import type { GptErrorCode } from "./types";
import type { ReviewProvider, ReviewProviderRequest, ReviewProviderResult, ReviewProviderModelIdentity, ReviewProviderTokenUsage } from "./review-provider";

// Generic OpenAI-compatible Chat Completion ReviewProvider Adapter — Phase SI-3.8F.
//
// Groq/OpenRouter/NVIDIA NIM은 모두 OpenAI 호환 `/chat/completions` 요청/응답 형태를 제공한다
// (공식 문서 기준) — 그래서 source-adapter.ts(D3)가 "MCP/공식 API/SDK/CLI 후보 전부 같은 JSON
// 스키마이므로 벤더별 adapter를 여럿 만들지 않는다"고 한 것과 동일한 원칙으로, 벤더별 별도
// transport 구현을 세 번 만들지 않고 이 하나의 factory(config만 다름)를 재사용한다.
//
// review-provider.ts의 설계를 그대로 따른다 — 이 factory는 review 요청/응답 payload(JSON
// schema)를 스스로 해석/검증하지 않는다. provider가 반환하는 것은 원문 텍스트(outputText)뿐이고,
// 그 파싱/검증은 여전히 Reviewer Core(gpt-reviewer.ts)의 단일 책임으로 남는다.
//
// Secret 처리 — API key는 오직 "환경변수 이름"(ChatCompletionProviderConfig.apiKeyEnv)으로만
// 설정에 담긴다. 실제 키 값은 review() 호출 시점에 env에서 딱 한 번 읽어 요청 header 조립에만
// 쓰고, 어떤 필드/로그/에러 메시지에도 남기지 않는다(§ 요구사항 9 "Secret 값 저장/로그 금지").
//
// production auto-routing/hidden fallback 없음 — 이 factory가 만든 ReviewProvider 하나는
// 정확히 하나의 고정 endpoint/model만 호출한다. 실패해도 다른 provider로 자동 전환하지 않는다
// (§ 요구사항 8).

export interface ChatCompletionHttpRequest {
  url: string;
  apiKey: string;
  body: unknown;
  timeoutMs: number;
}

export interface ChatCompletionHttpSuccess {
  status: number;
  bodyText: string;
}

/** transient: 재시도로 해결될 가능성이 있는 실패(429/5xx/timeout/네트워크 오류)인지 — Reviewer
 *  Core의 재시도 판단(review-provider.ts ReviewProviderFailure.transient)에 그대로 쓰인다.
 *  rateLimitHeaders: Final Reviewer Routing(Fireworks Primary / Groq Escalation)이 429 진단
 *  표시(GROQ_STATUS=RATE_LIMITED 등)를 만들 때만 쓴다 — RATE_LIMIT_RESPONSE_HEADER_ALLOWLIST에
 *  있는 header만 담기므로 Authorization 등 credential이 섞일 경로가 구조적으로 없다. */
export type ChatCompletionHttpOutcome =
  | { ok: true; response: ChatCompletionHttpSuccess }
  | { ok: false; reason: string; transient: boolean; status?: number; rateLimitHeaders?: Record<string, string> };

/** 실제 네트워크 호출은 이 함수 타입 뒤로 격리된다 — 모든 테스트는 이 함수를 fake로 주입해
 *  네트워크 없이 deterministic하게 검증한다(§ 요구사항 "실제 network request test 금지",
 *  "fake provider actual network call 0"). apiKey는 호출자가 이미 env에서 읽어온 값을 그대로
 *  전달할 뿐, 이 함수 자신은 env를 읽지 않는다. */
export type ChatCompletionHttpFetch = (req: ChatCompletionHttpRequest) => Promise<ChatCompletionHttpOutcome>;

const CHAT_COMPLETION_MAX_BODY_BYTES = 10 * 1024 * 1024;

// Final Reviewer Routing(Fireworks Primary / Groq Escalation) — Groq 429/quota 진단 표시(§
// GROQ_STATUS/GROQ_REASON) 요구사항. secret이 담긴 header(authorization 등)는 이 목록에 절대
// 추가하지 않는다 — 이 고정 allow-list 밖 header는 어떤 이유로도 읽어서 옮기지 않는다.
const RATE_LIMIT_RESPONSE_HEADER_ALLOWLIST = [
  "retry-after",
  "x-ratelimit-limit-requests",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-reset-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-tokens",
];

function captureRateLimitHeaders(headers: Headers): Record<string, string> | undefined {
  const captured: Record<string, string> = {};
  for (const name of RATE_LIMIT_RESPONSE_HEADER_ALLOWLIST) {
    const value = headers.get(name);
    if (typeof value === "string" && value.length > 0) captured[name] = value;
  }
  return Object.keys(captured).length > 0 ? captured : undefined;
}

