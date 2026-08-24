import type { ProviderSecurityMetadata } from "./provider-security-gate";

// Approved Free/Low-cost Reviewer Provider Pool — Security Metadata — Phase SI-3.8F.
//
// openai-provider-security-metadata.ts(SI-3.8E)와 동일한 설계 원칙을 그대로 따른다: 이 파일은
// provider-security-gate.ts(SI-3.8C)의 판정 로직을 전혀 바꾸지 않는다 — evaluateProviderSecurity()는
// 이번 Task에서도 수정하지 않았다. 이 파일은 그 Gate가 소비하는 ProviderSecurityMetadata를
// 후보 4건(Ollama/Groq/OpenRouter/NVIDIA NIM)에 대해 만들 뿐이다.
//
// 2026-08-25 기준 각 provider의 공식 문서(README 하단 "policySource" 참고)를 READ-ONLY로
// 조사해 확인된 사실만 인코딩한다. 공식 문서에서 확인되지 않거나 2차 자료끼리 서로 상충하는
// 항목은 절대 추측하지 않고 "unknown"으로 남긴다 — provider-security-gate.ts의 기존 Core hard
// rule(trainingPolicy/retentionPolicy가 unknown이면 모든 classification에서 BLOCK)이 그 항목을
// 그대로 비활성화 상태로 강제한다.
//
// 어떤 함수도 실제 네트워크 요청을 하지 않는다 — 전부 로컬 상수 조립 + (Groq/OpenRouter에
// 한해) env 기반 ZDR 검증 seam이다(openai-provider-security-metadata.ts의
// resolveOpenAiZdrVerification과 동일한 fail-closed 설계: "true" 문자열이 명시적으로 설정된
// 경우에만 zero-retention으로 취급한다 — provider가 ZDR을 "제공할 수 있다"는 사실과 "이
// AutoDev 배포가 실제로 ZDR을 활성화했다"는 사실을 같은 의미로 취급하지 않는다).

export const OLLAMA_PROVIDER_ID = "ollama";
export const GROQ_PROVIDER_ID = "groq";
export const OPENROUTER_PROVIDER_ID = "openrouter";
export const NVIDIA_NIM_PROVIDER_ID = "nvidia-nim";

const POLICY_VERIFIED_AT = "2026-08-25T00:00:00.000Z";

// =========================================================
// Ollama — local provider.
// =========================================================
//
// 공식 https://ollama.com/privacy(2026-08-25 확인): "We do not collect, store, transmit, or
// have access to your prompts, responses, model interactions, or other content you process
// locally." / "We do not use your inputs or outputs to train any AI models." 로컬 실행 모델은
// 정의상 외부로 전송되지 않으므로 retention도 zero로 취급한다(§ 별도 문서화된 클라우드
// 호스팅 모델 경로는 이 provider가 다루지 않는다 — 이 Task는 로컬 실행 API만 대상으로 한다).
//
// SECRET 등급은 이 metadata와 무관하게 provider-security-gate.ts의 Core hard rule이 항상
// BLOCK한다(§ 그 파일 상단 주석 — 이 Task가 그 예외를 만들지 않는다). local이라는 이유로
// Reviewer "품질"이 자동 승인되는 것도 아니다(§ real-provider-pool.ts의 qualityTier="unknown").
export function buildOllamaProviderSecurityMetadata(): ProviderSecurityMetadata {
  return {
    providerId: OLLAMA_PROVIDER_ID,
    trainingPolicy: "no-training",
    retentionPolicy: "zero",
    supportsZeroDataRetention: true,
    dataLocation: "local-device",
    trustLevel: "high",
    allowedDataClassifications: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
    policyVerifiedAt: POLICY_VERIFIED_AT,
    costTier: "free",
  };
}

// =========================================================
// Groq — direct-external provider.
// =========================================================
//
// 공식 https://console.groq.com/docs/your-data 및
// https://console.groq.com/docs/legal/services-agreement(Section 4.2, 2026-08-25 확인):
// "Groq is not permitted to use Inputs or Outputs for training or fine-tuning any AI Model
// Services or other models, unless explicitly granted permission or instructed by Customer."
// → trainingPolicy: "no-training"(확정).
//
// retention: "By default, Groq does not retain customer data for inference requests."라고
// 명시하지만, 동시에 "system reliability/abuse monitoring 목적으로 troubleshooting/investigating
// 시에만 최대 30일 보관"이라는 조건부 예외를 문서가 명시한다. 이 예외가 어느 요청에 실제로
// 적용될지 사전에 알 수 없으므로(요청 단위로 결정되지 않음), OpenAI 패턴과 동일하게 보수적으로
// "이 조건부 예외가 있는 상태"를 bounded(30일)로 취급하고, 오직 self-serve Zero Data Retention이
// 이 배포에 대해 실제로 활성화됐다고 명시적으로 검증된 경우에만 zero로 승격한다(문서: "All
// customers may enable Zero Data Retention (ZDR) in Data Controls settings.").
const GROQ_ZDR_VERIFIED_ENV = "AUTODEV_GROQ_ZDR_VERIFIED";
const GROQ_ZDR_VERIFIED_AT_ENV = "AUTODEV_GROQ_ZDR_VERIFIED_AT";

