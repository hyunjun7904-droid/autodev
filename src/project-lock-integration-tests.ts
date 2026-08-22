import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { runAutodevOnce } from "./autodev";
import { performAutoResume } from "./auto-resume";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import type { ClaudeResult, CoreState } from "./types";
import type { GptReviewerReturn } from "./orchestrator";
import type { ApprovalRequest } from "./approval";
import {
  debugComputeLockFilePath,
  resolveCanonicalProjectPath,
  RUNTIME_LOCK_DIR,
  PROJECT_LOCK_SCHEMA_VERSION,
} from "./project-lock";
import type { ProjectLockMetadata } from "./project-lock";

// Project Lock 통합 테스트 — Phase G Task G7. runAutodevOnce()/performAutoResume() 실제
// production entrypoint를 통해 lock이 실제로 적용되는지 검증한다(§ 요구사항 19~30). 실제
// Claude/OpenAI/Telegram 호출은 없다(orchestratorDeps에 항상 결정적 fake를 주입한다).
//
// 이 파일은 실제 RUNTIME_LOCK_DIR(autodev repo 자신의 logs/locks/)을 쓴다 — runAutodevOnce()가
// lockDir override를 받지 않기 때문이다(production 경로가 항상 그 위치 하나만 쓰는 것 자체가
// 이 테스트가 검증하려는 사실의 일부다). 각 시나리오는 서로 다른 tmpdir project root(=서로
// 다른 canonical path=서로 다른 lock 파일)를 쓰므로 시나리오 간 간섭이 없다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
const leftoverLockFiles: string[] = [];

function makeGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "plock-integration-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Project Lock Integration Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

const FIXTURE_TASK_REGISTRY: TaskDefinition[] = [
  {
    id: "L1",
    phase: 1,
    taskNumber: 1,
    title: "lock 통합 테스트용 task",
    prompt: "src/greet.js에 greet() 함수를 작성하세요.",
    requiredTests: [{ name: "lock-fixture-test", command: "node", args: ["tests/greet.test.js"], cwd: "root" }],
    allowedPathPrefixes: ["src/", "tests/"],
    prohibitedOperations: ["src/, tests/ 밖 파일 수정"],
  },
];
const FIXTURE_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["src/", "tests/"],
  allowedWritePrefixes: ["src/", "tests/"],
  allowedCommands: [{ cwd: "root", command: "node", args: ["tests/greet.test.js"] }],
};

function buildManifest(projectId: string, root: string, statePath: string): ProjectManifest {
  return {
    projectId,
    projectName: `Lock Integration ${projectId}`,
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

function makeSucceedingClaudeRunner(root: string, counter: { calls: number }): (task: string, attempt: number) => Promise<ClaudeResult> {
  return async (): Promise<ClaudeResult> => {
    counter.calls += 1;
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
      tests: [{ name: "lock-fixture-test", pass: res.status === 0 }],
      rawOutput: (res.stdout || "") + (res.stderr || ""),
    };
  };
}
function makeSucceedingReviewer(counter: { calls: number }): () => Promise<GptReviewerReturn> {
  return async (): Promise<GptReviewerReturn> => {
    counter.calls += 1;
    return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "정상", nextTask: null };
  };
}
function makeUnapprovedClaudeRunner(counter: { calls: number }): (task: string, attempt: number) => Promise<ClaudeResult> {
  return async (): Promise<ClaudeResult> => {
    counter.calls += 1;
    return { success: false, summary: "구조적 실패", changedFiles: [], tests: [], rawOutput: "", errorCode: "STRUCTURAL_FAILURE" } as ClaudeResult;
  };
}

/** 실제 RUNTIME_LOCK_DIR에 "다른(가짜, 하지만 진짜 살아있는) 프로세스가 이미 잡은 lock"을
 *  직접 심는다 — child_process로 실제로 살아있는 프로세스를 하나 띄우고 그 pid를 owner로
 *  기록한다(§ mock이 아니라 실제 liveness 판정 경로를 그대로 태운다). 호출부가 끝나면
 *  releaseFn()으로 child를 죽이고 남은 파일을 정리해야 한다. */
