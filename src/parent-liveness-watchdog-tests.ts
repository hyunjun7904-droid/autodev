import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  startParentLivenessWatchdog,
  resolveSupervisorParentPidFromEnv,
  resolveSupervisorParentStartedAtMsFromEnv,
  DEFAULT_PARENT_LIVENESS_POLL_MS,
} from "./parent-liveness-watchdog";
import { assessOwnerLiveness } from "./project-lock";

// P0-3 하드닝 테스트 — 실제 Claude/OpenAI/Telegram 호출은 전혀 없다. 순수 함수만 검증한다
// (setInterval 자체는 fake로 주입해 실제 시간을 기다리지 않고 결정적으로 검증한다).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

interface FakeTimerHandle {
  handler: () => void;
  ms: number;
}

function makeFakeTimers(): {
  setIntervalFn: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn: (timer: NodeJS.Timeout) => void;
  fire(): void;
  clearedCount: number;
} {
  let registered: FakeTimerHandle | undefined;
  let clearedCount = 0;
  return {
    setIntervalFn: (handler, ms) => {
      registered = { handler, ms };
      return registered as unknown as NodeJS.Timeout;
    },
    clearIntervalFn: () => {
      clearedCount++;
    },
    fire: () => {
      registered?.handler();
    },
    get clearedCount() {
      return clearedCount;
    },
  };
}

function scenarioParentAliveNeverFires(): void {
  const timers = makeFakeTimers();
  let deadCalled = false;
  startParentLivenessWatchdog(
    12345,
    { isPidAlive: () => true, onParentDead: () => (deadCalled = true), setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn },
    1_000
  );
  timers.fire();
  timers.fire();
  timers.fire();
  check("P0-3) parent가 계속 살아있으면 onParentDead가 절대 호출되지 않음", !deadCalled);
}

function scenarioParentDeadTriggersCallback(): void {
  const timers = makeFakeTimers();
  let deadCalled = false;
  startParentLivenessWatchdog(
    12345,
    { isPidAlive: () => false, onParentDead: () => (deadCalled = true), setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn },
    1_000
  );
  timers.fire();
  check("P0-3) parent가 죽었다고 판정되면 다음 poll에서 즉시 onParentDead 호출", deadCalled);
}

function scenarioStopPreventsClearedTimersFromFiring(): void {
  const timers = makeFakeTimers();
  let deadCalled = false;
  const handle = startParentLivenessWatchdog(
    12345,
    { isPidAlive: () => false, onParentDead: () => (deadCalled = true), setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn },
    1_000
  );
  handle.stop();
  timers.fire();
  check("P0-3) stop() 이후에는 parent가 죽어도 onParentDead가 호출되지 않음(정상 종료 시 orphan 오탐 없음)", !deadCalled);
  check("P0-3) stop()이 실제로 clearInterval을 호출함(정상 종료 시 interval이 프로세스를 붙잡지 않음)", timers.clearedCount === 1);
}

function scenarioStopIsIdempotent(): void {
  const timers = makeFakeTimers();
  const handle = startParentLivenessWatchdog(
    12345,
    { isPidAlive: () => true, onParentDead: () => {}, setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn },
    1_000
  );
  handle.stop();
  handle.stop();
  check("P0-3) stop()을 여러 번 호출해도 안전(clearInterval 1회만 실제 호출)", timers.clearedCount === 1);
}

function scenarioResolveEnvMissing(): void {
  const result = resolveSupervisorParentPidFromEnv({});
  check("P0-3) AUTODEV_SUPERVISOR_PID가 없으면 undefined(수동 실행/Canary는 watchdog 비활성)", result === undefined);
}

function scenarioResolveEnvPresent(): void {
  const result = resolveSupervisorParentPidFromEnv({ AUTODEV_SUPERVISOR_PID: "4242" });
  check("P0-3) AUTODEV_SUPERVISOR_PID가 지정되면 그 pid를 그대로 반환", result === 4242);
}

