import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { bootstrapProject } from "./project-bootstrap";
import type { BootstrapTrustedConfig, BootstrapOutcome } from "./project-bootstrap";
import type { BootstrapRequestIdentity } from "./project-bootstrap";
import { evaluateSpecIntake } from "./spec-intake";
import { PROJECT_LOCK_SCHEMA_VERSION, RUNTIME_LOCK_DIR, resolveCanonicalProjectPath, debugComputeLockFilePath } from "./project-lock";
import type { ProjectLockMetadata } from "./project-lock";
import {
  runPlanner,
  normalizeMasterSpec,
  validatePlannerRawOutput,
  buildPlannerPrompt,
  createClaudeCliRawOutputSource,
} from "./spec-planner";
import type { PlannerRawOutput, PlannerRawOutputSource, NormalizedMasterSpec, PlannerOutcome } from "./spec-planner";
import type { TaskDefinition } from "./task-registry";

// Planner → AutoDev Execution Data Synthesis + E2E 테스트(SI-3). 이 파일은 실제
// JARVIS/MOVAN/BILLION 프로젝트를 전혀 만들지 않는다 — 모든 시나리오는 OS 임시 디렉터리
// (mkdtempSync) 안의 disposable fixture만 쓰고, main() 마지막에 전부 정리한다. AutoDev
// Core 저장소(automation/ 자체) 안에는 어떤 파일도 만들지 않는다.
//
// SI-1(evaluateSpecIntake)/SI-2(bootstrapProject)를 mock하지 않고 실제로 호출해 진짜
// APPROVED Master Spec → SI-1 → SI-2 → SI-3 흐름을 검증한다(§ 요구사항 13 Disposable E2E).
// validatePlannerRawOutput()의 개별 위반 규칙(10~21)은 runPlanner()를 통해 end-to-end로
// 검증한다 — normalize/validate 로직을 테스트에서 따로 재구현하지 않는다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}
function skip(label: string): void {
  results.push(`[SKIP] ${label}`);
}

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

const COMMIT_IDENTITY = { name: "AutoDev SI-3 Test", email: "si3-test@example.invalid" };

// ---------------------------------------------------------------------------
// Master Spec 본문 fixture — SECTION_SPECS 관례(normalizeMasterSpec)를 따른다.
// REQ-001/002만 must-have, AC-001/002, FC-001(fixed_decision)/FC-002(explicit_constraint),
// DEF-001, OOS-001.
// ---------------------------------------------------------------------------
const FIXTURE_FC_001_TEXT = "The database provider is PostgreSQL and must not be changed.";
const FIXTURE_FC_002_TEXT = "No paid third-party services may be used without human approval.";

function buildMasterSpecContent(): string {
  return [
    "## Project Goal",
    "Deterministic fixture project goal text for SI-3 E2E testing.",
    "",
    "## Product Scope",
    "Fixture product scope text.",
    "",
    "## Must-have Requirements",
    "- Users can create an account.",
    "- Users can reset their password.",
    "",
    "## Functional Requirements",
    "- The system logs each login attempt.",
    "",
    "## Non-functional Requirements",
    "- The system responds within 500ms for read APIs.",
    "",
    "## Security Requirements",
    "- All passwords are hashed with bcrypt.",
    "",
    "## Privacy Requirements",
    "- User email addresses are never shared with third parties.",
    "",
    "## Data Requirements",
    "- User records are stored in a relational database.",
    "",
    "## External Integrations",
    "- The system sends transactional email via a third-party provider.",
    "",
    "## User / Role Requirements",
    "- Only admins can delete accounts.",
    "",
    "## Performance Requirements",
    "- The system supports 100 concurrent users.",
    "",
    "## Platform Requirements",
    "- The system runs on Node.js 20+.",
    "",
    "## Acceptance Criteria",
    "- A new user can sign up and immediately log in.",
    "- A user who forgot their password can reset it via email.",
    "",
    "## Fixed Decisions",
    `- ${FIXTURE_FC_001_TEXT}`,
    "",
    "## Deferred Items",
    "- Multi-factor authentication is deferred to a later phase.",
    "",
    "## Unresolved Items",
    "- Whether SSO is required is still an open question.",
    "",
    "## Explicit Constraints",
    `- ${FIXTURE_FC_002_TEXT}`,
    "",
    "## Out-of-scope",
    "- Native mobile apps are out of scope for this project.",
    "",
  ].join("\n");
}

function buildGoodRawOutput(normalized: NormalizedMasterSpec, identity: { projectId: string; specVersion: string }): PlannerRawOutput {
  return {
    projectId: identity.projectId,
    specVersion: identity.specVersion,
    architectureSummary: "Fixture architecture: a simple layered service with an auth module.",
    technologyChoices: [{ area: "backend", decision: "Node.js/TypeScript", reason: "matches platform requirement", source: "fixture", status: "confirmed" }],
    fixedConstraintAcknowledgement: normalized.fixedConstraints.map((fc) => ({ id: fc.id, value: fc.text })),
    modulesOrComponents: ["auth"],
    integrations: ["email-provider"],
    securityRequirementsSummary: ["passwords hashed with bcrypt"],
    testingRequirementsSummary: ["unit tests for auth module"],
    deliveryConstraintsSummary: ["no paid services without approval"],
    phases: [{ phaseId: "1", name: "Foundation", objective: "Implement core account features", dependsOn: [], completionCriteria: ["all must-have requirements implemented"] }],
    tasks: [
      {
        taskId: "1.1",
        phaseId: "1",
        title: "Implement account creation",
        objective: "Allow users to create an account",
        scope: ["src/"],
        constraints: ["only touch src/"],
        dependsOn: [],
        expectedModules: ["src/auth"],
        requiredTests: [{ name: "unit", command: "npm", args: ["run", "test:unit"], cwd: "root" }],
        acceptanceCriteria: ["AC-001"],
        reqIds: ["REQ-001"],
        securityConsiderations: ["hash passwords with bcrypt"],
        completionGate: "unit tests pass",
      },
      {
        taskId: "1.2",
        phaseId: "1",
        title: "Implement password reset",
        objective: "Allow users to reset their password",
        scope: ["src/"],
        constraints: ["only touch src/"],
        dependsOn: ["1.1"],
        expectedModules: ["src/auth"],
        requiredTests: [{ name: "unit", command: "npm", args: ["run", "test:unit"], cwd: "root" }],
        acceptanceCriteria: ["AC-002"],
        reqIds: ["REQ-002"],
        securityConsiderations: ["send reset link via email provider"],
        completionGate: "unit tests pass",
      },
    ],
    executionPolicy: {
      allowedReadPrefixes: ["src/"],
      allowedWritePrefixes: ["src/"],
      allowedCommands: [{ cwd: "root", command: "npm", args: ["run", "test:unit"] }],
    },
  };
}

function fixedSource(output: unknown): PlannerRawOutputSource {
  return async () => ({ ok: true, rawOutput: typeof output === "string" ? output : JSON.stringify(output) });
}
function countingSource(output: unknown): { source: PlannerRawOutputSource; callCount: () => number } {
  let calls = 0;
  return {
    callCount: () => calls,
    source: async () => {
      calls += 1;
      return { ok: true, rawOutput: JSON.stringify(output) };
    },
  };
}
function neverCalledSource(): PlannerRawOutputSource {
  return async () => {
    throw new Error("이 rawOutputSource는 절대 호출되면 안 됩니다(resume 시 재호출 금지).");
  };
}

interface EnvelopeOverrides {
  handoffId?: string;
  projectId?: string;
  specVersion?: string;
  specIntegrity?: { algorithm: "sha256" | "sha512"; hash: string };
  specContentRef?: string;
}

