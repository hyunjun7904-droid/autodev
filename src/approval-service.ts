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
import { loadProjectAdapter } from "./project-adapter-loader";
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

export interface GitExpectationForEvent {
  expectedGitHead?: string;
  expectedBranch?: string;
}

export interface CreateApprovalsOptions {
  now?: () => Date;
  expiryMs?: number;
  /** Auto Resume Git Safety recheck의 기준값(§ approval.ts ApprovalRequest.expectedGitHead/
   *  expectedBranch) — resolveGitExpectation이 지정되지 않았을 때만 모든 event에 그대로
   *  쓰인다(기존 단일-project 호출부/테스트와의 하위호환 전용 — 새 호출부는 아래
   *  resolveGitExpectation을 쓴다). */
  expectedGitHead?: string;
  expectedBranch?: string;
  eventStore?: EventStore;
  /** Multi-Project Approval Isolation(2026-09-01) — 지정하면 event마다 이 함수로 Git Safety
   *  recheck 기준값을 개별적으로 계산한다(§ 요구사항 — installation-wide controller owner
   *  project의 Git metadata를 다른 project event에 섞어 쓰지 않는다). 이 파일은 여전히 git을
   *  직접 조회하지 않는다(§ 파일 상단 주석) — 실제 조회/adapterPath 재해석은 호출부
   *  (telegram-controller.ts)가 담당한다. undefined를 반환하면 "이 event의 project context를
   *  안전하게 확정하지 못했다"는 뜻이며, 그 event는 이번 tick에서 approval을 만들지 않고
   *  건너뛴다(owner project 값으로 대체하지 않는다 — fail-closed, 다음 tick에 다시 시도). */
  resolveGitExpectation?: (event: AutoDevEvent) => GitExpectationForEvent | undefined;
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
    // Phase G Task G7.5 — production task-registry가 모두 끝났지만 마지막 task가
    // isHumanGate라 실제 배포를 사람이 직접 트리거해야 하는 상태다. 이 파이프라인에는
    // "배포를 원격으로 승인/실행"하는 resumable action이 없으므로(§ 요구사항 — 실제
    // 배포는 사람 몫), SELF_DEV_WAITING_HUMAN과 동일한 이유로 ApprovalRequest 자체를
    // 만들지 않는다.
    if (notification.notificationType === "DEPLOYMENT_WAITING_HUMAN") continue;

    if (approvalStore.getByDedupeKey(notification.dedupeKey)) continue;

    // Multi-Project Approval Isolation(2026-09-01) — resolveGitExpectation이 지정됐으면
    // 이 event 하나만의 project context로 Git 기준값을 새로 계산한다. undefined가 돌아오면
    // (project context를 안전하게 확정하지 못함) owner project의 batch 값으로 대체하지
    // 않고 이 event는 이번 tick에서 건너뛴다 — dedupeKey 기준 idempotent 재스캔이므로 다음
    // tick이 다시 시도한다.
    let gitExpectation: GitExpectationForEvent;
    if (opts.resolveGitExpectation) {
      const resolved = opts.resolveGitExpectation(event);
      if (!resolved) continue;
      gitExpectation = resolved;
    } else {
      gitExpectation = { expectedGitHead: opts.expectedGitHead, expectedBranch: opts.expectedBranch };
    }

