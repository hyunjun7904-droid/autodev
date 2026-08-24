import type { GptErrorCode } from "./types";
import type { DataClassification } from "./provider-security-gate";

// Reviewer Provider Abstraction — Phase SI-3.8E.
//
// Reviewer Core(gpt-reviewer.ts)가 실제 AI review provider의 SDK/transport를 몰라도 동작할
// 수 있게 하는 최소 contract다. 이번 Task는 이 contract 뒤로 기존 OpenAI reviewer의 동작을
// "그대로" 옮기는 것이 목적이지, provider를 추가/선택/routing하는 것이 목적이 아니다(§
// openai-review-provider.ts 상단 주석). 이 인터페이스는 OpenAI
// SDK의 타입(OpenAI, APIError 등)을 전혀 import하지 않는다 — 어떤 provider 구현이든 이 순수
// 데이터 계약만 만족하면 Reviewer Core가 그대로 소비할 수 있다.
//
// budget/security preflight(gpt-budget-guard.ts/provider-security-gate.ts)는 이 인터페이스
// 밖(Reviewer Core, review() 호출 이전)에서 이뤄진다 — provider 구현은 스스로 budget/security를
// 판단하지 않고, Core가 이미 통과시킨 요청만 받는다. "invalid structured output" 판정(JSON
// 파싱)도 Core의 단일 책임으로 유지한다 — provider는 원문 텍스트(outputText)만 돌려줄 뿐,
// 그 파싱/검증 로직을 provider별로 분산시키지 않는다(어떤 provider를 쓰든 동일한 파싱 규칙이
// 적용되게 하기 위함).
//
// SI-3.8E Security Ordering Correction — AutoDev Reviewer가 외부 provider로 보내는 실제 요청
// 내용(task text/project rules/source diff/code context)은 provider가 무엇이든 항상 동일한
// 기본 데이터 등급을 갖는다. PUBLIC은 프로젝트/정책에서 명시적으로 PUBLIC이라고 확정된
// 경우에만 허용할 미래 확장 seam으로 남겨두고(이번 Task는 그 project-policy 연동을 구현하지
// 않는다), 그런 확정이 없는 한 항상 CONFIDENTIAL로 취급한다 — provider security 판정을
// 낙관적으로 완화하지 않는다.
export const DEFAULT_REVIEWER_DATA_CLASSIFICATION: DataClassification = "CONFIDENTIAL";

/** 실제 API 응답이 echo한 provider/model 식별자 — 요청 시 지정한 값이 아니라 실제로 응답한
 *  값만 담는다(§ gpt-reviewer.ts 기존 GptReviewApiResult.model 주석과 동일한 원칙). */
export interface ReviewProviderModelIdentity {
  provider: string;
  name: string;
}

/** provider가 실제로 보고한 token usage — 추정/가격 환산 없이 그대로 옮긴 값만 담는다. */
export interface ReviewProviderTokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ReviewProviderRequest {
  /** system instructions — provider별 system/instructions 필드에 그대로 전달된다. Reviewer
   *  Core(buildSystemInstructions)가 조립하며, provider는 이 내용을 해석하지 않는다. */
  instructions: string;
  /** review 대상 payload(task/diff/rules 등을 조립한 최종 입력 텍스트, buildReviewInput). */
  input: string;
}

export interface ReviewProviderSuccess {
  ok: true;
  /** provider가 반환한 원문 텍스트 — Reviewer Core가 GptReviewResult로 JSON.parse한다. */
  outputText: string;
  /** 응답이 실제로 echo한 model을 확인하지 못했으면(예: 응답 필드가 비어있음) undefined다 —
   *  요청 시 지정한 model로 추측해서 채우지 않는다(기존 gpt-reviewer.ts 동작과 동일). */
  model?: ReviewProviderModelIdentity;
  tokenUsage?: ReviewProviderTokenUsage;
}

export interface ReviewProviderFailure {
  ok: false;
  errorCode: GptErrorCode;
  /** 같은 입력으로 다시 시도하면 성공할 가능성이 있는 오류인지 — Reviewer Core의 retry
   *  wrapper(reviewClaudeResultWithRetry)가 이 값만으로 재시도 여부를 결정한다(로직 자체는
   *  변경하지 않는다). */
  transient: boolean;
  /** false면 실제 네트워크 요청이 전혀 나가지 않은 채 실패했다는 뜻이다(예: 자격증명 누락으로
   *  클라이언트 생성 자체가 동기적으로 실패). Usage Ledger의 requestCount 계산이 이 값을
   *  기준으로 실제 API 사용량과 로컬 preflight 실패를 구분한다(§ gpt-reviewer.ts
   *  buildGptReviewLedgerEntryInput, 변경 없음). */
  requestAttempted: boolean;
}

export type ReviewProviderResult = ReviewProviderSuccess | ReviewProviderFailure;

/**
 * Reviewer Core가 실제 AI review transport를 호출하기 위해 알아야 하는 유일한 contract다.
 * 이 인터페이스를 만족하는 어떤 구현(fake 포함)도 reviewClaudeResultOnce()에 주입할 수 있다
 * (§ ReviewRetryOptions.provider / reviewClaudeResultOnce 마지막 인자) — production 기본값은
 * 여전히 OpenAIReviewProvider 하나뿐이다(이번 Task는 provider 선택/routing을 구현하지 않는다).
 */
export interface ReviewProvider {
  /** provider 식별자(예: "openai") — Usage Ledger의 provider 필드, 그리고 향후(이번 Task
   *  범위 밖) Provider Security Gate(evaluateProviderSecurity)의 providerId 조회에 쓰일 수
   *  있는 안정적인 값이다. */
  readonly id: string;
  /** 실제 호출에 요청되는 model 식별자(고정값) — 실제 응답이 echo한 model은
   *  ReviewProviderSuccess.model에 별도로 담긴다(둘이 다를 수 있음을 구분하기 위함). */
  readonly model: string;
  review(request: ReviewProviderRequest): Promise<ReviewProviderResult>;
}
