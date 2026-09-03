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
import { MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT } from "./orchestrator";
import { MAX_REVIEW_CYCLES } from "./policy";
import {
  debugComputeLockFilePath,
  resolveCanonicalProjectPath,
  RUNTIME_LOCK_DIR,
  PROJECT_LOCK_SCHEMA_VERSION,
} from "./project-lock";
import type { ProjectLockMetadata } from "./project-lock";
import { classifyWaitingHumanReason } from "./human-gate-policy";

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
// E — AutoDev / JARVIS 신뢰성 보완(2026-08-27) 도입 당시에는 checkpoint scope violation이
// canonical Human Gate Policy상 기술적 자동 복구 대상이었다 — Telegram 승인 없이 continuous
// runner가 스스로 재시도했다(그때는 자동 삭제가 leftover를 지워 실제로 매끄럽게 통과했다).
//
// No-Safe-Recovery-Action Gate(2026-08-31) 이후로 완전히 갱신 — Positive-Provenance-Only
// Auto-Delete Policy(a490700)로 자동 삭제 자체가 제거되면서 "재시도하면 스스로 풀린다"는
// 전제가 깨졌다는 것이 확인됐다(§ 요구사항 조사 1/2). Developer에게는 애초에 파일 삭제
// action이 없고, leftover는 이미 allowedPathPrefixes 밖이라 WRITE_FILE로도 지울 수 없으므로
// — 이 blocker는 Developer/Reviewer를 몇 번을 재시도해도 절대 사라지지 않는 결정론적
// blocker다. 그래서 CHECKPOINT_SCOPE_VIOLATION은 이제 genuine으로 재분류됐다(§
// human-gate-policy.ts) — continuous-runner.ts는 그 결과 이 task를 단 한 번도 재시도하지
// 않고 즉시 멈춘다(§ 요구사항 시나리오 A — "동일 Developer/API 호출 반복 금지 → 빠르게
// terminal/user-decision 상태"). T2/T3는 전혀 실행되지 않는다 — 안전이 무인화보다 우선한다는
// 정책의 의도된 결과다.
// ---------------------------------------------------------------------------
async function scenarioCheckpointScopeViolationStopsImmediatelyWithoutRetry(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: [] });
  const manifest = buildManifest(repo, statePath);

  const calls: string[] = [];
  const claudeRunner = async (task: string): Promise<ClaudeResult> => {
    calls.push(task);
    writeRepoFile(repo, "other/unexpected.txt", "허용 경로 밖 변경(1차 시도)");
    return {
      success: true,
      summary: "테스트: 허용 경로 밖 변경(1차 시도)",
      changedFiles: ["other/unexpected.txt"],
      tests: [{ name: "proj:check", pass: true }],
      rawOutput: "",
    };
  };

  const result = await runAutodevContinuous({
    manifest,
    orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() },
  });

  check("E) 1차 시도: outcome=RAN_TASK_CHECKPOINT_BLOCKED(scope violation)", result.iterations[0].result.outcome === "RAN_TASK_CHECKPOINT_BLOCKED");
  check("E) 단 1회 iteration만 실행됨(재시도 없음, 즉시 STOP)", result.iterations.length === 1);
  check("E) Developer가 정확히 1회만 호출됨(API/Developer 재호출 없음)", calls.length === 1);
  check(
    "E) stop.kind=OUTCOME_STOP(TECHNICAL_RECOVERY_LIMIT_REACHED로 50회 소진하는 구조가 아님)",
    result.stop.kind === "OUTCOME_STOP" && result.stop.outcome === "RAN_TASK_CHECKPOINT_BLOCKED"
  );
  check("E) leftover(허용 경로 밖 파일)가 삭제되지 않고 그대로 남음", existsSync(join(repo, "other", "unexpected.txt")));
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("E) T2/T3는 전혀 실행되지 않음(completedTasks가 비어있음)", finalState.completedTasks.length === 0);
  check("E) 최종 status=WAITING_HUMAN(즉시 명확한 사용자 판단 상태로 전환됨)", (finalState.status as unknown as string) === "WAITING_HUMAN");
  check("E) GENUINE_HUMAN_JUDGMENT로 분류됨(기술적 자동 복구 대상 아님)", classifyWaitingHumanReason(finalState) === "GENUINE_HUMAN_JUDGMENT");
}

