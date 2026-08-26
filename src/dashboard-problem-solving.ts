import { createFileProblemMemoryStore } from "./problem-memory";
import type { ProblemMemoryEntry, ProblemMemoryStore } from "./problem-memory";

// 오토데브 대시보드 후속 개선 — 현재 문제 해결 상황(§ 요구사항 9/11).
//
// 이 파일은 problem-memory.ts(지능형 오류 복구 하드닝)가 이미 기록한 자료를 읽기만 한다 —
// 새 문제 해결 판정/엔진을 만들지 않는다(§ 요구사항: "새로운 문제 해결 엔진을 대시보드
// 안에 만들지 않는다"). "자동 복구 횟수"/"자동 복구 성공 횟수"처럼 현재 어떤 기록도 남기지
// 않는 항목(required-test-preflight.ts의 자동 등록은 log()만 남기고 problem-memory나
// EventStore에 구조화된 event를 남기지 않는다)은 이 파일도 추측해서 채우지 않는다 — 그
// 항목은 이 스냅샷에 아예 포함시키지 않고, 호출부(dashboard-html.ts)가 "확인 불가"로
// 정직하게 표시한다.

export interface ProblemSolvingSnapshot {
  currentProblem?: {
    fingerprint: string;
    errorType: string;
    failedCheck?: string;
    /** 이 task 안에서 이미 실패로 기록된 시도 횟수(§ 요구사항 11 "같은 오류 반복 횟수"). */
    repeatedFailureCount: number;
    lastSeenAt: string;
    /** 이 문제가 이미 확정된 해결책으로 종결됐는지(§ pendingConfirmation===false이고
     *  finalSuccessfulSolution이 있음). */
    resolved: boolean;
  };
  /** 현재 문제와 같은 fingerprint를 가진, 이미 확정된(재사용 가능한) 다른 사례 수 —
   *  project tier(다른 task)와 common tier를 합친다. */
  similarPastCasesCount: number;
  /** 이 project의 problem-memory 전체에서 관측된 재사용 성공/실패 총합(§ 요구사항 2
   *  reuseSuccessCount/reuseFailureCount 필드를 그대로 합산). */
  totalReuseSuccessCount: number;
  totalReuseFailureCount: number;
}

/** projectId/currentTaskId가 없으면(아직 project 자료가 없거나 현재 task를 특정할 수 없음)
 *  undefined를 반환한다 — 추측하지 않는다. stores를 지정하지 않으면(운용 경로) 실제
 *  problem-memory 파일을 읽는다 — 테스트는 반드시 stores를 임시 store로 override한다. */
export function buildProblemSolvingSnapshot(
  projectId: string | undefined,
  currentTaskId: string | undefined,
  stores?: { project: ProblemMemoryStore; common: ProblemMemoryStore }
): ProblemSolvingSnapshot | undefined {
  if (!projectId) return undefined;

  const projectStore = stores?.project ?? createFileProblemMemoryStore("PROJECT", projectId);
  const commonStore = stores?.common ?? createFileProblemMemoryStore("COMMON", undefined);
  const projectEntries = projectStore.load();
  const commonEntries = commonStore.load();

  if (projectEntries.length === 0 && commonEntries.length === 0) return undefined;

  let totalReuseSuccessCount = 0;
  let totalReuseFailureCount = 0;
  for (const e of projectEntries) {
    totalReuseSuccessCount += e.reuseSuccessCount;
    totalReuseFailureCount += e.reuseFailureCount;
  }

  const currentEntry: ProblemMemoryEntry | undefined = currentTaskId
    ? projectEntries
        .filter((e) => e.taskId === currentTaskId)
        .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt))[0]
    : undefined;

  let similarPastCasesCount = 0;
  if (currentEntry) {
    similarPastCasesCount =
      projectEntries.filter((e) => e.id !== currentEntry.id && e.fingerprint === currentEntry.fingerprint && e.finalSuccessfulSolution && !e.pendingConfirmation).length +
      commonEntries.filter((e) => e.fingerprint === currentEntry.fingerprint && e.finalSuccessfulSolution && !e.pendingConfirmation).length;
  }

  return {
    currentProblem: currentEntry
      ? {
          fingerprint: currentEntry.fingerprint,
          errorType: currentEntry.errorType,
          failedCheck: currentEntry.failedCheck,
          repeatedFailureCount: currentEntry.attemptedSolutions.filter((s) => s.outcome === "FAILURE").length,
          lastSeenAt: currentEntry.lastSeenAt,
          resolved: !currentEntry.pendingConfirmation && currentEntry.finalSuccessfulSolution !== undefined,
        }
      : undefined,
    similarPastCasesCount,
    totalReuseSuccessCount,
    totalReuseFailureCount,
  };
}
