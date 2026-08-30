import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewClaudeResultWithRetry } from "./gpt-reviewer";
import type { GptReviewApiResult } from "./gpt-reviewer";
import { runOrchestrator, MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT, MAX_GPT_CALLS } from "./orchestrator";
import { DEFAULT_STATE_PATH } from "./state";
import type { ClaudeResult } from "./types";

// REVISE(project-state 테스트 격리) — 이전 버전은 runOrchestrator()를 항상 실제
// automation/config/project-state.json에 대해 실행했다(orchestrator.ts가 loadState()/
// saveState()를 인자 없이 호출했기 때문). 이제 orchestrator.ts가 deps.statePath를 받으므로,
// 이 테스트는 OS 임시 디렉터리에 만든 별도 project-state.json만 사용한다 — 실제 파일은
// 어떤 시나리오에서도 read 이후로 다시 손대지 않는다(끝에서 hash/내용 비교로 증명).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const FAKE_CLAUDE_RESULT: ClaudeResult = {
  success: true,
  summary: "fake",
  changedFiles: [],
  tests: [],
  rawOutput: "",
};

const tempDirs: string[] = [];

function makeTempStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "movan-gpt-retry-test-"));
  tempDirs.push(dir);
  const statePath = join(dir, "project-state.json");
  const initial = {
    project: "MOVAN ERP (TEST)",
    currentPhase: 13,
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

function makeSequence(codes: (GptReviewApiResult | "PASS")[]): {
  attempt: () => Promise<GptReviewApiResult>;
  callCount: () => number;
} {
  let i = 0;
  return {
    attempt: async () => {
      const item = codes[Math.min(i, codes.length - 1)];
      i++;
      if (item === "PASS") {
        return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "ok", nextTask: null };
      }
      return item;
    },
    callCount: () => i,
  };
}

function transientResult(code: "TIMEOUT" | "RATE_LIMIT"): GptReviewApiResult {
  return {
    decision: "HUMAN_REQUIRED",
    severity: { critical: 0, high: 0, medium: 0 },
    feedback: `GPT API 오류: ${code}`,
    nextTask: null,
    errorCode: code,
    transient: true,
  };
}
function nonTransientResult(code: "AUTH_ERROR" | "QUOTA_EXCEEDED"): GptReviewApiResult {
  return {
    decision: "HUMAN_REQUIRED",
    severity: { critical: 0, high: 0, medium: 0 },
    feedback: `GPT API 오류: ${code}`,
    nextTask: null,
    errorCode: code,
    transient: false,
  };
}

async function scenarioA(statePath: string): Promise<void> {
  // GPT TIMEOUT 2회 → 3회째 PASS → Claude worker 추가 호출 0 → APPROVED
  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return FAKE_CLAUDE_RESULT;
  };
  const seq = makeSequence([transientResult("TIMEOUT"), transientResult("TIMEOUT"), "PASS"]);
  let sleepCalls = 0;
  const gptReviewer = async (result: ClaudeResult, reviewCycle: number, task: string) =>
    reviewClaudeResultWithRetry(result, reviewCycle, task, {
      deps: {
        attempt: seq.attempt,
        sleep: async () => {
          sleepCalls += 1;
        },
      },
    });

  const { finalState } = await runOrchestrator("A: GPT TIMEOUT x2 then PASS", { claudeRunner, gptReviewer, statePath });
  check("A: 최종 상태 APPROVED", finalState.status === "APPROVED");
  check("A: GPT attempt 정확히 3회(2회 실패+3회째 성공)", seq.callCount() === 3);
  check("A: Claude worker 추가 호출 없음(정확히 1회)", claudeCalls === 1);
  check("A: sleep 정확히 2회(재시도 간격)", sleepCalls === 2);
}

async function scenarioB(statePath: string): Promise<void> {
  // GPT RATE_LIMIT 1회 → 다음 PASS
  const seq = makeSequence([transientResult("RATE_LIMIT"), "PASS"]);
  const gptReviewer = async (result: ClaudeResult, reviewCycle: number, task: string) =>
    reviewClaudeResultWithRetry(result, reviewCycle, task, { deps: { attempt: seq.attempt as never, sleep: async () => {} } });
  const { finalState } = await runOrchestrator("B: GPT RATE_LIMIT x1 then PASS", { gptReviewer, statePath });
  check("B: 최종 상태 APPROVED", finalState.status === "APPROVED");
  check("B: GPT attempt 정확히 2회", seq.callCount() === 2);
}

