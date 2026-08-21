import type {
  CapabilityRequirement,
  CapabilityCandidate,
  CapabilityType,
  SourceOfficiality,
  CostRisk,
  ActionTag,
  CandidateSource,
  CandidateSourceOutcome,
} from "./capability-resolver";
import { CORE_ALWAYS_HUMAN_APPROVAL_TAGS } from "./capability-resolver";

// Trusted Candidate Discovery & Evidence — Phase D Task D2.
//
// D1(capability-resolver.ts)이 만든 CandidateSource seam(requirement → CapabilityCandidate[]
// 조회, 실패 시 ok:false) 위에, 후보의 "출처/근거/신뢰도"를 구조화하는 계층을 더한다. D1
// 파일 자체는 이 Task에서 전혀 수정하지 않는다 — D2는 별도의 풍부한 evidence 기록
// (CandidateEvidence)을 평가/충돌 판정/랭킹하고, SUFFICIENT로 판정된 evidence만
// toCandidateSource()로 D1이 그대로 소비할 수 있는 CandidateSource로 승격시킨다. AI(Claude/
// GPT) 판단에 의존하지 않는다 — 이 모듈은 LLM을 호출하지 않고, 어떤 LLM 출력도 신뢰 입력으로
// 받지 않는다.
//
// 이번 D2 범위도 D1과 마찬가지로 "Core Design/Foundation"이다 — 실제 MCP 설치/활성화/실행,
// Browser Worker, Agent Router, Dashboard, 자동 다운로드, production credential 사용은
// 이 Task에서 하지 않는다.

// =========================================================
// Evidence 데이터 모델.
// =========================================================

/** 자료 신뢰 우선순위(요구사항 그대로) — 숫자가 작을수록 더 신뢰한다. community_signal은
 *  "후보 발견 신호"일 뿐 자동 선택 근거가 되지 않는다(§ evaluateEvidence). */
export type EvidenceSourceType =
  | "official_vendor_doc"
  | "official_repository"
  | "official_sdk_or_registry_metadata"
  | "vendor_maintained"
  | "general_technical"
  | "community_signal";

const SOURCE_TYPE_PRIORITY: Record<EvidenceSourceType, number> = {
  official_vendor_doc: 0,
  official_repository: 1,
  official_sdk_or_registry_metadata: 2,
  vendor_maintained: 3,
  general_technical: 4,
  community_signal: 5,
};

export type MaintenanceStatus = "actively_maintained" | "maintained" | "stale" | "unmaintained" | "unknown";

export interface LastKnownUpdate {
  /** ISO 8601 날짜 문자열. */
  date: string;
  /** 버전 태그/커밋 SHA/릴리스 노트 링크 등(선택). */
  reference?: string;
}

export interface SecurityReputationSignal {
  summary: string;
  sourceType: EvidenceSourceType;
}

/** candidate 하나에 대한 근거 레코드 — 순수 입력 데이터(사실)만 담는다. 판정 결과(신뢰도/
 *  선택·거부 이유)는 evaluateEvidence()/evaluateTrustedCandidate()의 출력에만 담는다(D1의
 *  CapabilityCandidate vs CapabilityEvaluation 분리와 동일한 설계). 값을 모르면 절대
 *  추측하지 않는다 — official/maintenanceStatus는 "unknown"으로, lastKnownUpdate/license/
 *  securitySignal은 undefined로 남긴다. */
export interface CandidateEvidence {
  candidateId: string;
  capabilityId: string;
  type: CapabilityType;
  sourceType: EvidenceSourceType;
  /** source URL 또는 canonical identifier(npm package name, MCP registry id, GitHub repo 등). */
  sourceRef: string;
  official: SourceOfficiality;
  publisher: string;
  maintenanceStatus: MaintenanceStatus;
  /** 있으면 기록한다 — 없으면 undefined(추측으로 채우지 않는다). */
  lastKnownUpdate?: LastKnownUpdate;
  requiredPermissions: string[];
  requiresNetwork: boolean;
  requiresSecret: boolean;
  costRisk: CostRisk;
  license?: string;
  securitySignal?: SecurityReputationSignal;
  /** 이 evidence 레코드 자체가 수집된 시점(ISO 8601) — staleness 판정의 기준값(lastKnownUpdate가
   *  없을 때의 대체 기준). */
  evidenceTimestamp: string;
  /** 같은 requirement에 대한 다른 candidate.id 목록(참고용 메타데이터). */
  alternatives?: string[];
  /** D1 ActionTag를 그대로 전달하고 싶을 때만 채운다 — 없으면 D1으로 승격할 때 빈 배열로
   *  다룬다(추측해서 채우지 않는다. requiresSecret은 별도 필드로 이미 전달되므로 영향 없음). */
  actionTags?: ActionTag[];
}

