import type { CapabilityRequirement, CapabilityType, SourceOfficiality, CostRisk, ActionTag } from "./capability-resolver";
import {
  discoverTrustedCandidates,
  KNOWN_ACTION_TAGS,
} from "./candidate-evidence";
import type {
  CandidateEvidence,
  EvidenceSourceOutcome,
  EvidenceSourceType,
  MaintenanceStatus,
  LastKnownUpdate,
  SecurityReputationSignal,
  EvaluateEvidenceOptions,
  TrustedDiscoveryResult,
} from "./candidate-evidence";

// Official Candidate Source Integration — Phase D Task D3.
//
// D1(capability-resolver.ts)의 CandidateSource seam과 D2(candidate-evidence.ts)의
// CandidateEvidence/EvidenceSource 위에, 실제 공식 vendor 문서/repository/SDK·package
// registry metadata에서 evidence를 가져올 수 있는 범용 Source Adapter 구조를 더한다. D1/D2
// 파일의 기존 동작은 이 Task에서 바꾸지 않는다(D2에 KNOWN_ACTION_TAGS export 추가만 했다 —
// 순수 추가, 기존 export/동작 변경 없음).
//
// 이 Task는 MCP 설치/활성화/실행, Browser Worker, Agent Router, Dashboard, 자동 다운로드,
// production credential 사용을 하지 않는다. AI(Claude/GPT) 판단에 의존하지 않는다 — 이
// 모듈은 LLM을 호출하지 않고, 어떤 LLM 출력도 신뢰 입력으로 받지 않는다.
//
// 핵심 보안 설계 — "source가 official 여부를 자기 주장만으로 확정할 수 없다":
// 외부에서 fetch한 JSON 응답의 스키마(RawCandidateMetadata)에는 official/sourceType/
// sourceRef/evidenceTimestamp 필드가 아예 존재하지 않는다. 이 네 필드는 오직 이 파일의
// SourceAdapterConfig(코드 레벨 상수, 응답과 무관)로만 채워진다 — 응답 바디에 "official":
// true 같은 필드를 끼워 넣어도 파싱 단계에서 무시되고 evidence.official에는 절대 반영되지
// 않는다(§ parseRawCandidateMetadataList/toCandidateEvidenceList, 아래 테스트로도
// 직접 검증한다).
//
// 실제 조회로 얻은 evidence도 D2의 evaluate/rank/conflict 판정을 반드시 거친 뒤에만
// 쓰인다 — 이 파일은 fetch 결과를 곧바로 "신뢰"하지 않는다(discoverTrustedCandidatesAsync가
// D2의 discoverTrustedCandidates에 그대로 위임 — 판정 로직을 복제하지 않는다).

// =========================================================
// URL 검증 — SSRF 방지. 이 파일의 어떤 함수도 이 검증을 우회하는 경로로 fetch를 실행하지
// 않는다(Core hard rule — safe-executor.ts의 DENY_PATH_PATTERNS와 동일한 설계 원칙: 항상
// 먼저 적용되고, 어떤 adapter 설정으로도 끌 수 없다).
// =========================================================

const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "0.0.0.0", "::1", "[::1]"]);

// IPv4 private/link-local/loopback 대역 — 169.254.169.254(AWS/GCP/Azure 클라우드 metadata
// endpoint)는 169.254.0.0/16(link-local)에 포함되므로 별도 규칙 없이 이 패턴으로 함께
// 차단된다.
const PRIVATE_IPV4_PATTERNS: RegExp[] = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0\./];

/** localhost/private network/link-local/cloud metadata endpoint 판정의 단일 출처 —
 *  browser-worker.ts(Phase E Task E1)의 navigation validator도 이 함수를 그대로
 *  재사용한다(SSRF 방지 로직 복제 금지). */
export function isPrivateOrMetadataHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (PRIVATE_IPV4_PATTERNS.some((p) => p.test(h))) return true;
  // IPv6 loopback(::1은 위에서 처리)/ULA(fc00::/7)/link-local(fe80::/10).
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  return false;
}

export interface UrlValidationOk {
  ok: true;
  url: URL;
}
export interface UrlValidationFail {
  ok: false;
  reason: string;
}

