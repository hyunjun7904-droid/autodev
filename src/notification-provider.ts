import { log, sanitizeForLog } from "./logger";
import type { NotificationMessage } from "./notification";

// Delivery Provider Interface — Phase G Task G5(기반) / G5.1(Telegram 실제 연결).
//
// Core를 특정 외부 모바일 서비스(Telegram/ntfy/Pushover/Email/Web Push 등)에 종속시키지
// 않는다 — 이 인터페이스 하나만 고정한다. send()는 절대 예외를 던지지 않는다 — 실패는
// 항상 { ok: false, error } 로 정직하게 반환한다(secret-scanner.ts/event-store.ts와 동일한
// "실패를 조용히 성공으로 위장하지 않는다" 원칙). 향후 Telegram/ntfy/Pushover 등은 이
// NotificationProvider 하나만 구현하는 별도 adapter 파일로 추가하면 된다 — 이 파일이나
// notification-service.ts를 수정할 필요가 없다.
//
// Phase G Task G5.1 — send()의 반환 타입을 `DeliveryResult | Promise<DeliveryResult>`로
// 넓혔다(순수 추가, 기존 동기 provider의 동작을 전혀 바꾸지 않는다). 실제 외부 HTTP
// provider(Telegram 등)는 네트워크 호출이 본질적으로 비동기라 동기 시그니처로는 구현할 수
// 없다 — Node에 안전한 동기 HTTP API가 없고, 이를 위해 새 동기 HTTP 라이브러리를 추가하는
// 것은 "불필요한 dependency 추가 금지" 원칙에 어긋난다. fake/log provider는 여전히 그냥
// `DeliveryResult`를 동기로 반환한다(값 하나가 `T | Promise<T>` union을 그대로 만족하므로
// 이 두 provider의 코드는 한 글자도 바뀌지 않았다) — notification-service.ts의 호출부만
// `await provider.send(...)`로 양쪽을 동일하게 처리한다(비-Promise 값을 await해도 즉시
// resolve될 뿐 동작이 바뀌지 않는다).

export interface DeliveryResult {
  ok: boolean;
  /** ok가 false일 때만 채워진다. */
  error?: string;
}

export interface NotificationProvider {
  send(notification: NotificationMessage): DeliveryResult | Promise<DeliveryResult>;
}

/**
 * deterministic fake provider — 실제 네트워크/파일 I/O 없이 in-memory에 전달된 notification을
 * 기록한다(테스트 전용). alwaysFail이 true면 항상 실패를 반환한다 — 무작위 실패를 만들지
 * 않는다(§ 요구사항: 이 저장소 전체의 deterministic 테스트 원칙).
 */
export function createFakeNotificationProvider(
  opts: { alwaysFail?: boolean } = {}
): NotificationProvider & { sent: NotificationMessage[] } {
  const sent: NotificationMessage[] = [];
  return {
    sent,
    send(notification) {
      if (opts.alwaysFail) {
        return { ok: false, error: "FAKE_PROVIDER_FORCED_FAILURE" };
      }
      sent.push(notification);
      return { ok: true };
    },
  };
}

/**
 * local/log provider — 실제 외부 서비스 없이 이 저장소의 기존 logger.ts(key 이름 기반
 * redaction 포함)로 기록한다. 이번 Task가 요구하는 "최소 안전 provider"(§ 요구사항)를
 * 만족한다 — NotificationMessage는 이미 short/safe 필드만 담고 있고(§ notification.ts),
 * 이 provider도 그 필드만 그대로 남길 뿐 새 자유 텍스트를 만들지 않는다.
 */
export function createLogNotificationProvider(): NotificationProvider {
  return {
    send(notification) {
      try {
        log(`[notification] ${notification.severity} ${notification.notificationType}: ${notification.title}`, {
          runId: notification.runId,
          taskId: notification.taskId ?? null,
          dedupeKey: notification.dedupeKey,
          shortMessage: notification.shortMessage,
        });
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: sanitizeForLog(message) };
      }
    },
  };
}
