import { createHash } from "node:crypto";
import type { EventStore } from "./event-store";
import { SECRET_CONTENT_PATTERNS } from "./secret-scanner";
import { SELF_DEV_PROJECT_ID } from "./self-dev-completion";
import type { SelfDevTaskContext, TaskContextError } from "./self-dev-task-context";
import { isTaskContextError } from "./self-dev-task-context";
import { log } from "./logger";

// Self-Dev BLOCKED / WAITING_HUMAN Terminal Status Bridge — Phase G Task G7.3.2.
//
// self-dev-completion.ts(G7.2.1)는 "Task가 COMPLETED로 끝났다"만 다룬다. 이 파일은 그
// 짝이다 — self-dev Claude Code Task가 실제 terminal 상태로 BLOCKED 또는 WAITING_HUMAN에
// 도달했을 때, 이미 갖춰진 production notification 경로(EventStore → notification-
// service.ts → NotificationStore/dedupe → telegram-controller.ts → Telegram Provider)를
// 그대로 재사용해 Telegram으로 알린다. self-dev-complete.ts(→ self-dev-completion.ts)의
// COMPLETED 경로는 이 파일이 건드리지 않는다(§ 요구사항 — LIVE VERIFIED 경로 재설계 금지).
//
// 두 상태를 서로 다른 기존/신규 어휘로 표현한다(§ 조사 결과, notification.ts/
// approval-service.ts 실측):
//   - BLOCKED  → 기존 "RUN_BLOCKED" eventType/notificationType을 그대로 재사용한다.
//     RUN_BLOCKED는 이미 severity=CRITICAL이고, approval-service.ts의
//     createApprovalRequestsFromEvents()가 이미 이 notificationType을 ApprovalRequest
//     생성 대상에서 제외한다(§ approval-service.ts 기존 주석) — 새 event/notification
//     type이 필요 없다.
//   - WAITING_HUMAN → 기존 "WAITING_HUMAN" notificationType(REVIEW_BLOCKED event 전용)을
//     재사용하지 않는다. 그 경로는 requiresHumanAction=true이고 approval-service.ts에서
//     RUN_BLOCKED만 예외 처리돼 있어, 그대로 재사용하면 실제 resumable action이 없는
//     self-dev 상태에도 ApprovalRequest가 만들어진다(요구사항이 명시적으로 금지). 대신
//     새 eventType "SELF_DEV_WAITING_HUMAN"/notificationType "SELF_DEV_WAITING_HUMAN"을
//     추가하고(§ observability-event.ts/notification.ts), approval-service.ts에 RUN_BLOCKED와
//     동일한 패턴으로 명시적 제외를 추가한다 — ApprovalRequest가 구조적으로 0건이다.
//
// reason은 event.reason(자유 텍스트, createEvent()가 이미 secret-shape 값을 redact함, §
// observability-event.ts)에 그대로 싣지만, 그 전에 이 파일의 validateSelfDevTerminalReason()
// 이 한 번 더 독립적으로 검증한다(빈 값/과도한 길이/여러 줄(스택 트레이스·prompt 붙여넣기
// 방지)/secret-like 패턴을 fail-closed로 거부) — self-dev-completion.ts의 evidence
// validation과 동일한 "이 파일 하나가 유효성의 단일 출처" 원칙이다. Telegram 메시지 본문
// 자체는 여전히 고정 템플릿만 쓴다(§ notification.ts 상단 주석 — event의 자유 텍스트를
// 알림 본문에 옮기지 않는다는 기존 불변식을 이 Task를 위해 약화시키지 않는다). reason은
// event.reason/metadata에만 남아 EventStore/Dashboard 감사 기록으로 쓰인다.

export type SelfDevTerminalStatus = "BLOCKED" | "WAITING_HUMAN";

const TERMINAL_STATUS_EVENT_TYPE: Record<SelfDevTerminalStatus, "RUN_BLOCKED" | "SELF_DEV_WAITING_HUMAN"> = {
  BLOCKED: "RUN_BLOCKED",
  WAITING_HUMAN: "SELF_DEV_WAITING_HUMAN",
};

export const MAX_SELF_DEV_TERMINAL_REASON_LENGTH = 200;
const MAX_REASON_NEWLINES = 2;

export interface ReasonValidationError {
  error: string;
}

export function isReasonValidationError(value: unknown): value is ReasonValidationError {
  return typeof value === "object" && value !== null && typeof (value as ReasonValidationError).error === "string";
}

