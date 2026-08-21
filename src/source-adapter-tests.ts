import {
  validateSourceUrl,
  validateSourceAdapterConfig,
  fetchEvidenceFromOfficialJsonSource,
  discoverTrustedCandidatesAsync,
  createAsyncEvidenceSource,
  combineAsyncEvidenceSources,
  createTtlCachedHttpFetch,
  nodeHttpFetch,
} from "./source-adapter";
import type { SourceAdapterConfig, HttpFetch, HttpFetchOutcome, AsyncEvidenceSource } from "./source-adapter";
import type { CapabilityRequirement } from "./capability-resolver";

// Official Candidate Source Integration 테스트(Phase D Task D3). 실제 Claude/GPT 유료 API를
// 호출하지 않고, MOVAN product task도 실행하지 않으며, 실제 네트워크 요청도 하지 않는다 —
// HttpFetch는 전부 fixture 함수로 주입한다. nodeHttpFetch(실제 운용 기본 구현) 자체의
// 파싱/한도 로직만 전역 fetch를 임시로 mock해 검증한다(실제 소켓 통신 없음).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const NOW = new Date("2026-01-01T00:00:00.000Z");
const FRESH_DATE = "2025-12-01T00:00:00.000Z";
const STALE_DATE = "2024-01-01T00:00:00.000Z";

function req(overrides: Partial<CapabilityRequirement> = {}): CapabilityRequirement {
  return { id: "req-1", reason: "테스트용 requirement", ...overrides };
}

function officialConfig(overrides: Partial<SourceAdapterConfig> = {}): SourceAdapterConfig {
  return {
    id: "vendor-official-docs",
    sourceType: "official_vendor_doc",
    maxOfficiality: "official",
    publisher: "Example Vendor",
    allowedHosts: ["vendor.example.com"],
    timeoutMs: 5000,
    maxBodyBytes: 65_536,
    ...overrides,
  };
}

function jsonFetch(status: number, bodyObj: unknown, finalUrl = "https://vendor.example.com/catalog.json"): HttpFetch {
  return async (): Promise<HttpFetchOutcome> => ({ ok: true, response: { status, finalUrl, bodyText: JSON.stringify(bodyObj) } });
}

function failFetch(reason: string): HttpFetch {
  return async () => ({ ok: false, reason });
}

function validCandidatesBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    candidates: [
      {
        candidateId: "official-cand",
        capabilityId: "req-1",
        type: "official_api",
        maintenanceStatus: "actively_maintained",
        lastKnownUpdate: { date: FRESH_DATE },
        requiredPermissions: ["read:data"],
        requiresNetwork: true,
        requiresSecret: false,
        costRisk: "none",
        ...overrides,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1) 정상 official source → evidence 생성(+ D2를 거쳐 실제 RESOLVED까지).
// ---------------------------------------------------------------------------
async function scenarioNormalOfficialSourceProducesEvidence(): Promise<void> {
  const config = officialConfig();
  const fetch = jsonFetch(200, validCandidatesBody());
  const outcome = await fetchEvidenceFromOfficialJsonSource(config, req(), "https://vendor.example.com/catalog.json", fetch, () => NOW);
  check("정상 official source: ok=true", outcome.ok === true);
  if (outcome.ok) {
    check("정상 official source: evidence 1건 생성", outcome.evidence.length === 1);
    check("정상 official source: official이 config.maxOfficiality를 따름", outcome.evidence[0].official === "official");
    check("정상 official source: sourceType이 config를 따름", outcome.evidence[0].sourceType === "official_vendor_doc");
    check("정상 official source: publisher가 config를 따름", outcome.evidence[0].publisher === "Example Vendor");
    check("정상 official source: sourceRef가 실제 응답 URL", outcome.evidence[0].sourceRef === "https://vendor.example.com/catalog.json");
    check("정상 official source: evidenceTimestamp가 주입된 now를 따름", outcome.evidence[0].evidenceTimestamp === NOW.toISOString());
  }

  const source: AsyncEvidenceSource = createAsyncEvidenceSource(config, "https://vendor.example.com/catalog.json", fetch, () => NOW);
  const result = await discoverTrustedCandidatesAsync(req(), source, { now: NOW });
  check("정상 official source: D2를 거쳐 status=RESOLVED", result.status === "RESOLVED");
  check("정상 official source: selected가 official-cand", result.selected?.candidateId === "official-cand");
}

// ---------------------------------------------------------------------------
// 2) malformed response → 선택 금지.
// ---------------------------------------------------------------------------
async function scenarioMalformedResponseBlocksSelection(): Promise<void> {
  const config = officialConfig();
  const badJsonFetch: HttpFetch = async () => ({ ok: true, response: { status: 200, finalUrl: "https://vendor.example.com/x", bodyText: "{ not valid json" } });
  const outcome1 = await fetchEvidenceFromOfficialJsonSource(config, req(), "https://vendor.example.com/x", badJsonFetch, () => NOW);
  check("malformed JSON: ok=false", outcome1.ok === false);

  const wrongShapeFetch = jsonFetch(200, { candidates: [{ candidateId: "x" /* 나머지 필드 누락 */ }] });
  const outcome2 = await fetchEvidenceFromOfficialJsonSource(config, req(), "https://vendor.example.com/x", wrongShapeFetch, () => NOW);
  check("스키마 불일치 응답: ok=false", outcome2.ok === false);

  const emptyArrayFetch = jsonFetch(200, { candidates: [] });
  const outcome3 = await fetchEvidenceFromOfficialJsonSource(config, req(), "https://vendor.example.com/x", emptyArrayFetch, () => NOW);
  check("빈 candidates 배열: ok=false", outcome3.ok === false);

  const source = createAsyncEvidenceSource(config, "https://vendor.example.com/x", badJsonFetch, () => NOW);
  const result = await discoverTrustedCandidatesAsync(req(), source);
  check("malformed response: discoverTrustedCandidatesAsync status=SOURCE_UNAVAILABLE", result.status === "SOURCE_UNAVAILABLE");
  check("malformed response: selected가 설정되지 않음", result.selected === undefined);
}

// ---------------------------------------------------------------------------
// 3) timeout/source failure → 선택 금지.
// ---------------------------------------------------------------------------
async function scenarioTimeoutOrSourceFailureBlocksSelection(): Promise<void> {
  const config = officialConfig();
  const timeoutFetch = failFetch("timeout(5000ms)");
  const outcome = await fetchEvidenceFromOfficialJsonSource(config, req(), "https://vendor.example.com/x", timeoutFetch, () => NOW);
  check("timeout: ok=false", outcome.ok === false);
  check("timeout: reason에 adapter id와 timeout 문구 포함", !outcome.ok && outcome.reason.includes("vendor-official-docs") && outcome.reason.includes("timeout"));

  const source = createAsyncEvidenceSource(config, "https://vendor.example.com/x", timeoutFetch, () => NOW);
  const result = await discoverTrustedCandidatesAsync(req(), source);
  check("timeout: discoverTrustedCandidatesAsync status=SOURCE_UNAVAILABLE", result.status === "SOURCE_UNAVAILABLE");
  check("timeout: selected가 설정되지 않음", result.selected === undefined);
}

// ---------------------------------------------------------------------------
// 4) oversized response 차단(실제 nodeHttpFetch 구현을 전역 fetch mock으로 검증).
// ---------------------------------------------------------------------------
async function scenarioOversizedResponseBlocked(): Promise<void> {
  const originalFetch = globalThis.fetch;
  try {
    const bigChunk = new Uint8Array(1000).fill(65);
    globalThis.fetch = (async () => ({
      type: "default",
      ok: true,
      status: 200,
      url: "https://vendor.example.com/huge.json",
      body: {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: bigChunk };
            },
            async cancel() {},
          };
        },
      },
    })) as unknown as typeof fetch;

    const outcome = await nodeHttpFetch("https://vendor.example.com/huge.json", { timeoutMs: 5000, maxBodyBytes: 100 });
    check("oversized response: nodeHttpFetch가 ok=false를 반환함(잘라서 계속 쓰지 않음)", outcome.ok === false);
    check("oversized response: reason에 한도 초과 문구 포함", !outcome.ok && outcome.reason.includes("초과"));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------
