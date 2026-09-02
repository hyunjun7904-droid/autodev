import { mkdtempSync, rmSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileEventStore } from "./event-store";
import type { EventStore } from "./event-store";
import type { AutoDevEventInput } from "./observability-event";
import {
  getDashboardSnapshot,
  getMultiProjectDashboardSnapshot,
  resetDashboardSnapshotCacheForTests,
  computeDashboardRuntimeTruth,
} from "./dashboard-snapshot-provider";
import { createRoundStatusReporterForTests } from "./round-status";
import type { ProjectRuntimeLiveness } from "./project-lock";
import type { ProblemMemoryStore } from "./problem-memory";
import { DASHBOARD_PROJECT_ADAPTERS_ENV } from "./dashboard-project-registry";
import { maintenancePauseMarkerPath } from "./runner-supervisor";

// Local Operations Dashboard — Read Service / Cache Seam 테스트(Phase G Task G4.1). 실제
// Claude/GPT 유료 API를 호출하지 않는다 — 이 파일은 파일 기반 EventStore에 직접 event를
// append해 만든 fixture만 다룬다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeEventFilePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-dashboard-provider-"));
  tempDirs.push(dir);
  return join(dir, "events.jsonl");
}

function ev(overrides: Partial<AutoDevEventInput> & { eventType: AutoDevEventInput["eventType"]; runId: string }): AutoDevEventInput {
  return overrides;
}

function appendAll(store: EventStore, inputs: AutoDevEventInput[]): void {
  for (const i of inputs) store.append(i);
}

function scenarioNoRunYet(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath(); // 파일을 실제로 만들지 않는다.
  const snapshot = getDashboardSnapshot(filePath);
  check("NO_RUN_YET: status=NO_RUN_YET(파일 없음)", snapshot.status === "NO_RUN_YET");
  check("NO_RUN_YET: snapshot 필드 없음", snapshot.snapshot === undefined);
  check("NO_RUN_YET: generatedAt 실제 값", typeof snapshot.generatedAt === "string");
}

function scenarioLatestRunSelected(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [
    ev({ eventType: "RUN_STARTED", runId: "run-1", projectId: "proj-a" }),
    ev({ eventType: "TASK_STARTED", runId: "run-1", taskId: "T1", projectId: "proj-a" }),
    ev({ eventType: "RUN_COMPLETED", runId: "run-1", taskId: "T1", projectId: "proj-a", outcome: "SUCCESS" }),
    ev({ eventType: "RUN_STARTED", runId: "run-2", projectId: "proj-a" }),
    ev({ eventType: "TASK_STARTED", runId: "run-2", taskId: "T2", projectId: "proj-a" }),
  ]);
  const snapshot = getDashboardSnapshot(filePath);
  check("최신 run 자동 선택: status=OK", snapshot.status === "OK");
  check("최신 run 자동 선택: runId=run-2(더 최근에 append됨)", snapshot.snapshot?.runId === "run-2");
  check("최신 run 자동 선택: taskId=T2", snapshot.snapshot?.taskId === "T2");
  check("최신 run 자동 선택: run-1 event가 섞이지 않음(RUNNING)", snapshot.snapshot?.taskStatus === "RUNNING");
}

function scenarioCacheHitWithoutFileChange(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [ev({ eventType: "RUN_STARTED", runId: "run-cache" }), ev({ eventType: "TASK_STARTED", runId: "run-cache", taskId: "T1" })]);

  const first = getDashboardSnapshot(filePath);
  const second = getDashboardSnapshot(filePath);
  // 파일이 바뀌지 않았으면 내부 캐시가 그대로 재사용되므로, snapshot을 만든 원본 QueryResult가
  // 동일 참조여야 한다(재파싱이 일어나지 않았다는 증거) — buildAutoDevLiveSnapshot 자체는
  // 매번 새 객체를 반환하지만(now가 다를 수 있으므로), 두 호출의 taskId/runId 등 event에서
  // 유래한 값은 항상 동일해야 한다.
  check("캐시 히트: runId 동일", first.snapshot?.runId === second.snapshot?.runId);
  check("캐시 히트: taskId 동일", first.snapshot?.taskId === second.snapshot?.taskId);

  store.append(ev({ eventType: "TASK_COMPLETED", runId: "run-cache", taskId: "T1", outcome: "SUCCESS" }));
  const third = getDashboardSnapshot(filePath);
  check("캐시 무효화: 파일 변경 후 taskStatus가 갱신됨(COMPLETED)", third.snapshot?.taskStatus === "COMPLETED");
}

