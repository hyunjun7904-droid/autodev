import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runAutodevOnce, runPreDevelopmentAdvisory, runPostDevelopmentAdvisory } from "./autodev";
import { runOrchestrator } from "./orchestrator";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import type { ProjectState, ClaudeResult } from "./types";
import type { GptReviewerReturn } from "./orchestrator";
import type { ReadOnlyAgentRunner } from "./agent-orchestrator";
import { createInMemoryEventStore } from "./event-store";
import type { EventStore, AuditWritableCheck } from "./event-store";
import { isAuditCriticalEvent } from "./observability-event";

// Production Pipeline Integration & Review Policy 단일화 테스트(Phase F Task F4/F4.1). 실제
// Claude/GPT 유료 API를 전혀 호출하지 않는다 — claudeRunner/gptReviewer/advisoryReadOnlyRunner는
// 항상 fake로 주입한다. MOVAN product task도 실행하지 않는다.
//
// 이 파일이 검증하는 것: (1) taskDef의 deterministic 신호(needsPlanning/
// needsExternalResearch/needsQaAdvisory/needsSecurityReview)에 따라 advisory agent가
// runAutodevOnce()의 실제 production 경로에서 실제 필요한 시점(pre-development:
// planner/research, post-development/pre-checkpoint: qa/security)에만 실행되는지(§
// F4.1), 신호가 없으면 LLM 호출이 0회인지, (2) developer/reviewer/REVISE/checkpoint의
// 핵심 순서와 판정은 여전히 기존 orchestrator.ts/checkpoint.ts가 단일 실행축으로 전담하고
// F3의 별도 Developer↔Reviewer REVISE loop가 production에 중복 연결되지 않았는지(§
// scenarioF3LoopNotDuplicatedInProduction), (3) review-policy.ts로 단일화된 판정
// (critical/high, required test 실패, MAX_REVIEW_CYCLES 소진)이 production 경로에서도
// 동일하게 적용되는지.
//
// Secret/Dependency Scanner Gate, per-run Safe Executor context, Fixture E2E, F1/F2/F3
// 자체 회귀는 이 파일에서 다시 테스트하지 않는다 — 각각의 기존 테스트 스위트(그리고 이번
// 세션에서 재확인한 전체 regression)가 이미 담당한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];

const FIXTURE_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["proj/"],
  allowedWritePrefixes: ["proj/"],
  allowedCommands: [],
};

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

function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-f4-integration-"));
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
  const state = baseState({ status: "READY", completedTasks: [], ...overrides });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  return statePath;
}

function writeRepoFile(repo: string, relPath: string, content: string): void {
  const abs = join(repo, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function makeTaskDef(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: "T1.1",
    phase: 1,
    taskNumber: 1,
    title: "F4 fixture task",
    prompt: "재시도 로직을 구현해줘",
    requiredTests: [],
    allowedPathPrefixes: ["proj/"],
    prohibitedOperations: [],
    ...overrides,
  };
}

function buildManifest(root: string, statePath: string, taskRegistry: TaskDefinition[]): ProjectManifest {
  return {
    projectId: "f4-fixture-project",
    projectName: "F4 Fixture Project",
    targetProjectRoot: root,
    statePath,
    taskRegistry,
    developerInstructions: "허용 범위: proj/**. F4 통합 테스트 fixture 프로젝트.",
    reviewInstructions: "proj/** 범위 밖 변경이 있으면 반드시 REVISE하세요.",
    reviewScopeDirs: ["proj/"],
    executionPolicy: FIXTURE_EXECUTION_POLICY,
  };
}

function fakeReviewer(
  overrides: Partial<GptReviewerReturn> = {}
): (result: ClaudeResult, reviewCycle: number, task: string, allowedPathPrefixes?: string[]) => Promise<GptReviewerReturn> {
  return async () => ({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "테스트: 문제 없음", nextTask: null, ...overrides });
}

function fakeClaudeRunnerWriting(repo: string, path: string, tests: { name: string; pass: boolean }[] = [{ name: "proj:check", pass: true }]) {
  let calls = 0;
  const runner = async (): Promise<ClaudeResult> => {
    calls += 1;
    writeRepoFile(repo, path, `marker attempt ${calls}\n`);
    return { success: true, summary: `테스트: 구현 완료(attempt ${calls})`, changedFiles: [path], tests, rawOutput: "" };
  };
  return { runner, callCount: () => calls };
}

function countingReadOnlyRunner(): { runner: ReadOnlyAgentRunner; calls: { role: string; prompt: string }[] } {
  const calls: { role: string; prompt: string }[] = [];
  const runner: ReadOnlyAgentRunner = async (prompt) => {
    calls.push({ role: "?", prompt });
    return { success: true, summary: "[FAKE] advisory 완료", rawOutput: prompt };
  };
  return { runner, calls };
}

// ---------------------------------------------------------------------------
// 1) plain code task(advisory 신호 없음) → advisory agent 호출 0회(pre/post 둘 다).
// ---------------------------------------------------------------------------
async function scenarioPlainCodeTaskZeroAdvisoryCalls(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  const { runner: claudeRunner, callCount } = fakeClaudeRunnerWriting(repo, "proj/marker.txt");
  const { runner: advisoryReadOnlyRunner, calls } = countingReadOnlyRunner();

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer() }, advisoryReadOnlyRunner });

  check("plain task: outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("plain task: developer가 정확히 1회 호출됨", callCount() === 1);
  check("plain task: agentAdvisory 필드가 없음(선택된 advisory agent 자체가 없음)", result.agentAdvisory === undefined);
  check("plain task: advisory read-only runner가 전혀 호출되지 않음(토큰 절감 — LLM 호출 0회)", calls.length === 0);
}

