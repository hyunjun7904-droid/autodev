import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryEventStore, createFileEventStore } from "./event-store";
import type { EventStore, QueryResult } from "./event-store";
import type { AutoDevEventInput } from "./observability-event";
import {
  aggregateRunMetrics,
  aggregateTaskMetrics,
  aggregateAllTaskMetrics,
  aggregateAgentMetrics,
  aggregateQualityMetrics,
  aggregateUsageMetrics,
  aggregateCostMetrics,
} from "./metrics";
import { describeClaudeUsageSnapshot } from "./claude-usage-snapshot";

// Usage, Cost & Performance Metrics Foundation 테스트(Phase G Task G3). 실제 Claude/GPT
// 유료 API를 호출하지 않는다 — 이 파일은 EventStore에 직접 event를 append해 만든 fixture만
// 다룬다(orchestrator.ts/autodev.ts의 실제 production 배선은 이미 event-store-tests.ts/
// production-agent-integration-tests.ts가 검증한다). 이 파일은 그 위에서 순수 집계 함수만
// 검증한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-metrics-"));
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
// 1) clean run(첫 시도 승인, agent 0회) — Run/Task metrics가 정상 집계된다.
// ---------------------------------------------------------------------------
function scenarioCleanRunMetrics(): void {
  const inputs: AutoDevEventInput[] = [
    ev({ eventType: "RUN_STARTED", runId: "run-1" }),
    ev({ eventType: "TASK_STARTED", runId: "run-1", taskId: "T1" }),
    ev({ eventType: "TEST_COMPLETED", runId: "run-1", taskId: "T1", outcome: "SUCCESS", testSummary: { total: 2, passed: 2, failed: 0 } }),
    ev({ eventType: "REVIEW_STARTED", runId: "run-1", taskId: "T1" }),
    ev({ eventType: "REVIEW_APPROVED", runId: "run-1", taskId: "T1", reviewDecision: "PASS", reviewSeverity: { critical: 0, high: 0, medium: 0 } }),
    ev({ eventType: "CHECKPOINT_CREATED", runId: "run-1", taskId: "T1" }),
    ev({ eventType: "TASK_COMPLETED", runId: "run-1", taskId: "T1" }),
    ev({ eventType: "RUN_COMPLETED", runId: "run-1", taskId: "T1" }),
  ];
  const { result } = buildStore(inputs);

  const run = aggregateRunMetrics(result, "run-1");
  check("clean run: terminalStatus=RUN_COMPLETED", run.terminalStatus === "RUN_COMPLETED");
  check("clean run: blocked=false", run.blocked === false);
  check("clean run: humanInterventionRequired=false", run.humanInterventionRequired === false);
  check("clean run: taskCount=1, taskIds=[T1]", run.taskCount === 1 && run.taskIds.join(",") === "T1");
  check("clean run: startedAt/endedAt이 둘 다 채워짐", typeof run.startedAt === "string" && typeof run.endedAt === "string");
  check("clean run: durationMs가 0 이상의 실제 값(추정 아님)", typeof run.durationMs === "number" && run.durationMs >= 0);
  check("clean run: integrity=CLEAN", run.integrity === "CLEAN");

  const task = aggregateTaskMetrics(result, "run-1", "T1");
  check("clean task: outcome=COMPLETED", task.outcome === "COMPLETED");
  check("clean task: checkpointCreated=true", task.checkpointCreated === true);
  check("clean task: finalTestSummary가 실제 값(failed=0)", task.finalTestSummary?.failed === 0 && task.finalTestSummary?.total === 2);
  check("clean task: testRunCount=1", task.testRunCount === 1);
  check("clean task: finalReviewDecision=PASS", task.finalReviewDecision === "PASS");
  check("clean task: reviseCycleCount=0(REVISE 없음)", task.reviseCycleCount === 0);
  check("clean task: securityBlocked=false, reviewCycleExhausted=false", task.securityBlocked === false && task.reviewCycleExhausted === false);
  check("clean task: durationMs가 실제 값(TASK_STARTED→TASK_COMPLETED)", typeof task.durationMs === "number" && task.durationMs >= 0);
}

