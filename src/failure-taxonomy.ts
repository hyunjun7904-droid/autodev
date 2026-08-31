import type { ClaudeErrorCode } from "./claude-runner";
import type { DeveloperErrorCode } from "./claude-developer";
import type { GptErrorCode } from "./types";

// AutoDev 최종 통합 하드닝(Hardening B, Failure Taxonomy 강화) — 단일 공유 분류 어휘.
//
// 실제 재시도/backoff 로직(claude-developer.ts의 DEVELOPER_TRANSIENT_ERROR_CODES/
// isTransientDeveloperFailure, gpt-reviewer.ts/openai-review-provider.ts의 classifyApiError,
// orchestrator.ts의 QUOTA_EXCEEDED/AUTH_ERROR/BUDGET_EXCEEDED/PROVIDER_SECURITY_BLOCKED
// 즉시-사람전달 분기)는 이미 각자의 위치에서 "이 실패를 재시도해야 하는가"를 증거 기반으로
// 판정하고 있다 — 이 파일은 그 판정 로직을 대체하거나 재구현하지 않는다(새 retry engine을
// 만들지 않는다). 이 파일이 추가하는 것은 그 개별 판정들을 하나의 공통 4분류 어휘
// (TRANSIENT/PERMANENT/DETERMINISTIC_LOCAL/UNKNOWN_TRANSIENTNESS)로 매핑해, 로그/
// diagnostic evidence bundle/problem-memory 등에서 "이 실패가 어느 범주였는가"를 프로젝트에
// 상관없이 일관되게 참조할 수 있게 하는 것뿐이다 — 순수 함수, 부수효과 없음.
//
// 각 매핑은 이미 해당 모듈이 코드/주석으로 문서화한 판정 근거를 그대로 옮긴 것이다(예:
// claude-developer.ts의 DEVELOPER_TRANSIENT_ERROR_CODES 상단 주석). 새로운 판단을 여기서
// 추가로 내리지 않는다 — 이미 내려진 판단에 이름을 붙일 뿐이다.

export type FailureClass = "TRANSIENT" | "PERMANENT" | "DETERMINISTIC_LOCAL" | "UNKNOWN_TRANSIENTNESS";

export interface FailureClassification {
  failureClass: FailureClass;
  /** 사람이 읽는 분류 근거 — 어떤 기존 판정/증거를 근거로 이 범주에 매핑했는지. */
  reason: string;
}

/**
 * claude-runner.ts/claude-developer.ts의 ClaudeErrorCode(Developer 실행 실패)를 분류한다.
 * TIMEOUT/CLI_NOT_FOUND는 이미 DEVELOPER_TRANSIENT_ERROR_CODES가 재시도 대상으로 확정한
 * 값이다. USAGE_LIMIT은 claude-developer.ts가 이미 자체적으로(12회, 매회 30분) 재시도하는
 * 실제 텍스트 패턴 증거 기반 신호다 — 알려진 리셋 주기가 있는 TRANSIENT로 취급한다.
 */
export function classifyClaudeErrorCode(code: ClaudeErrorCode): FailureClassification {
  switch (code) {
    case "TIMEOUT":
      return { failureClass: "TRANSIENT", reason: "일시적 프로세스/CLI 응답 지연 — DEVELOPER_TRANSIENT_ERROR_CODES가 이미 재시도 대상으로 확정." };
    case "CLI_NOT_FOUND":
      return { failureClass: "TRANSIENT", reason: "일시적 PATH/프로세스 가용성 문제로 취급 — DEVELOPER_TRANSIENT_ERROR_CODES가 이미 재시도 대상으로 확정." };
    case "USAGE_LIMIT":
      return { failureClass: "TRANSIENT", reason: "실제 사용량 한도 텍스트 패턴 증거(detectUsageLimitSignal) 기반 — 알려진 리셋 주기가 있어 긴 bounded backoff(12회×30분)로 이미 재시도됨." };
    case "AUTH_REQUIRED":
      return { failureClass: "PERMANENT", reason: "사람의 재로그인이 필요 — 재시도로 해결되지 않음." };
    case "ABORTED":
      return { failureClass: "PERMANENT", reason: "사람/시스템이 명시적으로 중단을 요청한 canonical stop — 재시도 대상 자체가 아님." };
    case "TRUSTED_EXECUTABLE_NOT_FOUND":
    case "EXECUTABLE_IDENTITY_UNTRUSTED":
    case "EXECUTABLE_SHADOWING_DETECTED":
      return { failureClass: "DETERMINISTIC_LOCAL", reason: "실행 파일 신뢰/환경 설정 결함(SI-3.6) — 로컬에서 결정론적으로 재확인 가능하며 무작정 재시도해서는 안 됨." };
    case "NON_ZERO_EXIT":
      return { failureClass: "UNKNOWN_TRANSIENTNESS", reason: "실제 exit code 실패지만 근본 원인(구현 결함 vs 일시적 환경 문제)이 이 신호만으로 확정되지 않음." };
    case "INVALID_OUTPUT":
      return { failureClass: "UNKNOWN_TRANSIENTNESS", reason: "파싱 불가능한 응답 — 일시적 전송 손상인지 영구적 스키마 불일치인지 이 신호만으로 확정되지 않음." };
  }
}

