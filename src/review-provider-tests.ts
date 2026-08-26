import { reviewClaudeResultOnce, reviewClaudeResultWithRetry, buildGptReviewLedgerEntryInput } from "./gpt-reviewer";
import type { GptReviewApiResult, ReviewProjectContext } from "./gpt-reviewer";
import { openAIReviewProvider, OPENAI_REVIEW_PROVIDER_ID, OPENAI_REVIEW_RESULT_SCHEMA } from "./openai-review-provider";
import type { ReviewProvider, ReviewProviderRequest, ReviewProviderResult } from "./review-provider";
import type { ProviderSecurityMetadata, ProviderSecurityRegistry } from "./provider-security-gate";
import {
  resolveOpenAiZdrVerification,
  buildOpenAiProviderSecurityMetadata,
  resolveOpenAiProviderSecurityRegistry,
} from "./openai-provider-security-metadata";
import { resolveFinalReviewerProductionSecurityRegistry } from "./final-reviewer-provider-selection";
import { runOrchestrator } from "./orchestrator";
import { DEFAULT_STATE_PATH } from "./state";
import { executeRoutingPlan } from "./agent-orchestrator";
import type { AgentOrchestratorDeps, DeveloperAgentRunner } from "./agent-orchestrator";
import { routeTask, CORE_AGENT_REGISTRY } from "./agent-registry";
import type { RoutableTaskInput } from "./agent-registry";
import type { ClaudeResult } from "./types";
import type { DeveloperResult } from "./claude-developer";
import { createSafeExecutorContext } from "./safe-executor";
import type { SafeExecutorContext } from "./safe-executor";
import type { ProjectExecutionPolicy } from "./project-policy";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Reviewer Provider Abstraction — Phase SI-3.8E (+ Security Ordering Correction).
//
// 이 파일이 실제로 증명하는 것 두 가지:
//   (1) Reviewer Core(gpt-reviewer.ts)가 이제 review-provider.ts의 ReviewProvider contract
//       하나만으로 동작하고, 그 뒤에 실제로 무엇이 있는지(OpenAI든 fake든) 알지 못한다는 것.
//   (2) Provider Security Gate(SI-3.8C)가 "seam으로만 존재"하지 않고 실제 production reviewer
//       call path(payload build → Budget Guard → Provider Security Gate → provider.review())
//       에서 항상 실행된다는 것 — 이 순서 확인이 SI-3.8E의 완료 조건이다.
//
// 어떤 시나리오도 실제 OpenAI API를 호출하지 않는다 — OPENAI_API_KEY를 프로세스 안에서만
// 일시적으로 제거해, production default(OpenAIReviewProvider)조차 실제 네트워크 요청 전에
// 로컬에서 확실히 실패하게 만든다(§ 요구사항 15 실제 외부 API 호출 0).
//
// 중요 — production default registry(resolveOpenAiProviderSecurityRegistry(), ZDR 미검증)는
// CONFIDENTIAL 등급을 zero-retention-only 정책 때문에 항상 BLOCK한다(§ Security 정책 확정,
// bounded 30일도 더 이상 충분하지 않음). 그래서 "provider.review()까지 실제로 도달하는" 기존
// Reviewer Core 동작(재시도/파싱/usage 등)을 검증하려는 시나리오는 이 기본 registry를 그대로
// 쓰지 않고, 그 시나리오의 fake provider id에 대해 명시적으로 컴플라이언트(zero retention/
// no-training/high trust) 등록 항목을 가진 override registry를 주입한다(passingSecurityOverrides
// 헬퍼) — 이 override 자체는 production 기본값을 바꾸지 않는다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const FAKE_RESULT: ClaudeResult = { success: true, summary: "테스트", changedFiles: [], tests: [], rawOutput: "" };
const SMALL_TASK = "작은 review 대상 task";
const HUGE_TASK = "H".repeat(400_000); // 기본 payload char 상한(200_000)을 확실히 초과.

function passOutputText(): string {
  return JSON.stringify({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "ok", nextTask: null });
}

interface FakeProviderHandle {
  provider: ReviewProvider;
  callCount: () => number;
  lastRequest: () => ReviewProviderRequest | undefined;
}

/** 순서대로 소비되는 응답 큐 기반 FakeReviewProvider — 큐가 비면 마지막 항목을 반복한다. */
function makeFakeProvider(responses: ReviewProviderResult[], opts: { id?: string; model?: string } = {}): FakeProviderHandle {
  let i = 0;
  let calls = 0;
  let lastRequest: ReviewProviderRequest | undefined;
  const provider: ReviewProvider = {
    id: opts.id ?? "fake-provider",
    model: opts.model ?? "fake-model-1",
    async review(request: ReviewProviderRequest): Promise<ReviewProviderResult> {
      calls += 1;
      lastRequest = request;
      const item = responses[Math.min(i, responses.length - 1)];
      i++;
      return item;
    },
  };
  return { provider, callCount: () => calls, lastRequest: () => lastRequest };
}

/** Provider Security Gate를 통과시키기 위한 완전히 컴플라이언트한 registry override — CONFIDENTIAL
 *  기본 등급 요구사항(no-training + zero retention)을 모두 만족한다. Reviewer Core 로직(재시도/
 *  파싱/usage 등)만 독립적으로 검증하려는 시나리오가 Security Gate를 의도적으로 우회하기 위해
 *  쓴다 — production 기본값(resolveFinalReviewerProductionSecurityRegistry, ZDR 미검증 시
 *  BLOCK)은 전혀 바뀌지 않는다. */
function passingSecurityOverrides(providerId: string): { registry: ProviderSecurityRegistry } {
  const metadata: ProviderSecurityMetadata = {
    providerId,
    trainingPolicy: "no-training",
    retentionPolicy: "zero",
    supportsZeroDataRetention: true,
    trustLevel: "high",
    allowedDataClassifications: ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
    policyVerifiedAt: "2026-08-25T00:00:00.000Z",
  };
  return { registry: { [providerId]: metadata } };
}

