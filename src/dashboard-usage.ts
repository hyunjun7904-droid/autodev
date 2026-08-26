import type { AutoDevEvent, AutoDevEventType } from "./observability-event";

// 오토데브 대시보드 후속 개선 — 사용량/서비스별 호출량/최근 호출 기록(§ 요구사항 5/6).
//
// 이 파일은 EventStore(이미 기록된 AutoDevEvent)의 순수 소비자다 — 새 판정을 만들지
// 않는다. Developer 호출은 TEST_COMPLETED event(claude-developer.ts가 이 cycle에서
// 관측한 model/tokenUsage를 이미 붙여 기록한다, § observability-event.ts), Reviewer 호출은
// REVIEW_APPROVED/REVIEW_REVISE/REVIEW_BLOCKED event(gpt-reviewer.ts의 model/tokenUsage)로
// 이미 존재한다 — 이 두 event 종류만 model/tokenUsage를 담으므로 그 사실 그대로 재사용한다.
// 실제로 관측된 provider/model만 나열한다(§ 요구사항: 호출되지 않은 서비스를 사용한 것처럼
// 표시하지 않는다) — 표시할 provider 목록을 미리 하드코딩하지 않는다.

const DEVELOPER_CALL_EVENT_TYPES: ReadonlySet<AutoDevEventType> = new Set(["TEST_COMPLETED"]);
const REVIEW_CALL_EVENT_TYPES: ReadonlySet<AutoDevEventType> = new Set(["REVIEW_APPROVED", "REVIEW_REVISE", "REVIEW_BLOCKED"]);

/**
 * TEST_COMPLETED는 claude-developer.ts의 required-test 실행 직후에만 기록되는 event다 —
 * 이 저장소 전체에서 "Developer 역할"은 항상 Claude Code CLI 하나뿐이고(다른 provider가
 * Developer로 쓰인 적이 없다, § claude-runner.ts resolveTrustedClaudeCommand), Reviewer
 * 역할만 여러 provider(Fireworks/Groq/OpenAI)를 오갈 수 있다(§ final-reviewer-routing.ts).
 * 실제 운영 기록을 확인해보니 claude CLI가 model 필드를 항상 보고하지는 않아(§ 이 파일
 * 작성 중 실제 events.jsonl에서 직접 확인) event.model이 비어있는 TEST_COMPLETED가 많다 —
 * 그렇다고 "Claude가 호출된 사실 자체"까지 숨기면(model이 없다고 그냥 건너뛰면) 실제로는
 * 계속 호출되고 있는 Claude가 서비스별 표에서 완전히 사라져 요구사항의 취지("실제로 사용한
 * 서비스를 보여준다")에 반한다. 이 provider 값("anthropic")은 token 수치처럼 관측된 값을
 * 추측하는 것이 아니라, "이 event 종류가 구조적으로 어떤 역할을 나타내는가"라는 이
 * 저장소의 고정된 아키텍처 사실을 반영한 것이다 — 모델 이름(name)은 실제로 보고된 값이
 * 없으면 여전히 undefined로 남긴다(그 부분까지 추측하지 않는다).
 */
const DEVELOPER_ROLE_PROVIDER = "anthropic";

function resolveModelRef(e: AutoDevEvent): { provider: string; name?: string } | undefined {
  if (e.model) return e.model;
  if (DEVELOPER_CALL_EVENT_TYPES.has(e.eventType) && e.tokenUsage) return { provider: DEVELOPER_ROLE_PROVIDER };
  return undefined;
}

// provider 식별자(anthropic/openai/fireworks/groq 등, model.provider에 실제로 기록된 값) →
// 사람이 읽는 표시 이름. 알려지지 않은 provider는 원문 그대로 보여준다(추측해서 새 이름을
// 만들지 않는다).
const PROVIDER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  anthropic: "Claude",
  openai: "OpenAI",
  fireworks: "Fireworks",
  groq: "Groq",
};

export function providerDisplayName(provider: string): string {
  return PROVIDER_DISPLAY_NAMES[provider] ?? provider;
}

