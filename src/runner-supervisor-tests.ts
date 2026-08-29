import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSupervisorLock, defaultIsPidAlive } from "./dashboard-supervisor";
import {
  clearMaintenancePause,
  engageMaintenancePause,
  maintenancePauseMarkerPath,
  runRunnerSupervisorLoop,
  sanitizeForFilename,
} from "./runner-supervisor";
import type { RunnerSupervisorConfig, RunnerSupervisorDeps, SupervisedRunnerChild } from "./runner-supervisor";

// AutoDev Continuous Runner Lifecycle Independence 테스트(2026-08-28 Maintenance) —
// dashboard-supervisor-tests.ts와 동일한 원칙: 순수 판정 함수는 이미 dashboard-supervisor-
// tests.ts가 검증했으므로(checkSupervisorLock/defaultIsPidAlive/computeBackoffDelayMs/
// shouldResetFailureStreak, 이 파일은 그 함수들을 재사용만 하고 재구현하지 않는다 — 재검증하지
// 않는다), 이 파일은 이 모듈 고유의 것만 검증한다: (1) runRunnerSupervisorLoop 자체(포트
// 확인 단계가 없는, 더 단순화된 spawn-wait-backoff-respawn 루프)를 진짜 OS child process로
// 검증(§ 요구사항 "실제 process kill -> 자동 재시작"을 mock이 아니라 재현), (2) project별
// lock 파일명 분리(sanitizeForFilename).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-runner-supervisor-"));
  tempDirs.push(dir);
  return dir;
}

function makeChildScript(dir: string, name: string, body: string): string {
  const scriptPath = join(dir, name);
  writeFileSync(scriptPath, body, "utf-8");
  return scriptPath;
}

function baseConfig(overrides: Partial<RunnerSupervisorConfig> = {}): RunnerSupervisorConfig {
  return {
    spawnCommand: process.execPath,
    spawnArgs: [],
    cwd: process.cwd(),
    env: {},
    backoffScheduleMs: [30, 60, 90],
    cooldownMs: 150,
    sustainedUptimeResetMs: 250,
    maintenancePollMs: 20,
    ...overrides,
  };
}

function neverPaused(): boolean {
  return false;
}

function fakeSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });
}

async function waitUntil(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

function scenarioSanitizeForFilename(): void {
  check("영숫자/-/_/.은 그대로 유지", sanitizeForFilename("abc-123_x.y") === "abc-123_x.y");
  check("경로 구분자/드라이브 문자는 _로 치환(파일 경로 escape 방지)", sanitizeForFilename("C:\\Users\\x\\.autodev\\manifest.json") === "C__Users_x_.autodev_manifest.json");
  check("서로 다른 project adapter 경로는 서로 다른 이름으로 분리됨", sanitizeForFilename("C:/a/manifest.json") !== sanitizeForFilename("C:/b/manifest.json"));
}

function scenarioLockReusesDashboardSupervisorLockLogic(): void {
  const dir = makeTempDir();
  const lockPath = join(dir, `runner-supervisor-${sanitizeForFilename("C:/fake/project/manifest.json")}.lock`);
  const noFile = checkSupervisorLock(lockPath, () => true);
  check("lock 파일이 없으면 PROCEED(dashboard-supervisor.ts의 checkSupervisorLock 재사용)", noFile.action === "PROCEED");
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid }), "utf-8");
  const aliveOwner = checkSupervisorLock(lockPath, defaultIsPidAlive);
  check("살아있는 owner PID면 ALREADY_RUNNING(같은 project supervisor 중복 방지)", aliveOwner.action === "ALREADY_RUNNING");
}

