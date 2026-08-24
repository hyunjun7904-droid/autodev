import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaudeJsonOutput } from "./claude-runner";
import type { RealClaudeResult } from "./claude-runner";
import { runDeveloperTaskViaSafeExecutor } from "./claude-developer";
import { reviewClaudeResultWithRetry } from "./gpt-reviewer";
import type { GptReviewApiResult, GptReviewRetryResult } from "./gpt-reviewer";
import { runOrchestrator } from "./orchestrator";
import type { GptReviewerReturn } from "./orchestrator";
import { runAutodevOnce } from "./autodev";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import type { ClaudeResult, ProjectState } from "./types";
import type { ReadOnlyAgentRunner, AgentOrchestratorDeps, DeveloperAgentRunner, AgentExecutionInput } from "./agent-orchestrator";
import { executeRoutingPlan } from "./agent-orchestrator";
import { routeTask, CORE_AGENT_REGISTRY } from "./agent-registry";
import type { RoutableTaskInput } from "./agent-registry";
import type { DeveloperResult } from "./claude-developer";
import { createInMemoryEventStore } from "./event-store";
import { aggregateUsageMetrics, aggregateCostMetrics } from "./metrics";
import { createInMemoryUsageLedger, aggregateUsageLedgerEntries } from "./usage-ledger";

// Phase G Task G3.1 — Production Usage & Model Telemetry Wiring 테스트. 실제 Claude/GPT
// 유료 API를 전혀 호출하지 않는다 — claude-runner의 parseClaudeJsonOutput은 순수 함수를
// 직접 검증하고, claude-developer/gpt-reviewer/orchestrator/autodev는 전부 fake/injected
// caller/attempt/runner로만 실행한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempStatePath(overrides: Partial<ProjectState> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-telemetry-tests-"));
  tempDirs.push(dir);
  const statePath = join(dir, "project-state.json");
  const initial: ProjectState = {
    currentPhase: 1,
    gitCheckpoint: "test",
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "IDLE",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
    ...overrides,
  } as ProjectState;
  writeFileSync(statePath, JSON.stringify(initial, null, 2) + "\n", "utf-8");
  return statePath;
}

// ===========================================================================
// A) claude-runner.ts — parseClaudeJsonOutput가 실제 CLI JSON 구조(modelUsage/usage/
//    duration_ms)만 읽고, 없으면 추정하지 않는지.
// ===========================================================================

function scenarioParseClaudeJsonOutputExtractsRealFields(): void {
  const raw = JSON.stringify({
    result: "구현 완료",
    modelUsage: { "claude-sonnet-5-20260101": { inputTokens: 1200, outputTokens: 340 } },
    usage: { input_tokens: 1200, output_tokens: 340 },
    duration_ms: 4820,
  });
  const parsed = parseClaudeJsonOutput(raw);
  check("parseClaudeJsonOutput: ok=true", parsed.ok === true);
  if (parsed.ok) {
    check("parseClaudeJsonOutput: model.name이 modelUsage의 유일한 key", parsed.model?.name === "claude-sonnet-5-20260101");
    check("parseClaudeJsonOutput: model.provider=anthropic", parsed.model?.provider === "anthropic");
    check("parseClaudeJsonOutput: tokenUsage.inputTokens=1200", parsed.tokenUsage?.inputTokens === 1200);
    check("parseClaudeJsonOutput: tokenUsage.outputTokens=340", parsed.tokenUsage?.outputTokens === 340);
    check("parseClaudeJsonOutput: durationMs=4820", parsed.durationMs === 4820);
  }
}

function scenarioParseClaudeJsonOutputUndefinedWhenAbsent(): void {
  const parsed = parseClaudeJsonOutput(JSON.stringify({ result: "구현 완료" }));
  check("parseClaudeJsonOutput(값 없음): ok=true", parsed.ok === true);
  if (parsed.ok) {
    check("parseClaudeJsonOutput(값 없음): model=undefined(추정하지 않음)", parsed.model === undefined);
    check("parseClaudeJsonOutput(값 없음): tokenUsage=undefined", parsed.tokenUsage === undefined);
    check("parseClaudeJsonOutput(값 없음): durationMs=undefined", parsed.durationMs === undefined);
  }
}