/**
 * reason 후보가 "짧고 안전한 사유"인지 판정하는 단일 출처(fail-closed). 값이 없거나 빈
 * 문자열이면 즉시 거부한다(§ 요구사항 — reason 필수). 길이 상한과 줄바꿈 상한은 full
 * prompt/raw Claude·GPT output/전체 stack trace를 그대로 붙여넣는 것을 구조적으로
 * 막는다(그런 텍스트는 이 상한을 항상 넘긴다). secret-like 패턴(§ secret-scanner.ts
 * SECRET_CONTENT_PATTERNS, observability-event.ts의 redaction과 동일한 단일 출처)이
 * 매칭되면 redact해서 조용히 통과시키지 않고 거부한다 — "Bot Token/API key 등을 담지
 * 않는다"는 요구사항을 사후 마스킹이 아니라 사전 거부로 만족시킨다.
 */
export function validateSelfDevTerminalReason(candidate: unknown): string | ReasonValidationError {
  if (typeof candidate !== "string") {
    return { error: "reason이 없습니다(문자열이 필요합니다)." };
  }
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return { error: "reason이 비어있습니다 — BLOCKED/WAITING_HUMAN에는 짧은 사유가 필수입니다." };
  }
  if (trimmed.length > MAX_SELF_DEV_TERMINAL_REASON_LENGTH) {
    return {
      error: `reason이 너무 깁니다(${trimmed.length}자, 최대 ${MAX_SELF_DEV_TERMINAL_REASON_LENGTH}자) — 짧은 사유만 허용됩니다(전체 prompt/출력/stack trace 금지).`,
    };
  }
  const newlineCount = (trimmed.match(/\n/g) ?? []).length;
  if (newlineCount > MAX_REASON_NEWLINES) {
    return { error: "reason에 줄바꿈이 너무 많습니다 — 여러 줄 stack trace/prompt 붙여넣기는 허용되지 않습니다." };
  }
  for (const { regex } of SECRET_CONTENT_PATTERNS) {
    if (regex.test(trimmed)) {
      return { error: "reason에 secret처럼 보이는 값이 포함되어 있어 거부되었습니다(Bot Token/API key/credential 등은 reason에 담을 수 없습니다)." };
    }
  }
  return trimmed;
}

/**
 * taskId+terminalStatus+reason으로부터 결정론적 runId를 만든다 — self-dev-completion.ts의
 * deriveSelfDevRunId()(taskId+commitHash 기반)와 동일한 목적(§ dedupe 단일 출처)을
 * terminal-status에 맞게 재구현한다. 동일한 세 값으로 이 명령을 몇 번 다시 실행해도 항상
 * 같은 runId → 같은 notification dedupeKey(§ notification.ts buildDedupeKey)이므로 중복
 * Telegram이 없다. reason이 dedupe identity에 포함되므로, 같은 Task에 대해 사유가 실제로
 *바뀌면(= 새로운 정보) 새 알림으로 취급한다 — 이는 요구사항이 명시한 dedupe 기준
 * (taskId+terminalStatus+reason)을 그대로 따른 것이다.
 */
export function deriveSelfDevTerminalRunId(taskId: string, terminalStatus: SelfDevTerminalStatus, reason: string): string {
  const digest = createHash("sha256").update(`${SELF_DEV_PROJECT_ID}:${terminalStatus}:${taskId}:${reason}`).digest("hex");
  return [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16), digest.slice(16, 20), digest.slice(20, 32)].join("-");
}

export interface ResolvedSelfDevTerminalInput {
  taskId: string;
  reason: string;
}

export interface ResolveSelfDevTerminalInputError {
  error: string;
}

export function isResolveSelfDevTerminalInputError(value: unknown): value is ResolveSelfDevTerminalInputError {
  return typeof value === "object" && value !== null && typeof (value as ResolveSelfDevTerminalInputError).error === "string";
}

/**
 * CLI 진입점(self-dev-blocked.ts/self-dev-waiting-human.ts)이 EventStore를 건드리기 전에
 * 거치는 단일 fail-closed 게이트다 — self-dev-task-context.ts가 이미 읽은 context와 CLI가
 * 받은 --reason 후보만으로 "이 호출이 event를 만들어도 되는가"를 판정한다(순수 함수, git/
 * 파일시스템 접근 없음 — self-dev-completion-hook.ts의 decideSelfDevCompletionTrigger()와
 * 동일한 "판정과 실행을 분리"하는 테스트 seam 패턴). context가 undefined(self-dev:begin
 * 미실행)거나 TaskContextError(선언이 손상됨)면 즉시 거부한다 — taskId를 transcript
 * parsing/commit message 추측/최근 task 추측으로 채우지 않는다(§ 요구사항).
 */
