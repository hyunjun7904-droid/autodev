import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { runAutodevContinuous } from "./continuous-runner";
import type { AutodevRunResult } from "./autodev";
import { PLAN_MARKERS } from "./task-registry";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import type { ProjectState, ClaudeResult } from "./types";
import type { GptReviewerReturn } from "./orchestrator";
import {
  debugComputeLockFilePath,
  resolveCanonicalProjectPath,
  RUNTIME_LOCK_DIR,
  PROJECT_LOCK_SCHEMA_VERSION,
} from "./project-lock";
import type { ProjectLockMetadata } from "./project-lock";

// Generic Continuous Runner(continuous-runner.ts) 전용 회귀 테스트.
//
// 이 파일은 runAutodevOnce()가 이미 검증된 것으로 가정하고(§ autodev-tests.ts/
// project-lock-integration-tests.ts/remote-git-safety-tests.ts) "완료된 Task 다음에
// 다음 Task를 자동으로 실행할지"를 판단하는 이 얇은 loop 레이어 하나만 검증한다 — 실제
// Developer/Reviewer/checkpoint pipeline 내부 판정은 이 파일에서 다시 검증하지 않는다.
// 실제 Claude CLI/OpenAI API 호출은 전혀 없다(orchestratorDeps에 항상 결정적 fake를 주입).
// 특정 프로젝트(JARVIS/MOVAN 등) 이름은 이 파일 어디에도 없다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
const leftoverLockFiles: string[] = [];