function scenarioParseClaudeJsonOutputMultipleModelsNoGuess(): void {
  const raw = JSON.stringify({
    result: "구현 완료",
    modelUsage: {
      "claude-sonnet-5-20260101": { inputTokens: 100, outputTokens: 50 },
      "claude-haiku-4-5-20251001": { inputTokens: 10, outputTokens: 5 },
    },
  });
  const parsed = parseClaudeJsonOutput(raw);
  check(
    "parseClaudeJsonOutput(model 2개): 하나를 대표로 추측하지 않고 model=undefined",
    parsed.ok === true && parsed.model === undefined
  );
}

// ===========================================================================
// B) claude-developer.ts — 한 developer attempt 안의 실제 성공 round 전체에 걸친
//    tokenUsage 합산/model 캡처.
// ===========================================================================

function makeRawResult(summary: string, extra: Partial<RealClaudeResult> = {}): RealClaudeResult {
  return { success: true, summary, changedFiles: [], tests: [], rawOutput: summary, ...extra };
}

async function scenarioDeveloperAccumulatesUsageAcrossRounds(): Promise<void> {
  const invalidJsonRound = "이건 JSON이 아닙니다 — 첫 라운드는 파싱 실패로 재시도됩니다.";
  const taskComplete = JSON.stringify({ type: "TASK_COMPLETE", summary: "완료", changedFiles: [], testsRequested: [] });
  let call = 0;
  const claudeCaller = async (): Promise<RealClaudeResult> => {
    call += 1;
    if (call === 1) {
      // round 1: 실제로 토큰을 소비했지만 프로토콜 JSON 파싱에는 실패한 라운드 — 그래도
      // 실제 호출이었으므로 tokenUsage는 반드시 합산 대상이다.
      return makeRawResult(invalidJsonRound, {
        model: { provider: "anthropic", name: "claude-sonnet-5-20260101" },
        tokenUsage: { inputTokens: 500, outputTokens: 100 },
      });
    }
    return makeRawResult(taskComplete, {
      model: { provider: "anthropic", name: "claude-sonnet-5-20260101" },
      tokenUsage: { inputTokens: 300, outputTokens: 220 },
    });
  };

  const result = await runDeveloperTaskViaSafeExecutor("usage 합산 테스트", 1, { claudeCaller });

  check("developer usage 합산: success=true", result.success === true);
  check("developer usage 합산: 실제 round가 2회 호출됨", call === 2);
  check("developer usage 합산: tokenUsage.inputTokens=800(500+300)", result.tokenUsage?.inputTokens === 800);
  check("developer usage 합산: tokenUsage.outputTokens=320(100+220)", result.tokenUsage?.outputTokens === 320);
  check("developer usage 합산: model이 관측된 값으로 채워짐", result.model?.name === "claude-sonnet-5-20260101");
}

async function scenarioDeveloperUsageUndefinedWhenRunnerProvidesNone(): Promise<void> {
  const taskComplete = JSON.stringify({ type: "TASK_COMPLETE", summary: "완료", changedFiles: [], testsRequested: [] });
  const claudeCaller = async (): Promise<RealClaudeResult> => makeRawResult(taskComplete);

  const result = await runDeveloperTaskViaSafeExecutor("usage 없음 테스트", 1, { claudeCaller });

  check("developer usage 없음: success=true", result.success === true);
  check("developer usage 없음: model=undefined(추정하지 않음)", result.model === undefined);
  check("developer usage 없음: tokenUsage=undefined", result.tokenUsage === undefined);
}

// ===========================================================================
// C) gpt-reviewer.ts 재시도 계층 — attempt()가 반환한 model/tokenUsage가 그대로 통과하고,
//    transient 오류 attempt의 usage와 섞이지 않는지.
// ===========================================================================

async function scenarioGptReviewPassesThroughUsage(): Promise<void> {
  const fakeResult: GptReviewApiResult = {
    decision: "PASS",
    severity: { critical: 0, high: 0, medium: 0 },
    feedback: "문제 없음",
    nextTask: null,
    model: { provider: "openai", name: "gpt-5.6-2026-02-01" },
    tokenUsage: { inputTokens: 900, outputTokens: 210, totalTokens: 1110 },
  };
  const result = await reviewClaudeResultWithRetry(
    { success: true, summary: "s", changedFiles: [], tests: [], rawOutput: "" },
    1,
    "task",
    { deps: { attempt: async () => fakeResult } }
  );
  check("gpt usage 통과: model이 그대로 전달됨", result.model?.name === "gpt-5.6-2026-02-01");
  check("gpt usage 통과: tokenUsage가 그대로 전달됨", result.tokenUsage?.inputTokens === 900 && result.tokenUsage?.outputTokens === 210 && result.tokenUsage?.totalTokens === 1110);
}