// AutoDev / JARVIS 신뢰성 보완(2026-08-28 정책 수정) — GPT Reviewer 자신의 provider 일시적
// 장애(5회 attempt 소진 후 gpt-reviewer.ts가 반환하는 GPT_REVIEW_TEMPORARILY_UNAVAILABLE)는
// 더 이상 즉시 genuine WAITING_HUMAN으로 승격하지 않는다 — 같은 diff로 재리뷰만 반복하다가
// provider가 회복되면 자동으로 통과한다("검증 안 된 코드를 PASS 처리하지 않는다"는 원칙은
// 그대로 유지된다 — 실제로 성공 응답을 받기 전까지는 절대 PASS로 진행하지 않는다는 뜻이지,
// 재시도 자체를 막는다는 뜻이 아니었다). orchestrator.ts 레벨 gptReviewer를 직접 합성해
// "몇 번째 outer 호출인지"를 정확히 제어한다(gpt-reviewer.ts의 내부 5-attempt 재시도 세부
// 타이밍에 의존하지 않기 위함).
function syntheticTemporarilyUnavailable() {
  return {
    decision: "HUMAN_REQUIRED" as const,
    severity: { critical: 0, high: 0, medium: 0 },
    feedback: "GPT reviewer가 5회 연속 일시적 오류로 응답하지 않았습니다.",
    nextTask: null,
    errorCode: "GPT_REVIEW_TEMPORARILY_UNAVAILABLE" as const,
  };
}
function syntheticPass() {
  return { decision: "PASS" as const, severity: { critical: 0, high: 0, medium: 0 }, feedback: "ok", nextTask: null };
}

async function scenarioC(statePath: string): Promise<void> {
  // outer 호출 2회는 provider 일시적 장애, 3회째에 회복(PASS) — Human Gate를 거치지 않고
  // 자동으로 재리뷰가 이어지다가 정상 완료돼야 한다.
  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return FAKE_CLAUDE_RESULT;
  };
  let outerGptCalls = 0;
  const gptReviewer = async () => {
    outerGptCalls += 1;
    return outerGptCalls <= 2 ? syntheticTemporarilyUnavailable() : syntheticPass();
  };
  const observedStatuses: string[] = [];
  let orchestratorSleepCalls = 0;

  const { finalState } = await runOrchestrator("C: GPT reviewer provider 일시적 장애 후 회복", {
    claudeRunner,
    gptReviewer,
    statePath,
    onProgress: (info) => observedStatuses.push(info.status),
    sleep: async () => {
      orchestratorSleepCalls += 1;
    },
  });

  check("C: WAITING_HUMAN이 전혀 관측되지 않음(genuine 승격 안 함)", !observedStatuses.includes("WAITING_HUMAN"));
  check("C: WAITING_PROVIDER_RETRY(durable wait)가 관측됨", observedStatuses.includes("WAITING_PROVIDER_RETRY"));
  check("C: 최종 상태 APPROVED(provider 회복 후 자동으로 통과)", finalState.status === "APPROVED");
  check("C: outer gptReviewer가 정확히 3회 호출됨(2회 실패+3회째 성공)", outerGptCalls === 3);
  check("C: durable wait는 정확히 2회(orchestrator sleep)", orchestratorSleepCalls === 2);
  check("C: reviewerProviderWaitCount가 2로 기록됨", finalState.reviewerProviderWaitCount === 2);
  check("C: Claude worker는 1회만 호출됨(같은 diff 재사용, 재실행 없음)", claudeCalls === 1);
  check(
    "C: deferredHumanTasks에 GPT_REVIEW_TEMPORARILY_UNAVAILABLE이 genuine 마커로 남지 않음(정상 완료됐으므로)",
    !finalState.deferredHumanTasks.some((t) => t.startsWith("GPT_REVIEW_TEMPORARILY_UNAVAILABLE"))
  );
}

