import { existsSync, statSync, lstatSync, mkdirSync, writeFileSync, readFileSync, renameSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isRealPathWithin } from "./project-bootstrap";
import type { BootstrapRequestIdentity, BootstrapStage } from "./project-bootstrap";
import { scanContentForSecrets } from "./secret-scanner";
import { validateProjectManifest } from "./project-manifest";
import type { ProjectManifest } from "./project-manifest";
import { validateProjectExecutionPolicy } from "./project-policy";
import type { ProjectExecutionPolicy, AllowedCommandSpec } from "./project-policy";
import { getNextTask } from "./task-registry";
import type { TaskDefinition, RequiredTestCommand } from "./task-registry";
import { runClaudeTask } from "./claude-runner";
import { acquireProjectLock, releaseProjectLock } from "./project-lock";

// AutoDev Core 선행 업그레이드 — Planner → AutoDev Execution Data Synthesis + E2E (SI-3).
//
// SI-1(spec-intake.ts)은 Handoff를 받아들일지 판정만 하고, SI-2(project-bootstrap.ts)는
// 그 판정을 실제 project root 생성 + Master Spec 보존으로 실행한다. 이 모듈은 그 다음 단계다
// — SI-2가 안전하게 보존한 APPROVED Master Spec(WHAT)을, AutoDev가 실제로 실행할 수 있는
// Phase/Task/ExecutionPolicy(HOW)로 변환한다. Master Spec이 HOW를 정하지 않는다 — 이
// Planner가 정한다. 이 모듈은 이번 Task에서 실제 JARVIS/MOVAN/BILLION 프로젝트를 전혀
// 언급하지 않는다 — 항상 이미 존재하는(SI-2가 만든) projectRoot를 외부에서 주입받는다.
//
// 신뢰 경계 — runPlanner()는 원본 HandoffEnvelope JSON을 다시 받지 않는다. SI-2가 이미
// projectRoot/.autodev/bootstrap-state.json + projectRoot/.autodev/master-spec/
// {spec.md,manifest.json}에 검증된 결과를 영구 보존했으므로, Planner의 신뢰 입력은
// "파일시스템(SI-2의 출력)"이다 — 이 함수는 그 파일들을 직접 다시 읽고, spec.md의 실제
// digest를 재계산해 manifest.json의 storedContentDigest와 대조하며, specStatus/
// userApproval/reviewerGate/unresolvedCriticalCount/contradictionCount 게이트를 전부
// 다시 확인한다(§ evaluateTrustedPlannerInput). 호출부가 넘기는 expectedIdentity와
// 실제로 읽은 identity가 하나라도 다르면 즉시 BLOCK한다 — 어떤 값도 추측하지 않는다.
//
// Master Spec 정규화(normalizeMasterSpec)는 LLM을 쓰지 않는 순수 deterministic 파서다 —
// "## <Section Name>" 헤더 + "- " 목록 항목이라는 최소 관례를 따르는 Master Spec 본문에서
// REQ-*/AC-*/FC-*/DEF-*/OOS-* 안정 id를 자동 채번한다(WHAT 추출은 항상 재현 가능해야
// 하므로 LLM에 맡기지 않는다). "HOW"(architecture/phase/task/execution policy)만 LLM(또는
// 테스트의 deterministic fixture)이 만든 rawOutputSource로 생성하고, 그 결과는 반드시
// validatePlannerRawOutput()(순수 함수, 첫 실패에서 멈추지 않고 위반 사항을 전부 모음)을
// 통과해야 한다 — LLM의 추측을 자동 승인하지 않는다(§ 요구사항 16). LLM 호출 자체는 새
// provider system을 만들지 않고 claude-runner.ts의 runClaudeTask를 그대로 감싼다
// (createClaudeCliRawOutputSource) — agent-orchestrator.ts의 realReadOnlyAgentRunner와
// 동일한 재사용 원칙.
//
// Phase/Task id는 이미 이 저장소가 쓰는 관례("{phase}.{taskNumber}", task-registry.ts 상단
// 주석)를 그대로 따른다 — phaseId는 "1","2",... 형태의 양의 정수 문자열, taskId는
// "{phaseId}.{taskNumber}" 형태다. 새 id 스킴을 만들지 않는다.
//
// 이 모듈은 project-manifest.ts/task-registry.ts/project-policy.ts의 타입과 검증 함수를
// 그대로 재사용한다 — 병렬 Manifest/Registry 시스템을 만들지 않는다. 생성된 실행 데이터는
// projectRoot/.autodev/ 아래(project-manifest.json/task-registry.json/execution-policy.json/
// planner-state.json)에 저장된다 — AutoDev Core 저장소(automation/)에는 어떤 파일도 만들지
// 않는다.

// ---------------------------------------------------------------------------
// Master Spec 정규화 — 순수 deterministic 파서(LLM 없음).
// ---------------------------------------------------------------------------

export type RequirementCategory =
  | "must_have"
  | "functional"
  | "non_functional"
  | "security"
  | "privacy"
  | "data"
  | "integration"
  | "user_role"
  | "performance"
  | "platform";

export interface NormalizedRequirementItem {
  id: string;
  text: string;
  category: RequirementCategory;
  mustHave: boolean;
}

export interface AcceptanceCriterionItem {
  id: string;
  text: string;
}

export type FixedConstraintKind = "fixed_decision" | "explicit_constraint";

export interface FixedConstraintItem {
  id: string;
  text: string;
  kind: FixedConstraintKind;
}

export interface DeferredItemEntry {
  id: string;
  text: string;
}

export interface OutOfScopeItemEntry {
  id: string;
  text: string;
}

export interface NormalizedMasterSpec {
  projectGoal: string;
  productScope: string;
  requirements: NormalizedRequirementItem[];
  acceptanceCriteria: AcceptanceCriterionItem[];
  fixedConstraints: FixedConstraintItem[];
  deferredItems: DeferredItemEntry[];
  outOfScope: OutOfScopeItemEntry[];
  unresolvedItems: string[];
  /** GPT Independent Reviewer 지적(SI-3 REVISE 1회차, HIGH) — "## <Section Name>" 관례를
   *  따르지 않는(또는 오타가 있는) 헤더 아래의 내용은 이전에는 조용히 버려졌다 — Fixed
   *  Decisions/Must-have Requirements가 실수로 다른 이름의 헤더 아래 적혔다면 WHAT 자체가
   *  Planner 모르게 누락될 수 있었다. 알려진 18개 섹션 이름과 일치하지 않는 "## ..." 헤더가
   *  하나라도 있으면 여기 기록되고, runPlanner()가 이를 즉시 BLOCK한다(침묵하는 손실 대신
   *  fail closed) — 정상 Master Spec은 이 배열이 항상 비어있어야 한다. */
  unrecognizedHeaders: string[];
}

type SectionKind =
  | "goal"
  | "scope"
  | "requirement"
  | "ac"
  | "fixed_decision"
  | "explicit_constraint"
  | "deferred"
  | "unresolved"
  | "outofscope";

interface SectionSpec {
  kind: SectionKind;
  category?: RequirementCategory;
  mustHave?: boolean;
}

// Master Spec 본문의 "## <Section Name>" 관례 — 이 표만이 인식되는 section이다(알려지지
// 않은 헤더의 본문은 조용히 무시된다, 요구사항을 몰래 지어내지 않기 위해 무엇이든 "그 외"로
// 뭉뚱그려 REQ로 만들지 않는다).
const SECTION_SPECS: Record<string, SectionSpec> = {
  "Project Goal": { kind: "goal" },
  "Product Scope": { kind: "scope" },
  "Must-have Requirements": { kind: "requirement", category: "must_have", mustHave: true },
  "Functional Requirements": { kind: "requirement", category: "functional", mustHave: false },
  "Non-functional Requirements": { kind: "requirement", category: "non_functional", mustHave: false },
  "Security Requirements": { kind: "requirement", category: "security", mustHave: false },
  "Privacy Requirements": { kind: "requirement", category: "privacy", mustHave: false },
  "Data Requirements": { kind: "requirement", category: "data", mustHave: false },
  "External Integrations": { kind: "requirement", category: "integration", mustHave: false },
  "User / Role Requirements": { kind: "requirement", category: "user_role", mustHave: false },
  "Performance Requirements": { kind: "requirement", category: "performance", mustHave: false },
  "Platform Requirements": { kind: "requirement", category: "platform", mustHave: false },
  "Acceptance Criteria": { kind: "ac" },
  "Fixed Decisions": { kind: "fixed_decision" },
  "Deferred Items": { kind: "deferred" },
  "Unresolved Items": { kind: "unresolved" },
  "Explicit Constraints": { kind: "explicit_constraint" },
  "Out-of-scope": { kind: "outofscope" },
};

