import type { GptDecision, SeverityCounts } from "./types";

// Review Policy Single Source of Truth — Phase F Task F4.
//
// orchestrator.ts(runOrchestrator, production 실행경로)와 agent-orchestrator.ts
// (executeReviewerStepWithRevise, Phase F Task F2/F3)는 각자 GPT reviewer의 decision을
// 그대로 신뢰하지 않고 동일한 안전장치를 강제해왔다 — required test 실패나 critical/high가
// 있는데도 PASS가 오면 REVISE로 override하고, allowedPathPrefixes 밖 변경이 있으면 BLOCK으로
// override한다. F3까지는 이 predicate가 두 파일에 각각 인라인/미러링돼 있어 "두 실행경로가
// 앞으로 서로 달라질 위험"이 있었다 — 이 파일이 그 판정의 단일 출처다. 두 orchestrator
// 모두 이 파일의 함수만 호출하고, 자체적으로 override 규칙을 다시 구현하지 않는다.
//
// 여기서 다루지 않는 것: checkpoint.ts의 evaluateApproval()은 git commit 직전의 독립적인
// 최종 방어 게이트(Claude/GPT의 자체 보고를 다시 한번 의심하는 defense-in-depth)로,
// 의도적으로 이 판정과 별개로 유지한다 — 하나의 버그가 "REVISE로 갔어야 할 결정"과
// "commit 직전 최종 확인"을 동시에 무력화하지 않도록 하기 위함이다.

/** required test 중 하나라도 실패했는지 — tests가 비어있으면(설정된 필수 테스트가 없으면)
 *  false다("테스트가 없다"를 "실패"로 취급하지 않는다). */
export function hasFailedRequiredTest(tests: { name: string; pass: boolean }[]): boolean {
  return tests.some((t) => !t.pass);
}

export interface ReviewDecisionInput {
  decision: GptDecision;
  severity: SeverityCounts;
  /** allowedPathPrefixes 밖에서 발견된 실제 변경 파일 — 비어있지 않으면 decision과 무관하게
   *  BLOCK으로 강제한다. */
  scopeViolations?: string[];
}

/**
 * GPT reviewer의 raw decision에 Core 안전장치를 강제 적용한 최종 decision을 반환한다.
 * 순서(먼저 적용된 규칙이 우선):
 *   1) scopeViolations가 있으면 무조건 BLOCK.
 *   2) (아직 BLOCK이 아니고) severity.critical>0 또는 high>0인데 decision=PASS면 REVISE.
 *   3) (아직 BLOCK이 아니고) required test가 실패했는데 decision=PASS면 REVISE.
 *   4) (아직 BLOCK이 아니고) decision=REVISE인데 critical/high가 전혀 없고 required test도
 *      실패하지 않았다면 PASS로 완화한다(§ 아래 주석).
 * HUMAN_REQUIRED/BLOCK으로 이미 판정된 경우는 그대로 유지한다(더 완화하지 않는다) —
 * HUMAN_REQUIRED는 severity와 무관하게 "사람 판단이 필요하다"는 명시적 신호이므로 자동으로
 * PASS로 다운그레이드하지 않는다.
 *
 * AutoDev Efficiency 개선(2026-09-04, RevenueOS 실측) — RevenueOS 실제 REVISE 판정
 * 56건(리뷰어가 실제로 호출된 것만) 중 33건(59%)이 severity critical=0/high=0(주로 medium
 * 이하 스타일/의견성 지적)이었는데도 REVISE로 되돌려졌다. `.claude/CLAUDE.md`/이 저장소가
 * 이미 다른 곳(checkpoint.ts 최종 판정 등)에서 따르는 원칙 — "최종 판정은 리뷰어의 의견이
 * 아니라 실측(required test) 기준"을 REVISE 루프 자체에도 일관되게 적용한 것이다. severity가
 * critical/high를 전혀 지적하지 않았다는 것은 이미 리뷰어 자신의 판정이므로, 그 상태에서
 * decision만 REVISE로 남기는 건 "완벽하지 않으면 되돌린다"는 별도의(문서화되지 않은) 기준을
 * 몰래 적용하는 것과 같다. medium 이하 지적은 사라지지 않는다 — reviewer의 severity/reason은
 * 이 함수 호출 이후에도 호출부가 그대로 로그/이벤트/checkpoint 기록에 남긴다(§ 요구사항 —
 * "기록만 하고 통과", 별도 상태 필드를 새로 추가하지 않고 기존 기록 경로를 그대로 쓴다).
 */
export function applyReviewDecisionPolicy(input: ReviewDecisionInput, requiredTestsFailed: boolean): GptDecision {
  let decision = input.decision;
  if (input.scopeViolations && input.scopeViolations.length > 0 && decision !== "BLOCK") {
    decision = "BLOCK";
  }
  if (decision === "PASS" && (input.severity.critical > 0 || input.severity.high > 0)) {
    decision = "REVISE";
  }
  if (decision === "PASS" && requiredTestsFailed) {
    decision = "REVISE";
  }
  if (decision === "REVISE" && input.severity.critical === 0 && input.severity.high === 0 && !requiredTestsFailed) {
    decision = "PASS";
  }
  return decision;
}

/**
 * MAX_REVIEW_CYCLES 소진으로 자동 REVISE 진행이 중단됐을 때 두 실행경로가 공통으로 쓰는
 * reason 라벨. 이 상태는 "사람이 승인하면 통과"라는 의미가 아니다 — critical/high나
 * 미해결 REVISE 지적사항이 그대로 남아있을 수 있으므로, 사람이 직접 개입해 확인해야 한다는
 * 뜻이다(orchestrator.ts는 기존 WAITING_HUMAN enum을, agent-orchestrator.ts는 BLOCKED를
 * 쓰지만 — 각자의 상태 어휘가 다를 뿐 이 reason 라벨과 의미는 동일하다).
 */
export const REVIEW_CYCLE_EXHAUSTED_REASON = "REVIEW_CYCLE_EXHAUSTED";
