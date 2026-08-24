import OpenAI from "openai";
import { AuthenticationError, RateLimitError, APIConnectionTimeoutError, APIConnectionError, APIError } from "openai";
import type { GptErrorCode } from "./types";
import type { ReviewProvider, ReviewProviderRequest, ReviewProviderResult } from "./review-provider";

// OpenAI Review Provider — Phase SI-3.8E.
//
// gpt-reviewer.ts가 직접 갖고 있던 OpenAI Responses API transport(client 생성/구조화 출력
// 요청/재시도 판단을 위한 오류 분류)를 ReviewProvider 뒤로 그대로 옮긴 것이다 — model/
// timeout/구조화 출력 schema/재시도 판단 semantics 전부 SI-3.8D 시점과 완전히 동일하다(이번
// Task는 Reviewer 품질을 바꾸지 않는다). system instructions/review payload 조립(prompt)은
// 여전히 gpt-reviewer.ts(Reviewer Core)의 책임이다 — 이 파일은 "이미 조립된 instructions+
// input을 실제로 어떻게 전송하는가"만 담당한다.

export const OPENAI_REVIEW_PROVIDER_ID = "openai";

// 기존 gpt-reviewer.ts MODEL 상수를 그대로 옮김 — 값 변경 없음.
const MODEL = "gpt-5.6";

// 기존 gpt-reviewer.ts RESULT_SCHEMA를 그대로 옮김 — 값 변경 없음(§ 요구사항: schema unchanged).
const RESULT_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["PASS", "REVISE", "HUMAN_REQUIRED", "BLOCK"] },
    severity: {
      type: "object",
      properties: {
        critical: { type: "integer" },
        high: { type: "integer" },
        medium: { type: "integer" },
      },
      required: ["critical", "high", "medium"],
      additionalProperties: false,
    },
    feedback: { type: "string" },
    nextTask: { type: ["string", "null"] },
  },
  required: ["decision", "severity", "feedback", "nextTask"],
  additionalProperties: false,
} as const;

/** 테스트/parity 검증 전용 export — RESULT_SCHEMA 원문이 SI-3.8D 시점과 동일한지 스냅샷
 *  비교하기 위함이다(review-provider-tests.ts). Reviewer Core는 이 값을 참조하지 않는다
 *  (JSON.parse만 수행 — § review-provider.ts 상단 주석). */
export const OPENAI_REVIEW_RESULT_SCHEMA = RESULT_SCHEMA;

// 30초는 실제로 너무 짧다는 것이 SI-3.8 이전에 이미 확인됐다 — 구조화 출력(json_schema)으로
// diff를 검토하는 실제 호출이 정상적으로도 30초를 종종 넘긴다. SDK 자체 재시도(maxRetries)는
// 여전히 0으로 유지하고 재시도는 gpt-reviewer.ts의 reviewClaudeResultWithRetry가 전담한다.
//
// lazy initialization — OPENAI_API_KEY가 없으면 "실제 API를 전혀 호출하지 않는" fake/injected
// reviewer 테스트조차 이 파일을 import하는 순간 실패하지 않도록, 실제로 API를 호출하는
// 시점(getClient() 최초 호출)에만 client를 생성한다. 키 값은 여기서도 절대 읽거나 로그로
// 남기지 않는다 — SDK가 process.env에서 자동으로 읽을 뿐이다.
let cachedClient: OpenAI | null = null;
function getClient(): OpenAI {
  if (!cachedClient) cachedClient = new OpenAI({ timeout: 120_000, maxRetries: 0 });
  return cachedClient;
}

// transient=true: 같은 입력으로 다시 시도하면 성공할 가능성이 있는 오류(네트워크/일시적
// 서버 문제). transient=false: 재시도로 해결되지 않는 오류(인증/쿼터/잘못된 응답 형식).
function classifyApiError(e: unknown): { code: GptErrorCode; transient: boolean } {
  if (e instanceof AuthenticationError) return { code: "AUTH_ERROR", transient: false };
  if (e instanceof RateLimitError) {
    if (e.code === "insufficient_quota") return { code: "QUOTA_EXCEEDED", transient: false };
    return { code: "RATE_LIMIT", transient: true };
  }
  if (e instanceof APIConnectionTimeoutError) return { code: "TIMEOUT", transient: true };
  if (e instanceof APIConnectionError) return { code: "API_ERROR", transient: true }; // 네트워크 연결 오류
  if (e instanceof APIError) {
    const status = e.status;
    return { code: "API_ERROR", transient: typeof status === "number" && status >= 500 };
  }
  return { code: "API_ERROR", transient: false };
}

/**
 * 실제 OpenAI Responses API를 정확히 1회 호출하는 ReviewProvider 구현. Reviewer Core(§
 * gpt-reviewer.ts reviewClaudeResultOnce)가 이 provider의 review()를 정확히 한 번 호출하고,
 * 그 결과(ok:true/false)를 그대로 해석한다 — 이 함수 자신은 budget/security preflight나
 * retry를 전혀 알지 못한다(Core가 review() 호출 이전/이후에서 전담한다).
 *
 * client 생성 실패(예: 자격증명 누락 — OpenAI SDK가 네트워크 요청 전에 동기적으로 throw)와
 * 실제로 전송된 요청의 실패를 requestAttempted로 구분한다(§ review-provider.ts
 * ReviewProviderFailure.requestAttempted 주석) — 이 구분이 있어야 Usage Ledger의
 * requestCount가 실제로 나가지 않은 요청까지 세지 않는다.
 */
export function createOpenAIReviewProvider(): ReviewProvider {
  return {
    id: OPENAI_REVIEW_PROVIDER_ID,
    model: MODEL,
    async review(request: ReviewProviderRequest): Promise<ReviewProviderResult> {
      let client: OpenAI;
      try {
        client = getClient();
      } catch (e) {
        const { code: errorCode } = classifyApiError(e);
        return { ok: false, errorCode, transient: false, requestAttempted: false };
      }

      try {
        const response = await client.responses.create({
          model: MODEL,
          instructions: request.instructions,
          input: request.input,
          text: {
            format: {
              type: "json_schema",
              name: "gpt_review_result",
              schema: RESULT_SCHEMA,
              strict: true,
            },
          },
        });

        const model = response.model ? { provider: OPENAI_REVIEW_PROVIDER_ID, name: response.model } : undefined;
        const tokenUsage = response.usage
          ? {
              inputTokens: response.usage.input_tokens,
              cachedInputTokens: response.usage.input_tokens_details?.cached_tokens,
              outputTokens: response.usage.output_tokens,
              totalTokens: response.usage.total_tokens,
            }
          : undefined;

        return { ok: true, outputText: response.output_text, model, tokenUsage };
      } catch (e) {
        const { code: errorCode, transient } = classifyApiError(e);
        return { ok: false, errorCode, transient, requestAttempted: true };
      }
    },
  };
}

// production default — 이 파일을 import하는 시점에 OpenAI client(new OpenAI())를 생성하지
// 않는다(createOpenAIReviewProvider()는 { id, model, review } 객체만 만들 뿐, 실제 client는
// review() 호출이 실제로 client가 필요한 시점(getClient())에만 lazy하게 생성된다 — 기존
// gpt-reviewer.ts의 lazy init 보장을 그대로 유지한다).
export const openAIReviewProvider: ReviewProvider = createOpenAIReviewProvider();
