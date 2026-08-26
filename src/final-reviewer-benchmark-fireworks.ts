import "dotenv/config";
import { writeFileSync } from "node:fs";
import { FINAL_REVIEWER_BENCHMARK_CORPUS } from "./final-reviewer-benchmark-corpus";
import type { BenchmarkExpectedClass } from "./final-reviewer-benchmark-corpus";
import { BENCHMARK_PROJECT_CONTEXT, RUNS_PER_CASE, buildCaseInput, evaluateCase } from "./final-reviewer-benchmark";
import type { RunOutcome, CaseReport } from "./final-reviewer-benchmark";
import { createFireworksReviewProvider, FIREWORKS_API_KEY_ENV } from "./fireworks-review-provider";
import { OPENAI_REVIEW_RESULT_SCHEMA } from "./openai-review-provider";
import { buildSystemInstructions } from "./gpt-reviewer";
import { resolveFireworksZdrVerification } from "./provider-pool-security-metadata";
import type { ReviewProviderTokenUsage } from "./review-provider";
import type { GptReviewResult } from "./types";

// FIREWORKS GPT-OSS-120B FINAL REVIEWER QUALIFICATION BENCHMARK.
//
// final-reviewer-benchmark-groq.ts(Groq openai/gpt-oss-120b qualification)와 정확히 동일한
// 원칙을 따른다 — final-reviewer-benchmark.ts(Ollama qualification, Phase SI-3.9)의 corpus(§
// final-reviewer-benchmark-corpus.ts, FINAL_REVIEWER_BENCHMARK_CORPUS 13건 — 이 파일에서 전혀
// 수정하지 않는다)와 정확히 동일한 PASS 판정 함수(evaluateCase, final-reviewer-benchmark.ts에서
// import — 재구현/복제 없음, PASS 기준 drift 방지)를 그대로 재사용한다. 이 파일이 새로 하는 일은
// 오직 하나 — provider transport를 Fireworks Direct(공식 OpenAI 호환
// `/inference/v1/chat/completions`, fireworks-review-provider.ts)로 바꾸는 것뿐이다. 새 Reviewer
// subsystem을 만들지 않는다 — provider/corpus/evaluator 전부 기존 파일 그대로다.
//
// 이 스크립트는 qualification 전용이다 — production Final Reviewer 선택은 여전히 Groq
// openai/gpt-oss-120b다(§ .claude/CLAUDE.md, final-reviewer-provider-selection.ts 없음). quota
// ladder/fallback 자동 wiring도 만들지 않는다. Groq/OpenAI/Ollama/OpenRouter/NVIDIA/Cloudflare는
// 호출하지 않는다 — createFireworksReviewProvider 하나만 쓴다.

const QUALIFIED_MODEL = process.env.FINAL_REVIEWER_BENCHMARK_FIREWORKS_MODEL ?? "accounts/fireworks/models/gpt-oss-120b";

// 공식 pricing(2026-08-26 확인, Task 요구사항에 명시된 gpt-oss-120b 공식 가격 그대로 인코딩 —
// 임의 숫자 생성 없음): input $0.15/1M tokens, output $0.60/1M tokens.
const USD_PER_INPUT_TOKEN = 0.15 / 1_000_000;
const USD_PER_OUTPUT_TOKEN = 0.6 / 1_000_000;

// chat-completion-review-provider.ts(Groq/OpenRouter/NVIDIA/Cloudflare/Fireworks 공용)는
// response_format을 전송하지 않는다(§ 그 파일 상단 주석 — production wiring을 이 Task에서
// 바꾸지 않는다, 새 파라미터를 추가하지 않는다). 그래서 Groq/Cloudflare qualification과 동일하게,
// production이 실제로 보내는 buildSystemInstructions() 결과에 이 benchmark 전용 명시적 출력
// 형식 지시만 덧붙인다 — 이 추가는 gpt-reviewer.ts/chat-completion-review-provider.ts 어디에도
// 저장되지 않는다.
function buildFireworksInstructions(): string {
  const base = buildSystemInstructions(BENCHMARK_PROJECT_CONTEXT);
  return `${base}

# 출력 형식(필수)
설명, 서론, markdown 코드펜스 없이 아래 JSON Schema를 정확히 만족하는 JSON 객체 "하나만"
출력하세요:
${JSON.stringify(OPENAI_REVIEW_RESULT_SCHEMA)}`;
}

