import { reviewClaudeResult } from "./gpt-reviewer";
import type { ClaudeResult } from "./types";

// 실제 OpenAI API 호출은 이 파일에서 딱 1회만 수행한다. 키 값은 절대 출력하지 않는다
// (client가 process.env.OPENAI_API_KEY를 내부적으로 읽을 뿐, 이 파일은 접근하지 않는다).
const PROBE_RESULT: ClaudeResult = {
  success: true,
  summary: "probe: 실제 코드 변경 없음 — GPT reviewer 구조 검증 전용 smoke test.",
  changedFiles: [],
  tests: [{ name: "probe-noop", pass: true }],
  rawOutput: "[SMOKE TEST PROBE] no real changes",
};

async function main(): Promise<void> {
  const result = await reviewClaudeResult(
    PROBE_RESULT,
    1,
    "GPT reviewer smoke test probe — 실제 작업 아님, decision=PASS 파싱만 확인"
  );

  const validDecision = (["PASS", "REVISE", "HUMAN_REQUIRED", "BLOCK"] as const).includes(
    result.decision as "PASS" | "REVISE" | "HUMAN_REQUIRED" | "BLOCK"
  );
  const structureOk =
    typeof result.feedback === "string" &&
    typeof result.severity?.critical === "number" &&
    typeof result.severity?.high === "number" &&
    typeof result.severity?.medium === "number";

  console.log("=== GPT smoke test 결과 ===");
  console.log(`[${!result.errorCode ? "PASS" : "FAIL"}] API 호출 성공(errorCode 없음)`);
  console.log(`[${validDecision ? "PASS" : "FAIL"}] decision 유효한 enum 값(${result.decision})`);
  console.log(`[${structureOk ? "PASS" : "FAIL"}] severity/feedback 구조 파싱 성공`);
  if (result.errorCode) console.log(`errorCode: ${result.errorCode}`);

  const allPass = !result.errorCode && validDecision && structureOk;
  if (!allPass) process.exitCode = 1;
}

main();
