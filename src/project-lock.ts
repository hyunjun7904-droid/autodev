import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

// Project Lock & Concurrent Writer Safety — Phase G Task G7.
//
// 목적: 같은 target project(canonical real path 기준)에 두 개의 production writer(AutoDev
// 실행/Telegram Auto Resume 등)가 동시에 들어가는 것을 막는다. 서로 다른 project는 이 lock과
// 무관하게 항상 동시 실행 가능하다 — global lock이 아니라 project 단위 lock이다.
//
// Core 설계 원칙(요구사항 그대로):
//   - 단순 경고가 아니라 실제 production write 이전에 검사하는 Safety Gate다.
//   - Lock 상태를 확실히 판단할 수 없으면 fail-closed한다(LOCK_STATE_UNCERTAIN).
//   - check-then-create 금지 — exclusive create("wx")만으로 원자적으로 승부를 가른다.
//   - "내가 잡은 lock"만 release할 수 있다(lockId owner token).
//   - TTL만으로 active lock을 삭제하지 않는다 — owner PID가 실제로 죽었다고 증명될 때만
//     stale recovery를 허용한다(PID 존재 여부 + 가능하면 process 시작 시각 비교로 PID 재사용
//     위험을 줄인다).
//   - malformed/schema 불일치/필수 필드 누락은 "lock 없음"으로 취급하지 않는다(CORRUPT_LOCK).
//   - lock stealing(강제 삭제/탈취) 기능은 이 모듈에 없다 — release는 owner만, stale recovery는
//     owner 죽음이 증명됐을 때만 acquire 경로 안에서만 일어난다.
//
// 이 파일은 EventStore/checkpoint/orchestrator를 전혀 모른다 — 이 저장소의 기존 관례(Safe
// Executor/Secret Scanner처럼 "무엇을 할지"만 판정하고, 실제 event 기록/배선은 autodev.ts가
// 전담)를 그대로 따른다.

export const PROJECT_LOCK_SCHEMA_VERSION = 1 as const;

export type ProjectLockOwnerKind = "autodev" | "telegram-resume" | "local-human-approval";

export interface ProjectLockMetadata {
  schemaVersion: typeof PROJECT_LOCK_SCHEMA_VERSION;
  projectId: string;
  canonicalProjectPath: string;
  /** acquire 시 발급되는 opaque owner token — release는 이 값이 일치할 때만 허용된다. */
  lockId: string;
  pid: number;
  /** 이 lock을 만든 프로세스의 OS 시작 시각(epoch ms) 추정값 — PID 재사용 탐지에 쓰인다. */
  processStartedAtMs: number;
  lockCreatedAt: string;
  ownerKind: ProjectLockOwnerKind;
  runId?: string;
  taskId?: string;
}

export interface ProjectLockHandle {
  filePath: string;
  metadata: ProjectLockMetadata;
}

export type ProjectLockBlockedCode = "PROJECT_ALREADY_LOCKED" | "LOCK_STATE_UNCERTAIN" | "CORRUPT_LOCK";

export type AcquireProjectLockResult =
  | {
      ok: true;
      lock: ProjectLockHandle;
      /** stale owner(증명된 죽은 PID/PID 재사용)를 밀어내고 얻은 경우에만 채워진다. */
      recoveredFromStale?: { previousOwnerPid: number; evidence: StaleEvidence };
    }
  | {
      ok: false;
      code: ProjectLockBlockedCode;
      reason: string;
      /** PROJECT_ALREADY_LOCKED일 때 참고용 — secret을 담지 않는 lock metadata 그대로다. */
      existingOwner?: { pid: number; ownerKind: ProjectLockOwnerKind; runId?: string; taskId?: string; lockCreatedAt: string };
    };

export type StaleEvidence = "PID_NOT_RUNNING" | "PID_REUSED_START_TIME_MISMATCH" | "SAME_PROCESS_REACQUIRE";

export interface AcquireProjectLockInput {
  projectId: string;
  targetProjectRoot: string;
  ownerKind: ProjectLockOwnerKind;
  runId?: string;
  taskId?: string;
}

