import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runAutodevOnce, runAdvisoryAgents } from "./autodev";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import type { ProjectState, ClaudeResult } from "./types";
import type { GptReviewerReturn } from "./orchestrator";
import type { ReadOnlyAgentRunner } from "./agent-orchestrator";

// Production Pipeline Integration & Review Policy 단일화 테스트(Phase F Task F4). 실제
// Claude/GPT 유료 API를 전혀 호출하지 않는다 — claudeRunner/gptReviewer/advisoryReadOnlyRunner는
// 항상 fake로 주입한다. MOVAN product task도 실행하지 않는다.
//
// 이 파일이 검증하는 것: (1) F1 routeTask() + F2 executeRoutingPlan()이 runAutodevOnce()의
// 실제 production 경로에서 진짜로 호출되는지(§ runAdvisoryAgents), (2) developer/reviewer/
// REVISE/checkpoint의 핵심 순서와 판정은 여전히 기존 orchestrator.ts/checkpoint.ts가
// 전담하고 F4가 이를 대체하지 않는지, (3) review-policy.ts로 단일화된 판정(critical/high,
// required test 실패, MAX_REVIEW_CYCLES 소진)이 production 경로에서도 동일하게 적용되는지.
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

// ---------------------------------------------------------------------------
// 1) F1 routeTask() + F2 executeRoutingPlan()이 실제로 production 경로에서 호출됨을
//    runAdvisoryAgents()로 직접 증명한다 — task-registry task는 항상 code_implementation
//    으로 취급되므로(§ RoutableTaskInput의 "구조화된 정보가 텍스트 분류보다 우선한다"는
//    설계를 그대로 따름), developer에 의존하지 않는 role은 이 sub-plan에 없다(qa만 존재
//    가능하고 developer 의존성 때문에 항상 SKIPPED) — 이는 버그가 아니라 F1의 dependency
//    선언을 그대로 따른 것임을 증명한다.
// ---------------------------------------------------------------------------
async function scenarioAdvisoryPipelineGenuinelyInvoked(): Promise<void> {
  const noFixedTests = makeTaskDef({ requiredTests: [] });
  const { routingPlan, agentAdvisory } = await runAdvisoryAgents(noFixedTests, undefined);
  check("advisory 파이프라인: F1 routing이 실제로 계산됨(steps 존재)", routingPlan.steps.length > 0);
  check("advisory 파이프라인: hasFixedRequiredTests=false면 qa가 routing에 포함됨", routingPlan.steps.some((s) => s.role === "qa"));
  check(
    "advisory 파이프라인: qa는 developer 의존성 미충족으로 자동 SKIPPED — agentAdvisory는 비어있음(실제 Agent 호출 0회)",
    agentAdvisory === undefined
  );

  const fixedTests = makeTaskDef({ requiredTests: [{ name: "t", command: "node", args: [], cwd: "root" }] });
  const { routingPlan: plan2 } = await runAdvisoryAgents(fixedTests, undefined);
  check("advisory 파이프라인: hasFixedRequiredTests=true면 qa가 routing에서 아예 제외됨", !plan2.steps.some((s) => s.role === "qa"));
  check("advisory 파이프라인: developer/reviewer만 routing됨", plan2.steps.map((s) => s.role).sort().join(",") === "developer,reviewer");
}

// ---------------------------------------------------------------------------
// 2) high-risk task는 advisory 파이프라인 자체가 실행되지 않음(routeTask 분류와 무관하게
//    어떤 read-only runner도 호출되지 않음) — 기존 human gate와 동일한 원칙.
// ---------------------------------------------------------------------------
async function scenarioHighRiskSkipsAdvisoryEntirely(): Promise<void> {
  let calls = 0;
  const runner: ReadOnlyAgentRunner = async () => {
    calls += 1;
    return { success: true, summary: "should not be called", rawOutput: "" };
  };
  const highRisk = makeTaskDef({ prompt: "production DB에서 데이터를 삭제해줘", requiredTests: [] });
  const { routingPlan, agentAdvisory } = await runAdvisoryAgents(highRisk, runner);
  check("high-risk task: routingPlan.requiresHumanApproval=true", routingPlan.requiresHumanApproval === true);
  check("high-risk task: agentAdvisory가 없음(advisory 실행 자체가 스킵됨)", agentAdvisory === undefined);
  check("high-risk task: read-only runner가 전혀 호출되지 않음", calls === 0);
}

// ---------------------------------------------------------------------------
// 3) code task → production runAutodevOnce의 first-pass APPROVED 경로(developer/reviewer
//    만 실제 실행, agentAdvisory 없음).
// ---------------------------------------------------------------------------
async function scenarioFirstPassApprovedNoAdvisory(): Promise<void> {
  const repo = makeTempGitRepo();
  const taskDef = makeTaskDef({ requiredTests: [{ name: "proj:check", command: "node", args: [], cwd: "root" }] });
  const statePath = makeTempStateFile(repo);
  const manifest = buildManifest(repo, statePath, [taskDef]);
  const { runner: claudeRunner, callCount } = fakeClaudeRunnerWriting(repo, "proj/marker.txt");

  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakeReviewer() } });

  check("first-pass: outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("first-pass: developer가 정확히 1회 호출됨", callCount() === 1);
  check("first-pass: agentAdvisory가 없음(developer/reviewer만 필요했음)", result.agentAdvisory === undefined);
}

// ---------------------------------------------------------------------------
// 4) REVISE 1회 → developer 재실행(orchestrator.ts의 기존 REVISE 루프, F4가 대체하지 않음).
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

async function main(): Promise<void> {
  try {
    await scenarioAdvisoryPipelineGenuinelyInvoked();
    await scenarioHighRiskSkipsAdvisoryEntirely();
    await scenarioFirstPassApprovedNoAdvisory();
    await scenarioReviseOnceThenApprove();
    await scenarioRequiredTestFailureBlocksCompletion();
    await scenarioCriticalHighBlocksApproval();
    await scenarioMaxCycleExhaustedReasonRecorded();
    await scenarioReviewerErrorNotFailOpen();
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
