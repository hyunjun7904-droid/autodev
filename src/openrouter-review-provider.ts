import type { ReviewProvider } from "./review-provider";
import type { ChatCompletionHttpFetch } from "./chat-completion-review-provider";
import { createChatCompletionReviewProvider, nodeChatCompletionHttpFetch } from "./chat-completion-review-provider";
import { OPENROUTER_PROVIDER_ID, resolveOpenRouterZdrVerification } from "./provider-pool-security-metadata";
import { OPENROUTER_API_KEY_ENV } from "./real-provider-pool";

// OpenRouter Review Provider Adapter — Phase SI-3.8F.
//
// OpenRouter의 OpenAI 호환 `/api/v1/chat/completions` endpoint(공식 문서,
// https://openrouter.ai/docs)를 chat-completion-review-provider.ts 공용 factory로 감싼다.
//
// 중요 — OpenRouter는 router다(§ .claude/CLAUDE.md 요구사항 6). 이 adapter 자신은 실제로 어떤
// downstream provider가 요청을 처리하는지 강제하지 않는다(호출자가 지정하는 "provider-prefixed"
// model 문자열, 예: "openai/gpt-..."에 달려있다). 이 adapter를 실제로 호출해도 되는지는
// provider-pool.ts의 evaluateProviderPoolSecurity()가 downstreamProviderIds 검증으로 별도로
// 판정한다 — 이 파일 자신은 Security Gate를 호출하지 않는다(Reviewer Core가 review() 호출
// 이전에 그 판정을 전담한다, § review-provider.ts 상단 주석과 동일한 경계 — provider 구현은
// 스스로 security를 판단하지 않는다).
//
// zdr 파라미터 — OpenRouter는 request body의 `provider.zdr: true`로 Zero Data Retention
// endpoint로만 라우팅을 강제할 수 있다(공식 문서, docs/guides/routing/provider-selection).
// AUTODEV_OPENROUTER_ZDR_VERIFIED=true로 이 배포가 검증됐다면(§
// provider-pool-security-metadata.ts) 이 adapter도 실제 요청에 그 파라미터를 함께 보내 "우리가
// zero retention을 검증했다고 주장하는 상태"와 "실제로 보내는 요청"이 어긋나지 않게 한다. 검증
// 안 된 배포는 파라미터를 조작해 안전을 가장하지 않고 그대로 둔다(metadata의
// retentionPolicy="unknown"이 이미 CONFIDENTIAL 이상 사용을 막는다).

export const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

interface OpenRouterChatBody {
  model: string;
  messages: { role: string; content: string }[];
  provider?: { zdr: true };
}

/** model은 OpenRouter의 "provider-prefixed" 모델 id(예: "openai/gpt-...")를 그대로 전달해야
 *  한다 — 이 파일은 임의 기본 모델을 하드코딩하지 않는다. */
export function createOpenRouterReviewProvider(
  model: string,
  httpFetch: ChatCompletionHttpFetch = nodeChatCompletionHttpFetch,
  env: NodeJS.ProcessEnv = process.env
): ReviewProvider {
  const zdr = resolveOpenRouterZdrVerification(env);
  const effectiveFetch: ChatCompletionHttpFetch = zdr.verified
    ? (req) => {
        const body = req.body as OpenRouterChatBody;
        return httpFetch({ ...req, body: { ...body, provider: { zdr: true } } });
      }
    : httpFetch;

  return createChatCompletionReviewProvider(
    { id: OPENROUTER_PROVIDER_ID, model, baseUrl: OPENROUTER_CHAT_COMPLETIONS_URL, apiKeyEnv: OPENROUTER_API_KEY_ENV },
    effectiveFetch,
    env
  );
}

/** review()가 실제로 보낸 body에 provider.zdr:true가 포함됐는지 테스트가 직접 확인할 수 있게
 *  하는 순수 타입 가드 — 프로덕션 코드에서는 쓰이지 않는다. */
export function bodyHasZdrTrue(body: unknown): boolean {
  const b = body as OpenRouterChatBody | undefined;
  return b?.provider?.zdr === true;
}
