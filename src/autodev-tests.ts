import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { decideNextAction, runAutodevOnce, approveHumanFinalReview, rejectHumanFinalReview } from "./autodev";
import { DEFAULT_STATE_PATH, loadState, saveState } from "./state";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import type { ProjectState, ClaudeResult } from "./types";
import type { GptReviewerReturn } from "./orchestrator";
import { MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT } from "./orchestrator";
import { createInMemoryEventStore } from "./event-store";
import { classifyEventForNotification } from "./notification";
import type { ProblemMemoryStore, ProblemMemoryEntry } from "./problem-memory";
import type { RealClaudeResult } from "./claude-runner";
import { inspectProjectRuntimeLiveness } from "./project-lock";
import { deriveAllowedCommandsFromRequiredTests } from "./execution-contract";

// 이 파일은 두 계층을 검증한다:
//   A) decideNextAction() — 순수 함수, 부수효과 없음(task-registry 엔진 + fixture registry
//      데이터 기반 다음 task 선택. autodev.ts가 이 둘을 배선한다).
//   B) runAutodevOnce() — 실제 orchestrator/checkpoint 배선까지 포함한 통합 시나리오.
//      claudeRunner/gptReviewer는 항상 fake로 주입해 실제 Claude CLI/OpenAI API를 호출하지
//      않는다. project-state.json/git commit은 전부 OS 임시 디렉터리 안에서만 일어나며,
//      실제 automation/config/project-state.json과 실제 프로젝트 repo는 어떤 시나리오에서도
//      건드리지 않는다(끝에서 실제 state 파일 내용을 read하여 증명한다).
//
// Phase B Task B3 — 이 파일은 이제 어떤 특정 프로젝트(MOVAN 포함)의 registry/manifest도
// import하지 않는다. 여러 Phase에 걸친 순차 진행/최종 human gate 같은 planner 동작은
// 이 파일 안에서 스스로 만든 다중 Phase fixture registry로 증명한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function baseState(overrides: Partial<ProjectState>): ProjectState {
  return {
    currentPhase: 1,
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

// ---------------------------------------------------------------------------
// 다중 Phase fixture registry — 특정 프로젝트를 흉내내지 않는다. Phase1(2개 task) →
// Phase2(2개 task, 마지막이 isHumanGate) 순서로, planner의 "같은 Phase 안 다음 task
// 선택 → Phase 전환 → 마지막 human gate → 전부 완료 시 STOP" 동작을 전부 검증할 수 있게
// 구성했다.
// ---------------------------------------------------------------------------
const PLANNER_FIXTURE_REGISTRY: TaskDefinition[] = [
  { id: "P1.1", phase: 1, taskNumber: 1, title: "Phase1 Task1", prompt: "Phase1 Task1 prompt", requiredTests: [], allowedPathPrefixes: ["proj/"], prohibitedOperations: [] },
  { id: "P1.2", phase: 1, taskNumber: 2, title: "Phase1 Task2", prompt: "Phase1 Task2 prompt", requiredTests: [], allowedPathPrefixes: ["proj/"], prohibitedOperations: [] },
  { id: "P2.1", phase: 2, taskNumber: 1, title: "Phase2 Task1", prompt: "Phase2 Task1 prompt", requiredTests: [], allowedPathPrefixes: ["proj/"], prohibitedOperations: [] },
  {
    id: "P2.2",
    phase: 2,
    taskNumber: 2,
    title: "Phase2 Task2(final human gate)",
    prompt: "Phase2 Task2 prompt",
    requiredTests: [],
    allowedPathPrefixes: ["proj/"],
    prohibitedOperations: [],
    isHumanGate: true,
  },
];

function idsUpTo(taskId: string): string[] {
  const idx = PLANNER_FIXTURE_REGISTRY.findIndex((t) => t.id === taskId);
  if (idx === -1) throw new Error(`알 수 없는 task id: ${taskId}`);
  return PLANNER_FIXTURE_REGISTRY.slice(0, idx + 1).map((t) => t.id);
}

function allTaskIds(): string[] {
  return PLANNER_FIXTURE_REGISTRY.map((t) => t.id);
}

// ---------------------------------------------------------------------------
// A) planner(decideNextAction) — 순수 함수 시나리오
// ---------------------------------------------------------------------------
function scenarioPlannerPhase1Task1DoneSelectsTask2(): void {
  const state = baseState({ status: "READY", completedTasks: ["P1.1"] });
  const decision = decideNextAction(state, PLANNER_FIXTURE_REGISTRY);
  check("planner: Phase1 Task1 완료 → Task2 선택(kind=RUN_TASK)", decision.kind === "RUN_TASK");
  check("planner: 선택된 task.id === 'P1.2'", decision.kind === "RUN_TASK" && decision.task.id === "P1.2");
}

function scenarioPlannerPhaseLastTaskTransitionsToNextPhase(): void {
  // Phase1의 마지막 task(P1.2)까지 완료 → Phase2 첫 task(P2.1)로 전환.
  const state = baseState({ status: "READY", completedTasks: idsUpTo("P1.2") });
  const decision = decideNextAction(state, PLANNER_FIXTURE_REGISTRY);
  check("planner: phase 마지막 task(P1.2) 완료 → 다음 phase 전환(kind=RUN_TASK)", decision.kind === "RUN_TASK");
  check(
    "planner: 선택된 task가 Phase2 Task1(P2.1)",
    decision.kind === "RUN_TASK" && decision.task.id === "P2.1" && decision.task.phase === 2
  );
}

function scenarioPlannerFinalGateIsSelected(): void {
  // Phase2 Task1(P2.1)까지 완료 → 마지막 task(P2.2, isHumanGate)가 선택되어야 한다.
  const state = baseState({ status: "READY", completedTasks: idsUpTo("P2.1") });
  const decision = decideNextAction(state, PLANNER_FIXTURE_REGISTRY);
  check("planner: Phase2 Task1 완료 → Task2(P2.2, final gate) 선택", decision.kind === "RUN_TASK" && decision.task.id === "P2.2");
  check("planner: 선택된 task가 isHumanGate=true", decision.kind === "RUN_TASK" && decision.task.isHumanGate === true);
}

function scenarioPlannerAllTasksDoneIsFinalGateStop(): void {
  // registry의 모든 task(P2.2 포함)까지 전부 완료 → 더 이상 자동 실행할 task가 없다.
  const state = baseState({ status: "READY", completedTasks: allTaskIds() });
  const decision = decideNextAction(state, PLANNER_FIXTURE_REGISTRY);
  check("planner: 마지막(P2.2)까지 전부 완료 → STOP(final gate)", decision.kind === "STOP");
  check(
    "planner: STOP 사유에 배포/사람 확인 관련 안내 포함",
    decision.kind === "STOP" && (decision.reason.includes("배포") || decision.reason.includes("DEPLOYMENT_WAITING_HUMAN"))
  );
}

function scenarioPlannerWaitingHumanStaysStopped(): void {
  const state = baseState({ status: "WAITING_HUMAN", completedTasks: ["P1.1"] });
  const decision = decideNextAction(state, PLANNER_FIXTURE_REGISTRY);
  check("planner: WAITING_HUMAN 상태 유지 시에도 STOP 결정", decision.kind === "STOP");
  check(
    "planner: WAITING_HUMAN에서는 재저장 불필요(setWaitingHuman=false)",
    decision.kind === "STOP" && decision.setWaitingHuman === false
  );
}

// AutoDev Core Maintenance — Crash-safe Checkpoint Resume(Category B). Reviewer가 PASS해
// runOrchestrator()가 setStatus("APPROVED") 후 저장한 직후 프로세스가 죽었다가 재시작되는
// 시나리오를 decideNextAction() 단독으로(순수 함수, 부수효과 없음) 검증한다 — 이 상태는
// Human Final Review와 무관하게(gate 없이도) 발생할 수 있다.
function scenarioPlannerApprovedStatusResumesCheckpointWithoutHumanFinalReview(): void {
  const target = PLANNER_FIXTURE_REGISTRY.find((t) => t.id === "P1.2")!;
  const state = baseState({
    status: "APPROVED",
    completedTasks: ["P1.1"],
    currentTask: target.prompt,
    lastGptDecision: { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "테스트", nextTask: null },
  });
  const decision = decideNextAction(state, PLANNER_FIXTURE_REGISTRY);
  check("planner: status=APPROVED(HFR 게이트 없음) → RESUME_APPROVED_CHECKPOINT", decision.kind === "RESUME_APPROVED_CHECKPOINT");
  check(
    "planner: resume 대상이 정확히 P1.2",
    decision.kind === "RESUME_APPROVED_CHECKPOINT" && decision.task.id === "P1.2"
  );
}

function scenarioPlannerApprovedStatusWithoutPassDecisionDoesNotResume(): void {
  // lastGptDecision이 PASS가 아니면(예: 손상/불일치) 모호하므로 resume하지 않고 기존 경로
  // (RUN_TASK — Developer/Reviewer 재실행)로 fail-closed한다.
  const state = baseState({
    status: "APPROVED",
    completedTasks: ["P1.1"],
    currentTask: "Phase1 Task2 prompt",
    lastGptDecision: { decision: "REVISE", severity: { critical: 0, high: 0, medium: 0 }, feedback: "테스트", nextTask: null },
  });
  const decision = decideNextAction(state, PLANNER_FIXTURE_REGISTRY);
  check("planner: status=APPROVED이지만 lastGptDecision!=PASS → resume하지 않음(RUN_TASK)", decision.kind === "RUN_TASK");
}

function scenarioPlannerApprovedStatusWithMismatchedCurrentTaskDoesNotResume(): void {
  // currentTask(taskDef.prompt 원문)가 getNextTask()가 지금 반환하는 task의 prompt와 다르면
  // (예: 다른 task의 stale APPROVED) 모호하므로 resume하지 않는다.
  const state = baseState({
    status: "APPROVED",
    completedTasks: ["P1.1"],
    currentTask: "이 registry의 어떤 task와도 일치하지 않는 임의 문자열",
    lastGptDecision: { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "테스트", nextTask: null },
  });
  const decision = decideNextAction(state, PLANNER_FIXTURE_REGISTRY);
  check("planner: status=APPROVED이지만 currentTask 불일치 → resume하지 않음(RUN_TASK)", decision.kind === "RUN_TASK");
}

// ---------------------------------------------------------------------------
// B) runAutodevOnce — orchestrator/checkpoint까지 포함한 통합 시나리오
// ---------------------------------------------------------------------------
const tempDirs: string[] = [];

const PLANNER_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["proj/"],
  allowedWritePrefixes: ["proj/"],
  allowedCommands: [],
};

function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-integration-"));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "autodev-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "AutoDev Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function makeTempStateFile(dir: string, overrides: Partial<ProjectState> = {}): string {
  const statePath = join(dir, ".autodev", "project-state.json");
  mkdirSync(join(dir, ".autodev"), { recursive: true });
  const state = baseState({ status: "READY", completedTasks: ["P1.1"], ...overrides });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  return statePath;
}

function writeRepoFile(repo: string, relPath: string, content: string): void {
  const abs = join(repo, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function buildPlannerManifest(root: string, statePath: string): ProjectManifest {
  return {
    projectId: "planner-fixture-project",
    projectName: "Planner Fixture Project",
    targetProjectRoot: root,
    statePath,
    taskRegistry: PLANNER_FIXTURE_REGISTRY,
    developerInstructions: "허용 범위: proj/**. 이 fixture 프로젝트의 다중 Phase 순차 진행만 다룹니다.",
    reviewInstructions: "proj/** 범위 밖 변경이 있으면 반드시 REVISE하세요.",
    reviewScopeDirs: ["proj/"],
    executionPolicy: PLANNER_EXECUTION_POLICY,
  };
}

// Minimal HUMAN_FINAL_REVIEW Runtime Checkpoint Gate는 project가 명시적으로 opt-in해야만
// 켜진다(§ project-manifest.ts ProjectManifest.humanFinalReviewPolicy) — buildPlannerManifest()
// 자체는 opt-in하지 않는다(기본값 OFF, 위 A)/B)의 나머지 시나리오는 전부 이 Gate와 무관하게
// 기존 AutoDev 동작을 그대로 검증한다). 이 Gate 자체를 검증하는 시나리오(아래 E)만 이 변형을
// 쓴다 — buildPlannerManifestWithRemoteGitSafety와 동일한 "기존 manifest 위에 opt-in 필드만
// 추가" 패턴이다.
function buildPlannerManifestWithHumanFinalReview(root: string, statePath: string): ProjectManifest {
  return { ...buildPlannerManifest(root, statePath), humanFinalReviewPolicy: { enabled: true } };
}

function fakePassReviewer(): (result: ClaudeResult, reviewCycle: number, task: string, allowedPathPrefixes?: string[]) => Promise<GptReviewerReturn> {
  return async () => ({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "테스트: 문제 없음", nextTask: null });
}

// ---------------------------------------------------------------------------
// C) Phase G Task G7.3 — manifest.remoteGitSafety가 지정된 project에서 Remote Safety Gate가
//    실제로 runAutodevOnce()에 배선되는지 통합 검증한다(세부 판정 로직 자체의 회귀는
//    remote-git-safety-tests.ts가 전담 — 여기서는 "opt-in 배선이 실제로 동작하는지"만
//    확인한다). manifest.remoteGitSafety를 지정하지 않는 위 A)/B) 시나리오는 전부 이 Gate와
//    무관하게 기존 그대로 동작한다(remote가 없는 temp repo에서도 깨지지 않음 — 이 파일
//    스스로가 그 회귀 방지 증거다).
// ---------------------------------------------------------------------------
function makeTempGitRepoWithOrigin(): { repo: string; origin: string } {
  const origin = mkdtempSync(join(tmpdir(), "autodev-rgs-origin-"));
  tempDirs.push(origin);
  spawnSync("git", ["init", "-q", "--bare", "--initial-branch=main"], { cwd: origin });

  const seedParent = mkdtempSync(join(tmpdir(), "autodev-rgs-seed-"));
  tempDirs.push(seedParent);
  const seedRepo = join(seedParent, "repo");
  spawnSync("git", ["clone", "-q", origin, seedRepo], { cwd: seedParent });
  spawnSync("git", ["config", "user.email", "autodev-test@example.com"], { cwd: seedRepo });
  spawnSync("git", ["config", "user.name", "AutoDev Test"], { cwd: seedRepo });
  writeFileSync(join(seedRepo, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: seedRepo });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: seedRepo });
  spawnSync("git", ["push", "-q", "-u", "origin", "HEAD:refs/heads/main"], { cwd: seedRepo });

  const clonesParent = mkdtempSync(join(tmpdir(), "autodev-rgs-clone-"));
  tempDirs.push(clonesParent);
  const repo = join(clonesParent, "repo");
  spawnSync("git", ["clone", "-q", origin, repo], { cwd: clonesParent });
  spawnSync("git", ["config", "user.email", "autodev-test@example.com"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "AutoDev Test"], { cwd: repo });

  return { repo, origin };
}

/** 다른 writer(별도 clone)가 origin에 새 commit을 push한 상황을 흉내낸다 — 이 저장소 자신의
 *  repo/origin은 건드리지 않는다(§ 요구사항 16 — 실제 git concurrency scenario). */
function pushExtraCommitToOrigin(origin: string, fileName: string): void {
  const parent = mkdtempSync(join(tmpdir(), "autodev-rgs-other-"));
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

function buildPlannerManifestWithRemoteGitSafety(root: string, statePath: string): ProjectManifest {
  return { ...buildPlannerManifest(root, statePath), remoteGitSafety: {} };
}

async function scenarioRunAutodevOnceBlockedByRemoteGitAtStart(): Promise<void> {
  const { repo, origin } = makeTempGitRepoWithOrigin();
  const statePath = makeTempStateFile(repo);
  const beforeState = readFileSync(statePath, "utf-8");
  pushExtraCommitToOrigin(origin, "external-before-start.txt"); // repo가 이제 stale(REMOTE_AHEAD).

  const manifest = buildPlannerManifestWithRemoteGitSafety(repo, statePath);
  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return { success: true, summary: "호출되면 안 됨", changedFiles: [], tests: [], rawOutput: "" };
  };

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner } });

  check("remote-git-safety 통합: 시작 전 remote가 앞서 있으면 outcome=BLOCKED_REMOTE_GIT", result.outcome === "BLOCKED_REMOTE_GIT");
  check("remote-git-safety 통합: Claude worker가 전혀 호출되지 않음", claudeCalls === 0);
  const afterState = readFileSync(statePath, "utf-8");
  check("remote-git-safety 통합: state.json이 전혀 건드려지지 않음(loadState조차 호출 안 함)", afterState === beforeState);
  const log = (spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "").trim();
  check("remote-git-safety 통합: local repo에 새 commit이 생기지 않음(init 1건만)", log.split("\n").length === 1);
}

async function scenarioRunAutodevOnceRemoteChangedDuringRunBlocksCheckpoint(): Promise<void> {
  const { repo, origin } = makeTempGitRepoWithOrigin();
  const statePath = makeTempStateFile(repo);
  const manifest = buildPlannerManifestWithRemoteGitSafety(repo, statePath);

  const claudeRunner = async (): Promise<ClaudeResult> => {
    writeRepoFile(repo, "proj/fake-task-p1-2-marker.txt", "marker\n");
    // 이 task를 실행하는 "동안" 다른 프로세스가 origin에 push했다고 흉내낸다(§ 요구사항 5/16).
    pushExtraCommitToOrigin(origin, "external-during-run.txt");
    return {
      success: true,
      summary: "테스트: P1.2 구현 완료(하지만 remote가 그 사이 바뀜)",
      changedFiles: ["proj/fake-task-p1-2-marker.txt"],
      tests: [{ name: "proj:check", pass: true }],
      rawOutput: "",
    };
  };

  // 이 manifest는 humanFinalReviewPolicy를 지정하지 않는다(기본값 OFF) — Remote Git Safety의
  // "run 도중 remote 변경 → checkpoint 직전 재확인 BLOCK" 판정 자체가 기존과 동일한 단일
  // runAutodevOnce() 호출 안에서 일어나는지 검증한다.
  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() },
  });

  check("remote-git-safety 통합: run 도중 remote 변경 → outcome=RAN_TASK_CHECKPOINT_BLOCKED", result.outcome === "RAN_TASK_CHECKPOINT_BLOCKED");
  check("remote-git-safety 통합: reason에 REMOTE_CHANGED_DURING_RUN 코드 포함", (result.reason ?? "").includes("REMOTE_CHANGED_DURING_RUN"));

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("remote-git-safety 통합: completedTasks에 P1.2가 추가되지 않음", !finalState.completedTasks.includes("P1.2"));
  check("remote-git-safety 통합: status='WAITING_HUMAN'", finalState.status === "WAITING_HUMAN");
  check(
    "remote-git-safety 통합: deferredHumanTasks에 REMOTE_GIT_CHANGED_DURING_RUN 기록됨",
    finalState.deferredHumanTasks.some((t) => t.includes("REMOTE_GIT_CHANGED_DURING_RUN"))
  );

  const log = (spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "").trim();
  check("remote-git-safety 통합: local repo에 commit이 생성되지 않음(init 1건만)", log.split("\n").length === 1);
  // git status --porcelain(untracked-files 기본값)은 완전히 새 디렉터리를 파일 단위가 아니라
  // "?? proj/"로 뭉쳐 보고한다(§ git-changes.ts 상단 주석과 동일한 실측 함정) — 파일 자체가
  // 삭제되지 않고 그대로 남아있는지는 fs로 직접 확인한다.
  check(
    "remote-git-safety 통합: developer가 만든 변경(marker.txt)이 working tree에 그대로 보존됨(commit 안 됐지만 삭제도 안 됨)",
    existsSync(join(repo, "proj", "fake-task-p1-2-marker.txt"))
  );
}

