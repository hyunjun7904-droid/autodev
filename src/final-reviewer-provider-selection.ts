import type { ReviewProvider, ReviewProviderRequest, ReviewProviderResult } from "./review-provider";
import type { ProviderSecurityRegistry, ProviderSecurityMetadata, DataClassification } from "./provider-security-gate";
import { evaluateProviderSecurity } from "./provider-security-gate";
import type { ChatCompletionHttpFetch } from "./chat-completion-review-provider";
import { createGroqReviewProvider } from "./groq-review-provider";
import { createFireworksReviewProvider } from "./fireworks-review-provider";
import {
  GROQ_PROVIDER_ID,
  FIREWORKS_PROVIDER_ID,
  buildGroqProviderSecurityMetadata,
  buildFireworksProviderSecurityMetadata,
  resolveGroqZdrVerification,
  resolveFireworksZdrVerification,
} from "./provider-pool-security-metadata";
import { OPENAI_REVIEW_RESULT_SCHEMA } from "./openai-review-provider";
import { createFinalReviewerRoutingProvider } from "./final-reviewer-routing";

// Production Final Reviewer Provider Selection — Final Reviewer Routing(Fireworks Primary /
// Groq Escalation), 실용형 보안 정책(§ .claude/CLAUDE.md).
//
// gpt-reviewer.ts(Reviewer Core)의 reviewClaudeResultOnce()가 provider/securityGateOverrides
// 인자를 생략했을 때(production 경로) 쓰는 production 기본값을 이 파일이 결정한다. 일반 Final
// Review는 Fireworks(accounts/fireworks/models/gpt-oss-120b, qualification 12/13 PASS,
// Critical miss=0, High miss=1 — D8_insecure_fallback_downgrade)가 담당하고, 위험도가 높은
// 변경/Fireworks의 불확실한 결과에서만 Groq(openai/gpt-oss-120b, qualification 13/13 PASS)가
// 2차 검증한다(final-reviewer-routing.ts) — 목적은 Fireworks 유료 credit을 실제 workload에
// 쓰면서 Groq quota를 escalation 전용으로 보존하는 것이다.
//
// 실제 provider transport(chat-completion-review-provider.ts 공용 factory)/Security Gate
// 판정 로직(provider-security-gate.ts)/escalation 판정 로직(final-reviewer-routing.ts)은 이
// 파일이 새로 만들지 않는다.
//
// =========================================================
// 실용형 보안 정책 — ZDR verification은 provider 사용의 필수 자격조건이 아니라 신뢰도
// 가산점이다.
// =========================================================
//
// provider-security-gate.ts의 Core hard rule(CONFIDENTIAL 이상 등급은 zero retention만
// 인정)은 이 파일이 전혀 수정하지 않는다 — 다른 모든 provider 경로(OpenAI 기본값 등)는 여전히
// 그 규칙 그대로 적용된다. 대신 이 파일은 review-provider.ts가 제공하는 선택적 seam
// (ReviewProvider.reviewerDataClassification)을 이용해 Fireworks/Groq에 한해 "이 요청에 어떤
// classification을 물어볼지"를 ZDR 검증 여부에 따라 동적으로 정한다:
//   - ZDR verified(AUTODEV_FIREWORKS_ZDR_VERIFIED/AUTODEV_GROQ_ZDR_VERIFIED === "true") →
//     CONFIDENTIAL을 그대로 요청한다 — retentionPolicy도 "zero"이므로 Core Gate가 기존과
//     동일하게 PASS한다(가산점 — 검증되면 기존과 동일한 최고 수준 보증을 받는다).
//   - ZDR unverified → INTERNAL을 요청한다. Core의 CONFIDENTIAL 이상 전용 zero-retention
//     요구사항은 INTERNAL에는 적용되지 않으므로(§ provider-security-gate.ts
//     CLASSIFICATION_LEVEL), ZDR 미검증만을 이유로 BLOCK되지 않는다 — "그것만으로 provider를
//     탈락시키지 않는다"는 정책을 그 Core 로직을 바꾸지 않고 구현한다.
// 이 하향은 안전하다 — Review payload(§ gpt-reviewer.ts buildChangeSection) 자체가 이미
// git-changes.ts의 secret/env 파일 패턴 제외를 거친 뒤에만 어떤 provider(OpenAI 포함)로도
// 전달된다(이 Task가 새로 추가한 보호가 아니라 기존에 이미 존재하는, provider에 무관한
// 공용 경로다). 호출부가 명시적으로 securityGateOverrides.classification을 지정하면(예:
// CONFIDENTIAL/RESTRICTED가 실제로 필요하다고 판단한 경우) 그 값이 항상 이 provider의 자기
// 선언보다 우선한다(§ gpt-reviewer.ts dataClassification 우선순위 주석) — 이 provider는 그
// 값을 낮출 방법이 없다.
//
// retentionPolicy가 "unknown"(정보 자체가 없음, Fireworks 미검증 기본값)인 경우만 문서로 이미
// 확인된 기본 동작에 맞춰 "bounded"로 완화해 표시한다(아래 toReviewerRegistryMetadata) —
// buildFireworksProviderSecurityMetadata()/buildGroqProviderSecurityMetadata() 자신(다른
// 소비처와 공유되는 shape/security metadata 빌더)은 전혀 수정하지 않는다. "unbounded"(보존기간
// 제한 없음으로 실제 확인된 경우 — 지금은 둘 중 어느 provider도 이 값을 갖지 않는다)는 완화하지
// 않는다 — 그것이 "완전히 불명확하거나 위험하다고 판단되는 경우 별도 검토"에 해당하는
// 케이스다.
//
// Fireworks 자신의 fail-closed ZDR self-check(fireworks-review-provider.ts)도 이 정책에 맞춰
// 완화됐다 — ZDR 미검증이어도 실제 HTTP 요청은 진행하고, 검증 여부는 이제 이 파일이 결정하는
// classification에만 반영된다. API key 자체가 없으면(전혀 다른 문제) 그 provider는 여전히
// fail-closed로 즉시 거부한다 — 그 검사는 이번 정책 변경과 무관하게 그대로 유지된다.

