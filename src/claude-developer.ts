import { resolveTrustedClaudeCommand, classifySubprocessOutcome } from "./claude-runner";
import type { ClaudeErrorCode } from "./claude-runner";
import { runSubprocessWithTimeout } from "./subprocess-runner";
import { validateAndExecute, PROJECT_ROOT } from "./safe-executor";
import type { ExecutorAction, SafeExecutorContext } from "./safe-executor";
import { getWorkingTreeChanges } from "./git-changes";
import type { RequiredTestCommand } from "./task-registry";
import { log, sanitizeForLog } from "./logger";

// Claude Developer — built-in Read/Edit/Write/Bash를 전혀 주지 않는다(항상 --tools "").
// 대신 Claude는 JSON ACTION_REQUEST로 무엇을 읽고/검색하고/수정하고 싶은지 "요청"만 하고,
// 실제 실행은 Node의 Safe Executor(safe-executor.ts)가 검증 후 수행한다. 하드 보안 경계는
// 전부 Safe Executor 코드에 있고, 이 파일이나 시스템 프롬프트의 지시는 신뢰 경계가 아니다.
//
// AutoDev 범용화 Phase A Task A6 — 이 파일(Core)은 이제 어떤 프로젝트를 개발하고 있는지
// 전혀 모른다. "MOVAN ERP 개발자"라고 가정하지 않고, 프로젝트 이름/허용 범위 설명/금지
// 사항 같은 실제 내용은 전부 호출부(autodev.ts)가 ProjectManifest로부터 조립해 주입하는
// DeveloperProjectContext를 통해서만 얻는다(§ DEFAULT_PROJECT_CONTEXT는 어떤 프로젝트도
// 가리키지 않는 범용 기본값이다). 실제 MOVAN 운용에서는 autodev.ts가 항상 명시적으로
// MOVAN_PROJECT_MANIFEST 기반 context를 넘기므로 기존 동작은 그대로 보존된다.

/** Claude Developer system prompt에 삽입되는 프로젝트별 맥락 — Core는 이 값의 의미를
 *  모른다(호출부가 ProjectManifest로부터 조립해 주입한다). */
export interface DeveloperProjectContext {
  /** system prompt 도입부("당신은 {projectName}의 자동 개발자입니다")에 삽입된다. */
  projectName: string;
  /** 허용 read/write 범위, 금지 사항, 프로젝트 맥락 등 — system prompt에 그대로 삽입된다. */
  instructions: string;
}

// Core 기본값 — 명시적으로 project context가 주입되지 않았을 때만 쓰인다(예: 이 함수를
// manifest 배선 없이 직접 부르는 경우). 특정 프로젝트를 가리키지 않는다 — 실제 프로젝트별
// 내용은 항상 호출부가 명시적으로 주입해야 한다(§ 요구사항: silent fallback으로 특정
// 프로젝트 규칙을 흉내내지 않는다).
const DEFAULT_PROJECT_CONTEXT: DeveloperProjectContext = {
  projectName: "AutoDev가 관리하는 프로젝트",
  instructions:
    "이 프로젝트에 대한 별도 규칙이 지정되지 않았습니다. 허용된 read/write 범위와 금지 " +
    "사항은 Safe Executor가 실제로 강제합니다 — 요청이 거부되면 denyReason을 참고해 " +
    "허용된 범위 안에서만 작업하세요.",
};

// 존재할 수 없는 경로 — changeScopeDirs가 지정되지 않았을 때 "아무것도 스캔하지 않음"을
// 보장한다(gpt-reviewer.ts의 NO_SCOPE_CONFIGURED와 동일한 이유: 빈 배열을 그대로 pathspec으로
// 넘기면 "제한 없음"이 되어 repository 전체를 스캔하게 된다).
const NO_SCOPE_CONFIGURED = ["__autodev_no_project_scope_configured__/"];

export type DeveloperErrorCode = ClaudeErrorCode | "TASK_ACTION_LIMIT" | "PROTOCOL_ERROR" | "NO_PROGRESS_STAGNATION";

export interface DeveloperResult {
  success: boolean;
  summary: string;
  changedFiles: string[];
  tests: { name: string; pass: boolean }[];
  rawOutput: string;
  errorCode?: DeveloperErrorCode;
  deferredHumanTasks?: string[];
  /** Phase G Task G3.1 — 이 developer attempt(1회의 runDeveloperTaskViaSafeExecutor 호출)
   *  안에서 실제로 성공한 모든 내부 round(claude CLI 호출)의 tokenUsage를 합산하고, model은
   *  가장 최근 round에서 관측된 값을 담는다(같은 세션이라 round마다 달라지지 않는다). CLI가
   *  값을 전혀 주지 않았으면(또는 실제 호출이 한 번도 성공하지 않았으면) undefined. */
  model?: { provider: string; name: string };
  tokenUsage?: { inputTokens?: number; outputTokens?: number };
}

