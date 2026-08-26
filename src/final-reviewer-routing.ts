import type { ReviewProvider, ReviewProviderRequest, ReviewProviderResult } from "./review-provider";
import type { ProviderSecurityGateResult } from "./provider-security-gate";
import type { GptDecision, SeverityCounts } from "./types";
import { log } from "./logger";

// Final Reviewer Routing — Fireworks Primary / Groq Escalation.
//
// Production Final Reviewer 운영 구조: 일반 Final Review는 Fireworks(유료 credit 활용,
// qualification 12/13 PASS, Critical miss=0)가 담당하고, 위험도가 높은 변경/Fireworks의
// 불확실한 결과에서만 Groq(qualification 13/13 PASS, 가장 신뢰도 높은 reviewer)가 2차
// 검증한다 — 목적은 Fireworks 유료 credit을 실제 workload에 쓰면서 Groq quota를 보존하는
// 것이다(§ .claude/CLAUDE.md).
//
// 이 파일은 review-provider.ts의 ReviewProvider contract 하나만으로 동작하는 순수 routing
// layer다 — 실제 transport(chat-completion-review-provider.ts)/qualification corpus/evaluator를
// 새로 만들지 않는다. primary/escalation provider는 호출부(final-reviewer-provider-selection.ts)가
// 이미 완성된 ReviewProvider(fail-closed ZDR gate 포함)로 주입한다 — 이 파일은 어느 provider가
// Fireworks/Groq인지조차 몰라도 되게 설계됐다(id/model은 provider 자신이 이미 알고 있다).
//
// review-provider.ts의 설계 원칙("invalid structured output 판정은 Core의 단일 책임 —
// provider는 원문 텍스트만 돌려줄 뿐 그 파싱/검증을 provider별로 분산시키지 않는다")은 그대로
// 지킨다 — 이 파일이 outputText를 peek-parse하는 것은 오직 "escalation이 필요한가"를 판단하기
// 위한 내부 heuristic일 뿐, 그 결과를 최종 decision으로 쓰지 않는다. 실제 최종 decision은
// 언제나 이 함수가 반환하는 ReviewProviderResult.outputText를 gpt-reviewer.ts(Core)가 그대로
// JSON.parse한 것이다 — escalation이 일어나면 Groq의 outputText를, 아니면 Fireworks의
// outputText를 그대로 반환할 뿐 이 파일이 직접 decision을 만들어내지 않는다("Groq 결과가 최종
// 판정을 우선한다"를 별도 병합 로직 없이 만족).
//
// 자동 fallback으로 숨기면 안 되는 오류(§ 요구사항 "중요한 예외") — AutoDev 자체의 버그(예:
// 아래 keyword 매칭 함수에 실제 코드 결함이 있어 예외가 발생하는 경우)는 이 파일이 의도적으로
// try/catch로 감싸지 않는다 — 그런 예외는 그대로 위로 전파되어 gpt-reviewer.ts의 기존 최종
// 방어선(reviewClaudeResultOnce의 provider.review() try/catch, § 그 파일 주석 "provider 신뢰도와
// 무관하게 Core가 최종 방어선")이 PROVIDER_THREW/API_ERROR로 안전하게 처리한다 — Groq
// escalation으로 조용히 숨겨지지 않는다. 유일한 예외는 Fireworks 응답 텍스트를 peek-parse할 때의
// JSON.parse 실패뿐이다(§ 아래 tryPeekParseReviewShape) — 이는 "malformed provider response"라는
// 정상적인 escalation trigger 경로이지 AutoDev의 내부 버그가 아니다.