function makeInlineEnvelope(content: string, overrides: EnvelopeOverrides = {}): unknown {
  const hash = overrides.specIntegrity ? overrides.specIntegrity.hash : sha256Hex(content);
  return {
    handoffId: overrides.handoffId ?? nextId("handoff-si3"),
    spec: {
      projectId: overrides.projectId ?? nextId("si3-proj").replace(/[^A-Za-z0-9_-]/g, "-"),
      projectName: "SI-3 Fixture Project",
      specVersion: overrides.specVersion ?? "1.0.0",
      specStatus: "APPROVED",
      userApproval: "PASS",
      reviewerGate: { critical: 0, high: 0 },
      unresolvedCriticalCount: 0,
      contradictionCount: 0,
      specIntegrity: overrides.specIntegrity ?? { algorithm: "sha256", hash },
      specContent: content,
    },
  };
}

function makeRefEnvelope(content: string, overrides: EnvelopeOverrides & { specContentRef: string }): unknown {
  const hash = sha256Hex(content);
  return {
    handoffId: overrides.handoffId ?? nextId("handoff-si3"),
    spec: {
      projectId: overrides.projectId ?? nextId("si3-proj").replace(/[^A-Za-z0-9_-]/g, "-"),
      projectName: "SI-3 Fixture Project (ref)",
      specVersion: overrides.specVersion ?? "1.0.0",
      specStatus: "APPROVED",
      userApproval: "PASS",
      reviewerGate: { critical: 0, high: 0 },
      unresolvedCriticalCount: 0,
      contradictionCount: 0,
      specIntegrity: overrides.specIntegrity ?? { algorithm: "sha256", hash },
      specContentRef: overrides.specContentRef,
    },
  };
}

interface FullBootstrapResult {
  outcome: BootstrapOutcome;
  identity: BootstrapRequestIdentity;
}

/** 실제 SI-1(evaluateSpecIntake) + SI-2(bootstrapProject) 경로를 그대로 호출해 COMPLETE된
 *  project root를 만든다 — 이 함수 자체는 어떤 SI-1/SI-2 규칙도 재구현하지 않는다. */
function runFullBootstrap(content: string, envelopeOverrides: EnvelopeOverrides = {}): FullBootstrapResult {
  const baseDir = makeTempDir("si3-base-");
  const envelope = makeInlineEnvelope(content, envelopeOverrides) as { handoffId: string; spec: { projectId: string; specVersion: string; specIntegrity: { algorithm: "sha256" | "sha512"; hash: string } } };
  const config: BootstrapTrustedConfig = { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY };
  const outcome = bootstrapProject(JSON.stringify(envelope), config);
  const identity: BootstrapRequestIdentity = {
    handoffId: envelope.handoffId,
    projectId: envelope.spec.projectId,
    specVersion: envelope.spec.specVersion,
    specIntegrityAlgorithm: envelope.spec.specIntegrity.algorithm,
    specIntegrityHash: envelope.spec.specIntegrity.hash.toLowerCase(),
  };
  return { outcome, identity };
}

// ---------------------------------------------------------------------------
// 1) valid inline APPROVED Master Spec → SI-1 → SI-2 → SI-3 → READY_FOR_AUTODEV
//    + 25~28) Project Manifest/Task Registry/Execution Policy/First Runnable Task 검증
// ---------------------------------------------------------------------------
async function scenarioInlineE2ESucceeds(): Promise<void> {
  const content = buildMasterSpecContent();
  const { outcome, identity } = runFullBootstrap(content);
  check("1) SI-2 bootstrap COMPLETE", outcome.status === "COMPLETE");
  if (outcome.status !== "COMPLETE") return;

  const normalized = normalizeMasterSpec(content);
  const goodRaw = buildGoodRawOutput(normalized, identity);
  const result = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: fixedSource(goodRaw) });
  // fixture Master Spec에는 항상 Fixed Constraint(FC-001/FC-002)가 있으므로 HOW-vs-constraint
  // 준수를 기계적으로 검증할 수 없어 status는 항상 HUMAN_REVIEW_REQUIRED다(§ 요구사항 1 fix,
  // "구조적 gate" — 순수 READY_FOR_AUTODEV/ALREADY_READY 케이스는 별도
  // scenarioNoFixedConstraintsYieldsReadyForAutodev()에서 검증한다).
  check("1) SI-3 runPlanner → HUMAN_REVIEW_REQUIRED(fixed constraint 있음)", result.status === "HUMAN_REVIEW_REQUIRED");
  if (result.status !== "HUMAN_REVIEW_REQUIRED") return;

  check("1) plannerStatePath 실제 생성됨", existsSync(result.plannerStatePath));
  check("25) project-manifest.json 실제 생성됨", existsSync(result.projectManifestPath));
  check("26) task-registry.json 실제 생성됨", existsSync(result.taskRegistryPath));
  check("27) execution-policy.json 실제 생성됨", existsSync(result.executionPolicyPath));

  const manifestFile = JSON.parse(readFileSync(result.projectManifestPath, "utf-8"));
  check("25) manifest.projectId 일치", manifestFile.projectId === identity.projectId);
  check("25) manifest.sourceSpecVersion 일치", manifestFile.sourceSpecVersion === identity.specVersion);
  check("25) manifest.fixedConstraints에 FC-001/FC-002 보존됨", manifestFile.fixedConstraints.some((f: { id: string }) => f.id === "FC-001") && manifestFile.fixedConstraints.some((f: { id: string }) => f.id === "FC-002"));
  check("25) manifest.reqTraceability에 REQ-001→1.1 매핑 기록됨", manifestFile.reqTraceability.requirements.find((r: { reqId: string }) => r.reqId === "REQ-001")?.taskIds.includes("1.1"));

  const taskRegistry = JSON.parse(readFileSync(result.taskRegistryPath, "utf-8")) as TaskDefinition[];
  check("26) task-registry.json에 task 2개 생성됨", taskRegistry.length === 2);
  check("26) task 1.1의 phase/taskNumber가 올바르게 파생됨", taskRegistry[0].id === "1.1" && taskRegistry[0].phase === 1 && taskRegistry[0].taskNumber === 1);

  const executionPolicy = JSON.parse(readFileSync(result.executionPolicyPath, "utf-8"));
  check("27) execution-policy.json에 allowedWritePrefixes 보존됨", JSON.stringify(executionPolicy.allowedWritePrefixes) === JSON.stringify(["src/"]));

  check("28) firstRunnableTask=1.1(registry의 첫 task)", result.firstRunnableTask?.id === "1.1");

  // GPT Independent Reviewer 지적(SI-3 REVISE 2회차, HIGH #1) — fixed constraint가 있으면
  // "HOW가 실제로 그 constraint를 지키는지는 기계적으로 검증되지 않았다"는 사실이 파일을
  // 열어보지 않아도 outcome 자체에서 항상 드러나야 한다(조용히 감추지 않는다).
  check(
    "compliance-note) fixedConstraints가 있으므로 fixedConstraintComplianceNote가 채워짐",
    typeof result.fixedConstraintComplianceNote === "string" && result.fixedConstraintComplianceNote.length > 0
  );
  check("compliance-note) manifest 파일에도 동일한 내용이 저장됨", manifestFile.fixedConstraintComplianceNote === result.fixedConstraintComplianceNote);
}

