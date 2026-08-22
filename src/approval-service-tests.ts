import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createApprovalRequestsFromEvents, handleTelegramCallbackUpdate } from "./approval-service";
import type { HandleCallbackContext } from "./approval-service";
import { createInMemoryApprovalStore } from "./approval-store";
import type { ApprovalStore } from "./approval-store";
import { createInMemoryEventStore } from "./event-store";
import type { EventStore } from "./event-store";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import type { CoreState, ClaudeResult } from "./types";
import type { GptReviewerReturn } from "./orchestrator";
import type { ApprovalType } from "./approval";
import type { TelegramUpdate } from "./telegram-callback-client";

// Approval Orchestration 테스트 — Phase G Task G6. 실제 Claude/GPT/Telegram 호출은 전혀
// 없다 — orchestratorDeps는 항상 fake, fetchImpl은 항상 fake로 주입한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "approval-service-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Approval Service Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

const FIXTURE_TASK_REGISTRY: TaskDefinition[] = [
  {
    id: "S1",
    phase: 1,
    taskNumber: 1,
    title: "승인 서비스 fixture task",
    prompt: "src/ping.js에 ping() 함수를 작성하세요.",
    requiredTests: [{ name: "svc-fixture-test", command: "node", args: ["tests/ping.test.js"], cwd: "root" }],
    allowedPathPrefixes: ["src/", "tests/"],
    prohibitedOperations: ["src/, tests/ 밖 파일 수정"],
  },
];
const FIXTURE_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["src/", "tests/"],
  allowedWritePrefixes: ["src/", "tests/"],
  allowedCommands: [{ cwd: "root", command: "node", args: ["tests/ping.test.js"] }],
};
function buildManifest(root: string, statePath: string): ProjectManifest {
  return {
    projectId: "fixture-approval-service",
    projectName: "Fixture Approval Service",
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

function callbackUpdate(updateId: number, data: string | undefined, chatId: number | string = 777, userId = 555): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: { id: `cbq-${updateId}`, data, from: { id: userId }, message: { chat: { id: chatId } } },
  };
}

