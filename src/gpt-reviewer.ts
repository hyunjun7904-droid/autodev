import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import { AuthenticationError, RateLimitError, APIConnectionTimeoutError, APIConnectionError, APIError } from "openai";
import type { ClaudeResult, GptReviewResult, GptErrorCode } from "./types";
import { getWorkingTreeChanges, getTrackedDiff, readUntrackedFiles, isPathInScope } from "./git-changes";
import { PROJECT_ROOT } from "./safe-executor";
import { validateReadPath } from "./safe-executor";
import type { SafeExecutorContext } from "./safe-executor";
import { log, sanitizeForLog } from "./logger";

// 실제 OpenAI Responses API 기반 리뷰어. AUTOMATION_DRY_RUN=false일 때만 orchestrator가
// 이 모듈을 선택한다. OPENAI_API_KEY는 client 생성자가 process.env에서 자동으로 읽는다 —
// 이 파일 어디에서도 키 값을 직접 읽거나 로그로 남기지 않는다.
//
// AutoDev 범용화 Phase A Task A6 — 이 파일(Core)은 이제 어떤 프로젝트를 리뷰하고 있는지
// 전혀 모른다. "MOVAN ERP 프로젝트의 리뷰어"라고 가정하지 않고, 프로젝트 이름/검토
// 규칙/실제 git 변경을 스캔할 소스 범위는 전부 호출부(autodev.ts)가 ProjectManifest로부터
// 조립해 주입하는 ReviewProjectContext를 통해서만 얻는다. 실제 MOVAN 운용에서는
// autodev.ts가 항상 명시적으로 MOVAN_PROJECT_MANIFEST 기반 context를 넘기므로 기존
// 동작은 그대로 보존된다.
const MODEL = "gpt-5.6";
// PROJECT_ROOT를 이 파일에서 독자적으로 다시 계산하지 않는다 — Safe Executor가
// project-context.ts의 TARGET_PROJECT_ROOT로부터 export하는 값을 그대로 재사용해,
// reviewer와 safe executor가 항상 동일한 target project root를 보게 한다(Phase A Task A1).
// Phase 9 Task2 리뷰에서 20_000자로는 사진 갤러리/업로드 기능 하나의 diff(약 55K자,
// 신규 파일 12개)조차 중간에 잘려 보안 경계 API를 리뷰어가 아예 보지 못하는 문제가
// 실제로 확인됐다 — 최소한으로 65_000자로 올린다(리뷰 대상 diff는 이미 프로젝트별
// reviewScopeDirs 범위로만 제한되어 있으므로 이 값을 올려도 "전체 repository 전송"과는
// 무관하다). 리뷰 로직/아키텍처는 변경하지 않는다.
const MAX_DIFF_CHARS = 65_000;
const MAX_RULES_CHARS = 2_000;

/** GPT Reviewer system instructions/review 대상 범위에 삽입되는 프로젝트별 맥락 — Core는
 *  이 값의 의미를 모른다(호출부가 ProjectManifest로부터 조립해 주입한다). */
export interface ReviewProjectContext {
  /** system instructions 도입부("당신은 {projectName}의 독립 코드 리뷰어입니다")에 삽입된다. */
  projectName: string;
  /** 프로젝트별 검토 규칙 — system instructions 끝에 그대로 삽입된다. */
  instructions: string;
  /** 실제 git 변경을 스캔하는 프로젝트 전체 소스 범위(POSIX 상대경로, trailing "/").
   *  task별 allowedPathPrefixes보다 넓어야 scope-violation을 실제로 탐지할 수 있다. */
  scopeDirs: string[];
  /** "프로젝트 규칙 요약" 섹션에 읽어올 문서 경로(targetProjectRoot 기준 상대경로).
   *  지정하지 않으면 규칙 요약 섹션을 생략한다. */
  rulesPath?: string;
}

// 존재할 수 없는 경로 — scopeDirs가 지정되지 않았을 때 "아무것도 스캔하지 않음"을
// 보장한다(빈 배열을 그대로 git status/diff의 pathspec으로 넘기면 "제한 없음"이 되어
// repository 전체를 스캔하게 되므로 반드시 피해야 한다).
const NO_SCOPE_CONFIGURED = ["__autodev_no_project_scope_configured__/"];

