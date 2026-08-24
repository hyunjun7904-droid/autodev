// Data Classification & Provider Security Gate — Phase SI-3.8C.
//
// 외부 AI/API Provider(Groq/Gemini/OpenRouter/Ollama/OmniRoute/FreeLLMAPI 등)를 "비용이
// 싸다"는 이유만으로 선택하지 못하게 막는 deterministic Security Gate다. 이 파일은 실제로
// 어떤 provider에도 연결하지 않는다(실제 네트워크 호출/HTTP client import가 이 파일 어디에도
// 없다) — gpt-budget-guard.ts가 "호출 전에 비용/크기 위험을 막는" 것과 동일한 위치에서,
// "호출 전에 데이터 등급과 provider의 데이터 처리 정책이 실제로 맞는지"를 판정한다. Budget
// Guard/Usage Ledger를 대체하거나 우회하지 않는다 — 이 파일은 그 둘을 import도, 호출도 하지
// 않고 완전히 독립적으로 존재한다(요구사항 9).
//
// Provider routing/fallback 실행, 실제 provider 연결(Groq/Gemini/OpenRouter/Ollama/
// OmniRoute/FreeLLMAPI), reviewer/JARVIS 배선은 이번 Task 범위 밖이다 — 이 파일은 "요청 데이터
// 등급 X를 provider Y(및 router라면 downstream provider들)로 보내도 되는가"를 판정하는
// 순수 함수(evaluateProviderSecurity)와 그 판정에 쓰이는 데이터 모델만 제공한다.
//
// capability-resolver.ts(D1)/candidate-evidence.ts(D2)와 동일한 설계 원칙을 따른다:
//   - LLM을 호출하지 않는다. 동일 입력 → 항상 동일 결과(순수 함수).
//   - "정보가 없거나 불완전하면 허용하지 않는다" — unknown/incomplete는 항상 BLOCK이지
//     PASS의 근거가 되지 않는다(요구사항 1, "policy unknown → default disabled").
//   - Core hard rule은 어떤 policy/설정으로도 우회할 수 없다(이 파일은 policy 인자를 아예
//     받지 않는다 — provider registry 자체가 "무엇이 허용되는지"의 유일한 입력이고, 그
//     registry조차 SECRET 등급은 절대 되살릴 수 없다).
//
// Secret 미노출(요구사항 "Provider security decision이 로그/ledger에 Secret 원문을 남기면
// 안 된다"): 이 모듈의 모든 타입은 provider/classification 식별자와 열거형 정책 값만
// 다룬다 — 실제 요청 prompt/diff/응답 본문을 담는 필드가 애초에 존재하지 않는다(usage-ledger.ts
// 상단 주석과 동일한 설계: "secret이 담길 수 있는 필드 자체를 두지 않는다"). 그러므로 이
// Gate의 판정 결과(reason 문자열 포함)를 그대로 로그/ledger에 남겨도 구조적으로 secret 원문이
// 섞여 들어갈 경로가 없다.

// =========================================================
// Data Classification.
// =========================================================

/**
 * SECRET은 다른 네 등급과 성격이 다른 special class다(요구사항) — 외부 AI/API provider로의
 * 전송 자체가 항상 금지된다. 이 Task의 registry가 모델링하는 provider는 모두 "외부 AI/API
 * Provider"뿐이다(IMPLEMENTATION BOUNDARY상 실제 local route(Ollama 등) 연결이 이번 Task에
 * 없다) — 그래서 evaluateProviderSecurity()는 SECRET을 어떤 provider에 대해서도 예외 없이
 * BLOCK한다("always BLOCK"과 "external provider always BLOCK"이 이 Task 범위 안에서는
 * 동치다). 향후 실제 local route가 추가되는 별도 Task에서도 SECRET은 Core hard rule로 남아야
 * 하며, 이 함수는 그 판정을 어떤 인자로도 약화시킬 수 없다(policy 인자 자체가 없다).
 */
export type DataClassification = "PUBLIC" | "INTERNAL" | "CONFIDENTIAL" | "RESTRICTED" | "SECRET";

type NonSecretClassification = Exclude<DataClassification, "SECRET">;

/** 등급 서열 — SECRET은 별도 분기에서 항상 먼저 처리되므로 이 표에 포함하지 않는다. */
const CLASSIFICATION_LEVEL: Record<NonSecretClassification, number> = {
  PUBLIC: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
};

// =========================================================
// Provider Security Metadata.
// =========================================================

