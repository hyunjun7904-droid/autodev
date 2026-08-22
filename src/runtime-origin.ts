// Production Runtime Origin Gate — incident response(2026-08-22, "알림 폭탄").
//
// 배경: AUTOMATION_DRY_RUN="false" 하나만으로 EventStore/NotificationStore/ApprovalStore/
// TelegramOffsetStore가 실제 파일 기반으로 전환되고, telegram-controller.ts가 실제 Telegram
// Bot Token/Chat ID를 골라 쓰는 구조였다. 이 값은 원래 "사람이 명시적으로 production을
// 의도했다"는 신호로 쓰였지만, 실제로는 (1) self-dev-complete.ts가 이 값을 자기 own
// process에서 설정한 뒤 전체 회귀를 자식 프로세스로 spawn하면서 그 값을 그대로 물려주고,
// (2) 이 Windows 환경에는 AUTODEV_TELEGRAM_BOT_TOKEN/CHAT_ID가 이미 영구 환경변수로 설정돼
// 있어, 두 조건이 우연히 겹치는 순간 test/fixture event가 실제 production 파일에 기록되고
// 실제 Telegram으로 배달되는 사고가 실제로 발생했다(F1/T1.1/P1.2/R1 등 fixture taskId가
// 실제 채널로 전달됨).
//
// 이 파일은 그 판정을 하나의 함수로 좁힌다 — "실제 production/self-dev 배달 경로를 열어도
// 되는가"는 AUTOMATION_DRY_RUN="false" *그리고* AUTODEV_PRODUCTION_RUNTIME="true" 둘 다
// 명시적으로 참일 때만 true다. 후자는 오직 사람이 의도적으로 실행하는 소수의 production
// entry point(run.ts를 띄우는 start-autodev.ps1, telegram-controller-main.ts,
// self-dev-complete.ts의 재검증 통과 이후, notify-task-completed.ts)만 설정한다 — 어떤
// test/fixture 코드도 이 값을 설정하지 않는다(설정하면 그 자체가 이 안전장치를 스스로
// 우회하는 것이므로 금지). 두 신호 중 하나라도 없으면 항상 안전한 쪽(in-memory store,
// Telegram credential 미채택)으로 fail-closed된다 — Windows 환경변수에 실제 Bot Token/
// Chat ID가 영구적으로 남아있어도 이 함수가 false를 반환하는 한 그 값은 절대 읽히지 않는다.
export function isProductionRuntime(): boolean {
  return process.env.AUTOMATION_DRY_RUN === "false" && process.env.AUTODEV_PRODUCTION_RUNTIME === "true";
}
