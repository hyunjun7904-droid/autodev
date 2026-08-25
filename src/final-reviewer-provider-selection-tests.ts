import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FINAL_REVIEWER_PRODUCTION_MODEL,
  FINAL_REVIEWER_PRODUCTION_PROVIDER_ID,
  createFinalReviewerProductionProvider,
  resolveFinalReviewerProductionSecurityRegistry,
  finalReviewerProductionProvider,
} from "./final-reviewer-provider-selection";
import { GROQ_CHAT_COMPLETIONS_URL } from "./groq-review-provider";
import { evaluateProviderSecurity } from "./provider-security-gate";
import { DEFAULT_REVIEWER_DATA_CLASSIFICATION } from "./review-provider";
import type { ChatCompletionHttpFetch, ChatCompletionHttpRequest } from "./chat-completion-review-provider";
import { reviewClaudeResultOnce, buildGptReviewLedgerEntryInput } from "./gpt-reviewer";
import type { ClaudeResult } from "./types";

// AutoDev Production Final Reviewer Wiring Task — mock/static 검증.
//
// 이 파일이 증명하는 것: gpt-reviewer.ts의 production default(override 없음)가 실제로
// final-reviewer-provider-selection.ts(Groq, openai/gpt-oss-120b)를 쓰고, GROQ_API_KEY/
// AUTODEV_GROQ_ZDR_VERIFIED 둘 중 하나라도 미충족이면 fail-closed로 중단하며, 어떤 시나리오도
// OpenAI/Ollama/OpenRouter/NVIDIA로 자동 전환하지 않는다는 것. 실제 Groq API는 이 파일 어디서도
// 호출하지 않는다(§ Task STEP 4 — "실제 Groq API를 호출하기 전에 mock/static tests를 먼저
// 수행한다") — 유일한 실제 네트워크 검증은 별도 smoke test 스크립트의 몫이다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const FAKE_RESULT: ClaudeResult = { success: true, summary: "테스트", changedFiles: [], tests: [], rawOutput: "" };
const SMALL_TASK = "작은 review 대상 task";
const SECRET_MARKER = "gsk_should-never-appear-anywhere-in-observability";

function passOutputText(): string {
  return JSON.stringify({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "ok", nextTask: null });
}

/** 실제 네트워크를 전혀 만들지 않는 fake ChatCompletionHttpFetch — 호출 횟수/마지막 요청을 관측한다. */
function makeFakeHttpFetch(
  responder: ChatCompletionHttpFetch
): { fetch: ChatCompletionHttpFetch; callCount: () => number; lastRequest: () => ChatCompletionHttpRequest | undefined } {
  let calls = 0;
  let lastRequest: ChatCompletionHttpRequest | undefined;
  const fetchFn: ChatCompletionHttpFetch = async (req) => {
    calls += 1;
    lastRequest = req;
    return responder(req);
  };
  return { fetch: fetchFn, callCount: () => calls, lastRequest: () => lastRequest };
}

// ---------------------------------------------------------------------------
// A) 정적 identity — model/provider id가 qualification 통과 값과 정확히 일치.
// ---------------------------------------------------------------------------
function scenarioA_staticIdentity(): void {
  check("A) FINAL_REVIEWER_PRODUCTION_MODEL === 'openai/gpt-oss-120b'(qualification 통과 모델)", FINAL_REVIEWER_PRODUCTION_MODEL === "openai/gpt-oss-120b");
  check("A) FINAL_REVIEWER_PRODUCTION_PROVIDER_ID === 'groq'", FINAL_REVIEWER_PRODUCTION_PROVIDER_ID === "groq");
  check("A) finalReviewerProductionProvider.id === 'groq'", finalReviewerProductionProvider.id === "groq");
  check("A) finalReviewerProductionProvider.model === FINAL_REVIEWER_PRODUCTION_MODEL", finalReviewerProductionProvider.model === FINAL_REVIEWER_PRODUCTION_MODEL);
}

