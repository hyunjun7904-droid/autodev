import { loadState, saveState, DEFAULT_STATE_PATH } from "./state";
import { runClaudeTask as fakeRunClaudeTask } from "./fake-claude-runner";
import { runDeveloperTaskWithRetry, DEVELOPER_TRANSIENT_RETRY_EXHAUSTED_PREFIX } from "./claude-developer";
import { reviewClaudeResult as fakeReviewClaudeResult } from "./fake-gpt-reviewer";
import { reviewClaudeResult as realReviewClaudeResult, buildGptReviewLedgerEntryInput } from "./gpt-reviewer";
import type { ReviewProjectContext } from "./gpt-reviewer";
import type { ReviewBaseline } from "./review-baseline";
import type { SafeExecutorContext } from "./safe-executor";
import { requiresHumanApproval, classifyTaskRisk, MAX_REVIEW_CYCLES } from "./policy";
import { applyReviewDecisionPolicy, hasFailedRequiredTest, REVIEW_CYCLE_EXHAUSTED_REASON } from "./review-policy";
import { computeFailureFingerprint, classifyFailureCategory, createStagnationTracker, STAGNATION_DETECTED_MARKER_PREFIX } from "./failure-stagnation";
import { buildTestSummary, isAuditCriticalEvent } from "./observability-event";
import type { AutoDevEventInput } from "./observability-event";
import type { EventStore } from "./event-store";
import type { UsageLedger } from "./usage-ledger";
import { log } from "./logger";
import type { ProjectState, OrchestratorStatus, ClaudeResult, GptReviewResult, CoreState } from "./types";
// § BLOCKER 2 재하드닝(독립 최종 감사, 2026-08-30) — human-gate-policy.ts는 이 파일의
// MAX_GPT_CALLS_EXCEEDED_MARKER_PREFIX/CLAUDE_STRUCTURAL_FAILURE_MARKER_PREFIX/
// DETERMINISTIC_REVIEW_CYCLE_EXHAUSTED_MARKER_PREFIX를 이미 import한다 — 이 값을 되받는
// 것은 순수 상수/함수 값이라(모듈 top-level에서 즉시 실행되지 않고 함수 본문 안에서만
// 호출됨) CommonJS의 순환 require에서도 안전하다. canonical 분류 단일 출처(§
// classifyWaitingHumanReason)를 이 파일에서 재구현하지 않기 위해서다.
import { isTechnicalAutoRecoverableWaitingHuman } from "./human-gate-policy";

export const MAX_GPT_CALLS = 10; // review "cycle" 단위 상한(REVISE 루프 횟수)
export const MAX_GPT_RAW_CALLS = 30; // gptTransportRetry 포함 실제 API 호출 총합의 hard cap(사용자 미지정 — 무한호출 방지용 보수적 기본값)
export const CLAUDE_LIMIT_WAIT_MS = 30 * 60 * 1000; // 30분

// P1-2 하드닝(2026-08-30, 독립 감사) — USAGE_LIMIT/provider transient/review stagnation
// durable wait-then-retry(WAITING_CLAUDE_LIMIT/WAITING_PROVIDER_RETRY)는 지금까지 재시도
// "횟수"에 상한이 없었다(간격만 bounded) — "천천히 무한 반복도 무인 연속개발의 정상 복구가
// 아니다"(§ 요구사항). 이 값은 기존 MAX_MID_FLIGHT_UNEXPECTED_EXIT_COUNT(§ autodev.ts)와
// 동일한 5를 재사용한다(새 숫자를 만들지 않는다) — 이 durable wait count가 이 값을 넘으면
// genuine Human Gate로 보내지 않고(§ P0-4) terminal 기술적 BLOCKED로 전환한다(§
// blockOnDurableWaitRetryExhausted).
export const MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT = 5;

// STAGNATION_DETECTED 마커 재분류(§ human-gate-policy.ts) 도입에 따른 안전장치 — MAX_GPT_CALLS/
// Claude 구조적 실패는 지금까지 deferredHumanTasks에 아무 마커도 남기지 않고 순수
// fail-closed 기본값(GENUINE_HUMAN_JUDGMENT)에만 의존해 genuine으로 남았다(§ production-
// agent-integration-tests.ts scenarioAdvisoryCannotOverrideCoreTestFailure 등이 이 설계를
// 명시적으로 검증한다 — "GPT 호출 횟수 상한은 의도적으로 TECHNICAL_AUTO_RECOVERABLE 목록에
// 넣지 않고 fail-closed GENUINE으로 남긴다"). 이 REVISE 루프는 같은 required test 실패가
// 반복되면 도중에(§ 아래 stagnationTracker) STAGNATION_DETECTED 마커를 이미 deferredHumanTasks에
// 남겨둔 채로 이 genuine 종료 지점에 도달할 수 있다 — "마커가 없으면 genuine"이라는 암묵적
// 판정과 "STAGNATION_DETECTED만 있으면 기술적 자동 복구 대상"이라는 새 규칙이 동시에 참이면,
// 실제로는 비용/구조적 실패로 멈춘 WAITING_HUMAN이 조용히 자동 복구될 위험이 생긴다. 그래서
// GPT_RAW_CALL_LIMIT_EXCEEDED/BUDGET_EXCEEDED 등 기존 genuine 마커와 동일한 패턴으로 이
// 두 지점도 명시적 마커를 남긴다 — "genuine으로 남는다"는 기존 설계 의도 자체는 바뀌지
// 않고, 그 판정 근거만 암묵적 부재(marker 없음)에서 명시적 마커로 바뀐다.
export const MAX_GPT_CALLS_EXCEEDED_MARKER_PREFIX = "MAX_GPT_CALLS_EXCEEDED:";
export const CLAUDE_STRUCTURAL_FAILURE_MARKER_PREFIX = "CLAUDE_STRUCTURAL_FAILURE(";

// P0-4 하드닝(2026-08-30, 독립 감사 — "Technical blocker와 Genuine Human Gate 완전 분리")
// — 이 marker prefix는 2026-08-30 이전 정책에서 REVIEW_CYCLE_EXHAUSTED 분기가 "동일한
// required-test 실패 fingerprint가 결정론적으로 반복"되는 경우 genuine WAITING_HUMAN으로
// 승격하는 데 썼다. 독립 감사에서 이것이 정책 위반으로 확인됐다 — "test failure/deterministic
// blocker"는 아무리 반복돼도 실제 사업적/보안적 판단이 필요한 게 아니라 순수 기술적
// 상황이다(deterministic-simulation.ts Run B가 실제로 이 오분류를 재현했다). 이제
// STAGNATION 반복 여부와 무관하게 REVIEW_CYCLE_EXHAUSTED는 항상 기술적 durable
// wait-then-retry(WAITING_PROVIDER_RETRY) 경로 하나로 합쳐지고, 그 durable wait
// count에는 MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT 상한이 적용된다(§ P1-2,
// blockOnDurableWaitRetryExhausted) — 상한을 넘으면 genuine이 아니라 terminal 기술적
// BLOCKED로 전환한다. 이 marker prefix 자체는 더 이상 어디에도 push되지 않는다(export만
// 하위 호환을 위해 유지 — 기존 human-gate-policy.ts 참조/테스트가 있다면 안전하게 무해하다).
export const DETERMINISTIC_REVIEW_CYCLE_EXHAUSTED_MARKER_PREFIX = "DETERMINISTIC_REVIEW_CYCLE_EXHAUSTED:";