/**
 * 요청을 실제로 보내기 전에 항상 거치는 검증 — https만 허용, embedded credential(userinfo)
 * 금지, localhost/private network/cloud metadata endpoint 차단(allowedHosts에 실수로
 * 들어있어도 차단 — defense in depth), 그리고 adapter가 명시적으로 신뢰하는 host 목록
 * (allowedHosts) 밖은 전부 거부한다. 이 목록은 requirement/응답 내용으로 바뀌지 않는
 * 코드 레벨 상수다(임의 URL 요청 금지).
 */
export function validateSourceUrl(rawUrl: string, allowedHosts: readonly string[]): UrlValidationOk | UrlValidationFail {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "URL을 파싱할 수 없습니다." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: `허용되지 않은 protocol(${url.protocol}) — https만 허용됩니다.` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URL에 embedded credential(userinfo)이 포함될 수 없습니다." };
  }
  if (isPrivateOrMetadataHost(url.hostname)) {
    return { ok: false, reason: `localhost/private network/cloud metadata endpoint로 판단되는 host(${url.hostname})는 허용되지 않습니다.` };
  }
  const normalizedAllowed = allowedHosts.map((h) => h.toLowerCase());
  if (!normalizedAllowed.includes(url.hostname.toLowerCase())) {
    return { ok: false, reason: `허용되지 않은 host(${url.hostname}) — 이 adapter의 신뢰 host 목록에 없습니다.` };
  }
  return { ok: true, url };
}

// =========================================================
// HTTP fetch seam — 실제 네트워크 호출은 이 함수 타입 뒤로 격리된다. dependency-scanner.ts의
// VulnerabilityAuditSource와 동일한 설계 원칙: 실제 운용 기본 구현(nodeHttpFetch)은
// 네트워크를 쓰지만, 이 모듈의 나머지 로직과 모든 테스트는 이 함수를 fixture로 주입해
// 네트워크 없이 deterministic하게 검증한다. 이 함수는 header/credential을 받는 파라미터가
// 아예 없다 — secret/credential을 자동으로 실어 보낼 방법이 구조적으로 없다.
// =========================================================

export interface HttpFetchOptions {
  timeoutMs: number;
  maxBodyBytes: number;
}

export interface HttpFetchSuccess {
  status: number;
  /** 실제로 응답한 URL(리다이렉트를 절대 따라가지 않으므로 항상 요청 URL과 같아야 한다). */
  finalUrl: string;
  bodyText: string;
}

export type HttpFetchOutcome = { ok: true; response: HttpFetchSuccess } | { ok: false; reason: string };

export type HttpFetch = (url: string, opts: HttpFetchOptions) => Promise<HttpFetchOutcome>;

/**
 * 실제 운용 기본 구현 — Node 전역 fetch를 쓴다. 반드시 지킨다: (1) redirect:"manual"로
 * 호출해 3xx 응답을 자동으로 따라가지 않는다(res.type==="opaqueredirect"이면 즉시 실패로
 * 취급 — 요구사항 "redirect/URL 검증"). (2) AbortController로 timeoutMs를 강제한다. (3)
 * 응답 body를 스트림으로 읽으며 누적 바이트 수가 maxBodyBytes를 넘으면 즉시 중단하고
 * 실패로 취급한다("oversized response 차단" — 잘라서 계속 쓰지 않고 전체를 거부한다). (4)
 * 2xx가 아닌 상태 코드는 실패로 취급한다. 이 함수는 어떤 header/credential도 요청에
 * 추가하지 않는다(secret 자동 전송 금지).
 */
export const nodeHttpFetch: HttpFetch = async (url, opts) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "manual" });
    if (res.type === "opaqueredirect") {
      return { ok: false, reason: "redirect 응답을 받았습니다 — 자동으로 따라가지 않습니다(SSRF 방지)." };
    }
    if (!res.ok) {
      return { ok: false, reason: `HTTP ${res.status} 응답.` };
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let oversized = false;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          if (received > opts.maxBodyBytes) {
            oversized = true;
            try {
              await reader.cancel();
            } catch {
              // 취소 실패는 무시 — 어차피 아래에서 실패로 반환한다.
            }
            break;
          }
          chunks.push(value);
        }
      }
    }
    if (oversized) {
      return { ok: false, reason: `응답 크기가 허용 한도(${opts.maxBodyBytes} bytes)를 초과했습니다.` };
    }
    const bodyText = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf-8");
    return { ok: true, response: { status: res.status, finalUrl: res.url, bodyText } };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, reason: `timeout(${opts.timeoutMs}ms)` };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `fetch 실패: ${message}` };
  } finally {
    clearTimeout(timer);
  }
};