export function resolveSelfDevTerminalInput(
  context: SelfDevTaskContext | TaskContextError | undefined,
  reasonCandidate: unknown
): ResolvedSelfDevTerminalInput | ResolveSelfDevTerminalInputError {
  if (context === undefined) {
    return {
      error: "self-dev task context가 선언되지 않았습니다 — 먼저 `npm run self-dev:begin -- --task-id <id>`를 실행하세요.",
    };
  }
  if (isTaskContextError(context)) {
    return { error: `self-dev task context가 유효하지 않습니다: ${context.error}` };
  }
  const reason = validateSelfDevTerminalReason(reasonCandidate);
  if (isReasonValidationError(reason)) {
    return { error: reason.error };
  }
  return { taskId: context.taskId, reason };
}

export interface RecordSelfDevTerminalStatusInput {
  taskId: string;
  terminalStatus: SelfDevTerminalStatus;
  /** validateSelfDevTerminalReason()을 이미 통과한 값만 넘긴다(§ 호출부: self-dev-blocked.ts/
   *  self-dev-waiting-human.ts). 이 함수 자신은 다시 검증하지 않는다 — 검증은 CLI 진입점의
   *  책임이고(fail-closed 판정을 한 곳에서만), 이 함수는 "이미 유효한 reason을 어떻게
   *  정확히 1회 기록하는가"만 담당한다(§ recordSelfDevTaskCompleted와 동일한 계층 분리).
   */
  reason: string;
}

export interface RecordSelfDevTerminalStatusResult {
  ok: boolean;
  /** true면 이번 호출 이전에 이미 같은 taskId+terminalStatus+reason으로 기록돼 있었다는
   *  뜻이다 — 새 event를 append하지 않았다(§ dedupe). */
  alreadyRecorded: boolean;
  runId: string;
  eventType: "RUN_BLOCKED" | "SELF_DEV_WAITING_HUMAN";
  error?: string;
}

/**
 * EventStore에 self-dev terminal status event를 기록한다(§ 파일 상단 주석 — BLOCKED는
 * 기존 RUN_BLOCKED, WAITING_HUMAN은 신규 SELF_DEV_WAITING_HUMAN). 같은 taskId+
 * terminalStatus+reason 조합이 이미 SELF_DEV_PROJECT_ID로 기록돼 있으면(= 같은
 * deriveSelfDevTerminalRunId() 결과) 새로 append하지 않고 기존 runId를 그대로 반환한다 —
 * recordSelfDevTaskCompleted()와 동일한 idempotency 패턴.
 */
export function recordSelfDevTerminalStatus(
  events: EventStore,
  input: RecordSelfDevTerminalStatusInput
): RecordSelfDevTerminalStatusResult {
  const eventType = TERMINAL_STATUS_EVENT_TYPE[input.terminalStatus];
  const runId = deriveSelfDevTerminalRunId(input.taskId, input.terminalStatus, input.reason);

  const existing = events
    .query({ taskId: input.taskId, eventType })
    .events.find((e) => e.projectId === SELF_DEV_PROJECT_ID && e.runId === runId);
  if (existing) {
    log("self-dev terminal status event 이미 기록됨 — 중복 append/알림 없이 재사용", {
      taskId: input.taskId,
      terminalStatus: input.terminalStatus,
      runId,
    });
    return { ok: true, alreadyRecorded: true, runId, eventType };
  }

  const appendResult = events.append({
    eventType,
    runId,
    projectId: SELF_DEV_PROJECT_ID,
    taskId: input.taskId,
    executionPhase: "state_update",
    outcome: input.terminalStatus === "BLOCKED" ? "BLOCKED" : "PENDING",
    reason: input.reason,
    metadata: { source: "claude-code-self-dev-bridge", terminalStatus: input.terminalStatus },
  });
  if (!appendResult.ok) {
    return { ok: false, alreadyRecorded: false, runId, eventType, error: appendResult.error ?? "unknown" };
  }
  log("self-dev terminal status event 기록됨", { taskId: input.taskId, terminalStatus: input.terminalStatus, runId });
  return { ok: true, alreadyRecorded: false, runId, eventType };
}