// AutoDev / JARVIS 신뢰성 보완 — Claude Developer Timeout Durable Retry(2026-08-28 정책
// 수정). Developer가 일시적 오류(TIMEOUT/CLI_NOT_FOUND)로 attempt 내 재시도(claude-
// developer.ts DEVELOPER_TRANSIENT_MAX_ATTEMPTS)까지 소진해도, 그 사실 자체는 사람 판단이
// 필요한 사유가 아니다(Task 위험도와 실패 원인 위험도를 분리 — provider가 오래 응답하지
// 못한다는 사실 자체는 genuine human judgment가 아니다). 이전 버전은 WAITING_CLAUDE_LIMIT과
// 똑같이 "bounded 횟수 초과 시 genuine WAITING_HUMAN"으로 끝냈으나, 그 최종 escalation
// 자체가 정책과 맞지 않는다고 재검토됐다 — TIMEOUT/RATE_LIMIT/PROVIDER_UNAVAILABLE류의 순수
// 기술적 실패는 얼마나 반복되든 Human Gate로 승격하지 않는다. 대신 dashboard-supervisor.ts의
// bounded backoff와 동일한 설계(schedule 이후 고정 cooldown)로 "재시도 사이 간격"만
// bounded로 계속 늘리고(API 폭주 방지), 재시도 횟수 자체는 무한히 계속한다 — 사람이 APPROVE
// 버튼을 눌러야 다시 움직이는 구조를 쓰지 않는다(§ 요구사항). 이 상태는 대시보드(§
// dashboard-runtime-truth)로 계속 관측 가능하다 — "사람이 볼 수 없게 조용히 멈춘다"가
// 아니라 "관측 가능한 채로 자동으로 계속 재시도한다"는 뜻이다.
export const DEVELOPER_PROVIDER_WAIT_SCHEDULE_MS = [5 * 60 * 1000, 15 * 60 * 1000, 30 * 60 * 1000]; // 5분, 15분, 30분
export const DEVELOPER_PROVIDER_WAIT_COOLDOWN_MS = 60 * 60 * 1000; // schedule 이후 고정 60분

/** dashboard-supervisor.ts computeBackoffDelayMs와 동일한 설계(순수 함수, schedule 소진 후
 *  고정 cooldown) — waitCount는 절대 상한이 없다(그 사실 자체가 정책 요구사항: 기술적
 *  provider 실패는 아무리 반복돼도 Human Gate로 승격하지 않는다), 다만 재시도 "간격"은
 *  cooldownMs로 bounded된다(API 폭주/무한 tight-loop 방지). */
export function computeDeveloperProviderWaitDelayMs(waitCount: number, schedule: number[], cooldownMs: number): number {
  if (waitCount <= 0) return 0;
  if (waitCount <= schedule.length) return schedule[waitCount - 1];
  return cooldownMs;
}

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
  /** Developer provider durable wait 스케줄/cooldown — 테스트에서만 짧게 override, 실제
   *  운용은 항상 DEVELOPER_PROVIDER_WAIT_SCHEDULE_MS/DEVELOPER_PROVIDER_WAIT_COOLDOWN_MS. */
  developerProviderWaitScheduleMs?: number[];
  developerProviderWaitCooldownMs?: number;
  /** 현재 시각(ms) — 테스트에서만 override, 실제 운용은 항상 Date.now. durable
   *  developerProviderNextRetryAt 계산/재개(process restart resume) 판정에만 쓰인다. */
  now?: () => number;
  sleep?: (ms: number, abortSignal?: AbortSignal) => Promise<void>;
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
  /** AutoDev Core Maintenance — Canonical Stop Path(2026-08-31, JARVIS Task 5.3 실측 —
   *  "실행 중인 Developer/continuous run을 canonical하게 정상 중단할 수 없는 결함"). 지정하면
   *  durable-wait sleep(§ sleepOrAbort) 중 즉시 대기를 끝내고, Developer 호출 결과가
   *  errorCode="ABORTED"(§ claude-developer.ts)면 즉시 정상 종료한다. 두 경우 모두
   *  saveCurrentState를 추가로 호출하지 않고(§ 파일 하단 최종 saveCurrentState를 건너뛰는
   *  이른 return) 마지막으로 이미 저장된 state 그대로 둔다 — project-state.json을 임의로
   *  바꾸지 않는다. 지정하지 않으면 기존 동작과 완전히 동일(중단 불가). */
  abortSignal?: AbortSignal;
}

/** § OrchestratorDeps.abortSignal 주석. abortSignal이 없으면 그냥 sleep(ms)를 기다린다(기존
 *  동작과 완전히 동일). 있으면 abort event와 경합시켜 먼저 끝나는 쪽을 따른다 — sleep()
 *  자체는 여전히 실제 ms 그대로 호출된다(기존 deps.sleep 테스트 override의 호출 인자 계약을
 *  그대로 보존, § claude-developer.ts runDeveloperTaskWithRetry의 동일한 설계). */
async function sleepOrAbort(ms: number, sleep: (ms: number, abortSignal?: AbortSignal) => Promise<void>, abortSignal?: AbortSignal): Promise<boolean> {
  if (!abortSignal) {
    await sleep(ms);
    return false;
  }
  if (abortSignal.aborted) return true;
  let aborted = false;
  await Promise.race([
    // § defaultSleep 주석(Timer Handle Defect) — abortSignal을 함께 넘겨 실제 프로덕션
    // sleep 구현이 자신의 setTimeout을 스스로 clearTimeout할 수 있게 한다. 테스트가 주입하는
    // 기존 sleep override(예: `async () => {}`)는 두 번째 인자를 그냥 무시하므로 기존 호출
    // 계약과 동작에 영향이 없다.
    sleep(ms, abortSignal),
    new Promise<void>((resolve) => {
      abortSignal.addEventListener(
        "abort",
        () => {
          aborted = true;
          resolve();
        },
        { once: true }
      );
    }),
  ]);
  return aborted;
}

