import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { decideNextAction, runAutodevOnce } from "./autodev";
import { MOVAN_TASK_REGISTRY } from "./project-registries/movan";
import { MOVAN_PROJECT_MANIFEST } from "./project-manifests/movan";
import { DEFAULT_STATE_PATH } from "./state";
import type { ProjectState, ClaudeResult } from "./types";
import type { GptReviewerReturn } from "./orchestrator";

// 이 파일은 두 계층을 검증한다:
//   A) decideNextAction() — 순수 함수, 부수효과 없음(task-registry 엔진 + MOVAN_TASK_REGISTRY
//      데이터 기반 다음 task 선택. autodev.ts가 이 둘을 배선한다).
//   B) runAutodevOnce() — 실제 orchestrator/checkpoint 배선까지 포함한 통합 시나리오.
//      claudeRunner/gptReviewer는 항상 fake로 주입해 실제 Claude CLI/OpenAI API를 호출하지
//      않는다. project-state.json/git commit은 전부 OS 임시 디렉터리 안에서만 일어나며,
//      실제 automation/config/project-state.json과 실제 프로젝트 repo는 어떤 시나리오에서도
//      건드리지 않는다(끝에서 실제 state 파일 내용을 read하여 증명한다).

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

function idsUpTo(taskId: string): string[] {
  const idx = MOVAN_TASK_REGISTRY.findIndex((t) => t.id === taskId);
  if (idx === -1) throw new Error(`알 수 없는 task id: ${taskId}`);
  return MOVAN_TASK_REGISTRY.slice(0, idx + 1).map((t) => t.id);
}

function allTaskIds(): string[] {
  return MOVAN_TASK_REGISTRY.map((t) => t.id);
}

// ---------------------------------------------------------------------------
// A) planner(decideNextAction) — 순수 함수 시나리오
// ---------------------------------------------------------------------------
function scenarioPlannerPhase13Task1DoneSelectsTask2(): void {
  const state = baseState({ status: "READY", completedTasks: ["13.1"] });
  const decision = decideNextAction(state, MOVAN_TASK_REGISTRY);
  check("planner: Phase13 Task1 완료 → Task2 선택(kind=RUN_TASK)", decision.kind === "RUN_TASK");
  check("planner: 선택된 task.id === '13.2'", decision.kind === "RUN_TASK" && decision.task.id === "13.2");
}

function scenarioPlannerTask2DoneSelectsPhase14Task1(): void {
  const state = baseState({ status: "READY", completedTasks: ["13.1", "13.2"] });
  const decision = decideNextAction(state, MOVAN_TASK_REGISTRY);
  check("planner: Task2 완료 → Phase14 Task1 선택(kind=RUN_TASK)", decision.kind === "RUN_TASK");
  check("planner: 선택된 task.id === '14.1'", decision.kind === "RUN_TASK" && decision.task.id === "14.1");
}

function scenarioPlannerPhaseLastTaskTransitionsToNextPhase(): void {
  // Phase 14의 마지막 task(14.2)까지 완료 → Phase 15 첫 task(15.1)로 전환.
  const state = baseState({ status: "READY", completedTasks: idsUpTo("14.2") });
  const decision = decideNextAction(state, MOVAN_TASK_REGISTRY);
  check("planner: phase 마지막 task(14.2) 완료 → 다음 phase 전환(kind=RUN_TASK)", decision.kind === "RUN_TASK");
  check(
    "planner: 선택된 task가 Phase15 Task1(15.1)",
    decision.kind === "RUN_TASK" && decision.task.id === "15.1" && decision.task.phase === 15
  );
}

function scenarioPlannerPhase16LastTaskIsFinalGate(): void {
  // Phase16 Task2(16.2)까지 완료 → 마지막 task(16.3, isHumanGate)가 선택되어야 한다.
  const state = baseState({ status: "READY", completedTasks: idsUpTo("16.2") });
  const decision = decideNextAction(state, MOVAN_TASK_REGISTRY);
  check("planner: Phase16 Task2 완료 → Task3(16.3) 선택", decision.kind === "RUN_TASK" && decision.task.id === "16.3");
  check("planner: 선택된 task가 isHumanGate=true", decision.kind === "RUN_TASK" && decision.task.isHumanGate === true);
}