function scenarioDegradedIntegrityPropagates(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [ev({ eventType: "RUN_STARTED", runId: "run-degraded" }), ev({ eventType: "TASK_STARTED", runId: "run-degraded", taskId: "T1" })]);
  appendFileSync(filePath, "{ this is not valid JSON\n", "utf-8");

  const snapshot = getDashboardSnapshot(filePath);
  check("DEGRADED: integrity=DEGRADED", snapshot.snapshot?.integrity === "DEGRADED");
  check("DEGRADED: integrityNote가 손상 원문을 담지 않음", !!snapshot.snapshot?.integrityNote && !snapshot.snapshot.integrityNote.includes("not valid JSON"));
}

function scenarioNoRawEventsExposed(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [
    ev({ eventType: "RUN_STARTED", runId: "run-secretcheck" }),
    ev({ eventType: "TASK_STARTED", runId: "run-secretcheck", taskId: "T1", reason: "internal free-text reason should never leak" }),
  ]);
  const snapshot = getDashboardSnapshot(filePath);
  const serialized = JSON.stringify(snapshot);
  check("raw 노출 금지: DashboardSnapshot에 'events' 배열 필드가 없음", !Object.prototype.hasOwnProperty.call(snapshot, "events"));
  check("raw 노출 금지: event.reason 자유 텍스트가 그대로 새지 않음", !serialized.includes("internal free-text reason should never leak"));
}

// ---------------------------------------------------------------------------
// 오토데브 대시보드 후속 개선 — usageOverview/recentCalls/actualWorkTime/projectProgress/
// problemSolving 배선이 실제로 동작하는지 확인한다. 각 필드의 세부 계산 로직 자체는
// work-time-tests.ts/dashboard-usage-tests.ts/dashboard-project-progress-tests.ts/
// dashboard-problem-solving-tests.ts가 전담한다 — 여기서는 "getDashboardSnapshot()이 그
// 결과를 실제로 채워 넣는지"만 확인한다.
// ---------------------------------------------------------------------------
function scenarioUsageOverviewAndRecentCallsPopulatedFromRealEvents(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [
    ev({ eventType: "RUN_STARTED", runId: "run-usage", projectId: "proj-usage" }),
    ev({ eventType: "TASK_STARTED", runId: "run-usage", taskId: "T1", projectId: "proj-usage" }),
    ev({
      eventType: "TEST_COMPLETED",
      runId: "run-usage",
      taskId: "T1",
      projectId: "proj-usage",
      executionPhase: "test",
      outcome: "SUCCESS",
      reviseCycle: 1,
      model: { provider: "anthropic", name: "claude-sonnet-5" },
      tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    }),
  ]);
  const snapshot = getDashboardSnapshot(filePath);
  check("usageOverview.allTime에 실제 호출된 Claude가 나타남", snapshot.usageOverview?.allTime.byService.some((u) => u.service === "Claude") ?? false);
  check("usageOverview.allTime 총 토큰이 정확히 집계됨(150)", snapshot.usageOverview?.allTime.totals.totalTokens === 150);
  check("usageOverview.currentTask도 동일 task 범위로 채워짐", snapshot.usageOverview?.currentTask?.totals.totalTokens === 150);
  check("recentCalls에 방금 기록한 호출이 포함됨", (snapshot.recentCalls?.length ?? 0) >= 1);
  check("recentCalls의 purpose가 '개발'로 표시됨(reviseCycle=1)", snapshot.recentCalls?.[0]?.purpose === "개발");
  check("actualWorkTime.currentTaskMs가 계산됨(0 이상의 실제 값)", typeof snapshot.actualWorkTime?.currentTaskMs === "number");
  check("actualWorkTime.projectTotalMs가 계산됨", typeof snapshot.actualWorkTime?.projectTotalMs === "number");
}

