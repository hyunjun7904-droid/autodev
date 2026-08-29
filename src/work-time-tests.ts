import { createInMemoryEventStore } from "./event-store";
import type { EventStore } from "./event-store";
import { computeActiveWorkMs, computeActiveWorkMsAcrossTasks, computeUsageLimitWaitMs } from "./work-time";

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const T0 = Date.parse("2026-08-27T00:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(T0 + offsetMs).toISOString();
}

function makeStore(): EventStore {
  return createInMemoryEventStore();
}

// createEvent()는 timestamp를 항상 new Date().toISOString()(현재 실제 시각)으로 채우고
// override hook이 없다 — append 직후 반환된 event 객체(in-memory store의 실제 배열 원소와
// 동일한 참조)의 timestamp만 테스트가 원하는 고정 시각으로 직접 덮어써 결정론적으로
// 검증한다(store의 append 로직 자체를 우회하지 않는다 — sequence/필드 검증은 그대로 거친다).
function append(store: EventStore, offsetMs: number, input: Parameters<EventStore["append"]>[0]): void {
  const result = store.append(input);
  if (result.ok && result.event) result.event.timestamp = iso(offsetMs);
}

// ---------------------------------------------------------------------------
// A) 단순 진행 — TASK_STARTED(RUNNING) 이후 TEST_COMPLETED까지의 간격만 작업시간으로 집계.
// ---------------------------------------------------------------------------
function scenarioSimpleActiveSpanCounted(): void {
  const store = makeStore();
  append(store, 0, { eventType: "TASK_STARTED", runId: "r1", taskId: "T1", executionPhase: "task_selection", outcome: "PENDING" });
  append(store, 5_000, { eventType: "TEST_COMPLETED", runId: "r1", taskId: "T1", executionPhase: "test", outcome: "SUCCESS" });

  const events = store.query({ runId: "r1" }).events;
  const workMs = computeActiveWorkMs(events, T0 + 5_000);
  check("A) TASK_STARTED~TEST_COMPLETED 구간(5초)이 그대로 작업시간으로 집계됨", workMs === 5_000);
}

// ---------------------------------------------------------------------------
// B) WAITING_HUMAN 이후의 대기 시간은 집계되지 않음(현재 시각까지 tail 포함).
// ---------------------------------------------------------------------------
function scenarioWaitingHumanTailExcluded(): void {
  const store = makeStore();
  append(store, 0, { eventType: "TASK_STARTED", runId: "r1", taskId: "T1", executionPhase: "task_selection", outcome: "PENDING" });
  append(store, 3_000, { eventType: "HUMAN_APPROVAL_REQUIRED", runId: "r1", taskId: "T1", executionPhase: "review", outcome: "BLOCKED", humanInterventionRequired: true });

  const events = store.query({ runId: "r1" }).events;
  // HUMAN_APPROVAL_REQUIRED 이후로 1시간이 그냥 흘렀다고 가정 — 그 1시간은 집계되면 안 된다.
  const now = T0 + 3_000 + 60 * 60 * 1000;
  const workMs = computeActiveWorkMs(events, now);
  check("B) HUMAN_APPROVAL_REQUIRED 이전 구간(3초)만 집계됨", workMs === 3_000);
  check("B) HUMAN_APPROVAL_REQUIRED 이후의 대기 1시간은 집계되지 않음", workMs < 60_000);
}

// ---------------------------------------------------------------------------
// C) 완료(COMPLETED) 이후에는 아무리 시간이 지나도 늘어나지 않음 — "재시작해도 값이
//    사라지지 않는다"의 반대 방향(과거 완료된 작업 시간이 계속 불어나지 않는다)도 증명한다.
// ---------------------------------------------------------------------------
function scenarioCompletedDoesNotKeepGrowing(): void {
  const store = makeStore();
  append(store, 0, { eventType: "TASK_STARTED", runId: "r1", taskId: "T1", executionPhase: "task_selection", outcome: "PENDING" });
  append(store, 10_000, { eventType: "TASK_COMPLETED", runId: "r1", taskId: "T1", executionPhase: "state_update", outcome: "SUCCESS" });

  const events = store.query({ runId: "r1" }).events;
  const workAtCompletion = computeActiveWorkMs(events, T0 + 10_000);
  const workMuchLater = computeActiveWorkMs(events, T0 + 10_000 + 999_999_999);
  check("C) 완료 시점의 작업시간(10초)", workAtCompletion === 10_000);
  check("C) 완료 이후 아무리 오래 지나도 같은 값(계속 증가하지 않음)", workMuchLater === workAtCompletion);
}

