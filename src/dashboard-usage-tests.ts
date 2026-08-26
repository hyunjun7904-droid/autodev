import { createInMemoryEventStore } from "./event-store";
import type { EventStore } from "./event-store";
import { aggregateProviderModelUsage, sumProviderModelUsage, buildRecentCalls, providerDisplayName, aggregateCallEfficiency } from "./dashboard-usage";

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

function scenarioProviderNamesMappedCorrectly(): void {
  check("anthropic -> Claude", providerDisplayName("anthropic") === "Claude");
  check("openai -> OpenAI", providerDisplayName("openai") === "OpenAI");
  check("fireworks -> Fireworks", providerDisplayName("fireworks") === "Fireworks");
  check("groq -> Groq", providerDisplayName("groq") === "Groq");
  check("알 수 없는 provider는 원문 그대로", providerDisplayName("some-new-provider") === "some-new-provider");
}

function scenarioOnlyActuallyCalledServicesAppear(): void {
  const store = createInMemoryEventStore();
  append(store, 0, {
    eventType: "TEST_COMPLETED",
    runId: "r1",
    taskId: "T1",
    executionPhase: "test",
    outcome: "SUCCESS",
    reviseCycle: 1,
    model: { provider: "anthropic", name: "claude-sonnet-5" },
    tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  });
  const events = store.query().events;
  const usage = aggregateProviderModelUsage(events);
  check("실제로 호출된 provider(Claude)만 나타남", usage.length === 1 && usage[0].service === "Claude");
  check("Groq/Fireworks 등 호출되지 않은 서비스는 나타나지 않음", !usage.some((u) => u.service === "Groq" || u.service === "Fireworks"));
  check("입력/출력/전체 토큰이 정확히 집계됨", usage[0].inputTokens === 100 && usage[0].outputTokens === 50 && usage[0].totalTokens === 150);
  check("호출 횟수가 1로 집계됨", usage[0].callCount === 1);
}

function scenarioMultipleServicesAggregatedSeparately(): void {
  const store = createInMemoryEventStore();
  append(store, 0, {
    eventType: "TEST_COMPLETED",
    runId: "r1",
    taskId: "T1",
    executionPhase: "test",
    outcome: "SUCCESS",
    reviseCycle: 1,
    model: { provider: "anthropic", name: "claude-sonnet-5" },
    tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  });
  append(store, 1_000, {
    eventType: "REVIEW_APPROVED",
    runId: "r1",
    taskId: "T1",
    executionPhase: "review",
    outcome: "SUCCESS",
    reviseCycle: 1,
    model: { provider: "fireworks", name: "gpt-oss-120b" },
    tokenUsage: { inputTokens: 2000, outputTokens: 300, totalTokens: 2300 },
  });
  const events = store.query().events;
  const usage = aggregateProviderModelUsage(events);
  check("Claude/Fireworks 두 서비스가 각각 별도 항목으로 집계됨", usage.length === 2);
  const totals = sumProviderModelUsage(usage);
  check("전체 호출 횟수 합산(2회)", totals.callCount === 2);
  check("전체 토큰 합산(150+2300=2450)", totals.totalTokens === 2450);
}

