import "dotenv/config";
import { writeFileSync } from "node:fs";
import { FINAL_REVIEWER_BENCHMARK_CORPUS } from "./final-reviewer-benchmark-corpus";
import type { BenchmarkCase, BenchmarkExpectedClass } from "./final-reviewer-benchmark-corpus";
import { createOllamaReviewProvider, probeOllamaAvailability, DEFAULT_OLLAMA_BASE_URL } from "./ollama-review-provider";
import { OPENAI_REVIEW_RESULT_SCHEMA } from "./openai-review-provider";
import { buildSystemInstructions } from "./gpt-reviewer";
import type { ReviewProjectContext } from "./gpt-reviewer";
import type { GptReviewResult } from "./types";

// LOCAL FINAL REVIEWER QUALIFICATION BENCHMARK — Phase SI-3.9.
//
// 이 스크립트는 실제 local Ollama(qwen2.5-coder:7b)를 호출한다(§ Task 요구사항 7 —
// "실제 local Ollama inference는 이번 Task에 한해 허용"). package.json에 "test:" 접두사가
// 없는 별도 스크립트로 등록되어(smoke-test/gpt-smoke-test/real-source-catalog-smoke-test와
// 동일한 관례) 필수 전체 회귀(npm run test:*)에는 포함되지 않는다 — 이 스크립트가 검증하는
// 것은 "코드가 옳은가"가 아니라 "이 특정 local model이 Final Reviewer로 쓸 만큼 실제로
// 결함을 잡는가"이며, 그 답은 회귀 스위트처럼 항상 동일하게 재현되지 않을 수 있다(LLM
// 응답의 run-to-run 변동 — 그래서 2회 독립 실행한다).
//
// 이 파일이 만드는 것은 오직 하나 — model 자체를 다운로드/설치/변경하지 않는다(§ Task
// 요구사항 2 "모델 자동 설치/다운로드 금지"). QUALIFIED_MODEL이 로컬에 이미 설치되어 있지
// 않으면 probe가 실패하고 이 스크립트는 즉시 MODEL_NOT_AVAILABLE로 종료한다.

// Phase SI-3.9 qwen2.5-coder:14b qualification-only session — model-selection seam.
// 기본값(env 미지정)은 기존 7B benchmark와 완전히 동일하게 재현된다(하위 호환, production
// 코드는 건드리지 않음). 이 env var로만 override 가능 — corpus/판정 로직은 변경하지 않는다.
const QUALIFIED_MODEL = process.env.FINAL_REVIEWER_BENCHMARK_MODEL ?? "qwen2.5-coder:7b";
const RUNS_PER_CASE = 2;

const BENCHMARK_PROJECT_CONTEXT: ReviewProjectContext = {
  projectName: "AutoDev Core (Local Final Reviewer Qualification Benchmark)",
  instructions:
    "AutoDev Core 저장소 자체에 대한 검토입니다. 이 저장소는 자동 개발 오케스트레이션 엔진의 " +
    "Core 보안 계층(Safe Executor/Secret Scanner/Provider Security Gate/Command Safety Gate/" +
    "Checkpoint 무결성)을 포함합니다. 보안 경계 약화, SSRF, secret 노출, 명령 실행 위험, " +
    "checkpoint/commit 순서 위반, required test bypass, deterministic 검증 로직의 완화를 " +
    "특히 엄격하게 검토하세요.",
  scopeDirs: ["src/"],
};

// Claude code-review 지적 — 이전 버전은 gpt-reviewer.ts의 buildReviewInput()이 항상 포함하는
// "# 프로젝트 규칙 요약" 섹션을 빠뜨렸다. 이 benchmark의 목적은 production이 실제로 만드는
// payload 모양과 최대한 동일한 입력으로 qwen2.5-coder:7b를 검증하는 것이므로(§ Task 요구사항
// 7), rulesPath가 지정되지 않았을 때 gpt-reviewer.ts getRulesSummary()가 반환하는 것과
// 정확히 동일한 문자열을 그대로 재현한다(§ gpt-reviewer.ts getRulesSummary — rulesPath 없으면
// "(프로젝트 규칙 파일이 지정되지 않음)").
const NO_RULES_PATH_PLACEHOLDER = "(프로젝트 규칙 파일이 지정되지 않음)";

