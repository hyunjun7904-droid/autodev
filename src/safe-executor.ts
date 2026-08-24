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
// SI-3.3~3.5 4-chunk 최종 리뷰 2라운드 지적(HIGH) — "help"는 read-only(정보 조회)로
// 보이지만 help.format=web/man.viewer/man.<viewer>.cmd 같은 config에 따라 외부
// 브라우저/man viewer 프로그램을 실행할 수 있다(git 공식 문서) — 이는 diff.external과
// 동일한 클래스의 config-driven 외부 실행 벡터이지만, "help"는 diff 옵션 체계를 공유하지
// 않아 --no-ext-diff/--no-textconv 같은 단일 플래그로 무력화할 방법이 없다(help가 어떤
// viewer를 쓸지는 config 자체가 결정하며, 이를 서브커맨드마다 안전하게 무력화하려면 help
// 전용 로직이 또 필요해진다 — 요구사항 6/7: 새 parser/무한定 방어 로직을 계속 추가하지
// 않는다). AutoDev의 실제 필요(.claude/CLAUDE.md 검증 절차, 이 저장소의 모든 git 사용
// fixture) 어디에도 "git help"가 없으므로, 이 서브커맨드를 read-only allow-list에서
// 아예 제외해 이 위험 표면 자체를 구조적으로 없앤다("있지도 않은 필요를 위해 위험한
// 표면을 열어두지 않는다").
const GIT_READ_ONLY_NO_SUBARG_CHECK: ReadonlySet<string> = new Set([
  "status", "diff", "log", "show", "blame", "rev-parse", "describe",
  "ls-files", "ls-tree", "cat-file", "shortlog", "version",
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

// Phase C Task C4.1 — Read-only Git Command Hardening.
//
// C4는 "서브커맨드 이름"만으로 read-only를 판정했다. 그런데 git 공식 문서 기준으로, 그
// 서브커맨드들도 특정 옵션이 붙으면 파일 쓰기/외부 프로그램 실행/네트워크 접근을 일으킬 수
// 있다 — subcommand 이름만으로 무조건 안전하다고 판단해서는 안 된다:
//   --output[=<file>]  diff-options(git-diff/log/show가 공유) — stdout이 아니라 임의 경로에
//                       직접 파일을 쓴다. RUN_COMMAND는 그 write를 validateWritePath로
//                       검증하지 않으므로(파일 write action이 아니라 명령 인자이기 때문) 이
//                       옵션 하나로 write 허용 범위/DENY_PATH_PATTERNS를 완전히 우회한다.
//   --ext-diff          diff.external/GIT_EXTERNAL_DIFF로 설정된 외부 프로그램을 강제 실행.
//   --textconv          gitattributes의 diff.<driver>.textconv(외부 프로그램)를 강제 실행
//                        (git-show(1)/git-cat-file(1)).
//   --filters            git cat-file --filters — 해당 경로에 설정된 clean/smudge 등 필터
//                        체인(외부 프로그램일 수 있음)을 실행한다(git-cat-file(1)).
//   --paginate           stdout이 파이프(비-tty)라도 core.pager/$PAGER 실행을 강제한다
//                        (git(1) "-p, --paginate"). 참고: 서브커맨드 뒤의 단독 "-p"는
//                        log/diff/show에서 "--patch"(diff 내용 표시)와 동음이의이므로 여기서는
//                        차단하지 않는다 — pager를 강제하는 전역 옵션 "-p"/"--paginate"는
//                        서브커맨드보다 앞에만 올 수 있는데, 이 게이트는 args[0]가 반드시
//                        서브커맨드 이름이어야만 read-only 판정 대상이 되므로 그 형태 자체가
//                        이미 구조적으로 차단된다(전역 -c를 통한 config injection도 동일한
//                        이유로 이미 차단됨).
//   --contents=<file>    git blame --contents=<file> — working tree 대신 임의의 로컬
//                        파일시스템 경로를 읽어 그 내용을 blame 출력에 그대로 포함한다
//                        (git-blame(1)) — Safe Executor의 read 허용 범위/DENY_PATH_PATTERNS를
//                        완전히 우회하는 임의 파일 읽기다.
// 어떤 read-only 서브커맨드도 이 옵션들을 실제로 필요로 하지 않으므로(AutoDev는 항상
// spawnSync로 stdout을 직접 캡처한다) blocklist를 서브커맨드별로 나누지 않고 모든 read-only
// git 호출에 공통으로 적용한다 — 전체 git 옵션 parser를 새로 만들지 않고, 문서로 확인된
// 위험 옵션만 최소한으로 막는다.
//
// Phase C Task C4.2 — Git option split-form hardening.
//
// git의 long option은(값을 받는 옵션이라면) "--option=value"와 "--option value"(값이 다음
// argv에 오는 분리형) 둘 다 지원하는 것이 일반적이다(parse-options). 위 옵션 중 값을 받는
// 것은 --output(<file>)과 --contents(<file>) 둘뿐이다(--ext-diff/--textconv/--filters/
// --paginate는 값을 받지 않는 순수 스위치라 분리형 자체가 존재하지 않는다). --output은
// 이미 `(=.*)?`로 "--output"(값이 다음 argv에 오는 분리형의 플래그 자체) / "--output=value"
// 둘 다 매칭했었다 — 이 패턴은 옵션 뒤에 오는 값이 정확히 무엇이든(어떤 경로든) 상관없이
// 플래그 자체의 존재만으로 차단하므로, 값이 같은 토큰에 있든(등호형) 다음 argv 토큰에
// 있든(분리형) 항상 차단된다. 반면 --contents=<file>은 등호형만 매칭했다 — 분리형
// "--contents <file>"은 그 자리의 인자가 정확히 "--contents"(등호도 값도 없음)이므로
// `/^--contents=/`(등호 필수)에 매칭되지 않아 그대로 통과했다(실제 우회 가능했던 gap). 값이
// 붙는 옵션의 안전한 패턴은 항상 --output처럼 "값 부분을 선택(optional)"으로 둬서 등호형·
// 분리형·값 없는 나열형(git이 값 누락으로 에러를 낼 뿐인 경우 포함) 모두를 플래그 자체
// 하나로 포괄해야 한다 — "다음 argv가 무엇인지"를 따로 들여다볼 필요가 없다(그 값 내용은
// 차단 여부와 무관하다). 참고: git의 long option은 모호하지 않은 접두사 축약(예: 문맥에 따라
// "--cont"가 "--contents"로 해석되는 경우)도 허용할 수 있는데, 이는 서브커맨드마다 실제
// 정의된 전체 옵션 집합을 알아야만 판정 가능한 문제라 여기서 다루지 않는다(요구사항: 전체
// git 옵션 parser를 새로 만들지 않는다) — 이 게이트가 다루는 것은 "정식 옵션명의 등호형/
// 분리형 두 표현"까지다.
// SI-3.3~3.5 4-chunk 최종 리뷰 3라운드 지적(HIGH) — "help"를 read-only 허용 서브커맨드
// 목록에서 제거해도, 이미 허용된 다른 모든 서브커맨드(status/diff/log/show 등)에
// "--help"를 인자로 붙이면 동일한 git help viewer 경로(help.format/man.viewer/
// man.<viewer>.cmd로 설정 가능한 외부 프로그램)로 진입한다 — "help" 서브커맨드 제거만으로는
// 이 표면을 닫지 못했다. 이 패턴은 GIT_READ_ONLY_NO_SUBARG_CHECK/GIT_READ_ONLY_FIRST_ARG에
// 있는 모든 서브커맨드에 공통 적용되므로(rest 전체를 검사) "help" 서브커맨드 자체를
// 제거한 것과 별개로, "--help" 인자 자체를 여기(모든 read-only 호출 공통 위험 옵션
// 목록)에 추가해 어떤 서브커맨드에 붙어도 차단한다.
const GIT_DANGEROUS_OPTION_PATTERNS: RegExp[] = [
  /^--output(=.*)?$/,
  /^--ext-diff$/,
  /^--textconv$/,
  /^--filters$/,
  /^--paginate$/,
  /^--contents(=.*)?$/,
  /^--help$/,
];

/**
 * git 명령이 read-only(정보 조회만 하고 repo/working tree 상태를 바꾸지 않음)인지 판정한다.
 * false는 "이 allow-list로 read-only임을 증명하지 못했다"는 뜻이며, mutating으로 간주해
 * 차단한다.
 */
function isReadOnlyGitInvocation(args: string[]): boolean {
  if (args.length === 0) return false; // 인자 없는 "git" 자체는 허용하지 않는다(불필요).
  const [sub, ...rest] = args;
  if (sub.startsWith("-")) return false; // 전역 옵션이 서브커맨드 앞에 오는 형태는 허용하지 않는다.

  let subcommandReadOnly: boolean;
  if (GIT_READ_ONLY_NO_SUBARG_CHECK.has(sub)) {
    subcommandReadOnly = true;
  } else {
    const allowedFirstArgs = GIT_READ_ONLY_FIRST_ARG[sub];
    if (!allowedFirstArgs) return false;
    // 예: 인자 없는 "git stash"는 push와 동일(mutating).
    subcommandReadOnly = rest.length > 0 && allowedFirstArgs.has(rest[0]);
  }
  if (!subcommandReadOnly) return false;

  // 서브커맨드 자체는 read-only로 확인됐어도, 옵션이 파일쓰기/외부실행을 유발할 수 있다
  // (§ 위 GIT_DANGEROUS_OPTION_PATTERNS 설명) — 하나라도 매칭되면 차단한다.
  if (rest.some((a) => GIT_DANGEROUS_OPTION_PATTERNS.some((p) => p.test(a)))) return false;

  // "git remote show <name>"은 -n(--no-query) 없이는 로컬 정보만 보는 다른 read-only
  // 서브커맨드와 달리 실제로 원격 서버에 네트워크 질의를 보낸다(git-remote(1) "show" 설명) —
  // -n이 명시적으로 있을 때만 read-only로 인정한다.
  if (sub === "remote" && rest[0] === "show" && !rest.includes("-n")) return false;

  return true;
}

// SI-3.3~3.5 4-chunk 최종 리뷰 지적(HIGH) — read-only로 확인된 git 서브커맨드(diff/log/
// show 등)도 "명령줄 플래그 없이" repo 자신의 config/.gitattributes만으로 외부 프로그램을
// 실행시킬 수 있다: core.pager(대화형 pager), diff.external/diff.<driver>.command(경로별
// diff 드라이버, .gitattributes의 "diff=<driver>" 속성으로 CLI 플래그 없이도 자동
// 트리거됨), core.fsmonitor(status/기타 명령이 자동 조회하는 외부 훅). GIT_DANGEROUS_
// OPTION_PATTERNS는 "명령줄에 그 플래그가 있는가"만 보므로, 이런 config-driven(플래그
// 없이 저장소 자체 설정만으로 트리거되는) 실행 벡터는 놓친다.
//
// project-bootstrap.ts의 runHardenedGit()이 이미 정확히 같은 클래스의 문제(core.hooksPath/
// core.fsmonitor/commit.gpgSign을 이용한 config 기반 임의 프로그램 실행, SI-2 REVISE
// 6~8회차에서 GPT Independent Reviewer가 지적)를 "매 호출마다 안전한 값으로 강제 override"
// 방식으로 막고 있다 — 이 파일의 git 실행에도 그 검증된 패턴을 재사용한다(새 방어 로직을
// 발명하지 않는다). validateCommand()가 이미 통과시킨 read-only 서브커맨드에 대해서만,
// 실제 spawnSync 호출 직전에 이 override를 추가한다(검증에 쓰인 args 자체는 건드리지
// 않는다 — 이 override는 validateCommand의 뒤에서만 적용된다).
const GIT_NEUTRALIZING_C_OVERRIDES: readonly string[] = [
  "-c",
  "core.pager=cat", // 대화형 pager(및 그 안에서 셸 이스케이프 가능성) 무력화.
  "-c",
  "core.fsmonitor=false", // status 등이 자동 실행하는 fsmonitor 훅 무력화.
  "-c",
  "diff.external=", // diff.external로 지정된 외부 diff 프로그램 무력화.
  "-c",
  "interactive.diffFilter=", // add -p 등에서 쓰이는 외부 필터 무력화.
];
// git-diff/log/show가 공유하는 diff 옵션 — "diff=<driver>" gitattributes 속성으로 지정된
// 경로별 외부 diff 드라이버(diff.<driver>.command)를 명령줄 플래그 없이도 자동 실행하는
// 것을 막는다(git 공식 문서 "--no-ext-diff": "Disallow external diff drivers."). 이
// 옵션은 diff 관련 서브커맨드만 인식한다 — status/ls-files/rev-parse 등 무관한
// 서브커맨드에 붙이면 "unknown option"으로 그 명령 자체가 실패하므로, 실제로 diff
// 옵션을 공유하는 서브커맨드에만 골라 붙인다(GIT_EXT_DIFF_CAPABLE_SUBCOMMANDS).
//
// SI-3.3~3.5 4-chunk 최종 리뷰 2라운드 지적(HIGH) — external diff driver(diff.external/
// diff.<driver>.command, --no-ext-diff가 막는 대상)와 textconv filter(diff.<driver>.
// textconv, git-show(1)/git-log(1) 문서 기준 --textconv/--no-textconv로 제어)는 git이
// 서로 다른 표면으로 취급한다 — --no-ext-diff 하나만으로는 textconv를 막지 못한다.
// 동일하게 "diff=<driver>" gitattributes 속성 하나로 명령줄 플래그 없이 자동 트리거되므로
// --no-ext-diff와 나란히 강제한다.
const GIT_NO_EXT_DIFF_FLAG = "--no-ext-diff";
const GIT_NO_TEXTCONV_FLAG = "--no-textconv";
const GIT_EXT_DIFF_CAPABLE_SUBCOMMANDS: ReadonlySet<string> = new Set(["diff", "log", "show"]);
// pager/external-diff는 config(-c, 위)보다도 이 환경변수가 우선한다는 것이 git 공식 문서에
// 명시되어 있다("The order of preference is the $GIT_PAGER environment variable, then
// core.pager configuration") — -c override만으로는 상속된 환경변수를 이길 수 없으므로
// 반드시 함께 제거해야 한다.
const GIT_EXTERNAL_HELPER_ENV_KEYS: readonly string[] = ["GIT_PAGER", "PAGER", "GIT_EXTERNAL_DIFF"];

function hardenedGitSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of GIT_EXTERNAL_HELPER_ENV_KEYS) delete out[k];
  return out;
}

