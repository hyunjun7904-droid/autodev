import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendDashboardLog } from "./dashboard-log";
import type { DashboardLogFields } from "./dashboard-log";
import { acquireSupervisorLockAtomic, defaultIsPidAlive, computeBackoffDelayMs, shouldResetFailureStreak } from "./dashboard-supervisor";

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
export const DEFAULT_MAINTENANCE_POLL_INTERVAL_MS = 2_000;
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
  /** Maintenance Pause(§ 아래 "Maintenance Pause — spawn-only 일시정지") 마커가 감지된
   *  동안, 다음 spawn 시도 전에 이 간격으로 재확인한다. */
  maintenancePollMs: number;
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
  /** Maintenance Pause(§ 아래) 마커가 현재 세워져 있는지 확인한다 — supervisor 자신은 이
   *  판정 자체를 갖지 않고 순수하게 이 dep에 위임한다(project-lock.ts와 역할을 섞지 않기
   *  위해 별도 primitive로 분리, § runner-supervisor.ts 상단 주석 "Maintenance Pause" 절). */
  isMaintenancePaused: () => boolean;
}

/** dashboard-supervisor.ts의 runSupervisorLoop와 동일한 구조(순수 함수, 실제 OS spawn 없이
 *  테스트 가능) — 포트 확인 단계가 없다(러너는 서버가 아니다): "child가 살아있는 동안은
 *  아무것도 하지 않고 exit을 기다린다 → 죽으면 backoff 후 재시작"만 반복한다.
 *
 * Maintenance Pause — spawn-only 일시정지(2026-08-30, controlled resume 실측 후속 조치) —
 * 실제 production incident: 이전 controlled resume 시도에서 "controlled run 종료 →
 * project-lock 재획득" 사이에 이 supervisor가 새 child를 spawn해 의도하지 않은 추가 Developer
 * 호출이 발생했다(hold-jarvis-lock.js가 project-lock을 놓는 순간과, 사람이 그것을 다시 잡는
 * 순간 사이의 TOCTOU). project-lock.ts는 "누가 지금 이 project의 유일한 writer인가"만
 * 판정할 뿐 "supervisor가 지금 새 writer를 만들어도 되는가"는 전혀 모른다(project-lock을
 * spawn 이전 검사에 섞으면 이미 spawn된 child 스스로도 같은 lock을 잡으려 하므로 역할이
 * 겹친다) — 그래서 이 둘은 의도적으로 분리된 별도 판정이다: project-lock은 "이미 시작된
 * writer들 사이의 상호배제", Maintenance Pause는 "애초에 새 writer를 시작할지 여부".
 *
 * 이 supervisor 프로세스 자체를 죽이지 않고 spawn 판단 지점 단 한 곳(다음 child를 spawn하기
 * 직전, backoff wait가 끝난 뒤)에 게이트를 하나 추가한다 — 이미 살아있는 child를 강제 종료하지
 * 않고(자연 종료를 기다린다), consecutiveFailures/backoff 스케줄은 전혀 건드리지 않는다(그냥
 * spawn 직전에 추가로 한 번 더 기다릴 뿐이다). isMaintenancePaused()가 참인 동안은
 * maintenancePollMs 간격으로 재확인하며 spawn을 미룬다 — abort되면 그 대기도 즉시 끝난다.
 * 마커가 사라진 뒤에야 정상 backoff/spawn 흐름으로 복귀한다. */
