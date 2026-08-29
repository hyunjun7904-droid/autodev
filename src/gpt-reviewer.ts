import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaudeResult, GptReviewResult, GptErrorCode } from "./types";
import { getWorkingTreeChanges, getTrackedDiff, readUntrackedFiles, isPathInScope } from "./git-changes";
import type { WorkingTreeChanges } from "./git-changes";
import { PROJECT_ROOT } from "./safe-executor";
import { validateReadPath } from "./safe-executor";
import type { SafeExecutorContext } from "./safe-executor";
import { log, sanitizeForLog } from "./logger";
import { resolveGptBudgetGuardConfig, evaluateGptBudgetGuard } from "./gpt-budget-guard";
import { resolvePricing, calculateEstimatedCost } from "./pricing-catalog";
import type { UsageLedgerEntryInput } from "./usage-ledger";
import { isProductionRuntime } from "./runtime-origin";
import type { ReviewProvider, ReviewProviderResult } from "./review-provider";
import { DEFAULT_REVIEWER_DATA_CLASSIFICATION } from "./review-provider";
import { finalReviewerProductionProvider, resolveFinalReviewerProductionSecurityRegistry } from "./final-reviewer-provider-selection";
import { evaluateProviderSecurity } from "./provider-security-gate";
import type { DataClassification, ProviderSecurityRegistry } from "./provider-security-gate";
import {
  buildTaskIdentity,
  buildScopeKey,
  buildAllowedPathPrefixesKey,
  buildFileStateSnapshot,
  buildReviewBaseline,
  validateReviewBaseline,
  diffAgainstBaseline,
  snapshotsAreIdentical,
} from "./review-baseline";
import type { ReviewBaseline, ReviewPayloadMode, FileContentReader, ReviewFileState } from "./review-baseline";

// Reviewer Core — 실제 AI review provider의 SDK/transport를 직접 알지 못한다(Phase SI-3.8E,
// Reviewer Provider Abstraction). AUTOMATION_DRY_RUN=false일 때만 orchestrator가 이 모듈을
// 선택한다. 이 파일은 review-provider.ts의 ReviewProvider contract만으로 provider를 호출한다 —
// provider가 API key를 어떻게 읽는지, 실제 요청을 어떻게 만드는지는 이 파일이 몰라도 된다.
//
// Production Final Reviewer Wiring — production default provider/security registry(아래
// reviewClaudeResultOnce의 provider/securityGateOverrides 기본값)는 이제
// final-reviewer-provider-selection.ts가 결정한다(qualification을 통과한 Groq
// openai/gpt-oss-120b, 4/4 QUALIFIED). 실제 transport(chat-completion-review-provider.ts 공용
// factory)는 여전히 이 파일이 모른다 — 이 파일은 어느 provider를 기본값으로 쓸지 그 선택
// 모듈에 위임할 뿐이다. OpenAI provider(openai-review-provider.ts)는 삭제되지 않았고
// review-provider-tests.ts 등에서 명시적으로 주입하는 provider로 계속 존재하지만, 더 이상 이
// 파일의 production 기본값이 아니다 — silent fallback도 없다(이 파일은 provider.review()가
// 실패해도 다른 provider로 자동 전환하지 않는다, § 아래 provider.review() 호출부).
//
// AutoDev 범용화 Phase A Task A6 — 이 파일(Core)은 이제 어떤 프로젝트를 리뷰하고 있는지
// 전혀 모른다. "MOVAN ERP 프로젝트의 리뷰어"라고 가정하지 않고, 프로젝트 이름/검토
// 규칙/실제 git 변경을 스캔할 소스 범위는 전부 호출부(autodev.ts)가 ProjectManifest로부터
// 조립해 주입하는 ReviewProjectContext를 통해서만 얻는다. 실제 MOVAN 운용에서는
// autodev.ts가 항상 명시적으로 MOVAN_PROJECT_MANIFEST 기반 context를 넘기므로 기존
// 동작은 그대로 보존된다.
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
   *  환산 없음. cachedInputTokens는 response.usage.input_tokens_details.cached_tokens(OpenAI
   *  SDK가 실제로 제공하는 필드)를 그대로 옮긴다 — Phase SI-3.8B, Usage Ledger의 cached-token
   *  기록을 위해 추가됐다(추정하지 않음, 제공된 값만). */
  tokenUsage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** Phase SI-3.8B — errorCode가 있을 때만 의미가 있다: false면 실제 네트워크 요청이 전혀
   *  나가지 않은 채(예: OPENAI_API_KEY 미설정으로 OpenAI SDK 클라이언트 생성자 자체가
   *  동기적으로 throw) 실패했다는 뜻이다. classifyApiError()는 이런 로컬 생성 실패와 실제로
   *  전송된 요청이 서버/네트워크에서 실패한 경우를 같은 errorCode(예: API_ERROR)로 분류할 수
   *  있어(§ Claude code-review 지적) errorCode만으로는 구분할 수 없다 — 그래서
   *  buildGptReviewLedgerEntryInput()의 requestCount 계산은 errorCode 대신 이 필드를 우선
   *  확인한다. 지정하지 않으면(성공 응답, 또는 실제로 전송된 요청이 실패한 일반적인 경우)
   *  true로 간주한다. */
  requestAttempted?: boolean;
  /** Phase SI-3.8D — 이번 round의 payload가 FULL/INCREMENTAL/SAFE_FULL_FALLBACK 중 어느
   *  방식으로 만들어졌는지(§ review-baseline.ts ReviewPayloadMode). Budget Guard BLOCK처럼
   *  실제 payload를 만든 뒤에만 채워진다. */
  reviewMode?: ReviewPayloadMode;
  /** Phase SI-3.8D — 이번 round가 끝난 뒤의 새 baseline. 호출부(orchestrator.ts/
   *  agent-orchestrator.ts)가 loop-local 변수로 들고 있다가 다음 round의 reviewClaudeResult
   *  호출에 그대로 넘기면 그 다음 round는 INCREMENTAL로 진행될 수 있다. project-state.json에
   *  영속화하지 않는다(§ review-baseline.ts 상단 주석). */
  reviewBaseline?: ReviewBaseline;
  /** Phase SI-3.8D — 실제 OpenAI에 전달된 instructions+input의 글자수(gpt-budget-guard.ts가
   *  이미 계산한 값을 그대로 옮긴 것) — Usage Ledger의 payloadChars에 그대로 반영되어
   *  FULL/INCREMENTAL round 간 payload 절감을 증거로 보여준다. */
  payloadChars?: number;
}
export interface GptReviewRetryResult extends GptReviewApiResult {
  /** 실제로 수행된 API 통신 재시도 횟수(최초 시도 제외) — reviewCycle과 별개로 집계. */
  gptTransportRetry: number;
}

