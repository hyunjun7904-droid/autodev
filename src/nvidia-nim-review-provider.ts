import type { ReviewProvider } from "./review-provider";
import type { ChatCompletionHttpFetch } from "./chat-completion-review-provider";
import { createChatCompletionReviewProvider, nodeChatCompletionHttpFetch } from "./chat-completion-review-provider";
import { NVIDIA_NIM_PROVIDER_ID } from "./provider-pool-security-metadata";
import { NVIDIA_NIM_API_KEY_ENV } from "./real-provider-pool";

// NVIDIA NIM(build.nvidia.com API Catalog) Review Provider Adapter — Phase SI-3.8F.
//
// build.nvidia.com API Catalog의 OpenAI 호환 `/v1/chat/completions` endpoint(공식 문서,
// https://docs.api.nvidia.com/nim/docs/api-quickstart)를 chat-completion-review-provider.ts
// 공용 factory로 감싼다 — transport 구현 자체는 완전하고 mockable하다(§ 요구사항 8 "필요한
// Provider adapter를 만들 수 있으나...").
//
// 이 provider는 catalog(real-provider-pool.ts)에서 approvalStatus="POLICY_UNKNOWN"으로
// 등록되어 있다 — training/retention 정책을 신뢰할 수 있는 1차 문서로 확인하지 못했기
// 때문이다(§ provider-pool-security-metadata.ts buildNvidiaNimProviderSecurityMetadata 상단
// 주석). 이 adapter가 존재한다는 사실 자체가 실제 사용을 승인하지 않는다 —
// evaluateProviderPoolSecurity()/evaluateProviderSecurity()가 이 provider id에 대해 항상
// BLOCK을 반환하므로, Reviewer Core 경로로는 이 provider의 review()가 호출될 수 없다(Provider
// Security Gate가 review() 호출 이전에 막는다, § review-provider.ts 상단 주석과 동일한 경계).

export const NVIDIA_NIM_CHAT_COMPLETIONS_URL = "https://integrate.api.nvidia.com/v1/chat/completions";

export function createNvidiaNimReviewProvider(
  model: string,
  httpFetch: ChatCompletionHttpFetch = nodeChatCompletionHttpFetch,
  env: NodeJS.ProcessEnv = process.env
): ReviewProvider {
  return createChatCompletionReviewProvider(
    { id: NVIDIA_NIM_PROVIDER_ID, model, baseUrl: NVIDIA_NIM_CHAT_COMPLETIONS_URL, apiKeyEnv: NVIDIA_NIM_API_KEY_ENV },
    httpFetch,
    env
  );
}
