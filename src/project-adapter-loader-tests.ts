import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadProjectAdapter } from "./project-adapter-loader";

// AutoDev 범용화 Phase B Task B3 — External Project Adapter 로더 검증.
//
// 이 파일은 project-adapter-loader.ts(AutoDev Core)가 MOVAN을 포함해 어떤 프로젝트도
// 직접 알지 못한 채, 오직 "adapter 경로 → createProjectManifest() export → 반환값이
// validateProjectManifest를 통과" 계약만으로 동작함을 증명한다. 실제 MOVAN adapter는
// 여기서 전혀 참조하지 않는다 — 이 테스트가 쓰는 adapter는 전부 OS 임시 디렉터리에 그
// 자리에서 만든 fixture CommonJS 모듈이다.

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

function writeAdapterModule(dir: string, fileName: string, content: string): string {
  const abs = join(dir, fileName);
  writeFileSync(abs, content, "utf-8");
  return abs;
}

// ---------------------------------------------------------------------------
// A) adapter 경로 미지정(undefined/빈 문자열) — 즉시 실패, 어떤 프로젝트로도 fallback 없음.
// ---------------------------------------------------------------------------
function scenarioMissingAdapterPathFailsFast(): void {
  let threwOnUndefined = false;
  try {
    loadProjectAdapter(undefined);
  } catch {
    threwOnUndefined = true;
  }
  check("A) adapter 경로가 undefined면 즉시 실패", threwOnUndefined);

  let threwOnEmpty = false;
  try {
    loadProjectAdapter("   ");
  } catch {
    threwOnEmpty = true;
  }
  check("A) adapter 경로가 공백 문자열이면 즉시 실패", threwOnEmpty);
}

// ---------------------------------------------------------------------------
// B) 존재하지 않는 adapter 모듈 경로 — 즉시 실패.
// ---------------------------------------------------------------------------
function scenarioNonexistentAdapterPathFailsFast(): void {
  const dir = makeTempDir("autodev-adapter-loader-missing-");
  const nonexistent = join(dir, "does-not-exist.js");
  let threw = false;
  try {
    loadProjectAdapter(nonexistent);
  } catch {
    threw = true;
  }
  check("B) 존재하지 않는 adapter 모듈 경로는 즉시 실패", threw);
}

// ---------------------------------------------------------------------------
// C) 모듈은 존재하지만 createProjectManifest()를 export하지 않음 — 즉시 실패.
// ---------------------------------------------------------------------------
function scenarioAdapterWithoutFactoryFailsFast(): void {
  const dir = makeTempDir("autodev-adapter-loader-nofactory-");
  const modulePath = writeAdapterModule(dir, "adapter.js", "module.exports = { somethingElse: 123 };\n");
  let threw = false;
  let message = "";
  try {
    loadProjectAdapter(modulePath);
  } catch (e) {
    threw = true;
    message = e instanceof Error ? e.message : String(e);
  }
  check("C) createProjectManifest export가 없으면 즉시 실패", threw);
  check("C) 실패 메시지가 createProjectManifest 계약 위반을 언급함", message.includes("createProjectManifest"));
}

// ---------------------------------------------------------------------------
// D) createProjectManifest()가 반환한 값이 validateProjectManifest를 통과하지 못함
//    — 즉시 실패(permissive fallback 없음).
// ---------------------------------------------------------------------------
function scenarioAdapterReturningInvalidManifestFailsFast(): void {
  const dir = makeTempDir("autodev-adapter-loader-invalid-");
  const modulePath = writeAdapterModule(
    dir,
    "adapter.js",
    [
      "module.exports = {",
      "  createProjectManifest: function () {",
      "    return { projectId: '' };", // projectId 빈 문자열 — validateProjectManifest가 거부해야 함
      "  },",
      "};",
    ].join("\n")
  );
  let threw = false;
  try {
    loadProjectAdapter(modulePath);
  } catch {
    threw = true;
  }
  check("D) 유효하지 않은 manifest를 반환하는 adapter는 즉시 실패", threw);
}

// ---------------------------------------------------------------------------
// E) 유효한 fixture adapter를 명시적으로 주입하면 정상적으로 ProjectManifest를 얻는다
//    (MOVAN이 아닌 임의의 fixture 프로젝트로도 동일하게 동작함을 증명).
// ---------------------------------------------------------------------------
function scenarioValidFixtureAdapterLoadsSuccessfully(): void {
  const dir = makeTempDir("autodev-adapter-loader-valid-");
  const modulePath = writeAdapterModule(
    dir,
    "adapter.js",
    [
      "const { resolve, join } = require('node:path');",
      "function createProjectManifest() {",
      "  return {",
      "    projectId: 'fixture-adapter-project',",
      "    projectName: 'Fixture Adapter Project',",
      "    targetProjectRoot: resolve(__dirname),",
      "    statePath: join(__dirname, 'project-state.json'),",
      "    taskRegistry: [],",
      "    developerInstructions: 'fixture adapter developer instructions',",
      "    reviewInstructions: 'fixture adapter review instructions',",
      "    reviewScopeDirs: ['fixture/'],",
      "    executionPolicy: {",
      "      allowedReadPrefixes: ['fixture/'],",
      "      allowedWritePrefixes: ['fixture/'],",
      "      allowedCommands: [],",
      "    },",
      "  };",
      "}",
      "module.exports = { createProjectManifest };",
    ].join("\n")
  );

  const manifest = loadProjectAdapter(modulePath);
  check("E) 유효한 fixture adapter가 정상적으로 ProjectManifest를 반환함", manifest.projectId === "fixture-adapter-project");
  check("E) 반환된 manifest.targetProjectRoot가 adapter 자신의 위치 기준으로 계산됨", manifest.targetProjectRoot === dir);
  check("E) 반환된 manifest에 MOVAN 관련 필드가 전혀 없음", !JSON.stringify(manifest).includes("movan") && !JSON.stringify(manifest).includes("MOVAN"));
}

async function main(): Promise<void> {
  try {
    scenarioMissingAdapterPathFailsFast();
    scenarioNonexistentAdapterPathFailsFast();
    scenarioAdapterWithoutFactoryFailsFast();
    scenarioAdapterReturningInvalidManifestFailsFast();
    scenarioValidFixtureAdapterLoadsSuccessfully();
  } finally {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 디렉터리 정리 실패는 테스트 결과에 영향 없음
      }
    }
  }

  // 소스 회귀 — run.ts(범용 진입점)가 project-manifests/movan을 import하지 않고, adapter
  // 경로 없이는 즉시 실패하며, 기본 프로젝트 상수를 갖지 않는다.
  const runSource = readFileSync(join(__dirname, "..", "src", "run.ts"), "utf-8");
  check("소스 회귀: run.ts가 project-manifests/movan을 import하지 않음", !/from\s+"\.\/project-manifests\/movan"/.test(runSource));
  check("소스 회귀: run.ts가 project-adapter-loader를 통해서만 manifest를 얻음", /loadProjectAdapter\(/.test(runSource));
  check("소스 회귀: run.ts에 MOVAN 하드코딩 문자열이 없음", !/MOVAN/.test(runSource));

  console.log("\n=== project-adapter-loader(Phase B Task B3 — External Project Adapter) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
