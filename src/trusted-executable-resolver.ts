import { existsSync, realpathSync, statSync } from "node:fs";
import { join, sep, win32 as pathWin32, posix as pathPosix } from "node:path";

// testDeps.platform으로 실제 OS와 다른 platform을 시뮬레이션하는 단위 테스트(예: 이
// Windows 개발 머신에서 POSIX PATH 탐색 로직을 검증)를 지원하려면 경로 조립 자체도 그
// simulated platform 기준이어야 한다 — 이 모듈 최상위의 ambient `join`/`sep`(항상 실제
// 실행 중인 OS 기준)를 그대로 쓰면 testDeps.platform이 실제 동작에 전혀 반영되지 않는다.
// Node의 `path.win32`/`path.posix`는 실제 OS와 무관하게 항상 그 platform 규칙으로 동작하는
// 공식 API라 이 문제를 새 로직 없이 그대로 해결한다.
function pathForPlatform(platform: NodeJS.Platform): { join: typeof join; sep: string } {
  return platform === "win32" ? pathWin32 : pathPosix;
}

// Trusted Executable Resolution — SI-3.6(Executable Identity Trust / PATH-CWD Shadowing
// Closure) — Core hard rule.
//
// SI-3.4(Command Execution Safety)는 "어떤 executable 이름을 실행해도 되는가"를
// CORE_ALLOWED_EXECUTABLE_FAMILIES(git/npm/npx/node/tsc)로 닫았다. 하지만 그 게이트를
// 통과한 뒤에도 safe-executor.ts/claude-runner.ts/claude-developer.ts는 여전히 "git"/
// "node"/"claude" 같은 bare 이름을 그대로 spawnSync/spawn에 넘겼다 — 실제로 어떤 파일이
// 실행될지는 OS의 PATH/cwd 탐색에 맡겨져 있었다. 공격자가 project root나 cwd, OS temp
// 디렉터리에 가짜 git.exe/node.exe/claude.exe를 심거나 PATH 앞에 악성 디렉터리를
// prepend하면, "허용된 명령 이름"이라는 판정과 무관하게 그 가짜 바이너리가 대신 실행될 수
// 있다 — 이름 허용(command safety gate)과 실행 파일 신원(executable identity)은 서로 다른
// 질문이며, 이 파일은 후자만 담당한다.
//
// 이 모듈은 "허용된 이름을 무엇으로 실행할 것인가"를 결정하는 단일 출처다 — 어떤
// 호출부(safe-executor.ts의 RUN_COMMAND, claude-runner.ts/claude-developer.ts의 claude CLI
// 호출)도 이 모듈을 거치지 않고 직접 bare 이름을 spawn에 넘기지 않는다(§ 각 호출부의
// 수정 내역 참고). 이 파일은 CORE_ALLOWED_EXECUTABLE_FAMILIES를 대체하지 않는다 — 두
// 게이트 모두 통과해야만 실제 실행이 일어난다(§ safe-executor.ts executeRunCommand).
//
// 설계 원칙(SI-3.4/3.5와 동일):
//   - "무엇이 가짜인가"를 나열하지 않는다(fake-git.exe 같은 이름을 알 필요가 없다) —
//     대신 "신뢰할 수 없는 위치"(project root/cwd/OS temp 등, excludedRoots)를 구조적으로
//     제외하고, 그 밖에서 실제로 검증 가능한 실행 파일만 신뢰한다.
//   - fail-closed — 신뢰를 확인할 근거가 없으면 비슷해 보이는 대체 실행 파일로 조용히
//     넘어가지 않는다(TRUSTED_EXECUTABLE_NOT_FOUND/EXECUTABLE_IDENTITY_UNTRUSTED/
//     EXECUTABLE_SHADOWING_DETECTED 중 하나로 명시적으로 거부한다).
//   - 이 함수들은 ProjectExecutionPolicy를 인자로 받지 않는다 — 어떤 프로젝트 정책도 이
//     판정을 약화시킬 방법이 없다(SI-3.4 coreCommandSafetyGate와 동일한 설계).
//
// 각 kind별 신뢰 근거(2026-08-24, 이 저장소 개발 머신에서 실제 확인한 증거 — 추측으로
// 채우지 않았다. § 4번 항목 "npm/npx" 참고):
//   - node: process.execPath — 지금 이 AutoDev 프로세스를 구동 중인 바로 그 Node 바이너리의
//     OS 확정 절대경로다. self-dev-completion-hook.ts(runSelfDevCompletionHook)가 이미
//     동일한 근거로 "node" 대신 process.execPath를 쓰고 있다 — 이 파일은 그 패턴을
//     git/npm/npx/claude로 일반화한 것이다(새 신뢰 근거를 발명하지 않음). project
//     content가 이 값에 영향을 줄 방법이 없으므로(OS가 프로세스 시작 시점에 확정) 어떤
//     excludedRoots 검사도 필요하지 않다 — 그 자체가 신뢰의 뿌리다.
//   - npm/npx: 공식 npm.cmd shim(Windows, `C:\Program Files\nodejs\npm.cmd`) 자체의 실제
//     내용을 직접 열어 확인한 결과, 그 shim은 정확히 "%~dp0\node.exe" "%~dp0\node_modules\
//     npm\bin\npm-cli.js" 형태로(자기 자신과 같은 디렉터리의 node.exe + 그 옆
//     node_modules/npm/bin/npm-cli.js) 실행된다 — 즉 npm 공식 배포 자체가 "신뢰된 node
//     설치 옆의 JS 진입점"을 신뢰 근거로 쓴다. 이 모듈은 그 evidence를 그대로 재사용한다:
//     trusted node(process.execPath)의 디렉터리를 기준으로 npm-cli.js/npx-cli.js를
//     찾고, 그 JS 파일을 trusted node로 직접 실행한다(node_modules/npm의 .cmd/.ps1 shim
//     자체는 전혀 spawn하지 않는다) — self-dev-complete.ts가 이미 실측 확인한 사실(".cmd
//     shim은 shell:false spawnSync로 직접 실행하면 ENOENT/EINVAL") 때문에라도 shim을
//     직접 실행하는 경로는 애초에 쓸 수 없다. POSIX 표준 설치 레이아웃(node가 <prefix>/
//     bin에, npm이 <prefix>/lib/node_modules/npm에 설치됨)도 후보로 함께 시도하되, 실제로
//     그 경로에 파일이 존재할 때만 신뢰하고 존재하지 않으면 추측하지 않고 실패한다.
//   - git/claude: Node 설치에 딸려오지 않는 독립 실행 파일이라 위와 같은 "동봉된 옆
//     경로" 근거가 없다. 대신 PATH를 이 모듈이 직접(OS의 CreateProcess/execvp 탐색에
//     위임하지 않고) 순회하며, project root/cwd/OS temp 등 신뢰할 수 없는 위치에 있는
//     후보는 구조적으로 건너뛰고, 그 밖에서 처음 발견된 유효한 후보(정규 파일, symlink
//     realpath도 신뢰할 수 없는 위치 밖)를 채택한다. 운영자가 AUTODEV_TRUSTED_GIT_PATH/
//     AUTODEV_TRUSTED_CLAUDE_PATH로 명시적 경로를 지정할 수도 있지만, 그 값도 동일한
//     검증(존재/정규파일/realpath 위치)을 통과해야만 신뢰된다 — 지정된 값을 맹목적으로
//     믿지 않는다(§ 요구사항 7 옵션 C).
//
// 정직하게 명시하는 경계(§ .claude/rules/filesystem-trust-model.md의 "Portable Core
// Boundary"와 동일한 프레이밍 — SI-3.5가 정한 경계를 재정의하지 않고 그대로 확장한다):
// 이 PATH 탐색은 "AutoDev 프로세스가 시작되기 전에 이미 시스템 전역 PATH 자체가
// 공격자에 의해 완전히 장악되어, project/cwd/temp 밖의 legitimate-looking 디렉터리를
// 가리키게 조작된" 시나리오까지는 막지 못한다 — 그 시점에는 이미 호스트 자체가
// 공격자에게 넘어간 것이라 portable Node.js 코드로 방어할 방법이 없다(커널 레벨 보장을
// 거짓 주장하지 않는다는 SI-3.5의 원칙과 동일). 이 모듈이 실제로 닫는 것은: project-local
// 가짜 실행 파일, cwd-local 가짜 실행 파일(특히 Windows의 CreateProcess가 bare 이름에
// 대해 cwd를 PATH보다 먼저 검색하는 문제 — 이 모듈이 처음부터 절대경로를 만들어
// spawnSync에 넘기므로 그 검색 자체가 일어나지 않는다), temp/scratch 디렉터리에 심어진
// 가짜 실행 파일, 그리고 project/cwd/temp 안쪽을 가리키는 PATH prepend다.
//
// SI-3.6 bounded review(chunk1 HIGH) 지적에 대한 명시적 응답 — "project/cwd/temp 밖의
// 정규 파일이면 무조건 신뢰하는 건 negative filtering일 뿐 positive identity trust가
// 아니다"는 지적은 정확하다. 이를 signature/checksum/설치 provenance 같은 positive trust
// anchor로 완전히 해결하려면 (a) OS별 코드 서명 검증 API 연동이나 known-good hash registry
// 같은 새 subsystem을 만들거나, (b) "공식 설치 경로는 여기다"를 OS별로 하드코딩해야 한다 —
// 둘 다 이 Task의 명시적 범위 밖이다((a)는 Task 종료 조건의 "새 native subsystem/OS-specific
// dependency가 필요하면 임의로 만들지 말고 STOP"에 해당하고, (b)는 요구사항 6/7이 금지하는
// "증거 없는 경로 하드코딩"에 해당한다 — 예를 들어 이 저장소를 개발 중인 실제 머신에서도
// 진짜 claude.exe는 `C:\Users\<user>\.local\bin\claude.exe`처럼 사용자 프로필 하위에 설치돼
// 있다. "사용자 프로필 하위는 신뢰하지 않는다"는 규칙을 추가하면 이 정상 설치까지 함께
// 차단된다). 그래서 이 모듈은 그 상위 문제(positive trust anchor)를 새로 만들지 않고,
// **AutoDev 자신이 실제로 통제할 수 있는 표면**(project content가 쓸 수 있는 위치 — project
// root/cwd/temp)만 구조적으로 배제하는 데 집중한다 — SI-3.5의 filesystem-trust-model.md가
// "닫을 수 있는 것만 확실히 닫고, 닫을 수 없는 것은 정직하게 범위 밖이라고 선언한다"고 이미
// 정한 것과 동일한 원칙이다. 이 경계를 넘는 강화(코드 서명 검증 등)가 필요하다고 판단되면
// 별도 Task로 명시적 승인을 받아 진행해야 한다.

