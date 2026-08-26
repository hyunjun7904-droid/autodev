import {
  createFinalReviewerRoutingProvider,
  detectContentEscalationCategories,
  detectPrimaryResultTrigger,
} from "./final-reviewer-routing";
import type { ReviewProvider, ReviewProviderRequest, ReviewProviderResult } from "./review-provider";
import type { ProviderSecurityGateResult } from "./provider-security-gate";

// Final Reviewer Routing(Fireworks Primary / Groq Escalation) — routing 판정 로직 자체를
// fake ReviewProvider(primary/escalation)로 독립 검증한다. 실제 Fireworks/Groq provider와의
// 배선은 final-reviewer-provider-selection-tests.ts가 검증한다 — 이 파일은 그 배선과 무관하게
// "escalation을 언제 하는가/언제 하지 않는가/Groq 결과가 최종 판정을 우선하는가/AutoDev 자체
// 오류를 숨기지 않는가"만 결정적으로 증명한다. 실제 네트워크는 어디서도 호출하지 않는다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function passResult(): ReviewProviderResult {
  return { ok: true, outputText: JSON.stringify({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "ok", nextTask: null }) };
}
function reviseResult(): ReviewProviderResult {
  return { ok: true, outputText: JSON.stringify({ decision: "REVISE", severity: { critical: 0, high: 1, medium: 0 }, feedback: "issue found", nextTask: null }) };
}
function blockResult(): ReviewProviderResult {
  return { ok: true, outputText: JSON.stringify({ decision: "BLOCK", severity: { critical: 1, high: 0, medium: 0 }, feedback: "critical issue", nextTask: null }) };
}

interface FakeHandle {
  provider: ReviewProvider;
  callCount: () => number;
}

function makeFakeProvider(id: string, responder: (req: ReviewProviderRequest) => ReviewProviderResult): FakeHandle {
  let calls = 0;
  const provider: ReviewProvider = {
    id,
    model: `${id}-model`,
    async review(req: ReviewProviderRequest): Promise<ReviewProviderResult> {
      calls += 1;
      return responder(req);
    },
  };
  return { provider, callCount: () => calls };
}

function passSecurity(): ProviderSecurityGateResult {
  return { verdict: "PASS", classification: "INTERNAL", providerId: "groq", reason: "test-pass", downstreamResults: [] };
}
function blockSecurity(): ProviderSecurityGateResult {
  return { verdict: "BLOCK", classification: "CONFIDENTIAL", providerId: "groq", blockCode: "RETENTION_POLICY_INSUFFICIENT", reason: "test-block", downstreamResults: [] };
}

const GENERAL_REQUEST: ReviewProviderRequest = { instructions: "일반 리뷰 규칙", input: "# Task\n버튼 텍스트를 수정한다\n\n# diff\n-Hello\n+Hi" };
const SECURITY_SENSITIVE_REQUEST: ReviewProviderRequest = { instructions: "일반 리뷰 규칙", input: "# Task\nadd authentication middleware for admin routes\n\n# diff\n+function checkAuthToken() {}" };
const PROVIDER_FALLBACK_REQUEST: ReviewProviderRequest = { instructions: "일반 리뷰 규칙", input: "# Task\nimplement provider fallback and reviewer routing logic\n\n# diff\n+function selectProvider() {}" };
const D8_STYLE_REQUEST: ReviewProviderRequest = { instructions: "일반 리뷰 규칙", input: "# Task\nallow insecure fallback downgrade when primary provider fails\n\n# diff\n+return { ok: true }; // downgrade" };
const RETENTION_REQUEST: ReviewProviderRequest = { instructions: "일반 리뷰 규칙", input: "# Task\nchange ZDR retention policy for prompt logging\n\n# diff\n+retentionPolicy: 'unbounded'" };

// ---------------------------------------------------------------------------
// 1) 일반 변경 + Fireworks PASS → Fireworks 1회, Groq 0회, 최종 PASS.
// ---------------------------------------------------------------------------
async function test1_normalPathFireworksPassNoEscalation(): Promise<void> {
  const fireworks = makeFakeProvider("fireworks", () => passResult());
  const groq = makeFakeProvider("groq", () => passResult());
  const routing = createFinalReviewerRoutingProvider({ primaryProvider: fireworks.provider, escalationProvider: groq.provider, escalationSecurityCheck: passSecurity });

  const result = await routing.review(GENERAL_REQUEST);
  check("1) Fireworks가 정확히 1회 호출됨", fireworks.callCount() === 1);
  check("1) Groq는 호출되지 않음(calls=0)", groq.callCount() === 0);
  check("1) 최종 decision=PASS(Fireworks 결과 그대로)", result.ok === true && JSON.parse((result as { outputText: string }).outputText).decision === "PASS");
}

