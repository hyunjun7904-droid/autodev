// Capability Discovery & MCP Resolver — Core Design/Foundation(Phase D Task D1).
//
// 새 프로젝트의 manifest/task/기술스택/요구사항에서 나온 "외부 Capability가 필요하다"는
// 사실을, MCP 서버/공식 API/SDK/CLI 등 구체적인 구현 후보(candidate)로 구조화하고,
// deterministic 규칙만으로 위험등급/승인 필요 여부를 판정하는 기반이다. AI(Claude/GPT)
// 판단에 의존하지 않는다 — 이 모듈은 LLM을 호출하지 않고, 어떤 LLM 출력도 신뢰 입력으로
// 받지 않는다.
//
// 이번 D1 범위는 "Core Design/Foundation"이다 — 실제 외부 MCP 설치/다운로드/실행, Browser
// Worker, Agent Router, Dashboard는 이 Task에서 시작하지 않는다. 이 파일은 데이터 모델 +
// candidate 평가/랭킹 + risk/approval 판정 + deterministic하게 테스트 가능한 Core seam
// (CandidateSource — dependency-scanner.ts의 VulnerabilityAuditSource와 동일한 설계
// 원칙: 실제 운용 구현은 외부 조회를 쓸 수 있지만, 이 모듈 자체와 테스트는 그 구현을 몰라도
// 되도록 주입형 함수로 분리한다)만 제공한다.
//
// Safe Executor(무엇을 읽고/쓰고/실행할 수 있는지) / Secret Scanner(commit 내용 검사) /
// Core Command Safety Gate(명령 실행 자체의 안전) / Dependency Scanner(공급망 위험)와
// 책임을 분리한다 — 이 모듈은 그 앞단, 즉 "어떤 외부 capability를 어떤 수단으로 쓸지"를
// 구조화하고 승인 필요 여부를 판정할 뿐, 실제로 무언가를 설치/실행/커밋하지 않는다(그 네
// 게이트를 우회하지도, 대체하지도 않는다).

// =========================================================
// Discovery — Capability 요구사항.
// =========================================================

/** 요구사항 설명(자유 텍스트)에서 대략적인 domain을 추정한다 — 순수 키워드 기반
 *  deterministic 분류이며 approval 판정에는 쓰지 않는다(승인 판정은 오직 candidate의
 *  구조화된 필드(actionTags/requiresSecret 등)만 근거로 삼는다 — 자유 텍스트 추정으로
 *  보안 판정을 내리지 않는다는 설계 원칙). candidate 탐색/후보 매칭을 돕는 참고 정보일
 *  뿐이다. */
export type CapabilityDomain =
  | "database"
  | "payment_or_financial"
  | "deployment"
  | "communication"
  | "storage"
  | "browser_automation"
  | "ai_model"
  | "general";

export function classifyRequirementDomain(description: string): CapabilityDomain {
  const text = description.toLowerCase();
  if (/(payment|결제|송금|trading|매매|brokerage|증권|financial|금융|invest)/i.test(text)) return "payment_or_financial";
  if (/(deploy|배포|release|ci\/cd|production\s*(release|rollout))/i.test(text)) return "deployment";
  if (/(database|\bdb\b|postgres|mysql|supabase|디비|데이터베이스|sql)/i.test(text)) return "database";
  if (/(slack|email|메일|notification|알림|sms|메시지|discord)/i.test(text)) return "communication";
  if (/(s3|storage|저장소|bucket|file\s*upload|파일\s*업로드)/i.test(text)) return "storage";
  if (/(browser|puppeteer|playwright|scrape|크롤|headless)/i.test(text)) return "browser_automation";
  if (/(llm|gpt|claude|anthropic|openai|language model)/i.test(text)) return "ai_model";
  return "general";
}