// Core 기본값 — 명시적으로 project context가 주입되지 않았을 때만 쓰인다. 특정 프로젝트를
// 가리키지 않는다 — 실제 프로젝트별 내용은 항상 호출부가 명시적으로 주입해야 한다.
const DEFAULT_REVIEW_PROJECT_CONTEXT: ReviewProjectContext = {
  projectName: "AutoDev가 관리하는 프로젝트",
  instructions: "이 프로젝트에 대한 추가 검토 규칙이 지정되지 않았습니다.",
  scopeDirs: NO_SCOPE_CONFIGURED,
};

export interface GptReviewApiResult extends GptReviewResult {
  errorCode?: GptErrorCode;
  /** 이 errorCode가 재시도로 해결될 가능성이 있는 일시적 오류인지. */
  transient?: boolean;
  /**
   * task.allowedPathPrefixes 밖에서 발견된 실제 변경 파일 목록(§ 요구사항 3/7). GPT의
   * decision과 무관하게, orchestrator가 이 목록이 비어있지 않으면 결정적으로 BLOCK으로
   * 강제한다 — "allowed task paths 밖 파일도 review 대상/commit 대상에서 제외하거나
   * 정책 위반으로 BLOCK한다"는 요구사항을 LLM 판단에만 맡기지 않기 위함.
   */
  scopeViolations?: string[];
  /** Phase G Task G3.1 — 실제 OpenAI Responses API 응답(response.model)이 echo한 값만
   *  담는다(요청 시 지정한 MODEL 상수가 아니라 실제로 응답한 model) — API가 실제로 호출된
   *  경로(정상 응답, INVALID_OUTPUT)에서만 채워지고, 네트워크/인증 오류로 응답 자체가 없으면
   *  undefined다. */
  model?: { provider: string; name: string };
  /** response.usage(input_tokens/output_tokens/total_tokens)를 그대로 옮긴 값 — 추정/가격
   *  환산 없음. */
  tokenUsage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}
export interface GptReviewRetryResult extends GptReviewApiResult {
  /** 실제로 수행된 API 통신 재시도 횟수(최초 시도 제외) — reviewCycle과 별개로 집계. */
  gptTransportRetry: number;
}

// 30초는 실제로 너무 짧다는 것이 확인됐다 — 구조화 출력(json_schema)으로 diff를 검토하는
// 실제 호출이 정상적으로도 30초를 종종 넘겨, 매 시도가 진짜 API 오류가 아니라 클라이언트
// 타임아웃 자체 때문에 실패하고 있었다(재시도 5회 전부 소진되는 것을 실제로 관찰). SDK
// 자체 재시도(maxRetries)는 여전히 0으로 유지하고 재시도는 reviewClaudeResultWithRetry가
// 전담한다.
//
// AutoDev 범용화 Phase A Task A6 — lazy initialization(기존 backlog 해결). 이전에는 이
// client를 모듈 최상단에서 즉시 생성해, OPENAI_API_KEY가 없으면 "실제 API를 전혀 호출하지
// 않는" fake/injected reviewer 테스트조차 이 파일을 import하는 순간(new OpenAI() 생성자가
// 즉시 throw) 실패했다. 이제 실제로 API를 호출하는 시점(getClient() 최초 호출)에만
// 생성한다 — deps.attempt를 주입하는 테스트는 reviewClaudeResultOnce/getClient를 전혀
// 거치지 않으므로 OPENAI_API_KEY 없이도 정상 동작한다. 실제 호출 시 key가 없으면 SDK
// 생성자가 그 시점에 명확히 실패한다(조용한 fallback 없음). 키 값은 여기서도 절대 읽거나
// 로그로 남기지 않는다 — SDK가 process.env에서 자동으로 읽을 뿐이다. 재시도/구조화 출력
// 동작은 그대로 유지한다.
let cachedClient: OpenAI | null = null;
function getClient(): OpenAI {
  if (!cachedClient) cachedClient = new OpenAI({ timeout: 120_000, maxRetries: 0 });
  return cachedClient;
}

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["PASS", "REVISE", "HUMAN_REQUIRED", "BLOCK"] },
    severity: {
      type: "object",
      properties: {
        critical: { type: "integer" },
        high: { type: "integer" },
        medium: { type: "integer" },
      },
      required: ["critical", "high", "medium"],
      additionalProperties: false,
    },
    feedback: { type: "string" },
    nextTask: { type: ["string", "null"] },
  },
  required: ["decision", "severity", "feedback", "nextTask"],
  additionalProperties: false,
} as const;