async function scenarioRunAutodevOnceHappyPath(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo); // completedTasks=["P1.1"] → 다음은 P1.2
  const manifest = buildPlannerManifest(repo, statePath);

  const claudeRunner = async (): Promise<ClaudeResult> => {
    // Claude가 실제로 파일을 만든 것처럼 temp repo 안에 직접 기록한다(P1.2의
    // allowedPathPrefixes=["proj/"] 범위 안).
    writeRepoFile(repo, "proj/fake-task-p1-2-marker.txt", "marker\n");
    return {
      success: true,
      summary: "테스트: P1.2 구현 완료",
      changedFiles: ["proj/fake-task-p1-2-marker.txt"],
      tests: [{ name: "proj:check", pass: true }],
      rawOutput: "",
    };
  };

  // 이 manifest는 humanFinalReviewPolicy를 지정하지 않는다(기본값 OFF) — reviewer APPROVED
  // 즉시 checkpoint까지 단일 호출로 이어지는 기존 AutoDev 동작을 그대로 검증한다(§ HFR
  // 요구사항 1 — default OFF → 자동 checkpoint).
  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() },
  });

  check("runAutodevOnce happy path: outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("runAutodevOnce happy path: taskId=P1.2", result.taskId === "P1.2");
  check("runAutodevOnce happy path: checkpoint.ok=true", result.checkpoint?.ok === true);
  check("runAutodevOnce happy path: commitHash 존재", typeof result.checkpoint?.commitHash === "string");

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("runAutodevOnce happy path: completedTasks에 P1.2 추가됨", finalState.completedTasks.includes("P1.2"));
  check("runAutodevOnce happy path: status='READY'(다음 task 대기)", finalState.status === "READY");
  check("runAutodevOnce happy path: currentTask가 P2.1을 가리킴", typeof finalState.currentTask === "string" && finalState.currentTask.includes("P2.1"));
  check("runAutodevOnce happy path: gitCheckpoint가 실제 commit hash로 갱신됨", finalState.gitCheckpoint === result.checkpoint?.commitHash);
  check("runAutodevOnce happy path: humanFinalReview gate가 비활성 상태이므로 null(생성된 적 없음)", finalState.humanFinalReview === null);

  const log = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "";
  check("runAutodevOnce happy path: product commit + administrative commit 2건 생성(+init 1건=3건)", log.trim().split("\n").length === 3);
  const statusAfter = (spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf-8" }).stdout || "").trim();
  check("runAutodevOnce happy path: 최종적으로 working tree clean", statusAfter === "");
}

// ---------------------------------------------------------------------------
// P0-5 하드닝(독립 감사) — local GREEN(required test 통과) 이전에는 Reviewer(GPT/Fireworks)
// network call을 절대 하지 않는다. changedFiles 존재 여부와 무관하다(§ orchestrator.ts
// skipReviewerLocalNotGreen).
// ---------------------------------------------------------------------------
async function scenarioRunAutodevOnceChangedFilesWithFailedRequiredTestNeverCallsReviewer(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo); // completedTasks=["P1.1"] → 다음은 P1.2
  const manifest = buildPlannerManifest(repo, statePath);

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    // 매 attempt마다 실제로 파일을 변경하지만(changedFiles 존재), required test는 계속
    // 실패한다 — 독립 감사가 실제로 재현한 반례(changedFiles가 있어도 required test 실패면
    // Reviewer가 호출되던 경로)와 정확히 같은 모양이다.
    writeRepoFile(repo, "proj/p12-marker.txt", `attempt-${claudeCalls}\n`);
    return {
      success: true,
      summary: `테스트: attempt ${claudeCalls} — required test 계속 실패`,
      changedFiles: ["proj/p12-marker.txt"],
      tests: [{ name: "proj:check", pass: false }],
      rawOutput: "",
    };
  };
  let reviewerCalls = 0;
  const gptReviewer = async (): Promise<GptReviewerReturn> => {
    reviewerCalls += 1;
    return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "호출되면 안 됨 — local GREEN 아님", nextTask: null };
  };

  // sleep을 fake로 주입한다 — P1-2 하드닝(orchestrator.ts durable wait-then-retry, §
  // MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT)이 실제 backoff(최대 300000ms)를 여러 차례
  // 거치므로, 실제 대기를 쓰면 이 테스트가 실제로 수십 분 걸린다(§ 요구사항 4 — 실제
  // Claude/OpenAI/Telegram 호출만이 아니라 실제 wall-clock 대기도 fake로 격리한다).
  await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer, sleep: async () => {}, now: () => Date.now() } });

  check("P0-5) changedFiles 존재 + required test 실패 반복 — Developer는 최소 1회 호출됨", claudeCalls >= 1);
  check("P0-5) changedFiles 존재 + required test 실패 — Reviewer는 단 한 번도 호출되지 않음(reviewerCalls=0)", reviewerCalls === 0);
}

async function scenarioRunAutodevOnceChangedFilesWithPassedRequiredTestCallsReviewer(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo);
  const manifest = buildPlannerManifest(repo, statePath);

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    writeRepoFile(repo, "proj/p12-marker.txt", "marker\n");
    return {
      success: true,
      summary: "테스트: P1.2 구현 완료(required test 통과)",
      changedFiles: ["proj/p12-marker.txt"],
      tests: [{ name: "proj:check", pass: true }],
      rawOutput: "",
    };
  };
  let reviewerCalls = 0;
  const gptReviewer = async (result: ClaudeResult, reviewCycle: number, task: string, allowedPathPrefixes?: string[]): Promise<GptReviewerReturn> => {
    reviewerCalls += 1;
    return fakePassReviewer()(result, reviewCycle, task, allowedPathPrefixes);
  };

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer } });

  check("P0-5) changedFiles 존재 + required test 통과(local GREEN) — Reviewer가 정상 호출됨(reviewerCalls=1)", reviewerCalls === 1);
  check("P0-5) local GREEN 경로는 정상적으로 checkpoint까지 완료됨", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  void claudeCalls;
}

async function scenarioRunAutodevOnceNoChangedFilesWithFailedRequiredTestNeverCallsReviewer(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo);
  const manifest = buildPlannerManifest(repo, statePath);

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    // 이번 attempt에서 파일을 전혀 바꾸지 않았는데도(changedFiles:[]) required test는
    // 여전히 실패한다(예: LOCAL_ROOT_CAUSE_MODE가 합성한 결과와 동일한 모양).
    return {
      success: true,
      summary: `테스트: attempt ${claudeCalls} — 변경 없음, required test 여전히 실패`,
      changedFiles: [],
      tests: [{ name: "proj:check", pass: false }],
      rawOutput: "",
    };
  };
  let reviewerCalls = 0;
  const gptReviewer = async (): Promise<GptReviewerReturn> => {
    reviewerCalls += 1;
    return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "호출되면 안 됨", nextTask: null };
  };

  // sleep을 fake로 주입한다(§ 위 scenarioRunAutodevOnceChangedFilesWithFailedRequiredTestNeverCallsReviewer
  // 와 동일한 이유 — P1-2 durable wait의 실제 backoff를 이 테스트에서 실제로 기다리지 않는다).
  await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer, sleep: async () => {}, now: () => Date.now() } });

  check("P0-5) changedFiles 없음 + required test 실패 — Reviewer는 단 한 번도 호출되지 않음(reviewerCalls=0)", reviewerCalls === 0);
}

async function scenarioRunAutodevOnceCheckpointBlockedOnUnexpectedFile(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo);
  const manifest = buildPlannerManifest(repo, statePath);

  const claudeRunner = async (): Promise<ClaudeResult> => {
    // P1.2의 allowedPathPrefixes 밖(other/)에 파일을 만든다 — checkpoint가 BLOCK해야 한다.
    writeRepoFile(repo, "other/unexpected.txt", "oops\n");
    return {
      success: true,
      summary: "테스트: 범위 밖 파일 생성(의도된 실패 시나리오)",
      changedFiles: ["other/unexpected.txt"],
      tests: [{ name: "proj:check", pass: true }],
      rawOutput: "",
    };
  };

  // 이 manifest는 humanFinalReviewPolicy를 지정하지 않는다(기본값 OFF) — fakePassReviewer는
  // 무조건 PASS를 반환하므로(범위 밖 파일을 실제로 검사하지 않음) 실제 out-of-scope 검증은
  // checkpoint.ts(computeCommitPlan)가 담당하며, 그 검증은 이 단일 호출 안에서 그대로 일어난다.
  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() },
  });

  check("runAutodevOnce checkpoint-blocked: outcome=RAN_TASK_CHECKPOINT_BLOCKED", result.outcome === "RAN_TASK_CHECKPOINT_BLOCKED");
  check("runAutodevOnce checkpoint-blocked: checkpoint.ok=false", result.checkpoint?.ok === false);
  check(
    "runAutodevOnce checkpoint-blocked: unexpectedFiles에 other/unexpected.txt 포함",
    (result.checkpoint?.unexpectedFiles ?? []).includes("other/unexpected.txt")
  );

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("runAutodevOnce checkpoint-blocked: completedTasks에 P1.2가 추가되지 않음", !finalState.completedTasks.includes("P1.2"));
  check("runAutodevOnce checkpoint-blocked: status='WAITING_HUMAN'", finalState.status === "WAITING_HUMAN");
  check(
    "runAutodevOnce checkpoint-blocked: deferredHumanTasks에 CHECKPOINT_BLOCKED 기록됨",
    finalState.deferredHumanTasks.some((t) => t.includes("CHECKPOINT_BLOCKED"))
  );

  const log = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "";
  check("runAutodevOnce checkpoint-blocked: commit이 생성되지 않음(init 1건만)", log.trim().split("\n").length === 1);
}

async function scenarioRunAutodevOnceNotApprovedSkipsCheckpoint(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo);
  const manifest = buildPlannerManifest(repo, statePath);

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return { success: true, summary: "테스트: 항상 REVISE 대상", changedFiles: [], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };
  const alwaysRevise = async (): Promise<GptReviewerReturn> => ({
    decision: "REVISE",
    severity: { critical: 0, high: 0, medium: 1 },
    feedback: "테스트: 항상 REVISE(무한루프 방지 확인용)",
    nextTask: "다시 시도",
  });

  // AutoDev Efficiency / Review Stagnation Hardening(2026-08-28) — REVIEW_CYCLE_EXHAUSTED는
  // 더 이상 MAX_REVIEW_CYCLES(5)에서 즉시 WAITING_HUMAN으로 끝나지 않고 durable하게(무제한
  // 횟수, bounded 간격) 재시도한다(§ orchestrator.ts/root-cause-analysis.ts). 이 alwaysRevise는
  // 절대 수렴하지 않으므로, 이 정책 수정과 무관한 기존 비용 안전장치 MAX_GPT_CALLS(10)가 결국
  // genuine WAITING_HUMAN으로 이끈다 — sleep을 fake로 주입해 실제 대기 없이 그 지점까지
  // 빠르게 도달한다.
  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner, gptReviewer: alwaysRevise, sleep: async () => {}, now: () => Date.now() },
  });

  check("runAutodevOnce 미승인: outcome=RAN_TASK_NOT_APPROVED", result.outcome === "RAN_TASK_NOT_APPROVED");
  check("runAutodevOnce 미승인: checkpoint가 시도되지 않음(undefined)", result.checkpoint === undefined);

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("runAutodevOnce 미승인: completedTasks 변화 없음", !finalState.completedTasks.includes("P1.2"));

  const log = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "";
  check("runAutodevOnce 미승인: commit이 생성되지 않음(init 1건만)", log.trim().split("\n").length === 1);
  check(
    "runAutodevOnce 미승인: MAX_REVIEW_CYCLES에서 하드 컷오프되지 않고 durable하게 재시도되다가 결국 MAX_GPT_CALLS(10)로 멈춤",
    claudeCalls > 5 && claudeCalls <= 12
  );
}

// ---------------------------------------------------------------------------
// D) Phase G Task G7.5 — Telegram 알림 UX Hardening. 중간 task 완료(SUBTASK, 🟡)와
//    task-registry 전체가 진짜 최종 완료되는 순간(PENDING_FINAL → PROJECT_COMPLETED, ✅)/
//    마지막 task가 isHumanGate라 배포는 사람이 트리거해야 하는 순간(PENDING_DEPLOYMENT_GATE
//    → DEPLOYMENT_WAITING_HUMAN, ⛔)을 각각 실제 EventStore로 구분해서 검증한다 — 세
//    시나리오 모두 같은 orchestrator/checkpoint 배선을 그대로 타므로 이 event들이 실제
//    production 코드 경로에서 만들어지는지 증명한다(단순 notification.ts 단위 테스트만으로는
//    "autodev.ts가 실제로 이 metadata/event를 만드는가"를 증명하지 못한다).
// ---------------------------------------------------------------------------

// P1.2는 registry의 중간 task다(다음은 P2.1) — 반드시 SUBTASK(🟡)여야 하고, PROJECT_COMPLETED/
// DEPLOYMENT_WAITING_HUMAN 최종 event는 절대 만들어지면 안 된다.
async function scenarioRunAutodevOnceMidRegistryTaskIsSubtaskOnly(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo); // completedTasks=["P1.1"] → 다음은 P1.2(중간 task)
  const manifest = buildPlannerManifest(repo, statePath);
  const events = createInMemoryEventStore();

  const claudeRunner = async (): Promise<ClaudeResult> => {
    writeRepoFile(repo, "proj/fake-task-p1-2-marker.txt", "marker\n");
    return { success: true, summary: "테스트", changedFiles: ["proj/fake-task-p1-2-marker.txt"], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };

  await runAutodevOnce({ manifest, events, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  const all = events.query().events;
  const taskCompleted = all.find((e) => e.eventType === "TASK_COMPLETED");
  check("D) 중간 task: TASK_COMPLETED.metadata.completionScope='SUBTASK'", taskCompleted?.metadata?.completionScope === "SUBTASK");
  check("D) 중간 task: PROJECT_COMPLETED event 없음", !all.some((e) => e.eventType === "PROJECT_COMPLETED"));
  check("D) 중간 task: DEPLOYMENT_WAITING_HUMAN event 없음", !all.some((e) => e.eventType === "DEPLOYMENT_WAITING_HUMAN"));

  const n = taskCompleted ? classifyEventForNotification(taskCompleted) : undefined;
  check("D) 중간 task: notification 🟡 TASK_COMPLETED로 분류(최종 완료 아님)", n?.notificationType === "TASK_COMPLETED");
}

// P2.1까지 완료한 뒤 마지막(P2.2, isHumanGate=true)을 완료 → 모든 자동 task는 끝났지만 실제
// 배포는 사람이 트리거해야 하는 상태(⛔ DEPLOYMENT_WAITING_HUMAN) — ✅ PROJECT_COMPLETED가
// 아니어야 한다(배포가 안 끝났으므로 "최종 완료"가 아니다).
async function scenarioRunAutodevOnceFinalHumanGateEmitsDeploymentWaitingHuman(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: idsUpTo("P2.1") }); // 다음은 P2.2(마지막, human gate)
  const manifest = buildPlannerManifest(repo, statePath);
  const events = createInMemoryEventStore();

  const claudeRunner = async (): Promise<ClaudeResult> => {
    writeRepoFile(repo, "proj/fake-task-p2-2-marker.txt", "marker\n");
    return { success: true, summary: "테스트", changedFiles: ["proj/fake-task-p2-2-marker.txt"], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };

  const result = await runAutodevOnce({ manifest, events, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });
  check("D) 마지막(human gate) task: outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("D) 마지막(human gate) task: status='DEPLOYMENT_WAITING_HUMAN'", (finalState.status as unknown as string) === "DEPLOYMENT_WAITING_HUMAN");

  const all = events.query().events;
  const taskCompleted = all.find((e) => e.eventType === "TASK_COMPLETED");
  check(
    "D) 마지막(human gate) task: TASK_COMPLETED.metadata.completionScope='PENDING_DEPLOYMENT_GATE'",
    taskCompleted?.metadata?.completionScope === "PENDING_DEPLOYMENT_GATE"
  );
  check(
    "D) 마지막(human gate) task: 이 TASK_COMPLETED 자체는 알림을 만들지 않음(중복 방지)",
    taskCompleted ? classifyEventForNotification(taskCompleted) === undefined : false
  );

  const deploymentEvent = all.find((e) => e.eventType === "DEPLOYMENT_WAITING_HUMAN");
  check("D) 마지막(human gate) task: DEPLOYMENT_WAITING_HUMAN event 생성됨", deploymentEvent !== undefined);
  check("D) 마지막(human gate) task: PROJECT_COMPLETED event 없음(배포 미완료)", !all.some((e) => e.eventType === "PROJECT_COMPLETED"));
  const n = deploymentEvent ? classifyEventForNotification(deploymentEvent) : undefined;
  check("D) 마지막(human gate) task: notification ⛔ DEPLOYMENT_WAITING_HUMAN", n?.notificationType === "DEPLOYMENT_WAITING_HUMAN");
  check("D) 마지막(human gate) task: requiresHumanAction=true(그러나 버튼 없음, § approval-service.ts)", n?.requiresHumanAction === true);
}

// 마지막 task가 human gate가 아닌 작은 별도 registry로 "진짜 최종 완료"(✅ PROJECT_COMPLETED)를
// 검증한다 — PLANNER_FIXTURE_REGISTRY는 마지막이 항상 isHumanGate라 이 경로를 만들 수 없다.
const FINAL_NO_GATE_REGISTRY: TaskDefinition[] = [
  { id: "N1", phase: 1, taskNumber: 1, title: "최종 완료 fixture Task1", prompt: "N1 prompt", requiredTests: [], allowedPathPrefixes: ["proj/"], prohibitedOperations: [] },
  { id: "N2", phase: 1, taskNumber: 2, title: "최종 완료 fixture Task2(마지막, human gate 아님)", prompt: "N2 prompt", requiredTests: [], allowedPathPrefixes: ["proj/"], prohibitedOperations: [] },
];

function buildFinalNoGateManifest(root: string, statePath: string): ProjectManifest {
  return {
    projectId: "final-no-gate-fixture-project",
    projectName: "Final No-Gate Fixture Project",
    targetProjectRoot: root,
    statePath,
    taskRegistry: FINAL_NO_GATE_REGISTRY,
    developerInstructions: "허용 범위: proj/**. 이 fixture 프로젝트는 진짜 최종 완료(PROJECT_COMPLETED)만 다룹니다.",
    reviewInstructions: "proj/** 범위 밖 변경이 있으면 반드시 REVISE하세요.",
    reviewScopeDirs: ["proj/"],
    executionPolicy: PLANNER_EXECUTION_POLICY,
  };
}

async function scenarioRunAutodevOnceFinalNonGateTaskEmitsProjectCompleted(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: ["N1"] }); // 다음은 N2(마지막, gate 아님)
  const manifest = buildFinalNoGateManifest(repo, statePath);
  const events = createInMemoryEventStore();

  const claudeRunner = async (): Promise<ClaudeResult> => {
    writeRepoFile(repo, "proj/fake-task-n2-marker.txt", "marker\n");
    return { success: true, summary: "테스트", changedFiles: ["proj/fake-task-n2-marker.txt"], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };

  const result = await runAutodevOnce({ manifest, events, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });
  check("D) 마지막(non-gate) task: outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("D) 마지막(non-gate) task: status='PROJECT_COMPLETE'", (finalState.status as unknown as string) === "PROJECT_COMPLETE");

  const all = events.query().events;
  const taskCompleted = all.find((e) => e.eventType === "TASK_COMPLETED");
  check(
    "D) 마지막(non-gate) task: TASK_COMPLETED.metadata.completionScope='PENDING_FINAL'",
    taskCompleted?.metadata?.completionScope === "PENDING_FINAL"
  );
  check(
    "D) 마지막(non-gate) task: 이 TASK_COMPLETED 자체는 알림을 만들지 않음(🟡와 ✅ 동시 발송 방지)",
    taskCompleted ? classifyEventForNotification(taskCompleted) === undefined : false
  );

  const projectCompletedEvent = all.find((e) => e.eventType === "PROJECT_COMPLETED");
  check("D) 마지막(non-gate) task: PROJECT_COMPLETED event 생성됨", projectCompletedEvent !== undefined);
  check("D) 마지막(non-gate) task: DEPLOYMENT_WAITING_HUMAN event 없음", !all.some((e) => e.eventType === "DEPLOYMENT_WAITING_HUMAN"));

  // 순서(§ 요구사항 5) — PROJECT_COMPLETED는 project-state.json 저장 + administrative
  // commit이 끝난 뒤에만 만들어진다는 사실을 event.sequence로 방증한다: TASK_COMPLETED보다
  // 항상 나중 sequence다(그 사이에 admin commit이 있었다는 것은 위 git log/상태로 이미
  // 별도 검증됨 — 여기서는 event 순서만 확인).
  check(
    "D) 마지막(non-gate) task: PROJECT_COMPLETED가 TASK_COMPLETED보다 나중 event(순서 보장)",
    (projectCompletedEvent?.sequence ?? -1) > (taskCompleted?.sequence ?? Number.MAX_SAFE_INTEGER)
  );

  const n = projectCompletedEvent ? classifyEventForNotification(projectCompletedEvent) : undefined;
  check("D) 마지막(non-gate) task: notification ✅ FINAL_COMPLETED", n?.notificationType === "FINAL_COMPLETED");
  check(
    "D) 마지막(non-gate) task: '다음 프로젝트 시작 가능: 예'",
    (n?.shortMessage ?? "").includes("다음 프로젝트 시작 가능: 예")
  );

  const log = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "";
  check("D) 마지막(non-gate) task: product commit + administrative commit 2건 생성(+init 1건=3건)", log.trim().split("\n").length === 3);
}

async function scenarioRunAutodevOnceNoTaskStops(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: allTaskIds() });
  const manifest = buildPlannerManifest(repo, statePath);

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return { success: true, summary: "호출되면 안 됨", changedFiles: [], tests: [], rawOutput: "" };
  };

  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner },
  });
  check("runAutodevOnce 모든 task 완료: outcome=STOPPED", result.outcome === "STOPPED");
  check("runAutodevOnce 모든 task 완료: Claude worker 호출 0회", claudeCalls === 0);
}

// AutoDev Core Maintenance — Crash-safe Checkpoint Resume(Category B) 통합 시나리오. Human
// Final Review 없이도(§ 위 planner 단위 테스트와 동일한 상태) reviewer가 이미 APPROVED한
// 실제 code 변경 위에서, 재시작이 Developer/Reviewer를 다시 부르지 않고 곧바로 checkpoint로
// 이어지는지 실제 runAutodevOnce()/checkpoint 배선까지 포함해 검증한다.
async function scenarioApprovedCrashBeforeCheckpointResumesWithoutRerunningDeveloper(): Promise<void> {
  const target = PLANNER_FIXTURE_REGISTRY.find((t) => t.id === "P1.2")!;
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, {
    status: "APPROVED",
    completedTasks: ["P1.1"],
    currentTask: target.prompt,
    reviewCycle: 1,
    lastGptDecision: { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "테스트: 문제없음", nextTask: null },
    lastClaudeResult: {
      success: true,
      summary: "테스트: 이미 승인된 직전 시도",
      changedFiles: ["proj/p12-marker.txt"],
      tests: [{ name: "proj:check", pass: true }],
      rawOutput: "",
    },
  });
  // reviewer가 이미 APPROVED한 실제 코드 변경 — product commit 직전에 프로세스가 죽었다는
  // 뜻으로 working tree에 그대로 uncommitted 상태로 남아있다.
  writeRepoFile(repo, "proj/p12-marker.txt", "marker\n");
  const manifest = buildPlannerManifest(repo, statePath);

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return { success: true, summary: "호출되면 안 됨 — 이미 APPROVED된 작업을 재실행함", changedFiles: [], tests: [], rawOutput: "" };
  };
  let reviewerCalls = 0;
  const gptReviewer = async (): Promise<GptReviewerReturn> => {
    reviewerCalls += 1;
    return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "호출되면 안 됨", nextTask: null };
  };

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer } });

  check("APPROVED crash resume: outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("APPROVED crash resume: taskId=P1.2", result.taskId === "P1.2");
  check("APPROVED crash resume: Developer가 다시 호출되지 않음(claudeCalls=0)", claudeCalls === 0);
  check("APPROVED crash resume: Reviewer도 다시 호출되지 않음(reviewerCalls=0)", reviewerCalls === 0);

  const stateAfter = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("APPROVED crash resume: completedTasks에 P1.2 추가됨", stateAfter.completedTasks.includes("P1.2"));

  const log = (spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "").trim();
  check("APPROVED crash resume: product+admin commit 2건 생성됨(+init 1건=3건)", log.split("\n").length === 3);
}