// ---------------------------------------------------------------------------
// A) OpenAI provider parity — production default가 SI-3.8D 시점과 동일한 model/schema/
//    client-failure semantics를 그대로 유지하는지(#1, #13, #14, #15).
// ---------------------------------------------------------------------------
async function scenarioA_openaiProviderParity(): Promise<void> {
  check("A) OpenAIReviewProvider.id === 'openai'", openAIReviewProvider.id === OPENAI_REVIEW_PROVIDER_ID && OPENAI_REVIEW_PROVIDER_ID === "openai");
  check("A) OpenAIReviewProvider.model === 기존 MODEL 상수('gpt-5.6')", openAIReviewProvider.model === "gpt-5.6");

  const expectedSchema = {
    type: "object",
    properties: {
      decision: { type: "string", enum: ["PASS", "REVISE", "HUMAN_REQUIRED", "BLOCK"] },
      severity: {
        type: "object",
        properties: { critical: { type: "integer" }, high: { type: "integer" }, medium: { type: "integer" } },
        required: ["critical", "high", "medium"],
        additionalProperties: false,
      },
      feedback: { type: "string" },
      nextTask: { type: ["string", "null"] },
    },
    required: ["decision", "severity", "feedback", "nextTask"],
    additionalProperties: false,
  };
  check("A) RESULT_SCHEMA가 SI-3.8D 시점과 완전히 동일함(schema unchanged)", JSON.stringify(OPENAI_REVIEW_RESULT_SCHEMA) === JSON.stringify(expectedSchema));

  // 자격증명 없이 provider를 직접 호출 — 실제 네트워크 요청 없이 client 생성 자체가 실패한다.
  // (Provider.review() 자체는 Security Gate를 전혀 모른다 — Gate는 Core의 책임이다.)
  const direct = await openAIReviewProvider.review({ instructions: "i", input: "j" });
  check("A) 직접 호출도 client 생성 실패로 ok=false", direct.ok === false);
  if (!direct.ok) {
    check("A) 직접 호출 errorCode=API_ERROR(자격증명 누락, OpenAIError)", direct.errorCode === "API_ERROR");
    check("A) 직접 호출 transient=false", direct.transient === false);
    check("A) 직접 호출 requestAttempted=false(실제 네트워크 요청 미발생)", direct.requestAttempted === false);
  }

  // Reviewer Core 기본 경로(provider/securityGateOverrides 모두 생략) — production default는
  // 이제 Fireworks Primary/Groq Escalation routing이다(§ final-reviewer-provider-selection.ts).
  // 실용형 보안 정책(§ .claude/CLAUDE.md) 이후 ZDR 미검증만으로는 Security Gate가 더 이상
  // BLOCK하지 않는다(classification이 INTERNAL로 하향돼 zero-retention 요구사항이 적용되지
  // 않음) — 이 파일 main()이 FIREWORKS_API_KEY도 제거해두므로, 실제로 도달하는 지점은
  // Fireworks provider 자신의 API key 누락 fail-closed다(client/요청 시도 자체가 없음은
  // 여전히 동일하게 보장된다 — 이는 오탐이 아니라 의도된 fail-closed 기본값이다).
  const viaCoreDefault = await reviewClaudeResultOnce(FAKE_RESULT, 1, SMALL_TASK);
  check("A) Reviewer Core 기본 경로(override 없음)는 FIREWORKS_API_KEY 누락으로 fail-closed(client 시도 자체 없음)", viaCoreDefault.errorCode === "AUTH_ERROR");
  check("A) requestAttempted=false(실제 요청 미전송)", viaCoreDefault.requestAttempted === false);

  // Security Gate를 컴플라이언트 override로 통과시키면, 그제서야 직접 호출과 동일한 결과가
  // 나와야 production default provider가 실제로 OpenAIReviewProvider임을 증명한다(#13/#23/#24
  // 의 transport-parity 기반).
  const viaCoreCompliant = await reviewClaudeResultOnce(
    FAKE_RESULT,
    1,
    SMALL_TASK,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    openAIReviewProvider,
    passingSecurityOverrides(OPENAI_REVIEW_PROVIDER_ID)
  );
  check("A) Security Gate를 통과시키면 Reviewer Core도 직접 호출과 동일하게 API_ERROR", viaCoreCompliant.errorCode === "API_ERROR");
  check("A) Security Gate 통과 후 경로도 requestAttempted=false", viaCoreCompliant.requestAttempted === false);
  check("A) Security Gate 통과 후 경로도 transient=false", viaCoreCompliant.transient === false);
}

// ---------------------------------------------------------------------------
// B) FakeReviewProvider 주입 + 성공 결과 처리 + provider/model identity + usage metadata
//    보존(#2, #3, #4, #5, #20, #21, #22). Security Gate는 컴플라이언트 override로 통과시킨다.
// ---------------------------------------------------------------------------
async function scenarioB_fakeProviderSuccessAndIdentity(): Promise<void> {
  const fake = makeFakeProvider(
    [
      {
        ok: true,
        outputText: JSON.stringify({ decision: "REVISE", severity: { critical: 1, high: 2, medium: 3 }, feedback: "issues found", nextTask: "fix X" }),
        model: { provider: "fake-provider", name: "fake-model-x-2026" },
        tokenUsage: { inputTokens: 111, cachedInputTokens: 22, outputTokens: 33, totalTokens: 144 },
      },
    ],
    { id: "fake-provider", model: "fake-model-x-2026" }
  );

  const result = await reviewClaudeResultOnce(
    FAKE_RESULT,
    1,
    SMALL_TASK,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fake.provider,
    passingSecurityOverrides("fake-provider")
  );

  check("B) FakeReviewProvider가 정확히 1회 호출됨(주입 성공)", fake.callCount() === 1);
  check("B) fake 성공 결과의 decision(REVISE)이 그대로 반영됨", result.decision === "REVISE");
  check("B) fake 성공 결과의 severity가 그대로 반영됨", result.severity.critical === 1 && result.severity.high === 2 && result.severity.medium === 3);
  check("B) fake 성공 결과의 feedback/nextTask가 그대로 반영됨", result.feedback === "issues found" && result.nextTask === "fix X");
  check("B) fake provider/model identity가 그대로 유지됨(Core가 덮어쓰지 않음)", result.model?.provider === "fake-provider" && result.model?.name === "fake-model-x-2026");
  check(
    "B) fake usage metadata가 그대로 유지됨",
    result.tokenUsage?.inputTokens === 111 &&
      result.tokenUsage?.cachedInputTokens === 22 &&
      result.tokenUsage?.outputTokens === 33 &&
      result.tokenUsage?.totalTokens === 144
  );
  check("B) 첫 review는 reviewMode=FULL로 유지됨", result.reviewMode === "FULL");
  check("B) payloadChars가 채워짐(Budget Guard가 이미 계산한 값 재사용)", typeof result.payloadChars === "number" && (result.payloadChars ?? 0) > 0);

  const entry = buildGptReviewLedgerEntryInput(result, { projectId: "p", taskId: "t", operationCycle: 1 });
  check("B) Usage Ledger provider identity 정확(fake provider가 그대로 기록됨, openai로 고정되지 않음)", entry.provider === "fake-provider");
  check("B) Usage Ledger model identity 정확(fake model이 그대로 기록됨)", entry.model === "fake-model-x-2026");
  check("B) Usage Ledger requestCount=1(성공 시 기존과 동일)", entry.requestCount === 1);
  check(
    "B) Usage Ledger token usage 정확",
    entry.inputTokens === 111 && entry.cachedInputTokens === 22 && entry.outputTokens === 33 && entry.totalTokens === 144
  );
  check("B) Usage Ledger reviewMode/payloadChars 유지", entry.reviewMode === "FULL" && entry.payloadChars === result.payloadChars);
}

