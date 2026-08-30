import { tmpdir } from "node:os";
import type { ClaudeResult } from "./types";
import { log, sanitizeForLog } from "./logger";
import { resolveTrustedExecutable } from "./trusted-executable-resolver";
import { runSubprocessWithTimeout } from "./subprocess-runner";
import type { SubprocessOutcome } from "./subprocess-runner";

// 실제 Claude Code CLI subprocess runner. AUTOMATION_DRY_RUN=false일 때만 orchestrator가
// 이 모듈을 선택한다(§ orchestrator.ts). task는 절대 shell 문자열로 이어붙이지 않고,
// spawn()에 인자 배열로만 전달한다(shell:false 고정) — shell injection 여지를 원천 차단한다.
// OPENAI/ANTHROPIC/SUPABASE secret은 CLI 인자에 절대 넣지 않는다(애초에 이 러너가
// 다루는 인자는 -p/--output-format/--tools/task 문자열뿐이다).

export type ClaudeErrorCode =
  | "CLI_NOT_FOUND"
  | "AUTH_REQUIRED"
  | "USAGE_LIMIT"
  | "TIMEOUT"
  | "NON_ZERO_EXIT"
  | "INVALID_OUTPUT"
  // AutoDev Core Maintenance — Canonical Stop Path(2026-08-31). subprocess-runner.ts의
  // outcome.aborted=true(호출부가 넘긴 abortSignal 발동)를 그대로 옮긴 값이다. TIMEOUT과
  // 절대 같은 값으로 합치지 않는다 — DEVELOPER_TRANSIENT_ERROR_CODES/isTransientDeveloperFailure
  // (§ claude-developer.ts)가 이 값을 재시도 대상으로 절대 취급하지 않도록 분리한다.
  | "ABORTED"
  // SI-3.6(Executable Identity Trust) — trusted-executable-resolver.ts의 실패 코드를 그대로
  // 재사용한다(목록을 복제하지 않음) — "claude"라는 이름이 허용됐다는 사실과 "실제로 어떤
  // 파일이 실행될지 신뢰할 수 있는가"는 별개 질문이다(§ trusted-executable-resolver.ts).
  | "TRUSTED_EXECUTABLE_NOT_FOUND"
  | "EXECUTABLE_IDENTITY_UNTRUSTED"
  | "EXECUTABLE_SHADOWING_DETECTED";

export interface RealClaudeResult extends ClaudeResult {
  errorCode?: ClaudeErrorCode;
}

// SI-3.6 bounded review(chunk1 HIGH, 3라운드 미해결) 지적 반영 — 브랜드 타입(2라운드에서
// 도입)은 "실수로" 우회하는 것만 막았을 뿐, createTestOnlyCommandOverride() 자체가 여전히
// production 모듈에서 exported된 정상 함수라 어떤 production 코드도 이를 import해 의도적으로
// 호출하면 trust resolution을 완전히 우회할 수 있었다("정상 API가 제공하는 우회"라는 정확한
// 지적). 이 override 메커니즘 자체를 완전히 제거한다 — runClaudeTask()는 이제 항상
// resolveTrustedClaudeCommand()가 결정한 경로만 쓴다. "존재하지 않는 claude 바이너리"를
// 실제 subprocess로 재현해야 하는 테스트(spec-planner-tests.ts)는 AUTODEV_TRUSTED_CLAUDE_PATH
// (trusted-executable-resolver.ts가 이미 구조적 검증을 거치는 명시적 override 채널, § 파일
// 상단 EXPLICIT_OVERRIDE_ENV_VARS)를 존재하지 않는 경로로 설정해 동일한 "실제 subprocess
// 실행 시도 → 실패 분류" 경로를 재현한다 — 새 우회 채널을 만들지 않고 기존에 이미 검증된
// 채널 하나만 쓴다.
export interface RunOptions {
  timeoutMs?: number;
  /** SI-3.6 bounded review(chunk1 HIGH) 지적 반영 — 호출부가 알고 있는 target project
   *  root(들)을 명시적으로 넘기면 resolveTrustedClaudeCommand()의 PATH 탐색에서 그 경로도
   *  함께 배제한다. 지정하지 않으면 process.cwd()/OS temp만 배제한다(§ 아래 함수 설명). */
  excludedRoots?: string[];
}

