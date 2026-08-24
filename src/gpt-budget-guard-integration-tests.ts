import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewClaudeResultOnce, reviewClaudeResultWithRetry, reviewClaudeResult as realReviewClaudeResult, buildGptReviewLedgerEntryInput } from "./gpt-reviewer";
import type { GptReviewApiResult, ReviewProjectContext } from "./gpt-reviewer";
import { openAIReviewProvider, OPENAI_REVIEW_PROVIDER_ID } from "./openai-review-provider";
import type { ProviderSecurityMetadata } from "./provider-security-gate";
import { runOrchestrator } from "./orchestrator";
import { DEFAULT_STATE_PATH } from "./state";
import { executeRoutingPlan } from "./agent-orchestrator";
import type { AgentOrchestratorDeps, DeveloperAgentRunner, AgentExecutionInput } from "./agent-orchestrator";
import { routeTask, CORE_AGENT_REGISTRY } from "./agent-registry";
import type { RoutableTaskInput } from "./agent-registry";
import type { ClaudeResult } from "./types";
import type { DeveloperResult } from "./claude-developer";
import { createInMemoryUsageLedger } from "./usage-ledger";

// GPT Reviewer API Budget Guard(SI-3.8A) — 통합(wiring) 테스트.
//
// 이 파일이 실제로 증명하는 것: reviewClaudeResultOnce()가 (guard가 BLOCK인 입력에서는)
// OpenAI 클라이언트를 생성/호출하는 코드 경로에 아예 진입하지 않는다는 것을, "guard를 통과한
// 입력에서는 그 경로에 진입해 실패한다"는 대조군과 비교해서 증명한다. 실제 네트워크 호출을
// 절대 만들지 않기 위해 process.env.OPENAI_API_KEY를 이 프로세스 안에서만 일시적으로
// 제거한다 — OpenAI SDK는 apiKey를 해석할 수 없으면 어떤 HTTP 요청도 시도하기 전에 클라이언트
// 생성자에서 동기적으로 throw한다(node_modules/openai/core/client.js 확인: "Missing
// credentials..." — APIError 계열이 아닌 순수 OpenAIError이므로 gpt-reviewer.ts의
// classifyApiError()가 이를 API_ERROR로 분류한다). 즉:
//   - guard가 BLOCK이면: errorCode는 항상 BUDGET_EXCEEDED(클라이언트 생성 자체가 없었음).
//   - guard가 ALLOW면: 클라이언트 생성 시도가 실제로 일어나 API_ERROR로 실패한다(이 실패는
//     guard와 무관하게 이 테스트 프로세스에 유효한 API 키가 없기 때문일 뿐이며, 실제
//     네트워크 요청은 결코 나가지 않는다).
// 이 대비가 "BLOCK 시 OpenAI attempt 함수가 0회 호출됨"을 네트워크 없이 결정적으로 증명한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const HUGE_TASK = "A".repeat(400_000); // 기본 char 상한(200_000자)을 여유 있게 넘기는 결정적 크기.
const SMALL_TASK = "작은 review 대상 task";

const FAKE_CLAUDE_RESULT: ClaudeResult = {
  success: true,
  summary: "테스트: budget guard 통합 검증용",
  changedFiles: [],
  tests: [{ name: "unit-1", pass: true }],
  rawOutput: "",
};

// ---------------------------------------------------------------------------
// A) reviewClaudeResultOnce 직접 호출 — BLOCK vs ALLOW 대조.
// ---------------------------------------------------------------------------
// Phase SI-3.8E Security Ordering Correction — Provider Security Gate가 Budget Guard 통과
// 이후 항상 실행되므로(§ gpt-reviewer.ts), SMALL_TASK 대조군도 이제 기본 registry(ZDR 미검증,
// CONFIDENTIAL 기본 등급)에서는 Security Gate가 먼저 BLOCK한다 — Budget Guard 통과 이후에도
// "실제 client 생성을 시도하다 API_ERROR로 실패"하는 이 대조군 자체를 계속 증명하려면 Security
// Gate를 통과하는 compliant registry를 명시적으로 주입해야 한다(이 값 자체가 production
// 기본값을 바꾸지 않는다 — 이 테스트 파일 안에서만 쓰이는 override).
const COMPLIANT_OPENAI_SECURITY_OVERRIDES = {
  registry: {
    [OPENAI_REVIEW_PROVIDER_ID]: {
      providerId: OPENAI_REVIEW_PROVIDER_ID,
      trainingPolicy: "no-training",
      retentionPolicy: "zero",
      supportsZeroDataRetention: true,
      trustLevel: "high",
      allowedDataClassifications: ["CONFIDENTIAL"],
      policyVerifiedAt: "2026-08-25T00:00:00.000Z",
    } as ProviderSecurityMetadata,
  },
};

