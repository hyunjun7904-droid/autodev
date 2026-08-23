import { randomUUID } from "node:crypto";
import { classifyEventForNotification, extractNotifications } from "./notification";
import type { NotificationType } from "./notification";
import type { AutoDevEvent, AutoDevEventInput } from "./observability-event";
import { classifyEventCategory } from "./observability-event";

// Notification Model & Deterministic Classification 테스트(Phase G Task G5). 실제 Claude/
// GPT 유료 호출 없음, 실제 외부 notification 전송 없음 — 이 파일은 순수 함수
// classifyEventForNotification()/extractNotifications()만 검증한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

let seq = 0;
function ev(overrides: Partial<AutoDevEventInput> & { eventType: AutoDevEventInput["eventType"]; runId: string }): AutoDevEvent {
  seq += 1;
  return {
    ...overrides,
    eventId: randomUUID(),
    timestamp: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    categories: classifyEventCategory(overrides.eventType),
    sequence: seq,
  };
}

// ---------------------------------------------------------------------------
// 1) high-signal 알림 종류(2026-08-22 incident 이후 6종) — event →
//    NotificationType/severity/requiresHumanAction. RUN_COMPLETED/TEST_FAILED는 더 이상
//    알림을 만들지 않는다(§ 아래 scenarioRunCompletedNoLongerNotifies/
//    scenarioTestCompletedNeverNotifies가 그 부재를 명시적으로 검증).
// ---------------------------------------------------------------------------
function scenarioTaskCompleted(): void {
  const n = classifyEventForNotification(ev({ eventType: "TASK_COMPLETED", runId: "r1", taskId: "T1", outcome: "SUCCESS" }));
  check("TASK_COMPLETED: 알림 생성됨", n !== undefined);
  check("TASK_COMPLETED: type", n?.notificationType === "TASK_COMPLETED");
  check("TASK_COMPLETED: severity=INFO", n?.severity === "INFO");
  check("TASK_COMPLETED: requiresHumanAction=false", n?.requiresHumanAction === false);
  check("TASK_COMPLETED: title 고정 템플릿(하위 Task, 🟡)", n?.title === "🟡 [AutoDev] 작업 단계 완료");
  check("TASK_COMPLETED: shortMessage에 taskId 포함", (n?.shortMessage ?? "").includes("T1"));
  check("TASK_COMPLETED: shortMessage에 '다음 프로젝트 시작 가능: 아니오' 포함", (n?.shortMessage ?? "").includes("다음 프로젝트 시작 가능: 아니오"));
}

// 2026-08-22 incident 이후 — RUN_COMPLETED/TEST_FAILED는 더 이상 알림을 만들지 않는다(§
// notification.ts 파일 상단 주석). RUN_COMPLETED는 TASK_COMPLETED와 중복 정보이고,
// TEST_FAILED는 REVISE 재시도마다 반복 발생하는 중간 신호라 실제 알림 폭탄의 원인이었다.
function scenarioRunCompletedNoLongerNotifies(): void {
  const success = classifyEventForNotification(ev({ eventType: "RUN_COMPLETED", runId: "r2", taskId: "T1", outcome: "SUCCESS" }));
  check("RUN_COMPLETED(SUCCESS): 더 이상 알림을 만들지 않음(TASK_COMPLETED와 중복 정보)", success === undefined);

  const skipped = classifyEventForNotification(ev({ eventType: "RUN_COMPLETED", runId: "r2", outcome: "SKIPPED" }));
  check("RUN_COMPLETED(SKIPPED): 알림 없음", skipped === undefined);
}

