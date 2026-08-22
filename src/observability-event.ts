import { randomUUID } from "node:crypto";
import { sanitizeForLog } from "./logger";
import { SECRET_CONTENT_PATTERNS } from "./secret-scanner";
import type { AgentRole } from "./agent-registry";
import type { GptDecision, SeverityCounts } from "./types";

// Observability & Audit Event Foundation — Phase G Task G1/G2.
//
// 두 목적을 구분한다:
//   - Observability: 성능/상태/비용/실행 흐름을 보기 위한 데이터.
//   - Audit: 누가/무엇이/언제/왜 어떤 행동을 했는지 남기는 보안 기록.
// 둘 다 이 파일의 공통 event envelope(AutoDevEvent)을 쓴다 — event type마다
// classifyEventCategory()가 두 카테고리 중 어디에 속하는지(또는 둘 다인지) deterministic
// 하게 정해준다. 이 파일은 순수 데이터 모델 + sanitization만 다룬다 — 실제 저장은
// event-store.ts, production 배선은 autodev.ts/orchestrator.ts가 각자 담당한다(관심사 분리).
//
// Phase G Task G2 — isAuditCriticalEvent()는 classifyEventCategory()와 다른 질문에
// 답한다: classifyEventCategory는 "이 event를 어떤 목적의 조회에 포함시킬지"(query 필터용)
// 이고, isAuditCriticalEvent는 "이 event 기록이 실패했을 때 조용히 넘어가면 안 되는지"
// (실패 처리 정책용)다. 두 테이블은 의도적으로 서로 다른 기준이라 겹치지 않을 수 있다.
//
// 이 파일은 Dashboard/UI/Notification을 만들지 않는다(범위 밖) — 오직 "무엇을 어떻게
// 구조화해서 남길지"만 정의한다.

/** 이 Task가 다루는 최소 event 종류 — 이름은 이 저장소의 실제 상태 어휘(orchestrator.ts의
 *  OrchestratorStatus, review-policy.ts의 REVIEW_CYCLE_EXHAUSTED, checkpoint.ts의 Secret/
 *  Dependency Gate)에 맞춰 정리했다. 새 event type이 필요해지면 이 union과 아래
 *  EVENT_CATEGORIES/AUDIT_CRITICAL_EVENT_TYPES 테이블에 함께 추가한다(단일 출처).
 *  DEVELOPER_RETRY_STARTED(G2)는 orchestrator.ts의 REVISE loop가 developer를 다시 부르는
 *  cycle(reviewCycle>1)에서만 쓰인다 — 최초 시도는 이 event를 쓰지 않는다(그건 이미
 *  TASK_STARTED로 경계가 표시된다). */