// ---------------------------------------------------------------------------
// 2) agent 0회 plain task — AGENT_* event가 하나도 없으면 빈 배열을 반환한다(가짜 항목을
//    만들어내지 않는다).
// ---------------------------------------------------------------------------
function scenarioZeroAgentPlainTask(): void {
  const inputs: AutoDevEventInput[] = [
    ev({ eventType: "RUN_STARTED", runId: "run-plain" }),
    ev({ eventType: "TASK_STARTED", runId: "run-plain", taskId: "T-plain" }),
    ev({ eventType: "TASK_COMPLETED", runId: "run-plain", taskId: "T-plain" }),
    ev({ eventType: "RUN_COMPLETED", runId: "run-plain", taskId: "T-plain" }),
  ];
  const { result } = buildStore(inputs);
  const agents = aggregateAgentMetrics(result, "run-plain");
  check("agent 0회: 빈 배열을 반환함(가짜 agent 항목 없음)", Array.isArray(agents) && agents.length === 0);
}

// ---------------------------------------------------------------------------
// 3) planner/research/qa/security 호출 횟수 — 각 agent별 callCount/outcomes/
//    callCountByTask가 정확히 집계된다.
// ---------------------------------------------------------------------------
function scenarioAgentRoleCallCounts(): void {
  function agentTriple(agentId: string, role: AutoDevEventInput["agentRole"], taskId: string, phase: "pre_development" | "post_development") {
    return [
      ev({ eventType: "AGENT_SELECTED", runId: "run-agents", taskId, agentId, agentRole: role, executionPhase: phase }),
      ev({ eventType: "AGENT_STARTED", runId: "run-agents", taskId, agentId, agentRole: role, executionPhase: phase, outcome: "PENDING" }),
      ev({ eventType: "AGENT_COMPLETED", runId: "run-agents", taskId, agentId, agentRole: role, executionPhase: phase, outcome: "SUCCESS" }),
    ];
  }
  const inputs: AutoDevEventInput[] = [
    ev({ eventType: "RUN_STARTED", runId: "run-agents" }),
    ev({ eventType: "TASK_STARTED", runId: "run-agents", taskId: "T1" }),
    ...agentTriple("core-planner", "planner", "T1", "pre_development"),
    ...agentTriple("core-research", "research", "T1", "pre_development"),
    ...agentTriple("core-qa", "qa", "T1", "post_development"),
    ...agentTriple("core-security", "security", "T1", "post_development"),
  ];
  const { result } = buildStore(inputs);
  const agents = aggregateAgentMetrics(result, "run-agents");

  check("agent 역할별: 4개 agent가 모두 집계됨", agents.length === 4);
  for (const [agentId, role] of [
    ["core-planner", "planner"],
    ["core-research", "research"],
    ["core-qa", "qa"],
    ["core-security", "security"],
  ] as const) {
    const m = agents.find((a) => a.agentId === agentId);
    check(`agent 역할별: ${agentId} callCount=1`, m?.callCount === 1);
    check(`agent 역할별: ${agentId} role=${role}`, m?.role === role);
    check(`agent 역할별: ${agentId} outcomes.success=1`, m?.outcomes.success === 1);
    check(`agent 역할별: ${agentId} callCountByTask[T1]=1`, m?.callCountByTask["T1"] === 1);
  }
}

// ---------------------------------------------------------------------------
// 4) first-pass APPROVED — REVISE 없이 승인된 task는 firstPassApprovedCount에 포함된다.
// ---------------------------------------------------------------------------
function scenarioFirstPassApproved(): void {
  const inputs: AutoDevEventInput[] = [
    ev({ eventType: "RUN_STARTED", runId: "run-fp" }),
    ev({ eventType: "TASK_STARTED", runId: "run-fp", taskId: "T1" }),
    ev({ eventType: "REVIEW_APPROVED", runId: "run-fp", taskId: "T1", reviewDecision: "PASS" }),
    ev({ eventType: "TASK_COMPLETED", runId: "run-fp", taskId: "T1" }),
    ev({ eventType: "RUN_COMPLETED", runId: "run-fp", taskId: "T1" }),
  ];
  const { result } = buildStore(inputs);
  const quality = aggregateQualityMetrics(result, "run-fp");
  check("first-pass: firstPassApprovedCount=1", quality.firstPassApprovedCount === 1);
  check("first-pass: totalReviseCycles=0", quality.totalReviseCycles === 0);
}

