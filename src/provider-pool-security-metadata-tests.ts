import {
  buildOllamaProviderSecurityMetadata,
  buildGroqProviderSecurityMetadata,
  buildOpenRouterProviderSecurityMetadata,
  buildNvidiaNimProviderSecurityMetadata,
  resolveGroqZdrVerification,
  resolveOpenRouterZdrVerification,
  OLLAMA_PROVIDER_ID,
  GROQ_PROVIDER_ID,
  OPENROUTER_PROVIDER_ID,
  NVIDIA_NIM_PROVIDER_ID,
} from "./provider-pool-security-metadata";
import { evaluateProviderSecurity } from "./provider-security-gate";

// Approved Free/Low-cost Reviewer Provider Pool — Security Metadata Tests — Phase SI-3.8F.
//
// 순수 deterministic 단위 테스트 — 실제 외부 AI/API를 전혀 호출하지 않는다(요구사항 24). 이
// 파일이 증명하는 것은 (1) 각 metadata builder가 조사된 공식 정책을 정확히 인코딩하는지, (2)
// env 기반 ZDR verification seam이 fail-closed(정확히 "true" 문자열만 인정)로 동작하는지, (3)
// 그 metadata가 provider-security-gate.ts의 기존 판정 로직과 조합됐을 때 기대한 결과를
// 내는지다 — provider-security-gate.ts 자체는 이 Task에서 수정되지 않았다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

// =========================================================
// Ollama — local, no-training + zero retention(#1).
// =========================================================
function scenarioOllama(): void {
  const m = buildOllamaProviderSecurityMetadata();
  check("Ollama) providerId 일치", m.providerId === OLLAMA_PROVIDER_ID);
  check("Ollama) trainingPolicy=no-training", m.trainingPolicy === "no-training");
  check("Ollama) retentionPolicy=zero(로컬 실행은 외부로 전송되지 않음)", m.retentionPolicy === "zero");
  check("Ollama) trustLevel=high", m.trustLevel === "high");
  check("Ollama) RESTRICTED까지 명시적으로 승인됨(local high-trust)", m.allowedDataClassifications.includes("RESTRICTED"));
  check("Ollama) policyVerifiedAt 존재", typeof m.policyVerifiedAt === "string" && m.policyVerifiedAt.length > 0);

  // SECRET은 metadata 내용과 무관하게 항상 BLOCK(provider-security-gate.ts Core hard rule).
  const registry = { [OLLAMA_PROVIDER_ID]: m };
  const secretResult = evaluateProviderSecurity({ classification: "SECRET", providerId: OLLAMA_PROVIDER_ID }, registry);
  check("Ollama) SECRET은 local provider라도 BLOCK(Core Secret Gate와 충돌하지 않음)", secretResult.verdict === "BLOCK" && secretResult.blockCode === "SECRET_CLASS_BLOCKED");

  const restrictedResult = evaluateProviderSecurity({ classification: "RESTRICTED", providerId: OLLAMA_PROVIDER_ID }, registry);
  check("Ollama) RESTRICTED는 통과(high-trust local)", restrictedResult.verdict === "PASS");
}

// =========================================================
// Groq — ZDR verification fail-closed semantics + CONFIDENTIAL insufficient/sufficient
// retention(#5/#6).
// =========================================================
function scenarioGroqZdrConfig(): void {
  check("Groq-ZDR) 미설정 → false", resolveGroqZdrVerification({}).verified === false);
  check("Groq-ZDR) 'false' 문자열 → false", resolveGroqZdrVerification({ AUTODEV_GROQ_ZDR_VERIFIED: "false" }).verified === false);
  check("Groq-ZDR) 빈 문자열 → false", resolveGroqZdrVerification({ AUTODEV_GROQ_ZDR_VERIFIED: "" }).verified === false);
  check("Groq-ZDR) 대소문자 다름('TRUE') → false", resolveGroqZdrVerification({ AUTODEV_GROQ_ZDR_VERIFIED: "TRUE" }).verified === false);
  check("Groq-ZDR) 임의 truthy 문자열('1') → false", resolveGroqZdrVerification({ AUTODEV_GROQ_ZDR_VERIFIED: "1" }).verified === false);
  check("Groq-ZDR) 정확히 'true' → verified=true", resolveGroqZdrVerification({ AUTODEV_GROQ_ZDR_VERIFIED: "true" }).verified === true);
  check(
    "Groq-ZDR) verified=true + 유효하지 않은 verifiedAt → verifiedAt만 생략(verified는 유지)",
    (() => {
      const r = resolveGroqZdrVerification({ AUTODEV_GROQ_ZDR_VERIFIED: "true", AUTODEV_GROQ_ZDR_VERIFIED_AT: "not-a-date" });
      return r.verified === true && r.verifiedAt === undefined;
    })()
  );
}