// ---------------------------------------------------------------------------
// F — AutoDev / JARVIS 신뢰성 보완(2026-08-27), AutoDev Efficiency / Review Stagnation
// Hardening(2026-08-28), P0-4/P1-2 하드닝(2026-08-30, 독립 감사)로 갱신.
//
// P0-4 하드닝(2026-08-30, 독립 감사) — 이전 정책(2026-08-30 이전 버전)은 동일한
// required-test 실패 fingerprint가 결정론적으로 반복되면 genuine WAITING_HUMAN으로
// 승격했다. 독립 감사에서 "test failure/deterministic blocker는 Human Gate가 아니다"라는
// 정책 위반으로 확인됐다(deterministic-simulation.ts Run B로 재현) — 이제 이 반복은 항상
// 기술적 durable wait-then-retry(§ orchestrator.ts REVIEW_CYCLE_EXHAUSTED)로 처리된다.
// P1-2 하드닝 — 그 durable wait에도 이제 상한(MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT=5)이
// 있다 — 상한을 넘으면 genuine이 아니라 terminal 기술적 BLOCKED로 전환한다(§
// blockOnDurableWaitRetryExhausted). 이 시나리오는 매 attempt마다 완전히 동일하게
// 실패하는 required test가 결국 "genuine Human Gate 0"를 지키면서도 무한 반복되지 않고
// terminal BLOCKED로 수렴하는지 검증한다.
// ---------------------------------------------------------------------------
async function scenarioIdenticalRequiredTestFailureEscalatesInsteadOfDurableRetry(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: [] });
  const manifest = buildManifest(repo, statePath);

  const calls: string[] = [];
  let callCount = 0;
  const claudeRunner = async (task: string): Promise<ClaudeResult> => {
    callCount += 1;
    calls.push(task);
    // 매 호출마다 완전히 동일하게 실패한다(다양한 이유가 아니라 같은 이유) — durable wait
    // 상한(MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT회 exhaustion, 매 exhaustion마다
    // MAX_REVIEW_CYCLES round, § policy.ts — 2026-09-04 Efficiency 개선으로 5→3)을 넘어서는
    // 호출은 절대 일어나지 않아야 한다(terminal 기술적 BLOCKED로 이미 전환했으므로).
    return { success: true, summary: "테스트: required test 항상 동일하게 실패", changedFiles: [], tests: [{ name: "proj:check", pass: false }], rawOutput: "" };
  };

  const result = await runAutodevContinuous({
    manifest,
    orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer(), sleep: async () => {}, now: () => Date.now() },
  });

  check(
    "F) T1이 첫 번째 runOnce 호출(=단일 orchestrator() 실행) 안에서 terminal 기술적 BLOCKED로 수렴함(RAN_TASK_NOT_APPROVED)",
    result.iterations[0].result.outcome === "RAN_TASK_NOT_APPROVED" && result.iterations[0].result.taskId === "T1"
  );
  const expectedBoundedCallCount = MAX_REVIEW_CYCLES * (MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT + 1);
  check(
    `F) developer 호출이 bounded됨(exhaustion마다 MAX_REVIEW_CYCLES round × (MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT+1)회=${expectedBoundedCallCount}, 무한 반복 아님)`,
    callCount === expectedBoundedCallCount && calls.every((c) => c === "Task1 prompt")
  );
  check(
    "F) terminal 기술적 BLOCKED이므로 continuous-runner 자신도 재시도하지 않고 즉시 STOP(T2/T3 시도 안 함, 단 1회 iteration)",
    result.stop.kind === "OUTCOME_STOP" && result.stop.outcome === "RAN_TASK_NOT_APPROVED" && result.iterations.length === 1
  );
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("F) status=BLOCKED(WAITING_HUMAN 아님 — genuine Human Gate 0)", (finalState.status as unknown as string) === "BLOCKED");
  check(
    "F) deferredHumanTasks에 더 이상 DETERMINISTIC_REVIEW_CYCLE_EXHAUSTED 마커가 기록되지 않음(genuine 마커 아님)",
    !finalState.deferredHumanTasks.some((t) => t.startsWith("DETERMINISTIC_REVIEW_CYCLE_EXHAUSTED:"))
  );
  check("F) T1은 아직 완료되지 않음(completedTasks가 비어있음)", JSON.stringify(finalState.completedTasks) === JSON.stringify([]));
}