export interface ProviderModelUsage {
  service: string;
  provider: string;
  model?: string;
  callCount: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** events(scope는 호출부가 이미 좁힌다 — 전체 누적이면 필터 없이, 현재 작업이면 taskId로
 *  미리 필터링해서 넘긴다)에서 실제로 관측된 provider/model 조합만 집계한다. */
export function aggregateProviderModelUsage(events: readonly AutoDevEvent[]): ProviderModelUsage[] {
  const map = new Map<string, ProviderModelUsage>();
  for (const e of events) {
    if (!DEVELOPER_CALL_EVENT_TYPES.has(e.eventType) && !REVIEW_CALL_EVENT_TYPES.has(e.eventType)) continue;
    const model = resolveModelRef(e);
    if (!model) continue;
    const key = `${model.provider}::${model.name ?? "(unknown)"}`;
    let entry = map.get(key);
    if (!entry) {
      entry = { service: providerDisplayName(model.provider), provider: model.provider, model: model.name, callCount: 0 };
      map.set(key, entry);
    }
    entry.callCount += 1;
    if (e.tokenUsage?.inputTokens !== undefined) entry.inputTokens = (entry.inputTokens ?? 0) + e.tokenUsage.inputTokens;
    if (e.tokenUsage?.outputTokens !== undefined) entry.outputTokens = (entry.outputTokens ?? 0) + e.tokenUsage.outputTokens;
    if (e.tokenUsage?.totalTokens !== undefined) entry.totalTokens = (entry.totalTokens ?? 0) + e.tokenUsage.totalTokens;
  }
  return Array.from(map.values());
}

export interface UsageTotals {
  callCount: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** aggregateProviderModelUsage() 결과를 하나의 총합으로 접는다(전체 누적/현재 작업 카드에
 *  쓰는 단일 숫자). */
export function sumProviderModelUsage(usages: readonly ProviderModelUsage[]): UsageTotals {
  const totals: UsageTotals = { callCount: 0 };
  for (const u of usages) {
    totals.callCount += u.callCount;
    if (u.inputTokens !== undefined) totals.inputTokens = (totals.inputTokens ?? 0) + u.inputTokens;
    if (u.outputTokens !== undefined) totals.outputTokens = (totals.outputTokens ?? 0) + u.outputTokens;
    if (u.totalTokens !== undefined) totals.totalTokens = (totals.totalTokens ?? 0) + u.totalTokens;
  }
  return totals;
}

export type CallPurpose = "개발" | "수정" | "검토" | "재검토";

export interface RecentCallEntry {
  timestamp: string;
  projectId?: string;
  taskId?: string;
  purpose: CallPurpose;
  service: string;
  provider: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  success: boolean;
}

function purposeFor(eventType: AutoDevEventType, reviseCycle: number | undefined): CallPurpose {
  const isRetry = typeof reviseCycle === "number" && reviseCycle > 1;
  if (DEVELOPER_CALL_EVENT_TYPES.has(eventType)) return isRetry ? "수정" : "개발";
  return isRetry ? "재검토" : "검토";
}

/** 최근 호출 기록(§ 요구사항 6) — 시각 내림차순으로 최대 limit개. 비밀값/요청 전문은
 *  AutoDevEvent 자체에 그런 필드가 없으므로(§ observability-event.ts) 이 함수가 따로
 *  가릴 것도 없다 — model/tokenUsage/timestamp/projectId/taskId/outcome 같은 운영
 *  metadata만 옮긴다. */
export function buildRecentCalls(events: readonly AutoDevEvent[], limit: number): RecentCallEntry[] {
  const calls: RecentCallEntry[] = [];
  for (const e of events) {
    if (!DEVELOPER_CALL_EVENT_TYPES.has(e.eventType) && !REVIEW_CALL_EVENT_TYPES.has(e.eventType)) continue;
    const model = resolveModelRef(e);
    if (!model) continue;
    calls.push({
      timestamp: e.timestamp,
      projectId: e.projectId,
      taskId: e.taskId,
      purpose: purposeFor(e.eventType, e.reviseCycle),
      service: providerDisplayName(model.provider),
      provider: model.provider,
      model: model.name,
      inputTokens: e.tokenUsage?.inputTokens,
      outputTokens: e.tokenUsage?.outputTokens,
      totalTokens: e.tokenUsage?.totalTokens,
      success: e.outcome === "SUCCESS",
    });
  }
  calls.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  return calls.slice(0, limit);
}