function scenarioProjectProgressUndefinedWithoutAdapterEnv(): void {
  resetDashboardSnapshotCacheForTests();
  const originalAdapter = process.env.AUTODEV_PROJECT_ADAPTER;
  delete process.env.AUTODEV_PROJECT_ADAPTER;
  try {
    const filePath = makeEventFilePath();
    const store = createFileEventStore(filePath);
    appendAll(store, [ev({ eventType: "TASK_STARTED", runId: "run-noadapter", taskId: "T1", projectId: "proj-noadapter" })]);
    const snapshot = getDashboardSnapshot(filePath);
    check("AUTODEV_PROJECT_ADAPTER 미설정 시 projectProgress는 undefined(추측 안 함)", snapshot.projectProgress === undefined);
  } finally {
    if (originalAdapter === undefined) delete process.env.AUTODEV_PROJECT_ADAPTER;
    else process.env.AUTODEV_PROJECT_ADAPTER = originalAdapter;
  }
}

// § 요구사항 4 project-state 격리와 동일한 원칙 — buildProblemSolvingSnapshot()의 COMMON
// tier lookup은 항상 실제 logs/problem-memory/ 파일을 읽으므로(§ dashboard-problem-solving.ts
// 상단 주석 "대시보드는 production 여부와 무관하게 항상 실제 파일을 본다"), 이 저장소가
// 실제 개발에 쓰이며 이미 COMMON tier 기록이 쌓여 있으면 이 project는 그 기록과 무관한데도
// problemSolving이 undefined가 아니게 된다(§ 실제 재현됨). 이 시나리오는 "problem-memory
// 자료가 전혀 없을 때"를 검증하려는 것이므로, 반드시 격리된 빈 in-memory store를 명시적으로
// 주입한다(getDashboardSnapshot()의 problemMemoryStores 테스트 seam).
function makeEmptyProblemMemoryStore(): ProblemMemoryStore {
  return { load: () => [], save: () => {} };
}

function scenarioProblemSolvingUndefinedWithoutMemoryData(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [ev({ eventType: "TASK_STARTED", runId: "run-noproblem", taskId: "T1", projectId: "proj-with-no-problem-history-xyz" })]);
  const snapshot = getDashboardSnapshot(filePath, makeRoundStatusFilePath(), {
    project: makeEmptyProblemMemoryStore(),
    common: makeEmptyProblemMemoryStore(),
  });
  check("problem-memory 기록이 전혀 없는 project는 problemSolving이 undefined", snapshot.problemSolving === undefined);
}

// § 요구사항 13(현재 개발 라운드) — round-status.json이 지금 보여줄 run/task와 실제로
// 일치할 때만 노출되고, 다른 run/task 또는 파일이 없으면 절대 추측해서 채우지 않는지 검증.
function makeRoundStatusFilePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-dashboard-round-status-"));
  tempDirs.push(dir);
  return join(dir, "round-status.json");
}

function scenarioRoundStatusShownWhenMatchesCurrentRunAndTask(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const roundStatusFilePath = makeRoundStatusFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [ev({ eventType: "TASK_STARTED", runId: "run-round", taskId: "T1", projectId: "proj-a" })]);
  createRoundStatusReporterForTests(roundStatusFilePath).report({ runId: "run-round", taskId: "T1", round: 4, maxRounds: 20, stage: "DISCOVERY" });

  const snapshot = getDashboardSnapshot(filePath, roundStatusFilePath);
  check("현재 run/task와 일치하면 roundStatus가 채워짐", snapshot.roundStatus?.round === 4 && snapshot.roundStatus?.maxRounds === 20);
}

function scenarioRoundStatusHiddenWhenTaskDiffersOrMissing(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const roundStatusFilePath = makeRoundStatusFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [ev({ eventType: "TASK_STARTED", runId: "run-round-2", taskId: "T2", projectId: "proj-a" })]);
  // 다른(이미 끝난) task의 낡은 round 값 — 지금 보여줄 task(T2)와 다르다.
  createRoundStatusReporterForTests(roundStatusFilePath).report({ runId: "run-round-2", taskId: "T1-old", round: 9, maxRounds: 20, stage: "LOCKED" });

  const snapshot = getDashboardSnapshot(filePath, roundStatusFilePath);
  check("다른 task의 값이면 roundStatus가 undefined(추측 금지)", snapshot.roundStatus === undefined);

  resetDashboardSnapshotCacheForTests();
  const filePath2 = makeEventFilePath();
  const store2 = createFileEventStore(filePath2);
  appendAll(store2, [ev({ eventType: "TASK_STARTED", runId: "run-round-3", taskId: "T3", projectId: "proj-a" })]);
  const snapshotNoFile = getDashboardSnapshot(filePath2, makeRoundStatusFilePath()); // 파일 자체를 만들지 않음
  check("round-status 파일이 없으면 roundStatus가 undefined", snapshotNoFile.roundStatus === undefined);
}

