import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryEventStore, createFileEventStore } from "./event-store";
import type { EventStore, QueryResult } from "./event-store";
import type { AutoDevEventInput } from "./observability-event";
import { buildAutoDevLiveSnapshot, aggregateHistoricalSummary, detectNotifiableSignal } from "./live-snapshot";

// Live Operations Read Model & Dashboard Data Foundation 테스트(Phase G Task G4). 실제
// Claude/GPT 유료 API를 호출하지 않는다 — 이 파일은 EventStore에 직접 event를 append해
// 만든 fixture만 다룬다(G1~G3.1의 production 배선은 이미 event-store-tests.ts/
// metrics-tests.ts/production-agent-integration-tests.ts가 검증한다). 이 파일은 그 위에서
// 순수 Read Model 변환 함수만 검증한다 — 실제 Dashboard UI는 없다(범위 밖).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-live-snapshot-"));
  tempDirs.push(dir);
  return dir;
}

function ev(overrides: Partial<AutoDevEventInput> & { eventType: AutoDevEventInput["eventType"]; runId: string }): AutoDevEventInput {
  return overrides;
}

function buildStore(inputs: AutoDevEventInput[]): { store: EventStore; result: QueryResult } {
  const store = createInMemoryEventStore();
  for (const i of inputs) store.append(i);
  return { store, result: store.query() };
}

// ---------------------------------------------------------------------------
// 1) IDLE snapshot — 실행할 task가 없어(decideNextAction STOP) RUN_COMPLETED(SKIPPED)만
//    기록된 경우.
// ---------------------------------------------------------------------------
function scenarioIdleSnapshot(): void {
  const { result } = buildStore([
    ev({ eventType: "RUN_STARTED", runId: "run-idle", executionPhase: "task_selection", outcome: "PENDING" }),
    ev({ eventType: "RUN_COMPLETED", runId: "run-idle", executionPhase: "task_selection", outcome: "SKIPPED", reason: "실행할 task 없음" }),
  ]);
  const snap = buildAutoDevLiveSnapshot(result, { runId: "run-idle" });
  check("IDLE: runStatus=IDLE", snap.runStatus === "IDLE");
  check("IDLE: taskStatus=IDLE", snap.taskStatus === "IDLE");
  check("IDLE: taskId 없음", snap.taskId === undefined);
}

// ---------------------------------------------------------------------------
// 2) RUNNING task.
// ---------------------------------------------------------------------------
function scenarioRunningTask(): void {
  const { result } = buildStore([
    ev({ eventType: "RUN_STARTED", runId: "run-running", executionPhase: "task_selection" }),
    ev({ eventType: "TASK_STARTED", runId: "run-running", taskId: "T1", executionPhase: "task_selection" }),
  ]);
  const snap = buildAutoDevLiveSnapshot(result, { runId: "run-running" });
  check("RUNNING: runStatus=RUNNING", snap.runStatus === "RUNNING");
  check("RUNNING: taskStatus=RUNNING", snap.taskStatus === "RUNNING");
  check("RUNNING: taskId=T1(자동 감지)", snap.taskId === "T1");
  check("RUNNING: currentAction=Task 시작", snap.currentOperation.currentAction === "Task 시작");
  check("RUNNING: startedAt 실제 값", typeof snap.currentOperation.startedAt === "string");
}

// ---------------------------------------------------------------------------
// 3) Agent 0회 task — advisory가 전부 빈 값이어야 한다.
// ---------------------------------------------------------------------------
function scenarioZeroAgentTask(): void {
  const { result } = buildStore([
    ev({ eventType: "RUN_STARTED", runId: "run-noagent" }),
    ev({ eventType: "TASK_STARTED", runId: "run-noagent", taskId: "T1" }),
    ev({ eventType: "TEST_COMPLETED", runId: "run-noagent", taskId: "T1", outcome: "SUCCESS", testSummary: { total: 1, passed: 1, failed: 0 } }),
  ]);
  const snap = buildAutoDevLiveSnapshot(result, { runId: "run-noagent" });
  check("0 agent: advisory.selected 빈 배열", snap.advisory.selected.length === 0);
  check("0 agent: completedAgentIds 빈 배열", snap.advisory.completedAgentIds.length === 0);
  check("0 agent: callCountByAgent 빈 객체", Object.keys(snap.advisory.callCountByAgent).length === 0);
}