// ---------------------------------------------------------------------------
// 2) valid specContentRef Master Spec → 동일 E2E 성공
// ---------------------------------------------------------------------------
async function scenarioSpecContentRefE2ESucceeds(): Promise<void> {
  const sourceRoot = makeTempDir("si3-src-");
  const content = buildMasterSpecContent();
  writeFileSync(join(sourceRoot, "spec.md"), content, "utf-8");
  const baseDir = makeTempDir("si3-base-ref-");
  const envelope = makeRefEnvelope(content, { specContentRef: "spec.md" }) as { handoffId: string; spec: { projectId: string; specVersion: string; specIntegrity: { algorithm: "sha256" | "sha512"; hash: string } } };
  const config: BootstrapTrustedConfig = { bootstrapBaseDir: baseDir, specContentRefSourceRoot: sourceRoot, commitIdentity: COMMIT_IDENTITY };
  const outcome = bootstrapProject(JSON.stringify(envelope), config);
  check("2) specContentRef bootstrap COMPLETE", outcome.status === "COMPLETE");
  if (outcome.status !== "COMPLETE") return;

  const identity: BootstrapRequestIdentity = {
    handoffId: envelope.handoffId,
    projectId: envelope.spec.projectId,
    specVersion: envelope.spec.specVersion,
    specIntegrityAlgorithm: envelope.spec.specIntegrity.algorithm,
    specIntegrityHash: envelope.spec.specIntegrity.hash.toLowerCase(),
  };
  const normalized = normalizeMasterSpec(content);
  const goodRaw = buildGoodRawOutput(normalized, identity);
  const result = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: fixedSource(goodRaw) });
  check("2) specContentRef E2E → HUMAN_REVIEW_REQUIRED(fixed constraint 있음)", result.status === "HUMAN_REVIEW_REQUIRED");
}

// ---------------------------------------------------------------------------
// 3) SI-1 REJECT → Planner 실행 0
// ---------------------------------------------------------------------------
function scenarioSI1RejectMeansNoPlanner(): void {
  const badEnvelope = makeInlineEnvelope(buildMasterSpecContent()) as { spec: Record<string, unknown> };
  badEnvelope.spec.specStatus = "DRAFT";
  const decision = evaluateSpecIntake(JSON.stringify(badEnvelope));
  check("3) SI-1이 DRAFT spec을 REJECT함", decision.decision === "REJECT");
  check("3) SI-1 REJECT면 project root가 아예 없어 Planner를 호출할 대상 자체가 없음(구조적으로 실행 불가)", decision.decision === "REJECT");
}

// ---------------------------------------------------------------------------
// 4) SI-2 incomplete → Planner 실행 금지
// ---------------------------------------------------------------------------
async function scenarioBootstrapIncompleteBlocksPlanner(): Promise<void> {
  const content = buildMasterSpecContent();
  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("4) setup) bootstrap COMPLETE", false);
    return;
  }
  // stage를 인위적으로 미완료 상태로 되돌린다(실제 미완료 시나리오를 흉내).
  const statePath = outcome.bootstrapStatePath;
  const state = JSON.parse(readFileSync(statePath, "utf-8"));
  state.stage = "GIT_INITIALIZED";
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

  const normalized = normalizeMasterSpec(content);
  const goodRaw = buildGoodRawOutput(normalized, identity);
  const result = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: fixedSource(goodRaw) });
  check("4) bootstrap stage != COMPLETED → BLOCKED(BOOTSTRAP_NOT_COMPLETED)", result.status === "BLOCKED" && result.code === "BOOTSTRAP_NOT_COMPLETED");
}

// ---------------------------------------------------------------------------
// 5) tampered preserved Master Spec → BLOCK
// ---------------------------------------------------------------------------
async function scenarioTamperedSpecBlocksPlanner(): Promise<void> {
  const content = buildMasterSpecContent();
  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("5) setup) bootstrap COMPLETE", false);
    return;
  }
  writeFileSync(outcome.masterSpecPath, content + "\n변조된 내용 추가.", "utf-8");
  const result = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: neverCalledSource() });
  check("5) spec.md 변조 → BLOCKED(MASTER_SPEC_DIGEST_MISMATCH)", result.status === "BLOCKED" && result.code === "MASTER_SPEC_DIGEST_MISMATCH");
}

// ---------------------------------------------------------------------------
// 6) integrity mismatch(manifest.json 자체 손상) → BLOCK
// ---------------------------------------------------------------------------
async function scenarioManifestIntegrityMismatchBlocksPlanner(): Promise<void> {
  const content = buildMasterSpecContent();
  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("6) setup) bootstrap COMPLETE", false);
    return;
  }
  const manifestPath = join(outcome.projectRoot, ".autodev", "master-spec", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifest.storedContentDigest.hash = "0".repeat(64);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  const result = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: neverCalledSource() });
  check("6) manifest storedContentDigest 손상 → BLOCKED(MASTER_SPEC_DIGEST_MISMATCH)", result.status === "BLOCKED" && result.code === "MASTER_SPEC_DIGEST_MISMATCH");
}

// ---------------------------------------------------------------------------
// GPT Independent Reviewer 지적(SI-3 REVISE 1회차, HIGH #1) — spec.md와 manifest.json의
// storedContentDigest/specIntegrity를 "함께" 새 내용에 맞춰 변조해도(내부 self-consistency는
// 유지한 채) 호출부가 아는 원래 expectedIdentity.specIntegrityHash로 spec.md를 직접
// 재해시하는 독립 체크가 이를 잡아내는지 확인한다.
// ---------------------------------------------------------------------------
async function scenarioCoordinatedTamperingBlocksPlanner(): Promise<void> {
  const content = buildMasterSpecContent();
  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("coordinated-tamper) setup) bootstrap COMPLETE", false);
    return;
  }
  const tamperedContent = content + "\n변조된 내용(공격자가 spec.md와 manifest.json을 함께 바꿈).";
  const tamperedHash = sha256Hex(tamperedContent);
  writeFileSync(outcome.masterSpecPath, tamperedContent, "utf-8");
  const manifestPath = join(outcome.projectRoot, ".autodev", "master-spec", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifest.storedContentDigest.hash = tamperedHash;
  manifest.specIntegrity.hash = tamperedHash; // 내부적으로는 서로 여전히 일치하도록 함께 변조
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  const result = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: neverCalledSource() });
  check(
    "coordinated-tamper) spec.md+manifest.json을 함께(self-consistent하게) 변조해도 원래 expectedIdentity 재해시로 BLOCKED(MASTER_SPEC_DIGEST_MISMATCH)",
    result.status === "BLOCKED" && result.code === "MASTER_SPEC_DIGEST_MISMATCH"
  );
}

// ---------------------------------------------------------------------------
// GPT Independent Reviewer 지적(SI-3 REVISE 1회차, HIGH #2 후반) — 알려지지 않은 "## " 헤더
// 아래의 내용(예: 오타난 Fixed Decisions)이 조용히 버려지지 않고 BLOCK되는지 확인한다.
// ---------------------------------------------------------------------------
async function scenarioUnrecognizedHeaderBlocksPlanner(): Promise<void> {
  const content = buildMasterSpecContent().replace("## Fixed Decisions", "## Fixed Decisons"); // 오타
  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("unrecognized-header) setup) bootstrap COMPLETE", false);
    return;
  }
  const result = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: neverCalledSource() });
  check(
    "unrecognized-header) 오타난 섹션 헤더 → BLOCKED(UNRECOGNIZED_MASTER_SPEC_SECTION), rawOutputSource 호출 없음",
    result.status === "BLOCKED" && result.code === "UNRECOGNIZED_MASTER_SPEC_SECTION"
  );
}

