import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { checkExistingServer } from "./dashboard";
import type { PortCheckResult } from "./dashboard";
import { DEFAULT_PORT } from "./dashboard-server";
import { appendDashboardLog } from "./dashboard-log";
import type { DashboardLogFields } from "./dashboard-log";

// AutoDev 대시보드 서버 장애 원인분석·복구·하드닝(§ 요구사항 6/7/9/11) — 대시보드는 AutoDev
// 본체와 완전히 분리된 관측 시스템이어야 하고, 죽으면 스스로 자동 복구되어야 한다. 이 파일이
// 하는 일은 단 하나: dashboard.js 프로세스를 자식으로 계속 살려두는 것 — Task 성격/우선순위
// 판단, 실행 승인, git/shell 실행 등은 이 파일에 전혀 없다(§ 대시보드 절대 금지 사항, 실행 대상은
// 오직 dashboard.js 하나로 고정되어 있고 이 파일 자체가 그 인자를 임의로 바꿀 방법이 없다).
//
// 설계(§ 요구사항 6 "가장 단순하고 신뢰성 높은 방식") — 매 loop마다 실제 포트 상태를 다시
// 확인하는 것을 유일한 진실 소스로 삼는다(dashboard.js의 exit code만으로 "정상 종료"/"포트
// 충돌"/"진짜 crash"를 구분하지 않는다 — 이 세 경우 모두 현재 exit code 1로 겹칠 수 있어
// 신뢰할 수 없다):
//   - OURS(우리 대시보드가 이미 응답 중) -> 아무것도 하지 않고 폴링만 계속한다(중복 실행 방지).
//   - OTHER(다른 프로그램이 그 포트를 씀) -> 절대 다른 포트로 넘어가지 않는다. 그 프로그램이
//     사라질 때까지 주기적으로 재확인만 한다(§ 요구사항 9 "포트 충돌 → 프로세스 종료 후 자동
//     으로 원래 포트 복구").
//   - FREE -> dashboard.js를 spawn한다. 빠르게 반복 실패하면 bounded backoff(§
//     DEFAULT_BACKOFF_SCHEDULE_MS)로 재시도 간격을 늘리고, 일정 횟수 이후에는 고정 cooldown으로
//     전환한다(무한 빠른 재시작 루프 금지). 충분히 오래 살아있었다면(§
//     DEFAULT_SUSTAINED_UPTIME_RESET_MS) 다음 실패는 새 crash 계열로 보고 backoff를 리셋한다.

export const DEFAULT_BACKOFF_SCHEDULE_MS = [2_000, 5_000, 15_000];
export const DEFAULT_COOLDOWN_MS = 60_000;
export const DEFAULT_SUSTAINED_UPTIME_RESET_MS = 60_000;
export const DEFAULT_HEALTHY_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_PORT_CONFLICT_RECHECK_MS = 30_000;
const OUTPUT_TAIL_MAX_CHARS = 2_000;

export interface SupervisorConfig {
  port: number;
  spawnCommand: string;
  spawnArgs: string[];
  cwd: string;
  backoffScheduleMs: number[];
  cooldownMs: number;
  sustainedUptimeResetMs: number;
  healthyPollIntervalMs: number;
  portConflictRecheckMs: number;
}

/** consecutiveFailures(방금 실패까지 포함한 연속 실패 횟수)에 대응하는 다음 spawn까지의 대기
 *  시간을 계산한다. schedule 범위를 넘어서면 cooldownMs로 bounded된다 — 무한히 빨라지는 재시작
 *  루프를 막는다(§ 요구사항 7). */
export function computeBackoffDelayMs(consecutiveFailures: number, schedule: number[], cooldownMs: number): number {
  if (consecutiveFailures <= 0) return 0;
  if (consecutiveFailures <= schedule.length) return schedule[consecutiveFailures - 1];
  return cooldownMs;
}

/** child가 sustainedUptimeResetMs 이상 살아있었다면 그 다음 실패는 새 crash 계열로 보고 backoff
 *  단계를 리셋한다 — 오래 잘 떠 있다가 어쩌다 한 번 죽은 경우까지 계속 backoff를 누적시키지
 *  않기 위함. */
