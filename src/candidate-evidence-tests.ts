import {
  evaluateEvidence,
  evaluateTrustedCandidate,
  detectEvidenceConflicts,
  rankEvidence,
  compareEvidence,
  compareTrustedCandidates,
  discoverTrustedCandidates,
  toCandidateSource,
  toCapabilityCandidate,
  validateTrustedDiscoveryPolicy,
} from "./candidate-evidence";
import type { CandidateEvidence, EvidenceSource, TrustedDiscoveryPolicy } from "./candidate-evidence";
import { resolveCapability } from "./capability-resolver";
import type { CapabilityRequirement } from "./capability-resolver";

// Trusted Candidate Discovery & Evidence 테스트(Phase D Task D2). 실제 Claude/GPT 유료
// API를 호출하지 않고, MOVAN product task도 실행하지 않으며, 실제 외부 조회/네트워크도
// 하지 않는다 — EvidenceSource는 전부 fixture 함수로 주입하고, 시각은 항상 고정된 `now`를
// 넘겨 deterministic하게 검증한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const NOW = new Date("2026-01-01T00:00:00.000Z");
const FRESH_TIMESTAMP = "2025-12-01T00:00:00.000Z"; // NOW 기준 약 31일 전 — stale 아님.
const STALE_TIMESTAMP = "2024-01-01T00:00:00.000Z"; // NOW 기준 약 2년 전 — stale.

function req(overrides: Partial<CapabilityRequirement> = {}): CapabilityRequirement {
  return { id: "req-1", reason: "테스트용 requirement", ...overrides };
}

