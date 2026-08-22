import { createInMemoryEventStore } from "./event-store";
import type { EventStore, AppendResult } from "./event-store";
import { createInMemoryNotificationStore } from "./notification-store";
import { createInMemoryApprovalStore } from "./approval-store";
import { classifyEventForNotification } from "./notification";
import { processNotifications } from "./notification-service";
import { createApprovalRequestsFromEvents } from "./approval-service";
import {
  validateSelfDevTerminalReason,
  isReasonValidationError,
  deriveSelfDevTerminalRunId,
  recordSelfDevTerminalStatus,
  resolveSelfDevTerminalInput,
  isResolveSelfDevTerminalInputError,
  MAX_SELF_DEV_TERMINAL_REASON_LENGTH,
} from "./self-dev-terminal-status";
import type { SelfDevTerminalStatus } from "./self-dev-terminal-status";
import { SELF_DEV_PROJECT_ID, validateSelfDevCompletionEvidence, recordSelfDevTaskCompleted, isEvidenceError } from "./self-dev-completion";
import type { SelfDevTaskContext, TaskContextError } from "./self-dev-task-context";

// Self-Dev BLOCKED / WAITING_HUMAN Terminal Status Bridge 테스트 — Phase G Task G7.3.2.
// 실제 Claude/GPT 유료 호출, 실제 Telegram 네트워크 전송 없음(전부 in-memory/순수 함수
// 검증). self-dev-complete-tests.ts/self-dev-completion-tests.ts와 동일한 관례를 따른다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const TASK_ID = "G7.3.2-fixture";

function makeContext(overrides: Partial<SelfDevTaskContext> = {}): SelfDevTaskContext {
  return { taskId: TASK_ID, pushRequired: false, baseHeadHash: "abc1234", declaredAt: new Date().toISOString(), ...overrides };
}

// ---------------------------------------------------------------------------
// 1) validateSelfDevTerminalReason — fail-closed reason 판정
// ---------------------------------------------------------------------------
function scenarioReasonHappyPath(): void {
  const result = validateSelfDevTerminalReason("필요한 외부 설정이 없어 더 진행할 수 없습니다.");
  check("1) 유효한 reason은 error 없이 통과한다", !isReasonValidationError(result));
}

function scenarioReasonMissing(): void {
  const result = validateSelfDevTerminalReason(undefined);
  check("2) reason 없음(undefined) -> fail-closed(error)", isReasonValidationError(result));
}

function scenarioReasonEmpty(): void {
  const result = validateSelfDevTerminalReason("");
  check("3) reason 빈 문자열 -> fail-closed(error)", isReasonValidationError(result));
}

function scenarioReasonWhitespaceOnly(): void {
  const result = validateSelfDevTerminalReason("   \n  ");
  check("4) reason 공백만 -> fail-closed(error)", isReasonValidationError(result));
}

function scenarioReasonTooLong(): void {
  const result = validateSelfDevTerminalReason("a".repeat(MAX_SELF_DEV_TERMINAL_REASON_LENGTH + 1));
  check("5) reason이 길이 상한을 넘으면 -> fail-closed(error, full prompt/output 붙여넣기 방지)", isReasonValidationError(result));
}

function scenarioReasonTooManyNewlines(): void {
  const result = validateSelfDevTerminalReason("line1\nline2\nline3\nline4");
  check("6) reason에 줄바꿈이 너무 많으면 -> fail-closed(error, 여러 줄 stack trace/prompt 방지)", isReasonValidationError(result));
}

function scenarioReasonSecretLikeApiKey(): void {
  const result = validateSelfDevTerminalReason("설정 필요: api_key=\"abcdefghijklmnop1234\"");
  check("7) reason에 secret-like 패턴(api_key=) -> fail-closed(error, 사후 마스킹 아닌 사전 거부)", isReasonValidationError(result));
}

function scenarioReasonSecretLikeBearerToken(): void {
  const result = validateSelfDevTerminalReason("Bearer abcdefghij1234567890 값이 잘못됨");
  check("8) reason에 secret-like 패턴(Bearer token) -> fail-closed(error)", isReasonValidationError(result));
}

// ---------------------------------------------------------------------------
// 2) resolveSelfDevTerminalInput — context + reason 통합 fail-closed 게이트
// ---------------------------------------------------------------------------
function scenarioResolveNoContext(): void {
  const result = resolveSelfDevTerminalInput(undefined, "짧은 사유");
  check("9) self-dev task context 없음(undefined) -> event 0(fail-closed)", isResolveSelfDevTerminalInputError(result));
}