export interface DeveloperTaskOptions {
  timeoutPerRoundMs?: number;
  /** 테스트 전용 override — 기본은 항상 실제 claude CLI 호출(callClaude). 운용 코드는 절대 바꾸지 않는다. */
  claudeCaller?: (input: string, timeoutMs: number) => ReturnType<typeof callClaude>;
  /**
   * TASK_COMPLETE 이후 AutoDev가 Safe Executor로 직접 실행해 실제 exitCode로 검증하는
   * 필수 테스트(task-registry.ts). Claude의 자체 보고(summary/testsRequested 문자열)는
   * 신뢰하지 않는다 — 여기 설정된 명령만 진짜로 실행되고, 그 결과만 DeveloperResult.tests에
   * 담긴다(§ 요구사항 6). 비어 있으면 tests는 빈 배열로 반환된다(기존 동작과 동일).
   */
  requiredTests?: RequiredTestCommand[];
  /**
   * task-registry.ts TaskDefinition.allowedPathPrefixes — 지정하면 이 함수 시작 시 그 범위
   * 안에 이미 존재하는 uncommitted 변경을 감지해 "버리지 말고 이어서 진행하라"는 안내를
   * 초기 transcript에 포함시킨다(§ 이전 시도가 USAGE_LIMIT 재시도 예산을 다 써서 새
   * 프로세스로 재시작해야 하는 최후의 경우에도 이미 써둔 코드를 Claude가 인지하고 이어가게
   * 하기 위함). 지정하지 않으면 기존 동작과 동일(감지 안 함).
   */
  allowedPathPrefixes?: string[];
  /** USAGE_LIMIT 재시도 대기 시간(ms) — 테스트에서만 짧게 override, 실제 운용은 항상 30분. */
  usageLimitWaitMs?: number;
  /** USAGE_LIMIT 재시도 최대 횟수 — 이 횟수 안에서는 round/discovery budget/lock grace를
   *  전혀 소비하지 않고 같은 라운드를 같은 transcript로 재시도한다. */
  usageLimitMaxRetries?: number;
  /** 테스트 전용 override — 기본은 실제 setTimeout 기반 대기. */
  sleep?: (ms: number) => Promise<void>;
  /** 이 task를 수행할 프로젝트의 맥락(system prompt에 삽입) — 지정하지 않으면
   *  DEFAULT_PROJECT_CONTEXT(범용 기본값)를 쓴다. 실제 운용은 autodev.ts가 ProjectManifest로
   *  부터 조립해 항상 명시적으로 넘긴다. */
  projectContext?: DeveloperProjectContext;
  /** DeveloperResult.changedFiles를 계산할 때 스캔할 프로젝트 전체 소스 범위(POSIX 상대경로,
   *  trailing "/") — 지정하지 않으면 아무것도 스캔하지 않는다(§ NO_SCOPE_CONFIGURED). 실제
   *  운용은 autodev.ts가 manifest.reviewScopeDirs를 그대로 넘긴다(GPT reviewer가 스캔하는
   *  범위와 동일). */
  changeScopeDirs?: string[];
  /** Phase C Task C2 — 이 developer task가 속한 project run 전용 SafeExecutorContext.
   *  지정하면 이 함수가 실제 파일 읽기/쓰기/명령 실행(ACTION_REQUEST 처리, 필수 테스트
   *  실행)과 changedFiles 계산에 이 context의 root/policy만 쓴다 — 다른 project의
   *  configureSafeExecutor() 호출에 영향받지 않는다. 지정하지 않으면 기존과 동일하게
   *  module-level singleton(Safe Executor의 configureSafeExecutor로 주입된 것)을 쓴다
   *  (하위 호환 — 기존 테스트가 계속 동작한다). 실제 운용(autodev.ts)은 항상 명시적으로
   *  넘긴다. */
  executor?: SafeExecutorContext;
}

