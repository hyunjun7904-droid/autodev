import {
  CORE_AGENT_REGISTRY,
} from "./agent-registry";
import type { AgentDefinition, AgentRegistry, AgentRole, RoutingPlan, RoutingStep } from "./agent-registry";
import { runDeveloperTaskViaSafeExecutor } from "./claude-developer";
import type { DeveloperResult, DeveloperTaskOptions } from "./claude-developer";
import { reviewClaudeResult as realReviewClaudeResult } from "./gpt-reviewer";
import type { GptReviewRetryResult, ReviewRetryOptions } from "./gpt-reviewer";
import { runClaudeTask as realReadOnlyClaudeCall } from "./claude-runner";
import { runClaudeTask as fakeClaudeTask } from "./fake-claude-runner";
import { reviewClaudeResult as fakeReviewClaudeResult } from "./fake-gpt-reviewer";
import type { ClaudeResult } from "./types";
import { discoverCapability } from "./discovery-orchestrator";
import type { CapabilityDiscoveryResult, DiscoverCapabilityOptions, SourceCatalog } from "./discovery-orchestrator";
import type { CapabilityRequirement } from "./capability-resolver";
import { MAX_REVIEW_CYCLES } from "./policy";
import { applyReviewDecisionPolicy, hasFailedRequiredTest, REVIEW_CYCLE_EXHAUSTED_REASON } from "./review-policy";

// Agent Execution Orchestration — Phase F Task F2.
//
// F1의 routeTask()가 만든 RoutingPlan을 실제로 실행한다: step dependency 확인 → 필요한
// Agent만 실행 → 결과를 구조화해 다음 step으로 전달 → 최종 실행 결과 반환. 이번 Task는
// Agent 간 자유대화/복잡한 병렬실행을 구현하지 않는다 — executeRoutingPlan()은 각
// RoutingStep을 dependency 순서대로 정확히 한 번만 방문한다(F1의 routing-level dedup은
// 그대로 유지된다).
//
// Phase F Task F3 — reviewer RoutingStep을 "방문"하는 것은 여전히 1회이지만, 그 안에서
// developer↔reviewer REVISE handoff loop(§ executeReviewerStepWithRevise)를 수행한다:
// reviewer가 REVISE를 반환하면 그 구체적 지적사항 + 관련 변경 파일 + 실패한 required
// test만으로 developer를 다시 부르고(§ buildReviseDeveloperTask, 과거 전체 대화나
// 프로젝트 전체를 다시 담지 않음), required test를 재실행한 뒤 reviewer를 재실행한다 —
// 이 재호출은 developer/reviewer가 RoutingStep으로 두 번 등장하는 것이 아니라, reviewer
// RoutingStep 하나를 처리하는 도중의 내부 동작이다("동일 agent 중복 호출 방지"는 routing
// 레벨 dedup을 말하는 것이지, 정당한 REVISE 재작업까지 막는 것이 아니다). 이 loop는
// orchestrator.ts의 runOrchestrator()가 이미 실제 운용에서 쓰는 것과 동일한 policy.ts의
// MAX_REVIEW_CYCLES 상한을 그대로 import해서 재사용하며(값을 다시 정의하지 않음), Claude
// 재개(continuation)는 claude-developer.ts가 이미 가진 allowedPathPrefixes 기반 "재개
// 감지" 구조(§ input.developerOptions.allowedPathPrefixes를 매 cycle 그대로 전달)를
// 그대로 재사용한다 — 새 continuation 메커니즘을 만들지 않는다.
//
// Phase F Task F4 — GPT 판정에 대한 안전장치 override(critical/high가 있는데 PASS→REVISE
// 강제, required test 실패에도 PASS→REVISE 강제, scope 밖 변경→BLOCK 강제)는 이제
// review-policy.ts(applyReviewDecisionPolicy/hasFailedRequiredTest)의 단일 출처를 그대로
// 쓴다 — orchestrator.ts(production 실행경로)도 동일한 함수를 쓰므로, 두 실행경로의 판정이
// 서로 달라질 위험이 구조적으로 없다(이전에는 이 override 로직이 두 파일에 각각
// 인라인/미러링돼 있었다 — F4가 그 중복을 제거했다).
//
// 역할 연결(전부 기존 Core 실행 경로 재사용, 새 실행 인프라 없음):
//   - developer → claude-developer.ts의 runDeveloperTaskViaSafeExecutor(Safe Executor 프로토콜)
//   - reviewer  → gpt-reviewer.ts의 reviewClaudeResult(독립 리뷰)
//   - planner/research/qa/security(모두 F1 registry의 executionModel="claude-read-only")
//     → claude-runner.ts의 runClaudeTask(항상 --tools "", 파일/명령 접근 자체가 없는 순수
//       텍스트 호출)를 감싼 realReadOnlyAgentRunner
//   - research는 추가로 D1~D5 Capability Discovery(discovery-orchestrator.ts의
//     discoverCapability, LLM이 아닌 Core deterministic 호출)를 선택적으로 수행해 그
//     결과를 read-only 호출의 context에 포함시킬 수 있다.
//
// Safe Executor / Secret Scanner / Dependency Scanner / Git checkpoint / state
// persistence는 계속 Core deterministic service다 — 이 파일 어디에도 그것들을 대체하는
// 코드가 없다(developer의 파일 쓰기는 여전히 claude-developer.ts 내부에서만, commit은
// 이 orchestrator가 전혀 건드리지 않는다 — F2는 checkpoint를 호출하지 않는다).
//
// 실제 test PASS/FAIL 판정은 QA agent의 의견이 아니라 developer 실행 결과에 담긴
// DeveloperResult.tests(claude-developer.ts가 Safe Executor로 직접 실행해 얻은 실제
// exitCode 기반 결과)가 최종 판정한다 — computeOverallStatus()는 QA step의 data를 아예
// 읽지 않는다(§ 아래).

