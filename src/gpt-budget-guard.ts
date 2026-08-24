import { log } from "./logger";

// GPT Reviewer API Budget Guard — Phase SI-3.8A.
//
// 실제 OpenAI Responses API(responses.create())를 호출하기 *직전*에만 쓰이는 deterministic
// preflight다. 여기서 하는 일은 정확히 하나: "이번 호출을 실제로 보내면 예산/요청 크기
// 한도를 넘을 위험이 있는가"를 로컬 계산만으로 판정하고, 위험하면 API를 아예 호출하지 않고
// BLOCK을 반환한다. 실제 tokenizer/OpenAI API를 호출해 계산하지 않는다 — 토큰 추정은 항상
// 보수적(실제보다 크게 잡는 방향)인 근사치이며 정확한 billing 계산이라고 주장하지 않는다.
//
// 이 파일은 비용 절감 알고리즘(예: diff 압축, incremental review)을 구현하지 않는다 — 오직
// "호출 전에 위험을 감지해 막는" 안전장치다. gpt-reviewer.ts의 reviewClaudeResultOnce()
// (OpenAI를 실제로 호출하는 유일한 지점)가 이 모듈의 evaluateGptBudgetGuard()를 호출한다.
// agent-orchestrator.ts는 gpt-reviewer.ts의 동일한 reviewClaudeResult 함수를 그대로 재사용
// 하므로(별도 OpenAI 호출 경로가 없음) 이 Guard를 별도로 다시 구현하지 않는다.

export type GptBudgetGuardVerdict = "ALLOW" | "BLOCK";

export type GptBudgetGuardBlockCode = "PAYLOAD_CHARS_EXCEEDED" | "ESTIMATED_TOKENS_EXCEEDED";

export interface GptBudgetGuardConfig {
  maxPayloadChars: number;
  maxEstimatedInputTokens: number;
}

export interface GptBudgetGuardInput {
  /** OpenAI responses.create()에 실제로 전달될 instructions 필드 원문. */
  instructions: string;
  /** OpenAI responses.create()에 실제로 전달될 input 필드 원문. */
  input: string;
  /** 현재 review cycle(관측/사유 메시지에만 쓰인다 — 이 값 자체로 BLOCK하지 않는다.
   *  reviewCycle 자체의 상한은 policy.ts의 MAX_REVIEW_CYCLES가 이미 별도로 강제한다). */
  reviewCycle: number;
  /** 현재 Task의 GPT review "cycle" 호출 총합(orchestrator.ts MAX_GPT_CALLS이 이미 별도로
   *  강제) — 관측 목적으로만 결과에 포함한다. */
  gptCallCount?: number;
  /** 현재 Task의 실제 API 통신(재시도 포함) 총합(orchestrator.ts MAX_GPT_RAW_CALLS이 이미
   *  별도로 강제) — 관측 목적으로만 결과에 포함한다. */
  gptRawCallTotal?: number;
}

export interface GptBudgetGuardResult {
  verdict: GptBudgetGuardVerdict;
  payloadChars: number;
  estimatedInputTokens: number;
  config: GptBudgetGuardConfig;
  reviewCycle: number;
  gptCallCount?: number;
  gptRawCallTotal?: number;
  /** verdict==="BLOCK"일 때만 채워진다 — 문자열 비교가 아니라 이 typed code로 분기해야 한다. */
  blockCode?: GptBudgetGuardBlockCode;
  /** 사람이 읽는 사유 설명(로그/feedback에 그대로 노출해도 안전 — payload 원문은 포함하지
   *  않는다, 글자수/토큰수 등 집계값만 담는다). */
  reason?: string;
}

