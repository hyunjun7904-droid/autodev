import { parseAssertionSummary, aggregateScriptResults } from "./full-regression-runner";
import type { ScriptResult } from "./full-regression-runner";

// full-regression-runner.ts의 순수 집계 로직만 검증한다 — 이 파일을 import해도 실제 78개
// test:* 스크립트를 spawn하지 않는다(§ full-regression-runner.ts의 require.main===module
// 가드). 실제 child process/파일 I/O 없이 fabricated ScriptResult로만 검증한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function fakeResult(overrides: Partial<ScriptResult> & { name: string }): ScriptResult {
  return {
    distPath: `dist/${overrides.name}.js`,
    exitCode: 0,
    combinedOutput: "",
    assertionSummary: null,
    ...overrides,
  };
}

function main(): void {
  // parseAssertionSummary — SKIP 그룹 없는 형태.
  check(
    "parseAssertionSummary: SKIP 없는 요약(총 N건, PASS X, FAIL Y)",
    (() => {
      const r = parseAssertionSummary("...\n총 16건, PASS 15, FAIL 1\n");
      return r !== null && r.total === 16 && r.pass === 15 && r.skip === 0 && r.fail === 1;
    })()
  );

  // parseAssertionSummary — SKIP 그룹 있는 형태.
  check(
    "parseAssertionSummary: SKIP 있는 요약(총 N건, PASS X, SKIP Y, FAIL Z)",
    (() => {
      const r = parseAssertionSummary("...\n총 53건, PASS 52, SKIP 1, FAIL 0\n");
      return r !== null && r.total === 53 && r.pass === 52 && r.skip === 1 && r.fail === 0;
    })()
  );

  // parseAssertionSummary — 요약 줄 자체가 없으면 null(0건으로 추측하지 않음).
  check(
    "parseAssertionSummary: 요약 줄 없으면 null",
    parseAssertionSummary("some unrelated crash output\nStack trace...\n") === null
  );

  // ==================================================
  // 요구사항 A — script exit 0, PASS 3 / FAIL 0 → 정상 집계
  // ==================================================
  {
    const r = [
      fakeResult({
        name: "a",
        exitCode: 0,
        assertionSummary: { total: 3, pass: 3, skip: 0, fail: 0 },
      }),
    ];
    const agg = aggregateScriptResults(r);
    check(
      "A) exit 0 / PASS 3 FAIL 0 → PASS_SCRIPTS=1, FAIL_SCRIPTS=0, PASS_ASSERTIONS=3, FAIL_ASSERTIONS=0",
      agg.totalScripts === 1 &&
        agg.passScripts === 1 &&
        agg.failScripts === 0 &&
        agg.passAssertions === 3 &&
        agg.failAssertions === 0 &&
        agg.skipAssertions === 0 &&
        agg.assertionSummaryParseErrors === 0
    );
  }

  // ==================================================
  // 요구사항 B — script exit 1, PASS 2 / FAIL 1 → FAIL_SCRIPTS=1이면서도 assertion은
  // 정확히 합산돼야 한다(이전 버그: exitCode!==0이면 assertion 자체가 통째로 누락됐다).
  // ==================================================
  {
    const r = [
      fakeResult({
        name: "b",
        exitCode: 1,
        assertionSummary: { total: 3, pass: 2, skip: 0, fail: 1 },
      }),
    ];
    const agg = aggregateScriptResults(r);
    check(
      "B) exit 1 / PASS 2 FAIL 1 → FAIL_SCRIPTS=1, PASS_ASSERTIONS=2, FAIL_ASSERTIONS=1(누락 없음)",
      agg.totalScripts === 1 &&
        agg.passScripts === 0 &&
        agg.failScripts === 1 &&
        agg.passAssertions === 2 &&
        agg.failAssertions === 1 &&
        agg.skipAssertions === 0 &&
        agg.assertionSummaryParseErrors === 0
    );
  }

  // ==================================================
  // 요구사항 C — script exit 1인데 assertion summary 자체가 없음(파싱 실패) → 조용히
  // 0건으로 처리하지 않고 ASSERTION_SUMMARY_PARSE_ERRORS로 명확히 드러나야 한다.
  // ==================================================
  {
    const r = [
      fakeResult({
        name: "c",
        exitCode: 1,
        assertionSummary: null,
      }),
    ];
    const agg = aggregateScriptResults(r);
    check(
      "C) exit 1 / 요약 파싱 실패 → FAIL_SCRIPTS=1, ASSERTION_SUMMARY_PARSE_ERRORS=1(0건으로 조용히 흡수되지 않음)",
      agg.totalScripts === 1 &&
        agg.failScripts === 1 &&
        agg.passAssertions === 0 &&
        agg.failAssertions === 0 &&
        agg.skipAssertions === 0 &&
        agg.assertionSummaryParseErrors === 1
    );
  }

  // exit 0인데 요약 파싱에 실패하는 경우도 동일하게 fail-closed해야 한다(성공 스크립트라고
  // 봐줘서 0건으로 조용히 처리하지 않음).
  {
    const r = [fakeResult({ name: "d", exitCode: 0, assertionSummary: null })];
    const agg = aggregateScriptResults(r);
    check(
      "C-변형) exit 0인데 요약 파싱 실패 → PASS_SCRIPTS=1이어도 ASSERTION_SUMMARY_PARSE_ERRORS=1",
      agg.passScripts === 1 && agg.assertionSummaryParseErrors === 1 && agg.passAssertions === 0
    );
  }

  // ==================================================
  // 혼합 — script 성공/실패 집계와 assertion 성공/실패 집계가 서로 독립적으로 정확히
  // 계산되는지, 여러 스크립트를 합산했을 때도 유지되는지 확인한다.
  // ==================================================
  {
    const r = [
      fakeResult({ name: "ok1", exitCode: 0, assertionSummary: { total: 10, pass: 10, skip: 0, fail: 0 } }),
      fakeResult({ name: "ok2-with-skip", exitCode: 0, assertionSummary: { total: 5, pass: 4, skip: 1, fail: 0 } }),
      fakeResult({ name: "broken", exitCode: 1, assertionSummary: { total: 16, pass: 15, skip: 0, fail: 1 } }),
    ];
    const agg = aggregateScriptResults(r);
    check(
      "혼합) 3개 스크립트(성공2/실패1) → TOTAL=3, PASS_SCRIPTS=2, FAIL_SCRIPTS=1",
      agg.totalScripts === 3 && agg.passScripts === 2 && agg.failScripts === 1
    );
    check(
      "혼합) assertion 합산은 script exit code와 무관하게 전부 더해짐: PASS=29, FAIL=1, SKIP=1",
      agg.passAssertions === 29 && agg.failAssertions === 1 && agg.skipAssertions === 1
    );
    check("혼합) 파싱 실패 없음 → ASSERTION_SUMMARY_PARSE_ERRORS=0", agg.assertionSummaryParseErrors === 0);
  }

  console.log("\n=== full-regression-runner 집계 로직 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
