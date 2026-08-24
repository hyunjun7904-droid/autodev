import { evaluateGptBudgetGuard, resolveGptBudgetGuardConfig, estimateInputTokens } from "./gpt-budget-guard";
import type { GptBudgetGuardConfig } from "./gpt-budget-guard";

// GPT Reviewer API Budget Guard(SI-3.8A) — 순수 deterministic 단위 테스트.
// 이 파일은 실제 OpenAI API를 전혀 호출하지 않는다 — evaluateGptBudgetGuard()/
// resolveGptBudgetGuardConfig()는 로컬 계산만 하는 순수 함수다(네트워크/파일/환경 I/O 없음,
// resolveGptBudgetGuardConfig는 인자로 넘긴 격리된 env 객체만 읽는다 — 실제 process.env를
// 건드리지 않는다).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const SMALL_CONFIG: GptBudgetGuardConfig = { maxPayloadChars: 1000, maxEstimatedInputTokens: 1000 };

// 1) 작은 payload → ALLOW
function scenario1_smallPayloadAllows(): void {
  const result = evaluateGptBudgetGuard(
    { instructions: "짧은 instructions", input: "짧은 input", reviewCycle: 1 },
    resolveGptBudgetGuardConfig({})
  );
  check("1) 작은 payload는 ALLOW", result.verdict === "ALLOW");
  check("1) ALLOW 결과에는 blockCode가 없음", result.blockCode === undefined);
  check("1) payloadChars가 실제 글자수와 일치", result.payloadChars === "짧은 instructions".length + "짧은 input".length);
}

// 2) char limit 초과 → BLOCK(PAYLOAD_CHARS_EXCEEDED)
function scenario2_charLimitExceededBlocks(): void {
  const config: GptBudgetGuardConfig = { maxPayloadChars: 10, maxEstimatedInputTokens: 1_000_000 };
  const result = evaluateGptBudgetGuard({ instructions: "0123456789012345", input: "", reviewCycle: 1 }, config);
  check("2) char 상한 초과는 BLOCK", result.verdict === "BLOCK");
  check("2) blockCode === PAYLOAD_CHARS_EXCEEDED", result.blockCode === "PAYLOAD_CHARS_EXCEEDED");
  check("2) reason이 문자열로 채워짐", typeof result.reason === "string" && result.reason.length > 0);
  check("2) BLOCK 결과에 payloadChars/estimatedInputTokens/config가 포함됨", result.payloadChars === 16 && typeof result.estimatedInputTokens === "number" && result.config === config);
}

// 3) estimated token limit 초과(글자수 자체는 상한 이내) → BLOCK(ESTIMATED_TOKENS_EXCEEDED)
function scenario3_tokenLimitExceededBlocks(): void {
  const config: GptBudgetGuardConfig = { maxPayloadChars: 1_000_000, maxEstimatedInputTokens: 5 };
  // "input" 30자 → estimateInputTokens(30자) = ceil(30/3) = 10 > 5(한도), payloadChars(30) << maxPayloadChars.
  const input = "0".repeat(30);
  const result = evaluateGptBudgetGuard({ instructions: "", input, reviewCycle: 1 }, config);
  check("3) 글자수는 상한 이내(char 검사를 통과)", result.payloadChars <= config.maxPayloadChars);
  check("3) 추정 토큰 상한 초과는 BLOCK", result.verdict === "BLOCK");
  check("3) blockCode === ESTIMATED_TOKENS_EXCEEDED", result.blockCode === "ESTIMATED_TOKENS_EXCEEDED");
  check("3) estimateInputTokens(30자, 3자/토큰) === 10", estimateInputTokens(input) === 10);
}