// =========================================================
// Project Policy — Core trust/risk 판정을 완화할 수 없다(project-policy.ts/
// capability-resolver.ts의 CapabilityResolverPolicy와 동일한 설계: 추가/강화만 가능,
// 대체·약화 불가).
// =========================================================

const CORE_STALE_AFTER_DAYS = 180;

export interface TrustedDiscoveryPolicy {
  /** CORE_ALWAYS_HUMAN_APPROVAL_TAGS 위에 추가만 가능(대체 불가) — capability-resolver.ts와
   *  동일한 목록을 그대로 재사용한다. */
  additionalAlwaysHumanApprovalTags?: ActionTag[];
  /** staleness 기준을 Core 기본값(180일)보다 "더 엄격하게"(짧게)만 좁힐 수 있다 — 이 값이
   *  Core 기본값보다 크면 무시되고 Core 기본값이 그대로 적용된다(늘려서 완화 불가). */
  maxStaleAfterDays?: number;
}

const KNOWN_ACTION_TAGS: ReadonlySet<ActionTag> = new Set([
  "production_db_write",
  "deployment",
  "live_trading_or_brokerage",
  "payment_or_financial_transaction",
  "high_risk_external_action",
  "read_only",
]);

export function validateTrustedDiscoveryPolicy(policy: TrustedDiscoveryPolicy): void {
  if (!policy || typeof policy !== "object") {
    throw new Error("Invalid TrustedDiscoveryPolicy: policy가 비어있거나 객체가 아닙니다.");
  }
  if (policy.additionalAlwaysHumanApprovalTags !== undefined) {
    if (
      !Array.isArray(policy.additionalAlwaysHumanApprovalTags) ||
      !policy.additionalAlwaysHumanApprovalTags.every((t) => typeof t === "string" && KNOWN_ACTION_TAGS.has(t as ActionTag))
    ) {
      throw new Error("Invalid TrustedDiscoveryPolicy: additionalAlwaysHumanApprovalTags는 알려진 ActionTag 문자열 배열이어야 합니다.");
    }
  }
  if (policy.maxStaleAfterDays !== undefined) {
    if (typeof policy.maxStaleAfterDays !== "number" || !Number.isFinite(policy.maxStaleAfterDays) || policy.maxStaleAfterDays <= 0) {
      throw new Error("Invalid TrustedDiscoveryPolicy: maxStaleAfterDays는 양수여야 합니다.");
    }
  }
}

function resolveAlwaysHumanApprovalTags(policy?: TrustedDiscoveryPolicy): ReadonlySet<ActionTag> {
  if (!policy?.additionalAlwaysHumanApprovalTags?.length) return CORE_ALWAYS_HUMAN_APPROVAL_TAGS;
  return new Set([...CORE_ALWAYS_HUMAN_APPROVAL_TAGS, ...policy.additionalAlwaysHumanApprovalTags]);
}

/** Core 기본값(180일)보다 큰 값은 무시한다 — project policy는 staleness 기준을 완화(늘리는
 *  것)할 수 없고, 더 엄격하게(줄이는 것)만 할 수 있다. */
function resolveStaleAfterDays(policy?: TrustedDiscoveryPolicy): number {
  if (policy?.maxStaleAfterDays === undefined) return CORE_STALE_AFTER_DAYS;
  return Math.min(CORE_STALE_AFTER_DAYS, policy.maxStaleAfterDays);
}

// =========================================================
// 단일 evidence 평가 — 신뢰도(confidence)/staleness/이유.
// =========================================================

/** "근거가 부족하면 UNKNOWN 또는 HUMAN_REVIEW_REQUIRED로 남긴다"의 3단계 등급.
 *  SUFFICIENT만 자동 선택(D1으로 승격)의 전제조건이 된다. */
