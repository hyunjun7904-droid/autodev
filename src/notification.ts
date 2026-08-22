import { randomUUID } from "node:crypto";
import type { AutoDevEvent, AutoDevEventType } from "./observability-event";

// Notification Model & Deterministic Classification — Phase G Task G5.
//
// 이 파일은 G1~G4.1의 EventStore/observability-event(AutoDevEvent)의 순수 소비자다 —
// production 판정(Developer/Reviewer/Test/Security Gate/Checkpoint 로직)을 전혀 만들거나
// 바꾸지 않는다. "이미 기록된 event가 어떤 알림에 해당하는가"만 deterministic 규칙으로
// 판정한다 — LLM을 호출하지 않으며, 동일 입력에는 항상 동일 출력을 반환하는 순수 함수다.
//
// event → notification 매핑은 이미 확정된 어휘만 쓴다:
//   - TASK_COMPLETED/HUMAN_APPROVAL_REQUIRED/SECURITY_BLOCKED/REVIEW_CYCLE_EXHAUSTED/
//     RUN_BLOCKED event는 observability-event.ts에 이미 존재하는 AutoDevEventType 값
//     그대로 1:1로 매핑한다(새 event type을 만들지 않는다).
//   - REVIEW_BLOCKED event(GPT reviewer가 최종 차단 — live-snapshot.ts의
//     STATUS_TRANSITIONS가 이미 이 event를 WAITING_HUMAN LiveStatus로 분류하는 것과 동일한
//     사실)는, HUMAN_APPROVAL_REQUIRED/REVIEW_CYCLE_EXHAUSTED가 이미 전용 알림을 가지므로,
//     남은 "사람 확인이 최종적으로 필요해진 나머지 경로"를 대표하는 일반 WAITING_HUMAN
//     알림으로 매핑한다.
//   - 2026-08-22 incident 이후(Phase G Task G7.2.1 안전장치 강화) — RUN_COMPLETED와
//     TEST_FAILED(TEST_COMPLETED event의 testSummary.failed>0 파생)는 더 이상 알림을
//     만들지 않는다. 실제 Telegram 전송은 "production/self-dev 실제 Task의 high-signal
//     최종 상태"로만 제한한다: TASK_COMPLETED, TASK_FAILED에 해당하는 최종 BLOCKED
//     (SECURITY_BLOCKED/RUN_BLOCKED), 그리고 실제 사람 개입이 최종적으로 필요해진
//     HUMAN_APPROVAL_REQUIRED/REVIEW_CYCLE_EXHAUSTED/WAITING_HUMAN뿐이다. RUN_COMPLETED는
//     TASK_COMPLETED와 사실상 중복 정보이고, TEST_FAILED는 REVISE 재시도마다(회귀 실패한
//     시도 하나하나) 반복 발생하는 중간 신호라 알림 폭탄의 실제 원인 중 하나였다(REVISE
//     루프 자체를 반복 알림하지 않는다 — 사람 개입이 최종적으로 필요해진 경우
//     REVIEW_CYCLE_EXHAUSTED로 정확히 1건만 알린다).
//   - 그 외 event(*_STARTED, AGENT_*, REVIEW_STARTED/APPROVED/REVISE, CHECKPOINT_CREATED,
//     RUN_COMPLETED, TEST_COMPLETED 등)는 알림을 만들지 않는다 — 순수 진행 상황이거나
//     이미 다른 event로 대표되거나, 위 high-signal 정책 밖이다.
//
// 메시지 본문은 event.reason/error.message 같은 자유 텍스트를 절대 옮겨 담지 않는다(§
// live-snapshot.ts CURRENT_ACTION_LABELS와 동일한 원칙) — 고정 템플릿 + runId/taskId 같은
// 순수 식별자, 그리고 testSummary.failed 같은 이미 집계된 숫자만 채운다. raw prompt/
// Claude·GPT 출력/secret/전체 source는 이 파일이 다루는 AutoDevEvent 자체에 애초에 담기지
// 않는다(§ observability-event.ts sanitizeEventInput) — 이 파일은 그 사실을 재확인하지
// 않고 그대로 신뢰하되, 자유 텍스트 필드를 옮겨 담는 코드 경로 자체를 만들지 않아 이중으로
// 안전하다.

export type NotificationSeverity = "INFO" | "WARNING" | "ACTION_REQUIRED" | "CRITICAL";

export type NotificationType =
  | "TASK_COMPLETED"
  | "RUN_COMPLETED"
  | "TEST_FAILED"
  | "WAITING_HUMAN"
  | "HUMAN_APPROVAL_REQUIRED"
  | "SECURITY_BLOCKED"
  | "REVIEW_CYCLE_EXHAUSTED"
  | "RUN_BLOCKED"
  // Phase G Task G7.3.2 — self-dev informational-only WAITING_HUMAN(§ self-dev-terminal-
  // status.ts 상단 주석). 기존 "WAITING_HUMAN"(REVIEW_BLOCKED 전용)과 의도적으로 분리한다 —
  // 이 type은 requiresHumanAction=true이지만 approval-service.ts가 명시적으로 ApprovalRequest
  // 생성 대상에서 제외한다(실제 resumable production action이 없으므로 버튼을 절대 만들지
  // 않는다).
  | "SELF_DEV_WAITING_HUMAN";

