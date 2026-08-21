import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_STATE_PATH } from "./state";
import type { ProjectState } from "./types";

// Phase A Task A2 — project-state 경로를 AUTODEV_STATE_PATH 환경변수로 외부에서 주입할 수
// 있는지 검증한다(project-context.ts의 resolveStatePath()가 실제 계산을 전담, state.ts는
// 그 값을 재export). AUTODEV_TARGET_PROJECT_ROOT(Task A1)와 동일하게, DEFAULT_STATE_PATH는
// 모듈 최초 import 시점에 환경변수를 한 번만 읽어 top-level const로 고정되므로, 다른 값을
// 검증하려면 매번 새 Node 프로세스를 spawn해야 한다.
//
// 이 파일 자신은 AUTODEV_STATE_PATH를 지정하지 않은 채로 실행되므로, 최상단에서 import한
// DEFAULT_STATE_PATH는 항상 실제 운영 경로(automation/config/project-state.json)다 —
// 이 값을 read-only 증거로만 써서 실제 파일이 테스트 전후 완전히 동일함을 증명한다(§ 요구사항:
// production project-state.json 보호).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const DIST_DIR = __dirname; // 빌드 후 automation/dist
const STATE_JS = join(DIST_DIR, "state.js");

function runProbe(env: NodeJS.ProcessEnv, script: string): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ["-e", script, STATE_JS], {
    cwd: DIST_DIR,
    encoding: "utf-8",
    env,
  });
  return { ok: res.status === 0, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

// A) 설정이 없으면 기존 automation/config/project-state.json 경로를 그대로 쓴다.
function scenarioDefaultPathMatchesExistingConfig(): void {
  const env = { ...process.env };
  delete env.AUTODEV_STATE_PATH;
  const script = [
    "const s = require(process.argv[1]);",
    "console.log(JSON.stringify({ DEFAULT_STATE_PATH: s.DEFAULT_STATE_PATH }));",
  ].join("\n");
  const probe = runProbe(env, script);
  check("A) 기본값 프로브 실행 성공(env 미지정)", probe.ok);
  if (!probe.ok) return;

  const parsed = JSON.parse(probe.stdout) as { DEFAULT_STATE_PATH: string };
  const expectedDefault = resolve(DIST_DIR, "..", "config", "project-state.json");
  check(
    "A) AUTODEV_STATE_PATH 미지정 시 기존 automation/config/project-state.json 경로와 정확히 동일",
    parsed.DEFAULT_STATE_PATH === expectedDefault
  );
}

// B) 외부 temp project-state 경로를 지정하면 그 파일만 읽고 쓴다.
// C) temp state 변경이 실제 production project-state.json에 영향을 주지 않는다.
function scenarioExternalStatePathIsUsedInIsolation(): void {
  const dir = mkdtempSync(join(tmpdir(), "autodev-state-path-"));
  const tempStatePath = join(dir, "project-state.json");
  try {
    const fixture: ProjectState = {
      project: "PROBE FIXTURE PROJECT",
      currentPhase: 999,
      phase10Allowed: true,
      migrationsApplied: [],
      migrationsImmutable: true,
      devSupabaseCreated: true,
      devSupabaseConnected: false,
      microsoftConnected: false,
      productionDeployAllowed: false,
      gitCheckpoint: "probe",
      currentTask: null,
      reviewCycle: 0,
      lastClaudeResult: null,
      lastGptDecision: null,
      status: "IDLE",
      claudeLimitWaitCount: 0,
      deferredHumanTasks: [],
      completedTasks: [],
    };
    writeFileSync(tempStatePath, JSON.stringify(fixture, null, 2) + "\n", "utf-8");

    const realStateBefore = readFileSync(DEFAULT_STATE_PATH, "utf-8");

    const env = { ...process.env, AUTODEV_STATE_PATH: tempStatePath };
    const script = [
      "const s = require(process.argv[1]);",
      "const before = s.loadState();",
      "before.currentTask = 'PROBE_MUTATED_BY_STATE_TESTS';",
      "s.saveState(before);",
      "const after = s.loadState();",
      "console.log(JSON.stringify({",
      "  DEFAULT_STATE_PATH: s.DEFAULT_STATE_PATH,",
      "  projectBefore: before.project,",
      "  currentTaskAfter: after.currentTask,",
      "}));",
    ].join("\n");
    const probe = runProbe(env, script);
    check("B) 외부 temp state path 프로브 실행 성공", probe.ok);
    if (!probe.ok) {
      console.error(probe.stderr);
      return;
    }

    const parsed = JSON.parse(probe.stdout) as {
      DEFAULT_STATE_PATH: string;
      projectBefore: string;
      currentTaskAfter: string;
    };
    check("B) AUTODEV_STATE_PATH로 지정한 temp 경로를 실제로 statePath로 사용", parsed.DEFAULT_STATE_PATH === tempStatePath);
    check("B) loadState()가 인자 없이도 temp fixture 내용을 읽음", parsed.projectBefore === fixture.project);
    check("B) saveState()가 인자 없이도 temp 경로에만 기록됨", parsed.currentTaskAfter === "PROBE_MUTATED_BY_STATE_TESTS");

    const tempFileOnDisk = JSON.parse(readFileSync(tempStatePath, "utf-8")) as ProjectState;
    check("B) temp state 파일이 실제로 디스크에 갱신됨", tempFileOnDisk.currentTask === "PROBE_MUTATED_BY_STATE_TESTS");

    const realStateAfter = readFileSync(DEFAULT_STATE_PATH, "utf-8");
    check("C) temp state 변경이 실제 production project-state.json에 전혀 영향 없음", realStateBefore === realStateAfter);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// D) 잘못된 명시적 state path는 조용히 다른 state로 fallback하지 않고 즉시 실패한다.
function scenarioInvalidStatePathFailsFast(): void {
  const nonExistent = join(tmpdir(), "autodev-state-does-not-exist-" + Date.now() + ".json");
  const script =
    "try { require(process.argv[1]); console.log('LOADED_OK'); } catch (e) { console.log('THREW:' + e.message); }";
  const res = spawnSync(process.execPath, ["-e", script, STATE_JS], {
    cwd: DIST_DIR,
    encoding: "utf-8",
    env: { ...process.env, AUTODEV_STATE_PATH: nonExistent },
  });
  const stdout = (res.stdout || "").trim();
  check("D) 존재하지 않는 AUTODEV_STATE_PATH는 즉시 실패(silent fallback 아님)", stdout.startsWith("THREW:"));
}

function main(): void {
  const realStateBefore = readFileSync(DEFAULT_STATE_PATH, "utf-8");

  scenarioDefaultPathMatchesExistingConfig();
  scenarioExternalStatePathIsUsedInIsolation();
  scenarioInvalidStatePathFailsFast();

  const realStateAfter = readFileSync(DEFAULT_STATE_PATH, "utf-8");
  check("전체 시나리오 실행 전후 실제 production project-state.json이 완전히 동일함", realStateBefore === realStateAfter);

  console.log("\n=== state(AUTODEV_STATE_PATH) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
