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

// AutoDev 신뢰성 수정(2026-08-26, "JARVIS 재개 전 확인된 신뢰성 gap #1") — continuous 모드
// (run.ts --continuous / AUTODEV_CONTINUOUS_RUN)는 여러 task에 걸쳐 실제 developer/checkpoint
// 작업을 반복한다. isProductionRuntime()이 false인 채로(예: 공식 launcher인
// start-autodev.ps1를 거치지 않고 dist/run.js를 직접 --continuous로 실행) continuous 모드가
// 시작되면, 실제 코드 변경/커밋은 그대로 진행되지만 EventStore/ApprovalStore/Telegram은 전부
// in-memory로 조용히 fallback된다(§ isProductionRuntime 상단 주석) — WAITING_HUMAN으로
// 멈춰도 그 사실이 어디에도 영구 기록되지 않고 사람에게 알림도 가지 않는 silent stall이 될 수
// 있다. run.ts는 continuous 모드를 시작하기 직전에 이 함수로 확인해 그 상태를 fail-fast로
// 막는다 — one-shot 모드(continuous=false)는 이 검사 대상이 아니다(기존 동작 100% 보존,
// 테스트/fixture/benchmark/dry-run 어디서도 이 값을 전역으로 강제하지 않는다). 이 함수는
// isProductionRuntime() 자체를 바꾸지 않는다 — 그 값을 소비만 한다.
export function assertProductionRuntimeForContinuousLaunch(continuous: boolean): { ok: true } | { ok: false; reason: string } {
  if (!continuous || isProductionRuntime()) return { ok: true };
  return {
    ok: false,
    reason:
      'continuous 모드(production continuous run)는 AUTOMATION_DRY_RUN="false"와 ' +
      'AUTODEV_PRODUCTION_RUNTIME="true"가 둘 다 명시적으로 설정된 상태에서만 시작할 수 있습니다 — ' +
      "이 상태가 아니면 실제 개발 작업은 계속 진행되지만 WAITING_HUMAN 승인 기록이 저장되지 않고 " +
      "Telegram 알림도 가지 않아 정지 상태를 사람이 알아챌 방법이 없습니다. start-autodev.ps1(공식 " +
      "launcher)로 실행하거나 두 환경변수를 직접 설정한 뒤 다시 실행하세요.",
  };
}
