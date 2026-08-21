import type { CapabilityRequirement, CapabilityType, CostRisk } from "./capability-resolver";
import type { RawResponseMapper } from "./source-adapter";
import type { CatalogSourceEntry, SourceCatalog } from "./discovery-orchestrator";

// Real Official Source Catalog Bootstrap — Phase D Task D5.
//
// D1(capability-resolver.ts)/D2(candidate-evidence.ts)/D3(source-adapter.ts)/D4
// (discovery-orchestrator.ts)의 기존 구조를 그대로 사용해 실제로 존재하고 유지되는 공식
// source 최소 3개를 catalog에 등록한다. 이 파일은 평가/신뢰/보안 로직을 전혀 다시 구현하지
// 않는다 — 여기 있는 건 (1) 실제 vendor의 GitHub REST API 응답을 우리 내부 스키마로
// 재구성하는 순수 함수(createGithubRepoResponseMapper, D3의 RawResponseMapper 훅에만
// 꽂힌다)와 (2) CatalogSourceEntry 3개(D4 구조 그대로)뿐이다.
//
// 등록한 3개 source는 모두 GitHub REST API(api.github.com) 하나의 실제 vendor 통합만
// 쓴다("불필요한 다수 벤더 구현 금지") — GitHub REST API는 공식 문서
// (https://docs.github.com/en/rest/repos/repos#get-a-repository)에 필드가 명확히 규정돼
// 있고, public repo는 인증 없이 조회 가능함을 확인했다.
//
//   1. anthropics/anthropic-sdk-typescript — GitHub 조직 "anthropics"(Anthropic 공식
//      조직)가 소유. npm registry의 @anthropic-ai/sdk 패키지 metadata의 repository.url이
//      이 저장소를 가리킴(2026-08-21 npm registry/GitHub API 직접 확인). Anthropic 공식
//      TypeScript/JS SDK — "API/SDK 후보"를 대표한다.
//   2. modelcontextprotocol/servers — Model Context Protocol 공식 GitHub 조직이 관리하는
//      reference server 모음. modelcontextprotocol.io(MCP 공식 문서 사이트)가 소개하는
//      프로토콜의 reference 구현이며, 검색 결과에서도 "Anthropic이 관리하는 공식 저장소"로
//      일관되게 확인됨(2026-08-21 확인, archived:false, 최근 push 확인됨) — "MCP 후보"를
//      대표한다.
//   3. puppeteer/puppeteer — GitHub 조직 "puppeteer"(Chrome DevTools 계보 공식 조직)가
//      소유한 Chrome/Firefox 공식 자동화 라이브러리(2026-08-21 확인, archived:false) —
//      "CLI/tool 후보"(browser_automation domain)를 대표한다.
//
// 오래됐거나 공식 여부가 불명확한 source는 등록하지 않았다 — 조사 과정에서 npm registry의
// 상세 package document(https://registry.npmjs.org/<pkg>)는 응답이 지나치게 커서(전체
// 버전 이력 포함) 이 세션의 조회 도구로 안정적으로 검증할 수 없었고, "last-known update"
// 필드(time.modified)의 존재를 신뢰성 있게 재확인하지 못했다 — 그래서 npm registry 기반
// evidence는 이번 bootstrap에 포함하지 않고, 필드가 공식 문서로 명확히 검증된 GitHub REST
// API만 채택했다(추측으로 값을 채우지 않는다는 원칙 그대로 적용).

// =========================================================
// GitHub REST API repo metadata → RawCandidateMetadata 매퍼.
// =========================================================

export interface GithubRepoMapperCuration {
  /** 이 candidate를 실제로 쓰려면 secret/credential이 필요한지 — GitHub repo API 응답에는
   *  없는 정보라(레포 메타데이터가 "이 SDK를 쓰려면 API key가 필요하다"를 말해주지 않음)
   *  사람이 문서화한 값이다(예: Anthropic SDK는 실제 API 호출에 ANTHROPIC_API_KEY 필요). */
  requiresSecret: boolean;
  costRisk: CostRisk;
}

const NOASSERTION = "NOASSERTION";

/**
 * GitHub REST API `GET /repos/{owner}/{repo}` 응답(공식 문서 기준 필드: full_name/
 * archived/pushed_at/html_url/license.spdx_id/stargazers_count)을 우리 내부
 * `{candidates:[RawCandidateMetadata]}` 스키마로 재구성한다. official/sourceType/
 * sourceRef/evidenceTimestamp에는 전혀 관여하지 않는다(그 값들은 여전히
 * fetchEvidenceFromOfficialJsonSource가 SourceAdapterConfig와 fetch 메타데이터로만
 * 채운다) — 이 함수는 순수 데이터 재구성이며 신뢰 판정을 대신하지 않는다.
 *
 * maintenanceStatus는 실제 응답의 `archived`(boolean, GitHub 공식 문서에 정의된 필드)만
 * 근거로 삼는다 — archived:true면 "unmaintained", 아니면 "maintained"("actively_maintained"
 * 로 과장하지 않는다 — 실제 최신성 판단은 lastKnownUpdate(pushed_at)를 근거로 D2의
 * staleness 판정이 별도로 담당한다). license는 GitHub가 감지하지 못한 경우
 * (spdx_id==="NOASSERTION")라면 추측하지 않고 생략한다.
 *
 * 필수 필드(full_name/archived)가 없거나 형식이 다르면 throw한다 —
 * fetchEvidenceFromOfficialJsonSource가 이를 malformed response로 처리해 근거 없이
 * 자동 선택하지 않는다.
 */