// ---------------------------------------------------------------------------
// P1-1 하드닝(2026-08-30, 독립 감사) — "재시작이 retry budget reset 버튼이 되면 안 된다".
// reviewStagnationWaitCount(§ orchestrator.ts blockOnDurableWaitRetryExhausted의 durable
// wait 예산)를 이미 상한(MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT)까지 소진한 상태로 미리
// project-state.json에 저장해두고(= "process가 재시작 직전까지 N-1번 소진했다"를 흉내낸다),
// 완전히 새로운(fresh) runAutodevOnce() 호출(= 실제 process 재시작과 동일하게 loadState()로
// 디스크에서 다시 읽는다) 하나만으로 그 다음 한 번의 소진이 즉시 상한을 초과해 terminal
// 기술적 BLOCKED로 끝나는지 검증한다 — 0부터 다시 시작(무한 반복)하지 않는다는 직접 증거다.
// ---------------------------------------------------------------------------
async function scenarioReviewStagnationBudgetPersistsAcrossRestart(): Promise<void> {
  const target = PLANNER_FIXTURE_REGISTRY.find((t) => t.id === "P1.2")!;
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, {
    status: "WAITING_PROVIDER_RETRY",
    completedTasks: ["P1.1"],
    currentTask: target.prompt,
    reviewCycle: 0,
    reviewStagnationWaitCount: MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT,
  });
  const manifest = buildPlannerManifest(repo, statePath);

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return { success: true, summary: "테스트: 재시작 이후에도 여전히 실패", changedFiles: [], tests: [{ name: "proj:check", pass: false }], rawOutput: "" };
  };
  const gptReviewer = async (): Promise<GptReviewerReturn> => ({
    decision: "PASS",
    severity: { critical: 0, high: 0, medium: 0 },
    feedback: "호출되면 안 됨",
    nextTask: null,
  });

  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner, gptReviewer, sleep: async () => {}, now: () => Date.now() },
  });

  check(
    "P1-1) 재시작(fresh runAutodevOnce 호출) 직후 예산이 0으로 리셋되지 않고 단 5회(MAX_REVIEW_CYCLES) 재시도 후 즉시 BLOCKED",
    claudeCalls === 5
  );
  check("P1-1) outcome이 APPROVED_AND_CHECKPOINTED가 아님(수렴하지 않았으므로)", result.outcome !== "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("P1-1) 최종 status=BLOCKED(terminal 기술적 안전정지 — 재시작이 예산을 초기화하지 않음)", (finalState.status as unknown as string) === "BLOCKED");
  check(
    `P1-1) reviewStagnationWaitCount가 seed(${MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT})에서 이어져 상한을 초과함(=${MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT + 1}, 0부터 재시작 아님)`,
    (finalState.reviewStagnationWaitCount ?? 0) === MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT + 1
  );
}

// ---------------------------------------------------------------------------
// P1-1 재하드닝(2026-08-30, 독립 감사 실제 재현) — claudeLimitWaitCount(USAGE_LIMIT durable
// wait 예산)가 orchestrator.ts에서 resumingSameTask 여부와 무관하게 항상 0으로 리셋되는
// 버그가 있었다(developerProviderWaitCount 등 나머지 세 durable counter는 이미
// `if (!resumingSameTask)` 블록 안에 있었는데 이것만 밖에 있었다). 이 시나리오는 그 정확한
// 재현 조건(같은 task로 재개 + 이미 cap 직전까지 소진된 seed)을 fresh runAutodevOnce() 호출
// (=실제 process 재시작과 동일하게 loadState()로 디스크에서 다시 읽음) 하나로 구성해, 수정
// 전에는 claudeCalls가 6(0부터 다시 쌓아올려야 cap에 도달)이었고 수정 후에는 1(seed가 그대로
// 보존되어 첫 실패가 즉시 cap을 넘음)이어야 함을 증명한다.
// ---------------------------------------------------------------------------
async function scenarioClaudeLimitWaitBudgetPersistsAcrossRestart(): Promise<void> {
  const target = PLANNER_FIXTURE_REGISTRY.find((t) => t.id === "P1.2")!;
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, {
    status: "WAITING_CLAUDE_LIMIT",
    completedTasks: ["P1.1"],
    currentTask: target.prompt,
    reviewCycle: 0,
    claudeLimitWaitCount: MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT,
  });
  const manifest = buildPlannerManifest(repo, statePath);

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return { success: false, summary: "테스트: 재시작 이후에도 여전히 사용량 제한", changedFiles: [], tests: [], rawOutput: "", errorCode: "USAGE_LIMIT" } as ClaudeResult;
  };
  const gptReviewer = async (): Promise<GptReviewerReturn> => ({
    decision: "PASS",
    severity: { critical: 0, high: 0, medium: 0 },
    feedback: "호출되면 안 됨",
    nextTask: null,
  });

  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner, gptReviewer, sleep: async () => {}, now: () => Date.now() },
  });

  check(
    "P1-1) 재시작(fresh runAutodevOnce 호출) 직후 claudeLimitWaitCount seed가 0으로 리셋되지 않고 단 1회 실패만으로 즉시 BLOCKED(과거 버그였다면 6회 필요)",
    claudeCalls === 1
  );
  check("P1-1) outcome이 APPROVED_AND_CHECKPOINTED가 아님(수렴하지 않았으므로)", result.outcome !== "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("P1-1) 최종 status=BLOCKED(terminal 기술적 안전정지 — 재시작이 예산을 초기화하지 않음)", (finalState.status as unknown as string) === "BLOCKED");
  check(
    `P1-1) claudeLimitWaitCount가 seed(${MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT})에서 이어져 상한을 초과함(=${MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT + 1}, 0부터 재시작 아님)`,
    (finalState.claudeLimitWaitCount ?? 0) === MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT + 1
  );
}

// AutoDev Core Maintenance — Crash-safe Checkpoint Reconciliation(Category B, 마지막 task
// 전용 gap) 통합 시나리오. 마지막 task의 completedTasks 갱신은 이미 저장됐지만(§ decideNextAction
// 관점에서는 "더 이상 실행할 task 없음") admin commit(commitProjectStateOnly)이 아직 git에
// 반영되지 않은 상태를 재현한다.
async function scenarioDanglingProjectStateReconciledWhenNoMoreTasks(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: idsUpTo("P2.1") });
  // 실제 운용에서는 project-state.json이 이미 git에 커밋된 tracked 파일이다 — 이 검증이
  // 다루는 것은 "tracked 파일의 admin commit이 아직 안 된 상태"이지 untracked 신규 파일이
  // 아니므로, 최초 버전을 먼저 commit해 tracked로 만든다.
  spawnSync("git", ["add", "--", ".autodev/project-state.json"], { cwd: repo });
  spawnSync("git", ["commit", "-q", "-m", "chore: initial state"], { cwd: repo });
  const beforeReconcile = (spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "")
    .trim()
    .split("\n").length;

  // "마지막 task까지 완료했지만 admin commit 직전에 죽음"을 재현한다 — completedTasks는 이미
  // 전부(allTaskIds()) disk에 반영됐지만(§ autodev.ts saveState), 그 git commit
  // (commitProjectStateOnly)은 아직 일어나지 않았다.
  const stateAfterCrash = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  stateAfterCrash.completedTasks = allTaskIds();
  stateAfterCrash.status = "READY";
  writeFileSync(statePath, JSON.stringify(stateAfterCrash, null, 2) + "\n", "utf-8");

  const manifest = buildPlannerManifest(repo, statePath);
  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return { success: true, summary: "호출되면 안 됨", changedFiles: [], tests: [], rawOutput: "" };
  };

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner } });
  check("dangling state 재조정: outcome=STOPPED", result.outcome === "STOPPED");
  check("dangling state 재조정: Claude worker 호출 0회(재실행 없음)", claudeCalls === 0);

  const statusAfter = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf-8" });
  check("dangling state 재조정: working tree가 다시 clean해짐(잔여 diff commit됨)", (statusAfter.stdout || "").trim() === "");

  const logAfter = (spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "").trim().split("\n").length;
  check("dangling state 재조정: admin commit이 정확히 1건 추가됨", logAfter === beforeReconcile + 1);

  const lastSubject = (spawnSync("git", ["log", "-1", "--format=%s"], { cwd: repo, encoding: "utf-8" }).stdout || "").trim();
  check("dangling state 재조정: commit 메시지가 재조정 사유를 명시함", lastSubject.includes("reconcile"));
}

// ---------------------------------------------------------------------------
// E) Minimal HUMAN_FINAL_REVIEW Runtime Checkpoint Gate — Reviewer APPROVED와 checkpoint
//    사이의 fail-closed gate를 직접 검증한다(§ Task 요구사항 13, Test 1~7).
// ---------------------------------------------------------------------------

// Test 1 — Reviewer APPROVED 후 Human 대기: checkpoint=0, completedTasks 변화 없음, next
// task 이동 없음.
async function scenarioHumanFinalReviewGatePausesBeforeCheckpoint(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo);
  const manifest = buildPlannerManifestWithHumanFinalReview(repo, statePath);

  const claudeRunner = async (): Promise<ClaudeResult> => {
    writeRepoFile(repo, "proj/hfr-test1-marker.txt", "marker\n");
    return { success: true, summary: "테스트", changedFiles: ["proj/hfr-test1-marker.txt"], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check("HFR Test1: outcome=RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW", result.outcome === "RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW");
  check("HFR Test1: checkpoint 시도 자체가 없음(undefined)", result.checkpoint === undefined);

  const state = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("HFR Test1: status='WAITING_HUMAN'", state.status === "WAITING_HUMAN");
  check("HFR Test1: humanFinalReview.status='PENDING'", state.humanFinalReview?.status === "PENDING");
  check("HFR Test1: humanFinalReview.taskId='P1.2'", state.humanFinalReview?.taskId === "P1.2");
  check("HFR Test1: completedTasks 변화 없음(next task 이동 없음)", !state.completedTasks.includes("P1.2"));

  const log = (spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "").trim();
  check("HFR Test1: checkpoint count=0(init 1건만)", log.split("\n").length === 1);
}

// Test 2 — Human approval 없이 재실행: 여전히 checkpoint=0, Task COMPLETE 금지.
async function scenarioHumanFinalReviewRerunWithoutApprovalStaysBlocked(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo);
  const manifest = buildPlannerManifestWithHumanFinalReview(repo, statePath);

  const claudeRunner = async (): Promise<ClaudeResult> => {
    writeRepoFile(repo, "proj/hfr-test2-marker.txt", "marker\n");
    return { success: true, summary: "테스트", changedFiles: ["proj/hfr-test2-marker.txt"], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };

  await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  // 승인 없이 다시 실행 — decideNextAction()이 gate.status==="PENDING"이므로 여전히 STOP이며
  // RESUME_APPROVED_CHECKPOINT로 진입하지 않는다.
  const secondResult = await runAutodevOnce({ manifest });

  check("HFR Test2: 승인 없는 재실행 outcome=STOPPED", secondResult.outcome === "STOPPED");
  check("HFR Test2: checkpoint 시도 자체가 없음", secondResult.checkpoint === undefined);

  const state = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("HFR Test2: completedTasks 변화 없음(Task COMPLETE 금지)", !state.completedTasks.includes("P1.2"));
  check("HFR Test2: status는 여전히 WAITING_HUMAN", state.status === "WAITING_HUMAN");

  const log = (spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "").trim();
  check("HFR Test2: checkpoint count=0(init 1건만)", log.split("\n").length === 1);
}

// Test 3 — 유효한 Human APPROVE 후 resume: 기존 checkpoint path 실행, Task COMPLETE,
// completedTasks 기록, checkpoint SHA 기록, next runnable task 계산.
async function scenarioHumanFinalReviewValidApproveResumesCheckpoint(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo);
  const manifest = buildPlannerManifestWithHumanFinalReview(repo, statePath);

  const claudeRunner = async (): Promise<ClaudeResult> => {
    writeRepoFile(repo, "proj/hfr-test3-marker.txt", "marker\n");
    return { success: true, summary: "테스트", changedFiles: ["proj/hfr-test3-marker.txt"], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };

  await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  const approval = approveHumanFinalReview(statePath, "P1.2");
  check("HFR Test3: approveHumanFinalReview ok=true", approval.ok === true);

  const result = await runAutodevOnce({ manifest });

  check("HFR Test3: outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("HFR Test3: checkpoint.ok=true", result.checkpoint?.ok === true);
  check("HFR Test3: commitHash(checkpoint SHA) 기록됨", typeof result.checkpoint?.commitHash === "string");

  const state = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("HFR Test3: completedTasks에 P1.2 기록됨(Task COMPLETE)", state.completedTasks.includes("P1.2"));
  check("HFR Test3: gitCheckpoint가 실제 commit hash로 갱신됨", state.gitCheckpoint === result.checkpoint?.commitHash);
  check("HFR Test3: next runnable task 계산됨(P2.1)", typeof state.currentTask === "string" && state.currentTask.includes("P2.1"));
}

// Test 4 — 다른 Task의 stale approval: checkpoint 금지(순수 decideNextAction 판정으로 검증).
function scenarioHumanFinalReviewStaleApprovalForOtherTaskIsRejected(): void {
  const nowIso = new Date().toISOString();
  const validReview = { decision: "PASS" as const, severity: { critical: 0, high: 0, medium: 0 }, feedback: "", nextTask: null };

  // 현재 next task는 P1.2이지만, gate는 이미 완료된 P1.1(예: 이전 task의 승인)을 가리키는
  // stale approval이다.
  const staleForCompletedTask = baseState({
    status: "WAITING_HUMAN",
    completedTasks: ["P1.1"],
    reviewCycle: 1,
    lastGptDecision: validReview,
    humanFinalReview: { taskId: "P1.1", reviewCycle: 1, status: "APPROVED", requestedAt: nowIso, approvedAt: nowIso },
  });
  check(
    "HFR Test4: 이미 완료된(다른) task용 stale approval → RESUME으로 취급되지 않음(STOP)",
    decideNextAction(staleForCompletedTask, PLANNER_FIXTURE_REGISTRY).kind === "STOP"
  );

  // gate는 아직 도달하지 않은 미래 task(P2.1)를 가리킨다 — 현재 next task(P1.2)와 다르다.
  const approvalForFutureTask = baseState({
    status: "WAITING_HUMAN",
    completedTasks: ["P1.1"],
    reviewCycle: 1,
    lastGptDecision: validReview,
    humanFinalReview: { taskId: "P2.1", reviewCycle: 1, status: "APPROVED", requestedAt: nowIso, approvedAt: nowIso },
  });
  check(
    "HFR Test4: 현재 next task(P1.2)와 다른 task용 approval → RESUME으로 취급되지 않음(STOP)",
    decideNextAction(approvalForFutureTask, PLANNER_FIXTURE_REGISTRY).kind === "STOP"
  );
}

// Test 5 — Reviewer REVISE/BLOCKED: Human Final Review로 진입시키지 않는다(기존
// REVISE/BLOCKED 경로 그대로 유지).
async function scenarioHumanFinalReviewReviewerNotApprovedNeverEntersGate(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo);
  const manifest = buildPlannerManifestWithHumanFinalReview(repo, statePath);

  const claudeRunner = async (): Promise<ClaudeResult> => ({
    success: true,
    summary: "테스트: 항상 REVISE",
    changedFiles: [],
    tests: [{ name: "proj:check", pass: true }],
    rawOutput: "",
  });
  const alwaysRevise = async (): Promise<GptReviewerReturn> => ({
    decision: "REVISE",
    severity: { critical: 0, high: 0, medium: 1 },
    feedback: "테스트: 항상 REVISE(HUMAN_FINAL_REVIEW 진입 방지 확인용)",
    nextTask: "다시 시도",
  });

  // AutoDev Efficiency / Review Stagnation Hardening(2026-08-28) — REVIEW_CYCLE_EXHAUSTED durable
  // retry(§ 위 scenarioRunAutodevOnceNotApprovedSkipsCheckpoint와 동일 원리) 때문에 sleep을
  // fake로 주입한다 — 이 alwaysRevise도 결국 기존 MAX_GPT_CALLS(10) 안전장치로 WAITING_HUMAN에
  // 도달한다(여전히 humanFinalReview gate와는 무관).
  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner, gptReviewer: alwaysRevise, sleep: async () => {}, now: () => Date.now() },
  });

  check("HFR Test5: outcome=RAN_TASK_NOT_APPROVED(Human Final Review 진입 안 함)", result.outcome === "RAN_TASK_NOT_APPROVED");
  const state = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("HFR Test5: humanFinalReview gate가 생성되지 않음", !state.humanFinalReview);
}

// Test 6 — corrupted approval/state: fail-closed(checkpoint 금지). decideNextAction()
// 판정 자체가 여러 손상/불일치 조합에서 모두 STOP인지 확인하고, approveHumanFinalReview()의
// 자체 검증(잘못된 taskId)도 함께 확인한다.
function scenarioHumanFinalReviewCorruptedOrInconsistentStateFailsClosed(): void {
  const nowIso = new Date().toISOString();
  const validGate = { taskId: "P1.2", reviewCycle: 1, status: "APPROVED" as const, requestedAt: nowIso, approvedAt: nowIso };
  const validReview = { decision: "PASS" as const, severity: { critical: 0, high: 0, medium: 0 }, feedback: "", nextTask: null };

  const missingGate = baseState({ status: "WAITING_HUMAN", completedTasks: ["P1.1"], reviewCycle: 1, lastGptDecision: validReview });
  check("HFR Test6: gate 자체가 없음 → STOP", decideNextAction(missingGate, PLANNER_FIXTURE_REGISTRY).kind === "STOP");

  const pendingGate = baseState({
    status: "WAITING_HUMAN",
    completedTasks: ["P1.1"],
    reviewCycle: 1,
    lastGptDecision: validReview,
    humanFinalReview: { ...validGate, status: "PENDING", approvedAt: undefined },
  });
  check("HFR Test6: gate.status=PENDING(아직 승인 안 됨) → STOP", decideNextAction(pendingGate, PLANNER_FIXTURE_REGISTRY).kind === "STOP");

  const rejectedGate = baseState({
    status: "WAITING_HUMAN",
    completedTasks: ["P1.1"],
    reviewCycle: 1,
    lastGptDecision: validReview,
    humanFinalReview: { ...validGate, status: "REJECTED" },
  });
  check("HFR Test6: gate.status=REJECTED → STOP", decideNextAction(rejectedGate, PLANNER_FIXTURE_REGISTRY).kind === "STOP");

  const mismatchedCycle = baseState({
    status: "WAITING_HUMAN",
    completedTasks: ["P1.1"],
    reviewCycle: 2,
    lastGptDecision: validReview,
    humanFinalReview: validGate,
  });
  check("HFR Test6: reviewCycle 불일치(다른 개발 cycle의 승인) → STOP", decideNextAction(mismatchedCycle, PLANNER_FIXTURE_REGISTRY).kind === "STOP");

  const inconsistentReviewerDecision = baseState({
    status: "WAITING_HUMAN",
    completedTasks: ["P1.1"],
    reviewCycle: 1,
    lastGptDecision: { ...validReview, decision: "REVISE" },
    humanFinalReview: validGate,
  });
  check(
    "HFR Test6: lastGptDecision이 PASS가 아닌데 gate만 APPROVED(상태 불일치) → STOP",
    decideNextAction(inconsistentReviewerDecision, PLANNER_FIXTURE_REGISTRY).kind === "STOP"
  );

  const noReviewerDecision = baseState({
    status: "WAITING_HUMAN",
    completedTasks: ["P1.1"],
    reviewCycle: 1,
    lastGptDecision: null,
    humanFinalReview: validGate,
  });
  check("HFR Test6: lastGptDecision 자체가 없음(손상) → STOP", decideNextAction(noReviewerDecision, PLANNER_FIXTURE_REGISTRY).kind === "STOP");
}

async function scenarioHumanFinalReviewApproveRejectsWrongTaskId(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo);
  const manifest = buildPlannerManifestWithHumanFinalReview(repo, statePath);
  const claudeRunner = async (): Promise<ClaudeResult> => {
    writeRepoFile(repo, "proj/hfr-test6b-marker.txt", "marker\n");
    return { success: true, summary: "테스트", changedFiles: ["proj/hfr-test6b-marker.txt"], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };
  await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  // 실제 대기 중인 task는 P1.2인데 다른 taskId로 승인을 시도 — 모호하면 승인으로 간주하지
  // 않는다(fail-closed).
  const wrongApproval = approveHumanFinalReview(statePath, "P2.1");
  check(
    "HFR Test6: 잘못된 taskId로 approve 시도 → ok=false(TASK_MISMATCH)",
    wrongApproval.ok === false && (wrongApproval.reason ?? "").startsWith("TASK_MISMATCH")
  );

  const state = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("HFR Test6: 잘못된 approve 시도 후에도 gate는 여전히 PENDING", state.humanFinalReview?.status === "PENDING");

  const secondResult = await runAutodevOnce({ manifest });
  check("HFR Test6: 잘못된 approve 시도 후 재실행해도 checkpoint 진행 안 됨(STOPPED)", secondResult.outcome === "STOPPED");
}

