import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NotificationMessage } from "./notification";
import { isProductionRuntime } from "./runtime-origin";

// Notification Store — Delivery Bookkeeping Only (Phase G Task G5).
//
// EventStore(event-store.ts)의 append-only audit 원장과 역할을 혼동하지 않는다 — 이 파일은
// "이 notification을 실제로 전달했는가"만 추적하는 mutable 소규모 store다. Audit 기록은
// 여전히 EventStore(NOTIFICATION_CREATED/NOTIFICATION_DELIVERED/NOTIFICATION_FAILED, §
// notification-service.ts)가 전담하고, 이 store는 그 audit 원장을 대체하지 않는다 — 이
// store가 손상되거나 비워져도 EventStore의 event 기록 자체는 전혀 영향받지 않는다(둘은
// 독립적인 저장소다).
//
// dedupe 판정의 단일 출처: dedupeKey가 이미 store에 있으면 createPending()은 아무것도
// 새로 만들지 않고 기존 레코드를 그대로 반환한다 — "같은 알림을 두 번 PENDING으로
// 덮어쓰지 않는다"(§ 요구사항: 매 polling마다 같은 알림이 반복되면 안 됨).

export type NotificationDeliveryStatus = "PENDING" | "DELIVERED" | "FAILED";

export interface NotificationDeliveryRecord {
  notification: NotificationMessage;
  deliveryStatus: NotificationDeliveryStatus;
  attemptCount: number;
  lastError?: string;
  lastAttemptAt?: string;
  deliveredAt?: string;
}

export interface NotificationStoreListFilter {
  runId?: string;
  deliveryStatus?: NotificationDeliveryStatus;
}

export interface NotificationStore {
  has(dedupeKey: string): boolean;
  get(dedupeKey: string): NotificationDeliveryRecord | undefined;
  createPending(notification: NotificationMessage): NotificationDeliveryRecord;
  recordDeliverySuccess(dedupeKey: string, deliveredAt: string): void;
  recordDeliveryFailure(dedupeKey: string, error: string, attemptedAt: string): void;
  list(filter?: NotificationStoreListFilter): NotificationDeliveryRecord[];
}

function matchesFilter(record: NotificationDeliveryRecord, filter: NotificationStoreListFilter): boolean {
  if (filter.runId !== undefined && record.notification.runId !== filter.runId) return false;
  if (filter.deliveryStatus !== undefined && record.deliveryStatus !== filter.deliveryStatus) return false;
  return true;
}

function cloneRecord(record: NotificationDeliveryRecord): NotificationDeliveryRecord {
  return { ...record, notification: { ...record.notification } };
}

/** 메모리 기반 store — 프로세스 생존 동안만 유지된다(테스트/dry-run 용도). get()/list()가
 *  반환하는 레코드는 항상 얕은 복사본이다(event-store.ts의 query()와 동일한 방어 — 호출부가
 *  반환값을 수정해도 저장된 원본은 바뀌지 않는다). */
export function createInMemoryNotificationStore(): NotificationStore {
  const records = new Map<string, NotificationDeliveryRecord>();

  return {
    has(dedupeKey) {
      return records.has(dedupeKey);
    },
    get(dedupeKey) {
      const record = records.get(dedupeKey);
      return record ? cloneRecord(record) : undefined;
    },
    createPending(notification) {
      const existing = records.get(notification.dedupeKey);
      if (existing) return cloneRecord(existing);
      const record: NotificationDeliveryRecord = { notification, deliveryStatus: "PENDING", attemptCount: 0 };
      records.set(notification.dedupeKey, record);
      return cloneRecord(record);
    },
    recordDeliverySuccess(dedupeKey, deliveredAt) {
      const existing = records.get(dedupeKey);
      if (!existing) return;
      records.set(dedupeKey, {
        ...existing,
        deliveryStatus: "DELIVERED",
        attemptCount: existing.attemptCount + 1,
        lastAttemptAt: deliveredAt,
        deliveredAt,
        lastError: undefined,
      });
    },
    recordDeliveryFailure(dedupeKey, error, attemptedAt) {
      const existing = records.get(dedupeKey);
      if (!existing) return;
      records.set(dedupeKey, {
        ...existing,
        deliveryStatus: "FAILED",
        attemptCount: existing.attemptCount + 1,
        lastAttemptAt: attemptedAt,
        lastError: error,
      });
    },
    list(filter = {}) {
      return Array.from(records.values())
        .filter((r) => matchesFilter(r, filter))
        .map(cloneRecord);
    },
  };
}

interface NotificationStoreFile {
  records: NotificationDeliveryRecord[];
}

function readStoreFile(filePath: string): NotificationStoreFile {
  if (!existsSync(filePath)) return { records: [] };
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as NotificationStoreFile;
    return Array.isArray(parsed.records) ? parsed : { records: [] };
  } catch {
    // 손상된 파일을 정상 기록인 것처럼 취급하지 않는다 — 빈 store로 취급하고 다음 저장이
    // 정상 내용으로 덮어쓴다. Audit(EventStore)과 달리 이 store는 bookkeeping 전용이라
    // integrityIssues 같은 정교한 손상 보고 체계를 두지 않는다(요구사항 범위 밖).
    return { records: [] };
  }
}

