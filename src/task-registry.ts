import type { CoreState } from "./types";

// AutoDev Core — "다음 Task 자동 선택" 엔진(Phase A Task A3: MOVAN 전용 데이터와 분리).
// 이 파일은 Task를 어떻게 고르는가라는 방법(타입 + 순수 함수)만 안다 — 실제로 무엇을 할지
// (Phase 번호, Task 제목, implementationPrompt, requiredTests, allowedPathPrefixes 등
// MOVAN 업무 내용)는 이 파일에 없다. 그 데이터는 project-registries/movan.ts처럼 프로젝트별
// 파일이 담당하고, getNextTask/findTaskById/isProjectComplete에 registry 인자로 주입된다
// (예: automation/src/project-registries/movan.ts의 MOVAN_TASK_REGISTRY).
//
// 이 파일 자체는 "무엇을 할지"만 선언하지 않는다 — 실제로 Claude worker를 부르거나 git commit을
// 만드는 부수효과도 전혀 없다(순수 타입 + 순수 함수).

export interface RequiredTestCommand {
  /** ClaudeResult.tests[].name에 그대로 쓰인다. */
  name: string;
  command: string;
  args: string[];
  /** "root"(targetProjectRoot 자체) 또는 프로젝트의 ProjectExecutionPolicy.commandCwdAliases가
   *  정의한 별칭 — 이 파일은 그 별칭이 무엇인지 모른다(프로젝트별 데이터). */
  cwd: string;
}

export interface TaskDefinition {
  /** "{phase}.{taskNumber}" 형식, 예: "13.2". completedTasks에 저장되는 값과 동일하다. */
  id: string;
  phase: number;
  taskNumber: number;
  title: string;
  /** Claude worker(runDeveloperTaskViaSafeExecutor)에 그대로 전달되는 구현 지시문. */
  prompt: string;
  /** AutoDev가 TASK_COMPLETE 이후 Safe Executor로 직접 실행해 실제 exitCode로 검증하는
   *  테스트 — Claude의 자체 보고("test passed" 문자열)를 신뢰하지 않는다(§ 요구사항 6). */
  requiredTests: RequiredTestCommand[];
  /** 이 task가 수정할 수 있는 경로 prefix(POSIX 상대경로, trailing "/"). checkpoint.ts가
   *  실제 변경 파일이 이 안에 있는지 검증하고, 벗어나면 commit 자체를 BLOCK한다. */
  allowedPathPrefixes: string[];
  /** 사람이 읽는 금지 사항 목록 — prompt 본문에도 녹여 넣지만, GPT reviewer/사람이 빠르게
   *  확인할 수 있도록 구조화된 형태로도 별도 보관한다. */
  prohibitedOperations: string[];
  /** 이 task가 끝나면 "다음 task"가 없고, 남은 것은 사람이 트리거하는 실제 배포뿐이라는 뜻. */
  isHumanGate?: boolean;
}

/** AutoDev 레벨 plan marker — state.status에 기록되는, OrchestratorStatus enum 밖의 값들. */
export const PLAN_MARKERS = {
  PROJECT_COMPLETE: "PROJECT_COMPLETE",
  DEPLOYMENT_WAITING_HUMAN: "DEPLOYMENT_WAITING_HUMAN",
} as const;

/**
 * completedTaskIds 목록을 보고 주어진 registry 순서상 다음 미완료 task를 고른다(순수 함수).
 * registry는 호출부가 명시적으로 주입한다 — 이 함수는 어떤 프로젝트의 registry인지 모른다.
 */
export function getNextTask(registry: readonly TaskDefinition[], completedTaskIds: readonly string[]): TaskDefinition | null {
  const completed = new Set(completedTaskIds);
  for (const task of registry) {
    if (!completed.has(task.id)) return task;
  }
  return null;
}

/** id로 registry 안의 task 정의를 직접 조회(checkpoint/orchestrator 배선에 사용). */
export function findTaskById(registry: readonly TaskDefinition[], id: string): TaskDefinition | undefined {
  return registry.find((t) => t.id === id);
}

export function isProjectComplete(registry: readonly TaskDefinition[], state: Pick<CoreState, "completedTasks">): boolean {
  return getNextTask(registry, state.completedTasks) === null;
}
