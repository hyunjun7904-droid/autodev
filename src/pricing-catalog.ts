// API Pricing Catalog & Cost Calculator — Phase SI-3.8B.
//
// 모델별 가격을 코드 곳곳에 hard-code하지 않기 위한 단일 bounded pricing catalog/resolver다.
// 이번 Task는 provider abstraction(OpenAI/Anthropic/Groq/Gemini 등을 자동으로 구분해 호출하는
// routing 계층)을 구현하지 않는다 — 여기서는 오직 "provider+model 조합 → 가격" 조회와 그
// 가격으로부터 token 사용량을 곱해 추정 비용을 계산하는 순수 함수만 제공한다.
//
// 핵심 원칙(§ 요구사항 5/6) — 이번 Task에서 인터넷/OpenAI Billing API를 호출해 현재 가격을
// 가져오지 않는다. 이 저장소 안에 확정된(공식 문서로 직접 확인된) 가격 정보가 없으므로,
// CORE_PRICING_CATALOG는 의도적으로 비어 있다 — 실제 최신 가격을 임의로 추측해서 채우지
// 않는다. resolvePricing()이 항상 undefined를 반환하는 한, calculateEstimatedCost()는 항상
// PRICE_UNAVAILABLE을 반환하고 어떤 호출부도 이 시점에 estimatedCostUsd를 채우지 않는다 —
// 이는 버그가 아니라 "가격표가 없으면 비용을 만들어내지 않는다"는 의도된 fail-safe 동작이다.
// 향후 공식 pricing 문서를 확인한 뒤 별도 Task에서 CORE_PRICING_CATALOG에 항목을 추가한다.

export interface PricingCatalogEntry {
  provider: string;
  model: string;
  /** 아래 세 가격이 적용되는 token 단위(예: 1_000_000 = "1M 토큰당 가격"). */
  pricingUnitTokens: number;
  inputPricePerUnitUsd: number;
  /** 이 provider/model이 cached-input 할인 가격을 지원하지 않으면 생략한다(추측 금지). */
  cachedInputPricePerUnitUsd?: number;
  outputPricePerUnitUsd: number;
  currency: string;
  /** 사람이 읽는 출처 설명(공식 pricing 문서 등) — 이 값 자체를 파싱해 신뢰도를 판정하지
   *  않는다(순수 metadata). */
  source: string;
  /** 이 가격이 실제로 확인된 시점(ISO date, "YYYY-MM-DD"). */
  asOf: string;
  /** 같은 provider/model이라도 가격이 바뀌면 새 entry(새 version)로 교체한다 — 기존 entry를
   *  덮어써서 과거에 계산된 비용의 근거를 지우지 않는다. */
  version: string;
}

// 이번 Task(SI-3.8B) 시점 기준 이 저장소 안에 공식 문서로 확인된 확정 가격 정보가 없다 —
// 의도적으로 빈 배열이다(§ 파일 상단 주석).
export const CORE_PRICING_CATALOG: readonly PricingCatalogEntry[] = [];

/** provider+model이 정확히 일치하는 catalog entry를 찾는다 — model이 없으면(관측되지 않음)
 *  조회 자체를 시도하지 않고 즉시 undefined를 반환한다(추측 금지). */
export function resolvePricing(
  provider: string,
  model: string | undefined,
  catalog: readonly PricingCatalogEntry[] = CORE_PRICING_CATALOG
): PricingCatalogEntry | undefined {
  if (!model) return undefined;
  return catalog.find((e) => e.provider === provider && e.model === model);
}

export type CostCalculationStatus = "CALCULATED" | "PRICE_UNAVAILABLE";

export interface CostCalculationUsageInput {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface CostCalculationResult {
  status: CostCalculationStatus;
  /** status==="CALCULATED"일 때만 채워진다. */
  estimatedCostUsd?: number;
  currency?: string;
  pricingSource?: string;
  pricingAsOf?: string;
}

const PRICE_UNAVAILABLE: CostCalculationResult = { status: "PRICE_UNAVAILABLE" };

/**
 * 순수 함수 — 실제 tokenizer/API를 호출하지 않는다. pricing이 없거나(가격표에 이
 * provider/model이 없음) 계산에 필요한 최소 usage(inputTokens/outputTokens)가 아직
 * 관측되지 않았으면 항상 PRICE_UNAVAILABLE이다(0으로 채우지 않는다 — § 요구사항 6).
 * cachedInputTokens는 pricing이 실제로 cached 할인 가격을 제공할 때만 반영된다 —
 * 제공하지 않으면 cached 여부와 무관하게 전체 inputTokens를 일반 input 가격으로 계산한다
 * (cached 토큰이 무료라고 임의로 가정하지 않는다).
 */
export function calculateEstimatedCost(usage: CostCalculationUsageInput, pricing: PricingCatalogEntry | undefined): CostCalculationResult {
  if (!pricing) return PRICE_UNAVAILABLE;
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return PRICE_UNAVAILABLE;

  const cachedTokens =
    pricing.cachedInputPricePerUnitUsd !== undefined ? Math.min(Math.max(usage.cachedInputTokens ?? 0, 0), usage.inputTokens) : 0;
  const nonCachedInputTokens = usage.inputTokens - cachedTokens;

  const cost =
    (nonCachedInputTokens / pricing.pricingUnitTokens) * pricing.inputPricePerUnitUsd +
    (cachedTokens / pricing.pricingUnitTokens) * (pricing.cachedInputPricePerUnitUsd ?? 0) +
    (usage.outputTokens / pricing.pricingUnitTokens) * pricing.outputPricePerUnitUsd;

  return {
    status: "CALCULATED",
    estimatedCostUsd: cost,
    currency: pricing.currency,
    pricingSource: pricing.source,
    pricingAsOf: pricing.asOf,
  };
}
