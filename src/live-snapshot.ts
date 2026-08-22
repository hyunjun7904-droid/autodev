import type { QueryResult, AuditIntegrityStatus } from "./event-store";
import { getAuditIntegrityStatus, describeAuditIntegrity } from "./event-store";
import type { AutoDevEvent, AutoDevEventType, TestResultSummary, ExecutionPhase } from "./observability-event";
import type { GptDecision, SeverityCounts } from "./types";
import type { AgentRole } from "./agent-registry";
import { aggregateAgentMetrics, aggregateTaskMetrics } from "./metrics";
import type { AgentMetrics } from "./metrics";
import { describeClaudeUsageSnapshot } from "./claude-usage-snapshot";
import type { ClaudeUsageSnapshot } from "./claude-usage-snapshot";

// Live Operations Read Model & Dashboard Data Foundation — Phase G Task G4.
//
// G1~G3.1의 EventStore(observability-event.ts/event-store.ts)와 Usage/Cost/Performance
// Metrics(metrics.ts)의 순수 "소비자"다 — 이 파일은 어떤 production 판정도 만들거나
// 바꾸지 않는다: Developer/Reviewer/Test/Security Gate/Checkpoint 로직은 전혀 건드리지
// 않고, 이미 기록된 AutoDevEvent를 사람이(그리고 향후 Dashboard가) 보기 좋은 구조로
// "변환"만 한다. 실제 시각적 Dashboard UI는 이 Task 범위 밖이다 — 여기서는 그 UI가 읽을
// 정확한 데이터 계약(AutoDevLiveSnapshot)만 만든다.
//
// 핵심 원칙:
//   - Live(현재 run/task/agent/review cycle)와 Historical(완료 task 통계)을 분리한다.
//     장기 DB는 만들지 않는다 — 호출부가 넘긴 EventStore.query() 결과(단일 runId로 좁힌
//     것이든, 파일 store 전체 이력이든)만 그대로 집계한다.
//   - 상태는 현재 Event/State에서 확실하게 알 수 있는 값만 쓴다 — 알 수 없으면 UNKNOWN
//     (§ LiveStatus). 새로운 추측 규칙을 만들지 않는다.
//   - integrity가 DEGRADED(§ event-store.ts)면 그 사실을 숨기지 않고 그대로 전파한다.
//   - raw prompt/Claude·GPT 원문 출력/source 전체/secret은 이 파일 어디에도 담지 않는다 —
//     AutoDevEvent 자체가 이미 그런 필드를 담지 않거나 저장 전 redact됐고(§
//     observability-event.ts), 이 파일은 그 위에서 파일명/test명/agent명/model/usage/
//     status 같은 운영 metadata만 다룬다. event.reason/error.message/metadata 같은 자유
//     텍스트 필드는(이미 redact됐더라도) 이 스냅샷의 어떤 필드에도 그대로 옮겨 담지 않는다
//     — currentAction은 event type별 고정 라벨(§ CURRENT_ACTION_LABELS)만 쓴다.
//   - "다른 runId 데이터 혼합 금지"(metrics.ts와 동일한 방어) — 이 파일의 모든 집계는
//     호출부가 이미 필터링한 QueryResult를 넘기더라도 내부에서 runId/taskId로 한 번 더
//     필터링한다.

// ---------------------------------------------------------------------------
// Deterministic Status — UI가 임의 해석하지 않아도 되는 단일 상태 어휘.
// ---------------------------------------------------------------------------

export type LiveStatus =
  | "IDLE"
  | "RUNNING"
  | "TESTING"
  | "REVIEWING"
  | "REVISING"
  | "WAITING_HUMAN"
  | "BLOCKED"
  | "CHECKPOINTING"
  | "COMPLETED"
  | "UNKNOWN";