// ---------------------------------------------------------------------------
// B) 소스 회귀 — 이 selection 모듈도, gpt-reviewer.ts의 provider 기본값 지점도 OpenAI/Ollama/
//    OpenRouter/NVIDIA를 참조하지 않는다(런타임 mock으로는 "그런 경로가 아예 없다"는 부정
//    명제를 증명할 수 없다 — § claude-developer-tests.ts 소스 회귀 테스트와 동일한 기법).
// ---------------------------------------------------------------------------
function scenarioB_sourceRegressionNoOtherProviderReferenced(): void {
  const selectionSource = readFileSync(join(__dirname, "..", "src", "final-reviewer-provider-selection.ts"), "utf-8");
  const gptReviewerSource = readFileSync(join(__dirname, "..", "src", "gpt-reviewer.ts"), "utf-8");

  // 코멘트 텍스트가 아니라 실제 import 절(중괄호 안 식별자 목록)만 검사한다 — 이 파일의 설명
  // 코멘트 자체가 "openAIReviewProvider" 같은 이름을 언급할 수 있으므로 whole-file substring
  // 검사로는 오탐이 난다.
  const openAiImportMatch = selectionSource.match(/import\s*\{([^}]*)\}\s*from ["']\.\/openai-review-provider["']/);
  check(
    "B) final-reviewer-provider-selection.ts는 openai-review-provider.ts에서 OPENAI_REVIEW_RESULT_SCHEMA 상수만 재사용할 뿐 OpenAI provider 자체(createOpenAIReviewProvider/openAIReviewProvider)를 import하지 않음(silent OpenAI fallback 경로 자체가 없음)",
    openAiImportMatch !== null &&
      openAiImportMatch[1].includes("OPENAI_REVIEW_RESULT_SCHEMA") &&
      !/openAIReviewProvider|createOpenAIReviewProvider/.test(openAiImportMatch[1])
  );
  check(
    "B) final-reviewer-provider-selection.ts는 ollama-review-provider.ts를 import하지 않음",
    !/from ["']\.\/ollama-review-provider["']/.test(selectionSource)
  );
  check(
    "B) final-reviewer-provider-selection.ts는 openrouter/nvidia-nim provider를 import하지 않음",
    !/from ["']\.\/(openrouter-review-provider|nvidia-nim-review-provider)["']/.test(selectionSource)
  );
  check(
    "B) gpt-reviewer.ts의 provider 기본값이 finalReviewerProductionProvider임(소스 회귀)",
    /provider:\s*ReviewProvider\s*=\s*finalReviewerProductionProvider/.test(gptReviewerSource)
  );
  check(
    "B) gpt-reviewer.ts의 registry 기본값이 resolveFinalReviewerProductionSecurityRegistry()임(소스 회귀)",
    /securityGateOverrides\?\.registry\s*\?\?\s*resolveFinalReviewerProductionSecurityRegistry\(\)/.test(gptReviewerSource)
  );
  check("B) gpt-reviewer.ts는 더 이상 openAIReviewProvider를 import하지 않음(production default였던 참조 제거)", !/openAIReviewProvider/.test(gptReviewerSource));
}

// ---------------------------------------------------------------------------
// C) GROQ_API_KEY 없음 → provider.review() 자체가 실제 HTTP 요청 없이 즉시 거부(§ STEP 4 #1).
// ---------------------------------------------------------------------------
async function scenarioC_missingApiKeyRejectsWithoutNetworkAttempt(): Promise<void> {
  const fake = makeFakeHttpFetch(async () => ({ ok: true, response: { status: 200, bodyText: "{}" } }));
  const provider = createFinalReviewerProductionProvider({ AUTODEV_GROQ_ZDR_VERIFIED: "true" }, fake.fetch);
  const result = await provider.review({ instructions: "i", input: "j" });

  check("C) GROQ_API_KEY 없으면 provider.review()가 ok:false", result.ok === false);
  if (!result.ok) {
    check("C) errorCode=AUTH_ERROR", result.errorCode === "AUTH_ERROR");
    check("C) transient=false(재시도 대상 아님)", result.transient === false);
    check("C) requestAttempted=false(실제 요청 미전송)", result.requestAttempted === false);
  }
  check("C) 실제 HTTP fetch가 0회 호출됨(key 누락 시점에 이미 거부됨)", fake.callCount() === 0);
}

// ---------------------------------------------------------------------------
// D) AUTODEV_GROQ_ZDR_VERIFIED 없음/거짓 → Provider Security Gate가 provider.review() 호출 전에
//    BLOCK(§ STEP 4 #2/#3).
// ---------------------------------------------------------------------------
function scenarioD_missingOrFalseZdrBlocksAtSecurityGate(): void {
  for (const [label, env] of [
    ["없음", { GROQ_API_KEY: "fake-key-never-used" }],
    ["'false'", { GROQ_API_KEY: "fake-key-never-used", AUTODEV_GROQ_ZDR_VERIFIED: "false" }],
  ] as const) {
    const registry = resolveFinalReviewerProductionSecurityRegistry(env);
    const gate = evaluateProviderSecurity(
      { classification: DEFAULT_REVIEWER_DATA_CLASSIFICATION, providerId: FINAL_REVIEWER_PRODUCTION_PROVIDER_ID },
      registry
    );
    check(`D) AUTODEV_GROQ_ZDR_VERIFIED ${label} → Security Gate BLOCK`, gate.verdict === "BLOCK");
    check(`D) AUTODEV_GROQ_ZDR_VERIFIED ${label} → blockCode=RETENTION_POLICY_INSUFFICIENT`, gate.blockCode === "RETENTION_POLICY_INSUFFICIENT");
  }
}

// ---------------------------------------------------------------------------
// E) 두 조건(모두) 정상 → Security Gate PASS + Groq provider가 정확한 model로 정확히 1회
//    호출됨(§ STEP 4 #4/#5/#6/#7) — 실제 네트워크는 fake httpFetch로 완전히 대체한다.
// ---------------------------------------------------------------------------
async function scenarioE_bothConditionsMetSelectsGroqWithCorrectModel(): Promise<void> {
  const env = { GROQ_API_KEY: SECRET_MARKER, AUTODEV_GROQ_ZDR_VERIFIED: "true" };
  const registry = resolveFinalReviewerProductionSecurityRegistry(env);
  const gate = evaluateProviderSecurity(
    { classification: DEFAULT_REVIEWER_DATA_CLASSIFICATION, providerId: FINAL_REVIEWER_PRODUCTION_PROVIDER_ID },
    registry
  );
  check("E) 두 조건 모두 충족 → Security Gate PASS", gate.verdict === "PASS");

  const fake = makeFakeHttpFetch(async () => ({
    ok: true,
    response: {
      status: 200,
      bodyText: JSON.stringify({
        model: FINAL_REVIEWER_PRODUCTION_MODEL,
        choices: [{ message: { content: passOutputText() } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    },
  }));
  const provider = createFinalReviewerProductionProvider(env, fake.fetch);
  const result = await provider.review({ instructions: "i", input: "j" });

  check("E) provider.id === 'groq'", provider.id === "groq");
  check("E) provider.model === FINAL_REVIEWER_PRODUCTION_MODEL", provider.model === FINAL_REVIEWER_PRODUCTION_MODEL);
  check("E) httpFetch가 정확히 1회 호출됨", fake.callCount() === 1);
  check("E) 실제 요청 URL이 Groq chat completions endpoint", fake.lastRequest()?.url === GROQ_CHAT_COMPLETIONS_URL);
  check("E) 실제 요청 body.model이 정확히 openai/gpt-oss-120b", (fake.lastRequest()?.body as { model?: string } | undefined)?.model === FINAL_REVIEWER_PRODUCTION_MODEL);
  const sentMessages = (fake.lastRequest()?.body as { messages?: { role: string; content: string }[] } | undefined)?.messages;
  const systemContent = sentMessages?.[0]?.role === "system" ? sentMessages[0].content : undefined;
  check(
    "E) 실제 요청 system instructions에 출력 형식(필수) 지시가 포함됨(qualification이 검증한 것과 동일한 구성)",
    systemContent !== undefined && systemContent.includes("출력 형식(필수)")
  );
  check("E) system instructions에 원래 instructions('i')도 그대로 보존됨(교체가 아니라 추가)", systemContent !== undefined && systemContent.startsWith("i"));
  check("E) provider.review() ok:true", result.ok === true);
  if (result.ok) {
    check("E) 응답 model.provider === 'groq'(요청 provider와 동일)", result.model?.provider === "groq");
    check("E) 응답 model.name === FINAL_REVIEWER_PRODUCTION_MODEL(echo된 값)", result.model?.name === FINAL_REVIEWER_PRODUCTION_MODEL);
  }
}

// ---------------------------------------------------------------------------
// F) production default 경로(진짜 singleton, override 없음) — 실제 process.env를 조작해
//    gpt-reviewer.ts의 reviewClaudeResultOnce()가 override 없이도 GROQ_API_KEY 누락 시
//    fail-closed로 중단됨을 증명한다(§ STEP 4 #1을 진짜 default provider로 재확인). AUTH_ERROR는
//    실제 HTTP 요청 전에 결정되므로 네트워크 호출이 없다.
// ---------------------------------------------------------------------------
async function scenarioF_realDefaultProviderFailsClosedWithoutApiKey(): Promise<void> {
  const originalApiKey = process.env.GROQ_API_KEY;
  const originalZdr = process.env.AUTODEV_GROQ_ZDR_VERIFIED;
  delete process.env.GROQ_API_KEY;
  process.env.AUTODEV_GROQ_ZDR_VERIFIED = "true"; // Security Gate는 통과시켜 provider.review()까지 도달하게 함.
  try {
    const result = await reviewClaudeResultOnce(FAKE_RESULT, 1, SMALL_TASK); // provider/securityGateOverrides 모두 생략 — 진짜 production default.
    check("F) 진짜 default provider(override 없음) + GROQ_API_KEY 없음 → errorCode=AUTH_ERROR", result.errorCode === "AUTH_ERROR");
    check("F) decision=HUMAN_REQUIRED", result.decision === "HUMAN_REQUIRED");
    check("F) requestAttempted=false(실제 요청 미전송)", result.requestAttempted === false);
  } finally {
    if (originalApiKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalApiKey;
    if (originalZdr === undefined) delete process.env.AUTODEV_GROQ_ZDR_VERIFIED;
    else process.env.AUTODEV_GROQ_ZDR_VERIFIED = originalZdr;
  }
}

// ---------------------------------------------------------------------------
// G) transport failure(5xx) → PASS로 오판하지 않음(§ STEP 4 #8).
// ---------------------------------------------------------------------------
async function scenarioG_transportFailureNeverMisreadAsPass(): Promise<void> {
  const env = { GROQ_API_KEY: "fake-key", AUTODEV_GROQ_ZDR_VERIFIED: "true" };
  const fake = makeFakeHttpFetch(async () => ({ ok: false, reason: "HTTP 503", transient: true, status: 503 }));
  const provider = createFinalReviewerProductionProvider(env, fake.fetch);
  const registry = resolveFinalReviewerProductionSecurityRegistry(env);

  const result = await reviewClaudeResultOnce(FAKE_RESULT, 1, SMALL_TASK, undefined, undefined, undefined, undefined, undefined, undefined, provider, {
    registry,
  });
  check("G) transport failure(503) → decision !== PASS", result.decision !== "PASS");
  check("G) decision=HUMAN_REQUIRED", result.decision === "HUMAN_REQUIRED");
  check("G) errorCode=API_ERROR", result.errorCode === "API_ERROR");
  check("G) transient=true(503은 재시도 대상)", result.transient === true);
}

// ---------------------------------------------------------------------------
// H) malformed response(envelope 자체가 기대한 형태가 아님) → PASS로 오판하지 않음(§ STEP 4 #9).
// ---------------------------------------------------------------------------
async function scenarioH_malformedEnvelopeNeverMisreadAsPass(): Promise<void> {
  const env = { GROQ_API_KEY: "fake-key", AUTODEV_GROQ_ZDR_VERIFIED: "true" };
  const fake = makeFakeHttpFetch(async () => ({ ok: true, response: { status: 200, bodyText: JSON.stringify({ no_choices_field: true }) } }));
  const provider = createFinalReviewerProductionProvider(env, fake.fetch);
  const registry = resolveFinalReviewerProductionSecurityRegistry(env);

  const result = await reviewClaudeResultOnce(FAKE_RESULT, 1, SMALL_TASK, undefined, undefined, undefined, undefined, undefined, undefined, provider, {
    registry,
  });
  check("H) malformed chat-completion envelope → decision !== PASS", result.decision !== "PASS");
  check("H) errorCode=API_ERROR(envelope 문제, review JSON 문제와 구분됨)", result.errorCode === "API_ERROR");
}

// ---------------------------------------------------------------------------
// I) envelope은 정상이지만 review 본문 JSON 파싱 실패 → PASS로 오판하지 않음(§ STEP 4 #9).
// ---------------------------------------------------------------------------
async function scenarioI_malformedReviewJsonNeverMisreadAsPass(): Promise<void> {
  const env = { GROQ_API_KEY: "fake-key", AUTODEV_GROQ_ZDR_VERIFIED: "true" };
  const fake = makeFakeHttpFetch(async () => ({
    ok: true,
    response: { status: 200, bodyText: JSON.stringify({ model: FINAL_REVIEWER_PRODUCTION_MODEL, choices: [{ message: { content: "not valid json at all" } }] }) },
  }));
  const provider = createFinalReviewerProductionProvider(env, fake.fetch);
  const registry = resolveFinalReviewerProductionSecurityRegistry(env);

  const result = await reviewClaudeResultOnce(FAKE_RESULT, 1, SMALL_TASK, undefined, undefined, undefined, undefined, undefined, undefined, provider, {
    registry,
  });
  check("I) review 본문이 JSON이 아니면 decision !== PASS", result.decision !== "PASS");
  check("I) errorCode=INVALID_OUTPUT", result.errorCode === "INVALID_OUTPUT");
}

// ---------------------------------------------------------------------------
// J) Secret 미노출 — 실제 API key 값(SECRET_MARKER)이 성공/실패 어느 결과에도, Ledger entry에도
//    나타나지 않음(§ STEP 4 #10).
// ---------------------------------------------------------------------------
async function scenarioJ_apiKeyNeverExposedInObservability(): Promise<void> {
  const env = { GROQ_API_KEY: SECRET_MARKER, AUTODEV_GROQ_ZDR_VERIFIED: "true" };
  const registry = resolveFinalReviewerProductionSecurityRegistry(env);

  const fakeFail = makeFakeHttpFetch(async () => ({ ok: false, reason: "HTTP 500", transient: true, status: 500 }));
  const failingProvider = createFinalReviewerProductionProvider(env, fakeFail.fetch);
  const failResult = await reviewClaudeResultOnce(FAKE_RESULT, 1, SMALL_TASK, undefined, undefined, undefined, undefined, undefined, undefined, failingProvider, {
    registry,
  });
  const failEntry = buildGptReviewLedgerEntryInput(failResult, { projectId: "p", taskId: "t" });
  check("J) transport failure 결과에 secret marker 없음", !JSON.stringify(failResult).includes(SECRET_MARKER));
  check("J) transport failure Ledger entry에 secret marker 없음", !JSON.stringify(failEntry).includes(SECRET_MARKER));

  const fakeOk = makeFakeHttpFetch(async () => ({
    ok: true,
    response: { status: 200, bodyText: JSON.stringify({ model: FINAL_REVIEWER_PRODUCTION_MODEL, choices: [{ message: { content: passOutputText() } }] }) },
  }));
  const okProvider = createFinalReviewerProductionProvider(env, fakeOk.fetch);
  const okResult = await reviewClaudeResultOnce(FAKE_RESULT, 1, SMALL_TASK, undefined, undefined, undefined, undefined, undefined, undefined, okProvider, {
    registry,
  });
  const okEntry = buildGptReviewLedgerEntryInput(okResult, { projectId: "p", taskId: "t" });
  check("J) 성공 결과에 secret marker 없음", !JSON.stringify(okResult).includes(SECRET_MARKER));
  check("J) 성공 Ledger entry에 secret marker 없음", !JSON.stringify(okEntry).includes(SECRET_MARKER));
  check("J) 성공 시나리오는 정상 PASS(위 fail-safe 검증과 대조군)", okResult.decision === "PASS");
}

async function main(): Promise<void> {
  scenarioA_staticIdentity();
  scenarioB_sourceRegressionNoOtherProviderReferenced();
  await scenarioC_missingApiKeyRejectsWithoutNetworkAttempt();
  scenarioD_missingOrFalseZdrBlocksAtSecurityGate();
  await scenarioE_bothConditionsMetSelectsGroqWithCorrectModel();
  await scenarioF_realDefaultProviderFailsClosedWithoutApiKey();
  await scenarioG_transportFailureNeverMisreadAsPass();
  await scenarioH_malformedEnvelopeNeverMisreadAsPass();
  await scenarioI_malformedReviewJsonNeverMisreadAsPass();
  await scenarioJ_apiKeyNeverExposedInObservability();

  console.log("\n=== Production Final Reviewer Wiring(Groq) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
