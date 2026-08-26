import {
  computeFailureFingerprint,
  computeProblemFingerprint,
  classifyFailureCategory,
  createStagnationTracker,
  buildEscalationGuidance,
} from "./failure-stagnation";
import type { ClaudeResult } from "./types";

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function tests(overrides: Partial<ClaudeResult["tests"][number]>[]): ClaudeResult["tests"] {
  return overrides.map((o) => ({ name: "t", pass: false, ...o })) as ClaudeResult["tests"];
}

// ---------------------------------------------------------------------------
// A) computeFailureFingerprint
// ---------------------------------------------------------------------------
function scenarioSameFailureProducesSameFingerprint(): void {
  const a = tests([{ name: "x", pass: false, failureEvidence: { command: "npm run test:x", exitCode: 1, stderrTail: "AssertionError: expected true\nat line 42" } }]);
  const b = tests([{ name: "x", pass: false, failureEvidence: { command: "npm run test:x", exitCode: 1, stderrTail: "AssertionError: expected true\nat line 99" } }]);
  check(
    "A) 같은 실패 원인(첫 줄 동일, 뒷부분 줄 번호만 다름)은 동일한 fingerprint",
    computeFailureFingerprint("T1", a) === computeFailureFingerprint("T1", b)
  );
}

function scenarioDifferentTaskProducesDifferentFingerprint(): void {
  const a = tests([{ name: "x", pass: false, failureEvidence: { command: "npm run test:x", exitCode: 1, stderrTail: "boom" } }]);
  check(
    "A) taskId가 다르면 나머지가 같아도 fingerprint가 다름",
    computeFailureFingerprint("T1", a) !== computeFailureFingerprint("T2", a)
  );
}

function scenarioDifferentErrorProducesDifferentFingerprint(): void {
  const a = tests([{ name: "x", pass: false, failureEvidence: { command: "npm run test:x", exitCode: 1, stderrTail: "AssertionError: expected true" } }]);
  const b = tests([{ name: "x", pass: false, failureEvidence: { command: "npm run test:x", exitCode: 1, stderrTail: "TypeError: cannot read property" } }]);
  check("A) 실제로 다른 에러 원인은 다른 fingerprint", computeFailureFingerprint("T1", a) !== computeFailureFingerprint("T1", b));
}

function scenarioPassingTestsExcludedFromFingerprint(): void {
  const a = tests([
    { name: "pass1", pass: true },
    { name: "fail1", pass: false, failureEvidence: { command: "npm run test:x", exitCode: 1, stderrTail: "boom" } },
  ]);
  const b = tests([{ name: "fail1", pass: false, failureEvidence: { command: "npm run test:x", exitCode: 1, stderrTail: "boom" } }]);
  check("A) 성공한 테스트는 fingerprint에 영향을 주지 않음", computeFailureFingerprint("T1", a) === computeFailureFingerprint("T1", b));
}

// ---------------------------------------------------------------------------
// B) classifyFailureCategory
// ---------------------------------------------------------------------------
function scenarioProviderClaudeErrorCode(): void {
  check("B) claude errorCode=TIMEOUT → PROVIDER", classifyFailureCategory("TIMEOUT", undefined, []) === "PROVIDER");
  check("B) claude errorCode=USAGE_LIMIT → PROVIDER", classifyFailureCategory("USAGE_LIMIT", undefined, []) === "PROVIDER");
}

function scenarioProviderGptErrorCode(): void {
  check("B) gpt errorCode=QUOTA_EXCEEDED → PROVIDER", classifyFailureCategory(undefined, "QUOTA_EXCEEDED", []) === "PROVIDER");
  check("B) gpt errorCode=PROVIDER_SECURITY_BLOCKED → PROVIDER", classifyFailureCategory(undefined, "PROVIDER_SECURITY_BLOCKED", []) === "PROVIDER");
}

function scenarioInfrastructureConfigurationWhenNeverExecuted(): void {
  const failedNoEvidence = tests([{ name: "x", pass: false }]); // failureEvidence 없음 = spawn조차 안 됨
  check(
    "B) required test가 spawn조차 되지 못함(failureEvidence 없음) → INFRASTRUCTURE_CONFIGURATION",
    classifyFailureCategory(undefined, undefined, failedNoEvidence) === "INFRASTRUCTURE_CONFIGURATION"
  );
}

function scenarioImplementationWhenActuallyExecutedAndFailed(): void {
  const failedWithEvidence = tests([{ name: "x", pass: false, failureEvidence: { command: "npm run test:x", exitCode: 1, stderrTail: "boom" } }]);
  check(
    "B) required test가 실제로 실행되어 실패함(exitCode/stderr 있음) → IMPLEMENTATION(TEST_LOGIC과의 구분은 의도적으로 시도하지 않음)",
    classifyFailureCategory(undefined, undefined, failedWithEvidence) === "IMPLEMENTATION"
  );
}