// event type → 이 event가 관측되면 전이되는 상태의 단일 출처. RUN_STARTED/RUN_COMPLETED는
// outcome에 따라 의미가 갈리므로(§ walkEvents) 이 표에 넣지 않고 별도 처리한다.
const STATUS_TRANSITIONS: Partial<Record<AutoDevEventType, LiveStatus>> = {
  TASK_STARTED: "RUNNING",
  AGENT_SELECTED: "RUNNING",
  AGENT_STARTED: "RUNNING",
  AGENT_COMPLETED: "RUNNING",
  AGENT_FAILED: "RUNNING",
  DEVELOPER_RETRY_STARTED: "RUNNING",
  TEST_STARTED: "TESTING",
  TEST_COMPLETED: "TESTING",
  REVIEW_STARTED: "REVIEWING",
  REVIEW_APPROVED: "RUNNING",
  REVIEW_REVISE: "REVISING",
  REVIEW_BLOCKED: "WAITING_HUMAN",
  SECURITY_BLOCKED: "BLOCKED",
  CHECKPOINT_CREATED: "CHECKPOINTING",
  HUMAN_APPROVAL_REQUIRED: "WAITING_HUMAN",
  REVIEW_CYCLE_EXHAUSTED: "WAITING_HUMAN",
  TASK_COMPLETED: "COMPLETED",
  RUN_BLOCKED: "BLOCKED",
};

// currentOperation.currentAction의 단일 출처 — 항상 이 고정 라벨만 쓴다(event.reason 같은
// 자유 텍스트를 절대 그대로 노출하지 않는다).
const CURRENT_ACTION_LABELS: Partial<Record<AutoDevEventType, string>> = {
  RUN_STARTED: "실행 시작",
  TASK_STARTED: "Task 시작",
  AGENT_SELECTED: "Agent 선택됨",
  AGENT_STARTED: "Agent 실행 중",
  AGENT_COMPLETED: "Agent 완료",
  AGENT_FAILED: "Agent 실패",
  DEVELOPER_RETRY_STARTED: "Developer 재작업 시작",
  TEST_STARTED: "Test 실행 중",
  TEST_COMPLETED: "Test 완료",
  REVIEW_STARTED: "GPT 리뷰 진행 중",
  REVIEW_APPROVED: "리뷰 승인됨",
  REVIEW_REVISE: "REVISE 요청됨",
  REVIEW_BLOCKED: "리뷰 차단됨",
  SECURITY_BLOCKED: "보안 게이트 차단됨",
  CHECKPOINT_CREATED: "Checkpoint 생성됨",
  HUMAN_APPROVAL_REQUIRED: "사람 승인 대기 중",
  REVIEW_CYCLE_EXHAUSTED: "Review Cycle 소진",
  TASK_COMPLETED: "Task 완료",
  RUN_COMPLETED: "Run 완료",
  RUN_BLOCKED: "Run 차단됨",
};

interface EventWalkResult {
  status: LiveStatus;
  phase?: ExecutionPhase;
  currentAction?: string;
  startedAt?: string;
  activeAgentId?: string;
  activeAgentRole?: AgentRole;
}

/**
 * events(이미 runId/taskId 등으로 좁혀진, sequence 오름차순 목록)를 한 번만 순회해 "지금
 * 어떤 상태인가"를 결정한다. 새 상태 판정 규칙을 산발적으로 만들지 않고 이 함수 하나가
 * 단일 출처다.
 *   - events가 비어있으면(이 scope에 대한 event가 하나도 없음) UNKNOWN — "모른다"와
 *     "확인 결과 아무 일도 없었다(IDLE)"를 구분한다.
 *   - RUN_COMPLETED(outcome=SKIPPED)면서 이 scope에 TASK_STARTED가 한 번도 없었다면
 *     IDLE(§ autodev.ts decideNextAction의 STOP 경로 — 실행할 task가 없거나 이미
 *     WAITING_HUMAN이라 아무 것도 하지 않은 경우).
 *   - 그 외 RUN_COMPLETED는 COMPLETED.
 *   - AGENT_STARTED로 활성화된 agent는 그 같은 agentId의 AGENT_COMPLETED/AGENT_FAILED가
 *     오면 다시 비활성화한다 — "지금 실행 중인 agent"만 담는다(끝난 agent는 advisory
 *     집계(§ aggregateAgentMetrics)로만 확인한다).
 */