/** 테스트 전용 override — 실제 프로세스 liveness/PowerShell 호출 없이 결정적으로 검증하기
 *  위함이다. production 호출부(autodev.ts)는 이 값을 지정하지 않는다(기본값이 실제 Windows
 *  PID liveness 판정을 쓴다). */
export interface ProjectLockTestDeps {
  /** 지정하면 acquire가 만드는 lock의 pid로 process.pid 대신 이 값을 쓴다. */
  pid?: number;
  /** 지정하면 acquire가 만드는 lock의 processStartedAtMs로 이 값을 쓴다. */
  processStartedAtMs?: number;
  /** 기존 lock owner의 liveness 판정을 대체한다(§ assessOwnerLiveness). */
  assessLiveness?: (pid: number, recordedStartedAtMs: number) => LivenessVerdict;
  /** lock runtime 디렉터리를 override한다(테스트 격리용) — 지정하지 않으면 실제 운용 경로. */
  lockDir?: string;
}

export type LivenessVerdict =
  | { verdict: "ALIVE" }
  | { verdict: "STALE"; evidence: StaleEvidence }
  | { verdict: "UNCERTAIN"; reason: string };

// AutoDev 자신의 runtime data — event-store.ts/approval-store.ts와 동일한 위치 계산
// (__dirname 기준, logs/는 이미 .gitignore 대상) 관례를 그대로 따른다. project identity로
// namespace하기 위해 logs/locks/ 아래 project별 파일 하나씩 둔다(§ 요구사항 12).
export const RUNTIME_LOCK_DIR = join(__dirname, "..", "logs", "locks");

function lockFilePathFor(canonicalProjectPath: string, lockDir: string): string {
  const hash = createHash("sha256").update(canonicalProjectPath.toLowerCase()).digest("hex").slice(0, 32);
  return join(lockDir, `${hash}.lock.json`);
}

/** 테스트/진단 전용 — 실제 production 코드는 이 경로를 직접 계산할 필요가 없다(항상
 *  acquireProjectLock/peekProjectLock/releaseProjectLock을 통해서만 lock을 다룬다). 통합
 *  테스트가 실제 RUNTIME_LOCK_DIR 아래에 "다른 프로세스가 이미 잡은 lock"을 미리 만들어
 *  두기 위해 이 계산 하나만 재사용한다(해시 알고리즘을 테스트 파일에 복제하지 않는다). */
export function debugComputeLockFilePath(canonicalProjectPath: string, lockDir: string = RUNTIME_LOCK_DIR): string {
  return lockFilePathFor(canonicalProjectPath, lockDir);
}

/** 같은 실제 project는 어떤 상대경로/대소문자 표현으로 와도 같은 lock으로 판정돼야 한다
 *  (§ 요구사항 2) — symlink 해석 + `.`/`..` 정규화 + Windows 실제 on-disk casing까지
 *  realpathSync 하나로 해결한다(safe-executor.ts가 이미 같은 목적으로 쓰는 것과 동일한 API). */
export function resolveCanonicalProjectPath(targetProjectRoot: string): string {
  return realpathSync(targetProjectRoot);
}

function isPidAlive(pid: number): boolean | "UNKNOWN" {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    return "UNKNOWN";
  }
}

/** Windows 전용 — 다른 프로세스의 실제 OS 시작 시각을 얻는 유일한 방법은 외부 조회뿐이다
 *  (Node에 native API가 없다). PowerShell Get-Process를 쓴다(§ 요구사항: Windows에서 PID
 *  생존 여부를 안전하게 확인). pid는 호출 전 이미 정수로 검증된 값만 들어온다(schema
 *  validation에서 이미 확인됨) — 문자열 보간이 PowerShell 명령 injection으로 이어지지
 *  않도록 이 함수에서도 다시 한번 정수 범위를 확인한다(defense in depth). */