export interface NotificationMessage {
  id: string;
  createdAt: string;
  projectId?: string;
  runId: string;
  taskId?: string;
  notificationType: NotificationType;
  severity: NotificationSeverity;
  /** 휴대폰 알림 제목 — 항상 고정 템플릿(§ 파일 상단 주석). */
  title: string;
  /** 휴대폰 알림 본문 — 항상 고정 템플릿 + 순수 식별자/집계 숫자만. */
  shortMessage: string;
  requiresHumanAction: boolean;
  dedupeKey: string;
  sourceEventType: AutoDevEventType;
  sourceEventId: string;
}

/** severity 우선순위 — 낮을수록 더 급하다. notification-service.ts의 delivery 순서 결정에
 *  재사용한다(단일 출처, 우선순위 표를 두 곳에서 따로 정의하지 않는다). */
export const NOTIFICATION_SEVERITY_PRIORITY: Record<NotificationSeverity, number> = {
  CRITICAL: 0,
  ACTION_REQUIRED: 1,
  WARNING: 2,
  INFO: 3,
};

const NOTIFICATION_SEVERITY: Record<NotificationType, NotificationSeverity> = {
  TASK_COMPLETED: "INFO",
  RUN_COMPLETED: "INFO",
  TEST_FAILED: "WARNING",
  WAITING_HUMAN: "ACTION_REQUIRED",
  HUMAN_APPROVAL_REQUIRED: "ACTION_REQUIRED",
  REVIEW_CYCLE_EXHAUSTED: "ACTION_REQUIRED",
  RUN_BLOCKED: "CRITICAL",
  SECURITY_BLOCKED: "CRITICAL",
  SELF_DEV_WAITING_HUMAN: "ACTION_REQUIRED",
};

const REQUIRES_HUMAN_ACTION: Record<NotificationType, boolean> = {
  TASK_COMPLETED: false,
  RUN_COMPLETED: false,
  TEST_FAILED: false,
  WAITING_HUMAN: true,
  HUMAN_APPROVAL_REQUIRED: true,
  REVIEW_CYCLE_EXHAUSTED: true,
  RUN_BLOCKED: true,
  SECURITY_BLOCKED: true,
  // true다(사람이 실제로 확인해야 하는 상태라는 사실은 정확하다 — notification-store.ts의
  // actionRequiredPendingCount 등 dashboard 집계가 이 사실을 정확히 반영해야 한다). 다만
  // approval-service.ts가 이 notificationType을 명시적으로 ApprovalRequest 생성 대상에서
  // 제외하므로(§ 그 파일), 이 값이 true여도 버튼이 있는 승인 요청은 절대 만들어지지 않는다
  // (RUN_BLOCKED와 동일한 "requiresHumanAction=true지만 approval-service.ts가 별도 차단"
  // 패턴).
  SELF_DEV_WAITING_HUMAN: true,
};

interface NotificationContent {
  title: string;
  shortMessage: string;
}

function taskLabel(event: Pick<AutoDevEvent, "taskId" | "runId">): string {
  return event.taskId ?? event.runId;
}

// 모든 메시지는 고정 템플릿이다 — event의 자유 텍스트 필드(reason/error.message/metadata)를
// 읽지 않는다(§ 파일 상단 주석). testSummary.failed만 예외적으로 쓰는데, 이는 자유 텍스트가
// 아니라 이미 집계된 숫자다(§ observability-event.ts buildTestSummary).
const NOTIFICATION_CONTENT: Record<NotificationType, (event: AutoDevEvent) => NotificationContent> = {
  TASK_COMPLETED: (e) => ({
    title: "[AutoDev] Task 완료",
    shortMessage: `Task ${taskLabel(e)}가 완료되었습니다.`,
  }),
  RUN_COMPLETED: (e) => ({
    title: "[AutoDev] Run 완료",
    shortMessage: `Run ${e.runId}이 완료되었습니다.`,
  }),
  TEST_FAILED: (e) => ({
    title: "[AutoDev] 테스트 실패",
    shortMessage: `Task ${taskLabel(e)} / ${e.testSummary?.failed ?? "?"}개 테스트 실패`,
  }),
  WAITING_HUMAN: (e) => ({
    title: "[AutoDev] 승인 필요",
    shortMessage: `Task ${taskLabel(e)}가 WAITING_HUMAN 상태입니다.`,
  }),
  HUMAN_APPROVAL_REQUIRED: (e) => ({
    title: "[AutoDev] 승인 필요",
    shortMessage: `Task ${taskLabel(e)}에 사람 승인이 필요합니다.`,
  }),
  SECURITY_BLOCKED: (e) => ({
    title: "[AutoDev] 보안 차단",
    shortMessage: `Task ${taskLabel(e)}에서 보안 게이트가 checkpoint를 차단했습니다.`,
  }),
  REVIEW_CYCLE_EXHAUSTED: (e) => ({
    title: "[AutoDev] 리뷰 반복 한도 도달",
    shortMessage: `Task ${taskLabel(e)}의 REVISE 반복이 한도에 도달했습니다.`,
  }),
  RUN_BLOCKED: (e) => ({
    title: "[AutoDev] 실행 차단",
    shortMessage: `Run ${e.runId}이 Task ${taskLabel(e)}에서 차단되어 중단되었습니다.`,
  }),
  SELF_DEV_WAITING_HUMAN: (e) => ({
    title: "[AutoDev] 사용자 확인 필요",
    shortMessage: `Task ${taskLabel(e)}가 사용자 확인이 필요한 상태입니다(Telegram 원격 승인으로 재개할 수 없습니다).`,
  }),
};

