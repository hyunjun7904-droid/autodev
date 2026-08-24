import type { DataClassification, ProviderSecurityRegistry } from "./provider-security-gate";
import type { ProviderPoolEntry, ProviderPoolStatus, ProviderQualityTier } from "./provider-pool";
import { evaluateProviderPoolSecurity } from "./provider-pool";
import type { UsageLedgerEntryInput, UsageLedgerEnvironment } from "./usage-ledger";

// Security-aware Provider Routing & Fallback — Phase SI-3.8G.
//
// SI-3.8F(provider-pool.ts/real-provider-pool.ts)가 등록한 "정책상 승인된" provider 후보
// 중에서, Reviewer 작업 하나에 실제로 어떤 provider를 쓸지 deterministic하게 고르는 routing
// layer다. 이 파일은 provider-pool.ts/provider-security-gate.ts의 판정 로직을 전혀 다시
// 구현하지 않는다 — evaluateProviderPoolSecurity()(SI-3.8C+F, SECRET/CONFIDENTIAL/RESTRICTED
// 등급 판정, router downstream 검증 전부 포함)를 그대로 재사용하고, 이 파일은 그 위에
// Availability(STEP2)/Quality(STEP3)/Budget-Cost(STEP4) 세 단계만 얹는다.
//
// 절대 우선순위(요구사항) — Security > Quality > Cost. costTier/freeTier 필드는 STEP4에서만
// 읽힌다(STEP1의 evaluateProviderPoolSecurity()는 이미 이 필드들을 전혀 읽지 않는다 — §
// provider-security-gate.ts/provider-pool.ts 상단 주석과 동일한 설계를 그대로 물려받는다).
//
// 실제 provider 호출은 이 파일 어디에도 없다 — routeReviewerProvider()는 순수 함수다(네트워크/
// 파일 I/O 없음, 동일 입력 → 항상 동일 결과). runtimeStatus(§ provider-pool.ts
// resolveProviderPoolStatus)/quotaState는 이미 호출부가 확인한 값을 그대로 입력받을 뿐, 이
// 파일이 스스로 probe하지 않는다.
//
// OpenAI GPT Independent Final Reviewer Gate는 이 router가 대체하지 않는다 — reviewerRole이
// "FINAL_INDEPENDENT_REVIEW"이면 이 함수는 후보 목록과 무관하게 어떤 provider도 선택하지 않고
// 항상 FINAL_INDEPENDENT_REVIEW_NOT_ROUTED를 반환한다(§ 요구사항 17). gpt-reviewer.ts/
// orchestrator.ts/agent-orchestrator.ts의 기존 production 기본값(OpenAIReviewProvider)은 이
// Task에서 전혀 수정하지 않는다 — 그 Gate가 필요한 경로는 여전히 그 파일들의 기존 배선을
// 그대로 따른다. "Free/local Provider가 PreReviewer에서 PASS했다"는 사실을 이 함수가 알 방법
// 자체가 없다(RoutingRequest에 그런 필드가 없다) — 구조적으로 어떤 이전 role의 결과도 이
// 판정에 영향을 줄 수 없다.

export type ReviewerRole = "PRE_REVIEW" | "SUPPORT_REVIEW" | "FINAL_INDEPENDENT_REVIEW";

/** 이 요청이 관측한 budget/quota 상태 — SI-3.8A Budget Guard(gpt-budget-guard.ts)의 실제
 *  API-call preflight를 대체하지 않는다(§ 요구사항 14). 이 router가 provider를 선택해도, 실제
 *  호출 직전에는 여전히 payload build → Budget Guard → Provider Security Gate →
 *  provider.review() 순서가 그대로 적용된다. "UNKNOWN"을 "AVAILABLE"처럼 관대하게 취급하지
 *  않는다(§ 요구사항 4/7 — unknown cost/quota는 $0/무제한으로 간주되지 않는다). */
export type RoutingBudgetState = "AVAILABLE" | "EXHAUSTED" | "UNKNOWN";
export type RoutingQuotaState = "AVAILABLE" | "EXHAUSTED" | "UNKNOWN";

