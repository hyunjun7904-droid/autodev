import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProjectRegistry,
  readMaintenancePauseStatus,
  DASHBOARD_PROJECT_ADAPTERS_ENV,
  SINGLE_PROJECT_ADAPTER_ENV,
} from "./dashboard-project-registry";
import { maintenancePauseMarkerPath } from "./runner-supervisor";

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
