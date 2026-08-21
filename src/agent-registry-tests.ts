import {
  routeTask,
  classifyTaskType,
  validateAgentDefinition,
  validateAgentRegistry,
  validateAgentRouterPolicy,
  CORE_AGENT_REGISTRY,
} from "./agent-registry";
import type { AgentDefinition, AgentRouterPolicy, RoutableTaskInput } from "./agent-registry";

// Core Agent Registry & Deterministic Router Foundation 테스트(Phase F Task F1). 실제
// Claude/GPT 유료 API를 전혀 호출하지 않는다 — routeTask()는 순수 함수이며 이 테스트는
// 그 함수만 검증한다(실제 agent 실행/병렬 처리 없음). MOVAN product task도 실행하지 않는다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function req(overrides: Partial<RoutableTaskInput> = {}): RoutableTaskInput {
  return { id: "task-1", description: "일반 작업", ...overrides };
}

// ---------------------------------------------------------------------------
// 0) Registry 자체가 유효함(모듈 로드 시 이미 검증되지만 명시적으로 재확인).
// ---------------------------------------------------------------------------
function scenarioCoreRegistryValid(): void {
  let threw = false;
  try {
    validateAgentRegistry(CORE_AGENT_REGISTRY);
  } catch {
    threw = true;
  }
  check("CORE_AGENT_REGISTRY는 validateAgentRegistry를 통과함", !threw);
  check("CORE_AGENT_REGISTRY에 정확히 6개 role이 있음(초기 역할 6개)", CORE_AGENT_REGISTRY.length === 6);
  check(
    "6개 역할이 planner/research/developer/qa/reviewer/security를 모두 포함함",
    ["planner", "research", "developer", "qa", "reviewer", "security"].every((r) =>
      CORE_AGENT_REGISTRY.some((a) => a.role === r)
    )
  );
  check(
    "developer 외 어떤 role도 canWriteCode=true가 아님(코드 작성은 developer 전용)",
    CORE_AGENT_REGISTRY.filter((a) => a.role !== "developer").every((a) => a.canWriteCode === false)
  );
}

// ---------------------------------------------------------------------------
// 1) classifyTaskType 단위 테스트.
// ---------------------------------------------------------------------------
function scenarioClassifyTaskType(): void {
  check("코드 구현 텍스트 → code_implementation", classifyTaskType("로그인 버그 수정 구현") === "code_implementation");
  check("공식 자료 조사 텍스트 → external_capability_research", classifyTaskType("외부 API 조사가 필요함") === "external_capability_research");
  check("아키텍처 텍스트 → architecture_design", classifyTaskType("시스템 아키텍처 설계") === "architecture_design");
  check("보안 검토 텍스트 → security_review", classifyTaskType("의존성 보안 검토") === "security_review");
  check(
    "Core service 이름을 직접 언급하면 → deterministic_only",
    classifyTaskType("secret scanner를 실행해서 검사한다") === "deterministic_only"
  );
  check("특징 없는 텍스트 → general", classifyTaskType("아무 의미 없는 텍스트 abcxyz") === "general");
}

// ---------------------------------------------------------------------------
// 2) code task → 필요한 agent set 선택(developer+qa+reviewer) + deterministic ordering.
// ---------------------------------------------------------------------------
function scenarioCodeTaskSelectsDeveloperQaReviewer(): void {
  const plan = routeTask(req({ description: "새 기능을 구현해줘" }));
  check("code task: taskType=code_implementation", plan.taskType === "code_implementation");
  check(
    "code task: developer/qa/reviewer 3개 role 선택됨",
    plan.steps.length === 3 && ["developer", "qa", "reviewer"].every((r) => plan.steps.some((s) => s.role === r))
  );
  check(
    "code task: deterministic ordering(developer → qa → reviewer, priority 순)",
    plan.steps.map((s) => s.role).join(",") === "developer,qa,reviewer"
  );
  const reviewerStep = plan.steps.find((s) => s.role === "reviewer");
  check(
    "code task: reviewer가 developer/qa 모두에 의존함(dependency 표현)",
    reviewerStep !== undefined && reviewerStep.dependsOn.length === 2
  );
  const qaStep = plan.steps.find((s) => s.role === "qa");
  check("code task: qa가 developer에 의존함", qaStep !== undefined && qaStep.dependsOn.includes("core-developer"));
  check("code task: 불필요한 agent(planner/research/security)는 선택되지 않음", !plan.steps.some((s) => ["planner", "research", "security"].includes(s.role)));
}