export type AutoDevEventType =
  | "RUN_STARTED"
  | "RUN_COMPLETED"
  | "RUN_BLOCKED"
  | "TASK_STARTED"
  | "TASK_COMPLETED"
  | "AGENT_SELECTED"
  | "AGENT_STARTED"
  | "AGENT_COMPLETED"
  | "AGENT_FAILED"
  | "DEVELOPER_RETRY_STARTED"
  | "TEST_STARTED"
  | "TEST_COMPLETED"
  | "REVIEW_STARTED"
  | "REVIEW_APPROVED"
  | "REVIEW_REVISE"
  | "REVIEW_BLOCKED"
  | "SECURITY_BLOCKED"
  | "CHECKPOINT_CREATED"
  | "HUMAN_APPROVAL_REQUIRED"
  | "REVIEW_CYCLE_EXHAUSTED"
  // Phase G Task G5 — Notification Service & Delivery Foundation. 이 세 event는
  // notification-service.ts가 "알림을 만들었다/전달했다/전달 실패했다"는 사실만 남긴다 —
  // Notification Store(notification-store.ts, delivery bookkeeping)를 대체하지 않는다.
  // audit-critical로 분류하지 않는다(§ AUDIT_CRITICAL_EVENT_TYPES) — 알림 bookkeeping 기록
  // 실패가 checkpoint/run 진행을 막아서는 안 된다는 원칙과 동일선상이다.
  | "NOTIFICATION_CREATED"
  | "NOTIFICATION_DELIVERED"
  | "NOTIFICATION_FAILED"
  // Phase G Task G6 — Telegram Mobile Approval, Safe Resume & Local Controller.
  // APPROVAL_REQUESTED/RECEIVED는 진행 상황(observability)만 남긴다 — 실제 사람의 결정
  // 자체(무엇을 승인/거절/보류했는가)는 아래 5개 결정 event가 담당한다. APPROVAL_UNAUTHORIZED/
  // APPROVAL_STALE도 "이 요청은 소비되지 않았다"는 보안상 중요한 사실이라 결정 event와 함께
  // audit-critical로 분류한다(§ AUDIT_CRITICAL_EVENT_TYPES).
  | "APPROVAL_REQUESTED"
  | "APPROVAL_RECEIVED"
  | "APPROVAL_APPROVED"
  | "APPROVAL_REJECTED"
  | "APPROVAL_DEFERRED"
  | "APPROVAL_EXPIRED"
  | "APPROVAL_UNAUTHORIZED"
  | "APPROVAL_STALE"
  | "AUTO_RESUME_STARTED"
  | "AUTO_RESUME_BLOCKED"
  | "AUTO_RESUME_COMPLETED"
  // Phase G Task G7 — Project Lock & Concurrent Writer Safety. 이 6개는 project-lock.ts의
  // 판정 결과를 "관찰"만 한다 — 판정 자체는 project-lock.ts가 전담하고, 이 event들은 그
  // 결과를 audit 기록으로 남기는 용도다(§ event 배선은 checkpoint.ts/safe-executor.ts와
  // 동일하게 autodev.ts가 전담). PROJECT_LOCK_BLOCKED는 PROJECT_ALREADY_LOCKED/
  // LOCK_STATE_UNCERTAIN 둘 다를 포괄한다(metadata.lockBlockedCode로 구분) — 요구사항이
  // 예시한 event 이름 목록을 그대로 따르되 불필요하게 event type 수를 늘리지 않는다.
  | "PROJECT_LOCK_ACQUIRED"
  | "PROJECT_LOCK_BLOCKED"
  | "PROJECT_LOCK_RELEASED"
  | "PROJECT_LOCK_STALE_DETECTED"
  | "PROJECT_LOCK_RECOVERED"
  | "PROJECT_LOCK_CORRUPT";

export type AutoDevEventCategory = "observability" | "audit";

// 어떤 event type이 어떤 목적에 쓰이는지의 단일 출처 — "순수 진행 상황"(*_STARTED)은
// observability만, "보안/승인/최종 판정에 관한 사실"은 audit을 반드시 포함한다. 완료류
// event는 대체로 둘 다에 유용하다.
const EVENT_CATEGORIES: Record<AutoDevEventType, readonly AutoDevEventCategory[]> = {
  RUN_STARTED: ["observability"],
  RUN_COMPLETED: ["observability", "audit"],
  RUN_BLOCKED: ["observability", "audit"],
  TASK_STARTED: ["observability"],
  TASK_COMPLETED: ["observability", "audit"],
  AGENT_SELECTED: ["observability"],
  AGENT_STARTED: ["observability"],
  AGENT_COMPLETED: ["observability", "audit"],
  AGENT_FAILED: ["observability", "audit"],
  DEVELOPER_RETRY_STARTED: ["observability"],
  TEST_STARTED: ["observability"],
  TEST_COMPLETED: ["observability", "audit"],
  REVIEW_STARTED: ["observability"],
  REVIEW_APPROVED: ["observability", "audit"],
  REVIEW_REVISE: ["observability", "audit"],
  REVIEW_BLOCKED: ["audit"],
  SECURITY_BLOCKED: ["audit"],
  CHECKPOINT_CREATED: ["audit"],
  HUMAN_APPROVAL_REQUIRED: ["audit"],
  REVIEW_CYCLE_EXHAUSTED: ["audit"],
  NOTIFICATION_CREATED: ["observability"],
  NOTIFICATION_DELIVERED: ["observability"],
  NOTIFICATION_FAILED: ["observability"],
  APPROVAL_REQUESTED: ["observability"],
  APPROVAL_RECEIVED: ["observability"],
  APPROVAL_APPROVED: ["observability", "audit"],
  APPROVAL_REJECTED: ["observability", "audit"],
  APPROVAL_DEFERRED: ["observability", "audit"],
  APPROVAL_EXPIRED: ["observability", "audit"],
  APPROVAL_UNAUTHORIZED: ["audit"],
  APPROVAL_STALE: ["audit"],
  AUTO_RESUME_STARTED: ["observability"],
  AUTO_RESUME_BLOCKED: ["observability", "audit"],
  AUTO_RESUME_COMPLETED: ["observability"],
  PROJECT_LOCK_ACQUIRED: ["observability"],
  PROJECT_LOCK_BLOCKED: ["observability", "audit"],
  PROJECT_LOCK_RELEASED: ["observability"],
  PROJECT_LOCK_STALE_DETECTED: ["observability", "audit"],
  PROJECT_LOCK_RECOVERED: ["observability", "audit"],
  PROJECT_LOCK_CORRUPT: ["observability", "audit"],
};

