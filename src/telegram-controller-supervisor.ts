import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startTelegramController } from "./telegram-controller";
import type { TelegramControllerHandle, TelegramControllerOptions } from "./telegram-controller";
import { assessOwnerLiveness } from "./project-lock";
import type { LivenessVerdict } from "./project-lock";
import type { ProjectManifest } from "./project-manifest";
import { log } from "./logger";

// Telegram Controller Supervisor — Phase G Task G7.2.
//
// 목적: "사람이 `npm run telegram-controller`를 별도 터미널에서 직접 실행해야만 알림이
// 전달된다"는 문제를 없앤다. 이 파일은 telegram-controller.ts(G6, long-poll tick loop
// 자체)를 다시 만들지 않는다 — 그 위에 "언제 시작할지/이미 떠 있는지/재시작 상한/graceful
// stop"만 관장하는 단일 canonical layer를 더한다. run.ts(production launcher)와
// telegram-controller-main.ts(수동 실행 entry point) 둘 다 이 파일 하나만 거친다 — entry
// point마다 서로 다른 시작/재시작 로직을 만들지 않는다(§ 요구사항 2).
//
// Controller singleton lock과 project-lock.ts의 Project Lock은 서로 다른 목적이다(§ 요구사항
// 14) — 혼합하지 않는다. Telegram controller는 이 AutoDev 설치(logs/ 하나, Bot Token
// 하나) 전체에 하나만 존재해야 하는 runtime-level 자원이라 project별 canonical path가
// 필요 없다(project-lock.ts처럼 target project 경로를 해시하지 않는다 — 고정 경로 하나만
// 쓴다). 다만 "check → start 사이 race" 방지에 필요한 atomic exclusive create(`wx`) +
// PID liveness 판정은 project-lock.ts와 동일한 원칙이므로, PID 생존 판정 함수
// (assessOwnerLiveness, Windows PowerShell 기반 프로세스 시작 시각 비교까지 포함)만
// 그대로 재사용한다 — 판정 로직을 이 파일에 복제하지 않는다. lock 파일 형식(atomic wx
// create/CORRUPT 처리/release는 owner만) 자체는 project-lock.ts의 것을 직접 쓰지 않고 이
// 파일이 독자적으로 구현한다(두 lock의 저장/소유권 개념을 분리 — § 요구사항 14).
//
// ownership metadata에는 schemaVersion/supervisorId(owner token)/pid/processStartedAtMs/
// startedAt만 담는다 — Bot Token/Chat ID는 절대 담지 않는다(§ 요구사항 5). status
// metadata(logs/telegram-controller.status.json)도 동일 원칙 — health state/pid/restart
// count/마지막 tick 시각/마지막 tick 오류(이미 telegram-controller.ts가 고정 코드로만
// 반환하는 값)만 담고, raw credential/Telegram API 응답 원문은 어디에도 남기지 않는다.

export const TELEGRAM_CONTROLLER_SUPERVISOR_SCHEMA_VERSION = 1 as const;

export type TelegramControllerHealthState = "STARTING" | "RUNNING" | "NOT_CONFIGURED" | "DEGRADED" | "STOPPED";

interface OwnershipMetadata {
  schemaVersion: typeof TELEGRAM_CONTROLLER_SUPERVISOR_SCHEMA_VERSION;
  supervisorId: string;
  pid: number;
  processStartedAtMs: number;
  startedAt: string;
}

export interface TelegramControllerStatus {
  schemaVersion: typeof TELEGRAM_CONTROLLER_SUPERVISOR_SCHEMA_VERSION;
  supervisorId: string;
  pid: number;
  state: TelegramControllerHealthState;
  startedAt: string;
  updatedAt: string;
  lastTickAt?: string;
  /** telegram-controller.ts의 TelegramControllerTickSummary.tickError를 그대로 옮긴 것 —
   *  이미 고정 코드/원문 없는 값이다(§ telegram-controller.ts 상단 주석). */
  lastTickError?: string;
  restartCount: number;
}

