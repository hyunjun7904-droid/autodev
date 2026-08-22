import "dotenv/config";
import type { NotificationMessage } from "./notification";
import type { DeliveryResult, NotificationProvider } from "./notification-provider";

// Telegram Bot API Outbound Provider — Phase G Task G5.1.
//
// Core Notification Service(notification-service.ts)/Notification 판정(notification.ts)은
// 이 파일을 import하지 않는다 — Telegram은 이 adapter 파일에서만 안다. 이 provider는
// NotificationProvider interface(notification-provider.ts) 하나만 구현한다 — Core가
// 특정 외부 모바일 서비스에 종속되지 않는다는 원칙을 그대로 지킨다.
//
// Bot Token은 secret이다 — 이 파일 어디에서도 token 값을 로그/에러/EventStore/
// NotificationStore/Dashboard에 남기지 않는다. token은 오직 Telegram 공식 Bot API가
// 요구하는 대로 요청 URL(`/bot<token>/sendMessage`) 일부로만 쓰이고, 그 URL 자체를 로그로
// 남기는 코드 경로가 이 파일에 없다. 실패 시에도 항상 고정된 error code(§
// buildDeliveryFailure)만 반환한다 — Telegram 응답 본문(description)이나 fetch 예외
// message 원문을 그대로 옮기지 않는다(사람이 읽는 자유 텍스트가 어떤 값을 담을지 예측할
// 수 없기 때문 — § 요구사항: API 응답 원문 미기록).
//
// Chat allowlist — 이 provider는 생성 시점에 고정된 chatId 하나로만 전송한다.
// NotificationMessage 타입 자체에 chatId 필드가 없어(§ notification.ts), notification
// payload로부터 전송 대상을 바꿀 수 있는 코드 경로가 구조적으로 없다.
//
// G6에서 inline keyboard/callback query(Approve/Reject/Defer)를 붙일 수 있도록 이 provider의
// 구조(설정 주입 → fetch 호출 하나)를 막지 않는다 — 그러나 이번 Task는 getUpdates/webhook/
// callback_query 처리/Auto Resume을 전혀 구현하지 않는다(범위 밖).

const TELEGRAM_API_BASE = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface TelegramProviderConfig {
  /** 지정하지 않으면 AUTODEV_TELEGRAM_BOT_TOKEN 환경변수를 쓴다. */
  botToken?: string;
  /** 지정하지 않으면 AUTODEV_TELEGRAM_CHAT_ID 환경변수를 쓴다. 이 provider가 실제로 전송할
   *  유일한 대상이다(§ Chat allowlist) — send() 인자(notification)에서 재정의할 방법이 없다. */
  chatId?: string;
  timeoutMs?: number;
  /** 테스트 전용 override — 지정하지 않으면 전역 fetch를 쓴다. 실제 네트워크를 타지 않는
   *  fake fetch를 주입해 이 provider를 완전히 deterministic하게 검증할 수 있다. */
  fetchImpl?: typeof fetch;
}

export type TelegramConfigStatus = "CONFIGURED" | "NOT_CONFIGURED";

export interface TelegramNotificationProvider extends NotificationProvider {
  /** botToken/chatId가 둘 다 있어야 CONFIGURED — 하나라도 없으면 NOT_CONFIGURED(§ 요구사항:
   *  가짜 성공 처리 금지, 명확한 상태). send()를 호출하지 않고도 확인할 수 있다. */
  readonly configStatus: TelegramConfigStatus;
}

interface TelegramSendMessageResponse {
  ok: boolean;
  error_code?: number;
}

function isTelegramSendMessageResponse(value: unknown): value is TelegramSendMessageResponse {
  return !!value && typeof value === "object" && typeof (value as Record<string, unknown>).ok === "boolean";
}

/** NotificationMessage(이미 G5가 안전하게 만든 고정 템플릿 필드)만 쓴다 — event.reason/
 *  error/rawOutput/metadata 등 원본 event의 자유 텍스트를 다시 읽거나 추가하지 않는다(§
 *  요구사항). title + shortMessage만으로 이미 휴대폰에서 바로 이해 가능한 두 줄이다(§
 *  notification.ts NOTIFICATION_CONTENT — "[AutoDev] 승인 필요" + "Task T1가 WAITING_HUMAN
 *  상태입니다." 형태). */
function buildMessageText(notification: NotificationMessage): string {
  return `${notification.title}\n${notification.shortMessage}`;
}

// Phase G Task G6 — Telegram inline keyboard(Approve/Reject/Defer)용 최소 타입. 이 파일은
// callback_data의 실제 형식/의미(approval.ts의 buildApprovalCallbackData)를 모른다 — 그저
// Telegram sendMessage의 reply_markup 필드를 그대로 전달할 뿐이다.
export interface TelegramInlineKeyboardButton {
  text: string;
  callback_data: string;
}
export interface TelegramReplyMarkup {
  inline_keyboard: TelegramInlineKeyboardButton[][];
}