function walkEvents(events: AutoDevEvent[]): EventWalkResult {
  if (events.length === 0) return { status: "UNKNOWN" };

  let status: LiveStatus = "IDLE";
  let phase: ExecutionPhase | undefined;
  let currentAction: string | undefined;
  let startedAt: string | undefined;
  let activeAgentId: string | undefined;
  let activeAgentRole: AgentRole | undefined;
  let sawTaskStarted = false;

  for (const e of events) {
    if (e.eventType === "TASK_STARTED") sawTaskStarted = true;

    if (e.eventType === "AGENT_STARTED") {
      activeAgentId = e.agentId;
      activeAgentRole = e.agentRole;
    } else if ((e.eventType === "AGENT_COMPLETED" || e.eventType === "AGENT_FAILED") && e.agentId === activeAgentId) {
      activeAgentId = undefined;
      activeAgentRole = undefined;
    }

    if (e.eventType === "RUN_COMPLETED") {
      status = e.outcome === "SKIPPED" && !sawTaskStarted ? "IDLE" : "COMPLETED";
    } else {
      const mapped = STATUS_TRANSITIONS[e.eventType];
      if (mapped) status = mapped;
    }

    const label = CURRENT_ACTION_LABELS[e.eventType];
    if (label) {
      currentAction = label;
      startedAt = e.timestamp;
      if (e.executionPhase) phase = e.executionPhase;
    }
  }

  return { status, phase, currentAction, startedAt, activeAgentId, activeAgentRole };
}

// ---------------------------------------------------------------------------
// 내부 필터/집계 helper — metrics.ts의 비공개 helper와 동일한 방어 원칙(§ 다른 runId 혼합
// 금지)을 이 파일에서도 독립적으로 지킨다. metrics.ts는 이 helper들을 export하지 않으므로
// 여기서 최소한으로 다시 둔다(로직 자체는 3~10줄의 단순 filter/sum이라 재사용을 위해
// metrics.ts의 export 표면을 넓히지 않는다).
// ---------------------------------------------------------------------------

function eventsForRun(queryResult: Pick<QueryResult, "events">, runId: string): AutoDevEvent[] {
  return queryResult.events.filter((e) => e.runId === runId).sort((a, b) => a.sequence - b.sequence);
}

function lastTaskIdStarted(events: AutoDevEvent[]): string | undefined {
  const started = events.filter((e): e is AutoDevEvent & { taskId: string } => e.eventType === "TASK_STARTED" && typeof e.taskId === "string");
  return started.length > 0 ? started[started.length - 1].taskId : undefined;
}

export interface TokenUsageTotals {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** tokenUsage가 실제로 기록된 event가 하나도 없으면 undefined(0으로 채우지 않는다) —
 *  metrics.ts의 aggregateUsageMetrics와 동일한 "추측 금지" 원칙을 provider/역할별로 좁혀
 *  적용한 버전이다(그 파일은 run 전체 합산만 제공하고 역할/provider로 나누지 않는다). */
function sumTokenUsage(events: AutoDevEvent[]): TokenUsageTotals | undefined {
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let totalTokens: number | undefined;
  let any = false;
  for (const e of events) {
    if (!e.tokenUsage) continue;
    any = true;
    if (e.tokenUsage.inputTokens !== undefined) inputTokens = (inputTokens ?? 0) + e.tokenUsage.inputTokens;
    if (e.tokenUsage.outputTokens !== undefined) outputTokens = (outputTokens ?? 0) + e.tokenUsage.outputTokens;
    if (e.tokenUsage.totalTokens !== undefined) totalTokens = (totalTokens ?? 0) + e.tokenUsage.totalTokens;
  }
  return any ? { inputTokens, outputTokens, totalTokens } : undefined;
}

function lastOfType(events: AutoDevEvent[], type: AutoDevEventType): AutoDevEvent | undefined {
  const matches = events.filter((e) => e.eventType === type);
  return matches.length > 0 ? matches[matches.length - 1] : undefined;
}

function countOfType(events: AutoDevEvent[], type: AutoDevEventType): number {
  return events.filter((e) => e.eventType === type).length;
}

function extractCommitHash(event: AutoDevEvent | undefined): string | undefined {
  const v = event?.metadata?.commitHash;
  return typeof v === "string" ? v : undefined;
}

// ---------------------------------------------------------------------------
// AutoDevLiveSnapshot — Dashboard가 읽을 데이터 계약. "Mobile 친화 구조" 요구사항에 따라
// 중첩을 도메인별 얕은 그룹(currentOperation/development/tests/review/advisory/safety/
// quality/usage/subscriptionUsage/historical)으로만 나눈다.
// ---------------------------------------------------------------------------

export interface ModelRef {
  provider: string;
  name?: string;
}

export interface AutoDevLiveSnapshot {
  generatedAt: string;
  projectId?: string;
  runId: string;
  taskId?: string;
  runStatus: LiveStatus;
  taskStatus: LiveStatus;
  /** 이 snapshot을 만든 query 결과의 audit integrity — DEGRADED면 완전한 기록이 아닐 수
   *  있다는 뜻이다(§ event-store.ts). 정상 데이터처럼 숨기지 않는다. */
  integrity: AuditIntegrityStatus;
  integrityNote?: string;

