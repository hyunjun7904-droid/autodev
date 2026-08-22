import { randomUUID } from "node:crypto";
import { createTelegramNotificationProvider } from "./notification-provider-telegram";
import { createInMemoryNotificationStore } from "./notification-store";
import { createInMemoryEventStore } from "./event-store";
import { processNotifications, DEFAULT_MAX_DELIVERY_ATTEMPTS } from "./notification-service";
import type { NotificationMessage } from "./notification";
import type { AutoDevEvent, AutoDevEventInput } from "./observability-event";
import { classifyEventCategory } from "./observability-event";

// Telegram Bot API Outbound Provider 테스트(Phase G Task G5.1). 실제 Telegram 호출은
// 절대 하지 않는다 — fetch를 전부 fake로 주입한다(source-adapter.ts의 HttpFetch 주입
// 패턴과 동일). 실제 Telegram 메시지 전송은 이 파일 어디에도 없다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function msg(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    runId: "r1",
    taskId: "T1",
    notificationType: "SECURITY_BLOCKED",
    severity: "CRITICAL",
    title: "[AutoDev] 보안 차단",
    shortMessage: "Task T1에서 보안 게이트가 checkpoint를 차단했습니다.",
    requiresHumanAction: true,
    dedupeKey: "r1::T1::SECURITY_BLOCKED::-",
    sourceEventType: "SECURITY_BLOCKED",
    sourceEventId: randomUUID(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// fetch fake — 실제 네트워크를 전혀 타지 않는다. source-adapter.ts의 HttpFetch 주입
// 패턴처럼 provider가 받는 fetchImpl 하나만 교체한다(전역 fetch를 monkey-patch하지
// 않는다 — 테스트 간 상태가 새지 않는다).
// ---------------------------------------------------------------------------

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

type FetchOutcome =
  | { kind: "response"; status: number; body: unknown }
  | { kind: "network-error" }
  | { kind: "hang" };

function createFakeFetch(outcome: FetchOutcome): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });

    if (outcome.kind === "network-error") {
      throw new TypeError("fetch failed: simulated network error");
    }
    if (outcome.kind === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      });
    }
    return new Response(JSON.stringify(outcome.body), { status: outcome.status });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function requestBody(call: CapturedCall): { chat_id?: unknown; text?: unknown } {
  return JSON.parse(String(call.init?.body ?? "{}"));
}

// ---------------------------------------------------------------------------
// 1~3) 정상 요청 — POST/sendMessage, 정확한 chatId, title/shortMessage 전달.
// ---------------------------------------------------------------------------
async function scenarioNormalSendMessageRequest(): Promise<void> {
  const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "response", status: 200, body: { ok: true } });
  const provider = createTelegramNotificationProvider({ botToken: "TEST_TOKEN_123", chatId: "999888777", fetchImpl });
  const result = await provider.send(msg());

  check("정상 요청: 결과 ok=true", result.ok === true);
  check("정상 요청: fetch 정확히 1회 호출", calls.length === 1);
  check("정상 요청: method=POST", calls[0].init?.method === "POST");
  check("정상 요청: URL이 공식 sendMessage endpoint", calls[0].url === "https://api.telegram.org/botTEST_TOKEN_123/sendMessage");

  const body = requestBody(calls[0]);
  check("정확한 chatId: body.chat_id가 configured chatId와 일치", body.chat_id === "999888777");
  check("title/message 전달: text에 title 포함", String(body.text).includes("[AutoDev] 보안 차단"));
  check("title/message 전달: text에 shortMessage 포함", String(body.text).includes("Task T1에서 보안 게이트가 checkpoint를 차단했습니다."));
}

// ---------------------------------------------------------------------------
// 4) Telegram ok:true → DELIVERED(provider 레벨에서는 DeliveryResult.ok=true).
// ---------------------------------------------------------------------------
async function scenarioTelegramOkTrueDelivered(): Promise<void> {
  const { fetch: fetchImpl } = createFakeFetch({ kind: "response", status: 200, body: { ok: true } });
  const provider = createTelegramNotificationProvider({ botToken: "tok", chatId: "chat", fetchImpl });
  const result = await provider.send(msg());
  check("Telegram ok:true → DeliveryResult.ok=true", result.ok === true);
  check("Telegram ok:true → error 없음", result.error === undefined);
}

// ---------------------------------------------------------------------------
// 5) HTTP failure → FAILED.
// ---------------------------------------------------------------------------
async function scenarioHttpFailure(): Promise<void> {
  const { fetch: fetchImpl } = createFakeFetch({ kind: "response", status: 500, body: { ok: false } });
  const provider = createTelegramNotificationProvider({ botToken: "tok", chatId: "chat", fetchImpl });
  const result = await provider.send(msg());
  check("HTTP failure(500): ok=false", result.ok === false);
  check("HTTP failure(500): error 코드에 상태코드 포함", result.error === "TELEGRAM_HTTP_ERROR_500");
}

