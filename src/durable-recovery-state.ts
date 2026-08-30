import type { CoreState, DurableFailureState, GptReviewResult } from "./types";

export type { DurableFailureState };

// AutoDev / JARVIS 최종 무인개발 구조 보완 — Durable Failure/Recovery State.
//
// 목표: failure fingerprint/같은 실패 반복 횟수/Fireworks 호출 횟수/RCA 횟수/provider
// timeout 횟수/예상치 못한 프로세스 종료 횟수가 AutoDev 프로세스 재시작으로 0이 되지
// 않게 한다(§ 요구사항 19). 새 저장소를 만들지 않는다 — project-state.json(기존
// CoreState.technicalRecoveryState 필드, state.ts의 loadState/saveState가 이미 원자적으로
// 저장/로드하는 바로 그 파일)에 그대로 얹는다.
//
// 이 파일은 순수 함수만 담는다 — fs 접근이 전혀 없다. 실제 로드/저장은 항상 호출부
// (autodev.ts)가 이미 갖고 있는 state 객체 + state.ts의 loadState/saveState로 수행한다.

/** taskId가 다르면(새 task로 전환) 항상 새 빈 상태를 반환한다 — 다른 task의 실패
 *  이력이 새어나가지 않는다(§ 요구사항 19 "다른 Task에 이전 상태가 넘어가면 안 된다"). */
export function loadDurableFailureStateForTask(
  state: Pick<CoreState, "technicalRecoveryState">,
  taskId: string,
  now: () => Date = () => new Date()
): DurableFailureState {
  const existing = state.technicalRecoveryState;
  if (existing && existing.taskId === taskId) return existing;
  return {
    taskId,
    sameFailureCount: 0,
    rootCauseAnalysisCount: 0,
    providerTimeoutCount: 0,
    noWriteRepeatCount: 0,
    unexpectedExitCount: 0,
    updatedAt: now().toISOString(),
  };
}

/**
 * root-cause-analysis.ts의 wrapGptReviewerWithFireworksCallLimiter()에 넘길 seed를 계산한다.
 * failure fingerprint/sameFailureCount/rootCauseAnalysisCount/pendingRootCause*는
 * orchestrator.ts를 전혀 수정하지 않기 위해 GptReviewerReturn의 extra field로 "얹혀서"
 * state.lastGptDecision을 통해 저장된다(§ root-cause-analysis.ts GptReviewerFnWithDurableState
 * 상단 주석) — 그래서 여기서도 state.lastGptDecision의 그 piggyback을 최우선으로 읽는다.
 * unexpectedExitCount/providerTimeoutCount는 autodev.ts가 이미 state.technicalRecoveryState
 * (top-level)에 안전하게(§ Process/Restart Circuit Breaker, runOrchestrator 호출 "전에" 저장)
 * 기록해 두므로 그쪽에서 읽는다. 두 출처 모두 taskId가 일치할 때만 신뢰한다 — 다른 task의
 * 값이 새어들어오지 않는다.
 */
export function resolveDurableFailureStateForReviewer(
  state: Pick<CoreState, "technicalRecoveryState" | "lastGptDecision">,
  taskId: string,
  now: () => Date = () => new Date()
): DurableFailureState {
  const base = loadDurableFailureStateForTask(state, taskId, now);
  const piggyback = (state.lastGptDecision as (GptReviewResult & { technicalRecoveryState?: DurableFailureState }) | null)?.technicalRecoveryState;
  if (!piggyback || piggyback.taskId !== taskId) return base;
  return {
    ...base,
    failureFingerprint: piggyback.failureFingerprint,
    sameFailureCount: piggyback.sameFailureCount,
    rootCauseAnalysisCount: piggyback.rootCauseAnalysisCount,
    pendingRootCauseCategory: piggyback.pendingRootCauseCategory,
    pendingSnapshotKey: piggyback.pendingSnapshotKey,
    lastRecoveryAction: piggyback.lastRecoveryAction ?? base.lastRecoveryAction,
  };
}

/** task가 실제로 완료(checkpoint 성공)됐을 때 호출한다 — 다음 task가 이 task의 실패
 *  이력을 물려받지 않게 완전히 비운다. */
export function clearDurableFailureState(state: { technicalRecoveryState?: DurableFailureState | null }): void {
  state.technicalRecoveryState = null;
}