export type EvidenceConfidence = "SUFFICIENT" | "UNKNOWN" | "HUMAN_REVIEW_REQUIRED";

const CONFIDENCE_ORDER: Record<EvidenceConfidence, number> = { SUFFICIENT: 0, UNKNOWN: 1, HUMAN_REVIEW_REQUIRED: 2 };

export interface EvidenceEvaluation {
  candidateId: string;
  confidence: EvidenceConfidence;
  stale: boolean;
  reasons: string[];
}

export interface EvaluateEvidenceOptions {
  /** 기준 시각 — 지정하지 않으면 실제 현재 시각(new Date())을 쓴다. 테스트는 항상 고정된
   *  값을 넘겨 deterministic하게 검증한다. */
  now?: Date;
  policy?: TrustedDiscoveryPolicy;
}

function isStale(evidence: CandidateEvidence, now: Date, staleAfterDays: number): boolean {
  const refDateStr = evidence.lastKnownUpdate?.date ?? evidence.evidenceTimestamp;
  const refDate = new Date(refDateStr);
  if (Number.isNaN(refDate.getTime())) return true; // 날짜를 파싱할 수 없으면 신뢰할 수 없으므로 stale로 간주(추측 금지).
  return now.getTime() - refDate.getTime() > staleAfterDays * 24 * 60 * 60 * 1000;
}

/**
 * evidence 레코드 하나를 deterministic 규칙만으로 평가한다. LLM을 호출하지 않고, 어떤
 * policy로도 약화될 수 없는 두 가지를 직접 강제한다: (1) requiresSecret===true는 항상
 * HUMAN_REVIEW_REQUIRED, (2) actionTags가 CORE_ALWAYS_HUMAN_APPROVAL_TAGS(+policy가
 * 추가한 항목)와 겹치면 항상 HUMAN_REVIEW_REQUIRED. 그 외에는 official 여부/source type/
 * maintenance 상태/staleness로 confidence를 낮춘다(공식·최신·유지보수 중인 evidence만
 * SUFFICIENT로 남는다).
 */
export function evaluateEvidence(evidence: CandidateEvidence, opts: EvaluateEvidenceOptions = {}): EvidenceEvaluation {
  const now = opts.now ?? new Date();
  const staleAfterDays = resolveStaleAfterDays(opts.policy);
  const reasons: string[] = [];
  let confidence: EvidenceConfidence = "SUFFICIENT";

  const downgrade = (to: EvidenceConfidence, reason: string) => {
    if (CONFIDENCE_ORDER[to] > CONFIDENCE_ORDER[confidence]) confidence = to;
    reasons.push(reason);
  };

  if (evidence.official === "unknown") {
    downgrade("HUMAN_REVIEW_REQUIRED", "공식 여부(official)를 확인할 수 없음(unknown) — 추측하지 않고 사람 확인이 필요함");
  } else if (evidence.official === "community") {
    downgrade("UNKNOWN", "비공식(community) 출처 — 발견 신호로만 취급, 자동 선택 근거로는 부족함");
  }

  if (evidence.sourceType === "community_signal") {
    downgrade("UNKNOWN", "source type이 community_signal(블로그/커뮤니티) — 후보 발견 신호일 뿐 자동 선택 근거가 아님");
  }

  if (evidence.maintenanceStatus === "unknown") {
    downgrade("UNKNOWN", "maintenance 상태를 확인할 수 없음(unknown)");
  } else if (evidence.maintenanceStatus === "unmaintained") {
    downgrade("HUMAN_REVIEW_REQUIRED", "유지보수가 중단된(unmaintained) 후보 — 사람 확인 필요");
  } else if (evidence.maintenanceStatus === "stale") {
    downgrade("UNKNOWN", "maintenance 상태가 stale(업데이트가 뜸함)");
  }

  const stale = isStale(evidence, now, staleAfterDays);
  if (stale) {
    downgrade("UNKNOWN", `evidence가 오래됨(stale) — 기준(${staleAfterDays}일) 대비 최신성을 확인해야 함`);
  }

  if (evidence.requiresSecret) {
    confidence = "HUMAN_REVIEW_REQUIRED";
    reasons.push("secret/credential 접근이 필요함 — Core 정책상 항상 사람 확인이 필요합니다.");
  }
  const alwaysHumanTags = resolveAlwaysHumanApprovalTags(opts.policy);
  const matchedTags = (evidence.actionTags ?? []).filter((t) => alwaysHumanTags.has(t));
  if (matchedTags.length > 0) {
    confidence = "HUMAN_REVIEW_REQUIRED";
    reasons.push(`Core 정책상 항상 사람 확인이 필요한 action(${matchedTags.join(", ")})을 포함함`);
  }

  if (confidence === "SUFFICIENT") {
    reasons.push(`공식(${evidence.official}) 출처(${evidence.sourceType})의 최신 evidence — 자동 선택 근거로 충분함`);
  }

  return { candidateId: evidence.candidateId, confidence, stale, reasons };
}