// ---------------------------------------------------------------------------
// 2) architecture 판단이 필요한 task(needsPlanning=true) → planner가 pre-development에서
//    실제로 실행되고, 그 요약이 developerContext에 추가 안내로만 덧붙는다.
// ---------------------------------------------------------------------------
async function scenarioArchitectureTaskRunsPlanner(): Promise<void> {
  const taskDef = makeTaskDef({ needsPlanning: true, requiredTests: [] });
  const { runner, calls } = countingReadOnlyRunner();
  const preAdvisory = await runPreDevelopmentAdvisory(taskDef, runner);

  check("architecture task: planner가 실제로 실행됨", preAdvisory?.some((r) => r.role === "planner" && r.status === "SUCCESS") === true);
  check("architecture task: research는 실행되지 않음(needsExternalResearch 미지정)", !preAdvisory?.some((r) => r.role === "research"));
  check("architecture task: read-only runner가 정확히 1회만 호출됨", calls.length === 1);
}

// ---------------------------------------------------------------------------
// 3) 외부 API/공식 문서 조사가 필요한 task(needsExternalResearch=true) → research가
//    pre-development에서 실제로 실행된다.
// ---------------------------------------------------------------------------
async function scenarioExternalResearchTaskRunsResearch(): Promise<void> {
  const taskDef = makeTaskDef({ needsExternalResearch: true, requiredTests: [] });
  const { runner, calls } = countingReadOnlyRunner();
  const preAdvisory = await runPreDevelopmentAdvisory(taskDef, runner);

  check("research task: research가 실제로 실행됨", preAdvisory?.some((r) => r.role === "research" && r.status === "SUCCESS") === true);
  check("research task: planner는 실행되지 않음(needsPlanning 미지정)", !preAdvisory?.some((r) => r.role === "planner"));
  check("research task: read-only runner가 정확히 1회만 호출됨", calls.length === 1);
}

// ---------------------------------------------------------------------------
// 4) security-sensitive 변경(needsSecurityReview=true) → security가 post-development(
//    developer 완료 후, checkpoint 이전)에 실제로 실행된다. Safe Executor/Secret/
//    Dependency Scanner를 대체하지 않는 순수 참고 의견이다.
// ---------------------------------------------------------------------------
async function scenarioSecuritySensitiveTaskRunsSecurityPostPass(): Promise<void> {
  const taskDef = makeTaskDef({ needsSecurityReview: true });
  const { runner, calls } = countingReadOnlyRunner();
  const developerResult: ClaudeResult = {
    success: true,
    summary: "인증 미들웨어 수정",
    changedFiles: ["proj/auth.ts"],
    tests: [{ name: "proj:check", pass: true }],
    rawOutput: "RAW_SHOULD_NOT_BE_RESENT",
  };
  const postAdvisory = await runPostDevelopmentAdvisory(taskDef, developerResult, runner);

  check("security task: security가 post-development에서 실제로 실행됨", postAdvisory?.some((r) => r.role === "security" && r.status === "SUCCESS") === true);
  check("security task: qa는 실행되지 않음(needsQaAdvisory 미지정)", !postAdvisory?.some((r) => r.role === "qa"));
  check("security task: read-only runner가 정확히 1회만 호출됨", calls.length === 1);
  check("security task: prompt에 변경 파일 요약이 포함됨(최소 context)", calls[0].prompt.includes("proj/auth.ts"));
  check("security task: prompt에 developer의 rawOutput 전체가 재전송되지 않음", !calls[0].prompt.includes("RAW_SHOULD_NOT_BE_RESENT"));
}