function scenarioGroqMetadata(): void {
  const defaultMeta = buildGroqProviderSecurityMetadata({});
  check("Groq) providerId 일치", defaultMeta.providerId === GROQ_PROVIDER_ID);
  check("Groq) trainingPolicy=no-training(services agreement §4.2 확인)", defaultMeta.trainingPolicy === "no-training");
  check("Groq) 기본(ZDR 미검증) retentionPolicy=bounded", defaultMeta.retentionPolicy === "bounded");
  check("Groq) 기본 maxRetentionDays=30(abuse monitoring 예외 window)", defaultMeta.maxRetentionDays === 30);
  check("Groq) supportsZeroDataRetention=true(self-serve Data Controls 제공)", defaultMeta.supportsZeroDataRetention === true);
  check("Groq) RESTRICTED는 승인 목록에 없음(고신뢰 근거 없음)", !defaultMeta.allowedDataClassifications.includes("RESTRICTED"));

  const registryDefault = { [GROQ_PROVIDER_ID]: defaultMeta };
  const confidentialBlocked = evaluateProviderSecurity({ classification: "CONFIDENTIAL", providerId: GROQ_PROVIDER_ID }, registryDefault);
  check("Groq) CONFIDENTIAL + ZDR 미검증 → BLOCK(RETENTION_POLICY_INSUFFICIENT, #5)", confidentialBlocked.verdict === "BLOCK" && confidentialBlocked.blockCode === "RETENTION_POLICY_INSUFFICIENT");
  const internalPassed = evaluateProviderSecurity({ classification: "INTERNAL", providerId: GROQ_PROVIDER_ID }, registryDefault);
  check("Groq) INTERNAL + ZDR 미검증(bounded 30일로 충분) → PASS", internalPassed.verdict === "PASS");

  const zdrMeta = buildGroqProviderSecurityMetadata({ AUTODEV_GROQ_ZDR_VERIFIED: "true" });
  check("Groq) ZDR 검증됨 → retentionPolicy=zero", zdrMeta.retentionPolicy === "zero");
  check("Groq) ZDR 검증됨 → maxRetentionDays 미설정", zdrMeta.maxRetentionDays === undefined);
  const registryZdr = { [GROQ_PROVIDER_ID]: zdrMeta };
  const confidentialPassed = evaluateProviderSecurity({ classification: "CONFIDENTIAL", providerId: GROQ_PROVIDER_ID }, registryZdr);
  check("Groq) CONFIDENTIAL + ZDR 검증됨 → PASS(#6)", confidentialPassed.verdict === "PASS");
}

// =========================================================
// OpenRouter — 기본 unknown retention → 항상 BLOCK(모든 classification), ZDR 검증 시 zero.
// =========================================================
function scenarioOpenRouterZdrConfig(): void {
  check("OpenRouter-ZDR) 미설정 → false", resolveOpenRouterZdrVerification({}).verified === false);
  check("OpenRouter-ZDR) 정확히 'true' → verified=true", resolveOpenRouterZdrVerification({ AUTODEV_OPENROUTER_ZDR_VERIFIED: "true" }).verified === true);
  check("OpenRouter-ZDR) 임의 truthy('yes') → false", resolveOpenRouterZdrVerification({ AUTODEV_OPENROUTER_ZDR_VERIFIED: "yes" }).verified === false);
}