  currentOperation: {
    phase?: ExecutionPhase;
    activeAgentId?: string;
    activeAgentRole?: AgentRole;
    /** 고정 라벨만 담는다(§ CURRENT_ACTION_LABELS) — event.reason 등 자유 텍스트는 절대
     *  담지 않는다. */
    currentAction?: string;
    startedAt?: string;
    /** startedAt이 있을 때만(§ realDurationMs와 동일한 원칙 — 실제 기록된 시각과 snapshot
     *  생성 시각의 실제 경과 시간이다, 추정값이 아니다). */
    elapsedMs?: number;
  };

  development: {
    callCount: number;
    model?: ModelRef;
    tokenUsage?: TokenUsageTotals;
  };

  tests: {
    status: "PASS" | "FAIL" | "UNKNOWN";
    latest?: TestResultSummary;
    testRunCount: number;
  };

  review: {
    decision?: GptDecision;
    severity?: SeverityCounts;
    reviewCycle: number;
    callCount: number;
    model?: ModelRef;
    tokenUsage?: TokenUsageTotals;
  };

  advisory: {
    selected: { agentId: string; role?: AgentRole }[];
    completedAgentIds: string[];
    failedAgentIds: string[];
    callCountByAgent: Record<string, number>;
  };

  safety: {
    securityBlocked: boolean;
    humanApprovalRequired: boolean;
    auditIntegrity: AuditIntegrityStatus;
    checkpointStatus: "NONE" | "CREATED";
    checkpointCommitHash?: string;
  };

  quality: {
    /** task outcome이 아직 COMPLETED/BLOCKED로 확정되지 않았으면 undefined(추측 금지). */
    firstPassApproved?: boolean;
    reviseCount: number;
    reviewCycleExhausted: boolean;
  };

  usage: {
    claudeTokens?: TokenUsageTotals;
    gptTokens?: TokenUsageTotals;
    totalKnownTokens?: number;
    actualCostUsd?: number;
    estimatedCostUsd?: number;
  };

  /** source가 없으면 undefined(§ claude-usage-snapshot.ts — 추정/역산 금지). */
  subscriptionUsage?: ClaudeUsageSnapshot;

