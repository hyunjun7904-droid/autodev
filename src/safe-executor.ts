import { resolve, sep, dirname, basename, relative } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { sanitizeForLog } from "./logger";
import { TARGET_PROJECT_ROOT } from "./project-context";
import { validateProjectExecutionPolicy } from "./project-policy";
import type { ProjectExecutionPolicy } from "./project-policy";

// Safe Executor — Claude에게 built-in Read/Edit/Write/Bash를 주지 않고, 이 모듈을 통해서만
// 검증된 파일/명령 작업을 수행하게 한다. 모든 하드 경계는 여기 코드로 강제되며, LLM 프롬프트
// 지시(시스템 프롬프트 등)로 대체하지 않는다.
//
// AutoDev 범용화 Phase B Task B1 — 이 파일은 이제 어떤 프로젝트의 read/write 허용 경로나
// 명령 allow-list인지 전혀 모른다("web/", "automation/", "supabase/" 같은 문자열이 이
// 파일에 없다). 그 실제 enforcement 데이터(ProjectExecutionPolicy)는 프로젝트별로 명시적으로
// 주입해야만 쓸 수 있다 — 주입되기 전까지 read/write/명령 검증은 항상 실패한다(어떤
// 프로젝트로도, 어떤 permissive한 값으로도 조용히 fallback하지 않는다). root 탈출/symlink
// 방어/UNC·다른 드라이브 차단(resolveSafe)과 DENY_PATH_PATTERNS/SECRET_NAME_PATTERNS(env/git/
// node_modules/secret 이름 패턴)는 Project Policy와 무관하게 항상 적용되는 Core hard rule이다
// — 어떤 프로젝트 정책도 이 두 가지를 약화시킬 수 없다.
//
// Phase C Task C2 — Per-Run Execution Context 격리. 이전에는 이 프로젝트별 상태(root/policy)가
// module-level mutable 전역(PROJECT_ROOT/PROJECT_ROOT_REAL/currentPolicy)이었고
// configureSafeExecutor()가 그 전역을 덮어썼다 — 한 프로세스 안에서 Project A 실행 도중
// Project B가 구성되면 A의 root/policy가 조용히 B로 바뀌는 구조적 위험이 있었다.
//
// 이제 실제 검증/실행 로직은 createSafeExecutorContext(root, policy)가 반환하는
// SafeExecutorContext 안에 있다 — 그 root/policy는 그 context를 만들 때 캡처된 closure
// 변수일 뿐, 어떤 전역도 거치지 않는다. Project A의 context와 Project B의 context는 서로의
// 존재를 전혀 모르고, 어느 쪽도 다른 쪽의 root/policy를 변경할 방법이 없다(같은 프로세스
// 안에서 동시에/번갈아 써도 안전).
//
// configureSafeExecutor()/module-level validateReadPath 등은 새 context를 만들어 "현재
// 활성 context"에 저장하는 하위 호환 wrapper로만 남는다 — 기존 테스트가 계속 동작하도록
// 유지하되, 실제 운용 경로(autodev.ts runAutodevOnce())는 이 wrapper를 전혀 쓰지 않고
// createSafeExecutorContext()가 반환한 context를 직접, 명시적으로 필요한 곳에만 전달한다.

const MAX_READ_CHARS_PER_FILE = 8_000;
const MAX_SEARCH_MATCHES = 200;
const MAX_COMMAND_OUTPUT_CHARS = 20_000;

// =========================================================
// action 타입
// =========================================================
export interface ReadFilesAction {
  type: "READ_FILES";
  paths: string[];
}
export interface SearchAction {
  type: "SEARCH";
  pattern: string;
  globs?: string[];
}
export interface WriteFileAction {
  type: "WRITE_FILE";
  path: string;
  content: string;
}
export interface ApplyPatchAction {
  type: "APPLY_PATCH";
  path: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}
export interface RunCommandAction {
  type: "RUN_COMMAND";
  command: string;
  args?: string[];
  /** "root"(targetProjectRoot 자체) 또는 현재 정책(ProjectExecutionPolicy.commandCwdAliases)이
   *  정의한 별칭. */
  cwd?: string;
}
export type ExecutorAction = ReadFilesAction | SearchAction | WriteFileAction | ApplyPatchAction | RunCommandAction;

