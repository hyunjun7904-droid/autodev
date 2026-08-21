import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadState, saveState, DEFAULT_STATE_PATH } from "./state";
import { decideNextAction } from "./autodev";
import type { TaskDefinition } from "./task-registry";
import type { CoreState, ProjectState } from "./types";

// AutoDev 범용화 Phase A Task A5 — CoreState/프로젝트 전용 상태 분리 검증.
// Phase B Task B3 — 이 파일은 이제 어떤 특정 프로젝트(MOVAN 포함)의 확장 필드 타입도 import
// 하지 않는다. "프로젝트 전용 확장 필드"는 이 파일 안에서 스스로 정의한 fixture 타입
// (FixtureProjectExtension)으로만 증명한다 — 실제 프로젝트 어댑터는 각자 자신의 저장소에서
// 이 패턴을 그대로 재사용하면 된다.
//
// A) CoreState 필드 + 임의의 프로젝트 전용 확장 필드가 함께 있는 state JSON을 새 타입
//    (ProjectState/CoreState)으로 정상 load할 수 있다.
// B) 그 프로젝트 전용 확장 필드가 하나도 유실되지 않는다.
// C) CoreState 필드만 가진 작은 Fixture project state로 AutoDev 핵심 next-task 판단이 가능하다.
// D) 그 Fixture state가 프로젝트 전용 확장 필드를 요구하지 않는다(타입 레벨 — 아래 fixture는
//    `CoreState` 타입 그대로 선언되어 있고, 확장 필드를 하나도 갖지 않는다).
// E) state load/save round-trip 후 알 수 없는 project-specific 필드가 보존된다.
//
// 실제 automation/config/project-state.json(AutoDev 자신의 config)은 read-only 증거로만
// 쓴다 — 어떤 시나리오도 이 경로에 쓰지 않는다(끝에서 실행 전/후 내용 비교로 증명, §
// 요구사항 project-state 테스트 격리).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// A) / B) CoreState 필드와 함께 임의의 프로젝트 전용 확장 필드(FixtureProjectExtension)를
// 가진 state JSON을 loadState()로 읽어, 그 확장 필드가 하나도 유실되지 않았는지 원본 JSON과
// 값 단위로 대조한다. 이 확장 필드는 특정 프로젝트를 흉내내지 않는다 — 순수하게 "AutoDev
// Core가 모르는 프로젝트 전용 데이터"라는 사실만 증명하면 된다.
// ---------------------------------------------------------------------------
interface FixtureProjectExtension {
  projectLabel: string;
  featureFlagAllowed: boolean;
  appliedItems: string[];
  itemsImmutable: boolean;
  externalServiceConnected: boolean;
  productionActionAllowed: boolean;
  freeformNote: string;
}

function scenarioLoadExtendedStateAndCheckNoFieldLoss(): void {
  const dir = makeTempDir("autodev-core-state-load-");
  const tempPath = join(dir, "project-state.json");

  const original = {
    // CoreState 필드
    currentTask: null,
    reviewCycle: 2,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "READY",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: ["FXA1"],
    gitCheckpoint: "abc1234",
    currentPhase: 3,
    // 프로젝트 전용 확장 필드(FixtureProjectExtension) — Core가 이름을 모르는 데이터.
    projectLabel: "Fixture Extended Project",
    featureFlagAllowed: true,
    appliedItems: ["item-1", "item-2"],
    itemsImmutable: true,
    externalServiceConnected: false,
    productionActionAllowed: false,
    freeformNote: "Core가 읽지 않는 자유 서술 필드도 유실되면 안 된다.",
  };
  writeFileSync(tempPath, JSON.stringify(original, null, 2) + "\n", "utf-8");

  const loaded = loadState(tempPath) as unknown as ProjectState<FixtureProjectExtension>;
  check("A) 확장 필드를 포함한 project-state.json을 새 ProjectState 타입으로 정상 load", typeof loaded === "object" && loaded !== null);

  // CoreState 필드가 원본 값 그대로 읽힌다.
  check("A) CoreState 필드(completedTasks) 정상 로드", JSON.stringify(loaded.completedTasks) === JSON.stringify(original.completedTasks));
  check("A) CoreState 필드(status) 정상 로드", loaded.status === original.status);
  check("A) CoreState 필드(gitCheckpoint) 정상 로드", loaded.gitCheckpoint === original.gitCheckpoint);
  check("A) CoreState 필드(currentPhase) 정상 로드", loaded.currentPhase === original.currentPhase);

  // 프로젝트 전용 확장 필드(FixtureProjectExtension) — 하나도 유실되지 않아야 한다.
  const extensionFields: (keyof FixtureProjectExtension)[] = [
    "projectLabel",
    "featureFlagAllowed",
    "appliedItems",
    "itemsImmutable",
    "externalServiceConnected",
    "productionActionAllowed",
    "freeformNote",
  ];
  for (const field of extensionFields) {
    check(
      `B) 프로젝트 전용 확장 필드 '${field}' 유실 없이 그대로 로드됨`,
      JSON.stringify(loaded[field]) === JSON.stringify(original[field])
    );
  }
}