function seedForeignLock(projectId: string, root: string): { filePath: string; release: () => void } {
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
    filePath,
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

// ---------------------------------------------------------------------------
// 19 — 일반 AutoDev production entry(runAutodevOnce)에서 lock이 정상 적용됨(lock 없는 경우
// 정상 진행하고, 성공 후에는 release되어 재실행 가능).
// ---------------------------------------------------------------------------
async function scenarioNormalRunAppliesLockAndReleasesOnSuccess(): Promise<void> {
  const root = makeGitRepo("plock-int-normal-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, { status: "READY" });
  const manifest = buildManifest("lock-int-normal", root, statePath);

  const claudeCounter = { calls: 0 };
  const reviewCounter = { calls: 0 };
  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner: makeSucceedingClaudeRunner(root, claudeCounter), gptReviewer: makeSucceedingReviewer(reviewCounter) },
  });
  check("19) lock이 없으면 일반 AutoDev 실행이 정상 진행됨(APPROVED+checkpoint)", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("19) claudeRunner가 실제로 호출됨(lock이 정상 진행을 막지 않음)", claudeCounter.calls > 0);

  const filePath = debugComputeLockFilePath(resolveCanonicalProjectPath(root), RUNTIME_LOCK_DIR);
  check("26) 성공(APPROVED+checkpoint)한 뒤에는 lock이 release됨(파일이 사라짐)", !existsSync(filePath));

  // 같은 프로세스가 다시 시도해도(재진입이 아니라 이미 release되었으므로 정상 acquire) task가
  // 이미 completedTasks에 있어 STOP으로 끝나야 한다 — 이 재실행 자체가 lock이 정상 release된
  // 뒤 다시 acquire 가능함을 보여준다.
  const second = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner: makeSucceedingClaudeRunner(root, claudeCounter), gptReviewer: makeSucceedingReviewer(reviewCounter) },
  });
  check("release 후 같은 project를 다시 acquire할 수 있음(BLOCKED_PROJECT_LOCK이 아님)", second.outcome !== "BLOCKED_PROJECT_LOCK");
}

