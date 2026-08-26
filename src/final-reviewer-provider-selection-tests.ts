import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FINAL_REVIEWER_PRIMARY_MODEL,
  FINAL_REVIEWER_PRIMARY_PROVIDER_ID,
  FINAL_REVIEWER_ESCALATION_MODEL,
  FINAL_REVIEWER_ESCALATION_PROVIDER_ID,
  FINAL_REVIEWER_PRODUCTION_MODEL,
  FINAL_REVIEWER_PRODUCTION_PROVIDER_ID,
  createFinalReviewerProductionProvider,
  resolveFinalReviewerProductionSecurityRegistry,
  finalReviewerProductionProvider,
} from "./final-reviewer-provider-selection";
import { FIREWORKS_CHAT_COMPLETIONS_URL } from "./fireworks-review-provider";
import { GROQ_CHAT_COMPLETIONS_URL } from "./groq-review-provider";
import { evaluateProviderSecurity } from "./provider-security-gate";
import { DEFAULT_REVIEWER_DATA_CLASSIFICATION } from "./review-provider";
import type { ChatCompletionHttpFetch, ChatCompletionHttpRequest } from "./chat-completion-review-provider";
import { reviewClaudeResultOnce, buildGptReviewLedgerEntryInput } from "./gpt-reviewer";
import type { ClaudeResult } from "./types";

// Final Reviewer Routing(Fireworks Primary / Groq Escalation) — production wiring 검증.
//
// 이 파일이 증명하는 것: gpt-reviewer.ts의 production default(override 없음)가 실제로
// final-reviewer-provider-selection.ts(Fireworks primary, accounts/fireworks/models/gpt-oss-120b)를
// 쓰고, FIREWORKS_API_KEY/AUTODEV_FIREWORKS_ZDR_VERIFIED 둘 중 하나라도 미충족이면
// fail-closed로 중단하며, 어떤 시나리오도 OpenAI/Ollama/OpenRouter/NVIDIA로 자동 전환하지
// 않는다는 것. 실제 escalation(Groq) trigger 판정 로직 자체(content keyword/severity/
// transport-anomaly 기반 escalation, rate-limit 진단 표시, "AutoDev 설정 오류를 escalation으로
// 숨기지 않는다")는 final-reviewer-routing-tests.ts가 fake provider로 독립적으로 검증한다 — 이
// 파일은 그 routing이 실제 Fireworks/Groq provider와 올바르게 배선됐는지만 확인한다. 실제
// Fireworks/Groq API는 이 파일 어디서도 호출하지 않는다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const FAKE_RESULT: ClaudeResult = { success: true, summary: "테스트", changedFiles: [], tests: [], rawOutput: "" };
const SMALL_TASK = "작은 review 대상 task";
const FIREWORKS_SECRET_MARKER = "fw-should-never-appear-anywhere-in-observability";
const GROQ_SECRET_MARKER = "gsk_should-never-appear-anywhere-in-observability";

function passOutputText(): string {
  return JSON.stringify({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "ok", nextTask: null });
}

/** 실제 네트워크를 전혀 만들지 않는 fake ChatCompletionHttpFetch — 호출 횟수/마지막 요청을
 *  provider별로 구분해 관측한다(§ Fireworks/Groq가 같은 httpFetch injection point를 공유하므로
 *  요청 url로 구분). */
function makeFakeHttpFetch(
  responder: ChatCompletionHttpFetch
): { fetch: ChatCompletionHttpFetch; callCount: () => number; requests: () => ChatCompletionHttpRequest[] } {
  const requests: ChatCompletionHttpRequest[] = [];
  const fetchFn: ChatCompletionHttpFetch = async (req) => {
    requests.push(req);
    return responder(req);
  };
  return { fetch: fetchFn, callCount: () => requests.length, requests: () => requests };
}

