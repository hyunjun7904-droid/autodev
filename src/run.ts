import { runAutodevOnce } from "./autodev";
import { loadProjectAdapter } from "./project-adapter-loader";
import { loadState } from "./state";
import { ensureTelegramControllerStarted } from "./telegram-controller-supervisor";
import { log } from "./logger";

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

let interrupted = false;
let resolveShutdownSignal: () => void = () => {};
const shutdownSignal = new Promise<void>((resolve) => {
  resolveShutdownSignal = resolve;
});
let shutdownHandlersInstalled = false;

/** SIGINT/SIGTERM 둘 다 같은 shutdownSignal을 한 번만 resolve한다(idempotent — 두 신호가
 *  겹쳐 와도, 또는 같은 신호가 여러 번 와도 안전하다, § 요구사항 10). */
function installShutdownHandlers(): void {
  if (shutdownHandlersInstalled) return;
  shutdownHandlersInstalled = true;
  let handled = false;
  const handler = (signal: NodeJS.Signals) => {
    if (handled) return;
    handled = true;
    interrupted = true;
    console.log(`\n[run] ${signal} 수신 — 종료합니다.`);
    resolveShutdownSignal();
  };
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
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
  const manifest = loadProjectAdapter(resolveAdapterPathFromArgs());
  log("AutoDev 시작", { project: manifest.projectId, AUTOMATION_DRY_RUN: process.env.AUTOMATION_DRY_RUN ?? "(unset)" });

  installShutdownHandlers();
  const controllerSupervisor = await ensureTelegramControllerStarted(manifest);

  try {
    const result = await runAutodevOnce({ manifest });
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

    if (waitingHuman && controllerSupervisor.isOwner()) {
      console.log("[run] WAITING_HUMAN — Telegram 승인 대기를 위해 controller를 유지한 채 프로세스를 계속 실행합니다(Ctrl+C로 종료 가능).");
      await waitWhileWaitingHuman(manifest.statePath);
    } else if (controllerSupervisor.isOwner()) {
      // 이번 run이 만든 최신 event(TASK_COMPLETED 등)가 최소 한 번은 전달 시도되도록 짧게
      // flush한 뒤 controller를 정리한다 — 기존 단발성 실행 UX를 그대로 보존한다.
      await controllerSupervisor.flushOnce();
    }
  } finally {
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
