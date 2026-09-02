import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProjectRegistry,
  discoverProjectsFromEvents,
  loadCombinedProjectRegistry,
  readMaintenancePauseStatus,
  DASHBOARD_PROJECT_ADAPTERS_ENV,
  SINGLE_PROJECT_ADAPTER_ENV,
} from "./dashboard-project-registry";
import { maintenancePauseMarkerPath } from "./runner-supervisor";
import type { AutoDevEvent } from "./observability-event";

// AutoDev Dashboard 멀티프로젝트 운영센터 개선 — dashboard-project-registry.ts 테스트.

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

function writeAdapter(dir: string, projectId: string, projectName: string): string {
  const projectRoot = join(dir, projectId);
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "state.json"), JSON.stringify({ completedTasks: [] }), "utf-8");
  const adapterPath = join(projectRoot, "manifest.json");
  const manifest = {
    projectId,
    projectName,
    targetProjectRoot: ".",
    statePath: "state.json",
    taskRegistry: [],
    developerInstructions: "test",
    reviewInstructions: "test",
    reviewScopeDirs: ["src/"],
    executionPolicy: { allowedReadPrefixes: ["src/"], allowedWritePrefixes: ["src/"], allowedCommands: [] },
  };
  writeFileSync(adapterPath, JSON.stringify(manifest, null, 2), "utf-8");
  return adapterPath;
}

function scenarioEmptyWithNoEnv(): void {
  const result = loadProjectRegistry({});
  check("환경변수 없음: projects 비어있음", result.projects.length === 0);
  check("환경변수 없음: issues 비어있음", result.issues.length === 0);
}

function scenarioSingleFallbackFromLegacyEnv(): void {
  const dir = makeTempDir("autodev-dashboard-registry-single-");
  const adapterPath = writeAdapter(dir, "legacy-proj", "레거시 프로젝트");
  const env: NodeJS.ProcessEnv = { [SINGLE_PROJECT_ADAPTER_ENV]: adapterPath };
  const result = loadProjectRegistry(env);
  check("AUTODEV_PROJECT_ADAPTER만 있으면 그 project 하나가 등록됨", result.projects.length === 1);
  check("AUTODEV_PROJECT_ADAPTER fallback: projectId 일치", result.projects[0]?.projectId === "legacy-proj");
}

function scenarioMultipleProjectsFromNewEnv(): void {
  const dir = makeTempDir("autodev-dashboard-registry-multi-");
  const a = writeAdapter(dir, "proj-a", "프로젝트 A");
  const b = writeAdapter(dir, "proj-b", "프로젝트 B");
  const c = writeAdapter(dir, "proj-c", "프로젝트 C");
  const env: NodeJS.ProcessEnv = { [DASHBOARD_PROJECT_ADAPTERS_ENV]: JSON.stringify([a, b, c]) };
  const result = loadProjectRegistry(env);
  check("N개 등록: 3개 모두 로드됨", result.projects.length === 3);
  check("N개 등록: issues 없음", result.issues.length === 0);
  const ids = result.projects.map((p) => p.projectId).sort();
  check("N개 등록: projectId 3개 모두 정확", JSON.stringify(ids) === JSON.stringify(["proj-a", "proj-b", "proj-c"]));
}

function scenarioMultiEnvTakesPriorityOverLegacy(): void {
  const dir = makeTempDir("autodev-dashboard-registry-priority-");
  const a = writeAdapter(dir, "proj-priority-a", "프로젝트 A");
  const legacy = writeAdapter(dir, "proj-legacy-only", "레거시만");
  const env: NodeJS.ProcessEnv = {
    [DASHBOARD_PROJECT_ADAPTERS_ENV]: JSON.stringify([a]),
    [SINGLE_PROJECT_ADAPTER_ENV]: legacy,
  };
  const result = loadProjectRegistry(env);
  check("새 env가 있으면 legacy env는 무시됨", result.projects.length === 1 && result.projects[0]?.projectId === "proj-priority-a");
}