function makeTempGitRepo(prefix = "continuous-runner-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "continuous-runner-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Continuous Runner Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function baseState(overrides: Partial<ProjectState>): ProjectState {
  return {
    currentPhase: 1,
    gitCheckpoint: "test",
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "READY",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
    ...overrides,
  } as ProjectState;
}

function makeTempStateFile(dir: string, overrides: Partial<ProjectState> = {}): string {
  const statePath = join(dir, ".autodev", "project-state.json");
  mkdirSync(join(dir, ".autodev"), { recursive: true });
  writeFileSync(statePath, JSON.stringify(baseState(overrides), null, 2) + "\n", "utf-8");
  return statePath;
}

function writeRepoFile(repo: string, relPath: string, content: string): void {
  const abs = join(repo, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

// 3개 task(전부 non-human-gate) — "여러 Task 자동 연속 실행 → 마지막에 project complete로
// STOP"을 흉내내는 최소 fixture. 특정 프로젝트를 흉내내지 않는다(§ Task Prompt 절대 원칙).
const CR_FIXTURE_REGISTRY: TaskDefinition[] = [
  { id: "T1", phase: 1, taskNumber: 1, title: "Task1", prompt: "Task1 prompt", requiredTests: [], allowedPathPrefixes: ["proj/"], prohibitedOperations: [] },
  { id: "T2", phase: 1, taskNumber: 2, title: "Task2", prompt: "Task2 prompt", requiredTests: [], allowedPathPrefixes: ["proj/"], prohibitedOperations: [] },
  { id: "T3", phase: 1, taskNumber: 3, title: "Task3", prompt: "Task3 prompt", requiredTests: [], allowedPathPrefixes: ["proj/"], prohibitedOperations: [] },
];

const CR_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["proj/"],
  allowedWritePrefixes: ["proj/"],
  allowedCommands: [],
};

function buildManifest(root: string, statePath: string, overrides: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    projectId: "continuous-runner-fixture-project",
    projectName: "Continuous Runner Fixture Project",
    targetProjectRoot: root,
    statePath,
    taskRegistry: CR_FIXTURE_REGISTRY,
    developerInstructions: "허용 범위: proj/**. Continuous Runner 회귀만 다루는 fixture입니다.",
    reviewInstructions: "proj/** 범위 밖 변경이 있으면 반드시 REVISE하세요.",
    reviewScopeDirs: ["proj/"],
    executionPolicy: CR_EXECUTION_POLICY,
    ...overrides,
  };
}

function fakePassReviewer(): () => Promise<GptReviewerReturn> {
  return async () => ({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "테스트: 문제 없음", nextTask: null });
}

/** task 프롬프트별로 서로 다른 marker 파일을 만드는 claudeRunner — 실제로 어떤 task가
 *  실행됐는지(호출 횟수/순서)를 나중에 검증할 수 있게 한다. */
function makeMarkerClaudeRunner(repo: string, calls: string[]): (task: string) => Promise<ClaudeResult> {
  return async (task: string): Promise<ClaudeResult> => {
    calls.push(task);
    const fileName = `proj/marker-${calls.length}.txt`;
    writeRepoFile(repo, fileName, task);
    return { success: true, summary: `테스트: ${task} 완료`, changedFiles: [fileName], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };
}

// ---------------------------------------------------------------------------
// A/D/H/J — 여러 Task 자동 연속 실행 → project complete에서 STOP. 각 task exactly once,
// HFR OFF(기본값)에서 checkpoint 직후 바로 다음 task로 이어짐, checkpoint가 task당 정확히
// 한 번만 생성됨을 함께 검증한다.
// ---------------------------------------------------------------------------
async function scenarioMultiTaskContinuousToProjectComplete(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: [] });
  const manifest = buildManifest(repo, statePath);

  const calls: string[] = [];
  const claudeRunner = makeMarkerClaudeRunner(repo, calls);

  const result = await runAutodevContinuous({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check("A) 총 4회 호출(task 3개 완료 + 마지막 '더 이상 없음' 확인 1회)", result.iterations.length === 4);
  check("A) iteration1 taskId=T1, outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", result.iterations[0].result.taskId === "T1" && result.iterations[0].result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("D) HFR OFF: iteration1 checkpoint 직후 바로 next task로 이어짐(iteration2 taskId=T2)", result.iterations[1].result.taskId === "T2");
  check("A) iteration3 taskId=T3", result.iterations[2].result.taskId === "T3");
  check("H) 마지막 iteration4는 outcome=STOPPED(project complete)", result.iterations[3].result.outcome === "STOPPED");
  check("H) stop.kind=OUTCOME_STOP, outcome=STOPPED", result.stop.kind === "OUTCOME_STOP" && result.stop.outcome === "STOPPED");
  check("H) 추가 호출 없음(정확히 4회로 종료)", result.iterations.length === 4);

  check("A) developer(claudeRunner)가 task 3개에 대해 정확히 3회만 호출됨(exactly once)", calls.length === 3);
  check("A) 호출 순서가 Task1→Task2→Task3", calls.join(",") === "Task1 prompt,Task2 prompt,Task3 prompt");

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("A) completedTasks=[T1,T2,T3]", JSON.stringify(finalState.completedTasks) === JSON.stringify(["T1", "T2", "T3"]));
  check("H) 마지막 상태=PROJECT_COMPLETE(비-human-gate 마지막 task)", finalState.status === PLAN_MARKERS.PROJECT_COMPLETE);

  // J) checkpoint exactly once — 3개 task 각각 서로 다른 commit hash를 정확히 한 번씩만 받음.
  const checkpointHashes = result.iterations.slice(0, 3).map((r) => r.result.checkpoint?.commitHash);
  check("J) 3개 task 모두 checkpoint.ok=true", result.iterations.slice(0, 3).every((r) => r.result.checkpoint?.ok === true));
  check("J) 3개 commit hash가 서로 다름(중복 checkpoint 없음)", new Set(checkpointHashes).size === 3);
  const log = (spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "").trim().split("\n");
  check("J) git log에 init 1건 + task당 2건(product+admin)×3 = 7건만 존재", log.length === 7);

  // J) 추가 보장 — continuous runner가 끝난 뒤 supervisor가 실수로 한 번 더 단발 호출해도
  // (예: run.ts의 기존 단발 호출 경로) project complete 상태이므로 checkpoint가 다시 생기지
  // 않는다(§ decideNextAction의 기존 exactly-once 보장을 그대로 재사용 — 새 로직 없음).
  const extraOnce = await runAutodevContinuous({ manifest, maxIterations: 1 }, {});
  check("J) project complete 이후 재호출은 outcome=STOPPED(checkpoint 재생성 없음)", extraOnce.iterations[0].result.outcome === "STOPPED");
  const logAfterExtra = (spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "").trim().split("\n");
  check("J) 재호출 후에도 commit 수 그대로 7건(추가 commit 없음)", logAfterExtra.length === 7);
}

// ---------------------------------------------------------------------------
// B — 이미 WAITING_HUMAN인 상태에서 시작하면 즉시 STOP, 어떤 task도 실행되지 않는다.
// ---------------------------------------------------------------------------
async function scenarioWaitingHumanStopsImmediately(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { status: "WAITING_HUMAN", completedTasks: [] });
  const manifest = buildManifest(repo, statePath);

  const calls: string[] = [];
  const claudeRunner = makeMarkerClaudeRunner(repo, calls);

  const result = await runAutodevContinuous({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check("B) WAITING_HUMAN: 정확히 1회만 호출되고 즉시 STOP", result.iterations.length === 1);
  check("B) outcome=STOPPED", result.iterations[0].result.outcome === "STOPPED");
  check("B) Task2(또는 어떤 task도) 실행되지 않음(developer 호출 0회)", calls.length === 0);
  check("B) stop.kind=OUTCOME_STOP(outcome=STOPPED)", result.stop.kind === "OUTCOME_STOP" && result.stop.outcome === "STOPPED");
}

// ---------------------------------------------------------------------------
// C — Human Final Review(HFR) ON: reviewer PASS → HFR PENDING → 즉시 STOP, 다음 task 실행 금지.
// ---------------------------------------------------------------------------
async function scenarioHumanFinalReviewPendingStopsImmediately(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: [] });
  const manifest = buildManifest(repo, statePath, { humanFinalReviewPolicy: { enabled: true } });

  const calls: string[] = [];
  const claudeRunner = makeMarkerClaudeRunner(repo, calls);

  const result = await runAutodevContinuous({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check("C) HFR ON: 정확히 1회만 호출되고 즉시 STOP(Task2 실행 금지)", result.iterations.length === 1);
  check("C) outcome=RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW", result.iterations[0].result.outcome === "RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW");
  check("C) developer는 T1에 대해서만 1회 호출됨(T2는 호출 안 됨)", calls.length === 1);
  check("C) stop.kind=OUTCOME_STOP(outcome=RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW)", result.stop.kind === "OUTCOME_STOP" && result.stop.outcome === "RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW");

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("C) status=WAITING_HUMAN, humanFinalReview.status=PENDING", finalState.status === "WAITING_HUMAN" && finalState.humanFinalReview?.status === "PENDING");
  check("C) completedTasks 변화 없음", finalState.completedTasks.length === 0);
}

// ---------------------------------------------------------------------------
// E — checkpoint 자체가 BLOCK(허용 경로 밖 변경) → 즉시 STOP, 다음 task 실행 금지.
// ---------------------------------------------------------------------------
async function scenarioCheckpointBlockedStopsImmediately(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: [] });
  const manifest = buildManifest(repo, statePath);

  const calls: string[] = [];
  const claudeRunner = async (task: string): Promise<ClaudeResult> => {
    calls.push(task);
    writeRepoFile(repo, "other/unexpected.txt", "허용 경로 밖 변경");
    return { success: true, summary: "테스트: 허용 경로 밖 변경", changedFiles: ["other/unexpected.txt"], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };

  const result = await runAutodevContinuous({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check("E) checkpoint BLOCK: 정확히 1회만 호출되고 즉시 STOP", result.iterations.length === 1);
  check("E) outcome=RAN_TASK_CHECKPOINT_BLOCKED", result.iterations[0].result.outcome === "RAN_TASK_CHECKPOINT_BLOCKED");
  check("E) T2는 실행되지 않음", calls.length === 1);
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("E) completedTasks 변화 없음, status=WAITING_HUMAN", finalState.completedTasks.length === 0 && finalState.status === "WAITING_HUMAN");
}

// ---------------------------------------------------------------------------
// F — Required Test 실패 → REVISE 반복 → REVIEW_CYCLE_EXHAUSTED → STOP, 다음 task 실행 금지.
// ---------------------------------------------------------------------------
async function scenarioRequiredTestFailureStopsImmediately(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: [] });
  const manifest = buildManifest(repo, statePath);

  const calls: string[] = [];
  const claudeRunner = async (task: string): Promise<ClaudeResult> => {
    calls.push(task);
    return { success: true, summary: "테스트: required test 실패", changedFiles: [], tests: [{ name: "proj:check", pass: false }], rawOutput: "" };
  };
  const passReviewerDespiteFailure = fakePassReviewer(); // reviewer가 PASS라고 해도 실패한
  // required test는 orchestrator.ts의 기존 강제 REVISE 안전장치(hasFailedRequiredTest)가
  // 덮어쓴다 — 이 파일은 그 판정을 다시 구현하지 않고 결과(outcome)만 관찰한다.

  const result = await runAutodevContinuous({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: passReviewerDespiteFailure } });

  check("F) required test 실패: 정확히 1회만 호출되고 즉시 STOP", result.iterations.length === 1);
  check("F) outcome=RAN_TASK_NOT_APPROVED", result.iterations[0].result.outcome === "RAN_TASK_NOT_APPROVED");
  check("F) T2는 실행되지 않음(developer는 T1에 대해서만 REVISE 반복 호출됨)", calls.every((c) => c === "Task1 prompt"));
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("F) completedTasks 변화 없음", finalState.completedTasks.length === 0);
}

// ---------------------------------------------------------------------------
// G — Secret Scanner Gate(보안) BLOCK → 즉시 STOP, 다음 task 실행 금지.
// ---------------------------------------------------------------------------
async function scenarioSecretScannerBlockStopsImmediately(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: [] });
  const manifest = buildManifest(repo, statePath);

  const calls: string[] = [];
  const claudeRunner = async (task: string): Promise<ClaudeResult> => {
    calls.push(task);
    // AWS access key id 형태(AKIA+16자) — secret-scanner.ts가 이미 검증하는 패턴을 그대로
    // 재사용한다(§ secret-scanner-tests.ts) — 새 탐지 로직을 이 파일에서 만들지 않는다.
    writeRepoFile(repo, "proj/leak.txt", "AKIA" + "ABCDEFGHIJKLMNOP");
    return { success: true, summary: "테스트: secret 포함", changedFiles: ["proj/leak.txt"], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };

  const result = await runAutodevContinuous({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check("G) secret scanner BLOCK: 정확히 1회만 호출되고 즉시 STOP", result.iterations.length === 1);
  check("G) outcome=RAN_TASK_CHECKPOINT_BLOCKED", result.iterations[0].result.outcome === "RAN_TASK_CHECKPOINT_BLOCKED");
  check("G) secretFindings가 실제로 기록됨(보안 게이트가 실제로 걸림)", (result.iterations[0].result.checkpoint?.secretFindings?.length ?? 0) > 0);
  check("G) T2는 실행되지 않음", calls.length === 1);
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("G) completedTasks 변화 없음, status=WAITING_HUMAN", finalState.completedTasks.length === 0 && finalState.status === "WAITING_HUMAN");
}

// ---------------------------------------------------------------------------
// I — no-progress/livelock 방어. 실제 runAutodevOnce()는 완료된 task를 다시 완료로 보고하지
// 않으므로(§ completedTasks가 실제 disk state), 이 방어 자체는 loop 레벨의 결정적 test
// seam(ContinuousRunnerTestDeps.runOnce)으로 직접 검증한다 — production 경로(run.ts)는 이
// seam을 쓰지 않는다.
// ---------------------------------------------------------------------------
async function scenarioLivelockAndMaxIterationsProtection(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath);

  // I-1) 같은 taskId가 두 번째에도 다시 "완료"로 보고됨 → 2회만 호출되고 fail-closed STOP.
  let dupCalls = 0;
  const dupRunOnce = async (): Promise<AutodevRunResult> => {
    dupCalls += 1;
    return { outcome: "RAN_TASK_APPROVED_AND_CHECKPOINTED", taskId: "T1" };
  };
  const dupResult = await runAutodevContinuous({ manifest, maxIterations: 50 }, { runOnce: dupRunOnce });
  check("I-1) 같은 taskId 반복 보고 시 무한루프 없이 2회 호출 후 정지", dupCalls === 2 && dupResult.iterations.length === 2);
  check("I-1) stop.kind=LIVELOCK_NO_PROGRESS(taskId=T1)", dupResult.stop.kind === "LIVELOCK_NO_PROGRESS" && dupResult.stop.taskId === "T1");

  // I-2) 매번 새로운(서로 다른) taskId가 계속 완료로 보고됨(livelock 아님) → livelock 판정에는
  // 안 걸리지만, 명시적 maxIterations(=registry 크기와 무관하게 호출부가 3으로 지정) backstop이
  // 정확히 그 횟수에서 멈춘다(임의 상수가 아니라 호출부가 명시한 상한을 그대로 존중).
  let freshCalls = 0;
  const freshRunOnce = async (): Promise<AutodevRunResult> => {
    freshCalls += 1;
    return { outcome: "RAN_TASK_APPROVED_AND_CHECKPOINTED", taskId: `FRESH-${freshCalls}` };
  };
  const freshResult = await runAutodevContinuous({ manifest, maxIterations: 3 }, { runOnce: freshRunOnce });
  check("I-2) livelock 없이 계속 진행되는 경우에도 maxIterations=3에서 정확히 멈춤", freshCalls === 3 && freshResult.iterations.length === 3);
  check("I-2) stop.kind=MAX_ITERATIONS_REACHED(3)", freshResult.stop.kind === "MAX_ITERATIONS_REACHED" && freshResult.stop.maxIterations === 3);

  // I-3) 기본 maxIterations는 manifest.taskRegistry.length + 1(임의 상수가 아님)임을 직접 확인.
  let boundCalls = 0;
  const alwaysContinuable = async (): Promise<AutodevRunResult> => {
    boundCalls += 1;
    return { outcome: "RAN_TASK_APPROVED_AND_CHECKPOINTED", taskId: `B-${boundCalls}` };
  };
  const boundResult = await runAutodevContinuous({ manifest }, { runOnce: alwaysContinuable });
  check(
    "I-3) 기본 maxIterations=taskRegistry.length+1(=4)에서 정확히 멈춤",
    boundCalls === CR_FIXTURE_REGISTRY.length + 1 && boundResult.stop.kind === "MAX_ITERATIONS_REACHED"
  );
}

// ---------------------------------------------------------------------------
// Project Lock 우회 없음 — 다른 프로세스가 이미 이 project를 쓰고 있으면 첫 호출에서 즉시
// BLOCKED_PROJECT_LOCK으로 멈추고, 다음 task를 시도하지 않는다(§ project-lock.ts를 그대로
// 재사용 — 새 lock 판정 로직 없음).
// ---------------------------------------------------------------------------
function seedForeignLock(projectId: string, root: string): { release: () => void } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"]);
  const canonical = resolveCanonicalProjectPath(root);
  const filePath = debugComputeLockFilePath(canonical, RUNTIME_LOCK_DIR);
  const meta: ProjectLockMetadata = {
    schemaVersion: PROJECT_LOCK_SCHEMA_VERSION,
    projectId,
    canonicalProjectPath: canonical,
    lockId: "foreign-owner-lock-id",
    pid: child.pid as number,
    processStartedAtMs: Date.now(),
    lockCreatedAt: new Date().toISOString(),
    ownerKind: "autodev",
  };
  if (!existsSync(RUNTIME_LOCK_DIR)) mkdirSync(RUNTIME_LOCK_DIR, { recursive: true });
  writeFileSync(filePath, JSON.stringify(meta), "utf-8");
  leftoverLockFiles.push(filePath);
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

async function scenarioProjectLockPreserved(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: [] });
  const manifest = buildManifest(repo, statePath, { projectId: "continuous-runner-lock-fixture" });

  const foreign = seedForeignLock("continuous-runner-lock-fixture", repo);
  try {
    const calls: string[] = [];
    const claudeRunner = makeMarkerClaudeRunner(repo, calls);
    const result = await runAutodevContinuous({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

    check("Project Lock: 다른 프로세스가 이미 쓰는 중이면 1회만 시도되고 즉시 STOP", result.iterations.length === 1);
    check("Project Lock: outcome=BLOCKED_PROJECT_LOCK", result.iterations[0].result.outcome === "BLOCKED_PROJECT_LOCK");
    check("Project Lock: developer가 전혀 호출되지 않음", calls.length === 0);
  } finally {
    foreign.release();
  }
}

// ---------------------------------------------------------------------------
// Remote Git Safety 우회 없음 — remote가 시작 시점에 이미 앞서 있으면 첫 호출에서 즉시
// BLOCKED_REMOTE_GIT으로 멈추고, 다음 task를 시도하지 않는다(§ remote-git-safety.ts를 그대로
// 재사용 — 새 판정 로직 없음).
// ---------------------------------------------------------------------------
function makeTempGitRepoWithOrigin(): { repo: string; origin: string } {
  const origin = mkdtempSync(join(tmpdir(), "continuous-runner-rgs-origin-"));
  tempDirs.push(origin);
  spawnSync("git", ["init", "-q", "--bare", "--initial-branch=main"], { cwd: origin });

  const seedParent = mkdtempSync(join(tmpdir(), "continuous-runner-rgs-seed-"));
  tempDirs.push(seedParent);
  const seedRepo = join(seedParent, "repo");
  spawnSync("git", ["clone", "-q", origin, seedRepo], { cwd: seedParent });
  spawnSync("git", ["config", "user.email", "continuous-runner-test@example.com"], { cwd: seedRepo });
  spawnSync("git", ["config", "user.name", "Continuous Runner Test"], { cwd: seedRepo });
  writeFileSync(join(seedRepo, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: seedRepo });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: seedRepo });
  spawnSync("git", ["push", "-q", "-u", "origin", "HEAD:refs/heads/main"], { cwd: seedRepo });

  const clonesParent = mkdtempSync(join(tmpdir(), "continuous-runner-rgs-clone-"));
  tempDirs.push(clonesParent);
  const repo = join(clonesParent, "repo");
  spawnSync("git", ["clone", "-q", origin, repo], { cwd: clonesParent });
  spawnSync("git", ["config", "user.email", "continuous-runner-test@example.com"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "Continuous Runner Test"], { cwd: repo });

  return { repo, origin };
}

