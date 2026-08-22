import type { QueryResult, AuditIntegrityStatus } from "./event-store";
import { getAuditIntegrityStatus, describeAuditIntegrity } from "./event-store";
import type { AutoDevEvent, AutoDevEventType, TestResultSummary } from "./observability-event";
import type { GptDecision } from "./types";
import type { AgentRole } from "./agent-registry";

// Usage, Cost & Performance Metrics Foundation — Phase G Task G3.
//
// 이 파일은 G1/G2/G2.1의 EventStore(append-only, 이미 secret redaction/audit-critical 정책이
// 적용된 append-only 기록)의 순수 "소비자"다 — production 판정 로직(orchestrator.ts의 상태
// 전이, checkpoint.ts의 승인 조건, review-policy.ts의 override)을 새로 만들거나 바꾸지
// 않는다. 여기서 계산하는 모든 값은 이미 기록된 AutoDevEvent 필드를 읽어 집계할 뿐이다.
//
// 핵심 원칙(§ 요구사항):
//   - 실제 값이 없으면 추측하지 않는다. token/cost 데이터가 없으면 undefined — 0으로
//     채우지 않는다.
//   - duration은 실제로 기록된 "진짜 경계"(START event timestamp → 그 활동이 실제로 끝난
//     시점의 event timestamp)에서만 계산한다. RUN_STARTED→RUN_COMPLETED/RUN_BLOCKED,
//     TASK_STARTED→TASK_COMPLETED는 실제 wall-clock 경계다(그 사이에 실제 작업이 일어난다).
//     반면 AGENT_STARTED→AGENT_COMPLETED/AGENT_FAILED는 현재 production 배선(§
//     autodev.ts의 emitAdvisoryAgentEvents)이 이미 끝난 advisory 결과를 같은 루프
//     안에서 사후에 순서대로 기록하는 구조라 두 event의 timestamp 차이가 실제 소요 시간을
//     반영하지 않는다 — 그래서 Agent duration은 timestamp 차이로 "추정"하지 않고, event가
//     실제로 durationMs를 제공했을 때만 그 값을 쓴다(§ 요구사항: 추측 금지).
//   - EventStore.query() 결과의 integrity가 DEGRADED이면 이 파일의 모든 집계 결과에도
//     integrity: "DEGRADED"가 그대로 전달된다 — "완전한 정상 통계"처럼 보이지 않는다.
//   - raw prompt/Claude·GPT output/secret은 이 파일 어디에도 다시 노출하지 않는다 —
//     AutoDevEvent 자체가 이미 그런 필드를 담지 않거나(rawOutput은애초에 event 모델에 없음)
//     저장 전 redact됐으므로(§ observability-event.ts), 이 파일은 그 위에서 숫자/열거값만
//     다룬다. reason/error.message/metadata 같은 자유 텍스트 필드는 이 파일의 어떤 결과
//     타입에도 그대로 옮겨 담지 않는다.
//   - Dashboard/그래프/Notification/Claude usage 알림/DB migration/hash-chain/Agent
//     점수·랭킹/Project Lock은 이 Task 범위 밖이다 — 순수 집계 함수와 데이터 구조만 제공한다.

/** integrity가 DEGRADED일 때만 채워지는 사람이 읽는 한 줄 설명 — event-store.ts의
 *  describeAuditIntegrity()를 그대로 재사용한다(단일 출처, wording 재구현 금지). */
export interface MetricsIntegrityInfo {
  integrity: AuditIntegrityStatus;
  integrityNote?: string;
}

function integrityInfo(queryResult: Pick<QueryResult, "integrityIssues">): MetricsIntegrityInfo {
  const integrity = getAuditIntegrityStatus(queryResult);
  return integrity === "DEGRADED" ? { integrity, integrityNote: describeAuditIntegrity(queryResult) } : { integrity };
}

/** runId로 필터링하고 sequence 오름차순으로 정렬한다 — 호출부가 이미 EventStore.query({runId})
 *  로 필터링한 결과를 넘기더라도, 서로 다른 run의 event가 섞여 들어오는 실수를 이 파일
 *  내부에서 한 번 더 막는다(§ 요구사항: 서로 다른 runId 데이터 혼합 금지). */
function eventsForRun(queryResult: Pick<QueryResult, "events">, runId: string): AutoDevEvent[] {
  return queryResult.events.filter((e) => e.runId === runId).sort((a, b) => a.sequence - b.sequence);
}

