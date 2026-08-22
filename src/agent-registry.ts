import { classifyTaskRisk, requiresHumanApproval } from "./policy";

// Core Agent Registry & Deterministic Router Foundation — Phase F Task F1.
//
// AutoDev가 Task 성격에 따라 필요한 전문 Agent만 선택할 수 있도록 (1) Core Agent Registry
// (2) Agent Capability/Permission 모델 (3) Deterministic Agent Router의 기반을 구현한다.
// 이번 Task는 실제 병렬 Agent 실행/자유로운 Agent-to-Agent 대화/Agent가 임의로 새 Agent를
// 만드는 기능을 전혀 구현하지 않는다 — routeTask()는 순수 함수이며, 어떤 LLM도 호출하지
// 않고 어떤 실행도 트리거하지 않는다(오직 "어떤 agent가 필요한가"라는 계획만 반환한다).
//
// 핵심 경계: Safe Executor(safe-executor.ts) / Secret Scanner(secret-scanner.ts) /
// Dependency Scanner(dependency-scanner.ts) / Git checkpoint(checkpoint.ts) / state
// persistence(state.ts)는 Agent가 아니라 AutoDev Core deterministic service로 남는다 —
// 이 Registry에는 그것들을 위한 AgentRole이 없고, Router가 그런 작업을 "agent가 필요한
// task"로 분류하면 안 된다는 요구사항을 classifyTaskType()의 "deterministic_only" 분류로
// 구조적으로 반영한다(§ 아래).
//
// Agent는 기존 Core Gate를 우회할 수 없다 — developer의 실제 코드 작성은 여전히
// claude-developer.ts(Safe Executor 프로토콜)를, commit은 여전히 checkpoint.ts(Secret/
// Dependency Scanner 게이트)를, reviewer는 여전히 gpt-reviewer.ts를 그대로 쓴다. 이 파일은
// "어떤 agent를 쓸지" 결정만 하고, 실제 실행 배선은 이 Task 범위 밖이다(다음 Task).

// =========================================================
// Agent Capability/Permission 모델.
// =========================================================

export type AgentRole = "planner" | "research" | "developer" | "qa" | "reviewer" | "security";

export const KNOWN_AGENT_ROLES: ReadonlySet<AgentRole> = new Set(["planner", "research", "developer", "qa", "reviewer", "security"]);

export type AgentRiskLevel = "low" | "medium" | "high";

/** 요구사항의 "task type" 분류 — Router가 어떤 agent 조합을 선택할지 결정하는 단일
 *  분류축이다. "deterministic_only"는 Core deterministic service(Safe Executor/Secret
 *  Scanner/Dependency Scanner/checkpoint/state)만으로 처리 가능한 작업을 가리킨다 —
 *  이 분류로 판정되면 어떤 agent도 선택되지 않는다(LLM 호출 낭비 금지). */
export type TaskType =
  | "code_implementation"
  | "external_capability_research"
  | "architecture_design"
  | "security_review"
  | "deterministic_only"
  | "general";

export const KNOWN_TASK_TYPES: ReadonlySet<TaskType> = new Set([
  "code_implementation",
  "external_capability_research",
  "architecture_design",
  "security_review",
  "deterministic_only",
  "general",
]);

/** 이 agent가 실제로 어떤 기존 Core 실행 경로에 의해 뒷받침되는지 — 새 실행 인프라를
 *  만들지 않고 이미 존재하는 경로만 참조한다. "claude-developer"는
 *  claude-developer.ts(Safe Executor 프로토콜, 코드 작성 가능), "gpt-reviewer"는
 *  gpt-reviewer.ts(독립 리뷰), "claude-read-only"는 파일 쓰기/명령 실행 권한이 없는
 *  일반 Claude 호출(계획/조사/검토 전용 — 아직 실제 배선은 이 Task 범위 밖이다). */
export type AgentExecutionModel = "claude-developer" | "gpt-reviewer" | "claude-read-only";

export const KNOWN_EXECUTION_MODELS: ReadonlySet<AgentExecutionModel> = new Set(["claude-developer", "gpt-reviewer", "claude-read-only"]);