/** read-only로 이미 검증된 git args에 위 안전 override를 적용한 실제 spawn용 argv를
 *  만든다 — args[0](서브커맨드) 앞에 전역 -c 옵션들을, diff 관련 서브커맨드에만
 *  --no-ext-diff/--no-textconv를 추가한다. 이 함수는 args가 이미
 *  isReadOnlyGitInvocation()을 통과했다는 전제 위에서만 호출된다. */
function buildHardenedGitArgs(args: string[]): string[] {
  const [sub, ...rest] = args;
  const extDiffGuard = GIT_EXT_DIFF_CAPABLE_SUBCOMMANDS.has(sub) ? [GIT_NO_EXT_DIFF_FLAG, GIT_NO_TEXTCONV_FLAG] : [];
  return [...GIT_NEUTRALIZING_C_OVERRIDES, sub, ...extDiffGuard, ...rest];
}

// =========================================================
// Core Recognized Executable Family Allow-list — SI-3.4(Command Execution Safety
// Architecture Closure) — Core hard rule.
// =========================================================
// SI-3.3 REVISE는 "알려진 위험한 interpreter/wrapper 이름"을 계속 나열하는 방식
// (POSIX_SHELL_INTERPRETERS/SCRIPT_EVAL_INTERPRETERS/WINDOWS_SHELL_INTERPRETERS/
// EXECUTION_DELEGATION_WRAPPERS — bash/sh/zsh/python/powershell/env/nohup/setsid 등)으로
// 버텼다. GPT Independent Reviewer는 매 회차 새로운 wrapper 조합을 찾아냈고(이번 SI-3.4
// 지시서의 nice/timeout/stdbuf/busybox 포함), 그 목록은 원리상 완결될 수 없다 — "이 세상
// 모든 shell/wrapper 실행 파일 이름"은 유한한 방식으로 나열할 수 있는 집합이 아니다.
//
// SI-3.4는 설계를 뒤집는다: "무엇이 위험한가"를 나열하는 대신 "AutoDev가 실제로 필요로
// 하는 것이 무엇인가"만 나열한다. CORE_ALLOWED_EXECUTABLE_FAMILIES는 AutoDev 자신의
// 빌드/테스트/개발 도구 표면(.claude/CLAUDE.md 검증 절차 — npx tsc --noEmit / npm run
// build / npm run test:<module> — 그리고 claude-developer.ts가 실제 만들어내는
// RUN_COMMAND의 실제 사용례 — node <script>.test.js / git 조회)과 정확히 일치하는 닫힌
// (closed) 5개 executable family다. 이 목록에 없는 executable은 그것이 무엇이든(알려진
// wrapper든 이전에 한 번도 본 적 없는 새 wrapper든) 무조건 거부된다 — bash/sh/zsh/dash/
// ksh/ash/pwsh/powershell/cmd/python/ruby/perl/php/deno/bun은 물론 nice/timeout/stdbuf/
// busybox/env/nohup/setsid 같은 실행 위임 wrapper, 그리고 이 목록에 없는 임의의 다른
// 이름도 "이 목록에 없다"는 사실 하나만으로 차단된다 — 이 코드가 "이것이 wrapper라는
// 것"을 알 필요가 전혀 없다(요구사항 7: 모든 wrapper를 알아내는 parser를 만들지 않는다 —
// 알아낼 필요 자체가 없어졌다). "wrapper nesting"(예: `env timeout bash -c ...`)도 첫
// executable(env)부터 이미 이 목록에 없으므로 중첩을 재귀 추적할 필요가 없다(요구사항 6:
// shell parsing을 새로 구현하지 않는다 — 애초에 두 번째 이상의 argv를 해석할 필요가
// 없다). "path-qualified"("/usr/bin/bash", "C:\\tools\\bash.exe")나 대소문자/확장자가
// 다른 변형("BASH", "CMD.EXE")도 normalizeExecutableBase() 하나로 통일해 같은 판정을
// 받는다.
//
// 이 allow-list는 policy.allowedCommands(project 소유)보다 항상 먼저, 그리고 그것과
// 무관하게 적용된다(요구사항 3: 프로젝트가 arbitrary shell string으로 이 경계를 우회할 수
// 없다) — 이 함수는 policy를 인자로 받지 않으므로 어떤 project도 이 5개 목록을 확장할
// 방법이 없다.
//
// family 허용은 "이 실행 파일 자체를 실행할 자격이 있다"는 판정일 뿐, "어떤 인자로도
// 실행해도 된다"는 뜻이 아니다 — family 허용 뒤에 각 family별 추가 검사가 적용된다: git은
// read-only 서브커맨드 allow-list(GIT_READ_ONLY_*, 아래 그대로 유지), node는 코드/표현식을
// 즉시 실행하거나 모듈을 preload하는 플래그 검사(NODE_EVAL_FLAG_PATTERNS), npm/npx는 첫
// 인자 allow-list(NPM_ALLOWED_SUBCOMMANDS/NPX_ALLOWED_PACKAGE_NAMES — SI-3.4 bounded GPT
// Independent Review 1차 CRITICAL 지적으로 추가: npm exec/npx는 인자로 지정한 임의
// 코드·패키지를 그대로 실행하는 위임 executor라 node의 eval 플래그와 동일한 클래스의
// 위험이다). tsc만 인자로 넘긴 내용을 코드로 즉시 실행하는 표준 플래그/서브커맨드가 없어
// family 허용만으로 충분하다.
const CORE_ALLOWED_EXECUTABLE_FAMILIES: ReadonlySet<string> = new Set([
  "git",
  "npm",
  "npx",
  "node",
  "nodejs", // 일부 Linux 배포판(Debian/Ubuntu 계열)에서 쓰이는 node의 대체 실행 파일 이름.
  "tsc",
]);