// ---------------------------------------------------------------------------
// C) retryable 오류 재시도 semantics 유지(#6) — TIMEOUT x2 → 성공. Security Gate는
//    컴플라이언트 override로 통과시킨다(재시도 attempt마다 동일 override가 재사용됨을 함께
//    증명한다).
// ---------------------------------------------------------------------------
async function scenarioC_retryableErrorRetrySemantics(): Promise<void> {
  const fake = makeFakeProvider([
    { ok: false, errorCode: "TIMEOUT", transient: true, requestAttempted: true },
    { ok: false, errorCode: "TIMEOUT", transient: true, requestAttempted: true },
    { ok: true, outputText: passOutputText(), model: { provider: "fake-provider", name: "fake-model-1" } },
  ]);
  let sleepCalls = 0;
  const retryResult = await reviewClaudeResultWithRetry(FAKE_RESULT, 1, SMALL_TASK, {
    provider: fake.provider,
    securityGateOverrides: passingSecurityOverrides("fake-provider"),
    deps: { sleep: async () => { sleepCalls += 1; } },
  });
  check("C) provider.review가 정확히 3회 호출됨(2회 실패+3회째 성공)", fake.callCount() === 3);
  check("C) sleep이 정확히 2회 호출됨(재시도 간격, 기존 semantics와 동일)", sleepCalls === 2);
  check("C) 최종 decision=PASS", retryResult.decision === "PASS");
  check("C) gptTransportRetry=2(최초 시도 제외 재시도 횟수)", retryResult.gptTransportRetry === 2);
}

// ---------------------------------------------------------------------------
// D) non-retryable 오류는 재시도하지 않음(#7).
// ---------------------------------------------------------------------------
async function scenarioD_nonRetryableErrorNoRetry(): Promise<void> {
  const fake = makeFakeProvider([{ ok: false, errorCode: "QUOTA_EXCEEDED", transient: false, requestAttempted: true }]);
  let sleepCalls = 0;
  const retryResult = await reviewClaudeResultWithRetry(FAKE_RESULT, 1, SMALL_TASK, {
    provider: fake.provider,
    securityGateOverrides: passingSecurityOverrides("fake-provider"),
    deps: { sleep: async () => { sleepCalls += 1; } },
  });
  check("D) provider.review가 정확히 1회만 호출됨(재시도 없음)", fake.callCount() === 1);
  check("D) sleep 0회", sleepCalls === 0);
  check("D) 최종 errorCode=QUOTA_EXCEEDED(재분류되지 않음)", retryResult.errorCode === "QUOTA_EXCEEDED");
  check("D) gptTransportRetry=0", retryResult.gptTransportRetry === 0);
}

// ---------------------------------------------------------------------------
// E) invalid structured output semantics 유지(#8) — JSON 파싱 실패.
// ---------------------------------------------------------------------------
async function scenarioE_invalidStructuredOutput(): Promise<void> {
  const fake = makeFakeProvider([
    {
      ok: true,
      outputText: "{this is not valid json",
      model: { provider: "fake-provider", name: "fake-model-1" },
      tokenUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
    },
  ]);
  const result = await reviewClaudeResultOnce(
    FAKE_RESULT,
    1,
    SMALL_TASK,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fake.provider,
    passingSecurityOverrides("fake-provider")
  );
  check("E) errorCode=INVALID_OUTPUT", result.errorCode === "INVALID_OUTPUT");
  check("E) decision=HUMAN_REQUIRED", result.decision === "HUMAN_REQUIRED");
  check("E) feedback이 기존 문구와 동일", result.feedback === "GPT 응답 JSON 파싱 실패");
  check("E) 실제로 응답을 받았으므로 model/tokenUsage는 여전히 채워짐(응답 자체는 있었음)", result.model?.name === "fake-model-1" && result.tokenUsage?.totalTokens === 10);
}

// ---------------------------------------------------------------------------
// F) Budget Guard BLOCK → provider call 0(#9/#F.8), Budget block을 provider error로 잘못
//    기록하지 않음(#11). Security Gate가 통과할 컴플라이언트 registry를 명시적으로 함께
//    주입해도 Budget Guard가 여전히 먼저(그리고 유일하게) BLOCK함을 증명한다(§ 요구사항 8
//    Budget/Security ordering regression 없음).
// ---------------------------------------------------------------------------
async function scenarioF_budgetGuardBlocksBeforeSecurityAndProviderCall(): Promise<void> {
  const fake = makeFakeProvider([{ ok: true, outputText: passOutputText(), model: { provider: "fake-provider", name: "fake-model-1" } }]);
  const result = await reviewClaudeResultOnce(
    FAKE_RESULT,
    1,
    HUGE_TASK,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fake.provider,
    passingSecurityOverrides("fake-provider") // Security Gate만 보면 PASS했을 registry.
  );
  check("F) Budget Guard BLOCK → provider.review 호출 0회(Security가 PASS였을 registry를 줘도)", fake.callCount() === 0);
  check("F) errorCode=BUDGET_EXCEEDED(PROVIDER_SECURITY_BLOCKED로 바뀌지 않음 — Budget이 먼저 실행됨)", result.errorCode === "BUDGET_EXCEEDED");
  check("F) model/tokenUsage 없음(응답을 받은 적이 없음)", result.model === undefined && result.tokenUsage === undefined);

  const entry = buildGptReviewLedgerEntryInput(result, { projectId: "p", taskId: "t" });
  check("F) Budget BLOCK이 Ledger에 실제 API 호출(requestCount)로 기록되지 않음", entry.requestCount === 0);
  check("F) Budget BLOCK의 status가 provider errorCode가 아니라 BUDGET_EXCEEDED로 정확히 남음", entry.status === "BUDGET_EXCEEDED");
}

// ---------------------------------------------------------------------------
// G) hidden provider fallback 없음(#12) — fake provider가 실패해도 production
//    OpenAIReviewProvider로 조용히 전환되지 않는다(전환됐다면 errorCode가 API_ERROR/
//    PROVIDER_SECURITY_BLOCKED로 바뀌었을 것 — fake의 고유 errorCode가 그대로 유지되는지로
//    증명한다).
// ---------------------------------------------------------------------------
async function scenarioG_noHiddenProviderFallback(): Promise<void> {
  const originalApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY; // 만약 숨은 fallback이 있다면 실제 OpenAI 시도는 API_ERROR로 실패할 것.

  const fake = makeFakeProvider([{ ok: false, errorCode: "QUOTA_EXCEEDED", transient: false, requestAttempted: true }]);
  const result = await reviewClaudeResultOnce(
    FAKE_RESULT,
    1,
    SMALL_TASK,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fake.provider,
    passingSecurityOverrides("fake-provider")
  );

  check("G) fake provider가 정확히 1회만 호출됨(추가 fallback 호출 없음)", fake.callCount() === 1);
  check("G) 최종 errorCode가 fake의 QUOTA_EXCEEDED 그대로임(API_ERROR로 바뀌지 않음 — 숨은 fallback 없음)", result.errorCode === "QUOTA_EXCEEDED");

  if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalApiKey;
}

