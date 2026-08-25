import { runAutodevOnce } from "./autodev";
import type { AutodevRunOptions, AutodevRunResult, AutodevRunOutcome } from "./autodev";

// AutoDev Generic Continuous Runner.
//
// AutoDev는 JARVIS 전용이 아니다 — 어떤 project(JARVIS/MOVAN/BILLION/향후 프로젝트)를
// 실행하든 이 파일은 그 프로젝트 이름을 전혀 모른다(project-agnostic). 기존
// runAutodevOnce()(autodev.ts — Developer/Reviewer/REVISE loop/checkpoint/Project Lock/
// Remote Git Safety/Human Final Review를 이미 전부 구현한 production 경로)를 "완료된 Task
// 다음에 다음 Task를 실행할지"만 판단하는 얇은 한 겹으로 감쌀 뿐이다. 이 파일은 새로운
// Developer/Reviewer/Test pipeline을 만들지 않는다 — runAutodevOnce()를 그대로, 반복해서
// 호출하는 것 외에는 아무것도 하지 않는다.
//
// "다음 iteration으로 계속 진행해도 되는가"의 유일한 신호는
// outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED"다 — 이 값 하나만 "이 task가 checkpoint
// (git commit)까지 완전히 끝났고, project-state.json이 다음 결정을 위해 안전하게 갱신됐다"를
// 뜻한다(§ autodev.ts runAutodevOnce). 그 외 모든 outcome은 이미 각자의 방식으로 "지금은 더
// 진행하면 안 된다"를 뜻한다:
//   - "STOPPED"                              → WAITING_HUMAN 유지 중이거나 다음 runnable
//                                               task가 없음(project complete/deployment gate).
//   - "RAN_TASK_NOT_APPROVED"                → orchestrator가 APPROVED로 끝나지 않음(Reviewer/
//                                               security gate 실패, Required Test 실패 등 —
//                                               이미 WAITING_HUMAN으로 전환됨).
//   - "RAN_TASK_CHECKPOINT_BLOCKED"          → Secret/Dependency Scanner, audit store 불가,
//                                               remote git 재확인 실패 등 checkpoint 자체가
//                                               막힘(이미 WAITING_HUMAN으로 전환됨).
//   - "RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW" → Human Final Review(HFR) PENDING.
//   - "BLOCKED_PROJECT_LOCK"                 → 다른 프로세스가 이미 이 project를 쓰는 중.
//   - "BLOCKED_REMOTE_GIT"                   → Remote Git Safety가 시작 자체를 막음.
// 이 파일은 이 여섯 가지를 각각 다시 판정하지 않는다 — "CONTINUABLE_OUTCOME이 아니면 멈춘다"는
// 단일 규칙이 Task Prompt가 요구하는 모든 STOP 조건을 그대로 커버한다(새 상태 체계를 만들지
// 않는다).
//
// runAutodevOnce()가 던지는 예외(처리되지 않은 fatal/unrecoverable 오류)는 여기서 삼키지
// 않고 그대로 다시 던진다 — 무슨 일이 있었는지 알 수 없는 상태에서 조용히 다음 task로
// 넘어가지 않는다(fail-closed, § autodev.ts의 catch(err){ lockShouldRelease=false; throw err; }
// 와 동일한 원칙을 이 바깥 loop도 그대로 따른다).
const CONTINUABLE_OUTCOME: AutodevRunOutcome = "RAN_TASK_APPROVED_AND_CHECKPOINTED";

export interface ContinuousRunnerOptions extends AutodevRunOptions {
  /**
   * 이 연속 실행이 시도할 수 있는 최대 runAutodevOnce() 호출 횟수(no-progress/livelock 방어의
   * 최종 backstop). 지정하지 않으면 manifest.taskRegistry.length + 1을 쓴다 — project가
   * 정상적으로 끝까지 자동 완료되는 경우 정확히 "task 개수만큼의 checkpoint 성공 + 마지막
   * 1회의 '더 이상 실행할 task 없음' 확인"(§ autodev.ts decideNextAction)으로 끝나므로,
   * 그보다 많은 호출에서도 계속 CONTINUABLE_OUTCOME이 반환된다면 project-state가 실제로는
   * 진행되지 않고 있다는 뜻이다. 임의의 상수가 아니라 실제 task-registry 구조(호출부가 이미
   * 주입한 manifest)에서 유도한 값이다.
   */
  maxIterations?: number;
}

