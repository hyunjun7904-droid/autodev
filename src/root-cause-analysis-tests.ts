import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSafeExecutorContext } from "./safe-executor";
import type { SafeExecutorContext } from "./safe-executor";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { ClaudeResult, DurableFailureState } from "./types";
import type { GptReviewerReturn } from "./orchestrator";
import {
  computeReviewCycleFingerprint,
  createReviewCallLimiter,
  classifyRootCause,
  runLocalVerificationBeforeFireworksRecall,
  wrapGptReviewerWithFireworksCallLimiter,
  type RootCauseAnalysisEvent,
} from "./root-cause-analysis";

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function passingTests(names: string[]): ClaudeResult["tests"] {
  return names.map((name) => ({ name, pass: true }));
}
function failingTest(name: string, command: string, exitCode: number, stderrTail: string): ClaudeResult["tests"] {
  return [{ name, pass: false, failureEvidence: { command, exitCode, stderrTail } }];
}
function neverExecutedFailingTest(name: string): ClaudeResult["tests"] {
  return [{ name, pass: false }];
}

function fakeResult(overrides: Partial<ClaudeResult> = {}): ClaudeResult {
  return {
    success: true,
    summary: "fixture",
    changedFiles: ["backend/device-trust/device-trust-manager.mjs"],
    tests: passingTests(["device-trust-registration-tests", "device-trust-revocation-tests"]),
    rawOutput: "",
    ...overrides,
  };
}

// RECOVERY_APPLIED 판정(§ 요구사항 20)은 attempt의 summary/changedFiles 조합으로 "이전과
// 구분되는 새 시도인지"를 판단한다 — 각 시나리오에서 cycle마다 다른 summary를 부여해 서로
// 다른 Developer attempt를 표현한다(실제 운영에서는 Claude가 매 attempt마다 새 summary를
// 만든다).
function attemptResult(label: string, overrides: Partial<ClaudeResult> = {}): ClaudeResult {
  return fakeResult({ summary: `attempt:${label}`, ...overrides });
}

function reviseResult(feedback: string, severity = { critical: 0, high: 0, medium: 1 }): GptReviewerReturn {
  return { decision: "REVISE", severity, feedback, nextTask: null, requestAttempted: true };
}
function passResult(): GptReviewerReturn {
  return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "ok", nextTask: null, requestAttempted: true };
}

const POLICY: ProjectExecutionPolicy = { allowedReadPrefixes: ["backend/"], allowedWritePrefixes: ["backend/"], allowedCommands: [] };
function makeExecutor(root: string): SafeExecutorContext {
  return createSafeExecutorContext(root, POLICY);
}
function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), "autodev-rca-"));
}

// ---------------------------------------------------------------------------
// computeReviewCycleFingerprint / createReviewCallLimiter — determinism.
// ---------------------------------------------------------------------------
function scenarioFingerprintDeterministicForSameInput(): void {
  const tests = passingTests(["t1"]);
  const a = computeReviewCycleFingerprint("2.1", { severity: { critical: 0, high: 1, medium: 0 }, feedback: "add locking" }, tests);
  const b = computeReviewCycleFingerprint("2.1", { severity: { critical: 0, high: 1, medium: 0 }, feedback: "add locking" }, tests);
  check("동일 입력은 항상 동일 fingerprint(순수 함수)", a === b);
}

function scenario7_NewFindingProducesNewFingerprint(): void {
  const tests = passingTests(["t1"]);
  const a = computeReviewCycleFingerprint("2.1", { severity: { critical: 0, high: 1, medium: 0 }, feedback: "add optimistic locking to registerDevice" }, tests);
  const b = computeReviewCycleFingerprint("2.1", { severity: { critical: 1, high: 0, medium: 0 }, feedback: "SQL injection in getDeviceById query" }, tests);
  check("7) 완전히 새로운 실제 finding은 새로운 fingerprint를 만듦", a !== b);
}