// ---------------------------------------------------------------------------
// J) provider.review()가 review-provider.ts 계약을 어기고 throw/reject해도(예: 계약을
//    위반한 provider 구현) Reviewer Core가 안전하게 HUMAN_REQUIRED로 수렴함(Claude
//    code-review 지적 — Core는 provider 신뢰도와 무관하게 최종 방어선이어야 한다).
// ---------------------------------------------------------------------------
async function scenarioJ_providerThrowConvertedToSafeFailure(): Promise<void> {
  let calls = 0;
  const throwingProvider: ReviewProvider = {
    id: "throwing-provider",
    model: "throwing-model",
    async review(): Promise<ReviewProviderResult> {
      calls += 1;
      throw new Error("provider가 계약을 위반하고 throw함");
    },
  };
  const result = await reviewClaudeResultOnce(
    FAKE_RESULT,
    1,
    SMALL_TASK,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    throwingProvider,
    passingSecurityOverrides("throwing-provider")
  );
  check("J) throwing provider도 정확히 1회만 호출됨", calls === 1);
  check("J) 예외가 프로세스로 전파되지 않고 안전하게 HUMAN_REQUIRED로 수렴함", result.decision === "HUMAN_REQUIRED");
  check("J) errorCode=API_ERROR(재시도 대상 아님)", result.errorCode === "API_ERROR" && result.transient === false);
  check("J) requestAttempted=false(실제로 요청이 나갔는지 알 수 없으므로 과다 집계 방지)", result.requestAttempted === false);

  const entry = buildGptReviewLedgerEntryInput(result, { projectId: "p", taskId: "t" });
  check("J) provider throw는 Ledger에 requestCount=0으로 기록됨(과다 집계 방지)", entry.requestCount === 0);
}

// ---------------------------------------------------------------------------
// K) production reviewer path: 아무 자격증명도 구성되지 않은 진짜 production 기본값(override
//    없음)으로도 provider.review()가 실제 네트워크를 시도하지 않고 fail-closed됨을 증명한다
//    (§ 요구사항 1 — production-path 검증, seam-only 아님). 실용형 보안 정책 이후 이 fail-closed
//    는 Security Gate(ZDR)가 아니라 Fireworks provider 자신의 API key 누락 검사가 담당한다.
// ---------------------------------------------------------------------------
async function scenarioK_productionPathFailsClosedBeforeProviderCall(): Promise<void> {
  const result = await reviewClaudeResultOnce(FAKE_RESULT, 1, SMALL_TASK); // 완전히 기본값 — provider/securityGateOverrides 모두 생략.
  check("K) production default(override 없음) → AUTH_ERROR(FIREWORKS_API_KEY 누락)", result.errorCode === "AUTH_ERROR");
  check("K) decision=HUMAN_REQUIRED", result.decision === "HUMAN_REQUIRED");
  check("K) transient=false(재시도 대상 아님)", result.transient === false);
  check(
    "K) model/tokenUsage 없음(실제 응답을 받은 적이 없다는 뜻 — client가 아예 시도되지 않았음의 간접 증거)",
    result.model === undefined && result.tokenUsage === undefined
  );

  // Ledger 매핑 — 로컬 preflight 실패가 provider API error로 뭉뚱그려지지 않음(#9).
  const entry = buildGptReviewLedgerEntryInput(result, { projectId: "p", taskId: "t" });
  check("K) Ledger requestCount=0(실제 API 호출로 기록되지 않음)", entry.requestCount === 0);
  check("K) Ledger status=AUTH_ERROR", entry.status === "AUTH_ERROR");
  check("K) Ledger에 token/비용 없음", entry.inputTokens === undefined && entry.estimatedCostUsd === undefined);
}

// ---------------------------------------------------------------------------
// L) CONFIDENTIAL + bounded 30일 retention(ZDR 미검증 기본값) → BLOCK(§ 요구사항 2/6).
// ---------------------------------------------------------------------------
async function scenarioL_confidentialBoundedRetentionBlocks(): Promise<void> {
  const originalZdr = process.env.AUTODEV_OPENAI_ZDR_VERIFIED;
  delete process.env.AUTODEV_OPENAI_ZDR_VERIFIED; // 명시적으로 미검증 상태로 고정.

  const metadata = buildOpenAiProviderSecurityMetadata();
  check("L) 기본 metadata: trainingPolicy=no-training", metadata.trainingPolicy === "no-training");
  check("L) 기본 metadata: retentionPolicy=bounded(ZDR 미검증)", metadata.retentionPolicy === "bounded");
  check("L) 기본 metadata: maxRetentionDays=30", metadata.maxRetentionDays === 30);
  check("L) 기본 metadata: supportsZeroDataRetention=true(제공 가능하다는 사실과 검증 상태는 별개, #6)", metadata.supportsZeroDataRetention === true);

  const fake = makeFakeProvider([{ ok: true, outputText: passOutputText(), model: { provider: "openai", name: "gpt-5.6" } }], { id: "openai" });
  const result = await reviewClaudeResultOnce(
    FAKE_RESULT,
    1,
    SMALL_TASK,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fake.provider,
    { registry: resolveOpenAiProviderSecurityRegistry() }
  );
  check("L) CONFIDENTIAL + bounded 30일(ZDR 미검증) → PROVIDER_SECURITY_BLOCKED", result.errorCode === "PROVIDER_SECURITY_BLOCKED");
  check("L) provider.review 호출 0회", fake.callCount() === 0);

  if (originalZdr === undefined) delete process.env.AUTODEV_OPENAI_ZDR_VERIFIED;
  else process.env.AUTODEV_OPENAI_ZDR_VERIFIED = originalZdr;
}

