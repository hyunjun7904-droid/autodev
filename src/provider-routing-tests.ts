import {
  routeReviewerProvider,
  buildFallbackRoutingRequest,
  buildRoutingDecisionLedgerEntryInput,
} from "./provider-routing";
import type { RoutingCandidate, RoutingRequest } from "./provider-routing";
import type { ProviderPoolEntry } from "./provider-pool";
import { toProviderSecurityRegistry } from "./provider-pool";
import type { ProviderSecurityMetadata, ProviderSecurityRegistry } from "./provider-security-gate";
import { buildRealProviderPool, resolveRealProviderPoolSecurityRegistry } from "./real-provider-pool";
import { OLLAMA_PROVIDER_ID, NVIDIA_NIM_PROVIDER_ID } from "./provider-pool-security-metadata";
import { openAIReviewProvider, OPENAI_REVIEW_PROVIDER_ID } from "./openai-review-provider";

// Security-aware Provider Routing & Fallback Tests — Phase SI-3.8G.
//
// 이 파일은 실제 외부 AI/API를 전혀 호출하지 않는다 — provider-routing.ts의 모든 함수는
// 로컬 계산만 하는 순수 함수다(§ 요구사항 40 "real external API calls 0"). runtimeStatus/
// quotaState는 전부 이 파일이 고정 fixture로 직접 주입한다(probe 실행 없음).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const NOW = "2026-08-25T00:00:00.000Z";

function security(overrides: Partial<ProviderSecurityMetadata> & { providerId: string }): ProviderSecurityMetadata {
  return {
    trainingPolicy: "no-training",
    retentionPolicy: "zero",
    supportsZeroDataRetention: true,
    trustLevel: "high",
    allowedDataClassifications: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
    policyVerifiedAt: NOW,
    costTier: "free",
    ...overrides,
  };
}

function poolEntry(overrides: Partial<ProviderPoolEntry> & { providerId: string; security: ProviderSecurityMetadata }): ProviderPoolEntry {
  return {
    providerType: "direct-external",
    reviewProviderCapability: true,
    approvalStatus: "APPROVED",
    policySource: ["https://example.com/policy"],
    policyVerifiedAt: NOW,
    qualityTier: "capable",
    downstreamProviderRequired: false,
    ...overrides,
  };
}

function candidate(entry: ProviderPoolEntry, overrides: Partial<Omit<RoutingCandidate, "entry">> = {}): RoutingCandidate {
  return { entry, runtimeStatus: "AVAILABLE", quotaState: "AVAILABLE", ...overrides };
}

function baseRequest(overrides: Partial<RoutingRequest> = {}): RoutingRequest {
  return {
    reviewerRole: "PRE_REVIEW",
    dataClassification: "CONFIDENTIAL",
    minimumQualityTier: "basic",
    allowPaidProvider: false,
    budgetState: "AVAILABLE",
    ...overrides,
  };
}

function registryOf(...entries: ProviderPoolEntry[]): ProviderSecurityRegistry {
  return toProviderSecurityRegistry(entries);
}

