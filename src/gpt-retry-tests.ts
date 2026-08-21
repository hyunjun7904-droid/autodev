import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reviewClaudeResultWithRetry } from "./gpt-reviewer";
import type { GptReviewApiResult } from "./gpt-reviewer";
import { runOrchestrator } from "./orchestrator";
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

async function scenarioC(statePath: string): Promise<void> {
  // GPT TIMEOUT 5회(전부) → state 보존, deferred 기록, 검증 안 된 코드 PASS 금지
  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return FAKE_CLAUDE_RESULT;
  };
  let sleepCalls = 0;
  const alwaysTimeout = async (): Promise<GptReviewApiResult> => transientResult("TIMEOUT");
  const gptReviewer = async (result: ClaudeResult, reviewCycle: number, task: string) =>
    reviewClaudeResultWithRetry(result, reviewCycle, task, {
      deps: {
        attempt: alwaysTimeout,
        sleep: async () => {
          sleepCalls += 1;
        },
      },
    });

  const { finalState } = await runOrchestrator("C: GPT TIMEOUT x5", { claudeRunner, gptReviewer, statePath });
  check("C: decision이 PASS가 아님(검증 안 된 코드 PASS 금지)", finalState.status !== "APPROVED");
  check("C: 최종 상태 WAITING_HUMAN", finalState.status === "WAITING_HUMAN");
  check(
    "C: deferredHumanTasks에 GPT_REVIEW_TEMPORARILY_UNAVAILABLE 기록됨",
    finalState.deferredHumanTasks.some((t) => t.includes("GPT_REVIEW_TEMPORARILY_UNAVAILABLE"))
  );
  check("C: sleep 4회(5회 시도 사이 대기)", sleepCalls === 4);
  check("C: Claude worker는 1회만 호출됨(같은 diff 재사용, 재실행 없음)", claudeCalls === 1);
  check("C: lastGptDecision.decision이 PASS가 아님", finalState.lastGptDecision?.decision !== "PASS");
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
