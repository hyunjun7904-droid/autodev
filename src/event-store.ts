import { accessSync, appendFileSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createEvent } from "./observability-event";
import type { AutoDevEvent, AutoDevEventInput, AutoDevEventType, AutoDevEventCategory } from "./observability-event";

// Append-only Event Store — Phase G Task G1/G2.
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
//
// Phase G Task G2 — Audit Integrity. 이전에는 file store가 손상된 JSONL 줄을 조용히
// 건너뛰었다(정상적인 기록인 것처럼 보이는 fail-open). 이제 query()는 항상
// { events, integrityIssues } 를 반환한다 — 손상이 있으면 events는 여전히 "파싱 가능했던
// 것까지의 최선의 결과"를 담지만, integrityIssues가 비어있지 않다는 사실 자체가 "이 결과가
// 완전한 기록이 아닐 수 있다"는 신호다(호출부가 이 신호를 무시할 수는 있어도, store가 그
// 사실을 숨기지는 않는다). integrityIssues에는 file/line/reason만 담고 손상된 원문은 절대
// 담지 않는다.

/** JSON 자체가 깨졌는지, JSON은 맞지만 event로서 필수 필드가 빠졌는지를 구분한다 — 두 경우
 *  모두 원문은 담지 않고 이 reason 라벨만 남긴다. */
export type AuditIntegrityIssueReason = "JSON_PARSE_ERROR" | "SCHEMA_INVALID";

export interface AuditIntegrityIssue {
  file: string;
  /** 1부터 시작하는 줄 번호. */
  line: number;
  reason: AuditIntegrityIssueReason;
}

export interface QueryResult {
  events: AutoDevEvent[];
  /** 비어있지 않으면 이 조회 결과가 불완전할 수 있다는 뜻이다 — query()가 fail-open으로
   *  이 사실을 숨기지 않는다(§ 요구사항: 이후 query가 완전한 기록인 것처럼 행동하지 않음). */
  integrityIssues: AuditIntegrityIssue[];
}

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

/** Phase G Task G2.1 — checkAuditWritable()의 반환 타입. AppendResult와 의도적으로 분리한다
 *  (checkAuditWritable은 event를 만들지 않으므로 event 필드가 없다). */
export interface AuditWritableCheck {
  ok: boolean;
  error?: string;
}

export interface EventStore {
  append(input: AutoDevEventInput): AppendResult;
  query(filter?: EventQueryFilter): QueryResult;
  /**
   * Phase G Task G2.1 — checkpoint(git commit)처럼 한 번 넘어가면 되돌리지 않는 경계
   * 직전에, audit-critical 저장소가 지금 실제로 쓰기 가능한지 부수효과 없이(실제 append
   * 없이) 미리 확인한다. append-only 보장을 이 점검이 깨지 않는다 — 이 메서드는 어떤
   * event도 만들거나 저장하지 않는다.
   * 이 메서드를 구현하지 않는 EventStore(예: in-memory store, 기존 테스트 fake)는 호출부가
   * `store.checkAuditWritable?.() ?? { ok: true }`로 처리한다 — 항상 사용 가능한 것으로
   * 간주되어 기존 동작이 전혀 바뀌지 않는다.
   */
  checkAuditWritable?(): AuditWritableCheck;
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
 * 여럿이어도 순서가 항상 명확하다(§ deterministic event ordering). 순수 in-process 객체라
 * JSON 파싱이 없으므로 integrityIssues는 항상 빈 배열이다.
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
      return { events: events.filter((e) => matchesFilter(e, filter)).map((e) => ({ ...e })), integrityIssues: [] };
    },
  };
}