function scenarioOneBrokenAdapterDoesNotBlockOthers(): void {
  const dir = makeTempDir("autodev-dashboard-registry-broken-");
  const good = writeAdapter(dir, "proj-good", "정상 프로젝트");
  const broken = join(dir, "does-not-exist.json");
  const env: NodeJS.ProcessEnv = { [DASHBOARD_PROJECT_ADAPTERS_ENV]: JSON.stringify([good, broken]) };
  const result = loadProjectRegistry(env);
  check("깨진 adapter 하나가 있어도 정상 project는 로드됨", result.projects.length === 1 && result.projects[0]?.projectId === "proj-good");
  check("깨진 adapter는 issues에 기록됨", result.issues.length === 1 && result.issues[0]?.adapterPath === broken);
}

function scenarioDuplicateProjectIdReportedAsIssue(): void {
  const dir = makeTempDir("autodev-dashboard-registry-dup-");
  const a = writeAdapter(dir, "dup-proj", "첫 번째");
  const dir2 = makeTempDir("autodev-dashboard-registry-dup2-");
  const b = writeAdapter(dir2, "dup-proj", "두 번째(같은 projectId)");
  const env: NodeJS.ProcessEnv = { [DASHBOARD_PROJECT_ADAPTERS_ENV]: JSON.stringify([a, b]) };
  const result = loadProjectRegistry(env);
  check("중복 projectId: 첫 번째만 등록됨", result.projects.length === 1 && result.projects[0]?.adapterPath === a);
  check("중복 projectId: issue로 기록됨", result.issues.some((i) => i.adapterPath === b));
}

function scenarioMalformedJsonEnvTreatedAsEmpty(): void {
  const env: NodeJS.ProcessEnv = { [DASHBOARD_PROJECT_ADAPTERS_ENV]: "not valid json" };
  const result = loadProjectRegistry(env);
  check("잘못된 JSON env: projects 비어있음(추측해서 일부 사용하지 않음)", result.projects.length === 0);
  check("잘못된 JSON env: issue 기록됨", result.issues.length === 1);
}

// ---------------------------------------------------------------------------
// Dashboard Project Auto-Discovery(2026-09-03) — discoverProjectsFromEvents()/
// loadCombinedProjectRegistry() 테스트. discoverProjectsFromEvents()는 완전한 AutoDevEvent를
// 요구하지 않는다(§ 함수 시그니처 Pick) — event store를 거치지 않고 최소 field만 담은 순수
// 객체로 직접 검증한다.
// ---------------------------------------------------------------------------

type MinimalEvent = Pick<AutoDevEvent, "eventType" | "projectId" | "metadata" | "timestamp" | "sequence">;

function runStartedEvent(overrides: Partial<MinimalEvent> & { sequence: number }): MinimalEvent {
  return { eventType: "RUN_STARTED", timestamp: "2026-09-03T00:00:00.000Z", ...overrides };
}

function scenarioDiscoverFromRunStartedEventRegistersProject(): void {
  const dir = makeTempDir("autodev-dashboard-discover-basic-");
  const adapterPath = writeAdapter(dir, "discovered-proj", "자동 발견된 프로젝트");
  const events: MinimalEvent[] = [runStartedEvent({ sequence: 1, projectId: "discovered-proj", metadata: { adapterPath } })];
  const result = discoverProjectsFromEvents(events);
  check("RUN_STARTED의 adapterPath만으로 project가 자동 등록됨", result.projects.length === 1);
  check("자동 등록: projectId 일치", result.projects[0]?.projectId === "discovered-proj");
  check("자동 등록: issues 없음", result.issues.length === 0);
}

function scenarioDiscoverIgnoresRunStartedWithoutAdapterPath(): void {
  const events: MinimalEvent[] = [runStartedEvent({ sequence: 1, projectId: "no-adapter-proj" })];
  const result = discoverProjectsFromEvents(events);
  check("adapterPath metadata가 없는 RUN_STARTED는 자동 등록하지 않음(추측 금지)", result.projects.length === 0 && result.issues.length === 0);
}

function scenarioDiscoverUsesMostRecentRunStartedOnReRun(): void {
  const dir = makeTempDir("autodev-dashboard-discover-rerun-");
  const adapterPath = writeAdapter(dir, "rerun-proj", "재실행 프로젝트");
  const events: MinimalEvent[] = [
    runStartedEvent({ sequence: 1, projectId: "rerun-proj", metadata: { adapterPath }, timestamp: "2026-09-01T00:00:00.000Z" }),
    runStartedEvent({ sequence: 2, projectId: "rerun-proj", metadata: { adapterPath }, timestamp: "2026-09-02T00:00:00.000Z" }),
  ];
  const result = discoverProjectsFromEvents(events);
  check("같은 projectId가 여러 번 RUN_STARTED해도 카드 1개만 생김(중복 카드 방지)", result.projects.length === 1);
}