// =========================================================
// 1) Security > Quality > Cost ordering.
// =========================================================
function scenario1_priorityOrdering(): void {
  const insecureButFreeAndFrontier = poolEntry({
    providerId: "insecure-frontier-free",
    security: security({ providerId: "insecure-frontier-free", trainingPolicy: "unknown" }),
    qualityTier: "frontier",
  });
  const secureButLowerQualityAndPaid = poolEntry({
    providerId: "secure-basic-paid",
    security: security({ providerId: "secure-basic-paid", costTier: "paid" }),
    qualityTier: "basic",
  });
  const req = baseRequest({ minimumQualityTier: "basic", allowPaidProvider: true, budgetState: "AVAILABLE" });
  const result = routeReviewerProvider(
    req,
    [candidate(insecureButFreeAndFrontier), candidate(secureButLowerQualityAndPaid)],
    registryOf(insecureButFreeAndFrontier, secureButLowerQualityAndPaid)
  );
  check("1) Security가 Quality/Cost보다 우선 — insecure 후보는 frontier+free여도 탈락", result.rejectedCandidates.some((r) => r.providerId === "insecure-frontier-free"));
  check("1) 결과적으로 secure한(더 낮은 quality, paid) 후보가 선택됨", result.outcome === "SELECTED" && result.selectedProviderId === "secure-basic-paid");

  const freeButTooLowQuality = poolEntry({ providerId: "free-basic", security: security({ providerId: "free-basic" }), qualityTier: "basic" });
  const paidButSufficientQuality = poolEntry({
    providerId: "paid-capable",
    security: security({ providerId: "paid-capable", costTier: "paid" }),
    qualityTier: "capable",
  });
  const req2 = baseRequest({ minimumQualityTier: "capable", allowPaidProvider: true, budgetState: "AVAILABLE" });
  const result2 = routeReviewerProvider(req2, [candidate(freeButTooLowQuality), candidate(paidButSufficientQuality)], registryOf(freeButTooLowQuality, paidButSufficientQuality));
  check("1) Quality가 Cost보다 우선 — 더 저렴한 후보가 quality 미달이면 탈락", result2.outcome === "SELECTED" && result2.selectedProviderId === "paid-capable");
}

// =========================================================
// 2) cheaper insecure provider rejected.
// =========================================================
function scenario2_cheaperInsecureRejected(): void {
  const cheapInsecure = poolEntry({ providerId: "cheap-insecure", security: security({ providerId: "cheap-insecure", retentionPolicy: "unknown" }) });
  const result = routeReviewerProvider(baseRequest(), [candidate(cheapInsecure)], registryOf(cheapInsecure));
  check("2) retentionPolicy unknown인 free 후보는 선택되지 않음", result.outcome !== "SELECTED");
  check("2) 사유가 SECURITY_BLOCKED로 기록됨", result.rejectedCandidates[0]?.code === "SECURITY_BLOCKED");
}

// =========================================================
// 3) free but insufficient-quality provider rejected.
// =========================================================
function scenario3_insufficientQualityRejected(): void {
  const freeBasic = poolEntry({ providerId: "free-basic-2", security: security({ providerId: "free-basic-2" }), qualityTier: "basic" });
  const result = routeReviewerProvider(baseRequest({ minimumQualityTier: "capable" }), [candidate(freeBasic)], registryOf(freeBasic));
  check("3) free지만 qualityTier 미달이면 탈락", result.outcome === "QUALITY_REQUIREMENT_UNMET");
  check("3) rejectedCandidates에 QUALITY_REQUIREMENT_UNMET 기록", result.rejectedCandidates[0]?.code === "QUALITY_REQUIREMENT_UNMET");
}

// =========================================================
// 4) secure quality-sufficient free provider selected.
// =========================================================
function scenario4_secureSufficientFreeSelected(): void {
  const good = poolEntry({ providerId: "good-free", security: security({ providerId: "good-free" }), qualityTier: "capable" });
  const result = routeReviewerProvider(baseRequest({ minimumQualityTier: "capable" }), [candidate(good)], registryOf(good));
  check("4) 안전하고 품질 충분한 free 후보가 선택됨", result.outcome === "SELECTED" && result.selectedProviderId === "good-free");
}

// =========================================================
// 5) unknown-policy provider never selected.
// =========================================================
function scenario5_unknownPolicyNeverSelected(): void {
  const unknownPolicy = poolEntry({ providerId: "unknown-policy", security: security({ providerId: "unknown-policy", trainingPolicy: "unknown", retentionPolicy: "unknown" }) });
  const result = routeReviewerProvider(baseRequest({ dataClassification: "PUBLIC" }), [candidate(unknownPolicy)], registryOf(unknownPolicy));
  check("5) trainingPolicy/retentionPolicy unknown이면 PUBLIC 등급이어도 선택되지 않음", result.outcome !== "SELECTED");
}

