import { loadState, saveState } from "./state";
import { getCurrentBranch, getCurrentHeadHash } from "./git-changes";
import { runAutodevOnce } from "./autodev";
import type { AutodevRunResult } from "./autodev";
import { resolveRemoteGitSafetyPolicy } from "./project-manifest";
import type { ProjectManifest } from "./project-manifest";
import type { EventStore } from "./event-store";
import type { ApprovalRequest } from "./approval";
import type { OrchestratorDeps } from "./orchestrator";
import { peekProjectLock } from "./project-lock";
import type { ProjectLockOwnerKind } from "./project-lock";
import { checkRemoteSafeToStart } from "./remote-git-safety";

// Safe Auto Resume — Phase G Task G6.
//
// "Telegram에서 APPROVE를 눌렀다"는 사람의 의사표시 하나일 뿐이다 — 최종 실행 여부는 여기서
// 다시 판단한다. 이 파일은 새로운 두 번째 Developer/Reviewer loop를 만들지 않는다 —
// runAutodevOnce()(autodev.ts, 기존 production entrypoint)를 그대로 다시 호출할 뿐이다.
// decideNextAction()(autodev.ts)이 완료되지 않은 task를 completedTasks에서 찾아 다시
// 선택하므로, "resume"의 실제 의미는 "이 task를 Security/Test/Review Gate를 전부 다시
// 거쳐 처음부터 재시도한다"이지, 어떤 Gate도 건너뛰는 것이 아니다(§ 요구사항: Auto Resume은
// 어떤 Gate도 우회하지 않는다 — approval.ts의 REMOTELY_APPROVABLE_APPROVAL_TYPES가
// ORCHESTRATOR_NOT_APPROVED_GENERIC만 허용하는 이유이기도 하다).
//
// 이 파일이 실제로 수행하는 재검사:
//   1) approval.remotelyApprovable 재확인(§ approval-service.ts가 이미 확인했어도 다시
//      확인한다 — "한 곳만 확인하고 다른 경로는 신뢰"하지 않는다).
//   2) Stale-state 재확인(승인 생성 시점과 지금 사이 task가 이미 끝났거나 상태가
//      바뀌었는가).
//   3) Git Safety 재확인(git-changes.ts의 기존 읽기 전용 helper만 재사용 — 새 판정
//      로직을 만들지 않는다). 불일치하면 RESUME_BLOCKED_GIT_STATE로 중단하고, git
//      reset/clean/checkout 등 어떤 "자동 수정"도 시도하지 않는다.
//   4) Phase G Task G7 — Project Lock 재확인(peekProjectLock, project-lock.ts). Telegram
//      APPROVE 자체는 lock override 권한이 아니다 — 이 project를 지금 다른 프로세스가 이미
//      쓰고 있다면(예: PC에서 AutoDev가 같은 project를 이미 수정 중) 아래 state.status
//      READY 전환조차 시도하지 않고 즉시 BLOCKED로 중단한다. 이 함수는 lock을 만들거나
//      지우지 않는 읽기 전용 사전 확인일 뿐이다 — 실제 원자적 acquire/release는 여전히
//      runAutodevOnce() 하나(project-lock.ts를 직접 쓰는 유일한 지점)가 전담한다(§ 요구사항
//      14, 두 실행 경로가 서로 다른 lock 구현을 갖지 않는다). Telegram callback에는 lock을
//      강제로 삭제/탈취하는 기능이 없다(§ 요구사항 11).
//   5) Remote Git Safety 사전 재확인(checkRemoteSafeToStart, remote-git-safety.ts) —
//      manifest.remoteGitSafety가 지정된 project에서만 활성화된다(§ project-manifest.ts,
//      지정하지 않으면 완전히 no-op). Project Lock 사전 확인과 동일한 원칙 — remote가 이미
//      앞서 있다면 아래 state.status READY 전환조차 시도하지 않고 즉시 BLOCKED로 중단한다.
//      이 사전 확인이 없으면(2026-08-26 Human Resume + Continuous Runner regression 조사에서
//      실제로 재현/증명함): state.status를 READY로 먼저 써둔 뒤 runAutodevOnce() 내부의
//      authoritative Remote Git Safety Gate가 BLOCKED_REMOTE_GIT을 반환해도 그 분기는
//      state.json을 다시 읽거나 쓰지 않으므로(§ autodev.ts), WAITING_HUMAN이 사람의 재확인
//      없이 다음 실행이 자동으로 진행할 수 있는 "READY" 상태로 orphan된다. 이 사전 확인도
//      Project Lock peek과 마찬가지로 최종 판정이 아니다 — 통과해도 그 사이 remote가 다시
//      바뀔 수 있고, 그 최종 승부는 여전히 runAutodevOnce() 내부의 authoritative Gate가
//      가른다(새 판정 로직을 만들지 않음 — checkRemoteSafeToStart()를 그대로 재사용).
//
// 이 중 하나라도 실패하면 WAITING_HUMAN 상태(state.status)를 그대로 둔 채(변경하지 않고)
// BLOCKED를 반환한다 — 안전한 경우에만 state.status를 "READY"로 바꿔 다음 실행이 이 task를
// 다시 선택할 수 있게 한다.
//
// Genuine Human Gate Local Approval(2026-08-29) — 위 2)~5) 재검사와 READY 전환 +
// runAutodevOnce() 재호출 로직은 resumeApprovedTask()(아래)로 분리했다. performAutoResume()
// (여전히 이 파일의 유일한 공개 Telegram 경로, 동작 변화 없음)은 1) remotelyApprovable
// 재확인만 자신이 하고 나머지는 그 함수에 위임한다. local-human-approval.ts는 완전히 다른
// 승인 정책(로컬 인간이 직접 확인한 genuine Human Gate만, remotelyApprovable=false 전용)을
// 자신이 검증한 뒤 이 파일의 resumeApprovedTask()만 재사용한다 — performAutoResume()을
// 호출하지 않으므로 그 함수의 remotelyApprovable=false 거부를 우회하는 경로가 아니다(호출
// 그래프 자체가 다르다).

