import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Phase A Task A1 — AUTODEV_ROOT / TARGET_PROJECT_ROOT 분리 검증.
//
// TARGET_PROJECT_ROOT(및 이를 그대로 쓰는 safe-executor.ts의 PROJECT_ROOT)는 모듈 최초
// import 시점에 process.env.AUTODEV_TARGET_PROJECT_ROOT를 한 번만 읽어 top-level const로
// 고정된다. 같은 프로세스 안에서 여러 값을 검증할 수 없으므로, "환경변수로 다른 target
// root를 주입했을 때 실제로 그 root를 쓰는지"는 매번 새 Node 프로세스를 spawn해 확인한다
// (실제 운용에서도 이 환경변수는 프로세스 시작 전에 지정된다 — 동일한 조건).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const DIST_DIR = __dirname; // 빌드 후 automation/dist

// 이 파일이 spawn하는 모든 probe 프로세스는 root 계산(TARGET_PROJECT_ROOT/PROJECT_ROOT)만
// 검증한다 — 실제 프로젝트 정책(read/write 허용 경로)과는 무관하므로 최소한의 정책("web/"
// 하나만 read/write 허용)을 그 자리에서 즉석으로 주입한다(Phase B Task B1 — Safe Executor는
// configureSafeExecutor() 없이는 어떤 프로젝트로도 조용히 fallback하지 않는다).
const PROBE_POLICY_LITERAL =
  "{ allowedReadPrefixes: ['web/'], allowedWritePrefixes: ['web/'], allowedCommands: [] }";