function scenarioTestCompletedNeverNotifies(): void {
  const failed = classifyEventForNotification(
    ev({ eventType: "TEST_COMPLETED", runId: "r3", taskId: "T1", outcome: "SUCCESS", testSummary: { total: 3, passed: 1, failed: 2 } })
  );
  check("TEST_COMPLETED(failed>0): 더 이상 알림을 만들지 않음(REVISE 반복마다 쌓이던 원인)", failed === undefined);

  const passed = classifyEventForNotification(
    ev({ eventType: "TEST_COMPLETED", runId: "r3", taskId: "T1", outcome: "SUCCESS", testSummary: { total: 3, passed: 3, failed: 0 } })
  );
  check("TEST_COMPLETED(failed=0): 알림 없음", passed === undefined);
}

function scenarioWaitingHuman(): void {
  const n = classifyEventForNotification(ev({ eventType: "REVIEW_BLOCKED", runId: "r4", taskId: "T1", reviseCycle: 1 }));
  check("REVIEW_BLOCKED: WAITING_HUMAN 알림", n?.notificationType === "WAITING_HUMAN");
  check("REVIEW_BLOCKED: severity=ACTION_REQUIRED", n?.severity === "ACTION_REQUIRED");
  check("REVIEW_BLOCKED: requiresHumanAction=true", n?.requiresHumanAction === true);
}

function scenarioHumanApprovalRequired(): void {
  const n = classifyEventForNotification(ev({ eventType: "HUMAN_APPROVAL_REQUIRED", runId: "r5", taskId: "T1" }));
  check("HUMAN_APPROVAL_REQUIRED: type 일치", n?.notificationType === "HUMAN_APPROVAL_REQUIRED");
  check("HUMAN_APPROVAL_REQUIRED: severity=ACTION_REQUIRED", n?.severity === "ACTION_REQUIRED");
  check("HUMAN_APPROVAL_REQUIRED: requiresHumanAction=true", n?.requiresHumanAction === true);
}

function scenarioSecurityBlocked(): void {
  const n = classifyEventForNotification(ev({ eventType: "SECURITY_BLOCKED", runId: "r6", taskId: "T1" }));
  check("SECURITY_BLOCKED: type 일치", n?.notificationType === "SECURITY_BLOCKED");
  check("SECURITY_BLOCKED: severity=CRITICAL", n?.severity === "CRITICAL");
  check("SECURITY_BLOCKED: requiresHumanAction=true", n?.requiresHumanAction === true);
}

function scenarioReviewCycleExhausted(): void {
  const n = classifyEventForNotification(ev({ eventType: "REVIEW_CYCLE_EXHAUSTED", runId: "r7", taskId: "T1", reviseCycle: 5 }));
  check("REVIEW_CYCLE_EXHAUSTED: type 일치", n?.notificationType === "REVIEW_CYCLE_EXHAUSTED");
  check("REVIEW_CYCLE_EXHAUSTED: severity=ACTION_REQUIRED", n?.severity === "ACTION_REQUIRED");
  check("REVIEW_CYCLE_EXHAUSTED: requiresHumanAction=true", n?.requiresHumanAction === true);
}

function scenarioRunBlocked(): void {
  const n = classifyEventForNotification(ev({ eventType: "RUN_BLOCKED", runId: "r8", taskId: "T1" }));
  check("RUN_BLOCKED: type 일치", n?.notificationType === "RUN_BLOCKED");
  check("RUN_BLOCKED: severity=CRITICAL", n?.severity === "CRITICAL");
  check("RUN_BLOCKED: requiresHumanAction=true", n?.requiresHumanAction === true);
}

// Phase G Task G7.3.2 — self-dev informational-only WAITING_HUMAN. 기존 "WAITING_HUMAN"
// (REVIEW_BLOCKED 전용)과 notificationType이 다르다는 사실 자체가 approval-service.ts의
// 별도 제외 규칙이 필요한 이유다(§ self-dev-terminal-status.ts 상단 주석).
function scenarioSelfDevWaitingHuman(): void {
  const n = classifyEventForNotification(ev({ eventType: "SELF_DEV_WAITING_HUMAN", runId: "r8b", taskId: "G7.3.2" }));
  check("SELF_DEV_WAITING_HUMAN: type 일치", n?.notificationType === "SELF_DEV_WAITING_HUMAN");
  check("SELF_DEV_WAITING_HUMAN: 기존 WAITING_HUMAN(REVIEW_BLOCKED)과 다른 type", n?.notificationType !== "WAITING_HUMAN");
  check("SELF_DEV_WAITING_HUMAN: severity=ACTION_REQUIRED", n?.severity === "ACTION_REQUIRED");
  check("SELF_DEV_WAITING_HUMAN: requiresHumanAction=true", n?.requiresHumanAction === true);
  check("SELF_DEV_WAITING_HUMAN: title 고정 템플릿", n?.title === "⛔ [AutoDev] 사용자 확인 필요");
}