/**
 * claude-developer.ts의 DeveloperErrorCode(ClaudeErrorCode 상위집합)를 분류한다.
 * TASK_ACTION_LIMIT/PROTOCOL_ERROR/NO_PROGRESS_STAGNATION은 이미 DEVELOPER_TRANSIENT_ERROR_CODES
 * 상단 주석이 "Claude 자신의 결정적 동작 문제, 재시도해도 같은 결과가 반복될 가능성이 높음"으로
 * 명시한 값이다 — 그대로 DETERMINISTIC_LOCAL로 옮긴다.
 */
export function classifyDeveloperErrorCode(code: DeveloperErrorCode): FailureClassification {
  switch (code) {
    case "TASK_ACTION_LIMIT":
      return { failureClass: "DETERMINISTIC_LOCAL", reason: "라운드/action 상한 도달 — Claude 자신의 결정적 동작 한계로, 같은 조건이면 재시도해도 반복됨." };
    case "PROTOCOL_ERROR":
      return { failureClass: "DETERMINISTIC_LOCAL", reason: "Claude 자신의 응답 프로토콜 위반 — 결정적 동작 문제로 취급(§ DEVELOPER_TRANSIENT_ERROR_CODES 주석)." };
    case "NO_PROGRESS_STAGNATION":
      return { failureClass: "DETERMINISTIC_LOCAL", reason: "반복되는 동일 no-progress 상태를 이미 결정론적으로 확정한 hard abort — 같은 전략으로 재시도하면 반복됨." };
    default:
      return classifyClaudeErrorCode(code);
  }
}

/**
 * gpt-reviewer.ts/openai-review-provider.ts의 GptErrorCode(Reviewer 실행 실패)를 분류한다.
 * API_ERROR는 openai-review-provider.ts의 classifyApiError()가 이미 실제 5xx/connection
 * 증거로 transient 여부를 판정해뒀으므로, 그 결과(evidenceBasedTransient)를 그대로 받아
 * 매핑한다 — 이 함수가 새로 추측하지 않는다. 호출부가 그 값을 모르면(예: RATE_LIMIT/TIMEOUT
 * 처럼 코드 자체가 이미 증거를 담고 있는 경우) 생략해도 된다.
 */
export function classifyGptErrorCode(code: GptErrorCode, evidenceBasedTransient?: boolean): FailureClassification {
  switch (code) {
    case "RATE_LIMIT":
      return { failureClass: "TRANSIENT", reason: "실제 rate-limit 응답 증거(classifyApiError) 기반." };
    case "TIMEOUT":
      return { failureClass: "TRANSIENT", reason: "일시적 연결/응답 지연(APIConnectionTimeoutError)." };
    case "GPT_REVIEW_TEMPORARILY_UNAVAILABLE":
      return { failureClass: "TRANSIENT", reason: "provider가 일시적으로 사용 불가함을 이미 명시적으로 신호." };
    case "AUTH_ERROR":
      return { failureClass: "PERMANENT", reason: "인증 실패(AuthenticationError) — 재시도로 해결되지 않음." };
    case "QUOTA_EXCEEDED":
      return { failureClass: "PERMANENT", reason: "insufficient_quota 명시적 증거(classifyApiError) — HTTP status만으로 추정한 것이 아님." };
    case "BUDGET_EXCEEDED":
      return { failureClass: "PERMANENT", reason: "SI-3.8A Budget Guard가 호출 자체를 사전 차단 — 재시도로 해결되지 않음(항상 transient=false로 설계됨)." };
    case "PROVIDER_SECURITY_BLOCKED":
      return { failureClass: "PERMANENT", reason: "Provider Security Gate 정책 차단 — 재시도로 해결되지 않음(항상 transient=false로 설계됨)." };
    case "ESCALATION_REVIEWER_UNAVAILABLE":
      return {
        failureClass: "PERMANENT",
        reason: "근본 원인은 transient였을 수 있으나(rate limit/timeout/일시적 장애), escalation이 반드시 필요한데 쓸 수 없다는 사실을 재시도에 묻지 않고 즉시 드러내기 위해 설계상 항상 transient=false로 처리됨.",
      };
    case "REVIEW_CONSISTENCY_CHECK_FAILED":
      return { failureClass: "DETERMINISTIC_LOCAL", reason: "payload 생성 시점과 decision 수신 시점 사이 working tree 변경을 결정론적으로 감지 — provider 재시도가 아니라 새 baseline으로 재리뷰가 필요." };
    case "INVALID_OUTPUT":
      return { failureClass: "UNKNOWN_TRANSIENTNESS", reason: "파싱 불가능한 응답 — 일시적 전송 손상인지 영구적 스키마 불일치인지 이 신호만으로 확정되지 않음." };
    case "API_ERROR":
      if (evidenceBasedTransient === true) {
        return { failureClass: "TRANSIENT", reason: "5xx 또는 연결 오류 — classifyApiError()의 실제 status/connection 증거 기반." };
      }
      return {
        failureClass: "UNKNOWN_TRANSIENTNESS",
        reason: "명확한 quota/auth/5xx 신호 없이 기타 API 오류로 분류됨 — status 코드만으로 permanent를 단정하지 않음(§ 429/413만으로 permanent 단정 금지 원칙).",
      };
  }
}