// =========================================================
// Context — 각 step에는 taskGoal + 그 role에 필요한 최소 context + 직전(dependsOn) step의
// summary만 전달한다. 프로젝트 전체나 이전 대화 전체를 모든 Agent에 반복 전달하지 않는다.
// =========================================================

export interface AgentExecutionContext {
  taskGoal: string;
  relevantContext?: string;
  priorResultsSummary?: string;
  relevantDiffOrTestSummary?: string;
}

function renderReadOnlyPrompt(agent: AgentDefinition, context: AgentExecutionContext): string {
  const parts = [`# Task 목표\n${context.taskGoal}`, `# Agent 역할\n${agent.role}(${agent.capabilities.join(", ")})`];
  if (context.relevantContext) parts.push(`# 관련 Context\n${context.relevantContext}`);
  if (context.priorResultsSummary) parts.push(`# 직전 Agent 결과\n${context.priorResultsSummary}`);
  if (context.relevantDiffOrTestSummary) parts.push(`# 관련 diff/test/조사 결과\n${context.relevantDiffOrTestSummary}`);
  return parts.join("\n\n");
}

// =========================================================
// Read-only Agent runner(planner/research/qa/security 공용) — F1 registry가 이 4개
// role에 동일한 executionModel("claude-read-only")을 부여했으므로 seam도 하나만 둔다.
// =========================================================

export type AgentPermissionKey = "canWriteCode" | "canUseNetwork" | "canRequestHumanApproval";

export interface ReadOnlyAgentOutcome {
  success: boolean;
  summary: string;
  rawOutput: string;
  /** 이 agent가 자신의 role 권한 밖 action(예: 코드 작성)이 필요하다고 스스로 보고했을
   *  때만 채워진다 — 실제로 그 action을 수행할 능력은 이 agent에게 구조적으로 없다(그런
   *  실행 경로 자체가 없다). orchestrator는 이 필드가 AgentDefinition의 권한과 맞지 않으면
   *  그 step을 BLOCKED로 판정한다. 실제 운용 기본 구현(realReadOnlyAgentRunner)은 현재 이
   *  필드를 채우지 않는다 — 자유 텍스트에서 "권한 밖 요청"을 안정적으로 파싱하는 것은 이
   *  Task 범위 밖이다(향후 Task에서 다룬다). 테스트는 fake runner로 이 필드를 직접 채워
   *  enforcement 로직 자체를 검증한다. */
  requestedPermission?: AgentPermissionKey;
  /** Phase G Task G3.1 — 실제 Claude CLI JSON 출력이 제공한 경우만(§ claude-runner.ts
   *  parseClaudeJsonOutput). 이 agent 호출(1회) 1건에 대해서만 채워진다. */
  model?: { provider: string; name: string };
  tokenUsage?: { inputTokens?: number; outputTokens?: number };
  durationMs?: number;
}