// =========================================================
// 1) Security-sensitive / Provider-fallback / Privacy-retention — content 기반 trigger.
// =========================================================
//
// request.instructions(system instructions, 프로젝트 규칙 포함)+request.input(task/diff/변경
// 파일 목록)은 이미 Fireworks/Groq 양쪽에 그대로 전달되는 동일한 텍스트다 — 이 함수는 새로운
// 정보 노출 없이 그 텍스트를 재사용해 keyword 기반으로 escalation 필요 여부만 판단한다(§
// STEP 5 "단순 문자열 substring 탐지는 HTTP 오류 분류에는 가능한 한 피한다" — 이 content
// 판정은 스펙 자신이 keyword 목록으로 정의한 영역이라 substring 탐지가 의도된 메커니즘이다).

export type ContentEscalationCategory = "SECURITY_SENSITIVE" | "PROVIDER_OR_FALLBACK_CHANGE" | "RETENTION_OR_PRIVACY_CHANGE";

const SECURITY_SENSITIVE_KEYWORDS = [
  "authentication",
  "authorization",
  "permission",
  "access control",
  "secret",
  "credential",
  "api key",
  "token",
  "encryption",
  "security policy",
  "security gate",
];

// D8_insecure_fallback_downgrade(Fireworks qualification의 유일한 High miss)와 같은 유형은
// "fallback"/"downgrade" keyword로 이미 커버된다 — 별도 case-id 하드코딩을 두지 않는다.
const PROVIDER_OR_FALLBACK_KEYWORDS = [
  "provider selection",
  "provider routing",
  "provider fallback",
  "provider downgrade",
  "quota ladder",
  "failover",
  "retry/fallback",
  "fallback",
  "downgrade",
  "reviewer switching",
  "reviewer routing",
  "reviewer provider security",
];

const RETENTION_OR_PRIVACY_KEYWORDS = [
  "zdr",
  "zero retention",
  "retention policy",
  "prompt logging",
  "telemetry",
  "request storage",
  "response storage",
  "provider security metadata",
];

function matchesAny(haystackLower: string, keywords: string[]): boolean {
  return keywords.some((k) => haystackLower.includes(k));
}

export function detectContentEscalationCategories(instructions: string, input: string): ContentEscalationCategory[] {
  const haystack = `${instructions}\n${input}`.toLowerCase();
  const categories: ContentEscalationCategory[] = [];
  if (matchesAny(haystack, SECURITY_SENSITIVE_KEYWORDS)) categories.push("SECURITY_SENSITIVE");
  if (matchesAny(haystack, PROVIDER_OR_FALLBACK_KEYWORDS)) categories.push("PROVIDER_OR_FALLBACK_CHANGE");
  if (matchesAny(haystack, RETENTION_OR_PRIVACY_KEYWORDS)) categories.push("RETENTION_OR_PRIVACY_CHANGE");
  return categories;
}

// =========================================================
// 2) Primary(Fireworks) 결과 기반 trigger — "결과가 위험한가".
// =========================================================

interface PeekParsedReview {
  decision: GptDecision;
  severity: SeverityCounts;
}

/** gpt-reviewer.ts의 실제 JSON.parse(outputText)와 동일한 최소 shape만 확인한다 — 이 결과는
 *  escalation 여부 판단에만 쓰이고, 최종 decision으로 절대 쓰이지 않는다(§ 파일 상단 주석). */
function tryPeekParseReviewShape(outputText: string): PeekParsedReview | undefined {
  try {
    const parsed = JSON.parse(outputText) as Partial<PeekParsedReview>;
    if (!parsed || typeof parsed.decision !== "string" || !parsed.severity) return undefined;
    if (typeof parsed.severity.critical !== "number" || typeof parsed.severity.high !== "number") return undefined;
    return { decision: parsed.decision as GptDecision, severity: parsed.severity as SeverityCounts };
  } catch {
    return undefined;
  }
}

export type PrimaryResultTriggerReason =
  | "PRIMARY_TRANSPORT_FAILURE" // 실제 요청은 전송됐지만 실패(429/5xx/timeout/malformed envelope 등) — "provider anomaly".
  | "PRIMARY_MALFORMED_RESPONSE" // envelope은 성공했지만 review JSON 형태가 아님 — "parser anomaly".
  | "PRIMARY_NON_PASS_DECISION" // decision이 PASS가 아님(REVISE/BLOCK/HUMAN_REQUIRED) — "FAIL/REVIEW_REQUIRED".
  | "PRIMARY_HIGH_SEVERITY"; // severity.critical>0 또는 severity.high>0.