const DEFAULT_TIMEOUT_MS = 120_000;

const USAGE_LIMIT_PATTERNS = [
  /usage limit/i,
  /rate limit/i,
  /quota/i,
  /사용량\s*제한/i,
  /5-hour limit/i,
  /weekly limit/i,
  /session limit/i,
  /usage cap/i,
  /upgrade (your|to a) plan/i,
  /limit reached/i,
  /reached your limit/i,
  /try again (later|in)/i,
  /limit will reset/i,
];
// 대화형 선택 메뉴(예: "1) ... 2) ... 3) ...")는 non-interactive(-p) 모드에서 응답할 방법이
// 없어(stdin을 즉시 닫아버림) 그대로 두면 timeout으로만 잡힌다. 이런 numbered-menu 형태
// 자체를 usage limit의 강한 신호로 취급해 TIMEOUT 대신 USAGE_LIMIT으로 분류한다 —
// 정확한 문구를 몰라도(추측 금지 원칙) "번호 선택지가 여러 개 나열된 형태"라는 구조적
// 특징만으로 탐지한다.
const INTERACTIVE_MENU_PATTERN = /(^|\n)\s*1[).]\s.*(\n|\r\n).*\s*2[).]\s.*(\n|\r\n).*\s*3[).]\s/s;

const AUTH_REQUIRED_PATTERNS = [
  /not authenticated/i,
  /please (run|log in)/i,
  /invalid api key/i,
  /authentication required/i,
  /로그인이\s*필요/i,
];

export function classifyFailureText(combinedOutput: string): ClaudeErrorCode {
  if (USAGE_LIMIT_PATTERNS.some((p) => p.test(combinedOutput)) || INTERACTIVE_MENU_PATTERN.test(combinedOutput)) {
    return "USAGE_LIMIT";
  }
  if (AUTH_REQUIRED_PATTERNS.some((p) => p.test(combinedOutput))) return "AUTH_REQUIRED";
  return "NON_ZERO_EXIT";
}

// TIMEOUT 경로 전용: 진짜 usage-limit/interactive 메뉴로 인한 hang인지 확인하되,
// 강한 신호(패턴 매칭)가 없으면 일반 NON_ZERO_EXIT로 오분류하지 않고 null을 반환해
// 기존 TIMEOUT 분류를 그대로 유지한다(네트워크 지연 등 진짜 timeout과 구분).
export function detectUsageLimitSignal(combinedOutput: string): boolean {
  return USAGE_LIMIT_PATTERNS.some((p) => p.test(combinedOutput)) || INTERACTIVE_MENU_PATTERN.test(combinedOutput);
}

export interface ParsedClaudeUsage {
  model?: { provider: string; name: string };
  tokenUsage?: { inputTokens?: number; outputTokens?: number };
  durationMs?: number;
}

export type ParsedClaudeJsonOutput = ({ ok: true; summary: string } & ParsedClaudeUsage) | { ok: false };

