import { executeRoutingPlan, computeOverallStatus } from "./agent-orchestrator";
import type {
  AgentOrchestratorDeps,
  AgentExecutionInput,
  DeveloperAgentRunner,
  ReviewerAgentRunner,
  ReadOnlyAgentRunner,
  ReadOnlyAgentOutcome,
  AgentStepResult,
} from "./agent-orchestrator";
import { routeTask, CORE_AGENT_REGISTRY } from "./agent-registry";
import type { RoutableTaskInput } from "./agent-registry";
import type { DeveloperResult } from "./claude-developer";
import type { GptReviewRetryResult } from "./gpt-reviewer";

// Agent Execution Orchestration 테스트(Phase F Task F2). 실제 Claude/GPT 유료 API를 전혀
// 호출하지 않는다 — developerRunner/reviewerRunner/readOnlyRunner는 항상 fake로 주입한다.
// MOVAN product task도 실행하지 않는다. F1의 routeTask()를 그대로 재사용해 RoutingPlan을
// 만든다(routing 로직을 이 테스트에서 다시 만들지 않는다).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function req(overrides: Partial<RoutableTaskInput> = {}): RoutableTaskInput {
  return { id: "task-1", description: "일반 작업", ...overrides };
}

function execInput(overrides: Partial<AgentExecutionInput> = {}): AgentExecutionInput {
  return { taskId: "task-1", taskGoal: "새 기능을 구현해줘", ...overrides };
}

interface TrackedDeps {
  deps: AgentOrchestratorDeps;
  callOrder: string[];
}

function makeTrackedDeps(overrides: {
  developer?: Partial<DeveloperResult>;
  reviewer?: Partial<GptReviewRetryResult>;
  readOnly?: Partial<ReadOnlyAgentOutcome>;
  prompts?: string[];
} = {}): TrackedDeps {
  const callOrder: string[] = [];
  const developerRunner: DeveloperAgentRunner = async () => {
    callOrder.push("developer");
    return {
      success: true,
      summary: "[FAKE] developer 구현 완료",
      changedFiles: ["a.ts"],
      tests: [{ name: "unit-1", pass: true }],
      rawOutput: "raw",
      ...overrides.developer,
    };
  };
  const reviewerRunner: ReviewerAgentRunner = async () => {
    callOrder.push("reviewer");
    return {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      feedback: "[FAKE] 리뷰 통과",
      nextTask: null,
      gptTransportRetry: 0,
      ...overrides.reviewer,
    };
  };
  const readOnlyRunner: ReadOnlyAgentRunner = async (prompt) => {
    callOrder.push(`readonly:${callOrder.filter((c) => c.startsWith("readonly")).length}`);
    overrides.prompts?.push(prompt);
    return { success: true, summary: "[FAKE] read-only agent 완료", rawOutput: prompt, ...overrides.readOnly };
  };
  return { deps: { developerRunner, reviewerRunner, readOnlyRunner }, callOrder };
}

// ---------------------------------------------------------------------------
// 1) code task: developer → qa/reviewer 순서.
// ---------------------------------------------------------------------------
async function scenarioCodeTaskExecutionOrder(): Promise<void> {
  const plan = routeTask(req({ description: "새 기능을 구현해줘" }));
  const { deps, callOrder } = makeTrackedDeps();
  const result = await executeRoutingPlan(plan, execInput(), CORE_AGENT_REGISTRY, deps);

  check("code task: overallStatus=COMPLETED", result.overallStatus === "COMPLETED");
  check(
    "code task: developer가 가장 먼저, reviewer가 마지막에 실행됨",
    callOrder[0] === "developer" && callOrder[callOrder.length - 1] === "reviewer"
  );
  check("code task: 3개 step 결과가 모두 SUCCESS", result.stepResults.every((r) => r.status === "SUCCESS"));
  check("code task: role 순서가 developer,qa,reviewer", result.stepResults.map((r) => r.role).join(",") === "developer,qa,reviewer");
}