/** provider-pool.ts의 catalog entry 하나 + 이 요청 시점에 호출부가 이미 확인한 런타임 상태.
 *  probe 실행은 이 파일의 책임이 아니다(§ 파일 상단 주석 — 순수 함수 경계 유지). */
export interface RoutingCandidate {
  entry: ProviderPoolEntry;
  runtimeStatus: ProviderPoolStatus;
  quotaState: RoutingQuotaState;
}

export interface RoutingFallbackContext {
  primaryProviderId: string;
  reason: "UNAVAILABLE" | "RATE_LIMITED" | "QUOTA_EXHAUSTED" | "PROVIDER_ERROR";
}

export interface RoutingRequest {
  /** 관측/Ledger 목적의 자유 설명(예: "code_review") — 이 값 자체는 어떤 필터링 분기에도
   *  쓰이지 않는다(가짜 의미를 부여하지 않는다). */
  operationType?: string;
  reviewerRole: ReviewerRole;
  dataClassification: DataClassification;
  /** unknown < basic < capable < frontier — 이 등급 미만인 후보는 STEP3에서 제거된다. local/
   *  free라는 이유로 이 요구사항이 완화되지 않는다(§ 요구사항 STEP3). */
  minimumQualityTier: ProviderQualityTier;
  /** costTier가 "free"가 아닌(paid 또는 unknown — unknown cost는 $0으로 취급하지 않는다, §
   *  요구사항 4) 후보를 이 요청이 명시적으로 허용하는지. false면 그런 후보는 STEP4에서
   *  PAID_PROVIDER_NOT_ALLOWED로 제거된다(§ 요구사항 11 Silent Paid Fallback 금지 — 최초
   *  라우팅에도 동일하게 적용해 "저렴해 보이는 unknown-cost 후보가 조용히 유료로 이어지는"
   *  경로를 막는다). */
  allowPaidProvider: boolean;
  /** allowPaidProvider=true인 후보가 실제로 선택 가능한지의 마지막 조건 — budgetState가
   *  "AVAILABLE"이 아니면(EXHAUSTED/UNKNOWN) paid 후보는 여전히 BUDGET_BLOCKED로 제거된다(§
   *  요구사항 21 "explicitly allowed paid fallback still subject to Budget Guard"). */
  budgetState: RoutingBudgetState;
  /** Security/Quality/Budget을 모두 통과한 후보가 여럿이면 이 provider를 최우선으로 고른다(§
   *  요구사항 3 "preferred provider가 있다면 optional"). 이 필드는 필터링 조건이 아니다 —
   *  선호 provider가 후보에 없거나 탈락했으면 조용히 무시되고 나머지 deterministic tie-break가
   *  그대로 적용된다. */
  preferredProviderId?: string;
  /** 이미 시도했거나(fallback) 정책상 배제해야 하는 provider id — 다른 필터보다 먼저
   *  EXCLUDED_BY_REQUEST로 제거된다. */
  excludeProviderIds?: string[];
  /** 이 라우팅이 이전 provider 실패에 대한 fallback인지 — 지정되면 결과의 fallbackUsed/
   *  fallbackReason에 그대로 반영된다(Usage Ledger metadata용). 이 필드 자체는 필터링 로직에
   *  관여하지 않는다 — fallback이라고 해서 Security/Quality 기준이 완화되지 않는다(§
   *  요구사항 10 — buildFallbackRoutingRequest()가 나머지 request 필드를 그대로 이어받는
   *  것으로 이를 구조적으로 보장한다). */
  fallback?: RoutingFallbackContext;
}

export type ProviderRoutingRejectionCode =
  | "EXCLUDED_BY_REQUEST"
  | "PROVIDER_DISABLED"
  | "PROVIDER_POLICY_UNKNOWN"
  | "SECURITY_BLOCKED"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_UNAVAILABLE"
  | "NOT_REVIEW_CAPABLE"
  | "QUALITY_REQUIREMENT_UNMET"
  | "QUOTA_UNAVAILABLE"
  | "PAID_PROVIDER_NOT_ALLOWED"
  | "BUDGET_BLOCKED"
  | "NOT_APPROVED_FOR_FINAL_INDEPENDENT_REVIEW";