// Core 기본값 — 환경변수가 없거나 무효할 때 쓰인다. gpt-reviewer.ts의 diff 관련 상한만으로도
// 이미 최대 130_000자다: tracked diff(MAX_DIFF_CHARS=65_000) + untracked 신규 파일 예산
// (readUntrackedFiles totalBudgetChars=MAX_DIFF_CHARS=65_000, git-changes.ts). 실제로 "사진
// 갤러리/업로드 기능, 신규 파일 12개"(gpt-reviewer.ts 상단 주석) 같은 정상 규모 task의 diff가
// 이 조합 전체를 채울 수 있다. 여기에 rules(MAX_RULES_CHARS=2_000) + summary/testsSummary/
// changedFiles/instructions(전부 크기가 작게 유지되는 섹션들)가 더해진다.
//
// 반면 `# Task\n${task}` 섹션(buildReviewInput, gpt-reviewer.ts)의 원본 task 문자열 자체는
// 이 파일 어디에서도 길이가 제한되지 않는다 — task-registry.ts/self-dev Task Prompt는
// development-operations.md의 Hybrid Thin Prompt 원칙(코드/Gate로 이미 강제된 규칙은 매
// Task Prompt에서 반복하지 않음)에 따라 실무상 수 KB 수준으로 유지되지만, 그 상한이 코드로
// 강제되는 것은 아니다. 아래 200_000은 diff 최대치(130_000)에 rules(2_000) +
// task/summary/testsSummary 등 나머지 섹션 전체를 위한 넉넉한 여유분(약 68_000자, 이 저장소의
// 실제 Task Prompt 관행보다 수십 배 큰 여유)을 더한 값이다 — "정상적으로 크지만 사전에
// 설계상 허용된" diff 규모의 payload를 오탐 BLOCK하지 않게 하는 것이 목적이다. 다만 이 여유분을
// 초과할 정도로 비정상적으로 긴 task 문자열이 큰 diff와 결합되면 이 기본값에서도 여전히 BLOCK
// 될 수 있다 — 이는 오탐이 아니라 guard의 의도된 동작이다(payload 총량이 실제로 크면 diff가
// 원인이든 task 문자열이 원인이든 동일하게 사전 차단하는 것이 이 Guard의 목적). 그런 정당한
// 대형 task가 실제로 필요해지면 AUTODEV_GPT_MAX_PAYLOAD_CHARS로 명시적으로 올려야 한다(조용한
// 자동 확장 없음).
const DEFAULT_MAX_PAYLOAD_CHARS = 200_000;
// CHARS_PER_TOKEN_ESTIMATE(=3) 기준 200_000자는 약 66_667토큰이다. 이 값을 그대로 상한으로
// 쓰면(=66_667 이상) char 상한이 항상 먼저 걸려 이 검사가 사실상 죽은 코드가 된다 — 일부러
// char 상한의 등가 글자수(60_000*3=180_000자)보다 낮게 잡아, 180_000~200_000자 구간(정상
// 최대치는 여전히 넉넉히 통과하는 범위)에서는 이 검사가 실제로 먼저 BLOCK을 발생시키도록
// 한다(두 검사 모두 실제로 도달 가능하게 함).
const DEFAULT_MAX_ESTIMATED_INPUT_TOKENS = 60_000;

// 환경변수로 설정 가능한 상한의 절대 상한(ceiling) — 이보다 큰 값을 env로 넣어도 그대로
// 받아들이지 않는다("비정상적으로 큰 값을 조용히 허용하지 않는다"). env가 이 ceiling을
// 넘으면 무효 값으로 취급해 Core 기본값으로 fallback한다(clamp가 아니라 fallback — 사용자가
// 실수로 자릿수를 잘못 입력했을 가능성을 "그나마 안전한 값을 그대로 쓰는 것"보다 "알려진
// 안전한 기본값을 쓰는 것"으로 처리한다).
const CEILING_MAX_PAYLOAD_CHARS = 2_000_000;
const CEILING_MAX_ESTIMATED_INPUT_TOKENS = 1_000_000;

// 보수적(실제보다 토큰 수를 크게 추정하는 방향) 근사치 — 영어 기준 실제 평균은 대략
// 4자/토큰이지만, review payload에는 한국어 instructions/diff 텍스트가 섞여 있어 실제
// 토큰/글자 비율이 더 높을(글자당 토큰이 더 많을) 수 있다. 나눗셈 분모를 작게 잡을수록
// 추정 토큰 수가 커지므로(=보수적) 3을 쓴다. 실제 tokenizer가 아니다.
const CHARS_PER_TOKEN_ESTIMATE = 3;

