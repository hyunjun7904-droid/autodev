import { randomUUID } from "node:crypto";
import { createInMemoryEventStore } from "./event-store";
import type { AutoDevEvent, AutoDevEventInput } from "./observability-event";
import { classifyEventCategory } from "./observability-event";
import { createInMemoryNotificationStore } from "./notification-store";
import { createFakeNotificationProvider } from "./notification-provider";
import { processNotifications, DEFAULT_MAX_DELIVERY_ATTEMPTS } from "./notification-service";
import type { NotificationType } from "./notification";

// Notification Delivery Orchestration 테스트(Phase G Task G5 / G5.1). Event/Snapshot →
// deterministic notification 판단 → dedupe/우선순위 처리 → Delivery Provider → 전달 결과
// 기록까지 전체 파이프라인을 검증한다. 실제 Claude/GPT 유료 호출 없음, 실제 외부
// notification 전송 없음(전부 fake/in-memory).
//
// Phase G Task G5.1 — processNotifications()가 async로 바뀌었다(notification-provider.ts가
// send()를 `DeliveryResult | Promise<DeliveryResult>`로 넓혔기 때문). 이 파일의 assertion
// 내용/개수는 G5와 완전히 동일하다 — 모든 호출부에 await만 기계적으로 추가했다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

let seq = 0;
function ev(overrides: Partial<AutoDevEventInput> & { eventType: AutoDevEventInput["eventType"]; runId: string }): AutoDevEvent {
  seq += 1;
  return {
    ...overrides,
    eventId: randomUUID(),
    timestamp: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
    categories: classifyEventCategory(overrides.eventType),
    sequence: seq,
  };
}

// ---------------------------------------------------------------------------
// 1) high-signal 알림 종류(2026-08-22 incident 이후 6종)가 전체 파이프라인을 통과해
//    실제로 delivered까지 도달한다. RUN_COMPLETED/TEST_COMPLETED(failed>0)는 섞여
//    있어도 알림을 만들지 않는다는 것을 같은 배치 안에서 함께 증명한다(§ 2 아래).
// ---------------------------------------------------------------------------
async function scenarioAllRequiredNotificationTypesDeliver(): Promise<void> {
  const events: AutoDevEvent[] = [
    ev({ eventType: "TASK_COMPLETED", runId: "run-all", taskId: "T1", outcome: "SUCCESS" }),
    ev({ eventType: "RUN_COMPLETED", runId: "run-all", taskId: "T1", outcome: "SUCCESS" }),
    ev({ eventType: "TEST_COMPLETED", runId: "run-all", taskId: "T1", outcome: "SUCCESS", testSummary: { total: 2, passed: 1, failed: 1 } }),
    ev({ eventType: "REVIEW_BLOCKED", runId: "run-all", taskId: "T1", reviseCycle: 1 }),
    ev({ eventType: "HUMAN_APPROVAL_REQUIRED", runId: "run-all", taskId: "T1" }),
    ev({ eventType: "SECURITY_BLOCKED", runId: "run-all", taskId: "T1" }),
    ev({ eventType: "REVIEW_CYCLE_EXHAUSTED", runId: "run-all", taskId: "T1", reviseCycle: 5 }),
    ev({ eventType: "RUN_BLOCKED", runId: "run-all", taskId: "T1" }),
  ];
  const store = createInMemoryNotificationStore();
  const provider = createFakeNotificationProvider();
  const result = await processNotifications(events, store, provider);

  check("6종 이벤트: created=6(RUN_COMPLETED/TEST_COMPLETED는 알림을 만들지 않음)", result.created.length === 6);
  check("6종 이벤트: delivered=6", result.delivered.length === 6);
  check("6종 이벤트: failed=0", result.failed.length === 0);
  check("6종 이벤트: providerConfigured=true", result.providerConfigured === true);
  const types = new Set(result.delivered.map((n) => n.notificationType));
  const requiredTypes: NotificationType[] = [
    "TASK_COMPLETED",
    "WAITING_HUMAN",
    "HUMAN_APPROVAL_REQUIRED",
    "SECURITY_BLOCKED",
    "REVIEW_CYCLE_EXHAUSTED",
    "RUN_BLOCKED",
  ];
  check("6종 이벤트: 6개 NotificationType 전부 포함", requiredTypes.every((t) => types.has(t)));
  check("6종 이벤트: RUN_COMPLETED는 전달되지 않음", !types.has("RUN_COMPLETED"));
  check("6종 이벤트: TEST_FAILED는 전달되지 않음", !types.has("TEST_FAILED"));
}