export type ReadOnlyAgentRunner = (prompt: string, attempt: number) => Promise<ReadOnlyAgentOutcome>;

/** 실제 운용 기본 구현 — claude-runner.ts의 runClaudeTask(항상 --tools "", 파일/명령
 *  실행 경로 자체가 없음)를 그대로 감싼다. 새 실행 인프라를 만들지 않는다. */
export const realReadOnlyAgentRunner: ReadOnlyAgentRunner = async (prompt, attempt) => {
  const result = await realReadOnlyClaudeCall(prompt, attempt);
  return {
    success: result.success,
    summary: result.summary,
    rawOutput: result.rawOutput,
    model: result.model,
    tokenUsage: result.tokenUsage,
    durationMs: result.durationMs,
  };
};

const fakeReadOnlyAgentRunner: ReadOnlyAgentRunner = async (prompt, attempt) => {
  const result = await fakeClaudeTask(prompt, attempt);
  return { success: result.success, summary: result.summary, rawOutput: result.rawOutput };
};

// developer/reviewer는 기존 함수 시그니처를 그대로 타입으로 재사용한다(새 타입을 만들지 않음).
export type DeveloperAgentRunner = typeof runDeveloperTaskViaSafeExecutor;
export type ReviewerAgentRunner = typeof realReviewClaudeResult;

// AUTOMATION_DRY_RUN 관례는 orchestrator.ts와 동일하다 — 값이 명시적으로 "false"일 때만
// 실제 유료 API를 호출하는 경로를 선택한다.
function selectDefaultDeveloperRunner(): DeveloperAgentRunner {
  if (process.env.AUTOMATION_DRY_RUN !== "false") {
    return async (task: string, attempt: number) => (await fakeClaudeTask(task, attempt)) as DeveloperResult;
  }
  return runDeveloperTaskViaSafeExecutor;
}
function selectDefaultReviewerRunner(): ReviewerAgentRunner {
  if (process.env.AUTOMATION_DRY_RUN !== "false") {
    return async (result: ClaudeResult, reviewCycle: number) => (await fakeReviewClaudeResult(result, reviewCycle)) as GptReviewRetryResult;
  }
  return realReviewClaudeResult;
}
function selectDefaultReadOnlyRunner(): ReadOnlyAgentRunner {
  return process.env.AUTOMATION_DRY_RUN !== "false" ? fakeReadOnlyAgentRunner : realReadOnlyAgentRunner;
}

// =========================================================
// Step 결과/오류 타입.
// =========================================================

export type AgentStepStatus = "SUCCESS" | "FAILED" | "BLOCKED" | "SKIPPED";

export interface AgentStepResult {
  agentId: string;
  role: AgentRole;
  status: AgentStepStatus;
  summary: string;
  /** role별 실제 구조화 결과(DeveloperResult/GptReviewRetryResult/ReadOnlyAgentOutcome 등) —
   *  다음 step의 context 구성과 최종 판정(computeOverallStatus)에 쓰인다. */
  data?: unknown;
  reason?: string;
}

export interface AgentExecutionInput {
  taskId: string;
  taskGoal: string;
  /** role별 최소 추가 context(자유 텍스트) — 지정하지 않은 role은 taskGoal만 받는다. */
  roleContext?: Partial<Record<AgentRole, string>>;
  developerOptions?: DeveloperTaskOptions;
  reviewerOptions?: ReviewRetryOptions;
  /** research가 실제로 D1~D5 Capability Discovery(Core deterministic, LLM 아님)를
   *  수행해야 할 때만 지정한다. */
  researchDiscovery?: { requirement: CapabilityRequirement; catalog: SourceCatalog; opts?: DiscoverCapabilityOptions };
}

export interface AgentOrchestratorDeps {
  developerRunner?: DeveloperAgentRunner;
  reviewerRunner?: ReviewerAgentRunner;
  readOnlyRunner?: ReadOnlyAgentRunner;
}

export type AgentExecutionOverallStatus = "COMPLETED" | "BLOCKED" | "HUMAN_APPROVAL_REQUIRED" | "FAILED";

export interface AgentExecutionResult {
  taskId: string;
  routingPlan: RoutingPlan;
  stepResults: AgentStepResult[];
  overallStatus: AgentExecutionOverallStatus;
  reason: string;
}