// ---------------------------------------------------------------------------
// C) / D) CoreState 필드만 가진 최소 Fixture project state로 decideNextAction()(AutoDev
// 핵심 next-task 판단)이 정상 동작한다. fixture는 CoreState 타입 그대로 선언되어 있으므로
// 프로젝트 전용 확장 필드를 하나도 갖지 않는다(TS가 그 사실 자체를 컴파일 시점에 강제한다
// — 타입에 없는 필드를 넣으면 컴파일 에러, 타입에 있는 필드가 빠지면 역시 컴파일 에러).
// ---------------------------------------------------------------------------
const FIXTURE_REGISTRY: TaskDefinition[] = [
  {
    id: "CORE1",
    phase: 1,
    taskNumber: 1,
    title: "core-only fixture task 1",
    prompt: "core-only fixture prompt 1",
    requiredTests: [],
    allowedPathPrefixes: ["fixture/"],
    prohibitedOperations: [],
  },
  {
    id: "CORE2",
    phase: 1,
    taskNumber: 2,
    title: "core-only fixture task 2",
    prompt: "core-only fixture prompt 2",
    requiredTests: [],
    allowedPathPrefixes: ["fixture/"],
    prohibitedOperations: [],
  },
];

function makeMinimalCoreStateFixture(overrides: Partial<CoreState> = {}): CoreState {
  return {
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "READY",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
    gitCheckpoint: "core-only-fixture",
    currentPhase: 1,
    ...overrides,
  };
}

function scenarioCoreOnlyFixtureDrivesNextTaskDecision(): void {
  const fixtureNoTasksDone = makeMinimalCoreStateFixture({ completedTasks: [] });
  check(
    "D) 프로젝트 전용 확장 필드가 fixture 객체에 하나도 없음(Object.keys에 확장 필드 부재)",
    !("projectLabel" in fixtureNoTasksDone) &&
      !("featureFlagAllowed" in fixtureNoTasksDone) &&
      !("appliedItems" in fixtureNoTasksDone) &&
      !("externalServiceConnected" in fixtureNoTasksDone)
  );

  const decision1 = decideNextAction(fixtureNoTasksDone, FIXTURE_REGISTRY);
  check("C) CoreState-only fixture: 완료 task 없음 → 첫 task(CORE1) 선택", decision1.kind === "RUN_TASK" && decision1.task.id === "CORE1");

  const fixtureFirstDone = makeMinimalCoreStateFixture({ completedTasks: ["CORE1"] });
  const decision2 = decideNextAction(fixtureFirstDone, FIXTURE_REGISTRY);
  check("C) CoreState-only fixture: CORE1 완료 → CORE2 선택", decision2.kind === "RUN_TASK" && decision2.task.id === "CORE2");

  const fixtureAllDone = makeMinimalCoreStateFixture({ completedTasks: ["CORE1", "CORE2"] });
  const decision3 = decideNextAction(fixtureAllDone, FIXTURE_REGISTRY);
  check("C) CoreState-only fixture: 전부 완료 → STOP(더 이상 자동 실행할 task 없음)", decision3.kind === "STOP");

  const fixtureWaitingHuman = makeMinimalCoreStateFixture({ status: "WAITING_HUMAN", completedTasks: [] });
  const decision4 = decideNextAction(fixtureWaitingHuman, FIXTURE_REGISTRY);
  check("C) CoreState-only fixture: WAITING_HUMAN 상태 → STOP", decision4.kind === "STOP");
}

