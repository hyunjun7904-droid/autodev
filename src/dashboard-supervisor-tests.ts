import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeBackoffDelayMs,
  checkSupervisorLock,
  defaultIsPidAlive,
  acquireSupervisorLockAtomic,
  releaseSupervisorLockAtomic,
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

// ---------------------------------------------------------------------------
// P0-2 하드닝 — acquireSupervisorLockAtomic()은 check-then-create가 아니라 `wx` exclusive
// create만으로 승부를 가른다. 살아있는 owner를 절대 덮어쓰지 않고, dead owner는 밀어내되
// 밀어내는 순간 다른 supervisor가 이미 fresh lock으로 교체했다면 지우지 않는다(§ project-lock
// P0-1과 동일한 CAS 원칙).
// ---------------------------------------------------------------------------
function scenarioAtomicAcquireSucceedsOnEmptyDir(): void {
  const dir = makeTempDir();
  const lockPath = join(dir, "supervisor.lock");
  const result = acquireSupervisorLockAtomic(lockPath, defaultIsPidAlive);
  check("P0-2) lock 없는 상태에서 atomic acquire 성공", result.ok === true);
  check("P0-2) lock 파일이 실제로 생성됨", existsSync(lockPath));
}

function scenarioAtomicAcquireBlockedByAliveOwner(): void {
  const dir = makeTempDir();
  const lockPath = join(dir, "supervisor.lock");
  // 실제 살아있는 owner(자기 자신)를 심어둔다 — mock 아님.
  const alwaysAlive = acquireSupervisorLockAtomic(lockPath, () => true);
  check("사전조건: 첫 acquire 성공", alwaysAlive.ok === true);
  const second = acquireSupervisorLockAtomic(lockPath, () => true);
  check("P0-2) 살아있는 owner가 있으면 두 번째 acquire는 차단됨(덮어쓰지 않음)", second.ok === false);
  check("P0-2) 원래 lock 파일이 그대로 유지됨", existsSync(lockPath));
}

/** P0-2 핵심 fault test — "X를 stale로 판정한 프로세스가 삭제 직전 다른 프로세스가 이미
 *  교체한 fresh Y를 실수로 삭제하지 않는다"를 project-lock.ts의 P0-1 fault test와 동일한
 *  기법(isPidAlive의 부수효과로 판정~삭제 사이 race를 결정적으로 재현)으로 검증한다. */
function scenarioAtomicAcquireStaleReplacedByFreshDuringRemoval(): void {
  const dir = makeTempDir();
  const lockPath = join(dir, "supervisor.lock");

  const deadPid = 5_555_551;
  writeFileSync(lockPath, JSON.stringify({ pid: deadPid, lockId: "stale-X" }), "utf-8");

  let swapped = false;
  const raceIsPidAlive = (pid: number): boolean => {
    if (pid === deadPid && !swapped) {
      // A가 "X는 죽었다"는 판정을 받는 바로 그 순간, 다른 supervisor(B)가 X를 자신의 fresh
      // lock(Y)으로 교체했다고 흉내낸다.
      swapped = true;
      writeFileSync(lockPath, JSON.stringify({ pid: 9_999_991, lockId: "fresh-Y" }), "utf-8");
      return false; // X는 실제로 죽었음(stale 판정 그대로 유지)
    }
    if (pid === 9_999_991) return true; // Y는 살아있는 진짜 owner
    return false;
  };

  const result = acquireSupervisorLockAtomic(lockPath, raceIsPidAlive);
  check("P0-2) X를 stale로 판정한 프로세스는 교체된 fresh Y를 삭제하지 못함(acquire 실패)", result.ok === false);
  check(
    "P0-2) Y의 lock 파일이 실수로 삭제되지 않고 그대로 존재(active writer ≤ 1 유지)",
    existsSync(lockPath) && (JSON.parse(readFileSync(lockPath, "utf-8")) as { lockId?: string }).lockId === "fresh-Y"
  );
}

// ---------------------------------------------------------------------------
// P0-2 — 실제 concurrency test: 실제 Node child process 2개가 동시에 같은 supervisor lock을
// acquisition 시도한다(project-lock-tests.ts의 실제 concurrency test와 동일한 원칙 — mock이
// 아니라 실제 OS 프로세스 두 개).
// ---------------------------------------------------------------------------
async function scenarioRealConcurrentSupervisorAcquisition(): Promise<void> {
  const dir = makeTempDir();
  const lockPath = join(dir, "supervisor.lock");
  const workerPath = join(__dirname, "supervisor-lock-concurrency-worker.js");
  if (!existsSync(workerPath)) {
    check("P0-2) (컴파일된 worker 스크립트를 찾지 못해 스킵 — npm run build 필요)", true);
    return;
  }

  function runWorker(): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [workerPath, lockPath]);
      let out = "";
      child.stdout.on("data", (d) => {
        out += d.toString();
      });
      child.on("close", () => resolve(out.trim()));
    });
  }

  const [outA, outB] = await Promise.all([runWorker(), runWorker()]);
  const acquiredCount = [outA, outB].filter((o) => o === "ACQUIRED").length;
  const blockedCount = [outA, outB].filter((o) => o.startsWith("BLOCKED:")).length;
  check("P0-2) 동시에 supervisor 2개 시작 시도 중 정확히 하나만 ACQUIRED(active supervisor 정확히 1개)", acquiredCount === 1);
  check("P0-2) 나머지 하나(loser)는 BLOCKED — writer/runner를 만들지 않음", blockedCount === 1);

  try {
    if (readdirSync(dir).length > 0) rmSync(lockPath, { force: true });
  } catch {
    /* 정리 실패는 테스트 결과에 영향 없음 */
  }
}