// ---------------------------------------------------------------------------
// GPT Independent Reviewer 지적(SI-3 REVISE 2회차, HIGH #2) — "### Fixed Decisions"(hash
// 개수가 다른 헤더 시도)는 1회차 수정(정확히 "## "만 인식) 이후에도 헤더로 인식되지 않아,
// 그 아래 "- ..." 항목이 직전(엉뚱한) 섹션인 Acceptance Criteria로 잘못 흡수될 수 있었다
// (silent-drop보다 나쁜 silent-misattribution). 2회차 수정(1~6개 '#' 모두 헤더 시도로 넓게
// 인식 + 불인식 시 current=null)이 이 misattribution을 실제로 막는지 확인한다.
// ---------------------------------------------------------------------------
async function scenarioMisattributedHeaderIsNotSilentlyAbsorbed(): Promise<void> {
  const content = buildMasterSpecContent().replace("## Fixed Decisions", "### Fixed Decisions");
  const normalized = normalizeMasterSpec(content);
  check(
    "misattribution) '### Fixed Decisions'는 헤더 시도로 인식되어 unrecognizedHeaders에 기록됨",
    normalized.unrecognizedHeaders.some((h) => h.includes("Fixed Decisions"))
  );
  check(
    "misattribution) 그 아래 FC-001 원문이 Acceptance Criteria로 잘못 흡수되지 않음(AC 개수는 여전히 2개)",
    normalized.acceptanceCriteria.length === 2
  );
  // fixture는 Fixed Decisions(깨짐)와 Explicit Constraints(정상) 두 섹션을 갖는다 — 깨진
  // 섹션의 항목(FIXTURE_FC_001_TEXT)만 사라지고 정상 섹션의 항목(FIXTURE_FC_002_TEXT)은
  // 그대로 채번된다(fcCounter 공유 특성상 새 id는 FC-001로 재배정됨).
  check("misattribution) 깨진 섹션의 항목은 사라지고 정상 섹션의 항목만 채번됨(1개)", normalized.fixedConstraints.length === 1);
  check(
    "misattribution) 남은 항목은 Explicit Constraints 쪽(FIXTURE_FC_002_TEXT)이지 깨진 Fixed Decisions 쪽이 아님",
    normalized.fixedConstraints[0]?.text === FIXTURE_FC_002_TEXT
  );

  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("misattribution) setup) bootstrap COMPLETE", false);
    return;
  }
  const result = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: neverCalledSource() });
  check(
    "misattribution) runPlanner()도 BLOCKED(UNRECOGNIZED_MASTER_SPEC_SECTION)로 fail-closed",
    result.status === "BLOCKED" && result.code === "UNRECOGNIZED_MASTER_SPEC_SECTION"
  );
}

// ---------------------------------------------------------------------------
// GPT Independent Reviewer 지적(SI-3 REVISE 2회차, HIGH #3) — safeEchoValue()가 짧고(≤60자)
// 허용 문자로만 구성된 secret-shaped 값(알려진 SECRET_CONTENT_PATTERNS와도 일치하지 않는
// 임의 32자 hex 토큰)을 여전히 원문 그대로 echo하지 않는지 확인한다. 동시에, 실제로 기대
// 형식(REQ-*)과 일치하는 정상적인 오타(존재하지 않는 requirement id) 케이스는 여전히 원문이
// 그대로 보여 디버깅 정보가 과도하게 사라지지 않는지도 함께 확인한다.
// ---------------------------------------------------------------------------
async function scenarioShortSecretShapedValueIsRedacted(): Promise<void> {
  const content = buildMasterSpecContent();
  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("short-secret) setup) bootstrap COMPLETE", false);
    return;
  }
  const normalized = normalizeMasterSpec(content);
  const shortHexToken = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6"; // 32자 hex, 알려진 secret 패턴과 불일치, id 형식도 아님
  const raw = buildGoodRawOutput(normalized, identity);
  raw.tasks[0].reqIds.push(shortHexToken);
  const result = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: fixedSource(raw) });
  check("short-secret) REJECTED", result.status === "REJECTED");
  if (result.status === "REJECTED") {
    const leaked = result.issues.some((i) => i.detail.includes(shortHexToken));
    check("short-secret) 32자 hex 토큰이 어떤 issue.detail에도 원문 그대로 노출되지 않음(digest로 대체됨)", !leaked);
    const hasDigestPlaceholder = result.issues.some((i) => i.detail.includes("sha256:"));
    check("short-secret) 대신 비가역 digest placeholder가 남음", hasDigestPlaceholder);
  }

  // 대조군: 실제 REQ id 형식과 일치하는(그러나 존재하지 않는) 참조는 여전히 원문이 보여야 함.
  const rawWithTypo = buildGoodRawOutput(normalized, identity);
  rawWithTypo.tasks[0].reqIds.push("REQ-999");
  const outcome2 = runFullBootstrap(content);
  if (outcome2.outcome.status !== "COMPLETE") {
    check("short-secret) setup2) bootstrap COMPLETE", false);
    return;
  }
  const result2 = await runPlanner(outcome2.outcome.projectRoot, outcome2.identity, {
    rawOutputSource: fixedSource({ ...rawWithTypo, projectId: outcome2.identity.projectId, specVersion: outcome2.identity.specVersion }),
  });
  check("short-secret) 대조군) REJECTED", result2.status === "REJECTED");
  if (result2.status === "REJECTED") {
    check("short-secret) 대조군) id 형식과 일치하는 오타(REQ-999)는 디버깅을 위해 원문 그대로 보임", result2.issues.some((i) => i.detail.includes("REQ-999")));
  }
}

// ---------------------------------------------------------------------------
// GPT Independent Reviewer 지적(SI-3 REVISE 1회차, HIGH #4) — 다른(진짜 살아있는) 프로세스가
// 이미 이 project root의 lock을 쥐고 있으면 runPlanner()가 project-lock.ts를 통해 실제로
// BLOCKED(CONCURRENT_PLANNER_RUN_IN_PROGRESS)로 거부하는지 확인한다. mock이 아니라
// project-lock-integration-tests.ts와 동일한 기법(실제 child process를 하나 띄워 진짜
// liveness 판정 경로를 태움)을 그대로 재사용한다.
// ---------------------------------------------------------------------------
function seedForeignPlannerLock(projectId: string, root: string): { release: () => void } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"]);
  const canonical = resolveCanonicalProjectPath(root);
  const filePath = debugComputeLockFilePath(canonical, RUNTIME_LOCK_DIR);
  const meta: ProjectLockMetadata = {
    schemaVersion: PROJECT_LOCK_SCHEMA_VERSION,
    projectId,
    canonicalProjectPath: canonical,
    lockId: "si3-foreign-owner-lock-id",
    pid: child.pid as number,
    processStartedAtMs: Date.now(),
    lockCreatedAt: new Date().toISOString(),
    ownerKind: "autodev",
  };
  if (!existsSync(RUNTIME_LOCK_DIR)) mkdirSync(RUNTIME_LOCK_DIR, { recursive: true });
  writeFileSync(filePath, JSON.stringify(meta), "utf-8");
  return {
    release: () => {
      child.kill();
      try {
        rmSync(filePath, { force: true });
      } catch {
        /* 정리 실패는 테스트 결과에 영향 없음 */
      }
    },
  };
}

async function scenarioConcurrentRunsAreSerialized(): Promise<void> {
  const content = buildMasterSpecContent();
  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("concurrency) setup) bootstrap COMPLETE", false);
    return;
  }
  const foreign = seedForeignPlannerLock(identity.projectId, outcome.projectRoot);
  try {
    const result = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: neverCalledSource() });
    check(
      "concurrency) 다른 프로세스가 이미 lock을 쥐고 있으면 BLOCKED(CONCURRENT_PLANNER_RUN_IN_PROGRESS)",
      result.status === "BLOCKED" && result.code === "CONCURRENT_PLANNER_RUN_IN_PROGRESS"
    );
  } finally {
    foreign.release();
  }

  // lock이 release된 뒤에는 정상적으로 진행할 수 있다(영구 BLOCK 아님).
  const normalized = normalizeMasterSpec(content);
  const goodRaw = buildGoodRawOutput(normalized, identity);
  const afterRelease = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: fixedSource(goodRaw) });
  check("concurrency) foreign lock release 이후에는 정상적으로 HUMAN_REVIEW_REQUIRED까지 진행됨", afterRelease.status === "HUMAN_REVIEW_REQUIRED");
}

