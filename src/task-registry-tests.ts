import { readFileSync } from "node:fs";
import { getNextTask, findTaskById, isProjectComplete } from "./task-registry";
import type { TaskDefinition } from "./task-registry";
import { MOVAN_TASK_REGISTRY } from "./project-registries/movan";
import { DEFAULT_STATE_PATH } from "./state";

// Phase A Task A3 — task-registry.ts(AutoDev Core 엔진: 타입 + 순수 함수)와
// project-registries/movan.ts(MOVAN 전용 데이터)의 분리를 검증한다.
//
// 이 파일은 실제 automation/config/project-state.json을 읽기만 하고(해시 비교 증거),
// 절대 쓰지 않는다 — getNextTask/findTaskById/isProjectComplete는 순수 함수이고, 이 파일도
// fixture registry/completedTasks만 메모리에서 다룬다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

// ---------------------------------------------------------------------------
// A) 기존 MOVAN_TASK_REGISTRY를 엔진에 주입하면 리팩터링 이전과 동일한 다음 task가 선택된다.
// ---------------------------------------------------------------------------
function scenarioMovanRegistryProducesSameNextTaskAsBefore(): void {
  check(
    "A) completedTasks=['13.1'] → 다음 task='13.2'",
    getNextTask(MOVAN_TASK_REGISTRY, ["13.1"])?.id === "13.2"
  );
  check(
    "A) completedTasks=['13.1','13.2'] → 다음 task='14.1'(Phase 전환)",
    getNextTask(MOVAN_TASK_REGISTRY, ["13.1", "13.2"])?.id === "14.1"
  );
  const allIds = MOVAN_TASK_REGISTRY.map((t) => t.id);
  check(
    "A) 전체 completedTasks(모든 id) → 다음 task 없음(null, registry 소진)",
    getNextTask(MOVAN_TASK_REGISTRY, allIds) === null
  );
  check(
    "A) 빈 completedTasks → 다음 task='13.1'(registry 첫 항목)",
    getNextTask(MOVAN_TASK_REGISTRY, [])?.id === "13.1"
  );
}

// ---------------------------------------------------------------------------
// B/C) 별도의 작은 fixture registry를 주입하면 그 registry만 쓰이고, MOVAN 데이터는
// 전혀 섞이지 않는다.
// ---------------------------------------------------------------------------
const FIXTURE_REGISTRY: TaskDefinition[] = [
  {
    id: "F1",
    phase: 1,
    taskNumber: 1,
    title: "fixture task 1",
    prompt: "fixture prompt 1",
    requiredTests: [],
    allowedPathPrefixes: ["fixture/"],
    prohibitedOperations: [],
  },
  {
    id: "F2",
    phase: 1,
    taskNumber: 2,
    title: "fixture task 2",
    prompt: "fixture prompt 2",
    requiredTests: [],
    allowedPathPrefixes: ["fixture/"],
    prohibitedOperations: [],
  },
];

function scenarioFixtureRegistryIsUsedInIsolation(): void {
  const first = getNextTask(FIXTURE_REGISTRY, []);
  check("B) fixture registry 주입 → 첫 task='F1'", first?.id === "F1");

  const second = getNextTask(FIXTURE_REGISTRY, ["F1"]);
  check("B) fixture registry에서 'F1' 완료 → 다음 task='F2'", second?.id === "F2");

  const done = getNextTask(FIXTURE_REGISTRY, ["F1", "F2"]);
  check("B) fixture registry 전부 완료 → 다음 task 없음(null)", done === null);

  // C) MOVAN registry의 id("13.1" 등)가 fixture 실행에 전혀 나타나지 않는다 — MOVAN
  // completedTasks를 그대로 fixture registry에 흘려보내도(둘 다 완료로 취급되지 않는 한)
  // fixture만의 항목이 그대로 선택되어야 한다(두 registry가 서로 다른 id 공간을 씀).
  const withUnrelatedCompleted = getNextTask(FIXTURE_REGISTRY, ["13.1", "13.2", "14.1"]);
  check(
    "C) MOVAN task id가 completedTasks에 섞여 있어도 fixture registry는 여전히 'F1'부터 선택(MOVAN 데이터가 fixture에 섞이지 않음)",
    withUnrelatedCompleted?.id === "F1"
  );
  check(
    "C) fixture registry 결과에 MOVAN 전용 task id('13.1' 등)가 나타나지 않음",
    !FIXTURE_REGISTRY.some((t) => MOVAN_TASK_REGISTRY.some((m) => m.id === t.id))
  );
}

