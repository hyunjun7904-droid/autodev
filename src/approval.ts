import { randomUUID } from "node:crypto";
import type { AutoDevEvent, AutoDevEventType } from "./observability-event";

// Approval Request Model & Remote Approval Policy — Phase G Task G6.
//
// notification.ts(Phase G Task G5)의 NotificationMessage는 "사람에게 알려주는 것"이다.
// ApprovalRequest는 그와 구분되는 "사람의 결정이 필요한 실제 상태"다 — Telegram에서
// APPROVE 버튼을 눌렀다는 사실 자체가 실행 허가를 의미하지 않는다(§ 요구사항: Prompt
// omission is NOT permission relaxation). 이 파일은 그 결정 상태의 데이터 모델과, "이
// approvalType은 애초에 원격 APPROVE로 resume까지 이어질 수 있는 종류인가"를 판정하는
// deterministic Core 정책만 담는다 — 실제 Telegram 전송/수신/Auto Resume 실행은 이 파일이
// 전혀 모른다.
//
// fail-closed 원칙 — REMOTELY_APPROVABLE_APPROVAL_TYPES는 명시적으로 안전하다고 확인된
// approvalType만 담는 allow-list다(policy.ts의 ALWAYS_HUMAN Set과 동일한 Core hard rule
// 패턴 — 이 함수는 policy 인자를 받지 않는다, 어떤 project config도 이 판정을 넓힐 수
// 없다). 이 목록에 없는 approvalType은(UNKNOWN 포함) 항상 remotelyApprovable=false다.
//
// 이 저장소의 production event 모델(orchestrator.ts/autodev.ts)에서 "사람 승인이 필요하다"는
// 사실은 여러 이유로 발생하지만, HUMAN_APPROVAL_REQUIRED라는 하나의 eventType이 그 중 서로
// 안전도가 완전히 다른 여러 원인(고위험 작업 사전 게이트, checkpoint scope 위반, audit
// 저장소 장애, 그 외 orchestrator가 APPROVED로 끝나지 못한 일반적인 경우)을 모두
// 대표한다(§ autodev.ts 상단 주석 — 이 파일이 emitEvent()로 남기는 reason은 고정 템플릿
// 문자열이다, LLM 자유 출력이 아니다). classifyApprovalType()은 그 고정 템플릿을 근거로
// 서로 다른 원인을 구분한다 — 매칭되지 않는 reason은 전부 UNKNOWN으로 남기고 추측하지
// 않는다.
//
// Auto Resume은 "이 task를 처음부터 다시 시도한다"는 뜻이다(§ auto-resume.ts —
// runAutodevOnce()를 다시 호출할 뿐 어떤 Gate도 우회하지 않는다) — 그래서
// ORCHESTRATOR_NOT_APPROVED_GENERIC(Claude 구조적 실패/사용량 제한 소진/GPT 호출 상한
// 초과처럼 "다시 시도하면 그만인" 원인)만 원격 승인 가능하다. Security/Review/Git 관련
// 원인은 재시도해도 그 Gate가 다시 그대로 적용되므로 구조적으로는 우회되지 않지만, 이
// 요구사항은 "그 판단 자체를 사람이 직접 보고 내려야 한다"는 정책 결정이므로 원격 승인
// 자체를 허용하지 않는다(§ 요구사항 3 명시적 금지 목록).

export type ApprovalType =
  | "HIGH_RISK_ACTION_PREGATE"
  | "SECURITY_BLOCKED"
  | "REVIEW_CYCLE_EXHAUSTED"
  | "REVIEW_BLOCKED"
  | "CHECKPOINT_SCOPE_VIOLATION"
  | "AUDIT_STORE_UNAVAILABLE"
  | "ORCHESTRATOR_NOT_APPROVED_GENERIC"
  | "UNKNOWN";

const HIGH_RISK_PREGATE_PREFIX = "고위험 작업 감지(";
const AUDIT_STORE_UNAVAILABLE_PREFIX = "AUDIT_STORE_UNAVAILABLE_BEFORE_CHECKPOINT";
// human-gate-policy.ts가 checkpoint.ts의 실제 scope-violation 실패 사유와 이 값을
// 정확히 대조해 "기술적 자동 복구 대상"을 판정한다(단일 출처 — 값을 복제하지 않는다).
export const CHECKPOINT_SCOPE_VIOLATION_REASON = "예상치 못한 범위 밖 파일 변경이 있어 commit을 중단했습니다.";
const ORCHESTRATOR_STATUS_PREFIX = "orchestrator status=";