// ---------------------------------------------------------------------------
// 1b) Phase G Task G7.5 — 하위 Task 완료 vs 상위 Task/Phase 진짜 최종 완료 구분.
// ---------------------------------------------------------------------------

// 9A — 하위 Task/fixture/internal run 완료 → 🟡, 다음 프로젝트 시작 가능: 아니오.
function scenarioSubtaskCompletionIsNotFinal(): void {
  const n = classifyEventForNotification(
    ev({ eventType: "TASK_COMPLETED", runId: "r20", taskId: "T1", outcome: "SUCCESS", metadata: { completionScope: "SUBTASK" } })
  );
  check("9A) SUBTASK completionScope: 🟡 TASK_COMPLETED로 분류", n?.notificationType === "TASK_COMPLETED");
  check("9A) SUBTASK completionScope: title에 🟡 포함", (n?.title ?? "").startsWith("🟡"));
  check("9A) SUBTASK completionScope: '다음 프로젝트 시작 가능: 아니오'", (n?.shortMessage ?? "").includes("다음 프로젝트 시작 가능: 아니오"));

  // metadata 자체가 없는(production의 예전 event 형태와 동일한) 경우도 안전하게 SUBTASK
  // 기본값으로 처리된다(§ 하위호환 — completionScope가 없으면 항상 🟡).
  const noMeta = classifyEventForNotification(ev({ eventType: "TASK_COMPLETED", runId: "r20b", taskId: "T1", outcome: "SUCCESS" }));
  check("9A) completionScope 없음(구버전 event) -> 여전히 🟡 TASK_COMPLETED", noMeta?.notificationType === "TASK_COMPLETED");
}

// 9B — 상위 작업 최종 완료(production: PROJECT_COMPLETED event / self-dev: TASK_COMPLETED
// metadata.completionScope="FINAL") → ✅, 다음 프로젝트 시작 가능: 예.
function scenarioFinalCompletion(): void {
  const projectCompleted = classifyEventForNotification(
    ev({ eventType: "PROJECT_COMPLETED", runId: "r21", taskId: "P.10", outcome: "SUCCESS" })
  );
  check("9B) PROJECT_COMPLETED -> FINAL_COMPLETED로 분류", projectCompleted?.notificationType === "FINAL_COMPLETED");
  check("9B) PROJECT_COMPLETED -> title에 ✅ 포함", (projectCompleted?.title ?? "").startsWith("✅"));
  check(
    "9B) PROJECT_COMPLETED -> '다음 프로젝트 시작 가능: 예'",
    (projectCompleted?.shortMessage ?? "").includes("다음 프로젝트 시작 가능: 예")
  );
  check("9B) PROJECT_COMPLETED -> requiresHumanAction=false(버튼 없음)", projectCompleted?.requiresHumanAction === false);

  const selfDevFinal = classifyEventForNotification(
    ev({ eventType: "TASK_COMPLETED", runId: "r22", taskId: "G7.5", outcome: "SUCCESS", metadata: { completionScope: "FINAL" } })
  );
  check("9B) self-dev TASK_COMPLETED(completionScope=FINAL) -> FINAL_COMPLETED로 승격", selfDevFinal?.notificationType === "FINAL_COMPLETED");
  check(
    "9B) self-dev FINAL -> '다음 프로젝트 시작 가능: 예'",
    (selfDevFinal?.shortMessage ?? "").includes("다음 프로젝트 시작 가능: 예")
  );
}

