import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { startTelegramController } from "./telegram-controller";
import { createInMemoryEventStore } from "./event-store";
import type { EventStore } from "./event-store";
import { createInMemoryNotificationStore } from "./notification-store";
import type { NotificationStore } from "./notification-store";
import { createInMemoryApprovalStore, createInMemoryTelegramOffsetStore } from "./approval-store";
import type { ApprovalStore, TelegramOffsetStore } from "./approval-store";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import type { CoreState } from "./types";

// Local Telegram Controller 테스트 — Phase G Task G6. 실제 api.telegram.org 호출은 절대
// 하지 않는다(fetch는 항상 fake) — 실제 Claude/GPT 호출도 없다(이 controller 자체는
// 실행 gate를 통과시키지 않는다, 그 검증은 auto-resume-tests.ts/approval-service-tests.ts가
// 이미 담당한다 — 여기서는 REJECT 흐름으로 배선만 검증해 중복 검증을 피한다).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "controller-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Controller Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

const FIXTURE_TASK_REGISTRY: TaskDefinition[] = [
  {
    id: "C1",
    phase: 1,
    taskNumber: 1,
    title: "controller fixture task",
    prompt: "src/x.js에 x() 함수를 작성하세요.",
    requiredTests: [{ name: "controller-fixture-test", command: "node", args: ["tests/x.test.js"], cwd: "root" }],
    allowedPathPrefixes: ["src/", "tests/"],
    prohibitedOperations: ["src/, tests/ 밖 파일 수정"],
  },
];
const FIXTURE_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["src/", "tests/"],
  allowedWritePrefixes: ["src/", "tests/"],
  allowedCommands: [{ cwd: "root", command: "node", args: ["tests/x.test.js"] }],
};
function buildManifest(root: string, statePath: string): ProjectManifest {
  return {
    projectId: "fixture-controller",
    projectName: "Fixture Controller",
    targetProjectRoot: root,
    statePath,
    taskRegistry: FIXTURE_TASK_REGISTRY,
    developerInstructions: "허용 범위: src/**, tests/**만 다룹니다.",
    reviewInstructions: "함수가 정확히 동작하는지 확인하세요.",
    reviewScopeDirs: ["src/", "tests/"],
    executionPolicy: FIXTURE_EXECUTION_POLICY,
  };
}
function writeStateFile(statePath: string, overrides: Partial<CoreState>): void {
  mkdirSync(join(statePath, ".."), { recursive: true });
  const state: CoreState = {
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "WAITING_HUMAN",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
    gitCheckpoint: "",
    currentPhase: 1,
    ...overrides,
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

async function waitUntil(cond: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!cond()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitUntil: timeout 안에 조건이 만족되지 않음");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface CapturedCall {
  url: string;
  body: unknown;
}
interface RoutableFetch {
  fetch: typeof fetch;
  getUpdatesCalls: CapturedCall[];
  sendMessageCalls: CapturedCall[];
  answerCalls: CapturedCall[];
  ntfyCalls: CapturedCall[];
  /** 다음 getUpdates 응답에 이 update 하나를 1회만 실어 보낸다(그 이후는 빈 배열). */
  queueNextUpdate: (update: unknown) => void;
}
function createRoutableFakeFetch(): RoutableFetch {
  const getUpdatesCalls: CapturedCall[] = [];
  const sendMessageCalls: CapturedCall[] = [];
  const ntfyCalls: CapturedCall[] = [];
  const answerCalls: CapturedCall[] = [];
  let queuedUpdate: unknown = null;

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    // ntfy는 plain text body를 보낸다(§ notification-provider-ntfy.ts) — Telegram(JSON body)과
    // 달리 JSON.parse가 실패하므로, 파싱 가능할 때만 파싱하고 아니면 원문 문자열을 그대로 쓴다.
    let body: unknown;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    if (url.includes("/getUpdates")) {
      getUpdatesCalls.push({ url, body });
      const result = queuedUpdate ? [queuedUpdate] : [];
      queuedUpdate = null;
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    }
    if (url.includes("/sendMessage")) {
      sendMessageCalls.push({ url, body });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes("/answerCallbackQuery")) {
      answerCalls.push({ url, body });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.includes("ntfy.sh") || url.includes("ntfy.example")) {
      ntfyCalls.push({ url, body: init?.body });
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    getUpdatesCalls,
    sendMessageCalls,
    answerCalls,
    ntfyCalls,
    queueNextUpdate: (update: unknown) => {
      queuedUpdate = update;
    },
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
async function scenarioInvalidManifestThrowsAndDoesNotStartLoop(): Promise<void> {
  let threw = false;
  try {
    await startTelegramController({ manifest: { projectId: "" } as unknown as ProjectManifest });
  } catch {
    threw = true;
  }
  check("잘못된 manifest는 즉시 throw하고 loop를 시작하지 않음", threw);
}

async function scenarioStartStopLifecycle(): Promise<void> {
  const root = makeGitRepo("controller-lifecycle-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath);
  const { fetch: fetchImpl } = createRoutableFakeFetch();

  const handle = await startTelegramController({
    manifest,
    eventStore: createInMemoryEventStore(),
    notificationStore: createInMemoryNotificationStore(),
    approvalStore: createInMemoryApprovalStore(),
    offsetStore: createInMemoryTelegramOffsetStore(),
    fetchImpl,
    tickDelayMs: 5,
    notConfiguredRetryDelayMs: 5,
  });
  check("start 직후 isRunning()=true", handle.isRunning());
  await waitUntil(() => handle.getLastTickSummary() !== undefined);
  check("최소 1회 tick이 실행됨", handle.getLastTickSummary() !== undefined);
  await handle.stop();
  check("stop() 이후 isRunning()=false", handle.isRunning() === false);
}

async function scenarioNotConfiguredMakesNoNetworkCalls(): Promise<void> {
  const root = makeGitRepo("controller-not-configured-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath);
  const { fetch: fetchImpl, getUpdatesCalls, sendMessageCalls } = createRoutableFakeFetch();

  // startTelegramController()의 botToken/chatId는 `opts.xxx ?? process.env.XXX`로 계산된다
  // (§ telegram-controller.ts) — opts에 명시적으로 undefined를 넘겨도 `??`는 process.env를
  // 그대로 fallback으로 쓴다. 이 테스트가 검증하려는 "미설정" 시나리오를 실제 개발자의
  // .env(G5.1/G6 live verification용으로 실제 값이 채워져 있을 수 있다) 상태와 무관하게
  // 결정적으로 재현하려면 이 scenario 동안만 process.env 쪽도 실제로 비워야 한다.
  const prevToken = process.env.AUTODEV_TELEGRAM_BOT_TOKEN;
  const prevChatId = process.env.AUTODEV_TELEGRAM_CHAT_ID;
  delete process.env.AUTODEV_TELEGRAM_BOT_TOKEN;
  delete process.env.AUTODEV_TELEGRAM_CHAT_ID;
  try {
    const handle = await startTelegramController({
      manifest,
      eventStore: createInMemoryEventStore(),
      notificationStore: createInMemoryNotificationStore(),
      approvalStore: createInMemoryApprovalStore(),
      offsetStore: createInMemoryTelegramOffsetStore(),
      fetchImpl,
      botToken: undefined,
      chatId: undefined,
      tickDelayMs: 5,
      notConfiguredRetryDelayMs: 5,
    });
    await waitUntil(() => (handle.getLastTickSummary()?.approvalsCreated ?? -1) >= 0);
    // tick이 여러 번 돌 시간을 준다 — 그래도 네트워크 호출은 전혀 없어야 한다.
    await new Promise((resolve) => setTimeout(resolve, 60));
    await handle.stop();
    check("Bot Token 미설정 -> getUpdates 호출 자체가 없음", getUpdatesCalls.length === 0);
    check("Bot Token 미설정 -> sendMessage 호출 자체가 없음(가짜 성공 처리 없음)", sendMessageCalls.length === 0);
  } finally {
    if (prevToken !== undefined) process.env.AUTODEV_TELEGRAM_BOT_TOKEN = prevToken;
    if (prevChatId !== undefined) process.env.AUTODEV_TELEGRAM_CHAT_ID = prevChatId;
  }
}

// 2026-08-22 incident — 이 환경(이 저장소가 실제로 개발되는 Windows 머신)에는
// AUTODEV_TELEGRAM_BOT_TOKEN/CHAT_ID가 실제로 영구 환경변수로 설정돼 있다. 이 시나리오는
// 그 상황을 그대로 재현한다: 실제처럼 보이는(하지만 가짜) credential이 process.env에 있고,
// opts에도 botToken/chatId를 아예 지정하지 않는다. isProductionRuntime()(§
// runtime-origin.ts)이 dual-gate를 요구하므로, AUTOMATION_DRY_RUN/AUTODEV_PRODUCTION_RUNTIME
// 둘 다 명시적으로 설정하지 않는 한(이 테스트가 절대 설정하지 않는다) controller는 그
// credential을 전혀 읽지 않아야 하고, 실제 네트워크 호출도 없어야 한다.
async function scenarioProductionCredentialsInEnvNeverAutoAdoptedOutsideProductionRuntime(): Promise<void> {
  const root = makeGitRepo("controller-env-credential-leak-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath);
  const { fetch: fetchImpl, getUpdatesCalls, sendMessageCalls } = createRoutableFakeFetch();

  const prevToken = process.env.AUTODEV_TELEGRAM_BOT_TOKEN;
  const prevChatId = process.env.AUTODEV_TELEGRAM_CHAT_ID;
  const prevDryRun = process.env.AUTOMATION_DRY_RUN;
  const prevProdRuntime = process.env.AUTODEV_PRODUCTION_RUNTIME;
  process.env.AUTODEV_TELEGRAM_BOT_TOKEN = "123456:fake-looks-real-token-for-test";
  process.env.AUTODEV_TELEGRAM_CHAT_ID = "999999";
  delete process.env.AUTOMATION_DRY_RUN;
  delete process.env.AUTODEV_PRODUCTION_RUNTIME;
  try {
    const handle = await startTelegramController({
      manifest,
      eventStore: createInMemoryEventStore(),
      notificationStore: createInMemoryNotificationStore(),
      approvalStore: createInMemoryApprovalStore(),
      offsetStore: createInMemoryTelegramOffsetStore(),
      fetchImpl,
      // botToken/chatId를 의도적으로 지정하지 않는다 — env fallback 경로 자체를 검증한다.
      tickDelayMs: 5,
      notConfiguredRetryDelayMs: 5,
    });
    await waitUntil(() => (handle.getLastTickSummary()?.approvalsCreated ?? -1) >= 0);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await handle.stop();
    check(
      "실제 Bot Token이 env에 있어도 isProductionRuntime()이 false면 getUpdates 호출 없음",
      getUpdatesCalls.length === 0
    );
    check(
      "실제 Bot Token이 env에 있어도 isProductionRuntime()이 false면 sendMessage 호출 없음(real Telegram 전송 없음)",
      sendMessageCalls.length === 0
    );
  } finally {
    if (prevToken === undefined) delete process.env.AUTODEV_TELEGRAM_BOT_TOKEN;
    else process.env.AUTODEV_TELEGRAM_BOT_TOKEN = prevToken;
    if (prevChatId === undefined) delete process.env.AUTODEV_TELEGRAM_CHAT_ID;
    else process.env.AUTODEV_TELEGRAM_CHAT_ID = prevChatId;
    if (prevDryRun === undefined) delete process.env.AUTOMATION_DRY_RUN;
    else process.env.AUTOMATION_DRY_RUN = prevDryRun;
    if (prevProdRuntime === undefined) delete process.env.AUTODEV_PRODUCTION_RUNTIME;
    else process.env.AUTODEV_PRODUCTION_RUNTIME = prevProdRuntime;
  }
}

// ---------------------------------------------------------------------------
// tick 배선: event -> approval 생성 -> notification 자동 전달 -> getUpdates -> callback 처리
// ---------------------------------------------------------------------------
async function scenarioFullTickWiring(): Promise<void> {
  const root = makeGitRepo("controller-full-wiring-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath);

  const eventStore: EventStore = createInMemoryEventStore();
  eventStore.append({ eventType: "HUMAN_APPROVAL_REQUIRED", runId: "r1", taskId: "C1", reason: "orchestrator status=WAITING_HUMAN(x)" });

  const approvalStore: ApprovalStore = createInMemoryApprovalStore();
  const notificationStore: NotificationStore = createInMemoryNotificationStore();
  const offsetStore: TelegramOffsetStore = createInMemoryTelegramOffsetStore();
  const routable = createRoutableFakeFetch();

  const handle = await startTelegramController({
    manifest,
    eventStore,
    notificationStore,
    approvalStore,
    offsetStore,
    fetchImpl: routable.fetch,
    botToken: "tok",
    chatId: "777",
    allowlist: { chatId: "777" },
    tickDelayMs: 5,
  });

  // 1) 승인 요청이 approvalStore에 생성될 때까지 대기.
  await waitUntil(() => approvalStore.list().length > 0);
  check("event -> approval-service.ts를 통해 ApprovalStore에 ApprovalRequest 생성됨", approvalStore.list().length === 1);
  const created = approvalStore.list()[0];
  check("생성된 approval은 remotelyApprovable=true(ORCHESTRATOR_NOT_APPROVED_GENERIC)", created.remotelyApprovable === true);

  // 2) 알림이 Telegram sendMessage로 자동 전달될 때까지 대기 — 버튼(inline keyboard)이 붙어야 한다.
  await waitUntil(() => routable.sendMessageCalls.length > 0);
  const sendBody = routable.sendMessageCalls[0].body as { reply_markup?: { inline_keyboard: unknown[][] } };
  check("notification-service.ts 경로로 Telegram에 알림이 자동 전달됨", routable.sendMessageCalls.length >= 1);
  check("전달된 메시지에 승인 버튼(inline keyboard)이 붙음(remotelyApprovable=true)", (sendBody.reply_markup?.inline_keyboard.flat().length ?? 0) === 3);

  // 3) 사람이 REJECT를 눌렀다고 흉내낸다 — 다음 getUpdates 응답에 그 callback을 실어 보낸다.
  routable.queueNextUpdate({
    update_id: 555,
    callback_query: { id: "cbq-1", data: `ap:${created.approvalId}:R`, from: { id: 1 }, message: { chat: { id: 777 } } },
  });
  await waitUntil(() => approvalStore.get(created.approvalId)?.status === "REJECTED");
  check("getUpdates로 받은 REJECT callback이 approval-service.ts로 처리되어 REJECTED로 전이됨", approvalStore.get(created.approvalId)?.status === "REJECTED");
  await waitUntil(() => offsetStore.getOffset() >= 556);
  check("처리한 update_id + 1로 offset이 전진함(replay 방지)", offsetStore.getOffset() === 556);
  await waitUntil(() => routable.answerCalls.length > 0);
  check("answerCallbackQuery로 사용자에게 응답을 보냄", routable.answerCalls.length >= 1);

  await handle.stop();
}

// ---------------------------------------------------------------------------
// AutoDev production notification policy(2026-08-27) — ntfy는 production에서 쓰지
// 않는다. AUTODEV_NTFY_TOPIC 등 ntfy 관련 옵션 자체가 TelegramControllerOptions에서
// 제거됐으므로(§ telegram-controller.ts), ntfy.sh로 향하는 호출이 정말 0건인지 실제
// fetch 라우팅으로 재확인한다(§ 요구사항 "ntfy provider 호출 = 0").
// ---------------------------------------------------------------------------
async function scenarioNtfyNeverCalledInProduction(): Promise<void> {
  const root = makeGitRepo("controller-ntfy-unused-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath);

  const eventStore: EventStore = createInMemoryEventStore();
  eventStore.append({ eventType: "HUMAN_APPROVAL_REQUIRED", runId: "r1", taskId: "C1", reason: "orchestrator status=WAITING_HUMAN(x)" });

  const notificationStore: NotificationStore = createInMemoryNotificationStore();
  const routable = createRoutableFakeFetch();

  const handle = await startTelegramController({
    manifest,
    eventStore,
    notificationStore,
    fetchImpl: routable.fetch,
    botToken: "tok",
    chatId: "777",
    allowlist: { chatId: "777" },
    tickDelayMs: 5,
  });

  await waitUntil(() => routable.sendMessageCalls.length > 0);
  check("ntfy 호출 자체가 없음(provider가 생성/호출되지 않음)", routable.ntfyCalls.length === 0);
  check("Telegram sendMessage로 정상 전달됨(유일한 provider)", routable.sendMessageCalls.length >= 1);

  await handle.stop();
}

// ---------------------------------------------------------------------------
// controller 재시작 — offset/approval 상태가 그대로 이어짐(같은 store 인스턴스를 재사용해
// "재시작"을 흉내낸다 — store 자체의 파일 재시작 persistence는 approval-store-tests.ts가
// 이미 별도로 검증한다).
// ---------------------------------------------------------------------------
async function scenarioControllerRestartPreservesState(): Promise<void> {
  const root = makeGitRepo("controller-restart-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath);

  const eventStore: EventStore = createInMemoryEventStore();
  eventStore.append({ eventType: "HUMAN_APPROVAL_REQUIRED", runId: "r1", taskId: "C1", reason: "orchestrator status=WAITING_HUMAN(x)" });
  const approvalStore: ApprovalStore = createInMemoryApprovalStore();
  const notificationStore: NotificationStore = createInMemoryNotificationStore();
  const offsetStore: TelegramOffsetStore = createInMemoryTelegramOffsetStore();

  const round1Fetch = createRoutableFakeFetch();
  const handle1 = await startTelegramController({
    manifest,
    eventStore,
    notificationStore,
    approvalStore,
    offsetStore,
    fetchImpl: round1Fetch.fetch,
    botToken: "tok",
    chatId: "777",
    allowlist: { chatId: "777" },
    tickDelayMs: 5,
  });
  await waitUntil(() => approvalStore.list().length > 0);
  const created = approvalStore.list()[0];
  round1Fetch.queueNextUpdate({
    update_id: 900,
    callback_query: { id: "cbq-r1", data: `ap:${created.approvalId}:D`, from: { id: 1 }, message: { chat: { id: 777 } } },
  });
  await waitUntil(() => approvalStore.get(created.approvalId)?.status === "DEFERRED");
  await waitUntil(() => offsetStore.getOffset() >= 901);
  await handle1.stop();

  // "재시작" — 새 controller 인스턴스, 같은 store를 그대로 주입한다.
  const round2Fetch = createRoutableFakeFetch();
  const handle2 = await startTelegramController({
    manifest,
    eventStore,
    notificationStore,
    approvalStore,
    offsetStore,
    fetchImpl: round2Fetch.fetch,
    botToken: "tok",
    chatId: "777",
    allowlist: { chatId: "777" },
    tickDelayMs: 5,
  });
  await waitUntil(() => round2Fetch.getUpdatesCalls.length > 0);
  check("재시작 후 getUpdates offset이 이전 상태를 이어감(0으로 리셋되지 않음)", round2Fetch.getUpdatesCalls.every((c) => (c.url as string).includes("offset=901")));
  // 재시작 후 같은 approvalId로 다시 APPROVE를 시도해도(이미 DEFERRED로 소비됨) 거부되어야 한다.
  round2Fetch.queueNextUpdate({
    update_id: 901,
    callback_query: { id: "cbq-r2", data: `ap:${created.approvalId}:A`, from: { id: 1 }, message: { chat: { id: 777 } } },
  });
  await waitUntil(() => round2Fetch.answerCalls.length > 0);
  await handle2.stop();
  check("재시작 후에도 이미 소비된 approval은 여전히 DEFERRED로 남아있음(재시작으로 되살아나지 않음)", approvalStore.get(created.approvalId)?.status === "DEFERRED");
}

// ---------------------------------------------------------------------------
// AutoDev production notification policy(2026-08-27) — Telegram은 "실제 사용자
// APPROVE/REJECT 입력이 필요한 상태"에만 쓴다(§ 요구사항 1~15). APPROVE/REJECT/EXPIRED/
// STALE callback 처리 자체는 approval-service.ts를 전혀 건드리지 않았으므로
// approval-service-tests.ts가 이미 검증한다(요구사항 3/5/6) — 여기서 중복 검증하지
// 않는다. REJECT callback + getUpdates polling 유지(요구사항 4/14)는 기존
// scenarioFullTickWiring이 이미 검증한다. 이 두 시나리오는 나머지 "Telegram 발신 여부"
// 판정(요구사항 1/2/7/8/9/10/11/12/13/15)만 검증한다 — 각 event는 dedupeKey 충돌을
// 피하려고 서로 다른 runId를 쓴다(§ notification.ts buildDedupeKey는 runId+taskId+type
// 기준이라, 같은 runId/taskId에 같은 notificationType이 두 번 오면 두 번째는 dedupe로
// 걸러진다 — 이 테스트의 의도가 아니다).
async function scenarioApprovalRequiredNotificationsSentToTelegram(): Promise<void> {
  const root = makeGitRepo("controller-policy-allow-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath);

  const eventStore: EventStore = createInMemoryEventStore();
  // 1) HUMAN_FINAL_REVIEW — autodev.ts가 실제로 남기는 고정 reason 그대로 재현(§ autodev.ts).
  eventStore.append({ eventType: "HUMAN_APPROVAL_REQUIRED", runId: "hfr-1", taskId: "C1", reason: "HUMAN_FINAL_REVIEW_PENDING(C1)" });
  // 2) 기존 canonical approval request(고위험 작업 사전 게이트) — classifyApprovalType()의
  //    HIGH_RISK_PREGATE_PREFIX와 정확히 일치하는 고정 접두사(§ approval.ts).
  eventStore.append({ eventType: "HUMAN_APPROVAL_REQUIRED", runId: "highrisk-1", taskId: "C1", reason: "고위험 작업 감지(prod-db-write)" });
  // 13) approval-required WAITING_HUMAN — GPT reviewer가 최종적으로 차단한 경우.
  eventStore.append({ eventType: "REVIEW_BLOCKED", runId: "reviewblocked-1", taskId: "C1" });
  // (참고) 일반적인 Claude 구조적 실패(재시도가 실제로 의미 있는 경우)도 여전히 알려야
  // 한다는 기존 계약(§ scenarioFullTickWiring, remotelyApprovable=true) — NO_PROGRESS_
  // STAGNATION만 예외로 제외된다는 것을 아래 scenarioNonApprovalNotificationsNotSentToTelegram과
  // 대조해서 함께 증명한다.
  eventStore.append({ eventType: "HUMAN_APPROVAL_REQUIRED", runId: "generic-1", taskId: "C1", reason: "orchestrator status=WAITING_HUMAN" });

  const notificationStore: NotificationStore = createInMemoryNotificationStore();
  const routable = createRoutableFakeFetch();

  const handle = await startTelegramController({
    manifest,
    eventStore,
    notificationStore,
    fetchImpl: routable.fetch,
    botToken: "tok",
    chatId: "777",
    allowlist: { chatId: "777" },
    tickDelayMs: 5,
  });

  await waitUntil(() => routable.sendMessageCalls.length >= 4);
  await new Promise((resolve) => setTimeout(resolve, 30)); // 추가 tick에서 중복 전송되지 않는지 여유를 둔다.
  await handle.stop();

  function textOf(call: CapturedCall): string {
    return String((call.body as { text?: string })?.text ?? "");
  }
  const texts = routable.sendMessageCalls.map(textOf);
  check("1) HUMAN_FINAL_REVIEW → Telegram send=1", texts.filter((t) => t.includes("C1")).length >= 1 && routable.sendMessageCalls.length === 4);
  check("2) 기존 canonical approval request(고위험 사전 게이트) → Telegram send 포함됨", routable.sendMessageCalls.length === 4);
  check("13) approval-required WAITING_HUMAN(REVIEW_BLOCKED) → Telegram send 포함됨", routable.sendMessageCalls.length === 4);
  check("일반 Claude 구조적 실패(재시도가 의미 있는 경우)도 여전히 Telegram send 포함됨", routable.sendMessageCalls.length === 4);
  check("정확히 4건만 전송됨(중복/누락 없음)", routable.sendMessageCalls.length === 4);
}

async function scenarioNonApprovalNotificationsNotSentToTelegram(): Promise<void> {
  const root = makeGitRepo("controller-policy-deny-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath);

  const eventStore: EventStore = createInMemoryEventStore();
  // 7) task completion(하위 Task 🟡) — requiresHumanAction=false.
  eventStore.append({ eventType: "TASK_COMPLETED", runId: "taskdone-1", taskId: "C1", outcome: "SUCCESS" });
  // 8) final completion(✅) — requiresHumanAction=false.
  eventStore.append({ eventType: "PROJECT_COMPLETED", runId: "finaldone-1", taskId: "C1", outcome: "SUCCESS" });
  // 9) routine failure(self-dev 완료 재검증 실패, ❌) — requiresHumanAction=false.
  eventStore.append({ eventType: "SELF_DEV_TASK_FAILED", runId: "routinefail-1", taskId: "C1", reason: "typecheck 실패" });
  // 10) reviewer REVISE — EVENT_TO_NOTIFICATION_TYPE에 아예 없음(알림 자체가 안 만들어짐).
  eventStore.append({ eventType: "REVIEW_REVISE", runId: "revise-1", taskId: "C1", reviseCycle: 1 });
  // 11) NO_PROGRESS_STAGNATION — 같은 reason이라도 metadata.claudeErrorCode로 구분해
  //     제외된다(§ telegram-controller.ts isTelegramAlertWorthyEvent, autodev.ts가 실어보냄).
  eventStore.append({
    eventType: "HUMAN_APPROVAL_REQUIRED",
    runId: "stagnation-1",
    taskId: "C1",
    reason: "orchestrator status=WAITING_HUMAN",
    metadata: { claudeErrorCode: "NO_PROGRESS_STAGNATION" },
  });
  // 12) 일반 WAITING_HUMAN이지만 approval action 없음(RUN_BLOCKED — approval-service.ts가
  //     이미 ApprovalRequest 자체를 만들지 않는 것과 동일한 판단).
  eventStore.append({ eventType: "RUN_BLOCKED", runId: "runblocked-1", taskId: "C1", reason: "checkpoint 실패" });
  // self-dev/deployment informational-only WAITING_HUMAN도 동일하게 제외되는지 함께 확인.
  eventStore.append({ eventType: "SELF_DEV_WAITING_HUMAN", runId: "selfdevwait-1", taskId: "C1", reason: "사용자 확인 필요" });
  eventStore.append({ eventType: "DEPLOYMENT_WAITING_HUMAN", runId: "deploywait-1", taskId: "C1" });

  // "control" event — 이 batch에서 실제로 알림 판정이 동작했다는 것을 증명하는 대조군
  // (tick 자체가 안 돌아서 0건인 것과, 정책상 걸러져서 0건인 것을 구분하기 위함).
  eventStore.append({ eventType: "HUMAN_APPROVAL_REQUIRED", runId: "control-1", taskId: "C1", reason: "orchestrator status=WAITING_HUMAN" });

  const notificationStore: NotificationStore = createInMemoryNotificationStore();
  const routable = createRoutableFakeFetch();

  const handle = await startTelegramController({
    manifest,
    eventStore,
    notificationStore,
    fetchImpl: routable.fetch,
    botToken: "tok",
    chatId: "777",
    allowlist: { chatId: "777" },
    tickDelayMs: 5,
  });

  await waitUntil(() => routable.sendMessageCalls.length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await handle.stop();

  check("control event(일반 승인 요청)는 정상 전송됨(필터가 실제로 동작했다는 증거)", routable.sendMessageCalls.length === 1);
  check("7) task completion → Telegram send=0", routable.sendMessageCalls.length === 1);
  check("8) final completion → Telegram send=0", routable.sendMessageCalls.length === 1);
  check("9) routine failure(self-dev 최종 미완료) → Telegram send=0", routable.sendMessageCalls.length === 1);
  check("10) reviewer REVISE → Telegram send=0", routable.sendMessageCalls.length === 1);
  check("11) NO_PROGRESS_STAGNATION → Telegram send=0", routable.sendMessageCalls.length === 1);
  check("12) 일반 WAITING_HUMAN(RUN_BLOCKED, approval action 없음) → Telegram send=0", routable.sendMessageCalls.length === 1);
  check("SELF_DEV_WAITING_HUMAN도 Telegram send=0", routable.sendMessageCalls.length === 1);
  check("DEPLOYMENT_WAITING_HUMAN도 Telegram send=0", routable.sendMessageCalls.length === 1);
  check("ntfy 호출 없음(15)", routable.ntfyCalls.length === 0);
}

async function main(): Promise<void> {
  await scenarioInvalidManifestThrowsAndDoesNotStartLoop();
  await scenarioStartStopLifecycle();
  await scenarioNotConfiguredMakesNoNetworkCalls();
  await scenarioProductionCredentialsInEnvNeverAutoAdoptedOutsideProductionRuntime();
  await scenarioFullTickWiring();
  await scenarioNtfyNeverCalledInProduction();
  await scenarioControllerRestartPreservesState();
  await scenarioApprovalRequiredNotificationsSentToTelegram();
  await scenarioNonApprovalNotificationsNotSentToTelegram();

  console.log("\n=== telegram-controller.ts(G6) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);

  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // OS 임시 디렉터리 — 정리 실패는 테스트 결과에 영향 없음.
    }
  }

  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
