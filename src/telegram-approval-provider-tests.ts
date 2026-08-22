import { randomUUID } from "node:crypto";
import { sendTelegramApprovalAwareMessage, buildApprovalInlineKeyboard, createTelegramApprovalAwareProvider } from "./telegram-approval-provider";
import { createInMemoryApprovalStore } from "./approval-store";
import type { ApprovalStore } from "./approval-store";
import type { ApprovalRequest } from "./approval";
import { buildApprovalCallbackData } from "./approval";
import type { NotificationMessage } from "./notification";

// Telegram Approval-Aware Outbound Provider 테스트 — Phase G Task G6. 실제 Telegram 호출은
// 전혀 없다 — fetch는 항상 fake로 주입한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

interface CapturedCall {
  url: string;
  init?: RequestInit;
}
function createFakeFetch(): { fetch: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: typeof input === "string" ? input : input.toString(), init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

function msg(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    id: randomUUID(),
    createdAt: "2026-01-01T00:00:00.000Z",
    runId: "r1",
    taskId: "T1",
    notificationType: "HUMAN_APPROVAL_REQUIRED",
    severity: "ACTION_REQUIRED",
    title: "[AutoDev] 승인 필요",
    shortMessage: "Task T1에 사람 승인이 필요합니다.",
    requiresHumanAction: true,
    dedupeKey: "r1::T1::HUMAN_APPROVAL_REQUIRED::-",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: randomUUID(),
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: randomUUID(),
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:30:00.000Z",
    runId: "r1",
    taskId: "T1",
    approvalType: "ORCHESTRATOR_NOT_APPROVED_GENERIC",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: randomUUID(),
    status: "PENDING",
    remotelyApprovable: true,
    requiresSafetyRecheck: true,
    dedupeKey: "r1::T1::HUMAN_APPROVAL_REQUIRED::-",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildApprovalInlineKeyboard
// ---------------------------------------------------------------------------
function scenarioInlineKeyboardShape(): void {
  const id = randomUUID();
  const kb = buildApprovalInlineKeyboard(id);
  const flat = kb.inline_keyboard.flat();
  check("inline keyboard에 정확히 3개 버튼(승인/거절/보류)", flat.length === 3);
  check("APPROVE 버튼 callback_data 정확", flat.some((b) => b.callback_data === buildApprovalCallbackData(id, "APPROVE")));
  check("REJECT 버튼 callback_data 정확", flat.some((b) => b.callback_data === buildApprovalCallbackData(id, "REJECT")));
  check("DEFER 버튼 callback_data 정확", flat.some((b) => b.callback_data === buildApprovalCallbackData(id, "DEFER")));
}

// ---------------------------------------------------------------------------
// sendTelegramApprovalAwareMessage — 버튼을 붙이는 조건
// ---------------------------------------------------------------------------
async function scenarioButtonsAttachedWhenPendingAndRemotelyApprovable(): Promise<void> {
  const store: ApprovalStore = createInMemoryApprovalStore();
  const notification = msg();
  const a = approval({ dedupeKey: notification.dedupeKey, remotelyApprovable: true, status: "PENDING" });
  store.createPending(a);
  const { fetch: fetchImpl, calls } = createFakeFetch();
  const result = await sendTelegramApprovalAwareMessage({ botToken: "tok", chatId: "chat", fetchImpl }, store, notification, {
    now: () => "2026-01-01T00:00:00.000Z",
  });
  check("PENDING + remotelyApprovable=true 승인 -> 전송 성공", result.ok === true);
  const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
  check("이 경우에만 reply_markup(inline keyboard)이 붙음", body.reply_markup?.inline_keyboard?.flat().length === 3);
  check("버튼의 callback_data가 실제 approvalId를 담음", body.reply_markup.inline_keyboard[0][0].callback_data.includes(a.approvalId));
}
async function scenarioNoButtonsWhenNoMatchingApproval(): Promise<void> {
  const store: ApprovalStore = createInMemoryApprovalStore();
  const notification = msg({ dedupeKey: "no-approval-for-this-dedupe-key" });
  const { fetch: fetchImpl, calls } = createFakeFetch();
  await sendTelegramApprovalAwareMessage({ botToken: "tok", chatId: "chat", fetchImpl }, store, notification);
  const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
  check("대응하는 ApprovalRequest가 없으면 버튼 없음(일반 텍스트)", body.reply_markup === undefined);
}
async function scenarioNoButtonsWhenAlreadyConsumed(): Promise<void> {
  const store: ApprovalStore = createInMemoryApprovalStore();
  const notification = msg();
  const a = approval({ dedupeKey: notification.dedupeKey, remotelyApprovable: true, status: "PENDING" });
  store.createPending(a);
  store.transition(a.approvalId, "APPROVED", "2026-01-01T00:01:00.000Z");
  const { fetch: fetchImpl, calls } = createFakeFetch();
  await sendTelegramApprovalAwareMessage({ botToken: "tok", chatId: "chat", fetchImpl }, store, notification);
  const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
  check("이미 소비된(PENDING 아님) 승인은 버튼 없음", body.reply_markup === undefined);
}
async function scenarioNoButtonsWhenExpired(): Promise<void> {
  const store: ApprovalStore = createInMemoryApprovalStore();
  const notification = msg();
  const a = approval({ dedupeKey: notification.dedupeKey, remotelyApprovable: true, status: "PENDING", expiresAt: "2020-01-01T00:00:00.000Z" });
  store.createPending(a);
  const { fetch: fetchImpl, calls } = createFakeFetch();
  await sendTelegramApprovalAwareMessage({ botToken: "tok", chatId: "chat", fetchImpl }, store, notification, { now: () => "2026-01-01T00:00:00.000Z" });
  const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
  check("만료된 승인은 버튼 없음", body.reply_markup === undefined);
}
async function scenarioNoButtonsWhenNotRemotelyApprovable(): Promise<void> {
  const store: ApprovalStore = createInMemoryApprovalStore();
  const notification = msg({ notificationType: "SECURITY_BLOCKED", dedupeKey: "r1::T1::SECURITY_BLOCKED::-" });
  const a = approval({ dedupeKey: notification.dedupeKey, remotelyApprovable: false, approvalType: "SECURITY_BLOCKED", status: "PENDING" });
  store.createPending(a);
  const { fetch: fetchImpl, calls } = createFakeFetch();
  await sendTelegramApprovalAwareMessage({ botToken: "tok", chatId: "chat", fetchImpl }, store, notification, {
    now: () => "2026-01-01T00:00:00.000Z",
  });
  const body = JSON.parse(String(calls[0].init?.body ?? "{}"));
  check(
    "remotelyApprovable=false(SECURITY_BLOCKED 등)인 승인 요청은 APPROVE 버튼 자체를 제공하지 않음",
    body.reply_markup === undefined
  );
}
async function scenarioNotConfiguredReturnsError(): Promise<void> {
  const store: ApprovalStore = createInMemoryApprovalStore();
  const result = await sendTelegramApprovalAwareMessage({}, store, msg());
  check("botToken/chatId 미설정 -> TELEGRAM_NOT_CONFIGURED(가짜 성공 아님)", result.ok === false && !result.ok && result.error === "TELEGRAM_NOT_CONFIGURED");
}
async function scenarioProviderFactoryPlugsIntoNotificationProvider(): Promise<void> {
  const store: ApprovalStore = createInMemoryApprovalStore();
  const { fetch: fetchImpl } = createFakeFetch();
  const provider = createTelegramApprovalAwareProvider({ botToken: "tok", chatId: "chat", fetchImpl }, store);
  const result = await provider.send(msg());
  check("createTelegramApprovalAwareProvider()가 NotificationProvider 계약을 만족", result.ok === true);
}

async function main(): Promise<void> {
  scenarioInlineKeyboardShape();
  await scenarioButtonsAttachedWhenPendingAndRemotelyApprovable();
  await scenarioNoButtonsWhenNoMatchingApproval();
  await scenarioNoButtonsWhenAlreadyConsumed();
  await scenarioNoButtonsWhenExpired();
  await scenarioNoButtonsWhenNotRemotelyApprovable();
  await scenarioNotConfiguredReturnsError();
  await scenarioProviderFactoryPlugsIntoNotificationProvider();

  console.log("\n=== telegram-approval-provider.ts(G6) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
