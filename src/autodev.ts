import { relative, sep } from "node:path";
import { loadState, saveState } from "./state";
import { runOrchestrator } from "./orchestrator";
import type { OrchestratorDeps } from "./orchestrator";
import { runDeveloperTaskViaSafeExecutor } from "./claude-developer";
import type { DeveloperProjectContext } from "./claude-developer";
import type { ReviewProjectContext } from "./gpt-reviewer";
import { getNextTask, PLAN_MARKERS } from "./task-registry";
import type { TaskDefinition } from "./task-registry";
import { validateProjectManifest, resolveRemoteGitSafetyPolicy } from "./project-manifest";
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
import type { CoreState, ClaudeResult } from "./types";

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
  | { kind: "RUN_TASK"; task: TaskDefinition };

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

  if (status === "WAITING_HUMAN") {
    return {
      kind: "STOP",
      reason: "이미 WAITING_HUMAN 상태 — 사람 확인 대기 중이므로 자동 실행하지 않습니다.",
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
}

export type AutodevRunOutcome =
  | "STOPPED"
  | "RAN_TASK_APPROVED_AND_CHECKPOINTED"
  | "RAN_TASK_NOT_APPROVED"
  | "RAN_TASK_CHECKPOINT_BLOCKED"
  /** Phase G Task G7 — 같은 project를 다른 프로세스가 이미 쓰고 있거나(PROJECT_ALREADY_LOCKED)
   *  lock 상태를 신뢰할 수 없어서(LOCK_STATE_UNCERTAIN/CORRUPT_LOCK) 이 실행 자체를 시작하지
   *  않은 경우. state.json/git 어느 쪽도 건드리지 않는다 — reason에 어떤 lock 코드였는지 남는다. */
  | "BLOCKED_PROJECT_LOCK"
  /** Phase G Task G7.3 — manifest.remoteGitSafety가 지정된 project에서, run 시작 전 Remote
   *  Safety Gate(local HEAD == origin/<branch> 재확인)가 통과하지 못한 경우. state.json/git
   *  어느 쪽도 건드리지 않는다(loadState조차 호출하지 않는다) — reason에 remote-git-safety.ts의
   *  RemoteGitBlockedCode가 남는다. */
  | "BLOCKED_REMOTE_GIT";

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
    const decision = decideNextAction(state, manifest.taskRegistry);

    if (decision.kind === "STOP") {
      console.log(`[autodev] ${decision.reason}`);
      if (decision.setWaitingHuman && (state.status as unknown as string) !== "WAITING_HUMAN") {
        state.status = "WAITING_HUMAN";
        saveState(state, statePath);
      }
      emitEvent(events, { eventType: "RUN_COMPLETED", runId, projectId: manifest.projectId, executionPhase: "task_selection", outcome: "SKIPPED", reason: decision.reason });
      // 이 분기는 어떤 developer/checkpoint 작업도 하지 않았다 — working tree에 아무 위험도
      // 남기지 않았으므로 안전하게 release한다(lockShouldRelease는 기본값 true 그대로).
      return { outcome: "STOPPED", reason: decision.reason };
    }

  const taskDef = decision.task;
  console.log(`[autodev] 다음 task 선택: ${taskDef.id} — ${taskDef.title}`);
  emitEvent(events, { eventType: "TASK_STARTED", runId, projectId: manifest.projectId, taskId: taskDef.id, executionPhase: "task_selection", outcome: "PENDING" });

  // Phase F Task F4.1 — pre-development advisory(planner/research). taskDef의 신호가
  // 없으면 즉시 undefined이고 LLM 호출이 전혀 없다.
  const preAdvisory = await runPreDevelopmentAdvisory(taskDef, opts.advisoryReadOnlyRunner);
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

  const defaultClaudeRunner = (task: string, attempt: number) =>
    runDeveloperTaskViaSafeExecutor(task, attempt, {
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
    });

  const { finalState } = await runOrchestrator(taskDef.prompt, {
    statePath,
    allowedPathPrefixes: taskDef.allowedPathPrefixes,
    claudeRunner: defaultClaudeRunner,
    projectContext: reviewContext,
    // Phase C Task C2 — deps.gptReviewer를 명시적으로 지정하지 않는 한(테스트가 흔히 그렇게
    // 한다) orchestrator의 기본 real GPT reviewer가 이 context를 써서 rules 파일/실제 git
    // 변경을 읽는다 — module-level singleton에 의존하지 않는다.
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
    ...opts.orchestratorDeps,
  });

  // orchestrator.ts가 이미 이 실행의 구체적인 사유(HUMAN_APPROVAL_REQUIRED 사전 게이트/
  // REVIEW_STARTED·APPROVED·REVISE·BLOCKED/TEST_COMPLETED/REVIEW_CYCLE_EXHAUSTED 등)를
  // cycle 단위로 기록했다(§ runOrchestrator에 넘긴 events/runId/taskId/projectId). 여기서는
  // 그 결과를 요약하는 run-level bookend event만 남긴다.
  if (finalState.status !== "APPROVED") {
    console.log(`[autodev] task ${taskDef.id} — orchestrator가 APPROVED로 끝나지 않음(status=${finalState.status}). checkpoint 생략.`);
    // claude 구조적 실패/GPT 호출 상한 초과처럼 orchestrator.ts에서 cycle 단위 event 이름이
    // 따로 없는 나머지 WAITING_HUMAN 사유까지 이 HUMAN_APPROVAL_REQUIRED 하나로 포괄한다.
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
  // 판정을 advisory 의견으로 우회/강제하지 않는다).
  const postAdvisory = finalState.lastClaudeResult
    ? await runPostDevelopmentAdvisory(taskDef, finalState.lastClaudeResult, opts.advisoryReadOnlyRunner)
    : undefined;
  if (postAdvisory && postAdvisory.length > 0) {
    console.log(`[autodev] task ${taskDef.id} — post-development advisory 실행: ${postAdvisory.map((r) => `${r.role}=${r.status}`).join(", ")}`);
  }
  emitAdvisoryAgentEvents(events, runId, manifest.projectId, taskDef.id, "post_development", postAdvisory);
  const agentAdvisory = [...(preAdvisory ?? []), ...(postAdvisory ?? [])];
  const agentAdvisoryField = agentAdvisory.length > 0 ? { agentAdvisory } : {};

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
    emitEvent(
      events,
      {
        eventType: isSecurityGate ? "SECURITY_BLOCKED" : "HUMAN_APPROVAL_REQUIRED",
        runId,
        projectId: manifest.projectId,
        taskId: taskDef.id,
        executionPhase: "checkpoint",
        outcome: "BLOCKED",
        humanInterventionRequired: true,
        reason: checkpoint.reason,
        metadata: { secretFindingCount: checkpoint.secretFindings?.length ?? 0, dependencyScanVerdict: checkpoint.dependencyScanVerdict ?? null },
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
    afterOrchestrator.deferredHumanTasks.push(
      `CHECKPOINT_BLOCKED(${taskDef.id}): ${checkpoint.reason}` +
        (checkpoint.unexpectedFiles?.length ? ` — unexpected: ${checkpoint.unexpectedFiles.join(", ")}` : ""),
      ...auditFailures
    );
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
