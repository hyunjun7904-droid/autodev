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
//   - Phase G Task G7.5(Telegram 알림 UX Hardening) — 위 high-signal 정책은 유지하되,
//     "하위 Task 완료"와 "상위 Task/Phase 진짜 최종 완료"를 서로 다른 판정 근거로
//     구분한다(§ 요구사항 8 — 단순 문자열만 바꾸지 않는다):
//       - 🟡 TASK_COMPLETED(기본값) — 이 task의 checkpoint는 성공했지만 아직 상위
//         작업(production task-registry 전체 또는 self-dev의 명시적 --final 선언)이
//         끝났다는 authoritative 신호가 없는 상태. "다음 프로젝트 시작 가능: 아니오".
//       - ✅ FINAL_COMPLETED — production에서는 별도 event PROJECT_COMPLETED로만(§
//         autodev.ts, task-registry.getNextTask()가 다음 task 없음 + isHumanGate
//         아님으로 판정하고 project-state.json PROJECT_COMPLETE 저장 + administrative
//         commit이 성공한 *이후*에만 발생), self-dev에서는 TASK_COMPLETED.metadata.
//         completionScope==="FINAL"(§ self-dev-completion.ts의 evidence.isFinal, 같은
//         재검증 파이프라인을 거친 뒤에만 세팅됨)로만 만들어진다 — 세션 종료/마지막
//         메시지 같은 추측으로 만들어지지 않는다.
//       - ⛔ 사람 확인이 필요한 6+1종(WAITING_HUMAN/HUMAN_APPROVAL_REQUIRED/
//         SECURITY_BLOCKED/REVIEW_CYCLE_EXHAUSTED/RUN_BLOCKED/SELF_DEV_WAITING_HUMAN/
//         DEPLOYMENT_WAITING_HUMAN)는 이제 공통된 "[AutoDev] 사용자 확인 필요" 형태로
//         통일하되, 사유 줄로 서로 구분한다.
//       - ❌ SELF_DEV_TASK_FAILED — self-dev 완료 재검증이 실패로 끝난 사실(오늘까지는
//         콘솔에만 남고 Telegram이 전혀 오지 않던 gap).
//   - 그 외 event(*_STARTED, AGENT_*, REVIEW_STARTED/APPROVED/REVISE, CHECKPOINT_CREATED,
//     RUN_COMPLETED, TEST_COMPLETED 등)는 알림을 만들지 않는다 — 순수 진행 상황이거나
//     이미 다른 event로 대표되거나, 위 high-signal 정책 밖이다.
//
// 메시지 본문은 원칙적으로 고정 템플릿 + runId/taskId 같은 순수 식별자 + testSummary.failed
// 같은 이미 집계된 숫자만 채운다(§ live-snapshot.ts CURRENT_ACTION_LABELS와 동일한 원칙).
// event.reason은 observability-event.ts의 createEvent()가 저장 시점에 이미 secret-shape
// 값을 redact했지만(§ sanitizeEventInput), 그 사실만으로 "어떤 reason이든 그대로 노출해도
// 안전하다"고 보지 않는다 — WAITING_HUMAN/HUMAN_APPROVAL_REQUIRED/SECURITY_BLOCKED/
// REVIEW_CYCLE_EXHAUSTED는 여전히 고정 문구만 쓴다(그 reason들은 orchestrator status 문자열/
// audit store 에러 메시지처럼 이 파일이 형태를 통제할 수 없는 값이 섞여 있을 수 있다).
// RUN_BLOCKED/SELF_DEV_WAITING_HUMAN/SELF_DEV_TASK_FAILED만 예외다 — 그 reason은 각각
// checkpoint.ts의 고정 템플릿 문자열이거나 self-dev-terminal-status.ts의
// validateSelfDevTerminalReason()(길이/줄바꿈/secret-shape를 사전 거부하는 전용 검증)을
// 이미 통과한 값이라는 것을 소스에서 직접 확인했다 — 그래서 boundedReason()으로 한 번 더
// 방어적으로(길이 상한 + 한 줄로 접기) 다듬어서만 사유 줄에 노출한다.

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
  | "SELF_DEV_WAITING_HUMAN"
  // Phase G Task G7.5 — 하위 Task 완료(🟡, 기존 TASK_COMPLETED)와 명확히 구분되는 "진짜
  // 최종 완료"(✅). production PROJECT_COMPLETED event 또는 self-dev
  // TASK_COMPLETED.metadata.completionScope==="FINAL"에서만 만들어진다(§ 파일 상단 주석).
  | "FINAL_COMPLETED"
  // production task-registry의 모든 자동 task는 끝났지만 마지막 task가 isHumanGate라 실제
  // 배포는 사람이 트리거해야 하는 상태(⛔) — SELF_DEV_WAITING_HUMAN과 동일하게 실제
  // resumable action이 없으므로 approval-service.ts가 버튼을 만들지 않는다(§ 그 파일).
  | "DEPLOYMENT_WAITING_HUMAN"
  // self-dev-complete.ts의 deterministic 재검증(typecheck/build/전체 회귀/commit/push)이
  // 실패로 끝났다는 사실(❌) — "사람 확인 필요"가 아니라 "이번 시도는 최종적으로 완료되지
  // 못했다"는 별도 의미다(버튼 없음, 문제를 고쳐 같은 taskId로 다시 시도하면 된다).
  | "SELF_DEV_TASK_FAILED";

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
  FINAL_COMPLETED: "INFO",
  DEPLOYMENT_WAITING_HUMAN: "ACTION_REQUIRED",
  SELF_DEV_TASK_FAILED: "WARNING",
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
  // "진짜 최종 완료" 자체는 사람이 확인/승인할 대상이 아니다(이미 모든 필수 검증을 통과한
  // 완료 사실의 통보) — TASK_COMPLETED와 동일하게 false, 버튼 없음.
  FINAL_COMPLETED: false,
  // RUN_BLOCKED/SELF_DEV_WAITING_HUMAN과 동일한 "requiresHumanAction=true지만
  // approval-service.ts가 별도 차단" 패턴 — 실제 배포 트리거는 이 파이프라인의 remotely
  // approvable action이 아니다(§ approval-service.ts exclusion).
  DEPLOYMENT_WAITING_HUMAN: true,
  // "최종적으로 완료되지 못했다"는 사실 자체는 버튼이 있는 승인 요청이 아니다 — 문제를
  // 고쳐 같은 taskId로 다시 시도하면 된다(정보성 알림, TASK_COMPLETED/FINAL_COMPLETED와
  // 동일하게 false).
  SELF_DEV_TASK_FAILED: false,
};

