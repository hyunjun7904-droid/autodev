// AutoDev Regression Infrastructure — build-once full regression runner.
//
// 문제: 기존 `npm run test:<module>` 78개는 각각 "npm run build && node dist/....js"
// 형태라 전체 회귀를 순차 실행하면 같은 dist/를 78번 다시 쓰게 되고, 그 과정에서 간헐적
// TS5033 파일 쓰기 오류가 발생할 수 있다. 이 스크립트는 그 78개 스크립트 정의 자체를
// 새로 만들지 않고 package.json의 "test:" 접두사 스크립트(단일 source of truth)를 그대로
// 읽어, build는 (이 스크립트를 포함해) 한 번만 수행된 이후 이미 생성된 dist/*.js를 그대로
// 실행만 한다 — 기존 `npm run test:<module>` 개별 동작(각자 build 포함)은 전혀 건드리지
// 않는다.
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

interface DiscoveredScript {
  name: string;
  distPath: string;
}

interface ScriptResult {
  name: string;
  distPath: string;
  exitCode: number | null;
  combinedOutput: string;
  assertTotal: number | null;
  assertPass: number | null;
  assertSkip: number;
  assertFail: number | null;
}

const SUMMARY_LINE = /총\s+(\d+)건,\s*PASS\s+(\d+)(?:,\s*SKIP\s+(\d+))?,\s*FAIL\s+(\d+)/;
const NODE_DIST_INVOCATION = /node\s+(dist\/[\w.-]+\.js)\s*$/;

function loadTestScripts(repoRoot: string): DiscoveredScript[] {
  const pkgPath = join(repoRoot, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  const discovered: DiscoveredScript[] = [];
  for (const name of Object.keys(scripts)) {
    if (!name.startsWith("test:")) continue;
    const cmd = scripts[name];
    const match = cmd.match(NODE_DIST_INVOCATION);
    if (!match) {
      throw new Error(
        `package.json의 "${name}" 스크립트("${cmd}")가 예상 패턴("... && node dist/<file>.js")과 다릅니다 — ` +
          `build-once 회귀는 이 패턴을 가정합니다. 새 test:* 스크립트를 추가했다면 이 러너도 함께 검토하세요.`
      );
    }
    discovered.push({ name, distPath: match[1] });
  }
  return discovered;
}

function runOne(repoRoot: string, script: DiscoveredScript): ScriptResult {
  const proc = spawnSync(process.execPath, [script.distPath], {
    cwd: repoRoot,
    encoding: "utf8",
    env: process.env,
  });
  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? "";
  const combinedOutput = stdout + (stderr ? `\n${stderr}` : "");
  const m = combinedOutput.match(SUMMARY_LINE);
  return {
    name: script.name,
    distPath: script.distPath,
    exitCode: proc.status,
    combinedOutput,
    assertTotal: m ? Number(m[1]) : null,
    assertPass: m ? Number(m[2]) : null,
    assertSkip: m && m[3] !== undefined ? Number(m[3]) : 0,
    assertFail: m ? Number(m[4]) : null,
  };
}

function main(): void {
  const repoRoot = join(__dirname, "..");
  const scripts = loadTestScripts(repoRoot);

  process.stdout.write(`=== Build-once full regression: ${scripts.length}개 test:* 스크립트 (dist 재빌드 없이 순차 실행) ===\n`);

  const results: ScriptResult[] = [];
  scripts.forEach((script, i) => {
    process.stdout.write(`[${i + 1}/${scripts.length}] ${script.name} (node ${script.distPath}) ...\n`);
    const result = runOne(repoRoot, script);
    results.push(result);
    if (result.exitCode !== 0) {
      process.stdout.write(`  -> FAIL (exit=${result.exitCode})\n`);
      const tail = result.combinedOutput.split("\n").slice(-30).join("\n");
      process.stdout.write(tail + "\n");
    } else {
      process.stdout.write(
        `  -> PASS (assertions total=${result.assertTotal ?? "NA"} pass=${result.assertPass ?? "NA"} ` +
          `skip=${result.assertSkip} fail=${result.assertFail ?? "NA"})\n`
      );
    }
  });

  const totalScripts = results.length;
  const passScripts = results.filter((r) => r.exitCode === 0).length;
  const failScripts = results.filter((r) => r.exitCode !== 0).length;
  const skippedScripts = 0; // 이 러너는 discovered scripts 전체를 항상 실행한다 — script-level skip 없음.

  let passAssertions = 0;
  let failAssertions = 0;
  let skipAssertions = 0;
  for (const r of results) {
    if (r.exitCode === 0) {
      passAssertions += r.assertPass ?? 0;
      failAssertions += r.assertFail ?? 0;
      skipAssertions += r.assertSkip;
    }
  }

  const allOutput = results.map((r) => r.combinedOutput).join("\n");
  const ts5033Count = (allOutput.match(/TS5033/g) ?? []).length;
  const ebusyCount = (allOutput.match(/EBUSY/gi) ?? []).length;

  process.stdout.write("\n=== FULL REGRESSION SUMMARY (build-once) ===\n");
  process.stdout.write(`TOTAL_SCRIPTS=${totalScripts}\n`);
  process.stdout.write(`PASS_SCRIPTS=${passScripts}\n`);
  process.stdout.write(`FAIL_SCRIPTS=${failScripts}\n`);
  process.stdout.write(`SKIPPED_SCRIPTS=${skippedScripts}\n`);
  process.stdout.write(`PASS_ASSERTIONS=${passAssertions}\n`);
  process.stdout.write(`FAIL_ASSERTIONS=${failAssertions}\n`);
  process.stdout.write(`SKIP_ASSERTIONS=${skipAssertions}\n`);
  process.stdout.write(`TS5033_COUNT=${ts5033Count}\n`);
  process.stdout.write(`EBUSY_COUNT=${ebusyCount}\n`);

  if (failScripts === 0 && failAssertions === 0 && ts5033Count === 0 && ebusyCount === 0) {
    process.stdout.write("FINAL_VERDICT=REGRESSION_INFRA_READY\n");
  } else {
    process.stdout.write("FINAL_VERDICT=HOLD\n");
    process.exitCode = 1;
  }
}

main();
