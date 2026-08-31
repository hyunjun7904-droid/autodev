import "dotenv/config";
import { selectDefaultEventStore } from "./event-store";
import type { EventStore } from "./event-store";
import type { AutoDevEvent } from "./observability-event";
import { selectDefaultNotificationStore } from "./notification-store";
import type { NotificationStore } from "./notification-store";
import { selectDefaultApprovalStore, selectDefaultTelegramOffsetStore } from "./approval-store";
import type { ApprovalStore, TelegramOffsetStore } from "./approval-store";
import { validateProjectManifest } from "./project-manifest";
import type { ProjectManifest } from "./project-manifest";
import { loadProjectAdapter } from "./project-adapter-loader";
import { getTelegramUpdates, resolveTelegramAllowlist } from "./telegram-callback-client";
import type { TelegramAllowlistConfig } from "./telegram-callback-client";
import { createApprovalRequestsFromEvents, handleTelegramCallbackUpdate } from "./approval-service";
import type { GitExpectationForEvent } from "./approval-service";
import { getCurrentBranch, getCurrentHeadHash } from "./git-changes";
import { classifyEventForNotification } from "./notification";
import { processNotifications } from "./notification-service";
import { createTelegramApprovalAwareProvider } from "./telegram-approval-provider";
import type { NotificationProvider } from "./notification-provider";
import { isProductionRuntime } from "./runtime-origin";

// AutoDev production notification policy(2026-08-27) — Telegram은 더 이상 일반 알림
// 채널이 아니다. ntfy는 production에서 쓰지 않는다(provider 파일 자체(notification-
// provider-ntfy.ts)는 그대로 두되, 이 controller가 더 이상 그 provider를 생성/호출하지
// 않는다 — § 요구사항). Telegram은 오직 "실제 사용자 APPROVE/REJECT 입력이 필요한 상태"
// 에만 쓴다 — 아래 isTelegramAlertWorthyEvent()가 그 판정이다. approval-service.ts의
// ApprovalRequest 생성/remotelyApprovable/CAS/expiry/replay 판정은 전혀 건드리지 않는다
// (이 함수는 "이미 만들어진 알림을 Telegram으로 push할지"만 결정하는 routing/filter
// 계층이다 — 새 판정 엔진이 아니라 notification.ts/observability-event.ts가 이미 아는
// 사실만 재사용한다).
function isTelegramAlertWorthyEvent(event: AutoDevEvent): boolean {
  const notification = classifyEventForNotification(event);
  if (!notification || !notification.requiresHumanAction) return false;
  // TASK_COMPLETED/FINAL_COMPLETED/SELF_DEV_TASK_FAILED는 이미 requiresHumanAction=false라
  // 위에서 걸러진다(§ notification.ts) — task 진행/완료/self-dev 완료는 여기 도달하지 않는다.
  // RUN_BLOCKED/SELF_DEV_WAITING_HUMAN/DEPLOYMENT_WAITING_HUMAN은 approval-service.ts가
  // 이미 "실제 resumable action이 없다"고 판단해 ApprovalRequest 자체를 만들지 않는 것과
  // 동일한 세 타입이다 — Telegram push 판단도 그 사실과 일치시킨다(새 판정이 아니라 기존
  // 판단의 재확인).
  if (
    notification.notificationType === "RUN_BLOCKED" ||
    notification.notificationType === "SELF_DEV_WAITING_HUMAN" ||
    notification.notificationType === "DEPLOYMENT_WAITING_HUMAN"
  ) {
    return false;
  }
  // NO_PROGRESS_STAGNATION(§ claude-developer.ts) — 같은 접근을 반복하다 무진척으로
  // 조기 종료된 것이라, "다시 한번 자동 재시도"가 실제로 도움이 될 가능성이 낮다(TIMEOUT/
  // PROTOCOL_ERROR 소진 등 다른 원인과 다르다 — 그 원인들은 재시도가 실제로 의미 있어
  // 그대로 알린다). classifyApprovalType()/remotelyApprovable 판정 자체는 바꾸지 않는다 —
  // ApprovalRequest는 그대로 생성되고 승인 보안 계약도 그대로다, 이 필터는 오직 "Telegram
  // push 여부"만 좁힌다(§ autodev.ts가 실어보내는 metadata.claudeErrorCode).
  if (event.eventType === "HUMAN_APPROVAL_REQUIRED" && event.metadata?.claudeErrorCode === "NO_PROGRESS_STAGNATION") {
    return false;
  }
  return true;
}

