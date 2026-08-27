import { existsSync, statSync } from "node:fs";
import { createFileEventStore, RUNTIME_EVENT_LOG_PATH } from "./event-store";
import type { QueryResult } from "./event-store";
import { buildAutoDevLiveSnapshot } from "./live-snapshot";
import type { AutoDevLiveSnapshot } from "./live-snapshot";
import { computeActiveWorkMs, computeActiveWorkMsAcrossTasks } from "./work-time";
import { aggregateProviderModelUsage, sumProviderModelUsage, buildRecentCalls, aggregateCallEfficiency } from "./dashboard-usage";
import type { ProviderModelUsage, UsageTotals, RecentCallEntry, CallEfficiencySummary } from "./dashboard-usage";
import { loadProjectProgress } from "./dashboard-project-progress";
import type { ProjectProgress } from "./dashboard-project-progress";
import { buildProblemSolvingSnapshot } from "./dashboard-problem-solving";
import type { ProblemSolvingSnapshot } from "./dashboard-problem-solving";
import { createFileUsageLedger, resolveUsageLedgerFilePath, RUNTIME_USAGE_LEDGER_DIR } from "./usage-ledger";
import { readRoundStatus, isRoundStatusLive, RUNTIME_ROUND_STATUS_PATH } from "./round-status";
import type { RoundStatusSnapshot } from "./round-status";
import { buildAttemptOutcomes } from "./dashboard-attempt-outcomes";
import type { AttemptOutcomesSummary } from "./dashboard-attempt-outcomes";
import { loadProjectAdapter } from "./project-adapter-loader";
import { inspectProjectRuntimeLiveness } from "./project-lock";

// Local Operations Dashboard — Read Service / Cache Seam (Phase G Task G4.1).
//
// 이 파일은 G4의 AutoDevLiveSnapshot(live-snapshot.ts)을 "누가 지금 보고 있는 run인가"만
// 결정해 그대로 통과시키는 순수 읽기 전용 소비자다 — 어떤 production 판정도 새로 만들지
// 않는다(EventStore 재해석 금지, § live-snapshot.ts 상단 주석과 동일 원칙). 이 파일이 하는
// 일은 단 두 가지다:
//   1) event 파일(JSONL)을 매 요청마다 무한 재파싱하지 않도록 mtime/size 기반으로 캐시한다
//      (§ 요구사항: "Event 파일 전체를 매 refresh마다 비효율적으로 재처리하는 구조는 피한다").
//   2) 이 store 전체에서 "가장 최근 run"이 무엇인지 결정한다 — AutoDev는 한 번에 하나의
//      run만 실행하고(autodev.ts), EventStore의 sequence는 파일 전체에서 단조증가하므로
//      (§ event-store.ts), 정렬된 이벤트 목록의 마지막 event가 가리키는 runId가 항상 가장
//      최근 run이다. 새로운 "현재 run" 판정 규칙을 만들지 않고 이 사실만 그대로 쓴다.
//
// write/execute 경로는 이 파일 어디에도 없다 — export하는 함수는 전부 조회만 한다.

interface CacheEntry {
  filePath: string;
  mtimeMs: number;
  size: number;
  result: QueryResult;
}

let cache: CacheEntry | undefined;

/** filePath가 이전 캐시와 같고 mtime/size가 그대로면 재파싱하지 않고 캐시를 그대로 쓴다 —
 *  파일이 바뀌었으면(요구사항: append-only이므로 크기는 항상 증가하거나 그대로다)
 *  createFileEventStore(filePath).query()로 다시 읽는다. */
function readQueryResult(filePath: string): QueryResult {
  if (!existsSync(filePath)) {
    if (cache?.filePath === filePath) cache = undefined;
    return { events: [], integrityIssues: [] };
  }
  const stat = statSync(filePath);
  if (cache && cache.filePath === filePath && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.result;
  }
  const result = createFileEventStore(filePath).query();
  cache = { filePath, mtimeMs: stat.mtimeMs, size: stat.size, result };
  return result;
}

/** 테스트 전용 — 모듈 전역 캐시를 초기화해 테스트 간 상태가 새지 않게 한다. 운용
 *  호출부(dashboard-server.ts)는 이 함수를 쓰지 않는다. */
export function resetDashboardSnapshotCacheForTests(): void {
  cache = undefined;
}

function latestRunId(result: QueryResult): string | undefined {
  return result.events.length > 0 ? result.events[result.events.length - 1].runId : undefined;
}

export type DashboardSnapshotStatus = "OK" | "NO_RUN_YET";