/** provider가 요청 데이터를 모델 학습에 쓰는지 — "unknown"은 "확인하지 못했다"는 뜻이며,
 *  절대 "allowed"처럼 관대하게 취급되지 않는다(요구사항 1). */
export type TrainingPolicy = "allowed" | "no-training" | "unknown";

/** provider의 데이터 보존 정책 — "zero"(요청 처리 즉시 폐기)/"bounded"(정해진 기간 후
 *  삭제, maxRetentionDays로 표현)/"unbounded"(보존기간 제한 없음)/"unknown"(확인 안 됨). */
export type RetentionPolicy = "zero" | "bounded" | "unbounded" | "unknown";

export type ProviderTrustLevel = "low" | "medium" | "high";

/** 비용 등급 — 순수 참고 메타데이터다. evaluateProviderSecurity()의 어떤 분기도 이 필드를
 *  읽지 않는다(요구사항 5, "free tier 여부는 security allow 근거가 아님"). */
export type ProviderCostTier = "free" | "paid" | "unknown";

export interface ProviderSecurityMetadata {
  /** registry의 key와 반드시 일치해야 한다(validateProviderSecurityMetadataShape가 재확인). */
  providerId: string;
  trainingPolicy: TrainingPolicy;
  retentionPolicy: RetentionPolicy;
  /** retentionPolicy==="bounded"일 때만 의미가 있고 필수다(그 외에는 무시됨). */
  maxRetentionDays?: number;
  /** provider가 zero data retention 모드를 실제로 지원/보장하는지 — retentionPolicy와
   *  별개 필드로 둔다(예: 기본은 bounded지만 옵션으로 zero-retention을 요청할 수 있는
   *  provider를 표현하기 위함). 이 필드 자체는 이번 Task의 판정 로직에서 retentionPolicy를
   *  대체하지 않는다 — retentionPolicy==="zero"만 "zero 보존"으로 인정한다. */
  supportsZeroDataRetention: boolean;
  /** 데이터가 실제로 처리/저장되는 지역 — 확인되지 않았으면 "unknown"으로 명시한다(자유
   *  텍스트를 비워두는 것과 "unknown"을 명시하는 것을 구분하기 위함). */
  dataLocation?: string | "unknown";
  trustLevel: ProviderTrustLevel;
  /** 이 provider가 명시적으로 처리 승인된 등급 목록(allow-list) — SECRET은 여기 포함되어도
   *  무시된다(evaluateProviderSecurity가 SECRET을 항상 별도 분기에서 처리하므로 이 목록을
   *  전혀 참조하지 않는다). 비어있으면(=아무 등급도 명시적으로 승인되지 않음) metadata
   *  불완전으로 취급해 BLOCK한다. */
  allowedDataClassifications: DataClassification[];
  /** 이 정책을 사람이 마지막으로 확인한 시각(ISO 8601) — policyVersion과 최소 하나는
   *  있어야 한다("terms/policy verifiedAt 또는 version/as-of metadata" 요구사항). */
  policyVerifiedAt?: string;
  policyVersion?: string;
  /** 참고용일 뿐 판정에 쓰이지 않는다(요구사항 5). */
  costTier?: ProviderCostTier;
}

export type ProviderSecurityRegistry = Readonly<Record<string, ProviderSecurityMetadata>>;

// =========================================================
// Metadata shape validation — "정보가 없거나 불완전하면 허용하지 않는다".
// =========================================================

const VALID_TRAINING_POLICIES: ReadonlySet<TrainingPolicy> = new Set(["allowed", "no-training", "unknown"]);
const VALID_RETENTION_POLICIES: ReadonlySet<RetentionPolicy> = new Set(["zero", "bounded", "unbounded", "unknown"]);
const VALID_TRUST_LEVELS: ReadonlySet<ProviderTrustLevel> = new Set(["low", "medium", "high"]);

type MetadataShapeResult = { ok: true } | { ok: false; reason: string };

/** provider metadata가 이 Gate가 판정에 쓸 수 있는 최소 형태를 갖췄는지 확인한다 — 값 자체가
 *  안전한지(예: unknown이라 BLOCK인지)는 여기서 판정하지 않는다(그건 evaluateSingleProvider의
 *  다음 단계). 여기서는 오직 "필수 필드가 존재하고 알려진 형태인가"만 본다. */
