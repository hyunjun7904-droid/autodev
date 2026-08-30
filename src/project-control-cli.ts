import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadProjectAdapter } from "./project-adapter-loader";
import { inspectProjectRuntimeLiveness } from "./project-lock";
import type { ProjectRuntimeLiveness } from "./project-lock";
import {
  maintenancePauseMarkerPath,
  engageMaintenancePause,
  clearMaintenancePause,
  runnerSupervisorLockFilePath,
  requestStop,
} from "./runner-supervisor";
import { checkSupervisorLock, defaultIsPidAlive } from "./dashboard-supervisor";
import type { LockCheckResult } from "./dashboard-supervisor";

// AutoDev Core Maintenance — Canonical Project Control CLI(Category C, AutoDev 1.0
// 하드닝). 목적: 운영 제어(개발 일시정지/재개/현재 상태 조회)가 taskkill/process.kill/수동
// PID 입력/임시 checkpoint script(예: 이전 세션이 즉석으로 만든 hold-jarvis-lock.js류
// throwaway 스크립트)에 의존하지 않게 한다 — 이런 즉석 스크립트는 검토 없는 프로세스 종료를
// 요구해 Auto Mode classifier가 정당하게 차단하고, project lock을 "떠 있는 프로세스"로
// 점유하는 방식 자체가 오래 지속되면 사람이 그 프로세스를 직접 찾아 죽여야만 재개할 수 있는
// 취약한 운영 패턴이다.
//
// 이 파일은 새로운 판정/안전 로직을 전혀 추가하지 않는다 — project-lock.ts/
// runner-supervisor.ts/dashboard-supervisor.ts에 이미 존재하고 각자 테스트된 순수 함수만
// 얇게 배선한다. 특히 project-lock.ts의 기존 설계 원칙("release는 owner만, live lock 강제
// 탈취 금지, TTL만으로 stale 판정하지 않음")을 이 CLI가 우회할 방법을 만들지 않는다 — 그래서
// 이 CLI에는 "강제 lock 해제"(force-release) 명령이 의도적으로 없다.
//
// 실제로 project 개발을 일시정지하고 싶으면 pause(Maintenance Pause — 마커 파일 하나의
// 존재 여부만으로 판정된다, § runner-supervisor.ts)를 쓴다. 이 메커니즘은 살아있는 프로세스가
// 전혀 필요 없다 — pause 명령을 실행한 프로세스가 끝나도 마커 파일은 그대로 남아 계속
// 유효하고, resume 명령이 그 마커 파일을 지울 때까지 supervisor는 새 child를 spawn하지
// 않는다(이미 떠 있는 child는 강제 종료하지 않고 자연 종료를 기다린다, § runner-supervisor.ts
// runRunnerSupervisorLoop). 이 CLI가 도입된 뒤로는 project lock을 "계속 살아있는 프로세스"로
// 점유해 일시정지를 흉내내는 패턴이 더 이상 필요하지 않다.

export interface ProjectControlStatusDeps {
  loadProjectAdapter?: typeof loadProjectAdapter;
  inspectProjectRuntimeLiveness?: typeof inspectProjectRuntimeLiveness;
  isPidAlive?: (pid: number) => boolean;
}

export type ProjectLockStatus = ProjectRuntimeLiveness | { present: false; error: string };

export interface ProjectControlStatus {
  maintenancePaused: boolean;
  supervisor: LockCheckResult;
  projectLock: ProjectLockStatus;
}

/**
 * 사람이 명시적으로 실행하는 상태 조회 — 어떤 상태도 바꾸지 않는다(읽기 전용). 세 가지를
 * 조합해 보여준다: (1) Maintenance Pause 마커 존재 여부, (2) supervisor 자신의 lock(살아있는
 * supervisor가 있는지), (3) project lock(어떤 writer가 지금 이 project를 점유하고 있는지) —
 * 이 세 값을 하나로 뭉개지 않는다(§ CLAUDE.md — "project-lock은 이미 시작된 writer들 사이의
 * 상호배제, Maintenance Pause는 애초에 새 writer를 시작할지 여부"라는 서로 다른 질문).
 */