/** 사람이 읽는 reason은 providerId/등급/enum 값만으로 구성된다 — 실제 요청 payload/secret
 *  원문을 담을 수 있는 필드가 이 타입에 애초에 없다(§ provider-security-gate.ts와 동일한
 *  Secret 미노출 설계, evaluateProviderPoolSecurity()의 reason을 그대로 옮길 뿐이다). */
export interface RejectedRoutingCandidate {
  providerId: string;
  code: ProviderRoutingRejectionCode;
  reason: string;
}

export type RoutingResultOutcome =
  | "SELECTED"
  | "NO_ELIGIBLE_PROVIDER"
  | "PROVIDER_SECURITY_BLOCKED"
  | "QUALITY_REQUIREMENT_UNMET"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_UNAVAILABLE"
  | "QUOTA_UNAVAILABLE"
  | "PAID_FALLBACK_NOT_ALLOWED"
  | "BUDGET_BLOCKED"
  | "FINAL_INDEPENDENT_REVIEW_NOT_ROUTED";

export interface RoutingResult {
  outcome: RoutingResultOutcome;
  reviewerRole: ReviewerRole;
  selectedProviderId?: string;
  selectedEntry?: ProviderPoolEntry;
  reason: string;
  candidateCount: number;
  rejectedCandidates: RejectedRoutingCandidate[];
  /** SELECTED 후보 외에 STEP1~4를 전부 통과했지만 deterministic tie-break에서 밀린 provider
   *  id — "억지로 하나만 남을 때까지 탈락시킨 게 아니라 여러 정당한 후보 중 하나를 골랐다"는
   *  것을 구분하기 위함이다. */
  consideredButNotSelected: string[];
  fallbackUsed: boolean;
  fallbackReason?: RoutingFallbackContext["reason"];
}

const QUALITY_RANK: Record<ProviderQualityTier, number> = { unknown: 0, basic: 1, capable: 2, frontier: 3 };

type RoutingCostTier = "free" | "paid" | "unknown";
const COST_RANK: Record<RoutingCostTier, number> = { free: 0, unknown: 1, paid: 2 };

interface AcceptedCandidate {
  entry: ProviderPoolEntry;
  costTier: RoutingCostTier;
}

type CandidateEvaluation =
  | { ok: true; accepted: AcceptedCandidate }
  | { ok: false; stage: number; rejected: RejectedRoutingCandidate };

/**
 * 후보 하나를 STEP1(Security) → STEP2(Availability/Configuration) → STEP3(Required Quality/
 * Capability) → STEP4(Budget/Cost) 순서로 판정한다 — 이 순서 자체가 "비용이 싸거나 무료라는
 * 이유로 Security 또는 Quality를 낮추지 않는다"는 절대 우선순위를 구현한다(뒤 단계는 앞 단계를
 * 통과한 후보에만 도달한다).
 */