// ---------------------------------------------------------------------------
// 6) Telegram ok:false(HTTP 200이지만 API 레벨 실패) → FAILED.
// ---------------------------------------------------------------------------
async function scenarioTelegramApiOkFalse(): Promise<void> {
  const { fetch: fetchImpl } = createFakeFetch({ kind: "response", status: 200, body: { ok: false, error_code: 400, description: "Bad Request: chat not found" } });
  const provider = createTelegramNotificationProvider({ botToken: "tok", chatId: "chat", fetchImpl });
  const result = await provider.send(msg());
  check("Telegram ok:false(HTTP 200): ok=false(HTTP 200만으로 성공 처리 안 함)", result.ok === false);
  check("Telegram ok:false: error_code 반영", result.error === "TELEGRAM_API_ERROR_400");
  check("Telegram ok:false: description 원문이 error에 없음(원문 미기록)", !String(result.error).includes("Bad Request"));
}

// ---------------------------------------------------------------------------
// 7) timeout → FAILED, 무한 대기 없음.
// ---------------------------------------------------------------------------
async function scenarioTimeout(): Promise<void> {
  const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "hang" });
  const provider = createTelegramNotificationProvider({ botToken: "tok", chatId: "chat", timeoutMs: 30, fetchImpl });
  const start = Date.now();
  const result = await provider.send(msg());
  const elapsed = Date.now() - start;
  check("timeout: ok=false", result.ok === false);
  check("timeout: error=TELEGRAM_TIMEOUT", result.error === "TELEGRAM_TIMEOUT");
  check("timeout: 실제로 timeoutMs 근처에서 중단됨(무한 대기 아님)", elapsed < 5_000);
  check("timeout: fetch는 1회만 호출됨", calls.length === 1);
}

// ---------------------------------------------------------------------------
// 8~9) 설정 없음 → NOT_CONFIGURED, 네트워크 호출 자체를 시도하지 않음.
// ---------------------------------------------------------------------------
async function scenarioNoBotTokenConfigured(): Promise<void> {
  const originalToken = process.env.AUTODEV_TELEGRAM_BOT_TOKEN;
  delete process.env.AUTODEV_TELEGRAM_BOT_TOKEN;
  try {
    const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "response", status: 200, body: { ok: true } });
    const provider = createTelegramNotificationProvider({ chatId: "chat", fetchImpl });
    check("token 없음: configStatus=NOT_CONFIGURED", provider.configStatus === "NOT_CONFIGURED");
    const result = await provider.send(msg());
    check("token 없음: send() → ok=false", result.ok === false);
    check("token 없음: error=TELEGRAM_NOT_CONFIGURED", result.error === "TELEGRAM_NOT_CONFIGURED");
    check("token 없음: fetch를 전혀 호출하지 않음", calls.length === 0);
  } finally {
    if (originalToken === undefined) delete process.env.AUTODEV_TELEGRAM_BOT_TOKEN;
    else process.env.AUTODEV_TELEGRAM_BOT_TOKEN = originalToken;
  }
}

async function scenarioNoChatIdConfigured(): Promise<void> {
  const originalChatId = process.env.AUTODEV_TELEGRAM_CHAT_ID;
  delete process.env.AUTODEV_TELEGRAM_CHAT_ID;
  try {
    const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "response", status: 200, body: { ok: true } });
    const provider = createTelegramNotificationProvider({ botToken: "tok", fetchImpl });
    check("chatId 없음: configStatus=NOT_CONFIGURED", provider.configStatus === "NOT_CONFIGURED");
    const result = await provider.send(msg());
    check("chatId 없음: send() → ok=false", result.ok === false);
    check("chatId 없음: error=TELEGRAM_NOT_CONFIGURED", result.error === "TELEGRAM_NOT_CONFIGURED");
    check("chatId 없음: fetch를 전혀 호출하지 않음", calls.length === 0);
  } finally {
    if (originalChatId === undefined) delete process.env.AUTODEV_TELEGRAM_CHAT_ID;
    else process.env.AUTODEV_TELEGRAM_CHAT_ID = originalChatId;
  }
}

