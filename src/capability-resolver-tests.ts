import {
  classifyRequirementDomain,
  evaluateCandidate,
  compareCandidates,
  rankCandidates,
  resolveCapability,
  validateCapabilityResolverPolicy,
  CORE_ALWAYS_HUMAN_APPROVAL_TAGS,
} from "./capability-resolver";
import type { CapabilityCandidate, CapabilityRequirement, CandidateSource, CapabilityResolverPolicy } from "./capability-resolver";

// Capability Discovery & MCP Resolver — Core Design/Foundation 테스트(Phase D Task D1).
// 실제 Claude/GPT 유료 API를 전혀 호출하지 않고, MOVAN product task도 실행하지 않으며,
// 실제 외부 MCP/네트워크 조회도 하지 않는다 — CandidateSource는 전부 fixture 함수로
// 주입한다(순수 함수 + 주입형 seam만 테스트).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function req(overrides: Partial<CapabilityRequirement> = {}): CapabilityRequirement {
  return { id: "req-1", reason: "테스트용 requirement", ...overrides };
}

function candidate(overrides: Partial<CapabilityCandidate> = {}): CapabilityCandidate {
  return {
    id: "cand-1",
    capabilityId: "req-1",
    type: "mcp_server",
    provider: "Example Provider",
    official: "official",
    permissions: [],
    requiresNetwork: false,
    requiresSecret: false,
    costRisk: "none",
    actionTags: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1) 일반 capability 요구사항 분류.
// ---------------------------------------------------------------------------
function scenarioClassifyRequirementDomain(): void {
  check("domain 분류: database 키워드 → database", classifyRequirementDomain("Supabase DB에 접근해야 함") === "database");
  check(
    "domain 분류: payment/financial 키워드 → payment_or_financial",
    classifyRequirementDomain("실시간 주식 trading API 연동") === "payment_or_financial"
  );
  check("domain 분류: deploy 키워드 → deployment", classifyRequirementDomain("production으로 자동 deploy") === "deployment");
  check("domain 분류: slack 키워드 → communication", classifyRequirementDomain("Slack으로 알림 전송") === "communication");
  check("domain 분류: s3 키워드 → storage", classifyRequirementDomain("S3 bucket에 파일 업로드") === "storage");
  check("domain 분류: playwright 키워드 → browser_automation", classifyRequirementDomain("playwright로 브라우저 자동화") === "browser_automation");
  check("domain 분류: anthropic 키워드 → ai_model", classifyRequirementDomain("Anthropic Claude API 연동") === "ai_model");
  check("domain 분류: 매칭 안 되면 general", classifyRequirementDomain("아무 의미 없는 문자열 abcxyz") === "general");
}

// ---------------------------------------------------------------------------
// 2) 공식 후보 우선.
// ---------------------------------------------------------------------------
function scenarioOfficialCandidatesRankedFirst(): void {
  const official = candidate({ id: "official-cand", official: "official" });
  const community = candidate({ id: "community-cand", official: "community" });
  const unknown = candidate({ id: "unknown-cand", official: "unknown" });
  const ranked = rankCandidates([unknown, community, official]);
  check("공식 후보 우선: 정렬 결과 1순위가 official", ranked[0].candidate.id === "official-cand");
  check("공식 후보 우선: 2순위가 community", ranked[1].candidate.id === "community-cand");
  check("공식 후보 우선: 3순위가 unknown", ranked[2].candidate.id === "unknown-cand");
}

// ---------------------------------------------------------------------------
// 3) 비공식 후보의 낮은 신뢰도.
// ---------------------------------------------------------------------------
function scenarioUnofficialCandidatesLowerTrust(): void {
  const officialEval = evaluateCandidate(candidate({ official: "official" }));
  const communityEval = evaluateCandidate(candidate({ official: "community" }));
  const unknownEval = evaluateCandidate(candidate({ official: "unknown" }));
  check("비공식 후보: official은 riskLevel=low", officialEval.riskLevel === "low");
  check("비공식 후보: community는 riskLevel이 official보다 높음(medium)", communityEval.riskLevel === "medium");
  check("비공식 후보: unknown은 community보다도 riskLevel이 더 높음(high)", unknownEval.riskLevel === "high");
  check(
    "비공식 후보: community reasons에 '신뢰도가 낮음' 문구 포함",
    communityEval.reasons.some((r) => r.includes("신뢰도가 낮음"))
  );
  check(
    "비공식 후보: unknown reasons에 '신뢰도가 매우 낮음' 문구 포함",
    unknownEval.reasons.some((r) => r.includes("신뢰도가 매우 낮음"))
  );
}

// ---------------------------------------------------------------------------
// 4) secret 요구 후보 분류 — 항상 HUMAN_APPROVAL_REQUIRED.
// ---------------------------------------------------------------------------
function scenarioSecretRequiringCandidateAlwaysNeedsApproval(): void {
  const evalResult = evaluateCandidate(candidate({ official: "official", requiresSecret: true }));
  check("secret 요구 후보: approval=HUMAN_APPROVAL_REQUIRED(official이어도)", evalResult.approval === "HUMAN_APPROVAL_REQUIRED");
  check("secret 요구 후보: riskLevel=critical", evalResult.riskLevel === "critical");
  check("secret 요구 후보: reasons에 secret/credential 문구 포함", evalResult.reasons.some((r) => r.includes("secret/credential")));

  const noSecretEval = evaluateCandidate(candidate({ official: "official", requiresSecret: false }));
  check("secret 불필요 후보: approval=AUTO_ALLOWED(다른 위험 없을 때)", noSecretEval.approval === "AUTO_ALLOWED");
}

// ---------------------------------------------------------------------------
// 5) prod write/deploy 등 Core action tag 후보 → HUMAN_APPROVAL_REQUIRED.
// ---------------------------------------------------------------------------
function scenarioCoreActionTagsAlwaysNeedApproval(): void {
  for (const tag of CORE_ALWAYS_HUMAN_APPROVAL_TAGS) {
    const evalResult = evaluateCandidate(candidate({ official: "official", requiresSecret: false, actionTags: [tag] }));
    check(`Core action tag(${tag}): approval=HUMAN_APPROVAL_REQUIRED`, evalResult.approval === "HUMAN_APPROVAL_REQUIRED");
    check(`Core action tag(${tag}): riskLevel=critical`, evalResult.riskLevel === "critical");
  }
  const readOnlyEval = evaluateCandidate(candidate({ official: "official", actionTags: ["read_only"] }));
  check("read_only tag는 Core action tag가 아니므로 approval=AUTO_ALLOWED", readOnlyEval.approval === "AUTO_ALLOWED");
}

// ---------------------------------------------------------------------------
// 6) 대안 비교(compareCandidates/rankCandidates).
// ---------------------------------------------------------------------------
function scenarioAlternativeComparison(): void {
  const lowRisk = candidate({ id: "low-risk", official: "official", costRisk: "none" });
  const mediumRisk = candidate({ id: "medium-risk", official: "official", costRisk: "certain" });
  const needsApproval = candidate({ id: "needs-approval", official: "official", actionTags: ["deployment"] });
  const ranked = rankCandidates([needsApproval, mediumRisk, lowRisk]);
  check("대안 비교: 위험도가 낮은 후보가 먼저 옴", ranked[0].candidate.id === "low-risk");
  check("대안 비교: 승인 필요 후보가 마지막에 옴", ranked[2].candidate.id === "needs-approval");
  check(
    "대안 비교: compareCandidates(a,b)와 compareCandidates(b,a)가 부호만 반대(일관성)",
    compareCandidates(ranked[0], ranked[1]) === -compareCandidates(ranked[1], ranked[0])
  );

  // 완전 동률인 두 후보는 id 사전순으로 deterministic 정렬된다.
  const tie1 = candidate({ id: "b-tie" });
  const tie2 = candidate({ id: "a-tie" });
  const tieRanked = rankCandidates([tie1, tie2]);
  check("대안 비교: 완전 동률이면 id 사전순으로 deterministic 정렬", tieRanked[0].candidate.id === "a-tie");
}

// ---------------------------------------------------------------------------
// 7) project rule로 Core risk 완화 불가.
// ---------------------------------------------------------------------------
function scenarioProjectPolicyCannotWeakenCoreRisk(): void {
  // (a) policy는 Core 목록에 추가만 할 수 있고, 이미 requiresSecret/Core action tag가
  //     강제하는 HUMAN_APPROVAL_REQUIRED를 약화시킬 방법이 없다 — 그런 필드 자체가 타입에
  //     없으므로, 가짜 '완화' 필드를 억지로 끼워 넣어도(as any) 런타임이 읽지 않는다.
  const bypassPolicy = {
    additionalAlwaysHumanApprovalTags: [],
    disableSecretApprovalRequirement: true,
    allowAutoApproveProductionWrites: true,
    coreOverride: "ALWAYS_ALLOW",
  };
  const secretEval = evaluateCandidate(
    candidate({ official: "official", requiresSecret: true }),
    bypassPolicy as unknown as CapabilityResolverPolicy
  );
  check("가짜 '완화' 필드를 policy에 넣어도 secret 후보는 여전히 HUMAN_APPROVAL_REQUIRED", secretEval.approval === "HUMAN_APPROVAL_REQUIRED");

  const deployEval = evaluateCandidate(
    candidate({ official: "official", actionTags: ["deployment"] }),
    bypassPolicy as unknown as CapabilityResolverPolicy
  );
  check(
    "가짜 '완화' 필드를 policy에 넣어도 deployment 후보는 여전히 HUMAN_APPROVAL_REQUIRED",
    deployEval.approval === "HUMAN_APPROVAL_REQUIRED"
  );

  // (b) policy는 오직 "추가"만 가능하다 — additionalAlwaysHumanApprovalTags로 새 제한을
  //     더하면 실제로 적용된다(완화가 아니라 강화만 가능함을 대조 검증).
  const readOnlyBaseline = evaluateCandidate(candidate({ official: "official", actionTags: ["read_only"] }));
  check("read_only 후보는 기본적으로 AUTO_ALLOWED", readOnlyBaseline.approval === "AUTO_ALLOWED");
  const readOnlyWithAddedRestriction = evaluateCandidate(
    candidate({ official: "official", actionTags: ["read_only"] }),
    { additionalAlwaysHumanApprovalTags: ["read_only"] }
  );
  check(
    "policy.additionalAlwaysHumanApprovalTags는 실제로 제한을 '추가'할 수 있음(완화가 아니라 강화)",
    readOnlyWithAddedRestriction.approval === "HUMAN_APPROVAL_REQUIRED"
  );

  // (c) 잘못된 policy(알려지지 않은 tag 등)는 조용히 무시되지 않고 즉시 throw한다.
  let threw = false;
  try {
    validateCapabilityResolverPolicy({ additionalAlwaysHumanApprovalTags: ["not-a-real-tag" as never] });
  } catch {
    threw = true;
  }
  check("알려지지 않은 action tag를 policy에 넣으면 validateCapabilityResolverPolicy가 throw함", threw);
}

// ---------------------------------------------------------------------------
// 8) 외부 조회 실패 시 근거 없이 자동선택 금지.
// ---------------------------------------------------------------------------
function scenarioSourceUnavailableDoesNotAutoSelect(): void {
  const failingSource: CandidateSource = () => ({ ok: false, reason: "네트워크 timeout(테스트 fixture)" });
  const resolution = resolveCapability(req(), failingSource);
  check("source 조회 실패: status=SOURCE_UNAVAILABLE", resolution.status === "SOURCE_UNAVAILABLE");
  check("source 조회 실패: selected가 설정되지 않음(근거 없이 자동선택 금지)", resolution.selected === undefined);
  check("source 조회 실패: rankedCandidates가 비어있음", resolution.rankedCandidates.length === 0);

  const emptySource: CandidateSource = () => ({ ok: true, candidates: [] });
  const emptyResolution = resolveCapability(req(), emptySource);
  check("candidate 없음: status=NO_CANDIDATES_FOUND", emptyResolution.status === "NO_CANDIDATES_FOUND");
  check("candidate 없음: selected가 설정되지 않음", emptyResolution.selected === undefined);
}

// ---------------------------------------------------------------------------
// 9) 정상 흐름 — candidate가 있으면 평가/랭킹 후 적절히 RESOLVED/HUMAN_APPROVAL_REQUIRED.
// ---------------------------------------------------------------------------
function scenarioResolveCapabilityHappyPathAndApprovalPath(): void {
  const okSource: CandidateSource = () => ({
    ok: true,
    candidates: [
      candidate({ id: "official-safe", official: "official", actionTags: ["read_only"] }),
      candidate({ id: "community-alt", official: "community" }),
    ],
  });
  const resolution = resolveCapability(req(), okSource);
  check("정상 흐름: status=RESOLVED", resolution.status === "RESOLVED");
  check("정상 흐름: selected가 1순위(official) candidate", resolution.selected?.id === "official-safe");
  check("정상 흐름: rankedCandidates에 2개 모두 포함", resolution.rankedCandidates.length === 2);

  const approvalSource: CandidateSource = () => ({
    ok: true,
    candidates: [candidate({ id: "needs-secret", official: "official", requiresSecret: true })],
  });
  const approvalResolution = resolveCapability(req(), approvalSource);
  check("승인 필요 흐름: status=HUMAN_APPROVAL_REQUIRED", approvalResolution.status === "HUMAN_APPROVAL_REQUIRED");
  check("승인 필요 흐름: selected가 설정되지 않음(사람 승인 전 자동 선택 금지)", approvalResolution.selected === undefined);
}

function main(): void {
  scenarioClassifyRequirementDomain();
  scenarioOfficialCandidatesRankedFirst();
  scenarioUnofficialCandidatesLowerTrust();
  scenarioSecretRequiringCandidateAlwaysNeedsApproval();
  scenarioCoreActionTagsAlwaysNeedApproval();
  scenarioAlternativeComparison();
  scenarioProjectPolicyCannotWeakenCoreRisk();
  scenarioSourceUnavailableDoesNotAutoSelect();
  scenarioResolveCapabilityHappyPathAndApprovalPath();

  console.log("\n=== capability-resolver 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