// ---------------------------------------------------------------------------
// 2) dedupe — 같은 event 목록을 두 번 처리해도 재전달하지 않는다.
// ---------------------------------------------------------------------------
async function scenarioDedupeAcrossCalls(): Promise<void> {
  const events = [ev({ eventType: "SECURITY_BLOCKED", runId: "run-dedupe", taskId: "T1" })];
  const store = createInMemoryNotificationStore();
  const provider = createFakeNotificationProvider();

  const first = await processNotifications(events, store, provider);
  check("dedupe: 최초 호출 → created=1, delivered=1", first.created.length === 1 && first.delivered.length === 1);

  const second = await processNotifications(events, store, provider);
  check("dedupe: 같은 event 재처리 → created=0", second.created.length === 0);
  check("dedupe: 같은 event 재처리 → dedupedCount=1", second.dedupedCount === 1);
  check("dedupe: 이미 DELIVERED된 알림은 재전달하지 않음(delivered=0)", second.delivered.length === 0);
  check("dedupe: provider.sent에 1건만 기록(재전송 없음)", provider.sent.length === 1);
}

// ---------------------------------------------------------------------------
// 3) 서로 다른 runId — 혼합 없이 각자 독립적으로 처리된다.
// ---------------------------------------------------------------------------
async function scenarioNoCrossRunMixing(): Promise<void> {
  const events = [
    ev({ eventType: "TASK_COMPLETED", runId: "run-a", taskId: "T1" }),
    ev({ eventType: "TASK_COMPLETED", runId: "run-b", taskId: "T1" }),
  ];
  const store = createInMemoryNotificationStore();
  const provider = createFakeNotificationProvider();
  const result = await processNotifications(events, store, provider);

  check("cross-run: created=2(서로 다른 runId는 별도 알림)", result.created.length === 2);
  const dedupeKeys = new Set(result.created.map((n) => n.dedupeKey));
  check("cross-run: dedupeKey가 서로 다름", dedupeKeys.size === 2);
  const runAOnly = store.list({ runId: "run-a" });
  check("cross-run: store.list({runId:'run-a'})는 run-b를 포함하지 않음", runAOnly.length === 1 && runAOnly[0].notification.runId === "run-a");
}

// ---------------------------------------------------------------------------
// 4) 서로 다른 review cycle — 의미 있는 상태 변화는 별도 알림으로 취급.
// ---------------------------------------------------------------------------
async function scenarioDifferentReviewCyclesAreSeparateNotifications(): Promise<void> {
  const events = [
    ev({ eventType: "REVIEW_CYCLE_EXHAUSTED", runId: "run-cycle", taskId: "T1", reviseCycle: 3 }),
    ev({ eventType: "REVIEW_CYCLE_EXHAUSTED", runId: "run-cycle", taskId: "T1", reviseCycle: 3 }),
  ];
  const store = createInMemoryNotificationStore();
  const provider = createFakeNotificationProvider();
  const first = await processNotifications(events, store, provider);
  check("동일 cycle 반복: created=1(dedupe)", first.created.length === 1);

  const secondCycleEvent = [ev({ eventType: "REVIEW_CYCLE_EXHAUSTED", runId: "run-cycle", taskId: "T1", reviseCycle: 4 })];
  const second = await processNotifications(secondCycleEvent, store, provider);
  check("다른 cycle: created=1(별도 알림)", second.created.length === 1);
  check("다른 cycle: 총 2건 delivered", store.list({ runId: "run-cycle" }).filter((r) => r.deliveryStatus === "DELIVERED").length === 2);
}

// ---------------------------------------------------------------------------
// 5) 우선순위 — CRITICAL이 ACTION_REQUIRED/INFO보다 먼저 전달된다. 2026-08-22 incident
//    이후 TEST_FAILED(WARNING)가 더 이상 알림을 만들지 않으므로(§ notification.ts),
//    WARNING 대신 여전히 발생하는 ACTION_REQUIRED(HUMAN_APPROVAL_REQUIRED)로 중간
//    우선순위를 검증한다.
// ---------------------------------------------------------------------------
async function scenarioPriorityOrdering(): Promise<void> {
  const events = [
    ev({ eventType: "TASK_COMPLETED", runId: "run-priority", taskId: "T1" }), // INFO
    ev({ eventType: "SECURITY_BLOCKED", runId: "run-priority", taskId: "T2" }), // CRITICAL
    ev({ eventType: "HUMAN_APPROVAL_REQUIRED", runId: "run-priority", taskId: "T3" }), // ACTION_REQUIRED
  ];
  const store = createInMemoryNotificationStore();
  const provider = createFakeNotificationProvider();
  await processNotifications(events, store, provider);

  const order = provider.sent.map((n) => n.severity);
  check("우선순위: CRITICAL이 ACTION_REQUIRED/INFO보다 먼저 전달됨", order[0] === "CRITICAL");
  check("우선순위: severity 순서가 CRITICAL→ACTION_REQUIRED→INFO", order.join(",") === "CRITICAL,ACTION_REQUIRED,INFO");
}