export interface ExecutorResult {
  ok: boolean;
  action: string;
  denyReason?: string;
  data?: unknown;
}

// =========================================================
// 경로 정책 — Core hard rule(프로젝트가 약화할 수 없음)
// =========================================================
// 이 목록들은 checkpoint.ts/git-changes.ts(REVIEW/COMMIT 대상에서 secret·빌드산출물·로그를
// 제외하는 로직)에서도 그대로 재사용한다 — "무엇이 위험한 경로인가"의 단일 출처를 Safe
// Executor 하나로 유지하기 위해 export한다(중복 목록을 따로 만들지 않는다). 어떤 프로젝트
// 정책(ProjectExecutionPolicy)도 이 목록을 끄거나 좁힐 수 없다 — writeDenyPatterns로 추가만
// 할 수 있다. 이 패턴들은 어느 project context에도 속하지 않는 진짜 상수라 per-run 분리
// 대상이 아니다.
// .env 계열 파일 판정의 단일 출처 — secret-scanner.ts(Phase C Task C3, Deterministic Secret
// Scanner Gate)가 파일명 기반 env 탐지에 이 배열을 그대로 재사용한다(정규식을 복제하지
// 않는다). DENY_PATH_PATTERNS 안에서의 위치/동작은 이전과 동일하다.
export const ENV_FILE_PATTERNS: RegExp[] = [/(^|\/)\.env(\..+)?$/i, /\.local\.env$/i];

export const DENY_PATH_PATTERNS: RegExp[] = [
  ...ENV_FILE_PATTERNS,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.next(\/|$)/,
  /^automation\/logs(\/|$)/,
  /(^|\/)\.claude(\/|$)/,
  /(^|\/)dist(\/|$)/,
  /(^|\/)diagnostics(\/|$)/,
];
export const SECRET_NAME_PATTERNS: RegExp[] = [/secret/i, /token/i, /credential/i, /api[-_]?key/i, /\.pem$/i, /id_rsa/i];

// =========================================================
// Command Safety Gate — Phase C Task C4(Hooks / Permissions Enforcement) — Core hard rule.
// =========================================================
// Claude Developer는 built-in Bash가 없다(claude-developer.ts, 항상 --tools ""). RUN_COMMAND
// action은 오직 이 Safe Executor의 validateCommand()를 거쳐서만 실행된다 — 이 파일이 사실상
// Claude의 유일한 명령 실행 경로에 대한 PreToolUse Hook이다.
//
// 지금까지 validateCommand()는 policy.allowedCommands(정확한 command+args+cwd 조합
// allow-list)만으로 명령을 걸렀다. 문제는 그 allow-list 자체가 project policy 소유
// 데이터라는 점이다 — project config(JSON, project-adapter-loader.ts가 읽는 데이터 파일)가
// allowedCommands에 `git reset --hard`/`git push --force`/`git clean -fd` 같은 조합을 넣으면
// 지금까지는 그대로 실행됐다. DENY_PATH_PATTERNS/SECRET_NAME_PATTERNS가 path 접근에서 어떤
// project policy도 약화할 수 없는 Core hard rule인 것과 마찬가지로, 명령 실행에도 동일한
// 성격의 Core hard rule이 필요하다 — 아래 게이트는 policy.allowedCommands 확인보다 먼저,
// 그리고 그것과 무관하게 항상 적용된다. 이 게이트 함수들은 ProjectExecutionPolicy를 인자로
// 받지 않는다(시그니처 자체에 약화/우회 옵션이 없다).
//
// git 서브커맨드 판정은 deny-list가 아니라 allow-list다(이 파일 전체의 설계 원칙과 동일) —
// git은 서브커맨드가 매우 많고 위험한 조합을 전부 나열하는 deny-list는 구조적으로 빠짐이
// 생기기 쉽다. 대신 "read-only로 알려진 서브커맨드(+세부 인자)"만 명시적으로 허용하고, 그
// 목록에 없는 모든 git 서브커맨드(reset/clean/rebase/push/checkout/restore/commit/add/rm/
// mv/merge/cherry-pick/revert/stash push·pop·drop·clear/branch -d·-D 등)는 전부 거부한다 —
// "이 목록에 없으므로 read-only임을 증명하지 못했다"는 곧 차단이다(fail-open 금지).
//
// `git stash`는 특히 주의가 필요하다 — `git stash list`/`git stash show`는 읽기 전용이지만
// 인자 없는 `git stash`(push와 동일)나 `git stash push`/`pop`/`drop`/`clear`/`apply`는 working
// tree/stash 목록을 바꾼다. 서브커맨드 문자열만 보고 "stash가 포함되면 차단"처럼 단순
// 매칭하면 `git stash list`까지 잘못 차단된다 — branch/tag/remote/reflog처럼 읽기/쓰기 형태가
// 섞인 서브커맨드도 마찬가지라 첫 세부 인자까지 확인한다.
function isGitExecutable(command: string): boolean {
  return /^git(\.exe)?$/i.test(command.trim());
}