/** 이 event type이 어떤 카테고리에 속하는지 — 순수 조회, 어떤 policy로도 바뀌지 않는다
 *  (함수가 policy 인자를 받지 않는다 — 이 코드베이스의 Core hard rule 패턴과 동일). */
export function classifyEventCategory(eventType: AutoDevEventType): readonly AutoDevEventCategory[] {
  return EVENT_CATEGORIES[eventType];
}

// Phase G Task G2 — "이 event 기록이 실패하면 조용히 넘어가면 안 된다"고 판정하는 event
// type의 단일 출처. 요구사항이 명시한 4가지(security block/human approval/checkpoint/
// run·task 최종 상태)만 담는다 — *_STARTED류나 test/agent 진행 상황 같은 일반 telemetry는
// 여기 없다(그런 event는 기록에 실패해도 production 실행에 영향을 주지 않는, 순수 관측
// 정보다). 이 판정도 policy 인자를 받지 않는다 — Project config가 무엇을 audit-critical로
// 볼지 재정의할 수 없다.
const AUDIT_CRITICAL_EVENT_TYPES: ReadonlySet<AutoDevEventType> = new Set<AutoDevEventType>([
  "SECURITY_BLOCKED",
  "HUMAN_APPROVAL_REQUIRED",
  "REVIEW_CYCLE_EXHAUSTED",
  "REVIEW_BLOCKED",
  "CHECKPOINT_CREATED",
  "RUN_COMPLETED",
  "RUN_BLOCKED",
  "TASK_COMPLETED",
  // Phase G Task G6 — 사람의 원격 승인 결정(또는 그 결정이 무효/미인가로 거부됐다는 사실)과
  // "승인은 됐지만 안전 재검사가 실행을 막았다"는 사실은 모두 감사상 반드시 남아야 한다.
  "APPROVAL_APPROVED",
  "APPROVAL_REJECTED",
  "APPROVAL_DEFERRED",
  "APPROVAL_EXPIRED",
  "APPROVAL_UNAUTHORIZED",
  "APPROVAL_STALE",
  "AUTO_RESUME_BLOCKED",
  // Phase G Task G7 — 동시 writer 진입이 막혔거나(BLOCKED) lock 상태를 신뢰할 수 없어
  // 진행을 중단한 경우(CORRUPT) 모두 보안상 중요한 사실이라 기록 실패를 조용히 넘기지 않는다.
  "PROJECT_LOCK_BLOCKED",
  "PROJECT_LOCK_CORRUPT",
]);

/** true면 이 event의 append 실패를 조용히 넘기면 안 된다(§ event-store.ts/autodev.ts/
 *  orchestrator.ts의 실패 처리 정책이 이 함수로만 판단한다 — 각자 다시 판정 기준을 만들지
 *  않는다). */
export function isAuditCriticalEvent(eventType: AutoDevEventType): boolean {
  return AUDIT_CRITICAL_EVENT_TYPES.has(eventType);
}

/** claude-developer.ts의 DeveloperResult.tests(실제 Safe Executor exitCode 기반)로부터
 *  TestResultSummary를 만든다 — orchestrator.ts/autodev.ts 양쪽이 이 함수 하나만 쓴다(같은
 *  집계 로직을 두 곳에 복제하지 않는다). */
