import { loadState } from "./state";
import type { CoreState } from "./types";
import type { AutoDevEvent, AutoDevEventInput } from "./observability-event";
import type { EventStore } from "./event-store";
import { classifyEventForNotification } from "./notification";
import { buildApprovalRequest, isApprovalExpired, parseApprovalCallbackData } from "./approval";
import type { ApprovalRequest } from "./approval";
import type { ApprovalStore } from "./approval-store";
import type { TelegramAllowlistConfig, TelegramCallbackQuery, TelegramUpdate } from "./telegram-callback-client";
import { answerTelegramCallbackQuery, verifyCallbackSender } from "./telegram-callback-client";
import { performAutoResume } from "./auto-resume";
import type { AutoResumeOutcome } from "./auto-resume";
import type { ProjectManifest } from "./project-manifest";
import type { OrchestratorDeps } from "./orchestrator";

// Approval Orchestration — Phase G Task G6.
//
// 두 가지 흐름을 배선한다:
//   1) createApprovalRequestsFromEvents — EventStore의 event → (notification.ts가 이미
//      G5에서 만든 판정을 그대로 재사용) → requiresHumanAction인 것만 ApprovalRequest로
//      승격. 새 분류 로직을 만들지 않는다(§ notification.ts classifyEventForNotification
//      단일 출처 재사용).
//   2) handleTelegramCallbackUpdate — Telegram callback 수신 → 발신자 검증 → approval
//      조회/replay/expiry/stale 검증 → REJECT/DEFER는 결정만 기록, APPROVE만 (다시 한 번
//      독립적으로 재검증하는) auto-resume.ts를 통해 안전한 경우에만 실행으로 이어진다.
//
// 이 파일은 어떤 판정도 새로 만들지 않는다 — approval.ts(분류/정책)와 auto-resume.ts(안전
// 재검사+실행)를 순서대로 호출할 뿐이다.

// ---------------------------------------------------------------------------
// 1) Event → ApprovalRequest
// ---------------------------------------------------------------------------

export interface CreateApprovalsOptions {
  now?: () => Date;
  expiryMs?: number;
  /** Auto Resume Git Safety recheck의 기준값(§ approval.ts ApprovalRequest.expectedGitHead/
   *  expectedBranch) — 호출부(telegram-controller.ts)가 이 batch를 처리하는 시점에
   *  git-changes.ts로 조회해 넘긴다(이 파일은 git을 직접 조회하지 않는다). */
  expectedGitHead?: string;
  expectedBranch?: string;
  eventStore?: EventStore;
}

export interface CreateApprovalsResult {
  created: ApprovalRequest[];
}

export function createApprovalRequestsFromEvents(
  events: AutoDevEvent[],
  approvalStore: ApprovalStore,
  opts: CreateApprovalsOptions = {}
): CreateApprovalsResult {
  const created: ApprovalRequest[] = [];
  for (const event of events) {
    const notification = classifyEventForNotification(event);
    if (!notification || !notification.requiresHumanAction) continue;
    // RUN_BLOCKED는 항상 더 구체적인 event(HUMAN_APPROVAL_REQUIRED/SECURITY_BLOCKED/
    // REVIEW_CYCLE_EXHAUSTED/REVIEW_BLOCKED)와 같은 batch에 짝을 이뤄 나오는 run-level
    // bookend일 뿐이다(§ autodev.ts) — 같은 차단에 두 번째 버튼 세트를 만들지 않는다.
    if (notification.notificationType === "RUN_BLOCKED") continue;
    // Phase G Task G7.3.2 — self-dev informational-only WAITING_HUMAN(§ self-dev-terminal-
    // status.ts). self-dev Claude Code 세션에는 production runAutodevOnce()의 실제
    // resumable action이 없으므로, 여기서 걸러내지 않으면 실제로 동작하지 않는 승인
    // 버튼이 생길 수 있다(요구사항이 명시적으로 금지) — ApprovalRequest 자체를 만들지
    // 않는다(버튼이 안 보이는 것만으로는 부족하다, § telegram-approval-provider.ts와는
    // 별개로 store에 request가 0건이어야 한다).
    if (notification.notificationType === "SELF_DEV_WAITING_HUMAN") continue;

    if (approvalStore.getByDedupeKey(notification.dedupeKey)) continue;

    const request = buildApprovalRequest(event, notification.dedupeKey, {
      now: opts.now,
      expiryMs: opts.expiryMs,
      expectedGitHead: opts.expectedGitHead,
      expectedBranch: opts.expectedBranch,
    });
    const stored = approvalStore.createPending(request);
    if (stored.approvalId !== request.approvalId) continue; // 다른 곳에서 이미 만들어짐(idempotent)

    created.push(stored);
    opts.eventStore?.append({
      eventType: "APPROVAL_REQUESTED",
      runId: stored.runId,
      projectId: stored.projectId,
      taskId: stored.taskId,
      metadata: { approvalType: stored.approvalType, remotelyApprovable: stored.remotelyApprovable },
    });
  }
  return { created };
}