export interface GroqZdrVerification {
  verified: boolean;
  verifiedAt?: string;
}

/** AUTODEV_GROQ_ZDR_VERIFIED를 읽는다 — Groq Console의 Data Controls에서 실제로 Zero Data
 *  Retention을 켠 것을 사람이 직접 확인했을 때만 "true"로 설정하는 local config seam이다.
 *  Groq API/Console을 호출해 이 상태를 자동 검증하지 않는다(openai-provider-security-metadata.ts의
 *  resolveOpenAiZdrVerification과 동일한 규칙: 정확히 "true" 문자열만 인정, 그 외 전부 false). */
export function resolveGroqZdrVerification(env: NodeJS.ProcessEnv = process.env): GroqZdrVerification {
  const raw = env[GROQ_ZDR_VERIFIED_ENV];
  if (raw !== "true") return { verified: false };
  const rawAt = env[GROQ_ZDR_VERIFIED_AT_ENV];
  const verifiedAt = typeof rawAt === "string" && rawAt.trim().length > 0 && !Number.isNaN(Date.parse(rawAt)) ? rawAt : undefined;
  return { verified: true, verifiedAt };
}

export function buildGroqProviderSecurityMetadata(env: NodeJS.ProcessEnv = process.env): ProviderSecurityMetadata {
  const zdr = resolveGroqZdrVerification(env);
  return {
    providerId: GROQ_PROVIDER_ID,
    trainingPolicy: "no-training",
    retentionPolicy: zdr.verified ? "zero" : "bounded",
    maxRetentionDays: zdr.verified ? undefined : 30,
    supportsZeroDataRetention: true,
    dataLocation: "United States (Google Cloud Platform)",
    // 독립 감사/계약 증거가 없어 "high"로 상향하지 않는다(OpenAI metadata와 동일한 보수적 원칙).
    trustLevel: "medium",
    // RESTRICTED를 명시적으로 승인할 근거가 없다.
    allowedDataClassifications: ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
    policyVerifiedAt: POLICY_VERIFIED_AT,
    costTier: "free",
  };
}

// =========================================================
// OpenRouter — router provider(자기 자신의 처리 계층만 표현 — 실제 inference를 수행하는
// downstream provider는 별도로 evaluateProviderSecurity()의 downstreamProviderIds 검증이
// 담당한다. § 요구사항 6/7, real-provider-pool.ts).
// =========================================================
//
// 공식 https://openrouter.ai/privacy(Last Updated 2026-07-06, 2026-08-25 확인): "OpenRouter
// does not use your Inputs or Outputs for model training." → trainingPolicy: "no-training"
// (OpenRouter 자신의 계층에 대해서만 — downstream provider가 학습에 쓰는지는 별개다).
//
// retention: 공식 문서는 구체적 보존 일수를 밝히지 않는다("We ... will retain your information
// for as long as is reasonably necessary to comply with our business and legal
// obligations..."). 확정된 숫자가 없으므로 임의 maxRetentionDays를 만들지 않는다(요구사항
// "가격/보존일수가 공식적으로 확정되지 않으면 임의 숫자 생성 금지"와 동일한 원칙을 보존일수에도
// 적용). 대신 공식 문서가 명시하는 request-level `zdr: true` 파라미터("the request will only
// be routed to endpoints that have a Zero Data Retention policy",
// docs/guides/routing/provider-selection)를 이 AutoDev 배포가 실제로 항상 사용하도록
// 구성/검증했다고 확인된 경우에만 zero로 승격한다 — 그 전까지는 unknown으로 fail-closed(모든
// classification BLOCK, PUBLIC 포함 — provider-security-gate.ts의 기존 규칙).
const OPENROUTER_ZDR_VERIFIED_ENV = "AUTODEV_OPENROUTER_ZDR_VERIFIED";
const OPENROUTER_ZDR_VERIFIED_AT_ENV = "AUTODEV_OPENROUTER_ZDR_VERIFIED_AT";

