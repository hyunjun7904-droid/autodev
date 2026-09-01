import { relative, sep, join } from "node:path";
import { loadState, saveState } from "./state";
import { runOrchestrator } from "./orchestrator";
import type { OrchestratorDeps } from "./orchestrator";
import { runDeveloperTaskWithRetry, buildDiscoveryProgressRetryHint, buildNoWriteStrategyEscalationHint } from "./claude-developer";
import type { DeveloperProjectContext, DeveloperTaskOptions, DeveloperContextMetrics } from "./claude-developer";
import { reviewClaudeResult as realReviewClaudeResult } from "./gpt-reviewer";
import type { ReviewProjectContext } from "./gpt-reviewer";
import { wrapGptReviewerWithFireworksCallLimiter, MAX_SAME_FAILURE_LOCAL_DEVELOPER_CALLS } from "./root-cause-analysis";
import type { RootCauseAnalysisEvent } from "./root-cause-analysis";
import { loadDurableFailureStateForTask, resolveDurableFailureStateForReviewer, clearDurableFailureState } from "./durable-recovery-state";
import { getNextTask, PLAN_MARKERS } from "./task-registry";
import type { TaskDefinition } from "./task-registry";
import { validateProjectManifest, resolveRemoteGitSafetyPolicy, isHumanFinalReviewEnabled } from "./project-manifest";
import type { ProjectManifest } from "./project-manifest";
import { checkRemoteSafeToStart, checkRemoteUnchangedSince } from "./remote-git-safety";
import type { RemoteGitSnapshot } from "./remote-git-safety";
import { createSafeExecutorContext } from "./safe-executor";
import { performTaskCheckpoint, commitProjectStateOnly } from "./checkpoint";
import type { CheckpointOutcome } from "./checkpoint";
import { buildAdvisoryRoutingPlan } from "./agent-registry";
import type { AdvisorySignals } from "./agent-registry";
import { executeRoutingPlan } from "./agent-orchestrator";
import type { AgentStepResult, ReadOnlyAgentRunner } from "./agent-orchestrator";
import { classifyTaskRisk, requiresHumanApproval } from "./policy";
import {
  checkRequiredTestScriptRegistration,
  attemptSafeRequiredTestScriptRepair,
  commitRequiredTestScriptRepair,
  reconcileStaleRequiredTestConfigurationTasks,
  checkRequiredTestExecutionEnvironment,
  reconcileStaleRequiredTestExecutionEnvironmentTasks,
} from "./required-test-preflight";
import { hasFailedRequiredTest } from "./review-policy";
import { validateRequiredTestExecutionContract } from "./execution-contract";
import { buildDiagnosticEvidenceBundle } from "./diagnostic-evidence-bundle";
import {
  computeProblemFingerprint,
  classifyFailureCategory,
  createStagnationTracker,
  buildEscalationGuidance,
  computeSecretFindingFingerprint,
} from "./failure-stagnation";
import { scanChangesForSecrets } from "./secret-scanner";
import {
  selectDefaultProblemMemoryStore,
  lookupSolution,
  lookupSolutionsByRootCauseClass,
  recordAttempt,
  confirmResolution,
  recordReuseOutcome,
  promoteToCommonIfGeneric,
} from "./problem-memory";
import type { ProblemMemoryStore } from "./problem-memory";
import { selectDefaultRoundStatusReporter } from "./round-status";
import { selectDefaultEventStore } from "./event-store";
import type { EventStore } from "./event-store";
import { selectDefaultUsageLedgerForProject } from "./usage-ledger";
import type { UsageLedger } from "./usage-ledger";
import { acquireProjectLock, releaseProjectLock } from "./project-lock";
import type { ProjectLockHandle, ProjectLockOwnerKind } from "./project-lock";
import { isAuditCriticalEvent } from "./observability-event";
import type { AutoDevEventInput } from "./observability-event";
import { randomUUID } from "node:crypto";
import { log } from "./logger";
import { getWorkingTreeChanges } from "./git-changes";
import { isPathWithinAllowedPrefixes } from "./claude-developer";
import type { CoreState, ClaudeResult, HumanFinalReviewGate } from "./types";
import { isTechnicalAutoRecoverableWaitingHuman, isCheckpointBlockedMarker, reconcileKnownTechnicalDeferredMarkers } from "./human-gate-policy";

// AutoDev Core — "project-state 읽기 → 다음 Task 자동 결정(task-registry.ts 엔진 +
// manifest.taskRegistry 데이터) → Claude 실제 개발 → targeted tests(AutoDev가 직접
// 실행) → GPT 독립 리뷰 → REVISE 자동 루프(orchestrator.ts가 전담) → Critical 0/High 0
// PASS면 → 해당 Task 파일만 Git checkpoint → project-state 갱신 → 다음 Task 자동 선택"까지
// 전부 이 파일이 배선한다. Phase별 if문을 여기 하드코딩하지 않는다 — task-registry.ts의
// getNextTask()에 ProjectManifest.taskRegistry를 주입한 순서/completedTasks만으로 다음
// task를 고른다(decideNextAction).
//
// Phase F Task F4 — Production Pipeline Integration. 실제 developer/reviewer/REVISE
// 루프는 여전히 아래 runOrchestrator()(기존 성숙한 상태 머신 — usage-limit 재시도,
// MAX_GPT_CALLS 등 F1~F3에는 없는 안전장치를 갖춘 production 경로)가 단일 실행축으로
// 전담한다 — Agent orchestration이 이 핵심 루프를 대체하거나 F3의 별도 Developer↔Reviewer
// REVISE loop를 여기 중복 연결하지 않는다(Agent가 Safe Executor/GPT Reviewer/checkpoint
// 같은 Core service를 대체하면 안 된다는 원칙).
//
// Phase F Task F4.1 — Production Advisory Agent Placement. F4는 모든 task의 taskType을
// "code_implementation"으로 강제해 F1 routeTask()를 호출했는데, 그 결과 developer에
// 의존하는 qa는 pre-pass에서 항상 dependency 미충족으로 SKIPPED되고 나머지 role은
// code_implementation에 아예 존재하지 않아 advisory가 구조적으로 항상 no-op이었다. 이제는
// task-registry.ts의 TaskDefinition에 task 작성자가 명시하는 deterministic 신호
// (needsPlanning/needsExternalResearch/needsQaAdvisory/needsSecurityReview — LLM 텍스트
// 재분류 아님)만으로 agent-registry.ts의 buildAdvisoryRoutingPlan()이 필요한 role만
// 골라내고, 두 시점에 나눠 실제로 실행한다:
//   - pre-development(planner/research) — developer 실행 전, 필요하면 그 요약을
//     developerContext.instructions에 추가 안내로만 덧붙인다(§ runPreDevelopmentAdvisory).
//   - post-development/pre-checkpoint(qa/security) — orchestrator가 APPROVED로 끝난
//     뒤, checkpoint 이전에 developer의 실제 변경/테스트 결과를 최소 요약으로 참고하게 한다
//     (§ runPostDevelopmentAdvisory). qa/security 둘 다 deterministic test PASS/FAIL이나
//     GPT reviewer의 APPROVED 판정을 전혀 덮어쓰지 않는다 — 어떤 return path에도 이
//     advisory 결과가 checkpoint 진행 여부에 영향을 주지 않는다(순수 정보,
//     AutodevRunResult.agentAdvisory에만 첨부).
// 신호가 하나도 없으면(대부분의 단순 구현 task) 두 함수 모두 즉시 빈 결과를 반환하고
// 어떤 LLM 호출도 하지 않는다 — "Agent가 있으니 일단 호출"하지 않는다.
//
// Phase G Task G1 — Observability & Audit Event Foundation의 production instrumentation
// seam. run/task/agent/checkpoint 지점의 event는 이 파일이 담당하고(§ emitEvent 아래),
// developer/reviewer/test/REVISE cycle 지점의 event는 orchestrator.ts가 자신의 REVISE
// loop 안에서 직접 담당한다(§ Phase G Task G2 — orchestrator.ts에 deps.events/deps.runId로
// 전달). 두 파일 모두 새로운 판정을 만들지 않고 기존에 이미 계산된 값만 관찰한다.
//
// Phase G Task G2 — Production EventStore 연결. opts.events를 지정하지 않으면
// selectDefaultEventStore()가 대신 선택한다 — AUTOMATION_DRY_RUN이 명시적으로 "false"일
// 때(실제 production, run.ts가 이 값을 설정하지 않으면 여전히 기본은 dry-run이다)만 실제
// 파일 store를, 그 외(테스트/dry-run 기본값)에는 in-memory store를 자동으로 쓴다 — "opts.
// events 미지정 때문에 관측이 꺼지는 일"과 "테스트가 실제 runtime event 파일을 건드리는
// 일"을 동시에 막는다(기존 test 코드는 전혀 수정할 필요가 없다 — 테스트 환경은
// AUTOMATION_DRY_RUN을 "false"로 설정하지 않으므로 자동으로 in-memory를 받는다).
// Audit-critical event(SECURITY_BLOCKED/HUMAN_APPROVAL_REQUIRED/CHECKPOINT_CREATED/
// RUN·TASK 최종 상태 — § observability-event.ts의 isAuditCriticalEvent)의 기록이
// 실패하면 이 파일이 이미 저장 직전인 state 객체(checkpoint 실패/승인 경로)의
// deferredHumanTasks에 남긴다 — 새로운 저장 경로를 만들지 않는다. 그 외 telemetry
// event 실패는 log() 경고만 남기고 실행을 막지 않는다.
//
// Phase G Task G2.1 — Audit-Critical Delivery Fail-Closed Hardening. G2까지는 audit-critical
// event 기록 실패가 항상 "사후 surface"(이미 벌어진 일을 deferredHumanTasks에 남기는 것)
// 였다 — CHECKPOINT_CREATED/TASK_COMPLETED/RUN_COMPLETED는 git commit(performTaskCheckpoint)
// 이 이미 끝난 뒤에야 기록을 시도하므로, 그 기록이 실패해도 commit 자체를 막을 방법이
// 없었다. 이미 만들어진 commit을 자동으로 되돌리는 구조는 만들지 않기로 했으므로(§
// 요구사항), 대신 commit "이전"에 audit-critical 저장소가 지금 실제로 쓰기 가능한지
// 부수효과 없이 미리 확인한다(§ EventStore.checkAuditWritable, event-store.ts). 사용
// 불가능하다고 확인되면 git을 전혀 건드리지 않고 checkpoint 자체를 진행하지 않는다(아래
// checkpoint 직전의 auditHealth 검사). 이미 WAITING_HUMAN으로 확정된 경로(SECURITY_BLOCKED/
// REVIEW_BLOCKED/REVIEW_CYCLE_EXHAUSTED/고위험 사전 게이트)는 audit 기록이 실패해도 그
// 상태 전이가 먼저 확정된 뒤에 emitEvent를 호출하는 기존 순서 그대로다 — audit 실패가 이미
// 내려진 BLOCK 판정을 반대로 풀어주는 경로는 이 파일 어디에도 없다.
//
// AutoDev 범용화 Phase A Task A7 — 이 파일은 이제 MOVAN을 전혀 모른다. project-manifests/
// movan.ts를 import하지 않고, ProjectManifest를 기본값 없이 항상 호출부가 명시적으로
// 주입해야만 동작한다(runAutodevOnce(opts) — opts.manifest는 필수). manifest를 지정하지
// 않으면 즉시 실패하며, 절대 MOVAN으로 조용히 fallback하지 않는다. 실제 MOVAN 운용은
// run-movan.ts(MOVAN 전용 진입점)가 MOVAN_PROJECT_MANIFEST를 명시적으로 조립해 이 파일의
// runAutodevOnce()에 넘기는 방식으로만 이뤄진다 — 이 파일 자체는 그 사실을 모른다. 프로세스
// 진입점(main()/SIGINT 처리)도 run-movan.ts로 옮겼다 — Core 모듈은 더 이상 자신을 어떻게
// 실행할지(entry point) 알지 않는다.

export type AutodevDecision =
  | { kind: "STOP"; reason: string; setWaitingHuman: boolean }
  | { kind: "RUN_TASK"; task: TaskDefinition }
  /** Minimal HUMAN_FINAL_REVIEW Runtime Checkpoint Gate — 사람이 이 정확한 task/reviewCycle의
   *  reviewer 승인 결과에 대해 명시적으로 APPROVE했다(§ approveHumanFinalReview). runAutodevOnce()는
   *  이 kind일 때 Developer/GPT Reviewer를 다시 호출하지 않고, 이미 저장된 승인 결과로 곧바로
   *  checkpoint를 진행한다. */
  | { kind: "RESUME_APPROVED_CHECKPOINT"; task: TaskDefinition };

// state만 보고 순수하게 판단한다(부수효과 없음) — 테스트에서 이 함수만 독립적으로 검증한다.
// taskRegistry는 호출부가 항상 명시적으로 주입해야 한다(Phase A Task A7 — 기본값 제거,
// 어떤 프로젝트의 registry인지 이 함수는 모른다. 절대 MOVAN registry로 조용히 fallback하지
// 않는다).
// Phase A Task A5 — 이 함수는 state.status/state.completedTasks(CoreState)만 읽는다 —
// MOVAN 전용 project-state 필드는 실제로 하나도 참조하지 않으므로 매개변수 타입을
// CoreState로 좁혀 그 사실을 드러낸다(호출부는 여전히 loadState()가 반환한 전체 상태
// 객체를 그대로 넘길 수 있다 — CoreState는 그 객체가 항상 만족하는 부분집합이다).
export function decideNextAction(
  state: CoreState,
  taskRegistry: readonly TaskDefinition[]
): AutodevDecision {
  const status = state.status as unknown as string;

  // AutoDev Core Maintenance — Crash-safe Checkpoint Resume(Category B). runOrchestrator()가
  // Reviewer PASS를 확인하고 setStatus("APPROVED") 직후 saveCurrentState(state)로 이미
  // 디스크에 저장한 뒤(§ orchestrator.ts 619-626,738) — 즉 이 task의 Developer/Reviewer
  // 작업은 이미 완전히 끝났고 남은 것은 checkpoint(git commit)뿐인 시점에 — 프로세스가 죽으면,
  // 이 사실을 모르는 재시작은 아래 일반 경로(getNextTask → RUN_TASK)를 타 같은 task를 다시
  // 고르고, runOrchestrator()가 state.lastClaudeResult/lastGptDecision을 null로 리셋한 뒤
  // Developer를 처음부터 다시 호출한다 — 이미 승인된 작업 위에 새 Developer 세션이 다시
  // 손대게 되어 중복 작업/(product commit이 이미 만들어졌다면) 중복 commit 위험이 생긴다.
  //
  // 기존 RESUME_APPROVED_CHECKPOINT 경로(원래 Human Final Review 전용으로 만들어짐, §
  // autodev.ts isResumingApprovedCheckpoint)를 그대로 재사용한다 — 새 checkpoint 로직을
  // 추가하지 않는다. HFR 게이트(state.humanFinalReview.taskId)와 달리 이 상태는 taskId를
  // 명시적으로 담은 필드가 없다(state.currentTask는 taskDef.prompt 원문이다, § orchestrator.ts
  // state.currentTask = task — 순수 id가 아니다) — 그래서 completedTasks가 이 checkpoint
  // 전까지는 절대 바뀌지 않는다는 기존 불변조건에 의존해 getNextTask()가 지금 이 순간
  // 결정론적으로 반환하는 task를 후보로 삼되, state.currentTask가 그 task의 prompt와 정확히
  // 일치하는지까지 함께 확인한다(모호하면 진행하지 않는다 — HFR 분기와 동일한 fail-closed
  // 원칙). 조건이 하나라도 어긋나면 아래 일반 경로로 그대로 진행한다 — 그 경로는 이미 오늘
  // 실제로 벌어지는 기존 동작이므로 새로운 위험을 추가하지 않는다.
  if (status === "APPROVED") {
    const completedForApprovedResume = state.completedTasks ?? [];
    const candidateForApprovedResume = getNextTask(taskRegistry, completedForApprovedResume);
    if (
      candidateForApprovedResume &&
      state.lastGptDecision?.decision === "PASS" &&
      state.currentTask === candidateForApprovedResume.prompt
    ) {
      return { kind: "RESUME_APPROVED_CHECKPOINT", task: candidateForApprovedResume };
    }
  }

  if (status === "WAITING_HUMAN") {
    // Minimal HUMAN_FINAL_REVIEW Runtime Checkpoint Gate — 사람이 이미 이 정확한 task/
    // reviewCycle/reviewer 승인에 대해 명시적으로 APPROVE했는지 확인한다(§
    // approveHumanFinalReview, autodev.ts). 아래 조건 중 하나라도 어긋나면(다른 task용 stale
    // approval, reviewCycle 불일치, reviewer decision이 PASS가 아니었음, 이미
    // completedTasks에 있음, gate 자체가 없거나 PENDING/REJECTED, registry상 "다음 task"가
    // gate의 taskId와 다름) 절대 RESUME으로 취급하지 않고 기존 WAITING_HUMAN STOP으로
    // fail-closed한다 — 모호하면 승인으로 간주하지 않는다.
    const gate = state.humanFinalReview;
    const completedForGate = state.completedTasks ?? [];
    if (
      gate &&
      gate.status === "APPROVED" &&
      gate.reviewCycle === state.reviewCycle &&
      state.lastGptDecision?.decision === "PASS" &&
      !completedForGate.includes(gate.taskId)
    ) {
      const resumedTask = getNextTask(taskRegistry, completedForGate);
      if (resumedTask && resumedTask.id === gate.taskId) {
        return { kind: "RESUME_APPROVED_CHECKPOINT", task: resumedTask };
      }
    }
    return {
      kind: "STOP",
      reason: "이미 WAITING_HUMAN 상태 — 사람 확인 대기 중이므로 자동 실행하지 않습니다.",
      setWaitingHuman: false,
    };
  }

  // AutoDev Core Maintenance(2026-08-30, Category A/C) — MID_FLIGHT_CRASH_LOOP_DETECTED(§
  // runAutodevOnce의 MID_FLIGHT_ORCHESTRATOR_STATUSES 재조정)는 WAITING_HUMAN이 아니라
  // "BLOCKED"(OrchestratorStatus에 이미 있었으나 실제로는 쓰이지 않던 값)를 쓴다 — 실제로
  // genuine judgment가 필요한 게 아니라(사람이 "승인"한다고 문제가 풀리지 않는다 — 환경/코드
  // 결함을 직접 고쳐야 한다) 기술적 안전정지이기 때문이다. run.ts는 status==="WAITING_HUMAN"
  // 문자열만으로 Telegram controller를 계속 살려 사람의 APPROVE를 기다리므로, 이 값을
  // WAITING_HUMAN으로 쓰면 실제 Human Gate(Telegram 알림/승인 대기)가 켜진다 — 그건 이
  // 상태의 의도가 아니다. 이 STOP 분기가 없으면 재시작마다 이 branch를 건너뛰고 아래 일반
  // 경로(getNextTask → RUN_TASK)로 빠져 Developer를 다시 호출하게 되어, 이 상한이 존재하는
  // 이유(§ MAX_MID_FLIGHT_UNEXPECTED_EXIT_COUNT) 자체가 무의미해진다 — 이 STOP이 그 상한을
  // 재시작을 넘어서도 실제로 지킨다.
  if (status === "BLOCKED") {
    return {
      kind: "STOP",
      reason: "이미 BLOCKED 상태(기술적 안전정지) — 근본 원인이 해소되지 않는 한 자동 실행하지 않습니다.",
      setWaitingHuman: false,
    };
  }

  const completedTasks = state.completedTasks ?? [];
  const nextTask = getNextTask(taskRegistry, completedTasks);

  if (!nextTask) {
    // registry의 모든 task가 completedTasks에 있다 — 더 실행할 자동 task가 없다.
    // Phase16 Task3(isHumanGate)까지 끝났다는 뜻이므로 실제 배포는 사람 몫으로 남긴다.
    return {
      kind: "STOP",
      reason: "task-registry의 모든 task가 완료되었습니다 — 배포는 사람이 트리거해야 합니다(DEPLOYMENT_WAITING_HUMAN).",
      setWaitingHuman: false,
    };
  }

  return { kind: "RUN_TASK", task: nextTask };
}

export interface HumanFinalReviewActionResult {
  ok: boolean;
  reason?: string;
}

/**
 * 사람이 Human Final Review를 명시적으로 APPROVE한다(§ 요구사항 7/§13 — 새로운 UI/CLI/
 * 서비스를 만들지 않고, project-state.json에 이미 있는 task ID/reviewCycle에 결합된 최소
 * 구조로 표현한다). 호출부(향후 CLI/Telegram/Dashboard wiring — 이 Task 범위 밖)는 사람이
 * 확인한 taskId를 그대로 넘겨야 한다: taskId가 현재 대기 중인 gate와 다르면(stale
 * approval) 거부한다.
 *
 * state.status는 여전히 "WAITING_HUMAN"으로 남겨둔다 — decideNextAction()이 이 값과
 * gate.status==="APPROVED"를 함께 확인해야만 RESUME_APPROVED_CHECKPOINT를 반환하기
 * 때문이다. 여기서 상태를 "READY"로 바꾸면 decideNextAction()이 이 승인 정보를 확인하지
 * 않고 곧바로 getNextTask()로 같은 task를 다시 골라 Developer/Reviewer를 처음부터
 * 재실행하게 된다 — § 요구사항 8이 명시적으로 금지하는 상황이다.
 */
export function approveHumanFinalReview(
  statePath: string,
  taskId: string,
  now: () => Date = () => new Date()
): HumanFinalReviewActionResult {
  const state = loadState(statePath);
  if ((state.status as unknown as string) !== "WAITING_HUMAN") {
    return { ok: false, reason: `UNEXPECTED_STATE(${state.status})` };
  }
  const gate = state.humanFinalReview;
  if (!gate || gate.status !== "PENDING") {
    return { ok: false, reason: "NO_PENDING_HUMAN_FINAL_REVIEW" };
  }
  if (gate.taskId !== taskId) {
    return { ok: false, reason: `TASK_MISMATCH(expected=${gate.taskId}, got=${taskId})` };
  }
  if (gate.reviewCycle !== state.reviewCycle) {
    return { ok: false, reason: "STALE_REVIEW_CYCLE" };
  }
  if ((state.completedTasks ?? []).includes(taskId)) {
    return { ok: false, reason: "TASK_ALREADY_COMPLETED" };
  }
  if (state.lastGptDecision?.decision !== "PASS") {
    return { ok: false, reason: "REVIEWER_DECISION_NOT_APPROVED" };
  }
  state.humanFinalReview = { ...gate, status: "APPROVED", approvedAt: now().toISOString() };
  saveState(state, statePath);
  return { ok: true };
}

/** 사람이 Human Final Review를 명시적으로 REJECT한다 — 이후 어떤 재실행도 checkpoint를
 *  진행하지 않는다(gate.status가 "APPROVED"가 아니게 되므로 decideNextAction()이 항상
 *  기존 WAITING_HUMAN STOP을 반환한다). 코드 변경 자체는 삭제/되돌리지 않고 working
 *  tree에 그대로 남겨(§ 요구사항 9 — 새로운 복잡한 revise workflow를 만들지 않는다) 사람이
 *  직접 조치할 수 있게 한다. */
