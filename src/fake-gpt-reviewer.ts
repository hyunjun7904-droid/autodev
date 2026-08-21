import type { ClaudeResult, GptReviewResult } from "./types";

// Step 1의 fake/mock 구현 — AUTOMATION_DRY_RUN=true(기본값)일 때 orchestrator가 사용한다.
// 실제 OpenAI API를 호출하지 않는다. 1차 리뷰는 항상 REVISE, 2차부터는 PASS로 고정했다 —
// 정상 흐름 테스트 시나리오(1차 REVISE → 2차 PASS)를 재현 가능하게 만들기 위함이다.
export async function reviewClaudeResult(
  result: ClaudeResult,
  reviewCycle: number
): Promise<GptReviewResult> {
  void result;

  if (reviewCycle <= 1) {
    return {
      decision: "REVISE",
      severity: { critical: 0, high: 0, medium: 1 },
      feedback: "[FAKE GPT] 테스트 커버리지 보강이 필요합니다.",
      nextTask: "테스트 케이스를 보강해 재구현",
    };
  }

  return {
    decision: "PASS",
    severity: { critical: 0, high: 0, medium: 0 },
    feedback: "[FAKE GPT] 리뷰 통과.",
    nextTask: null,
  };
}