// ---------------------------------------------------------------------------
// 5) REVISE 1회/2회 집계 — reviseCycleCount가 REVIEW_REVISE 실제 발생 횟수와 정확히 일치.
// ---------------------------------------------------------------------------
function scenarioReviseCycleCounts(): void {
  const oneRevise: AutoDevEventInput[] = [
    ev({ eventType: "RUN_STARTED", runId: "run-revise1" }),
    ev({ eventType: "TASK_STARTED", runId: "run-revise1", taskId: "T1" }),
    ev({ eventType: "REVIEW_REVISE", runId: "run-revise1", taskId: "T1", reviewDecision: "REVISE", reviseCycle: 1 }),
    ev({ eventType: "REVIEW_APPROVED", runId: "run-revise1", taskId: "T1", reviewDecision: "PASS", reviseCycle: 2 }),
    ev({ eventType: "TASK_COMPLETED", runId: "run-revise1", taskId: "T1" }),
  ];
  const twoRevise: AutoDevEventInput[] = [
    ev({ eventType: "RUN_STARTED", runId: "run-revise2" }),
    ev({ eventType: "TASK_STARTED", runId: "run-revise2", taskId: "T1" }),
    ev({ eventType: "REVIEW_REVISE", runId: "run-revise2", taskId: "T1", reviewDecision: "REVISE", reviseCycle: 1 }),
    ev({ eventType: "REVIEW_REVISE", runId: "run-revise2", taskId: "T1", reviewDecision: "REVISE", reviseCycle: 2 }),
    ev({ eventType: "REVIEW_APPROVED", runId: "run-revise2", taskId: "T1", reviewDecision: "PASS", reviseCycle: 3 }),
    ev({ eventType: "TASK_COMPLETED", runId: "run-revise2", taskId: "T1" }),
  ];
  const r1 = buildStore(oneRevise).result;
  const r2 = buildStore(twoRevise).result;

  check("REVISE 1회: reviseCycleCount=1", aggregateTaskMetrics(r1, "run-revise1", "T1").reviseCycleCount === 1);
  check("REVISE 2회: reviseCycleCount=2", aggregateTaskMetrics(r2, "run-revise2", "T1").reviseCycleCount === 2);
  check("REVISE 1회: firstPassApprovedCount=0(REVISE가 있었으므로)", aggregateQualityMetrics(r1, "run-revise1").firstPassApprovedCount === 0);
}

// ---------------------------------------------------------------------------
// 6) REVIEW_CYCLE_EXHAUSTED 집계 — task outcome=BLOCKED, reviewCycleExhausted=true.
// ---------------------------------------------------------------------------
function scenarioReviewCycleExhausted(): void {
  const inputs: AutoDevEventInput[] = [
    ev({ eventType: "RUN_STARTED", runId: "run-exhausted" }),
    ev({ eventType: "TASK_STARTED", runId: "run-exhausted", taskId: "T1" }),
    ev({ eventType: "REVIEW_CYCLE_EXHAUSTED", runId: "run-exhausted", taskId: "T1", reviseCycle: 5, humanInterventionRequired: true }),
    ev({ eventType: "RUN_BLOCKED", runId: "run-exhausted", taskId: "T1" }),
  ];
  const { result } = buildStore(inputs);
  const task = aggregateTaskMetrics(result, "run-exhausted", "T1");
  check("cycle 소진: outcome=BLOCKED", task.outcome === "BLOCKED");
  check("cycle 소진: reviewCycleExhausted=true", task.reviewCycleExhausted === true);
  check("cycle 소진: QualityMetrics.reviewCycleExhaustedCount=1", aggregateQualityMetrics(result, "run-exhausted").reviewCycleExhaustedCount === 1);
  const run = aggregateRunMetrics(result, "run-exhausted");
  check("cycle 소진: run.terminalStatus=RUN_BLOCKED, blocked=true", run.terminalStatus === "RUN_BLOCKED" && run.blocked === true);
}