function firstOfType(events: AutoDevEvent[], type: AutoDevEventType): AutoDevEvent | undefined {
  return events.find((e) => e.eventType === type);
}

function lastOfType(events: AutoDevEvent[], type: AutoDevEventType): AutoDevEvent | undefined {
  const matches = events.filter((e) => e.eventType === type);
  return matches.length > 0 ? matches[matches.length - 1] : undefined;
}

function countOfType(events: AutoDevEvent[], type: AutoDevEventType): number {
  return events.filter((e) => e.eventType === type).length;
}

/** 두 event의 timestamp가 둘 다 있을 때만 실제 경과 시간(ms)을 반환한다 — 추정하지 않는다. */
function realDurationMs(start: AutoDevEvent | undefined, end: AutoDevEvent | undefined): number | undefined {
  if (!start || !end) return undefined;
  const startMs = Date.parse(start.timestamp);
  const endMs = Date.parse(end.timestamp);
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return undefined;
  return endMs - startMs;
}

// ---------------------------------------------------------------------------
// Run Metrics
// ---------------------------------------------------------------------------

export type RunTerminalStatus = "RUN_COMPLETED" | "RUN_BLOCKED" | "UNKNOWN";

export interface RunMetrics extends MetricsIntegrityInfo {
  runId: string;
  startedAt?: string;
  endedAt?: string;
  /** RUN_STARTED/RUN_COMPLETED·RUN_BLOCKED가 둘 다 실제로 기록됐을 때만(§ realDurationMs). */
  durationMs?: number;
  terminalStatus: RunTerminalStatus;
  /** terminalStatus === "RUN_BLOCKED"와 동일한 값이다 — 호출부가 매번 문자열 비교를
   *  반복하지 않도록 boolean으로도 제공한다. */
  blocked: boolean;
  /** 이 run 안의 어떤 event든 humanInterventionRequired===true를 기록했으면 true다. */
  humanInterventionRequired: boolean;
  taskCount: number;
  taskIds: string[];
}

export function aggregateRunMetrics(queryResult: QueryResult, runId: string): RunMetrics {
  const events = eventsForRun(queryResult, runId);
  const started = firstOfType(events, "RUN_STARTED");
  const completed = firstOfType(events, "RUN_COMPLETED");
  const blockedEvent = firstOfType(events, "RUN_BLOCKED");
  const terminal = completed ?? blockedEvent;
  const terminalStatus: RunTerminalStatus = completed ? "RUN_COMPLETED" : blockedEvent ? "RUN_BLOCKED" : "UNKNOWN";

  const taskIds = Array.from(
    new Set(
      events
        .filter((e) => e.eventType === "TASK_STARTED")
        .map((e) => e.taskId)
        .filter((id): id is string => typeof id === "string")
    )
  );

  return {
    runId,
    startedAt: started?.timestamp,
    endedAt: terminal?.timestamp,
    durationMs: realDurationMs(started, terminal),
    terminalStatus,
    blocked: terminalStatus === "RUN_BLOCKED",
    humanInterventionRequired: events.some((e) => e.humanInterventionRequired === true),
    taskCount: taskIds.length,
    taskIds,
    ...integrityInfo(queryResult),
  };
}

// ---------------------------------------------------------------------------
// Task Metrics
// ---------------------------------------------------------------------------

export type TaskOutcome = "COMPLETED" | "BLOCKED" | "UNKNOWN";

const TASK_BLOCK_EVENT_TYPES: readonly AutoDevEventType[] = [
  "SECURITY_BLOCKED",
  "HUMAN_APPROVAL_REQUIRED",
  "REVIEW_BLOCKED",
  "REVIEW_CYCLE_EXHAUSTED",
];