function scenarioPurposeLabelsReflectRetryVsFirstAttempt(): void {
  const store = createInMemoryEventStore();
  append(store, 0, {
    eventType: "TEST_COMPLETED",
    runId: "r1",
    taskId: "T1",
    executionPhase: "test",
    outcome: "FAILED",
    reviseCycle: 1,
    model: { provider: "anthropic", name: "claude-sonnet-5" },
    tokenUsage: { totalTokens: 100 },
  });
  append(store, 1_000, {
    eventType: "REVIEW_REVISE",
    runId: "r1",
    taskId: "T1",
    executionPhase: "review",
    outcome: "PENDING",
    reviseCycle: 1,
    model: { provider: "fireworks", name: "gpt-oss-120b" },
    tokenUsage: { totalTokens: 200 },
  });
  append(store, 2_000, {
    eventType: "TEST_COMPLETED",
    runId: "r1",
    taskId: "T1",
    executionPhase: "test",
    outcome: "SUCCESS",
    reviseCycle: 2,
    model: { provider: "anthropic", name: "claude-sonnet-5" },
    tokenUsage: { totalTokens: 100 },
  });
  append(store, 3_000, {
    eventType: "REVIEW_APPROVED",
    runId: "r1",
    taskId: "T1",
    executionPhase: "review",
    outcome: "SUCCESS",
    reviseCycle: 2,
    model: { provider: "fireworks", name: "gpt-oss-120b" },
    tokenUsage: { totalTokens: 200 },
  });

  const calls = buildRecentCalls(store.query().events, 10);
  check("총 4건 기록됨", calls.length === 4);
  check("가장 최근 호출이 배열 맨 앞(시각 내림차순)", calls[0].timestamp === iso(3_000));
  const byOffset = (ms: number) => calls.find((c) => c.timestamp === iso(ms));
  check("1차 시도(reviseCycle=1) developer 호출은 '개발'", byOffset(0)?.purpose === "개발");
  check("1차 시도 reviewer 호출은 '검토'", byOffset(1_000)?.purpose === "검토");
  check("2차 시도(reviseCycle=2) developer 호출은 '수정'", byOffset(2_000)?.purpose === "수정");
  check("2차 시도 reviewer 호출은 '재검토'", byOffset(3_000)?.purpose === "재검토");
  check("성공 여부가 outcome 기준으로 정확히 매핑됨(FAILED->false)", byOffset(0)?.success === false);
  check("성공 여부가 outcome 기준으로 정확히 매핑됨(SUCCESS->true)", byOffset(3_000)?.success === true);
}

function scenarioRecentCallsRespectsLimit(): void {
  const store = createInMemoryEventStore();
  for (let i = 0; i < 5; i++) {
    append(store, i * 1000, {
      eventType: "TEST_COMPLETED",
      runId: "r1",
      taskId: "T1",
      executionPhase: "test",
      outcome: "SUCCESS",
      reviseCycle: 1,
      model: { provider: "anthropic", name: "claude-sonnet-5" },
      tokenUsage: { totalTokens: 10 },
    });
  }
  const calls = buildRecentCalls(store.query().events, 3);
  check("limit(3)만큼만 반환됨", calls.length === 3);
  check("가장 최근 것부터 반환됨", calls[0].timestamp === iso(4000));
}

function scenarioDeveloperCallWithoutModelStillCountedAsClaude(): void {
  // 실제 운영 기록(events.jsonl)에서 확인된 사실 — claude CLI가 항상 model 필드를
  // 보고하지는 않는다. TEST_COMPLETED는 구조적으로 항상 Claude Developer 호출이므로,
  // model이 없어도 "Claude가 호출됐다는 사실 자체"는 숨기지 않아야 한다.
  const store = createInMemoryEventStore();
  append(store, 0, {
    eventType: "TEST_COMPLETED",
    runId: "r1",
    taskId: "T1",
    executionPhase: "test",
    outcome: "FAILED",
    reviseCycle: 1,
    tokenUsage: { inputTokens: 90, outputTokens: 15630 },
  });
  const events = store.query().events;
  const usage = aggregateProviderModelUsage(events);
  check("model 필드가 없어도 Claude Developer 호출이 서비스 목록에 나타남", usage.length === 1 && usage[0].service === "Claude");
  check("모델 이름은 실제로 보고되지 않았으므로 undefined로 남음(추측 안 함)", usage[0].model === undefined);
  check("토큰 수치는 정확히 집계됨", usage[0].inputTokens === 90 && usage[0].outputTokens === 15630);

  const calls = buildRecentCalls(events, 10);
  check("최근 호출 기록에도 동일하게 Claude로 표시됨", calls.length === 1 && calls[0].service === "Claude");
}

