import "dotenv/config";
import type { DeliveryResult } from "./notification-provider";

// Telegram Inbound — getUpdates Long Polling & Callback Verification — Phase G Task G6.
//
// public webhook/public server는 쓰지 않는다(§ 요구사항) — Telegram 공식 Bot API의
// getUpdates(long polling)만 https://api.telegram.org로 직접 호출한다. 이 파일은 항상
// timeout(AbortController)을 두고, 무한 대기를 만들지 않는다. bounded retry/backoff는
// 이 파일을 호출하는 telegram-controller.ts가 담당한다(이 파일은 순수 transport 1회 호출
// 단위만 제공 — timeout 정책과 폴링 루프 정책을 분리한다).
//
// 발신자 검증(chat/user allowlist)도 이 파일이 담당한다 — AUTODEV_TELEGRAM_CHAT_ID(기존
// G5.1 환경변수 재사용)와 새 AUTODEV_TELEGRAM_USER_ID(선택)로 판정한다. 두 값 모두 이
// 파일이 로그/에러에 원문으로 남기지 않는다(id 자체는 secret은 아니지만, 실패 사유는
// 항상 고정 코드로만 반환한다 — notification-provider-telegram.ts와 동일한 원칙).

const TELEGRAM_API_BASE = "https://api.telegram.org";

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  from?: { id: number };
  message?: { chat: { id: number | string } };
}

export interface TelegramUpdate {
  update_id: number;
  callback_query?: TelegramCallbackQuery;
}

interface TelegramGetUpdatesResponse {
  ok: boolean;
  result?: unknown;
  error_code?: number;
}

function isTelegramGetUpdatesResponse(value: unknown): value is TelegramGetUpdatesResponse {
  return !!value && typeof value === "object" && typeof (value as Record<string, unknown>).ok === "boolean";
}

function isTelegramUpdate(value: unknown): value is TelegramUpdate {
  return !!value && typeof value === "object" && typeof (value as Record<string, unknown>).update_id === "number";
}

export type GetUpdatesResult = { ok: true; updates: TelegramUpdate[] } | { ok: false; error: string };

/**
 * getUpdates 1회 호출. offset=마지막으로 처리한 update_id+1을 넘기면 Telegram 서버가 그
 * 이하 update는 다시 보내지 않는다(공식 replay 방지 메커니즘, § approval-store.ts
 * TelegramOffsetStore) — 이 함수 자체는 어떤 offset도 스스로 계산하지 않고 호출부가 넘긴
 * 값을 그대로 쓴다. requestTimeoutMs는 longPollTimeoutSec보다 충분히 길어야 한다(호출부
 * 책임) — 이 함수는 그 관계를 강제하지 않지만, AbortController로 requestTimeoutMs를 넘기면
 * 무조건 중단한다(무한 대기 금지).
 */
export async function getTelegramUpdates(
  fetchImpl: typeof fetch,
  botToken: string,
  offset: number,
  longPollTimeoutSec: number,
  requestTimeoutMs: number
): Promise<GetUpdatesResult> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const params = new URLSearchParams({
      offset: String(offset),
      timeout: String(longPollTimeoutSec),
      allowed_updates: JSON.stringify(["callback_query"]),
    });
    const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${botToken}/getUpdates?${params.toString()}`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, error: `TELEGRAM_HTTP_ERROR_${response.status}` };

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: "TELEGRAM_INVALID_RESPONSE" };
    }
    if (!isTelegramGetUpdatesResponse(body)) return { ok: false, error: "TELEGRAM_INVALID_RESPONSE" };
    if (!body.ok) return { ok: false, error: `TELEGRAM_API_ERROR_${body.error_code ?? "UNKNOWN"}` };
    const rawResult = Array.isArray(body.result) ? body.result : [];
    const updates = rawResult.filter(isTelegramUpdate);
    return { ok: true, updates };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { ok: false, error: "TELEGRAM_TIMEOUT" };
    return { ok: false, error: "TELEGRAM_NETWORK_ERROR" };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

const DEFAULT_ANSWER_TIMEOUT_MS = 10_000;

/** Telegram callback에 짧은 사용자 안내를 보여준다(§ 요구사항 17) — Telegram API 응답
 *  원문은 절대 반환/기록하지 않는다(sendTelegramMessage와 동일한 원칙). 실패해도 예외를
 *  던지지 않는다 — 이 답장은 UX 보조일 뿐 승인 판정 자체에 영향을 주지 않는다. */
export async function answerTelegramCallbackQuery(
  fetchImpl: typeof fetch,
  botToken: string,
  callbackQueryId: string,
  text: string,
  timeoutMs: number = DEFAULT_ANSWER_TIMEOUT_MS
): Promise<DeliveryResult> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${TELEGRAM_API_BASE}/bot${botToken}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, error: `TELEGRAM_HTTP_ERROR_${response.status}` };
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, error: "TELEGRAM_INVALID_RESPONSE" };
    }
    if (!isTelegramGetUpdatesResponse(body) || !body.ok) return { ok: false, error: "TELEGRAM_API_ERROR" };
    return { ok: true };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { ok: false, error: "TELEGRAM_TIMEOUT" };
    return { ok: false, error: "TELEGRAM_NETWORK_ERROR" };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ---------------------------------------------------------------------------
// 발신자 allowlist — AUTODEV_TELEGRAM_CHAT_ID(G5.1 재사용) + 새 AUTODEV_TELEGRAM_USER_ID
// (선택, 기존 설정을 깨뜨리지 않는다 — 지정하지 않으면 chatId만으로 판정).
// ---------------------------------------------------------------------------

export interface TelegramAllowlistConfig {
  chatId?: string;
  userId?: string;
}

export function resolveTelegramAllowlist(config: TelegramAllowlistConfig = {}): TelegramAllowlistConfig {
  return {
    chatId: config.chatId ?? process.env.AUTODEV_TELEGRAM_CHAT_ID,
    userId: config.userId ?? process.env.AUTODEV_TELEGRAM_USER_ID,
  };
}

export interface SenderVerification {
  ok: boolean;
  reason?: "CHAT_ALLOWLIST_NOT_CONFIGURED" | "CHAT_ID_MISMATCH" | "USER_ID_MISMATCH" | "NOT_CALLBACK_QUERY";
}

/** callback_query.message.chat.id가 설정된 chatId와 정확히 일치해야 한다(§ 요구사항 6).
 *  AUTODEV_TELEGRAM_USER_ID가 설정돼 있으면 callback_query.from.id도 검증한다. chatId
 *  자체가 설정돼 있지 않으면(운영 misconfiguration) fail-closed로 항상 거부한다 — "설정이
 *  없으니 통과"로 fallback하지 않는다. */
export function verifyCallbackSender(callbackQuery: TelegramCallbackQuery, allowlist: TelegramAllowlistConfig): SenderVerification {
  if (!allowlist.chatId || allowlist.chatId.trim().length === 0) {
    return { ok: false, reason: "CHAT_ALLOWLIST_NOT_CONFIGURED" };
  }
  const chatId = callbackQuery.message?.chat?.id;
  if (chatId === undefined || String(chatId) !== allowlist.chatId) {
    return { ok: false, reason: "CHAT_ID_MISMATCH" };
  }
  if (allowlist.userId && allowlist.userId.trim().length > 0) {
    const fromId = callbackQuery.from?.id;
    if (fromId === undefined || String(fromId) !== allowlist.userId) {
      return { ok: false, reason: "USER_ID_MISMATCH" };
    }
  }
  return { ok: true };
}