export interface UsageOverview {
  allTime: { totals: UsageTotals; byService: ProviderModelUsage[] };
  currentTask?: { totals: UsageTotals; byService: ProviderModelUsage[] };
  /** § 요구사항 5 "실제 사용량 원장과 연결" — usage-ledger.ts(현재는 GPT Reviewer 호출만
   *  기록한다, § usage-ledger.ts 상단 주석)를 실제로 읽었다는 사실 자체를 정직하게
   *  드러낸다. byService/totals의 주된 근거는 EventStore다(Claude Developer 호출까지
   *  포함하는 유일하게 완전한 소스이기 때문 — 상세 근거는 아래 buildUsageOverview 주석). */
  usageLedgerEntryCount: number;
}

export interface ActualWorkTime {
  /** 현재 task의 실제 작업시간(ms) — currentTaskId가 없으면 undefined. */
  currentTaskMs?: number;
  /** 이 project 전체(모든 run/task 합산)의 실제 작업시간(ms) — projectId가 없으면 undefined. */
  projectTotalMs?: number;
}

export interface DashboardSnapshot {
  status: DashboardSnapshotStatus;
  generatedAt: string;
  /** status가 "OK"일 때만 채워진다 — G4의 데이터 계약을 그대로 통과시킨다. */
  snapshot?: AutoDevLiveSnapshot;
  /** AUTODEV_PROJECT_ADAPTER가 설정돼 있지 않거나 읽기에 실패하면 undefined — 추측하지
   *  않는다(§ 요구사항 3). */
  projectProgress?: ProjectProgress;
  actualWorkTime?: ActualWorkTime;
  usageOverview?: UsageOverview;
  recentCalls?: RecentCallEntry[];
  /** problem-memory.ts(지능형 오류 복구 하드닝)에 이 project의 기록이 전혀 없으면
   *  undefined(§ 요구사항 11 — 새 문제 해결 엔진을 만들지 않고 기존 자료만 읽는다). */
  problemSolving?: ProblemSolvingSnapshot;
  /** 현재 작업 범위(§ 요구사항 16 "호출 효율") — 이 task의 event에 devTotalRounds
   *  metadata가 전혀 없으면 undefined(추측 금지). */
  callEfficiency?: CallEfficiencySummary;
  /** § 요구사항 13 "현재 개발 라운드/최대 개발 라운드" — 지금 보여줄 run/task와 실제로
   *  일치하고 충분히 최근(§ ROUND_STATUS_MAX_AGE_MS)인 round-status.json 값이 있을 때만
   *  채워진다. 오래됐거나 다른 run/task의 값이면 undefined(추측해서 보여주지 않는다). */
  roundStatus?: RoundStatusSnapshot;
  /** § dashboard-attempt-outcomes.ts — 이 project(projectId가 없으면 전체)의 실제 완료된
   *  task attempt들을 CHECKPOINT_CREATED(성공)/RUN_BLOCKED(실패) event만으로 집계한다.
   *  runId 하나도 기록된 적이 없으면(NO_RUN_YET) 이 필드 자체가 없다. */
  attemptOutcomes?: AttemptOutcomesSummary;
  /**
   * AutoDev / JARVIS 최종 무인개발 구조 보완 — 대시보드 실행상태 보완(§ 요구사항 24).
   * snapshot.runStatus/taskStatus(EventStore의 마지막 event가 무엇이었는지)만으로는 그
   * 프로세스가 지금도 실제로 살아있는지 알 수 없다 — 마지막 event가 "RUNNING"류였는데
   * 그 프로세스가 죽었으면 이 값 없이는 영원히 실행 중처럼 보인다. project-lock.ts의
   * inspectProjectRuntimeLiveness()(읽기 전용, lock을 만들거나 지우지 않는다)로 실제 owner
   * PID의 생존 여부를 함께 확인해 이 문제를 없앤다 — scheduler/실행 로직은 전혀 건드리지
   * 않는 순수 표시 필드다(§ 요구사항: "이 변경은 표시/관측 로직에 한정한다"). AUTODEV_
   * PROJECT_ADAPTER가 설정돼 있지 않거나 project config를 읽을 수 없으면 undefined(추측
   * 금지).
   */
  runtimeTruth?: DashboardRuntimeTruth;
}

export type DashboardRuntimeState = "RUNNING" | "WAITING" | "STOPPED" | "STALE";

export interface DashboardRuntimeTruth {
  state: DashboardRuntimeState;
  reason: string;
}

