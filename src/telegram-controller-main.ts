import { ensureTelegramControllerStarted } from "./telegram-controller-supervisor";
import { loadProjectAdapter } from "./project-adapter-loader";
import { log } from "./logger";

// Local Telegram Controller — 수동 실행 entry point(`npm run telegram-controller`).
//
// Phase G Task G7.2 — 이 파일은 더 이상 telegram-controller.ts의 startTelegramController()를
// 직접 부르지 않는다. run.ts(production launcher)와 동일하게
// telegram-controller-supervisor.ts의 canonical entry point(ensureTelegramControllerStarted)
// 하나만 거친다 — entry point마다 서로 다른 시작 로직을 만들지 않는다(§ 요구사항 2). 이제
// production AutoDev 실행(run.ts)이 controller를 자동으로 시작하므로, 이 스크립트는 더 이상
// 필수 사용법이 아니다 — controller 상태를 직접 지켜보고 싶을 때/수동으로 미리 띄워두고
// 싶을 때를 위해 계속 남겨둔다. run.ts가 이미 controller를 소유하고 있다면 이 프로세스는
// singleton lock에 의해 두 번째 poller를 만들지 않고 곧바로 "이미 실행 중" 상태로 보고한다
// (§ telegram-controller-supervisor.ts ensureTelegramControllerStarted).
//
// run.ts와 동일한 관례 — 이 파일도 어떤 프로젝트를 대상으로 하는지 전혀 모른다. --project
// <path> 또는 AUTODEV_PROJECT_ADAPTER 환경변수로 명시된 project config(JSON)를
// project-adapter-loader.ts에 넘겨 ProjectManifest를 얻는다.
//
// AUTODEV_TELEGRAM_BOT_TOKEN/AUTODEV_TELEGRAM_CHAT_ID가 설정돼 있지 않으면 controller는
// 여전히 시작되지만(승인/알림 store bookkeeping은 계속 동작, health=NOT_CONFIGURED) 실제
// Telegram 네트워크 호출(getUpdates/sendMessage)은 전혀 시도하지 않는다(§
// telegram-controller.ts) — 이 스크립트를 실행하는 것 자체가 실제 Telegram smoke test를
// 의미하지 않는다.
//
// SIGINT(Ctrl+C)/SIGTERM 수신 시 진행 중인 tick을 끝까지 마친 뒤 graceful하게 멈추고
// singleton ownership을 반환한다(§ telegram-controller-supervisor.ts stop(), idempotent).

function resolveAdapterPathFromArgs(): string | undefined {
  const idx = process.argv.indexOf("--project");
  if (idx !== -1 && typeof process.argv[idx + 1] === "string" && process.argv[idx + 1].length > 0) {
    return process.argv[idx + 1];
  }
  const fromEnv = process.env.AUTODEV_PROJECT_ADAPTER;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return undefined;
}

async function main(): Promise<void> {
  const manifest = loadProjectAdapter(resolveAdapterPathFromArgs());
  const configured = Boolean(process.env.AUTODEV_TELEGRAM_BOT_TOKEN && process.env.AUTODEV_TELEGRAM_CHAT_ID);
  log("Telegram Controller 시작 요청", { project: manifest.projectId, telegramConfigured: configured });
  console.log(`[telegram-controller] project=${manifest.projectId} telegramConfigured=${configured}`);

  const supervisor = await ensureTelegramControllerStarted(manifest);
  if (!supervisor.isOwner()) {
    const status = supervisor.getStatus();
    console.log(
      `[telegram-controller] 이미 다른 프로세스가 controller를 실행 중입니다(pid=${status?.pid ?? "?"}, state=${status?.state ?? "UNKNOWN"}) — 이 프로세스는 두 번째 poller를 만들지 않고 종료합니다.`
    );
    return;
  }
  console.log("[telegram-controller] controller 시작됨 — Ctrl+C로 안전 종료할 수 있습니다.");

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[telegram-controller] ${signal} 수신 — 진행 중인 tick을 마친 뒤 종료합니다.`);
    supervisor
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error("[telegram-controller] 종료 중 오류:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[telegram-controller] 처리되지 않은 오류로 종료:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
