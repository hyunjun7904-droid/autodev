import type { CapabilityRequirement, CapabilityDomain, CapabilityType, SourceOfficiality } from "./capability-resolver";
import { classifyRequirementDomain } from "./capability-resolver";
import type { EvidenceSourceType, TrustedDiscoveryResult, TrustedDiscoveryStatus, TrustedDiscoveryPolicy } from "./candidate-evidence";
import {
  validateSourceUrl,
  validateSourceAdapterConfig,
  createAsyncEvidenceSource,
  combineAsyncEvidenceSources,
  discoverTrustedCandidatesAsync,
  nodeHttpFetch,
  KNOWN_CAPABILITY_TYPES,
  KNOWN_EVIDENCE_SOURCE_TYPES,
} from "./source-adapter";
import type { SourceAdapterConfig, HttpFetch, AsyncEvidenceSource } from "./source-adapter";

// Official Source Catalog & Discovery Orchestration — Phase D Task D4.
//
// D1(capability-resolver.ts)/D2(candidate-evidence.ts)/D3(source-adapter.ts)를 하나의
// 범용 Discovery 흐름으로 연결한다: CapabilityRequirement → (이 파일) Source Catalog에서
// 관련 있는 active source 선택 → (D3) 그 source들만 조회 → (D2) evidence 검증/충돌·staleness
// 판정 → 최종 결과 반환. D1/D2/D3 파일의 기존 동작은 이 Task에서 바꾸지 않는다 — D3에
// KNOWN_CAPABILITY_TYPES/KNOWN_EVIDENCE_SOURCE_TYPES export 추가만 했다(순수 추가, D2의
// KNOWN_ACTION_TAGS export와 동일한 패턴 — 이 파일이 그 값을 재사용해 목록을 복제하지
// 않는다).
//
// 평가/랭킹/충돌/staleness/승인 판정 로직은 전혀 새로 만들지 않는다 — 이 파일이 하는 일은
// 오직 "이 requirement에 어떤 catalog source가 관련 있는가"를 고르고(카탈로그 필터링),
// 그 source들만 D3에게 조회시킨 뒤, 그 결과를 D2의 discoverTrustedCandidates(D3의
// discoverTrustedCandidatesAsync를 통해)에 그대로 넘기는 배선(orchestration)뿐이다.
//
// 이 Task는 MCP 설치/활성화, package 다운로드, Browser Worker, Agent Router, Dashboard,
// production credential 사용을 하지 않는다. AI(Claude/GPT) 판단에 의존하지 않는다.

// =========================================================
// Source Catalog — 특정 프로젝트에 하드코딩하지 않는 범용 구조. 이 파일 자체는 실제
// catalog 데이터(어떤 vendor/domain을 다룰지)를 전혀 모른다 — 호출부가 SourceCatalog를
// 명시적으로 주입한다(project-policy.ts/project-manifest.ts와 동일한 "Core는 데이터를
// 모른다" 설계 원칙).
// =========================================================

export type SourceCatalogStatus = "active" | "inactive";

/** 이번 Task 기준 지원하는 adapter 구현은 D3의 범용 JSON adapter 하나뿐이다("불필요한
 *  다수 벤더 구현 금지") — 새 adapter 종류가 실제로 필요해지면 그때 이 union에 추가한다. */
export type SourceAdapterType = "official_json_source";