// Test 7 — checkpoint exactly once: valid approval 후 resume을 반복해도 동일 Task
// checkpoint가 중복 생성되거나 completedTasks가 중복되지 않는다.
async function scenarioHumanFinalReviewCheckpointExactlyOnceOnRepeatedResume(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo);
  const manifest = buildPlannerManifestWithHumanFinalReview(repo, statePath);
  const claudeRunner = async (): Promise<ClaudeResult> => {
    writeRepoFile(repo, "proj/hfr-test7-marker.txt", "marker\n");
    return { success: true, summary: "테스트", changedFiles: ["proj/hfr-test7-marker.txt"], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };
  await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });
  approveHumanFinalReview(statePath, "P1.2");

  const firstResume = await runAutodevOnce({ manifest });
  check("HFR Test7: 1차 resume outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", firstResume.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");

  // checkpoint 이후 같은 taskId로 다시 approve를 시도해도(예: 사람이 실수로 버튼을 두 번
  // 누름) gate는 이미 소비되어(status="READY", humanFinalReview=null) 거부되어야 한다.
  const repeatApproval = approveHumanFinalReview(statePath, "P1.2");
  check("HFR Test7: checkpoint 이후 같은 task 재승인 시도 → ok=false(이미 소비된 gate)", repeatApproval.ok === false);

  const stateAfter = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check(
    "HFR Test7: completedTasks에 P1.2가 정확히 한 번만 존재(중복 없음)",
    stateAfter.completedTasks.filter((id) => id === "P1.2").length === 1
  );

  const log = (spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "").trim();
  check("HFR Test7: P1.2 checkpoint가 정확히 한 번만 생성됨(product+admin=2건, +init 1건=3건)", log.split("\n").length === 3);
}

// rejectHumanFinalReview()도 최소한으로 검증한다 — REJECT는 checkpoint를 진행시키지 않고,
// 코드 변경은 working tree에 그대로 남긴다(§ 요구사항 9).
async function scenarioHumanFinalReviewRejectKeepsCheckpointBlocked(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo);
  const manifest = buildPlannerManifestWithHumanFinalReview(repo, statePath);
  const claudeRunner = async (): Promise<ClaudeResult> => {
    writeRepoFile(repo, "proj/hfr-reject-marker.txt", "marker\n");
    return { success: true, summary: "테스트", changedFiles: ["proj/hfr-reject-marker.txt"], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };
  await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  const rejection = rejectHumanFinalReview(statePath, "P1.2");
  check("HFR reject: rejectHumanFinalReview ok=true", rejection.ok === true);

  const afterReject = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("HFR reject: gate.status='REJECTED'", afterReject.humanFinalReview?.status === "REJECTED");

  // REJECT 이후 재실행해도 checkpoint가 진행되면 안 된다(gate.status!=="APPROVED").
  const afterRejectRun = await runAutodevOnce({ manifest });
  check("HFR reject: REJECT 후 재실행 outcome=STOPPED(checkpoint 진행 안 됨)", afterRejectRun.outcome === "STOPPED");

  const log = (spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "").trim();
  check("HFR reject: commit이 생성되지 않음(init 1건만)", log.split("\n").length === 1);
  check("HFR reject: developer가 만든 변경이 working tree에 그대로 보존됨", existsSync(join(repo, "proj", "hfr-reject-marker.txt")));
}

// ---------------------------------------------------------------------------
// G) AutoDev / JARVIS Unattended Continuous Development Reliability Hardening Phase 3/4 —
//    required-test 설정 preflight가 runAutodevOnce()에 실제로 배선되어 있는지 검증한다.
//    세부 판정 로직 자체의 회귀는 required-test-preflight-tests.ts가 전담한다 — 여기서는
//    "Developer/Reviewer를 부르기 전에 이 검사가 실제로 개입하는지"만 확인한다.
// ---------------------------------------------------------------------------
const REQUIRED_TEST_PREFLIGHT_REGISTRY: TaskDefinition[] = [
  { id: "P1.1", phase: 1, taskNumber: 1, title: "Phase1 Task1", prompt: "Phase1 Task1 prompt", requiredTests: [], allowedPathPrefixes: ["proj/"], prohibitedOperations: [] },
  {
    id: "P1.2",
    phase: 1,
    taskNumber: 2,
    title: "Phase1 Task2(required-test 설정 검증)",
    prompt: "Phase1 Task2 prompt",
    requiredTests: [{ name: "rtp-check", command: "npm", args: ["run", "test:rtp-check"], cwd: "root" }],
    allowedPathPrefixes: ["proj/"],
    prohibitedOperations: [],
  },
];

function buildRequiredTestPreflightManifestFor(root: string, statePath: string, registry: TaskDefinition[]): ProjectManifest {
  return {
    projectId: "required-test-preflight-fixture-project",
    projectName: "Required Test Preflight Fixture Project",
    targetProjectRoot: root,
    statePath,
    taskRegistry: registry,
    developerInstructions: "허용 범위: proj/**.",
    reviewInstructions: "proj/** 범위 밖 변경이 있으면 반드시 REVISE하세요.",
    reviewScopeDirs: ["proj/"],
    // Hardening A(Execution Contract를 Runtime 불변조건으로) — 실제 spec-planner.ts가 생성하는
    // manifest는 항상 deriveAllowedCommandsFromRequiredTests()로 allowedCommands를 requiredTests와
    // exact-match하게 파생시킨다(§ execution-contract.ts). 이 fixture도 그 실제 생성 결과를
    // 흉내내야 runtime execution-contract 재검증(autodev.ts)이 정상 통과한다 — allowedCommands를
    // 빈 배열로 두면 "task-registry와 execution-policy가 서로 실행 불가능하게 어긋난" 상태를
    // 만드는 것이므로, 그 자체가 정상 시나리오가 아니라 이 하드닝이 잡아야 하는 결함 상태다.
    executionPolicy: { ...PLANNER_EXECUTION_POLICY, allowedCommands: deriveAllowedCommandsFromRequiredTests(registry.map((t) => ({ taskId: t.id, requiredTests: t.requiredTests }))) },
  };
}

function buildRequiredTestPreflightManifest(root: string, statePath: string): ProjectManifest {
  return buildRequiredTestPreflightManifestFor(root, statePath, REQUIRED_TEST_PREFLIGHT_REGISTRY);
}

// AutoDev / JARVIS Unattended Continuous Development Reliability Hardening Phase 5 —
// "required test npm script 미등록 + 후보 파일 0개"는 새 task를 막 시작하는 정상 상태다
// (그 npm script가 가리킬 실제 테스트 파일은 이 task의 Developer가 구현 과정에서 만든다).
// 사람의 판단이 필요한 문제가 아니므로 더 이상 WAITING_HUMAN으로 전이하지 않고 Developer를
// 그대로 호출해야 한다. taskId/npm script 이름에 하드코딩된 특정 task 전용 처리가 아님을
// 증명하기 위해, 서로 다른 taskId/스크립트 이름을 쓰는 두 개의 독립된 registry로 각각
// 검증한다(scenarioRunAutodevOnceProceedsDespiteMissingRequiredTestScript는 P1.2/
// test:rtp-check를, ...ForArbitraryFutureTask는 이 저장소의 어떤 실제 task와도 무관한
// "F9"/test:future-feature를 쓴다).
async function runProceedsDespiteMissingRequiredTestScriptScenario(
  registry: TaskDefinition[],
  expectedTaskId: string,
  requiredTestName: string,
  expectedNpmScript: string,
  labelPrefix: string
): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo); // completedTasks=["P1.1"] → registry의 두 번째 task
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", scripts: {} }, null, 2) + "\n", "utf-8");
  // package.json은 실제 JARVIS처럼 이미 커밋된(tracked) 파일이어야 한다 — 여기서 커밋하지
  // 않으면 checkpoint의 기존 "allowedPathPrefixes 밖 예상치 못한 변경" 감지가 이 fixture
  // 파일 자체를 untracked 변경으로 오인해 매번 CHECKPOINT_SCOPE_VIOLATION으로 BLOCK한다 —
  // 이 required-test 재검사 로직과 무관한 실제 checkpoint 동작이므로 fixture를 실제와
  // 맞춘다.
  spawnSync("git", ["add", "--", "package.json"], { cwd: repo });
  spawnSync("git", ["commit", "-q", "-m", "package.json"], { cwd: repo });
  const manifest = buildRequiredTestPreflightManifestFor(repo, statePath, registry);

  let claudeCalls = 0;
  const markerRel = `proj/marker-${expectedTaskId}.txt`;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    writeRepoFile(repo, markerRel, "marker\n");
    return {
      success: true,
      summary: "테스트: 후보 파일 없어도 정상 호출됨",
      changedFiles: [markerRel],
      tests: [{ name: requiredTestName, pass: true }],
      rawOutput: "",
    };
  };

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check(`${labelPrefix}: Claude Developer가 정상적으로 1회 호출됨(더 이상 사전 차단하지 않음)`, claudeCalls === 1);
  check(
    `${labelPrefix}: outcome이 BLOCKED_REQUIRED_TEST_CONFIGURATION이 아님(checkpoint까지 정상 진행)`,
    result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED"
  );

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check(`${labelPrefix}: status가 WAITING_HUMAN이 아님`, (finalState.status as unknown as string) !== "WAITING_HUMAN");
  check(
    `${labelPrefix}: deferredHumanTasks에 REQUIRED_TEST_CONFIGURATION_ERROR가 기록되지 않음`,
    !finalState.deferredHumanTasks.some((t) => t.includes("REQUIRED_TEST_CONFIGURATION_ERROR"))
  );

  const pkgAfter = JSON.parse(readFileSync(join(repo, "package.json"), "utf-8"));
  check(
    `${labelPrefix}: 후보 파일이 없었으므로 package.json은 여전히 미등록 상태로 남음(추측으로 등록하지 않음)`,
    !Object.prototype.hasOwnProperty.call(pkgAfter.scripts, expectedNpmScript)
  );
}

async function scenarioRunAutodevOnceProceedsDespiteMissingRequiredTestScript(): Promise<void> {
  await runProceedsDespiteMissingRequiredTestScriptScenario(
    REQUIRED_TEST_PREFLIGHT_REGISTRY,
    "P1.2",
    "rtp-check",
    "test:rtp-check",
    "required-test preflight(P1.2)"
  );
}

// 향후 완전히 다른 task/script 이름으로도 동일하게 동작함을 증명한다 — P1.2/test:rtp-check에
// 대한 하드코딩이 아니라 공통 규칙임을 보인다(§ 요구사항 5 — task 2.1 전용 수정 금지).
const FUTURE_TASK_REQUIRED_TEST_REGISTRY: TaskDefinition[] = [
  { id: "P1.1", phase: 1, taskNumber: 1, title: "Phase1 Task1", prompt: "Phase1 Task1 prompt", requiredTests: [], allowedPathPrefixes: ["proj/"], prohibitedOperations: [] },
  {
    id: "F9",
    phase: 1,
    taskNumber: 2,
    title: "향후 임의 작업(F9)",
    prompt: "F9 prompt",
    requiredTests: [{ name: "future-feature-tests", command: "npm", args: ["run", "test:future-feature"], cwd: "root" }],
    allowedPathPrefixes: ["proj/"],
    prohibitedOperations: [],
  },
];

async function scenarioRunAutodevOnceProceedsDespiteMissingRequiredTestScriptForArbitraryFutureTask(): Promise<void> {
  await runProceedsDespiteMissingRequiredTestScriptScenario(
    FUTURE_TASK_REQUIRED_TEST_REGISTRY,
    "F9",
    "future-feature-tests",
    "test:future-feature",
    "required-test preflight(임의 향후 task F9)"
  );
}

// 필수 검증 2 — 오래된 WAITING_HUMAN(REQUIRED_TEST_CONFIGURATION_ERROR) 자동 복구. 과거
// 실행이 "npm script 미등록"을 이유로 WAITING_HUMAN을 남긴 뒤(§ Phase 3/4 시절 동작), 그
// 사이 package.json에 해당 script가 등록됐다면(원인 해소) 다음 실행이 project-state.json을
// 직접 손대지 않고도 스스로 정상 상태로 복구되어 같은 task를 계속 진행해야 한다.
async function scenarioRunAutodevOnceReconcilesStaleRequiredTestConfigWaitingHuman(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, {
    status: "WAITING_HUMAN",
    deferredHumanTasks: ["REQUIRED_TEST_CONFIGURATION_ERROR: task=P1.2 requiredTest=rtp-check missingScript=test:rtp-check"],
  });
  // 원인 해소: package.json에 필요한 npm script가 이미 등록돼 있다(예: 620992e 같은 별도
  // 커밋으로) — 다만 project-state.json은 아직 그 사실을 반영하지 못한 채 WAITING_HUMAN에
  // 머물러 있는 상태를 재현한다.
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { "test:rtp-check": "node proj/rtp-check.test.mjs" } }, null, 2) + "\n",
    "utf-8"
  );
  spawnSync("git", ["add", "--", "package.json"], { cwd: repo });
  spawnSync("git", ["commit", "-q", "-m", "package.json"], { cwd: repo });
  const manifest = buildRequiredTestPreflightManifest(repo, statePath);

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    writeRepoFile(repo, "proj/marker-stale-recovery.txt", "marker\n");
    return {
      success: true,
      summary: "테스트: 오래된 WAITING_HUMAN 자동복구 이후 정상 진행",
      changedFiles: ["proj/marker-stale-recovery.txt"],
      tests: [{ name: "rtp-check", pass: true }],
      rawOutput: "",
    };
  };

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check(
    "오래된 WAITING_HUMAN 자동복구: project-state.json을 사람이 직접 고치지 않아도 같은 task가 자동으로 재개됨(checkpoint까지 도달)",
    result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED"
  );
  check("오래된 WAITING_HUMAN 자동복구: Claude Developer가 정상적으로 1회 호출됨", claudeCalls === 1);

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("오래된 WAITING_HUMAN 자동복구: 최종 status가 WAITING_HUMAN이 아님", (finalState.status as unknown as string) !== "WAITING_HUMAN");
  check(
    "오래된 WAITING_HUMAN 자동복구: 예전 REQUIRED_TEST_CONFIGURATION_ERROR deferredHumanTasks가 제거됨",
    !finalState.deferredHumanTasks.some((t) => t.includes("REQUIRED_TEST_CONFIGURATION_ERROR"))
  );
}

// 실제 사람 판단이 필요한 WAITING_HUMAN(예: Human Final Review PENDING)은 이 재검사로 절대
// 자동 해제되지 않아야 한다 — deferredHumanTasks 문자열이 REQUIRED_TEST_CONFIGURATION_ERROR
// 형태가 아니므로 애초에 매칭되지 않는다는 것을 직접 증명한다.
async function scenarioRunAutodevOnceDoesNotReconcileGenuineHumanFinalReviewWaitingHuman(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, {
    status: "WAITING_HUMAN",
    humanFinalReview: { taskId: "P1.2", reviewCycle: 0, status: "PENDING", requestedAt: new Date().toISOString() },
    deferredHumanTasks: ["HUMAN_FINAL_REVIEW_PENDING(P1.2): reviewer APPROVED — checkpoint 전 사람의 최종 승인이 필요합니다."],
    lastGptDecision: { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "테스트", nextTask: null },
  });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { "test:rtp-check": "node proj/rtp-check.test.mjs" } }, null, 2) + "\n",
    "utf-8"
  );
  spawnSync("git", ["add", "--", "package.json"], { cwd: repo });
  spawnSync("git", ["commit", "-q", "-m", "package.json"], { cwd: repo });
  const manifest = buildRequiredTestPreflightManifest(repo, statePath);

  const result = await runAutodevOnce({ manifest });

  check("실제 사람 판단 필요 상태 보호: Human Final Review PENDING은 자동 해제되지 않고 STOPPED 유지", result.outcome === "STOPPED");
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("실제 사람 판단 필요 상태 보호: status가 여전히 WAITING_HUMAN", (finalState.status as unknown as string) === "WAITING_HUMAN");
  check(
    "실제 사람 판단 필요 상태 보호: humanFinalReview gate가 여전히 PENDING(위조/자동승인 없음)",
    finalState.humanFinalReview?.status === "PENDING"
  );
}

// 필수 검증 53 — 실패 작업물 다음 시도 전달: 직전 시도가 scope violation으로 BLOCK된 뒤
// (예: Telegram 승인으로 status가 READY로 복귀했지만 lastGptDecision/lastClaudeResult는
// 그대로 남아있는 실제 auto-resume.ts 패턴), 다음 attempt의 Developer 초기 transcript에
// "이 파일은 완료된 기존 구현이 아니라 미승인 변경"이라는 사실과 scope violation 목록/
// Reviewer 지적이 실제로 전달되는지 검증한다(§ autodev.ts previousAttemptResult seed).
async function scenarioRunAutodevOncePassesPreviousScopeViolationContextToNextDeveloper(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, {
    status: "READY",
    lastClaudeResult: {
      success: true,
      summary: "이전 시도 요약",
      changedFiles: ["proj/wrong-place.txt"],
      tests: [{ name: "rtp-check", pass: false }],
      rawOutput: "",
    },
    lastGptDecision: {
      decision: "BLOCK",
      severity: { critical: 0, high: 0, medium: 1 },
      feedback: "허용 경로 밖 변경입니다.",
      nextTask: null,
      scopeViolations: ["proj/wrong-place.txt"],
    } as unknown as ProjectState["lastGptDecision"],
  });
  const manifest = buildPlannerManifest(repo, statePath); // P1.2, requiredTests=[]

  let capturedFirstRoundInput: string | undefined;
  const developerClaudeCaller = async (input: string): Promise<RealClaudeResult> => {
    if (capturedFirstRoundInput === undefined) capturedFirstRoundInput = input;
    return {
      success: true,
      summary: JSON.stringify({ type: "TASK_COMPLETE", summary: "재작업 완료", changedFiles: [], testsRequested: [] }),
      changedFiles: [],
      tests: [],
      rawOutput: "",
    };
  };

  await runAutodevOnce({ manifest, orchestratorDeps: { gptReviewer: fakePassReviewer() }, developerClaudeCaller });

  check(
    "실패 작업물 전달: 이전 시도가 미승인 변경이라는 안내가 Developer 초기 입력에 포함됨",
    !!capturedFirstRoundInput?.includes("미승인")
  );
  check(
    "실패 작업물 전달: scope violation 파일 목록이 실제로 전달됨",
    !!capturedFirstRoundInput?.includes("proj/wrong-place.txt")
  );
  check(
    "실패 작업물 전달: Reviewer 지적 내용이 실제로 전달됨",
    !!capturedFirstRoundInput?.includes("허용 경로 밖 변경입니다")
  );
}

// AutoDev Core Maintenance(2026-08-30) — 직전 시도의 required test 실패 근거
// (failureEvidence/denyReason)가 다음 attempt의 Developer 초기 입력에 실제로 전달되는지
// 검증한다(§ types.ts ClaudeResult.tests.denyReason, JARVIS Task 5.2 실측 — 이전에는
// denyReason이 automation.log에만 남고 어디에도 전달되지 않아 Developer가 매번 원인을
// 추측했다).
async function scenarioRunAutodevOncePassesPreviousFailureEvidenceToNextDeveloper(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, {
    status: "READY",
    lastClaudeResult: {
      success: true,
      summary: "이전 시도 요약",
      changedFiles: [],
      tests: [
        {
          name: "wakeword-unit",
          pass: false,
          denyReason: "Executable Identity Trust(TRUSTED_EXECUTABLE_NOT_FOUND): gradlew.bat가 존재하지 않습니다.",
        },
      ],
      rawOutput: "",
    },
    lastGptDecision: {
      decision: "REVISE",
      severity: { critical: 0, high: 0, medium: 1 },
      feedback: "required test 실패",
      nextTask: null,
    } as unknown as ProjectState["lastGptDecision"],
  });
  const manifest = buildPlannerManifest(repo, statePath); // P1.2, requiredTests=[]

  let capturedFirstRoundInput: string | undefined;
  const developerClaudeCaller = async (input: string): Promise<RealClaudeResult> => {
    if (capturedFirstRoundInput === undefined) capturedFirstRoundInput = input;
    return {
      success: true,
      summary: JSON.stringify({ type: "TASK_COMPLETE", summary: "재작업 완료", changedFiles: [], testsRequested: [] }),
      changedFiles: [],
      tests: [],
      rawOutput: "",
    };
  };

  await runAutodevOnce({ manifest, orchestratorDeps: { gptReviewer: fakePassReviewer() }, developerClaudeCaller });

  check(
    "직전 실패 근거 전달: '직전 시도의 실제 실패 근거' 안내 헤더가 포함됨",
    !!capturedFirstRoundInput?.includes("직전 시도의 실제 실패 근거")
  );
  check(
    "직전 실패 근거 전달: denyReason 원문(TRUSTED_EXECUTABLE_NOT_FOUND)이 그대로 전달됨(추측 아님)",
    !!capturedFirstRoundInput?.includes("TRUSTED_EXECUTABLE_NOT_FOUND")
  );
}

