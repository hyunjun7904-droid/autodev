import { loadState, saveState, DEFAULT_STATE_PATH } from "./state";
import { runClaudeTask as fakeRunClaudeTask } from "./fake-claude-runner";
import { runDeveloperTaskWithRetry } from "./claude-developer";
import { reviewClaudeResult as fakeReviewClaudeResult } from "./fake-gpt-reviewer";
import { reviewClaudeResult as realReviewClaudeResult, buildGptReviewLedgerEntryInput } from "./gpt-reviewer";
import type { ReviewProjectContext } from "./gpt-reviewer";
import type { ReviewBaseline } from "./review-baseline";
import type { SafeExecutorContext } from "./safe-executor";
import { requiresHumanApproval, classifyTaskRisk, MAX_REVIEW_CYCLES } from "./policy";
import { applyReviewDecisionPolicy, hasFailedRequiredTest, REVIEW_CYCLE_EXHAUSTED_REASON } from "./review-policy";
import { computeFailureFingerprint, classifyFailureCategory, createStagnationTracker } from "./failure-stagnation";
import { buildTestSummary, isAuditCriticalEvent } from "./observability-event";
import type { AutoDevEventInput } from "./observability-event";
import type { EventStore } from "./event-store";
import type { UsageLedger } from "./usage-ledger";
import { log } from "./logger";
import type { ProjectState, OrchestratorStatus, ClaudeResult, GptReviewResult, CoreState } from "./types";

export const MAX_GPT_CALLS = 10; // review "cycle" 단위 상한(REVISE 루프 횟수)
export const MAX_GPT_RAW_CALLS = 30; // gptTransportRetry 포함 실제 API 호출 총합의 hard cap(사용자 미지정 — 무한호출 방지용 보수적 기본값)
export const MAX_CLAUDE_LIMIT_WAITS = 12;
export const CLAUDE_LIMIT_WAIT_MS = 30 * 60 * 1000; // 30분

export interface GptReviewerReturn extends GptReviewResult {
  errorCode?: string;
  gptTransportRetry?: number;
  /** task.allowedPathPrefixes 밖에서 발견된 변경 파일 — 비어있지 않으면 GPT decision과
   *  무관하게 orchestrator가 BLOCK으로 강제한다(§ 요구사항 3/7, LLM 판단에만 맡기지 않음). */
  scopeViolations?: string[];
  /** Phase G Task G3.1 — 실제 OpenAI Responses API 응답이 제공한 경우만(§ gpt-reviewer.ts). */
  model?: { provider: string; name: string };
  /** Phase SI-3.8B — cachedInputTokens는 response.usage.input_tokens_details.cached_tokens를
   *  그대로 옮긴 값이다(§ gpt-reviewer.ts GptReviewApiResult.tokenUsage). */
  tokenUsage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** Phase SI-3.8B — false면 실제 네트워크 요청이 전혀 나가지 않았다는 뜻이다(§
   *  gpt-reviewer.ts GptReviewApiResult.requestAttempted, buildGptReviewLedgerEntryInput의
   *  requestCount 계산에 쓰인다). */
  requestAttempted?: boolean;
  /** Phase SI-3.8D — 이번 round의 payload가 FULL/INCREMENTAL/SAFE_FULL_FALLBACK 중 어느
   *  방식으로 만들어졌는지(§ gpt-reviewer.ts GptReviewApiResult.reviewMode). */
  reviewMode?: "FULL" | "INCREMENTAL" | "SAFE_FULL_FALLBACK";
  /** Phase SI-3.8D — 이번 round가 끝난 뒤의 새 baseline. while 루프가 다음 round의
   *  gptReviewer() 호출에 그대로 넘긴다(§ gpt-reviewer.ts GptReviewApiResult.reviewBaseline). */
  reviewBaseline?: ReviewBaseline;
  /** Phase SI-3.8D — 실제로 OpenAI에 전달된 payload 글자수(§ gpt-reviewer.ts
   *  GptReviewApiResult.payloadChars) — Ledger에 그대로 반영된다. */
  payloadChars?: number;
}