export function getProjectControlStatus(
  adapterPath: string,
  logsDir: string,
  deps: ProjectControlStatusDeps = {}
): ProjectControlStatus {
  const maintenancePaused = existsSync(maintenancePauseMarkerPath(adapterPath, logsDir));

  const supervisorLockPath = runnerSupervisorLockFilePath(adapterPath, logsDir);
  const supervisor = checkSupervisorLock(supervisorLockPath, deps.isPidAlive ?? defaultIsPidAlive);

  const loadAdapter = deps.loadProjectAdapter ?? loadProjectAdapter;
  let manifest;
  try {
    manifest = loadAdapter(adapterPath);
  } catch (e) {
    return { maintenancePaused, supervisor, projectLock: { present: false, error: e instanceof Error ? e.message : String(e) } };
  }

  const inspectLiveness = deps.inspectProjectRuntimeLiveness ?? inspectProjectRuntimeLiveness;
  const projectLock = inspectLiveness(manifest.projectId, manifest.targetProjectRoot);
  return { maintenancePaused, supervisor, projectLock };
}

/** getProjectControlStatus()의 결과를 사람이 읽을 수 있는 여러 줄 텍스트로 렌더링한다(순수
 *  함수, 부수효과 없음) — CLI(main())와 테스트가 이 함수 하나로만 출력 형식을 공유한다. */
export function formatProjectControlStatus(status: ProjectControlStatus): string {
  const lines: string[] = [
    `Maintenance Pause: ${status.maintenancePaused ? "ACTIVE" : "inactive"}`,
    `Supervisor: ${status.supervisor.action === "ALREADY_RUNNING" ? "RUNNING" : "not running"} (${status.supervisor.reason})`,
  ];
  const pl = status.projectLock;
  if ("error" in pl) {
    lines.push(`Project Lock: 확인 불가 — project adapter를 읽을 수 없습니다(${pl.error})`);
  } else if (!pl.present) {
    lines.push("Project Lock: 없음(어떤 writer도 이 project를 점유하고 있지 않습니다)");
  } else {
    lines.push(
      `Project Lock: pid=${pl.pid} ownerKind=${pl.ownerKind}${pl.taskId ? ` taskId=${pl.taskId}` : ""} liveness=${pl.liveness.verdict}`
    );
  }
  return lines.join("\n");
}

// AutoDev Core Maintenance — Canonical Stop Path(2026-08-31, JARVIS Task 5.3 실측 —
// "실행 중인 Developer/continuous run을 canonical하게 정상 중단할 수 없는 결함"). run.ts는
// 이미 SIGINT/SIGTERM handler를 갖고 있었고(§ run.ts installShutdownHandlers) 이제 그
// 신호가 runAbortController를 통해 durable-wait/claude CLI subprocess까지 실제로
// 전달되지만, 이 CLI에서 process.kill(pid, "SIGTERM")로 보내는 방식은 채택하지 않는다 —
// 이 Task를 구현하며 직접 3가지 방식(자기 자신에게, 완전히 별도 프로세스에서, 실제 spawn된
// 자식에게)으로 실측 확인한 결과, 이 플랫폼(Windows)의 Node.js는 process.kill()로 보낸
// SIGTERM/SIGINT에 대해 대상 프로세스의 등록된 handler를 전혀 호출하지 않고 무조건
// 종료시킨다(taskkill과 동일한 효과 — 이 Task가 막으려는 바로 그 강제 종료다). 그래서
// Maintenance Pause와 완전히 동일한 마커 파일 패턴(§ runner-supervisor.ts
// engageMaintenancePause)을 재사용한다 — run.ts가 이 마커를 능동적으로 polling해서
// runAbortController.abort()를 직접 호출한다(§ requestStop/readStopRequestForPid). 새
// IPC 경로가 아니라 이미 있는 파일 마커 메커니즘의 재사용이다.
export type StopDecision =
  | { action: "REQUEST_STOP"; pid: number; processStartedAtMs: number }
  | { action: "NO_TARGET"; reason: string }
  | { action: "REFUSED"; reason: string };

/** 순수 함수 — 실제 마커 파일을 쓰지 않는다(§ main()이 그 부수효과를 담당). 대상이
 *  없거나(present:false) 이미 죽었으면(liveness!=="ALIVE") NO_TARGET — 요청을 보낼 대상
 *  자체가 없다는 뜻이지 실패가 아니다(그 경우 project-state/lock을 이 명령이 아니라 기존
 *  stale-PID 판정이 처리한다). ownerKind가 "autodev"가 아니면(예: "local-human-approval"/
 *  "telegram-resume") REFUSED — 이 명령은 실제 AutoDev continuous writer만 대상으로 한다,
 *  다른 종류의 owner를 추측해서 건드리지 않는다.
 *
 *  PID 재사용 하드닝(2026-08-31) — REQUEST_STOP은 pid뿐 아니라 이 project lock owner가
 *  실제로 기록한 processStartedAtMs(§ project-lock.ts ProjectRuntimeLiveness — 이미 lock
 *  metadata에 있던 값을 그대로 노출한 것, 새 계산 없음)도 함께 담아 반환한다 — stop marker의
 *  대상 신원을 pid 단독이 아니라 (pid, 시작시각) 쌍으로 묶기 위함이다(§ runner-supervisor.ts
 *  requestStop/readStopRequestForPid). */