// Phase C Task C2 — Per-Run Execution Context. 이 파일이 실제로 파일을 읽는 지점
// (getRulesSummary/readUntrackedFiles)은 executor(SafeExecutorContext)가 지정되면 그
// context의 root/validateReadPath만 쓴다 — module-level PROJECT_ROOT/validateReadPath
// singleton(다른 project가 configureSafeExecutor()로 덮어쓸 수 있는 전역)에 의존하지 않는다.
// executor를 지정하지 않으면(예: 이 파일을 직접 단위테스트하는 기존 코드) 기존과 동일하게
// module-level singleton을 쓴다(하위 호환) — 실제 운용(autodev.ts → orchestrator.ts)은
// 항상 executor를 명시적으로 전달한다.
type ReviewFileAccess = Pick<SafeExecutorContext, "projectRoot" | "validateReadPath">;

function resolveFileAccess(executor: SafeExecutorContext | undefined): ReviewFileAccess {
  return executor ?? { projectRoot: PROJECT_ROOT, validateReadPath };
}

// rulesPath는 targetProjectRoot(access.projectRoot) 기준 상대경로다 — 이 파일은 어느
// 프로젝트의 어떤 규칙 파일인지 모른다(ReviewProjectContext.rulesPath로 호출부가 지정한다).
// 지정하지 않으면 규칙 요약 자체를 생략한다(과거처럼 특정 파일 경로를 조용히 기본값으로
// 쓰지 않는다).
function getRulesSummary(rulesPath: string | undefined, access: ReviewFileAccess): string {
  if (!rulesPath) return "(프로젝트 규칙 파일이 지정되지 않음)";
  try {
    const raw = readFileSync(join(access.projectRoot, ...rulesPath.split("/")), "utf-8");
    return raw.slice(0, MAX_RULES_CHARS);
  } catch {
    return "(rules 파일 로드 실패)";
  }
}

// scope-matching 로직은 git-changes.ts의 isPathInScope 하나만 쓴다 — checkpoint.ts(commit
// 대상 판정)와 이 파일(review payload 범위/scope-violation 판정)이 각자 따로 구현하지
// 않는다(중복 구현 금지).