// ---------------------------------------------------------------------------
// D) 재시작/재조회에도 동일한 값 — 같은 event 기록을 다시 읽으면 항상 같은 값(순수 함수).
// ---------------------------------------------------------------------------
function scenarioDeterministicAcrossReReads(): void {
  const store = makeStore();
  append(store, 0, { eventType: "TASK_STARTED", runId: "r1", taskId: "T1", executionPhase: "task_selection", outcome: "PENDING" });
  append(store, 4_000, { eventType: "REVIEW_REVISE", runId: "r1", taskId: "T1", executionPhase: "review", outcome: "PENDING", reviseCycle: 1 });
  append(store, 7_000, { eventType: "TASK_COMPLETED", runId: "r1", taskId: "T1", executionPhase: "state_update", outcome: "SUCCESS" });

  const first = computeActiveWorkMs(store.query({ runId: "r1" }).events, T0 + 7_000);
  const second = computeActiveWorkMs(store.query({ runId: "r1" }).events, T0 + 7_000);
  check("D) 같은 기록을 다시 읽어도 동일한 값(브라우저 재접속과 동일한 상황)", first === second && first === 7_000);
}

// ---------------------------------------------------------------------------
// E) 여러 task에 걸친 프로젝트 전체 작업시간 — task 경계를 넘어 상태가 섞이지 않는다.
// ---------------------------------------------------------------------------
function scenarioAcrossTasksSumsIndependently(): void {
  const store = makeStore();
  // Task 1: 5초 작업 후 완료.
  append(store, 0, { eventType: "TASK_STARTED", runId: "r1", taskId: "T1", executionPhase: "task_selection", outcome: "PENDING" });
  append(store, 5_000, { eventType: "TASK_COMPLETED", runId: "r1", taskId: "T1", executionPhase: "state_update", outcome: "SUCCESS" });
  // Task 2: 3초 작업 후 사람 승인 대기(그 이후 오래 대기).
  append(store, 5_000, { eventType: "TASK_STARTED", runId: "r1", taskId: "T2", executionPhase: "task_selection", outcome: "PENDING" });
  append(store, 8_000, { eventType: "HUMAN_APPROVAL_REQUIRED", runId: "r1", taskId: "T2", executionPhase: "review", outcome: "BLOCKED", humanInterventionRequired: true });

  const events = store.query({ runId: "r1" }).events;
  const now = T0 + 8_000 + 60 * 60 * 1000;
  const total = computeActiveWorkMsAcrossTasks(events, now);
  check("E) Task1(5초) + Task2(3초) = 8초로 정확히 합산됨(Task2의 대기시간은 제외)", total === 8_000);
}