// § P1-2 재하드닝(독립 감사, 2026-08-30) — 이전 정책(이 시나리오의 예전 이름
// scenarioCNeverRecoversHitsRawCallCap)은 reviewerProviderWaitCount에 terminal cap이 전혀
// 연결되지 않아, provider가 전혀 회복되지 않으면 실제 비용 안전장치(MAX_GPT_RAW_CALLS=30,
// gptTransportRetry 포함 raw 호출 총합)에 도달할 때까지(outer 7회) "느리지만 사실상 무한한"
// 재시도가 계속되다가 결국 GPT_RAW_CALL_LIMIT_EXCEEDED(genuine WAITING_HUMAN)로 끝났다 —
// 독립 감사가 실제로 재현한 결함이다. 지금은 orchestrator.ts의 reviewer durable-wait 루프가
// 매 대기 전에 MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT(5)를 먼저 확인해, 그 상한을 raw-call
// 비용 상한보다 먼저 넘겨 terminal 기술적 BLOCKED로 끝난다(Human Gate 아님, 추가 Reviewer
// API 호출 없음) — MAX_GPT_RAW_CALLS 자체는 defense-in-depth로 여전히 존재하지만, 이
// 시나리오에서는 더 이상 먼저 도달하는 안전장치가 아니다.
async function scenarioCNeverRecoversHitsDurableRetryCap(statePath: string): Promise<void> {
  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return FAKE_CLAUDE_RESULT;
  };
  let outerGptCalls = 0;
  // 실제 gpt-reviewer.ts 내부 재시도(MAX_ATTEMPTS=5)를 그대로 반영해 outer 호출 1회당
  // gptRawCallTotal이 5씩 늘어나는 것과 동일하게 gptTransportRetry:4를 명시한다.
  const gptReviewer = async () => {
    outerGptCalls += 1;
    return { ...syntheticTemporarilyUnavailable(), gptTransportRetry: 4 };
  };
  let orchestratorSleepCalls = 0;

  const { finalState } = await runOrchestrator("C2: GPT reviewer provider 영구 장애(회복 없음)", {
    claudeRunner,
    gptReviewer,
    statePath,
    sleep: async () => {
      orchestratorSleepCalls += 1;
    },
  });

  check("C2) 결국 terminal 기술적 BLOCKED로 멈춤(genuine WAITING_HUMAN 아님)", finalState.status === "BLOCKED");
  check(
    "C2) deferredHumanTasks에 GPT_RAW_CALL_LIMIT_EXCEEDED가 기록되지 않음(retry count cap이 그보다 먼저 걸림)",
    !finalState.deferredHumanTasks.some((t) => t.startsWith("GPT_RAW_CALL_LIMIT_EXCEEDED"))
  );
  check(
    "C2) GPT_REVIEW_TEMPORARILY_UNAVAILABLE 자체는 genuine 마커로 남지 않음",
    !finalState.deferredHumanTasks.some((t) => t.startsWith("GPT_REVIEW_TEMPORARILY_UNAVAILABLE"))
  );
  check(
    "C2) reviewerProviderWaitCount가 상한(5)을 넘어선 시점(6)에서 멈춤(0부터 재시작 아님, 무한 반복도 아님)",
    finalState.reviewerProviderWaitCount === 6
  );
  check("C2) outer 호출 횟수가 유한함(초기 호출 1회 + 상한 내 재시도 5회 = 정확히 6회, 6번째 재시도는 호출 전에 차단됨)", outerGptCalls === 6);
  check("C2) durable wait도 유한함(정확히 5회)", orchestratorSleepCalls === 5);
  check("C2) Claude worker는 1회만 호출됨(같은 diff 재사용, 재실행 없음)", claudeCalls === 1);
}