// ---------------------------------------------------------------------------
// GPT Independent Reviewer 지적(SI-3 REVISE 1회차, HIGH #3) — 절대경로/확장자 변형으로
// 위험 명령 검사를 우회할 수 없는지 확인한다.
// ---------------------------------------------------------------------------
async function scenarioCommandEvasionIsRejected(): Promise<void> {
  const content = buildMasterSpecContent();
  const normalized = normalizeMasterSpec(content);

  async function runWithCommand(label: string, command: string, expectedCode: string): Promise<void> {
    const { outcome, identity } = runFullBootstrap(content);
    if (outcome.status !== "COMPLETE") {
      check(`${label}) setup) bootstrap COMPLETE`, false);
      return;
    }
    const raw = buildGoodRawOutput(normalized, identity);
    raw.executionPolicy.allowedCommands.push({ cwd: "root", command, args: ["reset", "--hard"] });
    const result = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: fixedSource(raw) });
    const ok = result.status === "REJECTED" && result.issues.some((i) => i.code === expectedCode);
    check(`${label}) command="${command}" → ${expectedCode}`, ok);
  }

  await runWithCommand("evasion-abs-path", "C:\\Program Files\\Git\\bin\\git.exe", "UNSAFE_EXECUTION_POLICY");
  await runWithCommand("evasion-exe-suffix", "GIT.EXE", "DESTRUCTIVE_COMMAND_REQUESTED");
  await runWithCommand("evasion-relative-path", "./git", "UNSAFE_EXECUTION_POLICY");
}

// ---------------------------------------------------------------------------
// GPT Independent Reviewer 지적(SI-3 REVISE 1회차, HIGH #5) — 알려진 secret 패턴과 일치하지
// 않는(그래서 SECRET_SHAPED_OUTPUT을 유발하지 않는) 긴 임의 문자열을 reqId에 넣어도, 다른
// issue(UNKNOWN_REQUIREMENT_REFERENCE)의 detail에 그 원문이 통째로 노출되지 않는지 확인한다.
// ---------------------------------------------------------------------------
async function scenarioIssueDetailDoesNotLeakRawValue(): Promise<void> {
  const content = buildMasterSpecContent();
  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("no-leak) setup) bootstrap COMPLETE", false);
    return;
  }
  const normalized = normalizeMasterSpec(content);
  const raw = buildGoodRawOutput(normalized, identity);
  const longSuspiciousValue = "X".repeat(30) + "-not-a-known-secret-pattern-but-still-long-" + "Y".repeat(30);
  raw.tasks[0].reqIds.push(longSuspiciousValue);
  const result = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: fixedSource(raw) });
  check("no-leak) REJECTED", result.status === "REJECTED");
  if (result.status === "REJECTED") {
    const anyDetailContainsFullValue = result.issues.some((i) => i.detail.includes(longSuspiciousValue));
    check("no-leak) 어떤 issue.detail에도 원문 전체가 그대로 노출되지 않음(길이 제한/문자 치환됨)", !anyDetailContainsFullValue);
  }
}

// ---------------------------------------------------------------------------
// 7/8) wrong projectId / wrong specVersion → BLOCK
// ---------------------------------------------------------------------------
async function scenarioExpectedIdentityMismatchBlocksPlanner(): Promise<void> {
  const content = buildMasterSpecContent();
  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("7/8) setup) bootstrap COMPLETE", false);
    return;
  }
  const wrongProjectId = await runPlanner(outcome.projectRoot, { ...identity, projectId: "totally-different-project" }, { rawOutputSource: neverCalledSource() });
  check("7) wrong projectId → BLOCKED(EXPECTED_IDENTITY_MISMATCH)", wrongProjectId.status === "BLOCKED" && wrongProjectId.code === "EXPECTED_IDENTITY_MISMATCH");

  const wrongSpecVersion = await runPlanner(outcome.projectRoot, { ...identity, specVersion: "9.9.9" }, { rawOutputSource: neverCalledSource() });
  check("8) wrong specVersion → BLOCKED(EXPECTED_IDENTITY_MISMATCH)", wrongSpecVersion.status === "BLOCKED" && wrongSpecVersion.code === "EXPECTED_IDENTITY_MISMATCH");
}

// ---------------------------------------------------------------------------
// 9) Planner malformed JSON → REVISE/BLOCK(REJECTED)
// ---------------------------------------------------------------------------
async function scenarioMalformedJsonIsRejected(): Promise<void> {
  const content = buildMasterSpecContent();
  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("9) setup) bootstrap COMPLETE", false);
    return;
  }
  const result = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: fixedSource("{ this is not valid json") });
  check("9) malformed JSON → REJECTED", result.status === "REJECTED");
  if (result.status === "REJECTED") {
    check("9) MALFORMED_JSON 이슈 포함", result.issues.some((i) => i.code === "MALFORMED_JSON"));
  }
}

// ---------------------------------------------------------------------------
// 10~21) validatePlannerRawOutput()의 개별 위반 규칙 — runPlanner()로 end-to-end 검증.
// ---------------------------------------------------------------------------
async function scenarioValidatorRejectsUnsafeOutputs(): Promise<void> {
  const content = buildMasterSpecContent();
  const normalized = normalizeMasterSpec(content);

  async function runWithMutation(label: string, mutate: (raw: PlannerRawOutput) => void, expectedCode: string): Promise<void> {
    const { outcome, identity } = runFullBootstrap(content);
    if (outcome.status !== "COMPLETE") {
      check(`${label}) setup) bootstrap COMPLETE`, false);
      return;
    }
    const raw = buildGoodRawOutput(normalized, identity);
    mutate(raw);
    const result = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: fixedSource(raw) });
    const ok = result.status === "REJECTED" && result.issues.some((i) => i.code === expectedCode);
    check(`${label}) ${expectedCode} → reject`, ok);
  }

  await runWithMutation("10", (raw) => {
    raw.phases.push({ ...raw.phases[0], phaseId: "1" });
  }, "DUPLICATE_PHASE_ID");

  await runWithMutation("11", (raw) => {
    raw.tasks.push({ ...raw.tasks[0], taskId: "1.1" });
  }, "DUPLICATE_TASK_ID");

  await runWithMutation("12", (raw) => {
    raw.tasks[0].phaseId = "9";
  }, "UNKNOWN_PHASE_REFERENCE");

  await runWithMutation("13", (raw) => {
    raw.phases.push({ phaseId: "2", name: "Cyclic", objective: "x", dependsOn: ["1"], completionCriteria: ["x"] });
    raw.phases[0].dependsOn = ["2"];
  }, "DEPENDENCY_CYCLE");

  await runWithMutation("14", (raw) => {
    raw.tasks[0].dependsOn = ["9.9"];
  }, "MISSING_DEPENDENCY");

  await runWithMutation("15", (raw) => {
    raw.tasks[0].reqIds = [];
  }, "MISSING_MUST_HAVE_COVERAGE");

  await runWithMutation("16", (raw) => {
    raw.tasks[0].acceptanceCriteria = [];
  }, "MISSING_ACCEPTANCE_CRITERIA_COVERAGE");

  await runWithMutation("17", (raw) => {
    raw.fixedConstraintAcknowledgement = raw.fixedConstraintAcknowledgement.map((a) => (a.id === "FC-001" ? { id: "FC-001", value: "The database provider is MongoDB now." } : a));
  }, "FIXED_CONSTRAINT_VIOLATION");

  await runWithMutation("18", (raw) => {
    raw.tasks[0].reqIds.push("DEF-001");
  }, "DEFERRED_OR_OUT_OF_SCOPE_REFERENCED");

  await runWithMutation("19", (raw) => {
    raw.executionPolicy.allowedWritePrefixes = ["./"];
  }, "UNSAFE_EXECUTION_POLICY");

  await runWithMutation("20", (raw) => {
    // sk-ant-* 패턴은 JSON.stringify가 인용부호를 escape해도(§ 다른 패턴은 이스케이프된
    // 따옴표 때문에 매칭이 깨질 수 있음) 형태가 그대로 유지되는 secret 패턴이라 fixture로
    // 안정적으로 쓸 수 있다(secret-scanner.ts SECRET_CONTENT_PATTERNS).
    raw.architectureSummary = "fixture note sk-ant-abcdefghijklmnopqrstuvwxyz1234567890";
  }, "SECRET_SHAPED_OUTPUT");

  await runWithMutation("21", (raw) => {
    raw.executionPolicy.allowedCommands.push({ cwd: "root", command: "git", args: ["reset", "--hard"] });
  }, "DESTRUCTIVE_COMMAND_REQUESTED");
}