// ---------------------------------------------------------------------------
// M) CONFIDENTIAL + no-training + verified ZDR → PASS(§ 요구사항 3/7).
// ---------------------------------------------------------------------------
async function scenarioM_confidentialVerifiedZdrPasses(): Promise<void> {
  const originalZdr = process.env.AUTODEV_OPENAI_ZDR_VERIFIED;
  const originalZdrAt = process.env.AUTODEV_OPENAI_ZDR_VERIFIED_AT;
  process.env.AUTODEV_OPENAI_ZDR_VERIFIED = "true";
  process.env.AUTODEV_OPENAI_ZDR_VERIFIED_AT = "2026-08-25T00:00:00.000Z";

  const zdr = resolveOpenAiZdrVerification();
  check("M) resolveOpenAiZdrVerification: verified=true", zdr.verified === true);
  check("M) resolveOpenAiZdrVerification: verifiedAt이 구조적으로 표현됨", zdr.verifiedAt === "2026-08-25T00:00:00.000Z");

  const metadata = buildOpenAiProviderSecurityMetadata();
  check("M) verified 상태에서 retentionPolicy=zero", metadata.retentionPolicy === "zero");
  check("M) verified 상태에서 maxRetentionDays는 채워지지 않음(zero에는 불필요)", metadata.maxRetentionDays === undefined);

  const fake = makeFakeProvider([{ ok: true, outputText: passOutputText(), model: { provider: "openai", name: "gpt-5.6" } }], { id: "openai" });
  const result = await reviewClaudeResultOnce(
    FAKE_RESULT,
    1,
    SMALL_TASK,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fake.provider,
    { registry: resolveOpenAiProviderSecurityRegistry() }
  );
  check("M) CONFIDENTIAL + no-training + verified ZDR → provider.review 호출됨(PASS)", fake.callCount() === 1);
  check("M) 최종 decision=PASS", result.decision === "PASS");
  check("M) errorCode 없음(정상 처리)", result.errorCode === undefined);

  if (originalZdr === undefined) delete process.env.AUTODEV_OPENAI_ZDR_VERIFIED;
  else process.env.AUTODEV_OPENAI_ZDR_VERIFIED = originalZdr;
  if (originalZdrAt === undefined) delete process.env.AUTODEV_OPENAI_ZDR_VERIFIED_AT;
  else process.env.AUTODEV_OPENAI_ZDR_VERIFIED_AT = originalZdrAt;
}

// ---------------------------------------------------------------------------
// resolveOpenAiZdrVerification 자체의 fail-closed semantics(§ 요구사항 3 규칙: missing→false,
// invalid→false, true라고 명시된 경우에만 verified).
// ---------------------------------------------------------------------------
function scenarioZdrConfigRules(): void {
  check("ZDR-config) 미설정 → false", resolveOpenAiZdrVerification({}).verified === false);
  check("ZDR-config) 'false' 문자열 → false", resolveOpenAiZdrVerification({ AUTODEV_OPENAI_ZDR_VERIFIED: "false" }).verified === false);
  check("ZDR-config) 빈 문자열 → false", resolveOpenAiZdrVerification({ AUTODEV_OPENAI_ZDR_VERIFIED: "" }).verified === false);
  check("ZDR-config) 대소문자 다름('TRUE') → false(정확히 'true' 문자열만 허용)", resolveOpenAiZdrVerification({ AUTODEV_OPENAI_ZDR_VERIFIED: "TRUE" }).verified === false);
  check("ZDR-config) 임의 truthy 문자열('1') → false", resolveOpenAiZdrVerification({ AUTODEV_OPENAI_ZDR_VERIFIED: "1" }).verified === false);
  check("ZDR-config) 정확히 'true' → verified=true", resolveOpenAiZdrVerification({ AUTODEV_OPENAI_ZDR_VERIFIED: "true" }).verified === true);
  check(
    "ZDR-config) verified=true인데 verifiedAt이 유효하지 않은 날짜면 verifiedAt만 생략(verified 자체는 유지)",
    (() => {
      const r = resolveOpenAiZdrVerification({ AUTODEV_OPENAI_ZDR_VERIFIED: "true", AUTODEV_OPENAI_ZDR_VERIFIED_AT: "not-a-date" });
      return r.verified === true && r.verifiedAt === undefined;
    })()
  );
  check(
    "ZDR-config) verified=true + 유효한 verifiedAt → 그대로 구조적으로 반환",
    resolveOpenAiZdrVerification({ AUTODEV_OPENAI_ZDR_VERIFIED: "true", AUTODEV_OPENAI_ZDR_VERIFIED_AT: "2026-01-01T00:00:00.000Z" }).verifiedAt ===
      "2026-01-01T00:00:00.000Z"
  );
}

// ---------------------------------------------------------------------------
// N) SECRET → provider call 0(§ 요구사항 4) — 완전히 컴플라이언트한 registry를 줘도 SECRET은
//    항상 BLOCK된다(provider-security-gate.ts의 Core hard rule이 그대로 관철됨).
// ---------------------------------------------------------------------------
async function scenarioN_secretAlwaysBlocksRegardlessOfCompliantRegistry(): Promise<void> {
  const fake = makeFakeProvider([{ ok: true, outputText: passOutputText(), model: { provider: "fake-provider", name: "fake-model-1" } }]);
  const result = await reviewClaudeResultOnce(
    FAKE_RESULT,
    1,
    SMALL_TASK,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    fake.provider,
    { classification: "SECRET", registry: passingSecurityOverrides("fake-provider").registry }
  );
  check("N) SECRET → PROVIDER_SECURITY_BLOCKED(완전히 승인된 registry라도 예외 없음)", result.errorCode === "PROVIDER_SECURITY_BLOCKED");
  check("N) provider.review 호출 0회", fake.callCount() === 0);
}

// ---------------------------------------------------------------------------
// O) unknown provider(registry에 없음) → provider call 0(§ 요구사항 5), fake provider
//    injection이 Security Gate를 우회하지 못함(§ 요구사항 10).
// ---------------------------------------------------------------------------
async function scenarioO_unknownProviderBlocksAndFakeCannotBypassGate(): Promise<void> {
  const fake = makeFakeProvider([{ ok: true, outputText: passOutputText(), model: { provider: "definitely-not-openai", name: "fake-model" } }], {
    id: "definitely-not-openai",
  });
  // securityGateOverrides를 전혀 주지 않음 — production 기본 registry(Groq 하나만 앎)를 그대로 쓴다.
  const result = await reviewClaudeResultOnce(FAKE_RESULT, 1, SMALL_TASK, undefined, undefined, undefined, undefined, undefined, undefined, fake.provider);
  check("O) registry에 없는 provider → PROVIDER_SECURITY_BLOCKED", result.errorCode === "PROVIDER_SECURITY_BLOCKED");
  check("O) provider.review 호출 0회(fake provider가 Security Gate를 우회하지 못함)", fake.callCount() === 0);
}

