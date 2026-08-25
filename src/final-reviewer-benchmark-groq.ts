import "dotenv/config";
import { writeFileSync } from "node:fs";
import { FINAL_REVIEWER_BENCHMARK_CORPUS } from "./final-reviewer-benchmark-corpus";
import type { BenchmarkExpectedClass } from "./final-reviewer-benchmark-corpus";
import { BENCHMARK_PROJECT_CONTEXT, RUNS_PER_CASE, buildCaseInput, evaluateCase } from "./final-reviewer-benchmark";
import type { RunOutcome, CaseReport } from "./final-reviewer-benchmark";
import { createGroqReviewProvider } from "./groq-review-provider";
import { OPENAI_REVIEW_RESULT_SCHEMA } from "./openai-review-provider";
import { buildSystemInstructions } from "./gpt-reviewer";
import { GROQ_API_KEY_ENV } from "./real-provider-pool";
import { resolveGroqZdrVerification } from "./provider-pool-security-metadata";
import type { GptReviewResult } from "./types";

// GROQ FINAL REVIEWER QUALIFICATION BENCHMARK.
//
// final-reviewer-benchmark.ts(Phase SI-3.9, Ollama qualification)와 정확히 동일한 corpus(§
// final-reviewer-benchmark-corpus.ts, FINAL_REVIEWER_BENCHMARK_CORPUS 13건 — 이 파일에서 전혀
// 수정하지 않는다)와 정확히 동일한 PASS 판정 함수(evaluateCase, final-reviewer-benchmark.ts에서
// import — 재구현/복제 없음, PASS 기준 drift 방지)를 그대로 재사용한다. 이 파일이 새로 하는 일은
// 오직 하나 — provider transport를 Ollama 대신 실제 production Groq adapter
// (groq-review-provider.ts createGroqReviewProvider, chat-completion-review-provider.ts 공용
// factory)로 바꾸는 것뿐이다. 새 Reviewer subsystem을 만들지 않는다 — provider/corpus/evaluator
// 전부 기존 파일 그대로다.
//
// production wiring(final reviewer provider 자동 선택/routing)은 이 저장소에 아직 존재하지
// 않는다(final-reviewer-provider-selection.ts 없음) — 이 스크립트는 그 wiring을 만들거나
// 건드리지 않는다. 오직 "이 모델이 Final Reviewer 후보로 쓸 만큼 실제로 결함을 잡는가"만
// 측정한다.
//
// Ollama/OpenAI/OpenRouter/NVIDIA는 호출하지 않는다 — createGroqReviewProvider 하나만 쓴다.

const QUALIFIED_MODEL = process.env.FINAL_REVIEWER_BENCHMARK_GROQ_MODEL ?? "openai/gpt-oss-120b";

// chat-completion-review-provider.ts(Groq/OpenRouter/NVIDIA 공용)는 Ollama의 `format`(구조화
// 출력 JSON Schema)과 달리 response_format을 전송하지 않는다(§ 그 파일 상단 주석 — production
// wiring을 이 Task에서 바꾸지 않는다, 새 파라미터를 추가하지 않는다). 그래서 이 스크립트는 그
// provider factory를 전혀 수정하지 않고, 대신 이 benchmark 전용 system instructions에만
// 명시적인 출력 형식 지시를 추가한다 — production이 실제로 보내는 buildSystemInstructions()
// 결과는 그대로 재사용하고(복제 없음), 그 뒤에 이 스크립트 자신의 텍스트만 덧붙인다. 이 추가는
// gpt-reviewer.ts/chat-completion-review-provider.ts 어디에도 저장되지 않는다 — 오직 이
// 스크립트가 호출하는 요청에만 존재한다.
function buildGroqInstructions(): string {
  const base = buildSystemInstructions(BENCHMARK_PROJECT_CONTEXT);
  return `${base}

# 출력 형식(필수)
설명, 서론, markdown 코드펜스 없이 아래 JSON Schema를 정확히 만족하는 JSON 객체 "하나만"
출력하세요:
${JSON.stringify(OPENAI_REVIEW_RESULT_SCHEMA)}`;
}

/** 모델이 markdown 코드펜스(\`\`\`json ... \`\`\`)로 감싸 응답하는 경우를 대비해, 순수 JSON
 *  파싱이 실패하면 첫 \`{\`부터 마지막 \`}\`까지만 다시 시도한다. 이 관용은 이 benchmark
 *  스크립트 자신의 파싱에만 적용되며, gpt-reviewer.ts의 production JSON.parse(outputText)
 *  로직은 전혀 건드리지 않는다. */
function tryParseReviewResult(outputText: string): GptReviewResult | undefined {
  const attempts = [outputText];
  const first = outputText.indexOf("{");
  const last = outputText.lastIndexOf("}");
  if (first >= 0 && last > first) attempts.push(outputText.slice(first, last + 1));
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as GptReviewResult;
    } catch {
      // 다음 attempt 시도.
    }
  }
  return undefined;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// Groq free-tier rate limit(요청/분, 토큰/분)에 걸린 transient 실패(429/5xx/timeout)를 실제