function getWindowsProcessStartTimeMs(pid: number): number | undefined {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 2 ** 31 - 1) return undefined;
  try {
    const res = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToUniversalTime().ToString('o')`,
      ],
      { encoding: "utf-8", timeout: 5_000 }
    );
    const out = (res.stdout || "").trim();
    if (!out) return undefined;
    const t = Date.parse(out);
    return Number.isFinite(t) ? t : undefined;
  } catch {
    return undefined;
  }
}

const START_TIME_TOLERANCE_MS = 5_000;

/** 기존 lock owner가 실제로 살아있는지 판정한다 — PID 존재만으로 "살아있다"고 단정하지
 *  않는다: PID가 살아있어도 실제 시작 시각이 lock에 기록된 값과 다르면(허용 오차
 *  START_TIME_TOLERANCE_MS 초과) OS가 그 PID를 재사용한 것으로 보고 STALE로 판정한다(§
 *  요구사항: PID reuse 위험 고려). 시작 시각을 확인할 수 없으면(예: PowerShell 조회 실패)
 *  "살아있다"는 사실 하나만으로 ALIVE로 남긴다 — 증명되지 않은 자동 recovery는 절대 하지
 *  않는다는 fail-closed 원칙 쪽으로 기운다. */
export function assessOwnerLiveness(pid: number, recordedStartedAtMs: number): LivenessVerdict {
  const alive = isPidAlive(pid);
  if (alive === false) return { verdict: "STALE", evidence: "PID_NOT_RUNNING" };
  if (alive === "UNKNOWN") return { verdict: "UNCERTAIN", reason: "owner PID의 생존 여부를 확인할 수 없습니다(권한 등)." };

  const actualStartMs = getWindowsProcessStartTimeMs(pid);
  if (actualStartMs === undefined) return { verdict: "ALIVE" };
  if (Math.abs(actualStartMs - recordedStartedAtMs) > START_TIME_TOLERANCE_MS) {
    return { verdict: "STALE", evidence: "PID_REUSED_START_TIME_MISMATCH" };
  }
  return { verdict: "ALIVE" };
}

function isValidLockMetadata(value: unknown): value is ProjectLockMetadata {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.schemaVersion === PROJECT_LOCK_SCHEMA_VERSION &&
    typeof v.projectId === "string" &&
    v.projectId.length > 0 &&
    typeof v.canonicalProjectPath === "string" &&
    v.canonicalProjectPath.length > 0 &&
    typeof v.lockId === "string" &&
    v.lockId.length > 0 &&
    typeof v.pid === "number" &&
    Number.isInteger(v.pid) &&
    v.pid > 0 &&
    typeof v.processStartedAtMs === "number" &&
    Number.isFinite(v.processStartedAtMs) &&
    typeof v.lockCreatedAt === "string" &&
    (v.ownerKind === "autodev" || v.ownerKind === "telegram-resume" || v.ownerKind === "local-human-approval")
  );
}

function readLockFile(filePath: string): { kind: "absent" } | { kind: "corrupt" } | { kind: "valid"; metadata: ProjectLockMetadata } {
  if (!existsSync(filePath)) return { kind: "absent" };
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return { kind: "absent" }; // 읽는 사이 다른 프로세스가 release해 사라진 경우 — 없는 것과 동일하게 재시도한다.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }
  if (!isValidLockMetadata(parsed)) return { kind: "corrupt" };
  return { kind: "valid", metadata: parsed };
}

const MAX_ACQUIRE_ATTEMPTS = 5;

/**
 * Project 단위 exclusive lock을 원자적으로 얻는다. check-then-create가 아니라 `wx`(exclusive
 * create) 자체의 원자성에 의존한다 — 두 프로세스가 동시에 시도해도 정확히 하나만 성공한다(§
 * 요구사항 3/18).
 *
 * 이미 lock이 있으면:
 *   - 그 owner pid가 지금 이 호출을 실행 중인 프로세스와 같으면(§ 재진입 — 이전 호출이
 *     WAITING_HUMAN 등으로 lock을 kept 상태로 남긴 뒤 같은 프로세스가 순차적으로 다시
 *     시도하는 경우) 항상 안전하게 복구한다 — 같은 프로세스라는 사실 자체가 동시 두 번째
 *     writer가 아님을 증명하므로 별도 liveness 판정이 필요 없다.
 *   - 그 외에는 assessOwnerLiveness()로 판정한다 — ALIVE면 BLOCK(PROJECT_ALREADY_LOCKED),
 *     STALE이 증명되면 그 lock을 밀어내고 재시도, UNCERTAIN이면 BLOCK(LOCK_STATE_UNCERTAIN).
 *   - lock 파일이 malformed/schema 불일치/필수 필드 누락이면 CORRUPT_LOCK으로 BLOCK한다 —
 *     "lock 없음"으로 취급하지 않고, 자동 삭제도 하지 않는다.
 */
export function acquireProjectLock(input: AcquireProjectLockInput, testDeps: ProjectLockTestDeps = {}): AcquireProjectLockResult {
  const canonicalProjectPath = resolveCanonicalProjectPath(input.targetProjectRoot);
  const lockDir = testDeps.lockDir ?? RUNTIME_LOCK_DIR;
  const filePath = lockFilePathFor(canonicalProjectPath, lockDir);
  const pid = testDeps.pid ?? process.pid;
  const processStartedAtMs = testDeps.processStartedAtMs ?? Date.now() - Math.round(process.uptime() * 1000);
  const assessLiveness = testDeps.assessLiveness ?? assessOwnerLiveness;
  // 이 acquire 시도 중 stale owner를 밀어낸 적이 있으면 그 증거를 기억해뒀다가, 최종적으로
  // wx create가 성공했을 때 그 결과에 함께 실어 보낸다(§ 요구사항 13, 호출부가
  // PROJECT_LOCK_STALE_DETECTED/PROJECT_LOCK_RECOVERED event를 남길 수 있게).
  let staleRecovery: { previousOwnerPid: number; evidence: StaleEvidence } | undefined;

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    if (!existsSync(lockDir)) mkdirSync(lockDir, { recursive: true });

    const metadata: ProjectLockMetadata = {
      schemaVersion: PROJECT_LOCK_SCHEMA_VERSION,
      projectId: input.projectId,
      canonicalProjectPath,
      lockId: randomUUID(),
      pid,
      processStartedAtMs,
      lockCreatedAt: new Date().toISOString(),
      ownerKind: input.ownerKind,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
    };

    try {
      writeFileSync(filePath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });
      return { ok: true, lock: { filePath, metadata }, ...(staleRecovery ? { recoveredFromStale: staleRecovery } : {}) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return { ok: false, code: "LOCK_STATE_UNCERTAIN", reason: `lock 파일 생성 실패: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    const existing = readLockFile(filePath);
    if (existing.kind === "absent") continue; // 방금 그 사이 release됨 — 재시도.
    if (existing.kind === "corrupt") {
      return { ok: false, code: "CORRUPT_LOCK", reason: "lock 파일이 손상되었거나(JSON 파싱 실패) 필수 metadata/schema를 만족하지 않습니다 — 자동 삭제하지 않고 중단합니다." };
    }

    const existingMeta = existing.metadata;
    if (existingMeta.pid === pid) {
      // 같은 프로세스의 재진입 — 항상 안전하게 복구한다(§ 함수 docstring).
      const removal = captureAndVerifyLock(filePath, existingMeta.lockId);
      if (removal.outcome === "UNCERTAIN") {
        return { ok: false, code: "LOCK_STATE_UNCERTAIN", reason: `같은 프로세스의 이전 lock을 정리하지 못했습니다: ${removal.reason}` };
      }
      staleRecovery = { previousOwnerPid: existingMeta.pid, evidence: "SAME_PROCESS_REACQUIRE" };
      continue;
    }

    const verdict = assessLiveness(existingMeta.pid, existingMeta.processStartedAtMs);
    if (verdict.verdict === "ALIVE") {
      return {
        ok: false,
        code: "PROJECT_ALREADY_LOCKED",
        reason: `이 project는 다른 프로세스(pid=${existingMeta.pid}, ownerKind=${existingMeta.ownerKind})가 이미 사용 중입니다.`,
        existingOwner: {
          pid: existingMeta.pid,
          ownerKind: existingMeta.ownerKind,
          runId: existingMeta.runId,
          taskId: existingMeta.taskId,
          lockCreatedAt: existingMeta.lockCreatedAt,
        },
      };
    }
    if (verdict.verdict === "UNCERTAIN") {
      return { ok: false, code: "LOCK_STATE_UNCERTAIN", reason: `기존 lock owner(pid=${existingMeta.pid})의 생존 여부를 확인할 수 없습니다: ${verdict.reason}` };
    }

    // STALE이 증명됨 — 밀어내고 재시도한다. captureAndVerifyLock()이 rename() 기반 단일승자
    // capture + wx 기반 안전 복원이므로(§ 함수 docstring), REMOVED가 아닌 다른 모든 결과
    // (ALREADY_GONE/MISMATCH_RESTORED/MISMATCH_SUPERSEDED/UNCERTAIN)에서도 즉시 전체
    // acquire를 실패시키지 않는다 — staleRecovery만 기록하지 않고 루프를 그대로
    // 돌려(MAX_ACQUIRE_ATTEMPTS로 bounded) 다음 반복이 그 시점의 실제 최신 상태를 처음부터
    // 다시 판정하게 한다. UNCERTAIN이 계속 반복되면 결국 아래 루프 종료 후
    // LOCK_STATE_UNCERTAIN으로 fail-closed된다(무한 재시도 없음).
    const removal = captureAndVerifyLock(filePath, existingMeta.lockId);
    if (removal.outcome === "REMOVED") {
      staleRecovery = { previousOwnerPid: existingMeta.pid, evidence: verdict.evidence };
    }
  }

  return { ok: false, code: "LOCK_STATE_UNCERTAIN", reason: `lock 획득을 ${MAX_ACQUIRE_ATTEMPTS}회 시도했지만 확정하지 못했습니다.` };
}

