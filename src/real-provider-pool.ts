import type { ProviderSecurityRegistry } from "./provider-security-gate";
import { OPENAI_REVIEW_PROVIDER_ID } from "./openai-review-provider";
import { resolveOpenAiProviderSecurityRegistry } from "./openai-provider-security-metadata";
import type { ProviderPoolEntry } from "./provider-pool";
import { toProviderSecurityRegistry, validateProviderPoolEntry } from "./provider-pool";
import {
  OLLAMA_PROVIDER_ID,
  GROQ_PROVIDER_ID,
  OPENROUTER_PROVIDER_ID,
  NVIDIA_NIM_PROVIDER_ID,
  buildOllamaProviderSecurityMetadata,
  buildGroqProviderSecurityMetadata,
  buildOpenRouterProviderSecurityMetadata,
  buildNvidiaNimProviderSecurityMetadata,
} from "./provider-pool-security-metadata";

// Real Approved Provider Pool Bootstrap — Phase SI-3.8F.
//
// real-source-catalog.ts(D5)가 capability-resolver.ts(D1)의 일반 모델 위에 실제 공식 catalog
// 3건을 등록한 것과 동일한 역할이다 — provider-pool.ts(일반 모델)는 어떤 provider도 모르고,
// 이 파일이 2026-08-25 공식 문서 조사로 확인된 4개 후보(Ollama/Groq/OpenRouter/NVIDIA NIM)를
// 실제로 등록한다. "많이 등록하지 않는다" 원칙을 그대로 따른다 — 조사 대상 4건 그대로다.
//
// 이 파일은 어떤 provider도 실제로 호출하지 않는다(adapter 실행/네트워크 I/O 없음) — 순수
// 데이터 조립이다. 자동 provider routing/cost-based routing/hidden fallback을 만들지 않는다
// (§ 요구사항 12) — buildRealProviderPool()이 반환하는 목록을 실제로 무엇에 쓸지는 이 Task
// 범위 밖(SI-3.8G)이다.

export const GROQ_API_KEY_ENV = "GROQ_API_KEY";
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
export const NVIDIA_NIM_API_KEY_ENV = "NVIDIA_API_KEY";

const POLICY_VERIFIED_AT = "2026-08-25T00:00:00.000Z";

function ollamaEntry(): ProviderPoolEntry {
  return {
    providerId: OLLAMA_PROVIDER_ID,
    providerType: "local",
    reviewProviderCapability: true,
    modelMetadata: {
      models: [],
      notes:
        "설치된 모델은 로컬 환경마다 다르므로 이 catalog에 고정하지 않는다 — 이번 Task는 모델 자동 다운로드/ollama 자동 설치를 하지 않으며, 실제 설치 여부는 별도 probe seam(ollama-review-provider.ts)으로만 확인한다.",
    },
    freeTier: {
      freeTierAvailable: true,
      guaranteedZeroCost: false,
      description: "로컬 실행 — API 비용 없음(로컬 하드웨어/전력 자원 소비는 이 필드가 다루는 범위가 아니다).",
      sourceUrl: "https://ollama.com/privacy",
    },
    security: buildOllamaProviderSecurityMetadata(),
    approvalStatus: "APPROVED",
    policySource: ["https://ollama.com/privacy"],
    policyVerifiedAt: POLICY_VERIFIED_AT,
    // local이라는 이유로 품질을 자동 승인하지 않는다(§ 요구사항 5) — 설치된 모델에 따라 전혀
    // 다르므로 임의로 확정하지 않는다.
    qualityTier: "unknown",
    downstreamProviderRequired: false,
  };
}

function groqEntry(env: NodeJS.ProcessEnv): ProviderPoolEntry {
  return {
    providerId: GROQ_PROVIDER_ID,
    providerType: "direct-external",
    reviewProviderCapability: true,
    modelMetadata: {
      models: [],
      notes: "모델별 free tier rate limit이 서로 달라(GroqDocs rate-limits) 특정 모델 id를 이 Task에서 고정하지 않는다.",
    },
    freeTier: {
      freeTierAvailable: true,
      guaranteedZeroCost: false,
      description:
        "Free Plan은 모델별로 RPM/RPD/TPM 상한이 다르다(예: 문서 기준 모델별 편차가 큼) — 초과분/일부 모델은 유료 Developer Plan 업그레이드가 필요할 수 있다.",
      sourceUrl: "https://console.groq.com/docs/rate-limits",
    },
    rateLimit: {
      notes: "Free Plan 요청 한도는 모델별로 상이하며 예고 없이 바뀔 수 있다 — 이 catalog는 특정 숫자를 고정하지 않고 공식 문서를 가리킨다.",
      sourceUrl: "https://console.groq.com/docs/rate-limits",
    },
    security: buildGroqProviderSecurityMetadata(env),
    approvalStatus: "APPROVED",
    policySource: ["https://console.groq.com/docs/your-data", "https://console.groq.com/docs/legal/services-agreement", "https://console.groq.com/docs/rate-limits"],
    policyVerifiedAt: POLICY_VERIFIED_AT,
    qualityTier: "capable",
    downstreamProviderRequired: false,
    requiresApiKeyEnv: GROQ_API_KEY_ENV,
  };
}

