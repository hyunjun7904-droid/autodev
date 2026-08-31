import { runAutodevOnce } from "./autodev";
import type { AutodevRunResult } from "./autodev";
import { runAutodevContinuous } from "./continuous-runner";
import { loadProjectAdapter } from "./project-adapter-loader";
import { loadState } from "./state";
import { getNextTask } from "./task-registry";
import { selectDefaultApprovalStore } from "./approval-store";
import { selectDefaultEventStore } from "./event-store";
import { ensureDurableApprovalForGenuineWaitingHuman } from "./local-human-approval";
import { ensureTelegramControllerStarted } from "./telegram-controller-supervisor";
import { assertProductionRuntimeForContinuousLaunch } from "./runtime-origin";
import { defaultIsPidAlive } from "./dashboard-supervisor";
import { assessOwnerLiveness } from "./project-lock";
import {
  startParentLivenessWatchdog,
  resolveSupervisorParentPidFromEnv,
  resolveSupervisorParentStartedAtMsFromEnv,
} from "./parent-liveness-watchdog";
import { readStopRequestForPid, clearStopRequest } from "./runner-supervisor";
import { log } from "./logger";
import { join } from "node:path";

// AutoDev 범용 진입점(Phase B Task B3 — run-movan.ts 대체, Phase C Task C1 — project adapter
// data-only 전환).
//
// 이 파일은 어떤 프로젝트를 개발하는지 전혀 모른다 — --project <path> 커맨드라인 인자
// 또는 AUTODEV_PROJECT_ADAPTER 환경변수로 명시된 project config(JSON 데이터 파일) 경로를
// project-adapter-loader.ts에 넘겨 ProjectManifest를 얻고, 그것을 runAutodevOnce()에
// 그대로 전달한다. 경로가 없거나, .json이 아니거나, 내용이 스키마를 어기면 즉시 실패한다
// — 어떤 기본 프로젝트로도 조용히 fallback하지 않는다. project-adapter-loader.ts는 이
// JSON을 fs.readFileSync+JSON.parse로만 읽는다 — require()/import()/eval() 등으로 프로젝트가
// 제공한 코드를 실행하지 않는다(§ project-adapter-loader.ts 상단 주석).
//
// 특정 프로젝트를 실행하려면: AUTODEV_PROJECT_ADAPTER(또는 --project)에 그 프로젝트 저장소가
// 소유한 project config(예: <project-repo>/.autodev/manifest.json)의 절대경로를 지정한다 —
// 그 프로젝트 쪽이 소유하는 wrapper 스크립트가 이 경로를 조립해 넘기는 방식을 권장한다. 새
// 프로젝트를 붙이려면 그 프로젝트가 같은 JSON 스키마(project-adapter-loader.ts 참고)를 따르는
// project config를 자신의 저장소 안에 두고 그 경로를 지정하면 된다 — 이 파일은 손댈 필요가 없다.
//
// Phase G Task G7.2 — Telegram Controller Auto Start & Supervisor. 이 파일은 이제 사람이
// 별도 터미널에서 `npm run telegram-controller`를 직접 실행하지 않아도 되도록,
// runAutodevOnce() 실행 전에 telegram-controller-supervisor.ts의 canonical entry point
// (ensureTelegramControllerStarted)로 controller singleton을 확인/시작한다. 이 함수는
// 절대 throw하지 않는다(§ telegram-controller-supervisor.ts) — controller supervisor
// 실패가 AutoDev Core 실행 자체를 막지 않는다. 이 프로세스가 실제로 controller를
// 소유했고(isOwner()) 실행 결과가 WAITING_HUMAN이면, Telegram APPROVE → Safe Auto
// Resume(auto-resume.ts, controller의 tick 안에서 같은 프로세스로 직접 호출됨)을 받을 수
// 있도록 프로세스를 종료하지 않고 대기한다(§ 요구사항 11 — WAITING_HUMAN이 됐다고
// controller를 종료하면 안 된다). WAITING_HUMAN이 아니면(정상 완료/이미 다른 프로세스가
// project를 쓰는 중이라 이번 실행이 아무 일도 하지 않은 경우 등) 이번 run이 만든 event가
// 최소 한 번 전달 시도되도록 짧게 flush한 뒤 controller를 정리하고 종료한다 — 기존
// 단발성(one-shot) 실행 UX를 그대로 보존한다(§ 요구사항 15).