/** 모델이 markdown 코드펜스(```json ... ```)로 감싸 응답하는 경우를 대비한 관용적 파싱(§
 *  final-reviewer-benchmark-groq.ts와 동일한 관용, 이 benchmark 스크립트 자신의 파싱에만
 *  적용된다 — gpt-reviewer.ts의 production JSON.parse(outputText) 로직은 전혀 건드리지 않는다). */
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
// Fireworks Direct의 분당 요청/토큰 한도는 계정별로 다르다(공식 문서가 고정 free-tier 숫자를
// 제시하지 않음) — 그래도 transient 실패(429/5xx/timeout)를 실제 qualification 실패로 오판하지
// 않기 위해 Groq/Cloudflare qualification과 동일한 정신의 최소 재시도를 둔다.
const TRANSIENT_RETRY_WAITS_MS = [10_000, 20_000, 30_000];

interface FailureDiagnostics {
  transportFailures: number; // provider.review() 자체가 실패(ok:false) — 429/5xx/timeout/AUTH 등.
  malformedJsonFailures: number; // provider.review()는 성공했지만 응답이 유효한 review JSON이 아님.
}

interface UsageAccumulator {
  apiCalls: number; // provider.review() 실제 호출 횟수(재시도 포함 — 실제 HTTP 시도 수).
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

function addUsage(acc: UsageAccumulator, usage: ReviewProviderTokenUsage | undefined): void {
  if (!usage) return;
  if (typeof usage.inputTokens === "number") acc.inputTokens += usage.inputTokens;
  if (typeof usage.cachedInputTokens === "number") acc.cachedInputTokens += usage.cachedInputTokens;
  if (typeof usage.outputTokens === "number") acc.outputTokens += usage.outputTokens;
  if (typeof usage.totalTokens === "number") acc.totalTokens += usage.totalTokens;
}

async function runCaseOnce(instructions: string, input: string, diag: FailureDiagnostics, usage: UsageAccumulator): Promise<RunOutcome> {
  const provider = createFireworksReviewProvider(QUALIFIED_MODEL);
  for (let attempt = 0; ; attempt++) {
    usage.apiCalls++;
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
    addUsage(usage, result.tokenUsage);
    const parsed = tryParseReviewResult(result.outputText);
    if (!parsed || typeof parsed.decision !== "string" || !parsed.severity) {
      diag.malformedJsonFailures++;
      return { parseOk: false };
    }
    return { parseOk: true, decision: parsed.decision, severity: parsed.severity };
  }
}

interface ProbeResult {
  ok: boolean;
  detail: string;
}

/** STEP 5 — 전체 benchmark 전 실제 API 1회만 최소 probe한다(§ 요구사항 "probe 실패 시 전체
 *  benchmark를 실행하지 않는다"). 재시도하지 않는다 — probe는 "지금 이 순간 호출 가능한가"만
 *  확인하면 충분하다. */
async function runProbe(instructions: string, usage: UsageAccumulator): Promise<ProbeResult> {
  const provider = createFireworksReviewProvider(QUALIFIED_MODEL);
  const probeInput = [`# Task\n이것은 probe 요청입니다. 실제 검토 대상 코드는 없습니다.`, `# 실제 변경 내역\n(diff 없음 — probe)`].join("\n\n");
  usage.apiCalls++;
  const result = await provider.review({ instructions, input: probeInput });
  if (!result.ok) {
    return { ok: false, detail: `transport 실패 — errorCode=${result.errorCode}, transient=${result.transient}, requestAttempted=${result.requestAttempted}` };
  }
  addUsage(usage, result.tokenUsage);
  const parsed = tryParseReviewResult(result.outputText);
  if (!parsed || typeof parsed.decision !== "string" || !parsed.severity) {
    return { ok: false, detail: "구조화된 JSON 파싱 실패(envelope는 성공했지만 review JSON 형태가 아님)" };
  }
  const usageNote = result.tokenUsage
    ? `input=${result.tokenUsage.inputTokens ?? "-"} cached=${result.tokenUsage.cachedInputTokens ?? "-"} output=${result.tokenUsage.outputTokens ?? "-"} total=${
        result.tokenUsage.totalTokens ?? "-"
      }`
    : "usage 필드 없음";
  return { ok: true, detail: `probe 성공 — decision=${parsed.decision}, model echo=${result.model?.name ?? "-"}, usage(${usageNote})` };
}

async function main(): Promise<void> {
  console.log(`=== FIREWORKS GPT-OSS-120B FINAL REVIEWER QUALIFICATION BENCHMARK ===`);
  console.log(`model: ${QUALIFIED_MODEL}, endpoint: Fireworks Direct OpenAI-compatible chat completions, runs/case: ${RUNS_PER_CASE}`);

  const apiKey = process.env[FIREWORKS_API_KEY_ENV];
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    console.log(`MISSING_API_KEY — ${FIREWORKS_API_KEY_ENV}가 설정되지 않았습니다.`);
    process.exitCode = 1;
    return;
  }
  const zdr = resolveFireworksZdrVerification();
  if (!zdr.verified) {
    console.log(`ZDR_NOT_VERIFIED — AUTODEV_FIREWORKS_ZDR_VERIFIED=true가 설정되지 않았습니다.`);
    console.log(`(이 env var는 "Fireworks Chat Completions API만 쓰고 FireOptimizer/Response API store=true 같은 opt-in 로깅 기능을 켜지 않았다"는 조건을 사람이 직접 확인했을 때만 true로 설정하는 local seam입니다.)`);
    process.exitCode = 1;
    return;
  }
  console.log(`precondition: FIREWORKS_API_KEY 존재 확인됨(값 미출력), direct-inference ZDR verified=true`);

