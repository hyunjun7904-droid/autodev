import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkGitSafeToResume, performAutoResume } from "./auto-resume";
import { runAutodevOnce, approveHumanFinalReview } from "./autodev";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import type { ClaudeResult, CoreState } from "./types";
import type { GptReviewerReturn } from "./orchestrator";
import type { ApprovalRequest } from "./approval";

// Safe Auto Resume 테스트 — Phase G Task G6. 실제 Claude CLI/OpenAI API는 절대 호출하지
// 않는다 — orchestratorDeps(claudeRunner/gptReviewer)는 항상 결정적 fake로 주입한다(§
// fixture-e2e-tests.ts와 동일한 원칙). "git reset/clean/checkout 등 자동 수정을 시도하지
// 않는다"는 이 파일이 실제 git 명령을 spawnSync로 직접 실행하지 않고, checkGitSafeToResume이
// 오직 읽기 전용 조회(git-changes.ts)만 쓰는 것으로 구조적으로 검증한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];

function makeGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "auto-resume-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Auto Resume Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function headHash(dir: string): string {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" });
  return (res.stdout || "").trim();
}
function branchName(dir: string): string {
  const res = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf-8" });
  return (res.stdout || "").trim();
}

// ---------------------------------------------------------------------------
// checkGitSafeToResume — 읽기 전용 helper만 재사용, git 명령을 직접 실행하지 않는다.
// ---------------------------------------------------------------------------
function scenarioGitSafeNoExpectation(): void {
  const dir = makeGitRepo("auto-resume-git-noexp-");
  const result = checkGitSafeToResume(dir, {});
  check("아무 기대값도 없으면 항상 ok:true(비교할 것이 없음)", result.ok === true);
}
function scenarioGitSafeHeadMatch(): void {
  const dir = makeGitRepo("auto-resume-git-headmatch-");
  const result = checkGitSafeToResume(dir, { expectedGitHead: headHash(dir) });
  check("HEAD가 승인 생성 시점과 동일 -> ok:true", result.ok === true);
}
function scenarioGitSafeHeadDiverged(): void {
  const dir = makeGitRepo("auto-resume-git-headdiverge-");
  const staleHead = headHash(dir);
  writeFileSync(join(dir, "extra.txt"), "changed");
  spawnSync("git", ["add", "--", "extra.txt"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "second commit"], { cwd: dir });
  const result = checkGitSafeToResume(dir, { expectedGitHead: staleHead });
  check("HEAD가 승인 생성 시점 이후 바뀜 -> ok:false RESUME_BLOCKED_GIT_STATE_DIVERGED", result.ok === false && result.reason === "RESUME_BLOCKED_GIT_STATE_DIVERGED");
}
function scenarioGitSafeBranchMatch(): void {
  const dir = makeGitRepo("auto-resume-git-branchmatch-");
  const result = checkGitSafeToResume(dir, { expectedBranch: branchName(dir) });
  check("branch가 승인 생성 시점과 동일 -> ok:true", result.ok === true);
}
function scenarioGitSafeBranchChanged(): void {
  const dir = makeGitRepo("auto-resume-git-branchchange-");
  const staleBranch = branchName(dir);
  spawnSync("git", ["checkout", "-q", "-b", "other-branch"], { cwd: dir });
  const result = checkGitSafeToResume(dir, { expectedBranch: staleBranch });
  check("branch가 승인 생성 시점 이후 바뀜 -> ok:false RESUME_BLOCKED_GIT_STATE_BRANCH_CHANGED", result.ok === false && result.reason === "RESUME_BLOCKED_GIT_STATE_BRANCH_CHANGED");
}
function scenarioGitSafeHeadUnknownFailsClosed(): void {
  const dir = mkdtempSync(join(tmpdir(), "auto-resume-not-a-repo-"));
  tempDirs.push(dir);
  const result = checkGitSafeToResume(dir, { expectedGitHead: "deadbeef" });
  check("git repo가 아니어서 HEAD를 알 수 없으면 fail-closed(ok:false)", result.ok === false && result.reason === "RESUME_BLOCKED_GIT_STATE_HEAD_UNKNOWN");
}

// ---------------------------------------------------------------------------
// performAutoResume — remotelyApprovable 재확인 / stale-state 재확인 / git safety 재확인
// ---------------------------------------------------------------------------
const FIXTURE_TASK_REGISTRY: TaskDefinition[] = [
  {
    id: "R1",
    phase: 1,
    taskNumber: 1,
    title: "resume 대상 task",
    prompt: "src/greet.js에 greet() 함수를 작성하세요.",
    requiredTests: [{ name: "resume-fixture-test", command: "node", args: ["tests/greet.test.js"], cwd: "root" }],
    allowedPathPrefixes: ["src/", "tests/"],
    prohibitedOperations: ["src/, tests/ 밖 파일 수정"],
  },
];
const FIXTURE_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["src/", "tests/"],
  allowedWritePrefixes: ["src/", "tests/"],
  allowedCommands: [{ cwd: "root", command: "node", args: ["tests/greet.test.js"] }],
};