const MAX_INTERNAL_ROUNDS = 20;
const MAX_TRANSCRIPT_CHARS = 120_000;
// USAGE_LIMIT(Claude 계정 세션/사용량 제한)은 developer task의 "실패"가 아니라 "일시정지"로
// 취급한다 — 실제 3차 E2E에서 orchestrator가 USAGE_LIMIT마다 이 함수를 처음부터 다시
// 호출해 transcript/round/discovery/lock 상태를 전부 잃어버리는 문제가 실제로 발생했다
// (이미 write한 파일은 디스크에 남지만, 그 다음 세션은 그걸 썼다는 기억이 전혀 없었다).
// 이제 이 함수 내부에서 같은 라운드의 같은 input(transcript)으로 재시도하며, round 카운터/
// discoveryOnlyRoundCount/lockedNoProgressCount/MAX_INTERNAL_ROUNDS 중 어느 것도 소비하지
// 않는다. orchestrator.ts에도 이름이 비슷한 상수(MAX_CLAUDE_LIMIT_WAITS/CLAUDE_LIMIT_WAIT_MS)가
// 있지만, 그건 developer 내부 상태를 전혀 모르는 채로 세션을 통째로 재생성하던 이전 경로를
// 위한 것이다 — 실제 developer 러너(이 함수)를 쓰는 한 그 경로는 이 함수가 스스로 훨씬 큰
// 예산으로 재시도를 흡수하기 때문에 정상 운용에서는 거의 발동하지 않는다(주입된 fake
// claudeRunner를 쓰는 orchestrator 레벨 테스트를 위한 안전망으로만 남겨둔다).
const DEVELOPER_USAGE_LIMIT_MAX_RETRIES = 12;
const DEVELOPER_USAGE_LIMIT_WAIT_MS = 30 * 60 * 1000;
const defaultDeveloperSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const FORBIDDEN_REPEAT_LIMIT = 3;
// REVISE(bounded discovery, 실제 Phase 13 Task 2 E2E 실패 사후 반영) — 이전 버전은
// "novel 여부"로 게이팅했다: 매번 다른(아직 안 본) 파일을 read/search하면 무진척 카운터가
// 계속 0으로 리셋됐다. 실제 라이브 실행에서 Claude가 20라운드 내내 서로 다른 파일만 계속
// 탐색하고 단 한 번도 WRITE_FILE/APPLY_PATCH에 도달하지 못한 채 MAX_INTERNAL_ROUNDS에
// 도달해 TASK_ACTION_LIMIT으로 종료된 사례가 실제로 발생했다 — novelty만으로는 "계속 넓게
// 탐색만 하고 구현으로 전환하지 않는" 패턴을 막지 못한다.
//
// 지금은 novel 여부와 무관하게 "총 discovery-only 라운드 수"(READ_FILES/SEARCH만 있는
// ACTION_REQUEST 라운드 + PLAN 라운드)를 누적으로만 센다(§ discoveryOnlyRoundCount).
// 코드 변경(WRITE_FILE/APPLY_PATCH 성공)이 한 번이라도 성공하면(codeChangeHappened) 이후
// 이 카운트는 더 이상 갱신되지도, 검사되지도 않는다 — "정상적인 초기 조사"가 stagnation으로
// 오판되지 않게 하는 핵심 장치는 그대로 유지한다(다만 그 조사가 "코드 변경 전"이라는 조건
// 하나만으로 판단하고, 반복인지 새 파일인지는 더 이상 구분하지 않는다).
const DISCOVERY_BUDGET_ROUNDS = 6;
// REVISE(2차 실전 E2E 실패 사후 반영) — 이전 버전은 discovery 예산 소진 시 nudge를 보내되
// 그 이후에도 READ_FILES/SEARCH를 여전히 정상 실행했다(advisory nudge only). 실제 라이브
// 실행에서 Claude가 nudge를 받고도 계속 READ_FILES/SEARCH/PLAN만 요청해 grace(3회) 안에
// NO_PROGRESS_STAGNATION으로 끝난 사례가 실제로 발생했다 — "안내"만으로는 구현 전환을
// 강제하지 못한다. 이제 discovery 예산 소진 시 IMPLEMENTATION_REQUIRED 상태로 전환하고,
// 이 상태의 READ_FILES/SEARCH-only 라운드는 Safe Executor를 아예 호출하지 않고 코드
// 레벨에서 거부한다(§ DISCOVERY_REJECTION_MESSAGE). WRITE_FILE/APPLY_PATCH가 섞인 라운드나
// 성공한 write는 그대로 처리되며, 성공 즉시(codeChangeHappened=true) 이 상태 자체가
// 무의미해진다(이후 모든 검사가 스킵됨 — 기존 설계와 동일).
const IMPLEMENTATION_LOCK_GRACE = 3;
const NUDGE_MESSAGE =
  "# AutoDev 안내\n" +
  "지금까지 조사(READ_FILES/SEARCH/PLAN)만 계속되고 실제 코드 변경(WRITE_FILE/APPLY_PATCH)이 " +
  "전혀 없습니다 — 새로운 파일을 계속 찾고 있더라도 마찬가지입니다. 지금부터 READ_FILES/" +
  "SEARCH만 있는 요청은 더 이상 실제로 실행되지 않고 거부됩니다. 지금까지 확인한 정보로 " +
  "지금 바로 WRITE_FILE 또는 APPLY_PATCH로 실제 코드 변경을 시작하세요. 계획을 한 번 더 " +
  "정리해야 한다면 PLAN을 최대 1회만 쓸 수 있고, 그 이후로는 반드시 WRITE_FILE/APPLY_PATCH로 " +
  "이어가야 합니다. 이 안내 이후에도 코드 변경 없이 거부된 조사나 반복 PLAN만 계속되면 " +
  "작업이 자동 종료됩니다.";
const DISCOVERY_REJECTION_MESSAGE =
  "Discovery budget exhausted. Further READ_FILES/SEARCH is blocked. " +
  "Use the information already collected and issue WRITE_FILE or APPLY_PATCH now.";
const PLAN_LOCK_REPEAT_MESSAGE =
  "Discovery budget exhausted. The one-time post-lock PLAN has already been used. " +
  "Issue WRITE_FILE or APPLY_PATCH now instead of another PLAN.";