// =========================================================
// 6) POLICY_UNKNOWN NVIDIA never selected.
// =========================================================
function scenario6_nvidiaPolicyUnknownNeverSelected(): void {
  const pool = buildRealProviderPool();
  const nvidia = pool.find((e) => e.providerId === NVIDIA_NIM_PROVIDER_ID)!;
  const registry = resolveRealProviderPoolSecurityRegistry();
  const result = routeReviewerProvider(baseRequest({ dataClassification: "PUBLIC", minimumQualityTier: "unknown" }), [candidate(nvidia)], registry);
  check("6) 실제 NVIDIA NIM catalog entry(POLICY_UNKNOWN)는 어떤 등급에서도 선택되지 않음", result.outcome !== "SELECTED");
  check("6) 탈락 사유가 PROVIDER_POLICY_UNKNOWN", result.rejectedCandidates[0]?.code === "PROVIDER_POLICY_UNKNOWN");
}

// =========================================================
// 7) NOT_CONFIGURED provider never selected.
// =========================================================
function scenario7_notConfiguredNeverSelected(): void {
  const entry = poolEntry({ providerId: "not-configured", security: security({ providerId: "not-configured" }) });
  const result = routeReviewerProvider(baseRequest(), [candidate(entry, { runtimeStatus: "NOT_CONFIGURED" })], registryOf(entry));
  check("7) NOT_CONFIGURED 후보는 선택되지 않음", result.outcome === "PROVIDER_NOT_CONFIGURED");
}

// =========================================================
// 8) UNAVAILABLE provider never selected.
// =========================================================
function scenario8_unavailableNeverSelected(): void {
  const entry = poolEntry({ providerId: "unavailable", security: security({ providerId: "unavailable" }) });
  const result = routeReviewerProvider(baseRequest(), [candidate(entry, { runtimeStatus: "UNAVAILABLE" })], registryOf(entry));
  check("8) UNAVAILABLE 후보는 선택되지 않음", result.outcome === "PROVIDER_UNAVAILABLE");
}

// =========================================================
// 9) SECRET external providers all rejected.
// =========================================================
function scenario9_secretAlwaysRejected(): void {
  const perfect = poolEntry({ providerId: "perfect", security: security({ providerId: "perfect" }) });
  const router = poolEntry({
    providerId: "router-1",
    providerType: "router",
    security: security({ providerId: "router-1" }),
    downstreamProviderRequired: true,
    downstreamProviderIds: ["perfect"],
  });
  const result = routeReviewerProvider(baseRequest({ dataClassification: "SECRET" }), [candidate(perfect), candidate(router)], registryOf(perfect, router));
  check("9) SECRET 등급은 어떤 provider(router 포함)에도 선택되지 않음", result.outcome !== "SELECTED");
  check("9) 모든 후보가 SECURITY_BLOCKED로 탈락", result.rejectedCandidates.every((r) => r.code === "SECURITY_BLOCKED"));
}

// =========================================================
// 10) CONFIDENTIAL non-ZDR external rejected / 11) verified-ZDR allowed.
// =========================================================
function scenario10_11_confidentialRetention(): void {
  const nonZdr = poolEntry({
    providerId: "non-zdr",
    security: security({ providerId: "non-zdr", retentionPolicy: "bounded", maxRetentionDays: 30, allowedDataClassifications: ["PUBLIC", "INTERNAL", "CONFIDENTIAL"] }),
  });
  const resultNonZdr = routeReviewerProvider(baseRequest({ dataClassification: "CONFIDENTIAL" }), [candidate(nonZdr)], registryOf(nonZdr));
  check("10) CONFIDENTIAL + bounded retention(non-ZDR)은 탈락", resultNonZdr.outcome !== "SELECTED");

  const zdr = poolEntry({
    providerId: "zdr-verified",
    security: security({ providerId: "zdr-verified", retentionPolicy: "zero", allowedDataClassifications: ["PUBLIC", "INTERNAL", "CONFIDENTIAL"] }),
  });
  const resultZdr = routeReviewerProvider(baseRequest({ dataClassification: "CONFIDENTIAL" }), [candidate(zdr)], registryOf(zdr));
  check("11) CONFIDENTIAL + verified zero retention은 선택 가능", resultZdr.outcome === "SELECTED" && resultZdr.selectedProviderId === "zdr-verified");
}