// ---------------------------------------------------------------------------
// 4) planner/research/qa/security 표시.
// ---------------------------------------------------------------------------
function scenarioAdvisoryAgentsDisplayed(): void {
  const roles: { agentId: string; role: AutoDevEventInput["agentRole"] }[] = [
    { agentId: "core-planner", role: "planner" },
    { agentId: "core-research", role: "research" },
    { agentId: "core-qa", role: "qa" },
    { agentId: "core-security", role: "security" },
  ];
  const inputs: AutoDevEventInput[] = [
    ev({ eventType: "RUN_STARTED", runId: "run-advisory" }),
    ev({ eventType: "TASK_STARTED", runId: "run-advisory", taskId: "T1" }),
  ];
  for (const r of roles) {
    inputs.push(ev({ eventType: "AGENT_SELECTED", runId: "run-advisory", taskId: "T1", agentId: r.agentId, agentRole: r.role, executionPhase: "pre_development" }));
    inputs.push(ev({ eventType: "AGENT_STARTED", runId: "run-advisory", taskId: "T1", agentId: r.agentId, agentRole: r.role, executionPhase: "pre_development", outcome: "PENDING" }));
    inputs.push(ev({ eventType: "AGENT_COMPLETED", runId: "run-advisory", taskId: "T1", agentId: r.agentId, agentRole: r.role, executionPhase: "pre_development", outcome: "SUCCESS" }));
  }
  const { result } = buildStore(inputs);
  const snap = buildAutoDevLiveSnapshot(result, { runId: "run-advisory" });
  const selectedRoles = snap.advisory.selected.map((a) => a.role).sort();
  check("advisory: planner/research/qa/security 4개 모두 selected", selectedRoles.join(",") === ["planner", "qa", "research", "security"].sort().join(","));
  check("advisory: 4개 모두 completed", snap.advisory.completedAgentIds.length === 4);
  check("advisory: callCountByAgent 각 1회", roles.every((r) => snap.advisory.callCountByAgent[r.agentId] === 1));
  check("advisory: 마지막 agent 완료 후 activeAgentId 없음", snap.currentOperation.activeAgentId === undefined);
}

// ---------------------------------------------------------------------------
// 5)/6) test PASS/FAIL.
// ---------------------------------------------------------------------------
function scenarioTestPass(): void {
  const { result } = buildStore([
    ev({ eventType: "RUN_STARTED", runId: "run-testpass" }),
    ev({ eventType: "TASK_STARTED", runId: "run-testpass", taskId: "T1" }),
    ev({ eventType: "TEST_COMPLETED", runId: "run-testpass", taskId: "T1", outcome: "SUCCESS", testSummary: { total: 3, passed: 3, failed: 0 } }),
  ]);
  const snap = buildAutoDevLiveSnapshot(result, { runId: "run-testpass" });
  check("test PASS: tests.status=PASS", snap.tests.status === "PASS");
  check("test PASS: latest.failed=0", snap.tests.latest?.failed === 0);
}

function scenarioTestFail(): void {
  const { result } = buildStore([
    ev({ eventType: "RUN_STARTED", runId: "run-testfail" }),
    ev({ eventType: "TASK_STARTED", runId: "run-testfail", taskId: "T1" }),
    ev({ eventType: "TEST_COMPLETED", runId: "run-testfail", taskId: "T1", outcome: "FAILED", testSummary: { total: 3, passed: 2, failed: 1, failedNames: ["test-b"] } }),
  ]);
  const snap = buildAutoDevLiveSnapshot(result, { runId: "run-testfail" });
  check("test FAIL: tests.status=FAIL", snap.tests.status === "FAIL");
  check("test FAIL: latest.failedNames=[test-b]", snap.tests.latest?.failedNames?.join(",") === "test-b");
  check("test FAIL: detectNotifiableSignal=TEST_FAILED", detectNotifiableSignal(snap) === "TEST_FAILED");
}