/** command에서 디렉터리/확장자를 제거한 실행 파일 이름(소문자)만 남긴다 — 이 파일 전체가
 *  "실행 파일이 무엇인가"를 판정하는 단일 출처다(git 판정/family 판정/node eval 판정이
 *  모두 이 함수 하나만 쓴다). 호스트 OS와 무관하게 "/"와 "\\" 둘 다 항상 구분자로
 *  인식한다(POSIX 호스트에서도 Windows 경로 형태의 basename을 놓치지 않는다).
 */
function normalizeExecutableBase(command: string): string {
  const withoutDir = command.trim().split(/[\\/]/).pop() ?? command.trim();
  return withoutDir.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
}

// node에만 적용되는 "코드/표현식을 즉시 실행하거나 모듈을 preload로 강제 로드하는" 플래그 —
// SI-3.3에서 검증된 -c/-e/-p/--eval/--print 정규식에 더해, SI-3.4 bounded GPT Independent
// Review(1차, HIGH)가 지적한 --require/-r(CJS preload)/--import(ESM preload)/--loader·
// --experimental-loader(모듈 loader 등록)를 추가한다 — 이 넷 모두 entry script 실행 전에
// 임의 로컬 모듈을 먼저 로드해 그 모듈의 top-level 코드를 즉시 실행시킨다는 점에서
// -e/--eval과 같은 클래스의 위험이다(그 모듈 파일 내용은 이 gate가 검증할 방법이 없다).
// family 범위가 5개로 줄어 python/ruby/perl/php/deno/bun/bash 등은 이제 위 allow-list
// 단계에서 이미 차단되므로 그 언어들의 개별 eval 플래그 형태를 더는 나열할 필요가 없다.
const NODE_EVAL_FLAG_PATTERNS: RegExp[] = [
  /^(-c|-e|-r|-p|--eval|--print|--require|--import|--loader|--experimental-loader)$/i,
  /^--(eval|print|require|import|loader|experimental-loader)=/i,
  /^-[ecrp]./,
];