function scenarioResolveInvalidContext(): void {
  const invalid: TaskContextError = { error: "손상된 context 파일(fixture)" };
  const result = resolveSelfDevTerminalInput(invalid, "짧은 사유");
  check("10) self-dev task context가 손상됨(TaskContextError) -> event 0(fail-closed)", isResolveSelfDevTerminalInputError(result));
}

function scenarioResolveMissingReasonWithValidContext(): void {
  const result = resolveSelfDevTerminalInput(makeContext(), undefined);
  check("11) context는 유효하지만 reason이 없음 -> event 0(fail-closed)", isResolveSelfDevTerminalInputError(result));
}

function scenarioResolveHappyPath(): void {
  const result = resolveSelfDevTerminalInput(makeContext(), "짧은 사유");
  check(
    "12) context+reason 둘 다 유효 -> taskId/reason 정상 반환",
    !isResolveSelfDevTerminalInputError(result) && result.taskId === TASK_ID && result.reason === "짧은 사유"
  );
}

// ---------------------------------------------------------------------------
// 3) deriveSelfDevTerminalRunId — deterministic runId
// ---------------------------------------------------------------------------
function scenarioRunIdDeterministic(): void {
  const a = deriveSelfDevTerminalRunId(TASK_ID, "BLOCKED", "동일 사유");
  const b = deriveSelfDevTerminalRunId(TASK_ID, "BLOCKED", "동일 사유");
  check("13) 같은 taskId+terminalStatus+reason -> 항상 같은 runId", a === b);
}

function scenarioRunIdDiffersByStatus(): void {
  const a = deriveSelfDevTerminalRunId(TASK_ID, "BLOCKED", "동일 사유");
  const b = deriveSelfDevTerminalRunId(TASK_ID, "WAITING_HUMAN", "동일 사유");
  check("14) terminalStatus가 다르면 runId도 다르다", a !== b);
}

function scenarioRunIdDiffersByReason(): void {
  const a = deriveSelfDevTerminalRunId(TASK_ID, "BLOCKED", "사유 A");
  const b = deriveSelfDevTerminalRunId(TASK_ID, "BLOCKED", "사유 B");
  check("15) reason이 다르면 runId도 다르다", a !== b);
}

function scenarioRunIdDiffersByTaskId(): void {
  const a = deriveSelfDevTerminalRunId("G7.3.2-a", "BLOCKED", "동일 사유");
  const b = deriveSelfDevTerminalRunId("G7.3.2-b", "BLOCKED", "동일 사유");
  check("16) taskId가 다르면 runId도 다르다", a !== b);
}

// ---------------------------------------------------------------------------
// 4) recordSelfDevTerminalStatus — BLOCKED/WAITING_HUMAN event 기록 + 기존 어휘 재사용
// ---------------------------------------------------------------------------
function scenarioBlockedRecordsExistingRunBlockedEventType(): void {
  const events = createInMemoryEventStore();
  const result = recordSelfDevTerminalStatus(events, { taskId: TASK_ID, terminalStatus: "BLOCKED", reason: "구조적 blocker(fixture)" });
  check("17) BLOCKED -> ok:true, alreadyRecorded:false", result.ok === true && result.alreadyRecorded === false);
  check("18) BLOCKED -> 기존 RUN_BLOCKED eventType 재사용(새 event type 아님)", result.eventType === "RUN_BLOCKED");

  const { events: stored } = events.query({ taskId: TASK_ID, eventType: "RUN_BLOCKED" });
  check("19) BLOCKED -> 정확히 1건의 RUN_BLOCKED event", stored.length === 1);
  const e = stored[0];
  check("20) event.projectId는 self-dev 전용 상수", e?.projectId === SELF_DEV_PROJECT_ID);
  check("21) event.outcome === BLOCKED", e?.outcome === "BLOCKED");
  check("22) event.reason에 사유가 그대로 담김", e?.reason === "구조적 blocker(fixture)");
}

