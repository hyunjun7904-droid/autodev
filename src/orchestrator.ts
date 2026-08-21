import { loadState, saveState, DEFAULT_STATE_PATH } from "./state";
import { runClaudeTask as fakeRunClaudeTask } from "./fake-claude-runner";
import { runDeveloperTaskViaSafeExecutor } from "./claude-developer";
import { reviewClaudeResult as fakeReviewClaudeResult } from "./fake-gpt-reviewer";
import { reviewClaudeResult as realReviewClaudeResult } from "./gpt-reviewer";
import type { ReviewProjectContext } from "./gpt-reviewer";
import type { SafeExecutorContext } from "./safe-executor";
import { requiresHumanApproval, classifyTaskRisk, MAX_REVIEW_CYCLES } from "./policy";
import { applyReviewDecisionPolicy, hasFailedRequiredTest, REVIEW_CYCLE_EXHAUSTED_REASON } from "./review-policy";
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
}

export interface OrchestratorDeps {
  claudeRunner?: (task: string, attempt: number) => Promise<ClaudeResult>;
  gptReviewer?: (
    result: ClaudeResult,
    reviewCycle: number,
    task: string,
    allowedPathPrefixes?: string[],
    projectContext?: ReviewProjectContext
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
  return (task: string, attempt: number) => runDeveloperTaskViaSafeExecutor(task, attempt);
}
function selectDefaultGptReviewer(executor?: SafeExecutorContext): (
  result: ClaudeResult,
  reviewCycle: number,
  task: string,
  allowedPathPrefixes?: string[],
  projectContext?: ReviewProjectContext
) => Promise<GptReviewerReturn> {
  if (process.env.AUTOMATION_DRY_RUN !== "false") return fakeReviewClaudeResult;
  return (result, reviewCycle, task, allowedPathPrefixes, projectContext) =>
    realReviewClaudeResult(result, reviewCycle, task, { allowedPathPrefixes, projectContext, executor });
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
    saveCurrentState(state);
    return { finalState: state, statusHistory };
  }

  let gptCallCount = 0;
  let gptRawCallTotal = 0;

  while (true) {
    setStatus("CLAUDE_WORKING");
    state.reviewCycle += 1;
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

    setStatus("WAITING_GPT_REVIEW");
    gptCallCount += 1;
    if (gptCallCount > MAX_GPT_CALLS) {
      log(`GPT 호출 ${MAX_GPT_CALLS}회 초과 — WAITING_HUMAN`);
      setStatus("WAITING_HUMAN");
      break;
    }

    const gptResult = await gptReviewer(claudeResult, state.reviewCycle, task, deps.allowedPathPrefixes, deps.projectContext);

    // reviewCycle(코드 수정 횟수)과 별개로 실제 API 통신 재시도까지 포함한 원시 호출
    // 총합에도 hard cap을 둔다 — 무한호출 방지(REVIEW 재시도가 반복돼도 실제 비용은 유한).
    gptRawCallTotal += 1 + (gptResult.gptTransportRetry ?? 0);
    if (gptRawCallTotal > MAX_GPT_RAW_CALLS) {
      log(`GPT 원시 API 호출 총합 ${MAX_GPT_RAW_CALLS}회 초과 — WAITING_HUMAN`, { gptRawCallTotal });
      state.deferredHumanTasks.push(`GPT_RAW_CALL_LIMIT_EXCEEDED: 총 ${gptRawCallTotal}회`);
      setStatus("WAITING_HUMAN");
      break;
    }

    if (
      gptResult.errorCode === "AUTH_ERROR" ||
      gptResult.errorCode === "QUOTA_EXCEEDED" ||
      gptResult.errorCode === "GPT_REVIEW_TEMPORARILY_UNAVAILABLE"
    ) {
      state.deferredHumanTasks.push(`${gptResult.errorCode}: ${gptResult.feedback}`);
    }

    // GPT decision에 대한 안전장치 override(scope 밖 변경→BLOCK, critical/high 있는데
    // PASS→REVISE, 필수 테스트 실패에도 PASS→REVISE)는 review-policy.ts의 단일 출처를
    // 그대로 쓴다(Phase F Task F4) — agent-orchestrator.ts(F2/F3)의 REVISE loop도 동일한
    // 함수를 쓰므로 두 실행경로의 판정이 서로 달라질 위험이 없다.
    const requiredTestsFailed = hasFailedRequiredTest(claudeResult.tests);
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

    if (decision === "PASS") {
      setStatus("APPROVED");
      break;
    }
    if (decision === "BLOCK" || decision === "HUMAN_REQUIRED") {
      setStatus("WAITING_HUMAN");
      break;
    }

    // REVISE
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
      break;
    }
    setStatus("REVISION_REQUIRED");
  }

  saveCurrentState(state);
  return { finalState: state, statusHistory };
}