export interface TelegramControllerSupervisorHandle {
  /** 이 프로세스가 실제로 controller를 소유(시작)했는지 — false면 다른 프로세스가 이미
   *  서비스 중이거나(ALREADY_RUNNING) ownership 판정이 불확실/손상되어(STATE_UNCERTAIN/
   *  CORRUPT_STATE) 이 프로세스는 아무 controller도 시작하지 않았다는 뜻이다. */
  isOwner(): boolean;
  /** 이 프로세스가 실제로 관측한 최신 상태 — non-owner는 디스크의 status 파일을 그대로
   *  읽어 보여준다(다른 owner가 쓴 값, 정확한 실시간 보장은 없다 — read-only 참고용). */
  getStatus(): TelegramControllerStatus | undefined;
  /**
   * owner일 때만 실질적 동작 — 진행 중인 tick summary가 이 호출 시점 이후로 갱신될
   * 때까지(=이번에 새로 append된 event가 최소 한 번 더 처리될 때까지) 짧게 기다린다.
   * production launcher가 controller를 곧 멈추기 전에 "방금 만든 completion event가
   * 최소 한 번은 전달 시도됐다"를 보장하기 위한 용도다(§ 요구사항: WAITING_HUMAN이
   * 아니면 정상 종료하되, 그 전에 이번 run이 만든 알림은 흘려보낸다). controller가 없거나
   * (NOT_CONFIGURED 등으로) tick 자체가 없으면 timeoutMs 안에 false를 반환할 수 있다 —
   * 이 값은 순수 관측 편의이지 어떤 production 판정에도 쓰이지 않는다.
   */
  flushOnce(timeoutMs?: number): Promise<boolean>;
  /** graceful stop — owner가 아니면 즉시 no-op. 여러 번 호출해도 안전하다(idempotent, §
   *  요구사항 10). */
  stop(): Promise<void>;
}

export interface TelegramControllerSupervisorTestDeps {
  /** 테스트 전용 override — 지정하지 않으면 실제 운용 경로(logs/). */
  runtimeDir?: string;
  pid?: number;
  processStartedAtMs?: number;
  /** 기존 owner의 liveness 판정을 대체한다(§ project-lock.ts assessOwnerLiveness와 동일한
   *  테스트 seam 패턴). */
  assessLiveness?: (pid: number, recordedStartedAtMs: number) => LivenessVerdict;
  /** 지정하면 startTelegramController() 대신 이 함수를 쓴다(실제 controller/네트워크 없이
   *  bounded restart/watchdog을 결정적으로 검증하기 위함). */
  startController?: (opts: TelegramControllerOptions) => Promise<TelegramControllerHandle>;
  /** watchdog(controller crash 감지) 주기(ms) — 지정하지 않으면 실제 운용 기본값(4000ms).
   *  테스트는 짧은 값으로 override해 실제 시간을 오래 기다리지 않는다. */
  watchdogIntervalMs?: number;
  /** bounded restart backoff(ms) 목록 — 지정하지 않으면 실제 운용 기본값. 테스트는 짧은
   *  값으로 override한다. */
  restartBackoffMs?: number[];
  /** telegram-controller.ts에 그대로 전달되는 getUpdates long-poll 대기 초(§
   *  TelegramControllerOptions.longPollTimeoutSec). telegram-controller.ts 자신의 기본값
   *  (25초, Telegram 권장 상한)과 달리 이 supervisor의 기본값은 짧다(§
   *  DEFAULT_SUPERVISOR_LONG_POLL_TIMEOUT_SEC) — graceful stop()은 진행 중인 tick(그
   *  안의 getUpdates 호출 포함)이 끝날 때까지 기다리므로(§ telegram-controller.ts), long
   *  poll이 길수록 stop()/flushOnce()가 그만큼 오래 걸린다(§ 요구사항 10 — SIGINT/SIGTERM에
   *  reasonable 시간 안에 반응해야 한다). WAITING_HUMAN을 오래 기다리는 동안에는 이 값이
   *  커도 문제없다(사람이 실제로 대기 중이므로) — 그런 경우 호출부가 명시적으로 늘릴 수
   *  있게 override 가능한 값으로 남겨둔다. */
  longPollTimeoutSec?: number;
}

const DEFAULT_RUNTIME_DIR = join(__dirname, "..", "logs");
export const TELEGRAM_CONTROLLER_RUNTIME_DIR = DEFAULT_RUNTIME_DIR;