    const request = buildApprovalRequest(event, notification.dedupeKey, {
      now: opts.now,
      expiryMs: opts.expiryMs,
      expectedGitHead: gitExpectation.expectedGitHead,
      expectedBranch: gitExpectation.expectedBranch,
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
  | "APPROVED"
  // Multi-Project Approval Isolation(2026-09-01) — 이 approval이 owner project와 다른
  // project에 속하는데, 그 project의 진짜 manifest를 안전하게 resolve하지 못했다(§
  // resolveApprovalProjectContext). owner project의 manifest/statePath/cwd로 대체하지 않고
  // fail-closed로 거부한다 — approval 자체는 PENDING으로 그대로 남는다(재시도 가능).
  | "PROJECT_CONTEXT_UNRESOLVED";

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
  PROJECT_CONTEXT_UNRESOLVED: "이 요청이 속한 프로젝트를 안전하게 확인할 수 없습니다 — PC에서 직접 확인하세요.",
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
  /** 테스트 전용 override — § resolveApprovalProjectContext. 지정하지 않으면 실제
   *  loadProjectAdapter()(project-adapter-loader.ts)를 그대로 쓴다. */
  loadProjectAdapter?: typeof loadProjectAdapter;
}

// ---------------------------------------------------------------------------
// Multi-Project Approval Isolation(2026-09-01) — DEFECT 2 수정.
// ---------------------------------------------------------------------------

export interface ResolvedApprovalProjectContext {
  manifest: ProjectManifest;
  statePath: string;
  cwd: string;
}

/**
 * 이 approval이 실제로 속한 project의 manifest/statePath/cwd를 안전하게 resolve한다 —
 * installation-wide Telegram controller owner의 manifest/statePath/cwd(ctx.manifest/
 * ctx.statePath/ctx.cwd)를 다른 project 처리에 fallback으로 쓰지 않는다(§ 요구사항 invariant
 * B). approval.projectId가 controller owner와 같으면(대부분의 단일-project 운용, 그리고
 * approval.projectId가 없는 구형 레코드) 기존 owner 경로를 그대로 쓴다 — 동작 변화 없음.
 * 다르면(cross-project) approval.adapterPath(§ approval.ts, event를 만든 project 자신이
 * 채운 값)로 loadProjectAdapter()(이미 검증된 유일한 project 진입점, 새 registry를 만들지
 * 않는다)를 다시 호출해 그 project의 진짜 manifest를 복원하고, 복원된 manifest.projectId가
 * approval.projectId와 실제로 일치하는지도 재확인한다(방어적 이중 확인). 이 중 하나라도
 * 실패/불확실하면 undefined를 반환한다 — 호출부는 owner 값으로 대체하지 않고 fail-closed로
 * 처리해야 한다.
 */
export function resolveApprovalProjectContext(
  approval: ApprovalRequest,
  ctx: Pick<HandleCallbackContext, "manifest" | "statePath" | "cwd" | "loadProjectAdapter">
): ResolvedApprovalProjectContext | undefined {
  const ownerStatePath = ctx.statePath ?? ctx.manifest.statePath;
  const ownerCwd = ctx.cwd ?? ctx.manifest.targetProjectRoot;
  if (approval.projectId === undefined || approval.projectId === ctx.manifest.projectId) {
    return { manifest: ctx.manifest, statePath: ownerStatePath, cwd: ownerCwd };
  }
  if (!approval.adapterPath) return undefined;
  const load = ctx.loadProjectAdapter ?? loadProjectAdapter;
  let resolved: ProjectManifest;
  try {
    resolved = load(approval.adapterPath);
  } catch {
    return undefined;
  }
  if (resolved.projectId !== approval.projectId) return undefined;
  return { manifest: resolved, statePath: resolved.statePath, cwd: resolved.targetProjectRoot };
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

  // Multi-Project Approval Isolation(2026-09-01) — DEFECT 2. REJECT/DEFER는 project별
  // state/git을 전혀 건드리지 않으므로(순수 ApprovalStore CAS) project context가 필요
  // 없다 — 이 resolve는 APPROVE에만 관여한다. owner project와 다른데 안전하게 resolve하지
  // 못하면 owner의 manifest/statePath/cwd로 대체하지 않고 즉시 fail-closed로 거부한다 —
  // approval 상태는 바꾸지 않는다(PENDING 그대로, 나중에 다시 시도 가능).
  let projectCtx: ResolvedApprovalProjectContext | undefined;
  if (parsed.action === "APPROVE") {
    projectCtx = resolveApprovalProjectContext(approval, ctx);
    if (!projectCtx) {
      emit(ctx, {
        eventType: "APPROVAL_STALE",
        runId: approval.runId,
        projectId: approval.projectId,
        taskId: approval.taskId,
        reason: "PROJECT_CONTEXT_UNRESOLVED",
      });
      await answer(ctx, cq.id, ANSWER_TEXT.PROJECT_CONTEXT_UNRESOLVED);
      return { kind: "PROJECT_CONTEXT_UNRESOLVED", approvalId: approval.approvalId };
    }
  }

  if (parsed.action === "APPROVE") {
    const staleReason = checkApprovalStale(approval, projectCtx!.statePath);
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
  // Multi-Project Approval Isolation(2026-09-01) — projectCtx는 이 지점에 도달했다는 사실
  // 자체로 이미 위에서 resolve됐다(APPROVE 분기, 실패 시 이미 return됨) — owner project의
  // manifest/statePath/cwd가 아니라 이 approval이 실제로 속한 project의 값을 쓴다.
  const resumed = await performAutoResume(approvedRequest, projectCtx!.manifest, {
    statePath: projectCtx!.statePath,
    cwd: projectCtx!.cwd,
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