/** 실제 운용 기본 구현 — Node 전역 fetch. Authorization 헤더에만 apiKey를 실어 보내고, 그 값을
 *  어떤 로그/에러 메시지에도 포함하지 않는다(에러 사유는 상태 코드/일반 문구로만 구성한다).
 *  redirect:"manual"로 3xx를 자동으로 따라가지 않는다 — 그렇지 않으면 Authorization 헤더(API
 *  key 포함)가 redirect 대상 host로 그대로 재전송될 수 있다(§ source-adapter.ts nodeHttpFetch와
 *  동일한 보호, Claude code-review에서 누락 지적됨). 응답 크기도 maxBodyBytes로 제한한다(잘라서
 *  계속 쓰지 않고 초과 시 전체 거부). */
export const nodeChatCompletionHttpFetch: ChatCompletionHttpFetch = async (req) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${req.apiKey}` },
      body: JSON.stringify(req.body),
    });
    if (res.type === "opaqueredirect") {
      return { ok: false, reason: "redirect 응답을 받았습니다 — 자동으로 따라가지 않습니다(Authorization 헤더 재전송 방지).", transient: false };
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let oversized = false;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          if (received > CHAT_COMPLETION_MAX_BODY_BYTES) {
            oversized = true;
            try {
              await reader.cancel();
            } catch {
              // 취소 실패는 무시 — 어차피 아래에서 실패로 반환한다.
            }
            break;
          }
          chunks.push(value);
        }
      }
    }
    if (oversized) {
      return { ok: false, reason: `응답 크기가 허용 한도(${CHAT_COMPLETION_MAX_BODY_BYTES} bytes)를 초과했습니다.`, transient: false };
    }
    const bodyText = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
    if (!res.ok) {
      // 413(Payload Too Large)도 429와 동일하게 transient로 취급한다 — Groq는 tokens-per-minute
      // capacity 초과를 429가 아니라 413 + {"code":"rate_limit_exceeded"}로 반환한다(2026-08-26,
      // JARVIS Task 1.2 Groq escalation 실제 실패를 재현해 직접 확인함: HTTP 413, "Request too
      // large for model ... on tokens per minute (TPM): Limit 8000, Requested 9349"). 이 상태를
      // 429/5xx와 다르게 취급하면(기존 버그) 재시도 가능한 capacity 초과가 영구적인 API_ERROR로
      // 오분류되어 escalation 실패 원인이 GROQ_STATUS 진단 없이 불투명하게 보고된다.
      const transient = res.status === 429 || res.status === 413 || res.status >= 500;
      return { ok: false, reason: `HTTP ${res.status}`, transient, status: res.status, rateLimitHeaders: captureRateLimitHeaders(res.headers) };
    }
    return { ok: true, response: { status: res.status, bodyText } };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, reason: "timeout", transient: true };
    }
    // err 원문은 담지 않는다(요청 header/URL을 포함할 수 있는 라이브러리도 있어 보수적으로
    // 일반화된 사유만 남긴다 — Secret 비노출 원칙과 동일한 정신).
    return { ok: false, reason: "네트워크 오류", transient: true };
  } finally {
    clearTimeout(timer);
  }
};

export interface ChatCompletionProviderConfig {
  /** ReviewProvider.id — Usage Ledger/Security Gate registry key로 그대로 쓰인다. */
  id: string;
  model: string;
  /** 고정된 chat completions endpoint(https). 요청/응답 내용으로 바뀌지 않는 코드 레벨 상수다. */
  baseUrl: string;
  /** 실제 API key "값"이 아니라 그 값을 담은 환경변수의 "이름"만 담는다. */
  apiKeyEnv: string;
  timeoutMs?: number;
  /** 선택적 추가 request body 필드(예: max_tokens) — 지정하지 않으면(undefined) 기존 요청
   *  body(model/messages만)와 완전히 동일하다(Groq/OpenRouter/NVIDIA는 이 필드를 쓰지 않으므로
   *  동작이 전혀 바뀌지 않는다). model/messages는 항상 이 필드보다 뒤에 조립되어 절대 덮어써지지
   *  않는다. */
  extraBody?: Record<string, unknown>;
}

function classifyHttpFailure(outcome: Extract<ChatCompletionHttpOutcome, { ok: false }>): { code: GptErrorCode; transient: boolean } {
  if (outcome.reason === "timeout") return { code: "TIMEOUT", transient: true };
  if (outcome.status === 401 || outcome.status === 403) return { code: "AUTH_ERROR", transient: false };
  // 413 — Groq의 tokens-per-minute capacity 초과 응답(§ 위 nodeChatCompletionHttpFetch 주석).
  // 429와 동일하게 RATE_LIMIT/transient로 분류해 final-reviewer-routing.ts의 기존
  // GROQ_STATUS=RATE_LIMITED 진단 경로로 흘러가게 한다 — 새 진단 경로를 만들지 않는다.
  if (outcome.status === 429 || outcome.status === 413) return { code: "RATE_LIMIT", transient: true };
  return { code: "API_ERROR", transient: outcome.transient };
}

interface ParsedChatCompletionEnvelope {
  outputText: string;
  model?: ReviewProviderModelIdentity;
  tokenUsage?: ReviewProviderTokenUsage;
}

/** OpenAI 호환 `/chat/completions` 응답 envelope에서 outputText/model/usage를 뽑아낸다. review
 *  payload(JSON 스키마: decision/severity/feedback/nextTask)의 유효성은 여기서 검사하지 않는다
 *  — 그건 Reviewer Core의 단일 책임이다(§ 파일 상단 주석). 여기서 실패할 수 있는 것은 오직
 *  "chat completion envelope 자체가 기대한 형태가 아님"(예: choices가 없음)뿐이다. */
function parseChatCompletionEnvelope(providerId: string, bodyText: string): { ok: true; data: ParsedChatCompletionEnvelope } | { ok: false } {
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return { ok: false };
  }
  if (!json || typeof json !== "object") return { ok: false };
  const o = json as Record<string, unknown>;
  const choices = o.choices;
  if (!Array.isArray(choices) || choices.length === 0) return { ok: false };
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content !== "string") return { ok: false };

  const model = typeof o.model === "string" && o.model.length > 0 ? { provider: providerId, name: o.model } : undefined;
  const usage = o.usage as Record<string, unknown> | undefined;
  const tokenUsage =
    usage && typeof usage === "object"
      ? {
          inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined,
          outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined,
          totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : undefined,
        }
      : undefined;

  return { ok: true, data: { outputText: content, model, tokenUsage } };
}

/**
 * config 하나 + 주입된 httpFetch/env로 ReviewProvider 하나를 만든다. review()는 정확히 1회
 * httpFetch를 호출한다(재시도는 Reviewer Core의 책임 — 이 factory는 재시도하지 않는다, §
 * openai-review-provider.ts와 동일한 계약).
 *
 * API key가 env에 없으면(§ 요구사항 "missing API key → NOT_CONFIGURED") 실제 요청을 전혀
 * 보내지 않고 즉시 requestAttempted:false로 실패한다(§ openai-review-provider.ts의 client 생성
 * 실패와 동일한 구분 — Usage Ledger가 실제 API 사용량과 로컬 preflight 실패를 구분할 수 있게
 * 한다).
 */
export function createChatCompletionReviewProvider(
  config: ChatCompletionProviderConfig,
  httpFetch: ChatCompletionHttpFetch = nodeChatCompletionHttpFetch,
  env: NodeJS.ProcessEnv = process.env
): ReviewProvider {
  return {
    id: config.id,
    model: config.model,
    async review(request: ReviewProviderRequest): Promise<ReviewProviderResult> {
      const apiKey = env[config.apiKeyEnv];
      if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
        return { ok: false, errorCode: "AUTH_ERROR", transient: false, requestAttempted: false };
      }

      const body = {
        ...config.extraBody,
        model: config.model,
        messages: [
          { role: "system", content: request.instructions },
          { role: "user", content: request.input },
        ],
      };

      const outcome = await httpFetch({ url: config.baseUrl, apiKey, body, timeoutMs: config.timeoutMs ?? 120_000 });
      if (!outcome.ok) {
        const { code, transient } = classifyHttpFailure(outcome);
        return { ok: false, errorCode: code, transient, requestAttempted: true, rateLimitHeaders: outcome.rateLimitHeaders, httpStatus: outcome.status };
      }

      const parsed = parseChatCompletionEnvelope(config.id, outcome.response.bodyText);
      if (!parsed.ok) {
        // envelope 자체가 기대한 형태가 아님(review JSON schema 문제가 아니라 transport 문제) —
        // Reviewer Core의 INVALID_OUTPUT과 의미를 겹치지 않게 API_ERROR로 분류한다. HTTP
        // 자체는 성공(2xx)했으므로 그 status를 그대로 보존한다(응답 body가 기대와 다른 것과
        // "요청 자체가 실패한 것"을 사후에 구분할 수 있게).
        return { ok: false, errorCode: "API_ERROR", transient: false, requestAttempted: true, httpStatus: outcome.response.status };
      }

      return { ok: true, outputText: parsed.data.outputText, model: parsed.data.model, tokenUsage: parsed.data.tokenUsage };
    },
  };
}
