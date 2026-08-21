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
import { log } from "./logger";
import type { CoreState } from "./types";

// AutoDev Core — "project-state 읽기 → 다음 Task 자동 결정(task-registry.ts 엔진 +
// manifest.taskRegistry 데이터) → Claude 실제 개발 → targeted tests(AutoDev가 직접
// 실행) → GPT 독립 리뷰 → REVISE 자동 루프(orchestrator.ts가 전담) → Critical 0/High 0
// PASS면 → 해당 Task 파일만 Git checkpoint → project-state 갱신 → 다음 Task 자동 선택"까지
// 전부 이 파일이 배선한다. Phase별 if문을 여기 하드코딩하지 않는다 — task-registry.ts의
// getNextTask()에 ProjectManifest.taskRegistry를 주입한 순서/completedTasks만으로 다음
// task를 고른다(decideNextAction).
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
}

function computeStateRelPath(statePath: string, cwd: string): string {
  return relative(cwd, statePath).split(sep).join("/");
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

  const state = loadState(statePath);
  const decision = decideNextAction(state, manifest.taskRegistry);

  if (decision.kind === "STOP") {
    console.log(`[autodev] ${decision.reason}`);
    if (decision.setWaitingHuman && (state.status as unknown as string) !== "WAITING_HUMAN") {
      state.status = "WAITING_HUMAN";
      saveState(state, statePath);
    }
    return { outcome: "STOPPED", reason: decision.reason };
  }

  const taskDef = decision.task;
  console.log(`[autodev] 다음 task 선택: ${taskDef.id} — ${taskDef.title}`);

  // manifest.developerInstructions/reviewInstructions는 Claude Developer/GPT Reviewer
  // Core(claude-developer.ts/gpt-reviewer.ts)가 전혀 모르는 프로젝트별 내용이다 — 이 파일이
  // ProjectManifest로부터 조립해 명시적으로 주입한다(Phase A Task A6). 어떤 manifest가
  // 주입되든(MOVAN이든 fixture든) 동일한 방식으로 조립되므로 이 파일은 프로젝트를 가리지 않는다.
  const developerContext: DeveloperProjectContext = {
    projectName: manifest.projectName,
    instructions: manifest.developerInstructions,
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

  if (finalState.status !== "APPROVED") {
    console.log(`[autodev] task ${taskDef.id} — orchestrator가 APPROVED로 끝나지 않음(status=${finalState.status}). checkpoint 생략.`);
    return {
      outcome: "RAN_TASK_NOT_APPROVED",
      taskId: taskDef.id,
      orchestratorStatus: String(finalState.status),
      reason: `orchestrator status=${finalState.status}`,
    };
  }

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
    return {
      outcome: "RAN_TASK_CHECKPOINT_BLOCKED",
      taskId: taskDef.id,
      orchestratorStatus: String(finalState.status),
      checkpoint,
      reason: checkpoint.reason,
    };
  }

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
  return {
    outcome: "RAN_TASK_APPROVED_AND_CHECKPOINTED",
    taskId: taskDef.id,
    orchestratorStatus: String(finalState.status),
    checkpoint,
  };
}

// 프로세스 진입점(main()/SIGINT 처리/require.main===module 가드)은 이 파일에 없다 — Core는
// 자기 자신을 어떻게 실행할지 모른다(Phase A Task A7). 실제 MOVAN 실행은 run-movan.ts가
// 담당한다 — 그 파일이 MOVAN_PROJECT_MANIFEST를 명시적으로 조립해 runAutodevOnce()를 호출한다.