async function scenarioGptReviewUsageUndefinedWhenAbsent(): Promise<void> {
  const fakeResult: GptReviewApiResult = { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "문제 없음", nextTask: null };
  const result = await reviewClaudeResultWithRetry(
    { success: true, summary: "s", changedFiles: [], tests: [], rawOutput: "" },
    1,
    "task",
    { deps: { attempt: async () => fakeResult } }
  );
  check("gpt usage 없음: model=undefined", result.model === undefined);
  check("gpt usage 없음: tokenUsage=undefined", result.tokenUsage === undefined);
}

async function scenarioGptReviewTransientRetryDoesNotMergeUsage(): Promise<void> {
  let call = 0;
  const attempt = async (): Promise<GptReviewApiResult> => {
    call += 1;
    if (call === 1) {
      return { decision: "HUMAN_REQUIRED", severity: { critical: 0, high: 0, medium: 0 }, feedback: "일시 오류", nextTask: null, errorCode: "RATE_LIMIT", transient: true };
    }
    return {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      feedback: "재시도 후 통과",
      nextTask: null,
      model: { provider: "openai", name: "gpt-5.6-2026-02-01" },
      tokenUsage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
    };
  };
  const result = await reviewClaudeResultWithRetry(
    { success: true, summary: "s", changedFiles: [], tests: [], rawOutput: "" },
    1,
    "task",
    { deps: { attempt, sleep: async () => {} } }
  );
  check("gpt 일시 오류 재시도: 실제로 2회 호출됨", call === 2);
  check("gpt 일시 오류 재시도: 최종 usage는 성공한 두 번째 호출 값만(합산/중복 없음)", result.tokenUsage?.inputTokens === 50 && result.tokenUsage?.outputTokens === 20);
}

// ===========================================================================
// D) orchestrator.ts — REVISE 2회(reviewer 3호출) + developer 3호출 시나리오에서
//    canonical event 위치에만 usage가 기록되고, Metrics 합산이 정확히 1배인지.
// ===========================================================================

