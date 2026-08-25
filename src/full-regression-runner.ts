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

export interface DiscoveredScript {
  name: string;
  distPath: string;
}

export interface AssertionSummary {
  total: number;
  pass: number;
  skip: number;
  fail: number;
}

// script 자체의 exit code와 그 안의 assertion 집계는 서로 다른 질문이다 — exit code는
// "이 스크립트가 실패로 끝났는가"만 말하고, assertionSummary는 "그 실행 중 assertion이
// 몇 개 PASS/FAIL/SKIP했는가"를 말한다. assertionSummary가 null이면 output에서 그 요약
// 줄 자체를 찾지 못했다는 뜻이다(§ ASSERTION_SUMMARY_PARSE_ERROR) — 이 경우 0건으로
// 조용히 간주하지 않는다(아래 aggregateScriptResults 참고).
export interface ScriptResult {
  name: string;
  distPath: string;
  exitCode: number | null;
  combinedOutput: string;
  assertionSummary: AssertionSummary | null;
}

export interface RegressionAggregate {
  totalScripts: number;
  passScripts: number;
  failScripts: number;
  skippedScripts: number;
  passAssertions: number;
  failAssertions: number;
  skipAssertions: number;
  /** output에서 "총 N건, PASS X(, SKIP Y)?, FAIL Z" 요약 줄을 찾지 못한 스크립트 수(exit
   *  code와 무관) — 0건으로 조용히 집계하지 않고 별도로 센다(fail-closed 신호). */
  assertionSummaryParseErrors: number;
}

const SUMMARY_LINE = /총\s+(\d+)건,\s*PASS\s+(\d+)(?:,\s*SKIP\s+(\d+))?,\s*FAIL\s+(\d+)/;
const NODE_DIST_INVOCATION = /node\s+(dist\/[\w.-]+\.js)\s*$/;

export function loadTestScripts(repoRoot: string): DiscoveredScript[] {
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

/** 스크립트 stdout+stderr에서 "총 N건, PASS X(, SKIP Y)?, FAIL Z" 요약 줄을 파싱한다. 찾지
 *  못하면 null — 호출부가 이를 0건으로 취급하지 않고 ASSERTION_SUMMARY_PARSE_ERROR로
 *  다뤄야 한다. */
export function parseAssertionSummary(combinedOutput: string): AssertionSummary | null {
  const m = combinedOutput.match(SUMMARY_LINE);
  if (!m) return null;
  return {
    total: Number(m[1]),
    pass: Number(m[2]),
    skip: m[3] !== undefined ? Number(m[3]) : 0,
    fail: Number(m[4]),
  };
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
  return {
    name: script.name,
    distPath: script.distPath,
    exitCode: proc.status,
    combinedOutput,
    assertionSummary: parseAssertionSummary(combinedOutput),
  };
}

/**
 * script-level pass/fail(exit code 기준)과 assertion-level pass/fail/skip(파싱된 요약 기준)을
 * 서로 독립적으로 집계한다 — 이전 버그: exitCode !== 0인 스크립트는 이미 파싱해 둔
 * assertionSummary가 있어도 전체 tally에서 통째로 제외됐다(FAIL_ASSERTIONS이 실제보다 항상
 * 작게 보고됨). 이제는 exit code와 무관하게 assertionSummary가 있으면 그 pass/fail/skip을
 * 그대로 더한다. assertionSummary가 없으면(파싱 실패) 0으로 조용히 채우지 않고
 * assertionSummaryParseErrors만 올린다 — 그 스크립트의 assertion 수치는 PASS/FAIL/SKIP
 * 어느 쪽에도 섞이지 않는다(모른다는 사실 자체를 숨기지 않는다).
 */
export function aggregateScriptResults(results: ScriptResult[]): RegressionAggregate {
  const totalScripts = results.length;
  const passScripts = results.filter((r) => r.exitCode === 0).length;
  const failScripts = results.filter((r) => r.exitCode !== 0).length;
  const skippedScripts = 0; // 이 러너는 discovered scripts 전체를 항상 실행한다 — script-level skip 없음.

  let passAssertions = 0;
  let failAssertions = 0;
  let skipAssertions = 0;
  let assertionSummaryParseErrors = 0;
  for (const r of results) {
    if (r.assertionSummary) {
      passAssertions += r.assertionSummary.pass;
      failAssertions += r.assertionSummary.fail;
      skipAssertions += r.assertionSummary.skip;
    } else {
      assertionSummaryParseErrors += 1;
    }
  }

  return {
    totalScripts,
    passScripts,
    failScripts,
    skippedScripts,
    passAssertions,
    failAssertions,
    skipAssertions,
    assertionSummaryParseErrors,
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
        `  -> PASS (assertions total=${result.assertionSummary?.total ?? "NA"} pass=${result.assertionSummary?.pass ?? "NA"} ` +
          `skip=${result.assertionSummary?.skip ?? "NA"} fail=${result.assertionSummary?.fail ?? "NA"})\n`
      );
    }
    if (!result.assertionSummary) {
      process.stdout.write(
        `  !! ASSERTION_SUMMARY_PARSE_ERROR — 이 스크립트 output에서 "총 N건, PASS X, FAIL Y" 요약을 찾지 못했습니다` +
          `(0건으로 조용히 처리하지 않습니다).\n`
      );
    }
  });

  const aggregate = aggregateScriptResults(results);

  const allOutput = results.map((r) => r.combinedOutput).join("\n");
  const ts5033Count = (allOutput.match(/TS5033/g) ?? []).length;
  const ebusyCount = (allOutput.match(/EBUSY/gi) ?? []).length;

  process.stdout.write("\n=== FULL REGRESSION SUMMARY (build-once) ===\n");
  process.stdout.write(`TOTAL_SCRIPTS=${aggregate.totalScripts}\n`);
  process.stdout.write(`PASS_SCRIPTS=${aggregate.passScripts}\n`);
  process.stdout.write(`FAIL_SCRIPTS=${aggregate.failScripts}\n`);
  process.stdout.write(`SKIPPED_SCRIPTS=${aggregate.skippedScripts}\n`);
  process.stdout.write(`PASS_ASSERTIONS=${aggregate.passAssertions}\n`);
  process.stdout.write(`FAIL_ASSERTIONS=${aggregate.failAssertions}\n`);
  process.stdout.write(`SKIP_ASSERTIONS=${aggregate.skipAssertions}\n`);
  process.stdout.write(`TS5033_COUNT=${ts5033Count}\n`);
  process.stdout.write(`EBUSY_COUNT=${ebusyCount}\n`);
  process.stdout.write(`ASSERTION_SUMMARY_PARSE_ERRORS=${aggregate.assertionSummaryParseErrors}\n`);

  const ready =
    aggregate.failScripts === 0 &&
    aggregate.failAssertions === 0 &&
    aggregate.assertionSummaryParseErrors === 0 &&
    ts5033Count === 0 &&
    ebusyCount === 0;

  if (ready) {
    process.stdout.write("FINAL_VERDICT=REGRESSION_INFRA_READY\n");
  } else {
    process.stdout.write("FINAL_VERDICT=HOLD\n");
    process.exitCode = 1;
  }
}

// require.main===module 가드 — 직접 실행될 때만(node dist/full-regression-runner.js) main()을
// 돈다. 이 파일을 테스트가 import할 때는 위 순수 함수(parseAssertionSummary/
// aggregateScriptResults)만 쓰고, 실제 78개 스크립트를 spawn하는 부수효과는 일으키지 않는다
// (§ full-regression-runner-tests.ts).
if (require.main === module) {
  main();
}