// AutoDev Core Maintenance(2026-08-30) — Deterministic Execution-Environment Preflight가
// 실제 runAutodevOnce() 경로에 배선되어, 결함 있는 required test 실행 환경에서는 Developer를
// 전혀 호출하지 않고 즉시 WAITING_HUMAN으로 전환하는지 검증한다(§ required-test-preflight.ts
// checkRequiredTestExecutionEnvironment, JARVIS Task 5.2 재현 — cwd:"root"인데 실제
// gradlew wrapper는 android/wakeword/에만 있음).
const EXECUTION_ENVIRONMENT_TASK_REGISTRY: TaskDefinition[] = [
  {
    id: "G1",
    phase: 1,
    taskNumber: 1,
    title: "Android wakeword unit test",
    prompt: "wakeword 모듈 단위 테스트",
    requiredTests: [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "root" }],
    allowedPathPrefixes: ["android/wakeword/"],
    prohibitedOperations: [],
  },
];
const EXECUTION_ENVIRONMENT_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["android/wakeword/"],
  allowedWritePrefixes: ["android/wakeword/"],
  allowedCommands: [],
};

async function scenarioRunAutodevOnceBlocksOnBrokenRequiredTestExecutionEnvironment(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { status: "READY", completedTasks: [] });
  const manifest: ProjectManifest = {
    projectId: "execution-env-fixture-project",
    projectName: "Execution Env Fixture Project",
    targetProjectRoot: repo,
    statePath,
    taskRegistry: EXECUTION_ENVIRONMENT_TASK_REGISTRY,
    developerInstructions: "허용 범위: android/wakeword/**.",
    reviewInstructions: "android/wakeword/** 범위 밖 변경이 있으면 반드시 REVISE하세요.",
    reviewScopeDirs: ["android/wakeword/"],
    executionPolicy: EXECUTION_ENVIRONMENT_POLICY,
  };
  const events = createInMemoryEventStore();

  let developerCallCount = 0;
  const developerClaudeCaller = async (): Promise<RealClaudeResult> => {
    developerCallCount += 1;
    return { success: true, summary: JSON.stringify({ type: "TASK_COMPLETE", summary: "x", changedFiles: [], testsRequested: [] }), changedFiles: [], tests: [], rawOutput: "" };
  };

  const result = await runAutodevOnce({ manifest, events, orchestratorDeps: { gptReviewer: fakePassReviewer() }, developerClaudeCaller });

  check(
    "실행 환경 preflight 차단: outcome=BLOCKED_REQUIRED_TEST_EXECUTION_ENVIRONMENT",
    result.outcome === "BLOCKED_REQUIRED_TEST_EXECUTION_ENVIRONMENT"
  );
  check("실행 환경 preflight 차단: Developer가 단 한 번도 호출되지 않음", developerCallCount === 0);
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  // P0-4 하드닝(독립 감사) — 이 결함은 실제 사람의 판단이 필요한 게 아니라 순수 config
  // 문제다. status는 이제 WAITING_HUMAN이 아니라 기술적 BLOCKED다(§ autodev.ts P0-4 주석).
  check("P0-4) 실행 환경 preflight 차단: status=BLOCKED(WAITING_HUMAN 아님)", (finalState.status as unknown as string) === "BLOCKED");
  check(
    "실행 환경 preflight 차단: deferredHumanTasks에 REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR 마커가 기록됨",
    finalState.deferredHumanTasks.some((t) => t.startsWith("REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR:") && t.includes("wakeword-unit"))
  );
  const all = events.query().events;
  check(
    "P0-4) 실행 환경 preflight 차단: HUMAN_APPROVAL_REQUIRED event가 생성되지 않음(genuine Human Gate 아님)",
    !all.some((e) => e.eventType === "HUMAN_APPROVAL_REQUIRED")
  );
  check(
    "P0-4) 실행 환경 preflight 차단: humanInterventionRequired=true인 event가 하나도 없음",
    !all.some((e) => e.humanInterventionRequired === true)
  );
  check("P0-4) 실행 환경 preflight 차단: RUN_BLOCKED event가 대신 기록됨(대시보드 집계는 유지)", all.some((e) => e.eventType === "RUN_BLOCKED"));
}

// P0-4 하드닝(독립 감사) — REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR로 BLOCKED된 상태도
// (WAITING_HUMAN과 마찬가지로) 원인이 해소되면 사람의 명시적 승인 없이 자동으로 READY로
// 복구되어야 한다(§ autodev.ts reconcileStaleRequiredTestExecutionEnvironmentTasks 호출부의
// status==="BLOCKED" 확장). CWD_NOT_FOUND(디렉터리 자체가 없음)를 쓴다 — WRAPPER_NOT_FOUND와
// 달리 실제 gradle/Java trust 판정 없이 디렉터리 생성만으로 결정론적으로 재현/해소할 수 있다.
async function scenarioRunAutodevOnceReconcilesStaleRequiredTestExecutionEnvironmentBlocked(): Promise<void> {
  const repo = makeTempGitRepo();
  const registry: TaskDefinition[] = [
    {
      id: "G2",
      phase: 1,
      taskNumber: 1,
      title: "fixture task",
      prompt: "fixture",
      requiredTests: [{ name: "fixture-check", command: "node", args: ["--version"], cwd: "sub" }],
      allowedPathPrefixes: ["proj/"],
      prohibitedOperations: [],
    },
  ];
  const statePath = makeTempStateFile(repo, {
    status: "BLOCKED",
    completedTasks: [],
    deferredHumanTasks: [
      `REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR: task=G2 requiredTest=fixture-check kind=CWD_NOT_FOUND cwd=sub resolvedPath=${join(repo, "sub")}`,
    ],
  });
  const manifest: ProjectManifest = {
    projectId: "execution-env-reconcile-project",
    projectName: "Execution Env Reconcile Project",
    targetProjectRoot: repo,
    statePath,
    taskRegistry: registry,
    developerInstructions: "허용 범위: proj/**.",
    reviewInstructions: "proj/** 범위 밖 변경이 있으면 반드시 REVISE하세요.",
    reviewScopeDirs: ["proj/"],
    // Hardening A — 위 REQUIRED_TEST_PREFLIGHT_REGISTRY fixture와 동일한 이유로, 실제
    // spec-planner.ts 산출물과 동일하게 이 task의 requiredTest와 exact-match하는 allowedCommands를
    // 채운다(§ deriveAllowedCommandsFromRequiredTests).
    executionPolicy: {
      allowedReadPrefixes: ["proj/"],
      allowedWritePrefixes: ["proj/"],
      allowedCommands: deriveAllowedCommandsFromRequiredTests(registry.map((t) => ({ taskId: t.id, requiredTests: t.requiredTests }))),
      commandCwdAliases: { sub: "sub" },
    },
  };

  // 원인 해소: 그 사이(예: 사람이 project adapter 밖에서) "sub/" 디렉터리가 실제로 생겼다.
  const subDir = join(repo, "sub");
  if (!existsSync(subDir)) mkdirSync(subDir, { recursive: true });

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    writeRepoFile(repo, "proj/marker-g2.txt", "marker\n");
    return {
      success: true,
      summary: "테스트: 오래된 BLOCKED 자동복구 이후 정상 진행",
      changedFiles: ["proj/marker-g2.txt"],
      tests: [{ name: "fixture-check", pass: true }],
      rawOutput: "",
    };
  };

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check(
    "P0-4) 오래된 BLOCKED(실행환경) 자동복구: 사람이 직접 고치지 않아도 같은 task가 자동으로 재개됨(checkpoint까지 도달)",
    result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED"
  );
  check("P0-4) 오래된 BLOCKED(실행환경) 자동복구: Claude Developer가 정상적으로 1회 호출됨", claudeCalls === 1);

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("P0-4) 오래된 BLOCKED(실행환경) 자동복구: 최종 status가 BLOCKED가 아님", (finalState.status as unknown as string) !== "BLOCKED");
  check(
    "P0-4) 오래된 BLOCKED(실행환경) 자동복구: deferredHumanTasks에서 마커가 제거됨",
    !finalState.deferredHumanTasks.some((t) => t.startsWith("REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR:"))
  );
}

// 필수 검증 — 직전 시도의 미승인 scope-violation 작업물을 attempt 시작 전에 결정론적으로
// 정리한다(§ autodev.ts Phase 7). untracked + 현재 task의 allowedPathPrefixes 밖 + 직전
// lastGptDecision.scopeViolations에 정확히 나열된 경우에만 삭제되고, tracked 파일이나
// scopeViolations에 없는 파일, 허용 경로 안 파일은 절대 건드리지 않는다.
async function scenarioRunAutodevOnceCleansUpUntrackedScopeViolationFilesBeforeNextAttempt(): Promise<void> {
  const repo = makeTempGitRepo();
  // 허용 경로(proj/) 밖에 직전 시도가 남긴 untracked 파일 — 삭제 대상.
  writeRepoFile(repo, "other/wrong-place.txt", "leftover\n");
  // scopeViolations에 없는 untracked 파일 — 절대 건드리면 안 됨(범위 밖이라도 명시적으로
  // 나열된 것만 삭제한다).
  writeRepoFile(repo, "other/unrelated.txt", "unrelated\n");
  // 허용 경로(proj/) 안의 untracked 파일이 실수로 scopeViolations에 나열돼도 삭제되면
  // 안 됨(범위 안은 항상 "이어서 진행" 대상이지 정리 대상이 아니다).
  writeRepoFile(repo, "proj/in-scope-leftover.txt", "in-scope\n");
  // tracked(이미 commit된) 파일이 scopeViolations에 나열돼도 절대 삭제하면 안 됨 — 이미
  // 커밋된 사용자/과거 작업을 이 경로로 지우지 않는다는 안전조건의 핵심 증거.
  writeRepoFile(repo, "other/tracked-file.txt", "already committed\n");
  spawnSync("git", ["add", "--", "other/tracked-file.txt"], { cwd: repo });
  spawnSync("git", ["commit", "-q", "-m", "tracked file"], { cwd: repo });

  const statePath = makeTempStateFile(repo, {
    status: "READY",
    lastClaudeResult: {
      success: true,
      summary: "이전 시도 요약",
      changedFiles: ["other/wrong-place.txt"],
      tests: [{ name: "x", pass: false }],
      rawOutput: "",
    },
    lastGptDecision: {
      decision: "BLOCK",
      severity: { critical: 0, high: 0, medium: 1 },
      feedback: "허용 경로 밖 변경입니다.",
      nextTask: null,
      scopeViolations: ["other/wrong-place.txt", "proj/in-scope-leftover.txt", "other/tracked-file.txt"],
    } as unknown as ProjectState["lastGptDecision"],
  });
  const manifest = buildPlannerManifest(repo, statePath); // P1.2, allowedPathPrefixes=["proj/"]

  const developerClaudeCaller = async (): Promise<RealClaudeResult> => ({
    success: true,
    summary: JSON.stringify({ type: "TASK_COMPLETE", summary: "완료", changedFiles: [], testsRequested: [] }),
    changedFiles: [],
    tests: [],
    rawOutput: "",
  });

  await runAutodevOnce({ manifest, orchestratorDeps: { gptReviewer: fakePassReviewer() }, developerClaudeCaller });

  check(
    "scope-violation 정리: untracked + 허용 경로 밖 + scopeViolations에 정확히 나열된 파일은 삭제됨",
    !existsSync(join(repo, "other/wrong-place.txt"))
  );
  check(
    "scope-violation 정리: scopeViolations에 없는 untracked 파일은 삭제되지 않음(추측 삭제 금지)",
    existsSync(join(repo, "other/unrelated.txt"))
  );
  check(
    "scope-violation 정리: 허용 경로 안 파일은 scopeViolations에 나열돼도 삭제되지 않음(이어서 진행 대상 보존)",
    existsSync(join(repo, "proj/in-scope-leftover.txt"))
  );
  check(
    "scope-violation 정리: tracked(이미 commit된) 파일은 scopeViolations에 나열돼도 절대 삭제되지 않음",
    existsSync(join(repo, "other/tracked-file.txt"))
  );
}

// AutoDev / JARVIS 신뢰성 보완(2026-08-27) — Canonical Human Gate Policy(§ human-gate-policy.ts)
// 기반 기술적 WAITING_HUMAN 자동 복구. REQUIRED_TEST_CONFIGURATION_ERROR 외에도
// REVIEW_CYCLE_EXHAUSTED/CHECKPOINT_SCOPE_VIOLATION/REVIEW_BLOCKED로 저장된 과거 WAITING_HUMAN은
// Telegram 승인 없이 자동으로 READY로 복구되어 같은 task가 재개돼야 한다.
async function scenarioRunAutodevOnceReconcilesStaleReviewCycleExhaustedWaitingHuman(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, {
    status: "WAITING_HUMAN",
    lastGptDecision: { decision: "REVISE", severity: { critical: 0, high: 0, medium: 1 }, feedback: "테스트: REVISE 반복", nextTask: null },
    deferredHumanTasks: [
      "REVIEW_CYCLE_EXHAUSTED: REVISE가 MAX_REVIEW_CYCLES(5)회 도달로 자동 진행을 중단합니다(단순 승인으로 완료 처리 불가).",
    ],
  });
  const manifest = buildPlannerManifest(repo, statePath); // P1.2

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    writeRepoFile(repo, "proj/marker-review-cycle-recovery.txt", "marker\n");
    return {
      success: true,
      summary: "테스트: REVIEW_CYCLE_EXHAUSTED 자동복구 이후 정상 진행",
      changedFiles: ["proj/marker-review-cycle-recovery.txt"],
      tests: [{ name: "proj:check", pass: true }],
      rawOutput: "",
    };
  };

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check(
    "REVIEW_CYCLE_EXHAUSTED 자동복구: Telegram 승인 없이 같은 task가 재개되어 checkpoint까지 도달",
    result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED"
  );
  check("REVIEW_CYCLE_EXHAUSTED 자동복구: Claude Developer가 정상적으로 재호출됨", claudeCalls === 1);
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("REVIEW_CYCLE_EXHAUSTED 자동복구: 최종 status가 WAITING_HUMAN이 아님", (finalState.status as unknown as string) !== "WAITING_HUMAN");
  check(
    "REVIEW_CYCLE_EXHAUSTED 자동복구: 옛 deferredHumanTasks 마커가 제거됨",
    !finalState.deferredHumanTasks.some((t) => t.includes("REVIEW_CYCLE_EXHAUSTED"))
  );
}

// CHECKPOINT_SCOPE_VIOLATION은 GPT Reviewer가 아니라 Core checkpoint 자신의 독립 판정(§
// checkpoint.ts plan.unexpected)으로도 발생할 수 있다(Reviewer는 PASS했지만 범위 밖 파일이
// 남아있던 경우) — 이 leftover는 state.lastGptDecision.scopeViolations에는 없고 오직
// deferredHumanTasks의 CHECKPOINT_BLOCKED 마커 안에만 있다. 자동 복구가 이 마커에서도 정리
// 대상을 추출해(§ human-gate-policy.ts extractCheckpointScopeViolationFiles) 정리하는지 검증한다.
async function scenarioRunAutodevOnceReconcilesStaleCheckpointScopeViolationAndCleansUpLeftover(): Promise<void> {
  const repo = makeTempGitRepo();
  writeRepoFile(repo, "other/leftover-from-checkpoint-block.txt", "leftover\n");
  const statePath = makeTempStateFile(repo, {
    status: "WAITING_HUMAN",
    lastGptDecision: { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "테스트: 문제 없음", nextTask: null },
    deferredHumanTasks: [
      "CHECKPOINT_BLOCKED(P1.2): 예상치 못한 범위 밖 파일 변경이 있어 commit을 중단했습니다. — unexpected: other/leftover-from-checkpoint-block.txt",
    ],
  });
  const manifest = buildPlannerManifest(repo, statePath); // P1.2, allowedPathPrefixes=["proj/"]

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    writeRepoFile(repo, "proj/marker-checkpoint-block-recovery.txt", "marker\n");
    return {
      success: true,
      summary: "테스트: CHECKPOINT_SCOPE_VIOLATION 자동복구 이후 정상 진행",
      changedFiles: ["proj/marker-checkpoint-block-recovery.txt"],
      tests: [{ name: "proj:check", pass: true }],
      rawOutput: "",
    };
  };

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check(
    "CHECKPOINT_SCOPE_VIOLATION 자동복구: Telegram 승인 없이 같은 task가 재개되어 checkpoint까지 도달",
    result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED"
  );
  check("CHECKPOINT_SCOPE_VIOLATION 자동복구: Claude Developer가 정상적으로 재호출됨", claudeCalls === 1);
  check(
    "CHECKPOINT_SCOPE_VIOLATION 자동복구: GPT가 보고하지 않은 leftover도 checkpoint 마커 기반으로 정리됨",
    !existsSync(join(repo, "other/leftover-from-checkpoint-block.txt"))
  );
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("CHECKPOINT_SCOPE_VIOLATION 자동복구: 최종 status가 WAITING_HUMAN이 아님", (finalState.status as unknown as string) !== "WAITING_HUMAN");
}