// =========================================================
// 12) RESTRICTED insufficient-trust external rejected.
// =========================================================
function scenario12_restrictedInsufficientTrust(): void {
  const mediumTrust = poolEntry({ providerId: "medium-trust", security: security({ providerId: "medium-trust", trustLevel: "medium" }) });
  const result = routeReviewerProvider(baseRequest({ dataClassification: "RESTRICTED" }), [candidate(mediumTrust)], registryOf(mediumTrust));
  check("12) RESTRICTED + trustLevel=medium은 탈락", result.outcome !== "SELECTED");
}

// =========================================================
// 13/14/15) router downstream 검증.
// =========================================================
function scenario13_14_15_routerDownstream(): void {
  const noDownstream = poolEntry({ providerId: "router-no-downstream", providerType: "router", security: security({ providerId: "router-no-downstream" }), downstreamProviderRequired: true });
  const resultNoDownstream = routeReviewerProvider(baseRequest(), [candidate(noDownstream)], registryOf(noDownstream));
  check("13) downstream unknown(빈 목록)인 router는 탈락", resultNoDownstream.outcome !== "SELECTED");

  const insecureDownstream = poolEntry({ providerId: "insecure-downstream", security: security({ providerId: "insecure-downstream", trainingPolicy: "unknown" }) });
  const routerInsecure = poolEntry({
    providerId: "router-insecure-downstream",
    providerType: "router",
    security: security({ providerId: "router-insecure-downstream" }),
    downstreamProviderRequired: true,
    downstreamProviderIds: ["insecure-downstream"],
  });
  const resultInsecureDownstream = routeReviewerProvider(baseRequest(), [candidate(routerInsecure)], registryOf(routerInsecure, insecureDownstream));
  check("14) downstream이 insecure면 router 전체가 탈락", resultInsecureDownstream.outcome !== "SELECTED");

  const secureDownstream = poolEntry({ providerId: "secure-downstream", security: security({ providerId: "secure-downstream" }) });
  const routerApproved = poolEntry({
    providerId: "router-approved",
    providerType: "router",
    security: security({ providerId: "router-approved" }),
    downstreamProviderRequired: true,
    downstreamProviderIds: ["secure-downstream"],
  });
  const resultApproved = routeReviewerProvider(baseRequest(), [candidate(routerApproved)], registryOf(routerApproved, secureDownstream));
  check("15) downstream이 approved면 router가 선택 가능", resultApproved.outcome === "SELECTED" && resultApproved.selectedProviderId === "router-approved");
}

