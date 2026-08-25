import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { performAutoResume } from "./auto-resume";
import { runAutodevContinuous } from "./continuous-runner";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import type { ProjectState, ClaudeResult } from "./types";
import type { GptReviewerReturn } from "./orchestrator";
import type { ApprovalRequest } from "./approval";

// AUTODEV HUMAN RESUME + CONTINUOUS RUNNER REGRESSION 전용 통합 테스트.
//
// 이 파일은 auto-resume.ts(Safe Auto Resume)와 continuous-runner.ts(Generic Continuous
// Runner)가 각각 독립적으로 이미 검증된 것으로 가정한다(§ auto-resume-tests.ts/
// failure-resume-hardening-tests.ts/project-lock-integration-tests.ts/
// continuous-runner-tests.ts). 여기서는 그 둘의 경계 — "Telegram Human APPROVE →
// performAutoResume()가 실제로 몇 개의 task를 진행시키는가"와 "그 resume 경로가
// Remote Git Safety를 우회하지 않는가" — 만 새로 증명한다. 기존 테스트는 전부 1-task
// registry만 썼기 때문에 "resume이 다음 task까지 자동으로 이어가는지"를 구조적으로
// 증명할 수 없었다(§ Task Prompt 4-D). 실제 Claude CLI/OpenAI API/JARVIS는 전혀 호출하지
// 않는다 — orchestratorDeps는 항상 결정적 fake다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];

function makeTempGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "human-resume-continuous-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Human Resume Continuous Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}
function headHash(dir: string): string {
  return (spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).stdout || "").trim();
}
function branchName(dir: string): string {
  return (spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf-8" }).stdout || "").trim();
}
function gitLogCount(repo: string): number {
  return (spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "").split("\n").filter(Boolean).length;
}
function writeRepoFile(repo: string, relPath: string, content: string): void {
  const abs = join(repo, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
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

// 두 task짜리 registry — "resume이 T1만 끝내는지, T2까지 이어가는지"를 구조적으로
// 증명하려면 최소 2개가 필요하다(기존 auto-resume-tests.ts/failure-resume-hardening-tests.ts는
// 전부 1-task registry라 이 경계를 애초에 표현할 수 없었다).
const TWO_TASK_REGISTRY: TaskDefinition[] = [
  { id: "T1", phase: 1, taskNumber: 1, title: "Task1", prompt: "Task1 prompt", requiredTests: [], allowedPathPrefixes: ["proj/"], prohibitedOperations: [] },
  { id: "T2", phase: 1, taskNumber: 2, title: "Task2", prompt: "Task2 prompt", requiredTests: [], allowedPathPrefixes: ["proj/"], prohibitedOperations: [] },
];
const EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["proj/"],
  allowedWritePrefixes: ["proj/"],
  allowedCommands: [],
};
function buildManifest(root: string, statePath: string, overrides: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    projectId: "human-resume-continuous-fixture",
    projectName: "Human Resume Continuous Fixture",
    targetProjectRoot: root,
    statePath,
    taskRegistry: TWO_TASK_REGISTRY,
    developerInstructions: "허용 범위: proj/**만 다룹니다.",
    reviewInstructions: "proj/** 범위 밖 변경이 있으면 반드시 REVISE하세요.",
    reviewScopeDirs: ["proj/"],
    executionPolicy: EXECUTION_POLICY,
    ...overrides,
  };
}

function fakePassReviewer(): () => Promise<GptReviewerReturn> {
  return async () => ({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "테스트: 문제 없음", nextTask: null });
}
function makeMarkerClaudeRunner(repo: string, calls: string[]): (task: string) => Promise<ClaudeResult> {
  return async (task: string): Promise<ClaudeResult> => {
    calls.push(task);
    const fileName = `proj/marker-${calls.length}.txt`;
    writeRepoFile(repo, fileName, task);
    return { success: true, summary: `테스트: ${task} 완료`, changedFiles: [fileName], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };
}

function baseApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: "fixture-approval-id",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:30:00.000Z",
    runId: "run-1",
    taskId: "T1",
    approvalType: "ORCHESTRATOR_NOT_APPROVED_GENERIC",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: "fixture-source-event-id",
    status: "APPROVED",
    remotelyApprovable: true,
    requiresSafetyRecheck: true,
    dedupeKey: "dk-fixture",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// D) Human APPROVE -> performAutoResume()는 승인된 그 task 하나만 완료시키고 그친다 —
// registry에 남은 다음 runnable task(T2)를 이어서 실행하지 않는다. 이 정확한 동작
// (NEXT_TASK_BEHAVIOR=RESUME_SAME_TASK_THEN_STOP)을 증명하는 것이 이 시나리오의 목적이다.
// 그 다음, 완전히 별도의 새 runAutodevContinuous() 호출은 (같은 project-state 위에서)
// 정상적으로 T2를 이어서 완료할 수 있음을 보여 "resume 자체가 다음 task까지 자동으로
// 진행하지는 않지만, 그 이후의 fresh 실행이 이어받는 것을 막지도 않는다"를 함께 증명한다.
// ---------------------------------------------------------------------------
async function scenarioResumeCompletesOnlySameTaskThenStops(): Promise<void> {
  const repo = makeTempGitRepo("hrc-resume-boundary-");
  const statePath = makeTempStateFile(repo, { status: "WAITING_HUMAN", completedTasks: [] });
  const manifest = buildManifest(repo, statePath);

  const calls: string[] = [];
  const claudeRunner = makeMarkerClaudeRunner(repo, calls);
  const approval = baseApproval({ expectedGitHead: headHash(repo), expectedBranch: branchName(repo) });

  const outcome = await performAutoResume(approval, manifest, { orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check("D) performAutoResume 결과 kind=COMPLETED", outcome.kind === "COMPLETED");
  if (outcome.kind === "COMPLETED") {
    check("D) resume된 outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", outcome.result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
    check("D) resume된 taskId=T1(승인된 바로 그 task)", outcome.result.taskId === "T1");
  }
  check("D) developer가 정확히 1회만 호출됨(T1)", calls.length === 1 && calls[0] === "Task1 prompt");
  check("D) T2 prompt는 이 resume 호출 안에서 전혀 실행되지 않음", !calls.includes("Task2 prompt"));

  const stateAfterResume = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("D) completedTasks=[T1]만 존재(T2는 아직 미완료)", JSON.stringify(stateAfterResume.completedTasks) === JSON.stringify(["T1"]));
  check("D) checkpoint가 정확히 1회만 발생(commit 2건: product+admin, init 포함 총 3건)", gitLogCount(repo) === 3);

  // NEXT_TASK_BEHAVIOR 증명 — resume 호출 자체는 여기서 끝났다(추가 호출 없음). 이제
  // *완전히 별도의* 새 continuous 실행이 같은 project-state 위에서 T2를 정상적으로
  // 이어받는지 확인한다 — 이것이 continuous-runner.ts의 몫이지, performAutoResume()의
  // 책임이 아님을 구조적으로 보여준다.
  const continuousResult = await runAutodevContinuous({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });
  check("D) resume 이후 별도의 fresh continuous 실행은 T2를 정상적으로 이어서 완료함", continuousResult.iterations.some((it) => it.result.taskId === "T2" && it.result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED"));
  check("D) fresh continuous 실행에서 T1은 다시 실행되지 않음(중복 실행 없음)", calls.filter((c) => c === "Task1 prompt").length === 1);
  const stateAfterContinuous = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("D) 최종적으로 completedTasks=[T1,T2] 모두 완료됨", JSON.stringify(stateAfterContinuous.completedTasks) === JSON.stringify(["T1", "T2"]));
}

// ---------------------------------------------------------------------------
// I) Remote Git Safety — resume 시도 시점에 remote가 앞서 있으면(diverged) performAutoResume은
// STOP(BLOCKED)해야 하고, checkpoint/다음 task 실행이 전혀 없어야 한다. 추가로: 이 BLOCK이
// project-state.json을 "WAITING_HUMAN이 아닌 값"으로 남겨 다음(사람의 재확인 없는) 실행이
// 자동으로 이 task를 진행시켜 버리는 orphaned-READY 상태를 만들지 않는지도 함께 확인한다.
// ---------------------------------------------------------------------------
function makeTempGitRepoWithOrigin(): { repo: string; origin: string } {
  const origin = mkdtempSync(join(tmpdir(), "hrc-rgs-origin-"));
  tempDirs.push(origin);
  spawnSync("git", ["init", "-q", "--bare", "--initial-branch=main"], { cwd: origin });

  const seedParent = mkdtempSync(join(tmpdir(), "hrc-rgs-seed-"));
  tempDirs.push(seedParent);
  const seedRepo = join(seedParent, "repo");
  spawnSync("git", ["clone", "-q", origin, seedRepo], { cwd: seedParent });
  spawnSync("git", ["config", "user.email", "human-resume-continuous-test@example.com"], { cwd: seedRepo });
  spawnSync("git", ["config", "user.name", "Human Resume Continuous Test"], { cwd: seedRepo });
  writeFileSync(join(seedRepo, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: seedRepo });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: seedRepo });
  spawnSync("git", ["push", "-q", "-u", "origin", "HEAD:refs/heads/main"], { cwd: seedRepo });

  const clonesParent = mkdtempSync(join(tmpdir(), "hrc-rgs-clone-"));
  tempDirs.push(clonesParent);
  const repo = join(clonesParent, "repo");
  spawnSync("git", ["clone", "-q", origin, repo], { cwd: clonesParent });
  spawnSync("git", ["config", "user.email", "human-resume-continuous-test@example.com"], { cwd: repo });
  spawnSync("git", ["config", "user.name", "Human Resume Continuous Test"], { cwd: repo });

  return { repo, origin };
}
function pushExtraCommitToOrigin(origin: string, fileName: string): void {
  const parent = mkdtempSync(join(tmpdir(), "hrc-rgs-other-"));
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

async function scenarioRemoteGitSafetyBlocksResume(): Promise<void> {
  const { repo, origin } = makeTempGitRepoWithOrigin();
  const statePath = makeTempStateFile(repo, { status: "WAITING_HUMAN", completedTasks: [] });
  const manifest = buildManifest(repo, statePath, { remoteGitSafety: {} });

  // 승인 생성 이후, 사람이 APPROVE를 누르고 실제 resume이 실행되는 시점 사이에 remote가
  // 앞서게 된 상황을 흉내낸다.
  pushExtraCommitToOrigin(origin, "external-before-resume.txt");

  const calls: string[] = [];
  const claudeRunner = makeMarkerClaudeRunner(repo, calls);
  const approval = baseApproval({ expectedGitHead: headHash(repo), expectedBranch: branchName(repo) });

  const outcome = await performAutoResume(approval, manifest, { orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });

  check("I) Remote Git Safety 차단 시 performAutoResume 결과 kind=BLOCKED", outcome.kind === "BLOCKED");
  if (outcome.kind === "BLOCKED") {
    check("I) BLOCKED 사유가 REMOTE_GIT_BLOCKED로 시작함", outcome.reason.startsWith("REMOTE_GIT_BLOCKED:"));
  }
  check("I) developer(claudeRunner)가 전혀 호출되지 않음", calls.length === 0);
  check("I) 어떤 commit도 생성되지 않음(init 1건만)", gitLogCount(repo) === 1);
  const stateAfter = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("I) completedTasks 변화 없음", stateAfter.completedTasks.length === 0);
  // 회귀 방지(2026-08-26 Human Resume + Continuous Runner regression 조사에서 발견 후 같은
  // 세션에서 수정): performAutoResume()이 예전에는 runAutodevOnce()를 호출하기 *전에*
  // state.status를 "READY"로 먼저 저장했는데, runAutodevOnce()의 Remote Git Safety Gate는
  // BLOCKED_REMOTE_GIT을 반환할 때 state.json을 다시 읽거나 쓰지 않으므로(§ autodev.ts "이
  // 분기는 state.json/git 어느 쪽도 건드리지 않았다" 주석), WAITING_HUMAN이 "READY"로 orphan
  // 되어 사람의 새 승인 없이 이후 어떤 실행이든 이 task를 자동으로 다시 시도할 수 있었다.
  // auto-resume.ts에 Project Lock peek과 동일한 원칙의 Remote Git Safety 사전 재확인(§ 파일
  // 상단 주석 5))을 추가해, remote가 이미 앞서 있으면 READY 전환 자체를 시도하지 않도록
  // 고쳤다 — 이 check가 그 회귀를 지킨다.
  check(
    "I) Remote Git Safety 차단 후 project-state.status가 WAITING_HUMAN으로 남아있음(사람 재확인 없이 다음 실행이 자동으로 이 task를 진행할 수 있는 orphaned READY 상태가 아님)",
    (stateAfter.status as unknown as string) === "WAITING_HUMAN"
  );
}

async function main(): Promise<void> {
  try {
    await scenarioResumeCompletesOnlySameTaskThenStops();
    await scenarioRemoteGitSafetyBlocksResume();
  } finally {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 디렉터리 정리 실패는 테스트 결과에 영향 없음
      }
    }
  }

  console.log("\n=== Human Resume + Continuous Runner 통합 회귀 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