// ---------------------------------------------------------------------------
// 22) same spec 재실행 → idempotent(재생성/LLM 재호출 없음)
// ---------------------------------------------------------------------------
async function scenarioIdempotentRerun(): Promise<void> {
  const content = buildMasterSpecContent();
  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("22) setup) bootstrap COMPLETE", false);
    return;
  }
  const normalized = normalizeMasterSpec(content);
  const goodRaw = buildGoodRawOutput(normalized, identity);
  const { source, callCount } = countingSource(goodRaw);

  const first = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: source });
  check("22) 최초 실행 → HUMAN_REVIEW_REQUIRED(fixed constraint 있음)", first.status === "HUMAN_REVIEW_REQUIRED");
  const second = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: source });
  check("22) 동일 identity 재실행도 HUMAN_REVIEW_REQUIRED(idempotent — 재생성 없이 저장된 파일만 재확인)", second.status === "HUMAN_REVIEW_REQUIRED");
  check("22) 재실행 시 rawOutputSource가 다시 호출되지 않음(idempotent, 진짜 idempotency 증거는 이 callCount)", callCount() === 1);
  if (first.status === "HUMAN_REVIEW_REQUIRED" && second.status === "HUMAN_REVIEW_REQUIRED") {
    check("22) 재실행 결과의 projectManifestPath가 최초 실행과 동일", first.projectManifestPath === second.projectManifestPath);
  }
}

// ---------------------------------------------------------------------------
// 23) 같은 project root에 다른 identity의 planner-state가 있으면 → conflict
// ---------------------------------------------------------------------------
async function scenarioDifferentIdentityConflicts(): Promise<void> {
  const content = buildMasterSpecContent();
  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("23) setup) bootstrap COMPLETE", false);
    return;
  }
  const normalized = normalizeMasterSpec(content);
  const goodRaw = buildGoodRawOutput(normalized, identity);
  const first = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: fixedSource(goodRaw) });
  if (first.status !== "HUMAN_REVIEW_REQUIRED") {
    check("23) setup) 최초 실행 HUMAN_REVIEW_REQUIRED", false);
    return;
  }
  // planner-state.json을 직접 변조해 "이전에 다른 spec으로 planning된 적이 있다"는 상황을
  // 흉내낸다(SI-2 자체는 같은 project root에 서로 다른 identity가 COMPLETED되는 것을 이미
  // 막으므로, 이 drift는 오직 planner-state.json 자체의 손상/변조로만 재현 가능하다 —
  // Planner의 CONFLICT 판정이 그런 drift도 놓치지 않는지 확인하는 defense-in-depth 테스트).
  const state = JSON.parse(readFileSync(first.plannerStatePath, "utf-8"));
  state.identity.specVersion = "2.0.0";
  state.identity.specIntegrityHash = "1".repeat(64);
  writeFileSync(first.plannerStatePath, JSON.stringify(state, null, 2), "utf-8");

  const second = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: neverCalledSource() });
  check("23) planner-state identity drift → CONFLICT", second.status === "CONFLICT");
}

// ---------------------------------------------------------------------------
// 24) partial Planner failure → state 보존 → resume(LLM 재호출 없이 이어서 진행)
// ---------------------------------------------------------------------------
async function scenarioResumeFromArchitecturePlanned(): Promise<void> {
  const content = buildMasterSpecContent();
  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("24) setup) bootstrap COMPLETE", false);
    return;
  }
  const normalized = normalizeMasterSpec(content);
  const goodRaw = buildGoodRawOutput(normalized, identity);

  // ARCHITECTURE_PLANNED까지만 인위적으로 도달한 상태를 만든다(예: 이전 프로세스가 파일 쓰기
  // 직전에 죽었다고 가정) — planner-state.json을 직접 그 stage로 만든다.
  const plannerStatePath = join(outcome.projectRoot, ".autodev", "planner-state.json");
  mkdirSync(join(outcome.projectRoot, ".autodev"), { recursive: true });
  const partialState = {
    schemaVersion: 1,
    identity,
    stage: "ARCHITECTURE_PLANNED",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rawPlannerOutput: JSON.stringify(goodRaw),
  };
  writeFileSync(plannerStatePath, JSON.stringify(partialState, null, 2), "utf-8");
  check("24) setup) 3개 생성 파일이 아직 없음(부분 실패 상태)", !existsSync(join(outcome.projectRoot, ".autodev", "project-manifest.json")));

  const result = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: neverCalledSource() });
  check("24) ARCHITECTURE_PLANNED에서 resume → HUMAN_REVIEW_REQUIRED(LLM 재호출 없음, fixed constraint 있음)", result.status === "HUMAN_REVIEW_REQUIRED");
  if (result.status === "HUMAN_REVIEW_REQUIRED") {
    check("24) resume 이후 3개 생성 파일이 실제로 만들어짐", existsSync(result.projectManifestPath) && existsSync(result.taskRegistryPath) && existsSync(result.executionPolicyPath));
  }
}

function buildMasterSpecContentNoFixedConstraints(): string {
  const withFixed = buildMasterSpecContent();
  const withoutFixedDecisions = withFixed.replace(`## Fixed Decisions\n- ${FIXTURE_FC_001_TEXT}\n\n`, "");
  const withoutEither = withoutFixedDecisions.replace(`## Explicit Constraints\n- ${FIXTURE_FC_002_TEXT}\n\n`, "");
  return withoutEither;
}

// ---------------------------------------------------------------------------
// GPT Independent Reviewer 지적(SI-3 REVISE 2회차, HIGH #1) — fixed constraint가 있으면
// 항상 HUMAN_REVIEW_REQUIRED가 되므로(위 시나리오들이 이미 증명), fixed constraint가 전혀
// 없는(드물지만 유효한) 경우에는 여전히 기존 READY_FOR_AUTODEV(최초)/ALREADY_READY(재실행)
// 상태 문자열이 그대로 나오는지도 별도로 확인한다(상태 gate가 "항상 HUMAN_REVIEW_REQUIRED로
// 고정"된 것이 아니라 실제로 조건부라는 것을 증명).
// ---------------------------------------------------------------------------
async function scenarioNoFixedConstraintsYieldsReadyForAutodev(): Promise<void> {
  const content = buildMasterSpecContentNoFixedConstraints();
  const normalized = normalizeMasterSpec(content);
  check("no-fixed-constraints) fixture에 fixed constraint가 실제로 없음(setup 검증)", normalized.fixedConstraints.length === 0);

  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("no-fixed-constraints) setup) bootstrap COMPLETE", false);
    return;
  }
  const goodRaw = buildGoodRawOutput(normalized, identity);
  const first = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: fixedSource(goodRaw) });
  check("no-fixed-constraints) 최초 실행 → READY_FOR_AUTODEV(HUMAN_REVIEW_REQUIRED 아님)", first.status === "READY_FOR_AUTODEV");
  if (first.status === "READY_FOR_AUTODEV") {
    check("no-fixed-constraints) fixedConstraintComplianceNote는 null", first.fixedConstraintComplianceNote === null);
  }
  const second = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: neverCalledSource() });
  check("no-fixed-constraints) 재실행 → ALREADY_READY", second.status === "ALREADY_READY");
}

