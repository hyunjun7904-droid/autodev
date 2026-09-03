import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import {
  parseArg,
  getProjectControlStatus,
  formatProjectControlStatus,
  decideStopAction,
  formatApprovalPreview,
} from "./project-control-cli";
import { engageMaintenancePause, clearMaintenancePause, runnerSupervisorLockFilePath } from "./runner-supervisor";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectRuntimeLiveness } from "./project-lock";
import { acquireProjectLock, releaseProjectLock } from "./project-lock";
import type { ProjectLockHandle } from "./project-lock";
import { createFileApprovalStore, createInMemoryApprovalStore } from "./approval-store";
import type { ApprovalRequest } from "./approval";
import type { CoreState } from "./types";

// AutoDev Core Maintenance — Canonical Project Control CLI(Category C) 테스트. 이 CLI는
// project-lock.ts/runner-supervisor.ts/dashboard-supervisor.ts에 이미 있고 각자 테스트된
// 순수 함수만 배선하므로, 여기서는 "그 배선이 정확한가"(올바른 경로/올바른 인자로 호출되는가)
// 만 검증한다 — lock/liveness 판정 로직 자체의 회귀는 project-lock-tests.ts/
// dashboard-supervisor-tests.ts가 전담한다(중복 검증하지 않는다). 실제 프로세스/실제
// project adapter는 전혀 쓰지 않는다 — 모든 fs 접근은 OS 임시 디렉터리 안에서만 일어난다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function makeTempLogsDir(): string {
  return mkdtempSync(join(tmpdir(), "project-control-cli-tests-"));
}

const FAKE_ADAPTER_PATH = "C:/fake/project/.autodev/manifest.json";

function fakeManifest(): ProjectManifest {
  return {
    projectId: "fake-project",
    projectName: "Fake Project",
    targetProjectRoot: "C:/fake/project",
    statePath: "C:/fake/project/.autodev/project-state.json",
    taskRegistry: [],
    developerInstructions: "",
    reviewInstructions: "",
    reviewScopeDirs: [],
    executionPolicy: { allowedReadPrefixes: [], allowedWritePrefixes: [], allowedCommands: [] },
  };
}

function scenarioParseArg(): void {
  check("parseArg: 지정된 flag 다음 값을 반환", parseArg(["--project", "/x/y", "--reason", "test"], "--project") === "/x/y");
  check("parseArg: 없는 flag는 undefined", parseArg(["--project", "/x/y"], "--reason") === undefined);
  check("parseArg: flag가 마지막에 값 없이 끝나면 undefined", parseArg(["--project"], "--project") === undefined);
}

function scenarioMaintenancePauseReflectedInStatus(): void {
  const logsDir = makeTempLogsDir();
  try {
    const before = getProjectControlStatus(FAKE_ADAPTER_PATH, logsDir, {
      loadProjectAdapter: () => fakeManifest(),
      inspectProjectRuntimeLiveness: () => ({ present: false }),
    });
    check("status: 최초에는 Maintenance Pause 비활성", before.maintenancePaused === false);

    engageMaintenancePause(FAKE_ADAPTER_PATH, logsDir, "테스트 사유");
    const afterEngage = getProjectControlStatus(FAKE_ADAPTER_PATH, logsDir, {
      loadProjectAdapter: () => fakeManifest(),
      inspectProjectRuntimeLiveness: () => ({ present: false }),
    });
    check("status: engageMaintenancePause 후 ACTIVE로 반영됨", afterEngage.maintenancePaused === true);
    check("status: format 출력에 ACTIVE 표시", formatProjectControlStatus(afterEngage).includes("Maintenance Pause: ACTIVE"));

    clearMaintenancePause(FAKE_ADAPTER_PATH, logsDir);
    const afterClear = getProjectControlStatus(FAKE_ADAPTER_PATH, logsDir, {
      loadProjectAdapter: () => fakeManifest(),
      inspectProjectRuntimeLiveness: () => ({ present: false }),
    });
    check("status: clearMaintenancePause 후 다시 inactive로 반영됨", afterClear.maintenancePaused === false);
  } finally {
    rmSync(logsDir, { recursive: true, force: true });
  }
}

function scenarioSupervisorLockReflectedInStatus(): void {
  const logsDir = makeTempLogsDir();
  try {
    const noLock = getProjectControlStatus(FAKE_ADAPTER_PATH, logsDir, {
      loadProjectAdapter: () => fakeManifest(),
      inspectProjectRuntimeLiveness: () => ({ present: false }),
    });
    check("status: supervisor lock 파일이 없으면 not running", noLock.supervisor.action === "PROCEED");
    check("status: format 출력에 not running 표시", formatProjectControlStatus(noLock).includes("Supervisor: not running"));

    const lockPath = runnerSupervisorLockFilePath(FAKE_ADAPTER_PATH, logsDir);
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 424242, adapterPath: FAKE_ADAPTER_PATH, startedAt: new Date().toISOString() }), "utf-8");

    const aliveResult = getProjectControlStatus(FAKE_ADAPTER_PATH, logsDir, {
      loadProjectAdapter: () => fakeManifest(),
      inspectProjectRuntimeLiveness: () => ({ present: false }),
      isPidAlive: (pid) => pid === 424242,
    });
    check("status: isPidAlive가 true를 반환하면 RUNNING으로 판정", aliveResult.supervisor.action === "ALREADY_RUNNING");
    check("status: format 출력에 RUNNING 표시", formatProjectControlStatus(aliveResult).includes("Supervisor: RUNNING"));

    const deadResult = getProjectControlStatus(FAKE_ADAPTER_PATH, logsDir, {
      loadProjectAdapter: () => fakeManifest(),
      inspectProjectRuntimeLiveness: () => ({ present: false }),
      isPidAlive: () => false,
    });
    check("status: isPidAlive가 false를 반환하면 stale lock으로 판정(not running)", deadResult.supervisor.action === "PROCEED");
  } finally {
    rmSync(logsDir, { recursive: true, force: true });
  }
}