// system prompt 자체는 신뢰 경계가 아니다(§ 상단 주석) — 여기 들어가는 프로젝트별 내용은
// 순수 안내문이고, 실제 강제는 Safe Executor(safe-executor.ts)가 코드 레벨로 한다. 그래서
// ctx.instructions에 어떤 문자열이 와도(빈 프로젝트 규칙 포함) 안전 경계 자체는 약화되지
// 않는다.
// export: developer-reviewer-context-tests.ts가 실제 claude CLI를 호출하지 않고도 system
// prompt에 프로젝트별 내용이 정확히 삽입되는지(그리고 다른 프로젝트 내용이 섞이지 않는지)
// 직접 검증할 수 있게 한다.
export function buildProtocolSystemPrompt(ctx: DeveloperProjectContext): string {
  return `당신은 ${ctx.projectName}의 자동 개발자입니다.
이 세션에는 built-in 파일/명령 도구가 전혀 없습니다(Read/Edit/Write/Bash 사용 불가).
대신 Safe Executor를 통해서만 파일을 읽고, 검색하고, 수정하고, 명령을 실행할 수 있습니다.

매 턴 반드시 순수 JSON 객체 하나만 출력하세요(설명 텍스트, 마크다운 코드펜스 금지).

파일/검색/명령이 필요하면:
{"type":"ACTION_REQUEST","actions":[...]}

action 종류:
- {"type":"READ_FILES","paths":["path/to/file.ts"]}
- {"type":"SEARCH","pattern":"정규식","globs":["src"]}
- {"type":"WRITE_FILE","path":"...","content":"..."} (새 파일 생성 또는 전체 덮어쓰기)
- {"type":"APPLY_PATCH","path":"...","oldString":"...","newString":"...","replaceAll":false}
  (oldString은 대상 파일과 정확히 일치해야 하고, 여러 번 일치하면 replaceAll:true 필요)
- {"type":"RUN_COMMAND","command":"...","args":["..."],"cwd":"root"}

권장 흐름: 초기 조사(READ_FILES/SEARCH) → 필요하면 구현 계획 정리 → WRITE_FILE/APPLY_PATCH
→ 검증. 확인한 정보를 바탕으로 구현 계획을 한 번 정리하고 싶다면
{"type":"PLAN","summary":"..."}로 응답할 수 있습니다(선택 사항, 최대 몇 번이든 가능하지만
계획만 반복하고 실제 구현으로 이어지지 않으면 무진척으로 간주됩니다) — PLAN 이후에는 바로
WRITE_FILE/APPLY_PATCH로 이어가세요.

라운드 수를 아끼세요: 서로 독립적인 READ_FILES/SEARCH 요청은 여러 라운드로 나누지 말고,
가능한 한 하나의 ACTION_REQUEST의 actions 배열 안에 함께 담아 한 번에 요청하세요
(예: 파일 3개를 읽어야 하면 별도 라운드 3번이 아니라 READ_FILES 액션 1개에 paths 3개,
또는 READ_FILES/SEARCH 여러 개를 같은 actions 배열에 함께 넣으세요). 조사(READ_FILES/
SEARCH/PLAN)만 계속되고 코드 변경(WRITE_FILE/APPLY_PATCH)이 없는 라운드가 일정 횟수
쌓이면 — 매번 새로운 파일을 찾고 있더라도 마찬가지로 — AutoDev가 구현 단계로 전환하라는
안내를 한 번 보냅니다. 그 이후로는 READ_FILES/SEARCH만 있는 요청을 실제로 실행하지 않고
거부합니다(응답에 결과 대신 거부 안내가 옵니다) — 지금까지 얻은 정보로 바로 WRITE_FILE/
APPLY_PATCH를 시작하세요. 계획 정리가 꼭 필요하면 PLAN을 이 시점 이후 최대 1회만 쓸 수
있고, 그래도 코드 변경이 없으면 자동으로 조기 종료됩니다.

# 프로젝트 규칙(${ctx.projectName})
${ctx.instructions}

각 action은 실행 전 검증됩니다. 거부되면 ok:false와 denyReason이 돌아옵니다 — 거부된 방식을
반복하지 말고 다른 방법을 시도하세요. 같은 방식이 3번 거부되면 그 항목은 사람 검토용으로
넘겨지니 다른 접근으로 계속 진행하세요.

작업이 끝났다고 판단되면 반드시 이 형태로만 응답하세요:
{"type":"TASK_COMPLETE","summary":"...","changedFiles":["..."],"testsRequested":["..."]}
(changedFiles/testsRequested는 참고용일 뿐이며, 실제 채택되는 값은 AutoDev가 git status로
직접 산출하고 task에 지정된 필수 테스트를 AutoDev가 직접 실행해 검증합니다 — 당신이 "테스트
통과"라고 적는 것만으로는 승인되지 않습니다. git commit은 절대 시도하지 마세요 — AutoDev가
검토 후 자동으로 처리합니다.)

내부 라운드는 최대 ${MAX_INTERNAL_ROUNDS}회로 제한됩니다. 위 프로젝트 규칙에서 사람 확인이
필요하다고 명시한 고위험 작업은 시도하지 말고 TASK_COMPLETE의 summary에 사람 확인이
필요하다고 명시하세요.`;
}