// =========================================================
// 개별 step 실행.
// =========================================================

function buildStepContext(step: RoutingStep, input: AgentExecutionInput, priorResults: AgentStepResult[]): AgentExecutionContext {
  const priorSummaries = step.dependsOn
    .map((depId) => priorResults.find((r) => r.agentId === depId))
    .filter((r): r is AgentStepResult => r !== undefined)
    .map((r) => `[${r.role}] ${r.summary}`);
  return {
    taskGoal: input.taskGoal,
    relevantContext: input.roleContext?.[step.role],
    priorResultsSummary: priorSummaries.length > 0 ? priorSummaries.join("\n") : undefined,
  };
}

function permissionGranted(agent: AgentDefinition, key: AgentPermissionKey): boolean {
  return agent[key] === true;
}

async function executeReadOnlyStep(
  agent: AgentDefinition,
  step: RoutingStep,
  context: AgentExecutionContext,
  runner: ReadOnlyAgentRunner
): Promise<AgentStepResult> {
  const prompt = renderReadOnlyPrompt(agent, context);
  const outcome = await runner(prompt, 1);
  if (outcome.requestedPermission && !permissionGranted(agent, outcome.requestedPermission)) {
    return {
      agentId: agent.id,
      role: step.role,
      status: "BLOCKED",
      summary: outcome.summary,
      reason: `agent(${agent.id})가 자신의 권한 밖(${outcome.requestedPermission}) action을 요청해 차단되었습니다.`,
    };
  }
  return {
    agentId: agent.id,
    role: step.role,
    status: outcome.success ? "SUCCESS" : "FAILED",
    summary: outcome.summary,
    data: outcome,
    reason: outcome.success ? undefined : "read-only agent 실행이 실패를 보고했습니다.",
  };
}

async function executeResearchStep(
  agent: AgentDefinition,
  step: RoutingStep,
  input: AgentExecutionInput,
  priorResults: AgentStepResult[],
  runner: ReadOnlyAgentRunner
): Promise<AgentStepResult> {
  let discovery: CapabilityDiscoveryResult | undefined;
  const context = buildStepContext(step, input, priorResults);
  if (input.researchDiscovery) {
    discovery = await discoverCapability(input.researchDiscovery.requirement, input.researchDiscovery.catalog, input.researchDiscovery.opts);
    context.relevantDiffOrTestSummary = `D1~D5 Capability Discovery 결과: status=${discovery.status} — ${discovery.reason}`;
  }
  const stepResult = await executeReadOnlyStep(agent, step, context, runner);
  if (discovery) stepResult.data = { readOnly: stepResult.data, discovery };
  return stepResult;
}

async function executeDeveloperStep(agent: AgentDefinition, input: AgentExecutionInput, runner: DeveloperAgentRunner): Promise<AgentStepResult> {
  const result = await runner(input.taskGoal, 1, input.developerOptions ?? {});
  return {
    agentId: agent.id,
    role: "developer",
    status: result.success ? "SUCCESS" : "FAILED",
    summary: result.summary,
    data: result,
    reason: result.success ? undefined : (result as DeveloperResult).errorCode,
  };
}

/** reviewer step의 data — GptReviewRetryResult에 REVISE loop 진행 정보만 덧붙인다. */
export interface ReviewerStepData extends GptReviewRetryResult {
  /** 이 판정에 도달하기까지 실제로 수행된 REVISE 재작업 횟수(첫 시도 제외). */
  reviseCycles: number;
  /**
   * MAX_REVIEW_CYCLES 도달로 decision이 여전히 REVISE인 채 자동 진행이 중단됐을 때만
   * true. 이 경우 사람이 "승인"한다고 해서 성공/완료로 전환되는 게 아니다 — critical/high나
   * 미해결 REVISE 상태가 그대로 남아있을 수 있으므로, 사람이 직접 코드를 다시 확인/개입해야
   * 한다는 뜻이다(§ computeOverallStatus가 이 플래그를 HUMAN_APPROVAL_REQUIRED가 아니라
   * BLOCKED + reason="REVIEW_CYCLE_EXHAUSTED"로 매핑하는 이유).
   */
  reviewCycleExhausted?: boolean;
}

