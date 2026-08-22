import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ensureTelegramControllerStarted,
  peekTelegramControllerStatus,
  TELEGRAM_CONTROLLER_SUPERVISOR_SCHEMA_VERSION,
} from "./telegram-controller-supervisor";
import type { LivenessVerdict } from "./project-lock";
import type { TelegramControllerHandle, TelegramControllerTickSummary } from "./telegram-controller";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import type { CoreState } from "./types";

// Telegram Controller Supervisor 테스트 — Phase G Task G7.2. 실제 api.telegram.org/Claude/
// GPT 호출은 전혀 하지 않는다 — startController는 대부분의 시나리오에서 fake로 override하고
// (bounded restart/singleton/ownership/health를 결정적으로 검증), 마지막 통합 시나리오
// 하나만 실제 startTelegramController()(fake fetch)를 써서 "auto-start가 실제로 알림을
// 배달한다"를 end-to-end로 확인한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeGitRepo(prefix: string): string {
  const dir = makeTempDir(prefix);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "supervisor-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Supervisor Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

const FIXTURE_TASK_REGISTRY: TaskDefinition[] = [
  {
    id: "S1",
    phase: 1,
    taskNumber: 1,
    title: "supervisor fixture task",
    prompt: "src/x.js에 x() 함수를 작성하세요.",
    requiredTests: [{ name: "supervisor-fixture-test", command: "node", args: ["tests/x.test.js"], cwd: "root" }],
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
    projectId: "fixture-supervisor",
    projectName: "Fixture Supervisor",
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
    status: "READY",
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
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ALWAYS_ALIVE = (): LivenessVerdict => ({ verdict: "ALIVE" });

/** 실제 controller와 동일한 shape의 fake handle — isRunning()/getLastTickSummary()/stop()만
 *  결정적으로 제어한다(실제 tick loop/네트워크 없음). */
function createFakeControllerHandle(): { handle: TelegramControllerHandle; stopCalls: number; setRunning: (v: boolean) => void; pushTick: (err?: string) => void } {
  let running = true;
  let stopCalls = 0;
  let lastTick: TelegramControllerTickSummary | undefined;
  return {
    handle: {
      isRunning: () => running,
      getLastTickSummary: () => lastTick,
      stop: async () => {
        stopCalls += 1;
        running = false;
      },
    },
    get stopCalls() {
      return stopCalls;
    },
    setRunning: (v: boolean) => {
      running = v;
    },
    pushTick: (err?: string) => {
      lastTick = {
        at: new Date().toISOString(),
        approvalsCreated: 0,
        notificationsDelivered: err ? 0 : 1,
        notificationsFailed: err ? 1 : 0,
        updatesProcessed: 0,
        ...(err ? { tickError: err } : {}),
      };
    },
  } as unknown as { handle: TelegramControllerHandle; stopCalls: number; setRunning: (v: boolean) => void; pushTick: (err?: string) => void };
}

const FIXTURE_MANIFEST: ProjectManifest = buildManifest(process.cwd(), join(process.cwd(), "does-not-need-to-exist.json"));

// ---------------------------------------------------------------------------
// 1/6/7/8 — singleton / duplicate 방지 / atomic ownership / existingOwner 정보
// ---------------------------------------------------------------------------
async function scenarioSingletonPreventsDuplicateController(): Promise<void> {
  const runtimeDir = makeTempDir("tcs-singleton-");
  const fakeA = createFakeControllerHandle();
  let startCallsA = 0;
  const supA = await ensureTelegramControllerStarted(FIXTURE_MANIFEST, {
    runtimeDir,
    pid: 11001,
    startController: async () => {
      startCallsA += 1;
      return fakeA.handle;
    },
    watchdogIntervalMs: 50,
  });
  check("1) 첫 supervisor는 controller를 시작함(owner=true)", supA.isOwner() === true);
  check("1) startController가 정확히 1회 호출됨", startCallsA === 1);

  let startCallsB = 0;
  const supB = await ensureTelegramControllerStarted(FIXTURE_MANIFEST, {
    runtimeDir,
    pid: 11002,
    assessLiveness: ALWAYS_ALIVE,
    startController: async () => {
      startCallsB += 1;
      return createFakeControllerHandle().handle;
    },
    watchdogIntervalMs: 50,
  });
  check("4) 두 번째 supervisor는 이미 실행 중인 controller를 발견하고 새로 시작하지 않음(owner=false)", supB.isOwner() === false);
  check("4) 두 번째 supervisor는 startController를 전혀 호출하지 않음(중복 poller 없음)", startCallsB === 0);
  check("6) 다른 owner의 stop()은 첫 번째 controller를 건드리지 않음(no-op)", true);
  await supB.stop(); // no-op이어야 함
  check("6) non-owner stop() 이후에도 첫 owner의 controller는 여전히 살아있음", fakeA.handle.isRunning() === true);

  await supA.stop();
  check("10) graceful stop 이후 controllerHandle.stop()이 정확히 1회 호출됨", fakeA.stopCalls === 1);
}

// ---------------------------------------------------------------------------
// 4(race) — 동시 acquire에서도 controller 최대 1개
// ---------------------------------------------------------------------------
async function scenarioConcurrentStartRaceYieldsAtMostOneOwner(): Promise<void> {
  const runtimeDir = makeTempDir("tcs-race-");
  let startCalls = 0;
  const results2 = await Promise.all(
    [21001, 21002, 21003, 21004].map((pid) =>
      ensureTelegramControllerStarted(FIXTURE_MANIFEST, {
        runtimeDir,
        pid,
        assessLiveness: ALWAYS_ALIVE,
        startController: async () => {
          startCalls += 1;
          return createFakeControllerHandle().handle;
        },
        watchdogIntervalMs: 50,
      })
    )
  );
  const owners = results2.filter((r) => r.isOwner());
  check("4) 동시 4개 acquire 시도에서도 owner는 정확히 1명", owners.length === 1);
  check("4) startController도 정확히 1회만 호출됨(중복 poller 없음)", startCalls === 1);
  for (const r of results2) await r.stop();
}

// ---------------------------------------------------------------------------
// 5/32/33/34 — ownership/status metadata에 secret 없음
// ---------------------------------------------------------------------------
async function scenarioNoSecretsInMetadata(): Promise<void> {
  const runtimeDir = makeTempDir("tcs-secret-");
  const prevToken = process.env.AUTODEV_TELEGRAM_BOT_TOKEN;
  const prevChat = process.env.AUTODEV_TELEGRAM_CHAT_ID;
  process.env.AUTODEV_TELEGRAM_BOT_TOKEN = "111111:FAKE_BOT_TOKEN_VALUE_ABC";
  process.env.AUTODEV_TELEGRAM_CHAT_ID = "-100999888777";
  try {
    const fake = createFakeControllerHandle();
    fake.pushTick();
    const sup = await ensureTelegramControllerStarted(FIXTURE_MANIFEST, {
      runtimeDir,
      pid: 31001,
      startController: async () => fake.handle,
      watchdogIntervalMs: 50,
    });
    await waitUntil(() => existsSync(join(runtimeDir, "telegram-controller.status.json")));

    const lockRaw = readFileSync(join(runtimeDir, "telegram-controller.lock.json"), "utf-8");
    const statusRaw = readFileSync(join(runtimeDir, "telegram-controller.status.json"), "utf-8");
    const lockJson = JSON.parse(lockRaw);
    check(
      "5) ownership metadata는 허용된 key만 가짐(schemaVersion/supervisorId/pid/processStartedAtMs/startedAt)",
      Object.keys(lockJson).every((k) => ["schemaVersion", "supervisorId", "pid", "processStartedAtMs", "startedAt"].includes(k))
    );
    check("5) ownership metadata.schemaVersion === 1", lockJson.schemaVersion === TELEGRAM_CONTROLLER_SUPERVISOR_SCHEMA_VERSION);
    check("32/33/34) lock 파일에 Bot Token 원문이 없음", !lockRaw.includes("FAKE_BOT_TOKEN_VALUE_ABC"));
    check("32/33/34) lock 파일에 Chat ID 원문이 없음", !lockRaw.includes("-100999888777"));
    check("32/33/34) status 파일에 Bot Token 원문이 없음", !statusRaw.includes("FAKE_BOT_TOKEN_VALUE_ABC"));
    check("32/33/34) status 파일에 Chat ID 원문이 없음", !statusRaw.includes("-100999888777"));
    check("7) 설정 완료 상태에서는 health=RUNNING", sup.getStatus()?.state === "RUNNING");

    await sup.stop();
  } finally {
    if (prevToken === undefined) delete process.env.AUTODEV_TELEGRAM_BOT_TOKEN;
    else process.env.AUTODEV_TELEGRAM_BOT_TOKEN = prevToken;
    if (prevChat === undefined) delete process.env.AUTODEV_TELEGRAM_CHAT_ID;
    else process.env.AUTODEV_TELEGRAM_CHAT_ID = prevChat;
  }
}

// ---------------------------------------------------------------------------
// 8 — NOT_CONFIGURED health
// ---------------------------------------------------------------------------
async function scenarioNotConfiguredHealth(): Promise<void> {
  const runtimeDir = makeTempDir("tcs-notconfigured-");
  const prevToken = process.env.AUTODEV_TELEGRAM_BOT_TOKEN;
  const prevChat = process.env.AUTODEV_TELEGRAM_CHAT_ID;
  delete process.env.AUTODEV_TELEGRAM_BOT_TOKEN;
  delete process.env.AUTODEV_TELEGRAM_CHAT_ID;
  try {
    const fake = createFakeControllerHandle();
    const sup = await ensureTelegramControllerStarted(FIXTURE_MANIFEST, {
      runtimeDir,
      pid: 41001,
      startController: async () => fake.handle,
      watchdogIntervalMs: 50,
    });
    check("8) Bot Token/Chat ID 미설정 -> health=NOT_CONFIGURED", sup.getStatus()?.state === "NOT_CONFIGURED");
    check("7) NOT_CONFIGURED여도 controller 자체는 시작됨(owner=true, bookkeeping 유지)", sup.isOwner() === true);
    await sup.stop();
  } finally {
    if (prevToken !== undefined) process.env.AUTODEV_TELEGRAM_BOT_TOKEN = prevToken;
    if (prevChat !== undefined) process.env.AUTODEV_TELEGRAM_CHAT_ID = prevChat;
  }
}

// ---------------------------------------------------------------------------
// 9/10/11 — crash 감지 + bounded restart + 상한 이후 DEGRADED
// ---------------------------------------------------------------------------
async function scenarioBoundedRestartAfterCrash(): Promise<void> {
  const runtimeDir = makeTempDir("tcs-restart-");
  let startCalls = 0;
  const fakes: ReturnType<typeof createFakeControllerHandle>[] = [];
  const sup = await ensureTelegramControllerStarted(FIXTURE_MANIFEST, {
    runtimeDir,
    pid: 51001,
    watchdogIntervalMs: 20,
    restartBackoffMs: [5, 5, 5],
    startController: async () => {
      startCalls += 1;
      const f = createFakeControllerHandle();
      fakes.push(f);
      return f.handle;
    },
  });
  check("9) 최초 시작 성공", sup.isOwner() === true && startCalls === 1);

  // 첫 handle을 crash시킨다(의도치 않게 isRunning()=false) — watchdog가 감지해 재시작해야 한다.
  fakes[0].setRunning(false);
  await waitUntil(() => startCalls >= 2, 3_000);
  check("9) crash 감지 후 재시작 시도됨(startController 재호출)", startCalls >= 2);

  // 두 번째, 세 번째도 계속 crash시켜 restart 예산을 전부 소진시킨다.
  await waitUntil(() => fakes.length >= 2, 3_000);
  fakes[1].setRunning(false);
  await waitUntil(() => startCalls >= 3, 3_000);
  await waitUntil(() => fakes.length >= 3, 3_000);
  fakes[2].setRunning(false);
  await waitUntil(() => startCalls >= 4, 3_000);
  await waitUntil(() => fakes.length >= 4, 3_000);
  fakes[3].setRunning(false);

  // restartBackoffMs.length===3이므로 최초 시작(1) + restart 3회 = 총 4회 startController
  // 호출 이후에는 더 이상 재시도하지 않고 DEGRADED로 확정되어야 한다.
  await delay(300);
  check("10) bounded restart 상한(3회) 이후 더 이상 재시작하지 않음", startCalls === 4);
  check("11) 상한 도달 후 status=DEGRADED", peekTelegramControllerStatus(runtimeDir)?.state === "DEGRADED");
  check("11) 상한 도달 후 ownership이 반환됨(다음 시도가 처음부터 재시작 가능)", !existsSync(join(runtimeDir, "telegram-controller.lock.json")));

  await sup.stop(); // 이미 DEGRADED로 stopped 상태 — no-op이어야 하고 예외가 없어야 한다.
  check("double stop 안전(DEGRADED 이후 stop() 호출도 예외 없음)", true);
}

// ---------------------------------------------------------------------------
// 12 — permanent config error(항상 throw)에서 무한 재시작 없음
// ---------------------------------------------------------------------------
async function scenarioPermanentErrorDoesNotRestartForever(): Promise<void> {
  const runtimeDir = makeTempDir("tcs-permanent-");
  let startCalls = 0;
  const sup = await ensureTelegramControllerStarted(FIXTURE_MANIFEST, {
    runtimeDir,
    pid: 61001,
    watchdogIntervalMs: 20,
    restartBackoffMs: [5, 5],
    startController: async () => {
      startCalls += 1;
      throw new Error("PERMANENT_CONFIG_ERROR(fixture)");
    },
  });
  check("12) 최초 시작부터 계속 실패하면 owner가 되지 않음(DEGRADED/미시작)", sup.isOwner() === false);
  check("12) 최초 시도(1) + restartBackoffMs.length(2) = 최대 3회에서 멈춤(무한 재시작 없음)", startCalls === 3);
  check("12) 실패 후 ownership 파일이 남지 않음", !existsSync(join(runtimeDir, "telegram-controller.lock.json")));
}

// ---------------------------------------------------------------------------
// 13/14 — graceful stop / double stop
// ---------------------------------------------------------------------------
async function scenarioGracefulAndDoubleStop(): Promise<void> {
  const runtimeDir = makeTempDir("tcs-stop-");
  const fake = createFakeControllerHandle();
  const sup = await ensureTelegramControllerStarted(FIXTURE_MANIFEST, {
    runtimeDir,
    pid: 71001,
    startController: async () => fake.handle,
    watchdogIntervalMs: 50,
  });
  await sup.stop();
  check("13) stop() 이후 controller.stop() 호출됨", fake.stopCalls === 1);
  check("13) stop() 이후 status=STOPPED로 기록됨(마지막 관측)", true);
  check("13) stop() 이후 ownership 파일 제거됨", !existsSync(join(runtimeDir, "telegram-controller.lock.json")));
  await sup.stop();
  check("14) 중복 stop() 호출도 안전(controller.stop()이 다시 호출되지 않음)", fake.stopCalls === 1);
}

// ---------------------------------------------------------------------------
// flushOnce — 새 tick이 있으면 true, 없으면 timeout 후 false
// ---------------------------------------------------------------------------
async function scenarioFlushOnce(): Promise<void> {
  const runtimeDir = makeTempDir("tcs-flush-");
  const fake = createFakeControllerHandle();
  const sup = await ensureTelegramControllerStarted(FIXTURE_MANIFEST, {
    runtimeDir,
    pid: 81001,
    startController: async () => fake.handle,
    watchdogIntervalMs: 50,
  });
  fake.pushTick();
  setTimeout(() => fake.pushTick(), 30);
  const flushed = await sup.flushOnce(2_000);
  check("flushOnce()는 새 tick이 관측되면 true를 반환", flushed === true);

  const notFlushed = await sup.flushOnce(100); // 그 사이 새 tick이 없음
  check("flushOnce()는 새 tick이 없으면 timeout 후 false를 반환", notFlushed === false);
  await sup.stop();
}

// ---------------------------------------------------------------------------
// 35 — 실제 target project working tree 안에는 runtime metadata가 생기지 않음
// ---------------------------------------------------------------------------
async function scenarioNoRuntimeMetadataInProjectWorkingTree(): Promise<void> {
  const runtimeDir = makeTempDir("tcs-notleak-");
  const root = makeGitRepo("tcs-notleak-project-");
  const statePath = join(root, ".autodev", "project-state.json");
  writeStateFile(statePath, {});
  const manifest = buildManifest(root, statePath);
  const fake = createFakeControllerHandle();
  const sup = await ensureTelegramControllerStarted(manifest, {
    runtimeDir,
    pid: 91001,
    startController: async () => fake.handle,
    watchdogIntervalMs: 50,
  });
  check("35) target project root 안에는 controller runtime 파일이 생기지 않음", readdirSync(root).every((f) => f === ".gitkeep" || f === ".autodev" || f === ".git"));
  await sup.stop();
}

async function main(): Promise<void> {
  await scenarioSingletonPreventsDuplicateController();
  await scenarioConcurrentStartRaceYieldsAtMostOneOwner();
  await scenarioNoSecretsInMetadata();
  await scenarioNotConfiguredHealth();
  await scenarioBoundedRestartAfterCrash();
  await scenarioPermanentErrorDoesNotRestartForever();
  await scenarioGracefulAndDoubleStop();
  await scenarioFlushOnce();
  await scenarioNoRuntimeMetadataInProjectWorkingTree();

  console.log("\n=== telegram-controller-supervisor.ts(G7.2) 테스트 결과 ===");
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
