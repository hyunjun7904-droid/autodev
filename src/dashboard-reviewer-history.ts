import type { AutoDevEvent, AutoDevEventType } from "./observability-event";
import { providerDisplayName } from "./dashboard-usage";

// AutoDev Dashboard 멀티프로젝트 운영센터 개선 — Reviewer 호출 이력(§ 요구사항 6).
//
// dashboard-usage.ts의 REVIEW_CALL_EVENT_TYPES/resolveModelRef와 동일한 event 종류
// (REVIEW_APPROVED/REVIEW_REVISE/REVIEW_BLOCKED, model이 실제로 기록된 것만)를 다시
// 쓴다 — 그 파일의 buildRecentCalls()는 Developer/Reviewer 호출을 섞어 "최근 N건"만
// 보여주는 반면, 이 파일은 Reviewer 호출만 시간순으로 전부 나열해 "몇 번째 호출인지",
// "provider가 바뀌었는지"를 보여준다. 새 관측 event나 판정 규칙을 만들지 않는다 — 이미
// 기록된 event만 재구성한다.
//
// "escalation" 표시에 대한 중요한 제약(§ 요구사항: 실제로 호출되지 않은 provider를 호출된
// 것처럼 표시하지 않는다) — final-reviewer-routing.ts의 provider escalation(예: Fireworks
// 응답이 나쁘면 같은 review cycle 안에서 Groq를 추가로 호출)은 오직 최종 채택된 decision
// event 하나(REVIEW_APPROVED/REVISE/BLOCKED, model=최종 채택된 provider)만 남긴다 — 실패한
// 1차 provider 호출 자체는 별도 event로 기록되지 않으므로 이 파일은 그 존재를 재구성하지
// 않는다. 대신 이 파일이 실제로 관측 가능한 사실만 표시한다: 같은 task 안에서 "바로 이전
// 호출"과 "이번 호출"의 provider가 실제로 다르면 그 사실(providerChangedFromPrevious)만
// 정직하게 표시한다.

const REVIEWER_DECISION_EVENT_TYPES: ReadonlySet<AutoDevEventType> = new Set(["REVIEW_APPROVED", "REVIEW_REVISE", "REVIEW_BLOCKED"]);

const EVENT_TYPE_TO_RESULT: Partial<Record<AutoDevEventType, "PASS" | "REVISE" | "BLOCK">> = {
  REVIEW_APPROVED: "PASS",
  REVIEW_REVISE: "REVISE",
  REVIEW_BLOCKED: "BLOCK",
};

export interface ReviewerCallEntry {
  /** 이 scope(프로젝트 또는 프로젝트+작업) 안에서 시간순 1부터 매기는 호출 순번. */
  sequenceNumber: number;
  timestamp: string;
  taskId?: string;
  provider: string;
  service: string;
  model?: string;
  result: "PASS" | "REVISE" | "BLOCK";
  reviewCycle?: number;
  /** 같은 taskId의 바로 이전 Reviewer 호출과 provider가 실제로 다르면 true(관측된 사실만—
   *  내부에서 왜 바뀌었는지는 이 event만으로 알 수 없으므로 추측하지 않는다). 이 task의 첫
   *  호출이면 false. */
  providerChangedFromPrevious: boolean;
}

function sortChronological(events: readonly AutoDevEvent[]): AutoDevEvent[] {
  return events.slice().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.sequence - b.sequence);
}

/** events는 QueryResult.events(파일 store 전체 — 여러 project가 섞여 있을 수 있음)를 그대로
 *  넘겨도 된다 — projectId가 지정되면 이 함수 내부에서 좁힌다(호출부가 이미 좁혔더라도
 *  안전하게 한 번 더 필터링, § metrics.ts/live-snapshot.ts와 동일한 방어 관례). */
export function buildReviewerHistory(events: readonly AutoDevEvent[], projectId: string | undefined): ReviewerCallEntry[] {
  const scoped = sortChronological(projectId ? events.filter((e) => e.projectId === projectId) : events).filter(
    (e) => REVIEWER_DECISION_EVENT_TYPES.has(e.eventType) && e.model
  );

  const entries: ReviewerCallEntry[] = [];
  const lastProviderByTask = new Map<string, string>();
  let seq = 0;
  for (const e of scoped) {
    if (!e.model) continue;
    seq += 1;
    const taskKey = e.taskId ?? "__NO_TASK__";
    const prevProvider = lastProviderByTask.get(taskKey);
    const providerChangedFromPrevious = prevProvider !== undefined && prevProvider !== e.model.provider;
    lastProviderByTask.set(taskKey, e.model.provider);
    const result = EVENT_TYPE_TO_RESULT[e.eventType];
    if (!result) continue;
    entries.push({
      sequenceNumber: seq,
      timestamp: e.timestamp,
      taskId: e.taskId,
      provider: e.model.provider,
      service: providerDisplayName(e.model.provider),
      model: e.model.name,
      result,
      reviewCycle: e.reviseCycle,
      providerChangedFromPrevious,
    });
  }
  return entries;
}