// ---------------------------------------------------------------------------
// 2) Fireworks transport FAIL → Groq escalation → Groq PASS → 최종 PASS(Groq 결과 우선).
// ---------------------------------------------------------------------------
async function test2_fireworksFailGroqPassEscalates(): Promise<void> {
  const fireworks = makeFakeProvider("fireworks", () => ({ ok: false, errorCode: "API_ERROR", transient: false, requestAttempted: true }));
  const groq = makeFakeProvider("groq", () => passResult());
  const routing = createFinalReviewerRoutingProvider({ primaryProvider: fireworks.provider, escalationProvider: groq.provider, escalationSecurityCheck: passSecurity });

  const result = await routing.review(GENERAL_REQUEST);
  check("2) Fireworks 1회 호출됨", fireworks.callCount() === 1);
  check("2) Groq escalation 1회 호출됨", groq.callCount() === 1);
  check("2) 최종 decision=PASS(Groq 결과가 최종 판정)", result.ok === true && JSON.parse((result as { outputText: string }).outputText).decision === "PASS");
}

// ---------------------------------------------------------------------------
// 3) Fireworks FAIL + Groq도 FAIL(REVISE) → 최종 decision !== PASS.
// ---------------------------------------------------------------------------
async function test3_fireworksFailGroqFailNeverPass(): Promise<void> {
  const fireworks = makeFakeProvider("fireworks", () => ({ ok: false, errorCode: "API_ERROR", transient: false, requestAttempted: true }));
  const groq = makeFakeProvider("groq", () => blockResult());
  const routing = createFinalReviewerRoutingProvider({ primaryProvider: fireworks.provider, escalationProvider: groq.provider, escalationSecurityCheck: passSecurity });

  const result = await routing.review(GENERAL_REQUEST);
  check("3) Groq escalation 1회 호출됨", groq.callCount() === 1);
  check("3) 최종 decision !== PASS(BLOCK)", result.ok === true && JSON.parse((result as { outputText: string }).outputText).decision === "BLOCK");
}

// ---------------------------------------------------------------------------
// 4/5/6/7) Content 기반 escalation trigger — Fireworks PASS여도 Groq가 호출된다.
// ---------------------------------------------------------------------------
async function test4to7_contentTriggersEscalateEvenOnFireworksPass(): Promise<void> {
  const cases: [string, ReviewProviderRequest][] = [
    ["4) security-sensitive 변경", SECURITY_SENSITIVE_REQUEST],
    ["5) provider/fallback/reviewer routing 변경", PROVIDER_FALLBACK_REQUEST],
    ["6) D8-style insecure fallback downgrade", D8_STYLE_REQUEST],
    ["7) ZDR/retention 변경", RETENTION_REQUEST],
  ];
  for (const [label, request] of cases) {
    const fireworks = makeFakeProvider("fireworks", () => passResult());
    const groq = makeFakeProvider("groq", () => passResult());
    const routing = createFinalReviewerRoutingProvider({ primaryProvider: fireworks.provider, escalationProvider: groq.provider, escalationSecurityCheck: passSecurity });
    await routing.review(request);
    check(`${label} → Fireworks PASS여도 Groq escalation 발생(calls=1)`, groq.callCount() === 1);
  }
}

// ---------------------------------------------------------------------------
// 8) 일반 변경 + Fireworks PASS → Groq가 rate-limited 상태여도 애초에 호출되지 않으므로 영향 없음.
// ---------------------------------------------------------------------------
async function test8_normalChangeIgnoresGroqAvailability(): Promise<void> {
  const fireworks = makeFakeProvider("fireworks", () => passResult());
  const groq = makeFakeProvider("groq", () => ({ ok: false, errorCode: "RATE_LIMIT", transient: true, requestAttempted: true }));
  const routing = createFinalReviewerRoutingProvider({ primaryProvider: fireworks.provider, escalationProvider: groq.provider, escalationSecurityCheck: passSecurity });

  const result = await routing.review(GENERAL_REQUEST);
  check("8) Groq는 호출되지 않음(트리거 없음, 가용성과 무관)", groq.callCount() === 0);
  check("8) 최종 decision=PASS", result.ok === true && JSON.parse((result as { outputText: string }).outputText).decision === "PASS");
}