async function scenarioA_directGuardBlocksBeforeClient(): Promise<void> {
  const blocked = await reviewClaudeResultOnce(FAKE_CLAUDE_RESULT, 1, HUGE_TASK);
  check("A) 거대 payload는 즉시 BUDGET_EXCEEDED로 반환됨(OpenAI 클라이언트 생성 없음)", blocked.errorCode === "BUDGET_EXCEEDED");
  check("A) BLOCK 결과의 decision=HUMAN_REQUIRED", blocked.decision === "HUMAN_REQUIRED");
  check("A) BLOCK 결과의 transient=false(재시도 대상 아님)", blocked.transient === false);
  check("A) BLOCK 결과에 model/tokenUsage가 없음(API 응답을 받은 적이 없음)", blocked.model === undefined && blocked.tokenUsage === undefined);

  const allowed = await reviewClaudeResultOnce(
    FAKE_CLAUDE_RESULT,
    1,
    SMALL_TASK,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    openAIReviewProvider,
    COMPLIANT_OPENAI_SECURITY_OVERRIDES
  );
  check(
    "A) 작은 payload는 guard를 통과해 실제로 클라이언트 생성을 시도하다 API_ERROR로 실패함(대조군 — 유효한 키가 없을 뿐 guard 때문이 아님)",
    allowed.errorCode === "API_ERROR"
  );
  check("A) 대조군 결과는 BUDGET_EXCEEDED가 아님(guard가 관여하지 않았음을 확인)", allowed.errorCode !== "BUDGET_EXCEEDED");

  // Phase SI-3.8B(Claude code-review 지적 반영) — 이 API_ERROR는 클라이언트 생성 자체가
  // 실패한 것(실제 네트워크 요청 0회)이지, 실제로 전송된 요청이 실패한 것이 아니다.
  // requestAttempted=false로 명확히 구분되고, Usage Ledger 매핑도 이를 requestCount=0으로
  // 반영해야 한다(전송되지 않은 요청을 "실제 API 사용량"으로 오기록하지 않는다).
  check("A) 클라이언트 생성 실패는 requestAttempted=false로 표시됨(실제 요청 미전송)", allowed.requestAttempted === false);
  const ledgerInputForPreflightFailure = buildGptReviewLedgerEntryInput(allowed, { projectId: "p", taskId: "t" });
  check("A) 그 결과를 Ledger에 매핑하면 requestCount=0(API_ERROR라도 실제 사용량으로 기록되지 않음)", ledgerInputForPreflightFailure.requestCount === 0);
}

// ---------------------------------------------------------------------------
// B) 재시도 wrapper가 BLOCK을 transport failure로 오인해 재시도하지 않음.
// ---------------------------------------------------------------------------
async function scenarioB_retryWrapperDoesNotRetryOnBlock(): Promise<void> {
  let attemptCalls = 0;
  let sleepCalls = 0;
  const countedAttempt = async (
    result: ClaudeResult,
    reviewCycle: number,
    task?: string,
    allowedPathPrefixes?: string[],
    projectContext?: Parameters<typeof reviewClaudeResultOnce>[4],
    executor?: Parameters<typeof reviewClaudeResultOnce>[5]
  ): Promise<GptReviewApiResult> => {
    attemptCalls += 1;
    return reviewClaudeResultOnce(result, reviewCycle, task, allowedPathPrefixes, projectContext, executor);
  };

  const retryResult = await reviewClaudeResultWithRetry(FAKE_CLAUDE_RESULT, 1, HUGE_TASK, {
    deps: { attempt: countedAttempt, sleep: async () => { sleepCalls += 1; } },
  });

  check("B) attempt는 정확히 1회만 호출됨(재시도 없음)", attemptCalls === 1);
  check("B) sleep은 0회(대기 없이 즉시 반환)", sleepCalls === 0);
  check("B) 최종 errorCode=BUDGET_EXCEEDED", retryResult.errorCode === "BUDGET_EXCEEDED");
  check("B) gptTransportRetry=0", retryResult.gptTransportRetry === 0);
}

