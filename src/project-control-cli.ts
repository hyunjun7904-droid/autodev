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
import { loadState } from "./state";
import type { ProjectManifest } from "./project-manifest";
import { selectDefaultApprovalStore } from "./approval-store";
import type { ApprovalStore } from "./approval-store";
import { selectDefaultEventStore } from "./event-store";
import { isApprovalExpired } from "./approval";
import { performLocalHumanApproval } from "./local-human-approval";
import { isCheckpointBlockedMarker } from "./human-gate-policy";

// Genuine Human Gate Local Approval CLI Entrypoint(2026-08-31) — local-human-approval.ts는
// 이미 승인 검증/실행 로직(performLocalHumanApproval)과 그 테스트를 갖고 있었지만, 그
// 함수를 production에서 실제로 호출할 방법이 이 저장소 어디에도 없었다(§ 그 파일 상단
// 주석 — "이 파일을 import하는 production 코드가 없다"). 이 CLI가 그 유일한 빠진 조각이다
// — 새 approval subsystem/state machine/store를 만들지 않는다: performLocalHumanApproval()
// 하나를 그대로 호출할 뿐이고, 이 파일이 새로 추가하는 것은 (1) 실제 파일 기반
// ApprovalStore/EventStore를 이 CLI 실행 컨텍스트에 연결하는 것, (2) 승인 전 확인 정보를
// 사람이 읽을 수 있게 출력하는 순수 포맷 함수 하나뿐이다.
//
// createFreshLocalApprovalRequest()는 이 CLI에서 쓰지 않는다 — 그 함수는 "원본
// ApprovalRequest가 만료/부재할 때 SECURITY_BLOCKED event를 근거로 새 요청을 만드는" 별도
// fallback 경로로 설계됐고(§ local-human-approval.ts 자신의 docstring), CHECKPOINT_SCOPE_
// VIOLATION은 HUMAN_APPROVAL_REQUIRED event로 기록되어 그 fallback의 대상이 아니다. 이
// CLI의 목표(§ 요구사항 0)는 "AutoDev가 이미 만들어 둔 현재의 durable pending approval을
// 승인하는 것"이지 승인 CLI가 승인 대상을 스스로 만들어내는 것이 아니다 — 실제 조사
// 결과(§ run.ts ensureTelegramControllerStarted → telegram-controller.ts tick →
// approval-service.ts createApprovalRequestsFromEvents) production 실행이 이미 자동으로
// durable pending approval을 만들고 있으므로 이 CLI가 fresh request를 만들 필요/근거가
// 없다.
//
// AUTOMATION_DRY_RUN/AUTODEV_PRODUCTION_RUNTIME — telegram-controller-main.ts와 동일한
// 관례(§ 그 파일 상단 주석) — 이 CLI도 사람이 명시적으로 실행하는 real production entry
// point이므로 isProductionRuntime()의 dual-gate를 스스로 선언한다. approve 서브커맨드가
// 실제 파일 기반 ApprovalStore/EventStore(§ approval-store.ts/event-store.ts
// selectDefaultApprovalStore/selectDefaultEventStore의 isProductionRuntime() 분기)를 쓰려면
// 이 선언이 필요하다 — pause/resume/status/stop은 이 값을 전혀 참조하지 않으므로(§
// project-lock.ts/runner-supervisor.ts/dashboard-supervisor.ts 어디도 isProductionRuntime을
// 쓰지 않음) 이 선언을 모든 서브커맨드 앞에 두어도 기존 동작에 영향이 없다.
process.env.AUTOMATION_DRY_RUN = "false";
process.env.AUTODEV_PRODUCTION_RUNTIME = "true";

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

/**
 * approve 실행 전에 사람이 확인해야 할 최소 정보(§ 요구사항 4/7) — 순수 함수, 어떤 상태도
 * 바꾸지 않는다. approvalId로 찾은 ApprovalRequest가 없으면 그 사실만 보여준다(추측하지
 * 않는다) — 실제 승인 가능 여부의 최종 판정은 이 함수가 아니라 performLocalHumanApproval()
 * 하나다(이 출력은 그 판정을 미리 보여주는 참고용일 뿐, 이 함수가 "승인 가능"이라고 표시해도
 * performLocalHumanApproval()이 별도로 거부할 수 있다 — 이중 판정을 만들지 않는다).
 */