// ---------------------------------------------------------------------------
// F2 — 기술적 자동 복구도 무한정은 아니다: maxTechnicalRecoveryAttempts를 넘으면 멈춘다(진짜
// 무한루프 버그로부터의 순수 리소스 안전장치일 뿐 — 이 상한 도달 자체가 사람 판단 사유로
// 격상되지는 않는다, § human-gate-policy.ts).
// ---------------------------------------------------------------------------
async function scenarioTechnicalRecoveryLimitStopsRunawayRetries(): Promise<void> {
  const repo = makeTempGitRepo();
  const statePath = makeTempStateFile(repo, { completedTasks: [] });
  const manifest = buildManifest(repo, statePath);

  // Positive-Provenance-Only Auto-Delete Policy(a490700) + No-Safe-Recovery-Action
  // Gate(2026-08-31) 이후로 CHECKPOINT_SCOPE_VIOLATION은 genuine이 되어(더 이상 매 runAutodevOnce
  // 호출마다 outer loop 수준에서 조용히 재조정되지 않는다) 이 시나리오의 원래 fixture로는
  // 더 이상 "outer-level technicalRecoveryCount 상한" 자체를 격리해 검증할 수 없다 — 그
  // fixture는 이제 §9-D/E(autodev-tests.ts)/E(continuous-runner-tests.ts)가 검증하는 "즉시
  // genuine으로 전환되어 재시도 자체를 안 한다"는 다른(그리고 더 안전한) 동작을 보여준다.
  // 대신 GPT Reviewer 자신의 BLOCK 판정(hasReviewBlocked — 이번 정책 변경과 무관하게 여전히
  // TECHNICAL_AUTO_RECOVERABLE, § human-gate-policy.ts)을 매번 반환하도록 해 "내부 REVISE
  // 루프 없이 매 runAutodevOnce 호출마다 곧바로 WAITING_HUMAN(기술적)으로 끝나고, 다음 호출이
  // 그걸 재조정해 다시 시도하는" 순수 outer-loop 반복을 재현한다.
  const claudeRunner = async (): Promise<ClaudeResult> => {
    writeRepoFile(repo, "proj/marker.txt", `attempt-${Date.now()}-${Math.random()}`);
    return { success: true, summary: "테스트: Reviewer가 항상 BLOCK", changedFiles: ["proj/marker.txt"], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };
  const gptReviewer = async (): Promise<GptReviewerReturn> => ({
    decision: "BLOCK",
    severity: { critical: 0, high: 0, medium: 1 },
    feedback: "테스트: 항상 BLOCK(영원히 고쳐지지 않는 코드 품질 문제를 흉내냄)",
    nextTask: null,
  });

  const result = await runAutodevContinuous(
    { manifest, orchestratorDeps: { claudeRunner, gptReviewer }, maxTechnicalRecoveryAttempts: 3 },
    {}
  );

  check("F2) stop.kind=TECHNICAL_RECOVERY_LIMIT_REACHED(maxTechnicalRecoveryAttempts=3)", result.stop.kind === "TECHNICAL_RECOVERY_LIMIT_REACHED");
  check(
    "F2) 정확히 maxTechnicalRecoveryAttempts+1회 시도 후 멈춤(최초 1회 + 재시도 3회)",
    result.iterations.length === 4
  );
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("F2) 상한 도달해도 project-state.json이 사람 승인이 필요한 상태로 위장되지 않음(여전히 기술적 WAITING_HUMAN)", finalState.status === "WAITING_HUMAN");
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
    await scenarioCheckpointScopeViolationStopsImmediatelyWithoutRetry();
    await scenarioIdenticalRequiredTestFailureEscalatesInsteadOfDurableRetry();
    await scenarioTechnicalRecoveryLimitStopsRunawayRetries();
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