/** event.eventType + 고정 템플릿 reason만으로 approvalType을 판정한다(LLM 재분류 없음,
 *  순수 함수, 동일 입력에는 항상 동일 출력). 어디에도 매칭되지 않으면 UNKNOWN이다 — 새로운
 *  reason 문구가 추가되면(§ autodev.ts/orchestrator.ts 변경) 이 함수도 함께 갱신해야
 *  하며, 갱신 전까지는 안전한 기본값(UNKNOWN → 원격 승인 불가)으로 남는다. */
export function classifyApprovalType(event: Pick<AutoDevEvent, "eventType" | "reason">): ApprovalType {
  if (event.eventType === "SECURITY_BLOCKED") return "SECURITY_BLOCKED";
  if (event.eventType === "REVIEW_CYCLE_EXHAUSTED") return "REVIEW_CYCLE_EXHAUSTED";
  if (event.eventType === "REVIEW_BLOCKED") return "REVIEW_BLOCKED";
  if (event.eventType === "HUMAN_APPROVAL_REQUIRED") {
    const reason = event.reason ?? "";
    if (reason.startsWith(HIGH_RISK_PREGATE_PREFIX)) return "HIGH_RISK_ACTION_PREGATE";
    if (reason.startsWith(AUDIT_STORE_UNAVAILABLE_PREFIX)) return "AUDIT_STORE_UNAVAILABLE";
    if (reason === CHECKPOINT_SCOPE_VIOLATION_REASON) return "CHECKPOINT_SCOPE_VIOLATION";
    if (reason.startsWith(ORCHESTRATOR_STATUS_PREFIX)) return "ORCHESTRATOR_NOT_APPROVED_GENERIC";
    return "UNKNOWN";
  }
  return "UNKNOWN";
}

// Core hard rule — 이 목록에 항목을 추가/삭제할 수 있는 policy 인자가 이 파일 어디에도
// 없다(safe-executor.ts의 DENY_PATH_PATTERNS/SECRET_NAME_PATTERNS, policy.ts의
// ALWAYS_HUMAN과 동일한 패턴).
const REMOTELY_APPROVABLE_APPROVAL_TYPES: ReadonlySet<ApprovalType> = new Set<ApprovalType>([
  "ORCHESTRATOR_NOT_APPROVED_GENERIC",
]);

export function isRemotelyApprovable(approvalType: ApprovalType): boolean {
  return REMOTELY_APPROVABLE_APPROVAL_TYPES.has(approvalType);
}

export type ApprovalStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "DEFERRED"
  | "EXPIRED"
  | "INVALIDATED"
  | "CONSUMED";

export interface ApprovalRequest {
  approvalId: string;
  createdAt: string;
  expiresAt: string;
  projectId?: string;
  runId: string;
  taskId?: string;
  approvalType: ApprovalType;
  sourceEventType: AutoDevEventType;
  sourceEventId: string;
  status: ApprovalStatus;
  /** classifyApprovalType() + isRemotelyApprovable()로 생성 시점에 고정된다 — 이후 어떤
   *  호출부도 이 값을 다시 계산하거나 override하지 않는다(승인 처리 시점에는 그대로
   *  재확인만 한다, § approval-service.ts). */
  remotelyApprovable: boolean;
  /** 이 스키마 안에서는 항상 true — Auto Resume 직전에는 예외 없이 Git/state 재검사를
   *  거친다(§ auto-resume.ts). 향후 승인 종류별로 재검사 범위를 세분화할 여지를 위해 필드
   *  자체는 남겨둔다. */
  requiresSafetyRecheck: boolean;
  /** notification.ts의 NotificationMessage.dedupeKey와 동일한 값 — 같은 알림에 대해 두 번째
   *  ApprovalRequest를 새로 만들지 않는다(§ approval-store.ts createPending). */
  dedupeKey: string;
  /** Git Safety recheck(§ auto-resume.ts)가 "승인 생성 시점 이후 값이 바뀌었는가"를 판정할
   *  기준값 — git-changes.ts의 읽기 전용 helper로 생성 시점에 캡처한다. 알 수 없으면(HEAD
   *  조회 실패 등) undefined로 남기고 추측하지 않는다. */
  expectedGitHead?: string;
  expectedBranch?: string;
}