// ---------------------------------------------------------------------------
// 7) REVIEWING.
// ---------------------------------------------------------------------------
function scenarioReviewing(): void {
  const { result } = buildStore([
    ev({ eventType: "RUN_STARTED", runId: "run-reviewing" }),
    ev({ eventType: "TASK_STARTED", runId: "run-reviewing", taskId: "T1" }),
    ev({ eventType: "TEST_COMPLETED", runId: "run-reviewing", taskId: "T1", outcome: "SUCCESS", testSummary: { total: 1, passed: 1, failed: 0 } }),
    ev({ eventType: "REVIEW_STARTED", runId: "run-reviewing", taskId: "T1", reviseCycle: 1 }),
  ]);
  const snap = buildAutoDevLiveSnapshot(result, { runId: "run-reviewing" });
  check("REVIEWING: taskStatus=REVIEWING", snap.taskStatus === "REVIEWING");
  check("REVIEWING: review.callCount=1", snap.review.callCount === 1);
}

// ---------------------------------------------------------------------------
// 8) REVISE 1회/2회.
// ---------------------------------------------------------------------------
function scenarioReviseCycles(): void {
  const { result } = buildStore([
    ev({ eventType: "RUN_STARTED", runId: "run-revise" }),
    ev({ eventType: "TASK_STARTED", runId: "run-revise", taskId: "T1" }),
    ev({ eventType: "TEST_COMPLETED", runId: "run-revise", taskId: "T1", outcome: "SUCCESS", testSummary: { total: 1, passed: 1, failed: 0 } }),
    ev({ eventType: "REVIEW_STARTED", runId: "run-revise", taskId: "T1", reviseCycle: 1 }),
    ev({ eventType: "REVIEW_REVISE", runId: "run-revise", taskId: "T1", reviseCycle: 1, reviewDecision: "REVISE" }),
    ev({ eventType: "DEVELOPER_RETRY_STARTED", runId: "run-revise", taskId: "T1", reviseCycle: 2 }),
    ev({ eventType: "TEST_COMPLETED", runId: "run-revise", taskId: "T1", outcome: "SUCCESS", testSummary: { total: 1, passed: 1, failed: 0 } }),
    ev({ eventType: "REVIEW_STARTED", runId: "run-revise", taskId: "T1", reviseCycle: 2 }),
  ]);
  const snapAfterOneRevise = buildAutoDevLiveSnapshot(
    { events: result.events.filter((e) => e.sequence <= 5), integrityIssues: [] },
    { runId: "run-revise" }
  );
  check("REVISE 1회: taskStatus=REVISING", snapAfterOneRevise.taskStatus === "REVISING");
  check("REVISE 1회: quality.reviseCount=1", snapAfterOneRevise.quality.reviseCount === 1);

  const snapFull = buildAutoDevLiveSnapshot(result, { runId: "run-revise" });
  check("REVISE 2회: review.reviewCycle=2", snapFull.review.reviewCycle === 2);
  check("REVISE 2회: development.callCount=2(최초+RETRY 1회)", snapFull.development.callCount === 2);
}

// ---------------------------------------------------------------------------
// 9) WAITING_HUMAN.
// ---------------------------------------------------------------------------
function scenarioWaitingHuman(): void {
  const { result } = buildStore([
    ev({ eventType: "RUN_STARTED", runId: "run-waiting" }),
    ev({ eventType: "TASK_STARTED", runId: "run-waiting", taskId: "T1" }),
    ev({ eventType: "HUMAN_APPROVAL_REQUIRED", runId: "run-waiting", taskId: "T1", humanInterventionRequired: true }),
  ]);
  const snap = buildAutoDevLiveSnapshot(result, { runId: "run-waiting" });
  check("WAITING_HUMAN: taskStatus=WAITING_HUMAN", snap.taskStatus === "WAITING_HUMAN");
  check("WAITING_HUMAN: safety.humanApprovalRequired=true", snap.safety.humanApprovalRequired === true);
  check("WAITING_HUMAN: safety.securityBlocked=false", snap.safety.securityBlocked === false);
  check("WAITING_HUMAN: detectNotifiableSignal=WAITING_HUMAN", detectNotifiableSignal(snap) === "WAITING_HUMAN");
}

// ---------------------------------------------------------------------------
// 10) SECURITY_BLOCKED.
// ---------------------------------------------------------------------------
function scenarioSecurityBlocked(): void {
  const { result } = buildStore([
    ev({ eventType: "RUN_STARTED", runId: "run-secblock" }),
    ev({ eventType: "TASK_STARTED", runId: "run-secblock", taskId: "T1" }),
    ev({ eventType: "SECURITY_BLOCKED", runId: "run-secblock", taskId: "T1", humanInterventionRequired: true, metadata: { secretFindingCount: 1, dependencyScanVerdict: null } }),
  ]);
  const snap = buildAutoDevLiveSnapshot(result, { runId: "run-secblock" });
  check("SECURITY_BLOCKED: taskStatus=BLOCKED", snap.taskStatus === "BLOCKED");
  check("SECURITY_BLOCKED: safety.securityBlocked=true", snap.safety.securityBlocked === true);
  check("SECURITY_BLOCKED: detectNotifiableSignal=SECURITY_BLOCKED", detectNotifiableSignal(snap) === "SECURITY_BLOCKED");
}