function runProbe(env: NodeJS.ProcessEnv): { ok: boolean; stdout: string; stderr: string } {
  const script = [
    "const se = require(process.argv[1]);",
    `se.configureSafeExecutor(se.PROJECT_ROOT, ${PROBE_POLICY_LITERAL});`,
    "const r1 = se.validateReadPath('web/probe-target.ts');",
    "const r2 = se.validateReadPath('../outside-target.ts');",
    "console.log(JSON.stringify({",
    "  PROJECT_ROOT: se.PROJECT_ROOT,",
    "  insideAllowed: r1.ok,",
    "  insideRel: r1.ok ? r1.rel : null,",
    "  traversalBlocked: !r2.ok,",
    "}));",
  ].join("\n");
  const safeExecutorPath = join(DIST_DIR, "safe-executor.js");
  const res = spawnSync(process.execPath, ["-e", script, safeExecutorPath], {
    cwd: DIST_DIR,
    encoding: "utf-8",
    env,
  });
  return { ok: res.status === 0, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

function scenarioDefaultRootMatchesCurrentRepo(): void {
  const env = { ...process.env };
  delete env.AUTODEV_TARGET_PROJECT_ROOT;
  const probe = runProbe(env);
  check("기본값 프로브 실행 성공(env 미지정)", probe.ok);
  if (!probe.ok) return;

  const parsed = JSON.parse(probe.stdout) as { PROJECT_ROOT: string; insideAllowed: boolean; traversalBlocked: boolean };
  // 기존 계산식(resolve(__dirname, "..", "..")를 automation/dist 기준)과 정확히 같은 값이어야
  // 기존 MOVAN AutoDev 동작이 100% 보존된다.
  const expectedDefault = resolve(DIST_DIR, "..", "..");
  check("A) env 미지정 시 TARGET_PROJECT_ROOT가 현재 repository root와 동일", parsed.PROJECT_ROOT === expectedDefault);
  check("A) 기본 root에서 read 허용 범위(web/**) 정상 동작", parsed.insideAllowed);
  check("A) 기본 root에서도 path traversal은 여전히 BLOCK", parsed.traversalBlocked);
}

function scenarioExternalTargetRootIsUsed(): void {
  const externalDir = mkdtempSync(join(tmpdir(), "autodev-target-root-"));
  try {
    const env = { ...process.env, AUTODEV_TARGET_PROJECT_ROOT: externalDir };
    const probe = runProbe(env);
    check("B) 외부 target root 프로브 실행 성공", probe.ok);
    if (!probe.ok) return;

    const parsed = JSON.parse(probe.stdout) as { PROJECT_ROOT: string; insideAllowed: boolean; insideRel: string | null; traversalBlocked: boolean };
    check("B) AUTODEV_TARGET_PROJECT_ROOT로 지정한 외부 디렉터리를 실제로 target root로 사용", parsed.PROJECT_ROOT === externalDir);
    check("B) 외부 target root 하위에서도 read 허용 범위(web/**) 판정이 정상 동작", parsed.insideAllowed);
    check("B) 외부 target root 기준 상대경로가 정확히 계산됨", parsed.insideRel === "web/probe-target.ts");
    check("D) 외부 target root에서도 path traversal은 여전히 BLOCK", parsed.traversalBlocked);
  } finally {
    rmSync(externalDir, { recursive: true, force: true });
  }
}

function scenarioOutsideTargetRootIsBlocked(): void {
  const targetDir = mkdtempSync(join(tmpdir(), "autodev-target-root-"));
  const otherDir = mkdtempSync(join(tmpdir(), "autodev-other-root-"));
  try {
    const script = [
      "const se = require(process.argv[1]);",
      `se.configureSafeExecutor(se.PROJECT_ROOT, ${PROBE_POLICY_LITERAL});`,
      "const outsideAbs = process.argv[2] + '\\\\web\\\\x.ts';",
      "const r = se.validateReadPath(outsideAbs);",
      "console.log(JSON.stringify({ PROJECT_ROOT: se.PROJECT_ROOT, blocked: !r.ok }));",
    ].join("\n");
    const safeExecutorPath = join(DIST_DIR, "safe-executor.js");
    const res = spawnSync(
      process.execPath,
      ["-e", script, safeExecutorPath, otherDir],
      { cwd: DIST_DIR, encoding: "utf-8", env: { ...process.env, AUTODEV_TARGET_PROJECT_ROOT: targetDir } }
    );
    check("C) target root 밖 절대경로 프로브 실행 성공", res.status === 0);
    if (res.status !== 0) return;
    const parsed = JSON.parse((res.stdout || "").trim()) as { PROJECT_ROOT: string; blocked: boolean };
    check("C) 지정한 target root(targetDir)를 실제로 사용", parsed.PROJECT_ROOT === targetDir);
    check("C) target root(targetDir) 밖의 다른 디렉터리(otherDir) 접근은 BLOCK", parsed.blocked);
  } finally {
    rmSync(targetDir, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  }
}

function scenarioInvalidTargetRootFailsFast(): void {
  const nonExistent = join(tmpdir(), "autodev-does-not-exist-" + Date.now());
  const script = "try { require(process.argv[1]); console.log('LOADED_OK'); } catch (e) { console.log('THREW:' + e.message); }";
  const safeExecutorPath = join(DIST_DIR, "safe-executor.js");
  const res = spawnSync(process.execPath, ["-e", script, safeExecutorPath], {
    cwd: DIST_DIR,
    encoding: "utf-8",
    env: { ...process.env, AUTODEV_TARGET_PROJECT_ROOT: nonExistent },
  });
  const stdout = (res.stdout || "").trim();
  check("존재하지 않는 AUTODEV_TARGET_PROJECT_ROOT는 즉시 실패(silent fallback 아님)", stdout.startsWith("THREW:"));
}

function scenarioGptReviewerSharesRootWithSafeExecutor(): void {
  // F) gpt-reviewer.ts가 더 이상 독자적으로 PROJECT_ROOT를 계산하지 않고, safe-executor.ts의
  // PROJECT_ROOT를 그대로 import해 쓰는지 소스 레벨로 확인한다(동일 target root 보장의 근거).
  const src = readFileSync(join(__dirname, "..", "src", "gpt-reviewer.ts"), "utf-8");
  check(
    "F) gpt-reviewer.ts가 safe-executor.ts에서 PROJECT_ROOT를 import함",
    /import\s*\{\s*PROJECT_ROOT\s*\}\s*from\s*"\.\/safe-executor"/.test(src)
  );
  check(
    "F) gpt-reviewer.ts에 독자적인 PROJECT_ROOT 재계산(join(__dirname, \"..\", \"..\"))이 남아있지 않음",
    !/const\s+PROJECT_ROOT\s*=\s*join\(__dirname/.test(src)
  );
}

function scenarioSafeExecutorSymlinkDefensePreserved(): void {
  // E) safe-executor.ts의 symlink 방어(realpath 기반 재검증) 로직이 root 주입 리팩터링
  // 이후에도 그대로 남아있는지 소스 레벨로 확인한다(경로 검사를 완화하지 않았다는 근거).
  const src = readFileSync(join(__dirname, "..", "src", "safe-executor.ts"), "utf-8");
  check("E) PROJECT_ROOT_REAL(realpath 기반 symlink 방어용 값) 계산이 그대로 존재", /PROJECT_ROOT_REAL\s*=\s*existsSync\(PROJECT_ROOT\)\s*\?\s*realpathSync\(PROJECT_ROOT\)/.test(src));
  check("E) symlink 탈출 차단 분기가 그대로 존재", src.includes("symlink로 project root 탈출"));
  // Phase B Task B1 — PROJECT_ROOT는 configureSafeExecutor()로 프로젝트별 재설정이 가능해야
  // 하므로 const에서 let으로 바뀌었다(재계산 로직 자체는 여전히 TARGET_PROJECT_ROOT 하나뿐).
  check(
    "E) PROJECT_ROOT가 project-context.ts의 TARGET_PROJECT_ROOT를 그대로 씀(자체 재계산 없음)",
    /(const|let)\s+PROJECT_ROOT\s*=\s*TARGET_PROJECT_ROOT;/.test(src)
  );
}

function main(): void {
  scenarioDefaultRootMatchesCurrentRepo();
  scenarioExternalTargetRootIsUsed();
  scenarioOutsideTargetRootIsBlocked();
  scenarioInvalidTargetRootFailsFast();
  scenarioGptReviewerSharesRootWithSafeExecutor();
  scenarioSafeExecutorSymlinkDefensePreserved();

  console.log("\n=== project-context(AUTODEV_ROOT/TARGET_PROJECT_ROOT) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