function evidence(overrides: Partial<CandidateEvidence> = {}): CandidateEvidence {
  return {
    candidateId: "cand-1",
    capabilityId: "req-1",
    type: "mcp_server",
    sourceType: "official_vendor_doc",
    sourceRef: "https://example.com/official-docs",
    official: "official",
    publisher: "Example Vendor",
    maintenanceStatus: "actively_maintained",
    lastKnownUpdate: { date: FRESH_TIMESTAMP },
    requiredPermissions: [],
    requiresNetwork: false,
    requiresSecret: false,
    costRisk: "none",
    evidenceTimestamp: FRESH_TIMESTAMP,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1) official candidate 우선.
// ---------------------------------------------------------------------------
function scenarioOfficialCandidatePreferred(): void {
  const officialEv = evidence({ candidateId: "official-cand", official: "official", sourceType: "official_vendor_doc" });
  const communityEv = evidence({ candidateId: "community-cand", official: "community", sourceType: "community_signal" });
  const source: EvidenceSource = () => ({ ok: true, evidence: [communityEv, officialEv] });
  const result = discoverTrustedCandidates(req(), source, { now: NOW });
  check("official candidate 우선: 1순위가 official-cand", result.rankedCandidates[0].candidateId === "official-cand");
  check("official candidate 우선: status=RESOLVED(official evidence가 SUFFICIENT)", result.status === "RESOLVED");
  check("official candidate 우선: selected가 official-cand", result.selected?.candidateId === "official-cand");
}

// ---------------------------------------------------------------------------
// 2) unofficial-only → 자동선택 금지 또는 명확한 review 판정.
// ---------------------------------------------------------------------------
function scenarioUnofficialOnlyBlocksAutoSelection(): void {
  const communityOnly = evidence({ official: "community", sourceType: "community_signal" });
  const evalResult = evaluateEvidence(communityOnly, { now: NOW });
  check("비공식만 존재: confidence=UNKNOWN(SUFFICIENT 아님)", evalResult.confidence === "UNKNOWN");

  const source: EvidenceSource = () => ({ ok: true, evidence: [communityOnly] });
  const result = discoverTrustedCandidates(req(), source, { now: NOW });
  check("비공식만 존재: status=HUMAN_REVIEW_REQUIRED(자동 채택 안 함)", result.status === "HUMAN_REVIEW_REQUIRED");
  check("비공식만 존재: selected가 설정되지 않음", result.selected === undefined);
}

// ---------------------------------------------------------------------------
// 3) source 실패 → 근거 없는 선택 금지(+ candidate 없음 케이스도 함께).
// ---------------------------------------------------------------------------
function scenarioSourceFailureBlocksSelection(): void {
  const failingSource: EvidenceSource = () => ({ ok: false, reason: "네트워크 timeout(테스트 fixture)" });
  const result = discoverTrustedCandidates(req(), failingSource);
  check("evidence source 실패: status=SOURCE_UNAVAILABLE", result.status === "SOURCE_UNAVAILABLE");
  check("evidence source 실패: selected가 설정되지 않음", result.selected === undefined);
  check("evidence source 실패: rankedCandidates가 비어있음", result.rankedCandidates.length === 0);

  const emptySource: EvidenceSource = () => ({ ok: true, evidence: [] });
  const emptyResult = discoverTrustedCandidates(req(), emptySource);
  check("evidence 없음: status=NO_EVIDENCE_FOUND", emptyResult.status === "NO_EVIDENCE_FOUND");
  check("evidence 없음: selected가 설정되지 않음", emptyResult.selected === undefined);
}

// ---------------------------------------------------------------------------
// 4) stale evidence 표시.
// ---------------------------------------------------------------------------
function scenarioStaleEvidenceFlagged(): void {
  const fresh = evidence({ lastKnownUpdate: { date: FRESH_TIMESTAMP }, evidenceTimestamp: FRESH_TIMESTAMP });
  const stale = evidence({ lastKnownUpdate: { date: STALE_TIMESTAMP }, evidenceTimestamp: STALE_TIMESTAMP });

  const freshEval = evaluateEvidence(fresh, { now: NOW });
  const staleEval = evaluateEvidence(stale, { now: NOW });
  check("최신 evidence: stale=false", freshEval.stale === false);
  check("오래된 evidence: stale=true", staleEval.stale === true);
  check("오래된 evidence: confidence가 SUFFICIENT가 아님(과소평가 없음)", staleEval.confidence !== "SUFFICIENT");
  check("오래된 evidence: reasons에 stale 문구 포함", staleEval.reasons.some((r) => r.includes("오래됨(stale)")));

  // lastKnownUpdate가 없으면 evidenceTimestamp를 기준으로 판정한다.
  const noLastKnownUpdate = evidence({ lastKnownUpdate: undefined, evidenceTimestamp: STALE_TIMESTAMP });
  check(
    "lastKnownUpdate 없을 때 evidenceTimestamp로 staleness 판정",
    evaluateEvidence(noLastKnownUpdate, { now: NOW }).stale === true
  );

  // 파싱 불가능한 날짜는 신뢰하지 못하므로 stale로 간주한다(추측 금지).
  const badDate = evidence({ lastKnownUpdate: { date: "not-a-date" } });
  check("파싱 불가능한 날짜는 stale로 간주됨(추측 금지)", evaluateEvidence(badDate, { now: NOW }).stale === true);
}

// ---------------------------------------------------------------------------
// 5) conflicting evidence 처리.
// ---------------------------------------------------------------------------
function scenarioConflictingEvidenceHandled(): void {
  const sourceA = evidence({ sourceRef: "https://vendor.example.com/docs", official: "official", requiresSecret: false });
  const sourceB = evidence({ sourceRef: "https://community.example.com/post", official: "community", requiresSecret: true });
  const conflicts = detectEvidenceConflicts([sourceA, sourceB]);
  check("충돌 탐지: official 필드 충돌 발견", conflicts.some((c) => c.field === "official"));
  check("충돌 탐지: requiresSecret 필드 충돌 발견", conflicts.some((c) => c.field === "requiresSecret"));

  const trusted = evaluateTrustedCandidate([sourceA, sourceB], { now: NOW });
  check("충돌 있는 candidate: confidence=HUMAN_REVIEW_REQUIRED(다수결로 조용히 처리하지 않음)", trusted.confidence === "HUMAN_REVIEW_REQUIRED");
  check("충돌 있는 candidate: conflicts 필드가 비어있지 않음", trusted.conflicts.length > 0);

  const source: EvidenceSource = () => ({ ok: true, evidence: [sourceA, sourceB] });
  const result = discoverTrustedCandidates(req(), source, { now: NOW });
  check("충돌 있는 candidate: discoverTrustedCandidates status=HUMAN_REVIEW_REQUIRED", result.status === "HUMAN_REVIEW_REQUIRED");
  check("충돌 있는 candidate: selected가 설정되지 않음", result.selected === undefined);

  // 값이 동일한 evidence 두 개는 충돌이 아니다(과잉 차단 없음).
  const identicalA = evidence({ sourceRef: "https://vendor.example.com/docs-1" });
  const identicalB = evidence({ sourceRef: "https://vendor.example.com/docs-2" });
  check("완전히 동일한 값의 evidence 두 개는 충돌 없음", detectEvidenceConflicts([identicalA, identicalB]).length === 0);
}

// ---------------------------------------------------------------------------
// 6) secret/high-risk candidate 승인 요구.
// ---------------------------------------------------------------------------
function scenarioSecretOrHighRiskRequiresApproval(): void {
  const secretEv = evidence({ official: "official", requiresSecret: true });
  const secretEval = evaluateEvidence(secretEv, { now: NOW });
  check("secret 요구 evidence: confidence=HUMAN_REVIEW_REQUIRED(official이어도)", secretEval.confidence === "HUMAN_REVIEW_REQUIRED");

  const deployEv = evidence({ official: "official", actionTags: ["deployment"] });
  const deployEval = evaluateEvidence(deployEv, { now: NOW });
  check("Core action tag(deployment) evidence: confidence=HUMAN_REVIEW_REQUIRED", deployEval.confidence === "HUMAN_REVIEW_REQUIRED");

  const readOnlyEv = evidence({ official: "official", actionTags: ["read_only"] });
  check("read_only tag는 Core action tag가 아니므로 confidence=SUFFICIENT 가능", evaluateEvidence(readOnlyEv, { now: NOW }).confidence === "SUFFICIENT");
}

// ---------------------------------------------------------------------------
// 7) project rule로 trust/risk 완화 불가.
// ---------------------------------------------------------------------------
function scenarioProjectPolicyCannotWeakenTrust(): void {
  const bypassPolicy = {
    additionalAlwaysHumanApprovalTags: [],
    disableSecretApprovalRequirement: true,
    allowStaleEvidence: true,
    coreOverride: "ALWAYS_TRUST",
  };
  const secretEval = evaluateEvidence(evidence({ requiresSecret: true }), {
    now: NOW,
    policy: bypassPolicy as unknown as TrustedDiscoveryPolicy,
  });
  check("가짜 '완화' 필드를 policy에 넣어도 secret evidence는 여전히 HUMAN_REVIEW_REQUIRED", secretEval.confidence === "HUMAN_REVIEW_REQUIRED");

  // policy는 staleness 기준을 "완화"(늘리기)할 수 없다 — Core 기본값(180일)보다 큰 값은
  // 무시되고 Core 기본값이 그대로 적용된다.
  const stale = evidence({ lastKnownUpdate: { date: STALE_TIMESTAMP } });
  const withLoosenedPolicy = evaluateEvidence(stale, { now: NOW, policy: { maxStaleAfterDays: 10_000 } });
  check(
    "maxStaleAfterDays를 크게 줘도 staleness 완화 불가(Core 기본값 유지)",
    withLoosenedPolicy.stale === true
  );

  // policy는 staleness 기준을 "강화"(줄이기)할 수는 있다 — FRESH_TIMESTAMP(약 31일 전)도
  // maxStaleAfterDays:10으로 좁히면 stale로 판정돼야 한다.
  const fresh = evidence({ lastKnownUpdate: { date: FRESH_TIMESTAMP } });
  const withTightenedPolicy = evaluateEvidence(fresh, { now: NOW, policy: { maxStaleAfterDays: 10 } });
  check("policy.maxStaleAfterDays는 실제로 기준을 '강화'할 수 있음(완화가 아니라 강화)", withTightenedPolicy.stale === true);

  let threw = false;
  try {
    validateTrustedDiscoveryPolicy({ additionalAlwaysHumanApprovalTags: ["not-a-real-tag"] as never });
  } catch {
    threw = true;
  }
  check("알려지지 않은 action tag를 policy에 넣으면 validateTrustedDiscoveryPolicy가 throw함", threw);

  let threwNegative = false;
  try {
    validateTrustedDiscoveryPolicy({ maxStaleAfterDays: -5 });
  } catch {
    threwNegative = true;
  }
  check("maxStaleAfterDays에 0 이하 값을 넣으면 validateTrustedDiscoveryPolicy가 throw함", threwNegative);
}

// ---------------------------------------------------------------------------
// 8) deterministic ranking 유지.
// ---------------------------------------------------------------------------
function scenarioDeterministicRanking(): void {
  const a = evidence({ candidateId: "cand-a", sourceRef: "https://a.example.com" });
  const b = evidence({ candidateId: "cand-b", sourceRef: "https://b.example.com" });
  const ranked1 = rankEvidence([b, a], { now: NOW });
  const ranked2 = rankEvidence([a, b], { now: NOW });
  check(
    "deterministic ranking: 입력 순서와 무관하게 동일한 결과",
    ranked1.map((r) => r.evidence.sourceRef).join(",") === ranked2.map((r) => r.evidence.sourceRef).join(",")
  );
  check(
    "deterministic ranking: compareEvidence 대칭성(a,b)==-(b,a)",
    compareEvidence(ranked1[0], ranked1[1]) === -compareEvidence(ranked1[1], ranked1[0])
  );

  const evalA = evaluateTrustedCandidate([a], { now: NOW });
  const evalB = evaluateTrustedCandidate([b], { now: NOW });
  check(
    "deterministic ranking: compareTrustedCandidates 대칭성",
    compareTrustedCandidates(evalA, evalB) === -compareTrustedCandidates(evalB, evalA)
  );

  const source: EvidenceSource = () => ({ ok: true, evidence: [b, a] });
  const result1 = discoverTrustedCandidates(req(), source, { now: NOW });
  const result2 = discoverTrustedCandidates(req(), source, { now: NOW });
  check(
    "deterministic ranking: discoverTrustedCandidates를 두 번 호출해도 동일한 selected",
    result1.selected?.candidateId === result2.selected?.candidateId
  );
}

// ---------------------------------------------------------------------------
// 9) D1 통합 — toCandidateSource 어댑터로 capability-resolver.ts의 resolveCapability를
//    그대로 소비할 수 있음(D1 소스는 수정하지 않음).
// ---------------------------------------------------------------------------
function scenarioD1IntegrationViaCandidateSourceAdapter(): void {
  const sufficientEv = evidence({ candidateId: "sufficient-cand", official: "official" });
  const insufficientEv = evidence({ candidateId: "insufficient-cand", official: "community", sourceType: "community_signal" });
  const source: EvidenceSource = () => ({ ok: true, evidence: [sufficientEv, insufficientEv] });

  const candidateSource = toCandidateSource(source, { now: NOW });
  const d1Result = resolveCapability(req(), candidateSource);
  check("D1 통합: SUFFICIENT evidence만 D1 candidate로 승격됨(1개만)", d1Result.rankedCandidates.length === 1);
  check("D1 통합: D1 resolveCapability가 status=RESOLVED로 판정", d1Result.status === "RESOLVED");
  check("D1 통합: D1이 선택한 candidate.id가 sufficient-cand", d1Result.selected?.id === "sufficient-cand");

  const allInsufficientSource: EvidenceSource = () => ({ ok: true, evidence: [insufficientEv] });
  const noneResolved = resolveCapability(req(), toCandidateSource(allInsufficientSource, { now: NOW }));
  check("D1 통합: 전부 근거 부족이면 D1으로 넘어가는 candidate가 0개", noneResolved.status === "NO_CANDIDATES_FOUND");

  const converted = toCapabilityCandidate(sufficientEv);
  check("toCapabilityCandidate: id/capabilityId/provider가 evidence에서 정확히 매핑됨", converted.id === "sufficient-cand" && converted.capabilityId === "req-1" && converted.provider === "Example Vendor");
}

// ---------------------------------------------------------------------------
// 10) 빈 evidence 목록으로 evaluateTrustedCandidate를 호출하면 추측하지 않고 즉시 실패.
// ---------------------------------------------------------------------------
function scenarioEmptyEvidenceListRejected(): void {
  let threw = false;
  try {
    evaluateTrustedCandidate([]);
  } catch {
    threw = true;
  }
  check("evaluateTrustedCandidate([])는 추측으로 결과를 만들지 않고 throw함", threw);
}

function main(): void {
  scenarioOfficialCandidatePreferred();
  scenarioUnofficialOnlyBlocksAutoSelection();
  scenarioSourceFailureBlocksSelection();
  scenarioStaleEvidenceFlagged();
  scenarioConflictingEvidenceHandled();
  scenarioSecretOrHighRiskRequiresApproval();
  scenarioProjectPolicyCannotWeakenTrust();
  scenarioDeterministicRanking();
  scenarioD1IntegrationViaCandidateSourceAdapter();
  scenarioEmptyEvidenceListRejected();

  console.log("\n=== candidate-evidence 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