export function formatApprovalPreview(
  manifest: Pick<ProjectManifest, "projectId" | "statePath">,
  approvalStore: ApprovalStore,
  approvalId: string,
  taskId: string,
  nowIso: string
): string {
  const lines: string[] = [
    "Human Approval 확인 정보(읽기 전용 미리보기 — 이 출력만으로는 어떤 상태도 바뀌지 않습니다):",
    `  project: ${manifest.projectId}`,
    `  task(입력값): ${taskId}`,
    `  approval id: ${approvalId}`,
  ];
  const approval = approvalStore.get(approvalId);
  if (!approval) {
    lines.push("  → 이 approvalId로 등록된 durable pending approval을 찾을 수 없습니다.");
    return lines.join("\n");
  }
  lines.push(
    `  approval.projectId: ${approval.projectId ?? "(없음)"}`,
    `  approval.taskId: ${approval.taskId ?? "(없음)"}`,
    `  approval type: ${approval.approvalType}`,
    `  approval status: ${approval.status}`,
    `  remotelyApprovable: ${approval.remotelyApprovable}`,
    `  stale(만료됨): ${isApprovalExpired(approval, nowIso)}`
  );
  try {
    const state = loadState(manifest.statePath);
    lines.push(`  현재 project status: ${state.status}`);
    // performLocalHumanApproval()이 실제로 매칭에 쓰는 것과 정확히 같은 판정(§
    // human-gate-policy.ts isCheckpointBlockedMarker)만 재사용한다 — 별도 매칭 로직을 만들지
    // 않는다. 파일 경로 등 이 marker 텍스트 자체는 secret이 아니다(오히려 CHECKPOINT_SCOPE_
    // VIOLATION의 경우 사람이 반드시 봐야 하는 정보다, § 요구사항 10).
    const marker = (state.deferredHumanTasks ?? []).find((m) => isCheckpointBlockedMarker(m) && m.startsWith(`CHECKPOINT_BLOCKED(${taskId}):`));
    lines.push(`  approval reason(현재 blocker marker): ${marker ?? "(일치하는 marker 없음)"}`);
  } catch (e) {
    lines.push(`  현재 project status: 확인 불가(${e instanceof Error ? e.message : String(e)})`);
  }
  return lines.join("\n");
}

function usageAndExit(): never {
  console.error(
    [
      "사용법:",
      "  node dist/project-control-cli.js pause --project <adapterPath> [--reason <text>]",
      "  node dist/project-control-cli.js resume --project <adapterPath>",
      "  node dist/project-control-cli.js status --project <adapterPath>",
      "  node dist/project-control-cli.js stop --project <adapterPath>",
      "  node dist/project-control-cli.js approve --project <adapterPath> --approval-id <id> --task <taskId> --approved-by <name>",
      "      genuine Human Gate(예: CHECKPOINT_SCOPE_VIOLATION)의 이미 존재하는 durable pending",
      "      approval을 승인합니다 — maintenance의 resume과는 완전히 다른 명령입니다. 새 approval을",
      "      만들지 않으며, 이미 존재하는 정확한 approval-id/task가 현재 상태와 일치할 때만 승인됩니다.",
    ].join("\n")
  );
  process.exit(1);
}