/**
 * append-only JSONL 파일 기반 store — 한 줄에 event 하나(JSON.stringify)씩 appendFileSync로
 * 추가한다(logger.ts의 파일 append 패턴과 동일한 방식). 기존 파일이 있으면 마지막
 * sequence를 읽어 이어간다(재시작해도 sequence가 겹치지 않는다) — 단, 손상된 줄의 원래
 * sequence는 알 수 없으므로 "파싱에 성공한 줄들 중 최댓값"부터 이어간다(그 데이터 자체가
 * 이미 사라졌으므로 이 한계는 구조적으로 피할 수 없다).
 *
 * logger.ts의 log()와 달리, 이 store의 append()는 파일 기록 실패를 조용히 삼키지 않는다 —
 * 실패하면 ok:false를 정직하게 반환한다(호출부가 그 반환값을 어떻게 쓸지는 별개 문제다).
 */
export function createFileEventStore(filePath: string): EventStore {
  let sequence = readLastKnownSequence(filePath);

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
      const { events, integrityIssues } = readAllEventsWithIntegrity(filePath);
      return {
        events: events.filter((e) => matchesFilter(e, filter)).sort((a, b) => a.sequence - b.sequence),
        integrityIssues,
      };
    },
    checkAuditWritable() {
      try {
        // append()가 mkdirSync(dir, {recursive:true})로 만들 디렉터리를 실제로 만들지
        // 않고, 그 상위 중 실제로 존재하는 첫 조상까지만 거슬러 올라가 확인한다(부수효과
        // 없는 점검). 그 조상이 디렉터리가 아니라 파일이면(예: 상위 경로 일부가 실제로는
        // 일반 파일) mkdirSync 자체가 구조적으로 불가능하므로 명시적으로 실패시킨다 —
        // accessSync만으로는 "파일이지만 쓰기 권한은 있음"을 걸러낼 수 없기 때문이다.
        let probe = dirname(filePath);
        while (!existsSync(probe)) {
          const parent = dirname(probe);
          if (parent === probe) break; // 파일시스템 root까지 올라왔다.
          probe = parent;
        }
        if (!statSync(probe).isDirectory()) {
          throw new Error(`${probe}는 디렉터리가 아니라서 audit-critical 저장소 경로를 만들 수 없습니다.`);
        }
        accessSync(probe, fsConstants.W_OK);
        if (existsSync(filePath)) accessSync(filePath, fsConstants.W_OK);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/** JSON.parse는 성공했지만 AutoDevEvent로서 필수 필드가 빠졌거나 타입이 틀린 경우까지
 *  잡아낸다 — "JSON은 맞으니 정상 event로 취급"하지 않는다(§ 정상으로 가장 금지). */
function isValidStoredEvent(value: unknown): value is AutoDevEvent {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.eventId === "string" &&
    typeof v.timestamp === "string" &&
    typeof v.sequence === "number" &&
    typeof v.runId === "string" &&
    typeof v.eventType === "string" &&
    Array.isArray(v.categories)
  );
}

function readAllEventsWithIntegrity(filePath: string): { events: AutoDevEvent[]; integrityIssues: AuditIntegrityIssue[] } {
  if (!existsSync(filePath)) return { events: [], integrityIssues: [] };
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const events: AutoDevEvent[] = [];
  const integrityIssues: AuditIntegrityIssue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue; // 순수 빈 줄(마지막 개행 등)은 손상이 아니다.
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      integrityIssues.push({ file: filePath, line: i + 1, reason: "JSON_PARSE_ERROR" });
      continue;
    }
    if (!isValidStoredEvent(parsed)) {
      integrityIssues.push({ file: filePath, line: i + 1, reason: "SCHEMA_INVALID" });
      continue;
    }
    events.push(parsed);
  }
  return { events, integrityIssues };
}

function readLastKnownSequence(filePath: string): number {
  let max = 0;
  for (const e of readAllEventsWithIntegrity(filePath).events) {
    if (e.sequence > max) max = e.sequence;
  }
  return max;
}