export type AutoResumeOutcome = { kind: "COMPLETED"; result: AutodevRunResult } | { kind: "BLOCKED"; reason: string };

export interface AutoResumeOptions {
  statePath?: string;
  cwd?: string;
  events?: EventStore;
  /** 테스트 전용 — runAutodevOnce()의 orchestratorDeps를 그대로 통과시켜 실제 Claude CLI/
   *  OpenAI API를 호출하지 않고도 COMPLETED 분기를 검증할 수 있게 한다(§ autodev.ts
   *  AutodevRunOptions.orchestratorDeps와 동일한 테스트 seam — 새 seam을 만들지 않는다).
   *  production 호출부(approval-service.ts)는 이 필드를 지정하지 않는다 — 지정하지 않으면
   *  runAutodevOnce()가 기존과 동일하게 실제 Claude Developer/GPT Reviewer를 그대로 쓴다
   *  (production 동작 변화 없음). */
  orchestratorDeps?: OrchestratorDeps;
  /** Genuine Human Gate Local Approval(2026-08-29) — project-lock.ts metadata에 남는
   *  ownerKind. 지정하지 않으면 이 파일의 기존 동작(performAutoResume, "telegram-resume")을
   *  그대로 유지한다 — local-human-approval.ts만 명시적으로 "local-human-approval"을
   *  넘긴다. */
  lockOwnerKind?: ProjectLockOwnerKind;
}

export interface GitSafetyExpectation {
  expectedGitHead?: string;
  expectedBranch?: string;
}

/** git-changes.ts의 읽기 전용 getCurrentHeadHash()/getCurrentBranch()만 재사용한다 — 새
 *  git 판정 로직을 이 파일에서 새로 만들지 않는다. 값을 알 수 없으면(예: HEAD 조회 실패)
 *  "모르면 진행하지 않는다" 원칙에 따라 안전하지 않은 것으로 취급한다. */
export function checkGitSafeToResume(cwd: string, expectation: GitSafetyExpectation): { ok: boolean; reason?: string } {
  if (expectation.expectedGitHead !== undefined) {
    const currentHead = getCurrentHeadHash(cwd);
    if (currentHead === undefined) return { ok: false, reason: "RESUME_BLOCKED_GIT_STATE_HEAD_UNKNOWN" };
    if (currentHead !== expectation.expectedGitHead) return { ok: false, reason: "RESUME_BLOCKED_GIT_STATE_DIVERGED" };
  }
  if (expectation.expectedBranch !== undefined) {
    const currentBranch = getCurrentBranch(cwd);
    if (currentBranch === undefined) return { ok: false, reason: "RESUME_BLOCKED_GIT_STATE_BRANCH_UNKNOWN" };
    if (currentBranch !== expectation.expectedBranch) return { ok: false, reason: "RESUME_BLOCKED_GIT_STATE_BRANCH_CHANGED" };
  }
  return { ok: true };
}