// GPT Independent Reviewer 지적(SI-3 REVISE 2~3회차, HIGH) — "^##\s+"만 헤더로 인식하면
// "### Fixed Decisions"/"# Fixed Decisions"처럼 hash 개수나 공백이 살짝 다른 오타는 헤더로
// 아예 인식되지 않아, current가 바뀌지 않은 채 그 아래 "- ..." 항목들이 직전(엉뚱한) 섹션의
// 항목으로 잘못 흡수될 수 있었다(silent-drop보다 더 나쁜 silent-misattribution — fail-closed가
// 아니었다). 1~6개의 '#'로 시작하는 모든 줄을 "헤더를 시도한 줄"로 넓게 인식하고, 정확히
// "## <알려진 섹션 이름>" 형태가 아니면 unrecognizedHeaders에 기록함과 동시에 current를
// 즉시 null로 되돌린다 — 이후 내용이 엉뚱한 이전 섹션에 계속 쌓이는 것을 막는다(그 다음 줄부터
// 다음 진짜 헤더가 나올 때까지는 완전히 버려질 뿐 다른 섹션으로 흡수되지 않는다).
//
// 3회차 지적 — 이 정규식이 줄의 맨 앞(`^`)에서만 '#'를 찾으므로 "   ### Fixed Decisions"처럼
// 앞에 공백이 있는(Markdown 표준상 유효한 최대 3칸 들여쓰기 헤더 포함) 헤더 시도는 여전히
// 놓쳤다 — current가 이전 섹션에 머문 채 같은 misattribution이 재현될 수 있었다. 정규식
// 자체를 복잡하게 만드는 대신, 호출부에서 매 줄을 먼저 trimStart()한 뒤 이 정규식을 적용한다
// (Markdown의 "0~3칸까지만 허용"보다 더 엄격하게 "앞에 공백이 몇 칸이든" 모두 정규화한다 —
// 관대한 예외를 만들지 않는다). 이 저장소는 이 Master Spec 관례를 스스로 정의하므로("## "
// 헤더가 항상 줄의 실제 시작이어야 한다), 자유 형식 문서 제목(예: 첫 줄의 "# JARVIS")도
// 예외 없이 동일하게 미인식 헤더로 취급해 BLOCK한다 — 모든 내용은 정의된 "## <Section>"
// 안에 있어야 한다는 요구사항을 예외 없이 강제한다(정당한 회귀가 아니라 의도된 제약이며,
// 테스트로 명시적으로 고정한다).
const HEADER_LOOKALIKE_RE = /^(#{1,6})[ \t]*(.*?)\s*$/;
const LIST_ITEM_RE = /^-\s+(.+)$/;

/**
 * "## <Section Name>" + "- <내용>" 관례를 따르는 Master Spec 본문을 파싱해 안정적인
 * REQ-, AC-, FC-, DEF-, OOS- id를 자동 채번한다. 순수 함수 — 파일시스템/네트워크/LLM을
 * 전혀 쓰지 않으며 동일 입력에는 항상 동일 결과를 반환한다. 이 관례를 벗어난 헤더 시도(§
 * HEADER_LOOKALIKE_RE 주석)는 unrecognizedHeaders에 기록되고 그 아래 내용은 어떤 섹션에도
 * 흡수되지 않는다(runPlanner()가 이를 즉시 BLOCK한다) — Unresolved Items만 자유 텍스트
 * 목록으로 정보성으로 보존된다(§ 요구사항 2: Unresolved Items).
 */
export function normalizeMasterSpec(content: string): NormalizedMasterSpec {
  const result: NormalizedMasterSpec = {
    projectGoal: "",
    productScope: "",
    requirements: [],
    acceptanceCriteria: [],
    fixedConstraints: [],
    deferredItems: [],
    outOfScope: [],
    unresolvedItems: [],
    unrecognizedHeaders: [],
  };

  let reqCounter = 0;
  let acCounter = 0;
  let fcCounter = 0;
  let defCounter = 0;
  let oosCounter = 0;
  const pad3 = (n: number) => String(n).padStart(3, "0");

  let current: SectionSpec | null = null;
  const goalLines: string[] = [];
  const scopeLines: string[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const headerMatch = HEADER_LOOKALIKE_RE.exec(rawLine.trimStart());
    if (headerMatch) {
      const hashes = headerMatch[1];
      const name = headerMatch[2];
      const spec = hashes === "##" ? SECTION_SPECS[name] : undefined;
      if (!spec) result.unrecognizedHeaders.push(rawLine.trim().slice(0, 200));
      current = spec ?? null; // 인식 실패 시 이전 섹션으로 오귀속되지 않도록 즉시 초기화됨
      continue;
    }
    if (!current) continue;

    if (current.kind === "goal") {
      const t = rawLine.trim();
      if (t.length > 0) goalLines.push(t);
      continue;
    }
    if (current.kind === "scope") {
      const t = rawLine.trim();
      if (t.length > 0) scopeLines.push(t);
      continue;
    }

    const itemMatch = LIST_ITEM_RE.exec(rawLine.trim());
    if (!itemMatch) continue;
    const text = itemMatch[1].trim();
    if (text.length === 0) continue;

    switch (current.kind) {
      case "requirement": {
        reqCounter += 1;
        result.requirements.push({
          id: `REQ-${pad3(reqCounter)}`,
          text,
          category: current.category as RequirementCategory,
          mustHave: current.mustHave === true,
        });
        break;
      }
      case "ac": {
        acCounter += 1;
        result.acceptanceCriteria.push({ id: `AC-${pad3(acCounter)}`, text });
        break;
      }
      case "fixed_decision":
      case "explicit_constraint": {
        fcCounter += 1;
        result.fixedConstraints.push({ id: `FC-${pad3(fcCounter)}`, text, kind: current.kind });
        break;
      }
      case "deferred": {
        defCounter += 1;
        result.deferredItems.push({ id: `DEF-${pad3(defCounter)}`, text });
        break;
      }
      case "outofscope": {
        oosCounter += 1;
        result.outOfScope.push({ id: `OOS-${pad3(oosCounter)}`, text });
        break;
      }
      case "unresolved": {
        result.unresolvedItems.push(text);
        break;
      }
      default:
        break;
    }
  }

  result.projectGoal = goalLines.join(" ");
  result.productScope = scopeLines.join(" ");
  return result;
}

// ---------------------------------------------------------------------------
// Planner Raw Output — LLM(또는 fixture)이 만드는 HOW. 반드시 validatePlannerRawOutput()을
// 통과해야만 신뢰된다.
// ---------------------------------------------------------------------------

export interface PlannerRawTechnologyChoice {
  area: string;
  decision: string;
  reason: string;
  source: string;
  status: "proposed" | "confirmed";
}

export interface PlannerRawFixedConstraintAck {
  id: string;
  value: string;
}

export interface PlannerRawPhase {
  phaseId: string;
  name: string;
  objective: string;
  dependsOn: string[];
  completionCriteria: string[];
}

export interface PlannerRawTask {
  taskId: string;
  phaseId: string;
  title: string;
  objective: string;
  scope: string[];
  constraints: string[];
  dependsOn: string[];
  expectedModules: string[];
  requiredTests: RequiredTestCommand[];
  acceptanceCriteria: string[];
  reqIds: string[];
  securityConsiderations: string[];
  completionGate: string;
}

export interface PlannerRawExecutionPolicy {
  allowedReadPrefixes: string[];
  allowedWritePrefixes: string[];
  commandCwdAliases?: Record<string, string>;
  allowedCommands: AllowedCommandSpec[];
}

export interface PlannerRawOutput {
  projectId: string;
  specVersion: string;
  architectureSummary: string;
  technologyChoices: PlannerRawTechnologyChoice[];
  fixedConstraintAcknowledgement: PlannerRawFixedConstraintAck[];
  modulesOrComponents: string[];
  integrations: string[];
  securityRequirementsSummary: string[];
  testingRequirementsSummary: string[];
  deliveryConstraintsSummary: string[];
  phases: PlannerRawPhase[];
  tasks: PlannerRawTask[];
  executionPolicy: PlannerRawExecutionPolicy;
}

// ---------------------------------------------------------------------------
// Deterministic Planner Output Validator — LLM 출력을 절대 그대로 신뢰하지 않는다.
// ---------------------------------------------------------------------------

export type PlannerValidationIssueCode =
  | "MALFORMED_JSON"
  | "INVALID_STRUCTURE"
  | "PROJECT_ID_MISMATCH"
  | "SPEC_VERSION_MISMATCH"
  | "DUPLICATE_PHASE_ID"
  | "DUPLICATE_TASK_ID"
  | "UNKNOWN_PHASE_REFERENCE"
  | "MISSING_DEPENDENCY"
  | "DEPENDENCY_CYCLE"
  | "MISSING_MUST_HAVE_COVERAGE"
  | "MISSING_ACCEPTANCE_CRITERIA_COVERAGE"
  | "UNKNOWN_REQUIREMENT_REFERENCE"
  | "DEFERRED_OR_OUT_OF_SCOPE_REFERENCED"
  | "FIXED_CONSTRAINT_ACKNOWLEDGEMENT_MISSING"
  | "FIXED_CONSTRAINT_VIOLATION"
  | "UNSAFE_EXECUTION_POLICY"
  | "DESTRUCTIVE_COMMAND_REQUESTED"
  | "PRODUCTION_DEPLOY_REQUESTED"
  | "SECRET_SHAPED_OUTPUT";

export interface PlannerValidationIssue {
  code: PlannerValidationIssueCode;
  detail: string;
}

const PHASE_ID_RE = /^[1-9]\d*$/;
const TASK_ID_RE = /^([1-9]\d*)\.([1-9]\d*)$/;
// normalizeMasterSpec()이 채번하는 REQ-/AC-/FC-/DEF-/OOS- id 계열 전체를 넓게 포괄하는 형태
// — safeEchoValue()가 "이 필드는 이런 id 계열이어야 한다"는 것만 알고 있을 때 쓴다. GPT
// Independent Reviewer 지적(SI-3 REVISE 2회차, HIGH) — 구조 검증에 실제로 쓰이는
// PHASE_ID_RE/TASK_ID_RE는 자릿수 상한이 없어(예: 32자리 숫자) echo 허용 판단에 그대로
// 쓰면 긴 숫자 토큰까지 "id처럼 보인다"는 이유로 원문 그대로 노출될 수 있었다. echo 판단
// 전용으로 자릿수 상한을 더한 별도 shape를 둔다(실제 phase/task id 구조 검증 로직
// PHASE_ID_RE/TASK_ID_RE 자체는 바꾸지 않는다 — echo 여부 판단과 구조 검증은 다른 문제다).
const ID_FAMILY_SHAPE = /^[A-Z]{2,4}-\d{1,6}$/;
const PHASE_ID_ECHO_SHAPE = /^[1-9]\d{0,5}$/;
const TASK_ID_ECHO_SHAPE = /^[1-9]\d{0,5}\.[1-9]\d{0,5}$/;
const COMMAND_NAME_SHAPE = /^[a-z][a-z0-9_-]{0,14}$/;
// "./"(프로젝트 전체)도 형식상으로는 안전한 상대경로이므로 여기서는 통과시킨다 — 최소 권한
// 위반(전체 접근) 판정은 이 뒤에서 allPrefixes.includes("./")로 별도로 명시적 검사한다.
const RELATIVE_DIR_PREFIX_RE = /^[^/][^:]*\/$/;

function isSafeScopePrefix(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!value.endsWith("/")) return false;
  if (value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) return false;
  if (value.split("/").includes("..")) return false;
  return RELATIVE_DIR_PREFIX_RE.test(value);
}

// Core는 git commit/checkpoint를 전담한다(checkpoint.ts) — task 레벨 allowedCommands에
// git이 들어오면 그 자체로 위험 신호이므로(예: git reset/push --force/rebase 등 어떤
// 서브커맨드든), 서브커맨드를 파싱하지 않고 command==="git" 자체를 항상 거부한다.
const DANGEROUS_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "git",
  "rm",
  "del",
  "rmdir",
  "sudo",
  "shutdown",
  "reboot",
  "format",
  "dd",
  "curl",
  "wget",
  "ssh",
  "scp",
  "powershell",
  "cmd",
]);
const DEPLOY_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "docker",
  "kubectl",
  "terraform",
  "gcloud",
  "aws",
  "az",
  "vercel",
  "netlify",
  "serverless",
]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// GPT Independent Reviewer 지적(SI-3 REVISE 1~2회차, HIGH) — LLM이 제공한 값(reqId/acId/
// dependsOn 항목/명령 인자 등)이 알려진 id 형식과 일치하지 않을 때 REJECTED issue의 detail에
// 그대로 echo됐다. 1회차 수정(길이 제한 + 허용 문자만 남김)은 짧고(≤60자) 허용 문자로만
// 구성된 secret-shaped 값(예: 32자 hex API key)을 여전히 그대로 통과시켰다 — "잘라내고
// 문자를 치환"하는 것은 원문 노출을 줄일 뿐 막지는 못한다. 이제는 원문을 절대 echo하지
// 않는다 — 그 필드에서 기대되는 정확한 형식(REQ-001/1.1/1 등, expectedShape)과 정확히
// 일치할 때만 원문을 그대로 보여주고(디버깅 편의), 그렇지 않으면(형식 미지정 포함) 원문
// 대신 비가역 SHA-256 digest 앞 12자만 남긴다 — 같은 잘못된 값이 반복되는지 구분할 수는
// 있지만 원문을 복원할 수는 없다(scanContentForSecrets가 이미 알려진 패턴을 잡는 것과
// 별개로, 이 함수는 "알려지지 않은 형태의 짧은 secret"까지 구조적으로 차단한다).
function safeEchoValue(value: unknown, expectedShape?: RegExp): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (expectedShape && raw.length <= 64 && expectedShape.test(raw)) {
    return raw;
  }
  const digest = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 12);
  return `<값이 예상 형식과 달라 원문 대신 비가역 digest만 기록 — sha256:${digest}, 길이 ${raw.length}자>`;
}

/** 그래프에 사이클이 있는지 DFS로 판정한다(방문 상태 3분류: 미방문/방문중/완료). */
function hasCycle(nodeIds: string[], edges: Map<string, string[]>): boolean {
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    const s = state.get(id) ?? 0;
    if (s === 1) return true; // 방문중인 노드를 다시 만남 — 사이클
    if (s === 2) return false;
    state.set(id, 1);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue; // 존재하지 않는 참조는 별도 검사(MISSING_DEPENDENCY)가 담당
      if (visit(next)) return true;
    }
    state.set(id, 2);
    return false;
  };
  for (const id of nodeIds) {
    if (visit(id)) return true;
  }
  return false;
}