async function scenarioOrchestratorDoubleCountingAcrossReviseCycles(): Promise<void> {
  const statePath = makeTempStatePath();
  const events = createInMemoryEventStore();
  const runId = "run-double-count";

  const devUsage = [
    { inputTokens: 100, outputTokens: 10 },
    { inputTokens: 200, outputTokens: 20 },
    { inputTokens: 300, outputTokens: 30 },
  ];
  let devCall = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    const usage = devUsage[devCall];
    devCall += 1;
    return {
      success: true,
      summary: "구현 완료",
      changedFiles: [],
      tests: [{ name: "check", pass: true }],
      rawOutput: "RAW_DEVELOPER_OUTPUT_SHOULD_NOT_LEAK",
      model: { provider: "anthropic", name: "claude-sonnet-5-20260101" },
      tokenUsage: usage,
    };
  };

  const gptUsage = [
    { inputTokens: 1000, outputTokens: 100, totalTokens: 1100 },
    { inputTokens: 2000, outputTokens: 200, totalTokens: 2200 },
    { inputTokens: 3000, outputTokens: 300, totalTokens: 3300 },
  ];
  let gptCall = 0;
  const gptReviewer = async (): Promise<GptReviewerReturn> => {
    const usage = gptUsage[gptCall];
    const isLast = gptCall === 2;
    gptCall += 1;
    return {
      decision: isLast ? "PASS" : "REVISE",
      severity: { critical: 0, high: 0, medium: 0 },
      feedback: isLast ? "이제 문제 없음" : `REVISE ${gptCall}`,
      nextTask: null,
      model: { provider: "openai", name: "gpt-5.6-2026-02-01" },
      tokenUsage: usage,
    };
  };

  const { finalState } = await runOrchestrator("테스트 task", {
    statePath,
    claudeRunner,
    gptReviewer,
    events,
    runId,
    taskId: "T-double-count",
    projectId: "usage-telemetry-fixture",
  });

  check("double-count: 최종 status=APPROVED", finalState.status === "APPROVED");
  check("double-count: developer가 3회 호출됨", devCall === 3);
  check("double-count: reviewer가 3회 호출됨", gptCall === 3);

  const { events: all } = events.query({ runId });

  const testCompleted = all.filter((e) => e.eventType === "TEST_COMPLETED");
  check("double-count: TEST_COMPLETED가 3건(cycle마다 1건)", testCompleted.length === 3);
  check(
    "double-count: 각 TEST_COMPLETED의 tokenUsage가 해당 cycle의 실제 값과 정확히 일치(서로 섞이지 않음)",
    testCompleted[0].tokenUsage?.inputTokens === 100 && testCompleted[1].tokenUsage?.inputTokens === 200 && testCompleted[2].tokenUsage?.inputTokens === 300
  );

  const reviewStarted = all.filter((e) => e.eventType === "REVIEW_STARTED");
  check("double-count: REVIEW_STARTED(호출 전)에는 tokenUsage가 전혀 기록되지 않음", reviewStarted.every((e) => e.tokenUsage === undefined));

  const reviewRevise = all.filter((e) => e.eventType === "REVIEW_REVISE");
  check("double-count: REVIEW_REVISE가 정확히 2건", reviewRevise.length === 2);
  check(
    "double-count: REVIEW_REVISE 각각의 tokenUsage가 해당 GPT 호출과 정확히 일치",
    reviewRevise[0].tokenUsage?.inputTokens === 1000 && reviewRevise[1].tokenUsage?.inputTokens === 2000
  );

  const reviewApproved = all.find((e) => e.eventType === "REVIEW_APPROVED");
  check("double-count: REVIEW_APPROVED의 tokenUsage가 마지막 GPT 호출과 일치", reviewApproved?.tokenUsage?.inputTokens === 3000);

  const usageMetrics = aggregateUsageMetrics({ events: all, integrityIssues: [] }, runId);
  const expectedInput = devUsage.reduce((s, u) => s + u.inputTokens, 0) + gptUsage.reduce((s, u) => s + u.inputTokens, 0);
  const expectedOutput = devUsage.reduce((s, u) => s + u.outputTokens, 0) + gptUsage.reduce((s, u) => s + u.outputTokens, 0);
  check(
    `double-count: Metrics 합산이 정확히 1배(inputTokens=${expectedInput})`,
    usageMetrics.inputTokens === expectedInput && usageMetrics.outputTokens === expectedOutput
  );
  check("double-count: eventsWithTokenData=6(TEST_COMPLETED 3 + REVIEW_* 3, 중복 없음)", usageMetrics.eventsWithTokenData === 6);

  const costMetrics = aggregateCostMetrics({ events: all, integrityIssues: [] }, runId);
  check("actual cost 미제공: actualCostUsd=undefined(가격표 역산 없음)", costMetrics.actualCostUsd === undefined);
  check("estimated cost 미제공: estimatedCostUsd=undefined(이 Task 범위 밖)", costMetrics.estimatedCostUsd === undefined);

  const serialized = JSON.stringify(all);
  check("raw output 비노출: developer의 rawOutput 원문이 어떤 event에도 없음", !serialized.includes("RAW_DEVELOPER_OUTPUT_SHOULD_NOT_LEAK"));
}

// ===========================================================================
// D.1) Phase SI-3.8B — orchestrator.ts가 gpt-reviewer 호출 1건당 정확히 1개의 Usage Ledger
//      entry를 기록하는지(REVISE 반복에도 중복 없음), Budget Guard BLOCK과 정상 호출을
//      requestCount로 구분하는지.
// ===========================================================================