// =========================================================
// 16/17) fallback — primary unavailable/rate-limited.
// =========================================================
function scenario16_17_safeFallback(): void {
  const primary = poolEntry({ providerId: "primary", security: security({ providerId: "primary" }) });
  const secondary = poolEntry({ providerId: "secondary", security: security({ providerId: "secondary" }) });
  const registry = registryOf(primary, secondary);

  const initialReq = baseRequest();
  const initialResult = routeReviewerProvider(initialReq, [candidate(primary, { runtimeStatus: "UNAVAILABLE" }), candidate(secondary)], registry);
  check("16) primary UNAVAILABLE이면 secondary가 즉시 선택됨(다른 요청 없이도)", initialResult.outcome === "SELECTED" && initialResult.selectedProviderId === "secondary");

  const fallbackReq = buildFallbackRoutingRequest(initialReq, "primary", "UNAVAILABLE");
  const fallbackResult = routeReviewerProvider(fallbackReq, [candidate(primary), candidate(secondary)], registry);
  check("16) fallback 요청은 primary를 EXCLUDED_BY_REQUEST로 제거하고 secondary를 선택", fallbackResult.outcome === "SELECTED" && fallbackResult.selectedProviderId === "secondary");
  check("16) fallbackUsed=true, fallbackReason 보존", fallbackResult.fallbackUsed === true && fallbackResult.fallbackReason === "UNAVAILABLE");

  const rateLimitedReq = buildFallbackRoutingRequest(initialReq, "primary", "RATE_LIMITED");
  const rateLimitedResult = routeReviewerProvider(rateLimitedReq, [candidate(primary, { quotaState: "EXHAUSTED" }), candidate(secondary)], registry);
  check("17) primary rate-limited(quota exhausted) fallback → secondary 선택", rateLimitedResult.outcome === "SELECTED" && rateLimitedResult.selectedProviderId === "secondary");
}

// =========================================================
// 18/19) fallback이 Security/Quality를 완화하지 않음.
// =========================================================
function scenario18_19_fallbackNoDowngrade(): void {
  const primary = poolEntry({ providerId: "primary-2", security: security({ providerId: "primary-2" }) });
  const insecureFallback = poolEntry({ providerId: "insecure-fallback", security: security({ providerId: "insecure-fallback", trainingPolicy: "unknown" }) });
  const initialReq = baseRequest({ dataClassification: "CONFIDENTIAL" });
  const fallbackReq = buildFallbackRoutingRequest(initialReq, "primary-2", "UNAVAILABLE");
  const result = routeReviewerProvider(fallbackReq, [candidate(primary), candidate(insecureFallback)], registryOf(primary, insecureFallback));
  check("18) fallback 후보도 security 기준 완화 없이 탈락", result.outcome !== "SELECTED");

  const lowQualityFallback = poolEntry({ providerId: "low-quality-fallback", security: security({ providerId: "low-quality-fallback" }), qualityTier: "basic" });
  const initialReq2 = baseRequest({ minimumQualityTier: "capable" });
  const fallbackReq2 = buildFallbackRoutingRequest(initialReq2, "primary-2", "UNAVAILABLE");
  const result2 = routeReviewerProvider(fallbackReq2, [candidate(primary, { runtimeStatus: "UNAVAILABLE" }), candidate(lowQualityFallback)], registryOf(primary, lowQualityFallback));
  check("19) fallback 후보도 quality 기준 완화 없이 탈락", result2.outcome !== "SELECTED" && result2.rejectedCandidates.some((r) => r.code === "QUALITY_REQUIREMENT_UNMET"));
}