export interface PrimaryResultTriggerOutcome {
  escalate: boolean;
  reason?: PrimaryResultTriggerReason;
  /** true면 primaryResult 자체를 그대로 반환해야 한다(§ "missing required API key"/ZDR
   *  실패처럼 AutoDev 설정 오류는 escalation으로 숨기지 않는다) — requestAttempted===false인
   *  실패는 escalate 여부와 무관하게 이 값이 true다. */
  surfacePrimaryDirectly: boolean;
}

export function detectPrimaryResultTrigger(primaryResult: ReviewProviderResult): PrimaryResultTriggerOutcome {
  if (!primaryResult.ok) {
    if (primaryResult.requestAttempted === false) {
      // 실제 HTTP 요청 자체가 없었던 로컬 preflight 실패(API key 누락/ZDR 미검증) — provider
      // 품질 문제가 아니라 AutoDev 설정 문제다. Groq escalation으로 숨기지 않고 그대로 노출한다.
      return { escalate: false, surfacePrimaryDirectly: true };
    }
    return { escalate: true, reason: "PRIMARY_TRANSPORT_FAILURE", surfacePrimaryDirectly: false };
  }

  const peek = tryPeekParseReviewShape(primaryResult.outputText);
  if (!peek) return { escalate: true, reason: "PRIMARY_MALFORMED_RESPONSE", surfacePrimaryDirectly: false };
  if (peek.decision !== "PASS") return { escalate: true, reason: "PRIMARY_NON_PASS_DECISION", surfacePrimaryDirectly: false };
  if (peek.severity.critical > 0 || peek.severity.high > 0) return { escalate: true, reason: "PRIMARY_HIGH_SEVERITY", surfacePrimaryDirectly: false };
  return { escalate: false, surfacePrimaryDirectly: false };
}

// =========================================================
// 3) Escalation(Groq) 가용성 진단 표시 — GROQ_STATUS/GROQ_REASON.
// =========================================================
//
// transient 플래그(review-provider.ts ReviewProviderFailure.transient — "재시도로 해결될
// 가능성이 있는 오류")를 그대로 재사용해 "provider availability 문제"와 "AutoDev가 숨기면 안
// 되는 오류(AUTH_ERROR/malformed envelope 등, 이미 이 코드베이스에서 transient=false로
// 분류됨)"를 구분한다 — 새 error classification 시스템을 만들지 않는다.

type GroqDiagnosticStatus = "RATE_LIMITED" | "PROVIDER_UNAVAILABLE";

function classifyGroqUnavailableStatus(errorCode: string): GroqDiagnosticStatus {
  return errorCode === "RATE_LIMIT" ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE";
}

// HTTP 429는 requests/day든 tokens/minute든 여러 원인일 수 있어 "DAILY_QUOTA_EXHAUSTED"처럼
// 단정하지 않는다(§ 요구사항) — 헤더로 더 구체화할 수 있을 때만 그 값을 별도로 실어 보낸다.
const GROQ_RATE_LIMIT_REASON = "RATE_LIMIT_OR_QUOTA_EXHAUSTED";

// =========================================================
// 4) Routing Provider 조립.
// =========================================================

