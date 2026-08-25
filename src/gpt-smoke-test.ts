import { reviewClaudeResult } from "./gpt-reviewer";
import { FINAL_REVIEWER_PRODUCTION_PROVIDER_ID, FINAL_REVIEWER_PRODUCTION_MODEL } from "./final-reviewer-provider-selection";
import type { ClaudeResult } from "./types";

// production Final Reviewer entry point(reviewClaudeResult = reviewClaudeResultWithRetry,
// provider/securityGateOverrides 모두 생략 — orchestrator.ts/agent-orchestrator.ts와 정확히
// 동일한 호출 형태)를 통해 실제 API를 딱 1회만 호출한다(재시도가 실제로 발생하면 그만큼
// 추가 호출될 수 있음 — 기존 reviewClaudeResultWithRetry의 transient retry 정책 그대로,
// 이 스크립트가 별도 retry/backoff를 구현하지 않는다). Production Final Reviewer Wiring
// Task 이후 이 경로는 Groq(openai/gpt-oss-120b, § final-reviewer-provider-selection.ts)로
// 연결되어 있다 — benchmark runner(final-reviewer-benchmark-groq.ts)는 쓰지 않는다. 키 값은
// 절대 출력하지 않는다(provider가 process.env.GROQ_API_KEY를 내부적으로 읽을 뿐, 이 파일은
// 접근하지 않는다).
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
  // 실제로 응답을 받은 경로(errorCode 없음)에서만 provider identity를 확인한다 — 이 값은
  // 실제 API 응답이 echo한 값이지, 이 스크립트가 요청한 값을 그대로 옮긴 것이 아니다(§
  // review-provider.ts ReviewProviderModelIdentity 주석과 동일한 원칙).
  const providerIdentityOk =
    result.errorCode !== undefined || (result.model?.provider === FINAL_REVIEWER_PRODUCTION_PROVIDER_ID && result.model?.name === FINAL_REVIEWER_PRODUCTION_MODEL);

  console.log("=== Production Final Reviewer smoke test 결과 ===");
  console.log(`[${!result.errorCode ? "PASS" : "FAIL"}] API 호출 성공(errorCode 없음)`);
  console.log(`[${validDecision ? "PASS" : "FAIL"}] decision 유효한 enum 값(${result.decision})`);
  console.log(`[${structureOk ? "PASS" : "FAIL"}] severity/feedback 구조 파싱 성공`);
  console.log(
    `[${providerIdentityOk ? "PASS" : "FAIL"}] 응답 provider/model이 production 기대값과 일치(provider=${result.model?.provider ?? "(없음)"}, model=${
      result.model?.name ?? "(없음)"
    }, 기대: ${FINAL_REVIEWER_PRODUCTION_PROVIDER_ID}/${FINAL_REVIEWER_PRODUCTION_MODEL})`
  );
  if (result.errorCode) console.log(`errorCode: ${result.errorCode}`);

  const allPass = !result.errorCode && validDecision && structureOk && providerIdentityOk;
  if (!allPass) process.exitCode = 1;
}

main();