// ---------------------------------------------------------------------------
// 3) 최소 Agent 선택으로 과잉 호출 방지 — hasFixedRequiredTests면 qa 제외.
// ---------------------------------------------------------------------------
function scenarioFixedTestsSkipsQa(): void {
  const plan = routeTask(req({ description: "새 기능을 구현해줘", hasFixedRequiredTests: true }));
  check("hasFixedRequiredTests=true: qa가 선택되지 않음(단순 deterministic test에 LLM Agent 낭비 안 함)", !plan.steps.some((s) => s.role === "qa"));
  check("hasFixedRequiredTests=true: developer+reviewer만 선택됨(2개)", plan.steps.length === 2);
  const reviewerStep = plan.steps.find((s) => s.role === "reviewer");
  check("hasFixedRequiredTests=true: reviewer는 developer에만 의존함(qa가 없으므로)", reviewerStep?.dependsOn.length === 1);
}

// ---------------------------------------------------------------------------
// 4) research task → research 중심 선택(research+security).
// ---------------------------------------------------------------------------
function scenarioResearchTaskSelectsResearchAndSecurity(): void {
  const plan = routeTask(req({ description: "외부 API 조사가 필요함" }));
  check("research task: taskType=external_capability_research", plan.taskType === "external_capability_research");
  check("research task: research/security 2개 role 선택됨", plan.steps.length === 2 && plan.steps.every((s) => ["research", "security"].includes(s.role)));
  check("research task: deterministic ordering(research → security)", plan.steps.map((s) => s.role).join(",") === "research,security");
  const securityStep = plan.steps.find((s) => s.role === "security");
  check("research task: security가 research에 의존함", securityStep?.dependsOn.includes("core-research") ?? false);
  check("research task: developer/qa/reviewer는 선택되지 않음", !plan.steps.some((s) => ["developer", "qa", "reviewer"].includes(s.role)));
}

// ---------------------------------------------------------------------------
// 5) security task → security만 선택.
// ---------------------------------------------------------------------------
function scenarioSecurityTaskSelectsSecurityOnly(): void {
  const plan = routeTask(req({ description: "의존성 보안 검토를 수행" }));
  check("security task: taskType=security_review", plan.taskType === "security_review");
  check("security task: security 1개만 선택됨", plan.steps.length === 1 && plan.steps[0].role === "security");
}

// ---------------------------------------------------------------------------
// 6) architecture task → planner (+ 필요한 경우 research).
// ---------------------------------------------------------------------------
function scenarioArchitectureTaskConditionalResearch(): void {
  const withoutHint = routeTask(req({ description: "시스템 아키텍처를 설계해줘" }));
  check("architecture(외부 언급 없음): planner만 선택됨", withoutHint.steps.length === 1 && withoutHint.steps[0].role === "planner");

  const withHint = routeTask(req({ description: "외부 vendor 공식 문서를 참고해 시스템 아키텍처를 설계해줘" }));
  check(
    "architecture(외부/공식 문서 언급): planner+research 선택됨",
    withHint.steps.length === 2 && ["planner", "research"].every((r) => withHint.steps.some((s) => s.role === r))
  );
  check("architecture+research: planner가 먼저(ordering)", withHint.steps.map((s) => s.role).join(",") === "planner,research");
}