export interface OrchestratorDeps {
  claudeRunner?: (task: string, attempt: number) => Promise<ClaudeResult>;
  gptReviewer?: (
    result: ClaudeResult,
    reviewCycle: number,
    task: string,
    allowedPathPrefixes?: string[],
    projectContext?: ReviewProjectContext,
    /** SI-3.8A — 이 loop의 gptCallCount/gptRawCallTotal(아래 while 루프의 로컬 카운터)을
     *  Budget Guard 관측값으로 그대로 전달한다(§ gpt-budget-guard.ts). */
    gptCallCount?: number,
    gptRawCallTotal?: number,
    /** SI-3.8D — 직전 round가 반환한 GptReviewerReturn.reviewBaseline(아래 while 루프의
     *  로컬 변수)을 그대로 전달한다. */
    baseline?: ReviewBaseline
  ) => Promise<GptReviewerReturn>;
  /** USAGE_LIMIT 재시도 대기 시간(ms) — 테스트에서만 짧게 override, 실제 운용은 항상 30분. */
  claudeLimitWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** 상태 전이마다 호출 — autodev.ts가 콘솔에 task/status/reviewCycle을 표시하는 데 사용. */
  onProgress?: (info: { task: string; status: OrchestratorStatus; reviewCycle: number }) => void;
  /** project-state.json 경로 — 지정하지 않으면 실제 운영 경로(state.ts DEFAULT_STATE_PATH)를
   *  쓴다. 테스트는 반드시 임시 경로를 넘겨 실제 project-state.json을 건드리지 않는다
   *  (§ 요구사항 4 project-state 테스트 격리). */
  statePath?: string;
  /** task-registry.ts TaskDefinition.allowedPathPrefixes — GPT reviewer의 review 범위/
   *  scope-violation 판정에 쓰인다. 지정하지 않으면 projectContext의 scopeDirs 전체가
   *  허용 범위인 것으로 취급한다. */
  allowedPathPrefixes?: string[];
  /** GPT reviewer에게 전달할 프로젝트 맥락(ProjectManifest로부터 조립됨) — 지정하지 않으면
   *  gpt-reviewer.ts의 범용 기본값을 쓴다. */
  projectContext?: ReviewProjectContext;
  /** Phase C Task C2 — 이 run 전용 SafeExecutorContext. deps.gptReviewer를 직접 지정하지
   *  않았을 때만 쓰인다 — 기본 real GPT reviewer(selectDefaultGptReviewer)가 이 context로
   *  rules 파일/실제 git 변경을 읽어, 다른 project run의 configureSafeExecutor() 호출에
   *  영향받지 않게 한다. autodev.ts가 runAutodevOnce() 안에서 만든 per-run context를 항상
   *  명시적으로 넘긴다. */
  executor?: SafeExecutorContext;
  /**
   * Phase G Task G2 — 지정하면 REVISE loop의 각 실제 cycle마다(DEVELOPER_RETRY_STARTED/
   * TEST_COMPLETED/REVIEW_STARTED/REVIEW_APPROVED·REVISE·BLOCKED/REVIEW_CYCLE_EXHAUSTED/
   * 고위험 사전 게이트의 HUMAN_APPROVAL_REQUIRED) event를 기록한다. 지정하지 않으면 이
   * 파일의 동작은 G2 이전과 완전히 동일하다(instrumentation이 전부 no-op). deps.runId가
   * 없으면 deps.events가 있어도 아무 event도 만들지 않는다(runId 없는 event는 correlation이
   * 불가능하므로 애초에 만들지 않는다).
   */
  events?: EventStore;
  runId?: string;
  taskId?: string;
  projectId?: string;
  /**
   * Phase SI-3.8B — 지정하면 실제 GPT reviewer 호출(정확히 1회, 위 gptReviewer 호출)마다
   * requestCount/token/추정비용을 Usage Ledger에 append한다(§ gpt-reviewer.ts
   * buildGptReviewLedgerEntryInput). 지정하지 않으면 이 파일의 동작은 이전과 완전히
   * 동일하다(instrumentation이 전부 no-op) — events/runId와 동일한 "지정 안 하면 no-op"
   * 원칙을 따른다.
   */
  ledger?: UsageLedger;
}