export interface FinalReviewerRoutingDeps {
  /** Fireworks 등 — 이미 자기 자신의 fail-closed ZDR gate를 통과한 상태로 주입된다. 이 provider의
   *  id/model이 routing provider 전체의 id/model로 그대로 쓰인다(Core의 Provider Security
   *  Gate는 이 id 하나만으로 primary 호출 자체의 허용 여부를 이미 판정했다는 전제). */
  primaryProvider: ReviewProvider;
  /** Groq 등 — escalation이 실제로 필요할 때만 호출된다(lazy). */
  escalationProvider: ReviewProvider;
  /** escalation을 실제로 호출하기 직전에만 평가하는 Groq 전용 Provider Security Gate 판정 —
   *  reviewClaudeResultOnce()가 primaryProvider.id 하나만으로 수행하는 outer 판정과 별개로,
   *  escalationProvider.id에 대해 evaluateProviderSecurity()를 그대로 재사용해 독립적으로
   *  다시 판정한다(§ provider-security-gate.ts 로직 복제 없음) — Groq ZDR이 미검증이면
   *  escalation이 필요한 상황에서도 실제 Groq API를 호출하지 않는다("Groq ZDR/security gate
   *  그대로 유지"). eager하게(매 review마다) 평가하지 않고 실제로 escalation이 필요할 때만
   *  호출한다 — 그래야 escalation이 필요 없는 일반 review가 Groq의 ZDR 상태와 무관하게 항상
   *  Fireworks-only로 진행될 수 있다("Groq quota와 무관하게 일반 변경은 Groq 호출 없음"). */
  escalationSecurityCheck: () => ProviderSecurityGateResult;
}

export function createFinalReviewerRoutingProvider(deps: FinalReviewerRoutingDeps): ReviewProvider {
  const { primaryProvider, escalationProvider, escalationSecurityCheck } = deps;
  return {
    id: primaryProvider.id,
    model: primaryProvider.model,
    async review(request: ReviewProviderRequest): Promise<ReviewProviderResult> {
      const primaryResult = await primaryProvider.review(request);

      const resultTrigger = detectPrimaryResultTrigger(primaryResult);
      if (resultTrigger.surfacePrimaryDirectly) {
        // AutoDev 설정 오류(API key 누락/ZDR 미검증) — escalation으로 숨기지 않고 그대로 노출.
        return primaryResult;
      }

      const contentCategories = detectContentEscalationCategories(request.instructions, request.input);
      const escalate = resultTrigger.escalate || contentCategories.length > 0;

      if (!escalate) {
        return primaryResult;
      }

      log(`Final Reviewer escalation 판정: escalate=true`, {
        primaryProviderId: primaryProvider.id,
        resultTriggerReason: resultTrigger.reason,
        contentTriggerCategories: contentCategories,
      });

      const security = escalationSecurityCheck();
      if (security.verdict === "BLOCK") {
        log(`Final Reviewer escalation SECURITY_BLOCKED — escalation provider 호출 생략`, {
          escalationProviderId: escalationProvider.id,
          blockCode: security.blockCode,
        });
        return { ok: false, errorCode: "PROVIDER_SECURITY_BLOCKED", transient: false, requestAttempted: false };
      }

      const escalationResult = await escalationProvider.review(request);
      if (!escalationResult.ok) {
        if (escalationResult.transient === true) {
          const status = classifyGroqUnavailableStatus(escalationResult.errorCode);
          log(`Final Reviewer escalation 실패 — GROQ_STATUS=${status} GROQ_REASON=${status === "RATE_LIMITED" ? GROQ_RATE_LIMIT_REASON : escalationResult.errorCode}`, {
            escalationProviderId: escalationProvider.id,
            errorCode: escalationResult.errorCode,
            rateLimitHeaders: escalationResult.rateLimitHeaders,
          });
          return { ok: false, errorCode: "ESCALATION_REVIEWER_UNAVAILABLE", transient: false, requestAttempted: escalationResult.requestAttempted };
        }
        // AUTH_ERROR(예: GROQ_API_KEY 누락) 등 AutoDev 설정 오류/실제 provider 오류는 escalation
        // unavailable로 재분류하지 않고 그대로 노출한다(§ "missing required API key" 예외).
        return escalationResult;
      }

      // Groq 결과가 최종 판정을 우선한다 — outputText를 재해석하지 않고 그대로 반환한다.
      return escalationResult;
    },
  };
}
