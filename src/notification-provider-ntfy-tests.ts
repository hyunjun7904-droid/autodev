import { randomUUID } from "node:crypto";
import { createNtfyNotificationProvider } from "./notification-provider-ntfy";
import { createInMemoryNotificationStore } from "./notification-store";
import { processNotifications, DEFAULT_MAX_DELIVERY_ATTEMPTS } from "./notification-service";
import type { NotificationMessage } from "./notification";
import type { AutoDevEvent, AutoDevEventInput } from "./observability-event";
import { classifyEventCategory } from "./observability-event";

// ntfy Outbound Provider 테스트 — AutoDev / JARVIS 지능형 오류 복구 하드닝 § 12. 실제 ntfy
// 서버 호출은 절대 하지 않는다 — fetch를 전부 fake로 주입한다(notification-provider-
// telegram-tests.ts와 동일한 패턴).

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

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

type FetchOutcome = { kind: "response"; status: number } | { kind: "network-error" } | { kind: "hang" };

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
    return new Response("{}", { status: outcome.status });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function headerOf(call: CapturedCall, name: string): string | undefined {
  const headers = call.init?.headers as Record<string, string> | undefined;
  return headers?.[name];
}

async function scenarioNormalPublishRequest(): Promise<void> {
  const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "response", status: 200 });
  const provider = createNtfyNotificationProvider({ topic: "autodev-test-topic", fetchImpl });
  const result = await provider.send(msg());

  check("정상 요청: 결과 ok=true", result.ok === true);
  check("정상 요청: fetch 정확히 1회 호출", calls.length === 1);
  check("정상 요청: method=POST", calls[0].init?.method === "POST");
  check("정상 요청: URL이 공식 ntfy.sh 기본 base + topic", calls[0].url === "https://ntfy.sh/autodev-test-topic");
  check("정상 요청: Title header에 알림 제목 전달", headerOf(calls[0], "Title") === "[AutoDev] 보안 차단");
  check("정상 요청: body에 shortMessage 그대로 전달", calls[0].init?.body === "Task T1에서 보안 게이트가 checkpoint를 차단했습니다.");
  check("정상 요청: CRITICAL severity → priority=5(urgent)", headerOf(calls[0], "Priority") === "5");
}

async function scenarioCustomBaseUrlForSelfHosted(): Promise<void> {
  const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "response", status: 200 });
  const provider = createNtfyNotificationProvider({ baseUrl: "https://ntfy.example.internal", topic: "t", fetchImpl });
  await provider.send(msg());
  check("self-host base URL: 지정한 서버로 요청됨", calls[0].url === "https://ntfy.example.internal/t");
}

async function scenarioAccessTokenSentAsBearerWhenConfigured(): Promise<void> {
  const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "response", status: 200 });
  const provider = createNtfyNotificationProvider({ topic: "t", accessToken: "tk_secret_123", fetchImpl });
  await provider.send(msg());
  check("accessToken 지정 시: Authorization: Bearer 헤더 전달", headerOf(calls[0], "Authorization") === "Bearer tk_secret_123");
}

async function scenarioNoAccessTokenMeansNoAuthorizationHeader(): Promise<void> {
  const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "response", status: 200 });
  const provider = createNtfyNotificationProvider({ topic: "t", fetchImpl });
  await provider.send(msg());
  check("accessToken 미지정 시: Authorization 헤더 자체가 없음(공개 토픽)", headerOf(calls[0], "Authorization") === undefined);
}

async function scenarioSeverityMappedToNtfyPriority(): Promise<void> {
  const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "response", status: 200 });
  const provider = createNtfyNotificationProvider({ topic: "t", fetchImpl });
  await provider.send(msg({ severity: "INFO" }));
  await provider.send(msg({ severity: "WARNING" }));
  await provider.send(msg({ severity: "ACTION_REQUIRED" }));
  check("INFO → priority=2", headerOf(calls[0], "Priority") === "2");
  check("WARNING → priority=3", headerOf(calls[1], "Priority") === "3");
  check("ACTION_REQUIRED → priority=4", headerOf(calls[2], "Priority") === "4");
}

