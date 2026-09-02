import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBootstrapAndPlan, parseCliArgs, formatResultForHuman } from "./bootstrap-and-run";
import type { BootstrapAndRunDeps } from "./bootstrap-and-run";
import { loadProjectAdapter } from "./project-adapter-loader";
import { getNextTask } from "./task-registry";
import type { TaskDefinition } from "./task-registry";
import type { PlannerRawOutputSource, NormalizedMasterSpec, ArchitectureRawOutput } from "./spec-planner";
import { normalizeMasterSpec } from "./spec-planner";

// bootstrap-and-run 테스트 — spec 파일 → bootstrapProject → runPlanner → adapter 조립까지의
// 접착 로직만 검증한다(각 하위 단계 자체의 세부 규칙은 spec-intake-tests.ts/
// project-bootstrap-tests.ts/spec-planner-tests.ts가 이미 담당). 실제 Claude CLI는 절대
// 호출하지 않는다 — rawOutputSource는 항상 fake로 주입한다(§ spec-planner-tests.ts와 동일한
// 관례). 모든 시나리오는 OS 임시 디렉터리(mkdtempSync) 안의 disposable fixture만 쓴다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

// ---------------------------------------------------------------------------
// Master Spec fixture — spec-planner-tests.ts의 검증된 fixture와 동일한 구조(정확히 같은
// section 헤더/불릿 텍스트)를 재사용한다 — normalizeMasterSpec()이 REQ id를 부여하는 규칙이
// section별 불릿 개수에 의존하므로, 검증된 것과 다른 텍스트를 쓰면 traceability 단계가
// 예측 불가능하게 깨질 위험이 있다.
// ---------------------------------------------------------------------------
const FC_TEXT = "The database provider is PostgreSQL and must not be changed.";

function buildSpecContent(withFixedConstraint: boolean): string {
  const base = [
    "## Project Goal",
    "Deterministic fixture project goal text for bootstrap-and-run testing.",
    "",
    "## Product Scope",
    "Fixture product scope text.",
    "",
    "## Must-have Requirements",
    "- Users can create an account.",
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
    "## Acceptance Criteria",
    "- A new user can sign up and immediately log in.",
    "",
  ];
  if (withFixedConstraint) {
    base.push("## Fixed Decisions", `- ${FC_TEXT}`, "");
  }
  return base.join("\n");
}

function buildGoodArchitectureRaw(normalized: NormalizedMasterSpec, identity: { projectId: string; specVersion: string }): ArchitectureRawOutput {
  return {
    projectId: identity.projectId,
    specVersion: identity.specVersion,
    architectureSummary: "Fixture architecture: a simple layered service.",
    technologyChoices: [{ area: "backend", decision: "Node.js/TypeScript", reason: "fixture", source: "fixture", status: "confirmed" }],
    modulesOrComponents: ["auth"],
    integrations: [],
    architecturalBoundaries: ["auth module owns credential storage"],
    dependencyRelationships: [],
    majorConstraints: [],
    securityRequirementsSummary: ["passwords hashed with bcrypt"],
    testingRequirementsSummary: ["unit tests for auth module"],
    deliveryConstraintsSummary: [],
    fixedConstraintAcknowledgement: normalized.fixedConstraints.map((fc) => ({ id: fc.id, value: fc.text })),
    executionPolicy: {
      allowedReadPrefixes: ["src/"],
      allowedWritePrefixes: ["src/"],
      allowedCommands: [{ cwd: "root", command: "npm", args: ["run", "test:unit"] }],
    },
  };
}

function buildGoodPhasePlanRaw(identity: { projectId: string; specVersion: string }, reqIds: string[]) {
  return {
    projectId: identity.projectId,
    specVersion: identity.specVersion,
    phases: [
      {
        sequence: 1,
        name: "Foundation",
        objective: "Implement core account features",
        dependsOnSequence: [] as number[],
        reqIds,
        acIds: ["AC-001"],
        completionCriteria: ["all must-have requirements implemented"],
      },
    ],
  };
}

function buildGoodTaskPlanRaw(identity: { projectId: string; specVersion: string }, phaseId: string, reqIds: string[]) {
  return {
    projectId: identity.projectId,
    specVersion: identity.specVersion,
    phaseId,
    tasks: [
      {
        sequence: 1,
        title: "Implement account creation",
        objective: "Allow users to create an account",
        scope: ["src/"],
        constraints: ["only touch src/"],
        dependsOn: [] as string[],
        dependsOnSequenceInPhase: [] as number[],
        expectedModules: ["src/auth"],
        requiredTests: [{ name: "unit", command: "npm", args: ["run", "test:unit"], cwd: "root" }],
        acceptanceCriteria: ["AC-001"],
        reqIds,
        securityConsiderations: ["hash passwords with bcrypt"],
        completionGate: "unit tests pass",
      },
    ],
  };
}