// ---------------------------------------------------------------------------
// § P1-2 재하드닝(독립 감사) — "재시작이 Reviewer retry budget reset 버튼이 되면 안 된다".
// reviewerProviderWaitCount를 이미 상한(MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT) 직전까지
// 소진한 상태를 project-state.json에 직접 심어두고(=실제 process 재시작 직전 상태를 흉내냄),
// 완전히 새로운 runOrchestrator() 호출(같은 task, loadState()로 디스크에서 다시 읽음) 하나가
// 그 다음 한 번의 provider 실패만으로 즉시 terminal BLOCKED로 끝나는지, 그리고 그 호출
// 이후 추가 Reviewer network call이 전혀 없는지(outerGptCalls===1) 검증한다.
// ---------------------------------------------------------------------------
async function scenarioReviewerBudgetPersistsAcrossRestart(): Promise<void> {
  const sameTask = "K: reviewer 재시작 이후 durable retry 예산 보존";
  const dir = mkdtempSync(join(tmpdir(), "movan-gpt-retry-restart-test-"));
  tempDirs.push(dir);
  const statePath = join(dir, "project-state.json");
  writeFileSync(
    statePath,
    JSON.stringify(
      {
        currentTask: sameTask,
        reviewCycle: 0,
        lastClaudeResult: null,
        lastGptDecision: null,
        status: "WAITING_PROVIDER_RETRY",
        claudeLimitWaitCount: 0,
        reviewerProviderWaitCount: MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT,
        deferredHumanTasks: [],
        completedTasks: [],
        gitCheckpoint: "test",
        currentPhase: 1,
      },
      null,
      2
    ) + "\n",
    "utf-8"
  );

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return FAKE_CLAUDE_RESULT;
  };
  let outerGptCalls = 0;
  const gptReviewer = async () => {
    outerGptCalls += 1;
    return syntheticTemporarilyUnavailable();
  };
  let sleepCalls = 0;

  const { finalState } = await runOrchestrator(sameTask, {
    claudeRunner,
    gptReviewer,
    statePath,
    sleep: async () => {
      sleepCalls += 1;
    },
  });

  check(
    "K) 재시작(fresh runOrchestrator 호출) 직후 reviewerProviderWaitCount seed가 리셋되지 않고 단 1회 실패만으로 즉시 terminal BLOCKED",
    outerGptCalls === 1
  );
  check("K) 상한 초과 판정이 실제 재호출 전에 걸려 추가 durable wait(sleep)도 0회", sleepCalls === 0);
  check("K) 최종 status=BLOCKED(genuine WAITING_HUMAN 아님)", finalState.status === "BLOCKED");
  check(
    `K) reviewerProviderWaitCount가 seed(${MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT})에서 이어져 ${MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT + 1}로 기록됨(0부터 재시작 아님)`,
    finalState.reviewerProviderWaitCount === MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT + 1
  );
  check(
    "K) Claude worker는 이번 재시작 cycle에서 정확히 1회만 호출됨(claudeResult 자체는 재시작에도 영속화되지 않으므로 Developer는 다시 호출되지만, 그 뒤 Reviewer 재시도는 즉시 차단됨)",
    claudeCalls === 1
  );
}

async function scenarioD(statePath: string): Promise<void> {
  // AUTH_ERROR → 불필요한 즉시 반복 없음
  let attemptCalls = 0;
  let sleepCalls = 0;
  const authError = async (): Promise<GptReviewApiResult> => {
    attemptCalls += 1;
    return nonTransientResult("AUTH_ERROR");
  };
  const gptReviewer = async (result: ClaudeResult, reviewCycle: number, task: string) =>
    reviewClaudeResultWithRetry(result, reviewCycle, task, {
      deps: {
        attempt: authError,
        sleep: async () => {
          sleepCalls += 1;
        },
      },
    });
  const { finalState } = await runOrchestrator("D: AUTH_ERROR", { gptReviewer, statePath });
  check("D: attempt 정확히 1회(재시도 없음)", attemptCalls === 1);
  check("D: sleep 0회", sleepCalls === 0);
  check("D: 최종 상태 WAITING_HUMAN", finalState.status === "WAITING_HUMAN");
  check(
    "D: deferredHumanTasks에 AUTH_ERROR 기록됨",
    finalState.deferredHumanTasks.some((t) => t.startsWith("AUTH_ERROR"))
  );
}

async function scenarioE(statePath: string): Promise<void> {
  // QUOTA_EXCEEDED → 불필요한 즉시 반복 없음
  let attemptCalls = 0;
  let sleepCalls = 0;
  const quotaExceeded = async (): Promise<GptReviewApiResult> => {
    attemptCalls += 1;
    return nonTransientResult("QUOTA_EXCEEDED");
  };
  const gptReviewer = async (result: ClaudeResult, reviewCycle: number, task: string) =>
    reviewClaudeResultWithRetry(result, reviewCycle, task, {
      deps: {
        attempt: quotaExceeded,
        sleep: async () => {
          sleepCalls += 1;
        },
      },
    });
  const { finalState } = await runOrchestrator("E: QUOTA_EXCEEDED", { gptReviewer, statePath });
  check("E: attempt 정확히 1회(재시도 없음)", attemptCalls === 1);
  check("E: sleep 0회", sleepCalls === 0);
  check("E: 최종 상태 WAITING_HUMAN", finalState.status === "WAITING_HUMAN");
  check(
    "E: deferredHumanTasks에 QUOTA_EXCEEDED 기록됨",
    finalState.deferredHumanTasks.some((t) => t.startsWith("QUOTA_EXCEEDED"))
  );
}

