import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createInMemoryNotificationStore,
  createFileNotificationStore,
  summarizeNotificationsForDashboard,
} from "./notification-store";
import type { NotificationStore } from "./notification-store";
import type { NotificationMessage, NotificationType } from "./notification";

// Notification Store 테스트(Phase G Task G5). EventStore(audit 원장)와 무관하게, delivery
// bookkeeping(dedupe/PENDING·DELIVERED·FAILED 상태 전이)만 검증한다. 실제 Claude/GPT 호출
// 없음, 실제 외부 notification 전송 없음.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-notification-store-"));
  tempDirs.push(dir);
  return dir;
}

function msg(overrides: Partial<NotificationMessage> & { runId: string; notificationType: NotificationType; dedupeKey: string }): NotificationMessage {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    severity: "INFO",
    title: "[AutoDev] 테스트",
    shortMessage: "테스트 메시지",
    requiresHumanAction: false,
    sourceEventType: "TASK_COMPLETED",
    sourceEventId: randomUUID(),
    ...overrides,
  };
}

function runStoreContract(label: string, makeStore: () => NotificationStore): void {
  // 1) createPending은 dedupeKey가 없으면 새 PENDING 레코드를 만든다.
  {
    const store = makeStore();
    const n = msg({ runId: "r1", notificationType: "TASK_COMPLETED", dedupeKey: "k1" });
    const record = store.createPending(n);
    check(`${label}: createPending 최초 호출 → PENDING`, record.deliveryStatus === "PENDING" && record.attemptCount === 0);
    check(`${label}: has(dedupeKey) === true`, store.has("k1") === true);
    check(`${label}: has(모르는 key) === false`, store.has("unknown") === false);
  }

  // 2) createPending은 이미 존재하는 dedupeKey를 덮어쓰지 않는다(§ dedupe).
  {
    const store = makeStore();
    const n1 = msg({ runId: "r1", notificationType: "TASK_COMPLETED", dedupeKey: "k2", shortMessage: "first" });
    const n2 = msg({ runId: "r1", notificationType: "TASK_COMPLETED", dedupeKey: "k2", shortMessage: "second" });
    store.createPending(n1);
    const record2 = store.createPending(n2);
    check(`${label}: createPending 재호출은 기존 레코드 유지(덮어쓰지 않음)`, record2.notification.shortMessage === "first");
  }

  // 3) recordDeliverySuccess.
  {
    const store = makeStore();
    const n = msg({ runId: "r1", notificationType: "TASK_COMPLETED", dedupeKey: "k3" });
    store.createPending(n);
    store.recordDeliverySuccess("k3", "2026-01-01T00:00:00.000Z");
    const record = store.get("k3");
    check(`${label}: recordDeliverySuccess → DELIVERED`, record?.deliveryStatus === "DELIVERED");
    check(`${label}: recordDeliverySuccess → attemptCount=1`, record?.attemptCount === 1);
    check(`${label}: recordDeliverySuccess → deliveredAt 기록`, record?.deliveredAt === "2026-01-01T00:00:00.000Z");
  }

  // 4) recordDeliveryFailure — 성공으로 위장하지 않는다.
  {
    const store = makeStore();
    const n = msg({ runId: "r1", notificationType: "SECURITY_BLOCKED", dedupeKey: "k4", severity: "CRITICAL", requiresHumanAction: true });
    store.createPending(n);
    store.recordDeliveryFailure("k4", "SMTP_TIMEOUT", "2026-01-01T00:00:01.000Z");
    const record = store.get("k4");
    check(`${label}: recordDeliveryFailure → FAILED(성공으로 위장 안 함)`, record?.deliveryStatus === "FAILED");
    check(`${label}: recordDeliveryFailure → lastError 기록`, record?.lastError === "SMTP_TIMEOUT");
    check(`${label}: recordDeliveryFailure → attemptCount=1`, record?.attemptCount === 1);

    store.recordDeliveryFailure("k4", "SMTP_TIMEOUT_2", "2026-01-01T00:00:02.000Z");
    const record2 = store.get("k4");
    check(`${label}: 두 번째 실패 → attemptCount=2(누적)`, record2?.attemptCount === 2);
  }

  // 5) list — runId/deliveryStatus 필터, 서로 다른 runId 혼합 금지.
  {
    const store = makeStore();
    store.createPending(msg({ runId: "run-a", notificationType: "TASK_COMPLETED", dedupeKey: "ka1" }));
    store.createPending(msg({ runId: "run-b", notificationType: "TASK_COMPLETED", dedupeKey: "kb1" }));
    store.recordDeliverySuccess("ka1", "2026-01-01T00:00:00.000Z");
    const runAOnly = store.list({ runId: "run-a" });
    check(`${label}: list({runId}) → 다른 run 혼합 없음`, runAOnly.length === 1 && runAOnly[0].notification.runId === "run-a");
    const pendingOnly = store.list({ deliveryStatus: "PENDING" });
    check(`${label}: list({deliveryStatus:PENDING}) → run-b만`, pendingOnly.length === 1 && pendingOnly[0].notification.runId === "run-b");
  }

  // 6) get()/list()가 반환하는 레코드는 복사본 — 외부에서 수정해도 store 원본은 안 바뀐다.
  {
    const store = makeStore();
    store.createPending(msg({ runId: "r1", notificationType: "TASK_COMPLETED", dedupeKey: "k6" }));
    const record = store.get("k6");
    if (record) record.deliveryStatus = "DELIVERED";
    check(`${label}: get() 결과는 복사본(외부 수정이 store에 반영 안 됨)`, store.get("k6")?.deliveryStatus === "PENDING");
  }
}