async function scenarioHttpFailure(): Promise<void> {
  const { fetch: fetchImpl } = createFakeFetch({ kind: "response", status: 500 });
  const provider = createNtfyNotificationProvider({ topic: "t", fetchImpl });
  const result = await provider.send(msg());
  check("HTTP failure(500): ok=false", result.ok === false);
  check("HTTP failure(500): error 코드에 상태코드 포함", result.error === "NTFY_HTTP_ERROR_500");
}

async function scenarioTimeout(): Promise<void> {
  const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "hang" });
  const provider = createNtfyNotificationProvider({ topic: "t", timeoutMs: 30, fetchImpl });
  const start = Date.now();
  const result = await provider.send(msg());
  const elapsed = Date.now() - start;
  check("timeout: ok=false", result.ok === false);
  check("timeout: error=NTFY_TIMEOUT", result.error === "NTFY_TIMEOUT");
  check("timeout: 실제로 timeoutMs 근처에서 중단됨(무한 대기 아님)", elapsed < 5_000);
  check("timeout: fetch는 1회만 호출됨", calls.length === 1);
}

async function scenarioNoTopicConfigured(): Promise<void> {
  const originalTopic = process.env.AUTODEV_NTFY_TOPIC;
  delete process.env.AUTODEV_NTFY_TOPIC;
  try {
    const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "response", status: 200 });
    const provider = createNtfyNotificationProvider({ fetchImpl });
    check("topic 없음: configStatus=NOT_CONFIGURED", provider.configStatus === "NOT_CONFIGURED");
    const result = await provider.send(msg());
    check("topic 없음: send() → ok=false", result.ok === false);
    check("topic 없음: error=NTFY_NOT_CONFIGURED", result.error === "NTFY_NOT_CONFIGURED");
    check("topic 없음: fetch를 전혀 호출하지 않음", calls.length === 0);
  } finally {
    if (originalTopic === undefined) delete process.env.AUTODEV_NTFY_TOPIC;
    else process.env.AUTODEV_NTFY_TOPIC = originalTopic;
  }
}

async function scenarioReadsFromEnvironmentVariables(): Promise<void> {
  const originalTopic = process.env.AUTODEV_NTFY_TOPIC;
  process.env.AUTODEV_NTFY_TOPIC = "env-topic";
  try {
    const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "response", status: 200 });
    const provider = createNtfyNotificationProvider({ fetchImpl });
    check("환경변수 설정: configStatus=CONFIGURED", provider.configStatus === "CONFIGURED");
    const result = await provider.send(msg());
    check("환경변수 설정: send() 성공", result.ok === true);
    check("환경변수 설정: 환경변수 topic으로 전송됨", calls[0].url === "https://ntfy.sh/env-topic");
  } finally {
    if (originalTopic === undefined) delete process.env.AUTODEV_NTFY_TOPIC;
    else process.env.AUTODEV_NTFY_TOPIC = originalTopic;
  }
}

async function scenarioAccessTokenNeverLeaksOnFailure(): Promise<void> {
  const tokenMarker = "SUPER_SECRET_NTFY_TOKEN_MARKER_abcdef123456";

  const httpFail = createFakeFetch({ kind: "response", status: 401 });
  const providerHttp = createNtfyNotificationProvider({ topic: "t", accessToken: tokenMarker, fetchImpl: httpFail.fetch });
  const resultHttp = await providerHttp.send(msg());
  check("token 비노출(HTTP 실패): error에 token marker 없음", !String(resultHttp.error).includes(tokenMarker));

  const networkFail = createFakeFetch({ kind: "network-error" });
  const providerNet = createNtfyNotificationProvider({ topic: "t", accessToken: tokenMarker, fetchImpl: networkFail.fetch });
  const resultNet = await providerNet.send(msg());
  check("token 비노출(네트워크 실패): error에 token marker 없음", !String(resultNet.error).includes(tokenMarker));

  const store = createInMemoryNotificationStore();
  let seq = 0;
  function ev(overrides: Partial<AutoDevEventInput> & { eventType: AutoDevEventInput["eventType"]; runId: string }): AutoDevEvent {
    seq += 1;
    return { ...overrides, eventId: randomUUID(), timestamp: new Date().toISOString(), categories: classifyEventCategory(overrides.eventType), sequence: seq };
  }
  const events = [ev({ eventType: "SECURITY_BLOCKED", runId: "run-ntfy-token-leak", taskId: "T1" })];
  await processNotifications(events, store, providerHttp);
  const serializedStore = JSON.stringify(store.list());
  check("token 비노출(전체 파이프라인): NotificationStore에 token marker 없음", !serializedStore.includes(tokenMarker));
}

