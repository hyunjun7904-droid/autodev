import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeveloperTaskWithRetry, isTransientDeveloperFailure } from "./claude-developer";
import type { DeveloperResult } from "./claude-developer";
import { runOrchestrator } from "./orchestrator";
import type { GptReviewerReturn } from "./orchestrator";
import { DEFAULT_STATE_PATH } from "./state";
import type { ClaudeResult, GptReviewResult } from "./types";

// AutoDev 신뢰성 수정(2026-08-26, Part B/C/D) — Claude Developer transient retry policy 테스트.
// gpt-retry-tests.ts(§ GPT reviewer transient retry)와 동일한 관례: 실제 project-state.json은
// 절대 건드리지 않고(OS 임시 디렉터리에 만든 별도 project-state.json만 사용), 끝에서 실제
// 파일 내용이 실행 전후 완전히 동일한지 비교해 증명한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-developer-retry-test-"));
  tempDirs.push(dir);
  const statePath = join(dir, "project-state.json");
  const initial = {
    project: "AutoDev (TEST)",
    currentPhase: 1,
    phase10Allowed: true,
    migrationsApplied: [],
    migrationsImmutable: true,
    devSupabaseCreated: true,
    devSupabaseConnected: false,
    microsoftConnected: false,
    productionDeployAllowed: false,
    gitCheckpoint: "test",
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "IDLE",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
  };
  writeFileSync(statePath, JSON.stringify(initial, null, 2) + "\n", "utf-8");
  return statePath;
}

function developerResult(overrides: Partial<DeveloperResult>): DeveloperResult {
  return {
    success: false,
    summary: "(no summary)",
    changedFiles: [],
    tests: [],
    rawOutput: "",
    ...overrides,
  };
}

const SUCCESS_RESULT: DeveloperResult = developerResult({ success: true, summary: "구현 완료", changedFiles: ["a.ts"] });
const TIMEOUT_RESULT: DeveloperResult = developerResult({ errorCode: "TIMEOUT", summary: "timeout 300000ms 초과로 강제 종료됨" });
const AUTH_REQUIRED_RESULT: DeveloperResult = developerResult({ errorCode: "AUTH_REQUIRED", summary: "로그인이 필요합니다" });

function makeSequence(items: DeveloperResult[]): {
  attempt: (task: string, attempt: number) => Promise<DeveloperResult>;
  callCount: () => number;
} {
  let i = 0;
  return {
    attempt: async () => {
      const item = items[Math.min(i, items.length - 1)];
      i++;
      return item;
    },
    callCount: () => i,
  };
}

const FAKE_PASS_REVIEW: GptReviewResult = {
  decision: "PASS",
  severity: { critical: 0, high: 0, medium: 0 },
  feedback: "ok",
  nextTask: null,
};

// ---- runDeveloperTaskWithRetry() 자체 단위 테스트 ----

async function scenarioClassification(): Promise<void> {
  check("분류: TIMEOUT은 transient", isTransientDeveloperFailure(TIMEOUT_RESULT) === true);
  check("분류: CLI_NOT_FOUND는 transient", isTransientDeveloperFailure(developerResult({ errorCode: "CLI_NOT_FOUND" })) === true);
  check("분류: AUTH_REQUIRED는 non-transient(사람 승인 필요)", isTransientDeveloperFailure(AUTH_REQUIRED_RESULT) === false);
  check("분류: NON_ZERO_EXIT는 non-transient(결정적 오류로 취급)", isTransientDeveloperFailure(developerResult({ errorCode: "NON_ZERO_EXIT" })) === false);
  check("분류: INVALID_OUTPUT은 non-transient(malformed 응답)", isTransientDeveloperFailure(developerResult({ errorCode: "INVALID_OUTPUT" })) === false);
  check(
    "분류: EXECUTABLE_IDENTITY_UNTRUSTED는 non-transient(보안 성격)",
    isTransientDeveloperFailure(developerResult({ errorCode: "EXECUTABLE_IDENTITY_UNTRUSTED" })) === false
  );
  check("분류: TASK_ACTION_LIMIT은 non-transient(결정적 애플리케이션 문제)", isTransientDeveloperFailure(developerResult({ errorCode: "TASK_ACTION_LIMIT" })) === false);
  check(
    "분류: USAGE_LIMIT은 이 재시도 대상이 아님(자체 재시도 예산을 이미 다 쓴 뒤에만 여기 도달)",
    isTransientDeveloperFailure(developerResult({ errorCode: "USAGE_LIMIT" })) === false
  );
  check("분류: success:true는 항상 non-transient(재시도 불필요)", isTransientDeveloperFailure(SUCCESS_RESULT) === false);
}

