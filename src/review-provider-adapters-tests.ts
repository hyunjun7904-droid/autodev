import type { ChatCompletionHttpFetch, ChatCompletionHttpRequest, ChatCompletionHttpOutcome } from "./chat-completion-review-provider";
import { createChatCompletionReviewProvider } from "./chat-completion-review-provider";
import { createGroqReviewProvider, GROQ_CHAT_COMPLETIONS_URL } from "./groq-review-provider";
import { createOpenRouterReviewProvider, OPENROUTER_CHAT_COMPLETIONS_URL, bodyHasZdrTrue } from "./openrouter-review-provider";
import { createNvidiaNimReviewProvider, NVIDIA_NIM_CHAT_COMPLETIONS_URL } from "./nvidia-nim-review-provider";
import type { OllamaHttpFetch, OllamaHttpRequest } from "./ollama-review-provider";
import { createOllamaReviewProvider, probeOllamaAvailability, DEFAULT_OLLAMA_BASE_URL, isStrictLoopbackHost } from "./ollama-review-provider";
import { GROQ_PROVIDER_ID, OPENROUTER_PROVIDER_ID, NVIDIA_NIM_PROVIDER_ID, OLLAMA_PROVIDER_ID } from "./provider-pool-security-metadata";

// Reviewer Provider Pool — Adapter Transport Tests — Phase SI-3.8F.
//
// 이 파일의 모든 시나리오는 fake transport(httpFetch)만 주입한다 — Node 전역 fetch를 실제로
// 호출하지 않으므로 실제 네트워크 요청이 0건이다(요구사항 "fake provider actual network call
// 0", "실제 external inference calls 0", "실제 network request test 금지"). 실제 운용
// 구현(nodeChatCompletionHttpFetch/nodeOllamaHttpFetch)은 이 파일 어디에서도 호출/import하지
// 않는다(createXxxReviewProvider 각각에 fake httpFetch를 명시적으로 주입한다).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const FAKE_API_KEY_VALUE = "sk-should-never-appear-anywhere";