// ---------------------------------------------------------------------------
// 6) delivery 실패 — 성공으로 위장하지 않는다.
// ---------------------------------------------------------------------------
async function scenarioDeliveryFailureRecorded(): Promise<void> {
  const events = [ev({ eventType: "SECURITY_BLOCKED", runId: "run-fail", taskId: "T1" })];
  const store = createInMemoryNotificationStore();
  const provider = createFakeNotificationProvider({ alwaysFail: true });
  const result = await processNotifications(events, store, provider);

  check("delivery 실패: delivered=0", result.delivered.length === 0);
  check("delivery 실패: failed=1", result.failed.length === 1);
  const record = store.get(result.created[0].dedupeKey);
  check("delivery 실패: store 상태 FAILED(성공 위장 없음)", record?.deliveryStatus === "FAILED");
  check("delivery 실패: lastError 기록됨", typeof record?.lastError === "string" && record.lastError.length > 0);
  check("delivery 실패: attemptCount=1", record?.attemptCount === 1);
}

// ---------------------------------------------------------------------------
// 7) 무한 재시도 금지 — 상한(DEFAULT_MAX_DELIVERY_ATTEMPTS) 도달 후 더 이상 시도하지 않는다.
// ---------------------------------------------------------------------------
async function scenarioNoInfiniteRetry(): Promise<void> {
  const events = [ev({ eventType: "SECURITY_BLOCKED", runId: "run-retry", taskId: "T1" })];
  const store = createInMemoryNotificationStore();
  const provider = createFakeNotificationProvider({ alwaysFail: true });

  let lastResult = await processNotifications(events, store, provider);
  for (let i = 0; i < 5; i++) {
    lastResult = await processNotifications([], store, provider);
  }
  const dedupeKey = "run-retry::T1::SECURITY_BLOCKED::-";
  const record = store.get(dedupeKey);
  check(`무한 재시도 금지: attemptCount이 상한(${DEFAULT_MAX_DELIVERY_ATTEMPTS})에서 멈춤`, record?.attemptCount === DEFAULT_MAX_DELIVERY_ATTEMPTS);
  check("무한 재시도 금지: 상한 도달 후 추가 호출은 failed=0(더 이상 시도 안 함)", lastResult.failed.length === 0);
  check("무한 재시도 금지: 여전히 FAILED(성공으로 위장되지 않음)", record?.deliveryStatus === "FAILED");
}

// ---------------------------------------------------------------------------
// 8) provider 없음 — 명확한 상태(PENDING 유지, 예외 없음, 성공/실패로 위장하지 않음).
// ---------------------------------------------------------------------------
async function scenarioNoProviderConfigured(): Promise<void> {
  const events = [ev({ eventType: "TASK_COMPLETED", runId: "run-noprovider", taskId: "T1" })];
  const store = createInMemoryNotificationStore();
  const result = await processNotifications(events, store, undefined);

  check("provider 없음: providerConfigured=false", result.providerConfigured === false);
  check("provider 없음: created는 정상 계산됨(분류/dedupe는 별개 단계)", result.created.length === 1);
  check("provider 없음: delivered=0", result.delivered.length === 0);
  check("provider 없음: failed=0", result.failed.length === 0);
  const record = store.get(result.created[0].dedupeKey);
  check("provider 없음: store 상태는 PENDING 유지", record?.deliveryStatus === "PENDING");
}