/** required tool의 단일 출처 — 실제 이 저장소에 존재하는 Core subsystem만 참조한다(새
 *  이름을 지어내지 않는다). */
export type RequiredTool = "safe_executor" | "capability_discovery" | "gpt_reviewer_api" | "browser_worker" | "dependency_scanner_findings";

export const KNOWN_REQUIRED_TOOLS: ReadonlySet<RequiredTool> = new Set([
  "safe_executor",
  "capability_discovery",
  "gpt_reviewer_api",
  "browser_worker",
  "dependency_scanner_findings",
]);

export interface AgentDefinition {
  id: string;
  role: AgentRole;
  /** 사람이 읽는 능력 설명 태그(자유 문자열) — routing 판정에는 쓰이지 않는다(판정은
   *  allowedTaskTypes/role만 근거로 한다). */
  capabilities: string[];
  allowedTaskTypes: TaskType[];
  requiredTools: RequiredTool[];
  riskLevel: AgentRiskLevel;
  canWriteCode: boolean;
  canUseNetwork: boolean;
  canRequestHumanApproval: boolean;
  executionModel: AgentExecutionModel;
  /** 낮을수록 먼저 실행된다(deterministic ordering의 단일 출처). */
  priority: number;
}

export type AgentRegistry = readonly AgentDefinition[];

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function validateAgentDefinition(agent: AgentDefinition): void {
  if (!agent || typeof agent !== "object") throw new Error("Invalid AgentDefinition: agent가 비어있거나 객체가 아닙니다.");
  if (!isNonEmptyString(agent.id)) throw new Error("Invalid AgentDefinition: id가 비어있습니다.");
  if (!KNOWN_AGENT_ROLES.has(agent.role)) throw new Error(`Invalid AgentDefinition(${agent.id}): role이 알려진 값이 아닙니다.`);
  if (!Array.isArray(agent.capabilities) || !agent.capabilities.every(isNonEmptyString)) {
    throw new Error(`Invalid AgentDefinition(${agent.id}): capabilities는 비어있지 않은 문자열 배열이어야 합니다.`);
  }
  if (
    !Array.isArray(agent.allowedTaskTypes) ||
    agent.allowedTaskTypes.length === 0 ||
    !agent.allowedTaskTypes.every((t) => KNOWN_TASK_TYPES.has(t))
  ) {
    throw new Error(`Invalid AgentDefinition(${agent.id}): allowedTaskTypes가 비어있거나 알려지지 않은 값을 포함합니다.`);
  }
  if (!Array.isArray(agent.requiredTools) || !agent.requiredTools.every((t) => KNOWN_REQUIRED_TOOLS.has(t))) {
    throw new Error(`Invalid AgentDefinition(${agent.id}): requiredTools에 알려지지 않은 값이 있습니다.`);
  }
  if (agent.riskLevel !== "low" && agent.riskLevel !== "medium" && agent.riskLevel !== "high") {
    throw new Error(`Invalid AgentDefinition(${agent.id}): riskLevel이 알려진 값이 아닙니다.`);
  }
  if (typeof agent.canWriteCode !== "boolean" || typeof agent.canUseNetwork !== "boolean" || typeof agent.canRequestHumanApproval !== "boolean") {
    throw new Error(`Invalid AgentDefinition(${agent.id}): canWriteCode/canUseNetwork/canRequestHumanApproval는 boolean이어야 합니다.`);
  }
  if (!KNOWN_EXECUTION_MODELS.has(agent.executionModel)) {
    throw new Error(`Invalid AgentDefinition(${agent.id}): executionModel이 알려진 값이 아닙니다.`);
  }
  if (typeof agent.priority !== "number" || !Number.isFinite(agent.priority)) {
    throw new Error(`Invalid AgentDefinition(${agent.id}): priority는 유한한 숫자여야 합니다.`);
  }
  // developer 외의 role은 코드를 직접 쓸 수 없다 — Core hard rule(Safe Executor를 거치는
  // 실제 코드 작성은 developer/claude-developer.ts만의 경로). 이 검증은 어떤 policy로도
  // 우회할 수 없다(이 함수 자체가 policy를 인자로 받지 않는다).
  if (agent.canWriteCode && agent.role !== "developer") {
    throw new Error(`Invalid AgentDefinition(${agent.id}): role="${agent.role}"는 canWriteCode=true를 가질 수 없습니다(코드 작성은 developer 전용).`);
  }
}