export interface OrchestratorRunResult {
  // AutoDev 범용화 Phase A Task A5 — orchestrator는 MOVAN 전용 project-state 필드를 전혀
  // 읽지도 쓰지도 않는다(실제 사용처 기준). 반환 타입을 CoreState로 좁혀 그 사실을 타입
  // 레벨에서도 드러낸다 — 런타임에는 여전히 loadState()가 반환한 전체 상태 객체(MOVAN 전용
  // 필드 포함)가 그대로 담겨 있다.
  finalState: CoreState;
  statusHistory: OrchestratorStatus[];
}

function isUsageLimitResult(result: ClaudeResult): boolean {
  const r = result as ClaudeResult & { errorCode?: string };
  return r.errorCode === "USAGE_LIMIT";
}

// AUTOMATION_DRY_RUN이 명시적으로 "false"일 때만 실제 runner/reviewer를 선택한다.
// 값이 없거나 그 외 무엇이든(오타 포함) 안전한 쪽(fake)으로 fallback한다.
// dry-run=false일 때 실제 자동개발에 쓰이는 runner는 Safe Executor 프로토콜 기반
// developer 모드다. Claude에게는 built-in 파일/명령 도구가 전혀 없고(항상 --tools ""),
// 모든 파일/명령 접근은 safe-executor.ts가 코드로 검증한다(§ claude-developer.ts).
function selectDefaultClaudeRunner(): (task: string, attempt: number) => Promise<ClaudeResult> {
  if (process.env.AUTOMATION_DRY_RUN !== "false") return fakeRunClaudeTask;
  // AutoDev 신뢰성 수정(2026-08-26) — autodev.ts와 동일하게 TIMEOUT/CLI_NOT_FOUND 같은 일시적
  // 실패를 즉시 WAITING_HUMAN으로 넘기지 않고 재시도한다(§ claude-developer.ts
  // runDeveloperTaskWithRetry). deps.claudeRunner를 명시적으로 지정하지 않은 호출부(테스트는
  // 항상 명시적으로 지정하거나 AUTOMATION_DRY_RUN을 "false"로 두지 않으므로 영향 없음)를 위한
  // fallback이다.
  return (task: string, attempt: number) => runDeveloperTaskWithRetry(task, attempt);
}
function selectDefaultGptReviewer(executor?: SafeExecutorContext): (
  result: ClaudeResult,
  reviewCycle: number,
  task: string,
  allowedPathPrefixes?: string[],
  projectContext?: ReviewProjectContext,
  gptCallCount?: number,
  gptRawCallTotal?: number,
  baseline?: ReviewBaseline
) => Promise<GptReviewerReturn> {
  if (process.env.AUTOMATION_DRY_RUN !== "false") return fakeReviewClaudeResult;
  return (result, reviewCycle, task, allowedPathPrefixes, projectContext, gptCallCount, gptRawCallTotal, baseline) =>
    realReviewClaudeResult(result, reviewCycle, task, { allowedPathPrefixes, projectContext, executor, gptCallCount, gptRawCallTotal, baseline });
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// 상태 머신: IDLE → CLAUDE_WORKING → WAITING_GPT_REVIEW → (REVISION_REQUIRED → CLAUDE_WORKING
// → WAITING_GPT_REVIEW 반복) → APPROVED | WAITING_HUMAN | BLOCKED
//
// 고위험 작업은 Claude worker를 호출하기 전에 즉시 WAITING_HUMAN으로 중지한다(§ policy.ts).
// REVISE가 MAX_REVIEW_CYCLES(5)회 연속되거나 GPT 호출이 MAX_GPT_CALLS(10)회를 넘으면
// WAITING_HUMAN. Claude가 USAGE_LIMIT을 보고하면 WAITING_CLAUDE_LIMIT으로 전환해 대기 후
// 재시도하며(최대 MAX_CLAUDE_LIMIT_WAITS회), 매 대기 전 state를 디스크에 저장해 프로세스
// 재시작에도 진행 상태를 잃지 않는다. GPT가 critical/high를 보고했는데도 decision=PASS를
// 반환하면, 오케스트레이터가 안전장치로 REVISE로 강제 전환한다(LLM 판단만 신뢰하지 않음).
export async function runOrchestrator(
  task: string,
  deps: OrchestratorDeps = {}
): Promise<OrchestratorRunResult> {
  const claudeRunner = deps.claudeRunner ?? selectDefaultClaudeRunner();
  const gptReviewer = deps.gptReviewer ?? selectDefaultGptReviewer(deps.executor);
  const claudeLimitWaitMs = deps.claudeLimitWaitMs ?? CLAUDE_LIMIT_WAIT_MS;
  const sleep = deps.sleep ?? defaultSleep;
  // 실제 운영 경로가 기본값이다 — 테스트는 반드시 deps.statePath로 임시 경로를 넘겨야
  // 실제 project-state.json을 건드리지 않는다(§ 요구사항 4).
  const statePath = deps.statePath ?? DEFAULT_STATE_PATH;
  const saveCurrentState = (s: ProjectState) => saveState(s, statePath);

  const state = loadState(statePath);

  // Phase G Task G2 — deps.events/deps.runId가 없으면 완전한 no-op이다(이 함수의 기존
  // 동작을 전혀 바꾸지 않는다). audit-critical event(HUMAN_APPROVAL_REQUIRED/
  // REVIEW_CYCLE_EXHAUSTED/REVIEW_BLOCKED)의 기록이 실패하면 state.deferredHumanTasks에
  // 남긴다 — 이미 이 함수가 매 전이마다 saveCurrentState(state)로 저장하므로 별도의 저장
  // 경로를 새로 만들 필요가 없다. telemetry event(REVIEW_STARTED 등)는 실패해도 log()
  // 경고만 남기고 state를 건드리지 않는다(§ 요구사항 6 — audit-critical과 telemetry의
  // 실패 처리 정책을 이 함수 하나에서 구분한다).
  const emitEvent = (input: Omit<AutoDevEventInput, "runId" | "taskId" | "projectId">): void => {
    if (!deps.events || !deps.runId) return;
    const result = deps.events.append({ ...input, runId: deps.runId, taskId: deps.taskId, projectId: deps.projectId });
    if (result.ok) return;
    if (isAuditCriticalEvent(input.eventType)) {
      log(`AUDIT_CRITICAL_EVENT_LOST: ${input.eventType} 기록 실패 — 이 실행의 감사 기록이 불완전합니다.`, { error: result.error });
      state.deferredHumanTasks.push(`AUDIT_EVENT_LOST(${input.eventType}): ${result.error ?? "unknown"}`);
    } else {
      log("observability event 기록 실패(telemetry)", { eventType: input.eventType, error: result.error });
    }
  };
  // Phase SI-3.8B — deps.ledger가 없으면 완전한 no-op이다(events/runId와 동일한 원칙). append
  // 실패는 Ledger 자체가 이미 ok:false로 정직하게 반환하므로(§ usage-ledger.ts) 여기서는
  // 경고만 남기고 state/실행 흐름에는 영향을 주지 않는다 — 비용 telemetry 기록 실패가 실제
  // 자동개발 진행을 막아서는 안 된다(event의 audit-critical 정책과 의도적으로 다르다).
  const recordGptReviewUsage = (result: GptReviewerReturn, reviewCycle: number): void => {
    if (!deps.ledger) return;
    const entry = buildGptReviewLedgerEntryInput(result, {
      projectId: deps.projectId,
      taskId: deps.taskId,
      operationCycle: reviewCycle,
    });
    const appendResult = deps.ledger.append(entry);
    if (!appendResult.ok) {
      log("Usage Ledger 기록 실패(gpt-reviewer) — 비용 telemetry만 유실됨, 실행에는 영향 없음", { error: appendResult.error });
    }
  };

  const statusHistory: OrchestratorStatus[] = [];
  const setStatus = (s: OrchestratorStatus) => {
    state.status = s;
    statusHistory.push(s);
    deps.onProgress?.({ task, status: s, reviewCycle: state.reviewCycle });
  };

  setStatus("IDLE");
  state.currentTask = task;
  state.reviewCycle = 0;
  state.claudeLimitWaitCount = 0;
  state.lastClaudeResult = null;
  state.lastGptDecision = null;
  state.deferredHumanTasks = [];

  const risk = classifyTaskRisk(task);
  if (risk && requiresHumanApproval(risk)) {
    log("위험 작업 감지 — Claude worker 호출 전 즉시 중지", { action: risk });
    setStatus("WAITING_HUMAN");
    emitEvent({ eventType: "HUMAN_APPROVAL_REQUIRED", executionPhase: "task_selection", outcome: "BLOCKED", humanInterventionRequired: true, reason: `고위험 작업 감지(${risk}) — Claude worker 호출 전 즉시 중지` });
    saveCurrentState(state);
    return { finalState: state, statusHistory };
  }

  let gptCallCount = 0;
  let gptRawCallTotal = 0;
  // Phase SI-3.8D — 이 run(while 루프) 안에서만 이어지는 loop-local 값이다(gptCallCount/
  // gptRawCallTotal과 동일한 이유로 project-state.json에 저장하지 않는다 — § review-baseline.ts
  // 상단 주석). 첫 round는 항상 undefined(FULL)로 시작한다.
  let reviewBaseline: ReviewBaseline | undefined;
  // Phase 6 — 같은 실패가 reviewCycle 내내 반복되는지 감지하는 loop-local tracker(위
  // gptCallCount와 동일하게 project-state.json에 영속화하지 않는다).
  const stagnationTracker = createStagnationTracker();

  while (true) {
    setStatus("CLAUDE_WORKING");
    state.reviewCycle += 1;
    // 최초 시도(reviewCycle===1)는 TASK_STARTED로 이미 경계가 표시된다(autodev.ts) — 이
    // event는 REVISE 이후의 실제 재시도에서만 쓴다.
    if (state.reviewCycle > 1) {
      emitEvent({ eventType: "DEVELOPER_RETRY_STARTED", executionPhase: "development", outcome: "PENDING", reviseCycle: state.reviewCycle });
    }
    saveCurrentState(state);

    const claudeResult = await claudeRunner(task, state.reviewCycle);
    state.lastClaudeResult = claudeResult;
    const claudeDeferred = (claudeResult as ClaudeResult & { deferredHumanTasks?: string[] }).deferredHumanTasks;
    if (claudeDeferred?.length) state.deferredHumanTasks.push(...claudeDeferred);

    if (isUsageLimitResult(claudeResult)) {
      if (state.claudeLimitWaitCount >= MAX_CLAUDE_LIMIT_WAITS) {
        log(`Claude 사용량 제한 대기 ${MAX_CLAUDE_LIMIT_WAITS}회 초과 — WAITING_HUMAN`);
        setStatus("WAITING_HUMAN");
        break;
      }
      state.claudeLimitWaitCount += 1;
      state.reviewCycle -= 1; // 사용량 제한은 실제 시도로 소비하지 않는다.
      setStatus("WAITING_CLAUDE_LIMIT");
      saveCurrentState(state);
      log(`Claude 사용량 제한 감지 — ${claudeLimitWaitMs}ms 대기 후 재시도 (${state.claudeLimitWaitCount}/${MAX_CLAUDE_LIMIT_WAITS})`);
      await sleep(claudeLimitWaitMs);
      continue;
    }

    // Claude 자체가 구조적으로 실패한 경우(subprocess/파싱/권한 게이트 등) — 리뷰할 코드
    // 변경이 없으므로 GPT 호출을 낭비하지 않고 바로 사람에게 넘긴다.
    if (!claudeResult.success) {
      const errorCode = (claudeResult as ClaudeResult & { errorCode?: string }).errorCode;
      log("Claude 결과가 실패(success=false) — GPT 리뷰 생략, WAITING_HUMAN", { errorCode });
      setStatus("WAITING_HUMAN");
      break;
    }

    if (claudeResult.tests.length > 0) {
      // Phase G Task G3.1 — 이 developer 호출(claudeRunner) 1회당 실제로 관측된 model/
      // tokenUsage를 이 cycle의 유일한 terminal event(TEST_COMPLETED)에만 붙인다 — 같은
      // reviewCycle 안에서 DEVELOPER_RETRY_STARTED(호출 전) 등 다른 event에는 중복 기록하지
      // 않는다(§ 요구사항 6 double-counting 방지).
      // AutoDev 신뢰성 보완(2026-08-27, "호출 효율 지표") — claude-developer.ts가 이미 계산한
      // DeveloperCallStats를 이 cycle의 유일한 terminal event에 그대로 실어보낸다(원시 타입만
      // 허용하는 기존 metadata 필드 재사용 — 새 event type을 만들지 않는다).
      const callStats = (claudeResult as ClaudeResult & { callStats?: { totalRounds: number; validResponseRounds: number; localRecoverySuccessRounds: number; protocolFailureRounds: number } }).callStats;
      emitEvent({
        eventType: "TEST_COMPLETED",
        executionPhase: "test",
        outcome: claudeResult.tests.every((t) => t.pass) ? "SUCCESS" : "FAILED",
        reviseCycle: state.reviewCycle,
        testSummary: buildTestSummary(claudeResult.tests),
        model: claudeResult.model,
        tokenUsage: claudeResult.tokenUsage,
        ...(callStats
          ? {
              metadata: {
                devTotalRounds: callStats.totalRounds,
                devValidResponseRounds: callStats.validResponseRounds,
                devLocalRecoveryRounds: callStats.localRecoverySuccessRounds,
                devProtocolFailureRounds: callStats.protocolFailureRounds,
              },
            }
          : {}),
      });
    }

    setStatus("WAITING_GPT_REVIEW");
    gptCallCount += 1;
    if (gptCallCount > MAX_GPT_CALLS) {
      log(`GPT 호출 ${MAX_GPT_CALLS}회 초과 — WAITING_HUMAN`);
      setStatus("WAITING_HUMAN");
      break;
    }

    emitEvent({ eventType: "REVIEW_STARTED", executionPhase: "review", outcome: "PENDING", reviseCycle: state.reviewCycle });
    // SI-3.8A — 이 시점의 gptCallCount(방금 +1된, "이번이 몇 번째 호출인지")와 gptRawCallTotal
    // (이번 호출 이전까지 누적된 raw 호출 수)을 Budget Guard 관측값으로 그대로 전달한다.
    // SI-3.8D — reviewBaseline(직전 round의 결과, 첫 round는 undefined)도 그대로 전달한다.
    const gptResult = await gptReviewer(
      claudeResult,
      state.reviewCycle,
      task,
      deps.allowedPathPrefixes,
      deps.projectContext,
      gptCallCount,
      gptRawCallTotal,
      reviewBaseline
    );
    // 이번 round가 만든 새 baseline을 다음 round를 위해 보존한다(BLOCK/HUMAN_REQUIRED로
    // 루프가 끝나도 무해하다 — 더 이상 쓰이지 않을 뿐).
    reviewBaseline = gptResult.reviewBaseline ?? reviewBaseline;

    // reviewCycle(코드 수정 횟수)과 별개로 실제 API 통신 재시도까지 포함한 원시 호출
    // 총합에도 hard cap을 둔다 — 무한호출 방지(REVIEW 재시도가 반복돼도 실제 비용은 유한).
    gptRawCallTotal += 1 + (gptResult.gptTransportRetry ?? 0);

    // Phase SI-3.8B — 이 reviewCycle의 gptReviewer() 호출 1건(Budget Guard BLOCK/실제 API
    // 성공/실패 전부 포함, 결과 branch 분기보다 먼저)을 정확히 한 번만 Ledger에 기록한다 —
    // 아래 어떤 branch(BUDGET_EXCEEDED/AUTH_ERROR/PASS/BLOCK/REVISE)로 진행하든 중복 기록되지
    // 않는다.
    recordGptReviewUsage(gptResult, state.reviewCycle);

    if (gptRawCallTotal > MAX_GPT_RAW_CALLS) {
      log(`GPT 원시 API 호출 총합 ${MAX_GPT_RAW_CALLS}회 초과 — WAITING_HUMAN`, { gptRawCallTotal });
      state.deferredHumanTasks.push(`GPT_RAW_CALL_LIMIT_EXCEEDED: 총 ${gptRawCallTotal}회`);
      setStatus("WAITING_HUMAN");
      break;
    }

    if (
      gptResult.errorCode === "AUTH_ERROR" ||
      gptResult.errorCode === "QUOTA_EXCEEDED" ||
      gptResult.errorCode === "GPT_REVIEW_TEMPORARILY_UNAVAILABLE" ||
      gptResult.errorCode === "BUDGET_EXCEEDED" ||
      // SI-3.8E Security Ordering Correction — Provider Security Gate BLOCK도 Budget Guard
      // BLOCK과 동일한 성격(사람 개입이 필요한 preflight 차단)이므로 동일하게 기록한다.
      gptResult.errorCode === "PROVIDER_SECURITY_BLOCKED"
    ) {
      state.deferredHumanTasks.push(`${gptResult.errorCode}: ${gptResult.feedback}`);
    }

    // GPT decision에 대한 안전장치 override(scope 밖 변경→BLOCK, critical/high 있는데
    // PASS→REVISE, 필수 테스트 실패에도 PASS→REVISE)는 review-policy.ts의 단일 출처를
    // 그대로 쓴다(Phase F Task F4) — agent-orchestrator.ts(F2/F3)의 REVISE loop도 동일한
    // 함수를 쓰므로 두 실행경로의 판정이 서로 달라질 위험이 없다.
    const requiredTestsFailed = hasFailedRequiredTest(claudeResult.tests);

    // Phase 6 — 같은 required test 실패가 반복되는지 deterministic fingerprint로 감지한다.
    // 5회 REVISE 제한 자체는 바꾸지 않는다 — 반복이 처음 확인되는 시점(2회 연속)에 그
    // 사실과 보수적으로 분류된 category를 deferredHumanTasks에 남겨, 사람이 나중에
    // WAITING_HUMAN을 받았을 때 "무엇이 반복됐는지" 바로 알 수 있게 한다.
    if (requiredTestsFailed) {
      const claudeErrorCode = (claudeResult as ClaudeResult & { errorCode?: string }).errorCode;
      const fingerprint = computeFailureFingerprint(deps.taskId ?? task, claudeResult.tests);
      const repeatCount = stagnationTracker.observe(fingerprint);
      if (repeatCount === 2) {
        const category = classifyFailureCategory(claudeErrorCode, gptResult.errorCode, claudeResult.tests);
        log("STAGNATION_DETECTED — 동일한 required test 실패가 반복됨", { category, reviewCycle: state.reviewCycle });
        state.deferredHumanTasks.push(
          `STAGNATION_DETECTED(${category}): reviewCycle=${state.reviewCycle}에서 동일한 required test 실패가 2회 연속 반복됨`
        );
      }
    }

    const decision = applyReviewDecisionPolicy(gptResult, requiredTestsFailed);
    if (decision !== gptResult.decision) {
      log("Core 안전장치가 GPT decision을 override함", {
        raw: gptResult.decision,
        overridden: decision,
        severity: gptResult.severity,
        scopeViolations: gptResult.scopeViolations,
        requiredTestsFailed,
      });
    }

    state.lastGptDecision = { ...gptResult, decision };

    // Phase G Task G3.1 — 이 gptReviewer() 호출(reviewCycle 1회) 1건당 실제로 관측된
    // model/tokenUsage를 이 cycle의 결정 event(APPROVED/BLOCKED/REVISE 중 정확히 하나)에만
    // 붙인다 — REVIEW_STARTED는 호출 이전에 이미 기록되어 있어 여기 값을 붙일 수 없고
    // 붙이지도 않는다(§ 요구사항 6/7, 같은 호출의 usage가 여러 event에 중복 기록되지 않음).
    if (decision === "PASS") {
      setStatus("APPROVED");
      emitEvent({
        eventType: "REVIEW_APPROVED",
        executionPhase: "review",
        outcome: "SUCCESS",
        reviewDecision: decision,
        reviewSeverity: gptResult.severity,
        reviseCycle: state.reviewCycle,
        reason: gptResult.feedback,
        model: gptResult.model,
        tokenUsage: gptResult.tokenUsage,
      });
      break;
    }
    if (decision === "BLOCK" || decision === "HUMAN_REQUIRED") {
      // SI-3.8A — Budget Guard가 OpenAI API 호출 자체를 막은 경우도 별도 enum 값을 새로
      // 만들지 않고 기존 WAITING_HUMAN을 그대로 쓴다(§ types.ts OrchestratorStatus 주석 —
      // run.ts/autodev.ts/dashboard-html.ts/live-snapshot.ts가 전부 "WAITING_HUMAN" 문자열을
      // exact-match로 이미 소비하고 있어, 새 상태값은 그 소비처들을 전부 고쳐야 하는
      // Core-wide 변경이 된다). 구체적 사유는 errorCode==="BUDGET_EXCEEDED"와
      // deferredHumanTasks의 "BUDGET_EXCEEDED: ..." 항목(위 push)으로 이미 구분 가능하다.
      setStatus("WAITING_HUMAN");
      emitEvent({
        eventType: "REVIEW_BLOCKED",
        executionPhase: "review",
        outcome: "BLOCKED",
        humanInterventionRequired: true,
        reviewDecision: decision,
        reviewSeverity: gptResult.severity,
        reviseCycle: state.reviewCycle,
        reason: gptResult.feedback,
        model: gptResult.model,
        tokenUsage: gptResult.tokenUsage,
      });
      break;
    }

    // REVISE
    emitEvent({
      eventType: "REVIEW_REVISE",
      executionPhase: "review",
      outcome: "PENDING",
      reviewDecision: decision,
      reviewSeverity: gptResult.severity,
      reviseCycle: state.reviewCycle,
      reason: gptResult.feedback,
      model: gptResult.model,
      tokenUsage: gptResult.tokenUsage,
    });
    if (state.reviewCycle >= MAX_REVIEW_CYCLES) {
      log(`연속 REVISE ${MAX_REVIEW_CYCLES}회 도달 — WAITING_HUMAN`);
      // Phase F Task F4 — 이 상태는 "사람이 승인하면 통과"가 아니다: critical/high나
      // 미해결 REVISE 지적사항이 그대로 남아있을 수 있다. agent-orchestrator.ts(F2/F3)의
      // BLOCKED+REVIEW_CYCLE_EXHAUSTED와 같은 의미를 이 파일의 기존 WAITING_HUMAN enum
      // 위에서 deferredHumanTasks reason으로 명확히 남긴다(enum 자체는 바꾸지 않는다).
      state.deferredHumanTasks.push(
        `${REVIEW_CYCLE_EXHAUSTED_REASON}: REVISE가 MAX_REVIEW_CYCLES(${MAX_REVIEW_CYCLES})회 도달로 자동 진행을 중단합니다(단순 승인으로 완료 처리 불가).`
      );
      setStatus("WAITING_HUMAN");
      emitEvent({
        eventType: "REVIEW_CYCLE_EXHAUSTED",
        executionPhase: "review",
        outcome: "BLOCKED",
        humanInterventionRequired: true,
        reviseCycle: state.reviewCycle,
        reason: `${REVIEW_CYCLE_EXHAUSTED_REASON}: MAX_REVIEW_CYCLES(${MAX_REVIEW_CYCLES}) 도달`,
      });
      break;
    }
    setStatus("REVISION_REQUIRED");
  }

  saveCurrentState(state);
  return { finalState: state, statusHistory };
}