// ---------------------------------------------------------------------------
// 파일 기반 store — 프로세스 재시작을 흉내낸다(같은 파일 경로로 새 store 인스턴스 생성).
// ---------------------------------------------------------------------------
function scenarioFileStorePersistsAcrossInstances(): void {
  const dir = makeTempDir();
  const filePath = join(dir, "notifications.json");

  const store1 = createFileNotificationStore(filePath);
  store1.createPending(msg({ runId: "r1", notificationType: "TASK_COMPLETED", dedupeKey: "persist-1" }));
  store1.recordDeliverySuccess("persist-1", "2026-01-01T00:00:00.000Z");

  const store2 = createFileNotificationStore(filePath);
  check("file store: 재시작 후에도 dedupe 상태 유지(has)", store2.has("persist-1") === true);
  const record = store2.get("persist-1");
  check("file store: 재시작 후에도 DELIVERED 상태 유지", record?.deliveryStatus === "DELIVERED");
}

function scenarioFileStoreMissingFileIsEmpty(): void {
  const dir = makeTempDir();
  const filePath = join(dir, "does-not-exist.json");
  const store = createFileNotificationStore(filePath);
  check("file store: 파일이 없으면 빈 store로 취급(크래시 없음)", store.list().length === 0);
}

// ---------------------------------------------------------------------------
// Dashboard 연결 seam — 읽기 전용, store를 변경하지 않는다.
// ---------------------------------------------------------------------------
function scenarioDashboardSummary(): void {
  const store = createInMemoryNotificationStore();
  store.createPending(msg({ runId: "r1", notificationType: "TASK_COMPLETED", dedupeKey: "d1", requiresHumanAction: false, createdAt: "2026-01-01T00:00:00.000Z" }));
  store.createPending(
    msg({ runId: "r1", notificationType: "SECURITY_BLOCKED", dedupeKey: "d2", severity: "CRITICAL", requiresHumanAction: true, createdAt: "2026-01-01T00:00:05.000Z" })
  );
  store.recordDeliverySuccess("d1", "2026-01-01T00:00:01.000Z");

  const summary = summarizeNotificationsForDashboard(store, { runId: "r1" });
  check("dashboard summary: pendingCount=1(d1은 이미 DELIVERED)", summary.pendingCount === 1);
  check("dashboard summary: actionRequiredPendingCount=1(d2)", summary.actionRequiredPendingCount === 1);
  check("dashboard summary: recent 최신순 정렬(d2가 먼저)", summary.recent[0]?.dedupeKey === "d2");
  check("dashboard summary: 조회가 store를 변경하지 않음", store.list().length === 2);
}

async function main(): Promise<void> {
  try {
    runStoreContract("in-memory", createInMemoryNotificationStore);
    runStoreContract("file-backed", () => createFileNotificationStore(join(makeTempDir(), "notifications.json")));
    scenarioFileStorePersistsAcrossInstances();
    scenarioFileStoreMissingFileIsEmpty();
    scenarioDashboardSummary();
  } finally {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // 정리 실패는 테스트 결과에 영향 없음(OS 임시 디렉터리).
      }
    }
  }

  console.log("\n=== notification-store(G5) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