export function validateAgentRegistry(registry: AgentRegistry): void {
  if (!Array.isArray(registry)) throw new Error("Invalid AgentRegistry: registry가 배열이 아닙니다.");
  const seenIds = new Set<string>();
  for (const agent of registry) {
    validateAgentDefinition(agent);
    if (seenIds.has(agent.id)) throw new Error(`Invalid AgentRegistry: agent id가 중복됩니다("${agent.id}").`);
    seenIds.add(agent.id);
  }
}

// =========================================================
// Core Agent Registry — 초기 6개 역할. Agent 이름/id는 프로젝트마다 달라질 수 있지만
// 역할 분리는 유지한다(요구사항). 이 목록 자체는 project policy로 대체할 수 없다 — 아래
// AgentRouterPolicy에는 이 배열을 대체/축소하는 필드가 없다(추가만 가능).
// =========================================================

export const CORE_AGENT_REGISTRY: AgentRegistry = [
  {
    id: "core-planner",
    role: "planner",
    capabilities: ["requirement_analysis", "architecture_planning", "task_breakdown"],
    allowedTaskTypes: ["architecture_design", "general"],
    requiredTools: [],
    riskLevel: "low",
    canWriteCode: false,
    canUseNetwork: false,
    canRequestHumanApproval: true,
    executionModel: "claude-read-only",
    priority: 10,
  },
  {
    id: "core-research",
    role: "research",
    capabilities: ["official_source_research", "capability_discovery_usage"],
    allowedTaskTypes: ["external_capability_research", "architecture_design"],
    requiredTools: ["capability_discovery"],
    riskLevel: "low",
    canWriteCode: false,
    canUseNetwork: true,
    canRequestHumanApproval: true,
    executionModel: "claude-read-only",
    priority: 20,
  },
  {
    id: "core-security",
    role: "security",
    capabilities: ["security_risk_review", "dependency_risk_review"],
    allowedTaskTypes: ["external_capability_research", "security_review"],
    requiredTools: ["capability_discovery", "dependency_scanner_findings"],
    riskLevel: "low",
    canWriteCode: false,
    canUseNetwork: true,
    canRequestHumanApproval: true,
    executionModel: "claude-read-only",
    priority: 25,
  },
  {
    id: "core-developer",
    role: "developer",
    capabilities: ["code_generation", "code_modification"],
    allowedTaskTypes: ["code_implementation"],
    requiredTools: ["safe_executor"],
    riskLevel: "medium",
    canWriteCode: true,
    canUseNetwork: false,
    canRequestHumanApproval: true,
    executionModel: "claude-developer",
    priority: 30,
  },
  {
    id: "core-qa",
    role: "qa",
    capabilities: ["test_planning", "verification_strategy"],
    allowedTaskTypes: ["code_implementation"],
    requiredTools: [],
    riskLevel: "low",
    canWriteCode: false,
    canUseNetwork: false,
    canRequestHumanApproval: true,
    executionModel: "claude-read-only",
    priority: 40,
  },
  {
    id: "core-reviewer",
    role: "reviewer",
    capabilities: ["independent_code_review", "severity_classification"],
    allowedTaskTypes: ["code_implementation"],
    requiredTools: ["gpt_reviewer_api"],
    riskLevel: "low",
    canWriteCode: false,
    canUseNetwork: false,
    canRequestHumanApproval: true,
    executionModel: "gpt-reviewer",
    priority: 50,
  },
];

validateAgentRegistry(CORE_AGENT_REGISTRY);

// =========================================================
// Project Policy — Core Agent의 보안권한을 임의로 확대할 수 없다(D1~D5/E1~E2와 동일한
// 설계: 추가만 가능, 대체/약화 불가). 이 타입에는 canWriteCode/canUseNetwork/
// canRequestHumanApproval/riskLevel을 바꾸는 필드 자체가 없다 — CORE_AGENT_REGISTRY의
// AgentDefinition은 이 policy로 절대 patch되지 않는다(routeTask()가 policy를 agent
// 정의에 병합하는 코드 경로 자체가 없다).
// =========================================================