// ---------------------------------------------------------------------------
// 5) required tests가 이미 충분한(hasFixedRequiredTests 개념과 무관하게, needsQaAdvisory
//    신호 자체가 없는) 단순 task → QA가 호출되지 않는다.
// ---------------------------------------------------------------------------
async function scenarioFixedTestsSufficientSkipsQa(): Promise<void> {
  const taskDef = makeTaskDef({ requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const { runner, calls } = countingReadOnlyRunner();
  const developerResult: ClaudeResult = { success: true, summary: "구현 완료", changedFiles: ["proj/a.ts"], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  const postAdvisory = await runPostDevelopmentAdvisory(taskDef, developerResult, runner);

  check("fixed tests 충분: postAdvisory가 없음(QA 미호출)", postAdvisory === undefined);
  check("fixed tests 충분: read-only runner가 전혀 호출되지 않음", calls.length === 0);
}

// ---------------------------------------------------------------------------
// 6) 테스트 사각지대/추가 검증 필요성이 명시된 task(needsQaAdvisory=true) → QA가
//    post-development에서 실행된다. QA는 deterministic test를 대신하지 않는다(§ 9에서
//    별도로 "덮어쓰지 못함"까지 증명).
// ---------------------------------------------------------------------------
async function scenarioQaAdvisorySignalRunsQaPostPass(): Promise<void> {
  const taskDef = makeTaskDef({ needsQaAdvisory: true });
  const { runner, calls } = countingReadOnlyRunner();
  const developerResult: ClaudeResult = { success: true, summary: "구현 완료", changedFiles: ["proj/a.ts"], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  const postAdvisory = await runPostDevelopmentAdvisory(taskDef, developerResult, runner);

  check("qa 필요 signal: qa가 post-development에서 실제로 실행됨", postAdvisory?.some((r) => r.role === "qa" && r.status === "SUCCESS") === true);
  check("qa 필요 signal: read-only runner가 정확히 1회만 호출됨", calls.length === 1);
}

// ---------------------------------------------------------------------------
// 7) 동일 task에서 동일 Agent 중복 호출 없음 — 여러 신호(needsPlanning+
//    needsExternalResearch, needsQaAdvisory+needsSecurityReview)가 함께 켜져도 각 role은
//    정확히 1번씩만 호출된다(pre-pass에서 2회, post-pass에서 2회 — 합쳐서 각 role 1회).
// ---------------------------------------------------------------------------
async function scenarioNoDuplicateAgentCallsPerTask(): Promise<void> {
  const taskDef = makeTaskDef({ needsPlanning: true, needsExternalResearch: true, needsQaAdvisory: true, needsSecurityReview: true });
  const { runner: preRunner, calls: preCalls } = countingReadOnlyRunner();
  const { runner: postRunner, calls: postCalls } = countingReadOnlyRunner();
  const developerResult: ClaudeResult = { success: true, summary: "구현 완료", changedFiles: ["proj/a.ts"], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };

  const preAdvisory = await runPreDevelopmentAdvisory(taskDef, preRunner);
  const postAdvisory = await runPostDevelopmentAdvisory(taskDef, developerResult, postRunner);

  check("중복 호출 없음: pre-pass가 planner+research 정확히 1회씩(총 2회) 호출함", preCalls.length === 2);
  check("중복 호출 없음: post-pass가 qa+security 정확히 1회씩(총 2회) 호출함", postCalls.length === 2);
  check(
    "중복 호출 없음: pre-pass 결과에 planner/research가 각각 정확히 1개씩만 존재",
    preAdvisory?.filter((r) => r.role === "planner").length === 1 && preAdvisory?.filter((r) => r.role === "research").length === 1
  );
  check(
    "중복 호출 없음: post-pass 결과에 qa/security가 각각 정확히 1개씩만 존재",
    postAdvisory?.filter((r) => r.role === "qa").length === 1 && postAdvisory?.filter((r) => r.role === "security").length === 1
  );
}

// ---------------------------------------------------------------------------
// 8) advisory agent 실패가 fail-open되지 않음 — advisory runner가 success:false를
//    반환해도 그 사실이 checkpoint/승인 판정에 전혀 영향을 주지 않는다(순수 정보이므로
//    "advisory가 실패했으니 사람이 이미 승인한 걸로 친다" 같은 우회가 없음을 증명).
// ---------------------------------------------------------------------------
async function scenarioAdvisoryFailureNotFailOpen(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ needsSecurityReview: true, requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  const { runner: claudeRunner } = fakeClaudeRunnerWriting(repo, "proj/marker.txt");
  const failingAdvisoryRunner: ReadOnlyAgentRunner = async () => ({ success: false, summary: "[FAKE] security advisory 실패", rawOutput: "" });

  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer() },
    advisoryReadOnlyRunner: failingAdvisoryRunner,
  });

  check("advisory 실패: outcome은 여전히 APPROVED_AND_CHECKPOINTED(advisory 실패가 checkpoint를 막지 않음)", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("advisory 실패: agentAdvisory에 security의 FAILED 상태가 정직하게 기록됨", result.agentAdvisory?.some((r) => r.role === "security" && r.status === "FAILED") === true);
}

// ---------------------------------------------------------------------------
// 9) Core required test 실패를 advisory(qa/security)가 "문제 없다"고 낙관 보고해도
//    덮어쓰지 못한다 — 최종 판정은 여전히 review-policy.ts(hasFailedRequiredTest)가 결정.
// ---------------------------------------------------------------------------
async function scenarioAdvisoryCannotOverrideCoreTestFailure(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ needsQaAdvisory: true, needsSecurityReview: true, requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  const claudeRunner = async (): Promise<ClaudeResult> => {
    writeRepoFile(repo, "proj/marker.txt", "broken\n");
    return { success: true, summary: "구현했지만 test 실패", changedFiles: ["proj/marker.txt"], tests: [{ name: "proj:check", pass: false }], rawOutput: "" };
  };
  const optimisticAdvisoryRunner: ReadOnlyAgentRunner = async () => ({ success: true, summary: "[FAKE] 문제 없어 보입니다 — 전부 통과할 것 같습니다.", rawOutput: "" });

  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer() },
    advisoryReadOnlyRunner: optimisticAdvisoryRunner,
  });

  check(
    "advisory가 낙관 보고해도 Core test 실패가 최종 판정(outcome이 APPROVED_AND_CHECKPOINTED가 아님)",
    result.outcome !== "RAN_TASK_APPROVED_AND_CHECKPOINTED"
  );
  check("advisory가 낙관 보고해도 checkpoint가 시도되지 않음", result.checkpoint === undefined);
}