// "tsc"는 이 파일의 resolveTrustedExecutable()이 직접 다루지 않는다(project 자신의
// node_modules 안을 신뢰 위치로 다뤄야 해서 project root를 아는 safe-executor.ts의
// SafeExecutorContext가 직접 해석한다 — § safe-executor.ts resolveTrustedTsc) — 다만 타입/
// trustSource는 이 파일에 함께 정의해 두 kind 체계가 갈라지지 않게 한다(단일 출처).
export type TrustedExecutableKind = "node" | "git" | "npm" | "npx" | "claude" | "tsc";

export type ExecutableTrustSource =
  | "process_exec_path"
  | "colocated_with_trusted_node"
  | "path_search_verified"
  | "explicit_trusted_override"
  | "project_local_dependency";

export type ExecutableTrustErrorCode =
  | "TRUSTED_EXECUTABLE_NOT_FOUND"
  | "EXECUTABLE_IDENTITY_UNTRUSTED"
  | "EXECUTABLE_SHADOWING_DETECTED";

export interface TrustedExecutableOk {
  ok: true;
  requestedName: TrustedExecutableKind;
  executableKind: TrustedExecutableKind;
  trustSource: ExecutableTrustSource;
  verified: true;
  /** 실제 spawnSync/spawn의 command 인자로 넘겨야 하는 검증된 절대경로. */
  spawnCommand: string;
  /** spawnCommand 뒤, 호출자의 실제 args보다 앞에 와야 하는 고정 prefix — node/git/claude는
   *  항상 빈 배열이고, npm/npx만 [진입 JS 파일 경로]를 담는다(§ 위 npm/npx 설명). */
  spawnArgsPrefix: string[];
  /** 사람이 읽는 canonical identity 경로(감사/로그용) — node/git/claude는 spawnCommand와
   *  동일하고, npm/npx는 실제로 실행되는 JS 진입점(spawnArgsPrefix[0])과 동일하다. */
  canonicalPath: string;
}

