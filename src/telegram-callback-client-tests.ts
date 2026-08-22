import { getTelegramUpdates, answerTelegramCallbackQuery, verifyCallbackSender, resolveTelegramAllowlist } from "./telegram-callback-client";
import type { TelegramCallbackQuery } from "./telegram-callback-client";

// Telegram Inbound(getUpdates long polling & callback 발신자 검증) 테스트 — Phase G Task
// G6. 실제 api.telegram.org 호출은 절대 하지 않는다 — fetch는 항상 fake로 주입한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

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
    if (outcome.kind === "network-error") throw new TypeError("fetch failed: simulated network error");
    if (outcome.kind === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
      });
    }
    return new Response(JSON.stringify(outcome.body), { status: outcome.status });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// getTelegramUpdates
// ---------------------------------------------------------------------------
async function scenarioGetUpdatesSuccess(): Promise<void> {
  const { fetch: fetchImpl, calls } = createFakeFetch({
    kind: "response",
    status: 200,
    body: { ok: true, result: [{ update_id: 101, callback_query: { id: "cbq1", data: "ap:x:A" } }] },
  });
  const result = await getTelegramUpdates(fetchImpl, "tok", 100, 25, 30_000);
  check("getUpdates 정상 응답 -> ok:true + updates 파싱", result.ok === true && result.ok && result.updates.length === 1 && result.updates[0].update_id === 101);
  check("getUpdates 요청 URL에 botToken이 경로에 포함(공식 Bot API 형식)", calls[0].url.includes("/bottok/getUpdates"));
  check("getUpdates 요청은 GET", calls[0].init?.method === "GET");
  check("getUpdates offset이 쿼리스트링에 그대로 전달됨", calls[0].url.includes("offset=100"));
  check("allowed_updates는 callback_query로 한정", decodeURIComponent(calls[0].url).includes(`allowed_updates=["callback_query"]`));
}
async function scenarioGetUpdatesEmpty(): Promise<void> {
  const { fetch: fetchImpl } = createFakeFetch({ kind: "response", status: 200, body: { ok: true, result: [] } });
  const result = await getTelegramUpdates(fetchImpl, "tok", 0, 25, 30_000);
  check("update가 없으면 빈 배열(에러 아님)", result.ok === true && result.ok && result.updates.length === 0);
}
async function scenarioGetUpdatesMalformedItemsFiltered(): Promise<void> {
  const { fetch: fetchImpl } = createFakeFetch({
    kind: "response",
    status: 200,
    body: { ok: true, result: [{ update_id: 1 }, { no_update_id: true }, "not-an-object", null, { update_id: "not-a-number" }] },
  });
  const result = await getTelegramUpdates(fetchImpl, "tok", 0, 25, 30_000);
  check("update_id가 없거나 타입이 틀린 항목은 조용히 필터링됨(정상으로 위장 안 함)", result.ok === true && result.ok && result.updates.length === 1 && result.updates[0].update_id === 1);
}
async function scenarioGetUpdatesHttpError(): Promise<void> {
  const { fetch: fetchImpl } = createFakeFetch({ kind: "response", status: 500, body: {} });
  const result = await getTelegramUpdates(fetchImpl, "tok", 0, 25, 30_000);
  check("HTTP 에러 -> ok:false + 고정 코드(응답 본문 원문 아님)", result.ok === false && !result.ok && result.error === "TELEGRAM_HTTP_ERROR_500");
}
async function scenarioGetUpdatesApiErrorFalse(): Promise<void> {
  const { fetch: fetchImpl } = createFakeFetch({ kind: "response", status: 200, body: { ok: false, error_code: 401 } });
  const result = await getTelegramUpdates(fetchImpl, "tok", 0, 25, 30_000);
  check("Telegram ok:false 응답 -> ok:false + 고정 코드", result.ok === false && !result.ok && result.error === "TELEGRAM_API_ERROR_401");
}
async function scenarioGetUpdatesInvalidJson(): Promise<void> {
  const fetchImpl = (async () => new Response("not json", { status: 200 })) as typeof fetch;
  const result = await getTelegramUpdates(fetchImpl, "tok", 0, 25, 30_000);
  check("JSON 파싱 실패 -> TELEGRAM_INVALID_RESPONSE", result.ok === false && !result.ok && result.error === "TELEGRAM_INVALID_RESPONSE");
}
async function scenarioGetUpdatesNetworkError(): Promise<void> {
  const { fetch: fetchImpl } = createFakeFetch({ kind: "network-error" });
  const result = await getTelegramUpdates(fetchImpl, "tok", 0, 25, 30_000);
  check("네트워크 오류 -> TELEGRAM_NETWORK_ERROR(예외 던지지 않음)", result.ok === false && !result.ok && result.error === "TELEGRAM_NETWORK_ERROR");
}
async function scenarioGetUpdatesTimeoutBounded(): Promise<void> {
  const { fetch: fetchImpl } = createFakeFetch({ kind: "hang" });
  const started = Date.now();
  const result = await getTelegramUpdates(fetchImpl, "tok", 0, 25, 200);
  const elapsedMs = Date.now() - started;
  check("무한 대기 없이 requestTimeoutMs로 중단됨", result.ok === false && !result.ok && result.error === "TELEGRAM_TIMEOUT");
  check("실제 대기 시간이 timeout 근처에서 끝남(무한 대기 아님)", elapsedMs < 5_000);
}
async function scenarioGetUpdatesTokenNotInReturnedValue(): Promise<void> {
  const { fetch: fetchImpl } = createFakeFetch({ kind: "response", status: 500, body: {} });
  const result = await getTelegramUpdates(fetchImpl, "super-secret-token", 0, 25, 30_000);
  check("실패 결과 어디에도 Bot Token 원문이 남지 않음", JSON.stringify(result).includes("super-secret-token") === false);
}