export async function runRunnerSupervisorLoop(config: RunnerSupervisorConfig, deps: RunnerSupervisorDeps, signal: AbortSignal): Promise<void> {
  let consecutiveFailures = 0;
  while (!signal.aborted) {
    if (consecutiveFailures > 0) {
      const delayMs = computeBackoffDelayMs(consecutiveFailures, config.backoffScheduleMs, config.cooldownMs);
      deps.log({ event: "RESTART_SCHEDULED", consecutiveFailures, delayMs });
      await deps.sleep(delayMs, signal);
      if (signal.aborted) break;
    }
    if (deps.isMaintenancePaused()) {
      deps.log({ event: "MAINTENANCE_PAUSE_ACTIVE" });
      while (deps.isMaintenancePaused() && !signal.aborted) {
        await deps.sleep(config.maintenancePollMs, signal);
      }
      if (signal.aborted) break;
      deps.log({ event: "MAINTENANCE_PAUSE_CLEARED" });
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

/** Maintenance Pause 마커 파일 경로를 project별로 결정한다 — lock 파일과 동일한
 *  sanitizeForFilename()을 재사용해 project adapter 경로를 안전한 파일명으로 바꾼다(§ 요구사항
 *  "project-lock과 역할을 섞지 않음" — 그래서 lock 파일과는 다른 확장자/접두사의 완전히 별도
 *  파일이다). 이 파일이 "존재하는가"만이 유일한 상태다 — 내용은 사람이 읽을 수 있는 진단
 *  메타데이터일 뿐 판정에 쓰이지 않는다(§ engageMaintenancePause). 외부 제어 스크립트와
 *  runner-supervisor.js 본체, 그리고 테스트가 모두 이 함수 하나로만 경로를 계산해 서로 다른
 *  경로를 가리키는 실수를 구조적으로 방지한다. */
export function maintenancePauseMarkerPath(adapterPath: string, logsDir: string): string {
  return join(logsDir, `runner-supervisor-maintenance-${sanitizeForFilename(adapterPath)}.pause`);
}

/** 마커 파일을 생성해 Maintenance Pause를 켠다(§ isMaintenancePaused는 이 파일의 존재 여부만
 *  본다). 이미 마커가 있으면(중복 engage) 그대로 둔다 — 여러 제어 스크립트가 겹쳐 호출해도
 *  안전하다. */
export function engageMaintenancePause(adapterPath: string, logsDir: string, reason: string): void {
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
  const markerPath = maintenancePauseMarkerPath(adapterPath, logsDir);
  writeFileSync(markerPath, `${JSON.stringify({ engagedAt: new Date().toISOString(), reason }, null, 2)}\n`, "utf-8");
}

/** 마커 파일을 지워 Maintenance Pause를 해제한다. 이미 없으면(중복 clear) 조용히 성공으로
 *  본다 — release/clear 계열 함수가 idempotent해야 한다는 이 저장소 전반의 관례(§
 *  releaseProjectLock의 "이미 없음"과 동일한 원칙)를 그대로 따른다. */
export function clearMaintenancePause(adapterPath: string, logsDir: string): void {
  const markerPath = maintenancePauseMarkerPath(adapterPath, logsDir);
  try {
    unlinkSync(markerPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/** supervisor 자신의 중복 실행 방지 lock 파일 경로 — main()과 § project-control-cli.ts(사람이
 *  supervisor 상태를 조회하는 canonical 진입점)가 이 함수 하나로만 경로를 계산해 서로 다른
 *  경로를 가리키는 실수를 구조적으로 방지한다(§ maintenancePauseMarkerPath와 동일한 관례,
 *  순수 리팩터 — 동작 변화 없음). */
export function runnerSupervisorLockFilePath(adapterPath: string, logsDir: string): string {
  return join(logsDir, `runner-supervisor-${sanitizeForFilename(adapterPath)}.lock`);
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
  const lockFilePath = runnerSupervisorLockFilePath(adapterPath, logsDir);
  const logFilePath = join(logsDir, "runner-supervisor.log");

  const acquireResult = acquireSupervisorLockAtomic(lockFilePath, defaultIsPidAlive, { adapterPath });
  if (!acquireResult.ok) {
    appendDashboardLog(logFilePath, { event: "DUPLICATE_SUPERVISOR_BLOCKED", reason: acquireResult.reason });
    return;
  }

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
    maintenancePollMs: DEFAULT_MAINTENANCE_POLL_INTERVAL_MS,
  };
  const maintenanceMarkerPath = maintenancePauseMarkerPath(adapterPath, logsDir);

  const deps: RunnerSupervisorDeps = {
    isMaintenancePaused: () => existsSync(maintenanceMarkerPath),
    spawnChild: () => {
      // shell:false(기본값) — 커맨드라인 문자열 조립/quote 파싱이 전혀 없다(§ 파일 상단
      // 주석 2). detached:false로 충분하다 — 이 supervisor 프로세스 자신이 이미 harness의
      // job object 밖(§ 이 파일을 실행하는 launcher, start-runner-silent.vbs)에서 실행되므로
      // child는 자연히 그 밖에서 태어난다(Windows job object 상속은 기본적으로 parent -> child
      // 방향으로만 전파된다).
      const child = spawn(config.spawnCommand, config.spawnArgs, {
        cwd: config.cwd,
        // P0-3 하드닝(§ parent-liveness-watchdog.ts) — child가 자기 자신의 supervisor PID를
        // 알 수 있게 넘긴다. supervisor가 비정상 종료되면 child가 스스로 감지하고 종료해
        // orphan으로 무기한 남지 않는다.
        env: { ...process.env, ...config.env, AUTODEV_SUPERVISOR_PID: String(process.pid) },
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