// nodeHttpFetch 자체의 redirect 거부 검증(전역 fetch mock, 실제 네트워크 없음).
// ---------------------------------------------------------------------------
async function scenarioNodeHttpFetchRejectsRedirect(): Promise<void> {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => ({ type: "opaqueredirect" })) as unknown as typeof fetch;
    const outcome = await nodeHttpFetch("https://vendor.example.com/x", { timeoutMs: 5000, maxBodyBytes: 1000 });
    check("nodeHttpFetch: redirect 응답을 자동으로 따라가지 않고 거부함", outcome.ok === false);
    check("nodeHttpFetch: redirect 거부 reason에 redirect 문구 포함", !outcome.ok && outcome.reason.includes("redirect"));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// ---------------------------------------------------------------------------
// 5) 허용되지 않은 URL/source 차단.
// ---------------------------------------------------------------------------
function scenarioUnauthorizedUrlBlocked(): void {
  const allowed = ["vendor.example.com"];
  check("http:// scheme 차단", validateSourceUrl("http://vendor.example.com/x", allowed).ok === false);
  check("허용되지 않은 host 차단", validateSourceUrl("https://evil.example.com/x", allowed).ok === false);
  check("URL에 userinfo가 있으면 차단", validateSourceUrl("https://user:pass@vendor.example.com/x", allowed).ok === false);
  check("정상 https + 허용된 host는 통과", validateSourceUrl("https://vendor.example.com/x", allowed).ok === true);

  // localhost/private/cloud metadata는 설령 allowedHosts에 들어있어도 항상 차단된다(defense in depth).
  const dangerousAllowList = ["localhost", "127.0.0.1", "169.254.169.254", "10.0.0.5", "192.168.1.1", "0.0.0.0"];
  for (const host of dangerousAllowList) {
    check(
      `localhost/private/metadata host(${host})는 allowedHosts에 있어도 차단됨`,
      validateSourceUrl(`https://${host}/x`, dangerousAllowList).ok === false
    );
  }

  // 잘못된 config 자체(허용 목록에 위험 host)는 config 검증 단계에서부터 throw한다.
  let threw = false;
  try {
    validateSourceAdapterConfig(officialConfig({ allowedHosts: ["169.254.169.254"] }));
  } catch {
    threw = true;
  }
  check("SourceAdapterConfig.allowedHosts에 metadata host를 넣으면 validateSourceAdapterConfig가 throw함", threw);

  let threwEmpty = false;
  try {
    validateSourceAdapterConfig(officialConfig({ allowedHosts: [] }));
  } catch {
    threwEmpty = true;
  }
  check("SourceAdapterConfig.allowedHosts가 비어있으면 throw함", threwEmpty);

  let threwTimeout = false;
  try {
    validateSourceAdapterConfig(officialConfig({ timeoutMs: 0 }));
  } catch {
    threwTimeout = true;
  }
  check("SourceAdapterConfig.timeoutMs<=0이면 throw함", threwTimeout);
}

