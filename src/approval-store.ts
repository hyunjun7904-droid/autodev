import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ApprovalRequest, ApprovalStatus } from "./approval";
import { isProductionRuntime } from "./runtime-origin";

// Approval Store — Phase G Task G6.
//
// notification-store.ts(Phase G Task G5)와 동일한 설계 원칙(mutable bookkeeping,
// in-memory/file 두 구현, "필요할 때 전체 읽기 → 수정 → 전체 쓰기")을 그대로 재사용한다.
// 이 store가 강제하는 가장 중요한 성질은 **한 ApprovalRequest는 한 번만 소비 가능**하다는
// 것이다 — transition()은 현재 status가 정확히 PENDING일 때만 성공하는 단일 CAS(compare-
// and-swap) 연산이다. Node는 단일 스레드이고 이 store의 모든 메서드는 동기(async 경계 없이
// 읽기→검사→쓰기가 한 호출 안에서 끝난다)이므로, 같은 프로세스 안에서는 이 CAS가 실제로
// 원자적이다(두 번째 클릭이 처리되는 동안 첫 번째 클릭의 쓰기가 끼어들 수 없다).
//
// createPending()도 dedupeKey 기준으로 idempotent하다 — 같은 dedupeKey로 이미
// PENDING이든 이미 소비된(APPROVED/REJECTED/...) 레코드든 항상 "존재하는 레코드"를 그대로
// 반환하고 새 approvalId를 발급하지 않는다. 이는 의도적이다: 한 번 소비된 승인 요청의
// dedupeKey로 다시 알림이 재생성돼도(예: controller가 같은 event를 다시 훑음) 새로운 살아있는
// 버튼이 다시 만들어지지 않는다 — replay 방지가 controller 재시작에도 이어진다(§ 요구사항
// 15/28).

// Store Durability Capability(2026-09-01) — Orphaned Genuine Human Gate Recovery
// Production Wiring Defect 수정. 이전에는 "이 store가 프로세스 종료 후에도 살아남는가"를
// 호출부가 isProductionRuntime()의 결과를 간접 추론(store 선택 함수를 신뢰)해서만 알 수
// 있었다 — 그 store 자체는 스스로 durable한지 밝히지 않았다. `durability`는 각 store
// 구현이 스스로 정직하게 보고하는 capability metadata다: `createInMemoryApprovalStore()`는
// 항상 `"MEMORY"`, `createFileApprovalStore()`는 항상 `"FILE"`을 반환한다 — 호출부가
// `isProductionRuntime()`을 다시 추측하지 않고 이 값 하나만으로 "durable 성공을 주장해도
// 되는가"를 판별할 수 있다(§ local-human-approval.ts ensureDurableApprovalForGenuineWaitingHuman).
export type ApprovalStoreDurability = "MEMORY" | "FILE";

export interface ApprovalStore {
  readonly durability: ApprovalStoreDurability;
  has(approvalId: string): boolean;
  get(approvalId: string): ApprovalRequest | undefined;
  getByDedupeKey(dedupeKey: string): ApprovalRequest | undefined;
  /** dedupeKey가 이미 있으면 기존 레코드를 그대로 반환한다(새로 만들지 않음). */
  createPending(request: ApprovalRequest): ApprovalRequest;
  /**
   * PENDING → nextStatus로의 단일 전이만 허용한다. 현재 status가 PENDING이 아니면(이미
   * 소비/만료/무효화됨) ok:false와 함께 현재 레코드를 반환한다 — 실패를 조용히 성공으로
   * 위장하지 않는다.
   */
  transition(approvalId: string, nextStatus: ApprovalStatus, at: string): { ok: boolean; request?: ApprovalRequest };
  list(filter?: { runId?: string; status?: ApprovalStatus }): ApprovalRequest[];
}

function matchesFilter(r: ApprovalRequest, filter: { runId?: string; status?: ApprovalStatus }): boolean {
  if (filter.runId !== undefined && r.runId !== filter.runId) return false;
  if (filter.status !== undefined && r.status !== filter.status) return false;
  return true;
}