function scenarioProjectLockStatusVariants(): void {
  const logsDir = makeTempLogsDir();
  try {
    const absent = getProjectControlStatus(FAKE_ADAPTER_PATH, logsDir, {
      loadProjectAdapter: () => fakeManifest(),
      inspectProjectRuntimeLiveness: () => ({ present: false }),
    });
    check("status: project lock 없음이 그대로 반영됨", absent.projectLock.present === false && !("error" in absent.projectLock));
    check("status: format 출력에 '없음' 표시", formatProjectControlStatus(absent).includes("Project Lock: 없음"));

    const present: ProjectRuntimeLiveness = {
      present: true,
      pid: 12345,
      processStartedAtMs: Date.now(),
      ownerKind: "local-human-approval",
      taskId: "5.3",
      liveness: { verdict: "ALIVE" },
    };
    const presentResult = getProjectControlStatus(FAKE_ADAPTER_PATH, logsDir, {
      loadProjectAdapter: () => fakeManifest(),
      inspectProjectRuntimeLiveness: () => present,
    });
    check("status: project lock 보유자 정보가 그대로 반영됨", presentResult.projectLock.present === true);
    const formatted = formatProjectControlStatus(presentResult);
    check("status: format 출력에 pid 포함", formatted.includes("pid=12345"));
    check("status: format 출력에 ownerKind 포함", formatted.includes("ownerKind=local-human-approval"));
    check("status: format 출력에 taskId 포함", formatted.includes("taskId=5.3"));
    check("status: format 출력에 liveness verdict 포함", formatted.includes("liveness=ALIVE"));

    const brokenAdapter = getProjectControlStatus(FAKE_ADAPTER_PATH, logsDir, {
      loadProjectAdapter: () => {
        throw new Error("MANIFEST_NOT_FOUND");
      },
    });
    check(
      "status: project adapter를 읽을 수 없으면 project lock을 '없음'으로 조용히 단정하지 않고 오류로 구분함",
      "error" in brokenAdapter.projectLock && brokenAdapter.projectLock.error === "MANIFEST_NOT_FOUND"
    );
    check("status: format 출력에 확인 불가 표시", formatProjectControlStatus(brokenAdapter).includes("확인 불가"));
  } finally {
    rmSync(logsDir, { recursive: true, force: true });
  }
}

// AutoDev Core Maintenance — Canonical Stop Path(2026-08-31, JARVIS Task 5.3 실측 —
// "실행 중인 Developer/continuous run을 canonical하게 정상 중단할 수 없는 결함"). decideStopAction
// 은 순수 함수라(실제 마커 파일을 쓰지 않는다) 여기서 그 판정 로직 자체만 검증한다 — 실제
// 마커 write/polling/abort 연쇄는 run-tests.ts가, 그 abort가 orchestrator.ts/autodev.ts에
// 실제로 반영되는지는 autodev-tests.ts(K/L/M 시나리오)가 각각 담당한다(중복 검증 없음).
function scenarioDecideStopAction(): void {
  check(
    "stop: project lock이 없으면 NO_TARGET",
    decideStopAction({ present: false }).action === "NO_TARGET"
  );
  check(
    "stop: liveness가 STALE이면 NO_TARGET(보낼 대상 없음, stale-PID 판정에 맡김)",
    decideStopAction({
      present: true,
      pid: 111,
      processStartedAtMs: 1_000,
      ownerKind: "autodev",
      liveness: { verdict: "STALE", evidence: "PID_NOT_RUNNING" },
    }).action === "NO_TARGET"
  );
  check(
    "stop: liveness가 UNCERTAIN이면 NO_TARGET(확인 못 함을 중단 대상으로 추측하지 않음)",
    decideStopAction({
      present: true,
      pid: 111,
      processStartedAtMs: 1_000,
      ownerKind: "autodev",
      liveness: { verdict: "UNCERTAIN", reason: "권한 없음" },
    }).action === "NO_TARGET"
  );
  check(
    "stop: ownerKind가 autodev가 아니면(local-human-approval) REFUSED — 추측해서 건드리지 않음",
    decideStopAction({
      present: true,
      pid: 111,
      processStartedAtMs: 1_000,
      ownerKind: "local-human-approval",
      liveness: { verdict: "ALIVE" },
    }).action === "REFUSED"
  );
  check(
    "stop: ownerKind가 autodev가 아니면(telegram-resume) REFUSED",
    decideStopAction({
      present: true,
      pid: 111,
      processStartedAtMs: 1_000,
      ownerKind: "telegram-resume",
      liveness: { verdict: "ALIVE" },
    }).action === "REFUSED"
  );
  const ok = decideStopAction({ present: true, pid: 999, processStartedAtMs: 123_456, ownerKind: "autodev", liveness: { verdict: "ALIVE" } });
  check("stop: ownerKind=autodev + liveness=ALIVE면 REQUEST_STOP", ok.action === "REQUEST_STOP");
  check("stop: REQUEST_STOP은 실제 project lock owner pid를 그대로 담음", ok.action === "REQUEST_STOP" && ok.pid === 999);
  check(
    "stop: REQUEST_STOP은 project lock owner의 processStartedAtMs도 그대로 담음(PID 재사용 하드닝 — pid 단독이 아니라 pid+시작시각으로 신원을 식별)",
    ok.action === "REQUEST_STOP" && ok.processStartedAtMs === 123_456
  );
}

