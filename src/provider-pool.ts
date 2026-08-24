import type { DataClassification, ProviderSecurityMetadata, ProviderSecurityRegistry, ProviderSecurityGateResult } from "./provider-security-gate";
import { evaluateProviderSecurity } from "./provider-security-gate";

// Approved Free/Low-cost Reviewer Provider Pool — Core Catalog Model — Phase SI-3.8F.
//
// 향후 저위험 PreReviewer/보조 검토/로컬 검토에 쓸 수 있는 검증된 Free/Low-cost ReviewProvider
// 후보를 allow-list 기반으로 등록하기 위한 순수 데이터 모델 + deterministic 판정 함수만
// 제공한다. 이 파일은 어떤 실제 provider도 하드코딩하지 않는다(real-provider-pool.ts가 그
// 역할을 한다) — capability-resolver.ts(D1)가 real-source-catalog.ts(D5)와 분리된 것과 동일한
// 설계 원칙이다.
//
// 이 파일은 provider-security-gate.ts(SI-3.8C)의 판정 로직(evaluateProviderSecurity)을 전혀
// 수정하지 않는다 — router provider의 "downstream이 없으면 자기 자신의 승인만으로 통과하지
// 않는다"는 추가 요구사항(§ 요구사항 6)만 이 파일의 evaluateProviderPoolSecurity()가 감싸서
// 강제한다. Claude Developer 대체/자동 provider routing/실제 provider 호출 실행은 이 파일의
// 책임이 아니다(§ 요구사항 12 — 자동 선택은 SI-3.8G).
//
// "비용이 무료라고 Security PASS가 되는 구조 금지"(§ 요구사항 4) — costTier/freeTier 필드는
// evaluateProviderPoolSecurity()의 어떤 분기에서도 읽히지 않는다(provider-security-gate.ts와
// 동일하게 순수 참고 메타데이터일 뿐이다).

// =========================================================
// Catalog 모델.
// =========================================================

export type ProviderPoolProviderType = "local" | "direct-external" | "router";

/** catalog 항목의 정책 승인 상태 — "APPROVED"는 정책상 승인됐다는 뜻일 뿐 런타임에 실제로 쓸 수
 *  있다는 뜻이 아니다(§ 요구사항 10, resolveProviderPoolStatus가 런타임 상태로 다시 정제한다). */
export type ProviderApprovalStatus = "APPROVED" | "DISABLED" | "POLICY_UNKNOWN";

/** 요구사항 10의 6개 상태 전체 — approvalStatus(정책 단계, APPROVED/DISABLED/POLICY_UNKNOWN
 *  중 하나)와 resolveProviderPoolStatus()의 런타임 결과(DISABLED/POLICY_UNKNOWN/NOT_CONFIGURED/
 *  UNAVAILABLE/AVAILABLE 중 하나 — 정책이 APPROVED인 항목만 런타임 3상태로 더 정제된다)가
 *  합쳐진 union이다. resolveProviderPoolStatus()는 절대 bare "APPROVED"를 반환하지 않는다 —
 *  APPROVED는 항상 NOT_CONFIGURED/UNAVAILABLE/AVAILABLE 중 하나로 정제된 뒤에만 최종 상태가
 *  된다("catalog에 있다고 AVAILABLE로 간주하지 않는다"). */
export type ProviderPoolStatus = ProviderApprovalStatus | "NOT_CONFIGURED" | "UNAVAILABLE" | "AVAILABLE";

export interface ProviderPoolModelMetadata {
  /** 공식 문서로 확인된 모델 id 목록 — 확인되지 않았거나 로컬 환경마다 달라 고정할 수 없으면
   *  빈 배열로 두고 notes에 이유를 남긴다(임의로 채우지 않는다). */
  models: string[];
  notes?: string;
}