// 4) invalid env(NaN/0/음수/비정상적으로 큰 값) → 안전한 Core 기본값으로 fallback(조용히
//    무제한/0으로 풀리지 않음)
function scenario4_invalidEnvFallsBackSafely(): void {
  const defaultConfig = resolveGptBudgetGuardConfig({});

  const nanConfig = resolveGptBudgetGuardConfig({ AUTODEV_GPT_MAX_PAYLOAD_CHARS: "not-a-number" });
  check("4) NaN 값은 기본값으로 fallback", nanConfig.maxPayloadChars === defaultConfig.maxPayloadChars);

  const zeroConfig = resolveGptBudgetGuardConfig({ AUTODEV_GPT_MAX_PAYLOAD_CHARS: "0" });
  check("4) 0은 기본값으로 fallback(0 이하 허용 안 함)", zeroConfig.maxPayloadChars === defaultConfig.maxPayloadChars);

  const negativeConfig = resolveGptBudgetGuardConfig({ AUTODEV_GPT_MAX_PAYLOAD_CHARS: "-100" });
  check("4) 음수는 기본값으로 fallback", negativeConfig.maxPayloadChars === defaultConfig.maxPayloadChars);

  const hugeConfig = resolveGptBudgetGuardConfig({ AUTODEV_GPT_MAX_PAYLOAD_CHARS: "999999999999" });
  check("4) 비정상적으로 큰 값(ceiling 초과)은 기본값으로 fallback(그대로 허용 안 함)", hugeConfig.maxPayloadChars === defaultConfig.maxPayloadChars);

  const floatConfig = resolveGptBudgetGuardConfig({ AUTODEV_GPT_MAX_ESTIMATED_INPUT_TOKENS: "12.5" });
  check("4) 정수가 아닌 값은 기본값으로 fallback", floatConfig.maxEstimatedInputTokens === defaultConfig.maxEstimatedInputTokens);

  const emptyConfig = resolveGptBudgetGuardConfig({ AUTODEV_GPT_MAX_PAYLOAD_CHARS: "" });
  check("4) 빈 문자열은 기본값으로 fallback", emptyConfig.maxPayloadChars === defaultConfig.maxPayloadChars);

  const validConfig = resolveGptBudgetGuardConfig({ AUTODEV_GPT_MAX_PAYLOAD_CHARS: "12345", AUTODEV_GPT_MAX_ESTIMATED_INPUT_TOKENS: "6789" });
  check("4) 유효한 env 값은 그대로 반영됨(fail-open 아님을 확인하는 대조군)", validConfig.maxPayloadChars === 12345 && validConfig.maxEstimatedInputTokens === 6789);
}

// 5) 정확히 boundary인 값 — 상한과 정확히 같으면 ALLOW, 1 넘으면 BLOCK
function scenario5_boundaryValues(): void {
  const config: GptBudgetGuardConfig = { maxPayloadChars: 12, maxEstimatedInputTokens: 1_000_000 };
  const exact = evaluateGptBudgetGuard({ instructions: "012345", input: "678901", reviewCycle: 1 }, config); // 정확히 12자
  check("5) payloadChars === maxPayloadChars → ALLOW", exact.payloadChars === 12 && exact.verdict === "ALLOW");

  const overByOne = evaluateGptBudgetGuard({ instructions: "0123456", input: "678901", reviewCycle: 1 }, config); // 13자
  check("5) payloadChars === maxPayloadChars+1 → BLOCK", overByOne.payloadChars === 13 && overByOne.verdict === "BLOCK");

  const tokenConfig: GptBudgetGuardConfig = { maxPayloadChars: 1_000_000, maxEstimatedInputTokens: 10 };
  const exactTokens = evaluateGptBudgetGuard({ instructions: "", input: "0".repeat(30), reviewCycle: 1 }, tokenConfig); // ceil(30/3)=10
  check("5) estimatedInputTokens === maxEstimatedInputTokens → ALLOW", exactTokens.estimatedInputTokens === 10 && exactTokens.verdict === "ALLOW");

  const overTokens = evaluateGptBudgetGuard({ instructions: "", input: "0".repeat(31), reviewCycle: 1 }, tokenConfig); // ceil(31/3)=11
  check("5) estimatedInputTokens === 한도+1 → BLOCK", overTokens.estimatedInputTokens === 11 && overTokens.verdict === "BLOCK");
}