// § 요구사항 21/24 — "runner crash -> supervisor 자동복구", 이번 세션 실제 incident(background
// shell job object 정리로 continuous runner가 2회 강제 종료됨)와 동일한 형태(실제 kill)를
// 진짜 OS child process로 재현한다.
async function scenarioRealKillTriggersRealRespawn(): Promise<void> {
  const dir = makeTempDir();
  const scriptPath = makeChildScript(dir, "idle.js", "setInterval(() => {}, 1000);\n");
  const logs: Record<string, unknown>[] = [];
  const controller = new AbortController();
  let lastChild: SupervisedRunnerChild | undefined;

  const deps: RunnerSupervisorDeps = {
    spawnChild: () => {
      const child = spawn(process.execPath, [scriptPath]);
      lastChild = child;
      return child;
    },
    sleep: fakeSleep,
    now: () => Date.now(),
    log: (f) => logs.push(f),
    isMaintenancePaused: neverPaused,
  };

  const loopPromise = runRunnerSupervisorLoop(baseConfig(), deps, controller.signal);

  await waitUntil(() => logs.some((l) => l.event === "SPAWNED"), 3000);
  check("실제 runner child가 spawn됨(SPAWNED 로그)", logs.some((l) => l.event === "SPAWNED"));

  const spawnedOnce = lastChild;
  check("실제 자식 프로세스 PID 확보", typeof spawnedOnce?.pid === "number");
  (spawnedOnce as unknown as { kill(): boolean })?.kill();

  await waitUntil(() => logs.some((l) => l.event === "CHILD_EXITED"), 3000);
  check("실제 kill 후 CHILD_EXITED가 감지됨(launcher/harness 종료로 프로세스가 죽는 것과 동일한 신호)", logs.some((l) => l.event === "CHILD_EXITED"));

  await waitUntil(() => logs.filter((l) => l.event === "SPAWNED").length >= 2, 3000);
  check("kill 이후 자동으로 재spawn됨(durable resume은 autodev.ts/human-gate-policy.ts가 이어서 담당)", logs.filter((l) => l.event === "SPAWNED").length >= 2);

  controller.abort();
  try {
    (lastChild as unknown as { kill(): boolean })?.kill();
  } catch {
    // 이미 죽어있으면 무시.
  }
  await loopPromise;
}

async function scenarioBoundedBackoffOnRepeatedCrash(): Promise<void> {
  const dir = makeTempDir();
  const scriptPath = makeChildScript(dir, "fastcrash.js", "process.exit(7);\n");
  const logs: Record<string, unknown>[] = [];
  const controller = new AbortController();

  const deps: RunnerSupervisorDeps = {
    spawnChild: () => spawn(process.execPath, [scriptPath]),
    sleep: fakeSleep,
    now: () => Date.now(),
    log: (f) => logs.push(f),
    isMaintenancePaused: neverPaused,
  };

  const config = baseConfig({ backoffScheduleMs: [30, 60, 90], cooldownMs: 150, sustainedUptimeResetMs: 10_000 });
  const loopPromise = runRunnerSupervisorLoop(config, deps, controller.signal);

  await waitUntil(() => logs.filter((l) => l.event === "RESTART_SCHEDULED").length >= 4, 5000);
  controller.abort();
  await loopPromise;

  const delays = logs.filter((l) => l.event === "RESTART_SCHEDULED").map((l) => l.delayMs as number);
  check("반복 crash 시 첫 3번은 backoff schedule을 그대로 따름(dashboard-supervisor.ts와 동일한 재사용 함수)", delays[0] === 30 && delays[1] === 60 && delays[2] === 90);
  check("schedule을 넘어서면 고정 cooldown으로 전환(무한 가속 없음)", delays[3] === 150);
}

async function scenarioSustainedUptimeResetsRealStreak(): Promise<void> {
  const dir = makeTempDir();
  const scriptPath = makeChildScript(dir, "slowexit.js", "setTimeout(() => process.exit(0), 120);\n");
  const logs: Record<string, unknown>[] = [];
  const controller = new AbortController();

  const deps: RunnerSupervisorDeps = {
    spawnChild: () => spawn(process.execPath, [scriptPath]),
    sleep: fakeSleep,
    now: () => Date.now(),
    log: (f) => logs.push(f),
    isMaintenancePaused: neverPaused,
  };

  const config = baseConfig({ sustainedUptimeResetMs: 60, backoffScheduleMs: [30, 60, 90], cooldownMs: 150 });
  const loopPromise = runRunnerSupervisorLoop(config, deps, controller.signal);

  await waitUntil(() => logs.filter((l) => l.event === "CHILD_EXITED").length >= 3, 5000);
  controller.abort();
  await loopPromise;

  check("충분히 오래 살다 죽으면 backoff가 누적되지 않음(RESTART_SCHEDULED 없음)", !logs.some((l) => l.event === "RESTART_SCHEDULED"));
}

