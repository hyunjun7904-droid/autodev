import { evaluateProviderSecurity } from "./provider-security-gate";
import type { ProviderSecurityMetadata, ProviderSecurityRegistry } from "./provider-security-gate";

// Data Classification & Provider Security Gate(SI-3.8C) — 순수 deterministic 단위 테스트.
// 이 파일은 실제 외부 AI/API를 전혀 호출하지 않는다(요구사항 18) — evaluateProviderSecurity()는
// 로컬 계산만 하는 순수 함수이며, registry는 이 파일에 리터럴로 정의된 fixture일 뿐 실제
// provider에 연결되지 않는다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const NOW = "2026-08-25T00:00:00.000Z";

function provider(overrides: Partial<ProviderSecurityMetadata> & { providerId: string }): ProviderSecurityMetadata {
  return {
    trainingPolicy: "no-training",
    retentionPolicy: "zero",
    supportsZeroDataRetention: true,
    trustLevel: "high",
    allowedDataClassifications: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
    policyVerifiedAt: NOW,
    costTier: "paid",
    ...overrides,
  };
}

function registryOf(...providers: ProviderSecurityMetadata[]): ProviderSecurityRegistry {
  const out: Record<string, ProviderSecurityMetadata> = {};
  for (const p of providers) out[p.providerId] = p;
  return out;
}

// 1) PUBLIC + allowed provider → PASS
function scenario1_publicAllowedPasses(): void {
  const registry = registryOf(provider({ providerId: "good-provider" }));
  const result = evaluateProviderSecurity({ classification: "PUBLIC", providerId: "good-provider" }, registry);
  check("1) PUBLIC + allowed provider → PASS", result.verdict === "PASS");
  check("1) PASS 결과에는 blockCode가 없음", result.blockCode === undefined);
}

// 2) INTERNAL policy mismatch(allowedDataClassifications에 INTERNAL이 없음) → BLOCK
function scenario2_internalMismatchBlocks(): void {
  const registry = registryOf(provider({ providerId: "public-only", allowedDataClassifications: ["PUBLIC"] }));
  const result = evaluateProviderSecurity({ classification: "INTERNAL", providerId: "public-only" }, registry);
  check("2) INTERNAL policy mismatch → BLOCK", result.verdict === "BLOCK");
  check("2) blockCode === CLASSIFICATION_NOT_EXPLICITLY_ALLOWED", result.blockCode === "CLASSIFICATION_NOT_EXPLICITLY_ALLOWED");
}

// 3) CONFIDENTIAL + retentionPolicy unknown → BLOCK
function scenario3_confidentialUnknownRetentionBlocks(): void {
  const registry = registryOf(provider({ providerId: "unknown-retention", retentionPolicy: "unknown" }));
  const result = evaluateProviderSecurity({ classification: "CONFIDENTIAL", providerId: "unknown-retention" }, registry);
  check("3) CONFIDENTIAL unknown retention → BLOCK", result.verdict === "BLOCK");
  check("3) blockCode === RETENTION_POLICY_UNKNOWN", result.blockCode === "RETENTION_POLICY_UNKNOWN");
}

// 4) CONFIDENTIAL + trainingPolicy allowed(학습에 씀) → BLOCK
function scenario4_confidentialTrainingAllowedBlocks(): void {
  const registry = registryOf(provider({ providerId: "trains-on-data", trainingPolicy: "allowed" }));
  const result = evaluateProviderSecurity({ classification: "CONFIDENTIAL", providerId: "trains-on-data" }, registry);
  check("4) CONFIDENTIAL training allowed → BLOCK", result.verdict === "BLOCK");
  check("4) blockCode === TRAINING_POLICY_DISALLOWS_CLASSIFICATION", result.blockCode === "TRAINING_POLICY_DISALLOWS_CLASSIFICATION");
}

// 5) CONFIDENTIAL + no-training이지만 retention이 상한(30일)을 초과 → BLOCK
function scenario5_confidentialInsufficientRetentionBlocks(): void {
  const registry = registryOf(
    provider({ providerId: "long-retention", trainingPolicy: "no-training", retentionPolicy: "bounded", maxRetentionDays: 90 })
  );
  const result = evaluateProviderSecurity({ classification: "CONFIDENTIAL", providerId: "long-retention" }, registry);
  check("5) CONFIDENTIAL no-training + insufficient retention → BLOCK", result.verdict === "BLOCK");
  check("5) blockCode === RETENTION_POLICY_INSUFFICIENT", result.blockCode === "RETENTION_POLICY_INSUFFICIENT");

  // 대조군: 30일 이하 bounded는 통과해야 한다(과도하게 엄격하지 않은지 확인).
  const okRegistry = registryOf(
    provider({ providerId: "short-retention", trainingPolicy: "no-training", retentionPolicy: "bounded", maxRetentionDays: 30 })
  );
  const okResult = evaluateProviderSecurity({ classification: "CONFIDENTIAL", providerId: "short-retention" }, okRegistry);
  check("5) 대조군: 30일 이하 bounded retention은 CONFIDENTIAL PASS", okResult.verdict === "PASS");
}

