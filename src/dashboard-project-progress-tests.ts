import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeProjectProgress, loadProjectProgress } from "./dashboard-project-progress";
import type { TaskDefinition } from "./task-registry";

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

// JARVIS 실제 규모(22 phases/113 tasks)를 흉내낸 것이 아니라, "숫자를 화면 코드에 고정하지
// 않는다"를 증명하기 위해 일부러 그와 다른 임의 규모(3 phases/5 tasks)의 fixture registry를
// 쓴다 — 계산 결과가 이 fixture 데이터에서 나온 값과 정확히 일치해야 한다.
const FIXTURE_REGISTRY: TaskDefinition[] = [
  { id: "1.1", phase: 1, taskNumber: 1, title: "Phase1 Task1", prompt: "p", requiredTests: [], allowedPathPrefixes: [], prohibitedOperations: [] },
  { id: "1.2", phase: 1, taskNumber: 2, title: "Phase1 Task2", prompt: "p", requiredTests: [], allowedPathPrefixes: [], prohibitedOperations: [] },
  { id: "2.1", phase: 2, taskNumber: 1, title: "Phase2 Task1", prompt: "p", requiredTests: [], allowedPathPrefixes: [], prohibitedOperations: [] },
  { id: "2.2", phase: 2, taskNumber: 2, title: "Phase2 Task2", prompt: "p", requiredTests: [], allowedPathPrefixes: [], prohibitedOperations: [] },
  { id: "3.1", phase: 3, taskNumber: 1, title: "Phase3 Task1(final)", prompt: "p", requiredTests: [], allowedPathPrefixes: [], prohibitedOperations: [] },
];

function scenarioComputesFromFixtureDataNotHardcoded(): void {
  const progress = computeProjectProgress("Fixture Project", FIXTURE_REGISTRY, ["1.1", "1.2"]);
  check("전체 단계 수가 fixture registry에서 계산됨(3)", progress.totalPhases === 3);
  check("전체 작업 수가 fixture registry에서 계산됨(5)", progress.totalTasks === 5);
  check("완료 작업 수가 completedTasks에서 계산됨(2)", progress.completedTaskCount === 2);
  check("현재 작업이 다음 미완료 task(2.1)로 계산됨", progress.currentTaskId === "2.1");
  check("다음 작업이 그 다음 task(2.2)로 계산됨", progress.nextTaskId === "2.2");
  check("전체 진행률이 2/5=40%로 계산됨", progress.overallProgressPercent === 40);
  check("현재 단계(phase 2)의 작업 수가 계산됨(2)", progress.currentPhaseTaskCount === 2);
  check("현재 단계 완료 수가 계산됨(0)", progress.currentPhaseCompletedCount === 0);
  check("현재 단계 진행률이 0%로 계산됨", progress.currentPhaseProgressPercent === 0);
}

function scenarioAllTasksCompletedHasNoCurrentOrNextTask(): void {
  const progress = computeProjectProgress("Fixture Project", FIXTURE_REGISTRY, ["1.1", "1.2", "2.1", "2.2", "3.1"]);
  check("모든 task 완료 시 currentTaskId 없음", progress.currentTaskId === undefined);
  check("모든 task 완료 시 nextTaskId 없음", progress.nextTaskId === undefined);
  check("모든 task 완료 시 진행률 100%", progress.overallProgressPercent === 100);
}

function scenarioDifferentRegistryProducesDifferentNumbers(): void {
  const smallerRegistry: TaskDefinition[] = FIXTURE_REGISTRY.slice(0, 2);
  const progress = computeProjectProgress("Smaller Fixture", smallerRegistry, []);
  check("다른 registry(2개 task)를 주면 다른 숫자가 나옴(하드코딩 아님)", progress.totalTasks === 2 && progress.totalPhases === 1);
}

// ---------------------------------------------------------------------------
// loadProjectProgress — AUTODEV_PROJECT_ADAPTER 미설정/설정 두 경로
// ---------------------------------------------------------------------------
function scenarioNoAdapterConfiguredReturnsHonestFailure(): void {
  const result = loadProjectProgress(undefined);
  check("adapter 경로가 없으면 ok:false로 정직하게 실패함(추측 안 함)", result.ok === false);
}

function scenarioLoadsFromRealProjectAdapterConfig(): void {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-progress-tests-"));
  try {
    mkdirSync(join(dir, "project", ".autodev"), { recursive: true });
    const stateContent = {
      currentTask: null,
      reviewCycle: 0,
      lastClaudeResult: null,
      lastGptDecision: null,
      status: "READY",
      claudeLimitWaitCount: 0,
      deferredHumanTasks: [],
      completedTasks: ["1.1"],
      gitCheckpoint: "",
      currentPhase: 1,
    };
    writeFileSync(join(dir, "project", ".autodev", "project-state.json"), JSON.stringify(stateContent), "utf-8");

    const registryWithPathPrefixes = FIXTURE_REGISTRY.map((t) => ({ ...t, allowedPathPrefixes: ["proj/"] }));
    const adapterConfig = {
      projectId: "fixture-adapter-project",
      projectName: "Fixture Adapter Project",
      targetProjectRoot: "project",
      statePath: "project/.autodev/project-state.json",
      taskRegistry: registryWithPathPrefixes,
      developerInstructions: "x",
      reviewInstructions: "x",
      reviewScopeDirs: ["proj/"],
      executionPolicy: {
        allowedReadPrefixes: ["fixture/"],
        allowedWritePrefixes: ["fixture/"],
        allowedCommands: [],
      },
    };
    const adapterPath = join(dir, "adapter.json");
    writeFileSync(adapterPath, JSON.stringify(adapterConfig), "utf-8");

    const result = loadProjectProgress(adapterPath);
    check("실제 project adapter config를 읽으면 ok:true", result.ok === true);
    if (result.ok) {
      check("projectName이 adapter config에서 읽힘", result.progress.projectName === "Fixture Adapter Project");
      check("completedTasks(1개)가 project-state.json에서 읽힘", result.progress.completedTaskCount === 1);
      check("currentTaskId가 다음 미완료 task로 계산됨(1.2)", result.progress.currentTaskId === "1.2");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function scenarioInvalidAdapterPathFailsHonestly(): void {
  const result = loadProjectProgress("/no/such/path/adapter.json");
  check("존재하지 않는 adapter 경로는 예외를 던지지 않고 ok:false로 처리됨", result.ok === false);
}

function main(): void {
  scenarioComputesFromFixtureDataNotHardcoded();
  scenarioAllTasksCompletedHasNoCurrentOrNextTask();
  scenarioDifferentRegistryProducesDifferentNumbers();
  scenarioNoAdapterConfiguredReturnsHonestFailure();
  scenarioLoadsFromRealProjectAdapterConfig();
  scenarioInvalidAdapterPathFailsHonestly();

  console.log("\n=== dashboard-project-progress 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