// Local Telegram Controller — Phase G Task G6.
//
// public webhook/public server를 두지 않는다(§ telegram-callback-client.ts) — 이 파일은
// 사람의 PC에서 직접 실행되는 단일 local process로서, getUpdates long polling과 알림 자동
// 전달을 하나의 순환(tick)으로 반복한다. approval 생성/전달/재시도/승인 판정 자체는 이미
// 존재하는 조각들을 정해진 순서로 호출할 뿐이다 — 이 파일이 직접 추가하는 유일한 판정은
// "이미 만들어진 알림 중 어떤 것을 실제로 Telegram push로 보낼지"(§ isTelegramAlertWorthyEvent,
// production notification policy) 하나뿐이다:
//
//   매 tick마다:
//     1) EventStore의 전체 event를 다시 읽어 approval-service.ts의
//        createApprovalRequestsFromEvents()로 새 ApprovalRequest를 만든다(dedupeKey 기준
//        idempotent — 매 tick 전체를 다시 훑어도 안전하다, § approval-store.ts). 이 목록은
//        isTelegramAlertWorthyEvent()로 걸러지지 않은 전체 events를 그대로 쓴다 — "무엇을
//        push하는가"와 "무엇이 승인 대상인가"는 서로 다른 질문이다.
//     2) events를 isTelegramAlertWorthyEvent()로 좁힌 뒤에만 notification-service.ts의
//        processNotifications()로 Telegram에 전달한다(§ G5 dedupe/재시도/우선순위 배선을
//        그대로 재사용 — provider는 telegram-approval-provider.ts의 approval-aware
//        provider 하나뿐이다, ntfy는 production에서 쓰지 않는다).
//     3) Telegram Bot Token이 설정돼 있을 때만 getUpdates를 1회 호출하고, 반환된 각
//        update를 approval-service.ts의 handleTelegramCallbackUpdate()에 그대로 넘긴다 —
//        처리한 update_id는 즉시 offset store에 반영한다(중간에 process가 죽어도 이미
//        끝까지 처리된 update만큼은 다시 배달되지 않는다, 그 이후 것만 재배달됨 — Telegram
//        공식 replay 방지 semantics 그대로).
//
// Bot Token이 설정돼 있지 않으면 이 tick은 1)/2)의 store bookkeeping(승인 생성/알림 dedupe
// 기록)은 그대로 수행하되, 실제 네트워크 호출(전달 시도/getUpdates)은 전혀 시도하지 않는다
// (§ notification-service.ts provider undefined 분기와 동일한 "설정 없으면 조용히 성공/실패로
// 위장하지 않고 시도 자체를 안 한다" 관례) — misconfiguration이 controller 시작 자체를 막지
// 않는다.
//
// tick 안에서 발생한 예외는 이 파일이 잡아 다음 tick으로 넘긴다 — controller 프로세스 자체가
// 죽지 않는다(무한 재시도 상한은 notification-service.ts의 maxAttempts가 이미 담당하므로
// 여기서 새로 만들지 않는다).

const DEFAULT_LONG_POLL_TIMEOUT_SEC = 25;
const DEFAULT_REQUEST_TIMEOUT_BUFFER_MS = 5_000;
const DEFAULT_TICK_DELAY_MS = 250;
const DEFAULT_NOT_CONFIGURED_RETRY_DELAY_MS = 5_000;