// 6) RESTRICTED + trustLevel 부족(high 아님) → BLOCK
function scenario6_restrictedInsufficientTrustBlocks(): void {
  const registry = registryOf(provider({ providerId: "medium-trust", trustLevel: "medium" }));
  const result = evaluateProviderSecurity({ classification: "RESTRICTED", providerId: "medium-trust" }, registry);
  check("6) RESTRICTED insufficient trust → BLOCK", result.verdict === "BLOCK");
  check("6) blockCode === TRUST_LEVEL_INSUFFICIENT", result.blockCode === "TRUST_LEVEL_INSUFFICIENT");
}

// 7) SECRET → 어떤 provider(완벽하게 승인된 provider 포함)라도 항상 BLOCK
function scenario7_secretAlwaysBlocks(): void {
  const registry = registryOf(provider({ providerId: "perfect-provider" }));
  const result = evaluateProviderSecurity({ classification: "SECRET", providerId: "perfect-provider" }, registry);
  check("7) SECRET → always BLOCK", result.verdict === "BLOCK");
  check("7) blockCode === SECRET_CLASS_BLOCKED", result.blockCode === "SECRET_CLASS_BLOCKED");
  check("7) SECRET BLOCK에는 downstreamResults가 빈 배열", Array.isArray(result.downstreamResults) && result.downstreamResults.length === 0);
}

// 8) registry에 없는 provider → BLOCK
function scenario8_unknownProviderBlocks(): void {
  const registry = registryOf(provider({ providerId: "known-provider" }));
  const result = evaluateProviderSecurity({ classification: "PUBLIC", providerId: "does-not-exist" }, registry);
  check("8) unknown provider → BLOCK", result.verdict === "BLOCK");
  check("8) blockCode === PROVIDER_UNKNOWN", result.blockCode === "PROVIDER_UNKNOWN");
}

// 9) provider는 존재하지만 정책 필드가 unknown(PUBLIC 등급에도 동일하게 적용됨을 확인) → BLOCK
function scenario9_unknownProviderPolicyBlocks(): void {
  const registry = registryOf(provider({ providerId: "unknown-policy", trainingPolicy: "unknown" }));
  const result = evaluateProviderSecurity({ classification: "PUBLIC", providerId: "unknown-policy" }, registry);
  check("9) unknown provider policy(PUBLIC에도 적용) → BLOCK", result.verdict === "BLOCK");
  check("9) blockCode === TRAINING_POLICY_UNKNOWN", result.blockCode === "TRAINING_POLICY_UNKNOWN");
}

// 10) "downgrade fallback candidate" — 더 낮은 등급만 지원하는(저렴한) 대체 provider로 상위
//     등급 요청을 조용히 낮춰 보내지 않는다.
function scenario10_downgradeFallbackCandidateBlocks(): void {
  const registry = registryOf(
    provider({ providerId: "cheap-fallback", allowedDataClassifications: ["PUBLIC", "INTERNAL"], trustLevel: "low" })
  );
  const result = evaluateProviderSecurity({ classification: "CONFIDENTIAL", providerId: "cheap-fallback" }, registry);
  check("10) downgrade fallback candidate → BLOCK", result.verdict === "BLOCK");
  check("10) blockCode === CLASSIFICATION_NOT_EXPLICITLY_ALLOWED(조용한 등급 하향 없음)", result.blockCode === "CLASSIFICATION_NOT_EXPLICITLY_ALLOWED");
}

