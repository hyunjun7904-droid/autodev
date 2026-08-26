import type { ReviewProvider } from "./review-provider";
import type { ChatCompletionHttpFetch } from "./chat-completion-review-provider";
import { createChatCompletionReviewProvider, nodeChatCompletionHttpFetch } from "./chat-completion-review-provider";
import { FIREWORKS_PROVIDER_ID, resolveFireworksZdrVerification } from "./provider-pool-security-metadata";
import { log } from "./logger";

// Fireworks Review Provider Adapter — Fireworks GPT-OSS-120B Final Reviewer Qualification.
//
// Fireworks Direct의 OpenAI 호환 `/inference/v1/chat/completions` endpoint(공식 문서,
// https://docs.fireworks.ai/api-reference/post-chatcompletions, 2026-08-26 확인)를
// chat-completion-review-provider.ts(Groq/OpenRouter/NVIDIA/Cloudflare(qualification-only)와
// 동일한 공용 factory)로 감싼다 — 이 파일은 그 factory를 전혀 수정하지 않고 config만 다르게
// 조립한다(로직 복제 없음). production auto-routing/hidden fallback 없음 — 이 provider 하나는
// 정확히 하나의 고정 model/endpoint만 호출한다. production Final Reviewer(Groq
// openai/gpt-oss-120b) wiring은 이 파일과 무관하며, 이 Task는 그 wiring을 변경하지 않는다.
//
// Responses API가 아닌 Chat Completions API만 사용한다(§ 공식
// https://docs.fireworks.ai/guides/security_compliance/data_handling, 2026-08-26 확인:
// "Fireworks does not log or store prompt or generation data for any open models, without
// explicit user opt-in." / "Prompt and generation data exist only in volatile memory for the
// duration of the request." — 이 zero-retention 기본값은 Response API의 별도 30일 보존 정책과
// 명시적으로 구분된다. 이 파일은 baseUrl을 `/inference/v1/chat/completions`로 고정해 Response
// API 경로를 아예 호출하지 않는다).
//
// STEP 1 SECURITY GATE(실용형 보안 정책, § .claude/CLAUDE.md Final Reviewer Routing) —
// AUTODEV_FIREWORKS_ZDR_VERIFIED는 더 이상 이 provider 호출 자체의 필수 자격조건이 아니다.
// 위 공식 정책이 이미 기본값으로 zero-retention이므로(Groq처럼 self-serve 설정을 별도로 켜야
// 하는 조건부 정책이 아님), 이 배포가 opt-in 로깅 기능을 켜지 않았다는 독립 검증이 없어도 실제
// HTTP 요청은 정상적으로 진행한다 — ZDR verified 여부는 이제 이 provider 자신이 아니라
// final-reviewer-provider-selection.ts가 Provider Security Gate에 전달하는 data
// classification(verified=CONFIDENTIAL, unverified=INTERNAL — review-provider.ts
// ReviewProvider.reviewerDataClassification)에만 반영된다("가산점"이지 gate가 아니다). API
// key 자체가 없으면(전혀 다른 문제 — 인증 자체가 불가능) createChatCompletionReviewProvider()가
// 여전히 fail-closed로 즉시 거부한다 — 이 완화는 그 검사를 전혀 건드리지 않는다.

export const FIREWORKS_API_KEY_ENV = "FIREWORKS_API_KEY";
export const FIREWORKS_CHAT_COMPLETIONS_URL = "https://api.fireworks.ai/inference/v1/chat/completions";

// 공식 모델 문서/블로그(https://docs.fireworks.ai/guides/reasoning, 2026-08-26 확인): gpt-oss
// 계열은 reasoning 모델이라 최종 답변 이전에 hidden reasoning 토큰을 함께 생성하며, "max_tokens
// should be set high enough to leave room for both otherwise the response can be truncated to
// empty output"이라고 공식 문서가 직접 경고한다. Cloudflare Workers AI qualification(동일
// gpt-oss-120b 모델, 다른 host)에서 기본 256 한도로 인해 review JSON이 finish_reason="length"로
// 잘리는 문제를 실제로 겪었다(§ 그 qualification의 실패 원인 기록) — Fireworks의 기본 출력
// 한도(공식 문서: max_tokens 미지정 시 하드 리밋 없이 context window까지 생성 가능하지만, 명시적
// 설정이 "권장됨")에 의존하지 않고, 그 qualification과 동등한 여유(4096)를 이 모델 호출에만
// 국한해 명시한다. chat-completion-review-provider.ts의 extraBody(순수 추가 필드, Groq/
// OpenRouter/NVIDIA는 쓰지 않아 동작 변화 없음)를 그대로 재사용한다 — 모델을 유리하게 만들
// 목적의 prompt/evaluator 변경은 아니다(출력 공간만 확보할 뿐 판정 기준과 무관).
const FIREWORKS_MAX_TOKENS = 4096;

export function createFireworksReviewProvider(
  model: string,
  httpFetch: ChatCompletionHttpFetch = nodeChatCompletionHttpFetch,
  env: NodeJS.ProcessEnv = process.env
): ReviewProvider {
  if (!resolveFireworksZdrVerification(env).verified) {
    log(
      "Fireworks ZDR가 이 배포에서 독립적으로 검증되지 않았습니다 — 실용형 보안 정책에 따라 호출은 계속 진행합니다(요청 데이터 등급이 CONFIDENTIAL 대신 INTERNAL로 처리됨, § final-reviewer-provider-selection.ts)."
    );
  }
  return createChatCompletionReviewProvider(
    {
      id: FIREWORKS_PROVIDER_ID,
      model,
      baseUrl: FIREWORKS_CHAT_COMPLETIONS_URL,
      apiKeyEnv: FIREWORKS_API_KEY_ENV,
      extraBody: { max_tokens: FIREWORKS_MAX_TOKENS },
    },
    httpFetch,
    env
  );
}
