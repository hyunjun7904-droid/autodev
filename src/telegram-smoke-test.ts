import { createTelegramNotificationProvider } from "./notification-provider-telegram";
import type { NotificationMessage } from "./notification";

// Telegram 실제 Bot API 호출은 이 파일에서만, 그리고 사람이 직접
// `npm run telegram-smoke-test`를 실행했을 때만 일어난다(Phase G Task G5.1) — 어떤 자동
// 테스트/회귀(`test:*`)도 이 스크립트를 호출하지 않는다(gpt-smoke-test.ts/
// real-source-catalog-smoke-test.ts와 동일하게 `test:` 접두사가 없는 별도 스크립트다).
// AUTODEV_TELEGRAM_BOT_TOKEN/AUTODEV_TELEGRAM_CHAT_ID을 사람이 직접 .env에 설정해 둔
// 경우에만 실제 메시지 1건을 보낸다 — 두 값이 없으면 NOT_CONFIGURED로 안전하게 종료한다
// (가짜 성공 처리 없음). 토큰 값은 이 파일에서도 절대 출력하지 않는다.

const PROBE_NOTIFICATION: NotificationMessage = {
  id: "smoke-test-probe",
  createdAt: new Date().toISOString(),
  runId: "smoke-test",
  taskId: "G5.1-smoke",
  notificationType: "TASK_COMPLETED",
  severity: "INFO",
  title: "[AutoDev] Telegram Provider Smoke Test",
  shortMessage: "이 메시지가 보였다면 Telegram provider 연결이 정상입니다(실제 전송 없음 검증 목적).",
  requiresHumanAction: false,
  dedupeKey: "smoke-test::G5.1-smoke::TASK_COMPLETED::-",
  sourceEventType: "TASK_COMPLETED",
  sourceEventId: "smoke-test-probe",
};

async function main(): Promise<void> {
  const provider = createTelegramNotificationProvider();

  console.log("=== Telegram provider smoke test ===");
  console.log(`configStatus: ${provider.configStatus}`);

  if (provider.configStatus === "NOT_CONFIGURED") {
    console.log("[SKIP] AUTODEV_TELEGRAM_BOT_TOKEN/AUTODEV_TELEGRAM_CHAT_ID이 설정되지 않았습니다 — 실제 전송을 시도하지 않습니다.");
    return;
  }

  const result = await provider.send(PROBE_NOTIFICATION);
  console.log(`[${result.ok ? "PASS" : "FAIL"}] 실제 Telegram sendMessage 결과: ok=${result.ok}`);
  if (!result.ok) {
    console.log(`error: ${result.error}`);
    process.exitCode = 1;
  }
}

main();
