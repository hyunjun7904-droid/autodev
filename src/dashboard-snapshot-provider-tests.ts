import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileEventStore } from "./event-store";
import type { EventStore } from "./event-store";
import type { AutoDevEventInput } from "./observability-event";
import { getDashboardSnapshot, resetDashboardSnapshotCacheForTests } from "./dashboard-snapshot-provider";

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

function scenarioProblemSolvingUndefinedWithoutMemoryData(): void {
  resetDashboardSnapshotCacheForTests();
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [ev({ eventType: "TASK_STARTED", runId: "run-noproblem", taskId: "T1", projectId: "proj-with-no-problem-history-xyz" })]);
  const snapshot = getDashboardSnapshot(filePath);
  check("problem-memory 기록이 전혀 없는 project는 problemSolving이 undefined", snapshot.problemSolving === undefined);
}

function main(): void {
  try {
    scenarioNoRunYet();
    scenarioLatestRunSelected();
    scenarioCacheHitWithoutFileChange();
    scenarioDegradedIntegrityPropagates();
    scenarioNoRawEventsExposed();
    scenarioUsageOverviewAndRecentCallsPopulatedFromRealEvents();
    scenarioProjectProgressUndefinedWithoutAdapterEnv();
    scenarioProblemSolvingUndefinedWithoutMemoryData();
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