export interface TrustedExecutableFail {
  ok: false;
  code: ExecutableTrustErrorCode;
  reason: string;
}

export type TrustedExecutableResult = TrustedExecutableOk | TrustedExecutableFail;

/** 실제 운용 코드는 절대 채우지 않는 테스트 전용 injection seam(§ PLANNER_TEST_DEPS/
 *  ProjectLockTestDeps와 동일한 패턴) — 실제 파일시스템/실제 PATH/실제 process.execPath 없이
 *  가짜 실행 파일 shadowing 시나리오를 deterministic하게 재현하기 위함이다. */
export interface TrustedExecutableTestDeps {
  pathEnv?: string;
  platform?: NodeJS.Platform;
  execPath?: string;
  envOverride?: Record<string, string | undefined>;
  existsSyncImpl?: (p: string) => boolean;
  statSyncImpl?: (p: string) => { isFile(): boolean };
  realpathSyncImpl?: (p: string) => string;
}

export interface ResolveTrustedExecutableOptions {
  /** PATH에서 발견돼도 절대 신뢰하지 않을 절대경로 목록(project root/cwd/OS temp 등) —
   *  이 경로 자체이거나 그 하위인 후보는 구조적으로 건너뛴다. */
  excludedRoots: string[];
  /** npm/npx 전용 — 이미 신뢰가 확인된 node 결과. 지정하지 않으면 이 함수가 내부적으로
   *  kind="node"를 먼저 해석해 얻는다(호출부가 이미 해석해뒀다면 중복 해석을 피하기 위한
   *  선택적 재사용 — 없어도 정확히 동일한 결과를 만든다). */
  trustedNode?: TrustedExecutableOk;
  testDeps?: TrustedExecutableTestDeps;
}