// ---------------------------------------------------------------------------
// D) 빈 registry / project-complete 조건을 안전하게 처리한다(예외를 던지지 않음).
// ---------------------------------------------------------------------------
function scenarioEmptyAndCompletedRegistryHandledSafely(): void {
  let threw = false;
  let emptyResult: TaskDefinition | null = null;
  try {
    emptyResult = getNextTask([], []);
  } catch {
    threw = true;
  }
  check("D) 빈 registry에 대해 getNextTask가 예외를 던지지 않음", !threw);
  check("D) 빈 registry → 다음 task 없음(null)", emptyResult === null);
  check(
    "D) 빈 registry는 isProjectComplete()에서도 즉시 완료로 안전하게 처리됨",
    isProjectComplete([], { completedTasks: [] }) === true
  );

  check(
    "D) findTaskById — 존재하지 않는 id는 예외 없이 undefined",
    findTaskById(FIXTURE_REGISTRY, "NO_SUCH_ID") === undefined
  );
  check(
    "D) findTaskById — 빈 registry에서도 예외 없이 undefined",
    findTaskById([], "F1") === undefined
  );

  check(
    "D) isProjectComplete — MOVAN registry를 완료 목록 없이 주입하면 false(할 일이 남음)",
    isProjectComplete(MOVAN_TASK_REGISTRY, { completedTasks: [] }) === false
  );
  const allMovanIds = MOVAN_TASK_REGISTRY.map((t) => t.id);
  check(
    "D) isProjectComplete — MOVAN registry의 모든 id가 완료되면 true",
    isProjectComplete(MOVAN_TASK_REGISTRY, { completedTasks: allMovanIds }) === true
  );
}

// ---------------------------------------------------------------------------
// E) findTaskById/getNextTask/isProjectComplete가 전부 "주입된" registry로 동작한다
// (module 내부 전역 상태를 몰래 참조하지 않는다).
// ---------------------------------------------------------------------------
function scenarioAllThreeFunctionsUseInjectedRegistry(): void {
  check(
    "E) findTaskById(FIXTURE_REGISTRY, 'F2')가 fixture task를 반환(MOVAN에는 'F2'가 없음)",
    findTaskById(FIXTURE_REGISTRY, "F2")?.title === "fixture task 2"
  );
  check(
    "E) findTaskById(MOVAN_TASK_REGISTRY, '13.2')가 MOVAN task를 반환",
    findTaskById(MOVAN_TASK_REGISTRY, "13.2")?.title === "문서관리 UI 구현"
  );
  check(
    "E) MOVAN registry에서 찾을 수 없는 fixture id('F1')는 undefined",
    findTaskById(MOVAN_TASK_REGISTRY, "F1") === undefined
  );

  check(
    "E) getNextTask에 같은 completedTasks를 줘도 registry가 다르면 다른 결과",
    getNextTask(MOVAN_TASK_REGISTRY, [])?.id !== getNextTask(FIXTURE_REGISTRY, [])?.id
  );
}

function main(): void {
  const realStateBefore = readFileSync(DEFAULT_STATE_PATH, "utf-8");

  scenarioMovanRegistryProducesSameNextTaskAsBefore();
  scenarioFixtureRegistryIsUsedInIsolation();
  scenarioEmptyAndCompletedRegistryHandledSafely();
  scenarioAllThreeFunctionsUseInjectedRegistry();

  const realStateAfter = readFileSync(DEFAULT_STATE_PATH, "utf-8");
  check("project-state 격리: 실제 project-state.json이 테스트 실행 전후 완전히 동일함", realStateBefore === realStateAfter);

  console.log("\n=== task-registry(engine/data 분리) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