// ---------------------------------------------------------------------------
// 9) security-sensitive 변경 + Groq HTTP 429(rate limit) → HOLD(ESCALATION_REVIEWER_UNAVAILABLE),
//    429를 내부 application error로 취급하지 않고, GROQ_STATUS=RATE_LIMITED로 진단 표시한다.
// ---------------------------------------------------------------------------
async function test9_securityChangeGroqRateLimitedHolds(): Promise<void> {
  const fireworks = makeFakeProvider("fireworks", () => passResult());
  const groq = makeFakeProvider("groq", () => ({ ok: false, errorCode: "RATE_LIMIT", transient: true, requestAttempted: true, rateLimitHeaders: { "retry-after": "30" } }));
  const routing = createFinalReviewerRoutingProvider({ primaryProvider: fireworks.provider, escalationProvider: groq.provider, escalationSecurityCheck: passSecurity });

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  let result: ReviewProviderResult;
  try {
    result = await routing.review(SECURITY_SENSITIVE_REQUEST);
  } finally {
    console.log = originalLog;
  }

  check("9) Groq escalation이 실제로 시도됨(calls=1)", groq.callCount() === 1);
  check("9) 최종 errorCode=ESCALATION_REVIEWER_UNAVAILABLE", !result.ok && result.errorCode === "ESCALATION_REVIEWER_UNAVAILABLE");
  check("9) transient=false(즉시 HOLD, 재시도 루프에 진단 정보가 묻히지 않음)", !result.ok && result.transient === false);
  check("9) requestAttempted=true(Groq API가 실제로 시도됨)", !result.ok && result.requestAttempted === true);
  check("9) 로그에 GROQ_STATUS=RATE_LIMITED 표시됨", logs.some((l) => l.includes("GROQ_STATUS=RATE_LIMITED")));
  check("9) 로그에 GROQ_REASON=RATE_LIMIT_OR_QUOTA_EXHAUSTED 표시됨(429를 '일일 한도 소진'으로 단정하지 않음)", logs.some((l) => l.includes("RATE_LIMIT_OR_QUOTA_EXHAUSTED")));
  check("9) 로그 어디에도 secret 값이 없음(rateLimitHeaders만 포함, Authorization 없음)", !logs.some((l) => l.toLowerCase().includes("authorization")));
}

// ---------------------------------------------------------------------------
// 10) High/Critical(severity 기반 trigger) + Groq quota unavailable(429) → HOLD.
// ---------------------------------------------------------------------------
async function test10_highSeverityTriggerGroqUnavailableHolds(): Promise<void> {
  const fireworks = makeFakeProvider("fireworks", () => blockResult()); // severity.critical=1
  const groq = makeFakeProvider("groq", () => ({ ok: false, errorCode: "RATE_LIMIT", transient: true, requestAttempted: true }));
  const routing = createFinalReviewerRoutingProvider({ primaryProvider: fireworks.provider, escalationProvider: groq.provider, escalationSecurityCheck: passSecurity });

  const result = await routing.review(GENERAL_REQUEST); // content 트리거 없음 — severity(critical) 단독 trigger 검증.
  check("10) severity(critical) 단독으로도 escalation 발생(calls=1)", groq.callCount() === 1);
  check("10) Groq unavailable → 자동 승인 금지, HOLD(errorCode=ESCALATION_REVIEWER_UNAVAILABLE)", !result.ok && result.errorCode === "ESCALATION_REVIEWER_UNAVAILABLE");
}

