import {
  loadDurableFailureStateForTask,
  resolveDurableFailureStateForReviewer,
  clearDurableFailureState,
} from "./durable-recovery-state";
import type { DurableFailureState } from "./types";

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function scenarioFreshStateForNewTask(): void {
  const state = { technicalRecoveryState: undefined };
  const result = loadDurableFailureStateForTask(state, "2.2");
  check("새 task(저장된 값 없음) → 전부 0으로 초기화된 빈 상태", result.taskId === "2.2" && result.sameFailureCount === 0 && result.unexpectedExitCount === 0);
}

function scenarioTaskIdMismatchResetsState(): void {
  const stale: DurableFailureState = {
    taskId: "2.1",
    sameFailureCount: 5,
    rootCauseAnalysisCount: 3,
    providerTimeoutCount: 2,
    unexpectedExitCount: 1,
    updatedAt: new Date().toISOString(),
  };
  const state = { technicalRecoveryState: stale };
  const result = loadDurableFailureStateForTask(state, "2.2");
  check(
    "다른 task의 이전 상태는 새 task로 넘어가지 않음(§ 요구사항 19)",
    result.taskId === "2.2" && result.sameFailureCount === 0 && result.unexpectedExitCount === 0
  );
}

function scenarioSameTaskIdPreservesCounts(): void {
  const persisted: DurableFailureState = {
    taskId: "2.2",
    sameFailureCount: 2,
    rootCauseAnalysisCount: 1,
    providerTimeoutCount: 1,
    unexpectedExitCount: 1,
    updatedAt: new Date().toISOString(),
  };
  const state = { technicalRecoveryState: persisted };
  const result = loadDurableFailureStateForTask(state, "2.2");
  check(
    "동일 task로 다시 조회하면 이전 카운트가 그대로 보존됨(프로세스 재시작에도 0으로 초기화되지 않음)",
    result.sameFailureCount === 2 && result.providerTimeoutCount === 1 && result.unexpectedExitCount === 1
  );
}

function scenarioClearRemovesState(): void {
  const state: { technicalRecoveryState?: DurableFailureState | null } = {
    technicalRecoveryState: { taskId: "2.2", sameFailureCount: 3, rootCauseAnalysisCount: 1, providerTimeoutCount: 0, unexpectedExitCount: 0, updatedAt: new Date().toISOString() },
  };
  clearDurableFailureState(state);
  check("task 완료 시 clearDurableFailureState가 완전히 비움", state.technicalRecoveryState === null);
}

function scenarioResolveMergesPiggybackedReviewerState(): void {
  // top-level(§ Process/Restart Circuit Breaker가 직접 저장)에는 unexpectedExitCount만 있고,
  // fingerprint/RCA 관련 값은 state.lastGptDecision에 얹혀 있다(§ root-cause-analysis.ts
  // GptReviewerFnWithDurableState — orchestrator.ts를 수정하지 않기 위한 설계).
  const state = {
    technicalRecoveryState: { taskId: "2.2", sameFailureCount: 0, rootCauseAnalysisCount: 0, providerTimeoutCount: 0, unexpectedExitCount: 1, updatedAt: new Date().toISOString() },
    lastGptDecision: {
      decision: "REVISE" as const,
      severity: { critical: 0, high: 0, medium: 1 },
      feedback: "fixture",
      nextTask: null,
      technicalRecoveryState: {
        taskId: "2.2",
        failureFingerprint: "fp-123",
        sameFailureCount: 2,
        rootCauseAnalysisCount: 1,
        providerTimeoutCount: 0,
        unexpectedExitCount: 0,
        pendingRootCauseCategory: "IMPLEMENTATION_ERROR",
        pendingSnapshotKey: "snap-1",
        updatedAt: new Date().toISOString(),
      } satisfies DurableFailureState,
    },
  };
  const result = resolveDurableFailureStateForReviewer(state, "2.2");
  check("resolve: fingerprint/RCA 값은 lastGptDecision의 piggyback에서 가져옴", result.failureFingerprint === "fp-123" && result.sameFailureCount === 2 && result.rootCauseAnalysisCount === 1);
  check("resolve: unexpectedExitCount는 top-level technicalRecoveryState에서 가져옴", result.unexpectedExitCount === 1);
  check("resolve: pending RCA 상태도 그대로 복원됨", result.pendingRootCauseCategory === "IMPLEMENTATION_ERROR" && result.pendingSnapshotKey === "snap-1");
}

function scenarioResolveIgnoresMismatchedTaskPiggyback(): void {
  const state = {
    technicalRecoveryState: undefined,
    lastGptDecision: {
      decision: "REVISE" as const,
      severity: { critical: 0, high: 0, medium: 1 },
      feedback: "fixture",
      nextTask: null,
      technicalRecoveryState: {
        taskId: "2.1",
        failureFingerprint: "fp-old-task",
        sameFailureCount: 5,
        rootCauseAnalysisCount: 2,
        providerTimeoutCount: 0,
        unexpectedExitCount: 0,
        updatedAt: new Date().toISOString(),
      } satisfies DurableFailureState,
    },
  };
  const result = resolveDurableFailureStateForReviewer(state, "2.2");
  check(
    "resolve: 다른 task(2.1)의 piggyback은 새 task(2.2)로 새어들어오지 않음",
    result.taskId === "2.2" && result.failureFingerprint === undefined && result.sameFailureCount === 0
  );
}

function main(): void {
  scenarioFreshStateForNewTask();
  scenarioTaskIdMismatchResetsState();
  scenarioSameTaskIdPreservesCounts();
  scenarioClearRemovesState();
  scenarioResolveMergesPiggybackedReviewerState();
  scenarioResolveIgnoresMismatchedTaskPiggyback();

  console.log("\n=== durable-recovery-state 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
