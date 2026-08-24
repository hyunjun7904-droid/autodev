import type { ReviewProvider } from "./review-provider";
import type { ChatCompletionHttpFetch } from "./chat-completion-review-provider";
import { createChatCompletionReviewProvider, nodeChatCompletionHttpFetch } from "./chat-completion-review-provider";
import { GROQ_PROVIDER_ID } from "./provider-pool-security-metadata";
import { GROQ_API_KEY_ENV } from "./real-provider-pool";

// Groq Review Provider Adapter — Phase SI-3.8F.
//
// GroqCloud의 OpenAI 호환 `/openai/v1/chat/completions` endpoint(공식 문서,
// https://console.groq.com/docs)를 chat-completion-review-provider.ts(SI-3.8F 공용 factory)로
// 감싼다. production auto-routing/hidden fallback을 만들지 않는다 — 이 provider를 실제로 언제
// 쓸지는 이 파일의 책임이 아니다(§ 요구사항 12, 자동 선택은 SI-3.8G).
//
// model은 이 Task에서 특정 모델 id를 확정하지 않는다(§ real-provider-pool.ts groqEntry의
// modelMetadata.notes — 모델별 free tier 한도가 다르다) — 호출자가 실제로 쓸 모델을 지정해야
// 하므로 이 파일은 model을 인자로 받는 factory만 제공하고, 임의 기본 모델 id를 하드코딩하지
// 않는다.

export const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";

export function createGroqReviewProvider(
  model: string,
  httpFetch: ChatCompletionHttpFetch = nodeChatCompletionHttpFetch,
  env: NodeJS.ProcessEnv = process.env
): ReviewProvider {
  return createChatCompletionReviewProvider(
    { id: GROQ_PROVIDER_ID, model, baseUrl: GROQ_CHAT_COMPLETIONS_URL, apiKeyEnv: GROQ_API_KEY_ENV },
    httpFetch,
    env
  );
}
