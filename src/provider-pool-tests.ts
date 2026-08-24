import {
  validateProviderPoolEntry,
  toProviderSecurityRegistry,
  resolveProviderPoolStatus,
  evaluateProviderPoolSecurity,
} from "./provider-pool";
import type { ProviderPoolEntry } from "./provider-pool";
import type { ProviderSecurityMetadata } from "./provider-security-gate";
import { buildRealProviderPool, resolveRealProviderPoolSecurityRegistry, GROQ_API_KEY_ENV, OPENROUTER_API_KEY_ENV } from "./real-provider-pool";
import { OLLAMA_PROVIDER_ID, GROQ_PROVIDER_ID, OPENROUTER_PROVIDER_ID, NVIDIA_NIM_PROVIDER_ID } from "./provider-pool-security-metadata";
import { OPENAI_REVIEW_PROVIDER_ID } from "./openai-review-provider";

// Approved Free/Low-cost Reviewer Provider Pool — Core Catalog Model Tests — Phase SI-3.8F.
//
// 이 파일은 실제 외부 AI/API를 전혀 호출하지 않는다(요구사항 24) — provider-pool.ts의 모든
// 함수는 로컬 계산만 하는 순수 함수이고, real-provider-pool.ts의 buildRealProviderPool()도
// 네트워크 I/O가 없다(§ 그 파일 상단 주석).

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

// =========================================================
// A) Entry shape validation.
// =========================================================
function scenarioA_entryValidation(): void {
  const good = poolEntry({ providerId: "p1", security: security({ providerId: "p1" }) });
  check("A) 유효한 entry는 통과", validateProviderPoolEntry(good).ok === true);

  const mismatchedSecurityId = poolEntry({ providerId: "p1", security: security({ providerId: "different" }) });
  check("A) security.providerId 불일치 → 실패", validateProviderPoolEntry(mismatchedSecurityId).ok === false);

  const disabledNoReason: ProviderPoolEntry = { ...good, providerId: "p2", security: security({ providerId: "p2" }), approvalStatus: "DISABLED" };
  check("A) DISABLED인데 disabledReason 없음 → 실패", validateProviderPoolEntry(disabledNoReason).ok === false);

  const disabledWithReason: ProviderPoolEntry = { ...disabledNoReason, disabledReason: "정책 미확인" };
  check("A) DISABLED + disabledReason 있음 → 통과", validateProviderPoolEntry(disabledWithReason).ok === true);

  const noPolicySource: ProviderPoolEntry = { ...good, providerId: "p3", security: security({ providerId: "p3" }), policySource: [] };
  check("A) policySource 비어있음 → 실패", validateProviderPoolEntry(noPolicySource).ok === false);

  const badDate: ProviderPoolEntry = { ...good, providerId: "p4", security: security({ providerId: "p4" }), policyVerifiedAt: "not-a-date" };
  check("A) policyVerifiedAt이 유효하지 않은 날짜 → 실패", validateProviderPoolEntry(badDate).ok === false);

  const routerMissingFlag: ProviderPoolEntry = {
    ...good,
    providerId: "p5",
    security: security({ providerId: "p5" }),
    providerType: "router",
    downstreamProviderRequired: false,
  };
  check("A) router인데 downstreamProviderRequired=false → 실패", validateProviderPoolEntry(routerMissingFlag).ok === false);

  const nonRouterWithDownstream: ProviderPoolEntry = {
    ...good,
    providerId: "p6",
    security: security({ providerId: "p6" }),
    downstreamProviderIds: ["x"],
  };
  check("A) router가 아닌데 downstreamProviderIds 존재 → 실패", validateProviderPoolEntry(nonRouterWithDownstream).ok === false);

  const routerValid: ProviderPoolEntry = {
    ...good,
    providerId: "p7",
    security: security({ providerId: "p7" }),
    providerType: "router",
    downstreamProviderRequired: true,
    downstreamProviderIds: ["openai"],
  };
  check("A) router + downstreamProviderRequired=true + downstreamProviderIds 있음 → 통과", validateProviderPoolEntry(routerValid).ok === true);
}

// =========================================================
// B) toProviderSecurityRegistry.
// =========================================================
function scenarioB_toRegistry(): void {
  const a = poolEntry({ providerId: "a", security: security({ providerId: "a" }) });
  const b = poolEntry({ providerId: "b", security: security({ providerId: "b" }) });
  const registry = toProviderSecurityRegistry([a, b]);
  check("B) registry에 두 provider 모두 존재", registry["a"] === a.security && registry["b"] === b.security);
}