export interface ContinuousRunnerIterationRecord {
  /** 1부터 시작하는 순번. */
  iteration: number;
  result: AutodevRunResult;
}

export type ContinuousRunnerStopReason =
  | { kind: "OUTCOME_STOP"; outcome: AutodevRunOutcome; reason?: string }
  /** 같은 taskId가 이 연속 실행 안에서 두 번 "checkpoint 완료"로 보고됨 — project-state가
   *  실제로는 진행되지 않고 있다는 뜻이라 즉시 멈춘다. */
  | { kind: "LIVELOCK_NO_PROGRESS"; taskId: string }
  | { kind: "MAX_ITERATIONS_REACHED"; maxIterations: number };

export interface ContinuousRunnerResult {
  /** 이번 연속 실행이 실제로 수행한 runAutodevOnce() 호출 기록(순서대로). */
  iterations: ContinuousRunnerIterationRecord[];
  stop: ContinuousRunnerStopReason;
  /** 마지막 iteration의 결과(편의 필드 — iterations[iterations.length - 1].result와 동일). */
  finalResult: AutodevRunResult;
}

/** 테스트 전용 seam — 이 저장소의 기존 관례(claudeRunner/gptReviewer/assessLiveness 등)와
 *  동일하게, production 호출부(run.ts)는 이 값을 지정하지 않는다(기본값이 실제
 *  runAutodevOnce()를 그대로 쓴다). loop 자체(계속 진행 판단/livelock 방어/maxIterations
 *  backstop)만 결정적으로 검증하기 위한 것이다 — 실제 Developer/Reviewer/checkpoint
 *  파이프라인을 대체하지 않는다. */
export interface ContinuousRunnerTestDeps {
  runOnce?: (opts: AutodevRunOptions) => Promise<AutodevRunResult>;
}

/**
 * Task 1 → runAutodevOnce() → COMPLETE → (다음 runnable task가 있으면) Task 2 → ... 를
 * project-agnostic하게 반복한다. runAutodevOnce()가 이미 구현한 어떤 안전장치(Project Lock/
 * Remote Git Safety/Secret·Dependency Scanner/Human Final Review/WAITING_HUMAN)도 이 함수는
 * 우회하지 않는다 — 그 함수를 그대로, 반복 호출할 뿐이다.
 */
export async function runAutodevContinuous(
  opts: ContinuousRunnerOptions,
  testDeps: ContinuousRunnerTestDeps = {}
): Promise<ContinuousRunnerResult> {
  if (!opts || !opts.manifest) {
    throw new Error("runAutodevContinuous: manifest가 필요합니다 — runAutodevOnce()와 동일한 요구사항입니다.");
  }
  const { maxIterations: explicitMaxIterations, ...runOptions } = opts;
  const maxIterations = explicitMaxIterations ?? opts.manifest.taskRegistry.length + 1;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(`runAutodevContinuous: maxIterations는 1 이상의 정수여야 합니다(받은 값: ${maxIterations}).`);
  }
  const runOnce = testDeps.runOnce ?? runAutodevOnce;

  const iterations: ContinuousRunnerIterationRecord[] = [];
  const completedTaskIdsSeenThisRun = new Set<string>();

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const result: AutodevRunResult = await runOnce(runOptions as AutodevRunOptions);
    iterations.push({ iteration, result });

    if (result.outcome !== CONTINUABLE_OUTCOME) {
      return { iterations, stop: { kind: "OUTCOME_STOP", outcome: result.outcome, reason: result.reason }, finalResult: result };
    }

    if (!result.taskId || completedTaskIdsSeenThisRun.has(result.taskId)) {
      return { iterations, stop: { kind: "LIVELOCK_NO_PROGRESS", taskId: result.taskId ?? "(unknown)" }, finalResult: result };
    }
    completedTaskIdsSeenThisRun.add(result.taskId);
  }

  return {
    iterations,
    stop: { kind: "MAX_ITERATIONS_REACHED", maxIterations },
    finalResult: iterations[iterations.length - 1].result,
  };
}