interface NotificationContent {
  title: string;
  shortMessage: string;
}

function taskLabel(event: Pick<AutoDevEvent, "taskId" | "runId">): string {
  return event.taskId ?? event.runId;
}

const MAX_DISPLAY_REASON_LENGTH = 200;

/** event.reason을 Telegram 표시용으로 안전하게 다듬는다 — secret-shape 값 제거는 이미
 *  observability-event.ts의 createEvent()가 저장 시점에 항상 수행했으므로(§
 *  redactSecretLikeText), 여기서는 순수 표시 목적의 방어적 변환만 한다: 줄바꿈을 공백으로
 *  접어 항상 한 줄로 만들고, 길이를 제한한다. 값이 없거나 공백뿐이면 undefined를 반환해
 *  호출부가 고정 fallback 문구를 쓰게 한다(§ 이 함수를 쓰는 notification type만 개별 문서
 *  참고 — 아무 notification type이나 이 함수로 event.reason을 노출하지 않는다). */
function boundedReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const singleLine = reason.replace(/\s+/g, " ").trim();
  if (singleLine.length === 0) return undefined;
  return singleLine.length > MAX_DISPLAY_REASON_LENGTH
    ? `${singleLine.slice(0, MAX_DISPLAY_REASON_LENGTH)}…`
    : singleLine;
}

const CONFIRM_TITLE = "⛔ [AutoDev] 사용자 확인 필요";
const CONFIRM_FOOTER = "다음 프로젝트 시작 가능: 아니오";