// production에서 마지막 task의 TASK_COMPLETED(PENDING_FINAL/PENDING_DEPLOYMENT_GATE)는
// 그 자체로 알림을 만들지 않는다 — 뒤이은 PROJECT_COMPLETED/DEPLOYMENT_WAITING_HUMAN이
// state 저장 이후에만 최종 알림을 만든다(§ 요구사항 5 순서, autodev.ts). 이 event 하나에
// 대해 🟡와 ✅/⛔ 두 알림이 동시에 나가지 않는다는 것을 확인한다.
function scenarioPendingFinalSuppressed(): void {
  const pendingFinal = classifyEventForNotification(
    ev({ eventType: "TASK_COMPLETED", runId: "r23", taskId: "P.10", outcome: "SUCCESS", metadata: { completionScope: "PENDING_FINAL" } })
  );
  check("PENDING_FINAL: 이 event 자체는 알림을 만들지 않음(중복 방지)", pendingFinal === undefined);

  const pendingGate = classifyEventForNotification(
    ev({ eventType: "TASK_COMPLETED", runId: "r24", taskId: "P.9", outcome: "SUCCESS", metadata: { completionScope: "PENDING_DEPLOYMENT_GATE" } })
  );
  check("PENDING_DEPLOYMENT_GATE: 이 event 자체는 알림을 만들지 않음(중복 방지)", pendingGate === undefined);
}

// 9C — WAITING_HUMAN/BLOCKED류(사람 확인 필요) → ⛔, 다음 프로젝트 시작 가능: 아니오.
// production의 DEPLOYMENT_WAITING_HUMAN도 같은 ⛔ 버킷에 속한다.
function scenarioDeploymentWaitingHuman(): void {
  const n = classifyEventForNotification(
    ev({ eventType: "DEPLOYMENT_WAITING_HUMAN", runId: "r25", taskId: "P.9", outcome: "SUCCESS", humanInterventionRequired: true })
  );
  check("9C) DEPLOYMENT_WAITING_HUMAN: type 일치", n?.notificationType === "DEPLOYMENT_WAITING_HUMAN");
  check("9C) DEPLOYMENT_WAITING_HUMAN: title에 ⛔ 포함", (n?.title ?? "").startsWith("⛔"));
  check("9C) DEPLOYMENT_WAITING_HUMAN: requiresHumanAction=true", n?.requiresHumanAction === true);
  check(
    "9C) DEPLOYMENT_WAITING_HUMAN: '다음 프로젝트 시작 가능: 아니오'",
    (n?.shortMessage ?? "").includes("다음 프로젝트 시작 가능: 아니오")
  );
}

function scenarioAllConfirmRequiredTypesShareIcon(): void {
  const confirmTypes: [import("./observability-event").AutoDevEventType, boolean][] = [
    ["REVIEW_BLOCKED", false],
    ["HUMAN_APPROVAL_REQUIRED", false],
    ["SECURITY_BLOCKED", false],
    ["REVIEW_CYCLE_EXHAUSTED", false],
    ["RUN_BLOCKED", false],
    ["SELF_DEV_WAITING_HUMAN", false],
    ["DEPLOYMENT_WAITING_HUMAN", false],
  ];
  const allShareIcon = confirmTypes.every(([eventType]) => {
    const n = classifyEventForNotification(ev({ eventType, runId: `r-icon-${eventType}`, taskId: "T1" }));
    return (n?.title ?? "").startsWith("⛔ [AutoDev] 사용자 확인 필요") && (n?.shortMessage ?? "").includes("다음 프로젝트 시작 가능: 아니오");
  });
  check("9C) 사람 확인 필요 6+1종 모두 ⛔ [AutoDev] 사용자 확인 필요 + '다음 프로젝트 시작 가능: 아니오'", allShareIcon);
}