function evaluateCandidate(candidate: RoutingCandidate, request: RoutingRequest, registry: ProviderSecurityRegistry): CandidateEvaluation {
  const { entry, runtimeStatus, quotaState } = candidate;

  if (request.excludeProviderIds?.includes(entry.providerId)) {
    return {
      ok: false,
      stage: 0,
      rejected: {
        providerId: entry.providerId,
        code: "EXCLUDED_BY_REQUEST",
        reason: `이 요청에서 명시적으로 제외된 provider입니다(${entry.providerId}).`,
      },
    };
  }

  // STEP 1 — Security. approvalStatus가 APPROVED가 아니면 evaluateProviderPoolSecurity()를
  // 호출하지 않고도 이미 알 수 있다(그 함수도 동일하게 우선 확인하지만, 이 파일은 그 이유를
  // 더 구체적인 코드(PROVIDER_DISABLED/PROVIDER_POLICY_UNKNOWN)로 구분해 보고한다).
  if (entry.approvalStatus === "DISABLED") {
    return {
      ok: false,
      stage: 1,
      rejected: {
        providerId: entry.providerId,
        code: "PROVIDER_DISABLED",
        reason: entry.disabledReason ?? `provider(${entry.providerId})가 정책상 비활성화되어 있습니다.`,
      },
    };
  }
  if (entry.approvalStatus === "POLICY_UNKNOWN") {
    return {
      ok: false,
      stage: 1,
      rejected: {
        providerId: entry.providerId,
        code: "PROVIDER_POLICY_UNKNOWN",
        reason: entry.disabledReason ?? `provider(${entry.providerId})의 정책이 아직 확인되지 않았습니다(POLICY_UNKNOWN).`,
      },
    };
  }
  const securityResult = evaluateProviderPoolSecurity(entry, request.dataClassification, registry);
  if (securityResult.verdict === "BLOCK") {
    return { ok: false, stage: 1, rejected: { providerId: entry.providerId, code: "SECURITY_BLOCKED", reason: securityResult.reason } };
  }

  // STEP 2 — Availability/Configuration. "catalog에 있다는 이유만으로 선택 금지"(§ 요구사항).
  if (runtimeStatus === "NOT_CONFIGURED") {
    return {
      ok: false,
      stage: 2,
      rejected: { providerId: entry.providerId, code: "PROVIDER_NOT_CONFIGURED", reason: `provider(${entry.providerId})가 이 환경에 설정되지 않았습니다(NOT_CONFIGURED).` },
    };
  }
  if (runtimeStatus !== "AVAILABLE") {
    return {
      ok: false,
      stage: 2,
      rejected: {
        providerId: entry.providerId,
        code: "PROVIDER_UNAVAILABLE",
        reason: `provider(${entry.providerId})의 런타임 상태가 AVAILABLE이 아닙니다(${runtimeStatus}).`,
      },
    };
  }

  // STEP 3 — Required Quality / Capability. local/free라는 이유로 완화되지 않는다.
  if (!entry.reviewProviderCapability) {
    return {
      ok: false,
      stage: 3,
      rejected: { providerId: entry.providerId, code: "NOT_REVIEW_CAPABLE", reason: `provider(${entry.providerId})는 review 용도로 의도되지 않았습니다(reviewProviderCapability=false).` },
    };
  }
  if (QUALITY_RANK[entry.qualityTier] < QUALITY_RANK[request.minimumQualityTier]) {
    return {
      ok: false,
      stage: 3,
      rejected: {
        providerId: entry.providerId,
        code: "QUALITY_REQUIREMENT_UNMET",
        reason: `provider(${entry.providerId})의 qualityTier(${entry.qualityTier})가 요구되는 최소 등급(${request.minimumQualityTier})에 미치지 못합니다.`,
      },
    };
  }

  // STEP 4 — Budget/Cost. Security/Quality를 통과한 후보 사이에서만 비용을 본다.
  if (quotaState !== "AVAILABLE") {
    return {
      ok: false,
      stage: 4,
      rejected: {
        providerId: entry.providerId,
        code: "QUOTA_UNAVAILABLE",
        reason: `provider(${entry.providerId})의 quota 상태를 신뢰성 있게 확인할 수 없습니다(quotaState=${quotaState}) — unknown을 무제한 free로 간주하지 않습니다.`,
      },
    };
  }
  const costTier: RoutingCostTier = entry.security.costTier ?? "unknown";
  if (costTier !== "free") {
    if (!request.allowPaidProvider) {
      return {
        ok: false,
        stage: 4,
        rejected: {
          providerId: entry.providerId,
          code: "PAID_PROVIDER_NOT_ALLOWED",
          reason: `provider(${entry.providerId})는 비용이 발생할 수 있으나(costTier=${costTier}) 이 요청이 paid provider 사용을 명시적으로 허용하지 않았습니다 — 무료 후보 실패를 이유로 자동으로 유료 provider를 쓰지 않습니다.`,
        },
      };
    }
    if (request.budgetState !== "AVAILABLE") {
      return {
        ok: false,
        stage: 4,
        rejected: {
          providerId: entry.providerId,
          code: "BUDGET_BLOCKED",
          reason: `provider(${entry.providerId}) paid 사용이 이 요청에서는 허용됐지만 budget 상태가 AVAILABLE이 아닙니다(${request.budgetState}).`,
        },
      };
    }
  }

  return { ok: true, accepted: { entry, costTier } };
}

