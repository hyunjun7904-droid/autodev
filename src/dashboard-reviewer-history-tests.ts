import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileEventStore } from "./event-store";
import type { EventStore } from "./event-store";
import type { AutoDevEventInput } from "./observability-event";
import { buildReviewerHistory } from "./dashboard-reviewer-history";

// AutoDev Dashboard 멀티프로젝트 운영센터 개선 — dashboard-reviewer-history.ts 테스트.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeEventFilePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-dashboard-reviewer-history-"));
  tempDirs.push(dir);
  return join(dir, "events.jsonl");
}

function ev(overrides: Partial<AutoDevEventInput> & { eventType: AutoDevEventInput["eventType"]; runId: string }): AutoDevEventInput {
  return overrides;
}

function appendAll(store: EventStore, inputs: AutoDevEventInput[]): void {
  for (const i of inputs) store.append(i);
}

function scenarioEmptyWhenNoReviewEvents(): void {
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [ev({ eventType: "TASK_STARTED", runId: "r1", projectId: "p1", taskId: "T1" })]);
  const history = buildReviewerHistory(store.query().events, "p1");
  check("Reviewer 호출 없음: 빈 배열", history.length === 0);
}

function scenarioOrderedSequenceAcrossCalls(): void {
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [
    ev({ eventType: "REVIEW_REVISE", runId: "r1", projectId: "p1", taskId: "T1", reviseCycle: 1, model: { provider: "fireworks", name: "gpt-oss-120b" } }),
    ev({ eventType: "REVIEW_APPROVED", runId: "r1", projectId: "p1", taskId: "T1", reviseCycle: 2, model: { provider: "fireworks", name: "gpt-oss-120b" } }),
  ]);
  const history = buildReviewerHistory(store.query().events, "p1");
  check("2건 호출: 개수 일치", history.length === 2);
  check("1번째 호출 순번=1", history[0]?.sequenceNumber === 1);
  check("2번째 호출 순번=2", history[1]?.sequenceNumber === 2);
  check("1번째 결과=REVISE", history[0]?.result === "REVISE");
  check("2번째 결과=PASS", history[1]?.result === "PASS");
  check("서비스 표시명 매핑(Fireworks)", history[0]?.service === "Fireworks");
}

function scenarioProviderChangeDetected(): void {
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [
    ev({ eventType: "REVIEW_REVISE", runId: "r1", projectId: "p1", taskId: "T1", model: { provider: "fireworks", name: "m1" } }),
    ev({ eventType: "REVIEW_APPROVED", runId: "r1", projectId: "p1", taskId: "T1", model: { provider: "groq", name: "m2" } }),
  ]);
  const history = buildReviewerHistory(store.query().events, "p1");
  check("첫 호출: providerChangedFromPrevious=false", history[0]?.providerChangedFromPrevious === false);
  check("provider가 fireworks->groq로 바뀌면 true", history[1]?.providerChangedFromPrevious === true);
}

function scenarioProjectIsolation(): void {
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [
    ev({ eventType: "REVIEW_APPROVED", runId: "r1", projectId: "p1", taskId: "T1", model: { provider: "fireworks", name: "m1" } }),
    ev({ eventType: "REVIEW_APPROVED", runId: "r2", projectId: "p2", taskId: "T1", model: { provider: "groq", name: "m2" } }),
  ]);
  const historyP1 = buildReviewerHistory(store.query().events, "p1");
  const historyP2 = buildReviewerHistory(store.query().events, "p2");
  check("p1 이력에는 p1 호출만", historyP1.length === 1 && historyP1[0]?.provider === "fireworks");
  check("p2 이력에는 p2 호출만(다른 project와 섞이지 않음)", historyP2.length === 1 && historyP2[0]?.provider === "groq");
}

function scenarioEventsWithoutModelAreSkipped(): void {
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [ev({ eventType: "REVIEW_APPROVED", runId: "r1", projectId: "p1", taskId: "T1" })]);
  const history = buildReviewerHistory(store.query().events, "p1");
  check("model 정보 없는 event는 실제 호출로 표시하지 않음", history.length === 0);
}

function main(): void {
  try {
    scenarioEmptyWhenNoReviewEvents();
    scenarioOrderedSequenceAcrossCalls();
    scenarioProviderChangeDetected();
    scenarioProjectIsolation();
    scenarioEventsWithoutModelAreSkipped();
  } finally {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // 정리 실패는 테스트 결과에 영향 없음.
      }
    }
  }

  console.log("\n=== dashboard-reviewer-history 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
