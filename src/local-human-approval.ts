import { randomUUID } from "node:crypto";
import { loadState, saveState } from "./state";
import type { ApprovalRequest } from "./approval";
import { buildApprovalRequest, isApprovalExpired } from "./approval";
import type { ApprovalStore } from "./approval-store";
import type { ProjectManifest } from "./project-manifest";
import type { EventStore } from "./event-store";
import type { AutoDevEvent } from "./observability-event";
import type { OrchestratorDeps } from "./orchestrator";
import { resumeApprovedTask } from "./auto-resume";
import type { AutoResumeOutcome } from "./auto-resume";
import { classifyWaitingHumanReason, isNonScopeCheckpointBlockMarker } from "./human-gate-policy";

// Genuine Human Gate Local Approval — AutoDev Core 구조적 결함 수정(2026-08-29).
//
// 배경: approval.ts의 REMOTELY_APPROVABLE_APPROVAL_TYPES는 SECURITY_BLOCKED 등 genuine
// Human Gate를 의도적으로 Telegram 원격 승인 대상에서 제외한다 — "그 판단 자체를 사람이
// 직접 보고 내려야 한다"는 정책이며, 이 파일은 그 정책을 절대 완화하지 않는다(§ 아래
// performLocalHumanApproval이 여전히 remotelyApprovable=false만 처리 대상으로 삼는 이유).
// 문제는 그 반대편에 있었다: 사람이 실제로 로컬(PC)에서 직접 내용을 확인하고 승인을
// 완료했을 때, 그 사실을 ApprovalStore/event log/project-state에 감사 가능하게 반영하며
// Resume까지 이어주는 공식 경로가 코드베이스 어디에도 없었다 — 유일한 실행 경로였던
// auto-resume.ts의 performAutoResume()조차 remotelyApprovable=false를 무조건 거부한다
// (§ 그 파일 주석). 그 결과 실제로 이 상황이 발생하면 project-state.json을 감사 기록 없이
// 직접 고치는 것만 남는 구조였다.
//
// 이 파일이 추가하는 것은 정확히 그 빠진 조각 하나뿐이다 — "이미 사람이 로컬에서 직접
// 확인했다"는 사실을 auto-resume.ts의 기존 공유 로직(resumeApprovedTask — Git Safety/
// Project Lock/Remote Git Safety 재확인 + state.status READY 전환 + runAutodevOnce() 재
// 호출)에 안전하게 연결하는 것. 새로운 두 번째 Resume 실행 경로를 만들지 않는다.
//
// 호출 경계 — 이 함수들은 어떤 자동 코드 경로(orchestrator.ts/autodev.ts/continuous-
// runner.ts/telegram-controller.ts)에서도 호출되지 않는다. 이 파일을 import하는 production
// 코드가 없다는 사실 자체가 "자동 승인 경로가 아니다"를 구조적으로 보장한다 — 실제 호출은
// 사람이 명시적으로 실행하는 별도 스크립트/CLI(이 Task 범위 밖, 이 파일은 그 진입점이
// 호출할 함수만 제공한다)에서만 이뤄져야 한다.

export interface LocalHumanApprovalInput {
  approvalId: string;
  taskId: string;
  /** 이 승인을 수행한 사람을 감사 기록에 식별 가능하게 남긴다 — 빈 문자열/공백만으로는
   *  승인 주체를 식별했다고 보지 않는다(§ 요구사항 "승인 주체 식별 가능 기록"). */
  approvedBy: string;
}

export interface LocalHumanApprovalOptions {
  approvalStore: ApprovalStore;
  statePath: string;
  manifest: ProjectManifest;
  events?: EventStore;
  now?: () => Date;
  orchestratorDeps?: OrchestratorDeps;
  cwd?: string;
}

export type LocalHumanApprovalRejectionReason =
  | "APPROVED_BY_REQUIRED"
  | "APPROVAL_NOT_FOUND"
  | "PROJECT_MISMATCH"
  | "TASK_MISMATCH"
  | "APPROVAL_ALREADY_CONSUMED"
  | "APPROVAL_EXPIRED"
  | "NOT_A_LOCAL_APPROVAL_TARGET"
  | "STATE_NOT_WAITING_HUMAN"
  | "NOT_A_GENUINE_HUMAN_GATE"
  | "NO_MATCHING_BLOCK_MARKER_FOR_TASK";