function scenarioDiscoverManifestProjectIdMismatchNotRegistered(): void {
  const dir = makeTempDir("autodev-dashboard-discover-mismatch-");
  const adapterPath = writeAdapter(dir, "actual-proj-id", "실제 manifest");
  // event는 다른 projectId를 기록했지만 그 경로의 실제 manifest.projectId는 다르다 —
  // manifest 파일이 그 사이 교체된 경우를 재현한다(§ 요구사항 G).
  const events: MinimalEvent[] = [runStartedEvent({ sequence: 1, projectId: "stale-proj-id", metadata: { adapterPath } })];
  const result = discoverProjectsFromEvents(events);
  check("event의 projectId와 manifest의 projectId가 다르면 자동 등록하지 않음", result.projects.length === 0);
  check("projectId 불일치는 issue로 기록됨", result.issues.length === 1);
}

// Stale Discovered-Registration Reconciliation(2026-09-03, 실제 production Dashboard에서
// 재현/보고된 결함) — E2E 검증용 임시 project를 정리(디렉터리 삭제)한 뒤에도, 그 RUN_STARTED
// event는 영구 기록이라 매 요청마다 loadProjectAdapter()가 다시 실패해 REGISTRY_ISSUE가
// 무한히 반복 표시됐다. "그 경로에 파일이 지금 없다"는 사람이 고칠 수 있는 설정 오류가
// 아니므로(프로젝트가 정상 종료 후 정리됐거나 테스트 fixture였을 뿐) issue로 격상하지
// 않는다 — 조용히 미등록으로만 남는다(§ 요구사항 E/I: 데이터 자체는 event 기반 카드로 계속
// 보존됨, 삭제/병합 없음).
function scenarioDiscoverDeletedManifestSilentlyUnregisteredNoIssue(): void {
  const events: MinimalEvent[] = [runStartedEvent({ sequence: 1, projectId: "gone-proj", metadata: { adapterPath: "C:/does/not/exist/manifest.json" } })];
  const result = discoverProjectsFromEvents(events);
  check(
    "manifest 파일이 사라지면 등록되지 않지만 issue도 남기지 않음(사람이 고칠 수 없는 상태를 영구 경고로 만들지 않음)",
    result.projects.length === 0 && result.issues.length === 0
  );
}

// 파일이 존재하는데 내용이 깨졌다면(위와 달리 "지금 그 경로에 뭔가 있는데 잘못됐다"는 실제
// 이상 신호) 여전히 issue로 표면화해야 한다 — 존재하지 않는 파일과 손상된 파일을 같은
// 취급으로 뭉뚱그리지 않는다.
function scenarioDiscoverCorruptManifestFileStillReportsIssue(): void {
  const dir = makeTempDir("autodev-dashboard-discover-corrupt-");
  const adapterPath = join(dir, "manifest.json");
  writeFileSync(adapterPath, "{ not valid json", "utf-8");
  const events: MinimalEvent[] = [runStartedEvent({ sequence: 1, projectId: "corrupt-proj", metadata: { adapterPath } })];
  const result = discoverProjectsFromEvents(events);
  check(
    "manifest 파일이 존재하지만 손상됐으면 issue로 표면화됨(파일 없음과 다른 취급)",
    result.projects.length === 0 && result.issues.length === 1
  );
}

function scenarioCombinedRegistryUnionsExplicitAndDiscovered(): void {
  const dir = makeTempDir("autodev-dashboard-combined-union-");
  const explicitAdapter = writeAdapter(dir, "explicit-proj", "명시 등록");
  const discoveredAdapter = writeAdapter(dir, "auto-proj", "자동 발견");
  const env: NodeJS.ProcessEnv = { [DASHBOARD_PROJECT_ADAPTERS_ENV]: JSON.stringify([explicitAdapter]) };
  const events: MinimalEvent[] = [runStartedEvent({ sequence: 1, projectId: "auto-proj", metadata: { adapterPath: discoveredAdapter } })];
  const result = loadCombinedProjectRegistry(env, events);
  const ids = result.projects.map((p) => p.projectId).sort();
  check("명시 등록 + 자동 발견이 합쳐짐(중복 없이 2개)", JSON.stringify(ids) === JSON.stringify(["auto-proj", "explicit-proj"]));
  check("합집합: issues 없음", result.issues.length === 0);
}