// ---------------------------------------------------------------------------
// 2) fixed tests: 불필요 QA 생략.
// ---------------------------------------------------------------------------
async function scenarioFixedTestsSkipsQaExecution(): Promise<void> {
  const plan = routeTask(req({ description: "새 기능을 구현해줘", hasFixedRequiredTests: true }));
  const { deps, callOrder } = makeTrackedDeps();
  const result = await executeRoutingPlan(plan, execInput(), CORE_AGENT_REGISTRY, deps);

  check("hasFixedRequiredTests: qa role이 결과에 없음(실행 자체가 안 됨)", !result.stepResults.some((r) => r.role === "qa"));
  check("hasFixedRequiredTests: readonly runner가 전혀 호출되지 않음(qa가 유일한 read-only였음)", !callOrder.some((c) => c.startsWith("readonly")));
  check("hasFixedRequiredTests: developer+reviewer만 실행됨(2개)", result.stepResults.length === 2);
}

// ---------------------------------------------------------------------------
// 3) research task: research → security 순서.
// ---------------------------------------------------------------------------
async function scenarioResearchTaskExecutionOrder(): Promise<void> {
  const plan = routeTask(req({ description: "외부 API 조사가 필요함" }));
  const { deps, callOrder } = makeTrackedDeps();
  const result = await executeRoutingPlan(plan, execInput({ taskGoal: "외부 API 조사가 필요함" }), CORE_AGENT_REGISTRY, deps);

  check("research task: overallStatus=COMPLETED", result.overallStatus === "COMPLETED");
  check("research task: readonly runner가 정확히 2번 호출됨(research, security)", callOrder.filter((c) => c.startsWith("readonly")).length === 2);
  check("research task: role 순서가 research,security", result.stepResults.map((r) => r.role).join(",") === "research,security");
  check("research task: developer/reviewer는 전혀 실행되지 않음", !callOrder.includes("developer") && !callOrder.includes("reviewer"));
}

// ---------------------------------------------------------------------------
// 4) dependency ordering — reviewer는 항상 developer(+qa) 이후에만 실행됨.
// ---------------------------------------------------------------------------
async function scenarioDependencyOrdering(): Promise<void> {
  const plan = routeTask(req({ description: "새 기능을 구현해줘" }));
  const { deps, callOrder } = makeTrackedDeps();
  await executeRoutingPlan(plan, execInput(), CORE_AGENT_REGISTRY, deps);
  const developerIdx = callOrder.indexOf("developer");
  const reviewerIdx = callOrder.indexOf("reviewer");
  check("dependency ordering: developer가 reviewer보다 먼저 실행됨(인덱스 비교)", developerIdx < reviewerIdx && developerIdx === 0);
}

// ---------------------------------------------------------------------------
// 5) prerequisite 실패 시 후속 Agent 미실행.
// ---------------------------------------------------------------------------
async function scenarioPrerequisiteFailureSkipsDependents(): Promise<void> {
  const plan = routeTask(req({ description: "새 기능을 구현해줘" }));
  const { deps, callOrder } = makeTrackedDeps({ developer: { success: false, errorCode: "NON_ZERO_EXIT" as never } });
  const result = await executeRoutingPlan(plan, execInput(), CORE_AGENT_REGISTRY, deps);

  check("developer 실패: overallStatus=FAILED", result.overallStatus === "FAILED");
  const qaResult = result.stepResults.find((r) => r.role === "qa");
  const reviewerResult = result.stepResults.find((r) => r.role === "reviewer");
  check("developer 실패: qa는 SKIPPED로 기록됨(실행되지 않음)", qaResult?.status === "SKIPPED");
  check("developer 실패: reviewer도 SKIPPED로 기록됨", reviewerResult?.status === "SKIPPED");
  check("developer 실패: qa/reviewer의 실제 runner가 호출되지 않음(readonly/reviewer가 callOrder에 없음)", !callOrder.includes("reviewer") && !callOrder.some((c) => c.startsWith("readonly")));
}

// ---------------------------------------------------------------------------
// 6) 동일 Agent 중복 호출 방지.
// ---------------------------------------------------------------------------
async function scenarioNoDuplicateAgentCalls(): Promise<void> {
  const plan = routeTask(req({ description: "새 기능을 구현해줘" }));
  const { deps, callOrder } = makeTrackedDeps();
  await executeRoutingPlan(plan, execInput(), CORE_AGENT_REGISTRY, deps);
  check("동일 Agent 중복 호출 방지: developer가 정확히 1번만 호출됨", callOrder.filter((c) => c === "developer").length === 1);
  check("동일 Agent 중복 호출 방지: reviewer가 정확히 1번만 호출됨", callOrder.filter((c) => c === "reviewer").length === 1);
}