function structuralGuard(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// A. Transport Normalization — LLM이 "JSON만 출력하라"는 지시를 어기고 설명문을 앞뒤에
// 붙이거나 markdown ```json fence로 감싸는 경우를 다룬다. 원본 raw JSON은 항상 그대로
// 허용하고, 정확히 하나의 markdown 코드 펜스만 존재하며 그 언어 태그가 비어있거나 "json"일
// 때만 그 안의 내용을 후보로 추출한다 — 코드 펜스가 0개/2개 이상이거나(여러 JSON 후보/
// 애매함) 언어 태그가 다른 경우(예: ```yaml)는 추출을 포기하고 원문 그대로 strict
// JSON.parse에 맡겨 실패시킨다(느슨하게 만들지 않는다 — 애매하면 거부). 이 함수는 key/값을
// 전혀 들여다보지 않는다(schema validation과 완전히 분리) — 순수하게 "어디까지가 JSON
// 텍스트인가"만 판정하는 순수 함수다.
// ---------------------------------------------------------------------------
const MARKDOWN_FENCE_RE = /```([A-Za-z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;

function extractJsonPayload(rawText: string): { ok: true; jsonText: string } | { ok: false; reason: string } {
  const trimmedFull = rawText.trim();
  try {
    JSON.parse(trimmedFull);
    return { ok: true, jsonText: trimmedFull };
  } catch {
    // raw 전체가 바로 JSON이 아니면 아래에서 코드 펜스 추출을 시도한다.
  }

  const fences = [...rawText.matchAll(MARKDOWN_FENCE_RE)];
  if (fences.length !== 1) {
    return {
      ok: false,
      reason:
        fences.length === 0
          ? "raw JSON도 아니고 markdown 코드 펜스도 없습니다."
          : `markdown 코드 펜스가 ${fences.length}개 발견되어 어떤 것이 실제 출력인지 모호합니다.`,
    };
  }
  const [, tag, body] = fences[0];
  const normalizedTag = tag.trim().toLowerCase();
  if (normalizedTag !== "" && normalizedTag !== "json") {
    return { ok: false, reason: `단일 코드 펜스의 언어 태그가 json이 아닙니다(태그: ${normalizedTag.slice(0, 20)}).` };
  }
  return { ok: true, jsonText: body.trim() };
}

// ---------------------------------------------------------------------------
// B. 엄격한 key/type 스키마 — 허용된 key만 통과시킨다. 추가/오타/깨진(garbled) key나 누락된
// 필수 key, 잘못된 타입을 자동으로 보정하지 않고 그대로 거부한다(§ issues.push만 하고 계속
// 진행 — validatePlannerRawOutput() 전체 원칙과 동일하게 첫 위반에서 멈추지 않는다).
// ---------------------------------------------------------------------------
const TOP_LEVEL_KEYS = [
  "projectId", "specVersion", "architectureSummary", "technologyChoices",
  "fixedConstraintAcknowledgement", "modulesOrComponents", "integrations",
  "securityRequirementsSummary", "testingRequirementsSummary", "deliveryConstraintsSummary",
  "phases", "tasks", "executionPolicy",
] as const;
const TECH_CHOICE_KEYS = ["area", "decision", "reason", "source", "status"] as const;
const ACK_KEYS = ["id", "value"] as const;
const PHASE_KEYS = ["phaseId", "name", "objective", "dependsOn", "completionCriteria"] as const;
const TASK_KEYS = [
  "taskId", "phaseId", "title", "objective", "scope", "constraints", "dependsOn",
  "expectedModules", "requiredTests", "acceptanceCriteria", "reqIds",
  "securityConsiderations", "completionGate",
] as const;
const REQUIRED_TEST_KEYS = ["name", "command", "args", "cwd"] as const;
const EXECUTION_POLICY_KEYS = ["allowedReadPrefixes", "allowedWritePrefixes", "commandCwdAliases", "allowedCommands"] as const;
const ALLOWED_COMMAND_KEYS = ["cwd", "command", "args"] as const;

function checkExactKeys(container: string, obj: Record<string, unknown>, allowed: readonly string[], issues: PlannerValidationIssue[]): void {
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) {
    issues.push({
      code: "INVALID_STRUCTURE",
      detail: `${container}에 허용되지 않는 key가 있습니다: ${unknown.map((k) => String(k).slice(0, 60)).join(", ")}`,
    });
  }
}
function checkRequiredString(container: string, obj: Record<string, unknown>, key: string, issues: PlannerValidationIssue[]): void {
  if (!isNonEmptyString(obj[key])) {
    issues.push({ code: "INVALID_STRUCTURE", detail: `${container}.${key}가 비어있거나 문자열이 아닙니다.` });
  }
}
function checkRequiredStringArray(container: string, obj: Record<string, unknown>, key: string, issues: PlannerValidationIssue[]): void {
  if (!isStringArray(obj[key])) {
    issues.push({ code: "INVALID_STRUCTURE", detail: `${container}.${key}가 문자열 배열이 아닙니다.` });
  }
}

/**
 * rawText(LLM/fixture가 반환한 JSON 문자열)를 normalized(WHAT)와 trusted identity 기준으로
 * 검증한다 — 첫 실패에서 멈추지 않고 발견한 위반을 전부 모아 반환한다(spec-intake.ts와 동일
 * 원칙). 통과해야만 { ok: true, value, normalizedJsonText }를 반환한다. 이 함수는
 * 파일시스템/네트워크에 전혀 접근하지 않는 순수 함수다.
 *
 * normalizedJsonText는 extractJsonPayload()가 rawText(설명문/markdown fence가 섞여 있을 수
 * 있는 원문)에서 뽑아낸 "순수 JSON 텍스트"다 — 호출부(runPlanner)는 원본 rawText가 아니라
 * 반드시 이 값을 다음 단계(rawPlannerOutput 저장/JSON.parse)에 써야 한다. 원본 rawText를
 * 그대로 저장하면, transport normalization이 이 함수 안에서만 일어나고 저장은 fence가 섞인
 * 원문으로 되어 나중에(EXECUTION_DATA_GENERATED 생성 시점) 다시 strict JSON.parse가 실패하는
 * 모순이 생긴다.
 */
export function validatePlannerRawOutput(
  rawText: string,
  normalized: NormalizedMasterSpec,
  trusted: { projectId: string; specVersion: string }
): { ok: true; value: PlannerRawOutput; normalizedJsonText: string } | { ok: false; issues: PlannerValidationIssue[] } {
  const issues: PlannerValidationIssue[] = [];

  // secret 패턴은 구조 파싱보다 먼저 원문 그대로 검사한다 — JSON 파싱 실패로 조기 반환해도
  // secret-shaped 텍스트가 rawText 안에 있었다는 사실 자체는 놓치지 않는다.
  const secretFindings = scanContentForSecrets(rawText, "<planner-raw-output>");
  if (secretFindings.length > 0) {
    issues.push({
      code: "SECRET_SHAPED_OUTPUT",
      detail: `Planner 출력에서 secret으로 의심되는 패턴이 발견됐습니다(${secretFindings.length}건). 원문은 기록하지 않습니다.`,
    });
  }

  const extraction = extractJsonPayload(rawText);
  if (!extraction.ok) {
    issues.push({
      code: "MALFORMED_JSON",
      detail: `Planner 출력에서 신뢰할 수 있는 단일 JSON을 찾지 못했습니다: ${extraction.reason}`,
    });
    return { ok: false, issues };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(extraction.jsonText);
  } catch {
    issues.push({ code: "MALFORMED_JSON", detail: "추출된 JSON 후보가 올바른 JSON이 아닙니다." });
    return { ok: false, issues };
  }
  if (!structuralGuard(parsed)) {
    issues.push({ code: "INVALID_STRUCTURE", detail: "Planner 출력이 객체가 아닙니다." });
    return { ok: false, issues };
  }
  const raw = parsed as Record<string, unknown>;

  checkExactKeys("Planner 출력", raw, TOP_LEVEL_KEYS, issues);
  checkRequiredStringArray("Planner 출력", raw, "modulesOrComponents", issues);
  checkRequiredStringArray("Planner 출력", raw, "integrations", issues);
  checkRequiredStringArray("Planner 출력", raw, "securityRequirementsSummary", issues);
  checkRequiredStringArray("Planner 출력", raw, "testingRequirementsSummary", issues);
  checkRequiredStringArray("Planner 출력", raw, "deliveryConstraintsSummary", issues);

  if (!Array.isArray(raw.technologyChoices)) {
    issues.push({ code: "INVALID_STRUCTURE", detail: "technologyChoices가 배열이 아닙니다." });
  } else {
    raw.technologyChoices.forEach((tc, idx) => {
      if (!structuralGuard(tc)) {
        issues.push({ code: "INVALID_STRUCTURE", detail: `technologyChoices[${idx}]가 객체가 아닙니다.` });
        return;
      }
      checkExactKeys(`technologyChoices[${idx}]`, tc, TECH_CHOICE_KEYS, issues);
      checkRequiredString(`technologyChoices[${idx}]`, tc, "area", issues);
      checkRequiredString(`technologyChoices[${idx}]`, tc, "decision", issues);
      checkRequiredString(`technologyChoices[${idx}]`, tc, "reason", issues);
      checkRequiredString(`technologyChoices[${idx}]`, tc, "source", issues);
      if (tc.status !== "proposed" && tc.status !== "confirmed") {
        issues.push({ code: "INVALID_STRUCTURE", detail: `technologyChoices[${idx}].status가 "proposed"/"confirmed"가 아닙니다.` });
      }
    });
  }

  if (raw.projectId !== trusted.projectId) {
    issues.push({ code: "PROJECT_ID_MISMATCH", detail: "Planner 출력의 projectId가 신뢰된 identity와 일치하지 않습니다." });
  }
  if (raw.specVersion !== trusted.specVersion) {
    issues.push({ code: "SPEC_VERSION_MISMATCH", detail: "Planner 출력의 specVersion이 신뢰된 identity와 일치하지 않습니다." });
  }
  if (!isNonEmptyString(raw.architectureSummary)) {
    issues.push({ code: "INVALID_STRUCTURE", detail: "architectureSummary가 비어있습니다." });
  }
  if (!Array.isArray(raw.phases)) {
    issues.push({ code: "INVALID_STRUCTURE", detail: "phases가 배열이 아닙니다." });
  }
  if (!Array.isArray(raw.tasks)) {
    issues.push({ code: "INVALID_STRUCTURE", detail: "tasks가 배열이 아닙니다." });
  }
  if (!structuralGuard(raw.executionPolicy)) {
    issues.push({ code: "INVALID_STRUCTURE", detail: "executionPolicy가 객체가 아닙니다." });
  }
  if (!Array.isArray(raw.fixedConstraintAcknowledgement)) {
    issues.push({ code: "INVALID_STRUCTURE", detail: "fixedConstraintAcknowledgement가 배열이 아닙니다." });
  }

  // 아래부터는 최소 구조가 확보된 필드만 더 깊이 검사한다(구조 자체가 깨졌으면 그 필드에
  // 대한 세부 검사는 의미가 없으므로 건너뛴다 — 이미 위에서 INVALID_STRUCTURE를 기록했다).
  const phases: PlannerRawPhase[] = Array.isArray(raw.phases) ? (raw.phases as PlannerRawPhase[]) : [];
  const tasks: PlannerRawTask[] = Array.isArray(raw.tasks) ? (raw.tasks as PlannerRawTask[]) : [];

  const phaseIds = new Set<string>();
  const phaseEdges = new Map<string, string[]>();
  for (const p of phases) {
    if (!structuralGuard(p as unknown as Record<string, unknown>) || !PHASE_ID_RE.test(String(p.phaseId))) {
      issues.push({ code: "INVALID_STRUCTURE", detail: `phase id 형식이 올바르지 않습니다: ${safeEchoValue(p?.phaseId)}` });
      continue;
    }
    const pObj = p as unknown as Record<string, unknown>;
    checkExactKeys(`phase "${p.phaseId}"`, pObj, PHASE_KEYS, issues);
    checkRequiredString(`phase "${p.phaseId}"`, pObj, "name", issues);
    checkRequiredString(`phase "${p.phaseId}"`, pObj, "objective", issues);
    checkRequiredStringArray(`phase "${p.phaseId}"`, pObj, "dependsOn", issues);
    checkRequiredStringArray(`phase "${p.phaseId}"`, pObj, "completionCriteria", issues);

    if (phaseIds.has(p.phaseId)) {
      issues.push({ code: "DUPLICATE_PHASE_ID", detail: `phaseId가 중복됩니다: ${p.phaseId}` });
    }
    phaseIds.add(p.phaseId);
    phaseEdges.set(p.phaseId, isStringArray(p.dependsOn) ? p.dependsOn : []);
  }
  for (const p of phases) {
    if (!phaseIds.has(p.phaseId)) continue;
    for (const dep of isStringArray(p.dependsOn) ? p.dependsOn : []) {
      if (!phaseIds.has(dep)) {
        issues.push({ code: "MISSING_DEPENDENCY", detail: `phase "${p.phaseId}"가 존재하지 않는 phase에 의존합니다: ${safeEchoValue(dep, PHASE_ID_ECHO_SHAPE)}` });
      }
    }
  }
  if (hasCycle([...phaseIds], phaseEdges)) {
    issues.push({ code: "DEPENDENCY_CYCLE", detail: "phase 의존성 그래프에 사이클이 있습니다." });
  }

  const taskIds = new Set<string>();
  const taskEdges = new Map<string, string[]>();
  const requirementIds = new Set(normalized.requirements.map((r) => r.id));
  const acIds = new Set(normalized.acceptanceCriteria.map((a) => a.id));
  const deferredIds = new Set(normalized.deferredItems.map((d) => d.id));
  const outOfScopeIds = new Set(normalized.outOfScope.map((o) => o.id));
  const reqCoverage = new Set<string>();
  const acCoverage = new Set<string>();

  for (const t of tasks) {
    if (!structuralGuard(t as unknown as Record<string, unknown>) || !TASK_ID_RE.test(String(t.taskId))) {
      issues.push({ code: "INVALID_STRUCTURE", detail: `task id 형식이 올바르지 않습니다: ${safeEchoValue(t?.taskId)}` });
      continue;
    }
    if (taskIds.has(t.taskId)) {
      issues.push({ code: "DUPLICATE_TASK_ID", detail: `taskId가 중복됩니다: ${t.taskId}` });
    }
    taskIds.add(t.taskId);
    taskEdges.set(t.taskId, isStringArray(t.dependsOn) ? t.dependsOn : []);

    const phasePrefix = TASK_ID_RE.exec(t.taskId)?.[1];
    if (t.phaseId !== phasePrefix || !phaseIds.has(String(t.phaseId))) {
      issues.push({ code: "UNKNOWN_PHASE_REFERENCE", detail: `task "${t.taskId}"가 알 수 없는 phase를 참조합니다: ${safeEchoValue(t.phaseId, PHASE_ID_ECHO_SHAPE)}` });
    }

    const tObj = t as unknown as Record<string, unknown>;
    checkExactKeys(`task "${t.taskId}"`, tObj, TASK_KEYS, issues);
    checkRequiredString(`task "${t.taskId}"`, tObj, "title", issues);
    checkRequiredString(`task "${t.taskId}"`, tObj, "objective", issues);
    checkRequiredString(`task "${t.taskId}"`, tObj, "completionGate", issues);
    checkRequiredStringArray(`task "${t.taskId}"`, tObj, "scope", issues);
    checkRequiredStringArray(`task "${t.taskId}"`, tObj, "constraints", issues);
    checkRequiredStringArray(`task "${t.taskId}"`, tObj, "dependsOn", issues);
    checkRequiredStringArray(`task "${t.taskId}"`, tObj, "expectedModules", issues);
    checkRequiredStringArray(`task "${t.taskId}"`, tObj, "acceptanceCriteria", issues);
    checkRequiredStringArray(`task "${t.taskId}"`, tObj, "reqIds", issues);
    checkRequiredStringArray(`task "${t.taskId}"`, tObj, "securityConsiderations", issues);
    if (!Array.isArray(t.requiredTests)) {
      issues.push({ code: "INVALID_STRUCTURE", detail: `task "${t.taskId}".requiredTests가 배열이 아닙니다.` });
    } else {
      t.requiredTests.forEach((rt, idx) => {
        if (!structuralGuard(rt)) {
          issues.push({ code: "INVALID_STRUCTURE", detail: `task "${t.taskId}".requiredTests[${idx}]가 객체가 아닙니다.` });
          return;
        }
        checkExactKeys(`task "${t.taskId}".requiredTests[${idx}]`, rt, REQUIRED_TEST_KEYS, issues);
        checkRequiredString(`task "${t.taskId}".requiredTests[${idx}]`, rt, "name", issues);
        checkRequiredString(`task "${t.taskId}".requiredTests[${idx}]`, rt, "command", issues);
        checkRequiredString(`task "${t.taskId}".requiredTests[${idx}]`, rt, "cwd", issues);
        checkRequiredStringArray(`task "${t.taskId}".requiredTests[${idx}]`, rt, "args", issues);
      });
    }

    for (const reqId of isStringArray(t.reqIds) ? t.reqIds : []) {
      if (deferredIds.has(reqId) || outOfScopeIds.has(reqId)) {
        issues.push({
          code: "DEFERRED_OR_OUT_OF_SCOPE_REFERENCED",
          detail: `task "${t.taskId}"가 deferred/out-of-scope 항목(${safeEchoValue(reqId, ID_FAMILY_SHAPE)})을 요구사항으로 참조합니다.`,
        });
      } else if (!requirementIds.has(reqId)) {
        issues.push({ code: "UNKNOWN_REQUIREMENT_REFERENCE", detail: `task "${t.taskId}"가 존재하지 않는 requirement(${safeEchoValue(reqId, ID_FAMILY_SHAPE)})를 참조합니다.` });
      } else {
        reqCoverage.add(reqId);
      }
    }
    for (const acId of isStringArray(t.acceptanceCriteria) ? t.acceptanceCriteria : []) {
      if (deferredIds.has(acId) || outOfScopeIds.has(acId)) {
        issues.push({
          code: "DEFERRED_OR_OUT_OF_SCOPE_REFERENCED",
          detail: `task "${t.taskId}"가 deferred/out-of-scope 항목(${safeEchoValue(acId, ID_FAMILY_SHAPE)})을 Acceptance Criteria로 참조합니다.`,
        });
      } else if (!acIds.has(acId)) {
        issues.push({ code: "UNKNOWN_REQUIREMENT_REFERENCE", detail: `task "${t.taskId}"가 존재하지 않는 Acceptance Criteria(${safeEchoValue(acId, ID_FAMILY_SHAPE)})를 참조합니다.` });
      } else {
        acCoverage.add(acId);
      }
    }
  }
  for (const t of tasks) {
    if (!taskIds.has(t.taskId)) continue;
    for (const dep of isStringArray(t.dependsOn) ? t.dependsOn : []) {
      if (!taskIds.has(dep)) {
        issues.push({ code: "MISSING_DEPENDENCY", detail: `task "${t.taskId}"가 존재하지 않는 task에 의존합니다: ${safeEchoValue(dep, TASK_ID_ECHO_SHAPE)}` });
      }
    }
  }
  if (hasCycle([...taskIds], taskEdges)) {
    issues.push({ code: "DEPENDENCY_CYCLE", detail: "task 의존성 그래프에 사이클이 있습니다." });
  }

  for (const req of normalized.requirements) {
    if (req.mustHave && !reqCoverage.has(req.id)) {
      issues.push({ code: "MISSING_MUST_HAVE_COVERAGE", detail: `Must-have requirement(${req.id})가 어떤 task에도 매핑되지 않았습니다.` });
    }
  }
  for (const ac of normalized.acceptanceCriteria) {
    if (!acCoverage.has(ac.id)) {
      issues.push({ code: "MISSING_ACCEPTANCE_CRITERIA_COVERAGE", detail: `Acceptance Criteria(${ac.id})가 어떤 task에도 매핑되지 않았습니다.` });
    }
  }

  // Fixed constraint — Planner(LLM)가 이해한 내용이 Master Spec의 실제 내용과 정확히
  // 일치해야만 통과한다(§ 요구사항 3/17: AutoDev가 임의로 변경 금지). 최종 ProjectManifest의
  // fixedConstraints는 이 ack가 아니라 항상 normalized.fixedConstraints(코드가 직접 채움)로
  // 채워지므로, LLM이 실제로 manifest 내용을 바꿀 방법은 없다 — 이 검사는 LLM이 "다른 값으로
  // 잘못 이해한 채" 그 위에 phase/task를 설계하지 않았는지 확인하는 안전장치다.
  const ackRaw = Array.isArray(raw.fixedConstraintAcknowledgement) ? (raw.fixedConstraintAcknowledgement as unknown[]) : [];
  const ackById = new Map<string, string>();
  ackRaw.forEach((a, idx) => {
    if (!structuralGuard(a)) {
      issues.push({ code: "INVALID_STRUCTURE", detail: `fixedConstraintAcknowledgement[${idx}]가 객체가 아닙니다.` });
      return;
    }
    checkExactKeys(`fixedConstraintAcknowledgement[${idx}]`, a, ACK_KEYS, issues);
    if (!isNonEmptyString(a.id) || typeof a.value !== "string") {
      issues.push({ code: "INVALID_STRUCTURE", detail: `fixedConstraintAcknowledgement[${idx}]의 id/value 형식이 올바르지 않습니다.` });
      return;
    }
    ackById.set(a.id, a.value);
  });
  for (const fc of normalized.fixedConstraints) {
    if (!ackById.has(fc.id)) {
      issues.push({ code: "FIXED_CONSTRAINT_ACKNOWLEDGEMENT_MISSING", detail: `Fixed constraint(${fc.id})를 Planner 출력이 확인(acknowledge)하지 않았습니다.` });
    } else if ((ackById.get(fc.id) ?? "").trim() !== fc.text.trim()) {
      issues.push({ code: "FIXED_CONSTRAINT_VIOLATION", detail: `Fixed constraint(${fc.id})의 내용을 Planner가 다르게 이해했습니다 — 원본과 일치해야 합니다.` });
    }
  }

  // 안전하지 않은 Execution Policy — 최소 권한 위반(전체 파일시스템 허용) + Core가 전담하는
  // 명령(git)/파괴적 명령/배포 명령 요구를 거부한다.
  if (structuralGuard(raw.executionPolicy)) {
    const epObj = raw.executionPolicy as Record<string, unknown>;
    checkExactKeys("executionPolicy", epObj, EXECUTION_POLICY_KEYS, issues);
    if (epObj.commandCwdAliases !== undefined) {
      const aliases = epObj.commandCwdAliases;
      if (!structuralGuard(aliases) || Array.isArray(aliases) || !Object.values(aliases).every((v) => typeof v === "string")) {
        issues.push({ code: "INVALID_STRUCTURE", detail: "executionPolicy.commandCwdAliases가 문자열 값을 가진 객체가 아닙니다." });
      }
    }

    const ep = raw.executionPolicy as unknown as PlannerRawExecutionPolicy;
    const allPrefixes = [...(Array.isArray(ep.allowedReadPrefixes) ? ep.allowedReadPrefixes : []), ...(Array.isArray(ep.allowedWritePrefixes) ? ep.allowedWritePrefixes : [])];
    if (!Array.isArray(ep.allowedReadPrefixes) || ep.allowedReadPrefixes.length === 0 || !ep.allowedReadPrefixes.every(isSafeScopePrefix)) {
      issues.push({ code: "UNSAFE_EXECUTION_POLICY", detail: "executionPolicy.allowedReadPrefixes가 비어있거나 안전한 상대경로 형식이 아닙니다." });
    }
    if (!Array.isArray(ep.allowedWritePrefixes) || ep.allowedWritePrefixes.length === 0 || !ep.allowedWritePrefixes.every(isSafeScopePrefix)) {
      issues.push({ code: "UNSAFE_EXECUTION_POLICY", detail: "executionPolicy.allowedWritePrefixes가 비어있거나 안전한 상대경로 형식이 아닙니다." });
    }
    if (allPrefixes.includes("./")) {
      issues.push({ code: "UNSAFE_EXECUTION_POLICY", detail: "executionPolicy가 프로젝트 전체(\"./\")에 대한 접근을 요청합니다 — 최소 권한 원칙 위반." });
    }
    if (!Array.isArray(ep.allowedCommands)) {
      issues.push({ code: "UNSAFE_EXECUTION_POLICY", detail: "executionPolicy.allowedCommands가 배열이 아닙니다." });
    } else {
      ep.allowedCommands.forEach((c, idx) => {
        if (!structuralGuard(c as unknown as Record<string, unknown>)) {
          issues.push({ code: "INVALID_STRUCTURE", detail: `executionPolicy.allowedCommands[${idx}]가 객체가 아닙니다.` });
          return;
        }
        const cObj = c as unknown as Record<string, unknown>;
        checkExactKeys(`executionPolicy.allowedCommands[${idx}]`, cObj, ALLOWED_COMMAND_KEYS, issues);
        checkRequiredString(`executionPolicy.allowedCommands[${idx}]`, cObj, "cwd", issues);
        checkRequiredStringArray(`executionPolicy.allowedCommands[${idx}]`, cObj, "args", issues);
        if (typeof c.command !== "string" || c.command.length === 0) {
          issues.push({ code: "INVALID_STRUCTURE", detail: `executionPolicy.allowedCommands[${idx}].command가 비어있거나 문자열이 아닙니다.` });
          return;
        }
        // GPT Independent Reviewer 지적(SI-3 REVISE 1회차, HIGH) — 이름 목록만 소문자
        // 비교하면 "git.exe"/절대경로("C:\...\git.exe")/별칭 같은 사소한 변형으로 이 검사
        // 단계를 우회할 수 있었다. 다만 이 검사가 유일한 방어선은 아니다 — 실제 실행 시점의
        // 최종 강제는 이 Task가 손대지 않는, 어떤 project policy로도 약화 불가능한
        // safe-executor.ts의 Core Command Safety Gate(coreCommandSafetyGate)다. 여기서는
        // (1) command가 경로 구분자/드라이브 문자를 포함하면(=bare 실행 파일명이 아니면)
        // 그 자체로 최소 권한 위반으로 거부하고, (2) 확장자(.exe/.cmd/.bat/.com)를 제거한
        // basename으로 denylist를 비교해 흔한 변형을 추가로 잡는다.
        if (/[\\/]/.test(c.command) || /^[a-zA-Z]:/.test(c.command)) {
          issues.push({
            code: "UNSAFE_EXECUTION_POLICY",
            detail: `executionPolicy.allowedCommands의 command는 경로가 아닌 실행 파일 이름이어야 합니다: ${safeEchoValue(c.command)}`,
          });
          return;
        }
        const cmd = c.command.trim().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
        if (DANGEROUS_COMMAND_NAMES.has(cmd)) {
          issues.push({ code: "DESTRUCTIVE_COMMAND_REQUESTED", detail: `executionPolicy.allowedCommands가 위험하거나 Core 전담 명령을 요청합니다: ${safeEchoValue(cmd, COMMAND_NAME_SHAPE)}` });
        }
        const args = isStringArray(c.args) ? c.args.map((a) => a.toLowerCase()) : [];
        if (DEPLOY_COMMAND_NAMES.has(cmd) || (cmd === "npm" && (args.includes("publish") || args.includes("deploy")))) {
          issues.push({ code: "PRODUCTION_DEPLOY_REQUESTED", detail: `executionPolicy.allowedCommands가 배포 관련 명령을 요청합니다: ${safeEchoValue(cmd, COMMAND_NAME_SHAPE)} ${safeEchoValue(args.join(" "))}` });
        }
      });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: raw as unknown as PlannerRawOutput, normalizedJsonText: extraction.jsonText };
}

// ---------------------------------------------------------------------------
// Raw Output Source — LLM 호출 seam(dependency-scanner.ts의 VulnerabilityAuditSource와
// 동일한 설계). 새 provider system을 만들지 않는다 — claude-runner.ts의 runClaudeTask를
// 그대로 감싼다(agent-orchestrator.ts의 realReadOnlyAgentRunner와 동일한 재사용 원칙).
// ---------------------------------------------------------------------------

export type PlannerRawOutputOutcome =
  | { ok: true; rawOutput: string }
  // retryable — SI-3.2. TIMEOUT처럼 일시적일 가능성이 있는 transport failure에서만 true로
  // 설정된다(§ createClaudeCliRawOutputSource). 지정하지 않으면(테스트 fixture 등) 항상
  // 재시도하지 않는 것으로(fail-closed 기본값) 취급한다 — § invokeRawOutputSourceWithTransportRetry.
  | { ok: false; reason: string; retryable?: boolean };
export type PlannerRawOutputSource = (prompt: string) => Promise<PlannerRawOutputOutcome>;

export interface ClaudeCliRawOutputSourceOptions {
  command?: string;
  timeoutMs?: number;
}

// SI-3.2 — 실제 JARVIS Master Spec Planner 실행에서 claude CLI 응답 생성이 2분(claude-runner.ts의
// DEFAULT_TIMEOUT_MS=120000)을 넘겨 수분까지 걸리는 사례가 반복 관찰됐다. DEFAULT_TIMEOUT_MS
// 자체는 건드리지 않는다 — agent-orchestrator.ts의 realReadOnlyAgentRunner 등 다른(짧은)
// read-only 호출이 그 값을 그대로 공유하기 때문이다(§ .claude/CLAUDE.md). 이 값은 오직
// Planner raw-output 호출(createClaudeCliRawOutputSource의 기본 timeoutMs)에만 적용된다 —
// "응답을 기다리는 시간"만 늘릴 뿐, timeout이 늘었다고 fail-closed 검증
// (validatePlannerRawOutput의 transport normalization → strict schema → semantic validation)을
// 우회하지 않는다.
export const PLANNER_RAW_OUTPUT_TIMEOUT_MS = 300_000;

// SI-3.2 — TIMEOUT처럼 일시적일 가능성이 있는 transport failure(§ PlannerRawOutputOutcome.
// retryable)에 한해서만 제한된 재시도를 허용한다. "추가로 허용하는 재시도 횟수"이므로 1이면
// 최초 시도 + 재시도 1회 = 최대 2회 실제 호출이다 — 무한 retry를 금지하기 위해 항상 상수로
// 상한을 둔다(§ invokeRawOutputSourceWithTransportRetry). CLI_NOT_FOUND/AUTH_REQUIRED/
// USAGE_LIMIT 등 명백히 비복구이거나 즉시 재시도가 오히려 해로운(USAGE_LIMIT) 실패는
// retryable이 설정되지 않으므로 이 재시도 대상이 아니다.
export const PLANNER_MAX_TRANSPORT_RETRIES = 1;

/** 실제 운용 기본 구현 — claude-runner.ts의 runClaudeTask(항상 --tools "")를 그대로
 *  감싼다. command override는 테스트 전용(claude-runner-tests.ts와 동일한 관례)이며
 *  실제 운용 코드는 지정하지 않는다. timeoutMs를 지정하지 않으면 claude-runner.ts 자신의
 *  DEFAULT_TIMEOUT_MS(120000, 다른 호출부용)가 아니라 PLANNER_RAW_OUTPUT_TIMEOUT_MS를 쓴다. */
export function createClaudeCliRawOutputSource(opts: ClaudeCliRawOutputSourceOptions = {}): PlannerRawOutputSource {
  return async (prompt: string) => {
    const timeoutMs = opts.timeoutMs ?? PLANNER_RAW_OUTPUT_TIMEOUT_MS;
    const result = await runClaudeTask(prompt, 1, { command: opts.command, timeoutMs });
    if (!result.success) {
      return {
        ok: false,
        reason: `claude 호출 실패: ${result.errorCode ?? "UNKNOWN"} — ${result.summary}`,
        // TIMEOUT만 일시적일 가능성이 있는 transport failure로 취급한다(§ 위 상수 주석) —
        // CLI_NOT_FOUND/AUTH_REQUIRED/USAGE_LIMIT/NON_ZERO_EXIT/INVALID_OUTPUT은 재시도해도
        // 회복 가능성이 낮거나(비복구) 재시도 자체가 해로울 수 있어(예: USAGE_LIMIT 즉시
        // 재요청) retryable로 표시하지 않는다.
        retryable: result.errorCode === "TIMEOUT",
      };
    }
    return { ok: true, rawOutput: result.summary };
  };
}

// SI-3.2 — transport-level bounded retry. correction retry(PLANNER_MAX_RAW_OUTPUT_ATTEMPTS —
// LLM이 스스로 schema 위반을 고칠 기회를 주는 재시도)와는 완전히 다른 문제를 다룬다: 여기서는
// "응답을 아예 받지 못했다"(예: TIMEOUT)는 transport 실패만 다루고, retryable이 아닌 실패는
// 재시도 없이 즉시 그대로 반환한다. 매 시도는 rawOutputSource(실제 운용에서는 runClaudeTask →
// 매번 새 subprocess)를 통해 독립적으로 자신만의 timeout을 가진다 — 이전 시도의 timeout이
// 다음 시도에 누적되지 않는다.
async function invokeRawOutputSourceWithTransportRetry(
  rawOutputSource: PlannerRawOutputSource,
  prompt: string
): Promise<PlannerRawOutputOutcome> {
  let outcome: PlannerRawOutputOutcome = { ok: false, reason: "rawOutputSource가 한 번도 호출되지 않았습니다." };
  for (let transportAttempt = 0; transportAttempt <= PLANNER_MAX_TRANSPORT_RETRIES; transportAttempt += 1) {
    outcome = await rawOutputSource(prompt);
    if (outcome.ok || !outcome.retryable) return outcome;
  }
  return outcome;
}

/** LLM에 전달하는 프롬프트 — Master Spec(WHAT, 정규화됨) + Fixed Constraints + Output
 *  Schema + Security Constraints + REQ/AC Traceability 요구를 포함한다(§ 요구사항 16). */
export function buildPlannerPrompt(normalized: NormalizedMasterSpec, trusted: { projectId: string; specVersion: string }): string {
  const reqLines = normalized.requirements.map((r) => `- ${r.id} [${r.category}${r.mustHave ? ", must-have" : ""}]: ${r.text}`).join("\n") || "(없음)";
  const acLines = normalized.acceptanceCriteria.map((a) => `- ${a.id}: ${a.text}`).join("\n") || "(없음)";
  const fcLines = normalized.fixedConstraints.map((f) => `- ${f.id} [${f.kind}]: ${f.text}`).join("\n") || "(없음)";
  const deferredLines = normalized.deferredItems.map((d) => `- ${d.id}: ${d.text}`).join("\n") || "(없음)";
  const oosLines = normalized.outOfScope.map((o) => `- ${o.id}: ${o.text}`).join("\n") || "(없음)";

  return [
    `당신은 AutoDev Planner입니다 — Master Spec(WHAT)을 실제 실행 계획(HOW: Phase/Task/Execution Policy)으로 변환합니다.`,
    `projectId=${trusted.projectId}, specVersion=${trusted.specVersion}`,
    `# Project Goal\n${normalized.projectGoal || "(명시되지 않음)"}`,
    `# Product Scope\n${normalized.productScope || "(명시되지 않음)"}`,
    `# Requirements\n${reqLines}`,
    `# Acceptance Criteria\n${acLines}`,
    `# Fixed Constraints(절대 변경 불가 — 반드시 원문 그대로 fixedConstraintAcknowledgement로 확인)\n${fcLines}`,
    `# Deferred Items(Task로 만들지 말 것)\n${deferredLines}`,
    `# Out-of-scope(Task로 만들지 말 것)\n${oosLines}`,
    [
      "# Output — 반드시 아래 JSON 구조만 반환(다른 텍스트 금지):",
      '{ "projectId": string, "specVersion": string, "architectureSummary": string,',
      '  "technologyChoices": [{"area":string,"decision":string,"reason":string,"source":string,"status":"proposed"|"confirmed"}],',
      '  "fixedConstraintAcknowledgement": [{"id":string,"value":string}] (모든 Fixed Constraint id를 원문 그대로 echo),',
      '  "modulesOrComponents": string[], "integrations": string[], "securityRequirementsSummary": string[],',
      '  "testingRequirementsSummary": string[], "deliveryConstraintsSummary": string[],',
      '  "phases": [{"phaseId":"1","name":string,"objective":string,"dependsOn":string[],"completionCriteria":string[]}],',
      '  "tasks": [{"taskId":"1.1","phaseId":"1","title":string,"objective":string,"scope":["dir/"],"constraints":string[],',
      '    "dependsOn":string[],"expectedModules":string[],"requiredTests":[{"name":string,"command":string,"args":string[],"cwd":"root"}],',
      '    "acceptanceCriteria":["AC-001"],"reqIds":["REQ-001"],"securityConsiderations":string[],"completionGate":string}],',
      '  "executionPolicy": {"allowedReadPrefixes":["dir/"],"allowedWritePrefixes":["dir/"],"allowedCommands":[{"cwd":"root","command":string,"args":string[]}]} }',
    ].join("\n"),
    [
      "# Security Constraints",
      "- 모든 Must-have requirement와 Acceptance Criteria는 최소 하나의 task(reqIds/acceptanceCriteria)에 매핑돼야 합니다.",
      "- Deferred/Out-of-scope 항목을 task의 reqIds/acceptanceCriteria로 참조하지 마세요.",
      '- executionPolicy에 "./"(프로젝트 전체) 접근이나 git/rm 등 위험한 명령, 배포 명령을 포함하지 마세요.',
      "- secret/API key/token/password로 보이는 어떤 값도 출력에 포함하지 마세요.",
    ].join("\n"),
  ].join("\n\n");
}

