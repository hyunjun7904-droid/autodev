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

// D.3(orchestrator 레벨) + C — 재시도 소진 시 orchestrator가 WAITING_HUMAN으로 전환하고
// 그 사유가 state.deferredHumanTasks/lastClaudeResult에 남는다(HUMAN_APPROVAL_REQUIRED 기존
// 파이프라인이 이 state를 그대로 소비한다 — orchestrator.ts/autodev.ts는 이 테스트에서 전혀
// 수정되지 않았다).
async function scenarioOrchestratorExhaustionProducesWaitingHuman(statePath: string): Promise<void> {
  const seq = makeSequence([TIMEOUT_RESULT, TIMEOUT_RESULT, TIMEOUT_RESULT]);
  const claudeRunner = (task: string, attempt: number) =>
    runDeveloperTaskWithRetry(task, attempt, {}, { attempt: seq.attempt, sleep: async () => {} }) as Promise<ClaudeResult>;

  const { finalState } = await runOrchestrator("orchestrator: TIMEOUT x3 소진", { claudeRunner, statePath });
  check("D.3(orchestrator): 최종 상태 WAITING_HUMAN", finalState.status === "WAITING_HUMAN");
  check("D.7(orchestrator): claudeRunner(오케스트레이터 관점 1 cycle) 안에서 attempt 정확히 3회만", seq.callCount() === 3);
  check(
    "C(orchestrator): deferredHumanTasks에 DEVELOPER_TRANSIENT_RETRY_EXHAUSTED 사유가 저장됨",
    finalState.deferredHumanTasks.some((t) => t.startsWith("DEVELOPER_TRANSIENT_RETRY_EXHAUSTED"))
  );
  check("C(orchestrator): lastClaudeResult.errorCode가 TIMEOUT으로 남아 원인 추적 가능", (finalState.lastClaudeResult as ClaudeResult & { errorCode?: string } | null)?.errorCode === "TIMEOUT");
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
    await scenarioOrchestratorExhaustionProducesWaitingHuman(makeTempStatePath());
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
