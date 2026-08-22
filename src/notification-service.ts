import type { AutoDevEvent } from "./observability-event";
import type { EventStore } from "./event-store";
import { extractNotifications, NOTIFICATION_SEVERITY_PRIORITY } from "./notification";
import type { NotificationMessage } from "./notification";
import type { NotificationStore } from "./notification-store";
import type { NotificationProvider } from "./notification-provider";

// Notification Delivery Orchestration — Phase G Task G5.
//
// Event/Snapshot → deterministic notification 판단(notification.ts) → 중복/우선순위
// 처리(notification-store.ts의 dedupeKey + severity 정렬) → Delivery Provider
// (notification-provider.ts) → 전달 결과 기록까지 배선하는 단일 진입점이다.
//
// 이 함수는 production 판정(orchestrator.ts의 상태 전이, checkpoint.ts의 승인 조건, Test/
// Security Gate)을 전혀 읽지도 바꾸지도 않는다 — 순수하게 이미 일어난 사실을 사람에게
// 알리는 부가 경로다. 알림 전달이 실패해도(provider가 없거나 send()가 실패해도) Security
// BLOCK을 풀거나, Human Approval을 자동 승인하거나, Test FAIL을 PASS로 바꾸거나,
// Checkpoint를 임의 진행시키는 경로는 이 파일 어디에도 없다 — 이 함수의 반환값은
// NotificationStore/EventStore 부수효과 기록일 뿐, 어떤 production 상태 객체도 인자로
// 받거나 반환하지 않는다.
//
// 무한 재시도 금지 — DEFAULT_MAX_DELIVERY_ATTEMPTS(3)에 도달한 FAILED record는 이후 호출에서
// 더 이상 재시도하지 않는다(그대로 FAILED로 남는다, 조용히 DELIVERED로 위장하지 않는다).
// 실제 background timer/scheduler는 이 Task 범위 밖이다 — 이 함수를 호출할 때마다(예: 향후
// polling 프로세스) 그 시점 기준으로 미전달/재시도 가능 record를 한 번 처리하는 것이
// "retry seam"이다.
//
// Phase G Task G5.1 — 이 함수는 이제 async다(notification-provider.ts가 send()를
// `DeliveryResult | Promise<DeliveryResult>`로 넓혔기 때문 — Telegram처럼 실제 네트워크
// I/O가 필요한 provider를 동일한 retry/dedupe/우선순위 배선에 그대로 꽂기 위함). 전달은
// 여전히 record 하나씩 순차로 처리한다(동시 발송으로 인한 순서 뒤섞임/rate limit 위반을
// 피하기 위함 — § 우선순위 처리가 의미를 가지려면 순서가 보장돼야 한다).

export const DEFAULT_MAX_DELIVERY_ATTEMPTS = 3;

export interface ProcessNotificationsOptions {
  maxAttempts?: number;
  /** 테스트 전용 override — 기본값은 매 시도마다 실제 Date.now() 기준 ISO 문자열. */
  now?: () => string;
  /**
   * 지정하면 NOTIFICATION_CREATED/NOTIFICATION_DELIVERED/NOTIFICATION_FAILED audit event를
   * 함께 남긴다(§ 요구사항: 필요하면 Audit/Event 구조에 연결) — 지정하지 않으면 이 함수는
   * EventStore를 전혀 건드리지 않는다(event-store.ts의 checkAuditWritable?()와 동일한
   * optional seam 패턴). 이 event들은 audit-critical로 분류돼 있지 않다(§
   * observability-event.ts) — append 실패를 이 함수가 별도로 감지/재시도하지 않는다(알림
   * bookkeeping 실패가 checkpoint/run 진행을 막아서는 안 된다는 원칙과 동일선상).
   */
  eventStore?: EventStore;
}