function scenarioPlannerAllTasksDoneIsFinalGateStop(): void {
  // registry의 모든 task(16.3 포함)까지 전부 완료 → 더 이상 자동 실행할 task가 없다.
  const state = baseState({ status: "READY", completedTasks: allTaskIds() });
  const decision = decideNextAction(state, MOVAN_TASK_REGISTRY);
  check("planner: Phase16 마지막(16.3)까지 전부 완료 → STOP(final gate)", decision.kind === "STOP");
  check(
    "planner: STOP 사유에 배포/사람 확인 관련 안내 포함",
    decision.kind === "STOP" && (decision.reason.includes("배포") || decision.reason.includes("DEPLOYMENT_WAITING_HUMAN"))
  );
}

function scenarioPlannerWaitingHumanStaysStopped(): void {
  const state = baseState({ status: "WAITING_HUMAN", completedTasks: ["13.1"] });
  const decision = decideNextAction(state, MOVAN_TASK_REGISTRY);
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

function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "movan-autodev-integration-"));
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
  const statePath = join(dir, "automation", "config", "project-state.json");
  mkdirSync(join(dir, "automation", "config"), { recursive: true });
  const state = baseState({ status: "READY", completedTasks: ["13.1"], ...overrides });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  return statePath;
}

function writeRepoFile(repo: string, relPath: string, content: string): void {
  const abs = join(repo, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function fakePassReviewer(): (result: ClaudeResult, reviewCycle: number, task: string, allowedPathPrefixes?: string[]) => Promise<GptReviewerReturn> {
  return async () => ({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "테스트: 문제 없음", nextTask: null });
}

async function scenarioRunAutodevOnceHappyPath(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo); // completedTasks=["13.1"] → 다음은 13.2

  const claudeRunner = async (): Promise<ClaudeResult> => {
    // Claude가 실제로 파일을 만든 것처럼 temp repo 안에 직접 기록한다(13.2의
    // allowedPathPrefixes=["web/app/", ...] 범위 안).
    writeRepoFile(repo, "web/app/fake-task-13-2-marker.tsx", "export default function Marker() { return null; }\n");
    return {
      success: true,
      summary: "테스트: 13.2 구현 완료",
      changedFiles: ["web/app/fake-task-13-2-marker.tsx"],
      tests: [
        { name: "web:tsc", pass: true },
        { name: "web:build", pass: true },
      ],
      rawOutput: "",
    };
  };

  const result = await runAutodevOnce({
    manifest: MOVAN_PROJECT_MANIFEST,
    statePath,
    cwd: repo,
    orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() },
  });

  check("runAutodevOnce happy path: outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("runAutodevOnce happy path: taskId=13.2", result.taskId === "13.2");
  check("runAutodevOnce happy path: checkpoint.ok=true", result.checkpoint?.ok === true);
  check("runAutodevOnce happy path: commitHash 존재", typeof result.checkpoint?.commitHash === "string");

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("runAutodevOnce happy path: completedTasks에 13.2 추가됨", finalState.completedTasks.includes("13.2"));
  check("runAutodevOnce happy path: status='READY'(다음 task 대기)", finalState.status === "READY");
  check("runAutodevOnce happy path: currentTask가 14.1을 가리킴", typeof finalState.currentTask === "string" && finalState.currentTask.includes("14.1"));
  check("runAutodevOnce happy path: gitCheckpoint가 실제 commit hash로 갱신됨", finalState.gitCheckpoint === result.checkpoint?.commitHash);

  const log = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "";
  check("runAutodevOnce happy path: product commit + administrative commit 2건 생성(+init 1건=3건)", log.trim().split("\n").length === 3);
  const statusAfter = (spawnSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf-8" }).stdout || "").trim();
  check("runAutodevOnce happy path: 최종적으로 working tree clean", statusAfter === "");
}

async function scenarioRunAutodevOnceCheckpointBlockedOnUnexpectedFile(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo);

  const claudeRunner = async (): Promise<ClaudeResult> => {
    // 13.2의 allowedPathPrefixes 밖(web/lib/storage/)에 파일을 만든다 — checkpoint가
    // BLOCK해야 한다.
    writeRepoFile(repo, "web/lib/storage/unexpected.ts", "export const oops = true;\n");
    return {
      success: true,
      summary: "테스트: 범위 밖 파일 생성(의도된 실패 시나리오)",
      changedFiles: ["web/lib/storage/unexpected.ts"],
      tests: [{ name: "web:tsc", pass: true }],
      rawOutput: "",
    };
  };

  const result = await runAutodevOnce({
    manifest: MOVAN_PROJECT_MANIFEST,
    statePath,
    cwd: repo,
    orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() },
  });

  check("runAutodevOnce checkpoint-blocked: outcome=RAN_TASK_CHECKPOINT_BLOCKED", result.outcome === "RAN_TASK_CHECKPOINT_BLOCKED");
  check("runAutodevOnce checkpoint-blocked: checkpoint.ok=false", result.checkpoint?.ok === false);
  check(
    "runAutodevOnce checkpoint-blocked: unexpectedFiles에 web/lib/storage/unexpected.ts 포함",
    (result.checkpoint?.unexpectedFiles ?? []).includes("web/lib/storage/unexpected.ts")
  );

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("runAutodevOnce checkpoint-blocked: completedTasks에 13.2가 추가되지 않음", !finalState.completedTasks.includes("13.2"));
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

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return { success: true, summary: "테스트: 항상 REVISE 대상", changedFiles: [], tests: [{ name: "web:tsc", pass: true }], rawOutput: "" };
  };
  const alwaysRevise = async (): Promise<GptReviewerReturn> => ({
    decision: "REVISE",
    severity: { critical: 0, high: 0, medium: 1 },
    feedback: "테스트: 항상 REVISE(무한루프 방지 확인용)",
    nextTask: "다시 시도",
  });

  const result = await runAutodevOnce({
    manifest: MOVAN_PROJECT_MANIFEST,
    statePath,
    cwd: repo,
    orchestratorDeps: { claudeRunner, gptReviewer: alwaysRevise },
  });

  check("runAutodevOnce 미승인: outcome=RAN_TASK_NOT_APPROVED", result.outcome === "RAN_TASK_NOT_APPROVED");
  check("runAutodevOnce 미승인: checkpoint가 시도되지 않음(undefined)", result.checkpoint === undefined);

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("runAutodevOnce 미승인: completedTasks 변화 없음", !finalState.completedTasks.includes("13.2"));

  const log = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "";
  check("runAutodevOnce 미승인: commit이 생성되지 않음(init 1건만)", log.trim().split("\n").length === 1);
  check("runAutodevOnce 미승인: MAX_REVIEW_CYCLES(5) 초과하지 않고 Claude 호출됨", claudeCalls > 0 && claudeCalls <= 5);
}