// ---------------------------------------------------------------------------
// 11) REVIEW_CYCLE_EXHAUSTED.
// ---------------------------------------------------------------------------
function scenarioReviewCycleExhausted(): void {
  const { result } = buildStore([
    ev({ eventType: "RUN_STARTED", runId: "run-exhausted" }),
    ev({ eventType: "TASK_STARTED", runId: "run-exhausted", taskId: "T1" }),
    ev({ eventType: "REVIEW_CYCLE_EXHAUSTED", runId: "run-exhausted", taskId: "T1", reviseCycle: 5, humanInterventionRequired: true }),
  ]);
  const snap = buildAutoDevLiveSnapshot(result, { runId: "run-exhausted" });
  check("REVIEW_CYCLE_EXHAUSTED: taskStatus=WAITING_HUMAN", snap.taskStatus === "WAITING_HUMAN");
  check("REVIEW_CYCLE_EXHAUSTED: quality.reviewCycleExhausted=true", snap.quality.reviewCycleExhausted === true);
  check("REVIEW_CYCLE_EXHAUSTED: detectNotifiableSignal=REVIEW_CYCLE_EXHAUSTED", detectNotifiableSignal(snap) === "REVIEW_CYCLE_EXHAUSTED");
}

// ---------------------------------------------------------------------------
// 12)/13) CHECKPOINT_CREATED → COMPLETED.
// ---------------------------------------------------------------------------
function scenarioCheckpointThenCompleted(): void {
  const upToCheckpoint: AutoDevEventInput[] = [
    ev({ eventType: "RUN_STARTED", runId: "run-checkpoint" }),
    ev({ eventType: "TASK_STARTED", runId: "run-checkpoint", taskId: "T1" }),
    ev({ eventType: "CHECKPOINT_CREATED", runId: "run-checkpoint", taskId: "T1", metadata: { commitHash: "abc123" } }),
  ];
  const { result: partial } = buildStore(upToCheckpoint);
  const snapCheckpointing = buildAutoDevLiveSnapshot(partial, { runId: "run-checkpoint" });
  check("CHECKPOINT_CREATED: taskStatus=CHECKPOINTING", snapCheckpointing.taskStatus === "CHECKPOINTING");
  check("CHECKPOINT_CREATED: safety.checkpointStatus=CREATED", snapCheckpointing.safety.checkpointStatus === "CREATED");
  check("CHECKPOINT_CREATED: checkpointCommitHash=abc123", snapCheckpointing.safety.checkpointCommitHash === "abc123");

  const store = createInMemoryEventStore();
  for (const i of upToCheckpoint) store.append(i);
  store.append(ev({ eventType: "TASK_COMPLETED", runId: "run-checkpoint", taskId: "T1", outcome: "SUCCESS" }));
  store.append(ev({ eventType: "RUN_COMPLETED", runId: "run-checkpoint", taskId: "T1", outcome: "SUCCESS" }));
  const snapCompleted = buildAutoDevLiveSnapshot(store.query(), { runId: "run-checkpoint" });
  check("COMPLETED: taskStatus=COMPLETED", snapCompleted.taskStatus === "COMPLETED");
  check("COMPLETED: runStatus=COMPLETED", snapCompleted.runStatus === "COMPLETED");
  check("COMPLETED: detectNotifiableSignal=TASK_COMPLETED", detectNotifiableSignal(snapCompleted) === "TASK_COMPLETED");
}