function fixedSource(output: unknown): PlannerRawOutputSource {
  return async () => ({ ok: true, rawOutput: typeof output === "string" ? output : JSON.stringify(output) });
}

interface MultiStageHooks {
  architecture?: PlannerRawOutputSource;
}

function buildGoodSource(normalized: NormalizedMasterSpec, identity: { projectId: string; specVersion: string }, hooks: MultiStageHooks = {}): PlannerRawOutputSource {
  const reqIds = normalized.requirements.map((r) => r.id);
  const architectureSource = hooks.architecture ?? fixedSource(buildGoodArchitectureRaw(normalized, identity));
  const phasePlanSource = fixedSource(buildGoodPhasePlanRaw(identity, reqIds));
  const taskSource = fixedSource(buildGoodTaskPlanRaw(identity, "1", reqIds));
  return async (prompt: string) => {
    if (prompt.includes("STAGE 1(ARCHITECTURE)")) return architectureSource(prompt);
    if (prompt.includes("STAGE 2(PHASE PLAN)")) return phasePlanSource(prompt);
    return taskSource(prompt);
  };
}

function makeDeps(baseDir: string, specContentByPath: Map<string, string>, plannerSource?: PlannerRawOutputSource): BootstrapAndRunDeps {
  const normalized = normalizeMasterSpec(buildSpecContent(false));
  return {
    readSpecFile: (p: string) => {
      const content = specContentByPath.get(p);
      if (content === undefined) throw Object.assign(new Error(`ENOENT: no such file (${p})`), { code: "ENOENT" });
      return content;
    },
    bootstrapConfigOverrides: { commitIdentity: { name: "bootstrap-and-run test", email: "bar-test@example.invalid" } },
    plannerConfig: { rawOutputSource: plannerSource ?? buildGoodSource(normalized, { projectId: "placeholder", specVersion: "1.0.0" }) },
  };
}

// ---------------------------------------------------------------------------
// 시나리오
// ---------------------------------------------------------------------------

async function scenarioHappyPathReady(): Promise<void> {
  const baseDir = makeTempDir("bar-happy-base-");
  const specPath = join(makeTempDir("bar-happy-src-"), "master-spec.md");
  const content = buildSpecContent(false);
  const normalized = normalizeMasterSpec(content);
  const specFiles = new Map([[specPath, content]]);
  const projectId = nextId("bar-happy");
  const identityLike = { projectId, specVersion: "1.0.0" };

  const result = await runBootstrapAndPlan(
    { specFilePath: specPath, projectId, projectName: "Happy Path Project", baseDir },
    makeDeps(baseDir, specFiles, buildGoodSource(normalized, identityLike))
  );

  check("happy path → READY", result.kind === "READY");
  if (result.kind !== "READY") {
    check(`happy path detail: ${JSON.stringify(result)}`, false);
    return;
  }

  const adapterPath = result.adapterPath;
  check("manifest.json 실제 생성됨", existsSync(adapterPath));
  const statePath = join(result.projectRoot, ".autodev", "project-state.json");
  check("project-state.json 실제 생성됨", existsSync(statePath));

  let loadedOk = false;
  try {
    loadProjectAdapter(adapterPath);
    loadedOk = true;
  } catch {
    loadedOk = false;
  }
  check("조립된 manifest.json이 loadProjectAdapter()로 정상 로드됨", loadedOk);

  const state = JSON.parse(readFileSync(statePath, "utf-8"));
  check("project-state.json: completedTasks=[]", Array.isArray(state.completedTasks) && state.completedTasks.length === 0);
  check("project-state.json: currentTask=null", state.currentTask === null);
  check("project-state.json: status=IDLE", state.status === "IDLE");

  const taskRegistryPath = join(result.projectRoot, ".autodev", "task-registry.json");
  const taskRegistry = JSON.parse(readFileSync(taskRegistryPath, "utf-8")) as TaskDefinition[];
  const next = getNextTask(taskRegistry, state.completedTasks ?? []);
  check("getNextTask()가 첫 task를 정상적으로 고름", next !== null && next !== undefined);
}