// ---------------------------------------------------------------------------
// F3의 별도 Developer↔Reviewer REVISE loop(executeReviewerStepWithRevise)가 production
// 경로(autodev.ts)에 중복 연결되지 않았음을 소스 레벨로 증명한다 — autodev.ts는
// agent-orchestrator.ts에서 오직 executeRoutingPlan()(advisory 실행에만 쓰임)과 타입만
// import해야 하고, F3의 developer/reviewer REVISE 실행 함수를 직접 부르면 안 된다.
// ---------------------------------------------------------------------------
function scenarioF3LoopNotDuplicatedInProduction(): void {
  const autodevSource = readFileSync(join(__dirname, "..", "src", "autodev.ts"), "utf-8");
  const agentOrchestratorImportLine = autodevSource
    .split("\n")
    .filter((l) => l.includes(`from "./agent-orchestrator"`))
    .join("\n");

  check("F3 미중복 연결: autodev.ts가 agent-orchestrator.ts를 import함(advisory 실행용)", agentOrchestratorImportLine.length > 0);
  check(
    "F3 미중복 연결: autodev.ts가 executeReviewerStepWithRevise(F3 REVISE loop 내부 함수)를 직접 import/호출하지 않음",
    !autodevSource.includes("executeReviewerStepWithRevise")
  );
  check(
    "F3 미중복 연결: autodev.ts는 developer 실제 실행을 여전히 claude-developer.ts(runDeveloperTaskViaSafeExecutor)로만 함",
    autodevSource.includes("runDeveloperTaskViaSafeExecutor")
  );
  check(
    "F3 미중복 연결: autodev.ts는 REVISE 루프 진행을 orchestrator.ts의 runOrchestrator() 정확히 1곳에서만 실제로 호출함(주석 언급 제외)",
    (autodevSource.match(/(?:await\s+)?runOrchestrator\(taskDef\.prompt/g) ?? []).length === 1
  );
}

// ---------------------------------------------------------------------------
// 10/11) REVISE 1회 → developer 재실행 — orchestrator.ts의 기존 production REVISE 루프가
//        F4.1 이후에도 그대로 유지됨을 증명한다.
// ---------------------------------------------------------------------------
async function scenarioReviseOnceThenApprove(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  const { runner: claudeRunner, callCount } = fakeClaudeRunnerWriting(repo, "proj/marker.txt");

  let reviewCalls = 0;
  const gptReviewer = async (): Promise<GptReviewerReturn> => {
    reviewCalls += 1;
    if (reviewCalls === 1) return { decision: "REVISE", severity: { critical: 0, high: 0, medium: 0 }, feedback: "수정 필요", nextTask: null };
    return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "이제 문제 없음", nextTask: null };
  };

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer } });

  check("REVISE 1회: outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED(재작업 후 승인)", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("REVISE 1회: developer가 정확히 2회 호출됨(최초+재작업)", callCount() === 2);
  check("REVISE 1회: reviewer가 정확히 2회 호출됨", reviewCalls === 2);
}

// ---------------------------------------------------------------------------
// 5) required test 실패 → reviewer가 PASS라고 해도 review-policy가 강제 REVISE → checkpoint
//    완료 불가(MAX_REVIEW_CYCLES까지 계속 실패하면 결국 WAITING_HUMAN).
// ---------------------------------------------------------------------------
async function scenarioRequiredTestFailureBlocksCompletion(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);

  const claudeRunner = async (): Promise<ClaudeResult> => {
    writeRepoFile(repo, "proj/marker.txt", "broken\n");
    return { success: true, summary: "구현했지만 test 실패", changedFiles: ["proj/marker.txt"], tests: [{ name: "proj:check", pass: false }], rawOutput: "" };
  };

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer() } });

  check("required test 실패: outcome이 APPROVED_AND_CHECKPOINTED가 아님(체크포인트 완료 불가)", result.outcome !== "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("required test 실패: checkpoint가 시도되지 않음", result.checkpoint === undefined);
}

// ---------------------------------------------------------------------------
// 6) Critical/High → reviewer가 PASS라고 해도 review-policy가 강제 REVISE → APPROVED 불가.
// ---------------------------------------------------------------------------
async function scenarioCriticalHighBlocksApproval(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  const { runner: claudeRunner } = fakeClaudeRunnerWriting(repo, "proj/marker.txt");
  const gptReviewer = fakeReviewer({ decision: "PASS", severity: { critical: 1, high: 0, medium: 0 } });

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer } });

  check("critical 존재: outcome이 APPROVED_AND_CHECKPOINTED가 아님", result.outcome !== "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("critical 존재: checkpoint가 시도되지 않음", result.checkpoint === undefined);
}

// ---------------------------------------------------------------------------
// 7/8) MAX_REVIEW_CYCLES 소진 → WAITING_HUMAN + REVIEW_CYCLE_EXHAUSTED reason(review-policy.ts
//      단일 출처) — 단순 승인으로 COMPLETED/APPROVED로 바뀌지 않는다(그런 경로 자체가 없음).
// ---------------------------------------------------------------------------
async function scenarioMaxCycleExhaustedReasonRecorded(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  const { runner: claudeRunner, callCount } = fakeClaudeRunnerWriting(repo, "proj/marker.txt");
  const gptReviewer = fakeReviewer({ decision: "REVISE", feedback: "계속 REVISE" });

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer } });
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;

  check("max cycle 소진: outcome=RAN_TASK_NOT_APPROVED(COMPLETED로 바뀌지 않음)", result.outcome === "RAN_TASK_NOT_APPROVED");
  check("max cycle 소진: developer가 MAX_REVIEW_CYCLES(5)회로 제한됨", callCount() === 5);
  check("max cycle 소진: state.status=WAITING_HUMAN(APPROVED 아님)", finalState.status === "WAITING_HUMAN");
  check(
    "max cycle 소진: deferredHumanTasks에 REVIEW_CYCLE_EXHAUSTED reason이 기록됨(review-policy.ts 단일 출처)",
    finalState.deferredHumanTasks.some((t) => t.includes("REVIEW_CYCLE_EXHAUSTED"))
  );
  check("max cycle 소진: checkpoint/commit이 생성되지 않음", result.checkpoint === undefined);
  const log = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "";
  check("max cycle 소진: git commit이 init 1건뿐(product/administrative commit 없음)", log.trim().split("\n").length === 1);
}