// ---------------------------------------------------------------------------
// 14) Claude/GPT token usage 정확 표시.
// ---------------------------------------------------------------------------
function scenarioTokenUsageAccuracy(): void {
  const { result } = buildStore([
    ev({ eventType: "RUN_STARTED", runId: "run-tokens" }),
    ev({ eventType: "TASK_STARTED", runId: "run-tokens", taskId: "T1" }),
    ev({
      eventType: "TEST_COMPLETED",
      runId: "run-tokens",
      taskId: "T1",
      outcome: "SUCCESS",
      testSummary: { total: 1, passed: 1, failed: 0 },
      model: { provider: "anthropic", name: "claude-x" },
      tokenUsage: { inputTokens: 100, outputTokens: 50 },
    }),
    ev({ eventType: "REVIEW_STARTED", runId: "run-tokens", taskId: "T1", reviseCycle: 1 }),
    ev({
      eventType: "REVIEW_APPROVED",
      runId: "run-tokens",
      taskId: "T1",
      reviseCycle: 1,
      reviewDecision: "PASS",
      model: { provider: "openai", name: "gpt-x" },
      tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    }),
  ]);
  const snap = buildAutoDevLiveSnapshot(result, { runId: "run-tokens" });
  check("token: development.tokenUsage.inputTokens=100", snap.development.tokenUsage?.inputTokens === 100);
  check("token: development.model.provider=anthropic", snap.development.model?.provider === "anthropic");
  check("token: review.tokenUsage.outputTokens=5", snap.review.tokenUsage?.outputTokens === 5);
  check("token: review.model.provider=openai", snap.review.model?.provider === "openai");
  check("token: usage.claudeTokens.inputTokens=100", snap.usage.claudeTokens?.inputTokens === 100);
  check("token: usage.gptTokens.totalTokens=15", snap.usage.gptTokens?.totalTokens === 15);
  check("token: usage.totalKnownTokens=15(claude totalTokens 미제공은 0으로 합산되지 않고 무시)", snap.usage.totalKnownTokens === 15);
}

// ---------------------------------------------------------------------------
// 15) unknown usage는 undefined.
// ---------------------------------------------------------------------------
function scenarioUnknownUsageUndefined(): void {
  const { result } = buildStore([
    ev({ eventType: "RUN_STARTED", runId: "run-nousage" }),
    ev({ eventType: "TASK_STARTED", runId: "run-nousage", taskId: "T1" }),
    ev({ eventType: "TEST_COMPLETED", runId: "run-nousage", taskId: "T1", outcome: "SUCCESS", testSummary: { total: 1, passed: 1, failed: 0 } }),
  ]);
  const snap = buildAutoDevLiveSnapshot(result, { runId: "run-nousage" });
  check("unknown usage: development.tokenUsage undefined", snap.development.tokenUsage === undefined);
  check("unknown usage: usage.claudeTokens undefined", snap.usage.claudeTokens === undefined);
  check("unknown usage: usage.totalKnownTokens undefined", snap.usage.totalKnownTokens === undefined);
  check("unknown usage: usage.actualCostUsd/estimatedCostUsd undefined", snap.usage.actualCostUsd === undefined && snap.usage.estimatedCostUsd === undefined);
  check("unknown usage: subscriptionUsage undefined(입력 없음)", snap.subscriptionUsage === undefined);
}

// ---------------------------------------------------------------------------
// 16) actual/estimated cost 구분.
// ---------------------------------------------------------------------------
function scenarioActualVsEstimatedCost(): void {
  const { result } = buildStore([
    ev({ eventType: "RUN_STARTED", runId: "run-cost" }),
    ev({ eventType: "TASK_STARTED", runId: "run-cost", taskId: "T1" }),
    ev({
      eventType: "TEST_COMPLETED",
      runId: "run-cost",
      taskId: "T1",
      outcome: "SUCCESS",
      testSummary: { total: 1, passed: 1, failed: 0 },
      tokenUsage: { actualCostUsd: 0.05 },
    }),
    ev({ eventType: "REVIEW_STARTED", runId: "run-cost", taskId: "T1", reviseCycle: 1 }),
    ev({
      eventType: "REVIEW_APPROVED",
      runId: "run-cost",
      taskId: "T1",
      reviseCycle: 1,
      reviewDecision: "PASS",
      tokenUsage: { estimatedCostUsd: 0.02 },
    }),
  ]);
  const snap = buildAutoDevLiveSnapshot(result, { runId: "run-cost" });
  check("cost: actualCostUsd=0.05", snap.usage.actualCostUsd === 0.05);
  check("cost: estimatedCostUsd=0.02", snap.usage.estimatedCostUsd === 0.02);
}