export interface TelegramControllerOptions {
  manifest: ProjectManifest;
  eventStore?: EventStore;
  notificationStore?: NotificationStore;
  approvalStore?: ApprovalStore;
  offsetStore?: TelegramOffsetStore;
  allowlist?: TelegramAllowlistConfig;
  /** 지정하지 않으면 AUTODEV_TELEGRAM_BOT_TOKEN 환경변수를 쓴다. */
  botToken?: string;
  /** 지정하지 않으면 AUTODEV_TELEGRAM_CHAT_ID 환경변수를 쓴다. */
  chatId?: string;
  /** 테스트 전용 override — 지정하지 않으면 전역 fetch를 쓴다. */
  fetchImpl?: typeof fetch;
  statePath?: string;
  cwd?: string;
  now?: () => Date;
  /** getUpdates long-poll 대기 초(기본 25 — Telegram 권장 상한 이내). */
  longPollTimeoutSec?: number;
  /** getUpdates 1회 호출의 상한(ms) — 무한 대기 금지. 기본 longPollTimeoutSec*1000+5000. */
  requestTimeoutMs?: number;
  /** tick 사이 대기시간(ms, 기본 250) — 테스트에서는 0에 가깝게 override한다. */
  tickDelayMs?: number;
  /** Bot Token이 설정돼 있지 않을 때 다음 tick까지 대기시간(ms, 기본 5000). */
  notConfiguredRetryDelayMs?: number;
  /** notification-service.ts processNotifications()의 maxAttempts로 그대로 전달된다. */
  maxDeliveryAttempts?: number;
  answerTimeoutMs?: number;
  /** 테스트 전용 override — § resolveGitExpectationForEvent. 지정하지 않으면 실제
   *  loadProjectAdapter()(project-adapter-loader.ts)를 그대로 쓴다. */
  loadProjectAdapter?: typeof loadProjectAdapter;
}

export interface TelegramControllerTickSummary {
  at: string;
  approvalsCreated: number;
  notificationsDelivered: number;
  notificationsFailed: number;
  updatesProcessed: number;
  /** getUpdates 또는 tick 내부 오류가 있었을 때만 채워진다 — Telegram API 응답 원문/Bot
   *  Token은 절대 담지 않는다(§ telegram-callback-client.ts와 동일한 고정 코드 원칙). */
  tickError?: string;
}

export interface TelegramControllerHandle {
  isRunning(): boolean;
  /** 가장 최근 tick의 결과 — 관측/테스트용, 어떤 판정에도 쓰이지 않는다. */
  getLastTickSummary(): TelegramControllerTickSummary | undefined;
  /** 진행 중인 tick을 끝까지 마친 뒤 loop를 멈춘다 — 중간에 강제로 끊지 않는다(graceful). */
  stop(): Promise<void>;
}

interface ControllerDeps {
  manifest: ProjectManifest;
  eventStore: EventStore;
  notificationStore: NotificationStore;
  approvalStore: ApprovalStore;
  offsetStore: TelegramOffsetStore;
  allowlist: TelegramAllowlistConfig;
  botToken?: string;
  chatId?: string;
  fetchImpl: typeof fetch;
  statePath: string;
  cwd: string;
  now: () => Date;
  longPollTimeoutSec: number;
  requestTimeoutMs: number;
  answerTimeoutMs?: number;
  maxDeliveryAttempts?: number;
  loadProjectAdapter?: typeof loadProjectAdapter;
}

/**
 * Multi-Project Approval Isolation(2026-09-01) — DEFECT 1 수정. installation-wide
 * controller가 owner project 하나의 cwd로 계산한 Git HEAD/branch를 다른 project의 event에
 * 그대로 섞어 쓰지 않는다(§ 요구사항 invariant A/B). event.projectId가 controller owner와
 * 같으면(대부분의 단일-project 운용, 그리고 projectId가 없는 구형/self-dev event) 기존
 * owner cwd 경로를 그대로 쓴다 — 동작 변화 없음. 다르면(cross-project) event.metadata.
 * adapterPath(그 project 자신의 autodev.ts/orchestrator.ts가 채운 값, § approval.ts
 * ApprovalRequest.adapterPath와 동일한 출처)로 loadProjectAdapter()를 다시 호출해 그
 * project의 진짜 targetProjectRoot를 얻는다. adapterPath가 없거나 로드 결과의 projectId가
 * event.projectId와 다르면(신뢰할 수 없음) undefined를 반환한다 — 호출부(approval-service.ts
 * createApprovalRequestsFromEvents)는 owner 값으로 대체하지 않고 이번 tick에서 그 event를
 * 건너뛴다.
 */
function resolveGitExpectationForEvent(event: AutoDevEvent, deps: ControllerDeps): GitExpectationForEvent | undefined {
  if (event.projectId === undefined || event.projectId === deps.manifest.projectId) {
    return { expectedGitHead: getCurrentHeadHash(deps.cwd), expectedBranch: getCurrentBranch(deps.cwd) };
  }
  const adapterPath = typeof event.metadata?.adapterPath === "string" ? event.metadata.adapterPath : undefined;
  if (!adapterPath) return undefined;
  const load = deps.loadProjectAdapter ?? loadProjectAdapter;
  let foreignManifest: ProjectManifest;
  try {
    foreignManifest = load(adapterPath);
  } catch {
    return undefined;
  }
  if (foreignManifest.projectId !== event.projectId) return undefined;
  return { expectedGitHead: getCurrentHeadHash(foreignManifest.targetProjectRoot), expectedBranch: getCurrentBranch(foreignManifest.targetProjectRoot) };
}