// =========================================================
// 선택적 TTL 캐시 — "cache가 필요하면 timestamp/만료를 명시"를 위한 최소 구현. 실패 응답은
// 캐시하지 않는다(일시적 오류를 계속 재사용해 fail-closed 원칙을 흐리지 않기 위함).
// =========================================================

export interface CacheEntry {
  value: HttpFetchOutcome;
  fetchedAt: string;
  expiresAt: string;
}

/** inner(HttpFetch)를 감싸 TTL 캐시를 추가한다. now는 테스트가 고정된 시계를 주입할 수
 *  있도록 콜백으로 받는다(기본값은 실제 현재 시각). */
export function createTtlCachedHttpFetch(inner: HttpFetch, ttlMs: number, now: () => Date = () => new Date()): HttpFetch {
  const cache = new Map<string, CacheEntry>();
  return async (url, opts) => {
    const cached = cache.get(url);
    const nowMs = now().getTime();
    if (cached && new Date(cached.expiresAt).getTime() > nowMs) {
      return cached.value;
    }
    const result = await inner(url, opts);
    if (result.ok) {
      cache.set(url, { value: result, fetchedAt: new Date(nowMs).toISOString(), expiresAt: new Date(nowMs + ttlMs).toISOString() });
    }
    return result;
  };
}

// =========================================================
// 응답 스키마 — 의도적으로 official/sourceType/sourceRef/evidenceTimestamp를 포함하지
// 않는다(위 상단 주석 참고). 이 스키마 밖의 필드(예: 응답이 자기 스스로 "official":true를
// 주장하는 필드)는 파싱 과정에서 아예 읽히지 않는다.
// =========================================================

interface RawCandidateMetadata {
  candidateId: string;
  capabilityId: string;
  type: CapabilityType;
  maintenanceStatus: MaintenanceStatus;
  lastKnownUpdate?: LastKnownUpdate;
  requiredPermissions: string[];
  requiresNetwork: boolean;
  requiresSecret: boolean;
  costRisk: CostRisk;
  license?: string;
  securitySignal?: SecurityReputationSignal;
  actionTags?: ActionTag[];
  alternatives?: string[];
}

/** discovery-orchestrator.ts(Phase D Task D4)의 catalog entry 검증도 이 하나의 출처를
 *  재사용한다(목록 복제 금지). */
