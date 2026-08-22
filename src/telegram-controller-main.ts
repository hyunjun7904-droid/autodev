import { startTelegramController } from "./telegram-controller";
import { loadProjectAdapter } from "./project-adapter-loader";
import { log } from "./logger";

// Local Telegram Controller — 실행 entry point(Phase G Task G6, `npm run telegram-controller`).
//
// run.ts와 동일한 관례 — 이 파일도 어떤 프로젝트를 대상으로 하는지 전혀 모른다. --project
// <path> 또는 AUTODEV_PROJECT_ADAPTER 환경변수로 명시된 project config(JSON)를
// project-adapter-loader.ts에 넘겨 ProjectManifest를 얻는다.
//
// AUTODEV_TELEGRAM_BOT_TOKEN/AUTODEV_TELEGRAM_CHAT_ID가 설정돼 있지 않으면 controller는
// 여전히 시작되지만(승인/알림 store bookkeeping은 계속 동작) 실제 Telegram 네트워크
// 호출(getUpdates/sendMessage)은 전혀 시도하지 않는다(§ telegram-controller.ts) — 이
// 스크립트를 실행하는 것 자체가 실제 Telegram smoke test를 의미하지 않는다. 실제 Telegram
// callback을 이용한 승인 smoke test는 이 스크립트를 실행한 사람이 직접 Telegram에서
// 버튼을 눌러야만 발생한다.
//
// SIGINT(Ctrl+C) 수신 시 진행 중인 tick을 끝까지 마친 뒤 graceful하게 멈춘다(§
// telegram-controller.ts stop()).

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
  log("Telegram Controller 시작", { project: manifest.projectId, telegramConfigured: configured });
  console.log(`[telegram-controller] project=${manifest.projectId} telegramConfigured=${configured}`);

  const handle = await startTelegramController({ manifest });

  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) return;
    stopping = true;
    console.log("\n[telegram-controller] SIGINT 수신 — 진행 중인 tick을 마친 뒤 종료합니다.");
    handle
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error("[telegram-controller] 종료 중 오류:", err instanceof Error ? err.message : String(err));
        process.exit(1);
      });
  });
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[telegram-controller] 처리되지 않은 오류로 종료:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