export interface ProviderPoolFreeTierMetadata {
  freeTierAvailable: boolean;
  /** true는 "이 provider를 어떤 조건에서도 절대 비용이 발생하지 않는다고 보장한다"는 뜻이다 —
   *  quota 초과/모델별 유료/provider 정책 변경 가능성이 있는 한 항상 false로 둔다(§ 요구사항
   *  11, "freeTierAvailable=true"와 "$0 guaranteed"를 구분). */
  guaranteedZeroCost: boolean;
  /** 공식 문서 기준 free tier 조건을 사람이 읽을 수 있게 요약한 텍스트 — 임의 숫자를 만들지
   *  않고 문서에 실제로 있는 내용만 담는다. */
  description: string;
  sourceUrl: string;
}

export interface ProviderPoolRateLimitMetadata {
  requestsPerMinute?: number;
  requestsPerDay?: number;
  tokensPerMinute?: number;
  notes?: string;
  sourceUrl: string;
}

export type ProviderQualityTier = "unknown" | "basic" | "capable" | "frontier";

export interface ProviderPoolEntry {
  providerId: string;
  providerType: ProviderPoolProviderType;
  /** 이 provider가 SI-3.8E ReviewProvider abstraction의 구현 대상인지(향후 PreReviewer 등에
   *  쓰일 capability가 있는지) — false면 catalog에는 있지만 review 용도로 의도되지 않았다는
   *  뜻이다. */
  reviewProviderCapability: boolean;
  modelMetadata?: ProviderPoolModelMetadata;
  freeTier?: ProviderPoolFreeTierMetadata;
  rateLimit?: ProviderPoolRateLimitMetadata;
  /** provider-security-gate.ts가 실제로 소비하는 값 — 이 필드 하나가 유일한 source of truth다
   *  (providerId는 반드시 이 객체의 providerId와 일치해야 한다, validateProviderPoolEntry가
   *  재확인). */
  security: ProviderSecurityMetadata;
  approvalStatus: ProviderApprovalStatus;
  /** approvalStatus !== "APPROVED"이면 필수 — "정책을 추측하지 않는다"는 원칙을 사람이 읽을 수
   *  있는 사유로 남긴다. */
  disabledReason?: string;
  /** 이 항목의 정책 판단 근거가 된 공식 문서 URL 목록 — 최소 1개 필수. */
  policySource: string[];
  /** 이 정책을 실제로 확인한 시각(ISO 8601). */
  policyVerifiedAt: string;
  qualityTier: ProviderQualityTier;
  /** providerType==="router"일 때만 true — router는 자신의 승인만으로 통과하지 않는다(§
   *  evaluateProviderPoolSecurity). */
  downstreamProviderRequired: boolean;
  /** router가 실제로 데이터를 넘기는 downstream provider id 목록 — 이 목록에 없는 provider로는
   *  라우팅한다고 주장하지 않는다. router가 아니면 반드시 비어있어야 한다. */
  downstreamProviderIds?: string[];
  /** direct-external/router가 인증에 필요로 하는 API key의 "환경변수 이름"(값이 아니다) —
   *  local provider는 undefined. */
  requiresApiKeyEnv?: string;
}

// =========================================================
// Entry shape validation — "정보가 없거나 불완전하면 허용하지 않는다"는 provider-security-gate.ts
// 원칙을 catalog entry 레벨에서도 강제한다.
// =========================================================

export type ProviderPoolEntryValidation = { ok: true } | { ok: false; reason: string };

const KNOWN_PROVIDER_TYPES: ReadonlySet<ProviderPoolProviderType> = new Set(["local", "direct-external", "router"]);
const KNOWN_APPROVAL_STATUSES: ReadonlySet<ProviderApprovalStatus> = new Set(["APPROVED", "DISABLED", "POLICY_UNKNOWN"]);