const EXPLICIT_OVERRIDE_ENV_VARS: Partial<Record<TrustedExecutableKind, string>> = {
  git: "AUTODEV_TRUSTED_GIT_PATH",
  claude: "AUTODEV_TRUSTED_CLAUDE_PATH",
};

// Windows는 .cmd/.bat/.ps1 shim을 shell:false spawnSync로 직접 실행할 수 없다(self-dev-
// complete.ts가 이미 실측 확인: ENOENT/EINVAL). 이 모듈은 이 파일을 새로 spawn하지 않고
// shim이 아닌 "다음" PATH 후보를 계속 찾는다 — 셸을 도입해 우회하지 않는다(이 저장소
// 전체가 shell:false를 고정하는 설계 원칙과 동일).
const UNSAFE_SHIM_EXTENSION_PATTERN = /\.(cmd|bat|ps1)$/i;

function readEnv(name: string, testDeps?: TrustedExecutableTestDeps): string | undefined {
  if (testDeps?.envOverride && name in testDeps.envOverride) return testDeps.envOverride[name];
  return process.env[name];
}

function candidateNamesFor(kind: "git" | "claude", platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    return kind === "git" ? ["git.exe"] : ["claude.exe", "claude.cmd", "claude.bat"];
  }
  return [kind];
}

function toLowerNormalized(p: string): string {
  return p.toLowerCase();
}

/** candidate가 roots 중 하나이거나 그 하위 경로인지 확인한다(safe-executor.ts의 resolveSafe와
 *  동일한 대소문자 무시 containment 스타일 — 이 저장소 전체의 기존 관례를 그대로 따른다). */
function isInsideAnyRoot(candidate: string, roots: string[]): boolean {
  const c = toLowerNormalized(candidate);
  return roots.some((r) => {
    const rl = toLowerNormalized(r);
    return c === rl || c.startsWith(rl + sep) || c.startsWith(rl + "/");
  });
}

