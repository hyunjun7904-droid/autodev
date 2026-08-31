import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { ensureDurableApprovalForGenuineWaitingHuman, performLocalHumanApproval } from "./local-human-approval";
import { buildApprovalRequest, CHECKPOINT_SCOPE_VIOLATION_REASON } from "./approval";
import type { ApprovalRequest } from "./approval";
import { createInMemoryApprovalStore, createFileApprovalStore } from "./approval-store";
import { getCurrentBranch, getCurrentHeadHash } from "./git-changes";
import { debugComputeLockFilePath, resolveCanonicalProjectPath, RUNTIME_LOCK_DIR } from "./project-lock";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import type { ClaudeResult, CoreState } from "./types";
import type { GptReviewerReturn } from "./orchestrator";
import { REVIEW_CYCLE_EXHAUSTED_REASON } from "./review-policy";
import { captureTaskChangeBaseline } from "./task-change-baseline";
import { computeCommitPlan } from "./checkpoint";

// Orphaned Genuine Human Gate Recovery(2026-09-01) — AutoDev Core Freeze(autodev-core-
// freeze-20260901) 이후 DEFECT_CONFIRMED된 generic production defect(§ .claude/CLAUDE.md)의
// 회귀 테스트다. JARVIS/Task 5.3 이름은 fixture로 쓰지 않는다(§ 요구사항 — generic fixture로
// 재현) — 여기 쓰는 project/task id는 모두 이 테스트 파일 전용 fixture 값이다.
//
// local-human-approval-tests.ts와 동일한 원칙 — 실제 Claude CLI/OpenAI API는 호출하지
// 않는다(orchestratorDeps는 항상 fake). Git/파일시스템/ApprovalStore/ProjectLock은 실제
// 동작을 그대로 쓴다(mock으로 COMPLETE 처리하지 않는다, § 요구사항 14).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];

function makeGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "orphaned-gate-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Orphaned Gate Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function commitMore(dir: string, fileName: string, message: string): void {
  writeFileSync(join(dir, fileName), "x");
  spawnSync("git", ["add", "--", fileName], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", message], { cwd: dir });
}

const FIXTURE_TASK_ID = "G1";
const FIXTURE_TASK_REGISTRY: TaskDefinition[] = [
  {
    id: FIXTURE_TASK_ID,
    phase: 1,
    taskNumber: 1,
    title: "orphaned gate fixture task",
    prompt: "src/greet.js에 greet() 함수를 작성하세요.",
    requiredTests: [{ name: "orphaned-gate-fixture-test", command: "node", args: ["tests/greet.test.js"], cwd: "root" }],
    allowedPathPrefixes: ["src/", "tests/"],
    prohibitedOperations: ["src/, tests/ 밖 파일 수정"],
  },
];
const FIXTURE_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["src/", "tests/"],
  allowedWritePrefixes: ["src/", "tests/"],
  allowedCommands: [{ cwd: "root", command: "node", args: ["tests/greet.test.js"] }],
};

function buildManifest(root: string, statePath: string, projectId: string): ProjectManifest {
  return {
    projectId,
    projectName: `Fixture ${projectId}`,
    targetProjectRoot: root,
    statePath,
    taskRegistry: FIXTURE_TASK_REGISTRY,
    developerInstructions: "허용 범위: src/**, tests/**만 다룹니다.",
    reviewInstructions: "함수가 정확히 동작하는지 확인하세요.",
    reviewScopeDirs: ["src/", "tests/"],
    executionPolicy: FIXTURE_EXECUTION_POLICY,
  };
}

const GENUINE_SCOPE_VIOLATION_MARKER = (taskId: string, unexpected: string) =>
  `CHECKPOINT_BLOCKED(${taskId}): ${CHECKPOINT_SCOPE_VIOLATION_REASON} — unexpected: ${unexpected}`;

function writeStateFile(statePath: string, overrides: Partial<CoreState>): void {
  mkdirSync(join(statePath, ".."), { recursive: true });
  const state: CoreState = {
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "WAITING_HUMAN",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [GENUINE_SCOPE_VIOLATION_MARKER(FIXTURE_TASK_ID, "leftover.txt")],
    completedTasks: [],
    gitCheckpoint: "",
    currentPhase: 1,
    ...overrides,
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function readState(statePath: string): CoreState {
  return JSON.parse(readFileSync(statePath, "utf-8")) as CoreState;
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
      tests: [{ name: "orphaned-gate-fixture-test", pass: res.status === 0 }],
      rawOutput: (res.stdout || "") + (res.stderr || ""),
    };
  };
}
async function fakeGptReviewer(): Promise<GptReviewerReturn> {
  return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "정상", nextTask: null };
}