// ---------------------------------------------------------------------------
// 7) test PASS/FAIL — finalTestSummary 기준으로 Quality의 testPassCount/testFailCount가
//    정확히 나뉜다.
// ---------------------------------------------------------------------------
function scenarioTestPassFail(): void {
  const inputs: AutoDevEventInput[] = [
    ev({ eventType: "RUN_STARTED", runId: "run-tests" }),
    ev({ eventType: "TASK_STARTED", runId: "run-tests", taskId: "T-pass" }),
    ev({ eventType: "TEST_COMPLETED", runId: "run-tests", taskId: "T-pass", testSummary: { total: 3, passed: 3, failed: 0 } }),
    ev({ eventType: "TASK_COMPLETED", runId: "run-tests", taskId: "T-pass" }),
  ];
  const { result } = buildStore(inputs);
  const quality = aggregateQualityMetrics(result, "run-tests");
  check("test PASS: testPassCount=1, testFailCount=0", quality.testPassCount === 1 && quality.testFailCount === 0);

  const failInputs: AutoDevEventInput[] = [
    ev({ eventType: "RUN_STARTED", runId: "run-tests-fail" }),
    ev({ eventType: "TASK_STARTED", runId: "run-tests-fail", taskId: "T-fail" }),
    ev({ eventType: "TEST_COMPLETED", runId: "run-tests-fail", taskId: "T-fail", testSummary: { total: 2, passed: 1, failed: 1, failedNames: ["unit-2"] } }),
  ];
  const failResult = buildStore(failInputs).result;
  const failQuality = aggregateQualityMetrics(failResult, "run-tests-fail");
  check("test FAIL: testPassCount=0, testFailCount=1", failQuality.testPassCount === 0 && failQuality.testFailCount === 1);
}

// ---------------------------------------------------------------------------
// 8) security block — SECURITY_BLOCKED가 task/quality 양쪽에 정확히 반영된다.
// ---------------------------------------------------------------------------
function scenarioSecurityBlockCount(): void {
  const inputs: AutoDevEventInput[] = [
    ev({ eventType: "RUN_STARTED", runId: "run-secblock" }),
    ev({ eventType: "TASK_STARTED", runId: "run-secblock", taskId: "T1" }),
    ev({ eventType: "SECURITY_BLOCKED", runId: "run-secblock", taskId: "T1", humanInterventionRequired: true }),
    ev({ eventType: "RUN_BLOCKED", runId: "run-secblock", taskId: "T1" }),
  ];
  const { result } = buildStore(inputs);
  check("security block: task.securityBlocked=true", aggregateTaskMetrics(result, "run-secblock", "T1").securityBlocked === true);
  check("security block: quality.securityBlockCount=1", aggregateQualityMetrics(result, "run-secblock").securityBlockCount === 1);
}

// ---------------------------------------------------------------------------
// 9) human intervention — humanInterventionRequired가 기록된 event가 있으면 RunMetrics에
//    반영되고, 없으면 false로 남는다.
// ---------------------------------------------------------------------------
function scenarioHumanIntervention(): void {
  const withIntervention: AutoDevEventInput[] = [
    ev({ eventType: "RUN_STARTED", runId: "run-hi" }),
    ev({ eventType: "HUMAN_APPROVAL_REQUIRED", runId: "run-hi", humanInterventionRequired: true }),
    ev({ eventType: "RUN_BLOCKED", runId: "run-hi" }),
  ];
  const noIntervention: AutoDevEventInput[] = [
    ev({ eventType: "RUN_STARTED", runId: "run-no-hi" }),
    ev({ eventType: "RUN_COMPLETED", runId: "run-no-hi" }),
  ];
  check("human intervention: true로 집계됨", aggregateRunMetrics(buildStore(withIntervention).result, "run-hi").humanInterventionRequired === true);
  check("human intervention: 없으면 false", aggregateRunMetrics(buildStore(noIntervention).result, "run-no-hi").humanInterventionRequired === false);
}

