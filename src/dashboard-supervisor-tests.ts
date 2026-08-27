import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeBackoffDelayMs,
  checkSupervisorLock,
  defaultIsPidAlive,
  DEFAULT_BACKOFF_SCHEDULE_MS,
  runSupervisorLoop,
  shouldResetFailureStreak,
} from "./dashboard-supervisor";
import type { SupervisedChild, SupervisorConfig, SupervisorDeps } from "./dashboard-supervisor";
import type { PortCheckResult } from "./dashboard";

// AutoDev 대시보드 서버 장애 원인분석·복구·하드닝 § 요구사항 6/7/9/11 — Dashboard Supervisor
// 테스트. 순수 판정 함수는 단위 테스트로, 실제 crash-detect/backoff/재시작 배선은 진짜 OS
// child process(spawn)를 써서 검증한다(§ 요구사항 9 "실제 process kill -> 자동 재시작"을
// mock이 아니라 실제로 재현) — 단, 포트 판정(probePort)은 이 파일에서 fake로 주입해 실제
// 4590/HTTP 왕복 없이도 backoff/lock/재시작 로직 자체를 빠르고 결정적으로 검증한다(포트 판정
// 자체는 dashboard-tests.ts의 checkExistingServer 테스트가 이미 별도로 검증한다).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-dashboard-supervisor-"));
  tempDirs.push(dir);
  return dir;
}

function scenarioBackoffScheduleBounded(): void {
  check("1회 실패 -> schedule[0]", computeBackoffDelayMs(1, DEFAULT_BACKOFF_SCHEDULE_MS, 60_000) === DEFAULT_BACKOFF_SCHEDULE_MS[0]);
  check("2회 실패 -> schedule[1]", computeBackoffDelayMs(2, DEFAULT_BACKOFF_SCHEDULE_MS, 60_000) === DEFAULT_BACKOFF_SCHEDULE_MS[1]);
  check("3회 실패 -> schedule[2]", computeBackoffDelayMs(3, DEFAULT_BACKOFF_SCHEDULE_MS, 60_000) === DEFAULT_BACKOFF_SCHEDULE_MS[2]);
  check("schedule 범위를 넘으면 cooldown으로 bounded", computeBackoffDelayMs(4, DEFAULT_BACKOFF_SCHEDULE_MS, 60_000) === 60_000);
  check("schedule을 훨씬 넘어도 cooldown 이상으로 커지지 않음(무한 가속 없음)", computeBackoffDelayMs(50, DEFAULT_BACKOFF_SCHEDULE_MS, 60_000) === 60_000);
  check("실패 0회는 대기 없음", computeBackoffDelayMs(0, DEFAULT_BACKOFF_SCHEDULE_MS, 60_000) === 0);
}

function scenarioSustainedUptimeResetsStreak(): void {
  check("충분히 오래 살았으면 리셋 대상", shouldResetFailureStreak(5000, 3000));
  check("너무 빨리 죽었으면 리셋 대상 아님", !shouldResetFailureStreak(50, 3000));
}

function scenarioLockNoFile(): void {
  const dir = makeTempDir();
  const lockPath = join(dir, "dashboard-supervisor.lock");
  const result = checkSupervisorLock(lockPath, () => true);
  check("lock 파일이 없으면 PROCEED", result.action === "PROCEED" && result.reason === "NO_LOCK_FILE");
}

function scenarioLockMalformed(): void {
  const dir = makeTempDir();
  const lockPath = join(dir, "dashboard-supervisor.lock");
  writeFileSync(lockPath, "not valid json", "utf-8");
  const result = checkSupervisorLock(lockPath, () => true);
  check("lock 파일이 손상돼도 throw하지 않고 PROCEED(stale로 취급)", result.action === "PROCEED");
}