// ---------------------------------------------------------------------------
// 17) 서로 다른 runId 혼합 금지 — 호출부가 필터링하지 않은 전체 QueryResult를 넘겨도
//     지정한 runId 밖 데이터가 섞이지 않아야 한다.
// ---------------------------------------------------------------------------
function scenarioNoCrossRunMixing(): void {
  const { result } = buildStore([
    ev({ eventType: "RUN_STARTED", runId: "run-a" }),
    ev({ eventType: "TASK_STARTED", runId: "run-a", taskId: "T-A" }),
    ev({ eventType: "TEST_COMPLETED", runId: "run-a", taskId: "T-A", outcome: "SUCCESS", testSummary: { total: 1, passed: 1, failed: 0 } }),
    ev({ eventType: "RUN_STARTED", runId: "run-b" }),
    ev({ eventType: "TASK_STARTED", runId: "run-b", taskId: "T-B" }),
    ev({ eventType: "SECURITY_BLOCKED", runId: "run-b", taskId: "T-B" }),
  ]);
  const snapA = buildAutoDevLiveSnapshot(result, { runId: "run-a" });
  check("cross-run: run-a taskId=T-A", snapA.taskId === "T-A");
  check("cross-run: run-a에는 run-b의 SECURITY_BLOCKED가 섞이지 않음", snapA.safety.securityBlocked === false);
  check("cross-run: run-a taskStatus는 run-b 영향 없이 TESTING(자신의 마지막 event 기준)", snapA.taskStatus === "TESTING");

  const snapB = buildAutoDevLiveSnapshot(result, { runId: "run-b" });
  check("cross-run: run-b taskId=T-B", snapB.taskId === "T-B");
  check("cross-run: run-b는 실제로 BLOCKED", snapB.taskStatus === "BLOCKED");
}

// ---------------------------------------------------------------------------
// 18) DEGRADED integrity 전파.
// ---------------------------------------------------------------------------
function scenarioDegradedIntegrityPropagates(): void {
  const dir = makeTempDir();
  const filePath = join(dir, "events.jsonl");
  const store = createFileEventStore(filePath);
  store.append(ev({ eventType: "RUN_STARTED", runId: "run-degraded" }));
  store.append(ev({ eventType: "TASK_STARTED", runId: "run-degraded", taskId: "T1" }));
  appendFileSync(filePath, "{ this is not valid JSON\n", "utf-8");

  const result = store.query();
  check("DEGRADED fixture: integrityIssues 비어있지 않음", result.integrityIssues.length > 0);

  const snap = buildAutoDevLiveSnapshot(result, { runId: "run-degraded" });
  check("DEGRADED: snapshot.integrity=DEGRADED", snap.integrity === "DEGRADED");
  check("DEGRADED: safety.auditIntegrity=DEGRADED", snap.safety.auditIntegrity === "DEGRADED");
  check("DEGRADED: integrityNote 존재", typeof snap.integrityNote === "string" && snap.integrityNote.length > 0);

  const historical = aggregateHistoricalSummary(result);
  check("DEGRADED: historical.integrity=DEGRADED", historical.integrity === "DEGRADED");
}

// ---------------------------------------------------------------------------
// 19) raw prompt/output/secret 비노출.
// ---------------------------------------------------------------------------
function scenarioNoSensitiveDataExposure(): void {
  const { result } = buildStore([
    ev({ eventType: "RUN_STARTED", runId: "run-sensitive" }),
    ev({ eventType: "TASK_STARTED", runId: "run-sensitive", taskId: "T1" }),
    ev({
      eventType: "HUMAN_APPROVAL_REQUIRED",
      runId: "run-sensitive",
      taskId: "T1",
      humanInterventionRequired: true,
      reason: "RAW_OUTPUT_MARKER_should_never_leak_sk-fake12345",
      error: { message: "another RAW_OUTPUT_MARKER in error" },
      metadata: { secretFindingCount: 1, dependencyScanVerdict: null, unexpectedFreeText: "RAW_OUTPUT_MARKER_in_metadata" },
    }),
  ]);
  const snap = buildAutoDevLiveSnapshot(result, { runId: "run-sensitive" });
  const serialized = JSON.stringify(snap);
  check("sensitive: reason 원문이 snapshot에 없음", !serialized.includes("RAW_OUTPUT_MARKER"));
  check("sensitive: metadata의 임의 필드가 snapshot에 없음", !serialized.includes("unexpectedFreeText"));
  check("sensitive: currentAction은 고정 라벨만", snap.currentOperation.currentAction === "사람 승인 대기 중");
}