function validateProviderSecurityMetadataShape(metadata: ProviderSecurityMetadata, expectedProviderId: string): MetadataShapeResult {
  if (!metadata || typeof metadata !== "object") return { ok: false, reason: "metadata가 객체가 아닙니다." };
  if (typeof metadata.providerId !== "string" || metadata.providerId.trim().length === 0) {
    return { ok: false, reason: "providerId가 비어있습니다." };
  }
  if (metadata.providerId !== expectedProviderId) {
    return { ok: false, reason: `metadata.providerId("${metadata.providerId}")가 registry key("${expectedProviderId}")와 일치하지 않습니다.` };
  }
  if (!VALID_TRAINING_POLICIES.has(metadata.trainingPolicy)) return { ok: false, reason: "trainingPolicy 값이 유효하지 않습니다." };
  if (!VALID_RETENTION_POLICIES.has(metadata.retentionPolicy)) return { ok: false, reason: "retentionPolicy 값이 유효하지 않습니다." };
  if (metadata.retentionPolicy === "bounded") {
    if (typeof metadata.maxRetentionDays !== "number" || !Number.isFinite(metadata.maxRetentionDays) || metadata.maxRetentionDays <= 0) {
      return { ok: false, reason: "retentionPolicy가 bounded인데 유효한 maxRetentionDays가 없습니다." };
    }
  }
  if (typeof metadata.supportsZeroDataRetention !== "boolean") return { ok: false, reason: "supportsZeroDataRetention이 boolean이 아닙니다." };
  if (!VALID_TRUST_LEVELS.has(metadata.trustLevel)) return { ok: false, reason: "trustLevel 값이 유효하지 않습니다." };
  if (!Array.isArray(metadata.allowedDataClassifications) || metadata.allowedDataClassifications.length === 0) {
    return { ok: false, reason: "allowedDataClassifications가 비어있습니다." };
  }
  const hasVerifiedAt = typeof metadata.policyVerifiedAt === "string" && metadata.policyVerifiedAt.trim().length > 0;
  const hasVersion = typeof metadata.policyVersion === "string" && metadata.policyVersion.trim().length > 0;
  if (!hasVerifiedAt && !hasVersion) {
    return { ok: false, reason: "policyVerifiedAt 또는 policyVersion 중 최소 하나는 있어야 합니다(정책 확인 시점/버전 근거 없음)." };
  }
  return { ok: true };
}

// =========================================================
// Retention 충분성 — CONFIDENTIAL 이상 등급에만 적용된다.
// =========================================================

// CONFIDENTIAL/RESTRICTED 등급 데이터를 허용하려면 "짧게 제한된" 보존만 인정한다. 30일은
// 이 Gate의 Core 기본 상한이며, provider metadata로 이보다 완화(연장)할 수 없다 — 오직
// 이 값 이하로 더 짧게 보고된 provider만 통과한다.
const MAX_RETENTION_DAYS_FOR_HIGHER_CLASSIFICATION = 30;

function isRetentionSufficientForHigherClassification(metadata: ProviderSecurityMetadata): boolean {
  if (metadata.retentionPolicy === "zero") return true;
  if (metadata.retentionPolicy === "bounded") {
    return typeof metadata.maxRetentionDays === "number" && metadata.maxRetentionDays <= MAX_RETENTION_DAYS_FOR_HIGHER_CLASSIFICATION;
  }
  return false; // "unbounded"/"unknown"은 여기 도달하지 않지만(unknown은 이전 단계에서 이미 BLOCK) 방어적으로 false.
}

// =========================================================
// 판정 결과 타입 — fail-closed typed result(요구사항 8).
// =========================================================

export type ProviderSecurityVerdict = "PASS" | "BLOCK";

export type ProviderSecurityBlockCode =
  | "SECRET_CLASS_BLOCKED"
  | "PROVIDER_UNKNOWN"
  | "PROVIDER_METADATA_INCOMPLETE"
  | "TRAINING_POLICY_UNKNOWN"
  | "RETENTION_POLICY_UNKNOWN"
  | "CLASSIFICATION_NOT_EXPLICITLY_ALLOWED"
  | "TRAINING_POLICY_DISALLOWS_CLASSIFICATION"
  | "RETENTION_POLICY_INSUFFICIENT"
  | "TRUST_LEVEL_INSUFFICIENT"
  | "DOWNSTREAM_PROVIDER_BLOCKED";

export interface ProviderCheckResult {
  providerId: string;
  verdict: ProviderSecurityVerdict;
  blockCode?: ProviderSecurityBlockCode;
  /** 사람이 읽는 사유 — providerId/classification/열거형 정책 값만으로 구성되며 실제 요청
   *  payload 원문을 포함하지 않는다(§ 파일 상단 Secret 미노출 설계). */
  reason: string;
}