// 11) multi-provider router: router provider 자체는 통과하지만 downstream provider가 registry에 없음 → BLOCK
function scenario11_routerDownstreamUnknownBlocks(): void {
  const registry = registryOf(provider({ providerId: "router" }));
  const result = evaluateProviderSecurity(
    { classification: "INTERNAL", providerId: "router", downstreamProviderIds: ["unknown-downstream"] },
    registry
  );
  check("11) router downstream provider unknown → BLOCK", result.verdict === "BLOCK");
  check("11) blockCode === DOWNSTREAM_PROVIDER_BLOCKED", result.blockCode === "DOWNSTREAM_PROVIDER_BLOCKED");
  check(
    "11) downstreamResults에 unknown-downstream의 PROVIDER_UNKNOWN이 기록됨",
    result.downstreamResults.length === 1 &&
      result.downstreamResults[0].providerId === "unknown-downstream" &&
      result.downstreamResults[0].blockCode === "PROVIDER_UNKNOWN"
  );
}

// 12) approved downstream provider → 정책 조건을 만족할 때만 PASS(만족하지 않으면 여전히 BLOCK)
function scenario12_approvedDownstreamPassesOnlyWhenPolicySatisfied(): void {
  const okRegistry = registryOf(provider({ providerId: "router" }), provider({ providerId: "downstream-ok" }));
  const okResult = evaluateProviderSecurity(
    { classification: "INTERNAL", providerId: "router", downstreamProviderIds: ["downstream-ok"] },
    okRegistry
  );
  check("12) approved + policy 만족 downstream → PASS", okResult.verdict === "PASS");
  check("12) PASS 결과에 downstream 판정도 포함됨", okResult.downstreamResults.length === 1 && okResult.downstreamResults[0].verdict === "PASS");

  const badRegistry = registryOf(
    provider({ providerId: "router" }),
    provider({ providerId: "downstream-bad-policy", trainingPolicy: "unknown" })
  );
  const badResult = evaluateProviderSecurity(
    { classification: "INTERNAL", providerId: "router", downstreamProviderIds: ["downstream-bad-policy"] },
    badRegistry
  );
  check("12) approved이지만 정책 불만족 downstream → BLOCK(router만으로 승인 안 함)", badResult.verdict === "BLOCK");
  check("12) blockCode === DOWNSTREAM_PROVIDER_BLOCKED", badResult.blockCode === "DOWNSTREAM_PROVIDER_BLOCKED");
}

// 13) free tier라는 이유만으로 PASS하지 않고, free tier라는 이유로 BLOCK되지도 않는다(costTier는
//     완전히 무관해야 한다).
function scenario13_freeTierIsNotASecurityBasis(): void {
  // providerId 자체에 "free"/"cost" 문자열을 넣지 않는다 — reason에 providerId가 그대로
  // 인용되므로, 그 값에 우연히 검사 대상 단어가 섞이면 아래 부정 검사가 오탐한다.
  const noncompliantRegistry = registryOf(provider({ providerId: "budget-tier-x", trainingPolicy: "unknown", costTier: "free" }));
  const blockResult = evaluateProviderSecurity({ classification: "PUBLIC", providerId: "budget-tier-x" }, noncompliantRegistry);
  check("13) free tier여도 정책 불만족이면 BLOCK(free가 면죄부 아님)", blockResult.verdict === "BLOCK");
  check("13) BLOCK 사유가 costTier를 근거로 언급하지 않음", !blockResult.reason.toLowerCase().includes("free") && !blockResult.reason.toLowerCase().includes("cost"));

  const freeAndCompliant = registryOf(provider({ providerId: "tier-a-provider", costTier: "free" }));
  const passResult = evaluateProviderSecurity({ classification: "PUBLIC", providerId: "tier-a-provider" }, freeAndCompliant);
  check("13) free tier라도 정책을 만족하면 PASS(free라서 PASS가 아니라 정책 만족이 이유)", passResult.verdict === "PASS");

  const paidAndCompliant = registryOf(provider({ providerId: "tier-b-provider", costTier: "paid" }));
  const paidPassResult = evaluateProviderSecurity({ classification: "PUBLIC", providerId: "tier-b-provider" }, paidAndCompliant);
  check("13) paid tier도 동일 정책이면 동일하게 PASS(costTier 자체가 판정에 영향 없음)", paidPassResult.verdict === "PASS");
}

