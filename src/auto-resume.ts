import { loadState, saveState } from "./state";
import { getCurrentBranch, getCurrentHeadHash } from "./git-changes";
import { runAutodevOnce } from "./autodev";
import type { AutodevRunResult } from "./autodev";
import type { ProjectManifest } from "./project-manifest";
import type { EventStore } from "./event-store";
import type { ApprovalRequest } from "./approval";
import type { OrchestratorDeps } from "./orchestrator";

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
// 이 파일이 실제로 수행하는 재검사 3가지:
//   1) approval.remotelyApprovable 재확인(§ approval-service.ts가 이미 확인했어도 다시
//      확인한다 — "한 곳만 확인하고 다른 경로는 신뢰"하지 않는다).
//   2) Stale-state 재확인(승인 생성 시점과 지금 사이 task가 이미 끝났거나 상태가
//      바뀌었는가).
//   3) Git Safety 재확인(git-changes.ts의 기존 읽기 전용 helper만 재사용 — 새 판정
//      로직을 만들지 않는다). 불일치하면 RESUME_BLOCKED_GIT_STATE로 중단하고, git
//      reset/clean/checkout 등 어떤 "자동 수정"도 시도하지 않는다.
//
// 이 중 하나라도 실패하면 WAITING_HUMAN 상태(state.status)를 그대로 둔 채(변경하지 않고)
// BLOCKED를 반환한다 — 안전한 경우에만 state.status를 "READY"로 바꿔 다음 실행이 이 task를
// 다시 선택할 수 있게 한다.

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

export async function performAutoResume(
  approval: ApprovalRequest,
  manifest: ProjectManifest,
  opts: AutoResumeOptions = {}
): Promise<AutoResumeOutcome> {
  // 1) remotelyApprovable 재확인 — 이 함수의 호출부(approval-service.ts)가 이미 확인했어도
  //    다시 확인한다(fail-closed, 단일 검증 지점에만 의존하지 않는다).
  if (!approval.remotelyApprovable) {
    return { kind: "BLOCKED", reason: "REMOTE_APPROVAL_NOT_ALLOWED" };
  }

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

  // 3) Git Safety 재확인 — 불일치 시 어떤 git 명령도 실행하지 않고 중단한다.
  const gitCheck = checkGitSafeToResume(cwd, approval);
  if (!gitCheck.ok) {
    return { kind: "BLOCKED", reason: gitCheck.reason ?? "RESUME_BLOCKED_GIT_STATE" };
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
    ...(opts.events ? { events: opts.events } : {}),
    ...(opts.orchestratorDeps ? { orchestratorDeps: opts.orchestratorDeps } : {}),
  });
  return { kind: "COMPLETED", result };
}