// ---------------------------------------------------------------------------
// 7) 최소 context 전달 — 각 Agent는 자신의 역할에 필요한 최소 context만 받는다.
// ---------------------------------------------------------------------------
async function scenarioMinimalContextPerAgent(): Promise<void> {
  const plan = routeTask(req({ description: "외부 API 조사가 필요함" }));
  const prompts: string[] = [];
  const { deps } = makeTrackedDeps({ prompts });
  await executeRoutingPlan(
    plan,
    execInput({
      taskGoal: "외부 API 조사가 필요함",
      roleContext: { research: "RESEARCH_ONLY_SECRET_CONTEXT", security: "SECURITY_ONLY_CONTEXT" },
    }),
    CORE_AGENT_REGISTRY,
    deps
  );

  check("최소 context: prompt가 정확히 2개(research, security) 생성됨", prompts.length === 2);
  const [researchPrompt, securityPrompt] = prompts;
  check("최소 context: research prompt에는 research 전용 context만 포함됨", researchPrompt.includes("RESEARCH_ONLY_SECRET_CONTEXT"));
  check("최소 context: research prompt에는 security 전용 context가 없음", !researchPrompt.includes("SECURITY_ONLY_CONTEXT"));
  check("최소 context: security prompt에는 security 전용 context가 포함됨", securityPrompt.includes("SECURITY_ONLY_CONTEXT"));
  check(
    "최소 context: security prompt에는 research의 '결과 요약'은 포함되지만 research의 원본 roleContext 문자열은 포함되지 않음",
    securityPrompt.includes("[research]") && !securityPrompt.includes("RESEARCH_ONLY_SECRET_CONTEXT")
  );
}

// ---------------------------------------------------------------------------
// 8) 불필요 Agent 호출 없음.
// ---------------------------------------------------------------------------
async function scenarioNoUnnecessaryAgentCalls(): Promise<void> {
  const plan = routeTask(req({ description: "의존성 보안 검토를 수행" }));
  const { deps, callOrder } = makeTrackedDeps();
  const result = await executeRoutingPlan(plan, execInput({ taskGoal: "의존성 보안 검토를 수행" }), CORE_AGENT_REGISTRY, deps);
  check("security task: security 1개만 실행됨", result.stepResults.length === 1 && result.stepResults[0].role === "security");
  check("security task: developer/reviewer는 전혀 호출되지 않음", !callOrder.includes("developer") && !callOrder.includes("reviewer"));
  check("security task: readonly는 정확히 1번만 호출됨", callOrder.filter((c) => c.startsWith("readonly")).length === 1);
}

// ---------------------------------------------------------------------------
// 9) deterministic_only → LLM 호출 0.
// ---------------------------------------------------------------------------
async function scenarioDeterministicOnlyZeroLlmCalls(): Promise<void> {
  const plan = routeTask(req({ description: "secret scanner를 실행해서 검사만 하면 됨" }));
  const { deps, callOrder } = makeTrackedDeps();
  const result = await executeRoutingPlan(plan, execInput({ taskGoal: "secret scanner를 실행해서 검사만 하면 됨" }), CORE_AGENT_REGISTRY, deps);
  check("deterministic_only: stepResults가 빈 배열", result.stepResults.length === 0);
  check("deterministic_only: 어떤 runner도 호출되지 않음(callOrder가 빈 배열)", callOrder.length === 0);
  check("deterministic_only: overallStatus=COMPLETED(실행할 게 없으므로)", result.overallStatus === "COMPLETED");
}

// ---------------------------------------------------------------------------
// 10) Agent permission 위반 BLOCK.
// ---------------------------------------------------------------------------
async function scenarioAgentPermissionViolationBlocked(): Promise<void> {
  const plan = routeTask(req({ description: "시스템 아키텍처를 설계해줘" }));
  const { deps } = makeTrackedDeps({ readOnly: { requestedPermission: "canWriteCode" } }); // planner는 canWriteCode=false.
  const result = await executeRoutingPlan(plan, execInput({ taskGoal: "시스템 아키텍처를 설계해줘" }), CORE_AGENT_REGISTRY, deps);
  check("permission 위반: planner step이 BLOCKED로 기록됨", result.stepResults[0].status === "BLOCKED");
  check("permission 위반: overallStatus=BLOCKED", result.overallStatus === "BLOCKED");
}