export type LocalHumanApprovalResult =
  | { kind: "RESUMED"; outcome: AutoResumeOutcome }
  | { kind: "REJECTED"; reason: LocalHumanApprovalRejectionReason };

/**
 * 사람이 로컬에서 이미 직접 확인/승인을 마친 remotelyApprovable=false genuine Human Gate를
 * 감사 가능하게 해제하고 Resume까지 진행한다. 검증(요구사항 1~9)을 전부 통과해야만 실제
 * ApprovalStore 전이/이벤트 기록/state 변경이 시작된다 — 하나라도 실패하면 어떤 상태도
 * 바뀌지 않고 REJECTED만 반환한다(부분 적용 없음).
 */
export async function performLocalHumanApproval(
  input: LocalHumanApprovalInput,
  opts: LocalHumanApprovalOptions
): Promise<LocalHumanApprovalResult> {
  if (!input.approvedBy || input.approvedBy.trim().length === 0) {
    return { kind: "REJECTED", reason: "APPROVED_BY_REQUIRED" };
  }

  // 1) ApprovalRequest가 실제 존재.
  const approval = opts.approvalStore.get(input.approvalId);
  if (!approval) return { kind: "REJECTED", reason: "APPROVAL_NOT_FOUND" };

  // ApprovalStore는 프로젝트 전체가 공유하는 단일 저장소다(logs/approvals.json) — taskId
  // 하나만으로는 다른 project의 동일 taskId 요청과 혼동될 수 있어 projectId도 함께 확인한다.
  if (approval.projectId !== opts.manifest.projectId) {
    return { kind: "REJECTED", reason: "PROJECT_MISMATCH" };
  }
  // 2) 대상 Task 일치. 7) 다른 Task의 오래된 ApprovalRequest를 승인하지 않음.
  if (approval.taskId !== input.taskId) {
    return { kind: "REJECTED", reason: "TASK_MISMATCH" };
  }
  // 6) 이미 승인/거절된 요청을 중복 처리하지 않음.
  if (approval.status !== "PENDING") {
    return { kind: "REJECTED", reason: "APPROVAL_ALREADY_CONSUMED" };
  }
  // 이 경로는 remotelyApprovable=false 전용이다 — 원격 승인 가능한 요청은 반드시 기존
  // Telegram/performAutoResume 경로로만 처리되어야 한다(§ 요구사항: SECURITY_BLOCKED를
  // 원격 승인 가능하게 만들지 마라 — 이 검사는 그 반대 방향, "원격 가능한 걸 이 경로로
  // 몰래 처리하지 않는다"를 보장한다).
  if (approval.remotelyApprovable) {
    return { kind: "REJECTED", reason: "NOT_A_LOCAL_APPROVAL_TARGET" };
  }

  const nowDate = opts.now ? opts.now() : new Date();
  const nowIso = nowDate.toISOString();
  // 만료된 요청은 절대 소생시키지 않는다(§ 요구사항) — 기존 만료 정책(approval.ts
  // isApprovalExpired)을 그대로 재사용한다, 새 만료 판정을 만들지 않는다.
  if (isApprovalExpired(approval, nowIso)) {
    return { kind: "REJECTED", reason: "APPROVAL_EXPIRED" };
  }

  // 3)/5) 현재 project-state가 실제 WAITING_HUMAN이고, 현재 차단 사유가 이 ApprovalRequest와
  // 일치하는지 확인한다. 4) state.status 확인은 여기서 이뤄진다.
  const state = loadState(opts.statePath);
  if ((state.status as unknown as string) !== "WAITING_HUMAN") {
    return { kind: "REJECTED", reason: "STATE_NOT_WAITING_HUMAN" };
  }
  // 8) 승인 대상이 Genuine Human Gate인지 확인 — human-gate-policy.ts의 canonical 판정을
  // 그대로 재사용한다(새 genuine/technical 분류 로직을 만들지 않는다). 기술적 자동 복구
  // 대상이면(REVIEW_CYCLE_EXHAUSTED 등 이미 자체적으로 재시도되는 것들) 이 경로로 임의
  // 승인할 수 없다 — 그런 상태는 애초에 사람 승인 없이 자동으로 풀려야 한다.
  if (classifyWaitingHumanReason(state) !== "GENUINE_HUMAN_JUDGMENT") {
    return { kind: "REJECTED", reason: "NOT_A_GENUINE_HUMAN_GATE" };
  }

  // deferredHumanTasks 안에서 "이 taskId의, scope-violation이 아닌 CHECKPOINT_BLOCKED
  // 마커"를 찾는다 — SECURITY_BLOCKED(Secret/Dependency Scanner Gate)와 그 외 checkpoint
  // 차단(scope-violation 제외)이 실제로 쓰는 마커 형식과 정확히 같다(§ autodev.ts checkpoint
  // 실패 분기, human-gate-policy.ts isNonScopeCheckpointBlockMarker). 이 마커가 없으면
  // "지금 실제로 막혀 있는 사유"와 이 ApprovalRequest가 대응하지 않는다는 뜻이므로 승인하지
  // 않는다(§ 요구사항 5 "현재 차단 사유와 ApprovalRequest가 일치").
  //
  // 현재 지원 범위: CHECKPOINT_BLOCKED 계열(SECURITY_BLOCKED 등)만 정확히 마커 매칭한다.
  // REVIEW_CYCLE_EXHAUSTED/REVIEW_BLOCKED 등 다른 genuine 마커 형식으로의 확장은 이번
  // 변경 범위 밖이다(필요한 최소 변경 원칙) — 지원하지 않는 approvalType은 아래에서
  // 명시적으로 거부되며 추측하지 않는다.
  const checkpointBlockedPrefix = `CHECKPOINT_BLOCKED(${input.taskId}):`;
  const matchingMarker = (state.deferredHumanTasks ?? []).find(
    (m) => isNonScopeCheckpointBlockMarker(m) && m.startsWith(checkpointBlockedPrefix)
  );
  if (!matchingMarker) {
    return { kind: "REJECTED", reason: "NO_MATCHING_BLOCK_MARKER_FOR_TASK" };
  }

  // 9) 여기까지 전부 통과해야만 상태 변경이 시작된다 — 자동 코드 경로는 이 함수를 호출하지
  // 않으므로(이 파일을 import하는 production 코드가 없다), 여기 도달했다는 사실 자체가
  // 이미 "명시적인 로컬 인간 승인 입력"을 의미한다.

  // ApprovalStore: PENDING → APPROVED (Telegram 경로와 동일한 단일 CAS 메서드 재사용 —
  // 새 전이 로직을 만들지 않는다).
  const transitioned = opts.approvalStore.transition(input.approvalId, "APPROVED", nowIso);
  if (!transitioned.ok) {
    // 검증 시점과 전이 시점 사이에 이미 다른 경로로 소비됐다(동시 처리) — 조용히 성공으로
    // 위장하지 않는다.
    return { kind: "REJECTED", reason: "APPROVAL_ALREADY_CONSUMED" };
  }

  // 감사/event log — 사람이 언제 어떤 Gate를 승인했는지, 그리고 그것이 Telegram이 아닌
  // 로컬 인간 승인이었다는 사실(승인 주체 포함)을 기록한다. eventType은 Telegram 경로와
  // 동일한 것을 재사용하고(§ observability-event.ts, 새 eventType을 만들지 않는다),
  // metadata로만 경로를 구분한다.
  opts.events?.append({
    eventType: "APPROVAL_APPROVED",
    runId: approval.runId,
    projectId: approval.projectId,
    taskId: approval.taskId,
    executionPhase: "review",
    outcome: "SUCCESS",
    metadata: { approvedVia: "LOCAL_HUMAN", approvedBy: input.approvedBy, approvalId: approval.approvalId },
  });
  opts.events?.append({
    eventType: "AUTO_RESUME_STARTED",
    runId: approval.runId,
    projectId: approval.projectId,
    taskId: approval.taskId,
    executionPhase: "review",
    outcome: "PENDING",
    metadata: { approvedVia: "LOCAL_HUMAN" },
  });

  // 지금 해결된 마커만 정확히 제거한다 — 다른 deferredHumanTasks(다른 task/다른 사유)는
  // 절대 건드리지 않는다(§ 요구사항: "다른 deferredHumanTasks가 있다면 무조건 전체 삭제하지
  // 마라"). status는 아직 WAITING_HUMAN으로 남겨둔다 — resumeApprovedTask()가 자신의
  // stale-state 재확인(state.status==="WAITING_HUMAN" 요구)을 통과해야 하기 때문이다.
  const afterMarkerRemoval = loadState(opts.statePath);
  afterMarkerRemoval.deferredHumanTasks = (afterMarkerRemoval.deferredHumanTasks ?? []).filter((m) => m !== matchingMarker);
  saveState(afterMarkerRemoval, opts.statePath);

  // 실제 Resume 실행 — auto-resume.ts의 공유 로직을 그대로 재사용한다(Git Safety/Project
  // Lock/Remote Git Safety 재확인 + state.status READY 전환 + runAutodevOnce() 재호출을
  // 이 파일에서 복제하지 않는다). ownerKind만 "local-human-approval"로 구분해 project-lock
  // metadata에서 이 재개가 어느 경로로 시작됐는지 알 수 있게 한다.
  const outcome = await resumeApprovedTask(approval, opts.manifest, {
    statePath: opts.statePath,
    cwd: opts.cwd,
    events: opts.events,
    orchestratorDeps: opts.orchestratorDeps,
    lockOwnerKind: "local-human-approval",
  });

  if (outcome.kind === "BLOCKED") {
    // resumeApprovedTask()는 Project Lock/Remote Git Safety 사전 재확인이 실패하면 자신의
    // READY 전환 지점(그 함수 안에서 Git Safety 다음, 이 두 확인 이후)에 도달하기도 전에
    // BLOCKED를 반환한다(§ 실제 production 사례 — 이 gate를 만든 원래 프로세스 자신이 아직
    // 살아서 lock을 들고 있는 동안 로컬 승인을 먼저 처리하는 경우). 그 경우 여기서 status를
    // WAITING_HUMAN으로 그대로 두면 "마커는 이미 없는데 여전히 WAITING_HUMAN"이라는 모호한
    // 상태가 되고, human-gate-policy.ts의 classifyWaitingHumanReason()은 알려진 마커가
    // 하나도 없으면 fail-closed로 다시 GENUINE_HUMAN_JUDGMENT를 반환하므로(§ 그 파일의
    // 마지막 fallback) 나중에 lock을 쥔 프로세스가 내려가고 새 프로세스가 떠도 자동으로
    // 재개되지 않는다. 이미 사람이 직접 승인을 완료한 시점(바로 위)에 이 판단 자체는
    // 확정됐으므로, project lock/remote git safety 사전 확인 결과와 무관하게 여기서 READY로
    // 전환해 다음 실행(재시작된 runner child든, 나중의 재시도든)이 정상적으로 이 task를 다시
    // 선택하게 한다. "정말 안전한지"는 여전히 runAutodevOnce() 내부의 authoritative Gate가
    // 재실행 시점에 다시 검증한다(§ 이 파일 전체의 원칙 — 이 함수는 그 Gate를 대신하지
    // 않는다) — 여기서 READY로 전환해도 그 Gate 자체를 우회하지 않는다. COMPLETED인
    // 경우에는 resumeApprovedTask()/runAutodevOnce()가 이미 state를 완전히 관리했으므로
    // 이 블록에서 더 손댈 것이 없다.
    const afterBlockedResume = loadState(opts.statePath);
    if ((afterBlockedResume.status as unknown as string) === "WAITING_HUMAN") {
      afterBlockedResume.status = "READY";
      saveState(afterBlockedResume, opts.statePath);
    }
    opts.events?.append({
      eventType: "AUTO_RESUME_BLOCKED",
      runId: approval.runId,
      projectId: approval.projectId,
      taskId: approval.taskId,
      executionPhase: "review",
      outcome: "BLOCKED",
      reason: outcome.reason,
      metadata: { approvedVia: "LOCAL_HUMAN" },
    });
  }

  return { kind: "RESUMED", outcome };
}