function scenarioLockAliveOwnerBlocks(): void {
  const dir = makeTempDir();
  const lockPath = join(dir, "dashboard-supervisor.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), "utf-8");
  // 실제 살아있는 PID(자기 자신)로 실제 defaultIsPidAlive를 그대로 사용 — mock 아님.
  const result = checkSupervisorLock(lockPath, defaultIsPidAlive);
  check("실제로 살아있는 owner PID면 ALREADY_RUNNING(중복 supervisor 차단)", result.action === "ALREADY_RUNNING");
}

async function scenarioLockDeadOwnerProceeds(): Promise<void> {
  const dir = makeTempDir();
  const lockPath = join(dir, "dashboard-supervisor.lock");
  // 실제로 이미 종료된 자식 프로세스의 PID를 얻어(진짜 OS 이벤트) stale lock 시나리오를
  // 재현한다.
  const dead = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const pid = child.pid as number;
    child.once("exit", () => resolve(pid));
  });
  writeFileSync(lockPath, JSON.stringify({ pid: dead }), "utf-8");
  const result = checkSupervisorLock(lockPath, defaultIsPidAlive);
  check("실제로 죽은 owner PID(stale lock)면 PROCEED", result.action === "PROCEED");
}

function makeChildScript(dir: string, name: string, body: string): string {
  const scriptPath = join(dir, name);
  writeFileSync(scriptPath, body, "utf-8");
  return scriptPath;
}

interface FakeProbeQueue {
  probePort: (port: number) => Promise<PortCheckResult>;
  push(result: PortCheckResult): void;
}

function makeFakeProbeQueue(defaultResult: PortCheckResult): FakeProbeQueue {
  const queue: PortCheckResult[] = [];
  return {
    push: (r) => queue.push(r),
    probePort: async () => (queue.length > 0 ? (queue.shift() as PortCheckResult) : defaultResult),
  };
}

function baseConfig(overrides: Partial<SupervisorConfig> = {}): SupervisorConfig {
  return {
    port: 0,
    spawnCommand: process.execPath,
    spawnArgs: [],
    cwd: process.cwd(),
    backoffScheduleMs: [30, 60, 90],
    cooldownMs: 150,
    sustainedUptimeResetMs: 250,
    healthyPollIntervalMs: 20,
    portConflictRecheckMs: 20,
    ...overrides,
  };
}

async function scenarioRealKillTriggersRealRespawn(): Promise<void> {
  const dir = makeTempDir();
  const scriptPath = makeChildScript(dir, "idle.js", "setInterval(() => {}, 1000);\n");
  const probe = makeFakeProbeQueue("FREE");
  const logs: Record<string, unknown>[] = [];
  const controller = new AbortController();
  let lastChild: SupervisedChild | undefined;

  const deps: SupervisorDeps = {
    probePort: probe.probePort,
    spawnChild: () => {
      const child = spawn(process.execPath, [scriptPath]);
      lastChild = child;
      return child;
    },
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      }),
    now: () => Date.now(),
    log: (f) => logs.push(f),
  };

  const loopPromise = runSupervisorLoop(baseConfig(), deps, controller.signal);

  await waitUntil(() => logs.some((l) => l.event === "SPAWNED"), 3000);
  check("실제 child가 spawn됨(SPAWNED 로그)", logs.some((l) => l.event === "SPAWNED"));

  const spawnedOnce = lastChild;
  check("실제 자식 프로세스 PID 확보", typeof spawnedOnce?.pid === "number");
  spawnedOnce?.kill();

  await waitUntil(() => logs.some((l) => l.event === "CHILD_EXITED"), 3000);
  check("실제 kill 후 CHILD_EXITED가 감지됨", logs.some((l) => l.event === "CHILD_EXITED"));

  await waitUntil(() => logs.filter((l) => l.event === "SPAWNED").length >= 2, 3000);
  check("kill 이후 자동으로 재spawn됨(supervisor auto-restart)", logs.filter((l) => l.event === "SPAWNED").length >= 2);

  controller.abort();
  try {
    lastChild?.kill();
  } catch {
    // 이미 죽어있으면 무시.
  }
  await loopPromise;
}

async function scenarioBoundedBackoffOnRepeatedCrash(): Promise<void> {
  const dir = makeTempDir();
  const scriptPath = makeChildScript(dir, "fastcrash.js", "process.exit(7);\n");
  const probe = makeFakeProbeQueue("FREE");
  const logs: Record<string, unknown>[] = [];
  const controller = new AbortController();

  const deps: SupervisorDeps = {
    probePort: probe.probePort,
    spawnChild: () => spawn(process.execPath, [scriptPath]),
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      }),
    now: () => Date.now(),
    log: (f) => logs.push(f),
  };

  const config = baseConfig({ backoffScheduleMs: [30, 60, 90], cooldownMs: 150, sustainedUptimeResetMs: 10_000 });
  const loopPromise = runSupervisorLoop(config, deps, controller.signal);

  await waitUntil(() => logs.filter((l) => l.event === "RESTART_SCHEDULED").length >= 4, 5000);
  controller.abort();
  await loopPromise;

  const delays = logs.filter((l) => l.event === "RESTART_SCHEDULED").map((l) => l.delayMs as number);
  check("반복 crash 시 첫 3번은 backoff schedule을 그대로 따름", delays[0] === 30 && delays[1] === 60 && delays[2] === 90);
  check("schedule을 넘어서면 고정 cooldown으로 전환(무한 가속 없음)", delays[3] === 150);
}

