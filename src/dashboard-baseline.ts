import type { AutoDevEvent } from "./observability-event";
import { buildReviewerHistory } from "./dashboard-reviewer-history";
import { buildDeveloperLifecycle } from "./dashboard-developer-lifecycle";

// AutoDev Dashboard 멀티프로젝트 운영센터 개선 — BASELINE 측정 기능(§ 요구사항 11).
//
// Graphify 같은 최적화 도구를 실제로 도입하기 전에 "지금 AutoDev가 어떤 비용으로
// task 하나를 끝내는가"를 실측 기록해두기 위한 순수 집계 함수다. 새 판정/추정 로직을
// 만들지 않는다 — dashboard-reviewer-history.ts/dashboard-developer-lifecycle.ts가 이미
// 검증된 event 재구성 결과를 그대로 합산할 뿐이다. 이 파일은 어디에도 자동으로 저장하지
// 않는다(persist는 호출부 책임) — Dashboard 상시 화면에 이 값을 크게 표시하지도 않는다
// (§ 요구사항: "비교 가능한 baseline이 없으면 값을 만들지 마라").
//
// taskCategory는 이 파일이 스스로 추측하지 않는다 — 호출부가 이미 알고 있는 task 제목/설명
// 텍스트를 넘기면 아주 단순한 키워드 매칭만 적용하고(§ classifyTaskCategoryFromText), 명확히
// 판단할 근거가 없으면 항상 UNKNOWN이다(§ 요구사항: "과도한 자동 분류 시스템을 만들 필요는
// 없다").

export type TaskCategory = "SIMPLE_EDIT" | "STRUCTURE_EXPLORATION" | "INCIDENT_FORENSICS" | "UNKNOWN";

const EXPLORATION_KEYWORDS = ["탐색", "구조 파악", "조사", "investigate", "explore"];
const INCIDENT_KEYWORDS = ["장애", "오류 원인", "포렌식", "incident", "root cause", "forensic"];
const SIMPLE_EDIT_KEYWORDS = ["함수 작성", "간단한 수정", "오타", "단순 수정"];

/** 매우 단순한 키워드 매칭만 한다 — 애매하면 항상 UNKNOWN(추측하지 않는다). 여러 범주
 *  키워드가 동시에 매칭되면(모호함) 그 자체도 UNKNOWN으로 처리한다. */
export function classifyTaskCategoryFromText(text: string | undefined): TaskCategory {
  if (!text) return "UNKNOWN";
  const lower = text.toLowerCase();
  const hits = {
    STRUCTURE_EXPLORATION: EXPLORATION_KEYWORDS.some((k) => lower.includes(k.toLowerCase())),
    INCIDENT_FORENSICS: INCIDENT_KEYWORDS.some((k) => lower.includes(k.toLowerCase())),
    SIMPLE_EDIT: SIMPLE_EDIT_KEYWORDS.some((k) => lower.includes(k.toLowerCase())),
  };
  const matched = Object.entries(hits).filter(([, v]) => v).map(([k]) => k);
  return matched.length === 1 ? (matched[0] as TaskCategory) : "UNKNOWN";
}

export interface TaskBaselineRecord {
  projectId: string;
  taskId: string;
  taskCategory: TaskCategory;
  developerCallCount: number;
  developerNormalEndCount: number;
  developerAbnormalEndCount: number;
  developerStartedAt?: string;
  developerEndedAt?: string;
  /** 각 attempt duration의 단순 합 — attempt 사이 대기 시간(REVISE 검토 대기 등)은 포함하지
   *  않는다(§ work-time.ts와 동일 원칙: 실제 작업 구간만 합산, 대기 구간은 별개). */
  developerTotalDurationMs: number;
  reviewerCallCount: number;
  reviewerCallCountByProvider: Record<string, number>;
  reviseCount: number;
  /** REVIEW_APPROVED/BLOCKED로 이 task의 최종 결과가 이미 확정됐으면 그 값, 아직이면
   *  UNKNOWN(추측 금지 — task가 진행 중일 수 있다). */
  finalResult: "PASS" | "FAIL" | "UNKNOWN";
  /** task 전체 소요시간(첫 Developer 시작 ~ 마지막으로 관측된 event) — 아직 진행 중이면
   *  "지금까지의" 경과이므로 별도 필드명으로 구분하지 않고 그대로 duration으로 쓰되,
   *  finalResult가 UNKNOWN이면 이 값이 "아직 끝나지 않은 task의 중간 경과"라는 것을
   *  호출부가 finalResult로 함께 판단해야 한다.
   */
  taskDurationMs?: number;
}

/**
 * events는 QueryResult.events(전체 store) 또는 이미 project로 좁혀진 목록 모두 받을 수
 * 있다 — 내부에서 projectId/taskId로 다시 좁힌다(다른 project/task 데이터 혼입 방지, §
 * metrics.ts와 동일한 방어). taskTitleOrPrompt는 순수 표시/분류용 텍스트로만 쓰이고 어떤
 * 판정에도 관여하지 않는다.
 */
export function buildTaskBaseline(
  events: readonly AutoDevEvent[],
  projectId: string,
  taskId: string,
  taskTitleOrPrompt?: string
): TaskBaselineRecord {
  const scoped = events.filter((e) => e.projectId === projectId && e.taskId === taskId);

  const lifecycle = buildDeveloperLifecycle(scoped, projectId, taskId);
  const reviewerHistory = buildReviewerHistory(scoped, projectId);

  const developerTotalDurationMs = lifecycle.attempts.reduce((sum, a) => sum + (a.durationMs ?? 0), 0);
  const developerNormalEndCount = lifecycle.attempts.filter((a) => a.outcome === "NORMAL_END").length;
  const developerAbnormalEndCount = lifecycle.attempts.filter((a) => a.outcome === "ABNORMAL_END").length;

  const reviewerCallCountByProvider: Record<string, number> = {};
  for (const r of reviewerHistory) {
    reviewerCallCountByProvider[r.provider] = (reviewerCallCountByProvider[r.provider] ?? 0) + 1;
  }
  const reviseCount = reviewerHistory.filter((r) => r.result === "REVISE").length;

  let finalResult: TaskBaselineRecord["finalResult"] = "UNKNOWN";
  const lastReviewerCall = reviewerHistory.length > 0 ? reviewerHistory[reviewerHistory.length - 1] : undefined;
  if (lastReviewerCall?.result === "PASS") finalResult = "PASS";
  else if (lastReviewerCall?.result === "BLOCK") finalResult = "FAIL";

  const sorted = scoped.slice().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.sequence - b.sequence);
  const firstEvent = sorted.length > 0 ? sorted[0] : undefined;
  const lastEvent = sorted.length > 0 ? sorted[sorted.length - 1] : undefined;
  const taskDurationMs = firstEvent && lastEvent ? Date.parse(lastEvent.timestamp) - Date.parse(firstEvent.timestamp) : undefined;

  return {
    projectId,
    taskId,
    taskCategory: classifyTaskCategoryFromText(taskTitleOrPrompt),
    developerCallCount: lifecycle.attempts.length,
    developerNormalEndCount,
    developerAbnormalEndCount,
    developerStartedAt: lifecycle.attempts[0]?.startedAt,
    developerEndedAt: lifecycle.latest?.endedAt,
    developerTotalDurationMs,
    reviewerCallCount: reviewerHistory.length,
    reviewerCallCountByProvider,
    reviseCount,
    finalResult,
    taskDurationMs,
  };
}