/** qualification을 통과한 primary(Fireworks) 모델 — final-reviewer-benchmark-fireworks.ts의
 *  기본값과 동일한 문자열이다(qualification 스크립트를 production이 import하지 않기 위한 값
 *  복제 — § 아래 FINAL_REVIEWER_ESCALATION_MODEL과 동일한 원칙). 이 값을 바꾸는 것은 곧 "어떤
 *  모델을 production primary Final Reviewer로 쓸지"를 바꾸는 것이므로, 새 qualification 없이
 *  바꾸지 않는다. */
export const FINAL_REVIEWER_PRIMARY_MODEL = "accounts/fireworks/models/gpt-oss-120b";
export const FINAL_REVIEWER_PRIMARY_PROVIDER_ID = FIREWORKS_PROVIDER_ID;

/** qualification을 통과한 escalation(Groq) 모델 — final-reviewer-benchmark-groq.ts의
 *  QUALIFIED_MODEL 기본값과 정확히 동일한 문자열이다. */
export const FINAL_REVIEWER_ESCALATION_MODEL = "openai/gpt-oss-120b";
export const FINAL_REVIEWER_ESCALATION_PROVIDER_ID = GROQ_PROVIDER_ID;

// 하위 호환 — 기존 호출부(gpt-smoke-test.ts 등)가 "production에서 응답할 것으로 기대되는
// provider/model"이라는 의미로 이 이름을 참조한다. 일반 review는 escalation 없이 Fireworks가
// 응답하므로 primary와 동일한 값을 가리킨다.
export const FINAL_REVIEWER_PRODUCTION_MODEL = FINAL_REVIEWER_PRIMARY_MODEL;
export const FINAL_REVIEWER_PRODUCTION_PROVIDER_ID = FINAL_REVIEWER_PRIMARY_PROVIDER_ID;