function chatCompletionSuccessBody(content: string, model = "fake-model-v1"): string {
  return JSON.stringify({
    model,
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}

interface FetchHandle {
  fetch: ChatCompletionHttpFetch;
  callCount: () => number;
  lastRequest: () => ChatCompletionHttpRequest | undefined;
}

function makeFakeChatFetch(outcomeBuilder: (req: ChatCompletionHttpRequest) => ChatCompletionHttpOutcome): FetchHandle {
  let calls = 0;
  let lastRequest: ChatCompletionHttpRequest | undefined;
  const fetch: ChatCompletionHttpFetch = async (req) => {
    calls += 1;
    lastRequest = req;
    return outcomeBuilder(req);
  };
  return { fetch, callCount: () => calls, lastRequest: () => lastRequest };
}

// =========================================================
// A) chat-completion-review-provider.ts 공용 factory — 기본 계약.
// =========================================================
async function scenarioA_factoryBasics(): Promise<void> {
  // A1) API key 없음 → NOT_CONFIGURED 동등(ok:false, requestAttempted:false), httpFetch 호출 0회.
  const noKeyFetch = makeFakeChatFetch(() => ({ ok: true, response: { status: 200, bodyText: chatCompletionSuccessBody("x") } }));
  const noKeyProvider = createChatCompletionReviewProvider({ id: "fake-provider", model: "m", baseUrl: "https://example.com/v1/chat", apiKeyEnv: "MISSING_KEY_ENV" }, noKeyFetch.fetch, {});
  const noKeyResult = await noKeyProvider.review({ instructions: "i", input: "j" });
  check("A1) API key 환경변수 없음 → ok:false", noKeyResult.ok === false);
  if (!noKeyResult.ok) {
    check("A1) errorCode=AUTH_ERROR", noKeyResult.errorCode === "AUTH_ERROR");
    check("A1) requestAttempted=false(실제 요청 미발생, NOT_CONFIGURED와 동등)", noKeyResult.requestAttempted === false);
  }
  check("A1) httpFetch 호출 0회(API key 없으면 요청 자체가 나가지 않음)", noKeyFetch.callCount() === 0);

  // A2) 성공 경로 — outputText/model/tokenUsage 추출, 정확히 1회 호출.
  const successFetch = makeFakeChatFetch((req) => {
    check("A2) Authorization 헤더용 apiKey가 올바르게 전달됨", req.apiKey === "real-key-value");
    return { ok: true, response: { status: 200, bodyText: chatCompletionSuccessBody('{"decision":"PASS"}', "echoed-model") } };
  });
  const successProvider = createChatCompletionReviewProvider(
    { id: "fake-provider", model: "requested-model", baseUrl: "https://example.com/v1/chat", apiKeyEnv: "KEY_ENV" },
    successFetch.fetch,
    { KEY_ENV: "real-key-value" }
  );
  const successResult = await successProvider.review({ instructions: "system text", input: "user text" });
  check("A2) httpFetch가 정확히 1회 호출됨", successFetch.callCount() === 1);
  check("A2) ok:true", successResult.ok === true);
  if (successResult.ok) {
    check("A2) outputText가 message.content 그대로", successResult.outputText === '{"decision":"PASS"}');
    check("A2) model identity가 응답의 model을 그대로 echo함(요청 model과 다를 수 있음을 구분)", successResult.model?.name === "echoed-model");
    check("A2) tokenUsage가 usage 필드에서 추출됨", successResult.tokenUsage?.inputTokens === 10 && successResult.tokenUsage?.outputTokens === 20 && successResult.tokenUsage?.totalTokens === 30);
  }
  const lastReq = successFetch.lastRequest();
  check("A2) 요청 body의 model이 config.model(고정값)", (lastReq?.body as { model?: string } | undefined)?.model === "requested-model");
  check(
    "A2) 요청 body의 messages가 instructions/input을 그대로 담음",
    JSON.stringify((lastReq?.body as { messages?: unknown } | undefined)?.messages) === JSON.stringify([
      { role: "system", content: "system text" },
      { role: "user", content: "user text" },
    ])
  );

  // A3) HTTP 오류 분류 — 401/413/429/500/timeout.
  const cases: { status?: number; reason: string; transient: boolean; expectedCode: string; expectedTransient: boolean }[] = [
    { status: 401, reason: "HTTP 401", transient: false, expectedCode: "AUTH_ERROR", expectedTransient: false },
    { status: 429, reason: "HTTP 429", transient: true, expectedCode: "RATE_LIMIT", expectedTransient: true },
    // Groq의 tokens-per-minute capacity 초과는 429가 아니라 413로 온다(2026-08-26, JARVIS
    // Task 1.2 Groq escalation 실제 실패 재현으로 확인 — HTTP 413, code:"rate_limit_exceeded").
    { status: 413, reason: "HTTP 413", transient: true, expectedCode: "RATE_LIMIT", expectedTransient: true },
    { status: 500, reason: "HTTP 500", transient: true, expectedCode: "API_ERROR", expectedTransient: true },
    { reason: "timeout", transient: true, expectedCode: "TIMEOUT", expectedTransient: true },
  ];
  for (const c of cases) {
    const errFetch = makeFakeChatFetch(() => ({ ok: false, reason: c.reason, transient: c.transient, status: c.status }));
    const errProvider = createChatCompletionReviewProvider({ id: "fake-provider", model: "m", baseUrl: "https://example.com/v1/chat", apiKeyEnv: "KEY_ENV" }, errFetch.fetch, { KEY_ENV: "k" });
    const errResult = await errProvider.review({ instructions: "i", input: "j" });
    check(`A3) ${c.reason} → ok:false`, errResult.ok === false);
    if (!errResult.ok) {
      check(`A3) ${c.reason} → errorCode=${c.expectedCode}`, errResult.errorCode === c.expectedCode);
      check(`A3) ${c.reason} → transient=${c.expectedTransient}`, errResult.transient === c.expectedTransient);
      check(`A3) ${c.reason} → requestAttempted=true(실제로 요청은 나감)`, errResult.requestAttempted === true);
      // AutoDev Core Maintenance — Reviewer Failure Telemetry(Category D). errorCode만으로는
      // 일반 4xx/5xx가 전부 API_ERROR 하나로 뭉개지지만, httpStatus는 실제 status를 그대로
      // 보존해 사후에 구분할 수 있게 한다. timeout(응답 자체가 없음)만 undefined로 남는다.
      check(
        `A3) ${c.reason} → httpStatus=${c.status ?? "undefined"}(실제 status가 유실되지 않음)`,
        errResult.httpStatus === c.status
      );
    }
  }

  // A4) malformed envelope(choices 없음) → API_ERROR, transient false(재시도해도 해결 안 됨).
  const malformedFetch = makeFakeChatFetch(() => ({ ok: true, response: { status: 200, bodyText: JSON.stringify({ no_choices_here: true }) } }));
  const malformedProvider = createChatCompletionReviewProvider({ id: "fake-provider", model: "m", baseUrl: "https://example.com/v1/chat", apiKeyEnv: "KEY_ENV" }, malformedFetch.fetch, { KEY_ENV: "k" });
  const malformedResult = await malformedProvider.review({ instructions: "i", input: "j" });
  check("A4) malformed envelope → ok:false", malformedResult.ok === false);
  if (!malformedResult.ok) {
    check("A4) errorCode=API_ERROR(Reviewer Core의 INVALID_OUTPUT과 의미가 겹치지 않음)", malformedResult.errorCode === "API_ERROR");
    check("A4) transient=false", malformedResult.transient === false);
    check("A4) HTTP 자체는 성공(200)했다는 사실이 httpStatus로 보존됨", malformedResult.httpStatus === 200);
  }

  // A5) Secret 비노출 — 성공/실패 어떤 결과에도 API key 값이 나타나지 않음(#23).
  const secretFetch = makeFakeChatFetch((req) => {
    check("A5) fake fetch가 실제로 secret key를 전달받음(주입 확인용)", req.apiKey === FAKE_API_KEY_VALUE);
    return { ok: false, reason: "HTTP 500", transient: true, status: 500 };
  });
  const secretProvider = createChatCompletionReviewProvider({ id: "fake-provider", model: "m", baseUrl: "https://example.com/v1/chat", apiKeyEnv: "SECRET_KEY_ENV" }, secretFetch.fetch, {
    SECRET_KEY_ENV: FAKE_API_KEY_VALUE,
  });
  const secretResult = await secretProvider.review({ instructions: "i", input: "j" });
  check("A5) 실패 결과 직렬화에 secret key 값이 없음(#23)", !JSON.stringify(secretResult).includes(FAKE_API_KEY_VALUE));
}

// =========================================================
// B) Groq/OpenRouter/NVIDIA NIM adapter — provider identity + 공용 factory 재사용 확인.
// =========================================================
async function scenarioB_adapterIdentities(): Promise<void> {
  const groqFetch = makeFakeChatFetch((req) => {
    check("B) Groq adapter가 올바른 endpoint를 호출함", req.url === GROQ_CHAT_COMPLETIONS_URL);
    return { ok: true, response: { status: 200, bodyText: chatCompletionSuccessBody("groq-ok") } };
  });
  const groqProvider = createGroqReviewProvider("llama-example", groqFetch.fetch, { GROQ_API_KEY: "k" });
  check("B) Groq provider.id === 'groq'", groqProvider.id === GROQ_PROVIDER_ID);
  const groqResult = await groqProvider.review({ instructions: "i", input: "j" });
  check("B) Groq 호출 정상 처리(1회, 다른 provider로 자동 전환 없음, #12)", groqFetch.callCount() === 1 && groqResult.ok === true);

  const nvidiaFetch = makeFakeChatFetch((req) => {
    check("B) NVIDIA NIM adapter가 올바른 endpoint를 호출함", req.url === NVIDIA_NIM_CHAT_COMPLETIONS_URL);
    return { ok: true, response: { status: 200, bodyText: chatCompletionSuccessBody("nim-ok") } };
  });
  const nvidiaProvider = createNvidiaNimReviewProvider("nim-example", nvidiaFetch.fetch, { NVIDIA_API_KEY: "k" });
  check("B) NVIDIA NIM provider.id === 'nvidia-nim'", nvidiaProvider.id === NVIDIA_NIM_PROVIDER_ID);
  const nvidiaResult = await nvidiaProvider.review({ instructions: "i", input: "j" });
  check("B) NVIDIA NIM 호출 정상 처리(transport는 완전하지만 Security Gate는 별도 관문, #8 어댑터)", nvidiaFetch.callCount() === 1 && nvidiaResult.ok === true);

  // OpenRouter — ZDR 미검증 시 provider.zdr 파라미터를 추가하지 않음.
  const openRouterFetchNoZdr = makeFakeChatFetch((req) => {
    check("B) OpenRouter adapter가 올바른 endpoint를 호출함", req.url === OPENROUTER_CHAT_COMPLETIONS_URL);
    check("B) ZDR 미검증 배포는 body에 provider.zdr을 추가하지 않음", !bodyHasZdrTrue(req.body));
    return { ok: true, response: { status: 200, bodyText: chatCompletionSuccessBody("openrouter-ok") } };
  });
  const openRouterProviderNoZdr = createOpenRouterReviewProvider("openai/gpt-example", openRouterFetchNoZdr.fetch, { OPENROUTER_API_KEY: "k" });
  check("B) OpenRouter provider.id === 'openrouter'", openRouterProviderNoZdr.id === OPENROUTER_PROVIDER_ID);
  await openRouterProviderNoZdr.review({ instructions: "i", input: "j" });
  check("B) OpenRouter(ZDR 미검증) 정확히 1회 호출됨", openRouterFetchNoZdr.callCount() === 1);

  // OpenRouter — ZDR 검증됨이면 body에 provider.zdr:true를 강제로 포함.
  const openRouterFetchZdr = makeFakeChatFetch((req) => {
    check("B) ZDR 검증된 배포는 실제 요청 body에 provider.zdr:true를 포함함", bodyHasZdrTrue(req.body));
    return { ok: true, response: { status: 200, bodyText: chatCompletionSuccessBody("openrouter-zdr-ok") } };
  });
  const openRouterProviderZdr = createOpenRouterReviewProvider("openai/gpt-example", openRouterFetchZdr.fetch, {
    OPENROUTER_API_KEY: "k",
    AUTODEV_OPENROUTER_ZDR_VERIFIED: "true",
  });
  await openRouterProviderZdr.review({ instructions: "i", input: "j" });
  check("B) OpenRouter(ZDR 검증됨) 정확히 1회 호출됨", openRouterFetchZdr.callCount() === 1);
}

// =========================================================
// C) Ollama local adapter — 별도 응답 스키마, baseUrl 검증, unavailable 안전 처리(#10).
// =========================================================
interface OllamaFetchHandle {
  fetch: OllamaHttpFetch;
  callCount: () => number;
  lastRequest: () => OllamaHttpRequest | undefined;
}
function makeFakeOllamaFetch(outcomeBuilder: (req: OllamaHttpRequest) => Awaited<ReturnType<OllamaHttpFetch>>): OllamaFetchHandle {
  let calls = 0;
  let lastRequest: OllamaHttpRequest | undefined;
  const fetch: OllamaHttpFetch = async (req) => {
    calls += 1;
    lastRequest = req;
    return outcomeBuilder(req);
  };
  return { fetch, callCount: () => calls, lastRequest: () => lastRequest };
}

async function scenarioC_ollamaAdapter(): Promise<void> {
  // C1) baseUrl이 loopback이 아니면 provider 생성 자체가 throw(로컬 전용 전제 보호).
  let threw = false;
  try {
    createOllamaReviewProvider("llama3", async () => ({ ok: true, response: { status: 200, bodyText: "{}" } }), "https://public-external-host.example.com");
  } catch {
    threw = true;
  }
  check("C1) 공인 host로 baseUrl 설정 시 provider 생성이 throw함(로컬 전용 전제 보호)", threw);

  // C1b) Claude code-review 지적 — "10.attacker.com"/"127.0.0.1.attacker.io"처럼 loopback
  // 대역과 문자열 prefix만 우연히 같아 보이는 완전히 유효한 공인 DNS 이름이 loopback으로
  // 오판되어 통과하지 않는지 직접 확인한다(isStrictLoopbackHost는 전체 hostname이 정확히
  // "localhost"/"::1" 또는 4-octet dotted-quad(첫 octet 127)일 때만 true여야 한다).
  check("C1b) isStrictLoopbackHost('10.attacker.com') === false(prefix만 비슷한 공인 DNS 이름)", isStrictLoopbackHost("10.attacker.com") === false);
  check("C1b) isStrictLoopbackHost('127.0.0.1.attacker.io') === false", isStrictLoopbackHost("127.0.0.1.attacker.io") === false);
  check("C1b) isStrictLoopbackHost('192.168.evil.example') === false", isStrictLoopbackHost("192.168.evil.example") === false);
  check("C1b) isStrictLoopbackHost('127.0.0.1') === true(정상 loopback)", isStrictLoopbackHost("127.0.0.1") === true);
  check("C1b) isStrictLoopbackHost('localhost') === true", isStrictLoopbackHost("localhost") === true);
  check("C1b) isStrictLoopbackHost('::1') === true", isStrictLoopbackHost("::1") === true);
  let spoofedThrew = false;
  try {
    createOllamaReviewProvider("llama3", async () => ({ ok: true, response: { status: 200, bodyText: "{}" } }), "http://10.attacker.com:11434");
  } catch {
    spoofedThrew = true;
  }
  check("C1b) 'http://10.attacker.com:11434'는 loopback으로 위장할 수 없고 provider 생성이 throw함", spoofedThrew);

  // C2) 정상 성공 경로 — Ollama 고유 응답 스키마(message.content, usage 없음).
  const okFetch = makeFakeOllamaFetch((req) => {
    check("C2) Ollama /api/chat endpoint를 호출함", req.url === `${DEFAULT_OLLAMA_BASE_URL}/api/chat`);
    return { ok: true, response: { status: 200, bodyText: JSON.stringify({ model: "llama3", message: { role: "assistant", content: "local-ok" } }) } };
  });
  const okProvider = createOllamaReviewProvider("llama3", okFetch.fetch);
  check("C2) Ollama provider.id === 'ollama'", okProvider.id === OLLAMA_PROVIDER_ID);
  const okResult = await okProvider.review({ instructions: "sys", input: "usr" });
  check("C2) httpFetch 정확히 1회 호출됨", okFetch.callCount() === 1);
  check("C2) ok:true + outputText가 message.content 그대로", okResult.ok === true && okResult.ok && okResult.outputText === "local-ok");

  // C3) 서버 연결 불가(Ollama가 실행 중이 아닌 상태) → 안전하게 ok:false로 수렴(#10 unavailable 안전 처리).
  const unreachableFetch = makeFakeOllamaFetch(() => ({ ok: false, reason: "로컬 Ollama 서버에 연결할 수 없습니다.", transient: false }));
  const unreachableProvider = createOllamaReviewProvider("llama3", unreachableFetch.fetch);
  const unreachableResult = await unreachableProvider.review({ instructions: "sys", input: "usr" });
  check("C3) 서버 연결 불가 → 예외 없이 ok:false로 수렴(안전 처리)", unreachableResult.ok === false);
  if (!unreachableResult.ok) {
    check("C3) requestAttempted=true(실제 로컬 요청은 시도됨)", unreachableResult.requestAttempted === true);
  }

  // C4) malformed 응답(message.content 없음) → API_ERROR.
  const malformedFetch = makeFakeOllamaFetch(() => ({ ok: true, response: { status: 200, bodyText: JSON.stringify({ done: true }) } }));
  const malformedProvider = createOllamaReviewProvider("llama3", malformedFetch.fetch);
  const malformedResult = await malformedProvider.review({ instructions: "sys", input: "usr" });
  check("C4) malformed 응답 → ok:false", malformedResult.ok === false);
  if (!malformedResult.ok) check("C4) errorCode=API_ERROR", malformedResult.errorCode === "API_ERROR");

  // C5) Claude code-review 지적(Phase SI-3.9) — 구조화 출력 `format` 파라미터가 지정되면
  // 요청 body에 그대로 실리고, 지정하지 않으면(기존 호출부 전부) body에 그 필드 자체가
  // 아예 없어야 한다(하위 호환 — 기존 동작 변경 없음).
  const FAKE_SCHEMA = { type: "object", properties: { decision: { type: "string" } } };
  const withFormatFetch = makeFakeOllamaFetch((req) => {
    const body = req.body as Record<string, unknown>;
    check("C5) format 지정 시 요청 body.format이 그대로 전달됨", JSON.stringify(body.format) === JSON.stringify(FAKE_SCHEMA));
    return { ok: true, response: { status: 200, bodyText: JSON.stringify({ model: "llama3", message: { role: "assistant", content: "{}" } }) } };
  });
  const withFormatProvider = createOllamaReviewProvider("llama3", withFormatFetch.fetch, DEFAULT_OLLAMA_BASE_URL, FAKE_SCHEMA);
  await withFormatProvider.review({ instructions: "sys", input: "usr" });
  check("C5) format 지정 시 httpFetch가 정확히 1회 호출됨", withFormatFetch.callCount() === 1);

  const withoutFormatFetch = makeFakeOllamaFetch((req) => {
    const body = req.body as Record<string, unknown>;
    check("C5) format 미지정 시 요청 body에 format 필드 자체가 없음", !("format" in body));
    return { ok: true, response: { status: 200, bodyText: JSON.stringify({ model: "llama3", message: { role: "assistant", content: "{}" } }) } };
  });
  const withoutFormatProvider = createOllamaReviewProvider("llama3", withoutFormatFetch.fetch);
  await withoutFormatProvider.review({ instructions: "sys", input: "usr" });
}

// =========================================================
// D) Ollama 가용성 probe — 모델 자동 다운로드 없이 조회만 함(#5/#10).
// =========================================================
async function scenarioD_ollamaProbe(): Promise<void> {
  const reachableWithModel = makeFakeOllamaFetch((req) => {
    check("D) probe가 /api/tags를 조회함", req.url === `${DEFAULT_OLLAMA_BASE_URL}/api/tags`);
    return { ok: true, response: { status: 200, bodyText: JSON.stringify({ models: [{ name: "llama3" }, { name: "other-model" }] }) } };
  });
  const availableResult = await probeOllamaAvailability("llama3", reachableWithModel.fetch);
  check("D) 서버 도달 가능 + 모델 설치됨 → available:true", availableResult.available === true);

  const reachableWithoutModel = makeFakeOllamaFetch(() => ({ ok: true, response: { status: 200, bodyText: JSON.stringify({ models: [{ name: "other-model" }] }) } }));
  const missingModelResult = await probeOllamaAvailability("llama3", reachableWithoutModel.fetch);
  check("D) 서버는 도달 가능하지만 모델 미설치 → available:false(모델 자동 다운로드 없음)", missingModelResult.available === false);

  const unreachable = makeFakeOllamaFetch(() => ({ ok: false, reason: "연결 불가", transient: false }));
  const unreachableResult = await probeOllamaAvailability("llama3", unreachable.fetch);
  check("D) 서버 도달 불가 → available:false", unreachableResult.available === false);

  check("D) probe가 fake fetch를 정확히 1회씩만 호출함(자동 재시도/다운로드 없음)", reachableWithModel.callCount() === 1 && reachableWithoutModel.callCount() === 1 && unreachable.callCount() === 1);
}

async function main(): Promise<void> {
  await scenarioA_factoryBasics();
  await scenarioB_adapterIdentities();
  await scenarioC_ollamaAdapter();
  await scenarioD_ollamaProbe();

  console.log("\n=== Reviewer Provider Pool — Adapter Transport(SI-3.8F) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