export interface TaskMetrics extends MetricsIntegrityInfo {
  runId: string;
  taskId: string;
  startedAt?: string;
  endedAt?: string;
  /** TASK_STARTED/TASK_COMPLETED가 둘 다 실제로 기록됐을 때만(§ realDurationMs). BLOCKED로
   *  끝난 task는 TASK_COMPLETED가 없으므로 undefined다(끝난 시점을 추정하지 않는다). */
  durationMs?: number;
  outcome: TaskOutcome;
  checkpointCreated: boolean;
  /** 이 task에서 실제로 기록된 TEST_COMPLETED 중 가장 마지막(최종 cycle) 결과. REVISE
   *  cycle이 여러 번이면 이전 cycle의 test 결과는 여기 없다 — testRunCount로 몇 번
   *  실행됐는지는 알 수 있다. */
  finalTestSummary?: TestResultSummary;
  testRunCount: number;
  /** 이 task에서 가장 마지막으로 기록된 review 판정(REVIEW_APPROVED/REVIEW_REVISE/
   *  REVIEW_BLOCKED 중). review event가 하나도 없으면 undefined. */
  finalReviewDecision?: GptDecision;
  /** REVIEW_REVISE event 수 — "REVISE 몇 번 있었는지"를 그대로 센다(추정/보정 없음). */
  reviseCycleCount: number;
  securityBlocked: boolean;
  reviewCycleExhausted: boolean;
}

export function listTaskIdsForRun(queryResult: QueryResult, runId: string): string[] {
  return aggregateRunMetrics(queryResult, runId).taskIds;
}

export function aggregateTaskMetrics(queryResult: QueryResult, runId: string, taskId: string): TaskMetrics {
  const events = eventsForRun(queryResult, runId).filter((e) => e.taskId === taskId);
  const started = firstOfType(events, "TASK_STARTED");
  const completed = firstOfType(events, "TASK_COMPLETED");
  const hasBlock = TASK_BLOCK_EVENT_TYPES.some((t) => events.some((e) => e.eventType === t));
  const outcome: TaskOutcome = completed ? "COMPLETED" : hasBlock ? "BLOCKED" : "UNKNOWN";

  const finalTest = lastOfType(events, "TEST_COMPLETED");
  const finalReview =
    events
      .filter((e) => e.eventType === "REVIEW_APPROVED" || e.eventType === "REVIEW_REVISE" || e.eventType === "REVIEW_BLOCKED")
      .slice(-1)[0] ?? undefined;

  return {
    runId,
    taskId,
    startedAt: started?.timestamp,
    endedAt: completed?.timestamp,
    durationMs: realDurationMs(started, completed),
    outcome,
    checkpointCreated: events.some((e) => e.eventType === "CHECKPOINT_CREATED"),
    finalTestSummary: finalTest?.testSummary,
    testRunCount: countOfType(events, "TEST_COMPLETED"),
    finalReviewDecision: finalReview?.reviewDecision,
    reviseCycleCount: countOfType(events, "REVIEW_REVISE"),
    securityBlocked: events.some((e) => e.eventType === "SECURITY_BLOCKED"),
    reviewCycleExhausted: events.some((e) => e.eventType === "REVIEW_CYCLE_EXHAUSTED"),
    ...integrityInfo(queryResult),
  };
}

/** 이 run에서 TASK_STARTED가 기록된 taskId 전체에 대해 aggregateTaskMetrics()를 반복
 *  적용한 편의 함수 — Quality Metrics가 이 결과를 그대로 재사용한다(같은 task 판정 로직을
 *  두 곳에서 복제하지 않는다). */
export function aggregateAllTaskMetrics(queryResult: QueryResult, runId: string): TaskMetrics[] {
  return listTaskIdsForRun(queryResult, runId).map((taskId) => aggregateTaskMetrics(queryResult, runId, taskId));
}

// ---------------------------------------------------------------------------
// Agent Metrics
// ---------------------------------------------------------------------------

export interface AgentOutcomeCounts {
  success: number;
  failed: number;
  blocked: number;
  skipped: number;
}

export interface AgentMetrics extends MetricsIntegrityInfo {
  runId: string;
  agentId: string;
  /** 같은 agentId가 항상 같은 role로만 기록됐다는 보장은 없으므로(이론상) 실제로 관측된
   *  role을 그대로 담는다 — 관측된 값이 여러 개면 첫 번째로 관측된 값만 대표로 쓰지 않고
   *  undefined로 남긴다(추측 금지). */
  role?: AgentRole;
  callCount: number;
  outcomes: AgentOutcomeCounts;
  /** AGENT_STARTED→AGENT_COMPLETED/AGENT_FAILED의 timestamp 차이로 "추정"하지 않는다(§
   *  파일 상단 주석) — event가 실제로 durationMs를 제공한 경우에만(현재 production 배선은
   *  아직 이 값을 채우지 않는다) 그 값들의 합으로 채운다. 그런 event가 하나도 없으면
   *  undefined다. */
  totalDurationMs?: number;
  /** 이 agentId가 taskId별로 몇 번 호출됐는지 — 토큰 절감 평가(§ 요구사항)의 기초값. */
  callCountByTask: Record<string, number>;
}