// ---------------------------------------------------------------------------
// 6) stale evidence 처리(adapter가 채운 evidenceTimestamp가 D2 staleness 판정에 실제로 반영됨).
// ---------------------------------------------------------------------------
async function scenarioStaleEvidenceHandledViaAdapter(): Promise<void> {
  const config = officialConfig();
  const fetchTime = new Date("2024-06-01T00:00:00.000Z"); // 실제 fetch가 일어난(오래된) 시각.
  const fetch = jsonFetch(200, validCandidatesBody({ lastKnownUpdate: { date: STALE_DATE } }));
  const source = createAsyncEvidenceSource(config, "https://vendor.example.com/catalog.json", fetch, () => fetchTime);
  const result = await discoverTrustedCandidatesAsync(req(), source, { now: NOW }); // 평가 시점(NOW)은 fetch보다 한참 뒤.
  check("stale evidence: status=HUMAN_REVIEW_REQUIRED(자동 채택 안 함)", result.status === "HUMAN_REVIEW_REQUIRED");
  check(
    "stale evidence: reasons에 stale 문구 포함",
    result.rankedCandidates[0]?.reasons.some((r) => r.includes("오래됨(stale)")) ?? false
  );
}

// ---------------------------------------------------------------------------
// 7) source가 official이라고 거짓 주장해도 자동 신뢰 금지.
// ---------------------------------------------------------------------------
async function scenarioSourceCannotSelfClaimOfficial(): Promise<void> {
  const communityConfig = officialConfig({ id: "community-mirror", maxOfficiality: "community", sourceType: "community_signal" });
  // 응답 바디에 스스로 "official": "official" / "trusted": true 를 끼워 넣어도 스키마 밖
  // 필드라 무시된다.
  const spoofedBody = validCandidatesBody() as Record<string, unknown>;
  (spoofedBody.candidates as Record<string, unknown>[])[0].official = "official";
  (spoofedBody.candidates as Record<string, unknown>[])[0].trusted = true;
  const fetch = jsonFetch(200, spoofedBody);
  const outcome = await fetchEvidenceFromOfficialJsonSource(communityConfig, req(), "https://vendor.example.com/x", fetch, () => NOW);
  check("스스로 official을 주장하는 응답도 파싱 성공(스키마 밖 필드는 무시)", outcome.ok === true);
  if (outcome.ok) {
    check(
      "응답이 official을 자칭해도 evidence.official은 adapter config(community)를 따름",
      outcome.evidence[0].official === "community"
    );
  }
}

// ---------------------------------------------------------------------------
// 8) conflicting evidence 처리(서로 다른 두 adapter를 합쳤을 때).
// ---------------------------------------------------------------------------
async function scenarioConflictingEvidenceAcrossSources(): Promise<void> {
  const officialAdapter = officialConfig({ id: "official-adapter" });
  const communityAdapter = officialConfig({
    id: "community-adapter",
    maxOfficiality: "community",
    sourceType: "community_signal",
    allowedHosts: ["community.example.com"],
  });

  const officialFetch = jsonFetch(200, validCandidatesBody({ requiresSecret: false }), "https://vendor.example.com/a.json");
  const communityFetch = jsonFetch(200, validCandidatesBody({ requiresSecret: true }), "https://community.example.com/a.json");

  const sourceA = createAsyncEvidenceSource(officialAdapter, "https://vendor.example.com/a.json", officialFetch, () => NOW);
  const sourceB = createAsyncEvidenceSource(communityAdapter, "https://community.example.com/a.json", communityFetch, () => NOW);
  const combined = combineAsyncEvidenceSources([sourceA, sourceB]);

  const result = await discoverTrustedCandidatesAsync(req(), combined, { now: NOW });
  check("충돌하는 evidence: status=HUMAN_REVIEW_REQUIRED(다수결로 조용히 처리하지 않음)", result.status === "HUMAN_REVIEW_REQUIRED");
  check("충돌하는 evidence: 최상위 candidate의 conflicts가 비어있지 않음", result.rankedCandidates[0]?.conflicts.length > 0);
}