interface FsDeps {
  exists: (p: string) => boolean;
  stat: (p: string) => { isFile(): boolean };
  realpath: (p: string) => string;
}

function fsDepsFrom(testDeps?: TrustedExecutableTestDeps): FsDeps {
  return {
    exists: testDeps?.existsSyncImpl ?? existsSync,
    stat: testDeps?.statSyncImpl ?? statSync,
    realpath: testDeps?.realpathSyncImpl ?? realpathSync,
  };
}

function verifyRegularFileOutsideExcluded(
  candidate: string,
  excludedRoots: string[],
  fs: FsDeps
): { ok: true; real: string } | { ok: false; code: ExecutableTrustErrorCode; reason: string } {
  if (!fs.exists(candidate)) {
    return { ok: false, code: "TRUSTED_EXECUTABLE_NOT_FOUND", reason: `${candidate}가 존재하지 않습니다.` };
  }
  let st: { isFile(): boolean };
  try {
    st = fs.stat(candidate);
  } catch {
    return { ok: false, code: "EXECUTABLE_IDENTITY_UNTRUSTED", reason: `${candidate} 상태 확인 실패.` };
  }
  if (!st.isFile()) {
    return { ok: false, code: "EXECUTABLE_IDENTITY_UNTRUSTED", reason: `${candidate}는 일반 파일이 아닙니다.` };
  }
  let real: string;
  try {
    real = fs.realpath(candidate);
  } catch {
    return { ok: false, code: "EXECUTABLE_IDENTITY_UNTRUSTED", reason: `${candidate} realpath 확인 실패.` };
  }
  // symlink/reparse escape 방어 — 최종 실제 경로도 신뢰할 수 없는 위치 밖이어야 한다.
  if (isInsideAnyRoot(candidate, excludedRoots) || isInsideAnyRoot(real, excludedRoots)) {
    return {
      ok: false,
      code: "EXECUTABLE_SHADOWING_DETECTED",
      reason: `${candidate}(실제 위치: ${real})가 신뢰할 수 없는 위치(project root/cwd/temp 등) 안에 있습니다.`,
    };
  }
  return { ok: true, real };
}

function resolveExplicitOverride(
  kind: TrustedExecutableKind,
  opts: ResolveTrustedExecutableOptions,
  fs: FsDeps
): TrustedExecutableResult | null {
  const envVarName = EXPLICIT_OVERRIDE_ENV_VARS[kind];
  if (!envVarName) return null;
  const val = readEnv(envVarName, opts.testDeps);
  if (!val || val.trim().length === 0) return null;
  const verified = verifyRegularFileOutsideExcluded(val, opts.excludedRoots, fs);
  if (!verified.ok) {
    return { ok: false, code: verified.code, reason: `${envVarName}: ${verified.reason}` };
  }
  return {
    ok: true,
    requestedName: kind,
    executableKind: kind,
    trustSource: "explicit_trusted_override",
    verified: true,
    spawnCommand: verified.real,
    spawnArgsPrefix: [],
    canonicalPath: verified.real,
  };
}

