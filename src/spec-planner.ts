import {
  existsSync,
  statSync,
  lstatSync,
  fstatSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  realpathSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
  constants,
} from "node:fs";
import { resolve, join, dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { isRealPathWithin, assertNoSymlinkInChain } from "./project-bootstrap";
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
import {
  validateRequiredTestExecutionContract,
  deriveAllowedCommandsFromRequiredTests,
  mergeAllowedCommands,
  filterAllowedCommandsByCoreCapability,
  deriveDependencyResolutionCommands,
} from "./execution-contract";
import type { ExecutionContractIssue, RequiredTestOwner } from "./execution-contract";

// AutoDev Core 선행 업그레이드 — Incremental / Chunked Planner (SI-3.3).
//
// SI-3(spec-planner.ts 최초 버전)는 "대형 Master Spec → 단일 Claude 호출 → 전체
// Architecture+Phase+Task+ExecutionPolicy JSON" 구조였다. 실제 JARVIS Master Spec으로
// 검증한 결과 이 단일 호출이 300초(SI-3.2가 이미 늘린 Planner 전용 timeout) + transport
// retry 1회 후에도 반복 TIMEOUT됐다(§ Task SI-3.3 prompt 진단 — claude CLI/인증/네트워크
// 자체는 정상, 대형 단일 요청 구조 자체가 병목). 이 모듈은 그 단일 거대 요청을 제거하고
// STAGE 1(ARCHITECTURE) → STAGE 2(PHASE PLAN) → STAGE 3(TASK PLAN, Phase별 개별 호출)
// → STAGE 4(GLOBAL TRACEABILITY, deterministic) → STAGE 5(FINAL ASSEMBLY, deterministic)
// 로 나눈 incremental pipeline으로 대체한다. 각 LLM stage는 검증된 좁은 범위의 JSON만
// 요구하므로 프롬프트/응답이 작고, Phase별 Task 생성은 독립적인 correction/transport retry
// 예산과 독립적인 checkpoint를 가져 부분 실패가 이미 완료된 이전 단계/이전 Phase를
// 재호출시키지 않는다(§ evaluateTrustedPlannerInput/runPlannerLocked 아래).
//
// SI-1(spec-intake.ts)/SI-2(project-bootstrap.ts)와의 관계, 신뢰 경계(§
// evaluateTrustedPlannerInput), Master Spec 정규화(normalizeMasterSpec, 순수/LLM 없음),
// projectRoot 외부 주입 원칙은 SI-3와 동일하다 — 이 주석은 SI-3.3에서 바뀐 부분(단일 호출
// → incremental pipeline)에 집중한다. 이 모듈은 여전히 project-manifest.ts/task-registry.ts/
// project-policy.ts의 타입/검증 함수를 그대로 재사용한다(병렬 시스템 없음) — 특히 STAGE
// 5(Final Assembly)는 검증된 단계별 산출물(Architecture/Phase Plan/Phase별 Task Plan)을
// synthesizeLegacyRawOutput()으로 SI-3가 이미 쓰던 PlannerRawOutput 모양으로 순수
// deterministic 조립한 뒤, SI-3의 buildGeneratedExecutionData/assembleProjectManifest를
// 그대로 재사용한다 — LLM이 최종 실행 데이터를 다시 통째로 생성하지 않는다.

// ---------------------------------------------------------------------------
// Master Spec 정규화 — 순수 deterministic 파서(LLM 없음). SI-3과 동일, 변경 없음.
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
  /** 알려진 섹션 이름과 일치하지 않는 "## ..." 헤더 시도가 있으면 여기 기록되고,
   *  runPlanner()가 이를 즉시 BLOCK한다(침묵하는 손실 대신 fail closed). */
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

const HEADER_LOOKALIKE_RE = /^(#{1,6})[ \t]*(.*?)\s*$/;
const LIST_ITEM_RE = /^-\s+(.+)$/;

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
      current = spec ?? null;
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
// 공유 raw-output 조각 타입 — 여러 stage/최종 조립에서 재사용된다.
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
  /** AutoDev Core Maintenance(2026-09-03) — § task-registry.ts TaskDefinition.requiresHumanReview
   *  주석 참고. LLM이 completionGate 자유 텍스트를 다시 해석해서 유도하지 않는다 — Core가
   *  이 필드를 그대로 TaskDefinition.requiresHumanReview로 전달한다. */
  requiresHumanReview: boolean;
}

export interface PlannerRawExecutionPolicy {
  allowedReadPrefixes: string[];
  allowedWritePrefixes: string[];
  commandCwdAliases?: Record<string, string>;
  allowedCommands: AllowedCommandSpec[];
}

/** STAGE 5(Final Assembly)가 조립하는 legacy 모양 — LLM이 직접 만들지 않는다(§ 파일 상단
 *  주석). synthesizeLegacyRawOutput()만 이 타입의 값을 만든다. */
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
// 검증 공용 유틸 — 여러 stage validator가 공유한다.
// ---------------------------------------------------------------------------

export type PlannerValidationIssueCode =
  | "MALFORMED_JSON"
  | "INVALID_STRUCTURE"
  | "PROJECT_ID_MISMATCH"
  | "SPEC_VERSION_MISMATCH"
  | "TASK_STAGE_PHASE_MISMATCH"
  | "DUPLICATE_PHASE_ID"
  | "DUPLICATE_TASK_ID"
  | "MISSING_DEPENDENCY"
  | "DEPENDENCY_CYCLE"
  | "MISSING_MUST_HAVE_COVERAGE"
  | "MISSING_REQUIREMENT_COVERAGE"
  | "MISSING_ACCEPTANCE_CRITERIA_COVERAGE"
  | "UNKNOWN_REQUIREMENT_REFERENCE"
  | "DEFERRED_OR_OUT_OF_SCOPE_REFERENCED"
  | "FIXED_CONSTRAINT_ACKNOWLEDGEMENT_MISSING"
  | "FIXED_CONSTRAINT_VIOLATION"
  | "UNSAFE_EXECUTION_POLICY"
  | "DESTRUCTIVE_COMMAND_REQUESTED"
  | "PRODUCTION_DEPLOY_REQUESTED"
  | "SECRET_SHAPED_OUTPUT"
  | "NO_RUNNABLE_TASK_FOUND"
  | "PHASE_DEPENDENCY_ORDER_VIOLATION"
  | "TASK_DEPENDENCY_PHASE_ORDER_VIOLATION"
  | "REQUIREMENT_OUTSIDE_PHASE_SCOPE"
  | "ACCEPTANCE_CRITERIA_OUTSIDE_PHASE_SCOPE"
  | "TOO_MANY_PHASES"
  | "TOO_MANY_TASKS_IN_PHASE"
  | "UNSAFE_TASK_SCOPE"
  | "REQUIRED_TEST_NOT_EXECUTABLE";

export interface PlannerValidationIssue {
  code: PlannerValidationIssueCode;
  detail: string;
}

const PHASE_ID_RE = /^[1-9]\d*$/;
const TASK_ID_RE = /^([1-9]\d*)\.([1-9]\d*)$/;
const ID_FAMILY_SHAPE = /^[A-Z]{2,4}-\d{1,6}$/;
const PHASE_ID_ECHO_SHAPE = /^[1-9]\d{0,5}$/;
const TASK_ID_ECHO_SHAPE = /^[1-9]\d{0,5}\.[1-9]\d{0,5}$/;
const COMMAND_NAME_SHAPE = /^[a-z][a-z0-9_-]{0,14}$/;

// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 재검증, HIGH) — Phase Plan의 phase 개수와
// Phase별 task 개수에 상한이 없었다 — phase 하나마다 STAGE 3 LLM 호출이 하나씩 발생하므로
// (§ validatePhasePlanRawOutput/validatePhaseTaskRawOutput 사용 지점 주석), 신뢰할 수 없는
// LLM 응답이 과도한 개수를 반환하면 호출 횟수/비용/실행 시간이 무제한 증폭될 수 있다. 이
// 값은 Core가 소유하며 project policy로 확대할 수 없다(검증 함수가 policy를 인자로 받지
// 않음). 실제 프로젝트 규모를 고려해 넉넉하되 무제한은 아닌 값을 고른다.
export const PLANNER_MAX_PHASES = 50;
export const PLANNER_MAX_TASKS_PER_PHASE = 50;

// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차, HIGH) — 이전 isSafeScopePrefix()는
// "/"만 구분자로 취급했다(split("/").includes(".."), 정규식도 "/" 기준). Windows에서는
// "\"도 유효한 경로 구분자라 "a\\..\\b/" 같은 값이 "/" 기준 분해로는 ".." 세그먼트가 전혀
// 보이지 않아 그대로 통과했고, "\\\\server\\share/"(UNC)도 "/"로 시작하지 않고 드라이브
// 문자도 없어 통과했다("//server/share/"류 POSIX-style UNC는 이미 startsWith("/")로
// 막혀 있었다 — 비대칭 방어였다). 문자열 치환/정규식 조합으로 매 우회 사례를 개별
// 패치하는 대신, 이 프로젝트의 scope prefix 표기 관례(항상 "/" 구분자, 항상 project-relative)
// 자체를 강제하는 단일 canonical validator로 교체한다 — "\"가 하나라도 있으면 그 자체로
// 거부(Windows 구분자/UNC(\\server\share)/mixed-separator 우회를 파생 규칙 없이 한 번에
// 차단), 그 다음 "/"만 구분자로 신뢰하고 세그먼트 단위로 "."/".."을 판정한다("." 세그먼트도
// 거부해 "./"·"./sub/" 같은 현재-디렉터리 기반 broad prefix까지 막는다). allowedReadPrefixes/
// allowedWritePrefixes(trailing "/" 필수)와 commandCwdAliases 값(trailing "/" 불필요, cwd
// alias는 디렉터리 자체를 가리키므로 trailing slash 관례가 다르다)이 이 함수 하나를
// requireTrailingSlash 옵션만 다르게 재사용한다 — 로직 복제 없음.
//
// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 재검증, HIGH) — 위 1차 수정도 세그먼트를
// 원문 그대로 "."/".."와 비교할 뿐이었다. Windows는 파일/디렉터리 이름 끝의 "."와 " "을
// 조용히 제거한다("foo. "와 "foo. ."는 실제로 "foo"를 가리킨다) — 그래서 "..  "(마침표+공백)
// 처럼 원문은 ".."와 다르지만 Windows API가 실제로는 ".."로 취급하는 값이 그대로 통과할 수
// 있었다. 각 세그먼트에서 후행 "."/" "을 제거한 뒤에도 다시 "."/".."/빈 문자열이 되면
// 거부한다. 같은 이유로 "foo//bar"(중간 빈 세그먼트)와 CON/NUL/COM1/LPT1류 Windows 예약
// 장치 이름(확장자가 붙어도 장치 자체를 가리킴)도 이 시점에 함께 차단한다 — 파생 규칙을
// 여러 곳에 늘리지 않고 이 하나의 canonical validator에 전부 모은다.
//
// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 2차 재검증, HIGH) — 콜론을 "드라이브
// 문자 뒤"(문자열 시작 위치)에서만 거부해 "NUL:stream/"·"foo/bar:stream/"·"C:relative"
// (경로 중간)류 Windows NTFS Alternate Data Stream/device 참조가 통과했다(예전
// RELATIVE_DIR_PREFIX_RE([^:]*)는 위치와 무관하게 콜론 자체를 거부했었다 — 이 부분에서는
// 보안 회귀였다). project-relative 경로 표기에 콜론이 필요한 정상 사례가 없으므로 위치와
// 무관하게 값 전체에서 콜론을 금지한다(드라이브 문자 검사를 대체 — 중복 규칙 없음).
// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 3차 재검증, HIGH) — ASCII COM1-9/LPT1-9
// 외에 Win32가 동일하게 예약 장치로 인식하는 위첨자 숫자 변형(COM¹/COM²/COM³/LPT¹/LPT²/LPT³,
// U+00B9/U+00B2/U+00B3)과 콘솔 별칭 CONIN$/CONOUT$도 함께 차단한다.
// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 5차 재검증, MEDIUM) — 역사적으로 예약된
// 시스템 시계 장치 이름 CLOCK$도 함께 차단한다.
const WINDOWS_RESERVED_DEVICE_NAME_RE = /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(\.[^/]*)?$/i;
const CONTROL_CHAR_RE = /[\x00-\x1f]/;
// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 4차 재검증, MEDIUM) — traversal 우회는
// 아니지만 "<>\"|?*"는 Win32에서 파일/디렉터리 이름에 아예 쓸 수 없는 문자다(CreateFile 계열이
// 즉시 실패한다) — 검증은 통과했지만 실제로는 Windows에서 절대 만들 수 없는 cwd/prefix가
// 되어 이후 실행 시점에 예측 못한 실패를 유발할 수 있다. project-relative 표기에 이런 문자가
// 필요한 정상 사례가 없으므로 함께 거부한다.
const WINDOWS_FORBIDDEN_CHAR_RE = /[<>"|?*]/;

function isSafeProjectRelativePath(value: unknown, opts: { requireTrailingSlash: boolean }): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.includes("\\")) return false;
  if (value.startsWith("/")) return false; // 절대경로 + POSIX-style UNC("//server/share")
  if (value.includes(":")) return false; // 드라이브 문자 경로 + Windows ADS/device 참조("NUL:stream" 등), 위치 무관 전부 차단
  if (WINDOWS_FORBIDDEN_CHAR_RE.test(value)) return false;
  if (opts.requireTrailingSlash && !value.endsWith("/")) return false;
  if (CONTROL_CHAR_RE.test(value)) return false;

  const rawSegments = value.split("/");
  const hasTrailingSlash = value.endsWith("/");
  const contentSegments = hasTrailingSlash ? rawSegments.slice(0, -1) : rawSegments;
  if (contentSegments.length === 0) return false; // 빈 값/"/"류 root-like 값
  for (const seg of contentSegments) {
    if (seg.length === 0) return false; // 내부 빈 세그먼트("foo//bar") — 연속 "/" 거부
    if (seg === "." || seg === "..") return false;
    const trimmedTrailingDotsSpaces = seg.replace(/[ .]+$/, "");
    if (
      trimmedTrailingDotsSpaces !== seg ||
      trimmedTrailingDotsSpaces.length === 0 ||
      trimmedTrailingDotsSpaces === "." ||
      trimmedTrailingDotsSpaces === ".."
    ) {
      return false;
    }
    if (WINDOWS_RESERVED_DEVICE_NAME_RE.test(seg)) return false;
  }
  return true;
}

function isSafeScopePrefix(value: unknown): value is string {
  // Planner scope는 디렉터리 prefix(`src/`) 또는 exact root/file path(`package.json`)를 허용한다.
  // Safe Executor도 동일하게 trailing slash 여부로 prefix/exact 의미를 구분한다.
  return isSafeProjectRelativePath(value, { requireTrailingSlash: false });
}

function isSafeCommandCwdAliasValue(value: unknown): value is string {
  return isSafeProjectRelativePath(value, { requireTrailingSlash: false });
}

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
// SI-3.3~3.5 4-chunk 최종 리뷰 지적(MEDIUM) — Number.isInteger()는 JSON의 unsafe integer
// (2^53-1을 넘는 값)도 통과시킨다 — 그런 값은 JSON.parse 시점에 이미 정밀도가 손실되어
// 있을 수 있어(JS Number가 배정밀도 부동소수점이라 안전하게 표현 가능한 정수 범위 밖),
// 이후 정렬/중복 판정이 오판될 수 있다. sequence 번호가 그 정도로 클 정당한 이유가 없으므로
// Number.isSafeInteger()로 교체한다 — 기존의 모든 정상 사용(1..수십 단위)에는 영향이 없다.
function isPositiveInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
}
function isPositiveIntegerArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every(isPositiveInteger);
}

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
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(id, 1);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue;
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
// A. Transport Normalization — SI-3.1과 동일, 변경 없음. 모든 stage validator가 공유한다.
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

/** secret 패턴은 구조 파싱보다 먼저 원문 그대로 검사한다 — JSON 파싱 실패로 조기 반환해도
 *  secret-shaped 텍스트가 rawText 안에 있었다는 사실 자체는 놓치지 않는다. 세 stage
 *  validator가 모두 동일한 순서로 이 검사를 먼저 실행한다(로직 복제 없음). */
function scanRawTextForSecrets(rawText: string, label: string): PlannerValidationIssue[] {
  const findings = scanContentForSecrets(rawText, label);
  if (findings.length === 0) return [];
  return [
    {
      code: "SECRET_SHAPED_OUTPUT",
      detail: `Planner 출력에서 secret으로 의심되는 패턴이 발견됐습니다(${findings.length}건). 원문은 기록하지 않습니다.`,
    },
  ];
}

// ---------------------------------------------------------------------------
// B. 엄격한 key/type 스키마 헬퍼 — 모든 stage validator가 공유한다.
// ---------------------------------------------------------------------------
const TECH_CHOICE_KEYS = ["area", "decision", "reason", "source", "status"] as const;
const ACK_KEYS = ["id", "value"] as const;
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

function validateRequiredTestsArray(container: string, value: unknown, issues: PlannerValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push({ code: "INVALID_STRUCTURE", detail: `${container}가 배열이 아닙니다.` });
    return;
  }
  value.forEach((rt, idx) => {
    if (!structuralGuard(rt)) {
      issues.push({ code: "INVALID_STRUCTURE", detail: `${container}[${idx}]가 객체가 아닙니다.` });
      return;
    }
    checkExactKeys(`${container}[${idx}]`, rt, REQUIRED_TEST_KEYS, issues);
    checkRequiredString(`${container}[${idx}]`, rt, "name", issues);
    checkRequiredString(`${container}[${idx}]`, rt, "command", issues);
    checkRequiredString(`${container}[${idx}]`, rt, "cwd", issues);
    checkRequiredStringArray(`${container}[${idx}]`, rt, "args", issues);
  });
}