export interface AgentRouterPolicy {
  /** 특정 TaskType에 대해 Core가 이미 선택한 agent 위에 추가로 포함시키고 싶은 agent id만
   *  지정할 수 있다(강화만 가능 — 이미 선택된 agent를 제거하거나 다른 agent로 대체하는
   *  필드는 없다). registry에 없는 id를 넣으면 validateAgentRouterPolicy가 throw한다. */
  additionalRequiredAgentsByTaskType?: Partial<Record<TaskType, string[]>>;
}

export function validateAgentRouterPolicy(policy: AgentRouterPolicy, registry: AgentRegistry = CORE_AGENT_REGISTRY): void {
  if (!policy || typeof policy !== "object") throw new Error("Invalid AgentRouterPolicy: policy가 비어있거나 객체가 아닙니다.");
  if (policy.additionalRequiredAgentsByTaskType !== undefined) {
    const map = policy.additionalRequiredAgentsByTaskType;
    if (!map || typeof map !== "object") {
      throw new Error("Invalid AgentRouterPolicy: additionalRequiredAgentsByTaskType가 객체가 아닙니다.");
    }
    const knownIds = new Set(registry.map((a) => a.id));
    for (const [taskType, agentIds] of Object.entries(map)) {
      if (!KNOWN_TASK_TYPES.has(taskType as TaskType)) {
        throw new Error(`Invalid AgentRouterPolicy: taskType("${taskType}")이 알려진 값이 아닙니다.`);
      }
      if (!Array.isArray(agentIds) || !agentIds.every((id) => typeof id === "string" && knownIds.has(id))) {
        throw new Error(`Invalid AgentRouterPolicy: additionalRequiredAgentsByTaskType["${taskType}"]에 알려지지 않은 agent id가 있습니다.`);
      }
    }
  }
}

// =========================================================
// Task Type 분류 — 순수 키워드 기반(policy.ts의 classifyTaskRisk/capability-resolver.ts의
// classifyRequirementDomain과 동일한 설계 스타일: deterministic, AI 미사용). 자유 텍스트
// 분류 결과는 routing의 "어떤 agent set을 후보로 볼지"에만 쓰이고, 실제 사람 승인 필요
// 여부는 policy.ts의 classifyTaskRisk/requiresHumanApproval을 그대로 재사용한다(새
// 위험 분류를 만들지 않는다).
// =========================================================

const DETERMINISTIC_ONLY_PATTERN =
  /(secret\s*scanner|dependency\s*scanner|safe\s*executor|git\s*checkpoint|시크릿\s*스캐너|의존성\s*스캐너|이미\s*정의된\s*테스트|정해진\s*테스트만|run\s*required\s*tests)/i;
const SECURITY_REVIEW_PATTERN = /(보안\s*검토|security\s*review|취약점\s*점검|vulnerability\s*audit|security\s*audit)/i;
const EXTERNAL_RESEARCH_PATTERN = /(공식\s*자료\s*조사|외부\s*capability|외부\s*api\s*조사|research\s*official|mcp\s*조사|vendor\s*조사|외부\s*소스\s*조사)/i;
const ARCHITECTURE_PATTERN = /(아키텍처|architecture|시스템\s*설계|system\s*design|설계\s*문서)/i;
const CODE_IMPLEMENTATION_PATTERN = /(구현|implement|코드\s*작성|버그\s*수정|fix\s*bug|리팩터|refactor|기능\s*추가)/i;
/** architecture_design에 "필요한 경우" research를 추가로 포함시킬지 판단하는 보조 신호 —
 *  EXTERNAL_RESEARCH_PATTERN보다 느슨하다(설계 문맥에서 "외부"/"공식 문서" 언급 정도로도
 *  research를 붙인다). */
const NEEDS_RESEARCH_HINT_PATTERN = /(외부|공식\s*문서|external|official\s*docs|vendor|타사)/i;