function hasNodeEvalFlag(args: string[]): boolean {
  return args.some((a) => NODE_EVAL_FLAG_PATTERNS.some((p) => p.test(a)));
}

// npm/npx에만 적용되는 "인자로 지정한 대상을 그대로 실행" 제한 — SI-3.4 bounded GPT
// Independent Review(1차, CRITICAL)가 지적: npm/npx는 family 허용만으로는 node의 eval
// 플래그와 동일한 클래스의 우회를 허용한다 — npx는 사실상 "npm exec"의 별칭이고, 둘 다
// 인자로 지정한 임의 패키지/커맨드를 즉시 다운로드·실행할 수 있다("npm exec -- <cmd>",
// "npm x <pkg>", "npx --package=<pkg> <cmd>"). AutoDev의 실제 필요(.claude/CLAUDE.md
// 검증 절차, REALISTIC_EXECUTION_POLICY fixture)는 "npm run <script>"/"npm test"/
// "npx tsc"뿐이므로 그 형태만 허용하고 나머지는 전부 차단한다 — args[0]를 고정된
// allow-set으로 제한하면 "--package="처럼 args[0] 자리에 오는 우회 플래그도 그 자체로
// allow-set에 없어 함께 차단된다(별도 플래그 목록을 나열할 필요가 없다).
const NPM_ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set(["run", "test"]);
const NPX_ALLOWED_PACKAGE_NAMES: ReadonlySet<string> = new Set(["tsc"]);