export interface OpenRouterZdrVerification {
  verified: boolean;
  verifiedAt?: string;
}

/** AUTODEV_OPENROUTER_ZDR_VERIFIED — 이 배포의 OpenRouter adapter가 모든 요청에 실제로
 *  `provider.zdr: true`를 강제하도록 구성/확인됐음을 사람이 직접 검증했을 때만 "true"로
 *  설정하는 local config seam이다(OpenRouter API를 호출해 자동 검증하지 않는다). */
export function resolveOpenRouterZdrVerification(env: NodeJS.ProcessEnv = process.env): OpenRouterZdrVerification {
  const raw = env[OPENROUTER_ZDR_VERIFIED_ENV];
  if (raw !== "true") return { verified: false };
  const rawAt = env[OPENROUTER_ZDR_VERIFIED_AT_ENV];
  const verifiedAt = typeof rawAt === "string" && rawAt.trim().length > 0 && !Number.isNaN(Date.parse(rawAt)) ? rawAt : undefined;
  return { verified: true, verifiedAt };
}

export function buildOpenRouterProviderSecurityMetadata(env: NodeJS.ProcessEnv = process.env): ProviderSecurityMetadata {
  const zdr = resolveOpenRouterZdrVerification(env);
  return {
    providerId: OPENROUTER_PROVIDER_ID,
    trainingPolicy: "no-training",
    retentionPolicy: zdr.verified ? "zero" : "unknown",
    supportsZeroDataRetention: true,
    dataLocation: "unknown",
    trustLevel: "medium",
    allowedDataClassifications: ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
    policyVerifiedAt: POLICY_VERIFIED_AT,
    // 무료 모델과 유료 모델이 혼재하므로 단일 costTier로 확정하지 않는다(§ 요구사항 11 —
    // 이 필드는 판정에 쓰이지 않는 순수 참고 메타데이터일 뿐이다).
    costTier: "unknown",
  };
}

// =========================================================
// NVIDIA NIM(build.nvidia.com API Catalog) — direct-external provider 후보. POLICY_UNKNOWN으로
// 등록한다(승인하지 않는다).
// =========================================================
//
// 1차 공식 문서(NVIDIA API Trial Terms of Service PDF,
// https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf)를
// 이번 조사에서 텍스트로 직접 확인하지 못했다(PDF 스트림 추출 실패). 문서 제목 자체("API
// TRIAL Terms of Service")와 검색 결과로 확인되는 2차 정보는 이 API Catalog가 "limited trial
// purposes only"이며 production 사용에 제한이 있을 수 있음을 시사하지만, 원문을 직접 인용하지
// 못했다. 더 결정적으로, training/retention에 대한 2차 자료가 서로 상충한다 — 일부는 "does not
// use prompts/responses to train models"라고 보고하고, 다른 자료는 "free API 엔드포인트를 통해
// 처리된 입력/출력이 기록되며 NVIDIA 자체 모델 학습에 쓰인다"고 보고한다. SNS/블로그/2차 요약만으로
// 승인하지 않는다는 원칙과, 서로 다른 근거가 충돌하면 승인하지 않는다는 원칙(§ D2
// detectEvidenceConflicts와 동일한 정신) 둘 다에 따라 trainingPolicy/retentionPolicy를 확정하지
// 않고 "unknown"으로 둔다 — provider-security-gate.ts의 기존 Core hard rule이 이를 모든
// classification(PUBLIC 포함)에서 자동으로 BLOCK 상태로 만든다.
export function buildNvidiaNimProviderSecurityMetadata(): ProviderSecurityMetadata {
  return {
    providerId: NVIDIA_NIM_PROVIDER_ID,
    trainingPolicy: "unknown",
    retentionPolicy: "unknown",
    supportsZeroDataRetention: false,
    dataLocation: "unknown",
    trustLevel: "low",
    // trainingPolicy/retentionPolicy가 unknown이므로 이 배열의 내용과 무관하게 항상 BLOCK된다
    // (evaluateSingleProviderForClassification의 판정 순서) — 그래도 형식상 최소 하나는
    // 채워야 metadata shape validation을 통과하므로 가장 낮은 등급만 형식적으로 넣는다.
    allowedDataClassifications: ["PUBLIC"],
    policyVerifiedAt: POLICY_VERIFIED_AT,
    costTier: "free",
  };
}