function scenarioCombinedRegistryExplicitWinsOnConflict(): void {
  const dir = makeTempDir("autodev-dashboard-combined-conflict-");
  const explicitAdapter = writeAdapter(dir, "conflict-proj", "명시 등록(신뢰됨)");
  const dir2 = makeTempDir("autodev-dashboard-combined-conflict2-");
  const discoveredAdapter = writeAdapter(dir2, "conflict-proj", "다른 경로에서 발견됨");
  const env: NodeJS.ProcessEnv = { [DASHBOARD_PROJECT_ADAPTERS_ENV]: JSON.stringify([explicitAdapter]) };
  const events: MinimalEvent[] = [runStartedEvent({ sequence: 1, projectId: "conflict-proj", metadata: { adapterPath: discoveredAdapter } })];
  const result = loadCombinedProjectRegistry(env, events);
  check("동일 projectId가 다른 경로로 충돌하면 명시 등록만 유지됨(임의 덮어쓰기 금지)", result.projects.length === 1 && result.projects[0]?.adapterPath === explicitAdapter);
  check("충돌은 issue로 드러남(조용히 무시하지 않음)", result.issues.some((i) => i.adapterPath === discoveredAdapter));
}

function scenarioMaintenancePauseAbsent(): void {
  const dir = makeTempDir("autodev-dashboard-registry-pause-absent-");
  const status = readMaintenancePauseStatus("C:/some/adapter.json", dir);
  check("Maintenance Pause 마커 없음: active=false", status.active === false);
}

function scenarioMaintenancePausePresent(): void {
  const dir = makeTempDir("autodev-dashboard-registry-pause-present-");
  const adapterPath = "C:/some/adapter.json";
  const markerPath = maintenancePauseMarkerPath(adapterPath, dir);
  writeFileSync(markerPath, JSON.stringify({ engagedAt: "2026-09-01T00:00:00.000Z", reason: "테스트 사유" }), "utf-8");
  const status = readMaintenancePauseStatus(adapterPath, dir);
  check("Maintenance Pause 마커 있음: active=true", status.active === true);
  check("Maintenance Pause 마커 있음: engagedAt 반영", status.engagedAt === "2026-09-01T00:00:00.000Z");
  check("Maintenance Pause 마커 있음: reason 반영", status.reason === "테스트 사유");
}

function scenarioMaintenancePauseCorruptMarkerStillActive(): void {
  const dir = makeTempDir("autodev-dashboard-registry-pause-corrupt-");
  const adapterPath = "C:/some/adapter.json";
  const markerPath = maintenancePauseMarkerPath(adapterPath, dir);
  writeFileSync(markerPath, "{ not valid json", "utf-8");
  const status = readMaintenancePauseStatus(adapterPath, dir);
  check("Maintenance Pause 마커 손상: 그래도 active=true(존재 자체가 판정 기준)", status.active === true);
}

function main(): void {
  try {
    scenarioEmptyWithNoEnv();
    scenarioSingleFallbackFromLegacyEnv();
    scenarioMultipleProjectsFromNewEnv();
    scenarioMultiEnvTakesPriorityOverLegacy();
    scenarioOneBrokenAdapterDoesNotBlockOthers();
    scenarioDuplicateProjectIdReportedAsIssue();
    scenarioMalformedJsonEnvTreatedAsEmpty();
    scenarioDiscoverFromRunStartedEventRegistersProject();
    scenarioDiscoverIgnoresRunStartedWithoutAdapterPath();
    scenarioDiscoverUsesMostRecentRunStartedOnReRun();
    scenarioDiscoverManifestProjectIdMismatchNotRegistered();
    scenarioDiscoverDeletedManifestSilentlyUnregisteredNoIssue();
    scenarioDiscoverCorruptManifestFileStillReportsIssue();
    scenarioCombinedRegistryUnionsExplicitAndDiscovered();
    scenarioCombinedRegistryExplicitWinsOnConflict();
    scenarioMaintenancePauseAbsent();
    scenarioMaintenancePausePresent();
    scenarioMaintenancePauseCorruptMarkerStillActive();
  } finally {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // 정리 실패는 테스트 결과에 영향 없음.
      }
    }
  }

  console.log("\n=== dashboard-project-registry 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