// ---------------------------------------------------------------------------
// AutoDev / JARVIS 최종 무인개발 구조 보완 — computeDashboardRuntimeTruth(§ 요구사항 24, 32).
// 실제 lock/PID 조회는 project-lock-tests.ts가 이미 검증한다 — 여기서는 이 순수 결합 함수만
// 직접 검증한다(§ 요구사항 32의 세 가지 최소 시나리오).
// ---------------------------------------------------------------------------
function scenarioRuntimeTruthNoLockIsStopped(): void {
  const liveness: ProjectRuntimeLiveness = { present: false };
  const result = computeDashboardRuntimeTruth(liveness, "CLAUDE_WORKING");
  check(
    "project-state=CLAUDE_WORKING이어도 lock이 없으면(runner 죽음) RUNNING으로 표시하지 않음(STOPPED)",
    result.state === "STOPPED"
  );
}

function scenarioRuntimeTruthAliveAndWaitingHuman(): void {
  const liveness: ProjectRuntimeLiveness = {
    present: true,
    pid: 12345,
    processStartedAtMs: Date.now(),
    ownerKind: "autodev",
    liveness: { verdict: "ALIVE" },
  };
  const result = computeDashboardRuntimeTruth(liveness, "WAITING_HUMAN");
  check("owner가 살아있고 taskStatus가 WAITING_HUMAN이면 WAITING으로 표시", result.state === "WAITING");
}

function scenarioRuntimeTruthAliveAndRunning(): void {
  const liveness: ProjectRuntimeLiveness = {
    present: true,
    pid: 12345,
    processStartedAtMs: Date.now(),
    ownerKind: "autodev",
    liveness: { verdict: "ALIVE" },
  };
  const result = computeDashboardRuntimeTruth(liveness, "RUNNING");
  check("runner PID가 살아있고 정상 상태면 RUNNING으로 표시", result.state === "RUNNING");
}

function scenarioRuntimeTruthStaleLockDoesNotClaimRunning(): void {
  const liveness: ProjectRuntimeLiveness = {
    present: true,
    pid: 99999,
    processStartedAtMs: Date.now(),
    ownerKind: "autodev",
    liveness: { verdict: "STALE", evidence: "PID_NOT_RUNNING" },
  };
  const result = computeDashboardRuntimeTruth(liveness, "CLAUDE_WORKING");
  check("stale lock/dead PID는 RUNNING이 아닌 STALE로 표시", result.state === "STALE");
}

// ---------------------------------------------------------------------------
// AutoDev Dashboard 멀티프로젝트 운영센터 개선 — getMultiProjectDashboardSnapshot() 테스트.
// DASHBOARD_ONLY_ATTRIBUTION_DEFECT의 핵심 검증: N개 project의 event가 같은 파일에
// 섞여 있어도 project별로 정확히 귀속되고, 서로 오염되지 않는지 확인한다.
// ---------------------------------------------------------------------------

function writeMultiProjectAdapter(dir: string, projectId: string, projectName: string): string {
  const projectRoot = join(dir, projectId);
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "state.json"), JSON.stringify({ completedTasks: [] }), "utf-8");
  const adapterPath = join(projectRoot, "manifest.json");
  const manifest = {
    projectId,
    projectName,
    targetProjectRoot: ".",
    statePath: "state.json",
    taskRegistry: [
      { id: "T1", phase: 1, taskNumber: 1, title: "예시 작업", prompt: "p", requiredTests: [], allowedPathPrefixes: ["src/"], prohibitedOperations: [] },
    ],
    developerInstructions: "test",
    reviewInstructions: "test",
    reviewScopeDirs: ["src/"],
    executionPolicy: { allowedReadPrefixes: ["src/"], allowedWritePrefixes: ["src/"], allowedCommands: [] },
  };
  writeFileSync(adapterPath, JSON.stringify(manifest, null, 2), "utf-8");
  return adapterPath;
}