export interface CapabilityRequirement {
  /** 이 requirement를 가리키는 고유 식별자(예: "movan-db-access"). */
  id: string;
  /** 사람이 읽는 요구사항 설명 — classifyRequirementDomain()의 입력이자, 후보 평가 결과의
   *  reason 문자열에도 그대로 인용된다. */
  reason: string;
}

// =========================================================
// Resolver — Candidate 데이터 모델.
// =========================================================

export type CapabilityType = "mcp_server" | "official_api" | "sdk" | "cli" | "other";

/** 공식 여부 — candidate.provider가 그 capability의 공식 벤더/메인테이너인지. "unknown"은
 *  "확인하지 못했다"는 뜻이며 "community"(비공식이지만 출처는 확인됨)보다 신뢰도가 더
 *  낮게 취급된다(§ evaluateCandidate). */
export type SourceOfficiality = "official" | "community" | "unknown";

/** Core가 항상 사람 승인을 요구하는 action 범주(요구사항 "자동 활성화 금지 대상") —
 *  candidate.actionTags에 이 중 하나라도 있으면 evaluateCandidate()가 무조건
 *  HUMAN_APPROVAL_REQUIRED로 판정한다. requiresSecret(별도 boolean 필드)도 이 목록과
 *  무관하게 항상 같은 효과를 낸다(§ 아래 evaluateCandidate). */
export type ActionTag =
  | "production_db_write"
  | "deployment"
  | "live_trading_or_brokerage"
  | "payment_or_financial_transaction"
  | "high_risk_external_action"
  | "read_only";

export type CostRisk = "none" | "possible" | "certain";

export interface CapabilityCandidate {
  /** 이 candidate 자체의 고유 id(예: "supabase-mcp-official"). */
  id: string;
  /** 이 candidate가 충족하려는 CapabilityRequirement.id. */
  capabilityId: string;
  type: CapabilityType;
  /** provider/source — 사람이 읽는 이름(예: "Anthropic", "Supabase", "community/foo"). */
  provider: string;
  sourceUrl?: string;
  official: SourceOfficiality;
  /** 이 candidate가 요구하는 permission(자유 문자열, 예: "read:database", "write:filesystem"). */
  permissions: string[];
  requiresNetwork: boolean;
  requiresSecret: boolean;
  costRisk: CostRisk;
  /** Core ALWAYS_HUMAN_APPROVAL_ACTION_TAGS 판정에 쓰이는 구조화된 action 분류 — 자유
   *  텍스트가 아니라 이 배열만이 승인 판정의 근거가 된다. */
  actionTags: ActionTag[];
  /** 같은 requirement에 대한 다른 candidate.id 목록(참고용, 순수 메타데이터). */
  alternatives?: string[];
  notes?: string;
}

// =========================================================
// Project Policy — Core risk를 완화할 수 없다(project-policy.ts와 동일한 설계 원칙: 추가만
// 가능, 대체/약화 불가). requiresSecret과 CORE_ALWAYS_HUMAN_APPROVAL_TAGS는 이 policy로
// 절대 끌 수 없다 — 그런 필드 자체가 타입에 없다.
// =========================================================

export interface CapabilityResolverPolicy {
  /** Core 목록(CORE_ALWAYS_HUMAN_APPROVAL_TAGS) 위에 프로젝트가 추가로 항상 사람 승인을
   *  요구하고 싶은 action tag. Core 목록을 줄이거나 대체하는 필드는 존재하지 않는다. */
  additionalAlwaysHumanApprovalTags?: ActionTag[];
  /** 트러스트 스코어 가산에만 쓰는 프로젝트 신뢰 provider 목록 — official 판정 자체나
   *  approval 판정을 대체하지 않는다(참고용 랭킹 보정일 뿐). */
  trustedProviders?: string[];
}

const KNOWN_ACTION_TAGS: ReadonlySet<ActionTag> = new Set([
  "production_db_write",
  "deployment",
  "live_trading_or_brokerage",
  "payment_or_financial_transaction",
  "high_risk_external_action",
  "read_only",
]);

