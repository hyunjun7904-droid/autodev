import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendDashboardLog } from "./dashboard-log";
import type { DashboardLogFields } from "./dashboard-log";
import { checkSupervisorLock, defaultIsPidAlive, computeBackoffDelayMs, shouldResetFailureStreak } from "./dashboard-supervisor";
import type { LockCheckResult } from "./dashboard-supervisor";

// AutoDev Continuous Runner Lifecycle Independence(2026-08-28 Maintenance) — 이번 세션의
// 실제 production incident: run.ts(--continuous)를 Claude Code harness가 추적하는 background
// shell(run_in_background)로 띄웠더니, 그 shell을 감싼 job object가 정리될 때 자식인 AutoDev
// runner 프로세스까지 함께 죽었다(2회 재현). 그 자리에서 즉석으로 만든 우회책(WScript.Shell.Run
// 을 통한 detached 실행, cmd.exe 중첩따옴표 한 줄짜리 커맨드라인)은 그 자체로 새 버그를
// 만들었다 — cmd.exe의 중첩 quote 파싱이 깨져 `set AUTODEV_CONTINUOUS_RUN=true`가 자식
// 프로세스에 전달되지 않았고, 그 결과 run.ts가 매번 continuous가 아닌 one-shot 모드로
// fallback해 Task 하나(REVIEW_CYCLE_EXHAUSTED/Reviewer BLOCK 등 기술적 WAITING_HUMAN)마다
// 프로세스가 멈추고 사람이 수동으로 재시작해야 했다.
//
// 이 파일은 그 두 문제를 함께 해결한다:
//   1) dashboard-supervisor.ts와 정확히 동일한 설계(§ 그 파일 상단 주석)로 child 프로세스를
//      계속 살려둔다 — 다만 "포트로 건강 확인"이 아니라 "프로세스가 아직 살아있는가"만 본다
//      (러너는 HTTP 서버가 아니다). 죽으면 bounded backoff(기존 dashboard-supervisor.ts의
//      computeBackoffDelayMs/shouldResetFailureStreak를 그대로 재사용, 새 상수/로직을 만들지
//      않는다)로 재시작한다 — 재시작된 프로세스가 같은 task를 이어가는 것은 이미 autodev.ts의
//      Process/Restart Circuit Breaker(§ MID_FLIGHT_ORCHESTRATOR_STATUSES)와 human-gate-
//      policy.ts의 기술적 WAITING_HUMAN 자동 복구가 담당한다 — 이 파일은 그 로직을 전혀
//      중복하지 않는다.
//   2) child를 `node.exe`로 직접 spawn()하고 --continuous를 Node argv로 직접 넘긴다(shell:false
//      기본값 — 어떤 cmd.exe/PowerShell 중첩 quote 파싱도 거치지 않는다). env는
//      `{ ...process.env, ...override }` 객체로 직접 전달한다 — 문자열 커맨드라인 조립이
//      전혀 없으므로 이번 세션에서 실제로 발생한 quoting 버그 클래스 자체가 구조적으로 존재할
//      수 없다.
//
// duplicate launch 방지(§ 요구사항 "duplicate launch → one writer") — 이 파일 자신의 lock은
// "같은 project에 대한 supervisor가 이미 떠 있는가"만 막는다(project별 lock 파일,
// checkSupervisorLock/defaultIsPidAlive를 dashboard-supervisor.ts에서 그대로 import해 재사용 —
// 로직 복제 없음). 실제 "같은 project에 대해 동시에 두 writer가 개발 작업을 하지 못하게" 막는
// 것은 이미 project-lock.ts가 runAutodevOnce() 안에서 담당한다(이 파일은 그 보장을 전혀
// 재구현하지 않는다) — 설령 이 supervisor의 lock을 어떤 이유로 우회해 두 supervisor가 같은
// project를 향해 각자 child를 spawn하더라도, 나중에 spawn된 child는 project-lock.ts에 의해
// BLOCKED_PROJECT_LOCK으로 즉시 종료될 뿐 실제 동시 쓰기는 발생하지 않는다(defense in depth).
//
// Dashboard/Runner failure domain 분리 — 이 파일은 dashboard-supervisor.ts의 순수 함수
// (backoff 계산/lock 판정)만 import한다. dashboard.js를 spawn/kill하지 않고, dashboard의
// lock/log 파일도 건드리지 않는다 — Dashboard가 죽어도 이 supervisor/runner는 영향받지 않고,
// 이 supervisor/runner가 죽어도 Dashboard는 영향받지 않는다(각자 독립된 lock 파일, 독립된
// child, 독립된 log 파일).