async function scenarioOrchestratorRecordsUsageLedgerEntries(): Promise<void> {
  const statePath = makeTempStatePath();
  const events = createInMemoryEventStore();
  const ledger = createInMemoryUsageLedger();
  const runId = "run-ledger";

  const claudeRunner = async (): Promise<ClaudeResult> => ({
    success: true,
    summary: "구현 완료",
    changedFiles: [],
    tests: [{ name: "check", pass: true }],
    rawOutput: "",
  });

  const gptUsage = [
    { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 100, totalTokens: 1100 },
    { inputTokens: 2000, outputTokens: 200, totalTokens: 2200 },
  ];
  let gptCall = 0;
  const gptReviewer = async (): Promise<GptReviewerReturn> => {
    const usage = gptUsage[gptCall];
    const isLast = gptCall === 1;
    gptCall += 1;
    return {
      decision: isLast ? "PASS" : "REVISE",
      severity: { critical: 0, high: 0, medium: 0 },
      feedback: isLast ? "이제 문제 없음" : "REVISE 1",
      nextTask: null,
      model: { provider: "openai", name: "gpt-5.6-2026-02-01" },
      tokenUsage: usage,
    };
  };

  const { finalState } = await runOrchestrator("Ledger 통합 테스트 task", {
    statePath,
    claudeRunner,
    gptReviewer,
    events,
    ledger,
    runId,
    taskId: "T-ledger",
    projectId: "usage-ledger-fixture",
  });

  check("Ledger 통합: 최종 status=APPROVED", finalState.status === "APPROVED");
  check("Ledger 통합: reviewer가 2회 호출됨(REVISE 1회 + PASS)", gptCall === 2);

  const ledgerEntries = ledger.query({ projectId: "usage-ledger-fixture" }).entries;
  check("Ledger 통합: gpt-reviewer 호출 1건당 정확히 1개의 entry(2건, 중복 없음)", ledgerEntries.length === 2);
  check("Ledger 통합: entry의 taskId/service/provider/operation이 정확함", ledgerEntries.every((e) => e.taskId === "T-ledger" && e.service === "gpt-reviewer" && e.provider === "openai" && e.operation === "gpt_review"));
  check("Ledger 통합: 각 entry의 requestCount=1(실제 성공 호출, 재시도 없음)", ledgerEntries.every((e) => e.requestCount === 1));
  check("Ledger 통합: 첫 entry(REVISE)의 cachedInputTokens가 정확히 기록됨", ledgerEntries[0].cachedInputTokens === 100);
  check("Ledger 통합: 두 번째 entry(PASS)의 inputTokens가 두 번째 호출 값과 일치", ledgerEntries[1].inputTokens === 2000);
  check("Ledger 통합: status가 각각 REVISE/PASS 여부와 무관하게 SUCCESS(실제 API 성공)", ledgerEntries.every((e) => e.status === "SUCCESS"));
  check("Ledger 통합: actualCostUsd는 어떤 entry에도 없음(임의 생성 금지)", ledgerEntries.every((e) => e.actualCostUsd === undefined));

  const agg = aggregateUsageLedgerEntries(ledgerEntries);
  check("Ledger 통합: 집계된 totalInputTokens=3000(1000+2000)", agg.totalInputTokens === 3000);
  check("Ledger 통합: unknownCostEntryCount=2(pricing catalog가 비어있어 전부 unknown)", agg.unknownCostEntryCount === 2);
}

// ===========================================================================
// D.2) Phase SI-3.8B — agent-orchestrator.ts의 reviewer step이 orchestrator.ts와 동일한
//      Usage Ledger 인터페이스를 재사용하는지(중복 구현 없이).
// ===========================================================================

function req(overrides: Partial<RoutableTaskInput> = {}): RoutableTaskInput {
  return { id: "ledger-agent-orchestrator-task", description: "새 기능을 구현해줘", hasFixedRequiredTests: true, ...overrides };
}