export interface ProcessNotificationsResult {
  /** 이번 호출에서 새로 dedupe를 통과해 store에 PENDING으로 만들어진 알림. */
  created: NotificationMessage[];
  /** 이번 호출에서 실제로 전달 성공한 알림(severity 우선순위 순). */
  delivered: NotificationMessage[];
  /** 이번 호출에서 전달을 시도했지만 실패한 알림. */
  failed: NotificationMessage[];
  /** dedupe로 인해 이번 호출에서 새로 만들지 않은 event 개수(이미 store에 있던 dedupeKey). */
  dedupedCount: number;
  /** provider가 없어서 전달을 전혀 시도하지 않았으면 false — 그래도 created/dedupedCount는
   *  정상 계산된다(분류/dedupe와 전달은 별개 단계). */
  providerConfigured: boolean;
}

function defaultNow(): string {
  return new Date().toISOString();
}

export async function processNotifications(
  events: AutoDevEvent[],
  store: NotificationStore,
  provider?: NotificationProvider,
  opts: ProcessNotificationsOptions = {}
): Promise<ProcessNotificationsResult> {
  const now = opts.now ?? defaultNow;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_DELIVERY_ATTEMPTS;

  // 1) 분류 + dedupe — 새 알림만 PENDING으로 store에 기록한다.
  const created: NotificationMessage[] = [];
  let dedupedCount = 0;

  for (const notification of extractNotifications(events)) {
    if (store.has(notification.dedupeKey)) {
      dedupedCount += 1;
      continue;
    }
    store.createPending(notification);
    created.push(notification);
    opts.eventStore?.append({
      eventType: "NOTIFICATION_CREATED",
      runId: notification.runId,
      projectId: notification.projectId,
      taskId: notification.taskId,
      metadata: { notificationType: notification.notificationType, dedupeKey: notification.dedupeKey },
    });
  }

  const delivered: NotificationMessage[] = [];
  const failed: NotificationMessage[] = [];

  // 2) provider가 없으면 전달을 시도조차 하지 않는다 — 조용히 성공/실패로 위장하지 않고
  //    명확히 providerConfigured:false를 반환한다(§ 요구사항: provider 없음 → 명확한 상태).
  //    이때도 store의 레코드는 PENDING으로 남아 있다 — 다음 호출(provider가 준비된 이후)에서
  //    그대로 재시도 대상이 된다.
  if (!provider) {
    return { created, delivered, failed, dedupedCount, providerConfigured: false };
  }

  // 3) 재시도 대상 — PENDING 전체 + FAILED 중 아직 상한에 도달하지 않은 것만. severity
  //    우선순위(CRITICAL > ACTION_REQUIRED > WARNING > INFO)로 정렬해 더 급한 알림을 먼저
  //    전달한다(§ 요구사항: 우선순위 처리). Array.prototype.sort는 stable이므로(ES2019+,
  //    이 저장소 target=ES2022) 같은 severity 안에서는 store가 반환한 순서를 그대로 유지한다.
  const retryable = store
    .list()
    .filter((r) => r.deliveryStatus === "PENDING" || (r.deliveryStatus === "FAILED" && r.attemptCount < maxAttempts))
    .sort((a, b) => NOTIFICATION_SEVERITY_PRIORITY[a.notification.severity] - NOTIFICATION_SEVERITY_PRIORITY[b.notification.severity]);

  for (const record of retryable) {
    const result = await provider.send(record.notification);
    const at = now();
    if (result.ok) {
      store.recordDeliverySuccess(record.notification.dedupeKey, at);
      delivered.push(record.notification);
      opts.eventStore?.append({
        eventType: "NOTIFICATION_DELIVERED",
        runId: record.notification.runId,
        projectId: record.notification.projectId,
        taskId: record.notification.taskId,
        metadata: { notificationType: record.notification.notificationType, dedupeKey: record.notification.dedupeKey },
      });
    } else {
      const error = result.error ?? "UNKNOWN_DELIVERY_ERROR";
      store.recordDeliveryFailure(record.notification.dedupeKey, error, at);
      failed.push(record.notification);
      opts.eventStore?.append({
        eventType: "NOTIFICATION_FAILED",
        runId: record.notification.runId,
        projectId: record.notification.projectId,
        taskId: record.notification.taskId,
        reason: error,
        metadata: { notificationType: record.notification.notificationType, dedupeKey: record.notification.dedupeKey },
      });
    }
  }

  return { created, delivered, failed, dedupedCount, providerConfigured: true };
}