function pushExtraCommitToOrigin(origin: string, fileName: string): void {
  const parent = mkdtempSync(join(tmpdir(), "continuous-runner-rgs-other-"));
  tempDirs.push(parent);
  const other = join(parent, "repo");
  spawnSync("git", ["clone", "-q", origin, other], { cwd: parent });
  spawnSync("git", ["config", "user.email", "other-writer@example.com"], { cwd: other });
  spawnSync("git", ["config", "user.name", "Other Writer"], { cwd: other });
  writeFileSync(join(other, fileName), "external change\n", "utf-8");
  spawnSync("git", ["add", "--", fileName], { cwd: other });
  spawnSync("git", ["commit", "-q", "-m", "external commit"], { cwd: other });
  spawnSync("git", ["push", "-q", "origin", "HEAD:refs/heads/main"], { cwd: other });
}

async function scenarioRemoteGitSafetyPreserved(): Promise<void> {
  const { repo, origin } = makeTempGitRepoWithOrigin();
  const statePath = makeTempStateFile(repo, { completedTasks: [] });
  const manifest = buildManifest(repo, statePath, { remoteGitSafety: {} });
  pushExtraCommitToOrigin(origin, "external-before-start.txt"); // repo가 이제 stale(REMOTE_AHEAD).

  const calls: string[] = [];
  const claudeRunner = makeMarkerClaudeRunner(repo, calls);
  const result = await runAutodevContinuous({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check("Remote Git Safety: remote가 앞서 있으면 1회만 시도되고 즉시 STOP", result.iterations.length === 1);
  check("Remote Git Safety: outcome=BLOCKED_REMOTE_GIT", result.iterations[0].result.outcome === "BLOCKED_REMOTE_GIT");
  check("Remote Git Safety: developer가 전혀 호출되지 않음", calls.length === 0);
}

async function main(): Promise<void> {
  try {
    await scenarioMultiTaskContinuousToProjectComplete();
    await scenarioWaitingHumanStopsImmediately();
    await scenarioHumanFinalReviewPendingStopsImmediately();
    await scenarioCheckpointBlockedStopsImmediately();
    await scenarioRequiredTestFailureStopsImmediately();
    await scenarioSecretScannerBlockStopsImmediately();
    await scenarioLivelockAndMaxIterationsProtection();
    await scenarioProjectLockPreserved();
    await scenarioRemoteGitSafetyPreserved();
  } finally {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 디렉터리 정리 실패는 테스트 결과에 영향 없음
      }
    }
    for (const f of leftoverLockFiles) {
      try {
        rmSync(f, { force: true });
      } catch {
        // 이미 release()에서 정리됐을 수 있음 — 무시
      }
    }
  }

  // 회귀 방지: continuous-runner.ts가 새로운 Developer/Reviewer/checkpoint pipeline을
  // 복제하지 않고 runAutodevOnce()만 재사용하는지 소스 스캔으로도 확인한다.
  const source = readFileSync(join(__dirname, "..", "src", "continuous-runner.ts"), "utf-8");
  check("소스 회귀: continuous-runner.ts가 runAutodevOnce를 import함(재사용)", /import\s*\{\s*runAutodevOnce\s*\}\s*from\s*"\.\/autodev"/.test(source));
  // 파일 상단 주석이 "AutoDev는 JARVIS/MOVAN/BILLION 전용이 아니다"를 설명하며 프로젝트
  // 이름을 예시로 "언급"하는 것 자체는 괜찮다 — 여기서 금지하는 것은 실제 분기 코드
  // (projectId === "JARVIS" 같은 조건문)다.
  check(
    "소스 회귀: continuous-runner.ts에 프로젝트 이름 기반 분기 코드 없음(projectId === \"JARVIS\" 등)",
    !/projectId\s*===\s*["'](JARVIS|MOVAN|BILLION)["']/i.test(source)
  );
  check(
    "소스 회귀: continuous-runner.ts가 checkpoint/git commit을 직접 만들지 않음(performTaskCheckpoint 미참조)",
    !/performTaskCheckpoint/.test(source)
  );

  console.log("\n=== continuous-runner 회귀 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