interface CapturedCall {
  url: string;
  init?: RequestInit;
}
function createFakeFetch(): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function baseCtx(overrides: Partial<HandleCallbackContext> = {}): HandleCallbackContext {
  const { fetch: fetchImpl } = createFakeFetch();
  return {
    approvalStore: createInMemoryApprovalStore(),
    manifest: {
      projectId: "p",
      projectName: "P",
      targetProjectRoot: process.cwd(),
      statePath: join(tmpdir(), "unused-state.json"),
      taskRegistry: [],
      developerInstructions: "x",
      reviewInstructions: "x",
      reviewScopeDirs: ["src/"],
      executionPolicy: { allowedReadPrefixes: ["src/"], allowedWritePrefixes: ["src/"], allowedCommands: [] },
    },
    allowlist: { chatId: "777" },
    fetchImpl,
    botToken: "tok",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createApprovalRequestsFromEvents
// ---------------------------------------------------------------------------
function scenarioCreatesApprovalForHumanApprovalRequired(): void {
  const approvalStore: ApprovalStore = createInMemoryApprovalStore();
  const eventStore: EventStore = createInMemoryEventStore();
  eventStore.append({ eventType: "HUMAN_APPROVAL_REQUIRED", runId: "r1", taskId: "T1", reason: "orchestrator status=WAITING_HUMAN(x)" });
  const { events } = eventStore.query();
  const result = createApprovalRequestsFromEvents(events, approvalStore, { eventStore });
  check("HUMAN_APPROVAL_REQUIRED(orchestrator generic) -> ApprovalRequest 생성", result.created.length === 1);
  check("생성된 approval은 remotelyApprovable=true(ORCHESTRATOR_NOT_APPROVED_GENERIC)", result.created[0]?.remotelyApprovable === true);
  const appended = eventStore.query({ eventType: "APPROVAL_REQUESTED" }).events;
  check("APPROVAL_REQUESTED observability event가 남음", appended.length === 1);
}
function scenarioCreatesApprovalForSecurityBlockedNotRemotelyApprovable(): void {
  const approvalStore: ApprovalStore = createInMemoryApprovalStore();
  const eventStore: EventStore = createInMemoryEventStore();
  eventStore.append({ eventType: "SECURITY_BLOCKED", runId: "r1", taskId: "T1" });
  const result = createApprovalRequestsFromEvents(eventStore.query().events, approvalStore, { eventStore });
  check("SECURITY_BLOCKED -> ApprovalRequest는 생성되지만 remotelyApprovable=false", result.created.length === 1 && result.created[0].remotelyApprovable === false);
}
function scenarioNoApprovalForNonHumanActionEvent(): void {
  const approvalStore: ApprovalStore = createInMemoryApprovalStore();
  const eventStore: EventStore = createInMemoryEventStore();
  eventStore.append({ eventType: "TASK_COMPLETED", runId: "r1", taskId: "T1" });
  const result = createApprovalRequestsFromEvents(eventStore.query().events, approvalStore, { eventStore });
  check("requiresHumanAction=false인 event(TASK_COMPLETED)는 승인 요청을 만들지 않음", result.created.length === 0);
}
function scenarioNoApprovalForRunBlockedBookend(): void {
  const approvalStore: ApprovalStore = createInMemoryApprovalStore();
  const eventStore: EventStore = createInMemoryEventStore();
  eventStore.append({ eventType: "RUN_BLOCKED", runId: "r1", taskId: "T1" });
  const result = createApprovalRequestsFromEvents(eventStore.query().events, approvalStore, { eventStore });
  check("RUN_BLOCKED는 다른 구체적 event와 짝을 이루는 bookend라 별도 승인 요청을 만들지 않음", result.created.length === 0);
}
function scenarioNoApprovalForSelfDevWaitingHuman(): void {
  // Phase G Task G7.3.2 — self-dev informational-only WAITING_HUMAN에는 실제 resumable
  // production action이 없다(§ self-dev-terminal-status.ts). ApprovalRequest가 구조적으로
  // 0건이어야 한다(버튼이 안 보이는 것만으로는 부족하다).
  const approvalStore: ApprovalStore = createInMemoryApprovalStore();
  const eventStore: EventStore = createInMemoryEventStore();
  eventStore.append({ eventType: "SELF_DEV_WAITING_HUMAN", runId: "r1", taskId: "G7.3.2", reason: "사용자 확인 필요(fixture)" });
  const result = createApprovalRequestsFromEvents(eventStore.query().events, approvalStore, { eventStore });
  check("SELF_DEV_WAITING_HUMAN -> ApprovalRequest 0건", result.created.length === 0);
  check("SELF_DEV_WAITING_HUMAN -> ApprovalStore에도 request 없음", approvalStore.list().length === 0);
}
function scenarioIdempotentAcrossRepeatedBatches(): void {
  const approvalStore: ApprovalStore = createInMemoryApprovalStore();
  const eventStore: EventStore = createInMemoryEventStore();
  eventStore.append({ eventType: "HUMAN_APPROVAL_REQUIRED", runId: "r1", taskId: "T1", reason: "orchestrator status=WAITING_HUMAN(x)" });
  const events = eventStore.query().events;
  const first = createApprovalRequestsFromEvents(events, approvalStore, { eventStore });
  const second = createApprovalRequestsFromEvents(events, approvalStore, { eventStore }); // controller가 매 tick 전체를 다시 훑는 것을 흉내낸다
  check("같은 event batch를 다시 처리해도 두 번째 호출에서는 새 승인이 생기지 않음(idempotent)", first.created.length === 1 && second.created.length === 0);
  check("store에는 approval이 정확히 1개만 존재", approvalStore.list().length === 1);
}
function scenarioGitExpectationPassedThrough(): void {
  const approvalStore: ApprovalStore = createInMemoryApprovalStore();
  const eventStore: EventStore = createInMemoryEventStore();
  eventStore.append({ eventType: "HUMAN_APPROVAL_REQUIRED", runId: "r1", taskId: "T1", reason: "orchestrator status=WAITING_HUMAN(x)" });
  const result = createApprovalRequestsFromEvents(eventStore.query().events, approvalStore, {
    expectedGitHead: "abc123",
    expectedBranch: "main",
  });
  check("expectedGitHead/expectedBranch가 생성된 ApprovalRequest에 그대로 담김", result.created[0]?.expectedGitHead === "abc123" && result.created[0]?.expectedBranch === "main");
}

// ---------------------------------------------------------------------------
// handleTelegramCallbackUpdate
// ---------------------------------------------------------------------------
async function scenarioIgnoresNonCallbackUpdate(): Promise<void> {
  const ctx = baseCtx();
  const result = await handleTelegramCallbackUpdate({ update_id: 1 }, ctx);
  check("callback_query가 없는 update는 무시(IGNORED_NOT_CALLBACK)", result.kind === "IGNORED_NOT_CALLBACK");
}
async function scenarioUnauthorizedChatIdRejected(): Promise<void> {
  const eventStore: EventStore = createInMemoryEventStore();
  const ctx = baseCtx({ eventStore, allowlist: { chatId: "777" } });
  const update = callbackUpdate(1, "ap:x:A", 999);
  const result = await handleTelegramCallbackUpdate(update, ctx);
  check("chat allowlist 불일치 -> UNAUTHORIZED", result.kind === "UNAUTHORIZED");
  check("UNAUTHORIZED는 APPROVAL_UNAUTHORIZED audit event를 남김", eventStore.query({ eventType: "APPROVAL_UNAUTHORIZED" }).events.length === 1);
}
async function scenarioMissingDataMalformed(): Promise<void> {
  const ctx = baseCtx();
  const result = await handleTelegramCallbackUpdate(callbackUpdate(1, undefined), ctx);
  check("callback_query.data 없음 -> MALFORMED", result.kind === "MALFORMED");
}
async function scenarioMalformedDataRejected(): Promise<void> {
  const ctx = baseCtx();
  const result = await handleTelegramCallbackUpdate(callbackUpdate(1, "not-a-valid-callback"), ctx);
  check("파싱 불가능한 callback_data -> MALFORMED", result.kind === "MALFORMED");
}
async function scenarioUnknownApprovalRejected(): Promise<void> {
  const ctx = baseCtx();
  const result = await handleTelegramCallbackUpdate(callbackUpdate(1, `ap:${randomUUID()}:A`), ctx);
  check("존재하지 않는 approvalId -> UNKNOWN_APPROVAL", result.kind === "UNKNOWN_APPROVAL");
}
async function scenarioAlreadyConsumedRejected(): Promise<void> {
  const approvalStore = createInMemoryApprovalStore();
  const approvalId = randomUUID();
  approvalStore.createPending({
    approvalId,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    runId: "r1",
    taskId: "T1",
    approvalType: "ORCHESTRATOR_NOT_APPROVED_GENERIC",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: randomUUID(),
    status: "PENDING",
    remotelyApprovable: true,
    requiresSafetyRecheck: true,
    dedupeKey: "dk-1",
  });
  approvalStore.transition(approvalId, "REJECTED", "2026-01-01T00:01:00.000Z");
  const ctx = baseCtx({ approvalStore });
  const result = await handleTelegramCallbackUpdate(callbackUpdate(1, `ap:${approvalId}:A`), ctx);
  check("이미 소비된(REJECTED) approval에 다시 요청 -> ALREADY_CONSUMED", result.kind === "ALREADY_CONSUMED");
}
async function scenarioExpiredRejectedAndTransitioned(): Promise<void> {
  const approvalStore = createInMemoryApprovalStore();
  const approvalId = randomUUID();
  approvalStore.createPending({
    approvalId,
    createdAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2020-01-01T00:30:00.000Z",
    runId: "r1",
    taskId: "T1",
    approvalType: "ORCHESTRATOR_NOT_APPROVED_GENERIC",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: randomUUID(),
    status: "PENDING",
    remotelyApprovable: true,
    requiresSafetyRecheck: true,
    dedupeKey: "dk-2",
  });
  const eventStore: EventStore = createInMemoryEventStore();
  const ctx = baseCtx({ approvalStore, eventStore });
  const result = await handleTelegramCallbackUpdate(callbackUpdate(1, `ap:${approvalId}:A`), ctx);
  check("만료된 approval -> EXPIRED", result.kind === "EXPIRED");
  check("store 상태도 EXPIRED로 전이됨", approvalStore.get(approvalId)?.status === "EXPIRED");
  check("APPROVAL_EXPIRED audit event 기록", eventStore.query({ eventType: "APPROVAL_EXPIRED" }).events.length === 1);
}
async function scenarioRejectTransitionsAndAnswers(): Promise<void> {
  const approvalStore = createInMemoryApprovalStore();
  const approvalId = randomUUID();
  approvalStore.createPending({
    approvalId,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    runId: "r1",
    taskId: "T1",
    approvalType: "SECURITY_BLOCKED",
    sourceEventType: "SECURITY_BLOCKED",
    sourceEventId: randomUUID(),
    status: "PENDING",
    remotelyApprovable: false,
    requiresSafetyRecheck: true,
    dedupeKey: "dk-3",
  });
  const eventStore: EventStore = createInMemoryEventStore();
  const ctx = baseCtx({ approvalStore, eventStore });
  const result = await handleTelegramCallbackUpdate(callbackUpdate(1, `ap:${approvalId}:R`), ctx);
  check("REJECT -> REJECTED", result.kind === "REJECTED");
  check("store도 REJECTED로 전이됨", approvalStore.get(approvalId)?.status === "REJECTED");
  check("APPROVAL_REJECTED audit event 기록", eventStore.query({ eventType: "APPROVAL_REJECTED" }).events.length === 1);
}
async function scenarioDeferTransitions(): Promise<void> {
  const approvalStore = createInMemoryApprovalStore();
  const approvalId = randomUUID();
  approvalStore.createPending({
    approvalId,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    runId: "r1",
    taskId: "T1",
    approvalType: "REVIEW_CYCLE_EXHAUSTED",
    sourceEventType: "REVIEW_CYCLE_EXHAUSTED",
    sourceEventId: randomUUID(),
    status: "PENDING",
    remotelyApprovable: false,
    requiresSafetyRecheck: true,
    dedupeKey: "dk-4",
  });
  const eventStore: EventStore = createInMemoryEventStore();
  const ctx = baseCtx({ approvalStore, eventStore });
  const result = await handleTelegramCallbackUpdate(callbackUpdate(1, `ap:${approvalId}:D`), ctx);
  check("DEFER -> DEFERRED", result.kind === "DEFERRED");
  check("APPROVAL_DEFERRED audit event 기록", eventStore.query({ eventType: "APPROVAL_DEFERRED" }).events.length === 1);
}
async function scenarioApproveNotRemotelyApprovableForAllForbiddenTypes(): Promise<void> {
  const forbiddenTypes: ApprovalType[] = [
    "SECURITY_BLOCKED",
    "REVIEW_CYCLE_EXHAUSTED",
    "REVIEW_BLOCKED",
    "CHECKPOINT_SCOPE_VIOLATION",
    "HIGH_RISK_ACTION_PREGATE",
    "AUDIT_STORE_UNAVAILABLE",
    "UNKNOWN",
  ];
  for (const approvalType of forbiddenTypes) {
    const approvalStore = createInMemoryApprovalStore();
    const approvalId = randomUUID();
    approvalStore.createPending({
      approvalId,
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      runId: "r1",
      taskId: "T1",
      approvalType,
      sourceEventType: "HUMAN_APPROVAL_REQUIRED",
      sourceEventId: randomUUID(),
      status: "PENDING",
      remotelyApprovable: false,
      requiresSafetyRecheck: true,
      dedupeKey: `dk-forbidden-${approvalType}`,
    });
    const ctx = baseCtx({ approvalStore });
    const result = await handleTelegramCallbackUpdate(callbackUpdate(1, `ap:${approvalId}:A`), ctx);
    check(`${approvalType}는 APPROVE로도 REMOTE_NOT_ALLOWED(원격 우회 불가)`, result.kind === "REMOTE_NOT_ALLOWED");
    check(`${approvalType}는 REMOTE_NOT_ALLOWED 후에도 store 상태가 PENDING 그대로(소비되지 않음)`, approvalStore.get(approvalId)?.status === "PENDING");
  }
}
async function scenarioApproveStaleTaskAlreadyCompleted(): Promise<void> {
  const root = makeGitRepo("approval-svc-stale-completed-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, { completedTasks: ["S1"] });
  const manifest = buildManifest(root, statePath);
  const approvalStore = createInMemoryApprovalStore();
  const approvalId = randomUUID();
  approvalStore.createPending({
    approvalId,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    runId: "r1",
    taskId: "S1",
    approvalType: "ORCHESTRATOR_NOT_APPROVED_GENERIC",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: randomUUID(),
    status: "PENDING",
    remotelyApprovable: true,
    requiresSafetyRecheck: true,
    dedupeKey: "dk-stale-completed",
  });
  const eventStore: EventStore = createInMemoryEventStore();
  const ctx = baseCtx({ approvalStore, eventStore, manifest, statePath });
  const result = await handleTelegramCallbackUpdate(callbackUpdate(1, `ap:${approvalId}:A`), ctx);
  check("이미 완료된 task에 대한 APPROVE -> STALE", result.kind === "STALE");
  check("store는 INVALIDATED로 전이됨(다시 시도 불가)", approvalStore.get(approvalId)?.status === "INVALIDATED");
  check("APPROVAL_STALE audit event 기록", eventStore.query({ eventType: "APPROVAL_STALE" }).events.length === 1);
}
async function scenarioApproveStaleUnexpectedState(): Promise<void> {
  const root = makeGitRepo("approval-svc-stale-state-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, { status: "IDLE" });
  const manifest = buildManifest(root, statePath);
  const approvalStore = createInMemoryApprovalStore();
  const approvalId = randomUUID();
  approvalStore.createPending({
    approvalId,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    runId: "r1",
    taskId: "S1",
    approvalType: "ORCHESTRATOR_NOT_APPROVED_GENERIC",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: randomUUID(),
    status: "PENDING",
    remotelyApprovable: true,
    requiresSafetyRecheck: true,
    dedupeKey: "dk-stale-state",
  });
  const ctx = baseCtx({ approvalStore, manifest, statePath });
  const result = await handleTelegramCallbackUpdate(callbackUpdate(1, `ap:${approvalId}:A`), ctx);
  check("현재 state.status가 WAITING_HUMAN이 아니면 APPROVE도 STALE로 조기 차단", result.kind === "STALE");
}
async function scenarioApproveHappyPathCompletesWithoutRealApiCalls(): Promise<void> {
  const root = makeGitRepo("approval-svc-happy-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath);
  const approvalStore = createInMemoryApprovalStore();
  const approvalId = randomUUID();
  approvalStore.createPending({
    approvalId,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    runId: "r1",
    taskId: "S1",
    approvalType: "ORCHESTRATOR_NOT_APPROVED_GENERIC",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: randomUUID(),
    status: "PENDING",
    remotelyApprovable: true,
    requiresSafetyRecheck: true,
    dedupeKey: "dk-happy",
  });
  const eventStore: EventStore = createInMemoryEventStore();

  const claudeRunner = async (): Promise<ClaudeResult> => {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "src", "ping.js"), "function ping() {\n  return 'pong';\n}\n\nmodule.exports = { ping };\n");
    writeFileSync(
      join(root, "tests", "ping.test.js"),
      "const assert = require('node:assert');\nconst { ping } = require('../src/ping');\nassert.strictEqual(ping(), 'pong');\nconsole.log('OK');\n"
    );
    const res = spawnSync(process.execPath, ["tests/ping.test.js"], { cwd: root, encoding: "utf-8" });
    return {
      success: true,
      summary: "ping() 구현 완료",
      changedFiles: ["src/ping.js", "tests/ping.test.js"],
      tests: [{ name: "svc-fixture-test", pass: res.status === 0 }],
      rawOutput: (res.stdout || "") + (res.stderr || ""),
    };
  };
  const gptReviewer = async (): Promise<GptReviewerReturn> => ({
    decision: "PASS",
    severity: { critical: 0, high: 0, medium: 0 },
    feedback: "정상",
    nextTask: null,
  });

  const ctx = baseCtx({ approvalStore, eventStore, manifest, statePath, orchestratorDeps: { claudeRunner, gptReviewer } });
  const result = await handleTelegramCallbackUpdate(callbackUpdate(1, `ap:${approvalId}:A`), ctx);

  check("안전한 APPROVE -> kind=APPROVED", result.kind === "APPROVED");
  check("Auto Resume outcome은 COMPLETED", result.autoResume?.kind === "COMPLETED");
  check("store는 APPROVED로 전이됨(재사용 불가)", approvalStore.get(approvalId)?.status === "APPROVED");
  check("APPROVAL_APPROVED audit event 기록", eventStore.query({ eventType: "APPROVAL_APPROVED" }).events.length === 1);
  check("AUTO_RESUME_STARTED event 기록", eventStore.query({ eventType: "AUTO_RESUME_STARTED" }).events.length === 1);
  check("AUTO_RESUME_COMPLETED event 기록", eventStore.query({ eventType: "AUTO_RESUME_COMPLETED" }).events.length === 1);

  // Replay — 같은 update를 다시 처리하면(예: Telegram 중복 전달) 두 번째는 항상 거부된다.
  const replay = await handleTelegramCallbackUpdate(callbackUpdate(1, `ap:${approvalId}:A`), ctx);
  check("동일 approvalId로 재클릭(replay) -> ALREADY_CONSUMED", replay.kind === "ALREADY_CONSUMED");
}
async function scenarioApproveGitDivergedBlocksAutoResumeButConsumesApproval(): Promise<void> {
  const root = makeGitRepo("approval-svc-git-diverge-");
  const staleHead = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf-8" }).stdout.trim();
  writeFileSync(join(root, "manual.txt"), "x");
  spawnSync("git", ["add", "--", "manual.txt"], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "manual"], { cwd: root });
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath);
  const approvalStore = createInMemoryApprovalStore();
  const approvalId = randomUUID();
  approvalStore.createPending({
    approvalId,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    runId: "r1",
    taskId: "S1",
    approvalType: "ORCHESTRATOR_NOT_APPROVED_GENERIC",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: randomUUID(),
    status: "PENDING",
    remotelyApprovable: true,
    requiresSafetyRecheck: true,
    dedupeKey: "dk-git-diverge",
    expectedGitHead: staleHead,
  });
  const eventStore: EventStore = createInMemoryEventStore();
  const ctx = baseCtx({ approvalStore, eventStore, manifest, statePath });
  const result = await handleTelegramCallbackUpdate(callbackUpdate(1, `ap:${approvalId}:A`), ctx);
  check("승인 자체는 소비되지만(재사용 불가) Auto Resume은 Git divergence로 BLOCKED", result.kind === "APPROVED" && result.autoResume?.kind === "BLOCKED");
  check("AUTO_RESUME_BLOCKED audit event 기록", eventStore.query({ eventType: "AUTO_RESUME_BLOCKED" }).events.length === 1);
  check("store 상태는 APPROVED(다시 재시도 버튼이 생기지 않음)", approvalStore.get(approvalId)?.status === "APPROVED");
}
async function scenarioNoBotTokenAnswerDoesNotThrow(): Promise<void> {
  const approvalStore = createInMemoryApprovalStore();
  const ctx = baseCtx({ approvalStore, botToken: undefined });
  let threw = false;
  try {
    await handleTelegramCallbackUpdate(callbackUpdate(1, `ap:${randomUUID()}:A`), ctx);
  } catch {
    threw = true;
  }
  check("Bot Token 미설정이어도 예외 없이 처리됨(answer는 조용히 생략)", threw === false);
}
async function scenarioResultNeverLeaksBotToken(): Promise<void> {
  const ctx = baseCtx({ botToken: "super-secret-bot-token-value" });
  const result = await handleTelegramCallbackUpdate(callbackUpdate(1, `ap:${randomUUID()}:A`), ctx);
  check("HandleCallbackResult 어디에도 Bot Token 원문이 없음", JSON.stringify(result).includes("super-secret-bot-token-value") === false);
}

async function main(): Promise<void> {
  scenarioCreatesApprovalForHumanApprovalRequired();
  scenarioCreatesApprovalForSecurityBlockedNotRemotelyApprovable();
  scenarioNoApprovalForNonHumanActionEvent();
  scenarioNoApprovalForRunBlockedBookend();
  scenarioNoApprovalForSelfDevWaitingHuman();
  scenarioIdempotentAcrossRepeatedBatches();
  scenarioGitExpectationPassedThrough();

  await scenarioIgnoresNonCallbackUpdate();
  await scenarioUnauthorizedChatIdRejected();
  await scenarioMissingDataMalformed();
  await scenarioMalformedDataRejected();
  await scenarioUnknownApprovalRejected();
  await scenarioAlreadyConsumedRejected();
  await scenarioExpiredRejectedAndTransitioned();
  await scenarioRejectTransitionsAndAnswers();
  await scenarioDeferTransitions();
  await scenarioApproveNotRemotelyApprovableForAllForbiddenTypes();
  await scenarioApproveStaleTaskAlreadyCompleted();
  await scenarioApproveStaleUnexpectedState();
  await scenarioApproveHappyPathCompletesWithoutRealApiCalls();
  await scenarioApproveGitDivergedBlocksAutoResumeButConsumesApproval();
  await scenarioNoBotTokenAnswerDoesNotThrow();
  await scenarioResultNeverLeaksBotToken();

  console.log("\n=== approval-service.ts(G6) 테스트 결과 ===");
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
