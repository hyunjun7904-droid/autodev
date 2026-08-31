import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runAutodevOnce, runPreDevelopmentAdvisory, runPostDevelopmentAdvisory } from "./autodev";
import { runOrchestrator, MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT } from "./orchestrator";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import type { ProjectState, ClaudeResult } from "./types";
import type { GptReviewerReturn } from "./orchestrator";
import type { ReadOnlyAgentRunner } from "./agent-orchestrator";
import { createInMemoryEventStore } from "./event-store";
import type { EventStore, AuditWritableCheck } from "./event-store";
import { isAuditCriticalEvent } from "./observability-event";
import { deriveAllowedCommandsFromRequiredTests } from "./execution-contract";

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
    // Hardening A(Execution Contract를 Runtime 불변조건으로) — 실제 spec-planner.ts가
    // 생성하는 manifest는 항상 deriveAllowedCommandsFromRequiredTests()로 allowedCommands를
    // requiredTests와 exact-match하게 파생시킨다(§ execution-contract.ts). FIXTURE_EXECUTION_POLICY의
    // 정적 allowedCommands=[]는 그 실제 생성 결과를 흉내내지 못해 autodev.ts의 runtime
    // execution-contract 재검증에 매번 걸린다 — 이 registry의 실제 requiredTests로부터 매번
    // 파생시켜 그 재검증이 정상 통과하게 한다.
    executionPolicy: { ...FIXTURE_EXECUTION_POLICY, allowedCommands: deriveAllowedCommandsFromRequiredTests(taskRegistry.map((t) => ({ taskId: t.id, requiredTests: t.requiredTests }))) },
  };
}

function fakeReviewer(
  overrides: Partial<GptReviewerReturn> = {}
): (result: ClaudeResult, reviewCycle: number, task: string, allowedPathPrefixes?: string[]) => Promise<GptReviewerReturn> {
  return async () => ({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "테스트: 문제 없음", nextTask: null, ...overrides });
}

function fakeClaudeRunnerWriting(repo: string, path: string, tests: ClaudeResult["tests"] = [{ name: "proj:check", pass: true }]) {
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

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer(), sleep: async () => {}, now: () => Date.now() }, advisoryReadOnlyRunner });

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
    orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer(), sleep: async () => {}, now: () => Date.now() },
    advisoryReadOnlyRunner: failingAdvisoryRunner,
  });

  check("advisory 실패: outcome은 여전히 APPROVED_AND_CHECKPOINTED(advisory 실패가 checkpoint를 막지 않음)", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("advisory 실패: agentAdvisory에 security의 FAILED 상태가 정직하게 기록됨", result.agentAdvisory?.some((r) => r.role === "security" && r.status === "FAILED") === true);
}

// ---------------------------------------------------------------------------
// 9) Core required test 실패를 advisory(qa/security)가 "문제 없다"고 낙관 보고해도
//    덮어쓰지 못한다 — 최종 판정은 여전히 review-policy.ts(hasFailedRequiredTest)가 결정.
// ---------------------------------------------------------------------------
// AutoDev Efficiency / Review Stagnation Hardening(2026-08-28) — 이 시나리오의 claudeRunner는
// required test가 절대 통과하지 않도록 의도적으로 고정돼 있다(§ 이 시나리오의 원래 목적:
// "advisory가 낙관적으로 보고해도 Core test 실패를 뒤집을 수 없다"). REVIEW_CYCLE_EXHAUSTED가
// 더 이상 WAITING_HUMAN으로 끝나지 않고 durable하게 재시도하도록 바뀐 뒤로도(§
// root-cause-analysis.ts/orchestrator.ts, 같은 세션의 정책 수정) 이 fixture는 결국 끝난다 —
// 이 정책 수정과 무관한 기존 비용 안전장치 MAX_GPT_CALLS(10, orchestrator.ts)가 여전히
// genuine WAITING_HUMAN으로 이어지기 때문이다(§ scenarioMaxCycleExhaustedRecordsAuditEvents와
// 동일한 원리). sleep을 fake로 주입해 그 10회 호출이 실제 대기 없이 빠르게 일어나게 한다.
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
    orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer(), sleep: async () => {}, now: () => Date.now() },
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

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer(), sleep: async () => {}, now: () => Date.now() } });

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

  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner, gptReviewer, sleep: async () => {}, now: () => Date.now() },
  });

  check("critical 존재: outcome이 APPROVED_AND_CHECKPOINTED가 아님", result.outcome !== "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("critical 존재: checkpoint가 시도되지 않음", result.checkpoint === undefined);
}