const STAGE_CODE_TO_OUTCOME: Record<ProviderRoutingRejectionCode, RoutingResultOutcome> = {
  EXCLUDED_BY_REQUEST: "NO_ELIGIBLE_PROVIDER",
  PROVIDER_DISABLED: "PROVIDER_SECURITY_BLOCKED",
  PROVIDER_POLICY_UNKNOWN: "PROVIDER_SECURITY_BLOCKED",
  SECURITY_BLOCKED: "PROVIDER_SECURITY_BLOCKED",
  PROVIDER_NOT_CONFIGURED: "PROVIDER_NOT_CONFIGURED",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  NOT_REVIEW_CAPABLE: "QUALITY_REQUIREMENT_UNMET",
  QUALITY_REQUIREMENT_UNMET: "QUALITY_REQUIREMENT_UNMET",
  QUOTA_UNAVAILABLE: "QUOTA_UNAVAILABLE",
  PAID_PROVIDER_NOT_ALLOWED: "PAID_FALLBACK_NOT_ALLOWED",
  BUDGET_BLOCKED: "BUDGET_BLOCKED",
  NOT_APPROVED_FOR_FINAL_INDEPENDENT_REVIEW: "FINAL_INDEPENDENT_REVIEW_NOT_ROUTED",
};

/**
 * 후보가 전부 탈락했을 때 top-level outcome을 결정한다 — 가장 늦은 단계(STEP4에 가까울수록
 * "선택에 더 근접했던" 탈락)에서 탈락한 후보들을 우선 근거로 삼고, 그 단계에서 매핑된
 * top-level outcome이 전부 같으면(원인 code가 서로 달라도 — 예: PROVIDER_DISABLED와
 * SECURITY_BLOCKED는 둘 다 PROVIDER_SECURITY_BLOCKED로 매핑됨) 그 outcome으로 승격한다.
 * 매핑된 outcome 자체가 섞여 있을 때만 어느 하나로 단정하지 않고 일반
 * NO_ELIGIBLE_PROVIDER로 남긴다(원인은 rejectedCandidates에 그대로 보존되므로 정보 손실은
 * 없다). raw code로 dedupe하면 같은 outcome으로 매핑되는 서로 다른 code가 섞였을 때도
 * NO_ELIGIBLE_PROVIDER로 뭉개져 더 구체적인 outcome을 놓치므로, 반드시 매핑된 outcome
 * 기준으로 dedupe한다.
 */
function computeAggregateOutcome(rejections: { stage: number; code: ProviderRoutingRejectionCode }[]): RoutingResultOutcome {
  if (rejections.length === 0) return "NO_ELIGIBLE_PROVIDER";
  const maxStage = Math.max(...rejections.map((r) => r.stage));
  const atMaxStage = rejections.filter((r) => r.stage === maxStage);
  const outcomes = new Set(atMaxStage.map((r) => STAGE_CODE_TO_OUTCOME[r.code]));
  if (outcomes.size === 1) {
    return STAGE_CODE_TO_OUTCOME[atMaxStage[0].code];
  }
  return "NO_ELIGIBLE_PROVIDER";
}

const FINAL_INDEPENDENT_REVIEW_REASON =
  "FINAL_INDEPENDENT_REVIEW는 이 router가 자동으로 provider를 선택하지 않습니다 — 기존 OpenAI GPT " +
  "Independent Final Reviewer Gate(gpt-reviewer.ts/orchestrator.ts/agent-orchestrator.ts의 기존 배선)가 " +
  "그대로 유지됩니다. PreReviewer/SUPPORT_REVIEW가 PASS했다는 사실은 이 판정에 전혀 영향을 주지 않습니다" +
  "(이 함수는 그런 이전 결과를 입력으로 받지 않습니다).";