async function scenarioIdempotentRerunPreservesProgress(): Promise<void> {
  const baseDir = makeTempDir("bar-idem-base-");
  const specPath = join(makeTempDir("bar-idem-src-"), "master-spec.md");
  const content = buildSpecContent(false);
  const normalized = normalizeMasterSpec(content);
  const specFiles = new Map([[specPath, content]]);
  const projectId = nextId("bar-idem");
  const identityLike = { projectId, specVersion: "1.0.0" };
  const args = { specFilePath: specPath, projectId, projectName: "Idempotent Project", baseDir };

  const first = await runBootstrapAndPlan(args, makeDeps(baseDir, specFiles, buildGoodSource(normalized, identityLike)));
  check("첫 실행 → READY", first.kind === "READY");
  if (first.kind !== "READY") return;

  const statePath = join(first.projectRoot, ".autodev", "project-state.json");
  const progressed = { ...JSON.parse(readFileSync(statePath, "utf-8")), completedTasks: ["1.1"], currentTask: "1.2" };
  writeFileSync(statePath, JSON.stringify(progressed, null, 2) + "\n", "utf-8");

  const second = await runBootstrapAndPlan(args, makeDeps(baseDir, specFiles, buildGoodSource(normalized, identityLike)));
  check("동일 입력 재실행 → 다시 READY(idempotent)", second.kind === "READY");

  const stateAfter = JSON.parse(readFileSync(statePath, "utf-8"));
  check(
    "재실행이 이미 진행된 project-state.json(completedTasks)을 덮어쓰지 않음",
    Array.isArray(stateAfter.completedTasks) && stateAfter.completedTasks.length === 1 && stateAfter.completedTasks[0] === "1.1"
  );
}

async function scenarioModifiedSpecSameProjectIdConflicts(): Promise<void> {
  const baseDir = makeTempDir("bar-conflict-base-");
  const srcDir = makeTempDir("bar-conflict-src-");
  const specPathA = join(srcDir, "a.md");
  const specPathB = join(srcDir, "b.md");
  const projectId = nextId("bar-conflict");
  const contentA = buildSpecContent(false);
  const contentB = buildSpecContent(false) + "\n## Product Scope\nA deliberately different scope text.\n";
  const specFiles = new Map([
    [specPathA, contentA],
    [specPathB, contentB],
  ]);
  const normalized = normalizeMasterSpec(contentA);
  const identityLike = { projectId, specVersion: "1.0.0" };

  const first = await runBootstrapAndPlan(
    { specFilePath: specPathA, projectId, projectName: "Conflict Project", baseDir },
    makeDeps(baseDir, specFiles, buildGoodSource(normalized, identityLike))
  );
  check("(conflict setup) 첫 실행 → READY", first.kind === "READY");

  const second = await runBootstrapAndPlan(
    { specFilePath: specPathB, projectId, projectName: "Conflict Project", baseDir },
    makeDeps(baseDir, specFiles, buildGoodSource(normalizeMasterSpec(contentB), identityLike))
  );
  check("같은 project-id, 다른 spec 내용 재실행 → BOOTSTRAP_CONFLICT", second.kind === "BOOTSTRAP_CONFLICT");
}

async function scenarioOversizedSpecRejectedBeforeTouchingDisk(): Promise<void> {
  const baseDir = makeTempDir("bar-oversized-base-");
  const projectId = nextId("bar-oversized");
  const huge = "x".repeat(2_000_001);
  const result = await runBootstrapAndPlan(
    { specFilePath: "/fake/oversized.md", projectId, projectName: "Oversized", baseDir },
    { readSpecFile: () => huge }
  );
  check("과대 spec 파일 → SPEC_TOO_LARGE", result.kind === "SPEC_TOO_LARGE");
  check("과대 spec은 프로젝트 폴더를 만들지 않음", !existsSync(join(baseDir, projectId)));
}

async function scenarioInvalidProjectIdRejectedByCore(): Promise<void> {
  const baseDir = makeTempDir("bar-invalidid-base-");
  const specPath = join(makeTempDir("bar-invalidid-src-"), "master-spec.md");
  const content = buildSpecContent(false);
  const specFiles = new Map([[specPath, content]]);

  const result = await runBootstrapAndPlan(
    { specFilePath: specPath, projectId: "a", projectName: "Invalid Id Project", baseDir },
    makeDeps(baseDir, specFiles)
  );
  check(
    "1글자 project-id(Core 형식 위반) → BOOTSTRAP_REJECTED(INVALID_PROJECT_ID)",
    result.kind === "BOOTSTRAP_REJECTED" && result.reasons.some((r) => r.code === "INVALID_PROJECT_ID")
  );
}

async function scenarioMissingSpecFile(): Promise<void> {
  const baseDir = makeTempDir("bar-missing-base-");
  const result = await runBootstrapAndPlan(
    { specFilePath: join(baseDir, "does-not-exist.md"), projectId: nextId("bar-missing"), projectName: "Missing", baseDir },
    {}
  );
  check("존재하지 않는 spec 파일 경로 → SPEC_FILE_ERROR", result.kind === "SPEC_FILE_ERROR");
}