// ---------------------------------------------------------------------------
// P0-2 재하드닝 — 실제 concurrency test: 이미 죽은(진짜 dead pid) owner의 stale supervisor
// lock 하나를 실제 OS 프로세스 2개가 동시에 밀어내고 새로 acquire하려고 경쟁한다(§
// project-lock-tests.ts의 scenarioRealConcurrentStaleLockRecovery와 동일한 원칙).
// ---------------------------------------------------------------------------
async function scenarioRealConcurrentSupervisorStaleLockRecovery(): Promise<void> {
  const dir = makeTempDir();
  const lockPath = join(dir, "supervisor.lock");
  const workerPath = join(__dirname, "supervisor-lock-concurrency-worker.js");
  if (!existsSync(workerPath)) {
    check("P0-2-real) (컴파일된 worker 스크립트를 찾지 못해 스킵 — npm run build 필요)", true);
    return;
  }

  const deadChild = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = deadChild.pid;
  if (typeof deadPid !== "number") {
    check("P0-2-real) (죽은 child pid를 얻지 못해 스킵)", true);
    return;
  }
  writeFileSync(lockPath, JSON.stringify({ pid: deadPid, lockId: "real-race-stale-owner", startedAt: new Date().toISOString() }), "utf-8");

  function runWorker(): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [workerPath, lockPath]);
      let out = "";
      child.stdout.on("data", (d) => {
        out += d.toString();
      });
      child.on("close", () => resolve(out.trim()));
    });
  }

  const [outA, outB] = await Promise.all([runWorker(), runWorker()]);
  const acquiredCount = [outA, outB].filter((o) => o === "ACQUIRED").length;
  check("P0-2-real) 진짜 dead owner의 stale supervisor lock을 두 실제 프로세스가 동시에 밀어내도 정확히 하나만 ACQUIRED", acquiredCount === 1);
  check(
    "P0-2-real) 나머지 하나는 BLOCKED(승자를 정확히 인식) — 둘 다 자신이 supervisor라고 착각하지 않음",
    (outA === "ACQUIRED") !== (outB === "ACQUIRED") && (outA.startsWith("BLOCKED:") || outB.startsWith("BLOCKED:"))
  );

  try {
    rmSync(lockPath, { force: true });
  } catch {
    /* 정리 실패는 테스트 결과에 영향 없음 */
  }
}

// ---------------------------------------------------------------------------
// P0-2 — shutdown()의 ownership-blind unlink 제거 검증. releaseSupervisorLockAtomic()은
// "내가 acquire 때 발급받은 lockId"가 현재 파일의 owner와 정확히 같을 때만 지운다 — 예전
// shutdown()의 `existsSync → unlinkSync`(자기 ownership 미확인)였다면 아래 시나리오에서
// new supervisor(B)의 살아있는 lock까지 지워버렸을 것이다.
// ---------------------------------------------------------------------------
function scenarioReleaseOnlyRemovesOwnLock(): void {
  const dir = makeTempDir();
  const lockPath = join(dir, "supervisor.lock");

  const acquired = acquireSupervisorLockAtomic(lockPath, () => false);
  check("P0-2-release) 사전조건: old supervisor(A) acquire 성공", acquired.ok === true);
  if (!acquired.ok) return;
  const ownLockId = acquired.lockId;

  // old supervisor(A)가 stale로 판정되어 밀려나고, new supervisor(B)가 이미 그 자리에
  // 자신의 fresh lock을 만들어둔 상태를 흉내낸다 — A는 이 사실을 전혀 모른 채 자신이 원래
  // 발급받은 lockId로만 shutdown release를 시도한다.
  writeFileSync(lockPath, JSON.stringify({ pid: 8_123_456, lockId: "new-supervisor-B", startedAt: new Date().toISOString() }), "utf-8");

  const released = releaseSupervisorLockAtomic(lockPath, ownLockId);
  check("P0-2-release) old supervisor(A)의 release 시도는 거부됨(lockId 불일치)", released.ok === false);
  check(
    "P0-2-release) new supervisor(B)의 lock이 실수로 삭제되지 않고 그대로 존재",
    existsSync(lockPath) && (JSON.parse(readFileSync(lockPath, "utf-8")) as { lockId?: string }).lockId === "new-supervisor-B"
  );

  try {
    rmSync(lockPath, { force: true });
  } catch {
    /* 정리 실패는 테스트 결과에 영향 없음 */
  }
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
    scenarioAtomicAcquireSucceedsOnEmptyDir();
    scenarioAtomicAcquireBlockedByAliveOwner();
    scenarioAtomicAcquireStaleReplacedByFreshDuringRemoval();
    scenarioReleaseOnlyRemovesOwnLock();
    await scenarioRealConcurrentSupervisorAcquisition();
    await scenarioRealConcurrentSupervisorStaleLockRecovery();
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