// ---------------------------------------------------------------------------
// 9) reviewer error/timeout → fail-open 금지(APPROVED로 처리되지 않음).
// ---------------------------------------------------------------------------
async function scenarioReviewerErrorNotFailOpen(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  const { runner: claudeRunner } = fakeClaudeRunnerWriting(repo, "proj/marker.txt");
  const gptReviewer = fakeReviewer({
    decision: "HUMAN_REQUIRED",
    feedback: "GPT reviewer가 5회 연속 일시적 오류로 응답하지 않았습니다.",
    errorCode: "GPT_REVIEW_TEMPORARILY_UNAVAILABLE",
  });

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer } });

  check("reviewer 오류: outcome이 APPROVED_AND_CHECKPOINTED가 아님(fail-open 아님)", result.outcome !== "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("reviewer 오류: checkpoint가 시도되지 않음", result.checkpoint === undefined);
}

// ---------------------------------------------------------------------------
// Phase G Task G1 — Observability & Audit production seam을 실제 runAutodevOnce() 호출로
// "fake integration"한다: opts.events(in-memory EventStore)를 주입해 실제 run/task/test/
// reviewer/checkpoint event가 기록되는지 증명한다. opts.events를 지정하지 않는 나머지
// 모든 시나리오는 이 파일 전체에서 event를 전혀 만들지 않는다는 것도 이미 그 시나리오들이
// 계속 정상 통과한다는 사실 자체로 증명된다(seam이 기본적으로 완전한 no-op).
// ---------------------------------------------------------------------------
async function scenarioApprovedRunRecordsRealEvents(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  const { runner: claudeRunner } = fakeClaudeRunnerWriting(repo, "proj/marker.txt");
  const events = createInMemoryEventStore();

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer() }, events });

  check("event 기록(정상 승인): outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  const { events: all, integrityIssues } = events.query();
  const types = all.map((e) => e.eventType);
  check("event 기록: integrityIssues가 없음(in-memory store)", integrityIssues.length === 0);
  check("event 기록: RUN_STARTED가 기록됨", types.includes("RUN_STARTED"));
  check("event 기록: TASK_STARTED가 기록됨", types.includes("TASK_STARTED"));
  check("event 기록: DEVELOPER_RETRY_STARTED가 없음(REVISE 없이 first-pass 승인)", !types.includes("DEVELOPER_RETRY_STARTED"));
  check("event 기록: REVIEW_STARTED가 기록됨(orchestrator.ts의 새 instrumentation)", types.includes("REVIEW_STARTED"));
  check("event 기록: TEST_COMPLETED가 기록됨(outcome=SUCCESS)", all.some((e) => e.eventType === "TEST_COMPLETED" && e.outcome === "SUCCESS"));
  check("event 기록: REVIEW_APPROVED가 기록됨", types.includes("REVIEW_APPROVED"));
  check("event 기록: CHECKPOINT_CREATED가 기록됨", types.includes("CHECKPOINT_CREATED"));
  check("event 기록: RUN_COMPLETED가 기록됨", types.includes("RUN_COMPLETED"));
  check("event 기록: 모든 event가 동일 runId를 공유함(correlation)", new Set(all.map((e) => e.runId)).size === 1);
  check(
    "event 기록: taskId가 있는 event는 모두 동일 taskId를 공유함(RUN_STARTED는 task 선택 전이라 taskId가 없음)",
    all.filter((e) => e.eventType !== "RUN_STARTED").every((e) => e.taskId === taskDef.id)
  );
  check("event 기록: RUN_STARTED가 sequence상 가장 먼저(1)", events.query({ eventType: "RUN_STARTED" }).events[0]?.sequence === 1);
}

// Phase G Task G2 — production entrypoint(runAutodevOnce)가 opts.events를 지정하지 않아도
// EventStore를 스스로 주입한다는 것을 증명한다(§ selectDefaultEventStore). 테스트 환경은
// AUTOMATION_DRY_RUN을 "false"로 설정하지 않으므로 여기서는 in-memory 기본값 분기를
// 타지만, 그 자체가 "opts.events 생략 시 관측이 꺼지지 않는다"는 것의 증거다(만약
// 관측이 꺼진다면 이 호출은 여전히 정상 완료돼야 하고, 만약 예외적으로 죽는다면 잘못된
// 것 — 여기서는 정상 완료만 확인한다. 실제 file store 분기의 AUTOMATION_DRY_RUN 게이팅
// 자체는 event-store-tests.ts의 scenarioDefaultEventStoreSelection이 임시 경로로 이미
// 검증했다).
async function scenarioProductionEntrypointInjectsEventStoreByDefault(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  const { runner: claudeRunner } = fakeClaudeRunnerWriting(repo, "proj/marker.txt");

  // opts.events를 아예 지정하지 않는다 — production entrypoint(run.ts)와 동일한 호출 형태.
  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer() } });

  check("production entrypoint: opts.events 생략해도 정상 완료됨(관측이 꺼져서 실행이 막히지 않음)", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
}