// § BLOCKER 2 재하드닝(독립 최종 감사, 2026-08-30) — Technical/Human Gate Matrix. 이전에는
// REVIEW_BLOCKED(orchestrator.ts)/CHECKPOINT_BLOCKED-scope-violation(autodev.ts) event가
// 실제로 canonical classifier(human-gate-policy.ts)와 무관하게 humanInterventionRequired를
// 무조건 true로 실었다 — 이 두 case는 classifier가 이미 TECHNICAL_AUTO_RECOVERABLE로
// 판정하는(Reviewer 코드 품질 BLOCK/scope violation) case이므로, 실제로 emit되는 event의
// humanInterventionRequired도 그와 일치해야 한다(Human Gate=0). Secret/Dependency에 의한
// CHECKPOINT_BLOCKED(진짜 genuine)는 계속 humanInterventionRequired=true여야 한다는 것은
// scenarioSecretPrecheckDoesNotRepeatDeveloperCallWhenFindingPersists가 별도로 지킨다(아래
// 함수가 그 regression도 함께 재확인한다).
async function scenarioTechnicalHumanGateMatrixReviewBlockAndScopeViolation(): Promise<void> {
  // --- 행 1: Reviewer BLOCK 결정 → REVIEW_BLOCKED event는 기술적(Human Gate=0) ---
  {
    const repo = makeTempGitRepo();
    const statePath = makeTempStateFile(repo, { status: "READY", completedTasks: ["P1.1"] });
    const manifest = buildPlannerManifest(repo, statePath); // 다음 task = P1.2
    const events = createInMemoryEventStore();
    const claudeRunner = async (): Promise<ClaudeResult> => {
      writeRepoFile(repo, "proj/matrix-review-block.txt", "marker\n");
      return {
        success: true,
        summary: "매트릭스: 리뷰 BLOCK 유발용",
        changedFiles: ["proj/matrix-review-block.txt"],
        tests: [{ name: "proj:check", pass: true }],
        rawOutput: "",
      };
    };
    const blockReviewer = async (): Promise<GptReviewerReturn> => ({
      decision: "BLOCK",
      severity: { critical: 0, high: 1, medium: 0 },
      feedback: "매트릭스 테스트: 코드 품질 문제로 BLOCK",
      nextTask: null,
    });
    const result = await runAutodevOnce({ manifest, events, orchestratorDeps: { claudeRunner, gptReviewer: blockReviewer } });

    check("매트릭스[Reviewer BLOCK]: outcome=RAN_TASK_NOT_APPROVED", result.outcome === "RAN_TASK_NOT_APPROVED");
    const all = events.query().events;
    const reviewBlocked = all.filter((e) => e.eventType === "REVIEW_BLOCKED");
    check("매트릭스[Reviewer BLOCK]: REVIEW_BLOCKED event가 정확히 1건 기록됨", reviewBlocked.length === 1);
    check(
      "매트릭스[Reviewer BLOCK]: REVIEW_BLOCKED event의 humanInterventionRequired=false(기술적 — Developer가 고칠 문제)",
      reviewBlocked.every((e) => e.humanInterventionRequired === false)
    );
    check(
      "매트릭스[Reviewer BLOCK]: genuine HUMAN_APPROVAL_REQUIRED event는 생성되지 않음(Human Gate=0)",
      !all.some((e) => e.eventType === "HUMAN_APPROVAL_REQUIRED")
    );

    // 재실행(Telegram 승인 없이) — 기술적 자동 복구로 같은 task가 이어져야 한다.
    let secondCalls = 0;
    const claudeRunner2 = async (): Promise<ClaudeResult> => {
      secondCalls += 1;
      writeRepoFile(repo, "proj/matrix-review-block-fixed.txt", "fixed\n");
      return {
        success: true,
        summary: "매트릭스: 재시도 성공",
        changedFiles: ["proj/matrix-review-block-fixed.txt"],
        tests: [{ name: "proj:check", pass: true }],
        rawOutput: "",
      };
    };
    const second = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner: claudeRunner2, gptReviewer: fakePassReviewer() } });
    check("매트릭스[Reviewer BLOCK]: 자동 복구 후 재시도 → outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", second.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
    check("매트릭스[Reviewer BLOCK]: 자동 복구 재시도에서 Developer가 실제로 다시 호출됨(정확히 1회)", secondCalls === 1);
  }

  // --- 행 2: Core checkpoint 자신의 scope-violation 판정(Reviewer는 놓침) → 기술적(Human Gate=0) ---
  {
    const repo = makeTempGitRepo();
    const statePath = makeTempStateFile(repo, { status: "READY", completedTasks: ["P1.1"] });
    const manifest = buildPlannerManifest(repo, statePath); // allowedPathPrefixes=["proj/"]
    const events = createInMemoryEventStore();
    const claudeRunner = async (): Promise<ClaudeResult> => {
      writeRepoFile(repo, "proj/matrix-scope-ok.txt", "marker\n");
      writeRepoFile(repo, "other/matrix-scope-violation.txt", "leftover\n");
      return {
        success: true,
        summary: "매트릭스: scope violation 유발용(Reviewer는 놓침)",
        changedFiles: ["proj/matrix-scope-ok.txt"], // Reviewer에게는 이 파일만 보고됨
        tests: [{ name: "proj:check", pass: true }],
        rawOutput: "",
      };
    };
    const result = await runAutodevOnce({ manifest, events, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

    check("매트릭스[Scope Violation]: outcome=RAN_TASK_CHECKPOINT_BLOCKED", result.outcome === "RAN_TASK_CHECKPOINT_BLOCKED");
    const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
    check(
      "매트릭스[Scope Violation]: deferredHumanTasks에 CHECKPOINT_BLOCKED(scope violation) 마커 기록됨",
      finalState.deferredHumanTasks.some((t) => t.startsWith("CHECKPOINT_BLOCKED(") && t.includes("other/matrix-scope-violation.txt"))
    );
    const all = events.query().events;
    const checkpointBlockedEvents = all.filter((e) => e.eventType === "HUMAN_APPROVAL_REQUIRED" && e.executionPhase === "checkpoint");
    check("매트릭스[Scope Violation]: checkpoint HUMAN_APPROVAL_REQUIRED event가 정확히 1건 기록됨", checkpointBlockedEvents.length === 1);
    check(
      "매트릭스[Scope Violation]: 그 event의 humanInterventionRequired=false(기술적 — scope violation은 자동 정리됨)",
      checkpointBlockedEvents.every((e) => e.humanInterventionRequired === false)
    );

    try {
      rmSync(join(repo, "other"), { recursive: true, force: true });
    } catch {
      /* 정리 실패는 테스트 결과에 영향 없음 */
    }
  }
}

// AutoDev / JARVIS 최종 무인개발 구조 보완 — Process/Restart Circuit Breaker(§ 요구사항
// 20/21). status가 종결값이 아닌 mid-flight 값("CLAUDE_WORKING")으로 남아있다는 것은 직전
// 프로세스가 그 상태를 종결하지 못한 채 죽었다는 뜻이다.
//
// AutoDev Core Maintenance(2026-08-30, Category A/C) — 2026-08-28 정책은 "process crash는
// 아무리 반복돼도 Human Gate로 승격하지 않는다"였으나, 그 전제("이 프로세스를 빠르게 자동
// 재시작시키는 supervisor가 없다")가 runner-supervisor.ts(및 그 crash watchdog)의 등장으로
// 깨졌다 — deterministic-simulation.ts Run C가 실제로 재현: 동일 task가 매 attempt마다
// 프로세스를 죽이면 supervisor가 이를 영원히 재시작하며 "동일 deterministic 실패에 무제한
// 재시도 금지" 원칙을 위반한다. 이제는 MAX_MID_FLIGHT_UNEXPECTED_EXIT_COUNT(5)를 넘으면
// Developer를 다시 호출하지 않고 즉시 genuine WAITING_HUMAN으로 승격한다.
async function scenarioRunAutodevOnceEscalatesAfterMidFlightCrashLoopExceedsCap(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, {
    status: "CLAUDE_WORKING",
    technicalRecoveryState: {
      taskId: "P1.2",
      sameFailureCount: 0,
      rootCauseAnalysisCount: 0,
      providerTimeoutCount: 0,
      unexpectedExitCount: 5,
      updatedAt: new Date().toISOString(),
    },
  });
  const manifest = buildPlannerManifest(repo, statePath); // completedTasks=["P1.1"] → 다음은 P1.2

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return { success: true, summary: "호출되면 안 됨 — 상한 초과", changedFiles: [], tests: [], rawOutput: "" };
  };

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check("상한 초과: Developer가 호출되지 않음(claudeCalls=0)", claudeCalls === 0);
  check("상한 초과: outcome=BLOCKED_MID_FLIGHT_CRASH_LOOP", result.outcome === "BLOCKED_MID_FLIGHT_CRASH_LOOP");
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  // AutoDev Core Maintenance(2026-08-30) — WAITING_HUMAN이 아니라 BLOCKED다: 이 상태는
  // 사람이 "승인"해서 풀리는 genuine Human Gate가 아니라(run.ts는 정확히
  // status==="WAITING_HUMAN" 문자열만 보고 Telegram controller를 살려 승인을 기다린다 —
  // BLOCKED는 그 조건에 해당하지 않으므로 Human Gate/알림이 켜지지 않는다) 기술적
  // 안전정지다.
  check("상한 초과: 최종 status=BLOCKED(WAITING_HUMAN 아님 — Human Gate 활성화 안 함)", (finalState.status as unknown as string) === "BLOCKED");
  check(
    "상한 초과: MID_FLIGHT_CRASH_LOOP_DETECTED 마커가 기록됨(evidence 보존)",
    finalState.deferredHumanTasks.some((t) => t.startsWith("MID_FLIGHT_CRASH_LOOP_DETECTED:"))
  );
  check("상한 초과: task P1.2는 completedTasks에 없음(자동 승인 아님)", !finalState.completedTasks.includes("P1.2"));
  check("상한 초과: durable unexpectedExitCount가 6으로 계속 기록됨(진단 가능)", finalState.technicalRecoveryState?.unexpectedExitCount === 6);

  // 재시작(같은 task, 같은 project) 이후에도 상한이 계속 지켜지는지 확인한다 — decideNextAction의
  // status==="BLOCKED" STOP 분기가 없으면 여기서 Developer가 다시 호출된다.
  let claudeCallsAfterRestart = 0;
  const claudeRunnerAfterRestart = async (): Promise<ClaudeResult> => {
    claudeCallsAfterRestart += 1;
    return { success: true, summary: "호출되면 안 됨 — BLOCKED 유지되어야 함", changedFiles: [], tests: [], rawOutput: "" };
  };
  const resultAfterRestart = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner: claudeRunnerAfterRestart, gptReviewer: fakePassReviewer() } });
  check("상한 초과 후 재시작: Developer가 다시 호출되지 않음(claudeCallsAfterRestart=0)", claudeCallsAfterRestart === 0);
  check("상한 초과 후 재시작: outcome=STOPPED(BLOCKED 유지)", resultAfterRestart.outcome === "STOPPED");
}

// AutoDev 최종 통합 하드닝(Hardening E, No-Progress를 Hard Switch로) — durable하게 누적된
// noWriteRepeatCount(WRITE 없이 연속 실패)가 MAX_MID_FLIGHT_UNEXPECTED_EXIT_COUNT(5)에
// 도달하면, buildNoWriteStrategyEscalationHint가 매번 더 강한 문구만 반복하는 대신 실제로
// Developer 호출을 멈추고 기술적 BLOCKED로 전환해야 한다.
async function scenarioRunAutodevOnceEscalatesAfterNoWriteRepeatExceedsCap(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, {
    status: "READY",
    technicalRecoveryState: {
      taskId: "P1.2",
      sameFailureCount: 0,
      rootCauseAnalysisCount: 0,
      providerTimeoutCount: 0,
      noWriteRepeatCount: 5,
      unexpectedExitCount: 0,
      updatedAt: new Date().toISOString(),
    },
  });
  const manifest = buildPlannerManifest(repo, statePath); // completedTasks=["P1.1"] → 다음은 P1.2

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return { success: true, summary: "호출되면 안 됨 — no-write 상한 초과", changedFiles: [], tests: [], rawOutput: "" };
  };

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check("no-write 상한 초과: Developer가 호출되지 않음(claudeCalls=0)", claudeCalls === 0);
  check("no-write 상한 초과: outcome=BLOCKED_NO_WRITE_STRATEGY_EXHAUSTED", result.outcome === "BLOCKED_NO_WRITE_STRATEGY_EXHAUSTED");
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("no-write 상한 초과: 최종 status=BLOCKED(WAITING_HUMAN 아님 — Human Gate 활성화 안 함)", (finalState.status as unknown as string) === "BLOCKED");
  check(
    "no-write 상한 초과: NO_WRITE_STRATEGY_EXHAUSTED 마커가 기록됨(evidence 보존)",
    finalState.deferredHumanTasks.some((t) => t.startsWith("NO_WRITE_STRATEGY_EXHAUSTED:"))
  );
  check("no-write 상한 초과: task P1.2는 completedTasks에 없음(자동 승인 아님)", !finalState.completedTasks.includes("P1.2"));
}

// 대조군 — 상한 미만(4)이면 여전히 Developer가 정상 호출돼야 한다(과도하게 이르게 차단하지
// 않음 — buildNoWriteStrategyEscalationHint의 prompt hint 단계에는 여전히 기회를 준다).
async function scenarioRunAutodevOnceStillCallsDeveloperBelowNoWriteCap(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, {
    status: "READY",
    technicalRecoveryState: {
      taskId: "P1.2",
      sameFailureCount: 0,
      rootCauseAnalysisCount: 0,
      providerTimeoutCount: 0,
      noWriteRepeatCount: 4,
      unexpectedExitCount: 0,
      updatedAt: new Date().toISOString(),
    },
  });
  const manifest = buildPlannerManifest(repo, statePath);

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return { success: true, summary: "정상 호출", changedFiles: ["proj/marker.txt"], tests: [], rawOutput: "" };
  };

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check("no-write 상한 미만(4): Developer가 정상적으로 1회 호출됨(과도하게 이르게 차단하지 않음)", claudeCalls === 1);
  check("no-write 상한 미만(4): outcome이 BLOCKED_NO_WRITE_STRATEGY_EXHAUSTED가 아님", result.outcome !== "BLOCKED_NO_WRITE_STRATEGY_EXHAUSTED");
}

// 첫 번째 mid-flight 재발견(unexpectedExitCount 0 → 1)은 아직 임계치 미만이므로 정상적으로
// Developer를 재호출해 진행을 계속해야 한다 — 여기서 즉시 차단되면 §20의 "제한적 재시작
// 허용"이 깨진다.
async function scenarioRunAutodevOnceProcessRestartCircuitBreakerAllowsFirstRepeat(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { status: "WAITING_GPT_REVIEW" });
  const manifest = buildPlannerManifest(repo, statePath);

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    writeRepoFile(repo, "proj/marker-restart-recovery.txt", "marker\n");
    return {
      success: true,
      summary: "테스트: 1회차 mid-flight 재발견 이후 정상 진행",
      changedFiles: ["proj/marker-restart-recovery.txt"],
      tests: [{ name: "proj:check", pass: true }],
      rawOutput: "",
    };
  };

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check("PROCESS_RESTART_CIRCUIT_BREAKER: 1회차는 제한적으로 재시작을 허용함", claudeCalls === 1);
  check("PROCESS_RESTART_CIRCUIT_BREAKER: 1회차는 정상적으로 checkpoint까지 도달", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
}

// 실제 비용이 얽힌 WAITING_HUMAN(BUDGET_EXCEEDED)은 canonical policy로도 절대 자동 복구되지
// 않아야 한다 — humanFinalReview gate와 무관한 별도 보호 경로를 직접 증명한다.
async function scenarioRunAutodevOnceDoesNotReconcileGenuineBudgetExceededWaitingHuman(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, {
    status: "WAITING_HUMAN",
    deferredHumanTasks: ["BUDGET_EXCEEDED: 테스트 — 예산 상한 초과"],
  });
  const manifest = buildPlannerManifest(repo, statePath);

  const result = await runAutodevOnce({ manifest });

  check("BUDGET_EXCEEDED 보호: 기술적 자동 복구 대상이 아니므로 STOPPED 유지", result.outcome === "STOPPED");
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("BUDGET_EXCEEDED 보호: status가 여전히 WAITING_HUMAN", (finalState.status as unknown as string) === "WAITING_HUMAN");
  check(
    "BUDGET_EXCEEDED 보호: deferredHumanTasks 마커가 그대로 보존됨(자동 삭제되지 않음)",
    finalState.deferredHumanTasks.some((t) => t.includes("BUDGET_EXCEEDED"))
  );
}

// Secret/Dependency Scanner Gate로 인한 CHECKPOINT_BLOCKED(scope violation과 다른 사유)는
// 절대 자동 복구되지 않아야 한다 — 마커 텍스트가 CHECKPOINT_SCOPE_VIOLATION_REASON과 다르면
// fail-closed로 GENUINE_HUMAN_JUDGMENT로 남는다는 것을 직접 증명한다.
async function scenarioRunAutodevOnceDoesNotReconcileSecurityCheckpointBlockedWaitingHuman(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, {
    status: "WAITING_HUMAN",
    lastGptDecision: { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "테스트", nextTask: null },
    deferredHumanTasks: [
      "CHECKPOINT_BLOCKED(P1.2): commit 대상 파일에서 secret으로 의심되는 패턴이 발견되어 commit을 중단했습니다.",
    ],
  });
  const manifest = buildPlannerManifest(repo, statePath);

  const result = await runAutodevOnce({ manifest });

  check("Secret Scanner 보호: scope violation과 다른 사유의 CHECKPOINT_BLOCKED는 자동 복구되지 않음", result.outcome === "STOPPED");
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("Secret Scanner 보호: status가 여전히 WAITING_HUMAN", (finalState.status as unknown as string) === "WAITING_HUMAN");
}

// Secret Scanner 사전검사(2026-08-29, Task 4.2 SECURITY_BLOCKED 재발 방지) — Developer가
// 만든 변경에 완성형 secret-shape 리터럴이 있으면, 최종 checkpoint의 authoritative Secret
// Scanner Gate에 처음 걸리기 전에 defaultClaudeRunner(autodev.ts)가 같은 scanChangesForSecrets()
// 로 먼저 검사해 Developer에게 file/line/kind만(원문 값 제외) 안내하고 한 번 더 기회를 준다.
// AUTOMATION_DRY_RUN을 이 시나리오 안에서만 명시적으로 "false"로 두어 실제 이 경로가
// 실행되게 한다(다른 시나리오는 이 값을 건드리지 않으므로 서로 영향이 없다 — 이 파일은
// 시나리오를 순차 실행하는 단일 프로세스이므로 finally로 반드시 원복한다).
//
// checkpoint.ts의 requiredTestsAllPassed는 Claude/GPT 자체 보고를 신뢰하지 않고 항상 실제
// requiredTests 실행 결과(claude-developer.ts runRequiredTests)만 본다 — taskDef.requiredTests
// 가 비어 있으면 그 결과도 항상 빈 배열이라 checkpoint가 "필수 테스트 미통과"로 막힌다(§
// autodev.ts requiredTestsAllPassed = tests.length > 0 && ...). 이 두 시나리오는 secret
// 사전검사만 독립적으로 검증해야 하므로, 항상 exit 0인 최소 check.js를 실제 requiredTests로
// 등록해 이 무관한 gate를 우회한다(scope는 buildPlannerManifest와 동일하게 proj/만 허용).
const SECRET_PRECHECK_REGISTRY: TaskDefinition[] = [
  {
    id: "SP1",
    phase: 1,
    taskNumber: 1,
    title: "Secret Precheck Fixture Task",
    prompt: "Secret precheck fixture task prompt",
    requiredTests: [{ name: "check-always-pass", command: "node", args: ["check.js"], cwd: "root" }],
    allowedPathPrefixes: ["proj/"],
    prohibitedOperations: [],
  },
];

function buildSecretPrecheckManifest(root: string, statePath: string): ProjectManifest {
  return {
    projectId: "secret-precheck-fixture-project",
    projectName: "Secret Precheck Fixture Project",
    targetProjectRoot: root,
    statePath,
    taskRegistry: SECRET_PRECHECK_REGISTRY,
    developerInstructions: "허용 범위: proj/**.",
    reviewInstructions: "proj/** 범위 밖 변경이 있으면 반드시 REVISE하세요.",
    reviewScopeDirs: ["proj/"],
    executionPolicy: {
      allowedReadPrefixes: ["proj/"],
      allowedWritePrefixes: ["proj/"],
      allowedCommands: [{ cwd: "root", command: "node", args: ["check.js"] }],
    },
  };
}

function writeAlwaysPassCheckScript(repo: string): void {
  // proj/** 밖의 인프라 파일이라 checkpoint의 "허용 경로 밖 예상치 못한 변경" 방어에 걸리지
  // 않도록 초기 커밋에 포함시킨다(§ writeCheckScript와 동일한 관례) — marker.txt(secret
  // 유무 검사 대상)만 이 Task의 실제 산출물이다. 내용과 무관하게 항상 exit 0이라 secret
  // 사전검사/최종 Secret Scanner 판정과 완전히 독립적이다.
  writeFileSync(join(repo, "check.js"), "process.exit(0);\n", "utf-8");
  spawnSync("git", ["add", "--", "check.js"], { cwd: repo });
  spawnSync("git", ["commit", "-q", "-m", "add check.js"], { cwd: repo });
}

async function scenarioSecretPrecheckAutoFixesFindingWithoutHumanGate(): Promise<void> {
  const repo = makeTempGitRepo();
  writeAlwaysPassCheckScript(repo);
  const statePath = makeTempStateFile(repo, { completedTasks: [] }); // 다음 task = SP1
  const manifest = buildSecretPrecheckManifest(repo, statePath);

  const RAW_SECRET = "sk-abcdefghijklmnopqrstuvwx";
  let call = 0;
  const receivedInputs: string[] = [];
  const developerClaudeCaller = async (input: string): Promise<RealClaudeResult> => {
    call += 1;
    receivedInputs.push(input);
    if (call === 1) {
      const content = `const key = '${RAW_SECRET}';\n`;
      const protocolJson = JSON.stringify({ type: "ACTION_REQUEST", actions: [{ type: "WRITE_FILE", path: "proj/marker.txt", content }] });
      return { success: true, summary: protocolJson, changedFiles: [], tests: [], rawOutput: protocolJson };
    }
    if (call === 2) {
      const protocolJson = JSON.stringify({
        type: "TASK_COMPLETE",
        summary: "1차 시도: marker.txt에 fake key 상수를 그대로 넣어 완료",
        changedFiles: ["proj/marker.txt"],
        testsRequested: [],
      });
      // requiredTests=[]인 fixture 관례상, 실제 command가 없어도 checkpoint의
      // requiredTestsAllPassed(autodev.ts) 판정이 "tests.length > 0 && 전부 pass"를 요구한다
      // (§ scenarioRunAutodevOnceHappyPath와 동일한 관례) — 이 시나리오의 목적은 required test
      // 판정이 아니라 secret 사전검사이므로 더미 PASS 항목으로 그 판정을 항상 통과시킨다.
      return { success: true, summary: protocolJson, changedFiles: ["proj/marker.txt"], tests: [{ name: "proj:check", pass: true }], rawOutput: protocolJson };
    }
    if (call === 3) {
      const content = "const key = safeConcat();\n"; // 사전검사 안내를 반영해 완성형 리터럴 제거
      const protocolJson = JSON.stringify({ type: "ACTION_REQUEST", actions: [{ type: "WRITE_FILE", path: "proj/marker.txt", content }] });
      return { success: true, summary: protocolJson, changedFiles: [], tests: [], rawOutput: protocolJson };
    }
    const protocolJson = JSON.stringify({
      type: "TASK_COMPLETE",
      summary: "2차 시도: 사전검사 안내에 따라 secret-shape 리터럴 제거",
      changedFiles: ["proj/marker.txt"],
      testsRequested: [],
    });
    return { success: true, summary: protocolJson, changedFiles: ["proj/marker.txt"], tests: [{ name: "proj:check", pass: true }], rawOutput: protocolJson };
  };

  const originalDryRun = process.env.AUTOMATION_DRY_RUN;
  process.env.AUTOMATION_DRY_RUN = "false";
  try {
    const result = await runAutodevOnce({
      manifest,
      developerClaudeCaller,
      orchestratorDeps: { gptReviewer: fakePassReviewer() },
    });

    check("Secret 사전검사: Developer가 정확히 2회(원본 시도 + 사전검사 재시도 1회) 호출됨", call === 4);
    check(
      "Secret 사전검사: 재시도 라운드 프롬프트에 file/line/kind 안내가 실제로 포함됨",
      !!receivedInputs[2]?.includes("proj/marker.txt") && !!receivedInputs[2]?.includes("generic-api-key")
    );
    check(
      "Secret 사전검사: 재시도 프롬프트에 탐지된 secret의 실제 원문 값은 노출되지 않음",
      !receivedInputs[2]?.includes(RAW_SECRET)
    );
    check(
      "Secret 사전검사: 사람 승인 없이 정상적으로 checkpoint까지 도달(WAITING_HUMAN으로 멈추지 않음)",
      result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED"
    );
    const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
    check("Secret 사전검사: 최종 status가 WAITING_HUMAN이 아님", (finalState.status as unknown as string) !== "WAITING_HUMAN");
    const committedContent = readFileSync(join(repo, "proj", "marker.txt"), "utf-8");
    check("Secret 사전검사: 최종 commit된 파일 내용에 secret-shape 리터럴이 남지 않음", !committedContent.includes(RAW_SECRET));
  } finally {
    if (originalDryRun === undefined) delete process.env.AUTOMATION_DRY_RUN;
    else process.env.AUTOMATION_DRY_RUN = originalDryRun;
  }
}