export function classifyTaskType(description: string): TaskType {
  if (DETERMINISTIC_ONLY_PATTERN.test(description)) return "deterministic_only";
  if (SECURITY_REVIEW_PATTERN.test(description)) return "security_review";
  if (EXTERNAL_RESEARCH_PATTERN.test(description)) return "external_capability_research";
  if (ARCHITECTURE_PATTERN.test(description)) return "architecture_design";
  if (CODE_IMPLEMENTATION_PATTERN.test(description)) return "code_implementation";
  return "general";
}

// =========================================================
// Deterministic Router.
// =========================================================

export interface RoutableTaskInput {
  id: string;
  /** task 제목/prompt 등 자유 텍스트 — taskType이 명시되지 않았을 때만 classifyTaskType()의
   *  입력으로 쓰인다. */
  description: string;
  /** 호출부가 이미 task type을 알고 있으면(예: task-registry.ts TaskDefinition 기반)
   *  명시적으로 지정한다 — 지정하면 텍스트 분류보다 우선한다(더 신뢰할 수 있는 구조화된
   *  정보를 자유 텍스트 추정보다 우선하는 설계, D2의 evidence 우선순위와 동일한 원칙). */
  taskType?: TaskType;
  /** code_implementation에서 Core(task-registry.ts의 requiredTests)가 이미 무엇을
   *  테스트할지 완전히 정해뒀다면 true로 표시한다 — true면 qa(테스트 "계획" 역할)를
   *  routing에서 제외한다("단순 deterministic test 실행을 별도 LLM Agent 호출로 낭비하지
   *  않는다"). */
  hasFixedRequiredTests?: boolean;
}

export interface RoutingStep {
  agentId: string;
  role: AgentRole;
  /** 이 단계가 논리적으로 선행돼야 하는 agent id 목록(dependency 표현) — 빈 배열이면
   *  선행 의존성이 없다. */
  dependsOn: string[];
}

export interface RoutingPlan {
  taskId: string;
  taskType: TaskType;
  /** priority 기준 deterministic하게 정렬된 단계 목록 — 동일 입력에는 항상 동일한
   *  순서/구성을 반환한다. */
  steps: RoutingStep[];
  /** policy.ts의 classifyTaskRisk/requiresHumanApproval을 그대로 재사용한 결과 — 이
   *  파일은 위험 분류 로직을 다시 만들지 않는다. true면 routing과 무관하게 사람 승인이
   *  필요하다(기존 orchestrator.ts의 동작과 동일한 게이트, 이 Task는 그 배선을 바꾸지
   *  않는다). */
  requiresHumanApproval: boolean;
  reason: string;
}

interface RolePlanStep {
  role: AgentRole;
  dependsOnRoles: AgentRole[];
}

function findAgentByRole(registry: AgentRegistry, role: AgentRole): AgentDefinition | undefined {
  return registry.find((a) => a.role === role);
}

/**
 * task 하나에 필요한 agent를 deterministic하게 선택한다. LLM을 호출하지 않고, 매번 같은
 * 입력에 같은 결과를 반환한다("동일 입력 → 동일 routing"). 순서:
 *   1) taskType 결정(명시값 우선, 없으면 classifyTaskType()).
 *   2) taskType별 정적 role 계획(§ 아래 워크플로별 role/의존성)에서 시작한다.
 *      - "deterministic_only"는 항상 빈 계획을 반환한다(Core service를 agent로 routing하지
 *        않는다).
 *      - code_implementation은 hasFixedRequiredTests===true면 qa를 뺀다.
 *      - architecture_design은 description이 NEEDS_RESEARCH_HINT_PATTERN과 일치할
 *        때만 research를 추가한다("필요한 경우 research").
 *   3) policy.additionalRequiredAgentsByTaskType으로 추가된 agent id를 더한다(추가만
 *      가능 — 기존 role 계획을 지우거나 대체하지 않는다).
 *   4) role/agent id 기준으로 중복을 제거한다(동일 task에서 불필요한 중복 호출 방지).
 *   5) registry에서 실제 AgentDefinition을 찾아 priority 오름차순으로 정렬한다
 *      (deterministic ordering의 단일 출처).
 *   6) requiresHumanApproval은 policy.ts를 그대로 재사용해 계산한다.
 */