// ---------------------------------------------------------------------------
// 9) high-risk/secret 후보는 여전히 승인 요구.
// ---------------------------------------------------------------------------
async function scenarioHighRiskSecretCandidateStillRequiresApproval(): Promise<void> {
  const config = officialConfig();
  const secretFetch = jsonFetch(200, validCandidatesBody({ requiresSecret: true }));
  const secretSource = createAsyncEvidenceSource(config, "https://vendor.example.com/x", secretFetch, () => NOW);
  const secretResult = await discoverTrustedCandidatesAsync(req(), secretSource, { now: NOW });
  check("secret 요구 후보: status=HUMAN_REVIEW_REQUIRED(official이어도)", secretResult.status === "HUMAN_REVIEW_REQUIRED");

  const deployFetch = jsonFetch(200, validCandidatesBody({ actionTags: ["deployment"] }));
  const deploySource = createAsyncEvidenceSource(config, "https://vendor.example.com/x", deployFetch, () => NOW);
  const deployResult = await discoverTrustedCandidatesAsync(req(), deploySource, { now: NOW });
  check("Core action tag(deployment) 후보: status=HUMAN_REVIEW_REQUIRED", deployResult.status === "HUMAN_REVIEW_REQUIRED");
}

// ---------------------------------------------------------------------------
// 10) combineAsyncEvidenceSources 부분 실패/전체 실패 처리.
// ---------------------------------------------------------------------------
async function scenarioCombinePartialAndTotalFailure(): Promise<void> {
  const config = officialConfig();
  const workingFetch = jsonFetch(200, validCandidatesBody());
  const workingSource = createAsyncEvidenceSource(config, "https://vendor.example.com/ok.json", workingFetch, () => NOW);
  const failingSource: AsyncEvidenceSource = async () => ({ ok: false, reason: "네트워크 오류(테스트 fixture)" });

  const partial = combineAsyncEvidenceSources([failingSource, workingSource]);
  const partialOutcome = await partial(req());
  check("부분 실패: 성공한 source의 evidence는 그대로 반환됨", partialOutcome.ok === true && partialOutcome.evidence.length === 1);

  const total = combineAsyncEvidenceSources([failingSource, failingSource]);
  const totalOutcome = await total(req());
  check("전체 실패: ok=false(근거 없는 자동 선택 금지)", totalOutcome.ok === false);
}

// ---------------------------------------------------------------------------
// 11) TTL 캐시 — timestamp/만료 기반 재사용, 만료 후 재조회.
// ---------------------------------------------------------------------------
async function scenarioTtlCacheRespectsExpiry(): Promise<void> {
  let callCount = 0;
  const counting: HttpFetch = async () => {
    callCount++;
    const outcome: HttpFetchOutcome = { ok: true, response: { status: 200, finalUrl: "https://vendor.example.com/x", bodyText: "{}" } };
    return outcome;
  };
  let clock = NOW;
  const cached = createTtlCachedHttpFetch(counting, 60_000, () => clock);

  await cached("https://vendor.example.com/x", { timeoutMs: 1000, maxBodyBytes: 1000 });
  await cached("https://vendor.example.com/x", { timeoutMs: 1000, maxBodyBytes: 1000 });
  check("TTL 캐시: 만료 전 재호출은 실제 fetch를 다시 하지 않음", callCount === 1);

  clock = new Date(NOW.getTime() + 61_000);
  await cached("https://vendor.example.com/x", { timeoutMs: 1000, maxBodyBytes: 1000 });
  check("TTL 캐시: 만료 후에는 다시 실제 fetch를 수행함", callCount === 2);
}

async function main(): Promise<void> {
  await scenarioNormalOfficialSourceProducesEvidence();
  await scenarioMalformedResponseBlocksSelection();
  await scenarioTimeoutOrSourceFailureBlocksSelection();
  await scenarioOversizedResponseBlocked();
  await scenarioNodeHttpFetchRejectsRedirect();
  scenarioUnauthorizedUrlBlocked();
  await scenarioStaleEvidenceHandledViaAdapter();
  await scenarioSourceCannotSelfClaimOfficial();
  await scenarioConflictingEvidenceAcrossSources();
  await scenarioHighRiskSecretCandidateStillRequiresApproval();
  await scenarioCombinePartialAndTotalFailure();
  await scenarioTtlCacheRespectsExpiry();

  console.log("\n=== source-adapter 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