/** policy가 명시적으로 주입됐을 때 형태를 검증한다 — 잘못된 값이 조용히 무시되거나
 *  예상치 못한 방식으로 해석되지 않도록 즉시 throw한다(project-policy.ts와 동일한 원칙). */
export function validateCapabilityResolverPolicy(policy: CapabilityResolverPolicy): void {
  if (!policy || typeof policy !== "object") {
    throw new Error("Invalid CapabilityResolverPolicy: policy가 비어있거나 객체가 아닙니다.");
  }
  if (policy.additionalAlwaysHumanApprovalTags !== undefined) {
    if (
      !Array.isArray(policy.additionalAlwaysHumanApprovalTags) ||
      !policy.additionalAlwaysHumanApprovalTags.every((t) => typeof t === "string" && KNOWN_ACTION_TAGS.has(t as ActionTag))
    ) {
      throw new Error(
        "Invalid CapabilityResolverPolicy: additionalAlwaysHumanApprovalTags는 알려진 ActionTag 문자열 배열이어야 합니다."
      );
    }
  }
  if (policy.trustedProviders !== undefined) {
    if (!Array.isArray(policy.trustedProviders) || !policy.trustedProviders.every((p) => typeof p === "string")) {
      throw new Error("Invalid CapabilityResolverPolicy: trustedProviders는 string 배열이어야 합니다.");
    }
  }
}

/** Core가 절대 프로젝트로 대체될 수 없는 "항상 사람 승인" action 목록 — production DB
 *  write/배포/live trading·brokerage/결제·금융 transaction/고위험 외부 action. */
export const CORE_ALWAYS_HUMAN_APPROVAL_TAGS: ReadonlySet<ActionTag> = new Set([
  "production_db_write",
  "deployment",
  "live_trading_or_brokerage",
  "payment_or_financial_transaction",
  "high_risk_external_action",
]);

function resolveAlwaysHumanApprovalTags(policy?: CapabilityResolverPolicy): ReadonlySet<ActionTag> {
  if (!policy?.additionalAlwaysHumanApprovalTags?.length) return CORE_ALWAYS_HUMAN_APPROVAL_TAGS;
  return new Set([...CORE_ALWAYS_HUMAN_APPROVAL_TAGS, ...policy.additionalAlwaysHumanApprovalTags]);
}

// =========================================================
// Candidate 평가 — risk/approval 판정.
// =========================================================

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type ApprovalDecision = "AUTO_ALLOWED" | "HUMAN_APPROVAL_REQUIRED";

export interface CapabilityEvaluation {
  candidateId: string;
  riskLevel: RiskLevel;
  approval: ApprovalDecision;
  /** 선택/거부 이유 — 판정에 실제로 영향을 준 요인을 사람이 읽을 수 있는 문장으로 담는다. */
  reasons: string[];
}