// ---------------------------------------------------------------------------
// 11) Groq TIMEOUT(다른 transient 오류) → PROVIDER_UNAVAILABLE로 진단(429가 아닌 경우 RATE_LIMITED로
//     잘못 표시하지 않음).
// ---------------------------------------------------------------------------
async function test11_groqTimeoutClassifiedAsProviderUnavailableNotRateLimited(): Promise<void> {
  const fireworks = makeFakeProvider("fireworks", () => passResult());
  const groq = makeFakeProvider("groq", () => ({ ok: false, errorCode: "TIMEOUT", transient: true, requestAttempted: true }));
  const routing = createFinalReviewerRoutingProvider({ primaryProvider: fireworks.provider, escalationProvider: groq.provider, escalationSecurityCheck: passSecurity });

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.map(String).join(" "));
  let result: ReviewProviderResult;
  try {
    result = await routing.review(SECURITY_SENSITIVE_REQUEST);
  } finally {
    console.log = originalLog;
  }
  check("11) TIMEOUT도 ESCALATION_REVIEWER_UNAVAILABLE로 HOLD", !result.ok && result.errorCode === "ESCALATION_REVIEWER_UNAVAILABLE");
  check("11) 로그에 GROQ_STATUS=PROVIDER_UNAVAILABLE(429가 아니므로 RATE_LIMITED로 표시하지 않음)", logs.some((l) => l.includes("GROQ_STATUS=PROVIDER_UNAVAILABLE")));
}

// ---------------------------------------------------------------------------
// 12) 일반 변경(Groq 미호출) vs security 변경(Groq TIMEOUT) — 두 정책이 서로 다름을 함께 증명.
// ---------------------------------------------------------------------------
async function test12_generalVsSecurityPolicyDifferOnGroqUnavailable(): Promise<void> {
  const fireworksA = makeFakeProvider("fireworks", () => passResult());
  const groqA = makeFakeProvider("groq", () => ({ ok: false, errorCode: "TIMEOUT", transient: true, requestAttempted: true }));
  const routingA = createFinalReviewerRoutingProvider({ primaryProvider: fireworksA.provider, escalationProvider: groqA.provider, escalationSecurityCheck: passSecurity });
  const resultA = await routingA.review(GENERAL_REQUEST);
  check("12) 일반 변경 → Groq unavailable과 무관하게 PASS(호출 자체가 없었음)", resultA.ok === true && groqA.callCount() === 0);

  const fireworksB = makeFakeProvider("fireworks", () => passResult());
  const groqB = makeFakeProvider("groq", () => ({ ok: false, errorCode: "TIMEOUT", transient: true, requestAttempted: true }));
  const routingB = createFinalReviewerRoutingProvider({ primaryProvider: fireworksB.provider, escalationProvider: groqB.provider, escalationSecurityCheck: passSecurity });
  const resultB = await routingB.review(SECURITY_SENSITIVE_REQUEST);
  check("12) security 변경 → 같은 Groq unavailable 상황에서 HOLD(정책이 다름)", !resultB.ok && resultB.errorCode === "ESCALATION_REVIEWER_UNAVAILABLE");
}

// ---------------------------------------------------------------------------
// 14) Groq ZDR 미검증(escalationSecurityCheck BLOCK) → escalation 필요 상황에서도 Groq API 호출 0회.
// ---------------------------------------------------------------------------
async function test14_groqSecurityBlockedNeverCallsEscalationProvider(): Promise<void> {
  const fireworks = makeFakeProvider("fireworks", () => passResult());
  const groq = makeFakeProvider("groq", () => passResult());
  const routing = createFinalReviewerRoutingProvider({ primaryProvider: fireworks.provider, escalationProvider: groq.provider, escalationSecurityCheck: blockSecurity });

  const result = await routing.review(SECURITY_SENSITIVE_REQUEST);
  check("14) escalation이 필요한 상황이지만 Groq API 호출 0회(Security Gate가 먼저 막음)", groq.callCount() === 0);
  check("14) errorCode=PROVIDER_SECURITY_BLOCKED", !result.ok && result.errorCode === "PROVIDER_SECURITY_BLOCKED");
  check("14) requestAttempted=false", !result.ok && result.requestAttempted === false);
}

// ---------------------------------------------------------------------------
// 15) Secret leakage — 모든 시나리오 결과 어디에도 fake secret marker가 나타나지 않음.
// ---------------------------------------------------------------------------
async function test15_noSecretLeakage(): Promise<void> {
  const SECRET_MARKER = "gsk_test-secret-should-never-leak";
  const fireworks = makeFakeProvider("fireworks", () => ({ ok: false, errorCode: "API_ERROR", transient: false, requestAttempted: true }));
  const groq = makeFakeProvider("groq", () => ({
    ok: false,
    errorCode: "RATE_LIMIT",
    transient: true,
    requestAttempted: true,
    rateLimitHeaders: { "retry-after": "10" },
  }));
  const routing = createFinalReviewerRoutingProvider({ primaryProvider: fireworks.provider, escalationProvider: groq.provider, escalationSecurityCheck: passSecurity });
  const result = await routing.review({ instructions: `system prompt with key=${SECRET_MARKER}`, input: "diff" });
  check("15) 결과 어디에도 secret marker 없음", !JSON.stringify(result).includes(SECRET_MARKER));
}