// 9D — 최종 실패/미완료 → ❌, 다음 프로젝트 시작 가능: 아니오.
function scenarioSelfDevTaskFailed(): void {
  const n = classifyEventForNotification(
    ev({ eventType: "SELF_DEV_TASK_FAILED", runId: "r26", taskId: "G7.5", outcome: "FAILED", reason: "typecheck 실패(exit 1)." })
  );
  check("9D) SELF_DEV_TASK_FAILED: type 일치", n?.notificationType === "SELF_DEV_TASK_FAILED");
  check("9D) SELF_DEV_TASK_FAILED: title에 ❌ 포함", (n?.title ?? "").startsWith("❌"));
  check("9D) SELF_DEV_TASK_FAILED: requiresHumanAction=false(버튼 없음)", n?.requiresHumanAction === false);
  check("9D) SELF_DEV_TASK_FAILED: 사유에 reason 반영됨", (n?.shortMessage ?? "").includes("typecheck 실패(exit 1)."));
  check(
    "9D) SELF_DEV_TASK_FAILED: '다음 프로젝트 시작 가능: 아니오'",
    (n?.shortMessage ?? "").includes("다음 프로젝트 시작 가능: 아니오")
  );
}

// ---------------------------------------------------------------------------
// 2) 알림 대상이 아닌 event — 순수 진행 상황(*_STARTED, AGENT_*, REVIEW_STARTED/APPROVED/
//    REVISE, CHECKPOINT_CREATED)은 알림을 만들지 않는다.
// ---------------------------------------------------------------------------
function scenarioNonNotifiableEvents(): void {
  const nonNotifiableTypes: AutoDevEventInput["eventType"][] = [
    "RUN_STARTED",
    "TASK_STARTED",
    "AGENT_SELECTED",
    "AGENT_STARTED",
    "AGENT_COMPLETED",
    "AGENT_FAILED",
    "DEVELOPER_RETRY_STARTED",
    "TEST_STARTED",
    "REVIEW_STARTED",
    "REVIEW_APPROVED",
    "REVIEW_REVISE",
    "CHECKPOINT_CREATED",
  ];
  const allUndefined = nonNotifiableTypes.every(
    (eventType) => classifyEventForNotification(ev({ eventType, runId: "r9", taskId: "T1" })) === undefined
  );
  check("순수 진행 event는 알림을 만들지 않음(12종 전부)", allUndefined);
}

// ---------------------------------------------------------------------------
// 3) dedupeKey — 같은 runId+taskId+type+cycle은 같은 key, 하나라도 다르면 다른 key.
// ---------------------------------------------------------------------------
function scenarioDedupeKeyStability(): void {
  const a = classifyEventForNotification(ev({ eventType: "TASK_COMPLETED", runId: "run-x", taskId: "T1" }));
  const b = classifyEventForNotification(ev({ eventType: "TASK_COMPLETED", runId: "run-x", taskId: "T1" }));
  check("dedupeKey: 같은 runId+taskId+type → 동일 key", a?.dedupeKey === b?.dedupeKey);

  const diffRun = classifyEventForNotification(ev({ eventType: "TASK_COMPLETED", runId: "run-y", taskId: "T1" }));
  check("dedupeKey: runId만 다르면 다른 key", a?.dedupeKey !== diffRun?.dedupeKey);

  const diffTask = classifyEventForNotification(ev({ eventType: "TASK_COMPLETED", runId: "run-x", taskId: "T2" }));
  check("dedupeKey: taskId만 다르면 다른 key", a?.dedupeKey !== diffTask?.dedupeKey);

  const cycle1 = classifyEventForNotification(ev({ eventType: "REVIEW_CYCLE_EXHAUSTED", runId: "run-z", taskId: "T1", reviseCycle: 1 }));
  const cycle2 = classifyEventForNotification(ev({ eventType: "REVIEW_CYCLE_EXHAUSTED", runId: "run-z", taskId: "T1", reviseCycle: 2 }));
  check("dedupeKey: reviseCycle만 다르면 다른 key(의미 있는 상태 변화는 별도 사건)", cycle1?.dedupeKey !== cycle2?.dedupeKey);
}