// =========================================================
// 20) silent paid fallback rejected / 21) explicit paid fallback still subject to budget.
// =========================================================
function scenario20_21_paidFallback(): void {
  const freePrimary = poolEntry({ providerId: "free-primary", security: security({ providerId: "free-primary" }) });
  const paidFallback = poolEntry({ providerId: "paid-fallback", security: security({ providerId: "paid-fallback", costTier: "paid" }) });
  const initialReq = baseRequest({ allowPaidProvider: false });
  const fallbackReq = buildFallbackRoutingRequest(initialReq, "free-primary", "PROVIDER_ERROR");
  const result = routeReviewerProvider(fallbackReq, [candidate(freePrimary, { runtimeStatus: "UNAVAILABLE" }), candidate(paidFallback)], registryOf(freePrimary, paidFallback));
  check("20) allowPaidProvider=false면 paid fallback이 자동 선택되지 않음", result.outcome === "PAID_FALLBACK_NOT_ALLOWED");

  const initialReqAllowed = baseRequest({ allowPaidProvider: true, budgetState: "EXHAUSTED" });
  const fallbackReqAllowed = buildFallbackRoutingRequest(initialReqAllowed, "free-primary", "PROVIDER_ERROR");
  const resultAllowed = routeReviewerProvider(fallbackReqAllowed, [candidate(freePrimary, { runtimeStatus: "UNAVAILABLE" }), candidate(paidFallback)], registryOf(freePrimary, paidFallback));
  check("21) paid 명시 허용이어도 budgetState!=AVAILABLE이면 BUDGET_BLOCKED", resultAllowed.outcome === "BUDGET_BLOCKED");

  const resultAllowedAndBudgetOk = routeReviewerProvider(
    buildFallbackRoutingRequest(baseRequest({ allowPaidProvider: true, budgetState: "AVAILABLE" }), "free-primary", "PROVIDER_ERROR"),
    [candidate(freePrimary, { runtimeStatus: "UNAVAILABLE" }), candidate(paidFallback)],
    registryOf(freePrimary, paidFallback)
  );
  check("21) paid 허용 + budget AVAILABLE이면 선택됨", resultAllowedAndBudgetOk.outcome === "SELECTED" && resultAllowedAndBudgetOk.selectedProviderId === "paid-fallback");
}

// =========================================================
// 22) no candidate → explicit BLOCK.
// =========================================================
function scenario22_noCandidate(): void {
  const result = routeReviewerProvider(baseRequest(), [], {});
  check("22) 후보가 없으면 NO_ELIGIBLE_PROVIDER", result.outcome === "NO_ELIGIBLE_PROVIDER");
  check("22) 억지로 provider를 선택하지 않음(selectedProviderId undefined)", result.selectedProviderId === undefined);
}

// =========================================================
// 23) deterministic tie-breaking / 24) same state → same result.
// =========================================================
function scenario23_24_deterministicTieBreak(): void {
  const a = poolEntry({ providerId: "z-provider", security: security({ providerId: "z-provider" }) });
  const b = poolEntry({ providerId: "a-provider", security: security({ providerId: "a-provider" }) });
  const req = baseRequest();
  const registry = registryOf(a, b);
  const result1 = routeReviewerProvider(req, [candidate(a), candidate(b)], registry);
  const result2 = routeReviewerProvider(req, [candidate(b), candidate(a)], registry);
  check("23) 입력 순서와 무관하게 providerId 오름차순(a-provider)이 선택됨", result1.selectedProviderId === "a-provider" && result2.selectedProviderId === "a-provider");

  const result3 = routeReviewerProvider(req, [candidate(a), candidate(b)], registry);
  check("24) 동일 입력 → 동일 결과(deep equal)", JSON.stringify(result1) === JSON.stringify(result3));
}

// =========================================================
// 25) Ollama unavailable not selected.
// =========================================================
function scenario25_ollamaUnavailable(): void {
  const pool = buildRealProviderPool();
  const ollama = pool.find((e) => e.providerId === OLLAMA_PROVIDER_ID)!;
  const registry = resolveRealProviderPoolSecurityRegistry();
  const result = routeReviewerProvider(baseRequest({ dataClassification: "RESTRICTED", minimumQualityTier: "unknown" }), [candidate(ollama, { runtimeStatus: "UNAVAILABLE" })], registry);
  check("25) Ollama가 security적으로 완벽해도 UNAVAILABLE이면 선택되지 않음", result.outcome === "PROVIDER_UNAVAILABLE");
}