function buildResumeManifest(root: string, statePath: string): ProjectManifest {
  return {
    projectId: "fixture-resume",
    projectName: "Fixture Resume",
    targetProjectRoot: root,
    statePath,
    taskRegistry: FIXTURE_TASK_REGISTRY,
    developerInstructions: "허용 범위: src/**, tests/**만 다룹니다.",
    reviewInstructions: "함수가 정확히 동작하는지 확인하세요.",
    reviewScopeDirs: ["src/", "tests/"],
    executionPolicy: FIXTURE_EXECUTION_POLICY,
  };
}

function writeStateFile(statePath: string, overrides: Partial<CoreState>): void {
  mkdirSync(join(statePath, ".."), { recursive: true });
  const state: CoreState = {
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "WAITING_HUMAN",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
    gitCheckpoint: "",
    currentPhase: 1,
    ...overrides,
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function baseApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: randomUUID(),
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:30:00.000Z",
    runId: "run-1",
    taskId: "R1",
    approvalType: "ORCHESTRATOR_NOT_APPROVED_GENERIC",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: randomUUID(),
    status: "APPROVED",
    remotelyApprovable: true,
    requiresSafetyRecheck: true,
    dedupeKey: `dk-${randomUUID()}`,
    ...overrides,
  };
}

async function scenarioRemotelyApprovableFalseBlocked(): Promise<void> {
  const root = makeGitRepo("auto-resume-notapprovable-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildResumeManifest(root, statePath);
  const approval = baseApproval({ remotelyApprovable: false, approvalType: "SECURITY_BLOCKED" });
  const outcome = await performAutoResume(approval, manifest);
  check(
    "remotelyApprovable=false인 승인은(호출부가 이미 걸러도) 다시 한번 재확인해 BLOCKED",
    outcome.kind === "BLOCKED" && outcome.reason === "REMOTE_APPROVAL_NOT_ALLOWED"
  );
}

async function scenarioTaskAlreadyCompletedStale(): Promise<void> {
  const root = makeGitRepo("auto-resume-completed-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, { completedTasks: ["R1"] });
  const manifest = buildResumeManifest(root, statePath);
  const approval = baseApproval({});
  const outcome = await performAutoResume(approval, manifest);
  check(
    "승인 생성 시점 이후 task가 이미 완료됨 -> BLOCKED(중복 재실행 방지)",
    outcome.kind === "BLOCKED" && outcome.reason === "STALE_APPROVAL_TASK_ALREADY_COMPLETED"
  );
}

async function scenarioUnexpectedStateStale(): Promise<void> {
  const root = makeGitRepo("auto-resume-unexpected-state-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, { status: "IDLE" });
  const manifest = buildResumeManifest(root, statePath);
  const approval = baseApproval({});
  const outcome = await performAutoResume(approval, manifest);
  check(
    "현재 상태가 WAITING_HUMAN이 아니면(이미 다른 경로로 진행됨) BLOCKED",
    outcome.kind === "BLOCKED" && outcome.reason === "STALE_APPROVAL_UNEXPECTED_STATE(IDLE)"
  );
}

async function scenarioGitDivergedBlocksAndDoesNotMutateState(): Promise<void> {
  const root = makeGitRepo("auto-resume-git-diverge-full-");
  const staleHead = headHash(root);
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildResumeManifest(root, statePath);

  // 승인 생성 이후 실제로 저장소에 새 commit이 생겼다(사람이 PC에서 직접 작업했거나 다른
  // 프로세스가 커밋한 상황을 흉내낸다).
  writeFileSync(join(root, "manual-change.txt"), "someone committed directly");
  spawnSync("git", ["add", "--", "manual-change.txt"], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "manual change after approval created"], { cwd: root });

  const approval = baseApproval({ expectedGitHead: staleHead });
  const outcome = await performAutoResume(approval, manifest);
  check("Git HEAD가 승인 생성 시점 이후 바뀌면 실행 자체를 하지 않고 BLOCKED", outcome.kind === "BLOCKED" && outcome.reason === "RESUME_BLOCKED_GIT_STATE_DIVERGED");

  const stateAfter = JSON.parse(readFileSync(statePath, "utf-8")) as CoreState;
  check("Git divergence로 BLOCKED된 경우 state.status는 WAITING_HUMAN 그대로 유지(READY로 바뀌지 않음)", stateAfter.status === "WAITING_HUMAN");
  check("Git divergence로 BLOCKED된 경우 completedTasks도 변화 없음", stateAfter.completedTasks.length === 0);
}

function makeFakeClaudeRunner(root: string): (task: string, attempt: number) => Promise<ClaudeResult> {
  return async (): Promise<ClaudeResult> => {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "src", "greet.js"), "function greet(name) {\n  return `hi ${name}`;\n}\n\nmodule.exports = { greet };\n");
    writeFileSync(
      join(root, "tests", "greet.test.js"),
      "const assert = require('node:assert');\nconst { greet } = require('../src/greet');\nassert.strictEqual(greet('a'), 'hi a');\nconsole.log('OK');\n"
    );
    const res = spawnSync(process.execPath, ["tests/greet.test.js"], { cwd: root, encoding: "utf-8" });
    return {
      success: true,
      summary: "greet() 구현 완료",
      changedFiles: ["src/greet.js", "tests/greet.test.js"],
      tests: [{ name: "resume-fixture-test", pass: res.status === 0 }],
      rawOutput: (res.stdout || "") + (res.stderr || ""),
    };
  };
}
async function fakeGptReviewer(): Promise<GptReviewerReturn> {
  return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "정상", nextTask: null };
}