// Phase G Task G2.1 — Audit Integrity 소비자용 단일 판정 helper. query()가 이미
// integrityIssues를 숨기지 않지만, 소비자마다 "integrityIssues.length > 0"을 직접 재구현하면
// 기준이 갈릴 위험이 있다(예: 누군가는 실수로 이 검사를 빠뜨리고 events만 보고 "정상 기록"
// 으로 취급할 수 있다). 이 두 helper가 그 단일 출처다 — Dashboard/Notification(범위 밖)을
// 만들지 않고, 순수 판정/설명 문자열만 제공한다.

export type AuditIntegrityStatus = "CLEAN" | "DEGRADED";

/** integrityIssues가 하나라도 있으면 DEGRADED — 이 조회 결과를 "완전한 정상 기록"으로 취급할
 *  수 없다는 뜻이다(§ 요구사항: query 결과가 완전한 기록인 것처럼 행동하지 않음). */
export function getAuditIntegrityStatus(result: Pick<QueryResult, "integrityIssues">): AuditIntegrityStatus {
  return result.integrityIssues.length > 0 ? "DEGRADED" : "CLEAN";
}

/** DEGRADED일 때 사람이 읽을 수 있는 한 줄 요약을 만든다 — reason 필드(예:
 *  deferredHumanTasks)에 그대로 넣을 수 있는 형태다. integrityIssues가 이미 file/line/
 *  reason만 담고 있으므로(§ event-store.ts 상단 주석), 이 함수도 손상된 원문을 어디에서도
 *  다시 읽거나 포함하지 않는다. */
export function describeAuditIntegrity(result: Pick<QueryResult, "integrityIssues">): string {
  if (result.integrityIssues.length === 0) return "CLEAN — 손상된 audit 기록이 없습니다.";
  const counts = { JSON_PARSE_ERROR: 0, SCHEMA_INVALID: 0 };
  for (const issue of result.integrityIssues) counts[issue.reason] += 1;
  return (
    `DEGRADED — 손상된 audit 기록 ${result.integrityIssues.length}건 ` +
    `(JSON_PARSE_ERROR=${counts.JSON_PARSE_ERROR}, SCHEMA_INVALID=${counts.SCHEMA_INVALID}). ` +
    `이 조회 결과는 완전한 기록이 아닐 수 있습니다.`
  );
}

// Phase G Task G2 — Production EventStore 연결. AUTOMATION_DRY_RUN이 명시적으로 "false"일
// 때만(orchestrator.ts/agent-orchestrator.ts와 동일한 관례) 실제 파일 기반 store를 쓴다 —
// 값이 없거나 그 외 무엇이든 안전한 쪽(in-memory, 파일 I/O 없음)으로 fallback한다. 이
// 함수를 쓰면 opts.events를 지정하지 않아도(production 기본 호출부인 run.ts가 그렇다)
// production에서는 관측이 자동으로 켜지고, test/dry-run에서는 자동으로 in-memory라
// 어떤 test도 실제 runtime 파일을 건드리지 않는다("production과 test storage를 명확히
// 분리"). 이 파일은 AutoDev 자신의 runtime data이지 target project(MOVAN 등) repo 안이
// 아니다 — logger.ts의 LOG_DIR과 동일한 위치 계산(__dirname 기준)을 쓴다. 이 경로는 이미
// .gitignore의 logs/ 패턴에 포함돼 git commit 대상이 되지 않는다.
const RUNTIME_EVENT_LOG_PATH = join(__dirname, "..", "logs", "events.jsonl");

// filePath는 테스트 전용 override다(실제 운용 호출부인 autodev.ts는 인자 없이 부른다 —
// 기본값이 실제 runtime 경로다). 이 override 자체가 있다고 해서 "false가 아닐 때 실제
// 파일을 쓴다"는 판단 로직이 약해지는 건 아니다 — AUTOMATION_DRY_RUN 검사는 그대로다.
export function selectDefaultEventStore(filePath: string = RUNTIME_EVENT_LOG_PATH): EventStore {
  return process.env.AUTOMATION_DRY_RUN === "false" ? createFileEventStore(filePath) : createInMemoryEventStore();
}