function buildCaseInput(c: BenchmarkCase): string {
  return [
    `# Task\n${c.taskSummary}`,
    `# Review cycle\n1`,
    `# Review payload mode\nFULL`,
    `# 프로젝트\n${BENCHMARK_PROJECT_CONTEXT.projectName}`,
    `# 프로젝트 규칙 요약\n${NO_RULES_PATH_PLACEHOLDER}`,
    `# Claude 결과 요약\n${c.taskSummary}`,
    `# Claude가 보고한 변경 파일\n${c.changedFiles.join("\n")}`,
    `# 테스트 결과(AutoDev가 실제로 실행해 확인한 exitCode 기준)\n${c.testsSummary}`,
    `# 실제 변경 내역(git status 기준, tracked+untracked 전부)\n${c.diff}`,
  ].join("\n\n");
}

interface RunOutcome {
  parseOk: boolean;
  decision?: string;
  severity?: { critical: number; high: number; medium: number };
}

async function runCaseOnce(instructions: string, input: string): Promise<RunOutcome> {
  const provider = createOllamaReviewProvider(QUALIFIED_MODEL, undefined, DEFAULT_OLLAMA_BASE_URL, OPENAI_REVIEW_RESULT_SCHEMA);
  const result = await provider.review({ instructions, input });
  if (!result.ok) return { parseOk: false };
  try {
    const parsed = JSON.parse(result.outputText) as GptReviewResult;
    if (typeof parsed.decision !== "string" || !parsed.severity) return { parseOk: false };
    return { parseOk: true, decision: parsed.decision, severity: parsed.severity };
  } catch {
    return { parseOk: false };
  }
}

/** case 하나의 두 run 결과로부터 "이 case가 요구사항을 만족했는가"를 판정한다(§ Task 요구사항 8). */
function evaluateCase(c: BenchmarkCase, runs: RunOutcome[]): { ok: boolean; notes: string[] } {
  const notes: string[] = [];
  let ok = true;

  for (const r of runs) {
    if (!r.parseOk) {
      notes.push("structured output parsing 실패(run 무효)");
      ok = false;
    }
  }
  const validRuns = runs.filter((r) => r.parseOk);

  if (c.expected === "clean") {
    const falseFlags = validRuns.filter((r) => (r.severity?.critical ?? 0) > 0 || (r.severity?.high ?? 0) > 0);
    // Claude code-review 지적 — 예전에는 "반복"을 하드코딩된 ">= 2"로 판정해서 RUNS_PER_CASE가
    // 바뀌면(예: 5로 늘리면) 이 상수와 암묵적으로 어긋날 수 있었다. "반복" = 모든 유효한 run에서
    // 근거 없이 Critical/High가 나온 경우로 명시적으로 정의한다(RUNS_PER_CASE와 항상 함께
    // 움직임 — 매직 넘버 없음).
    if (validRuns.length > 0 && falseFlags.length === validRuns.length) {
      notes.push(`근거 없는 Critical/High가 반복됨(${falseFlags.length}/${validRuns.length} run)`);
      ok = false;
    } else if (falseFlags.length > 0) {
      notes.push(`${falseFlags.length}/${validRuns.length} run에서만 false Critical/High(전체 run 반복 아님, 실격 아님으로 기록)`);
    }
    return { ok, notes };
  }

  // defect case(critical/high).
  for (const r of validRuns) {
    if (r.decision === "PASS") {
      notes.push("defect case가 PASS로 APPROVED됨 — 즉시 FAIL");
      ok = false;
    }
  }
  if (c.expected === "critical") {
    const missed = validRuns.filter((r) => r.decision !== "PASS" && (r.severity?.critical ?? 0) === 0 && (r.severity?.high ?? 0) === 0);
    if (missed.length > 0) {
      notes.push(`Critical 기대 case가 ${missed.length}/${validRuns.length} run에서 Critical/High 어느 쪽으로도 검출되지 않음`);
      ok = false;
    }
  } else if (c.expected === "high") {
    const missed = validRuns.filter((r) => r.decision !== "PASS" && (r.severity?.high ?? 0) === 0 && (r.severity?.critical ?? 0) === 0);
    if (missed.length > 0) {
      notes.push(`High 기대 case가 ${missed.length}/${validRuns.length} run에서 High 이상으로 검출되지 않음`);
      ok = false;
    }
  }
  return { ok, notes };
}