export function aggregateAgentMetrics(queryResult: QueryResult, runId: string): AgentMetrics[] {
  const events = eventsForRun(queryResult, runId);
  const agentIds = Array.from(
    new Set(events.filter((e) => e.eventType === "AGENT_STARTED").map((e) => e.agentId).filter((id): id is string => typeof id === "string"))
  );

  return agentIds.map((agentId) => {
    const agentEvents = events.filter((e) => e.agentId === agentId);
    const startedEvents = agentEvents.filter((e) => e.eventType === "AGENT_STARTED");
    const completedEvents = agentEvents.filter((e) => e.eventType === "AGENT_COMPLETED");
    const failedEvents = agentEvents.filter((e) => e.eventType === "AGENT_FAILED");

    const roles = new Set(agentEvents.map((e) => e.agentRole).filter((r): r is AgentRole => r !== undefined));
    const role = roles.size === 1 ? [...roles][0] : undefined;

    const outcomes: AgentOutcomeCounts = { success: 0, failed: failedEvents.length, blocked: 0, skipped: 0 };
    for (const e of completedEvents) {
      if (e.outcome === "SUCCESS") outcomes.success += 1;
      else if (e.outcome === "BLOCKED") outcomes.blocked += 1;
      else if (e.outcome === "SKIPPED") outcomes.skipped += 1;
      else if (e.outcome === "FAILED") outcomes.failed += 1;
    }

    const explicitDurations = [...completedEvents, ...failedEvents]
      .map((e) => e.durationMs)
      .filter((d): d is number => typeof d === "number");
    const totalDurationMs = explicitDurations.length > 0 ? explicitDurations.reduce((sum, d) => sum + d, 0) : undefined;

    const callCountByTask: Record<string, number> = {};
    for (const e of startedEvents) {
      if (typeof e.taskId === "string") callCountByTask[e.taskId] = (callCountByTask[e.taskId] ?? 0) + 1;
    }

    return {
      runId,
      agentId,
      role,
      callCount: startedEvents.length,
      outcomes,
      totalDurationMs,
      callCountByTask,
      ...integrityInfo(queryResult),
    };
  });
}

// ---------------------------------------------------------------------------
// Quality Metrics
// ---------------------------------------------------------------------------

export interface QualityMetrics extends MetricsIntegrityInfo {
  runId: string;
  taskCount: number;
  /** REVIEW_REVISE 없이(reviseCycleCount===0) COMPLETED로 끝난 task 수 — "한 번에 승인"된
   *  task 수를 그대로 센다. */
  firstPassApprovedCount: number;
  /** taskId별 REVISE 횟수 — aggregateTaskMetrics()의 reviseCycleCount를 그대로 모은 것. */
  reviseCycleCountByTask: Record<string, number>;
  totalReviseCycles: number;
  /** finalTestSummary가 있고 failed===0인 task 수. */
  testPassCount: number;
  /** finalTestSummary가 있고 failed>0인 task 수. */
  testFailCount: number;
  securityBlockCount: number;
  reviewCycleExhaustedCount: number;
}

export function aggregateQualityMetrics(queryResult: QueryResult, runId: string): QualityMetrics {
  const taskMetrics = aggregateAllTaskMetrics(queryResult, runId);

  const reviseCycleCountByTask: Record<string, number> = {};
  let totalReviseCycles = 0;
  let firstPassApprovedCount = 0;
  let testPassCount = 0;
  let testFailCount = 0;
  let securityBlockCount = 0;
  let reviewCycleExhaustedCount = 0;

  for (const t of taskMetrics) {
    reviseCycleCountByTask[t.taskId] = t.reviseCycleCount;
    totalReviseCycles += t.reviseCycleCount;
    if (t.outcome === "COMPLETED" && t.reviseCycleCount === 0) firstPassApprovedCount += 1;
    if (t.finalTestSummary) {
      if (t.finalTestSummary.failed === 0) testPassCount += 1;
      else testFailCount += 1;
    }
    if (t.securityBlocked) securityBlockCount += 1;
    if (t.reviewCycleExhausted) reviewCycleExhaustedCount += 1;
  }

  return {
    runId,
    taskCount: taskMetrics.length,
    firstPassApprovedCount,
    reviseCycleCountByTask,
    totalReviseCycles,
    testPassCount,
    testFailCount,
    securityBlockCount,
    reviewCycleExhaustedCount,
    ...integrityInfo(queryResult),
  };
}