export function rejectHumanFinalReview(
  statePath: string,
  taskId: string,
  now: () => Date = () => new Date()
): HumanFinalReviewActionResult {
  const state = loadState(statePath);
  if ((state.status as unknown as string) !== "WAITING_HUMAN") {
    return { ok: false, reason: `UNEXPECTED_STATE(${state.status})` };
  }
  const gate = state.humanFinalReview;
  if (!gate || gate.status !== "PENDING") {
    return { ok: false, reason: "NO_PENDING_HUMAN_FINAL_REVIEW" };
  }
  if (gate.taskId !== taskId) {
    return { ok: false, reason: `TASK_MISMATCH(expected=${gate.taskId}, got=${taskId})` };
  }
  state.humanFinalReview = { ...gate, status: "REJECTED", rejectedAt: now().toISOString() };
  state.deferredHumanTasks.push(
    `HUMAN_FINAL_REVIEW_REJECTED(${taskId}): 사람이 checkpoint를 거절했습니다 — 코드 변경은 working tree에 그대로 남아있습니다.`
  );
  saveState(state, statePath);
  return { ok: true };
}

export interface AutodevRunOptions {
  /** 어느 프로젝트를 개발할지 결정하는 Project Manifest(Phase A Task A4). Phase A Task A7부터
   *  필수 필드다 — 기본값이 없다. 호출부(예: run-movan.ts)가 항상 명시적으로 주입해야 하며,
   *  지정하지 않거나 유효하지 않으면(validateProjectManifest 실패) 즉시 throw한다. 이 Core
   *  파일은 어떤 프로젝트도 기본값으로 선택하지 않는다(silent MOVAN fallback 없음). */
  manifest: ProjectManifest;
  /** 지정하지 않으면 manifest.statePath를 쓴다. */
  statePath?: string;
  /** checkpoint git 명령이 실행될 저장소 경로 — 지정하지 않으면 manifest.targetProjectRoot를
   *  쓴다. 테스트는 반드시 별도의 임시 git repo 경로를 넘긴다(실제 프로젝트 repo에 commit이
   *  생기지 않게). */
  cwd?: string;
  /** 테스트 전용 — claudeRunner/gptReviewer 등을 주입해 실제 Claude CLI/OpenAI API를
   *  호출하지 않고 전체 흐름(선택→실행→checkpoint→state 갱신)을 검증한다. claudeRunner를
   *  직접 넘기면 taskDef.requiredTests 자동 바인딩을 덮어쓴다(테스트가 원한다면). */
  orchestratorDeps?: OrchestratorDeps;
  /**
   * Phase F Task F4.1 — taskDef의 needsPlanning/needsExternalResearch/needsQaAdvisory/
   * needsSecurityReview 신호에 따라 실제 실행되는 advisory read-only agent(planner/
   * research/qa/security) 실행에 쓸 runner. 지정하지 않으면 agent-orchestrator.ts의 기존
   * AUTOMATION_DRY_RUN 기본 선택(fake/real)을 그대로 따른다. 테스트는 반드시 fake를
   * 주입해 실제 Claude API를 호출하지 않는다.
   */
  advisoryReadOnlyRunner?: ReadOnlyAgentRunner;
  /**
   * Phase G Task G1 — 지정하면 이 실행의 run/task/agent/test/reviewer/checkpoint event를
   * 실제로 기록한다(§ emitEvent). 지정하지 않으면(기본값) 이 파일은 event를 전혀 만들지
   * 않는다 — 기존 production 동작과 100% 동일하다. Project config가 이 필드를 통해서도
   * event-store.ts의 append를 비활성화/약화시킬 수 없다(그런 파라미터 자체가 없다).
   */
  events?: EventStore;
  /**
   * Phase SI-3.8B — 지정하면 이 실행의 gpt-reviewer 호출(orchestrator.ts 경로)마다
   * requestCount/token/추정비용을 기록한다. 지정하지 않으면(기본값)
   * selectDefaultUsageLedgerForProject(manifest.projectId)가 production 여부에 따라
   * file/in-memory를 자동 선택한다(§ usage-ledger.ts — event-store.ts의 selectDefaultEventStore
   * 와 동일한 원칙).
   */
  ledger?: UsageLedger;
  /**
   * 테스트 전용 — defaultClaudeRunner(problem-memory 조회/기록, memoryHint 주입을 포함한
   * 이 파일의 실제 wiring)는 그대로 실행하면서, 그 안에서 실제 Claude CLI를 부르는
   * runDeveloperTaskViaSafeExecutor의 claudeCaller만 스크립트로 대체한다. 이 값이 없으면
   * runDeveloperTaskViaSafeExecutor의 기본값(실제 claude CLI 호출)을 그대로 쓴다.
   * orchestratorDeps.claudeRunner(더 상위의 완전 대체 seam)를 지정하면 이 옵션은 무시된다
   * (defaultClaudeRunner 자체가 호출되지 않으므로).
   */
  developerClaudeCaller?: DeveloperTaskOptions["claudeCaller"];
  /**
   * 테스트 전용 — problem-memory.ts의 project/common tier store를 명시적으로 주입한다.
   * 지정하지 않으면 selectDefaultProblemMemoryStore()가 production 여부에 따라 file/
   * in-memory를 자동 선택한다(§ 그 파일). 서로 다른 runAutodevOnce() 호출(예: Task A →
   * Task B 순차 실행) 사이에 지식이 이어지는지 검증하려면, 테스트가 같은 store 인스턴스를
   * 여러 호출에 걸쳐 명시적으로 재사용해야 한다(in-memory store는 호출마다 새로 만들면
   * 매번 비워진다).
   */
  problemMemoryStores?: { project: ProblemMemoryStore; common: ProblemMemoryStore };
  /** 지정하지 않으면 이 실행마다 새 runId를 생성한다(node:crypto의 randomUUID). */
  runId?: string;
  /**
   * Phase G Task G7 — Project Lock metadata의 ownerKind. 지정하지 않으면 "autodev"(일반
   * AutoDev 실행)를 쓴다. auto-resume.ts가 performAutoResume()에서 이 값을
   * "telegram-resume"로 지정해 호출한다 — lock 판정 로직 자체(project-lock.ts)는 두 호출
   * 경로가 완전히 동일하게 공유한다(canonical service 하나, 두 개의 서로 다른 lock 구현이
   * 아니다).
   */
  lockOwnerKind?: ProjectLockOwnerKind;
  /** AutoDev Core Maintenance — Canonical Stop Path(2026-08-31, JARVIS Task 5.3 실측 —
   *  "실행 중인 Developer/continuous run을 canonical하게 정상 중단할 수 없는 결함"). 지정하면
   *  이미 시작하기 전이면 lock acquire조차 하지 않고, 진행 중이면 durable-wait sleep(§
   *  orchestrator.ts)과 Developer subprocess(§ subprocess-runner.ts)를 즉시 중단하고
   *  outcome="STOPPED"로 반환한다. project-state.json은 중단 직전 마지막으로 저장된 내용
   *  그대로 남고(§ orchestrator.ts stopped 주석), project lock은 release하지 않는다(§ 아래
   *  lockShouldRelease=false — 기존 "작업 중 상태 보존" 원칙과 동일, 다음 writer는 기존
   *  stale-PID 판정으로 안전하게 재획득한다). 지정하지 않으면 기존 동작과 완전히 동일(중단
   *  불가). */
  abortSignal?: AbortSignal;
}

export type AutodevRunOutcome =
  | "STOPPED"
  | "RAN_TASK_APPROVED_AND_CHECKPOINTED"
  | "RAN_TASK_NOT_APPROVED"
  | "RAN_TASK_CHECKPOINT_BLOCKED"
  /** Minimal HUMAN_FINAL_REVIEW Runtime Checkpoint Gate — reviewer가 APPROVED했지만 사람의
   *  명시적 최종 승인(approveHumanFinalReview())이 아직 없어 checkpoint를 진행하지 않고
   *  WAITING_HUMAN으로 대기 상태를 전환한 경우. checkpoint/completedTasks/next task 진행
   *  전부 0건이다 — 사람이 승인한 뒤 동일 project를 다시 실행해야 checkpoint까지 이어진다
   *  (§ decideNextAction의 RESUME_APPROVED_CHECKPOINT). */
  | "RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW"
  /** Phase G Task G7 — 같은 project를 다른 프로세스가 이미 쓰고 있거나(PROJECT_ALREADY_LOCKED)
   *  lock 상태를 신뢰할 수 없어서(LOCK_STATE_UNCERTAIN/CORRUPT_LOCK) 이 실행 자체를 시작하지
   *  않은 경우. state.json/git 어느 쪽도 건드리지 않는다 — reason에 어떤 lock 코드였는지 남는다. */
  | "BLOCKED_PROJECT_LOCK"
  /** Phase G Task G7.3 — manifest.remoteGitSafety가 지정된 project에서, run 시작 전 Remote
   *  Safety Gate(local HEAD == origin/<branch> 재확인)가 통과하지 못한 경우. state.json/git
   *  어느 쪽도 건드리지 않는다(loadState조차 호출하지 않는다) — reason에 remote-git-safety.ts의
   *  RemoteGitBlockedCode가 남는다. */
  | "BLOCKED_REMOTE_GIT"
  /** AutoDev / JARVIS Unattended Continuous Development Reliability Hardening Phase 3, 이후
   *  Phase 5에서 재정의됨 — taskDef.requiredTests 중 "npm run X" 형태가 package.json에
   *  등록돼 있지 않은 경우. Safe deterministic self-recovery(§ required-test-preflight.ts
   *  attemptSafeRequiredTestScriptRepair)로 고칠 수 있는 항목은 여기서 고쳐지고 실행이
   *  계속된다. Phase 5부터는 그렇게도 해결할 수 없는 항목(파일이 아직 없는 정상적인
   *  "구현 전" 상태, 또는 후보가 모호함)이 남아도 이 outcome을 반환하지 않는다 —
   *  REQUIRED_TEST_CONFIGURATION_ERROR는 사람의 판단이 필요한 문제가 아니므로(§
   *  CLAUDE.md WAITING_HUMAN 정책) Developer/Reviewer 호출을 막지 않고 그대로 진행한다.
   *  이 union member는 타입 호환성을 위해 남겨두지만 현재 production 코드 경로에서는
   *  반환되지 않는다. */
  | "BLOCKED_REQUIRED_TEST_CONFIGURATION"
  /** AutoDev Core Maintenance(2026-08-30) — taskDef.requiredTests 중 하나 이상의 cwd가
   *  resolve하는 절대경로가 실제로 존재하지 않거나(디렉터리 없음), wrapper-style
   *  executable(gradlew 등)의 wrapper 파일 자체가 그 디렉터리 안에 없는 경우(§
   *  required-test-preflight.ts checkRequiredTestExecutionEnvironment). 이 문제는
   *  Developer가 스스로 고칠 수 없다(project adapter config — commandCwdAliases/
   *  requiredTest.cwd — 자체가 잘못됐고, Developer의 allowedPathPrefixes 밖이며 AutoDev
   *  Core도 이 파일에 쓰지 않는다) — 그래서 REQUIRED_TEST_CONFIGURATION_ERROR(위, npm
   *  script 미등록)와 달리 이 경우는 Developer/Reviewer를 전혀 부르지 않는다. P0-4
   *  하드닝(독립 감사) — 실제 사람의 사업적/보안적 "판단"이 필요한 게 아니라 순수 config
   *  결함이므로 WAITING_HUMAN이 아니라 기술적 BLOCKED로 전환한다(§ decideNextAction의
   *  status==="BLOCKED" STOP 분기와 동일한 원칙 — run.ts가 정상 종료하고 runner-supervisor.ts
   *  의 bounded backoff 재시작이 retry를 담당, humanInterventionRequired는 설정하지 않음).
   *  같은 결함이 더 이상 재현되지 않으면 다음 재시작 시 자동으로 READY로 복구된다(§
   *  reconcileStaleRequiredTestExecutionEnvironmentTasks 호출부). */
  | "BLOCKED_REQUIRED_TEST_EXECUTION_ENVIRONMENT"
  /** AutoDev 최종 통합 하드닝(Hardening A, Execution Contract를 Runtime 불변조건으로) —
   *  execution-contract.ts(SI-3.7)의 validateRequiredTestExecutionContract는 원래
   *  spec-planner.ts의 계획 생성 시점에서만 호출됐다 — 그 이후 project adapter가 수동
   *  편집되거나(예: task-registry.json의 requiredTest만 바뀌고 execution-policy.json의
   *  allowedCommands가 갱신되지 않음) 서로 다른 generation의 산출물이 섞이면, 계획 시점
   *  에는 통과했더라도 실행 시점에는 이 task의 requiredTest가 더 이상 실행 가능한
   *  구조가 아닐 수 있다(§ JARVIS EP-1과 동일한 계열의 실행계약 불일치). 이 검사는 그
   *  런 drift를 Developer를 부르기 직전에 다시 한 번 재확인한다 — 새 검증 로직이 아니라
   *  같은 validateRequiredTestExecutionContract를 여기서도 재사용할 뿐이다. 실패하면
   *  BLOCKED_REQUIRED_TEST_EXECUTION_ENVIRONMENT와 동일한 원칙(genuine Human Gate가
   *  아니라 기술적 BLOCKED — canonical source-of-truth가 명백하지 않은 이상 추측 수정
   *  하지 않는다)으로 Developer/Reviewer를 전혀 부르지 않는다. */
  | "BLOCKED_EXECUTION_CONTRACT_MISMATCH"
  /** AutoDev Core Maintenance(2026-08-30) — 같은 task에서 mid-flight 프로세스 크래시
   *  재시작(§ MID_FLIGHT_ORCHESTRATOR_STATUSES)이 MAX_MID_FLIGHT_UNEXPECTED_EXIT_COUNT를
   *  초과했다. Developer/Reviewer를 다시 호출하지 않고 즉시 기술적 BLOCKED로 전환한다(genuine
   *  WAITING_HUMAN이 아니다 — § 아래 실제 구현의 status==="BLOCKED" 분기와 그 주석) —
   *  deterministic-simulation.ts Run C가 실제로 재현한 무제한 재시작 결함을 닫는다. */
  | "BLOCKED_MID_FLIGHT_CRASH_LOOP"
  /** AutoDev 최종 통합 하드닝(Hardening E, No-Progress를 Hard Switch로) — 같은 task가
   *  WRITE 없이(changedFiles.length===0) MAX_MID_FLIGHT_UNEXPECTED_EXIT_COUNT회 이상
   *  연속 실패했다. buildNoWriteStrategyEscalationHint()가 이미 반복 횟수에 따라 더 강한
   *  prompt hint를 보여주지만, 이 상한 전까지는 계속 같은 전략(더 강한 문구의 hint)만
   *  반복할 뿐 실제로 접근을 바꾸지 않는다 — 상한을 넘으면 Developer를 다시 호출하지 않고
   *  즉시 기술적 BLOCKED로 전환한다(genuine WAITING_HUMAN이 아니다 — MID_FLIGHT_CRASH_LOOP_DETECTED
   *  와 동일한 원칙, project lock도 동일하게 유지한다). */
  | "BLOCKED_NO_WRITE_STRATEGY_EXHAUSTED";

export interface AutodevRunResult {
  outcome: AutodevRunOutcome;
  taskId?: string;
  orchestratorStatus?: string;
  checkpoint?: CheckpointOutcome;
  reason?: string;
  /**
   * Phase F Task F4.1 — taskDef의 신호에 따라 실제 실행된 advisory agent(pre-development:
   * planner/research, post-development: qa/security)의 결과를 실행 순서대로 담는다.
   * 신호가 없는 대부분의 단순 task는 이 필드 자체가 없다(agent 호출 0회). developer/
   * reviewer/checkpoint의 어떤 판정에도 영향을 주지 않는 순수 정보다.
   */
  agentAdvisory?: AgentStepResult[];
}

function computeStateRelPath(statePath: string, cwd: string): string {
  return relative(cwd, statePath).split(sep).join("/");
}

/**
 * developer 실행 전 advisory(planner/research)만 taskDef.needsPlanning/
 * needsExternalResearch 신호에 따라 실제 실행한다. 신호가 없으면 즉시 undefined(LLM 호출
 * 0회). 고위험 task는 orchestrator.ts의 기존 게이트와 동일한 policy.ts 함수로 판정해
 * advisory 자체를 실행하지 않는다(§ 고위험 task는 어떤 runner도 호출하지 않는다는 기존
 * 원칙과 동일 — routeTask()를 거치지 않고 classifyTaskRisk/requiresHumanApproval을 직접
 * 재사용한다).
 */
export async function runPreDevelopmentAdvisory(
  taskDef: TaskDefinition,
  advisoryReadOnlyRunner: ReadOnlyAgentRunner | undefined
): Promise<AgentStepResult[] | undefined> {
  const risk = classifyTaskRisk(taskDef.prompt);
  if (risk !== null && requiresHumanApproval(risk)) return undefined;

  const plan = buildAdvisoryRoutingPlan(taskDef.id, {
    needsPlanning: taskDef.needsPlanning,
    needsExternalResearch: taskDef.needsExternalResearch,
  });
  if (plan.steps.length === 0) return undefined;

  const result = await executeRoutingPlan(
    plan,
    { taskId: taskDef.id, taskGoal: taskDef.prompt },
    undefined,
    advisoryReadOnlyRunner ? { readOnlyRunner: advisoryReadOnlyRunner } : {}
  );
  return result.stepResults.length > 0 ? result.stepResults : undefined;
}

/**
 * developer 완료(+ reviewer APPROVED) 후, checkpoint 이전 advisory(qa/security)만
 * taskDef.needsQaAdvisory/needsSecurityReview 신호에 따라 실제 실행한다. 신호가 없으면
 * 즉시 undefined. developerResult(실제 changedFiles/required test 결과)의 최소 요약만
 * context로 전달한다 — rawOutput이나 전체 transcript는 절대 재전송하지 않는다(§ 토큰
 * 효율). 이 함수의 결과는 어디에서도 checkpoint 진행 여부에 영향을 주지 않는다(호출부가
 * 순수 정보로만 취급한다).
 */
export async function runPostDevelopmentAdvisory(
  taskDef: TaskDefinition,
  developerResult: ClaudeResult,
  advisoryReadOnlyRunner: ReadOnlyAgentRunner | undefined
): Promise<AgentStepResult[] | undefined> {
  const plan = buildAdvisoryRoutingPlan(taskDef.id, {
    needsQaAdvisory: taskDef.needsQaAdvisory,
    needsSecurityReview: taskDef.needsSecurityReview,
  });
  if (plan.steps.length === 0) return undefined;

  const testsSummary = developerResult.tests.length > 0 ? developerResult.tests.map((t) => `${t.name}=${t.pass ? "PASS" : "FAIL"}`).join(", ") : "(없음)";
  const changedFilesSummary = developerResult.changedFiles.length > 0 ? developerResult.changedFiles.join(", ") : "(없음)";
  const contextSummary = `# 변경 파일\n${changedFilesSummary}\n\n# required test 결과\n${testsSummary}`;

  const result = await executeRoutingPlan(
    plan,
    { taskId: taskDef.id, taskGoal: taskDef.prompt, roleContext: { qa: contextSummary, security: contextSummary } },
    undefined,
    advisoryReadOnlyRunner ? { readOnlyRunner: advisoryReadOnlyRunner } : {}
  );
  return result.stepResults.length > 0 ? result.stepResults : undefined;
}

/**
 * events가 지정되지 않았으면 즉시 no-op. append가 실패하면(event-store.ts는 실패를
 * ok:false로 정직하게 반환한다) 그 사실을 logger.ts의 log()로 눈에 보이게 남긴다 — 실패를
 * 조용히 성공으로 위장하지 않는다. audit-critical event(§ isAuditCriticalEvent)의 실패는
 * auditFailures에도 짧은 사유만 쌓인다 — 호출부가 이미 저장 직전인 state 객체의
 * deferredHumanTasks에 이어붙일 수 있게(§ 요구사항 6, 새 저장 경로를 만들지 않는다). 이
 * 함수 자체는 runAutodevOnce()의 실제 흐름/반환값을 절대 바꾸지 않는다(observability
 * 실패가 production 코드 배포 자체를 막으면 안 된다는 원칙 — telemetry든 audit-critical
 * event 손실이든 동일하게, "이 함수 하나가 최종 outcome을 바꾸지 않는다"는 점은 같다.
 * audit-critical과 telemetry의 차이는 "얼마나 눈에 띄게/영구적으로 surface하는가"에
 * 있다 — 전자는 project-state.json에도 남고, 후자는 log 한 줄로 끝난다).
 */
function emitEvent(events: EventStore | undefined, input: AutoDevEventInput, auditFailures?: string[]): void {
  if (!events) return;
  const result = events.append(input);
  if (result.ok) return;
  if (isAuditCriticalEvent(input.eventType)) {
    log(`AUDIT_CRITICAL_EVENT_LOST: ${input.eventType} 기록 실패 — 이 실행의 감사 기록이 불완전합니다.`, {
      eventType: input.eventType,
      runId: input.runId,
      taskId: input.taskId,
      error: result.error,
    });
    auditFailures?.push(`AUDIT_EVENT_LOST(${input.eventType}): ${result.error ?? "unknown"}`);
  } else {
    log("observability event 기록 실패(telemetry)", { eventType: input.eventType, runId: input.runId, error: result.error });
  }
}

/** advisory 실행 결과(AgentStepResult[])를 AGENT_STARTED+AGENT_COMPLETED/AGENT_FAILED
 *  event 쌍으로 남긴다 — 이미 끝난 결과를 관찰만 할 뿐, 새로운 duration 측정을 만들지
 *  않는다(실제 runner가 duration을 제공하지 않으므로 durationMs는 채우지 않는다 —
 *  §추정값을 실제값처럼 만들지 않는다). */
function emitAdvisoryAgentEvents(
  events: EventStore | undefined,
  runId: string,
  projectId: string,
  taskId: string,
  phase: "pre_development" | "post_development",
  results: AgentStepResult[] | undefined
): void {
  if (!events || !results) return;
  for (const r of results) {
    const outcome = r.status === "SUCCESS" ? "SUCCESS" : r.status === "BLOCKED" ? "BLOCKED" : r.status === "SKIPPED" ? "SKIPPED" : "FAILED";
    // Phase G Task G3.1 — 이 agent 호출(1회) 1건당 실제로 관측된 model/tokenUsage/durationMs를
    // AGENT_SELECTED/AGENT_STARTED(호출 전, 아직 결과 없음)가 아니라 이 terminal event
    // (AGENT_COMPLETED/AGENT_FAILED) 하나에만 붙인다(§ 요구사항 6 double-counting 방지).
    // r.data는 planner/research/qa/security(모두 read-only 실행모델)의 ReadOnlyAgentOutcome이다.
    const data = r.data as { model?: { provider: string; name: string }; tokenUsage?: { inputTokens?: number; outputTokens?: number }; durationMs?: number } | undefined;
    emitEvent(events, { eventType: "AGENT_SELECTED", runId, projectId, taskId, agentId: r.agentId, agentRole: r.role, executionPhase: phase });
    emitEvent(events, { eventType: "AGENT_STARTED", runId, projectId, taskId, agentId: r.agentId, agentRole: r.role, executionPhase: phase, outcome: "PENDING" });
    emitEvent(events, {
      eventType: outcome === "FAILED" ? "AGENT_FAILED" : "AGENT_COMPLETED",
      runId,
      projectId,
      taskId,
      agentId: r.agentId,
      agentRole: r.role,
      executionPhase: phase,
      outcome,
      reason: r.reason,
      model: data?.model,
      tokenUsage: data?.tokenUsage,
      durationMs: data?.durationMs,
    });
  }
}