export interface ProviderSecurityRequest {
  classification: DataClassification;
  /** 실제로 요청을 받는 provider(단일 provider 호출이면 이것이 유일한 대상). */
  providerId: string;
  /** multi-provider router(예: OpenRouter류 aggregator)가 실제로 데이터를 넘기는 downstream
   *  provider id 목록(요구사항 7) — router 자신의 판정만으로 전체를 승인하지 않고, 이
   *  목록의 provider 각각을 동일한 등급 기준으로 독립 검증한다. 이 Task는 실제 router
   *  구현/연결을 하지 않으므로, 이 필드는 호출부가 이미 알고 있는 downstream provider id를
   *  그대로 전달하는 순수 데이터 입력이다. */
  downstreamProviderIds?: string[];
}

export interface ProviderSecurityGateResult {
  verdict: ProviderSecurityVerdict;
  classification: DataClassification;
  providerId: string;
  blockCode?: ProviderSecurityBlockCode;
  reason: string;
  /** downstreamProviderIds로 요청됐던 각 provider의 개별 판정 — router 판정을 신뢰하지
   *  않고 항상 채워진다(요청하지 않았으면 빈 배열). */
  downstreamResults: ProviderCheckResult[];
}

// =========================================================
// 단일 provider 판정 — 이 함수 하나가 규칙 1~4/6의 유일한 구현이다(router 검증도 이 함수를
// 그대로 재사용한다 — downstream provider용 별도 완화된 로직을 두지 않는다, 요구사항 6/7).
// =========================================================

function evaluateSingleProviderForClassification(
  classification: NonSecretClassification,
  providerId: string,
  registry: ProviderSecurityRegistry
): ProviderCheckResult {
  const metadata = registry[providerId];
  if (!metadata) {
    return {
      providerId,
      verdict: "BLOCK",
      blockCode: "PROVIDER_UNKNOWN",
      reason: `registry에 등록되지 않은 provider입니다: ${providerId} — 알 수 없는 provider는 허용하지 않습니다.`,
    };
  }

  const shape = validateProviderSecurityMetadataShape(metadata, providerId);
  if (!shape.ok) {
    return {
      providerId,
      verdict: "BLOCK",
      blockCode: "PROVIDER_METADATA_INCOMPLETE",
      reason: `provider(${providerId}) metadata가 불완전합니다: ${shape.reason}`,
    };
  }

  // 요구사항 1: policy unknown → default disabled. CONFIDENTIAL 이상에만 국한하지 않고
  // 모든 등급(PUBLIC 포함)에 동일하게 적용한다 — "확인되지 않은 정책"은 그 자체로 허용
  // 근거가 될 수 없다.
  if (metadata.trainingPolicy === "unknown") {
    return {
      providerId,
      verdict: "BLOCK",
      blockCode: "TRAINING_POLICY_UNKNOWN",
      reason: `provider(${providerId})의 trainingPolicy가 unknown입니다 — 정책이 확인되지 않으면 기본값은 비활성화입니다.`,
    };
  }
  if (metadata.retentionPolicy === "unknown") {
    return {
      providerId,
      verdict: "BLOCK",
      blockCode: "RETENTION_POLICY_UNKNOWN",
      reason: `provider(${providerId})의 retentionPolicy가 unknown입니다 — 정책이 확인되지 않으면 기본값은 비활성화입니다.`,
    };
  }

  if (!metadata.allowedDataClassifications.includes(classification)) {
    return {
      providerId,
      verdict: "BLOCK",
      blockCode: "CLASSIFICATION_NOT_EXPLICITLY_ALLOWED",
      reason: `provider(${providerId})는 ${classification} 등급 데이터 처리를 명시적으로 승인하지 않았습니다 — 더 낮은 등급만 지원하는 provider로 조용히 낮춰 보내지 않습니다.`,
    };
  }

  // 요구사항 3: CONFIDENTIAL 이상 → 학습 미사용 + 짧게 제한된 보존만 인정한다.
  if (CLASSIFICATION_LEVEL[classification] >= CLASSIFICATION_LEVEL.CONFIDENTIAL) {
    if (metadata.trainingPolicy !== "no-training") {
      return {
        providerId,
        verdict: "BLOCK",
        blockCode: "TRAINING_POLICY_DISALLOWS_CLASSIFICATION",
        reason: `provider(${providerId})의 trainingPolicy(${metadata.trainingPolicy})는 ${classification} 등급에 허용되지 않습니다 — no-training만 허용됩니다.`,
      };
    }
    if (!isRetentionSufficientForHigherClassification(metadata)) {
      return {
        providerId,
        verdict: "BLOCK",
        blockCode: "RETENTION_POLICY_INSUFFICIENT",
        reason: `provider(${providerId})의 retention 정책(${metadata.retentionPolicy}${metadata.maxRetentionDays !== undefined ? `, ${metadata.maxRetentionDays}일` : ""})이 ${classification} 등급에 요구되는 보존 상한(zero 또는 ${MAX_RETENTION_DAYS_FOR_HIGHER_CLASSIFICATION}일 이하 bounded)을 만족하지 않습니다.`,
      };
    }
  }

  // 요구사항 4: RESTRICTED → 명시 승인 + 고신뢰(trustLevel==="high")만 인정한다.
  if (classification === "RESTRICTED" && metadata.trustLevel !== "high") {
    return {
      providerId,
      verdict: "BLOCK",
      blockCode: "TRUST_LEVEL_INSUFFICIENT",
      reason: `provider(${providerId})의 trustLevel(${metadata.trustLevel})이 RESTRICTED 등급에 요구되는 high에 미치지 못합니다.`,
    };
  }

  return {
    providerId,
    verdict: "PASS",
    reason: `provider(${providerId})가 ${classification} 등급 요구사항(명시적 승인/학습 미사용/보존 정책/신뢰도)을 모두 만족합니다.`,
  };
}