/**
 * REVISE 발생 시 다음 developer 호출에 넘길 task 문자열을 구성한다. 원래 Task 목표 +
 * reviewer의 구체적 지적사항 + 관련 변경 파일 + 실패한 required test만 포함한다 — 과거
 * 대화 전체나 프로젝트 전체를 다시 담지 않는다(§ 토큰 효율 요구사항). 이 문자열이
 * claude-developer.ts의 transcript 시드(`# Task\n${task}`)가 되고, 같은 developerOptions
 * (특히 allowedPathPrefixes)를 그대로 유지해서 넘기면 그 파일이 이미 가진 "이전 시도의
 * in-scope 미완성 변경을 감지해 이어서 진행하라고 안내"하는 재개 구조가 자동으로 함께
 * 작동한다 — 여기서 새로 만들 필요가 없다.
 */
function buildReviseDeveloperTask(originalTaskGoal: string, reviewFeedback: string, developerResult: DeveloperResult): string {
  const failedTests = developerResult.tests.filter((t) => !t.pass).map((t) => t.name);
  const parts = [
    `# 원래 Task 목표\n${originalTaskGoal}`,
    `# Reviewer 지적사항(REVISE)\n${reviewFeedback}`,
    `# 관련 변경 파일\n${developerResult.changedFiles.length > 0 ? developerResult.changedFiles.join(", ") : "(없음)"}`,
  ];
  if (failedTests.length > 0) {
    parts.push(`# 실패한 required test\n${failedTests.join(", ")}`);
  }
  parts.push("이전 시도의 변경사항은 버리지 말고 위 지적사항을 반영해 이어서 수정하세요.");
  return parts.join("\n\n");
}

/**
 * reviewer RoutingStep을 실행한다. developer 결과가 없으면(선행 미실행) SKIPPED.
 * decision이 REVISE면(안전장치 override 포함) developer를 다시 불러 tests를 재실행하고
 * reviewer를 재실행한다 — MAX_REVIEW_CYCLES(policy.ts, orchestrator.ts와 동일한 값) 안에서만.
 *
 * 한도 도달 시(orchestrator.ts의 "REVISE 5회 도달 → WAITING_HUMAN"과 동일한 정책) 자동
 * 진행을 중단하고 reviewCycleExhausted=true를 남긴다. orchestrator.ts의 OrchestratorStatus
 * 는 WAITING_HUMAN 하나로 "고위험 사전 승인 대기"와 "자동 루프가 수렴하지 못해 멈춤"을
 * 모두 표현하지만(그 상태에서 자동으로 APPROVED로 되돌아가는 코드 경로 자체가 없음),
 * 이 파일의 AgentExecutionOverallStatus에서 HUMAN_APPROVAL_REQUIRED는 "승인하면 진행"
 * 이라는 의미로도 쓰이고 있어(§ plan.requiresHumanApproval 사전 게이트) 그대로 재사용하면
 * "사람이 승인만 하면 이 REVISE도 통과된 것으로 볼 수 있다"는 오해를 살 수 있다. 그래서
 * review cycle 소진은 HUMAN_APPROVAL_REQUIRED가 아니라 BLOCKED로 매핑하고(§
 * computeOverallStatus), reason을 REVIEW_CYCLE_EXHAUSTED로 명시해 "승인=완료"가 아님을
 * 분명히 한다 — critical/high나 미해결 REVISE 상태는 그대로 보존된다(강제로 PASS/COMPLETED
 * 로 재작성하지 않음).
 *
 * developer 재시도가 구조적으로 실패(success=false)하면 그 자리에서 멈추고 reviewer는
 * 다시 부르지 않는다(§ orchestrator.ts의 "claude 실패 시 GPT 리뷰 생략" 원칙과 동일).
 * 반환하는 developer step은 항상 "최신 시도"의 실제 결과를 담는다 — 호출부가 stepResults의
 * 기존 developer 항목을 이걸로 교체해야 최종 판정이 실제로 검증된 마지막 코드를 본다.
 */