export function buildTestSummary(tests: { name: string; pass: boolean }[]): TestResultSummary {
  return {
    total: tests.length,
    passed: tests.filter((t) => t.pass).length,
    failed: tests.filter((t) => !t.pass).length,
    failedNames: tests.filter((t) => !t.pass).map((t) => t.name),
  };
}

/** AgentStepStatus(agent-orchestrator.ts)와 호환되는 상위집합 — *_STARTED류 event를 위한
 *  PENDING만 추가한다. 새 상태 어휘를 따로 만들지 않고 기존 것에 맞춰 확장했다. */
export type EventOutcome = "PENDING" | "SUCCESS" | "FAILED" | "BLOCKED" | "SKIPPED";

/** 실행 흐름 중 어느 단계에서 발생했는지 — F4.1의 production 배치 구분(pre-development/
 *  post-development)을 그대로 반영한다. */
export type ExecutionPhase =
  | "task_selection"
  | "pre_development"
  | "development"
  | "test"
  | "review"
  | "post_development"
  | "checkpoint"
  | "state_update";

/** 실제 test 결과 요약만 담는다 — Claude/GPT의 자체 보고 문자열이나 test stdout 원문은
 *  담지 않는다(§ claude-developer.ts의 DeveloperResult.tests가 이미 실제 exitCode 기반). */
export interface TestResultSummary {
  total: number;
  passed: number;
  failed: number;
  failedNames?: string[];
}

/** 향후 측정을 위한 optional 구조 — 현재 runner가 실제로 제공하지 않는 값은 절대 채우지
 *  않는다(undefined 유지). 추정값을 실제값처럼 기록하지 않는다는 요구사항을 타입 레벨에서도
 *  전부 optional로 표현한다.
 *
 *  Phase G Task G3 — actualCostUsd/estimatedCostUsd는 의도적으로 분리된 별도 필드다.
 *  runner/billing source가 실제 청구 금액을 제공하면 actualCostUsd에, 가격표 기반 추정치는
 *  estimatedCostUsd에만 채운다 — metrics.ts를 포함해 이 둘을 하나로 합산하거나 서로
 *  대체하지 않는다(§ 요구사항: 실제값과 estimated 값을 혼합 금지). */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  /** runner/billing source가 실제로 제공한 청구 금액만 담는다 — 가격표로 역산한 값은
   *  절대 여기에 채우지 않는다(그런 값은 estimatedCostUsd로만 남긴다). */
  actualCostUsd?: number;
}

/** 실제 전달된 context의 "크기"만 기록한다(문자 수 등 실측 가능한 값) — 원문 자체는 담지
 *  않는다. summary는 사람이 읽는 짧은 설명(예: "taskGoal+선행 agent 요약")이지 원문
 *  transcript가 아니다. */
export interface ContextScopeInfo {
  approxChars?: number;
  summary?: string;
}

export interface AutoDevEventInput {
  eventType: AutoDevEventType;
  /** 이 event가 속한 1회 runAutodevOnce() 실행을 식별한다 — 모든 event에 필수(run/task/
   *  agent correlation의 기준). */
  runId: string;
  projectId?: string;
  taskId?: string;
  /** AGENT 계열/REVIEW 계열 등 특정 agent에 해당하는 event에서만 채운다. */
  agentId?: string;
  agentRole?: AgentRole;
  executionPhase?: ExecutionPhase;
  outcome?: EventOutcome;
  durationMs?: number;
  /** LLM을 실제로 호출했을 때만 채운다 — Core deterministic 작업에는 없다. */
  model?: { provider: string; name?: string };
  /** 이 event가 사용한 tool/capability 종류(자유 문자열, 예: "safe_executor",
   *  "capability_discovery") — task-registry.ts/agent-registry.ts의 RequiredTool과 굳이
   *  같은 타입으로 강제하지 않는다(이 event 모델은 Core 밖의 향후 tool도 기록할 수 있어야
   *  한다). */
  tool?: string;
  testSummary?: TestResultSummary;
  /** review-policy.ts의 override까지 반영된 최종 decision(types.ts의 GptDecision을
   *  그대로 재사용 — 새 decision 어휘를 만들지 않는다). */
  reviewDecision?: GptDecision;
  reviewSeverity?: SeverityCounts;
  /** REVISE가 몇 번째 cycle이었는지(orchestrator.ts의 state.reviewCycle과 동일한 의미). */
  reviseCycle?: number;
  humanInterventionRequired?: boolean;
  /** 사람이 읽는 짧은 사유 — 저장 전 secret-like 값이 redact된다(§ sanitizeEventInput). */
  reason?: string;
  error?: { code?: string; message: string };
  tokenUsage?: TokenUsage;
  contextScope?: ContextScopeInfo;
  /** 자유 형식 부가 정보 — 값은 원시 타입만 허용한다(중첩 객체에 secret이 숨을 여지를
   *  구조적으로 없앤다). 문자열 값은 저장 전 redact된다. */
  metadata?: Record<string, string | number | boolean | null>;
}