const DEFAULT_WATCHDOG_INTERVAL_MS = 4_000;
const DEFAULT_RESTART_BACKOFF_MS = [1_000, 3_000, 9_000];
const MAX_ACQUIRE_ATTEMPTS = 5;
/** telegram-controller.ts 자신의 기본값(25초)보다 짧다 — supervisor가 관리하는 controller는
 *  graceful stop()이 진행 중인 tick 하나가 끝날 때까지 기다리는 구조라서(§ 요구사항 10),
 *  기본값을 그대로 쓰면 매번 `npm run autodev`를 정상 종료할 때마다 최대 ~30초를 불필요하게
 *  기다리게 된다(§ 요구사항 15 — 기존 단발성 실행 UX를 불필요하게 깨뜨리지 않는다). 3초는
 *  여전히 매 tick마다 새 HTTP 요청을 만드는 것보다는 효율적이면서, stop()/flushOnce()가
 *  현실적인 시간 안에 끝나게 한다. */
const DEFAULT_SUPERVISOR_LONG_POLL_TIMEOUT_SEC = 3;

function lockFilePath(dir: string): string {
  return join(dir, "telegram-controller.lock.json");
}
function statusFilePath(dir: string): string {
  return join(dir, "telegram-controller.status.json");
}

function isValidOwnership(value: unknown): value is OwnershipMetadata {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.schemaVersion === TELEGRAM_CONTROLLER_SUPERVISOR_SCHEMA_VERSION &&
    typeof v.supervisorId === "string" &&
    v.supervisorId.length > 0 &&
    typeof v.pid === "number" &&
    Number.isInteger(v.pid) &&
    v.pid > 0 &&
    typeof v.processStartedAtMs === "number" &&
    Number.isFinite(v.processStartedAtMs) &&
    typeof v.startedAt === "string"
  );
}

function readOwnership(filePath: string): { kind: "absent" } | { kind: "corrupt" } | { kind: "valid"; metadata: OwnershipMetadata } {
  if (!existsSync(filePath)) return { kind: "absent" };
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return { kind: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt" };
  }
  if (!isValidOwnership(parsed)) return { kind: "corrupt" };
  return { kind: "valid", metadata: parsed };
}