export const DEFAULT_RUNNER_BACKOFF_SCHEDULE_MS = [5_000, 15_000, 30_000];
export const DEFAULT_RUNNER_COOLDOWN_MS = 60_000;
export const DEFAULT_RUNNER_SUSTAINED_UPTIME_RESET_MS = 5 * 60_000;
const OUTPUT_TAIL_MAX_CHARS = 4_000;

export interface RunnerSupervisorConfig {
  spawnCommand: string;
  spawnArgs: string[];
  cwd: string;
  /** child 프로세스에 병합할 환경변수 override(예: AUTOMATION_DRY_RUN/AUTODEV_PRODUCTION_RUNTIME).
   *  실제 spawn 시 { ...process.env, ...env }로 병합한다 — 문자열 커맨드라인 조립이 전혀
   *  없으므로 어떤 shell quoting도 거치지 않는다(§ 파일 상단 주석 2). */
  env: Record<string, string>;
  backoffScheduleMs: number[];
  cooldownMs: number;
  sustainedUptimeResetMs: number;
}

export interface SupervisedRunnerChild {
  pid?: number;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
}

export interface RunnerSupervisorDeps {
  spawnChild: () => SupervisedRunnerChild;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  now: () => number;
  log: (fields: DashboardLogFields) => void;
}

/** dashboard-supervisor.ts의 runSupervisorLoop와 동일한 구조(순수 함수, 실제 OS spawn 없이
 *  테스트 가능) — 포트 확인 단계가 없다(러너는 서버가 아니다): "child가 살아있는 동안은
 *  아무것도 하지 않고 exit을 기다린다 → 죽으면 backoff 후 재시작"만 반복한다. */