function resolveAdapterPathFromArgs(): string | undefined {
  const idx = process.argv.indexOf("--project");
  if (idx !== -1 && typeof process.argv[idx + 1] === "string" && process.argv[idx + 1].length > 0) {
    return process.argv[idx + 1];
  }
  const fromEnv = process.env.AUTODEV_PROJECT_ADAPTER;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return undefined;
}

// Generic Continuous Runner(continuous-runner.ts) opt-in 여부. 지정하지 않으면(기본값)
// 기존 one-shot 동작(runAutodevOnce() 1회)이 100% 그대로 유지된다 — 어떤 프로젝트 이름도
// 여기서 분기하지 않는다.
function isContinuousModeRequested(): boolean {
  if (process.argv.includes("--continuous")) return true;
  const fromEnv = process.env.AUTODEV_CONTINUOUS_RUN;
  return fromEnv === "true" || fromEnv === "1";
}

let interrupted = false;
let resolveShutdownSignal: () => void = () => {};
const shutdownSignal = new Promise<void>((resolve) => {
  resolveShutdownSignal = resolve;
});
let shutdownHandlersInstalled = false;

// AutoDev Core Maintenance — Canonical Stop Path(2026-08-31, JARVIS Task 5.3 실측 —
// "실행 중인 Developer/continuous run을 canonical하게 정상 중단할 수 없는 결함"). 기존
// interrupted/shutdownSignal은 waitWhileWaitingHuman()(Telegram 승인 대기 단계)에서만
// 소비됐고, 실제 실행 중인 runAutodevContinuous()/runAutodevOnce()에는 전혀 전달되지 않았다
// (그 호출들은 `await runAutodevContinuous({ manifest })`처럼 이 신호를 아예 받지 않았다).
// 이 AbortController가 그 실제 전달 경로다 — runAbortController.signal을 opts.abortSignal로
// 넘기면 durable-wait sleep(§ orchestrator.ts)과 진행 중인 claude CLI subprocess(§
// subprocess-runner.ts)까지 실제로 중단된다. 기존 interrupted/shutdownSignal 메커니즘은
// 그대로 유지한다(waitWhileWaitingHuman의 동작을 바꾸지 않는다) — 같은 SIGINT/SIGTERM
// handler가 이제 둘 다 함께 트리거할 뿐이다.
export const runAbortController = new AbortController();

/** SIGINT/SIGTERM 둘 다 같은 shutdownSignal을 한 번만 resolve한다(idempotent — 두 신호가
 *  겹쳐 와도, 또는 같은 신호가 여러 번 와도 안전하다, § 요구사항 10). export하는 이유는
 *  run-tests.ts가 실제 process.kill(process.pid, "SIGTERM")로 이 정확한 handler가 실제
 *  runAbortController를 발동시키는지 검증하기 위함이다(require.main===module 가드가 있어
 *  이 파일을 import해도 main()이 자동 실행되지 않는다, § 파일 하단). */
export function installShutdownHandlers(): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;
  let handled = false;
  const handler = (signal: NodeJS.Signals) => {
    if (handled) return;
    handled = true;
    interrupted = true;
    console.log(`\n[run] ${signal} 수신 — 종료합니다.`);
    resolveShutdownSignal();
    runAbortController.abort();
  };
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
}

// project-control-cli.ts의 repoLogsDir()와 동일한 __dirname 기준 계산(§ 그 파일 주석 — 이
// 저장소의 기존 관례, dist/ 빌드 결과 기준 상위 logs/) — 마커 파일 경로가 정확히 일치해야
// 하므로 두 곳이 서로 다른 계산을 하지 않는다.
function repoLogsDir(): string {
  return join(__dirname, "..", "logs");
}