function scenarioMultiProjectAttributionNoContamination(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [
    ev({ eventType: "TASK_STARTED", runId: "run-multi-a", taskId: "TA", projectId: "multi-proj-a" }),
    ev({ eventType: "REVIEW_APPROVED", runId: "run-multi-a", taskId: "TA", projectId: "multi-proj-a", model: { provider: "fireworks", name: "m1" } }),
    ev({ eventType: "TASK_STARTED", runId: "run-multi-b", taskId: "TB", projectId: "multi-proj-b" }),
    ev({ eventType: "REVIEW_BLOCKED", runId: "run-multi-b", taskId: "TB", projectId: "multi-proj-b", model: { provider: "groq", name: "m2" } }),
  ]);
  const multi = getMultiProjectDashboardSnapshot(filePath);
  const a = multi.projects.find((p) => p.projectId === "multi-proj-a");
  const b = multi.projects.find((p) => p.projectId === "multi-proj-b");
  check("멀티프로젝트: 2개 project 모두 카드로 존재", a !== undefined && b !== undefined);
  check("A project: taskId가 A로 정확히 귀속", a?.snapshot?.taskId === "TA");
  check("B project: taskId가 B로 정확히 귀속(A로 섞이지 않음)", b?.snapshot?.taskId === "TB");
  check("A project: Reviewer 이력에 fireworks만", a?.reviewerHistory.length === 1 && a.reviewerHistory[0]?.provider === "fireworks");
  check("B project: Reviewer 이력에 groq만(A와 섞이지 않음)", b?.reviewerHistory.length === 1 && b.reviewerHistory[0]?.provider === "groq");
}

function scenarioMultiProjectRegisteredEventlessProjectStillShown(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath(); // event 없음(파일 자체를 만들지 않음)
  const registryDir = mkdtempSync(join(tmpdir(), "autodev-dashboard-multi-registry-"));
  tempDirs.push(registryDir);
  const adapterPath = writeMultiProjectAdapter(registryDir, "new-canary", "새 Canary(아직 미실행)");
  const multi = getMultiProjectDashboardSnapshot(filePath, undefined, { env: { [DASHBOARD_PROJECT_ADAPTERS_ENV]: JSON.stringify([adapterPath]) } });
  const entry = multi.projects.find((p) => p.projectId === "new-canary");
  check("event가 아직 없어도 registry에 등록된 project는 카드로 표시됨", entry !== undefined);
  check("event 없는 등록 project: status=NO_RUN_YET", entry?.status === "NO_RUN_YET");
  check("event 없는 등록 project: registered=true", entry?.registered === true);
  check("event 없는 등록 project: projectProgress는 manifest 기반으로 채워짐", entry?.projectProgress?.totalTasks === 1);
}

function scenarioMultiProjectUnregisteredButHasEventsStillShown(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [ev({ eventType: "TASK_STARTED", runId: "run-unreg", taskId: "T1", projectId: "unregistered-proj" })]);
  const multi = getMultiProjectDashboardSnapshot(filePath, undefined, { env: {} });
  const entry = multi.projects.find((p) => p.projectId === "unregistered-proj");
  check("registry에 없어도 event만으로 project 카드가 생김", entry !== undefined);
  check("등록되지 않은 project: registered=false", entry?.registered === false);
  check("등록되지 않은 project: projectLabel은 projectId 그대로(추측된 이름 없음)", entry?.projectLabel === "unregistered-proj");
}

function scenarioMultiProjectMaintenancePauseSurfacedSeparately(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [ev({ eventType: "TASK_STARTED", runId: "run-paused", taskId: "T1", projectId: "paused-proj" })]);
  const registryDir = mkdtempSync(join(tmpdir(), "autodev-dashboard-multi-pause-"));
  tempDirs.push(registryDir);
  const adapterPath = writeMultiProjectAdapter(registryDir, "paused-proj", "일시정지된 프로젝트");
  const logsDir = mkdtempSync(join(tmpdir(), "autodev-dashboard-multi-pause-logs-"));
  tempDirs.push(logsDir);
  writeFileSync(
    maintenancePauseMarkerPath(adapterPath, logsDir),
    JSON.stringify({ engagedAt: "2026-09-01T00:00:00.000Z", reason: "테스트용 유지보수" }),
    "utf-8"
  );
  const multi = getMultiProjectDashboardSnapshot(filePath, undefined, {
    env: { [DASHBOARD_PROJECT_ADAPTERS_ENV]: JSON.stringify([adapterPath]) },
    logsDir,
  });
  const entry = multi.projects.find((p) => p.projectId === "paused-proj");
  check("Maintenance Pause 마커가 있으면 maintenancePause.active=true", entry?.maintenancePause?.active === true);
  check("Maintenance Pause: engagedAt/reason이 그대로 노출됨", entry?.maintenancePause?.reason === "테스트용 유지보수");
}