export function createGithubRepoResponseMapper(candidateType: CapabilityType, curation: GithubRepoMapperCuration): RawResponseMapper {
  return (raw: unknown, requirement: CapabilityRequirement): unknown => {
    if (!raw || typeof raw !== "object") {
      throw new Error("GitHub repo 응답이 객체가 아닙니다.");
    }
    const o = raw as Record<string, unknown>;

    const fullName = o.full_name;
    if (typeof fullName !== "string" || fullName.length === 0) {
      throw new Error("GitHub repo 응답에 full_name(string)이 없습니다.");
    }
    const archived = o.archived;
    if (typeof archived !== "boolean") {
      throw new Error("GitHub repo 응답에 archived(boolean)가 없습니다.");
    }

    const pushedAt = o.pushed_at;
    const htmlUrl = o.html_url;
    const lastKnownUpdate =
      typeof pushedAt === "string" && pushedAt.length > 0
        ? { date: pushedAt, reference: typeof htmlUrl === "string" ? htmlUrl : undefined }
        : undefined;

    const licenseObj = o.license as Record<string, unknown> | null | undefined;
    const spdxId = licenseObj && typeof licenseObj === "object" ? licenseObj.spdx_id : undefined;
    const license = typeof spdxId === "string" && spdxId.length > 0 && spdxId !== NOASSERTION ? spdxId : undefined;

    const stars = o.stargazers_count;
    const securitySignal =
      typeof stars === "number"
        ? { summary: `GitHub stargazers_count: ${stars}(커뮤니티 참여 지표 — 보안 감사 결과가 아님)`, sourceType: "official_repository" as const }
        : undefined;

    return {
      candidates: [
        {
          candidateId: fullName,
          capabilityId: requirement.id,
          type: candidateType,
          maintenanceStatus: archived ? "unmaintained" : "maintained",
          lastKnownUpdate,
          requiredPermissions: [],
          requiresNetwork: true,
          requiresSecret: curation.requiresSecret,
          costRisk: curation.costRisk,
          license,
          securitySignal,
        },
      ],
    };
  };
}

// =========================================================
// 실제 공식 Source Catalog — 최소 3개(대표 capability 유형별 1개씩).
// =========================================================

const GITHUB_API_HOST = "api.github.com";

export const REAL_OFFICIAL_SOURCE_CATALOG: SourceCatalog = [
  {
    id: "anthropic-sdk-typescript-github",
    capabilityDomain: "ai_model",
    provider: "Anthropic",
    sourceType: "official_repository",
    canonicalHost: GITHUB_API_HOST,
    endpointUrl: "https://api.github.com/repos/anthropics/anthropic-sdk-typescript",
    officialBasis:
      'GitHub 조직 "anthropics"(Anthropic 공식 조직) 소유 저장소이며, npm registry의 @anthropic-ai/sdk ' +
      "패키지 metadata의 repository.url이 이 저장소를 가리킴(2026-08-21 npm registry/GitHub API 직접 확인).",
    maxOfficiality: "official",
    adapterType: "official_json_source",
    supportedCandidateTypes: ["sdk"],
    requiresNetwork: true,
    requiresCredential: false,
    status: "active",
    timeoutMs: 8000,
    maxBodyBytes: 200_000,
    responseMapper: createGithubRepoResponseMapper("sdk", { requiresSecret: true, costRisk: "possible" }),
  },
  {
    id: "mcp-reference-servers-github",
    capabilityDomain: "ai_model",
    provider: "Model Context Protocol (Anthropic-managed)",
    sourceType: "official_repository",
    canonicalHost: GITHUB_API_HOST,
    endpointUrl: "https://api.github.com/repos/modelcontextprotocol/servers",
    officialBasis:
      "modelcontextprotocol.io(MCP 공식 문서 사이트)가 소개하는 프로토콜의 reference server 구현 저장소이며, " +
      "GitHub 조직 modelcontextprotocol이 관리함(2026-08-21 확인, archived:false, 최근 push 활동 확인됨).",
    maxOfficiality: "official",
    adapterType: "official_json_source",
    supportedCandidateTypes: ["mcp_server"],
    requiresNetwork: true,
    requiresCredential: false,
    status: "active",
    timeoutMs: 8000,
    maxBodyBytes: 200_000,
    responseMapper: createGithubRepoResponseMapper("mcp_server", { requiresSecret: false, costRisk: "none" }),
  },
  {
    id: "puppeteer-github",
    capabilityDomain: "browser_automation",
    provider: "Puppeteer",
    sourceType: "official_repository",
    canonicalHost: GITHUB_API_HOST,
    endpointUrl: "https://api.github.com/repos/puppeteer/puppeteer",
    officialBasis:
      'GitHub 조직 "puppeteer"(Chrome DevTools 계보 공식 조직) 소유의 Chrome/Firefox 공식 자동화 ' +
      "JavaScript API 저장소(2026-08-21 확인, archived:false).",
    maxOfficiality: "official",
    adapterType: "official_json_source",
    supportedCandidateTypes: ["sdk"],
    requiresNetwork: true,
    requiresCredential: false,
    status: "active",
    timeoutMs: 8000,
    maxBodyBytes: 200_000,
    responseMapper: createGithubRepoResponseMapper("sdk", { requiresSecret: false, costRisk: "none" }),
  },
];

export const REAL_SOURCE_CATALOG_VERIFIED_AT = "2026-08-21";