// ---------------------------------------------------------------------------
// Genuine Human Gate Local Approval CLI(2026-08-31) — formatApprovalPreview()는 순수
// 함수다(어떤 상태도 바꾸지 않는다) — approvalStore.get()이 반환한 값과 loadState()
// 결과만으로 사람이 승인 전에 봐야 할 정보를 조립한다.
// ---------------------------------------------------------------------------
function scenarioFormatApprovalPreviewMissingApproval(): void {
  const store = createInMemoryApprovalStore();
  const out = formatApprovalPreview({ projectId: "p1", statePath: "C:/nowhere/state.json" }, store, "missing-id", "T1", new Date().toISOString());
  check("formatApprovalPreview: 없는 approvalId는 '찾을 수 없습니다'를 표시", out.includes("찾을 수 없습니다"));
  check("formatApprovalPreview: project/task/approval id는 그대로 표시됨", out.includes("project: p1") && out.includes("approval id: missing-id"));
}

function baseApprovalFixture(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const now = new Date();
  return {
    approvalId: "approval-1",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    projectId: "p1",
    runId: "run-1",
    taskId: "T1",
    approvalType: "CHECKPOINT_SCOPE_VIOLATION",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: "event-1",
    status: "PENDING",
    remotelyApprovable: false,
    requiresSafetyRecheck: true,
    dedupeKey: "dk-1",
    ...overrides,
  };
}

function scenarioFormatApprovalPreviewFoundApproval(): void {
  const store = createInMemoryApprovalStore();
  store.createPending(baseApprovalFixture());
  const out = formatApprovalPreview({ projectId: "p1", statePath: "C:/nowhere/state.json" }, store, "approval-1", "T1", new Date().toISOString());
  check("formatApprovalPreview: approval type 표시", out.includes("approval type: CHECKPOINT_SCOPE_VIOLATION"));
  check("formatApprovalPreview: approval status 표시", out.includes("approval status: PENDING"));
  check("formatApprovalPreview: remotelyApprovable 표시", out.includes("remotelyApprovable: false"));
  check("formatApprovalPreview: stale 여부 표시(아직 만료 전 → false)", out.includes("stale(만료됨): false"));
  check("formatApprovalPreview: statePath를 읽을 수 없으면 project status를 확인 불가로 표시(추측하지 않음)", out.includes("확인 불가"));
}

// ---------------------------------------------------------------------------
// Genuine Human Gate Local Approval CLI — 실제 production child-process 검증(§ 요구사항
// 15). 단위 테스트에서 performLocalHumanApproval()을 직접 호출하는 것(§ 이미
// local-human-approval-tests.ts가 담당)과, 실제 컴파일된 CLI entrypoint(node
// dist/project-control-cli.js approve ...)를 별도 프로세스로 실행해 실제 파일 기반
// ApprovalStore/EventStore/project-state.json을 읽고 쓰는 것은 서로 다른 질문이다 — 이
// 섹션은 후자만 검증한다. 실제 Claude CLI/GPT API를 호출하지 않기 위해 "성공" 시나리오는
// 실제 project-lock.ts(acquireProjectLock)로 이 project를 미리 점유해 두어
// resumeApprovedTask()가 runAutodevOnce()를 호출하기 전에 안전하게(그리고 빠르게)
// BLOCKED(PROJECT_ALREADY_LOCKED)로 끝나도록 한다 — approve CLI 자신의 검증/전이 로직은
// 그 지점까지 전부 실제로 실행된다(ApprovalStore PENDING→APPROVED 전이, deferredHumanTasks
// marker 제거, project-state.json READY 전환까지 전부 실제 파일 I/O로 확인한다).
//
// 실제 JARVIS 저장소/두 깨진 파일은 이 섹션 어디에서도 fixture로 쓰지 않는다 — 매 시나리오가
// 그 자체로 만드는 임시 git-init 없는 순수 임시 디렉터리만 사용한다.
// ---------------------------------------------------------------------------

const CLI_PATH = join(__dirname, "project-control-cli.js");

function relFromTo(fromDir: string, toDir: string): string {
  return relative(fromDir, toDir).split(sep).join("/");
}

function writeJson(dir: string, fileName: string, data: unknown): string {
  const abs = join(dir, fileName);
  writeFileSync(abs, JSON.stringify(data, null, 2) + "\n", "utf-8");
  return abs;
}

interface CliFixture {
  configDir: string;
  projectRoot: string;
  adapterPath: string;
  statePath: string;
  approvalStorePath: string;
  eventLogPath: string;
  projectId: string;
}