export interface OrchestratorRunResult {
  // AutoDev 범용화 Phase A Task A5 — orchestrator는 MOVAN 전용 project-state 필드를 전혀
  // 읽지도 쓰지도 않는다(실제 사용처 기준). 반환 타입을 CoreState로 좁혀 그 사실을 타입
  // 레벨에서도 드러낸다 — 런타임에는 여전히 loadState()가 반환한 전체 상태 객체(MOVAN 전용
  // 필드 포함)가 그대로 담겨 있다.
  finalState: CoreState;
  statusHistory: OrchestratorStatus[];
  /** § OrchestratorDeps.abortSignal 주석. true면 durable-wait 중 또는 Developer 호출
   *  결과(errorCode="ABORTED")로 정상 중단됐다는 뜻이다 — finalState는 중단 직전 마지막으로
   *  저장된 내용 그대로다(project-state.json에 새로 쓰인 값 없음). */
  stopped?: boolean;
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

// AutoDev Core Maintenance — Timer Handle Defect 재하드닝(2026-08-31, JARVIS Task 5.3
// 실측 — canonical stop이 durable-wait(최대 몇십 분) 도중 논리적으로는 즉시 abort됐는데도
// 실제 OS 프로세스가 원래 예정된 대기시간까지 계속 살아있던 결함). 기존 defaultSleep은
// setTimeout의 handle을 아무도 들고 있지 않아 sleepOrAbort()의 Promise.race에서 abort
// 쪽이 먼저 끝나도 이 setTimeout 자체는 clearTimeout되지 않고 그대로 살아남았다 — Node의
// 타이머는 기본적으로 ref되어 있으므로, 그 타이머가 스스로 만료될 때까지 프로세스가 정상
// 종료되지 못했다(실측: 30분 durable-wait 도중 abort했는데 원래 예정 시각에 정확히 맞춰
// 프로세스가 종료됨 — clearTimeout 누락의 직접 증거). abortSignal을 받으면 스스로
// clearTimeout까지 책임진다 — sleepOrAbort()의 기존 "abort 쪽 Promise가 별도로 aborted
// 플래그를 설정한다"는 구조는 그대로 두고(중복 리스너라도 안전, 둘 다 동일 이벤트에서
// 발동), 이 함수는 오직 "자신이 만든 실제 타이머를 자신이 정리한다"는 책임만 추가로 진다.
const defaultSleep = (ms: number, abortSignal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (!abortSignal) return;
    if (abortSignal.aborted) {
      clearTimeout(timer);
      resolve();
      return;
    }
    abortSignal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

// 상태 머신: IDLE → CLAUDE_WORKING → WAITING_GPT_REVIEW → (REVISION_REQUIRED → CLAUDE_WORKING
// → WAITING_GPT_REVIEW 반복) → APPROVED | WAITING_HUMAN | BLOCKED
//
// 고위험 작업은 Claude worker를 호출하기 전에 즉시 WAITING_HUMAN으로 중지한다(§ policy.ts).
// REVISE가 MAX_REVIEW_CYCLES(5)회 연속되거나 GPT 호출이 MAX_GPT_CALLS(10)회를 넘으면
// WAITING_HUMAN. Claude가 USAGE_LIMIT을 보고하면 WAITING_CLAUDE_LIMIT으로 전환해 대기 후
// 재시도한다 — 2026-08-28 정책 수정: RATE_LIMIT류 기술적 실패는 아무리 반복돼도 genuine
// WAITING_HUMAN으로 승격하지 않으므로 이 대기에는 더 이상 상한이 없다(claudeLimitWaitMs
// 간격으로 무한히 재시도) — 매 대기 전 state를 디스크에 저장해 프로세스 재시작에도 진행
// 상태를 잃지 않는다. GPT가 critical/high를 보고했는데도 decision=PASS를 반환하면,
// 오케스트레이터가 안전장치로 REVISE로 강제 전환한다(LLM 판단만 신뢰하지 않음).
export async function runOrchestrator(
  task: string,
  deps: OrchestratorDeps = {}
): Promise<OrchestratorRunResult> {
  const claudeRunner = deps.claudeRunner ?? selectDefaultClaudeRunner();
  const gptReviewer = deps.gptReviewer ?? selectDefaultGptReviewer(deps.executor);
  const claudeLimitWaitMs = deps.claudeLimitWaitMs ?? CLAUDE_LIMIT_WAIT_MS;
  const developerProviderWaitSchedule = deps.developerProviderWaitScheduleMs ?? DEVELOPER_PROVIDER_WAIT_SCHEDULE_MS;
  const developerProviderWaitCooldownMs = deps.developerProviderWaitCooldownMs ?? DEVELOPER_PROVIDER_WAIT_COOLDOWN_MS;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const abortSignal = deps.abortSignal;
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
  // AutoDev / JARVIS 신뢰성 보완(2026-08-28) — 이 프로세스가 방금 죽었다가 재시작되어 "같은
  // task를 이어서" runOrchestrator가 다시 호출된 경우(§ autodev.ts MID_FLIGHT_ORCHESTRATOR_
  // STATUSES), developerProviderWaitCount/developerProviderNextRetryAt은 그대로 보존한다 —
  // 재시작마다 durable wait 진행 상황이 0으로 리셋되면 매번 처음부터 다시 기다리게 되어
  // "durable"이라는 이름이 무의미해진다. 다른(새) task로 전환될 때만 리셋한다 — 이전 task의
  // durable wait 이력이 새 task로 새어나가지 않는다.
  const resumingSameTask = state.currentTask === task;
  state.currentTask = task;
  state.reviewCycle = 0;
  if (!resumingSameTask) {
    // P1-1 재하드닝(독립 감사) — claudeLimitWaitCount는 예전에 resumingSameTask 여부와
    // 무관하게 항상 0으로 초기화됐다(이 블록 밖에 있었음) — 같은 task를 재개해도 durable
    // USAGE_LIMIT wait 진행 상황이 매번 사라져 terminal cap(MAX_DURABLE_PROVIDER_WAIT_
    // RETRY_COUNT)에 절대 도달하지 못하는 무한 재시도가 됐다. developerProviderWaitCount 등
    // 나머지 durable counter와 동일하게 "다른(새) task로 전환될 때만" 리셋한다.
    state.claudeLimitWaitCount = 0;
    state.developerProviderWaitCount = 0;
    state.developerProviderNextRetryAt = null;
    state.reviewerProviderWaitCount = 0;
    state.reviewerProviderNextRetryAt = null;
    state.reviewStagnationWaitCount = 0;
    state.reviewStagnationNextRetryAt = null;
    // § BLOCKER 3 재하드닝(독립 최종 감사) — gptCallCount/gptRawCallTotal도 나머지 durable
    // counter와 동일한 원칙: 다른(새) task로 전환될 때만 리셋한다. 같은 task를 이어가는 동안은
    // (아래 let 초기화가 state에서 그대로 이어받는다) 프로세스 재시작에도 보존된다.
    state.gptCallCount = 0;
    state.gptRawCallTotal = 0;
  }
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

  // § BLOCKER 3 재하드닝(독립 최종 감사) — 더 이상 무조건 0으로 시작하지 않는다. 위
  // resumingSameTask 블록이 새 task로 전환될 때만 state.gptCallCount/gptRawCallTotal을 0으로
  // 리셋하므로, 같은 task를 이어가는 process restart에서는 여기서 그 durable 값을 그대로
  // 이어받는다(§ types.ts CoreState.gptCallCount/gptRawCallTotal 문서).
  let gptCallCount = state.gptCallCount ?? 0;
  let gptRawCallTotal = state.gptRawCallTotal ?? 0;
  // Phase SI-3.8D — reviewBaseline은 여전히 이 run(while 루프) 안에서만 이어지는 loop-local
  // 값이다(claudeResult 자체가 재시작에도 살아남지 않아 재시작하면 Developer 호출부터 다시
  // 해야 하므로, review round의 "직전 baseline"을 영속화해도 실익이 없다 — § 아래 gptResult
  // 관련 주석과 동일한 이유). 첫 round는 항상 undefined(FULL)로 시작한다.
  let reviewBaseline: ReviewBaseline | undefined;
  // Phase 6 — 같은 실패가 reviewCycle 내내 반복되는지 감지하는 loop-local tracker(reviewBaseline과
  // 동일하게 project-state.json에 영속화하지 않는다 — gptCallCount/gptRawCallTotal과 달리 이
  // tracker는 크래시 우회 budget이 아니라 관측용 fingerprint 캐시일 뿐이다).
  const stagnationTracker = createStagnationTracker();
  // AutoDev Core Maintenance(2026-08-30) — 가장 최근에 관측된 required-test 실패
  // repeatCount(아래 stagnationTracker.observe 결과를 매 cycle 갱신). MAX_REVIEW_CYCLES
  // 소진 시점(§ 아래)에 "이 소진이 순수 기술적 비수렴 때문인지, 아니면 동일 실패가
  // 결정론적으로 반복돼서인지"를 구분하는 데만 쓴다 — 새 tracker/fingerprint 도메인을
  // 만들지 않고 이미 있는 신호를 재사용한다.
  let lastRequiredTestRepeatCount = 0;

  // P1-2 하드닝(2026-08-30, 독립 감사) — durable wait-then-retry 카테고리(USAGE_LIMIT/
  // provider transient/review stagnation) 공통 판정. waitCount(이미 증가된, "이번이 몇
  // 번째 대기인지")가 MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT를 넘으면 true를 반환하고,
  // 그 전에 이 task를 genuine Human Gate가 아니라 terminal 기술적 BLOCKED로 전환한다(§
  // decideNextAction의 status==="BLOCKED" STOP 분기와 동일한 원칙 — humanInterventionRequired
  // 없음, run.ts가 정상 종료해 runner-supervisor.ts의 backoff 재시작이 이어받는다). false를
  // 반환하면(아직 상한 이내) 호출부는 기존 durable wait을 그대로 계속한다 — 이 함수는 그
  // 경우 state/이벤트를 전혀 건드리지 않는다.
  const blockOnDurableWaitRetryExhausted = (category: string, waitCount: number, detail: string): boolean => {
    if (waitCount <= MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT) return false;
    const reason = `DURABLE_WAIT_RETRY_EXHAUSTED(${category}): waitCount=${waitCount} > ${MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT} — ${detail}`;
    log(`durable wait 재시도 상한 초과 — 기술적 BLOCKED로 전환(Human Gate 아님, ${category})`, { waitCount, category });
    state.status = "BLOCKED";
    emitEvent({ eventType: "RUN_BLOCKED", executionPhase: "review", outcome: "BLOCKED", reason });
    saveCurrentState(state);
    return true;
  };

  while (true) {
    // AutoDev / JARVIS 신뢰성 보완(2026-08-28) — 이전 프로세스가 durable provider wait
    // 도중(§ 아래) 죽었다가 재시작된 경우, developerProviderNextRetryAt이 여전히 디스크에
    // 남아있다(위 reset 블록이 같은 task면 보존한다). 남은 시간만큼만 마저 대기하고(이미
    // 지났으면 즉시 재시도) 이 필드를 비운다 — "재시작마다 전체 간격을 처음부터 다시
    // 기다리는" 낭비를 없앤다(§ 요구사항 "nextRetryAt 도달 → 자동 재시도").
    if (state.developerProviderNextRetryAt) {
      const scheduledAtMs = Date.parse(state.developerProviderNextRetryAt);
      const remainingMs = Number.isFinite(scheduledAtMs) ? Math.max(0, scheduledAtMs - now()) : 0;
      state.developerProviderNextRetryAt = null;
      if (remainingMs > 0) {
        setStatus("WAITING_PROVIDER_RETRY");
        saveCurrentState(state);
        log(`재시작 후 durable provider wait 재개 — 남은 ${remainingMs}ms만 대기 후 재시도`);
        if (await sleepOrAbort(remainingMs, sleep, abortSignal)) {
          return { finalState: state, statusHistory, stopped: true };
        }
      }
    }

    // AutoDev Efficiency / Review Stagnation Hardening — developerProviderNextRetryAt과 동일한
    // 재시작-복원 원칙(§ 위 블록). REVIEW_CYCLE_EXHAUSTED durable wait 도중 죽었다가 재시작된
    // 경우 남은 시간만 마저 기다린다.
    if (state.reviewStagnationNextRetryAt) {
      const scheduledAtMs = Date.parse(state.reviewStagnationNextRetryAt);
      const remainingMs = Number.isFinite(scheduledAtMs) ? Math.max(0, scheduledAtMs - now()) : 0;
      state.reviewStagnationNextRetryAt = null;
      if (remainingMs > 0) {
        setStatus("WAITING_PROVIDER_RETRY");
        saveCurrentState(state);
        log(`재시작 후 review stagnation durable wait 재개 — 남은 ${remainingMs}ms만 대기 후 재시도`);
        if (await sleepOrAbort(remainingMs, sleep, abortSignal)) {
          return { finalState: state, statusHistory, stopped: true };
        }
      }
    }

    setStatus("CLAUDE_WORKING");
    state.reviewCycle += 1;
    // 최초 시도(reviewCycle===1)는 TASK_STARTED로 이미 경계가 표시된다(autodev.ts) — 이
    // event는 REVISE 이후의 실제 재시도에서만 쓴다.
    if (state.reviewCycle > 1) {
      emitEvent({ eventType: "DEVELOPER_RETRY_STARTED", executionPhase: "development", outcome: "PENDING", reviseCycle: state.reviewCycle });
    }
    saveCurrentState(state);

    const claudeResult = await claudeRunner(task, state.reviewCycle);
    // AutoDev Core Maintenance — Canonical Stop Path(2026-08-31). errorCode="ABORTED"(§
    // claude-developer.ts opts.abortSignal)는 절대 재시도 대상이 아니고, genuine WAITING_HUMAN
    // 으로도 승격하지 않는다 — state를 전혀 건드리지 않고(lastClaudeResult에도 담지 않는다)
    // 즉시 반환한다. 이 return은 아래 최종 saveCurrentState(§ 파일 끝)를 건너뛰므로
    // project-state.json은 이번 attempt 시작 직전(위 saveCurrentState(state)) 상태 그대로
    // 남는다.
    if ((claudeResult as ClaudeResult & { errorCode?: string }).errorCode === "ABORTED") {
      log("developer 중단(ABORTED) 감지 — durable wait/재시도/Reviewer 없이 즉시 정상 종료");
      return { finalState: state, statusHistory, stopped: true };
    }
    state.lastClaudeResult = claudeResult;
    const claudeDeferred = (claudeResult as ClaudeResult & { deferredHumanTasks?: string[] }).deferredHumanTasks;
    if (claudeDeferred?.length) state.deferredHumanTasks.push(...claudeDeferred);

    if (isUsageLimitResult(claudeResult)) {
      // 2026-08-28 정책 수정 — RATE_LIMIT/USAGE_LIMIT은 아무리 반복돼도 genuine WAITING_HUMAN
      // 으로 승격하지 않는다(Task 위험도와 실패 원인 위험도 분리, § DEVELOPER_PROVIDER_WAIT와
      // 동일 원칙). P1-2 하드닝(독립 감사) — 재시도 "횟수"에도 이제 상한이 있다(§
      // MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT, blockOnDurableWaitRetryExhausted) — 초과하면
      // genuine이 아니라 terminal 기술적 BLOCKED로 전환한다(무제한 "느린 반복" 금지).
      state.claudeLimitWaitCount += 1;
      state.reviewCycle -= 1; // 사용량 제한은 실제 시도로 소비하지 않는다.
      if (
        blockOnDurableWaitRetryExhausted(
          "USAGE_LIMIT",
          state.claudeLimitWaitCount,
          `Claude 사용량 제한 durable wait이 ${MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT}회를 초과했습니다`
        )
      ) {
        break;
      }
      setStatus("WAITING_CLAUDE_LIMIT");
      saveCurrentState(state);
      log(`Claude 사용량 제한 감지 — ${claudeLimitWaitMs}ms 대기 후 재시도 (${state.claudeLimitWaitCount}회째, Human Gate로 승격하지 않고 계속 재시도합니다)`);
      if (await sleepOrAbort(claudeLimitWaitMs, sleep, abortSignal)) {
        return { finalState: state, statusHistory, stopped: true };
      }
      continue;
    }

    // Claude 자체가 구조적으로 실패한 경우(subprocess/파싱/권한 게이트 등) — 리뷰할 코드
    // 변경이 없으므로 GPT 호출을 낭비하지 않는다. Developer가 일시적 오류(TIMEOUT/
    // CLI_NOT_FOUND)로 attempt 내 재시도까지 소진한 경우(§
    // DEVELOPER_TRANSIENT_RETRY_EXHAUSTED_PREFIX)와, errorCode==="PROTOCOL_ERROR"(§ P0-3
    // 재하드닝, 독립 감사 — 응답을 반복적으로 해석하지 못한 "protocol parse failure")는
    // durable wait-then-retry를 거친다 — Task 위험도와 실패 원인 위험도를 분리한다: provider가
    // 응답하지 못했다는 사실이나 응답 형식을 반복 해석하지 못했다는 사실 자체는 사람 판단이
    // 필요한 사유가 아니며(§ human-gate-policy.ts isProtocolErrorStructuralFailureMarker와
    // 동일한 정책), 아무리 반복돼도 즉시 Human Gate로 승격하지 않는다. 재시도 "횟수"는
    // MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT로 bounded되어(§ blockOnDurableWaitRetryExhausted)
    // 초과하면 terminal 기술적 BLOCKED로 끝난다. 그 외 구조적 실패(파싱/권한 게이트 등, 위 두
    // 마커가 없는 경우)는 기존과 동일하게 즉시 WAITING_HUMAN이다 — 이건 여전히 사람이 봐야 할
    // 진짜 문제일 수 있다(예: 잘못된 실행 권한 설정 등 — provider가 "응답을 아예 못 준" 것,
    // "응답 형식을 반복 해석 못한 것"과 다른 범주).
    if (!claudeResult.success) {
      const errorCode = (claudeResult as ClaudeResult & { errorCode?: string }).errorCode;
      const claudeResultDeferred = (claudeResult as ClaudeResult & { deferredHumanTasks?: string[] }).deferredHumanTasks ?? [];
      const isTransientRetryExhausted = claudeResultDeferred.some((m: string) => m.startsWith(DEVELOPER_TRANSIENT_RETRY_EXHAUSTED_PREFIX));
      const isProtocolError = errorCode === "PROTOCOL_ERROR";

      if (isTransientRetryExhausted || isProtocolError) {
        state.developerProviderWaitCount = (state.developerProviderWaitCount ?? 0) + 1;
        state.reviewCycle -= 1; // durable wait은 실제 시도로 소비하지 않는다(claudeLimitWaitCount와 동일 관례).
        // P1-2 하드닝(독립 감사) — 재시도 "횟수"에도 이제 상한이 있다(§ 위 claudeLimitWaitCount와
        // 동일한 원칙) — 초과하면 genuine이 아니라 terminal 기술적 BLOCKED로 전환한다.
        if (
          blockOnDurableWaitRetryExhausted(
            isProtocolError ? "DEVELOPER_PROTOCOL_ERROR" : "DEVELOPER_PROVIDER_TRANSIENT",
            state.developerProviderWaitCount,
            `Developer ${isProtocolError ? "응답 해석 반복 실패(PROTOCOL_ERROR)" : `provider(${errorCode})`} durable wait이 ${MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT}회를 초과했습니다`
          )
        ) {
          break;
        }
        const delayMs = computeDeveloperProviderWaitDelayMs(state.developerProviderWaitCount, developerProviderWaitSchedule, developerProviderWaitCooldownMs);
        state.developerProviderNextRetryAt = new Date(now() + delayMs).toISOString();
        setStatus("WAITING_PROVIDER_RETRY");
        saveCurrentState(state);
        log(
          `Developer ${isProtocolError ? "응답 해석 반복 실패(PROTOCOL_ERROR)" : `provider 일시적 오류(${errorCode})`} 감지 — ${delayMs}ms 대기 후 동일 task 재시도 (${state.developerProviderWaitCount}회째, 기술적 실패는 Human Gate로 승격하지 않고 계속 재시도합니다)`
        );
        if (await sleepOrAbort(delayMs, sleep, abortSignal)) {
          return { finalState: state, statusHistory, stopped: true };
        }
        state.developerProviderNextRetryAt = null;
        continue;
      }

      log("Claude 결과가 실패(success=false) — GPT 리뷰 생략, WAITING_HUMAN", { errorCode });
      state.deferredHumanTasks.push(
        `${CLAUDE_STRUCTURAL_FAILURE_MARKER_PREFIX}${errorCode ?? "UNKNOWN"}): Claude 결과가 구조적으로 실패(success=false)해 GPT 리뷰 없이 WAITING_HUMAN으로 전환됨`
      );
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

    // P0-5 하드닝(2026-08-30, 독립 감사 — "local GREEN 이전 Reviewer network call 금지") —
    // required test가 실패했으면 changedFiles 존재 여부와 무관하게 Reviewer를 절대 호출하지
    // 않는다. 이전 정책(2026-08-30 이전)은 "changedFiles가 비어있을 때만" 생략했는데, 독립
    // 감사에서 실제로 changedFiles가 존재하는데도 required test가 실패한 채로 Reviewer가
    // 호출되는 경로가 확인됐다(정책 위반 — Developer 결과 후 순서는 deterministic
    // validation → required tests → LOCAL GREEN이 되기 전에는 Reviewer network/API 호출을
    // 하지 않는다). 이전 정책의 우려("테스트 실패만으로 무조건 생략하면 새로 도입된
    // scope/security 문제를 Reviewer가 한 번도 못 볼 위험")는 여전히 유효한 diff가 있으면 그
    // diff는 required test가 통과하는 즉시(다음 성공한 attempt) Reviewer가 보게 되므로
    // structurally 해소된다 — required test가 계속 실패하는 동안은 STAGNATION_DETECTED(§
    // 위)/MAX_REVIEW_CYCLES/durable retry가 이미 무한 루프를 막는다.
    const requiredTestsFailed = hasFailedRequiredTest(claudeResult.tests);
    const skipReviewerLocalNotGreen = requiredTestsFailed;

    setStatus("WAITING_GPT_REVIEW");
    let gptResult: GptReviewerReturn;
    if (skipReviewerLocalNotGreen) {
      log("Reviewer 호출 생략 — required test 실패(local GREEN 아님) — changedFiles 존재 여부와 무관", {
        reviewCycle: state.reviewCycle,
        changedFilesCount: claudeResult.changedFiles.length,
      });
      gptResult = {
        // applyReviewDecisionPolicy(아래)가 requiredTestsFailed로 REVISE로 강제한다 — 실제
        // Reviewer가 "이 diff엔 문제 없음"이라고 판단한 것과 동일한 중립 출발점이다.
        decision: "PASS",
        severity: { critical: 0, high: 0, medium: 0 },
        feedback:
          "AutoDev — required test가 실패해 local GREEN이 아니므로 Reviewer를 호출하지 않았습니다(§ P0-5 정책 — local GREEN 이전 Reviewer network call 금지). required test가 여전히 실패해 REVISE로 처리합니다.",
        nextTask: null,
        requestAttempted: false,
      };
    } else {
      gptCallCount += 1;
      // § BLOCKER 3 재하드닝(독립 최종 감사) — REVISE round 예산(gptCallCount)도 실제
      // 네트워크 호출 여부와 무관하게 즉시 durable하게 반영한다(아래 gptRawCallTotal 예약과
      // 함께 저장됨).
      state.gptCallCount = gptCallCount;
      if (gptCallCount > MAX_GPT_CALLS) {
        // § BLOCKER 3 재하드닝(독립 최종 감사) — REVISE round 예산 소진은 사람의 "승인"으로
        // 해결되는 문제가 아니다(코드가 계속 REVISE를 유발한다는 뜻 — 근본 원인을 사람이
        // 직접 고쳐야 한다). blockOnDurableWaitRetryExhausted(§ 위)와 정확히 동일한 원칙으로
        // WAITING_HUMAN(Telegram Human Gate)이 아니라 terminal 기술적 BLOCKED로 전환한다 —
        // 이전에는 이 case가 WAITING_HUMAN이라 autodev.ts의 generic catch-all이
        // HUMAN_APPROVAL_REQUIRED(humanInterventionRequired:true)를 만들었다(§ 요구사항
        // "cap을 넘긴 뒤 ... terminal technical BLOCKED, Human Gate=0").
        log(`GPT 호출 ${MAX_GPT_CALLS}회 초과 — 기술적 BLOCKED로 전환(Human Gate 아님)`);
        state.deferredHumanTasks.push(`${MAX_GPT_CALLS_EXCEEDED_MARKER_PREFIX} 총 ${gptCallCount}회`);
        state.status = "BLOCKED";
        emitEvent({
          eventType: "RUN_BLOCKED",
          executionPhase: "review",
          outcome: "BLOCKED",
          reason: `${MAX_GPT_CALLS_EXCEEDED_MARKER_PREFIX} 총 ${gptCallCount}회`,
        });
        saveCurrentState(state);
        break;
      }

      emitEvent({ eventType: "REVIEW_STARTED", executionPhase: "review", outcome: "PENDING", reviseCycle: state.reviewCycle });
      // § BLOCKER 3 재하드닝(독립 최종 감사) — 실제 network call(gptReviewer) 직전에
      // crash-safe write-ahead reservation을 저장한다. 이 호출이 내부적으로 몇 번 재시도할지
      // (gptTransportRetry)는 호출이 끝나야 알 수 있으므로, 지금 확실히 아는 최소값(+1)만
      // 먼저 반영해 저장한다 — "호출이 성공적으로 돌아온 뒤에만 counter 저장"하면 네트워크
      // 호출 직후 process crash 시 그 호출량이 통째로 유실되어 hard budget이 재시작으로
      // 우회될 수 있다(§ types.ts CoreState.gptRawCallTotal 문서).
      state.gptRawCallTotal = gptRawCallTotal + 1;
      saveCurrentState(state);
      // SI-3.8A — 이 시점의 gptCallCount(방금 +1된, "이번이 몇 번째 호출인지")와 gptRawCallTotal
      // (이번 호출 이전까지 누적된 raw 호출 수)을 Budget Guard 관측값으로 그대로 전달한다.
      // SI-3.8D — reviewBaseline(직전 round의 결과, 첫 round는 undefined)도 그대로 전달한다.
      gptResult = await gptReviewer(
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
      // § BLOCKER 3 재하드닝 — 호출이 실제로 끝났으므로 위 reservation을 정확한 합계로
      // 교정해 저장한다(같은 task 안에서는 재시작에도 이 정확한 값이 이어진다).
      state.gptRawCallTotal = gptRawCallTotal;
      saveCurrentState(state);
      recordGptReviewUsage(gptResult, state.reviewCycle);

      // AutoDev / JARVIS 신뢰성 보완(2026-08-28 정책 수정) — GPT Reviewer 자신의 순수 provider
      // 일시적 장애(timeout/rate limit류, gpt-reviewer.ts reviewClaudeResultWithRetry가 자체
      // MAX_ATTEMPTS(5)까지 소진한 뒤에만 이 errorCode를 반환)는 Developer provider durable
      // wait과 정확히 같은 원칙을 적용한다 — 아무리 반복돼도 genuine WAITING_HUMAN으로 승격하지
      // 않는다. 대신 같은 diff로 재리뷰만 반복한다(Developer를 다시 호출하지 않음 — claudeResult
      // 는 이 while(true) 바깥 loop의 값 그대로다). gptCallCount("몇 번째 REVISE round인지")는
      // 이 재시도로 소비하지 않는다(claudeLimitWaitCount/developerProviderWaitCount와 동일
      // 관례) — 다만 gptRawCallTotal(실제 API 호출 총합, 비용 안전장치)은 재시도도 실제 호출이므로
      // 계속 늘어나고, 그 hard cap(MAX_GPT_RAW_CALLS)은 그대로 유지된다 — "얼마나 반복되든 Human
      // Gate 승격 없음"이 "실제 비용이 무한정 계속 나가도 된다"는 뜻은 아니다(그건 이미
      // GPT_RAW_CALL_LIMIT_EXCEEDED라는 별도의, 이 정책과 무관한 genuine 비용 사유다).
      // 참고: Developer provider wait(위)과 달리 이 retry는 재시작 후 "남은 시간만 대기"를
      // 구현하지 않는다 — claudeResult 자체가 프로세스 재시작에도 살아남을 방법이 없어(디스크에
      // 영속화하지 않음, 기존 설계 그대로), 재시작하면 어차피 Developer 호출부터 처음부터 다시
      // 해야 한다(이 특성은 이번 변경으로 새로 생긴 게 아니라 기존 review 단계 전체가 이미 그랬다
      // — claudeResult를 durable하게 만드는 것은 이번 정책 수정의 범위 밖이다). 따라서
      // reviewerProviderNextRetryAt은 관측(대시보드/로그)용으로만 저장되고, 재시작 시 남은
      // 시간만큼만 기다리는 로직은 없다.
      while (gptResult.errorCode === "GPT_REVIEW_TEMPORARILY_UNAVAILABLE" && gptRawCallTotal <= MAX_GPT_RAW_CALLS) {
        state.reviewerProviderWaitCount = (state.reviewerProviderWaitCount ?? 0) + 1;
        // P1-2 재하드닝(독립 감사) — 이전에는 이 카운터가 durable하게 증가만 할 뿐 어떤
        // terminal cap에도 연결되지 않아, MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT(5)를 훨씬
        // 넘어(실제 재현: 11회) 계속 재호출되다가 결국 MAX_GPT_RAW_CALLS 소진 후에야
        // GPT_RAW_CALL_LIMIT_EXCEEDED(genuine WAITING_HUMAN)로 끝났다 — "느리지만 무한한
        // 재시도"였다. developerProviderWaitCount/reviewStagnationWaitCount와 동일하게 이
        // 카운터도 상한을 넘으면 terminal 기술적 BLOCKED로 전환하고, 이 함수는 즉시
        // 반환한다(추가 Reviewer network call 없음 — blockOnDurableWaitRetryExhausted가
        // 참을 반환한 시점에는 아직 이번 라운드의 재호출을 시작하지 않았다).
        if (
          blockOnDurableWaitRetryExhausted(
            "REVIEWER_PROVIDER_TRANSIENT",
            state.reviewerProviderWaitCount,
            `GPT Reviewer provider durable wait이 ${MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT}회를 초과했습니다`
          )
        ) {
          return { finalState: state, statusHistory };
        }
        const delayMs = computeDeveloperProviderWaitDelayMs(state.reviewerProviderWaitCount, developerProviderWaitSchedule, developerProviderWaitCooldownMs);
        state.reviewerProviderNextRetryAt = new Date(now() + delayMs).toISOString();
        setStatus("WAITING_PROVIDER_RETRY");
        saveCurrentState(state);
        log(
          `GPT Reviewer provider 일시적 오류 감지 — ${delayMs}ms 대기 후 같은 diff로 재리뷰 (${state.reviewerProviderWaitCount}회째, gptCallCount 예산은 소비하지 않음, Human Gate로 승격하지 않고 계속 재시도합니다)`
        );
        if (await sleepOrAbort(delayMs, sleep, abortSignal)) {
          return { finalState: state, statusHistory, stopped: true };
        }
        state.reviewerProviderNextRetryAt = null;
        setStatus("WAITING_GPT_REVIEW");
        // § BLOCKER 3 재하드닝 — 이 재시도 호출도 실제 network call이므로 동일한 write-ahead
        // reservation을 적용한다(위 최초 호출과 동일한 원칙, 로직 복제 없이 같은 지역 변수를
        // 그대로 재사용).
        state.gptRawCallTotal = gptRawCallTotal + 1;
        saveCurrentState(state);
        gptResult = await gptReviewer(claudeResult, state.reviewCycle, task, deps.allowedPathPrefixes, deps.projectContext, gptCallCount, gptRawCallTotal, reviewBaseline);
        reviewBaseline = gptResult.reviewBaseline ?? reviewBaseline;
        gptRawCallTotal += 1 + (gptResult.gptTransportRetry ?? 0);
        state.gptRawCallTotal = gptRawCallTotal;
        saveCurrentState(state);
        recordGptReviewUsage(gptResult, state.reviewCycle);
      }

      if (gptRawCallTotal > MAX_GPT_RAW_CALLS) {
        // § BLOCKER 3 재하드닝(독립 최종 감사) — 이 hard budget(실제 네트워크 호출 총합)
        // 소진도 위 MAX_GPT_CALLS와 동일한 이유로 terminal 기술적 BLOCKED로 전환한다 —
        // "승인"으로 풀리는 문제가 아니라 실제 비용 상한에 도달했다는 뜻이며, 사람은 이
        // 상한 자체를 조정하거나 근본 원인을 조사해야 한다(Telegram Approve 버튼을 누른다고
        // 이 task가 재개되어서는 안 된다 — 재개되면 hard budget이 무의미해진다). 이제
        // gptRawCallTotal 자체가 durable하므로(§ types.ts CoreState.gptRawCallTotal),
        // process restart로 이 cap을 우회할 수도 없다 — cap 도달 후 재시작해도 추가 Reviewer
        // network call은 0이다(위 write-ahead reservation이 이미 저장된 카운트에서 시작).
        log(`GPT 원시 API 호출 총합 ${MAX_GPT_RAW_CALLS}회 초과 — 기술적 BLOCKED로 전환(Human Gate 아님)`, { gptRawCallTotal });
        state.deferredHumanTasks.push(`GPT_RAW_CALL_LIMIT_EXCEEDED: 총 ${gptRawCallTotal}회`);
        state.status = "BLOCKED";
        emitEvent({
          eventType: "RUN_BLOCKED",
          executionPhase: "review",
          outcome: "BLOCKED",
          reason: `GPT_RAW_CALL_LIMIT_EXCEEDED: 총 ${gptRawCallTotal}회`,
        });
        saveCurrentState(state);
        break;
      }

      if (
        gptResult.errorCode === "AUTH_ERROR" ||
        gptResult.errorCode === "QUOTA_EXCEEDED" ||
        gptResult.errorCode === "BUDGET_EXCEEDED" ||
        // SI-3.8E Security Ordering Correction — Provider Security Gate BLOCK도 Budget Guard
        // BLOCK과 동일한 성격(사람 개입이 필요한 preflight 차단)이므로 동일하게 기록한다.
        gptResult.errorCode === "PROVIDER_SECURITY_BLOCKED"
      ) {
        state.deferredHumanTasks.push(`${gptResult.errorCode}: ${gptResult.feedback}`);
      }
    }

    // GPT decision에 대한 안전장치 override(scope 밖 변경→BLOCK, critical/high 있는데
    // PASS→REVISE, 필수 테스트 실패에도 PASS→REVISE)는 review-policy.ts의 단일 출처를
    // 그대로 쓴다(Phase F Task F4) — agent-orchestrator.ts(F2/F3)의 REVISE loop도 동일한
    // 함수를 쓰므로 두 실행경로의 판정이 서로 달라질 위험이 없다.

    // Phase 6 — 같은 required test 실패가 반복되는지 deterministic fingerprint로 감지한다.
    // 5회 REVISE 제한 자체는 바꾸지 않는다 — 반복이 처음 확인되는 시점(2회 연속)에 그
    // 사실과 보수적으로 분류된 category를 deferredHumanTasks에 남겨, 사람이 나중에
    // WAITING_HUMAN을 받았을 때 "무엇이 반복됐는지" 바로 알 수 있게 한다.
    if (requiredTestsFailed) {
      const claudeErrorCode = (claudeResult as ClaudeResult & { errorCode?: string }).errorCode;
      const fingerprint = computeFailureFingerprint(deps.taskId ?? task, claudeResult.tests);
      const repeatCount = stagnationTracker.observe(fingerprint);
      lastRequiredTestRepeatCount = repeatCount;
      if (repeatCount === 2) {
        const category = classifyFailureCategory(claudeErrorCode, gptResult.errorCode, claudeResult.tests);
        log("STAGNATION_DETECTED — 동일한 required test 실패가 반복됨", { category, reviewCycle: state.reviewCycle });
        state.deferredHumanTasks.push(
          `${STAGNATION_DETECTED_MARKER_PREFIX}${category}): reviewCycle=${state.reviewCycle}에서 동일한 required test 실패가 2회 연속 반복됨`
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
      // § BLOCKER 2 재하드닝(독립 최종 감사) — 이전에는 여기서 humanInterventionRequired를
      // 무조건 true로 고정했다. 하지만 human-gate-policy.ts의 canonical classifier는 이
      // 정확히 같은 case(state.lastGptDecision.decision이 BLOCK/HUMAN_REQUIRED)를 이미
      // TECHNICAL_AUTO_RECOVERABLE로 판정한다(코드 품질/scope 문제 — Developer가 고쳐야 할
      // 기술적 사안, 사람 승인 없이 다음 실행에서 자동 복구됨, § autodev.ts의 WAITING_HUMAN
      // 자동 복구 블록). state.lastGptDecision은 바로 위에서 이미 이 decision으로
      // 갱신되었으므로, 여기서 classifier를 재사용하면 event의 humanInterventionRequired가
      // 실제 시스템 동작(자동 복구 여부)과 항상 일치한다 — "Reviewer BLOCK/HUMAN_REQUIRED가
      // 일괄 humanInterventionRequired=true가 될 수 있음" 오분류를 닫는다. 이 task에 이미
      // 다른 genuine 마커/humanFinalReview가 남아있는 드문 경우에는 classifier가 여전히
      // true를 반환해 진짜 genuine 상태를 되돌리지 않는다.
      emitEvent({
        eventType: "REVIEW_BLOCKED",
        executionPhase: "review",
        outcome: "BLOCKED",
        humanInterventionRequired: !isTechnicalAutoRecoverableWaitingHuman(state),
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
      // P0-4 하드닝(2026-08-30, 독립 감사) — 이전 정책은 lastRequiredTestRepeatCount(같은
      // required test 실패가 결정론적으로 반복됐는지)가 2 이상이면 genuine WAITING_HUMAN으로
      // 승격했다(§ 위 DETERMINISTIC_REVIEW_CYCLE_EXHAUSTED_MARKER_PREFIX 주석). 독립 감사
      // (deterministic-simulation.ts Run B로 실제 재현)에서 이것이 정책 위반으로 확인됐다 —
      // "test failure/deterministic blocker"는 아무리 반복돼도 실제 사업적/보안적 판단이
      // 필요한 게 아니다. STAGNATION 반복 여부와 무관하게 항상 아래 기술적 durable
      // wait-then-retry 경로 하나로 처리한다. lastRequiredTestRepeatCount는 로그/관측
      // 목적으로만 남긴다.
      //
      // AutoDev Efficiency / Review Stagnation Hardening(2026-08-28 정책 수정) — REVIEW_CYCLE_EXHAUSTED
      // 는 genuine WAITING_HUMAN이 아니다(§ types.ts reviewStagnationWaitCount 상단
      // 주석). review가 MAX_REVIEW_CYCLES 안에 수렴하지 못했다는 사실 자체는 순수 기술적
      // 상황이며, Developer provider timeout과 동일한 durable wait-then-retry 원칙을 그대로
      // 재사용한다. 대기 후 reviewCycle을 0으로 되돌려 이 task에 새 REVISE 예산을 준다(같은
      // task이므로 developerProviderWaitCount 등 다른 durable counter는 건드리지 않는다).
      // P1-2 하드닝(독립 감사) — 이 재시도 "횟수"에도 이제 상한이 있다(§
      // MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT, blockOnDurableWaitRetryExhausted — "천천히
      // 무한 반복"도 금지) — 초과하면 terminal 기술적 BLOCKED로 전환한다.
      state.reviewStagnationWaitCount = (state.reviewStagnationWaitCount ?? 0) + 1;
      if (
        blockOnDurableWaitRetryExhausted(
          "REVIEW_STAGNATION",
          state.reviewStagnationWaitCount,
          `review stagnation durable wait이 ${MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT}회를 초과했습니다(마지막 관측된 동일 required test 실패 반복 횟수=${lastRequiredTestRepeatCount})`
        )
      ) {
        break;
      }
      const delayMs = computeDeveloperProviderWaitDelayMs(state.reviewStagnationWaitCount, developerProviderWaitSchedule, developerProviderWaitCooldownMs);
      state.reviewStagnationNextRetryAt = new Date(now() + delayMs).toISOString();
      state.reviewCycle = 0;
      setStatus("WAITING_PROVIDER_RETRY");
      emitEvent({
        eventType: "REVIEW_CYCLE_EXHAUSTED",
        executionPhase: "review",
        outcome: "PENDING",
        humanInterventionRequired: false,
        reviseCycle: MAX_REVIEW_CYCLES,
        reason: `${REVIEW_CYCLE_EXHAUSTED_REASON}: MAX_REVIEW_CYCLES(${MAX_REVIEW_CYCLES}) 도달 — ${delayMs}ms 대기 후 새 REVISE 예산으로 재시도(${state.reviewStagnationWaitCount}회째, Human Gate로 승격하지 않음)`,
      });
      saveCurrentState(state);
      log(
        `연속 REVISE ${MAX_REVIEW_CYCLES}회 도달 — ${delayMs}ms 대기 후 새 REVISE 예산으로 재시도 (${state.reviewStagnationWaitCount}회째, 기술적 review 정체는 Human Gate로 승격하지 않고 계속 재시도합니다)`
      );
      if (await sleepOrAbort(delayMs, sleep, abortSignal)) {
        return { finalState: state, statusHistory, stopped: true };
      }
      state.reviewStagnationNextRetryAt = null;
      continue;
    }
    setStatus("REVISION_REQUIRED");
  }

  saveCurrentState(state);
  return { finalState: state, statusHistory };
}