// ---------------------------------------------------------------------------
// GPT Independent Reviewer 지적(SI-3 REVISE 3회차, HIGH #2) — 앞에 공백이 있는 헤더 시도
// ("   ### Fixed Decisions", Markdown 표준상 유효한 3칸 들여쓰기 헤더 포함)도 정확히
// "## <알려진 이름>"이 아니면 여전히 감지되어야 하고(직전 섹션으로 오귀속되지 않아야) 한다.
// ---------------------------------------------------------------------------
async function scenarioIndentedHeaderIsNotSilentlyAbsorbed(): Promise<void> {
  const content = buildMasterSpecContent().replace("## Fixed Decisions", "   ### Fixed Decisions");
  const normalized = normalizeMasterSpec(content);
  check(
    "indented-header) 들여쓴 '### Fixed Decisions'도 헤더 시도로 인식되어 unrecognizedHeaders에 기록됨",
    normalized.unrecognizedHeaders.some((h) => h.includes("Fixed Decisions"))
  );
  check("indented-header) 그 아래 FC-001 원문이 Acceptance Criteria로 잘못 흡수되지 않음(AC 개수는 여전히 2개)", normalized.acceptanceCriteria.length === 2);

  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("indented-header) setup) bootstrap COMPLETE", false);
    return;
  }
  const result = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: neverCalledSource() });
  check("indented-header) runPlanner()도 BLOCKED(UNRECOGNIZED_MASTER_SPEC_SECTION)로 fail-closed", result.status === "BLOCKED" && result.code === "UNRECOGNIZED_MASTER_SPEC_SECTION");
}

// ---------------------------------------------------------------------------
// GPT Independent Reviewer 지적(SI-3 REVISE 3회차, HIGH #4) — COMPLETED 이후 생성 파일이
// 직접 변조/손상되면, 재실행(HUMAN_REVIEW_REQUIRED/ALREADY_READY로 이어지는 경로) 시점에
// 그 손상이 반드시 감지돼야 한다("조용히 READY로 보고하지 않는다").
// ---------------------------------------------------------------------------
async function scenarioTamperedGeneratedFilesAreDetectedAfterCompletion(): Promise<void> {
  const content = buildMasterSpecContentNoFixedConstraints(); // READY_FOR_AUTODEV/ALREADY_READY 경로로 명확히 테스트
  const normalized = normalizeMasterSpec(content);
  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("tamper-after-completion) setup) bootstrap COMPLETE", false);
    return;
  }
  const goodRaw = buildGoodRawOutput(normalized, identity);
  const first = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: fixedSource(goodRaw) });
  if (first.status !== "READY_FOR_AUTODEV") {
    check("tamper-after-completion) setup) 최초 실행 READY_FOR_AUTODEV", false);
    return;
  }
  // task-registry.json을 완료 이후 직접 손상시킨다(예: task id 중복을 주입).
  const taskRegistry = JSON.parse(readFileSync(first.taskRegistryPath, "utf-8"));
  taskRegistry.push({ ...taskRegistry[0] }); // 동일 id를 가진 중복 task 주입
  writeFileSync(first.taskRegistryPath, JSON.stringify(taskRegistry, null, 2), "utf-8");

  const second = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: neverCalledSource() });
  check(
    "tamper-after-completion) COMPLETED 이후 task-registry.json 변조 → 재실행 시 BLOCKED(GENERATED_DATA_INVALID)로 감지됨(조용히 ALREADY_READY 아님)",
    second.status === "BLOCKED" && second.code === "GENERATED_DATA_INVALID"
  );
}

// ---------------------------------------------------------------------------
// GPT Independent Reviewer 지적(SI-3 REVISE 3회차, MEDIUM) — planner-state.json이 구조
// 검증(rawPlannerOutput이 string)은 통과했지만 그 JSON 내용 자체가 손상된 상태에서 resume하면
// 처리되지 않은 예외가 아니라 구조화된 BLOCKED가 반환돼야 한다.
// ---------------------------------------------------------------------------
async function scenarioCorruptedRawPlannerOutputOnResumeIsHandled(): Promise<void> {
  const content = buildMasterSpecContent();
  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("corrupt-resume) setup) bootstrap COMPLETE", false);
    return;
  }
  const plannerStatePath = join(outcome.projectRoot, ".autodev", "planner-state.json");
  mkdirSync(join(outcome.projectRoot, ".autodev"), { recursive: true });
  const partialState = {
    schemaVersion: 1,
    identity,
    stage: "ARCHITECTURE_PLANNED",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    rawPlannerOutput: "{ this is not valid json even though it is a string field",
  };
  writeFileSync(plannerStatePath, JSON.stringify(partialState, null, 2), "utf-8");

  let threw = false;
  let result: PlannerOutcome | undefined;
  try {
    result = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: neverCalledSource() });
  } catch {
    threw = true;
  }
  check("corrupt-resume) 처리되지 않은 예외로 전파되지 않음(구조화된 결과 반환)", !threw);
  check("corrupt-resume) BLOCKED(GENERATED_DATA_INVALID)로 안전하게 처리됨", result?.status === "BLOCKED" && result.code === "GENERATED_DATA_INVALID");
}

// ---------------------------------------------------------------------------
// GPT Independent Reviewer 지적(SI-3 REVISE 4회차, HIGH #1) — HUMAN_REVIEW_REQUIRED 판정을
// persisted project-manifest.json의 fixedConstraintComplianceNote 필드에서 가져오면, 그
// 필드만 조용히 지워도(fixedConstraints 자체는 그대로 둔 채) gate를 우회할 수 있었다.
// 이제는 신뢰된 spec.md 재정규화 결과(hasFixedConstraints)만 판정에 쓰고, persisted note와
// 그 값이 불일치하면(변조/손상의 증거) BLOCK한다.
// ---------------------------------------------------------------------------
async function scenarioNoteTamperingDoesNotBypassGate(): Promise<void> {
  const content = buildMasterSpecContent(); // fixed constraint 있음
  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("note-tamper) setup) bootstrap COMPLETE", false);
    return;
  }
  const normalized = normalizeMasterSpec(content);
  const goodRaw = buildGoodRawOutput(normalized, identity);
  const first = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: fixedSource(goodRaw) });
  if (first.status !== "HUMAN_REVIEW_REQUIRED") {
    check("note-tamper) setup) 최초 실행 HUMAN_REVIEW_REQUIRED", false);
    return;
  }
  // fixedConstraints 배열은 그대로 둔 채 note만 null로 지운다 — gate 우회 시도를 흉내낸다.
  const manifestFile = JSON.parse(readFileSync(first.projectManifestPath, "utf-8"));
  check("note-tamper) setup) 변조 전 fixedConstraints는 비어있지 않음", Array.isArray(manifestFile.fixedConstraints) && manifestFile.fixedConstraints.length > 0);
  manifestFile.fixedConstraintComplianceNote = null;
  writeFileSync(first.projectManifestPath, JSON.stringify(manifestFile, null, 2), "utf-8");

  const second = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: neverCalledSource() });
  check(
    "note-tamper) note만 지워도(fixedConstraints는 그대로) READY로 조용히 넘어가지 않고 BLOCKED(GENERATED_DATA_INVALID)",
    second.status === "BLOCKED" && second.code === "GENERATED_DATA_INVALID"
  );
}

