import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

export interface ApprovalStore {
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

function writeStoreFile(filePath: string, data: ApprovalStoreFile): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

/** 파일 기반 store — controller 재시작에도 PENDING/소비 상태가 이어진다(§ 요구사항 15/28).
 *  매 호출마다 디스크에서 다시 읽고 전체를 다시 쓴다(notification-store.ts의
 *  createFileNotificationStore와 동일한 패턴) — 이 프로세스 하나만 이 파일에 쓴다는 전제
 *  (§ 요구사항: 단일 process local controller)에서 안전하다. */
export function createFileApprovalStore(filePath: string): ApprovalStore {
  function load(): Map<string, ApprovalRequest> {
    return new Map(readStoreFile(filePath).records.map((r) => [r.approvalId, r]));
  }
  function save(records: Map<string, ApprovalRequest>): void {
    writeStoreFile(filePath, { records: Array.from(records.values()) });
  }
  function findByDedupeKey(records: Map<string, ApprovalRequest>, dedupeKey: string): ApprovalRequest | undefined {
    for (const r of records.values()) if (r.dedupeKey === dedupeKey) return r;
    return undefined;
  }

  return {
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
      const records = load();
      const existing = findByDedupeKey(records, request.dedupeKey);
      if (existing) return existing;
      records.set(request.approvalId, request);
      save(records);
      return request;
    },
    transition(approvalId, nextStatus) {
      const records = load();
      const current = records.get(approvalId);
      if (!current) return { ok: false };
      if (current.status !== "PENDING") return { ok: false, request: current };
      const updated: ApprovalRequest = { ...current, status: nextStatus };
      records.set(approvalId, updated);
      save(records);
      return { ok: true, request: updated };
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