// ---------------------------------------------------------------------------
// A) 정적 identity — primary/escalation model/provider id가 qualification 통과 값과 정확히 일치.
// ---------------------------------------------------------------------------
function scenarioA_staticIdentity(): void {
  check("A) FINAL_REVIEWER_PRIMARY_MODEL === Fireworks qualification 통과 모델", FINAL_REVIEWER_PRIMARY_MODEL === "accounts/fireworks/models/gpt-oss-120b");
  check("A) FINAL_REVIEWER_PRIMARY_PROVIDER_ID === 'fireworks'", FINAL_REVIEWER_PRIMARY_PROVIDER_ID === "fireworks");
  check("A) FINAL_REVIEWER_ESCALATION_MODEL === Groq qualification 통과 모델", FINAL_REVIEWER_ESCALATION_MODEL === "openai/gpt-oss-120b");
  check("A) FINAL_REVIEWER_ESCALATION_PROVIDER_ID === 'groq'", FINAL_REVIEWER_ESCALATION_PROVIDER_ID === "groq");
  check("A) PRODUCTION_MODEL/PROVIDER_ID 하위호환 alias가 PRIMARY와 동일", FINAL_REVIEWER_PRODUCTION_MODEL === FINAL_REVIEWER_PRIMARY_MODEL && FINAL_REVIEWER_PRODUCTION_PROVIDER_ID === FINAL_REVIEWER_PRIMARY_PROVIDER_ID);
  check("A) finalReviewerProductionProvider.id === 'fireworks'(routing provider가 primary의 id를 그대로 씀)", finalReviewerProductionProvider.id === "fireworks");
  check("A) finalReviewerProductionProvider.model === FINAL_REVIEWER_PRIMARY_MODEL", finalReviewerProductionProvider.model === FINAL_REVIEWER_PRIMARY_MODEL);
}

