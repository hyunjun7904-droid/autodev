import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { decideNextAction, runAutodevOnce } from "./autodev";
import { MOVAN_PROJECT_MANIFEST } from "./project-manifests/movan";
import { MOVAN_TASK_REGISTRY } from "./project-registries/movan";
import { validateProjectManifest } from "./project-manifest";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import { DEFAULT_STATE_PATH } from "./state";
import type { ProjectState, ClaudeResult } from "./types";
import type { GptReviewerReturn } from "./orchestrator";

// Phase A Task A4 — Project Manifest 최소 골격 검증.
//
// autodev.ts는 더 이상 MOVAN_TASK_REGISTRY를 직접 import하지 않는다 — 기본값은
// MOVAN_PROJECT_MANIFEST를 통해서만 연결되고, 명시적으로 다른(fixture) ProjectManifest를
// 주입하면 그 manifest의 taskRegistry/statePath/targetProjectRoot만 쓰인다는 것을 증명한다.
//
// 이 파일은 실제 automation/config/project-state.json을 읽기만 하고(해시 비교 증거) 절대
// 쓰지 않는다 — fixture state/target root는 전부 OS 임시 디렉터리 안에서만 다룬다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function baseState(overrides: Partial<ProjectState>): ProjectState {
  return {
    project: "MOVAN ERP",
    currentPhase: 13,
    phase10Allowed: true,
    migrationsApplied: [],
    migrationsImmutable: true,
    devSupabaseCreated: true,
    devSupabaseConnected: false,
    microsoftConnected: false,
    productionDeployAllowed: false,
    gitCheckpoint: "test",
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "IDLE",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
    ...overrides,
  } as ProjectState;
}

function fakePassReviewer(): (result: ClaudeResult, reviewCycle: number, task: string, allowedPathPrefixes?: string[]) => Promise<GptReviewerReturn> {
  return async () => ({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "테스트: 문제 없음", nextTask: null });
}

// ---------------------------------------------------------------------------
// A) Phase A Task A7 — MOVAN Manifest를 명시적으로 주입해야만 MOVAN 다음 Task가 선택된다.
// decideNextAction()은 더 이상 기본값(MOVAN)을 갖지 않는다 — taskRegistry 인자가 필수다.
// ---------------------------------------------------------------------------
function scenarioExplicitManifestRequiredNoSilentDefault(): void {
  const state = baseState({ status: "READY", completedTasks: ["13.1"] });

  const decisionExplicitMovan = decideNextAction(state, MOVAN_PROJECT_MANIFEST.taskRegistry);
  check(
    "A) MOVAN_PROJECT_MANIFEST.taskRegistry를 명시적으로 주입하면 다음 task='13.2'",
    decisionExplicitMovan.kind === "RUN_TASK" && decisionExplicitMovan.task.id === "13.2"
  );
  check("A) MOVAN_PROJECT_MANIFEST.taskRegistry === MOVAN_TASK_REGISTRY(동일 데이터)", MOVAN_PROJECT_MANIFEST.taskRegistry === MOVAN_TASK_REGISTRY);

  // TS 컴파일 타임에는 taskRegistry가 필수 매개변수라 인자 없이 호출하면 컴파일 에러다.
  // 런타임에서도(예: 컴파일된 JS를 다른 프로젝트가 잘못 호출하는 경우) 조용히 MOVAN으로
  // fallback하지 않고 실제로 taskRegistry가 없으면 getNextTask가 빈 배열을 순회해 즉시
  // STOP(다음 task 없음)을 반환한다는 것을 증명한다 — MOVAN 값을 절대 추측해 채우지 않는다.
  const decisionEmptyRegistry = decideNextAction(state, []);
  check(
    "A) 빈 taskRegistry를 명시적으로 주입하면 MOVAN으로 fallback하지 않고 STOP",
    decisionEmptyRegistry.kind === "STOP"
  );
}

// ---------------------------------------------------------------------------
// B/C) Fixture Manifest를 주입하면 fixture registry/state/root만 사용하고, MOVAN 데이터가
// 전혀 섞이지 않는다.
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

const FIXTURE_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["fixture/"],
  allowedWritePrefixes: ["fixture/"],
  allowedCommands: [],
};

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