// § 요구사항 25 — duplicate launch는 두 번째 writer를 만들지 않는다. 이 supervisor 계층에서는
// "같은 project를 향한 두 번째 supervisor가 자기 자신의 child를 또 spawn하지 않는다"만
// 검증한다(project-lock.ts 자체의 single-writer 보장은 project-lock-tests.ts/project-lock-
// integration-tests.ts가 이미 별도로 검증한다 — 이 파일이 재검증하지 않는다).
function scenarioDuplicateSupervisorForSameProjectBlocked(): void {
  const dir = makeTempDir();
  const adapterPath = "C:/fake/jarvis/.autodev/manifest.json";
  const lockPath = join(dir, `runner-supervisor-${sanitizeForFilename(adapterPath)}.lock`);
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, adapterPath }), "utf-8");
  const second = checkSupervisorLock(lockPath, defaultIsPidAlive);
  check("같은 project adapter를 가리키는 두 번째 supervisor는 ALREADY_RUNNING으로 차단됨", second.action === "ALREADY_RUNNING");
}

function scenarioDifferentProjectsDoNotBlockEachOther(): void {
  const dir = makeTempDir();
  const lockA = join(dir, `runner-supervisor-${sanitizeForFilename("C:/projA/manifest.json")}.lock`);
  writeFileSync(lockA, JSON.stringify({ pid: process.pid }), "utf-8");
  const lockB = join(dir, `runner-supervisor-${sanitizeForFilename("C:/projB/manifest.json")}.lock`);
  const forOther = checkSupervisorLock(lockB, defaultIsPidAlive);
  check("서로 다른 project는 서로의 supervisor를 막지 않음(AutoDev는 project-agnostic Core)", forOther.action === "PROCEED");
}

// Maintenance Pause(2026-08-30, controlled resume 실측 후속 조치) — supervisor 프로세스는
// 살려둔 채 "다음 child spawn"만 일시정지하는 별도 primitive(§ runner-supervisor.ts
// runRunnerSupervisorLoop 상단 주석). project-lock.ts와는 완전히 분리된 마커 파일 하나로만
// 판정한다 — 아래 시나리오들은 (1) 마커 파일 자체의 round-trip(존재 여부만이 유일한 상태,
// idempotent), (2) 처음부터 paused면 spawn이 전혀 일어나지 않음, (3) 이미 떠 있는 child는
// 강제 종료하지 않고 자연 종료를 기다린 뒤에만 게이트가 적용됨, (4) pause/clear가 기존
// backoff 스케줄/카운터를 전혀 훼손하지 않음을 실제 OS child process로 검증한다.

function scenarioMaintenancePauseMarkerRoundTrip(): void {
  const dir = makeTempDir();
  const adapterPath = "C:/fake/jarvis/.autodev/manifest.json";
  const markerPath = maintenancePauseMarkerPath(adapterPath, dir);
  check("초기 상태: 마커 파일 없음", !existsSync(markerPath));

  engageMaintenancePause(adapterPath, dir, "test-engage");
  check("engageMaintenancePause 후 마커 파일 생성됨", existsSync(markerPath));

  engageMaintenancePause(adapterPath, dir, "test-engage-again");
  check("이미 켜진 상태에서 다시 engage해도 안전(idempotent)", existsSync(markerPath));

  clearMaintenancePause(adapterPath, dir);
  check("clearMaintenancePause 후 마커 파일 삭제됨", !existsSync(markerPath));

  clearMaintenancePause(adapterPath, dir);
  check("이미 꺼진 상태에서 다시 clear해도 예외 없이 안전(idempotent)", !existsSync(markerPath));

  const otherAdapterPath = "C:/fake/other-project/.autodev/manifest.json";
  const otherMarkerPath = maintenancePauseMarkerPath(otherAdapterPath, dir);
  check("서로 다른 project adapter는 서로 다른 마커 파일을 가리킴(project-lock과 동일 원칙)", markerPath !== otherMarkerPath);
}