// ---------------------------------------------------------------------------
// classifyRootCause — §16 분류.
// ---------------------------------------------------------------------------
function scenario8_ParseErrorClassifiedAsDeveloperResponseParseError(): void {
  const category = classifyRootCause({ claudeErrorCode: "PROTOCOL_ERROR", tests: passingTests(["t1"]) });
  check("8) UNRECOGNIZED_SHAPE/PROTOCOL_ERROR는 DEVELOPER_RESPONSE_PARSE_ERROR로 분류됨(Fireworks 호출과 무관)", category === "DEVELOPER_RESPONSE_PARSE_ERROR");
}

function scenario9_MissingScriptClassifiedAsInfrastructure(): void {
  const category = classifyRootCause({ tests: neverExecutedFailingTest("device-trust-revocation-tests") });
  check("9) required test 명령이 spawn조차 되지 못함(missing script) → INFRASTRUCTURE_CONFIGURATION", category === "INFRASTRUCTURE_CONFIGURATION");
}

function scenario10_SecurityBlockedClassifiedAsSecurityOrPolicy(): void {
  const category = classifyRootCause({ gptErrorCode: "PROVIDER_SECURITY_BLOCKED", tests: passingTests(["t1"]) });
  check("10) PROVIDER_SECURITY_BLOCKED → SECURITY_OR_POLICY(자동 승인 대상 아님)", category === "SECURITY_OR_POLICY");
}

function scenario11_ProviderRateLimitNotMisclassifiedAsImplementation(): void {
  const category = classifyRootCause({ claudeErrorCode: "TIMEOUT", tests: [] });
  check("11) Provider rate limit/timeout은 PROVIDER_ERROR로 분류되고 IMPLEMENTATION_ERROR로 오분류되지 않음", category === "PROVIDER_ERROR");
}

function scenarioRegistrationDriftClassified(): void {
  const category = classifyRootCause({ requiredTestRegistrationDrift: true, tests: passingTests(["t1"]) });
  check("registration drift는 REQUIRED_TEST_REGISTRATION_DRIFT로 분류됨", category === "REQUIRED_TEST_REGISTRATION_DRIFT");
}

function scenarioPlainImplementationDefault(): void {
  const category = classifyRootCause({ tests: passingTests(["t1"]) });
  check("특별한 신호가 없고 required test는 통과한 상태의 REVISE는 IMPLEMENTATION_ERROR로 안전하게 기본 분류됨", category === "IMPLEMENTATION_ERROR");
}

// ---------------------------------------------------------------------------
// runLocalVerificationBeforeFireworksRecall
// ---------------------------------------------------------------------------
function scenario4_FailingRequiredTestBlocksLocalVerification(): void {
  const result = fakeResult({ tests: failingTest("device-trust-revocation-tests", "npm run test:x", 1, "AssertionError: expected true") });
  const v = runLocalVerificationBeforeFireworksRecall(result, ["backend/device-trust/"], undefined);
  check("4) required test가 여전히 실패하면 로컬 검증 FAIL(Fireworks 재호출 금지 신호)", v.pass === false);
}

function scenarioScopeViolationBlocksLocalVerification(): void {
  const result = fakeResult({ changedFiles: ["src/outside/evil.ts"] });
  const v = runLocalVerificationBeforeFireworksRecall(result, ["backend/device-trust/"], undefined);
  check("허용 경로 밖 변경이 있으면 로컬 검증 FAIL", v.pass === false);
}