// 14) 로그/ledger에 넘겨도 안전 — 결과 객체에 원본 payload/자유 텍스트 필드가 존재하지 않고,
//     구조가 알려진 고정 key 집합으로만 구성됨을 직접 확인한다.
function scenario14_noSecretShapeInResult(): void {
  const registry = registryOf(provider({ providerId: "shape-check-provider" }));
  const result = evaluateProviderSecurity({ classification: "PUBLIC", providerId: "shape-check-provider" }, registry);
  // blockCode는 PASS 결과에는 아예 존재하지 않는 optional key다(gpt-budget-guard.ts와 동일한
  // 패턴) — 그래서 "정확히 일치"가 아니라 "알려진 superset의 부분집합 + 필수 key 전부 포함"으로
  // 검증한다(자유 텍스트 payload 필드가 몰래 추가되지 않았음을 확인하는 것이 목적).
  const keys = Object.keys(result);
  const knownSuperset = new Set(["verdict", "classification", "providerId", "blockCode", "reason", "downstreamResults"]);
  const requiredKeys = ["verdict", "classification", "providerId", "reason", "downstreamResults"];
  check("14) 결과 객체 key가 알려진 superset 안에만 존재함(자유 텍스트 payload 필드 없음)", keys.every((k) => knownSuperset.has(k)));
  check("14) 필수 key가 모두 포함됨", requiredKeys.every((k) => keys.includes(k)));

  // BLOCK 경로에서도 동일하게 검증 — 등급 불일치 사유로 provider metadata의 일부(허용된
  // 등급 목록/등급명)만 reason에 포함되고, 그 외 무관한 원본 데이터는 등장하지 않는다.
  const blockRegistry = registryOf(provider({ providerId: "secret-marker-provider", allowedDataClassifications: ["PUBLIC"] }));
  const blockResult = evaluateProviderSecurity({ classification: "RESTRICTED", providerId: "secret-marker-provider" }, blockRegistry);
  const NOT_INJECTED_SECRET_MARKER = "sk-should-never-appear-anywhere";
  check(
    "14) 호출부가 결과에 전달하지 않은 값(secret 유사 marker)은 절대 결과에 등장하지 않음",
    JSON.stringify(blockResult).includes(NOT_INJECTED_SECRET_MARKER) === false
  );
  check("14) reason은 문자열이고 providerId/classification 값만으로 구성됨", typeof blockResult.reason === "string" && blockResult.reason.includes("secret-marker-provider") && blockResult.reason.includes("RESTRICTED"));
}

// 동일 입력 → 동일 결과(진짜 deterministic 함수임을 확인).
function scenarioDeterministic(): void {
  const registry = registryOf(provider({ providerId: "det-provider" }));
  const a = evaluateProviderSecurity({ classification: "INTERNAL", providerId: "det-provider" }, registry);
  const b = evaluateProviderSecurity({ classification: "INTERNAL", providerId: "det-provider" }, registry);
  check("동일 입력에 대해 항상 동일한 verdict/blockCode/reason", a.verdict === b.verdict && a.blockCode === b.blockCode && a.reason === b.reason);
}

// metadata 자체가 불완전(policyVerifiedAt/policyVersion 둘 다 없음)하면 어떤 등급에도 PASS하지 않는다.
function scenarioIncompleteMetadataBlocks(): void {
  const registry: ProviderSecurityRegistry = {
    "incomplete-provider": {
      providerId: "incomplete-provider",
      trainingPolicy: "no-training",
      retentionPolicy: "zero",
      supportsZeroDataRetention: true,
      trustLevel: "high",
      allowedDataClassifications: ["PUBLIC"],
      // policyVerifiedAt/policyVersion 둘 다 없음.
    },
  };
  const result = evaluateProviderSecurity({ classification: "PUBLIC", providerId: "incomplete-provider" }, registry);
  check("metadata 불완전(policy 확인 시점/버전 없음) → BLOCK", result.verdict === "BLOCK");
  check("blockCode === PROVIDER_METADATA_INCOMPLETE", result.blockCode === "PROVIDER_METADATA_INCOMPLETE");
}

function main(): void {
  scenario1_publicAllowedPasses();
  scenario2_internalMismatchBlocks();
  scenario3_confidentialUnknownRetentionBlocks();
  scenario4_confidentialTrainingAllowedBlocks();
  scenario5_confidentialInsufficientRetentionBlocks();
  scenario6_restrictedInsufficientTrustBlocks();
  scenario7_secretAlwaysBlocks();
  scenario8_unknownProviderBlocks();
  scenario9_unknownProviderPolicyBlocks();
  scenario10_downgradeFallbackCandidateBlocks();
  scenario11_routerDownstreamUnknownBlocks();
  scenario12_approvedDownstreamPassesOnlyWhenPolicySatisfied();
  scenario13_freeTierIsNotASecurityBasis();
  scenario14_noSecretShapeInResult();
  scenarioDeterministic();
  scenarioIncompleteMetadataBlocks();

  console.log("\n=== Provider Security Gate 단위 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