function scenarioReviewCallWithoutModelIsNotGuessed(): void {
  // Reviewer 역할은 여러 provider를 오갈 수 있으므로(Fireworks/Groq/OpenAI), model이
  // 없으면 Developer와 달리 추측하지 않고 그대로 제외한다.
  const store = createInMemoryEventStore();
  append(store, 0, {
    eventType: "REVIEW_APPROVED",
    runId: "r1",
    taskId: "T1",
    executionPhase: "review",
    outcome: "SUCCESS",
    reviseCycle: 1,
    tokenUsage: { inputTokens: 100, outputTokens: 50 },
  });
  const events = store.query().events;
  check("model이 없는 review 호출은 어떤 provider도 추측하지 않고 제외됨", aggregateProviderModelUsage(events).length === 0);
}

function scenarioEventsWithoutModelAreIgnored(): void {
  const store = createInMemoryEventStore();
  append(store, 0, { eventType: "TASK_STARTED", runId: "r1", taskId: "T1", executionPhase: "task_selection", outcome: "PENDING" });
  const events = store.query().events;
  check("model이 없는 event는 서비스 집계에서 제외됨", aggregateProviderModelUsage(events).length === 0);
  check("model이 없는 event는 최근 호출 기록에서 제외됨", buildRecentCalls(events, 10).length === 0);
}

// 오토데브 대시보드 후속 개선 § 요구사항 16(호출 효율) — claude-developer.ts가 실제로
// 계산한 DeveloperCallStats를 TEST_COMPLETED/HUMAN_APPROVAL_REQUIRED의 metadata에서
// 다시 읽어 합산하는지만 검증한다(§ dashboard-usage.ts CALL_STATS_EVENT_TYPES).
function scenarioCallEfficiencySumsAcrossCycles(): void {
  const store = createInMemoryEventStore();
  append(store, 0, {
    eventType: "TEST_COMPLETED",
    runId: "r1",
    taskId: "T1",
    executionPhase: "test",
    outcome: "SUCCESS",
    reviseCycle: 1,
    metadata: { devTotalRounds: 3, devValidResponseRounds: 2, devLocalRecoveryRounds: 1, devProtocolFailureRounds: 1 },
  });
  append(store, 1_000, {
    eventType: "HUMAN_APPROVAL_REQUIRED",
    runId: "r1",
    taskId: "T1",
    executionPhase: "review",
    outcome: "BLOCKED",
    humanInterventionRequired: true,
    reason: "orchestrator status=WAITING_HUMAN",
    metadata: { devTotalRounds: 3, devValidResponseRounds: 0, devLocalRecoveryRounds: 0, devProtocolFailureRounds: 3 },
  });
  const summary = aggregateCallEfficiency(store.query().events);
  check("호출 효율: totalRounds 합산(3+3=6)", summary?.totalRounds === 6);
  check("호출 효율: validResponseRounds 합산(2+0=2)", summary?.validResponseRounds === 2);
  check("호출 효율: localRecoverySuccessRounds 합산(1+0=1)", summary?.localRecoverySuccessRounds === 1);
  check("호출 효율: protocolFailureRounds 합산(1+3=4)", summary?.protocolFailureRounds === 4);
}

function scenarioCallEfficiencyUndefinedWhenNoMetadata(): void {
  const store = createInMemoryEventStore();
  append(store, 0, { eventType: "TASK_STARTED", runId: "r1", taskId: "T1", executionPhase: "task_selection", outcome: "PENDING" });
  const summary = aggregateCallEfficiency(store.query().events);
  check("호출 효율: metadata가 없으면 0으로 채우지 않고 undefined(추측 금지)", summary === undefined);
}

function main(): void {
  scenarioProviderNamesMappedCorrectly();
  scenarioOnlyActuallyCalledServicesAppear();
  scenarioMultipleServicesAggregatedSeparately();
  scenarioPurposeLabelsReflectRetryVsFirstAttempt();
  scenarioRecentCallsRespectsLimit();
  scenarioDeveloperCallWithoutModelStillCountedAsClaude();
  scenarioReviewCallWithoutModelIsNotGuessed();
  scenarioEventsWithoutModelAreIgnored();
  scenarioCallEfficiencySumsAcrossCycles();
  scenarioCallEfficiencyUndefinedWhenNoMetadata();

  console.log("\n=== dashboard-usage 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