/** 실제 project config(JSON)/project-state.json/빈 project root를 OS 임시 디렉터리에
 *  만든다 — project-adapter-loader-tests.ts와 동일한 최소 유효 스키마를 그대로 따른다(중복
 *  스키마를 새로 만들지 않는다). */
function makeCliFixture(projectId: string, state: CoreState): CliFixture {
  const configDir = mkdtempSync(join(tmpdir(), "project-control-cli-approve-cfg-"));
  const projectRoot = mkdtempSync(join(tmpdir(), "project-control-cli-approve-root-"));
  const statePathAbs = writeJson(configDir, "project-state.json", state);
  const adapterPath = writeJson(configDir, "manifest.json", {
    projectId,
    projectName: projectId,
    targetProjectRoot: relFromTo(configDir, projectRoot),
    statePath: "project-state.json",
    taskRegistry: [],
    developerInstructions: "fixture",
    reviewInstructions: "fixture",
    reviewScopeDirs: ["fixture/"],
    executionPolicy: { allowedReadPrefixes: ["fixture/"], allowedWritePrefixes: ["fixture/"], allowedCommands: [] },
  });
  const approvalStorePath = join(configDir, "approvals.json");
  const eventLogPath = join(configDir, "events.jsonl");
  return { configDir, projectRoot, adapterPath, statePath: statePathAbs, approvalStorePath, eventLogPath, projectId };
}

function waitingHumanScopeViolationState(taskId: string, markerFile = "other/unexpected.txt"): CoreState {
  return {
    currentTask: `${taskId} prompt`,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "정상(하지만 scope 밖 파일이 있음)", nextTask: null },
    status: "WAITING_HUMAN",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [`CHECKPOINT_BLOCKED(${taskId}): 예상치 못한 범위 밖 파일 변경이 있어 commit을 중단했습니다. — unexpected: ${markerFile}`],
    completedTasks: [],
    gitCheckpoint: "",
    currentPhase: 1,
  };
}

function cleanupCliFixture(fixture: CliFixture): void {
  rmSync(fixture.configDir, { recursive: true, force: true });
  rmSync(fixture.projectRoot, { recursive: true, force: true });
}

