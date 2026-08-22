import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createEvent } from "./observability-event";
import type { AutoDevEvent, AutoDevEventInput, AutoDevEventType, AutoDevEventCategory } from "./observability-event";

// Append-only Event Store — Phase G Task G1.
//
// 이 파일이 노출하는 API는 append(추가)와 query(조회) 두 가지뿐이다 — update/delete 함수가
// 이 파일 어디에도 없다(구조적으로 "과거 event를 수정/삭제하는 경로 자체가 없음"을
// 보장한다). append()는 어떤 policy/config 인자도 받지 않는다 — Project config가 Core
// audit 기록을 비활성화하거나 완화할 방법이 없다(safe-executor.ts/secret-scanner.ts와
// 동일한 "함수 시그니처에 그런 파라미터가 없다"는 Core hard rule 패턴).
//
// query()가 반환하는 event는 항상 얕은 복사본이다 — 호출부가 반환된 객체를 수정해도 저장된
// 원본 history는 바뀌지 않는다("Agent가 audit 결과를 임의 수정하지 못한다"는 요구사항을
// 저장소 경계에서 구조적으로 막는다).

export interface EventQueryFilter {
  runId?: string;
  taskId?: string;
  agentId?: string;
  eventType?: AutoDevEventType;
  category?: AutoDevEventCategory;
}

export interface AppendResult {
  ok: boolean;
  event?: AutoDevEvent;
  /** append가 실패했을 때만 채워진다 — 실패를 조용히 성공으로 위장하지 않는다(§ 요구사항). */
  error?: string;
}

export interface EventStore {
  append(input: AutoDevEventInput): AppendResult;
  query(filter?: EventQueryFilter): AutoDevEvent[];
}

function matchesFilter(event: AutoDevEvent, filter: EventQueryFilter): boolean {
  if (filter.runId !== undefined && event.runId !== filter.runId) return false;
  if (filter.taskId !== undefined && event.taskId !== filter.taskId) return false;
  if (filter.agentId !== undefined && event.agentId !== filter.agentId) return false;
  if (filter.eventType !== undefined && event.eventType !== filter.eventType) return false;
  if (filter.category !== undefined && !event.categories.includes(filter.category)) return false;
  return true;
}

/**
 * 메모리 기반 store — 프로세스 생존 동안만 유지된다(테스트/deterministic fixture 용도).
 * sequence는 이 store 인스턴스 안에서 1부터 단조증가한다 — 같은 timestamp를 가진 event가
 * 여럿이어도 순서가 항상 명확하다(§ deterministic event ordering).
 */
export function createInMemoryEventStore(): EventStore {
  const events: AutoDevEvent[] = [];
  let sequence = 0;

  return {
    append(input) {
      sequence += 1;
      const draft = createEvent(input);
      const event: AutoDevEvent = { ...draft, sequence };
      events.push(event);
      return { ok: true, event };
    },
    query(filter = {}) {
      return events.filter((e) => matchesFilter(e, filter)).map((e) => ({ ...e }));
    },
  };
}

/**
 * append-only JSONL 파일 기반 store — 한 줄에 event 하나(JSON.stringify)씩 appendFileSync로
 * 추가한다(logger.ts의 파일 append 패턴과 동일한 방식). 기존 파일이 있으면 마지막
 * sequence를 읽어 이어간다(재시작해도 sequence가 겹치지 않는다). 손상된 줄은 조회 시
 * 건너뛴다 — 한 줄이 깨졌다고 나머지 history 전체를 읽지 못하게 만들지 않는다.
 *
 * logger.ts의 log()와 달리, 이 store의 append()는 파일 기록 실패를 조용히 삼키지 않는다 —
 * 실패하면 ok:false를 정직하게 반환한다(호출부가 그 반환값을 어떻게 쓸지는 별개 문제다).
 */
export function createFileEventStore(filePath: string): EventStore {
  let sequence = readLastSequence(filePath);

  return {
    append(input) {
      sequence += 1;
      const draft = createEvent(input);
      const event: AutoDevEvent = { ...draft, sequence };
      try {
        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf-8");
        return { ok: true, event };
      } catch (err) {
        return { ok: false, event, error: err instanceof Error ? err.message : String(err) };
      }
    },
    query(filter = {}) {
      return readAllEvents(filePath)
        .filter((e) => matchesFilter(e, filter))
        .sort((a, b) => a.sequence - b.sequence)
        .map((e) => ({ ...e }));
    },
  };
}

function readAllEvents(filePath: string): AutoDevEvent[] {
  if (!existsSync(filePath)) return [];
  const lines = readFileSync(filePath, "utf-8").split("\n").filter((l) => l.trim().length > 0);
  const events: AutoDevEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as AutoDevEvent);
    } catch {
      // 손상된 줄은 건너뛴다 — 나머지 history는 계속 읽을 수 있어야 한다.
    }
  }
  return events;
}

function readLastSequence(filePath: string): number {
  let max = 0;
  for (const e of readAllEvents(filePath)) {
    if (typeof e.sequence === "number" && e.sequence > max) max = e.sequence;
  }
  return max;
}