type LockCaptureOutcome =
  | { outcome: "REMOVED" }
  | { outcome: "ALREADY_GONE" }
  | { outcome: "MISMATCH_RESTORED" }
  | { outcome: "MISMATCH_SUPERSEDED" }
  | { outcome: "UNCERTAIN"; reason: string };

/** stale-steal(acquire 안에서)과 release(releaseProjectLock) 양쪽에서 공유하는 단일
 *  primitive — § P0-1 3+ contender 재하드닝(독립 최종 감사 BLOCKER 1). 이전 버전(read →
 *  compare lockId → unlinkSync, 또는 stale-steal에서는 "격리 후 mismatch면 blind
 *  renameSync로 복원")은 두 지점에서 진짜 3개 이상 프로세스 경쟁을 안전하게 못 지켰다:
 *
 *  1) unlink는 "무엇을 지우는지" 검증할 방법이 없다 — compare와 unlink 사이에 owner가
 *     바뀌면 fresh owner의 lock을 그대로 지워버린다.
 *  2) mismatch 복원에 쓰던 blind renameSync(quarantine, filePath)는 "그 사이 세 번째
 *     프로세스가 이미 그 자리에 진짜 살아있는 fresh lock을 만들어뒀다면" 그 fresh lock을
 *     통째로 덮어써 지워버린다(POSIX rename(2)/Windows MoveFileEx 둘 다 목적지가 있으면
 *     조건 없이 교체한다) — 이것이 독립 감사가 지적한 "3개 이상 contender에서 canonical
 *     path가 비는 창에 다른 owner가 들어온 뒤 restore가 충돌"하는 정확한 지점이었다.
 *
 *  이 버전은 오직 두 개의 진짜 커널 단일승자(single-winner) 연산만 쓴다 — 그 사이의
 *  "검증 후 조건부 교체(compare-and-swap)"는 portable Node.js fs에 없으므로 아예 필요
 *  없게 설계를 바꾼다:
 *
 *  (a) renameSync(filePath, quarantinePath) — 같은 filePath에서 동시에 여러 프로세스가
 *      각자의 quarantine으로 rename을 시도해도, 그 directory entry를 실제로 옮기는 데
 *      성공하는 것은 정확히 하나뿐이다(나머지는 ENOENT). 이 "현재 거기 있는 것을 통째로
 *      원자적으로 가져오기"는 무엇을 캡처했는지 항상 정확히 안다(unlink와 다른 점).
 *  (b) writeFileSync(filePath, ..., {flag:"wx"}) — acquire의 최초 lock 생성과 정확히
 *      같은 원자적 exclusive-create. mismatch로 판명된(=우리가 기대한 stale/own lockId가
 *      아닌) 캡처 내용을 "복원"할 때 blind rename 대신 이 exclusive-create를 쓴다:
 *      필요하다면 성공하고, 그 사이 세 번째 프로세스가 이미 그 자리에 자신의 진짜 fresh
 *      lock을 만들어뒀다면 EEXIST로 실패한다 — 실패 자체가 "덮어쓰지 않고 물러났다"는
 *      뜻이므로 그 fresh lock은 항상 보존된다(절대 clobber하지 않는다).
 *
 *  이 두 연산만으로 구성하면: 어떤 특정 lock 인스턴스(lockId로 식별)를 실제로
 *  "제거"하는 데 성공하는 프로세스는 정확히 하나뿐이고(단일승자 rename-away가 그 lockId를
 *  캡처하는 것 자체가 유일한 성공 조건), 그 제거는 오직 그 owner가 진짜로 죽었다고
 *  assessOwnerLiveness가 증명했을 때만(또는 owner 자신의 release) 일어난다. mismatch를
 *  만난 쪽은 절대 clobber하지 않고(복원 성공) 또는 이미 새 owner가 있으므로 조용히
 *  물러난다(복원 실패=EEXIST, 정상) — 어느 쪽이든 캡처 시도 전/후로 진짜 살아있는 owner가
 *  둘 이상 존재하는 순간은 구조적으로 생기지 않는다. 잔여 위험은 filesystem-trust-model.md
 *  가 이미 명시한 것과 동일한 계열(검증~실제 syscall 사이의 진짜 원자적 결합은 portable
 *  Node.js fs로 불가능)로 한정된다 — 여기서는 그 창이 "PowerShell 조회(최대 5초)"에서
 *  "JS statement 몇 줄"로 좁혀졌을 뿐만 아니라, 그 창 안에서 무엇이 일어나도(1 또는 그 이상
 *  프로세스가 끼어들어도) 결과가 REMOVED/MISMATCH_RESTORED/MISMATCH_SUPERSEDED 중 하나로
 *  수렴하고 그 어떤 경우도 살아있는 다른 owner의 lock을 지우지 않는다는 것이 이 함수의
 *  핵심 보장이다. */