export function createInMemoryApprovalStore(): ApprovalStore {
  const byId = new Map<string, ApprovalRequest>();
  const byDedupeKey = new Map<string, string>(); // dedupeKey -> approvalId

  return {
    durability: "MEMORY",
    has(approvalId) {
      return byId.has(approvalId);
    },
    get(approvalId) {
      const r = byId.get(approvalId);
      return r ? { ...r } : undefined;
    },
    getByDedupeKey(dedupeKey) {
      const id = byDedupeKey.get(dedupeKey);
      if (!id) return undefined;
      const r = byId.get(id);
      return r ? { ...r } : undefined;
    },
    createPending(request) {
      const existingId = byDedupeKey.get(request.dedupeKey);
      if (existingId) {
        const existing = byId.get(existingId);
        if (existing) return { ...existing };
      }
      byId.set(request.approvalId, { ...request });
      byDedupeKey.set(request.dedupeKey, request.approvalId);
      return { ...request };
    },
    transition(approvalId, nextStatus, _at) {
      const current = byId.get(approvalId);
      if (!current) return { ok: false };
      if (current.status !== "PENDING") return { ok: false, request: { ...current } };
      const updated: ApprovalRequest = { ...current, status: nextStatus };
      byId.set(approvalId, updated);
      return { ok: true, request: { ...updated } };
    },
    list(filter = {}) {
      return Array.from(byId.values())
        .filter((r) => matchesFilter(r, filter))
        .map((r) => ({ ...r }));
    },
  };
}

interface ApprovalStoreFile {
  records: ApprovalRequest[];
}

function readStoreFile(filePath: string): ApprovalStoreFile {
  if (!existsSync(filePath)) return { records: [] };
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as ApprovalStoreFile;
    return Array.isArray(parsed.records) ? parsed : { records: [] };
  } catch {
    // notification-store.ts와 동일한 정책 — 손상된 파일을 정상 기록으로 위장하지 않고 빈
    // store로 취급한다(다음 저장이 정상 내용으로 덮어쓴다).
    return { records: [] };
  }
}

/** same-directory temp write + rename() — filesystem-trust-model.md/project-lock.ts와 동일한
 *  원칙(§ 그 문서 "same-directory temp + atomic rename"): 프로세스가 write 도중 죽어도
 *  approvals.json은 이전 완전한 내용 그대로거나 새 완전한 내용 그대로다 — 절반만 쓰인 JSON이
 *  남지 않는다(§ Multi-Project Approval Isolation, invariant I). */