async function scenarioSafePathCompletesWithoutRealApiCalls(): Promise<void> {
  const root = makeGitRepo("auto-resume-completed-path-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  // 이 시나리오는 "auto-resume이 HFR gate를 우회하지 못함"을 직접 검증하는 전용
  // 시나리오다(§ HFR 요구사항 7) — 이 project는 humanFinalReviewPolicy를 명시적으로
  // opt-in한다. buildResumeManifest() 자체(다른 시나리오가 공유)는 기본값 OFF를 유지한다.
  const manifest = { ...buildResumeManifest(root, statePath), humanFinalReviewPolicy: { enabled: true } };
  const approval = baseApproval({ expectedGitHead: headHash(root), expectedBranch: branchName(root) });

  let claudeRunnerCalled: boolean = false;
  let gptReviewerCalled: boolean = false;
  const outcome = await performAutoResume(approval, manifest, {
    orchestratorDeps: {
      claudeRunner: async (task: string, attempt: number) => {
        claudeRunnerCalled = true;
        return makeFakeClaudeRunner(root)(task, attempt);
      },
      gptReviewer: async () => {
        gptReviewerCalled = true;
        return fakeGptReviewer();
      },
    },
  });

  check("모든 안전 재검사를 통과하면 실제 실행까지 이어짐(COMPLETED)", outcome.kind === "COMPLETED");
  check("실제 실행은 injected fake claudeRunner를 통해서만 일어남(실제 Claude CLI 호출 아님)", claudeRunnerCalled);
  check("실제 실행은 injected fake gptReviewer를 통해서만 일어남(실제 OpenAI API 호출 아님)", gptReviewerCalled);
  // HUMAN_FINAL_REVIEW gate — Auto Resume이 developer/reviewer를 다시 실행해 reviewer가
  // 다시 APPROVED하더라도, checkpoint 전 사람의 최종 승인이 여전히 필요하다(§ 요구사항 —
  // Human Final Review는 Reviewer/Auto Resume 어느 경로로 도달했든 동일하게 적용된다).
  if (outcome.kind === "COMPLETED") {
    check(
      "COMPLETED 결과의 outcome은 RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW(재실행된 reviewer도 Human Final Review를 거쳐야 함)",
      outcome.result.outcome === "RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW"
    );
  }

  const stateAfterAutoResume = JSON.parse(readFileSync(statePath, "utf-8")) as CoreState;
  check("Auto Resume 직후에는 아직 completedTasks에 R1이 추가되지 않음(사람 최종 승인 대기 중)", !stateAfterAutoResume.completedTasks.includes("R1"));
  check("Auto Resume 직후 status='WAITING_HUMAN'(Human Final Review 대기)", (stateAfterAutoResume.status as unknown as string) === "WAITING_HUMAN");

  // 사람이 명시적으로 APPROVE한 뒤에만(Gate를 실제로 거쳐) checkpoint까지 이어진다.
  const approval2 = approveHumanFinalReview(statePath, "R1");
  check("Human Final Review approveHumanFinalReview ok=true", approval2.ok === true);
  const resumedResult = await runAutodevOnce({ manifest, statePath });
  check("Human Final Review 승인 후 resume outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", resumedResult.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");

  const stateAfter = JSON.parse(readFileSync(statePath, "utf-8")) as CoreState;
  check("성공 이후 completedTasks에 R1이 추가됨(Gate를 실제로 거쳐 완료)", stateAfter.completedTasks.includes("R1"));
}

async function main(): Promise<void> {
  scenarioGitSafeNoExpectation();
  scenarioGitSafeHeadMatch();
  scenarioGitSafeHeadDiverged();
  scenarioGitSafeBranchMatch();
  scenarioGitSafeBranchChanged();
  scenarioGitSafeHeadUnknownFailsClosed();
  await scenarioRemotelyApprovableFalseBlocked();
  await scenarioTaskAlreadyCompletedStale();
  await scenarioUnexpectedStateStale();
  await scenarioGitDivergedBlocksAndDoesNotMutateState();
  await scenarioSafePathCompletesWithoutRealApiCalls();

  console.log("\n=== auto-resume.ts(G6) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);

  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // OS 임시 디렉터리 — 정리 실패는 테스트 결과에 영향 없음.
    }
  }

  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