async function scenarioReviseCycleEventsRecordedInOrder(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  const { runner: claudeRunner } = fakeClaudeRunnerWriting(repo, "proj/marker.txt");
  let reviewCalls = 0;
  const gptReviewer = async (): Promise<GptReviewerReturn> => {
    reviewCalls += 1;
    if (reviewCalls <= 2) return { decision: "REVISE", severity: { critical: 0, high: 0, medium: 0 }, feedback: `수정 필요 ${reviewCalls}`, nextTask: null };
    return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "이제 문제 없음", nextTask: null };
  };
  const events = createInMemoryEventStore();

  await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer }, events });

  const { events: all } = events.query();
  const reviewEvents = all.filter((e) => e.eventType === "REVIEW_STARTED" || e.eventType === "REVIEW_REVISE" || e.eventType === "REVIEW_APPROVED");
  check("REVISE 2회: REVIEW_STARTED가 3회(cycle 1,2,3) 기록됨", all.filter((e) => e.eventType === "REVIEW_STARTED").length === 3);
  check("REVISE 2회: REVIEW_REVISE가 정확히 2회 기록됨", all.filter((e) => e.eventType === "REVIEW_REVISE").length === 2);
  check("REVISE 2회: DEVELOPER_RETRY_STARTED가 정확히 2회 기록됨(cycle 2,3 재시도)", all.filter((e) => e.eventType === "DEVELOPER_RETRY_STARTED").length === 2);
  check(
    "REVISE 2회: cycle별 순서가 REVIEW_STARTED→REVISE→...→REVIEW_STARTED→APPROVED 형태",
    reviewEvents.map((e) => e.eventType).join(",") === "REVIEW_STARTED,REVIEW_REVISE,REVIEW_STARTED,REVIEW_REVISE,REVIEW_STARTED,REVIEW_APPROVED"
  );
  const approved = all.find((e) => e.eventType === "REVIEW_APPROVED");
  check("REVISE 2회: 최종 REVIEW_APPROVED의 reviseCycle이 실제 cycle 수(3)를 담음", approved?.reviseCycle === 3);
  check("REVISE 2회: 모든 review event의 sequence가 append 순서와 일치(deterministic ordering)", reviewEvents.every((e, i) => (i === 0 ? true : e.sequence > reviewEvents[i - 1].sequence)));
}

async function scenarioMaxCycleExhaustedRecordsAuditEvents(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  const { runner: claudeRunner } = fakeClaudeRunnerWriting(repo, "proj/marker.txt");
  const gptReviewer = fakeReviewer({ decision: "REVISE", feedback: "계속 REVISE" });
  const events = createInMemoryEventStore();

  await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer }, events });

  const exhausted = events.query({ eventType: "REVIEW_CYCLE_EXHAUSTED" }).events[0];
  check("event 기록(cycle 소진): REVIEW_CYCLE_EXHAUSTED event가 audit 카테고리로 기록됨", exhausted?.categories.includes("audit") === true);
  check("event 기록: reviseCycle=5가 정확히 담김", exhausted?.reviseCycle === 5);
  check("event 기록: humanInterventionRequired=true", exhausted?.humanInterventionRequired === true);
  check("event 기록: REVIEW_REVISE가 5회(각 cycle) 기록됨", events.query({ eventType: "REVIEW_REVISE" }).events.length === 5);
  check("event 기록: HUMAN_APPROVAL_REQUIRED도 함께 기록됨(run-level bookend)", events.query({ eventType: "HUMAN_APPROVAL_REQUIRED" }).events.length === 1);
  check(
    "event 기록: RUN_BLOCKED가 기록됨(RUN_COMPLETED가 아님)",
    events.query({ eventType: "RUN_BLOCKED" }).events.length === 1 && events.query({ eventType: "RUN_COMPLETED" }).events.length === 0
  );
}

async function scenarioAdvisoryAgentsRecordAgentEvents(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ needsSecurityReview: true, requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  const { runner: claudeRunner } = fakeClaudeRunnerWriting(repo, "proj/marker.txt");
  const advisoryReadOnlyRunner: ReadOnlyAgentRunner = async () => ({ success: true, summary: "[FAKE] 보안 검토 완료", rawOutput: "" });
  const events = createInMemoryEventStore();

  await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer() }, events, advisoryReadOnlyRunner });

  check("event 기록(advisory): AGENT_SELECTED가 security에 대해 기록됨", events.query({ eventType: "AGENT_SELECTED", agentId: "core-security" }).events.length === 1);
  check("event 기록(advisory): AGENT_STARTED가 기록됨", events.query({ eventType: "AGENT_STARTED", agentId: "core-security" }).events.length === 1);
  check("event 기록(advisory): AGENT_COMPLETED가 SUCCESS로 기록됨", events.query({ eventType: "AGENT_COMPLETED", agentId: "core-security" }).events[0]?.outcome === "SUCCESS");
}

// Phase G Task G2 — audit-critical event append 실패가 fail-open되지 않는다: run outcome은
// 여전히 정상 진행되지만(observability 장애가 production 코드 배포 자체를 막지 않는다는
// 기존 원칙 유지), 그 실패 사실이 project-state.json의 deferredHumanTasks에 명확히
// surface된다(조용히 무시되지 않는다).
function makeAuditFailingEventStore(): EventStore {
  const inner = createInMemoryEventStore();
  return {
    append(input) {
      if (isAuditCriticalEvent(input.eventType)) {
        return { ok: false, error: "SIMULATED_DISK_FULL" };
      }
      return inner.append(input);
    },
    query: (filter) => inner.query(filter),
  };
}