export function validateProviderPoolEntry(entry: ProviderPoolEntry): ProviderPoolEntryValidation {
  if (!entry || typeof entry !== "object") return { ok: false, reason: "entry가 객체가 아닙니다." };
  if (typeof entry.providerId !== "string" || entry.providerId.trim().length === 0) {
    return { ok: false, reason: "providerId가 비어있습니다." };
  }
  if (!entry.security || entry.security.providerId !== entry.providerId) {
    return { ok: false, reason: "security.providerId가 entry.providerId와 일치하지 않습니다." };
  }
  if (!KNOWN_PROVIDER_TYPES.has(entry.providerType)) {
    return { ok: false, reason: `providerType(${entry.providerType})이 유효하지 않습니다.` };
  }
  if (!KNOWN_APPROVAL_STATUSES.has(entry.approvalStatus)) {
    return { ok: false, reason: `approvalStatus(${entry.approvalStatus})가 유효하지 않습니다.` };
  }
  if (entry.approvalStatus !== "APPROVED" && (!entry.disabledReason || entry.disabledReason.trim().length === 0)) {
    return { ok: false, reason: "approvalStatus가 APPROVED가 아니면 disabledReason이 필요합니다." };
  }
  if (!Array.isArray(entry.policySource) || entry.policySource.length === 0) {
    return { ok: false, reason: "policySource가 비어있습니다(최소 1개의 공식 문서 URL 필요)." };
  }
  if (typeof entry.policyVerifiedAt !== "string" || Number.isNaN(Date.parse(entry.policyVerifiedAt))) {
    return { ok: false, reason: "policyVerifiedAt이 유효한 날짜 문자열이 아닙니다." };
  }
  if (entry.providerType === "router") {
    if (entry.downstreamProviderRequired !== true) {
      return { ok: false, reason: "router provider는 downstreamProviderRequired=true여야 합니다." };
    }
  } else {
    if (entry.downstreamProviderRequired) {
      return { ok: false, reason: "router가 아닌 provider는 downstreamProviderRequired=false여야 합니다." };
    }
    if (entry.downstreamProviderIds && entry.downstreamProviderIds.length > 0) {
      return { ok: false, reason: "router가 아닌 provider는 downstreamProviderIds를 가질 수 없습니다." };
    }
  }
  if (entry.providerType !== "local" && entry.requiresApiKeyEnv !== undefined && entry.requiresApiKeyEnv.trim().length === 0) {
    return { ok: false, reason: "requiresApiKeyEnv가 빈 문자열입니다." };
  }
  return { ok: true };
}

/** catalog entry 목록 → provider-security-gate.ts가 바로 소비할 수 있는 registry. */
export function toProviderSecurityRegistry(entries: readonly ProviderPoolEntry[]): ProviderSecurityRegistry {
  const out: Record<string, ProviderSecurityMetadata> = {};
  for (const e of entries) out[e.providerId] = e.security;
  return out;
}

// =========================================================
// Runtime Availability — "catalog에 있다고 AVAILABLE로 간주하지 않는다"(§ 요구사항 10).
// =========================================================

export interface ProviderRuntimeProbeResult {
  available: boolean;
  detail?: string;
}

/**
 * catalog entry 하나의 최종 상태를 판정한다 — 순수 함수(probeResult는 호출자가 이미 실행한
 * probe의 결과를 넘길 뿐, 이 함수 자신은 어떤 I/O도 하지 않는다).
 *
 * 우선순위: (1) approvalStatus가 APPROVED가 아니면 그대로 반환(DISABLED/POLICY_UNKNOWN은 런타임
 * 상태와 무관하게 항상 최종값이다 — 정책 문제는 설정/가동 여부로 해소되지 않는다). (2)
 * requiresApiKeyEnv가 있는데 해당 환경변수가 없으면 NOT_CONFIGURED. (3) probeResult가 없으면 —
 * local provider는 NOT_CONFIGURED(서버 연동 자체가 설정되지 않음), 그 외(외부 provider로서 key는
 * 있지만 도달 가능성을 확인하지 않음)는 UNAVAILABLE(거짓 AVAILABLE 금지). (4) probeResult가 있으면
 * 그 결과를 그대로 AVAILABLE/UNAVAILABLE로 반영한다.
 */