// 1회 실행 — "다음 task 선택 → Claude 개발(+AutoDev가 직접 실행하는 필수 테스트) →
// GPT 리뷰(REVISE 루프는 orchestrator.ts 내부에서 전담) → 승인 시 checkpoint → project-state
// 갱신(2단계 commit: product commit → administrative commit)"까지 한 사이클을 수행한다.
// Claude worker를 부르기 전의 상태 판단(decideNextAction)은 순수 함수라 별도로 테스트하고,
// 이 함수는 그 판단 이후의 부수효과(orchestrator 실행, checkpoint, state 저장)를 담당한다.
export async function runAutodevOnce(opts: AutodevRunOptions): Promise<AutodevRunResult> {
  if (!opts || !opts.manifest) {
    throw new Error(
      "runAutodevOnce: manifest가 필요합니다 — AutoDev Core는 어떤 프로젝트를 개발할지 스스로 " +
        "선택하지 않습니다(silent MOVAN fallback 없음). 호출부가 ProjectManifest를 명시적으로 넘기세요."
    );
  }
  const manifest = opts.manifest;
  validateProjectManifest(manifest);

  // AutoDev Core Maintenance — Canonical Stop Path(2026-08-31, JARVIS Task 5.3 실측 —
  // "실행 중인 Developer/continuous run을 canonical하게 정상 중단할 수 없는 결함"). lock
  // acquire조차 시도하기 전에 이미 중단 요청이 들어와 있으면 아무 것도 시작하지 않는다 —
  // project-state.json/lock 어느 쪽도 건드리지 않는다(§ 위 lock acquire 주석과 동일한 원칙:
  // "이 경로에서는 아직 아무것도 만지지 않았다").
  if (opts.abortSignal?.aborted) {
    log("AutoDev 시작 전 중단 요청(abortSignal) 감지 — lock acquire도 시도하지 않고 즉시 종료");
    return { outcome: "STOPPED", reason: "ABORTED: 시작 전 중단 요청" };
  }

  const runId = opts.runId ?? randomUUID();
  const events = opts.events ?? selectDefaultEventStore();
  const ledger = opts.ledger ?? selectDefaultUsageLedgerForProject(manifest.projectId);
  const lockOwnerKind: ProjectLockOwnerKind = opts.lockOwnerKind ?? "autodev";

  // Phase G Task G7 — Project Lock & Concurrent Writer Safety. 실제 production write(state
  // 읽기/Developer 실행/checkpoint)를 시작하기 전에, 이 project(canonical real path 기준)를
  // 다른 프로세스가 이미 쓰고 있지 않은지 원자적으로 확인한다. 이 판정은 project-lock.ts
  // 하나가 전담한다 — 일반 AutoDev 실행(run.ts)과 Telegram Auto Resume(auto-resume.ts)
  // 모두 이 함수(runAutodevOnce) 하나를 거치므로 두 경로가 서로 다른 lock 구현을 갖지
  // 않는다(§ 요구사항 14). 실패하면 state.json/git 어느 쪽도 건드리지 않고 즉시 반환한다 —
  // "이미 다른 프로세스가 이 파일들을 만지고 있을 수 있다"는 바로 그 이유 때문에, 이
  // 경로에서는 loadState()조차 호출하지 않는다(동시 쓰기 race를 새로 만들지 않기 위함).
  const lockAcquireResult = acquireProjectLock({
    projectId: manifest.projectId,
    targetProjectRoot: manifest.targetProjectRoot,
    ownerKind: lockOwnerKind,
    runId,
  });

  if (!lockAcquireResult.ok) {
    const lockEventType = lockAcquireResult.code === "CORRUPT_LOCK" ? "PROJECT_LOCK_CORRUPT" : "PROJECT_LOCK_BLOCKED";
    log(`Project Lock BLOCK(${lockAcquireResult.code}) — production writer를 시작하지 않습니다.`, {
      projectId: manifest.projectId,
      code: lockAcquireResult.code,
      reason: lockAcquireResult.reason,
    });
    emitEvent(events, {
      eventType: lockEventType,
      runId,
      projectId: manifest.projectId,
      executionPhase: "task_selection",
      outcome: "BLOCKED",
      humanInterventionRequired: true,
      reason: lockAcquireResult.reason,
      metadata: {
        lockBlockedCode: lockAcquireResult.code,
        ...(lockAcquireResult.code === "PROJECT_ALREADY_LOCKED" && lockAcquireResult.existingOwner
          ? { existingOwnerPid: lockAcquireResult.existingOwner.pid, existingOwnerKind: lockAcquireResult.existingOwner.ownerKind }
          : {}),
      },
    });
    return { outcome: "BLOCKED_PROJECT_LOCK", reason: lockAcquireResult.reason };
  }

  const lock: ProjectLockHandle = lockAcquireResult.lock;
  emitEvent(events, {
    eventType: "PROJECT_LOCK_ACQUIRED",
    runId,
    projectId: manifest.projectId,
    executionPhase: "task_selection",
    outcome: "SUCCESS",
    metadata: { ownerKind: lockOwnerKind },
  });
  if (lockAcquireResult.recoveredFromStale) {
    const { previousOwnerPid, evidence } = lockAcquireResult.recoveredFromStale;
    emitEvent(events, {
      eventType: "PROJECT_LOCK_STALE_DETECTED",
      runId,
      projectId: manifest.projectId,
      executionPhase: "task_selection",
      outcome: "SUCCESS",
      reason: evidence,
      metadata: { previousOwnerPid },
    });
    emitEvent(events, {
      eventType: "PROJECT_LOCK_RECOVERED",
      runId,
      projectId: manifest.projectId,
      executionPhase: "task_selection",
      outcome: "SUCCESS",
      metadata: { previousOwnerPid },
    });
  }

  // 이 시점부터는 lock을 잡고 있다 — 아래 finalizeProjectLock()이 실행 결과에 따라
  // release/keep을 결정한다(§ 요구사항 9, WAITING_HUMAN lifecycle 정책은 각 반환 지점에서
  // lockShouldRelease를 명시적으로 false로 설정하는 방식으로 표현한다).
  let lockShouldRelease = true;
  function finalizeProjectLock(): void {
    if (lockShouldRelease) {
      const rel = releaseProjectLock(lock);
      if (rel.ok) {
        emitEvent(events, { eventType: "PROJECT_LOCK_RELEASED", runId, projectId: manifest.projectId, executionPhase: "state_update", outcome: "SUCCESS" });
      } else {
        log("Project Lock release 실패 — 다음 acquire 시도가 stale 판정으로 복구해야 할 수 있습니다.", { projectId: manifest.projectId, reason: rel.reason });
      }
    } else {
      log(
        "Project Lock을 유지합니다(production working state가 WAITING_HUMAN으로 보존됨) — 이 프로세스가 종료된 뒤에는 stale 판정(owner PID 죽음/재사용 증명)으로만 다음 writer가 복구할 수 있습니다.",
        { projectId: manifest.projectId, pid: lock.metadata.pid }
      );
    }
  }

  try {
    // Safe Executor의 실제 read/write/명령 enforcement를 이 manifest의 Project Policy로
    // 명시적으로 설정한다(Phase B Task B1) — Safe Executor 자체는 어떤 프로젝트인지 모르고,
    // 이 호출이 유일한 주입 지점이다(silent MOVAN/permissive fallback 없음).
    //
    // Phase C Task C2 — 이 run 전용 SafeExecutorContext를 만든다. module-global mutable
    // singleton을 설정하는 하위 호환 wrapper 함수(같은 프로세스의 다른 실행이 나중에 덮어쓸 수
    // 있는 전역)는 이 production 경로에서 더 이상 호출하지 않는다 — 이 executorContext는 이
    // runAutodevOnce() 호출 하나에만 속하며, 아래에서 필요한 곳(Developer/GPT Reviewer)에
    // 명시적으로 전달한다. 같은 프로세스 안에서 다른 project의 runAutodevOnce()가 동시에/
    // 번갈아 실행돼도 이 executorContext의 root/policy는 절대 바뀌지 않는다.
    const executorContext = createSafeExecutorContext(manifest.targetProjectRoot, manifest.executionPolicy);

    const statePath = opts.statePath ?? manifest.statePath;
    const cwd = opts.cwd ?? manifest.targetProjectRoot;
    // Phase G Task G2 — audit-critical event 기록 실패 사유만(원문/추가정보 없이) 쌓아뒀다가
    // 이미 저장 직전인 state 객체의 deferredHumanTasks에 이어붙인다(§ emitEvent 주석).
    const auditFailures: string[] = [];

    // Phase G Task G7.3 — GitHub Sync & Remote Repository Safety. manifest.remoteGitSafety가
    // 지정된 project에서만 활성화된다(§ project-manifest.ts — 지정하지 않으면 완전히 no-op이라
    // remote가 없는 기존 fixture/temp git repo 테스트/manifest는 100% 기존 동작 그대로다).
    // Project Lock 다음, 어떤 production write(state 읽기 포함)보다도 먼저 확인한다 — 이
    // Gate가 막으면 loadState조차 호출하지 않는다(§ Project Lock BLOCK 분기와 동일한 원칙).
    // fetch 실패/remote 없음/upstream 없음/detached HEAD/remote ahead/local ahead/diverged/
    // 비교 불가 전부 fail-closed BLOCK이다 — 어떤 git 상태도 자동으로 바꾸지 않는다(§
    // remote-git-safety.ts).
    let remoteSnapshot: RemoteGitSnapshot | undefined;
    if (manifest.remoteGitSafety) {
      const remotePolicy = resolveRemoteGitSafetyPolicy(manifest.remoteGitSafety);
      emitEvent(events, {
        eventType: "REMOTE_GIT_CHECK_STARTED",
        runId,
        projectId: manifest.projectId,
        executionPhase: "task_selection",
        outcome: "PENDING",
        metadata: { remoteName: remotePolicy.remoteName },
      });
      const remoteCheck = checkRemoteSafeToStart(cwd, remotePolicy);
      if (!remoteCheck.ok) {
        log(`Remote Git Safety BLOCK(${remoteCheck.code}) — production writer를 시작하지 않습니다.`, {
          projectId: manifest.projectId,
          code: remoteCheck.code,
          reason: remoteCheck.reason,
        });
        emitEvent(events, {
          eventType: "REMOTE_GIT_BLOCKED",
          runId,
          projectId: manifest.projectId,
          executionPhase: "task_selection",
          outcome: "BLOCKED",
          humanInterventionRequired: true,
          reason: remoteCheck.reason,
          metadata: { remoteGitBlockedCode: remoteCheck.code },
        });
        // 이 분기는 state.json/git 어느 쪽도 건드리지 않았다(loadState조차 호출하지 않음) —
        // finally의 finalizeProjectLock()이 기본값(lockShouldRelease=true)대로 안전하게
        // release한다(§ Project Lock BLOCK 분기와 동일).
        return { outcome: "BLOCKED_REMOTE_GIT", reason: remoteCheck.reason };
      }
      remoteSnapshot = remoteCheck.snapshot;
      emitEvent(events, {
        eventType: "REMOTE_GIT_SAFE",
        runId,
        projectId: manifest.projectId,
        executionPhase: "task_selection",
        outcome: "SUCCESS",
        metadata: { remoteName: remoteSnapshot.remoteName, branch: remoteSnapshot.branch },
      });
    }

    emitEvent(events, { eventType: "RUN_STARTED", runId, projectId: manifest.projectId, executionPhase: "task_selection", outcome: "PENDING" });

    const state = loadState(statePath);

    // AutoDev / JARVIS 최종 무인개발 구조 보완 — Process/Restart 재시작 감지(§ 요구사항
    // 20/21, 2026-08-28 정책 수정). 정상적으로 끝난 실행은 항상 orchestrator.ts의 while
    // 루프가 break 전에 남기는 종결 상태(APPROVED/WAITING_HUMAN/BLOCKED)로 종료한다 — 그
    // 종결 상태가 아닌 mid-flight 상태(developer/reviewer 호출 도중을 뜻하는 값)로 새
    // 프로세스가 이 project를 다시 발견했다면, 그 이유는 직전 프로세스가 그 상태를 종결하지
    // 못한 채(수동 종료/timeout/OS kill 등) 죽었다는 것뿐이다 — 새로운 판정 로직을 만들지
    // 않고 이미 저장된 status 값만 재사용한다. 프로세스가 예상치 못하게 죽는 것 자체는
    // 기술적 사건이지 사람 판단이 필요한 사유가 아니다(§ 정책 수정 — "process crash" 카테고리
    // 는 Human Gate로 연결하지 않는다).
    //
    // AutoDev Core Maintenance(2026-08-30, Category A/C — Deterministic Simulation이 실제로
    // 재현한 결함) — 2026-08-28 정책은 이 재시작 허용에 상한을 두지 않았다("몇 번이 반복되든
    // 항상 제한적 재시작을 허용") — 그 근거는 "이 프로세스를 빠르게 자동 재시작시키는 별도
    // supervisor가 없다"였다. 그 전제가 이제 깨졌다: `runner-supervisor.ts`(및 그 crash
    // watchdog, Category C)가 정확히 그런 supervisor다. 같은 task가 매 attempt마다 프로세스
    // 자체를 죽이는 결함(예: 환경 결함으로 인한 uncaught exception)이면, supervisor가 이를
    // 영원히(수 초~수십 초 간격으로) 재시작하면서 Developer를 매번 처음부터 다시 호출하게
    // 되어 "동일 deterministic 실패에 무제한 재시도 금지"(§ 이 하드닝의 핵심 원칙)를 정확히
    // 위반한다 — seed=20260830 deterministic-simulation.ts Run C로 직접 재현 확인(20회
    // 재시작에도 종결 상태에 도달하지 못함). durable unexpectedExitCount(이미 있던 값, §
    // durable-recovery-state.ts)에 상한을 추가할 뿐 새 카운터를 만들지 않는다 — 상한을
    // 넘기면 root-cause-analysis.ts의 MAX_SAME_FAILURE_LOCAL_DEVELOPER_CALLS/
    // required-test-preflight.ts의 BLOCKED_REQUIRED_TEST_EXECUTION_ENVIRONMENT와 동일한
    // 원칙으로 Developer를 다시 부르지 않고 즉시 genuine WAITING_HUMAN으로 승격한다.
    const MAX_MID_FLIGHT_UNEXPECTED_EXIT_COUNT = 5;
    const MID_FLIGHT_ORCHESTRATOR_STATUSES = new Set([
      "CLAUDE_WORKING",
      "WAITING_GPT_REVIEW",
      "REVISION_REQUIRED",
      "WAITING_CLAUDE_LIMIT",
      // AutoDev / JARVIS 신뢰성 보완(2026-08-27 후속) — Developer provider durable wait
      // (§ orchestrator.ts WAITING_PROVIDER_RETRY) 도중 프로세스가 죽어도 WAITING_CLAUDE_LIMIT과
      // 동일하게 "한 번의 재시작은 허용"으로 취급한다 — 별도 판정 로직을 추가하지 않는다.
      "WAITING_PROVIDER_RETRY",
    ]);
    const inFlightTaskCandidate = getNextTask(manifest.taskRegistry, state.completedTasks);
    if (inFlightTaskCandidate && MID_FLIGHT_ORCHESTRATOR_STATUSES.has(state.status as string)) {
      const durable = loadDurableFailureStateForTask(state, inFlightTaskCandidate.id);
      const unexpectedExitCount = durable.unexpectedExitCount + 1;
      const priorStatus = state.status;
      state.technicalRecoveryState = { ...durable, unexpectedExitCount, updatedAt: new Date().toISOString() };
      if (unexpectedExitCount > MAX_MID_FLIGHT_UNEXPECTED_EXIT_COUNT) {
        const reason = `MID_FLIGHT_CRASH_LOOP_DETECTED: task=${inFlightTaskCandidate.id} unexpectedExitCount=${unexpectedExitCount} priorStatus=${priorStatus}`;
        log("MID_FLIGHT_CRASH_LOOP_DETECTED — 동일 task에서 mid-flight 재시작 상한 초과, 기술적 BLOCKED로 전환(Developer 재호출 없음, Human Gate 아님)", {
          taskId: inFlightTaskCandidate.id,
          unexpectedExitCount,
          priorStatus,
        });
        // AutoDev Core Maintenance(2026-08-30) — 이 상태는 WAITING_HUMAN이 아니라 BLOCKED다.
        // "사람이 승인"한다고 풀리는 문제가 아니라(코드/환경 결함을 실제로 고쳐야 한다) —
        // WAITING_HUMAN을 쓰면 run.ts가 문자열 하나만으로 Telegram controller를 계속 살려
        // 실제 승인 대기(Genuine Human Gate)를 켠다(§ decideNextAction의 status==="BLOCKED"
        // STOP 분기 주석). HUMAN_APPROVAL_REQUIRED 대신 RUN_BLOCKED를 쓴다 — 기존
        // REVIEW_CYCLE_EXHAUSTED 등 다른 genuine 경로도 감사 기록용으로 함께 남기는
        // 이벤트이지만(§ 위 예시), humanInterventionRequired는 설정하지 않는다("Human
        // approval 요구 0" — 대시보드/로그로는 관측 가능하되 알림·승인 요청은 아니다).
        state.status = "BLOCKED";
        state.deferredHumanTasks.push(reason);
        saveState(state, statePath);
        emitEvent(events, {
          eventType: "RUN_BLOCKED",
          runId,
          projectId: manifest.projectId,
          taskId: inFlightTaskCandidate.id,
          executionPhase: "task_selection",
          outcome: "BLOCKED",
          reason,
        });
        // 이 task가 반복적으로 프로세스를 죽이는 원인이 해소될 때까지 다른 writer가 같은
        // 실패를 다시 반복하지 않도록 lock을 유지한다(§ 대다수 genuine WAITING_HUMAN 경로와
        // 동일한 원칙 — MAX_GPT_CALLS_EXCEEDED/DETERMINISTIC_REVIEW_CYCLE_EXHAUSTED 등. 이
        // 상태는 genuine gate는 아니지만, 근본 원인이 사람이 직접 고쳐야 하는 결함이라는 점은
        // 동일하므로 같은 lock 보존 원칙을 따른다).
        lockShouldRelease = false;
        return { outcome: "BLOCKED_MID_FLIGHT_CRASH_LOOP", taskId: inFlightTaskCandidate.id, reason };
      }
      log("AutoDev 프로세스가 mid-flight 상태에서 재시작됨 — 제한적 재시작 허용(§ 요구사항 20, 상한 이내)", {
        taskId: inFlightTaskCandidate.id,
        unexpectedExitCount,
        priorStatus,
      });
      saveState(state, statePath);
    }

    // AutoDev / JARVIS Unattended Continuous Development Reliability Hardening Phase 5 —
    // Stale REQUIRED_TEST_CONFIGURATION_ERROR WAITING_HUMAN Reconciliation. decideNextAction()
    // 은 순수 함수로 유지한다(§ 그 함수 상단 주석 — state만 보고 부수효과 없이 판단, 독립
    // 테스트 대상) — 그래서 fs를 읽는 이 재검사는 decideNextAction() 호출 "전에" 여기서
    // 별도로 수행하고, 필요하면 이 state 객체만 갱신한다. state.humanFinalReview가 있으면
    // (사람이 이미 이 정확한 checkpoint에 명시적으로 APPROVE해야만 넘어갈 수 있는 별도
    // gate — § decideNextAction의 RESUME_APPROVED_CHECKPOINT) 이 재검사는 절대 개입하지
    // 않는다.
    //
    // Mixed-Marker Recovery 수정(2026-09-01, JARVIS Task 5.3 실측 — generic defect, §
    // required-test-preflight.ts reconcileStaleRequiredTestConfigurationTasks 상단 주석) —
    // 예전에는 deferredHumanTasks 전체가 REQUIRED_TEST_CONFIGURATION_ERROR 고정 템플릿
    // 문자열이어야만 재검사를 수행해서, 무관한 오래된 marker(STAGNATION_DETECTED, ENV
    // marker, genuine human marker 등) 하나만 섞여 있어도 실제 configuration 문제가
    // 해소됐는지 재확인 자체가 영구히 스킵됐다. 이제 그 함수는 이 마커 형식과 일치하는
    // 항목만 독립적으로 재검사해 해소된 것만 골라 제거한 remainingDeferredHumanTasks를
    // 반환한다 — 무관한 marker/아직 해소되지 않은 marker는 그 배열에 그대로 남는다. 이
    // 블록은 "이 마커 형식이 아닌 다른 사유"를 스스로 판정하거나 지우지 않는다 —
    // remainingDeferredHumanTasks가 완전히 비었을 때만(더 이상 어떤 사유도 남지 않았을
    // 때만) READY로 전환한다. 다른 marker가 남아 있으면 status는 WAITING_HUMAN으로 그대로
    // 유지되고, 그 남은 marker의 해소는 각자의 기존 canonical 경로에 맡긴다.
    if ((state.status as unknown as string) === "WAITING_HUMAN" && !state.humanFinalReview) {
      const reconciliation = reconcileStaleRequiredTestConfigurationTasks(state.deferredHumanTasks, executorContext.projectRoot);
      if (reconciliation.resolvedMarkers.length > 0) {
        console.log(
          `[autodev] REQUIRED_TEST_CONFIGURATION_ERROR marker ${reconciliation.resolvedMarkers.length}건을 재검사했습니다 — package.json에 필요한 npm script가 이미 등록되어 원인이 해소됨을 확인, 해당 marker만 제거합니다.`
        );
        log("REQUIRED_TEST_CONFIGURATION_ERROR marker 부분 해소", {
          projectId: manifest.projectId,
          resolvedMarkers: reconciliation.resolvedMarkers,
          remainingDeferredHumanTasks: reconciliation.remainingDeferredHumanTasks,
        });
        state.deferredHumanTasks = [...reconciliation.remainingDeferredHumanTasks];
        if (state.deferredHumanTasks.length === 0) {
          console.log(`[autodev] 남은 사유가 없습니다 — 정상 실행 상태로 자동 복구합니다.`);
          state.status = "READY";
        }
        saveState(state, statePath);
      }
    }

    // AutoDev / JARVIS 신뢰성 보완(2026-08-30, JARVIS Task 5.2 실측; P0-4 하드닝으로
    // status를 BLOCKED로 변경) — Stale REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR
    // Reconciliation. status가 "BLOCKED"인 경우도 함께 확인한다(§ P0-4 — 이 결함은 이제
    // WAITING_HUMAN이 아니라 BLOCKED로 저장된다).
    //
    // Mixed-Marker Recovery 수정(2026-09-01, JARVIS Task 5.3 실측 — generic defect, §
    // required-test-preflight.ts reconcileStaleRequiredTestExecutionEnvironmentTasks 상단
    // 주석) — 예전에는 deferredHumanTasks 전체가 이 마커 형식이어야만 재검사를 수행해서,
    // 무관한 오래된 마커(예: STAGNATION_DETECTED) 하나만 섞여 있어도 실제 환경 결함이
    // 해소됐는지 재확인 자체가 영구히 스킵됐다. 이제 그 함수는 이 마커 형식과 일치하는
    // 항목만 taskId/requiredTest 단위로 독립적으로 재검사해 해소된 것만 골라 제거한
    // remainingDeferredHumanTasks를 반환한다 — 무관한 마커/아직 해소되지 않은 마커/taskId를
    // 찾지 못한 마커는 그 배열에 그대로 남는다. 이 블록은 "이 마커 형식이 아닌 다른 사유"를
    // 스스로 판정하거나 지우지 않는다 — remainingDeferredHumanTasks가 완전히 비었을 때만
    // (더 이상 어떤 사유도 남지 않았을 때만) READY로 전환한다. 다른 마커가 남아 있으면
    // status는 그대로 유지되고(이미 BLOCKED/WAITING_HUMAN이었던 값), 그 남은 마커의 해소는
    // 각자의 기존 canonical 경로(§ 위 REQUIRED_TEST_CONFIGURATION_ERROR 재검사,
    // classifyWaitingHumanReason 등)에 맡긴다 — 이 블록이 임의로 지우지 않는다.
    if (
      ((state.status as unknown as string) === "WAITING_HUMAN" || (state.status as unknown as string) === "BLOCKED") &&
      !state.humanFinalReview
    ) {
      const envReconciliation = reconcileStaleRequiredTestExecutionEnvironmentTasks(
        state.deferredHumanTasks,
        manifest.taskRegistry,
        executorContext
      );
      if (envReconciliation.resolvedMarkers.length > 0) {
        console.log(
          `[autodev] REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR marker ${envReconciliation.resolvedMarkers.length}건을 재검사했습니다 — 실행 환경 결함이 더 이상 재현되지 않음을 확인, 해당 marker만 제거합니다.`
        );
        log("REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR marker 부분 해소", {
          projectId: manifest.projectId,
          resolvedMarkers: envReconciliation.resolvedMarkers,
          remainingDeferredHumanTasks: envReconciliation.remainingDeferredHumanTasks,
        });
        state.deferredHumanTasks = [...envReconciliation.remainingDeferredHumanTasks];
        if (state.deferredHumanTasks.length === 0) {
          console.log(`[autodev] 남은 사유가 없습니다 — 정상 실행 상태로 자동 복구합니다.`);
          state.status = "READY";
        }
        saveState(state, statePath);
      }
    }

    // Durable Technical Blocker Recovery — BLOCKED 상태 일반화(2026-09-01, generic defect,
    // JARVIS Task 5.3 실측 — § human-gate-policy.ts reconcileKnownTechnicalDeferredMarkers
    // 상단 주석) — STAGNATION_DETECTED_MARKER_PREFIX 등은 이미 TECHNICAL_AUTO_RECOVERABLE로
    // 분류돼 있었지만, 그 자동복구(아래 isTechnicalAutoRecoverableWaitingHuman 블록)는
    // status==="WAITING_HUMAN"일 때만 적용됐다 — status==="BLOCKED"이면 그 marker가
    // deferredHumanTasks에 남아 있어도 decideNextAction()이 재평가 없이 곧바로 STOP하므로
    // 영구 정체될 수 있었다. WAITING_HUMAN 전용 기존 블록(아래)은 전혀 건드리지 않는다
    // (회귀 없음, § 요구사항 E) — 이 블록은 status==="BLOCKED"에만 적용되는 별도 추가다.
    // genuine marker가 하나라도 섞여 있으면 reconcileKnownTechnicalDeferredMarkers() 자신이
    // fail-closed로 아무것도 하지 않는다(§ 요구사항 E — genuine marker 자동 제거/승인 금지).
    // ENV/CONFIG 등 이 함수가 모르는 형식의 marker는 위 두 블록의 몫으로 그대로 남는다 — 이
    // 블록은 그 marker를 절대 지우지 않는다(§ 요구사항 5 — 각 marker는 자기 정책으로만
    // 처리).
    if ((state.status as unknown as string) === "BLOCKED" && !state.humanFinalReview) {
      const technicalReconciliation = reconcileKnownTechnicalDeferredMarkers(state.deferredHumanTasks);
      if (technicalReconciliation.resolvedMarkers.length > 0) {
        console.log(
          `[autodev] 기술적 자동복구 대상 marker ${technicalReconciliation.resolvedMarkers.length}건(STAGNATION_DETECTED 등)을 제거하고 재시도를 허용합니다 — 근본 원인이 해소됐다고 증명하는 것이 아니라, 원인이 아직 남아있다면 재시도 중 다시 감지됩니다.`
        );
        log("BLOCKED 상태의 기술적 자동복구 marker 제거(Durable Technical Blocker Recovery)", {
          projectId: manifest.projectId,
          resolvedMarkers: technicalReconciliation.resolvedMarkers,
          remainingDeferredHumanTasks: technicalReconciliation.remainingDeferredHumanTasks,
        });
        state.deferredHumanTasks = [...technicalReconciliation.remainingDeferredHumanTasks];
        if (state.deferredHumanTasks.length === 0) {
          console.log(`[autodev] 남은 사유가 없습니다 — 정상 실행 상태로 자동 복구합니다.`);
          state.status = "READY";
        }
        saveState(state, statePath);
      }
    }

    // AutoDev / JARVIS 신뢰성 보완(2026-08-27) — Canonical Human Gate Policy 기반 기술적
    // WAITING_HUMAN 자동 복구. 위 REQUIRED_TEST_CONFIGURATION_ERROR 전용 재검사가 남은 marker
    // 없이 이미 해소했다면 state.status는 이미 "READY"이므로 이 블록은 자연히 아무 것도 하지
    // 않는다(중복 판정 없음). humanFinalReview가 있으면
    // classifyWaitingHumanReason() 자체가 항상 GENUINE_HUMAN_JUDGMENT를 반환하므로 그
    // gate는 여기서도 절대 건드리지 않는다(§ human-gate-policy.ts).
    //
    // No-Safe-Recovery-Action Gate(2026-08-31) — CHECKPOINT_SCOPE_VIOLATION은 더 이상 여기서
    // READY로 되돌아가지 않는다(human-gate-policy.ts가 이제 genuine으로 분류한다 — Developer/
    // Reviewer를 아무리 재시도해도 이 파일은 절대 사라지지 않는다는 것이 확인됐기 때문에,
    // provider/API를 다시 호출하는 대신 즉시 사람 판단 상태로 남긴다). REVIEW_CYCLE_EXHAUSTED/
    // REVIEW_BLOCKED로 저장된 WAITING_HUMAN만 READY로 되돌린다 — state.lastGptDecision/
    // lastClaudeResult는 그대로 보존하므로, 아래(§ Phase 6/7) previousAttemptResult 시딩과
    // scope-violation leftover 정리(§ 아래 — 이제는 항상 lastGptDecision.scopeViolations만
    // 본다, Core checkpoint 자신의 독립 판정 목록은 genuine 경로로 넘어가 여기 도달하지 않음)가
    // 이어서 정상 동작한다.
    if ((state.status as unknown as string) === "WAITING_HUMAN" && !state.humanFinalReview) {
      if (isTechnicalAutoRecoverableWaitingHuman(state)) {
        console.log(
          `[autodev] 기술적 WAITING_HUMAN을 재검사했습니다 — 실제 사람 판단이 필요한 사유가 아니므로 Telegram 승인 없이 자동 복구합니다.`
        );
        log("기술적 WAITING_HUMAN 자동 복구(Canonical Human Gate Policy)", {
          projectId: manifest.projectId,
          previousDeferredHumanTasks: state.deferredHumanTasks,
          lastGptDecision: state.lastGptDecision?.decision ?? null,
        });
        state.status = "READY";
        state.deferredHumanTasks = [];
        saveState(state, statePath);
      }
    }

    const decision = decideNextAction(state, manifest.taskRegistry);

    if (decision.kind === "STOP") {
      console.log(`[autodev] ${decision.reason}`);
      if (decision.setWaitingHuman && (state.status as unknown as string) !== "WAITING_HUMAN") {
        state.status = "WAITING_HUMAN";
        saveState(state, statePath);
      }
      // AutoDev Core Maintenance — Crash-safe Checkpoint Reconciliation(Category B, 마지막
      // task 전용 gap). "더 이상 실행할 task가 없다"는 이 지점은, 정상 종료라면 이미 마지막
      // task의 admin commit(commitProjectStateOnly, § 아래 completedTasks push 직후)까지 끝나
      // project-state.json이 clean해야 한다 — 그 admin commit 직전에 프로세스가 죽었다가
      // 재시작된 경우라면 completedTasks는 이미 저장돼 있으므로(§ decideNextAction — task 재
      // 실행 위험은 없다) 오직 project-state.json 자체만 dirty한 채로 남을 수 있다. working
      // tree 전체에서 딱 이 파일 하나만 변경돼 있을 때만(다른 unexpected 변경이 하나라도
      // 섞여 있으면 추측하지 않고 그대로 둔다 — 사람이 확인해야 한다) 안전하게 admin commit을
      // 대신 완료해 "state와 Git이 최종적으로 일치"하도록 마무리한다.
      const stateRelPathForReconcile = computeStateRelPath(statePath, cwd);
      const wtChangesForReconcile = getWorkingTreeChanges([], cwd).all;
      const onlyStateFileDirty =
        wtChangesForReconcile.length === 1 &&
        wtChangesForReconcile[0].path === stateRelPathForReconcile &&
        wtChangesForReconcile[0].status !== "untracked";
      if (onlyStateFileDirty) {
        const reconcileCommit = commitProjectStateOnly(
          stateRelPathForReconcile,
          "chore: reconcile dangling project-state.json (crash recovery — admin checkpoint had not completed)",
          cwd
        );
        if (reconcileCommit.ok) {
          console.log(
            `[autodev] project-state.json 잔여 uncommitted 변경을 안전하게 재조정 commit했습니다(${reconcileCommit.commitHash ?? "no-op"}).`
          );
          log("STATE_RECONCILED_ON_STOP — 마지막 task 이후 남아있던 project-state.json 변경을 commit함", {
            commitHash: reconcileCommit.commitHash,
          });
        } else {
          log("STATE_RECONCILE_ON_STOP_FAILED — project-state.json 재조정 commit 실패(uncommitted로 남음)", {
            reason: reconcileCommit.reason,
          });
        }
      }
      emitEvent(events, { eventType: "RUN_COMPLETED", runId, projectId: manifest.projectId, executionPhase: "task_selection", outcome: "SKIPPED", reason: decision.reason });
      // 이 분기는 어떤 developer/checkpoint 작업도 하지 않았다 — working tree에 아무 위험도
      // 남기지 않았으므로 안전하게 release한다(lockShouldRelease는 기본값 true 그대로).
      return { outcome: "STOPPED", reason: decision.reason };
    }

  const taskDef = decision.task;
  // Minimal HUMAN_FINAL_REVIEW Runtime Checkpoint Gate — 이 kind일 때는 사람이 이미 이
  // 정확한 task/reviewCycle의 reviewer 승인 결과에 APPROVE했다(§ decideNextAction). 아래
  // 코드는 이 플래그로 "Developer/GPT Reviewer를 다시 호출할지" 자체를 분기한다.
  const isResumingApprovedCheckpoint = decision.kind === "RESUME_APPROVED_CHECKPOINT";

  let finalState: CoreState;
  let preAdvisory: AgentStepResult[] | undefined;
  // AutoDev 지능형 오류 복구 하드닝(Problem-Solving Knowledge Store) — defaultClaudeRunner
  // (아래 else 분기)가 "이 task 안에서 required test 실패를 해결한 cycle"을 만나면 그 항목의
  // id를 여기 남긴다. checkpoint가 실제로 성공한 뒤(§ 아래 CHECKPOINT_CREATED emitEvent
  // 직후)에만 confirmResolution()으로 확정한다 — resume 경로(위 isResumingApprovedCheckpoint)는
  // defaultClaudeRunner를 전혀 호출하지 않으므로 이 값은 undefined로 남고 확정 코드는
  // 자연히 no-op이다.
  let pendingMemoryEntryId: string | undefined;
  // resume 경로도 checkpoint 확정 코드(아래)에서 이 두 store를 참조하므로 if/else 밖에서
  // 한 번만 만든다(§ problem-memory.ts — production 여부에 따라 file/in-memory 자동 선택,
  // 테스트는 opts.problemMemoryStores로 명시적으로 override할 수 있다).
  const problemProjectStore: ProblemMemoryStore =
    opts.problemMemoryStores?.project ?? selectDefaultProblemMemoryStore("PROJECT", manifest.projectId);
  const problemCommonStore: ProblemMemoryStore =
    opts.problemMemoryStores?.common ?? selectDefaultProblemMemoryStore("COMMON", undefined);
  // AutoDev 신뢰성 보완(2026-08-27, "현재 개발 라운드 대시보드 실시간 표시") — production이
  // 아니면 no-op이라(§ round-status.ts) 테스트가 실제 파일을 건드리지 않는다.
  const roundStatusReporter = selectDefaultRoundStatusReporter();

  if (isResumingApprovedCheckpoint) {
    // 이미 디스크에 저장된 승인된 상태(state, 이 함수 상단에서 loadState()로 읽은 값 —
    // reviewer가 APPROVED한 시점에 orchestrator.ts가 저장한 lastGptDecision/lastClaudeResult가
    // 그대로 남아있다)를 그대로 checkpoint 판단에 재사용한다. Developer/GPT Reviewer는 이
    // 분기에서 전혀 호출되지 않는다.
    console.log(
      `[autodev] task ${taskDef.id} — Human Final Review APPROVE 확인됨(reviewCycle=${state.reviewCycle}). developer/reviewer 재실행 없이 checkpoint로 재개합니다.`
    );
    emitEvent(events, {
      eventType: "TASK_STARTED",
      runId,
      projectId: manifest.projectId,
      taskId: taskDef.id,
      executionPhase: "checkpoint",
      outcome: "PENDING",
      reason: "HUMAN_FINAL_REVIEW_APPROVED_RESUME",
    });
    finalState = state;
  } else {
    // AutoDev / JARVIS Unattended Continuous Development Reliability Hardening Phase 3/4/5 —
    // Claude Developer/GPT Reviewer를 부르기 전에 required-test 등록 상태를 먼저 확인한다
    // (§ required-test-preflight.ts). 이 검사는 npm/claude 어떤 프로세스도 spawn하지 않는
    // 순수 fs 판정이다. 안전하게 증명 가능한 경우(task의 allowedPathPrefixes 안에 후보
    // *.test.mjs가 정확히 하나만 있는 경우 — 이전 시도가 이미 파일을 만들어둔 채 중단된
    // 경우)에는 여기서 즉시 package.json.scripts를 보강해 Developer가 헛되이 같은 npm
    // 오류를 다시 겪지 않게 한다. 후보가 아직 없다면(§ 새 task를 지금 막 시작하는 정상
    // 상태 — task의 requiredTests가 가리키는 실제 테스트 파일은 이 task의 Developer가
    // 구현 과정에서 만들 파일이다, 구현 전에는 존재하지 않는 것이 정상이다) 더 이상
    // Developer/Reviewer 호출을 막지 않는다(Phase 5) — REQUIRED_TEST_CONFIGURATION_ERROR는
    // "사람의 판단"이 필요한 문제가 아니라 순수 기술/설정 문제이기 때문이다(§ CLAUDE.md
    // WAITING_HUMAN 정책). Developer가 그 test 파일을 만들면, claude-developer.ts의
    // TASK_COMPLETE 처리 시점(같은 attempt 안, 새 REVISE 라운드 소비 없음)에 바로 이
    // 후보가 정확히 하나로 확정되어 같은 자동 등록이 다시 시도된다. Developer가 그래도 그
    // 파일을 만들지 않으면 npm run이 "Missing script"로 실패하고, 그 실패는 일반 required
    // test 실패와 동일하게 기존 GPT Reviewer REVISE 루프가 처리한다 — 이 preflight는 그
    // 흐름을 대신하지 않는다.
    const requiredTestPreflight = checkRequiredTestScriptRegistration(taskDef.requiredTests, executorContext.projectRoot);
    if (!requiredTestPreflight.ok) {
      const repair = attemptSafeRequiredTestScriptRepair(
        requiredTestPreflight.issues,
        executorContext.projectRoot,
        taskDef.allowedPathPrefixes
      );
      if (repair.repaired.length > 0) {
        console.log(
          `[autodev] task ${taskDef.id} — REQUIRED_TEST_CONFIGURATION 자동 복구: ${repair.repaired
            .map((r) => `${r.npmScript} -> ${r.expectedScript}`)
            .join(", ")}`
        );
        // 이 write를 즉시 별도 commit으로 확정한다(§ Phase 11 — Task 자신의 checkpoint와
        // 절대 섞지 않는다). commit이 실패해도(예: 동시성으로 index에 다른 변경이 함께
        // staged됨) package.json 내용 자체는 working tree에 이미 등록된 채로 남아 있어
        // 아래 Developer 호출을 막을 이유가 되지 않는다 — 그 uncommitted 변경은 이 task
        // 자신의 checkpoint(performTaskCheckpoint)가 범위 밖 예상치 못한 변경으로 이미
        // 다루는 기존 CHECKPOINT_SCOPE_VIOLATION 경로로 자연히 수렴한다(새 사람 대기
        // 경로를 여기서 만들지 않는다).
        const commit = commitRequiredTestScriptRepair(executorContext.projectRoot, repair.repaired);
        if (commit.ok) {
          console.log(`[autodev] task ${taskDef.id} — REQUIRED_TEST_CONFIGURATION 자동 복구 commit 완료(${commit.commitHash ?? "no-op"})`);
        } else {
          console.log(`[autodev] task ${taskDef.id} — REQUIRED_TEST_CONFIGURATION 자동 복구 commit 실패(uncommitted로 남음): ${commit.reason}`);
        }
      }
      if (repair.unresolved.length > 0) {
        // 후보가 아직 없거나(정상적인 "구현 전" 상태) 모호함(여러 후보) — 사람 판단이 필요한
        // 문제가 아니므로 WAITING_HUMAN으로 전환하지 않고, HUMAN_APPROVAL_REQUIRED event도
        // 만들지 않는다(Telegram은 실제 사람 판단이 필요한 상태에서만 쓴다는 정책과 일치).
        // Developer/Reviewer 호출을 막지 않고 그대로 진행한다 — § 위 주석.
        const detail = repair.unresolved.map((i) => `requiredTest=${i.requiredTestName} missingScript=${i.npmScript}`);
        console.log(
          `[autodev] task ${taskDef.id} — required test npm script 아직 미등록(${detail.join("; ")}) — 사람 판단이 필요한 문제가 아니므로 차단하지 않고 Developer를 그대로 호출합니다(구현 과정에서 파일이 생기면 TASK_COMPLETE 시점에 자동 등록됩니다).`
        );
      }
    }

    // AutoDev Core Maintenance(2026-08-30) — Deterministic Execution-Environment
    // Preflight(§ required-test-preflight.ts checkRequiredTestExecutionEnvironment,
    // AutodevRunOutcome.BLOCKED_REQUIRED_TEST_EXECUTION_ENVIRONMENT 상단 주석). 위 npm
    // script 등록 검사와 달리 이 검사가 찾는 문제(cwd가 resolve하는 디렉터리가 없음,
    // wrapper 파일 자체가 없음)는 Developer가 스스로 고칠 수 없는 project adapter config
    // 결함이다 — 그대로 Developer를 부르면 매 attempt마다 동일한
    // TRUSTED_EXECUTABLE_NOT_FOUND(또는 유사한) 실패만 반복하며 Claude 호출을 낭비한다(§
    // 실제 JARVIS Task 5.2 관측 — 이 검사가 도입되기 전 5회 반복). 그래서 이 검사는 npm
    // script 검사와 달리 실제로 차단한다 — Developer/Reviewer 어느 쪽도 부르지 않는다.
    //
    // P0-4 하드닝(2026-08-30, 독립 감사 — "Technical blocker와 Genuine Human Gate 완전
    // 분리") — 이전 정책은 이 상태를 "WAITING_HUMAN" + HUMAN_APPROVAL_REQUIRED(
    // humanInterventionRequired:true)로 표시했다. 이 결함은 execution-environment config
    // 문제일 뿐 실제 사업적/제품적/보안적/법적 "판단"이 필요한 게 아니다 — 그래서
    // MID_FLIGHT_CRASH_LOOP_DETECTED(§ 위 decideNextAction의 status==="BLOCKED" STOP 분기
    // 주석)와 동일한 원칙으로 "WAITING_HUMAN이 아니라 BLOCKED"를 쓴다: run.ts는 status===
    // "WAITING_HUMAN"일 때만 Telegram controller를 계속 살려 승인을 기다리므로(waitWhileWaitingHuman),
    // BLOCKED를 쓰면 이 프로세스가 정상 종료하고 runner-supervisor.ts의 bounded backoff
    // 재시작이 "기존 AutoDev의 technical BLOCKED / retry / recovery 구조"를 그대로
    // 제공한다(§ 요구사항 P0-4). 아래 재검사(§ reconcileStaleRequiredTestExecutionEnvironmentTasks
    // 호출부, status==="BLOCKED"도 함께 확인하도록 확장)가 매 재시작마다 이 결함이 여전히
    // 재현되는지 deterministic하게 다시 확인해, 해소되면 사람의 명시적 APPROVE 없이도 자동으로
    // READY로 되돌린다.
    // Hardening G(Prerequisite Feasibility) — feasibilityContext를 넘겨 issue에
    // EXPECTED_GREENFIELD/MISSING_PREREQUISITE/UNSATISFIABLE_PREREQUISITE 분류가 함께
    // 남도록 한다(§ required-test-preflight.ts classifyPrerequisiteFeasibility) — 이
    // 분류 자체는 BLOCK 여부를 바꾸지 않는다, 순수 진단 정보다.
    const executionEnvironmentPreflight = checkRequiredTestExecutionEnvironment(
      taskDef.requiredTests,
      executorContext,
      taskDef.allowedPathPrefixes,
      undefined,
      { currentTaskId: taskDef.id, registry: manifest.taskRegistry }
    );
    if (executionEnvironmentPreflight.deferredGreenfield.length > 0) {
      log("REQUIRED_TEST_EXECUTION_ENVIRONMENT greenfield defer 적용 — Developer 호출 전 차단하지 않음", {
        taskId: taskDef.id,
        deferredGreenfield: executionEnvironmentPreflight.deferredGreenfield,
      });
    }
    if (!executionEnvironmentPreflight.ok) {
      const detail = executionEnvironmentPreflight.issues
        .map(
          (i) =>
            `requiredTest=${i.requiredTestName} kind=${i.kind} cwd=${i.cwd} resolvedPath=${i.resolvedPath} reason=${i.reason ?? ""}` +
            (i.prerequisiteFeasibility ? ` prerequisiteFeasibility=${i.prerequisiteFeasibility.feasibility}(${i.prerequisiteFeasibility.reason})` : "")
        )
        .join("; ");
      console.log(
        `[autodev] task ${taskDef.id} — required test 실행 환경 결함 감지(${detail}) — Developer를 부르지 않고 기술적 BLOCKED로 전환합니다(project adapter config의 commandCwdAliases/requiredTest.cwd를 직접 확인/수정해야 합니다 — 사람 승인이 아니라 기술적 안전정지입니다).`
      );
      log("REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR — Developer 호출 전 차단(기술적 BLOCKED, Human Gate 아님)", {
        taskId: taskDef.id,
        issues: executionEnvironmentPreflight.issues,
      });
      state.status = "BLOCKED";
      for (const issue of executionEnvironmentPreflight.issues) {
        state.deferredHumanTasks.push(
          `REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR: task=${taskDef.id} requiredTest=${issue.requiredTestName} kind=${issue.kind} cwd=${issue.cwd} resolvedPath=${issue.resolvedPath}`
        );
      }
      emitEvent(events, {
        eventType: "RUN_BLOCKED",
        runId,
        projectId: manifest.projectId,
        taskId: taskDef.id,
        executionPhase: "task_selection",
        outcome: "BLOCKED",
        reason: `REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR(${taskDef.id}): ${detail}`,
      });
      saveState(state, statePath);
      // 이 분기는 Developer/checkpoint 어느 쪽도 시작하지 않았다 — working tree에 아무
      // 위험도 남기지 않았으므로 안전하게 release한다(lockShouldRelease는 기본값 true
      // 그대로, § BLOCKED_PROJECT_LOCK/BLOCKED_REMOTE_GIT과 동일한 원칙).
      return { outcome: "BLOCKED_REQUIRED_TEST_EXECUTION_ENVIRONMENT", taskId: taskDef.id, reason: detail };
    }

    // AutoDev 최종 통합 하드닝(Hardening A) — execution-contract.ts를 runtime invariant로.
    // spec-planner.ts는 계획 생성 시점에 이미 동일한 검증을 통과시켰지만, 그 이후 project
    // adapter가 수동 편집되거나 서로 다른 generation의 산출물이 섞였을 가능성을
    // Developer를 부르기 직전에 다시 한 번 재확인한다(§ 새 validator를 만들지 않고
    // validateRequiredTestExecutionContract를 그대로 재사용). 이 task의 requiredTest만
    // 검사한다 — 다른 task까지 매번 전수 재검증하지 않는다(이 시점에 필요한 것은 "지금
    // 부르려는 이 task가 실행 가능한가"뿐이다).
    const executionContractIssues = validateRequiredTestExecutionContract(
      [{ taskId: taskDef.id, requiredTests: taskDef.requiredTests }],
      manifest.executionPolicy.commandCwdAliases,
      manifest.executionPolicy.allowedCommands
    );
    if (executionContractIssues.length > 0) {
      const detail = executionContractIssues.map((i) => i.reason).join("; ");
      console.log(
        `[autodev] task ${taskDef.id} — execution contract mismatch 감지(${detail}) — Developer를 부르지 않고 기술적 BLOCKED로 전환합니다(task-registry.json의 requiredTests와 execution-policy.json의 allowedCommands/commandCwdAliases가 서로 실행 가능하게 맞물리지 않습니다 — project adapter를 직접 확인/수정해야 합니다).`
      );
      log("EXECUTION_CONTRACT_MISMATCH — Developer 호출 전 차단(기술적 BLOCKED, Human Gate 아님, DETERMINISTIC_LOCAL)", {
        taskId: taskDef.id,
        issues: executionContractIssues,
      });
      state.status = "BLOCKED";
      for (const issue of executionContractIssues) {
        state.deferredHumanTasks.push(`EXECUTION_CONTRACT_MISMATCH: task=${taskDef.id} testName=${issue.testName ?? ""} reason=${issue.reason}`);
      }
      emitEvent(events, {
        eventType: "RUN_BLOCKED",
        runId,
        projectId: manifest.projectId,
        taskId: taskDef.id,
        executionPhase: "task_selection",
        outcome: "BLOCKED",
        reason: `EXECUTION_CONTRACT_MISMATCH(${taskDef.id}): ${detail}`,
      });
      saveState(state, statePath);
      return { outcome: "BLOCKED_EXECUTION_CONTRACT_MISMATCH", taskId: taskDef.id, reason: detail };
    }

    // AutoDev 최종 통합 하드닝(Hardening E, No-Progress를 Hard Switch로) —
    // buildNoWriteStrategyEscalationHint(§ 아래 memoryHint 조립부)는 WRITE 없이 연속
    // 실패한 횟수가 늘어날수록 더 강한 prompt 문구를 보여줄 뿐, 그 자체로는 상한이 없다 —
    // 같은 "prompt hint만 바꾸는" 전략을 무한히 반복하며 Developer 호출만 계속 소비할 수
    // 있다(§ "같은 전략을 계속 반복하지 않는다" 원칙). durable-recovery-state.ts가 이미
    // process 재시작을 넘어 누적하는 noWriteRepeatCount를(§ LOCAL_ROOT_CAUSE_MODE와 동일한
    // 출처 — 새 카운터를 만들지 않는다) 위 MID_FLIGHT_CRASH_LOOP_DETECTED가 쓰는
    // MAX_MID_FLIGHT_UNEXPECTED_EXIT_COUNT(=5, "몇 번의 기회까지 허용하는가"에 대한 이
    // 함수의 기존 기준)와 비교한다 — 새 arbitrary magic number를 만들지 않는다. 상한에
    // 도달하면 문구만 더 강하게 바꾸는 대신 실제로 전략을 전환한다: Developer를 다시
    // 호출하지 않고 즉시 기술적 BLOCKED로 전환한다(genuine WAITING_HUMAN이 아니다 —
    // MID_FLIGHT_CRASH_LOOP_DETECTED/EXECUTION_CONTRACT_MISMATCH와 동일한 원칙: 사람의
    // 사업적/보안적 "판단"이 필요한 문제가 아니라, 증명된 비생산적 전략을 자동으로 계속
    // 반복하지 않게 막는 deterministic 안전장치다).
    const noWriteDurableState = loadDurableFailureStateForTask(state, taskDef.id);
    const noWriteDurableRepeatCount = noWriteDurableState.noWriteRepeatCount ?? 0;
    if (noWriteDurableRepeatCount >= MAX_MID_FLIGHT_UNEXPECTED_EXIT_COUNT) {
      const reason = `NO_WRITE_STRATEGY_EXHAUSTED: task=${taskDef.id} noWriteRepeatCount=${noWriteDurableRepeatCount}`;
      log("NO_WRITE_STRATEGY_EXHAUSTED — WRITE 없이 반복된 실패 상한 초과, 동일 전략(prompt hint) 반복을 멈추고 Developer 재호출 없이 기술적 BLOCKED로 전환(Human Gate 아님, DETERMINISTIC_LOCAL)", {
        taskId: taskDef.id,
        noWriteRepeatCount: noWriteDurableState.noWriteRepeatCount,
      });
      console.log(
        `[autodev] task ${taskDef.id} — NO_WRITE_STRATEGY_EXHAUSTED(${noWriteDurableState.noWriteRepeatCount}회 연속 WRITE 없이 실패) — 같은 prompt 전략 반복을 멈추고 기술적 BLOCKED로 전환합니다(사람이 접근 자체를 재검토해야 합니다).`
      );
      state.status = "BLOCKED";
      state.deferredHumanTasks.push(reason);
      saveState(state, statePath);
      emitEvent(events, {
        eventType: "RUN_BLOCKED",
        runId,
        projectId: manifest.projectId,
        taskId: taskDef.id,
        executionPhase: "task_selection",
        outcome: "BLOCKED",
        reason,
      });
      // MID_FLIGHT_CRASH_LOOP_DETECTED와 동일한 원칙 — 근본 원인(반복적으로 비생산적인
      // 전략)이 해소될 때까지(예: 사람이 task 정의/접근을 직접 재검토) 다른 writer가 같은
      // 실패를 즉시 다시 반복하지 않도록 lock을 유지한다. 완전히 잠기는 것은 아니다 — 이
      // 프로세스가 종료되면 project-lock.ts의 기존 stale lock 복구가 다음 시도의 자연스러운
      // 재시도 속도를 늦추는 역할을 한다(§ 요구사항 9와 동일한 원칙).
      lockShouldRelease = false;
      return { outcome: "BLOCKED_NO_WRITE_STRATEGY_EXHAUSTED", taskId: taskDef.id, reason };
    }

    console.log(`[autodev] 다음 task 선택: ${taskDef.id} — ${taskDef.title}`);
    emitEvent(events, { eventType: "TASK_STARTED", runId, projectId: manifest.projectId, taskId: taskDef.id, executionPhase: "task_selection", outcome: "PENDING" });

    // Phase F Task F4.1 — pre-development advisory(planner/research). taskDef의 신호가
    // 없으면 즉시 undefined이고 LLM 호출이 전혀 없다.
    preAdvisory = await runPreDevelopmentAdvisory(taskDef, opts.advisoryReadOnlyRunner);
    if (preAdvisory && preAdvisory.length > 0) {
      console.log(`[autodev] task ${taskDef.id} — pre-development advisory 실행: ${preAdvisory.map((r) => `${r.role}=${r.status}`).join(", ")}`);
    }
    emitAdvisoryAgentEvents(events, runId, manifest.projectId, taskDef.id, "pre_development", preAdvisory);

    // manifest.developerInstructions/reviewInstructions는 Claude Developer/GPT Reviewer
    // Core(claude-developer.ts/gpt-reviewer.ts)가 전혀 모르는 프로젝트별 내용이다 — 이 파일이
    // ProjectManifest로부터 조립해 명시적으로 주입한다(Phase A Task A6). 어떤 manifest가
    // 주입되든(MOVAN이든 fixture든) 동일한 방식으로 조립되므로 이 파일은 프로젝트를 가리지 않는다.
    //
    // Phase F Task F4.1 — pre-development advisory가 실행됐다면 그 요약(summary)만 추가
    // 안내로 덧붙인다(rawOutput 전체는 재전송하지 않는다 — § 토큰 효율).
    const developerContext: DeveloperProjectContext = {
      projectName: manifest.projectName,
      instructions:
        preAdvisory && preAdvisory.length > 0
          ? `${manifest.developerInstructions}\n\n# Pre-development advisory 참고\n${preAdvisory.map((r) => `[${r.role}] ${r.summary}`).join("\n")}`
          : manifest.developerInstructions,
    };
    const reviewContext: ReviewProjectContext = {
      projectName: manifest.projectName,
      instructions: manifest.reviewInstructions,
      scopeDirs: manifest.reviewScopeDirs,
      rulesPath: manifest.rulesPath,
    };

    // AutoDev 지능형 오류 복구 하드닝(Problem-Solving Knowledge Store) — 이 run(runAutodevOnce
    // 1회 호출) 동안만 유효한 loop-local 상태다(orchestrator.ts의 gptCallCount/
    // stagnationTracker와 동일한 원칙 — project-state.json에 저장하지 않는다). store 자체는
    // 위(if/else 밖)에서 이미 만들었다 — checkpoint 확정 코드도 같은 인스턴스를 참조해야
    // 하기 때문이다.
    const memoryStagnationTracker = createStagnationTracker();
    // Secret Scanner 사전검사(§ defaultClaudeRunner 아래) 전용 stagnation tracker — 별도
    // 인스턴스를 쓴다(memoryStagnationTracker와 fingerprint 도메인이 다르므로 하나를 같이
    // 쓰면 "번갈아 관찰"에 의해 repeatCount가 절대 2에 도달하지 못하는 버그가 생긴다).
    const secretPrecheckTracker = createStagnationTracker();
    let previousAttemptResult: ClaudeResult | undefined;
    // AutoDev / JARVIS 최종 무인개발 하드닝 — Fireworks Same-Finding Call Limiting & Root
    // Cause Analysis(§ root-cause-analysis.ts)가 RCA를 트리거하면(동일 reviewer finding이
    // 2회 연속 REVISE로 반복됨) 이 run 전용 wrapped gptReviewer가 그 사실을 여기 채워 넣는다
    // — defaultClaudeRunner가 다음 라운드 시작 시 이 값을 읽어 memoryHint에 반영하고 소비한다
    // (loop-local, project-state.json에 저장하지 않는다 — previousAttemptResult와 동일한 원칙).
    let pendingRootCauseGuidance: RootCauseAnalysisEvent | undefined;
    // AutoDev / JARVIS Unattended Continuous Development Reliability Hardening Phase 6 —
    // 이 task가 이전의 별도 실행(runAutodevOnce 프로세스 자체가 다시 시작된 경우 포함)에서
    // 이미 한 번 시도됐지만 아직 승인(decision==="PASS")되지 못한 채 끝났다면, 그 결과를 이번
    // fresh 실행의 "직전 시도"로 간주해 아래(§ Section 4/5/9/10) 실패 기억/전략 전환 로직이
    // 이어서 재사용하게 한다. 이 seed가 없으면 매 runAutodevOnce() 호출마다
    // previousAttemptResult가 항상 undefined로 초기화되어(§ loop-local, 위 주석) 같은 task를
    // 재시도하는 새 프로세스는 직전 시도의 실패를 전혀 모른 채 시작한다 — 실제 JARVIS Task 2.1
    // 재현 사례(허용 경로 밖에 남은 미승인 변경을 다음 시도가 "이미 구현됨"으로 오인)의 근본
    // 원인이었다. decideNextAction()은 completedTasks에 없는 task만 다시 선택하므로, 이
    // leftover state는 항상 지금 선택된 이 task 자신의 것이다(AutoDev는 한 번에 한 task만
    // 순차 처리한다 — 다른 task의 실패가 섞여 들어올 여지가 없다).
    // AutoDev Core Maintenance — Greenfield/Timeout Discovery Progress Persistence(2026-08-31,
    // JARVIS Task 5.3 실측: 위 seed는 원래 "Reviewer가 REVISE한 직전 시도"만 다뤘다 —
    // Developer 자신이 TIMEOUT 등으로 실패하면 Reviewer가 아예 호출되지 않아
    // state.lastGptDecision이 null로 남고, 이 조건이 항상 false가 되어 previousAttemptResult가
    // 절대 seed되지 않았다. 그 결과 discoveryProgress(§ claude-developer.ts)를 만들어도 다음
    // attempt에 전달할 경로가 없어 매번 discovery를 완전히 처음부터 반복했다(§ 실제 production
    // 관측 — 5회 연속 TIMEOUT, WRITE 0). Developer 자신의 실패(success===false)도 동일한
    // "같은 task의 직전 시도" 원칙으로 seed한다 — 위 주석의 안전조건(decideNextAction이 이
    // task 자신의 leftover만 선택)은 이 경우에도 동일하게 성립한다.
    if (
      state.lastClaudeResult &&
      ((state.lastGptDecision && state.lastGptDecision.decision !== "PASS") || state.lastClaudeResult.success === false)
    ) {
      previousAttemptResult = state.lastClaudeResult;
    }

    // Positive-Provenance-Only Auto-Delete Policy(2026-08-31, JARVIS Task 5.3 Canary
    // 사실검증 후속 — "AutoDev가 자신이 만들었다고 증명할 수 없는 파일을 자동삭제하는 경로가
    // 절대로 존재하지 않도록 한다") — 이 블록은 예전에(Phase 7, 2026-08-27) 직전 시도가
    // scope violation으로 BLOCK되면 그 남은 파일을 자동으로 rmSync해서 지웠다. 그 뒤
    // baseline-absence 기반 안전조건(§ 이전 커밋 a4d7e0e)을 추가했지만, 실제 조사
    // 결과(§ 아래) baseline에 없다는 사실 자체가 "AutoDev/Claude Developer가 이 파일을
    // 만들었다"는 증명이 될 수 없다는 것이 확인됐다 — 이 저장소에는 파일 경로를 taskId/
    // attempt/round에 연결하는 durable action log가 어디에도 없다(claude-developer.ts의
    // ClaudeResult.changedFiles조차 실제로는 매 라운드 getWorkingTreeChanges()로 다시 계산한
    // git status 기반 diff일 뿐이다 — "AutoDev가 실제로 이 action으로 이 파일을 썼다"는 기록이
    // 아니다). 즉 baseline-absence("task 시작 시점엔 없었다")와 authorship proof("AutoDev가
    // 만들었다")는 서로 다른 주장이며, 이 저장소에는 후자를 증명할 방법이 구조적으로 없다 —
    // 같은 시간 창에 사용자/IDE/빌드도구/동기화 프로그램이 파일을 만들었을 가능성을 이 저장소
    // 스스로는 배제할 수 없다.
    //
    // 따라서 이 블록은 더 이상 어떤 파일도 삭제하지 않는다. 대신 "cleanup 대상으로 보였던
    // 파일"을 순수 관측용으로 로그만 남긴다 — Developer가 다음 attempt에서 올바른 경로에
    // 정확히 다시 구현해도 이 leftover가 계속 남아 있으면 checkpoint가 매번 다시 scope
    // violation으로 BLOCK된다(예전에는 자동 삭제로 "자가치유"됐던 실제 JARVIS Task 2.1류
    // 시나리오가 이제는 사람이 직접 그 파일을 처리해야만 풀린다 — 이것은 이 정책의 의도된
    // trade-off다, "무인화를 유지하기 위해 안전성을 희생하지 않는다"). 무한 재시도는 아니다
    // — 이 task가 계속 진행하지 못하면(CONTINUABLE_OUTCOME 없음) continuous-runner.ts의
    // technicalRecoveryCount가 매 재시도마다 증가해 결국 TECHNICAL_RECOVERY_LIMIT_REACHED로
    // 멈춘다(§ continuous-runner.ts DEFAULT_MAX_TECHNICAL_RECOVERY_ATTEMPTS — 이미 존재하는
    // 별도 bound, 이 블록이 새로 만들지 않는다).
    //
    // No-Safe-Recovery-Action Gate(2026-08-31) — Core checkpoint 자신의 독립 scope-violation
    // 판정(CHECKPOINT_SCOPE_VIOLATION_REASON)은 이제 genuine으로 분류되어(§
    // human-gate-policy.ts) 이 reconcile 블록 자체에 절대 도달하지 않는다 — 그래서 여기서는
    // GPT Reviewer 자신이 BLOCK 판정과 함께 보고한 scopeViolations만 후보로 쓴다(코드 품질
    // 등 다른 이유로 여전히 기술적 자동 복구 대상인 BLOCK decision에 곁다리로 딸려온 out-of-
    // scope 목록 — 이 목록의 파일도 "AutoDev가 만들었다"를 증명하지 못하는 것은 동일하므로
    // 여전히 삭제하지 않고 로그만 남긴다).
    const lastGptDecisionForCleanup = state.lastGptDecision as (typeof state.lastGptDecision & { scopeViolations?: string[] }) | null;
    const gptReportedScopeViolations =
      lastGptDecisionForCleanup && lastGptDecisionForCleanup.decision !== "PASS" && lastGptDecisionForCleanup.scopeViolations
        ? lastGptDecisionForCleanup.scopeViolations
        : [];
    const cleanupCandidates = Array.from(new Set(gptReportedScopeViolations));
    if (cleanupCandidates.length > 0) {
      const currentUntracked = new Set(getWorkingTreeChanges([], executorContext.projectRoot).untracked.map((c) => c.path));
      const stillPresentOutOfScope = cleanupCandidates.filter(
        (p) => currentUntracked.has(p) && !isPathWithinAllowedPrefixes(p, taskDef.allowedPathPrefixes)
      );
      if (stillPresentOutOfScope.length > 0) {
        log(
          "직전 시도의 scope-violation 파일이 여전히 남아있음 — 자동 삭제하지 않음(AutoDev는 이 파일을 자신이 만들었다고 증명할 방법이 없다, fail-closed)",
          { taskId: taskDef.id, paths: stillPresentOutOfScope }
        );
      }
    }

    // AutoDev 신뢰성 보완(2026-08-27, "응답 형식 오류도 기존 문제 해결 흐름에 포함") — 이
    // 정확한 task가 과거에 PROTOCOL_ERROR(§ claude-developer.ts PROTOCOL_FAILURE_HARD_STOP)로
    // 중단된 적이 있으면, 매번 3라운드를 소진한 뒤에야(2회차 실패 시점) 나오는
    // RESPONSE_CONTRACT_REINFORCEMENT_MESSAGE를 기다리지 않고 최초 라운드부터 JSON 계약을
    // 미리 상기시킨다(§ 요구사항 "동일 문제 재발 시 더 빠른 해결"). 정확히 같은 fingerprint가
    // 재현된다는 보장은 없으므로 구체적 해결책을 단정하지 않고, 일반 계약 재안내만 앞당긴다 —
    // problemProjectStore.load()는 이 run에서 한 번만 호출한다.
    const hadPriorProtocolFailureForThisTask = problemProjectStore
      .load()
      .some((e) => e.projectId === manifest.projectId && e.taskId === taskDef.id && e.errorCode === "PROTOCOL_ERROR");
    const PRIOR_PROTOCOL_FAILURE_HINT =
      "# AutoDev 안내(과거 응답 형식 문제 이력)\n" +
      "이 작업은 과거에 Claude 응답을 AutoDev 프로토콜(TASK_COMPLETE/PLAN/ACTION_REQUEST)로 해석하지 못해 중단된 적이 있습니다. " +
      "다른 텍스트나 코드펜스 없이 세 형태 중 정확히 하나의 순수 JSON 객체만 출력하세요(ACTION_REQUEST의 actions는 항상 배열).";

    // AutoDev Core Maintenance(2026-08-30) — claude-developer.ts는 event-store.ts를 전혀
    // 모른다(§ DeveloperTaskOptions.onContextMetrics 주석) — 이 콜백이 그 경계를 지킨 채
    // durable 저장을 담당한다. round당 1건이라 attempt당 최대 MAX_INTERNAL_ROUNDS(20)건 —
    // TEST_COMPLETED 등 기존 event들과 동일한 크기 수준이라 별도 rate limit을 두지 않는다.
    const emitDeveloperContextMetrics = (metrics: DeveloperContextMetrics): void => {
      emitEvent(events, {
        eventType: "DEVELOPER_CONTEXT_METRICS",
        runId,
        projectId: manifest.projectId,
        taskId: taskDef.id,
        executionPhase: "development",
        metadata: {
          attempt: metrics.attempt,
          round: metrics.round,
          systemPromptChars: metrics.systemPromptChars,
          transcriptChars: metrics.transcriptChars,
          transcriptEntryCount: metrics.transcriptEntryCount,
          fileSnapshotChars: metrics.fileSnapshotChars,
          fileSnapshotCount: metrics.fileSnapshotCount,
          duplicateReadCount: metrics.duplicateReadCount,
          trimmedThisRound: metrics.trimmedThisRound,
        },
      });
    };
    // AutoDev Core Maintenance(2026-08-30) — § work-time.ts computeUsageLimitWaitMs 주석.
    const emitDeveloperUsageLimitWait = (info: { round: number; retryCount: number; waitMs: number; phase: "START" | "END" }): void => {
      emitEvent(events, {
        eventType: info.phase === "START" ? "DEVELOPER_USAGE_LIMIT_WAIT_STARTED" : "DEVELOPER_USAGE_LIMIT_WAIT_ENDED",
        runId,
        projectId: manifest.projectId,
        taskId: taskDef.id,
        executionPhase: "development",
        metadata: { round: info.round, retryCount: info.retryCount, waitMs: info.waitMs },
      });
    };

    // AutoDev 신뢰성 수정(2026-08-26) — runDeveloperTaskViaSafeExecutor를 직접 부르지 않고
    // runDeveloperTaskWithRetry로 감싼다. TIMEOUT/CLI_NOT_FOUND처럼 명확히 일시적인 실패는
    // 최대 2회까지 자동 재시도(총 3회 시도)한 뒤에도 계속되면 그때 실패로 반환한다(§
    // claude-developer.ts isTransientDeveloperFailure) — orchestrator.ts는 이 재시도를
    // 전혀 모른 채 최종 결과 하나만 받으므로 기존 REVISE/WAITING_HUMAN 상태 머신은 손대지
    // 않는다.
    const defaultClaudeRunner = async (task: string, attempt: number): Promise<ClaudeResult> => {
      // Section 4/5/9/10 — 새 문제라고 바로 Claude를 다시 부르는 것 자체는 막을 수 없다
      // (Developer 호출 자체가 "무엇을 시도할지"를 만든다), 대신 직전 시도가 required test에
      // 실패했다면 그 프롬프트에 과거 해결 사례/반복 실패 전략 전환 안내를 덧붙여, 같은
      // 실수를 맹목적으로 반복하지 않게 한다(§ claude-developer.ts opts.memoryHint).
      let memoryHint: string | undefined;
      let lookupEntryIdThisCycle: string | undefined;
      // AutoDev Core Maintenance — Greenfield/Timeout Discovery Progress Persistence
      // (2026-08-31, JARVIS Task 5.3 실측 — 회귀 재발견). previousAttemptResult 확장(§ 위
      // seed 조건) 이전에는 hadPriorProtocolFailureForThisTask 안내가 "previousAttemptResult가
      // 없을 때만"(!previousAttemptResult) 나가는 fallback이었다 — Developer 자신의 실패도
      // previousAttemptResult로 seed되도록 넓히면서 이 fallback 조건이 거의 항상 false가 되어
      // 안내가 조용히 사라지는 회귀가 생겼다(§ scenarioProtocolErrorRecordedAndSpeedsUpNextAttempt
      // 재현). PRIOR_PROTOCOL_FAILURE_HINT는 problemProjectStore(previousAttemptResult와 무관한
      // 별도 영속 이력)를 근거로 하므로, hintParts 안에서 그 자체 조건(hadPriorProtocolFailureForThisTask)
      // 으로만 독립적으로 판단해 두 안내가 필요하면 함께 실린다.
      if (previousAttemptResult || hadPriorProtocolFailureForThisTask) {
        const hintParts: string[] = [];

        if (hadPriorProtocolFailureForThisTask) {
          hintParts.push(PRIOR_PROTOCOL_FAILURE_HINT);
        }

      if (previousAttemptResult) {
        // AutoDev / JARVIS 최종 무인개발 하드닝 — RCA가 트리거됐다면(§ root-cause-analysis.ts)
        // 그 분류/권장 조치/직전 Reviewer 지적을 이번 라운드 프롬프트에 명시적으로 전달한다
        // (§ 요구사항 17 IMPLEMENTATION_ERROR 복구 — "막연한 REVISE가 아니라 이전 finding을
        // 함께 전달"). 한 번 소비하면 즉시 비운다 — 같은 안내를 여러 라운드에 반복하지 않는다.
        if (pendingRootCauseGuidance) {
          const g = pendingRootCauseGuidance;
          pendingRootCauseGuidance = undefined;
          hintParts.push(
            "# AutoDev 안내(Root Cause Analysis — 동일 reviewer finding 반복)\n" +
              "동일한 reviewer 지적사항이 연속으로 반복되어 AutoDev가 근본원인 분석을 수행했습니다. " +
              "이미 시도한 접근을 그대로 반복하지 말고 아래 지적을 정확히 해결하세요:\n" +
              `- 분류: ${g.category}\n` +
              `- 권장 조치: ${g.recoveryAction}\n` +
              `- 직전 Reviewer 지적: ${g.priorFeedback}`
          );
        }

        // AutoDev / JARVIS Unattended Continuous Development Reliability Hardening Phase 6 —
        // 직전 시도가 scope violation(allowedPathPrefixes 밖 변경)으로 승인되지 않았다면,
        // 그 파일들을 "이미 완료된 기존 구현"이 아니라 "미승인 변경"으로 명시한다 — 그렇지
        // 않으면 Developer가 working tree에 남아있는 그 파일들을 발견하고 완료된 것으로
        // 오인해 아무 수정 없이 다시 TASK_COMPLETE를 선언할 수 있다(실제 JARVIS Task 2.1
        // 2차 시도에서 재현된 실패 패턴).
        const lastGptDecisionWithScope = state.lastGptDecision as (typeof state.lastGptDecision & { scopeViolations?: string[] }) | null;
        if (
          lastGptDecisionWithScope &&
          lastGptDecisionWithScope.decision !== "PASS" &&
          lastGptDecisionWithScope.scopeViolations &&
          lastGptDecisionWithScope.scopeViolations.length > 0
        ) {
          hintParts.push(
            "# AutoDev 안내(직전 시도 — 미승인, 검토 실패)\n" +
              "다음 파일은 이미 완료된 기존 구현이 아닙니다. 직전 시도에서 만들어졌지만 아직 " +
              "commit되지 않았고, GPT Reviewer가 이 task의 허용 경로(allowedPathPrefixes) 밖 " +
              "변경이라는 이유로 승인하지 않았습니다:\n" +
              `- 허용 경로 밖 변경 파일: ${lastGptDecisionWithScope.scopeViolations.join(", ")}\n` +
              `- Reviewer 지적: ${lastGptDecisionWithScope.feedback}\n` +
              "이 파일들을 그대로 두고 완료로 선언하지 마세요 — 지적 사유를 해결하도록 허용된 " +
              "경로로 옮기거나 수정하고, 더 이상 필요 없는 파일이면 삭제하세요."
          );
        }

        if (hasFailedRequiredTest(previousAttemptResult.tests)) {
          const fingerprint = computeProblemFingerprint(previousAttemptResult.tests);
          const repeatCount = memoryStagnationTracker.observe(fingerprint);
          const priorFailedDescriptions = problemProjectStore
            .load()
            .filter((e) => e.projectId === manifest.projectId && e.taskId === taskDef.id && e.fingerprint === fingerprint)
            .flatMap((e) => e.attemptedSolutions.filter((s) => s.outcome === "FAILURE").map((s) => s.description));

          // AutoDev Core Maintenance(2026-08-30) — LOCAL_ROOT_CAUSE_MODE. 동일 required-test
          // 실패 fingerprint가 이미 MAX_SAME_FAILURE_LOCAL_DEVELOPER_CALLS번 관측됐다면, 다음
          // Developer 호출 "전에" 먼저 실행 환경을 결정론적으로 재확인한다(§
          // required-test-preflight.ts checkRequiredTestExecutionEnvironment, Phase 1과 동일한
          // 함수 — 로직 복제 없음). 여전히 같은 결함이 확정되면(설정을 아무도 고치지 않았다는
          // 뜻) Developer를 실제로 호출하지 않고, 변화 없는 동일 실패를 그대로 합성해 반환한다
          // — 이 attempt는 Claude 호출 0회다. 사람이 config를 고치면(§ Phase 9) 다음 cycle의
          // 이 재확인이 자연히 통과해 정상적으로 다시 Developer를 호출한다(fail-open이 아니라
          // "원인이 실제로 해소됨을 재확인"이므로 안전하다). execution-environment 문제가
          // 아닌 다른 반복(예: 순수 구현 결함)은 이 재확인이 항상 ok:true이므로 이 분기를
          // 타지 않고 기존 buildEscalationGuidance 경로(아래)로 그대로 진행한다 — 이
          // LOCAL_ROOT_CAUSE_MODE는 결정론적으로 재확인 가능한 execution-environment
          // 카테고리만 다룬다(§ 요구사항 — 추측으로 "변화 없음"을 판정하지 않는다).
          if (repeatCount >= MAX_SAME_FAILURE_LOCAL_DEVELOPER_CALLS) {
            const envRecheck = checkRequiredTestExecutionEnvironment(taskDef.requiredTests, executorContext, taskDef.allowedPathPrefixes, undefined, {
              currentTaskId: taskDef.id,
              registry: manifest.taskRegistry,
            });
            if (!envRecheck.ok) {
              const detail = envRecheck.issues
                .map(
                  (i) =>
                    `requiredTest=${i.requiredTestName} kind=${i.kind} cwd=${i.cwd} resolvedPath=${i.resolvedPath}` +
                    (i.prerequisiteFeasibility ? ` prerequisiteFeasibility=${i.prerequisiteFeasibility.feasibility}(${i.prerequisiteFeasibility.reason})` : "")
                )
                .join("; ");
              // AutoDev Core Maintenance(2026-08-30) — advisory-only(§ problem-memory.ts
              // lookupSolutionsByRootCauseClass 주석 — "검증된 정답이 아니라 우선 검토할
              // 후보"). Developer를 호출하지 않으므로 프롬프트에 주입하지 않는다 — 사람이
              // WAITING_HUMAN/로그를 확인할 때 참고할 수 있도록 로그에만 남긴다.
              const similarCases = lookupSolutionsByRootCauseClass({
                errorType: "INFRASTRUCTURE_CONFIGURATION",
                projectId: manifest.projectId,
                projectStore: problemProjectStore,
                commonStore: problemCommonStore,
              });
              // Hardening F(Diagnostic Evidence Bundle) — 다음 round/다음 project가 이 조사를
              // 처음부터 반복하지 않도록, 이미 이 지점에서 알고 있는 정보를 하나의 구조로
              // 묶어 함께 남긴다(§ diagnostic-evidence-bundle.ts — 새 조사 없음, 이미 계산된
              // 값만 조합). 기존 issues/similarCasesAdvisory 필드는 그대로 유지한다(정보
              // 손실 없음) — bundle은 그 위에 대표 이슈 1건 + retries/다음 행동만 추가한다.
              const firstIssue = envRecheck.issues[0];
              const firstSimilarCase = similarCases[0];
              const evidenceBundle = buildDiagnosticEvidenceBundle({
                taskId: taskDef.id,
                failureClass: "DETERMINISTIC_LOCAL",
                failureClassReason: "required test 실행 환경 결함이 재확인에서도 그대로 확정됨 — Developer 재시도로 해결되지 않음.",
                requiredTestName: firstIssue?.requiredTestName,
                cwd: firstIssue?.cwd,
                prerequisiteFeasibility: firstIssue?.prerequisiteFeasibility?.feasibility,
                prerequisiteFeasibilityReason: firstIssue?.prerequisiteFeasibility?.reason,
                retries: repeatCount,
                problemMemoryMatch: firstSimilarCase ? { tier: firstSimilarCase.tier, entryId: firstSimilarCase.entry.id } : null,
                priorVerifiedResolutionSummary: firstSimilarCase?.entry.finalSuccessfulSolution ?? null,
                nextDeterministicAction: "project adapter config(commandCwdAliases/requiredTest.cwd)를 직접 확인/수정해야 합니다.",
              });
              log("LOCAL_ROOT_CAUSE_MODE — required test 실행 환경 결함이 반복 확정되어 Developer를 다시 호출하지 않습니다", {
                taskId: taskDef.id,
                repeatCount,
                issues: envRecheck.issues,
                similarCasesAdvisory: similarCases.map((c) => ({ tier: c.tier, entryId: c.entry.id, solution: c.entry.finalSuccessfulSolution })),
                evidenceBundle,
              });
              console.log(
                `[autodev] task ${taskDef.id} — LOCAL_ROOT_CAUSE_MODE(execution environment, ${repeatCount}회 반복 확정, ${detail}) — Developer를 호출하지 않고 동일 실패를 그대로 반환합니다.`
              );
              return {
                success: true,
                summary: `LOCAL_ROOT_CAUSE_MODE — required test 실행 환경 결함(${detail})이 재확인에서도 그대로 확정되어 Developer를 다시 호출하지 않았습니다. project adapter config(commandCwdAliases/requiredTest.cwd)를 직접 확인/수정해야 합니다.`,
                changedFiles: [],
                tests: previousAttemptResult.tests,
                rawOutput: "",
              };
            }
          }

          // AutoDev Core Maintenance(2026-08-30) — 직전 시도의 실제 실패 근거를 추측 없는
          // 사실로 먼저 전달한다(§ 아래 lookup/escalation 힌트는 각각 "과거 해결 사례
          // 후보"와 "행동 경고"일 뿐, 실제 "왜 실패했는지"는 아니었다 — 그 결과 Developer가
          // 매 attempt마다 원인을 추측했다, § 실제 JARVIS Task 5.2 관측). failureEvidence/
          // denyReason은 이미 bounded size로 잘려있다(§ types.ts 주석) — 여기서 다시 한번
          // 여러 실패 테스트 합계 기준으로 좁혀 다음 라운드 context가 과도하게 커지지 않게
          // 한다.
          const evidenceLines = previousAttemptResult.tests
            .filter((t) => !t.pass)
            .map((t) => {
              if (t.failureEvidence) {
                const ev = t.failureEvidence;
                const tail = ev.stderrTail ? ev.stderrTail.slice(-800) : undefined;
                return `- ${t.name}: command="${ev.command}" exitCode=${ev.exitCode ?? "(none)"}${tail ? `\n  stderr(tail): ${tail}` : ""}`;
              }
              if (t.denyReason) return `- ${t.name}: 명령이 실행되지 못하고 거부됨 — ${t.denyReason.slice(0, 800)}`;
              return `- ${t.name}: (근거 없음 — 명령이 spawn조차 되지 않음)`;
            });
          if (evidenceLines.length > 0) {
            hintParts.push(`# AutoDev 안내(직전 시도의 실제 실패 근거 — 추측하지 말고 이 사실부터 확인하세요)\n${evidenceLines.join("\n")}`);
          }

          const lookup = lookupSolution({
            projectId: manifest.projectId,
            taskId: taskDef.id,
            tests: previousAttemptResult.tests,
            projectStore: problemProjectStore,
            commonStore: problemCommonStore,
            projectRootForAncestryCheck: executorContext.projectRoot,
          });

          if (lookup) {
            lookupEntryIdThisCycle = lookup.entry.id;
            hintParts.push(
              `# AutoDev 안내(과거 해결 사례 — ${lookup.tier === "PROJECT" ? "같은 프로젝트의 다른 Task" : "AutoDev 공통 지식"})\n` +
                "이 문제와 동일한 조건(같은 required test 실패 신호)이 과거에 다음과 같이 해결된 적이 있습니다. " +
                "이것은 검증된 정답이 아니라 우선적으로 검토할 후보입니다 — 현재 코드/조건에 실제로 적용 가능한지 " +
                "먼저 판단하고, 적용할 수 없다면 다른 접근을 시도하세요:\n" +
                lookup.entry.finalSuccessfulSolution
            );
          }
          const escalation = buildEscalationGuidance(repeatCount, priorFailedDescriptions);
          if (escalation) hintParts.push(escalation);
        }

        // AutoDev Core Maintenance — Greenfield/Timeout Discovery Progress Persistence
        // (2026-08-31, JARVIS Task 5.3 실측). previousAttemptResult가 Developer 자신의 실패
        // (TIMEOUT 등, 위 seed 확장)이고 discoveryProgress가 있으면, 이미 읽은 파일 "경로"만
        // (내용은 포함하지 않는다 — raw transcript 재주입이 아니다) 압축해서 전달한다.
        // discoveryOnlyRoundCount 자체의 이어받기는 claude-developer.ts
        // opts.priorDiscoveryProgress가 기계적으로 처리한다 — 이 hint는 그 기계적 처리를
        // Claude에게 텍스트로 설명해 왜 곧바로 구현으로 넘어가야 하는지 알려주는 역할만 한다.
        // Progress Transfer Gap 재하드닝 — 이 텍스트는 claude-developer.ts의
        // buildDiscoveryProgressRetryHint()와 완전히 동일한 단일 출처다(durable retry 간에는
        // 이 파일이, 같은 durable attempt 안의 내부 transient retry 간에는
        // runDeveloperTaskWithRetry()가 각각 호출한다 — 텍스트를 복제하지 않는다).
        if (previousAttemptResult.success === false && previousAttemptResult.discoveryProgress) {
          const discoveryHint = buildDiscoveryProgressRetryHint(
            previousAttemptResult.discoveryProgress,
            previousAttemptResult.errorCode
          );
          if (discoveryHint) hintParts.push(discoveryHint);
        }

        // AutoDev Core Maintenance — NO-WRITE Stagnation / Strategy Repeat 재하드닝
        // (2026-08-31, JARVIS Task 5.3 실측). previousAttemptResult.noWriteRepeatCount는
        // runDeveloperTaskWithRetry()가 durable하게 이어받아 계산한 값을 그대로 담고 있다 —
        // 이 durable retry가 새로 시작하는 첫 라운드부터(내부 sub-attempt 1이 시작되기
        // 전부터) 같은 안내를 보여준다. 텍스트 자체는 claude-developer.ts의
        // buildNoWriteStrategyEscalationHint()와 완전히 동일한 단일 출처다.
        if (previousAttemptResult.success === false && (previousAttemptResult.noWriteRepeatCount ?? 0) >= 2) {
          const strategyHint = buildNoWriteStrategyEscalationHint(previousAttemptResult.noWriteRepeatCount ?? 0);
          if (strategyHint) hintParts.push(strategyHint);
        }
        }

        if (hintParts.length > 0) memoryHint = hintParts.join("\n\n");
      }

      let result = await runDeveloperTaskWithRetry(task, attempt, {
        requiredTests: taskDef.requiredTests,
        allowedPathPrefixes: taskDef.allowedPathPrefixes,
        projectContext: developerContext,
        // manifest.reviewScopeDirs는 GPT reviewer가 스캔하는 것과 동일한 "프로젝트 전체 소스
        // 범위"다 — claude-developer.ts가 DeveloperResult.changedFiles를 계산할 때도 같은
        // 범위를 쓴다(이전에는 이 파일에 ["web/", "automation/"]로 하드코딩돼 있었다).
        changeScopeDirs: manifest.reviewScopeDirs,
        // Phase C Task C2 — 이 run 전용 executorContext를 명시적으로 넘긴다. Developer는
        // module-level Safe Executor singleton을 전혀 거치지 않고 이 context의 root/policy로만
        // 파일/명령을 검증·실행한다.
        executor: executorContext,
        memoryHint,
        // § 위 discoveryProgress hintParts 주석 — discoveryOnlyRoundCount/implementationLocked
        // 이어받기의 실제 기계적 처리(claude-developer.ts opts.priorDiscoveryProgress).
        // previousAttemptResult가 Developer 성공/Reviewer REVISE 결과일 때는 discoveryProgress가
        // 없으므로(undefined) 기존 동작과 동일하게 0/false부터 시작한다.
        priorDiscoveryProgress: previousAttemptResult?.discoveryProgress,
        // AutoDev Core Maintenance — NO-WRITE Stagnation / Strategy Repeat 재하드닝
        // (2026-08-31, JARVIS Task 5.3 실측). durable하게 이어받은 "WRITE 없이 연속 실패한
        // 횟수"를 이 durable attempt의 내부 transient retry 루프가 이어서 계산하게 한다(§
        // claude-developer.ts opts.priorNoWriteRepeatCount).
        priorNoWriteRepeatCount: previousAttemptResult?.noWriteRepeatCount,
        // § AutodevRunOptions.abortSignal 주석 — 그대로 전달한다(claude-developer.ts가
        // subprocess-runner.ts까지 이어서 threading한다).
        abortSignal: opts.abortSignal,
        // 테스트 전용(§ AutodevRunOptions.developerClaudeCaller) — 지정하지 않으면 undefined라
        // runDeveloperTaskViaSafeExecutor의 기본값(실제 claude CLI 호출)이 그대로 쓰인다.
        claudeCaller: opts.developerClaudeCaller,
        onRoundStart: (round, maxRounds, stage) => roundStatusReporter.report({ runId, taskId: taskDef.id, round, maxRounds, stage }),
        onContextMetrics: emitDeveloperContextMetrics,
        onUsageLimitWait: emitDeveloperUsageLimitWait,
      });

      // Secret Scanner 사전검사(2026-08-29, Task 4.2 SECURITY_BLOCKED 재발 방지) — Developer
      // 산출물이 checkpoint 직전(performTaskCheckpoint, checkpoint.ts)에야 처음 Secret Scanner에
      // 걸려 매번 사람 승인까지 도달하는 것을 줄인다. 새 Scanner/정규식을 두지 않고 checkpoint.ts와
      // 정확히 동일한 scanChangesForSecrets()를 그대로 재사용한다 — 이 사전검사가 clean이어도
      // 최종 checkpoint의 authoritative Secret Scanner Gate는 절대 건너뛰지 않고 항상 다시
      // 실행된다(§ 아래, 이 블록은 그 Gate 호출부를 전혀 건드리지 않는다). AUTOMATION_DRY_RUN이
      // 아닐 때만 실제 working tree를 스캔한다(selectDefaultClaudeRunner/selectDefaultGptReviewer와
      // 동일한 조건 — dry-run/테스트에서는 fake claudeCaller가 실제 파일을 쓰지 않는 한 no-op).
      if (result.success && process.env.AUTOMATION_DRY_RUN === "false") {
        const changes = getWorkingTreeChanges(manifest.reviewScopeDirs, executorContext.projectRoot);
        const scan = scanChangesForSecrets(changes.all, executorContext.projectRoot);
        if (!scan.clean) {
          const fingerprint = computeSecretFindingFingerprint(taskDef.id, scan.findings);
          const repeatCount = secretPrecheckTracker.observe(fingerprint);
          // 실제 값은 findings에 애초에 담기지 않는다(secret-scanner.ts) — 로그에도 file/
          // line/kind만 남는다.
          log("Secret 사전검사 finding — checkpoint 이전에 자체 점검합니다", {
            taskId: taskDef.id,
            findings: scan.findings,
            repeatCount,
          });
          if (repeatCount === 1) {
            // 같은 finding이 처음 관찰된 경우에만 Developer를 한 번 더 부른다(§ 요구사항
            // "같은 finding 반복 시 Developer/외부 AI 호출 반복 금지" — repeatCount가 2 이상이면
            // 이 분기에 들어오지 않으므로 아래 재호출은 발생하지 않는다). GPT Reviewer는 전혀
            // 호출하지 않는다 — 이 판정은 결정론적이라 AI 판단/비용이 필요 없다.
            const findingList = scan.findings.map((f) => `- ${f.file}:${f.line} (${f.kind})`).join("\n");
            const secretHint =
              "# AutoDev 안내(Secret 사전검사 — checkpoint 전 자체 점검)\n" +
              "방금 만든 변경에서 Secret Scanner가 완성형 secret-shape 패턴을 발견했습니다(실제 값은 " +
              "표시하지 않습니다 — 파일/줄/탐지 종류만):\n" +
              findingList +
              "\n\n실제 credential이든 secret 차단 기능 자체를 검증하는 테스트 fixture든 동일하게 " +
              "적용됩니다: 소스/테스트에 Secret Scanner와 매칭되는 완성형 secret-shaped raw literal을 " +
              "저장하지 마세요. 보안 탐지 기능을 테스트해야 한다면 런타임 문자열 조합(예: 여러 리터럴을 " +
              "이어붙이기)으로 테스트 의미를 유지하면서 저장소에는 완성형 패턴이 남지 않게 하세요. " +
              "whitelist 추가나 Scanner 완화는 허용되지 않습니다.";
            result = await runDeveloperTaskWithRetry(task, attempt, {
              requiredTests: taskDef.requiredTests,
              allowedPathPrefixes: taskDef.allowedPathPrefixes,
              projectContext: developerContext,
              changeScopeDirs: manifest.reviewScopeDirs,
              executor: executorContext,
              memoryHint: memoryHint ? `${memoryHint}\n\n${secretHint}` : secretHint,
              abortSignal: opts.abortSignal,
              claudeCaller: opts.developerClaudeCaller,
              onRoundStart: (round, maxRounds, stage) => roundStatusReporter.report({ runId, taskId: taskDef.id, round, maxRounds, stage }),
              onContextMetrics: emitDeveloperContextMetrics,
              onUsageLimitWait: emitDeveloperUsageLimitWait,
            });
          }
          // repeatCount >= 2(같은 finding이 사전검사 수정 시도 이후에도 반복됨) 또는 방금 재시도한
          // 결과는 다시 스캔하지 않는다 — 이 result를 그대로 기존 REVISE/checkpoint 흐름으로
          // 넘긴다. 최종 checkpoint의 scanChangesForSecrets가 여전히 authoritative gate로 다시
          // 검사해, 필요하면 기존과 동일하게 SECURITY_BLOCKED(WAITING_HUMAN)로 멈춘다 — 이
          // 사전검사는 그 판정을 대신하거나 완화하지 않는다.
        }
      }

      // Section 2/6/9 — 이 cycle의 결과를 problem-memory에 기록한다. GPT 리뷰 판단이 아니라
      // required test 통과 여부라는 객관적 신호만 근거로 삼는다(§ agent-orchestrator.ts의
      // "QA 의견이 아니라 실제 required test가 최종 판정을 결정"과 동일한 원칙).
      if (result.success) {
        const stillFailing = hasFailedRequiredTest(result.tests);
        const priorWasFailing = previousAttemptResult ? hasFailedRequiredTest(previousAttemptResult.tests) : false;
        if (stillFailing) {
          recordAttempt(problemProjectStore, {
            projectId: manifest.projectId,
            taskId: taskDef.id,
            tests: result.tests,
            errorType: classifyFailureCategory(undefined, undefined, result.tests),
            changedFiles: result.changedFiles,
            attemptDescription: result.summary,
            outcome: "FAILURE",
          });
          if (lookupEntryIdThisCycle) recordReuseOutcome(problemProjectStore, lookupEntryIdThisCycle, "FAILURE");
        } else if (priorWasFailing && previousAttemptResult) {
          const entry = recordAttempt(problemProjectStore, {
            projectId: manifest.projectId,
            taskId: taskDef.id,
            tests: previousAttemptResult.tests,
            errorType: classifyFailureCategory(undefined, undefined, previousAttemptResult.tests),
            changedFiles: result.changedFiles,
            attemptDescription: result.summary,
            outcome: "SUCCESS",
          });
          pendingMemoryEntryId = entry.id;
          if (lookupEntryIdThisCycle) recordReuseOutcome(problemProjectStore, lookupEntryIdThisCycle, "SUCCESS");
        }
      }

      previousAttemptResult = result;
      return result;
    };

    // AutoDev / JARVIS 최종 무인개발 하드닝 — production(dry-run이 아닌) 실행에서만 실제
    // Fireworks reviewer를 Same-Finding Call Limiting/RCA wrapper로 감싼다. dry-run이거나
    // opts.orchestratorDeps.gptReviewer가 지정되면(테스트가 흔히 그렇게 한다) 이 값은 아래
    // "...opts.orchestratorDeps" spread가 그대로 덮어써 무시된다 — 기존 테스트 동작에 영향
    // 없음. AUTOMATION_DRY_RUN 판정은 orchestrator.ts의 selectDefaultGptReviewer와 동일한
    // 조건을 그대로 재사용한다(로직 복제가 아니라 동일 환경변수 규약을 그대로 따르는 것).
    const isDryRun = process.env.AUTOMATION_DRY_RUN !== "false";
    const gptReviewer = isDryRun
      ? undefined
      : wrapGptReviewerWithFireworksCallLimiter(
          (result, reviewCycle, task, allowedPathPrefixes, projectContext, gptCallCount, gptRawCallTotal, baseline) =>
            realReviewClaudeResult(result, reviewCycle, task, {
              allowedPathPrefixes,
              projectContext,
              executor: executorContext,
              gptCallCount,
              gptRawCallTotal,
              baseline,
            }),
          {
            taskId: taskDef.id,
            executor: executorContext,
            // durable-recovery-state.ts — 프로세스가 도중에 죽었다 재시작해도 이 task의
            // failure fingerprint/Fireworks 호출 횟수/RCA 횟수가 0으로 초기화되지 않는다(§
            // 요구사항 19). runOrchestrator()가 끝난 뒤의 state.lastGptDecision을 통해 그대로
            // 다시 저장된다 — orchestrator.ts는 수정하지 않는다.
            initialDurableState: resolveDurableFailureStateForReviewer(state, taskDef.id),
            onRootCauseAnalysis: (event) => {
              pendingRootCauseGuidance = event;
            },
          }
        );

    const orchestratorResult = await runOrchestrator(taskDef.prompt, {
      statePath,
      allowedPathPrefixes: taskDef.allowedPathPrefixes,
      claudeRunner: defaultClaudeRunner,
      projectContext: reviewContext,
      // Phase C Task C2 — deps.gptReviewer를 명시적으로 지정하지 않는 한(테스트가 흔히 그렇게
      // 한다) orchestrator의 기본 real GPT reviewer가 이 context를 써서 rules 파일/실제 git
      // 변경을 읽는다 — module-level singleton에 의존하지 않는다.
      gptReviewer,
      executor: executorContext,
      // Phase G Task G2 — REVISE loop의 각 cycle마다(DEVELOPER_RETRY_STARTED/TEST_COMPLETED/
      // REVIEW_STARTED/REVIEW_APPROVED·REVISE·BLOCKED/REVIEW_CYCLE_EXHAUSTED) event를 남기는
      // instrumentation은 orchestrator.ts 자신이 담당한다 — 이 파일은 events/runId/taskId/
      // projectId만 넘긴다.
      events,
      // Phase SI-3.8B — Usage Ledger instrumentation은 orchestrator.ts 자신이 담당한다(§
      // recordGptReviewUsage) — 이 파일은 ledger/runId/taskId/projectId만 넘긴다.
      ledger,
      runId,
      taskId: taskDef.id,
      projectId: manifest.projectId,
      // Multi-Project Approval Isolation(2026-09-01) — § orchestrator.ts OrchestratorDeps.adapterPath.
      adapterPath: manifest.adapterPath,
      abortSignal: opts.abortSignal,
      ...opts.orchestratorDeps,
    });
    // AutoDev Core Maintenance — Canonical Stop Path(2026-08-31). orchestrator.ts가
    // durable-wait 중 또는 Developer 호출 결과(errorCode="ABORTED")로 중단됐다면, checkpoint/
    // Reviewer 판정 어느 쪽도 진행하지 않고 즉시 반환한다 — saveState를 호출하지 않으므로
    // project-state.json은 orchestrator.ts가 마지막으로 이미 저장한 내용 그대로다(§
    // orchestrator.ts stopped 주석). 작업 중 상태를 보존하는 기존 원칙과 동일하게 lock도
    // release하지 않는다(§ lockShouldRelease 기본값 true를 명시적으로 false로 뒤집는다 —
    // 다음 writer는 기존 stale-PID 판정으로 안전하게 재획득한다).
    if (orchestratorResult.stopped) {
      log("orchestrator 중단(ABORTED)됨 — checkpoint/Reviewer 판정 생략, lock 유지, project-state 추가 저장 없음", { taskId: taskDef.id });
      lockShouldRelease = false;
      return { outcome: "STOPPED", taskId: taskDef.id, reason: "ABORTED: Developer/durable-wait 중 중단 요청으로 정상 종료" };
    }
    finalState = orchestratorResult.finalState;
  }

  // orchestrator.ts가 이미 이 실행의 구체적인 사유(HUMAN_APPROVAL_REQUIRED 사전 게이트/
  // REVIEW_STARTED·APPROVED·REVISE·BLOCKED/TEST_COMPLETED/REVIEW_CYCLE_EXHAUSTED 등)를
  // cycle 단위로 기록했다(§ runOrchestrator에 넘긴 events/runId/taskId/projectId). 여기서는
  // 그 결과를 요약하는 run-level bookend event만 남긴다.
  // isResumingApprovedCheckpoint일 때는 finalState(=state)가 이미 WAITING_HUMAN이다(Human
  // Final Review 대기 중이었으므로) — orchestrator를 다시 호출하지 않았으니 이 "orchestrator가
  // APPROVED로 끝나지 않음" 판정 자체를 건너뛴다. decideNextAction()이 이 kind를 반환하기
  // 전에 이미 gate.status==="APPROVED" && lastGptDecision.decision==="PASS"를 확인했다.
  if (!isResumingApprovedCheckpoint && finalState.status !== "APPROVED") {
    console.log(`[autodev] task ${taskDef.id} — orchestrator가 APPROVED로 끝나지 않음(status=${finalState.status}). checkpoint 생략.`);

    // AutoDev 신뢰성 보완(2026-08-27) — orchestrator.ts는 developer 응답이 구조적으로
    // 실패(claudeResult.success===false)하면 GPT 리뷰 없이 즉시 WAITING_HUMAN으로 넘어간다
    // (§ orchestrator.ts). 이 cycle은 defaultClaudeRunner의 `if (result.success)` 기록 분기를
    // 거치지 않으므로(§ 위) PROTOCOL_ERROR가 problem-memory에 전혀 남지 않았다 — 여기서
    // FAILURE로 한 번 기록해, 이 task가 다시 시도될 때(§ hadPriorProtocolFailureForThisTask)
    // 그리고 대시보드(§ Section 15) 양쪽에서 이 이력을 확인할 수 있게 한다. 원문 응답은
    // 포함하지 않고 claude-developer.ts가 이미 계산한 non-secret fingerprint만 쓴다.
    const failedClaudeResult = finalState.lastClaudeResult as
      | (ClaudeResult & { errorCode?: string; protocolFailureFingerprint?: string; callStats?: { totalRounds: number; validResponseRounds: number; localRecoverySuccessRounds: number; protocolFailureRounds: number } })
      | null;
    if (failedClaudeResult && failedClaudeResult.success === false && failedClaudeResult.errorCode === "PROTOCOL_ERROR") {
      recordAttempt(problemProjectStore, {
        projectId: manifest.projectId,
        taskId: taskDef.id,
        tests: [
          {
            name: `claude-response-protocol:${failedClaudeResult.protocolFailureFingerprint ?? "unknown"}`,
            pass: false,
            failureEvidence: { command: "developer-response-protocol-parse" },
          },
        ],
        errorType: "UNKNOWN",
        claudeErrorCode: "PROTOCOL_ERROR",
        changedFiles: failedClaudeResult.changedFiles,
        attemptDescription: failedClaudeResult.summary,
        outcome: "FAILURE",
      });
    }

    // AutoDev / JARVIS 최종 무인개발 구조 보완 — Provider Timeout Circuit Breaker(§ 요구사항
    // 20/21), 2026-08-28 정책 수정으로 갱신: claude-developer.ts의 runDeveloperTaskWithRetry가
    // attempt 내 최대 재시도까지 소진해도, orchestrator.ts는 이제 절대 genuine WAITING_HUMAN
    // 으로 승격하지 않는다 — durable provider wait-then-retry(§ orchestrator.ts
    // WAITING_PROVIDER_RETRY)를 무한히(횟수 무제한, 간격만 bounded) 계속한다. 이 코드가 여기
    // 도달했다는 것은(failedClaudeResult.success===false && errorCode가 TIMEOUT/
    // CLI_NOT_FOUND) orchestrator가 이번 cycle에서 attempt 내 재시도가 소진돼 durable wait에
    // 들어갔다는 뜻이지, genuine WAITING_HUMAN이 됐다는 뜻이 아니다(그건 이 실행에서 발생하지
    // 않는다). 이 블록은 그 사실 자체를 바꾸지 않는다 — 다만 이 task에서 누적된 provider
    // timeout 횟수를 durable하게 기록해(재시작해도 유지) 사람이 대시보드/로그로 "이번이 몇
    // 번째인지" 확인할 수 있게 하고, 근본원인 분류(PROVIDER_ERROR)를 명시적으로 남긴다.
    if (failedClaudeResult && failedClaudeResult.success === false && (failedClaudeResult.errorCode === "TIMEOUT" || failedClaudeResult.errorCode === "CLI_NOT_FOUND")) {
      const durable = loadDurableFailureStateForTask(state, taskDef.id);
      const providerTimeoutCount = durable.providerTimeoutCount + 1;
      // AutoDev Core Maintenance — NO-WRITE Stagnation / Strategy Repeat 재하드닝(2026-08-31,
      // JARVIS Task 5.3 실측). runDeveloperTaskWithRetry()가 이미 이 durable attempt 안의
      // 내부 3회 재시도에 걸쳐 이어서 계산한 noWriteRepeatCount를 그대로 이어받는다(이 값이
      // 없으면 — 예: 오래된 코드 경로/테스트 — durable.noWriteRepeatCount에 1만 더해
      // 안전하게 degrade한다). 실제 WRITE가 있었으면(changedFiles.length>0) 즉시 0으로
      // 리셋한다 — providerTimeoutCount와 달리 이 값은 "몇 번째 실패인지"가 아니라 "지금도
      // 여전히 진척이 없는지"를 나타내야 하기 때문이다.
      const noWriteRepeatCount =
        failedClaudeResult.changedFiles.length > 0
          ? 0
          : (failedClaudeResult.noWriteRepeatCount ?? (durable.noWriteRepeatCount ?? 0) + 1);
      const afterProviderTimeout = loadState(statePath);
      afterProviderTimeout.technicalRecoveryState = {
        ...durable,
        providerTimeoutCount,
        noWriteRepeatCount,
        lastRecoveryAction: `PROVIDER_ERROR(${failedClaudeResult.errorCode})`,
        updatedAt: new Date().toISOString(),
      };
      saveState(afterProviderTimeout, statePath);
      log("PROVIDER_ERROR — Developer 호출이 재시도 소진 후에도 실패(durable 카운트 갱신)", {
        taskId: taskDef.id,
        errorCode: failedClaudeResult.errorCode,
        providerTimeoutCount,
        noWriteRepeatCount,
      });
    }

    // claude 구조적 실패/GPT 호출 상한 초과처럼 orchestrator.ts에서 cycle 단위 event 이름이
    // 따로 없는 나머지 WAITING_HUMAN 사유까지 이 HUMAN_APPROVAL_REQUIRED 하나로 포괄한다.
    // § 요구사항 "호출 효율 지표" — developer가 구조적으로 실패한 cycle은 orchestrator.ts의
    // TEST_COMPLETED를 거치지 않으므로(§ 위) callStats를 실어보낼 다른 event가 없다 — 이미
    // 존재하는 이 event의 metadata(원시 타입만 허용)에 그대로 얹는다(새 event type을 만들지
    // 않는다). § AutoDev production notification policy(2026-08-27) — claudeErrorCode도
    // 함께 싣는다: approval.ts의 classifyApprovalType()은 이 reason(고정 접두사
    // "orchestrator status=")만으로는 NO_PROGRESS_STAGNATION(같은 접근을 반복하다 무진척으로
    // 조기 종료 — 재시도해도 다시 같은 결과일 가능성이 높다)과 TIMEOUT/PROTOCOL_ERROR 소진
    // 같은 "다시 시도하면 실제로 도움이 될 수 있는" 원인을 구분하지 못한다 —
    // classifyApprovalType()/remotelyApprovable 판정 자체(승인 보안 계약)는 전혀 건드리지
    // 않고, telegram-controller.ts의 routing 필터가 이 metadata만 보고 NO_PROGRESS_STAGNATION
    // 하나만 Telegram push 대상에서 제외한다.
    const metadataFields: Record<string, string | number | boolean | null> = {};
    if (failedClaudeResult?.callStats) {
      metadataFields.devTotalRounds = failedClaudeResult.callStats.totalRounds;
      metadataFields.devValidResponseRounds = failedClaudeResult.callStats.validResponseRounds;
      metadataFields.devLocalRecoveryRounds = failedClaudeResult.callStats.localRecoverySuccessRounds;
      metadataFields.devProtocolFailureRounds = failedClaudeResult.callStats.protocolFailureRounds;
    }
    if (failedClaudeResult?.errorCode) metadataFields.claudeErrorCode = failedClaudeResult.errorCode;
    // AutoDev / JARVIS 신뢰성 보완(2026-08-27) — 이 generic HUMAN_APPROVAL_REQUIRED("orchestrator
    // status=...")는 approval.ts에서 ORCHESTRATOR_NOT_APPROVED_GENERIC으로 분류되어 실제
    // Telegram APPROVE 버튼을 만든다(remotelyApprovable=true). REVIEW_CYCLE_EXHAUSTED/
    // REVIEW_BLOCKED(및 CHECKPOINT_SCOPE_VIOLATION — 이 분기가 아니라 checkpoint 실패 분기에서
    // 별도 처리됨)는 이미 canonical Human Gate Policy상 기술적 자동 복구 대상이므로(§
    // human-gate-policy.ts), 이 경우까지 실제 사람에게 APPROVE 버튼을 보내면 자동 복구가 끝나기
    // 전에 사람이 오래된 버튼을 눌러 혼란을 주거나(실제 재실행은 막히지만 — §
    // performAutoResume의 STALE_APPROVAL_UNEXPECTED_STATE 재검사 — 불필요한 알림 자체가
    // 문제다), "실제 사람 판단이 필요한 경우에만 Telegram을 쓴다"는 정책에 어긋난다. 기술적
    // 자동 복구 대상이면 이 event를 아예 만들지 않는다 — RUN_BLOCKED(아래, 항상 기록됨)와
    // orchestrator.ts 자신의 REVIEW_CYCLE_EXHAUSTED/REVIEW_BLOCKED event만으로 audit
    // 기록/대시보드 집계는 이미 충분하다(둘 다 이 generic event에 의존하지 않는다).
    //
    // § BLOCKER 3 재하드닝(독립 최종 감사, 2026-08-30) — 이 investigation 도중 확인된 별도
    // 오분류: finalState.status==="BLOCKED"(orchestrator.ts blockOnDurableWaitRetryExhausted가
    // developerProviderWaitCount/reviewerProviderWaitCount/reviewStagnationWaitCount 및 이제
    // gptCallCount/gptRawCallTotal cap 초과 시 설정하는, "terminal 기술적 BLOCKED —
    // humanInterventionRequired 없음"이라고 그 함수 자신이 명시한 상태)는
    // classifyWaitingHumanReason()이 finalState.status를 전혀 보지 않으므로(§ human-gate-
    // policy.ts — 오직 deferredHumanTasks/lastGptDecision/humanFinalReview만 본다) 이 조건
    // 하나만으로는 걸러지지 않고, 이 generic event가 그대로 HUMAN_APPROVAL_REQUIRED(
    // humanInterventionRequired:true)를 만들어 blockOnDurableWaitRetryExhausted 자신의 설계
    // 의도("Human Gate 아님")를 조용히 뒤집고 있었다(§ 요구사항 5 "technical error → Human
    // Gate" 금지 — 새로 발견된 위반). "BLOCKED"는 이미 이 저장소 전체에서 일관되게
    // "terminal 기술적, Human Gate 없음"만을 뜻하므로(§ decideNextAction의 status==="BLOCKED"
    // STOP 분기와 동일한 원칙), 여기서도 명시적으로 제외한다 — classifyWaitingHumanReason을
    // 새로 흉내내지 않고 이 저장소의 기존 status 계약을 그대로 재사용한다.
    if (finalState.status !== "BLOCKED" && !isTechnicalAutoRecoverableWaitingHuman(finalState)) {
      emitEvent(
        events,
        {
          eventType: "HUMAN_APPROVAL_REQUIRED",
          runId,
          projectId: manifest.projectId,
          taskId: taskDef.id,
          executionPhase: "review",
          outcome: "BLOCKED",
          humanInterventionRequired: true,
          reason: `orchestrator status=${finalState.status}`,
          // Multi-Project Approval Isolation(2026-09-01) — § project-manifest.ts adapterPath.
          ...(Object.keys(metadataFields).length > 0 || manifest.adapterPath
            ? { metadata: { ...metadataFields, ...(manifest.adapterPath ? { adapterPath: manifest.adapterPath } : {}) } }
            : {}),
        },
        auditFailures
      );
    }
    emitEvent(
      events,
      {
        eventType: "RUN_BLOCKED",
        runId,
        projectId: manifest.projectId,
        taskId: taskDef.id,
        executionPhase: "review",
        outcome: "BLOCKED",
        reason: `orchestrator status=${finalState.status}`,
      },
      auditFailures
    );
    if (auditFailures.length > 0) {
      const afterOrchestrator = loadState(statePath);
      afterOrchestrator.deferredHumanTasks.push(...auditFailures);
      saveState(afterOrchestrator, statePath);
    }
    // Phase G Task G7 — orchestrator가 APPROVED로 끝나지 않았다는 것은 developer가 실제로
    // 만든 코드 변경이 working tree에 커밋되지 않은 채 남아있을 수 있다는 뜻이다(checkpoint는
    // APPROVED일 때만 실행된다 — performTaskCheckpoint 호출 자체가 아래에 있다). 이 lock을
    // 여기서 release하면 다른 writer가 그 미완성/미검증 변경 위에 그대로 개발을 시작할 수
    // 있으므로, 이 프로세스가 살아있는 동안은 release하지 않는다(§ 요구사항 9).
    lockShouldRelease = false;
    return {
      outcome: "RAN_TASK_NOT_APPROVED",
      taskId: taskDef.id,
      orchestratorStatus: String(finalState.status),
      reason: `orchestrator status=${finalState.status}`,
      ...(preAdvisory ? { agentAdvisory: preAdvisory } : {}),
    };
  }

  // Phase F Task F4.1 — post-development/pre-checkpoint advisory(qa/security). reviewer가
  // 이미 APPROVED로 판정한 뒤에만 실행하고, 그 결과는 아래 checkpoint 진행 여부에 절대
  // 영향을 주지 않는다(순수 정보 — deterministic test PASS/FAIL이나 GPT reviewer의 APPROVED
  // 판정을 advisory 의견으로 우회/강제하지 않는다). Human Final Review 재개(resume) 시에는
  // 이미 이 advisory가 fresh 실행 때 끝났으므로(아래 gate가 그 결과를 agentAdvisory로 이미
  // 반환했다) 불필요한 LLM 재호출을 피하기 위해 건너뛴다.
  const postAdvisory =
    !isResumingApprovedCheckpoint && finalState.lastClaudeResult
      ? await runPostDevelopmentAdvisory(taskDef, finalState.lastClaudeResult, opts.advisoryReadOnlyRunner)
      : undefined;
  if (postAdvisory && postAdvisory.length > 0) {
    console.log(`[autodev] task ${taskDef.id} — post-development advisory 실행: ${postAdvisory.map((r) => `${r.role}=${r.status}`).join(", ")}`);
  }
  emitAdvisoryAgentEvents(events, runId, manifest.projectId, taskDef.id, "post_development", postAdvisory);
  const agentAdvisory = [...(preAdvisory ?? []), ...(postAdvisory ?? [])];
  const agentAdvisoryField = agentAdvisory.length > 0 ? { agentAdvisory } : {};

  if (!isResumingApprovedCheckpoint && isHumanFinalReviewEnabled(manifest)) {
    // Minimal HUMAN_FINAL_REVIEW Runtime Checkpoint Gate — project-agnostic opt-in(§
    // project-manifest.ts ProjectManifest.humanFinalReviewPolicy/isHumanFinalReviewEnabled).
    // 이 project가 manifest.humanFinalReviewPolicy.enabled===true로 명시적으로 opt-in한
    // 경우에만 이 분기에 들어온다 — AutoDev Core는 어떤 프로젝트 이름으로도 분기하지 않는다.
    // opt-in하지 않은 project(기본값, 기존 project 전부 해당)는 이 조건이 항상 false이므로
    // 곧바로 아래 기존 checkpoint 코드로 진행해 기존 AutoDev 동작(Reviewer PASS → 즉시
    // checkpoint)을 100% 그대로 유지한다.
    //
    // reviewer가 방금 APPROVED(finalState.status==="APPROVED")했더라도, 사람이 명시적으로
    // APPROVE하기 전까지는 checkpoint(git commit)를 진행하지 않는다 — Reviewer PASS는 자동
    // 완료 승인이 아니다. post-development advisory(qa/security)는 사람이 최종 승인 여부를
    // 판단할 때 참고할 수 있도록 이미 위에서 실행되어 agentAdvisoryField에 담겨 있다 — 이
    // 지점 이후의 코드(§ checkpoint)는 이제 decideNextAction()의 RESUME_APPROVED_CHECKPOINT
    // 경로(위 isResumingApprovedCheckpoint 분기)로만 도달한다 — 사람의 새 승인 없이는 같은
    // 실행 안에서도, 이후 재실행에서도 절대 도달하지 않는다(checkpoint=0/completedTasks
    // 변화=0/next task 진행=0 보장).
    const gate: HumanFinalReviewGate = {
      taskId: taskDef.id,
      reviewCycle: finalState.reviewCycle,
      status: "PENDING",
      requestedAt: new Date().toISOString(),
    };
    const gated = loadState(statePath);
    gated.status = "WAITING_HUMAN";
    gated.humanFinalReview = gate;
    gated.deferredHumanTasks.push(
      `HUMAN_FINAL_REVIEW_PENDING(${taskDef.id}): reviewer APPROVED — checkpoint 전 사람의 최종 승인이 필요합니다(approveHumanFinalReview() 호출 후 재실행하세요).`
    );
    emitEvent(
      events,
      {
        eventType: "HUMAN_APPROVAL_REQUIRED",
        runId,
        projectId: manifest.projectId,
        taskId: taskDef.id,
        executionPhase: "checkpoint",
        outcome: "BLOCKED",
        humanInterventionRequired: true,
        reason: `HUMAN_FINAL_REVIEW_PENDING(${taskDef.id})`,
        // Multi-Project Approval Isolation(2026-09-01) — § project-manifest.ts adapterPath.
        ...(manifest.adapterPath ? { metadata: { adapterPath: manifest.adapterPath } } : {}),
      },
      auditFailures
    );
    if (auditFailures.length > 0) gated.deferredHumanTasks.push(...auditFailures);
    saveState(gated, statePath);
    console.log(
      `[autodev] task ${taskDef.id} — reviewer APPROVED. Human Final Review 대기(checkpoint 보류) — 사람이 승인해야 다음 실행에서 checkpoint가 진행됩니다.`
    );
    // Phase G Task G7과 동일한 원칙 — reviewer가 이미 APPROVED한 실제 코드 변경이 아직
    // commit되지 않은 채 working tree에 그대로 있다. 다른 writer가 이 위에서 시작하지
    // 못하도록 이 프로세스가 살아있는 동안 lock을 유지한다.
    lockShouldRelease = false;
    return {
      outcome: "RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW",
      taskId: taskDef.id,
      orchestratorStatus: String(finalState.status),
      reason: `HUMAN_FINAL_REVIEW_PENDING(${taskDef.id}): reviewer APPROVED — 사람의 최종 승인 대기 중(checkpoint 보류).`,
      ...agentAdvisoryField,
    };
  }

  // Claude/GPT의 자체 보고를 신뢰하지 않는다 — orchestrator가 강제 REVISE 안전장치를
  // 이미 적용했지만(§ 요구사항 6), checkpoint 직전에도 다시 한번 독립적으로 확인한다.
  const tests = finalState.lastClaudeResult?.tests ?? [];
  const requiredTestsAllPassed = tests.length > 0 && tests.every((t) => t.pass);

  // Phase G Task G2.1 — checkpoint(git commit)는 되돌릴 수 없는 경계다. commit 이후에
  // CHECKPOINT_CREATED/TASK_COMPLETED/RUN_COMPLETED 기록이 실패해도 이미 만들어진 commit을
  // 자동으로 reset/rewrite하지 않는다(§ 요구사항 — 이미 생성된 commit을 되돌리는 구조는
  // 만들지 않는다). 그래서 이 경계는 사전에 막는다: audit-critical 저장소가 지금 실제로
  // 쓰기 가능한지 부수효과 없는 점검(§ EventStore.checkAuditWritable)으로 먼저 확인하고,
  // 사용 불가능하다고 확인되면 git을 전혀 건드리지 않고 checkpoint 자체를 진행하지 않는다.
  // events가 지정되지 않았거나(테스트/dry-run) 이 메서드를 구현하지 않는 store는 항상 사용
  // 가능한 것으로 간주한다(기존 동작 100% 보존).
  const auditHealth = events?.checkAuditWritable?.() ?? { ok: true };
  if (!auditHealth.ok) {
    log("checkpoint 금지 — checkpoint 전 audit-critical 저장소 사용 불가 확인됨(commit 시도 안 함)", {
      taskId: taskDef.id,
      error: auditHealth.error,
    });
    emitEvent(
      events,
      {
        eventType: "HUMAN_APPROVAL_REQUIRED",
        runId,
        projectId: manifest.projectId,
        taskId: taskDef.id,
        executionPhase: "checkpoint",
        outcome: "BLOCKED",
        humanInterventionRequired: true,
        reason: `AUDIT_STORE_UNAVAILABLE_BEFORE_CHECKPOINT: ${auditHealth.error ?? "unknown"}`,
        // Multi-Project Approval Isolation(2026-09-01) — § project-manifest.ts adapterPath.
        ...(manifest.adapterPath ? { metadata: { adapterPath: manifest.adapterPath } } : {}),
      },
      auditFailures
    );
    emitEvent(
      events,
      {
        eventType: "RUN_BLOCKED",
        runId,
        projectId: manifest.projectId,
        taskId: taskDef.id,
        executionPhase: "checkpoint",
        outcome: "BLOCKED",
        reason: "audit-critical 저장소 사용 불가로 checkpoint를 진행하지 않았습니다.",
      },
      auditFailures
    );
    const afterOrchestrator = loadState(statePath);
    afterOrchestrator.status = "WAITING_HUMAN";
    afterOrchestrator.deferredHumanTasks.push(
      `AUDIT_STORE_UNAVAILABLE_BEFORE_CHECKPOINT(${taskDef.id}): ${auditHealth.error ?? "unknown"} — audit-critical 저장소를 쓸 수 없어 commit을 시도하지 않았습니다.`,
      ...auditFailures
    );
    saveState(afterOrchestrator, statePath);
    // Phase G Task G7 — reviewer가 이미 APPROVED한 실제 코드 변경이 아직 commit되지 않은 채
    // working tree에 그대로 있다(audit store 문제로 checkpoint 자체를 시도하지 않았을 뿐).
    // 다른 writer가 이 위에서 시작하지 못하도록 이 프로세스가 살아있는 동안 lock을 유지한다.
    lockShouldRelease = false;
    return {
      outcome: "RAN_TASK_CHECKPOINT_BLOCKED",
      taskId: taskDef.id,
      orchestratorStatus: String(finalState.status),
      reason: "audit-critical 저장소 사용 불가로 checkpoint를 진행하지 않았습니다.",
      ...agentAdvisoryField,
    };
  }

  // Phase G Task G7.3 — remote가 이 run 시작 시점 이후 바뀌었는지 checkpoint(git commit)
  // 직전 다시 확인한다(§ 요구사항 5) — checkpoint는 되돌릴 수 없는 경계이므로 바로 위
  // audit store 점검과 동일한 원칙으로 commit을 시도하기 전에 미리 막는다.
  // remoteSnapshot이 없으면(manifest가 이 Gate를 요청하지 않음) 완전히 no-op이다. 이 재확인은
  // fetch(remote-tracking ref 갱신)만 하고 어떤 git 상태도 바꾸지 않는다 — reset/rebase/merge
  // 자동 수행 없음, working tree의 실제 코드 변경은 그대로 보존된다.
  if (remoteSnapshot) {
    const remoteRecheck = checkRemoteUnchangedSince(cwd, remoteSnapshot);
    if (!remoteRecheck.ok) {
      const eventType = remoteRecheck.code === "REMOTE_CHANGED_DURING_RUN" ? "REMOTE_GIT_CHANGED" : "REMOTE_GIT_BLOCKED";
      log(`checkpoint 금지 — remote git 상태 재확인 실패(${remoteRecheck.code}), commit 시도 안 함`, {
        taskId: taskDef.id,
        reason: remoteRecheck.reason,
      });
      emitEvent(
        events,
        {
          eventType,
          runId,
          projectId: manifest.projectId,
          taskId: taskDef.id,
          executionPhase: "checkpoint",
          outcome: "BLOCKED",
          humanInterventionRequired: true,
          reason: remoteRecheck.reason,
          metadata: { remoteGitBlockedCode: remoteRecheck.code },
        },
        auditFailures
      );
      emitEvent(
        events,
        {
          eventType: "RUN_BLOCKED",
          runId,
          projectId: manifest.projectId,
          taskId: taskDef.id,
          executionPhase: "checkpoint",
          outcome: "BLOCKED",
          reason: "remote git 상태가 이 run 동안 변경되었거나(또는 재확인 실패) checkpoint를 진행하지 않았습니다.",
        },
        auditFailures
      );
      const afterRemoteCheck = loadState(statePath);
      afterRemoteCheck.status = "WAITING_HUMAN";
      afterRemoteCheck.deferredHumanTasks.push(
        `REMOTE_GIT_CHANGED_DURING_RUN(${taskDef.id}): ${remoteRecheck.reason} — commit을 시도하지 않았습니다.`,
        ...auditFailures
      );
      saveState(afterRemoteCheck, statePath);
      // 이 task가 실제로 만든(reviewer가 이미 APPROVED한) 코드 변경이 아직 commit되지 않은 채
      // working tree에 그대로 남아있다 — 다른 writer가 이 위에서 시작하지 못하도록 이
      // 프로세스가 살아있는 동안 lock을 유지한다(§ 감사 store 점검 gate와 동일한 원칙).
      lockShouldRelease = false;
      return {
        outcome: "RAN_TASK_CHECKPOINT_BLOCKED",
        taskId: taskDef.id,
        orchestratorStatus: String(finalState.status),
        reason: `remote git 상태 재확인 실패(${remoteRecheck.code}): ${remoteRecheck.reason}`,
        ...agentAdvisoryField,
      };
    }
  }

  const stateRelPath = computeStateRelPath(statePath, cwd);
  const checkpoint = performTaskCheckpoint(taskDef, {
    decision: finalState.lastGptDecision?.decision ?? "REVISE",
    severity: finalState.lastGptDecision?.severity ?? { critical: 0, high: 0, medium: 0 },
    requiredTestsAllPassed,
    reviewFeedback: finalState.lastGptDecision?.feedback,
    cwd,
    excludePaths: [stateRelPath],
    // Checkpoint Provenance/Baseline Hardening(2026-08-31) — orchestrator.ts가 이 task의
    // 진짜 첫 attempt 시작 시점에 캡처해 state에 durable하게 저장한 baseline(§
    // task-change-baseline.ts). finalState는 orchestrator 실행 결과(RESUME_APPROVED_CHECKPOINT
    // 경로에서는 loadState() 그대로)이므로 항상 이 필드를 그대로 갖고 있다.
    baseline: finalState.taskChangeBaseline,
  });

  if (!checkpoint.ok) {
    // Phase G Task G1 — Secret/Dependency Scanner Gate(Core, checkpoint.ts)가 실제로 걸린
    // 경우만 SECURITY_BLOCKED로 남긴다(원문은 담지 않는다 — checkpoint.secretFindings는
    // 이미 file/line/kind만 담고 원문을 포함하지 않는다). 그 외 checkpoint 실패 사유(예:
    // allowedPathPrefixes 밖 변경)는 HUMAN_APPROVAL_REQUIRED로 남긴다. 이 event들을 먼저
    // 만들어 auditFailures를 채운 뒤, 아래 한 번의 saveState()에 함께 반영한다(Phase G Task
    // G2 — audit-critical 기록 실패도 같은 저장 경로로 surface한다, 새 저장 경로를 만들지
    // 않는다).
    const isSecurityGate = (checkpoint.secretFindings?.length ?? 0) > 0 || checkpoint.dependencyScanVerdict === "BLOCK";
    // § BLOCKER 2 재하드닝(독립 최종 감사) — 아래에서 실제로 state.deferredHumanTasks에
    // 저장하는 것과 정확히 같은 marker 문자열을 여기서 미리 계산해, human-gate-policy.ts의
    // canonical isCheckpointBlockedMarker()로 이 checkpoint 실패가 실제로 genuine인지
    // 재사용해 판정한다. No-Safe-Recovery-Action Gate(2026-08-31) 이후로는 CHECKPOINT_BLOCKED
    // 마커는 이유(Secret/Dependency든 scope violation이든)와 무관하게 전부 genuine이다 —
    // Developer/Reviewer 재시도로는 어느 쪽도 스스로 해결되지 않기 때문이다(scope violation:
    // Developer에게 삭제 action이 없음, Secret/Dependency: 애초에 보안 판단이 필요함).
    const checkpointBlockedMarker =
      `CHECKPOINT_BLOCKED(${taskDef.id}): ${checkpoint.reason}` +
      (checkpoint.unexpectedFiles?.length ? ` — unexpected: ${checkpoint.unexpectedFiles.join(", ")}` : "");
    const isGenuineCheckpointBlock = isSecurityGate || isCheckpointBlockedMarker(checkpointBlockedMarker);
    emitEvent(
      events,
      {
        eventType: isSecurityGate ? "SECURITY_BLOCKED" : "HUMAN_APPROVAL_REQUIRED",
        runId,
        projectId: manifest.projectId,
        taskId: taskDef.id,
        executionPhase: "checkpoint",
        outcome: "BLOCKED",
        humanInterventionRequired: isGenuineCheckpointBlock,
        reason: checkpoint.reason,
        // Multi-Project Approval Isolation(2026-09-01) — § project-manifest.ts adapterPath.
        metadata: {
          secretFindingCount: checkpoint.secretFindings?.length ?? 0,
          dependencyScanVerdict: checkpoint.dependencyScanVerdict ?? null,
          ...(manifest.adapterPath ? { adapterPath: manifest.adapterPath } : {}),
        },
      },
      auditFailures
    );
    emitEvent(
      events,
      { eventType: "RUN_BLOCKED", runId, projectId: manifest.projectId, taskId: taskDef.id, executionPhase: "checkpoint", outcome: "BLOCKED", reason: checkpoint.reason },
      auditFailures
    );

    const afterOrchestrator = loadState(statePath);
    afterOrchestrator.status = "WAITING_HUMAN";
    afterOrchestrator.deferredHumanTasks.push(checkpointBlockedMarker, ...auditFailures);
    saveState(afterOrchestrator, statePath);
    log("checkpoint 실패 — WAITING_HUMAN으로 전환", { taskId: taskDef.id, reason: checkpoint.reason });
    // Phase G Task G7 — checkpoint가 BLOCK한 이유(unexpected files/secret/dependency 위험)와
    // 무관하게, 이 시점의 working tree에는 이 task가 실제로 만든(또는 예상 밖의) 변경이 그대로
    // 남아있다 — 정확히 요구사항 9가 경고하는 상황이다. 이 프로세스가 살아있는 동안 lock을
    // 유지해 다른 writer가 이 미해결 상태 위에서 작업을 시작하지 못하게 한다.
    lockShouldRelease = false;
    return {
      outcome: "RAN_TASK_CHECKPOINT_BLOCKED",
      taskId: taskDef.id,
      orchestratorStatus: String(finalState.status),
      checkpoint,
      reason: checkpoint.reason,
      ...agentAdvisoryField,
    };
  }

  emitEvent(
    events,
    {
      eventType: "CHECKPOINT_CREATED",
      runId,
      projectId: manifest.projectId,
      taskId: taskDef.id,
      executionPhase: "checkpoint",
      outcome: "SUCCESS",
      metadata: { commitHash: checkpoint.commitHash ?? null },
    },
    auditFailures
  );

  // AutoDev 지능형 오류 복구 하드닝(Problem-Solving Knowledge Store) — checkpoint가 실제로
  // 성공한 뒤에만 pending 해결책을 확정한다(§ 요구사항 5 — 검증 전 해결책을 정답으로
  // 단정하지 않는다). checkpoint.commitHash가 없으면(이론상 발생하지 않지만 방어적으로)
  // 확정하지 않는다 — "resolvedAtCommit 없는 확정 항목"을 만들지 않기 위함이다.
  if (pendingMemoryEntryId && checkpoint.commitHash) {
    confirmResolution(problemProjectStore, pendingMemoryEntryId, checkpoint.commitHash);
    const confirmedEntry = problemProjectStore.load().find((e) => e.id === pendingMemoryEntryId);
    if (confirmedEntry) promoteToCommonIfGeneric(problemCommonStore, confirmedEntry);
  }

  // Phase G Task G7.5 — Telegram 알림 UX Hardening. 이 task 완료가 "하위 Task(🟡)"인지
  // "상위 task-registry 전체가 진짜 최종 완료될 예정(PENDING_FINAL)"인지 "모든 자동 task는
  // 끝났지만 이 task가 isHumanGate라 배포는 사람이 트리거해야 하는지(PENDING_DEPLOYMENT_
  // GATE)"인지를, 실제로 state에 반영하기 전에 미리 계산한다(getNextTask는 순수 함수라
  // 부수효과 없이 두 번 호출해도 안전하다 — 아래 909번째 줄의 실제 판정과 동일한 로직).
  // TASK_COMPLETED 이 event 자체에는 "PENDING_*"만 남기고, notification.ts가 이 값을 보고
  // 알림을 만들지 않는다(§ 그 파일) — 실제 "최종 완료" Telegram은 project-state.json 저장 +
  // administrative commit이 성공한 뒤에만(§ 아래) 별도 event로 보낸다. 이 순서를 지키지
  // 않으면(예: 여기서 바로 최종 완료를 알리면) "TASK_COMPLETED 발생 → 최종 완료 Telegram →
  // 그 뒤 최종 검증/보고" 순서가 되어 요구사항이 명시적으로 금지하는 잘못된 순서가 된다.
  const completedTasksAfterThis = [...(state.completedTasks ?? []), taskDef.id];
  const willHaveNextTask = getNextTask(manifest.taskRegistry, completedTasksAfterThis) !== null;
  const taskCompletionScope: "SUBTASK" | "PENDING_FINAL" | "PENDING_DEPLOYMENT_GATE" = willHaveNextTask
    ? "SUBTASK"
    : taskDef.isHumanGate
      ? "PENDING_DEPLOYMENT_GATE"
      : "PENDING_FINAL";

  emitEvent(
    events,
    {
      eventType: "TASK_COMPLETED",
      runId,
      projectId: manifest.projectId,
      taskId: taskDef.id,
      executionPhase: "state_update",
      outcome: "SUCCESS",
      metadata: { completionScope: taskCompletionScope },
    },
    auditFailures
  );
  emitEvent(events, { eventType: "RUN_COMPLETED", runId, projectId: manifest.projectId, taskId: taskDef.id, executionPhase: "state_update", outcome: "SUCCESS" }, auditFailures);

  // product commit(위 performTaskCheckpoint)이 끝난 뒤에만 project-state.json을 갱신하고
  // 별도의 administrative commit으로 남긴다 — project-state.json은 스스로를 같은 commit
  // 안에서 참조할 수 없으므로(자기참조 문제) 2단계로 분리한다.
  const updated = loadState(statePath);
  updated.completedTasks = [...(updated.completedTasks ?? []), taskDef.id];
  updated.gitCheckpoint = checkpoint.commitHash ?? updated.gitCheckpoint;
  updated.currentPhase = taskDef.phase;
  updated.lastGptDecision = finalState.lastGptDecision;
  // durable-recovery-state.ts — 이 task가 실제로 완료(checkpoint 성공)됐다. 이 task의 failure
  // fingerprint/Fireworks 호출 횟수/RCA 횟수/provider timeout 횟수/예상치 못한 종료 횟수를
  // 완전히 비운다 — 다음 task가 이 task의 실패 이력을 물려받지 않게 한다(§ 요구사항 19).
  clearDurableFailureState(updated);
  // checkpoint가 실제로 성공했으므로 이 gate는 완전히 소비됐다 — 다음 실행에서 stale하게
  // 남아 재해석되지 않도록 명시적으로 비운다(§ 요구사항 13 Test 7 — checkpoint exactly once).
  updated.humanFinalReview = null;
  // resume 경로는 runOrchestrator()를 다시 호출하지 않으므로(§ isResumingApprovedCheckpoint)
  // 그 함수가 매 fresh 실행 시작마다 하던 deferredHumanTasks 초기화가 이 경로에는 일어나지
  // 않는다 — 이 gate가 대기 중일 때 남긴 안내 메시지(HUMAN_FINAL_REVIEW_PENDING)만 정확히
  // 지금 소비된 것이므로 명시적으로 제거한다(다른 무관한 기존 항목은 그대로 보존한다).
  updated.deferredHumanTasks = updated.deferredHumanTasks.filter((t) => !t.startsWith(`HUMAN_FINAL_REVIEW_PENDING(${taskDef.id})`));
  if (auditFailures.length > 0) updated.deferredHumanTasks.push(...auditFailures);

  const next = getNextTask(manifest.taskRegistry, updated.completedTasks);
  if (next) {
    updated.currentTask = `${next.id} — ${next.title}`;
    updated.status = "READY";
  } else if (taskDef.isHumanGate) {
    updated.currentTask = null;
    updated.status = PLAN_MARKERS.DEPLOYMENT_WAITING_HUMAN;
  } else {
    updated.currentTask = null;
    updated.status = PLAN_MARKERS.PROJECT_COMPLETE;
  }
  saveState(updated, statePath);

  const adminCommit = commitProjectStateOnly(
    stateRelPath,
    `chore: record checkpoint ${checkpoint.commitHash ?? "(hash 없음)"} for Phase ${taskDef.phase} Task ${taskDef.taskNumber} in project-state`,
    cwd
  );
  if (!adminCommit.ok) {
    // product commit은 이미 성공했으므로 코드 변경 자체는 안전하게 기록됐다 — project-state
    // 기록만 실패한 상태다. 사람이 project-state.json을 수동으로 정리할 수 있도록 남긴다.
    const afterAdmin = loadState(statePath);
    afterAdmin.deferredHumanTasks.push(`PROJECT_STATE_COMMIT_FAILED(${taskDef.id}): ${adminCommit.reason}`);
    saveState(afterAdmin, statePath);
    log("project-state administrative commit 실패", { taskId: taskDef.id, reason: adminCommit.reason });
  }

  // Phase G Task G7.5 — 위에서 계산한 taskCompletionScope가 SUBTASK가 아니면, project-state
  // 저장(saveState) + administrative commit이 이미 끝난 *이후*인 지금에서야 authoritative
  // 최종 event를 남긴다(§ 요구사항 5 순서 — "실행 → 검증 → state/completion 처리 →
  // 최종보고 확정 → 최종 Telegram"). administrative commit이 실패했으면(adminCommit.ok===
  // false) "최종 state 기록 성공"이라는 완료 조건 자체를 충족하지 못한 것이므로, 어떤
  // scope였든 ✅/⛔ 최종 event 대신 기존 RUN_BLOCKED(사람 확인 필요, § notification.ts)로
  // 남긴다 — product commit(코드 변경)은 이미 안전하게 커밋됐고 project-state.json도
  // working tree에는 올바른 최종 상태로 저장돼 있으므로, 이 실패가 코드 변경 자체를
  // 위험하게 만들지는 않는다.
  if (taskCompletionScope !== "SUBTASK") {
    if (!adminCommit.ok) {
      emitEvent(events, {
        eventType: "RUN_BLOCKED",
        runId,
        projectId: manifest.projectId,
        taskId: taskDef.id,
        executionPhase: "state_update",
        outcome: "BLOCKED",
        reason: "project-state 최종 기록(commit)에 실패해 최종 완료를 확정하지 못했습니다.",
      });
    } else if (taskCompletionScope === "PENDING_FINAL") {
      emitEvent(events, {
        eventType: "PROJECT_COMPLETED",
        runId,
        projectId: manifest.projectId,
        taskId: taskDef.id,
        executionPhase: "state_update",
        outcome: "SUCCESS",
        metadata: { commitHash: checkpoint.commitHash ?? null },
      });
    } else {
      emitEvent(events, {
        eventType: "DEPLOYMENT_WAITING_HUMAN",
        runId,
        projectId: manifest.projectId,
        taskId: taskDef.id,
        executionPhase: "state_update",
        outcome: "SUCCESS",
        humanInterventionRequired: true,
      });
    }
  }

  console.log(`[autodev] task ${taskDef.id} APPROVED + checkpoint 완료 (commit ${checkpoint.commitHash ?? "?"})`);
  // Phase G Task G7 — product commit + administrative commit이 모두 끝난 뒤라 working tree가
  // clean하다(또는 adminCommit 실패만 남았어도 코드 자체는 이미 안전하게 커밋됨) — 안전하게
  // release한다(lockShouldRelease는 기본값 true 그대로).
  return {
    outcome: "RAN_TASK_APPROVED_AND_CHECKPOINTED",
    taskId: taskDef.id,
    orchestratorStatus: String(finalState.status),
    checkpoint,
    ...agentAdvisoryField,
  };
  } catch (err) {
    // Phase G Task G7 — 처리되지 않은 예외는 이 실행의 최종 상태를 알 수 없다는 뜻이다(fail
    // closed). working tree/state.json이 안전한 상태인지 확신할 수 없으므로 lock을 release하지
    // 않는다 — 이 프로세스가 실제로 종료된 뒤에야 다음 acquire 시도가 stale 판정(owner PID
    // 죽음 증명)으로 복구할 수 있다.
    lockShouldRelease = false;
    throw err;
  } finally {
    finalizeProjectLock();
  }
}

// 프로세스 진입점(main()/SIGINT 처리/require.main===module 가드)은 이 파일에 없다 — Core는
// 자기 자신을 어떻게 실행할지 모른다(Phase A Task A7). 실제 MOVAN 실행은 run-movan.ts가
// 담당한다 — 그 파일이 MOVAN_PROJECT_MANIFEST를 명시적으로 조립해 runAutodevOnce()를 호출한다.