// ---------------------------------------------------------------------------
// 11) high-risk human gate 유지 — 어떤 runner도 호출되지 않음.
// ---------------------------------------------------------------------------
async function scenarioHighRiskHumanGateNoRunnerCalls(): Promise<void> {
  const plan = routeTask(req({ description: "production DB에서 데이터를 삭제해줘" }));
  check("고위험 task: F1이 이미 requiresHumanApproval=true로 판정함", plan.requiresHumanApproval === true);
  const { deps, callOrder } = makeTrackedDeps();
  const result = await executeRoutingPlan(plan, execInput({ taskGoal: "production DB에서 데이터를 삭제해줘" }), CORE_AGENT_REGISTRY, deps);
  check("고위험 task: overallStatus=HUMAN_APPROVAL_REQUIRED", result.overallStatus === "HUMAN_APPROVAL_REQUIRED");
  check("고위험 task: stepResults가 빈 배열(어떤 agent도 실행 안 됨)", result.stepResults.length === 0);
  check("고위험 task: 어떤 runner도 호출되지 않음", callOrder.length === 0);
}

// ---------------------------------------------------------------------------
// 12) deterministic tests가 QA 의견보다 우선.
// ---------------------------------------------------------------------------
async function scenarioDeterministicTestsOverrideQaOpinion(): Promise<void> {
  const plan = routeTask(req({ description: "새 기능을 구현해줘" }));
  // developer의 실제 required test는 실패했지만, QA(read-only agent)는 "다 좋다"고 보고한다.
  const { deps } = makeTrackedDeps({
    developer: { tests: [{ name: "unit-1", pass: false }] },
    readOnly: { summary: "[FAKE QA] 테스트 계획상 문제 없어 보입니다 — 전부 통과할 것 같습니다." },
  });
  const result = await executeRoutingPlan(plan, execInput(), CORE_AGENT_REGISTRY, deps);
  check("QA가 낙관적으로 보고해도 실제 테스트 실패가 최종 판정됨(overallStatus=FAILED)", result.overallStatus === "FAILED");
  check("실패 사유가 deterministic required tests를 명시함", result.reason.includes("deterministic required tests"));
  const qaResult = result.stepResults.find((r) => r.role === "qa");
  check("QA step 자체는 SUCCESS로 기록됨(QA는 정상 실행됐을 뿐, 그 의견이 최종 판정을 바꾸지 못할 뿐)", qaResult?.status === "SUCCESS");
}

// ---------------------------------------------------------------------------
// 13) advisory(read-only) runner가 예외를 던져도 전체 pipeline이 죽지 않고 이 step만
//     FAILED로 격리됨 — 하드닝 H(Advisory Agent 실패격리).
// ---------------------------------------------------------------------------
async function scenarioReadOnlyRunnerThrowIsolatedFromPipeline(): Promise<void> {
  const plan = routeTask(req({ description: "새 기능을 구현해줘" }));
  const callOrder: string[] = [];
  const developerRunner: DeveloperAgentRunner = async () => {
    callOrder.push("developer");
    return { success: true, summary: "[FAKE] developer 구현 완료", changedFiles: ["a.ts"], tests: [{ name: "unit-1", pass: true }], rawOutput: "raw" };
  };
  const readOnlyRunner: ReadOnlyAgentRunner = async () => {
    callOrder.push("qa-throw");
    throw new Error("simulated network failure in advisory QA runner");
  };
  const reviewerRunner: ReviewerAgentRunner = async () => {
    callOrder.push("reviewer");
    return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "ok", nextTask: null, gptTransportRetry: 0 };
  };

  let threw = false;
  let result: Awaited<ReturnType<typeof executeRoutingPlan>> | undefined;
  try {
    result = await executeRoutingPlan(plan, execInput(), CORE_AGENT_REGISTRY, { developerRunner, reviewerRunner, readOnlyRunner });
  } catch {
    threw = true;
  }

  check("advisory throw 격리: executeRoutingPlan 자체는 예외를 던지지 않고 정상적으로 resolve됨", !threw && result !== undefined);
  const qaResult = result?.stepResults.find((r) => r.role === "qa");
  check("advisory throw 격리: qa step은 FAILED로 기록됨(SUCCESS로 위장하지 않음)", qaResult?.status === "FAILED");
  check("advisory throw 격리: qa 실패 사유에 예외 메시지가 포함됨", !!qaResult?.reason?.includes("simulated network failure"));
  const developerResult = result?.stepResults.find((r) => r.role === "developer");
  check("advisory throw 격리: developer step은 그대로 SUCCESS로 남아있음(예외로 유실되지 않음)", developerResult?.status === "SUCCESS");
  const reviewerResult = result?.stepResults.find((r) => r.role === "reviewer");
  check("advisory throw 격리: qa가 실패했으므로 reviewer는 의존성 미충족으로 SKIPPED됨", reviewerResult?.status === "SKIPPED");
  check("advisory throw 격리: reviewer의 실제 runner는 호출되지 않음", !callOrder.includes("reviewer"));
  check("advisory throw 격리: overallStatus=FAILED(예외를 삼켜 COMPLETED로 위장하지 않음)", result?.overallStatus === "FAILED");
}