// =========================================================
// 26/27) Final Independent Review — local provider 자동 승격 금지, PreReviewer PASS가 우회 못함.
// =========================================================
function scenario26_27_finalIndependentReview(): void {
  const pool = buildRealProviderPool();
  const ollama = pool.find((e) => e.providerId === OLLAMA_PROVIDER_ID)!;
  const registry = resolveRealProviderPoolSecurityRegistry();

  const preReviewReq = baseRequest({ reviewerRole: "PRE_REVIEW", dataClassification: "RESTRICTED", minimumQualityTier: "unknown" });
  const preReviewResult = routeReviewerProvider(preReviewReq, [candidate(ollama)], registry);
  check("26/27 사전조건) PRE_REVIEW는 Ollama를 정상 선택할 수 있음", preReviewResult.outcome === "SELECTED" && preReviewResult.selectedProviderId === OLLAMA_PROVIDER_ID);

  const finalReq = baseRequest({ reviewerRole: "FINAL_INDEPENDENT_REVIEW", dataClassification: "RESTRICTED", minimumQualityTier: "unknown" });
  const finalResult = routeReviewerProvider(finalReq, [candidate(ollama)], registry);
  check("26) 동일한 Ollama 후보라도 FINAL_INDEPENDENT_REVIEW에서는 절대 선택되지 않음", finalResult.outcome === "FINAL_INDEPENDENT_REVIEW_NOT_ROUTED");
  check("26) rejectedCandidates에 NOT_APPROVED_FOR_FINAL_INDEPENDENT_REVIEW 기록", finalResult.rejectedCandidates[0]?.code === "NOT_APPROVED_FOR_FINAL_INDEPENDENT_REVIEW");
  check(
    "27) PRE_REVIEW가 SELECTED였다는 사실은 이후 FINAL_INDEPENDENT_REVIEW 호출 결과에 아무 영향을 주지 못함(구조적으로 그 결과를 입력받지 않음)",
    preReviewResult.outcome === "SELECTED" && finalResult.outcome === "FINAL_INDEPENDENT_REVIEW_NOT_ROUTED"
  );
}

// =========================================================
// 28) OpenAI production final default preserved(regression) — gpt-reviewer.ts/orchestrator.ts의
//     기존 default provider 배선은 이 파일이 전혀 건드리지 않았다.
// =========================================================
function scenario28_openAiDefaultPreserved(): void {
  check("28) openAIReviewProvider.id는 여전히 'openai'(기존 배선 불변)", openAIReviewProvider.id === OPENAI_REVIEW_PROVIDER_ID && OPENAI_REVIEW_PROVIDER_ID === "openai");
}

// =========================================================
// 32) Usage Ledger metadata는 자유 텍스트(reason)를 옮기지 않는다 — enum/providerId만.
// =========================================================
function scenario32_ledgerMetadataSafe(): void {
  const secretLike = poolEntry({
    providerId: "secret-marker-provider",
    security: security({ providerId: "secret-marker-provider", trainingPolicy: "unknown" }),
    disabledReason: undefined,
  });
  const result = routeReviewerProvider(baseRequest({ dataClassification: "PUBLIC" }), [candidate(secretLike)], registryOf(secretLike));
  const entry = buildRoutingDecisionLedgerEntryInput(result, { projectId: "proj-1", taskId: "task-1" }, "development");
  const serialized = JSON.stringify(entry);
  check("32) Ledger entry는 reason 자유 텍스트를 전혀 포함하지 않음", !serialized.includes("이 요청에서") && !serialized.includes("provider(secret-marker-provider)"));
  check("32) Ledger entry의 provider/operation/status는 enum/식별자만 담음", entry.provider === "(unrouted)" && entry.operation.startsWith("reviewer_provider_routing:") && entry.status === result.outcome);
  check("32) requestCount는 항상 0(routing 자체는 API 호출이 아님)", entry.requestCount === 0);
  check("32) estimatedCostUsd/actualCostUsd를 임의로 채우지 않음", entry.estimatedCostUsd === undefined && entry.actualCostUsd === undefined);

  const selectedEntry = poolEntry({ providerId: "selected-provider", security: security({ providerId: "selected-provider" }) });
  const selectedResult = routeReviewerProvider(baseRequest(), [candidate(selectedEntry)], registryOf(selectedEntry));
  const selectedLedgerEntry = buildRoutingDecisionLedgerEntryInput(selectedResult, {}, "development");
  check("32) SELECTED일 때는 provider 필드에 실제 providerId가 담김", selectedLedgerEntry.provider === "selected-provider");
}