/**
 * lock 파일이 없으면(present:false) 이 project를 대상으로 실행 중인 AutoDev writer가 전혀
 * 없다는 뜻이다 — project-state.json.status가 무엇이든("CLAUDE_WORKING"이 남아있어도) 그
 * 값을 신뢰하지 않고 STOPPED로 표시한다(§ 요구사항 24 핵심 사례). owner가 STALE/UNCERTAIN이면
 * (죽은 PID가 확인됐거나 확인 자체가 불가능함) lock 파일은 남아있어도 실행 중이라고 주장하지
 * 않는다 — STALE로 표시한다. owner가 ALIVE면 그제서야 event 기반 taskStatus를 참고해
 * WAITING_HUMAN이면 WAITING, 아니면 RUNNING으로 세분한다.
 */
export function computeDashboardRuntimeTruth(
  liveness: import("./project-lock").ProjectRuntimeLiveness,
  taskStatus: string | undefined
): DashboardRuntimeTruth {
  if (!liveness.present) {
    return { state: "STOPPED", reason: "실행 중인 AutoDev process lock이 없습니다." };
  }
  if (liveness.liveness.verdict === "STALE") {
    return { state: "STALE", reason: `owner(pid=${liveness.pid})가 더 이상 살아있지 않습니다(${liveness.liveness.evidence}).` };
  }
  if (liveness.liveness.verdict === "UNCERTAIN") {
    return { state: "STALE", reason: `owner(pid=${liveness.pid})의 생존 여부를 확인할 수 없습니다(${liveness.liveness.reason}).` };
  }
  if (taskStatus === "WAITING_HUMAN") {
    return { state: "WAITING", reason: `owner(pid=${liveness.pid})는 살아있지만 사람 승인을 기다리는 중입니다.` };
  }
  return { state: "RUNNING", reason: `owner(pid=${liveness.pid})가 실제로 실행 중입니다.` };
}

// round-status.json은 claude CLI가 실제로 응답을 받은 round 시작 시점에만 갱신된다 — 그
// 사이(USAGE_LIMIT 대기 등)에는 갱신되지 않을 수 있다. 너무 짧으면 정상적으로 오래 걸리는
// round도 "자료 없음"으로 사라지고, 너무 길면 이미 끝난 run의 낡은 값을 진행 중으로
// 오인시킬 수 있다 — 10분을 절충값으로 둔다(§ isRoundStatusLive).
const ROUND_STATUS_MAX_AGE_MS = 10 * 60 * 1000;

const RECENT_CALLS_LIMIT = 20;

/**
 * "서비스별 사용량"(§ 요구사항 5)의 주된 근거로 EventStore를 쓴다 — usage-ledger.ts는
 * 현재 GPT Reviewer 호출(operation="gpt_review")만 기록하고 Claude Developer 호출은 전혀
 * 기록하지 않는다(이 대시보드 작업 중 직접 소스를 확인해 알게 된 사실). usage-ledger만
 * 단독으로 쓰면 Claude가 실제로 계속 호출되고 있어도 화면에서 완전히 누락된다 — 그래서
 * TEST_COMPLETED(Developer)/REVIEW_APPROVED·REVISE·BLOCKED(Reviewer) event가 이미 담고
 * 있는 model/tokenUsage(§ observability-event.ts, claude-developer.ts/gpt-reviewer.ts가
 * 이미 정확히 채워 넣는다)를 유일한 소스로 쓴다 — Claude/GPT 양쪽을 실제로 빠짐없이 보여줄
 * 수 있는 것이 이 소스뿐이기 때문이다. usage-ledger는 별도로 읽어 "연결은 됐다"는 사실과
 * 실제 기록 건수만 정직하게 보여준다(§ 위 UsageOverview.usageLedgerEntryCount) — 두 소스를
 * 억지로 하나의 숫자로 합쳐서 이중 계산하지 않는다.
 */
function buildUsageOverview(allEvents: QueryResult["events"], projectId: string | undefined, currentTaskId: string | undefined): UsageOverview {
  const scopedToProject = projectId ? allEvents.filter((e) => e.projectId === projectId) : allEvents;
  const allTimeByService = aggregateProviderModelUsage(scopedToProject);
  const allTime = { totals: sumProviderModelUsage(allTimeByService), byService: allTimeByService };

  let currentTask: UsageOverview["currentTask"];
  if (currentTaskId) {
    const taskEvents = scopedToProject.filter((e) => e.taskId === currentTaskId);
    const byService = aggregateProviderModelUsage(taskEvents);
    currentTask = { totals: sumProviderModelUsage(byService), byService };
  }

  let usageLedgerEntryCount = 0;
  try {
    const resolved = resolveUsageLedgerFilePath(RUNTIME_USAGE_LEDGER_DIR, projectId);
    if (resolved.ok) {
      usageLedgerEntryCount = createFileUsageLedger(resolved.path).query().entries.length;
    }
  } catch {
    // 사용량 원장을 읽지 못해도(예: 파일 없음) 대시보드 전체를 무너뜨리지 않는다 — 0으로
    // 남긴다(추측 금지).
  }

  return { allTime, currentTask, usageLedgerEntryCount };
}