// Phase G Task G3.1 — `claude -p --output-format json`의 실제 JSON 결과는 summary(result)
// 외에도 modelUsage(model 이름을 key로 하는 실측 usage)/usage(input_tokens/output_tokens)/
// duration_ms를 담아 반환한다(claude CLI 바이너리에 이 필드명이 실제로 존재함을 직접
// 확인했다 — 문서/기억만으로 채우지 않았다). 이 함수는 그 구조화된 JSON 필드만 읽는다 —
// 화면 문자열을 정규식으로 스크래핑하지 않는다(§ 요구사항: 취약한 terminal scraping 금지).
// modelUsage에 model이 정확히 1개일 때만 채운다 — 이 developer/read-only 호출은 항상
// `--tools ""`라 subagent가 모델을 추가로 섞을 경로 자체가 없지만, 혹시 여러 개가 관측되면
// 추측 없이 undefined로 남긴다(§ 요구사항: 값이 여러 개면 하나를 대표로 고르지 않는다).
export function parseClaudeJsonOutput(stdout: string): ParsedClaudeJsonOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false };
  const obj = parsed as Record<string, unknown>;
  const summary =
    typeof obj.result === "string" ? obj.result : typeof obj.summary === "string" ? obj.summary : null;
  if (summary === null) return { ok: false };

  const result: { ok: true; summary: string } & ParsedClaudeUsage = { ok: true, summary };

  if (obj.modelUsage && typeof obj.modelUsage === "object") {
    const modelNames = Object.keys(obj.modelUsage as Record<string, unknown>);
    if (modelNames.length === 1) result.model = { provider: "anthropic", name: modelNames[0] };
  }

  if (obj.usage && typeof obj.usage === "object") {
    const usage = obj.usage as Record<string, unknown>;
    const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
    const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
    if (inputTokens !== undefined || outputTokens !== undefined) result.tokenUsage = { inputTokens, outputTokens };
  }

  if (typeof obj.duration_ms === "number") result.durationMs = obj.duration_ms;

  return result;
}

function makeError(errorCode: ClaudeErrorCode, message: string, stdout = "", stderr = ""): RealClaudeResult {
  log(`claude CLI 오류(${errorCode})`, { message });
  return {
    success: false,
    summary: message,
    changedFiles: [],
    tests: [],
    rawOutput: sanitizeForLog(`stdout:\n${stdout}\n\nstderr:\n${stderr}`),
    errorCode,
  };
}

/**
 * subprocess-runner.ts의 범용 SubprocessOutcome(신뢰 여부와 무관, spawn/timeout/출력만 관측)을
 * claude CLI 전용 판정(RealClaudeResult)으로 변환하는 순수 함수 — 실제 spawn을 전혀 하지
 * 않는다. runner-tests.ts가 이 함수와 runSubprocessWithTimeout()을 직접 조합해, claude-
 * runner.ts에서 "임의 command를 spawn하는 exported 함수"를 노출하지 않고도 CLI_NOT_FOUND/
 * TIMEOUT/USAGE_LIMIT/NON_ZERO_EXIT 분류를 실제 subprocess로 검증할 수 있다(§ SI-3.6 bounded
 * review chunk1 HIGH, 4라운드 지적 반영).
 */
export function classifySubprocessOutcome(outcome: SubprocessOutcome, timeoutMs: number): RealClaudeResult {
  if (outcome.spawnErrorCode !== undefined) {
    const errorCode = outcome.spawnErrorCode === "ENOENT" ? "CLI_NOT_FOUND" : "NON_ZERO_EXIT";
    return makeError(
      errorCode,
      `subprocess 시작 실패: ${sanitizeForLog(outcome.spawnErrorMessage ?? "")}`,
      outcome.stdout,
      outcome.stderr
    );
  }

  // AutoDev Core Maintenance — Canonical Stop Path(2026-08-31). outcome.aborted는 반드시
  // outcome.timedOut보다 먼저 확인한다 — 호출부가 abortSignal로 child를 SIGKILL했을 때도
  // 내부적으로는 timedOut이 함께 true일 수 있는 race가 있을 수 있어(§ subprocess-runner.ts
  // 두 플래그가 독립적으로 set됨), "의도된 정상 중단"을 "진짜 timeout"으로 오분류해
  // isTransientDeveloperFailure(§ claude-developer.ts)가 재시도하게 만들면 안 된다.
  if (outcome.aborted) {
    return makeError("ABORTED", "호출부 요청으로 정상 중단됨(canonical stop)", outcome.stdout, outcome.stderr);
  }
  if (outcome.timedOut) {
    // stdin은 이미 즉시 닫았으므로 대화형 프롬프트가 떠도 응답할 방법이 없다 — 그대로면
    // timeoutMs까지 hang하다 강제 종료된다. 그 hang의 원인이 usage-limit/대화형 선택 메뉴로
    // 보이면 TIMEOUT이 아니라 USAGE_LIMIT으로 분류해 재시도 로직(orchestrator의
    // WAITING_CLAUDE_LIMIT)이 정확히 잡게 한다.
    const errorCode = detectUsageLimitSignal(`${outcome.stdout}\n${outcome.stderr}`) ? "USAGE_LIMIT" : "TIMEOUT";
    return makeError(errorCode, `timeout ${timeoutMs}ms 초과로 강제 종료됨`, outcome.stdout, outcome.stderr);
  }
  if (outcome.code !== 0) {
    const errorCode = classifyFailureText(`${outcome.stdout}\n${outcome.stderr}`);
    return makeError(errorCode, `exit code ${outcome.code}`, outcome.stdout, outcome.stderr);
  }

  const parsed = parseClaudeJsonOutput(outcome.stdout);
  if (!parsed.ok) {
    return makeError("INVALID_OUTPUT", "JSON 결과 파싱 실패", outcome.stdout, outcome.stderr);
  }

  log("claude CLI 호출 완료", { exitCode: outcome.code });
  return {
    success: true,
    summary: parsed.summary,
    changedFiles: [],
    tests: [],
    rawOutput: sanitizeForLog(outcome.stdout),
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.tokenUsage ? { tokenUsage: parsed.tokenUsage } : {}),
    ...(parsed.durationMs !== undefined ? { durationMs: parsed.durationMs } : {}),
  };
}