export const KNOWN_CAPABILITY_TYPES: ReadonlySet<CapabilityType> = new Set(["mcp_server", "official_api", "sdk", "cli", "other"]);
const KNOWN_MAINTENANCE_STATUSES: ReadonlySet<MaintenanceStatus> = new Set([
  "actively_maintained",
  "maintained",
  "stale",
  "unmaintained",
  "unknown",
]);
const KNOWN_COST_RISKS: ReadonlySet<CostRisk> = new Set(["none", "possible", "certain"]);
export const KNOWN_EVIDENCE_SOURCE_TYPES: ReadonlySet<EvidenceSourceType> = new Set([
  "official_vendor_doc",
  "official_repository",
  "official_sdk_or_registry_metadata",
  "vendor_maintained",
  "general_technical",
  "community_signal",
]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function validateOneRawCandidateMetadata(item: unknown, index: number): { ok: true; data: RawCandidateMetadata } | { ok: false; reason: string } {
  if (!item || typeof item !== "object") return { ok: false, reason: `candidates[${index}]가 객체가 아닙니다.` };
  const o = item as Record<string, unknown>;

  if (!isNonEmptyString(o.candidateId)) return { ok: false, reason: `candidates[${index}].candidateId가 비어있거나 문자열이 아닙니다.` };
  if (!isNonEmptyString(o.capabilityId)) return { ok: false, reason: `candidates[${index}].capabilityId가 비어있거나 문자열이 아닙니다.` };
  if (typeof o.type !== "string" || !KNOWN_CAPABILITY_TYPES.has(o.type as CapabilityType)) {
    return { ok: false, reason: `candidates[${index}].type이 알려진 CapabilityType이 아닙니다.` };
  }
  if (typeof o.maintenanceStatus !== "string" || !KNOWN_MAINTENANCE_STATUSES.has(o.maintenanceStatus as MaintenanceStatus)) {
    return { ok: false, reason: `candidates[${index}].maintenanceStatus가 알려진 값이 아닙니다.` };
  }
  if (o.lastKnownUpdate !== undefined) {
    const lku = o.lastKnownUpdate;
    if (!lku || typeof lku !== "object" || !isNonEmptyString((lku as Record<string, unknown>).date)) {
      return { ok: false, reason: `candidates[${index}].lastKnownUpdate.date가 비어있거나 문자열이 아닙니다.` };
    }
  }
  if (!Array.isArray(o.requiredPermissions) || !o.requiredPermissions.every((p) => typeof p === "string")) {
    return { ok: false, reason: `candidates[${index}].requiredPermissions는 string 배열이어야 합니다.` };
  }
  if (typeof o.requiresNetwork !== "boolean") return { ok: false, reason: `candidates[${index}].requiresNetwork는 boolean이어야 합니다.` };
  if (typeof o.requiresSecret !== "boolean") return { ok: false, reason: `candidates[${index}].requiresSecret는 boolean이어야 합니다.` };
  if (typeof o.costRisk !== "string" || !KNOWN_COST_RISKS.has(o.costRisk as CostRisk)) {
    return { ok: false, reason: `candidates[${index}].costRisk가 알려진 값이 아닙니다.` };
  }
  if (o.license !== undefined && typeof o.license !== "string") {
    return { ok: false, reason: `candidates[${index}].license는 문자열이어야 합니다.` };
  }
  if (o.securitySignal !== undefined) {
    const s = o.securitySignal as Record<string, unknown> | null;
    if (
      !s ||
      typeof s !== "object" ||
      !isNonEmptyString(s.summary) ||
      typeof s.sourceType !== "string" ||
      !KNOWN_EVIDENCE_SOURCE_TYPES.has(s.sourceType as EvidenceSourceType)
    ) {
      return { ok: false, reason: `candidates[${index}].securitySignal 형식이 올바르지 않습니다.` };
    }
  }
  if (o.actionTags !== undefined) {
    if (!Array.isArray(o.actionTags) || !o.actionTags.every((t) => typeof t === "string" && KNOWN_ACTION_TAGS.has(t as ActionTag))) {
      return { ok: false, reason: `candidates[${index}].actionTags는 알려진 ActionTag 배열이어야 합니다.` };
    }
  }
  if (o.alternatives !== undefined) {
    if (!Array.isArray(o.alternatives) || !o.alternatives.every((a) => typeof a === "string")) {
      return { ok: false, reason: `candidates[${index}].alternatives는 string 배열이어야 합니다.` };
    }
  }

  return {
    ok: true,
    data: {
      candidateId: o.candidateId as string,
      capabilityId: o.capabilityId as string,
      type: o.type as CapabilityType,
      maintenanceStatus: o.maintenanceStatus as MaintenanceStatus,
      lastKnownUpdate: o.lastKnownUpdate as LastKnownUpdate | undefined,
      requiredPermissions: o.requiredPermissions as string[],
      requiresNetwork: o.requiresNetwork as boolean,
      requiresSecret: o.requiresSecret as boolean,
      costRisk: o.costRisk as CostRisk,
      license: o.license as string | undefined,
      securitySignal: o.securitySignal as SecurityReputationSignal | undefined,
      actionTags: o.actionTags as ActionTag[] | undefined,
      alternatives: o.alternatives as string[] | undefined,
    },
  };
}

/** 응답 전체 JSON을 검증한다 — 형태는 `{ candidates: RawCandidateMetadata[] }`. 항목 하나
 *  라도 형식이 올바르지 않으면 응답 전체를 거부한다(부분 신뢰 없음 — malformed response는
 *  전부 아니면 전무). */
function parseRawCandidateMetadataList(json: unknown): { ok: true; data: RawCandidateMetadata[] } | { ok: false; reason: string } {
  if (!json || typeof json !== "object") return { ok: false, reason: "응답이 객체가 아닙니다." };
  const candidates = (json as Record<string, unknown>).candidates;
  if (!Array.isArray(candidates)) return { ok: false, reason: '응답에 "candidates" 배열이 없습니다.' };
  if (candidates.length === 0) return { ok: false, reason: '"candidates" 배열이 비어있습니다.' };
  const result: RawCandidateMetadata[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const v = validateOneRawCandidateMetadata(candidates[i], i);
    if (!v.ok) return { ok: false, reason: v.reason };
    result.push(v.data);
  }
  return { ok: true, data: result };
}

// =========================================================
// Source Adapter — 공식 JSON metadata endpoint를 위한 범용 구현. MCP/공식 API/SDK/CLI
// 후보 전부 CapabilityType(type 필드)만 다를 뿐 같은 스키마로 표현되므로, 벤더별로 별도
// adapter 클래스를 만들지 않고 이 하나의 factory를 config만 바꿔 재사용한다("불필요한 다수
// 벤더 구현 금지").
// =========================================================

/**
 * 실제 vendor가 우리 내부 스키마({candidates:[...]})와 다른 형식으로 응답할 때(예: GitHub
 * REST API의 repo 메타데이터), JSON.parse 직후·스키마 검증 직전에 한 번 순수하게 재구성하는
 * 훅(Phase D Task D5 — Real Official Source Catalog Bootstrap). requirement는 capabilityId를
 * 채워 넣는 용도로만 쓴다. 이 함수는 official/sourceType/sourceRef/evidenceTimestamp에
 * 절대 관여하지 않는다 — 그 네 값은 여전히 fetchEvidenceFromOfficialJsonSource가 config와
 * fetch 메타데이터로만 채운다(§ 아래). 신뢰/보안 판정 로직이 아니라 순수 데이터 재구성이므로
 * D2/D1의 평가 로직을 전혀 건드리지 않는다 — 잘못된 형식이면 그냥 throw하면 된다(malformed
 * response로 처리됨, fail-open 없음).
 */
export type RawResponseMapper = (raw: unknown, requirement: CapabilityRequirement) => unknown;

export interface SourceAdapterConfig {
  /** 이 adapter의 고유 식별자(로그/에러 메시지에 표시). */
  id: string;
  /** 이 adapter가 만들어내는 evidence의 sourceType — 응답이 아니라 이 코드 레벨 설정이
   *  유일한 출처다. */
  sourceType: EvidenceSourceType;
  /** 이 adapter가 부여할 수 있는 official 등급의 상한 — 응답 바디의 어떤 필드도 이 값을
   *  올릴 수 없다(응답 스키마 자체에 official 필드가 없다). */
  maxOfficiality: SourceOfficiality;
  /** 사람이 읽는 publisher/provider 이름 — 응답이 아니라 이 설정이 출처다. */
  publisher: string;
  /** 이 adapter가 실제로 요청을 보낼 수 있는 정확한 host 목록(SSRF 방지의 단일 출처). */
  allowedHosts: string[];
  timeoutMs: number;
  maxBodyBytes: number;
  /** 지정하지 않으면(기존 동작과 완전히 동일) 응답을 그대로 스키마 검증에 넘긴다. */
  responseMapper?: RawResponseMapper;
}

export function validateSourceAdapterConfig(config: SourceAdapterConfig): void {
  if (!config || typeof config !== "object") throw new Error("Invalid SourceAdapterConfig: config가 비어있거나 객체가 아닙니다.");
  if (!isNonEmptyString(config.id)) throw new Error("Invalid SourceAdapterConfig: id가 비어있습니다.");
  if (!isNonEmptyString(config.publisher)) throw new Error(`Invalid SourceAdapterConfig(${config.id}): publisher가 비어있습니다.`);
  if (!Array.isArray(config.allowedHosts) || config.allowedHosts.length === 0 || !config.allowedHosts.every(isNonEmptyString)) {
    throw new Error(`Invalid SourceAdapterConfig(${config.id}): allowedHosts가 비어있거나 string 배열이 아닙니다.`);
  }
  if (config.allowedHosts.some((h) => isPrivateOrMetadataHost(h))) {
    throw new Error(`Invalid SourceAdapterConfig(${config.id}): allowedHosts에 localhost/private/metadata host를 넣을 수 없습니다.`);
  }
  if (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0) {
    throw new Error(`Invalid SourceAdapterConfig(${config.id}): timeoutMs는 양수여야 합니다.`);
  }
  if (!Number.isFinite(config.maxBodyBytes) || config.maxBodyBytes <= 0) {
    throw new Error(`Invalid SourceAdapterConfig(${config.id}): maxBodyBytes는 양수여야 합니다.`);
  }
}

/**
 * requirement 하나를 명시된 endpointUrl에서 조회해 CandidateEvidence[]로 변환한다. 순서:
 * (1) validateSourceUrl — https/no-userinfo/private·metadata 차단/allowedHosts 확인.
 * (2) httpFetch — timeout/redirect 거부/response size 제한을 강제하는 seam(기본값
 *     nodeHttpFetch, 테스트는 fixture 주입).
 * (3) JSON 파싱 → config.responseMapper가 있으면 순수 재구성(§ RawResponseMapper, 실패 시
 *     malformed response로 처리) → parseRawCandidateMetadataList — 스키마 밖 필드(예: 자칭
 *     "official")는 아예 읽지 않는다.
 * (4) evidence 조립 — official/sourceType/sourceRef/evidenceTimestamp는 전부 config와
 *     fetch 메타데이터(finalUrl/현재 시각)에서만 채운다(응답 바디 값 사용 안 함).
 * 이 함수가 반환하는 evidence는 아직 "신뢰됐다"는 뜻이 아니다 — 호출부가 반드시
 * discoverTrustedCandidatesAsync()(또는 D2의 evaluate 계열 함수)를 거쳐야 한다.
 */
export async function fetchEvidenceFromOfficialJsonSource(
  config: SourceAdapterConfig,
  requirement: CapabilityRequirement,
  endpointUrl: string,
  httpFetch: HttpFetch = nodeHttpFetch,
  now: () => Date = () => new Date()
): Promise<EvidenceSourceOutcome> {
  const urlCheck = validateSourceUrl(endpointUrl, config.allowedHosts);
  if (!urlCheck.ok) {
    return { ok: false, reason: `[${config.id}] ${urlCheck.reason}` };
  }

  const fetchOutcome = await httpFetch(urlCheck.url.toString(), { timeoutMs: config.timeoutMs, maxBodyBytes: config.maxBodyBytes });
  if (!fetchOutcome.ok) {
    return { ok: false, reason: `[${config.id}] ${fetchOutcome.reason}` };
  }

  let json: unknown;
  try {
    json = JSON.parse(fetchOutcome.response.bodyText);
  } catch {
    return { ok: false, reason: `[${config.id}] 응답이 유효한 JSON이 아닙니다(malformed response).` };
  }

  let mapped: unknown = json;
  if (config.responseMapper) {
    try {
      mapped = config.responseMapper(json, requirement);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `[${config.id}] 응답 변환(responseMapper) 실패(malformed response): ${message}` };
    }
  }

  const parsed = parseRawCandidateMetadataList(mapped);
  if (!parsed.ok) {
    return { ok: false, reason: `[${config.id}] 응답 스키마가 올바르지 않습니다: ${parsed.reason}` };
  }

  // requirement.id와 무관한 capability를 응답에 섞어 보내도 그대로 받아들이지 않는다 —
  // 이 adapter는 그 판단을 하지 않고 그대로 넘기지만, D2의 discoverTrustedCandidates는
  // requirement별로 별도 호출되므로 실제 사용 흐름에서 다른 requirement의 evidence가 섞여
  // 들어올 일이 없다(§ discoverTrustedCandidatesAsync가 이 함수를 requirement 단위로 호출).
  const evidenceTimestamp = now().toISOString();
  const evidence: CandidateEvidence[] = parsed.data.map((raw) => ({
    candidateId: raw.candidateId,
    capabilityId: raw.capabilityId,
    type: raw.type,
    sourceType: config.sourceType,
    sourceRef: fetchOutcome.response.finalUrl,
    official: config.maxOfficiality,
    publisher: config.publisher,
    maintenanceStatus: raw.maintenanceStatus,
    lastKnownUpdate: raw.lastKnownUpdate,
    requiredPermissions: raw.requiredPermissions,
    requiresNetwork: raw.requiresNetwork,
    requiresSecret: raw.requiresSecret,
    costRisk: raw.costRisk,
    license: raw.license,
    securitySignal: raw.securitySignal,
    evidenceTimestamp,
    alternatives: raw.alternatives,
    actionTags: raw.actionTags,
  }));

  return { ok: true, evidence };
}

