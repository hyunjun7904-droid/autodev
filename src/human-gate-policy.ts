import type { CoreState } from "./types";
import type { AutoDevEventType } from "./observability-event";
import { REVIEW_CYCLE_EXHAUSTED_REASON } from "./review-policy";
import { CHECKPOINT_SCOPE_VIOLATION_REASON } from "./approval";
import { DEVELOPER_TRANSIENT_RETRY_EXHAUSTED_PREFIX } from "./claude-developer";
import { STAGNATION_DETECTED_MARKER_PREFIX } from "./failure-stagnation";
import {
  MAX_GPT_CALLS_EXCEEDED_MARKER_PREFIX,
  CLAUDE_STRUCTURAL_FAILURE_MARKER_PREFIX,
  DETERMINISTIC_REVIEW_CYCLE_EXHAUSTED_MARKER_PREFIX,
} from "./orchestrator";

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
//     PROVIDER_SECURITY_BLOCKED — 실제 비용/인증/provider 보안 판단이 얽혀 있다("실제 비용
//     발생" 범주). GPT_REVIEW_TEMPORARILY_UNAVAILABLE은 2026-08-28 정책 수정으로 이 목록에서
//     빠졌다 — orchestrator.ts가 이제 이 errorCode를 genuine 마커로 저장하지 않고(§ 아래
//     "기술적 자동 복구 대상") 같은 diff로 재리뷰만 무한히 반복하기 때문에, 이 마커 자체가
//     더 이상 생성되지 않는다.
//   - CHECKPOINT_BLOCKED이지만 이유가 CHECKPOINT_SCOPE_VIOLATION_REASON이 아닌 경우(Secret/
//     Dependency Scanner Gate — SECURITY_BLOCKED) — 민감 보안 판단.
//   - CHECKPOINT_BLOCKED이고 이유가 정확히 CHECKPOINT_SCOPE_VIOLATION_REASON인 경우(No-Safe-
//     Recovery-Action Gate, 2026-08-31) — 예전(2026-08-27 Phase 7)에는 여기 있지 않았다:
//     그때는 autodev.ts가 이 leftover 파일을 다음 attempt 전에 자동으로 rmSync해서 지웠으므로
//     "재시도하면 스스로 풀린다"가 실제로 성립했다. Positive-Provenance-Only Auto-Delete
//     Policy(2026-08-31, a490700)로 그 자동 삭제가 완전히 제거된 이후로는(AutoDev가 이 파일을
//     자신이 만들었다고 증명할 방법이 구조적으로 없다는 것이 확인됨) 이 전제가 더 이상
//     성립하지 않는다 — Developer(LLM ACTION_REQUEST)에는 파일 삭제 action 자체가 없고, 이
//     파일은 이미 allowedPathPrefixes 밖이라 WRITE_FILE로도 지울 수 없으므로, 같은 task를
//     Developer/Reviewer로 몇 번을 재시도해도 이 파일은 절대 사라지지 않는다(결정론적으로
//     재현되는 blocker — required test 반복 실패처럼 "다른 접근을 시도하면 통과할 수도
//     있는" 종류가 아니다). 이 파일을 지우거나 그대로 둘지는 사람만 판단할 수 있으므로(§
//     요구사항: "실제 파일 삭제/보존 판단처럼 사용자 판단이 필요한 경우") genuine으로
//     분류한다 — 기술적 재시도를 50회(continuous-runner.ts MAX_TECHNICAL_RECOVERY_ATTEMPTS)
//     반복한 뒤에야 사람에게 넘기는 대신, 처음 발견되는 즉시 사람 판단 상태로 전환한다.
//     사람이 실제로 파일을 지우거나(또는 보존하기로 결정하고) local-human-approval.ts로
//     승인하면(§ isCheckpointBlockedMarker — remotelyApprovable=false 유지, Telegram에서
//     실수로 누르지 않도록) 그 다음 실행에서 정상 재개된다(§ 요구사항 시나리오 B) — "사람
//     승인 없이는 다시 시도하지 않는다"이지 "영원히 막힌다"가 아니다.
//   - MAX_GPT_CALLS_EXCEEDED_MARKER_PREFIX 마커(orchestrator.ts MAX_GPT_CALLS) — REVISE
//     "cycle" 수(코드 수정 후 재리뷰 횟수)가 10회를 넘었다는 뜻으로, 실제 GPT 호출 비용이
//     이미 상당히 발생했다는 신호다("실제 비용 발생" 범주, GPT_RAW_CALL_LIMIT_EXCEEDED와
//     같은 성격이지만 별도 카운터). 2026-08-28 이전에는 이 마커 없이 fail-closed 기본값에만
//     의존해 genuine으로 남았다(§ production-agent-integration-tests.ts
//     scenarioAdvisoryCannotOverrideCoreTestFailure가 이 설계를 직접 검증) — STAGNATION_DETECTED
//     마커가 기술적 자동 복구 대상에 추가되면서(§ 아래) "마커가 없으면 genuine"이라는 암묵적
//     판정에만 의존할 경우 STAGNATION_DETECTED 마커가 남아있는 상태로 이 비용 상한에 도달해도
//     조용히 자동 복구될 위험이 생겨, 이 마커를 명시적으로 추가했다(판정 결과 자체는 바뀌지
//     않는다 — 근거만 암묵적 부재에서 명시적 마커로 바뀔 뿐이다).
//   - CLAUDE_STRUCTURAL_FAILURE_MARKER_PREFIX 마커(orchestrator.ts — Claude 결과가
//     success=false이고 DEVELOPER_TRANSIENT_RETRY_EXHAUSTED_PREFIX(TIMEOUT/CLI_NOT_FOUND류
//     provider 일시 장애)가 아닌 경우, 예: 파싱/권한 게이트 실패) — provider가 응답을 아예
//     못 준 것과 다른 범주로, 여전히 사람이 봐야 할 진짜 문제일 수 있다. 위와 동일한 이유로
//     STAGNATION_DETECTED 마커 도입에 맞춰 명시적 마커를 추가했다.
//
// 기술적 자동 복구 대상(사람 승인 없이 다음 시도로 이어감):
//   - REVIEW_CYCLE_EXHAUSTED_REASON 마커 — REVISE가 MAX_REVIEW_CYCLES에 도달해 멈춘 경우.
//   - state.lastGptDecision.decision이 "BLOCK" 또는 "HUMAN_REQUIRED"인 경우(Reviewer 자신의
//     BLOCK 판정 — 코드 품질/scope 문제로, Developer가 고쳐야 할 기술적 사안이다).
//   - DEVELOPER_TRANSIENT_RETRY_EXHAUSTED_PREFIX 마커(claude-developer.ts) — Developer가
//     일시적 오류(TIMEOUT/CLI_NOT_FOUND)로 attempt 내 재시도를 소진한 경우. 2026-08-28 정책
//     수정: orchestrator.ts는 이제 이 마커를 절대 genuine WAITING_HUMAN으로 승격하지 않는다
//     — durable wait-then-retry(§ WAITING_PROVIDER_RETRY)를 무한히(재시도 "횟수"에 상한
//     없음, 재시도 "간격"만 bounded) 계속한다. 따라서 이 마커 하나만 저장된 WAITING_HUMAN은
//     항상 이 정책이 도입되기 전(stale)에 만들어진 상태다 — Task 위험도(예: security-
//     critical)와 실패 원인 위험도(provider timeout)를 분리한다는 원칙에 따라 자동 복구
//     대상으로 취급해, 다음 실행에서 자동으로 READY로 되돌리고 durable wait 경로로 넘어가게
//     한다.
//   - STAGNATION_DETECTED_MARKER_PREFIX 마커(failure-stagnation.ts — orchestrator.ts가
//     같은 required test 실패가 2회 연속 반복될 때 남긴다, § orchestrator.ts stagnationTracker)
//     — 이 마커는 그 자체로 "무엇이 반복됐는지"를 기록하는 관측용 표시일 뿐, 실제 비용/보안/
//     권한/요구사항 충돌 판단이 필요하다는 신호가 아니다(어떤 FailureCategory든 동일 —
//     INFRASTRUCTURE_CONFIGURATION/IMPLEMENTATION/PROVIDER/UNKNOWN 전부 이 마커 하나만으로는
//     genuine이 되지 않는다). 이미 REVIEW_CYCLE_EXHAUSTED_REASON이 "required test가 계속
//     실패해 REVISE가 소진돼도 genuine이 아니다"라고 정한 것과 동일한 원칙을 그보다 이른
//     시점(2회 연속 반복 시점)에 적용할 뿐이다. 주의: 이 마커는 REVIEW_CYCLE_EXHAUSTED_REASON/
//     DEVELOPER_TRANSIENT_RETRY_EXHAUSTED_PREFIX와 달리 "이 WAITING_HUMAN이 왜 발생했는지"의
//     terminal 사유가 아니라 루프 중간에 한 번만 찍히는 관측용 breadcrumb다 — 그 뒤로도 같은
//     runOrchestrator() 실행이 계속돼 결국 MAX_GPT_CALLS_EXCEEDED_MARKER_PREFIX/
//     CLAUDE_STRUCTURAL_FAILURE_MARKER_PREFIX 같은 실제 genuine 사유로 WAITING_HUMAN에
//     도달할 수 있다. hasGenuineMarker 검사가 이 함수에서 항상 먼저 실행되므로 그 경우
//     이 마커는 결과를 바꾸지 못하고 GENUINE으로 남는다(§ 위 두 마커 항목) — 이 마커 혼자
//     남아있을 때만(다른 genuine 마커가 전혀 없을 때만) 기술적 자동 복구 대상이 된다. 자동
//     복구는 "이 task를 완료로 선언"하지 않는다, decideNextAction()이 이 task를 다시 선택해
//     Developer/Reviewer/Required Test/
//     Security Gate를 처음부터 다시 통과시키므로 실제 원인이 아직 해결되지 않았다면 그대로
//     다시 실패해 관측 가능한 상태(대시보드/로그)로 계속 남는다. 무한 재시도 방지는 이미
//     별도 계층(continuous-runner.ts의 technicalRecoveryCount 상한,
//     computeDeveloperProviderWaitDelayMs의 점증 backoff, failure-stagnation.ts
//     buildEscalationGuidance/problem-memory.ts의 반복 전략 차단 안내)이 담당한다 — 이
//     함수는 "사람 승인이 필요한가"만 판정하고 "얼마나 재시도할지"는 판정하지 않는다.

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
  MAX_GPT_CALLS_EXCEEDED_MARKER_PREFIX,
  // CLAUDE_STRUCTURAL_FAILURE_MARKER_PREFIX는 여기 없다 — § P0-3 재하드닝(독립 감사) 아래
  // isGenuineClaudeStructuralFailureMarker() 참고. errorCode==="PROTOCOL_ERROR"(응답 해석
  // 반복 실패)만은 예외적으로 기술적 자동 복구 대상이라 이 블랑켓 목록에 넣을 수 없다.
  // AutoDev Core Maintenance(2026-08-30) — 같은 cycle에 STAGNATION_DETECTED_MARKER_PREFIX
  // 마커가 이미 함께 남아있을 수 있다(repeatCount===2 시점에 무조건 push되고, 이 exhaustion
  // 마커는 그보다 나중 cycle에 추가로 push될 수 있음) — STAGNATION_DETECTED만 있었다면
  // TECHNICAL_AUTO_RECOVERABLE이 맞지만, 이 마커가 함께 있으면 "단순 반복 관측"이 아니라
  // "그 반복 때문에 review 예산 자체가 소진되어 genuine 개입이 필요하다고 이미 확정됨"이라는
  // 뜻이다 — MAX_GPT_CALLS_EXCEEDED_MARKER_PREFIX/CLAUDE_STRUCTURAL_FAILURE_MARKER_PREFIX와
  // 동일한 이유로 여기 추가한다(§ 위 두 항목의 원래 도입 주석과 동일한 패턴 — STAGNATION_DETECTED
  // co-occurrence에 의해 조용히 TECHNICAL_AUTO_RECOVERABLE로 뒤집히지 않게 한다).
  DETERMINISTIC_REVIEW_CYCLE_EXHAUSTED_MARKER_PREFIX,
];