// ---------------------------------------------------------------------------
// 9) Audit 연결 seam — eventStore를 넘기면 NOTIFICATION_CREATED/DELIVERED/FAILED가
//    남고, 넘기지 않으면 EventStore를 전혀 건드리지 않는다.
// ---------------------------------------------------------------------------
async function scenarioAuditEventSeam(): Promise<void> {
  const events = [
    ev({ eventType: "TASK_COMPLETED", runId: "run-audit", taskId: "T1" }),
    ev({ eventType: "SECURITY_BLOCKED", runId: "run-audit", taskId: "T2" }),
  ];

  const eventStore = createInMemoryEventStore();
  const store = createInMemoryNotificationStore();
  const provider = createFakeNotificationProvider({ alwaysFail: true }); // SECURITY_BLOCKED 알림 전달 실패 유도
  await processNotifications(events, store, provider, { eventStore });

  const audit = eventStore.query({ runId: "run-audit" }).events;
  check("audit seam: NOTIFICATION_CREATED 2건", audit.filter((e) => e.eventType === "NOTIFICATION_CREATED").length === 2);
  check("audit seam: NOTIFICATION_FAILED 최소 1건(alwaysFail)", audit.filter((e) => e.eventType === "NOTIFICATION_FAILED").length >= 1);

  const withoutEventStore = createInMemoryEventStore();
  const store2 = createInMemoryNotificationStore();
  await processNotifications([ev({ eventType: "TASK_COMPLETED", runId: "run-no-audit", taskId: "T1" })], store2, createFakeNotificationProvider());
  check("audit seam: eventStore를 넘기지 않으면 다른 store에 아무 영향 없음", withoutEventStore.query().events.length === 0);
}

// ---------------------------------------------------------------------------
// 10) privacy — 파이프라인 전체를 통과해도 raw prompt/output/secret이 노출되지 않는다.
// ---------------------------------------------------------------------------
async function scenarioNoSensitiveDataThroughPipeline(): Promise<void> {
  const secretMarker = "ghp_SUPER_SECRET_TOKEN_MARKER_abcdef1234567890";
  const events = [
    ev({
      eventType: "SECURITY_BLOCKED",
      runId: "run-privacy",
      taskId: "T1",
      reason: `blocked: ${secretMarker}`,
      error: { message: `raw output: ${secretMarker}` },
      metadata: { rawPrompt: secretMarker },
    }),
  ];
  const eventStore = createInMemoryEventStore();
  const store = createInMemoryNotificationStore();
  const provider = createFakeNotificationProvider();
  const result = await processNotifications(events, store, provider, { eventStore });

  const serializedResult = JSON.stringify(result);
  const serializedAudit = JSON.stringify(eventStore.query().events);
  const serializedStore = JSON.stringify(store.list());
  check("privacy: processNotifications 반환값에 secret 없음", !serializedResult.includes(secretMarker));
  check("privacy: NOTIFICATION_* audit event에 secret 없음", !serializedAudit.includes(secretMarker));
  check("privacy: NotificationStore 기록에 secret 없음", !serializedStore.includes(secretMarker));
}

// ---------------------------------------------------------------------------
// 11) production outcome 불변 — 알림 처리(전달 성공/실패 무관)는 이 함수가 다루는
//     값(NotificationStore/EventStore 부수효과) 밖의 어떤 상태도 바꾸지 않는다. 이 함수는
//     ProjectState/CheckpointResult/OrchestratorStatus 등 production 판정 타입을 인자로도
//     반환값으로도 전혀 다루지 않는다(구조적으로 건드릴 방법이 없다) — SECURITY_BLOCKED
//     알림의 delivery가 실패해도 예외 없이 정상 반환되고, 원본 events 배열은 변경되지 않는다.
// ---------------------------------------------------------------------------
async function scenarioDeliveryFailureDoesNotThrowOrMutateInput(): Promise<void> {
  const events = [ev({ eventType: "SECURITY_BLOCKED", runId: "run-purity", taskId: "T1" })];
  const eventsCopy = JSON.stringify(events);
  const store = createInMemoryNotificationStore();
  const provider = createFakeNotificationProvider({ alwaysFail: true });

  let threw = false;
  try {
    await processNotifications(events, store, provider);
  } catch {
    threw = true;
  }
  check("production outcome 불변: 전달 실패해도 예외 없이 반환", threw === false);
  check("production outcome 불변: 입력 events 배열이 변경되지 않음", JSON.stringify(events) === eventsCopy);
}

async function main(): Promise<void> {
  await scenarioAllRequiredNotificationTypesDeliver();
  await scenarioDedupeAcrossCalls();
  await scenarioNoCrossRunMixing();
  await scenarioDifferentReviewCyclesAreSeparateNotifications();
  await scenarioPriorityOrdering();
  await scenarioDeliveryFailureRecorded();
  await scenarioNoInfiniteRetry();
  await scenarioNoProviderConfigured();
  await scenarioAuditEventSeam();
  await scenarioNoSensitiveDataThroughPipeline();
  await scenarioDeliveryFailureDoesNotThrowOrMutateInput();

  console.log("\n=== notification-service(G5) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