// STEP 5(REAL GROQ END-TO-END SMOKE, Production Final Reviewer Wiring Task) 실행 중 실제로
// 발견된 문제 — chat-completion-review-provider.ts(Fireworks/Groq/OpenRouter/NVIDIA 공용)는
// OpenAI Responses API의 구조화 출력(json_schema strict 모드)과 달리 response_format을 전송하지
// 않는다(§ 그 파일 상단 주석). gpt-reviewer.ts의 production system instructions
// (buildSystemInstructions())는 어떤 provider에도 동일하게 중립적이라 명시적 JSON 출력 지시를
// 포함하지 않는데, 이 지시 없이는 gpt-oss-120b가 markdown 산문 리뷰를 반환해 Core의
// JSON.parse(outputText)가 INVALID_OUTPUT으로 실패한다(Groq 실제 호출로 직접 확인됨).
// final-reviewer-benchmark-groq.ts/final-reviewer-benchmark-fireworks.ts 둘 다 동일하게 이
// 문제를 "출력 형식(필수)" 지시 + OPENAI_REVIEW_RESULT_SCHEMA를 system instructions 끝에
// 추가해서 우회했다 — 즉 "qualification을 통과한 설정"은 모델 하나가 아니라 [모델 + 이 출력
// 형식 지시]의 조합이다. 이 지시 텍스트 자체는 provider에 무관하므로(모델 이름을 언급하지
// 않는다) Fireworks/Groq 양쪽에 동일하게 적용한다.
const JSON_OUTPUT_FORMAT_DIRECTIVE = `

# 출력 형식(필수)
설명, 서론, markdown 코드펜스 없이 아래 JSON Schema를 정확히 만족하는 JSON 객체 "하나만"
출력하세요:
${JSON.stringify(OPENAI_REVIEW_RESULT_SCHEMA)}`;

function withJsonOutputFormatDirective(inner: ReviewProvider): ReviewProvider {
  return {
    id: inner.id,
    model: inner.model,
    async review(request: ReviewProviderRequest): Promise<ReviewProviderResult> {
      return inner.review({ instructions: request.instructions + JSON_OUTPUT_FORMAT_DIRECTIVE, input: request.input });
    },
  };
}

/** ZDR verified → CONFIDENTIAL(기존과 동일한 최고 수준 요구), unverified → INTERNAL(zero
 *  retention 요구사항이 적용되지 않는 Core의 기존 하위 등급) — provider-security-gate.ts의
 *  등급 서열/판정 로직은 전혀 바꾸지 않는다. */
function reviewerClassificationFor(zdrVerified: boolean): DataClassification {
  return zdrVerified ? "CONFIDENTIAL" : "INTERNAL";
}

/** retentionPolicy가 "unknown"(정보 자체가 없음)일 때만 문서로 이미 확인된 기본 동작에 맞춰
 *  "bounded"로 완화해 표시한다 — provider-pool-security-metadata.ts의 빌더 함수 자체는 전혀
 *  수정하지 않으므로 real-provider-pool.ts 등 다른 소비처는 영향받지 않는다. "zero"/"bounded"/
 *  "unbounded"는 이미 확인/판단된 값이므로 그대로 둔다(특히 "unbounded"는 완화하지 않는다 —
 *  이것이 "완전히 불명확하거나 위험한" 경우다). */
function toReviewerRegistryMetadata(metadata: ProviderSecurityMetadata): ProviderSecurityMetadata {
  if (metadata.retentionPolicy !== "unknown") return metadata;
  return { ...metadata, retentionPolicy: "bounded", maxRetentionDays: 30 };
}