function isCheckpointScopeViolationMarker(marker: string): boolean {
  return marker.startsWith("CHECKPOINT_BLOCKED(") && marker.includes(`: ${CHECKPOINT_SCOPE_VIOLATION_REASON}`);
}

/** § P0-3 재하드닝(독립 감사, 2026-08-30)이 PROTOCOL_ERROR 하나만 기술적 자동 복구
 *  대상으로 처음 분리했다. § BLOCKER 2 재하드닝(독립 최종 감사, 2026-08-30 후속) — 그
 *  분리 원칙을 CLAUDE_STRUCTURAL_FAILURE의 나머지 errorCode에도 claude-developer.ts의 실제
 *  생성 의미(§ 그 파일 상단 주석 "AUTH_REQUIRED(사람 로그인 필요)/NON_ZERO_EXIT(실제 exit
 *  code 실패 — 결정적 오류로 취급)/INVALID_OUTPUT(파싱 불가능한 응답)/...")를 직접 확인한
 *  뒤 개별적으로 적용한다 — 추측으로 일괄 재분류하지 않는다:
 *
 *  - INVALID_OUTPUT — claude-runner.ts가 최상위 CLI stdout 전체를 JSON으로 파싱하지 못한
 *    경우(claude-runner.ts makeError("INVALID_OUTPUT", ...)). PROTOCOL_ERROR(내부 라운드
 *    단위 응답 계약 위반이 반복됨)와 같은 계열의 "응답 형식을 해석하지 못했다"는 순수 파싱
 *    문제이지 사업/보안 판단이 아니다 — PROTOCOL_ERROR와 동일하게 기술적 자동 복구 대상으로
 *    옮긴다.
 *  - NON_ZERO_EXIT — Claude CLI 프로세스 자체의 실행 실패(exit code)로, "재시도 exhaustion"/
 *    "execution environment failure" 범주에 해당한다 — 기술적 자동 복구 대상으로 옮긴다.
 *  - TASK_ACTION_LIMIT/NO_PROGRESS_STAGNATION — Claude가 예산(내부 라운드/탐색-only grace)
 *    안에 진척을 만들지 못하고 끝난 경우로, 이미 기술적 자동 복구 대상인
 *    STAGNATION_DETECTED_MARKER_PREFIX(같은 required test 실패 반복)와 정확히 같은 성격의
 *    "반복/무진척 패턴"이다 — 동일한 원칙으로 기술적 자동 복구 대상으로 옮긴다. 새 시도는
 *    Developer를 처음부터 다시 호출하므로(§ orchestrator.ts) 다른 탐색 경로로 실제 진척이
 *    날 여지가 있다.
 *  - AUTH_REQUIRED(사람 로그인 필요)는 그대로 GENUINE으로 남긴다 — 어떤 횟수의 자동
 *    재시도로도 스스로 해결될 수 없는 상태(사람이 실제로 로그인해야 함)라, bounded
 *    retry로 옮겨도 재시도 예산만 소모하고 결국 다시 사람을 기다리게 될 뿐이다.
 *  - TRUSTED_EXECUTABLE_NOT_FOUND/EXECUTABLE_IDENTITY_UNTRUSTED/EXECUTABLE_SHADOWING_DETECTED
 *    (claude-developer.ts 주석: "실행 파일 신뢰 검증 실패 — 보안 성격, 무작정 재시도하면
 *    안 됨")는 그대로 GENUINE으로 남긴다 — PATH/cwd executable shadowing류 잠재적 공격
 *    신호일 수 있어(§ .claude/rules/future-operations.md SI-3.4 관련 기록) 조용히 재시도만
 *    반복하고 사람에게 알리지 않는 것은 안전 회귀다.
 *  - UNKNOWN(그 외 알 수 없는 errorCode)은 이 파일의 fail-closed 원칙("매칭되지 않는 사유는
 *    항상 GENUINE_HUMAN_JUDGMENT") 그대로 GENUINE으로 남긴다. */