// Phase SI-3.8E — 실제 API client/구조화 출력 schema/lazy initialization은 이제
// openai-review-provider.ts(OpenAIReviewProvider)의 책임이다(값/동작 변경 없이 그대로 이동—
// § openai-review-provider.ts 상단 주석). 이 파일은 ReviewProvider.review()만 호출한다.

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
  changes: WorkingTreeChanges,
  access: ReviewFileAccess
): { text: string; scopeViolations: string[]; fullyIncludedPaths: string[] } {
  const allPaths = changes.all.map((c) => c.path);
  const scopeViolations = allPaths.filter((p) => !isPathInScope(p, allowedPathPrefixes));
  const scopeViolationSet = new Set(scopeViolations);

  const inScopeUntracked = changes.untracked.filter((c) => !scopeViolationSet.has(c.path));

  let trackedDiffText: string;
  // Claude code-review 지적 — 예산 초과로 truncate된(또는 조회 자체가 실패한) tracked diff를
  // "review됨"으로 취급해 baseline에 반영하면, 실제로 GPT가 본 적 없는 내용이 이후 round에서
  // "이미 검토됨"으로 조용히 영구 제외될 수 있다. 그래서 이 블록은 실제로 전체 내용이 담겼는지
  // (trackedFullyIncluded)를 별도로 추적해 fullyIncludedPaths 계산에 반영한다.
  let trackedFullyIncluded = true;
  try {
    const raw = getTrackedDiff(scopeDirs, access.projectRoot);
    if (!raw) {
      trackedDiffText = "(tracked diff 없음)";
    } else if (raw.length <= MAX_DIFF_CHARS) {
      trackedDiffText = raw;
    } else {
      trackedFullyIncluded = false;
      trackedDiffText = raw.slice(0, MAX_DIFF_CHARS) + `\n...[diff truncated, ${raw.length - MAX_DIFF_CHARS}자 생략]`;
    }
  } catch (e) {
    trackedFullyIncluded = false;
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

  const fullyIncludedPaths = [
    ...(trackedFullyIncluded ? changes.tracked.map((c) => c.path) : []),
    ...untrackedFiles.filter((f) => !f.truncated).map((f) => f.path),
  ];

  const text = [
    `## tracked 변경 diff (최대 ${MAX_DIFF_CHARS}자)\n${trackedDiffText}`,
    `## 신규(untracked) 파일 전체 내용\n${untrackedText}`,
    `## 예산 초과로 review에서 생략된 파일(어떤 파일이 잘렸는지)\n${skipped.length ? skipped.join("\n") : "(없음)"}`,
    `## 민감정보/빌드산출물/로그/temp 등으로 제외된 경로\n${changes.excluded.length ? changes.excluded.join("\n") : "(없음)"}`,
    `## 이 task의 허용 경로(allowedPathPrefixes) 밖에서 발견된 변경 — 정책 위반, 반드시 BLOCK 또는 REVISE 판단에 반영\n${scopeViolations.length ? scopeViolations.join("\n") : "(없음)"}`,
  ].join("\n\n");

  return { text, scopeViolations, fullyIncludedPaths };
}

// Phase SI-3.8D — Incremental GPT Reviewer. FULL(첫 review)/SAFE_FULL_FALLBACK(baseline을
// 신뢰할 수 없을 때)는 access.projectRoot 기준으로 tracked file을 직접 읽는다(getTrackedDiff가
// 이미 Safe Executor read-prefix 제한 없이 scopeDirs 전체 diff를 노출하는 것과 동일한 노출
// 수준 — 새 정보 노출이 아니다). untracked file은 기존과 동일하게 access.validateReadPath로
// 게이트한다(§ readUntrackedFiles와 동일한 보안 경계 유지).
function makeFileStateReader(access: ReviewFileAccess): FileContentReader {
  return {
    read(path, status) {
      if (status === "untracked") {
        const v = access.validateReadPath(path);
        if (!v.ok) return { ok: false };
        try {
          return { ok: true, content: readFileSync(v.abs, "utf-8") };
        } catch {
          return { ok: false };
        }
      }
      try {
        return { ok: true, content: readFileSync(join(access.projectRoot, ...path.split("/")), "utf-8") };
      } catch {
        return { ok: false };
      }
    },
  };
}

// INCREMENTAL 전용 — changedPaths(이전 baseline 이후 실제로 달라진 파일)만의 diff/content를
// 담는다. unchangedPaths는 경로만 명시하고 내용은 다시 보내지 않는다(§ 요구사항 5/6). rename은
// getTrackedDiff의 -M과 old+new pathspec 조합으로 "rename from X to Y" 형태로 정확히
// 표현되고, 별도 요약 섹션으로도 한번 더 명시한다(§ 요구사항 7).
function buildIncrementalText(
  changedPaths: string[],
  unchangedPaths: string[],
  removedPaths: string[],
  changes: WorkingTreeChanges,
  access: ReviewFileAccess,
  scopeViolations: string[]
): { text: string; fullyIncludedPaths: string[] } {
  const changedSet = new Set(changedPaths);
  const scopeViolationSet = new Set(scopeViolations);
  const changedTracked = changes.tracked.filter((c) => changedSet.has(c.path));
  // Claude code-review 지적 — FULL 모드(buildChangeSection)는 scope 밖 untracked 파일의
  // 내용을 애초에 읽지 않는데, 이 함수는 그 필터를 빠뜨려서 scope 밖 파일이 "변경됨"으로
  // 분류되는 순간(baseline 대비 hash가 달라지는 순간) 내용이 그대로 OpenAI payload에
  // 포함될 수 있었다 — FULL과 동일하게 scope 밖 untracked는 내용을 읽지 않는다(경로는
  // scopeViolations 섹션에 이미 명시된다).
  const changedUntracked = changes.untracked.filter((c) => changedSet.has(c.path) && !scopeViolationSet.has(c.path));

  const trackedPathspec: string[] = [];
  for (const c of changedTracked) {
    trackedPathspec.push(c.path);
    if (c.renamedFrom) trackedPathspec.push(c.renamedFrom);
  }

  let trackedDiffText: string;
  let trackedFullyIncluded = true;
  try {
    const raw = trackedPathspec.length > 0 ? getTrackedDiff(trackedPathspec, access.projectRoot) : "";
    if (!raw) {
      trackedDiffText = "(이전 review 이후 변경된 tracked 파일 없음)";
    } else if (raw.length <= MAX_DIFF_CHARS) {
      trackedDiffText = raw;
    } else {
      trackedFullyIncluded = false;
      trackedDiffText = raw.slice(0, MAX_DIFF_CHARS) + `\n...[diff truncated, ${raw.length - MAX_DIFF_CHARS}자 생략]`;
    }
  } catch (e) {
    trackedFullyIncluded = false;
    trackedDiffText = `(git diff 조회 실패: ${sanitizeForLog(String(e)).slice(0, 200)})`;
  }

  const { files: untrackedFiles, skipped } = readUntrackedFiles(
    changedUntracked,
    { perFileMaxChars: 20_000, totalBudgetChars: MAX_DIFF_CHARS },
    { validateReadPath: access.validateReadPath }
  );
  const untrackedText = untrackedFiles.length
    ? untrackedFiles
        .map((f) => `--- 신규 파일: ${f.path}${f.truncated ? " (내용 일부 truncated)" : ""} ---\n${f.content}`)
        .join("\n\n")
    : "(이전 review 이후 변경된 신규 untracked 파일 없음)";

  const fullyIncludedPaths = [
    ...(trackedFullyIncluded ? changedTracked.map((c) => c.path) : []),
    ...untrackedFiles.filter((f) => !f.truncated).map((f) => f.path),
  ];

  const renamedNotes = changedTracked.filter((c) => c.status === "renamed").map((c) => `${c.renamedFrom} -> ${c.path}`);
  const deletedNotes = changedTracked.filter((c) => c.status === "deleted").map((c) => c.path);

  const text = [
    `## Incremental review — 이전 review(last-reviewed state) 이후 실제로 변경된 파일만 포함합니다(전체 재전송 아님).`,
    `## tracked 변경 diff — 이름 변경(rename)/삭제 포함(최대 ${MAX_DIFF_CHARS}자)\n${trackedDiffText}`,
    `## 신규(untracked) 파일 전체 내용 — 이전 review 이후 변경분만\n${untrackedText}`,
    `## 이름이 변경된 파일(old -> new)\n${renamedNotes.length ? renamedNotes.join("\n") : "(없음)"}`,
    `## 삭제된 파일\n${deletedNotes.length ? deletedNotes.join("\n") : "(없음)"}`,
    `## 예산 초과로 이번 payload에서 생략된 파일\n${skipped.length ? skipped.join("\n") : "(없음)"}`,
    `## 이전 review 이후 내용이 전혀 변경되지 않아 이번 payload에서 생략된 파일(${unchangedPaths.length}개, 이미 이전 round에서 검토됨)\n${unchangedPaths.length ? unchangedPaths.join("\n") : "(없음)"}`,
    `## 이전에 감지되었으나 이번 review에서는 더 이상 나타나지 않는 파일(예: untracked 신규 파일이 삭제됨 — git status가 더 이상 추적하지 않음)\n${removedPaths.length ? removedPaths.join("\n") : "(없음)"}`,
    `## 민감정보/빌드산출물/로그/temp 등으로 제외된 경로\n${changes.excluded.length ? changes.excluded.join("\n") : "(없음)"}`,
    `## 이 task의 허용 경로(allowedPathPrefixes) 밖에서 발견된 변경 — 정책 위반, 반드시 BLOCK 또는 REVISE 판단에 반영\n${scopeViolations.length ? scopeViolations.join("\n") : "(없음)"}`,
  ].join("\n\n");

  return { text, fullyIncludedPaths };
}

export interface ReviewPayloadResult {
  text: string;
  scopeViolations: string[];
  mode: ReviewPayloadMode;
  newBaseline: ReviewBaseline;
  /**
   * Final Consistency Cross-check 전용 — Task 1.3 JARVIS 실전 false positive(2026-08-26) 수정.
   * newBaseline.fileHashes(REVIEW COVERAGE baseline)는 의도적으로 fullyIncludedPaths만 담는다
   * (예산 초과로 완전히 전달되지 못한 파일은 "다음 round에도 계속 검토 대상"으로 남기기 위해
   * 제외 — 이 semantics는 INCREMENTAL 재사용에 필수이므로 건드리지 않는다). 하지만 그 필터링된
   * 집합을 "review 요청이 진행되는 동안 working tree가 실제로 안 바뀌었는가"를 확인하는 데
   * 그대로 재사용하면, truncated(budget 초과) 파일 하나만 있어도 파일 개수가 always mismatch돼
   * 실제로는 아무것도 바뀌지 않았는데도 항상 false positive로 REVIEW_CONSISTENCY_CHECK_FAILED가
   * 난다(실제로 JARVIS Task 1.3에서 재현/확인됨 — baseline 1개 파일 vs 재검사 시점 2개 파일).
   *
   * consistencySnapshot은 그 별개의 목적을 위한 별도 스냅샷이다 — currentSnapshot(이 함수가
   * 이미 한 번만 계산하는, truncation과 무관하게 changes.all 전체에 대한 full-content hash)을
   * 필터링 없이 그대로 담는다. full/truncated(head+tail)/전혀 review에 포함되지 못한 파일 모두
   * 동일하게 "이 경로가 payload를 만든 시점에 이 hash였다"만 기록한다 — "review에 완전히
   * 포함됐는가"라는 다른 질문(newBaseline.fileHashes의 책임)과 섞지 않는다.
   */
  consistencySnapshot: Record<string, ReviewFileState>;
}

/**
 * Review payload/mode 결정의 단일 지점 — reviewClaudeResultOnce()가 이 함수 하나만 호출해서
 * FULL/INCREMENTAL/SAFE_FULL_FALLBACK을 결정한다. baseline이 없으면(첫 review) 항상 FULL.
 * baseline이 있어도 validateReviewBaseline()이 무효라고 판정하면(§ 요구사항 8 — missing/
 * stale/tampered/incompatible) 조용히 INCREMENTAL을 계속하지 않고 명시적으로
 * SAFE_FULL_FALLBACK으로 전환한다(silent fallback 금지 — log로 사유를 남긴다).
 */
function buildReviewPayload(
  task: string,
  reviewCycle: number,
  allowedPathPrefixes: string[],
  scopeDirs: string[],
  access: ReviewFileAccess,
  baseline: ReviewBaseline | undefined
): ReviewPayloadResult {
  // git status/diff 조회는 이 함수 안에서 한 번만 수행한다 — 이전에는 FULL/SAFE_FULL_FALLBACK
  // 분기가 buildChangeSection() 내부에서 별도로 다시 getWorkingTreeChanges()를 호출해, 그
  // 사이 working tree가 바뀌면 baseline과 실제 전송된 내용이 서로 다른 상태를 가리킬 수
  // 있었다(§ Claude code-review 지적). 지금은 이 하나의 changes/currentSnapshot을 모든 분기가
  // 공유한다.
  const changes = getWorkingTreeChanges(scopeDirs, access.projectRoot);
  const taskIdentity = buildTaskIdentity(task);
  const scopeKey = buildScopeKey(scopeDirs);
  const allowedPathPrefixesKey = buildAllowedPathPrefixesKey(allowedPathPrefixes);
  const reader = makeFileStateReader(access);
  const currentSnapshot = buildFileStateSnapshot(changes, reader);

  // Claude code-review 지적 — "이번 round에 실제로 GPT에게 전달된 내용"만 다음 baseline에
  // "review됨"으로 기록한다. changedThisRound가 "ALL"(FULL/SAFE_FULL_FALLBACK, baseline이 없거나
  // 무효라 모든 파일이 사실상 처음 보여지는 것과 같음)이면, fullyIncludedPaths에 없는 파일은
  // baseline에서 완전히 제외된다(다음 round에도 계속 "변경됨"으로 재시도됨). INCREMENTAL이면
  // changedThisRound가 실제 changedPaths 집합이고, 그 집합 밖(=이전 round와 내용이 같아 이번
  // round에 아예 재전송 대상이 아니었던 파일)은 예산 초과 여부와 무관하게 항상 그대로 이어간다
  // (이미 어떤 과거 round에서 fully-included 되었을 때만 baseline에 존재할 수 있으므로).
  function buildReviewedBaseline(fullyIncludedPaths: string[], changedThisRound: Set<string> | "ALL"): ReviewBaseline {
    const fullyIncludedSet = new Set(fullyIncludedPaths);
    const reviewedFileHashes: Record<string, ReviewFileState> = {};
    for (const path of Object.keys(currentSnapshot)) {
      const wasChangedThisRound = changedThisRound === "ALL" || changedThisRound.has(path);
      if (!wasChangedThisRound || fullyIncludedSet.has(path)) {
        reviewedFileHashes[path] = currentSnapshot[path];
      }
      // else: 이번 round에 변경됐지만 예산 초과 등으로 완전히 전달되지 못한 파일 — baseline에서
      // 제외해 다음 round에도 계속 "변경됨"으로 재시도되게 한다(previous PASS를 신뢰하지 않는다).
    }
    return buildReviewBaseline({ taskIdentity, scopeKey, allowedPathPrefixesKey, reviewCycleOfBaseline: reviewCycle, fileHashes: reviewedFileHashes });
  }

  if (!baseline) {
    const { text, scopeViolations, fullyIncludedPaths } = buildChangeSection(allowedPathPrefixes, scopeDirs, changes, access);
    return { text, scopeViolations, mode: "FULL", newBaseline: buildReviewedBaseline(fullyIncludedPaths, "ALL"), consistencySnapshot: currentSnapshot };
  }

  const validation = validateReviewBaseline(baseline, { taskIdentity, scopeKey, allowedPathPrefixesKey, reviewCycle });
  if (!validation.ok) {
    log(`GPT Reviewer baseline을 신뢰할 수 없음(${validation.reason}) — SAFE_FULL_FALLBACK으로 전환합니다.`, { reviewCycle });
    const { text, scopeViolations, fullyIncludedPaths } = buildChangeSection(allowedPathPrefixes, scopeDirs, changes, access);
    return { text, scopeViolations, mode: "SAFE_FULL_FALLBACK", newBaseline: buildReviewedBaseline(fullyIncludedPaths, "ALL"), consistencySnapshot: currentSnapshot };
  }

  const scopeViolations = changes.all.map((c) => c.path).filter((p) => !isPathInScope(p, allowedPathPrefixes));
  const { changedPaths, unchangedPaths, removedPaths } = diffAgainstBaseline(currentSnapshot, baseline);
  const { text, fullyIncludedPaths } = buildIncrementalText(changedPaths, unchangedPaths, removedPaths, changes, access, scopeViolations);
  return {
    text,
    scopeViolations,
    mode: "INCREMENTAL",
    newBaseline: buildReviewedBaseline(fullyIncludedPaths, new Set(changedPaths)),
    consistencySnapshot: currentSnapshot,
  };
}

// Final Consistency Cross-check(§ 요구사항 9)의 핵심 판정 — reviewClaudeResultOnce()가
// decision=PASS를 그대로 신뢰하기 직전에 호출한다. export하는 이유: 이 함수는 실제 OpenAI
// round-trip 없이도(git-changes.ts/review-baseline.ts만으로) 결정적으로 재현/검증할 수 있어,
// 이 Task의 테스트가 실제 API를 호출하지 않고도 "review payload를 만든 시점 이후 working
// tree가 실제로 달라졌는가"를 직접 증명할 수 있게 한다(review-baseline-tests.ts).
//
// JARVIS Task 1.3 false positive 수정(2026-08-26) — 이 함수는 이제 ReviewBaseline(REVIEW
// COVERAGE 개념, fullyIncludedPaths로 필터링된 newBaseline.fileHashes)이 아니라
// ReviewPayloadResult.consistencySnapshot(필터링 없는 전체 hash snapshot)을 받는다.
// 이전에는 newBaseline.fileHashes를 그대로 재사용했는데, 그건 "예산 초과로 완전히 전달되지
// 못한 파일은 제외"하는 REVIEW COVERAGE 규칙을 따르므로, truncated(20,000자 초과) 파일이
// 하나만 있어도 payload 시점 스냅샷(파일 제외됨)과 재검사 시점 스냅샷(파일 포함됨)의 키 개수가
// 항상 달라져 실제 내용 변경이 전혀 없어도 매번 false positive로 drift가 보고됐다(실제
// JARVIS Task 1.3 production에서 재현·확인됨 — baseline 1개 파일 vs 재검사 2개 파일). 두
// snapshot 모두 동일한 포함 규칙(scopeDirs 안의 changes.all 전체, truncation 여부 무관)을
// 쓰도록 통일해 이 비대칭을 제거한다 — REVIEW COVERAGE(fullyIncludedPaths) semantics 자체는
// 전혀 건드리지 않는다(여전히 그대로 별도 baseline으로 존재).
export function hasWorkingTreeDriftedSincePayload(
  scopeDirs: string[],
  payloadConsistencySnapshot: Record<string, ReviewFileState>,
  executor?: SafeExecutorContext
): boolean {
  const access = resolveFileAccess(executor);
  const currentChanges = getWorkingTreeChanges(scopeDirs, access.projectRoot);
  const currentSnapshot = buildFileStateSnapshot(currentChanges, makeFileStateReader(access));
  return !snapshotsAreIdentical(currentSnapshot, payloadConsistencySnapshot);
}

// export: developer-reviewer-context-tests.ts가 실제 OpenAI API를 호출하지 않고도 review
// input/system instructions에 프로젝트별 내용이 정확히 삽입되는지 직접 검증할 수 있게 한다.
// baseline(Phase SI-3.8D)을 지정하지 않으면(기존 호출부 전부 포함) 항상 FULL review와 완전히
// 동일하게 동작한다 — 기존 동작을 바꾸지 않는다.
export function buildReviewInput(
  task: string,
  result: ClaudeResult,
  reviewCycle: number,
  allowedPathPrefixes: string[],
  projectContext: ReviewProjectContext,
  executor?: SafeExecutorContext,
  baseline?: ReviewBaseline
): {
  input: string;
  scopeViolations: string[];
  reviewMode: ReviewPayloadMode;
  newBaseline: ReviewBaseline;
  consistencySnapshot: Record<string, ReviewFileState>;
} {
  const access = resolveFileAccess(executor);
  // Phase 5 — 실패한 required test의 실제 근거(exitCode/stdout·stderr 꼬리)가 있으면 함께
  // 전달한다. "pass=false"만 보고 REVISE를 반복하지 않고, Developer/Reviewer 모두 실제
  // 원인(CONFIGURATION_ERROR/TEST_LOGIC_ERROR/IMPLEMENTATION_ERROR)을 추측 없이 판단할 수
  // 있게 한다(§ claude-developer.ts runRequiredTests).
  const testsSummary =
    result.tests
      .map((t) => {
        const header = `- ${t.name}: ${t.pass ? "PASS" : "FAIL"}`;
        if (t.pass) return header;
        // AutoDev Core Maintenance(2026-08-30) — 명령이 spawn조차 되지 못하고 거부된 경우(§
        // types.ts ClaudeResult.tests.denyReason 주석) failureEvidence는 없지만 거부 사유는
        // 있을 수 있다 — 이전에는 이 사유가 어디에도 전달되지 않아 "pass=false"만 보고 REVISE를
        // 반복했다.
        if (!t.failureEvidence) return t.denyReason ? `${header}\n  denyReason: ${t.denyReason}` : header;
        const ev = t.failureEvidence;
        const parts = [`  command: ${ev.command}`, `  exitCode: ${ev.exitCode ?? "(none)"}`];
        if (ev.stderrTail) parts.push(`  stderr(tail):\n${ev.stderrTail}`);
        if (ev.stdoutTail) parts.push(`  stdout(tail):\n${ev.stdoutTail}`);
        return [header, ...parts].join("\n");
      })
      .join("\n") || "(없음)";
  const { text: changeSection, scopeViolations, mode, newBaseline, consistencySnapshot } = buildReviewPayload(
    task,
    reviewCycle,
    allowedPathPrefixes,
    projectContext.scopeDirs,
    access,
    baseline
  );
  const input = [
    `# Task\n${task}`,
    `# Review cycle\n${reviewCycle}`,
    `# Review payload mode\n${mode}`,
    `# 프로젝트\n${projectContext.projectName}`,
    `# 프로젝트 규칙 요약\n${getRulesSummary(projectContext.rulesPath, access)}`,
    `# Claude 결과 요약\n${result.summary}`,
    `# Claude가 보고한 변경 파일\n${result.changedFiles.join("\n") || "(없음)"}`,
    `# 테스트 결과(AutoDev가 실제로 실행해 확인한 exitCode 기준)\n${testsSummary}`,
    `# 실제 변경 내역(git status 기준, tracked+untracked 전부)\n${changeSection}`,
  ].join("\n\n");
  return { input, scopeViolations, reviewMode: mode, newBaseline, consistencySnapshot };
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

// 실제 review provider를 정확히 1회만 호출하는 하위 레벨 함수 — 재시도 로직은 아래
// reviewClaudeResultWithRetry()에서 감싼다. 테스트에서 이 함수를 직접 fake로 대체해
// 재시도 로직만 독립적으로 검증할 수 있게 이름을 분리했다.
export async function reviewClaudeResultOnce(
  result: ClaudeResult,
  reviewCycle: number,
  task = "(task 미지정)",
  allowedPathPrefixes?: string[],
  projectContext: ReviewProjectContext = DEFAULT_REVIEW_PROJECT_CONTEXT,
  executor?: SafeExecutorContext,
  /** orchestrator.ts가 자신의 loop-local 카운터를 그대로 넘긴다(§ GptBudgetGuardInput) —
   *  이 함수 자체는 이 값을 계산/추적하지 않는다(관측 목적 pass-through일 뿐). */
  gptCallCount?: number,
  gptRawCallTotal?: number,
  /** Phase SI-3.8D — 직전 round가 반환한 GptReviewApiResult.reviewBaseline을 호출부가 그대로
   *  넘긴다. 지정하지 않으면(첫 review, 또는 baseline 개념이 없는 기존 호출부) 항상 FULL로
   *  동작한다 — 기존 동작을 바꾸지 않는다. */
  baseline?: ReviewBaseline,
  /** Phase SI-3.8E — Reviewer Provider Abstraction. 지정하지 않으면 production default인
   *  finalReviewerProductionProvider(§ final-reviewer-provider-selection.ts, Groq
   *  openai/gpt-oss-120b)를 쓴다. tests가 실제 네트워크 호출 없이 Reviewer Core(payload 구성/
   *  Budget Guard/baseline/Final Consistency Cross-check)를 검증하기 위한 주입 지점이기도
   *  하다 — provider 선택/routing 로직 자체는 아니다(그 판단은 이제
   *  final-reviewer-provider-selection.ts 하나가 담당한다). */
  provider: ReviewProvider = finalReviewerProductionProvider,
  /** Phase SI-3.8E Security Ordering Correction — Provider Security Gate(provider-security-gate.ts)
   *  override 지점. 지정하지 않으면 production default: classification은 항상
   *  DEFAULT_REVIEWER_DATA_CLASSIFICATION(CONFIDENTIAL), registry는
   *  resolveFinalReviewerProductionSecurityRegistry()(§ final-reviewer-provider-selection.ts,
   *  Groq 하나만 아는 registry, AUTODEV_GROQ_ZDR_VERIFIED 여부에 따라 zero/bounded)를 쓴다.
   *  tests가 fake provider를 위한 호환 metadata를 주입하거나, Security Gate가 실제로 BLOCK하는
   *  경로를 검증하기 위한 seam이다 — provider 선택과 마찬가지로 이 값 자체는 production
   *  기본값을 바꾸지 않는다. */
  securityGateOverrides?: { classification?: DataClassification; registry?: ProviderSecurityRegistry }
): Promise<GptReviewApiResult> {
  const effectiveAllowedPathPrefixes = allowedPathPrefixes ?? projectContext.scopeDirs;
  const { input, scopeViolations, reviewMode, newBaseline, consistencySnapshot } = buildReviewInput(
    task,
    result,
    reviewCycle,
    effectiveAllowedPathPrefixes,
    projectContext,
    executor,
    baseline
  );
  const instructions = buildSystemInstructions(projectContext);

  // GPT Reviewer API Budget Guard(SI-3.8A) — 실제 OpenAI API를 호출하기 직전의 마지막
  // deterministic 검문소다. 여기서 BLOCK이면 getClient()조차 호출하지 않는다(아래 try 블록
  // 진입 자체를 하지 않음) — API 호출 0회를 구조적으로 보장한다. 재시도로 해결되는 문제가
  // 아니므로 transient는 항상 false다(reviewClaudeResultWithRetry가 즉시 반환하고 재시도하지
  // 않음). FULL/INCREMENTAL/SAFE_FULL_FALLBACK 어느 모드로 만들어진 payload든 완성된
  // instructions+input 글자수/추정 토큰수만으로 판정하므로 이 Guard는 세 모드 모두에 동일하게
  // 적용된다(§ 요구사항 10 — 모드별 예외 없음).
  const budgetGuardResult = evaluateGptBudgetGuard(
    { instructions, input, reviewCycle, gptCallCount, gptRawCallTotal },
    resolveGptBudgetGuardConfig()
  );
  if (budgetGuardResult.verdict === "BLOCK") {
    log(`GPT Budget Guard BLOCK(${budgetGuardResult.blockCode}) — OpenAI API 호출 생략`, {
      reviewCycle,
      reviewMode,
      payloadChars: budgetGuardResult.payloadChars,
      estimatedInputTokens: budgetGuardResult.estimatedInputTokens,
      config: budgetGuardResult.config,
    });
    return {
      decision: "HUMAN_REQUIRED",
      severity: { critical: 0, high: 0, medium: 0 },
      feedback: `GPT Budget Guard: ${budgetGuardResult.reason}`,
      nextTask: null,
      errorCode: "BUDGET_EXCEEDED",
      transient: false,
      scopeViolations,
      reviewMode,
      reviewBaseline: newBaseline,
      payloadChars: budgetGuardResult.payloadChars,
    };
  }

  // Phase SI-3.8E Security Ordering Correction — Provider Security Gate(SI-3.8C)는 Budget
  // Guard를 통과한 뒤, provider.review()를 호출하기 전에 항상 실행된다(payload build → Budget
  // Guard → Provider Security Gate → provider.review()). registry에 이 provider.id가 없거나
  // (예: 테스트 fake provider, 향후 다른 provider가 명시적으로 등록되지 않은 경우) metadata가
  // 불완전하면 evaluateProviderSecurity()가 PROVIDER_UNKNOWN/PROVIDER_METADATA_INCOMPLETE로
  // BLOCK한다 — 어떤 provider도 이 registry에 없다는 이유만으로 자동 allow되지 않는다(§
  // 요구사항 5 Provider identity). classification 판정 자체는 이 함수가 임의로 하지 않는다 —
  // 우선순위는 (1) 호출부가 명시적으로 지정한 securityGateOverrides.classification(항상 최우선
  // — 어떤 caller가 실제로 CONFIDENTIAL/RESTRICTED를 명시하면 provider의 자기 선언으로 절대
  // 낮출 수 없다), (2) provider.reviewerDataClassification(review-provider.ts, Final Reviewer
  // Routing 실용형 보안 정책 — provider가 스스로 선언하는 선택적 값, 지정하지 않는 provider는
  // 이 단계가 그냥 없는 것과 동일), (3) DEFAULT_REVIEWER_DATA_CLASSIFICATION(CONFIDENTIAL, 기존
  // 동작과 완전히 동일한 최종 fallback). provider-security-gate.ts의 판정 로직 자체는 전혀
  // 바뀌지 않는다 — 이 3단계는 그 로직에 "어떤 classification을 물어볼지"만 결정할 뿐이다.
  // production default registry는 resolveFinalReviewerProductionSecurityRegistry()다(§
  // final-reviewer-provider-selection.ts).
  const dataClassification = securityGateOverrides?.classification ?? provider.reviewerDataClassification?.() ?? DEFAULT_REVIEWER_DATA_CLASSIFICATION;
  const securityRegistry = securityGateOverrides?.registry ?? resolveFinalReviewerProductionSecurityRegistry();
  const securityResult = evaluateProviderSecurity({ classification: dataClassification, providerId: provider.id }, securityRegistry);
  if (securityResult.verdict === "BLOCK") {
    log(`GPT Provider Security Gate BLOCK(${securityResult.blockCode}) — provider 호출 생략`, {
      reviewCycle,
      reviewMode,
      providerId: provider.id,
      classification: dataClassification,
    });
    return {
      decision: "HUMAN_REQUIRED",
      severity: { critical: 0, high: 0, medium: 0 },
      feedback: `GPT Provider Security Gate: ${securityResult.reason}`,
      nextTask: null,
      errorCode: "PROVIDER_SECURITY_BLOCKED",
      transient: false,
      scopeViolations,
      reviewMode,
      reviewBaseline: newBaseline,
      payloadChars: budgetGuardResult.payloadChars,
    };
  }

  // Phase SI-3.8E — Reviewer Provider Abstraction. Budget Guard와 Provider Security Gate를
  // 모두 통과한 뒤에만 provider를 호출한다(§ 요구사항 7 Budget Guard Ordering, § 요구사항 4
  // Provider Security Gate Ordering) — provider.review()가 호출되는 유일한 지점이다. provider가
  // 실제로 client를 어떻게 생성/호출하는지(예: OpenAI SDK 자격증명 누락으로 인한 로컬 실패 vs
  // 실제로 전송된 요청의 실패)는 ReviewProviderResult.requestAttempted가 이미 구분해 알려준다
  // (§ review-provider.ts) — 이 파일은 그 구분을 그대로 옮길 뿐 다시 판단하지 않는다.
  //
  // Claude code-review 지적 — review-provider.ts의 contract는 provider가 항상 resolve하고
  // (절대 throw/reject하지 않고) ok:true/false로만 결과를 표현하라고 문서화하지만, 이 Core는
  // 그 계약을 강제할 방법이 없다(TypeScript는 런타임에 이를 보장하지 않는다). 삭제된 이전
  // 코드는 client 생성/API 호출 전체를 try/catch로 감싸 어떤 실패도 항상 HUMAN_REQUIRED로
  // 안전하게 수렴시켰다 — provider 구현이 계약을 어기고 throw/reject하는 경우에도 동일하게
  // 안전한 방향으로 수렴하도록 이 호출도 try/catch로 감싼다(provider 신뢰도와 무관하게 Core가
  // 최종 방어선이 되게 한다).
  let providerResult: ReviewProviderResult;
  try {
    providerResult = await provider.review({ instructions, input });
  } catch (e) {
    log(`GPT 리뷰 provider 예외 발생(provider가 review-provider.ts 계약을 위반함) — ${sanitizeForLog(String(e)).slice(0, 200)}`, { reviewCycle });
    return {
      decision: "HUMAN_REQUIRED",
      severity: { critical: 0, high: 0, medium: 0 },
      feedback: "GPT API 오류: PROVIDER_THREW",
      nextTask: null,
      errorCode: "API_ERROR",
      transient: false,
      scopeViolations,
      // Claude code-review 지적 — provider가 계약을 어기고 throw하면 실제로 요청이 나갔는지
      // 알 방법이 없다(provider 내부 상태를 신뢰할 수 없으므로). "확인되지 않으면 실제 사용량
      // 으로 세지 않는다"는 이 파일의 기존 원칙(§ client 생성 실패 분기와 동일)을 그대로
      // 적용해 requestAttempted=false로 남긴다 — Usage Ledger가 이 요청을 실제 API 호출로
      // 과다 집계하지 않게 한다.
      requestAttempted: false,
      reviewMode,
      reviewBaseline: newBaseline,
      payloadChars: budgetGuardResult.payloadChars,
    };
  }

  if (!providerResult.ok) {
    if (providerResult.requestAttempted === false) {
      log(`GPT 리뷰 클라이언트 생성 실패(${providerResult.errorCode}) — 실제 요청은 전송되지 않음`, { reviewCycle });
    } else {
      log(`GPT 리뷰 API 오류(${providerResult.errorCode})`, { reviewCycle, transient: providerResult.transient });
    }
    return {
      decision: "HUMAN_REQUIRED",
      severity: { critical: 0, high: 0, medium: 0 },
      feedback: `GPT API 오류: ${providerResult.errorCode}`,
      nextTask: null,
      errorCode: providerResult.errorCode,
      transient: providerResult.transient,
      scopeViolations,
      requestAttempted: providerResult.requestAttempted === false ? false : undefined,
      reviewMode,
      reviewBaseline: newBaseline,
      payloadChars: budgetGuardResult.payloadChars,
    };
  }

  // 실제 provider 호출이 응답을 반환한 시점부터는(파싱 성공 여부와 무관하게) 이미 실제 토큰이
  // 소비됐다 — model/tokenUsage는 그 실제 호출 1건에 대해 정확히 한 번만 존재하므로, 아래 두
  // return 경로(정상/INVALID_OUTPUT) 모두에 동일하게 붙인다(§ 요구사항: 실제로 호출됐을 때
  // 얻을 수 있는 값은 누락하지 않는다). 실패 분기(위 !providerResult.ok)에는 이 값이 존재하지
  // 않는다.
  const { outputText, model, tokenUsage } = providerResult;

  let parsed: GptReviewResult;
  try {
    parsed = JSON.parse(outputText) as GptReviewResult;
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
      reviewMode,
      reviewBaseline: newBaseline,
      payloadChars: budgetGuardResult.payloadChars,
    };
  }

  // Final Consistency Cross-check(§ 요구사항 9) — decision=PASS를 그대로 신뢰하기 직전에,
  // "이번 round의 payload를 만든 시점"의 snapshot(newBaseline.fileHashes)과 "지금(provider
  // round-trip 이후) 다시 계산한 snapshot"이 완전히 같은지 로컬 hash 비교만으로 재확인한다
  // (provider를 다시 호출하지 않는다). working tree가 review 도중 실제로 달라졌다면 PASS를
  // 그대로 반환하지 않고 HUMAN_REQUIRED로 강제 전환한다 — "previous PASS를 단순히 신뢰하지
  // 않는다"는 원칙을 APPROVED 후보 시점에도 동일하게 적용한다.
  if (parsed.decision === "PASS") {
    if (hasWorkingTreeDriftedSincePayload(projectContext.scopeDirs, consistencySnapshot, executor)) {
      log("GPT 리뷰 Final Consistency Cross-check 실패 — working tree가 review 도중 변경됨, PASS를 신뢰하지 않음", {
        reviewCycle,
        reviewMode,
      });
      return {
        decision: "HUMAN_REQUIRED",
        severity: parsed.severity,
        feedback: `Final Consistency Cross-check 실패: review payload를 만든 시점과 decision을 받은 시점 사이에 working tree가 변경되었습니다. 원래 GPT feedback: ${parsed.feedback}`,
        nextTask: parsed.nextTask,
        errorCode: "REVIEW_CONSISTENCY_CHECK_FAILED",
        transient: false,
        scopeViolations,
        model,
        tokenUsage,
        reviewMode,
        reviewBaseline: newBaseline,
        payloadChars: budgetGuardResult.payloadChars,
      };
    }
  }

  log("GPT 리뷰 완료", { reviewCycle, decision: parsed.decision, severity: parsed.severity, reviewMode });
  return {
    ...parsed,
    scopeViolations,
    model,
    tokenUsage,
    reviewMode,
    reviewBaseline: newBaseline,
    payloadChars: budgetGuardResult.payloadChars,
  };
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
  /** SI-3.8A — 호출부(orchestrator.ts)의 GPT 호출 횟수 카운터를 Budget Guard 관측값으로
   *  그대로 전달한다(§ gpt-budget-guard.ts GptBudgetGuardInput.gptCallCount/
   *  gptRawCallTotal) — 지정하지 않으면 undefined로 전달될 뿐, 이 값 자체로 BLOCK하지
   *  않는다(그 상한은 orchestrator.ts의 MAX_GPT_CALLS/MAX_GPT_RAW_CALLS가 이미 별도로
   *  강제한다). */
  gptCallCount?: number;
  gptRawCallTotal?: number;
  /** Phase SI-3.8D — 직전 round의 GptReviewRetryResult.reviewBaseline을 호출부(orchestrator.ts/
   *  agent-orchestrator.ts)가 loop-local 변수로 그대로 넘긴다. 재시도 wrapper는 이 값을
   *  attempt마다 그대로 재사용한다(같은 round 안의 재시도는 같은 payload/baseline을 다시
   *  보낼 뿐, 새 round로 진행하지 않는다 — § 요구사항 21 "retry wrapper does not bypass
   *  baseline/budget failure"). */
  baseline?: ReviewBaseline;
  /** Phase SI-3.8E — Reviewer Provider Abstraction. attempt마다(재시도 포함) 이 provider를
   *  그대로 재사용한다. 지정하지 않으면 reviewClaudeResultOnce의 production default
   *  (OpenAIReviewProvider)가 쓰인다 — tests가 실제 OpenAI 호출 없이 재시도/오류 분류
   *  semantics를 검증하기 위한 주입 지점이다(§ 요구사항 12 Dependency Injection). */
  provider?: ReviewProvider;
  /** Phase SI-3.8E Security Ordering Correction — attempt마다(재시도 포함) 이 override를
   *  그대로 재사용한다. 지정하지 않으면 reviewClaudeResultOnce의 production default
   *  (CONFIDENTIAL classification + OpenAI-only registry)가 쓰인다 — tests가 fake provider용
   *  호환 metadata를 주입하거나 Security Gate의 실제 BLOCK 경로를 검증하기 위한 주입 지점이다. */
  securityGateOverrides?: { classification?: DataClassification; registry?: ProviderSecurityRegistry };
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
    const r = await attempt(
      result,
      reviewCycle,
      task,
      allowedPathPrefixes,
      projectContext,
      opts.executor,
      opts.gptCallCount,
      opts.gptRawCallTotal,
      opts.baseline,
      opts.provider,
      opts.securityGateOverrides
    );
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

// Phase SI-3.8B — Usage & Cost Ledger 연결. 이 파일(gpt-reviewer.ts) 자신은 Ledger를
// 저장/조회하지 않는다(호출부인 orchestrator.ts/agent-orchestrator.ts가 이미 project/task/
// agent identity를 알고 있고, Ledger append도 그쪽에서 수행한다) — 여기서는 그 두 호출부가
// 공유하는 "GPT reviewer 호출 결과 → UsageLedgerEntryInput" 매핑 로직 하나만 제공해서 같은
// 변환 로직이 두 파일에 복제되지 않게 한다.
export interface GptReviewLedgerContextFields {
  projectId?: string;
  taskId?: string;
  agentId?: string;
  /** review cycle(orchestrator.ts의 state.reviewCycle 또는 agent-orchestrator.ts의 내부
   *  REVISE cycle) — UsageLedgerEntryInput.operationCycle에 그대로 옮긴다. */
  operationCycle?: number;
}

/** GPT reviewer 서비스 식별자 — Ledger entry의 service 필드에 그대로 쓰인다(단일 출처). */
export const GPT_REVIEWER_LEDGER_SERVICE = "gpt-reviewer";
export const GPT_REVIEWER_LEDGER_OPERATION = "gpt_review";

/**
 * 순수 함수 — 실제 API를 호출하거나 Ledger에 append하지 않는다. requestCount=0으로 고정되는
 * 경우는 둘이다(§ 요구사항 8/Claude code-review) — (1) Budget Guard가 API 호출 자체를 막은
 * 경우(errorCode==="BUDGET_EXCEEDED"), (2) result.requestAttempted===false(OpenAI SDK
 * 클라이언트 생성 자체가 실패해 실제 네트워크 요청이 전혀 나가지 않은 경우 — §
 * reviewClaudeResultOnce의 client 생성 분리). errorCode만으로는 이 둘을 구분할 수 없다 —
 * classifyApiError()가 "요청을 아예 못 보낸 로컬 실패"와 "요청을 보냈지만 실패한 경우"를 같은
 * errorCode(API_ERROR)로 분류할 수 있기 때문이다. 그 외에는 실제로 시도된 API 통신 횟수(최초
 * 시도 + gptTransportRetry)를 requestCount로 담는다 — reviewCycle 자체(코드 재작업 횟수)와는
 * 다른 값이다.
 *
 * estimatedCostUsd는 pricing-catalog.ts의 CORE_PRICING_CATALOG에 해당 provider/model 가격이
 * 등록돼 있을 때만 채워진다 — 이번 Task 시점에는 그 catalog가 비어 있으므로(§
 * pricing-catalog.ts 상단 주석) 항상 undefined다. actualCostUsd는 이 함수가 절대 채우지
 * 않는다(실제 billing source를 연결하지 않았다 — § 요구사항 5).
 */
export function buildGptReviewLedgerEntryInput(
  result: {
    /** orchestrator.ts의 GptReviewerReturn.errorCode(string)와 gpt-reviewer.ts의
     *  GptReviewApiResult.errorCode(GptErrorCode) 양쪽 호출부를 모두 그대로 받을 수 있게
     *  일부러 GptErrorCode보다 넓은 string으로 받는다(둘 다 이 함수의 유일한 실제 호출부). */
    errorCode?: string;
    model?: { provider: string; name: string };
    tokenUsage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number; totalTokens?: number };
    gptTransportRetry?: number;
    requestAttempted?: boolean;
    /** Phase SI-3.8D — GptReviewApiResult.reviewMode/payloadChars를 그대로 옮긴다(있으면). */
    reviewMode?: string;
    payloadChars?: number;
  },
  fields: GptReviewLedgerContextFields
): UsageLedgerEntryInput {
  // Phase SI-3.8E Security Ordering Correction — Provider Security Gate BLOCK도 Budget Guard
  // BLOCK과 동일하게 provider.review()를 전혀 호출하지 않은 상태다. errorCode만으로 두 preflight
  // BLOCK을 하나의 "실제 API 호출 아님" 판정으로 묶되, status 필드(아래 `result.errorCode ??
  // "SUCCESS"`)는 여전히 BUDGET_EXCEEDED/PROVIDER_SECURITY_BLOCKED를 그대로 구분해서 남긴다
  // (§ 요구사항 9/11 — Security BLOCK을 provider API error로 잘못 기록하지 않음, Budget BLOCK과
  // Provider Error를 혼동하지 않음).
  const isPreflightBlocked = result.errorCode === "BUDGET_EXCEEDED" || result.errorCode === "PROVIDER_SECURITY_BLOCKED";
  const requestNeverSent = isPreflightBlocked || result.requestAttempted === false;
  const requestCount = requestNeverSent ? 0 : 1 + (result.gptTransportRetry ?? 0);
  const status = result.errorCode ?? "SUCCESS";

  // Phase SI-3.8E(Claude code-review 지적) — Reviewer Provider Abstraction 이후
  // GptReviewApiResult.model.provider가 실제로 응답한 provider 식별자를 담을 수 있게 됐다.
  // 이 Ledger 매핑이 여전히 "openai"를 하드코딩하면, 향후(이번 Task 범위 밖) 다른
  // ReviewProvider가 실제로 연결됐을 때 Usage Ledger의 provider 필드와 가격 조회가 실제
  // 호출된 provider와 다른 값으로 조용히 잘못 기록된다 — 실제로 응답한 provider가 있으면 그
  // 값을 쓰고, 없으면(응답을 받은 적이 없는 실패 — BUDGET_EXCEEDED/client 생성 실패 등)
  // 기존과 동일하게 "openai"로 fallback한다(이 파일의 production default provider가 여전히
  // OpenAIReviewProvider뿐이므로 기존 동작은 그대로 보존된다).
  const provider = result.model?.provider ?? "openai";
  const pricing = resolvePricing(provider, result.model?.name);
  const cost = calculateEstimatedCost(
    {
      inputTokens: result.tokenUsage?.inputTokens,
      cachedInputTokens: result.tokenUsage?.cachedInputTokens,
      outputTokens: result.tokenUsage?.outputTokens,
    },
    pricing
  );

  return {
    projectId: fields.projectId,
    taskId: fields.taskId,
    agentId: fields.agentId,
    environment: isProductionRuntime() ? "production" : "development",
    service: GPT_REVIEWER_LEDGER_SERVICE,
    provider,
    model: result.model?.name,
    operation: GPT_REVIEWER_LEDGER_OPERATION,
    requestCount,
    inputTokens: result.tokenUsage?.inputTokens,
    cachedInputTokens: result.tokenUsage?.cachedInputTokens,
    outputTokens: result.tokenUsage?.outputTokens,
    totalTokens: result.tokenUsage?.totalTokens,
    estimatedCostUsd: cost.status === "CALCULATED" ? cost.estimatedCostUsd : undefined,
    currency: cost.status === "CALCULATED" ? cost.currency : undefined,
    operationCycle: fields.operationCycle,
    payloadChars: result.payloadChars,
    reviewMode: result.reviewMode,
    status,
  };
}
