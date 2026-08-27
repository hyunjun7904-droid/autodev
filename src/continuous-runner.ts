import { runAutodevOnce } from "./autodev";
import type { AutodevRunOptions, AutodevRunResult, AutodevRunOutcome } from "./autodev";
import { loadState } from "./state";
import { isTechnicalAutoRecoverableWaitingHuman } from "./human-gate-policy";

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
//
// AutoDev / JARVIS 신뢰성 보완(2026-08-27) — 위 여섯 가지 중 "RAN_TASK_NOT_APPROVED"와
// "RAN_TASK_CHECKPOINT_BLOCKED" 딱 두 가지만 예외다: 이 두 outcome이 실제로 만든
// WAITING_HUMAN이 human-gate-policy.ts의 canonical 판정으로 "기술적 자동 복구 대상"이면
// (scope violation/REVIEW_CYCLE_EXHAUSTED/REVIEW_BLOCKED — 실제 사람 판단이 필요한 사유가
// 아님) 이 loop는 멈추지 않고 runOnce()를 다시 호출한다. 그 다음 호출 자신의 canonical
// 재검사(autodev.ts)가 state.status를 READY로 되돌리고 leftover를 정리한다 — 이 파일은
// state.json을 직접 쓰지 않는다(production state transition은 항상 autodev.ts 하나가
// 담당한다는 기존 원칙을 그대로 유지, § autodev.ts human-gate-policy 재검사 블록). 나머지
// 네 outcome(STOPPED/HFR/두 BLOCKED_*)은 이 판정 대상이 아니다 — 이 파일은 그 넷을 각각
// 다시 판정하지 않는다(새 상태 체계를 만들지 않는다).
//
// runAutodevOnce()가 던지는 예외(처리되지 않은 fatal/unrecoverable 오류)는 여기서 삼키지
// 않고 그대로 다시 던진다 — 무슨 일이 있었는지 알 수 없는 상태에서 조용히 다음 task로
// 넘어가지 않는다(fail-closed, § autodev.ts의 catch(err){ lockShouldRelease=false; throw err; }
// 와 동일한 원칙을 이 바깥 loop도 그대로 따른다).
const CONTINUABLE_OUTCOME: AutodevRunOutcome = "RAN_TASK_APPROVED_AND_CHECKPOINTED";

/** 이 두 outcome만 "WAITING_HUMAN으로 끝났을 수 있는" 결과다(§ 파일 상단 주석) — 기술적
 *  자동 복구 재검사 대상은 이 집합으로 고정한다(다른 네 outcome은 절대 포함하지 않는다). */
const WAITING_HUMAN_OUTCOMES: ReadonlySet<AutodevRunOutcome> = new Set(["RAN_TASK_NOT_APPROVED", "RAN_TASK_CHECKPOINT_BLOCKED"]);

/** maxIterations(task 진행 backstop)와 별개의 예산 — 반복 횟수 자체로 사람 승인을 강제하지
 *  않는다는 정책(§ human-gate-policy.ts)과, 진짜 무한루프 버그로부터 리소스를 보호해야 한다는
 *  요구를 함께 만족시킨다. 이 상한에 도달해도 project-state.json을 WAITING_HUMAN으로 강제
 *  전환하지 않는다 — 이 continuous 실행(프로세스 1회)의 예산을 다 썼다는 뜻일 뿐이며, 다음
 *  실행(재시작)이 다시 canonical 판정부터 시작한다. */
const DEFAULT_MAX_TECHNICAL_RECOVERY_ATTEMPTS = 50;

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
  /**
   * 기술적(사람 판단 불필요) WAITING_HUMAN 자동 복구 재시도의 최대 횟수 — maxIterations와는
   * 별개의 예산이다(§ DEFAULT_MAX_TECHNICAL_RECOVERY_ATTEMPTS 상단 주석). 지정하지 않으면
   * 기본값(50)을 쓴다.
   */
  maxTechnicalRecoveryAttempts?: number;
}

export interface ContinuousRunnerIterationRecord {
  /** 1부터 시작하는 순번(기술적 자동 복구 재시도 포함, 실제 runOnce() 호출마다 1씩 증가). */
  iteration: number;
  result: AutodevRunResult;
}