export function resolveProviderPoolStatus(
  entry: ProviderPoolEntry,
  env: NodeJS.ProcessEnv = process.env,
  probeResult?: ProviderRuntimeProbeResult
): ProviderPoolStatus {
  if (entry.approvalStatus !== "APPROVED") return entry.approvalStatus;

  if (entry.requiresApiKeyEnv) {
    const key = env[entry.requiresApiKeyEnv];
    if (typeof key !== "string" || key.trim().length === 0) return "NOT_CONFIGURED";
  }

  if (!probeResult) {
    return entry.providerType === "local" ? "NOT_CONFIGURED" : "UNAVAILABLE";
  }
  return probeResult.available ? "AVAILABLE" : "UNAVAILABLE";
}

// =========================================================
// Router Security 강제 — "router 자신에 대한 승인만으로 전체를 승인해서는 안 된다"(§ 요구사항
// 6). provider-security-gate.ts는 이 파일이 만들지 않는다 — evaluateProviderSecurity()를 그대로
// 재사용하되, downstream이 아예 지정되지 않은 경우만 이 함수가 추가로 막는다(그 함수 자체는
// downstreamProviderIds가 없으면 router 자신의 판정만으로 PASS를 반환할 수 있다 — 단일 provider
// 호출과 router 호출을 구분하지 않기 때문이다. 이 wrapper가 그 구분을 추가한다).
// =========================================================

/**
 * ProviderPoolEntry 하나를 대상으로 evaluateProviderSecurity()를 호출한다. 이 함수는 항상
 * entry.approvalStatus를 먼저 확인한다 — "APPROVED"가 아니면 security metadata 내용이 무엇이든
 * (설령 미래에 어떤 DISABLED/POLICY_UNKNOWN 항목에 컴플라이언트한 값이 채워지더라도)
 * evaluateProviderSecurity()를 아예 호출하지 않고 즉시 BLOCK한다 — resolveProviderPoolStatus()가
 * 이미 approvalStatus!=="APPROVED"를 런타임과 무관한 최종 상태로 취급하는 것과 동일한 원칙을
 * security 판정에도 적용한다(Claude code-review에서 이 wrapper가 approvalStatus를 확인하지
 * 않던 gap을 지적함).
 *
 * approvalStatus가 APPROVED인 경우에만 providerType==="router" && downstreamProviderIds가
 * 비어있는지 추가로 확인한다 — 비어있으면 evaluateProviderSecurity()를 호출하지 않고 즉시
 * BLOCK한다(router 자신의 metadata가 아무리 컴플라이언트해도 downstream을 모르면 통과시키지
 * 않는다 — "downstream unknown: BLOCK").
 */
export function evaluateProviderPoolSecurity(
  entry: ProviderPoolEntry,
  classification: DataClassification,
  registry: ProviderSecurityRegistry
): ProviderSecurityGateResult {
  if (entry.approvalStatus !== "APPROVED") {
    return {
      verdict: "BLOCK",
      classification,
      providerId: entry.providerId,
      blockCode: "PROVIDER_UNKNOWN",
      reason: `provider(${entry.providerId})의 catalog 승인 상태가 ${entry.approvalStatus}입니다 — security metadata 내용과 무관하게 정책 승인 없이는 사용할 수 없습니다.`,
      downstreamResults: [],
    };
  }
  if (entry.providerType === "router" && (!entry.downstreamProviderIds || entry.downstreamProviderIds.length === 0)) {
    return {
      verdict: "BLOCK",
      classification,
      providerId: entry.providerId,
      blockCode: "DOWNSTREAM_PROVIDER_BLOCKED",
      reason: `router provider(${entry.providerId})는 downstream provider가 식별되지 않으면 사용할 수 없습니다 — router 자체 승인만으로 전체를 통과시키지 않습니다.`,
      downstreamResults: [],
    };
  }
  return evaluateProviderSecurity(
    {
      classification,
      providerId: entry.providerId,
      downstreamProviderIds: entry.providerType === "router" ? entry.downstreamProviderIds : undefined,
    },
    registry
  );
}