  const instructions = buildFireworksInstructions();
  const usage: UsageAccumulator = { apiCalls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 };

  console.log(`\n--- STEP 5: MINIMAL API PROBE ---`);
  const probe = await runProbe(instructions, usage);
  console.log(`probe: ${probe.detail}`);
  if (!probe.ok) {
    console.log(`PROBE_FAILED — 전체 benchmark를 실행하지 않습니다.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n--- STEP 6: FULL QUALIFICATION (${FINAL_REVIEWER_BENCHMARK_CORPUS.length} cases x ${RUNS_PER_CASE} runs) ---`);
  const reports: CaseReport[] = [];
  const diag: FailureDiagnostics = { transportFailures: 0, malformedJsonFailures: 0 };
  let firstRequest = true;

  for (const c of FINAL_REVIEWER_BENCHMARK_CORPUS) {
    const input = buildCaseInput(c);
    const runs: RunOutcome[] = [];
    for (let i = 0; i < RUNS_PER_CASE; i++) {
      // 최소 pacing(재시도와 별개) — 계정별 rate limit에 여유를 둔다.
      if (!firstRequest) await sleep(1_500);
      firstRequest = false;
      const outcome = await runCaseOnce(instructions, input, diag, usage);
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

  const estimatedCostUsd = usage.inputTokens * USD_PER_INPUT_TOKEN + usage.outputTokens * USD_PER_OUTPUT_TOKEN;

  console.log(`\n=== SUMMARY ===`);
  console.log(`corpus: ${reports.length} (defect ${defectCases.length}, clean ${cleanCases.length})`);
  console.log(`missed Critical cases: ${missedCritical}`);
  console.log(`missed High cases: ${missedHigh}`);
  console.log(`clean cases with false Critical/High(repeated): ${falseFlagCases}`);
  console.log(`invalid structured responses(총 run 기준): ${invalidResponses}`);
  console.log(`  ┗ transport failure(429/5xx/timeout 등, 재시도 소진 후): ${diag.transportFailures}`);
  console.log(`  ┗ malformed JSON(응답은 성공했지만 파싱 실패): ${diag.malformedJsonFailures}`);
  console.log(`QUALIFICATION VERDICT: ${overallOk ? "QUALIFIED" : "QUALIFICATION_FAILED"}`);
  console.log(`\n=== USAGE / COST (STEP 8) ===`);
  console.log(`total API calls(probe 포함, 재시도 포함): ${usage.apiCalls}`);
  console.log(`input tokens: ${usage.inputTokens}, cached input tokens: ${usage.cachedInputTokens}, output tokens: ${usage.outputTokens}, total tokens: ${usage.totalTokens}`);
  console.log(`estimated cost(공식 가격표 input $0.15/1M, output $0.60/1M 기준): $${estimatedCostUsd.toFixed(4)}`);
  console.log(`account credit 잔액은 API로 안전하게 확인할 방법이 없어 조회하지 않음(추측 금지).`);

  const machineReadable = {
    provider: "fireworks",
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
    usage: {
      totalApiCalls: usage.apiCalls,
      inputTokens: usage.inputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      estimatedCostUsd,
    },
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