export function estimateInputTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

function resolvePositiveIntEnv(envValue: string | undefined, envName: string, defaultValue: number, ceiling: number): number {
  if (envValue === undefined || envValue.trim().length === 0) return defaultValue;
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    log(`GPT Budget Guard: ${envName}이 유효하지 않아(값="${envValue}") Core 기본값(${defaultValue})을 사용합니다.`);
    return defaultValue;
  }
  if (parsed > ceiling) {
    log(`GPT Budget Guard: ${envName}(${parsed})이 허용 상한(${ceiling})을 초과해 Core 기본값(${defaultValue})을 사용합니다.`);
    return defaultValue;
  }
  return parsed;
}

/** 환경변수를 한 곳에서 읽어 Budget Guard 제한값을 결정한다 — fail-open 없음(무효 값은
 *  항상 안전한 Core 기본값으로 대체될 뿐, 검사를 건너뛰거나 무제한으로 풀리지 않는다).
 *  env를 지정하지 않으면 process.env를 쓴다(테스트는 격리된 객체를 주입해 실제
 *  process.env를 건드리지 않고 검증할 수 있다). */
export function resolveGptBudgetGuardConfig(env: NodeJS.ProcessEnv = process.env): GptBudgetGuardConfig {
  return {
    maxPayloadChars: resolvePositiveIntEnv(
      env.AUTODEV_GPT_MAX_PAYLOAD_CHARS,
      "AUTODEV_GPT_MAX_PAYLOAD_CHARS",
      DEFAULT_MAX_PAYLOAD_CHARS,
      CEILING_MAX_PAYLOAD_CHARS
    ),
    maxEstimatedInputTokens: resolvePositiveIntEnv(
      env.AUTODEV_GPT_MAX_ESTIMATED_INPUT_TOKENS,
      "AUTODEV_GPT_MAX_ESTIMATED_INPUT_TOKENS",
      DEFAULT_MAX_ESTIMATED_INPUT_TOKENS,
      CEILING_MAX_ESTIMATED_INPUT_TOKENS
    ),
  };
}

/**
 * 완전히 로컬 deterministic 계산 — 실제 tokenizer나 OpenAI API를 호출하지 않는다. 동일
 * 입력에는 항상 동일한 결과를 반환한다. 정확히 한도(=)인 값은 ALLOW다(한도 "초과"만 BLOCK).
 */
export function evaluateGptBudgetGuard(input: GptBudgetGuardInput, config: GptBudgetGuardConfig): GptBudgetGuardResult {
  const payloadChars = input.instructions.length + input.input.length;
  const estimatedInputTokens = estimateInputTokens(input.instructions) + estimateInputTokens(input.input);

  const base = {
    payloadChars,
    estimatedInputTokens,
    config,
    reviewCycle: input.reviewCycle,
    gptCallCount: input.gptCallCount,
    gptRawCallTotal: input.gptRawCallTotal,
  };

  if (payloadChars > config.maxPayloadChars) {
    return {
      ...base,
      verdict: "BLOCK",
      blockCode: "PAYLOAD_CHARS_EXCEEDED",
      reason: `review payload 글자수(${payloadChars})가 설정된 상한(${config.maxPayloadChars})을 초과했습니다(reviewCycle=${input.reviewCycle}).`,
    };
  }
  if (estimatedInputTokens > config.maxEstimatedInputTokens) {
    return {
      ...base,
      verdict: "BLOCK",
      blockCode: "ESTIMATED_TOKENS_EXCEEDED",
      reason: `추정 입력 토큰 수(${estimatedInputTokens}, 보수적 근사치)가 설정된 상한(${config.maxEstimatedInputTokens})을 초과했습니다(reviewCycle=${input.reviewCycle}).`,
    };
  }
  return { ...base, verdict: "ALLOW" };
}