// ---------------------------------------------------------------------------
// 10/11) token 값 제공 시 정확히 합산 / 미제공 시 undefined 유지.
// ---------------------------------------------------------------------------
function scenarioTokenUsage(): void {
  const inputs: AutoDevEventInput[] = [
    ev({ eventType: "RUN_STARTED", runId: "run-tokens" }),
    ev({ eventType: "AGENT_COMPLETED", runId: "run-tokens", agentId: "core-planner", tokenUsage: { inputTokens: 100, outputTokens: 40 }, model: { provider: "anthropic", name: "claude-x" } }),
    ev({ eventType: "AGENT_COMPLETED", runId: "run-tokens", agentId: "core-qa", tokenUsage: { inputTokens: 50, outputTokens: 10, totalTokens: 60 }, model: { provider: "anthropic", name: "claude-x" } }),
  ];
  const { result } = buildStore(inputs);
  const usage = aggregateUsageMetrics(result, "run-tokens");
  check("token 합산: inputTokens=150", usage.inputTokens === 150);
  check("token 합산: outputTokens=50", usage.outputTokens === 50);
  check("token 합산: totalTokens=60(하나만 제공됐으므로 그 값만)", usage.totalTokens === 60);
  check("token 합산: eventsWithTokenData=2", usage.eventsWithTokenData === 2);
  check("token 합산: model 목록에 중복 없이 1개", usage.models.length === 1 && usage.models[0].provider === "anthropic");

  const noTokenInputs: AutoDevEventInput[] = [ev({ eventType: "RUN_STARTED", runId: "run-no-tokens" }), ev({ eventType: "RUN_COMPLETED", runId: "run-no-tokens" })];
  const noTokenUsage = aggregateUsageMetrics(buildStore(noTokenInputs).result, "run-no-tokens");
  check("token 미제공: inputTokens/outputTokens/totalTokens 모두 undefined", noTokenUsage.inputTokens === undefined && noTokenUsage.outputTokens === undefined && noTokenUsage.totalTokens === undefined);
  check("token 미제공: eventsWithTokenData=0(0으로 임의 채우지 않고 근거를 남김)", noTokenUsage.eventsWithTokenData === 0);
  check("token 미제공: models가 빈 배열(임의 모델을 만들어내지 않음)", noTokenUsage.models.length === 0);
}

// ---------------------------------------------------------------------------
// 12) actual cost와 estimated cost 구분 — 절대 합산/혼합하지 않는다.
// ---------------------------------------------------------------------------
function scenarioActualVsEstimatedCost(): void {
  const inputs: AutoDevEventInput[] = [
    ev({ eventType: "RUN_STARTED", runId: "run-cost" }),
    ev({ eventType: "AGENT_COMPLETED", runId: "run-cost", agentId: "core-planner", tokenUsage: { actualCostUsd: 0.05 } }),
    ev({ eventType: "AGENT_COMPLETED", runId: "run-cost", agentId: "core-qa", tokenUsage: { estimatedCostUsd: 0.1 } }),
  ];
  const { result } = buildStore(inputs);
  const cost = aggregateCostMetrics(result, "run-cost");
  check("cost 구분: actualCostUsd=0.05", cost.actualCostUsd === 0.05);
  check("cost 구분: estimatedCostUsd=0.1", cost.estimatedCostUsd === 0.1);
  check("cost 구분: 둘이 합산되지 않음(0.15가 아님)", cost.actualCostUsd !== 0.15 && cost.estimatedCostUsd !== 0.15);
  check("cost 구분: eventsWithActualCostData=1, eventsWithEstimatedCostData=1", cost.eventsWithActualCostData === 1 && cost.eventsWithEstimatedCostData === 1);

  const noCostInputs: AutoDevEventInput[] = [ev({ eventType: "RUN_STARTED", runId: "run-no-cost" })];
  const noCost = aggregateCostMetrics(buildStore(noCostInputs).result, "run-no-cost");
  check("cost 미제공: actualCostUsd/estimatedCostUsd 모두 undefined", noCost.actualCostUsd === undefined && noCost.estimatedCostUsd === undefined);
}