export interface CatalogSourceEntry {
  /** 이 catalog entry의 고유 식별자. */
  id: string;
  /** 이 source가 다루는 capability 영역 — classifyRequirementDomain()(D1)이 반환하는
   *  값과 동일한 어휘를 쓴다(재사용, 새 분류 체계를 만들지 않는다). */
  capabilityDomain: CapabilityDomain;
  provider: string;
  sourceType: EvidenceSourceType;
  /** 이 source가 실제로 요청을 보낼 수 있는 유일한 host(SSRF 방지 — D3의 allowedHosts로
   *  그대로 전달된다). */
  canonicalHost: string;
  /** 실제로 조회할 고정 endpoint URL — canonicalHost와 host가 일치해야 한다(검증됨). */
  endpointUrl: string;
  /** "공식 근거" — 사람이 읽는 설명 문장이되, 이 문자열 자체가 신뢰를 만들지 않는다. 실제
   *  신뢰 상한은 항상 maxOfficiality + 아래 validateCatalogSourceEntry의 구조적 검증
   *  (https/allowedHosts/private-host 차단, D3 그대로 재사용)이 결정한다 — "공식 여부를
   *  임의 문자열만으로 결정하지 않는다"의 구현: maxOfficiality:"official" entry는 이
   *  근거가 비어있으면(또는 너무 짧으면) catalog 자체가 유효하지 않은 것으로 거부된다. */
  officialBasis: string;
  /** 이 source가 만들어내는 evidence의 official 상한 — D3.SourceAdapterConfig와 동일한
   *  의미(응답 바디가 이 값을 절대 올릴 수 없다). */
  maxOfficiality: SourceOfficiality;
  adapterType: SourceAdapterType;
  /** 이 source가 답할 수 있는 candidate 구현 형태(MCP/공식 API/SDK/CLI 등, 여러 개 가능). */
  supportedCandidateTypes: CapabilityType[];
  requiresNetwork: boolean;
  requiresCredential: boolean;
  status: SourceCatalogStatus;
  timeoutMs: number;
  maxBodyBytes: number;
}

export type SourceCatalog = readonly CatalogSourceEntry[];

const KNOWN_CAPABILITY_DOMAINS: ReadonlySet<CapabilityDomain> = new Set([
  "database",
  "payment_or_financial",
  "deployment",
  "communication",
  "storage",
  "browser_automation",
  "ai_model",
  "general",
]);
const KNOWN_SOURCE_OFFICIALITIES: ReadonlySet<SourceOfficiality> = new Set(["official", "community", "unknown"]);
const MIN_OFFICIAL_BASIS_LENGTH = 10;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

/** CatalogSourceEntry를 D3의 SourceAdapterConfig로 변환한다 — allowedHosts는 항상
 *  [canonicalHost] 하나뿐이다(이 entry가 다른 host를 부를 방법이 없다). */
function toSourceAdapterConfig(entry: CatalogSourceEntry): SourceAdapterConfig {
  return {
    id: entry.id,
    sourceType: entry.sourceType,
    maxOfficiality: entry.maxOfficiality,
    publisher: entry.provider,
    allowedHosts: [entry.canonicalHost],
    timeoutMs: entry.timeoutMs,
    maxBodyBytes: entry.maxBodyBytes,
  };
}