const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * candidate 하나를 deterministic 규칙만으로 평가한다. 이 함수는 LLM을 호출하지 않고,
 * ProjectExecutionPolicy 등 다른 어떤 정책도 받지 않는다(우회 표면이 없다). policy(있다면
 * CapabilityResolverPolicy)는 오직 추가 제한만 더할 수 있다.
 *
 * 승인 판정 규칙(요구사항 "자동 활성화 금지 대상" 그대로):
 *   - candidate.requiresSecret === true → 항상 HUMAN_APPROVAL_REQUIRED("secret/credential
 *     접근"). Core 목록이 아니라 이 boolean 필드 자체가 직접 판정을 강제한다 — 어떤
 *     policy로도 끌 수 없다.
 *   - candidate.actionTags 중 하나라도 CORE_ALWAYS_HUMAN_APPROVAL_TAGS(+policy가 추가한
 *     항목)에 속하면 → 항상 HUMAN_APPROVAL_REQUIRED.
 *   - 그 외에는 official 여부/network 필요/비용 가능성으로 riskLevel만 조정하고
 *     AUTO_ALLOWED로 판정한다(단, 이 Task는 실제로 무언가를 활성화하지 않는다 — 이
 *     approval 필드는 향후 활성화 게이트가 참조할 분류값일 뿐이다).
 */
export function evaluateCandidate(candidate: CapabilityCandidate, policy?: CapabilityResolverPolicy): CapabilityEvaluation {
  const reasons: string[] = [];
  let riskLevel: RiskLevel = "low";
  const escalate = (level: RiskLevel, reason: string) => {
    if (RISK_ORDER[level] > RISK_ORDER[riskLevel]) riskLevel = level;
    reasons.push(reason);
  };

  if (candidate.official === "community") {
    escalate("medium", `provider(${candidate.provider})가 공식 소스가 아님(community) — 신뢰도가 낮음`);
  } else if (candidate.official === "unknown") {
    escalate("high", `provider(${candidate.provider})의 공식 여부를 확인할 수 없음(unknown) — 신뢰도가 매우 낮음`);
  } else {
    reasons.push(`provider(${candidate.provider})가 공식 소스로 확인됨(official)`);
  }

  if (candidate.requiresNetwork && candidate.official !== "official") {
    escalate("medium", "network 접근이 필요하며 공식 출처가 아님");
  }
  if (candidate.costRisk === "certain") {
    escalate("medium", "비용이 확정적으로 발생함");
  } else if (candidate.costRisk === "possible") {
    reasons.push("비용이 발생할 가능성이 있음(사용량 등에 따라 달라짐)");
  }

  let approval: ApprovalDecision = "AUTO_ALLOWED";

  if (candidate.requiresSecret) {
    riskLevel = "critical";
    approval = "HUMAN_APPROVAL_REQUIRED";
    reasons.push("secret/credential 접근이 필요함 — Core 정책상 항상 사람 승인이 필요합니다.");
  }

  const alwaysHumanTags = resolveAlwaysHumanApprovalTags(policy);
  const matchedTags = candidate.actionTags.filter((t) => alwaysHumanTags.has(t));
  if (matchedTags.length > 0) {
    riskLevel = "critical";
    approval = "HUMAN_APPROVAL_REQUIRED";
    reasons.push(`Core 정책상 항상 사람 승인이 필요한 action(${matchedTags.join(", ")})을 포함함`);
  }

  return { candidateId: candidate.id, riskLevel, approval, reasons };
}

export interface CandidateRanking {
  candidate: CapabilityCandidate;
  evaluation: CapabilityEvaluation;
}

const OFFICIAL_RANK: Record<SourceOfficiality, number> = { official: 0, community: 1, unknown: 2 };

/** 두 candidate를 비교한다 — 공식 후보 우선 → AUTO_ALLOWED 후보 우선 → 낮은 위험도 우선 →
 *  id 사전순(완전 동률 시 deterministic 안정 정렬). "대안 비교"의 단일 출처. */
export function compareCandidates(a: CandidateRanking, b: CandidateRanking): number {
  const officialDiff = OFFICIAL_RANK[a.candidate.official] - OFFICIAL_RANK[b.candidate.official];
  if (officialDiff !== 0) return officialDiff;
  if (a.evaluation.approval !== b.evaluation.approval) {
    return a.evaluation.approval === "AUTO_ALLOWED" ? -1 : 1;
  }
  const riskDiff = RISK_ORDER[a.evaluation.riskLevel] - RISK_ORDER[b.evaluation.riskLevel];
  if (riskDiff !== 0) return riskDiff;
  return a.candidate.id.localeCompare(b.candidate.id);
}

/** 여러 candidate(같은 requirement에 대한 대안들)를 평가하고 우선순위대로 정렬한다. */
export function rankCandidates(candidates: CapabilityCandidate[], policy?: CapabilityResolverPolicy): CandidateRanking[] {
  return candidates.map((c) => ({ candidate: c, evaluation: evaluateCandidate(c, policy) })).sort(compareCandidates);
}

// =========================================================
// Candidate Source — 외부 catalog 조회를 위한 주입형 seam(dependency-scanner.ts의
// VulnerabilityAuditSource와 동일한 설계). 이 Task는 실제 조회 구현(예: 공식 MCP
// registry/Anthropic catalog 연동)을 만들지 않는다 — 그 구현이 나중에 생기더라도, 이
// 모듈/테스트는 CandidateSource 함수 시그니처만 알면 된다(네트워크 불필요).
// =========================================================

export type CandidateSourceOutcome = { ok: true; candidates: CapabilityCandidate[] } | { ok: false; reason: string };

export type CandidateSource = (requirement: CapabilityRequirement) => CandidateSourceOutcome;

export type ResolutionStatus = "RESOLVED" | "HUMAN_APPROVAL_REQUIRED" | "NO_CANDIDATES_FOUND" | "SOURCE_UNAVAILABLE";

export interface CapabilityResolution {
  requirement: CapabilityRequirement;
  status: ResolutionStatus;
  rankedCandidates: CandidateRanking[];
  /** status === "RESOLVED"일 때만 설정된다(최상위 candidate가 AUTO_ALLOWED인 경우). */
  selected?: CapabilityCandidate;
  reason: string;
}

/**
 * requirement 하나를 candidate source로 조회해 평가/랭킹까지 마친다.
 *
 * source 조회 자체가 실패하면(ok:false — 네트워크 오류, catalog 접근 불가 등) 근거 없이
 * 아무 candidate도 자동 선택하지 않는다(status="SOURCE_UNAVAILABLE", selected 없음) —
 * 요구사항: "외부 조회 실패 시 근거 없이 자동선택 금지". source가 후보를 찾지 못했다면
 * (candidates.length===0) status="NO_CANDIDATES_FOUND"로 구분한다. 후보가 있으면
 * rankCandidates()로 정렬하고, 1순위가 AUTO_ALLOWED면 RESOLVED로 selected를 채운다 —
 * 1순위가 HUMAN_APPROVAL_REQUIRED라면(예: candidate가 secret을 요구하거나 Core action
 * tag를 포함) 그 판정을 그대로 승계해 status="HUMAN_APPROVAL_REQUIRED"로 두고
 * selected는 비워둔다(자동 선택 금지 — 사람이 승인해야 다음 단계로 진행).
 */
export function resolveCapability(
  requirement: CapabilityRequirement,
  source: CandidateSource,
  policy?: CapabilityResolverPolicy
): CapabilityResolution {
  const outcome = source(requirement);
  if (!outcome.ok) {
    return {
      requirement,
      status: "SOURCE_UNAVAILABLE",
      rankedCandidates: [],
      reason: `candidate source 조회에 실패했습니다 — 근거 없이 자동 선택하지 않습니다: ${outcome.reason}`,
    };
  }
  if (outcome.candidates.length === 0) {
    return {
      requirement,
      status: "NO_CANDIDATES_FOUND",
      rankedCandidates: [],
      reason: "이 requirement에 대해 알려진 candidate가 없습니다 — 사람이 직접 조사해야 합니다.",
    };
  }

  const ranked = rankCandidates(outcome.candidates, policy);
  const top = ranked[0];
  if (top.evaluation.approval === "HUMAN_APPROVAL_REQUIRED") {
    return {
      requirement,
      status: "HUMAN_APPROVAL_REQUIRED",
      rankedCandidates: ranked,
      reason: `최상위 candidate(${top.candidate.id})가 사람 승인이 필요합니다: ${top.evaluation.reasons.join("; ")}`,
    };
  }
  return {
    requirement,
    status: "RESOLVED",
    rankedCandidates: ranked,
    selected: top.candidate,
    reason: `최상위 candidate(${top.candidate.id}) 자동 채택 가능: ${top.evaluation.reasons.join("; ") || "특이 위험 요인 없음"}`,
  };
}