// ---------------------------------------------------------------------------
// 13) 서로 다른 runId 데이터 혼합 금지 — 같은 store에 run-A/run-B가 섞여 있어도 서로
//     새어들지 않는다.
// ---------------------------------------------------------------------------
function scenarioNoCrossRunMixing(): void {
  const inputs: AutoDevEventInput[] = [
    ev({ eventType: "RUN_STARTED", runId: "run-A" }),
    ev({ eventType: "TASK_STARTED", runId: "run-A", taskId: "TA" }),
    ev({ eventType: "AGENT_COMPLETED", runId: "run-A", agentId: "core-planner", taskId: "TA", tokenUsage: { inputTokens: 10 } }),
    ev({ eventType: "RUN_COMPLETED", runId: "run-A", taskId: "TA" }),
    ev({ eventType: "RUN_STARTED", runId: "run-B" }),
    ev({ eventType: "TASK_STARTED", runId: "run-B", taskId: "TB" }),
    ev({ eventType: "AGENT_COMPLETED", runId: "run-B", agentId: "core-security", taskId: "TB", tokenUsage: { inputTokens: 9999 } }),
    ev({ eventType: "RUN_BLOCKED", runId: "run-B", taskId: "TB" }),
  ];
  const { result } = buildStore(inputs);

  const runA = aggregateRunMetrics(result, "run-A");
  check("혼합 금지: run-A taskIds에 TB가 없음", !runA.taskIds.includes("TB"));
  check("혼합 금지: run-A는 RUN_COMPLETED(run-B의 RUN_BLOCKED에 영향받지 않음)", runA.terminalStatus === "RUN_COMPLETED");

  const usageA = aggregateUsageMetrics(result, "run-A");
  check("혼합 금지: run-A의 inputTokens=10(run-B의 9999가 섞이지 않음)", usageA.inputTokens === 10);

  const agentsB = aggregateAgentMetrics(result, "run-B");
  check("혼합 금지: run-B agent 목록에 run-A의 core-planner가 없음", !agentsB.some((a) => a.agentId === "core-planner"));
}

// ---------------------------------------------------------------------------
// 14) DEGRADED Audit → metrics integrity도 DEGRADED로 전파된다(완전한 정상 통계처럼
//     보이지 않는다).
// ---------------------------------------------------------------------------
function scenarioDegradedIntegrityPropagates(): void {
  const dir = makeTempDir();
  const filePath = join(dir, "events.jsonl");
  writeFileSync(filePath, "", "utf-8");
  const store = createFileEventStore(filePath);
  store.append({ eventType: "RUN_STARTED", runId: "run-degraded" });
  store.append({ eventType: "TASK_STARTED", runId: "run-degraded", taskId: "T1" });
  appendFileSync(filePath, "NOT_VALID_JSON\n", "utf-8");
  store.append({ eventType: "RUN_COMPLETED", runId: "run-degraded", taskId: "T1" });

  const result = store.query({ runId: "run-degraded" });
  check("DEGRADED 전파: query() 자체가 integrityIssues를 보고함", result.integrityIssues.length > 0);

  const run = aggregateRunMetrics(result, "run-degraded");
  check("DEGRADED 전파: RunMetrics.integrity=DEGRADED", run.integrity === "DEGRADED");
  check("DEGRADED 전파: RunMetrics.integrityNote가 채워짐(누락 가능성 명시)", typeof run.integrityNote === "string" && run.integrityNote.length > 0);

  const task = aggregateTaskMetrics(result, "run-degraded", "T1");
  check("DEGRADED 전파: TaskMetrics.integrity=DEGRADED", task.integrity === "DEGRADED");

  const quality = aggregateQualityMetrics(result, "run-degraded");
  check("DEGRADED 전파: QualityMetrics.integrity=DEGRADED", quality.integrity === "DEGRADED");

  const usage = aggregateUsageMetrics(result, "run-degraded");
  check("DEGRADED 전파: UsageMetrics.integrity=DEGRADED", usage.integrity === "DEGRADED");

  const cost = aggregateCostMetrics(result, "run-degraded");
  check("DEGRADED 전파: CostMetrics.integrity=DEGRADED", cost.integrity === "DEGRADED");

  const agents = aggregateAgentMetrics(result, "run-degraded");
  check("DEGRADED 전파: agent가 0개여도(§ 시나리오와 무관) 함수 자체는 정상 동작함", Array.isArray(agents));

  // CLEAN 대조군 — 손상이 없으면 integrityNote 자체가 생기지 않는다.
  const cleanResult = buildStore([ev({ eventType: "RUN_STARTED", runId: "run-clean-2" })]).result;
  const cleanRun = aggregateRunMetrics(cleanResult, "run-clean-2");
  check("CLEAN 대조군: integrity=CLEAN, integrityNote 없음", cleanRun.integrity === "CLEAN" && cleanRun.integrityNote === undefined);
}

