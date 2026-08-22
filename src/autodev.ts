import { relative, sep } from "node:path";
import { loadState, saveState } from "./state";
import { runOrchestrator } from "./orchestrator";
import type { OrchestratorDeps } from "./orchestrator";
import { runDeveloperTaskViaSafeExecutor } from "./claude-developer";
import type { DeveloperProjectContext } from "./claude-developer";
import type { ReviewProjectContext } from "./gpt-reviewer";
import { getNextTask, PLAN_MARKERS } from "./task-registry";
import type { TaskDefinition } from "./task-registry";
import { validateProjectManifest } from "./project-manifest";
import type { ProjectManifest } from "./project-manifest";
import { createSafeExecutorContext } from "./safe-executor";
import { performTaskCheckpoint, commitProjectStateOnly } from "./checkpoint";
import type { CheckpointOutcome } from "./checkpoint";
import { buildAdvisoryRoutingPlan } from "./agent-registry";
import type { AdvisorySignals } from "./agent-registry";
import { executeRoutingPlan } from "./agent-orchestrator";
import type { AgentStepResult, ReadOnlyAgentRunner } from "./agent-orchestrator";
import { classifyTaskRisk, requiresHumanApproval } from "./policy";
import { REVIEW_CYCLE_EXHAUSTED_REASON } from "./review-policy";
import type { EventStore } from "./event-store";
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
// seam. opts.events(event-store.ts의 EventStore)를 지정하지 않으면 이 파일의 동작은
// G1 이전과 완전히 동일하다(emitEvent가 즉시 no-op) — 기존 production flow를 크게 뜯지
// 않는다. 지정하면 run/task/agent/test/reviewer/checkpoint 지점에서 실제로 이미 계산된
// 값(finalState.lastClaudeResult/lastGptDecision, checkpoint.ok 등)만으로 event를
// 기록한다 — 새로운 판정을 만들지 않고, 기존 값을 관찰만 한다. developer/reviewer의 매
// REVISE cycle마다 개별 event를 남기지는 않는다(그 loop는 orchestrator.ts 내부에 있고,
// 이번 Task는 그 내부를 뜯지 않는다 — § 남은 문제) — 대신 최종 decision과 실제
// reviewCycle 횟수를 하나의 event에 담는다.
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
  /** 지정하지 않으면 이 실행마다 새 runId를 생성한다(node:crypto의 randomUUID). */
  runId?: string;
}

export type AutodevRunOutcome =
  | "STOPPED"
  | "RAN_TASK_APPROVED_AND_CHECKPOINTED"
  | "RAN_TASK_NOT_APPROVED"
  | "RAN_TASK_CHECKPOINT_BLOCKED";

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
 * events가 지정되지 않았으면 즉시 no-op(이 파일의 기존 동작을 전혀 바꾸지 않는다). append가
 * 실패하면(event-store.ts는 실패를 ok:false로 정직하게 반환한다) 그 사실을 logger.ts의
 * log()로 눈에 보이게 남긴다 — 실패를 조용히 성공으로 위장하지 않는다. 이 함수 자체가
 * runAutodevOnce()의 실제 흐름/반환값에는 영향을 주지 않는다(observability 실패가 production
 * 실행을 막으면 안 된다).
 */