function resolveNode(opts: ResolveTrustedExecutableOptions, fs: FsDeps): TrustedExecutableResult {
  const execPath = opts.testDeps?.execPath ?? process.execPath;
  // process.execPath는 이 AutoDev 프로세스를 구동한 OS 자체가 확정한 값이다 — project
  // content가 영향을 줄 수 있는 경로가 아니므로 excludedRoots containment 검사 대상이
  // 아니다(§ 상단 설명). 그래도 손상된 설치에 대비해 존재/정규파일 여부는 확인한다.
  if (!fs.exists(execPath)) {
    return { ok: false, code: "TRUSTED_EXECUTABLE_NOT_FOUND", reason: `process.execPath(${execPath})가 존재하지 않습니다.` };
  }
  let st: { isFile(): boolean };
  try {
    st = fs.stat(execPath);
  } catch {
    return { ok: false, code: "EXECUTABLE_IDENTITY_UNTRUSTED", reason: "process.execPath 상태 확인 실패." };
  }
  if (!st.isFile()) {
    return { ok: false, code: "EXECUTABLE_IDENTITY_UNTRUSTED", reason: "process.execPath가 일반 파일이 아닙니다." };
  }
  // SI-3.6 bounded review(chunk1 MEDIUM) 지적 반영 — process.execPath 자체가 symlink일 수
  // 있는 경로를 그대로 spawnCommand로 쓰지 않고, realpath로 확정된 최종 파일을 canonical
  // identity로 고정한다(npm/npx가 이 값을 기준으로 옆 경로를 유도하는 것과도 일관성 유지).
  // 이것이 실행 직전 파일 교체(진짜 kernel-level TOCTOU)까지 막지는 못한다 — portable
  // Node.js로 커널 수준 보장을 거짓 주장하지 않는다(§ SI-3.5 Portable Core Boundary와 동일
  // 원칙).
  let real = execPath;
  try {
    real = fs.realpath(execPath);
  } catch {
    return { ok: false, code: "EXECUTABLE_IDENTITY_UNTRUSTED", reason: "process.execPath realpath 확인 실패." };
  }
  return {
    ok: true,
    requestedName: "node",
    executableKind: "node",
    trustSource: "process_exec_path",
    verified: true,
    spawnCommand: real,
    spawnArgsPrefix: [],
    canonicalPath: real,
  };
}

function resolveNpmOrNpx(
  kind: "npm" | "npx",
  opts: ResolveTrustedExecutableOptions,
  fs: FsDeps
): TrustedExecutableResult {
  const trustedNode = opts.trustedNode ?? resolveNode(opts, fs);
  if (!trustedNode.ok) return trustedNode;

  const platform = opts.testDeps?.platform ?? process.platform;
  const p = pathForPlatform(platform);
  const nodeDir = trustedNode.canonicalPath.split(/[\\/]/).slice(0, -1).join(p.sep) || p.sep;
  const jsFileName = kind === "npm" ? "npm-cli.js" : "npx-cli.js";
  // 실제 환경 증거(§ 파일 상단 설명) — 공식 npm.cmd shim이 그대로 쓰는 상대 위치(Windows
  // 공식 설치 레이아웃)와, node.js 공식 문서 기준 POSIX 표준 prefix 레이아웃 둘 다
  // 후보로 시도한다. 실제로 파일이 존재하는 후보만 신뢰하고, 없으면 추측하지 않는다.
  const candidates = [
    p.join(nodeDir, "node_modules", "npm", "bin", jsFileName),
    p.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", jsFileName),
  ];

  let lastFail: TrustedExecutableFail | null = null;
  for (const candidate of candidates) {
    if (!fs.exists(candidate)) continue;
    const verified = verifyRegularFileOutsideExcluded(candidate, opts.excludedRoots, fs);
    if (!verified.ok) {
      lastFail = { ok: false, code: verified.code, reason: verified.reason };
      continue;
    }
    return {
      ok: true,
      requestedName: kind,
      executableKind: kind,
      trustSource: "colocated_with_trusted_node",
      verified: true,
      spawnCommand: trustedNode.canonicalPath,
      spawnArgsPrefix: [verified.real],
      canonicalPath: verified.real,
    };
  }
  return (
    lastFail ?? {
      ok: false,
      code: "TRUSTED_EXECUTABLE_NOT_FOUND",
      reason: `신뢰된 node(${trustedNode.canonicalPath}) 기준으로 ${jsFileName}를 찾지 못했습니다.`,
    }
  );
}