async function runTick(deps: ControllerDeps): Promise<TelegramControllerTickSummary> {
  const nowDate = deps.now();
  const nowIso = nowDate.toISOString();
  const { events } = deps.eventStore.query();

  const approvalsResult = createApprovalRequestsFromEvents(events, deps.approvalStore, {
    now: deps.now,
    eventStore: deps.eventStore,
    resolveGitExpectation: (event) => resolveGitExpectationForEvent(event, deps),
  });

  // AutoDev production notification policy(2026-08-27) — ntfy는 production에서 쓰지 않는다
  // (§ 파일 상단 주석). Telegram이 유일한 provider이고, 그마저도 실제 approval이 필요한
  // event만 골라 보낸다(§ isTelegramAlertWorthyEvent) — task 진행/완료/self-dev
  // 완료/routine failure/reviewer REVISE 같은 일반 상태는 여기 도달하지 않는다.
  const notificationProvider: NotificationProvider | undefined =
    deps.botToken && deps.chatId
      ? createTelegramApprovalAwareProvider({ botToken: deps.botToken, chatId: deps.chatId, fetchImpl: deps.fetchImpl }, deps.approvalStore)
      : undefined;
  const telegramAlertEvents = events.filter(isTelegramAlertWorthyEvent);

  let notificationsDelivered = 0;
  let notificationsFailed = 0;
  if (notificationProvider) {
    const notifResult = await processNotifications(telegramAlertEvents, deps.notificationStore, notificationProvider, {
      now: () => deps.now().toISOString(),
      eventStore: deps.eventStore,
      ...(deps.maxDeliveryAttempts !== undefined ? { maxAttempts: deps.maxDeliveryAttempts } : {}),
    });
    notificationsDelivered = notifResult.delivered.length;
    notificationsFailed = notifResult.failed.length;
  } else {
    // provider 없이도 dedupe/PENDING 기록 같은 bookkeeping은 그대로 수행한다(§
    // notification-service.ts) — Bot Token이 아직 없다는 이유로 이 event batch를 건너뛰면
    // 나중에 설정된 뒤에도 그 사이 발생한 event가 알림으로 승격되지 않는다.
    await processNotifications(telegramAlertEvents, deps.notificationStore, undefined, {
      now: () => deps.now().toISOString(),
      eventStore: deps.eventStore,
    });
  }

  let updatesProcessed = 0;
  let tickError: string | undefined;
  if (deps.botToken) {
    const offset = deps.offsetStore.getOffset();
    const updatesResult = await getTelegramUpdates(deps.fetchImpl, deps.botToken, offset, deps.longPollTimeoutSec, deps.requestTimeoutMs);
    if (updatesResult.ok) {
      for (const update of updatesResult.updates) {
        await handleTelegramCallbackUpdate(update, {
          approvalStore: deps.approvalStore,
          manifest: deps.manifest,
          allowlist: deps.allowlist,
          eventStore: deps.eventStore,
          now: deps.now,
          fetchImpl: deps.fetchImpl,
          botToken: deps.botToken,
          answerTimeoutMs: deps.answerTimeoutMs,
          statePath: deps.statePath,
          cwd: deps.cwd,
          loadProjectAdapter: deps.loadProjectAdapter,
        });
        updatesProcessed += 1;
        // update마다 즉시 반영한다 — batch 중간에 process가 죽어도 이미 끝까지 처리된
        // update만큼은 offset이 이미 전진해 있어 다시 배달되지 않는다(§ 요구사항: replay
        // protection이 controller 재시작에도 이어짐).
        deps.offsetStore.setOffset(update.update_id + 1);
      }
    } else {
      tickError = updatesResult.error;
    }
  }

  return {
    at: nowIso,
    approvalsCreated: approvalsResult.created.length,
    notificationsDelivered,
    notificationsFailed,
    updatesProcessed,
    ...(tickError ? { tickError } : {}),
  };
}

