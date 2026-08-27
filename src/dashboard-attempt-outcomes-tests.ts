import { createInMemoryEventStore } from "./event-store";
import type { EventStore } from "./event-store";
import { buildAttemptOutcomes } from "./dashboard-attempt-outcomes";

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const T0 = Date.parse("2026-08-27T00:00:00.000Z");
function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function append(store: EventStore, offsetMs: number, input: Parameters<EventStore["append"]>[0]): void {
  const result = store.append(input);
  if (result.ok && result.event) result.event.timestamp = iso(offsetMs);
}

// 필수 검증 61 — 대시보드 성공 사례 기록: requiredTests 통과 → Reviewer 승인 → Task
// 완료(CHECKPOINT_CREATED)로 이어진 attempt는 성공 사례 1건으로 집계된다.
function scenarioSuccessfulAttemptCountsAsOneSuccess(): void {
  const store = createInMemoryEventStore();
  append(store, 0, { eventType: "TASK_STARTED", runId: "r1", taskId: "T1", projectId: "P", executionPhase: "task_selection", outcome: "PENDING" });
  append(store, 1, { eventType: "TEST_COMPLETED", runId: "r1", taskId: "T1", projectId: "P", executionPhase: "test", outcome: "SUCCESS", reviseCycle: 1 });
  append(store, 2, { eventType: "REVIEW_APPROVED", runId: "r1", taskId: "T1", projectId: "P", executionPhase: "review", outcome: "SUCCESS", reviseCycle: 1 });
  append(store, 3, { eventType: "CHECKPOINT_CREATED", runId: "r1", taskId: "T1", projectId: "P", executionPhase: "checkpoint", outcome: "SUCCESS" });

  const summary = buildAttemptOutcomes(store.query().events, "P");
  check("성공 사례 정확히 1건", summary.successCount === 1);
  check("실패 사례 0건", summary.failureCount === 0);
  check("recent[0]이 SUCCESS", summary.recent[0]?.result === "SUCCESS");
  check("recent[0].taskId === 'T1'", summary.recent[0]?.taskId === "T1");
}

// 필수 검증 60 — 대시보드 실패 사례 기록: required test 실패 → Reviewer REVISE → 기술적
// BLOCK → attempt 종료는 실패 사례 1건으로 집계되고, 동일 attempt 내부 event(REVIEW_STARTED/
// REVIEW_BLOCKED/HUMAN_APPROVAL_REQUIRED 등)를 중복 집계하지 않는다.
function scenarioFailedAttemptCountsAsOneFailureNotFour(): void {
  const store = createInMemoryEventStore();
  append(store, 0, { eventType: "TASK_STARTED", runId: "r2", taskId: "T2", projectId: "P", executionPhase: "task_selection", outcome: "PENDING" });
  append(store, 1, { eventType: "TEST_COMPLETED", runId: "r2", taskId: "T2", projectId: "P", executionPhase: "test", outcome: "FAILED", reviseCycle: 1 });
  append(store, 2, { eventType: "REVIEW_STARTED", runId: "r2", taskId: "T2", projectId: "P", executionPhase: "review", outcome: "PENDING", reviseCycle: 1 });
  append(store, 3, {
    eventType: "REVIEW_BLOCKED",
    runId: "r2",
    taskId: "T2",
    projectId: "P",
    executionPhase: "review",
    outcome: "BLOCKED",
    humanInterventionRequired: true,
    reviseCycle: 1,
    reason: "scope violation",
  });
  append(store, 4, {
    eventType: "HUMAN_APPROVAL_REQUIRED",
    runId: "r2",
    taskId: "T2",
    projectId: "P",
    executionPhase: "review",
    outcome: "BLOCKED",
    humanInterventionRequired: true,
    reason: "orchestrator status=WAITING_HUMAN",
  });
  append(store, 5, {
    eventType: "RUN_BLOCKED",
    runId: "r2",
    taskId: "T2",
    projectId: "P",
    executionPhase: "review",
    outcome: "BLOCKED",
    reason: "orchestrator status=WAITING_HUMAN",
  });

  const summary = buildAttemptOutcomes(store.query().events, "P");
  check("실패 사례 정확히 1건(REVIEW_STARTED/REVIEW_BLOCKED/HUMAN_APPROVAL_REQUIRED 중복 집계 안 함)", summary.failureCount === 1);
  check("성공 사례 0건", summary.successCount === 0);
  check("recent[0]이 FAILURE", summary.recent[0]?.result === "FAILURE");
  check("recent[0].reason에 RUN_BLOCKED reason이 담김", summary.recent[0]?.reason === "orchestrator status=WAITING_HUMAN");
}

