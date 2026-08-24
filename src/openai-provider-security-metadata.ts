import type { ProviderSecurityMetadata, ProviderSecurityRegistry } from "./provider-security-gate";
import { OPENAI_REVIEW_PROVIDER_ID } from "./openai-review-provider";

// OpenAI Provider Security Metadata & Zero Data Retention(ZDR) Verification Config —
// SI-3.8E Security Ordering Correction.
//
// provider-security-gate.ts(SI-3.8C)는 policy 판정 로직만 제공하고 어떤 provider의 실제
// 정책이 무엇인지는 전혀 모른다 — 이 파일이 그 registry 판정에 쓰이는 OpenAI 전용 metadata를
// 만든다. 2026-08-25 기준 공식 OpenAI API 정책으로 확정된 사실만 인코딩한다:
//   - API business data는 기본적으로 model 학습에 사용되지 않는다 → trainingPolicy: "no-training"
//   - 일반 API input/output은 최대 30일 보관될 수 있다(abuse monitoring 목적) →
//     retentionPolicy: "bounded", maxRetentionDays: 30
//   - Zero Data Retention(ZDR)은 eligible API customers/endpoints에 제공 가능하다 →
//     supportsZeroDataRetention: true
//
// 핵심 원칙 — supportsZeroDataRetention=true는 "OpenAI가 ZDR을 제공할 수 있다"는 뜻일 뿐,
// "이 AutoDev 배포가 실제로 ZDR 적용 대상 계정/엔드포인트로 설정되어 있다"를 의미하지 않는다.
// 이 둘을 같은 의미로 취급하지 않는다 — 현재 AutoDev 환경에 ZDR이 실제 활성화됐다는 증거가
// 없으므로, 아래 resolveOpenAiZdrVerification()이 명시적으로 true라고 확인해주지 않는 한 항상
// retentionPolicy: "bounded"(30일)로 fail-closed 계산한다. 이 파일은 OpenAI API/Billing/Admin
// API로 ZDR 상태를 자동 조회하지 않는다 — 그런 자동 조회는 별도 Task 범위다.

const ZDR_VERIFIED_ENV = "AUTODEV_OPENAI_ZDR_VERIFIED";
const ZDR_VERIFIED_AT_ENV = "AUTODEV_OPENAI_ZDR_VERIFIED_AT";

export interface OpenAiZdrVerification {
  /** true인 경우에만 zero-retention profile을 쓴다 — missing/invalid는 항상 false(fail-closed). */
  verified: boolean;
  /** verified===true이고 AUTODEV_OPENAI_ZDR_VERIFIED_AT이 유효한 ISO 날짜 문자열일 때만
   *  채워진다(구조적 as-of metadata) — 유효하지 않으면 조용히 생략한다(verified 자체를
   *  false로 만들지는 않는다: "언제 확인했는지"와 "확인했는지" 자체는 별개 정보다). */
  verifiedAt?: string;
}

/** AUTODEV_OPENAI_ZDR_VERIFIED를 읽는다 — 사용자가 실제 OpenAI 계정/API 프로젝트에서 ZDR
 *  활성화를 직접 확인했을 때만 "true"로 명시적으로 설정하는 local config seam이다. 이 함수는
 *  OpenAI API/Billing/Admin API를 호출해 이 상태를 검증하지 않는다(§ 파일 상단 주석) — 순수하게
 *  환경변수 읽기다. API key 등 secret 값은 이 함수가 다루는 값에 전혀 관여하지 않는다. */
export function resolveOpenAiZdrVerification(env: NodeJS.ProcessEnv = process.env): OpenAiZdrVerification {
  // runtime-origin.ts(isProductionRuntime)와 동일한 convention — 정확히 "true" 문자열만
  // 인정한다(대소문자 변형/trim/느슨한 truthy 전부 거부). missing/invalid는 전부 false다
  // (clamp가 아니라 fail-closed).
  const raw = env[ZDR_VERIFIED_ENV];
  if (raw !== "true") {
    return { verified: false };
  }
  const rawAt = env[ZDR_VERIFIED_AT_ENV];
  const verifiedAt = typeof rawAt === "string" && rawAt.trim().length > 0 && !Number.isNaN(Date.parse(rawAt)) ? rawAt : undefined;
  return { verified: true, verifiedAt };
}

const POLICY_VERIFIED_AT = "2026-08-25T00:00:00.000Z";

/**
 * OpenAI provider의 ProviderSecurityMetadata를 만든다 — retentionPolicy만
 * resolveOpenAiZdrVerification()의 결과에 따라 "zero"(verified) 또는 "bounded"(그 외 전부,
 * 기본값)로 달라진다. trustLevel은 "high"라고 확정할 근거(예: 공식 감사/계약 문서)가 없으므로
 * 임의로 상향하지 않고 "medium"으로 보수적으로 둔다(현재 기본 등급인 CONFIDENTIAL 판정에는
 * trustLevel이 관여하지 않는다 — RESTRICTED에서만 관여한다). allowedDataClassifications에
 * RESTRICTED를 포함하지 않는다 — RESTRICTED 등급 데이터를 이 provider로 보내도 된다는 명시적
 * 승인 근거가 없다.
 */
export function buildOpenAiProviderSecurityMetadata(env: NodeJS.ProcessEnv = process.env): ProviderSecurityMetadata {
  const zdr = resolveOpenAiZdrVerification(env);
  return {
    providerId: OPENAI_REVIEW_PROVIDER_ID,
    trainingPolicy: "no-training",
    retentionPolicy: zdr.verified ? "zero" : "bounded",
    maxRetentionDays: zdr.verified ? undefined : 30,
    supportsZeroDataRetention: true,
    dataLocation: "unknown",
    trustLevel: "medium",
    allowedDataClassifications: ["PUBLIC", "INTERNAL", "CONFIDENTIAL"],
    policyVerifiedAt: POLICY_VERIFIED_AT,
    costTier: "paid",
  };
}

/** gpt-reviewer.ts의 Provider Security Gate 호출에 그대로 쓰이는 registry — OpenAI 하나만
 *  안다. 등록되지 않은 provider(예: 테스트 fake provider, 향후 다른 provider)는 이 registry에
 *  없으므로 evaluateProviderSecurity()가 PROVIDER_UNKNOWN으로 BLOCK한다(§ 요구사항 5 — 알 수
 *  없는 provider를 자동 allow하지 않는다). */
export function resolveOpenAiProviderSecurityRegistry(env: NodeJS.ProcessEnv = process.env): ProviderSecurityRegistry {
  const metadata = buildOpenAiProviderSecurityMetadata(env);
  return { [metadata.providerId]: metadata };
}
