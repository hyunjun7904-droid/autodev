import { spawn } from "node:child_process";
import type { ClaudeResult } from "./types";
import { log, sanitizeForLog } from "./logger";

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
  | "INVALID_OUTPUT";

export interface RealClaudeResult extends ClaudeResult {
  errorCode?: ClaudeErrorCode;
}

export interface RunOptions {
  timeoutMs?: number;
  /** 테스트 전용 override — 기본값은 항상 "claude". 실제 운용 코드는 절대 바꾸지 않는다. */
  command?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // stdout/stderr 각각 2MB로 제한

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

// command/args를 그대로 받는 하위 레벨 실행기 — 테스트에서 실제 "claude" 바이너리를
// 호출하지 않고도(존재하지 않는 커맨드, 짧게 도는 더미 커맨드 등으로) spawn 실패/timeout
// 경로를 실제로 검증할 수 있도록 분리했다. 운용 코드(runClaudeTask)는 항상 command="claude"로만 호출한다.
export function execAndClassify(
  command: string,
  args: string[],
  timeoutMs: number,
  stdinInput?: string
): Promise<RealClaudeResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { shell: false });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      const errorCode = code === "ENOENT" ? "CLI_NOT_FOUND" : "NON_ZERO_EXIT";
      resolve(makeError(errorCode, `subprocess 생성 실패: ${sanitizeForLog(String(e))}`));
      return;
    }

    // 프롬프트가 큰 경우 CLI 인자로 넘기면 OS 명령행 길이 제한(Windows 등)에 걸릴 수 있다
    // (실제로 ENAMETOOLONG 발생 확인) — stdin으로 전달해 이 제한을 피한다.
    if (stdinInput !== undefined) {
      child.stdin?.write(stdinInput, "utf-8");
      child.stdin?.end();
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const code = err.code === "ENOENT" ? "CLI_NOT_FOUND" : "NON_ZERO_EXIT";
      resolve(makeError(code, `subprocess 시작 실패: ${sanitizeForLog(err.message)}`));
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf-8");
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (timedOut) {
        // stdin은 이미 즉시 닫았으므로(§ 위 write/end) 대화형 프롬프트가 떠도 응답할 방법이
        // 없다 — 그대로면 timeoutMs까지 hang하다 여기서 강제 종료된다. 그 hang의 원인이
        // usage-limit/대화형 선택 메뉴로 보이면 TIMEOUT이 아니라 USAGE_LIMIT으로 분류해
        // 재시도 로직(orchestrator의 WAITING_CLAUDE_LIMIT)이 정확히 잡게 한다.
        const errorCode = detectUsageLimitSignal(`${stdout}\n${stderr}`) ? "USAGE_LIMIT" : "TIMEOUT";
        resolve(makeError(errorCode, `timeout ${timeoutMs}ms 초과로 강제 종료됨`, stdout, stderr));
        return;
      }
      if (code !== 0) {
        const errorCode = classifyFailureText(`${stdout}\n${stderr}`);
        resolve(makeError(errorCode, `exit code ${code}`, stdout, stderr));
        return;
      }

      const parsed = parseClaudeJsonOutput(stdout);
      if (!parsed.ok) {
        resolve(makeError("INVALID_OUTPUT", "JSON 결과 파싱 실패", stdout, stderr));
        return;
      }

      log("claude CLI 호출 완료", { exitCode: code });
      resolve({
        success: true,
        summary: parsed.summary,
        changedFiles: [],
        tests: [],
        rawOutput: sanitizeForLog(stdout),
        ...(parsed.model ? { model: parsed.model } : {}),
        ...(parsed.tokenUsage ? { tokenUsage: parsed.tokenUsage } : {}),
        ...(parsed.durationMs !== undefined ? { durationMs: parsed.durationMs } : {}),
      });
    });
  });
}

export async function runClaudeTask(
  task: string,
  attempt: number,
  opts: RunOptions = {}
): Promise<RealClaudeResult> {
  void attempt;
  const command = opts.command ?? "claude";
  const args = ["-p", task, "--output-format", "json", "--tools", "", "--no-session-persistence"];
  return execAndClassify(command, args, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}
