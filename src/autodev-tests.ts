import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { decideNextAction, runAutodevOnce } from "./autodev";
import { DEFAULT_STATE_PATH } from "./state";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import type { ProjectState, ClaudeResult } from "./types";
import type { GptReviewerReturn } from "./orchestrator";
import { createInMemoryEventStore } from "./event-store";
import { classifyEventForNotification } from "./notification";

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

  const log = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "";
  check("runAutodevOnce happy path: product commit + administrative commit 2건 생성(+init 1건=3건)", log.trim().split("\n").length === 3);
  const statusAfter = (spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf-8" }).stdout || "").trim();
  check("runAutodevOnce happy path: 최종적으로 working tree clean", statusAfter === "");
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

  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner, gptReviewer: alwaysRevise },
  });

  check("runAutodevOnce 미승인: outcome=RAN_TASK_NOT_APPROVED", result.outcome === "RAN_TASK_NOT_APPROVED");
  check("runAutodevOnce 미승인: checkpoint가 시도되지 않음(undefined)", result.checkpoint === undefined);

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("runAutodevOnce 미승인: completedTasks 변화 없음", !finalState.completedTasks.includes("P1.2"));

  const log = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "";
  check("runAutodevOnce 미승인: commit이 생성되지 않음(init 1건만)", log.trim().split("\n").length === 1);
  check("runAutodevOnce 미승인: MAX_REVIEW_CYCLES(5) 초과하지 않고 Claude 호출됨", claudeCalls > 0 && claudeCalls <= 5);
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

async function main(): Promise<void> {
  const realStateBefore = readFileSync(DEFAULT_STATE_PATH, "utf-8");

  scenarioPlannerPhase1Task1DoneSelectsTask2();
  scenarioPlannerPhaseLastTaskTransitionsToNextPhase();
  scenarioPlannerFinalGateIsSelected();
  scenarioPlannerAllTasksDoneIsFinalGateStop();
  scenarioPlannerWaitingHumanStaysStopped();

  try {
    await scenarioRunAutodevOnceHappyPath();
    await scenarioRunAutodevOnceCheckpointBlockedOnUnexpectedFile();
    await scenarioRunAutodevOnceNotApprovedSkipsCheckpoint();
    await scenarioRunAutodevOnceNoTaskStops();
    await scenarioRunAutodevOnceMidRegistryTaskIsSubtaskOnly();
    await scenarioRunAutodevOnceFinalHumanGateEmitsDeploymentWaitingHuman();
    await scenarioRunAutodevOnceFinalNonGateTaskEmitsProjectCompleted();
    await scenarioRunAutodevOnceBlockedByRemoteGitAtStart();
    await scenarioRunAutodevOnceRemoteChangedDuringRunBlocksCheckpoint();
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
