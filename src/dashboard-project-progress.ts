import { loadProjectAdapter } from "./project-adapter-loader";
import { loadState } from "./state";
import { getNextTask } from "./task-registry";
import type { TaskDefinition } from "./task-registry";

// 오토데브 대시보드 후속 개선 — 프로젝트 전체 진행 상황(§ 요구사항 3).
//
// AutoDev Core는 어떤 프로젝트를 다루는지 모른다(§ CLAUDE.md) — 이 파일도 예외가
// 아니다. 프로젝트의 task-registry/project-state를 읽으려면 run.ts가 이미 쓰는 것과
// 완전히 동일한 경로(--project/AUTODEV_PROJECT_ADAPTER 환경변수가 가리키는 project
// config JSON, project-adapter-loader.ts)로만 접근한다 — 새 설정 방식을 만들지 않는다.
// 이 값이 설정돼 있지 않으면 이 파일은 그 사실을 정직하게 반환할 뿐 아무 것도 추측하지
// 않는다(§ 요구사항: 숫자를 화면 코드에 고정하지 않는다).
//
// 이 파일은 읽기만 한다 — project-state.json/task-registry 어느 쪽도 쓰지 않는다.

export interface ProjectProgress {
  projectName: string;
  totalPhases: number;
  totalTasks: number;
  completedTaskCount: number;
  currentTaskId?: string;
  currentTaskTitle?: string;
  currentTaskPhase?: number;
  nextTaskId?: string;
  nextTaskTitle?: string;
  /** 0~100. registry가 비어있으면(이론상 발생하지 않지만 방어적으로) undefined. */
  overallProgressPercent?: number;
  currentPhaseTaskCount?: number;
  currentPhaseCompletedCount?: number;
  currentPhaseProgressPercent?: number;
}

export function computeProjectProgress(
  projectName: string,
  taskRegistry: readonly TaskDefinition[],
  completedTasks: readonly string[]
): ProjectProgress {
  const totalPhases = new Set(taskRegistry.map((t) => t.phase)).size;
  const totalTasks = taskRegistry.length;
  const completedTaskCount = completedTasks.filter((id) => taskRegistry.some((t) => t.id === id)).length;

  const currentTask = getNextTask(taskRegistry, completedTasks);
  const nextTask = currentTask ? getNextTask(taskRegistry, [...completedTasks, currentTask.id]) : null;

  const overallProgressPercent = totalTasks > 0 ? (completedTaskCount / totalTasks) * 100 : undefined;

  let currentPhaseTaskCount: number | undefined;
  let currentPhaseCompletedCount: number | undefined;
  let currentPhaseProgressPercent: number | undefined;
  if (currentTask) {
    const phaseTasks = taskRegistry.filter((t) => t.phase === currentTask.phase);
    currentPhaseTaskCount = phaseTasks.length;
    currentPhaseCompletedCount = phaseTasks.filter((t) => completedTasks.includes(t.id)).length;
    currentPhaseProgressPercent = currentPhaseTaskCount > 0 ? (currentPhaseCompletedCount / currentPhaseTaskCount) * 100 : undefined;
  }

  return {
    projectName,
    totalPhases,
    totalTasks,
    completedTaskCount,
    currentTaskId: currentTask?.id,
    currentTaskTitle: currentTask?.title,
    currentTaskPhase: currentTask?.phase,
    nextTaskId: nextTask?.id,
    nextTaskTitle: nextTask?.title,
    overallProgressPercent,
    currentPhaseTaskCount,
    currentPhaseCompletedCount,
    currentPhaseProgressPercent,
  };
}

export type LoadProjectProgressResult = { ok: true; progress: ProjectProgress } | { ok: false; reason: string };

/**
 * adapterPath가 없으면(대시보드 프로세스에 AUTODEV_PROJECT_ADAPTER가 설정돼 있지 않으면)
 * 즉시 실패를 반환한다 — 이 경우 대시보드는 "프로젝트 자료 없음"으로 정직하게 표시해야
 * 한다(추측 금지). loadProjectAdapter()/loadState()가 던지는 어떤 예외도 여기서 잡아
 * 대시보드 프로세스 자체가 죽지 않게 한다(읽기 전용 조회 실패가 대시보드 전체를 무너뜨려서는
 * 안 된다).
 */
export function loadProjectProgress(adapterPath: string | undefined): LoadProjectProgressResult {
  if (!adapterPath || adapterPath.trim().length === 0) {
    return { ok: false, reason: "PROJECT_ADAPTER_NOT_CONFIGURED" };
  }
  try {
    const manifest = loadProjectAdapter(adapterPath);
    const state = loadState(manifest.statePath);
    const progress = computeProjectProgress(manifest.projectName, manifest.taskRegistry, state.completedTasks);
    return { ok: true, progress };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