export function shouldResetFailureStreak(childAliveMs: number, sustainedUptimeResetMs: number): boolean {
  return childAliveMs >= sustainedUptimeResetMs;
}

export interface LockCheckResult {
  action: "PROCEED" | "ALREADY_RUNNING";
  reason: string;
}

/** § 요구사항 11 "Supervisor 중복 실행 → Dashboard 여러 개 생성 금지". lock 파일이 없거나,
 *  있어도 그 안의 PID가 더 이상 살아있지 않으면(stale) 새 supervisor가 계속 진행해도 된다.
 *  isPidAlive는 테스트에서 실제 OS 프로세스 없이 주입할 수 있게 분리했다. */
export function checkSupervisorLock(lockFilePath: string, isPidAlive: (pid: number) => boolean): LockCheckResult {
  if (!existsSync(lockFilePath)) return { action: "PROCEED", reason: "NO_LOCK_FILE" };
  let pid: number | undefined;
  try {
    const raw = JSON.parse(readFileSync(lockFilePath, "utf-8")) as { pid?: number };
    pid = typeof raw.pid === "number" ? raw.pid : undefined;
  } catch {
    return { action: "PROCEED", reason: "LOCK_FILE_UNREADABLE_TREAT_AS_STALE" };
  }
  if (pid === undefined) return { action: "PROCEED", reason: "LOCK_FILE_MALFORMED_TREAT_AS_STALE" };
  if (isPidAlive(pid)) return { action: "ALREADY_RUNNING", reason: `OWNER_PID_${pid}_ALIVE` };
  return { action: "PROCEED", reason: `OWNER_PID_${pid}_DEAD_STALE_LOCK` };
}

const MAX_SUPERVISOR_LOCK_ACQUIRE_ATTEMPTS = 5;

export type AcquireSupervisorLockResult = { ok: true } | { ok: false; reason: string };

/** § P0-2 하드닝 — Supervisor singleton ownership을 원자적으로 얻는다. 기존
 *  checkSupervisorLock()은 순수 read-only 판정(§ project-control-cli.ts의 상태 조회 용도로는
 *  그대로 남겨둔다)일 뿐이라, main()이 그 결과를 보고 별도로 writeFileSync(...)하는 방식은
 *  check-then-create다 — 두 supervisor가 동시에 "잠겨있지 않음"을 보고 각자 write하면 마지막
 *  write가 조용히 이기고 둘 다 이미 child를 spawn하는 race가 있었다. project-lock.ts의
 *  acquireProjectLock()과 동일한 원칙(`wx` exclusive create만이 실제 승부를 가른다)으로
 *  대체한다. 기존 lock이 살아있으면(isPidAlive) 절대 덮어쓰지 않고 ALREADY_RUNNING을
 *  반환하고, 죽었다고 판정되면(stale) CAS-equivalent compare-before-delete(§
 *  tryRemoveStaleSupervisorLock — project-lock.ts의 tryRemoveStaleLock과 동일한 원칙)로
 *  밀어내고 재시도한다 — 그 사이 다른 supervisor가 이미 살아있는 fresh lock으로 교체했다면
 *  그 lock은 절대 지우지 않는다. */