const GIT_READ_ONLY_NO_SUBARG_CHECK: ReadonlySet<string> = new Set([
  "status", "diff", "log", "show", "blame", "rev-parse", "describe",
  "ls-files", "ls-tree", "cat-file", "shortlog", "help", "version",
]);

// 서브커맨드별로 "이 세부 첫 인자까지는 read-only"로 허용하는 목록. 정의되지 않은 서브커맨드는
// (위 GIT_READ_ONLY_NO_SUBARG_CHECK에도 없다면) 전부 거부된다.
const GIT_READ_ONLY_FIRST_ARG: Readonly<Record<string, ReadonlySet<string>>> = {
  stash: new Set(["list", "show"]),
  branch: new Set(["-v", "-vv", "-a", "-r", "--list", "-l"]),
  tag: new Set(["-l", "--list"]),
  remote: new Set(["-v", "show", "get-url"]),
  reflog: new Set(["show"]),
};

/**
 * git 명령이 read-only(정보 조회만 하고 repo/working tree 상태를 바꾸지 않음)인지 판정한다.
 * false는 "이 allow-list로 read-only임을 증명하지 못했다"는 뜻이며, mutating으로 간주해
 * 차단한다.
 */
function isReadOnlyGitInvocation(args: string[]): boolean {
  if (args.length === 0) return false; // 인자 없는 "git" 자체는 허용하지 않는다(불필요).
  const [sub, ...rest] = args;
  if (sub.startsWith("-")) return false; // 전역 옵션이 서브커맨드 앞에 오는 형태는 허용하지 않는다.
  if (GIT_READ_ONLY_NO_SUBARG_CHECK.has(sub)) return true;
  const allowedFirstArgs = GIT_READ_ONLY_FIRST_ARG[sub];
  if (!allowedFirstArgs) return false;
  if (rest.length === 0) return false; // 예: 인자 없는 "git stash"는 push와 동일(mutating).
  return allowedFirstArgs.has(rest[0]);
}

/**
 * RUN_COMMAND의 Core Command Safety Gate — validateCommand()가 policy.allowedCommands를
 * 확인하기 전에 항상 먼저 통과해야 한다.
 *   1) 대상이 git이면 read-only 서브커맨드가 아닌 한 무조건 거부(위 설명).
 *   2) 명령 인자 중 하나라도 ENV_FILE_PATTERNS/SECRET_NAME_PATTERNS(이 파일의 단일 출처,
 *      secret-scanner.ts와 동일한 상수를 재사용 — 목록을 복제하지 않는다)에 매칭되면 거부한다
 *      — "cat web/.env", "powershell Get-Content web/.env.local" 같은 경로 기반 secret/env
 *      접근을 명령 인자 레벨에서 막는다. 이 목적은 secret-scanner.ts(Phase C Task C3, commit
 *      대상 파일 "내용"을 검사)와 겹치지 않는다 — 여기는 "명령 실행 인자"가 secret/env
 *      파일을 가리키는지만 본다(책임 분리).
 * 어떤 ProjectExecutionPolicy도 이 함수의 동작을 바꿀 방법이 없다(인자로 policy를 받지
 * 않음).
 */
export function coreCommandSafetyGate(command: string, args: string[]): { ok: boolean; reason?: string } {
  if (isGitExecutable(command) && !isReadOnlyGitInvocation(args)) {
    return {
      ok: false,
      reason:
        "Core Command Safety Gate: read-only로 확인되지 않은 git 서브커맨드는 어떤 프로젝트 정책으로도 " +
        "허용되지 않습니다(reset/clean/rebase/push/checkout/restore/commit/stash push·pop·drop 등).",
    };
  }
  for (const raw of args) {
    const a = raw.split("\\").join("/");
    if (ENV_FILE_PATTERNS.some((p) => p.test(a))) {
      return { ok: false, reason: "Core Command Safety Gate: 명령 인자가 .env 계열 파일을 참조합니다." };
    }
    if (SECRET_NAME_PATTERNS.some((p) => p.test(a))) {
      return { ok: false, reason: "Core Command Safety Gate: 명령 인자가 secret/key/token 이름 패턴을 참조합니다." };
    }
  }
  return { ok: true };
}