export function routeTask(
  input: RoutableTaskInput,
  registry: AgentRegistry = CORE_AGENT_REGISTRY,
  policy?: AgentRouterPolicy
): RoutingPlan {
  const taskType = input.taskType ?? classifyTaskType(input.description);
  const rolePlan = buildRolePlan(taskType, input);

  const selectedByRole = new Map<AgentRole, RolePlanStep>();
  for (const step of rolePlan) selectedByRole.set(step.role, step);

  const additionalIds = policy?.additionalRequiredAgentsByTaskType?.[taskType] ?? [];
  for (const id of additionalIds) {
    const agent = registry.find((a) => a.id === id);
    if (agent && !selectedByRole.has(agent.role)) {
      selectedByRole.set(agent.role, { role: agent.role, dependsOnRoles: [] });
    }
  }

  // role 계획(buildRolePlan)은 이미 selectedByRole에 실제로 있는 role만 dependsOnRoles로
  // 나열하므로("§ buildRolePlan" 참고 — 각 taskType이 자신이 실제로 추가하는 role만
  // 의존성으로 선언한다) 선택되지 않은 role에 대한 의존성은 애초에 나타나지 않는다. 그래도
  // policy로 추가된 agent나 향후 변경에 대비해 selectedRoleSet으로 한 번 더 필터링한다
  // (선택되지 않은 role을 가리키는 의존성이 결과에 남지 않도록 방어).
  const selectedRoleSet = new Set(selectedByRole.keys());
  const finalSteps: RoutingStep[] = [...selectedByRole.values()]
    .map(({ role, dependsOnRoles }) => {
      const agent = findAgentByRole(registry, role);
      if (!agent) return null; // registry에 해당 role이 없으면(예: 커스텀 registry) 조용히 건너뛴다 — 추측으로 만들어내지 않는다.
      const dependsOn = dependsOnRoles
        .filter((r) => selectedRoleSet.has(r))
        .map((r) => findAgentByRole(registry, r)?.id)
        .filter((id): id is string => id !== undefined);
      return { agentId: agent.id, role, dependsOn };
    })
    .filter((s): s is RoutingStep => s !== null)
    .sort((a, b) => {
      const pa = findAgentByRole(registry, a.role)?.priority ?? Number.MAX_SAFE_INTEGER;
      const pb = findAgentByRole(registry, b.role)?.priority ?? Number.MAX_SAFE_INTEGER;
      return pa !== pb ? pa - pb : a.agentId.localeCompare(b.agentId);
    });

  const risk = classifyTaskRisk(input.description);
  const needsApproval = risk !== null && requiresHumanApproval(risk);

  return {
    taskId: input.id,
    taskType,
    steps: finalSteps,
    requiresHumanApproval: needsApproval,
    reason:
      finalSteps.length === 0
        ? `taskType=${taskType} — Core deterministic service만으로 처리 가능해 agent를 선택하지 않았습니다.`
        : `taskType=${taskType} — ${finalSteps.map((s) => s.role).join(", ")} agent를 선택했습니다.`,
  };
}

/** taskType별 정적 워크플로 — role과 그 role이 논리적으로 의존하는 다른 role을
 *  선언한다. 이 표가 "dependency 표현"의 단일 출처다. */
function buildRolePlan(taskType: TaskType, input: RoutableTaskInput): RolePlanStep[] {
  switch (taskType) {
    case "deterministic_only":
      return [];
    case "code_implementation": {
      const plan: RolePlanStep[] = [{ role: "developer", dependsOnRoles: [] }];
      if (!input.hasFixedRequiredTests) {
        plan.push({ role: "qa", dependsOnRoles: ["developer"] });
      }
      plan.push({ role: "reviewer", dependsOnRoles: input.hasFixedRequiredTests ? ["developer"] : ["developer", "qa"] });
      return plan;
    }
    case "external_capability_research":
      return [
        { role: "research", dependsOnRoles: [] },
        { role: "security", dependsOnRoles: ["research"] },
      ];
    case "security_review":
      return [{ role: "security", dependsOnRoles: [] }];
    case "architecture_design": {
      const plan: RolePlanStep[] = [{ role: "planner", dependsOnRoles: [] }];
      if (NEEDS_RESEARCH_HINT_PATTERN.test(input.description)) {
        plan.push({ role: "research", dependsOnRoles: ["planner"] });
      }
      return plan;
    }
    case "general":
    default:
      return [{ role: "planner", dependsOnRoles: [] }];
  }
}