// event type → notification type 단일 매핑. 이 표에 없는 event type은 알림을 만들지 않는다
// (Partial이라 컴파일러가 "새 event type을 추가하면 여기도 채워야 한다"고 강제하지 않는다 —
// 의도적이다: 새 event type의 기본값은 "알림 없음"이어야 하고, 알림이 필요한 event만 이
// 표에 명시적으로 추가한다).
const EVENT_TO_NOTIFICATION_TYPE: Partial<Record<AutoDevEventType, NotificationType>> = {
  TASK_COMPLETED: "TASK_COMPLETED",
  HUMAN_APPROVAL_REQUIRED: "HUMAN_APPROVAL_REQUIRED",
  SECURITY_BLOCKED: "SECURITY_BLOCKED",
  REVIEW_CYCLE_EXHAUSTED: "REVIEW_CYCLE_EXHAUSTED",
  RUN_BLOCKED: "RUN_BLOCKED",
  REVIEW_BLOCKED: "WAITING_HUMAN",
  // RUN_COMPLETED는 의도적으로 여기 없다(§ 파일 상단 주석 — 2026-08-22 incident 이후
  // TASK_COMPLETED와 중복되는 중간/완료 정보는 보내지 않는다).
  // Phase G Task G7.3.2 — self-dev BLOCKED는 이 표에 별도 항목이 없다(RUN_BLOCKED가 이미
  // 위에서 매핑돼 있고, self-dev-terminal-status.ts가 그 기존 eventType을 그대로 재사용
  // 한다 — 새 event type 없음).
  SELF_DEV_WAITING_HUMAN: "SELF_DEV_WAITING_HUMAN",
};

function buildDedupeKey(runId: string, taskId: string | undefined, type: NotificationType, cycle: number | undefined): string {
  return `${runId}::${taskId ?? "-"}::${type}::${cycle ?? "-"}`;
}

/**
 * event 하나를 이미 확정된 규칙으로만 판정해 NotificationMessage(아직 전달되지 않은 순수
 * 데이터)로 변환한다. 알림 대상이 아니면 undefined. 이 함수는 어떤 policy/config 인자도
 * 받지 않는다 — 알림 판정 기준을 project/adapter가 약화시킬 방법이 없다(safe-executor.ts/
 * secret-scanner.ts와 동일한 Core hard rule 패턴).
 */
export function classifyEventForNotification(event: AutoDevEvent): NotificationMessage | undefined {
  // TEST_COMPLETED(개별 회귀/REVISE 재시도의 중간 결과, 실패 여부와 무관)는 의도적으로
  // 알림을 만들지 않는다(§ 파일 상단 주석 — 2026-08-22 incident, REVISE 반복마다 알림이
  // 쌓이는 문제의 실제 원인이었다).
  const type: NotificationType | undefined = EVENT_TO_NOTIFICATION_TYPE[event.eventType];
  if (!type) return undefined;

  const content = NOTIFICATION_CONTENT[type](event);

  return {
    id: randomUUID(),
    createdAt: event.timestamp,
    projectId: event.projectId,
    runId: event.runId,
    taskId: event.taskId,
    notificationType: type,
    severity: NOTIFICATION_SEVERITY[type],
    title: content.title,
    shortMessage: content.shortMessage,
    requiresHumanAction: REQUIRES_HUMAN_ACTION[type],
    dedupeKey: buildDedupeKey(event.runId, event.taskId, type, event.reviseCycle),
    sourceEventType: event.eventType,
    sourceEventId: event.eventId,
  };
}

/** events(이미 sequence 오름차순인 목록)를 순회하며 알림 대상 event만 NotificationMessage로
 *  변환한다 — 순서는 event 순서 그대로 유지한다(우선순위 정렬은 notification-service.ts가
 *  전달 단계에서 별도로 담당한다). */
export function extractNotifications(events: AutoDevEvent[]): NotificationMessage[] {
  const out: NotificationMessage[] = [];
  for (const e of events) {
    const notification = classifyEventForNotification(e);
    if (notification) out.push(notification);
  }
  return out;
}