// ---------------------------------------------------------------------------
// C) production orchestrator(runOrchestrator) — 실제 reviewer 경로를 그대로 통과시켜
//    WAITING_HUMAN + errorCode=BUDGET_EXCEEDED로 전환되는지, 그리고 orchestrator의 실제
//    gptCallCount/gptRawCallTotal 카운터가 Guard에 그대로 전달되는지 확인한다(§ 별도
//    WAITING_API_BUDGET enum 값을 두지 않기로 한 이유는 types.ts OrchestratorStatus 주석
//    참고 — run.ts/autodev.ts/dashboard-html.ts/live-snapshot.ts가 "WAITING_HUMAN" 문자열을
//    exact-match로 광범위하게 소비하고 있어 새 상태값은 그 소비처 전부를 고쳐야 하는
//    Core-wide 변경이 된다). claudeRunner만 fake로 주입한다(Budget Guard와 무관한 developer
//    실행 자체는 이 Task 범위 밖).
// ---------------------------------------------------------------------------
const tempDirs: string[] = [];
function makeTempStatePath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  const statePath = join(dir, "project-state.json");
  const initial = {
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "IDLE",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
    gitCheckpoint: "test",
    currentPhase: 0,
  };
  writeFileSync(statePath, JSON.stringify(initial, null, 2) + "\n", "utf-8");
  return statePath;
}

async function scenarioC_orchestratorEntersWaitingHumanWithBudgetReason(statePath: string): Promise<void> {
  let claudeCalls = 0;
  let capturedGptCallCount: number | undefined;
  let capturedGptRawCallTotal: number | undefined;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return FAKE_CLAUDE_RESULT;
  };
  const gptReviewer = async (
    result: ClaudeResult,
    reviewCycle: number,
    task: string,
    allowedPathPrefixes?: string[],
    projectContext?: ReviewProjectContext,
    gptCallCount?: number,
    gptRawCallTotal?: number
  ) => {
    capturedGptCallCount = gptCallCount;
    capturedGptRawCallTotal = gptRawCallTotal;
    return realReviewClaudeResult(result, reviewCycle, task, { allowedPathPrefixes, projectContext, gptCallCount, gptRawCallTotal });
  };

  // Phase SI-3.8B — Budget Guard가 BLOCK한 이 호출이 Usage Ledger에 "실제 API 사용량"으로
  // 잘못 기록되지 않는지(§ 요구사항 15)도 같은 시나리오에서 함께 확인한다.
  const ledger = createInMemoryUsageLedger();
  const { finalState } = await runOrchestrator(HUGE_TASK, { claudeRunner, gptReviewer, statePath, ledger, taskId: "T-budget", projectId: "budget-guard-fixture" });

  check("C) 최종 상태 WAITING_HUMAN(별도 enum 값 없이 기존 상태 재사용)", finalState.status === "WAITING_HUMAN");
  check("C) deferredHumanTasks에 BUDGET_EXCEEDED 기록됨", finalState.deferredHumanTasks.some((t) => t.startsWith("BUDGET_EXCEEDED")));
  check("C) lastGptDecision.errorCode === BUDGET_EXCEEDED", (finalState.lastGptDecision as GptReviewApiResult | null)?.errorCode === "BUDGET_EXCEEDED");
  check("C) Claude worker는 1회만 호출됨(재시도로 낭비되지 않음)", claudeCalls === 1);
  check("C) orchestrator의 실제 gptCallCount(1)이 Guard 관측값으로 전달됨", capturedGptCallCount === 1);
  check("C) orchestrator의 실제 gptRawCallTotal(0, 이번 호출 이전 누적)이 전달됨", capturedGptRawCallTotal === 0);

  const ledgerEntries = ledger.query({ projectId: "budget-guard-fixture" }).entries;
  check("C) Budget Guard BLOCK도 Ledger에 entry 1건은 남지만(관측 목적)", ledgerEntries.length === 1);
  check("C) 그 entry의 requestCount=0(실제 API 호출로 기록되지 않음)", ledgerEntries[0]?.requestCount === 0);
  check("C) 그 entry에 token/비용이 전혀 없음(실제 사용량으로 오기록되지 않음)", ledgerEntries[0]?.inputTokens === undefined && ledgerEntries[0]?.estimatedCostUsd === undefined && ledgerEntries[0]?.actualCostUsd === undefined);
  check("C) 그 entry의 status=BUDGET_EXCEEDED", ledgerEntries[0]?.status === "BUDGET_EXCEEDED");
}