// ---------------------------------------------------------------------------
// GPT Independent Reviewer 지적(SI-3 REVISE 4회차, HIGH #2) — .autodev 디렉터리 자체의
// containment만으로는 그 "안"의 개별 생성 파일이 symlink로 project root 밖 파일을 가리키는
// 경우를 막지 못했다. task-registry.json을 project root 밖 파일을 가리키는 symlink로
// 교체해도 재검증이 거부하는지 확인한다(파일 symlink 생성 권한이 없는 환경에서는
// project-bootstrap-tests.ts와 동일한 관례로 건너뛴다).
// ---------------------------------------------------------------------------
async function scenarioGeneratedFileSymlinkIsRejected(): Promise<void> {
  const content = buildMasterSpecContentNoFixedConstraints();
  const normalized = normalizeMasterSpec(content);
  const { outcome, identity } = runFullBootstrap(content);
  if (outcome.status !== "COMPLETE") {
    check("generated-symlink) setup) bootstrap COMPLETE", false);
    return;
  }
  const goodRaw = buildGoodRawOutput(normalized, identity);
  const first = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: fixedSource(goodRaw) });
  if (first.status !== "READY_FOR_AUTODEV") {
    check("generated-symlink) setup) 최초 실행 READY_FOR_AUTODEV", false);
    return;
  }

  const outsideDir = makeTempDir("si3-symlink-outside-");
  const outsideFile = join(outsideDir, "fake-task-registry.json");
  writeFileSync(outsideFile, JSON.stringify([{ id: "9.9", phase: 9, taskNumber: 9, title: "injected", prompt: "x", requiredTests: [], allowedPathPrefixes: ["x/"], prohibitedOperations: [] }]), "utf-8");

  try {
    unlinkSync(first.taskRegistryPath);
    symlinkSync(outsideFile, first.taskRegistryPath, "file");
  } catch {
    skip("generated-symlink) 이 환경에서 파일 symlink 생성 권한이 없어 건너뜀");
    return;
  }

  const second = await runPlanner(outcome.projectRoot, identity, { rawOutputSource: neverCalledSource() });
  check(
    "generated-symlink) task-registry.json이 project root 밖을 가리키는 symlink면 BLOCKED(GENERATED_DATA_INVALID)로 거부됨",
    second.status === "BLOCKED" && second.code === "GENERATED_DATA_INVALID"
  );
}

// ---------------------------------------------------------------------------
// normalizeMasterSpec 단위 검증 — id 채번/mustHave 분류가 기대대로인지.
// ---------------------------------------------------------------------------
function scenarioNormalizeMasterSpecUnitChecks(): void {
  const normalized = normalizeMasterSpec(buildMasterSpecContent());
  check("normalize) requirements 11개(모든 requirement 계열 section 합산)", normalized.requirements.length === 11);
  check("normalize) REQ-001/002만 mustHave=true", normalized.requirements.filter((r) => r.mustHave).map((r) => r.id).join(",") === "REQ-001,REQ-002");
  check("normalize) acceptanceCriteria 2개(AC-001/002)", normalized.acceptanceCriteria.length === 2);
  check("normalize) fixedConstraints 2개(FC-001 fixed_decision, FC-002 explicit_constraint)", normalized.fixedConstraints.length === 2 && normalized.fixedConstraints[0].kind === "fixed_decision" && normalized.fixedConstraints[1].kind === "explicit_constraint");
  check("normalize) deferredItems 1개(DEF-001)", normalized.deferredItems.length === 1 && normalized.deferredItems[0].id === "DEF-001");
  check("normalize) outOfScope 1개(OOS-001)", normalized.outOfScope.length === 1 && normalized.outOfScope[0].id === "OOS-001");
  check("normalize) unresolvedItems 1개(정보성)", normalized.unresolvedItems.length === 1);
  check("normalize) projectGoal 비어있지 않음", normalized.projectGoal.length > 0);

  // buildPlannerPrompt가 실제로 핵심 요소(REQ id/Fixed Constraint 본문/schema 지시)를 담는지.
  const prompt = buildPlannerPrompt(normalized, { projectId: "p", specVersion: "1.0.0" });
  check("prompt) REQ-001 id 포함", prompt.includes("REQ-001"));
  check("prompt) Fixed Constraint 원문 포함", prompt.includes(FIXTURE_FC_001_TEXT));
  check("prompt) output schema 지시 포함", prompt.includes('"executionPolicy"'));

  // validatePlannerRawOutput을 직접 호출해도(runPlanner 경유 없이) 정상 output이 통과하는지.
  const goodRaw = buildGoodRawOutput(normalized, { projectId: "p", specVersion: "1.0.0" });
  const direct = validatePlannerRawOutput(JSON.stringify(goodRaw), normalized, { projectId: "p", specVersion: "1.0.0" });
  check("validator) 정상 raw output은 직접 호출로도 통과함", direct.ok === true);
}

// ---------------------------------------------------------------------------
// 실제 운용 경로 배선 검증 — createClaudeCliRawOutputSource()는 fixture가 아니라
// claude-runner.ts의 실제 runClaudeTask/execAndClassify(실제 subprocess spawn)를 그대로
// 감싼다. deterministic 테스트를 위해 rawOutputSource 자체는 항상 fixture를 주입하지만
// (§ 요구사항 15), 실제 AutoDev가 쓸 이 seam이 "한 번도 실행되지 않은 채" 완료 처리되지
// 않도록 존재하지 않는 바이너리로 실제 spawn을 시도해 오류 매핑까지 실제로 확인한다
// (claude-runner.ts 자신의 CLI_NOT_FOUND 분류는 runner-tests.ts가 이미 검증한다 — 여기서는
// 그 결과가 PlannerRawOutputOutcome으로 올바르게 감싸지는지만 확인한다).
// ---------------------------------------------------------------------------
async function scenarioClaudeCliWiringIsReal(): Promise<void> {
  const source = createClaudeCliRawOutputSource({ command: "autodev-si3-nonexistent-claude-binary-xyz", timeoutMs: 5000 });
  const result = await source("무시되는 테스트 prompt");
  check("wiring) 실제 존재하지 않는 바이너리로 실제 subprocess spawn을 시도하고 실패를 올바르게 매핑함", result.ok === false);
}

async function main(): Promise<void> {
  scenarioSI1RejectMeansNoPlanner();
  scenarioNormalizeMasterSpecUnitChecks();
  await scenarioClaudeCliWiringIsReal();

  try {
    await scenarioInlineE2ESucceeds();
    await scenarioSpecContentRefE2ESucceeds();
    await scenarioBootstrapIncompleteBlocksPlanner();
    await scenarioTamperedSpecBlocksPlanner();
    await scenarioManifestIntegrityMismatchBlocksPlanner();
    await scenarioCoordinatedTamperingBlocksPlanner();
    await scenarioUnrecognizedHeaderBlocksPlanner();
    await scenarioMisattributedHeaderIsNotSilentlyAbsorbed();
    await scenarioConcurrentRunsAreSerialized();
    await scenarioCommandEvasionIsRejected();
    await scenarioIssueDetailDoesNotLeakRawValue();
    await scenarioShortSecretShapedValueIsRedacted();
    await scenarioExpectedIdentityMismatchBlocksPlanner();
    await scenarioMalformedJsonIsRejected();
    await scenarioValidatorRejectsUnsafeOutputs();
    await scenarioIdempotentRerun();
    await scenarioDifferentIdentityConflicts();
    await scenarioResumeFromArchitecturePlanned();
    await scenarioNoFixedConstraintsYieldsReadyForAutodev();
    await scenarioIndentedHeaderIsNotSilentlyAbsorbed();
    await scenarioTamperedGeneratedFilesAreDetectedAfterCompletion();
    await scenarioCorruptedRawPlannerOutputOnResumeIsHandled();
    await scenarioNoteTamperingDoesNotBypassGate();
    await scenarioGeneratedFileSymlinkIsRejected();
  } finally {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 디렉터리 정리 실패는 테스트 결과에 영향 없음
      }
    }
  }

  console.log("\n=== spec-planner(Planner → AutoDev Execution Data Synthesis + E2E, SI-3) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  const skipCount = results.filter((r) => r.startsWith("[SKIP]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}${skipCount ? `, SKIP ${skipCount}` : ""}, FAIL ${results.length - passCount - skipCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();

// unused-type 회귀 방지용 참조(타입만 쓰는 import가 tree-shaking/lint 경고 없이 유지되도록).
export type { PlannerOutcome };