// 필수 검증 65 — 연속 시도는 각각 기록: 1차 실패, 2차 실패, 3차 성공(서로 다른 runId)이면
// 실패 사례 2건 + 성공 사례 1건으로 각각 독립 집계된다(실제 JARVIS Task 2.1 재현 패턴).
function scenarioConsecutiveAttemptsEachRecordedIndependently(): void {
  const store = createInMemoryEventStore();
  append(store, 0, { eventType: "RUN_BLOCKED", runId: "attempt1", taskId: "T3", projectId: "P", executionPhase: "review", outcome: "BLOCKED", reason: "scope violation 1" });
  append(store, 1, { eventType: "RUN_BLOCKED", runId: "attempt2", taskId: "T3", projectId: "P", executionPhase: "review", outcome: "BLOCKED", reason: "scope violation 2" });
  append(store, 2, { eventType: "CHECKPOINT_CREATED", runId: "attempt3", taskId: "T3", projectId: "P", executionPhase: "checkpoint", outcome: "SUCCESS" });

  const summary = buildAttemptOutcomes(store.query().events, "P");
  check("실패 사례 2건", summary.failureCount === 2);
  check("성공 사례 1건", summary.successCount === 1);
  check("최신순 정렬 — 가장 최근(성공)이 0번", summary.recent[0]?.result === "SUCCESS");
}

// 필수 검증 62 — exitCode 0 성공 오판 방지: Claude CLI 호출 성공(TEST_COMPLETED SUCCESS
// 등)만으로는 성공 사례로 집계되지 않는다 — CHECKPOINT_CREATED가 없으면 0건이어야 한다.
function scenarioExitCodeZeroAloneIsNotSuccess(): void {
  const store = createInMemoryEventStore();
  append(store, 0, { eventType: "TASK_STARTED", runId: "r4", taskId: "T4", projectId: "P", executionPhase: "task_selection", outcome: "PENDING" });
  append(store, 1, { eventType: "TEST_COMPLETED", runId: "r4", taskId: "T4", projectId: "P", executionPhase: "test", outcome: "SUCCESS", reviseCycle: 1 });
  append(store, 2, { eventType: "REVIEW_STARTED", runId: "r4", taskId: "T4", projectId: "P", executionPhase: "review", outcome: "PENDING", reviseCycle: 1 });

  const summary = buildAttemptOutcomes(store.query().events, "P");
  check("CHECKPOINT_CREATED 없으면 성공 사례 0건(진행 중 run은 집계 대상 아님)", summary.successCount === 0);
  check("CHECKPOINT_CREATED/RUN_BLOCKED 둘 다 없으면 실패 사례도 0건", summary.failureCount === 0);
}

// 필수 검증 63 — 일시 오류 후 성공: 같은 attempt(같은 runId) 안에서 TIMEOUT 재시도가
// 있었어도 최종 CHECKPOINT_CREATED 하나만 있으면 성공 사례 1건이다(TIMEOUT 자체는 이
// 집계 대상 event 타입이 아니므로 애초에 세지 않는다).
function scenarioTransientRetryThenSuccessCountsOnce(): void {
  const store = createInMemoryEventStore();
  append(store, 0, { eventType: "TASK_STARTED", runId: "r5", taskId: "T5", projectId: "P", executionPhase: "task_selection", outcome: "PENDING" });
  append(store, 1, { eventType: "DEVELOPER_RETRY_STARTED", runId: "r5", taskId: "T5", projectId: "P", executionPhase: "development", outcome: "PENDING", reviseCycle: 1 });
  append(store, 2, { eventType: "CHECKPOINT_CREATED", runId: "r5", taskId: "T5", projectId: "P", executionPhase: "checkpoint", outcome: "SUCCESS" });

  const summary = buildAttemptOutcomes(store.query().events, "P");
  check("일시 재시도 후 성공은 성공 사례 정확히 1건(재시도로 부풀리지 않음)", summary.successCount === 1);
  check("실패 사례로 잘못 세지 않음", summary.failureCount === 0);
}

// 프로젝트 범위 — 다른 project의 attempt는 집계에 섞이지 않는다.
function scenarioScopedToProjectId(): void {
  const store = createInMemoryEventStore();
  append(store, 0, { eventType: "CHECKPOINT_CREATED", runId: "r6", taskId: "T6", projectId: "OTHER_PROJECT", executionPhase: "checkpoint", outcome: "SUCCESS" });
  append(store, 1, { eventType: "RUN_BLOCKED", runId: "r7", taskId: "T7", projectId: "P", executionPhase: "review", outcome: "BLOCKED", reason: "x" });

  const summary = buildAttemptOutcomes(store.query().events, "P");
  check("다른 project의 성공 event는 집계에서 제외됨", summary.successCount === 0);
  check("이 project의 실패 event만 집계됨", summary.failureCount === 1);
}

function main(): void {
  scenarioSuccessfulAttemptCountsAsOneSuccess();
  scenarioFailedAttemptCountsAsOneFailureNotFour();
  scenarioConsecutiveAttemptsEachRecordedIndependently();
  scenarioExitCodeZeroAloneIsNotSuccess();
  scenarioTransientRetryThenSuccessCountsOnce();
  scenarioScopedToProjectId();

  console.log("\n=== dashboard-attempt-outcomes 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