function scenarioSecretInChangedFileBlocksLocalVerification(): void {
  const root = makeRoot();
  try {
    mkdirSync(join(root, "backend", "device-trust"), { recursive: true });
    const relPath = "backend/device-trust/leaky.mjs";
    writeFileSync(join(root, relPath), 'const accessKeyId = "AKIAIOSFODNN7EXAMPLE";\n', "utf-8");
    const executor = makeExecutor(root);
    const result = fakeResult({ changedFiles: [relPath] });
    const v = runLocalVerificationBeforeFireworksRecall(result, ["backend/device-trust/"], executor);
    check("변경 파일에 secret 패턴이 있으면 로컬 검증 FAIL", v.pass === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioCleanChangeSetPassesLocalVerification(): void {
  const root = makeRoot();
  try {
    mkdirSync(join(root, "backend", "device-trust"), { recursive: true });
    const relPath = "backend/device-trust/device-trust-manager.mjs";
    writeFileSync(join(root, relPath), "export function registerDevice() { return true; }\n", "utf-8");
    const executor = makeExecutor(root);
    const result = fakeResult({ changedFiles: [relPath] });
    const v = runLocalVerificationBeforeFireworksRecall(result, ["backend/device-trust/"], executor);
    check("required test 통과 + scope 안 + secret 없음 → 로컬 검증 PASS", v.pass === true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// wrapGptReviewerWithFireworksCallLimiter — end-to-end scenarios 1~6.
// ---------------------------------------------------------------------------
async function runWrapperScenarios(): Promise<void> {
  const root = makeRoot();
  try {
    mkdirSync(join(root, "backend", "device-trust"), { recursive: true });
    const relPath = "backend/device-trust/device-trust-manager.mjs";
    writeFileSync(join(root, relPath), "export function registerDevice() { return true; }\n", "utf-8");
    const executor = makeExecutor(root);

    let innerCallCount = 0;
    const events: RootCauseAnalysisEvent[] = [];
    // 실제 Fireworks 대신 fixture: 처음 두 번은 같은 REVISE(동일 문제), 세 번째 실제 호출
    // (RCA 로컬 검증 통과 후)은 PASS를 반환한다.
    const innerResponses: GptReviewerReturn[] = [
      reviseResult("동시성 처리가 없어 race condition이 발생할 수 있습니다"),
      reviseResult("동시성 처리가 없어 race condition이 발생할 수 있습니다"),
      passResult(),
    ];
    const inner = async (): Promise<GptReviewerReturn> => {
      innerCallCount += 1;
      return innerResponses[Math.min(innerCallCount - 1, innerResponses.length - 1)];
    };

    const wrapped = wrapGptReviewerWithFireworksCallLimiter(inner, {
      taskId: "2.1",
      executor,
      onRootCauseAnalysis: (e) => events.push(e),
    });

    // 1) 첫 REVISE — 정상적으로 Fireworks를 호출한다.
    const r1 = await wrapped(attemptResult("1", { changedFiles: [relPath] }), 1, "task", ["backend/device-trust/"], undefined, 1, 1, undefined);
    check("1) 첫 번째 REVISE는 실제로 Fireworks(inner)를 호출함", innerCallCount === 1 && r1.decision === "REVISE");

    // 2) 두 번째(동일 fingerprint) REVISE — 여전히 실제로 호출된다(2회까지는 허용).
    const r2 = await wrapped(attemptResult("2", { changedFiles: [relPath] }), 2, "task", ["backend/device-trust/"], undefined, 2, 2, undefined);
    check("2) 두 번째 동일 REVISE도 실제로 Fireworks(inner)를 호출함(아직 2회 이하)", innerCallCount === 2 && r2.decision === "REVISE");
    check("2) 두 번째 호출 이후 RCA가 트리거되어 onRootCauseAnalysis가 즉시 알림", events.some((e) => e.triggered && e.localVerification === undefined));

    // 3) 세 번째 호출 시도 — Developer가 새 attempt("3")를 냈고(RECOVERY_APPLIED=YES) 로컬 검증도
    //    통과하는 상태(required test pass/scope ok/secret 없음)이므로 재검증 1회를 허용한다.
    const r3 = await wrapped(attemptResult("3", { changedFiles: [relPath] }), 3, "task", ["backend/device-trust/"], undefined, 3, 3, undefined);
    check("5) 로컬 검증 통과 후 재검증 1회로 실제 Fireworks를 호출함(innerCallCount=3)", innerCallCount === 3);
    check("5) 재검증 결과가 PASS로 반환됨", r3.decision === "PASS");
    check("로컬 검증 PASS 이벤트가 기록됨", events.some((e) => e.localVerification === "PASS"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function runWrapperScenario_LocalVerificationFailsBlocksThirdCall(): Promise<void> {
  let innerCallCount = 0;
  const events: RootCauseAnalysisEvent[] = [];
  const inner = async (): Promise<GptReviewerReturn> => {
    innerCallCount += 1;
    return reviseResult("동일한 audit logging 문제가 반복됩니다");
  };
  const wrapped = wrapGptReviewerWithFireworksCallLimiter(inner, { taskId: "2.1", onRootCauseAnalysis: (e) => events.push(e) });

  // required test가 계속 실패하는 상태 — Developer가 매번 새로 시도해도(RECOVERY_APPLIED=YES)
  // 로컬 검증(required tests)이 통과할 수 없다.
  const stillFailingTests = failingTest("device-trust-revocation-tests", "npm run test:x", 1, "AssertionError");

  await wrapped(attemptResult("1", { tests: stillFailingTests }), 1, "task", [], undefined, 1, 1, undefined); // 1회차
  await wrapped(attemptResult("2", { tests: stillFailingTests }), 2, "task", [], undefined, 2, 2, undefined); // 2회차, RCA 트리거
  const r3 = await wrapped(attemptResult("3", { tests: stillFailingTests }), 3, "task", [], undefined, 3, 3, undefined); // 3회차 — 새 attempt지만 여전히 test 실패

  check("3/4) required test가 여전히 실패하면 세 번째 호출에서 Fireworks(inner)를 호출하지 않음", innerCallCount === 2);
  check("3/4) 대신 합성된 REVISE가 반환되어 Developer 재시도로 되돌아감", r3.decision === "REVISE");
  check("3/4) 이 합성 REVISE는 실제 provider 요청을 시도하지 않았다고 표시함(requestAttempted=false)", (r3 as { requestAttempted?: boolean }).requestAttempted === false);

  const r4 = await wrapped(attemptResult("4", { tests: stillFailingTests }), 4, "task", [], undefined, 4, 4, undefined); // 4회차 — 여전히 로컬 실패
  check("3) RCA 상태가 유지되는 동안 계속 Fireworks 호출 0회", innerCallCount === 2 && r4.decision === "REVISE");
}

async function runWrapperScenario_RecoveryNotAppliedBlocksRecall(): Promise<void> {
  let innerCallCount = 0;
  const inner = async (): Promise<GptReviewerReturn> => {
    innerCallCount += 1;
    return reviseResult("동일한 audit logging 문제가 반복됩니다");
  };
  const wrapped = wrapGptReviewerWithFireworksCallLimiter(inner, { taskId: "2.1" });

  await wrapped(attemptResult("1"), 1, "task", [], undefined, 1, 1, undefined);
  await wrapped(attemptResult("2"), 2, "task", [], undefined, 2, 2, undefined); // RCA 트리거, baseline=attempt 2

  // Developer가 이전과 구분되지 않는 산출물(동일 summary/changedFiles)을 그대로 다시 낸 경우 —
  // 로컬 검사만 보면 통과할 수 있는 상태라도 RECOVERY_APPLIED=NO이므로 재호출을 허용하지 않는다.
  const unchanged = attemptResult("2");
  const r3 = await wrapped(unchanged, 3, "task", [], undefined, 3, 3, undefined);
  check("RECOVERY_APPLIED=NO(직전과 구분되지 않는 산출물)이면 로컬 검사 통과 여부와 무관하게 재호출하지 않음", innerCallCount === 2 && r3.decision === "REVISE");
}

async function runWrapperScenario_RepeatAfterRevalidationTriggersRcaAgain(): Promise<void> {
  const root = makeRoot();
  try {
    mkdirSync(join(root, "backend", "device-trust"), { recursive: true });
    const relPath = "backend/device-trust/device-trust-manager.mjs";
    writeFileSync(join(root, relPath), "export function registerDevice() { return true; }\n", "utf-8");
    const executor = makeExecutor(root);

    let innerCallCount = 0;
    const events: RootCauseAnalysisEvent[] = [];
    // 재검증 호출(3번째 실제 호출)도 동일 fingerprint의 REVISE를 다시 반환한다 — 6번 시나리오.
    const inner = async (): Promise<GptReviewerReturn> => {
      innerCallCount += 1;
      return reviseResult("동시성 처리가 없어 race condition이 발생할 수 있습니다");
    };
    const wrapped = wrapGptReviewerWithFireworksCallLimiter(inner, {
      taskId: "2.1",
      executor,
      onRootCauseAnalysis: (e) => events.push(e),
    });

    await wrapped(attemptResult("1", { changedFiles: [relPath] }), 1, "task", ["backend/device-trust/"], undefined, 1, 1, undefined);
    await wrapped(attemptResult("2", { changedFiles: [relPath] }), 2, "task", ["backend/device-trust/"], undefined, 2, 2, undefined); // RCA 트리거, baseline=attempt 2
    const attempt3 = attemptResult("3", { changedFiles: [relPath] });
    const r3 = await wrapped(attempt3, 3, "task", ["backend/device-trust/"], undefined, 3, 3, undefined); // 새 attempt + 로컬 검증 PASS → 재검증(3번째 실제 호출)
    check("6) 재검증 호출이 실제로 이뤄짐", innerCallCount === 3 && r3.decision === "REVISE");

    // 재검증(3번째 실제 호출)이 다시 동일 fingerprint의 REVISE를 반환했으므로 baseline이
    // attempt 3으로 갱신되며 다시 RCA 상태가 된다. Developer가 attempt 3과 구분되지 않는
    // 산출물을 그대로 다시 내면(예: 같은 코드를 다시 제출) RECOVERY_APPLIED=NO로 막혀야 한다.
    const r4 = await wrapped(attemptResult("3", { changedFiles: [relPath] }), 4, "task", ["backend/device-trust/"], undefined, 4, 4, undefined);
    check("6) 재검증에서 동일 실패가 반복된 뒤 구분되지 않는 재제출은 다시 RCA로 막혀 네 번째 호출은 Fireworks를 부르지 않음", innerCallCount === 3 && r4.decision === "REVISE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// AutoDev / JARVIS 최종 무인개발 구조 보완 — durable seed로 RCA-pending 상태를 복원(§
// 요구사항 19, 30 "재시작해도 Fireworks count 보존"). 프로세스가 RCA 트리거 직후(3번째
// 호출을 막아야 하는 상태) 죽었다가 다시 시작된 상황을 흉내낸다 — 새 wrapper 인스턴스의
// 첫 호출임에도 durable seed만으로 즉시 3번째 실제 호출을 차단해야 한다.
// ---------------------------------------------------------------------------
async function scenarioDurableSeedBlocksThirdCallAfterRestart(): Promise<void> {
  let innerCallCount = 0;
  const inner = async (): Promise<GptReviewerReturn> => {
    innerCallCount += 1;
    return reviseResult("동일한 audit logging 문제가 반복됩니다");
  };
  const seed: DurableFailureState = {
    taskId: "2.2",
    failureFingerprint: "seeded-fp",
    sameFailureCount: 2,
    rootCauseAnalysisCount: 1,
    providerTimeoutCount: 0,
    unexpectedExitCount: 1,
    pendingRootCauseCategory: "IMPLEMENTATION_ERROR",
    // fakeResult()의 기본 changedFiles(backend/device-trust/device-trust-manager.mjs)까지
    // 포함한 실제 snapshot key 형식과 정확히 일치해야 한다(§ computeAttemptSnapshotKey).
    pendingSnapshotKey: "attempt:seeded-prior::backend/device-trust/device-trust-manager.mjs",
    lastRecoveryAction: "구현 결함으로 분류됨",
    updatedAt: new Date().toISOString(),
  };
  const wrapped = wrapGptReviewerWithFireworksCallLimiter(inner, { taskId: "2.2", initialDurableState: seed });

  // 이 새 프로세스의 첫 attempt가 이전과 구분되지 않는 산출물(동일 snapshot)을 다시
  // 제출했다면 RECOVERY_APPLIED=NO로 즉시 막혀야 한다 — inner가 전혀 호출되지 않는다.
  const unchangedAttempt = attemptResult("seeded-prior");
  const r1 = await wrapped(unchangedAttempt, 1, "task", [], undefined, 1, 1, undefined);
  check("durable seed 복원 — 재시작 직후 첫 호출도 이전과 동일한 산출물이면 Fireworks를 호출하지 않음", innerCallCount === 0 && r1.decision === "REVISE");

  // 새로운(구분되는) attempt를 제출하고 로컬 검증도 통과하면 그제서야 재검증 1회를 허용한다.
  const r2 = await wrapped(attemptResult("seeded-new"), 2, "task", [], undefined, 2, 2, undefined);
  check("durable seed 복원 — 새 attempt + 로컬 검증 통과 후에만 재검증 1회 허용", innerCallCount === 1 && r2.decision === "REVISE");
}

function scenarioSeededLimiterContinuesCountFromDisk(): void {
  // durable-recovery-state.ts가 이미 taskId 일치를 확인한 뒤 넘긴다는 계약(§
  // resolveDurableFailureStateForReviewer, durable-recovery-state-tests.ts에서 별도 검증) —
  // 여기서는 createReviewCallLimiter가 그 seed 위에서 정상적으로 카운트를 이어간다는 것만
  // 직접 확인한다(재시작 전 repeatCount=1이었다면 재시작 후 같은 fingerprint 재관측 시
  // repeatCount=2가 되어야 트리거된다).
  const limiter = createReviewCallLimiter(2, { fingerprint: "fp-a", repeatCount: 1 });
  const observed = limiter.observeReviseFingerprint("fp-a");
  check("createReviewCallLimiter seed — 시딩된 repeatCount 위에서 정상적으로 이어서 카운트함", observed.repeatCount === 2 && observed.triggerRootCauseAnalysis === true);
}

async function main(): Promise<void> {
  scenarioFingerprintDeterministicForSameInput();
  scenario7_NewFindingProducesNewFingerprint();
  scenario8_ParseErrorClassifiedAsDeveloperResponseParseError();
  scenario9_MissingScriptClassifiedAsInfrastructure();
  scenario10_SecurityBlockedClassifiedAsSecurityOrPolicy();
  scenario11_ProviderRateLimitNotMisclassifiedAsImplementation();
  scenarioRegistrationDriftClassified();
  scenarioPlainImplementationDefault();
  scenario4_FailingRequiredTestBlocksLocalVerification();
  scenarioScopeViolationBlocksLocalVerification();
  scenarioSecretInChangedFileBlocksLocalVerification();
  scenarioCleanChangeSetPassesLocalVerification();
  await runWrapperScenarios();
  await runWrapperScenario_LocalVerificationFailsBlocksThirdCall();
  await runWrapperScenario_RecoveryNotAppliedBlocksRecall();
  await runWrapperScenario_RepeatAfterRevalidationTriggersRcaAgain();
  await scenarioDurableSeedBlocksThirdCallAfterRestart();
  scenarioSeededLimiterContinuesCountFromDisk();

  // limiter 단독 동작(§ 요구사항 — 단순 reviewCycle 증가가 아니라 fingerprint 기반).
  const limiter = createReviewCallLimiter();
  const o1 = limiter.observeReviseFingerprint("fp-a");
  const o2 = limiter.observeReviseFingerprint("fp-a");
  check("createReviewCallLimiter — 동일 fingerprint 2회째에 트리거", o1.triggerRootCauseAnalysis === false && o2.triggerRootCauseAnalysis === true);
  const o3 = limiter.observeReviseFingerprint("fp-b");
  check("createReviewCallLimiter — 새 fingerprint는 카운트를 리셋함", o3.repeatCount === 1 && o3.triggerRootCauseAnalysis === false);

  console.log("\n=== root-cause-analysis 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