function scenarioOpenRouterMetadata(): void {
  const defaultMeta = buildOpenRouterProviderSecurityMetadata({});
  check("OpenRouter) providerId 일치", defaultMeta.providerId === OPENROUTER_PROVIDER_ID);
  check("OpenRouter) trainingPolicy=no-training(OpenRouter 자신의 정책)", defaultMeta.trainingPolicy === "no-training");
  check("OpenRouter) 기본(ZDR 미검증) retentionPolicy=unknown(공식 문서가 구체적 보존일수를 밝히지 않음 — 임의 숫자 생성 금지)", defaultMeta.retentionPolicy === "unknown");

  const registryDefault = { [OPENROUTER_PROVIDER_ID]: defaultMeta };
  const publicBlocked = evaluateProviderSecurity({ classification: "PUBLIC", providerId: OPENROUTER_PROVIDER_ID }, registryDefault);
  check(
    "OpenRouter) 기본(ZDR 미검증) → retentionPolicy=unknown이라 PUBLIC조차 BLOCK(fail-closed, provider-security-gate.ts 기존 규칙)",
    publicBlocked.verdict === "BLOCK" && publicBlocked.blockCode === "RETENTION_POLICY_UNKNOWN"
  );

  const zdrMeta = buildOpenRouterProviderSecurityMetadata({ AUTODEV_OPENROUTER_ZDR_VERIFIED: "true" });
  check("OpenRouter) ZDR 검증됨 → retentionPolicy=zero", zdrMeta.retentionPolicy === "zero");
  const registryZdr = { [OPENROUTER_PROVIDER_ID]: zdrMeta };
  const confidentialPassed = evaluateProviderSecurity({ classification: "CONFIDENTIAL", providerId: OPENROUTER_PROVIDER_ID }, registryZdr);
  check("OpenRouter) ZDR 검증됨 + CONFIDENTIAL(자기 자신만, downstream 없이) → PASS", confidentialPassed.verdict === "PASS");
}

// =========================================================
// NVIDIA NIM — 정책 확인 실패 → 항상 unknown → 항상 BLOCK(#2, #22).
// =========================================================
function scenarioNvidiaNim(): void {
  const m = buildNvidiaNimProviderSecurityMetadata();
  check("NVIDIA NIM) providerId 일치", m.providerId === NVIDIA_NIM_PROVIDER_ID);
  check("NVIDIA NIM) trainingPolicy=unknown(1차 문서 미확인 + 2차 자료 상충)", m.trainingPolicy === "unknown");
  check("NVIDIA NIM) retentionPolicy=unknown", m.retentionPolicy === "unknown");
  check("NVIDIA NIM) supportsZeroDataRetention=false(확인 안 됨)", m.supportsZeroDataRetention === false);
  check("NVIDIA NIM) trustLevel=low", m.trustLevel === "low");

  const registry = { [NVIDIA_NIM_PROVIDER_ID]: m };
  for (const classification of ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"] as const) {
    const result = evaluateProviderSecurity({ classification, providerId: NVIDIA_NIM_PROVIDER_ID }, registry);
    check(`NVIDIA NIM) ${classification} → BLOCK(정책 unknown fail-closed, #2/#22)`, result.verdict === "BLOCK");
  }
}

// =========================================================
// Secret 비노출(#23) — 이 파일의 metadata 객체 어디에도 API key "값" 필드가 없다(구조적 보장 —
// ProviderSecurityMetadata 타입 자체에 그런 필드가 없음을 직렬화로 재확인한다).
// =========================================================
function scenarioNoSecretFields(): void {
  const all = [
    buildOllamaProviderSecurityMetadata(),
    buildGroqProviderSecurityMetadata({ GROQ_API_KEY: "sk-should-never-appear-anywhere" }),
    buildOpenRouterProviderSecurityMetadata({ OPENROUTER_API_KEY: "or-should-never-appear-anywhere" }),
    buildNvidiaNimProviderSecurityMetadata(),
  ];
  const serialized = JSON.stringify(all);
  check("Secret) 어떤 metadata에도 주입한 API key 값이 나타나지 않음(#23)", !serialized.includes("should-never-appear-anywhere"));
  check("Secret) 어떤 metadata 필드도 'key'/'token'/'secret' 이름을 갖지 않음(구조적 보장)", !/key|token|secret/i.test(Object.keys(all[1]).join(",")));
}

function main(): void {
  scenarioOllama();
  scenarioGroqZdrConfig();
  scenarioGroqMetadata();
  scenarioOpenRouterZdrConfig();
  scenarioOpenRouterMetadata();
  scenarioNvidiaNim();
  scenarioNoSecretFields();

  console.log("\n=== Approved Free/Low-cost Reviewer Provider Pool(SI-3.8F) — Security Metadata 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