async function scenarioAgentOrchestratorReusesUsageLedger(): Promise<void> {
  const ledger = createInMemoryUsageLedger();
  const developerRunner: DeveloperAgentRunner = async (): Promise<DeveloperResult> => ({
    success: true,
    summary: "[FAKE] developer 완료",
    changedFiles: ["file.ts"],
    tests: [{ name: "unit-1", pass: true }],
    rawOutput: "raw",
  });
  const reviewerRunner = async (): Promise<GptReviewRetryResult> =>
    ({
      decision: "PASS" as const,
      severity: { critical: 0, high: 0, medium: 0 },
      feedback: "ok",
      nextTask: null,
      model: { provider: "openai", name: "gpt-5.6-2026-02-01" },
      tokenUsage: { inputTokens: 55, outputTokens: 11, totalTokens: 66 },
      gptTransportRetry: 0,
    });

  const deps: AgentOrchestratorDeps = { developerRunner, reviewerRunner, ledger, projectId: "agent-orchestrator-ledger-fixture" };
  const plan = routeTask(req());
  const input: AgentExecutionInput = { taskId: "ledger-agent-orchestrator-task", taskGoal: "기능 구현" };

  const result = await executeRoutingPlan(plan, input, CORE_AGENT_REGISTRY, deps);

  check("agent-orchestrator Ledger 재사용: overallStatus=COMPLETED", result.overallStatus === "COMPLETED");
  const entries = ledger.query({ projectId: "agent-orchestrator-ledger-fixture" }).entries;
  check("agent-orchestrator Ledger 재사용: reviewer 호출 1건이 동일 Ledger에 기록됨", entries.length === 1);
  check("agent-orchestrator Ledger 재사용: taskId/agentId가 정확히 채워짐", entries[0]?.taskId === "ledger-agent-orchestrator-task" && entries[0]?.agentId === "core-reviewer");
  check("agent-orchestrator Ledger 재사용: tokenUsage가 orchestrator.ts와 동일한 매핑 함수로 채워짐", entries[0]?.inputTokens === 55 && entries[0]?.outputTokens === 11);
}

// ===========================================================================
// E) 서로 다른 runId 혼합 없음 — 같은 in-memory store에 두 run을 기록해도 Metrics가 섞이지 않는다.
// ===========================================================================

async function scenarioDifferentRunIdsNotMixed(): Promise<void> {
  const events = createInMemoryEventStore();

  async function runOnce(runId: string, inputTokens: number): Promise<void> {
    const statePath = makeTempStatePath();
    const claudeRunner = async (): Promise<ClaudeResult> => ({
      success: true,
      summary: "완료",
      changedFiles: [],
      tests: [{ name: "check", pass: true }],
      rawOutput: "",
      model: { provider: "anthropic", name: "claude-sonnet-5-20260101" },
      tokenUsage: { inputTokens, outputTokens: 1 },
    });
    const gptReviewer = async (): Promise<GptReviewerReturn> => ({
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      feedback: "ok",
      nextTask: null,
    });
    await runOrchestrator("task", { statePath, claudeRunner, gptReviewer, events, runId, taskId: "T", projectId: "p" });
  }

  await runOnce("run-A", 111);
  await runOnce("run-B", 222);

  const { events: all } = events.query();
  const usageA = aggregateUsageMetrics({ events: all, integrityIssues: [] }, "run-A");
  const usageB = aggregateUsageMetrics({ events: all, integrityIssues: [] }, "run-B");

  check("runId 혼합 없음: run-A의 inputTokens=111(run-B와 섞이지 않음)", usageA.inputTokens === 111);
  check("runId 혼합 없음: run-B의 inputTokens=222(run-A와 섞이지 않음)", usageB.inputTokens === 222);
}

// ===========================================================================
// F) autodev.ts advisory agent — AGENT_COMPLETED에만 정확히 1회 usage가 기록되는지.
// ===========================================================================

const FIXTURE_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["proj/"],
  allowedWritePrefixes: ["proj/"],
  allowedCommands: [],
};

function makeTaskDef(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: "T1.1",
    phase: 1,
    taskNumber: 1,
    title: "G3.1 fixture task",
    prompt: "테스트 task",
    requiredTests: [],
    allowedPathPrefixes: ["proj/"],
    prohibitedOperations: [],
    ...overrides,
  };
}

function buildManifest(root: string, statePath: string, taskRegistry: TaskDefinition[]): ProjectManifest {
  return {
    projectId: "g3-1-fixture-project",
    projectName: "G3.1 Fixture Project",
    targetProjectRoot: root,
    statePath,
    taskRegistry,
    developerInstructions: "허용 범위: proj/**.",
    reviewInstructions: "proj/** 범위 밖 변경이 있으면 REVISE.",
    reviewScopeDirs: ["proj/"],
    executionPolicy: FIXTURE_EXECUTION_POLICY,
  };
}

function makeAdvisoryFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "usage-telemetry-advisory-"));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "usage-telemetry@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Usage Telemetry Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function makeAdvisoryFixtureStatePath(dir: string): string {
  const statePath = join(dir, ".autodev", "project-state.json");
  mkdirSync(join(dir, ".autodev"), { recursive: true });
  const state: ProjectState = {
    currentPhase: 1,
    gitCheckpoint: "test",
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "READY",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
  } as ProjectState;
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  return statePath;
}

async function scenarioAdvisoryAgentUsageRecordedExactlyOnce(): Promise<void> {
  const dir = makeAdvisoryFixtureRepo();
  const taskDef = makeTaskDef({ needsSecurityReview: true, requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeAdvisoryFixtureStatePath(dir);
  const manifest = buildManifest(dir, statePath, [taskDef]);

  let devWriteCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    devWriteCalls += 1;
    mkdirSync(join(dir, "proj"), { recursive: true });
    writeFileSync(join(dir, "proj", "marker.txt"), `attempt ${devWriteCalls}\n`, "utf-8");
    return { success: true, summary: "구현 완료", changedFiles: ["proj/marker.txt"], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };
  const gptReviewer = async (): Promise<GptReviewerReturn> => ({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "ok", nextTask: null });
  const advisoryReadOnlyRunner: ReadOnlyAgentRunner = async () => ({
    success: true,
    summary: "[FAKE] 보안 검토 완료",
    rawOutput: "RAW_ADVISORY_OUTPUT_SHOULD_NOT_LEAK",
    model: { provider: "anthropic", name: "claude-sonnet-5-20260101" },
    tokenUsage: { inputTokens: 77, outputTokens: 33 },
    durationMs: 1234,
  });
  const events = createInMemoryEventStore();

  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner, gptReviewer },
    advisoryReadOnlyRunner,
    events,
  });

  check("advisory usage: outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");

  const { events: all } = events.query();
  const agentCompleted = all.filter((e) => e.eventType === "AGENT_COMPLETED" && e.agentId === "core-security");
  const agentSelected = all.filter((e) => e.eventType === "AGENT_SELECTED" && e.agentId === "core-security");
  const agentStarted = all.filter((e) => e.eventType === "AGENT_STARTED" && e.agentId === "core-security");

  check("advisory usage: AGENT_COMPLETED가 정확히 1건", agentCompleted.length === 1);
  check("advisory usage: AGENT_COMPLETED에 tokenUsage/model/durationMs가 정확히 기록됨", agentCompleted[0]?.tokenUsage?.inputTokens === 77 && agentCompleted[0]?.model?.name === "claude-sonnet-5-20260101" && agentCompleted[0]?.durationMs === 1234);
  check("advisory usage: AGENT_SELECTED에는 tokenUsage가 없음(호출 전)", agentSelected.every((e) => e.tokenUsage === undefined));
  check("advisory usage: AGENT_STARTED에는 tokenUsage가 없음(호출 전)", agentStarted.every((e) => e.tokenUsage === undefined));

  const serialized = JSON.stringify(all);
  check("advisory usage: raw rawOutput 원문이 어떤 event에도 없음", !serialized.includes("RAW_ADVISORY_OUTPUT_SHOULD_NOT_LEAK"));
}

async function main(): Promise<void> {
  try {
    scenarioParseClaudeJsonOutputExtractsRealFields();
    scenarioParseClaudeJsonOutputUndefinedWhenAbsent();
    scenarioParseClaudeJsonOutputMultipleModelsNoGuess();
    await scenarioDeveloperAccumulatesUsageAcrossRounds();
    await scenarioDeveloperUsageUndefinedWhenRunnerProvidesNone();
    await scenarioGptReviewPassesThroughUsage();
    await scenarioGptReviewUsageUndefinedWhenAbsent();
    await scenarioGptReviewTransientRetryDoesNotMergeUsage();
    await scenarioOrchestratorDoubleCountingAcrossReviseCycles();
    await scenarioOrchestratorRecordsUsageLedgerEntries();
    await scenarioAgentOrchestratorReusesUsageLedger();
    await scenarioDifferentRunIdsNotMixed();
    await scenarioAdvisoryAgentUsageRecordedExactlyOnce();
  } finally {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // 정리 실패는 테스트 결과에 영향 없음.
      }
    }
  }

  console.log("\n=== usage-telemetry(G3.1) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