// =========================================================
// C) resolveProviderPoolStatus — availability(#10, #11, #12).
// =========================================================
function scenarioC_availabilityStatus(): void {
  const disabled = poolEntry({ providerId: "d", security: security({ providerId: "d" }), approvalStatus: "DISABLED", disabledReason: "reason" });
  check("C) DISABLED entry → DISABLED(런타임과 무관)", resolveProviderPoolStatus(disabled, {}, { available: true }) === "DISABLED");

  const unknownPolicy = poolEntry({
    providerId: "u",
    security: security({ providerId: "u" }),
    approvalStatus: "POLICY_UNKNOWN",
    disabledReason: "reason",
  });
  check("C) POLICY_UNKNOWN entry → POLICY_UNKNOWN(런타임과 무관)", resolveProviderPoolStatus(unknownPolicy, {}, { available: true }) === "POLICY_UNKNOWN");

  const external = poolEntry({ providerId: "e", security: security({ providerId: "e" }), requiresApiKeyEnv: "SOME_KEY" });
  check("C) API key 환경변수 없음 → NOT_CONFIGURED(#11)", resolveProviderPoolStatus(external, {}) === "NOT_CONFIGURED");
  check(
    "C) API key 환경변수는 있지만 probe 결과 없음 → UNAVAILABLE(거짓 AVAILABLE 금지, #10/#12)",
    resolveProviderPoolStatus(external, { SOME_KEY: "value" }) === "UNAVAILABLE"
  );
  check(
    "C) API key 있음 + probe available=false → UNAVAILABLE",
    resolveProviderPoolStatus(external, { SOME_KEY: "value" }, { available: false }) === "UNAVAILABLE"
  );
  check(
    "C) API key 있음 + probe available=true → AVAILABLE",
    resolveProviderPoolStatus(external, { SOME_KEY: "value" }, { available: true }) === "AVAILABLE"
  );

  const local = poolEntry({ providerId: "l", security: security({ providerId: "l" }), providerType: "local" });
  check("C) local provider + probe 없음 → NOT_CONFIGURED(Ollama unavailable 안전 처리, #10)", resolveProviderPoolStatus(local, {}) === "NOT_CONFIGURED");
  check("C) local provider + probe available=false → UNAVAILABLE", resolveProviderPoolStatus(local, {}, { available: false }) === "UNAVAILABLE");
  check("C) local provider + probe available=true → AVAILABLE", resolveProviderPoolStatus(local, {}, { available: true }) === "AVAILABLE");
}