// ---------------------------------------------------------------------------
// 7) Core service를 Agent로 잘못 routing하지 않음(deterministic_only → 빈 계획).
// ---------------------------------------------------------------------------
function scenarioDeterministicOnlyRoutesToNoAgents(): void {
  const plan = routeTask(req({ description: "secret scanner를 실행해서 커밋 전 검사만 하면 됨" }));
  check("deterministic_only: taskType=deterministic_only", plan.taskType === "deterministic_only");
  check("deterministic_only: 어떤 agent도 선택되지 않음(빈 배열)", plan.steps.length === 0);
  check("deterministic_only: reason에 Core deterministic service 문구 포함", plan.reason.includes("Core deterministic service"));
}

// ---------------------------------------------------------------------------
// 8) 동일 입력 → 동일 routing.
// ---------------------------------------------------------------------------
function scenarioSameInputSameRouting(): void {
  const input = req({ description: "새 기능을 구현해줘" });
  const plan1 = routeTask(input);
  const plan2 = routeTask(input);
  check("동일 입력을 두 번 routing해도 완전히 동일한 결과", JSON.stringify(plan1) === JSON.stringify(plan2));
}

// ---------------------------------------------------------------------------
// 9) Project Rule로 Agent 권한 확대 불가(추가만 가능).
// ---------------------------------------------------------------------------
function scenarioProjectPolicyCannotExpandCorePermissions(): void {
  // (a) policy는 agent 정의(canWriteCode 등)를 patch할 방법이 전혀 없다 — 가짜 필드를
  //     넣어도 무시된다.
  const bypassPolicy = {
    overrideAgentPermissions: { "core-qa": { canWriteCode: true, canUseNetwork: true } },
    disableCoreRegistry: true,
  } as unknown as AgentRouterPolicy;
  const plan = routeTask(req({ description: "새 기능을 구현해줘" }), CORE_AGENT_REGISTRY, bypassPolicy);
  const qaAgent = CORE_AGENT_REGISTRY.find((a) => a.id === "core-qa");
  check("가짜 '권한 확대' 필드를 policy에 넣어도 CORE_AGENT_REGISTRY의 core-qa 정의 자체는 변하지 않음", qaAgent?.canWriteCode === false);
  check("routing 결과는 정상적으로 계산됨(policy의 알 수 없는 필드가 routing을 깨뜨리지 않음)", plan.steps.length > 0);

  // (b) policy는 오직 "추가"만 가능하다 — additionalRequiredAgentsByTaskType으로 실제
  //     agent를 추가할 수 있음을 대조 검증(완화가 아니라 강화만 가능).
  const additivePolicy: AgentRouterPolicy = { additionalRequiredAgentsByTaskType: { code_implementation: ["core-security"] } };
  const expandedPlan = routeTask(req({ description: "새 기능을 구현해줘" }), CORE_AGENT_REGISTRY, additivePolicy);
  check(
    "policy.additionalRequiredAgentsByTaskType는 실제로 agent를 '추가'할 수 있음(강화)",
    expandedPlan.steps.some((s) => s.role === "security")
  );
  check("추가된 agent 때문에 기존 developer/qa/reviewer가 사라지지 않음", ["developer", "qa", "reviewer"].every((r) => expandedPlan.steps.some((s) => s.role === r)));

  // (c) 잘못된 policy(알려지지 않은 agent id/taskType)는 조용히 무시되지 않고 throw한다.
  let threwUnknownAgent = false;
  try {
    validateAgentRouterPolicy({ additionalRequiredAgentsByTaskType: { code_implementation: ["not-a-real-agent"] } });
  } catch {
    threwUnknownAgent = true;
  }
  check("알려지지 않은 agent id를 policy에 넣으면 validateAgentRouterPolicy가 throw함", threwUnknownAgent);

  let threwUnknownTaskType = false;
  try {
    validateAgentRouterPolicy({ additionalRequiredAgentsByTaskType: { not_a_real_task_type: ["core-security"] } as never });
  } catch {
    threwUnknownTaskType = true;
  }
  check("알려지지 않은 taskType key를 policy에 넣으면 validateAgentRouterPolicy가 throw함", threwUnknownTaskType);
}