/** gpt-reviewer.ts의 Provider Security Gate 호출(primary=Fireworks 판정)과
 *  final-reviewer-routing.ts의 escalationSecurityCheck(escalation=Groq 판정)가 공유하는 단일
 *  registry — 두 곳 모두 이 함수 하나로 metadata를 조립해, 같은 provider에 대해 서로 다른
 *  metadata가 쓰이는 drift를 구조적으로 막는다. 등록되지 않은 provider는 이 registry에 없으므로
 *  evaluateProviderSecurity()가 PROVIDER_UNKNOWN으로 BLOCK한다. */
export function resolveFinalReviewerProductionSecurityRegistry(env: NodeJS.ProcessEnv = process.env): ProviderSecurityRegistry {
  const fireworksMetadata = toReviewerRegistryMetadata(buildFireworksProviderSecurityMetadata(env));
  const groqMetadata = toReviewerRegistryMetadata(buildGroqProviderSecurityMetadata(env));
  return { [fireworksMetadata.providerId]: fireworksMetadata, [groqMetadata.providerId]: groqMetadata };
}

/**
 * production Final Reviewer ReviewProvider(routing 포함)를 만든다. httpFetch를 지정하지
 * 않으면 각 provider factory의 기본값(nodeChatCompletionHttpFetch, 실제 네트워크)을 그대로
 * 쓴다 — 이 파라미터는 오직 테스트가 실제 네트워크 없이 이 selection/routing 자체를 검증하기
 * 위한 주입 지점이다(§ chat-completion-review-provider.ts ChatCompletionHttpFetch와 동일한
 * 설계 원칙 — 실제 운용 기본값을 바꾸지 않는다).
 */
export function createFinalReviewerProductionProvider(
  env: NodeJS.ProcessEnv = process.env,
  httpFetch?: ChatCompletionHttpFetch
): ReviewProvider {
  const primaryProvider = withJsonOutputFormatDirective(createFireworksReviewProvider(FINAL_REVIEWER_PRIMARY_MODEL, httpFetch, env));
  const escalationProvider = withJsonOutputFormatDirective(createGroqReviewProvider(FINAL_REVIEWER_ESCALATION_MODEL, httpFetch, env));

  // finalReviewerProductionProvider는 module import 시점에 한 번만 만들어지는 singleton이다 —
  // 이 함수(createFinalReviewerProductionProvider) 자체는 한 번만 호출되므로, registry/
  // classification을 여기서 즉시 계산해 값으로 고정하면 이후 env가 바뀌어도(테스트의 env
  // 조작 등) 반영되지 않는다. 그래서 아래 두 closure는 실제로 호출되는 시점(escalation 판정
  // 직전/매 review() 직전)에 매번 다시 계산한다 — API key를 review() 호출 시점에만 읽는 기존
  // lazy 원칙과 동일하다.
  const routingProvider = createFinalReviewerRoutingProvider({
    primaryProvider,
    escalationProvider,
    escalationSecurityCheck: () =>
      evaluateProviderSecurity(
        { classification: reviewerClassificationFor(resolveGroqZdrVerification(env).verified), providerId: FINAL_REVIEWER_ESCALATION_PROVIDER_ID },
        resolveFinalReviewerProductionSecurityRegistry(env)
      ),
  });

  // gpt-reviewer.ts의 outer Provider Security Gate 호출이 이 값을 읽는다(§ review-provider.ts
  // ReviewProvider.reviewerDataClassification, gpt-reviewer.ts dataClassification 우선순위).
  return { ...routingProvider, reviewerDataClassification: () => reviewerClassificationFor(resolveFireworksZdrVerification(env).verified) };
}

// production default — 이 파일을 import하는 시점에 실제 네트워크 요청/자격증명 읽기를 하지
// 않는다(각 provider factory도 { id, model, review } 객체만 만들 뿐, 실제 API key는 review()
// 호출이 실제로 필요한 시점에만 env에서 읽는다).
export const finalReviewerProductionProvider: ReviewProvider = createFinalReviewerProductionProvider();