async function executeReviewerStepWithRevise(
  agent: AgentDefinition,
  priorResults: AgentStepResult[],
  input: AgentExecutionInput,
  developerRunner: DeveloperAgentRunner,
  reviewerRunner: ReviewerAgentRunner
): Promise<{ reviewerStep: AgentStepResult; updatedDeveloperStep?: AgentStepResult }> {
  const developerStepResult = priorResults.find((r) => r.role === "developer");
  if (!developerStepResult || developerStepResult.status !== "SUCCESS") {
    return {
      reviewerStep: {
        agentId: agent.id,
        role: "reviewer",
        status: "SKIPPED",
        summary: "",
        reason: "reviewer는 developer 결과가 있어야 리뷰할 수 있습니다(선행 결과 없음).",
      },
    };
  }

  let developerData = developerStepResult.data as DeveloperResult;
  let latestDeveloperStep = developerStepResult;
  let cycle = 1;

  while (true) {
    const requiredTestsFailed = hasFailedRequiredTest(developerData.tests);
    const reviewResult = await reviewerRunner(developerData as ClaudeResult, cycle, input.taskGoal, input.reviewerOptions ?? {});
    const decision = applyReviewDecisionPolicy(reviewResult, requiredTestsFailed);
    const reviseCycles = cycle - 1;

    if (decision === "PASS" || decision === "BLOCK" || decision === "HUMAN_REQUIRED") {
      return {
        reviewerStep: {
          agentId: agent.id,
          role: "reviewer",
          status: "SUCCESS",
          summary: reviewResult.feedback,
          data: { ...reviewResult, decision, reviseCycles } as ReviewerStepData,
        },
        updatedDeveloperStep: reviseCycles > 0 ? latestDeveloperStep : undefined,
      };
    }

    // decision === "REVISE"
    if (cycle >= MAX_REVIEW_CYCLES) {
      return {
        reviewerStep: {
          agentId: agent.id,
          role: "reviewer",
          status: "SUCCESS",
          summary: reviewResult.feedback,
          data: { ...reviewResult, decision, reviseCycles, reviewCycleExhausted: true } as ReviewerStepData,
          reason: `${REVIEW_CYCLE_EXHAUSTED_REASON} — MAX_REVIEW_CYCLES(${MAX_REVIEW_CYCLES}) 도달로 자동 진행을 중단합니다(단순 승인으로 완료 처리할 수 없고, critical/high나 미해결 REVISE 상태가 남아있는 채로 사람이 직접 개입해야 합니다).`,
        },
        updatedDeveloperStep: reviseCycles > 0 ? latestDeveloperStep : undefined,
      };
    }

    const reviseTask = buildReviseDeveloperTask(input.taskGoal, reviewResult.feedback, developerData);
    cycle += 1;
    const nextDeveloperResult = await developerRunner(reviseTask, cycle, input.developerOptions ?? {});
    latestDeveloperStep = {
      agentId: latestDeveloperStep.agentId,
      role: "developer",
      status: nextDeveloperResult.success ? "SUCCESS" : "FAILED",
      summary: nextDeveloperResult.summary,
      data: nextDeveloperResult,
      reason: nextDeveloperResult.success ? undefined : nextDeveloperResult.errorCode,
    };
    if (!nextDeveloperResult.success) {
      return {
        reviewerStep: {
          agentId: agent.id,
          role: "reviewer",
          status: "SKIPPED",
          summary: "",
          reason: "developer REVISE 재시도가 실패해(success=false) 리뷰를 생략합니다.",
        },
        updatedDeveloperStep: latestDeveloperStep,
      };
    }
    developerData = nextDeveloperResult;
  }
}

// =========================================================
// 최종 판정 — QA/reviewer의 "의견"이 아니라 developer의 실제 DeveloperResult.tests(Safe
// Executor로 직접 실행한 exitCode 기반)가 test pass/fail을 결정한다. 이 함수는 QA step의
// data를 전혀 읽지 않는다(의도적).
// =========================================================