/**
 * RUN_COMMAND의 Core Command Safety Gate — validateCommand()가 policy.allowedCommands를
 * 확인하기 전에 항상 먼저 통과해야 한다.
 *   1) 실행 파일(normalizeExecutableBase 기준)이 CORE_ALLOWED_EXECUTABLE_FAMILIES(git/npm/
 *      npx/node/tsc) 밖이면 무조건 거부한다(위 설명 — SI-3.4, 이 다섯 개 밖은 그것이
 *      wrapper인지 여부와 무관하게 전부 차단이라 bash/sh/env/nice/timeout/stdbuf/busybox 등
 *      개별 이름을 알 필요가 없다).
 *   2) 대상이 node/nodejs이고 인자에 코드/표현식을 즉시 실행하거나 모듈을 preload하는 플래그
 *      (-c/-e/-r/-p/--eval/--print/--require/--import/--loader 등)가 있으면 무조건
 *      거부한다(위 설명).
 *   2-1) 대상이 npm이면 첫 인자가 NPM_ALLOWED_SUBCOMMANDS(run/test) 밖일 때, 대상이 npx면
 *      첫 인자가 NPX_ALLOWED_PACKAGE_NAMES(tsc) 밖일 때 무조건 거부한다(위 설명 — npm
 *      exec/x, npx의 임의 패키지 실행은 node의 eval 플래그와 같은 클래스의 위험이다).
 *   3) 대상이 git이면 read-only 서브커맨드가 아닌 한 무조건 거부(위 설명).
 *   0) command 문자열 자체에 경로 구분자("/"·"\\")나 드라이브 문자(":")가 있으면 무조건
 *      거부한다(위 1)보다도 먼저 — SI-3.4 bounded GPT Independent Review 2차(CRITICAL)
 *      지적: normalizeExecutableBase()가 경로를 벗겨내고 basename만으로 family를 판정하기
 *      때문에, hand-authored(비-Planner) ProjectExecutionPolicy가 "/tmp/git" 같은
 *      path-qualified 이름을 그대로 policy.allowedCommands에 등록하면(spec-planner.ts의
 *      LLM 생성 policy 전용 경로-구분자 거부는 여기 적용되지 않는다) 공격자가 배치한 임의
 *      경로의 파일이 "git"으로 정규화되어 family 허용까지 통과할 위험이 있었다. 이 검사는
 *      그 등록 자체를 Core 레벨에서 authoritative하게 차단해, "policy가 어떤 절대/상대
 *      경로를 command에 넣더라도" 통과할 수 없게 한다(bare 실행 파일 이름만 허용 — 실제
 *      무엇이 실행될지는 표준 PATH 탐색에 맡긴다).
 *   4) 명령 인자 중 하나라도 ENV_FILE_PATTERNS/SECRET_NAME_PATTERNS(이 파일의 단일 출처,
 *      secret-scanner.ts와 동일한 상수를 재사용 — 목록을 복제하지 않는다)에 매칭되면 거부한다
 *      — "cat web/.env" 같은 경로 기반 secret/env 접근을 명령 인자 레벨에서 막는다(이제
 *      "cat"은 1)에서 이미 차단되지만, 이 검사는 CORE_ALLOWED_EXECUTABLE_FAMILIES 안의
 *      명령(예: 향후 git 인자로 실수로 .env 경로가 전달되는 경우)에도 동일하게 적용되는
 *      별도 방어선이다). 이 목적은 secret-scanner.ts(Phase C Task C3, commit 대상 파일
 *      "내용"을 검사)와 겹치지 않는다 — 여기는 "명령 실행 인자"가 secret/env 파일을
 *      가리키는지만 본다(책임 분리).
 * 어떤 ProjectExecutionPolicy도 이 함수의 동작을 바꿀 방법이 없다(인자로 policy를 받지
 * 않음).
 */