function buildActualWorkTime(allEvents: QueryResult["events"], projectId: string | undefined, currentTaskId: string | undefined, now: number): ActualWorkTime {
  const result: ActualWorkTime = {};
  if (currentTaskId) {
    const taskEvents = allEvents.filter((e) => e.taskId === currentTaskId).sort((a, b) => a.sequence - b.sequence);
    result.currentTaskMs = computeActiveWorkMs(taskEvents, now);
  }
  if (projectId) {
    const projectEvents = allEvents.filter((e) => e.projectId === projectId).sort((a, b) => a.sequence - b.sequence);
    result.projectTotalMs = computeActiveWorkMsAcrossTasks(projectEvents, now);
  }
  return result;
}

/**
 * 지금 보여줄 Live Snapshot을 만든다. events.jsonl에 event가 하나도 없으면(아직 production
 * run이 한 번도 없었음) "NO_RUN_YET"을 반환한다 — UNKNOWN이나 임의 기본값으로 채우지
 * 않는다.
 */
export function getDashboardSnapshot(filePath: string = RUNTIME_EVENT_LOG_PATH, roundStatusFilePath: string = RUNTIME_ROUND_STATUS_PATH): DashboardSnapshot {
  const result = readQueryResult(filePath);
  const runId = latestRunId(result);
  const now = Date.now();
  if (!runId) {
    return { status: "NO_RUN_YET", generatedAt: new Date(now).toISOString() };
  }
  const lastEvent = result.events[result.events.length - 1];
  const snapshot = buildAutoDevLiveSnapshot(result, { runId, projectId: lastEvent.projectId, now });

  // run.ts가 이미 쓰는 것과 완전히 동일한 project config 경로(§ project-adapter-loader.ts) —
  // 새 설정 방식을 만들지 않는다. 설정돼 있지 않으면 projectProgress는 undefined로 남는다.
  const adapterPath = process.env.AUTODEV_PROJECT_ADAPTER;
  const projectProgressResult = loadProjectProgress(adapterPath);

  const rawRoundStatus = readRoundStatus(roundStatusFilePath);
  const roundStatus =
    rawRoundStatus && snapshot.taskId && isRoundStatusLive(rawRoundStatus, runId, snapshot.taskId, now, ROUND_STATUS_MAX_AGE_MS) ? rawRoundStatus : undefined;

  // § 요구사항 24 — run.ts가 이미 쓰는 것과 동일한 project config 경로로 targetProjectRoot를
  // 얻는다(§ project-adapter-loader.ts, 새 설정 방식을 만들지 않는다). 읽을 수 없으면
  // runtimeTruth는 undefined로 남는다(추측 금지) — 다른 필드에는 전혀 영향을 주지 않는다.
  let runtimeTruth: DashboardRuntimeTruth | undefined;
  if (adapterPath) {
    try {
      const manifest = loadProjectAdapter(adapterPath);
      const liveness = inspectProjectRuntimeLiveness(manifest.projectId, manifest.targetProjectRoot);
      runtimeTruth = computeDashboardRuntimeTruth(liveness, snapshot.taskStatus);
    } catch {
      // project config를 읽지 못하면(잘못된 경로 등) 이 필드만 조용히 비운다 — 대시보드
      // 전체를 무너뜨리지 않는다(§ 요구사항: 추측 금지, 기존 다른 optional 필드와 동일 원칙).
    }
  }

  return {
    status: "OK",
    generatedAt: snapshot.generatedAt,
    snapshot,
    projectProgress: projectProgressResult.ok ? projectProgressResult.progress : undefined,
    actualWorkTime: buildActualWorkTime(result.events, snapshot.projectId, snapshot.taskId, now),
    usageOverview: buildUsageOverview(result.events, snapshot.projectId, snapshot.taskId),
    recentCalls: buildRecentCalls(result.events, RECENT_CALLS_LIMIT),
    problemSolving: buildProblemSolvingSnapshot(snapshot.projectId, snapshot.taskId),
    callEfficiency: aggregateCallEfficiency(snapshot.taskId ? result.events.filter((e) => e.taskId === snapshot.taskId) : result.events),
    roundStatus,
    attemptOutcomes: buildAttemptOutcomes(result.events, snapshot.projectId),
    runtimeTruth,
  };
}