function scenarioWaitingHumanRecordsNewEventType(): void {
  const events = createInMemoryEventStore();
  const result = recordSelfDevTerminalStatus(events, {
    taskId: TASK_ID,
    terminalStatus: "WAITING_HUMAN",
    reason: "사용자 확인 필요(fixture)",
  });
  check("23) WAITING_HUMAN -> ok:true, alreadyRecorded:false", result.ok === true && result.alreadyRecorded === false);
  check("24) WAITING_HUMAN -> 신규 SELF_DEV_WAITING_HUMAN eventType", result.eventType === "SELF_DEV_WAITING_HUMAN");

  const { events: stored } = events.query({ taskId: TASK_ID, eventType: "SELF_DEV_WAITING_HUMAN" });
  check("25) WAITING_HUMAN -> 정확히 1건의 event", stored.length === 1);
  check("26) event.projectId는 self-dev 전용 상수", stored[0]?.projectId === SELF_DEV_PROJECT_ID);
}

// ---------------------------------------------------------------------------
// 5) notification.ts 연동 — 정상 알림 생성 + severity/requiresHumanAction
// ---------------------------------------------------------------------------
function scenarioBlockedNotificationGenerated(): void {
  const events = createInMemoryEventStore();
  recordSelfDevTerminalStatus(events, { taskId: TASK_ID, terminalStatus: "BLOCKED", reason: "구조적 blocker(fixture)" });
  const [event] = events.query({ taskId: TASK_ID, eventType: "RUN_BLOCKED" }).events;
  const notification = classifyEventForNotification(event);
  check("27) BLOCKED -> notification 정상 생성됨", notification !== undefined);
  check("28) BLOCKED -> notificationType=RUN_BLOCKED(CRITICAL/high-signal 재사용)", notification?.notificationType === "RUN_BLOCKED");
  check("29) BLOCKED -> severity=CRITICAL", notification?.severity === "CRITICAL");
}

function scenarioWaitingHumanNotificationGenerated(): void {
  const events = createInMemoryEventStore();
  recordSelfDevTerminalStatus(events, { taskId: TASK_ID, terminalStatus: "WAITING_HUMAN", reason: "사용자 확인 필요(fixture)" });
  const [event] = events.query({ taskId: TASK_ID, eventType: "SELF_DEV_WAITING_HUMAN" }).events;
  const notification = classifyEventForNotification(event);
  check("30) WAITING_HUMAN -> informational notification 정상 생성됨", notification !== undefined);
  check("31) WAITING_HUMAN -> notificationType=SELF_DEV_WAITING_HUMAN", notification?.notificationType === "SELF_DEV_WAITING_HUMAN");
  check("32) WAITING_HUMAN -> title 고정 템플릿(사용자 확인 필요)", notification?.title === "[AutoDev] 사용자 확인 필요");
}

// ---------------------------------------------------------------------------
// 6) approval-service.ts 연동 — ApprovalRequest 0건 (버튼 생성 금지)
// ---------------------------------------------------------------------------
function scenarioBlockedApprovalRequestZero(): void {
  const events = createInMemoryEventStore();
  const approvalStore = createInMemoryApprovalStore();
  recordSelfDevTerminalStatus(events, { taskId: TASK_ID, terminalStatus: "BLOCKED", reason: "구조적 blocker(fixture)" });
  const result = createApprovalRequestsFromEvents(events.query().events, approvalStore, { eventStore: events });
  check("33) BLOCKED -> ApprovalRequest 0건", result.created.length === 0);
  check("34) BLOCKED -> ApprovalStore에도 request 없음", approvalStore.list().length === 0);
}

function scenarioWaitingHumanApprovalRequestZero(): void {
  const events = createInMemoryEventStore();
  const approvalStore = createInMemoryApprovalStore();
  recordSelfDevTerminalStatus(events, { taskId: TASK_ID, terminalStatus: "WAITING_HUMAN", reason: "사용자 확인 필요(fixture)" });
  const result = createApprovalRequestsFromEvents(events.query().events, approvalStore, { eventStore: events });
  check("35) WAITING_HUMAN -> ApprovalRequest 0건", result.created.length === 0);
  check("36) WAITING_HUMAN -> ApprovalStore에도 request 없음", approvalStore.list().length === 0);
}