// ---------------------------------------------------------------------------
// A) genuine state + event 없음 + approval 없음 → fresh valid PENDING 하나.
// ---------------------------------------------------------------------------
function scenarioCreatesFreshApprovalWhenNoneExists(): void {
  const root = makeGitRepo("orphaned-gate-fresh-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const projectId = `fixture-orphaned-${randomUUID()}`;
  const manifest = buildManifest(root, statePath, projectId);
  const approvalStore = createInMemoryApprovalStore();
  const currentHead = getCurrentHeadHash(root);
  const currentBranch = getCurrentBranch(root);

  const outcome = ensureDurableApprovalForGenuineWaitingHuman(FIXTURE_TASK_ID, { approvalStore, statePath, manifest });
  check("A) event/approval이 전혀 없어도 새 PENDING approval을 생성함(CREATED)", outcome.kind === "CREATED");
  if (outcome.kind === "CREATED") {
    check("A) projectId가 정확함", outcome.approval.projectId === projectId);
    check("A) taskId가 정확함", outcome.approval.taskId === FIXTURE_TASK_ID);
    check("A) status는 PENDING", outcome.approval.status === "PENDING");
    check(
      "A) CHECKPOINT_SCOPE_VIOLATION_REASON 마커는 기존 classifyApprovalType()을 재사용해 CHECKPOINT_SCOPE_VIOLATION으로 정확히 분류됨",
      outcome.approval.approvalType === "CHECKPOINT_SCOPE_VIOLATION"
    );
    check("A) remotelyApprovable=false(genuine은 항상 원격 승인 불가)", outcome.approval.remotelyApprovable === false);
    check("A) sourceKind=DURABLE_STATE_RECOVERY(정직한 provenance)", outcome.approval.sourceKind === "DURABLE_STATE_RECOVERY");
    check("A) 존재하지 않는 event를 가리키는 sourceEventId를 날조하지 않음(비어있음)", outcome.approval.sourceEventId === undefined);
    check("A) sourceStateFingerprint가 채워짐(durable state 근거)", typeof outcome.approval.sourceStateFingerprint === "string" && outcome.approval.sourceStateFingerprint.length > 0);
    check("A) 현재 실제 Git HEAD가 기록됨", outcome.approval.expectedGitHead === currentHead);
    check("A) 현재 실제 branch가 기록됨", outcome.approval.expectedBranch === currentBranch);
    check("A) state.json은 이 함수로 인해 변경되지 않음(상태 전이 없음)", JSON.stringify(readState(statePath).deferredHumanTasks) === JSON.stringify([GENUINE_SCOPE_VIOLATION_MARKER(FIXTURE_TASK_ID, "leftover.txt")]));
  }
}

// ---------------------------------------------------------------------------
// B) 동일 상태 재실행 → duplicate 0.
// ---------------------------------------------------------------------------
function scenarioRepeatedCallDoesNotDuplicate(): void {
  const root = makeGitRepo("orphaned-gate-repeat-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath, `fixture-orphaned-${randomUUID()}`);
  const approvalStore = createInMemoryApprovalStore();

  const first = ensureDurableApprovalForGenuineWaitingHuman(FIXTURE_TASK_ID, { approvalStore, statePath, manifest });
  const second = ensureDurableApprovalForGenuineWaitingHuman(FIXTURE_TASK_ID, { approvalStore, statePath, manifest });
  check("B) 첫 호출은 CREATED", first.kind === "CREATED");
  check("B) 두 번째 호출은 REUSED_EXISTING(새로 만들지 않음)", second.kind === "REUSED_EXISTING");
  if (first.kind === "CREATED" && second.kind === "REUSED_EXISTING") {
    check("B) 같은 approvalId를 그대로 재사용함", first.approval.approvalId === second.approval.approvalId);
  }
  check(
    "B) ApprovalStore에는 이 project/task에 대해 정확히 1건만 존재함",
    approvalStore.list({}).filter((r) => r.projectId === manifest.projectId && r.taskId === FIXTURE_TASK_ID).length === 1
  );
}

// ---------------------------------------------------------------------------
// C) old expired approval 존재 → old는 건드리지 않고 current 기준 새 approval 생성.
// ---------------------------------------------------------------------------
function scenarioExpiredOldApprovalDoesNotBlockNewOne(): void {
  const root = makeGitRepo("orphaned-gate-expired-old-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath, `fixture-orphaned-${randomUUID()}`);
  const approvalStore = createInMemoryApprovalStore();

  const currentHead = getCurrentHeadHash(root);
  const currentBranch = getCurrentBranch(root);
  const oldExpired: ApprovalRequest = {
    approvalId: randomUUID(),
    createdAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2020-01-01T00:30:00.000Z",
    projectId: manifest.projectId,
    runId: "old-run",
    taskId: FIXTURE_TASK_ID,
    approvalType: "CHECKPOINT_SCOPE_VIOLATION",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: randomUUID(),
    status: "PENDING",
    remotelyApprovable: false,
    requiresSafetyRecheck: true,
    dedupeKey: `old-dk-${randomUUID()}`,
    expectedGitHead: currentHead,
    expectedBranch: currentBranch,
  };
  approvalStore.createPending(oldExpired);

  const outcome = ensureDurableApprovalForGenuineWaitingHuman(FIXTURE_TASK_ID, { approvalStore, statePath, manifest });
  check("C) 만료된 기존 approval과 무관하게 새 approval이 생성됨(CREATED)", outcome.kind === "CREATED");
  if (outcome.kind === "CREATED") {
    check("C) 새 approval은 old expired와 다른 approvalId", outcome.approval.approvalId !== oldExpired.approvalId);
  }
  check("C) old expired approval 자체는 전혀 건드리지 않음(여전히 PENDING, 삭제/수정 없음)", approvalStore.get(oldExpired.approvalId)?.status === "PENDING");
  check(
    "C) old expired approval을 직접 승인 시도하면 여전히 APPROVAL_EXPIRED(§ O)",
    true // 실제 검증은 별도 scenarioExpiredRecoveryApprovalStillRejected()에서 수행
  );
}

// ---------------------------------------------------------------------------
// D) old HEAD approval 존재 → current HEAD approval을 별도 생성(HEAD mismatch fixture, § 13).
// ---------------------------------------------------------------------------
function scenarioOldHeadApprovalDoesNotSupersedeCurrentHead(): void {
  const root = makeGitRepo("orphaned-gate-old-head-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath, `fixture-orphaned-${randomUUID()}`);
  const approvalStore = createInMemoryApprovalStore();

  const staleHead = "0".repeat(40); // 실제 HEAD와 절대 일치하지 않는 값.
  const oldHeadApproval: ApprovalRequest = {
    approvalId: randomUUID(),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    projectId: manifest.projectId,
    runId: "old-head-run",
    taskId: FIXTURE_TASK_ID,
    approvalType: "CHECKPOINT_SCOPE_VIOLATION",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: randomUUID(),
    status: "PENDING",
    remotelyApprovable: false,
    requiresSafetyRecheck: true,
    dedupeKey: `old-head-dk-${randomUUID()}`,
    expectedGitHead: staleHead,
    expectedBranch: "main",
  };
  approvalStore.createPending(oldHeadApproval);

  const outcome = ensureDurableApprovalForGenuineWaitingHuman(FIXTURE_TASK_ID, { approvalStore, statePath, manifest });
  check("D) 아직 만료되지 않은 old-HEAD PENDING이 있어도 current HEAD 기준 새 approval을 별도로 생성함", outcome.kind === "CREATED");
  if (outcome.kind === "CREATED") {
    check("D) 새 approval의 expectedGitHead는 실제 현재 HEAD(old-HEAD와 다름)", outcome.approval.expectedGitHead === getCurrentHeadHash(root) && outcome.approval.expectedGitHead !== staleHead);
    check("D) old-HEAD approval과는 다른 approvalId", outcome.approval.approvalId !== oldHeadApproval.approvalId);
  }
  check("D) old-HEAD approval은 삭제/수정되지 않고 그대로 PENDING(operator가 stale 여부를 expectedGitHead 비교로 구분 가능)", approvalStore.get(oldHeadApproval.approvalId)?.status === "PENDING" && approvalStore.get(oldHeadApproval.approvalId)?.expectedGitHead === staleHead);
}

// ---------------------------------------------------------------------------
// E/I) 이미 유효한 matching PENDING(정상 event 기반 경로가 만든 것 포함) → 재사용, duplicate
//      없음. 기존 event 기반 생성 경로(createApprovalRequestsFromEvents가 쓰는 것과 동일한
//      buildApprovalRequest())는 회귀 없이 그대로 유지됨을 함께 확인한다.
// ---------------------------------------------------------------------------
function scenarioReusesValidEventBasedApprovalWithoutDuplicating(): void {
  const root = makeGitRepo("orphaned-gate-reuse-event-based-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath, `fixture-orphaned-${randomUUID()}`);
  const approvalStore = createInMemoryApprovalStore();
  const currentHead = getCurrentHeadHash(root);
  const currentBranch = getCurrentBranch(root);

  // 정상 production 경로(autodev.ts emitEvent → approval-service.ts
  // createApprovalRequestsFromEvents)가 만드는 것과 동일한 건축 함수를 그대로 재사용해 "이미
  // 정상적으로 만들어진 event 기반 approval"을 흉내낸다.
  const eventBased = buildApprovalRequest(
    {
      eventType: "HUMAN_APPROVAL_REQUIRED",
      reason: CHECKPOINT_SCOPE_VIOLATION_REASON,
      runId: "real-run",
      taskId: FIXTURE_TASK_ID,
      projectId: manifest.projectId,
      eventId: randomUUID(),
    },
    `real-run::${FIXTURE_TASK_ID}::HUMAN_APPROVAL_REQUIRED::-`,
    { expectedGitHead: currentHead, expectedBranch: currentBranch }
  );
  approvalStore.createPending(eventBased);

  const outcome = ensureDurableApprovalForGenuineWaitingHuman(FIXTURE_TASK_ID, { approvalStore, statePath, manifest });
  check("E/I) 정상 event 기반 경로가 이미 만든 valid approval을 그대로 재사용함(REUSED_EXISTING)", outcome.kind === "REUSED_EXISTING");
  if (outcome.kind === "REUSED_EXISTING") {
    check("E/I) 재사용된 approval이 실제로 그 event 기반 approval임", outcome.approval.approvalId === eventBased.approvalId);
    check("E/I) 그 approval의 sourceKind는 여전히 EVENT(recovery가 provenance를 덮어쓰지 않음)", outcome.approval.sourceKind === "EVENT");
  }
  check(
    "E/I) 새 approval이 추가로 생성되지 않음(정확히 1건)",
    approvalStore.list({}).filter((r) => r.projectId === manifest.projectId && r.taskId === FIXTURE_TASK_ID).length === 1
  );
}

// ---------------------------------------------------------------------------
// F) technical WAITING_HUMAN → human approval 생성 0.
// ---------------------------------------------------------------------------
function scenarioTechnicalWaitingHumanCreatesNothing(): void {
  const root = makeGitRepo("orphaned-gate-technical-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, { deferredHumanTasks: [`${REVIEW_CYCLE_EXHAUSTED_REASON}: 재현된 required test 실패`] });
  const manifest = buildManifest(root, statePath, `fixture-orphaned-${randomUUID()}`);
  const approvalStore = createInMemoryApprovalStore();

  const outcome = ensureDurableApprovalForGenuineWaitingHuman(FIXTURE_TASK_ID, { approvalStore, statePath, manifest });
  check(
    "F) technical WAITING_HUMAN(REVIEW_CYCLE_EXHAUSTED)에는 approval을 생성하지 않음(NOT_APPLICABLE)",
    outcome.kind === "NOT_APPLICABLE" && outcome.reason === "NOT_A_GENUINE_HUMAN_GATE"
  );
  check("F) ApprovalStore에 아무것도 생기지 않음", approvalStore.list({}).length === 0);
}

// ---------------------------------------------------------------------------
// G) state가 READY 등 WAITING_HUMAN이 아님 → approval 생성 0.
// ---------------------------------------------------------------------------
function scenarioNonWaitingHumanStateCreatesNothing(): void {
  const root = makeGitRepo("orphaned-gate-not-waiting-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, { status: "READY", deferredHumanTasks: [] });
  const manifest = buildManifest(root, statePath, `fixture-orphaned-${randomUUID()}`);
  const approvalStore = createInMemoryApprovalStore();

  const outcome = ensureDurableApprovalForGenuineWaitingHuman(FIXTURE_TASK_ID, { approvalStore, statePath, manifest });
  check(
    "G) status=READY면 approval을 생성하지 않음(NOT_APPLICABLE/STATE_NOT_WAITING_HUMAN)",
    outcome.kind === "NOT_APPLICABLE" && outcome.reason === "STATE_NOT_WAITING_HUMAN"
  );
  check("G) ApprovalStore에 아무것도 생기지 않음", approvalStore.list({}).length === 0);
}

// ---------------------------------------------------------------------------
// H) 알려진 marker가 전혀 없는 fail-closed genuine 케이스 — 그래도 human gate가 영구히
//    고립되지 않는다(§ 요구사항 A). classifyWaitingHumanReason()의 fail-closed 기본값을
//    그대로 신뢰한다(새 판정을 만들지 않음).
// ---------------------------------------------------------------------------
function scenarioUnmarkedFailClosedGenuineStillGetsApproval(): void {
  const root = makeGitRepo("orphaned-gate-unmarked-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, { deferredHumanTasks: [] }); // 알려진 마커 전혀 없음, humanFinalReview도 없음.
  const manifest = buildManifest(root, statePath, `fixture-orphaned-${randomUUID()}`);
  const approvalStore = createInMemoryApprovalStore();

  const outcome = ensureDurableApprovalForGenuineWaitingHuman(FIXTURE_TASK_ID, { approvalStore, statePath, manifest });
  check("H) 알려진 마커가 전혀 없는 fail-closed genuine에도 human gate가 고립되지 않고 approval이 생성됨", outcome.kind === "CREATED");
  if (outcome.kind === "CREATED") {
    check("H) 구체적 사유를 재구성할 수 없으므로 범용 GENUINE_STATE_RECOVERY로 정직하게 남음", outcome.approval.approvalType === "GENUINE_STATE_RECOVERY");
    check("H) remotelyApprovable=false(범용 타입도 원격 승인 불가)", outcome.approval.remotelyApprovable === false);
  }
}

// ---------------------------------------------------------------------------
// J) 동일 blocker에 대한 concurrent child process recovery → exactly one.
// ---------------------------------------------------------------------------
async function scenarioConcurrentSameBlockerRecoveryExactlyOne(): Promise<void> {
  const workerPath = join(__dirname, "orphaned-human-gate-recovery-worker.js");
  if (!existsSync(workerPath)) {
    check("J) (컴파일된 worker 스크립트를 찾지 못해 스킵 — npm run build 필요)", true);
    return;
  }
  const root = makeGitRepo("orphaned-gate-concurrent-same-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const projectId = `fixture-orphaned-concurrent-${randomUUID()}`;
  const approvalStoreFilePath = join(mkdtempSync(join(tmpdir(), "orphaned-gate-store-")), "approvals.json");

  function runWorker(): Promise<{ kind: string; approvalId: string | null }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [workerPath, statePath, approvalStoreFilePath, projectId, root, FIXTURE_TASK_ID]);
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("close", () => {
        try {
          resolve(JSON.parse(out.trim().split("\n").pop() || "{}"));
        } catch {
          resolve({ kind: "PARSE_ERROR", approvalId: null });
        }
      });
    });
  }

  const N = 5;
  const outs = await Promise.all(Array.from({ length: N }, () => runWorker()));
  const createdCount = outs.filter((o) => o.kind === "CREATED").length;
  const approvalIds = new Set(outs.map((o) => o.approvalId).filter(Boolean));
  check("J) N개 동시 recovery 시도 중 실제로 생성된 것은 정확히 1건", createdCount === 1);
  check("J) 모든 프로세스가 결국 같은 approvalId 하나로 수렴함", approvalIds.size === 1);

  const finalStore = createFileApprovalStore(approvalStoreFilePath);
  check(
    "J) ApprovalStore 최종 상태에도 이 project/task PENDING approval이 정확히 1건만 존재함(파일 손상 없음)",
    finalStore.list({}).filter((r) => r.projectId === projectId && r.taskId === FIXTURE_TASK_ID).length === 1
  );
}

// ---------------------------------------------------------------------------
// K) multi-project isolation — 서로 다른 project가 같은 file-based ApprovalStore를 동시에
//    써도 서로의 approval/state를 오염시키지 않는다.
// ---------------------------------------------------------------------------
async function scenarioMultiProjectIsolation(): Promise<void> {
  const workerPath = join(__dirname, "orphaned-human-gate-recovery-worker.js");
  if (!existsSync(workerPath)) {
    check("K) (컴파일된 worker 스크립트를 찾지 못해 스킵 — npm run build 필요)", true);
    return;
  }
  const rootA = makeGitRepo("orphaned-gate-multi-a-");
  const rootB = makeGitRepo("orphaned-gate-multi-b-");
  const statePathA = join(rootA, ".autodev", "project-state.json");
  const statePathB = join(rootB, ".autodev", "project-state.json");
  writeStateFile(statePathA, {});
  writeStateFile(statePathB, {});
  const projectA = `fixture-orphaned-A-${randomUUID()}`;
  const projectB = `fixture-orphaned-B-${randomUUID()}`;
  const sharedStoreFilePath = join(mkdtempSync(join(tmpdir(), "orphaned-gate-shared-store-")), "approvals.json");

  function runWorker(statePath: string, projectId: string, root: string): Promise<{ kind: string; approvalId: string | null; projectId: string | null }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [workerPath, statePath, sharedStoreFilePath, projectId, root, FIXTURE_TASK_ID]);
      let out = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.on("close", () => {
        try {
          resolve(JSON.parse(out.trim().split("\n").pop() || "{}"));
        } catch {
          resolve({ kind: "PARSE_ERROR", approvalId: null, projectId: null });
        }
      });
    });
  }

  const [outA, outB] = await Promise.all([runWorker(statePathA, projectA, rootA), runWorker(statePathB, projectB, rootB)]);
  check("K) project A recovery 성공(CREATED)", outA.kind === "CREATED");
  check("K) project B recovery 성공(CREATED)", outB.kind === "CREATED");
  check("K) project A approval의 projectId는 A", outA.projectId === projectA);
  check("K) project B approval의 projectId는 B", outB.projectId === projectB);
  check("K) 서로 다른 approvalId(혼입 없음)", outA.approvalId !== outB.approvalId);

  const finalStore = createFileApprovalStore(sharedStoreFilePath);
  const allRecords = finalStore.list({});
  check("K) 공유 ApprovalStore에 A/B 각각 정확히 1건씩만 존재함", allRecords.filter((r) => r.projectId === projectA).length === 1 && allRecords.filter((r) => r.projectId === projectB).length === 1);

  const stateAAfter = readState(statePathA);
  const stateBAfter = readState(statePathB);
  check("K) project A의 state.json은 project B recovery로 오염되지 않음", stateAAfter.deferredHumanTasks.every((m) => !m.includes(projectB)));
  check("K) project B의 state.json은 project A recovery로 오염되지 않음", stateBAfter.deferredHumanTasks.every((m) => !m.includes(projectA)));
}

// ---------------------------------------------------------------------------
// L/N) 실제 approval → resume E2E(+ stale project lock이 있어도 기존 acquireProjectLock()
//      경로로 정상 회수되어 재개됨을 함께 확인).
// ---------------------------------------------------------------------------
async function scenarioFullApprovalResumeE2EWithStaleLock(): Promise<void> {
  const root = makeGitRepo("orphaned-gate-e2e-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath, `fixture-orphaned-e2e-${randomUUID()}`);
  const approvalStore = createInMemoryApprovalStore();

  // N) stale project lock — 이미 죽은 PID가 소유한 lock 파일을 실제 운용 lock 디렉터리에
  // 직접 만들어둔다(§ project-lock-tests.ts와 동일한 "실제로 종료된 child" 패턴). 이 project의
  // canonicalProjectPath는 이 fixture 임시 디렉터리 기준이라 실제 다른 project의 lock과
  // 절대 경로가 겹치지 않는다.
  const deadChild = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = deadChild.pid;
  if (typeof deadPid === "number") {
    const canonicalProjectPath = resolveCanonicalProjectPath(root);
    const lockFilePath = debugComputeLockFilePath(canonicalProjectPath, RUNTIME_LOCK_DIR);
    mkdirSync(join(lockFilePath, ".."), { recursive: true });
    writeFileSync(
      lockFilePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          projectId: manifest.projectId,
          canonicalProjectPath,
          lockId: randomUUID(),
          pid: deadPid,
          processStartedAtMs: Date.now() - 600_000,
          lockCreatedAt: new Date().toISOString(),
          ownerKind: "autodev",
        },
        null,
        2
      )}\n`,
      "utf-8"
    );
  }

  const ensured = ensureDurableApprovalForGenuineWaitingHuman(FIXTURE_TASK_ID, { approvalStore, statePath, manifest });
  check("L) recovery가 먼저 valid PENDING approval을 만듦", ensured.kind === "CREATED");
  if (ensured.kind !== "CREATED") return;

  const result = await performLocalHumanApproval(
    { approvalId: ensured.approval.approvalId, taskId: FIXTURE_TASK_ID, approvedBy: "e2e-operator" },
    {
      approvalStore,
      statePath,
      manifest,
      orchestratorDeps: { claudeRunner: makeFakeClaudeRunner(root), gptReviewer: fakeGptReviewer },
    }
  );
  check("L) 기존 performLocalHumanApproval()로 정상 승인/재개됨(RESUMED)", result.kind === "RESUMED");
  if (result.kind === "RESUMED") {
    check(
      "L/N) stale lock이 있어도 기존 acquireProjectLock()의 stale 회수 경로로 정상 완료됨(COMPLETED, 별도 unlink 없이)",
      result.outcome.kind === "COMPLETED"
    );
    if (result.outcome.kind === "COMPLETED") {
      check("L) 최종 outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", result.outcome.result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
    }
  }
  check("L) ApprovalStore가 PENDING -> APPROVED로 전이됨", approvalStore.get(ensured.approval.approvalId)?.status === "APPROVED");
  const finalState = readState(statePath);
  check("L) task가 completedTasks에 반영됨", finalState.completedTasks.includes(FIXTURE_TASK_ID));
}

// ---------------------------------------------------------------------------
// M) scope-violation의 원인 파일이 여전히 존재하면(사람이 아직 지우지 않음) — 자동 삭제/자동
//    commit 없이, 다음 checkpoint가 다시 안전하게 BLOCK된다(§ 요구사항 15 — approval은
//    "사람이 판단했다"는 뜻일 뿐 파일 제거 권한이 아니다).
// ---------------------------------------------------------------------------
async function scenarioLeftoverFileNotAutoDeletedAndBlocksAgain(): Promise<void> {
  const root = makeGitRepo("orphaned-gate-leftover-");
  const statePath = join(root, ".autodev", "project-state.json");
  // task-change-baseline.ts — baseline은 반드시 leftover 파일이 생기기 "전"에 캡처해야 한다.
  // 그래야 이 파일이 "task 시작 전부터 있던 무관한 파일"이 아니라 "이번 attempt 동안 새로
  // 생긴 unexpected 변경"으로 정확히 분류된다(§ 실제 JARVIS 사고와 동일한 순서 — baseline이
  // 그 사고파일들보다 먼저 캡처되어 있었기 때문에 unexpected로 잡혔다).
  const baseline = captureTaskChangeBaseline(FIXTURE_TASK_ID, root);
  const leftoverFileName = "leftover-out-of-scope.txt";
  writeFileSync(join(root, leftoverFileName), "이 파일은 task의 allowedPathPrefixes 밖입니다.\n");
  writeStateFile(statePath, { deferredHumanTasks: [GENUINE_SCOPE_VIOLATION_MARKER(FIXTURE_TASK_ID, leftoverFileName)], taskChangeBaseline: baseline });
  const manifest = buildManifest(root, statePath, `fixture-orphaned-leftover-${randomUUID()}`);
  const approvalStore = createInMemoryApprovalStore();

  const ensured = ensureDurableApprovalForGenuineWaitingHuman(FIXTURE_TASK_ID, { approvalStore, statePath, manifest });
  check("M) recovery approval 생성됨", ensured.kind === "CREATED");
  if (ensured.kind !== "CREATED") return;

  // approve/resume 이전에, 이 정확한 baseline+working tree로 기존 checkpoint.ts
  // computeCommitPlan()을 직접 호출해 "원인 파일이 여전히 unexpected로 잡히는가"를 checkpoint
  // 자신의 fail-closed 판정으로 직접 확인한다(§ 요구사항 15 — 이 판정 로직 자체는 이번
  // 수정으로 전혀 건드리지 않았다는 회귀 확인. orchestrator.ts의 attempt/resume 생명주기
  // 세부사항 — 언제 baseline을 재캡처하는지 등 — 은 이번 defect의 범위 밖이라 그 경로를
  // 통해 간접적으로 재확인하지 않는다).
  const planBeforeResume = computeCommitPlan(manifest.taskRegistry[0], root, [], baseline);
  check(
    "M) checkpoint.ts computeCommitPlan()이 원인 파일을 여전히 unexpected로 분류함(자동 commit 대상 아님, 회귀 없음)",
    planBeforeResume.unexpected.some((c) => c.path === leftoverFileName)
  );
  check("M) 원인 파일이 allowed(자동 commit 대상)로는 절대 분류되지 않음", !planBeforeResume.allowed.some((c) => c.path === leftoverFileName));

  const result = await performLocalHumanApproval(
    { approvalId: ensured.approval.approvalId, taskId: FIXTURE_TASK_ID, approvedBy: "e2e-operator" },
    {
      approvalStore,
      statePath,
      manifest,
      // fake developer는 leftoverFileName을 전혀 건드리지 않는다 — 여전히 out-of-scope 상태로
      // working tree에 남아있다.
      orchestratorDeps: { claudeRunner: makeFakeClaudeRunner(root), gptReviewer: fakeGptReviewer },
    }
  );
  check("M) 승인/재개 자체는 진행됨(RESUMED)", result.kind === "RESUMED");
  check("M) 원인 파일이 자동으로 삭제되지 않고 여전히 디스크에 존재함(approval은 파일 제거 권한이 아님)", existsSync(join(root, leftoverFileName)));
}

// ---------------------------------------------------------------------------
// O) recovery가 만든 approval도 만료되면 여전히 APPROVAL_EXPIRED(특별 취급 없음).
// ---------------------------------------------------------------------------
async function scenarioExpiredRecoveryApprovalStillRejected(): Promise<void> {
  const root = makeGitRepo("orphaned-gate-recovery-expired-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath, `fixture-orphaned-${randomUUID()}`);
  const approvalStore = createInMemoryApprovalStore();

  const ensured = ensureDurableApprovalForGenuineWaitingHuman(FIXTURE_TASK_ID, {
    approvalStore,
    statePath,
    manifest,
    now: () => new Date("2020-01-01T00:00:00.000Z"),
  });
  check("O) 과거 시각 기준으로 recovery approval 생성됨(테스트 셋업)", ensured.kind === "CREATED");
  if (ensured.kind !== "CREATED") return;

  const result = await performLocalHumanApproval(
    { approvalId: ensured.approval.approvalId, taskId: FIXTURE_TASK_ID, approvedBy: "operator" },
    { approvalStore, statePath, manifest, now: () => new Date("2026-01-01T00:00:00.000Z") }
  );
  check("O) recovery가 만든 approval도 만료되면 여전히 APPROVAL_EXPIRED로 거부됨(특별 취급 없음)", result.kind === "REJECTED" && result.reason === "APPROVAL_EXPIRED");
  check("O) 만료된 요청은 임의로 소생되지 않음(여전히 PENDING)", approvalStore.get(ensured.approval.approvalId)?.status === "PENDING");
}

async function main(): Promise<void> {
  try {
    scenarioCreatesFreshApprovalWhenNoneExists();
    scenarioRepeatedCallDoesNotDuplicate();
    scenarioExpiredOldApprovalDoesNotBlockNewOne();
    scenarioOldHeadApprovalDoesNotSupersedeCurrentHead();
    scenarioReusesValidEventBasedApprovalWithoutDuplicating();
    scenarioTechnicalWaitingHumanCreatesNothing();
    scenarioNonWaitingHumanStateCreatesNothing();
    scenarioUnmarkedFailClosedGenuineStillGetsApproval();
    await scenarioConcurrentSameBlockerRecoveryExactlyOne();
    await scenarioMultiProjectIsolation();
    await scenarioFullApprovalResumeE2EWithStaleLock();
    await scenarioLeftoverFileNotAutoDeletedAndBlocksAgain();
    await scenarioExpiredRecoveryApprovalStillRejected();
  } finally {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // OS 임시 디렉터리 — 정리 실패는 테스트 결과에 영향 없음.
      }
    }
  }

  console.log("\n=== orphaned-human-gate 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
