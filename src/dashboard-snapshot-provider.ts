import { existsSync, statSync } from "node:fs";
import { createFileEventStore, RUNTIME_EVENT_LOG_PATH } from "./event-store";
import type { QueryResult } from "./event-store";
import { buildAutoDevLiveSnapshot } from "./live-snapshot";
import type { AutoDevLiveSnapshot } from "./live-snapshot";

// Local Operations Dashboard — Read Service / Cache Seam (Phase G Task G4.1).
//
// 이 파일은 G4의 AutoDevLiveSnapshot(live-snapshot.ts)을 "누가 지금 보고 있는 run인가"만
// 결정해 그대로 통과시키는 순수 읽기 전용 소비자다 — 어떤 production 판정도 새로 만들지
// 않는다(EventStore 재해석 금지, § live-snapshot.ts 상단 주석과 동일 원칙). 이 파일이 하는
// 일은 단 두 가지다:
//   1) event 파일(JSONL)을 매 요청마다 무한 재파싱하지 않도록 mtime/size 기반으로 캐시한다
//      (§ 요구사항: "Event 파일 전체를 매 refresh마다 비효율적으로 재처리하는 구조는 피한다").
//   2) 이 store 전체에서 "가장 최근 run"이 무엇인지 결정한다 — AutoDev는 한 번에 하나의
//      run만 실행하고(autodev.ts), EventStore의 sequence는 파일 전체에서 단조증가하므로
//      (§ event-store.ts), 정렬된 이벤트 목록의 마지막 event가 가리키는 runId가 항상 가장
//      최근 run이다. 새로운 "현재 run" 판정 규칙을 만들지 않고 이 사실만 그대로 쓴다.
//
// write/execute 경로는 이 파일 어디에도 없다 — export하는 함수는 전부 조회만 한다.

interface CacheEntry {
  filePath: string;
  mtimeMs: number;
  size: number;
  result: QueryResult;
}

let cache: CacheEntry | undefined;

/** filePath가 이전 캐시와 같고 mtime/size가 그대로면 재파싱하지 않고 캐시를 그대로 쓴다 —
 *  파일이 바뀌었으면(요구사항: append-only이므로 크기는 항상 증가하거나 그대로다)
 *  createFileEventStore(filePath).query()로 다시 읽는다. */
function readQueryResult(filePath: string): QueryResult {
  if (!existsSync(filePath)) {
    if (cache?.filePath === filePath) cache = undefined;
    return { events: [], integrityIssues: [] };
  }
  const stat = statSync(filePath);
  if (cache && cache.filePath === filePath && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.result;
  }
  const result = createFileEventStore(filePath).query();
  cache = { filePath, mtimeMs: stat.mtimeMs, size: stat.size, result };
  return result;
}

/** 테스트 전용 — 모듈 전역 캐시를 초기화해 테스트 간 상태가 새지 않게 한다. 운용
 *  호출부(dashboard-server.ts)는 이 함수를 쓰지 않는다. */
export function resetDashboardSnapshotCacheForTests(): void {
  cache = undefined;
}

function latestRunId(result: QueryResult): string | undefined {
  return result.events.length > 0 ? result.events[result.events.length - 1].runId : undefined;
}

export type DashboardSnapshotStatus = "OK" | "NO_RUN_YET";

export interface DashboardSnapshot {
  status: DashboardSnapshotStatus;
  generatedAt: string;
  /** status가 "OK"일 때만 채워진다 — G4의 데이터 계약을 그대로 통과시킨다. */
  snapshot?: AutoDevLiveSnapshot;
}

/**
 * 지금 보여줄 Live Snapshot을 만든다. events.jsonl에 event가 하나도 없으면(아직 production
 * run이 한 번도 없었음) "NO_RUN_YET"을 반환한다 — UNKNOWN이나 임의 기본값으로 채우지
 * 않는다.
 */
export function getDashboardSnapshot(filePath: string = RUNTIME_EVENT_LOG_PATH): DashboardSnapshot {
  const result = readQueryResult(filePath);
  const runId = latestRunId(result);
  const now = Date.now();
  if (!runId) {
    return { status: "NO_RUN_YET", generatedAt: new Date(now).toISOString() };
  }
  const lastEvent = result.events[result.events.length - 1];
  const snapshot = buildAutoDevLiveSnapshot(result, { runId, projectId: lastEvent.projectId, now });
  return { status: "OK", generatedAt: snapshot.generatedAt, snapshot };
}