function emitEvent(events: EventStore | undefined, input: AutoDevEventInput): void {
  if (!events) return;
  const result = events.append(input);
  if (!result.ok) {
    log("audit/observability event 기록 실패", { eventType: input.eventType, runId: input.runId, error: result.error });
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
  const runId = opts.runId ?? randomUUID();
  const events = opts.events;

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
    ...opts.orchestratorDeps,
  });

  // Phase G Task G1 — orchestrator.ts가 이미 계산한 값(finalState)만 관찰해서 test/review
  // event를 남긴다. REVISE loop 자체는 orchestrator.ts 내부에 있어 cycle별 개별 event는
  // 없다 — 최종 decision 하나에 실제 reviewCycle 횟수(finalState.reviewCycle)를 담는다.
  const testsForEvent = finalState.lastClaudeResult?.tests ?? [];
  if (testsForEvent.length > 0) {
    emitEvent(events, {
      eventType: "TEST_COMPLETED",
      runId,
      projectId: manifest.projectId,
      taskId: taskDef.id,
      executionPhase: "test",
      outcome: testsForEvent.every((t) => t.pass) ? "SUCCESS" : "FAILED",
      testSummary: {
        total: testsForEvent.length,
        passed: testsForEvent.filter((t) => t.pass).length,
        failed: testsForEvent.filter((t) => !t.pass).length,
        failedNames: testsForEvent.filter((t) => !t.pass).map((t) => t.name),
      },
    });
  }
  const reviewDecision = finalState.lastGptDecision?.decision;
  if (reviewDecision) {
    const reviewEventType = reviewDecision === "PASS" ? "REVIEW_APPROVED" : reviewDecision === "REVISE" ? "REVIEW_REVISE" : "REVIEW_BLOCKED";
    emitEvent(events, {
      eventType: reviewEventType,
      runId,
      projectId: manifest.projectId,
      taskId: taskDef.id,
      executionPhase: "review",
      outcome: reviewDecision === "PASS" ? "SUCCESS" : reviewDecision === "REVISE" ? "PENDING" : "BLOCKED",
      reviewDecision,
      reviewSeverity: finalState.lastGptDecision?.severity,
      reviseCycle: finalState.reviewCycle,
      reason: finalState.lastGptDecision?.feedback,
    });
  }
  if (finalState.deferredHumanTasks.some((t) => t.startsWith(REVIEW_CYCLE_EXHAUSTED_REASON))) {
    emitEvent(events, {
      eventType: "REVIEW_CYCLE_EXHAUSTED",
      runId,
      projectId: manifest.projectId,
      taskId: taskDef.id,
      executionPhase: "review",
      outcome: "BLOCKED",
      reviseCycle: finalState.reviewCycle,
      humanInterventionRequired: true,
      reason: finalState.deferredHumanTasks.find((t) => t.startsWith(REVIEW_CYCLE_EXHAUSTED_REASON)),
    });
  }

  if (finalState.status !== "APPROVED") {
    console.log(`[autodev] task ${taskDef.id} — orchestrator가 APPROVED로 끝나지 않음(status=${finalState.status}). checkpoint 생략.`);
    emitEvent(events, {
      eventType: "HUMAN_APPROVAL_REQUIRED",
      runId,
      projectId: manifest.projectId,
      taskId: taskDef.id,
      executionPhase: "review",
      outcome: "BLOCKED",
      humanInterventionRequired: true,
      reason: `orchestrator status=${finalState.status}`,
    });
    emitEvent(events, {
      eventType: "RUN_BLOCKED",
      runId,
      projectId: manifest.projectId,
      taskId: taskDef.id,
      executionPhase: "review",
      outcome: "BLOCKED",
      reason: `orchestrator status=${finalState.status}`,
    });
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
    const afterOrchestrator = loadState(statePath);
    afterOrchestrator.status = "WAITING_HUMAN";
    afterOrchestrator.deferredHumanTasks.push(
      `CHECKPOINT_BLOCKED(${taskDef.id}): ${checkpoint.reason}` +
        (checkpoint.unexpectedFiles?.length ? ` — unexpected: ${checkpoint.unexpectedFiles.join(", ")}` : "")
    );
    saveState(afterOrchestrator, statePath);
    log("checkpoint 실패 — WAITING_HUMAN으로 전환", { taskId: taskDef.id, reason: checkpoint.reason });
    // Phase G Task G1 — Secret/Dependency Scanner Gate(Core, checkpoint.ts)가 실제로 걸린
    // 경우만 SECURITY_BLOCKED로 남긴다(원문은 담지 않는다 — checkpoint.secretFindings는
    // 이미 file/line/kind만 담고 원문을 포함하지 않는다). 그 외 checkpoint 실패 사유(예:
    // allowedPathPrefixes 밖 변경)는 HUMAN_APPROVAL_REQUIRED로 남긴다.
    const isSecurityGate = (checkpoint.secretFindings?.length ?? 0) > 0 || checkpoint.dependencyScanVerdict === "BLOCK";
    emitEvent(events, {
      eventType: isSecurityGate ? "SECURITY_BLOCKED" : "HUMAN_APPROVAL_REQUIRED",
      runId,
      projectId: manifest.projectId,
      taskId: taskDef.id,
      executionPhase: "checkpoint",
      outcome: "BLOCKED",
      humanInterventionRequired: true,
      reason: checkpoint.reason,
      metadata: { secretFindingCount: checkpoint.secretFindings?.length ?? 0, dependencyScanVerdict: checkpoint.dependencyScanVerdict ?? null },
    });
    emitEvent(events, { eventType: "RUN_BLOCKED", runId, projectId: manifest.projectId, taskId: taskDef.id, executionPhase: "checkpoint", outcome: "BLOCKED", reason: checkpoint.reason });
    return {
      outcome: "RAN_TASK_CHECKPOINT_BLOCKED",
      taskId: taskDef.id,
      orchestratorStatus: String(finalState.status),
      checkpoint,
      reason: checkpoint.reason,
      ...agentAdvisoryField,
    };
  }

  emitEvent(events, {
    eventType: "CHECKPOINT_CREATED",
    runId,
    projectId: manifest.projectId,
    taskId: taskDef.id,
    executionPhase: "checkpoint",
    outcome: "SUCCESS",
    metadata: { commitHash: checkpoint.commitHash ?? null },
  });

  // product commit(위 performTaskCheckpoint)이 끝난 뒤에만 project-state.json을 갱신하고
  // 별도의 administrative commit으로 남긴다 — project-state.json은 스스로를 같은 commit
  // 안에서 참조할 수 없으므로(자기참조 문제) 2단계로 분리한다.
  const updated = loadState(statePath);
  updated.completedTasks = [...(updated.completedTasks ?? []), taskDef.id];
  updated.gitCheckpoint = checkpoint.commitHash ?? updated.gitCheckpoint;
  updated.currentPhase = taskDef.phase;
  updated.lastGptDecision = finalState.lastGptDecision;

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

  console.log(`[autodev] task ${taskDef.id} APPROVED + checkpoint 완료 (commit ${checkpoint.commitHash ?? "?"})`);
  emitEvent(events, { eventType: "TASK_COMPLETED", runId, projectId: manifest.projectId, taskId: taskDef.id, executionPhase: "state_update", outcome: "SUCCESS" });
  emitEvent(events, { eventType: "RUN_COMPLETED", runId, projectId: manifest.projectId, taskId: taskDef.id, executionPhase: "state_update", outcome: "SUCCESS" });
  return {
    outcome: "RAN_TASK_APPROVED_AND_CHECKPOINTED",
    taskId: taskDef.id,
    orchestratorStatus: String(finalState.status),
    checkpoint,
    ...agentAdvisoryField,
  };
}

// 프로세스 진입점(main()/SIGINT 처리/require.main===module 가드)은 이 파일에 없다 — Core는
// 자기 자신을 어떻게 실행할지 모른다(Phase A Task A7). 실제 MOVAN 실행은 run-movan.ts가
// 담당한다 — 그 파일이 MOVAN_PROJECT_MANIFEST를 명시적으로 조립해 runAutodevOnce()를 호출한다.