/**
 * Reviewer 작업 하나에 쓸 provider를 deterministic하게 고른다 — 순수 함수(동일 입력 → 항상
 * 동일 결과, 네트워크/파일 I/O 없음, 실제 provider를 호출하지 않는다).
 *
 * reviewerRole==="FINAL_INDEPENDENT_REVIEW"이면 후보 목록/상태와 무관하게 항상
 * FINAL_INDEPENDENT_REVIEW_NOT_ROUTED를 반환한다(§ 파일 상단 주석) — 이 role에 대해서는
 * 어떤 candidate도 SELECTED로 반환될 수 없다(로컬/무료 provider가 자동으로 Final Independent
 * Reviewer가 되는 경로 자체가 없다).
 */
export function routeReviewerProvider(request: RoutingRequest, candidates: readonly RoutingCandidate[], registry: ProviderSecurityRegistry): RoutingResult {
  if (request.reviewerRole === "FINAL_INDEPENDENT_REVIEW") {
    return {
      outcome: "FINAL_INDEPENDENT_REVIEW_NOT_ROUTED",
      reviewerRole: request.reviewerRole,
      reason: FINAL_INDEPENDENT_REVIEW_REASON,
      candidateCount: candidates.length,
      rejectedCandidates: candidates.map((c) => ({
        providerId: c.entry.providerId,
        code: "NOT_APPROVED_FOR_FINAL_INDEPENDENT_REVIEW" as const,
        reason: `provider(${c.entry.providerId})는 Final Independent Review 역할에 승인된 provider가 아닙니다 — 이 역할은 이 router의 자동 선택 대상이 아닙니다.`,
      })),
      consideredButNotSelected: [],
      fallbackUsed: request.fallback !== undefined,
      fallbackReason: request.fallback?.reason,
    };
  }

  const rejectedCandidates: RejectedRoutingCandidate[] = [];
  const rejectedStaged: { stage: number; code: ProviderRoutingRejectionCode }[] = [];
  const accepted: AcceptedCandidate[] = [];

  for (const candidate of candidates) {
    const result = evaluateCandidate(candidate, request, registry);
    if (result.ok) {
      accepted.push(result.accepted);
    } else {
      rejectedCandidates.push(result.rejected);
      rejectedStaged.push({ stage: result.stage, code: result.rejected.code });
    }
  }

  if (accepted.length === 0) {
    return {
      outcome: computeAggregateOutcome(rejectedStaged),
      reviewerRole: request.reviewerRole,
      reason:
        candidates.length === 0
          ? "후보 provider가 제공되지 않았습니다."
          : "모든 후보 provider가 Security/Availability/Quality/Budget 요구사항 중 하나 이상을 통과하지 못했습니다.",
      candidateCount: candidates.length,
      rejectedCandidates,
      consideredButNotSelected: [],
      fallbackUsed: request.fallback !== undefined,
      fallbackReason: request.fallback?.reason,
    };
  }

  // Deterministic tie-break(§ 요구사항 13) — Security/Quality/Budget을 이미 통과한 후보들
  // 사이에서만 적용된다(Cost가 Security/Quality보다 먼저 오지 않는다):
  //   1) preferredProviderId가 후보 중에 있으면 최우선.
  //   2) approved priority == qualityTier 내림차순(frontier가 가장 앞).
  //   3) cost tier 오름차순(free가 가장 앞, paid가 가장 뒤).
  //   4) providerId 오름차순(안정적인 tie-break, 랜덤 없음).
  const sorted = [...accepted].sort((a, b) => {
    if (request.preferredProviderId) {
      const aPref = a.entry.providerId === request.preferredProviderId ? 0 : 1;
      const bPref = b.entry.providerId === request.preferredProviderId ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
    }
    const qualityDiff = QUALITY_RANK[b.entry.qualityTier] - QUALITY_RANK[a.entry.qualityTier];
    if (qualityDiff !== 0) return qualityDiff;
    const costDiff = COST_RANK[a.costTier] - COST_RANK[b.costTier];
    if (costDiff !== 0) return costDiff;
    return a.entry.providerId < b.entry.providerId ? -1 : a.entry.providerId > b.entry.providerId ? 1 : 0;
  });

  const selected = sorted[0];
  return {
    outcome: "SELECTED",
    reviewerRole: request.reviewerRole,
    selectedProviderId: selected.entry.providerId,
    selectedEntry: selected.entry,
    reason: `provider(${selected.entry.providerId})가 Security/Availability/Quality/Budget 요구사항을 모두 만족해 선택되었습니다(qualityTier=${selected.entry.qualityTier}, costTier=${selected.costTier}).`,
    candidateCount: candidates.length,
    rejectedCandidates,
    consideredButNotSelected: sorted.slice(1).map((s) => s.entry.providerId),
    fallbackUsed: request.fallback !== undefined,
    fallbackReason: request.fallback?.reason,
  };
}