// ---------------------------------------------------------------------------
// P) FULL/INCREMENTAL/SAFE_FULL_FALLBACK 세 모드 모두 동일 Security Gate가 적용됨(§ 요구사항
//    11) — 세 모드 전부 override 없이(production 기본값) 실행해 전부 BLOCK + provider call
//    0임을 확인한다.
// ---------------------------------------------------------------------------
const tempDirs: string[] = [];
const POLICY: ProjectExecutionPolicy = { allowedReadPrefixes: ["src/"], allowedWritePrefixes: ["src/"], allowedCommands: [] };
function makeTempGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "review-provider-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Review Provider Test"], { cwd: dir });
  return dir;
}
function writeRepoFile(repo: string, relPath: string, content: string): void {
  const abs = join(repo, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}
function commitAll(repo: string, message: string): void {
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "-q", "-m", message], { cwd: repo });
}
function makeExecutor(root: string): SafeExecutorContext {
  return createSafeExecutorContext(root, POLICY);
}
const CONTEXT: ReviewProjectContext = { projectName: "Security Gate Fixture", instructions: "규칙 없음", scopeDirs: ["src/"] };

async function scenarioP_allThreeModesApplySecurityGate(): Promise<void> {
  const repo = makeTempGitRepo("review-provider-security-modes-");
  writeRepoFile(repo, "src/fileA.ts", "export const a = 'A_V0';\n");
  commitAll(repo, "init");
  writeRepoFile(repo, "src/fileA.ts", "export const a = 'A_V1';\n");
  const executor = makeExecutor(repo);

  // FULL(첫 review, baseline 없음) — override 없음, production 기본값. 실용형 보안 정책 이후
  // 세 모드 모두 실제로 도달하는 fail-closed 지점은 Fireworks provider의 API key 누락이다(§
  // 이 파일 main()이 FIREWORKS_API_KEY를 제거해둠) — 어느 모드든 실제 네트워크를 시도하지
  // 않는다는 것 자체가 이 시나리오의 핵심 증명이다.
  const full = await reviewClaudeResultOnce(FAKE_RESULT, 1, SMALL_TASK, ["src/"], CONTEXT, executor, undefined, undefined, undefined);
  check("P) FULL round도 fail-closed 적용됨(AUTH_ERROR)", full.errorCode === "AUTH_ERROR");
  check("P) FULL round의 reviewMode=FULL", full.reviewMode === "FULL");

  // INCREMENTAL(유효한 이전 baseline) — 여기서는 buildReviewInput()으로 유효한 baseline을 직접
  // 만들어 INCREMENTAL round를 인위적으로 구성한다.
  writeRepoFile(repo, "src/fileA.ts", "export const a = 'A_V2';\n");
  const incremental = await reviewClaudeResultOnce(FAKE_RESULT, 2, SMALL_TASK, ["src/"], CONTEXT, executor, undefined, undefined, full.reviewBaseline);
  check("P) INCREMENTAL round도 fail-closed 적용됨(AUTH_ERROR)", incremental.errorCode === "AUTH_ERROR");
  check("P) INCREMENTAL round의 reviewMode=INCREMENTAL", incremental.reviewMode === "INCREMENTAL");

  // SAFE_FULL_FALLBACK(baseline이 tampered) — validateReviewBaseline이 거부하도록 baselineHash를 깨뜨린다.
  const tamperedBaseline = incremental.reviewBaseline ? { ...incremental.reviewBaseline, fileHashes: {}, baselineHash: "will-not-match" } : undefined;
  const fallback = await reviewClaudeResultOnce(FAKE_RESULT, 3, SMALL_TASK, ["src/"], CONTEXT, executor, undefined, undefined, tamperedBaseline);
  check("P) SAFE_FULL_FALLBACK round도 fail-closed 적용됨(AUTH_ERROR)", fallback.errorCode === "AUTH_ERROR");
  check("P) fallback round의 reviewMode=SAFE_FULL_FALLBACK", fallback.reviewMode === "SAFE_FULL_FALLBACK");

  check(
    "P) 세 round 모두 provider.review 호출이 없었다는 간접 증거(model/tokenUsage 전부 없음)",
    full.model === undefined && incremental.model === undefined && fallback.model === undefined
  );
}

// ---------------------------------------------------------------------------
// Q) Usage Ledger/observability — Security Gate 판정 결과 어디에도 secret 유사 값이 없음(§
//    요구사항 12). 실용형 보안 정책 이후 production 기본값(override 없음)은 더 이상 Security
//    Gate에서 BLOCK되지 않으므로(§ scenarioA/K/P), 여기서는 호출부가 명시적으로 CONFIDENTIAL을
//    요구해 provider의 INTERNAL 자기 선언으로 낮출 수 없는 실제 BLOCK 경로를 직접 구성한다(§
//    final-reviewer-provider-selection-tests.ts D와 동일한 원칙 — explicit override가 항상
//    우선한다).
// ---------------------------------------------------------------------------
async function scenarioQ_noSecretInSecurityBlockedObservability(): Promise<void> {
  const registry = resolveFinalReviewerProductionSecurityRegistry({}); // FIREWORKS_API_KEY/AUTODEV_FIREWORKS_ZDR_VERIFIED 모두 없음 → unverified.
  const result = await reviewClaudeResultOnce(
    FAKE_RESULT,
    1,
    SMALL_TASK,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { classification: "CONFIDENTIAL", registry }
  );
  check("Q) 명시적 CONFIDENTIAL 요구 + ZDR 미검증 → 실제로 BLOCK됨(이 시나리오의 전제 조건)", result.errorCode === "PROVIDER_SECURITY_BLOCKED");
  const entry = buildGptReviewLedgerEntryInput(result, { projectId: "p", taskId: "t" });
  const SECRET_MARKER = "sk-should-never-appear-anywhere";
  check("Q) GptReviewApiResult에 secret marker 없음(주입한 적 없으므로 당연히 없어야 함)", !JSON.stringify(result).includes(SECRET_MARKER));
  check("Q) Ledger entry에 secret marker 없음", !JSON.stringify(entry).includes(SECRET_MARKER));
  check("Q) feedback 문자열이 providerId/classification/blockCode 성격의 값만 담음(자유 텍스트 payload 없음)", result.feedback.includes("Provider Security Gate"));
}

// ---------------------------------------------------------------------------
// H) orchestrator.ts 경로가 동일한 provider abstraction + Security Gate를 사용함(#23) — 코드
//    변경 없이 realReviewClaudeResult(=reviewClaudeResultWithRetry)를 그대로 재사용하므로,
//    production 기본 registry(ZDR 미검증)에서 PROVIDER_SECURITY_BLOCKED로 귀결된다.
// ---------------------------------------------------------------------------
function makeTempStatePath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  const statePath = join(dir, "project-state.json");
  const initial = {
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "IDLE",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
    gitCheckpoint: "test",
    currentPhase: 0,
  };
  writeFileSync(statePath, JSON.stringify(initial, null, 2) + "\n", "utf-8");
  return statePath;
}