/**
 * Genuine Human Gate Local Approval(2026-08-29) — 이 함수는 원래 performAutoResume() 본문
 * 전체(remotelyApprovable 재확인 이후 부분)였다. Telegram 경로(performAutoResume, 아래)와
 * 로컬 인간 승인 경로(local-human-approval.ts) 둘 다 "이미 승인이 확정된 approval을 실제로
 * 재개한다"는 이 부분을 그대로 공유한다 — Git Safety/Project Lock/Remote Git Safety 재확인
 * + state.status READY 전환 + runAutodevOnce() 재호출 로직을 두 곳에 복제하지 않는다. 이
 * 함수 자신은 remotelyApprovable을 확인하지 않는다 — "이 approval을 지금 재개해도 되는가"는
 * 호출부(원격 정책 vs 로컬 인간 승인 정책)의 책임이고, 이 함수는 그 판단이 이미 끝났다고
 * 가정한 뒤의 공통 실행 로직만 담당한다.
 */
export async function resumeApprovedTask(
  approval: ApprovalRequest,
  manifest: ProjectManifest,
  opts: AutoResumeOptions = {}
): Promise<AutoResumeOutcome> {
  const statePath = opts.statePath ?? manifest.statePath;
  const cwd = opts.cwd ?? manifest.targetProjectRoot;

  // 2) Stale-state 재확인.
  const state = loadState(statePath);
  if (approval.taskId && (state.completedTasks ?? []).includes(approval.taskId)) {
    return { kind: "BLOCKED", reason: "STALE_APPROVAL_TASK_ALREADY_COMPLETED" };
  }
  if ((state.status as unknown as string) !== "WAITING_HUMAN") {
    return { kind: "BLOCKED", reason: `STALE_APPROVAL_UNEXPECTED_STATE(${state.status})` };
  }
  // Minimal HUMAN_FINAL_REVIEW Runtime Checkpoint Gate와의 경계 — 이 WAITING_HUMAN이 실제로는
  // "reviewer가 이미 APPROVED했고 사람의 최종 승인만 기다리는 중"이라면(§ autodev.ts
  // decideNextAction의 humanFinalReview gate), 이 함수(옛 Auto Resume — "처음부터 다시
  // 시도한다"는 의미, § 파일 상단 주석)가 아래에서 status를 "READY"로 되돌려 developer/
  // reviewer를 처음부터 재실행하면 안 된다 — 이미 나온 reviewer 승인 결과를 버리고 불필요하게
  // 재실행하는 것이며, 승인 대기 중인 gate를 조용히 우회하는 결과가 된다(§ 요구사항 8 —
  // Developer/Reviewer 재실행 금지). approveHumanFinalReview()를 통해서만 이 gate를 넘길 수
  // 있다 — 이 함수는 그 경로가 아니므로 fail-closed로 거부한다.
  if (state.humanFinalReview) {
    return { kind: "BLOCKED", reason: "HUMAN_FINAL_REVIEW_GATE_PENDING" };
  }

  // 3) Git Safety 재확인 — 불일치 시 어떤 git 명령도 실행하지 않고 중단한다.
  const gitCheck = checkGitSafeToResume(cwd, approval);
  if (!gitCheck.ok) {
    return { kind: "BLOCKED", reason: gitCheck.reason ?? "RESUME_BLOCKED_GIT_STATE" };
  }

  // 4) Project Lock 재확인 — 아래 state.status READY 전환(쓰기)조차 다른 살아있는 owner가
  //    있다면 시도하지 않는다(§ 요구사항 10/21). 이 peek이 통과해도 그 사이 다른 프로세스가
  //    먼저 실제 lock을 잡을 수 있다 — 그 최종 승부는 runAutodevOnce()의 원자적 acquire가
  //    가른다(이 함수는 그 결과를 그대로 BLOCKED로 반환할 뿐, 여기서 다시 판정하지 않는다).
  const lockPeek = peekProjectLock(manifest.projectId, manifest.targetProjectRoot);
  if (lockPeek.locked) {
    return { kind: "BLOCKED", reason: `PROJECT_ALREADY_LOCKED: ${lockPeek.reason}` };
  }

  // 5) Remote Git Safety 사전 재확인 — Project Lock peek과 동일한 원칙으로, 아래
  //    state.status READY 전환(쓰기)조차 remote가 이미 앞서 있다면 시도하지 않는다. 이
  //    사전 확인이 없으면 runAutodevOnce()의 authoritative Gate가 BLOCKED_REMOTE_GIT을
  //    반환해도 state.json을 다시 건드리지 않아 WAITING_HUMAN이 READY로 orphan된다(§ 파일
  //    상단 주석 5)).
  if (manifest.remoteGitSafety) {
    const remotePreCheck = checkRemoteSafeToStart(cwd, resolveRemoteGitSafetyPolicy(manifest.remoteGitSafety));
    if (!remotePreCheck.ok) {
      return { kind: "BLOCKED", reason: `REMOTE_GIT_BLOCKED: ${remotePreCheck.reason}` };
    }
  }

  // 안전 확인 완료 — WAITING_HUMAN을 벗어나 decideNextAction()이 이 미완료 task를 다시
  // 선택할 수 있게 한다(autodev.ts가 task 완료 후 다음 task를 고를 때 쓰는 것과 동일한
  // "READY" marker — 새 상태 값을 만들지 않는다).
  const cleared = loadState(statePath);
  cleared.status = "READY";
  saveState(cleared, statePath);

  const result = await runAutodevOnce({
    manifest,
    statePath,
    cwd,
    lockOwnerKind: opts.lockOwnerKind ?? "telegram-resume",
    ...(opts.events ? { events: opts.events } : {}),
    ...(opts.orchestratorDeps ? { orchestratorDeps: opts.orchestratorDeps } : {}),
  });
  if (result.outcome === "BLOCKED_PROJECT_LOCK") {
    return { kind: "BLOCKED", reason: `PROJECT_ALREADY_LOCKED: ${result.reason ?? ""}` };
  }
  // Phase G Task G7.3 — Telegram APPROVE는 Remote Git Safety를 우회하지 않는다(§ 요구사항
  // 10). runAutodevOnce()가 이미 Project Lock 다음에 이 Gate를 통과해야만 실제 실행을
  // 시작하므로, 이 함수는 그 결과를 그대로 BLOCKED로 반영할 뿐 여기서 다시 판정하지 않는다
  // (§ Project Lock 재확인과 동일한 원칙 — 단일 판정 출처는 여전히 runAutodevOnce() 하나).
  if (result.outcome === "BLOCKED_REMOTE_GIT") {
    return { kind: "BLOCKED", reason: `REMOTE_GIT_BLOCKED: ${result.reason ?? ""}` };
  }
  return { kind: "COMPLETED", result };
}

/** Telegram 원격 승인 경로 — 기존 동작을 정확히 그대로 유지한다(remotelyApprovable=false는
 *  무조건 거부, 그 외에는 resumeApprovedTask()의 공통 로직을 그대로 통과시킨다). 이 함수의
 *  외부 시그니처/동작은 이번 변경으로 전혀 바뀌지 않았다 — 본문만 공통 로직으로 위임한다. */
export async function performAutoResume(
  approval: ApprovalRequest,
  manifest: ProjectManifest,
  opts: AutoResumeOptions = {}
): Promise<AutoResumeOutcome> {
  // remotelyApprovable 재확인 — 이 함수의 호출부(approval-service.ts)가 이미 확인했어도
  // 다시 확인한다(fail-closed, 단일 검증 지점에만 의존하지 않는다). 이 검사는 절대 완화하지
  // 않는다 — local-human-approval.ts는 이 함수를 호출하지 않고 resumeApprovedTask()를
  // 별도로 호출하므로, 이 게이트를 우회할 방법이 없다.
  if (!approval.remotelyApprovable) {
    return { kind: "BLOCKED", reason: "REMOTE_APPROVAL_NOT_ALLOWED" };
  }
  return resumeApprovedTask(approval, manifest, opts);
}