async function scenarioFixedConstraintsRequireHumanReview(): Promise<void> {
  const baseDir = makeTempDir("bar-fc-base-");
  const specPath = join(makeTempDir("bar-fc-src-"), "master-spec.md");
  const content = buildSpecContent(true);
  const normalized = normalizeMasterSpec(content);
  const specFiles = new Map([[specPath, content]]);
  const projectId = nextId("bar-fc");
  const identityLike = { projectId, specVersion: "1.0.0" };

  const result = await runBootstrapAndPlan(
    { specFilePath: specPath, projectId, projectName: "Fixed Constraint Project", baseDir },
    makeDeps(baseDir, specFiles, buildGoodSource(normalized, identityLike))
  );
  check("Fixed Constraint 있는 spec → HUMAN_REVIEW_REQUIRED", result.kind === "HUMAN_REVIEW_REQUIRED");
  if (result.kind === "HUMAN_REVIEW_REQUIRED") {
    check("HUMAN_REVIEW_REQUIRED에서 manifest.json은 생성되지 않음", !existsSync(join(result.projectRoot, ".autodev", "manifest.json")));
    const { exitCode } = formatResultForHuman(result);
    check("HUMAN_REVIEW_REQUIRED는 exitCode 0이 아님(자동 성공으로 오인되지 않음)", exitCode !== 0);
  }
}

async function scenarioEmptyArgsRejected(): Promise<void> {
  const r1 = await runBootstrapAndPlan({ specFilePath: "", projectId: "x", projectName: "x" }, {});
  check("빈 --spec-file → INVALID_ARGS", r1.kind === "INVALID_ARGS");
  const r2 = await runBootstrapAndPlan({ specFilePath: "x", projectId: "", projectName: "x" }, {});
  check("빈 --project-id → INVALID_ARGS", r2.kind === "INVALID_ARGS");
  const r3 = await runBootstrapAndPlan({ specFilePath: "x", projectId: "x", projectName: "" }, {});
  check("빈 --project-name → INVALID_ARGS", r3.kind === "INVALID_ARGS");
}

async function scenarioPlannerRejectedMappedCorrectly(): Promise<void> {
  const baseDir = makeTempDir("bar-planner-reject-base-");
  const specPath = join(makeTempDir("bar-planner-reject-src-"), "master-spec.md");
  const content = buildSpecContent(false);
  const normalized = normalizeMasterSpec(content);
  const specFiles = new Map([[specPath, content]]);
  const projectId = nextId("bar-planner-reject");
  const identityLike = { projectId, specVersion: "1.0.0" };
  const badArchitecture = buildGoodArchitectureRaw(normalized, identityLike);
  badArchitecture.architectureSummary = ""; // validator가 거부해야 하는 빈 문자열

  const result = await runBootstrapAndPlan(
    { specFilePath: specPath, projectId, projectName: "Planner Reject Project", baseDir },
    makeDeps(baseDir, specFiles, buildGoodSource(normalized, identityLike, { architecture: fixedSource(badArchitecture) }))
  );
  check("architecture validator 위반 → PLANNER_REJECTED", result.kind === "PLANNER_REJECTED");
  if (result.kind === "PLANNER_REJECTED") {
    check("PLANNER_REJECTED는 issues를 담고 있음", result.issues.length > 0);
  }
}

function scenarioParseCliArgs(): void {
  const parsed = parseCliArgs(["--spec-file", "a.md", "--project-id", "p1", "--project-name", "P One"]);
  check("parseCliArgs: 필수 인자만으로 정상 파싱", !("error" in parsed) && parsed.specFilePath === "a.md" && parsed.projectId === "p1");

  const missing = parseCliArgs(["--project-id", "p1", "--project-name", "P One"]);
  check("parseCliArgs: --spec-file 누락 → error", "error" in missing);

  const withOptional = parseCliArgs([
    "--spec-file",
    "a.md",
    "--project-id",
    "p1",
    "--project-name",
    "P One",
    "--base-dir",
    "C:\\somewhere",
    "--spec-version",
    "2.1.0",
  ]);
  check(
    "parseCliArgs: 선택 인자(base-dir/spec-version)도 정상 파싱",
    !("error" in withOptional) && withOptional.baseDir === "C:\\somewhere" && withOptional.specVersion === "2.1.0"
  );
}

async function main(): Promise<void> {
  await scenarioHappyPathReady();
  await scenarioIdempotentRerunPreservesProgress();
  await scenarioModifiedSpecSameProjectIdConflicts();
  await scenarioOversizedSpecRejectedBeforeTouchingDisk();
  await scenarioInvalidProjectIdRejectedByCore();
  await scenarioMissingSpecFile();
  await scenarioFixedConstraintsRequireHumanReview();
  await scenarioEmptyArgsRejected();
  await scenarioPlannerRejectedMappedCorrectly();
  scenarioParseCliArgs();

  console.log("\n=== bootstrap-and-run 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