// ---------------------------------------------------------------------------
// 2) Telegram callback → 검증 → REJECT/DEFER 기록 또는 (안전할 때만) Auto Resume
// ---------------------------------------------------------------------------

export type HandleCallbackOutcomeKind =
  | "IGNORED_NOT_CALLBACK"
  | "UNAUTHORIZED"
  | "MALFORMED"
  | "UNKNOWN_APPROVAL"
  | "EXPIRED"
  | "ALREADY_CONSUMED"
  | "STALE"
  | "REMOTE_NOT_ALLOWED"
  | "REJECTED"
  | "DEFERRED"
  | "APPROVED";

export interface HandleCallbackResult {
  kind: HandleCallbackOutcomeKind;
  approvalId?: string;
  autoResume?: AutoResumeOutcome;
}

const ANSWER_TEXT: Record<Exclude<HandleCallbackOutcomeKind, "IGNORED_NOT_CALLBACK">, string> = {
  UNAUTHORIZED: "이 요청을 처리할 권한이 없습니다.",
  MALFORMED: "요청 형식을 확인할 수 없습니다.",
  UNKNOWN_APPROVAL: "승인 요청을 찾을 수 없습니다.",
  EXPIRED: "승인 요청이 만료되었습니다.",
  ALREADY_CONSUMED: "이미 처리된 승인입니다.",
  STALE: "현재 상태가 변경되어 승인할 수 없습니다.",
  REMOTE_NOT_ALLOWED: "이 작업은 원격 승인으로 진행할 수 없습니다 — PC에서 직접 확인하세요.",
  REJECTED: "승인 거절됨.",
  DEFERRED: "나중에 처리하도록 보류했습니다.",
  APPROVED: "승인 접수됨.",
};

export interface HandleCallbackContext {
  approvalStore: ApprovalStore;
  manifest: ProjectManifest;
  allowlist: TelegramAllowlistConfig;
  eventStore?: EventStore;
  now?: () => Date;
  fetchImpl?: typeof fetch;
  botToken?: string;
  answerTimeoutMs?: number;
  statePath?: string;
  cwd?: string;
  /** 테스트 전용 — auto-resume.ts AutoResumeOptions.orchestratorDeps로 그대로 통과된다(§
   *  auto-resume.ts 주석과 동일한 seam). production 호출부(telegram-controller.ts)는 이
   *  필드를 지정하지 않는다. */
  orchestratorDeps?: OrchestratorDeps;
}

function emit(ctx: HandleCallbackContext, input: AutoDevEventInput): void {
  ctx.eventStore?.append(input);
}

async function answer(ctx: HandleCallbackContext, callbackQueryId: string, text: string): Promise<void> {
  const botToken = ctx.botToken ?? process.env.AUTODEV_TELEGRAM_BOT_TOKEN;
  if (!botToken) return;
  const fetchImpl = ctx.fetchImpl ?? fetch;
  try {
    await answerTelegramCallbackQuery(fetchImpl, botToken, callbackQueryId, text, ctx.answerTimeoutMs);
  } catch {
    // answerCallbackQuery는 이미 예외를 던지지 않지만(§ telegram-callback-client.ts),
    // 방어적으로 한 번 더 감싼다 — 이 시점에는 승인 판정 자체가 이미 끝나 있다.
  }
}