// REVISE(FINAL — untracked 파일 포함) — 이전 버전은 "git diff -- web/ automation/"만
// 사용해 신규(untracked) 파일을 전혀 review payload에 넣지 못했다(치명적 구조 문제).
// git-changes.ts(getWorkingTreeChanges)로 tracked/untracked를 함께 파악하고, untracked
// 파일은 content를 직접 읽어 payload에 포함한다. git index를 바꾸는 명령(git add -N 등)은
// 쓰지 않는다. secret/빌드산출물/로그/temp 파일은 git-changes.ts가 이미 제외했고,
// task.allowedPathPrefixes 밖 파일은 review 대상에서 제외하되 별도 섹션으로 명시해
// 정책 위반 여부를 리뷰어/orchestrator 양쪽이 알 수 있게 한다.
function buildChangeSection(
  allowedPathPrefixes: string[],
  scopeDirs: string[],
  access: ReviewFileAccess
): { text: string; scopeViolations: string[] } {
  const changes = getWorkingTreeChanges(scopeDirs, access.projectRoot);
  const allPaths = changes.all.map((c) => c.path);
  const scopeViolations = allPaths.filter((p) => !isPathInScope(p, allowedPathPrefixes));
  const scopeViolationSet = new Set(scopeViolations);

  const inScopeUntracked = changes.untracked.filter((c) => !scopeViolationSet.has(c.path));

  let trackedDiffText: string;
  try {
    const raw = getTrackedDiff(scopeDirs, access.projectRoot);
    trackedDiffText = !raw
      ? "(tracked diff 없음)"
      : raw.length <= MAX_DIFF_CHARS
        ? raw
        : raw.slice(0, MAX_DIFF_CHARS) + `\n...[diff truncated, ${raw.length - MAX_DIFF_CHARS}자 생략]`;
  } catch (e) {
    trackedDiffText = `(git diff 조회 실패: ${sanitizeForLog(String(e)).slice(0, 200)})`;
  }

  const { files: untrackedFiles, skipped } = readUntrackedFiles(
    inScopeUntracked,
    { perFileMaxChars: 20_000, totalBudgetChars: MAX_DIFF_CHARS },
    { validateReadPath: access.validateReadPath }
  );
  const untrackedText = untrackedFiles.length
    ? untrackedFiles
        .map((f) => `--- 신규 파일: ${f.path}${f.truncated ? " (내용 일부 truncated)" : ""} ---\n${f.content}`)
        .join("\n\n")
    : "(신규 untracked 파일 없음)";

  const text = [
    `## tracked 변경 diff (최대 ${MAX_DIFF_CHARS}자)\n${trackedDiffText}`,
    `## 신규(untracked) 파일 전체 내용\n${untrackedText}`,
    `## 예산 초과로 review에서 생략된 파일(어떤 파일이 잘렸는지)\n${skipped.length ? skipped.join("\n") : "(없음)"}`,
    `## secret/빌드산출물/로그/temp 등으로 제외된 경로\n${changes.excluded.length ? changes.excluded.join("\n") : "(없음)"}`,
    `## 이 task의 허용 경로(allowedPathPrefixes) 밖에서 발견된 변경 — 정책 위반, 반드시 BLOCK 또는 REVISE 판단에 반영\n${scopeViolations.length ? scopeViolations.join("\n") : "(없음)"}`,
  ].join("\n\n");

  return { text, scopeViolations };
}

// export: developer-reviewer-context-tests.ts가 실제 OpenAI API를 호출하지 않고도 review
// input/system instructions에 프로젝트별 내용이 정확히 삽입되는지 직접 검증할 수 있게 한다.
export function buildReviewInput(
  task: string,
  result: ClaudeResult,
  reviewCycle: number,
  allowedPathPrefixes: string[],
  projectContext: ReviewProjectContext,
  executor?: SafeExecutorContext
): { input: string; scopeViolations: string[] } {
  const access = resolveFileAccess(executor);
  const testsSummary = result.tests.map((t) => `- ${t.name}: ${t.pass ? "PASS" : "FAIL"}`).join("\n") || "(없음)";
  const { text: changeSection, scopeViolations } = buildChangeSection(allowedPathPrefixes, projectContext.scopeDirs, access);
  const input = [
    `# Task\n${task}`,
    `# Review cycle\n${reviewCycle}`,
    `# 프로젝트\n${projectContext.projectName}`,
    `# 프로젝트 규칙 요약\n${getRulesSummary(projectContext.rulesPath, access)}`,
    `# Claude 결과 요약\n${result.summary}`,
    `# Claude가 보고한 변경 파일\n${result.changedFiles.join("\n") || "(없음)"}`,
    `# 테스트 결과(AutoDev가 실제로 실행해 확인한 exitCode 기준)\n${testsSummary}`,
    `# 실제 변경 내역(git status 기준, tracked+untracked 전부)\n${changeSection}`,
  ].join("\n\n");
  return { input, scopeViolations };
}

export function buildSystemInstructions(ctx: ReviewProjectContext): string {
  const projectRules = ctx.instructions.trim();
  return `당신은 ${ctx.projectName}의 독립 코드 리뷰어입니다.
Claude가 작성한 변경사항을 검토해 아래 관점에서 문제를 찾으세요:
보안, 권한(RLS/RBAC), 데이터 무결성, 타입 정확성, 동시성(race condition), 오류 처리,
회귀(regression) 여부.
직접 파일을 수정하지 마세요 — 당신은 리뷰만 담당합니다.
critical/high가 하나라도 있으면 반드시 REVISE 또는 BLOCK을 선택하세요.
medium만 있고 진행을 막을 정도가 아니면 PASS해도 됩니다.

# 프로젝트 규칙(${ctx.projectName})
${projectRules}`;
}