// GPT Independent Reviewer 지적(SI-3 REVISE 4회차 — 실제 JARVIS 실행 관찰) — 실제 claude CLI가
// "JSON only" 지시를 어기고 설명문을 앞뒤에 붙이거나 markdown ```json fence로 감싸는 경우,
// 또는 허용되지 않는/깨진 key를 만드는 경우가 관찰됐다. buildPlannerPrompt()의 최초 프롬프트는
// 이미 통과된 spec/schema를 그대로 두되(느슨하게 만들지 않음), validatePlannerRawOutput()가
// 실제로 발견한 위반(§ PlannerValidationIssue)을 그대로 되돌려주며 Planner에게 같은 요청을
// 다시 한다 — 값을 이쪽에서 임의로 보정하지 않고, "무엇이 왜 거부됐는지"만 정확히 알려서
// Planner 스스로 고치게 한다(§ 요구사항: correction retry). issues[].detail은 이미
// safeEchoValue()로 원문 secret/긴 임의 문자열을 노출하지 않도록 정제돼 있으므로 그대로
// 프롬프트에 포함해도 안전하다.
export function buildPlannerCorrectionPrompt(
  normalized: NormalizedMasterSpec,
  trusted: { projectId: string; specVersion: string },
  issues: PlannerValidationIssue[]
): string {
  const base = buildPlannerPrompt(normalized, trusted);
  const issueLines = issues.length > 0 ? issues.map((i) => `- [${i.code}] ${i.detail}`).join("\n") : "(기록된 위반 없음)";
  return [
    base,
    [
      "# 이전 시도가 거부되었습니다 — 아래 이유를 반드시 수정해서 다시 출력하세요",
      issueLines,
      "",
      "# 출력 형식 — 절대 예외 없이 지킬 것",
      "- 응답 전체가 정확히 하나의 JSON 객체여야 합니다. 첫 글자는 반드시 '{', 마지막 글자는 반드시 '}'여야 합니다.",
      "- 설명, 인사말, 여는/닫는 문장을 절대 포함하지 마세요.",
      "- markdown 코드 펜스(```)로 감싸지 마세요.",
      "- 위에 정의된 Output 스키마에 없는 key를 추가하지 마세요.",
    ].join("\n"),
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Execution Data 생성 — 검증된 raw output + normalized(WHAT)를 기존 Core 타입
// (ProjectManifest/TaskDefinition/ProjectExecutionPolicy)으로 변환한다. fixedConstraints는
// 항상 normalized(코드)에서만 채워진다 — LLM 출력에서 직접 채우지 않는다(§ 위 주석).
// ---------------------------------------------------------------------------

export interface PlannerPhase {
  phaseId: string;
  name: string;
  objective: string;
  dependencies: string[];
  completionCriteria: string[];
}

export interface ReqTraceabilityEntry {
  reqId: string;
  taskIds: string[];
}
export interface AcTraceabilityEntry {
  acId: string;
  taskIds: string[];
}
export interface ReqTraceability {
  requirements: ReqTraceabilityEntry[];
  acceptanceCriteria: AcTraceabilityEntry[];
}

function buildReqTraceability(normalized: NormalizedMasterSpec, tasks: PlannerRawTask[]): ReqTraceability {
  const reqMap = new Map<string, string[]>(normalized.requirements.map((r) => [r.id, []]));
  const acMap = new Map<string, string[]>(normalized.acceptanceCriteria.map((a) => [a.id, []]));
  for (const t of tasks) {
    for (const reqId of t.reqIds ?? []) {
      if (reqMap.has(reqId)) reqMap.get(reqId)!.push(t.taskId);
    }
    for (const acId of t.acceptanceCriteria ?? []) {
      if (acMap.has(acId)) acMap.get(acId)!.push(t.taskId);
    }
  }
  return {
    requirements: [...reqMap.entries()].map(([reqId, taskIds]) => ({ reqId, taskIds })),
    acceptanceCriteria: [...acMap.entries()].map(([acId, taskIds]) => ({ acId, taskIds })),
  };
}

function buildTaskRegistry(raw: PlannerRawOutput): TaskDefinition[] {
  return raw.tasks.map((t) => {
    const m = TASK_ID_RE.exec(t.taskId)!;
    return {
      id: t.taskId,
      phase: parseInt(m[1], 10),
      taskNumber: parseInt(m[2], 10),
      title: t.title,
      prompt: [t.objective, t.constraints.length ? `제약: ${t.constraints.join("; ")}` : "", t.completionGate ? `완료 조건: ${t.completionGate}` : ""]
        .filter(Boolean)
        .join("\n"),
      requiredTests: t.requiredTests,
      allowedPathPrefixes: t.scope,
      prohibitedOperations: [...t.constraints, ...t.securityConsiderations],
    };
  });
}

function buildExecutionPolicy(raw: PlannerRawOutput): ProjectExecutionPolicy {
  return {
    allowedReadPrefixes: raw.executionPolicy.allowedReadPrefixes,
    allowedWritePrefixes: raw.executionPolicy.allowedWritePrefixes,
    commandCwdAliases: raw.executionPolicy.commandCwdAliases,
    allowedCommands: raw.executionPolicy.allowedCommands,
  };
}

interface GeneratedExecutionData {
  manifestFile: PersistedProjectManifestFile;
  taskRegistry: TaskDefinition[];
  executionPolicy: ProjectExecutionPolicy;
}

export interface PersistedProjectManifestFile {
  schemaVersion: 1;
  projectId: string;
  projectName: string;
  targetProjectRoot: string;
  statePath: string;
  developerInstructions: string;
  reviewInstructions: string;
  reviewScopeDirs: string[];
  architectureSummary: string;
  technologyChoices: PlannerRawTechnologyChoice[];
  fixedConstraints: FixedConstraintItem[];
  modulesOrComponents: string[];
  integrations: string[];
  securityRequirementsSummary: string[];
  testingRequirementsSummary: string[];
  deliveryConstraintsSummary: string[];
  phases: PlannerPhase[];
  sourceSpecVersion: string;
  sourceSpecIntegrity: { algorithm: "sha256" | "sha512"; hash: string };
  reqTraceability: ReqTraceability;
  generatedAt: string;
  /** GPT Independent Reviewer 지적(SI-3 REVISE 2회차, HIGH) — validatePlannerRawOutput()의
   *  fixedConstraintAcknowledgement 검사는 Planner(LLM)가 fixed constraint의 "문구"를 정확히
   *  echo했는지만 deterministic하게 확인한다 — phases/tasks/technologyChoices/executionPolicy
   *  같은 실제 HOW가 그 constraint를 진짜로 지키는지는(자유 텍스트 의미 해석이 필요하므로)
   *  결정적으로 검증하지 않는다(할 수 없다). 그 사실을 조용히 감추는 대신 항상 명시적으로
   *  드러낸다 — fixedConstraints가 하나라도 있으면 이 필드가 항상 채워지고, READY_FOR_AUTODEV
   *  outcome에도 동일한 내용이 그대로 노출된다(capability-resolver.ts가 자동으로 검증할 수
   *  없는 위험을 조용히 통과시키지 않고 HUMAN_APPROVAL_REQUIRED로 명시적으로 분류하는 것과
   *  동일한 원칙) — 실제 개발 시작 전 사람이 반드시 phases/tasks/technologyChoices/
   *  executionPolicy를 Fixed Constraints와 직접 대조해야 한다. */
  fixedConstraintComplianceNote: string | null;
}

const FIXED_CONSTRAINT_COMPLIANCE_NOTE =
  "Fixed Constraint 준수는 Planner 출력의 fixedConstraintAcknowledgement가 원문과 문자 그대로 " +
  "일치하는지만 deterministic하게 검증됐습니다 — phases/tasks/technologyChoices/executionPolicy 같은 " +
  "실제 실행 계획(HOW)이 각 Fixed Constraint를 실제로 지키는지는 자유 텍스트 의미 해석이 필요해 이 " +
  "Validator가 기계적으로 검증할 수 없습니다. 실제 개발을 시작하기 전에 사람이 반드시 아래 " +
  "fixedConstraints를 생성된 phases/tasks/technologyChoices/executionPolicy와 직접 대조해 위반이 " +
  "없는지 확인해야 합니다.";

function buildGeneratedExecutionData(
  raw: PlannerRawOutput,
  normalized: NormalizedMasterSpec,
  identity: BootstrapRequestIdentity,
  projectName: string,
  projectRoot: string,
  now: Date
): GeneratedExecutionData {
  const taskRegistry = buildTaskRegistry(raw);
  const executionPolicy = buildExecutionPolicy(raw);
  const phases: PlannerPhase[] = raw.phases.map((p) => ({
    phaseId: p.phaseId,
    name: p.name,
    objective: p.objective,
    dependencies: p.dependsOn,
    completionCriteria: p.completionCriteria,
  }));
  const manifestFile: PersistedProjectManifestFile = {
    schemaVersion: 1,
    projectId: identity.projectId,
    projectName,
    targetProjectRoot: projectRoot,
    statePath: join(projectRoot, ".autodev", "project-state.json"),
    developerInstructions: [
      `프로젝트: ${projectName}`,
      `아키텍처 요약: ${raw.architectureSummary}`,
      normalized.fixedConstraints.length
        ? `절대 변경 금지(Fixed Constraints): ${normalized.fixedConstraints.map((f) => `${f.id}: ${f.text}`).join(" / ")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    reviewInstructions: [
      `프로젝트: ${projectName}`,
      `보안 요구사항: ${raw.securityRequirementsSummary.join("; ") || "(추가 규칙 없음)"}`,
      `테스트 요구사항: ${raw.testingRequirementsSummary.join("; ") || "(추가 규칙 없음)"}`,
    ].join("\n"),
    reviewScopeDirs: [...new Set(executionPolicy.allowedWritePrefixes)],
    architectureSummary: raw.architectureSummary,
    technologyChoices: raw.technologyChoices,
    fixedConstraints: normalized.fixedConstraints,
    modulesOrComponents: raw.modulesOrComponents,
    integrations: raw.integrations,
    securityRequirementsSummary: raw.securityRequirementsSummary,
    testingRequirementsSummary: raw.testingRequirementsSummary,
    deliveryConstraintsSummary: raw.deliveryConstraintsSummary,
    phases,
    sourceSpecVersion: identity.specVersion,
    sourceSpecIntegrity: { algorithm: identity.specIntegrityAlgorithm, hash: identity.specIntegrityHash },
    reqTraceability: buildReqTraceability(normalized, raw.tasks),
    generatedAt: now.toISOString(),
    fixedConstraintComplianceNote: normalized.fixedConstraints.length > 0 ? FIXED_CONSTRAINT_COMPLIANCE_NOTE : null,
  };
  return { manifestFile, taskRegistry, executionPolicy };
}

function assembleProjectManifest(data: GeneratedExecutionData): ProjectManifest {
  const m = data.manifestFile;
  return {
    projectId: m.projectId,
    projectName: m.projectName,
    targetProjectRoot: m.targetProjectRoot,
    statePath: m.statePath,
    taskRegistry: data.taskRegistry,
    developerInstructions: m.developerInstructions,
    reviewInstructions: m.reviewInstructions,
    reviewScopeDirs: m.reviewScopeDirs,
    executionPolicy: data.executionPolicy,
  };
}

// ---------------------------------------------------------------------------
// Planner State — 원자적 write, resume-safe, idempotent(SI-2의 bootstrap-state.json과
// 동일한 tmp+rename + 3분류(absent/corrupt/valid) 패턴을 그대로 따른다).
// ---------------------------------------------------------------------------

export const PLANNER_STATE_SCHEMA_VERSION = 1 as const;

// GPT Independent Reviewer 지적(SI-3 REVISE 4회차 — 실제 JARVIS 실행 관찰) — 실제 claude
// CLI가 MALFORMED_JSON/schema 위반을 반복 생성한 관찰에 대한 방어. rawOutputSource가 매번
// 같은(또는 더 나쁜) 출력을 반복해도 무한 재시도하지 않도록 상한을 둔다 — buildGoodRawOutput류
// fixture가 아닌 실제 LLM은 correction prompt(§ buildPlannerCorrectionPrompt)를 받으면 보통
// 1~2회 안에 수정하므로, 3회(최초 1회 + correction 2회)면 충분하다.
export const PLANNER_MAX_RAW_OUTPUT_ATTEMPTS = 3;

export type PlannerStage =
  | "SPEC_VERIFIED"
  | "REQUIREMENTS_NORMALIZED"
  | "ARCHITECTURE_PLANNED"
  | "EXECUTION_DATA_GENERATED"
  | "EXECUTION_DATA_VALIDATED"
  | "COMPLETED";

const PLANNER_STAGE_ORDER: readonly PlannerStage[] = [
  "SPEC_VERIFIED",
  "REQUIREMENTS_NORMALIZED",
  "ARCHITECTURE_PLANNED",
  "EXECUTION_DATA_GENERATED",
  "EXECUTION_DATA_VALIDATED",
  "COMPLETED",
];

export interface PlannerStateFile {
  schemaVersion: typeof PLANNER_STATE_SCHEMA_VERSION;
  identity: BootstrapRequestIdentity;
  stage: PlannerStage;
  createdAt: string;
  updatedAt: string;
  /** ARCHITECTURE_PLANNED 이상에서만 채워진다(검증을 통과한 raw output만 여기 저장된다). */
  rawPlannerOutput?: string;
  /** REJECTED로 끝난 마지막 시도의 진단 정보 — "partial output 보존"(감사/재시도 참고용).
   *  stage를 진행시키지 않는다. */
  lastValidationIssues?: PlannerValidationIssue[];
}

function plannerStateFilePath(projectRoot: string): string {
  return join(projectRoot, ".autodev", "planner-state.json");
}
function generatedManifestPath(projectRoot: string): string {
  return join(projectRoot, ".autodev", "project-manifest.json");
}
function generatedTaskRegistryPath(projectRoot: string): string {
  return join(projectRoot, ".autodev", "task-registry.json");
}
function generatedExecutionPolicyPath(projectRoot: string): string {
  return join(projectRoot, ".autodev", "execution-policy.json");
}

function isValidIdentityShape(v: unknown): v is BootstrapRequestIdentity {
  if (!v || typeof v !== "object") return false;
  const i = v as Record<string, unknown>;
  return (
    typeof i.handoffId === "string" &&
    i.handoffId.length > 0 &&
    typeof i.projectId === "string" &&
    i.projectId.length > 0 &&
    typeof i.specVersion === "string" &&
    i.specVersion.length > 0 &&
    (i.specIntegrityAlgorithm === "sha256" || i.specIntegrityAlgorithm === "sha512") &&
    typeof i.specIntegrityHash === "string" &&
    i.specIntegrityHash.length > 0
  );
}

function isValidPlannerStateFile(v: unknown): v is PlannerStateFile {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.schemaVersion !== PLANNER_STATE_SCHEMA_VERSION) return false;
  if (typeof o.stage !== "string" || !PLANNER_STAGE_ORDER.includes(o.stage as PlannerStage)) return false;
  if (typeof o.createdAt !== "string" || typeof o.updatedAt !== "string") return false;
  if (!isValidIdentityShape(o.identity)) return false;
  if (o.rawPlannerOutput !== undefined && typeof o.rawPlannerOutput !== "string") return false;
  return true;
}

type ReadPlannerStateResult = { kind: "absent" } | { kind: "corrupt"; detail: string } | { kind: "valid"; state: PlannerStateFile };

function readPlannerState(projectRoot: string): ReadPlannerStateResult {
  const p = plannerStateFilePath(projectRoot);
  if (!existsSync(p)) return { kind: "absent" };
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return { kind: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", detail: "planner-state.json이 올바른 JSON이 아닙니다." };
  }
  if (!isValidPlannerStateFile(parsed)) return { kind: "corrupt", detail: "planner-state.json이 예상된 schema와 일치하지 않습니다." };
  return { kind: "valid", state: parsed };
}

function writeJsonAtomic(targetPath: string, data: unknown): { ok: true } | { ok: false; detail: string } {
  try {
    mkdirSync(join(targetPath, ".."), { recursive: true });
    const tmp = `${targetPath}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
    renameSync(tmp, targetPath);
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: `파일 저장 실패(${targetPath}): ${e instanceof Error ? e.message : String(e)}` };
  }
}

function identitiesMatch(a: BootstrapRequestIdentity, b: BootstrapRequestIdentity): boolean {
  return (
    a.handoffId === b.handoffId &&
    a.projectId === b.projectId &&
    a.specVersion === b.specVersion &&
    a.specIntegrityAlgorithm === b.specIntegrityAlgorithm &&
    a.specIntegrityHash === b.specIntegrityHash
  );
}

// ---------------------------------------------------------------------------
// 신뢰된 입력 확인(§ 요구사항 1) — SI-2가 남긴 파일시스템 결과만 신뢰 입력으로 쓴다.
// ---------------------------------------------------------------------------

export type PlannerBlockedCode =
  | "INVALID_PROJECT_ROOT"
  | "BOOTSTRAP_STATE_MISSING_OR_CORRUPT"
  | "BOOTSTRAP_NOT_COMPLETED"
  | "MASTER_SPEC_MANIFEST_MISSING_OR_CORRUPT"
  | "MASTER_SPEC_CONTENT_UNREADABLE"
  | "MASTER_SPEC_DIGEST_MISMATCH"
  | "SPEC_NOT_APPROVED"
  | "USER_APPROVAL_NOT_PASS"
  | "REVIEWER_GATE_NOT_ZERO"
  | "UNRESOLVED_OR_CONTRADICTION_NOT_ZERO"
  | "EXPECTED_IDENTITY_MISMATCH"
  | "PROJECT_ROOT_ESCAPE"
  | "PLANNER_STATE_CORRUPT"
  | "UNRECOGNIZED_MASTER_SPEC_SECTION"
  | "RAW_OUTPUT_SOURCE_FAILED"
  | "GENERATED_DATA_INVALID"
  | "STATE_WRITE_FAILED"
  | "CONCURRENT_PLANNER_RUN_IN_PROGRESS";

interface TrustedPlannerInput {
  identity: BootstrapRequestIdentity;
  projectName: string;
  specContent: string;
}

type TrustedInputResult = { ok: true; input: TrustedPlannerInput } | { ok: false; code: PlannerBlockedCode; detail: string };

interface MasterSpecManifestShape {
  projectId: string;
  projectName: string;
  specVersion: string;
  handoffId: string;
  specIntegrity: { algorithm: "sha256" | "sha512"; hash: string };
  specStatus: string;
  userApproval: string;
  reviewerGate: { critical: number; high: number };
  unresolvedCriticalCount: number;
  contradictionCount: number;
  storedContentDigest: { algorithm: "sha256" | "sha512"; hash: string };
}

function isValidMasterSpecManifestShape(v: unknown): v is MasterSpecManifestShape {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (typeof o.projectId !== "string" || o.projectId.length === 0) return false;
  if (typeof o.projectName !== "string" || o.projectName.length === 0) return false;
  if (typeof o.specVersion !== "string" || o.specVersion.length === 0) return false;
  if (typeof o.handoffId !== "string" || o.handoffId.length === 0) return false;
  const si = o.specIntegrity as Record<string, unknown> | undefined;
  if (!si || (si.algorithm !== "sha256" && si.algorithm !== "sha512") || typeof si.hash !== "string") return false;
  if (typeof o.specStatus !== "string" || typeof o.userApproval !== "string") return false;
  const rg = o.reviewerGate as Record<string, unknown> | undefined;
  if (!rg || typeof rg.critical !== "number" || typeof rg.high !== "number") return false;
  if (typeof o.unresolvedCriticalCount !== "number" || typeof o.contradictionCount !== "number") return false;
  const scd = o.storedContentDigest as Record<string, unknown> | undefined;
  if (!scd || (scd.algorithm !== "sha256" && scd.algorithm !== "sha512") || typeof scd.hash !== "string") return false;
  return true;
}

interface BootstrapStateShape {
  stage: string;
}
function isValidBootstrapStateShape(v: unknown): v is BootstrapStateShape {
  if (!v || typeof v !== "object") return false;
  return typeof (v as Record<string, unknown>).stage === "string";
}

/**
 * SI-2가 만든 projectRoot/.autodev/{bootstrap-state.json,master-spec/*}만 신뢰 입력으로
 * 다시 읽고 재검증한다(§ 요구사항 1 — Fail Closed, 하나라도 확인 불가면 Planner 실행 금지).
 * expectedIdentity가 실제로 읽은 identity와 다르면(호출부가 잘못된 project를 가리키는 경우)
 * EXPECTED_IDENTITY_MISMATCH로 즉시 BLOCK한다.
 */
function evaluateTrustedPlannerInput(projectRoot: string, expectedIdentity: BootstrapRequestIdentity): TrustedInputResult {
  const bootstrapStatePath = join(projectRoot, ".autodev", "bootstrap-state.json");
  if (!existsSync(bootstrapStatePath)) {
    return { ok: false, code: "BOOTSTRAP_STATE_MISSING_OR_CORRUPT", detail: "bootstrap-state.json이 존재하지 않습니다 — SI-2 Bootstrap이 완료되지 않았습니다." };
  }
  let bootstrapState: unknown;
  try {
    bootstrapState = JSON.parse(readFileSync(bootstrapStatePath, "utf-8"));
  } catch {
    return { ok: false, code: "BOOTSTRAP_STATE_MISSING_OR_CORRUPT", detail: "bootstrap-state.json을 읽거나 파싱할 수 없습니다." };
  }
  if (!isValidBootstrapStateShape(bootstrapState)) {
    return { ok: false, code: "BOOTSTRAP_STATE_MISSING_OR_CORRUPT", detail: "bootstrap-state.json 형식이 올바르지 않습니다." };
  }
  if ((bootstrapState as BootstrapStateShape).stage !== ("COMPLETED" as BootstrapStage)) {
    return { ok: false, code: "BOOTSTRAP_NOT_COMPLETED", detail: `SI-2 Bootstrap stage가 COMPLETED가 아닙니다(현재: ${(bootstrapState as BootstrapStateShape).stage}).` };
  }

  const masterSpecDir = join(projectRoot, ".autodev", "master-spec");
  const manifestPath = join(masterSpecDir, "manifest.json");
  const specPath = join(masterSpecDir, "spec.md");
  if (!existsSync(manifestPath)) {
    return { ok: false, code: "MASTER_SPEC_MANIFEST_MISSING_OR_CORRUPT", detail: "master-spec/manifest.json이 존재하지 않습니다." };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return { ok: false, code: "MASTER_SPEC_MANIFEST_MISSING_OR_CORRUPT", detail: "master-spec/manifest.json을 읽거나 파싱할 수 없습니다." };
  }
  if (!isValidMasterSpecManifestShape(manifest)) {
    return { ok: false, code: "MASTER_SPEC_MANIFEST_MISSING_OR_CORRUPT", detail: "master-spec/manifest.json 형식이 올바르지 않습니다." };
  }
  const m = manifest as MasterSpecManifestShape;

  let specContent: string;
  try {
    specContent = readFileSync(specPath, "utf-8");
  } catch (e) {
    return { ok: false, code: "MASTER_SPEC_CONTENT_UNREADABLE", detail: `master-spec/spec.md를 읽을 수 없습니다: ${e instanceof Error ? e.message : String(e)}` };
  }
  const actualHash = createHash(m.storedContentDigest.algorithm).update(specContent, "utf8").digest("hex");
  if (actualHash !== m.storedContentDigest.hash || m.specIntegrity.hash.toLowerCase() !== m.storedContentDigest.hash) {
    return {
      ok: false,
      code: "MASTER_SPEC_DIGEST_MISMATCH",
      detail: "master-spec/spec.md의 실제 digest가 보존된 storedContentDigest와 일치하지 않습니다 — 변조가 의심되어 중단합니다.",
    };
  }
  // GPT Independent Reviewer 지적(SI-3 REVISE 1회차, HIGH) — 위 두 비교는 manifest.json
  // 내부 필드끼리(storedContentDigest ↔ specIntegrity)의 self-consistency와 spec.md ↔
  // manifest의 일치만 본다. manifest.json 전체가 spec.md와 함께 "일관되게" 조작되면(세 값
  // 모두 같은 새 내용을 가리키도록 함께 바뀌면) 위 체크만으로는 최종적으로 actualIdentity가
  // expectedIdentity와 달라지는 것에 의존해서만 걸러진다 — 그 의존성을 명시적으로 만들기
  // 위해, spec.md의 실제 바이트를 호출부가 아는 expectedIdentity.specIntegrityAlgorithm/Hash로
  // 직접 재해시해 한 번 더 독립적으로 대조한다(manifest.json의 어떤 필드도 거치지 않는
  // 별도 경로 — manifest 전체가 조작돼도 우회할 수 없다).
  const directHash = createHash(expectedIdentity.specIntegrityAlgorithm).update(specContent, "utf8").digest("hex");
  if (directHash !== expectedIdentity.specIntegrityHash) {
    return {
      ok: false,
      code: "MASTER_SPEC_DIGEST_MISMATCH",
      detail: "master-spec/spec.md의 실제 digest가 호출부가 아는 expectedIdentity.specIntegrityHash와 일치하지 않습니다 — 변조가 의심되어 중단합니다.",
    };
  }

  if (m.specStatus !== "APPROVED") {
    return { ok: false, code: "SPEC_NOT_APPROVED", detail: `specStatus가 APPROVED가 아닙니다(현재: ${m.specStatus}).` };
  }
  if (m.userApproval !== "PASS") {
    return { ok: false, code: "USER_APPROVAL_NOT_PASS", detail: `userApproval이 PASS가 아닙니다(현재: ${m.userApproval}).` };
  }
  if (m.reviewerGate.critical !== 0 || m.reviewerGate.high !== 0) {
    return {
      ok: false,
      code: "REVIEWER_GATE_NOT_ZERO",
      detail: `reviewerGate가 0이 아닙니다(critical=${m.reviewerGate.critical}, high=${m.reviewerGate.high}).`,
    };
  }
  if (m.unresolvedCriticalCount !== 0 || m.contradictionCount !== 0) {
    return {
      ok: false,
      code: "UNRESOLVED_OR_CONTRADICTION_NOT_ZERO",
      detail: `unresolvedCriticalCount(${m.unresolvedCriticalCount}) 또는 contradictionCount(${m.contradictionCount})가 0이 아닙니다.`,
    };
  }

  const actualIdentity: BootstrapRequestIdentity = {
    handoffId: m.handoffId,
    projectId: m.projectId,
    specVersion: m.specVersion,
    specIntegrityAlgorithm: m.specIntegrity.algorithm,
    specIntegrityHash: m.specIntegrity.hash.toLowerCase(),
  };
  if (!identitiesMatch(actualIdentity, expectedIdentity)) {
    return {
      ok: false,
      code: "EXPECTED_IDENTITY_MISMATCH",
      detail: "호출부가 지정한 expectedIdentity가 이 project root에 실제로 보존된 identity와 일치하지 않습니다.",
    };
  }

  return { ok: true, input: { identity: actualIdentity, projectName: m.projectName, specContent } };
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

export interface PlannerTrustedConfig {
  /** 지정하지 않으면 createClaudeCliRawOutputSource()(실제 claude CLI)를 쓴다. 테스트는
   *  항상 deterministic fixture를 명시적으로 주입한다. */
  rawOutputSource?: PlannerRawOutputSource;
  now?: () => Date;
}

export type PlannerOutcome =
  | { status: "BLOCKED"; code: PlannerBlockedCode; detail: string }
  | { status: "CONFLICT"; detail: string; existingIdentity: BootstrapRequestIdentity; requestedIdentity: BootstrapRequestIdentity }
  | { status: "REJECTED"; issues: PlannerValidationIssue[] }
  | {
      // GPT Independent Reviewer 지적(SI-3 REVISE 2회차, HIGH) — fixedConstraintComplianceNote
      // 필드만으로는 호출자가 note를 무시하고 그대로 실행을 진행할 수 있었다("알림"일 뿐
      // 실제 상태 전이를 막지 못함). Fixed Constraint가 하나라도 있으면(HOW가 그 constraint를
      // 실제로 지키는지는 이 Validator가 기계적으로 검증할 수 없으므로) status 자체가 절대
      // "READY_FOR_AUTODEV"/"ALREADY_READY"가 아니라 "HUMAN_REVIEW_REQUIRED"가 된다 —
      // capability-resolver.ts가 자동으로 검증할 수 없는 위험을 HUMAN_APPROVAL_REQUIRED로
      // 분류하고 자동 선택을 구조적으로 막는 것과 동일한 원칙. fixedConstraints가 없는(드문)
      // 경우에만 기존과 동일하게 READY_FOR_AUTODEV(최초 완료)/ALREADY_READY(재실행)를 쓴다.
      status: "READY_FOR_AUTODEV" | "ALREADY_READY" | "HUMAN_REVIEW_REQUIRED";
      projectRoot: string;
      plannerStatePath: string;
      projectManifestPath: string;
      taskRegistryPath: string;
      executionPolicyPath: string;
      firstRunnableTask: TaskDefinition | null;
      /** § PersistedProjectManifestFile.fixedConstraintComplianceNote — 파일을 열어보지
       *  않아도 호출자가 바로 볼 수 있도록 outcome에도 그대로 노출한다. null이 아니면 항상
       *  status==="HUMAN_REVIEW_REQUIRED"다. */
      fixedConstraintComplianceNote: string | null;
    };

/**
 * GPT Independent Reviewer 지적(SI-3 REVISE 3회차, HIGH) — .autodev 디렉터리 자체의
 * containment만 확인해서는 그 "안"에 있는 개별 파일(project-manifest.json/task-registry.json/
 * execution-policy.json) 각각이 symlink로 project root 밖의 다른 파일을 가리키는 경우를
 * 막지 못한다(호출 시작 전부터 이미 존재하는 안정적인 symlink 포함 — "확인 직후 swap"되는
 * race와는 다른, 더 단순하고 항상 재현 가능한 문제). 읽기 전에 lstat로 symlink 자체를
 * 무조건 거부하고(따라가지 않음), realpath가 검증된 project root 내부인지 재확인한다.
 */
function readTrustedGeneratedFile(filePath: string, projectRootReal: string): { ok: true; content: string } | { ok: false; detail: string } {
  let st;
  try {
    st = lstatSync(filePath);
  } catch (e) {
    return { ok: false, detail: `파일 확인 실패(${filePath}): ${e instanceof Error ? e.message : String(e)}` };
  }
  if (st.isSymbolicLink()) {
    return { ok: false, detail: `${filePath}가 symlink입니다 — 신뢰할 수 없어 읽기를 거부합니다.` };
  }
  if (!st.isFile()) {
    return { ok: false, detail: `${filePath}가 일반 파일이 아닙니다.` };
  }
  let real: string;
  try {
    real = realpathSync(filePath);
  } catch (e) {
    return { ok: false, detail: `realpath 확인 실패(${filePath}): ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isRealPathWithin(real, projectRootReal)) {
    return { ok: false, detail: `${filePath}가 project root 밖을 가리킵니다.` };
  }
  try {
    return { ok: true, content: readFileSync(filePath, "utf-8") };
  } catch (e) {
    return { ok: false, detail: `파일 읽기 실패(${filePath}): ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * projectRoot/.autodev/ 아래 저장된 3개 생성 파일을 다시 읽어 처음 생성했을 때와 동일한
 * Core 검증(validateProjectManifest/validateProjectExecutionPolicy/task id 중복 없음)을
 * 다시 통과하는지 확인한다. GPT Independent Reviewer 지적(SI-3 REVISE 2회차, HIGH) — 이전에는
 * EXECUTION_DATA_GENERATED→EXECUTION_DATA_VALIDATED 전환 시점에만 이 재확인을 했고,
 * stage===COMPLETED 이후(ALREADY_READY 재실행 경로)에는 파일을 다시 검증하지 않고 그대로
 * "준비됨"으로 보고했다 — COMPLETED 이후 누군가 파일을 직접 변조/손상시켜도 감지하지
 * 못했다. 이제 EXECUTION_DATA_GENERATED 전환과 매 ALREADY_READY/최종 완료 보고 양쪽 모두
 * 이 동일한 함수로 재검증한다(로직 복제 없음).
 */
function reloadAndValidateGeneratedData(
  projectRoot: string,
  projectId: string
): { ok: true; taskRegistry: TaskDefinition[]; manifestFile: PersistedProjectManifestFile } | { ok: false; detail: string } {
  try {
    const projectRootReal = realpathSync(projectRoot);
    const taskRegistryFile = readTrustedGeneratedFile(generatedTaskRegistryPath(projectRoot), projectRootReal);
    if (!taskRegistryFile.ok) return taskRegistryFile;
    const executionPolicyFile = readTrustedGeneratedFile(generatedExecutionPolicyPath(projectRoot), projectRootReal);
    if (!executionPolicyFile.ok) return executionPolicyFile;
    const manifestFileRaw = readTrustedGeneratedFile(generatedManifestPath(projectRoot), projectRootReal);
    if (!manifestFileRaw.ok) return manifestFileRaw;

    const taskRegistry = JSON.parse(taskRegistryFile.content) as TaskDefinition[];
    const executionPolicy = JSON.parse(executionPolicyFile.content) as ProjectExecutionPolicy;
    const manifestFile = JSON.parse(manifestFileRaw.content) as PersistedProjectManifestFile;
    const manifest = assembleProjectManifest({ manifestFile, taskRegistry, executionPolicy });
    validateProjectManifest(manifest);
    validateProjectExecutionPolicy(executionPolicy, projectId);
    const ids = new Set<string>();
    for (const t of taskRegistry) {
      if (ids.has(t.id)) throw new Error(`재확인 중 중복 task id 발견: ${t.id}`);
      ids.add(t.id);
    }
    return { ok: true, taskRegistry, manifestFile };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * GPT Independent Reviewer 지적(SI-3 REVISE 3회차, HIGH) — 이전에는 status(READY_FOR_AUTODEV
 * vs HUMAN_REVIEW_REQUIRED) 판정을 persisted manifestFile.fixedConstraintComplianceNote
 * 필드의 null 여부에서 가져왔다 — 이 필드는 project-manifest.json 안의 평범한 데이터라,
 * fixedConstraints는 그대로 둔 채 note만 지우거나 둘을 함께 지우는 변조/손상이 있으면
 * validateProjectManifest()가 그 불일치를 알지 못해 그대로 통과시킬 수 있었다(즉 gate
 * 자체를 우회 가능). 이제 hasFixedConstraints는 이 호출 직전에 이미 재검증된 원본 spec.md
 * (evaluateTrustedPlannerInput의 digest 대조를 통과한 신뢰 입력)를 다시 정규화해서 얻은
 * 값만 쓴다 — persisted 파일의 어떤 필드도 이 판정에 관여하지 않는다. 추가로, persisted
 * note가 이 신뢰된 판정과 불일치하면(변조/손상의 증거이므로) 조용히 무시하지 않고
 * GENERATED_DATA_INVALID로 BLOCK한다.
 */
function readyOutcome(
  freshness: "FRESH" | "IDEMPOTENT",
  projectRoot: string,
  projectId: string,
  hasFixedConstraints: boolean
): PlannerOutcome {
  const reloaded = reloadAndValidateGeneratedData(projectRoot, projectId);
  if (!reloaded.ok) {
    return { status: "BLOCKED", code: "GENERATED_DATA_INVALID", detail: `저장된 실행 데이터 재확인 실패: ${reloaded.detail}` };
  }
  const persistedNote = reloaded.manifestFile.fixedConstraintComplianceNote;
  if ((persistedNote !== null) !== hasFixedConstraints) {
    return {
      status: "BLOCKED",
      code: "GENERATED_DATA_INVALID",
      detail: "저장된 project-manifest.json의 fixedConstraintComplianceNote가 신뢰된 Master Spec의 fixed constraint 존재 여부와 일치하지 않습니다 — 변조/손상이 의심되어 중단합니다.",
    };
  }
  const note = hasFixedConstraints ? FIXED_CONSTRAINT_COMPLIANCE_NOTE : null;
  const status: "READY_FOR_AUTODEV" | "ALREADY_READY" | "HUMAN_REVIEW_REQUIRED" =
    hasFixedConstraints ? "HUMAN_REVIEW_REQUIRED" : freshness === "FRESH" ? "READY_FOR_AUTODEV" : "ALREADY_READY";
  return {
    status,
    projectRoot,
    plannerStatePath: plannerStateFilePath(projectRoot),
    projectManifestPath: generatedManifestPath(projectRoot),
    taskRegistryPath: generatedTaskRegistryPath(projectRoot),
    executionPolicyPath: generatedExecutionPolicyPath(projectRoot),
    firstRunnableTask: getNextTask(reloaded.taskRegistry, []),
    fixedConstraintComplianceNote: note,
  };
}

/**
 * SI-2가 완료한 projectRoot를 대상으로 Planner를 실행한다 — projectRoot/.autodev/ 아래의
 * Bootstrap 산출물만 신뢰 입력으로 재검증하고(§ evaluateTrustedPlannerInput), 통과하면
 * Master Spec을 정규화(WHAT)한 뒤 config.rawOutputSource(HOW, LLM 또는 fixture)를 호출해
 * validatePlannerRawOutput()으로 검증하고, 통과한 결과만 Core 타입(ProjectManifest/
 * TaskDefinition/ProjectExecutionPolicy)으로 변환해 projectRoot/.autodev/ 아래 저장한다.
 * 동일 identity로 재호출하면 idempotent(이미 COMPLETED면 재생성 없이 동일 결과 반환)하고,
 * 같은 project root에 다른 identity가 이미 기록돼 있으면 CONFLICT를 반환한다. 중간 실패 후
 * 재호출하면 마지막으로 성공한 stage부터 이어서 진행한다(resume-safe) — 이미 검증을 통과한
 * rawPlannerOutput이 저장돼 있으면 rawOutputSource를 다시 호출하지 않는다.
 *
 * 실제 작업은 runPlannerLocked()가 담당하고, 이 함수는 그 앞뒤로 projectId 단위 Project
 * Lock(project-lock.ts, 이미 존재하는 Core 동시성 방어 서비스 — Phase G Task G7)만 얹는다.
 * GPT Independent Reviewer 지적(SI-3 REVISE 1회차, HIGH) — 이 lock이 없으면 같은 project
 * root를 대상으로 한 두 runPlanner() 동시 호출이 서로 다른 시점의 상태를 읽고 각자 LLM을
 * 호출해 planner-state.json/생성 파일을 교차 덮어쓸 수 있었다. project-lock.ts는 이미 이
 * 저장소의 "동시 writer 방지"에 대한 단일 설계 원칙(check-then-create 금지, PID liveness로만
 * stale 복구)을 갖고 있으므로 그대로 재사용한다(복제 금지) — ownerKind는 기존 "autodev"를
 * 그대로 쓴다(이 project는 아직 실제 task 실행을 시작하지 않았으므로 실제 concurrent
 * task-execution lock과 충돌할 여지가 없다).
 */
export async function runPlanner(
  projectRoot: string,
  expectedIdentity: BootstrapRequestIdentity,
  config: PlannerTrustedConfig = {}
): Promise<PlannerOutcome> {
  const resolvedRoot = resolve(projectRoot);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    return { status: "BLOCKED", code: "INVALID_PROJECT_ROOT", detail: `projectRoot가 존재하지 않거나 디렉터리가 아닙니다: ${resolvedRoot}` };
  }

  const lockAcquire = acquireProjectLock({ projectId: expectedIdentity.projectId, targetProjectRoot: resolvedRoot, ownerKind: "autodev" });
  if (!lockAcquire.ok) {
    return {
      status: "BLOCKED",
      code: "CONCURRENT_PLANNER_RUN_IN_PROGRESS",
      detail: `${lockAcquire.reason} (code=${lockAcquire.code})`,
    };
  }
  try {
    // finally가 lock을 놓기 전에 실제 작업이 전부 끝나도록 반드시 await한다 — await 없이
    // Promise를 그대로 return하면 finally가 즉시(작업이 끝나기 전에) 실행돼 lock이 조기
    // release되는 race가 생긴다.
    return await runPlannerLocked(resolvedRoot, expectedIdentity, config);
  } finally {
    releaseProjectLock(lockAcquire.lock);
  }
}

async function runPlannerLocked(
  resolvedRoot: string,
  expectedIdentity: BootstrapRequestIdentity,
  config: PlannerTrustedConfig
): Promise<PlannerOutcome> {
  let projectRootReal: string;
  try {
    projectRootReal = realpathSync(resolvedRoot);
  } catch (e) {
    return { status: "BLOCKED", code: "INVALID_PROJECT_ROOT", detail: `projectRoot realpath 확인 실패: ${e instanceof Error ? e.message : String(e)}` };
  }

  const trustedInputResult = evaluateTrustedPlannerInput(resolvedRoot, expectedIdentity);
  if (!trustedInputResult.ok) {
    return { status: "BLOCKED", code: trustedInputResult.code, detail: trustedInputResult.detail };
  }
  const { identity, projectName, specContent } = trustedInputResult.input;

  // normalizeMasterSpec()은 순수/저비용 함수이므로 stage 분기보다 먼저(신뢰된 specContent를
  // 얻은 직후) 계산해둔다 — IDEMPOTENT(COMPLETED) 조기 반환 경로도 hasFixedConstraints를
  // persisted 파일이 아니라 이 신뢰된 재계산 값에서만 얻어야 하기 때문이다(§ readyOutcome
  // 상단 주석, GPT Independent Reviewer 지적 SI-3 REVISE 3회차 HIGH).
  const normalized = normalizeMasterSpec(specContent);
  if (normalized.unrecognizedHeaders.length > 0) {
    return {
      status: "BLOCKED",
      code: "UNRECOGNIZED_MASTER_SPEC_SECTION",
      detail: `Master Spec에 알려지지 않은 "## " 섹션 헤더가 있어 WHAT이 조용히 누락될 위험이 있습니다: ${normalized.unrecognizedHeaders.join(", ")}`,
    };
  }
  const hasFixedConstraints = normalized.fixedConstraints.length > 0;

  // .autodev 하위가 symlink/junction으로 project root 밖을 가리키면(SI-2가 이미 만든
  // 디렉터리이지만, 이후 외부에서 교체됐을 가능성에 대비) 실제 write 직전에 다시 확인한다
  // (project-bootstrap.ts의 assertExistingSubPathContained와 동일한 방어 원칙, 재사용은
  // 불가능해(비공개 함수) 최소한의 동일 판정만 여기서 반복한다).
  const autodevDir = join(resolvedRoot, ".autodev");
  if (existsSync(autodevDir)) {
    let autodevReal: string;
    try {
      autodevReal = realpathSync(autodevDir);
    } catch (e) {
      return { status: "BLOCKED", code: "PROJECT_ROOT_ESCAPE", detail: `.autodev 확인 실패: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!isRealPathWithin(autodevReal, projectRootReal)) {
      return { status: "BLOCKED", code: "PROJECT_ROOT_ESCAPE", detail: ".autodev가 symlink/junction을 통해 project root 밖을 가리킵니다." };
    }
  }

  const stateRead = readPlannerState(resolvedRoot);
  if (stateRead.kind === "corrupt") {
    return { status: "BLOCKED", code: "PLANNER_STATE_CORRUPT", detail: stateRead.detail };
  }

  let cur: PlannerStateFile;
  if (stateRead.kind === "absent") {
    cur = { schemaVersion: PLANNER_STATE_SCHEMA_VERSION, identity, stage: "SPEC_VERIFIED", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const w = writeJsonAtomic(plannerStateFilePath(resolvedRoot), cur);
    if (!w.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: w.detail };
  } else {
    if (!identitiesMatch(stateRead.state.identity, identity)) {
      return { status: "CONFLICT", detail: "같은 project root에 다른 identity(specVersion/specIntegrity 등)의 Planner 상태가 이미 존재합니다.", existingIdentity: stateRead.state.identity, requestedIdentity: identity };
    }
    if (stateRead.state.stage === "COMPLETED") {
      return readyOutcome("IDEMPOTENT", resolvedRoot, identity.projectId, hasFixedConstraints);
    }
    cur = stateRead.state;
  }

  const now = config.now ? config.now() : new Date();
  const rawOutputSource = config.rawOutputSource ?? createClaudeCliRawOutputSource();

  if (cur.stage === "SPEC_VERIFIED") {
    cur = { ...cur, stage: "REQUIREMENTS_NORMALIZED", updatedAt: new Date().toISOString() };
    const w = writeJsonAtomic(plannerStateFilePath(resolvedRoot), cur);
    if (!w.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: w.detail };
  }

  if (cur.stage === "REQUIREMENTS_NORMALIZED") {
    // Correction retry(§ 요구사항 C) — MALFORMED_JSON/schema 위반이면 validatePlannerRawOutput()이
    // 찾은 실제 issues를 그대로 buildPlannerCorrectionPrompt()에 실어 같은 rawOutputSource를
    // 다시 부른다(§ 새 provider/우회 경로 없음). 값을 임의로 보정하지 않는다 — 매 시도는 여전히
    // validatePlannerRawOutput() 전체를 다시 통과해야 한다. PLANNER_MAX_RAW_OUTPUT_ATTEMPTS로
    // 상한을 둬 무한 재시도를 금지한다 — 모든 시도가 실패하면 마지막 시도의 issues로 REJECTED한다.
    let lastIssues: PlannerValidationIssue[] = [];
    let acceptedRawOutput: string | null = null;
    for (let attempt = 1; attempt <= PLANNER_MAX_RAW_OUTPUT_ATTEMPTS; attempt += 1) {
      const prompt =
        attempt === 1 ? buildPlannerPrompt(normalized, identity) : buildPlannerCorrectionPrompt(normalized, identity, lastIssues);
      const sourceResult = await invokeRawOutputSourceWithTransportRetry(rawOutputSource, prompt);
      if (!sourceResult.ok) {
        return { status: "BLOCKED", code: "RAW_OUTPUT_SOURCE_FAILED", detail: sourceResult.reason };
      }
      const validation = validatePlannerRawOutput(sourceResult.rawOutput, normalized, identity);
      if (validation.ok) {
        // § validatePlannerRawOutput 상단 주석 — 반드시 normalizedJsonText(순수 JSON)를
        // 저장한다. 원본 sourceResult.rawOutput을 저장하면 설명문/markdown fence가 섞인
        // 원문이 rawPlannerOutput에 남아, 다음 stage(EXECUTION_DATA_GENERATED)에서 다시
        // JSON.parse(cur.rawPlannerOutput)가 실패한다.
        acceptedRawOutput = validation.normalizedJsonText;
        break;
      }
      lastIssues = validation.issues;
    }
    if (acceptedRawOutput === null) {
      const withDiagnostics: PlannerStateFile = { ...cur, lastValidationIssues: lastIssues, updatedAt: new Date().toISOString() };
      writeJsonAtomic(plannerStateFilePath(resolvedRoot), withDiagnostics); // best-effort — 실패해도 REJECTED 반환 자체는 막지 않는다.
      return { status: "REJECTED", issues: lastIssues };
    }
    cur = { ...cur, stage: "ARCHITECTURE_PLANNED", rawPlannerOutput: acceptedRawOutput, lastValidationIssues: undefined, updatedAt: new Date().toISOString() };
    const w = writeJsonAtomic(plannerStateFilePath(resolvedRoot), cur);
    if (!w.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: w.detail };
  }

  if (cur.stage === "ARCHITECTURE_PLANNED") {
    if (!cur.rawPlannerOutput) {
      return { status: "BLOCKED", code: "PLANNER_STATE_CORRUPT", detail: "stage=ARCHITECTURE_PLANNED인데 rawPlannerOutput이 저장돼 있지 않습니다." };
    }
    // GPT Independent Reviewer 지적(SI-3 REVISE 2회차, MEDIUM) — planner-state.json이 구조
    // 검증(isValidPlannerStateFile — rawPlannerOutput이 string인지)은 통과했지만 그 문자열
    // 내용 자체는 손상된 경우(예: 저장 도중 중단), JSON.parse가 여기서 그대로 throw해
    // 구조화된 BLOCKED 대신 처리되지 않은 예외로 전파될 수 있었다. buildGeneratedExecutionData
    // 자체도 raw의 세부 필드 접근에서 예상치 못한 값(resume 경로로만 도달 가능한 손상)에
    // 던질 수 있어 같은 try 안에서 함께 방어한다.
    let manifest: ProjectManifest;
    let generated: ReturnType<typeof buildGeneratedExecutionData>;
    try {
      const raw = JSON.parse(cur.rawPlannerOutput) as PlannerRawOutput;
      generated = buildGeneratedExecutionData(raw, normalized, identity, projectName, resolvedRoot, now);
      manifest = assembleProjectManifest(generated);
      validateProjectManifest(manifest);
      validateProjectExecutionPolicy(generated.executionPolicy, identity.projectId);
    } catch (e) {
      return { status: "BLOCKED", code: "GENERATED_DATA_INVALID", detail: `생성된 실행 데이터가 Core 검증을 통과하지 못했습니다: ${e instanceof Error ? e.message : String(e)}` };
    }

    // GPT Independent Reviewer 지적(SI-3 REVISE 2회차, HIGH) — 이 시점 이전에 유일하게 긴
    // 비동기 대기(rawOutputSource 호출, 실제 LLM이면 수십~수백 초)가 있었다. 그 사이
    // project root/.autodev가 symlink로 교체됐을 가능성에 대비해 실제 write 직전에
    // containment를 다시 확인한다(project-bootstrap.ts의 advanceBootstrap()과 동일한 "write
    // 직전 재확인" 원칙). 완전한 TOCTOU 방지는 아니다 — project-bootstrap.ts의
    // verifySpecContentRefFile() 상단 주석이 이미 문서화했듯, 순수 Node.js 동기 API만으로는
    // realpath 확인과 실제 open/write를 원자적으로 묶을 방법이 없다(네이티브 addon 없이는
    // 해결 불가한 플랫폼/런타임 한계) — 이 함수는 그 문서화된 잔여 위험과 동일한 성격의
    // best-effort 재확인을 추가할 뿐이다.
    let projectRootRealNow: string;
    try {
      projectRootRealNow = realpathSync(resolvedRoot);
    } catch (e) {
      return { status: "BLOCKED", code: "PROJECT_ROOT_ESCAPE", detail: `write 직전 project root 재확인 실패: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (projectRootRealNow !== projectRootReal) {
      return { status: "BLOCKED", code: "PROJECT_ROOT_ESCAPE", detail: "project root의 실제 대상이 처리 도중 바뀐 것으로 보여 안전하게 중단했습니다." };
    }
    const autodevDirNow = join(resolvedRoot, ".autodev");
    if (existsSync(autodevDirNow)) {
      let autodevRealNow: string;
      try {
        autodevRealNow = realpathSync(autodevDirNow);
      } catch (e) {
        return { status: "BLOCKED", code: "PROJECT_ROOT_ESCAPE", detail: `write 직전 .autodev 재확인 실패: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (!isRealPathWithin(autodevRealNow, projectRootRealNow)) {
        return { status: "BLOCKED", code: "PROJECT_ROOT_ESCAPE", detail: "write 직전 .autodev가 symlink/junction을 통해 project root 밖을 가리킵니다." };
      }
    }

    const writes = [
      writeJsonAtomic(generatedManifestPath(resolvedRoot), generated.manifestFile),
      writeJsonAtomic(generatedTaskRegistryPath(resolvedRoot), generated.taskRegistry),
      writeJsonAtomic(generatedExecutionPolicyPath(resolvedRoot), generated.executionPolicy),
    ];
    const failed = writes.find((w) => !w.ok) as { ok: false; detail: string } | undefined;
    if (failed) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: failed.detail };

    cur = { ...cur, stage: "EXECUTION_DATA_GENERATED", updatedAt: new Date().toISOString() };
    const w = writeJsonAtomic(plannerStateFilePath(resolvedRoot), cur);
    if (!w.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: w.detail };
  }

  if (cur.stage === "EXECUTION_DATA_GENERATED") {
    // 저장된 파일을 다시 읽어 round-trip 무결성을 재확인한다(project-bootstrap.ts의
    // preserveMasterSpec 재확인 패턴과 동일한 원칙 — 쓰기 도중 손상을 여기서 잡는다). 로직은
    // readyOutcome()이 COMPLETED 이후 재확인할 때와 동일한 reloadAndValidateGeneratedData()를
    // 그대로 재사용한다(복제 금지).
    const reloaded = reloadAndValidateGeneratedData(resolvedRoot, identity.projectId);
    if (!reloaded.ok) {
      return { status: "BLOCKED", code: "GENERATED_DATA_INVALID", detail: `저장된 실행 데이터 재확인 실패: ${reloaded.detail}` };
    }
    cur = { ...cur, stage: "EXECUTION_DATA_VALIDATED", updatedAt: new Date().toISOString() };
    const w = writeJsonAtomic(plannerStateFilePath(resolvedRoot), cur);
    if (!w.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: w.detail };
  }

  if (cur.stage === "EXECUTION_DATA_VALIDATED") {
    cur = { ...cur, stage: "COMPLETED", updatedAt: new Date().toISOString() };
    const w = writeJsonAtomic(plannerStateFilePath(resolvedRoot), cur);
    if (!w.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: w.detail };
  }

  return readyOutcome("FRESH", resolvedRoot, identity.projectId, hasFixedConstraints);
}