export const DEFAULT_APPROVAL_EXPIRY_MS = 30 * 60 * 1000; // 30분

export interface BuildApprovalRequestOptions {
  now?: () => Date;
  expiryMs?: number;
  expectedGitHead?: string;
  expectedBranch?: string;
}

/** notification-service.ts가 이미 분류한 NotificationMessage 하나에 대응하는 ApprovalRequest를
 *  만든다 — dedupeKey를 그대로 재사용해 "같은 알림 = 같은 승인 요청"을 보장한다(중복 분류
 *  로직을 새로 만들지 않는다, § approval-service.ts가 notification.ts의
 *  classifyEventForNotification()을 그대로 재사용하는 것과 짝을 이룬다). */
export function buildApprovalRequest(
  event: Pick<AutoDevEvent, "eventType" | "reason" | "runId" | "taskId" | "projectId" | "eventId">,
  notificationDedupeKey: string,
  opts: BuildApprovalRequestOptions = {}
): ApprovalRequest {
  const approvalType = classifyApprovalType(event);
  const now = opts.now ? opts.now() : new Date();
  const expiryMs = opts.expiryMs ?? DEFAULT_APPROVAL_EXPIRY_MS;
  return {
    approvalId: randomUUID(),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expiryMs).toISOString(),
    projectId: event.projectId,
    runId: event.runId,
    taskId: event.taskId,
    approvalType,
    sourceEventType: event.eventType,
    sourceEventId: event.eventId,
    status: "PENDING",
    remotelyApprovable: isRemotelyApprovable(approvalType),
    requiresSafetyRecheck: true,
    dedupeKey: notificationDedupeKey,
    ...(opts.expectedGitHead !== undefined ? { expectedGitHead: opts.expectedGitHead } : {}),
    ...(opts.expectedBranch !== undefined ? { expectedBranch: opts.expectedBranch } : {}),
  };
}

export function isApprovalExpired(approval: Pick<ApprovalRequest, "expiresAt">, nowIso: string): boolean {
  return Date.parse(nowIso) >= Date.parse(approval.expiresAt);
}

// ---------------------------------------------------------------------------
// Telegram callback_data — 짧은 opaque approvalId + action만 담는다(§ 요구사항: Bot
// Token/chatId/source/reason/project path/secret을 담지 않는다). 실제 검증(존재/PENDING/
// allowlist/expiry/remotelyApprovable/replay)은 이 값을 신뢰하지 않고 매번
// ApprovalStore에서 다시 조회한다(§ approval-service.ts) — 이 파일은 파싱만 한다.
// ---------------------------------------------------------------------------

export type ApprovalAction = "APPROVE" | "REJECT" | "DEFER";

const ACTION_TO_CODE: Record<ApprovalAction, string> = { APPROVE: "A", REJECT: "R", DEFER: "D" };
const CODE_TO_ACTION: Record<string, ApprovalAction> = { A: "APPROVE", R: "REJECT", D: "DEFER" };

export function buildApprovalCallbackData(approvalId: string, action: ApprovalAction): string {
  return `ap:${approvalId}:${ACTION_TO_CODE[action]}`;
}

export interface ParsedApprovalCallback {
  approvalId: string;
  action: ApprovalAction;
}

// approvalId는 randomUUID() 산출물만 허용한다(형식이 다르면 이미 malformed) — 이 정규식
// 자체가 approvalId를 "신뢰"하는 것은 아니다(형식만 검증할 뿐, 실제 존재/상태 확인은
// ApprovalStore가 한다).
const CALLBACK_PATTERN = /^ap:([0-9a-fA-F-]{8,64}):([ARD])$/;

export function parseApprovalCallbackData(data: string): ParsedApprovalCallback | null {
  const m = CALLBACK_PATTERN.exec(data);
  if (!m) return null;
  const action = CODE_TO_ACTION[m[2]];
  if (!action) return null;
  return { approvalId: m[1], action };
}