// ---------------------------------------------------------------------------
// 15) secret/raw text 비노출 — reason에 담긴 secret-like 값(이미 redact됨)이나 raw 텍스트
//     필드 자체가 Metrics 결과 어디에도 나타나지 않는다.
// ---------------------------------------------------------------------------
function scenarioNoSecretOrRawTextExposure(): void {
  const inputs: AutoDevEventInput[] = [
    ev({ eventType: "RUN_STARTED", runId: "run-secret" }),
    ev({ eventType: "TASK_STARTED", runId: "run-secret", taskId: "T1" }),
    ev({
      eventType: "SECURITY_BLOCKED",
      runId: "run-secret",
      taskId: "T1",
      reason: 'ANTHROPIC_API_KEY="sk-ant-verysecretvalue1234567890" 노출 발견',
      metadata: { note: "token=sk-ant-zzzzzzzzzzzzzzzzzzzzzzzzz" },
    }),
    ev({ eventType: "RUN_BLOCKED", runId: "run-secret", taskId: "T1" }),
  ];
  const { result } = buildStore(inputs);

  const run = aggregateRunMetrics(result, "run-secret");
  const task = aggregateTaskMetrics(result, "run-secret", "T1");
  const quality = aggregateQualityMetrics(result, "run-secret");
  const agents = aggregateAgentMetrics(result, "run-secret");
  const usage = aggregateUsageMetrics(result, "run-secret");
  const cost = aggregateCostMetrics(result, "run-secret");
  const combined = JSON.stringify({ run, task, quality, agents, usage, cost });

  check("secret 비노출: 원본 secret 값이 어떤 결과에도 없음", !combined.includes("verysecretvalue1234567890") && !combined.includes("zzzzzzzzzzzzzzzzzzzzzzzzz"));
  check("secret 비노출: reason 필드 자체가 결과 타입에 없음(구조적으로 옮겨 담지 않음)", !("reason" in run) && !("reason" in task));
  check("secret 비노출: metadata 필드 자체가 결과 타입에 없음", !("metadata" in run) && !("metadata" in task));
}

// ---------------------------------------------------------------------------
// Claude 구독/Context 확장 seam — 값이 실제 입력되지 않으면 생성하지 않는다.
// ---------------------------------------------------------------------------
function scenarioClaudeUsageSnapshotSeam(): void {
  check("usage snapshot: 입력이 없으면 undefined", describeClaudeUsageSnapshot(undefined) === undefined);
  check("usage snapshot: 모든 필드가 undefined인 입력도 undefined로 취급됨(빈 snapshot을 만들지 않음)", describeClaudeUsageSnapshot({}) === undefined);

  const provided = describeClaudeUsageSnapshot({ fiveHourUsagePercent: 42, resetTime: "2026-08-22T10:00:00.000Z" });
  check("usage snapshot: 실제로 제공된 필드만 그대로 담김", provided?.fiveHourUsagePercent === 42 && provided?.resetTime === "2026-08-22T10:00:00.000Z");
  check("usage snapshot: 제공하지 않은 필드(sevenDayUsagePercent 등)는 추정하지 않고 undefined", provided?.sevenDayUsagePercent === undefined);
}

async function main(): Promise<void> {
  try {
    scenarioCleanRunMetrics();
    scenarioZeroAgentPlainTask();
    scenarioAgentRoleCallCounts();
    scenarioFirstPassApproved();
    scenarioReviseCycleCounts();
    scenarioReviewCycleExhausted();
    scenarioTestPassFail();
    scenarioSecurityBlockCount();
    scenarioHumanIntervention();
    scenarioTokenUsage();
    scenarioActualVsEstimatedCost();
    scenarioNoCrossRunMixing();
    scenarioDegradedIntegrityPropagates();
    scenarioNoSecretOrRawTextExposure();
    scenarioClaudeUsageSnapshotSeam();
    // aggregateAllTaskMetrics는 여러 시나리오에서 간접 검증됐지만(quality가 내부적으로
    // 재사용), 직접 export도 정상 동작하는지 별도로 확인한다.
    const direct = aggregateAllTaskMetrics(buildStore([ev({ eventType: "RUN_STARTED", runId: "run-direct" }), ev({ eventType: "TASK_STARTED", runId: "run-direct", taskId: "T1" })]).result, "run-direct");
    check("aggregateAllTaskMetrics: taskId 1개를 그대로 반환", direct.length === 1 && direct[0].taskId === "T1" && direct[0].outcome === "UNKNOWN");
  } finally {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // 정리 실패는 테스트 결과에 영향 없음(OS 임시 디렉터리).
      }
    }
  }

  console.log("\n=== metrics(G3) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