// =========================================================
// 여러 evidence 소스 간 충돌 탐지 — 다수결/최신값으로 조용히 병합하지 않는다.
// =========================================================

export interface EvidenceConflict {
  field: keyof CandidateEvidence;
  values: { sourceRef: string; value: unknown }[];
}

const CONFLICT_CHECK_FIELDS: (keyof CandidateEvidence)[] = [
  "official",
  "requiresSecret",
  "requiresNetwork",
  "maintenanceStatus",
  "costRisk",
];

/** 같은 candidateId를 가리키는 evidence들이 핵심 필드에서 서로 다른 값을 보고하는지
 *  검사한다. 하나라도 다르면 그 필드를 conflict로 기록한다 — 어느 쪽이 "맞다"고 판단하지
 *  않는다(그 판단은 evaluateTrustedCandidate()가 사람 확인으로 승격시키는 방식으로만
 *  처리한다). */
export function detectEvidenceConflicts(evidenceList: CandidateEvidence[]): EvidenceConflict[] {
  if (evidenceList.length < 2) return [];
  const conflicts: EvidenceConflict[] = [];
  for (const field of CONFLICT_CHECK_FIELDS) {
    const distinctValues = new Set(evidenceList.map((ev) => JSON.stringify(ev[field])));
    if (distinctValues.size > 1) {
      conflicts.push({ field, values: evidenceList.map((ev) => ({ sourceRef: ev.sourceRef, value: ev[field] })) });
    }
  }
  return conflicts;
}

// =========================================================
// evidence 랭킹(같은 candidate에 대한 여러 evidence 중 대표를 고름) + candidate 간 랭킹
// ("대안 비교" — 여러 candidate 중 어느 쪽을 우선할지).
// =========================================================

export interface EvidenceRanking {
  evidence: CandidateEvidence;
  confidence: EvidenceConfidence;
  stale: boolean;
  reasons: string[];
}

/** 신뢰도가 높을수록(SUFFICIENT < UNKNOWN < HUMAN_REVIEW_REQUIRED 순으로 낮음) → 자료
 *  신뢰 우선순위(official_vendor_doc이 가장 앞) → non-stale 우선 → sourceRef 사전순
 *  (완전 동률 시 deterministic 안정 정렬)으로 비교한다. */
export function compareEvidence(a: EvidenceRanking, b: EvidenceRanking): number {
  const confDiff = CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence];
  if (confDiff !== 0) return confDiff;
  const srcDiff = SOURCE_TYPE_PRIORITY[a.evidence.sourceType] - SOURCE_TYPE_PRIORITY[b.evidence.sourceType];
  if (srcDiff !== 0) return srcDiff;
  if (a.stale !== b.stale) return a.stale ? 1 : -1;
  return a.evidence.sourceRef.localeCompare(b.evidence.sourceRef);
}

export function rankEvidence(evidenceList: CandidateEvidence[], opts: EvaluateEvidenceOptions = {}): EvidenceRanking[] {
  const rankings: EvidenceRanking[] = evidenceList.map((evidence) => {
    const evalResult = evaluateEvidence(evidence, opts);
    return { evidence, confidence: evalResult.confidence, stale: evalResult.stale, reasons: evalResult.reasons };
  });
  return rankings.sort(compareEvidence);
}