// =========================================================
// D) evaluateProviderPoolSecurity — SECRET block(#4), free tier가 security를 통과시키지
//    않음(#3), router downstream unknown/disallowed/approved(#7/#8/#9).
// =========================================================
function scenarioD_securityEvaluation(): void {
  // #4 SECRET external provider BLOCK — 완전히 컴플라이언트한 metadata라도 예외 없음.
  const compliant = poolEntry({ providerId: "compliant", security: security({ providerId: "compliant" }) });
  const registryD = toProviderSecurityRegistry([compliant]);
  const secretResult = evaluateProviderPoolSecurity(compliant, "SECRET", registryD);
  check("D) SECRET → BLOCK(완전히 컴플라이언트해도 예외 없음, #4)", secretResult.verdict === "BLOCK" && secretResult.blockCode === "SECRET_CLASS_BLOCKED");

  // #3 free tier만으로 security PASS하지 않음 — costTier="free"이지만 trainingPolicy가 unknown이면 BLOCK.
  const freeButUnknownPolicy = poolEntry({
    providerId: "free-unknown",
    security: security({ providerId: "free-unknown", trainingPolicy: "unknown", costTier: "free" }),
  });
  const registryFree = toProviderSecurityRegistry([freeButUnknownPolicy]);
  const freeResult = evaluateProviderPoolSecurity(freeButUnknownPolicy, "PUBLIC", registryFree);
  check("D) free tier(costTier=free)라도 정책 unknown이면 PUBLIC조차 BLOCK(#3)", freeResult.verdict === "BLOCK");

  // Claude code-review 지적 — evaluateProviderPoolSecurity()가 approvalStatus를 확인하지 않고
  // security metadata만으로 판정하면, 미래에 DISABLED/POLICY_UNKNOWN 항목에 컴플라이언트한
  // security metadata가 채워질 경우 조용히 PASS를 반환할 위험이 있었다. 완전히 컴플라이언트한
  // security metadata를 가졌지만 catalog 승인 상태가 DISABLED/POLICY_UNKNOWN인 entry는 그
  // metadata 내용과 무관하게 항상 BLOCK되어야 한다.
  const disabledButCompliant = poolEntry({
    providerId: "disabled-but-compliant",
    security: security({ providerId: "disabled-but-compliant" }), // 완전히 컴플라이언트한 metadata.
    approvalStatus: "DISABLED",
    disabledReason: "예: ToS가 production 사용을 금지함",
  });
  const registryDisabled = toProviderSecurityRegistry([disabledButCompliant]);
  const disabledResult = evaluateProviderPoolSecurity(disabledButCompliant, "PUBLIC", registryDisabled);
  check(
    "D) approvalStatus=DISABLED + 완전히 컴플라이언트한 security metadata라도 BLOCK(security 내용이 catalog 승인을 대체하지 못함)",
    disabledResult.verdict === "BLOCK"
  );

  const policyUnknownButCompliant = poolEntry({
    providerId: "policy-unknown-but-compliant",
    security: security({ providerId: "policy-unknown-but-compliant" }),
    approvalStatus: "POLICY_UNKNOWN",
    disabledReason: "예: 1차 문서 미확인",
  });
  const registryPolicyUnknown = toProviderSecurityRegistry([policyUnknownButCompliant]);
  const policyUnknownResult = evaluateProviderPoolSecurity(policyUnknownButCompliant, "PUBLIC", registryPolicyUnknown);
  check("D) approvalStatus=POLICY_UNKNOWN + 완전히 컴플라이언트한 security metadata라도 BLOCK", policyUnknownResult.verdict === "BLOCK");

  // #7 router downstream unknown → BLOCK(entry에 downstreamProviderIds가 아예 없음).
  const routerNoDownstream: ProviderPoolEntry = {
    ...poolEntry({ providerId: "router-no-downstream", security: security({ providerId: "router-no-downstream" }) }),
    providerType: "router",
    downstreamProviderRequired: true,
    downstreamProviderIds: undefined,
  };
  const registryRouter = toProviderSecurityRegistry([routerNoDownstream]);
  const noDownstreamResult = evaluateProviderPoolSecurity(routerNoDownstream, "PUBLIC", registryRouter);
  check(
    "D) router + downstream 미지정 → BLOCK(router 자신의 승인만으로 통과하지 않음, #7)",
    noDownstreamResult.verdict === "BLOCK" && noDownstreamResult.blockCode === "DOWNSTREAM_PROVIDER_BLOCKED"
  );

  // #8 router downstream disallowed → BLOCK(downstream이 registry에 있지만 그 classification을 승인하지 않음).
  const badDownstream = security({ providerId: "bad-downstream", allowedDataClassifications: ["PUBLIC"] });
  const routerWithBadDownstream: ProviderPoolEntry = {
    ...routerNoDownstream,
    providerId: "router-bad-downstream",
    security: security({ providerId: "router-bad-downstream" }),
    downstreamProviderIds: ["bad-downstream"],
  };
  const registryBadDownstream = toProviderSecurityRegistry([routerWithBadDownstream, poolEntry({ providerId: "bad-downstream", security: badDownstream })]);
  const badDownstreamResult = evaluateProviderPoolSecurity(routerWithBadDownstream, "INTERNAL", registryBadDownstream);
  check(
    "D) router + downstream이 해당 classification을 승인하지 않음 → BLOCK(#8)",
    badDownstreamResult.verdict === "BLOCK" && badDownstreamResult.blockCode === "DOWNSTREAM_PROVIDER_BLOCKED"
  );

  // #9 router approved downstream → PASS.
  const goodDownstream = security({ providerId: "good-downstream" });
  const routerWithGoodDownstream: ProviderPoolEntry = {
    ...routerNoDownstream,
    providerId: "router-good-downstream",
    security: security({ providerId: "router-good-downstream" }),
    downstreamProviderIds: ["good-downstream"],
  };
  const registryGoodDownstream = toProviderSecurityRegistry([
    routerWithGoodDownstream,
    poolEntry({ providerId: "good-downstream", security: goodDownstream }),
  ]);
  const goodDownstreamResult = evaluateProviderPoolSecurity(routerWithGoodDownstream, "CONFIDENTIAL", registryGoodDownstream);
  check("D) router + 승인된 downstream → PASS(#9)", goodDownstreamResult.verdict === "PASS");
}