/** 저장되기 전(sequence 미부여) 상태의 event — event-store.ts의 append()가 sequence를
 *  붙여 AutoDevEvent로 완성한다. */
export type AutoDevEventDraft = AutoDevEventInput & {
  eventId: string;
  timestamp: string;
  categories: readonly AutoDevEventCategory[];
};

/** 실제로 저장된 event — sequence는 append 시점에 store가 단조증가로 부여한다(timestamp가
 *  같은 밀리초에 겹치더라도 순서를 명확히 구분하기 위함 — § deterministic event ordering). */
export interface AutoDevEvent extends AutoDevEventDraft {
  sequence: number;
}

function redactSecretLikeText(text: string): string {
  // 1) 알려진 key 이름 기반 redaction(logger.ts, 이미 log() 전체가 재사용 중).
  let safe = sanitizeForLog(text);
  // 2) key 이름과 무관한 secret "모양" 기반 redaction(secret-scanner.ts, checkpoint gate와
  //    동일한 단일 출처) — 여기서만 새로 정규식을 만들지 않는다.
  for (const { regex } of SECRET_CONTENT_PATTERNS) {
    const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
    safe = safe.replace(new RegExp(regex.source, flags), "[REDACTED]");
  }
  return safe;
}

/** event input의 모든 자유 텍스트 필드에서 secret-like 값을 제거한다. 이 함수는
 *  createEvent() 내부에서 항상 호출된다 — 호출부가 잊어버릴 수 없는 구조(빠뜨릴 수 있는
 *  "옵션"이 아니라 event 생성 경로 자체에 내장돼 있다). */
function sanitizeEventInput(input: AutoDevEventInput): AutoDevEventInput {
  const sanitized: AutoDevEventInput = { ...input };
  if (sanitized.reason !== undefined) sanitized.reason = redactSecretLikeText(sanitized.reason);
  if (sanitized.error) sanitized.error = { ...sanitized.error, message: redactSecretLikeText(sanitized.error.message) };
  if (sanitized.contextScope?.summary !== undefined) {
    sanitized.contextScope = { ...sanitized.contextScope, summary: redactSecretLikeText(sanitized.contextScope.summary) };
  }
  if (sanitized.metadata) {
    const safeMeta: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(sanitized.metadata)) {
      safeMeta[key] = typeof value === "string" ? redactSecretLikeText(value) : value;
    }
    sanitized.metadata = safeMeta;
  }
  return sanitized;
}

/**
 * AutoDevEventDraft를 만든다 — eventId/timestamp/categories를 부여하고, 모든 자유 텍스트
 * 필드를 sanitize한다. sequence는 아직 없다(event-store.ts의 append()가 부여). 이 함수는
 * 어떤 policy/config 인자도 받지 않는다 — Project config가 이 sanitization을 끄거나
 * 약화시킬 방법이 없다(구조적 Core hard rule).
 */
export function createEvent(input: AutoDevEventInput): AutoDevEventDraft {
  const sanitized = sanitizeEventInput(input);
  return {
    ...sanitized,
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    categories: classifyEventCategory(input.eventType),
  };
}
