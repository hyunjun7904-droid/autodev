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
// 1) 8개 필수 알림 종류 — event → NotificationType/severity/requiresHumanAction.
// ---------------------------------------------------------------------------
function scenarioTaskCompleted(): void {
  const n = classifyEventForNotification(ev({ eventType: "TASK_COMPLETED", runId: "r1", taskId: "T1", outcome: "SUCCESS" }));
  check("TASK_COMPLETED: 알림 생성됨", n !== undefined);
  check("TASK_COMPLETED: type", n?.notificationType === "TASK_COMPLETED");
  check("TASK_COMPLETED: severity=INFO", n?.severity === "INFO");
  check("TASK_COMPLETED: requiresHumanAction=false", n?.requiresHumanAction === false);
  check("TASK_COMPLETED: title 고정 템플릿", n?.title === "[AutoDev] Task 완료");
  check("TASK_COMPLETED: shortMessage에 taskId 포함", (n?.shortMessage ?? "").includes("T1"));
}

function scenarioRunCompleted(): void {
  const success = classifyEventForNotification(ev({ eventType: "RUN_COMPLETED", runId: "r2", taskId: "T1", outcome: "SUCCESS" }));
  check("RUN_COMPLETED(SUCCESS): 알림 생성됨", success !== undefined);
  check("RUN_COMPLETED(SUCCESS): severity=INFO", success?.severity === "INFO");
  check("RUN_COMPLETED(SUCCESS): requiresHumanAction=false", success?.requiresHumanAction === false);

  const skipped = classifyEventForNotification(ev({ eventType: "RUN_COMPLETED", runId: "r2", outcome: "SKIPPED" }));
  check("RUN_COMPLETED(SKIPPED): 알림 없음(실행할 task 없어 아무 일도 안 함)", skipped === undefined);
}

function scenarioTestFailed(): void {
  const failed = classifyEventForNotification(
    ev({ eventType: "TEST_COMPLETED", runId: "r3", taskId: "T1", outcome: "SUCCESS", testSummary: { total: 3, passed: 1, failed: 2 } })
  );
  check("TEST_COMPLETED(failed>0): TEST_FAILED 알림", failed?.notificationType === "TEST_FAILED");
  check("TEST_COMPLETED(failed>0): severity=WARNING", failed?.severity === "WARNING");
  check("TEST_COMPLETED(failed>0): shortMessage에 실패 개수 포함", (failed?.shortMessage ?? "").includes("2개"));

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
  check("SECURITY_BLOCKED: title/shortMessage는 고정 템플릿만 포함", n?.shortMessage === "Task T1에서 보안 게이트가 checkpoint를 차단했습니다.");
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
  scenarioRunCompleted();
  scenarioTestFailed();
  scenarioWaitingHuman();
  scenarioHumanApprovalRequired();
  scenarioSecurityBlocked();
  scenarioReviewCycleExhausted();
  scenarioRunBlocked();
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