// transient=true: 같은 입력으로 다시 시도하면 성공할 가능성이 있는 오류(네트워크/일시적
// 서버 문제). transient=false: 재시도로 해결되지 않는 오류(인증/쿼터/잘못된 응답 형식).
function classifyApiError(e: unknown): { code: GptErrorCode; transient: boolean } {
  if (e instanceof AuthenticationError) return { code: "AUTH_ERROR", transient: false };
  if (e instanceof RateLimitError) {
    if (e.code === "insufficient_quota") return { code: "QUOTA_EXCEEDED", transient: false };
    return { code: "RATE_LIMIT", transient: true };
  }
  if (e instanceof APIConnectionTimeoutError) return { code: "TIMEOUT", transient: true };
  if (e instanceof APIConnectionError) return { code: "API_ERROR", transient: true }; // 네트워크 연결 오류
  if (e instanceof APIError) {
    const status = e.status;
    return { code: "API_ERROR", transient: typeof status === "number" && status >= 500 };
  }
  return { code: "API_ERROR", transient: false };
}

// 실제 OpenAI API를 정확히 1회만 호출하는 하위 레벨 함수 — 재시도 로직은 아래
// reviewClaudeResultWithRetry()에서 감싼다. 테스트에서 이 함수를 직접 fake로 대체해
// 재시도 로직만 독립적으로 검증할 수 있게 이름을 분리했다.
export async function reviewClaudeResultOnce(
  result: ClaudeResult,
  reviewCycle: number,
  task = "(task 미지정)",
  allowedPathPrefixes?: string[],
  projectContext: ReviewProjectContext = DEFAULT_REVIEW_PROJECT_CONTEXT,
  executor?: SafeExecutorContext
): Promise<GptReviewApiResult> {
  const effectiveAllowedPathPrefixes = allowedPathPrefixes ?? projectContext.scopeDirs;
  const { input, scopeViolations } = buildReviewInput(task, result, reviewCycle, effectiveAllowedPathPrefixes, projectContext, executor);

  try {
    const response = await getClient().responses.create({
      model: MODEL,
      instructions: buildSystemInstructions(projectContext),
      input,
      text: {
        format: {
          type: "json_schema",
          name: "gpt_review_result",
          schema: RESULT_SCHEMA,
          strict: true,
        },
      },
    });

    // 실제 API 호출이 응답을 반환한 시점부터는(파싱 성공 여부와 무관하게) 이미 실제 토큰이
    // 소비됐다 — response.usage/response.model은 그 실제 호출 1건에 대해 정확히 한 번만
    // 존재하므로, 아래 두 return 경로(정상/INVALID_OUTPUT) 모두에 동일하게 붙인다(§ 요구사항:
    // 실제로 호출됐을 때 얻을 수 있는 값은 누락하지 않는다). catch 블록(네트워크/인증 오류 등
    // 응답 자체가 없는 경우)에는 이 값이 존재하지 않는다.
    const model = response.model ? { provider: "openai", name: response.model } : undefined;
    const tokenUsage = response.usage
      ? { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, totalTokens: response.usage.total_tokens }
      : undefined;

    let parsed: GptReviewResult;
    try {
      parsed = JSON.parse(response.output_text) as GptReviewResult;
    } catch {
      log("GPT 리뷰 오류(INVALID_OUTPUT)", { reviewCycle });
      return {
        decision: "HUMAN_REQUIRED",
        severity: { critical: 0, high: 0, medium: 0 },
        feedback: "GPT 응답 JSON 파싱 실패",
        nextTask: null,
        errorCode: "INVALID_OUTPUT",
        scopeViolations,
        model,
        tokenUsage,
      };
    }

    log("GPT 리뷰 완료", { reviewCycle, decision: parsed.decision, severity: parsed.severity });
    return { ...parsed, scopeViolations, model, tokenUsage };
  } catch (e) {
    const { code: errorCode, transient } = classifyApiError(e);
    log(`GPT 리뷰 API 오류(${errorCode})`, { reviewCycle, transient });
    return {
      decision: "HUMAN_REQUIRED",
      severity: { critical: 0, high: 0, medium: 0 },
      feedback: `GPT API 오류: ${errorCode}`,
      nextTask: null,
      errorCode,
      transient,
      scopeViolations,
    };
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
// 1차 실패→15초, 2차 실패→30초, 3차 실패→60초, 4차 실패→60초 대기 후 재시도(최대 5회 시도).
const RETRY_WAITS_MS = [15_000, 30_000, 60_000, 60_000];
const MAX_ATTEMPTS = 5;

export interface ReviewRetryDeps {
  attempt?: typeof reviewClaudeResultOnce;
  sleep?: (ms: number) => Promise<void>;
}

// TIMEOUT/RATE_LIMIT/일시적(5xx·connection) API_ERROR는 같은 Claude 결과·같은 git diff로
// GPT reviewer 호출만 재시도한다(Claude 작업을 다시 실행하지 않음). AUTH_ERROR/QUOTA_EXCEEDED는
// 재시도로 해결되지 않으므로 즉시 반환한다. 5회 모두 일시적 오류로 실패하면
// GPT_REVIEW_TEMPORARILY_UNAVAILABLE로 반환하며, 이 경우도 decision은 절대 PASS가 아니다
// (검증 안 된 코드를 PASS 처리하지 않는다는 원칙).
export interface ReviewRetryOptions {
  deps?: ReviewRetryDeps;
  /** task-registry.ts TaskDefinition.allowedPathPrefixes — 지정하지 않으면 projectContext의
   *  scopeDirs 전체가 허용 범위인 것으로 취급한다(기존 동작과 동일한 방식). */
  allowedPathPrefixes?: string[];
  /** 이 리뷰가 대상으로 하는 프로젝트의 맥락 — 지정하지 않으면 DEFAULT_REVIEW_PROJECT_CONTEXT
   *  (범용 기본값)를 쓴다. 실제 운용은 autodev.ts가 ProjectManifest로부터 조립해 항상
   *  명시적으로 넘긴다. */
  projectContext?: ReviewProjectContext;
  /** Phase C Task C2 — 이 review가 속한 project run 전용 SafeExecutorContext. 지정하면
   *  rules 파일 읽기/실제 git 변경 스캔이 이 context의 root/validateReadPath만 쓴다(다른
   *  project의 configureSafeExecutor() 호출에 영향받지 않음). 지정하지 않으면 기존과 동일하게
   *  module-level singleton을 쓴다(하위 호환) — 실제 운용은 orchestrator.ts가 항상 명시적으로
   *  넘긴다. */
  executor?: SafeExecutorContext;
}

export async function reviewClaudeResultWithRetry(
  result: ClaudeResult,
  reviewCycle: number,
  task = "(task 미지정)",
  opts: ReviewRetryOptions = {}
): Promise<GptReviewRetryResult> {
  const attempt = opts.deps?.attempt ?? reviewClaudeResultOnce;
  const sleep = opts.deps?.sleep ?? defaultSleep;
  const projectContext = opts.projectContext ?? DEFAULT_REVIEW_PROJECT_CONTEXT;
  const allowedPathPrefixes = opts.allowedPathPrefixes ?? projectContext.scopeDirs;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const r = await attempt(result, reviewCycle, task, allowedPathPrefixes, projectContext, opts.executor);
    if (!r.transient) {
      return { ...r, gptTransportRetry: i };
    }
    log(`GPT 리뷰 일시적 오류(${r.errorCode}) — 재시도 ${i + 1}/${MAX_ATTEMPTS}`, { reviewCycle });
    if (i < MAX_ATTEMPTS - 1) await sleep(RETRY_WAITS_MS[i]);
  }

  return {
    decision: "HUMAN_REQUIRED",
    severity: { critical: 0, high: 0, medium: 0 },
    feedback: `GPT reviewer가 ${MAX_ATTEMPTS}회 연속 일시적 오류로 응답하지 않았습니다.`,
    nextTask: null,
    errorCode: "GPT_REVIEW_TEMPORARILY_UNAVAILABLE",
    transient: false,
    gptTransportRetry: MAX_ATTEMPTS - 1,
  };
}

// orchestrator.ts는 이 이름으로 import한다 — 재시도까지 포함된 버전을 실제 사용 경로로 삼는다.
export const reviewClaudeResult = reviewClaudeResultWithRetry;