async function scenarioH_orchestratorUsesSameProviderAbstractionAndSecurityGate(statePath: string): Promise<void> {
  const originalDryRun = process.env.AUTOMATION_DRY_RUN;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalZdr = process.env.AUTODEV_OPENAI_ZDR_VERIFIED;
  const originalGroqApiKey = process.env.GROQ_API_KEY;
  const originalGroqZdr = process.env.AUTODEV_GROQ_ZDR_VERIFIED;
  const originalFireworksApiKey = process.env.FIREWORKS_API_KEY;
  const originalFireworksZdr = process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED;
  process.env.AUTOMATION_DRY_RUN = "false"; // 실제 gpt-reviewer.ts 경로(realReviewClaudeResult) 선택
  delete process.env.OPENAI_API_KEY;
  delete process.env.AUTODEV_OPENAI_ZDR_VERIFIED; // ZDR 미검증 기본값 고정.
  delete process.env.GROQ_API_KEY;
  delete process.env.AUTODEV_GROQ_ZDR_VERIFIED;
  delete process.env.FIREWORKS_API_KEY; // production default provider(Fireworks)도 동일하게 미구성 고정.
  delete process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED;

  try {
    let claudeCalls = 0;
    const claudeRunner = async (): Promise<ClaudeResult> => {
      claudeCalls += 1;
      return FAKE_RESULT;
    };
    const { finalState } = await runOrchestrator(SMALL_TASK, { claudeRunner, statePath });

    // 실용형 보안 정책 이후 production 기본값은 FIREWORKS_API_KEY 누락으로 fail-closed된다
    // (§ scenarioA/K/P와 동일한 이유 — ZDR 미검증만으로는 더 이상 Security Gate가 BLOCK하지
    // 않는다).
    check(
      "H) orchestrator 기본 gptReviewer(realReviewClaudeResult)도 fail-closed(AUTH_ERROR)",
      (finalState.lastGptDecision as GptReviewApiResult | null)?.errorCode === "AUTH_ERROR"
    );
    check("H) 최종 상태 WAITING_HUMAN(별도 reviewer 구현이 아님을 확인)", finalState.status === "WAITING_HUMAN");
    check(
      "H) deferredHumanTasks에 AUTH_ERROR가 기록됨",
      finalState.deferredHumanTasks.some((t) => t.startsWith("AUTH_ERROR"))
    );
    check("H) Claude worker는 1회만 호출됨", claudeCalls === 1);
  } finally {
    if (originalDryRun === undefined) delete process.env.AUTOMATION_DRY_RUN;
    else process.env.AUTOMATION_DRY_RUN = originalDryRun;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    if (originalZdr === undefined) delete process.env.AUTODEV_OPENAI_ZDR_VERIFIED;
    else process.env.AUTODEV_OPENAI_ZDR_VERIFIED = originalZdr;
    if (originalGroqApiKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalGroqApiKey;
    if (originalGroqZdr === undefined) delete process.env.AUTODEV_GROQ_ZDR_VERIFIED;
    else process.env.AUTODEV_GROQ_ZDR_VERIFIED = originalGroqZdr;
    if (originalFireworksApiKey === undefined) delete process.env.FIREWORKS_API_KEY;
    else process.env.FIREWORKS_API_KEY = originalFireworksApiKey;
    if (originalFireworksZdr === undefined) delete process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED;
    else process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED = originalFireworksZdr;
  }
}

// ---------------------------------------------------------------------------
// I) agent-orchestrator.ts 경로가 동일한 provider abstraction + Security Gate를 사용함(#24).
// ---------------------------------------------------------------------------
function req(overrides: Partial<RoutableTaskInput> = {}): RoutableTaskInput {
  return { id: "review-provider-task", description: "새 기능을 구현해줘", hasFixedRequiredTests: true, ...overrides };
}

async function scenarioI_agentOrchestratorUsesSameProviderAbstractionAndSecurityGate(): Promise<void> {
  const originalDryRun = process.env.AUTOMATION_DRY_RUN;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalZdr = process.env.AUTODEV_OPENAI_ZDR_VERIFIED;
  const originalGroqApiKey = process.env.GROQ_API_KEY;
  const originalGroqZdr = process.env.AUTODEV_GROQ_ZDR_VERIFIED;
  const originalFireworksApiKey = process.env.FIREWORKS_API_KEY;
  const originalFireworksZdr = process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED;
  process.env.AUTOMATION_DRY_RUN = "false"; // 실제 reviewerRunner(realReviewClaudeResult) 선택
  delete process.env.OPENAI_API_KEY;
  delete process.env.AUTODEV_OPENAI_ZDR_VERIFIED;
  delete process.env.GROQ_API_KEY;
  delete process.env.AUTODEV_GROQ_ZDR_VERIFIED;
  delete process.env.FIREWORKS_API_KEY; // production default provider(Fireworks)도 동일하게 미구성 고정.
  delete process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED;

  try {
    let developerCalls = 0;
    const developerRunner: DeveloperAgentRunner = async (): Promise<DeveloperResult> => {
      developerCalls += 1;
      return { success: true, summary: "[FAKE] developer 완료", changedFiles: ["file.ts"], tests: [{ name: "unit-1", pass: true }], rawOutput: "raw" };
    };

    const deps: AgentOrchestratorDeps = { developerRunner };
    const plan = routeTask(req());
    const result = await executeRoutingPlan(plan, { taskId: "review-provider-task", taskGoal: SMALL_TASK }, CORE_AGENT_REGISTRY, deps);

    const reviewerStep = result.stepResults.find((r) => r.role === "reviewer");
    check("I) developer는 정확히 1회 호출됨", developerCalls === 1);
    check(
      "I) agent-orchestrator의 기본 reviewerRunner도 fail-closed(AUTH_ERROR — FIREWORKS_API_KEY 누락)",
      (reviewerStep?.data as GptReviewApiResult | undefined)?.errorCode === "AUTH_ERROR"
    );
    check("I) overallStatus=HUMAN_APPROVAL_REQUIRED(HUMAN_REQUIRED decision 매핑)", result.overallStatus === "HUMAN_APPROVAL_REQUIRED");
  } finally {
    if (originalDryRun === undefined) delete process.env.AUTOMATION_DRY_RUN;
    else process.env.AUTOMATION_DRY_RUN = originalDryRun;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    if (originalZdr === undefined) delete process.env.AUTODEV_OPENAI_ZDR_VERIFIED;
    else process.env.AUTODEV_OPENAI_ZDR_VERIFIED = originalZdr;
    if (originalGroqApiKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalGroqApiKey;
    if (originalGroqZdr === undefined) delete process.env.AUTODEV_GROQ_ZDR_VERIFIED;
    else process.env.AUTODEV_GROQ_ZDR_VERIFIED = originalGroqZdr;
    if (originalFireworksApiKey === undefined) delete process.env.FIREWORKS_API_KEY;
    else process.env.FIREWORKS_API_KEY = originalFireworksApiKey;
    if (originalFireworksZdr === undefined) delete process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED;
    else process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED = originalFireworksZdr;
  }
}

async function main(): Promise<void> {
  const originalApiKeyOuter = process.env.OPENAI_API_KEY;
  const originalZdrOuter = process.env.AUTODEV_OPENAI_ZDR_VERIFIED;
  const originalZdrAtOuter = process.env.AUTODEV_OPENAI_ZDR_VERIFIED_AT;
  // Final Reviewer Routing(Fireworks Primary / Groq Escalation) — reviewClaudeResultOnce()의
  // production default provider/registry가 이제 Fireworks/Groq(§
  // final-reviewer-provider-selection.ts)이므로, "override 없음" 시나리오(K/P/Q/H/I 등)가
  // 정말로 fail-closed되는지는 이 프로세스의 실제 자격증명/ZDR 상태와 무관해야 한다 —
  // OPENAI_API_KEY/ZDR와 동일하게 GROQ_API_KEY/FIREWORKS_API_KEY/AUTODEV_*_ZDR_VERIFIED도 이
  // 파일 실행 동안 일시적으로 제거한다(그렇지 않으면 이 배포처럼 자격증명이 실제로 구성된
  // 환경에서는 default 경로가 실제 네트워크 요청을 시도하게 된다 — § 요구사항 15와 동일한
  // 이유). 실용형 보안 정책(§ .claude/CLAUDE.md) 이후 ZDR 미검증만으로는 더 이상 Security
  // Gate가 BLOCK하지 않으므로, "override 없음" 시나리오가 실제로 도달하는 fail-closed 지점은
  // Fireworks provider의 API key 누락이다(§ scenarioA/K/P/H/I 주석).
  const originalGroqApiKeyOuter = process.env.GROQ_API_KEY;
  const originalGroqZdrOuter = process.env.AUTODEV_GROQ_ZDR_VERIFIED;
  const originalGroqZdrAtOuter = process.env.AUTODEV_GROQ_ZDR_VERIFIED_AT;
  const originalFireworksApiKeyOuter = process.env.FIREWORKS_API_KEY;
  const originalFireworksZdrOuter = process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED;
  const originalFireworksZdrAtOuter = process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED_AT;
  delete process.env.OPENAI_API_KEY; // 이 파일 전체가 실제 네트워크 요청을 만들 수 없게 한다(§ 요구사항 15).
  delete process.env.AUTODEV_OPENAI_ZDR_VERIFIED; // 기본은 항상 ZDR 미검증 상태에서 시작.
  delete process.env.AUTODEV_OPENAI_ZDR_VERIFIED_AT;
  delete process.env.GROQ_API_KEY;
  delete process.env.AUTODEV_GROQ_ZDR_VERIFIED;
  delete process.env.AUTODEV_GROQ_ZDR_VERIFIED_AT;
  delete process.env.FIREWORKS_API_KEY;
  delete process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED;
  delete process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED_AT;

  const realStateBefore = readFileSync(DEFAULT_STATE_PATH, "utf-8");

  try {
    await scenarioA_openaiProviderParity();
    await scenarioB_fakeProviderSuccessAndIdentity();
    await scenarioC_retryableErrorRetrySemantics();
    await scenarioD_nonRetryableErrorNoRetry();
    await scenarioE_invalidStructuredOutput();
    await scenarioF_budgetGuardBlocksBeforeSecurityAndProviderCall();
    await scenarioG_noHiddenProviderFallback();
    await scenarioJ_providerThrowConvertedToSafeFailure();
    await scenarioK_productionPathFailsClosedBeforeProviderCall();
    await scenarioL_confidentialBoundedRetentionBlocks();
    await scenarioM_confidentialVerifiedZdrPasses();
    scenarioZdrConfigRules();
    await scenarioN_secretAlwaysBlocksRegardlessOfCompliantRegistry();
    await scenarioO_unknownProviderBlocksAndFakeCannotBypassGate();
    await scenarioP_allThreeModesApplySecurityGate();
    await scenarioQ_noSecretInSecurityBlockedObservability();
    await scenarioH_orchestratorUsesSameProviderAbstractionAndSecurityGate(makeTempStatePath("autodev-review-provider-orchestrator-"));
    await scenarioI_agentOrchestratorUsesSameProviderAbstractionAndSecurityGate();
  } finally {
    if (originalApiKeyOuter === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKeyOuter;
    if (originalZdrOuter === undefined) delete process.env.AUTODEV_OPENAI_ZDR_VERIFIED;
    else process.env.AUTODEV_OPENAI_ZDR_VERIFIED = originalZdrOuter;
    if (originalZdrAtOuter === undefined) delete process.env.AUTODEV_OPENAI_ZDR_VERIFIED_AT;
    else process.env.AUTODEV_OPENAI_ZDR_VERIFIED_AT = originalZdrAtOuter;
    if (originalGroqApiKeyOuter === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalGroqApiKeyOuter;
    if (originalGroqZdrOuter === undefined) delete process.env.AUTODEV_GROQ_ZDR_VERIFIED;
    else process.env.AUTODEV_GROQ_ZDR_VERIFIED = originalGroqZdrOuter;
    if (originalGroqZdrAtOuter === undefined) delete process.env.AUTODEV_GROQ_ZDR_VERIFIED_AT;
    else process.env.AUTODEV_GROQ_ZDR_VERIFIED_AT = originalGroqZdrAtOuter;
    if (originalFireworksApiKeyOuter === undefined) delete process.env.FIREWORKS_API_KEY;
    else process.env.FIREWORKS_API_KEY = originalFireworksApiKeyOuter;
    if (originalFireworksZdrOuter === undefined) delete process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED;
    else process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED = originalFireworksZdrOuter;
    if (originalFireworksZdrAtOuter === undefined) delete process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED_AT;
    else process.env.AUTODEV_FIREWORKS_ZDR_VERIFIED_AT = originalFireworksZdrAtOuter;
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 디렉터리 정리 실패는 테스트 결과에 영향 없음(OS temp는 결국 정리됨)
      }
    }
  }

  const realStateAfter = readFileSync(DEFAULT_STATE_PATH, "utf-8");
  check("project-state 격리: 실제 project-state.json이 테스트 실행 전후 완전히 동일함", realStateBefore === realStateAfter);

  console.log("\n=== Reviewer Provider Abstraction + Security Ordering Correction(SI-3.8E) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