// ---------------------------------------------------------------------------
// 7/8) MAX_REVIEW_CYCLES 소진 → AutoDev Efficiency / Review Stagnation Hardening(2026-08-28
//      정책 수정) 이후: 더 이상 genuine WAITING_HUMAN이 아니다. developerProviderWaitCount와
//      동일한 durable wait-then-retry(재시도 횟수 무제한, 간격만 bounded)로 전환해 reviewCycle
//      예산을 리셋하고 계속 진행한다 — review가 결국 수렴하면(§ 이 fake reviewer가 6번째
//      호출부터 PASS로 전환) 정상적으로 APPROVED + checkpoint까지 도달해야 한다(사람 승인 없이).
// ---------------------------------------------------------------------------
async function scenarioMaxCycleExhaustionDurableRetryNotWaitingHuman(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  const { runner: claudeRunner, callCount } = fakeClaudeRunnerWriting(repo, "proj/marker.txt");
  // 처음 MAX_REVIEW_CYCLES(5)회는 REVISE로 소진시켜 durable wait 경로를 실제로 타게 하고,
  // 그 이후(reviewCycle이 리셋되어 다시 시작된 6번째 developer 호출)부터는 PASS로 전환해 이
  // task가 실제로 수렴/완료될 수 있음을 함께 증명한다.
  const gptReviewer = async (): Promise<GptReviewerReturn> =>
    callCount() <= 5
      ? { decision: "REVISE", severity: { critical: 0, high: 0, medium: 0 }, feedback: "계속 REVISE", nextTask: null }
      : { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "이제 통과", nextTask: null };

  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner, gptReviewer, sleep: async () => {}, now: () => Date.now() },
  });
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;

  check("max cycle 소진: developer가 5회를 넘어 계속 재시도됨(하드 컷오프 아님)", callCount() > 5);
  check("max cycle 소진: 결국 수렴하면 checkpoint까지 완료됨(사람 승인 없이)", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  // checkpoint 성공 후 state.status는(autodev.ts) 다음 task가 있으면 "READY"로, 이 fixture처럼
  // task가 이거 하나뿐이면(getNextTask가 null) PLAN_MARKERS.PROJECT_COMPLETE로 설정된다 —
  // "APPROVED"라는 문자열 값 자체는 이 필드에 존재하지 않는다(orchestrator 내부 finalState의
  // 필드 이름과 혼동하지 않는다). 이 fixture manifest는 task를 정확히 하나만 등록하므로
  // PROJECT_COMPLETE가 된다.
  check(
    "max cycle 소진: state.status=PROJECT_COMPLETE(WAITING_HUMAN 아님, checkpoint 성공 후 다음 task 없음)",
    finalState.status === "PROJECT_COMPLETE"
  );
  check(
    "max cycle 소진: reviewStagnationWaitCount가 최소 1회 이상 durable하게 기록됨",
    (finalState.reviewStagnationWaitCount ?? 0) >= 1
  );
  check(
    "max cycle 소진: deferredHumanTasks에 REVIEW_CYCLE_EXHAUSTED reason이 더 이상 기록되지 않음(Human Gate 아님)",
    !finalState.deferredHumanTasks.some((t) => t.includes("REVIEW_CYCLE_EXHAUSTED"))
  );
  const log = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "";
  check("max cycle 소진: product checkpoint commit이 실제로 생성됨", log.trim().split("\n").length > 1);
}