export async function runRunnerSupervisorLoop(config: RunnerSupervisorConfig, deps: RunnerSupervisorDeps, signal: AbortSignal): Promise<void> {
  let consecutiveFailures = 0;
  while (!signal.aborted) {
    if (consecutiveFailures > 0) {
      const delayMs = computeBackoffDelayMs(consecutiveFailures, config.backoffScheduleMs, config.cooldownMs);
      deps.log({ event: "RESTART_SCHEDULED", consecutiveFailures, delayMs });
      await deps.sleep(delayMs, signal);
      if (signal.aborted) break;
    }
    const child = deps.spawnChild();
    const startedAt = deps.now();
    deps.log({ event: "SPAWNED", pid: child.pid });
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
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

/** dashboard-supervisor.ts의 lock 파일과 달리 project별로 분리한다 — 서로 다른 project를
 *  가리키는 supervisor 두 개는 서로를 막지 않는다(§ AutoDev는 project-agnostic Core).
 *  영숫자/-/_/. 외 문자는 전부 _로 치환한다(usage-ledger.ts/problem-memory.ts와 동일한 방어적
 *  원칙 — 파일 경로 escape 방지). */
export function sanitizeForFilename(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function resolveAdapterPath(): string | undefined {
  const idx = process.argv.indexOf("--project");
  if (idx !== -1 && typeof process.argv[idx + 1] === "string" && process.argv[idx + 1].length > 0) {
    return process.argv[idx + 1];
  }
  const fromEnv = process.env.AUTODEV_PROJECT_ADAPTER;
  return fromEnv && fromEnv.trim().length > 0 ? fromEnv : undefined;
}

function main(): void {
  const adapterPath = resolveAdapterPath();
  if (!adapterPath) {
    // eslint-disable-next-line no-console
    console.error("[runner-supervisor] project adapter가 지정되지 않았습니다 — --project <path> 또는 AUTODEV_PROJECT_ADAPTER 환경변수로 지정하세요.");
    process.exitCode = 1;
    return;
  }

  const repoRoot = join(__dirname, "..");
  const runJsPath = join(__dirname, "run.js");
  const logsDir = join(repoRoot, "logs");
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  const lockFilePath = join(logsDir, `runner-supervisor-${sanitizeForFilename(adapterPath)}.lock`);
  const logFilePath = join(logsDir, "runner-supervisor.log");

  const lockCheck: LockCheckResult = checkSupervisorLock(lockFilePath, defaultIsPidAlive);
  if (lockCheck.action === "ALREADY_RUNNING") {
    appendDashboardLog(logFilePath, { event: "DUPLICATE_SUPERVISOR_BLOCKED", reason: lockCheck.reason });
    return;
  }
  writeFileSync(lockFilePath, JSON.stringify({ pid: process.pid, adapterPath, startedAt: new Date().toISOString() }), "utf-8");

  const controller = new AbortController();
  let shuttingDown = false;
  function shutdown(reason: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    controller.abort();
    appendDashboardLog(logFilePath, { event: "SUPERVISOR_SHUTDOWN", reason });
    try {
      if (existsSync(lockFilePath)) unlinkSync(lockFilePath);
    } catch {
      // lock 정리 실패는 다음 supervisor 시작 시 stale-lock 경로로 자연히 흡수된다.
    }
    process.exit(0);
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const config: RunnerSupervisorConfig = {
    spawnCommand: process.execPath,
    spawnArgs: [runJsPath, "--continuous", "--project", adapterPath],
    cwd: repoRoot,
    env: { AUTOMATION_DRY_RUN: "false", AUTODEV_PRODUCTION_RUNTIME: "true" },
    backoffScheduleMs: DEFAULT_RUNNER_BACKOFF_SCHEDULE_MS,
    cooldownMs: DEFAULT_RUNNER_COOLDOWN_MS,
    sustainedUptimeResetMs: DEFAULT_RUNNER_SUSTAINED_UPTIME_RESET_MS,
  };

  const deps: RunnerSupervisorDeps = {
    spawnChild: () => {
      // shell:false(기본값) — 커맨드라인 문자열 조립/quote 파싱이 전혀 없다(§ 파일 상단
      // 주석 2). detached:false로 충분하다 — 이 supervisor 프로세스 자신이 이미 harness의
      // job object 밖(§ 이 파일을 실행하는 launcher, start-runner-silent.vbs)에서 실행되므로
      // child는 자연히 그 밖에서 태어난다(Windows job object 상속은 기본적으로 parent -> child
      // 방향으로만 전파된다).
      const child = spawn(config.spawnCommand, config.spawnArgs, {
        cwd: config.cwd,
        env: { ...process.env, ...config.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
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
      return child;
    },
    sleep: realSleep,
    now: () => Date.now(),
    log: (fields) => appendDashboardLog(logFilePath, fields),
  };

  appendDashboardLog(logFilePath, { event: "SUPERVISOR_STARTED", adapterPath });
  runRunnerSupervisorLoop(config, deps, controller.signal).catch((e) => {
    appendDashboardLog(logFilePath, { event: "SUPERVISOR_LOOP_CRASHED", reason: e instanceof Error ? e.message : String(e) });
  });
}

// require.main===module 가드 — 테스트가 이 파일을 import해도 실제 supervisor loop/spawn이
// 자동으로 시작되지 않는다(§ dashboard-supervisor.ts와 동일 관례).
if (require.main === module) {
  main();
}