// 6) 회귀 방지 — Core 기본값이 gpt-reviewer.ts가 실제로 허용하는 정상 최대 payload보다
//    작아서 정상 크기 diff를 오탐 BLOCK하는 일이 다시 생기지 않는지 직접 검증한다(SI-3.8A
//    code-review에서 최초 기본값 100_000자가 실제 worst-case(약 131_000자)보다 작아 정상
//    payload를 BLOCK하는 것이 실제로 확인됐다). gpt-reviewer.ts를 import하지 않고(이 파일은
//    순수 단위 테스트로 유지) 그 파일이 실제로 쓰는 상한을 리터럴로 직접 재현한다:
//    tracked diff(MAX_DIFF_CHARS=65_000) + untracked 신규 파일 예산(readUntrackedFiles
//    totalBudgetChars=MAX_DIFF_CHARS=65_000) + rules(MAX_RULES_CHARS=2_000) = 132_000자,
//    여기에 task/summary/testsSummary/instructions 등 나머지 섹션 여유분(3_000자)을 더한다.
function scenario6_realisticWorstCaseLegitimatePayloadAllows(): void {
  const trackedDiffWorstCase = "0".repeat(65_000);
  const untrackedFilesWorstCase = "0".repeat(65_000);
  const rulesWorstCase = "0".repeat(2_000);
  const remainingSectionsOverhead = "0".repeat(3_000);
  const result = evaluateGptBudgetGuard(
    {
      instructions: rulesWorstCase,
      input: trackedDiffWorstCase + untrackedFilesWorstCase + remainingSectionsOverhead,
      reviewCycle: 1,
    },
    resolveGptBudgetGuardConfig({})
  );
  check(
    "6) 실제 gpt-reviewer.ts worst-case 조합(약 135_000자)이 Core 기본값에서 ALLOW(오탐 BLOCK 없음)",
    result.verdict === "ALLOW"
  );
}

// 관측 필드(reviewCycle/gptCallCount/gptRawCallTotal)가 결과에 그대로 전달되는지 — 새 gate를
// 추가하지 않으면서도(그 값들의 별도 상한은 orchestrator.ts가 이미 강제) 결과에서 확인 가능함.
function scenarioObservabilityFieldsPassThrough(): void {
  const result = evaluateGptBudgetGuard(
    { instructions: "a", input: "b", reviewCycle: 3, gptCallCount: 2, gptRawCallTotal: 4 },
    resolveGptBudgetGuardConfig({})
  );
  check("관측용 reviewCycle/gptCallCount/gptRawCallTotal이 결과에 그대로 담김", result.reviewCycle === 3 && result.gptCallCount === 2 && result.gptRawCallTotal === 4);
}

// 동일 입력 → 동일 결과(진짜 tokenizer/외부 API 호출 없이 완전히 결정적임을 확인).
function scenarioDeterministic(): void {
  const config = resolveGptBudgetGuardConfig({ AUTODEV_GPT_MAX_PAYLOAD_CHARS: "500", AUTODEV_GPT_MAX_ESTIMATED_INPUT_TOKENS: "200" });
  const a = evaluateGptBudgetGuard({ instructions: "동일 입력 테스트", input: "반복 호출", reviewCycle: 5 }, config);
  const b = evaluateGptBudgetGuard({ instructions: "동일 입력 테스트", input: "반복 호출", reviewCycle: 5 }, config);
  check("동일 입력에 대해 항상 동일한 verdict/payloadChars/estimatedInputTokens", a.verdict === b.verdict && a.payloadChars === b.payloadChars && a.estimatedInputTokens === b.estimatedInputTokens);
}

function main(): void {
  scenario1_smallPayloadAllows();
  scenario2_charLimitExceededBlocks();
  scenario3_tokenLimitExceededBlocks();
  scenario4_invalidEnvFallsBackSafely();
  scenario5_boundaryValues();
  scenario6_realisticWorstCaseLegitimatePayloadAllows();
  scenarioObservabilityFieldsPassThrough();
  scenarioDeterministic();

  console.log("\n=== GPT Budget Guard 단위 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