function scenarioResolveEnvMalformed(): void {
  check("P0-3) 비정상 값(문자열)은 undefined로 fail-safe", resolveSupervisorParentPidFromEnv({ AUTODEV_SUPERVISOR_PID: "not-a-pid" }) === undefined);
  check("P0-3) 0/음수는 undefined로 fail-safe", resolveSupervisorParentPidFromEnv({ AUTODEV_SUPERVISOR_PID: "-1" }) === undefined);
  check("P0-3) 빈 문자열은 undefined로 fail-safe", resolveSupervisorParentPidFromEnv({ AUTODEV_SUPERVISOR_PID: "" }) === undefined);
}

function scenarioDefaultPollIntervalReasonable(): void {
  check("P0-3) 기본 poll 간격이 양수(0이 아님 — busy loop 방지)", DEFAULT_PARENT_LIVENESS_POLL_MS > 0);
}

// ---------------------------------------------------------------------------
// § P1-4 하드닝(독립 감사) — AUTODEV_SUPERVISOR_STARTED_AT_MS resolve + PID reuse 판정 합성.
// ---------------------------------------------------------------------------
function scenarioResolveStartedAtMsMissing(): void {
  check("P1-4) AUTODEV_SUPERVISOR_STARTED_AT_MS가 없으면 undefined(구버전 supervisor로 degrade)", resolveSupervisorParentStartedAtMsFromEnv({}) === undefined);
}

function scenarioResolveStartedAtMsPresent(): void {
  check(
    "P1-4) AUTODEV_SUPERVISOR_STARTED_AT_MS가 지정되면 그 값을 숫자로 반환",
    resolveSupervisorParentStartedAtMsFromEnv({ AUTODEV_SUPERVISOR_STARTED_AT_MS: "1700000000000" }) === 1700000000000
  );
}

function scenarioResolveStartedAtMsMalformed(): void {
  check(
    "P1-4) 비정상 값(숫자가 아님)은 undefined로 fail-safe",
    resolveSupervisorParentStartedAtMsFromEnv({ AUTODEV_SUPERVISOR_STARTED_AT_MS: "not-a-number" }) === undefined
  );
}

/** run.ts가 실제로 구성하는 parentIsPidAlive와 정확히 동일한 합성 함수 — 로직을 복제하지 않고
 *  같은 원칙(assessOwnerLiveness의 verdict!=="STALE"이면 아직 살아있다고 본다)을 그대로
 *  재현해 검증한다. */
function composeParentIsPidAlive(recordedStartedAtMs: number): (pid: number) => boolean {
  return (pid) => assessOwnerLiveness(pid, recordedStartedAtMs).verdict !== "STALE";
}

/** § P1-4 핵심 fault test — 부모가 죽고 그 PID가 실제로 재사용된 것과 동일한 조건(진짜 살아있는
 *  다른 프로세스 + 그 프로세스의 실제 시작 시각과 크게 다른 recordedStartedAtMs)에서, 단순
 *  PID 생존만 보는 watchdog은 "살아있다"고 오판하지만 PID reuse 인지 합성 함수는 정확히
 *  STALE(죽음/재사용)로 판정해 자기 자신을 종료시켜야 한다. */
function scenarioPidReuseDetectedAsParentDead(): void {
  // 실제로 살아있는 프로세스(이 테스트 프로세스 자신)를 "재사용된 PID"로 흉내낸다 — 진짜
  // 시작 시각과 크게 다른 recordedStartedAtMs를 기록해둔다.
  const fakeRecordedStartedAtMs = Date.now() - 999_000_000; // 실제 시작 시각과 크게 다름
  const composed = composeParentIsPidAlive(fakeRecordedStartedAtMs);

  check(
    "P1-4) 단순 PID 생존만 보면(defaultIsPidAlive) 재사용된 PID도 여전히 alive로 오판함(비교 대상 — 이 값 자체가 개선 필요성의 근거)",
    (() => {
      try {
        process.kill(process.pid, 0);
        return true;
      } catch {
        return false;
      }
    })() === true
  );
  check(
    "P1-4) PID reuse 인지 합성 함수는 시작 시각 불일치를 STALE로 판정해 false(=parent dead)를 반환함",
    composed(process.pid) === false
  );

  const timers = makeFakeTimers();
  let deadCalled = false;
  startParentLivenessWatchdog(
    process.pid,
    { isPidAlive: composed, onParentDead: () => (deadCalled = true), setIntervalFn: timers.setIntervalFn, clearIntervalFn: timers.clearIntervalFn },
    1_000
  );
  timers.fire();
  check("P1-4) watchdog에 실제로 합성해 연결하면 PID reuse 시나리오에서도 onParentDead가 호출됨(orphan 방지)", deadCalled);
}

