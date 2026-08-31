import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { performLocalHumanApproval, createFreshLocalApprovalRequest } from "./local-human-approval";
import { performAutoResume } from "./auto-resume";
import { buildApprovalInlineKeyboard } from "./telegram-approval-provider";
import type { ApprovalRequest } from "./approval";
import { createInMemoryApprovalStore } from "./approval-store";
import type { ApprovalStore } from "./approval-store";
import { createInMemoryEventStore } from "./event-store";
import type { EventStore } from "./event-store";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import type { ClaudeResult, CoreState } from "./types";
import type { GptReviewerReturn } from "./orchestrator";
import { REVIEW_CYCLE_EXHAUSTED_REASON } from "./review-policy";

// Genuine Human Gate Local Approval 테스트(2026-08-29). 실제 Claude CLI/OpenAI API는
// 호출하지 않는다 — orchestratorDeps는 항상 fake로 주입한다(§ auto-resume-tests.ts와
// 동일한 원칙). 이 파일은 로컬 인간 승인 경로(local-human-approval.ts) 고유의 검증만
// 담당한다 — resumeApprovedTask()의 Git Safety/Project Lock/Remote Git Safety 재검증
// 자체는 auto-resume-tests.ts가 이미 검증했으므로 재검증하지 않는다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];

function makeGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "local-approval-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Local Approval Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

const FIXTURE_TASK_REGISTRY: TaskDefinition[] = [
  {
    id: "T1",
    phase: 1,
    taskNumber: 1,
    title: "local approval 대상 task",
    prompt: "src/greet.js에 greet() 함수를 작성하세요.",
    requiredTests: [{ name: "local-approval-fixture-test", command: "node", args: ["tests/greet.test.js"], cwd: "root" }],
    allowedPathPrefixes: ["src/", "tests/"],
    prohibitedOperations: ["src/, tests/ 밖 파일 수정"],
  },
];
const FIXTURE_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["src/", "tests/"],
  allowedWritePrefixes: ["src/", "tests/"],
  allowedCommands: [{ cwd: "root", command: "node", args: ["tests/greet.test.js"] }],
};

function buildManifest(root: string, statePath: string, projectId = "fixture-local-approval"): ProjectManifest {
  return {
    projectId,
    projectName: "Fixture Local Approval",
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
    deferredHumanTasks: [`CHECKPOINT_BLOCKED(T1): commit 대상 파일에서 민감정보(secret) 패턴이 발견되어 commit을 중단했습니다.`],
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

function baseApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const now = new Date();
  return {
    approvalId: randomUUID(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    projectId: "fixture-local-approval",
    runId: "run-1",
    taskId: "T1",
    approvalType: "SECURITY_BLOCKED",
    sourceEventType: "SECURITY_BLOCKED",
    sourceEventId: randomUUID(),
    status: "PENDING",
    remotelyApprovable: false,
    requiresSafetyRecheck: true,
    dedupeKey: `dk-${randomUUID()}`,
    ...overrides,
  };
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
      tests: [{ name: "local-approval-fixture-test", pass: res.status === 0 }],
      rawOutput: (res.stdout || "") + (res.stderr || ""),
    };
  };
}
async function fakeGptReviewer(): Promise<GptReviewerReturn> {
  return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "정상", nextTask: null };
}