// ---------------------------------------------------------------------------
// 10) high-risk task human approval 유지(policy.ts 재사용).
// ---------------------------------------------------------------------------
function scenarioHighRiskTaskRequiresHumanApproval(): void {
  const highRiskPlan = routeTask(req({ description: "production DB에서 데이터를 삭제해줘" }));
  check("고위험 task: requiresHumanApproval=true", highRiskPlan.requiresHumanApproval === true);

  const normalPlan = routeTask(req({ description: "새 기능을 구현해줘" }));
  check("일반 task: requiresHumanApproval=false", normalPlan.requiresHumanApproval === false);
}

// ---------------------------------------------------------------------------
// 11) Core hard rule — developer 외 role은 canWriteCode=true를 가질 수 없다.
// ---------------------------------------------------------------------------
function scenarioNonDeveloperCannotWriteCode(): void {
  const invalidAgent: AgentDefinition = {
    id: "rogue-qa",
    role: "qa",
    capabilities: ["test_planning"],
    allowedTaskTypes: ["code_implementation"],
    requiredTools: [],
    riskLevel: "low",
    canWriteCode: true,
    canUseNetwork: false,
    canRequestHumanApproval: true,
    executionModel: "claude-read-only",
    priority: 40,
  };
  let threw = false;
  try {
    validateAgentDefinition(invalidAgent);
  } catch {
    threw = true;
  }
  check("qa role인데 canWriteCode=true인 AgentDefinition은 validateAgentDefinition이 throw함", threw);
}

// ---------------------------------------------------------------------------
// 12) taskType이 명시되면 텍스트 분류보다 우선한다.
// ---------------------------------------------------------------------------
function scenarioExplicitTaskTypeOverridesTextClassification(): void {
  const plan = routeTask(req({ description: "아무 의미 없는 텍스트", taskType: "security_review" }));
  check("명시적 taskType이 텍스트 분류보다 우선함", plan.taskType === "security_review" && plan.steps.length === 1 && plan.steps[0].role === "security");
}

// ---------------------------------------------------------------------------
// 13) 커스텀(축소된) registry에서도 안전하게 동작함(존재하지 않는 role은 조용히 생략).
// ---------------------------------------------------------------------------
function scenarioCustomRegistryMissingRoleHandledGracefully(): void {
  const reducedRegistry = CORE_AGENT_REGISTRY.filter((a) => a.role !== "qa");
  const plan = routeTask(req({ description: "새 기능을 구현해줘" }), reducedRegistry);
  check("registry에 qa가 없으면 qa 없이도 크래시 없이 routing됨", !plan.steps.some((s) => s.role === "qa"));
  check("나머지 developer/reviewer는 정상적으로 선택됨", ["developer", "reviewer"].every((r) => plan.steps.some((s) => s.role === r)));
}

function main(): void {
  scenarioCoreRegistryValid();
  scenarioClassifyTaskType();
  scenarioCodeTaskSelectsDeveloperQaReviewer();
  scenarioFixedTestsSkipsQa();
  scenarioResearchTaskSelectsResearchAndSecurity();
  scenarioSecurityTaskSelectsSecurityOnly();
  scenarioArchitectureTaskConditionalResearch();
  scenarioDeterministicOnlyRoutesToNoAgents();
  scenarioSameInputSameRouting();
  scenarioProjectPolicyCannotExpandCorePermissions();
  scenarioHighRiskTaskRequiresHumanApproval();
  scenarioNonDeveloperCannotWriteCode();
  scenarioExplicitTaskTypeOverridesTextClassification();
  scenarioCustomRegistryMissingRoleHandledGracefully();

  console.log("\n=== agent-registry 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