async function main(): Promise<void> {
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
    case "approve": {
      // Genuine Human Gate Local Approval(§ 요구사항 0/16) — 이 CLI 실행 자체가 사람의 명시적
      // approval action이다(§ 요구사항 6, "불필요한 두 번째 확인 UI를 새로 만들지 않는다" —
      // 이 명령을 정확한 approval-id/task/approved-by와 함께 실행했다는 사실 자체가 승인
      // 의사표시다, project-control-cli.js stop이 이미 확인 프롬프트 없이 동작하는 것과 동일한
      // 기존 보안 모델). approvalId를 요구해 "현재 WAITING_HUMAN이면 무조건 승인" 형태를
      // 구조적으로 막는다(§ 요구사항 6 명시 금지) — source of truth는 항상 durable
      // ApprovalStore/project-state이고, 사용자가 입력한 값은 그것과 일치하는지 검증용으로만
      // 쓰인다(performLocalHumanApproval 내부에서).
      const approvalId = parseArg(rest, "--approval-id");
      const taskId = parseArg(rest, "--task");
      const approvedBy = parseArg(rest, "--approved-by");
      if (!approvalId || !taskId || !approvedBy) {
        console.error(
          "[project-control] approve에는 --approval-id <id>, --task <taskId>, --approved-by <name>이 모두 필요합니다(단순 '현재 WAITING_HUMAN이면 승인'은 지원하지 않습니다)."
        );
        usageAndExit();
      }

      const manifest = loadProjectAdapter(adapterPath);
      // 실제 파일 기반 store(§ 파일 상단 AUTOMATION_DRY_RUN/AUTODEV_PRODUCTION_RUNTIME 선언이
      // 이를 보장한다) — 이 CLI가 승인 대상을 새로 만들지 않고 telegram-controller.ts의 tick
      // (approval-service.ts createApprovalRequestsFromEvents)이 이미 만들어 둔 durable
      // pending approval을 그대로 찾아 쓴다. AUTODEV_APPROVAL_STORE_PATH/AUTODEV_EVENT_LOG_PATH
      // 는 테스트 전용 격리 override다(지정하지 않으면 selectDefaultApprovalStore/
      // selectDefaultEventStore의 실제 운용 기본 경로 그대로) — approval-store.ts/
      // event-store.ts에 이미 있던 선택적 filePath 매개변수를 그대로 쓸 뿐 새 저장 로직을
      // 만들지 않는다.
      const approvalStore = selectDefaultApprovalStore(process.env.AUTODEV_APPROVAL_STORE_PATH);
      const eventStore = selectDefaultEventStore(process.env.AUTODEV_EVENT_LOG_PATH);

      console.log(formatApprovalPreview(manifest, approvalStore, approvalId, taskId, new Date().toISOString()));

      const result = await performLocalHumanApproval(
        { approvalId, taskId, approvedBy },
        { approvalStore, statePath: manifest.statePath, manifest, events: eventStore, cwd: manifest.targetProjectRoot }
      );

      if (result.kind === "REJECTED") {
        console.log(`[project-control] Human Approval 거부됨(fail-closed) — reason=${result.reason}`);
        console.log("[project-control] 어떤 상태도 변경되지 않았습니다(approval/project-state 모두 그대로입니다).");
        process.exitCode = 1;
        return;
      }

      console.log("[project-control] Human Approval 승인 처리됨 — ApprovalStore: PENDING → APPROVED.");
      if (result.outcome.kind === "COMPLETED") {
        console.log(
          `[project-control] Resume 실행 결과: outcome=${result.outcome.result.outcome}${result.outcome.result.reason ? `, reason=${result.outcome.result.reason}` : ""}`
        );
      } else {
        console.log(`[project-control] Resume이 안전 재확인(Git/Project Lock/Remote Git Safety)에서 보류됨(BLOCKED) — reason=${result.outcome.reason}`);
        console.log(
          "[project-control] project-state.json은 READY로 전환되었습니다 — 다음 정상 실행(run.ts)이 이 task를 다시 안전하게 시도할 수 있습니다."
        );
      }
      try {
        const finalState = loadState(manifest.statePath);
        console.log(`[project-control] 최종 project status=${finalState.status}`);
      } catch (e) {
        console.log(`[project-control] 최종 project status 확인 불가(${e instanceof Error ? e.message : String(e)})`);
      }
      return;
    }
    default:
      usageAndExit();
  }
}

// require.main===module 가드 — 테스트가 이 파일을 import해도 실제 CLI가 자동으로 실행되지
// 않는다(§ runner-supervisor.ts와 동일 관례).
if (require.main === module) {
  main().catch((e) => {
    console.error("[project-control] 처리되지 않은 오류로 종료:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