function validateCatalogSourceEntry(entry: CatalogSourceEntry): void {
  if (!entry || typeof entry !== "object") throw new Error("Invalid CatalogSourceEntry: entry가 비어있거나 객체가 아닙니다.");
  if (!isNonEmptyString(entry.id)) throw new Error("Invalid CatalogSourceEntry: id가 비어있습니다.");
  if (!KNOWN_CAPABILITY_DOMAINS.has(entry.capabilityDomain)) {
    throw new Error(`Invalid CatalogSourceEntry(${entry.id}): capabilityDomain이 알려진 값이 아닙니다.`);
  }
  if (!isNonEmptyString(entry.provider)) throw new Error(`Invalid CatalogSourceEntry(${entry.id}): provider가 비어있습니다.`);
  if (!KNOWN_EVIDENCE_SOURCE_TYPES.has(entry.sourceType)) {
    throw new Error(`Invalid CatalogSourceEntry(${entry.id}): sourceType이 알려진 값이 아닙니다.`);
  }
  if (!KNOWN_SOURCE_OFFICIALITIES.has(entry.maxOfficiality)) {
    throw new Error(`Invalid CatalogSourceEntry(${entry.id}): maxOfficiality가 알려진 값이 아닙니다.`);
  }
  if (entry.adapterType !== "official_json_source") {
    throw new Error(`Invalid CatalogSourceEntry(${entry.id}): 지원하지 않는 adapterType입니다(현재 "official_json_source"만 지원).`);
  }
  if (
    !Array.isArray(entry.supportedCandidateTypes) ||
    entry.supportedCandidateTypes.length === 0 ||
    !entry.supportedCandidateTypes.every((t) => KNOWN_CAPABILITY_TYPES.has(t))
  ) {
    throw new Error(`Invalid CatalogSourceEntry(${entry.id}): supportedCandidateTypes가 비어있거나 알려지지 않은 값을 포함합니다.`);
  }
  if (typeof entry.requiresNetwork !== "boolean") {
    throw new Error(`Invalid CatalogSourceEntry(${entry.id}): requiresNetwork는 boolean이어야 합니다.`);
  }
  if (typeof entry.requiresCredential !== "boolean") {
    throw new Error(`Invalid CatalogSourceEntry(${entry.id}): requiresCredential은 boolean이어야 합니다.`);
  }
  if (entry.status !== "active" && entry.status !== "inactive") {
    throw new Error(`Invalid CatalogSourceEntry(${entry.id}): status는 "active" 또는 "inactive"여야 합니다.`);
  }
  if (entry.maxOfficiality === "official" && (!isNonEmptyString(entry.officialBasis) || entry.officialBasis.trim().length < MIN_OFFICIAL_BASIS_LENGTH)) {
    throw new Error(
      `Invalid CatalogSourceEntry(${entry.id}): maxOfficiality가 "official"이면 officialBasis(공식 근거, 최소 ${MIN_OFFICIAL_BASIS_LENGTH}자)가 있어야 합니다 — 임의 문자열/빈 값만으로 공식 여부를 결정하지 않습니다.`
    );
  }
  // host/URL 검증은 D3의 기존 함수를 그대로 재사용한다(SSRF 방지 로직 복제 금지) —
  // https 전용/userinfo 금지/localhost·private·metadata host 차단(canonicalHost가 그런
  // host면 여기서 이미 throw됨)까지 전부 포함된다.
  validateSourceAdapterConfig(toSourceAdapterConfig(entry));
  const urlCheck = validateSourceUrl(entry.endpointUrl, [entry.canonicalHost]);
  if (!urlCheck.ok) {
    throw new Error(`Invalid CatalogSourceEntry(${entry.id}): endpointUrl 검증 실패 — ${urlCheck.reason}`);
  }
}

/** catalog 전체를 검증한다 — id 중복, 각 entry의 형식/host 유효성을 확인한다. 잘못된
 *  catalog는 조용히 일부만 무시하지 않고 즉시 throw한다(project-policy.ts와 동일한 원칙 —
 *  실행 중에 알아채는 대신 구성 시점에 바로 실패한다). */
export function validateSourceCatalog(catalog: SourceCatalog): void {
  if (!Array.isArray(catalog)) throw new Error("Invalid SourceCatalog: catalog가 배열이 아닙니다.");
  const seenIds = new Set<string>();
  for (const entry of catalog) {
    validateCatalogSourceEntry(entry);
    if (seenIds.has(entry.id)) throw new Error(`Invalid SourceCatalog: source id가 중복됩니다("${entry.id}").`);
    seenIds.add(entry.id);
  }
}

/** requirement의 domain과 일치하고 status==="active"인 catalog entry만 고른다 — 다른
 *  domain/비활성 entry는 "관련 없는 source"로 간주해 절대 호출하지 않는다("알 수 없는
 *  Source 자동 호출 금지" + "무관한 Source 호출 안 함"). */
export function selectRelevantSources(requirement: CapabilityRequirement, catalog: SourceCatalog): CatalogSourceEntry[] {
  const domain = classifyRequirementDomain(requirement.reason);
  return catalog.filter((entry) => entry.status === "active" && entry.capabilityDomain === domain);
}

// =========================================================
// Discovery Orchestrator — 최종 결과는 요구사항 그대로 4가지로만 구분한다.
// =========================================================

export type DiscoveryOutcomeStatus = "SELECTED" | "HUMAN_REVIEW_REQUIRED" | "NO_TRUSTED_CANDIDATE" | "SOURCE_UNAVAILABLE";

export interface CapabilityDiscoveryResult {
  requirement: CapabilityRequirement;
  status: DiscoveryOutcomeStatus;
  /** 실제로 호출을 시도한 catalog source id 목록(provenance) — 호출하지 않은 source는
   *  여기 나타나지 않는다. */
  queriedSourceIds: string[];
  /** D2(discoverTrustedCandidates)의 판정 결과를 그대로 담는다 — 이 파일은 그 판정을
   *  다시 계산하지 않는다(중복 평가 로직 금지). status===SELECTED일 때
   *  trusted.selected(CandidateEvidence)가 실제 선택된 candidate다. */
  trusted?: TrustedDiscoveryResult;
  reason: string;
}