export type ContinuousRunnerStopReason =
  | { kind: "OUTCOME_STOP"; outcome: AutodevRunOutcome; reason?: string }
  /** 같은 taskId가 이 연속 실행 안에서 두 번 "checkpoint 완료"로 보고됨 — project-state가
   *  실제로는 진행되지 않고 있다는 뜻이라 즉시 멈춘다. */
  | { kind: "LIVELOCK_NO_PROGRESS"; taskId: string }
  | { kind: "MAX_ITERATIONS_REACHED"; maxIterations: number }
  /** 기술적 WAITING_HUMAN 자동 복구를 maxTechnicalRecoveryAttempts회 넘게 반복했다 — 사람
   *  판단이 필요해진 것은 아니다(§ human-gate-policy.ts), 이 프로세스 1회의 리소스 예산을
   *  다 썼다는 순수 안전장치일 뿐이다. project-state.json은 여전히 WAITING_HUMAN(기술적)
   *  상태로 남으며, 다음 실행이 다시 canonical 판정부터 자동으로 이어간다. */
  | { kind: "TECHNICAL_RECOVERY_LIMIT_REACHED"; maxTechnicalRecoveryAttempts: number; taskId?: string };

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
  const { maxIterations: explicitMaxIterations, maxTechnicalRecoveryAttempts: explicitMaxTechnicalRecoveryAttempts, ...runOptions } = opts;
  const maxIterations = explicitMaxIterations ?? opts.manifest.taskRegistry.length + 1;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(`runAutodevContinuous: maxIterations는 1 이상의 정수여야 합니다(받은 값: ${maxIterations}).`);
  }
  const maxTechnicalRecoveryAttempts = explicitMaxTechnicalRecoveryAttempts ?? DEFAULT_MAX_TECHNICAL_RECOVERY_ATTEMPTS;
  if (!Number.isInteger(maxTechnicalRecoveryAttempts) || maxTechnicalRecoveryAttempts < 0) {
    throw new Error(`runAutodevContinuous: maxTechnicalRecoveryAttempts는 0 이상의 정수여야 합니다(받은 값: ${maxTechnicalRecoveryAttempts}).`);
  }
  const runOnce = testDeps.runOnce ?? runAutodevOnce;
  const statePathForRecoveryCheck = runOptions.statePath ?? opts.manifest.statePath;

  const iterations: ContinuousRunnerIterationRecord[] = [];
  const completedTaskIdsSeenThisRun = new Set<string>();
  // taskAdvancementCount: 기존 for-loop의 maxIterations backstop과 정확히 같은 것을 센다
  // (CONTINUABLE_OUTCOME으로 실제 task 진행이 있었던 호출 수). 기술적 자동 복구 재시도는
  // 이 예산을 소모하지 않는다 — 그 재시도는 별도의 technicalRecoveryCount로만 제한한다(§
  // 파일 상단 주석 — "반복 횟수 자체로 사람 승인을 요구하지 않는다"는 정책과, 기존
  // maxIterations의 "task 진행" 의미를 둘 다 그대로 지키기 위함).
  let taskAdvancementCount = 0;
  let technicalRecoveryCount = 0;
  let iterationNumber = 0;

  while (true) {
    if (taskAdvancementCount >= maxIterations) {
      return {
        iterations,
        stop: { kind: "MAX_ITERATIONS_REACHED", maxIterations },
        finalResult: iterations[iterations.length - 1].result,
      };
    }

    iterationNumber += 1;
    const result: AutodevRunResult = await runOnce(runOptions as AutodevRunOptions);
    iterations.push({ iteration: iterationNumber, result });

    if (result.outcome === CONTINUABLE_OUTCOME) {
      taskAdvancementCount += 1;
      // 실제 task 진행이 있었으므로 기술적 자동 복구 예산을 다음 task를 위해 새로 채운다.
      technicalRecoveryCount = 0;
      if (!result.taskId || completedTaskIdsSeenThisRun.has(result.taskId)) {
        return { iterations, stop: { kind: "LIVELOCK_NO_PROGRESS", taskId: result.taskId ?? "(unknown)" }, finalResult: result };
      }
      completedTaskIdsSeenThisRun.add(result.taskId);
      continue;
    }

    // AutoDev / JARVIS 신뢰성 보완(2026-08-27) — RAN_TASK_NOT_APPROVED/RAN_TASK_CHECKPOINT_BLOCKED
    // 는 WAITING_HUMAN으로 끝났을 수 있다. 이 project-state.json을 다시 읽어 canonical
    // Human Gate Policy로 재검사한다 — 기술적 자동 복구 대상이면 이 loop는 state를 직접
    // 건드리지 않고(그 mutation은 항상 autodev.ts 하나가 담당) 그대로 runOnce()를 다시
    // 호출한다. 다음 호출 자신의 canonical 재검사가 READY 전환 + leftover 정리를 수행한다.
    if (WAITING_HUMAN_OUTCOMES.has(result.outcome)) {
      let recoverable = false;
      try {
        recoverable = isTechnicalAutoRecoverableWaitingHuman(loadState(statePathForRecoveryCheck));
      } catch {
        // state.json을 읽을 수 없으면(손상/삭제 등) fail-closed로 사람 판단이 필요한
        // 것으로 취급한다 — 확인하지 못한 상태를 자동 복구 대상으로 추측하지 않는다.
        recoverable = false;
      }
      if (recoverable) {
        technicalRecoveryCount += 1;
        if (technicalRecoveryCount > maxTechnicalRecoveryAttempts) {
          return {
            iterations,
            stop: { kind: "TECHNICAL_RECOVERY_LIMIT_REACHED", maxTechnicalRecoveryAttempts, taskId: result.taskId },
            finalResult: result,
          };
        }
        continue;
      }
    }

    return { iterations, stop: { kind: "OUTCOME_STOP", outcome: result.outcome, reason: result.reason }, finalResult: result };
  }
}
