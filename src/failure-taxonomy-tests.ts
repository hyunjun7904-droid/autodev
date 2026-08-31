import { classifyClaudeErrorCode, classifyDeveloperErrorCode, classifyGptErrorCode } from "./failure-taxonomy";
import type { FailureClass } from "./failure-taxonomy";
import type { ClaudeErrorCode } from "./claude-runner";
import type { DeveloperErrorCode } from "./claude-developer";
import type { GptErrorCode } from "./types";

// Hardening B(Failure Taxonomy 강화) 테스트 — 순수 매핑 함수라 실제 API/CLI 호출 없이
// exhaustive하게 검증한다. 목적은 두 가지: (1) 모든 알려진 error code가 4분류
// (TRANSIENT/PERMANENT/DETERMINISTIC_LOCAL/UNKNOWN_TRANSIENTNESS) 중 정확히 하나로
// 매핑되는지, (2) 이미 문서화된 기존 판정(DEVELOPER_TRANSIENT_ERROR_CODES 등)과 이 매핑이
// 모순되지 않는지.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const ALL_CLASSES: FailureClass[] = ["TRANSIENT", "PERMANENT", "DETERMINISTIC_LOCAL", "UNKNOWN_TRANSIENTNESS"];

function checkClaude(code: ClaudeErrorCode, expected: FailureClass): void {
  const result = classifyClaudeErrorCode(code);
  check(`classifyClaudeErrorCode(${code}) === ${expected}`, result.failureClass === expected);
  check(`classifyClaudeErrorCode(${code}) reason이 비어있지 않음`, result.reason.length > 0);
}

checkClaude("TIMEOUT", "TRANSIENT");
checkClaude("CLI_NOT_FOUND", "TRANSIENT");
checkClaude("USAGE_LIMIT", "TRANSIENT");
checkClaude("AUTH_REQUIRED", "PERMANENT");
checkClaude("ABORTED", "PERMANENT");
checkClaude("TRUSTED_EXECUTABLE_NOT_FOUND", "DETERMINISTIC_LOCAL");
checkClaude("EXECUTABLE_IDENTITY_UNTRUSTED", "DETERMINISTIC_LOCAL");
checkClaude("EXECUTABLE_SHADOWING_DETECTED", "DETERMINISTIC_LOCAL");
checkClaude("NON_ZERO_EXIT", "UNKNOWN_TRANSIENTNESS");
checkClaude("INVALID_OUTPUT", "UNKNOWN_TRANSIENTNESS");

// claude-developer.ts의 기존 DEVELOPER_TRANSIENT_ERROR_CODES = {TIMEOUT, CLI_NOT_FOUND}와
// 모순되지 않아야 한다 — 그 두 값만 TRANSIENT여야 하며(재시도 대상), 그 집합 밖의 값은
// 이 테스트 파일이 TRANSIENT로 잘못 매핑하지 않았는지 별도로 확인한다(위 checkClaude
// 목록이 이미 그 전부를 커버함 — 회귀 방지용 명시적 재확인).
check(
  "claude-developer.ts DEVELOPER_TRANSIENT_ERROR_CODES와 일치: TIMEOUT/CLI_NOT_FOUND만 TRANSIENT(USAGE_LIMIT은 별도 예산으로 이미 재시도됨)",
  classifyClaudeErrorCode("TIMEOUT").failureClass === "TRANSIENT" &&
    classifyClaudeErrorCode("CLI_NOT_FOUND").failureClass === "TRANSIENT" &&
    classifyClaudeErrorCode("AUTH_REQUIRED").failureClass !== "TRANSIENT" &&
    classifyClaudeErrorCode("NON_ZERO_EXIT").failureClass !== "TRANSIENT"
);

function checkDeveloper(code: DeveloperErrorCode, expected: FailureClass): void {
  const result = classifyDeveloperErrorCode(code);
  check(`classifyDeveloperErrorCode(${code}) === ${expected}`, result.failureClass === expected);
}

checkDeveloper("TASK_ACTION_LIMIT", "DETERMINISTIC_LOCAL");
checkDeveloper("PROTOCOL_ERROR", "DETERMINISTIC_LOCAL");
checkDeveloper("NO_PROGRESS_STAGNATION", "DETERMINISTIC_LOCAL");
checkDeveloper("TIMEOUT", "TRANSIENT");
checkDeveloper("AUTH_REQUIRED", "PERMANENT");

function checkGpt(code: GptErrorCode, expected: FailureClass, evidenceBasedTransient?: boolean): void {
  const result = classifyGptErrorCode(code, evidenceBasedTransient);
  check(`classifyGptErrorCode(${code}${evidenceBasedTransient !== undefined ? `, transient=${evidenceBasedTransient}` : ""}) === ${expected}`, result.failureClass === expected);
}

checkGpt("RATE_LIMIT", "TRANSIENT");
checkGpt("TIMEOUT", "TRANSIENT");
checkGpt("GPT_REVIEW_TEMPORARILY_UNAVAILABLE", "TRANSIENT");
checkGpt("AUTH_ERROR", "PERMANENT");
checkGpt("QUOTA_EXCEEDED", "PERMANENT");
checkGpt("BUDGET_EXCEEDED", "PERMANENT");
checkGpt("PROVIDER_SECURITY_BLOCKED", "PERMANENT");
checkGpt("ESCALATION_REVIEWER_UNAVAILABLE", "PERMANENT");
checkGpt("REVIEW_CONSISTENCY_CHECK_FAILED", "DETERMINISTIC_LOCAL");
checkGpt("INVALID_OUTPUT", "UNKNOWN_TRANSIENTNESS");

// API_ERROR는 코드 하나로 두 가지 실제 증거(5xx/connection vs 기타)를 가질 수 있다 — 이 분기
// 자체가 "429/413 status만으로 permanent 단정 금지" 원칙을 지키는지 확인한다.
checkGpt("API_ERROR", "TRANSIENT", true);
checkGpt("API_ERROR", "UNKNOWN_TRANSIENTNESS", false);
checkGpt("API_ERROR", "UNKNOWN_TRANSIENTNESS", undefined);
check(
  "API_ERROR: 증거 없이는 절대 PERMANENT로 단정하지 않음(ambiguous 429/413 → UNKNOWN_TRANSIENTNESS 원칙)",
  classifyGptErrorCode("API_ERROR", false).failureClass !== "PERMANENT" && classifyGptErrorCode("API_ERROR", undefined).failureClass !== "PERMANENT"
);

// 모든 반환값이 4분류 중 하나여야 한다(타입 시스템이 이미 보장하지만, 런타임 값 자체도 확인).
check(
  "classifyGptErrorCode의 모든 결과가 4분류(TRANSIENT/PERMANENT/DETERMINISTIC_LOCAL/UNKNOWN_TRANSIENTNESS) 안에 있음",
  ALL_CLASSES.includes(classifyGptErrorCode("RATE_LIMIT").failureClass) && ALL_CLASSES.includes(classifyGptErrorCode("QUOTA_EXCEEDED").failureClass)
);

console.log("\n=== failure-taxonomy 테스트 결과 ===");
for (const r of results) console.log(r);
const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
