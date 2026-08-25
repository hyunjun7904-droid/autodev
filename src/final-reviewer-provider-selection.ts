import type { ReviewProvider, ReviewProviderRequest, ReviewProviderResult } from "./review-provider";
import type { ProviderSecurityRegistry } from "./provider-security-gate";
import type { ChatCompletionHttpFetch } from "./chat-completion-review-provider";
import { createGroqReviewProvider } from "./groq-review-provider";
import { GROQ_PROVIDER_ID, buildGroqProviderSecurityMetadata } from "./provider-pool-security-metadata";
import { OPENAI_REVIEW_RESULT_SCHEMA } from "./openai-review-provider";

// Production Final Reviewer Provider Selection — AutoDev Production Final Reviewer Wiring
// Task.
//
// gpt-reviewer.ts(Reviewer Core)의 reviewClaudeResultOnce()가 provider/securityGateOverrides
// 인자를 생략했을 때(production 경로 — orchestrator.ts/agent-orchestrator.ts는 항상 생략한다,
// § 그 두 파일의 selectDefaultGptReviewer/selectDefaultReviewerRunner) 쓰는 production 기본값
// 하나만 이 파일이 결정한다. 실제 provider transport(chat-completion-review-provider.ts 공용
// factory)/Security Gate 판정(provider-security-gate.ts)/qualification corpus/evaluator는 전혀
// 새로 만들지 않는다 — final-reviewer-benchmark-groq.ts(Groq openai/gpt-oss-120b, 4/4
// QUALIFIED, CRITICAL_MISSED=0, HIGH_MISSED=0)가 검증한 것과 정확히 동일한 provider factory
// (groq-review-provider.ts createGroqReviewProvider)와 동일한 Security metadata 함수
// (provider-pool-security-metadata.ts buildGroqProviderSecurityMetadata)를 그대로 재사용한다.
//
// Fail-closed는 이 파일이 새로 구현하지 않는다 — 기존 두 Core 게이트를 그대로 통과시킬 뿐이다:
//   - GROQ_API_KEY 누락 → createChatCompletionReviewProvider()의 review()가 실제 HTTP 요청을
//     보내기 전에 즉시 { ok:false, errorCode:"AUTH_ERROR", requestAttempted:false }를 반환한다
//     (chat-completion-review-provider.ts, 이 파일과 무관하게 이미 존재하는 동작).
//   - AUTODEV_GROQ_ZDR_VERIFIED !== "true" → buildGroqProviderSecurityMetadata()가
//     retentionPolicy="bounded"(30일)를 반환하고, provider-security-gate.ts의 기존 Core hard
//     rule(CONFIDENTIAL 이상은 zero retention만 인정)이 provider.review()를 호출하기 전에
//     PROVIDER_SECURITY_BLOCKED로 BLOCK한다.
// 두 조건 중 하나라도 미충족이면 Reviewer Core는 HUMAN_REQUIRED를 반환할 뿐 다른 provider(OpenAI/
// Ollama/OpenRouter/NVIDIA)로 자동 전환하지 않는다 — 이 파일은 그 provider들의 ReviewProvider
// factory(createOpenAIReviewProvider/openAIReviewProvider, ollama-review-provider.ts 등)를 아예
// import하지 않는다(참조 자체가 없으므로 silent fallback 경로가 구조적으로 없다). 유일한 예외는
// openai-review-provider.ts가 export하는 OPENAI_REVIEW_RESULT_SCHEMA 상수 하나뿐이다(아래 §
// GROQ_OUTPUT_FORMAT_DIRECTIVE) — 이 값은 그 파일 자신의 주석이 "다른 provider가 동일한 구조화
// 출력 schema를 강제할 때도 그대로 가져다 쓴다"고 명시한 순수 데이터 상수이지 OpenAI provider
// 자체가 아니다.
//
// Qualification(final-reviewer-benchmark-groq.ts)과 production 경로는 서로를 import하지 않는다
// — benchmark 스크립트는 이 파일을 쓰지 않고 createGroqReviewProvider를 직접 호출하며, 이 파일도
// benchmark corpus/evaluator를 전혀 참조하지 않는다.

/** qualification을 통과한 모델 — final-reviewer-benchmark-groq.ts의 QUALIFIED_MODEL 기본값과
 *  정확히 동일한 문자열이다(값 복제이지 로직 복제가 아니다 — 두 파일이 이 상수를 공유하는
 *  import를 두지 않는 이유는 qualification 스크립트가 production 코드에 의존해서는 안 되기
 *  때문이다, § gpt-reviewer.ts 상단 "runtime production path가 benchmark 코드를 실행하면
 *  안 된다"). 이 값을 바꾸는 것은 곧 "어떤 모델을 production Final Reviewer로 쓸지" 자체를
 *  바꾸는 것이므로, 새 qualification 없이 이 값을 바꾸지 않는다. */
export const FINAL_REVIEWER_PRODUCTION_MODEL = "openai/gpt-oss-120b";

/** production Final Reviewer provider id — Groq(direct-external)와 동일하다. */
export const FINAL_REVIEWER_PRODUCTION_PROVIDER_ID = GROQ_PROVIDER_ID;