// § BLOCKER 3(독립 최종 감사, 2026-08-30) — Reviewer API/retry hard budget restart
// persistence. gptCallCount/gptRawCallTotal이 이제 project-state.json에 durable하게
// 저장되므로(§ orchestrator.ts/types.ts CoreState.gptCallCount/gptRawCallTotal), 같은
// task를 이어가는 process restart(이 테스트에서는 scenarioReviewerBudgetPersistsAcrossRestart
// (K)와 동일한 원칙으로 매번 새 runOrchestrator() 호출 + 같은 statePath로 실제 process
// restart를 흉내낸다)에서도 이 예산이 리셋되지 않는지, cap 도달 후에는 추가 Reviewer
// network call이 정확히 0인지, 그 최종 상태가 genuine WAITING_HUMAN이 아니라 terminal
// 기술적 BLOCKED(Human Gate=0)인지, 그리고 정말 새로운 task로 전환할 때만 리셋되는지를
// 직접 검증한다.
async function scenarioGptCallBudgetRestartPersistence(): Promise<void> {
  const sameTask = "BLOCKER3: gpt call/raw budget이 process restart에도 보존됨";

  // 1) 같은 Task 첫 process에서 일부 budget 사용(첫 process가 이미 3회 REVISE round를
  //    소비하고 죽었다고 가정 — scenarioReviewerBudgetPersistsAcrossRestart(K)와 동일하게
  //    state.json에 직접 seed한다).
  const dir1 = mkdtempSync(join(tmpdir(), "movan-gpt-budget-restart-test-"));
  tempDirs.push(dir1);
  const statePath1 = join(dir1, "project-state.json");
  writeFileSync(
    statePath1,
    JSON.stringify(
      {
        currentTask: sameTask,
        reviewCycle: 0,
        lastClaudeResult: null,
        lastGptDecision: null,
        status: "READY",
        claudeLimitWaitCount: 0,
        gptCallCount: 3,
        gptRawCallTotal: 3,
        deferredHumanTasks: [],
        completedTasks: [],
        gitCheckpoint: "test",
        currentPhase: 1,
      },
      null,
      2
    ) + "\n",
    "utf-8"
  );

  // 2/3) process 종료 → 같은 Task 재시작(fresh runOrchestrator() 호출 — 실제 process
  //    재시작과 동일하게 loadState(statePath1)부터 다시 시작한다).
  let reviewerCalls1 = 0;
  const gptReviewerPass = async (): Promise<{ decision: "PASS"; severity: { critical: number; high: number; medium: number }; feedback: string; nextTask: null }> => {
    reviewerCalls1 += 1;
    return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "ok", nextTask: null };
  };
  const claudeRunner = async (): Promise<ClaudeResult> => FAKE_CLAUDE_RESULT;
  const { finalState: afterRestart1 } = await runOrchestrator(sameTask, {
    claudeRunner,
    gptReviewer: gptReviewerPass,
    statePath: statePath1,
    sleep: async () => {},
  });

  // 4) 이전 budget이 그대로 복원됨(seed 3에서 이어져 이번 호출로 4가 됨 — 0부터 재시작이
  //    아니다).
  check("BLOCKER3) restart 후 gptCallCount가 seed(3)에서 이어져 4로 기록됨(0부터 재시작 아님)", afterRestart1.gptCallCount === 4);
  check("BLOCKER3) restart 후 gptRawCallTotal도 seed(3)에서 이어져 4로 기록됨", afterRestart1.gptRawCallTotal === 4);
  // 5) 남은 budget만 사용 가능 — 이번 process는 정확히 1회만 실제로 호출해 정상 진행됨.
  check("BLOCKER3) 이번 process에서는 정확히 1회만 Reviewer network call(남은 budget만 사용)", reviewerCalls1 === 1);
  check("BLOCKER3) 이 attempt는 정상 APPROVED로 끝남(budget이 정확히 이어져 계속 진행 가능)", afterRestart1.status === "APPROVED");

  // 6) cap(MAX_GPT_CALLS)에 정확히 도달한 상태로 seed한 뒤 재시작한다 — "남은 budget"이
  //    0인 반대 극단을 검증한다.
  const dir2 = mkdtempSync(join(tmpdir(), "movan-gpt-budget-restart-cap-test-"));
  tempDirs.push(dir2);
  const statePath2 = join(dir2, "project-state.json");
  writeFileSync(
    statePath2,
    JSON.stringify(
      {
        currentTask: sameTask,
        reviewCycle: 0,
        lastClaudeResult: null,
        lastGptDecision: null,
        status: "READY",
        claudeLimitWaitCount: 0,
        gptCallCount: MAX_GPT_CALLS,
        gptRawCallTotal: MAX_GPT_CALLS,
        deferredHumanTasks: [],
        completedTasks: [],
        gitCheckpoint: "test",
        currentPhase: 1,
      },
      null,
      2
    ) + "\n",
    "utf-8"
  );

  // 7) 다시 process 재시작(fresh runOrchestrator() 호출).
  let reviewerCalls2 = 0;
  const gptReviewerShouldNotBeCalled = async (): Promise<{ decision: "PASS"; severity: { critical: number; high: number; medium: number }; feedback: string; nextTask: null }> => {
    reviewerCalls2 += 1;
    return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "ok", nextTask: null };
  };
  const { finalState: afterCap } = await runOrchestrator(sameTask, {
    claudeRunner,
    gptReviewer: gptReviewerShouldNotBeCalled,
    statePath: statePath2,
    sleep: async () => {},
  });

  // 8) 추가 Reviewer network call 정확히 0.
  check("BLOCKER3) cap 도달 후 재시작해도 추가 Reviewer network call 정확히 0", reviewerCalls2 === 0);
  // 9) status=terminal 기술적 BLOCKED(genuine WAITING_HUMAN 아님).
  check("BLOCKER3) cap 도달 후 최종 status=BLOCKED(terminal 기술적, genuine WAITING_HUMAN 아님)", afterCap.status === "BLOCKED");
  check(
    "BLOCKER3) deferredHumanTasks에 MAX_GPT_CALLS_EXCEEDED 사유가 남음(진단용 — Human Gate 판정과는 무관, § human-gate-policy.ts는 status로 직접 판정하지 않지만 autodev.ts가 status===\"BLOCKED\"를 우선 확인한다)",
    afterCap.deferredHumanTasks.some((t) => t.startsWith("MAX_GPT_CALLS_EXCEEDED"))
  );
  // 10) Human Gate=0은 runAutodevOnce 레벨(autodev.ts의 generic catch-all)에서 실제로
  //     검증한다(§ production-agent-integration-tests.ts "event 기록: MAX_GPT_CALLS로 인한
  //     BLOCKED는 기술적이므로 generic HUMAN_APPROVAL_REQUIRED bookend가 생성되지 않음") —
  //     여기서는 runOrchestrator() 레벨의 계약(status==="BLOCKED")만 검증한다(로직 복제 없음).

  // 11) 새로운(다른) Task로 전환하면 gptCallCount/gptRawCallTotal이 0부터 다시 시작해야
  //     한다 — 같은 statePath2를 그대로 재사용해 완전히 다른 task 문자열로 호출한다.
  const differentTask = "BLOCKER3: 완전히 다른 task로 전환됨";
  let reviewerCalls3 = 0;
  const gptReviewerPass3 = async (): Promise<{ decision: "PASS"; severity: { critical: number; high: number; medium: number }; feedback: string; nextTask: null }> => {
    reviewerCalls3 += 1;
    return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "ok", nextTask: null };
  };
  const { finalState: afterNewTask } = await runOrchestrator(differentTask, {
    claudeRunner,
    gptReviewer: gptReviewerPass3,
    statePath: statePath2,
    sleep: async () => {},
  });
  check("BLOCKER3) 새로운(다른) task로 전환하면 gptCallCount가 0부터 다시 시작해 이번 호출로 1이 됨", afterNewTask.gptCallCount === 1);
  check("BLOCKER3) 새로운(다른) task로 전환하면 gptRawCallTotal도 0부터 다시 시작해 이번 호출로 1이 됨", afterNewTask.gptRawCallTotal === 1);
  check("BLOCKER3) 새 task 전환 시 실제로 Reviewer가 다시 호출됨(cap이 새 task로 새어들지 않음)", reviewerCalls3 === 1);
}