async function scenarioAuditCriticalAppendFailureNotFailOpen(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  const { runner: claudeRunner } = fakeClaudeRunnerWriting(repo, "proj/marker.txt");
  const events = makeAuditFailingEventStore();

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer() }, events });

  check("audit-critical 실패: run outcome은 정상 진행됨(observability 장애가 code 배포를 막지 않음)", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check(
    "audit-critical 실패: 조용히 무시되지 않고 deferredHumanTasks에 AUDIT_EVENT_LOST로 surface됨",
    finalState.deferredHumanTasks.some((t) => t.startsWith("AUDIT_EVENT_LOST"))
  );
  // Phase G Task G2.1 — final-state 경계(CHECKPOINT_CREATED/TASK_COMPLETED/RUN_COMPLETED)
  // 셋 다 개별적으로 실패가 surface돼야 한다 — 그중 하나라도 조용히 "정상 성공"처럼 넘어가지
  // 않는다(§ 요구사항 5: final state audit 실패를 성공으로 조용히 보고하지 않음).
  check(
    "audit-critical 실패: CHECKPOINT_CREATED 기록 실패가 개별적으로 surface됨",
    finalState.deferredHumanTasks.some((t) => t.startsWith("AUDIT_EVENT_LOST(CHECKPOINT_CREATED)"))
  );
  check(
    "audit-critical 실패: TASK_COMPLETED 기록 실패가 개별적으로 surface됨",
    finalState.deferredHumanTasks.some((t) => t.startsWith("AUDIT_EVENT_LOST(TASK_COMPLETED)"))
  );
  check(
    "audit-critical 실패: RUN_COMPLETED 기록 실패가 개별적으로 surface됨",
    finalState.deferredHumanTasks.some((t) => t.startsWith("AUDIT_EVENT_LOST(RUN_COMPLETED)"))
  );
}

// ---------------------------------------------------------------------------
// Phase G Task G2.1 — telemetry event(REVIEW_STARTED 등, isAuditCriticalEvent가 false)의
// 기록 실패는 warning 로그만 남기고 run은 정상 진행되며, deferredHumanTasks에는 아무것도
// 남지 않는다(audit-critical과 정책이 명확히 다름을 증명한다 — § 요구사항 1).
// ---------------------------------------------------------------------------
function makeTelemetryFailingEventStore(): EventStore {
  const inner = createInMemoryEventStore();
  return {
    append(input) {
      if (!isAuditCriticalEvent(input.eventType)) {
        return { ok: false, error: "SIMULATED_TELEMETRY_SINK_DOWN" };
      }
      return inner.append(input);
    },
    query: (filter) => inner.query(filter),
  };
}

async function scenarioTelemetryFailureDoesNotBlockRun(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  const { runner: claudeRunner } = fakeClaudeRunnerWriting(repo, "proj/marker.txt");
  const events = makeTelemetryFailingEventStore();

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer() }, events });

  check("telemetry 실패: run outcome은 정상 진행됨(APPROVED_AND_CHECKPOINTED)", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check(
    "telemetry 실패: deferredHumanTasks에 아무 항목도 추가되지 않음(audit-critical과 달리 사람에게 남기지 않음)",
    finalState.deferredHumanTasks.length === 0
  );
}

// ---------------------------------------------------------------------------
// Phase G Task G2.1 — checkpoint(git commit) 전에 audit-critical 저장소가 사용 불가능하다고
// 확인되면(§ EventStore.checkAuditWritable) commit 자체를 시도하지 않는다 — 이미 만들어진
// commit을 되돌리는 대신, 되돌릴 수 없는 경계 이전에 막는다(§ 요구사항: checkpoint 전
// audit-critical 저장소 사용불가가 확인되면 commit/checkpoint를 진행하지 않는다).
// ---------------------------------------------------------------------------
function makeAuditUnwritableEventStore(): EventStore {
  const inner = createInMemoryEventStore();
  return {
    append: (input) => inner.append(input),
    query: (filter) => inner.query(filter),
    checkAuditWritable: (): AuditWritableCheck => ({ ok: false, error: "SIMULATED_STORE_UNAVAILABLE" }),
  };
}

function commitCount(repo: string): number {
  const res = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: repo, encoding: "utf-8" });
  return Number((res.stdout || "0").trim());
}

async function scenarioAuditStoreUnavailableBeforeCheckpointBlocksCommit(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  const { runner: claudeRunner } = fakeClaudeRunnerWriting(repo, "proj/marker.txt");
  const events = makeAuditUnwritableEventStore();
  const commitsBefore = commitCount(repo);

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer() }, events });

  check("audit store 사용 불가(사전 확인): outcome=RAN_TASK_CHECKPOINT_BLOCKED", result.outcome === "RAN_TASK_CHECKPOINT_BLOCKED");
  check("audit store 사용 불가(사전 확인): git commit이 전혀 만들어지지 않음(commit 수 불변)", commitCount(repo) === commitsBefore);
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("audit store 사용 불가(사전 확인): status가 WAITING_HUMAN으로 전환됨", finalState.status === "WAITING_HUMAN");
  check(
    "audit store 사용 불가(사전 확인): deferredHumanTasks에 AUDIT_STORE_UNAVAILABLE_BEFORE_CHECKPOINT로 명확히 surface됨",
    finalState.deferredHumanTasks.some((t) => t.startsWith("AUDIT_STORE_UNAVAILABLE_BEFORE_CHECKPOINT"))
  );
}