export function acquireSupervisorLockAtomic(
  lockFilePath: string,
  isPidAlive: (pid: number) => boolean,
  extraMetadata: Record<string, unknown> = {},
  pid: number = process.pid
): AcquireSupervisorLockResult {
  for (let attempt = 0; attempt < MAX_SUPERVISOR_LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    const lockId = randomUUID();
    try {
      writeFileSync(lockFilePath, JSON.stringify({ pid, lockId, startedAt: new Date().toISOString(), ...extraMetadata }), {
        encoding: "utf-8",
        flag: "wx",
      });
      return { ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return { ok: false, reason: `supervisor lock 파일 생성 실패: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    let existing: { pid?: number; lockId?: string } | undefined;
    try {
      existing = JSON.parse(readFileSync(lockFilePath, "utf-8")) as { pid?: number; lockId?: string };
    } catch {
      existing = undefined; // 방금 사라졌거나(재시도) 손상됨 — 아래에서 재시도한다.
    }
    if (existing === undefined) continue; // 다음 루프의 wx create가 최종 상태를 다시 판정한다.
    if (typeof existing.pid === "number" && isPidAlive(existing.pid)) {
      return { ok: false, reason: `OWNER_PID_${existing.pid}_ALIVE` };
    }
    // stale(또는 pid 필드가 없는 malformed — 기존 checkSupervisorLock과 동일하게 stale
    // 취급)로 판정됨 — CAS compare-before-delete로 밀어낸다.
    tryRemoveStaleSupervisorLock(lockFilePath, existing.lockId);
  }
  return { ok: false, reason: `supervisor lock 획득을 ${MAX_SUPERVISOR_LOCK_ACQUIRE_ATTEMPTS}회 시도했지만 확정하지 못했습니다.` };
}

/** stale로 판정된 supervisor lock을 제거한다 — unlink 직전에 다시 읽어 lockId가 여전히 우리가
 *  stale로 판정했던 값과 같은지 확인한다(§ project-lock.ts의 tryRemoveStaleLock과 동일한
 *  원칙). 그 사이 다른 supervisor가 이 자리를 자신의 fresh lock으로 교체했다면(lockId가
 *  다르다) 절대 지우지 않는다. */
function tryRemoveStaleSupervisorLock(lockFilePath: string, expectedLockId: string | undefined): void {
  let current: { lockId?: string } | undefined;
  try {
    current = JSON.parse(readFileSync(lockFilePath, "utf-8")) as { lockId?: string };
  } catch {
    return; // 이미 없어졌거나(ENOENT) 여전히 파싱 불가 — 확정할 수 있는 삭제 대상이 없다.
  }
  if (current.lockId !== expectedLockId) return; // 다른 supervisor가 이미 교체함 — 지우지 않는다.
  try {
    unlinkSync(lockFilePath);
  } catch {
    /* ENOENT 등 — 이미 없어졌으면 상관없다(다음 loop이 재평가). */
  }
}

/** pid==0 신호는 프로세스를 죽이지 않고 존재 여부만 물어본다(Node가 Windows에서도 이 의미를
 *  이식성 있게 제공한다). EPERM은 "존재하지만 신호 보낼 권한이 없다"는 뜻이라 여전히 살아있는
 *  것으로 본다 — ESRCH(또는 그 외)만 죽은 것으로 본다. */
export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface SupervisedChild {
  pid?: number;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  kill(): boolean;
}

export interface SupervisorDeps {
  probePort: (port: number) => Promise<PortCheckResult>;
  spawnChild: () => SupervisedChild;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  log: (fields: DashboardLogFields) => void;
}

/** 실제 loop 본체 — 순수하게 주입된 deps만으로 동작해 실제 OS spawn 없이도 테스트할 수 있다.
 *  signal이 abort되면 다음으로 안전하게 멈출 수 있는 지점에서 정지한다. */
export async function runSupervisorLoop(config: SupervisorConfig, deps: SupervisorDeps, signal: AbortSignal): Promise<void> {
  let consecutiveFailures = 0;
  while (!signal.aborted) {
    const probe = await deps.probePort(config.port);
    if (probe === "OURS") {
      if (consecutiveFailures > 0) deps.log({ event: "RECOVERED", consecutiveFailures });
      consecutiveFailures = 0;
      await deps.sleep(config.healthyPollIntervalMs, signal);
      continue;
    }
    if (probe === "OTHER") {
      deps.log({ event: "PORT_CONFLICT", port: config.port });
      await deps.sleep(config.portConflictRecheckMs, signal);
      continue;
    }
    // FREE
    if (consecutiveFailures > 0) {
      const delayMs = computeBackoffDelayMs(consecutiveFailures, config.backoffScheduleMs, config.cooldownMs);
      deps.log({ event: "RESTART_SCHEDULED", consecutiveFailures, delayMs });
      await deps.sleep(delayMs, signal);
      if (signal.aborted) break;
    }
    const child = deps.spawnChild();
    const startedAt = deps.now();
    deps.log({ event: "SPAWNED", pid: child.pid, port: config.port });
    const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.once("exit", (code, sig) => resolve({ code, signal: sig }));
    });
    const aliveMs = deps.now() - startedAt;
    deps.log({ event: "CHILD_EXITED", pid: child.pid, exitCode: exitInfo.code, signal: exitInfo.signal, aliveMs });
    consecutiveFailures = shouldResetFailureStreak(aliveMs, config.sustainedUptimeResetMs) ? 0 : consecutiveFailures + 1;
  }
}

function realSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

function main(): void {
  const portEnv = process.env.AUTODEV_DASHBOARD_PORT;
  const port = portEnv && portEnv.trim().length > 0 ? Number(portEnv) : DEFAULT_PORT;

  const repoRoot = join(__dirname, "..");
  const dashboardJsPath = join(__dirname, "dashboard.js");
  const logsDir = join(repoRoot, "logs");
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  const lockFilePath = join(logsDir, "dashboard-supervisor.lock");
  const logFilePath = join(logsDir, "dashboard-supervisor.log");

  const acquireResult = acquireSupervisorLockAtomic(lockFilePath, defaultIsPidAlive);
  if (!acquireResult.ok) {
    appendDashboardLog(logFilePath, { event: "DUPLICATE_SUPERVISOR_BLOCKED", reason: acquireResult.reason });
    return;
  }

  const controller = new AbortController();
  let currentChild: SupervisedChild | undefined;
  let shuttingDown = false;

  function shutdown(reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    controller.abort();
    appendDashboardLog(logFilePath, { event: "SUPERVISOR_SHUTDOWN", reason });
    try {
      if (existsSync(lockFilePath)) unlinkSync(lockFilePath);
    } catch {
      // lock 정리 실패는 다음 supervisor 시작 시 stale-lock 경로(§ checkSupervisorLock)로
      // 자연히 흡수된다.
    }
    if (currentChild) {
      try {
        currentChild.kill();
      } catch {
        // 이미 죽어 있으면 무시.
      }
    }
    process.exit(0);
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const config: SupervisorConfig = {
    port,
    spawnCommand: process.execPath,
    spawnArgs: [dashboardJsPath],
    cwd: repoRoot,
    backoffScheduleMs: DEFAULT_BACKOFF_SCHEDULE_MS,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    sustainedUptimeResetMs: DEFAULT_SUSTAINED_UPTIME_RESET_MS,
    healthyPollIntervalMs: DEFAULT_HEALTHY_POLL_INTERVAL_MS,
    portConflictRecheckMs: DEFAULT_PORT_CONFLICT_RECHECK_MS,
  };

  const deps: SupervisorDeps = {
    probePort: (p) => checkExistingServer(p),
    spawnChild: () => {
      const child = spawn(config.spawnCommand, config.spawnArgs, { cwd: config.cwd, stdio: ["ignore", "pipe", "pipe"] });
      let outputTail = "";
      const capture = (chunk: Buffer): void => {
        outputTail = (outputTail + chunk.toString("utf-8")).slice(-OUTPUT_TAIL_MAX_CHARS);
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);
      child.once("exit", () => {
        if (outputTail.trim().length > 0) {
          appendDashboardLog(logFilePath, { event: "CHILD_OUTPUT_TAIL", pid: child.pid, outputTail });
        }
      });
      currentChild = child;
      return child;
    },
    sleep: realSleep,
    now: () => Date.now(),
    log: (fields) => appendDashboardLog(logFilePath, fields),
  };

  appendDashboardLog(logFilePath, { event: "SUPERVISOR_STARTED", port });
  runSupervisorLoop(config, deps, controller.signal).catch((e) => {
    appendDashboardLog(logFilePath, { event: "SUPERVISOR_LOOP_CRASHED", reason: e instanceof Error ? e.message : String(e) });
  });
}

// require.main===module 가드 — 테스트가 이 파일을 import해도 실제 supervisor loop/spawn이
// 자동으로 시작되지 않는다(§ dashboard.ts와 동일 관례).
if (require.main === module) {
  main();
}