// ---------------------------------------------------------------------------
// 16) AutoDev 자체 버그(예: content trigger 판정 함수의 예외)는 escalation으로 숨겨지지 않고
//     그대로 전파된다 — Core(gpt-reviewer.ts)의 기존 최종 방어선(try/catch)이 처리할 몫이지,
//     이 routing layer가 조용히 삼키지 않는다.
// ---------------------------------------------------------------------------
async function test16_internalBugPropagatesNotHiddenByEscalation(): Promise<void> {
  const buggyPrimary: ReviewProvider = {
    id: "fireworks",
    model: "m",
    async review(): Promise<ReviewProviderResult> {
      throw new Error("simulated AutoDev internal bug");
    },
  };
  const groq = makeFakeProvider("groq", () => passResult());
  const routing = createFinalReviewerRoutingProvider({ primaryProvider: buggyPrimary, escalationProvider: groq.provider, escalationSecurityCheck: passSecurity });

  let threw = false;
  try {
    await routing.review(GENERAL_REQUEST);
  } catch (e) {
    threw = e instanceof Error && e.message === "simulated AutoDev internal bug";
  }
  check("16) 내부 예외가 routing layer에서 삼켜지지 않고 그대로 전파됨(Core의 방어선이 처리)", threw);
  check("16) 예외 전파 중 Groq escalation으로 숨겨지지 않음(calls=0)", groq.callCount() === 0);
}

// ---------------------------------------------------------------------------
// 부가 — detectContentEscalationCategories/detectPrimaryResultTrigger 단위 검증(§ requirement의
// 최소 재현 단위).
// ---------------------------------------------------------------------------
function unitTests(): void {
  check("U) 일반 텍스트는 어떤 category도 매칭하지 않음", detectContentEscalationCategories("i", "일반 코드 변경").length === 0);
  check("U) security keyword 매칭", detectContentEscalationCategories("i", "add authentication check").includes("SECURITY_SENSITIVE"));
  check("U) provider/fallback keyword 매칭", detectContentEscalationCategories("i", "provider fallback logic").includes("PROVIDER_OR_FALLBACK_CHANGE"));
  check("U) retention/ZDR keyword 매칭", detectContentEscalationCategories("i", "zero retention policy").includes("RETENTION_OR_PRIVACY_CHANGE"));

  check("U) requestAttempted=false 실패는 escalate하지 않고 그대로 노출(설정 오류)", detectPrimaryResultTrigger({ ok: false, errorCode: "AUTH_ERROR", transient: false, requestAttempted: false }).surfacePrimaryDirectly === true);
  check("U) requestAttempted=true 실패는 escalate 대상(provider anomaly)", detectPrimaryResultTrigger({ ok: false, errorCode: "API_ERROR", transient: true, requestAttempted: true }).escalate === true);
  check("U) malformed JSON은 escalate 대상", detectPrimaryResultTrigger({ ok: true, outputText: "not json" }).escalate === true);
  check("U) decision=PASS + severity 0은 escalate 하지 않음", detectPrimaryResultTrigger(passResult()).escalate === false);
  check("U) decision=REVISE는 escalate 대상", detectPrimaryResultTrigger(reviseResult()).escalate === true);
}

async function main(): Promise<void> {
  unitTests();
  await test1_normalPathFireworksPassNoEscalation();
  await test2_fireworksFailGroqPassEscalates();
  await test3_fireworksFailGroqFailNeverPass();
  await test4to7_contentTriggersEscalateEvenOnFireworksPass();
  await test8_normalChangeIgnoresGroqAvailability();
  await test9_securityChangeGroqRateLimitedHolds();
  await test10_highSeverityTriggerGroqUnavailableHolds();
  await test11_groqTimeoutClassifiedAsProviderUnavailableNotRateLimited();
  await test12_generalVsSecurityPolicyDifferOnGroqUnavailable();
  await test14_groqSecurityBlockedNeverCallsEscalationProvider();
  await test15_noSecretLeakage();
  await test16_internalBugPropagatesNotHiddenByEscalation();

  console.log("\n=== Final Reviewer Routing(Fireworks Primary / Groq Escalation) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