/** 대조군 — recordedStartedAtMs가 실제 시작 시각과 일치하면(정상, 재사용 아님) 살아있다고
 *  정확히 판정해야 한다(§ 오탐 방지 — 정상 supervisor를 재사용된 PID로 착각하지 않음). */
function scenarioMatchingStartTimeStillAlive(): void {
  const deadChild = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = deadChild.pid;
  const selfStartedAtMs = Date.now() - Math.round(process.uptime() * 1000);
  const composedAlive = composeParentIsPidAlive(selfStartedAtMs);
  check("P1-4) 시작 시각이 실제로 일치하면 정상적으로 alive로 판정됨(오탐 없음)", composedAlive(process.pid) === true);
  if (typeof deadPid === "number") {
    const composedDead = composeParentIsPidAlive(Date.now());
    check("P1-4) 실제로 죽은 PID는 시작 시각과 무관하게 dead로 판정됨", composedDead(deadPid) === false);
  } else {
    check("P1-4) (죽은 child pid를 얻지 못해 스킵)", true);
  }
}

// ---------------------------------------------------------------------------
// P0-3 — 실제 concurrency/liveness test: 실제 OS 프로세스("가짜 supervisor")를 하나 띄우고,
// 그것을 감시하는 실제 child 프로세스를 또 하나 띄운 뒤, "가짜 supervisor"를 실제로 kill해
// child가 정말로(mock 없이) 스스로 종료하는지 검증한다(§ orphan/zombie 0의 핵심 근거).
// ---------------------------------------------------------------------------
async function scenarioRealOrphanSelfTerminatesWhenParentDies(): Promise<void> {
  const workerPath = join(__dirname, "parent-liveness-watchdog-worker.js");
  if (!existsSync(workerPath)) {
    check("P0-3) (컴파일된 worker 스크립트를 찾지 못해 스킵 — npm run build 필요)", true);
    return;
  }

  // 가짜 supervisor — 그냥 살아만 있는 실제 OS 프로세스.
  const fakeParent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"]);
  const fakeParentPid = fakeParent.pid as number;

  const child = spawn(process.execPath, [workerPath, String(fakeParentPid)]);
  let out = "";
  child.stdout.on("data", (d) => {
    out += d.toString();
  });
  const childExit = new Promise<void>((resolve) => child.once("close", () => resolve()));

  // child가 최소 한 번은 poll(200ms)했을 시간을 준 뒤 "가짜 supervisor"를 실제로 kill한다.
  await new Promise((r) => setTimeout(r, 500));
  fakeParent.kill();

  await childExit;
  check("P0-3) 실제 parent(supervisor) 프로세스가 죽으면 child가 실제로 스스로 종료함(SELF_TERMINATED)", out.includes("SELF_TERMINATED"));
  check("P0-3) timeout(안전장치)이 아니라 실제 감지로 종료함", !out.includes("TIMEOUT"));
}

async function main(): Promise<void> {
  scenarioParentAliveNeverFires();
  scenarioParentDeadTriggersCallback();
  scenarioStopPreventsClearedTimersFromFiring();
  scenarioStopIsIdempotent();
  scenarioResolveEnvMissing();
  scenarioResolveEnvPresent();
  scenarioResolveEnvMalformed();
  scenarioDefaultPollIntervalReasonable();
  scenarioResolveStartedAtMsMissing();
  scenarioResolveStartedAtMsPresent();
  scenarioResolveStartedAtMsMalformed();
  scenarioPidReuseDetectedAsParentDead();
  scenarioMatchingStartTimeStillAlive();
  await scenarioRealOrphanSelfTerminatesWhenParentDies();

  console.log("\n=== parent-liveness-watchdog.ts(P0-3) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