// D.1 — 첫 TIMEOUT이 즉시 실패로 끝나지 않는다(재시도해서 성공).
async function scenarioFirstTimeoutRetries(): Promise<void> {
  const seq = makeSequence([TIMEOUT_RESULT, SUCCESS_RESULT]);
  let sleepCalls = 0;
  const result = await runDeveloperTaskWithRetry("task A", 1, {}, { attempt: seq.attempt, sleep: async () => { sleepCalls += 1; } });
  check("D.1: 1회 TIMEOUT 후 2회째 성공 → 최종 success:true", result.success === true);
  check("D.1: attempt 정확히 2회(초기 1회 + 재시도 1회)", seq.callCount() === 2);
  check("D.1: sleep 정확히 1회", sleepCalls === 1);
}

// D.2 — 두 번째로 허용된 재시도도 실제로 재시도된다.
async function scenarioSecondRetryStillRetries(): Promise<void> {
  const seq = makeSequence([TIMEOUT_RESULT, TIMEOUT_RESULT, SUCCESS_RESULT]);
  let sleepCalls = 0;
  const result = await runDeveloperTaskWithRetry("task B", 1, {}, { attempt: seq.attempt, sleep: async () => { sleepCalls += 1; } });
  check("D.2: 2회 연속 TIMEOUT 후 3회째 성공 → 최종 success:true", result.success === true);
  check("D.2: attempt 정확히 3회(초기 1회 + 재시도 2회 = 정책상 최대)", seq.callCount() === 3);
  check("D.2: sleep 정확히 2회", sleepCalls === 2);
}

// D.3 / D.7 — 재시도 소진(3회 모두 TIMEOUT) → 실패로 반환, 4번째 시도는 없음(무한 재시도 아님).
async function scenarioExhaustionNoInfiniteRetry(): Promise<void> {
  const seq = makeSequence([TIMEOUT_RESULT, TIMEOUT_RESULT, TIMEOUT_RESULT, TIMEOUT_RESULT, TIMEOUT_RESULT]);
  let sleepCalls = 0;
  const result = await runDeveloperTaskWithRetry("task C", 1, {}, { attempt: seq.attempt, sleep: async () => { sleepCalls += 1; } });
  check("D.3: 3회 모두 TIMEOUT → 최종 success:false", result.success === false);
  check("D.7: attempt 정확히 3회만(무한 재시도 아님 — sequence에 5개를 채워도 3개만 소비)", seq.callCount() === 3);
  check("D.7: sleep 정확히 2회(3회 시도 사이에만 대기)", sleepCalls === 2);
  check("D.3: errorCode는 마지막 실제 오류(TIMEOUT) 그대로 보존", result.errorCode === "TIMEOUT");
  check(
    "C: summary에 반복된 timeout/transient 실패라는 사유가 명시됨",
    result.summary.includes("3회 연속") && result.summary.includes("TIMEOUT")
  );
  check(
    "C: deferredHumanTasks에 DEVELOPER_TRANSIENT_RETRY_EXHAUSTED 기록됨(승인 기록/Telegram 알림 경로로 흘러감)",
    (result.deferredHumanTasks ?? []).some((t) => t.startsWith("DEVELOPER_TRANSIENT_RETRY_EXHAUSTED"))
  );
}

// B — 사람 승인이 필요한 명시적 오류(AUTH_REQUIRED)는 재시도하지 않는다.
async function scenarioNonTransientNoRetry(): Promise<void> {
  let attemptCalls = 0;
  let sleepCalls = 0;
  const attempt = async (): Promise<DeveloperResult> => {
    attemptCalls += 1;
    return AUTH_REQUIRED_RESULT;
  };
  const result = await runDeveloperTaskWithRetry("task D", 1, {}, { attempt, sleep: async () => { sleepCalls += 1; } });
  check("B: AUTH_REQUIRED는 attempt 정확히 1회(재시도 없음)", attemptCalls === 1);
  check("B: AUTH_REQUIRED는 sleep 0회", sleepCalls === 0);
  check("B: 최종 success:false, errorCode AUTH_REQUIRED 그대로 보존", result.success === false && result.errorCode === "AUTH_REQUIRED");
}

// ---- orchestrator.ts 레벨 통합 테스트(claudeRunner로 이 wrapper를 주입) ----

