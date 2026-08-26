import "dotenv/config";
import type { NotificationMessage, NotificationSeverity } from "./notification";
import type { DeliveryResult, NotificationProvider } from "./notification-provider";

// ntfy(https://ntfy.sh, 공식 오픈소스 self-host 가능 push notification 서비스) Outbound
// Provider — AutoDev / JARVIS 지능형 오류 복구 하드닝 § 12.
//
// Telegram 대신 이 provider가 이제 AutoDev의 상태 알림 기준이다(§ 요구사항: "앞으로
// AutoDev의 상태 알림은 ntfy를 기준으로 한다"). notification-provider-telegram.ts와 동일한
// 구조(NotificationProvider 인터페이스 하나만 구현)를 그대로 따른다 — Core(notification-
// service.ts)는 이 파일을 몰라도 되고, 이 provider도 Telegram/Core 어느 쪽도 알지 못한다.
//
// ntfy는 사람이 응답을 "보내는" 채널이 아니다(§ 요구사항: "ntfy는 알림 수단이며 AutoDev의
// 작업 판단 주체가 아니다") — Telegram의 inline keyboard/getUpdates 콜백 같은 승인 응답
// 채널을 이 파일은 의도적으로 구현하지 않는다(그런 기능 자체가 없다 — 새 기능 추가 금지,
// § 요구사항 19). 사람의 실제 승인/거절 기록은 기존 approval-service.ts/project-state.json
// humanFinalReview 메커니즘이 그대로 담당한다 — 이 provider는 순수 발신 전용이다.
//
// 인증 토큰(있는 경우)은 이 파일 어디에서도 로그/에러에 남기지 않는다 — Authorization
// header 값 자체를 절대 로그로 만들지 않고, 실패 시에도 고정된 error code만 반환한다(§
// notification-provider-telegram.ts와 동일한 "API 응답 원문 미기록" 원칙).

const DEFAULT_NTFY_BASE_URL = "https://ntfy.sh";
const DEFAULT_TIMEOUT_MS = 10_000;

export interface NtfyProviderConfig {
  /** 지정하지 않으면 AUTODEV_NTFY_BASE_URL 환경변수, 그것도 없으면 공식 https://ntfy.sh. */
  baseUrl?: string;
  /** 지정하지 않으면 AUTODEV_NTFY_TOPIC 환경변수를 쓴다. */
  topic?: string;
  /** self-host 인증 서버용 — 지정하지 않으면 AUTODEV_NTFY_TOKEN 환경변수를 쓴다. 없으면
   *  Authorization header 자체를 보내지 않는다(공개 ntfy.sh 토픽은 인증이 필요 없다). */
  accessToken?: string;
  timeoutMs?: number;
  /** 테스트 전용 override — 지정하지 않으면 전역 fetch를 쓴다. */
  fetchImpl?: typeof fetch;
}

export type NtfyConfigStatus = "CONFIGURED" | "NOT_CONFIGURED";

export interface NtfyNotificationProvider extends NotificationProvider {
  /** topic이 있어야 CONFIGURED — baseUrl은 기본값(https://ntfy.sh)이 있어 그 자체로는
   *  NOT_CONFIGURED의 이유가 되지 않는다. */
  readonly configStatus: NtfyConfigStatus;
}

// ntfy 공식 severity 우선순위(1=min ... 5=urgent). notification.ts의
// NOTIFICATION_SEVERITY_PRIORITY(0=CRITICAL이 가장 급함)와 방향이 반대이므로 여기서
// 명시적으로 다시 매핑한다 — 두 표를 서로 계산해서 파생시키지 않고 고정 상수로 둔다(둘 중
// 하나가 바뀌어도 이 매핑이 조용히 깨지지 않도록).
const NTFY_PRIORITY_BY_SEVERITY: Record<NotificationSeverity, number> = {
  CRITICAL: 5,
  ACTION_REQUIRED: 4,
  WARNING: 3,
  INFO: 2,
};

export function resolveNtfyConfig(config: NtfyProviderConfig = {}): {
  baseUrl: string;
  topic?: string;
  accessToken?: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  configStatus: NtfyConfigStatus;
} {
  const baseUrl = config.baseUrl ?? process.env.AUTODEV_NTFY_BASE_URL ?? DEFAULT_NTFY_BASE_URL;
  const topic = config.topic ?? process.env.AUTODEV_NTFY_TOPIC;
  const accessToken = config.accessToken ?? process.env.AUTODEV_NTFY_TOKEN;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = config.fetchImpl ?? fetch;
  const configStatus: NtfyConfigStatus = topic ? "CONFIGURED" : "NOT_CONFIGURED";
  return { baseUrl, topic, accessToken, timeoutMs, fetchImpl, configStatus };
}

function buildNtfyUrl(baseUrl: string, topic: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${normalizedBase}/${encodeURIComponent(topic)}`;
}

/** ntfy publish 호출 하나의 최하위 구현 — 공식 문서 기준 POST body=메시지 본문,
 *  Title/Priority header로 제목/우선순위를 전달한다(JSON publish 형식도 공식 지원하지만,
 *  Telegram provider와 동일하게 최소 표면적만 쓴다). */
export async function sendNtfyMessage(
  fetchImpl: typeof fetch,
  baseUrl: string,
  topic: string,
  accessToken: string | undefined,
  timeoutMs: number,
  title: string,
  message: string,
  priority: number
): Promise<DeliveryResult> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "Content-Type": "text/plain; charset=utf-8",
      Title: title,
      Priority: String(priority),
    };
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    const response = await fetchImpl(buildNtfyUrl(baseUrl, topic), {
      method: "POST",
      headers,
      body: message,
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ok: false, error: `NTFY_HTTP_ERROR_${response.status}` };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "NTFY_TIMEOUT" };
    }
    // fetch 예외 message 원문은 반환하지 않는다(§ 파일 상단 주석 — DNS/TLS/connection 실패
    // 메시지에 어떤 정보가 담길지 이 파일이 통제할 수 없다).
    return { ok: false, error: "NTFY_NETWORK_ERROR" };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * ntfy 기반 NotificationProvider를 만든다. topic이 없으면(환경변수도 없으면) configStatus는
 * NOT_CONFIGURED로 고정되고, send()는 실제 네트워크를 전혀 타지 않고 즉시
 * { ok:false, error:"NTFY_NOT_CONFIGURED" }를 반환한다 — Core run을 깨뜨리지 않고, 가짜
 * 성공으로도 위장하지 않는다(§ notification-provider-telegram.ts와 동일한 원칙).
 *
 * Provider 내부 retry는 없다 — notification-service.ts의 bounded retry 정책
 * (DEFAULT_MAX_DELIVERY_ATTEMPTS)이 이 provider를 감싸는 유일한 재시도 계층이다.
 */
export function createNtfyNotificationProvider(config: NtfyProviderConfig = {}): NtfyNotificationProvider {
  const { baseUrl, topic, accessToken, timeoutMs, fetchImpl, configStatus } = resolveNtfyConfig(config);

  return {
    configStatus,
    send(notification: NotificationMessage): Promise<DeliveryResult> {
      if (configStatus === "NOT_CONFIGURED" || !topic) {
        return Promise.resolve({ ok: false, error: "NTFY_NOT_CONFIGURED" });
      }
      const priority = NTFY_PRIORITY_BY_SEVERITY[notification.severity];
      return sendNtfyMessage(fetchImpl, baseUrl, topic, accessToken, timeoutMs, notification.title, notification.shortMessage, priority);
    },
  };
}