// =========================================================
// Advisory Routing — Phase F Task F4.1. task-registry.ts의 모든 task는 정의상
// "코드를 구현하는" 작업이라, routeTask()의 taskType 기반 buildRolePlan()(하나의 taskType →
// 하나의 고정 role 조합)은 "이 code task에 추가로 planner/research/qa/security가 필요한가"
// 라는, taskType과 독립적으로 조합 가능한 질문에 맞지 않는다(F4는 이걸 무시하고 taskType을
// "code_implementation"으로 강제해 실질적으로 advisory가 항상 no-op이 되는 문제가 있었다).
//
// 이 함수는 텍스트를 다시 분류하지 않는다 — 호출부(task-registry.ts의 TaskDefinition에
// task 작성자가 명시한 needsPlanning/needsExternalResearch/needsQaAdvisory/
// needsSecurityReview)가 이미 결정한 deterministic 신호만 그대로 읽는다. 신호가 없으면
// (전부 false/undefined) steps가 빈 배열이다 — "Agent가 있으니 일단 호출"하지 않는다.
// developer/reviewer는 이 함수가 다루지 않는다(그 역할은 여전히 orchestrator.ts 전담).
// =========================================================

export interface AdvisorySignals {
  needsPlanning?: boolean;
  needsExternalResearch?: boolean;
  needsQaAdvisory?: boolean;
  needsSecurityReview?: boolean;
}

/**
 * AdvisorySignals에 명시된 role만, priority 순으로 deterministic하게 담은 RoutingPlan을
 * 만든다. 각 step은 dependsOn:[](developer/reviewer를 이 plan에 포함하지 않으므로 그
 * 어떤 role도 서로에게 의존하지 않는다 — planner/research는 pre-development, qa/security는
 * post-development에 각자 독립적으로 advisory로 개입한다). requiresHumanApproval은 이
 * 함수가 판단하지 않는다 — 호출부가 이미 policy.ts(classifyTaskRisk/requiresHumanApproval)
 * 로 고위험 여부를 확인한 뒤에만 이 함수를 부른다(§ autodev.ts).
 */
export function buildAdvisoryRoutingPlan(taskId: string, signals: AdvisorySignals, registry: AgentRegistry = CORE_AGENT_REGISTRY): RoutingPlan {
  const roles: AgentRole[] = [];
  if (signals.needsPlanning) roles.push("planner");
  if (signals.needsExternalResearch) roles.push("research");
  if (signals.needsQaAdvisory) roles.push("qa");
  if (signals.needsSecurityReview) roles.push("security");

  const steps: RoutingStep[] = roles
    .map((role): RoutingStep | null => {
      const agent = findAgentByRole(registry, role);
      return agent ? { agentId: agent.id, role, dependsOn: [] as string[] } : null;
    })
    .filter((s): s is RoutingStep => s !== null)
    .sort((a, b) => {
      const pa = findAgentByRole(registry, a.role)?.priority ?? Number.MAX_SAFE_INTEGER;
      const pb = findAgentByRole(registry, b.role)?.priority ?? Number.MAX_SAFE_INTEGER;
      return pa !== pb ? pa - pb : a.agentId.localeCompare(b.agentId);
    });

  return {
    taskId,
    taskType: "general",
    steps,
    requiresHumanApproval: false,
    reason:
      steps.length === 0
        ? "advisory signal이 지정되지 않아 agent를 선택하지 않았습니다."
        : `advisory signal에 따라 ${steps.map((s) => s.role).join(", ")} agent를 선택했습니다.`,
  };
}