// ---------------------------------------------------------------------------
// 만료되었거나 아예 존재하지 않는 ApprovalRequest 처리 — 오래된 요청을 억지로 소생시키지
// 않는다(§ 요구사항). 대신 "지금 실제로 project-state.json을 막고 있는 사유"를 나타내는
// 가장 최근 event를 근거로 완전히 새로운 ApprovalRequest를 정식으로 생성한다.
// ---------------------------------------------------------------------------

export type CreateFreshLocalApprovalRejectionReason =
  | "STATE_NOT_WAITING_HUMAN"
  | "NOT_A_GENUINE_HUMAN_GATE"
  | "NO_MATCHING_BLOCK_MARKER_FOR_TASK"
  | "NO_MATCHING_EVENT_FOUND";

export type CreateFreshLocalApprovalResult =
  | { kind: "CREATED"; approval: ApprovalRequest }
  | { kind: "REJECTED"; reason: CreateFreshLocalApprovalRejectionReason };

/**
 * 현재 project-state.json이 실제로 WAITING_HUMAN + genuine이고, 그 사유에 정확히 대응하는
 * SECURITY_BLOCKED류 event가 event log에 남아있을 때만 새 ApprovalRequest를 만든다 — 아무
 * event나 추측해서 새로 만들지 않는다. dedupeKey에 매 호출 고유 suffix를 붙여
 * ApprovalStore.createPending()의 기존 dedupeKey 기반 idempotency(§ approval-store.ts —
 * "같은 dedupeKey면 항상 기존 레코드를 반환")가 만료된 원본 레코드를 그대로 돌려주지 않고
 * 실제로 새 레코드(새 approvalId, 새 expiresAt)를 만들도록 한다 — 원본 레코드 자체는 전혀
 * 건드리지 않는다(만료 상태 그대로 남는다).
 */