export function computeOverallStatus(stepResults: AgentStepResult[]): { status: AgentExecutionOverallStatus; reason: string } {
  if (stepResults.some((r) => r.status === "BLOCKED")) {
    const blocked = stepResults.filter((r) => r.status === "BLOCKED");
    return { status: "BLOCKED", reason: `agent permission 위반으로 차단됨: ${blocked.map((r) => r.reason).join("; ")}` };
  }

  const developerStep = stepResults.find((r) => r.role === "developer");
  if (developerStep) {
    if (developerStep.status !== "SUCCESS") {
      return { status: "FAILED", reason: `developer step 실패: ${developerStep.reason ?? developerStep.summary}` };
    }
    const developerData = developerStep.data as DeveloperResult;
    if (developerData.tests.length > 0 && !developerData.tests.every((t) => t.pass)) {
      const failedNames = developerData.tests.filter((t) => !t.pass).map((t) => t.name);
      return {
        status: "FAILED",
        reason: `deterministic required tests 실패(QA/reviewer 의견과 무관하게 최종 판정): ${failedNames.join(", ")}`,
      };
    }
  }

  const reviewerStep = stepResults.find((r) => r.role === "reviewer");
  if (reviewerStep) {
    if (reviewerStep.status !== "SUCCESS") {
      return { status: "FAILED", reason: `reviewer step 실패: ${reviewerStep.reason ?? reviewerStep.summary}` };
    }
    const reviewerData = reviewerStep.data as ReviewerStepData;
    if (reviewerData.decision === "BLOCK" || reviewerData.decision === "HUMAN_REQUIRED") {
      return { status: "HUMAN_APPROVAL_REQUIRED", reason: `reviewer decision=${reviewerData.decision}` };
    }
    // executeReviewerStepWithRevise()는 REVISE를 내부에서 MAX_REVIEW_CYCLES까지 자동으로
    // 재작업/재리뷰한다 — 여기 도달한 시점에 decision이 여전히 REVISE라면 그건 한도 도달로
    // 자동 진행이 중단된 경우뿐이다(§ reviewCycleExhausted). 이 경우 일부러
    // HUMAN_APPROVAL_REQUIRED(plan.requiresHumanApproval 사전 게이트와 같은 "승인하면
    // 진행"이라는 뜻으로도 쓰이는 상태)를 쓰지 않는다 — "review cycle을 다 썼는데도 REVISE
    // 상태(critical/high 또는 미해결 지적사항 포함)가 남아있다"는 사실을 "사람이 승인만
    // 하면 통과"로 오해할 수 있기 때문이다. BLOCKED + reason=REVIEW_CYCLE_EXHAUSTED로
    // 매핑해 승인만으로 완료/성공 전환될 수 없음을 명확히 한다.
    if (reviewerData.decision === "REVISE") {
      return {
        status: "BLOCKED",
        reason: reviewerData.reviewCycleExhausted
          ? `${REVIEW_CYCLE_EXHAUSTED_REASON}: REVISE가 MAX_REVIEW_CYCLES(${MAX_REVIEW_CYCLES})에 도달해 자동 진행을 중단합니다(critical=${reviewerData.severity.critical}, high=${reviewerData.severity.high} — 승인만으로 완료 처리 불가, 사람이 직접 개입해야 합니다).`
          : "reviewer decision=REVISE — 아직 해결되지 않은 REVISE 상태입니다.",
      };
    }
  }

  if (stepResults.some((r) => r.status === "FAILED" || r.status === "SKIPPED")) {
    const problems = stepResults.filter((r) => r.status === "FAILED" || r.status === "SKIPPED");
    return { status: "FAILED", reason: `하나 이상의 agent step이 실패했거나 선행 조건 미충족으로 건너뛰었습니다: ${problems.map((r) => `${r.role}(${r.status})`).join(", ")}` };
  }

  return { status: "COMPLETED", reason: "선택된 모든 agent step이 정상적으로 완료됐습니다." };
}

// =========================================================
// 실행 진입점 — F1의 RoutingPlan을 받아 실제로 실행한다.
// =========================================================

/**
 * RoutingPlan을 실행한다. 순서:
 *   1) plan.requiresHumanApproval===true면(F1이 policy.ts로 이미 판정) 어떤 step도 실행하지
 *      않고 즉시 HUMAN_APPROVAL_REQUIRED를 반환한다(기존 orchestrator.ts의 "고위험 작업은
 *      Claude worker 호출 전 즉시 중지" 게이트와 동일한 원칙 — LLM 호출 자체를 하지
 *      않는다).
 *   2) plan.steps는 이미 F1이 priority 순으로 deterministic하게 정렬해뒀다 — 그 순서
 *      그대로 순회한다.
 *   3) 각 step 실행 전 dependsOn이 전부 완료(completed) 상태인지 확인한다 — 하나라도
 *      미완료/실패면 이 step은 실행하지 않고 SKIPPED로 기록한다(선행 실패 전파).
 *   4) 이미 실행된 agentId는 다시 실행하지 않는다(동일 Agent 중복 호출 방지 — F1이 이미
 *      dedup하지만 방어적으로 한 번 더 확인한다).
 *   5) role에 따라 developer/reviewer/research/그 외(read-only 공용) 실행 함수로
 *      분기한다 — 각자 필요한 최소 context만 구성해서 전달한다(§ buildStepContext).
 *   6) 모든 step이 끝나면 computeOverallStatus()로 최종 판정한다 — deterministic
 *      required tests가 QA/reviewer 의견보다 우선한다.
 * 이 함수는 checkpoint/commit을 전혀 호출하지 않는다 — 그건 여전히 별도 Core service의
 * 몫이다.
 */
