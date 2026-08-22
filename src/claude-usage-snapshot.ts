// Phase G Task G3 — Claude 구독/Context 확장 seam.
//
// 향후 Claude Code가 제공할 수 있는 사용률 데이터(5시간/7일 사용률, reset 시각, 현재 context
// 사용량/잔여량)를 나중에 연결할 수 있도록 타입만 미리 준비한다. 이 파일이 다루는 데이터는
// EventStore/Audit 원본(observability-event.ts/event-store.ts)과 명확히 구분되는 runtime
// usage/observability 정보다 — AutoDevEvent가 아니고, query()의 결과에도 나타나지 않으며,
// metrics.ts의 Run/Task/Agent/Quality/Usage/Cost 집계와도 별도 경로다.
//
// 이 Task에서는 실제 값을 만들어내지 않는다:
//   - 값이 실제로 입력되지 않으면 snapshot 자체를 생성하지 않는다(§
//     describeClaudeUsageSnapshot).
//   - Pro/Max의 총 토큰 한도를 추정하거나 역산하지 않는다 — 이 타입 어디에도 "총 한도"
//     필드가 없다(contextRemainingTokens는 실제로 제공된 값만 담는다. 총 한도를 몰라도
//     남은 값만 그대로 전달할 수 있는 source가 있을 수 있으므로 총 한도 필드에서
//     역산하지 않는다).
//   - 이 파일을 실제 데이터 source에 연결하는 배선은 이번 Task 범위 밖이다(Dashboard/
//     Notification과 마찬가지로 범위 밖).

/** 모든 필드가 optional이다 — 실제로 아는 값만 채운다(추정 금지). */
export interface ClaudeUsageSnapshot {
  /** 5시간 rolling window 사용률(0~100 퍼센트) — 실제로 제공된 값만. */
  fiveHourUsagePercent?: number;
  /** 7일 rolling window 사용률(0~100 퍼센트) — 실제로 제공된 값만. */
  sevenDayUsagePercent?: number;
  /** 사용량이 초기화되는 시각(ISO 8601). */
  resetTime?: string;
  /** 현재 context window에서 실제 사용 중인 토큰 수. */
  currentContextTokens?: number;
  /** 현재 context window에서 남은 토큰 수 — 총 한도를 추정해 역산하지 않는다(source가
   *  실제로 제공한 값만). */
  contextRemainingTokens?: number;
  /** 이 snapshot이 실제로 캡처된 시각(ISO 8601). */
  capturedAt?: string;
}

/**
 * 입력을 그대로 통과시키는 순수 함수 — 어떤 필드도 추정/보완/기본값으로 채우지 않는다.
 * 입력이 없거나(undefined) 모든 필드가 undefined면(값이 실제로 하나도 없으면) undefined를
 * 반환한다 — "빈 snapshot"을 만들어내지 않는다(§ 요구사항: 값이 실제 입력되지 않으면
 * 생성하지 않는다).
 */
export function describeClaudeUsageSnapshot(input?: ClaudeUsageSnapshot): ClaudeUsageSnapshot | undefined {
  if (!input) return undefined;
  const hasAnyValue = Object.values(input).some((v) => v !== undefined);
  return hasAnyValue ? { ...input } : undefined;
}
