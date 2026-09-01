import type { AutoDevEvent, AutoDevEventType } from "./observability-event";

// AutoDev Dashboard 멀티프로젝트 운영센터 개선 — Developer 실행 생애주기(§ 요구사항 5).
//
// 새 관측 event를 만들지 않는다 — 이미 기록된 event만으로 "몇 번째 시도인지", "언제
// 시작했고 언제 끝났는지", "정상/비정상 종료인지", "종료 사유가 무엇인지"를 재구성한다.
//
//   - 시도(attempt) 시작 — TASK_STARTED(이 task의 첫 Developer 호출)와
//     DEVELOPER_RETRY_STARTED(REVISE 이후 재시도, orchestrator.ts가 review cycle마다
//     emitEvent한다)만이 "Developer가 새로 호출됐다"는 사실의 단일 출처다(§ live-snapshot.ts
//     developerCallCount와 동일한 event 조합 — 새 카운팅 규칙을 만들지 않는다).
//   - 시도 종료(정상) — TEST_COMPLETED(required test까지 실제로 실행됨, 이 시점부터는
//     Reviewer 단계로 넘어간다) 또는 CHECKPOINT_CREATED가 이 attempt를 대표하는 마지막
//     event다.
//   - 시도 종료(비정상) — HUMAN_APPROVAL_REQUIRED(3회 transient retry 소진 등, §
//     claude-developer.ts) 또는 RUN_BLOCKED가 나오면 이 attempt는 TEST_COMPLETED에 도달하지
//     못하고 끝난 것이다. error.code(TIMEOUT/CLI_NOT_FOUND/USAGE_LIMIT 등, § failure-taxonomy.ts)가
//     있으면 그대로 노출하고, 없으면 exitReason은 undefined로 남긴다(근거 없는 사유를 만들지
//     않는다) — 대신 사람이 읽는 reason 텍스트(이미 redact된 값)가 있으면 exitDetail로만
//     보조 설명한다.
//   - 아직 종료 event가 관측되지 않았으면(이 attempt가 이 scope의 마지막 event) outcome은
//     "RUNNING"이다 — "종료 = 아직 없음"을 그대로 표현한다.

const ATTEMPT_START_TYPES: ReadonlySet<AutoDevEventType> = new Set(["TASK_STARTED", "DEVELOPER_RETRY_STARTED"]);
const ATTEMPT_END_TYPES: ReadonlySet<AutoDevEventType> = new Set(["TEST_COMPLETED", "CHECKPOINT_CREATED", "HUMAN_APPROVAL_REQUIRED", "RUN_BLOCKED"]);
const ABNORMAL_END_TYPES: ReadonlySet<AutoDevEventType> = new Set(["HUMAN_APPROVAL_REQUIRED", "RUN_BLOCKED"]);

export type DeveloperAttemptOutcome = "RUNNING" | "NORMAL_END" | "ABNORMAL_END";

export interface DeveloperAttempt {
  attemptNumber: number;
  taskId?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  outcome: DeveloperAttemptOutcome;
  /** § failure-taxonomy.ts의 error.code(예: TIMEOUT/CLI_NOT_FOUND/USAGE_LIMIT) — 실제로
   *  관측된 값이 없으면 undefined(추측 금지). */
  exitReason?: string;
  /** 사람이 읽는 보조 설명(RUN_BLOCKED/HUMAN_APPROVAL_REQUIRED의 reason 텍스트, 이미
   *  redact됨) — exitReason(코드)이 없을 때도 이 값은 있을 수 있다. */
  exitDetail?: string;
}

export interface DeveloperLifecycle {
  /** 시간순(오래된 것부터). */
  attempts: DeveloperAttempt[];
  /** attempts의 마지막 항목 — 편의 필드(중복 로직 없음, attempts.length===0이면 undefined). */
  latest?: DeveloperAttempt;
}

function sortChronological(events: readonly AutoDevEvent[]): AutoDevEvent[] {
  return events.slice().sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.sequence - b.sequence);
}

/**
 * events는 QueryResult.events(전체 store)를 그대로 넘겨도 된다 — projectId/taskId가
 * 지정되면 내부에서 좁힌다. taskId를 지정하지 않으면 "이 project의 모든 task를 통틀어
 * Developer가 호출된 순서"가 되므로(§ TASK_STARTED가 task마다 반복) attemptNumber가 여러
 * task에 걸쳐 계속 누적된다 — 특정 task 하나의 시도 횟수를 보려면 반드시 taskId를 지정해야
 * 한다(호출부 책임, 이 파일은 그 의미를 재해석하지 않는다).
 */
export function buildDeveloperLifecycle(
  events: readonly AutoDevEvent[],
  projectId: string | undefined,
  taskId: string | undefined
): DeveloperLifecycle {
  let scoped: AutoDevEvent[] = projectId ? events.filter((e) => e.projectId === projectId) : events.slice();
  if (taskId) scoped = scoped.filter((e) => e.taskId === taskId);
  scoped = sortChronological(scoped);

  const attempts: DeveloperAttempt[] = [];
  let current: DeveloperAttempt | undefined;
  let attemptNumber = 0;

  for (const e of scoped) {
    if (ATTEMPT_START_TYPES.has(e.eventType)) {
      attemptNumber += 1;
      current = { attemptNumber, taskId: e.taskId, startedAt: e.timestamp, outcome: "RUNNING" };
      attempts.push(current);
      continue;
    }
    if (current && current.outcome === "RUNNING" && ATTEMPT_END_TYPES.has(e.eventType)) {
      current.endedAt = e.timestamp;
      current.durationMs = Date.parse(e.timestamp) - Date.parse(current.startedAt);
      if (ABNORMAL_END_TYPES.has(e.eventType)) {
        current.outcome = "ABNORMAL_END";
        current.exitReason = e.error?.code;
        current.exitDetail = e.reason;
      } else {
        current.outcome = "NORMAL_END";
      }
    }
  }

  return { attempts, latest: attempts.length > 0 ? attempts[attempts.length - 1] : undefined };
}
