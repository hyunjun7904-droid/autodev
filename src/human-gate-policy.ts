import type { CoreState } from "./types";
import { REVIEW_CYCLE_EXHAUSTED_REASON } from "./review-policy";
import { CHECKPOINT_SCOPE_VIOLATION_REASON } from "./approval";

// Canonical Human Gate Policy Evaluator — AutoDev / JARVIS 지능형 오류 복구 하드닝 §
// 신뢰성 보완(2026-08-27).
//
// 목적: "이 WAITING_HUMAN이 실제 사람 판단이 필요한 상태인가, 아니면 AutoDev가 스스로
// 해소하고 재시도할 수 있는 기술적 실패인가"를 하나의 canonical 함수로 판정한다. 지금까지
// 이 판정이 여러 곳(orchestrator.ts의 WAITING_HUMAN 전환 지점들, approval.ts의
// classifyApprovalType/isRemotelyApprovable, autodev.ts의 개별 reconciliation 블록)에
// 흩어져 있어 서로 다른 기준으로 WAITING_HUMAN을 만들 위험이 있었다 — 이 파일은 그 중
// "사람 승인 없이 자동 복구해도 되는가"만 담당하는 단일 출처다. approval.ts의
// classifyApprovalType()/isRemotelyApprovable()(원격 Telegram 승인 가능 여부)은 건드리지
// 않는다 — 서로 다른 질문("원격으로 승인 가능한가" vs "애초에 사람 승인 자체가 필요한가")
// 이기 때문이다.
//
// 판정은 오직 project-state.json에 이미 저장된 값(state.deferredHumanTasks의 고정 템플릿
// 문자열, state.lastGptDecision.decision, state.humanFinalReview)만 본다 — LLM 재분류
//없음, 순수 함수, 동일 입력에는 항상 동일 출력. 매칭되지 않는 사유는 항상 fail-closed로
// GENUINE_HUMAN_JUDGMENT로 남는다(§ 요구사항: "확인하지 못한 항목은 미완료로 남긴다"와
// 동일한 원칙).
//
// 사람 판단이 반드시 필요하다고 유지하는 범주(자동 복구 대상에서 명시적으로 제외):
//   - HIGH_RISK_ACTION_PREGATE(policy.ts ALWAYS_HUMAN) — 이 함수에 도달하기 전에 이미
//     별도 마커 없이 WAITING_HUMAN이 되므로 deferredHumanTasks에 알려진 기술 마커가 없어
//     자연히 fail-closed로 걸린다.
//   - AUDIT_STORE_UNAVAILABLE_BEFORE_CHECKPOINT — 감사 저장소 자체의 장애일 수 있어(디스크/
//     권한 등) Developer 재시도로 해결되지 않을 수 있다.
//   - REMOTE_GIT_CHANGED_DURING_RUN — 다른 곳에서 remote가 앞서갔다는 뜻으로, 이 저장소의
//     Remote Git Safety Gate가 보호하려는 "요구사항 충돌"에 해당한다.
//   - GPT_RAW_CALL_LIMIT_EXCEEDED / BUDGET_EXCEEDED / AUTH_ERROR / QUOTA_EXCEEDED /
//     PROVIDER_SECURITY_BLOCKED / GPT_REVIEW_TEMPORARILY_UNAVAILABLE — 실제 비용/인증/
//     provider 보안 판단이 얽혀 있다("실제 비용 발생" 범주).
//   - CHECKPOINT_BLOCKED이지만 이유가 CHECKPOINT_SCOPE_VIOLATION_REASON이 아닌 경우(Secret/
//     Dependency Scanner Gate — SECURITY_BLOCKED) — 민감 보안 판단.
//
// 기술적 자동 복구 대상(사람 승인 없이 다음 시도로 이어감):
//   - CHECKPOINT_BLOCKED이고 이유가 정확히 CHECKPOINT_SCOPE_VIOLATION_REASON인 경우 —
//     allowedPathPrefixes 밖 예상치 못한 변경만으로 막힌 경우(Secret/Dependency 문제 없음).
//     이미 autodev.ts Phase 7이 state.lastGptDecision.scopeViolations 기준으로 안전하게
//     정리하는 대상과 정확히 같은 범주다.
//   - REVIEW_CYCLE_EXHAUSTED_REASON 마커 — REVISE가 MAX_REVIEW_CYCLES에 도달해 멈춘 경우.
//   - state.lastGptDecision.decision이 "BLOCK" 또는 "HUMAN_REQUIRED"인 경우(Reviewer 자신의
//     BLOCK 판정 — 코드 품질/scope 문제로, Developer가 고쳐야 할 기술적 사안이다).

export type WaitingHumanClassification = "GENUINE_HUMAN_JUDGMENT" | "TECHNICAL_AUTO_RECOVERABLE";