// ---------------------------------------------------------------------------
// Usage(token) Metrics
// ---------------------------------------------------------------------------

export interface UsageMetrics extends MetricsIntegrityInfo {
  runId: string;
  /** tokenUsage.inputTokens/outputTokens/totalTokens가 실제로 기록된 event가 하나 이상
   *  있어야 채워진다 — 하나도 없으면 undefined(0으로 채우지 않는다, § 요구사항). */
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** 이 run에서 실제로 관측된 model/provider 조합 — 여러 model이 섞여 있으면 그대로
   *  전부 나열한다(하나만 대표로 골라 보고하지 않는다). */
  models: { provider: string; name?: string }[];
  /** tokenUsage가 실제로 기록된 event 수 — 0이면 이 run에 token 데이터가 전혀 없었다는
   *  뜻이다(inputTokens 등이 왜 undefined인지 구분할 수 있게 남긴다). */
  eventsWithTokenData: number;
}

export function aggregateUsageMetrics(queryResult: QueryResult, runId: string): UsageMetrics {
  const events = eventsForRun(queryResult, runId);
  const withTokenUsage = events.filter((e) => e.tokenUsage !== undefined);

  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let totalTokens: number | undefined;
  for (const e of withTokenUsage) {
    if (e.tokenUsage?.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + e.tokenUsage.inputTokens;
    if (e.tokenUsage?.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + e.tokenUsage.outputTokens;
    if (e.tokenUsage?.totalTokens !== undefined) totalTokens = (totalTokens ?? 0) + e.tokenUsage.totalTokens;
  }

  const modelKeySeen = new Set<string>();
  const models: { provider: string; name?: string }[] = [];
  for (const e of events) {
    if (!e.model) continue;
    const key = `${e.model.provider}::${e.model.name ?? ""}`;
    if (modelKeySeen.has(key)) continue;
    modelKeySeen.add(key);
    models.push({ ...e.model });
  }

  return {
    runId,
    inputTokens,
    outputTokens,
    totalTokens,
    models,
    eventsWithTokenData: withTokenUsage.length,
    ...integrityInfo(queryResult),
  };
}

// ---------------------------------------------------------------------------
// Cost Metrics
// ---------------------------------------------------------------------------

export interface CostMetrics extends MetricsIntegrityInfo {
  runId: string;
  /** runner/billing source가 실제로 제공한 tokenUsage.actualCostUsd의 합 — 하나도 없으면
   *  undefined. estimatedCostUsd와 절대 섞지 않는다(§ 요구사항: 실제값과 estimated 값을
   *  혼합 금지). */
  actualCostUsd?: number;
  /** tokenUsage.estimatedCostUsd의 합 — actualCostUsd와 별도 필드로 유지한다. 이 파일은
   *  가격표를 만들거나 이 값을 스스로 계산하지 않는다 — event에 이미 기록된 값만 합산한다. */
  estimatedCostUsd?: number;
  /** actualCostUsd 계산에 쓰인 event 수. */
  eventsWithActualCostData: number;
  /** estimatedCostUsd 계산에 쓰인 event 수. */
  eventsWithEstimatedCostData: number;
}

export function aggregateCostMetrics(queryResult: QueryResult, runId: string): CostMetrics {
  const events = eventsForRun(queryResult, runId);

  let actualCostUsd: number | undefined;
  let eventsWithActualCostData = 0;
  let estimatedCostUsd: number | undefined;
  let eventsWithEstimatedCostData = 0;

  for (const e of events) {
    if (e.tokenUsage?.actualCostUsd !== undefined) {
      actualCostUsd = (actualCostUsd ?? 0) + e.tokenUsage.actualCostUsd;
      eventsWithActualCostData += 1;
    }
    if (e.tokenUsage?.estimatedCostUsd !== undefined) {
      estimatedCostUsd = (estimatedCostUsd ?? 0) + e.tokenUsage.estimatedCostUsd;
      eventsWithEstimatedCostData += 1;
    }
  }

  return {
    runId,
    actualCostUsd,
    estimatedCostUsd,
    eventsWithActualCostData,
    eventsWithEstimatedCostData,
    ...integrityInfo(queryResult),
  };
}