function scenarioUnknownWhenNoFailedTests(): void {
  check("B) 실패한 required test가 없으면 UNKNOWN", classifyFailureCategory(undefined, undefined, []) === "UNKNOWN");
}

// ---------------------------------------------------------------------------
// C) createStagnationTracker
// ---------------------------------------------------------------------------
function scenarioTrackerDetectsSecondConsecutiveRepeat(): void {
  const tracker = createStagnationTracker();
  check("C) 첫 관측은 1", tracker.observe("fp-a") === 1);
  check("C) 같은 fingerprint 두 번째 관측은 2(반복 감지 시점)", tracker.observe("fp-a") === 2);
  check("C) 같은 fingerprint 세 번째 관측은 3(계속 누적)", tracker.observe("fp-a") === 3);
}

function scenarioTrackerResetsOnDifferentFingerprint(): void {
  const tracker = createStagnationTracker();
  check("C) 첫 관측 fp-a=1", tracker.observe("fp-a") === 1);
  check("C) 다른 fingerprint(fp-b)로 바뀌면 다시 1로 리셋", tracker.observe("fp-b") === 1);
  check("C) fp-b가 반복되면 2", tracker.observe("fp-b") === 2);
}

// ---------------------------------------------------------------------------
// D) computeProblemFingerprint — cross-task/cross-project 재사용의 기반(taskId 미포함)
// ---------------------------------------------------------------------------
function scenarioProblemFingerprintExcludesTaskId(): void {
  const a = tests([{ name: "x", pass: false, failureEvidence: { command: "npm run test:x", exitCode: 1, stderrTail: "boom" } }]);
  check(
    "D) computeProblemFingerprint는 taskId 없이도 동일 조건이면 항상 동일 값",
    computeProblemFingerprint(a) === computeProblemFingerprint(a)
  );
  check(
    "D) computeFailureFingerprint(taskId, tests) === `${taskId}::${computeProblemFingerprint(tests)}`",
    computeFailureFingerprint("T1", a) === `T1::${computeProblemFingerprint(a)}`
  );
}

// ---------------------------------------------------------------------------
// E) buildEscalationGuidance
// ---------------------------------------------------------------------------
function scenarioNoGuidanceOnFirstFailure(): void {
  check("E) 1회차(repeatCount=1)는 안내 없음", buildEscalationGuidance(1, []) === undefined);
}

function scenarioSecondFailureWarnsStrategyMayBeWrong(): void {
  const guidance = buildEscalationGuidance(2, ["방법 A 시도"]);
  check("E) 2회차 안내가 존재함", typeof guidance === "string");
  check("E) 2회차 안내에 직전 시도 내용이 포함됨", (guidance ?? "").includes("방법 A 시도"));
}

function scenarioThirdFailureForbidsRepeatingStrategy(): void {
  const guidance = buildEscalationGuidance(3, ["방법 A 시도", "방법 B 시도"]) ?? "";
  check("E) 3회차 안내는 '금지'를 명시함", guidance.includes("금지"));
  check("E) 3회차 안내에 이전 실패 목록(A, B) 포함", guidance.includes("방법 A 시도") && guidance.includes("방법 B 시도"));
}

function scenarioFourthFailureRequestsReconsideringApproach(): void {
  const guidance = buildEscalationGuidance(4, ["A", "B", "C"]) ?? "";
  check("E) 4회차 이상은 구현 접근 재검토를 요구함", guidance.includes("재검토"));
}

function main(): void {
  scenarioSameFailureProducesSameFingerprint();
  scenarioDifferentTaskProducesDifferentFingerprint();
  scenarioDifferentErrorProducesDifferentFingerprint();
  scenarioPassingTestsExcludedFromFingerprint();
  scenarioProviderClaudeErrorCode();
  scenarioProviderGptErrorCode();
  scenarioInfrastructureConfigurationWhenNeverExecuted();
  scenarioImplementationWhenActuallyExecutedAndFailed();
  scenarioUnknownWhenNoFailedTests();
  scenarioTrackerDetectsSecondConsecutiveRepeat();
  scenarioTrackerResetsOnDifferentFingerprint();
  scenarioProblemFingerprintExcludesTaskId();
  scenarioNoGuidanceOnFirstFailure();
  scenarioSecondFailureWarnsStrategyMayBeWrong();
  scenarioThirdFailureForbidsRepeatingStrategy();
  scenarioFourthFailureRequestsReconsideringApproach();

  console.log("\n=== failure-stagnation 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