  historical: HistoricalSummary;
}

export interface BuildLiveSnapshotOptions {
  runId: string;
  projectId?: string;
  /** 지정하지 않으면 이 run에서 가장 최근 TASK_STARTED의 taskId를 자동으로 쓴다. */
  taskId?: string;
  /** elapsedMs 계산 기준 시각(ms) — 테스트에서만 override, 기본값은 Date.now(). */
  now?: number;
  /** 향후 실제 source가 연결되면 그대로 통과시킨다(§ claude-usage-snapshot.ts) — 이 Task는
   *  값을 만들어내지 않는다. */
  claudeUsage?: ClaudeUsageSnapshot;
  /** historical 집계 대상을 이 projectId로 좁힌다 — 지정하지 않으면 넘겨받은 queryResult
   *  전체(여러 project가 섞여 있을 수 있는 파일 store 전체 이력)를 그대로 쓴다. */
  historicalProjectId?: string;
}

/**
 * G1~G3.1의 EventStore.query() 결과로부터 한 run(및 그 run의 현재 task)의 Live snapshot을
 * 만든다. 이 함수는 어떤 production 판정도 하지 않는다 — 이미 기록된 event만 읽어
 * 표시하기 좋은 구조로 변환한다.
 */
export function buildAutoDevLiveSnapshot(queryResult: QueryResult, opts: BuildLiveSnapshotOptions): AutoDevLiveSnapshot {
  const runEvents = eventsForRun(queryResult, opts.runId);
  const currentTaskId = opts.taskId ?? lastTaskIdStarted(runEvents);
  const taskEvents = currentTaskId ? runEvents.filter((e) => e.taskId === currentTaskId) : runEvents;

  const runWalk = walkEvents(runEvents);
  const taskWalk = walkEvents(taskEvents);

  const now = opts.now ?? Date.now();
  const elapsedMs = taskWalk.startedAt !== undefined ? now - Date.parse(taskWalk.startedAt) : undefined;

  const integrity = getAuditIntegrityStatus(queryResult);
  const integrityNote = integrity === "DEGRADED" ? describeAuditIntegrity(queryResult) : undefined;

  // Development — developer(Claude worker) 실제 호출 관측치. TASK_STARTED가 최초 시도를
  // 이미 표시하므로(§ observability-event.ts DEVELOPER_RETRY_STARTED 주석과 동일한 관례),
  // 총 호출 수는 "최초 1회(있었다면) + DEVELOPER_RETRY_STARTED 수"다.
  const testCompletedEvents = taskEvents.filter((e) => e.eventType === "TEST_COMPLETED");
  const developerCallCount = (taskEvents.some((e) => e.eventType === "TASK_STARTED") ? 1 : 0) + countOfType(taskEvents, "DEVELOPER_RETRY_STARTED");
  const lastTestCompleted = testCompletedEvents.length > 0 ? testCompletedEvents[testCompletedEvents.length - 1] : undefined;

  // Review — GPT reviewer 실제 호출 관측치.
  const reviewDecisionEvents = taskEvents.filter(
    (e) => e.eventType === "REVIEW_APPROVED" || e.eventType === "REVIEW_REVISE" || e.eventType === "REVIEW_BLOCKED"
  );
  const lastReviewDecisionEvent = reviewDecisionEvents.length > 0 ? reviewDecisionEvents[reviewDecisionEvents.length - 1] : undefined;
  const reviewCycle = taskEvents.reduce((max, e) => (typeof e.reviseCycle === "number" && e.reviseCycle > max ? e.reviseCycle : max), 0);

  // Advisory — planner/research/qa/security(agent-registry.ts) 관측치. G3의
  // aggregateAgentMetrics를 그대로 재사용한다(집계 로직을 복제하지 않는다).
  const agentMetrics: AgentMetrics[] = aggregateAgentMetrics(queryResult, opts.runId).filter((a) =>
    currentTaskId ? (a.callCountByTask[currentTaskId] ?? 0) > 0 : true
  );

  const taskMetrics = currentTaskId ? aggregateTaskMetrics(queryResult, opts.runId, currentTaskId) : undefined;

  const checkpointEvent = lastOfType(taskEvents, "CHECKPOINT_CREATED");

  const claudeTokens = sumTokenUsage(taskEvents.filter((e) => e.model?.provider === "anthropic"));
  const gptTokens = sumTokenUsage(taskEvents.filter((e) => e.model?.provider === "openai"));
  const totalKnownTokens =
    claudeTokens?.totalTokens !== undefined || gptTokens?.totalTokens !== undefined
      ? (claudeTokens?.totalTokens ?? 0) + (gptTokens?.totalTokens ?? 0)
      : undefined;
  let actualCostUsd: number | undefined;
  let estimatedCostUsd: number | undefined;
  for (const e of taskEvents) {
    if (e.tokenUsage?.actualCostUsd !== undefined) actualCostUsd = (actualCostUsd ?? 0) + e.tokenUsage.actualCostUsd;
    if (e.tokenUsage?.estimatedCostUsd !== undefined) estimatedCostUsd = (estimatedCostUsd ?? 0) + e.tokenUsage.estimatedCostUsd;
  }

  const testStatus: "PASS" | "FAIL" | "UNKNOWN" = !taskMetrics?.finalTestSummary
    ? "UNKNOWN"
    : taskMetrics.finalTestSummary.failed === 0
      ? "PASS"
      : "FAIL";

  return {
    generatedAt: new Date(now).toISOString(),
    projectId: opts.projectId,
    runId: opts.runId,
    taskId: currentTaskId,
    runStatus: runWalk.status,
    taskStatus: taskWalk.status,
    integrity,
    integrityNote,

    currentOperation: {
      phase: taskWalk.phase,
      activeAgentId: taskWalk.activeAgentId,
      activeAgentRole: taskWalk.activeAgentRole,
      currentAction: taskWalk.currentAction,
      startedAt: taskWalk.startedAt,
      elapsedMs,
    },

    development: {
      callCount: developerCallCount,
      model: lastTestCompleted?.model,
      tokenUsage: sumTokenUsage(testCompletedEvents),
    },

    tests: {
      status: testStatus,
      latest: taskMetrics?.finalTestSummary,
      testRunCount: taskMetrics?.testRunCount ?? countOfType(taskEvents, "TEST_COMPLETED"),
    },

    review: {
      decision: lastReviewDecisionEvent?.reviewDecision,
      severity: lastReviewDecisionEvent?.reviewSeverity,
      reviewCycle,
      callCount: countOfType(taskEvents, "REVIEW_STARTED"),
      model: lastReviewDecisionEvent?.model,
      tokenUsage: sumTokenUsage(reviewDecisionEvents),
    },

    advisory: {
      selected: agentMetrics.map((a) => ({ agentId: a.agentId, role: a.role })),
      completedAgentIds: agentMetrics.filter((a) => a.outcomes.success > 0).map((a) => a.agentId),
      failedAgentIds: agentMetrics.filter((a) => a.outcomes.failed > 0).map((a) => a.agentId),
      callCountByAgent: Object.fromEntries(agentMetrics.map((a) => [a.agentId, a.callCount])),
    },

    safety: {
      securityBlocked: taskEvents.some((e) => e.eventType === "SECURITY_BLOCKED"),
      humanApprovalRequired: taskEvents.some((e) => e.eventType === "HUMAN_APPROVAL_REQUIRED"),
      auditIntegrity: integrity,
      checkpointStatus: checkpointEvent ? "CREATED" : "NONE",
      checkpointCommitHash: extractCommitHash(checkpointEvent),
    },

    quality: {
      firstPassApproved:
        taskMetrics?.outcome === "COMPLETED" ? taskMetrics.reviseCycleCount === 0 : undefined,
      reviseCount: taskMetrics?.reviseCycleCount ?? countOfType(taskEvents, "REVIEW_REVISE"),
      reviewCycleExhausted: taskMetrics?.reviewCycleExhausted ?? taskEvents.some((e) => e.eventType === "REVIEW_CYCLE_EXHAUSTED"),
    },

    usage: {
      claudeTokens,
      gptTokens,
      totalKnownTokens,
      actualCostUsd,
      estimatedCostUsd,
    },

    subscriptionUsage: describeClaudeUsageSnapshot(opts.claudeUsage),

    historical: aggregateHistoricalSummary(queryResult, opts.historicalProjectId ? { projectId: opts.historicalProjectId } : undefined),
  };
}

// ---------------------------------------------------------------------------
// Historical Summary — Live(위 snapshot)과 명확히 분리된, 완료된 task들에 대한 요약
// 통계다. 장기 DB를 새로 만들지 않는다 — 호출부가 넘긴 QueryResult(여러 run/여러 task를
// 포함할 수 있는 이력)를 그대로 집계한다. runId별로 metrics.ts의 aggregateAllTaskMetrics/
// aggregateAgentMetrics를 재사용해 합산할 뿐, 새 task/agent 판정 로직을 만들지 않는다.
// ---------------------------------------------------------------------------

export interface HistoricalSummary {
  integrity: AuditIntegrityStatus;
  integrityNote?: string;
  completedTaskCount: number;
  /** completedTaskCount===0이면 undefined(0/0 같은 무의미한 값을 만들지 않는다). */
  firstPassApprovalRate?: number;
  totalReviseCycles: number;
  totalAgentCalls: number;
  claudeTokens?: TokenUsageTotals;
  gptTokens?: TokenUsageTotals;
}

export function aggregateHistoricalSummary(queryResult: QueryResult, filter?: { projectId?: string }): HistoricalSummary {
  const events = filter?.projectId ? queryResult.events.filter((e) => e.projectId === filter.projectId) : queryResult.events;
  const scoped: QueryResult = { events, integrityIssues: queryResult.integrityIssues };
  const runIds = Array.from(new Set(events.map((e) => e.runId)));

  let completedTaskCount = 0;
  let firstPassApprovedCount = 0;
  let totalReviseCycles = 0;
  let totalAgentCalls = 0;

  for (const runId of runIds) {
    const runEvents = eventsForRun(scoped, runId);
    const taskIds = Array.from(new Set(runEvents.filter((e) => e.eventType === "TASK_STARTED" && typeof e.taskId === "string").map((e) => e.taskId as string)));
    for (const taskId of taskIds) {
      const task = aggregateTaskMetrics(scoped, runId, taskId);
      totalReviseCycles += task.reviseCycleCount;
      if (task.outcome === "COMPLETED") {
        completedTaskCount += 1;
        if (task.reviseCycleCount === 0) firstPassApprovedCount += 1;
      }
    }
    for (const agent of aggregateAgentMetrics(scoped, runId)) totalAgentCalls += agent.callCount;
  }

  const claudeTokens = sumTokenUsage(events.filter((e) => e.model?.provider === "anthropic"));
  const gptTokens = sumTokenUsage(events.filter((e) => e.model?.provider === "openai"));
  const integrity = getAuditIntegrityStatus(scoped);

  return {
    integrity,
    integrityNote: integrity === "DEGRADED" ? describeAuditIntegrity(scoped) : undefined,
    completedTaskCount,
    firstPassApprovalRate: completedTaskCount > 0 ? firstPassApprovedCount / completedTaskCount : undefined,
    totalReviseCycles,
    totalAgentCalls,
    claudeTokens,
    gptTokens,
  };
}

// ---------------------------------------------------------------------------
// Notification 연결 seam — Phase G Task G4 요구사항: Notification Service(미구현)가 향후
// 재사용할 수 있는 작은 deterministic seam만 마련한다. 이 함수는 알림을 전송하지 않는다 —
// 순수하게 "이 snapshot이 어떤 알림 신호에 해당하는가"만 판정한다.
//
// future-operations.md가 나열한 알림 이벤트 중 이 Task가 실제로 관측 가능한 신호만
// 구현한다(§ 요구사항: 확실하게 알 수 있는 것만). CLAUDE_USAGE_LIMIT/AUTODEV_ERROR/
// PHASE_COMPLETED는 현재 AutoDevEventType 어휘로 관측할 수 없어(§ orchestrator.ts의
// WAITING_CLAUDE_LIMIT은 event를 남기지 않고, PHASE_COMPLETED 판정에는 이 Read Model이
// 갖지 않은 taskRegistry 전체 정보가 필요하다) 이 함수가 반환하지 않는다 — 추측으로
// 채우지 않는다. 그 신호들이 필요해지면 별도 Task에서 해당 event type을 먼저 추가해야 한다.
// ---------------------------------------------------------------------------

export type NotifiableSignal = "WAITING_HUMAN" | "SECURITY_BLOCKED" | "TEST_FAILED" | "REVIEW_CYCLE_EXHAUSTED" | "TASK_COMPLETED";

/** 우선순위: security block > review cycle 소진 > waiting human > test 실패 > task 완료.
 *  앞의 것이 뒤의 것보다 더 심각하거나 더 사람 개입이 급하다고 판단해 먼저 확인한다. */
export function detectNotifiableSignal(snapshot: Pick<AutoDevLiveSnapshot, "safety" | "quality" | "taskStatus" | "tests">): NotifiableSignal | undefined {
  if (snapshot.safety.securityBlocked) return "SECURITY_BLOCKED";
  if (snapshot.quality.reviewCycleExhausted) return "REVIEW_CYCLE_EXHAUSTED";
  if (snapshot.taskStatus === "WAITING_HUMAN") return "WAITING_HUMAN";
  if (snapshot.tests.status === "FAIL") return "TEST_FAILED";
  if (snapshot.taskStatus === "COMPLETED") return "TASK_COMPLETED";
  return undefined;
}