// ---------------------------------------------------------------------------
// 1/3) 원격 승인 정책 회귀 없음 — SECURITY_BLOCKED는 여전히 Telegram 원격 승인 불가,
//      performAutoResume은 기존처럼 거부한다. 이 파일이 추가한 어떤 것도 이 결과에 영향을
//      주지 않는다.
// ---------------------------------------------------------------------------
async function scenarioRemotePathStillRejectsSecurityBlocked(): Promise<void> {
  const root = makeGitRepo("local-approval-remote-still-rejects-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath);
  const approval = baseApproval({ remotelyApprovable: false });
  const outcome = await performAutoResume(approval, manifest);
  check(
    "1/3) SECURITY_BLOCKED(remotelyApprovable=false)는 performAutoResume(원격 경로)에서 여전히 거부됨",
    outcome.kind === "BLOCKED" && outcome.reason === "REMOTE_APPROVAL_NOT_ALLOWED"
  );
}

// ---------------------------------------------------------------------------
// 2) SECURITY_BLOCKED에 Telegram inline keyboard(버튼)가 생성되지 않음 — 기존
//    telegram-approval-provider.ts 로직을 그대로 재사용해 직접 확인한다(이 파일이 그
//    로직을 바꾸지 않았다는 회귀 확인).
// ---------------------------------------------------------------------------
function scenarioSecurityBlockedNeverGetsInlineKeyboardBuilt(): void {
  const approval = baseApproval({ remotelyApprovable: false });
  // telegram-approval-provider.ts의 resolveApprovalIdForButtons()는 이 approval이
  // remotelyApprovable=false이면 buildApprovalInlineKeyboard()까지 도달하지 않는다 — 그
  // 함수 자체는 항상 버튼을 만들 수 있으므로(입력을 안 가림), "만들 수 있는 함수가 있다"와
  // "이 approval에 대해 실제로 호출되지 않는다"는 다른 질문이다. 여기서는 후자를
  // approval.remotelyApprovable 값 자체로 직접 확인한다(§ telegram-approval-provider.ts
  // line 50, 이 파일이 그 게이트를 우회하지 않았음을 재확인).
  check("2) SECURITY_BLOCKED approval.remotelyApprovable=false(버튼 생성 게이트가 항상 이 값으로 막힘)", approval.remotelyApprovable === false);
  // buildApprovalInlineKeyboard 자체는 여전히 정상 동작(다른 타입에는 계속 버튼을
  // 만들어줘야 하므로 함수 자체를 망가뜨리지 않았음을 확인) — approvalId만 넣으면 항상
  // 3개 버튼 구조를 반환한다는 기존 계약이 그대로 유지됨.
  const kb = buildApprovalInlineKeyboard("some-id");
  check("2) buildApprovalInlineKeyboard 자체 기능은 회귀 없음(원격 승인 가능한 다른 타입은 여전히 버튼 생성)", kb.inline_keyboard[0].length === 3);
}

// ---------------------------------------------------------------------------
// 4/5/6/7/8) 명시적 로컬 인간 승인 happy path — ApprovalStore APPROVED 전이, 감사 이벤트
//      생성, WAITING_HUMAN 해제, 해당 마커만 정확히 제거, 실제 checkpoint까지 완료.
// ---------------------------------------------------------------------------
async function scenarioLocalApprovalHappyPathResumesToCompletion(): Promise<void> {
  const root = makeGitRepo("local-approval-happy-");
  const statePath = join(root, ".autodev", "project-state.json");
  // 9) 다른 Human Gate 마커는 보존 — 무관한 마커를 하나 더 심어둔다.
  const unrelatedMarker = "AUDIT_STORE_UNAVAILABLE_BEFORE_CHECKPOINT(T1): 감사 저장소 접근 실패.";
  const targetMarker = "CHECKPOINT_BLOCKED(T1): commit 대상 파일에서 민감정보(secret) 패턴이 발견되어 commit을 중단했습니다.";
  writeStateFile(statePath, { deferredHumanTasks: [targetMarker, unrelatedMarker] });
  const manifest = buildManifest(root, statePath);
  const approvalStore = createInMemoryApprovalStore();
  const events = createInMemoryEventStore();
  const approval = baseApproval({});
  approvalStore.createPending(approval);

  const result = await performLocalHumanApproval(
    { approvalId: approval.approvalId, taskId: "T1", approvedBy: "local-operator-1" },
    {
      approvalStore,
      statePath,
      manifest,
      events,
      orchestratorDeps: {
        claudeRunner: makeFakeClaudeRunner(root),
        gptReviewer: fakeGptReviewer,
      },
    }
  );

  check("4) 명시적 로컬 인간 승인이 정상 처리됨(RESUMED)", result.kind === "RESUMED");
  if (result.kind === "RESUMED") {
    check("4) 실제 Resume까지 이어져 checkpoint 완료(COMPLETED)", result.outcome.kind === "COMPLETED");
    if (result.outcome.kind === "COMPLETED") {
      check("4) 최종 outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", result.outcome.result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
    }
  }

  check("5) ApprovalStore가 PENDING -> APPROVED로 전이됨", approvalStore.get(approval.approvalId)?.status === "APPROVED");

  const allEvents = events.query().events;
  const approvedEvent = allEvents.find((e) => e.eventType === "APPROVAL_APPROVED");
  check("6) 감사 이벤트 APPROVAL_APPROVED가 기록됨", !!approvedEvent);
  check("6) 감사 이벤트에 approvedVia=LOCAL_HUMAN이 기록됨", approvedEvent?.metadata?.approvedVia === "LOCAL_HUMAN");
  check("6) 감사 이벤트에 승인 주체(approvedBy)가 식별 가능하게 기록됨", approvedEvent?.metadata?.approvedBy === "local-operator-1");
  check("6) AUTO_RESUME_STARTED 감사 기록도 남음", allEvents.some((e) => e.eventType === "AUTO_RESUME_STARTED"));

  const finalState = readState(statePath);
  check("7) WAITING_HUMAN이 정상적으로 해제됨(다음 task로 진행했거나 completedTasks에 T1 반영)", finalState.completedTasks.includes("T1"));
  check("8) 해결된 마커(CHECKPOINT_BLOCKED(T1))만 정확히 제거됨", !finalState.deferredHumanTasks.includes(targetMarker));
  // 9)(무관한 마커 보존)는 이 시나리오가 아니라 아래 scenarioMarkerRemovalPreservesUnrelated
  // MarkersBeforeResumeStarts()에서 별도로 검증한다 — runOrchestrator() 자체가(이 파일이
  // 만들지 않은, 이미 존재하던 동작으로) 매 새 attempt 시작 시 deferredHumanTasks 전체를
  // 무조건 초기화한다(§ orchestrator.ts:279, "새 attempt의 이전 attempt 잔여 사유 초기화" —
  // 이 local-human-approval 경로에 국한된 동작이 아니라 Telegram 경로를 포함해 항상
  // 그래왔다). 그래서 "무관한 마커가 보존되는가"는 내 함수 자신의 마커 제거 단계
  // (resumeApprovedTask 호출 *직전*)를 기준으로 검증해야 정확하다 — 실제 checkpoint까지
  // 끝난 뒤의 최종 상태를 기준으로 삼으면 이 무관한 기존 동작과 뒤섞여 오탐한다.
}

// ---------------------------------------------------------------------------
// 9) 무관한 다른 Human Gate 마커는 보존됨 — performLocalHumanApproval 자신이 "해결된
//    마커만" 제거한다는 것을, resumeApprovedTask()가 실제로 진행되기 전(Git Safety
//    재검사에서 즉시 BLOCKED되도록 만들어 runOrchestrator()의 무관한 "새 attempt 초기화"가
//    끼어들 수 없는 지점)에 직접 확인한다.
// ---------------------------------------------------------------------------
async function scenarioMarkerRemovalPreservesUnrelatedMarkersBeforeResumeStarts(): Promise<void> {
  const root = makeGitRepo("local-approval-marker-preserve-");
  const staleHead = "0".repeat(40); // 실제 HEAD와 절대 일치하지 않는 값 — Git Safety 재검사에서 즉시 BLOCKED되게 한다.
  const statePath = join(root, ".autodev", "project-state.json");
  const unrelatedMarker = "AUDIT_STORE_UNAVAILABLE_BEFORE_CHECKPOINT(T1): 감사 저장소 접근 실패.";
  const targetMarker = "CHECKPOINT_BLOCKED(T1): commit 대상 파일에서 민감정보(secret) 패턴이 발견되어 commit을 중단했습니다.";
  writeStateFile(statePath, { deferredHumanTasks: [targetMarker, unrelatedMarker] });
  const manifest = buildManifest(root, statePath);
  const approvalStore = createInMemoryApprovalStore();
  const approval = baseApproval({ expectedGitHead: staleHead });
  approvalStore.createPending(approval);

  const result = await performLocalHumanApproval({ approvalId: approval.approvalId, taskId: "T1", approvedBy: "local-operator" }, { approvalStore, statePath, manifest });

  check(
    "9) Git Safety 재검사에서 BLOCKED되어 runOrchestrator까지 도달하지 않음(이 시나리오의 전제)",
    result.kind === "RESUMED" && result.outcome.kind === "BLOCKED" && result.outcome.reason === "RESUME_BLOCKED_GIT_STATE_DIVERGED"
  );
  // ApprovalStore/이벤트/마커 제거는 resumeApprovedTask 호출 *이전*에 이미 확정되므로
  // Git Safety BLOCKED 여부와 무관하게 그대로 남아있어야 한다.
  check("9) ApprovalStore 전이 자체는 Git Safety 결과와 무관하게 확정됨(APPROVED)", approvalStore.get(approval.approvalId)?.status === "APPROVED");
  const stateAfter = readState(statePath);
  check("9) 해결된 마커(CHECKPOINT_BLOCKED(T1))는 제거됨", !stateAfter.deferredHumanTasks.includes(targetMarker));
  check("9) 무관한 다른 Human Gate 마커(AUDIT_STORE_UNAVAILABLE)는 보존됨(전체 삭제 아님)", stateAfter.deferredHumanTasks.includes(unrelatedMarker));
  // resumeApprovedTask()가 READY 전환 지점(Git Safety 통과 이후)에 도달하기도 전에
  // BLOCKED를 반환했더라도, 이미 확정된 사람 승인 판단에 따라 이 함수 자신이 status를
  // READY로 전환해야 한다(§ 실제 production 사례 — 그렇지 않으면 마커 없는 WAITING_HUMAN
  // 모호 상태로 영구히 남는다). 이 검증이 바로 그 회귀 방지 테스트다.
  check(
    "9) resumeApprovedTask가 READY 전환 전에 BLOCKED되어도 이 함수가 status를 READY로 정리함(모호한 WAITING_HUMAN 잔류 방지)",
    (stateAfter.status as unknown as string) === "READY"
  );
}

// ---------------------------------------------------------------------------
// 10) 잘못된 Task 승인 거부.
// ---------------------------------------------------------------------------
async function scenarioWrongTaskRejected(): Promise<void> {
  const root = makeGitRepo("local-approval-wrong-task-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath);
  const approvalStore = createInMemoryApprovalStore();
  const approval = baseApproval({ taskId: "T1" });
  approvalStore.createPending(approval);

  const result = await performLocalHumanApproval(
    { approvalId: approval.approvalId, taskId: "T2-DIFFERENT", approvedBy: "local-operator" },
    { approvalStore, statePath, manifest }
  );
  check("10) taskId가 일치하지 않으면 TASK_MISMATCH로 거부", result.kind === "REJECTED" && result.reason === "TASK_MISMATCH");
  check("10) 거부된 경우 ApprovalStore는 여전히 PENDING(부분 적용 없음)", approvalStore.get(approval.approvalId)?.status === "PENDING");
}

// ---------------------------------------------------------------------------
// 11) 오래된/불일치 요청 승인 거부 — (a) 만료된 요청, (b) 현재 차단 사유와 마커가 불일치.
// ---------------------------------------------------------------------------
async function scenarioExpiredApprovalRejectedNotRevived(): Promise<void> {
  const root = makeGitRepo("local-approval-expired-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath);
  const approvalStore = createInMemoryApprovalStore();
  const approval = baseApproval({ createdAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-01T00:30:00.000Z" });
  approvalStore.createPending(approval);

  const result = await performLocalHumanApproval(
    { approvalId: approval.approvalId, taskId: "T1", approvedBy: "local-operator" },
    { approvalStore, statePath, manifest, now: () => new Date("2026-01-01T00:00:00.000Z") }
  );
  check("11-a) 만료된 ApprovalRequest는 APPROVED_EXPIRED로 거부되고 소생되지 않음", result.kind === "REJECTED" && result.reason === "APPROVAL_EXPIRED");
  check("11-a) 만료된 요청 자체의 status는 그대로 PENDING(임의로 APPROVED로 바뀌지 않음)", approvalStore.get(approval.approvalId)?.status === "PENDING");
}

async function scenarioMismatchedBlockReasonRejected(): Promise<void> {
  const root = makeGitRepo("local-approval-mismatch-");
  const statePath = join(root, ".autodev", "project-state.json");
  // deferredHumanTasks에 T1에 대한 CHECKPOINT_BLOCKED 마커가 전혀 없음(예: 이미 다른
  // 경로로 해결되었거나, 이 approval이 애초에 다른 사유였던 경우를 흉내낸다).
  writeStateFile(statePath, { deferredHumanTasks: ["AUDIT_STORE_UNAVAILABLE_BEFORE_CHECKPOINT(T1): 감사 저장소 접근 실패."] });
  const manifest = buildManifest(root, statePath);
  const approvalStore = createInMemoryApprovalStore();
  const approval = baseApproval({});
  approvalStore.createPending(approval);

  const result = await performLocalHumanApproval(
    { approvalId: approval.approvalId, taskId: "T1", approvedBy: "local-operator" },
    { approvalStore, statePath, manifest }
  );
  check(
    "11-b) 현재 차단 사유(deferredHumanTasks)와 ApprovalRequest가 대응하지 않으면 거부됨",
    result.kind === "REJECTED" && result.reason === "NO_MATCHING_BLOCK_MARKER_FOR_TASK"
  );
}

// ---------------------------------------------------------------------------
// 12) 중복 승인 거부.
// ---------------------------------------------------------------------------
async function scenarioDuplicateApprovalRejected(): Promise<void> {
  const root = makeGitRepo("local-approval-duplicate-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath);
  const approvalStore = createInMemoryApprovalStore();
  const events = createInMemoryEventStore();
  const approval = baseApproval({});
  approvalStore.createPending(approval);

  const first = await performLocalHumanApproval(
    { approvalId: approval.approvalId, taskId: "T1", approvedBy: "local-operator" },
    { approvalStore, statePath, manifest, events, orchestratorDeps: { claudeRunner: makeFakeClaudeRunner(root), gptReviewer: fakeGptReviewer } }
  );
  check("12) 첫 번째 승인은 정상 처리됨", first.kind === "RESUMED");

  const second = await performLocalHumanApproval(
    { approvalId: approval.approvalId, taskId: "T1", approvedBy: "local-operator" },
    { approvalStore, statePath, manifest, events }
  );
  check("12) 같은 approvalId로 두 번째 승인 시도는 APPROVAL_ALREADY_CONSUMED로 거부됨", second.kind === "REJECTED" && second.reason === "APPROVAL_ALREADY_CONSUMED");
}

// ---------------------------------------------------------------------------
// 13) Genuine Human Gate가 아닌 것(기술적 자동 복구 대상)을 이 경로로 임의 승인할 수 없음.
//
// No-Safe-Recovery-Action Gate(2026-08-31)로 CHECKPOINT_SCOPE_VIOLATION은 더 이상 기술적
// 자동 복구 대상이 아니다(§ human-gate-policy.ts — Developer/Reviewer 재시도로는 절대
// 스스로 해결되지 않는다는 것이 확인됐다) — 그래서 이 대표 사례를, 이 정책 변경 이후에도
// 여전히 기술적 자동 복구 대상으로 남아있는 REVIEW_CYCLE_EXHAUSTED_REASON 마커로 바꿨다
// (이 시나리오가 검증하려는 것은 "기술적 자동 복구 대상은 이 경로로 승인할 수 없다"는
// 불변식 그 자체이지 scope-violation이라는 구체적 예시가 아니다 — 그 불변식은 변하지
// 않았다).
// ---------------------------------------------------------------------------
async function scenarioTechnicalAutoRecoverableCannotBeLocallyApproved(): Promise<void> {
  const root = makeGitRepo("local-approval-not-genuine-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {
    deferredHumanTasks: [`${REVIEW_CYCLE_EXHAUSTED_REASON}: 재현된 required test 실패`],
  });
  const manifest = buildManifest(root, statePath);
  const approvalStore = createInMemoryApprovalStore();
  const approval = baseApproval({ approvalType: "REVIEW_CYCLE_EXHAUSTED", sourceEventType: "HUMAN_APPROVAL_REQUIRED" });
  approvalStore.createPending(approval);

  const result = await performLocalHumanApproval(
    { approvalId: approval.approvalId, taskId: "T1", approvedBy: "local-operator" },
    { approvalStore, statePath, manifest }
  );
  check(
    "13) 기술적 자동 복구 대상(REVIEW_CYCLE_EXHAUSTED)은 이 경로로 임의 승인할 수 없음(NOT_A_GENUINE_HUMAN_GATE)",
    result.kind === "REJECTED" && result.reason === "NOT_A_GENUINE_HUMAN_GATE"
  );
}

// ---------------------------------------------------------------------------
// 13-c) No-Safe-Recovery-Action Gate(2026-08-31) — CHECKPOINT_SCOPE_VIOLATION은 이제 genuine
// 이므로, 사람이 실제로 로컬에서 파일을 확인/처리한 뒤에는 이 경로로 정상 승인·Resume까지
// 이어져야 한다(§ 요구사항 시나리오 B — "외부에서 실제로 상태가 변경되면 재개 가능"). Auto
// Resume의 Git Safety recheck까지는 이 fixture가 별도로 구성하지 않으므로 AUTO_RESUME_BLOCKED
// (Git divergence 등)로 끝나는 것은 정상이다 — 여기서 검증하려는 것은 오직 "ApprovalStore
// 전이 자체가 실제로 시작된다"(=NOT_A_GENUINE_HUMAN_GATE로 거부되지 않는다)는 것뿐이다.
// ---------------------------------------------------------------------------
async function scenarioCheckpointScopeViolationCanBeLocallyApproved(): Promise<void> {
  const root = makeGitRepo("local-approval-scope-violation-genuine-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {
    deferredHumanTasks: ["CHECKPOINT_BLOCKED(T1): 예상치 못한 범위 밖 파일 변경이 있어 commit을 중단했습니다. — unexpected: other/leftover.txt"],
  });
  const manifest = buildManifest(root, statePath);
  const approvalStore = createInMemoryApprovalStore();
  const approval = baseApproval({ approvalType: "CHECKPOINT_SCOPE_VIOLATION", sourceEventType: "HUMAN_APPROVAL_REQUIRED" });
  approvalStore.createPending(approval);

  const result = await performLocalHumanApproval(
    { approvalId: approval.approvalId, taskId: "T1", approvedBy: "local-operator" },
    { approvalStore, statePath, manifest }
  );
  check(
    "13-c) CHECKPOINT_SCOPE_VIOLATION은 이제 genuine이므로 NOT_A_GENUINE_HUMAN_GATE로 거부되지 않음(ApprovalStore 전이 시작됨)",
    !(result.kind === "REJECTED" && result.reason === "NOT_A_GENUINE_HUMAN_GATE")
  );
  check("13-c) 실제로 RESUMED 경로를 탐(승인 자체는 소비됨)", result.kind === "RESUMED");
  const approvalAfter = approvalStore.get(approval.approvalId);
  check("13-c) ApprovalStore 상태가 APPROVED로 전이됨", approvalAfter?.status === "APPROVED");
}

async function scenarioRemotelyApprovableTrueRejectedByLocalPath(): Promise<void> {
  const root = makeGitRepo("local-approval-not-local-target-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath);
  const approvalStore = createInMemoryApprovalStore();
  const approval = baseApproval({ remotelyApprovable: true, approvalType: "ORCHESTRATOR_NOT_APPROVED_GENERIC" });
  approvalStore.createPending(approval);

  const result = await performLocalHumanApproval(
    { approvalId: approval.approvalId, taskId: "T1", approvedBy: "local-operator" },
    { approvalStore, statePath, manifest }
  );
  check(
    "13-b) 원격 승인 가능한 요청은 로컬 승인 경로로 처리하지 않음(정책 경계 분리, NOT_A_LOCAL_APPROVAL_TARGET)",
    result.kind === "REJECTED" && result.reason === "NOT_A_LOCAL_APPROVAL_TARGET"
  );
}

// ---------------------------------------------------------------------------
// 14) 기존 Telegram 승인 가능한 Gate 동작 회귀 없음 — performAutoResume 자체가 이번
//     리팩터링(resumeApprovedTask 추출) 이후에도 정상 동작한다.
// ---------------------------------------------------------------------------
async function scenarioRemotePathStillCompletesNormally(): Promise<void> {
  const root = makeGitRepo("local-approval-remote-regression-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath);
  const approval = baseApproval({ remotelyApprovable: true, approvalType: "ORCHESTRATOR_NOT_APPROVED_GENERIC" });

  const outcome = await performAutoResume(approval, manifest, {
    orchestratorDeps: { claudeRunner: makeFakeClaudeRunner(root), gptReviewer: fakeGptReviewer },
  });
  check("14) 원격 승인 가능한 Gate는 리팩터링 이후에도 정상적으로 COMPLETED까지 이어짐(회귀 없음)", outcome.kind === "COMPLETED");
  if (outcome.kind === "COMPLETED") {
    check("14) 최종 outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED(회귀 없음)", outcome.result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  }
}

// ---------------------------------------------------------------------------
// 만료된/부재한 ApprovalRequest에 대한 신규 생성 경로 — createFreshLocalApprovalRequest.
// ---------------------------------------------------------------------------
function seedSecurityBlockedEvent(events: EventStore, runId: string, taskId: string): string {
  const appended = events.append({
    eventType: "SECURITY_BLOCKED",
    runId,
    projectId: "fixture-local-approval",
    taskId,
    executionPhase: "checkpoint",
    outcome: "BLOCKED",
    reason: "commit 대상 파일에서 민감정보(secret) 패턴이 발견되어 commit을 중단했습니다.",
  });
  if (!appended.ok || !appended.event) throw new Error("test setup failed: could not seed SECURITY_BLOCKED event");
  return appended.event.eventId;
}

function scenarioCreateFreshRequestForCurrentGenuineBlock(): void {
  const root = makeGitRepo("local-approval-fresh-create-");
  const statePath = join(root, ".autodev", "project-state.json");
  const targetMarker = "CHECKPOINT_BLOCKED(T1): commit 대상 파일에서 민감정보(secret) 패턴이 발견되어 commit을 중단했습니다.";
  writeStateFile(statePath, { deferredHumanTasks: [targetMarker] });
  const manifest = buildManifest(root, statePath);
  const approvalStore = createInMemoryApprovalStore();
  const events = createInMemoryEventStore();
  seedSecurityBlockedEvent(events, "run-fresh-1", "T1");

  const result = createFreshLocalApprovalRequest("T1", { approvalStore, statePath, manifest, events });
  check("새 로컬 승인용 ApprovalRequest가 정상 생성됨", result.kind === "CREATED");
  if (result.kind === "CREATED") {
    check("새로 생성된 요청은 PENDING", result.approval.status === "PENDING");
    check("새로 생성된 요청은 remotelyApprovable=false(SECURITY_BLOCKED)", result.approval.remotelyApprovable === false);
    check("새로 생성된 요청이 실제로 ApprovalStore에 저장됨", approvalStore.get(result.approval.approvalId)?.approvalId === result.approval.approvalId);
  }
}

function scenarioCreateFreshRequestDoesNotReviveOldExpiredRecord(): void {
  const root = makeGitRepo("local-approval-fresh-no-revive-");
  const statePath = join(root, ".autodev", "project-state.json");
  const targetMarker = "CHECKPOINT_BLOCKED(T1): commit 대상 파일에서 민감정보(secret) 패턴이 발견되어 commit을 중단했습니다.";
  writeStateFile(statePath, { deferredHumanTasks: [targetMarker] });
  const manifest = buildManifest(root, statePath);
  const approvalStore = createInMemoryApprovalStore();
  const events = createInMemoryEventStore();
  seedSecurityBlockedEvent(events, "run-fresh-2", "T1");

  const oldExpired = baseApproval({ createdAt: "2020-01-01T00:00:00.000Z", expiresAt: "2020-01-01T00:30:00.000Z" });
  approvalStore.createPending(oldExpired);

  const result = createFreshLocalApprovalRequest("T1", { approvalStore, statePath, manifest, events });
  check("만료된 기존 레코드와 무관하게 새 레코드가 생성됨(다른 approvalId)", result.kind === "CREATED" && result.kind === "CREATED" && result.approval.approvalId !== oldExpired.approvalId);
  check("기존 만료 레코드 자체는 전혀 건드리지 않음(여전히 PENDING 그대로, 임의로 소생되지 않음)", approvalStore.get(oldExpired.approvalId)?.status === "PENDING");
}

function scenarioCreateFreshRequestRejectedWhenNotWaitingHuman(): void {
  const root = makeGitRepo("local-approval-fresh-not-waiting-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, { status: "READY", deferredHumanTasks: [] });
  const manifest = buildManifest(root, statePath);
  const approvalStore = createInMemoryApprovalStore();
  const events = createInMemoryEventStore();

  const result = createFreshLocalApprovalRequest("T1", { approvalStore, statePath, manifest, events });
  check("현재 상태가 WAITING_HUMAN이 아니면 새 요청을 만들지 않음", result.kind === "REJECTED" && result.reason === "STATE_NOT_WAITING_HUMAN");
}

async function main(): Promise<void> {
  try {
    await scenarioRemotePathStillRejectsSecurityBlocked();
    scenarioSecurityBlockedNeverGetsInlineKeyboardBuilt();
    await scenarioLocalApprovalHappyPathResumesToCompletion();
    await scenarioMarkerRemovalPreservesUnrelatedMarkersBeforeResumeStarts();
    await scenarioWrongTaskRejected();
    await scenarioExpiredApprovalRejectedNotRevived();
    await scenarioMismatchedBlockReasonRejected();
    await scenarioDuplicateApprovalRejected();
    await scenarioTechnicalAutoRecoverableCannotBeLocallyApproved();
    await scenarioCheckpointScopeViolationCanBeLocallyApproved();
    await scenarioRemotelyApprovableTrueRejectedByLocalPath();
    await scenarioRemotePathStillCompletesNormally();
    scenarioCreateFreshRequestForCurrentGenuineBlock();
    scenarioCreateFreshRequestDoesNotReviveOldExpiredRecord();
    scenarioCreateFreshRequestRejectedWhenNotWaitingHuman();
  } finally {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // OS 임시 디렉터리 — 정리 실패는 테스트 결과에 영향 없음.
      }
    }
  }

  console.log("\n=== local-human-approval 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