// ---------------------------------------------------------------------------
// 14) reviewer runner가 예외를 던져도 이미 성공한 developer step 결과가 유실되지 않음.
// ---------------------------------------------------------------------------
async function scenarioReviewerRunnerThrowPreservesDeveloperStep(): Promise<void> {
  const plan = routeTask(req({ description: "새 기능을 구현해줘", hasFixedRequiredTests: true }));
  const developerRunner: DeveloperAgentRunner = async () => ({
    success: true,
    summary: "[FAKE] developer 구현 완료",
    changedFiles: ["a.ts"],
    tests: [{ name: "unit-1", pass: true }],
    rawOutput: "raw",
  });
  const reviewerRunner: ReviewerAgentRunner = async () => {
    throw new Error("simulated malformed GPT reviewer response");
  };
  const readOnlyRunner: ReadOnlyAgentRunner = async () => ({ success: true, summary: "", rawOutput: "" });

  const result = await executeRoutingPlan(plan, execInput(), CORE_AGENT_REGISTRY, { developerRunner, reviewerRunner, readOnlyRunner });

  const developerResult = result.stepResults.find((r) => r.role === "developer");
  check("reviewer throw: developer step은 SUCCESS로 그대로 남아있음(유실되지 않음)", developerResult?.status === "SUCCESS");
  const reviewerResult = result.stepResults.find((r) => r.role === "reviewer");
  check("reviewer throw: reviewer step은 FAILED로 격리됨", reviewerResult?.status === "FAILED");
  check("reviewer throw: 실패 사유에 예외 메시지가 포함됨", !!reviewerResult?.reason?.includes("simulated malformed GPT reviewer response"));
  check("reviewer throw: overallStatus=FAILED", result.overallStatus === "FAILED");
}

// ---------------------------------------------------------------------------
// computeOverallStatus 단위 테스트(순수 함수).
// ---------------------------------------------------------------------------
function scenarioComputeOverallStatusUnitChecks(): void {
  const allSuccess: AgentStepResult[] = [
    { agentId: "core-developer", role: "developer", status: "SUCCESS", summary: "", data: { success: true, tests: [{ name: "t", pass: true }] } as DeveloperResult },
  ];
  check("computeOverallStatus: 전부 성공 + 테스트 통과 → COMPLETED", computeOverallStatus(allSuccess).status === "COMPLETED");

  const empty: AgentStepResult[] = [];
  check("computeOverallStatus: 빈 배열 → COMPLETED(실행할 게 없음)", computeOverallStatus(empty).status === "COMPLETED");
}

async function main(): Promise<void> {
  await scenarioCodeTaskExecutionOrder();
  await scenarioFixedTestsSkipsQaExecution();
  await scenarioResearchTaskExecutionOrder();
  await scenarioDependencyOrdering();
  await scenarioPrerequisiteFailureSkipsDependents();
  await scenarioNoDuplicateAgentCalls();
  await scenarioMinimalContextPerAgent();
  await scenarioNoUnnecessaryAgentCalls();
  await scenarioDeterministicOnlyZeroLlmCalls();
  await scenarioAgentPermissionViolationBlocked();
  await scenarioHighRiskHumanGateNoRunnerCalls();
  await scenarioDeterministicTestsOverrideQaOpinion();
  await scenarioReadOnlyRunnerThrowIsolatedFromPipeline();
  await scenarioReviewerRunnerThrowPreservesDeveloperStep();
  scenarioComputeOverallStatusUnitChecks();

  console.log("\n=== agent-orchestrator 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