function resolveViaPathSearch(
  kind: "git" | "claude",
  opts: ResolveTrustedExecutableOptions,
  fs: FsDeps
): TrustedExecutableResult {
  const platform = opts.testDeps?.platform ?? process.platform;
  const p = pathForPlatform(platform);
  const pathEnv = opts.testDeps?.pathEnv ?? readEnv("PATH", opts.testDeps) ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  const dirs = pathEnv
    .split(delimiter)
    .map((d) => d.trim())
    .filter((d) => d.length > 0);
  const names = candidateNamesFor(kind, platform);

  let sawExcludedOnlyCandidate = false;

  for (const dir of dirs) {
    for (const name of names) {
      if (UNSAFE_SHIM_EXTENSION_PATTERN.test(name)) continue; // shell 없이 안전하게 spawn할 수 없는 shim은 애초에 후보에서 제외
      const candidate = p.join(dir, name);
      if (!fs.exists(candidate)) continue;
      let st: { isFile(): boolean };
      try {
        st = fs.stat(candidate);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      let real: string;
      try {
        real = fs.realpath(candidate);
      } catch {
        continue;
      }
      if (isInsideAnyRoot(candidate, opts.excludedRoots) || isInsideAnyRoot(real, opts.excludedRoots)) {
        sawExcludedOnlyCandidate = true;
        continue; // shadow 후보 — 신뢰하지 않고 다음 PATH 디렉터리를 계속 탐색한다
      }
      return {
        ok: true,
        requestedName: kind,
        executableKind: kind,
        trustSource: "path_search_verified",
        verified: true,
        spawnCommand: real,
        spawnArgsPrefix: [],
        canonicalPath: real,
      };
    }
  }

  return {
    ok: false,
    code: sawExcludedOnlyCandidate ? "EXECUTABLE_SHADOWING_DETECTED" : "TRUSTED_EXECUTABLE_NOT_FOUND",
    reason: sawExcludedOnlyCandidate
      ? `${kind}: PATH에서 발견된 후보가 모두 신뢰할 수 없는 위치(project root/cwd/temp 등) 안에 있어 거부되었습니다.`
      : `${kind}: PATH에서 신뢰 가능한 실행 파일을 찾지 못했습니다.`,
  };
}

/** "tsc"는 이 함수가 다루지 않는다(§ TrustedExecutableKind 주석) — safe-executor.ts가
 *  project root 기준으로 직접 해석한다. */
export type ResolvableExecutableKind = Exclude<TrustedExecutableKind, "tsc">;

// SI-3.6 bounded review(chunk1 MEDIUM) 지적 반영 — excludedRoots 자체를 realpath로
// canonicalize하지 않으면, excludedRoot가 symlink/junction/reparse alias를 가질 때 후보의
// realpath(이미 canonicalize됨)와 root의 원본 문자열을 비교하는 containment 검사가 어긋날 수
// 있다(예: project root가 실제로는 symlink이고 그 alias 경로로 excludedRoots가 전달된 경우).
// 이 함수가 이 문제를 한 곳에서만 해결한다(호출부마다 반복하지 않음) — 존재하지 않는 경로는
// realpath가 실패하므로 원본 문자열을 그대로 유지한다(존재하지 않는 경로는 애초에 그 자체로
// PATH 후보가 될 수 없어 containment 판정에 영향이 없다).
function canonicalizeExcludedRoots(roots: string[], fs: FsDeps): string[] {
  return roots.map((r) => {
    try {
      return fs.realpath(r);
    } catch {
      return r;
    }
  });
}

/**
 * 요청된 executable kind를 검증된 canonical absolute path로 해석한다 — 이름만으로 실행을
 * 승인하지 않는다(§ 파일 상단 설명). 어떤 ProjectExecutionPolicy도 이 함수의 동작을 바꿀
 * 방법이 없다(policy를 인자로 받지 않음).
 */
export function resolveTrustedExecutable(
  kind: ResolvableExecutableKind,
  rawOpts: ResolveTrustedExecutableOptions
): TrustedExecutableResult {
  const fs = fsDepsFrom(rawOpts.testDeps);
  const opts: ResolveTrustedExecutableOptions = {
    ...rawOpts,
    excludedRoots: canonicalizeExcludedRoots(rawOpts.excludedRoots, fs),
  };

  if (kind === "node") return resolveNode(opts, fs);
  if (kind === "npm" || kind === "npx") return resolveNpmOrNpx(kind, opts, fs);

  // git/claude — 명시적 override가 있으면 그것부터(단, 동일한 검증을 거친다), 없으면 PATH 탐색.
  const override = resolveExplicitOverride(kind, opts, fs);
  if (override) return override;
  return resolveViaPathSearch(kind, opts, fs);
}