// Secret 사전검사가 Developer를 한 번 되돌려도 같은 secret-shape finding이 그대로 남으면
// (§ 요구사항 "같은 finding 반복 시 Developer/외부 AI 호출 반복 금지") 더 이상 Developer를
// 부르지 않고 기존 흐름(GPT Review → checkpoint)으로 그대로 넘긴다는 것, 그리고 이 사전검사가
// 최종 authoritative Secret Scanner Gate(checkpoint.ts)의 SECURITY_BLOCKED 판정을 절대
// 대신하거나 완화하지 않는다는 것을 함께 증명한다.
async function scenarioSecretPrecheckDoesNotRepeatDeveloperCallWhenFindingPersists(): Promise<void> {
  const repo = makeTempGitRepo();
  writeAlwaysPassCheckScript(repo);
  const statePath = makeTempStateFile(repo, { completedTasks: [] });
  const manifest = buildSecretPrecheckManifest(repo, statePath);
  const events = createInMemoryEventStore();

  const RAW_SECRET = "sk-abcdefghijklmnopqrstuvwx";
  let call = 0;
  const developerClaudeCaller = async (): Promise<RealClaudeResult> => {
    call += 1;
    // 매 시도(WRITE_FILE 라운드)마다 항상 같은 secret-shape 리터럴을 그대로 남긴다 —
    // 사전검사가 한 번 재시도를 줘도 문제를 고치지 못하는 Developer를 시뮬레이션한다.
    if (call % 2 === 1) {
      const content = `const key = '${RAW_SECRET}';\n`;
      const protocolJson = JSON.stringify({ type: "ACTION_REQUEST", actions: [{ type: "WRITE_FILE", path: "proj/marker.txt", content }] });
      return { success: true, summary: protocolJson, changedFiles: [], tests: [], rawOutput: protocolJson };
    }
    const protocolJson = JSON.stringify({
      type: "TASK_COMPLETE",
      summary: `시도 ${Math.ceil(call / 2)}: marker.txt 완료(여전히 secret-shape 값 포함)`,
      changedFiles: ["proj/marker.txt"],
      testsRequested: [],
    });
    // requiredTestsAllPassed(autodev.ts)가 이 checkpoint 시도를 required test 미달이 아니라
    // 오직 secret 사전검사/최종 Secret Scanner 사유로만 막게 하기 위한 더미 PASS(§ 위와 동일).
    return { success: true, summary: protocolJson, changedFiles: ["proj/marker.txt"], tests: [{ name: "proj:check", pass: true }], rawOutput: protocolJson };
  };

  const originalDryRun = process.env.AUTOMATION_DRY_RUN;
  process.env.AUTOMATION_DRY_RUN = "false";
  try {
    const result = await runAutodevOnce({
      manifest,
      events,
      developerClaudeCaller,
      orchestratorDeps: { gptReviewer: fakePassReviewer() },
    });

    check(
      "Secret 사전검사(미해결): Developer가 정확히 2회만 호출됨(원본 + 재시도 1회, 그 이상 반복 호출 없음)",
      call === 4
    );
    check(
      "Secret 사전검사(미해결): 최종 checkpoint가 실제 Secret Scanner Gate에 의해 BLOCK됨(authoritative gate 그대로 유지)",
      result.outcome === "RAN_TASK_CHECKPOINT_BLOCKED"
    );
    const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
    check("Secret 사전검사(미해결): 최종 status가 WAITING_HUMAN", (finalState.status as unknown as string) === "WAITING_HUMAN");
    check(
      "Secret 사전검사(미해결): deferredHumanTasks에 실제 CHECKPOINT_BLOCKED 마커가 기록됨(사전검사가 이 판정을 대신하지 않음)",
      finalState.deferredHumanTasks.some((t) => t.startsWith("CHECKPOINT_BLOCKED(SP1)"))
    );
    // § BLOCKER 2 재하드닝(독립 최종 감사) Technical/Human Gate Matrix — Secret Scanner에
    // 의한 CHECKPOINT_BLOCKED는 진짜 genuine이다(scope violation과 다른 사유). event의
    // humanInterventionRequired는 계속 true여야 한다 — CHECKPOINT_BLOCKED(scope-violation)만
    // 기술적으로 재분류한 § BLOCKER 2 수정이 이 case까지 조용히 덮지 않는지 직접 확인한다.
    const all = events.query().events;
    const securityBlockedEvents = all.filter((e) => e.eventType === "SECURITY_BLOCKED");
    check("Secret 사전검사(미해결): SECURITY_BLOCKED event가 정확히 1건 기록됨", securityBlockedEvents.length === 1);
    check(
      "Secret 사전검사(미해결): SECURITY_BLOCKED event의 humanInterventionRequired=true(진짜 genuine, 변경 없음)",
      securityBlockedEvents.every((e) => e.humanInterventionRequired === true)
    );
  } finally {
    if (originalDryRun === undefined) delete process.env.AUTOMATION_DRY_RUN;
    else process.env.AUTOMATION_DRY_RUN = originalDryRun;
  }
}

// AutoDev / JARVIS 신뢰성 보완(2026-08-27), AutoDev Efficiency / Review Stagnation
// Hardening(2026-08-28), AutoDev Core Maintenance(2026-08-30)로 갱신.
//
// 이 시나리오의 claudeRunner는 매 attempt마다 완전히 동일한 required test 실패를
// 반환한다 — 2026-08-30 변경 전에는(REVIEW_CYCLE_EXHAUSTED 자신이 canonical Human Gate
// Policy상 언제나 기술적 자동 복구 대상) 이 반복이 무제한 durable backoff-and-retry로
// 흡수되어 결국 무관한 비용 안전장치 MAX_GPT_CALLS(10)에서야 genuine WAITING_HUMAN에
// 도달했다. 이제는 orchestrator.ts가 stagnationTracker의 repeatCount로 "다양한 이유로
// 계속 REVISE"와 "동일한 이유로 계속 REVISE"를 구분한다(§ DETERMINISTIC_REVIEW_CYCLE_
// EXHAUSTED_MARKER_PREFIX) — 이 fixture는 정확히 후자이므로, 첫 MAX_REVIEW_CYCLES(5)
// 소진 시점에 이미 genuine WAITING_HUMAN으로 승격된다(더 이상 10회까지 무제한 반복하지
// 않는다 — 이것이 바로 이번 변경의 목적: 동일 실패를 무한정 재시도하지 않는다). 그
// genuine WAITING_HUMAN도 human-gate-policy.ts가 GENUINE_HUMAN_JUDGMENT로 분류하므로,
// generic HUMAN_APPROVAL_REQUIRED("orchestrator status=...") bookend는 여전히 정상적으로
// 기록돼야 한다(REVIEW_CYCLE_EXHAUSTED event 자신에 이제 humanInterventionRequired=true가
// 실려온다 — 더 이상 항상 false가 아니다). RUN_BLOCKED와 orchestrator.ts 자신의
// REVIEW_CYCLE_EXHAUSTED event는 여전히 그대로 기록된다(감사 기록/집계는 유지).
async function scenarioRunAutodevOnceDeterministicReviewCycleExhaustionEscalatesEarly(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo);
  const manifest = buildPlannerManifest(repo, statePath); // P1.2
  const events = createInMemoryEventStore();

  let claudeCallCount = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCallCount += 1;
    return {
      success: true,
      summary: "테스트: required test 항상 동일하게 실패",
      changedFiles: [],
      tests: [{ name: "proj:check", pass: false }],
      rawOutput: "",
    };
  };

  const result = await runAutodevOnce({
    manifest,
    events,
    orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer(), sleep: async () => {}, now: () => Date.now() },
  });

  // P0-4/P1-2 하드닝(2026-08-30, 독립 감사) — 동일 required test 실패 반복이 확정돼도 더
  // 이상 genuine WAITING_HUMAN으로 조기 승격하지 않는다(§ orchestrator.ts
  // blockOnDurableWaitRetryExhausted) — 대신 durable wait이 MAX_DURABLE_PROVIDER_WAIT_
  // RETRY_COUNT(5)회까지 기술적으로 반복된 뒤 terminal 기술적 BLOCKED로 수렴한다(genuine
  // Human Gate 0을 유지하면서도 무한 반복은 아니다).
  check("결정론적 반복 조기 승격: outcome=RAN_TASK_NOT_APPROVED", result.outcome === "RAN_TASK_NOT_APPROVED");
  check(
    "결정론적 반복 조기 승격: developer 호출이 bounded됨(exhaustion마다 MAX_REVIEW_CYCLES=5 round × (MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT+1)회=30, 무제한 아님)",
    claudeCallCount === 30
  );
  const all = events.query().events;
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("결정론적 반복 조기 승격: 최종 status=BLOCKED(WAITING_HUMAN 아님 — genuine Human Gate 0)", (finalState.status as unknown as string) === "BLOCKED");
  const exhaustedEvents = all.filter((e) => e.eventType === "REVIEW_CYCLE_EXHAUSTED");
  check(
    "결정론적 반복 조기 승격: REVIEW_CYCLE_EXHAUSTED event 자체는 항상 humanInterventionRequired=false(genuine 아님, 기술적 durable wait)",
    exhaustedEvents.length > 0 && exhaustedEvents.every((e) => e.humanInterventionRequired === false)
  );
  check(
    "결정론적 반복 조기 승격: generic 'orchestrator status=' HUMAN_APPROVAL_REQUIRED event는 생성되지 않음(기술적 자동 복구 대상이므로)",
    !all.some((e) => e.eventType === "HUMAN_APPROVAL_REQUIRED" && (e.reason ?? "").startsWith("orchestrator status="))
  );
  check("결정론적 반복 조기 승격: RUN_BLOCKED event는 그대로 기록됨(대시보드 실패 집계 유지)", all.some((e) => e.eventType === "RUN_BLOCKED"));
  check("결정론적 반복 조기 승격: orchestrator의 REVIEW_CYCLE_EXHAUSTED event는 그대로 기록됨(감사 기록 유지)", all.some((e) => e.eventType === "REVIEW_CYCLE_EXHAUSTED"));
}

async function scenarioRunAutodevOnceAutoRepairsRequiredTestScriptAndContinues(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "fixture", scripts: {} }, null, 2) + "\n", "utf-8");
  // 이 task의 allowedPathPrefixes(proj/) 안에 정확히 하나의 *.test.mjs 후보를 미리 심어둔다
  // — Developer가 실행되기도 전에 이미 디스크에 있는 이전 시도의 산출물을 흉내낸다.
  writeRepoFile(repo, "proj/rtp-check.test.mjs", "// fixture\n");
  const manifest = buildRequiredTestPreflightManifest(repo, statePath);

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    writeRepoFile(repo, "proj/fake-task-p1-2-marker.txt", "marker\n");
    return {
      success: true,
      summary: "테스트: 자동 복구 이후 정상 진행",
      changedFiles: ["proj/fake-task-p1-2-marker.txt"],
      tests: [{ name: "rtp-check", pass: true }],
      rawOutput: "",
    };
  };

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check(
    "required-test preflight: 후보가 정확히 1개면 자동 복구 후 정상 진행(checkpoint까지 도달)",
    result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED"
  );
  check("required-test preflight: 자동 복구 이후 Claude Developer가 정상적으로 1회 호출됨", claudeCalls === 1);

  const pkgAfter = JSON.parse(readFileSync(join(repo, "package.json"), "utf-8"));
  check(
    "required-test preflight: package.json에 스크립트가 실제로 등록됨(node <실제 발견된 파일>)",
    pkgAfter.scripts["test:rtp-check"] === "node proj/rtp-check.test.mjs"
  );
}

// ---------------------------------------------------------------------------
// H) AutoDev 지능형 오류 복구 하드닝 — Problem-Solving Knowledge Store가 실제
//    runAutodevOnce() 파이프라인에 배선되어 cross-task 재사용이 동작하는지 검증한다.
//    problem-memory.ts 자체의 세부 판정 로직 회귀는 problem-memory-tests.ts가 전담한다 —
//    여기서는 "실제 developer 호출 흐름에 배선되어 있는지"만 확인한다.
// ---------------------------------------------------------------------------
function makeInMemoryProblemMemoryStore(): ProblemMemoryStore {
  let entries: ProblemMemoryEntry[] = [];
  return {
    load: () => entries,
    save: (next) => {
      entries = next;
    },
  };
}

const MEMORY_REUSE_REGISTRY: TaskDefinition[] = [
  {
    id: "M1",
    phase: 1,
    taskNumber: 1,
    title: "M1",
    prompt: "M1 prompt",
    requiredTests: [{ name: "check-fixed", command: "node", args: ["check.js"], cwd: "root" }],
    allowedPathPrefixes: ["proj/"],
    prohibitedOperations: [],
  },
  {
    id: "M2",
    phase: 1,
    taskNumber: 2,
    title: "M2",
    prompt: "M2 prompt",
    requiredTests: [{ name: "check-fixed", command: "node", args: ["check.js"], cwd: "root" }],
    allowedPathPrefixes: ["proj/"],
    prohibitedOperations: [],
  },
];

function buildMemoryReuseManifest(root: string, statePath: string): ProjectManifest {
  return {
    projectId: "memory-reuse-fixture-project",
    projectName: "Memory Reuse Fixture Project",
    targetProjectRoot: root,
    statePath,
    taskRegistry: MEMORY_REUSE_REGISTRY,
    developerInstructions: "허용 범위: proj/**.",
    reviewInstructions: "proj/** 범위 밖 변경이 있으면 반드시 REVISE하세요.",
    reviewScopeDirs: ["proj/"],
    executionPolicy: {
      allowedReadPrefixes: ["proj/"],
      allowedWritePrefixes: ["proj/"],
      allowedCommands: [{ cwd: "root", command: "node", args: ["check.js"] }],
    },
  };
}

function writeCheckScript(repo: string): void {
  // proj/** 밖의 파일이라 checkpoint의 "allowedPathPrefixes 밖 예상치 못한 변경" 방어에
  // 걸리지 않도록, 이미 존재하는 프로젝트 인프라 파일처럼 초기 커밋에 포함시킨다(이 Task
  // 자신이 만든 변경이 아니다 — marker.txt만 Task의 실제 산출물이다).
  // startsWith("FIXED")로 판정한다(정확히 "FIXED"가 아니어도 됨) — 여러 Task가 순차로 이
  // 같은 required test를 통과시켜야 하는데, 매번 정확히 같은 문자열을 쓰면 이전 Task의
  // commit과 diff가 전혀 없어 "commit할 변경 파일이 없습니다"로 checkpoint가 막힌다(git이
  // 실제로 아무것도 안 바뀐 것으로 판단하는 것 자체는 정상 동작이다 — 이 fixture가 각 Task마다
  // 구분되는 값을 쓰도록 설계해야 한다).
  writeFileSync(
    join(repo, "check.js"),
    "const fs=require('fs');\ntry{const c=fs.readFileSync('proj/marker.txt','utf8').trim();process.exit(c.indexOf('FIXED')===0?0:1);}catch(e){process.exit(1);}\n",
    "utf-8"
  );
  spawnSync("git", ["add", "--", "check.js"], { cwd: repo });
  spawnSync("git", ["commit", "-q", "-m", "add check.js"], { cwd: repo });
}

interface ScriptedDeveloperCaller {
  call: (input: string, timeoutMs: number) => Promise<{ success: boolean; summary: string; changedFiles: string[]; tests: never[]; rawOutput: string }>;
  receivedInputs: string[];
}

/** WRITE_FILE(BROKEN) → TASK_COMPLETE → [REVISE] → WRITE_FILE(FIXED) → TASK_COMPLETE
 *  순서를 스크립트한다 — 첫 attempt는 항상 문제를 해결하지 못하고, 두 번째 attempt에서만
 *  고친다(memory hint가 두 번째 attempt의 transcript에 실제로 실리는지 검증하기 위함). */
function makeTwoAttemptFixCaller(fixedValue: string = "FIXED"): ScriptedDeveloperCaller {
  let call = 0;
  const receivedInputs: string[] = [];
  return {
    receivedInputs,
    call: async (input: string) => {
      call += 1;
      receivedInputs.push(input);
      if (call === 1 || call === 3) {
        const content = call === 1 ? "BROKEN\n" : `${fixedValue}\n`;
        const protocolJson = JSON.stringify({ type: "ACTION_REQUEST", actions: [{ type: "WRITE_FILE", path: "proj/marker.txt", content }] });
        return { success: true, summary: protocolJson, changedFiles: [], tests: [], rawOutput: protocolJson };
      }
      const summary = call === 2 ? "1차 시도: marker.txt를 BROKEN으로 둔 채 완료(문제 미해결)" : "2차 시도: marker.txt 값을 FIXED로 바꿔 문제를 해결함";
      const protocolJson = JSON.stringify({ type: "TASK_COMPLETE", summary, changedFiles: ["proj/marker.txt"], testsRequested: [] });
      return { success: true, summary: protocolJson, changedFiles: ["proj/marker.txt"], tests: [], rawOutput: protocolJson };
    },
  };
}

async function scenarioCrossTaskMemoryReuseEndToEnd(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: [] }); // 다음 task = M1
  writeCheckScript(repo);
  const manifest = buildMemoryReuseManifest(repo, statePath);
  const problemMemoryStores = { project: makeInMemoryProblemMemoryStore(), common: makeInMemoryProblemMemoryStore() };

  const m1Caller = makeTwoAttemptFixCaller();
  const m1Result = await runAutodevOnce({
    manifest,
    problemMemoryStores,
    developerClaudeCaller: m1Caller.call,
    orchestratorDeps: { gptReviewer: fakePassReviewer() },
  });

  check("H) M1: 두 번째 attempt(과거 기록 없음)에서 정상적으로 checkpoint까지 도달", m1Result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("H) M1: memory에 확정된(pendingConfirmation=false) 해결책이 기록됨", problemMemoryStores.project.load().some((e) => e.taskId === "M1" && e.finalSuccessfulSolution && !e.pendingConfirmation));

  const m2Caller = makeTwoAttemptFixCaller("FIXED-M2");
  const m2Result = await runAutodevOnce({
    manifest,
    problemMemoryStores,
    developerClaudeCaller: m2Caller.call,
    orchestratorDeps: { gptReviewer: fakePassReviewer() },
  });

  check("H) M2: 같은 프로젝트의 다른 Task도 정상적으로 checkpoint까지 도달", m2Result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check(
    "H) M2: 두 번째 attempt의 초기 transcript에 M1의 과거 해결 사례 안내가 실제로 주입됨",
    m2Caller.receivedInputs[2]?.includes("과거 해결 사례") && m2Caller.receivedInputs[2]?.includes("marker.txt 값을 FIXED로 바꿔 문제를 해결함")
  );
  check(
    "H) M2: 재사용된 M1 항목의 reuseSuccessCount가 1 증가함",
    problemMemoryStores.project.load().find((e) => e.taskId === "M1")?.reuseSuccessCount === 1
  );
}

async function scenarioSameTaskDoesNotRepeatFailedStrategy(): Promise<void> {
  // 같은 Task 안에서 반복 실패하면 이미 실패한 설명이 escalation guidance로 그대로
  // 전달되는지 확인한다(§ 요구사항 6/10 — 같은 전략을 맹목적으로 반복하지 않게 안내).
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: [] });
  writeCheckScript(repo);
  const manifest = buildMemoryReuseManifest(repo, statePath);
  const problemMemoryStores = { project: makeInMemoryProblemMemoryStore(), common: makeInMemoryProblemMemoryStore() };

  let call = 0;
  const receivedInputs: string[] = [];
  const caller = async (input: string) => {
    call += 1;
    receivedInputs.push(input);
    // 매 attempt마다 여전히 BROKEN으로 둔 채 다른 설명으로 완료 보고 — 3번째 attempt까지
    // 계속 실패해야 3회차 escalation("금지") 안내를 관찰할 수 있다.
    const summary = `시도 ${call}: 여전히 해결하지 못함`;
    const protocolJson = JSON.stringify({ type: "TASK_COMPLETE", summary, changedFiles: [], testsRequested: [] });
    return { success: true, summary: protocolJson, changedFiles: [], tests: [], rawOutput: protocolJson };
  };

  // AutoDev Efficiency / Review Stagnation Hardening(2026-08-28) — 이 caller는 절대
  // 문제를 해결하지 않으므로(§ 이 시나리오의 목적: 반복 실패 escalation 안내 검증) required
  // test가 계속 실패해 REVIEW_CYCLE_EXHAUSTED durable retry를 실제로 거친다 — sleep을 fake로
  // 주입해 실제 대기 없이 결국 기존 MAX_GPT_CALLS 안전장치까지 빠르게 도달하게 한다(이 검증
  // 자체는 3번째 attempt 시점의 transcript만 보므로 그 이후 얼마나 더 재시도되는지는
  // 무관하다).
  await runAutodevOnce({
    manifest,
    problemMemoryStores,
    developerClaudeCaller: caller,
    orchestratorDeps: { gptReviewer: fakePassReviewer(), sleep: async () => {}, now: () => Date.now() },
  });

  check("I) 3번째 attempt 이후 transcript에 반복 전략 금지 안내가 실제로 주입됨", receivedInputs.some((inp) => inp.includes("전략 재사용 금지")));
}

/** 매번 완전히 동일한(claude-developer.ts 프로토콜에 없는) 응답 shape만 반환한다 — 실제
 *  production 장애(§ autodev.ts hadPriorProtocolFailureForThisTask 상단 주석)를 재현하기
 *  위해 claude-developer-tests.ts scenario Y와 동일한 패턴을 이 autodev.ts 통합 레벨에서
 *  다시 스크립트한다. */
function makeAlwaysUnrecognizedProtocolCaller(): ScriptedDeveloperCaller {
  const receivedInputs: string[] = [];
  return {
    receivedInputs,
    call: async (input: string) => {
      receivedInputs.push(input);
      const badJson = JSON.stringify({ type: "SOMETHING_ELSE", foo: "bar" });
      return { success: true, summary: badJson, changedFiles: [], tests: [], rawOutput: badJson };
    },
  };
}