// ---------------------------------------------------------------------------
// B) 소스 회귀 — OpenAI/Ollama/OpenRouter/NVIDIA를 참조하지 않는다.
// ---------------------------------------------------------------------------
function scenarioB_sourceRegressionNoOtherProviderReferenced(): void {
  const selectionSource = readFileSync(join(__dirname, "..", "src", "final-reviewer-provider-selection.ts"), "utf-8");
  const gptReviewerSource = readFileSync(join(__dirname, "..", "src", "gpt-reviewer.ts"), "utf-8");

  const openAiImportMatch = selectionSource.match(/import\s*\{([^}]*)\}\s*from ["']\.\/openai-review-provider["']/);
  check(
    "B) final-reviewer-provider-selection.ts는 openai-review-provider.ts에서 OPENAI_REVIEW_RESULT_SCHEMA 상수만 재사용할 뿐 OpenAI provider 자체를 import하지 않음(silent OpenAI fallback 경로 자체가 없음)",
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
    "B) final-reviewer-provider-selection.ts가 Fireworks/Groq 두 provider factory를 모두 import함(routing 조립 대상)",
    /from ["']\.\/fireworks-review-provider["']/.test(selectionSource) && /from ["']\.\/groq-review-provider["']/.test(selectionSource)
  );
  check(
    "B) gpt-reviewer.ts의 provider 기본값이 finalReviewerProductionProvider임(소스 회귀)",
    /provider:\s*ReviewProvider\s*=\s*finalReviewerProductionProvider/.test(gptReviewerSource)
  );
  check(
    "B) gpt-reviewer.ts의 registry 기본값이 resolveFinalReviewerProductionSecurityRegistry()임(소스 회귀)",
    /securityGateOverrides\?\.registry\s*\?\?\s*resolveFinalReviewerProductionSecurityRegistry\(\)/.test(gptReviewerSource)
  );
  check("B) gpt-reviewer.ts는 openAIReviewProvider를 import하지 않음(production default였던 참조 제거)", !/openAIReviewProvider/.test(gptReviewerSource));
}

// ---------------------------------------------------------------------------
// C) FIREWORKS_API_KEY 없음 → provider.review() 자체가 실제 HTTP 요청 없이 즉시 거부(escalation도
//    호출되지 않음 — "missing required API key"는 escalation으로 숨기지 않는다).
// ---------------------------------------------------------------------------
async function scenarioC_missingFireworksApiKeyRejectsWithoutNetworkAttempt(): Promise<void> {
  const fake = makeFakeHttpFetch(async () => ({ ok: true, response: { status: 200, bodyText: "{}" } }));
  const provider = createFinalReviewerProductionProvider({ AUTODEV_FIREWORKS_ZDR_VERIFIED: "true", GROQ_API_KEY: "unused", AUTODEV_GROQ_ZDR_VERIFIED: "true" }, fake.fetch);
  const result = await provider.review({ instructions: "i", input: "j" });

  check("C) FIREWORKS_API_KEY 없으면 provider.review()가 ok:false", result.ok === false);
  if (!result.ok) {
    check("C) errorCode=AUTH_ERROR", result.errorCode === "AUTH_ERROR");
    check("C) transient=false(재시도 대상 아님)", result.transient === false);
    check("C) requestAttempted=false(실제 요청 미전송)", result.requestAttempted === false);
  }
  check("C) 실제 HTTP fetch가 0회 호출됨(Fireworks key 누락 시점에 이미 거부, Groq escalation도 호출되지 않음)", fake.callCount() === 0);
}

// ---------------------------------------------------------------------------
// D) 실용형 보안 정책(§ .claude/CLAUDE.md) — AUTODEV_FIREWORKS_ZDR_VERIFIED 없음/거짓이어도
//    그것만으로는 더 이상 Security Gate가 BLOCK하지 않는다(provider가 스스로 classification을
//    INTERNAL로 선언 — zero-retention 요구사항이 적용되지 않는 기존 Core 등급). 단, 호출부가
//    명시적으로 CONFIDENTIAL을 요구하면(예: 실제로 더 민감한 데이터라고 판단한 경우) provider의
//    자기 선언으로 그 요구를 낮출 수 없다 — 기존 zero-retention-only 규칙이 그대로 BLOCK한다.
// ---------------------------------------------------------------------------
async function scenarioD_unverifiedZdrNoLongerBlocksButExplicitOverrideStillWins(): Promise<void> {
  const env = { FIREWORKS_API_KEY: "fake-key" }; // AUTODEV_FIREWORKS_ZDR_VERIFIED 의도적으로 미설정.
  const fake = makeFakeHttpFetch(async (req) =>
    req.url === FIREWORKS_CHAT_COMPLETIONS_URL
      ? { ok: true, response: { status: 200, bodyText: JSON.stringify({ model: FINAL_REVIEWER_PRIMARY_MODEL, choices: [{ message: { content: passOutputText() } }] }) } }
      : { ok: true, response: { status: 200, bodyText: "{}" } }
  );
  const provider = createFinalReviewerProductionProvider(env, fake.fetch);
  const registry = resolveFinalReviewerProductionSecurityRegistry(env);

  check("D) provider.reviewerDataClassification() === 'INTERNAL'(ZDR 미검증 → 자기 선언 하향, 가산점이 아니라는 뜻이지 gate라는 뜻이 아님)", provider.reviewerDataClassification?.() === "INTERNAL");

  const result = await reviewClaudeResultOnce(FAKE_RESULT, 1, SMALL_TASK, undefined, undefined, undefined, undefined, undefined, undefined, provider, {
    registry,
  });
  check("D) ZDR 미검증만으로는 더 이상 BLOCK되지 않음 → 실제 Fireworks 호출까지 도달해 PASS", result.decision === "PASS");
  check("D) Fireworks endpoint가 실제로 호출됨(Security Gate가 provider.review() 이전에 막지 않음)", fake.callCount() >= 1);

  const explicitResult = await reviewClaudeResultOnce(
    FAKE_RESULT,
    1,
    SMALL_TASK,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    provider,
    { classification: "CONFIDENTIAL", registry }
  );
  check(
    "D) 호출부가 명시적으로 CONFIDENTIAL을 요구하면 provider의 INTERNAL 자기 선언으로 낮출 수 없음 → 여전히 BLOCK(explicit override 우선)",
    explicitResult.errorCode === "PROVIDER_SECURITY_BLOCKED"
  );
}

// ---------------------------------------------------------------------------
// E) Fireworks 조건(모두) 정상 + 정상 PASS → Security Gate PASS + Fireworks provider가 정확한
//    model + JSON 출력 형식 지시로 정확히 1회 호출되고, escalation(Groq)은 호출되지 않는다.
// ---------------------------------------------------------------------------
async function scenarioE_bothConditionsMetSelectsFireworksWithCorrectModelNoEscalation(): Promise<void> {
  const env = { FIREWORKS_API_KEY: FIREWORKS_SECRET_MARKER, AUTODEV_FIREWORKS_ZDR_VERIFIED: "true" };
  const registry = resolveFinalReviewerProductionSecurityRegistry(env);
  const gate = evaluateProviderSecurity(
    { classification: DEFAULT_REVIEWER_DATA_CLASSIFICATION, providerId: FINAL_REVIEWER_PRIMARY_PROVIDER_ID },
    registry
  );
  check("E) Fireworks 조건 모두 충족 → Security Gate PASS", gate.verdict === "PASS");

  const fake = makeFakeHttpFetch(async (req) => ({
    ok: true,
    response: {
      status: 200,
      bodyText: JSON.stringify({
        model: FINAL_REVIEWER_PRIMARY_MODEL,
        choices: [{ message: { content: passOutputText() } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    },
  }));
  const provider = createFinalReviewerProductionProvider(env, fake.fetch);
  const result = await provider.review({ instructions: "i", input: "j" });

  check("E) provider.id === 'fireworks'", provider.id === "fireworks");
  check("E) provider.model === FINAL_REVIEWER_PRIMARY_MODEL", provider.model === FINAL_REVIEWER_PRIMARY_MODEL);
  check("E) httpFetch가 정확히 1회만 호출됨(escalation 없음)", fake.callCount() === 1);
  check("E) 실제 요청 URL이 Fireworks chat completions endpoint", fake.requests()[0]?.url === FIREWORKS_CHAT_COMPLETIONS_URL);
  check("E) 실제 요청 body.model이 정확히 Fireworks 모델", (fake.requests()[0]?.body as { model?: string } | undefined)?.model === FINAL_REVIEWER_PRIMARY_MODEL);
  const sentMessages = (fake.requests()[0]?.body as { messages?: { role: string; content: string }[] } | undefined)?.messages;
  const systemContent = sentMessages?.[0]?.role === "system" ? sentMessages[0].content : undefined;
  check(
    "E) 실제 요청 system instructions에 출력 형식(필수) 지시가 포함됨(qualification이 검증한 것과 동일한 구성)",
    systemContent !== undefined && systemContent.includes("출력 형식(필수)")
  );
  check("E) system instructions에 원래 instructions('i')도 그대로 보존됨(교체가 아니라 추가)", systemContent !== undefined && systemContent.startsWith("i"));
  check("E) provider.review() ok:true", result.ok === true);
  if (result.ok) {
    check("E) 응답 model.provider === 'fireworks'(요청 provider와 동일)", result.model?.provider === "fireworks");
    check("E) 응답 model.name === FINAL_REVIEWER_PRIMARY_MODEL(echo된 값)", result.model?.name === FINAL_REVIEWER_PRIMARY_MODEL);
  }
}

// ---------------------------------------------------------------------------
// F) production default 경로(진짜 singleton, override 없음) — 실제 process.env를 조작해
//    reviewClaudeResultOnce()가 override 없이도 FIREWORKS_API_KEY 누락 시 fail-closed로
//    중단됨을 증명한다. Groq escalation도 시도되지 않으므로 GROQ_API_KEY 상태와 무관하다.
// ---------------------------------------------------------------------------
async function scenarioF_realDefaultProviderFailsClosedWithoutApiKey(): Promise<void> {
  const originalApiKey = process.env.FIREWORKS_API_KEY;
  const originalZdr = process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED;
  const originalGroqApiKey = process.env.GROQ_API_KEY;
  delete process.env.FIREWORKS_API_KEY;
  process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED = "true"; // Security Gate는 통과시켜 provider.review()까지 도달하게 함.
  delete process.env.GROQ_API_KEY; // escalation이 시도되지 않아야 함을 함께 증명(설정 여부 무관).
  try {
    const result = await reviewClaudeResultOnce(FAKE_RESULT, 1, SMALL_TASK); // provider/securityGateOverrides 모두 생략 — 진짜 production default.
    check("F) 진짜 default provider(override 없음) + FIREWORKS_API_KEY 없음 → errorCode=AUTH_ERROR", result.errorCode === "AUTH_ERROR");
    check("F) decision=HUMAN_REQUIRED", result.decision === "HUMAN_REQUIRED");
    check("F) requestAttempted=false(실제 요청 미전송)", result.requestAttempted === false);
  } finally {
    if (originalApiKey === undefined) delete process.env.FIREWORKS_API_KEY;
    else process.env.FIREWORKS_API_KEY = originalApiKey;
    if (originalZdr === undefined) delete process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED;
    else process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED = originalZdr;
    if (originalGroqApiKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalGroqApiKey;
  }
}

// ---------------------------------------------------------------------------
// G) Fireworks transport failure(5xx) → escalation이 시도되지만(§ final-reviewer-routing.ts
//    PRIMARY_TRANSPORT_FAILURE) Groq도 미구성이면 그 실제 설정 오류(AUTH_ERROR)를 그대로 노출한다
//    — 어느 경우에도 PASS로 오판하지 않는다.
// ---------------------------------------------------------------------------
async function scenarioG_transportFailureEscalatesAndNeverMisreadAsPass(): Promise<void> {
  const env = { FIREWORKS_API_KEY: "fake-key", AUTODEV_FIREWORKS_ZDR_VERIFIED: "true" }; // GROQ_API_KEY 의도적으로 없음.
  const fake = makeFakeHttpFetch(async (req) =>
    req.url === FIREWORKS_CHAT_COMPLETIONS_URL ? { ok: false, reason: "HTTP 503", transient: true, status: 503 } : { ok: true, response: { status: 200, bodyText: "{}" } }
  );
  const provider = createFinalReviewerProductionProvider(env, fake.fetch);
  const registry = resolveFinalReviewerProductionSecurityRegistry(env);

  const result = await reviewClaudeResultOnce(FAKE_RESULT, 1, SMALL_TASK, undefined, undefined, undefined, undefined, undefined, undefined, provider, {
    registry,
  });
  check("G) Fireworks transport failure(503) → decision !== PASS", result.decision !== "PASS");
  check("G) decision=HUMAN_REQUIRED", result.decision === "HUMAN_REQUIRED");
  check("G) Fireworks 실패 후 escalation이 시도되어(Groq 미구성) 최종 errorCode=AUTH_ERROR로 노출됨(숨겨지지 않음)", result.errorCode === "AUTH_ERROR");
  check("G) Fireworks endpoint가 실제로 1회 호출됨(escalation 판정 이전에 primary는 항상 호출됨)", fake.requests().some((r) => r.url === FIREWORKS_CHAT_COMPLETIONS_URL));
}

// ---------------------------------------------------------------------------
// H) malformed response(envelope 자체가 기대한 형태가 아님) → escalation 시도, Groq 미구성이면
//    그 오류를 그대로 노출 → PASS로 오판하지 않음.
// ---------------------------------------------------------------------------
async function scenarioH_malformedEnvelopeEscalatesAndNeverMisreadAsPass(): Promise<void> {
  const env = { FIREWORKS_API_KEY: "fake-key", AUTODEV_FIREWORKS_ZDR_VERIFIED: "true" };
  const fake = makeFakeHttpFetch(async (req) =>
    req.url === FIREWORKS_CHAT_COMPLETIONS_URL
      ? { ok: true, response: { status: 200, bodyText: JSON.stringify({ no_choices_field: true }) } }
      : { ok: true, response: { status: 200, bodyText: "{}" } }
  );
  const provider = createFinalReviewerProductionProvider(env, fake.fetch);
  const registry = resolveFinalReviewerProductionSecurityRegistry(env);

  const result = await reviewClaudeResultOnce(FAKE_RESULT, 1, SMALL_TASK, undefined, undefined, undefined, undefined, undefined, undefined, provider, {
    registry,
  });
  check("H) malformed Fireworks envelope → decision !== PASS", result.decision !== "PASS");
  check("H) escalation 시도(Groq 미구성) → errorCode=AUTH_ERROR로 노출됨", result.errorCode === "AUTH_ERROR");
}

// ---------------------------------------------------------------------------
// I) 두 provider 모두 정상 구성 + Fireworks가 non-PASS(REVISE) → Groq escalation이 실제로
//    호출되고, Groq의 PASS 결과가 최종 판정을 우선한다.
// ---------------------------------------------------------------------------
async function scenarioI_fireworksRevisesGroqEscalatesAndWins(): Promise<void> {
  const env = { FIREWORKS_API_KEY: "fake-fw-key", AUTODEV_FIREWORKS_ZDR_VERIFIED: "true", GROQ_API_KEY: "fake-groq-key", AUTODEV_GROQ_ZDR_VERIFIED: "true" };
  const reviseOutputText = JSON.stringify({ decision: "REVISE", severity: { critical: 0, high: 1, medium: 0 }, feedback: "fireworks flagged an issue", nextTask: null });
  const fake = makeFakeHttpFetch(async (req) => {
    if (req.url === FIREWORKS_CHAT_COMPLETIONS_URL) {
      return { ok: true, response: { status: 200, bodyText: JSON.stringify({ model: FINAL_REVIEWER_PRIMARY_MODEL, choices: [{ message: { content: reviseOutputText } }] }) } };
    }
    return { ok: true, response: { status: 200, bodyText: JSON.stringify({ model: FINAL_REVIEWER_ESCALATION_MODEL, choices: [{ message: { content: passOutputText() } }] }) } };
  });
  const provider = createFinalReviewerProductionProvider(env, fake.fetch);
  const registry = resolveFinalReviewerProductionSecurityRegistry(env);

  const result = await reviewClaudeResultOnce(FAKE_RESULT, 1, SMALL_TASK, undefined, undefined, undefined, undefined, undefined, undefined, provider, {
    registry,
  });
  check("I) Fireworks REVISE → escalation 발생 → Groq PASS가 최종 판정", result.decision === "PASS");
  check("I) Fireworks endpoint 1회 호출됨", fake.requests().filter((r) => r.url === FIREWORKS_CHAT_COMPLETIONS_URL).length === 1);
  check("I) Groq endpoint 1회 호출됨(escalation)", fake.requests().filter((r) => r.url === GROQ_CHAT_COMPLETIONS_URL).length === 1);
  check("I) 최종 응답 model.provider === 'groq'(escalation 응답이 그대로 반영됨)", result.model?.provider === "groq");
}

// ---------------------------------------------------------------------------
// J) Secret 미노출 — Fireworks/Groq API key 값이 성공/실패 어느 결과에도, Ledger entry에도
//    나타나지 않음.
// ---------------------------------------------------------------------------
async function scenarioJ_apiKeysNeverExposedInObservability(): Promise<void> {
  const env = { FIREWORKS_API_KEY: FIREWORKS_SECRET_MARKER, AUTODEV_FIREWORKS_ZDR_VERIFIED: "true", GROQ_API_KEY: GROQ_SECRET_MARKER, AUTODEV_GROQ_ZDR_VERIFIED: "true" };
  const registry = resolveFinalReviewerProductionSecurityRegistry(env);

  const fakeFail = makeFakeHttpFetch(async () => ({ ok: false, reason: "HTTP 500", transient: true, status: 500 }));
  const failingProvider = createFinalReviewerProductionProvider(env, fakeFail.fetch);
  const failResult = await reviewClaudeResultOnce(FAKE_RESULT, 1, SMALL_TASK, undefined, undefined, undefined, undefined, undefined, undefined, failingProvider, {
    registry,
  });
  const failEntry = buildGptReviewLedgerEntryInput(failResult, { projectId: "p", taskId: "t" });
  check("J) transport failure 결과에 Fireworks secret marker 없음", !JSON.stringify(failResult).includes(FIREWORKS_SECRET_MARKER));
  check("J) transport failure 결과에 Groq secret marker 없음", !JSON.stringify(failResult).includes(GROQ_SECRET_MARKER));
  check("J) transport failure Ledger entry에 secret marker 없음", !JSON.stringify(failEntry).includes(FIREWORKS_SECRET_MARKER) && !JSON.stringify(failEntry).includes(GROQ_SECRET_MARKER));

  const fakeOk = makeFakeHttpFetch(async () => ({
    ok: true,
    response: { status: 200, bodyText: JSON.stringify({ model: FINAL_REVIEWER_PRIMARY_MODEL, choices: [{ message: { content: passOutputText() } }] }) },
  }));
  const okProvider = createFinalReviewerProductionProvider(env, fakeOk.fetch);
  const okResult = await reviewClaudeResultOnce(FAKE_RESULT, 1, SMALL_TASK, undefined, undefined, undefined, undefined, undefined, undefined, okProvider, {
    registry,
  });
  const okEntry = buildGptReviewLedgerEntryInput(okResult, { projectId: "p", taskId: "t" });
  check("J) 성공 결과에 secret marker 없음", !JSON.stringify(okResult).includes(FIREWORKS_SECRET_MARKER) && !JSON.stringify(okResult).includes(GROQ_SECRET_MARKER));
  check("J) 성공 Ledger entry에 secret marker 없음", !JSON.stringify(okEntry).includes(FIREWORKS_SECRET_MARKER) && !JSON.stringify(okEntry).includes(GROQ_SECRET_MARKER));
  check("J) 성공 시나리오는 정상 PASS(위 fail-safe 검증과 대조군)", okResult.decision === "PASS");
}

async function main(): Promise<void> {
  scenarioA_staticIdentity();
  scenarioB_sourceRegressionNoOtherProviderReferenced();
  await scenarioC_missingFireworksApiKeyRejectsWithoutNetworkAttempt();
  await scenarioD_unverifiedZdrNoLongerBlocksButExplicitOverrideStillWins();
  await scenarioE_bothConditionsMetSelectsFireworksWithCorrectModelNoEscalation();
  await scenarioF_realDefaultProviderFailsClosedWithoutApiKey();
  await scenarioG_transportFailureEscalatesAndNeverMisreadAsPass();
  await scenarioH_malformedEnvelopeEscalatesAndNeverMisreadAsPass();
  await scenarioI_fireworksRevisesGroqEscalatesAndWins();
  await scenarioJ_apiKeysNeverExposedInObservability();

  console.log("\n=== Final Reviewer Routing(Fireworks Primary / Groq Escalation) Production Wiring 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