function writeStoreFileAtomic(filePath: string, data: ApprovalStoreFile): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.${basename(filePath)}.tmp-${randomUUID()}`);
  writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  renameSync(tmpPath, filePath);
}

// ---------------------------------------------------------------------------
// Multi-Project Approval Isolation(2026-09-01) — DEFECT 3 수정.
//
// 배경: 이 store는 원래 "이 프로세스 하나만 이 파일에 쓴다"는 전제로 설계됐다(load 전체 →
// mutate → save 전체, 락 없음) — Node 단일 스레드 + 동기 I/O라 같은 프로세스 안에서는 항상
// 안전했다. Genuine Human Gate Local Approval CLI(project-control-cli.ts approve,
// local-human-approval.ts)가 추가되면서 실제로 이 파일에 쓰는 production writer가
// Telegram controller 프로세스 + CLI 프로세스, 최소 둘이 됐다 — 서로 다른 OS 프로세스이므로
// 그 전제가 더 이상 성립하지 않는다: A가 읽은 뒤 쓰기 전에 B가 읽고 쓰면 A의 쓰기가 B의
// 변경을 덮어써 lost-update가 된다.
//
// project-lock.ts/telegram-controller-supervisor.ts가 이미 쓰는 것과 동일한 원자적
// exclusive-create(`wx`) idiom을 재사용해, load→mutate→save 전체를 짧은 critical section
// 하나로 직렬화한다 — 이 store 전용의 별도 mutation lock 파일(approvals.json과 나란히,
// "<file>.mutlock")이며 project-lock.ts의 ProjectLockMetadata 스키마/의미(canonical project
// path/ownerKind 등)와는 무관하다(§ telegram-controller-supervisor.ts 상단 주석과 동일한
// 원칙 — 서로 다른 목적의 lock을 섞지 않는다). 이 critical section은 항상 매우 짧다(파일
// 하나를 읽고 파싱하고 다시 쓰는 동기 연산뿐, 네트워크/사용자 입력 없음)이므로 staleness
// 기준(STORE_MUTATION_LOCK_STALE_MS)은 project-lock.ts의 PID liveness 판정보다 훨씬 단순한
// "이 시간보다 오래 남아있으면 그 writer는 critical section 도중 죽은 것"이라는 시간 기반
// 판단만으로 충분하다 — 그래도 project-lock.ts의 stale-steal과 동일한 "rename-away로 캡처한
// 것을 실제로 안다"는 원칙(blind unlink 금지)을 그대로 따른다.
// ---------------------------------------------------------------------------

const STORE_MUTATION_LOCK_STALE_MS = 10_000; // 실제 critical section은 항상 수 ms~수십 ms
const STORE_MUTATION_LOCK_ACQUIRE_BUDGET_MS = 5_000;
const STORE_MUTATION_LOCK_RETRY_DELAY_MS = 15;

function mutationLockPath(filePath: string): string {
  return `${filePath}.mutlock`;
}

/** Node.js 메인 스레드에서도 허용되는(브라우저와 달리) 동기 sleep — createPending/transition의
 *  기존 완전 동기 시그니처를 바꾸지 않기 위해 async/await 대신 이 방식을 쓴다(§ ApprovalStore
 *  인터페이스, 이미 이 저장소 전체에 넓게 재사용됨 — 시그니처를 바꾸면 그 blast radius가
 *  이번 수정 범위를 크게 벗어난다). */
function sleepSyncMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** project-lock.ts captureAndVerifyLock()과 동일한 단일승자 원칙(rename-away로 실제 캡처한
 *  내용만 지운다 — blind unlink 금지)을 이 짧은 mutation lock에도 적용한다. 캡처한 내용이
 *  기대한 stale owner가 아니면(그 사이 다른 프로세스가 이미 새로 획득함) 절대 지우지 않고
 *  물러난다. */
function tryReclaimStaleMutationLock(lockPath: string): void {
  const quarantine = `${lockPath}.stale-${randomUUID()}`;
  try {
    renameSync(lockPath, quarantine);
  } catch {
    return; // 이미 사라졌거나 그 사이 다른 프로세스가 처리함 — 다음 재시도가 최신 상태를 다시 판정한다.
  }
  try {
    unlinkSync(quarantine);
  } catch {
    /* 이미 격리되어 아무도 더 이상 참조하지 않으므로 정리 실패는 무해하다. */
  }
}

/** load→mutate→save 전체를 감싸는 exclusive lock을 얻는다. 얻지 못하면(budget 소진 — 극단적
 *  경합) undefined를 반환한다 — 호출부는 이를 "안전하게 진행할 수 없다"로 취급해야 한다
 *  (조용히 lock 없이 진행하지 않는다). */
function acquireMutationLock(lockPath: string): { release: () => void } | undefined {
  const deadline = Date.now() + STORE_MUTATION_LOCK_ACQUIRE_BUDGET_MS;
  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { encoding: "utf-8", flag: "wx" });
      return {
        release: () => {
          try {
            unlinkSync(lockPath);
          } catch {
            /* 이미 없거나(레이스로 다른 프로세스가 stale로 판정해 재점유함) 정리 실패 — 어느 쪽도
             * 이 프로세스가 더 손댈 일이 아니다(release는 "내가 다 썼다"는 의사표시일 뿐, 여기서
             * lockId 소유권 검증까지 하지 않는 이유는 이 lock의 생명주기가 항상 이 함수 호출
             * 안에서 시작/종료되어 project-lock.ts처럼 장기 보유되는 소유권 개념이 없기
             * 때문이다). */
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    try {
      const stat = statSync(lockPath);
      if (Date.now() - stat.mtimeMs > STORE_MUTATION_LOCK_STALE_MS) {
        tryReclaimStaleMutationLock(lockPath);
        continue; // 즉시 재시도(wx create) — 회수에 성공했으면 이번엔 우리가 얻는다.
      }
    } catch {
      continue; // stat 실패(그 사이 사라짐) — 즉시 재시도.
    }

    if (Date.now() >= deadline) return undefined;
    sleepSyncMs(STORE_MUTATION_LOCK_RETRY_DELAY_MS);
  }
}

/** 파일 기반 store — controller 재시작에도 PENDING/소비 상태가 이어진다(§ 요구사항 15/28).
 *  매 호출마다 디스크에서 다시 읽고 전체를 다시 쓴다(notification-store.ts의
 *  createFileNotificationStore와 동일한 패턴) — createPending/transition(실제 mutation이
 *  일어나는 두 메서드)은 이제 위 acquireMutationLock()으로 서로 다른 프로세스 간에도
 *  load→mutate→save 전체를 직렬화한다(§ Multi-Project Approval Isolation DEFECT 3 — 이제
 *  이 파일에 쓰는 production writer가 둘 이상이다). 순수 조회(get/getByDedupeKey/has/list)는
 *  lock이 필요 없다 — writeStoreFileAtomic()이 파일을 항상 완전한 상태로만 남기므로(rename
 *  기반) torn read가 없다. */
export function createFileApprovalStore(filePath: string): ApprovalStore {
  function load(): Map<string, ApprovalRequest> {
    return new Map(readStoreFile(filePath).records.map((r) => [r.approvalId, r]));
  }
  function save(records: Map<string, ApprovalRequest>): void {
    writeStoreFileAtomic(filePath, { records: Array.from(records.values()) });
  }
  function findByDedupeKey(records: Map<string, ApprovalRequest>, dedupeKey: string): ApprovalRequest | undefined {
    for (const r of records.values()) if (r.dedupeKey === dedupeKey) return r;
    return undefined;
  }
  function withMutationLock<T>(fn: () => T): T {
    const lock = acquireMutationLock(mutationLockPath(filePath));
    if (!lock) {
      throw new Error(
        "ApprovalStore mutation lock을 획득하지 못했습니다(타임아웃) — 동시 writer가 과도하게 경합 중입니다. 이 mutation은 적용되지 않았습니다."
      );
    }
    try {
      return fn();
    } finally {
      lock.release();
    }
  }

  return {
    durability: "FILE",
    has(approvalId) {
      return load().has(approvalId);
    },
    get(approvalId) {
      return load().get(approvalId);
    },
    getByDedupeKey(dedupeKey) {
      return findByDedupeKey(load(), dedupeKey);
    },
    createPending(request) {
      return withMutationLock(() => {
        const records = load();
        const existing = findByDedupeKey(records, request.dedupeKey);
        if (existing) return existing;
        records.set(request.approvalId, request);
        save(records);
        return request;
      });
    },
    transition(approvalId, nextStatus) {
      return withMutationLock(() => {
        const records = load();
        const current = records.get(approvalId);
        if (!current) return { ok: false };
        if (current.status !== "PENDING") return { ok: false, request: current };
        const updated: ApprovalRequest = { ...current, status: nextStatus };
        records.set(approvalId, updated);
        save(records);
        return { ok: true, request: updated };
      });
    },
    list(filter = {}) {
      return Array.from(load().values()).filter((r) => matchesFilter(r, filter));
    },
  };
}

export const RUNTIME_APPROVAL_STORE_PATH = join(__dirname, "..", "logs", "approvals.json");

/** notification-store.ts의 selectDefaultNotificationStore()와 동일한 관례 —
 *  isProductionRuntime()(§ runtime-origin.ts)이 참일 때만 실제 파일 store를 쓴다. */
export function selectDefaultApprovalStore(filePath: string = RUNTIME_APPROVAL_STORE_PATH): ApprovalStore {
  return isProductionRuntime() ? createFileApprovalStore(filePath) : createInMemoryApprovalStore();
}

// ---------------------------------------------------------------------------
// Telegram update_id offset — getUpdates(offset=lastProcessed+1)이 Telegram 공식 replay
// 방지 메커니즘이다(공식 문서: offset을 넘기면 그 이하 update_id는 서버가 다시 보내지
// 않는다) — 별도의 update_id 집합을 직접 관리하지 않고 이 하나의 정수만 durable하게
// 저장한다(§ 요구사항 13/29). 이 store도 controller 재시작에도 이어져야 한다.
// ---------------------------------------------------------------------------

export interface TelegramOffsetStore {
  getOffset(): number;
  setOffset(offset: number): void;
}

export function createInMemoryTelegramOffsetStore(initial = 0): TelegramOffsetStore {
  let offset = initial;
  return {
    getOffset: () => offset,
    setOffset: (o) => {
      offset = o;
    },
  };
}

interface OffsetFile {
  offset: number;
}

export function createFileTelegramOffsetStore(filePath: string): TelegramOffsetStore {
  function load(): number {
    if (!existsSync(filePath)) return 0;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as OffsetFile;
      return typeof parsed.offset === "number" && Number.isFinite(parsed.offset) ? parsed.offset : 0;
    } catch {
      return 0;
    }
  }
  return {
    getOffset: load,
    setOffset: (offset) => {
      const dir = dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, `${JSON.stringify({ offset } satisfies OffsetFile, null, 2)}\n`, "utf-8");
    },
  };
}

export const RUNTIME_TELEGRAM_OFFSET_PATH = join(__dirname, "..", "logs", "telegram-offset.json");

export function selectDefaultTelegramOffsetStore(filePath: string = RUNTIME_TELEGRAM_OFFSET_PATH): TelegramOffsetStore {
  return isProductionRuntime() ? createFileTelegramOffsetStore(filePath) : createInMemoryTelegramOffsetStore();
}