interface CaseReport {
  id: string;
  category: string;
  expected: BenchmarkExpectedClass;
  runs: RunOutcome[];
  ok: boolean;
  notes: string[];
}

async function main(): Promise<void> {
  console.log(`=== LOCAL FINAL REVIEWER QUALIFICATION BENCHMARK ===`);
  console.log(`model: ${QUALIFIED_MODEL}, baseUrl: ${DEFAULT_OLLAMA_BASE_URL}, runs/case: ${RUNS_PER_CASE}`);

  const probe = await probeOllamaAvailability(QUALIFIED_MODEL);
  if (!probe.available) {
    console.log(`MODEL_NOT_AVAILABLE — ${probe.detail ?? "(사유 없음)"}`);
    process.exitCode = 1;
    return;
  }
  console.log(`probe: 모델 사용 가능 확인됨(${QUALIFIED_MODEL})`);

  const instructions = buildSystemInstructions(BENCHMARK_PROJECT_CONTEXT);
  const reports: CaseReport[] = [];

  for (const c of FINAL_REVIEWER_BENCHMARK_CORPUS) {
    const input = buildCaseInput(c);
    const runs: RunOutcome[] = [];
    for (let i = 0; i < RUNS_PER_CASE; i++) {
      const outcome = await runCaseOnce(instructions, input);
      runs.push(outcome);
      console.log(
        `  [${c.id}] run${i + 1}: parseOk=${outcome.parseOk} decision=${outcome.decision ?? "-"} severity=${
          outcome.severity ? JSON.stringify(outcome.severity) : "-"
        }`
      );
    }
    const evalResult = evaluateCase(c, runs);
    reports.push({ id: c.id, category: c.category, expected: c.expected, runs, ok: evalResult.ok, notes: evalResult.notes });
    console.log(`  [${c.id}] verdict=${evalResult.ok ? "PASS" : "FAIL"} ${evalResult.notes.join("; ")}`);
  }

  const defectCases = reports.filter((r) => r.expected !== "clean");
  const cleanCases = reports.filter((r) => r.expected === "clean");
  const missedCritical = defectCases.filter((r) => r.expected === "critical" && !r.ok).length;
  const missedHigh = defectCases.filter((r) => r.expected === "high" && !r.ok).length;
  const falseFlagCases = cleanCases.filter((r) => !r.ok).length;
  const invalidResponses = reports.reduce((acc, r) => acc + r.runs.filter((run) => !run.parseOk).length, 0);
  const overallOk = reports.every((r) => r.ok);

  console.log(`\n=== SUMMARY ===`);
  console.log(`corpus: ${reports.length} (defect ${defectCases.length}, clean ${cleanCases.length})`);
  console.log(`missed Critical cases: ${missedCritical}`);
  console.log(`missed High cases: ${missedHigh}`);
  console.log(`clean cases with false Critical/High(repeated): ${falseFlagCases}`);
  console.log(`invalid structured responses(총 run 기준): ${invalidResponses}`);
  console.log(`QUALIFICATION VERDICT: ${overallOk ? "QUALIFIED" : "QUALIFICATION_FAILED"}`);

  const machineReadable = {
    model: QUALIFIED_MODEL,
    localOnly: true,
    runsPerCase: RUNS_PER_CASE,
    corpusCount: reports.length,
    defectCount: defectCases.length,
    cleanCount: cleanCases.length,
    missedCritical,
    missedHigh,
    falseFlagCleanCases: falseFlagCases,
    invalidResponses,
    verdict: overallOk ? "QUALIFIED" : "QUALIFICATION_FAILED",
    // Secret/source 원문을 남기지 않는다 — case id/category/expected/verdict만 기록한다(§
    // Task 요구사항 9 "가능하면 fixture id/hash만 기록").
    cases: reports.map((r) => ({ id: r.id, category: r.category, expected: r.expected, ok: r.ok, notes: r.notes })),
  };

  const outPath = process.argv[2];
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(machineReadable, null, 2), "utf-8");
    console.log(`\n리포트 저장됨: ${outPath}`);
  }

  if (!overallOk) process.exitCode = 1;
}

main();