// § BLOCKER 3 재하드닝 — crash window 검증: 실제 network call(gptReviewer)이 시작된 직후지만
// 결과가 아직 반환되기 전에 프로세스가 죽으면(이 테스트에서는 gptReviewer가 그 자리에서
// 즉시 reject해 이를 흉내낸다) hard budget이 유실되지 않아야 한다 — write-ahead
// reservation이 이미 디스크에 저장돼 있어야 한다(§ types.ts CoreState.gptRawCallTotal 문서,
// "호출 후 성공적으로 돌아온 뒤에만 counter 저장"하던 이전 방식의 정확한 반례).
async function scenarioGptRawCallBudgetSurvivesCrashDuringNetworkCall(): Promise<void> {
  const sameTask = "BLOCKER3-crash: 네트워크 호출 도중 crash";
  const dir = mkdtempSync(join(tmpdir(), "movan-gpt-budget-crash-test-"));
  tempDirs.push(dir);
  const statePath = join(dir, "project-state.json");
  writeFileSync(
    statePath,
    JSON.stringify(
      {
        currentTask: sameTask,
        reviewCycle: 0,
        lastClaudeResult: null,
        lastGptDecision: null,
        status: "READY",
        claudeLimitWaitCount: 0,
        gptCallCount: 0,
        gptRawCallTotal: 0,
        deferredHumanTasks: [],
        completedTasks: [],
        gitCheckpoint: "test",
        currentPhase: 1,
      },
      null,
      2
    ) + "\n",
    "utf-8"
  );

  const claudeRunner = async (): Promise<ClaudeResult> => FAKE_CLAUDE_RESULT;
  const crashingReviewer = async (): Promise<never> => {
    throw new Error("의도적인 테스트 crash — network call 도중 프로세스가 죽었다고 가정");
  };

  let threw = false;
  try {
    await runOrchestrator(sameTask, { claudeRunner, gptReviewer: crashingReviewer, statePath, sleep: async () => {} });
  } catch {
    threw = true;
  }
  check("BLOCKER3-crash) 예외가 삼켜지지 않고 그대로 전파됨(fail-closed)", threw);

  const onDisk = JSON.parse(readFileSync(statePath, "utf-8")) as { gptCallCount?: number; gptRawCallTotal?: number };
  check(
    "BLOCKER3-crash) network call 시작 직전에 이미 write-ahead reservation이 디스크에 저장됨(gptRawCallTotal=1, 호출 결과를 기다리지 않음)",
    onDisk.gptRawCallTotal === 1
  );
  check("BLOCKER3-crash) gptCallCount(REVISE round 예산)도 호출 여부와 무관하게 저장됨", onDisk.gptCallCount === 1);

  // 재시작(다음 process) — 이 reservation이 실제로 이어져 cap 계산에 반영되는지 확인한다.
  let reviewerCallsAfterCrash = 0;
  const gptReviewerPass = async (): Promise<{ decision: "PASS"; severity: { critical: number; high: number; medium: number }; feedback: string; nextTask: null }> => {
    reviewerCallsAfterCrash += 1;
    return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "ok", nextTask: null };
  };
  const { finalState: afterRecovery } = await runOrchestrator(sameTask, {
    claudeRunner,
    gptReviewer: gptReviewerPass,
    statePath,
    sleep: async () => {},
  });
  check(
    "BLOCKER3-crash) 재시작 후 gptRawCallTotal이 유실된 1에서 이어져 2가 됨(crash로 0으로 되돌아가지 않음)",
    afterRecovery.gptRawCallTotal === 2
  );
  check("BLOCKER3-crash) 재시작 후 실제로 Reviewer가 호출되어 정상 진행됨", reviewerCallsAfterCrash === 1);
}

async function main(): Promise<void> {
  // 실제 project-state.json은 read-only 증거로만 쓴다 — 이 테스트가 절대 이 파일을 쓰지
  // 않는다는 것을 실행 전/후 내용 비교로 증명한다(§ 요구사항 4).
  const realStateBefore = readFileSync(DEFAULT_STATE_PATH, "utf-8");

  try {
    await scenarioA(makeTempStatePath());
    await scenarioB(makeTempStatePath());
    await scenarioC(makeTempStatePath());
    await scenarioCNeverRecoversHitsDurableRetryCap(makeTempStatePath());
    await scenarioReviewerBudgetPersistsAcrossRestart();
    await scenarioD(makeTempStatePath());
    await scenarioE(makeTempStatePath());
    await scenarioGptCallBudgetRestartPersistence();
    await scenarioGptRawCallBudgetSurvivesCrashDuringNetworkCall();
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

  console.log("\n=== GPT transient retry 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