const TECHNICAL_CLAUDE_STRUCTURAL_FAILURE_ERROR_CODES: readonly string[] = [
  "PROTOCOL_ERROR",
  "INVALID_OUTPUT",
  "NON_ZERO_EXIT",
  "TASK_ACTION_LIMIT",
  "NO_PROGRESS_STAGNATION",
];

function isTechnicalClaudeStructuralFailureMarker(marker: string): boolean {
  return TECHNICAL_CLAUDE_STRUCTURAL_FAILURE_ERROR_CODES.some((code) => marker.startsWith(`${CLAUDE_STRUCTURAL_FAILURE_MARKER_PREFIX}${code})`));
}

function isGenuineClaudeStructuralFailureMarker(marker: string): boolean {
  return marker.startsWith(CLAUDE_STRUCTURAL_FAILURE_MARKER_PREFIX) && !isTechnicalClaudeStructuralFailureMarker(marker);
}

/** Genuine Human Gate Local Approval(2026-08-29)이 재사용한다 — CHECKPOINT_BLOCKED 마커를
 *  전부 골라낸다. 2026-08-29 도입 당시에는 이름 그대로 scope-violation(그때는 기술적 자동
 *  복구 대상)을 "제외"했지만, No-Safe-Recovery-Action Gate(2026-08-31)로 scope-violation도
 *  genuine이 된 뒤로는 CHECKPOINT_BLOCKED 마커 전부가 genuine이므로 더 이상 제외할 대상이
 *  없다 — 그래서 이름도 isCheckpointBlockedMarker로 바꿨다(기존 호출부 3곳 — autodev.ts/
 *  local-human-approval.ts × 2 — 도 함께 갱신, 로직 자체는 여전히 이 파일 하나가
 *  단일 출처다). */