// =========================================================
// E) 실제 catalog(real-provider-pool.ts) — #1(approved local provider metadata), #2(unknown
//    policy external provider disabled), #5/#6(Groq ZDR gating), #21(source/as-of 존재).
// =========================================================
function scenarioE_realCatalog(): void {
  const originalGroqZdr = process.env.AUTODEV_GROQ_ZDR_VERIFIED;
  const originalOpenRouterZdr = process.env.AUTODEV_OPENROUTER_ZDR_VERIFIED;
  delete process.env.AUTODEV_GROQ_ZDR_VERIFIED;
  delete process.env.AUTODEV_OPENROUTER_ZDR_VERIFIED;

  try {
    const pool = buildRealProviderPool({});
    check("E) 실제 catalog에 정확히 4개 provider 등록됨", pool.length === 4);
    for (const entry of pool) {
      check(`E) ${entry.providerId} entry가 validateProviderPoolEntry를 통과함`, validateProviderPoolEntry(entry).ok === true);
      check(`E) ${entry.providerId} policySource 존재(#21)`, entry.policySource.length > 0);
      check(`E) ${entry.providerId} policyVerifiedAt 존재(#21)`, typeof entry.policyVerifiedAt === "string" && entry.policyVerifiedAt.length > 0);
    }

    // #1 approved local provider metadata.
    const ollama = pool.find((p) => p.providerId === OLLAMA_PROVIDER_ID);
    check("E) Ollama가 APPROVED + local provider로 등록됨(#1)", ollama?.approvalStatus === "APPROVED" && ollama?.providerType === "local");
    check("E) Ollama security metadata: no-training + zero retention", ollama?.security.trainingPolicy === "no-training" && ollama?.security.retentionPolicy === "zero");

    // #2 unknown policy external provider disabled.
    const nvidia = pool.find((p) => p.providerId === NVIDIA_NIM_PROVIDER_ID);
    check("E) NVIDIA NIM이 POLICY_UNKNOWN으로 등록됨(#2)", nvidia?.approvalStatus === "POLICY_UNKNOWN");
    check("E) NVIDIA NIM security metadata: trainingPolicy=unknown", nvidia?.security.trainingPolicy === "unknown");
    check("E) NVIDIA NIM disabledReason 존재(#22 정책 unknown fail closed)", !!nvidia?.disabledReason && nvidia.disabledReason.length > 0);

    const registry = resolveRealProviderPoolSecurityRegistry({});
    const nvidiaBlock = evaluateProviderPoolSecurity(nvidia!, "PUBLIC", registry);
    check("E) NVIDIA NIM은 PUBLIC조차 BLOCK(#22 정책 unknown fail closed)", nvidiaBlock.verdict === "BLOCK");

    // #5 Groq 기본(ZDR 미검증) → CONFIDENTIAL insufficient retention BLOCK.
    const groq = pool.find((p) => p.providerId === GROQ_PROVIDER_ID)!;
    check("E) Groq 기본 metadata: retentionPolicy=bounded(ZDR 미검증)", groq.security.retentionPolicy === "bounded");
    const groqConfidentialBlocked = evaluateProviderPoolSecurity(groq, "CONFIDENTIAL", registry);
    check("E) Groq(ZDR 미검증) + CONFIDENTIAL → BLOCK(#5)", groqConfidentialBlocked.verdict === "BLOCK");

    // #6 Groq ZDR verified → CONFIDENTIAL PASS.
    process.env.AUTODEV_GROQ_ZDR_VERIFIED = "true";
    const poolWithZdr = buildRealProviderPool({ AUTODEV_GROQ_ZDR_VERIFIED: "true" });
    const groqZdr = poolWithZdr.find((p) => p.providerId === GROQ_PROVIDER_ID)!;
    check("E) Groq(ZDR 검증됨) metadata: retentionPolicy=zero", groqZdr.security.retentionPolicy === "zero");
    const registryZdr = resolveRealProviderPoolSecurityRegistry({ AUTODEV_GROQ_ZDR_VERIFIED: "true" });
    const groqConfidentialPassed = evaluateProviderPoolSecurity(groqZdr, "CONFIDENTIAL", registryZdr);
    check("E) Groq(ZDR 검증됨) + CONFIDENTIAL → PASS(#6)", groqConfidentialPassed.verdict === "PASS");

    // #11 missing API key → NOT_CONFIGURED for Groq/OpenRouter.
    check("E) Groq API key 없음 → NOT_CONFIGURED(#11)", resolveProviderPoolStatus(groq, {}) === "NOT_CONFIGURED");
    const openrouter = pool.find((p) => p.providerId === OPENROUTER_PROVIDER_ID)!;
    check("E) OpenRouter API key 없음 → NOT_CONFIGURED(#11)", resolveProviderPoolStatus(openrouter, {}) === "NOT_CONFIGURED");
    check(
      "E) Groq API key 있어도 probe 없이는 UNAVAILABLE(거짓 AVAILABLE 금지, #12)",
      resolveProviderPoolStatus(groq, { [GROQ_API_KEY_ENV]: "fake-key-value-not-real" }) === "UNAVAILABLE"
    );

    // OpenRouter downstream — 실제 catalog는 openai 하나를 알려진 downstream으로 등록한다.
    check("E) OpenRouter downstreamProviderIds에 openai 포함", openrouter.downstreamProviderIds?.includes(OPENAI_REVIEW_PROVIDER_ID) === true);
    const openRouterNoZdr = evaluateProviderPoolSecurity(openrouter, "PUBLIC", registry);
    check("E) OpenRouter(ZDR 미검증) 자신의 retentionPolicy=unknown → PUBLIC조차 BLOCK(fail-closed)", openRouterNoZdr.verdict === "BLOCK");

    // downstream(openai) 자신도 CONFIDENTIAL을 통과하려면 OpenAI 자신의 ZDR도 별도로 검증돼야
    // 한다(§ openai-provider-security-metadata.ts AUTODEV_OPENAI_ZDR_VERIFIED — OpenRouter의
    // ZDR 검증과는 별개의 env — "router 판정만으로 downstream까지 승인하지 않는다"는 원칙이
    // 여기서도 그대로 적용된다는 것을 함께 증명한다).
    process.env.AUTODEV_OPENROUTER_ZDR_VERIFIED = "true";
    const downstreamEnv = { AUTODEV_OPENROUTER_ZDR_VERIFIED: "true", AUTODEV_OPENAI_ZDR_VERIFIED: "true" };
    const poolOpenRouterZdr = buildRealProviderPool(downstreamEnv);
    const openrouterZdr = poolOpenRouterZdr.find((p) => p.providerId === OPENROUTER_PROVIDER_ID)!;
    const registryOpenRouterZdr = resolveRealProviderPoolSecurityRegistry(downstreamEnv);
    const openRouterWithZdr = evaluateProviderPoolSecurity(openrouterZdr, "CONFIDENTIAL", registryOpenRouterZdr);
    check(
      "E) OpenRouter(ZDR 검증됨) + 승인된 downstream(openai, ZDR도 검증됨) + CONFIDENTIAL → PASS",
      openRouterWithZdr.verdict === "PASS"
    );
    check(
      "E) 판정 결과에 downstream(openai) 개별 결과도 포함됨",
      openRouterWithZdr.downstreamResults.some((d) => d.providerId === OPENAI_REVIEW_PROVIDER_ID && d.verdict === "PASS")
    );

    check("E) OpenRouter requiresApiKeyEnv 값 확인", openrouter.requiresApiKeyEnv === OPENROUTER_API_KEY_ENV);
  } finally {
    if (originalGroqZdr === undefined) delete process.env.AUTODEV_GROQ_ZDR_VERIFIED;
    else process.env.AUTODEV_GROQ_ZDR_VERIFIED = originalGroqZdr;
    if (originalOpenRouterZdr === undefined) delete process.env.AUTODEV_OPENROUTER_ZDR_VERIFIED;
    else process.env.AUTODEV_OPENROUTER_ZDR_VERIFIED = originalOpenRouterZdr;
  }
}