async function scenarioFixtureManifestIsolatesFromMovan(): Promise<void> {
  const root = makeTempGitRepo();
  const statePath = join(root, "fixture-project-state.json");
  writeFileSync(statePath, JSON.stringify(baseState({ project: "Fixture Project", status: "READY", completedTasks: [] }), null, 2) + "\n", "utf-8");

  const fixtureManifest: ProjectManifest = {
    projectId: "fixture-project",
    projectName: "Fixture Project",
    targetProjectRoot: root,
    statePath,
    taskRegistry: FIXTURE_REGISTRY,
    developerInstructions: "fixture manifest developer instructions — no MOVAN content.",
    reviewInstructions: "fixture manifest review instructions — no MOVAN content.",
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
  check("B) fixture manifest 실행: taskId='FX1'(fixture registry의 첫 task, MOVAN '13.1' 아님)", result.taskId === "FX1");

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("B) manifest.statePath(fixture-project-state.json)에 실제로 기록됨", finalState.completedTasks.includes("FX1"));
  check(
    "B) 다음 task가 fixture registry의 FX2를 가리킴(MOVAN 다음 task 아님)",
    typeof finalState.currentTask === "string" && finalState.currentTask.includes("FX2")
  );

  const log = spawnSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf-8" }).stdout || "";
  check(
    "B) git commit이 manifest.targetProjectRoot(fixture root)에서 실제로 발생함(product+administrative+init=3건)",
    log.trim().split("\n").length === 3
  );

  check(
    "C) fixture 실행 결과 completedTasks에 MOVAN 전용 task id가 전혀 섞이지 않음",
    !MOVAN_TASK_REGISTRY.some((t) => finalState.completedTasks.includes(t.id))
  );
  check("C) fixture registry id 공간과 MOVAN registry id 공간이 겹치지 않음", !FIXTURE_REGISTRY.some((f) => MOVAN_TASK_REGISTRY.some((m) => m.id === f.id)));
}

// ---------------------------------------------------------------------------
// D) 잘못된 명시적 Manifest는 MOVAN으로 조용히 fallback하지 않고 즉시 실패한다.
// ---------------------------------------------------------------------------
async function scenarioInvalidManifestFailsFastWithoutSilentFallback(): Promise<void> {
  let claudeRunnerCalled = false;
  const claudeRunnerShouldNeverRun = async (): Promise<ClaudeResult> => {
    claudeRunnerCalled = true;
    throw new Error("claudeRunner가 호출되면 안 된다 — invalid manifest는 실행 전에 실패해야 한다");
  };

  const NOWHERE_ROOT = join(tmpdir(), "autodev-manifest-nonexistent-root-" + Date.now());
  const NOWHERE_STATE = join(tmpdir(), "autodev-manifest-nonexistent-state-" + Date.now() + ".json");

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
    targetProjectRoot: MOVAN_PROJECT_MANIFEST.targetProjectRoot,
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
  let threwBadProjectId = false;
  try {
    validateProjectManifest({ ...MOVAN_PROJECT_MANIFEST, projectId: "" });
  } catch {
    threwBadProjectId = true;
  }
  check("D) projectId가 빈 문자열인 manifest는 validateProjectManifest에서 즉시 실패", threwBadProjectId);

  check("D) 위 invalid manifest 시나리오에서 claudeRunner가 한 번도 호출되지 않음(검증 단계에서 이미 차단)", !claudeRunnerCalled);
}

// ---------------------------------------------------------------------------
// E) Phase A Task A7 필수 테스트 A — manifest를 아예 지정하지 않으면(런타임에 undefined가
// 들어오는 경우까지 포함) MOVAN으로 조용히 fallback하지 않고 즉시 실패한다. TS 컴파일
// 타임에는 opts.manifest가 필수 필드라 아예 생략하면 컴파일 에러다 — 여기서는 컴파일된 JS를
// 호출하는 쪽이 실수로(또는 다른 언어에서) manifest를 빠뜨리는 상황까지 방어하는지 as
// unknown 캐스트로 흉내내 런타임 동작을 직접 증명한다.
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
  check("E) opts.manifest를 아예 생략(런타임)하면 즉시 실패(silent MOVAN fallback 없음)", threwOnMissingManifest);

  let threwOnUndefinedManifest = false;
  try {
    await runAutodevOnce({
      manifest: undefined as unknown as ProjectManifest,
      orchestratorDeps: { claudeRunner: claudeRunnerShouldNeverRun },
    });
  } catch {
    threwOnUndefinedManifest = true;
  }
  check("E) opts.manifest=undefined도 즉시 실패(silent MOVAN fallback 없음)", threwOnUndefinedManifest);
  check("E) manifest 누락 시나리오에서 claudeRunner가 한 번도 호출되지 않음", !claudeRunnerCalled);
}

async function main(): Promise<void> {
  const realStateBefore = readFileSync(DEFAULT_STATE_PATH, "utf-8");

  scenarioExplicitManifestRequiredNoSilentDefault();

  try {
    await scenarioFixtureManifestIsolatesFromMovan();
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

  // 회귀 방지: autodev.ts 소스에 MOVAN_TASK_REGISTRY 직접 import가 재도입되지 않았는지
  // 소스 스캔으로도 확인한다.
  const autodevSource = readFileSync(join(__dirname, "..", "src", "autodev.ts"), "utf-8");
  check(
    "소스 회귀: autodev.ts가 MOVAN_TASK_REGISTRY를 직접 import하지 않음(project-registries/movan에서 import 안 함)",
    !/from\s+"\.\/project-registries\/movan"/.test(autodevSource)
  );

  // Phase A Task A7 필수 테스트 A/B — autodev.ts(Core)는 MOVAN_PROJECT_MANIFEST를 전혀
  // import하지 않고(silent fallback 제거), run-movan.ts(MOVAN 전용 진입점)만 명시적으로
  // MOVAN_PROJECT_MANIFEST를 조립해 runAutodevOnce()에 넘긴다.
  check(
    "소스 회귀(A7-A): autodev.ts가 project-manifests/movan을 import하지 않음(Core는 MOVAN을 모름)",
    !/from\s+"\.\/project-manifests\/movan"/.test(autodevSource)
  );
  const runMovanSource = readFileSync(join(__dirname, "..", "src", "run-movan.ts"), "utf-8");
  check(
    "소스 회귀(A7-B): run-movan.ts가 project-manifests/movan에서 MOVAN_PROJECT_MANIFEST를 import함",
    /import\s*\{\s*MOVAN_PROJECT_MANIFEST\s*\}\s*from\s*"\.\/project-manifests\/movan"/.test(runMovanSource)
  );
  check(
    "소스 회귀(A7-B): run-movan.ts가 runAutodevOnce에 manifest: MOVAN_PROJECT_MANIFEST를 명시적으로 전달함",
    /runAutodevOnce\(\{\s*manifest:\s*MOVAN_PROJECT_MANIFEST\s*\}\)/.test(runMovanSource)
  );

  console.log("\n=== project-manifest(Project Manifest 최소 골격) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