function openRouterEntry(env: NodeJS.ProcessEnv): ProviderPoolEntry {
  return {
    providerId: OPENROUTER_PROVIDER_ID,
    providerType: "router",
    reviewProviderCapability: true,
    security: buildOpenRouterProviderSecurityMetadata(env),
    approvalStatus: "APPROVED",
    policySource: [
      "https://openrouter.ai/privacy",
      "https://openrouter.ai/docs/guides/privacy/provider-logging",
      "https://openrouter.ai/docs/guides/routing/provider-selection",
    ],
    policyVerifiedAt: POLICY_VERIFIED_AT,
    // downstream에 완전히 의존하므로 router 자신의 qualityTier를 확정하지 않는다.
    qualityTier: "unknown",
    downstreamProviderRequired: true,
    // 현재 이 registry가 독립적으로 검증한 downstream provider는 OpenAI 하나뿐이다(§
    // openai-provider-security-metadata.ts) — OpenRouter가 OpenAI 모델을 실제로 라우팅한다는
    // 것은 공식적으로 알려진 사실이다. 다른 downstream(예: Groq 자신을 OpenRouter로 다시
    // 라우팅하는 경우 등)은 "명확하지 않으면 제외"(§ 요구사항 2) 원칙에 따라 등록하지 않는다.
    downstreamProviderIds: [OPENAI_REVIEW_PROVIDER_ID],
    requiresApiKeyEnv: OPENROUTER_API_KEY_ENV,
  };
}

function nvidiaNimEntry(): ProviderPoolEntry {
  return {
    providerId: NVIDIA_NIM_PROVIDER_ID,
    providerType: "direct-external",
    // approvalStatus가 이미 사용을 막지만, "이 provider는애초에 review 용도로 의도되지 않았다"는
    // 사실을 capability 필드로도 명시적으로 표현한다.
    reviewProviderCapability: false,
    freeTier: {
      freeTierAvailable: true,
      guaranteedZeroCost: false,
      description:
        "build.nvidia.com API Catalog는 가입 시 즉시 1,000 credit, 최대 5,000 credit까지 무료 제공을 표방하나(2차 자료 기준, 1차 문서 원문 직접 확인 실패), 이 catalog가 실제로 승인 판정에 쓰지는 않는다(POLICY_UNKNOWN).",
      sourceUrl: "https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf",
    },
    security: buildNvidiaNimProviderSecurityMetadata(),
    approvalStatus: "POLICY_UNKNOWN",
    disabledReason:
      "1차 공식 문서(NVIDIA API Trial Terms of Service PDF)를 텍스트로 직접 확인하지 못했고(PDF 스트림 추출 실패), training/retention 정책에 대한 2차 자료끼리 서로 상충한다(일부는 '학습에 사용 안 함', 다른 자료는 '학습에 사용됨'이라고 보고). 문서명 자체('API TRIAL Terms of Service')는 production/commercial 사용 제한 가능성도 시사한다. 신뢰할 수 있는 1차 인용을 확보하기 전까지 정책을 추측하지 않고 비활성화한다.",
    policySource: ["https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf"],
    policyVerifiedAt: POLICY_VERIFIED_AT,
    qualityTier: "unknown",
    downstreamProviderRequired: false,
    requiresApiKeyEnv: NVIDIA_NIM_API_KEY_ENV,
  };
}

/** 실제 4개 후보 catalog 항목 — 순서: Ollama(local) → Groq(direct-external) →
 *  OpenRouter(router) → NVIDIA NIM(direct-external, POLICY_UNKNOWN). 매 호출마다 env 기반 ZDR
 *  검증을 다시 평가하므로(§ Groq/OpenRouter metadata) 이 함수는 항상 최신 env 상태를 반영한다. */
export function buildRealProviderPool(env: NodeJS.ProcessEnv = process.env): ProviderPoolEntry[] {
  const entries = [ollamaEntry(), groqEntry(env), openRouterEntry(env), nvidiaNimEntry()];
  for (const entry of entries) {
    const validation = validateProviderPoolEntry(entry);
    if (!validation.ok) {
      throw new Error(`buildRealProviderPool: entry(${entry.providerId}) 검증 실패 — ${validation.reason}`);
    }
  }
  return entries;
}

/** OpenAI(SI-3.8E) registry + 이 Pool의 registry를 합친 것 — OpenRouter → openai downstream
 *  검증처럼 두 registry에 걸친 provider 판정에 그대로 쓸 수 있다. OpenAI의 기존 registry
 *  resolver를 재사용할 뿐 복제하지 않는다. */
export function resolveRealProviderPoolSecurityRegistry(env: NodeJS.ProcessEnv = process.env): ProviderSecurityRegistry {
  const pool = buildRealProviderPool(env);
  return { ...resolveOpenAiProviderSecurityRegistry(env), ...toProviderSecurityRegistry(pool) };
}