// ---------------------------------------------------------------------------
// Historical Summary — 여러 run에 걸친 완료 task 통계.
// ---------------------------------------------------------------------------
function scenarioHistoricalSummary(): void {
  const { result } = buildStore([
    ev({ eventType: "RUN_STARTED", runId: "run-h1" }),
    ev({ eventType: "TASK_STARTED", runId: "run-h1", taskId: "H1" }),
    ev({ eventType: "TEST_COMPLETED", runId: "run-h1", taskId: "H1", outcome: "SUCCESS", testSummary: { total: 1, passed: 1, failed: 0 } }),
    ev({ eventType: "REVIEW_STARTED", runId: "run-h1", taskId: "H1", reviseCycle: 1 }),
    ev({ eventType: "REVIEW_APPROVED", runId: "run-h1", taskId: "H1", reviseCycle: 1, reviewDecision: "PASS" }),
    ev({ eventType: "CHECKPOINT_CREATED", runId: "run-h1", taskId: "H1" }),
    ev({ eventType: "TASK_COMPLETED", runId: "run-h1", taskId: "H1", outcome: "SUCCESS" }),
    ev({ eventType: "RUN_COMPLETED", runId: "run-h1", taskId: "H1", outcome: "SUCCESS" }),

    ev({ eventType: "RUN_STARTED", runId: "run-h2" }),
    ev({ eventType: "TASK_STARTED", runId: "run-h2", taskId: "H2" }),
    ev({ eventType: "TEST_COMPLETED", runId: "run-h2", taskId: "H2", outcome: "SUCCESS", testSummary: { total: 1, passed: 1, failed: 0 } }),
    ev({ eventType: "REVIEW_STARTED", runId: "run-h2", taskId: "H2", reviseCycle: 1 }),
    ev({ eventType: "REVIEW_REVISE", runId: "run-h2", taskId: "H2", reviseCycle: 1, reviewDecision: "REVISE" }),
    ev({ eventType: "DEVELOPER_RETRY_STARTED", runId: "run-h2", taskId: "H2", reviseCycle: 2 }),
    ev({ eventType: "TEST_COMPLETED", runId: "run-h2", taskId: "H2", outcome: "SUCCESS", testSummary: { total: 1, passed: 1, failed: 0 } }),
    ev({ eventType: "REVIEW_STARTED", runId: "run-h2", taskId: "H2", reviseCycle: 2 }),
    ev({ eventType: "REVIEW_APPROVED", runId: "run-h2", taskId: "H2", reviseCycle: 2, reviewDecision: "PASS" }),
    ev({ eventType: "CHECKPOINT_CREATED", runId: "run-h2", taskId: "H2" }),
    ev({ eventType: "TASK_COMPLETED", runId: "run-h2", taskId: "H2", outcome: "SUCCESS" }),
    ev({ eventType: "RUN_COMPLETED", runId: "run-h2", taskId: "H2", outcome: "SUCCESS" }),
  ]);
  const historical = aggregateHistoricalSummary(result);
  check("historical: completedTaskCount=2", historical.completedTaskCount === 2);
  check("historical: firstPassApprovalRate=0.5(H1만 first-pass)", historical.firstPassApprovalRate === 0.5);
  check("historical: totalReviseCycles=1", historical.totalReviseCycles === 1);
}

async function main(): Promise<void> {
  try {
    scenarioIdleSnapshot();
    scenarioRunningTask();
    scenarioZeroAgentTask();
    scenarioAdvisoryAgentsDisplayed();
    scenarioTestPass();
    scenarioTestFail();
    scenarioReviewing();
    scenarioReviseCycles();
    scenarioWaitingHuman();
    scenarioSecurityBlocked();
    scenarioReviewCycleExhausted();
    scenarioCheckpointThenCompleted();
    scenarioTokenUsageAccuracy();
    scenarioUnknownUsageUndefined();
    scenarioActualVsEstimatedCost();
    scenarioNoCrossRunMixing();
    scenarioDegradedIntegrityPropagates();
    scenarioNoSensitiveDataExposure();
    scenarioHistoricalSummary();
  } finally {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // 정리 실패는 테스트 결과에 영향 없음(OS 임시 디렉터리).
      }
    }
  }

  console.log("\n=== live-snapshot(G4) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