// ---------------------------------------------------------------------------
// 환경변수 기반 설정 — config를 생략해도 AUTODEV_TELEGRAM_BOT_TOKEN/AUTODEV_TELEGRAM_CHAT_ID
// 환경변수로 CONFIGURED가 된다(§ 설정 방식).
// ---------------------------------------------------------------------------
async function scenarioReadsFromEnvironmentVariables(): Promise<void> {
  const originalToken = process.env.AUTODEV_TELEGRAM_BOT_TOKEN;
  const originalChatId = process.env.AUTODEV_TELEGRAM_CHAT_ID;
  process.env.AUTODEV_TELEGRAM_BOT_TOKEN = "env-token";
  process.env.AUTODEV_TELEGRAM_CHAT_ID = "env-chat";
  try {
    const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "response", status: 200, body: { ok: true } });
    const provider = createTelegramNotificationProvider({ fetchImpl });
    check("환경변수 설정: configStatus=CONFIGURED", provider.configStatus === "CONFIGURED");
    const result = await provider.send(msg());
    check("환경변수 설정: send() 성공", result.ok === true);
    check("환경변수 설정: 환경변수 chatId로 전송됨", requestBody(calls[0]).chat_id === "env-chat");
  } finally {
    if (originalToken === undefined) delete process.env.AUTODEV_TELEGRAM_BOT_TOKEN;
    else process.env.AUTODEV_TELEGRAM_BOT_TOKEN = originalToken;
    if (originalChatId === undefined) delete process.env.AUTODEV_TELEGRAM_CHAT_ID;
    else process.env.AUTODEV_TELEGRAM_CHAT_ID = originalChatId;
  }
}

// ---------------------------------------------------------------------------
// 10) token이 log/error/store에 노출되지 않음 — 실패 경로 전부에서 확인.
// ---------------------------------------------------------------------------
async function scenarioTokenNeverLeaksOnFailure(): Promise<void> {
  const tokenMarker = "SUPER_SECRET_BOT_TOKEN_MARKER_abcdef123456";

  const httpFail = createFakeFetch({ kind: "response", status: 401, body: { ok: false, error_code: 401 } });
  const providerHttp = createTelegramNotificationProvider({ botToken: tokenMarker, chatId: "chat", fetchImpl: httpFail.fetch });
  const resultHttp = await providerHttp.send(msg());
  check("token 비노출(HTTP 실패): error에 token marker 없음", !String(resultHttp.error).includes(tokenMarker));

  const networkFail = createFakeFetch({ kind: "network-error" });
  const providerNet = createTelegramNotificationProvider({ botToken: tokenMarker, chatId: "chat", fetchImpl: networkFail.fetch });
  const resultNet = await providerNet.send(msg());
  check("token 비노출(네트워크 실패): error에 token marker 없음", !String(resultNet.error).includes(tokenMarker));

  const timeoutFail = createFakeFetch({ kind: "hang" });
  const providerTimeout = createTelegramNotificationProvider({ botToken: tokenMarker, chatId: "chat", timeoutMs: 20, fetchImpl: timeoutFail.fetch });
  const resultTimeout = await providerTimeout.send(msg());
  check("token 비노출(timeout): error에 token marker 없음", !String(resultTimeout.error).includes(tokenMarker));

  // 파이프라인 전체(EventStore/NotificationStore)를 통과해도 token이 새지 않는다.
  let seq = 0;
  function ev(overrides: Partial<AutoDevEventInput> & { eventType: AutoDevEventInput["eventType"]; runId: string }): AutoDevEvent {
    seq += 1;
    return { ...overrides, eventId: randomUUID(), timestamp: new Date().toISOString(), categories: classifyEventCategory(overrides.eventType), sequence: seq };
  }
  const eventStore = createInMemoryEventStore();
  const store = createInMemoryNotificationStore();
  const events = [ev({ eventType: "SECURITY_BLOCKED", runId: "run-token-leak", taskId: "T1" })];
  await processNotifications(events, store, providerHttp, { eventStore });
  const serializedAudit = JSON.stringify(eventStore.query().events);
  const serializedStore = JSON.stringify(store.list());
  check("token 비노출(전체 파이프라인): EventStore에 token marker 없음", !serializedAudit.includes(tokenMarker));
  check("token 비노출(전체 파이프라인): NotificationStore에 token marker 없음", !serializedStore.includes(tokenMarker));
}

// ---------------------------------------------------------------------------
// 11) chat allowlist — notification payload에 chatId를 끼워 넣어도 무시된다.
// ---------------------------------------------------------------------------
async function scenarioChatAllowlistCannotBeOverridden(): Promise<void> {
  const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "response", status: 200, body: { ok: true } });
  const provider = createTelegramNotificationProvider({ botToken: "tok", chatId: "configured-chat-id", fetchImpl });

  const maliciousPayload = { ...msg(), chatId: "malicious-attacker-chat-id" } as NotificationMessage & { chatId: string };
  await provider.send(maliciousPayload);

  const body = requestBody(calls[0]);
  check("chat allowlist: 실제 전송 대상은 항상 configured chatId", body.chat_id === "configured-chat-id");
  check("chat allowlist: payload에 끼워 넣은 chatId는 무시됨", body.chat_id !== "malicious-attacker-chat-id");
}