/** botToken/chatId/timeoutMs/fetchImpl 해석 로직의 단일 출처 — createTelegramNotificationProvider()와
 *  G6의 approval-aware 전송 경로(telegram-approval-provider.ts)가 이 하나만 공유한다(중복
 *  구현 금지). */
export function resolveTelegramConfig(config: TelegramProviderConfig = {}): {
  botToken?: string;
  chatId?: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  configStatus: TelegramConfigStatus;
} {
  const botToken = config.botToken ?? process.env.AUTODEV_TELEGRAM_BOT_TOKEN;
  const chatId = config.chatId ?? process.env.AUTODEV_TELEGRAM_CHAT_ID;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = config.fetchImpl ?? fetch;
  const configStatus: TelegramConfigStatus = botToken && chatId ? "CONFIGURED" : "NOT_CONFIGURED";
  return { botToken, chatId, timeoutMs, fetchImpl, configStatus };
}

/** sendMessage 호출 하나의 최하위 구현 — text + (있으면) reply_markup만 전송한다. G5.1의
 *  기존 sendViaTelegram()과 G6의 approval 전송(§ telegram-approval-provider.ts)이 이 함수
 *  하나만 공유한다 — timeout/AbortController/원문 미기록 정책이 두 곳에서 갈라지지 않는다. */
export async function sendTelegramMessage(
  fetchImpl: typeof fetch,
  botToken: string,
  chatId: string,
  timeoutMs: number,
  text: string,
  replyMarkup?: TelegramReplyMarkup
): Promise<DeliveryResult> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // chat_id는 항상 호출부가 고정 설정한 값이다 — notification/approval payload에서
      // 읽지 않는다(§ Chat allowlist).
      body: JSON.stringify({ chat_id: chatId, text, ...(replyMarkup ? { reply_markup: replyMarkup } : {}) }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, error: `TELEGRAM_HTTP_ERROR_${response.status}` };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: "TELEGRAM_INVALID_RESPONSE" };
    }
    if (!isTelegramSendMessageResponse(body)) {
      return { ok: false, error: "TELEGRAM_INVALID_RESPONSE" };
    }
    // HTTP 200만으로 성공 처리하지 않는다 — Telegram Bot API의 구조화된 ok 값을 반드시
    // 확인한다(§ 요구사항). description(자유 텍스트, 원문 미기록 대상)은 절대 읽지 않는다 —
    // error_code(정수, secret 아님)만 안전하게 재사용한다.
    if (!body.ok) {
      return { ok: false, error: `TELEGRAM_API_ERROR_${body.error_code ?? "UNKNOWN"}` };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "TELEGRAM_TIMEOUT" };
    }
    // fetch 예외의 message 원문은 절대 반환하지 않는다 — DNS/TLS/connection 실패 메시지에
    // 어떤 정보가 담길지 이 파일이 통제할 수 없기 때문이다(§ 요구사항: 원문 미기록).
    return { ok: false, error: "TELEGRAM_NETWORK_ERROR" };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Telegram Bot API(sendMessage) 기반 NotificationProvider를 만든다. botToken/chatId는
 * config로 명시하지 않으면 AUTODEV_TELEGRAM_BOT_TOKEN/AUTODEV_TELEGRAM_CHAT_ID
 * 환경변수에서 읽는다(이 저장소의 기존 AUTODEV_* 환경변수 convention — project-context.ts의
 * AUTODEV_TARGET_PROJECT_ROOT/AUTODEV_STATE_PATH, run.ts의 AUTODEV_PROJECT_ADAPTER,
 * dashboard.ts의 AUTODEV_DASHBOARD_PORT와 동일). 값을 하나라도 읽지 못하면 configStatus는
 * NOT_CONFIGURED로 고정되고, send()는 실제 네트워크를 전혀 타지 않고 즉시
 * { ok:false, error:"TELEGRAM_NOT_CONFIGURED" }를 반환한다 — Core run을 깨뜨리지 않고,
 * 가짜 성공으로도 위장하지 않는다(§ 요구사항).
 *
 * Provider 내부 retry는 없다 — send() 1회 호출은 fetch 1회만 시도한다. G5의 bounded retry
 * 정책(notification-service.ts의 DEFAULT_MAX_DELIVERY_ATTEMPTS)이 이 provider를 감싸는
 * 유일한 재시도 계층이다(§ 요구사항: 무한 재시도 금지, retry 정책은 G5 그대로 재사용).
 */
export function createTelegramNotificationProvider(config: TelegramProviderConfig = {}): TelegramNotificationProvider {
  const { botToken, chatId, timeoutMs, fetchImpl, configStatus } = resolveTelegramConfig(config);

  return {
    configStatus,
    send(notification: NotificationMessage): Promise<DeliveryResult> {
      if (configStatus === "NOT_CONFIGURED" || !botToken || !chatId) {
        return Promise.resolve({ ok: false, error: "TELEGRAM_NOT_CONFIGURED" });
      }
      return sendTelegramMessage(fetchImpl, botToken, chatId, timeoutMs, buildMessageText(notification));
    },
  };
}