export function decideStopAction(liveness: ProjectRuntimeLiveness): StopDecision {
  if (!liveness.present) {
    return { action: "NO_TARGET", reason: "이 project를 점유한 writer가 현재 없습니다." };
  }
  if (liveness.liveness.verdict !== "ALIVE") {
    return {
      action: "NO_TARGET",
      reason: `project lock owner(pid=${liveness.pid})가 이미 살아있지 않습니다(liveness=${liveness.liveness.verdict}) — 보낼 대상이 없습니다.`,
    };
  }
  if (liveness.ownerKind !== "autodev") {
    return {
      action: "REFUSED",
      reason: `이 project lock의 owner는 ownerKind="${liveness.ownerKind}"입니다(AutoDev continuous writer가 아님) — 이 명령은 ownerKind="autodev"만 대상으로 합니다.`,
    };
  }
  return { action: "REQUEST_STOP", pid: liveness.pid, processStartedAtMs: liveness.processStartedAtMs };
}

export function parseArg(args: readonly string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1 || typeof args[idx + 1] !== "string") return undefined;
  return args[idx + 1];
}

function repoLogsDir(): string {
  return join(__dirname, "..", "logs");
}

function usageAndExit(): never {
  console.error(
    [
      "사용법:",
      "  node dist/project-control-cli.js pause --project <adapterPath> [--reason <text>]",
      "  node dist/project-control-cli.js resume --project <adapterPath>",
      "  node dist/project-control-cli.js status --project <adapterPath>",
      "  node dist/project-control-cli.js stop --project <adapterPath>",
    ].join("\n")
  );
  process.exit(1);
}

function main(): void {
  const [, , command, ...rest] = process.argv;
  const adapterPath = parseArg(rest, "--project");
  if (!command || !adapterPath) usageAndExit();

  const logsDir = repoLogsDir();
  switch (command) {
    case "pause": {
      const reason = parseArg(rest, "--reason") ?? "(사유 미지정)";
      engageMaintenancePause(adapterPath, logsDir, reason);
      console.log(`[project-control] Maintenance Pause 활성화됨 — adapter=${adapterPath}, reason=${reason}`);
      console.log(
        "[project-control] 이미 살아있는 child는 강제 종료되지 않습니다(자연 종료를 기다립니다) — 다음 spawn만 resume 전까지 미뤄집니다."
      );
      return;
    }
    case "resume": {
      clearMaintenancePause(adapterPath, logsDir);
      console.log(`[project-control] Maintenance Pause 해제됨 — adapter=${adapterPath}`);
      return;
    }
    case "status": {
      console.log(formatProjectControlStatus(getProjectControlStatus(adapterPath, logsDir)));
      return;
    }
    case "stop": {
      const manifest = loadProjectAdapter(adapterPath);
      const liveness = inspectProjectRuntimeLiveness(manifest.projectId, manifest.targetProjectRoot);
      const decision = decideStopAction(liveness);
      if (decision.action === "NO_TARGET") {
        console.log(`[project-control] Stop 대상 없음 — ${decision.reason}`);
        return;
      }
      if (decision.action === "REFUSED") {
        console.log(`[project-control] Stop 거부 — ${decision.reason}`);
        return;
      }
      console.log(`[project-control] Stop 요청 — pid=${decision.pid}를 대상으로 canonical stop marker를 남깁니다(강제 종료 아님).`);
      requestStop(adapterPath, logsDir, "project-control-cli stop", decision.pid, decision.processStartedAtMs);
      console.log(
        `[project-control] Stop 요청 기록 완료 — pid=${decision.pid}가 다음 polling 주기(§ run.ts pollForStopRequest)에서 이를 발견하고 durable-wait/진행 중인 Developer subprocess를 정상적으로 중단한 뒤 스스로 종료할 때까지 기다리세요. project-state.json/lock은 이 명령이 직접 건드리지 않습니다 — 그 프로세스 자신의 canonical stop 경로(run.ts)가 처리합니다.`
      );
      return;
    }
    default:
      usageAndExit();
  }
}

// require.main===module 가드 — 테스트가 이 파일을 import해도 실제 CLI가 자동으로 실행되지
// 않는다(§ runner-supervisor.ts와 동일 관례).
if (require.main === module) {
  main();
}