// STEP 5(REAL GROQ END-TO-END SMOKE) 실행 중 실제로 발견된 문제 — chat-completion-review-provider.ts
// (Groq/OpenRouter/NVIDIA 공용)는 OpenAI Responses API의 구조화 출력(json_schema strict 모드)과
// 달리 response_format을 전송하지 않는다(§ 그 파일 상단 주석 — 이 Task가 그 공용 factory를
// 수정하지 않는다). gpt-reviewer.ts의 production system instructions(buildSystemInstructions())는
// 어떤 provider에도 동일하게 중립적이라 명시적 JSON 출력 지시를 포함하지 않는데, 이 지시 없이
// production instructions만으로 실제 호출해보면 gpt-oss-120b는 markdown 산문 리뷰를 반환해
// Core의 JSON.parse(outputText)가 INVALID_OUTPUT으로 실패한다(직접 확인함). qualification
// (final-reviewer-benchmark-groq.ts buildGroqInstructions())은 정확히 이 문제를 "출력 형식(필수)"
// 지시 + OPENAI_REVIEW_RESULT_SCHEMA를 system instructions 끝에 추가해서 우회했고, 그 결과
// PARSE_FAILURES=0으로 qualification을 통과했다 — 즉 "qualification을 통과한 설정"은 모델
// 하나가 아니라 [모델 + 이 출력 형식 지시]의 조합이다. 이 파일도 production에 그 조합을 그대로
// 옮긴다(모델만 옮기고 지시를 빠뜨리면 qualification이 실제로 검증한 조건과 달라진다).
//
// 이 지시는 Core의 JSON 파싱/검증 책임을 침범하지 않는다 — review-provider.ts의 원칙("invalid
// structured output 판정은 Core의 단일 책임")을 그대로 지킨다: 이 wrapper는 request.instructions
// 문자열에 고정 텍스트를 추가해 그대로 전달할 뿐, provider가 반환한 outputText를 스스로
// JSON.parse하거나 그 유효성을 판단하지 않는다(성공/실패 결과를 그대로 통과시킨다) — 어떤 것이
// "유효한 review"인지 판단하는 것은 여전히 gpt-reviewer.ts뿐이다. benchmark 스크립트의
// 텍스트/스키마 상수를 import하지 않는다(qualification과 production은 서로를 참조하지 않는다,
// § 파일 상단 주석) — 대신 두 파일이 이미 공유하도록 export된 OPENAI_REVIEW_RESULT_SCHEMA(§
// openai-review-provider.ts, "다른 provider가 동일한 구조화 출력 schema를 강제할 때도 이 값을
// 그대로 가져다 쓴다"고 명시된 값)만 재사용하고, 지시 문구 자체는 qualification이 검증한 것과
// 동일한 문구를 이 파일에 직접 유지한다(qualification 스크립트를 production이 import하지 않기
// 위한 값 복제 — § FINAL_REVIEWER_PRODUCTION_MODEL과 동일한 원칙).
const GROQ_OUTPUT_FORMAT_DIRECTIVE = `

# 출력 형식(필수)
설명, 서론, markdown 코드펜스 없이 아래 JSON Schema를 정확히 만족하는 JSON 객체 "하나만"
출력하세요:
${JSON.stringify(OPENAI_REVIEW_RESULT_SCHEMA)}`;

function withGroqOutputFormatDirective(inner: ReviewProvider): ReviewProvider {
  return {
    id: inner.id,
    model: inner.model,
    async review(request: ReviewProviderRequest): Promise<ReviewProviderResult> {
      return inner.review({ instructions: request.instructions + GROQ_OUTPUT_FORMAT_DIRECTIVE, input: request.input });
    },
  };
}

/**
 * production Final Reviewer ReviewProvider를 만든다. httpFetch를 지정하지 않으면
 * createGroqReviewProvider()의 기본값(nodeChatCompletionHttpFetch, 실제 네트워크)을 그대로
 * 쓴다 — 이 파라미터는 오직 테스트가 실제 네트워크 없이 이 selection 자체(모델/provider id가
 * 정확한지, GROQ_API_KEY/ZDR 조건이 그대로 적용되는지, 출력 형식 지시가 실제로 요청에
 * 포함되는지)를 검증하기 위한 주입 지점이다(§ chat-completion-review-provider.ts
 * ChatCompletionHttpFetch와 동일한 설계 원칙 — 실제 운용 기본값을 바꾸지 않는다).
 */
export function createFinalReviewerProductionProvider(
  env: NodeJS.ProcessEnv = process.env,
  httpFetch?: ChatCompletionHttpFetch
): ReviewProvider {
  return withGroqOutputFormatDirective(createGroqReviewProvider(FINAL_REVIEWER_PRODUCTION_MODEL, httpFetch, env));
}

/** gpt-reviewer.ts의 Provider Security Gate 호출에 그대로 쓰이는 registry — Groq 하나만 안다
 *  (openai-provider-security-metadata.ts resolveOpenAiProviderSecurityRegistry와 동일한 패턴).
 *  등록되지 않은 provider(예: 테스트 fake provider)는 이 registry에 없으므로
 *  evaluateProviderSecurity()가 PROVIDER_UNKNOWN으로 BLOCK한다 — 알 수 없는 provider를 자동
 *  allow하지 않는다. */
export function resolveFinalReviewerProductionSecurityRegistry(env: NodeJS.ProcessEnv = process.env): ProviderSecurityRegistry {
  const metadata = buildGroqProviderSecurityMetadata(env);
  return { [metadata.providerId]: metadata };
}

// production default — 이 파일을 import하는 시점에 실제 네트워크 요청/자격증명 읽기를 하지
// 않는다(createGroqReviewProvider()도 { id, model, review } 객체만 만들 뿐, 실제 GROQ_API_KEY는
// review() 호출이 실제로 필요한 시점에만 env에서 읽는다 — § openai-review-provider.ts
// openAIReviewProvider와 동일한 lazy 보장).
export const finalReviewerProductionProvider: ReviewProvider = createFinalReviewerProductionProvider();
