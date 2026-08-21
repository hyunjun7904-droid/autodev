import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { decideNextAction, runAutodevOnce } from "./autodev";
import { validateProjectManifest } from "./project-manifest";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import { DEFAULT_STATE_PATH } from "./state";
import type { ProjectState, ClaudeResult } from "./types";
import type { GptReviewerReturn } from "./orchestrator";

// Phase A Task A4 — Project Manifest 최소 골격 검증.
// Phase B Task B3 — External Project Adapter 분리 이후, 이 파일은 어떤 특정 프로젝트(MOVAN
// 포함)도 import하지 않는다. autodev.ts는 taskRegistry를 기본값 없이 항상 명시적으로
// 요구하고, 명시적으로 주입한 (fixture) ProjectManifest의 taskRegistry/statePath/
// targetProjectRoot만 쓰인다는 것을 자체 fixture 데이터만으로 증명한다.
//
// 이 파일은 실제 automation/config/project-state.json(AutoDev 자신의 config)을 읽기만
// 하고(해시 비교 증거) 절대 쓰지 않는다 — fixture state/target root는 전부 OS 임시
// 디렉터리 안에서만 다룬다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function baseState(overrides: Partial<ProjectState>): ProjectState {
  return {
    gitCheckpoint: "test",
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "IDLE",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
    currentPhase: 1,
    ...overrides,
  } as ProjectState;
}

function fakePassReviewer(): (result: ClaudeResult, reviewCycle: number, task: string, allowedPathPrefixes?: string[]) => Promise<GptReviewerReturn> {
  return async () => ({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "테스트: 문제 없음", nextTask: null });
}

// ---------------------------------------------------------------------------
// 공용 Fixture 데이터 — 서로 다른 두 개의 독립적인 프로젝트를 흉내낸다(id 공간이 겹치지
// 않는다는 것을 스스로 증명하기 위해 registry를 두 개 둔다).
// ---------------------------------------------------------------------------
const FIXTURE_REGISTRY: TaskDefinition[] = [
  {
    id: "FX1",
    phase: 1,
    taskNumber: 1,
    title: "fixture manifest task 1",
    prompt: "fixture manifest prompt 1",
    requiredTests: [],
    allowedPathPrefixes: ["fixture/"],
    prohibitedOperations: [],
  },
  {
    id: "FX2",
    phase: 1,
    taskNumber: 2,
    title: "fixture manifest task 2",
    prompt: "fixture manifest prompt 2",
    requiredTests: [],
    allowedPathPrefixes: ["fixture/"],
    prohibitedOperations: [],
  },
];

const ALT_FIXTURE_REGISTRY: TaskDefinition[] = [
  {
    id: "ALT1",
    phase: 1,
    taskNumber: 1,
    title: "다른 프로젝트의 task 1",
    prompt: "다른 프로젝트의 task 1 prompt",
    requiredTests: [],
    allowedPathPrefixes: ["alt/"],
    prohibitedOperations: [],
  },
];

const FIXTURE_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["fixture/"],
  allowedWritePrefixes: ["fixture/"],
  allowedCommands: [],
};

// ---------------------------------------------------------------------------
// A) 명시적 taskRegistry 주입이 항상 필요하다 — decideNextAction()은 기본값(특정 프로젝트)을
// 갖지 않는다. 어떤 registry를 주입하든 그 registry의 순서만으로 다음 task가 결정되고,
// 빈 registry를 주입하면 어떤 프로젝트로도 fallback하지 않고 STOP한다.
// ---------------------------------------------------------------------------
function scenarioExplicitManifestRequiredNoSilentDefault(): void {
  const state = baseState({ status: "READY", completedTasks: ["FX1"] });

  const decisionExplicit = decideNextAction(state, FIXTURE_REGISTRY);
  check(
    "A) FIXTURE_REGISTRY를 명시적으로 주입하면 다음 task='FX2'",
    decisionExplicit.kind === "RUN_TASK" && decisionExplicit.task.id === "FX2"
  );

  // TS 컴파일 타임에는 taskRegistry가 필수 매개변수라 인자 없이 호출하면 컴파일 에러다.
  // 런타임에서도(예: 컴파일된 JS를 다른 프로젝트가 잘못 호출하는 경우) 조용히 특정
  // 프로젝트로 fallback하지 않고 실제로 taskRegistry가 없으면 getNextTask가 빈 배열을
  // 순회해 즉시 STOP(다음 task 없음)을 반환한다는 것을 증명한다 — 어떤 프로젝트의 값도
  // 절대 추측해 채우지 않는다.
  const decisionEmptyRegistry = decideNextAction(state, []);
  check(
    "A) 빈 taskRegistry를 명시적으로 주입하면 어떤 프로젝트로도 fallback하지 않고 STOP",
    decisionEmptyRegistry.kind === "STOP"
  );
}