// =========================================================
// 39) hidden fallback 0 — buildFallbackRoutingRequest 없이는 어떤 provider도 다른 provider를
//     대체하지 않는다(같은 candidates에 excludeProviderIds가 없으면 항상 동일한 SELECTED만
//     반환됨을 재확인).
// =========================================================
function scenario39_noHiddenFallback(): void {
  const only = poolEntry({ providerId: "only-provider", security: security({ providerId: "only-provider" }) });
  const req = baseRequest();
  const result1 = routeReviewerProvider(req, [candidate(only, { runtimeStatus: "UNAVAILABLE" })], registryOf(only));
  check("39) fallback 요청을 명시적으로 만들지 않으면 UNAVAILABLE 후보를 다른 provider로 조용히 대체하지 않음", result1.outcome === "PROVIDER_UNAVAILABLE" && result1.fallbackUsed === false);
}

// =========================================================
// 40) computeAggregateOutcome — 같은 단계에서 서로 다른 code가 같은 outcome으로 매핑되면
//     raw code로 뭉개지 않고 그 구체적 outcome을 그대로 보고한다(code 기준 dedupe 회귀 방지).
// =========================================================
function scenario40_mixedCodeSameOutcome(): void {
  const disabled = poolEntry({ providerId: "disabled-provider", approvalStatus: "DISABLED", security: security({ providerId: "disabled-provider" }) });
  const securityBlocked = poolEntry({ providerId: "security-blocked-provider", security: security({ providerId: "security-blocked-provider", trainingPolicy: "unknown" }) });
  const result = routeReviewerProvider(baseRequest(), [candidate(disabled), candidate(securityBlocked)], registryOf(disabled, securityBlocked));
  check(
    "40) PROVIDER_DISABLED와 SECURITY_BLOCKED(둘 다 stage1, 둘 다 PROVIDER_SECURITY_BLOCKED로 매핑)가 섞이면 outcome이 그 구체적 값으로 승격됨(NO_ELIGIBLE_PROVIDER로 뭉개지지 않음)",
    result.outcome === "PROVIDER_SECURITY_BLOCKED"
  );
  check("40) rejectedCandidates에는 원래 code(PROVIDER_DISABLED/SECURITY_BLOCKED)가 그대로 보존됨", result.rejectedCandidates.some((r) => r.code === "PROVIDER_DISABLED") && result.rejectedCandidates.some((r) => r.code === "SECURITY_BLOCKED"));
}

function main(): void {
  scenario1_priorityOrdering();
  scenario2_cheaperInsecureRejected();
  scenario3_insufficientQualityRejected();
  scenario4_secureSufficientFreeSelected();
  scenario5_unknownPolicyNeverSelected();
  scenario6_nvidiaPolicyUnknownNeverSelected();
  scenario7_notConfiguredNeverSelected();
  scenario8_unavailableNeverSelected();
  scenario9_secretAlwaysRejected();
  scenario10_11_confidentialRetention();
  scenario12_restrictedInsufficientTrust();
  scenario13_14_15_routerDownstream();
  scenario16_17_safeFallback();
  scenario18_19_fallbackNoDowngrade();
  scenario20_21_paidFallback();
  scenario22_noCandidate();
  scenario23_24_deterministicTieBreak();
  scenario25_ollamaUnavailable();
  scenario26_27_finalIndependentReview();
  scenario28_openAiDefaultPreserved();
  scenario32_ledgerMetadataSafe();
  scenario39_noHiddenFallback();
  scenario40_mixedCodeSameOutcome();

  console.log("\n=== Security-aware Provider Routing & Fallback(SI-3.8G) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