function mapTrustedStatus(status: TrustedDiscoveryStatus): DiscoveryOutcomeStatus {
  switch (status) {
    case "RESOLVED":
      return "SELECTED";
    case "HUMAN_REVIEW_REQUIRED":
      return "HUMAN_REVIEW_REQUIRED";
    case "NO_EVIDENCE_FOUND":
      return "NO_TRUSTED_CANDIDATE";
    case "SOURCE_UNAVAILABLE":
      return "SOURCE_UNAVAILABLE";
  }
}

export interface DiscoverCapabilityOptions {
  httpFetch?: HttpFetch;
  /** fetch 시각(evidence 수집 시각)과 evidence 평가 기준 시각(staleness 판정)에 모두 쓰인다
   *  — 지정하지 않으면 실제 현재 시각. 테스트는 항상 고정값을 주입한다. */
  now?: () => Date;
  /** D2의 TrustedDiscoveryPolicy를 그대로 전달한다 — 이 파일은 별도의 policy 타입을 새로
   *  만들지 않는다(Core trust/risk 완화 불가 원칙은 D2가 이미 보장하며, 이 파일이 다시
   *  구현하지 않는다). */
  policy?: TrustedDiscoveryPolicy;
}

/**
 * CapabilityRequirement 하나를 끝까지 처리한다:
 *   1) selectRelevantSources — catalog에서 관련 있는 active source만 고른다. 하나도
 *      없으면 "이 capability를 다루는 source가 카탈로그에 없다"는 뜻이므로 즉시
 *      NO_TRUSTED_CANDIDATE로 반환한다(어떤 source도 호출하지 않음 — 조회 실패가 아니라
 *      애초에 후보가 없는 것과 같다).
 *   2) 고른 source들만 D3(createAsyncEvidenceSource)로 조회 seam을 만들고,
 *      combineAsyncEvidenceSources로 합친다 — 이 두 함수는 D3 그대로이며 이 파일은
 *      그 안의 fetch/검증 로직을 전혀 재구현하지 않는다.
 *   3) discoverTrustedCandidatesAsync(D3)가 그 결과를 D2의 discoverTrustedCandidates에
 *      위임한다 — evidence 신뢰도/충돌/staleness/Core action tag·secret 강제 판정은
 *      전부 D2 코드 그대로 실행된다.
 *   4) D2의 4가지 상태(RESOLVED/HUMAN_REVIEW_REQUIRED/NO_EVIDENCE_FOUND/
 *      SOURCE_UNAVAILABLE)를 이 파일의 4가지 상태(SELECTED/HUMAN_REVIEW_REQUIRED/
 *      NO_TRUSTED_CANDIDATE/SOURCE_UNAVAILABLE)로 1:1 매핑한다.
 */
export async function discoverCapability(
  requirement: CapabilityRequirement,
  catalog: SourceCatalog,
  opts: DiscoverCapabilityOptions = {}
): Promise<CapabilityDiscoveryResult> {
  const relevant = selectRelevantSources(requirement, catalog);
  if (relevant.length === 0) {
    return {
      requirement,
      status: "NO_TRUSTED_CANDIDATE",
      queriedSourceIds: [],
      reason: `이 capability(domain=${classifyRequirementDomain(requirement.reason)})를 다루는 활성 catalog source가 없습니다 — 알 수 없는 source를 임의로 호출하지 않습니다.`,
    };
  }

  const now = opts.now ?? (() => new Date());
  const asyncSources: AsyncEvidenceSource[] = relevant.map((entry) =>
    createAsyncEvidenceSource(toSourceAdapterConfig(entry), entry.endpointUrl, opts.httpFetch ?? nodeHttpFetch, now)
  );
  const combined = combineAsyncEvidenceSources(asyncSources);
  const trusted = await discoverTrustedCandidatesAsync(requirement, combined, { policy: opts.policy, now: now() });

  return {
    requirement,
    status: mapTrustedStatus(trusted.status),
    queriedSourceIds: relevant.map((e) => e.id),
    trusted,
    reason: trusted.reason,
  };
}