// ---------------------------------------------------------------------------
// 4) privacy — event.reason/error.message 같은 자유 텍스트가 절대 옮겨지지 않는다.
// ---------------------------------------------------------------------------
function scenarioNoSensitiveDataLeak(): void {
  const secretMarker = "sk-SUPER_SECRET_MARKER_ANTHROPIC_KEY_1234567890";
  const event = ev({
    eventType: "SECURITY_BLOCKED",
    runId: "r10",
    taskId: "T1",
    reason: `checkpoint blocked by secret: ${secretMarker}`,
    error: { message: `raw claude output leaked: ${secretMarker}` },
    metadata: { rawPrompt: secretMarker },
  });
  const n = classifyEventForNotification(event);
  const serialized = JSON.stringify(n);
  check("SECURITY_BLOCKED: reason/error/metadata 원문이 알림에 노출되지 않음", !serialized.includes(secretMarker));
  check(
    "SECURITY_BLOCKED: title/shortMessage는 고정 템플릿만 포함(event.reason 미노출)",
    n?.shortMessage === "작업: T1\n사유: 보안 게이트가 checkpoint를 차단했습니다.\n다음 프로젝트 시작 가능: 아니오"
  );
}

// ---------------------------------------------------------------------------
// 5) extractNotifications — event 순서 유지, 알림 대상만 필터링.
// ---------------------------------------------------------------------------
function scenarioExtractNotificationsOrderAndFilter(): void {
  const events = [
    ev({ eventType: "RUN_STARTED", runId: "r11" }),
    ev({ eventType: "TASK_STARTED", runId: "r11", taskId: "T1" }),
    ev({ eventType: "SECURITY_BLOCKED", runId: "r11", taskId: "T1" }),
    ev({ eventType: "RUN_BLOCKED", runId: "r11", taskId: "T1" }),
  ];
  const notifications = extractNotifications(events);
  check("extractNotifications: 알림 대상 2건만 추출", notifications.length === 2);
  const order: NotificationType[] = notifications.map((n) => n.notificationType);
  check("extractNotifications: event 순서 그대로(SECURITY_BLOCKED → RUN_BLOCKED)", order.join(",") === "SECURITY_BLOCKED,RUN_BLOCKED");
}

// ---------------------------------------------------------------------------
// 6) taskId 없는 event — runId로 fallback, 크래시 없음.
// ---------------------------------------------------------------------------
function scenarioNoTaskIdFallback(): void {
  const n = classifyEventForNotification(ev({ eventType: "RUN_BLOCKED", runId: "run-only" }));
  check("taskId 없음: shortMessage가 runId로 fallback", (n?.shortMessage ?? "").includes("run-only"));
  check("taskId 없음: dedupeKey에 '-' placeholder", n?.dedupeKey.includes("::-::") ?? false);
}

async function main(): Promise<void> {
  scenarioTaskCompleted();
  scenarioSubtaskCompletionIsNotFinal();
  scenarioFinalCompletion();
  scenarioPendingFinalSuppressed();
  scenarioDeploymentWaitingHuman();
  scenarioAllConfirmRequiredTypesShareIcon();
  scenarioSelfDevTaskFailed();
  scenarioRunCompletedNoLongerNotifies();
  scenarioTestCompletedNeverNotifies();
  scenarioWaitingHuman();
  scenarioHumanApprovalRequired();
  scenarioSecurityBlocked();
  scenarioReviewCycleExhausted();
  scenarioRunBlocked();
  scenarioSelfDevWaitingHuman();
  scenarioNonNotifiableEvents();
  scenarioDedupeKeyStability();
  scenarioNoSensitiveDataLeak();
  scenarioExtractNotificationsOrderAndFilter();
  scenarioNoTaskIdFallback();

  console.log("\n=== notification(G5) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