// qualification 실패로 오판하지 않기 위한 최소 재시도(§ gpt-reviewer.ts
// reviewClaudeResultWithRetry와 동일한 정신 — "일시적 오류는 재시도, PASS 기준/판정 로직은
// 절대 바꾸지 않는다"). 이 backoff 자체는 evaluateCase()에 전달되는 RunOutcome을 만들기 전
// 단계일 뿐이라 PASS 기준에 영향을 주지 않는다.
const TRANSIENT_RETRY_WAITS_MS = [15_000, 30_000, 45_000];

interface FailureDiagnostics {
  transportFailures: number; // provider.review() 자체가 실패(ok:false) — 429/5xx/timeout/AUTH 등.
  malformedJsonFailures: number; // provider.review()는 성공했지만 응답이 유효한 review JSON이 아님.
}

async function runCaseOnce(instructions: string, input: string, diag: FailureDiagnostics): Promise<RunOutcome> {
  const provider = createGroqReviewProvider(QUALIFIED_MODEL);
  for (let attempt = 0; ; attempt++) {
    const result = await provider.review({ instructions, input });
    if (!result.ok) {
      if (result.transient && attempt < TRANSIENT_RETRY_WAITS_MS.length) {
        console.log(`    (transient ${result.errorCode}, 재시도 ${attempt + 1}/${TRANSIENT_RETRY_WAITS_MS.length})`);
        await sleep(TRANSIENT_RETRY_WAITS_MS[attempt]);
        continue;
      }
      diag.transportFailures++;
      return { parseOk: false };
    }
    const parsed = tryParseReviewResult(result.outputText);
    if (!parsed || typeof parsed.decision !== "string" || !parsed.severity) {
      diag.malformedJsonFailures++;
      return { parseOk: false };
    }
    return { parseOk: true, decision: parsed.decision, severity: parsed.severity };
  }
}

async function main(): Promise<void> {
  console.log(`=== GROQ FINAL REVIEWER QUALIFICATION BENCHMARK ===`);
  console.log(`model: ${QUALIFIED_MODEL}, endpoint: Groq OpenAI-compatible chat completions, runs/case: ${RUNS_PER_CASE}`);

  const apiKey = process.env[GROQ_API_KEY_ENV];
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    console.log(`MISSING_API_KEY — ${GROQ_API_KEY_ENV}가 설정되지 않았습니다.`);
    process.exitCode = 1;
    return;
  }
  const zdr = resolveGroqZdrVerification();
  if (!zdr.verified) {
    console.log(`ZDR_NOT_VERIFIED — AUTODEV_GROQ_ZDR_VERIFIED=true가 설정되지 않았습니다.`);
    process.exitCode = 1;
    return;
  }
  console.log(`precondition: GROQ_API_KEY 존재 확인됨(값 미출력), ZDR verified=true`);

  const instructions = buildGroqInstructions();
  const reports: CaseReport[] = [];
  const diag: FailureDiagnostics = { transportFailures: 0, malformedJsonFailures: 0 };
  let firstRequest = true;

  for (const c of FINAL_REVIEWER_BENCHMARK_CORPUS) {
    const input = buildCaseInput(c);
    const runs: RunOutcome[] = [];
    for (let i = 0; i < RUNS_PER_CASE; i++) {
      // Groq free-tier 분당 요청/토큰 한도에 미리 여유를 두기 위한 고정 pacing(재시도와 별개).
      if (!firstRequest) await sleep(2_000);
      firstRequest = false;
      const outcome = await runCaseOnce(instructions, input, diag);
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

  const defectCases = reports.filter((r) => r.expected !== ("clean" as BenchmarkExpectedClass));
  const cleanCases = reports.filter((r) => r.expected === ("clean" as BenchmarkExpectedClass));
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
  console.log(`  ┗ transport failure(429/5xx/timeout 등, 재시도 소진 후): ${diag.transportFailures}`);
  console.log(`  ┗ malformed JSON(응답은 성공했지만 파싱 실패): ${diag.malformedJsonFailures}`);
  console.log(`QUALIFICATION VERDICT: ${overallOk ? "QUALIFIED" : "QUALIFICATION_FAILED"}`);

  const machineReadable = {
    provider: "groq",
    model: QUALIFIED_MODEL,
    runsPerCase: RUNS_PER_CASE,
    corpusCount: reports.length,
    defectCount: defectCases.length,
    cleanCount: cleanCases.length,
    missedCritical,
    missedHigh,
    falseFlagCleanCases: falseFlagCases,
    invalidResponses,
    transportFailures: diag.transportFailures,
    malformedJsonFailures: diag.malformedJsonFailures,
    verdict: overallOk ? "QUALIFIED" : "QUALIFICATION_FAILED",
    // Secret/source 원문을 남기지 않는다 — case id/category/expected/verdict만 기록한다.
    cases: reports.map((r) => ({ id: r.id, category: r.category, expected: r.expected, ok: r.ok, notes: r.notes })),
  };

  const outPath = process.argv[2];
  if (outPath) {
    writeFileSync(outPath, JSON.stringify(machineReadable, null, 2), "utf-8");
    console.log(`\n리포트 저장됨: ${outPath}`);
  }

  if (!overallOk) process.exitCode = 1;
}

if (require.main === module) {
  main();
}