// 모든 메시지는 고정 템플릿 뼈대를 쓴다 — event의 자유 텍스트 필드는 원칙적으로 읽지 않고,
// boundedReason()을 거치는 RUN_BLOCKED/SELF_DEV_WAITING_HUMAN/SELF_DEV_TASK_FAILED만
// 예외다(§ 파일 상단 주석에서 그 세 reason이 왜 안전한지 소스 근거를 남겼다).
// testSummary.failed 같은 이미 집계된 숫자도 자유 텍스트가 아니다(§ observability-event.ts
// buildTestSummary).
const NOTIFICATION_CONTENT: Record<NotificationType, (event: AutoDevEvent) => NotificationContent> = {
  TASK_COMPLETED: (e) => ({
    title: "🟡 [AutoDev] 작업 단계 완료",
    shortMessage: `작업: ${taskLabel(e)}\n상태: 전체 작업 진행 중\n${CONFIRM_FOOTER}`,
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
    title: CONFIRM_TITLE,
    shortMessage: `작업: ${taskLabel(e)}\n사유: GPT 리뷰가 최종적으로 사람 확인을 요구했습니다.\n${CONFIRM_FOOTER}`,
  }),
  HUMAN_APPROVAL_REQUIRED: (e) => ({
    title: CONFIRM_TITLE,
    shortMessage: `작업: ${taskLabel(e)}\n사유: 사람 승인이 필요한 고위험 작업입니다.\n${CONFIRM_FOOTER}`,
  }),
  SECURITY_BLOCKED: (e) => ({
    title: CONFIRM_TITLE,
    shortMessage: `작업: ${taskLabel(e)}\n사유: 보안 게이트가 checkpoint를 차단했습니다.\n${CONFIRM_FOOTER}`,
  }),
  REVIEW_CYCLE_EXHAUSTED: (e) => ({
    title: CONFIRM_TITLE,
    shortMessage: `작업: ${taskLabel(e)}\n사유: REVISE 반복이 한도에 도달했습니다.\n${CONFIRM_FOOTER}`,
  }),
  RUN_BLOCKED: (e) => ({
    title: CONFIRM_TITLE,
    shortMessage: `작업: ${taskLabel(e)}\n사유: ${boundedReason(e.reason) ?? "실행이 차단되어 중단되었습니다."}\n${CONFIRM_FOOTER}`,
  }),
  SELF_DEV_WAITING_HUMAN: (e) => ({
    title: CONFIRM_TITLE,
    shortMessage: `작업: ${taskLabel(e)}\n사유: ${boundedReason(e.reason) ?? "사용자 확인이 필요한 상태입니다."}(Telegram 원격 승인으로 재개할 수 없습니다)\n${CONFIRM_FOOTER}`,
  }),
  FINAL_COMPLETED: (e) => ({
    title: "✅ [AutoDev] 최종 완료",
    shortMessage: `작업: ${taskLabel(e)}\n결과: 모든 필수 검증 통과\n최종보고: 완료\n다음 프로젝트 시작 가능: 예`,
  }),
  DEPLOYMENT_WAITING_HUMAN: (e) => ({
    title: CONFIRM_TITLE,
    shortMessage: `작업: ${taskLabel(e)}\n사유: 모든 자동 Task가 완료되어 실제 배포는 사람이 직접 트리거해야 합니다.\n${CONFIRM_FOOTER}`,
  }),
  SELF_DEV_TASK_FAILED: (e) => ({
    title: "❌ [AutoDev] 최종 미완료",
    shortMessage: `작업: ${taskLabel(e)}\n사유: ${boundedReason(e.reason) ?? "완료 조건을 충족하지 못했습니다."}\n${CONFIRM_FOOTER}`,
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
  // Phase G Task G7.5 — production의 "진짜 최종 완료"/"배포 대기"는 TASK_COMPLETED와
  // 시점이 다른 별도 event다(§ 파일 상단 주석 — state 저장/administrative commit 성공
  // *이후*에만 발생, autodev.ts). self-dev의 "진짜 최종 완료"는 별도 event가 아니라
  // TASK_COMPLETED.metadata.completionScope로 표현되므로(§ classifyEventForNotification
  // 아래) 여기 없다.
  PROJECT_COMPLETED: "FINAL_COMPLETED",
  DEPLOYMENT_WAITING_HUMAN: "DEPLOYMENT_WAITING_HUMAN",
  SELF_DEV_TASK_FAILED: "SELF_DEV_TASK_FAILED",
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
  let type: NotificationType | undefined = EVENT_TO_NOTIFICATION_TYPE[event.eventType];

  // Phase G Task G7.5 — TASK_COMPLETED(하위 Task/subtask)는 기본값이지만, 이 event 자체가
  // "이 task 완료 직후 상위 작업이 확정될 예정/이미 확정됐다"는 사실을 이미 알고 있으면
  // (§ autodev.ts/self-dev-completion.ts가 채우는 metadata.completionScope) 다르게
  // 처리한다:
  //   - "PENDING_FINAL"/"PENDING_DEPLOYMENT_GATE"(production) — 이 event 자체는 알림을
  //     만들지 않는다. production의 최종 판정은 project-state.json 저장 + administrative
  //     commit이 실제로 성공한 *이후*에만 별도 event(PROJECT_COMPLETED/
  //     DEPLOYMENT_WAITING_HUMAN)로 알린다 — "TASK_COMPLETED 발생 → 최종 완료 Telegram
  //     → 그 뒤 최종 검증/보고" 순서를 구조적으로 금지한다(§ 요구사항 5). 그렇게 하지
  //     않으면 같은 task에 대해 🟡와 ✅/⛔ 두 알림이 동시에 나가 사용자를 혼란스럽게 만든다.
  //   - "FINAL"(self-dev --final) — self-dev는 이 TASK_COMPLETED 자체가 이미 "완료
  //     evidence 재검증 + 최종 보고 생성 이후" 시점에만 기록되므로(§
  //     self-dev-completion.ts recordSelfDevTaskCompleted), 별도 event 없이 곧바로
  //     FINAL_COMPLETED로 승격한다.
  if (event.eventType === "TASK_COMPLETED") {
    const scope = event.metadata?.completionScope;
    if (scope === "PENDING_FINAL" || scope === "PENDING_DEPLOYMENT_GATE") return undefined;
    if (scope === "FINAL") type = "FINAL_COMPLETED";
  }

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