// ---------------------------------------------------------------------------
// 20 — Telegram Auto Resume에서도 동일 lock이 적용됨(lock 없는 정상 경로는 막히지 않는다).
// ---------------------------------------------------------------------------
async function scenarioAutoResumeAppliesLockOnNormalPath(): Promise<void> {
  const root = makeGitRepo("plock-int-resume-normal-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest("lock-int-resume-normal", root, statePath);
  const approval: ApprovalRequest = {
    approvalId: "appr-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:30:00.000Z",
    runId: "run-1",
    taskId: "L1",
    approvalType: "ORCHESTRATOR_NOT_APPROVED_GENERIC",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: "evt-1",
    status: "APPROVED",
    remotelyApprovable: true,
    requiresSafetyRecheck: true,
    dedupeKey: "dk-1",
  };
  const claudeCounter = { calls: 0 };
  const reviewCounter = { calls: 0 };
  const outcome = await performAutoResume(approval, manifest, {
    orchestratorDeps: { claudeRunner: makeSucceedingClaudeRunner(root, claudeCounter), gptReviewer: makeSucceedingReviewer(reviewCounter) },
  });
  check("20) lock이 없으면 Telegram Auto Resume도 정상 진행됨(COMPLETED)", outcome.kind === "COMPLETED");
  check("20) 실제 developer가 호출됨(lock이 정상 진행을 막지 않음)", claudeCounter.calls > 0);
}

// ---------------------------------------------------------------------------
// 21 — Telegram APPROVE가 lock을 우회하지 못함: 다른(진짜 살아있는) 프로세스가 이미 이
// project를 쓰고 있으면 Auto Resume은 즉시 BLOCKED되고, state.json의 READY 전환조차 시도하지
// 않는다(peekProjectLock 사전확인).
// ---------------------------------------------------------------------------
async function scenarioAutoResumeBlockedByForeignLock(): Promise<void> {
  const root = makeGitRepo("plock-int-resume-blocked-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest("lock-int-resume-blocked", root, statePath);
  const approval: ApprovalRequest = {
    approvalId: "appr-2",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:30:00.000Z",
    runId: "run-2",
    taskId: "L1",
    approvalType: "ORCHESTRATOR_NOT_APPROVED_GENERIC",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: "evt-2",
    status: "APPROVED",
    remotelyApprovable: true,
    requiresSafetyRecheck: true,
    dedupeKey: "dk-2",
  };

  const gitStatusBefore = (spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf-8" }).stdout || "").trim();

  const foreign = seedForeignLock("lock-int-resume-blocked", root);
  try {
    const claudeCounter = { calls: 0 };
    const reviewCounter = { calls: 0 };
    const outcome = await performAutoResume(approval, manifest, {
      orchestratorDeps: { claudeRunner: makeSucceedingClaudeRunner(root, claudeCounter), gptReviewer: makeSucceedingReviewer(reviewCounter) },
    });
    check("21) 다른 프로세스가 이미 lock을 쥐고 있으면 Telegram Auto Resume이 BLOCKED됨", outcome.kind === "BLOCKED");
    check("21) BLOCKED 사유에 PROJECT_ALREADY_LOCKED가 남음", outcome.kind === "BLOCKED" && outcome.reason.includes("PROJECT_ALREADY_LOCKED"));
    check("21) claudeRunner는 전혀 호출되지 않음(developer 시작 안 함)", claudeCounter.calls === 0);
    check("21) gptReviewer도 전혀 호출되지 않음", reviewCounter.calls === 0);

    const stateAfter = JSON.parse(readFileSync(statePath, "utf-8")) as CoreState;
    check("10) lock 재확인이 READY 전환(state 쓰기)보다 먼저 막아 state.status가 WAITING_HUMAN 그대로 유지됨", stateAfter.status === "WAITING_HUMAN");
    check("21) completedTasks도 변화 없음(L1이 추가되지 않음)", !stateAfter.completedTasks.includes("L1"));

    // 이 fixture 자체가 .autodev/project-state.json을 untracked 상태로 미리 만들어두므로
    // (테스트 셋업), git status가 완전히 빈 문자열일 것을 기대하지 않는다 — blocked 호출
    // "전후"에 상태가 전혀 바뀌지 않았는지만 비교한다(§ 요구사항 25, git mutation 0).
    const gitStatusAfter = (spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf-8" }).stdout || "").trim();
    check("25) blocked 상태에서 target repo의 git status가 호출 전후로 전혀 바뀌지 않음(mutation 0)", gitStatusAfter === gitStatusBefore);
    const gitLog = (spawnSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf-8" }).stdout || "").trim().split("\n");
    check("25) commit도 생성되지 않음(init 커밋 1건만 존재)", gitLog.length === 1);
  } finally {
    foreign.release();
  }
}

// ---------------------------------------------------------------------------
// 22/23/24/25 — 일반 AutoDev 실행(runAutodevOnce)도 동일하게 blocked lock에서 아무 production
// 작업도 하지 않는다.
// ---------------------------------------------------------------------------
async function scenarioRunAutodevOnceBlockedByForeignLockDoesNothing(): Promise<void> {
  const root = makeGitRepo("plock-int-run-blocked-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, { status: "READY" });
  const manifest = buildManifest("lock-int-run-blocked", root, statePath);

  const foreign = seedForeignLock("lock-int-run-blocked", root);
  try {
    const claudeCounter = { calls: 0 };
    const reviewCounter = { calls: 0 };
    const result = await runAutodevOnce({
      manifest,
      orchestratorDeps: { claudeRunner: makeSucceedingClaudeRunner(root, claudeCounter), gptReviewer: makeSucceedingReviewer(reviewCounter) },
    });
    check("22) blocked lock 상태에서 outcome=BLOCKED_PROJECT_LOCK", result.outcome === "BLOCKED_PROJECT_LOCK");
    check("22) Claude runner 호출 0회", claudeCounter.calls === 0);
    check("23) GPT reviewer 호출 0회", reviewCounter.calls === 0);

    const stateAfter = JSON.parse(readFileSync(statePath, "utf-8")) as CoreState;
    check("24) checkpoint(project-state 갱신) 0회 — state.json이 최초 값 그대로", stateAfter.status === "READY" && stateAfter.completedTasks.length === 0);

    const gitLog = (spawnSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf-8" }).stdout || "").trim().split("\n");
    check("25) blocked 상태에서 Git mutation 0(commit 여전히 init 1건)", gitLog.length === 1);
  } finally {
    foreign.release();
  }
}

// ---------------------------------------------------------------------------
// 27/29 — 실패(orchestrator NOT_APPROVED) lifecycle: lock은 release되지 않고 유지된다.
// ---------------------------------------------------------------------------
async function scenarioFailureLifecycleKeepsLock(): Promise<void> {
  const root = makeGitRepo("plock-int-failure-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, { status: "READY" });
  const manifest = buildManifest("lock-int-failure", root, statePath);

  const claudeCounter = { calls: 0 };
  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner: makeUnapprovedClaudeRunner(claudeCounter) },
  });
  check("27) orchestrator가 APPROVED로 끝나지 않으면 outcome=RAN_TASK_NOT_APPROVED", result.outcome === "RAN_TASK_NOT_APPROVED");

  const filePath = debugComputeLockFilePath(resolveCanonicalProjectPath(root), RUNTIME_LOCK_DIR);
  check("27/29) 실패(WAITING_HUMAN) lifecycle에서는 lock을 release하지 않고 유지함", existsSync(filePath));

  // 같은 프로세스가 다시 시도하면(재진입) kept lock에 막히지 않아야 한다 — 다만 첫 번째
  // 실패로 이미 state.status가 WAITING_HUMAN으로 저장됐으므로(runOrchestrator 자체 동작,
  // lock과 무관) decideNextAction()이 STOP으로 끝나는 것이 정상이다. 여기서 검증하려는
  // 것은 오직 하나 — "같은 프로세스의 재진입이 PROJECT_ALREADY_LOCKED로 차단되지 않는다"는
  // 사실이다("영원히 잠김"이 아니라 "이 프로세스가 살아있는 동안만 유지"임을 보여준다).
  const claudeCounter2 = { calls: 0 };
  const reviewCounter2 = { calls: 0 };
  const second = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner: makeSucceedingClaudeRunner(root, claudeCounter2), gptReviewer: makeSucceedingReviewer(reviewCounter2) },
  });
  check("같은 프로세스의 재진입은 kept lock에 PROJECT_ALREADY_LOCKED로 막히지 않음", second.outcome !== "BLOCKED_PROJECT_LOCK");
  check("재진입 후에도 decideNextAction은 기존 WAITING_HUMAN 정책 그대로 STOP(lock과 무관한 기존 동작)", second.outcome === "STOPPED");

  try {
    rmSync(filePath, { force: true });
  } catch {
    /* 정리 실패는 테스트 결과에 영향 없음 */
  }
}

// ---------------------------------------------------------------------------
// 28 — 예외(exception) lifecycle: 처리되지 않은 예외가 발생해도 lock은 release되지 않고
// 유지되며, 예외는 그대로 호출부에 전파된다(삼켜지지 않는다).
// ---------------------------------------------------------------------------
async function scenarioExceptionLifecycleKeepsLockAndRethrows(): Promise<void> {
  const root = makeGitRepo("plock-int-exception-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, { status: "READY" });
  const manifest = buildManifest("lock-int-exception", root, statePath);

  let threw = false;
  try {
    await runAutodevOnce({
      manifest,
      orchestratorDeps: {
        claudeRunner: async () => {
          throw new Error("의도적인 테스트 예외");
        },
      },
    });
  } catch {
    threw = true;
  }
  check("28) 처리되지 않은 예외는 삼켜지지 않고 그대로 전파됨", threw);

  const filePath = debugComputeLockFilePath(resolveCanonicalProjectPath(root), RUNTIME_LOCK_DIR);
  check("28) 예외 발생 시에도 lock을 release하지 않고 유지함(fail-closed)", existsSync(filePath));

  try {
    rmSync(filePath, { force: true });
  } catch {
    /* 정리 실패는 테스트 결과에 영향 없음 */
  }
}

async function main(): Promise<void> {
  await scenarioNormalRunAppliesLockAndReleasesOnSuccess();
  await scenarioAutoResumeAppliesLockOnNormalPath();
  await scenarioAutoResumeBlockedByForeignLock();
  await scenarioRunAutodevOnceBlockedByForeignLockDoesNothing();
  await scenarioFailureLifecycleKeepsLock();
  await scenarioExceptionLifecycleKeepsLockAndRethrows();

  console.log("\n=== project-lock 통합(runAutodevOnce/performAutoResume) 테스트 결과 ===");
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
  for (const f of leftoverLockFiles) {
    try {
      rmSync(f, { force: true });
    } catch {
      /* 정리 실패는 테스트 결과에 영향 없음 */
    }
  }

  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