export function createFreshLocalApprovalRequest(
  taskId: string,
  opts: { approvalStore: ApprovalStore; statePath: string; manifest: ProjectManifest; events: EventStore; now?: () => Date }
): CreateFreshLocalApprovalResult {
  const state = loadState(opts.statePath);
  if ((state.status as unknown as string) !== "WAITING_HUMAN") {
    return { kind: "REJECTED", reason: "STATE_NOT_WAITING_HUMAN" };
  }
  if (classifyWaitingHumanReason(state) !== "GENUINE_HUMAN_JUDGMENT") {
    return { kind: "REJECTED", reason: "NOT_A_GENUINE_HUMAN_GATE" };
  }
  const checkpointBlockedPrefix = `CHECKPOINT_BLOCKED(${taskId}):`;
  const matchingMarker = (state.deferredHumanTasks ?? []).find(
    (m) => isNonScopeCheckpointBlockMarker(m) && m.startsWith(checkpointBlockedPrefix)
  );
  if (!matchingMarker) {
    return { kind: "REJECTED", reason: "NO_MATCHING_BLOCK_MARKER_FOR_TASK" };
  }

  // 이 taskId에 대해 가장 최근에 기록된 SECURITY_BLOCKED event를 근거 event로 삼는다 —
  // deferredHumanTasks 마커 하나만으로는(§ 위) 텍스트 재현일 뿐, 실제 event log에 대응하는
  // 근거가 있어야 "추측이 아니다".
  const candidates: AutoDevEvent[] = opts.events
    .query({ taskId })
    .events.filter((e) => e.eventType === "SECURITY_BLOCKED")
    .sort((a, b) => b.sequence - a.sequence);
  const sourceEvent = candidates[0];
  if (!sourceEvent) {
    return { kind: "REJECTED", reason: "NO_MATCHING_EVENT_FOUND" };
  }

  const nowFn = opts.now ?? (() => new Date());
  const freshDedupeKey = `${sourceEvent.runId}::${taskId}::${sourceEvent.eventType}::LOCAL_HUMAN::${randomUUID()}`;
  const built = buildApprovalRequest(sourceEvent, freshDedupeKey, { now: nowFn });
  const created = opts.approvalStore.createPending(built);
  return { kind: "CREATED", approval: created };
}
