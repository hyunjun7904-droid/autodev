import type { AutoDevEvent } from "./observability-event";

// AutoDev / JARVIS Unattended Continuous Development Reliability Hardening Phase 6 —
// 대시보드 "성공 사례"/"실패 사례" 집계.
//
// 이미 정확히 기록되고 있는 EventStore(§ event-store.ts, 실제 JARVIS 실행에서 REVIEW_BLOCKED/
// HUMAN_APPROVAL_REQUIRED/RUN_BLOCKED/CHECKPOINT_CREATED 등이 전부 정상적으로 logs/events.jsonl에
// 남아있음을 직접 확인했다)만으로 "작업 시도(attempt) 단위" 성공/실패를 집계한다 — 새 판정
// 로직이나 별도 기록 경로를 만들지 않는다. autodev.ts의 모든 종료 경로를 다시 읽어보면 정확히
// 두 event만 "이 runId의 최종 결과"를 대표한다:
//   - CHECKPOINT_CREATED — requiredTests 통과 + Reviewer 승인 + checkpoint(git commit) 확정
//     까지 실제로 끝났을 때만 emitEvent된다(§ autodev.ts). 이것이 "성공 사례"의 유일한 근거다
//     — Claude CLI exitCode=0이나 discovery round 종료, Reviewer 호출 성공 자체는 성공으로
//     세지 않는다(그런 이벤트들은 여기서 아예 보지 않는다).
//   - RUN_BLOCKED — orchestrator가 APPROVED로 끝나지 않음/checkpoint 실패(scope violation
//     포함)/audit-critical 저장소 사용 불가/remote git 변경, autodev.ts의 모든 실패 종료
//     경로가 공통으로 emitEvent하는 bookend event다. 이것이 "실패 사례"의 유일한 근거다.
// 두 event 모두 그 event를 만드는 코드 지점이 emitEvent 직후 곧바로 return/break하므로 같은
// runId 안에서 두 번 이상 발생하지 않는다(§ autodev.ts) — TIMEOUT 자동 재시도, REVISE 재시도,
// DEVELOPER_RETRY_STARTED 같은 중간 event는 전혀 세지 않으므로 "한 시도 = 하나의 최종 결과"
// 원칙이 이 두 event의 존재 자체로 이미 보장된다(중복 집계 방지를 위한 별도 로직 불필요).
// runId 하나가 정확히 하나의 task attempt(runAutodevOnce() 1회 호출)에 대응한다는 사실은
// continuous-runner.ts가 반복마다 runAutodevOnce({ manifest })를 opts.runId 없이 호출해
// 매번 새 runId를 받기 때문에 성립한다(§ autodev.ts AutodevRunOptions.runId 문서).

export interface AttemptOutcomeEntry {
  runId: string;
  taskId?: string;
  result: "SUCCESS" | "FAILURE";
  /** 이 attempt의 최종 event(CHECKPOINT_CREATED 또는 RUN_BLOCKED) timestamp. */
  occurredAt: string;
  /** FAILURE일 때만 채워진다 — RUN_BLOCKED event의 reason을 그대로 노출한다(원문 secret이
   *  섞여 들어올 수 있는 원시 stdout/stderr는 여기 담기지 않는다, § autodev.ts가 이미
   *  reason을 고정 템플릿/reviewer feedback 텍스트로만 채운다). */
  reason?: string;
  /** SUCCESS일 때만, 그리고 CHECKPOINT_CREATED event가 실제로 metadata.commitHash를
   *  string으로 담고 있을 때만 채워진다(§ autodev.ts가 checkpoint 확정 시 항상 이 값을
   *  기록함 — 새 필드를 만들지 않고 이미 기록된 값을 그대로 노출할 뿐이다). 없으면
   *  undefined(추측 금지) — Dashboard UX 정리(§ 요구사항 8 Git 표시)를 위해 추가됐다. */
  commitHash?: string;
}

export interface AttemptOutcomesSummary {
  successCount: number;
  failureCount: number;
  /** 최신순(가장 최근 attempt가 0번 인덱스). */
  recent: AttemptOutcomeEntry[];
}

const RECENT_LIMIT = 20;

export function buildAttemptOutcomes(allEvents: readonly AutoDevEvent[], projectId: string | undefined): AttemptOutcomesSummary {
  const scoped = projectId ? allEvents.filter((e) => e.projectId === projectId) : allEvents;
  const byRun = new Map<string, { checkpoint?: AutoDevEvent; blocked?: AutoDevEvent }>();
  for (const e of scoped) {
    if (e.eventType !== "CHECKPOINT_CREATED" && e.eventType !== "RUN_BLOCKED") continue;
    const entry = byRun.get(e.runId) ?? {};
    if (e.eventType === "CHECKPOINT_CREATED" && !entry.checkpoint) entry.checkpoint = e;
    if (e.eventType === "RUN_BLOCKED" && !entry.blocked) entry.blocked = e;
    byRun.set(e.runId, entry);
  }

  const entries: AttemptOutcomeEntry[] = [];
  for (const [runId, { checkpoint, blocked }] of byRun) {
    // CHECKPOINT_CREATED가 있으면 항상 성공으로 판정한다 — checkpoint가 실제로 확정된
    // runId에는 구조적으로 RUN_BLOCKED가 함께 존재할 수 없다(§ 위 주석, 상호 배타적인 두
    // 종료 경로).
    if (checkpoint) {
      const commitHash = typeof checkpoint.metadata?.commitHash === "string" ? checkpoint.metadata.commitHash : undefined;
      entries.push({ runId, taskId: checkpoint.taskId, result: "SUCCESS", occurredAt: checkpoint.timestamp, commitHash });
    } else if (blocked) {
      entries.push({ runId, taskId: blocked.taskId, result: "FAILURE", occurredAt: blocked.timestamp, reason: blocked.reason });
    }
  }

  entries.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));

  return {
    successCount: entries.filter((e) => e.result === "SUCCESS").length,
    failureCount: entries.filter((e) => e.result === "FAILURE").length,
    recent: entries.slice(0, RECENT_LIMIT),
  };
}