export function coreCommandSafetyGate(command: string, args: string[]): { ok: boolean; reason?: string } {
  if (/[\\/]/.test(command) || command.includes(":")) {
    return {
      ok: false,
      reason:
        "Core Command Safety Gate: 경로 구분자/드라이브 문자가 포함된 executable은 허용되지 않습니다 — " +
        "bare 실행 파일 이름만 허용됩니다(예: \"git\", \"npm\") — 어떤 프로젝트 정책으로도 우회할 수 없습니다.",
    };
  }
  const base = normalizeExecutableBase(command);

  if (!CORE_ALLOWED_EXECUTABLE_FAMILIES.has(base)) {
    return {
      ok: false,
      reason:
        "Core Command Safety Gate: 인식되지 않은 executable입니다 — Core가 허용하는 command family" +
        "(git/npm/npx/node/tsc) 밖의 명령은 어떤 프로젝트 정책으로도 실행할 수 없습니다" +
        "(shell/interpreter wrapper 포함, 알려진 wrapper 여부와 무관).",
    };
  }
  if ((base === "node" || base === "nodejs") && hasNodeEvalFlag(args)) {
    return {
      ok: false,
      reason:
        "Core Command Safety Gate: node에 코드·표현식을 즉시 실행하거나 모듈을 preload하는 플래그" +
        "(-c/-e/-r/-p/--eval/--print/--require/--import/--loader 등)가 포함되어 있어 내용을 안전하게 " +
        "검증할 수 없습니다 — 어떤 프로젝트 정책으로도 허용되지 않습니다.",
    };
  }
  if (base === "npm" && (args.length === 0 || !NPM_ALLOWED_SUBCOMMANDS.has(args[0]))) {
    return {
      ok: false,
      reason:
        "Core Command Safety Gate: npm은 run/test 서브커맨드만 허용됩니다 — exec/x 등 인자로 지정한 " +
        "임의 코드·패키지를 즉시 실행하는 형태는 어떤 프로젝트 정책으로도 허용되지 않습니다.",
    };
  }
  if (base === "npx" && (args.length === 0 || !NPX_ALLOWED_PACKAGE_NAMES.has(args[0]))) {
    return {
      ok: false,
      reason:
        "Core Command Safety Gate: npx는 Core가 인식하는 패키지(tsc)만 실행할 수 있습니다 — 그 외 임의 " +
        "패키지 실행(--package= 우회 포함)은 어떤 프로젝트 정책으로도 허용되지 않습니다.",
    };
  }
  if (base === "git" && !isReadOnlyGitInvocation(args)) {
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
    // SI-3.3~3.5 4-chunk 최종 리뷰 지적(HIGH) — git은 validateCommand()를 통과했다는
    // 사실만으로는(명령줄 플래그 검사만 거쳤을 뿐) 여전히 repo 자신의 config/gitattributes를
    // 통해 외부 프로그램을 실행할 수 있다(§ buildHardenedGitArgs 상단 주석). 실제 spawn
    // 직전에만(위 validateCommand의 args 자체는 건드리지 않음) 안전 override를 추가한다 —
    // git이 아닌 명령에는 전혀 영향 없다.
    const isGit = normalizeExecutableBase(command) === "git";
    const spawnArgs = isGit ? buildHardenedGitArgs(args) : args;
    const spawnEnv = isGit ? hardenedGitSpawnEnv(process.env) : process.env;
    const res = spawnSync(command, spawnArgs, {
      cwd: cwdResolved.path,
      shell: false,
      encoding: "utf-8",
      timeout: 300_000,
      maxBuffer: 5 * 1024 * 1024,
      env: spawnEnv,
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