// ---------------------------------------------------------------------------
// 7) dedupe/idempotency — 동일 taskId+terminalStatus+reason 반복 실행
// ---------------------------------------------------------------------------
async function scenarioBlockedRepeatDedupe(): Promise<void> {
  const events = createInMemoryEventStore();
  const input = { taskId: TASK_ID, terminalStatus: "BLOCKED" as SelfDevTerminalStatus, reason: "동일 사유(fixture)" };
  const first = recordSelfDevTerminalStatus(events, input);
  const second = recordSelfDevTerminalStatus(events, input);
  check("37) 동일 BLOCKED 재실행 -> 두 번째 호출은 alreadyRecorded:true", first.alreadyRecorded === false && second.alreadyRecorded === true);
  check("38) 동일 BLOCKED 재실행 -> runId 동일", first.runId === second.runId);
  const { events: stored } = events.query({ taskId: TASK_ID, eventType: "RUN_BLOCKED" });
  check("39) 동일 BLOCKED를 두 번 기록해도 event는 여전히 1건뿐", stored.length === 1);

  const notificationStore = createInMemoryNotificationStore();
  const r1 = await processNotifications(events.query().events, notificationStore);
  check("40) 첫 processNotifications 호출 -> created 1건", r1.created.length === 1);
  const r2 = await processNotifications(events.query().events, notificationStore);
  check("41) 동일 BLOCKED 재실행 -> notification 중복 0(두 번째 호출은 dedupe만)", r2.created.length === 0 && r2.dedupedCount === 1);
}

async function scenarioWaitingHumanRepeatDedupe(): Promise<void> {
  const events = createInMemoryEventStore();
  const input = { taskId: TASK_ID, terminalStatus: "WAITING_HUMAN" as SelfDevTerminalStatus, reason: "동일 사유(fixture)" };
  const first = recordSelfDevTerminalStatus(events, input);
  const second = recordSelfDevTerminalStatus(events, input);
  check("42) 동일 WAITING_HUMAN 재실행 -> 두 번째 호출은 alreadyRecorded:true", first.alreadyRecorded === false && second.alreadyRecorded === true);
  const { events: stored } = events.query({ taskId: TASK_ID, eventType: "SELF_DEV_WAITING_HUMAN" });
  check("43) 동일 WAITING_HUMAN을 두 번 기록해도 event는 여전히 1건뿐", stored.length === 1);

  const notificationStore = createInMemoryNotificationStore();
  const r1 = await processNotifications(events.query().events, notificationStore);
  const r2 = await processNotifications(events.query().events, notificationStore);
  check("43b) 동일 WAITING_HUMAN 재실행 -> notification 중복 0", r1.created.length === 1 && r2.created.length === 0 && r2.dedupedCount === 1);
}

function scenarioDifferentReasonCreatesNewEvent(): void {
  const events = createInMemoryEventStore();
  recordSelfDevTerminalStatus(events, { taskId: TASK_ID, terminalStatus: "BLOCKED", reason: "사유 A(fixture)" });
  const second = recordSelfDevTerminalStatus(events, { taskId: TASK_ID, terminalStatus: "BLOCKED", reason: "사유 B(fixture)" });
  check("44) 같은 taskId+status라도 reason이 다르면 새 event가 기록된다", second.alreadyRecorded === false);
  const { events: stored } = events.query({ taskId: TASK_ID, eventType: "RUN_BLOCKED" });
  check("45) 서로 다른 사유 2건 -> event 2건", stored.length === 2);
}

// ---------------------------------------------------------------------------
// 8) 전이(transition) — BLOCKED/WAITING_HUMAN -> COMPLETED는 서로 다른 유효 상태
// ---------------------------------------------------------------------------
function requireCompletionEvidence(commitHash: string) {
  const evidence = validateSelfDevCompletionEvidence({
    taskId: TASK_ID,
    commitHash,
    testsPassed: true,
    typecheckPassed: true,
    buildPassed: true,
    pushRequired: false,
    pushPassed: false,
    source: "claude-code-self-dev-bridge",
  });
  if (isEvidenceError(evidence)) throw new Error(`fixture evidence가 유효하지 않습니다: ${evidence.error}`);
  return evidence;
}

function scenarioBlockedThenCompletedBothAllowed(): void {
  const events = createInMemoryEventStore();
  recordSelfDevTerminalStatus(events, { taskId: TASK_ID, terminalStatus: "BLOCKED", reason: "임시 blocker(fixture)" });
  const completion = recordSelfDevTaskCompleted(events, requireCompletionEvidence("aaa1111"));
  check("46) BLOCKED -> COMPLETED 전이 정상 허용(별도 event로 기록됨)", completion.ok === true && completion.alreadyRecorded === false);

  const blocked = events.query({ taskId: TASK_ID, eventType: "RUN_BLOCKED" }).events;
  const completed = events.query({ taskId: TASK_ID, eventType: "TASK_COMPLETED" }).events;
  check("47) BLOCKED event와 COMPLETED event가 모두 남아있음(서로 다른 유효 상태)", blocked.length === 1 && completed.length === 1);
  check("48) BLOCKED와 COMPLETED의 runId는 서로 다름(독립적 dedupe 공간)", blocked[0]?.runId !== completed[0]?.runId);
}

