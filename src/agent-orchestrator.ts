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

// Agent Execution Orchestration — Phase F Task F2.
//
// F1의 routeTask()가 만든 RoutingPlan을 실제로 실행한다: step dependency 확인 → 필요한
// Agent만 실행 → 결과를 구조화해 다음 step으로 전달 → 최종 실행 결과 반환. 이번 Task는
// Agent 간 자유대화/복잡한 병렬실행/REVISE 자동 handoff loop를 구현하지 않는다 —
// executeRoutingPlan()은 각 step을 정확히 한 번만, RoutingStep의 dependency 순서대로
// 실행하고 끝난다(REVISE는 결과로 보고될 뿐, 자동으로 developer를 다시 부르지 않는다 —
// 그 loop는 orchestrator.ts의 별개 관심사이며 이 파일은 그것을 감싸지 않고 claude-developer.ts/
// gpt-reviewer.ts의 실행 primitive를 직접 재사용한다).
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
}

export type ReadOnlyAgentRunner = (prompt: string, attempt: number) => Promise<ReadOnlyAgentOutcome>;

/** 실제 운용 기본 구현 — claude-runner.ts의 runClaudeTask(항상 --tools "", 파일/명령
 *  실행 경로 자체가 없음)를 그대로 감싼다. 새 실행 인프라를 만들지 않는다. */
export const realReadOnlyAgentRunner: ReadOnlyAgentRunner = async (prompt, attempt) => {
  const result = await realReadOnlyClaudeCall(prompt, attempt);
  return { success: result.success, summary: result.summary, rawOutput: result.rawOutput };
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

async function executeReviewerStep(
  agent: AgentDefinition,
  priorResults: AgentStepResult[],
  input: AgentExecutionInput,
  runner: ReviewerAgentRunner
): Promise<AgentStepResult> {
  const developerResult = priorResults.find((r) => r.role === "developer")?.data as DeveloperResult | undefined;
  if (!developerResult) {
    return {
      agentId: agent.id,
      role: "reviewer",
      status: "SKIPPED",
      summary: "",
      reason: "reviewer는 developer 결과가 있어야 리뷰할 수 있습니다(선행 결과 없음).",
    };
  }
  const result = await runner(developerResult, 1, input.taskGoal, input.reviewerOptions ?? {});
  return { agentId: agent.id, role: "reviewer", status: "SUCCESS", summary: result.feedback, data: result };
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
    const reviewerData = reviewerStep.data as GptReviewRetryResult;
    if (reviewerData.decision === "BLOCK" || reviewerData.decision === "HUMAN_REQUIRED") {
      return { status: "HUMAN_APPROVAL_REQUIRED", reason: `reviewer decision=${reviewerData.decision}` };
    }
    if (reviewerData.decision === "REVISE") {
      return {
        status: "FAILED",
        reason: "reviewer decision=REVISE — 이 Task는 자동 REVISE handoff loop를 구현하지 않으므로 후속 처리는 호출부의 몫입니다.",
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
      stepResult = await executeReviewerStep(agent, stepResults, input, reviewerRunner);
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
