import type { NotificationMessage } from "./notification";
import type { DeliveryResult, NotificationProvider } from "./notification-provider";
import { resolveTelegramConfig, sendTelegramMessage } from "./notification-provider-telegram";
import type { TelegramProviderConfig, TelegramReplyMarkup } from "./notification-provider-telegram";
import { buildApprovalCallbackData, isApprovalExpired } from "./approval";
import type { ApprovalStore } from "./approval-store";

// Telegram Approval-Aware Outbound Provider — Phase G Task G6.
//
// notification-provider-telegram.ts(G5.1)가 이미 이 확장 지점을 예고했다: "G6에서 inline
// keyboard/callback query를 붙일 수 있도록 이 provider의 구조를 막지 않는다." 이 파일은
// 정확히 그 자리를 additive하게 채운다 — notification-service.ts/notification-provider.ts
// (Core G5)는 이 파일의 존재를 전혀 모르고, 한 글자도 수정되지 않는다. 이 provider는
// NotificationProvider interface 하나만 구현하므로 processNotifications()에 기존
// createTelegramNotificationProvider() 대신 그대로 꽂을 수 있다.
//
// send(notification)이 호출될 때마다:
//   1) ApprovalStore에서 notification.dedupeKey로 대응하는 ApprovalRequest를 조회한다
//      (신뢰하지 않는 notification payload가 아니라 store의 실제 레코드만 근거로 삼는다).
//   2) 그 요청이 존재하고, 아직 PENDING이고, 만료되지 않았고, remotelyApprovable=true일
//      때만 inline keyboard(승인/거절/보류)를 붙인다 — 그 외(요청 없음/이미 소비/만료/
//      원격 승인 불가)에는 항상 버튼 없는 일반 텍스트로 보낸다(§ 요구사항: "APPROVE 버튼
//      자체를 제공하지 않거나").
//   3) 단순 INFO notification(대응하는 ApprovalRequest 자체가 없음)에는 항상 버튼이 없다.

function buildMessageText(notification: NotificationMessage): string {
  return `${notification.title}\n${notification.shortMessage}`;
}

export function buildApprovalInlineKeyboard(approvalId: string): TelegramReplyMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ 승인", callback_data: buildApprovalCallbackData(approvalId, "APPROVE") },
        { text: "❌ 거절", callback_data: buildApprovalCallbackData(approvalId, "REJECT") },
        { text: "⏰ 나중에", callback_data: buildApprovalCallbackData(approvalId, "DEFER") },
      ],
    ],
  };
}

/** ApprovalStore 조회 결과만으로 "이 notification에 지금 버튼을 붙여도 되는가"를 판정한다 —
 *  notification 자체에는 approvalId가 없으므로(§ notification.ts, Telegram을 모르는 Core
 *  타입) 항상 dedupeKey로만 상관관계를 맺는다. */
function resolveApprovalIdForButtons(store: ApprovalStore, notification: NotificationMessage, nowIso: string): string | undefined {
  const approval = store.getByDedupeKey(notification.dedupeKey);
  if (!approval) return undefined;
  if (approval.status !== "PENDING") return undefined;
  if (isApprovalExpired(approval, nowIso)) return undefined;
  if (!approval.remotelyApprovable) return undefined;
  return approval.approvalId;
}

export async function sendTelegramApprovalAwareMessage(
  config: TelegramProviderConfig,
  store: ApprovalStore,
  notification: NotificationMessage,
  opts: { now?: () => string } = {}
): Promise<DeliveryResult> {
  const { botToken, chatId, timeoutMs, fetchImpl, configStatus } = resolveTelegramConfig(config);
  if (configStatus === "NOT_CONFIGURED" || !botToken || !chatId) {
    return { ok: false, error: "TELEGRAM_NOT_CONFIGURED" };
  }
  const nowIso = opts.now ? opts.now() : new Date().toISOString();
  const approvalId = resolveApprovalIdForButtons(store, notification, nowIso);
  const replyMarkup = approvalId ? buildApprovalInlineKeyboard(approvalId) : undefined;
  return sendTelegramMessage(fetchImpl, botToken, chatId, timeoutMs, buildMessageText(notification), replyMarkup);
}

/** notification-service.ts의 processNotifications()에 그대로 꽂을 수 있는
 *  NotificationProvider — G5의 dedupe/재시도/우선순위 배선을 전혀 바꾸지 않는다(§ 파일 상단
 *  주석). */
export function createTelegramApprovalAwareProvider(config: TelegramProviderConfig, store: ApprovalStore): NotificationProvider {
  return {
    send(notification: NotificationMessage): Promise<DeliveryResult> {
      return sendTelegramApprovalAwareMessage(config, store, notification);
    },
  };
}