// =========================================================
// 최상위 Gate — 요청 하나를 판정한다. downstream provider까지 검증한다(요구사항 7).
// =========================================================

/**
 * 완전히 로컬 deterministic 계산이다 — 네트워크/파일 I/O가 전혀 없고, 동일 입력에는 항상
 * 동일한 결과를 반환한다. 비용은 이 함수의 어떤 분기에도 입력으로 들어오지 않는다(요구사항
 * 5) — provider metadata의 costTier 필드는 아예 읽지 않는다.
 *
 * SECRET은 이 함수의 유일한 특별 분기다 — registry 내용과 무관하게 항상 BLOCK한다(요구사항
 * 2, Core hard rule — 이 함수는 그 판정을 약화시킬 policy 인자를 아예 받지 않는다).
 *
 * router 시나리오(downstreamProviderIds가 있는 경우)는 router provider 자신에 대한 판정과
 * downstream provider 각각에 대한 판정을 evaluateSingleProviderForClassification()로
 * 동일하게(완화 없이) 수행하고, 하나라도 BLOCK이면 전체를 BLOCK으로 판정한다 — "router
 * 판정만으로 전체를 승인"하지 않는다.
 */
export function evaluateProviderSecurity(request: ProviderSecurityRequest, registry: ProviderSecurityRegistry): ProviderSecurityGateResult {
  if (request.classification === "SECRET") {
    return {
      verdict: "BLOCK",
      classification: "SECRET",
      providerId: request.providerId,
      blockCode: "SECRET_CLASS_BLOCKED",
      reason: "SECRET 등급 데이터는 어떤 외부 AI/API provider에도 전송할 수 없습니다(Core hard rule) — provider metadata로 이 판정을 우회할 방법이 없습니다.",
      downstreamResults: [],
    };
  }

  // 위에서 SECRET을 이미 걸러냈으므로 아래는 NonSecretClassification으로 안전하게 좁혀 쓸 수
  // 있다(타입 시스템이 이 런타임 분기로부터 자동으로 narrow하지 못하므로 명시적으로 단언).
  const classification = request.classification as NonSecretClassification;

  const primary = evaluateSingleProviderForClassification(classification, request.providerId, registry);
  const downstreamResults = (request.downstreamProviderIds ?? []).map((id) =>
    evaluateSingleProviderForClassification(classification, id, registry)
  );

  if (primary.verdict === "BLOCK") {
    return {
      verdict: "BLOCK",
      classification,
      providerId: request.providerId,
      blockCode: primary.blockCode,
      reason: primary.reason,
      downstreamResults,
    };
  }

  const failedDownstream = downstreamResults.find((d) => d.verdict === "BLOCK");
  if (failedDownstream) {
    return {
      verdict: "BLOCK",
      classification,
      providerId: request.providerId,
      blockCode: "DOWNSTREAM_PROVIDER_BLOCKED",
      reason: `downstream provider(${failedDownstream.providerId}) 검증 실패: ${failedDownstream.reason}`,
      downstreamResults,
    };
  }

  return {
    verdict: "PASS",
    classification,
    providerId: request.providerId,
    reason: `provider(${request.providerId})${
      downstreamResults.length > 0 ? ` 및 downstream provider ${downstreamResults.length}건` : ""
    }이 ${classification} 등급 요구사항을 모두 만족합니다.`,
    downstreamResults,
  };
}