// =========================================================
// D2 discoverTrustedCandidates로의 위임 — 비동기 fetch 결과를 D2의 동기 순수 판정 함수에
// 그대로 넘긴다(판정 로직 복제 없음, D2 파일도 수정하지 않음).
// =========================================================

export type AsyncEvidenceSource = (requirement: CapabilityRequirement) => Promise<EvidenceSourceOutcome>;

/**
 * 실제 네트워크 조회(비동기)를 D2의 discoverTrustedCandidates(동기)에 위임한다. fetch 자체가
 * 실패/timeout/malformed여도 이 함수는 그 결과를 그대로 D2에 전달할 뿐 스스로 후보를
 * 선택하지 않는다 — "조회 실패/timeout/잘못된 응답 → 근거 없는 자동선택 금지"는
 * discoverTrustedCandidates(SOURCE_UNAVAILABLE)가 그대로 보장한다.
 */
export async function discoverTrustedCandidatesAsync(
  requirement: CapabilityRequirement,
  source: AsyncEvidenceSource,
  opts?: EvaluateEvidenceOptions
): Promise<TrustedDiscoveryResult> {
  const outcome = await source(requirement);
  return discoverTrustedCandidates(requirement, () => outcome, opts);
}

/** SourceAdapterConfig + endpointUrl 하나를 AsyncEvidenceSource로 감싼다 — 여러 adapter를
 *  같은 requirement에 대해 순차 조회하고 싶다면 combineAsyncEvidenceSources()를 쓴다. */