function groupByCandidateId(evidenceList: CandidateEvidence[]): Map<string, CandidateEvidence[]> {
  const map = new Map<string, CandidateEvidence[]>();
  for (const ev of evidenceList) {
    const list = map.get(ev.candidateId) ?? [];
    list.push(ev);
    map.set(ev.candidateId, list);
  }
  return map;
}

export interface TrustedCandidateEvaluation {
  candidateId: string;
  confidence: EvidenceConfidence;
  stale: boolean;
  conflicts: EvidenceConflict[];
  reasons: string[];
  /** 이 candidate의 evidence 중 랭킹 1순위(대표) — conflicts가 있어도 참고용으로 남긴다.
   *  자동 채택 여부는 confidence로만 판단한다(§ discoverTrustedCandidates). */
  primaryEvidence: CandidateEvidence;
}

/** 같은 candidateId의 evidence 전부를 모아 대표 evidence(랭킹 1순위)로 평가하되, 서로
 *  충돌하는 값이 있으면 무조건 HUMAN_REVIEW_REQUIRED로 승격한다(다수결/최신값으로 조용히
 *  선택하지 않음). */
export function evaluateTrustedCandidate(evidenceList: CandidateEvidence[], opts: EvaluateEvidenceOptions = {}): TrustedCandidateEvaluation {
  if (evidenceList.length === 0) {
    throw new Error("evaluateTrustedCandidate: evidenceList가 비어있습니다.");
  }
  const ranked = rankEvidence(evidenceList, opts);
  const primary = ranked[0];
  const conflicts = detectEvidenceConflicts(evidenceList);
  const reasons = [...primary.reasons];
  let confidence = primary.confidence;
  if (conflicts.length > 0) {
    confidence = "HUMAN_REVIEW_REQUIRED";
    reasons.push(
      `서로 다른 evidence 소스 간 충돌 발견(${conflicts.map((c) => String(c.field)).join(", ")}) — 자동으로 하나를 채택하지 않고 사람 확인이 필요합니다.`
    );
  }
  return { candidateId: primary.evidence.candidateId, confidence, stale: primary.stale, conflicts, reasons, primaryEvidence: primary.evidence };
}

export function compareTrustedCandidates(a: TrustedCandidateEvaluation, b: TrustedCandidateEvaluation): number {
  const confDiff = CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence];
  if (confDiff !== 0) return confDiff;
  const srcDiff = SOURCE_TYPE_PRIORITY[a.primaryEvidence.sourceType] - SOURCE_TYPE_PRIORITY[b.primaryEvidence.sourceType];
  if (srcDiff !== 0) return srcDiff;
  if (a.stale !== b.stale) return a.stale ? 1 : -1;
  return a.candidateId.localeCompare(b.candidateId);
}

// =========================================================
// Evidence Source — 외부 조회를 위한 주입형 seam(D1의 CandidateSource와 동일한 설계
// 원칙). 실제 조회 구현(공식 vendor 문서/repository/registry metadata 연동)은 이 Task에서
// 만들지 않는다 — 테스트는 전부 fixture 함수로 주입한다(네트워크 불필요).
// =========================================================

export type EvidenceSourceOutcome = { ok: true; evidence: CandidateEvidence[] } | { ok: false; reason: string };

export type EvidenceSource = (requirement: CapabilityRequirement) => EvidenceSourceOutcome;

export type TrustedDiscoveryStatus = "RESOLVED" | "HUMAN_REVIEW_REQUIRED" | "NO_EVIDENCE_FOUND" | "SOURCE_UNAVAILABLE";

export interface TrustedDiscoveryResult {
  requirement: CapabilityRequirement;
  status: TrustedDiscoveryStatus;
  rankedCandidates: TrustedCandidateEvaluation[];
  /** status === "RESOLVED"일 때만 설정된다. */
  selected?: CandidateEvidence;
  reason: string;
}

/**
 * requirement 하나를 evidence source로 조회해 candidate별로 평가/충돌 판정/랭킹까지
 * 마친다. source 조회 자체가 실패하면(ok:false) 근거 없이 아무 candidate도 자동 선택하지
 * 않는다(status="SOURCE_UNAVAILABLE"). evidence가 비어있으면 NO_EVIDENCE_FOUND로
 * 구분한다. 1순위 candidate의 confidence가 SUFFICIENT가 아니면(UNKNOWN이든
 * HUMAN_REVIEW_REQUIRED든) RESOLVED로 판정하지 않는다 — "비공식만 있으면 자동 채택 금지",
 * "충돌하면 자동 채택 금지"가 이 한 조건으로 함께 처리된다.
 */