async function scenarioProtocolErrorRecordedAndSpeedsUpNextAttempt(): Promise<void> {
  // AutoDev 신뢰성 보완(2026-08-27, "응답 형식 오류도 기존 문제 해결 흐름에 포함") —
  // PROTOCOL_ERROR(§ claude-developer.ts PROTOCOL_FAILURE_HARD_STOP)로 developer가
  // 구조적으로 실패해도 problem-memory에는 여전히 FAILURE로 기록되고, 이 task가 다시 시도될
  // 때 최초 라운드부터(2회차 실패를 기다리지 않고) 응답 형식 안내가 미리 주입되는지
  // 검증한다(§ 요구사항 "동일 문제 재발 시 더 빠른 해결").
  //
  // § P0-3 재하드닝(독립 감사, 2026-08-30) — 이전에는 PROTOCOL_ERROR가 GPT 리뷰 없이 즉시
  // genuine WAITING_HUMAN으로 넘어갔다. 독립 감사에서 "protocol parse failure는 genuine Human
  // Gate가 아니다"로 확정되어, 지금은 DEVELOPER_TRANSIENT_RETRY_EXHAUSTED_PREFIX와 동일한
  // durable wait-then-retry(§ orchestrator.ts developerProviderWaitCount, 상한
  // MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT)를 거친 뒤 terminal 기술적 BLOCKED로 끝난다 — 이
  // caller는 절대 회복되지 않으므로(항상 같은 미해석 응답) 실제로 상한까지 전부 소진한다.
  // sleep/now를 fake로 주입해 실제 대기 없이 빠르게 끝낸다(그렇지 않으면 실제 backoff
  // schedule(최대 3600000ms)만큼 몇 시간을 기다리게 된다).
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: [] }); // 다음 task = M1
  writeCheckScript(repo);
  const manifest = buildMemoryReuseManifest(repo, statePath);
  const problemMemoryStores = { project: makeInMemoryProblemMemoryStore(), common: makeInMemoryProblemMemoryStore() };

  const firstCaller = makeAlwaysUnrecognizedProtocolCaller();
  const firstResult = await runAutodevOnce({
    manifest,
    problemMemoryStores,
    developerClaudeCaller: firstCaller.call,
    orchestratorDeps: { gptReviewer: fakePassReviewer(), sleep: async () => {}, now: () => Date.now() },
  });

  check("J) 1차 시도: PROTOCOL_ERROR가 durable 상한을 소진해 checkpoint 없이 종료(RAN_TASK_NOT_APPROVED)", firstResult.outcome === "RAN_TASK_NOT_APPROVED");
  check(
    `J) 1차 시도: durable wait 상한(MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT+1=${MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT + 1}회) × 내부 3라운드 하드 상한 = 정확히 ${(MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT + 1) * 3}회 내부 호출 후 중단(무한 반복 아님)`,
    firstCaller.receivedInputs.length === (MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT + 1) * 3
  );
  const stateAfterFirst = loadState(statePath);
  check("J) 1차 시도: 최종 status=BLOCKED(genuine WAITING_HUMAN 아님)", (stateAfterFirst.status as unknown as string) === "BLOCKED");

  const recordedEntry = problemMemoryStores.project.load().find((e) => e.taskId === "M1" && e.errorCode === "PROTOCOL_ERROR");
  check("J) PROTOCOL_ERROR가 problem-memory에 FAILURE로 기록됨", !!recordedEntry);
  check("J) 기록된 attemptedSolutions에 FAILURE 결과가 포함됨", !!recordedEntry?.attemptedSolutions.some((s) => s.outcome === "FAILURE"));

  // decideNextAction()은 WAITING_HUMAN을 절대 자동으로 재시도하지 않는다(§ 요구사항 —
  // 모호하면 승인으로 간주하지 않음). 실제 재시도는 사람이 승인한 뒤 auto-resume.ts가
  // state.status를 안전하게 재확인하고 "READY"로 되돌린 뒤에만 일어난다(§ auto-resume.ts
  // 상단 주석) — 그 지점만 흉내낸다(그 파일의 git/lock/remote 재확인 로직 자체를 다시
  // 구현하지 않는다, 이 테스트가 검증하려는 것은 problem-memory 연결이지 auto-resume 자체가
  // 아니다).
  const resumedState = loadState(statePath);
  resumedState.status = "READY";
  saveState(resumedState, statePath);

  const secondCaller = makeAlwaysUnrecognizedProtocolCaller();
  await runAutodevOnce({
    manifest,
    problemMemoryStores,
    developerClaudeCaller: secondCaller.call,
    orchestratorDeps: { gptReviewer: fakePassReviewer(), sleep: async () => {}, now: () => Date.now() },
  });

  check(
    "J) 2차 시도: 최초 라운드 입력에 과거 응답 형식 문제 이력 안내가 이미 포함됨(2회차 실패를 기다리지 않음)",
    secondCaller.receivedInputs[0]?.includes("과거 응답 형식 문제 이력") ?? false
  );
}

// AutoDev Core Maintenance — Canonical Stop Path(2026-08-31, JARVIS Task 5.3 실측 —
// "실행 중인 Developer/continuous run을 canonical하게 정상 중단할 수 없는 결함"). K~M
// 시나리오는 opts.abortSignal이 runAutodevOnce() 전체 파이프라인(lock acquire 전 조기
// 반환/orchestrator.ts durable-wait/checkpoint·Reviewer 생략)에 실제로 어떻게 반영되는지
// end-to-end로 검증한다. subprocess-runner.ts 레벨의 실제 claude.exe 종료는 runner-tests.ts가
// 이미 실측 검증했고, run.ts의 마커 polling 자체는 run-tests.ts가 검증한다 — 이 파일은 그
// abortSignal이 orchestrator.ts/autodev.ts의 실제 상태 전이(project-state.json/project
// lock/checkpoint/Reviewer 호출 여부)에 정확히 반영되는지만 담당한다.

async function scenarioAbortBeforeStartSkipsEverything(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: [] });
  const manifest = buildPlannerManifest(repo, statePath);

  const controller = new AbortController();
  controller.abort(); // 시작 전에 이미 중단 요청됨.

  const stateBefore = readFileSync(statePath, "utf-8");
  let developerCalled = false;
  const result = await runAutodevOnce({
    manifest,
    developerClaudeCaller: async () => {
      developerCalled = true;
      throw new Error("호출되면 안 됨");
    },
    orchestratorDeps: { gptReviewer: fakePassReviewer() },
    abortSignal: controller.signal,
  });
  const stateAfter = readFileSync(statePath, "utf-8");

  check("K) 시작 전 abort: outcome=STOPPED", result.outcome === "STOPPED");
  check("K) 시작 전 abort: Developer가 전혀 호출되지 않음(lock acquire조차 시도 안 함)", developerCalled === false);
  check("K) 시작 전 abort: project-state.json이 완전히 그대로임(바이트 단위 동일)", stateBefore === stateAfter);
  check(
    "K) 시작 전 abort: lock을 acquire조차 하지 않았으므로 project lock이 없음",
    inspectProjectRuntimeLiveness(manifest.projectId, manifest.targetProjectRoot).present === false
  );
}

async function scenarioAbortDuringDurableWaitStopsQuicklyAndPreservesState(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: [] });
  const manifest = buildPlannerManifest(repo, statePath);

  // PROTOCOL_ERROR(항상 해석 불가한 응답)는 developer attempt 내부에서 3라운드 만에 하드
  // 중단되고 곧바로 orchestrator.ts의 durable-wait 분기로 들어간다(§
  // scenarioProtocolErrorRecordedAndSpeedsUpNextAttempt와 동일한 재현 방식) — 짧은 재시도
  // sleep(15s/30s) 없이 곧장 durable-wait의 real sleep을 경합시킬 수 있다.
  const caller = makeAlwaysUnrecognizedProtocolCaller();
  const controller = new AbortController();
  const abortAfterMs = 200;
  setTimeout(() => controller.abort(), abortAfterMs);

  const startedAt = Date.now();
  const result = await runAutodevOnce({
    manifest,
    developerClaudeCaller: caller.call,
    orchestratorDeps: {
      gptReviewer: fakePassReviewer(),
      // sleep은 override하지 않는다 — 실제 setTimeout 기반 대기와 abort를 진짜로 경합시킨다.
      developerProviderWaitScheduleMs: [10_000],
      developerProviderWaitCooldownMs: 10_000,
    },
    abortSignal: controller.signal,
  });
  const elapsedMs = Date.now() - startedAt;

  check("L) durable-wait 중 abort: outcome=STOPPED", result.outcome === "STOPPED");
  check(
    `L) durable-wait 중 abort: 실제 10초 durable-wait을 기다리지 않고 abort 시점(약 ${abortAfterMs}ms) 근처에서 종료됨`,
    elapsedMs < 5_000
  );

  const liveness = inspectProjectRuntimeLiveness(manifest.projectId, manifest.targetProjectRoot);
  check(
    "L) durable-wait 중 abort: project lock을 release하지 않음(작업 중 상태 보존 — 기존 lockShouldRelease=false 원칙과 동일)",
    liveness.present === true && liveness.pid === process.pid
  );

  const stateAfter = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check(
    "L) durable-wait 중 abort: project-state.json은 abort 직전 마지막으로 저장된 상태 그대로(WAITING_PROVIDER_RETRY) — 추가 저장 없음",
    (stateAfter.status as unknown as string) === "WAITING_PROVIDER_RETRY"
  );
}

async function scenarioNoAbortSignalBehavesExactlyAsBeforeRegression(): Promise<void> {
  // TEST8 — abortSignal을 지정하지 않으면(모든 기존 호출부) 기존 동작과 완전히 동일하다.
  // 이 파일의 나머지 246개 기존 시나리오가 이미 이 회귀를 증명하지만, 이 defect가 만든
  // 새 코드 경로(previousAttemptResult 확장/hintParts 재구조화/orchestrator.ts
  // sleepOrAbort)를 겨냥해 명시적으로 하나 더 확인한다 — PROTOCOL_ERROR는 여전히 정상적으로
  // durable wait-then-retry를 거쳐 MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT에서 terminal
  // BLOCKED로 끝나야 한다(§ Human Gate=0). TIMEOUT이 아니라 PROTOCOL_ERROR를 쓰는 이유는
  // scenarioProtocolErrorRecordedAndSpeedsUpNextAttempt와 동일 — TIMEOUT은
  // runDeveloperTaskWithRetry의 실제 15s/30s quick-retry sleep(orchestratorDeps.sleep으로
  // override 불가한 별도 계층)을 거쳐 이 테스트를 수 분 단위로 느리게 만든다.
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: [] });
  const manifest = buildPlannerManifest(repo, statePath);

  const caller = makeAlwaysUnrecognizedProtocolCaller();
  const result = await runAutodevOnce({
    manifest,
    developerClaudeCaller: caller.call,
    orchestratorDeps: {
      gptReviewer: fakePassReviewer(),
      sleep: async () => {},
      now: () => Date.now(),
    },
    // abortSignal 의도적으로 생략.
  });

  check("M) abortSignal 없음: PROTOCOL_ERROR가 여전히 durable wait 상한 초과로 terminal BLOCKED(회귀 없음)", result.outcome === "RAN_TASK_NOT_APPROVED");
  const stateAfter = loadState(statePath);
  check("M) abortSignal 없음: 최종 status=BLOCKED(Human Gate 아님, 기존과 동일)", (stateAfter.status as unknown as string) === "BLOCKED");
  check("M) abortSignal 없음: Developer가 정상적으로 여러 차례 호출됨(abort로 조기 차단되지 않음)", caller.receivedInputs.length > 1);
}

// AutoDev Core Maintenance — NO-WRITE Stagnation / Strategy Repeat 재하드닝(2026-08-31,
// JARVIS Task 5.3 실측 — 3회 연속 TIMEOUT 모두 WRITE 0건, 포렌식으로 확정).
//
// 이 시나리오는 (검증 완료, 이 파일에는 남기지 않음) 실제로 매 round TIMEOUT을 반환하는
// developerClaudeCaller로 전체 경로(내부 3회 × durable 6회 = 18회 호출)를 직접 실행해
// 수동으로 1회 확인했다 — 3번째 호출부터 전략 전환 안내가 나타나고 durable retry 경계를
// 넘어서도 유지됨을 실측 확인(PASS). 다만 runAutodevOnce()는 claude-developer.ts의 내부
// transient retry(최대 2회, 15s/30s 실제 대기 — orchestratorDeps.sleep으로 override 불가한
// 별도 계층, § scenarioProtocolErrorRecordedAndSpeedsUpNextAttempt와 동일한 이유)를 그대로
// 통과시켜, 이 경로 전체를 상시 회귀 테스트로 그대로 남기면 매 test:autodev 실행마다
// 수 분이 걸린다. 대신 이 스캐폴드는 previousAttemptResult 시딩(§ autodev.ts:1281, 이미
// 검증된 기존 seed 경로 — J 시나리오와 동일한 "재시작 이후 첫 라운드" 원칙)을 이용해, 실제
// durable retry가 방금 남겼을 discoveryProgress/noWriteRepeatCount를 state.lastClaudeResult에
// 직접 심어두고 단 1회의 빠른 성공 라운드만 실행한다 — autodev.ts의 hintParts 생성 코드(§
// buildDiscoveryProgressRetryHint/buildNoWriteStrategyEscalationHint 호출부)를 정확히 같은
// 코드 경로로, 실제 대기 없이 검증한다. claude-developer.ts 내부 3회 루프 자체의 escalation
// 타이밍(2회째부터 등장)은 claude-developer-retry-tests.ts가 sleep을 override할 수 있는
// 레벨에서 별도로 빠르게 검증한다.
async function scenarioNoWriteStrategyHintInjectedFromSeededDurableState(): Promise<void> {
  const repo = makeTempGitRepo();
  const seededLastClaudeResult: ClaudeResult = {
    success: false,
    summary: "Claude Developer가 3회 연속 일시적 오류(TIMEOUT)로 실패했습니다",
    changedFiles: [],
    tests: [],
    rawOutput: "",
    errorCode: "TIMEOUT",
    discoveryProgress: { filesRead: ["proj/a.ts", "proj/b.ts"], discoveryOnlyRoundCount: 3, implementationLocked: false, lastRoundReached: 4 },
    noWriteRepeatCount: 2,
  };
  const statePath = makeTempStateFile(repo, { completedTasks: [], lastClaudeResult: seededLastClaudeResult });
  const manifest = buildPlannerManifest(repo, statePath);

  const receivedInputs: string[] = [];
  const caller = async (input: string) => {
    receivedInputs.push(input);
    return {
      success: true,
      summary: JSON.stringify({ type: "TASK_COMPLETE", summary: "구현 완료", changedFiles: [], testsRequested: [] }),
      changedFiles: [],
      tests: [],
      rawOutput: "",
    };
  };

  await runAutodevOnce({
    manifest,
    developerClaudeCaller: caller,
    orchestratorDeps: { gptReviewer: fakePassReviewer(), sleep: async () => {}, now: () => Date.now() },
  });

  check("N) 시딩된 직전 실패의 discoveryProgress 안내가 첫 라운드부터 이미 포함됨(재탐색 억제)", receivedInputs[0]?.includes("proj/a.ts") ?? false);
  check(
    "N) 시딩된 noWriteRepeatCount(2)에 따른 전략 전환 안내가 durable retry 시작 즉시(첫 라운드부터) 포함됨",
    receivedInputs[0]?.includes("WRITE 없이 2회 연속 실패") ?? false
  );
  check("N) 두 안내가 같은 입력에 함께 존재해도 정상 성공으로 진행됨(안내가 진행을 방해하지 않음)", receivedInputs.length === 1);
}

async function main(): Promise<void> {
  const realStateBefore = readFileSync(DEFAULT_STATE_PATH, "utf-8");

  scenarioPlannerPhase1Task1DoneSelectsTask2();
  scenarioPlannerPhaseLastTaskTransitionsToNextPhase();
  scenarioPlannerFinalGateIsSelected();
  scenarioPlannerAllTasksDoneIsFinalGateStop();
  scenarioPlannerWaitingHumanStaysStopped();
  scenarioPlannerApprovedStatusResumesCheckpointWithoutHumanFinalReview();
  scenarioPlannerApprovedStatusWithoutPassDecisionDoesNotResume();
  scenarioPlannerApprovedStatusWithMismatchedCurrentTaskDoesNotResume();

  try {
    await scenarioRunAutodevOnceHappyPath();
    await scenarioRunAutodevOnceChangedFilesWithFailedRequiredTestNeverCallsReviewer();
    await scenarioRunAutodevOnceChangedFilesWithPassedRequiredTestCallsReviewer();
    await scenarioRunAutodevOnceNoChangedFilesWithFailedRequiredTestNeverCallsReviewer();
    await scenarioRunAutodevOnceCheckpointBlockedOnUnexpectedFile();
    await scenarioRunAutodevOnceNotApprovedSkipsCheckpoint();
    await scenarioRunAutodevOnceNoTaskStops();
    await scenarioRunAutodevOnceMidRegistryTaskIsSubtaskOnly();
    await scenarioRunAutodevOnceFinalHumanGateEmitsDeploymentWaitingHuman();
    await scenarioRunAutodevOnceFinalNonGateTaskEmitsProjectCompleted();
    await scenarioRunAutodevOnceBlockedByRemoteGitAtStart();
    await scenarioRunAutodevOnceRemoteChangedDuringRunBlocksCheckpoint();
    await scenarioRunAutodevOnceProceedsDespiteMissingRequiredTestScript();
    await scenarioRunAutodevOnceProceedsDespiteMissingRequiredTestScriptForArbitraryFutureTask();
    await scenarioRunAutodevOnceReconcilesStaleRequiredTestConfigWaitingHuman();
    await scenarioRunAutodevOnceDoesNotReconcileGenuineHumanFinalReviewWaitingHuman();
    await scenarioRunAutodevOncePassesPreviousScopeViolationContextToNextDeveloper();
    await scenarioRunAutodevOncePassesPreviousFailureEvidenceToNextDeveloper();
    await scenarioRunAutodevOnceBlocksOnBrokenRequiredTestExecutionEnvironment();
    await scenarioRunAutodevOnceReconcilesStaleRequiredTestExecutionEnvironmentBlocked();
    await scenarioRunAutodevOnceCleansUpUntrackedScopeViolationFilesBeforeNextAttempt();
    await scenarioRunAutodevOnceReconcilesStaleReviewCycleExhaustedWaitingHuman();
    await scenarioRunAutodevOnceReconcilesStaleCheckpointScopeViolationAndCleansUpLeftover();
    await scenarioTechnicalHumanGateMatrixReviewBlockAndScopeViolation();
    await scenarioRunAutodevOnceEscalatesAfterMidFlightCrashLoopExceedsCap();
    await scenarioRunAutodevOnceEscalatesAfterNoWriteRepeatExceedsCap();
    await scenarioRunAutodevOnceStillCallsDeveloperBelowNoWriteCap();
    await scenarioRunAutodevOnceProcessRestartCircuitBreakerAllowsFirstRepeat();
    await scenarioRunAutodevOnceDoesNotReconcileGenuineBudgetExceededWaitingHuman();
    await scenarioRunAutodevOnceDoesNotReconcileSecurityCheckpointBlockedWaitingHuman();
    await scenarioSecretPrecheckAutoFixesFindingWithoutHumanGate();
    await scenarioSecretPrecheckDoesNotRepeatDeveloperCallWhenFindingPersists();
    await scenarioRunAutodevOnceDeterministicReviewCycleExhaustionEscalatesEarly();
    await scenarioRunAutodevOnceAutoRepairsRequiredTestScriptAndContinues();
    await scenarioCrossTaskMemoryReuseEndToEnd();
    await scenarioSameTaskDoesNotRepeatFailedStrategy();
    await scenarioProtocolErrorRecordedAndSpeedsUpNextAttempt();
    await scenarioAbortBeforeStartSkipsEverything();
    await scenarioAbortDuringDurableWaitStopsQuicklyAndPreservesState();
    await scenarioNoAbortSignalBehavesExactlyAsBeforeRegression();
    await scenarioNoWriteStrategyHintInjectedFromSeededDurableState();

    await scenarioApprovedCrashBeforeCheckpointResumesWithoutRerunningDeveloper();
    await scenarioReviewStagnationBudgetPersistsAcrossRestart();
    await scenarioClaudeLimitWaitBudgetPersistsAcrossRestart();
    await scenarioDanglingProjectStateReconciledWhenNoMoreTasks();

    await scenarioHumanFinalReviewGatePausesBeforeCheckpoint();
    await scenarioHumanFinalReviewRerunWithoutApprovalStaysBlocked();
    await scenarioHumanFinalReviewValidApproveResumesCheckpoint();
    scenarioHumanFinalReviewStaleApprovalForOtherTaskIsRejected();
    await scenarioHumanFinalReviewReviewerNotApprovedNeverEntersGate();
    scenarioHumanFinalReviewCorruptedOrInconsistentStateFailsClosed();
    await scenarioHumanFinalReviewApproveRejectsWrongTaskId();
    await scenarioHumanFinalReviewCheckpointExactlyOnceOnRepeatedResume();
    await scenarioHumanFinalReviewRejectKeepsCheckpointBlocked();
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

  // 회귀 방지: autodev.ts 소스에 Phase 하드코딩이 재도입되지 않았는지 소스 스캔으로도 확인한다.
  const autodevSource = readFileSync(join(__dirname, "..", "src", "autodev.ts"), "utf-8");
  check("소스 회귀: autodev.ts에 TASK_1 하드코딩 상수 없음", !/const\s+TASK_1\s*=/.test(autodevSource));
  check("소스 회귀: autodev.ts에 TASK_2 하드코딩 상수 없음", !/const\s+TASK_2\s*=/.test(autodevSource));
  check("소스 회귀: autodev.ts가 task-registry를 통해서만 다음 task를 고름(getNextTask 사용)", autodevSource.includes("getNextTask"));

  // Phase A Task A7 / Phase B Task B3 — autodev.ts(Core)는 어떤 특정 프로젝트도 import하지
  // 않는다(silent fallback 없음).
  check(
    "소스 회귀(A7/B3): autodev.ts가 project-manifests/movan을 import하지 않음",
    !/from\s+"\.\/project-manifests\/movan"/.test(autodevSource)
  );
  check(
    "소스 회귀(A7): decideNextAction의 taskRegistry 매개변수에 기본값이 없음(= 없음)",
    /taskRegistry:\s*readonly TaskDefinition\[\]\s*\)/.test(autodevSource)
  );

  console.log("\n=== autodev planner/checkpoint 통합 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