// AutoDev / JARVIS 신뢰성 보완(2026-08-27 후속) — 실제 JARVIS Task 2.2(security-critical
// biometric 인증 구현 중 Claude Developer가 3회 연속 TIMEOUT)에서 발견된 실제 결함을 그대로
// 재현하는 회귀 fixture다: Task 위험도(security-critical)와 실패 원인 위험도(provider
// timeout)를 분리한다 — attempt 내 재시도(D.3)가 한 번 소진됐다고 곧바로 genuine
// WAITING_HUMAN으로 넘어가지 않고, WAITING_CLAUDE_LIMIT과 동일한 durable wait-then-retry를
// 거쳐 같은 task를 자동으로 재개한다.
async function scenarioJarvisSecurityCriticalTaskTimeoutAutoResumes(statePath: string): Promise<void> {
  // security-critical 문구를 실제 JARVIS currentTask 텍스트처럼 포함시켜 "task 내용이
  // security-critical이라는 사실 자체가 이 durable retry를 막지 않는다"를 명시적으로 검증한다.
  const securityCriticalTask =
    "고위험 Action 실행 전 Android 공식 경로(BiometricPrompt + Android Keystore)를 통한 강한 인증을 수행한다.";
  const seq = makeSequence([TIMEOUT_RESULT, TIMEOUT_RESULT, TIMEOUT_RESULT, SUCCESS_RESULT]);
  const claudeRunner = (task: string, attempt: number) =>
    runDeveloperTaskWithRetry(task, attempt, {}, { attempt: seq.attempt, sleep: async () => {} }) as Promise<ClaudeResult>;
  const gptReviewer = async (): Promise<GptReviewerReturn> => FAKE_PASS_REVIEW;

  const observedStatuses: string[] = [];
  let sleepCalls = 0;
  let lastSleepMs: number | undefined;

  const { finalState } = await runOrchestrator(securityCriticalTask, {
    claudeRunner,
    gptReviewer,
    statePath,
    onProgress: (info) => observedStatuses.push(info.status),
    sleep: async (ms) => {
      sleepCalls += 1;
      lastSleepMs = ms;
    },
  });

  check(
    "JARVIS 실제 사례: 3회 TIMEOUT 소진 후에도 WAITING_HUMAN이 즉시 관측되지 않음(genuine 승격 안 함)",
    !observedStatuses.includes("WAITING_HUMAN")
  );
  check("JARVIS 실제 사례: WAITING_PROVIDER_RETRY(durable wait) 상태가 관측됨", observedStatuses.includes("WAITING_PROVIDER_RETRY"));
  check("durable wait: sleep이 정확히 1회 호출됨(bounded)", sleepCalls === 1);
  check("durable wait: 5분(300000ms) 단위로 대기함", lastSleepMs === 5 * 60 * 1000);
  check("JARVIS 실제 사례: durable wait 이후 같은 task가 자동으로 재개되어 최종 APPROVED", finalState.status === "APPROVED");
  check("developerProviderWaitCount가 durable wait 1회를 기록함", finalState.developerProviderWaitCount === 1);
  check(
    "durable wait는 review cycle 예산을 소비하지 않음(claudeLimitWaitCount와 동일 관례) — reviewCycle=1로 정상 완료",
    finalState.reviewCycle === 1
  );
}

// durable wait 예산(MAX_DEVELOPER_PROVIDER_WAITS)까지 전부 소진해도 계속 실패하면 그때만
// genuine WAITING_HUMAN으로 넘어간다 — 무한 자동복구가 아니라는 것(bounded)을 직접 증명한다.
async function scenarioOrchestratorDurableWaitBoundedThenGenuineWaitingHuman(statePath: string): Promise<void> {
  const seq = makeSequence([TIMEOUT_RESULT]); // 계속 TIMEOUT만 반환(clamp)
  const claudeRunner = (task: string, attempt: number) =>
    runDeveloperTaskWithRetry(task, attempt, {}, { attempt: seq.attempt, sleep: async () => {} }) as Promise<ClaudeResult>;
  let sleepCalls = 0;

  const { finalState } = await runOrchestrator("orchestrator: TIMEOUT 영구 지속", {
    claudeRunner,
    statePath,
    sleep: async () => {
      sleepCalls += 1;
    },
  });

  check("bounded: durable wait 예산(6회)을 넘으면 그제서야 WAITING_HUMAN", finalState.status === "WAITING_HUMAN");
  check("bounded: sleep이 정확히 MAX_DEVELOPER_PROVIDER_WAITS(6)회만 호출됨(무한 대기 아님)", sleepCalls === 6);
  check("bounded: developerProviderWaitCount가 정확히 6에서 멈춤", finalState.developerProviderWaitCount === 6);
  check(
    "bounded: 최종 마커는 DEVELOPER_PROVIDER_WAIT_EXHAUSTED(새 마커, 자동 복구 목록에 없음)",
    finalState.deferredHumanTasks.some((t) => t.startsWith("DEVELOPER_PROVIDER_WAIT_EXHAUSTED("))
  );
  check(
    "bounded: attempt 총 횟수도 유한함((6+1)cycle × 3attempt = 21, 무한 재시도 아님)",
    seq.callCount() === 21
  );
}