async function scenarioRunAutodevOnceNoTaskStops(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: allTaskIds() });

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return { success: true, summary: "호출되면 안 됨", changedFiles: [], tests: [], rawOutput: "" };
  };

  const result = await runAutodevOnce({
    manifest: MOVAN_PROJECT_MANIFEST,
    statePath,
    cwd: repo,
    orchestratorDeps: { claudeRunner },
  });
  check("runAutodevOnce 모든 task 완료: outcome=STOPPED", result.outcome === "STOPPED");
  check("runAutodevOnce 모든 task 완료: Claude worker 호출 0회", claudeCalls === 0);
}

async function main(): Promise<void> {
  const realStateBefore = readFileSync(DEFAULT_STATE_PATH, "utf-8");

  scenarioPlannerPhase13Task1DoneSelectsTask2();
  scenarioPlannerTask2DoneSelectsPhase14Task1();
  scenarioPlannerPhaseLastTaskTransitionsToNextPhase();
  scenarioPlannerPhase16LastTaskIsFinalGate();
  scenarioPlannerAllTasksDoneIsFinalGateStop();
  scenarioPlannerWaitingHumanStaysStopped();

  try {
    await scenarioRunAutodevOnceHappyPath();
    await scenarioRunAutodevOnceCheckpointBlockedOnUnexpectedFile();
    await scenarioRunAutodevOnceNotApprovedSkipsCheckpoint();
    await scenarioRunAutodevOnceNoTaskStops();
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

  // Phase A Task A7 — autodev.ts(Core)는 이제 MOVAN을 import하지 않는다(silent fallback 제거).
  check(
    "소스 회귀(A7): autodev.ts가 project-manifests/movan을 import하지 않음",
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