/** 승인 생성 시점과 지금 사이 task가 이미 끝났거나 현재 상태가 예상과 달라졌는지 확인한다
 *  (§ 요구사항 9) — auto-resume.ts가 실행 직전에 한 번 더 독립적으로 재확인하므로, 여기서의
 *  확인은 "명백히 stale한 요청을 조기에 걸러내는" 1차 방어선이다. */
function checkApprovalStale(approval: ApprovalRequest, statePath: string): string | undefined {
  let state: CoreState;
  try {
    state = loadState(statePath);
  } catch {
    return "STATE_UNREADABLE";
  }
  if (approval.taskId && (state.completedTasks ?? []).includes(approval.taskId)) {
    return "TASK_ALREADY_COMPLETED";
  }
  if ((state.status as unknown as string) !== "WAITING_HUMAN") {
    return `UNEXPECTED_STATE(${state.status})`;
  }
  return undefined;
}

function isCallbackQuery(update: TelegramUpdate): update is TelegramUpdate & { callback_query: TelegramCallbackQuery } {
  return update.callback_query !== undefined;
}

export async function handleTelegramCallbackUpdate(update: TelegramUpdate, ctx: HandleCallbackContext): Promise<HandleCallbackResult> {
  if (!isCallbackQuery(update)) return { kind: "IGNORED_NOT_CALLBACK" };
  const cq = update.callback_query;
  const nowIso = (ctx.now ? ctx.now() : new Date()).toISOString();
  const statePath = ctx.statePath ?? ctx.manifest.statePath;

  const verification = verifyCallbackSender(cq, ctx.allowlist);
  if (!verification.ok) {
    emit(ctx, {
      eventType: "APPROVAL_UNAUTHORIZED",
      runId: "UNKNOWN_SENDER",
      metadata: { reason: verification.reason ?? "UNKNOWN" },
    });
    await answer(ctx, cq.id, ANSWER_TEXT.UNAUTHORIZED);
    return { kind: "UNAUTHORIZED" };
  }

  if (!cq.data) {
    await answer(ctx, cq.id, ANSWER_TEXT.MALFORMED);
    return { kind: "MALFORMED" };
  }
  const parsed = parseApprovalCallbackData(cq.data);
  if (!parsed) {
    await answer(ctx, cq.id, ANSWER_TEXT.MALFORMED);
    return { kind: "MALFORMED" };
  }

  // approvalId는 절대 신뢰하지 않는다 — 실제 store 조회로만 존재/상태를 판단한다(§
  // 요구사항 23, callback forgery 방어).
  const approval = ctx.approvalStore.get(parsed.approvalId);
  if (!approval) {
    await answer(ctx, cq.id, ANSWER_TEXT.UNKNOWN_APPROVAL);
    return { kind: "UNKNOWN_APPROVAL" };
  }

  emit(ctx, {
    eventType: "APPROVAL_RECEIVED",
    runId: approval.runId,
    projectId: approval.projectId,
    taskId: approval.taskId,
    metadata: { action: parsed.action, approvalType: approval.approvalType },
  });

  if (approval.status !== "PENDING") {
    await answer(ctx, cq.id, ANSWER_TEXT.ALREADY_CONSUMED);
    return { kind: "ALREADY_CONSUMED", approvalId: approval.approvalId };
  }

  if (isApprovalExpired(approval, nowIso)) {
    ctx.approvalStore.transition(approval.approvalId, "EXPIRED", nowIso);
    emit(ctx, { eventType: "APPROVAL_EXPIRED", runId: approval.runId, projectId: approval.projectId, taskId: approval.taskId });
    await answer(ctx, cq.id, ANSWER_TEXT.EXPIRED);
    return { kind: "EXPIRED", approvalId: approval.approvalId };
  }

  if (parsed.action === "APPROVE" && !approval.remotelyApprovable) {
    await answer(ctx, cq.id, ANSWER_TEXT.REMOTE_NOT_ALLOWED);
    return { kind: "REMOTE_NOT_ALLOWED", approvalId: approval.approvalId };
  }

  if (parsed.action === "APPROVE") {
    const staleReason = checkApprovalStale(approval, statePath);
    if (staleReason) {
      ctx.approvalStore.transition(approval.approvalId, "INVALIDATED", nowIso);
      emit(ctx, {
        eventType: "APPROVAL_STALE",
        runId: approval.runId,
        projectId: approval.projectId,
        taskId: approval.taskId,
        reason: staleReason,
      });
      await answer(ctx, cq.id, ANSWER_TEXT.STALE);
      return { kind: "STALE", approvalId: approval.approvalId };
    }
  }

  if (parsed.action === "REJECT") {
    const t = ctx.approvalStore.transition(approval.approvalId, "REJECTED", nowIso);
    if (!t.ok) {
      await answer(ctx, cq.id, ANSWER_TEXT.ALREADY_CONSUMED);
      return { kind: "ALREADY_CONSUMED", approvalId: approval.approvalId };
    }
    emit(ctx, { eventType: "APPROVAL_REJECTED", runId: approval.runId, projectId: approval.projectId, taskId: approval.taskId });
    await answer(ctx, cq.id, ANSWER_TEXT.REJECTED);
    return { kind: "REJECTED", approvalId: approval.approvalId };
  }

  if (parsed.action === "DEFER") {
    const t = ctx.approvalStore.transition(approval.approvalId, "DEFERRED", nowIso);
    if (!t.ok) {
      await answer(ctx, cq.id, ANSWER_TEXT.ALREADY_CONSUMED);
      return { kind: "ALREADY_CONSUMED", approvalId: approval.approvalId };
    }
    emit(ctx, { eventType: "APPROVAL_DEFERRED", runId: approval.runId, projectId: approval.projectId, taskId: approval.taskId });
    await answer(ctx, cq.id, ANSWER_TEXT.DEFERRED);
    return { kind: "DEFERRED", approvalId: approval.approvalId };
  }

  // APPROVE — PENDING→APPROVED 단일 CAS. 두 번째 클릭(동시 replay)은 여기서 ok:false로
  // 걸러진다.
  const consumed = ctx.approvalStore.transition(approval.approvalId, "APPROVED", nowIso);
  if (!consumed.ok) {
    await answer(ctx, cq.id, ANSWER_TEXT.ALREADY_CONSUMED);
    return { kind: "ALREADY_CONSUMED", approvalId: approval.approvalId };
  }
  emit(ctx, { eventType: "APPROVAL_APPROVED", runId: approval.runId, projectId: approval.projectId, taskId: approval.taskId });
  emit(ctx, { eventType: "AUTO_RESUME_STARTED", runId: approval.runId, projectId: approval.projectId, taskId: approval.taskId });

  const approvedRequest = consumed.request ?? { ...approval, status: "APPROVED" as const };
  const resumed = await performAutoResume(approvedRequest, ctx.manifest, {
    statePath: ctx.statePath,
    cwd: ctx.cwd,
    events: ctx.eventStore,
    ...(ctx.orchestratorDeps ? { orchestratorDeps: ctx.orchestratorDeps } : {}),
  });

  if (resumed.kind === "BLOCKED") {
    emit(ctx, {
      eventType: "AUTO_RESUME_BLOCKED",
      runId: approval.runId,
      projectId: approval.projectId,
      taskId: approval.taskId,
      reason: resumed.reason,
    });
    await answer(ctx, cq.id, `${ANSWER_TEXT.APPROVED} (재개 보류: 현재 상태에서 안전하게 진행할 수 없습니다)`);
  } else {
    emit(ctx, { eventType: "AUTO_RESUME_COMPLETED", runId: approval.runId, projectId: approval.projectId, taskId: approval.taskId });
    await answer(ctx, cq.id, ANSWER_TEXT.APPROVED);
  }

  return { kind: "APPROVED", approvalId: approval.approvalId, autoResume: resumed };
}