export function createAsyncEvidenceSource(
  config: SourceAdapterConfig,
  endpointUrl: string,
  httpFetch: HttpFetch = nodeHttpFetch,
  now: () => Date = () => new Date()
): AsyncEvidenceSource {
  return (requirement: CapabilityRequirement) => fetchEvidenceFromOfficialJsonSource(config, requirement, endpointUrl, httpFetch, now);
}

/** 여러 AsyncEvidenceSource를 순서대로 호출해 evidence를 합친다 — 하나라도 실패하면 그
 *  실패를 삼키지 않고 reasons에 기록하되, 나머지 source가 유효한 evidence를 냈다면
 *  전체 조회를 중단하지 않는다(부분 실패를 전체 실패로 과잉 처리하지 않음). 모든 source가
 *  실패하면(성공한 evidence가 하나도 없으면) 전체를 ok:false로 반환한다(근거 없는 자동
 *  선택 금지 — 일부만 성공했다고 해서 실패한 source의 부재를 "정상"으로 조용히 넘기지
 *  않고 reason에 실패 목록을 남긴다). */
export function combineAsyncEvidenceSources(sources: AsyncEvidenceSource[]): AsyncEvidenceSource {
  return async (requirement: CapabilityRequirement): Promise<EvidenceSourceOutcome> => {
    const evidence: CandidateEvidence[] = [];
    const failures: string[] = [];
    for (const source of sources) {
      const outcome = await source(requirement);
      if (outcome.ok) {
        evidence.push(...outcome.evidence);
      } else {
        failures.push(outcome.reason);
      }
    }
    if (evidence.length === 0) {
      return {
        ok: false,
        reason: failures.length > 0 ? `모든 source 조회 실패: ${failures.join(" | ")}` : "모든 source가 evidence를 반환하지 않았습니다.",
      };
    }
    return { ok: true, evidence };
  };
}