const DEFAULT_STOP_REQUEST_POLL_MS = 1_000;

/** AutoDev Core Maintenance — Canonical Stop Path(2026-08-31, JARVIS Task 5.3 실측 —
 *  "실행 중인 Developer/continuous run을 canonical하게 정상 중단할 수 없는 결함"). § 위
 *  runAbortController 주석 — 이 플랫폼의 process.kill()이 SIGTERM/SIGINT handler를 신뢰성
 *  있게 호출하지 않으므로(직접 실측 확인), project-control-cli.js stop이 남긴 마커 파일(§
 *  runner-supervisor.ts requestStop)을 이 프로세스가 능동적으로 polling한다 — 발견하면
 *  handler와 완전히 동일하게 runAbortController.abort()를 호출하고, 마커를 스스로 지운다
 *  (§ requestStop 주석 — 다음 무관한 writer가 stale 마커를 보고 스스로 중단하는 경쟁 상태를
 *  막기 위함, 소비한 요청은 소비한 프로세스가 치운다). 반환하는 stop()은 정상 종료 시
 *  interval을 정리한다(§ main() finally). */
export function startStopRequestPolling(adapterPath: string, logsDir: string, pollMs: number = DEFAULT_STOP_REQUEST_POLL_MS): { stop: () => void } {
  let handled = false;
  const timer = setInterval(() => {
    if (handled) return;
    if (!readStopRequestForPid(adapterPath, logsDir, process.pid)) return;
    handled = true;
    console.log(`\n[run] canonical stop 요청(project-control-cli stop) 감지 — 종료합니다.`);
    interrupted = true;
    resolveShutdownSignal();
    runAbortController.abort();
    clearStopRequest(adapterPath, logsDir);
  }, pollMs);
  timer.unref?.(); // 이 polling만으로 프로세스가 종료를 못 하게 붙잡고 있지 않는다.
  return {
    stop: () => clearInterval(timer),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** WAITING_HUMAN인 동안(Telegram 승인을 기다리는 동안) 프로세스를 종료하지 않는다 —
 *  controller의 tick이 같은 프로세스 안에서 Safe Auto Resume까지 처리하므로, 그 결과로
 *  state가 더 이상 WAITING_HUMAN이 아니게 되면(완료/다시 WAITING_HUMAN이 아닌 다른 정지)
 *  자연스럽게 대기를 끝낸다. SIGINT/SIGTERM이 오면 즉시 대기를 끝낸다. */
async function waitWhileWaitingHuman(statePath: string, pollMs = 5_000): Promise<void> {
  while (!interrupted) {
    await Promise.race([shutdownSignal, delay(pollMs)]);
    if (interrupted) return;
    let stillWaiting: boolean;
    try {
      const state = loadState(statePath);
      stillWaiting = (state.status as unknown as string) === "WAITING_HUMAN";
    } catch {
      return; // state를 읽을 수 없으면 더 기다리지 않고 안전하게 종료 절차로 넘어간다.
    }
    if (!stillWaiting) return;
  }
}

async function main(): Promise<void> {
  const adapterPathArg = resolveAdapterPathFromArgs();
  const manifest = loadProjectAdapter(adapterPathArg);
  log("AutoDev 시작", { project: manifest.projectId, AUTOMATION_DRY_RUN: process.env.AUTOMATION_DRY_RUN ?? "(unset)" });

  const continuous = isContinuousModeRequested();
  // AutoDev 신뢰성 수정(2026-08-26) — continuous 모드는 controller를 띄우거나 실제 task를
  // 시작하기 전, 어떤 부수효과도 만들지 않은 이 시점에 production runtime을 먼저 확인한다(§
  // runtime-origin.ts assertProductionRuntimeForContinuousLaunch). one-shot 모드는 검사 대상이
  // 아니다 — 기존 동작 그대로다.
  const productionPreflight = assertProductionRuntimeForContinuousLaunch(continuous);
  if (!productionPreflight.ok) {
    console.error(`[run] FATAL: ${productionPreflight.reason}`);
    process.exitCode = 1;
    return;
  }

  installShutdownHandlers();
  // § startStopRequestPolling 주석 — adapterPathArg는 이 지점에 도달했다는 사실 자체로 이미
  // loadProjectAdapter()를 통과한 유효한 문자열임이 보장된다(무효/undefined였다면 위에서
  // 이미 throw했다) — project-control-cli.js stop --project <adapterPath>가 쓰는 값과
  // 정확히 같은 문자열이어야 마커 경로가 일치한다.
  const stopRequestPolling = startStopRequestPolling(adapterPathArg as string, repoLogsDir());
  const controllerSupervisor = await ensureTelegramControllerStarted(manifest);

  // P0-3 하드닝(§ parent-liveness-watchdog.ts) — runner-supervisor.ts가 spawn한 child일
  // 때만(AUTODEV_SUPERVISOR_PID) 켜진다. supervisor가 비정상 종료되면 이 프로세스가 orphan으로
  // 무기한 계속 실행되지 않고 스스로 종료한다 — crash-safe checkpoint resume이 이미 이
  // 종류의 예기치 않은 종료를 안전하게 재개한다.
  //
  // P1-4 재하드닝(독립 감사) — 예전에는 defaultIsPidAlive(단순 PID 생존 여부)만 봤다. 부모가
  // 죽고 OS가 그 PID를 다른(무관한) 프로세스에 재사용하면, 새 supervisor가 이미 떠 있어도
  // 이 프로세스는 "옛 supervisor가 여전히 살아있다"고 오인해 orphan으로 계속 남을 수 있었다.
  // AUTODEV_SUPERVISOR_STARTED_AT_MS가 있으면 project-lock.ts의 assessOwnerLiveness()(PID +
  // 실제 OS 시작 시각 비교로 PID reuse까지 판정하는 기존 로직, 복제하지 않음)로 재검증한다 —
  // STALE(재사용 증명)일 때만 죽었다고 판정하고, ALIVE 또는 UNCERTAIN(시작 시각을 확인할 수
  // 없는 경우)은 안전한 쪽으로 기울여 "아직 살아있다"로 취급한다(불확실한 상태에서 정상
  // 작업을 스스로 중단시키지 않는다 — assessOwnerLiveness 자신의 fail-closed 기본값과 동일한
  // 원칙). 이 env가 없으면(구버전 supervisor/수동 실행) 기존 단순 PID liveness로 degrade한다.
  const supervisorParentPid = resolveSupervisorParentPidFromEnv();
  const supervisorParentStartedAtMs = resolveSupervisorParentStartedAtMsFromEnv();
  const parentIsPidAlive: (pid: number) => boolean =
    supervisorParentStartedAtMs !== undefined
      ? (pid) => assessOwnerLiveness(pid, supervisorParentStartedAtMs).verdict !== "STALE"
      : defaultIsPidAlive;
  const parentWatchdog = supervisorParentPid
    ? startParentLivenessWatchdog(supervisorParentPid, {
        isPidAlive: parentIsPidAlive,
        onParentDead: () => {
          console.error(`[run] supervisor(pid=${supervisorParentPid})가 더 이상 살아있지 않습니다(PID 재사용 포함) — orphan으로 남지 않도록 즉시 종료합니다.`);
          process.exit(1);
        },
      })
    : undefined;

  try {
    let result: AutodevRunResult;
    if (continuous) {
      const continuousResult = await runAutodevContinuous({ manifest, abortSignal: runAbortController.signal });
      const stopDetail =
        continuousResult.stop.kind === "OUTCOME_STOP"
          ? `outcome=${continuousResult.stop.outcome}${continuousResult.stop.reason ? `, reason=${continuousResult.stop.reason}` : ""}`
          : continuousResult.stop.kind === "LIVELOCK_NO_PROGRESS"
            ? `taskId=${continuousResult.stop.taskId}`
            : continuousResult.stop.kind === "MAX_ITERATIONS_REACHED"
              ? `maxIterations=${continuousResult.stop.maxIterations}`
              : `maxTechnicalRecoveryAttempts=${continuousResult.stop.maxTechnicalRecoveryAttempts}, taskId=${continuousResult.stop.taskId ?? "(unknown)"}`;
      console.log(
        `[run] continuous 종료: ${continuousResult.iterations.length}회 실행, stop=${continuousResult.stop.kind}(${stopDetail})`
      );
      result = continuousResult.finalResult;
    } else {
      result = await runAutodevOnce({ manifest, abortSignal: runAbortController.signal });
    }
    console.log(`[run] 종료: outcome=${result.outcome}${result.reason ? `, reason=${result.reason}` : ""}`);

    let waitingHuman = false;
    try {
      const state = loadState(manifest.statePath);
      waitingHuman = (state.status as unknown as string) === "WAITING_HUMAN";
    } catch (err) {
      log("[run] 최종 state 확인 실패 — WAITING_HUMAN 여부를 판단할 수 없습니다(controller를 유지하지 않고 종료합니다).", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (waitingHuman) {
      // Orphaned Genuine Human Gate Recovery(2026-09-01) — § local-human-approval.ts
      // ensureDurableApprovalForGenuineWaitingHuman 주석. 이 project 자신의 manifest/state를
      // 이미 아는 이 project-scoped 진입점에서, telegram-controller.ts의 정상 event 기반
      // 경로(§ 그 파일 tick → approval-service.ts createApprovalRequestsFromEvents)가 이미
      // 만든 valid approval이 있으면 그대로 재사용하고, 대응 event가 없어도(§ 요구사항 A/B)
      // 사람이 승인할 PENDING approval이 durable project-state만으로 항상 존재하게 한다 —
      // 상태 전이/Resume은 전혀 하지 않는다(§ 요구사항 C). controllerSupervisor의 owner 여부와
      // 무관하게 항상 실행한다 — installation-wide controller owner context에 의존하지
      // 않는다(§ 요구사항 8, multi-project isolation).
      try {
        const state = loadState(manifest.statePath);
        const nextTask = getNextTask(manifest.taskRegistry, state.completedTasks ?? []);
        if (nextTask) {
          const outcome = ensureDurableApprovalForGenuineWaitingHuman(nextTask.id, {
            approvalStore: selectDefaultApprovalStore(),
            statePath: manifest.statePath,
            manifest,
            events: selectDefaultEventStore(),
            cwd: manifest.targetProjectRoot,
          });
          if (outcome.kind === "CREATED") {
            log("[run] orphaned genuine Human Gate — durable state만으로 새 PENDING approval을 생성했습니다.", {
              projectId: manifest.projectId,
              taskId: nextTask.id,
              approvalId: outcome.approval.approvalId,
              approvalType: outcome.approval.approvalType,
            });
          }
        }
      } catch (err) {
        log("[run] orphaned genuine Human Gate 복구 확인 실패 — 기존 event 기반 approval 경로는 영향받지 않습니다.", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (waitingHuman && controllerSupervisor.isOwner()) {
      console.log("[run] WAITING_HUMAN — Telegram 승인 대기를 위해 controller를 유지한 채 프로세스를 계속 실행합니다(Ctrl+C로 종료 가능).");
      await waitWhileWaitingHuman(manifest.statePath);
    } else if (controllerSupervisor.isOwner()) {
      // 이번 run이 만든 최신 event(TASK_COMPLETED 등)가 최소 한 번은 전달 시도되도록 짧게
      // flush한 뒤 controller를 정리한다 — 기존 단발성 실행 UX를 그대로 보존한다.
      await controllerSupervisor.flushOnce();
    }
  } finally {
    parentWatchdog?.stop();
    stopRequestPolling.stop();
    await controllerSupervisor.stop();
  }

  if (interrupted) {
    console.log("[run] 사용자 중단 — 종료");
  }
}

// require.main===module 가드 — 직접 실행될 때만 main()을 돌린다.
if (require.main === module) {
  main().catch((e) => {
    console.error("[run] 처리되지 않은 오류로 종료:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