// Dashboard Project Auto-Discovery(2026-09-03, Revenue OS 실제 운영 결함) — RUN_STARTED가
// manifest.adapterPath를 metadata로 실으면, 환경변수로 아무것도 등록하지 않아도(env: {})
// registered:true로 표시돼야 한다(§ dashboard-project-registry.ts discoverProjectsFromEvents).
function scenarioMultiProjectAutoDiscoveredFromRunStartedEventWithoutManualRegistration(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  const registryDir = mkdtempSync(join(tmpdir(), "autodev-dashboard-autodiscover-"));
  tempDirs.push(registryDir);
  const adapterPath = writeMultiProjectAdapter(registryDir, "auto-discovered-proj", "자동 발견 프로젝트");
  appendAll(store, [
    ev({ eventType: "RUN_STARTED", runId: "run-auto", projectId: "auto-discovered-proj", metadata: { adapterPath } }),
    ev({ eventType: "TASK_STARTED", runId: "run-auto", taskId: "T1", projectId: "auto-discovered-proj" }),
  ]);
  // env를 전혀 설정하지 않는다 — 이 project는 어디에도 수동으로 등록되지 않았다.
  const multi = getMultiProjectDashboardSnapshot(filePath, undefined, { env: {} });
  const entry = multi.projects.find((p) => p.projectId === "auto-discovered-proj");
  check("사람이 등록하지 않아도 RUN_STARTED만으로 registered=true가 됨(Revenue OS 결함 재현/검증)", entry?.registered === true);
  check("자동 발견: projectLabel이 manifest의 실제 이름으로 채워짐(추측 아님)", entry?.projectLabel === "자동 발견 프로젝트");
  check("자동 발견: taskId도 정확히 귀속됨", entry?.snapshot?.taskId === "T1");
}

// 같은 projectId가 다시 실행돼도(재시작/재배포) 중복 카드가 아니라 기존 카드 하나만 갱신돼야
// 한다(§ 요구사항 F) — event store에 RUN_STARTED가 두 번 쌓여도 결과는 항상 project 1개다.
function scenarioMultiProjectSameProjectIdRerunDoesNotDuplicateCard(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  const registryDir = mkdtempSync(join(tmpdir(), "autodev-dashboard-autodiscover-rerun-"));
  tempDirs.push(registryDir);
  const adapterPath = writeMultiProjectAdapter(registryDir, "rerun-auto-proj", "재실행 자동 발견");
  appendAll(store, [
    ev({ eventType: "RUN_STARTED", runId: "run-first", projectId: "rerun-auto-proj", metadata: { adapterPath } }),
    ev({ eventType: "RUN_COMPLETED", runId: "run-first", projectId: "rerun-auto-proj" }),
    ev({ eventType: "RUN_STARTED", runId: "run-second", projectId: "rerun-auto-proj", metadata: { adapterPath } }),
  ]);
  const multi = getMultiProjectDashboardSnapshot(filePath, undefined, { env: {} });
  const matches = multi.projects.filter((p) => p.projectId === "rerun-auto-proj");
  check("동일 projectId 재실행: 카드가 정확히 1개(중복 생성 없음)", matches.length === 1);
}

