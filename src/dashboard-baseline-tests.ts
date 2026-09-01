import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileEventStore } from "./event-store";
import type { EventStore } from "./event-store";
import type { AutoDevEventInput } from "./observability-event";
import { buildTaskBaseline, classifyTaskCategoryFromText } from "./dashboard-baseline";

// AutoDev Dashboard 멀티프로젝트 운영센터 개선 — dashboard-baseline.ts 테스트.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeEventFilePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-dashboard-baseline-"));
  tempDirs.push(dir);
  return join(dir, "events.jsonl");
}

function ev(overrides: Partial<AutoDevEventInput> & { eventType: AutoDevEventInput["eventType"]; runId: string }): AutoDevEventInput {
  return overrides;
}

function appendAll(store: EventStore, inputs: AutoDevEventInput[]): void {
  for (const i of inputs) store.append(i);
}

function scenarioCategoryClassification(): void {
  check("분류: undefined는 UNKNOWN", classifyTaskCategoryFromText(undefined) === "UNKNOWN");
  check("분류: '탐색' 포함 텍스트는 STRUCTURE_EXPLORATION", classifyTaskCategoryFromText("기존 구조를 탐색합니다") === "STRUCTURE_EXPLORATION");
  check("분류: '장애' 포함 텍스트는 INCIDENT_FORENSICS", classifyTaskCategoryFromText("장애 원인을 분석합니다") === "INCIDENT_FORENSICS");
  check("분류: 여러 키워드가 동시에 매칭되면 모호하므로 UNKNOWN", classifyTaskCategoryFromText("장애 발생 후 구조를 탐색합니다") === "UNKNOWN");
  check("분류: 관련 키워드가 전혀 없으면 UNKNOWN", classifyTaskCategoryFromText("아무 관련 없는 설명 텍스트") === "UNKNOWN");
}

function scenarioBaselineFromRealisticEventSequence(): void {
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [
    ev({ eventType: "TASK_STARTED", runId: "run-1", taskId: "T1", projectId: "p1" }),
    ev({
      eventType: "TEST_COMPLETED",
      runId: "run-1",
      taskId: "T1",
      projectId: "p1",
      outcome: "SUCCESS",
      model: { provider: "anthropic" },
      testSummary: { total: 3, passed: 3, failed: 0 },
    }),
    ev({ eventType: "REVIEW_REVISE", runId: "run-1", taskId: "T1", projectId: "p1", reviseCycle: 1, model: { provider: "fireworks", name: "m1" } }),
    ev({ eventType: "DEVELOPER_RETRY_STARTED", runId: "run-1", taskId: "T1", projectId: "p1" }),
    ev({
      eventType: "TEST_COMPLETED",
      runId: "run-1",
      taskId: "T1",
      projectId: "p1",
      outcome: "SUCCESS",
      model: { provider: "anthropic" },
      testSummary: { total: 3, passed: 3, failed: 0 },
    }),
    ev({ eventType: "REVIEW_APPROVED", runId: "run-1", taskId: "T1", projectId: "p1", reviseCycle: 2, model: { provider: "fireworks", name: "m1" } }),
  ]);
  const baseline = buildTaskBaseline(store.query().events, "p1", "T1", "단순 수정 작업");
  check("baseline: projectId/taskId 반영", baseline.projectId === "p1" && baseline.taskId === "T1");
  check("baseline: Developer 호출 2회(TASK_STARTED + DEVELOPER_RETRY_STARTED)", baseline.developerCallCount === 2);
  check("baseline: 둘 다 정상 종료", baseline.developerNormalEndCount === 2 && baseline.developerAbnormalEndCount === 0);
  check("baseline: Reviewer 호출 2회", baseline.reviewerCallCount === 2);
  check("baseline: fireworks 2회", baseline.reviewerCallCountByProvider.fireworks === 2);
  check("baseline: REVISE 1회", baseline.reviseCount === 1);
  check("baseline: 최종 결과 PASS", baseline.finalResult === "PASS");
  check("baseline: taskCategory=SIMPLE_EDIT(제목 근거)", baseline.taskCategory === "SIMPLE_EDIT");
}

function scenarioFinalResultUnknownWhenNotYetDecided(): void {
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [ev({ eventType: "TASK_STARTED", runId: "run-2", taskId: "T2", projectId: "p1" })]);
  const baseline = buildTaskBaseline(store.query().events, "p1", "T2");
  check("baseline: 아직 Reviewer 결정 없으면 finalResult=UNKNOWN(추측 금지)", baseline.finalResult === "UNKNOWN");
  check("baseline: 제목 없으면 taskCategory=UNKNOWN", baseline.taskCategory === "UNKNOWN");
}

function scenarioProjectAndTaskIsolation(): void {
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  appendAll(store, [
    ev({ eventType: "TASK_STARTED", runId: "run-a", taskId: "T1", projectId: "p1" }),
    ev({ eventType: "TASK_STARTED", runId: "run-b", taskId: "T1", projectId: "p2" }),
    ev({ eventType: "TASK_STARTED", runId: "run-c", taskId: "T2", projectId: "p1" }),
  ]);
  const baseline = buildTaskBaseline(store.query().events, "p1", "T1");
  check("baseline: 다른 project(p2)/다른 task(T2)의 Developer 호출이 섞이지 않음", baseline.developerCallCount === 1);
}

function main(): void {
  try {
    scenarioCategoryClassification();
    scenarioBaselineFromRealisticEventSequence();
    scenarioFinalResultUnknownWhenNotYetDecided();
    scenarioProjectAndTaskIsolation();
  } finally {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // 정리 실패는 테스트 결과에 영향 없음.
      }
    }
  }

  console.log("\n=== dashboard-baseline 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