function captureAndVerifyLock(filePath: string, expectedLockId: string): LockCaptureOutcome {
  const quarantinePath = `${filePath}.stale-${randomUUID()}`;
  try {
    renameSync(filePath, quarantinePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { outcome: "ALREADY_GONE" }; // 이미 다른 프로세스가 처리함.
    return { outcome: "UNCERTAIN", reason: `lock 격리(rename) 실패: ${err instanceof Error ? err.message : String(err)}` };
  }

  const captured = readLockFile(quarantinePath);
  if (captured.kind === "valid" && captured.metadata.lockId === expectedLockId) {
    try {
      unlinkSync(quarantinePath);
    } catch {
      /* 이미 격리되어 아무도 더 이상 참조하지 않으므로 정리 실패는 무해하다. */
    }
    return { outcome: "REMOVED" };
  }

  // 우리가 격리한 것이 기대했던 owner(X)가 아니다 — 다른 프로세스가 이미 X를 제거하고 그
  // 자리에 자신의(또는 세 번째 프로세스의) 살아있는 fresh lock(Y)을 만들어둔 상태를 실수로
  // 옮겨온 것일 수 있다. 원본 raw bytes를 그대로(재직렬화하지 않고) 복원 시도한다 —
  // exclusive create이므로 그 사이 진짜 fresh owner가 이미 그 자리를 차지했다면 절대
  // 덮어쓰지 않는다.
  let rawContent: string;
  try {
    rawContent = readFileSync(quarantinePath, "utf-8");
  } catch (err) {
    return { outcome: "UNCERTAIN", reason: `격리된 내용을 다시 읽지 못했습니다(파일은 quarantine에 보존됨): ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    writeFileSync(filePath, rawContent, { encoding: "utf-8", flag: "wx" });
    try {
      unlinkSync(quarantinePath);
    } catch {
      /* 복원 성공 후 quarantine 사본은 더 이상 필요 없음 — 정리 실패는 무해하다. */
    }
    return { outcome: "MISMATCH_RESTORED" };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // 그 사이 진짜 fresh owner가 이미 그 자리를 차지했다 — 절대 덮어쓰지 않고 우리가
      // 실수로 격리했던(이미 무의미해진) 사본만 정리한다. fresh owner의 lock은 전혀
      // 건드리지 않았다.
      try {
        unlinkSync(quarantinePath);
      } catch {
        /* 정리 실패는 무해하다 — fresh owner의 lock과는 무관한 orphan quarantine 파일. */
      }
      return { outcome: "MISMATCH_SUPERSEDED" };
    }
    // 복원도 실패하면(EEXIST 외의 이유) 격리된 파일을 그대로 둔다(자동 삭제하지 않음 —
    // fail-closed, 포렌식 목적).
    return {
      outcome: "UNCERTAIN",
      reason: `mismatch 복원 실패(quarantine에 보존됨): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * "내가 잡은 lock"만 release할 수 있다 — lockId가 정확히 일치할 때만 파일을 지운다. 다른
 * owner의 lock(우리가 없는 사이 stale로 판정되어 다른 프로세스가 새로 잡은 lock 포함)은
 * 절대 지우지 않는다(§ 요구사항 5 — lock stealing 금지와 동일한 원칙).
 *
 * § P0-1 3+ contender 재하드닝(독립 최종 감사 BLOCKER 1) — 이전 버전(read → compare
 * lockId → unlinkSync)은 compare와 unlink가 별도 syscall이라, 그 사이에 (이론상) owner가
 * 교체되면 unlink가 경로 기준으로 동작하므로 fresh owner의 lock을 지워버릴 수 있었다. 먼저
 * 손상/부재 판정을 위한 non-destructive 사전 읽기로 기존 에러 메시지/동작(손상된 lock은
 * 절대 건드리지 않음)을 그대로 유지한 뒤에만, 실제 삭제는 captureAndVerifyLock()(acquire의
 * stale-steal과 동일한 단일승자 rename-away + wx 기반 안전 복원 primitive, 로직 복제 없음)에
 * 위임한다 — 이 함수가 실제로 캡처한 내용이 우리 lockId와 다르면(우리가 살아있는 동안 다른
 * 프로세스가 이미 이 lock을 교체했다는 뜻) 그 fresh owner의 lock을 절대 clobber하지 않는다.
 */
export function releaseProjectLock(lock: ProjectLockHandle): { ok: boolean; reason?: string } {
  const initial = readLockFile(lock.filePath);
  if (initial.kind === "absent") return { ok: false, reason: "lock 파일이 이미 없습니다(이미 release되었거나 유실됨)." };
  if (initial.kind === "corrupt") return { ok: false, reason: "release 시점에 lock 파일이 손상되어 있어 안전하게 확인할 수 없습니다 — 삭제하지 않습니다." };
  if (initial.metadata.lockId !== lock.metadata.lockId) {
    return { ok: false, reason: "이 lockId는 현재 파일의 owner와 일치하지 않습니다 — 다른 owner의 lock을 release하지 않습니다." };
  }

  const outcome = captureAndVerifyLock(lock.filePath, lock.metadata.lockId);
  if (outcome.outcome === "REMOVED") return { ok: true };
  if (outcome.outcome === "ALREADY_GONE") return { ok: false, reason: "lock 파일이 이미 없습니다(이미 release되었거나 유실됨)." };
  if (outcome.outcome === "MISMATCH_RESTORED" || outcome.outcome === "MISMATCH_SUPERSEDED") {
    return { ok: false, reason: "release 시도 중 owner가 교체되어 이 lock을 지우지 않았습니다 — 다른 owner의 lock을 release하지 않습니다." };
  }
  return { ok: false, reason: outcome.reason };
}

/**
 * 실제로 lock을 만들거나 지우지 않는 읽기 전용 사전 확인 — Telegram Auto Resume이 lock을
 * 진짜로 잡기 전(=runAutodevOnce() 호출 전) 자신의 state.json 쓰기(READY 전환)보다 앞서 한 번
 * 더 재확인하기 위한 용도다(§ 요구사항 10). 이 함수가 통과했다는 사실이 그 뒤의 실제
 * acquireProjectLock() 성공을 보장하지는 않는다(그 사이 다른 프로세스가 먼저 잡을 수
 * 있다) — 그 최종 승부는 여전히 acquireProjectLock()의 원자적 wx create가 가른다. 이 함수는
 * "이미 다른 살아있는 owner가 있는 게 확실한 흔한 경우"를 값싸게 조기 차단해 불필요한 state
 * 쓰기를 줄이는 방어선일 뿐이다.
 */
export function peekProjectLock(
  projectId: string,
  targetProjectRoot: string,
  testDeps: Pick<ProjectLockTestDeps, "assessLiveness" | "lockDir"> = {}
): { locked: true; reason: string } | { locked: false } {
  const canonicalProjectPath = resolveCanonicalProjectPath(targetProjectRoot);
  const lockDir = testDeps.lockDir ?? RUNTIME_LOCK_DIR;
  const filePath = lockFilePathFor(canonicalProjectPath, lockDir);
  const existing = readLockFile(filePath);
  if (existing.kind !== "valid") return { locked: false };
  if (existing.metadata.pid === process.pid) return { locked: false };
  const assessLiveness = testDeps.assessLiveness ?? assessOwnerLiveness;
  const verdict = assessLiveness(existing.metadata.pid, existing.metadata.processStartedAtMs);
  if (verdict.verdict === "ALIVE") {
    return { locked: true, reason: `이 project는 다른 프로세스(pid=${existing.metadata.pid}, ownerKind=${existing.metadata.ownerKind})가 이미 사용 중입니다.` };
  }
  return { locked: false };
}

export type ProjectRuntimeLiveness =
  | { present: false }
  | {
      present: true;
      pid: number;
      /** 이 owner가 lock을 만들 때 기록한 OS 시작 시각 추정값(§ ProjectLockMetadata.processStartedAtMs)
       *  그대로 노출한다 — PID 단독이 아니라 pid+시작시각으로 신원을 식별해야 하는 호출부(예:
       *  project-control-cli.ts의 canonical stop marker)가 이 값을 그대로 재사용한다(새 계산
       *  로직 없음). */
      processStartedAtMs: number;
      ownerKind: ProjectLockOwnerKind;
      taskId?: string;
      liveness: LivenessVerdict;
    };

/**
 * AutoDev / JARVIS 최종 무인개발 구조 보완 — 대시보드 실행상태 보완(§ 요구사항 24). 이
 * 함수도 peekProjectLock()과 마찬가지로 읽기 전용(lock을 만들거나 지우지 않는다)이지만,
 * peekProjectLock()과 달리 "잠겨 있는가"라는 boolean 하나로 뭉개지 않고 실제 owner
 * PID/liveness 판정 전체를 그대로 노출한다 — 대시보드가 project-state.json의 status 문자열
 * (예: "CLAUDE_WORKING")만으로 "지금 실제로 실행 중"이라고 추측하지 않고, 이 값과 status를
 * 함께 조합해 판단할 수 있게 하기 위함이다. lock 파일이 없거나(present:false) 손상됐으면
 * (§ readLockFile의 "corrupt" — present:false로 취급, "실행 중이 아님"과 동일하게 안전한
 * 쪽으로 fail-closed) 실행 중이라고 주장하지 않는다.
 */
export function inspectProjectRuntimeLiveness(
  projectId: string,
  targetProjectRoot: string,
  testDeps: Pick<ProjectLockTestDeps, "assessLiveness" | "lockDir"> = {}
): ProjectRuntimeLiveness {
  const canonicalProjectPath = resolveCanonicalProjectPath(targetProjectRoot);
  const lockDir = testDeps.lockDir ?? RUNTIME_LOCK_DIR;
  const filePath = lockFilePathFor(canonicalProjectPath, lockDir);
  const existing = readLockFile(filePath);
  if (existing.kind !== "valid") return { present: false };
  const assessLiveness = testDeps.assessLiveness ?? assessOwnerLiveness;
  const liveness = assessLiveness(existing.metadata.pid, existing.metadata.processStartedAtMs);
  return {
    present: true,
    pid: existing.metadata.pid,
    processStartedAtMs: existing.metadata.processStartedAtMs,
    ownerKind: existing.metadata.ownerKind,
    taskId: existing.metadata.taskId,
    liveness,
  };
}