// ---------------------------------------------------------------------------
// P0-4/P1-2 하드닝(2026-08-30, 독립 감사) — 이전 정책(2026-08-30 이전 버전)은 이 시나리오를
// 위 7/8과 정반대 대조군으로 써서 "동일한 required test 실패가 결정론적으로 반복"되면
// genuine WAITING_HUMAN으로 승격해야 한다고 검증했다. 독립 감사에서 이것이 정책 위반으로
// 확인됐다 — "test failure/deterministic blocker"는 아무리 반복돼도 실제 사업적/보안적
// 판단이 필요한 게 아니다(§ CLAUDE.md P0-4, deterministic-simulation.ts Run B가 실제
// 재현). 이제 "다양한 이유"든 "같은 이유"든 REVIEW_CYCLE_EXHAUSTED는 항상 동일한 기술적
// durable wait-then-retry 경로를 타고(§ orchestrator.ts blockOnDurableWaitRetryExhausted),
// 그 durable wait 자체에 상한(MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT=5)이 있어 terminal
// 기술적 BLOCKED로 수렴한다(무한 반복은 아니되 genuine Human Gate도 아니다).
// ---------------------------------------------------------------------------
async function scenarioMaxCycleExhaustionWithDeterministicRepeatStaysTechnicalBlocked(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  // 매 attempt마다 완전히 동일한 실패(name/command/exitCode/stderrTail 전부 동일)를 반환한다
  // — computeFailureFingerprint가 매번 같은 값이 되어 stagnationTracker의 repeatCount가
  // 계속 증가한다(다양한 실패가 아니라 "같은" 실패) — 그래도 genuine으로 승격되지 않아야 한다.
  const { runner: claudeRunner, callCount } = fakeClaudeRunnerWriting(repo, "proj/marker.txt", [
    { name: "proj:check", pass: false, failureEvidence: { command: "node proj/check.mjs", exitCode: 1, stderrTail: "AssertionError: 항상 동일하게 실패" } },
  ]);
  const gptReviewer = fakeReviewer({ decision: "PASS" }); // REVISE는 오직 requiredTestsFailed override로만 발생.

  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner, gptReviewer, sleep: async () => {}, now: () => Date.now() },
  });
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;

  check(
    "결정론적 반복: developer 호출이 bounded됨(exhaustion마다 5 round × (MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT+1)회=30, 무한 반복 아님)",
    callCount() === 30
  );
  check("결정론적 반복: outcome이 APPROVED_AND_CHECKPOINTED가 아님", result.outcome !== "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check(
    "결정론적 반복: state.status=BLOCKED(genuine WAITING_HUMAN 아님 — Human Gate 0, 무한 반복도 아님)",
    (finalState.status as unknown as string) === "BLOCKED"
  );
  check(
    "결정론적 반복: deferredHumanTasks에 더 이상 DETERMINISTIC_REVIEW_CYCLE_EXHAUSTED 마커가 기록되지 않음(genuine 아님)",
    !finalState.deferredHumanTasks.some((t) => t.startsWith("DETERMINISTIC_REVIEW_CYCLE_EXHAUSTED:"))
  );
  check(
    "결정론적 반복: reviewStagnationWaitCount가 durable하게 증가함(기술적 backoff 경로를 탔으므로, 상한 초과로 BLOCKED)",
    (finalState.reviewStagnationWaitCount ?? 0) === MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT + 1
  );
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

  // 2026-08-28 정책 수정 — GPT_REVIEW_TEMPORARILY_UNAVAILABLE은 이제 orchestrator.ts가
  // 즉시 genuine WAITING_HUMAN으로 승격하지 않고 같은 diff로 durable하게 재리뷰를 반복한다
  // (실제 비용 안전장치 MAX_GPT_RAW_CALLS에 걸릴 때까지) — 이 fake reviewer는 항상 같은
  // 결과만 반환하므로 결국 그 안전장치로 멈추는 것은 동일하지만(아래 assertion 불변),
  // 실제 5분/15분/... 대기를 기다리면 테스트가 멈추므로 sleep/schedule을 fake로 override한다.
  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner, gptReviewer, sleep: async () => {}, developerProviderWaitScheduleMs: [1, 1, 1], developerProviderWaitCooldownMs: 1 },
  });

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

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer(), sleep: async () => {}, now: () => Date.now() }, events });

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
  // Phase G Task G7 — Project Lock event(PROJECT_LOCK_ACQUIRED/RELEASED)도 이 실행에서
  // 실제로 기록된다. task 선택 이전(acquire)/이후(state_update에서 release)에 일어나는
  // run-level event라 RUN_STARTED와 마찬가지로 taskId가 없다(§ 요구사항: lock은 project
  // 단위이지 task 단위가 아니다).
  check("event 기록: PROJECT_LOCK_ACQUIRED가 기록됨", types.includes("PROJECT_LOCK_ACQUIRED"));
  check("event 기록: PROJECT_LOCK_RELEASED가 기록됨(성공 후 release)", types.includes("PROJECT_LOCK_RELEASED"));
  check("event 기록: 모든 event가 동일 runId를 공유함(correlation)", new Set(all.map((e) => e.runId)).size === 1);
  const taskAgnosticEventTypes = new Set(["RUN_STARTED", "PROJECT_LOCK_ACQUIRED", "PROJECT_LOCK_RELEASED"]);
  check(
    "event 기록: taskId가 있는 event는 모두 동일 taskId를 공유함(RUN_STARTED/PROJECT_LOCK_*는 task 선택 전후라 taskId가 없음)",
    all.filter((e) => !taskAgnosticEventTypes.has(e.eventType)).every((e) => e.taskId === taskDef.id)
  );
  check(
    "event 기록: PROJECT_LOCK_ACQUIRED가 sequence상 가장 먼저(1), RUN_STARTED가 그 다음(2)",
    events.query({ eventType: "PROJECT_LOCK_ACQUIRED" }).events[0]?.sequence === 1 && events.query({ eventType: "RUN_STARTED" }).events[0]?.sequence === 2
  );
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
  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer(), sleep: async () => {}, now: () => Date.now() } });

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

  // AutoDev Efficiency / Review Stagnation Hardening(2026-08-28) — 이 fake reviewer는 항상
  // REVISE만 반환하므로, REVIEW_CYCLE_EXHAUSTED는 이제 durable wait-then-retry로 계속
  // 반복된다(사람에게 넘기지 않음). 이 run이 실제로 끝나는 지점은 비용 안전장치 MAX_GPT_CALLS
  // (10, orchestrator.ts)다 — reviewCycle이 MAX_REVIEW_CYCLES(5)마다 리셋되며 durable wait을
  // 2번 거친 뒤(gptCallCount 5, 10) 11번째 review 시도에서 gptCallCount>10으로 terminal
  // 기술적 BLOCKED가 된다(§ BLOCKER 3 재하드닝, 독립 최종 감사 2026-08-30 — 이전에는 여기서
  // genuine WAITING_HUMAN이었으나, "cap을 넘긴 뒤 terminal technical BLOCKED, Human Gate=0"
  // 요구사항에 따라 blockOnDurableWaitRetryExhausted와 동일한 원칙으로 바뀌었다). sleep을
  // 즉시 반환하도록 주입해 실제 대기 없이 테스트한다.
  await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer, sleep: async () => {}, now: () => Date.now() }, events });

  const exhaustedEvents = events.query({ eventType: "REVIEW_CYCLE_EXHAUSTED" }).events;
  const exhausted = exhaustedEvents[0];
  check("event 기록(cycle 소진): REVIEW_CYCLE_EXHAUSTED event가 audit 카테고리로 기록됨", exhausted?.categories.includes("audit") === true);
  check("event 기록: reviseCycle=5가 정확히 담김", exhausted?.reviseCycle === 5);
  check(
    "event 기록: humanInterventionRequired=false(더 이상 Human Gate가 아님, 2026-08-28 정책 수정)",
    exhausted?.humanInterventionRequired === false
  );
  check("event 기록: REVIEW_CYCLE_EXHAUSTED가 2회(사람에게 넘기지 않고 durable하게 재시도했으므로) 기록됨", exhaustedEvents.length === 2);
  check("event 기록: REVIEW_REVISE가 10회(두 번의 5-cycle 예산) 기록됨", events.query({ eventType: "REVIEW_REVISE" }).events.length === 10);
  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("event 기록: 결국 MAX_GPT_CALLS(비용 안전장치)로 terminal 기술적 BLOCKED에 도달", finalState.status === "BLOCKED");
  check(
    "event 기록: 그 BLOCKED는 REVIEW_CYCLE_EXHAUSTED가 아니라 MAX_GPT_CALLS 사유임(deferredHumanTasks에 REVIEW_CYCLE_EXHAUSTED 없음)",
    !finalState.deferredHumanTasks.some((t) => t.includes("REVIEW_CYCLE_EXHAUSTED"))
  );
  // § BLOCKER 3 재하드닝(독립 최종 감사, 2026-08-30) — MAX_GPT_CALLS 소진은 이제
  // blockOnDurableWaitRetryExhausted(developerProviderWaitCount/reviewerProviderWaitCount/
  // reviewStagnationWaitCount 소진)와 정확히 같은 원칙(state.status="BLOCKED")을 쓴다 — 사람의
  // "승인"으로 풀리는 문제가 아니라 근본 원인(REVISE가 계속 필요한 이유)을 사람이 직접
  // 고쳐야 하는 기술적 안전정지이기 때문이다(§ autodev.ts decideNextAction의 status==="BLOCKED"
  // STOP 분기 주석과 동일한 원칙). autodev.ts의 generic catch-all은 이제
  // finalState.status==="BLOCKED"일 때 이 event를 아예 만들지 않는다(§ 요구사항 "cap을 넘긴
  // 뒤 ... Human Gate = 0") — 이전 정책(genuine WAITING_HUMAN + Telegram 알림)은 독립 감사가
  // 지적한 "technical error → Human Gate" 오분류였다.
  check(
    "event 기록: MAX_GPT_CALLS로 인한 BLOCKED는 기술적이므로 generic HUMAN_APPROVAL_REQUIRED bookend가 생성되지 않음(Human Gate=0)",
    events.query({ eventType: "HUMAN_APPROVAL_REQUIRED" }).events.length === 0
  );
  check(
    "event 기록: RUN_BLOCKED가 기록됨(RUN_COMPLETED가 아님) — orchestrator.ts 자신의 RUN_BLOCKED(blockOnDurableWaitRetryExhausted와 동일 패턴) + autodev.ts의 generic RUN_BLOCKED(모든 non-APPROVED 종료에 항상 기록됨) 2건",
    events.query({ eventType: "RUN_BLOCKED" }).events.length === 2 && events.query({ eventType: "RUN_COMPLETED" }).events.length === 0
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

  await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer(), sleep: async () => {}, now: () => Date.now() }, events, advisoryReadOnlyRunner });

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

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer(), sleep: async () => {}, now: () => Date.now() }, events });

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

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer(), sleep: async () => {}, now: () => Date.now() }, events });

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

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer(), sleep: async () => {}, now: () => Date.now() }, events });

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

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer(), sleep: async () => {}, now: () => Date.now() }, events });

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
    await scenarioMaxCycleExhaustionDurableRetryNotWaitingHuman();
    await scenarioMaxCycleExhaustionWithDeterministicRepeatStaysTechnicalBlocked();
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