async function scenarioMaintenancePauseBlocksSpawnFromStart(): Promise<void> {
  const dir = makeTempDir();
  const scriptPath = makeChildScript(dir, "idle.js", "setInterval(() => {}, 1000);\n");
  const adapterPath = "C:/fake/jarvis/.autodev/manifest.json";
  const logs: Record<string, unknown>[] = [];
  const controller = new AbortController();
  let lastChild: SupervisedRunnerChild | undefined;

  engageMaintenancePause(adapterPath, dir, "before-start");

  const deps: RunnerSupervisorDeps = {
    spawnChild: () => {
      const child = spawn(process.execPath, [scriptPath]);
      lastChild = child;
      return child;
    },
    sleep: fakeSleep,
    now: () => Date.now(),
    log: (f) => logs.push(f),
    isMaintenancePaused: () => existsSync(maintenancePauseMarkerPath(adapterPath, dir)),
  };

  const loopPromise = runRunnerSupervisorLoop(baseConfig({ maintenancePollMs: 20 }), deps, controller.signal);

  await waitUntil(() => logs.some((l) => l.event === "MAINTENANCE_PAUSE_ACTIVE"), 2000);
  check("paused 상태로 시작하면 MAINTENANCE_PAUSE_ACTIVE가 기록됨", logs.some((l) => l.event === "MAINTENANCE_PAUSE_ACTIVE"));

  await new Promise((r) => setTimeout(r, 200));
  check("마커가 켜진 동안은 spawn이 전혀 일어나지 않음(SPAWNED 0건)", !logs.some((l) => l.event === "SPAWNED"));

  clearMaintenancePause(adapterPath, dir);
  await waitUntil(() => logs.some((l) => l.event === "SPAWNED"), 2000);
  check("마커 해제 후에는 정상적으로 spawn됨", logs.some((l) => l.event === "SPAWNED"));
  check("마커 해제가 기록됨(MAINTENANCE_PAUSE_CLEARED)", logs.some((l) => l.event === "MAINTENANCE_PAUSE_CLEARED"));

  controller.abort();
  try {
    (lastChild as unknown as { kill(): boolean })?.kill();
  } catch {
    // 이미 죽어있으면 무시.
  }
  await loopPromise;
}

async function scenarioMaintenancePauseWaitsForActiveChildThenBlocksRespawn(): Promise<void> {
  const dir = makeTempDir();
  const scriptPath = makeChildScript(dir, "idle.js", "setInterval(() => {}, 1000);\n");
  const adapterPath = "C:/fake/jarvis/.autodev/manifest.json";
  const logs: Record<string, unknown>[] = [];
  const controller = new AbortController();
  let lastChild: SupervisedRunnerChild | undefined;

  const deps: RunnerSupervisorDeps = {
    spawnChild: () => {
      const child = spawn(process.execPath, [scriptPath]);
      lastChild = child;
      return child;
    },
    sleep: fakeSleep,
    now: () => Date.now(),
    log: (f) => logs.push(f),
    isMaintenancePaused: () => existsSync(maintenancePauseMarkerPath(adapterPath, dir)),
  };

  const loopPromise = runRunnerSupervisorLoop(baseConfig({ maintenancePollMs: 20 }), deps, controller.signal);

  await waitUntil(() => logs.some((l) => l.event === "SPAWNED"), 2000);
  const firstChild = lastChild;
  check("unpaused 상태에서는 정상적으로 첫 child가 spawn됨", typeof firstChild?.pid === "number");

  // 이미 떠 있는 child가 살아있는 동안 maintenance pause를 켠다 — 강제 종료 대상이 아니어야 한다.
  engageMaintenancePause(adapterPath, dir, "mid-run");
  await new Promise((r) => setTimeout(r, 100));
  check(
    "이미 떠 있는 child는 maintenance pause로 강제 종료되지 않음(자연 종료를 기다림 — CHILD_EXITED 아직 없음)",
    !logs.some((l) => l.event === "CHILD_EXITED")
  );

  (firstChild as unknown as { kill(): boolean })?.kill();
  await waitUntil(() => logs.some((l) => l.event === "CHILD_EXITED"), 2000);
  check("떠 있던 child가 자연 종료됨(kill에 의한 CHILD_EXITED)", logs.some((l) => l.event === "CHILD_EXITED"));

  await new Promise((r) => setTimeout(r, 200));
  check("child 종료 후에도 paused 상태면 재spawn되지 않음(SPAWNED는 여전히 1건)", logs.filter((l) => l.event === "SPAWNED").length === 1);

  clearMaintenancePause(adapterPath, dir);
  await waitUntil(() => logs.filter((l) => l.event === "SPAWNED").length >= 2, 2000);
  check("pause 해제 후에는 다시 정상 spawn됨(SPAWNED 2건째)", logs.filter((l) => l.event === "SPAWNED").length >= 2);

  controller.abort();
  try {
    (lastChild as unknown as { kill(): boolean })?.kill();
  } catch {
    // 이미 죽어있으면 무시.
  }
  await loopPromise;
}