/**
 * primary provider 실패 이후 재시도할 RoutingRequest를 만든다 — previousRequest의 나머지 필드
 * (dataClassification/minimumQualityTier/allowPaidProvider/budgetState 등)를 그대로 이어받는
 * 것으로 "fallback이 Security/Quality 기준을 완화하지 않는다"(§ 요구사항 10)를 구조적으로
 * 보장한다. 이 함수는 어떤 provider를 다음으로 쓸지 결정하지 않는다 — 그것은 여전히
 * routeReviewerProvider()가 STEP1~4를 다시 전부 실행해서 결정한다("hidden fallback 없음").
 */
export function buildFallbackRoutingRequest(previousRequest: RoutingRequest, failedProviderId: string, reason: RoutingFallbackContext["reason"]): RoutingRequest {
  return {
    ...previousRequest,
    excludeProviderIds: [...(previousRequest.excludeProviderIds ?? []), failedProviderId],
    fallback: { primaryProviderId: failedProviderId, reason },
  };
}

// =========================================================
// Usage & Cost Ledger 통합(§ 요구사항 15) — routing "결정"은 그 자체로 API 호출이 아니므로
// requestCount는 항상 0이고 estimatedCostUsd/actualCostUsd는 채우지 않는다(실제 review 호출
// 1건의 usage/cost는 여전히 gpt-reviewer.ts buildGptReviewLedgerEntryInput이 별도로 기록한다 —
// 이 함수가 그 기록을 대체하지 않는다). Secret/Prompt/소스코드 원문은 이 함수가 다루는 어떤
// 필드에도 존재하지 않는다(providerId/enum outcome/reviewerRole만 옮긴다 — RoutingResult.reason/
// rejectedCandidates[].reason처럼 자유 텍스트가 섞인 필드는 의도적으로 옮기지 않는다).
// =========================================================

export const PROVIDER_ROUTING_LEDGER_SERVICE = "provider-router";
export const PROVIDER_ROUTING_LEDGER_OPERATION_PREFIX = "reviewer_provider_routing";
const UNROUTED_PROVIDER_LABEL = "(unrouted)";

export interface RoutingLedgerContextFields {
  projectId?: string;
  taskId?: string;
  agentId?: string;
  operationCycle?: number;
}

/** 순수 함수 — Ledger에 append하지 않는다(호출부가 UsageLedger.append()에 그대로 넘긴다, §
 *  gpt-reviewer.ts buildGptReviewLedgerEntryInput과 동일한 경계). */
export function buildRoutingDecisionLedgerEntryInput(
  result: RoutingResult,
  fields: RoutingLedgerContextFields,
  environment: UsageLedgerEnvironment
): UsageLedgerEntryInput {
  return {
    projectId: fields.projectId,
    taskId: fields.taskId,
    agentId: fields.agentId,
    environment,
    service: PROVIDER_ROUTING_LEDGER_SERVICE,
    provider: result.selectedProviderId ?? UNROUTED_PROVIDER_LABEL,
    operation: `${PROVIDER_ROUTING_LEDGER_OPERATION_PREFIX}:${result.reviewerRole}`,
    requestCount: 0,
    operationCycle: fields.operationCycle,
    status: result.outcome,
  };
}
