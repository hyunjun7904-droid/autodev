import type { GptErrorCode } from "./types";
import type { ReviewProvider, ReviewProviderRequest, ReviewProviderResult } from "./review-provider";
import { OLLAMA_PROVIDER_ID } from "./provider-pool-security-metadata";
import type { ProviderRuntimeProbeResult } from "./provider-pool";

// Ollama Local Review Provider Adapter — Phase SI-3.8F.
//
// Ollama의 로컬 REST API(`POST /api/chat`, 공식 문서 https://ollama.com/privacy 및
// github.com/ollama/ollama의 API 문서 — 이 파일은 그 스키마를 직접 소비할 뿐 외부 네트워크
// 호출을 하지 않는다)는 Groq/OpenRouter/NVIDIA NIM의 OpenAI 호환 chat-completions 형식과
// 다르다(usage 필드 없음, message.content 위치는 동일) — 그래서
// chat-completion-review-provider.ts 공용 factory를 재사용하지 않고 이 파일에서 별도로
// 구현한다.
//
// baseUrl 검증 — source-adapter.ts(D3)의 isPrivateOrMetadataHost()는 절대 재사용하지 않는다
// (Claude code-review에서 지적됨). 그 함수의 PRIVATE_IPV4_PATTERNS는 hostname 문자열에 대한
// unanchored prefix 정규식(예: /^10\./)이라 "10.attacker.com" 같은 완전히 유효한 공인 DNS
// 이름도 매칭시킨다 — 임의 외부 endpoint를 항상 거부하는 blocklist(과다 매칭이 안전한 방향)
// 로는 맞지만, 그 판정을 뒤집어 "private처럼 보이면 허용"하는 allow-check로 쓰면 안전성이
// 반대로 뒤집힌다: "10.attacker.com"이 loopback인 척 통과해 RESTRICTED 등급 데이터까지
// 실제로는 공인 인터넷 호스트로 전송될 수 있다(Ollama의 trustLevel="high"/RESTRICTED 허용은
// "로컬 실행이라 외부로 전송되지 않는다"는 전제에만 의존한다). 그래서 이 파일은
// isStrictLoopbackHost() — hostname 전체가 정확히 "localhost"/"::1"이거나, 네 자리 십진
// octet으로만 구성된 완전한 IPv4 dotted-quad이면서 첫 octet이 127인 경우만 인정하는 엄격한
// 자체 검증 — 을 별도로 구현한다("10.attacker.com"/"127.0.0.1.attacker.io" 모두 이 전체
// 매칭 정규식을 통과하지 못해 거부된다).
//
// 실제 fetch(nodeOllamaHttpFetch)도 source-adapter.ts의 nodeHttpFetch와 동일한 두 가지
// 보호를 강제한다 — (1) redirect:"manual"로 3xx를 자동으로 따라가지 않는다(로컬 서버가
// 위 검증을 통과한 뒤에도 redirect로 외부 host로 유도될 수 있는 경로를 차단), (2)
// maxBodyBytes로 응답 크기를 제한한다(잘라서 계속 쓰지 않고 초과 시 전체 거부).
//
// 자동 다운로드/자동 설치를 하지 않는다(§ 요구사항 5) — 이 파일의 어떤 함수도 모델을
// 다운로드하거나 ollama 프로세스를 실행하지 않는다. 서버/모델 존재 여부는 순수 probe seam
// (OllamaProbeFetch)으로만 확인하며, 기본 export 어디에도 이 probe를 자동으로 호출하는 경로가
// 없다(provider-pool.ts의 resolveProviderPoolStatus()도 probeResult가 없으면 NOT_CONFIGURED로
// 처리할 뿐 스스로 probe를 실행하지 않는다).

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface OllamaHttpRequest {
  url: string;
  body?: unknown;
  timeoutMs: number;
}
export interface OllamaHttpSuccess {
  status: number;
  bodyText: string;
}
export type OllamaHttpOutcome = { ok: true; response: OllamaHttpSuccess } | { ok: false; reason: string; transient: boolean };

/** 실제 로컬 HTTP 호출은 이 함수 타입 뒤로 격리된다 — 테스트는 항상 fake를 주입해 실제
 *  localhost로 나가지 않는다(§ 요구사항 "실제 network request test 금지"). */
export type OllamaHttpFetch = (req: OllamaHttpRequest) => Promise<OllamaHttpOutcome>;

export const nodeOllamaHttpFetch: OllamaHttpFetch = async (req) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), req.timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: req.body === undefined ? "GET" : "POST",
      // 로컬 검증을 통과한 뒤에도 redirect로 다른 host로 유도될 수 있는 경로를 차단한다.
      redirect: "manual",
      signal: controller.signal,
      headers: req.body === undefined ? undefined : { "content-type": "application/json" },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
    });
    if (res.type === "opaqueredirect") {
      return { ok: false, reason: "redirect 응답을 받았습니다 — 자동으로 따라가지 않습니다.", transient: false };
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
          if (received > OLLAMA_MAX_BODY_BYTES) {
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
      return { ok: false, reason: `응답 크기가 허용 한도(${OLLAMA_MAX_BODY_BYTES} bytes)를 초과했습니다.`, transient: false };
    }
    const bodyText = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status}`, transient: res.status >= 500 };
    }
    return { ok: true, response: { status: res.status, bodyText } };
  } catch {
    if (controller.signal.aborted) return { ok: false, reason: "timeout", transient: true };
    // 로컬 서버가 아예 떠있지 않은 경우가 가장 흔한 원인이다 — 원문 err는 담지 않는다.
    return { ok: false, reason: "로컬 Ollama 서버에 연결할 수 없습니다.", transient: false };
  } finally {
    clearTimeout(timer);
  }
};

/** hostname 전체가 정확히 loopback인지 엄격하게 판정한다 — "10.attacker.com" 같은 문자열이
 *  prefix만 우연히 비슷해 보인다는 이유로 통과하지 않도록, 부분 매칭이 아니라 전체 문자열이
 *  하나의 정확한 형태(정확히 "localhost"/"::1", 또는 4개의 십진 octet(각 0~255)로만 이뤄진
 *  IPv4 dotted-quad이면서 첫 octet이 127)일 때만 인정한다(§ 파일 상단 주석 — D3의
 *  isPrivateOrMetadataHost()를 allow-check로 재사용하지 않는 이유). */
export function isStrictLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!match) return false;
  const octets = match.slice(1, 5).map(Number);
  return octets.every((o) => o >= 0 && o <= 255) && octets[0] === 127;
}

function assertLocalBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Invalid Ollama baseUrl: URL을 파싱할 수 없습니다(${baseUrl}).`);
  }
  if (!isStrictLoopbackHost(url.hostname)) {
    throw new Error(
      `Invalid Ollama baseUrl(${baseUrl}): local provider는 정확히 loopback host(localhost/127.0.0.0/8/::1)만 허용됩니다 — 이 값은 "로컬 실행이라 외부로 전송되지 않는다"는 security metadata 전제를 깨뜨립니다.`
    );
  }
}