async function scenarioNoInternalRetry(): Promise<void> {
  const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "network-error" });
  const provider = createNtfyNotificationProvider({ topic: "t", fetchImpl });
  await provider.send(msg());
  check("provider 내부 retry 없음: fetch 정확히 1회만 호출됨", calls.length === 1);
}

async function scenarioBoundedRetryPreservedThroughG5(): Promise<void> {
  const { fetch: fetchImpl, calls } = createFakeFetch({ kind: "network-error" });
  const provider = createNtfyNotificationProvider({ topic: "t", fetchImpl });
  const store = createInMemoryNotificationStore();

  let seq = 0;
  function ev(overrides: Partial<AutoDevEventInput> & { eventType: AutoDevEventInput["eventType"]; runId: string }): AutoDevEvent {
    seq += 1;
    return { ...overrides, eventId: randomUUID(), timestamp: new Date().toISOString(), categories: classifyEventCategory(overrides.eventType), sequence: seq };
  }
  const events = [ev({ eventType: "SECURITY_BLOCKED", runId: "run-ntfy-retry", taskId: "T1" })];

  await processNotifications(events, store, provider);
  for (let i = 0; i < 5; i++) {
    await processNotifications([], store, provider);
  }
  const record = store.get("run-ntfy-retry::T1::SECURITY_BLOCKED::-");
  check(`G5 bounded retry: ntfy provider로도 상한(${DEFAULT_MAX_DELIVERY_ATTEMPTS})에서 멈춤`, record?.attemptCount === DEFAULT_MAX_DELIVERY_ATTEMPTS);
  check("G5 bounded retry: fetch 호출 수도 상한과 일치(무한 재시도 아님)", calls.length === DEFAULT_MAX_DELIVERY_ATTEMPTS);
  check("G5 bounded retry: 여전히 FAILED(성공 위장 없음)", record?.deliveryStatus === "FAILED");
}

async function scenarioFailureDoesNotThrow(): Promise<void> {
  const { fetch: fetchImpl } = createFakeFetch({ kind: "network-error" });
  const provider = createNtfyNotificationProvider({ topic: "t", fetchImpl });
  let threw = false;
  try {
    await provider.send(msg());
  } catch {
    threw = true;
  }
  check("Core production outcome 불변: 전달 실패해도 예외를 던지지 않음", threw === false);
}

async function main(): Promise<void> {
  await scenarioNormalPublishRequest();
  await scenarioCustomBaseUrlForSelfHosted();
  await scenarioAccessTokenSentAsBearerWhenConfigured();
  await scenarioNoAccessTokenMeansNoAuthorizationHeader();
  await scenarioSeverityMappedToNtfyPriority();
  await scenarioHttpFailure();
  await scenarioTimeout();
  await scenarioNoTopicConfigured();
  await scenarioReadsFromEnvironmentVariables();
  await scenarioAccessTokenNeverLeaksOnFailure();
  await scenarioNoInternalRetry();
  await scenarioBoundedRetryPreservedThroughG5();
  await scenarioFailureDoesNotThrow();

  console.log("\n=== notification-provider-ntfy 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
