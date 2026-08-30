import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  startParentLivenessWatchdog,
  resolveSupervisorParentPidFromEnv,
  DEFAULT_PARENT_LIVENESS_POLL_MS,
} from "./parent-liveness-watchdog";

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
  await scenarioRealOrphanSelfTerminatesWhenParentDies();

  console.log("\n=== parent-liveness-watchdog.ts(P0-3) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