async function scenarioSustainedUptimeResetsRealStreak(): Promise<void> {
  const dir = makeTempDir();
  // sustainedUptimeResetMs(60ms)보다 오래 살고 나서 종료 -> 매번 "새 crash 계열"로 취급되어
  // consecutiveFailures가 0으로 유지되어야 한다 -> RESTART_SCHEDULED가 전혀 로깅되지 않아야 함.
  const scriptPath = makeChildScript(dir, "slowexit.js", "setTimeout(() => process.exit(0), 120);\n");
  const probe = makeFakeProbeQueue("FREE");
  const logs: Record<string, unknown>[] = [];
  const controller = new AbortController();

  const deps: SupervisorDeps = {
    probePort: probe.probePort,
    spawnChild: () => spawn(process.execPath, [scriptPath]),
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      }),
    now: () => Date.now(),
    log: (f) => logs.push(f),
  };

  const config = baseConfig({ sustainedUptimeResetMs: 60, backoffScheduleMs: [30, 60, 90], cooldownMs: 150 });
  const loopPromise = runSupervisorLoop(config, deps, controller.signal);

  await waitUntil(() => logs.filter((l) => l.event === "CHILD_EXITED").length >= 3, 5000);
  controller.abort();
  await loopPromise;

  check(
    "충분히 오래 살다 죽으면 backoff가 누적되지 않음(RESTART_SCHEDULED 없음)",
    !logs.some((l) => l.event === "RESTART_SCHEDULED")
  );
}

async function scenarioPortConflictNeverSpawnsAndRecovers(): Promise<void> {
  const probe = makeFakeProbeQueue("OTHER");
  probe.push("OTHER");
  probe.push("OTHER");
  probe.push("FREE");
  const logs: Record<string, unknown>[] = [];
  let spawnCount = 0;
  const dir = makeTempDir();
  const scriptPath = makeChildScript(dir, "idle2.js", "setInterval(() => {}, 1000);\n");
  const controller = new AbortController();
  let lastChild: SupervisedChild | undefined;

  const deps: SupervisorDeps = {
    probePort: probe.probePort,
    spawnChild: () => {
      spawnCount += 1;
      const child = spawn(process.execPath, [scriptPath]);
      lastChild = child;
      return child;
    },
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      }),
    now: () => Date.now(),
    log: (f) => logs.push(f),
  };

  const loopPromise = runSupervisorLoop(baseConfig({ portConflictRecheckMs: 15 }), deps, controller.signal);

  await waitUntil(() => logs.filter((l) => l.event === "PORT_CONFLICT").length >= 2, 3000);
  check("포트 충돌 동안은 spawn을 시도하지 않음(다른 포트로 몰래 넘어가지 않음)", spawnCount === 0);

  await waitUntil(() => spawnCount >= 1, 3000);
  check("충돌이 사라지면(FREE) 원래 포트로 자동 복구되어 spawn됨", spawnCount === 1);

  controller.abort();
  try {
    lastChild?.kill();
  } catch {
    // 무시.
  }
  await loopPromise;
}

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function main(): Promise<void> {
  try {
    scenarioBackoffScheduleBounded();
    scenarioSustainedUptimeResetsStreak();
    scenarioLockNoFile();
    scenarioLockMalformed();
    scenarioLockAliveOwnerBlocks();
    await scenarioLockDeadOwnerProceeds();
    await scenarioRealKillTriggersRealRespawn();
    await scenarioBoundedBackoffOnRepeatedCrash();
    await scenarioSustainedUptimeResetsRealStreak();
    await scenarioPortConflictNeverSpawnsAndRecovers();
  } finally {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // OS temp 정리 실패는 테스트 결과에 영향 없음.
      }
    }
  }

  console.log("\n=== dashboard-supervisor 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