async function scenarioMaintenancePauseDoesNotDisturbBackoff(): Promise<void> {
  const dir = makeTempDir();
  const scriptPath = makeChildScript(dir, "fastcrash.js", "process.exit(7);\n");
  const adapterPath = "C:/fake/jarvis/.autodev/manifest.json";
  const logs: Record<string, unknown>[] = [];
  const controller = new AbortController();

  const deps: RunnerSupervisorDeps = {
    spawnChild: () => spawn(process.execPath, [scriptPath]),
    sleep: fakeSleep,
    now: () => Date.now(),
    log: (f) => logs.push(f),
    isMaintenancePaused: () => existsSync(maintenancePauseMarkerPath(adapterPath, dir)),
  };

  const config = baseConfig({ backoffScheduleMs: [30, 60, 90], cooldownMs: 150, sustainedUptimeResetMs: 10_000, maintenancePollMs: 20 });
  const loopPromise = runRunnerSupervisorLoop(config, deps, controller.signal);

  // 두 번 crash가 쌓이도록 둔 뒤(backoff schedule 진행 중) maintenance pause를 켰다가 곧바로
  // 끈다 — RESTART_SCHEDULED 순서/delay 자체가 이 토글로 바뀌면 안 된다(§ "backoff/restart
  // 상태 훼손 없음").
  await waitUntil(() => logs.filter((l) => l.event === "RESTART_SCHEDULED").length >= 2, 3000);
  engageMaintenancePause(adapterPath, dir, "mid-backoff");
  await new Promise((r) => setTimeout(r, 100));
  clearMaintenancePause(adapterPath, dir);

  await waitUntil(() => logs.filter((l) => l.event === "RESTART_SCHEDULED").length >= 4, 5000);
  controller.abort();
  await loopPromise;

  const delays = logs.filter((l) => l.event === "RESTART_SCHEDULED").map((l) => l.delayMs as number);
  check(
    "backoff 도중 maintenance pause를 껐다 켜도 schedule은 그대로(첫 3번 30/60/90, 이후 cooldown 150)",
    delays[0] === 30 && delays[1] === 60 && delays[2] === 90 && delays[3] === 150
  );
  check("crash 횟수(RESTART_SCHEDULED)가 pause 토글로 인해 부풀려지지 않음", delays.length === 4);
}

async function main(): Promise<void> {
  try {
    scenarioSanitizeForFilename();
    scenarioLockReusesDashboardSupervisorLockLogic();
    scenarioDuplicateSupervisorForSameProjectBlocked();
    scenarioDifferentProjectsDoNotBlockEachOther();
    await scenarioRealKillTriggersRealRespawn();
    await scenarioBoundedBackoffOnRepeatedCrash();
    await scenarioSustainedUptimeResetsRealStreak();
    scenarioMaintenancePauseMarkerRoundTrip();
    await scenarioMaintenancePauseBlocksSpawnFromStart();
    await scenarioMaintenancePauseWaitsForActiveChildThenBlocksRespawn();
    await scenarioMaintenancePauseDoesNotDisturbBackoff();
  } finally {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // OS temp 정리 실패는 테스트 결과에 영향 없음.
      }
    }
  }

  console.log("\n=== runner-supervisor 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