// ---------------------------------------------------------------------------
// 12) provider 내부 retry 없음 — send() 1회 호출은 fetch 1회만 시도한다.
// ---------------------------------------------------------------------------
async function scenarioNoInternalRetry(): Promise<void> {
  const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "network-error" });
  const provider = createTelegramNotificationProvider({ botToken: "tok", chatId: "chat", fetchImpl });
  await provider.send(msg());
  check("provider 내부 retry 없음: fetch 정확히 1회만 호출됨", calls.length === 1);
}

// ---------------------------------------------------------------------------
// 13~14) G5 bounded retry 정책과의 통합 — Telegram provider를 processNotifications에
//        꽂아도 상한을 넘지 않고, 이미 전달된 알림은 재전송하지 않는다.
// ---------------------------------------------------------------------------
async function scenarioBoundedRetryPreservedThroughG5(): Promise<void> {
  const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "network-error" });
  const provider = createTelegramNotificationProvider({ botToken: "tok", chatId: "chat", fetchImpl });
  const store = createInMemoryNotificationStore();

  let seq = 0;
  function ev(overrides: Partial<AutoDevEventInput> & { eventType: AutoDevEventInput["eventType"]; runId: string }): AutoDevEvent {
    seq += 1;
    return { ...overrides, eventId: randomUUID(), timestamp: new Date().toISOString(), categories: classifyEventCategory(overrides.eventType), sequence: seq };
  }
  const events = [ev({ eventType: "SECURITY_BLOCKED", runId: "run-telegram-retry", taskId: "T1" })];

  await processNotifications(events, store, provider);
  for (let i = 0; i < 5; i++) {
    await processNotifications([], store, provider);
  }
  const record = store.get("run-telegram-retry::T1::SECURITY_BLOCKED::-");
  check(`G5 bounded retry: Telegram provider로도 상한(${DEFAULT_MAX_DELIVERY_ATTEMPTS})에서 멈춤`, record?.attemptCount === DEFAULT_MAX_DELIVERY_ATTEMPTS);
  check("G5 bounded retry: fetch 호출 수도 상한과 일치(무한 재시도 아님)", calls.length === DEFAULT_MAX_DELIVERY_ATTEMPTS);
  check("G5 bounded retry: 여전히 FAILED(성공 위장 없음)", record?.deliveryStatus === "FAILED");
}

async function scenarioDuplicateNotResentAfterSuccess(): Promise<void> {
  const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "response", status: 200, body: { ok: true } });
  const provider = createTelegramNotificationProvider({ botToken: "tok", chatId: "chat", fetchImpl });
  const store = createInMemoryNotificationStore();

  let seq = 0;
  function ev(overrides: Partial<AutoDevEventInput> & { eventType: AutoDevEventInput["eventType"]; runId: string }): AutoDevEvent {
    seq += 1;
    return { ...overrides, eventId: randomUUID(), timestamp: new Date().toISOString(), categories: classifyEventCategory(overrides.eventType), sequence: seq };
  }
  const events = [ev({ eventType: "TASK_COMPLETED", runId: "run-telegram-dup", taskId: "T1" })];

  const first = await processNotifications(events, store, provider);
  const second = await processNotifications(events, store, provider);

  check("duplicate 재전송 없음: 최초 호출 delivered=1", first.delivered.length === 1);
  check("duplicate 재전송 없음: 재호출 delivered=0", second.delivered.length === 0);
  check("duplicate 재전송 없음: 실제 fetch 호출은 1회만", calls.length === 1);
}

// ---------------------------------------------------------------------------
// 15) Core production outcome 변경 없음 — 실패해도 예외를 던지지 않는다.
// ---------------------------------------------------------------------------
async function scenarioFailureDoesNotThrow(): Promise<void> {
  const { fetch: fetchImpl } = createFakeFetch({ kind: "network-error" });
  const provider = createTelegramNotificationProvider({ botToken: "tok", chatId: "chat", fetchImpl });
  let threw = false;
  try {
    await provider.send(msg());
  } catch {
    threw = true;
  }
  check("Core production outcome 불변: 전달 실패해도 예외를 던지지 않음", threw === false);
}

async function main(): Promise<void> {
  await scenarioNormalSendMessageRequest();
  await scenarioTelegramOkTrueDelivered();
  await scenarioHttpFailure();
  await scenarioTelegramApiOkFalse();
  await scenarioTimeout();
  await scenarioNoBotTokenConfigured();
  await scenarioNoChatIdConfigured();
  await scenarioReadsFromEnvironmentVariables();
  await scenarioTokenNeverLeaksOnFailure();
  await scenarioChatAllowlistCannotBeOverridden();
  await scenarioNoInternalRetry();
  await scenarioBoundedRetryPreservedThroughG5();
  await scenarioDuplicateNotResentAfterSuccess();
  await scenarioFailureDoesNotThrow();

  console.log("\n=== notification-provider-telegram(G5.1) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