function tryRemove(filePath: string): boolean {
  try {
    unlinkSync(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

function writeStatus(dir: string, status: TelegramControllerStatus): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(statusFilePath(dir), `${JSON.stringify(status, null, 2)}\n`, "utf-8");
  } catch (err) {
    // status는 순수 관측용 seam이다 — 기록 실패가 controller 동작 자체를 막지 않는다(§
    // 요구사항: 알림 못 보내도 위험한 작업은 그대로 BLOCK/WAITING_HUMAN — 이 파일은 그
    // 판정에 관여하지 않으므로 같은 fail-open 원칙을 status I/O에도 적용한다).
    log("telegram-controller-supervisor: status 파일 기록 실패(controller 동작에는 영향 없음)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Dashboard 등 어떤 프로세스에서도 읽을 수 있는 순수 read-only 조회 — 실제 lock을
 *  잡거나 controller를 시작하지 않는다(§ 요구사항 6). owner가 아니어도 항상 호출 가능하다. */
export function peekTelegramControllerStatus(runtimeDir: string = DEFAULT_RUNTIME_DIR): TelegramControllerStatus | undefined {
  const filePath = statusFilePath(runtimeDir);
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    return parsed as TelegramControllerStatus;
  } catch {
    return undefined;
  }
}

type AcquireOutcome =
  | { ok: true; filePath: string; metadata: OwnershipMetadata }
  | { ok: false; code: "ALREADY_RUNNING"; reason: string; existingOwnerPid: number }
  | { ok: false; code: "STATE_UNCERTAIN" | "CORRUPT_STATE"; reason: string };

/** project-lock.ts의 acquireProjectLock()과 동일한 원자성 원칙(check-then-create 금지,
 *  `wx` exclusive create만으로 승부를 가름)을 이 controller singleton lock에도 적용한다 —
 *  다만 이 lock은 canonical project path가 아니라 이 AutoDev 설치 하나를 대표하는 고정
 *  경로 하나만 쓴다(§ 요구사항 14, project-lock과 저장소/의미를 섞지 않는다). */
function acquireControllerOwnership(dir: string, testDeps: TelegramControllerSupervisorTestDeps): AcquireOutcome {
  const filePath = lockFilePath(dir);
  const pid = testDeps.pid ?? process.pid;
  const processStartedAtMs = testDeps.processStartedAtMs ?? Date.now() - Math.round(process.uptime() * 1000);
  const assessLiveness = testDeps.assessLiveness ?? assessOwnerLiveness;

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const metadata: OwnershipMetadata = {
      schemaVersion: TELEGRAM_CONTROLLER_SUPERVISOR_SCHEMA_VERSION,
      supervisorId: randomUUID(),
      pid,
      processStartedAtMs,
      startedAt: new Date().toISOString(),
    };

    try {
      writeFileSync(filePath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf-8", flag: "wx" });
      return { ok: true, filePath, metadata };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return { ok: false, code: "STATE_UNCERTAIN", reason: `ownership 파일 생성 실패: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    const existing = readOwnership(filePath);
    if (existing.kind === "absent") continue; // 방금 release됨 — 재시도.
    if (existing.kind === "corrupt") {
      return { ok: false, code: "CORRUPT_STATE", reason: "controller ownership 파일이 손상되었습니다 — 자동 삭제하지 않고 중단합니다(사람 확인 필요)." };
    }

    if (existing.metadata.pid === pid) {
      // 같은 프로세스 재진입 — 이 프로세스가 이미 controller를 소유하고 있었다는 뜻이다
      // (예: ensureTelegramControllerStarted를 같은 프로세스에서 두 번 호출). 항상 안전하게
      // 복구한다(project-lock.ts와 동일한 원칙).
      if (!tryRemove(filePath)) return { ok: false, code: "STATE_UNCERTAIN", reason: "같은 프로세스의 이전 ownership을 정리하지 못했습니다." };
      continue;
    }

    const verdict = assessLiveness(existing.metadata.pid, existing.metadata.processStartedAtMs);
    if (verdict.verdict === "ALIVE") {
      return {
        ok: false,
        code: "ALREADY_RUNNING",
        reason: `Telegram controller는 이미 다른 프로세스(pid=${existing.metadata.pid})가 실행 중입니다 — 중복 poller를 만들지 않습니다.`,
        existingOwnerPid: existing.metadata.pid,
      };
    }
    if (verdict.verdict === "UNCERTAIN") {
      return { ok: false, code: "STATE_UNCERTAIN", reason: `기존 controller owner(pid=${existing.metadata.pid})의 생존 여부를 확인할 수 없습니다: ${verdict.reason}` };
    }

    // STALE 증명됨 — 밀어내고 재시도.
    tryRemove(filePath);
  }

  return { ok: false, code: "STATE_UNCERTAIN", reason: `controller ownership 획득을 ${MAX_ACQUIRE_ATTEMPTS}회 시도했지만 확정하지 못했습니다.` };
}

function releaseControllerOwnership(filePath: string, expected: OwnershipMetadata): void {
  const current = readOwnership(filePath);
  if (current.kind !== "valid") return; // 이미 없거나 손상됨 — 더 할 일 없음(다른 owner의 것을 건드리지 않는다).
  if (current.metadata.supervisorId !== expected.supervisorId) return; // 다른 owner의 lock — release하지 않는다.
  tryRemove(filePath);
}

function nonOwnerHandle(runtimeDir: string): TelegramControllerSupervisorHandle {
  return {
    isOwner: () => false,
    getStatus: () => peekTelegramControllerStatus(runtimeDir),
    flushOnce: async () => false,
    stop: async () => {
      // 이 프로세스는 controller를 소유하지 않았다 — stop()은 항상 안전한 no-op이다(다른
      // owner의 controller를 강제 종료하는 기능은 이 파일에 없다, § 요구사항 4의 lock
      // stealing 금지 원칙과 동일).
    },
  };
}

/**
 * Telegram controller가 필요하면(=이 프로세스가 singleton ownership을 얻으면) 시작하고,
 * 이미 다른 프로세스가 서비스 중이면 두 번째 poller를 만들지 않는다. AutoDev 여러
 * entrypoint(run.ts/telegram-controller-main.ts/self-dev notifier)가 모두 이 함수 하나만
 * 호출한다(§ 요구사항 2 — canonical layer 하나).
 *
 * 이 함수는 어떤 이유로도 throw하지 않는다 — controller supervisor 실패가 AutoDev 실행
 * 자체를 막아서는 안 된다(§ 요구사항 8). 실패/불확실한 상태는 항상 non-owner handle +
 * DEGRADED 판정으로 표현된다.
 */
export async function ensureTelegramControllerStarted(
  manifest: ProjectManifest,
  testDeps: TelegramControllerSupervisorTestDeps = {}
): Promise<TelegramControllerSupervisorHandle> {
  const runtimeDir = testDeps.runtimeDir ?? DEFAULT_RUNTIME_DIR;
  const startControllerImpl = testDeps.startController ?? startTelegramController;
  const watchdogIntervalMs = testDeps.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
  const restartBackoffMs = testDeps.restartBackoffMs ?? DEFAULT_RESTART_BACKOFF_MS;
  const longPollTimeoutSec = testDeps.longPollTimeoutSec ?? DEFAULT_SUPERVISOR_LONG_POLL_TIMEOUT_SEC;

  let acquired: AcquireOutcome;
  try {
    acquired = acquireControllerOwnership(runtimeDir, testDeps);
  } catch (err) {
    log("telegram-controller-supervisor: ownership 획득 중 예외 — controller를 시작하지 않습니다.", {
      error: err instanceof Error ? err.message : String(err),
    });
    return nonOwnerHandle(runtimeDir);
  }

  if (!acquired.ok) {
    if (acquired.code === "ALREADY_RUNNING") {
      log("telegram-controller-supervisor: 기존 controller 발견 — 이 프로세스는 새로 시작하지 않습니다.", {
        existingOwnerPid: acquired.existingOwnerPid,
      });
    } else {
      log(`telegram-controller-supervisor: ownership BLOCK(${acquired.code}) — controller를 시작하지 않습니다(DEGRADED).`, {
        reason: acquired.reason,
      });
    }
    return nonOwnerHandle(runtimeDir);
  }

  const ownershipFilePath = acquired.filePath;
  const ownershipMetadata = acquired.metadata;
  const supervisorId = ownershipMetadata.supervisorId;
  const configured = Boolean(process.env.AUTODEV_TELEGRAM_BOT_TOKEN && process.env.AUTODEV_TELEGRAM_CHAT_ID);

  let restartCount = 0;
  let stopped = false;
  let watchdogTimer: ReturnType<typeof setInterval> | undefined;
  let controllerHandle: TelegramControllerHandle | undefined;

  function currentStatus(state: TelegramControllerHealthState): TelegramControllerStatus {
    const lastTick = controllerHandle?.getLastTickSummary();
    return {
      schemaVersion: TELEGRAM_CONTROLLER_SUPERVISOR_SCHEMA_VERSION,
      supervisorId,
      pid: ownershipMetadata.pid,
      state,
      startedAt: ownershipMetadata.startedAt,
      updatedAt: new Date().toISOString(),
      lastTickAt: lastTick?.at,
      lastTickError: lastTick?.tickError,
      restartCount,
    };
  }

  function persistStatus(state: TelegramControllerHealthState): void {
    writeStatus(runtimeDir, currentStatus(state));
  }

  persistStatus("STARTING");

  async function startOnce(): Promise<TelegramControllerHandle | undefined> {
    try {
      return await startControllerImpl({ manifest, longPollTimeoutSec });
    } catch (err) {
      log("telegram-controller-supervisor: controller 시작 실패", { error: err instanceof Error ? err.message : String(err) });
      return undefined;
    }
  }

  function giveUpPermanently(): void {
    stopped = true;
    if (watchdogTimer) clearInterval(watchdogTimer);
    persistStatus("DEGRADED");
    releaseControllerOwnership(ownershipFilePath, ownershipMetadata);
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function attemptRestart(): Promise<void> {
    if (stopped) return;
    if (restartCount >= restartBackoffMs.length) {
      log("telegram-controller-supervisor: bounded restart 상한 도달 — 더 이상 재시작하지 않습니다(DEGRADED).", { restartCount });
      giveUpPermanently();
      return;
    }
    const backoff = restartBackoffMs[restartCount];
    restartCount += 1;
    log("telegram-controller-supervisor: controller 재시작 시도", { attempt: restartCount, backoffMs: backoff });
    await delay(backoff);
    if (stopped) return;
    const next = await startOnce();
    if (!next) {
      // startController() 자체가 다시 throw했다 — 설정/구조적 문제일 가능성이 높다(§
      // 요구사항 9: permanent config error는 무한 재시작하지 않는다). 남은 restart 예산을
      // 마저 소진해보되(일시적 I/O 문제일 수도 있으므로), 예산 소진 시 즉시 DEGRADED로
      // 확정한다 — attemptRestart 재귀 호출 자체가 restartCount 상한 검사를 다시 거친다.
      await attemptRestart();
      return;
    }
    controllerHandle = next;
    persistStatus(configured ? "RUNNING" : "NOT_CONFIGURED");
  }

  let restartInFlight = false;

  function startWatchdog(): void {
    watchdogTimer = setInterval(() => {
      if (stopped || restartInFlight) return; // 이미 진행 중인 restart 시도가 끝나기 전에는
      // 같은 interval의 다음 tick이 겹쳐 attemptRestart()를 중복 호출하지 않는다(중복 호출은
      // restartCount를 실제 crash 횟수보다 더 빨리 소진시켜 bounded restart 예산 판정을
      // 왜곡한다).
      if (controllerHandle && !controllerHandle.isRunning()) {
        // 의도한 stop()이 아닌데 loop가 멈춰 있다 — crash로 간주하고 bounded restart를
        // 시도한다(§ 요구사항 9).
        restartInFlight = true;
        void attemptRestart().finally(() => {
          restartInFlight = false;
        });
        return;
      }
      // 살아있으면 lastTickAt/lastTickError만 최신화한다(순수 관측 — 어떤 판정도 하지
      // 않는다).
      persistStatus(configured ? "RUNNING" : "NOT_CONFIGURED");
    }, watchdogIntervalMs);
    // Node 프로세스가 이 interval 하나 때문에 종료되지 못하는 일이 없게 한다 — 실제 종료
    // 여부는 controller 자신의 tick 타이머(telegram-controller.ts)가 이미 결정한다.
    watchdogTimer.unref?.();
  }

  const firstHandle = await startOnce();
  if (!firstHandle) {
    log("telegram-controller-supervisor: 최초 시작 실패 — bounded restart를 시도합니다.");
    await attemptRestart();
    if (!controllerHandle) {
      // 최초 시작 + 모든 restart 예산 소진 — DEGRADED로 확정하고 ownership을 반환한다(다음
      // 시도가 처음부터 다시 판단할 수 있게).
      giveUpPermanently();
      return nonOwnerHandle(runtimeDir);
    }
  } else {
    controllerHandle = firstHandle;
    persistStatus(configured ? "RUNNING" : "NOT_CONFIGURED");
  }

  startWatchdog();

  return {
    isOwner: () => true,
    getStatus: () => currentStatus(stopped ? "STOPPED" : configured ? "RUNNING" : "NOT_CONFIGURED"),
    flushOnce: async (timeoutMs = 5_000) => {
      if (!controllerHandle) return false;
      const before = controllerHandle.getLastTickSummary()?.at;
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const after = controllerHandle.getLastTickSummary()?.at;
        if (after !== undefined && after !== before) return true;
        await delay(50);
      }
      return false;
    },
    stop: async () => {
      if (stopped) return; // idempotent(§ 요구사항 10 — 중복 종료에도 안전).
      stopped = true;
      if (watchdogTimer) clearInterval(watchdogTimer);
      if (controllerHandle) {
        try {
          await controllerHandle.stop();
        } catch (err) {
          log("telegram-controller-supervisor: controller stop() 중 오류(무시하고 ownership은 반환합니다)", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      persistStatus("STOPPED");
      releaseControllerOwnership(ownershipFilePath, ownershipMetadata);
    },
  };
}
