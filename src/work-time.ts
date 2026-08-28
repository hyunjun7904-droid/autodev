import type { AutoDevEvent } from "./observability-event";
import { walkEvents } from "./live-snapshot";
import type { LiveStatus } from "./live-snapshot";

// 오토데브 대시보드 후속 개선 — 실제 작업시간(§ 요구사항 10).
//
// 기존 dashboard-html.ts의 "경과 시간"은 "지금 시각 - 작업 시작 시각"이라 오토데브가
// 중단돼 있거나(프로세스 종료/사람 승인 대기/사용량 제한 대기) 아무 일도 하지 않는 동안에도
// 계속 증가했다. 이 파일은 그 값을 대체하는 "실제 작업시간"을 EventStore(이미 존재하는
// append-only 기록)만으로 계산한다 — 오토데브 핵심 흐름(orchestrator.ts/autodev.ts)에
// 새 계측 코드를 추가하지 않는다(§ 이번 작업 범위 제한). live-snapshot.ts의 walkEvents()
// (이미 검증된 "지금 상태가 무엇인가" 단일 판정 로직)를 그대로 재사용해 상태를 판정하고,
// 여기서는 그 상태가 "실제 작업 중"으로 분류되는 구간의 길이만 합산한다 — 새 상태 판정
// 규칙을 만들지 않는다.
//
// 알려진 한계(정직하게 문서화) — 이 계산은 event 사이의 "간격"에 상태를 매긴다. 단일
// Developer attempt 안에서(예: DEVELOPER_RETRY_STARTED ~ TEST_COMPLETED 사이) 발생한
// 사용량 제한 재시도 대기(claude-developer.ts의 내부 sleep)는 별도 event로 기록되지
// 않으므로, 그 구간 전체가 "작업 중"으로 계산된다(그 구간의 시작 상태가 RUNNING이기
// 때문). 반대로 프로세스가 완전히 중단된 기간, WAITING_HUMAN/BLOCKED로 확정된 이후의
// 대기 기간, 완료(COMPLETED)/IDLE/UNKNOWN 기간은 전부 정확히 제외된다 — 실제로 값을
// 왜곡시키는 지배적인 경우(오토데브가 꺼져 있거나 사람을 기다리는 동안 시간이 계속 늘어나는
// 문제)는 이 계산으로 완전히 해결된다.
//
// 재시작/브라우저 재접속에도 값이 동일한 이유 — 이 함수는 순수 함수이고 입력은 이미
// 디스크에 저장된 append-only event 기록뿐이다. 별도 누적 카운터를 만들어 저장하지 않는다
// (그 자체가 새로운 상태를 만들고 손상/누락 위험을 추가하기 때문) — 같은 event 기록을
// 다시 읽으면 항상 같은 값이 나온다.

const ACTIVE_STATUSES: ReadonlySet<LiveStatus> = new Set(["RUNNING", "TESTING", "REVIEWING", "REVISING", "CHECKPOINTING"]);

/**
 * events(이미 하나의 연속된 scope로 좁혀진, sequence 오름차순 목록 — 예: 한 run의 한 task)의
 * "실제 작업 시간"(ms)을 계산한다. 각 event 사이의 간격은, 그 간격이 시작되는 시점의 상태
 * (그 이전까지의 event들로 walkEvents가 판정한 상태)가 ACTIVE_STATUSES에 속할 때만
 * 합산한다. 마지막 event 이후 now까지의 꼬리 구간도 같은 규칙을 적용한다(현재 상태가
 * 활성 상태일 때만 카운트) — 그래서 오토데브가 멈춰 있거나 사람을 기다리는 동안에는 이
 * 값이 더 이상 증가하지 않는다.
 */
export interface ComputeActiveWorkMsOptions {
  /**
   * AutoDev / JARVIS Dashboard Stale-State Reconciliation(2026-08-28) — 이 값이 true면 마지막
   * event 이후의 tail 구간(§ 위 주석)을 절대 집계하지 않는다. finalStatus가 ACTIVE_STATUSES에
   * 속하더라도(예: 마지막 event가 REVIEW_STARTED라 event 기록만으로는 여전히 "검토 중") 실제
   * owner 프로세스가 죽었거나(§ dashboard-snapshot-provider.ts의 DashboardRuntimeTruth
   * state==="STALE") 아예 실행 중인 프로세스가 없으면(state==="STOPPED") 그 시점 이후로는
   * 실제 작업이 발생할 수 없다는 사실을 이미 알고 있기 때문이다 — event log만으로는 프로세스
   * 생존 여부를 알 수 없다는 이 파일 상단 주석의 한계를 호출부가 실제 liveness 판정으로 메운다.
   * event 사이의 이미 지나간 구간(과거 tail이 아닌 부분) 집계는 이 옵션과 무관하게 그대로다 —
   * "프로세스가 죽기 전까지 실제로 흐른 시간"은 여전히 정확하게 인정한다.
   */
  freezeTail?: boolean;
}

export function computeActiveWorkMs(events: AutoDevEvent[], now: number, options?: ComputeActiveWorkMsOptions): number {
  if (events.length === 0) return 0;
  let total = 0;
  for (let i = 1; i < events.length; i++) {
    const statusBeforeThisEvent = walkEvents(events.slice(0, i)).status;
    if (ACTIVE_STATUSES.has(statusBeforeThisEvent)) {
      const gapMs = Date.parse(events[i].timestamp) - Date.parse(events[i - 1].timestamp);
      total += Math.max(0, gapMs);
    }
  }
  const finalStatus = walkEvents(events).status;
  if (ACTIVE_STATUSES.has(finalStatus) && !options?.freezeTail) {
    const tailMs = now - Date.parse(events[events.length - 1].timestamp);
    total += Math.max(0, tailMs);
  }
  return total;
}

/** 한 run 안의 여러 task에 걸친 이력(§ 프로젝트 전체 실제 작업시간)을 taskId별로 나눠 각각
 *  계산한 뒤 합산한다 — task 경계를 넘어 상태를 섞지 않는다(다른 task의 REVIEW_BLOCKED가
 *  이 task의 작업 구간 판정에 영향을 주지 않는다). */
export function computeActiveWorkMsAcrossTasks(events: AutoDevEvent[], now: number, options?: ComputeActiveWorkMsOptions): number {
  const byTask = new Map<string, AutoDevEvent[]>();
  const noTaskId: AutoDevEvent[] = [];
  for (const e of events) {
    if (typeof e.taskId === "string") {
      const arr = byTask.get(e.taskId) ?? [];
      arr.push(e);
      byTask.set(e.taskId, arr);
    } else {
      noTaskId.push(e);
    }
  }
  let total = 0;
  for (const taskEvents of byTask.values()) {
    total += computeActiveWorkMs(taskEvents, now, options);
  }
  // taskId가 없는 event만으로 구성된 구간(예: task 선택 이전의 RUN_STARTED 등)도 동일한
  // 규칙으로 포함한다 — 다만 이런 event만으로는 대개 활성 상태로 전이되지 않는다(§
  // STATUS_TRANSITIONS는 TASK_STARTED부터 RUNNING으로 전이시킨다).
  total += computeActiveWorkMs(noTaskId, now, options);
  return total;
}