// getActualChangedFiles/reviewer가 같은 기준(git-changes.ts)을 쓰도록 통일한다 — 이전에는
// "git diff --name-only"만 써서 신규(untracked) 파일이 changedFiles에서 누락됐다. scopeDirs는
// 호출부(runDeveloperTaskViaSafeExecutor)가 opts.changeScopeDirs로 넘긴다 — 이 함수는 어떤
// 프로젝트의 소스 범위인지 모른다.
function getActualChangedFiles(scopeDirs: string[], executor: SafeExecutorContext | undefined): string[] {
  const { all } = getWorkingTreeChanges(scopeDirs, executor?.projectRoot);
  return all.map((c) => c.path);
}

async function runRequiredTests(
  requiredTests: RequiredTestCommand[] | undefined,
  executor: SafeExecutorContext | undefined
): Promise<{ name: string; pass: boolean }[]> {
  if (!requiredTests || requiredTests.length === 0) return [];
  const doValidateAndExecute = executor?.validateAndExecute ?? validateAndExecute;
  const results: { name: string; pass: boolean }[] = [];
  for (const t of requiredTests) {
    const res = await doValidateAndExecute({ type: "RUN_COMMAND", command: t.command, args: t.args, cwd: t.cwd });
    results.push({ name: t.name, pass: res.ok });
    if (!res.ok) {
      log(`필수 테스트 실패(${t.name})`, { command: t.command, args: t.args, cwd: t.cwd, denyReason: res.denyReason });
    }
  }
  return results;
}

async function callClaude(input: string, timeoutMs: number, systemPrompt: string, projectRoot?: string) {
  // 프롬프트를 CLI 인자로 넘기지 않고 stdin으로 전달한다 — 라운드가 쌓여 프롬프트가 커지면
  // OS 명령행 길이 제한(Windows에서 실제로 ENAMETOOLONG 발생 확인)에 걸리기 때문이다.
  // "claude -p"(positional prompt 생략)가 stdin에서 읽는 것은 실제 호출로 직접 검증했다.
  const args = [
    "-p",
    "--output-format",
    "json",
    "--tools",
    "",
    "--no-session-persistence",
    "--system-prompt",
    systemPrompt,
  ];
  // SI-3.6(Executable Identity Trust) — bare "claude" 문자열을 더 이상 spawn에 직접 넘기지
  // 않는다(§ claude-runner.ts resolveTrustedClaudeCommand 상단 설명 — 이 호출부가 실제로
  // 개발 대상 project 내용을 다루는 가장 공격 표면이 큰 경로다). projectRoot를 함께
  // 넘겨 project-local 가짜 claude 실행 파일도 PATH 탐색 후보에서 제외한다.
  const trusted = resolveTrustedClaudeCommand(projectRoot ? [projectRoot] : []);
  if (!trusted.ok) return trusted.result;
  const outcome = await runSubprocessWithTimeout(trusted.command, args, timeoutMs, input);
  return classifySubprocessOutcome(outcome, timeoutMs);
}

function actionKey(action: ExecutorAction): string {
  return JSON.stringify(action).slice(0, 300);
}