// ---------------------------------------------------------------------------
// answerTelegramCallbackQuery
// ---------------------------------------------------------------------------
async function scenarioAnswerSuccess(): Promise<void> {
  const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "response", status: 200, body: { ok: true } });
  const result = await answerTelegramCallbackQuery(fetchImpl, "tok", "cbq1", "승인 접수됨.");
  check("answerCallbackQuery 정상 응답 -> ok:true", result.ok === true);
  check("answerCallbackQuery는 POST + JSON body", calls[0].init?.method === "POST");
  const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
  check("callback_query_id/text가 그대로 전달됨", body.callback_query_id === "cbq1" && body.text === "승인 접수됨.");
}
async function scenarioAnswerFailureDoesNotThrow(): Promise<void> {
  const { fetch: fetchImpl } = createFakeFetch({ kind: "network-error" });
  let threw = false;
  let result;
  try {
    result = await answerTelegramCallbackQuery(fetchImpl, "tok", "cbq1", "text");
  } catch {
    threw = true;
  }
  check("answerCallbackQuery 실패해도 예외를 던지지 않음", threw === false);
  check("실패 결과는 ok:false로 정직하게 반환", result?.ok === false);
}
async function scenarioAnswerTimeoutBounded(): Promise<void> {
  const { fetch: fetchImpl } = createFakeFetch({ kind: "hang" });
  const result = await answerTelegramCallbackQuery(fetchImpl, "tok", "cbq1", "text", 150);
  check("answerCallbackQuery도 무한 대기하지 않음", result.ok === false && result.error === "TELEGRAM_TIMEOUT");
}

// ---------------------------------------------------------------------------
// verifyCallbackSender — chat/user allowlist
// ---------------------------------------------------------------------------
function cq(overrides: Partial<TelegramCallbackQuery> = {}): TelegramCallbackQuery {
  return { id: "cbq1", data: "ap:x:A", from: { id: 555 }, message: { chat: { id: 777 } }, ...overrides };
}