export async function executeRoutingPlan(
  plan: RoutingPlan,
  input: AgentExecutionInput,
  registry: AgentRegistry = CORE_AGENT_REGISTRY,
  deps: AgentOrchestratorDeps = {}
): Promise<AgentExecutionResult> {
  if (plan.requiresHumanApproval) {
    return {
      taskId: input.taskId,
      routingPlan: plan,
      stepResults: [],
      overallStatus: "HUMAN_APPROVAL_REQUIRED",
      reason: "F1 routeTask가 이미 고위험 작업으로 판정했습니다 — agent를 하나도 실행하지 않고 즉시 사람 승인 대기로 전환합니다.",
    };
  }

  const developerRunner = deps.developerRunner ?? selectDefaultDeveloperRunner();
  const reviewerRunner = deps.reviewerRunner ?? selectDefaultReviewerRunner();
  const readOnlyRunner = deps.readOnlyRunner ?? selectDefaultReadOnlyRunner();

  const completed = new Set<string>();
  const failedOrSkipped = new Set<string>();
  const calledAgentIds = new Set<string>();
  const stepResults: AgentStepResult[] = [];

  for (const step of plan.steps) {
    if (calledAgentIds.has(step.agentId)) continue;

    const unmet = step.dependsOn.filter((depId) => !completed.has(depId));
    if (unmet.length > 0) {
      const causedByFailure = step.dependsOn.some((depId) => failedOrSkipped.has(depId));
      stepResults.push({
        agentId: step.agentId,
        role: step.role,
        status: "SKIPPED",
        summary: "",
        reason: causedByFailure
          ? `선행 agent 실패/차단으로 건너뜀: ${unmet.join(", ")}`
          : `선행 agent가 아직 완료되지 않아 건너뜀: ${unmet.join(", ")}`,
      });
      calledAgentIds.add(step.agentId);
      failedOrSkipped.add(step.agentId);
      continue;
    }

    calledAgentIds.add(step.agentId);
    const agent = registry.find((a) => a.id === step.agentId);
    if (!agent) {
      stepResults.push({ agentId: step.agentId, role: step.role, status: "SKIPPED", summary: "", reason: "registry에서 agent를 찾을 수 없습니다." });
      failedOrSkipped.add(step.agentId);
      continue;
    }

    let stepResult: AgentStepResult;
    if (step.role === "developer") {
      stepResult = await executeDeveloperStep(agent, input, developerRunner);
    } else if (step.role === "reviewer") {
      const { reviewerStep, updatedDeveloperStep } = await executeReviewerStepWithRevise(agent, stepResults, input, developerRunner, reviewerRunner);
      if (updatedDeveloperStep) {
        const developerIdx = stepResults.findIndex((r) => r.role === "developer");
        if (developerIdx !== -1) stepResults[developerIdx] = updatedDeveloperStep;
        if (updatedDeveloperStep.status === "SUCCESS") completed.add(updatedDeveloperStep.agentId);
        else failedOrSkipped.add(updatedDeveloperStep.agentId);
      }
      stepResult = reviewerStep;
    } else if (step.role === "research") {
      stepResult = await executeResearchStep(agent, step, input, stepResults, readOnlyRunner);
    } else {
      stepResult = await executeReadOnlyStep(agent, step, buildStepContext(step, input, stepResults), readOnlyRunner);
    }

    stepResults.push(stepResult);
    if (stepResult.status === "SUCCESS") completed.add(step.agentId);
    else failedOrSkipped.add(step.agentId);
  }

  const { status, reason } = computeOverallStatus(stepResults);
  return { taskId: input.taskId, routingPlan: plan, stepResults, overallStatus: status, reason };
}