// ---------------------------------------------------------------------------
// F) AutoDev / JARVIS Dashboard Stale-State Reconciliation(2026-08-28) — freezeTail. 실제
//    production incident 재현: 마지막 event가 REVIEW_STARTED(REVIEWING, ACTIVE_STATUSES에
//    속함)인 채로 owner 프로세스가 죽으면, freezeTail 없이는 그 시점 이후 몇 시간이 지나든
//    tail이 계속 늘어난다. freezeTail=true는 그 tail을 완전히 0으로 만든다 — 죽기 전까지
//    실제로 흐른 구간(사건 사이 간격)은 그대로 인정한다는 것도 함께 증명한다.
// ---------------------------------------------------------------------------
function scenarioFreezeTailStopsGrowthAfterProcessDeath(): void {
  const store = makeStore();
  append(store, 0, { eventType: "TASK_STARTED", runId: "r1", taskId: "T1", executionPhase: "task_selection", outcome: "PENDING" });
  append(store, 5_000, { eventType: "REVIEW_STARTED", runId: "r1", taskId: "T1", executionPhase: "review", outcome: "PENDING", reviseCycle: 1 });

  const events = store.query({ runId: "r1" }).events;
  const nowShortlyAfter = T0 + 5_000 + 1_000;
  const nowManyHoursLater = T0 + 5_000 + 15 * 60 * 60 * 1000;

  const withoutFreeze = computeActiveWorkMs(events, nowManyHoursLater);
  check(
    "F) freezeTail 없이는(기존 동작) 프로세스 죽음과 무관하게 tail이 계속 늘어남(회귀 대상 버그 재현)",
    withoutFreeze > 60_000
  );

  const frozenShortlyAfter = computeActiveWorkMs(events, nowShortlyAfter, { freezeTail: true });
  const frozenManyHoursLater = computeActiveWorkMs(events, nowManyHoursLater, { freezeTail: true });
  check("F) freezeTail=true면 마지막 event까지의 구간(5초)만 집계됨", frozenShortlyAfter === 5_000);
  check(
    "F) freezeTail=true면 그 이후 시간이 아무리 지나도 값이 늘지 않음(11시간 이상 정체돼도 작업시간 고정)",
    frozenManyHoursLater === 5_000 && frozenManyHoursLater === frozenShortlyAfter
  );
}

function scenarioFreezeTailAcrossTasks(): void {
  const store = makeStore();
  append(store, 0, { eventType: "TASK_STARTED", runId: "r1", taskId: "T1", executionPhase: "task_selection", outcome: "PENDING" });
  append(store, 5_000, { eventType: "TASK_COMPLETED", runId: "r1", taskId: "T1", executionPhase: "state_update", outcome: "SUCCESS" });
  append(store, 5_000, { eventType: "TASK_STARTED", runId: "r1", taskId: "T2", executionPhase: "task_selection", outcome: "PENDING" });
  append(store, 8_000, { eventType: "REVIEW_STARTED", runId: "r1", taskId: "T2", executionPhase: "review", outcome: "PENDING", reviseCycle: 1 });

  const events = store.query({ runId: "r1" }).events;
  const nowMuchLater = T0 + 8_000 + 12 * 60 * 60 * 1000;
  const total = computeActiveWorkMsAcrossTasks(events, nowMuchLater, { freezeTail: true });
  check(
    "F) 여러 task 합산에서도 freezeTail이 적용됨 — T1(5초, 이미 완료돼 원래도 안 늘어남) + T2(3초, 죽은 프로세스의 tail은 집계 안 됨) = 8초",
    total === 8_000
  );
}