/**
 * Controller를 시작한다 — 반환된 handle의 stop()을 호출하기 전까지 계속 tick을 반복한다.
 * manifest가 유효하지 않으면(project-manifest.ts validateProjectManifest) 즉시 throw하고
 * loop 자체를 시작하지 않는다(§ 요구사항: 잘못된 설정으로 조용히 계속 돌지 않는다).
 */
export async function startTelegramController(opts: TelegramControllerOptions): Promise<TelegramControllerHandle> {
  validateProjectManifest(opts.manifest);

  const longPollTimeoutSec = opts.longPollTimeoutSec ?? DEFAULT_LONG_POLL_TIMEOUT_SEC;
  const deps: ControllerDeps = {
    manifest: opts.manifest,
    eventStore: opts.eventStore ?? selectDefaultEventStore(),
    notificationStore: opts.notificationStore ?? selectDefaultNotificationStore(),
    approvalStore: opts.approvalStore ?? selectDefaultApprovalStore(),
    offsetStore: opts.offsetStore ?? selectDefaultTelegramOffsetStore(),
    allowlist: opts.allowlist ?? resolveTelegramAllowlist(),
    // isProductionRuntime()이 참일 때만 환경변수의 실제 Bot Token/Chat ID를 읽는다(§
    // runtime-origin.ts, 2026-08-22 incident) — opts로 명시적으로 넘기지 않는 한, 이
    // 값이 Windows 환경변수에 영구적으로 남아있어도 test/비-production 실행에서는 절대
    // 읽히지 않는다(fail-closed).
    botToken: opts.botToken ?? (isProductionRuntime() ? process.env.AUTODEV_TELEGRAM_BOT_TOKEN : undefined),
    chatId: opts.chatId ?? (isProductionRuntime() ? process.env.AUTODEV_TELEGRAM_CHAT_ID : undefined),
    fetchImpl: opts.fetchImpl ?? fetch,
    statePath: opts.statePath ?? opts.manifest.statePath,
    cwd: opts.cwd ?? opts.manifest.targetProjectRoot,
    now: opts.now ?? (() => new Date()),
    longPollTimeoutSec,
    requestTimeoutMs: opts.requestTimeoutMs ?? longPollTimeoutSec * 1000 + DEFAULT_REQUEST_TIMEOUT_BUFFER_MS,
    answerTimeoutMs: opts.answerTimeoutMs,
    maxDeliveryAttempts: opts.maxDeliveryAttempts,
    loadProjectAdapter: opts.loadProjectAdapter,
  };

  const tickDelayMs = opts.tickDelayMs ?? DEFAULT_TICK_DELAY_MS;
  const notConfiguredRetryDelayMs = opts.notConfiguredRetryDelayMs ?? DEFAULT_NOT_CONFIGURED_RETRY_DELAY_MS;

  let running = true;
  let lastTickSummary: TelegramControllerTickSummary | undefined;
  let resolveStopSignal!: () => void;
  const stopSignal = new Promise<void>((resolve) => {
    resolveStopSignal = resolve;
  });

  function cancellableDelay(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const handle = setTimeout(resolve, ms);
      stopSignal.then(() => {
        clearTimeout(handle);
        resolve();
      });
    });
  }

  const loopPromise = (async () => {
    while (running) {
      try {
        lastTickSummary = await runTick(deps);
      } catch (err) {
        // tick 내부에서 예상치 못한 예외가 새어나와도 controller 프로세스 자체는 죽지 않는다
        // — 다음 tick에서 다시 시도한다. err.message에는 Bot Token/callback 원문이 담길 수
        // 없다(telegram-callback-client.ts/approval-service.ts가 이미 그런 값을 던지지 않고
        // 고정 코드로만 반환하기 때문) — 이 catch는 store I/O 등 그 밖의 예외에 대한 방어선이다.
        lastTickSummary = {
          at: deps.now().toISOString(),
          approvalsCreated: 0,
          notificationsDelivered: 0,
          notificationsFailed: 0,
          updatesProcessed: 0,
          tickError: err instanceof Error ? err.message : String(err),
        };
      }
      if (!running) break;
      await cancellableDelay(deps.botToken ? tickDelayMs : notConfiguredRetryDelayMs);
    }
  })();

  return {
    isRunning: () => running,
    getLastTickSummary: () => lastTickSummary,
    stop: async () => {
      running = false;
      resolveStopSignal();
      await loopPromise;
    },
  };
}