interface CliRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runApproveCli(fixture: CliFixture, args: string[]): CliRunResult {
  const res = spawnSync(
    "node",
    [CLI_PATH, "approve", "--project", fixture.adapterPath, ...args],
    {
      encoding: "utf-8",
      env: {
        ...process.env,
        AUTODEV_APPROVAL_STORE_PATH: fixture.approvalStorePath,
        AUTODEV_EVENT_LOG_PATH: fixture.eventLogPath,
      },
    }
  );
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function readFixtureState(fixture: CliFixture): CoreState {
  return JSON.parse(readFileSync(fixture.statePath, "utf-8")) as CoreState;
}

function readFixtureApproval(fixture: CliFixture, approvalId: string): ApprovalRequest | undefined {
  const store = createFileApprovalStore(fixture.approvalStorePath);
  return store.get(approvalId);
}

// A) 정상 CHECKPOINT_SCOPE_VIOLATION + 현재 durable pending local approval → CLI 승인 성공
// → 기존 approval transition(PENDING→APPROVED) → resumeApprovedTask 경로가 실제로 호출됨
// (project lock을 미리 점유해 real Developer/API 호출 없이 BLOCKED(PROJECT_ALREADY_LOCKED)
// 로 안전하게 끝난다) → project-state.json이 READY로 전환됨.
async function scenarioRealCliApprovesPendingScopeViolation(): Promise<void> {
  const taskId = "T1";
  const fixture = makeCliFixture("real-cli-project-a", waitingHumanScopeViolationState(taskId));
  const approvalStore = createFileApprovalStore(fixture.approvalStorePath);
  const approval = approvalStore.createPending(
    baseApprovalFixture({ approvalId: "approval-a", projectId: fixture.projectId, taskId, dedupeKey: "dk-a" })
  );

  let lock: ProjectLockHandle | undefined;
  try {
    const acquired = acquireProjectLock({ projectId: fixture.projectId, targetProjectRoot: fixture.projectRoot, ownerKind: "autodev" });
    if (acquired.ok) lock = acquired.lock;
    check("A) 사전 조건: project lock을 실제로 선점함(Developer 재호출 방지용)", acquired.ok === true);

    const result = runApproveCli(fixture, ["--approval-id", approval.approvalId, "--task", taskId, "--approved-by", "qa-operator"]);

    check("A) CLI exit code=0", result.status === 0);
    check("A) 출력에 승인 전 확인 정보(project/approval type/reason)가 포함됨", result.stdout.includes(`project: ${fixture.projectId}`) && result.stdout.includes("CHECKPOINT_SCOPE_VIOLATION"));
    check("A) 출력에 '승인 처리됨' 문구 포함", result.stdout.includes("승인 처리됨"));

    const approvalAfter = readFixtureApproval(fixture, approval.approvalId);
    check("A) ApprovalStore: PENDING → APPROVED로 실제 전이됨", approvalAfter?.status === "APPROVED");

    const stateAfter = readFixtureState(fixture);
    check("A) deferredHumanTasks에서 해당 CHECKPOINT_BLOCKED marker가 제거됨", !stateAfter.deferredHumanTasks.some((m) => m.startsWith(`CHECKPOINT_BLOCKED(${taskId}):`)));
    check(
      "A) resumeApprovedTask가 project lock 재확인에서 BLOCKED를 반환했고, 그 결과로 status가 READY로 남음(runAutodevOnce가 실제로 호출되지 않음)",
      (stateAfter.status as unknown as string) === "READY"
    );
    check("A) 출력에 안전 재확인 보류(BLOCKED) 안내 포함", result.stdout.includes("보류됨(BLOCKED)") && result.stdout.includes("PROJECT_ALREADY_LOCKED"));
  } finally {
    if (lock) releaseProjectLock(lock);
    cleanupCliFixture(fixture);
  }
}

// B) WAITING_HUMAN이지만 지정한 approvalId로 등록된 pending approval이 없음 → 거부, 어떤
// 상태도 바뀌지 않음, fresh approval도 만들어지지 않음.
function scenarioRealCliRejectsUnknownApproval(): void {
  const taskId = "T1";
  const fixture = makeCliFixture("real-cli-project-b", waitingHumanScopeViolationState(taskId));
  try {
    const result = runApproveCli(fixture, ["--approval-id", "does-not-exist", "--task", taskId, "--approved-by", "qa-operator"]);
    check("B) CLI exit code != 0", result.status !== 0);
    check("B) 출력에 APPROVAL_NOT_FOUND 포함", result.stdout.includes("APPROVAL_NOT_FOUND"));
    const stateAfter = readFixtureState(fixture);
    check("B) project-state.json이 전혀 바뀌지 않음(여전히 WAITING_HUMAN, marker 그대로)", (stateAfter.status as unknown as string) === "WAITING_HUMAN" && stateAfter.deferredHumanTasks.length === 1);
  } finally {
    cleanupCliFixture(fixture);
  }
}

// F) 존재하는 approval이지만 --task로 다른(잘못된) taskId를 지정 → TASK_MISMATCH로 거부.
function scenarioRealCliRejectsTaskMismatch(): void {
  const taskId = "T1";
  const fixture = makeCliFixture("real-cli-project-f", waitingHumanScopeViolationState(taskId));
  const approvalStore = createFileApprovalStore(fixture.approvalStorePath);
  const approval = approvalStore.createPending(
    baseApprovalFixture({ approvalId: "approval-f", projectId: fixture.projectId, taskId, dedupeKey: "dk-f" })
  );
  try {
    const result = runApproveCli(fixture, ["--approval-id", approval.approvalId, "--task", "WRONG_TASK", "--approved-by", "qa-operator"]);
    check("F) CLI exit code != 0", result.status !== 0);
    check("F) 출력에 TASK_MISMATCH 포함", result.stdout.includes("TASK_MISMATCH"));
    const approvalAfter = readFixtureApproval(fixture, approval.approvalId);
    check("F) approval은 여전히 PENDING(소비되지 않음)", approvalAfter?.status === "PENDING");
  } finally {
    cleanupCliFixture(fixture);
  }
}

// H) 존재하는 approval이지만 다른 project의 것 → PROJECT_MISMATCH로 거부.
function scenarioRealCliRejectsProjectMismatch(): void {
  const taskId = "T1";
  const fixture = makeCliFixture("real-cli-project-h", waitingHumanScopeViolationState(taskId));
  const approvalStore = createFileApprovalStore(fixture.approvalStorePath);
  const approval = approvalStore.createPending(
    baseApprovalFixture({ approvalId: "approval-h", projectId: "some-other-project", taskId, dedupeKey: "dk-h" })
  );
  try {
    const result = runApproveCli(fixture, ["--approval-id", approval.approvalId, "--task", taskId, "--approved-by", "qa-operator"]);
    check("H) CLI exit code != 0", result.status !== 0);
    check("H) 출력에 PROJECT_MISMATCH 포함", result.stdout.includes("PROJECT_MISMATCH"));
  } finally {
    cleanupCliFixture(fixture);
  }
}

// C/G) project status가 WAITING_HUMAN이 아님(READY) → STATE_NOT_WAITING_HUMAN으로 거부.
function scenarioRealCliRejectsWhenNotWaitingHuman(): void {
  const taskId = "T1";
  const readyState: CoreState = { ...waitingHumanScopeViolationState(taskId), status: "READY", deferredHumanTasks: [] };
  const fixture = makeCliFixture("real-cli-project-c", readyState);
  const approvalStore = createFileApprovalStore(fixture.approvalStorePath);
  const approval = approvalStore.createPending(
    baseApprovalFixture({ approvalId: "approval-c", projectId: fixture.projectId, taskId, dedupeKey: "dk-c" })
  );
  try {
    const result = runApproveCli(fixture, ["--approval-id", approval.approvalId, "--task", taskId, "--approved-by", "qa-operator"]);
    check("C/G) CLI exit code != 0", result.status !== 0);
    check("C/G) 출력에 STATE_NOT_WAITING_HUMAN 포함", result.stdout.includes("STATE_NOT_WAITING_HUMAN"));
  } finally {
    cleanupCliFixture(fixture);
  }
}

// M/V) remotelyApprovable=true인 approval은 local CLI가 거부한다(Telegram 전용 경로로만
// 처리돼야 한다) — NOT_A_LOCAL_APPROVAL_TARGET.
function scenarioRealCliRejectsRemotelyApprovable(): void {
  const taskId = "T1";
  const fixture = makeCliFixture("real-cli-project-m", waitingHumanScopeViolationState(taskId));
  const approvalStore = createFileApprovalStore(fixture.approvalStorePath);
  const approval = approvalStore.createPending(
    baseApprovalFixture({ approvalId: "approval-m", projectId: fixture.projectId, taskId, remotelyApprovable: true, dedupeKey: "dk-m" })
  );
  try {
    const result = runApproveCli(fixture, ["--approval-id", approval.approvalId, "--task", taskId, "--approved-by", "qa-operator"]);
    check("M/V) CLI exit code != 0", result.status !== 0);
    check("M/V) 출력에 NOT_A_LOCAL_APPROVAL_TARGET 포함", result.stdout.includes("NOT_A_LOCAL_APPROVAL_TARGET"));
    const approvalAfter = readFixtureApproval(fixture, approval.approvalId);
    check("M/V) approval은 여전히 PENDING(Telegram 전용 경로가 아니면 아무도 소비하지 않음)", approvalAfter?.status === "PENDING");
  } finally {
    cleanupCliFixture(fixture);
  }
}

// I) stale(만료된) approval → APPROVAL_EXPIRED로 거부.
function scenarioRealCliRejectsExpiredApproval(): void {
  const taskId = "T1";
  const fixture = makeCliFixture("real-cli-project-i", waitingHumanScopeViolationState(taskId));
  const approvalStore = createFileApprovalStore(fixture.approvalStorePath);
  const pastIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const approval = approvalStore.createPending(
    baseApprovalFixture({ approvalId: "approval-i", projectId: fixture.projectId, taskId, expiresAt: pastIso, dedupeKey: "dk-i" })
  );
  try {
    const result = runApproveCli(fixture, ["--approval-id", approval.approvalId, "--task", taskId, "--approved-by", "qa-operator"]);
    check("I) CLI exit code != 0", result.status !== 0);
    check("I) 출력에 APPROVAL_EXPIRED 포함", result.stdout.includes("APPROVAL_EXPIRED"));
  } finally {
    cleanupCliFixture(fixture);
  }
}

// J/O) 같은 approval에 대해 CLI를 두 번 실행 — 두 번째는 안전하게 실패해야 하며(중복 승인
// 없음), resumeApprovedTask가 두 번 실행되지 않는다는 것을 project-state.json이 두 번째
// 실행으로 다시 바뀌지 않았는지로 확인한다.
function scenarioRealCliRejectsDuplicateApproval(): void {
  const taskId = "T1";
  const fixture = makeCliFixture("real-cli-project-j", waitingHumanScopeViolationState(taskId));
  const approvalStore = createFileApprovalStore(fixture.approvalStorePath);
  const approval = approvalStore.createPending(
    baseApprovalFixture({ approvalId: "approval-j", projectId: fixture.projectId, taskId, dedupeKey: "dk-j" })
  );
  let lock: ProjectLockHandle | undefined;
  try {
    const acquired = acquireProjectLock({ projectId: fixture.projectId, targetProjectRoot: fixture.projectRoot, ownerKind: "autodev" });
    if (acquired.ok) lock = acquired.lock;

    const first = runApproveCli(fixture, ["--approval-id", approval.approvalId, "--task", taskId, "--approved-by", "qa-operator"]);
    check("J/O) 첫 번째 승인: exit code=0", first.status === 0);
    const stateAfterFirst = readFixtureState(fixture);

    const second = runApproveCli(fixture, ["--approval-id", approval.approvalId, "--task", taskId, "--approved-by", "qa-operator"]);
    check("J/O) 두 번째(중복) 승인: exit code != 0", second.status !== 0);
    check("J/O) 두 번째 승인 출력에 APPROVAL_ALREADY_CONSUMED 포함", second.stdout.includes("APPROVAL_ALREADY_CONSUMED"));

    const stateAfterSecond = readFixtureState(fixture);
    check(
      "J/O) 두 번째(거부된) 실행이 project-state.json을 다시 바꾸지 않음(중복 resume 없음)",
      JSON.stringify(stateAfterSecond) === JSON.stringify(stateAfterFirst)
    );
  } finally {
    if (lock) releaseProjectLock(lock);
    cleanupCliFixture(fixture);
  }
}

// ---------------------------------------------------------------------------
// V) AutoDev Core Maintenance(2026-09-03) — final-review-approve/final-review-reject
//    서브커맨드(approveHumanFinalReview()/rejectHumanFinalReview()를 실제로 호출하는 유일한
//    production entrypoint, § project-control-cli.ts 상단 주석) — 실제 컴파일된 CLI를
//    child process로 실행해 project-state.json을 실제로 읽고 쓰는지 검증한다. 승인/거부 둘 다
//    project lock을 건드리지 않으므로(§ approveHumanFinalReview/rejectHumanFinalReview 자체가
//    runAutodevOnce()를 호출하지 않음, autodev.ts 참고) 위 approve 섹션과 달리 project lock
//    선점이 필요 없다.
// ---------------------------------------------------------------------------
function waitingHumanFinalReviewState(taskId: string, overrides: Partial<CoreState> = {}): CoreState {
  return {
    currentTask: `${taskId} prompt`,
    reviewCycle: 1,
    lastClaudeResult: null,
    lastGptDecision: { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "정상", nextTask: null },
    status: "WAITING_HUMAN",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
    gitCheckpoint: "",
    currentPhase: 1,
    humanFinalReview: { taskId, reviewCycle: 1, status: "PENDING", requestedAt: new Date().toISOString() },
    ...overrides,
  };
}

function runFinalReviewCli(fixture: CliFixture, command: "final-review-approve" | "final-review-reject", args: string[]): CliRunResult {
  const res = spawnSync("node", [CLI_PATH, command, "--project", fixture.adapterPath, ...args], { encoding: "utf-8" });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function scenarioRealCliFinalReviewApproveHappyPath(): void {
  const taskId = "T1";
  const fixture = makeCliFixture("real-cli-project-v1", waitingHumanFinalReviewState(taskId));
  try {
    const result = runFinalReviewCli(fixture, "final-review-approve", ["--task", taskId, "--approved-by", "qa-operator"]);
    check("V) approve happy path: exit code=0", result.status === 0);
    check("V) approve happy path: 출력에 APPROVED 문구 포함", result.stdout.includes("APPROVED"));

    const stateAfter = readFixtureState(fixture);
    check("V) approve happy path: gate.status='APPROVED'로 실제 전이됨", stateAfter.humanFinalReview?.status === "APPROVED");
    check(
      "V) approve happy path: status는 여전히 WAITING_HUMAN(즉시 checkpoint되지 않음 — 다음 정상 실행이 처리)",
      (stateAfter.status as unknown as string) === "WAITING_HUMAN"
    );
  } finally {
    cleanupCliFixture(fixture);
  }
}

function scenarioRealCliFinalReviewRejectHappyPath(): void {
  const taskId = "T1";
  const fixture = makeCliFixture("real-cli-project-v2", waitingHumanFinalReviewState(taskId));
  try {
    const result = runFinalReviewCli(fixture, "final-review-reject", ["--task", taskId, "--approved-by", "qa-operator"]);
    check("V) reject happy path: exit code=0", result.status === 0);
    check("V) reject happy path: 출력에 REJECTED 문구 포함", result.stdout.includes("REJECTED"));

    const stateAfter = readFixtureState(fixture);
    check("V) reject happy path: gate.status='REJECTED'로 실제 전이됨", stateAfter.humanFinalReview?.status === "REJECTED");
    check(
      "V) reject happy path: completedTasks에 taskId가 기록되지 않음(commit/complete 없음)",
      !stateAfter.completedTasks.includes(taskId)
    );
  } finally {
    cleanupCliFixture(fixture);
  }
}

function scenarioRealCliFinalReviewRejectsWrongTaskId(): void {
  const taskId = "T1";
  const fixture = makeCliFixture("real-cli-project-v3", waitingHumanFinalReviewState(taskId));
  try {
    const result = runFinalReviewCli(fixture, "final-review-approve", ["--task", "WRONG_TASK", "--approved-by", "qa-operator"]);
    check("V) 잘못된 taskId: exit code != 0", result.status !== 0);
    check("V) 잘못된 taskId: 출력에 TASK_MISMATCH 포함", result.stdout.includes("TASK_MISMATCH"));

    const stateAfter = readFixtureState(fixture);
    check("V) 잘못된 taskId 시도 후에도 gate는 여전히 PENDING(상태 변경 없음)", stateAfter.humanFinalReview?.status === "PENDING");
  } finally {
    cleanupCliFixture(fixture);
  }
}

function scenarioRealCliFinalReviewRejectsStaleReviewCycle(): void {
  const taskId = "T1";
  // gate는 reviewCycle=1을 가리키지만 project-state 자체의 reviewCycle은 2로 전진했다 —
  // 다른 개발 cycle의 오래된 승인을 stale로 거부해야 한다(사용자 조건 3).
  const fixture = makeCliFixture("real-cli-project-v4", waitingHumanFinalReviewState(taskId, { reviewCycle: 2 }));
  try {
    const result = runFinalReviewCli(fixture, "final-review-approve", ["--task", taskId, "--approved-by", "qa-operator"]);
    check("V) stale reviewCycle: exit code != 0", result.status !== 0);
    check("V) stale reviewCycle: 출력에 STALE_REVIEW_CYCLE 포함", result.stdout.includes("STALE_REVIEW_CYCLE"));

    const stateAfter = readFixtureState(fixture);
    check("V) stale reviewCycle 시도 후에도 gate는 여전히 PENDING", stateAfter.humanFinalReview?.status === "PENDING");
  } finally {
    cleanupCliFixture(fixture);
  }
}

function scenarioRealCliFinalReviewRejectsAlreadyCompletedTask(): void {
  const taskId = "T1";
  const fixture = makeCliFixture("real-cli-project-v5", waitingHumanFinalReviewState(taskId, { completedTasks: [taskId] }));
  try {
    const result = runFinalReviewCli(fixture, "final-review-approve", ["--task", taskId, "--approved-by", "qa-operator"]);
    check("V) 이미 완료된 task: exit code != 0", result.status !== 0);
    check("V) 이미 완료된 task: 출력에 TASK_ALREADY_COMPLETED 포함", result.stdout.includes("TASK_ALREADY_COMPLETED"));
  } finally {
    cleanupCliFixture(fixture);
  }
}

function scenarioRealCliFinalReviewRejectsWhenNoPendingGate(): void {
  const taskId = "T1";
  const fixture = makeCliFixture(
    "real-cli-project-v6",
    waitingHumanFinalReviewState(taskId, { humanFinalReview: undefined })
  );
  try {
    const result = runFinalReviewCli(fixture, "final-review-approve", ["--task", taskId, "--approved-by", "qa-operator"]);
    check("V) gate 자체가 없음: exit code != 0", result.status !== 0);
    check("V) gate 자체가 없음: 출력에 NO_PENDING_HUMAN_FINAL_REVIEW 포함", result.stdout.includes("NO_PENDING_HUMAN_FINAL_REVIEW"));
  } finally {
    cleanupCliFixture(fixture);
  }
}

function scenarioRealCliFinalReviewRejectsDuplicateApprove(): void {
  const taskId = "T1";
  const fixture = makeCliFixture("real-cli-project-v7", waitingHumanFinalReviewState(taskId));
  try {
    const first = runFinalReviewCli(fixture, "final-review-approve", ["--task", taskId, "--approved-by", "qa-operator"]);
    check("V) 중복 승인 방지: 첫 번째 승인 exit code=0", first.status === 0);

    // 사람이 실수로 버튼을 두 번 누른 상황 — gate가 이미 APPROVED로 소비되어(PENDING이 아님)
    // 두 번째 시도는 거부되어야 한다(사용자 조건 3 — stale/중복 승인 거부).
    const second = runFinalReviewCli(fixture, "final-review-approve", ["--task", taskId, "--approved-by", "qa-operator"]);
    check("V) 중복 승인 방지: 두 번째(중복) 승인 exit code != 0", second.status !== 0);
    check("V) 중복 승인 방지: 출력에 NO_PENDING_HUMAN_FINAL_REVIEW 포함", second.stdout.includes("NO_PENDING_HUMAN_FINAL_REVIEW"));
  } finally {
    cleanupCliFixture(fixture);
  }
}

function scenarioRealCliFinalReviewRequiresTaskAndApprovedBy(): void {
  const taskId = "T1";
  const fixture = makeCliFixture("real-cli-project-v8", waitingHumanFinalReviewState(taskId));
  try {
    const missingTask = spawnSync("node", [CLI_PATH, "final-review-approve", "--project", fixture.adapterPath, "--approved-by", "qa-operator"], {
      encoding: "utf-8",
    });
    check("V) --task 누락: exit code != 0(usage 오류)", missingTask.status !== 0);

    const missingApprovedBy = spawnSync("node", [CLI_PATH, "final-review-approve", "--project", fixture.adapterPath, "--task", taskId], {
      encoding: "utf-8",
    });
    check("V) --approved-by 누락: exit code != 0(usage 오류)", missingApprovedBy.status !== 0);
  } finally {
    cleanupCliFixture(fixture);
  }
}

// U) 기존 pause/resume/status/stop 서브커맨드가 approve 추가 이후에도 실제 child process로
// 정상 동작한다(회귀 없음) — status는 상태를 바꾸지 않으므로 골라서 확인한다.
function scenarioRealCliExistingStatusSubcommandStillWorks(): void {
  const taskId = "T1";
  const fixture = makeCliFixture("real-cli-project-u", waitingHumanScopeViolationState(taskId));
  try {
    const res = spawnSync("node", [CLI_PATH, "status", "--project", fixture.adapterPath], { encoding: "utf-8" });
    check("U) 기존 status 명령: exit code=0(회귀 없음)", res.status === 0);
    check("U) 기존 status 명령 출력 형식 유지(Maintenance Pause 표시 포함)", (res.stdout ?? "").includes("Maintenance Pause:"));
  } finally {
    cleanupCliFixture(fixture);
  }
}

async function main(): Promise<void> {
  scenarioParseArg();
  scenarioMaintenancePauseReflectedInStatus();
  scenarioSupervisorLockReflectedInStatus();
  scenarioProjectLockStatusVariants();
  scenarioDecideStopAction();
  scenarioFormatApprovalPreviewMissingApproval();
  scenarioFormatApprovalPreviewFoundApproval();

  await scenarioRealCliApprovesPendingScopeViolation();
  scenarioRealCliRejectsUnknownApproval();
  scenarioRealCliRejectsTaskMismatch();
  scenarioRealCliRejectsProjectMismatch();
  scenarioRealCliRejectsWhenNotWaitingHuman();
  scenarioRealCliRejectsRemotelyApprovable();
  scenarioRealCliRejectsExpiredApproval();
  scenarioRealCliRejectsDuplicateApproval();
  scenarioRealCliExistingStatusSubcommandStillWorks();

  scenarioRealCliFinalReviewApproveHappyPath();
  scenarioRealCliFinalReviewRejectHappyPath();
  scenarioRealCliFinalReviewRejectsWrongTaskId();
  scenarioRealCliFinalReviewRejectsStaleReviewCycle();
  scenarioRealCliFinalReviewRejectsAlreadyCompletedTask();
  scenarioRealCliFinalReviewRejectsWhenNoPendingGate();
  scenarioRealCliFinalReviewRejectsDuplicateApprove();
  scenarioRealCliFinalReviewRequiresTaskAndApprovedBy();

  console.log("\n=== project-control-cli 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