// ---------------------------------------------------------------------------
// G) AutoDev Core Maintenance(2026-08-30) — computeUsageLimitWaitMs. § 파일 상단 "알려진
// 한계" 문단이 문서화한 gap을 메우는 새 함수 — TASK_STARTED~TEST_COMPLETED 구간(전부
// 활성 상태) 안에 USAGE_LIMIT 내부 재시도 대기가 끼어 있어도, computeActiveWorkMs 자체는
// (기존 한계 그대로) 전체를 작업시간으로 계산하지만, computeUsageLimitWaitMs는 그 대기
// 구간만 정확히 분리해낸다 — 호출부가 둘을 빼서 "USAGE_LIMIT 제외 실제 작업시간"을 얻을
// 수 있다(기존 computeActiveWorkMs의 반환값/시그니처는 전혀 바뀌지 않았다).
// ---------------------------------------------------------------------------
function scenarioUsageLimitWaitExcludedFromCorrectedWorkTime(): void {
  const store = makeStore();
  append(store, 0, { eventType: "TASK_STARTED", runId: "r1", taskId: "T1", executionPhase: "task_selection", outcome: "PENDING" });
  append(store, 2_000, { eventType: "DEVELOPER_USAGE_LIMIT_WAIT_STARTED", runId: "r1", taskId: "T1", executionPhase: "development" });
  append(store, 32_000, { eventType: "DEVELOPER_USAGE_LIMIT_WAIT_ENDED", runId: "r1", taskId: "T1", executionPhase: "development" });
  append(store, 35_000, { eventType: "TEST_COMPLETED", runId: "r1", taskId: "T1", executionPhase: "test", outcome: "SUCCESS" });

  const events = store.query({ runId: "r1" }).events;
  const workMs = computeActiveWorkMs(events, T0 + 35_000);
  check("G) 기존 computeActiveWorkMs는 여전히 전체 구간(35초)을 그대로 집계함(기존 한계 — 시그니처/의미 불변)", workMs === 35_000);

  const usageLimitWaitMs = computeUsageLimitWaitMs(events);
  check("G) computeUsageLimitWaitMs가 STARTED~ENDED 구간(30초)만 정확히 분리함", usageLimitWaitMs === 30_000);

  const corrected = workMs - usageLimitWaitMs;
  check("G) 조합(workMs - usageLimitWaitMs)이 실제 개발 작업시간(5초)을 정확히 산출함", corrected === 5_000);
}

function scenarioUsageLimitWaitMultipleRoundsSummed(): void {
  const store = makeStore();
  append(store, 0, { eventType: "DEVELOPER_USAGE_LIMIT_WAIT_STARTED", runId: "r1", taskId: "T1", executionPhase: "development" });
  append(store, 10_000, { eventType: "DEVELOPER_USAGE_LIMIT_WAIT_ENDED", runId: "r1", taskId: "T1", executionPhase: "development" });
  append(store, 20_000, { eventType: "DEVELOPER_USAGE_LIMIT_WAIT_STARTED", runId: "r1", taskId: "T1", executionPhase: "development" });
  append(store, 45_000, { eventType: "DEVELOPER_USAGE_LIMIT_WAIT_ENDED", runId: "r1", taskId: "T1", executionPhase: "development" });

  const events = store.query({ runId: "r1" }).events;
  check("G) 여러 STARTED/ENDED 쌍이 정확히 합산됨(10초+25초=35초)", computeUsageLimitWaitMs(events) === 35_000);
}

function scenarioUsageLimitWaitUnmatchedEndedIgnored(): void {
  const store = makeStore();
  // 고아 ENDED(대응하는 STARTED 없음) — 추측으로 구간을 만들지 않고 무시해야 한다.
  append(store, 0, { eventType: "DEVELOPER_USAGE_LIMIT_WAIT_ENDED", runId: "r1", taskId: "T1", executionPhase: "development" });
  append(store, 5_000, { eventType: "DEVELOPER_USAGE_LIMIT_WAIT_STARTED", runId: "r1", taskId: "T1", executionPhase: "development" });
  // 짝이 없는 마지막 STARTED(아직 진행 중이거나 프로세스가 죽어 ENDED가 기록되지 않음) — 무시.

  const events = store.query({ runId: "r1" }).events;
  check("G) 고아 ENDED/짝 없는 마지막 STARTED는 추측으로 구간을 만들지 않고 0으로 처리됨", computeUsageLimitWaitMs(events) === 0);
}

function main(): void {
  scenarioSimpleActiveSpanCounted();
  scenarioWaitingHumanTailExcluded();
  scenarioCompletedDoesNotKeepGrowing();
  scenarioDeterministicAcrossReReads();
  scenarioAcrossTasksSumsIndependently();
  scenarioFreezeTailStopsGrowthAfterProcessDeath();
  scenarioFreezeTailAcrossTasks();
  scenarioUsageLimitWaitExcludedFromCorrectedWorkTime();
  scenarioUsageLimitWaitMultipleRoundsSummed();
  scenarioUsageLimitWaitUnmatchedEndedIgnored();

  console.log("\n=== work-time 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