function scenarioAllowlistNotConfiguredFailsClosed(): void {
  const v = verifyCallbackSender(cq(), { chatId: undefined });
  check("chatId allowlist 미설정 -> fail-closed(UNAUTHORIZED)로 항상 거부", v.ok === false && v.reason === "CHAT_ALLOWLIST_NOT_CONFIGURED");
}
function scenarioAllowlistEmptyStringFailsClosed(): void {
  const v = verifyCallbackSender(cq(), { chatId: "   " });
  check("chatId가 빈 문자열/공백뿐이면 fail-closed", v.ok === false && v.reason === "CHAT_ALLOWLIST_NOT_CONFIGURED");
}
function scenarioAllowlistChatIdMatch(): void {
  const v = verifyCallbackSender(cq({ message: { chat: { id: 777 } } }), { chatId: "777" });
  check("chatId 일치 -> 허용", v.ok === true);
}
function scenarioAllowlistChatIdMismatch(): void {
  const v = verifyCallbackSender(cq({ message: { chat: { id: 999 } } }), { chatId: "777" });
  check("chatId 불일치 -> 거부", v.ok === false && v.reason === "CHAT_ID_MISMATCH");
}
function scenarioAllowlistChatIdMissingOnQuery(): void {
  const v = verifyCallbackSender(cq({ message: undefined }), { chatId: "777" });
  check("callback_query에 message.chat.id가 없으면 거부(위조 방어)", v.ok === false && v.reason === "CHAT_ID_MISMATCH");
}
function scenarioAllowlistUserIdOptionalNotConfigured(): void {
  const v = verifyCallbackSender(cq({ from: { id: 1 } }), { chatId: "777" });
  check("userId allowlist 미지정이면 chatId만으로 판정(기존 설정 안 깨짐)", v.ok === true);
}
function scenarioAllowlistUserIdMatch(): void {
  const v = verifyCallbackSender(cq({ from: { id: 555 } }), { chatId: "777", userId: "555" });
  check("userId까지 지정하면 from.id도 일치해야 허용", v.ok === true);
}
function scenarioAllowlistUserIdMismatch(): void {
  const v = verifyCallbackSender(cq({ from: { id: 1 } }), { chatId: "777", userId: "555" });
  check("userId 지정 + from.id 불일치 -> 거부", v.ok === false && v.reason === "USER_ID_MISMATCH");
}
function scenarioAllowlistUserIdMissingOnQuery(): void {
  const v = verifyCallbackSender(cq({ from: undefined }), { chatId: "777", userId: "555" });
  check("userId allowlist 지정 + callback_query.from 자체가 없으면 거부", v.ok === false && v.reason === "USER_ID_MISMATCH");
}
function scenarioResolveTelegramAllowlistReadsEnv(): void {
  const prevChat = process.env.AUTODEV_TELEGRAM_CHAT_ID;
  const prevUser = process.env.AUTODEV_TELEGRAM_USER_ID;
  process.env.AUTODEV_TELEGRAM_CHAT_ID = "env-chat";
  process.env.AUTODEV_TELEGRAM_USER_ID = "env-user";
  const resolved = resolveTelegramAllowlist();
  check("resolveTelegramAllowlist()는 환경변수를 기본값으로 읽음", resolved.chatId === "env-chat" && resolved.userId === "env-user");
  const overridden = resolveTelegramAllowlist({ chatId: "explicit" });
  check("명시적 config가 있으면 env보다 우선", overridden.chatId === "explicit");
  if (prevChat === undefined) delete process.env.AUTODEV_TELEGRAM_CHAT_ID;
  else process.env.AUTODEV_TELEGRAM_CHAT_ID = prevChat;
  if (prevUser === undefined) delete process.env.AUTODEV_TELEGRAM_USER_ID;
  else process.env.AUTODEV_TELEGRAM_USER_ID = prevUser;
}

async function main(): Promise<void> {
  await scenarioGetUpdatesSuccess();
  await scenarioGetUpdatesEmpty();
  await scenarioGetUpdatesMalformedItemsFiltered();
  await scenarioGetUpdatesHttpError();
  await scenarioGetUpdatesApiErrorFalse();
  await scenarioGetUpdatesInvalidJson();
  await scenarioGetUpdatesNetworkError();
  await scenarioGetUpdatesTimeoutBounded();
  await scenarioGetUpdatesTokenNotInReturnedValue();
  await scenarioAnswerSuccess();
  await scenarioAnswerFailureDoesNotThrow();
  await scenarioAnswerTimeoutBounded();
  scenarioAllowlistNotConfiguredFailsClosed();
  scenarioAllowlistEmptyStringFailsClosed();
  scenarioAllowlistChatIdMatch();
  scenarioAllowlistChatIdMismatch();
  scenarioAllowlistChatIdMissingOnQuery();
  scenarioAllowlistUserIdOptionalNotConfigured();
  scenarioAllowlistUserIdMatch();
  scenarioAllowlistUserIdMismatch();
  scenarioAllowlistUserIdMissingOnQuery();
  scenarioResolveTelegramAllowlistReadsEnv();

  console.log("\n=== telegram-callback-client.ts(G6) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