// SI-3.6(Executable Identity Trust) bounded review(chunk1 HIGH, 4라운드) 지적 반영 — 이 함수는
// 더 이상 export되지 않는다. runClaudeTask()만 이 함수를 쓰고, 항상 resolveTrustedClaudeCommand()가
// 결정한 경로만 넘긴다 — 다른 어떤 파일도 이 함수를 통해 임의 command를 spawn할 방법이 없다
// (subprocess-runner.ts의 runSubprocessWithTimeout()은 claude 신뢰와 무관한 범용 유틸리티라
// 이 우려 대상이 아니다 — § 그 파일 상단 설명).
async function execAndClassify(command: string, args: string[], timeoutMs: number, stdinInput?: string): Promise<RealClaudeResult> {
  const outcome = await runSubprocessWithTimeout(command, args, timeoutMs, stdinInput);
  return classifySubprocessOutcome(outcome, timeoutMs);
}

// SI-3.6(Executable Identity Trust) — RunOptions.command가 지정되지 않은 실제 운용 경로는
// bare "claude" 문자열을 spawn에 그대로 넘기지 않는다(그동안은 PATH/cwd 탐색에 전적으로
// 위임했다 — project root/cwd/OS temp에 심어진 가짜 claude.exe가 대신 실행될 수 있는
// 구조였다). claude-developer.ts의 callClaude()도 동일한 위험을 가진 별도 호출부라 이
// 함수를 그대로 재사용한다(판정 로직을 두 곳에 복제하지 않는다).
export function resolveTrustedClaudeCommand(
  excludedRoots: string[] = []
): { ok: true; command: string } | { ok: false; result: RealClaudeResult } {
  const resolved = resolveTrustedExecutable("claude", {
    excludedRoots: [process.cwd(), tmpdir(), ...excludedRoots],
  });
  if (!resolved.ok) {
    return {
      ok: false,
      result: makeError(resolved.code, `신뢰된 claude CLI 실행 파일을 확인하지 못했습니다: ${resolved.reason}`),
    };
  }
  return { ok: true, command: resolved.spawnCommand };
}

export async function runClaudeTask(
  task: string,
  attempt: number,
  opts: RunOptions = {}
): Promise<RealClaudeResult> {
  void attempt;
  const args = ["-p", task, "--output-format", "json", "--tools", "", "--no-session-persistence"];
  const trusted = resolveTrustedClaudeCommand(opts.excludedRoots ?? []);
  if (!trusted.ok) return trusted.result;
  return execAndClassify(trusted.command, args, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}