export function discoverTrustedCandidates(
  requirement: CapabilityRequirement,
  source: EvidenceSource,
  opts: EvaluateEvidenceOptions = {}
): TrustedDiscoveryResult {
  const outcome = source(requirement);
  if (!outcome.ok) {
    return {
      requirement,
      status: "SOURCE_UNAVAILABLE",
      rankedCandidates: [],
      reason: `evidence source 조회에 실패했습니다 — 근거 없이 자동 선택하지 않습니다: ${outcome.reason}`,
    };
  }
  if (outcome.evidence.length === 0) {
    return {
      requirement,
      status: "NO_EVIDENCE_FOUND",
      rankedCandidates: [],
      reason: "이 requirement에 대해 알려진 evidence가 없습니다 — 사람이 직접 조사해야 합니다.",
    };
  }

  const grouped = groupByCandidateId(outcome.evidence);
  const evaluated = [...grouped.values()].map((list) => evaluateTrustedCandidate(list, opts));
  const ranked = evaluated.sort(compareTrustedCandidates);
  const top = ranked[0];

  if (top.confidence !== "SUFFICIENT") {
    return {
      requirement,
      status: "HUMAN_REVIEW_REQUIRED",
      rankedCandidates: ranked,
      reason: `최상위 candidate(${top.candidateId})의 evidence가 자동 선택에 충분하지 않습니다(${top.confidence}): ${top.reasons.join("; ")}`,
    };
  }
  return {
    requirement,
    status: "RESOLVED",
    rankedCandidates: ranked,
    selected: top.primaryEvidence,
    reason: `최상위 candidate(${top.candidateId}) evidence가 자동 선택에 충분합니다: ${top.reasons.join("; ")}`,
  };
}

// =========================================================
// D1(capability-resolver.ts)로의 승격 — CandidateSource seam 어댑터.
// =========================================================

/** evidence를 D1의 CapabilityCandidate로 변환한다 — evidence에 없는 필드는 추측하지 않고
 *  그대로(예: official="unknown") 전달한다. */
export function toCapabilityCandidate(evidence: CandidateEvidence): CapabilityCandidate {
  return {
    id: evidence.candidateId,
    capabilityId: evidence.capabilityId,
    type: evidence.type,
    provider: evidence.publisher,
    sourceUrl: evidence.sourceRef,
    official: evidence.official,
    permissions: evidence.requiredPermissions,
    requiresNetwork: evidence.requiresNetwork,
    requiresSecret: evidence.requiresSecret,
    costRisk: evidence.costRisk,
    actionTags: evidence.actionTags ?? [],
    alternatives: evidence.alternatives,
    notes: evidence.securitySignal?.summary,
  };
}

/**
 * EvidenceSource를 D1의 CandidateSource로 어댑팅한다 — capability-resolver.ts의
 * resolveCapability()가 이 함수의 반환값을 그대로 소비할 수 있다(D1 소스는 이 Task에서
 * 전혀 수정하지 않는다). D2의 신뢰도 판정을 통과하지 못한(confidence !== "SUFFICIENT")
 * candidate는 D1으로 아예 넘기지 않는다 — "비공식/근거 부족/충돌 candidate를 자동 채택하지
 * 않음"을 D1에 판단을 떠넘기지 않고 이 어댑터 단계에서부터 강제한다.
 */
export function toCandidateSource(source: EvidenceSource, opts: EvaluateEvidenceOptions = {}): CandidateSource {
  return (requirement: CapabilityRequirement): CandidateSourceOutcome => {
    const outcome = source(requirement);
    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    const grouped = groupByCandidateId(outcome.evidence);
    const candidates: CapabilityCandidate[] = [];
    for (const list of grouped.values()) {
      const trusted = evaluateTrustedCandidate(list, opts);
      if (trusted.confidence === "SUFFICIENT") {
        candidates.push(toCapabilityCandidate(trusted.primaryEvidence));
      }
    }
    return { ok: true, candidates };
  };
}