// Claude가 지시를 어기고 마크다운 코드펜스나 설명 텍스트를 덧붙이는 경우까지 관대하게
// 처리한다 — 코드펜스 제거 후 직접 파싱을 시도하고, 그래도 실패하면 첫 번째 균형 잡힌
// {...} 블록을 브레이스 카운팅으로 찾아 그 부분만 파싱한다.
function tryParseProtocolJson(raw: string): { type?: string; [key: string]: unknown } | null {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    // fallthrough
  }

  const start = stripped.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = stripped.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function runDeveloperTaskViaSafeExecutor(
  task: string,
  attempt: number,
  opts: DeveloperTaskOptions = {}
): Promise<DeveloperResult> {
  void attempt;
  const timeoutMs = opts.timeoutPerRoundMs ?? 300_000;
  const changeScopeDirs = opts.changeScopeDirs ?? NO_SCOPE_CONFIGURED;
  const projectContext = opts.projectContext ?? DEFAULT_PROJECT_CONTEXT;
  const systemPrompt = buildProtocolSystemPrompt(projectContext);
  // SI-3.6 bounded review(chunk1 HIGH) 지적 반영 — executor가 지정되지 않은 호출(하위 호환
  // module-level singleton 경로)도 target project root를 빠뜨리지 않는다. PROJECT_ROOT는
  // configureSafeExecutor()가 갱신하는 살아있는 재-export 바인딩이라(§ checkpoint.ts/git-
  // changes.ts/gpt-reviewer.ts가 이미 같은 방식으로 참조) executor가 없을 때도 실제 활성
  // project root를 반영한다.
  const claudeCall =
    opts.claudeCaller ??
    ((input: string, callTimeoutMs: number) =>
      callClaude(input, callTimeoutMs, systemPrompt, opts.executor?.projectRoot ?? PROJECT_ROOT));
  const sleepFn = opts.sleep ?? defaultDeveloperSleep;
  const usageLimitWaitMs = opts.usageLimitWaitMs ?? DEVELOPER_USAGE_LIMIT_WAIT_MS;
  const usageLimitMaxRetries = opts.usageLimitMaxRetries ?? DEVELOPER_USAGE_LIMIT_MAX_RETRIES;
  // Phase C Task C2 — 이 run 전용 SafeExecutorContext(지정 안 되면 module-level singleton
  // 하위 호환). 이 함수 안의 모든 실제 read/write/명령 실행과 changedFiles 계산이 이 하나의
  // 값만 참조한다 — 다른 developer run이 자신의 executor로 무엇을 하든 이 run에는 보이지
  // 않는다.
  const executor = opts.executor;
  const doValidateAndExecute = executor?.validateAndExecute ?? validateAndExecute;

  const transcript: string[] = [`# Task\n${task}`];

  // 이전 시도(새 프로세스로 재시작 등)의 in-scope 미완성 작업물이 이미 디스크에 있으면,
  // 버리라고 하지 않고 이어서 진행하라고 명시적으로 안내한다. scope 밖 변경 차단은 여기서
  // 다루지 않는다 — 그건 기존 checkpoint/GPT reviewer의 scope-violation BLOCK 정책이 그대로
  // 담당한다(이 안내는 순수 정보 제공이지 권한 확장이 아니다).
  if (opts.allowedPathPrefixes && opts.allowedPathPrefixes.length > 0) {
    const existingInScope = getWorkingTreeChanges(opts.allowedPathPrefixes, executor?.projectRoot).all.map((c) => c.path);
    if (existingInScope.length > 0) {
      log(`developer 재개 감지 — 이전 시도의 in-scope 미완성 변경 ${existingInScope.length}개`, { files: existingInScope });
      transcript.push(
        "# AutoDev 안내(재개)\n" +
          "Existing in-scope partial changes from the previous attempt were detected. " +
          "Do not discard them. Inspect and continue the existing implementation.\n" +
          `변경된 파일 목록:\n${existingInScope.map((p) => `- ${p}`).join("\n")}`
      );
    }
  }

  const forbiddenRepeatCount = new Map<string, number>();
  const deferredHumanTasks: string[] = [];
  let codeChangeHappened = false;
  // false(DISCOVERY): 기존처럼 READ_FILES/SEARCH/PLAN이 정상 실행된다. discoveryOnlyRoundCount가
  // DISCOVERY_BUDGET_ROUNDS에 도달하면 true(IMPLEMENTATION_REQUIRED)로 전환되고 다시는
  // false로 되돌아가지 않는다(코드 변경이 성공하면 codeChangeHappened가 모든 검사를 무력화
  // 한다 — 잠금 자체를 되돌릴 필요가 없다).
  let implementationLocked = false;
  let discoveryOnlyRoundCount = 0;
  // IMPLEMENTATION_REQUIRED 상태에서 "진척 없는 시도"(거부된 discovery-only 라운드 + 1회
  // 한도를 넘긴 PLAN 반복) 누적 횟수 — novel 여부와 무관, discoveryOnlyRoundCount와 동일한
  // 정신으로 누적만 한다.
  let lockedNoProgressCount = 0;
  // IMPLEMENTATION_REQUIRED로 전환된 뒤 "구현 전환용" PLAN을 정확히 1회까지만 정상 처리한다
  // (두 번째부터는 PLAN_LOCK_REPEAT_MESSAGE로 거부).
  let planUsedInLock = false;

  // Phase G Task G3.1 — 이 developer attempt 안에서 실제로 성공한 모든 내부 round(claude CLI
  // 호출)의 tokenUsage를 합산한다. round마다 별도 event로 쪼개 기록하지 않고(canonical 위치는
  // 이 함수의 반환값 하나뿐이다) 이 attempt 전체를 대표하는 값 하나로만 반환한다 — 호출부
  // (orchestrator.ts)가 이 DeveloperResult 하나당 정확히 한 번만 event에 반영한다.
  let accInputTokens: number | undefined;
  let accOutputTokens: number | undefined;
  let lastModel: { provider: string; name: string } | undefined;
  function accumulateUsage(raw: { model?: { provider: string; name: string }; tokenUsage?: { inputTokens?: number; outputTokens?: number } }): void {
    if (raw.model) lastModel = raw.model;
    if (raw.tokenUsage?.inputTokens !== undefined) accInputTokens = (accInputTokens ?? 0) + raw.tokenUsage.inputTokens;
    if (raw.tokenUsage?.outputTokens !== undefined) accOutputTokens = (accOutputTokens ?? 0) + raw.tokenUsage.outputTokens;
  }
  function usageFields(): Pick<DeveloperResult, "model" | "tokenUsage"> {
    return {
      ...(lastModel ? { model: lastModel } : {}),
      ...(accInputTokens !== undefined || accOutputTokens !== undefined
        ? { tokenUsage: { inputTokens: accInputTokens, outputTokens: accOutputTokens } }
        : {}),
    };
  }

  const capTranscript = () => {
    let joined = transcript.join("\n\n---\n\n");
    while (joined.length > MAX_TRANSCRIPT_CHARS && transcript.length > 1) {
      // 가장 오래된 라운드부터 버린다 — Task 본문(index 0)은 항상 유지한다.
      transcript.splice(1, 1);
      joined = transcript.join("\n\n---\n\n");
    }
    return joined;
  };

  function noProgressFailure(round: number, count: number): DeveloperResult {
    log(
      `developer 무진척 감지 — 구현 잠금 이후에도 진척 없는 시도(거부된 discovery/PLAN 반복)가 ${count}회 계속됨(라운드 ${round}/${MAX_INTERNAL_ROUNDS}) — 조기 종료`
    );
    return {
      success: false,
      summary: `구현 단계 전환(잠금) 이후에도 실제 코드 변경 없이 거부된 조사 시도나 반복 PLAN만 ${count}회 계속되어 무진척으로 판단해 조기 종료했습니다.`,
      changedFiles: getActualChangedFiles(changeScopeDirs, executor),
      tests: [],
      rawOutput: "",
      errorCode: "NO_PROGRESS_STAGNATION",
      deferredHumanTasks,
      ...usageFields(),
    };
  }

  // 잠금 전(!implementationLocked) 상태에서만 호출된다(PLAN 또는 READ_FILES/SEARCH-only
  // ACTION_REQUEST 라운드). 예산 소진 시 잠금으로 전환하고 nudge를 transcript에 남긴다 —
  // 이 함수는 실패를 반환하지 않는다(잠금 이후의 무진척 판정은 별도로 lockedNoProgressCount가
  // 담당).
  function advanceDiscoveryBudget(round: number): void {
    discoveryOnlyRoundCount += 1;
    if (discoveryOnlyRoundCount < DISCOVERY_BUDGET_ROUNDS) return;
    implementationLocked = true;
    log(
      `developer discovery 예산 소진 — 구현 단계 전환 안내 전송 및 READ_FILES/SEARCH 잠금(라운드 ${round}/${MAX_INTERNAL_ROUNDS}, discovery-only 누적 ${discoveryOnlyRoundCount}회)`
    );
    transcript.push(NUDGE_MESSAGE);
  }

  for (let round = 1; round <= MAX_INTERNAL_ROUNDS; round++) {
    const input = capTranscript();
    let claudeRaw = await claudeCall(input, timeoutMs);

    // USAGE_LIMIT은 일시정지다 — 같은 라운드/같은 input(transcript)으로 재시도한다. round
    // 카운터를 증가시키지 않고, transcript/discoveryOnlyRoundCount/lockedNoProgressCount/
    // implementationLocked/planUsedInLock/codeChangeHappened 중 아무것도 건드리지 않는다.
    let usageLimitRetries = 0;
    while (!claudeRaw.success && claudeRaw.errorCode === "USAGE_LIMIT") {
      if (usageLimitRetries >= usageLimitMaxRetries) {
        log(
          `developer USAGE_LIMIT 재시도 ${usageLimitMaxRetries}회 초과(라운드 ${round}는 소비되지 않음, transcript 보존) — 사람 확인 필요`
        );
        return {
          success: false,
          summary: claudeRaw.summary,
          changedFiles: getActualChangedFiles(changeScopeDirs, executor),
          tests: [],
          rawOutput: claudeRaw.rawOutput,
          errorCode: "USAGE_LIMIT",
          deferredHumanTasks,
          ...usageFields(),
        };
      }
      usageLimitRetries += 1;
      log(
        `developer Claude 사용량 제한 감지 — round/discovery budget/lock grace 소비 없이 ${usageLimitWaitMs}ms 대기 후 같은 라운드(${round}) 재시도 (${usageLimitRetries}/${usageLimitMaxRetries})`
      );
      await sleepFn(usageLimitWaitMs);
      claudeRaw = await claudeCall(input, timeoutMs); // 같은 input = 같은 transcript 상태 그대로 재요청
    }

    // claudeRaw가 실제로 성공한 경우에만 model/tokenUsage가 채워져 있다(§ claude-runner.ts) —
    // 실패 결과는 그대로 무시된다(추정하지 않는다).
    accumulateUsage(claudeRaw);

    if (!claudeRaw.success) {
      log(`developer 라운드 ${round} Claude 호출 실패(${claudeRaw.errorCode})`);
      return {
        success: false,
        summary: claudeRaw.summary,
        changedFiles: getActualChangedFiles(changeScopeDirs, executor),
        tests: [],
        rawOutput: claudeRaw.rawOutput,
        errorCode: claudeRaw.errorCode,
        deferredHumanTasks,
        ...usageFields(),
      };
    }

    const parsed = tryParseProtocolJson(claudeRaw.summary);
    if (!parsed) {
      log(`developer 라운드 ${round} 응답 JSON 파싱 실패`);
      transcript.push(
        `# Round ${round} 오류\n응답이 JSON이 아닙니다. 코드펜스나 설명 텍스트 없이 ACTION_REQUEST 또는 TASK_COMPLETE JSON 객체 하나만 출력하세요.`
      );
      continue;
    }

    if (parsed.type === "TASK_COMPLETE") {
      const summary = typeof parsed.summary === "string" ? parsed.summary : "(summary 없음)";
      // Claude의 자체 보고를 신뢰하지 않는다 — task-registry에 지정된 필수 테스트만
      // AutoDev(Safe Executor)가 직접 실행해 실제 exitCode로 결과를 만든다(§ 요구사항 6).
      const tests = await runRequiredTests(opts.requiredTests, executor);
      return {
        success: true,
        summary,
        changedFiles: getActualChangedFiles(changeScopeDirs, executor),
        tests,
        rawOutput: sanitizeForLog(claudeRaw.summary),
        deferredHumanTasks,
        ...usageFields(),
      };
    }

    // PLAN — 선택적 중간 산출물. 실제 코드 변경(codeChangeHappened)으로 치지는 않는다.
    if (parsed.type === "PLAN") {
      const planSummary = typeof parsed.summary === "string" ? parsed.summary : "(PLAN summary 없음)";
      log(`developer 라운드 ${round} PLAN 수신`);

      if (codeChangeHappened) {
        transcript.push(`# Round ${round} PLAN\n${planSummary}`);
        continue;
      }

      if (implementationLocked) {
        if (!planUsedInLock) {
          // 구현 전환용 PLAN 1회 한도 — 정상 처리하되 무진척 카운트에도 반영한다(PLAN만
          // 반복해도 grace를 무한정 소모할 수는 없다).
          planUsedInLock = true;
          transcript.push(`# Round ${round} PLAN\n${planSummary}`);
        } else {
          log(`developer 라운드 ${round} PLAN 반복 — 잠금 중 1회 한도 초과, protocol rejection`);
          transcript.push(`# Round ${round} PLAN 요청\n${planSummary}`);
          transcript.push(`# Round ${round} 오류\n${PLAN_LOCK_REPEAT_MESSAGE}`);
        }
        lockedNoProgressCount += 1;
        if (lockedNoProgressCount >= IMPLEMENTATION_LOCK_GRACE) return noProgressFailure(round, lockedNoProgressCount);
        continue;
      }

      // !implementationLocked (아직 DISCOVERY)
      transcript.push(`# Round ${round} PLAN\n${planSummary}`);
      advanceDiscoveryBudget(round);
      continue;
    }

    if (parsed.type === "ACTION_REQUEST" && Array.isArray(parsed.actions)) {
      const roundActions = parsed.actions as ExecutorAction[];
      // novel 여부는 보지 않는다 — READ_FILES/SEARCH만 있는 라운드는 이미 본 파일이든 새
      // 파일이든 동일하게 취급한다(§ 상단 주석, 실제 E2E 실패 사후 반영).
      const isDiscoveryOnlyRound = roundActions.every((a) => a.type === "READ_FILES" || a.type === "SEARCH");

      if (!codeChangeHappened && implementationLocked && isDiscoveryOnlyRound) {
        // 구현 잠금 상태 — Safe Executor를 아예 호출하지 않는다(실제 read/search를 실행하지
        // 않고 protocol-level rejection만 transcript에 남긴다).
        log(`developer 라운드 ${round} — 구현 잠금 중 READ_FILES/SEARCH-only 요청 실행 거부(protocol rejection)`);
        transcript.push(`# Round ${round} 요청\n${JSON.stringify(parsed)}`);
        transcript.push(`# Round ${round} 결과\n${DISCOVERY_REJECTION_MESSAGE}`);
        lockedNoProgressCount += 1;
        if (lockedNoProgressCount >= IMPLEMENTATION_LOCK_GRACE) return noProgressFailure(round, lockedNoProgressCount);
        continue;
      }

      const roundResults: unknown[] = [];
      for (const rawAction of roundActions) {
        const result = await doValidateAndExecute(rawAction);
        if (!result.ok) {
          const key = actionKey(rawAction);
          const count = (forbiddenRepeatCount.get(key) ?? 0) + 1;
          forbiddenRepeatCount.set(key, count);
          if (count >= FORBIDDEN_REPEAT_LIMIT) {
            deferredHumanTasks.push(`반복 거부(${count}회): ${key} — ${result.denyReason}`);
            roundResults.push({ ...result, deferred: true, note: "3회 이상 거부됨 — 사람 검토로 넘겨짐, 다른 접근 필요" });
            continue;
          }
        } else if (rawAction.type === "WRITE_FILE" || rawAction.type === "APPLY_PATCH") {
          codeChangeHappened = true;
        }
        roundResults.push(result);
      }
      transcript.push(`# Round ${round} 요청\n${JSON.stringify(parsed)}`);
      transcript.push(`# Round ${round} 결과\n${sanitizeForLog(JSON.stringify(roundResults))}`);

      if (!codeChangeHappened && !implementationLocked && isDiscoveryOnlyRound) {
        advanceDiscoveryBudget(round);
      }
      continue;
    }

    log(`developer 라운드 ${round} 알 수 없는 응답 형식`);
    transcript.push(`# Round ${round} 오류\n알 수 없는 응답 형식입니다. ACTION_REQUEST 또는 TASK_COMPLETE만 허용됩니다.`);
  }

  return {
    success: false,
    summary: `내부 라운드 ${MAX_INTERNAL_ROUNDS}회를 초과했습니다.`,
    changedFiles: getActualChangedFiles(changeScopeDirs, executor),
    tests: [],
    rawOutput: "",
    errorCode: "TASK_ACTION_LIMIT",
    deferredHumanTasks,
    ...usageFields(),
  };
}