function writeStoreFile(filePath: string, data: NotificationStoreFile): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

/** 파일 기반 store — logs/notifications.json에 전체 레코드를 JSON으로 다시 쓴다
 *  (event-store.ts의 append-only JSONL과 의도적으로 다른 구조다 — 이 store는 mutable
 *  bookkeeping이라 기존 레코드 갱신 자체가 정상 동작이다. state.ts의 loadState/saveState와
 *  동일한 "필요할 때 전체 읽기 → 수정 → 전체 쓰기" 패턴을 그대로 따른다). 매 호출마다
 *  디스크에서 다시 읽으므로 여러 프로세스(예: 향후 polling 프로세스와 production run)가
 *  같은 파일을 봐도 재시작 후에도 dedupe 상태가 유지된다. */
export function createFileNotificationStore(filePath: string): NotificationStore {
  function load(): Map<string, NotificationDeliveryRecord> {
    return new Map(readStoreFile(filePath).records.map((r) => [r.notification.dedupeKey, r]));
  }
  function save(records: Map<string, NotificationDeliveryRecord>): void {
    writeStoreFile(filePath, { records: Array.from(records.values()) });
  }

  return {
    has(dedupeKey) {
      return load().has(dedupeKey);
    },
    get(dedupeKey) {
      return load().get(dedupeKey);
    },
    createPending(notification) {
      const records = load();
      const existing = records.get(notification.dedupeKey);
      if (existing) return existing;
      const record: NotificationDeliveryRecord = { notification, deliveryStatus: "PENDING", attemptCount: 0 };
      records.set(notification.dedupeKey, record);
      save(records);
      return record;
    },
    recordDeliverySuccess(dedupeKey, deliveredAt) {
      const records = load();
      const existing = records.get(dedupeKey);
      if (!existing) return;
      records.set(dedupeKey, {
        ...existing,
        deliveryStatus: "DELIVERED",
        attemptCount: existing.attemptCount + 1,
        lastAttemptAt: deliveredAt,
        deliveredAt,
        lastError: undefined,
      });
      save(records);
    },
    recordDeliveryFailure(dedupeKey, error, attemptedAt) {
      const records = load();
      const existing = records.get(dedupeKey);
      if (!existing) return;
      records.set(dedupeKey, {
        ...existing,
        deliveryStatus: "FAILED",
        attemptCount: existing.attemptCount + 1,
        lastAttemptAt: attemptedAt,
        lastError: error,
      });
      save(records);
    },
    list(filter = {}) {
      return Array.from(load().values()).filter((r) => matchesFilter(r, filter));
    },
  };
}

// event-store.ts의 RUNTIME_EVENT_LOG_PATH와 동일한 위치 계산(__dirname 기준) — AutoDev
// 자신의 runtime data이지 target project repo 안이 아니다. logs/는 이미 .gitignore에 있어
// git commit 대상이 되지 않는다.
export const RUNTIME_NOTIFICATION_STORE_PATH = join(__dirname, "..", "logs", "notifications.json");

/** event-store.ts의 selectDefaultEventStore()와 동일한 관례 — isProductionRuntime()(§
 *  runtime-origin.ts)이 참일 때만 실제 파일 기반 store를 쓴다(2026-08-22 incident 이후
 *  AUTOMATION_DRY_RUN 단독 판정에서 dual-gate로 강화됨). */
export function selectDefaultNotificationStore(filePath: string = RUNTIME_NOTIFICATION_STORE_PATH): NotificationStore {
  return isProductionRuntime() ? createFileNotificationStore(filePath) : createInMemoryNotificationStore();
}

// ---------------------------------------------------------------------------
// Dashboard 연결 seam(§ 요구사항: 향후 Dashboard가 "알림 필요/승인 필요/최근 알림" 정도를
// 표시할 수 있도록 읽기 전용 query 제공) — 실제 Dashboard UI(dashboard-server.ts/
// dashboard-html.ts)는 이 Task 범위 밖이라 건드리지 않는다. 이 함수는 어떤 상태도 바꾸지
// 않는 순수 조회다.
// ---------------------------------------------------------------------------

export interface NotificationDashboardSummary {
  pendingCount: number;
  actionRequiredPendingCount: number;
  /** 최신순(createdAt 내림차순) 최근 알림 — 기본 5건. */
  recent: NotificationMessage[];
}

export function summarizeNotificationsForDashboard(
  store: NotificationStore,
  opts: { runId?: string; recentLimit?: number } = {}
): NotificationDashboardSummary {
  const records = store.list(opts.runId !== undefined ? { runId: opts.runId } : undefined);
  const pending = records.filter((r) => r.deliveryStatus === "PENDING");
  const limit = opts.recentLimit ?? 5;
  const recent = records
    .slice()
    .sort((a, b) => Date.parse(b.notification.createdAt) - Date.parse(a.notification.createdAt))
    .slice(0, limit)
    .map((r) => r.notification);

  return {
    pendingCount: pending.length,
    actionRequiredPendingCount: pending.filter((r) => r.notification.requiresHumanAction).length,
    recent,
  };
}