// 두 project(예: JARVIS/Revenue OS)가 서로 다른 프로세스로 동시에 실행돼도 각각 독립 카드로
// 자동 등록돼야 한다(§ 요구사항 H) — 새 격리 로직이 아니라 이미 검증된 projectId 귀속(§
// scenarioMultiProjectAttributionNoContamination)에 자동 발견을 얹었을 뿐임을 확인한다.
function scenarioMultiProjectTwoConcurrentAutoDiscoveredProjectsBothShown(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  const registryDir = mkdtempSync(join(tmpdir(), "autodev-dashboard-autodiscover-concurrent-"));
  tempDirs.push(registryDir);
  const adapterA = writeMultiProjectAdapter(registryDir, "concurrent-a", "동시 실행 A");
  const adapterB = writeMultiProjectAdapter(registryDir, "concurrent-b", "동시 실행 B");
  appendAll(store, [
    ev({ eventType: "RUN_STARTED", runId: "run-a", projectId: "concurrent-a", metadata: { adapterPath: adapterA } }),
    ev({ eventType: "RUN_STARTED", runId: "run-b", projectId: "concurrent-b", metadata: { adapterPath: adapterB } }),
  ]);
  const multi = getMultiProjectDashboardSnapshot(filePath, undefined, { env: {} });
  const a = multi.projects.find((p) => p.projectId === "concurrent-a");
  const b = multi.projects.find((p) => p.projectId === "concurrent-b");
  check("두 project가 동시에 실행돼도 둘 다 registered=true로 독립 표시됨", a?.registered === true && b?.registered === true);
}

// 과거 canary/fixture(event만 있고 adapterPath metadata가 없는 오래된 기록)는 이번 변경으로
// 사라지거나 합쳐지지 않는다(§ 요구사항 I) — 여전히 registered:false 미등록 카드로 남는다.
function scenarioMultiProjectLegacyEventOnlyProjectStillUnregistered(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [ev({ eventType: "RUN_STARTED", runId: "run-legacy", projectId: "legacy-canary-proj" })]); // adapterPath metadata 없음(과거 기록)
  const multi = getMultiProjectDashboardSnapshot(filePath, undefined, { env: {} });
  const entry = multi.projects.find((p) => p.projectId === "legacy-canary-proj");
  check("adapterPath metadata가 없는 과거 event 기록은 삭제/병합되지 않고 그대로 미등록 카드로 남음", entry !== undefined && entry.registered === false);
}

// Stale Discovered-Registration Reconciliation(2026-09-03, 실제 production Dashboard 재현
// 결함) — E2E 검증용 임시 project(§ scenarioMultiProjectAutoDiscoveredFromRunStartedEventWithoutManualRegistration와
// 동일한 모양)를 만든 뒤 manifest 디렉터리 전체를 지우고, getMultiProjectDashboardSnapshot()을
// 두 번 연속 호출(연속 polling 재현)해도 REGISTRY_ISSUE가 쌓이지 않고, 그 project는 여전히
// 과거 기록(미등록 카드)으로 조회 가능한지 확인한다.
function scenarioMultiProjectStaleDiscoveredManifestDoesNotProduceIssueOnRepeatedPolls(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  const registryDir = mkdtempSync(join(tmpdir(), "autodev-dashboard-stale-discover-"));
  tempDirs.push(registryDir);
  const adapterPath = writeMultiProjectAdapter(registryDir, "stale-discovered-proj", "정리된 임시 프로젝트");
  appendAll(store, [ev({ eventType: "RUN_STARTED", runId: "run-stale", projectId: "stale-discovered-proj", metadata: { adapterPath } })]);
  // 프로젝트 종료 후 정리(테스트 fixture 삭제, 또는 실제 project 디렉터리 정리)를 재현한다.
  rmSync(registryDir, { recursive: true, force: true });

  const firstPoll = getMultiProjectDashboardSnapshot(filePath, undefined, { env: {} });
  const secondPoll = getMultiProjectDashboardSnapshot(filePath, undefined, { env: {} });

  check("manifest가 사라진 뒤 첫 poll: registryIssues에 남지 않음", firstPoll.registryIssues.length === 0);
  check("manifest가 사라진 뒤 반복 poll: 두 번째 요청에도 registryIssues가 쌓이지 않음(무한 재발 없음)", secondPoll.registryIssues.length === 0);
  const entry = secondPoll.projects.find((p) => p.projectId === "stale-discovered-proj");
  check("manifest가 사라져도 project 자체는 과거 기록(미등록 카드)으로 계속 조회됨(데이터 손실 없음)", entry !== undefined && entry.registered === false);
}