interface ParsedOllamaChatResponse {
  outputText: string;
  model?: string;
}

function parseOllamaChatResponse(bodyText: string): { ok: true; data: ParsedOllamaChatResponse } | { ok: false } {
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return { ok: false };
  }
  if (!json || typeof json !== "object") return { ok: false };
  const o = json as Record<string, unknown>;
  const message = o.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content !== "string") return { ok: false };
  const model = typeof o.model === "string" && o.model.length > 0 ? o.model : undefined;
  return { ok: true, data: { outputText: content, model } };
}

function classifyOllamaFailure(outcome: Extract<OllamaHttpOutcome, { ok: false }>): { code: GptErrorCode; transient: boolean } {
  if (outcome.reason === "timeout") return { code: "TIMEOUT", transient: true };
  return { code: "API_ERROR", transient: outcome.transient };
}

/**
 * Ollama 로컬 `/api/chat`을 정확히 1회 호출하는 ReviewProvider. API key가 없다(로컬 실행,
 * 인증 불필요) — 대신 baseUrl이 loopback/private host가 아니면 provider 생성 자체가 throw한다
 * (fail-closed, 잘못된 설정으로 조용히 외부 전송이 일어나지 않게 한다).
 */
export function createOllamaReviewProvider(
  model: string,
  httpFetch: OllamaHttpFetch = nodeOllamaHttpFetch,
  baseUrl: string = DEFAULT_OLLAMA_BASE_URL
): ReviewProvider {
  assertLocalBaseUrl(baseUrl);
  return {
    id: OLLAMA_PROVIDER_ID,
    model,
    async review(request: ReviewProviderRequest): Promise<ReviewProviderResult> {
      const body = {
        model,
        stream: false,
        messages: [
          { role: "system", content: request.instructions },
          { role: "user", content: request.input },
        ],
      };
      const outcome = await httpFetch({ url: `${baseUrl}/api/chat`, body, timeoutMs: 120_000 });
      if (!outcome.ok) {
        const { code, transient } = classifyOllamaFailure(outcome);
        return { ok: false, errorCode: code, transient, requestAttempted: true };
      }
      const parsed = parseOllamaChatResponse(outcome.response.bodyText);
      if (!parsed.ok) {
        return { ok: false, errorCode: "API_ERROR", transient: false, requestAttempted: true };
      }
      const modelIdentity = parsed.data.model ? { provider: OLLAMA_PROVIDER_ID, name: parsed.data.model } : undefined;
      return { ok: true, outputText: parsed.data.outputText, model: modelIdentity };
    },
  };
}

// =========================================================
// Availability Probe — 서버/모델 존재 여부를 위한 deterministic local probe seam(§ 요구사항 5
// "모델/서버 존재 여부는 deterministic local probe seam으로 설계 가능"). 이 함수는 어디에서도
// 자동으로 호출되지 않는다 — 호출자가 명시적으로 실행해 그 결과를 provider-pool.ts의
// resolveProviderPoolStatus()에 넘겨야 한다.
// =========================================================

/** `/api/tags`(설치된 모델 목록)를 조회해 서버 도달 가능성과 특정 모델의 설치 여부를 함께
 *  확인한다. 모델을 다운로드/설치하지 않는다 — 오직 조회만 한다. */
export async function probeOllamaAvailability(
  model: string,
  httpFetch: OllamaHttpFetch = nodeOllamaHttpFetch,
  baseUrl: string = DEFAULT_OLLAMA_BASE_URL
): Promise<ProviderRuntimeProbeResult> {
  assertLocalBaseUrl(baseUrl);
  const outcome = await httpFetch({ url: `${baseUrl}/api/tags`, timeoutMs: 5_000 });
  if (!outcome.ok) {
    return { available: false, detail: "로컬 Ollama 서버에 도달할 수 없습니다." };
  }
  let json: unknown;
  try {
    json = JSON.parse(outcome.response.bodyText);
  } catch {
    return { available: false, detail: "서버 응답을 해석할 수 없습니다." };
  }
  const models = (json as Record<string, unknown> | null)?.models;
  if (!Array.isArray(models)) {
    return { available: false, detail: "서버 응답에 models 목록이 없습니다." };
  }
  const installed = models.some((m) => (m as Record<string, unknown> | null)?.name === model);
  if (!installed) {
    return { available: false, detail: `모델(${model})이 로컬에 설치되어 있지 않습니다.` };
  }
  return { available: true };
}