type ClassifiableState = Pick<CoreState, "deferredHumanTasks" | "lastGptDecision" | "humanFinalReview">;

const GENUINE_MARKER_PREFIXES: readonly string[] = [
  "AUDIT_STORE_UNAVAILABLE_BEFORE_CHECKPOINT(",
  "REMOTE_GIT_CHANGED_DURING_RUN(",
  "GPT_RAW_CALL_LIMIT_EXCEEDED:",
  "BUDGET_EXCEEDED:",
  "AUTH_ERROR:",
  "QUOTA_EXCEEDED:",
  "PROVIDER_SECURITY_BLOCKED:",
  "GPT_REVIEW_TEMPORARILY_UNAVAILABLE:",
];

function isCheckpointScopeViolationMarker(marker: string): boolean {
  return marker.startsWith("CHECKPOINT_BLOCKED(") && marker.includes(`: ${CHECKPOINT_SCOPE_VIOLATION_REASON}`);
}

function isNonScopeCheckpointBlockMarker(marker: string): boolean {
  return marker.startsWith("CHECKPOINT_BLOCKED(") && !isCheckpointScopeViolationMarker(marker);
}

/** state.json에 이미 저장된 값만으로 "사람 승인 없이 자동 복구해도 되는가"를 판정한다.
 *  Human Final Review gate가 있으면(§ decideNextAction의 RESUME_APPROVED_CHECKPOINT 전용
 *  경로) 이 함수는 절대 개입하지 않는다 — 항상 GENUINE_HUMAN_JUDGMENT다. */
export function classifyWaitingHumanReason(state: ClassifiableState): WaitingHumanClassification {
  if (state.humanFinalReview) return "GENUINE_HUMAN_JUDGMENT";

  const markers = state.deferredHumanTasks ?? [];

  const hasGenuineMarker =
    markers.some((m) => GENUINE_MARKER_PREFIXES.some((prefix) => m.startsWith(prefix))) ||
    markers.some(isNonScopeCheckpointBlockMarker);
  if (hasGenuineMarker) return "GENUINE_HUMAN_JUDGMENT";

  const hasCheckpointScopeViolation = markers.some(isCheckpointScopeViolationMarker);
  const hasReviewCycleExhausted = markers.some((m) => m.startsWith(`${REVIEW_CYCLE_EXHAUSTED_REASON}:`));
  const decision = state.lastGptDecision?.decision;
  const hasReviewBlocked = decision === "BLOCK" || decision === "HUMAN_REQUIRED";

  if (hasCheckpointScopeViolation || hasReviewCycleExhausted || hasReviewBlocked) {
    return "TECHNICAL_AUTO_RECOVERABLE";
  }

  // 알려진 기술적 마커가 전혀 없다 — HIGH_RISK_ACTION_PREGATE, Claude 사용량 제한 소진,
  // Claude 구조적 실패, GPT 호출 횟수 상한 등은 여기서 fail-closed로 사람 판단을 유지한다.
  return "GENUINE_HUMAN_JUDGMENT";
}

export function isTechnicalAutoRecoverableWaitingHuman(state: ClassifiableState): boolean {
  return classifyWaitingHumanReason(state) === "TECHNICAL_AUTO_RECOVERABLE";
}

const UNEXPECTED_FILES_MARKER = " — unexpected: ";

/** autodev.ts가 CHECKPOINT_BLOCKED 마커에 붙여 저장한 `checkpoint.unexpectedFiles` 목록을
 *  다시 꺼낸다(§ autodev.ts `afterOrchestrator.deferredHumanTasks.push` — 같은 join(", ")
 *  형식의 역파싱, 새 저장 형식을 만들지 않는다). 이 마커가 CHECKPOINT_SCOPE_VIOLATION_REASON
 *  케이스가 아니면(Secret/Dependency 등 다른 이유) 빈 배열을 반환한다 — 자동 정리 대상은
 *  항상 scope violation 케이스로만 한정한다. 파싱에 실패하면(형식이 예상과 다르면) 빈
 *  배열을 반환할 뿐 추측하지 않는다(fail-closed — 정리 대상을 넓히지 않는다, 과소 정리는
 *  안전하지만 과다 정리는 위험하다).
 */
export function extractCheckpointScopeViolationFiles(deferredHumanTasks: readonly string[]): string[] {
  const files: string[] = [];
  for (const marker of deferredHumanTasks) {
    if (!isCheckpointScopeViolationMarker(marker)) continue;
    const idx = marker.indexOf(UNEXPECTED_FILES_MARKER);
    if (idx === -1) continue;
    const tail = marker.slice(idx + UNEXPECTED_FILES_MARKER.length);
    for (const raw of tail.split(", ")) {
      const trimmed = raw.trim();
      if (trimmed.length > 0) files.push(trimmed);
    }
  }
  return files;
}