function scenarioMultiProjectEventsWithoutProjectIdGetOwnBucket(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [
    ev({ eventType: "TASK_STARTED", runId: "run-noproj", taskId: "T1" }), // projectId 없음
    ev({ eventType: "TASK_STARTED", runId: "run-withproj", taskId: "T2", projectId: "real-proj" }),
  ]);
  const multi = getMultiProjectDashboardSnapshot(filePath, undefined, { env: {} });
  check("멀티프로젝트: projectId 없는 event와 있는 event가 서로 다른 카드", multi.projects.length === 2);
  const real = multi.projects.find((p) => p.projectId === "real-proj");
  check("projectId 있는 project에 taskId 없는 event가 섞이지 않음", real?.snapshot?.taskId === "T2");
}

// Dashboard 운영 UX 정리(§ 요구사항 12 Baseline) — buildTaskBaseline()이 이 project의
// projectEvents로만 계산되고 다른 project와 섞이지 않는지, 그리고 projectId가 없는
// UNASSIGNED 버킷에서는(재필터 버그를 만들지 않도록) 추측 없이 undefined로 남는지 확인한다.
function scenarioMultiProjectBaselineScopedPerProject(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [
    ev({ eventType: "TASK_STARTED", runId: "run-base-a", taskId: "TA", projectId: "base-proj-a" }),
    ev({ eventType: "TASK_STARTED", runId: "run-base-b", taskId: "TB", projectId: "base-proj-b" }),
    ev({ eventType: "TASK_STARTED", runId: "run-base-none", taskId: "TN" }), // projectId 없음
  ]);
  const multi = getMultiProjectDashboardSnapshot(filePath);
  const a = multi.projects.find((p) => p.projectId === "base-proj-a");
  const b = multi.projects.find((p) => p.projectId === "base-proj-b");
  const unassigned = multi.projects.find((p) => p.projectId === "__UNASSIGNED_PROJECT__");
  check("base-proj-a: baseline이 자신의 taskId(TA)로 계산됨", a?.baseline?.taskId === "TA" && a?.baseline?.projectId === "base-proj-a");
  check("base-proj-b: baseline이 자신의 taskId(TB)로 계산됨(A와 섞이지 않음)", b?.baseline?.taskId === "TB" && b?.baseline?.projectId === "base-proj-b");
  check("projectId 없는 UNASSIGNED 버킷: baseline을 추측해서 채우지 않고 undefined로 남김", unassigned?.baseline === undefined);
}

function main(): void {
  try {
    scenarioNoRunYet();
    scenarioMultiProjectAttributionNoContamination();
    scenarioMultiProjectBaselineScopedPerProject();
    scenarioMultiProjectRegisteredEventlessProjectStillShown();
    scenarioMultiProjectUnregisteredButHasEventsStillShown();
    scenarioMultiProjectAutoDiscoveredFromRunStartedEventWithoutManualRegistration();
    scenarioMultiProjectSameProjectIdRerunDoesNotDuplicateCard();
    scenarioMultiProjectTwoConcurrentAutoDiscoveredProjectsBothShown();
    scenarioMultiProjectLegacyEventOnlyProjectStillUnregistered();
    scenarioMultiProjectStaleDiscoveredManifestDoesNotProduceIssueOnRepeatedPolls();
    scenarioMultiProjectMaintenancePauseSurfacedSeparately();
    scenarioMultiProjectEventsWithoutProjectIdGetOwnBucket();
    scenarioRoundStatusShownWhenMatchesCurrentRunAndTask();
    scenarioRoundStatusHiddenWhenTaskDiffersOrMissing();
    scenarioLatestRunSelected();
    scenarioCacheHitWithoutFileChange();
    scenarioDegradedIntegrityPropagates();
    scenarioNoRawEventsExposed();
    scenarioUsageOverviewAndRecentCallsPopulatedFromRealEvents();
    scenarioProjectProgressUndefinedWithoutAdapterEnv();
    scenarioProblemSolvingUndefinedWithoutMemoryData();
    scenarioRuntimeTruthNoLockIsStopped();
    scenarioRuntimeTruthAliveAndWaitingHuman();
    scenarioRuntimeTruthAliveAndRunning();
    scenarioRuntimeTruthStaleLockDoesNotClaimRunning();
  } finally {
    resetDashboardSnapshotCacheForTests();
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // 정리 실패는 테스트 결과에 영향 없음(OS 임시 디렉터리).
      }
    }
  }

  console.log("\n=== dashboard-snapshot-provider(G4.1) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