// ---------------------------------------------------------------------------
// B/C) Fixture Manifest를 주입하면 그 fixture registry/state/root만 사용하고, 다른(ALT)
// 프로젝트의 데이터가 전혀 섞이지 않는다.
// ---------------------------------------------------------------------------
const tempDirs: string[] = [];

function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-manifest-fixture-"));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "manifest-fixture-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Manifest Fixture Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function writeRepoFile(repo: string, relPath: string, content: string): void {
  const abs = join(repo, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

async function scenarioFixtureManifestIsolatesFromOtherProjects(): Promise<void> {
  const root = makeTempGitRepo();
  const statePath = join(root, "fixture-project-state.json");
  writeFileSync(statePath, JSON.stringify(baseState({ status: "READY", completedTasks: [] }), null, 2) + "\n", "utf-8");

  const fixtureManifest: ProjectManifest = {
    projectId: "fixture-project",
    projectName: "Fixture Project",
    targetProjectRoot: root,
    statePath,
    taskRegistry: FIXTURE_REGISTRY,
    developerInstructions: "fixture manifest developer instructions — no other project content.",
    reviewInstructions: "fixture manifest review instructions — no other project content.",
    reviewScopeDirs: ["fixture/"],
    executionPolicy: FIXTURE_EXECUTION_POLICY,
  };

  // manifest 자체는 유효해야 한다(root/statePath 모두 실존).
  let validated = false;
  try {
    validateProjectManifest(fixtureManifest);
    validated = true;
  } catch {
    validated = false;
  }
  check("B) 유효한 fixture manifest는 validateProjectManifest를 통과함", validated);

  const claudeRunner = async (): Promise<ClaudeResult> => {
    writeRepoFile(root, "fixture/marker.txt", "fixture manifest marker\n");
    return {
      success: true,
      summary: "테스트: fixture manifest task 실행",
      changedFiles: ["fixture/marker.txt"],
      tests: [{ name: "fixture:check", pass: true }],
      rawOutput: "",
    };
  };

  // statePath/cwd를 opts로 넘기지 않는다 — manifest.statePath/manifest.targetProjectRoot가
  // 실제로 쓰이는지 확인하기 위함이다.
  const result = await runAutodevOnce({
    manifest: fixtureManifest,
    orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() },
  });

  check("B) fixture manifest 실행: outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("B) fixture manifest 실행: taskId='FX1'(fixture registry의 첫 task, ALT registry 아님)", result.taskId === "FX1");

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("B) manifest.statePath(fixture-project-state.json)에 실제로 기록됨", finalState.completedTasks.includes("FX1"));
  check(
    "B) 다음 task가 fixture registry의 FX2를 가리킴(다른 프로젝트의 다음 task 아님)",
    typeof finalState.currentTask === "string" && finalState.currentTask.includes("FX2")
  );

  const log = spawnSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf-8" }).stdout || "";
  check(
    "B) git commit이 manifest.targetProjectRoot(fixture root)에서 실제로 발생함(product+administrative+init=3건)",
    log.trim().split("\n").length === 3
  );

  check(
    "C) fixture 실행 결과 completedTasks에 다른(ALT) 프로젝트의 task id가 전혀 섞이지 않음",
    !ALT_FIXTURE_REGISTRY.some((t) => finalState.completedTasks.includes(t.id))
  );
  check("C) fixture registry id 공간과 ALT registry id 공간이 겹치지 않음", !FIXTURE_REGISTRY.some((f) => ALT_FIXTURE_REGISTRY.some((m) => m.id === f.id)));
}

// ---------------------------------------------------------------------------
// D) 잘못된 명시적 Manifest는 어떤 프로젝트로도 조용히 fallback하지 않고 즉시 실패한다.
// ---------------------------------------------------------------------------
async function scenarioInvalidManifestFailsFastWithoutSilentFallback(): Promise<void> {
  let claudeRunnerCalled = false;
  const claudeRunnerShouldNeverRun = async (): Promise<ClaudeResult> => {
    claudeRunnerCalled = true;
    throw new Error("claudeRunner가 호출되면 안 된다 — invalid manifest는 실행 전에 실패해야 한다");
  };

  const NOWHERE_ROOT = join(tmpdir(), "autodev-manifest-nonexistent-root-" + Date.now());
  const NOWHERE_STATE = join(tmpdir(), "autodev-manifest-nonexistent-state-" + Date.now() + ".json");
  // 이 프로세스가 실제로 실행 중인 이 repository의 root — validateProjectManifest는
  // existsSync만 확인하므로 존재하는 임의의 디렉터리면 충분하다(실제로 쓰지 않는다).
  const EXISTING_ROOT = resolve(__dirname, "..");

  // D-1) targetProjectRoot가 존재하지 않는 경로.
  const badRootManifest: ProjectManifest = {
    projectId: "bad-root",
    projectName: "Bad Root Manifest",
    targetProjectRoot: NOWHERE_ROOT,
    statePath: NOWHERE_STATE,
    taskRegistry: FIXTURE_REGISTRY,
    developerInstructions: "irrelevant",
    reviewInstructions: "irrelevant",
    reviewScopeDirs: ["fixture/"],
    executionPolicy: FIXTURE_EXECUTION_POLICY,
  };
  let threwBadRoot = false;
  try {
    await runAutodevOnce({ manifest: badRootManifest, orchestratorDeps: { claudeRunner: claudeRunnerShouldNeverRun } });
  } catch {
    threwBadRoot = true;
  }
  check("D) 존재하지 않는 targetProjectRoot를 가진 manifest는 즉시 실패(silent fallback 아님)", threwBadRoot);

  // D-2) taskRegistry가 배열이 아님(런타임에 잘못된 값이 주입된 경우를 흉내).
  const badRegistryManifest = {
    projectId: "bad-registry",
    projectName: "Bad Registry Manifest",
    targetProjectRoot: EXISTING_ROOT,
    statePath: NOWHERE_STATE,
    taskRegistry: "not-an-array",
    developerInstructions: "irrelevant",
    reviewInstructions: "irrelevant",
    reviewScopeDirs: ["fixture/"],
  } as unknown as ProjectManifest;
  let threwBadRegistry = false;
  try {
    await runAutodevOnce({ manifest: badRegistryManifest, orchestratorDeps: { claudeRunner: claudeRunnerShouldNeverRun } });
  } catch {
    threwBadRegistry = true;
  }
  check("D) taskRegistry가 배열이 아닌 manifest는 즉시 실패", threwBadRegistry);

  // D-3) projectId가 빈 문자열.
  const validShapeManifest: ProjectManifest = {
    projectId: "valid-shape",
    projectName: "Valid Shape Manifest",
    targetProjectRoot: EXISTING_ROOT,
    statePath: NOWHERE_STATE,
    taskRegistry: FIXTURE_REGISTRY,
    developerInstructions: "irrelevant",
    reviewInstructions: "irrelevant",
    reviewScopeDirs: ["fixture/"],
    executionPolicy: FIXTURE_EXECUTION_POLICY,
  };
  let threwBadProjectId = false;
  try {
    validateProjectManifest({ ...validShapeManifest, projectId: "" });
  } catch {
    threwBadProjectId = true;
  }
  check("D) projectId가 빈 문자열인 manifest는 validateProjectManifest에서 즉시 실패", threwBadProjectId);

  check("D) 위 invalid manifest 시나리오에서 claudeRunner가 한 번도 호출되지 않음(검증 단계에서 이미 차단)", !claudeRunnerCalled);
}

// ---------------------------------------------------------------------------
// E) manifest를 아예 지정하지 않으면(런타임에 undefined가 들어오는 경우까지 포함) 어떤
// 프로젝트로도 조용히 fallback하지 않고 즉시 실패한다. TS 컴파일 타임에는 opts.manifest가
// 필수 필드라 아예 생략하면 컴파일 에러다 — 여기서는 컴파일된 JS를 호출하는 쪽이 실수로
// (또는 다른 언어에서) manifest를 빠뜨리는 상황까지 방어하는지 as unknown 캐스트로 흉내내
// 런타임 동작을 직접 증명한다.
// ---------------------------------------------------------------------------
async function scenarioMissingManifestFailsFastAtRuntime(): Promise<void> {
  let claudeRunnerCalled = false;
  const claudeRunnerShouldNeverRun = async (): Promise<ClaudeResult> => {
    claudeRunnerCalled = true;
    throw new Error("claudeRunner가 호출되면 안 된다 — manifest 없이는 실행 전에 실패해야 한다");
  };

  let threwOnMissingManifest = false;
  try {
    await runAutodevOnce({ orchestratorDeps: { claudeRunner: claudeRunnerShouldNeverRun } } as unknown as { manifest: ProjectManifest });
  } catch {
    threwOnMissingManifest = true;
  }
  check("E) opts.manifest를 아예 생략(런타임)하면 즉시 실패(silent fallback 없음)", threwOnMissingManifest);

  let threwOnUndefinedManifest = false;
  try {
    await runAutodevOnce({
      manifest: undefined as unknown as ProjectManifest,
      orchestratorDeps: { claudeRunner: claudeRunnerShouldNeverRun },
    });
  } catch {
    threwOnUndefinedManifest = true;
  }
  check("E) opts.manifest=undefined도 즉시 실패(silent fallback 없음)", threwOnUndefinedManifest);
  check("E) manifest 누락 시나리오에서 claudeRunner가 한 번도 호출되지 않음", !claudeRunnerCalled);
}

async function main(): Promise<void> {
  const realStateBefore = readFileSync(DEFAULT_STATE_PATH, "utf-8");

  scenarioExplicitManifestRequiredNoSilentDefault();

  try {
    await scenarioFixtureManifestIsolatesFromOtherProjects();
    await scenarioInvalidManifestFailsFastWithoutSilentFallback();
    await scenarioMissingManifestFailsFastAtRuntime();
  } finally {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 디렉터리 정리 실패는 테스트 결과에 영향 없음
      }
    }
  }

  const realStateAfter = readFileSync(DEFAULT_STATE_PATH, "utf-8");
  check("project-state 격리: 실제 project-state.json이 테스트 실행 전후 완전히 동일함", realStateBefore === realStateAfter);

  // 회귀 방지: autodev.ts 소스에 특정 프로젝트의 registry 직접 import가 재도입되지 않았는지
  // 소스 스캔으로도 확인한다.
  const autodevSource = readFileSync(join(__dirname, "..", "src", "autodev.ts"), "utf-8");
  check(
    "소스 회귀: autodev.ts가 project-registries/movan을 import하지 않음",
    !/from\s+"\.\/project-registries\/movan"/.test(autodevSource)
  );

  // Phase A Task A7 / Phase B Task B3 — autodev.ts(Core)는 어떤 프로젝트의 manifest도 전혀
  // import하지 않고(silent fallback 없음), run.ts(범용 진입점)만 project-adapter-loader를
  // 통해 외부에서 명시적으로 주입받은 manifest를 runAutodevOnce()에 넘긴다.
  check(
    "소스 회귀(A7/B3): autodev.ts가 project-manifests/movan을 import하지 않음(Core는 특정 프로젝트를 모름)",
    !/from\s+"\.\/project-manifests\/movan"/.test(autodevSource)
  );
  const runSource = readFileSync(join(__dirname, "..", "src", "run.ts"), "utf-8");
  check(
    "소스 회귀(B3): run.ts가 project-adapter-loader에서 loadProjectAdapter를 import함",
    /import\s*\{\s*loadProjectAdapter\s*\}\s*from\s*"\.\/project-adapter-loader"/.test(runSource)
  );
  check(
    "소스 회귀(B3): run.ts가 runAutodevOnce에 loadProjectAdapter()의 반환값을 manifest로 전달함",
    /runAutodevOnce\(\{\s*manifest\s*\}\)/.test(runSource)
  );

  console.log("\n=== project-manifest(Project Manifest 최소 골격) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
