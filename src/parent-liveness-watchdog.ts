// P0-3 하드닝 — Supervisor crash 이후 runner orphan/zombie 방지.
//
// 문제: runner-supervisor.ts는 child(run.ts --continuous)를 `detached:false`로 spawn하지만,
// Windows에는 Node.js child_process가 기본으로 강제하는 "parent가 죽으면 child도 함께
// 죽는다"는 보장이 없다(POSIX의 SIGHUP 상속과도 다르고, Job Object 연결도 기본으로 되지
// 않는다) — supervisor 프로세스 자체가 비정상 종료(강제 kill/crash)되면 child(runner)는
// 아무도 감시하지 않는 orphan으로 계속 살아있을 수 있다. watchdog(supervisor 재시작
// 루프 자체)는 "supervisor의 lock이 stale"임을 감지해 새 supervisor를 띄우지만, 그 새
// supervisor는 기존 orphan child를 전혀 모른다 — orphan이 project-lock을 계속 들고 있는
// 동안 새 supervisor의 새 child는 project-lock.ts에 의해 반복적으로 BLOCKED_PROJECT_LOCK
// 될 뿐, orphan 자신은 "관리되지 않는 채" 무기한 계속 실행된다(§ 요구사항: unmanaged
// orphan/zombie runner 0).
//
// 해결(portable Node.js만 사용 — Windows Job Object 같은 native OS primitive는 도입하지
// 않는다, § filesystem-trust-model.md의 Option A와 동일한 비용/이득 판단): child(run.ts)
// 자신이 자신을 spawn한 supervisor의 PID를 env(AUTODEV_SUPERVISOR_PID)로 전달받아, 주기적으로
// 그 PID가 아직 살아있는지 스스로 확인한다. 죽었다고 판단되면 즉시 자기 자신을 종료한다 —
// 이미 하드닝된 crash-safe checkpoint resume(§ CLAUDE.md)이 이 "예기치 않은 프로세스 종료"를
// 안전하게 재개할 수 있으므로, 자진 종료는 새로운 위험을 만들지 않는다. 이렇게 하면 orphan은
// "무기한 관리되지 않고 계속 실행"되는 대신 다음 poll 안에 스스로 사라지고, project-lock이
// 곧 stale해져 새 supervisor의 새 child가 정상적으로 project-lock을 획득할 수 있게 된다.

export interface ParentLivenessWatchdogDeps {
  isPidAlive: (pid: number) => boolean;
  onParentDead: () => void;
  setIntervalFn?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (timer: NodeJS.Timeout) => void;
}

export interface ParentLivenessWatchdogHandle {
  stop(): void;
}

export const DEFAULT_PARENT_LIVENESS_POLL_MS = 5_000;

/** parentPid가 살아있는 동안은 아무것도 하지 않고, 죽었다고 판정되는 즉시(다음 poll에서)
 *  deps.onParentDead()를 호출한다. 반환된 handle.stop()으로 언제든 중단할 수 있다(정상 종료
 *  경로에서 반드시 호출해 interval이 프로세스 종료를 막지 않게 해야 한다). */
export function startParentLivenessWatchdog(
  parentPid: number,
  deps: ParentLivenessWatchdogDeps,
  pollMs: number = DEFAULT_PARENT_LIVENESS_POLL_MS
): ParentLivenessWatchdogHandle {
  const setIntervalFn = deps.setIntervalFn ?? setInterval;
  const clearIntervalFn = deps.clearIntervalFn ?? clearInterval;
  let stopped = false;
  const timer = setIntervalFn(() => {
    if (stopped) return;
    if (!deps.isPidAlive(parentPid)) {
      deps.onParentDead();
    }
  }, pollMs);
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
    },
  };
}

/** run.ts가 supervisor로부터 spawn됐는지, 됐다면 어떤 PID를 감시해야 하는지 env에서 읽는다.
 *  이 env가 없으면(수동 실행/Canary/일반 CLI 등 supervisor 없이 실행된 경우) watchdog을 전혀
 *  켜지 않는다 — 지켜볼 supervisor가 애초에 없는 실행까지 이 메커니즘을 강제하지 않는다. */
export function resolveSupervisorParentPidFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.AUTODEV_SUPERVISOR_PID;
  if (!raw || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** § P1-4 하드닝(독립 감사) — AUTODEV_SUPERVISOR_PID와 짝을 이루는 supervisor의 실제 OS
 *  시작 시각(epoch ms) 추정값. project-lock.ts의 processStartedAtMs와 동일한 목적: 이 값이
 *  있으면 호출부(run.ts)가 단순 PID 생존이 아니라 project-lock.ts의 assessOwnerLiveness()로
 *  "그 PID가 정말 우리가 감시하던 그 supervisor인지"(PID reuse 여부)까지 재확인할 수 있다.
 *  이 값이 없으면(구버전 supervisor가 spawn했거나 env가 누락된 경우) undefined를 반환해
 *  호출부가 기존 단순 PID liveness로 안전하게 degrade하게 한다 — 이 값의 부재가 watchdog
 *  자체를 막지는 않는다. */
export function resolveSupervisorParentStartedAtMsFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.AUTODEV_SUPERVISOR_STARTED_AT_MS;
  if (!raw || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