// D.1/D.2(orchestrator 레벨) — 재시도로 성공하면 orchestrator 입장에서는 claudeRunner 호출이
// 정확히 1회(cycle 1회)뿐이고, 이후 정상적으로 GPT 리뷰 → APPROVED로 이어진다. 재시도가
// orchestrator의 REVISE/WAITING_HUMAN 상태 머신에 전혀 보이지 않는다는 것(투명성)을 증명한다.
async function scenarioOrchestratorRetryTransparentToReviewLoop(statePath: string): Promise<void> {
  const seq = makeSequence([TIMEOUT_RESULT, TIMEOUT_RESULT, SUCCESS_RESULT]);
  const claudeRunner = (task: string, attempt: number) =>
    runDeveloperTaskWithRetry(task, attempt, {}, { attempt: seq.attempt, sleep: async () => {} }) as Promise<ClaudeResult>;
  let claudeRunnerCallCountAtOrchestratorLevel = 0;
  const wrappedClaudeRunner = async (task: string, attempt: number) => {
    claudeRunnerCallCountAtOrchestratorLevel += 1;
    return claudeRunner(task, attempt);
  };
  const gptReviewer = async (): Promise<GptReviewerReturn> => FAKE_PASS_REVIEW;

  const { finalState } = await runOrchestrator("orchestrator: TIMEOUT x2 후 성공", {
    claudeRunner: wrappedClaudeRunner,
    gptReviewer,
    statePath,
  });
  check("D.1/D.2(orchestrator): 최종 상태 APPROVED(재시도 성공 후 정상 리뷰 통과)", finalState.status === "APPROVED");
  check("투명성: orchestrator 입장에서 claudeRunner는 정확히 1 cycle만 호출됨", claudeRunnerCallCountAtOrchestratorLevel === 1);
  check("투명성: 내부적으로는 attempt가 3회(재시도 2회 포함) 소비됨", seq.callCount() === 3);
}

// D.4 — 실제 Human Gate(정책상 항상 사람 승인이 필요한 고위험 작업)는 이 변경과 무관하게
// 여전히 claudeRunner를 전혀 호출하지 않고 즉시 WAITING_HUMAN이다(회귀 확인 — 이 재시도
// 정책은 policy.ts의 사전 게이트를 우회하지 않는다).
async function scenarioRealHumanGateStillImmediate(statePath: string): Promise<void> {
  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return SUCCESS_RESULT;
  };
  const { finalState } = await runOrchestrator("production 데이터 삭제해줘", { claudeRunner, statePath });
  check("D.4: 고위험 작업은 즉시 WAITING_HUMAN", finalState.status === "WAITING_HUMAN");
  check("D.4: claudeRunner(따라서 재시도 wrapper도) 전혀 호출되지 않음", claudeCalls === 0);
}

async function main(): Promise<void> {
  const realStateBefore = readFileSync(DEFAULT_STATE_PATH, "utf-8");

  try {
    await scenarioClassification();
    await scenarioFirstTimeoutRetries();
    await scenarioSecondRetryStillRetries();
    await scenarioExhaustionNoInfiniteRetry();
    await scenarioNonTransientNoRetry();
    await scenarioJarvisSecurityCriticalTaskTimeoutAutoResumes(makeTempStatePath());
    await scenarioOrchestratorDurableWaitBoundedThenGenuineWaitingHuman(makeTempStatePath());
    await scenarioOrchestratorRetryTransparentToReviewLoop(makeTempStatePath());
    await scenarioRealHumanGateStillImmediate(makeTempStatePath());
  } finally {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 디렉터리 정리 실패는 테스트 결과에 영향 없음(OS temp는 결국 정리됨)
      }
    }
  }

  const realStateAfter = readFileSync(DEFAULT_STATE_PATH, "utf-8");
  check("project-state 격리: 실제 project-state.json이 테스트 실행 전후 완전히 동일함", realStateBefore === realStateAfter);

  console.log("\n=== Claude Developer transient retry 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