export interface ResolveOk {
  ok: true;
  abs: string;
  rel: string;
}
export interface ResolveFail {
  ok: false;
  reason: string;
}

/**
 * 하나의 Project Run(하나의 root + 하나의 policy)이 소유하는 실행 경계. root/policy는
 * 이 객체를 만들 때 캡처된 값이며, 이후 어떤 외부 호출로도 바뀌지 않는다(다른
 * SafeExecutorContext를 만들거나 쓰는 것이 이 context에 아무 영향을 주지 않는다) — 그래서
 * 같은 프로세스 안에서 여러 프로젝트의 context를 동시에/번갈아 들고 있어도 서로 격리된다.
 */
export interface SafeExecutorContext {
  readonly projectRoot: string;
  readonly projectRootReal: string;
  readonly policy: ProjectExecutionPolicy;
  validateReadPath(candidate: string): ResolveOk | ResolveFail;
  validateWritePath(candidate: string): ResolveOk | ResolveFail;
  validateCommand(command: string, args: string[], cwd: string): { ok: boolean; reason?: string };
  validateAndExecute(action: ExecutorAction): Promise<ExecutorResult>;
}

// 실제 검증/실행 로직 전부가 이 함수 안에 있다 — projectRoot/projectRootReal/policy는
// 인자로 받은 값을 closure로 캡처할 뿐, 어떤 module-level 변수도 읽거나 쓰지 않는다.
function buildContext(projectRoot: string, projectRootReal: string, policy: ProjectExecutionPolicy): SafeExecutorContext {
  function toRelPosix(absPath: string): string {
    return relative(projectRoot, absPath).split(sep).join("/");
  }

  // path.resolve() 후 project root 하위인지 검사, symlink는 realpath 기준으로 재검증한다.
  function resolveSafe(candidate: string): ResolveOk | ResolveFail {
    if (typeof candidate !== "string" || candidate.length === 0) return { ok: false, reason: "빈 경로" };
    if (/^\\\\/.test(candidate) || /^\/\/[^/]/.test(candidate)) return { ok: false, reason: "UNC 경로 금지" };
    if (/^[a-zA-Z]:[\\/]/.test(candidate) && !candidate.toLowerCase().startsWith(projectRoot.toLowerCase())) {
      return { ok: false, reason: "다른 드라이브 절대경로 금지" };
    }

    const abs = resolve(projectRoot, candidate);
    const absLower = abs.toLowerCase();
    const rootLower = projectRoot.toLowerCase();
    if (absLower !== rootLower && !absLower.startsWith(rootLower + sep)) {
      return { ok: false, reason: "project root 밖 경로" };
    }

    // symlink 방어: 존재하는 가장 가까운 조상 디렉터리의 realpath로 재검증한다.
    let probe = abs;
    while (!existsSync(probe)) {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    try {
      const real = realpathSync(probe).toLowerCase();
      const rootRealLower = projectRootReal.toLowerCase();
      if (real !== rootRealLower && !real.startsWith(rootRealLower + sep)) {
        return { ok: false, reason: "symlink로 project root 탈출" };
      }
    } catch {
      return { ok: false, reason: "경로 확인 실패" };
    }

    return { ok: true, abs, rel: toRelPosix(abs) };
  }

  function validateReadPath(candidate: string): ResolveOk | ResolveFail {
    const r = resolveSafe(candidate);
    if (!r.ok) return r;
    const { rel } = r;
    if (!policy.allowedReadPrefixes.some((p) => rel === p.slice(0, -1) || rel.startsWith(p))) {
      return { ok: false, reason: `허용된 read 범위(${policy.allowedReadPrefixes.join(", ")}) 밖` };
    }
    if (DENY_PATH_PATTERNS.some((p) => p.test(rel))) return { ok: false, reason: "DENY 패턴 매칭(env/git/node_modules 등)" };
    if (SECRET_NAME_PATTERNS.some((p) => p.test(basename(rel)))) return { ok: false, reason: "secret/key/token 이름 패턴 매칭" };
    return r;
  }

  function validateWritePath(candidate: string): ResolveOk | ResolveFail {
    const r = resolveSafe(candidate);
    if (!r.ok) return r;
    const { rel } = r;
    if (!policy.allowedWritePrefixes.some((p) => rel.startsWith(p))) {
      return { ok: false, reason: `허용된 write 범위(${policy.allowedWritePrefixes.join(", ")}) 밖` };
    }
    if (
      DENY_PATH_PATTERNS.some((p) => p.test(rel)) ||
      (policy.writeDenyPatterns ?? []).some((p) => p.test(rel))
    ) {
      return { ok: false, reason: "DENY 패턴 매칭(env/git/node_modules/프로젝트 write-deny 등)" };
    }
    if (SECRET_NAME_PATTERNS.some((p) => p.test(basename(rel)))) return { ok: false, reason: "secret/key/token 이름 패턴 매칭" };
    return r;
  }

  // 명령 allow-list — 정확한 command+args+cwd 조합만 허용(패턴 아님). 실제 목록은 policy가
  // 소유한다 — 이 함수는 어떤 명령이 허용되는지 전혀 모른다.
  function cwdToPath(cwd: string): { ok: true; path: string } | { ok: false; reason: string } {
    if (cwd === "root") return { ok: true, path: projectRoot };
    const alias = policy.commandCwdAliases?.[cwd];
    if (alias === undefined) return { ok: false, reason: `정의되지 않은 cwd 별칭: ${cwd}` };
    return { ok: true, path: resolve(projectRoot, alias) };
  }

  function validateCommand(command: string, args: string[], cwd: string): { ok: boolean; reason?: string } {
    const gate = coreCommandSafetyGate(command, args);
    if (!gate.ok) return gate;
    const match = policy.allowedCommands.find(
      (c) =>
        c.cwd === cwd &&
        c.command === command &&
        c.args.length === args.length &&
        c.args.every((a, i) => a === args[i])
    );
    if (!match) return { ok: false, reason: "allow-list에 없는 명령(정확한 command+args+cwd 조합만 허용)" };
    return { ok: true };
  }

  // =========================================================
  // action 실행
  // =========================================================
  function executeReadFiles(paths: string[]): ExecutorResult {
    if (!Array.isArray(paths) || paths.length === 0) {
      return { ok: false, action: "READ_FILES", denyReason: "paths가 비어있음" };
    }
    for (const p of paths) {
      const v = validateReadPath(p);
      if (!v.ok) return { ok: false, action: "READ_FILES", denyReason: `${p}: ${v.reason}` };
    }
    const out: Record<string, string> = {};
    for (const p of paths) {
      const v = validateReadPath(p) as ResolveOk;
      try {
        const content = readFileSync(v.abs, "utf-8");
        out[v.rel] =
          content.length > MAX_READ_CHARS_PER_FILE
            ? content.slice(0, MAX_READ_CHARS_PER_FILE) + `\n...[truncated, ${content.length - MAX_READ_CHARS_PER_FILE}자 생략]`
            : content;
      } catch {
        return { ok: false, action: "READ_FILES", denyReason: `${p}: 읽기 실패(존재하지 않을 수 있음)` };
      }
    }
    return { ok: true, action: "READ_FILES", data: out };
  }

  function executeSearch(pattern: string, globs?: string[]): ExecutorResult {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, "i");
    } catch {
      return { ok: false, action: "SEARCH", denyReason: "잘못된 정규식" };
    }
    const defaultRoots = policy.allowedReadPrefixes.map((p) => p.replace(/\/$/, ""));
    const roots = (globs && globs.length ? globs : defaultRoots).map((g) => g.replace(/\/\*\*$/, ""));
    const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "logs", ".claude"]);
    const matches: { file: string; line: number; text: string }[] = [];

    function walk(dirAbs: string): void {
      if (matches.length >= MAX_SEARCH_MATCHES) return;
      let entries;
      try {
        entries = readdirSync(dirAbs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (matches.length >= MAX_SEARCH_MATCHES) return;
        if (SKIP_DIRS.has(entry.name)) continue;
        const abs = resolve(dirAbs, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
          continue;
        }
        const rel = toRelPosix(abs);
        if (!validateReadPath(rel).ok) continue;
        let text: string;
        try {
          text = readFileSync(abs, "utf-8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= MAX_SEARCH_MATCHES) break;
          if (regex.test(lines[i])) matches.push({ file: rel, line: i + 1, text: lines[i].slice(0, 300) });
        }
      }
    }

    for (const root of roots) {
      const abs = resolve(projectRoot, root);
      if (existsSync(abs)) walk(abs);
    }
    return { ok: true, action: "SEARCH", data: { matches } };
  }

  function executeWriteFile(pathCandidate: string, content: string): ExecutorResult {
    const v = validateWritePath(pathCandidate);
    if (!v.ok) return { ok: false, action: "WRITE_FILE", denyReason: v.reason };
    try {
      mkdirSync(dirname(v.abs), { recursive: true });
      writeFileSync(v.abs, content, "utf-8");
      return { ok: true, action: "WRITE_FILE", data: { path: v.rel } };
    } catch {
      return { ok: false, action: "WRITE_FILE", denyReason: "쓰기 실패" };
    }
  }

  function executeApplyPatch(
    pathCandidate: string,
    oldString: string,
    newString: string,
    replaceAll = false
  ): ExecutorResult {
    // 1) 대상 path 검증
    const v = validateWritePath(pathCandidate);
    if (!v.ok) return { ok: false, action: "APPLY_PATCH", denyReason: v.reason };

    let content: string;
    try {
      content = readFileSync(v.abs, "utf-8");
    } catch {
      return { ok: false, action: "APPLY_PATCH", denyReason: "대상 파일 읽기 실패(존재하지 않을 수 있음)" };
    }
    const beforeHash = createHash("sha256").update(content).digest("hex").slice(0, 16);

    const occurrences = content.split(oldString).length - 1;
    if (occurrences === 0) return { ok: false, action: "APPLY_PATCH", denyReason: "oldString이 파일에 없음" };
    if (occurrences > 1 && !replaceAll) {
      return { ok: false, action: "APPLY_PATCH", denyReason: `oldString이 ${occurrences}번 매칭됨(replaceAll:true 필요)` };
    }

    // 2) 재검증(경로가 그 사이 바뀌지 않았는지) — 동기 단일 스레드 실행이라 항상 동일하지만 명시적으로 한 번 더 확인
    const v2 = validateWritePath(pathCandidate);
    if (!v2.ok) return { ok: false, action: "APPLY_PATCH", denyReason: v2.reason };

    const updated = replaceAll ? content.split(oldString).join(newString) : content.replace(oldString, newString);
    try {
      writeFileSync(v.abs, updated, "utf-8");
    } catch {
      return { ok: false, action: "APPLY_PATCH", denyReason: "쓰기 실패" };
    }
    return { ok: true, action: "APPLY_PATCH", data: { path: v.rel, beforeHash, occurrences: replaceAll ? occurrences : 1 } };
  }

  function executeRunCommand(command: string, args: string[], cwd: string): ExecutorResult {
    const v = validateCommand(command, args, cwd);
    if (!v.ok) return { ok: false, action: "RUN_COMMAND", denyReason: v.reason };
    const cwdResolved = cwdToPath(cwd);
    if (!cwdResolved.ok) return { ok: false, action: "RUN_COMMAND", denyReason: cwdResolved.reason };
    const res = spawnSync(command, args, {
      cwd: cwdResolved.path,
      shell: false,
      encoding: "utf-8",
      timeout: 300_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    return {
      ok: res.status === 0,
      action: "RUN_COMMAND",
      data: {
        exitCode: res.status,
        stdout: sanitizeForLog((res.stdout || "").slice(0, MAX_COMMAND_OUTPUT_CHARS)),
        stderr: sanitizeForLog((res.stderr || "").slice(0, MAX_COMMAND_OUTPUT_CHARS)),
      },
    };
  }

  async function validateAndExecute(action: ExecutorAction): Promise<ExecutorResult> {
    switch (action.type) {
      case "READ_FILES":
        return executeReadFiles(action.paths);
      case "SEARCH":
        return executeSearch(action.pattern, action.globs);
      case "WRITE_FILE":
        return executeWriteFile(action.path, action.content);
      case "APPLY_PATCH":
        return executeApplyPatch(action.path, action.oldString, action.newString, action.replaceAll);
      case "RUN_COMMAND":
        return executeRunCommand(action.command, action.args ?? [], action.cwd ?? "root");
      default: {
        const unknown = action as { type?: string };
        return { ok: false, action: unknown.type ?? "UNKNOWN", denyReason: "알 수 없는 action type" };
      }
    }
  }

  return { projectRoot, projectRootReal, policy, validateReadPath, validateWritePath, validateCommand, validateAndExecute };
}

/**
 * 하나의 Project Run 전용 SafeExecutorContext를 새로 만든다. 어떤 module-level 상태도
 * 읽거나 쓰지 않는다 — 반환된 context는 완전히 독립적이며, 이후 다른 createSafeExecutorContext()
 * 호출이나 configureSafeExecutor() 호출이 이 context의 동작에 아무 영향을 주지 않는다.
 * 실제 운용(autodev.ts runAutodevOnce())은 이 함수만 쓰고, 그 결과를 필요한 곳(Claude
 * Developer/GPT Reviewer)에 명시적으로 전달한다 — module-level singleton을 거치지 않는다.
 */
export function createSafeExecutorContext(root: string, policy: ProjectExecutionPolicy): SafeExecutorContext {
  const resolvedRoot = resolve(root);
  if (!existsSync(resolvedRoot)) {
    throw new Error(`createSafeExecutorContext: root가 존재하지 않는 경로입니다: ${resolvedRoot}`);
  }
  validateProjectExecutionPolicy(policy);
  const resolvedRootReal = realpathSync(resolvedRoot);
  return buildContext(resolvedRoot, resolvedRootReal, policy);
}

// =========================================================
// 하위 호환 singleton wrapper — configureSafeExecutor()로 명시적으로 주입되기 전까지는
// 기존과 동일하게 항상 실패한다(silent 기본/permissive 정책 없음). 새로 만드는 코드는
// createSafeExecutorContext()가 반환한 context를 직접 쓰고, 이 wrapper는 기존 테스트
// 호환을 위해서만 남는다 — 실제 운용 경로(runAutodevOnce)는 더 이상 이 wrapper를 거치지
// 않는다.
// =========================================================
let PROJECT_ROOT = TARGET_PROJECT_ROOT;
let PROJECT_ROOT_REAL = existsSync(PROJECT_ROOT) ? realpathSync(PROJECT_ROOT) : PROJECT_ROOT;
let activeContext: SafeExecutorContext | null = null;

/**
 * 이 프로세스의 "현재 활성 context"를 설정하는 하위 호환 wrapper — 내부적으로
 * createSafeExecutorContext()로 새 독립 context를 만들어 activeContext에 저장할 뿐이다.
 * 여러 project를 동시에 다뤄야 하는 코드는 이 함수 대신 createSafeExecutorContext()를 직접
 * 써서 각자의 context를 명시적으로 들고 있어야 한다(이 wrapper로 만든 activeContext는
 * 그 다음 configureSafeExecutor() 호출로 다시 바뀔 수 있는 전역이기 때문).
 */
export function configureSafeExecutor(root: string, policy: ProjectExecutionPolicy): void {
  const ctx = createSafeExecutorContext(root, policy);
  activeContext = ctx;
  PROJECT_ROOT = ctx.projectRoot;
  PROJECT_ROOT_REAL = ctx.projectRootReal;
}

function requireActiveContext(): SafeExecutorContext {
  if (!activeContext) {
    throw new Error(
      "Safe Executor 정책이 설정되지 않았습니다 — configureSafeExecutor(root, policy)를 먼저 호출하세요" +
        "(silent 기본/permissive 정책 없음)."
    );
  }
  return activeContext;
}

export function validateReadPath(candidate: string): ResolveOk | ResolveFail {
  return requireActiveContext().validateReadPath(candidate);
}

export function validateWritePath(candidate: string): ResolveOk | ResolveFail {
  return requireActiveContext().validateWritePath(candidate);
}

export function validateCommand(command: string, args: string[], cwd: string): { ok: boolean; reason?: string } {
  return requireActiveContext().validateCommand(command, args, cwd);
}

export function validateAndExecute(action: ExecutorAction): Promise<ExecutorResult> {
  return requireActiveContext().validateAndExecute(action);
}

export { PROJECT_ROOT, PROJECT_ROOT_REAL };