function validateExecutionPolicyBlock(raw: Record<string, unknown>, issues: PlannerValidationIssue[]): void {
  if (!structuralGuard(raw.executionPolicy)) {
    issues.push({ code: "INVALID_STRUCTURE", detail: "executionPolicy가 객체가 아닙니다." });
    return;
  }
  const epObj = raw.executionPolicy as Record<string, unknown>;
  checkExactKeys("executionPolicy", epObj, EXECUTION_POLICY_KEYS, issues);
  if (epObj.commandCwdAliases !== undefined) {
    const aliases = epObj.commandCwdAliases;
    if (!structuralGuard(aliases) || Array.isArray(aliases)) {
      issues.push({ code: "INVALID_STRUCTURE", detail: "executionPolicy.commandCwdAliases가 문자열 값을 가진 객체가 아닙니다." });
    } else {
      // GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차, HIGH) — 이전에는 alias 값이
      // "문자열이기만 하면" 통과했다(경로 안전성 검사 전무). isSafeCommandCwdAliasValue()로
      // allowedReadPrefixes/allowedWritePrefixes와 동일한 canonical validator를 재사용해
      // absolute/drive/UNC/traversal 값을 여기서도 거부한다.
      for (const [alias, aliasValue] of Object.entries(aliases)) {
        if (typeof aliasValue !== "string") {
          issues.push({ code: "INVALID_STRUCTURE", detail: `executionPolicy.commandCwdAliases["${safeEchoValue(alias)}"]가 문자열이 아닙니다.` });
        } else if (!isSafeCommandCwdAliasValue(aliasValue)) {
          issues.push({
            code: "UNSAFE_EXECUTION_POLICY",
            detail: `executionPolicy.commandCwdAliases["${safeEchoValue(alias)}"]가 안전한 project-relative 상대경로 형식이 아닙니다: ${safeEchoValue(aliasValue)}`,
          });
        }
      }
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
    return;
  }
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
    // command가 경로 구분자/드라이브 문자를 포함하면(=bare 실행 파일명이 아니면) 최소 권한
    // 위반으로 거부한다. 실제 실행 시점의 최종 강제는 safe-executor.ts의 Core Command
    // Safety Gate(coreCommandSafetyGate)다 — 이 검사가 유일한 방어선은 아니다.
    // GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 재검증, HIGH) — 콜론(드라이브/ADS)과
    // Windows 후행 점/공백 정규화 우회를 command에도 동일하게 적용한다("git.exe." 같은 이름은
    // Win32에서 "git.exe"로 취급된다) — isSafeProjectRelativePath와 같은 원칙을 재사용한다.
    if (/[\\/]/.test(c.command) || c.command.includes(":") || WINDOWS_FORBIDDEN_CHAR_RE.test(c.command)) {
      issues.push({
        code: "UNSAFE_EXECUTION_POLICY",
        detail: `executionPolicy.allowedCommands의 command는 경로가 아닌 실행 파일 이름이어야 합니다: ${safeEchoValue(c.command)}`,
      });
      return;
    }
    const trimmedTrailingDotsSpaces = c.command.replace(/[ .]+$/, "");
    if (trimmedTrailingDotsSpaces.length === 0 || trimmedTrailingDotsSpaces !== c.command) {
      issues.push({
        code: "UNSAFE_EXECUTION_POLICY",
        detail: `executionPolicy.allowedCommands의 command에 Windows에서 조용히 제거되는 후행 점/공백이 있습니다: ${safeEchoValue(c.command)}`,
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

function validateTechnologyChoicesArray(raw: Record<string, unknown>, issues: PlannerValidationIssue[]): void {
  if (!Array.isArray(raw.technologyChoices)) {
    issues.push({ code: "INVALID_STRUCTURE", detail: "technologyChoices가 배열이 아닙니다." });
    return;
  }
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

function validateFixedConstraintAcknowledgement(
  raw: Record<string, unknown>,
  normalized: NormalizedMasterSpec,
  issues: PlannerValidationIssue[]
): void {
  const ackRaw = Array.isArray(raw.fixedConstraintAcknowledgement) ? (raw.fixedConstraintAcknowledgement as unknown[]) : [];
  const ackById = new Map<string, string>();
  const knownFixedConstraintIds = new Set(normalized.fixedConstraints.map((fc) => fc.id));
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
    // GPT Independent Reviewer 지적(SI-3.3 REVISE 2회차, 부가) — 중복 id나 Master Spec에 없는
    // id의 ack 항목을 조용히 허용/무시하지 않는다("strict, no silent coercion" 원칙을 이
    // 배열에도 동일하게 적용).
    if (ackById.has(a.id)) {
      issues.push({ code: "INVALID_STRUCTURE", detail: `fixedConstraintAcknowledgement에 id가 중복됩니다: ${safeEchoValue(a.id, ID_FAMILY_SHAPE)}` });
      return;
    }
    if (!knownFixedConstraintIds.has(a.id)) {
      issues.push({ code: "INVALID_STRUCTURE", detail: `fixedConstraintAcknowledgement가 존재하지 않는 fixed constraint id를 참조합니다: ${safeEchoValue(a.id, ID_FAMILY_SHAPE)}` });
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
}

// ---------------------------------------------------------------------------
// STAGE 1 — ARCHITECTURE. Master Spec(WHAT) → 프로젝트 요약/기술 선택/모듈/통합/경계/
// executionPolicy만 생성한다. Phase/Task는 여기서 만들지 않는다.
// ---------------------------------------------------------------------------

export interface ArchitectureRawOutput {
  projectId: string;
  specVersion: string;
  architectureSummary: string;
  technologyChoices: PlannerRawTechnologyChoice[];
  modulesOrComponents: string[];
  integrations: string[];
  architecturalBoundaries: string[];
  dependencyRelationships: string[];
  majorConstraints: string[];
  securityRequirementsSummary: string[];
  testingRequirementsSummary: string[];
  deliveryConstraintsSummary: string[];
  fixedConstraintAcknowledgement: PlannerRawFixedConstraintAck[];
  executionPolicy: PlannerRawExecutionPolicy;
}

const ARCHITECTURE_TOP_LEVEL_KEYS = [
  "projectId",
  "specVersion",
  "architectureSummary",
  "technologyChoices",
  "modulesOrComponents",
  "integrations",
  "architecturalBoundaries",
  "dependencyRelationships",
  "majorConstraints",
  "securityRequirementsSummary",
  "testingRequirementsSummary",
  "deliveryConstraintsSummary",
  "fixedConstraintAcknowledgement",
  "executionPolicy",
] as const;

export function validateArchitectureRawOutput(
  rawText: string,
  normalized: NormalizedMasterSpec,
  trusted: { projectId: string; specVersion: string }
): { ok: true; value: ArchitectureRawOutput } | { ok: false; issues: PlannerValidationIssue[] } {
  const issues: PlannerValidationIssue[] = scanRawTextForSecrets(rawText, "<planner-architecture-output>");

  const extraction = extractJsonPayload(rawText);
  if (!extraction.ok) {
    issues.push({ code: "MALFORMED_JSON", detail: `Architecture 출력에서 신뢰할 수 있는 단일 JSON을 찾지 못했습니다: ${extraction.reason}` });
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
    issues.push({ code: "INVALID_STRUCTURE", detail: "Architecture 출력이 객체가 아닙니다." });
    return { ok: false, issues };
  }
  const raw = parsed as Record<string, unknown>;

  checkExactKeys("Architecture 출력", raw, ARCHITECTURE_TOP_LEVEL_KEYS, issues);
  checkRequiredStringArray("Architecture 출력", raw, "modulesOrComponents", issues);
  checkRequiredStringArray("Architecture 출력", raw, "integrations", issues);
  checkRequiredStringArray("Architecture 출력", raw, "architecturalBoundaries", issues);
  checkRequiredStringArray("Architecture 출력", raw, "dependencyRelationships", issues);
  checkRequiredStringArray("Architecture 출력", raw, "majorConstraints", issues);
  checkRequiredStringArray("Architecture 출력", raw, "securityRequirementsSummary", issues);
  checkRequiredStringArray("Architecture 출력", raw, "testingRequirementsSummary", issues);
  checkRequiredStringArray("Architecture 출력", raw, "deliveryConstraintsSummary", issues);

  if (raw.projectId !== trusted.projectId) issues.push({ code: "PROJECT_ID_MISMATCH", detail: "Architecture 출력의 projectId가 신뢰된 identity와 일치하지 않습니다." });
  if (raw.specVersion !== trusted.specVersion) issues.push({ code: "SPEC_VERSION_MISMATCH", detail: "Architecture 출력의 specVersion이 신뢰된 identity와 일치하지 않습니다." });
  if (!isNonEmptyString(raw.architectureSummary)) issues.push({ code: "INVALID_STRUCTURE", detail: "architectureSummary가 비어있습니다." });

  validateTechnologyChoicesArray(raw, issues);

  if (!Array.isArray(raw.fixedConstraintAcknowledgement)) {
    issues.push({ code: "INVALID_STRUCTURE", detail: "fixedConstraintAcknowledgement가 배열이 아닙니다." });
  }
  validateFixedConstraintAcknowledgement(raw, normalized, issues);
  validateExecutionPolicyBlock(raw, issues);

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: raw as unknown as ArchitectureRawOutput };
}

// GPT Independent Reviewer 지적(SI-3.3 REVISE 1회차, HIGH) — checkpoint(planner-state.json)에
// 저장된 architecture는 validateArchitectureRawOutput()을 통과한 시점에만 저장되지만, 그
// 이후에는(다음 실행에서 resume할 때) 오직 shape만 재확인될 뿐(§ isValidArchitectureShape)
// 내용까지 다시 검증되지 않았다 — planner-state.json은 로컬 파일이라 프로세스 사이에 직접
// 변조/손상될 수 있고, shape을 그대로 유지한 채로도 fixedConstraintAcknowledgement를
// 다르게 바꾸거나 secret-shaped 값을 넣거나 executionPolicy를 위험하게 바꿀 수 있다. 매번
// architecture를 실제로 소비하기 직전(§ runPlannerLocked의 ARCHITECTURE_PLANNED/
// TRACEABILITY_VALIDATED 두 지점)에 이 함수로 다시 검증한다 — validateArchitectureRawOutput()이
// 이미 쓰는 헬퍼(validateFixedConstraintAcknowledgement/validateExecutionPolicyBlock/
// scanRawTextForSecrets)를 그대로 재사용해 로직을 복제하지 않는다. exact-key/타입 재검증은
// 하지 않는다(§ isValidArchitectureShape가 이미 타입 레벨로 shape를 강제하고, 저장된 값의
// 알려진 필드만 실제로 읽어 쓰므로 추가 unknown key가 있어도 동작에 영향이 없다) — 여기서는
// "내용이 안전/일치하는가"라는, shape 검사로는 잡을 수 없는 부분만 담당한다.
// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 재검증, HIGH) — 이전에는 trusted identity를
// 인자로 받지 않아 checkpoint의 architecture.projectId/specVersion 자체가 변조돼도(exact-key/
// shape/content 검사는 이 두 필드의 "존재/타입"만 볼 뿐 "신뢰된 값과 일치하는가"는 보지
// 않았다) 잡히지 않았다 — validateArchitectureRawOutput()(라이브 경로)은 이미 이 비교를
// 하므로 동일한 필드를 여기서도 재확인한다(로직 복제 없음, 단순 동등 비교).
function validateResumedArchitecture(
  architecture: ArchitectureRawOutput,
  normalized: NormalizedMasterSpec,
  trusted: { projectId: string; specVersion: string }
): PlannerValidationIssue[] {
  const issues: PlannerValidationIssue[] = scanRawTextForSecrets(JSON.stringify(architecture), "<planner-architecture-checkpoint>");
  const raw = architecture as unknown as Record<string, unknown>;
  checkExactKeys("architecture(checkpoint)", raw, ARCHITECTURE_TOP_LEVEL_KEYS, issues);
  if (raw.projectId !== trusted.projectId) issues.push({ code: "PROJECT_ID_MISMATCH", detail: "architecture checkpoint의 projectId가 신뢰된 identity와 일치하지 않습니다." });
  if (raw.specVersion !== trusted.specVersion) issues.push({ code: "SPEC_VERSION_MISMATCH", detail: "architecture checkpoint의 specVersion이 신뢰된 identity와 일치하지 않습니다." });
  validateTechnologyChoicesArray(raw, issues);
  validateFixedConstraintAcknowledgement(raw, normalized, issues);
  validateExecutionPolicyBlock(raw, issues);
  return issues;
}

export function buildArchitecturePrompt(normalized: NormalizedMasterSpec, trusted: { projectId: string; specVersion: string }): string {
  const reqLines = normalized.requirements.map((r) => `- ${r.id} [${r.category}${r.mustHave ? ", must-have" : ""}]: ${r.text}`).join("\n") || "(없음)";
  const fcLines = normalized.fixedConstraints.map((f) => `- ${f.id} [${f.kind}]: ${f.text}`).join("\n") || "(없음)";
  const deferredLines = normalized.deferredItems.map((d) => `- ${d.id}: ${d.text}`).join("\n") || "(없음)";
  const oosLines = normalized.outOfScope.map((o) => `- ${o.id}: ${o.text}`).join("\n") || "(없음)";

  return [
    `당신은 AutoDev Planner입니다 — 이번 호출은 STAGE 1(ARCHITECTURE)만 담당합니다. Phase/Task는 만들지 마세요(다음 단계에서 별도로 생성됩니다).`,
    `projectId=${trusted.projectId}, specVersion=${trusted.specVersion}`,
    `# Project Goal\n${normalized.projectGoal || "(명시되지 않음)"}`,
    `# Product Scope\n${normalized.productScope || "(명시되지 않음)"}`,
    `# Requirements(참고용 — 이 단계에서 task로 분해하지 않습니다)\n${reqLines}`,
    `# Fixed Constraints(절대 변경 불가 — 반드시 원문 그대로 fixedConstraintAcknowledgement로 확인)\n${fcLines}`,
    `# Deferred Items(구현 대상 아님)\n${deferredLines}`,
    `# Out-of-scope(구현 대상 아님)\n${oosLines}`,
    [
      "# Output — 반드시 아래 JSON 구조만 반환(다른 텍스트 금지):",
      '{ "projectId": string, "specVersion": string, "architectureSummary": string,',
      '  "technologyChoices": [{"area":string,"decision":string,"reason":string,"source":string,"status":"proposed"|"confirmed"}],',
      '  "modulesOrComponents": string[], "integrations": string[],',
      '  "architecturalBoundaries": string[], "dependencyRelationships": string[], "majorConstraints": string[],',
      '  "securityRequirementsSummary": string[], "testingRequirementsSummary": string[], "deliveryConstraintsSummary": string[],',
      '  "fixedConstraintAcknowledgement": [{"id":string,"value":string}] (모든 Fixed Constraint id를 원문 그대로 echo),',
      '  "executionPolicy": {"allowedReadPrefixes":["dir/","exact-file"],"allowedWritePrefixes":["dir/","exact-file"],"allowedCommands":[{"cwd":"root","command":string,"args":string[]}],',
      '    "commandCwdAliases": {"alias-name": "project-relative-dir"} (선택 — cwd로 "root"가 아닌 하위 디렉터리가 필요할 때만 추가, 불필요하면 이 key 자체를 생략)} }',
    ].join("\n"),
    [
      "# Security Constraints",
      '- executionPolicy에 "./"(프로젝트 전체) 접근이나 git/rm 등 위험한 명령, 배포 명령을 포함하지 마세요.',
      "- secret/API key/token/password로 보이는 어떤 값도 출력에 포함하지 마세요.",
      "- phases/tasks key를 만들지 마세요 — 이 단계의 스키마에는 없는 key입니다.",
    ].join("\n"),
  ].join("\n\n");
}

function appendCorrectionSuffix(base: string, issues: PlannerValidationIssue[]): string {
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

export function buildArchitectureCorrectionPrompt(
  normalized: NormalizedMasterSpec,
  trusted: { projectId: string; specVersion: string },
  issues: PlannerValidationIssue[]
): string {
  return appendCorrectionSuffix(buildArchitecturePrompt(normalized, trusted), issues);
}

// ---------------------------------------------------------------------------
// STAGE 2 — PHASE PLAN. Master Spec + 검증된 Architecture → Phase 목록만 생성한다(세부
// Task는 STAGE 3에서 Phase별로 생성한다). Phase id는 LLM이 만들지 않는다 — LLM은 이 응답
// 안에서만 고유한 sequence(1..)로 순서/의존성을 표현하고, Core가 sequence 오름차순으로
// "1","2",...를 deterministic 부여한다(§ 요구사항 6 "Phase ID는 가능하면 Core에서
// deterministic하게 부여한다").
// ---------------------------------------------------------------------------

/** 최종 확정된(Core가 phaseId를 부여한) Phase — STAGE 3 프롬프트 구성을 위해 reqIds/acIds도
 *  함께 보존한다(원본 PlannerPhase에는 없던 필드 — 조립 결과물에는 필요 없어 최종
 *  legacy raw 변환 시 drop된다). */
export interface PlannerPhase {
  phaseId: string;
  name: string;
  objective: string;
  dependencies: string[];
  completionCriteria: string[];
}
export interface ValidatedPlannerPhase extends PlannerPhase {
  reqIds: string[];
  acIds: string[];
}

const PHASE_PLAN_TOP_LEVEL_KEYS = ["projectId", "specVersion", "phases"] as const;
const PHASE_PLAN_ITEM_KEYS = ["sequence", "name", "objective", "dependsOnSequence", "reqIds", "acIds", "completionCriteria"] as const;
// 검증을 통과해 Core가 phaseId를 부여한 뒤(§ ValidatedPlannerPhase)의 key 집합 — LLM이 만드는
// wire 형식(PHASE_PLAN_ITEM_KEYS, sequence/dependsOnSequence 기반)과는 다르다. 오직
// validateResumedPhasePlanAndKnownTasks()가 checkpoint 재검증(§ 요구사항 MEDIUM1)에만 쓴다.
const VALIDATED_PHASE_KEYS = ["phaseId", "name", "objective", "dependencies", "completionCriteria", "reqIds", "acIds"] as const;

export function validatePhasePlanRawOutput(
  rawText: string,
  normalized: NormalizedMasterSpec,
  trusted: { projectId: string; specVersion: string }
): { ok: true; value: ValidatedPlannerPhase[] } | { ok: false; issues: PlannerValidationIssue[] } {
  const issues: PlannerValidationIssue[] = scanRawTextForSecrets(rawText, "<planner-phase-plan-output>");

  const extraction = extractJsonPayload(rawText);
  if (!extraction.ok) {
    issues.push({ code: "MALFORMED_JSON", detail: `Phase Plan 출력에서 신뢰할 수 있는 단일 JSON을 찾지 못했습니다: ${extraction.reason}` });
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
    issues.push({ code: "INVALID_STRUCTURE", detail: "Phase Plan 출력이 객체가 아닙니다." });
    return { ok: false, issues };
  }
  const raw = parsed as Record<string, unknown>;
  checkExactKeys("Phase Plan 출력", raw, PHASE_PLAN_TOP_LEVEL_KEYS, issues);
  if (raw.projectId !== trusted.projectId) issues.push({ code: "PROJECT_ID_MISMATCH", detail: "Phase Plan 출력의 projectId가 신뢰된 identity와 일치하지 않습니다." });
  if (raw.specVersion !== trusted.specVersion) issues.push({ code: "SPEC_VERSION_MISMATCH", detail: "Phase Plan 출력의 specVersion이 신뢰된 identity와 일치하지 않습니다." });

  if (!Array.isArray(raw.phases) || raw.phases.length === 0) {
    issues.push({ code: "INVALID_STRUCTURE", detail: "phases가 배열이 아니거나 비어있습니다." });
    return { ok: false, issues };
  }
  // GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 재검증, HIGH) — phase 개수에 상한이
  // 없었다. Phase Plan의 phase 하나마다 STAGE 3에서 독립적인 LLM 호출(최대
  // PLANNER_MAX_RAW_OUTPUT_ATTEMPTS번 correction retry, 각 최대 PLANNER_RAW_OUTPUT_TIMEOUT_MS)이
  // 발생하므로, 신뢰할 수 없거나 오작동한 LLM이 수백~수천 개 phase를 반환하면 호출 횟수/
  // 비용/실행 시간이 무제한으로 증폭된다. Core가 소유하는 명시적 상한을 두고 초과 시
  // fail-closed한다(project policy로 확대할 수 없음 — 이 검증은 policy를 인자로 받지 않는다).
  if (raw.phases.length > PLANNER_MAX_PHASES) {
    issues.push({
      code: "TOO_MANY_PHASES",
      detail: `phases 개수(${raw.phases.length})가 상한(${PLANNER_MAX_PHASES})을 초과합니다 — phase마다 별도 LLM 호출이 발생해 비용/시간이 무제한 증폭될 수 있습니다.`,
    });
    return { ok: false, issues };
  }

  interface Item {
    sequence: number;
    name: string;
    objective: string;
    dependsOnSequence: number[];
    reqIds: string[];
    acIds: string[];
    completionCriteria: string[];
  }
  const validItems: Item[] = [];
  const seenSequences = new Set<number>();

  (raw.phases as unknown[]).forEach((pRaw, idx) => {
    if (!structuralGuard(pRaw)) {
      issues.push({ code: "INVALID_STRUCTURE", detail: `phases[${idx}]가 객체가 아닙니다.` });
      return;
    }
    const pObj = pRaw as Record<string, unknown>;
    checkExactKeys(`phases[${idx}]`, pObj, PHASE_PLAN_ITEM_KEYS, issues);
    checkRequiredString(`phases[${idx}]`, pObj, "name", issues);
    checkRequiredString(`phases[${idx}]`, pObj, "objective", issues);
    checkRequiredStringArray(`phases[${idx}]`, pObj, "reqIds", issues);
    checkRequiredStringArray(`phases[${idx}]`, pObj, "acIds", issues);
    checkRequiredStringArray(`phases[${idx}]`, pObj, "completionCriteria", issues);
    if (!isPositiveIntegerArray(pObj.dependsOnSequence)) {
      issues.push({ code: "INVALID_STRUCTURE", detail: `phases[${idx}].dependsOnSequence가 양의 정수 배열이 아닙니다.` });
    }
    if (!isPositiveInteger(pObj.sequence)) {
      issues.push({ code: "INVALID_STRUCTURE", detail: `phases[${idx}].sequence가 양의 정수가 아닙니다.` });
      return;
    }
    const sequence = pObj.sequence as number;
    if (seenSequences.has(sequence)) {
      issues.push({ code: "DUPLICATE_PHASE_ID", detail: `phases 안에서 sequence가 중복됩니다: ${sequence}` });
      return;
    }
    seenSequences.add(sequence);
    validItems.push({
      sequence,
      name: isNonEmptyString(pObj.name) ? pObj.name : "",
      objective: isNonEmptyString(pObj.objective) ? pObj.objective : "",
      dependsOnSequence: isPositiveIntegerArray(pObj.dependsOnSequence) ? pObj.dependsOnSequence : [],
      reqIds: isStringArray(pObj.reqIds) ? pObj.reqIds : [],
      acIds: isStringArray(pObj.acIds) ? pObj.acIds : [],
      completionCriteria: isStringArray(pObj.completionCriteria) ? pObj.completionCriteria : [],
    });
  });

  const seqSet = seenSequences;
  const seqEdges = new Map<number, number[]>();
  for (const item of validItems) seqEdges.set(item.sequence, item.dependsOnSequence);
  for (const item of validItems) {
    for (const dep of item.dependsOnSequence) {
      if (!seqSet.has(dep)) {
        issues.push({ code: "MISSING_DEPENDENCY", detail: `phase(sequence=${item.sequence})가 존재하지 않는 sequence(${dep})에 의존합니다.` });
      } else if (dep >= item.sequence) {
        // GPT Independent Reviewer 지적(SI-3.3 REVISE 1회차, MEDIUM) — Core는 phaseId를
        // sequence 오름차순으로 부여하고, STAGE 3(TASK PLAN)도 그 phaseId 오름차순으로만
        // 처리한다(§ runPlannerLocked PHASE_PLANNED 블록). dependsOnSequence가 자기보다 크거나
        // 같은(=아직 처리되지 않을) sequence를 가리키면 hasCycle() 통과 여부와 무관하게 STAGE
        // 3에서 그 "선행" phase의 task id를 실제로는 알 수 없다 — phase 순서와 실행 순서가
        // 어긋나는 것을 여기서 즉시 거부한다(LLM에게는 "dependsOnSequence는 항상 더 작은
        // sequence만 참조" 규칙을 프롬프트로 안내한다).
        issues.push({
          code: "PHASE_DEPENDENCY_ORDER_VIOLATION",
          detail: `phase(sequence=${item.sequence})가 자신보다 늦거나 같은 sequence(${dep})에 의존합니다 — dependsOnSequence는 항상 더 작은 sequence만 참조해야 합니다.`,
        });
      }
    }
  }
  if (hasCycle([...seqSet].map(String), new Map([...seqEdges].map(([k, v]) => [String(k), v.map(String)])))) {
    issues.push({ code: "DEPENDENCY_CYCLE", detail: "phase 의존성 그래프에 사이클이 있습니다." });
  }

  const deferredIds = new Set(normalized.deferredItems.map((d) => d.id));
  const outOfScopeIds = new Set(normalized.outOfScope.map((o) => o.id));
  const requirementIds = new Set(normalized.requirements.map((r) => r.id));
  const acIdSet = new Set(normalized.acceptanceCriteria.map((a) => a.id));
  const reqUnion = new Set<string>();
  const acUnion = new Set<string>();
  for (const item of validItems) {
    for (const r of item.reqIds) {
      if (deferredIds.has(r) || outOfScopeIds.has(r)) {
        issues.push({ code: "DEFERRED_OR_OUT_OF_SCOPE_REFERENCED", detail: `phase(sequence=${item.sequence})가 deferred/out-of-scope 항목(${safeEchoValue(r, ID_FAMILY_SHAPE)})을 참조합니다.` });
      } else if (!requirementIds.has(r)) {
        issues.push({ code: "UNKNOWN_REQUIREMENT_REFERENCE", detail: `phase(sequence=${item.sequence})가 존재하지 않는 requirement(${safeEchoValue(r, ID_FAMILY_SHAPE)})를 참조합니다.` });
      } else {
        reqUnion.add(r);
      }
    }
    for (const a of item.acIds) {
      if (deferredIds.has(a) || outOfScopeIds.has(a)) {
        issues.push({ code: "DEFERRED_OR_OUT_OF_SCOPE_REFERENCED", detail: `phase(sequence=${item.sequence})가 deferred/out-of-scope 항목(${safeEchoValue(a, ID_FAMILY_SHAPE)})을 Acceptance Criteria로 참조합니다.` });
      } else if (!acIdSet.has(a)) {
        issues.push({ code: "UNKNOWN_REQUIREMENT_REFERENCE", detail: `phase(sequence=${item.sequence})가 존재하지 않는 Acceptance Criteria(${safeEchoValue(a, ID_FAMILY_SHAPE)})를 참조합니다.` });
      } else {
        acUnion.add(a);
      }
    }
  }
  // 조기 fail-fast — Master Spec의 모든 NOW requirement는 어떤 phase엔가 배정돼야 한다.
  // Must-have만 강제하면 functional/security/data 같은 일반 requirement가 조용히 누락될 수 있다.
  for (const req of normalized.requirements) {
    if (!reqUnion.has(req.id)) {
      issues.push({ code: "MISSING_REQUIREMENT_COVERAGE", detail: `Requirement(${req.id})가 어떤 phase에도 배정되지 않았습니다.` });
    }
  }
  for (const ac of normalized.acceptanceCriteria) {
    if (!acUnion.has(ac.id)) {
      issues.push({ code: "MISSING_ACCEPTANCE_CRITERIA_COVERAGE", detail: `Acceptance Criteria(${ac.id})가 어떤 phase에도 배정되지 않았습니다.` });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const sorted = [...validItems].sort((a, b) => a.sequence - b.sequence);
  const seqToPhaseId = new Map<number, string>();
  sorted.forEach((item, i) => seqToPhaseId.set(item.sequence, String(i + 1)));
  const value: ValidatedPlannerPhase[] = sorted.map((item) => ({
    phaseId: seqToPhaseId.get(item.sequence)!,
    name: item.name,
    objective: item.objective,
    dependencies: item.dependsOnSequence.map((s) => seqToPhaseId.get(s)!),
    completionCriteria: item.completionCriteria,
    reqIds: item.reqIds,
    acIds: item.acIds,
  }));
  return { ok: true, value };
}

export function buildPhasePlanPrompt(
  normalized: NormalizedMasterSpec,
  trusted: { projectId: string; specVersion: string },
  architecture: ArchitectureRawOutput
): string {
  const reqLines = normalized.requirements.map((r) => `- ${r.id} [${r.category}${r.mustHave ? ", must-have" : ""}]: ${r.text}`).join("\n") || "(없음)";
  const acLines = normalized.acceptanceCriteria.map((a) => `- ${a.id}: ${a.text}`).join("\n") || "(없음)";
  const fcLines = normalized.fixedConstraints.map((f) => `- ${f.id} [${f.kind}]: ${f.text}`).join("\n") || "(없음)";

  return [
    `당신은 AutoDev Planner입니다 — 이번 호출은 STAGE 2(PHASE PLAN)만 담당합니다. 세부 Task는 만들지 마세요(다음 단계에서 Phase별로 별도 생성됩니다).`,
    `projectId=${trusted.projectId}, specVersion=${trusted.specVersion}`,
    `# Architecture Summary(이미 확정됨 — 참고만 할 것, 다시 만들지 마세요)\n${architecture.architectureSummary}`,
    `# Modules/Components\n${architecture.modulesOrComponents.join(", ") || "(없음)"}`,
    `# Requirements\n${reqLines}`,
    `# Acceptance Criteria\n${acLines}`,
    `# Fixed Constraints(참고 — 이미 STAGE 1에서 확인됨)\n${fcLines}`,
    [
      "# Output — 반드시 아래 JSON 구조만 반환(다른 텍스트 금지):",
      '{ "projectId": string, "specVersion": string,',
      '  "phases": [{"sequence": number(1부터 시작 — 이 응답 안에서만 고유하면 됨. 실제 phaseId는 Core가 부여합니다),',
      '    "name": string, "objective": string, "dependsOnSequence": number[](이 응답 안에서 자신보다 작은 sequence만 참조 — 나중 단계는 만들어지기 전이라 참조 불가),',
      '    "reqIds": string[], "acIds": string[], "completionCriteria": string[]}] }',
    ].join("\n"),
    [
      "# Rules",
      "- Phase 개수를 미리 정하지 마세요 — 실제로 필요한 만큼만 만드세요.",
      "- phases 배열을 의존성 순서(먼저 실행돼야 하는 phase가 먼저)로 나열하고, sequence도 그 순서대로(먼저 나오는 phase일수록 작은 sequence) 매기세요.",
      "- dependsOnSequence에는 반드시 자신보다 작은 sequence만 넣으세요 — 자신과 같거나 더 큰 sequence(아직 정의되지 않은 이후 phase)는 절대 참조할 수 없습니다.",
      "- 모든 Must-have requirement와 모든 Acceptance Criteria는 최소 하나의 phase(reqIds/acIds)에 포함돼야 합니다.",
      "- Deferred/Out-of-scope 항목을 참조하지 마세요.",
      "- phaseId를 직접 만들지 마세요 — sequence만 지정하면 Core가 phaseId를 부여합니다.",
    ].join("\n"),
  ].join("\n\n");
}

export function buildPhasePlanCorrectionPrompt(
  normalized: NormalizedMasterSpec,
  trusted: { projectId: string; specVersion: string },
  architecture: ArchitectureRawOutput,
  issues: PlannerValidationIssue[]
): string {
  return appendCorrectionSuffix(buildPhasePlanPrompt(normalized, trusted, architecture), issues);
}

// ---------------------------------------------------------------------------
// STAGE 3 — TASK PLAN(Phase별 개별 호출). 한 번에 하나의 Phase만 대상으로 한다 — 입력을
// 그 Phase에 배정된 REQ/AC + Fixed Constraints + Architecture 요약 + 이전 Phase 요약 +
// 이미 확정된 이전 Phase의 taskId 목록으로 최소화한다(전체 이전 raw output을 다시 넣지
// 않는다). taskId도 Core가 부여한다 — LLM은 이 응답 안에서만 고유한 sequence로 표현하고,
// 다른(이미 확정된) Phase의 task를 가리킬 때만 실제 taskId 문자열을 쓴다.
// ---------------------------------------------------------------------------

const PHASE_TASK_TOP_LEVEL_KEYS = ["projectId", "specVersion", "phaseId", "tasks"] as const;
const PHASE_TASK_ITEM_KEYS = [
  "sequence",
  "title",
  "objective",
  "scope",
  "constraints",
  "dependsOn",
  "dependsOnSequenceInPhase",
  "expectedModules",
  "requiredTests",
  "acceptanceCriteria",
  "reqIds",
  "securityConsiderations",
  "completionGate",
  "requiresHumanReview",
] as const;
// 검증을 통과해 Core가 taskId를 부여한 뒤(§ PlannerRawTask)의 key 집합 — LLM이 만드는 wire
// 형식(PHASE_TASK_ITEM_KEYS, sequence/dependsOnSequenceInPhase 기반)과는 다르다. 오직
// validateResumedPhasePlanAndKnownTasks()가 checkpoint 재검증에만 쓴다.
const PLANNER_RAW_TASK_KEYS = [
  "taskId",
  "phaseId",
  "title",
  "objective",
  "scope",
  "constraints",
  "dependsOn",
  "expectedModules",
  "requiredTests",
  "acceptanceCriteria",
  "reqIds",
  "securityConsiderations",
  "completionGate",
  "requiresHumanReview",
] as const;

export function validatePhaseTaskRawOutput(
  rawText: string,
  normalized: NormalizedMasterSpec,
  trusted: { projectId: string; specVersion: string },
  phase: ValidatedPlannerPhase,
  knownTaskIds: ReadonlySet<string>
): { ok: true; value: PlannerRawTask[] } | { ok: false; issues: PlannerValidationIssue[] } {
  const issues: PlannerValidationIssue[] = scanRawTextForSecrets(rawText, "<planner-task-plan-output>");

  const extraction = extractJsonPayload(rawText);
  if (!extraction.ok) {
    issues.push({ code: "MALFORMED_JSON", detail: `Task Plan 출력(phase ${phase.phaseId})에서 신뢰할 수 있는 단일 JSON을 찾지 못했습니다: ${extraction.reason}` });
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
    issues.push({ code: "INVALID_STRUCTURE", detail: "Task Plan 출력이 객체가 아닙니다." });
    return { ok: false, issues };
  }
  const raw = parsed as Record<string, unknown>;
  checkExactKeys("Task Plan 출력", raw, PHASE_TASK_TOP_LEVEL_KEYS, issues);
  if (raw.projectId !== trusted.projectId) issues.push({ code: "PROJECT_ID_MISMATCH", detail: "Task Plan 출력의 projectId가 신뢰된 identity와 일치하지 않습니다." });
  if (raw.specVersion !== trusted.specVersion) issues.push({ code: "SPEC_VERSION_MISMATCH", detail: "Task Plan 출력의 specVersion이 신뢰된 identity와 일치하지 않습니다." });
  if (raw.phaseId !== phase.phaseId) {
    issues.push({ code: "TASK_STAGE_PHASE_MISMATCH", detail: `Task Plan 출력의 phaseId가 요청된 phase(${phase.phaseId})와 일치하지 않습니다: ${safeEchoValue(raw.phaseId, PHASE_ID_ECHO_SHAPE)}` });
  }

  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    issues.push({ code: "INVALID_STRUCTURE", detail: "tasks가 배열이 아니거나 비어있습니다." });
    return { ok: false, issues };
  }
  // GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 재검증, HIGH) — phase당 task 개수에도
  // 동일한 이유(§ 위 phases 상한 주석)로 상한이 필요하다 — task 개수 자체가 LLM 호출을
  // 늘리지는 않지만, 다음 correction retry 프롬프트에 이 phase의 이미 확정된 task 목록이
  // 그대로 다시 포함되므로(§ buildPhaseTaskPrompt) 무한정 커지면 프롬프트 크기/비용이
  // 함께 증폭된다.
  if (raw.tasks.length > PLANNER_MAX_TASKS_PER_PHASE) {
    issues.push({
      code: "TOO_MANY_TASKS_IN_PHASE",
      detail: `phase ${phase.phaseId}의 tasks 개수(${raw.tasks.length})가 상한(${PLANNER_MAX_TASKS_PER_PHASE})을 초과합니다.`,
    });
    return { ok: false, issues };
  }

  interface Item {
    sequence: number;
    title: string;
    objective: string;
    scope: string[];
    constraints: string[];
    dependsOn: string[];
    dependsOnSequenceInPhase: number[];
    expectedModules: string[];
    requiredTests: RequiredTestCommand[];
    acceptanceCriteria: string[];
    reqIds: string[];
    securityConsiderations: string[];
    completionGate: string;
    requiresHumanReview: boolean;
  }
  const validItems: Item[] = [];
  const seenSequences = new Set<number>();

  (raw.tasks as unknown[]).forEach((tRaw, idx) => {
    if (!structuralGuard(tRaw)) {
      issues.push({ code: "INVALID_STRUCTURE", detail: `tasks[${idx}]가 객체가 아닙니다.` });
      return;
    }
    const tObj = tRaw as Record<string, unknown>;
    checkExactKeys(`tasks[${idx}]`, tObj, PHASE_TASK_ITEM_KEYS, issues);
    checkRequiredString(`tasks[${idx}]`, tObj, "title", issues);
    checkRequiredString(`tasks[${idx}]`, tObj, "objective", issues);
    checkRequiredString(`tasks[${idx}]`, tObj, "completionGate", issues);
    checkRequiredStringArray(`tasks[${idx}]`, tObj, "scope", issues);
    if (isStringArray(tObj.scope)) {
      for (const scope of tObj.scope) {
        if (!isSafeScopePrefix(scope)) {
          issues.push({
            code: "UNSAFE_TASK_SCOPE",
            detail: `tasks[${idx}].scope에 안전하지 않은 project-relative 범위가 있습니다: ${safeEchoValue(scope)}`,
          });
        }
      }
    }
    checkRequiredStringArray(`tasks[${idx}]`, tObj, "constraints", issues);
    checkRequiredStringArray(`tasks[${idx}]`, tObj, "dependsOn", issues);
    checkRequiredStringArray(`tasks[${idx}]`, tObj, "expectedModules", issues);
    checkRequiredStringArray(`tasks[${idx}]`, tObj, "acceptanceCriteria", issues);
    checkRequiredStringArray(`tasks[${idx}]`, tObj, "reqIds", issues);
    checkRequiredStringArray(`tasks[${idx}]`, tObj, "securityConsiderations", issues);
    if (!isPositiveIntegerArray(tObj.dependsOnSequenceInPhase)) {
      issues.push({ code: "INVALID_STRUCTURE", detail: `tasks[${idx}].dependsOnSequenceInPhase가 양의 정수 배열이 아닙니다.` });
    }
    validateRequiredTestsArray(`tasks[${idx}].requiredTests`, tObj.requiredTests, issues);
    if (!isPositiveInteger(tObj.sequence)) {
      issues.push({ code: "INVALID_STRUCTURE", detail: `tasks[${idx}].sequence가 양의 정수가 아닙니다.` });
      return;
    }
    const sequence = tObj.sequence as number;
    if (seenSequences.has(sequence)) {
      issues.push({ code: "DUPLICATE_TASK_ID", detail: `tasks 안에서 sequence가 중복됩니다: ${sequence}` });
      return;
    }
    seenSequences.add(sequence);
    validItems.push({
      sequence,
      title: isNonEmptyString(tObj.title) ? tObj.title : "",
      objective: isNonEmptyString(tObj.objective) ? tObj.objective : "",
      scope: isStringArray(tObj.scope) ? tObj.scope : [],
      constraints: isStringArray(tObj.constraints) ? tObj.constraints : [],
      dependsOn: isStringArray(tObj.dependsOn) ? tObj.dependsOn : [],
      dependsOnSequenceInPhase: isPositiveIntegerArray(tObj.dependsOnSequenceInPhase) ? tObj.dependsOnSequenceInPhase : [],
      expectedModules: isStringArray(tObj.expectedModules) ? tObj.expectedModules : [],
      requiredTests: Array.isArray(tObj.requiredTests) ? (tObj.requiredTests as RequiredTestCommand[]) : [],
      acceptanceCriteria: isStringArray(tObj.acceptanceCriteria) ? tObj.acceptanceCriteria : [],
      reqIds: isStringArray(tObj.reqIds) ? tObj.reqIds : [],
      securityConsiderations: isStringArray(tObj.securityConsiderations) ? tObj.securityConsiderations : [],
      completionGate: isNonEmptyString(tObj.completionGate) ? tObj.completionGate : "",
      // AutoDev Core Maintenance(2026-09-03) — 지정하지 않거나 boolean이 아니면 기존 동작과
      // 100% 동일한 false로 방어적 기본값 처리(§ 다른 필드와 동일한 관례).
      requiresHumanReview: typeof tObj.requiresHumanReview === "boolean" ? tObj.requiresHumanReview : false,
    });
  });

  const seqSet = seenSequences;
  const seqEdges = new Map<number, number[]>();
  for (const item of validItems) seqEdges.set(item.sequence, item.dependsOnSequenceInPhase);
  for (const item of validItems) {
    for (const dep of item.dependsOnSequenceInPhase) {
      if (!seqSet.has(dep)) {
        issues.push({ code: "MISSING_DEPENDENCY", detail: `task(phase ${phase.phaseId}, sequence=${item.sequence})가 같은 phase 내 존재하지 않는 sequence(${dep})에 의존합니다.` });
      }
    }
  }
  if (hasCycle([...seqSet].map(String), new Map([...seqEdges].map(([k, v]) => [String(k), v.map(String)])))) {
    issues.push({ code: "DEPENDENCY_CYCLE", detail: `phase ${phase.phaseId} 내 task 의존성 그래프에 사이클이 있습니다.` });
  }

  for (const item of validItems) {
    for (const dep of item.dependsOn) {
      if (!TASK_ID_RE.test(dep) || !knownTaskIds.has(dep)) {
        issues.push({
          code: "MISSING_DEPENDENCY",
          detail: `task(phase ${phase.phaseId}, sequence=${item.sequence})가 존재하지 않거나 아직 확정되지 않은 task(${safeEchoValue(dep, TASK_ID_ECHO_SHAPE)})에 의존합니다.`,
        });
      }
    }
  }

  const deferredIds = new Set(normalized.deferredItems.map((d) => d.id));
  const outOfScopeIds = new Set(normalized.outOfScope.map((o) => o.id));
  const requirementIds = new Set(normalized.requirements.map((r) => r.id));
  const acIdSet = new Set(normalized.acceptanceCriteria.map((a) => a.id));
  // GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차, HIGH) — 이전에는 "Master Spec 전체
  // 기준으로 존재하는 REQ/AC인가"만 확인했다. Phase Plan이 이미 각 Phase에 reqIds/acIds를
  // 배정했는데도(§ STAGE 2) 이 검증은 그 배정 범위를 전혀 쓰지 않아, 이 Phase의 Task가 다른
  // Phase에 배정된 REQ/AC를 claim해도(global union만 맞으면) 통과했다 — "Phase가 담당하지
  // 않는 REQ/AC를 Task가 claim하면 REJECT" 요구를 위반한다. 여기서 phase.reqIds/phase.acIds
  // 부분집합 여부를 추가로 확인한다(기존 전역 존재성 검사는 그대로 유지 — 두 검사는 서로
  // 다른 실패를 잡는다).
  const phaseReqIdSet = new Set(phase.reqIds);
  const phaseAcIdSet = new Set(phase.acIds);
  const reqCoverageInThisPhase = new Set<string>();
  const acCoverageInThisPhase = new Set<string>();
  for (const item of validItems) {
    for (const r of item.reqIds) {
      if (deferredIds.has(r) || outOfScopeIds.has(r)) {
        issues.push({ code: "DEFERRED_OR_OUT_OF_SCOPE_REFERENCED", detail: `task(phase ${phase.phaseId}, sequence=${item.sequence})가 deferred/out-of-scope 항목(${safeEchoValue(r, ID_FAMILY_SHAPE)})을 요구사항으로 참조합니다.` });
      } else if (!requirementIds.has(r)) {
        issues.push({ code: "UNKNOWN_REQUIREMENT_REFERENCE", detail: `task(phase ${phase.phaseId}, sequence=${item.sequence})가 존재하지 않는 requirement(${safeEchoValue(r, ID_FAMILY_SHAPE)})를 참조합니다.` });
      } else if (!phaseReqIdSet.has(r)) {
        issues.push({
          code: "REQUIREMENT_OUTSIDE_PHASE_SCOPE",
          detail: `task(phase ${phase.phaseId}, sequence=${item.sequence})가 이 phase에 배정되지 않은 requirement(${safeEchoValue(r, ID_FAMILY_SHAPE)})를 참조합니다 — 다른 phase의 REQ는 claim할 수 없습니다.`,
        });
      } else {
        reqCoverageInThisPhase.add(r);
      }
    }
    for (const a of item.acceptanceCriteria) {
      if (deferredIds.has(a) || outOfScopeIds.has(a)) {
        issues.push({ code: "DEFERRED_OR_OUT_OF_SCOPE_REFERENCED", detail: `task(phase ${phase.phaseId}, sequence=${item.sequence})가 deferred/out-of-scope 항목(${safeEchoValue(a, ID_FAMILY_SHAPE)})을 Acceptance Criteria로 참조합니다.` });
      } else if (!acIdSet.has(a)) {
        issues.push({ code: "UNKNOWN_REQUIREMENT_REFERENCE", detail: `task(phase ${phase.phaseId}, sequence=${item.sequence})가 존재하지 않는 Acceptance Criteria(${safeEchoValue(a, ID_FAMILY_SHAPE)})를 참조합니다.` });
      } else if (!phaseAcIdSet.has(a)) {
        issues.push({
          code: "ACCEPTANCE_CRITERIA_OUTSIDE_PHASE_SCOPE",
          detail: `task(phase ${phase.phaseId}, sequence=${item.sequence})가 이 phase에 배정되지 않은 Acceptance Criteria(${safeEchoValue(a, ID_FAMILY_SHAPE)})를 참조합니다 — 다른 phase의 AC는 claim할 수 없습니다.`,
        });
      } else {
        acCoverageInThisPhase.add(a);
      }
    }
  }
  // 이 Phase에 배정된 모든 requirement/AC는 실제 Task에 coverage되어야 한다.
  for (const reqId of phase.reqIds) {
    if (!reqCoverageInThisPhase.has(reqId)) {
      issues.push({ code: "MISSING_REQUIREMENT_COVERAGE", detail: `phase ${phase.phaseId}에 배정된 requirement(${reqId})가 이 phase의 어떤 task에도 매핑되지 않았습니다.` });
    }
  }
  for (const acId of phase.acIds) {
    if (!acCoverageInThisPhase.has(acId)) {
      issues.push({ code: "MISSING_ACCEPTANCE_CRITERIA_COVERAGE", detail: `phase ${phase.phaseId}에 배정된 Acceptance Criteria(${acId})가 이 phase의 어떤 task에도 매핑되지 않았습니다.` });
    }
  }

  if (issues.length > 0) return { ok: false, issues };

  const sorted = [...validItems].sort((a, b) => a.sequence - b.sequence);
  const seqToTaskId = new Map<number, string>();
  sorted.forEach((item, i) => seqToTaskId.set(item.sequence, `${phase.phaseId}.${i + 1}`));
  const value: PlannerRawTask[] = sorted.map((item) => ({
    taskId: seqToTaskId.get(item.sequence)!,
    phaseId: phase.phaseId,
    title: item.title,
    objective: item.objective,
    scope: item.scope,
    constraints: item.constraints,
    dependsOn: [...item.dependsOn, ...item.dependsOnSequenceInPhase.map((s) => seqToTaskId.get(s)!)],
    expectedModules: item.expectedModules,
    requiredTests: item.requiredTests,
    acceptanceCriteria: item.acceptanceCriteria,
    reqIds: item.reqIds,
    securityConsiderations: item.securityConsiderations,
    completionGate: item.completionGate,
    requiresHumanReview: item.requiresHumanReview,
  }));
  return { ok: true, value };
}

export function buildPhaseTaskPrompt(
  normalized: NormalizedMasterSpec,
  trusted: { projectId: string; specVersion: string },
  architecture: ArchitectureRawOutput,
  phase: ValidatedPlannerPhase,
  priorPhases: ValidatedPlannerPhase[],
  knownTasks: { taskId: string; title: string }[]
): string {
  const reqIdSet = new Set(phase.reqIds);
  const acIdSet = new Set(phase.acIds);
  const relevantReqs = normalized.requirements.filter((r) => reqIdSet.has(r.id));
  const relevantAcs = normalized.acceptanceCriteria.filter((a) => acIdSet.has(a.id));
  const reqLines = relevantReqs.map((r) => `- ${r.id} [${r.category}${r.mustHave ? ", must-have" : ""}]: ${r.text}`).join("\n") || "(이 phase에 명시적으로 배정된 requirement 없음)";
  const acLines = relevantAcs.map((a) => `- ${a.id}: ${a.text}`).join("\n") || "(이 phase에 명시적으로 배정된 Acceptance Criteria 없음)";
  const fcLines = normalized.fixedConstraints.map((f) => `- ${f.id} [${f.kind}]: ${f.text}`).join("\n") || "(없음)";
  const priorPhaseLines = priorPhases.map((p) => `- Phase ${p.phaseId} "${p.name}": ${p.objective}`).join("\n") || "(이전 phase 없음)";
  const knownTaskLines = knownTasks.map((t) => `- ${t.taskId}: ${t.title}`).join("\n") || "(이전에 확정된 task 없음)";

  return [
    `당신은 AutoDev Planner입니다 — 이번 호출은 STAGE 3(TASK PLAN) — phaseId=${phase.phaseId}만 담당하며, 오직 Phase ${phase.phaseId}("${phase.name}")의 task만 만듭니다. 다른 phase의 task는 만들지 마세요.`,
    `projectId=${trusted.projectId}, specVersion=${trusted.specVersion}`,
    `# Architecture Summary\n${architecture.architectureSummary}`,
    `# 이 Phase\nphaseId=${phase.phaseId}\nname=${phase.name}\nobjective=${phase.objective}\ncompletionCriteria=${phase.completionCriteria.join("; ") || "(없음)"}`,
    `# 이 Phase에 배정된 Requirements\n${reqLines}`,
    `# 이 Phase에 배정된 Acceptance Criteria\n${acLines}`,
    `# Fixed Constraints(절대 변경 불가)\n${fcLines}`,
    `# 이전 Phase 요약(참고용)\n${priorPhaseLines}`,
    `# 이미 확정된 이전 Phase의 task id(cross-phase dependsOn에 참조 가능)\n${knownTaskLines}`,
    [
      "# Output — 반드시 아래 JSON 구조만 반환(다른 텍스트 금지):",
      `{ "projectId": string, "specVersion": string, "phaseId": "${phase.phaseId}",`,
      '  "tasks": [{"sequence": number(1부터 시작 — 이 응답 안에서만 고유하면 됨. 실제 taskId는 Core가 부여합니다),',
      '    "title": string, "objective": string, "scope": ["dir/ 또는 exact/file"], "constraints": string[],',
      '    "dependsOn": string[](다른 phase의 이미 확정된 taskId만, 위 목록에서 선택), "dependsOnSequenceInPhase": number[](같은 응답 안의 다른 task의 sequence만),',
      '    "expectedModules": string[], "requiredTests": [{"name":string,"command":string,"args":string[],"cwd":"root"}],',
      '    "acceptanceCriteria": string[], "reqIds": string[], "securityConsiderations": string[], "completionGate": string,',
      '    "requiresHumanReview": boolean}] }',
    ].join("\n"),
    [
      "# Rules",
      "- 이 phase의 목표를 달성하는 데 필요한 task만 만드세요.",
      "- taskId를 직접 만들지 마세요 — sequence만 지정하면 Core가 taskId를 부여합니다.",
      "- Deferred/Out-of-scope 항목을 참조하지 마세요.",
      "- executionPolicy는 이미 STAGE 1에서 확정됐습니다 — 여기서 다시 만들지 마세요.",
      "- requiresHumanReview: required tests(자동화된 테스트)만으로는 완료 여부를 기계적으로 검증할 수 없어 사람이 diff를 직접 검토해야만 이 task를 완료로 인정할 수 있는 경우에만 true로 지정하세요(예: 자동 테스트로는 판단할 수 없는 보안/신뢰 경계 설계 판단이 필요한 task). completionGate에 '사람이 검토해야 한다'는 취지를 자유 텍스트로만 적지 마세요 — 이 boolean 필드로 명시하세요. required tests로 검증 가능한 일반 task는 생략하세요(기본값 false).",
    ].join("\n"),
  ].join("\n\n");
}

export function buildPhaseTaskCorrectionPrompt(
  normalized: NormalizedMasterSpec,
  trusted: { projectId: string; specVersion: string },
  architecture: ArchitectureRawOutput,
  phase: ValidatedPlannerPhase,
  priorPhases: ValidatedPlannerPhase[],
  knownTasks: { taskId: string; title: string }[],
  issues: PlannerValidationIssue[]
): string {
  return appendCorrectionSuffix(buildPhaseTaskPrompt(normalized, trusted, architecture, phase, priorPhases, knownTasks), issues);
}

// ---------------------------------------------------------------------------
// Raw Output Source — LLM 호출 seam. SI-3.1/SI-3.2와 동일, 변경 없음(claude-runner.ts의
// runClaudeTask를 그대로 감싼다, Planner 전용 timeout/transport retry 상수도 동일).
// ---------------------------------------------------------------------------

export type PlannerRawOutputOutcome =
  | { ok: true; rawOutput: string }
  | { ok: false; reason: string; retryable?: boolean };
export type PlannerRawOutputSource = (prompt: string) => Promise<PlannerRawOutputOutcome>;

export interface ClaudeCliRawOutputSourceOptions {
  timeoutMs?: number;
  /** SI-3.6 bounded review(chunk1 HIGH) 지적 반영 — 이 Planner 호출이 다루는 target project
   *  root(들)을 넘기면 claude-runner.ts의 Trusted Executable Resolution이 그 경로 안의 가짜
   *  claude 실행 파일도 PATH 탐색에서 배제한다. */
  excludedRoots?: string[];
}

export const PLANNER_RAW_OUTPUT_TIMEOUT_MS = 300_000;
export const PLANNER_MAX_TRANSPORT_RETRIES = 1;

export function createClaudeCliRawOutputSource(opts: ClaudeCliRawOutputSourceOptions = {}): PlannerRawOutputSource {
  return async (prompt: string) => {
    const timeoutMs = opts.timeoutMs ?? PLANNER_RAW_OUTPUT_TIMEOUT_MS;
    const result = await runClaudeTask(prompt, 1, { timeoutMs, excludedRoots: opts.excludedRoots });
    if (!result.success) {
      return {
        ok: false,
        reason: `claude 호출 실패: ${result.errorCode ?? "UNKNOWN"} — ${result.summary}`,
        retryable: result.errorCode === "TIMEOUT",
      };
    }
    return { ok: true, rawOutput: result.summary };
  };
}

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

// SI-3와 동일 — LLM이 스스로 schema 위반을 고칠 기회를 주는 correction retry 상한. Phase별
// TASK PLAN 호출을 포함해 모든 LLM stage 호출이 이 상한을 독립적으로 각자 소비한다(§
// runLlmStage 아래 — "Phase별 Planner 호출은 retry budget이 독립적이어야 한다").
export const PLANNER_MAX_RAW_OUTPUT_ATTEMPTS = 3;

export interface PlannerDiagnosticEvent {
  stage: "ARCHITECTURE" | "PHASE_PLAN" | "TASK_PLAN";
  phaseId?: string;
  attempt: number;
  promptLength: number;
  elapsedMs: number;
  transportResult: "ok" | "failed";
  validationResult: "ok" | "rejected" | "not_attempted";
}

type LlmStageOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "transport_failed"; detail: string }
  | { kind: "rejected"; issues: PlannerValidationIssue[] };

/** 하나의 LLM stage(ARCHITECTURE/PHASE_PLAN/한 Phase의 TASK_PLAN) 호출 전체를 담당하는
 *  공용 루프 — transport bounded retry(§ invokeRawOutputSourceWithTransportRetry) +
 *  correction bounded retry(§ PLANNER_MAX_RAW_OUTPUT_ATTEMPTS)를 재사용한다. 매 호출마다
 *  독립적인 attempt 카운터를 새로 시작하므로, Phase별 TASK_PLAN 호출은 서로 retry 예산을
 *  공유하지 않는다(§ 요구사항 8) — 한 Phase의 실패가 다른 Phase의 남은 예산을 갉아먹지
 *  않는다. */
async function runLlmStage<T>(
  rawOutputSource: PlannerRawOutputSource,
  stage: PlannerDiagnosticEvent["stage"],
  phaseId: string | undefined,
  buildInitialPrompt: () => string,
  buildCorrectionPrompt: (issues: PlannerValidationIssue[]) => string,
  validate: (rawText: string) => { ok: true; value: T } | { ok: false; issues: PlannerValidationIssue[] },
  onDiagnostic?: (event: PlannerDiagnosticEvent) => void
): Promise<LlmStageOutcome<T>> {
  let lastIssues: PlannerValidationIssue[] = [];
  for (let attempt = 1; attempt <= PLANNER_MAX_RAW_OUTPUT_ATTEMPTS; attempt += 1) {
    const prompt = attempt === 1 ? buildInitialPrompt() : buildCorrectionPrompt(lastIssues);
    const startedAt = Date.now();
    const sourceResult = await invokeRawOutputSourceWithTransportRetry(rawOutputSource, prompt);
    const elapsedMs = Date.now() - startedAt;
    if (!sourceResult.ok) {
      onDiagnostic?.({ stage, phaseId, attempt, promptLength: prompt.length, elapsedMs, transportResult: "failed", validationResult: "not_attempted" });
      return { kind: "transport_failed", detail: sourceResult.reason };
    }
    const validation = validate(sourceResult.rawOutput);
    onDiagnostic?.({ stage, phaseId, attempt, promptLength: prompt.length, elapsedMs, transportResult: "ok", validationResult: validation.ok ? "ok" : "rejected" });
    if (validation.ok) return { kind: "ok", value: validation.value };
    lastIssues = validation.issues;
  }
  return { kind: "rejected", issues: lastIssues };
}

// ---------------------------------------------------------------------------
// STAGE 4 — GLOBAL TRACEABILITY. LLM이 아니라 Core가 deterministic하게 전체를 재검증한다.
// 각 stage validator가 이미 개별적으로 검사했지만, 여기서는 "모든 Phase의 모든 Task가 모인
// 뒤"에만 드러나는 전역 불변식(예: phase는 REQ를 배정했지만 그 phase의 어떤 task도 실제로
// 그 REQ를 claim하지 않은 경우)과, resume된 checkpoint 데이터의 변조/손상에 대한 방어를
// 담당한다.
// ---------------------------------------------------------------------------

// GPT Independent Reviewer 지적(SI-3.3 REVISE 2회차, HIGH) — 원래 하나의 함수였던 것을 세
// 조각으로 나눈다. 이유: coverage 완전성(모든 must-have REQ/AC가 매핑됐는가)은 "모든 Phase의
// 모든 Task가 이미 확정된 뒤"에만 유효하게 물을 수 있는 질문이다 — STAGE 3(TASK PLAN) 루프가
// 아직 일부 Phase만 처리한 resume 도중(§ runPlannerLocked PHASE_PLANNED 블록, 아래
// validateResumedKnownTasks)에 이 셋을 그대로 재사용하면, 아직 만들어지지 않은 뒤 Phase의
// REQ/AC가 "커버되지 않음"으로 항상 오탐(false positive)된다. reference 무결성(존재하지
// 않는/금지된 REQ·AC 참조, taskId 중복, phaseId 불일치, dangling dependency, cycle)은
// 부분집합에 대해서도 항상 안전하게(단조적으로) 재확인할 수 있으므로 별도 함수로 분리해
// 두 곳(부분 resume 방어 + 최종 완전성 검증)에서 재사용한다.
function validatePhaseGraphIntegrity(phasePlan: readonly ValidatedPlannerPhase[]): PlannerValidationIssue[] {
  const issues: PlannerValidationIssue[] = [];
  const phaseIds = new Set<string>();
  for (const p of phasePlan) {
    if (phaseIds.has(p.phaseId)) issues.push({ code: "DUPLICATE_PHASE_ID", detail: `phaseId가 중복됩니다: ${p.phaseId}` });
    phaseIds.add(p.phaseId);
  }
  const phaseEdges = new Map(phasePlan.map((p) => [p.phaseId, p.dependencies]));
  for (const p of phasePlan) {
    for (const dep of p.dependencies) {
      if (!phaseIds.has(dep)) {
        issues.push({ code: "MISSING_DEPENDENCY", detail: `phase "${p.phaseId}"가 존재하지 않는 phase에 의존합니다: ${safeEchoValue(dep, PHASE_ID_ECHO_SHAPE)}` });
      } else if (Number(dep) >= Number(p.phaseId)) {
        issues.push({
          code: "PHASE_DEPENDENCY_ORDER_VIOLATION",
          detail: `phase "${p.phaseId}"가 자신보다 늦거나 같은 phaseId(${dep})에 의존합니다.`,
        });
      }
    }
  }
  if (hasCycle([...phaseIds], phaseEdges)) issues.push({ code: "DEPENDENCY_CYCLE", detail: "phase 의존성 그래프에 사이클이 있습니다(global)." });
  return issues;
}

// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 재검증, HIGH) — validatePhasePlanRawOutput()
// (STAGE 2 라이브 validator)는 각 phase의 reqIds/acIds를 deferred/out-of-scope/실제 존재
// 여부까지 검증하지만, 그 결과가 checkpoint된 뒤(resume/최종 검증 시점)에는 이 필드 자체가
// 다시 검증되지 않았다 — validatePhaseGraphIntegrity(의존성만 확인)와
// validateTaskReferenceIntegrity(task가 실제로 참조한 값만 확인)는 phasePlan[].reqIds/acIds에
// 존재하지 않거나 deferred/out-of-scope인 값이 직접 주입돼도 잡지 못한다. 이 값은 STAGE 3
// 프롬프트(buildPhaseTaskPrompt)의 "이 Phase에 배정된 Requirements/AC" 섹션 구성에 그대로
// 쓰이므로, 신뢰 경계(LLM 프롬프트) 진입 전에 다시 검증한다 — validateResumedPhasePlanAndKnownTasks
// (PHASE_PLANNED resume)와 validateGlobalTraceability(최종 검증) 양쪽에서 재사용한다.
function validatePhaseRequirementAssignmentIntegrity(
  normalized: NormalizedMasterSpec,
  phasePlan: readonly ValidatedPlannerPhase[]
): PlannerValidationIssue[] {
  const issues: PlannerValidationIssue[] = [];
  const deferredIds = new Set(normalized.deferredItems.map((d) => d.id));
  const outOfScopeIds = new Set(normalized.outOfScope.map((o) => o.id));
  const requirementIds = new Set(normalized.requirements.map((r) => r.id));
  const acIdSet = new Set(normalized.acceptanceCriteria.map((a) => a.id));
  for (const phase of phasePlan) {
    for (const r of phase.reqIds) {
      if (deferredIds.has(r) || outOfScopeIds.has(r)) {
        issues.push({ code: "DEFERRED_OR_OUT_OF_SCOPE_REFERENCED", detail: `phase "${phase.phaseId}"가 deferred/out-of-scope 항목(${safeEchoValue(r, ID_FAMILY_SHAPE)})을 참조합니다.` });
      } else if (!requirementIds.has(r)) {
        issues.push({ code: "UNKNOWN_REQUIREMENT_REFERENCE", detail: `phase "${phase.phaseId}"가 존재하지 않는 requirement(${safeEchoValue(r, ID_FAMILY_SHAPE)})를 참조합니다.` });
      }
    }
    for (const a of phase.acIds) {
      if (deferredIds.has(a) || outOfScopeIds.has(a)) {
        issues.push({ code: "DEFERRED_OR_OUT_OF_SCOPE_REFERENCED", detail: `phase "${phase.phaseId}"가 deferred/out-of-scope 항목(${safeEchoValue(a, ID_FAMILY_SHAPE)})을 Acceptance Criteria로 참조합니다.` });
      } else if (!acIdSet.has(a)) {
        issues.push({ code: "UNKNOWN_REQUIREMENT_REFERENCE", detail: `phase "${phase.phaseId}"가 존재하지 않는 Acceptance Criteria(${safeEchoValue(a, ID_FAMILY_SHAPE)})를 참조합니다.` });
      }
    }
  }
  return issues;
}

// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차, HIGH) — 이전에는 phaseIds(단순 존재
// 집합)만 받아 "존재하는 phase를 가리키는가"만 확인했다. "Task reqIds/acceptanceCriteria가
// 자신의 phase가 배정받은 REQ/AC 범위 안인가"는 STAGE 3 단일 호출(§ validatePhaseTaskRawOutput)
// 에서만 검사됐는데, 그 검사는 resume checkpoint가 직접 변조된 경우(STAGE 3를 다시 거치지
// 않고 phaseTaskPlans만 바뀐 경우) 우회된다 — 여기서 phasePlan 전체를 받아 phase별
// reqIds/acIds도 함께 재확인하고, phase 단위 coverage(§ validatePhaseTaskRawOutput과 동일
// 기준)까지 다시 검증해 "Task-stage validator 우회"를 막는다.
function validateTaskReferenceIntegrity(
  normalized: NormalizedMasterSpec,
  phasePlan: readonly ValidatedPlannerPhase[],
  allTasks: readonly PlannerRawTask[]
): PlannerValidationIssue[] {
  const issues: PlannerValidationIssue[] = [];
  const phaseById = new Map(phasePlan.map((p) => [p.phaseId, p]));
  const taskIds = new Set<string>();
  const taskEdges = new Map<string, string[]>();
  const taskPhaseById = new Map<string, string>();
  const deferredIds = new Set(normalized.deferredItems.map((d) => d.id));
  const outOfScopeIds = new Set(normalized.outOfScope.map((o) => o.id));
  const requirementIds = new Set(normalized.requirements.map((r) => r.id));
  const acIdSet = new Set(normalized.acceptanceCriteria.map((a) => a.id));
  const reqCoverageByPhase = new Map<string, Set<string>>();
  const acCoverageByPhase = new Map<string, Set<string>>();
  for (const t of allTasks) {
    if (taskIds.has(t.taskId)) issues.push({ code: "DUPLICATE_TASK_ID", detail: `taskId가 중복됩니다: ${t.taskId}` });
    taskIds.add(t.taskId);
    taskEdges.set(t.taskId, t.dependsOn);
    taskPhaseById.set(t.taskId, t.phaseId);
    const phase = phaseById.get(t.phaseId);
    if (!phase || !t.taskId.startsWith(`${t.phaseId}.`)) {
      issues.push({ code: "INVALID_STRUCTURE", detail: `task "${safeEchoValue(t.taskId, TASK_ID_ECHO_SHAPE)}"의 phaseId(${safeEchoValue(t.phaseId, PHASE_ID_ECHO_SHAPE)})가 존재하지 않거나 taskId와 일치하지 않습니다.` });
    }
    const phaseReqIdSet = phase ? new Set(phase.reqIds) : undefined;
    const phaseAcIdSet = phase ? new Set(phase.acIds) : undefined;
    for (const r of t.reqIds) {
      if (deferredIds.has(r) || outOfScopeIds.has(r)) {
        issues.push({ code: "DEFERRED_OR_OUT_OF_SCOPE_REFERENCED", detail: `task "${t.taskId}"가 deferred/out-of-scope 항목(${safeEchoValue(r, ID_FAMILY_SHAPE)})을 요구사항으로 참조합니다.` });
      } else if (!requirementIds.has(r)) {
        issues.push({ code: "UNKNOWN_REQUIREMENT_REFERENCE", detail: `task "${t.taskId}"가 존재하지 않는 requirement(${safeEchoValue(r, ID_FAMILY_SHAPE)})를 참조합니다.` });
      } else if (phaseReqIdSet && !phaseReqIdSet.has(r)) {
        issues.push({ code: "REQUIREMENT_OUTSIDE_PHASE_SCOPE", detail: `task "${t.taskId}"가 자신의 phase(${t.phaseId})에 배정되지 않은 requirement(${safeEchoValue(r, ID_FAMILY_SHAPE)})를 참조합니다.` });
      } else if (phaseReqIdSet) {
        if (!reqCoverageByPhase.has(t.phaseId)) reqCoverageByPhase.set(t.phaseId, new Set());
        reqCoverageByPhase.get(t.phaseId)!.add(r);
      }
    }
    for (const a of t.acceptanceCriteria) {
      if (deferredIds.has(a) || outOfScopeIds.has(a)) {
        issues.push({ code: "DEFERRED_OR_OUT_OF_SCOPE_REFERENCED", detail: `task "${t.taskId}"가 deferred/out-of-scope 항목(${safeEchoValue(a, ID_FAMILY_SHAPE)})을 Acceptance Criteria로 참조합니다.` });
      } else if (!acIdSet.has(a)) {
        issues.push({ code: "UNKNOWN_REQUIREMENT_REFERENCE", detail: `task "${t.taskId}"가 존재하지 않는 Acceptance Criteria(${safeEchoValue(a, ID_FAMILY_SHAPE)})를 참조합니다.` });
      } else if (phaseAcIdSet && !phaseAcIdSet.has(a)) {
        issues.push({ code: "ACCEPTANCE_CRITERIA_OUTSIDE_PHASE_SCOPE", detail: `task "${t.taskId}"가 자신의 phase(${t.phaseId})에 배정되지 않은 Acceptance Criteria(${safeEchoValue(a, ID_FAMILY_SHAPE)})를 참조합니다.` });
      } else if (phaseAcIdSet) {
        if (!acCoverageByPhase.has(t.phaseId)) acCoverageByPhase.set(t.phaseId, new Set());
        acCoverageByPhase.get(t.phaseId)!.add(a);
      }
    }
  }
  // SI-3.3~3.5 4-chunk 최종 리뷰 지적(HIGH) — 지금까지 task dependency는 "존재하는 task를
  // 가리키는가"(MISSING_DEPENDENCY)와 "전체 그래프에 사이클이 없는가"(DEPENDENCY_CYCLE)만
  // 확인했다. 정상 fresh 생성에서는(STAGE 3가 phase를 순서대로 하나씩 처리하므로) 이보다
  // 이른 phase의 task가 "아직 생성되지 않은" 늦은 phase의 task를 가리킬 수 없어 이 문제가
  // 드러나지 않았다. 하지만 resume checkpoint가 변조되어 늦은 phase가 이른 phase보다 먼저
  // 완료된 상태로 저장되면(§ validateResumedPhasePlanAndKnownTasks가 이미 이 phase 순서를
  // 강제하지 않는다는 점을 이 리뷰가 지적), 그 시점의 knownTasksFlat에 늦은 phase의 task가
  // 포함되어 이른 phase의 task가 그 task에 의존하는 것을 이 함수가 지금까지 허용했다 — 실행
  // 순서를 역전시키는 task dependency다. phase 자체의 의존성은 이미 같은 원칙(자신보다
  // 늦거나 같은 phaseId에 의존 금지, § validatePhaseGraphIntegrity의
  // PHASE_DEPENDENCY_ORDER_VIOLATION)으로 강제되므로, task dependency에도 동일한 원칙을
  // 적용한다 — 서로 다른 phase를 가리키는 task dependency는 반드시 자신보다 이른 phaseId를
  // 가리켜야 한다.
  for (const t of allTasks) {
    for (const dep of t.dependsOn) {
      if (!taskIds.has(dep)) {
        issues.push({ code: "MISSING_DEPENDENCY", detail: `task "${t.taskId}"가 존재하지 않는 task에 의존합니다: ${safeEchoValue(dep, TASK_ID_ECHO_SHAPE)}` });
        continue;
      }
      const depPhaseId = taskPhaseById.get(dep);
      if (depPhaseId !== undefined && depPhaseId !== t.phaseId && Number(depPhaseId) >= Number(t.phaseId)) {
        issues.push({
          code: "TASK_DEPENDENCY_PHASE_ORDER_VIOLATION",
          detail: `task "${t.taskId}"(phase ${t.phaseId})가 자신보다 늦거나 같은 phase(${depPhaseId})의 task(${safeEchoValue(dep, TASK_ID_ECHO_SHAPE)})에 의존합니다 — 실행 순서를 역전시킵니다.`,
        });
      }
    }
  }
  if (hasCycle([...taskIds], taskEdges)) issues.push({ code: "DEPENDENCY_CYCLE", detail: "task 의존성 그래프에 사이클이 있습니다(global)." });

  // phase 단위 coverage 재확인 — 해당 phase의 task가 이미 생성됐다면 그 phase가 배정받은
  // 모든 REQ/AC가 실제 Task에 coverage되어야 한다. 아직 생성되지 않은 뒤 phase는 건너뛴다.
  const phasesWithTasks = new Set(allTasks.map((t) => t.phaseId));
  for (const phase of phasePlan) {
    if (!phasesWithTasks.has(phase.phaseId)) continue;
    const reqCov = reqCoverageByPhase.get(phase.phaseId) ?? new Set<string>();
    const acCov = acCoverageByPhase.get(phase.phaseId) ?? new Set<string>();
    for (const reqId of phase.reqIds) {
      if (!reqCov.has(reqId)) {
        issues.push({ code: "MISSING_REQUIREMENT_COVERAGE", detail: `phase ${phase.phaseId}에 배정된 requirement(${reqId})가 이 phase의 어떤 task에도 매핑되지 않았습니다.` });
      }
    }
    for (const acId of phase.acIds) {
      if (!acCov.has(acId)) {
        issues.push({ code: "MISSING_ACCEPTANCE_CRITERIA_COVERAGE", detail: `phase ${phase.phaseId}에 배정된 Acceptance Criteria(${acId})가 이 phase의 어떤 task에도 매핑되지 않았습니다.` });
      }
    }
  }
  return issues;
}

function validateCoverageCompleteness(normalized: NormalizedMasterSpec, allTasks: readonly PlannerRawTask[]): PlannerValidationIssue[] {
  const issues: PlannerValidationIssue[] = [];
  const reqCoverage = new Set<string>();
  const acCoverage = new Set<string>();
  for (const t of allTasks) {
    for (const r of t.reqIds) reqCoverage.add(r);
    for (const a of t.acceptanceCriteria) acCoverage.add(a);
  }
  for (const req of normalized.requirements) {
    if (!reqCoverage.has(req.id)) {
      issues.push({ code: "MISSING_REQUIREMENT_COVERAGE", detail: `Requirement(${req.id})가 어떤 task에도 매핑되지 않았습니다.` });
    }
  }
  for (const ac of normalized.acceptanceCriteria) {
    if (!acCoverage.has(ac.id)) {
      issues.push({ code: "MISSING_ACCEPTANCE_CRITERIA_COVERAGE", detail: `Acceptance Criteria(${ac.id})가 어떤 task에도 매핑되지 않았습니다.` });
    }
  }
  return issues;
}

// MEDIUM1(§ GPT Independent Reviewer 지적 SI-3.3 REVISE 2회차) — checkpoint shape 검사(§
// isValidValidatedPhaseArray/isValidPhaseTaskPlansShape)는 타입만 확인할 뿐 unknown key를
// 거부하지 않는다. "완전한(coverage 포함) 검증"이 아니라 "부분집합에도 항상 안전한 구조
// 검증"이므로 validateTaskReferenceIntegrity와 동일하게 완전/부분 데이터 양쪽에서 재사용한다.
function validateCheckpointShapeStrictness(phasePlan: readonly ValidatedPlannerPhase[], tasks: readonly PlannerRawTask[]): PlannerValidationIssue[] {
  const issues: PlannerValidationIssue[] = [];
  for (const p of phasePlan) {
    checkExactKeys(`phase "${p.phaseId}"(checkpoint)`, p as unknown as Record<string, unknown>, VALIDATED_PHASE_KEYS, issues);
  }
  for (const t of tasks) {
    const tObj = t as unknown as Record<string, unknown>;
    checkExactKeys(`task "${t.taskId}"(checkpoint)`, tObj, PLANNER_RAW_TASK_KEYS, issues);
    validateRequiredTestsArray(`task "${t.taskId}"(checkpoint).requiredTests`, tObj.requiredTests, issues);
    if (isStringArray(t.scope)) {
      for (const scope of t.scope) {
        if (!isSafeScopePrefix(scope)) {
          issues.push({ code: "UNSAFE_TASK_SCOPE", detail: `task "${t.taskId}"(checkpoint).scope가 안전하지 않습니다: ${safeEchoValue(scope)}` });
        }
      }
    }
  }
  return issues;
}

// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 재검증, HIGH) — 이 함수는 TASKS_PLANNED
// resume 진입 시(STAGE 4)와 TRACEABILITY_VALIDATED resume 진입 직전(STAGE 5) 양쪽에서
// checkpoint 전체를 재검증하는 마지막 방어선인데, validateResumedPhasePlanAndKnownTasks
// (PHASE_PLANNED resume 방어선)와 달리 secret-shaped 값 스캔이 빠져 있었다 — checkpoint를
// 직접 변조해 STAGE 3 라이브 validator(매 호출마다 scanRawTextForSecrets를 거침)를 우회하고
// secret-shaped 문자열을 phasePlan/task 필드에 주입하면, 이 함수만으로는 잡히지 않고 최종
// project-manifest.json/task-registry.json까지 그대로 전달될 수 있었다. 같은 헬퍼
// (scanRawTextForSecrets)를 재사용해 로직 복제 없이 동일 방어를 적용한다.
export function validateGlobalTraceability(
  normalized: NormalizedMasterSpec,
  phasePlan: readonly ValidatedPlannerPhase[],
  allTasks: readonly PlannerRawTask[]
): PlannerValidationIssue[] {
  const countLimitIssues = validatePhaseTaskCountLimits(phasePlan, allTasks);
  if (countLimitIssues.length > 0) return countLimitIssues;

  const issues: PlannerValidationIssue[] = [
    ...scanRawTextForSecrets(JSON.stringify(phasePlan), "<planner-phase-plan-checkpoint>"),
    ...scanRawTextForSecrets(JSON.stringify(allTasks), "<planner-known-tasks-checkpoint>"),
    ...validateCheckpointShapeStrictness(phasePlan, allTasks),
    ...validatePhaseGraphIntegrity(phasePlan),
    ...validatePhaseRequirementAssignmentIntegrity(normalized, phasePlan),
    ...validateTaskReferenceIntegrity(normalized, phasePlan, allTasks),
    ...validateCoverageCompleteness(normalized, allTasks),
  ];

  if (issues.length === 0 && allTasks.length > 0 && !allTasks.some((t) => t.dependsOn.length === 0)) {
    issues.push({ code: "NO_RUNNABLE_TASK_FOUND", detail: "실행 가능한(의존성이 없는) 첫 task가 없습니다." });
  }

  return issues;
}

/**
 * PHASE_PLANNED resume 진입 시(§ runPlannerLocked) STAGE 3 루프가 architecture/phasePlan을
 * 실제로 Task Plan LLM 프롬프트에 쓰기 전에, 그리고 이미 확정된 phaseTaskPlans(있다면)를
 * "이미 확정된 task id" 컨텍스트로 다음 프롬프트에 노출하기 전에 호출한다(§ GPT Independent
 * Reviewer 지적 SI-3.3 REVISE 2회차, HIGH — "PHASE_PLANNED resume에서 architecture와
 * phasePlan이 LLM prompt에 사용되기 전에 semantic 재검증되지 않는다"). must-have coverage는
 * 아직 일부 Phase의 task만 존재할 수 있어(정상) 여기서 확인하지 않는다(§ 위
 * validateCoverageCompleteness 분리 주석) — reference 무결성 + phase graph integrity +
 * secret-shaped 값만 확인한다.
 */
// SI-3.3~3.5 4-chunk 최종 리뷰 지적(HIGH) — PLANNER_MAX_PHASES/PLANNER_MAX_TASKS_PER_PHASE는
// 지금까지 fresh LLM raw output을 검증하는 시점(Phase Plan/Task Plan stage validator)에만
// 강제됐다. resume 경로(이 함수)는 planner-state.json에서 읽은 phasePlan/phaseTaskPlans를
// 그대로 신뢰해 이 상한을 다시 확인하지 않았다 — planner-state.json 자체가 변조되어(§
// "mid-run-tamper-*" 시나리오가 이미 이 파일에 대한 변조 탐지를 검증하지만, 그 시나리오들은
// "다른 신뢰 입력과 self-consistent하지 않은 변조"만 다뤘다) shape는 유효하지만 phase/task
// 개수가 상한을 넘는 경우, resume이 phase마다 별도 LLM 호출을 계속 발생시켜 비용/시간
// 제한을 우회할 수 있었다. fresh 경로와 동일한 Core 상한을 여기서도 강제한다(로직 복제가
// 아니라 동일한 상수를 재사용 — 값의 단일 출처는 그대로 PLANNER_MAX_PHASES/
// PLANNER_MAX_TASKS_PER_PHASE 하나다).
// SI-3.3~3.5 4-chunk 최종 리뷰 2라운드 지적(HIGH) — 위 상한 재검증을
// validateResumedPhasePlanAndKnownTasks(PHASE_PLANNED resume 전용)에만 넣었더니
// TASKS_PLANNED/TRACEABILITY_VALIDATED resume과 fresh final assembly가 공유하는
// validateGlobalTraceability()는 이 상한을 여전히 재확인하지 않았다 — checkpoint의
// stage를 그 이후 단계로 만들고 모든 phaseTaskPlans key를 채우면 이 상한을 우회해
// PHASE_PLANNED 방어선을 건너뛸 수 있었다. 두 함수 모두 이 하나의 헬퍼를 공유해(로직
// 복제 없음) 상한이 "resume이 어느 stage에서 재개되든" 동일하게 적용되게 한다.
function validatePhaseTaskCountLimits(phasePlan: readonly ValidatedPlannerPhase[], allTasks: readonly PlannerRawTask[]): PlannerValidationIssue[] {
  if (phasePlan.length > PLANNER_MAX_PHASES) {
    return [
      {
        code: "TOO_MANY_PHASES",
        detail: `checkpoint의 phase 개수(${phasePlan.length})가 상한(${PLANNER_MAX_PHASES})을 초과합니다 — 변조/손상이 의심되어 거부합니다.`,
      },
    ];
  }
  const countByPhase = new Map<string, number>();
  for (const t of allTasks) countByPhase.set(t.phaseId, (countByPhase.get(t.phaseId) ?? 0) + 1);
  const issues: PlannerValidationIssue[] = [];
  for (const [phaseId, count] of countByPhase) {
    if (count > PLANNER_MAX_TASKS_PER_PHASE) {
      issues.push({
        code: "TOO_MANY_TASKS_IN_PHASE",
        detail: `checkpoint의 phase ${phaseId} task 개수(${count})가 상한(${PLANNER_MAX_TASKS_PER_PHASE})을 초과합니다 — 변조/손상이 의심되어 거부합니다.`,
      });
    }
  }
  return issues;
}

function validateResumedPhasePlanAndKnownTasks(
  phasePlan: readonly ValidatedPlannerPhase[],
  phaseTaskPlans: Readonly<Record<string, PlannerRawTask[]>>,
  normalized: NormalizedMasterSpec
): PlannerValidationIssue[] {
  const knownTasks = Object.values(phaseTaskPlans).flat();
  const issues: PlannerValidationIssue[] = [
    ...scanRawTextForSecrets(JSON.stringify(phasePlan), "<planner-phase-plan-checkpoint>"),
    ...scanRawTextForSecrets(JSON.stringify(knownTasks), "<planner-known-tasks-checkpoint>"),
    ...validatePhaseTaskCountLimits(phasePlan, knownTasks),
  ];
  if (issues.length > 0) return issues;
  issues.push(
    ...validateCheckpointShapeStrictness(phasePlan, knownTasks),
    ...validatePhaseGraphIntegrity(phasePlan),
    ...validatePhaseRequirementAssignmentIntegrity(normalized, phasePlan),
    ...validateTaskReferenceIntegrity(normalized, phasePlan, knownTasks)
  );
  return issues;
}

// ---------------------------------------------------------------------------
// STAGE 5 — FINAL ASSEMBLY. 검증된 Architecture/Phase Plan/Phase별 Task Plan을 SI-3가
// 쓰던 PlannerRawOutput 모양으로 순수 deterministic 조립한 뒤, buildGeneratedExecutionData
// 이하는 SI-3와 완전히 동일한 경로를 재사용한다(project-manifest.ts/task-registry.ts/
// project-policy.ts 재검증 포함) — LLM이 최종 실행 데이터를 다시 통째로 생성하지 않는다.
// ---------------------------------------------------------------------------

// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차, HIGH) — 이전에는 `phaseTaskPlans[phase.phaseId] ?? []`로
// 누락된 phase key를 조용히 "그 phase에는 task가 없음"으로 취급했다. 이 함수는 STAGE 4 이후
// (모든 phase의 Task Plan이 이미 확정됐다고 stage가 보장하는 시점)에만 호출되므로, 이 시점에
// phasePlan의 phaseId 중 하나라도 phaseTaskPlans에 대응 entry가 없으면 "누락"이 아니라
// "checkpoint 손상/변조"다 — throw로 fail-closed하고, 호출부가 BLOCKED(PLANNER_STATE_CORRUPT)로
// 변환한다(§ runPlannerLocked).
export function flattenPhaseTaskPlans(
  phasePlan: readonly ValidatedPlannerPhase[],
  phaseTaskPlans: Readonly<Record<string, PlannerRawTask[]>>
): PlannerRawTask[] {
  const out: PlannerRawTask[] = [];
  for (const phase of [...phasePlan].sort((a, b) => Number(a.phaseId) - Number(b.phaseId))) {
    // GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 재검증, MEDIUM) — 이전에는
    // `phaseTaskPlans[phase.phaseId]`의 truthiness만 확인했다. own-property 존재 여부를
    // hasOwnProperty로 명시적으로 먼저 확인하고, 값이 실제로 비어있지 않은 배열인지도 여기서
    // 다시 한번 방어적으로 확인한다(§ isValidPhaseTaskPlansShape가 이미 파일을 읽는 시점에
    // 이 불변식을 강제하지만, 이 함수는 export되어 다른 호출부에서도 재사용될 수 있으므로
    // 자체적으로도 fail-closed여야 한다).
    const hasEntry = Object.prototype.hasOwnProperty.call(phaseTaskPlans, phase.phaseId);
    const tasksForPhase = hasEntry ? phaseTaskPlans[phase.phaseId] : undefined;
    if (!hasEntry || !Array.isArray(tasksForPhase) || tasksForPhase.length === 0) {
      throw new Error(`flattenPhaseTaskPlans: phase "${phase.phaseId}"에 대응하는 유효한(비어있지 않은) phaseTaskPlans entry가 없습니다 — 누락되거나 빈 phase를 조용히 취급하지 않습니다.`);
    }
    out.push(...tasksForPhase);
  }
  return out;
}

export function synthesizeLegacyRawOutput(
  identity: BootstrapRequestIdentity,
  architecture: ArchitectureRawOutput,
  phasePlan: readonly ValidatedPlannerPhase[],
  allTasks: readonly PlannerRawTask[]
): PlannerRawOutput {
  return {
    projectId: identity.projectId,
    specVersion: identity.specVersion,
    architectureSummary: architecture.architectureSummary,
    technologyChoices: architecture.technologyChoices,
    fixedConstraintAcknowledgement: architecture.fixedConstraintAcknowledgement,
    modulesOrComponents: architecture.modulesOrComponents,
    integrations: architecture.integrations,
    securityRequirementsSummary: architecture.securityRequirementsSummary,
    testingRequirementsSummary: architecture.testingRequirementsSummary,
    deliveryConstraintsSummary: architecture.deliveryConstraintsSummary,
    phases: phasePlan.map((p) => ({ phaseId: p.phaseId, name: p.name, objective: p.objective, dependsOn: p.dependencies, completionCriteria: p.completionCriteria })),
    tasks: [...allTasks],
    executionPolicy: architecture.executionPolicy,
  };
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
      ...(t.requiresHumanReview ? { requiresHumanReview: true } : {}),
    };
  });
}

function toRequiredTestOwners(tasks: readonly PlannerRawTask[]): RequiredTestOwner[] {
  return tasks.map((t) => ({ taskId: t.taskId, requiredTests: t.requiredTests }));
}

function describeExecutionContractIssues(issues: readonly ExecutionContractIssue[]): string {
  return issues.map((i) => i.reason).join(" | ");
}

// SI-3.7(Execution Contract Closure, EP-1) — allowedCommands는 더 이상 STAGE 1 LLM 출력을
// 그대로 신뢰하지 않는다. Core가 deterministic하게 (a) STAGE 1이 제안한 후보 중 Core Command
// Safety Gate를 통과하는 것만 남기고(§ filterAllowedCommandsByCoreCapability), (b) 모든
// task의 requiredTests에서 파생된(§ deriveAllowedCommandsFromRequiredTests — 이 함수를
// 호출하는 시점에는 이미 validateRequiredTestExecutionContract가 그 requiredTests 전체를
// 검증했다는 전제 위에서만 안전하다, § runPlannerLocked/reassembleExecutionContractLocked의
// 호출 순서) 최소 명령을 더해 최종 allowedCommands를 만든다 — task-registry.requiredTests와
// execution-policy.allowedCommands가 서로 다른 stage의 독립적인 LLM 출력이라 어긋날 수
// 있었던 구조적 원인(EP-1)을 "requiredTests가 곧 allowedCommands의 근거"로 만들어 제거한다.
function collapseExecutionScopes(scopes: readonly string[]): string[] {
  const unique = [...new Set(scopes)];
  // broad directory scope가 이미 있으면 그 아래 exact/child scope는 제거해 policy를 최소화한다.
  return unique.filter((scope, idx, all) =>
    !all.some((other, otherIdx) => {
      if (idx === otherIdx || !other.endsWith("/")) return false;
      return scope === other.slice(0, -1) || scope.startsWith(other);
    })
  );
}

function buildExecutionPolicy(raw: PlannerRawOutput): ProjectExecutionPolicy {
  const safeAuthoredCommands = filterAllowedCommandsByCoreCapability(raw.executionPolicy.allowedCommands, raw.executionPolicy.commandCwdAliases);
  const derivedFromRequiredTests = deriveAllowedCommandsFromRequiredTests(toRequiredTestOwners(raw.tasks));
  // STAGE 1 executionPolicy는 Task가 존재하기 전에 만들어지므로 root 파일/apps/supabase 등 실제
  // Task scope를 완전히 알 수 없다. 최종 정책은 검증된 모든 Task scope의 union을 deterministic하게
  // 합쳐 "Task는 허용됐지만 Project-wide Safe Executor가 거부"하는 실행계약 gap을 닫는다.
  const taskScopes = raw.tasks.flatMap((t) => t.scope);
  const allowedReadPrefixes = collapseExecutionScopes([...raw.executionPolicy.allowedReadPrefixes, ...taskScopes]);
  const allowedWritePrefixes = collapseExecutionScopes([...raw.executionPolicy.allowedWritePrefixes, ...taskScopes]);
  // § execution-contract.ts deriveDependencyResolutionCommands 주석(Dependency/Lockfile
  // Bootstrap Gap Closure) — 위에서 이미 확정된 최종 allowedWritePrefixes(STAGE 1 policy +
  // 모든 task scope의 union)에 root package.json이 있을 때만, lockfile을 생성할 수 있는
  // 고정 안전 명령 하나를 더한다.
  const derivedDependencyResolution = deriveDependencyResolutionCommands(allowedWritePrefixes);
  return {
    allowedReadPrefixes,
    allowedWritePrefixes,
    commandCwdAliases: raw.executionPolicy.commandCwdAliases,
    allowedCommands: mergeAllowedCommands(safeAuthoredCommands, derivedFromRequiredTests, derivedDependencyResolution),
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
  /** fixedConstraints가 하나라도 있으면 HOW(phases/tasks/technologyChoices/executionPolicy)가
   *  그 constraint를 실제로 지키는지는 자유 텍스트 의미 해석이 필요해 이 Validator가 기계적으로
   *  검증할 수 없다는 사실을 항상 명시적으로 드러낸다(READY_FOR_AUTODEV outcome에도 동일 내용
   *  노출) — 사람이 반드시 phases/tasks/technologyChoices/executionPolicy를 직접 대조해야 한다. */
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
// Planner State — 원자적 write, resume-safe, idempotent. SI-3.3부터 schemaVersion=2로
// stage별 구조화된 산출물(architecture/phasePlan/phaseTaskPlans)을 직접 저장한다(SI-3의
// 단일 rawPlannerOutput 문자열 저장 방식을 대체) — resume은 이 구조화된 값을 그대로
// 재사용하고, 이미 완료된 Phase의 Task Plan은 다시 호출하지 않는다.
// ---------------------------------------------------------------------------

export const PLANNER_STATE_SCHEMA_VERSION = 2 as const;

export type PlannerStage =
  | "SPEC_VERIFIED"
  | "REQUIREMENTS_NORMALIZED"
  | "ARCHITECTURE_PLANNED"
  | "PHASE_PLANNED"
  | "TASKS_PLANNED"
  | "TRACEABILITY_VALIDATED"
  | "EXECUTION_DATA_GENERATED"
  | "EXECUTION_DATA_VALIDATED"
  | "COMPLETED";

const PLANNER_STAGE_ORDER: readonly PlannerStage[] = [
  "SPEC_VERIFIED",
  "REQUIREMENTS_NORMALIZED",
  "ARCHITECTURE_PLANNED",
  "PHASE_PLANNED",
  "TASKS_PLANNED",
  "TRACEABILITY_VALIDATED",
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
  /** ARCHITECTURE_PLANNED 이상에서만 채워진다(검증을 통과한 결과만 저장된다). */
  architecture?: ArchitectureRawOutput;
  /** PHASE_PLANNED 이상에서만 채워진다. */
  phasePlan?: ValidatedPlannerPhase[];
  /** phaseId를 key로 하는 부분 진행 상태 — PHASE_PLANNED 단계 진행 중에도 완료된 Phase마다
   *  즉시(체크포인트로) 채워진다. TASKS_PLANNED 도달 시 phasePlan의 모든 phaseId를 포함한다. */
  phaseTaskPlans?: Record<string, PlannerRawTask[]>;
  /** REJECTED로 끝난 마지막 시도의 진단 정보 — "부분 산출물 보존"(감사/재시도 참고용).
   *  stage를 진행시키지 않는다. */
  lastValidationIssues?: PlannerValidationIssue[];
  lastValidationContext?: { stage: string; phaseId?: string };
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
// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차, HIGH/MEDIUM) — project-manifest.json/
// task-registry.json/execution-policy.json은 각각 독립적인 writeJsonAtomic() 호출로
// 저장된다(개별 파일은 원자적이지만, 3개 파일 전체를 하나의 트랜잭션으로 묶는 파일시스템
// 원시 기능은 없다) — 그중 하나만 실패하면(디스크 공간 부족 등) 서로 다른 generation의
// 파일이 섞일 수 있다. 새 트랜잭션 framework 대신, 3개 파일을 모두 성공적으로 쓴 "직후"
// 그 파일들의 실제 내용을 다시 읽어 해시를 계산하고, 그 해시를 담은 이 4번째 파일을 가장
// 마지막에 쓴다 — 이 파일이 존재하고 기록된 해시가 실제 3개 파일과 일치해야만 "이 3개가
// 같은 generation에서 함께 완성됐다"고 신뢰한다(§ reloadAndValidateGeneratedData). 부분
// 실패(3개 중 일부만 갱신됨/이 파일 자체가 없음/해시 불일치)는 다음 resume에서 즉시
// GENERATED_DATA_INVALID로 탐지된다 — 기존 generated-data integrity 검증에 통합될 뿐,
// 별도 read/write 경로를 추가하지 않는다.
function generationManifestPath(projectRoot: string): string {
  return join(projectRoot, ".autodev", "generation.json");
}
interface GenerationManifest {
  generationId: string;
  manifestSha256: string;
  taskRegistrySha256: string;
  executionPolicySha256: string;
}
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
function isValidGenerationManifestShape(v: unknown): v is GenerationManifest {
  if (!structuralGuard(v)) return false;
  return (
    typeof v.generationId === "string" &&
    v.generationId.length > 0 &&
    typeof v.manifestSha256 === "string" &&
    SHA256_HEX_RE.test(v.manifestSha256) &&
    typeof v.taskRegistrySha256 === "string" &&
    SHA256_HEX_RE.test(v.taskRegistrySha256) &&
    typeof v.executionPolicySha256 === "string" &&
    SHA256_HEX_RE.test(v.executionPolicySha256)
  );
}
function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
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

function isValidArchitectureShape(v: unknown): v is ArchitectureRawOutput {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.projectId === "string" &&
    typeof o.specVersion === "string" &&
    typeof o.architectureSummary === "string" &&
    Array.isArray(o.technologyChoices) &&
    isStringArray(o.modulesOrComponents) &&
    isStringArray(o.integrations) &&
    isStringArray(o.architecturalBoundaries) &&
    isStringArray(o.dependencyRelationships) &&
    isStringArray(o.majorConstraints) &&
    isStringArray(o.securityRequirementsSummary) &&
    isStringArray(o.testingRequirementsSummary) &&
    isStringArray(o.deliveryConstraintsSummary) &&
    Array.isArray(o.fixedConstraintAcknowledgement) &&
    structuralGuard(o.executionPolicy)
  );
}

// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 재검증, HIGH) — 빈 배열은 Array.every()가
// vacuously true를 반환해 "shape-valid"로 통과했다. 라이브 validator(validatePhasePlanRawOutput)는
// `raw.phases.length === 0`을 절대 성공으로 반환하지 않으므로, 정상 파이프라인에서 저장된
// phasePlan이 빈 배열일 수 없다 — checkpoint에 phasePlan=[]을 직접 주입하는 변조를 여기서
// fail-closed로 거부한다.
function isValidValidatedPhaseArray(v: unknown): v is ValidatedPlannerPhase[] {
  if (!Array.isArray(v) || v.length === 0) return false;
  return v.every((p) => {
    if (!structuralGuard(p)) return false;
    return (
      typeof p.phaseId === "string" &&
      PHASE_ID_RE.test(p.phaseId) &&
      typeof p.name === "string" &&
      typeof p.objective === "string" &&
      isStringArray(p.dependencies) &&
      isStringArray(p.completionCriteria) &&
      isStringArray(p.reqIds) &&
      isStringArray(p.acIds)
    );
  });
}

// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 재검증, HIGH) — 이전에는 phaseTaskPlans의
// 각 phase entry가 "배열이기만 하면"(길이 0 포함) shape-valid로 인정됐다. 그런데 실제 STAGE 3
// 라이브 validator(validatePhaseTaskRawOutput)는 tasks.length===0인 응답을 절대 성공으로
// 반환하지 않는다(가장 먼저 INVALID_STRUCTURE로 거부) — 즉 "완료된 phase의 task 배열이
// 비어있음"은 정상 파이프라인에서 나올 수 없는 상태다. 그런데 validateTaskReferenceIntegrity의
// phase-local coverage 검사는 "이 phase에 속한 task가 실제로 있는가"로 "이 phase의 STAGE 3가
// 완료됐는가"를 추론했다 — checkpoint에 `phaseTaskPlans[phaseId] = []`를 직접 주입하면(shape은
// 여전히 유효) 그 phase는 task가 0개이므로 phase-local coverage 검사 대상에서 조용히
// 제외되면서도, stage-artifact invariant(모든 phaseId가 key로 존재하기만 하면 통과)는
// 그대로 통과해 우회가 가능했다. "정상적으로 완료된 phase는 절대 빈 배열일 수 없다"는
// 불변식을 shape 검증 자체에 넣어 가장 이른 지점(파일을 읽는 즉시)에서 차단한다 — 이 결과
// isValidPlannerStateFileV2/validateCheckpointShapeStrictness(둘 다 이 함수를 재사용) 양쪽
// 모두에서 즉시 막힌다(로직 복제 없음).
function isValidPhaseTaskPlansShape(v: unknown): v is Record<string, PlannerRawTask[]> {
  if (!structuralGuard(v)) return false;
  return Object.entries(v).every(([phaseId, tasks]) => {
    if (!PHASE_ID_RE.test(phaseId)) return false;
    if (!Array.isArray(tasks) || tasks.length === 0) return false;
    return tasks.every((t) => {
      if (!structuralGuard(t)) return false;
      return (
        typeof t.taskId === "string" &&
        TASK_ID_RE.test(t.taskId) &&
        t.phaseId === phaseId &&
        typeof t.title === "string" &&
        typeof t.objective === "string" &&
        isStringArray(t.scope) &&
        isStringArray(t.constraints) &&
        isStringArray(t.dependsOn) &&
        isStringArray(t.expectedModules) &&
        Array.isArray(t.requiredTests) &&
        isStringArray(t.acceptanceCriteria) &&
        isStringArray(t.reqIds) &&
        isStringArray(t.securityConsiderations) &&
        typeof t.completionGate === "string" &&
        typeof t.requiresHumanReview === "boolean"
      );
    });
  });
}

// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차, HIGH) — 이전에는 "각 필드의 shape만
// 맞으면"(architecture/phasePlan/phaseTaskPlans가 optional이라 undefined든 valid value든
// 전부 통과) 유효한 v2 planner-state로 인정했다. stage는 "이 시점까지 어떤 산출물이 이미
// 확정됐어야 하는가"를 스스로 선언하는 값인데, 그 선언과 실제 저장된 필드가 어긋나도(예:
// stage=SPEC_VERIFIED인데 architecture가 이미 채워짐, stage=TASKS_PLANNED인데
// phaseTaskPlans가 일부 phase만 있음) shape 검사만으로는 잡히지 않았다 — runPlannerLocked의
// 각 stage 블록은 "cur.architecture/phasePlan/phaseTaskPlans가 있다"를 그대로 신뢰해
// 사용하므로, 이 불일치를 여기서 막지 않으면 이후 로직이 잘못된 가정 위에서 진행된다.
// 실제 runPlannerLocked의 stage 전이 순서를 그대로 반영한다 — PHASE_PLANNED는 STAGE 3
// 루프가 진행 중일 수 있어 phaseTaskPlans가 없거나 phasePlan의 일부 phaseId만 있을 수
// 있고(정상), 그 이후(TASKS_PLANNED~COMPLETED)는 STAGE 3 루프가 전체 phase에 대해
// 완료됐다고 stage 자체가 보장하므로 phaseTaskPlans가 phasePlan의 모든 phaseId를 정확히
// 포함해야 한다.
function isPlannerStageArtifactInvariantSatisfied(
  stage: PlannerStage,
  architecture: ArchitectureRawOutput | undefined,
  phasePlan: ValidatedPlannerPhase[] | undefined,
  phaseTaskPlans: Record<string, PlannerRawTask[]> | undefined
): boolean {
  const hasArchitecture = architecture !== undefined;
  const hasPhasePlan = phasePlan !== undefined;

  switch (stage) {
    case "SPEC_VERIFIED":
    case "REQUIREMENTS_NORMALIZED":
      return !hasArchitecture && !hasPhasePlan && phaseTaskPlans === undefined;
    case "ARCHITECTURE_PLANNED":
      return hasArchitecture && !hasPhasePlan && phaseTaskPlans === undefined;
    case "PHASE_PLANNED": {
      if (!hasArchitecture || !hasPhasePlan) return false;
      if (phaseTaskPlans === undefined) return true;
      const validPhaseIds = new Set(phasePlan!.map((p) => p.phaseId));
      return Object.keys(phaseTaskPlans).every((k) => validPhaseIds.has(k));
    }
    case "TASKS_PLANNED":
    case "TRACEABILITY_VALIDATED":
    case "EXECUTION_DATA_GENERATED":
    case "EXECUTION_DATA_VALIDATED":
    case "COMPLETED": {
      if (!hasArchitecture || !hasPhasePlan || phaseTaskPlans === undefined) return false;
      const planPhaseIds = phasePlan!.map((p) => p.phaseId);
      const planPhaseIdSet = new Set(planPhaseIds);
      const phaseTaskPlanKeys = Object.keys(phaseTaskPlans);
      if (phaseTaskPlanKeys.length !== planPhaseIds.length) return false;
      return phaseTaskPlanKeys.every((k) => planPhaseIdSet.has(k));
    }
    default:
      return false;
  }
}

function isValidPlannerStateFileV2(v: unknown): v is PlannerStateFile {
  if (!structuralGuard(v)) return false;
  if (v.schemaVersion !== PLANNER_STATE_SCHEMA_VERSION) return false;
  if (typeof v.stage !== "string" || !PLANNER_STAGE_ORDER.includes(v.stage as PlannerStage)) return false;
  if (typeof v.createdAt !== "string" || typeof v.updatedAt !== "string") return false;
  if (!isValidIdentityShape(v.identity)) return false;
  if (v.architecture !== undefined && !isValidArchitectureShape(v.architecture)) return false;
  if (v.phasePlan !== undefined && !isValidValidatedPhaseArray(v.phasePlan)) return false;
  if (v.phaseTaskPlans !== undefined && !isValidPhaseTaskPlansShape(v.phaseTaskPlans)) return false;
  return isPlannerStageArtifactInvariantSatisfied(
    v.stage as PlannerStage,
    v.architecture as ArchitectureRawOutput | undefined,
    v.phasePlan as ValidatedPlannerPhase[] | undefined,
    v.phaseTaskPlans as Record<string, PlannerRawTask[]> | undefined
  );
}

// --- 레거시(schemaVersion=1, SI-3/SI-3.1/SI-3.2) planner-state.json 마이그레이션 ---
//
// v1은 "단일 거대 rawPlannerOutput 문자열"을 저장했다 — SPEC_VERIFIED/REQUIREMENTS_NORMALIZED
// 두 stage(아직 어떤 LLM 호출도 하지 않은 상태)는 v2와 의미가 완전히 동일해 안전하게
// 마이그레이션할 수 있다. 그 이후 stage(ARCHITECTURE_PLANNED 이상)는 v1의 "완성된 단일
// PlannerRawOutput"과 v2의 "stage별로 나뉜 구조화된 산출물"이 근본적으로 다른 모양이라
// 안전하게 재해석할 수 없다 — 조용히 이어서 진행하지 않고 구조화된 BLOCKED로 중단한다(§
// 요구사항 10).
const LEGACY_V1_STAGE_ORDER = ["SPEC_VERIFIED", "REQUIREMENTS_NORMALIZED", "ARCHITECTURE_PLANNED", "EXECUTION_DATA_GENERATED", "EXECUTION_DATA_VALIDATED", "COMPLETED"] as const;
type LegacyV1Stage = (typeof LEGACY_V1_STAGE_ORDER)[number];
interface LegacyPlannerStateFileV1 {
  schemaVersion: 1;
  identity: BootstrapRequestIdentity;
  stage: LegacyV1Stage;
  createdAt: string;
  updatedAt: string;
  rawPlannerOutput?: string;
}
const LEGACY_V1_SAFELY_MIGRATABLE_STAGES: readonly LegacyV1Stage[] = ["SPEC_VERIFIED", "REQUIREMENTS_NORMALIZED"];

function isValidLegacyPlannerStateFileV1(v: unknown): v is LegacyPlannerStateFileV1 {
  if (!structuralGuard(v)) return false;
  if (v.schemaVersion !== 1) return false;
  if (typeof v.stage !== "string" || !LEGACY_V1_STAGE_ORDER.includes(v.stage as LegacyV1Stage)) return false;
  if (typeof v.createdAt !== "string" || typeof v.updatedAt !== "string") return false;
  if (!isValidIdentityShape(v.identity)) return false;
  if (v.rawPlannerOutput !== undefined && typeof v.rawPlannerOutput !== "string") return false;
  return true;
}

function migrateLegacyV1(legacy: LegacyPlannerStateFileV1): PlannerStateFile {
  return {
    schemaVersion: PLANNER_STATE_SCHEMA_VERSION,
    identity: legacy.identity,
    stage: legacy.stage as PlannerStage,
    createdAt: legacy.createdAt,
    updatedAt: legacy.updatedAt,
  };
}

type ReadPlannerStateResult =
  | { kind: "absent" }
  | { kind: "corrupt"; detail: string }
  | { kind: "unsupported_migration"; detail: string }
  | { kind: "valid"; state: PlannerStateFile };

function readPlannerState(projectRoot: string, projectRootReal: string): ReadPlannerStateResult {
  const p = plannerStateFilePath(projectRoot);
  if (!existsSync(p)) return { kind: "absent" };
  // GPT Independent Reviewer 지적(SI-3.3 REVISE 1회차, HIGH) — 이전에는 파일이 실제로
  // 존재하는데 readFileSync가 실패하면(권한 오류/디렉터리로 대체됨/I-O 오류 등) "absent"로
  // 취급해 SPEC_VERIFIED부터 새로 시작했다 — 이는 "checkpoint 변조/손상 시 BLOCKED, silent
  // repair 금지" 요구를 정면으로 위반한다(기존 진행 상태를 조용히 버리고 처음부터 다시
  // 시작하는 것도 일종의 silent repair다). 또한 planner-state.json 자체에는 생성 파일
  // (project-manifest.json 등)에 이미 적용된 symlink/realpath containment 방어가 없었다.
  // readTrustedGeneratedFile()을 그대로 재사용해(로직 복제 없음) 두 문제를 함께 해결한다 —
  // 존재하지만 신뢰할 수 있게 읽을 수 없는 파일은 이제 항상 "corrupt"로 분류된다.
  const fileRead = readTrustedGeneratedFile(p, projectRootReal);
  if (!fileRead.ok) {
    return { kind: "corrupt", detail: `planner-state.json을 신뢰할 수 있게 읽지 못했습니다: ${fileRead.detail}` };
  }
  const raw = fileRead.content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", detail: "planner-state.json이 올바른 JSON이 아닙니다." };
  }
  if (!structuralGuard(parsed)) return { kind: "corrupt", detail: "planner-state.json이 객체가 아닙니다." };
  const schemaVersion = parsed.schemaVersion;

  if (schemaVersion === PLANNER_STATE_SCHEMA_VERSION) {
    if (!isValidPlannerStateFileV2(parsed)) return { kind: "corrupt", detail: "planner-state.json이 예상된 schema(v2)와 일치하지 않습니다." };
    return { kind: "valid", state: parsed };
  }
  if (schemaVersion === 1) {
    if (!isValidLegacyPlannerStateFileV1(parsed)) return { kind: "corrupt", detail: "planner-state.json이 예상된 schema(legacy v1)와 일치하지 않습니다." };
    if (LEGACY_V1_SAFELY_MIGRATABLE_STAGES.includes(parsed.stage)) {
      return { kind: "valid", state: migrateLegacyV1(parsed) };
    }
    return {
      kind: "unsupported_migration",
      detail:
        `planner-state.json이 SI-3.3 이전 schema(schemaVersion=1, stage=${parsed.stage})입니다 — 이 stage는 ` +
        "SI-3.3의 incremental 구조로 안전하게 재해석할 수 없어 자동 진행을 중단합니다. 이 project root의 " +
        "Planner 상태를 사람이 직접 확인해야 합니다(예: .autodev/planner-state.json을 백업 후 제거하고 STAGE 1부터 다시 시작).",
    };
  }
  return { kind: "corrupt", detail: `planner-state.json의 schemaVersion(${String(schemaVersion)})을 인식할 수 없습니다.` };
}

// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차, HIGH) — 이전에는 mkdir 이후 대상/부모
// 경로가 symlink로 바뀌는 TOCTOU를 전혀 방어하지 않았다(부모 디렉터리 realpath containment
// 재확인 없음, rename 직전 재검증 없음, 실패 시 temp 정리 없음, fsync 없음). projectRootReal이
// 주어지면(§ 호출부가 이미 알고 있는 값 — 새 subsystem 없이 그대로 전달) 부모 디렉터리의
// realpath가 project root 안인지 write 직전에 재확인하고, temp 파일도 그 검증된 부모
// 디렉터리 안에서만 만든다(기존과 동일한 위치). rename 직전에도 대상 경로가 project root
// 밖을 가리키는 symlink로 바뀌지 않았는지 다시 확인한다 — 검증과 rename 사이의 아주 짧은
// 창(window)까지 완전히 없앨 수는 없지만(cross-platform Node fs API에는 O_NOFOLLOW류 원자적
// open+rename이 없다), 검증 시점을 write 직전까지 최대한 좁힌다. 실패 시 남은 temp 파일은
// 항상 정리하고, writeFileSync 직후 fsync로 durability를 확보한 뒤에만 rename한다.
// SI-3.5(Trusted Filesystem / TOCTOU Security Boundary Closure — Option A, § `.claude/
// rules/filesystem-trust-model.md`) — 이전에는 parentDir의 containment를 함수 맨 앞에서
// 딱 한 번만 확인했다. 그 확인과 실제 write(writeFileSync)/promote(renameSync) 사이에는
// 여전히 창이 있다 — portable Node.js fs만으로 이 창을 완전히 없앨 수는 없지만(§ threat
// model 문서), rename 직전에 한번 더 재확인하면(pre-promotion revalidation) 그 창을 최대한
// 좁힐 수 있다. rename 직후에는 최종 대상을 다시 확인해(post-promotion 검증) race가 실제로
// 일어났다면 "성공"으로 조용히 보고하지 않는다 — 이미 일어난 rename을 되돌릴 수는
// 없으므로 이것은 prevention이 아니라 detection이다.
function writeJsonAtomic(targetPath: string, data: unknown, projectRootReal?: string): { ok: true } | { ok: false; detail: string } {
  const parentDir = dirname(targetPath);
  let tmp: string | undefined;
  try {
    mkdirSync(parentDir, { recursive: true });
    if (projectRootReal !== undefined) {
      const parentReal = realpathSync(parentDir);
      if (!isRealPathWithin(parentReal, projectRootReal)) {
        return { ok: false, detail: `파일 저장 실패(${targetPath}): 부모 디렉터리가 project root 밖을 가리킵니다.` };
      }
      // containment(위)만으로는 "root 내부의 다른 위치를 가리키는 symlink"를 잡지 못한다
      // (§ assertNoSymlinkInChain 상단 주석) — parentDir 자체가 symlink/junction이면
      // 목적지와 무관하게 구조적으로 거부한다.
      const chainCheck = assertNoSymlinkInChain(parentDir, projectRootReal);
      if (!chainCheck.ok) return { ok: false, detail: `파일 저장 실패(${targetPath}): ${chainCheck.detail}` };
    }
    tmp = `${targetPath}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
    // Windows에서는 읽기 전용("r")으로 연 핸들의 fsync가 EPERM으로 실패하는 경우가 있다
    // (실제로 이 환경에서 재현 확인) — "r+"(읽기/쓰기, 파일이 이미 존재해야 함)로 열어
    // POSIX/Windows 양쪽에서 안전하게 동작하게 한다. 방금 writeFileSync로 만든 파일이라
    // 항상 존재한다.
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (projectRootReal !== undefined && existsSync(targetPath)) {
      const targetLstat = lstatSync(targetPath);
      if (targetLstat.isSymbolicLink()) {
        const targetReal = realpathSync(targetPath);
        if (!isRealPathWithin(targetReal, projectRootReal)) {
          throw new Error(`대상 경로(${targetPath})가 project root 밖을 가리키는 symlink로 바뀌었습니다.`);
        }
      }
    }
    // pre-promotion revalidation — write(위)와 promote(아래 renameSync) 사이에 parentDir가
    // symlink로 교체됐을 가능성을 rename 직전에 한 번 더 좁혀서 재확인한다.
    if (projectRootReal !== undefined) {
      const parentRealBeforeRename = realpathSync(parentDir);
      if (!isRealPathWithin(parentRealBeforeRename, projectRootReal)) {
        throw new Error(`부모 디렉터리(${parentDir})가 write 도중 project root 밖을 가리키도록 바뀌었습니다.`);
      }
      const preRenameChainCheck = assertNoSymlinkInChain(parentDir, projectRootReal);
      if (!preRenameChainCheck.ok) throw new Error(preRenameChainCheck.detail);
    }
    renameSync(tmp, targetPath);
    tmp = undefined;
    // post-promotion 검증(destination swap detection 가능한 범위) — prevention이 아니라
    // detection이다. rename 자체는 이미 일어났으므로 되돌릴 수 없지만, 최종 대상이 예상과
    // 다르면(regular file이 아니거나 root 밖) 이 write를 "성공"으로 조용히 보고하지 않는다.
    if (projectRootReal !== undefined) {
      const postLstat = lstatSync(targetPath);
      if (!postLstat.isFile()) {
        return { ok: false, detail: `파일 저장 실패(${targetPath}): write 이후 재확인에서 대상이 regular file이 아닙니다(가능한 race 탐지).` };
      }
      const postReal = realpathSync(targetPath);
      if (!isRealPathWithin(postReal, projectRootReal)) {
        return { ok: false, detail: `파일 저장 실패(${targetPath}): write 이후 재확인에서 대상이 project root 밖을 가리킵니다(가능한 race 탐지).` };
      }
    }
    return { ok: true };
  } catch (e) {
    if (tmp !== undefined) {
      try {
        unlinkSync(tmp);
      } catch {
        // 정리 실패는 원래 오류를 덮지 않는다 — 아래에서 원래 오류만 보고한다.
      }
    }
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
// 신뢰된 입력 확인 — SI-2가 남긴 파일시스템 결과만 신뢰 입력으로 쓴다. SI-3와 동일, 변경 없음.
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
  | "PLANNER_STATE_SCHEMA_MIGRATION_UNSUPPORTED"
  | "UNRECOGNIZED_MASTER_SPEC_SECTION"
  | "RAW_OUTPUT_SOURCE_FAILED"
  | "GENERATED_DATA_INVALID"
  | "STATE_WRITE_FAILED"
  | "CONCURRENT_PLANNER_RUN_IN_PROGRESS"
  // SI-3.7(Execution Contract Closure) — 하나 이상의 requiredTest가 최종 execution-policy +
  // Core Command Safety + Trusted Executable Resolution을 통과할 수 없다(§ execution-
  // contract.ts validateRequiredTestExecutionContract). READY_FOR_AUTODEV/
  // HUMAN_REVIEW_REQUIRED를 만들지 않고 항상 이 코드로 중단한다.
  | "REQUIRED_TEST_NOT_EXECUTABLE";

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

// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차, HIGH) — bootstrap-state.json/
// master-spec/manifest.json/spec.md는 SI-2(project-bootstrap.ts)가 남긴 산출물이라
// "신뢰 입력"으로 취급되지만, 이 함수는 그동안 existsSync+readFileSync만 썼다(symlink/
// project root 밖 escape 방어 없음) — planner-state.json/생성된 3개 실행 데이터 파일에는
// 이미 적용된 readTrustedGeneratedFile()(symlink 거부 + realpath containment)을 여기서도
// 재사용해 동일한 신뢰 경계를 적용한다(로직 복제 없음).
function evaluateTrustedPlannerInput(projectRoot: string, projectRootReal: string, expectedIdentity: BootstrapRequestIdentity): TrustedInputResult {
  const bootstrapStatePath = join(projectRoot, ".autodev", "bootstrap-state.json");
  const bootstrapStateRead = readTrustedGeneratedFile(bootstrapStatePath, projectRootReal);
  if (!bootstrapStateRead.ok) {
    return { ok: false, code: "BOOTSTRAP_STATE_MISSING_OR_CORRUPT", detail: `bootstrap-state.json을 신뢰할 수 있게 읽지 못했습니다: ${bootstrapStateRead.detail}` };
  }
  let bootstrapState: unknown;
  try {
    bootstrapState = JSON.parse(bootstrapStateRead.content);
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
  const manifestRead = readTrustedGeneratedFile(manifestPath, projectRootReal);
  if (!manifestRead.ok) {
    return { ok: false, code: "MASTER_SPEC_MANIFEST_MISSING_OR_CORRUPT", detail: `master-spec/manifest.json을 신뢰할 수 있게 읽지 못했습니다: ${manifestRead.detail}` };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestRead.content);
  } catch {
    return { ok: false, code: "MASTER_SPEC_MANIFEST_MISSING_OR_CORRUPT", detail: "master-spec/manifest.json을 읽거나 파싱할 수 없습니다." };
  }
  if (!isValidMasterSpecManifestShape(manifest)) {
    return { ok: false, code: "MASTER_SPEC_MANIFEST_MISSING_OR_CORRUPT", detail: "master-spec/manifest.json 형식이 올바르지 않습니다." };
  }
  const m = manifest as MasterSpecManifestShape;

  const specRead = readTrustedGeneratedFile(specPath, projectRootReal);
  if (!specRead.ok) {
    return { ok: false, code: "MASTER_SPEC_CONTENT_UNREADABLE", detail: `master-spec/spec.md를 신뢰할 수 있게 읽지 못했습니다: ${specRead.detail}` };
  }
  const specContent = specRead.content;
  const actualHash = createHash(m.storedContentDigest.algorithm).update(specContent, "utf8").digest("hex");
  if (actualHash !== m.storedContentDigest.hash || m.specIntegrity.hash.toLowerCase() !== m.storedContentDigest.hash) {
    return {
      ok: false,
      code: "MASTER_SPEC_DIGEST_MISMATCH",
      detail: "master-spec/spec.md의 실제 digest가 보존된 storedContentDigest와 일치하지 않습니다 — 변조가 의심되어 중단합니다.",
    };
  }
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
  /** 최소 Observability(§ 요구사항 14) — stage/phaseId/attempt/promptLength/elapsedMs/
   *  transportResult/validationResult만 담는다. secret/raw sensitive 값은 전달되지
   *  않는다. 지정하지 않으면 아무 것도 기록하지 않는다(과도한 신규 subsystem을 만들지
   *  않는다). */
  onDiagnostic?: (event: PlannerDiagnosticEvent) => void;
}

export type PlannerOutcome =
  | { status: "BLOCKED"; code: PlannerBlockedCode; detail: string }
  | { status: "CONFLICT"; detail: string; existingIdentity: BootstrapRequestIdentity; requestedIdentity: BootstrapRequestIdentity }
  | { status: "REJECTED"; issues: PlannerValidationIssue[] }
  | {
      // Fixed Constraint가 하나라도 있으면(HOW가 그 constraint를 실제로 지키는지는 이
      // Validator가 기계적으로 검증할 수 없으므로) status 자체가 절대 "READY_FOR_AUTODEV"/
      // "ALREADY_READY"가 아니라 "HUMAN_REVIEW_REQUIRED"가 된다. fixedConstraints가 없는
      // (드문) 경우에만 기존과 동일하게 READY_FOR_AUTODEV(최초 완료)/ALREADY_READY(재실행)를
      // 쓴다.
      status: "READY_FOR_AUTODEV" | "ALREADY_READY" | "HUMAN_REVIEW_REQUIRED";
      projectRoot: string;
      plannerStatePath: string;
      projectManifestPath: string;
      taskRegistryPath: string;
      executionPolicyPath: string;
      firstRunnableTask: TaskDefinition | null;
      fixedConstraintComplianceNote: string | null;
    };

// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 재검증, HIGH) — 이전에는
// lstatSync(path) → realpathSync(path) → readFileSync(path) 세 번 모두 각자 경로를 다시
// 해석했다 — 각 호출 사이의 아주 짧은 창에서 경로가 symlink로 교체되면, 앞선 두 검사가
// 통과한 "안전한 대상"과 실제로 읽는 대상이 달라질 수 있다(전형적인 다단계 TOCTOU). 실제
// 읽기(readFileSync)는 이제 open()이 반환한 파일 디스크립터에서 수행한다 — fd는 open() 호출
// 그 순간 커널이 확정한 대상에 고정되므로, 그 이후 경로가 무엇으로 바뀌든 이 fd를 통한 읽기
// 결과 자체는 바뀌지 않는다(open~read 사이의 경로 교체를 무력화). 또한 지원되는 플랫폼
// (대부분의 POSIX)에서는 O_NOFOLLOW로 열어 대상이 symlink이면 open() 자체가 fail-closed로
// 실패하게 한다 — Windows는 이 플래그를 신뢰할 수 있게 강제하지 못하는 것으로 알려져 있어
// (Node/libuv가 Windows에서 O_NOFOLLOW를 이식성 있게 보장하지 않음), 그 경우에도 fd 확보
// 이후의 read는 여전히 open 시점에 고정된 대상만 반환한다는 방어는 유지된다. lstat 기반
// symlink 거부와 realpath 기반 containment 확인은 그대로 유지하되(정책적으로 symlink 자체를
// 거부하고 project root 밖 대상을 거부하는 목적), 이 두 검사와 실제 파일 open 사이에 남는
// "open 자체가 무엇을 가리킬지"의 창은 표준 Node.js fs API만으로는(네이티브 addon 없이는)
// 완전히 없앨 수 없다는 사실을 그대로 남긴다 — 이 함수는 그 잔여 창을 최소화하는 최선의
// portable 구현이다(요구사항: 새로운 네이티브 의존성 추가 없이 해결).
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
  // SI-3.5 — containment(위)만으로는 "root 내부의 다른 위치를 가리키는 symlink"를 잡지
  // 못한다(§ assertNoSymlinkInChain 상단 주석). filePath 자체는 이미 위에서 symlink가
  // 아님을 확인했지만(lstat), 그 조상 디렉터리들은 아직 확인하지 않았다 — 여기서 함께
  // 확인한다.
  const chainCheck = assertNoSymlinkInChain(filePath, projectRootReal);
  if (!chainCheck.ok) return { ok: false, detail: chainCheck.detail };
  let fd: number;
  try {
    // Windows에서는 O_NOFOLLOW가 이식성 있게 강제되지 않는 것으로 알려져 있어(§ 위 주석)
    // POSIX에서만 사용한다 — Windows에서도 아래 fd 기반 read 자체는 여전히 open 시점에
    // 고정된 대상만 반환하므로 이중 방어 중 하나가 빠질 뿐, read의 정확성은 유지된다.
    const openFlags = process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    fd = openSync(filePath, openFlags);
  } catch (e) {
    return { ok: false, detail: `파일 열기 실패(${filePath}): ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    const fdStat = fstatSync(fd);
    if (!fdStat.isFile()) {
      return { ok: false, detail: `${filePath}(open 이후 재확인)가 일반 파일이 아닙니다.` };
    }
    return { ok: true, content: readFileSync(fd, "utf-8") };
  } catch (e) {
    return { ok: false, detail: `파일 읽기 실패(${filePath}): ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // close 실패는 이미 확보한 결과에 영향 없음 — 무시한다.
    }
  }
}

// GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 재검증, HIGH) — 부분 실패/신뢰 입력 변경
// 감지 시 정리(cleanup)를 위한 unlinkSync(path) 호출은 경로를 그대로 다시 해석한다 — write
// 시점 이후 `.autodev`가 project root 밖을 가리키는 symlink/junction으로 교체되면, 이
// cleanup 코드가 writeJsonAtomic()이 write 시점에 이미 강제한 containment 보호를 우회해
// project root 밖의 파일을 삭제할 수 있다. 삭제 직전에도 동일한 containment를 재확인하고,
// 그 사이 대상이 project root 밖으로 바뀐 것으로 보이면 삭제를 포기한다(파일을 남기는 쪽이
// project root 밖 파일을 실수로 지우는 것보다 안전하다 — generation.json이 쓰이지 않으므로
// 다음 실행이 어차피 GENERATED_DATA_INVALID로 이 상태를 다시 잡는다).
function safeUnlinkWithinRoot(filePath: string, projectRootReal: string): void {
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) return; // symlink 자체는 삭제 대상으로 신뢰하지 않는다.
    const real = realpathSync(filePath);
    if (!isRealPathWithin(real, projectRootReal)) return;
    unlinkSync(filePath);
  } catch {
    // 대상이 이미 없거나 확인할 수 없으면 아무것도 하지 않는다 — 원래 실패만 보고된다.
  }
}

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

    // § 위 generationManifestPath 주석 — 3개 파일이 서로 다른 generation에서 부분적으로만
    // 갱신된 채 섞이지 않았는지 재확인한다. 이 파일이 없거나 해시가 실제 내용과 다르면 부분
    // 실패로 간주해 즉시 실패 처리한다(어떤 필드도 조용히 신뢰하지 않는다).
    const generationFile = readTrustedGeneratedFile(generationManifestPath(projectRoot), projectRootReal);
    if (!generationFile.ok) return { ok: false, detail: `generation.json을 신뢰할 수 있게 읽지 못했습니다(3개 실행 데이터 파일의 generation 일관성을 확인할 수 없습니다): ${generationFile.detail}` };
    let generationManifest: unknown;
    try {
      generationManifest = JSON.parse(generationFile.content);
    } catch {
      return { ok: false, detail: "generation.json이 올바른 JSON이 아닙니다." };
    }
    if (!isValidGenerationManifestShape(generationManifest)) {
      return { ok: false, detail: "generation.json 형식이 올바르지 않습니다." };
    }
    if (
      sha256Hex(manifestFileRaw.content) !== generationManifest.manifestSha256 ||
      sha256Hex(taskRegistryFile.content) !== generationManifest.taskRegistrySha256 ||
      sha256Hex(executionPolicyFile.content) !== generationManifest.executionPolicySha256
    ) {
      return {
        ok: false,
        detail: "project-manifest.json/task-registry.json/execution-policy.json 중 일부가 generation.json이 기록한 해시와 일치하지 않습니다 — 서로 다른 generation이 섞였을 수 있어(부분 write 실패 의심) 신뢰하지 않습니다.",
      };
    }

    const taskRegistry = JSON.parse(taskRegistryFile.content) as TaskDefinition[];
    const executionPolicy = JSON.parse(executionPolicyFile.content) as ProjectExecutionPolicy;
    const manifestFile = JSON.parse(manifestFileRaw.content) as PersistedProjectManifestFile;

    // GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 재검증, HIGH) — write 직전/직후
    // 재검증만으로는 "그 사이의 아주 짧은 창" 논쟁이 근본적으로 끝나지 않는다(여러 독립 파일에
    // 걸친 진짜 원자적 트랜잭션은 표준 파일시스템 API로 만들 수 없다 — 요구사항: 과도한 새
    // transaction framework 금지). 대신 "매번 다시 읽을 때(reload) 원본 신뢰 소스와 대조"하는
    // 방식으로 전환한다 — 이 함수는 EXECUTION_DATA_GENERATED→VALIDATED 전이 시점뿐 아니라
    // COMPLETED 이후 모든 재실행(readyOutcome, § 요구사항 "idempotent 재확인")에서도 항상
    // 호출되므로, "실행 도중 마지막 순간에 바뀜"과 "COMPLETED 이후 나중에 바뀜"(더 실질적인
    // 위험 — spec.md가 완료 후 다시 수정됐는데 오래된 생성물을 계속 신뢰하는 경우) 둘 다
    // 이 지점에서 매번 다시 잡는다. manifestFile.sourceSpecIntegrity(생성 시점에 검증한
    // digest)를 신뢰하지 않고, 지금 이 순간의 master-spec/spec.md를 다시 읽어(동일한
    // readTrustedGeneratedFile containment) 직접 재계산한 digest와 대조한다.
    if (!structuralGuard(manifestFile.sourceSpecIntegrity)) {
      return { ok: false, detail: "manifestFile.sourceSpecIntegrity 형식이 올바르지 않습니다." };
    }
    const sourceSpecIntegrity = manifestFile.sourceSpecIntegrity as unknown as Record<string, unknown>;
    const algorithm = sourceSpecIntegrity.algorithm;
    const expectedHash = sourceSpecIntegrity.hash;
    if ((algorithm !== "sha256" && algorithm !== "sha512") || typeof expectedHash !== "string" || expectedHash.length === 0) {
      return { ok: false, detail: "manifestFile.sourceSpecIntegrity의 algorithm/hash 형식이 올바르지 않습니다." };
    }
    const specPath = join(projectRoot, ".autodev", "master-spec", "spec.md");
    const specFile = readTrustedGeneratedFile(specPath, projectRootReal);
    if (!specFile.ok) {
      return { ok: false, detail: `master-spec/spec.md를 신뢰할 수 있게 다시 읽지 못했습니다(생성물이 여전히 유효한 spec을 반영하는지 확인할 수 없습니다): ${specFile.detail}` };
    }
    const liveSpecHash = createHash(algorithm).update(specFile.content, "utf8").digest("hex");
    if (liveSpecHash !== expectedHash.toLowerCase()) {
      return {
        ok: false,
        detail: "master-spec/spec.md의 현재 내용이 이 생성물이 생성될 때 검증한 digest와 더 이상 일치하지 않습니다 — spec이 그 사이(또는 완료 이후) 바뀐 것으로 보여 이 생성물을 신뢰하지 않습니다.",
      };
    }

    const manifest = assembleProjectManifest({ manifestFile, taskRegistry, executionPolicy });
    validateProjectManifest(manifest);
    validateProjectExecutionPolicy(executionPolicy, projectId);
    // SI-3.7 — 저장된 task-registry.json의 requiredTests가 저장된 execution-policy.json의
    // allowedCommands와 여전히 정확히 일치하는지 매 resume/idempotent 재확인마다 다시
    // 검증한다. 이 함수는 EXECUTION_DATA_GENERATED→VALIDATED 전이, COMPLETED 이후 모든
    // idempotent 재실행(readyOutcome)에서 항상 호출되므로, 이 Task 이전 코드가 만든 오래된
    // checkpoint(예: 기존 JARVIS COMPLETED 산출물)를 포함해 어떤 generation이든 이 계약을
    // 위반하면 조용히 READY_FOR_AUTODEV/HUMAN_REVIEW_REQUIRED로 흘려보내지 않는다.
    const executionContractIssuesOnReload = validateRequiredTestExecutionContract(
      taskRegistry.map((t) => ({ taskId: t.id, requiredTests: t.requiredTests })),
      executionPolicy.commandCwdAliases,
      executionPolicy.allowedCommands
    );
    if (executionContractIssuesOnReload.length > 0) {
      return {
        ok: false,
        detail: `저장된 task-registry.json/execution-policy.json이 Required Test Execution Contract를 통과하지 못했습니다: ${describeExecutionContractIssues(executionContractIssuesOnReload)}`,
      };
    }
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
 * SI-2가 완료한 projectRoot를 대상으로 Incremental Planner를 실행한다 — projectRoot/.autodev/
 * 아래의 Bootstrap 산출물만 신뢰 입력으로 재검증하고(§ evaluateTrustedPlannerInput), 통과하면
 * Master Spec을 정규화(WHAT)한 뒤 STAGE 1(ARCHITECTURE) → STAGE 2(PHASE PLAN) →
 * STAGE 3(TASK PLAN, Phase별) → STAGE 4(GLOBAL TRACEABILITY) → STAGE 5(FINAL ASSEMBLY)
 * 순서로 진행한다. 각 stage는 독립적인 checkpoint를 가지며, 중간 실패 후 재호출하면 마지막으로
 * 성공한 stage/Phase부터 이어서 진행한다(resume-safe) — 이미 검증을 통과한 stage는
 * rawOutputSource를 다시 호출하지 않는다.
 *
 * 실제 작업은 runPlannerLocked()가 담당하고, 이 함수는 그 앞뒤로 projectId 단위 Project
 * Lock(project-lock.ts)만 얹는다(SI-3와 동일).
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
  // SI-3.5 — statSync(위)는 symlink를 따라가므로 resolvedRoot 자체가 디렉터리를 가리키는
  // symlink/junction이어도 통과한다. project root 자체는(§ threat model 문서) 어떤 방향을
  // 가리키든 symlink일 수 없다.
  if (lstatSync(resolvedRoot).isSymbolicLink()) {
    return { status: "BLOCKED", code: "INVALID_PROJECT_ROOT", detail: `projectRoot 자체가 symlink/junction/reparse point입니다: ${resolvedRoot}` };
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
  let projectRootIdentity: { dev: number; ino: number };
  try {
    projectRootReal = realpathSync(resolvedRoot);
    // GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 재검증, HIGH) — realpath 문자열
    // 비교만으로는 "같은 경로에 원래 디렉터리를 rename으로 치우고 identical해 보이는 새
    // 디렉터리를 그 자리에 설치"하는 공격을 잡지 못한다(symlink가 전혀 없으면 realpath는
    // 경로 문자열을 그대로 반환할 뿐 그 밑의 실제 파일시스템 객체(inode)가 바뀌었는지는
    // 보지 않는다). dev+ino(파일시스템 고유 식별자)를 함께 캡처해, write 직전 재확인
    // 시점에 실제로 같은 디렉터리 객체인지(경로 문자열이 아니라) 대조한다.
    const rootStat = statSync(projectRootReal);
    projectRootIdentity = { dev: rootStat.dev, ino: rootStat.ino };
  } catch (e) {
    return { status: "BLOCKED", code: "INVALID_PROJECT_ROOT", detail: `projectRoot realpath 확인 실패: ${e instanceof Error ? e.message : String(e)}` };
  }

  const trustedInputResult = evaluateTrustedPlannerInput(resolvedRoot, projectRootReal, expectedIdentity);
  if (!trustedInputResult.ok) {
    return { status: "BLOCKED", code: trustedInputResult.code, detail: trustedInputResult.detail };
  }
  const { identity, projectName, specContent } = trustedInputResult.input;

  const normalized = normalizeMasterSpec(specContent);
  if (normalized.unrecognizedHeaders.length > 0) {
    return {
      status: "BLOCKED",
      code: "UNRECOGNIZED_MASTER_SPEC_SECTION",
      detail: `Master Spec에 알려지지 않은 "## " 섹션 헤더가 있어 WHAT이 조용히 누락될 위험이 있습니다: ${normalized.unrecognizedHeaders.join(", ")}`,
    };
  }
  const hasFixedConstraints = normalized.fixedConstraints.length > 0;

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

  const stateRead = readPlannerState(resolvedRoot, projectRootReal);
  if (stateRead.kind === "corrupt") {
    return { status: "BLOCKED", code: "PLANNER_STATE_CORRUPT", detail: stateRead.detail };
  }
  if (stateRead.kind === "unsupported_migration") {
    return { status: "BLOCKED", code: "PLANNER_STATE_SCHEMA_MIGRATION_UNSUPPORTED", detail: stateRead.detail };
  }

  let cur: PlannerStateFile;
  if (stateRead.kind === "absent") {
    cur = { schemaVersion: PLANNER_STATE_SCHEMA_VERSION, identity, stage: "SPEC_VERIFIED", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const w = writeJsonAtomic(plannerStateFilePath(resolvedRoot), cur, projectRootReal);
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
  const rawOutputSource = config.rawOutputSource ?? createClaudeCliRawOutputSource({ excludedRoots: [resolvedRoot] });
  const nowIso = () => new Date().toISOString();
  const persist = (next: PlannerStateFile): { ok: true } | { ok: false; detail: string } => writeJsonAtomic(plannerStateFilePath(resolvedRoot), next, projectRootReal);

  if (cur.stage === "SPEC_VERIFIED") {
    cur = { ...cur, stage: "REQUIREMENTS_NORMALIZED", updatedAt: nowIso() };
    const w = persist(cur);
    if (!w.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: w.detail };
  }

  // STAGE 1 — ARCHITECTURE.
  if (cur.stage === "REQUIREMENTS_NORMALIZED") {
    const outcome = await runLlmStage(
      rawOutputSource,
      "ARCHITECTURE",
      undefined,
      () => buildArchitecturePrompt(normalized, identity),
      (issues) => buildArchitectureCorrectionPrompt(normalized, identity, issues),
      (rawText) => validateArchitectureRawOutput(rawText, normalized, identity),
      config.onDiagnostic
    );
    if (outcome.kind === "transport_failed") {
      return { status: "BLOCKED", code: "RAW_OUTPUT_SOURCE_FAILED", detail: outcome.detail };
    }
    if (outcome.kind === "rejected") {
      const rejectWrite = persist({ ...cur, lastValidationIssues: outcome.issues, lastValidationContext: { stage: "ARCHITECTURE" }, updatedAt: nowIso() });
      if (!rejectWrite.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: rejectWrite.detail };
      return { status: "REJECTED", issues: outcome.issues };
    }
    cur = { ...cur, architecture: outcome.value, stage: "ARCHITECTURE_PLANNED", lastValidationIssues: undefined, updatedAt: nowIso() };
    const w = persist(cur);
    if (!w.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: w.detail };
  }

  // STAGE 2 — PHASE PLAN.
  if (cur.stage === "ARCHITECTURE_PLANNED") {
    if (!cur.architecture) {
      return { status: "BLOCKED", code: "PLANNER_STATE_CORRUPT", detail: "stage=ARCHITECTURE_PLANNED인데 architecture가 저장돼 있지 않습니다." };
    }
    const resumedArchIssues = validateResumedArchitecture(cur.architecture, normalized, identity);
    if (resumedArchIssues.length > 0) {
      return {
        status: "BLOCKED",
        code: "PLANNER_STATE_CORRUPT",
        detail: `저장된 architecture checkpoint가 신뢰할 수 없는 내용을 담고 있습니다: ${resumedArchIssues.map((i) => i.code).join(", ")}`,
      };
    }
    const architecture = cur.architecture;
    const outcome = await runLlmStage(
      rawOutputSource,
      "PHASE_PLAN",
      undefined,
      () => buildPhasePlanPrompt(normalized, identity, architecture),
      (issues) => buildPhasePlanCorrectionPrompt(normalized, identity, architecture, issues),
      (rawText) => validatePhasePlanRawOutput(rawText, normalized, identity),
      config.onDiagnostic
    );
    if (outcome.kind === "transport_failed") {
      return { status: "BLOCKED", code: "RAW_OUTPUT_SOURCE_FAILED", detail: outcome.detail };
    }
    if (outcome.kind === "rejected") {
      const rejectWrite = persist({ ...cur, lastValidationIssues: outcome.issues, lastValidationContext: { stage: "PHASE_PLAN" }, updatedAt: nowIso() });
      if (!rejectWrite.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: rejectWrite.detail };
      return { status: "REJECTED", issues: outcome.issues };
    }
    cur = { ...cur, phasePlan: outcome.value, stage: "PHASE_PLANNED", lastValidationIssues: undefined, updatedAt: nowIso() };
    const w = persist(cur);
    if (!w.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: w.detail };
  }

  // STAGE 3 — TASK PLAN(Phase별). 이미 완료된 Phase는 건너뛰고(resume), 각 Phase마다
  // 완료 즉시 checkpoint한다 — 뒤 Phase의 transport 실패/REJECTED가 앞선 Phase를 재호출시키지
  // 않는다.
  if (cur.stage === "PHASE_PLANNED") {
    if (!cur.architecture || !cur.phasePlan) {
      return { status: "BLOCKED", code: "PLANNER_STATE_CORRUPT", detail: "stage=PHASE_PLANNED인데 architecture/phasePlan이 저장돼 있지 않습니다." };
    }
    // GPT Independent Reviewer 지적(SI-3.3 REVISE 2회차, HIGH) — 이 블록은 architecture를
    // Task Plan LLM 프롬프트에 그대로 담아 외부로 보낸다(§ buildPhaseTaskPrompt). resume이
    // ARCHITECTURE_PLANNED 블록을 거치지 않고 이 stage로 곧장 들어올 수 있어(예: 이전 실행이
    // PHASE_PLANNED까지 이미 진행한 뒤 중단됨), 여기서 실제로 프롬프트를 만들기 전에 반드시
    // architecture와 phasePlan(+이미 확정된 phaseTaskPlans, 다음 프롬프트의 "이미 확정된 task"
    // 컨텍스트로 쓰인다)을 재검증한다 — secret-shaped 값이 검증 전에 외부로 유출되는 것을
    // 막는다(§ validateResumedArchitecture/validateResumedPhasePlanAndKnownTasks 상단 주석).
    const resumedArchIssuesAtPhasePlanned = validateResumedArchitecture(cur.architecture, normalized, identity);
    if (resumedArchIssuesAtPhasePlanned.length > 0) {
      return {
        status: "BLOCKED",
        code: "PLANNER_STATE_CORRUPT",
        detail: `저장된 architecture checkpoint가 신뢰할 수 없는 내용을 담고 있습니다: ${resumedArchIssuesAtPhasePlanned.map((i) => i.code).join(", ")}`,
      };
    }
    const resumedPhaseIssues = validateResumedPhasePlanAndKnownTasks(cur.phasePlan, cur.phaseTaskPlans ?? {}, normalized);
    if (resumedPhaseIssues.length > 0) {
      return {
        status: "BLOCKED",
        code: "PLANNER_STATE_CORRUPT",
        detail: `저장된 phasePlan/phaseTaskPlans checkpoint가 신뢰할 수 없는 내용을 담고 있습니다: ${resumedPhaseIssues.map((i) => i.code).join(", ")}`,
      };
    }
    const architecture = cur.architecture;
    const orderedPhases = [...cur.phasePlan].sort((a, b) => Number(a.phaseId) - Number(b.phaseId));
    let phaseTaskPlans: Record<string, PlannerRawTask[]> = { ...(cur.phaseTaskPlans ?? {}) };

    for (const phase of orderedPhases) {
      if (phaseTaskPlans[phase.phaseId]) continue;

      const knownTasksFlat = Object.values(phaseTaskPlans).flat();
      const knownTaskIds = new Set(knownTasksFlat.map((t) => t.taskId));
      const knownTasks = knownTasksFlat.map((t) => ({ taskId: t.taskId, title: t.title }));
      const priorPhases = orderedPhases.filter((p) => Number(p.phaseId) < Number(phase.phaseId));

      const outcome = await runLlmStage(
        rawOutputSource,
        "TASK_PLAN",
        phase.phaseId,
        () => buildPhaseTaskPrompt(normalized, identity, architecture, phase, priorPhases, knownTasks),
        (issues) => buildPhaseTaskCorrectionPrompt(normalized, identity, architecture, phase, priorPhases, knownTasks, issues),
        (rawText) => {
          const validated = validatePhaseTaskRawOutput(rawText, normalized, identity, phase, knownTaskIds);
          if (!validated.ok) return validated;
          const contractIssues = validateRequiredTestExecutionContract(
            toRequiredTestOwners(validated.value),
            architecture.executionPolicy.commandCwdAliases
          );
          if (contractIssues.length > 0) {
            return {
              ok: false as const,
              issues: contractIssues.map((i) => ({
                code: "REQUIRED_TEST_NOT_EXECUTABLE" as const,
                detail: i.reason,
              })),
            };
          }
          return validated;
        },
        config.onDiagnostic
      );
      if (outcome.kind === "transport_failed") {
        return { status: "BLOCKED", code: "RAW_OUTPUT_SOURCE_FAILED", detail: outcome.detail };
      }
      if (outcome.kind === "rejected") {
        cur = { ...cur, phaseTaskPlans, lastValidationIssues: outcome.issues, lastValidationContext: { stage: "TASK_PLAN", phaseId: phase.phaseId }, updatedAt: nowIso() };
        const rejectWrite = persist(cur);
        if (!rejectWrite.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: rejectWrite.detail };
        return { status: "REJECTED", issues: outcome.issues };
      }
      phaseTaskPlans = { ...phaseTaskPlans, [phase.phaseId]: outcome.value };
      cur = { ...cur, phaseTaskPlans, lastValidationIssues: undefined, updatedAt: nowIso() };
      const w = persist(cur);
      if (!w.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: w.detail };
    }

    cur = { ...cur, stage: "TASKS_PLANNED", updatedAt: nowIso() };
    const w = persist(cur);
    if (!w.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: w.detail };
  }

  // STAGE 4 — GLOBAL TRACEABILITY(deterministic, LLM 없음).
  if (cur.stage === "TASKS_PLANNED") {
    if (!cur.phasePlan || !cur.phaseTaskPlans) {
      return { status: "BLOCKED", code: "PLANNER_STATE_CORRUPT", detail: "stage=TASKS_PLANNED인데 phasePlan/phaseTaskPlans가 저장돼 있지 않습니다." };
    }
    let allTasks: PlannerRawTask[];
    try {
      allTasks = flattenPhaseTaskPlans(cur.phasePlan, cur.phaseTaskPlans);
    } catch (e) {
      return { status: "BLOCKED", code: "PLANNER_STATE_CORRUPT", detail: e instanceof Error ? e.message : String(e) };
    }
    const issues = validateGlobalTraceability(normalized, cur.phasePlan, allTasks);
    if (issues.length > 0) {
      const rejectWrite = persist({ ...cur, lastValidationIssues: issues, lastValidationContext: { stage: "TRACEABILITY" }, updatedAt: nowIso() });
      if (!rejectWrite.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: rejectWrite.detail };
      return { status: "REJECTED", issues };
    }
    cur = { ...cur, stage: "TRACEABILITY_VALIDATED", lastValidationIssues: undefined, updatedAt: nowIso() };
    const w = persist(cur);
    if (!w.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: w.detail };
  }

  // STAGE 5 — FINAL ASSEMBLY(deterministic, LLM 없음) — SI-3의 나머지 파이프라인(Core
  // 재검증 + write-직전 재확인 + 3개 파일 원자적 저장)을 그대로 재사용한다.
  if (cur.stage === "TRACEABILITY_VALIDATED") {
    if (!cur.architecture || !cur.phasePlan || !cur.phaseTaskPlans) {
      return { status: "BLOCKED", code: "PLANNER_STATE_CORRUPT", detail: "stage=TRACEABILITY_VALIDATED인데 architecture/phasePlan/phaseTaskPlans가 저장돼 있지 않습니다." };
    }
    // resume이 ARCHITECTURE_PLANNED 블록을 거치지 않고 이 stage로 곧장 들어올 수 있으므로
    // (예: 이전 실행이 TASKS_PLANNED/TRACEABILITY_VALIDATED까지 이미 진행한 뒤 중단됨) 여기서도
    // 독립적으로 재검증한다(§ validateResumedArchitecture 상단 주석).
    const resumedArchIssuesAtAssembly = validateResumedArchitecture(cur.architecture, normalized, identity);
    if (resumedArchIssuesAtAssembly.length > 0) {
      return {
        status: "BLOCKED",
        code: "PLANNER_STATE_CORRUPT",
        detail: `저장된 architecture checkpoint가 신뢰할 수 없는 내용을 담고 있습니다: ${resumedArchIssuesAtAssembly.map((i) => i.code).join(", ")}`,
      };
    }
    // GPT Independent Reviewer 지적(SI-3.3 REVISE 2회차, HIGH) — resume이 TASKS_PLANNED
    // 블록(STAGE 4)을 거치지 않고 이 stage로 곧장 들어올 수 있다(예: stage가 이미
    // TRACEABILITY_VALIDATED로 저장된 뒤 phasePlan/phaseTaskPlans만 직접 변조됨). architecture만
    // 재검증하고 넘어가면 unknown/dangling REQ·AC, deferred/out-of-scope 승격, taskId/phaseId
    // 불일치, coverage 누락, task 사이클 등이 최종 조립까지 그대로 통과한다 —
    // buildTaskRegistry()가 reqIds/acceptanceCriteria/dependsOn 상당수를 그대로 옮기지 않아
    // downstream(Core project-manifest/execution-policy validator)도 이를 복구해 잡지 못한다.
    // final assembly 직전에 STAGE 4 전체를 다시 실행해, 위반이 있으면 REJECTED(재시도 유도)가
    // 아니라 BLOCKED(PLANNER_STATE_CORRUPT)로 처리한다 — 이 시점의 위반은 새 LLM 응답을 받아서
    // 고칠 문제가 아니라 checkpoint 자체의 신뢰 문제이기 때문이다.
    let allTasksAtAssembly: PlannerRawTask[];
    try {
      allTasksAtAssembly = flattenPhaseTaskPlans(cur.phasePlan, cur.phaseTaskPlans);
    } catch (e) {
      return { status: "BLOCKED", code: "PLANNER_STATE_CORRUPT", detail: e instanceof Error ? e.message : String(e) };
    }
    const traceabilityIssuesAtAssembly = validateGlobalTraceability(normalized, cur.phasePlan, allTasksAtAssembly);
    if (traceabilityIssuesAtAssembly.length > 0) {
      return {
        status: "BLOCKED",
        code: "PLANNER_STATE_CORRUPT",
        detail: `저장된 phasePlan/phaseTaskPlans checkpoint가 Global Traceability 재검증을 통과하지 못했습니다: ${traceabilityIssuesAtAssembly.map((i) => i.code).join(", ")}`,
      };
    }
    // SI-3.7 — Required Test Execution Contract(§ execution-contract.ts). 모든 task의 모든
    // requiredTest가 실제로 실행 가능한 구조인지(Core Command Safety Gate/cwd alias 유효성)를
    // 여기서 deterministic하게 재검증한다 — 통과하지 못하면 최종 executionPolicy를 만들기
    // 전에 즉시 BLOCKED한다(§ .claude/CLAUDE.md "requiredTests에 적혀 있다는 이유만으로 위험한
    // 명령을 자동 허용하면 안 된다" — Core-supported capability validation이 항상 먼저다).
    const executionContractIssuesAtAssembly = validateRequiredTestExecutionContract(
      toRequiredTestOwners(allTasksAtAssembly),
      cur.architecture.executionPolicy.commandCwdAliases
    );
    if (executionContractIssuesAtAssembly.length > 0) {
      return {
        status: "BLOCKED",
        code: "REQUIRED_TEST_NOT_EXECUTABLE",
        detail: `저장된 phaseTaskPlans의 requiredTests가 Required Test Execution Contract를 통과하지 못했습니다: ${describeExecutionContractIssues(executionContractIssuesAtAssembly)}`,
      };
    }
    let manifest: ProjectManifest;
    let generated: ReturnType<typeof buildGeneratedExecutionData>;
    try {
      const allTasks = flattenPhaseTaskPlans(cur.phasePlan, cur.phaseTaskPlans);
      const raw = synthesizeLegacyRawOutput(identity, cur.architecture, cur.phasePlan, allTasks);
      generated = buildGeneratedExecutionData(raw, normalized, identity, projectName, resolvedRoot, now);
      manifest = assembleProjectManifest(generated);
      validateProjectManifest(manifest);
      validateProjectExecutionPolicy(generated.executionPolicy, identity.projectId);
      // 위 buildExecutionPolicy()가 requiredTests로부터 allowedCommands를 파생/병합했으므로
      // 아래는 구성상 항상 통과해야 하는 tautology 재확인이다(defense-in-depth — 파생 로직
      // 자체의 회귀를 잡기 위함이지, 새로운 실패 모드를 기대하는 것이 아니다).
      const finalContractIssues = validateRequiredTestExecutionContract(
        toRequiredTestOwners(allTasks),
        generated.executionPolicy.commandCwdAliases,
        generated.executionPolicy.allowedCommands
      );
      if (finalContractIssues.length > 0) {
        throw new Error(
          `재조립된 executionPolicy.allowedCommands가 자체 Required Test Execution Contract 최종 검증을 통과하지 못했습니다: ${describeExecutionContractIssues(finalContractIssues)}`
        );
      }
    } catch (e) {
      return { status: "BLOCKED", code: "GENERATED_DATA_INVALID", detail: `생성된 실행 데이터가 Core 검증을 통과하지 못했습니다: ${e instanceof Error ? e.message : String(e)}` };
    }

    // 이 시점 이전에 여러 번의 긴 비동기 대기(각 stage의 rawOutputSource 호출, 실제 LLM이면
    // 수십~수백 초씩 여러 번)가 있었다. 그 사이 project root/.autodev가 symlink로 교체됐을
    // 가능성에 대비해 실제 write 직전에 containment를 다시 확인한다.
    let projectRootRealNow: string;
    try {
      projectRootRealNow = realpathSync(resolvedRoot);
    } catch (e) {
      return { status: "BLOCKED", code: "PROJECT_ROOT_ESCAPE", detail: `write 직전 project root 재확인 실패: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (projectRootRealNow !== projectRootReal) {
      return { status: "BLOCKED", code: "PROJECT_ROOT_ESCAPE", detail: "project root의 실제 대상이 처리 도중 바뀐 것으로 보여 안전하게 중단했습니다." };
    }
    // § 위 projectRootIdentity 캡처 주석 — 경로 문자열이 같아도 그 사이 원래 디렉터리가
    // rename되고 같은 경로에 다른 디렉터리가 새로 설치됐을 수 있다(symlink 없이도 가능).
    // dev+ino로 실제 같은 파일시스템 객체인지 재확인한다.
    let projectRootIdentityNow: { dev: number; ino: number };
    try {
      const rootStatNow = statSync(projectRootRealNow);
      projectRootIdentityNow = { dev: rootStatNow.dev, ino: rootStatNow.ino };
    } catch (e) {
      return { status: "BLOCKED", code: "PROJECT_ROOT_ESCAPE", detail: `write 직전 project root 객체 재확인 실패: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (projectRootIdentityNow.dev !== projectRootIdentity.dev || projectRootIdentityNow.ino !== projectRootIdentity.ino) {
      return {
        status: "BLOCKED",
        code: "PROJECT_ROOT_ESCAPE",
        detail: "project root 경로 문자열은 같지만 실제 파일시스템 객체(inode)가 실행 도중 바뀐 것으로 보여 안전하게 중단했습니다.",
      };
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

    // GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차, HIGH) — project lock(acquireProjectLock)이
    // 실제로 막는 race와, 그것으로 막을 수 없는 위험을 구분해서 검토했다:
    // (a) "동시에 실행되는 다른 runPlanner() 호출"이 같은 project root의 checkpoint/생성
    //     파일을 동시에 쓰는 race — runPlanner()가 lock을 잡은 채로 runPlannerLocked
    //     전체(모든 LLM stage await 포함)를 감싸므로 완전히 제거된다(같은/다른 프로세스의
    //     두 번째 runPlanner() 호출은 CONCURRENT_PLANNER_RUN_IN_PROGRESS로 즉시 거부).
    // (b) runPlannerLocked 자신이 planner-state.json을 externally tamper당하는 race —
    //     이 파일은 stage가 바뀔 때마다 항상 cur 전체를 다시 write하는 "완전 덮어쓰기"
    //     모델이라(부분 merge 없음), 매 LLM stage 호출 직후에는 어차피 그 결과로 다시
    //     전체를 write한다 — 외부에서 그 사이에 무엇을 쓰더라도 다음 정상 write가 그대로
    //     덮어쓴다. 그리고 stage가 이미 TRACEABILITY_VALIDATED 이상으로 resume되는
    //     경로(§ 위 STAGE 5 블록)는 이 지점까지 오는 동안 추가 LLM await 자체가 없어(모든
    //     재검증이 동기적으로 이어짐) 그 사이에 끼어들 틈이 구조적으로 없다 — 별도
    //     방어를 추가해도 실제로 도달 불가능한 코드가 되므로 만들지 않는다.
    // (c) lock이 막지 "못하는" 것은 runPlanner() 경로를 거치지 않는 bootstrap-state.json/
    //     master-spec/spec.md에 대한 외부 변경이다 — 이 파일들은 evaluateTrustedPlannerInput()
    //     이 실행 시작 시 한 번만 읽고 이후 다시 읽지 않으므로, 이 프로세스가 LLM 응답을
    //     기다리는 수십~수백 초 동안 사람/다른 도구가 이 파일들을 직접 편집해도 원래는
    //     끝까지 감지되지 않았다. 되돌릴 수 없는 최종 write 직전인 이 지점에서
    //     evaluateTrustedPlannerInput()을 처음부터 다시 실행해(로직 복제 없음) 그 사이
    //     bootstrap-state/manifest/spec.md가 여전히 이 실행이 시작할 때와 동일한 identity를
    //     신뢰할 수 있는 상태인지 확인한다 — 어긋나면 결과를 덮어쓰지 않고 BLOCKED한다.
    const revalidatedTrustedInput = evaluateTrustedPlannerInput(resolvedRoot, projectRootRealNow, expectedIdentity);
    if (!revalidatedTrustedInput.ok) {
      return {
        status: "BLOCKED",
        code: revalidatedTrustedInput.code,
        detail: `write 직전 재검증 실패(실행 도중 신뢰 입력이 바뀐 것으로 의심됨): ${revalidatedTrustedInput.detail}`,
      };
    }
    if (!identitiesMatch(revalidatedTrustedInput.input.identity, identity)) {
      return {
        status: "BLOCKED",
        code: "EXPECTED_IDENTITY_MISMATCH",
        detail: "write 직전 재검증한 identity가 이 실행이 시작할 때 확인한 identity와 다릅니다 — 실행 도중 신뢰 입력이 바뀐 것으로 보여 중단합니다.",
      };
    }
    // GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 재검증, HIGH) — identitiesMatch()는
    // handoffId/projectId/specVersion/specIntegrity만 비교한다. projectName은
    // BootstrapRequestIdentity에 없는 별도 필드라(manifest.json에만 있음) 이 비교에
    // 포함되지 않았다 — spec 내용/식별자는 그대로인데 manifest.json의 projectName만 바뀌면
    // 최종 생성물의 developerInstructions/reviewInstructions 등에 다른 프로젝트 이름이
    // 그대로 반영될 수 있었다. 최초 신뢰 입력에서 캡처한 projectName과도 함께 대조한다.
    if (revalidatedTrustedInput.input.projectName !== projectName) {
      return {
        status: "BLOCKED",
        code: "EXPECTED_IDENTITY_MISMATCH",
        detail: "write 직전 재검증한 projectName이 이 실행이 시작할 때 확인한 projectName과 다릅니다 — 실행 도중 신뢰 입력이 바뀐 것으로 보여 중단합니다.",
      };
    }

    // GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 재검증, MEDIUM) — 이전에는 배열
    // literal(`[writeJsonAtomic(...), writeJsonAtomic(...), writeJsonAtomic(...)]`)이 세
    // 호출을 모두 즉시 평가해, 첫 번째가 실패해도 나머지를 계속 썼다(불필요한 부분 갱신).
    // 순서대로 실행해 첫 실패에서 즉시 멈추고, 그때까지 이미 쓴 파일은 정리(삭제)한다 —
    // generation.json이 아직 쓰이지 않았으므로 다음 실행은 어차피 GENERATED_DATA_INVALID로
    // 이 상태를 다시 잡지만(§ generationManifestPath 주석), 불필요한 부분 갱신 파일을
    // 남기지 않는 편이 더 안전하다.
    const writeSteps: Array<{ path: string; data: unknown }> = [
      { path: generatedManifestPath(resolvedRoot), data: generated.manifestFile },
      { path: generatedTaskRegistryPath(resolvedRoot), data: generated.taskRegistry },
      { path: generatedExecutionPolicyPath(resolvedRoot), data: generated.executionPolicy },
    ];
    const writtenSoFar: string[] = [];
    let writeFailure: { ok: false; detail: string } | undefined;
    for (const step of writeSteps) {
      const w = writeJsonAtomic(step.path, step.data, projectRootRealNow);
      if (!w.ok) {
        writeFailure = w;
        break;
      }
      writtenSoFar.push(step.path);
    }
    if (writeFailure) {
      for (const p of writtenSoFar) {
        safeUnlinkWithinRoot(p, projectRootRealNow);
      }
      return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: writeFailure.detail };
    }

    // § generationManifestPath 상단 주석 — 3개 파일이 모두 성공적으로 쓰인 "직후"에만 이
    // 파일을 쓴다. 실제로 디스크에 쓰인 내용을 다시 읽어 해시하므로(재구성된 값이 아니라)
    // 이 시점 이후 어떤 이유로든 다시 읽었을 때 실제 파일과의 불일치는 곧 "이 3개가 이
    // generation.json이 기록한 것과 다른 상태로 바뀌었다"는 뜻이 된다.
    const writtenManifest = readTrustedGeneratedFile(generatedManifestPath(resolvedRoot), projectRootRealNow);
    const writtenTaskRegistry = readTrustedGeneratedFile(generatedTaskRegistryPath(resolvedRoot), projectRootRealNow);
    const writtenExecutionPolicy = readTrustedGeneratedFile(generatedExecutionPolicyPath(resolvedRoot), projectRootRealNow);
    if (!writtenManifest.ok || !writtenTaskRegistry.ok || !writtenExecutionPolicy.ok) {
      return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: "write 직후 생성된 파일을 신뢰할 수 있게 재확인하지 못했습니다." };
    }

    // GPT Independent Reviewer 지적(SI-3.3 REVISE 3회차 재검증, HIGH) — 위 write 직전
    // 재검증과 실제 3개 파일 write 사이에도(비록 그 사이에 await은 없지만, 실제 디스크 I/O가
    // 걸리는 동안 다른 프로세스가 파일을 바꿀 수 있는 여지가 있다) 여전히 이론적인 TOCTOU
    // 창이 남는다 — 여러 개의 독립된 파일에 걸친 진짜 원자적 트랜잭션은 표준 파일시스템
    // API로 만들 수 없다(요구사항: 과도한 새 transaction framework 금지). "이 3개 파일을
    // COMPLETED로 확정해도 되는가"의 최종 관문인 generation.json/stage 전이 직전에 한 번 더
    // 같은 재검증을 반복해 그 창을 최대한 좁힌다 — 여기서 실패하면 이미 쓴 3개 파일이
    // 신뢰할 수 없는 입력을 반영한 채로 남지 않도록 정리(삭제)를 시도한 뒤 BLOCKED한다
    // (삭제 자체가 실패해도 stage는 EXECUTION_DATA_GENERATED로 전진시키지 않으므로, 다음
    // 실행이 generation.json 부재로 GENERATED_DATA_INVALID를 통해 이 상태를 다시 잡는다 —
    // § generationManifestPath 상단 주석과 동일한 방어선을 재사용).
    const revalidatedTrustedInputBeforePublish = evaluateTrustedPlannerInput(resolvedRoot, projectRootRealNow, expectedIdentity);
    // § 위 write 직전 재검증의 projectName 비교 주석과 동일한 이유로 여기서도 함께 대조한다.
    const identityStillMatches =
      revalidatedTrustedInputBeforePublish.ok &&
      identitiesMatch(revalidatedTrustedInputBeforePublish.input.identity, identity) &&
      revalidatedTrustedInputBeforePublish.input.projectName === projectName;
    if (!identityStillMatches) {
      for (const p of [generatedManifestPath(resolvedRoot), generatedTaskRegistryPath(resolvedRoot), generatedExecutionPolicyPath(resolvedRoot)]) {
        safeUnlinkWithinRoot(p, projectRootRealNow);
      }
      return {
        status: "BLOCKED",
        code: revalidatedTrustedInputBeforePublish.ok ? "EXPECTED_IDENTITY_MISMATCH" : revalidatedTrustedInputBeforePublish.code,
        detail: "생성 파일 write 직후 재검증한 신뢰 입력이 이 실행이 시작할 때와 다릅니다 — 실행 도중 신뢰 입력이 바뀐 것으로 보여 방금 쓴 파일을 정리하고 중단합니다.",
      };
    }

    const generationManifest: GenerationManifest = {
      generationId: randomUUID(),
      manifestSha256: sha256Hex(writtenManifest.content),
      taskRegistrySha256: sha256Hex(writtenTaskRegistry.content),
      executionPolicySha256: sha256Hex(writtenExecutionPolicy.content),
    };
    const generationWrite = writeJsonAtomic(generationManifestPath(resolvedRoot), generationManifest, projectRootRealNow);
    if (!generationWrite.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: generationWrite.detail };

    cur = { ...cur, stage: "EXECUTION_DATA_GENERATED", updatedAt: nowIso() };
    const w = persist(cur);
    if (!w.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: w.detail };
  }

  if (cur.stage === "EXECUTION_DATA_GENERATED") {
    const reloaded = reloadAndValidateGeneratedData(resolvedRoot, identity.projectId);
    if (!reloaded.ok) {
      return { status: "BLOCKED", code: "GENERATED_DATA_INVALID", detail: `저장된 실행 데이터 재확인 실패: ${reloaded.detail}` };
    }
    cur = { ...cur, stage: "EXECUTION_DATA_VALIDATED", updatedAt: nowIso() };
    const w = persist(cur);
    if (!w.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: w.detail };
  }

  if (cur.stage === "EXECUTION_DATA_VALIDATED") {
    cur = { ...cur, stage: "COMPLETED", updatedAt: nowIso() };
    const w = persist(cur);
    if (!w.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: w.detail };
  }

  return readyOutcome("FRESH", resolvedRoot, identity.projectId, hasFixedConstraints);
}

// =========================================================================
// SI-3.7 — EXECUTION_CONTRACT_REASSEMBLY.
// =========================================================================
//
// runPlannerLocked()의 "stage === COMPLETED" 분기(§ 위 runPlannerLocked 앞부분)는 곧장
// readyOutcome("IDEMPOTENT", ...)로 이어진다 — reloadAndValidateGeneratedData()가 이제 새
// Required Test Execution Contract를 재검증하므로(§ 위 함수 안의 SI-3.7 추가분), 이 Task
// 이전 코드가 만든 오래된 COMPLETED checkpoint(예: 기존 JARVIS 산출물)를 대상으로 다시
// runPlanner()를 호출하면 이제 조용히 통과하지 않고 BLOCKED(GENERATED_DATA_INVALID)로
// 정확히 막힌다 — 이것만으로 EP-1/EP-2를 "탐지"하기에는 충분하지만, Architecture/Phase/
// Task LLM을 다시 호출하지 않고 그 checkpoint를 "고치는" 명시적 경로는 아니다.
//
// reassembleExecutionContract()가 그 경로다: 이미 COMPLETED된 checkpoint의
// architecture/phasePlan/phaseTaskPlans(LLM 산출물)는 그대로 재사용하고(재호출 없음),
// execution 계약 레이어(project-manifest.json/task-registry.json/execution-policy.json/
// generation.json)만 SI-3.7의 새 deterministic 로직(buildExecutionPolicy의 derive/merge +
// validateRequiredTestExecutionContract)으로 다시 조립한다. planner-state.json의 stage는
// COMPLETED로 유지되며 이 함수는 그 값을 바꾸지 않는다 — 이미 완료된 상태를 조용히
// 되돌리거나 재전이시키지 않는다. 명시적으로 이 함수가 호출됐을 때만 동작하는 opt-in
// migration 경로다(§ .claude/CLAUDE.md "명시적 EXECUTION_CONTRACT_REASSEMBLY") — 어떤
// 자동 트리거도 이 함수를 대신 호출하지 않는다.
//
// stage!==COMPLETED(아직 진행 중이거나 시작 전)인 project는 이 함수의 대상이 아니다 —
// 일반 runPlanner()가 이어서 진행하면 final assembly 시점에 어차피 동일한 Execution
// Contract 검증을 거친다(§ 위 runPlannerLocked TRACEABILITY_VALIDATED 블록). 이 함수는
// runPlannerLocked의 초기 신뢰 입력 검증(project root 안전성/bootstrap 신뢰 경계/identity
// 대조)을 동일하게 반복한다 — 코드는 의도적으로 병렬(로직 복제)이지 리팩터링으로 공유
// 경로를 새로 만들지 않았다: runPlannerLocked는 이미 여러 차례의 bounded GPT Independent
// Review를 거친 security-critical 함수라, 이 Task 범위에서 그 함수의 제어 흐름 자체를
// 바꾸는 리스크를 지지 않기 위함이다(§ 요구사항 "Core-wide 예상 외 변경이 필요하면 임의
// 확대하지 말고 BLOCKED STOP").

export type ExecutionContractReassemblyOutcome =
  | { status: "BLOCKED"; code: PlannerBlockedCode; detail: string }
  | { status: "CONFLICT"; detail: string; existingIdentity: BootstrapRequestIdentity; requestedIdentity: BootstrapRequestIdentity }
  | { status: "REASSEMBLY_NOT_APPLICABLE"; detail: string }
  | {
      status: "EXECUTION_CONTRACT_REASSEMBLED";
      projectRoot: string;
      plannerStatePath: string;
      projectManifestPath: string;
      taskRegistryPath: string;
      executionPolicyPath: string;
      firstRunnableTask: TaskDefinition | null;
      fixedConstraintComplianceNote: string | null;
    };

function reassembleExecutionContractLocked(
  resolvedRoot: string,
  expectedIdentity: BootstrapRequestIdentity,
  config: PlannerTrustedConfig
): ExecutionContractReassemblyOutcome {
  let projectRootReal: string;
  let projectRootIdentity: { dev: number; ino: number };
  try {
    projectRootReal = realpathSync(resolvedRoot);
    // § runPlannerLocked의 동일 목적 캡처(위 "projectRootIdentity" 주석)와 동일한 이유 —
    // 경로 문자열만으로는 "같은 경로에 원래 디렉터리가 rename되고 다른 디렉터리가 새로
    // 설치됨"을 잡지 못한다. dev+ino를 write 직전 재확인의 기준으로 여기서 캡처한다.
    const rootStat = statSync(projectRootReal);
    projectRootIdentity = { dev: rootStat.dev, ino: rootStat.ino };
  } catch (e) {
    return { status: "BLOCKED", code: "INVALID_PROJECT_ROOT", detail: `projectRoot realpath 확인 실패: ${e instanceof Error ? e.message : String(e)}` };
  }

  const trustedInputResult = evaluateTrustedPlannerInput(resolvedRoot, projectRootReal, expectedIdentity);
  if (!trustedInputResult.ok) {
    return { status: "BLOCKED", code: trustedInputResult.code, detail: trustedInputResult.detail };
  }
  const { identity, projectName, specContent } = trustedInputResult.input;
  const normalized = normalizeMasterSpec(specContent);
  if (normalized.unrecognizedHeaders.length > 0) {
    return {
      status: "BLOCKED",
      code: "UNRECOGNIZED_MASTER_SPEC_SECTION",
      detail: `Master Spec에 알려지지 않은 "## " 섹션 헤더가 있어 WHAT이 조용히 누락될 위험이 있습니다: ${normalized.unrecognizedHeaders.join(", ")}`,
    };
  }
  const hasFixedConstraints = normalized.fixedConstraints.length > 0;

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

  const stateRead = readPlannerState(resolvedRoot, projectRootReal);
  if (stateRead.kind === "corrupt") {
    return { status: "BLOCKED", code: "PLANNER_STATE_CORRUPT", detail: stateRead.detail };
  }
  if (stateRead.kind === "unsupported_migration") {
    return { status: "BLOCKED", code: "PLANNER_STATE_SCHEMA_MIGRATION_UNSUPPORTED", detail: stateRead.detail };
  }
  if (stateRead.kind === "absent") {
    return { status: "REASSEMBLY_NOT_APPLICABLE", detail: "planner-state.json이 없습니다 — 재조립할 완료된 checkpoint가 없습니다." };
  }
  const cur = stateRead.state;
  if (!identitiesMatch(cur.identity, identity)) {
    return { status: "CONFLICT", detail: "같은 project root에 다른 identity(specVersion/specIntegrity 등)의 Planner 상태가 이미 존재합니다.", existingIdentity: cur.identity, requestedIdentity: identity };
  }
  if (cur.stage !== "COMPLETED") {
    return {
      status: "REASSEMBLY_NOT_APPLICABLE",
      detail: `현재 stage(${cur.stage})가 COMPLETED가 아닙니다 — 일반 runPlanner()로 이어서 진행하세요(final assembly에서 동일한 Execution Contract 검증을 거칩니다).`,
    };
  }
  // stage=COMPLETED 불변식(§ isPlannerStageArtifactInvariantSatisfied)이 architecture/
  // phasePlan/phaseTaskPlans 존재를 이미 보장하지만, 방어적으로 다시 확인한다.
  if (!cur.architecture || !cur.phasePlan || !cur.phaseTaskPlans) {
    return { status: "BLOCKED", code: "PLANNER_STATE_CORRUPT", detail: "stage=COMPLETED인데 architecture/phasePlan/phaseTaskPlans가 저장돼 있지 않습니다." };
  }
  // bounded code-review 지적(HIGH) — runPlannerLocked()의 TRACEABILITY_VALIDATED 진입
  // 직전(§ 위 resumedArchIssuesAtPhasePlanned)과 동일하게, 이 함수도 cur.architecture를 곧장
  // 신뢰해 쓰기 전에 반드시 재검증해야 한다. validateGlobalTraceability(아래)는
  // phasePlan/allTasks만 재검증할 뿐 architecture 자체(secret-shaped 값/projectId·
  // specVersion 불일치/변조된 fixedConstraintAcknowledgement/안전하지 않은 executionPolicy
  // 등)는 검사하지 않는다 — 이 재검증 없이는 tampered planner-state.json이 runPlanner()에서는
  // BLOCKED(PLANNER_STATE_CORRUPT)로 잡히던 것이 이 별도 진입점에서는 그대로 통과할 수 있었다.
  const resumedArchIssues = validateResumedArchitecture(cur.architecture, normalized, identity);
  if (resumedArchIssues.length > 0) {
    return {
      status: "BLOCKED",
      code: "PLANNER_STATE_CORRUPT",
      detail: `저장된 architecture checkpoint가 신뢰할 수 없는 내용을 담고 있습니다: ${resumedArchIssues.map((i) => i.code).join(", ")}`,
    };
  }

  let allTasks: PlannerRawTask[];
  try {
    allTasks = flattenPhaseTaskPlans(cur.phasePlan, cur.phaseTaskPlans);
  } catch (e) {
    return { status: "BLOCKED", code: "PLANNER_STATE_CORRUPT", detail: e instanceof Error ? e.message : String(e) };
  }
  const traceabilityIssues = validateGlobalTraceability(normalized, cur.phasePlan, allTasks);
  if (traceabilityIssues.length > 0) {
    return {
      status: "BLOCKED",
      code: "PLANNER_STATE_CORRUPT",
      detail: `저장된 phasePlan/phaseTaskPlans checkpoint가 Global Traceability 재검증을 통과하지 못했습니다: ${traceabilityIssues.map((i) => i.code).join(", ")}`,
    };
  }
  const contractIssues = validateRequiredTestExecutionContract(toRequiredTestOwners(allTasks), cur.architecture.executionPolicy.commandCwdAliases);
  if (contractIssues.length > 0) {
    return {
      status: "BLOCKED",
      code: "REQUIRED_TEST_NOT_EXECUTABLE",
      detail: `저장된 phaseTaskPlans의 requiredTests가 Required Test Execution Contract를 통과하지 못했습니다: ${describeExecutionContractIssues(contractIssues)}`,
    };
  }

  const now = config.now ? config.now() : new Date();
  let manifest: ProjectManifest;
  let generated: ReturnType<typeof buildGeneratedExecutionData>;
  try {
    const raw = synthesizeLegacyRawOutput(identity, cur.architecture, cur.phasePlan, allTasks);
    generated = buildGeneratedExecutionData(raw, normalized, identity, projectName, resolvedRoot, now);
    manifest = assembleProjectManifest(generated);
    validateProjectManifest(manifest);
    validateProjectExecutionPolicy(generated.executionPolicy, identity.projectId);
    const finalContractIssues = validateRequiredTestExecutionContract(
      toRequiredTestOwners(allTasks),
      generated.executionPolicy.commandCwdAliases,
      generated.executionPolicy.allowedCommands
    );
    if (finalContractIssues.length > 0) {
      throw new Error(`재조립된 executionPolicy.allowedCommands가 자체 Required Test Execution Contract 최종 검증을 통과하지 못했습니다: ${describeExecutionContractIssues(finalContractIssues)}`);
    }
  } catch (e) {
    return { status: "BLOCKED", code: "GENERATED_DATA_INVALID", detail: `재조립된 실행 데이터가 Core 검증을 통과하지 못했습니다: ${e instanceof Error ? e.message : String(e)}` };
  }

  // write 직전 재검증 — runPlannerLocked의 동일 목적 재검증(§ 위 "write 직전 재확인 재검증"
  // 주석)과 동일한 이유: LLM stage 없이도 evaluateTrustedPlannerInput() 자체가 파일 I/O를
  // 하므로, 그 사이 신뢰 입력이 바뀌지 않았는지 되돌릴 수 없는 최종 write 직전에 다시 확인한다.
  const revalidated = evaluateTrustedPlannerInput(resolvedRoot, projectRootReal, expectedIdentity);
  if (!revalidated.ok) {
    return { status: "BLOCKED", code: revalidated.code, detail: `write 직전 재검증 실패(실행 도중 신뢰 입력이 바뀐 것으로 의심됨): ${revalidated.detail}` };
  }
  if (!identitiesMatch(revalidated.input.identity, identity) || revalidated.input.projectName !== projectName) {
    return { status: "BLOCKED", code: "EXPECTED_IDENTITY_MISMATCH", detail: "write 직전 재검증한 신뢰 입력이 이 실행이 시작할 때와 다릅니다 — 실행 도중 신뢰 입력이 바뀐 것으로 보여 중단합니다." };
  }
  // bounded code-review 지적(HIGH) — 위 evaluateTrustedPlannerInput() 재검증만으로는
  // "project root 경로 문자열은 같지만 실제 파일시스템 객체(inode)가 바뀜"(rename 후 같은
  // 경로에 새 디렉터리 설치, symlink 없이도 가능)까지는 잡지 못한다 — runPlannerLocked의
  // write-guard(§ 위 projectRootIdentityNow)와 동일하게 realpath+dev/ino를 다시 파생해
  // 재확인한다(캡처해둔 값을 재사용하지 않는다).
  let projectRootRealNow: string;
  try {
    projectRootRealNow = realpathSync(resolvedRoot);
  } catch (e) {
    return { status: "BLOCKED", code: "PROJECT_ROOT_ESCAPE", detail: `write 직전 project root 재확인 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (projectRootRealNow !== projectRootReal) {
    return { status: "BLOCKED", code: "PROJECT_ROOT_ESCAPE", detail: "project root의 실제 대상이 처리 도중 바뀐 것으로 보여 안전하게 중단했습니다." };
  }
  let projectRootIdentityNow: { dev: number; ino: number };
  try {
    const rootStatNow = statSync(projectRootRealNow);
    projectRootIdentityNow = { dev: rootStatNow.dev, ino: rootStatNow.ino };
  } catch (e) {
    return { status: "BLOCKED", code: "PROJECT_ROOT_ESCAPE", detail: `write 직전 project root 객체 재확인 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (projectRootIdentityNow.dev !== projectRootIdentity.dev || projectRootIdentityNow.ino !== projectRootIdentity.ino) {
    return {
      status: "BLOCKED",
      code: "PROJECT_ROOT_ESCAPE",
      detail: "project root 경로 문자열은 같지만 실제 파일시스템 객체(inode)가 실행 도중 바뀐 것으로 보여 안전하게 중단했습니다.",
    };
  }

  const writeSteps: Array<{ path: string; data: unknown }> = [
    { path: generatedManifestPath(resolvedRoot), data: generated.manifestFile },
    { path: generatedTaskRegistryPath(resolvedRoot), data: generated.taskRegistry },
    { path: generatedExecutionPolicyPath(resolvedRoot), data: generated.executionPolicy },
  ];
  const writtenSoFar: string[] = [];
  let writeFailure: { ok: false; detail: string } | undefined;
  for (const step of writeSteps) {
    const w = writeJsonAtomic(step.path, step.data, projectRootRealNow);
    if (!w.ok) {
      writeFailure = w;
      break;
    }
    writtenSoFar.push(step.path);
  }
  if (writeFailure) {
    for (const p of writtenSoFar) safeUnlinkWithinRoot(p, projectRootRealNow);
    return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: writeFailure.detail };
  }

  const writtenManifest = readTrustedGeneratedFile(generatedManifestPath(resolvedRoot), projectRootRealNow);
  const writtenTaskRegistry = readTrustedGeneratedFile(generatedTaskRegistryPath(resolvedRoot), projectRootRealNow);
  const writtenExecutionPolicy = readTrustedGeneratedFile(generatedExecutionPolicyPath(resolvedRoot), projectRootRealNow);
  if (!writtenManifest.ok || !writtenTaskRegistry.ok || !writtenExecutionPolicy.ok) {
    return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: "write 직후 재조립된 파일을 신뢰할 수 있게 재확인하지 못했습니다." };
  }

  const revalidatedBeforePublish = evaluateTrustedPlannerInput(resolvedRoot, projectRootRealNow, expectedIdentity);
  const identityStillMatches =
    revalidatedBeforePublish.ok && identitiesMatch(revalidatedBeforePublish.input.identity, identity) && revalidatedBeforePublish.input.projectName === projectName;
  if (!identityStillMatches) {
    for (const p of [generatedManifestPath(resolvedRoot), generatedTaskRegistryPath(resolvedRoot), generatedExecutionPolicyPath(resolvedRoot)]) {
      safeUnlinkWithinRoot(p, projectRootRealNow);
    }
    return {
      status: "BLOCKED",
      code: revalidatedBeforePublish.ok ? "EXPECTED_IDENTITY_MISMATCH" : revalidatedBeforePublish.code,
      detail: "재조립 파일 write 직후 재검증한 신뢰 입력이 이 실행이 시작할 때와 다릅니다 — 실행 도중 신뢰 입력이 바뀐 것으로 보여 방금 쓴 파일을 정리하고 중단합니다.",
    };
  }

  const generationManifest: GenerationManifest = {
    generationId: randomUUID(),
    manifestSha256: sha256Hex(writtenManifest.content),
    taskRegistrySha256: sha256Hex(writtenTaskRegistry.content),
    executionPolicySha256: sha256Hex(writtenExecutionPolicy.content),
  };
  const generationWrite = writeJsonAtomic(generationManifestPath(resolvedRoot), generationManifest, projectRootRealNow);
  if (!generationWrite.ok) return { status: "BLOCKED", code: "STATE_WRITE_FAILED", detail: generationWrite.detail };

  // planner-state.json 자체는 건드리지 않는다 — stage는 이미 COMPLETED였고 그대로 COMPLETED다
  // (재전이 없음, § 파일 상단 설명).
  const reloaded = reloadAndValidateGeneratedData(resolvedRoot, identity.projectId);
  if (!reloaded.ok) {
    return { status: "BLOCKED", code: "GENERATED_DATA_INVALID", detail: `재조립 직후 재확인 실패: ${reloaded.detail}` };
  }

  return {
    status: "EXECUTION_CONTRACT_REASSEMBLED",
    projectRoot: resolvedRoot,
    plannerStatePath: plannerStateFilePath(resolvedRoot),
    projectManifestPath: generatedManifestPath(resolvedRoot),
    taskRegistryPath: generatedTaskRegistryPath(resolvedRoot),
    executionPolicyPath: generatedExecutionPolicyPath(resolvedRoot),
    firstRunnableTask: getNextTask(reloaded.taskRegistry, []),
    fixedConstraintComplianceNote: reloaded.manifestFile.fixedConstraintComplianceNote,
  };
}

/**
 * 이미 COMPLETED된 Planner checkpoint의 execution 계약 레이어(project-manifest.json/
 * task-registry.json/execution-policy.json/generation.json)만 SI-3.7의 새 deterministic
 * Required Test Execution Contract로 재조립한다 — Architecture/Phase/Task LLM은 다시
 * 호출하지 않는다(§ 파일 상단 설명). runPlanner()와 동일하게 projectId 단위 Project Lock
 * 위에서 실행된다.
 */
export async function reassembleExecutionContract(
  projectRoot: string,
  expectedIdentity: BootstrapRequestIdentity,
  config: PlannerTrustedConfig = {}
): Promise<ExecutionContractReassemblyOutcome> {
  const resolvedRoot = resolve(projectRoot);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    return { status: "BLOCKED", code: "INVALID_PROJECT_ROOT", detail: `projectRoot가 존재하지 않거나 디렉터리가 아닙니다: ${resolvedRoot}` };
  }
  if (lstatSync(resolvedRoot).isSymbolicLink()) {
    return { status: "BLOCKED", code: "INVALID_PROJECT_ROOT", detail: `projectRoot 자체가 symlink/junction/reparse point입니다: ${resolvedRoot}` };
  }
  const lockAcquire = acquireProjectLock({ projectId: expectedIdentity.projectId, targetProjectRoot: resolvedRoot, ownerKind: "autodev" });
  if (!lockAcquire.ok) {
    return { status: "BLOCKED", code: "CONCURRENT_PLANNER_RUN_IN_PROGRESS", detail: `${lockAcquire.reason} (code=${lockAcquire.code})` };
  }
  try {
    return reassembleExecutionContractLocked(resolvedRoot, expectedIdentity, config);
  } finally {
    releaseProjectLock(lockAcquire.lock);
  }
}