// ---------------------------------------------------------------------------
// E) state load/save round-trip 후 알 수 없는 project-specific 필드가 보존된다. 여기서는
// CoreState 필드도 아니고 FixtureProjectExtension 필드도 아닌, 이 테스트만을 위한 임의의
// 프로젝트 전용 필드(예: 가상의 또 다른 프로젝트가 쓸 법한 필드)를 하나 심어서 왕복 후에도
// 그대로 남는지 확인한다 — 실제 automation/config/project-state.json은 전혀 건드리지 않는다.
// ---------------------------------------------------------------------------
function scenarioUnknownProjectFieldSurvivesRoundTrip(): void {
  const dir = makeTempDir("autodev-core-state-roundtrip-");
  const statePath = join(dir, "project-state.json");

  const UNKNOWN_FIELD_VALUE = { note: "또 다른 프로젝트 전용 확장 필드", count: 42 };
  const initial = {
    // CoreState 필드
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "IDLE",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
    gitCheckpoint: "roundtrip-fixture",
    currentPhase: 1,
    // 타입에 전혀 없는 임의의 프로젝트 전용 필드 — 이 필드의 존재를 loadState()/saveState()가
    // 몰라도 유실시키면 안 된다.
    anotherProjectOnlyField: UNKNOWN_FIELD_VALUE,
  };
  writeFileSync(statePath, JSON.stringify(initial, null, 2) + "\n", "utf-8");

  const loaded = loadState(statePath) as ProjectState & { anotherProjectOnlyField?: unknown };
  check(
    "E) load 직후 알 수 없는 필드(anotherProjectOnlyField)가 그대로 존재",
    JSON.stringify(loaded.anotherProjectOnlyField) === JSON.stringify(UNKNOWN_FIELD_VALUE)
  );

  // Core 필드만 수정한 뒤 저장 — 프로젝트 전용 필드는 건드리지 않는다(실제 orchestrator/
  // autodev 코드가 하는 것과 동일한 패턴).
  loaded.completedTasks = ["CORE1"];
  loaded.status = "READY";
  saveState(loaded, statePath);

  const reloadedRaw = JSON.parse(readFileSync(statePath, "utf-8")) as Record<string, unknown>;
  check(
    "E) save 이후 디스크에 기록된 JSON에도 알 수 없는 필드가 그대로 보존됨",
    JSON.stringify(reloadedRaw.anotherProjectOnlyField) === JSON.stringify(UNKNOWN_FIELD_VALUE)
  );
  check("E) Core 필드(completedTasks) 변경 사항은 정상 반영됨", JSON.stringify(reloadedRaw.completedTasks) === JSON.stringify(["CORE1"]));
  check("E) Core 필드(status) 변경 사항은 정상 반영됨", reloadedRaw.status === "READY");
}

function main(): void {
  const realStateBefore = readFileSync(DEFAULT_STATE_PATH, "utf-8");

  try {
    scenarioLoadExtendedStateAndCheckNoFieldLoss();
    scenarioCoreOnlyFixtureDrivesNextTaskDecision();
    scenarioUnknownProjectFieldSurvivesRoundTrip();
  } finally {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 디렉터리 정리 실패는 테스트 결과에 영향 없음
      }
    }
  }

  const realStateAfter = readFileSync(DEFAULT_STATE_PATH, "utf-8");
  check("project-state 격리: 실제 project-state.json이 테스트 실행 전후 완전히 동일함", realStateBefore === realStateAfter);

  console.log("\n=== core-state(CoreState/프로젝트 전용 상태 분리) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