// =========================================================
// F) no Secret 노출(#23) — catalog/registry 직렬화 어디에도 실제 API key 값이 없음(애초에 그런
//    필드가 없다 — 구조적 보장을 직접 확인한다).
// =========================================================
function scenarioF_noSecretInCatalog(): void {
  const pool = buildRealProviderPool({ [GROQ_API_KEY_ENV]: "sk-should-never-appear-anywhere", [OPENROUTER_API_KEY_ENV]: "or-should-never-appear-anywhere" });
  const serialized = JSON.stringify(pool);
  check("F) catalog 직렬화에 실제 API key 값이 전혀 없음(구조적으로 그런 필드가 없음, #23)", !serialized.includes("should-never-appear-anywhere"));
  const registry = resolveRealProviderPoolSecurityRegistry({ [GROQ_API_KEY_ENV]: "sk-should-never-appear-anywhere" });
  check("F) registry 직렬화에도 API key 값이 없음(#23)", !JSON.stringify(registry).includes("should-never-appear-anywhere"));
}

function main(): void {
  scenarioA_entryValidation();
  scenarioB_toRegistry();
  scenarioC_availabilityStatus();
  scenarioD_securityEvaluation();
  scenarioE_realCatalog();
  scenarioF_noSecretInCatalog();

  console.log("\n=== Approved Free/Low-cost Reviewer Provider Pool(SI-3.8F) — Core Catalog Model 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