export function isCheckpointBlockedMarker(marker: string): boolean {
  return marker.startsWith("CHECKPOINT_BLOCKED(");
}

/** state.json에 이미 저장된 값만으로 "사람 승인 없이 자동 복구해도 되는가"를 판정한다.
 *  Human Final Review gate가 있으면(§ decideNextAction의 RESUME_APPROVED_CHECKPOINT 전용
 *  경로) 이 함수는 절대 개입하지 않는다 — 항상 GENUINE_HUMAN_JUDGMENT다. */
export function classifyWaitingHumanReason(state: ClassifiableState): WaitingHumanClassification {
  if (state.humanFinalReview) return "GENUINE_HUMAN_JUDGMENT";

  const markers = state.deferredHumanTasks ?? [];

  const hasGenuineMarker =
    markers.some((m) => GENUINE_MARKER_PREFIXES.some((prefix) => m.startsWith(prefix))) ||
    markers.some(isCheckpointBlockedMarker) ||
    markers.some(isGenuineClaudeStructuralFailureMarker);
  if (hasGenuineMarker) return "GENUINE_HUMAN_JUDGMENT";

  const hasReviewCycleExhausted = markers.some((m) => m.startsWith(`${REVIEW_CYCLE_EXHAUSTED_REASON}:`));
  const decision = state.lastGptDecision?.decision;
  const hasReviewBlocked = decision === "BLOCK" || decision === "HUMAN_REQUIRED";
  const hasDeveloperTransientRetryExhausted = markers.some((m) => m.startsWith(DEVELOPER_TRANSIENT_RETRY_EXHAUSTED_PREFIX));
  const hasStagnationDetected = markers.some((m) => m.startsWith(STAGNATION_DETECTED_MARKER_PREFIX));
  const hasTechnicalClaudeStructuralFailure = markers.some(isTechnicalClaudeStructuralFailureMarker);

  if (
    hasReviewCycleExhausted ||
    hasReviewBlocked ||
    hasDeveloperTransientRetryExhausted ||
    hasStagnationDetected ||
    hasTechnicalClaudeStructuralFailure
  ) {
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

// ---------------------------------------------------------------------------
// Orphaned Genuine Human Gate Recovery(2026-09-01) — durable project-state가 genuine
// WAITING_HUMAN인데 대응하는 durable AutoDevEvent/valid ApprovalRequest가 없을 수 있다는
// 것이 확인됐다(§ .claude/CLAUDE.md — JARVIS Task 5.3 실측). local-human-approval.ts의
// ensureDurableApprovalForGenuineWaitingHuman()이 이 파일 하나만을 "지금 실제로 막고 있는
// genuine 사유가 무엇인가"의 canonical 출처로 재사용한다 — 새 blocker parser를 별도로 만들지
// 않는다.
// ---------------------------------------------------------------------------

/** CHECKPOINT_BLOCKED 마커(§ autodev.ts `CHECKPOINT_BLOCKED(${taskDef.id}): ${checkpoint.reason}
 *  [ — unexpected: ...]`)를 taskId/reason으로 되돌린다 — extractCheckpointScopeViolationFiles()와
 *  같은 저장 형식의 역파싱이다(새 저장 형식을 만들지 않는다). 형식이 예상과 다르면 null을
 *  반환할 뿐 추측하지 않는다(fail-closed). */
function parseCheckpointBlockedMarker(marker: string): { taskId: string; reason: string } | null {
  if (!marker.startsWith("CHECKPOINT_BLOCKED(")) return null;
  const closeIdx = marker.indexOf("): ");
  if (closeIdx === -1) return null;
  const taskId = marker.slice("CHECKPOINT_BLOCKED(".length, closeIdx);
  let reason = marker.slice(closeIdx + "): ".length);
  const filesIdx = reason.indexOf(UNEXPECTED_FILES_MARKER);
  if (filesIdx !== -1) reason = reason.slice(0, filesIdx);
  return { taskId, reason };
}

export interface GenuineWaitingHumanBlocker {
  /** dedupe/identity에 쓰는 안정적 문자열 — 같은 project-state(같은 project/task/genuine
   *  사유)에서는 항상 같은 값이다. state.deferredHumanTasks/state.humanFinalReview에 이미
   *  저장된 내용에서만 유도한다 — 존재하지 않는 정보를 추측하지 않는다. */
  fingerprint: string;
  /** 이 marker를 approval.ts classifyApprovalType()이 이해하는 {eventType, reason} 쌍으로
   *  정직하게 되돌릴 수 있으면 채운다 — 지금은 CHECKPOINT_BLOCKED 계열만 지원한다
   *  (performLocalHumanApproval()/createFreshLocalApprovalRequest()와 동일한 지원 범위, §
   *  local-human-approval.ts 주석). 이미 durable state에 저장된 고정 템플릿 문자열을 기존
   *  classifier의 입력 모양으로 재배열할 뿐, eventId/timestamp 등 실제 event 고유 값은 전혀
   *  만들지 않는다 — 존재하지 않았던 event를 재현하지 않는다. */
  reconstructedReasonForClassification?: { eventType: AutoDevEventType; reason: string };
}

/** state.deferredHumanTasks(및 state.humanFinalReview)만으로 "지금 이 WAITING_HUMAN을 막고
 *  있는 genuine 사유가 무엇인가"를 재구성한다 — classifyWaitingHumanReason()이 이미
 *  GENUINE_HUMAN_JUDGMENT로 판정한 경우에만 non-null을 반환한다(그 판정을 다시 하지 않는다,
 *  단일 출처 재사용). taskId는 호출부가 이미 확정한 현재 task(§ task-registry.ts
 *  getNextTask())를 그대로 받는다 — 이 함수 자신은 "무엇이 현재 task인가"를 추측하지 않는다.
 *
 *  마커가 여러 genuine 범주에 걸쳐 있어도(예: STAGNATION_DETECTED와 CHECKPOINT_BLOCKED가
 *  함께 저장된 경우) classifyWaitingHumanReason()과 동일한 우선순위(CHECKPOINT_BLOCKED류가
 *  가장 구체적) — CHECKPOINT_BLOCKED 계열이 있으면 그것으로, 없으면 다른 genuine
 *  marker/humanFinalReview/무마커 fail-closed 순으로 fingerprint를 고른다. */
export function identifyGenuineWaitingHumanBlocker(state: ClassifiableState, taskId: string): GenuineWaitingHumanBlocker | null {
  if (classifyWaitingHumanReason(state) !== "GENUINE_HUMAN_JUDGMENT") return null;

  const markers = state.deferredHumanTasks ?? [];

  const checkpointMarker = markers.find((m) => {
    const parsed = parseCheckpointBlockedMarker(m);
    return parsed !== null && parsed.taskId === taskId;
  });
  if (checkpointMarker) {
    const parsed = parseCheckpointBlockedMarker(checkpointMarker);
    if (parsed) {
      const eventType: AutoDevEventType = parsed.reason === CHECKPOINT_SCOPE_VIOLATION_REASON ? "HUMAN_APPROVAL_REQUIRED" : "SECURITY_BLOCKED";
      return { fingerprint: checkpointMarker, reconstructedReasonForClassification: { eventType, reason: parsed.reason } };
    }
  }

  const genuineMarker = markers.find(
    (m) => GENUINE_MARKER_PREFIXES.some((prefix) => m.startsWith(prefix)) || isGenuineClaudeStructuralFailureMarker(m)
  );
  if (genuineMarker) return { fingerprint: genuineMarker };

  if (state.humanFinalReview) {
    return { fingerprint: `HUMAN_FINAL_REVIEW(${taskId}):${JSON.stringify(state.humanFinalReview)}` };
  }

  // 알려진 marker가 전혀 없는 fail-closed genuine 케이스(예: HIGH_RISK_ACTION_PREGATE — § 위
  // classifyWaitingHumanReason 문서, 별도 마커 없이 genuine으로 남는다). 그래도 재실행마다
  // 다른 fingerprint를 만들지 않도록 taskId 기반 안정값을 쓴다 — 이 task에 대해 알려진
  // marker가 전혀 없는 상태 자체가 이 fingerprint의 근거다.
  return { fingerprint: `UNMARKED_GENUINE(${taskId})` };
}
