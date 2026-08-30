import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewClaudeResultWithRetry } from "./gpt-reviewer";
import type { GptReviewApiResult } from "./gpt-reviewer";
import { runOrchestrator, MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT } from "./orchestrator";
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