function scenarioWaitingHumanThenCompletedBothAllowed(): void {
  const events = createInMemoryEventStore();
  recordSelfDevTerminalStatus(events, { taskId: TASK_ID, terminalStatus: "WAITING_HUMAN", reason: "확인 필요(fixture)" });
  const completion = recordSelfDevTaskCompleted(events, requireCompletionEvidence("bbb2222"));
  check("49) WAITING_HUMAN -> COMPLETED 전이 정상 허용", completion.ok === true && completion.alreadyRecorded === false);

  const waiting = events.query({ taskId: TASK_ID, eventType: "SELF_DEV_WAITING_HUMAN" }).events;
  const completed = events.query({ taskId: TASK_ID, eventType: "TASK_COMPLETED" }).events;
  check("50) WAITING_HUMAN event와 COMPLETED event가 모두 남아있음", waiting.length === 1 && completed.length === 1);
}

// ---------------------------------------------------------------------------
// 9) append 실패 전파 + secret 미노출
// ---------------------------------------------------------------------------
function scenarioAppendFailurePropagates(): void {
  const failingStore: EventStore = {
    append(): AppendResult {
      return { ok: false, error: "disk full(fixture)" };
    },
    query() {
      return { events: [], integrityIssues: [] };
    },
  };
  const result = recordSelfDevTerminalStatus(failingStore, { taskId: TASK_ID, terminalStatus: "BLOCKED", reason: "사유(fixture)" });
  check("51) EventStore.append 실패 -> ok:false, error 전달됨(조용히 성공으로 위장하지 않음)", result.ok === false && result.error === "disk full(fixture)");
}

function scenarioNoTelegramCredentialInEventMetadata(): void {
  const events = createInMemoryEventStore();
  recordSelfDevTerminalStatus(events, { taskId: TASK_ID, terminalStatus: "BLOCKED", reason: "사유(fixture)" });
  const { events: stored } = events.query({ taskId: TASK_ID, eventType: "RUN_BLOCKED" });
  const serialized = JSON.stringify(stored);
  const noTokenLeak = !/BOT_TOKEN|CHAT_ID|telegram/i.test(serialized);
  check("52) 기록된 event에 Telegram Bot Token/Chat ID 관련 문자열이 없다", noTokenLeak);

  const metadata = (stored[0]?.metadata ?? {}) as Record<string, unknown>;
  const expectedKeys = ["source", "terminalStatus"].sort();
  check("53) event.metadata는 정확히 기대한 필드만 담는다(추가 secret 필드 없음)", JSON.stringify(Object.keys(metadata).sort()) === JSON.stringify(expectedKeys));
}

async function main(): Promise<void> {
  scenarioReasonHappyPath();
  scenarioReasonMissing();
  scenarioReasonEmpty();
  scenarioReasonWhitespaceOnly();
  scenarioReasonTooLong();
  scenarioReasonTooManyNewlines();
  scenarioReasonSecretLikeApiKey();
  scenarioReasonSecretLikeBearerToken();
  scenarioResolveNoContext();
  scenarioResolveInvalidContext();
  scenarioResolveMissingReasonWithValidContext();
  scenarioResolveHappyPath();
  scenarioRunIdDeterministic();
  scenarioRunIdDiffersByStatus();
  scenarioRunIdDiffersByReason();
  scenarioRunIdDiffersByTaskId();
  scenarioBlockedRecordsExistingRunBlockedEventType();
  scenarioWaitingHumanRecordsNewEventType();
  scenarioBlockedNotificationGenerated();
  scenarioWaitingHumanNotificationGenerated();
  scenarioBlockedApprovalRequestZero();
  scenarioWaitingHumanApprovalRequestZero();
  await scenarioBlockedRepeatDedupe();
  await scenarioWaitingHumanRepeatDedupe();
  scenarioDifferentReasonCreatesNewEvent();
  scenarioBlockedThenCompletedBothAllowed();
  scenarioWaitingHumanThenCompletedBothAllowed();
  scenarioAppendFailurePropagates();
  scenarioNoTelegramCredentialInEventMetadata();

  console.log("\n=== self-dev-terminal-status.ts(G7.3.2) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);

  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