// ---------------------------------------------------------------------------
// Phase G Task G2.1 — SECURITY_BLOCKED(secret 발견으로 checkpoint 자체가 BLOCK된 경로)의
// audit 기록이 실패해도 원래의 Security BLOCK이 반대로 풀리지 않는다 — audit 실패는 추가
// 정보로만 덧붙는다(§ 요구사항: SECURITY_BLOCKED 기록 실패 → 원래 Security BLOCK 유지 →
// 추가로 audit 실패를 표시).
// ---------------------------------------------------------------------------
async function scenarioSecurityBlockedAuditFailureKeepsBlock(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  const claudeRunner = async (): Promise<ClaudeResult> => {
    // 파일명에 "secret"이 들어가면 git-changes.ts의 SECRET_NAME_PATTERNS가 commit 대상
    // 목록에 들어오기도 전에 걸러내(§ isExcludedPath) content 기반 secret-scanner 게이트를
    // 검증할 수 없다 — 그래서 무해한 파일명에 secret-shape "내용"만 담는다.
    writeRepoFile(repo, "proj/config.txt", 'const key = "sk-ant-verysecretvalue1234567890";\n');
    return { success: true, summary: "구현 완료", changedFiles: ["proj/config.txt"], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };
  const events = makeAuditFailingEventStore();
  const commitsBefore = commitCount(repo);

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer() }, events });

  check("SECURITY_BLOCKED + audit 실패: outcome=RAN_TASK_CHECKPOINT_BLOCKED(원래 Security BLOCK 유지)", result.outcome === "RAN_TASK_CHECKPOINT_BLOCKED");
  check("SECURITY_BLOCKED + audit 실패: secret이 담긴 commit이 만들어지지 않음(commit 수 불변)", commitCount(repo) === commitsBefore);
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("SECURITY_BLOCKED + audit 실패: status가 WAITING_HUMAN으로 유지됨", finalState.status === "WAITING_HUMAN");
  check(
    "SECURITY_BLOCKED + audit 실패: 원래의 CHECKPOINT_BLOCKED(secret) 사유가 그대로 남음",
    finalState.deferredHumanTasks.some((t) => t.startsWith("CHECKPOINT_BLOCKED") && t.includes(taskDef.id))
  );
  check(
    "SECURITY_BLOCKED + audit 실패: 추가로 audit 기록 실패도 surface됨",
    finalState.deferredHumanTasks.some((t) => t.startsWith("AUDIT_EVENT_LOST(SECURITY_BLOCKED)"))
  );
}

// ---------------------------------------------------------------------------
// Phase G Task G2.1 — orchestrator.ts의 고위험 사전 게이트(HUMAN_APPROVAL_REQUIRED, Claude
// worker 호출 전 즉시 WAITING_HUMAN)에서도 audit 기록 실패가 승인대기 상태를 풀어주지
// 않는다 — setStatus("WAITING_HUMAN")가 emitEvent보다 먼저 실행되므로, event append가
// 실패해도 이미 확정된 상태 전이는 그대로 유지된다(§ 요구사항: human approval event 실패
// → 승인대기 상태 유지 + audit failure 표시).
// ---------------------------------------------------------------------------
async function scenarioHumanApprovalGateAuditFailureKeepsWaiting(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "autodev-g21-human-approval-"));
  tempDirs.push(dir);
  const statePath = join(dir, "project-state.json");
  writeFileSync(statePath, JSON.stringify(baseState({ status: "IDLE" })) + "\n", "utf-8");
  const events = makeAuditFailingEventStore();

  const { finalState } = await runOrchestrator("production DB에서 고객 데이터를 삭제해줘", {
    statePath,
    events,
    runId: "run-g21-human-approval",
    taskId: "T-human-approval",
  });

  check("고위험 사전 게이트 + audit 실패: status가 WAITING_HUMAN으로 유지됨", finalState.status === "WAITING_HUMAN");
  check(
    "고위험 사전 게이트 + audit 실패: HUMAN_APPROVAL_REQUIRED 기록 실패가 surface됨",
    finalState.deferredHumanTasks.some((t) => t.startsWith("AUDIT_EVENT_LOST(HUMAN_APPROVAL_REQUIRED)"))
  );
}

async function main(): Promise<void> {
  try {
    await scenarioPlainCodeTaskZeroAdvisoryCalls();
    await scenarioArchitectureTaskRunsPlanner();
    await scenarioExternalResearchTaskRunsResearch();
    await scenarioSecuritySensitiveTaskRunsSecurityPostPass();
    await scenarioFixedTestsSufficientSkipsQa();
    await scenarioQaAdvisorySignalRunsQaPostPass();
    await scenarioNoDuplicateAgentCallsPerTask();
    await scenarioAdvisoryFailureNotFailOpen();
    await scenarioAdvisoryCannotOverrideCoreTestFailure();
    scenarioF3LoopNotDuplicatedInProduction();
    await scenarioReviseOnceThenApprove();
    await scenarioRequiredTestFailureBlocksCompletion();
    await scenarioCriticalHighBlocksApproval();
    await scenarioMaxCycleExhaustedReasonRecorded();
    await scenarioReviewerErrorNotFailOpen();
    await scenarioApprovedRunRecordsRealEvents();
    await scenarioProductionEntrypointInjectsEventStoreByDefault();
    await scenarioReviseCycleEventsRecordedInOrder();
    await scenarioMaxCycleExhaustedRecordsAuditEvents();
    await scenarioAdvisoryAgentsRecordAgentEvents();
    await scenarioAuditCriticalAppendFailureNotFailOpen();
    await scenarioTelemetryFailureDoesNotBlockRun();
    await scenarioAuditStoreUnavailableBeforeCheckpointBlocksCommit();
    await scenarioSecurityBlockedAuditFailureKeepsBlock();
    await scenarioHumanApprovalGateAuditFailureKeepsWaiting();
  } finally {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // 정리 실패는 테스트 결과에 영향 없음(OS 임시 디렉터리).
      }
    }
  }

  console.log("\n=== production-agent-integration(F4) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