// ---------------------------------------------------------------------------
// D) agent-orchestrator 경로 — 동일한 reviewer 함수를 그대로 재사용하므로 Guard를 우회할 수
//    없다. developer만 fake로 주입해 reviewer step까지 빠르게 도달한다.
// ---------------------------------------------------------------------------
function req(overrides: Partial<RoutableTaskInput> = {}): RoutableTaskInput {
  return { id: "budget-guard-task", description: "새 기능을 구현해줘", hasFixedRequiredTests: true, ...overrides };
}

async function scenarioD_agentOrchestratorCannotBypassGuard(): Promise<void> {
  let developerCalls = 0;
  const developerRunner: DeveloperAgentRunner = async (_task, attempt): Promise<DeveloperResult> => {
    developerCalls += 1;
    return {
      success: true,
      summary: "[FAKE] developer 완료",
      changedFiles: ["file.ts"],
      tests: [{ name: "unit-1", pass: true }],
      rawOutput: "raw",
    };
  };

  const ledger = createInMemoryUsageLedger();
  const deps: AgentOrchestratorDeps = { developerRunner, reviewerRunner: realReviewClaudeResult, ledger, projectId: "budget-guard-agent-orchestrator-fixture" };
  const plan = routeTask(req());
  const input: AgentExecutionInput = { taskId: "budget-guard-task", taskGoal: HUGE_TASK };

  const result = await executeRoutingPlan(plan, input, CORE_AGENT_REGISTRY, deps);

  check("D) developer는 정확히 1회만 호출됨(REVISE 루프로 오인해 반복 호출하지 않음)", developerCalls === 1);
  check("D) overallStatus=HUMAN_APPROVAL_REQUIRED(HUMAN_REQUIRED decision 매핑)", result.overallStatus === "HUMAN_APPROVAL_REQUIRED");
  const reviewerStep = result.stepResults.find((r) => r.role === "reviewer");
  check("D) reviewer step data.errorCode === BUDGET_EXCEEDED(동일 Guard가 그대로 적용됨)", (reviewerStep?.data as GptReviewApiResult | undefined)?.errorCode === "BUDGET_EXCEEDED");

  const ledgerEntries = ledger.query({ projectId: "budget-guard-agent-orchestrator-fixture" }).entries;
  check("D) agent-orchestrator 경로도 Budget Guard BLOCK을 requestCount=0으로 기록함(실제 사용량 아님)", ledgerEntries.length === 1 && ledgerEntries[0].requestCount === 0);
}

async function main(): Promise<void> {
  const originalApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  // 실제 project-state.json은 read-only 증거로만 쓴다 — gpt-retry-tests.ts와 동일한 격리
  // 원칙(§ development-operations.md).
  const realStateBefore = readFileSync(DEFAULT_STATE_PATH, "utf-8");

  try {
    await scenarioA_directGuardBlocksBeforeClient();
    await scenarioB_retryWrapperDoesNotRetryOnBlock();
    await scenarioC_orchestratorEntersWaitingHumanWithBudgetReason(makeTempStatePath("autodev-budget-guard-orchestrator-"));
    await scenarioD_agentOrchestratorCannotBypassGuard();
  } finally {
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 디렉터리 정리 실패는 테스트 결과에 영향 없음(OS temp는 결국 정리됨)
      }
    }
  }

  const realStateAfter = readFileSync(DEFAULT_STATE_PATH, "utf-8");
  check("project-state 격리: 실제 project-state.json이 테스트 실행 전후 완전히 동일함", realStateBefore === realStateAfter);

  console.log("\n=== GPT Budget Guard 통합 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
