import { randomUUID } from "node:crypto";
import {
  classifyApprovalType,
  isRemotelyApprovable,
  buildApprovalRequest,
  isApprovalExpired,
  buildApprovalCallbackData,
  parseApprovalCallbackData,
  DEFAULT_APPROVAL_EXPIRY_MS,
} from "./approval";
import type { ApprovalType, ApprovalAction } from "./approval";
import type { AutoDevEvent } from "./observability-event";

// Approval Request Model & Remote Approval Policy 테스트 — Phase G Task G6.
// LLM 호출/네트워크 호출이 전혀 없는 순수 함수만 다룬다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function ev(overrides: Partial<Pick<AutoDevEvent, "eventType" | "reason" | "runId" | "taskId" | "projectId" | "eventId">>): Pick<
  AutoDevEvent,
  "eventType" | "reason" | "runId" | "taskId" | "projectId" | "eventId"
> {
  return {
    eventType: "HUMAN_APPROVAL_REQUIRED",
    runId: "r1",
    taskId: "T1",
    projectId: "p1",
    eventId: randomUUID(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyApprovalType
// ---------------------------------------------------------------------------
function scenarioClassifySecurityBlocked(): void {
  check("SECURITY_BLOCKED eventType -> SECURITY_BLOCKED", classifyApprovalType(ev({ eventType: "SECURITY_BLOCKED" })) === "SECURITY_BLOCKED");
}
function scenarioClassifyReviewCycleExhausted(): void {
  check(
    "REVIEW_CYCLE_EXHAUSTED eventType -> REVIEW_CYCLE_EXHAUSTED",
    classifyApprovalType(ev({ eventType: "REVIEW_CYCLE_EXHAUSTED" })) === "REVIEW_CYCLE_EXHAUSTED"
  );
}
function scenarioClassifyReviewBlocked(): void {
  check("REVIEW_BLOCKED eventType -> REVIEW_BLOCKED", classifyApprovalType(ev({ eventType: "REVIEW_BLOCKED" })) === "REVIEW_BLOCKED");
}
function scenarioClassifyHighRiskPregate(): void {
  const type = classifyApprovalType(ev({ reason: "고위험 작업 감지(예: 결제 API 변경)" }));
  check("HUMAN_APPROVAL_REQUIRED + 고위험 사전 게이트 reason -> HIGH_RISK_ACTION_PREGATE", type === "HIGH_RISK_ACTION_PREGATE");
}
function scenarioClassifyAuditStoreUnavailable(): void {
  const type = classifyApprovalType(ev({ reason: "AUDIT_STORE_UNAVAILABLE_BEFORE_CHECKPOINT: disk full" }));
  check("HUMAN_APPROVAL_REQUIRED + AUDIT_STORE_UNAVAILABLE prefix -> AUDIT_STORE_UNAVAILABLE", type === "AUDIT_STORE_UNAVAILABLE");
}
function scenarioClassifyCheckpointScopeViolation(): void {
  const type = classifyApprovalType(ev({ reason: "예상치 못한 범위 밖 파일 변경이 있어 commit을 중단했습니다." }));
  check("HUMAN_APPROVAL_REQUIRED + 정확한 scope violation reason -> CHECKPOINT_SCOPE_VIOLATION", type === "CHECKPOINT_SCOPE_VIOLATION");
}
function scenarioClassifyOrchestratorGeneric(): void {
  const type = classifyApprovalType(ev({ reason: "orchestrator status=WAITING_HUMAN(claude_limit_wait_exceeded)" }));
  check("HUMAN_APPROVAL_REQUIRED + orchestrator status= prefix -> ORCHESTRATOR_NOT_APPROVED_GENERIC", type === "ORCHESTRATOR_NOT_APPROVED_GENERIC");
}
function scenarioClassifyUnknownReason(): void {
  const type = classifyApprovalType(ev({ reason: "전혀 다른 새로운 사유 문구" }));
  check("HUMAN_APPROVAL_REQUIRED + 매칭 안 되는 reason -> UNKNOWN(추측 안 함)", type === "UNKNOWN");
}
// AutoDev / JARVIS Unattended Continuous Development Reliability Hardening Phase 5 — 이
// 사유(REQUIRED_TEST_CONFIGURATION_ERROR)는 이 함수에 특별한 case가 없어 UNKNOWN으로
// 분류된다(§ scenarioClassifyUnknownReason과 동일한 fail-closed 원칙). 이 값 자체는 여기서
// 바뀌지 않는다 — 대신 autodev.ts는 Phase 5부터 이 사유로는 애초에 HUMAN_APPROVAL_REQUIRED
// event를 만들지 않으므로(§ required-test-preflight.ts 위임 경로), classifyApprovalType()이
// UNKNOWN을 반환하는 것 자체가 "사람 대기로 이어진다"는 뜻이 되지 않는다는 것을 문서화한다.
function scenarioClassifyRequiredTestConfigurationErrorIsUnknownButHarmless(): void {
  const type = classifyApprovalType(
    ev({ reason: "REQUIRED_TEST_CONFIGURATION_ERROR: task=2.1 requiredTest=device-trust-registration-tests missingScript=test:device-trust-registration" })
  );
  check(
    "REQUIRED_TEST_CONFIGURATION_ERROR reason -> UNKNOWN(하지만 Phase 5부터 이 사유로는 이 event 자체가 만들어지지 않음 — autodev.ts 참고)",
    type === "UNKNOWN"
  );
  check("UNKNOWN은 remotelyApprovable=false(Telegram 자동 재개 대상 아님 — 승인 보안 계약 유지)", isRemotelyApprovable(type) === false);
}

function scenarioClassifyNoReason(): void {
  const type = classifyApprovalType(ev({ reason: undefined }));
  check("HUMAN_APPROVAL_REQUIRED + reason 없음 -> UNKNOWN", type === "UNKNOWN");
}
function scenarioClassifyOtherEventType(): void {
  const type = classifyApprovalType(ev({ eventType: "TASK_COMPLETED" }));
  check("무관한 eventType(TASK_COMPLETED) -> UNKNOWN", type === "UNKNOWN");
}
function scenarioClassifyDeterministic(): void {
  const input = ev({ reason: "orchestrator status=WAITING_HUMAN(x)" });
  const a = classifyApprovalType(input);
  const b = classifyApprovalType(input);
  check("동일 입력 -> 항상 동일 출력(순수 함수)", a === b);
}

// ---------------------------------------------------------------------------
// isRemotelyApprovable — fail-closed allow-list. ORCHESTRATOR_NOT_APPROVED_GENERIC만 true.
// ---------------------------------------------------------------------------
function scenarioRemotelyApprovableAllowList(): void {
  const allTypes: ApprovalType[] = [
    "HIGH_RISK_ACTION_PREGATE",
    "SECURITY_BLOCKED",
    "REVIEW_CYCLE_EXHAUSTED",
    "REVIEW_BLOCKED",
    "CHECKPOINT_SCOPE_VIOLATION",
    "AUDIT_STORE_UNAVAILABLE",
    "ORCHESTRATOR_NOT_APPROVED_GENERIC",
    "UNKNOWN",
  ];
  const allowed = allTypes.filter(isRemotelyApprovable);
  check("remotelyApprovable=true는 ORCHESTRATOR_NOT_APPROVED_GENERIC 단 하나뿐", allowed.length === 1 && allowed[0] === "ORCHESTRATOR_NOT_APPROVED_GENERIC");
  check("SECURITY_BLOCKED는 remotelyApprovable=false", isRemotelyApprovable("SECURITY_BLOCKED") === false);
  check("REVIEW_CYCLE_EXHAUSTED는 remotelyApprovable=false", isRemotelyApprovable("REVIEW_CYCLE_EXHAUSTED") === false);
  check("REVIEW_BLOCKED는 remotelyApprovable=false", isRemotelyApprovable("REVIEW_BLOCKED") === false);
  check("CHECKPOINT_SCOPE_VIOLATION은 remotelyApprovable=false", isRemotelyApprovable("CHECKPOINT_SCOPE_VIOLATION") === false);
  check("HIGH_RISK_ACTION_PREGATE는 remotelyApprovable=false", isRemotelyApprovable("HIGH_RISK_ACTION_PREGATE") === false);
  check("AUDIT_STORE_UNAVAILABLE는 remotelyApprovable=false", isRemotelyApprovable("AUDIT_STORE_UNAVAILABLE") === false);
  check("UNKNOWN(fail-closed 기본값)은 remotelyApprovable=false", isRemotelyApprovable("UNKNOWN") === false);
}

// ---------------------------------------------------------------------------
// buildApprovalRequest
// ---------------------------------------------------------------------------
function scenarioBuildApprovalRequestFields(): void {
  const fixedNow = new Date("2026-01-01T00:00:00.000Z");
  const event = ev({ eventType: "SECURITY_BLOCKED", runId: "r9", taskId: "T9", projectId: "p9" });
  const req = buildApprovalRequest(event, "dedupe-key-1", { now: () => fixedNow });
  check("approvalId는 randomUUID 형식", /^[0-9a-f-]{36}$/i.test(req.approvalId));
  check("createdAt = now()", req.createdAt === fixedNow.toISOString());
  check("expiresAt = now() + DEFAULT_APPROVAL_EXPIRY_MS", req.expiresAt === new Date(fixedNow.getTime() + DEFAULT_APPROVAL_EXPIRY_MS).toISOString());
  check("status 초기값 PENDING", req.status === "PENDING");
  check("approvalType은 classifyApprovalType 재사용(SECURITY_BLOCKED)", req.approvalType === "SECURITY_BLOCKED");
  check("SECURITY_BLOCKED -> remotelyApprovable=false", req.remotelyApprovable === false);
  check("requiresSafetyRecheck 항상 true", req.requiresSafetyRecheck === true);
  check("dedupeKey는 인자로 받은 값 그대로", req.dedupeKey === "dedupe-key-1");
  check("runId/taskId/projectId 전달", req.runId === "r9" && req.taskId === "T9" && req.projectId === "p9");
  check("sourceEventId 전달", req.sourceEventId === event.eventId);
  check("expectedGitHead 미지정 시 undefined", req.expectedGitHead === undefined);
}
function scenarioBuildApprovalRequestCustomExpiry(): void {
  const fixedNow = new Date("2026-01-01T00:00:00.000Z");
  const req = buildApprovalRequest(ev({}), "k", { now: () => fixedNow, expiryMs: 60_000 });
  check("expiryMs override 반영", req.expiresAt === new Date(fixedNow.getTime() + 60_000).toISOString());
}
function scenarioBuildApprovalRequestGitExpectation(): void {
  const req = buildApprovalRequest(ev({}), "k", { expectedGitHead: "abc123", expectedBranch: "main" });
  check("expectedGitHead 전달됨", req.expectedGitHead === "abc123");
  check("expectedBranch 전달됨", req.expectedBranch === "main");
}
function scenarioBuildApprovalRequestOrchestratorGeneric(): void {
  const req = buildApprovalRequest(ev({ reason: "orchestrator status=WAITING_HUMAN(x)" }), "k");
  check("ORCHESTRATOR_NOT_APPROVED_GENERIC -> remotelyApprovable=true", req.remotelyApprovable === true);
}
function scenarioBuildApprovalRequestUniqueIds(): void {
  const a = buildApprovalRequest(ev({}), "k1");
  const b = buildApprovalRequest(ev({}), "k2");
  check("서로 다른 호출은 서로 다른 approvalId", a.approvalId !== b.approvalId);
}

// ---------------------------------------------------------------------------
// isApprovalExpired
// ---------------------------------------------------------------------------
function scenarioExpiryBoundary(): void {
  const approval = { expiresAt: "2026-01-01T00:30:00.000Z" };
  check("만료 시각 이전 -> false", isApprovalExpired(approval, "2026-01-01T00:29:59.999Z") === false);
  check("만료 시각 정각 -> true(경계 포함)", isApprovalExpired(approval, "2026-01-01T00:30:00.000Z") === true);
  check("만료 시각 이후 -> true", isApprovalExpired(approval, "2026-01-01T00:30:00.001Z") === true);
}

// ---------------------------------------------------------------------------
// Telegram callback_data build/parse
// ---------------------------------------------------------------------------
function scenarioCallbackRoundTrip(): void {
  const id = randomUUID();
  for (const action of ["APPROVE", "REJECT", "DEFER"] as ApprovalAction[]) {
    const data = buildApprovalCallbackData(id, action);
    const parsed = parseApprovalCallbackData(data);
    check(`callback_data round-trip(${action})`, parsed !== null && parsed.approvalId === id && parsed.action === action);
  }
}
function scenarioCallbackDataNoSensitiveFields(): void {
  const data = buildApprovalCallbackData(randomUUID(), "APPROVE");
  check(
    "callback_data는 approvalId+action만 담고, chatId/reason/token 등 다른 정보를 담지 않음",
    /^ap:[0-9a-f-]+:A$/i.test(data)
  );
}
function scenarioCallbackMalformedRejected(): void {
  const malformed = [
    "",
    "ap:",
    "ap::A",
    "ap:short:A", // approvalId가 8자 미만
    `ap:${randomUUID()}:X`, // 알 수 없는 action code
    `ap:${randomUUID()}`, // action 누락
    `not-ap:${randomUUID()}:A`, // 다른 prefix
    `ap:${randomUUID()}:a`, // 소문자 action code(정의되지 않음)
    `ap:${randomUUID()};DROP TABLE;:A`, // 형식 밖 문자
  ];
  for (const data of malformed) {
    check(`malformed callback_data 거부: ${JSON.stringify(data)}`, parseApprovalCallbackData(data) === null);
  }
}

async function main(): Promise<void> {
  scenarioClassifySecurityBlocked();
  scenarioClassifyReviewCycleExhausted();
  scenarioClassifyReviewBlocked();
  scenarioClassifyHighRiskPregate();
  scenarioClassifyAuditStoreUnavailable();
  scenarioClassifyCheckpointScopeViolation();
  scenarioClassifyOrchestratorGeneric();
  scenarioClassifyUnknownReason();
  scenarioClassifyRequiredTestConfigurationErrorIsUnknownButHarmless();
  scenarioClassifyNoReason();
  scenarioClassifyOtherEventType();
  scenarioClassifyDeterministic();
  scenarioRemotelyApprovableAllowList();
  scenarioBuildApprovalRequestFields();
  scenarioBuildApprovalRequestCustomExpiry();
  scenarioBuildApprovalRequestGitExpectation();
  scenarioBuildApprovalRequestOrchestratorGeneric();
  scenarioBuildApprovalRequestUniqueIds();
  scenarioExpiryBoundary();
  scenarioCallbackRoundTrip();
  scenarioCallbackDataNoSensitiveFields();
  scenarioCallbackMalformedRejected();

  console.log("\n=== approval.ts(G6) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
