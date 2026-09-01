import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileEventStore } from "./event-store";
import type { EventStore } from "./event-store";
import type { AutoDevEventInput } from "./observability-event";
import { buildDeveloperLifecycle } from "./dashboard-developer-lifecycle";

// AutoDev Dashboard 멀티프로젝트 운영센터 개선 — dashboard-developer-lifecycle.ts 테스트.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeEventFilePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-dashboard-developer-lifecycle-"));
  tempDirs.push(dir);
  return join(dir, "events.jsonl");
}

function ev(overrides: Partial<AutoDevEventInput> & { eventType: AutoDevEventInput["eventType"]; runId: string }): AutoDevEventInput {
  return overrides;
}

function appendAll(store: EventStore, inputs: AutoDevEventInput[]): void {
  for (const i of inputs) store.append(i);
}

function scenarioNoAttemptsYet(): void {
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [ev({ eventType: "RUN_STARTED", runId: "r1", projectId: "p1" })]);
  const lifecycle = buildDeveloperLifecycle(store.query().events, "p1", "T1");
  check("Developer 시작 event 없음: attempts 비어있음", lifecycle.attempts.length === 0);
  check("Developer 시작 event 없음: latest undefined", lifecycle.latest === undefined);
}

function scenarioRunningAttemptHasNoEnd(): void {
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [ev({ eventType: "TASK_STARTED", runId: "r1", projectId: "p1", taskId: "T1" })]);
  const lifecycle = buildDeveloperLifecycle(store.query().events, "p1", "T1");
  check("시작만 있음: attempt 1개", lifecycle.attempts.length === 1);
  check("시작만 있음: attemptNumber=1", lifecycle.latest?.attemptNumber === 1);
  check("시작만 있음: outcome=RUNNING(종료 event 없음)", lifecycle.latest?.outcome === "RUNNING");
  check("시작만 있음: endedAt 없음", lifecycle.latest?.endedAt === undefined);
}

function scenarioNormalEndViaTestCompleted(): void {
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [
    ev({ eventType: "TASK_STARTED", runId: "r1", projectId: "p1", taskId: "T1" }),
    ev({ eventType: "TEST_COMPLETED", runId: "r1", projectId: "p1", taskId: "T1", outcome: "SUCCESS" }),
  ]);
  const lifecycle = buildDeveloperLifecycle(store.query().events, "p1", "T1");
  check("TEST_COMPLETED로 종료: outcome=NORMAL_END", lifecycle.latest?.outcome === "NORMAL_END");
  check("TEST_COMPLETED로 종료: endedAt 채워짐", typeof lifecycle.latest?.endedAt === "string");
  check("TEST_COMPLETED로 종료: durationMs>=0", (lifecycle.latest?.durationMs ?? -1) >= 0);
  check("TEST_COMPLETED로 종료: exitReason 없음(정상 종료)", lifecycle.latest?.exitReason === undefined);
}

function scenarioAbnormalEndWithErrorCode(): void {
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [
    ev({ eventType: "TASK_STARTED", runId: "r1", projectId: "p1", taskId: "T1" }),
    ev({
      eventType: "HUMAN_APPROVAL_REQUIRED",
      runId: "r1",
      projectId: "p1",
      taskId: "T1",
      outcome: "BLOCKED",
      error: { code: "TIMEOUT", message: "timeout" },
      reason: "3회 재시도 소진",
    }),
  ]);
  const lifecycle = buildDeveloperLifecycle(store.query().events, "p1", "T1");
  check("HUMAN_APPROVAL_REQUIRED로 종료: outcome=ABNORMAL_END", lifecycle.latest?.outcome === "ABNORMAL_END");
  check("HUMAN_APPROVAL_REQUIRED로 종료: exitReason=TIMEOUT", lifecycle.latest?.exitReason === "TIMEOUT");
  check("HUMAN_APPROVAL_REQUIRED로 종료: exitDetail 반영", lifecycle.latest?.exitDetail === "3회 재시도 소진");
}

function scenarioMultipleAttemptsViaRetry(): void {
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [
    ev({ eventType: "TASK_STARTED", runId: "r1", projectId: "p1", taskId: "T1" }),
    ev({ eventType: "TEST_COMPLETED", runId: "r1", projectId: "p1", taskId: "T1", outcome: "SUCCESS" }),
    ev({ eventType: "REVIEW_REVISE", runId: "r1", projectId: "p1", taskId: "T1" }),
    ev({ eventType: "DEVELOPER_RETRY_STARTED", runId: "r1", projectId: "p1", taskId: "T1" }),
    ev({ eventType: "TEST_COMPLETED", runId: "r1", projectId: "p1", taskId: "T1", outcome: "SUCCESS" }),
  ]);
  const lifecycle = buildDeveloperLifecycle(store.query().events, "p1", "T1");
  check("REVISE 후 재시도: attempt 2개", lifecycle.attempts.length === 2);
  check("REVISE 후 재시도: attemptNumber 1,2", lifecycle.attempts[0]?.attemptNumber === 1 && lifecycle.attempts[1]?.attemptNumber === 2);
  check("REVISE 후 재시도: 둘 다 NORMAL_END", lifecycle.attempts.every((a) => a.outcome === "NORMAL_END"));
}

function scenarioTaskIsolation(): void {
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [
    ev({ eventType: "TASK_STARTED", runId: "r1", projectId: "p1", taskId: "T1" }),
    ev({ eventType: "TASK_STARTED", runId: "r1", projectId: "p1", taskId: "T2" }),
  ]);
  const lifecycleT1 = buildDeveloperLifecycle(store.query().events, "p1", "T1");
  const lifecycleT2 = buildDeveloperLifecycle(store.query().events, "p1", "T2");
  check("T1 조회: attempt 1개(다른 task와 섞이지 않음)", lifecycleT1.attempts.length === 1);
  check("T2 조회: attempt 1개(다른 task와 섞이지 않음)", lifecycleT2.attempts.length === 1);
  check("T1/T2 각각 attemptNumber=1(task별 독립 카운트)", lifecycleT1.latest?.attemptNumber === 1 && lifecycleT2.latest?.attemptNumber === 1);
}

function scenarioProjectIsolation(): void {
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [
    ev({ eventType: "TASK_STARTED", runId: "r1", projectId: "p1", taskId: "T1" }),
    ev({ eventType: "TASK_STARTED", runId: "r2", projectId: "p2", taskId: "T1" }),
  ]);
  const lifecycleP1 = buildDeveloperLifecycle(store.query().events, "p1", "T1");
  const lifecycleP2 = buildDeveloperLifecycle(store.query().events, "p2", "T1");
  check("p1/T1: attempt 1개(p2와 섞이지 않음)", lifecycleP1.attempts.length === 1);
  check("p2/T1: attempt 1개(p1과 섞이지 않음)", lifecycleP2.attempts.length === 1);
}

function main(): void {
  try {
    scenarioNoAttemptsYet();
    scenarioRunningAttemptHasNoEnd();
    scenarioNormalEndViaTestCompleted();
    scenarioAbnormalEndWithErrorCode();
    scenarioMultipleAttemptsViaRetry();
    scenarioTaskIsolation();
    scenarioProjectIsolation();
  } finally {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // 정리 실패는 테스트 결과에 영향 없음.
      }
    }
  }

  console.log("\n=== dashboard-developer-lifecycle 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
