import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { resolveTrustedExecutable } from "./trusted-executable-resolver";
import { resolveTrustedClaudeCommand } from "./claude-runner";
import * as subprocessRunnerModule from "./subprocess-runner";
import { configureSafeExecutor, validateAndExecute } from "./safe-executor";
import type { ProjectExecutionPolicy } from "./project-policy";

// SI-3.6(Executable Identity Trust / PATH-CWD Shadowing Closure) 회귀 테스트.
//
// SECTION 1 — 단위 레벨(testDeps injection, 실제 파일시스템/실제 PATH 없이 deterministic).
// SECTION 2 — 이 개발 머신의 실제 node/npm/npx/git/claude 설치를 대상으로 한 "해석만"
//   테스트(실제 spawn 없음 — claude를 실제로 실행하는 것은 이 저장소 전체 규칙(실제 Claude
//   CLI 호출 금지 — API 비용/부작용)에 위배된다).
// SECTION 3 — safe-executor.ts의 실제 RUN_COMMAND 파이프라인(spawnSync 포함)을 통한 marker
//   file 통합 테스트 — SI-3.5에서 이미 검증된 패턴(diff.external/textconv 무력화 증명)을
//   그대로 재사용해, "가짜 실행 파일이 실제로 실행되지 않았다"를 마커 파일 부재로 증명한다.
//   실제 process.env.PATH를 임시로 바꾸므로 매 시나리오 try/finally로 원복한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}
function skip(label: string): void {
  results.push(`[SKIP] ${label}`);
}

// "가짜 실행 파일"을 실제로 디스크에 만든다 — 이 저장소의 신뢰된 resolver 설계상
// excludedRoots 안의 후보는 애초에 spawn 후보에서 제외되므로, 이 파일이 실제로 유효한
// PE/스크립트 형식인지는 시나리오의 핵심이 아니다(신뢰된 resolver가 이 파일을 "고려조차
// 하지 않는다"는 것을 증명하는 것이 목적). 내용은 사람이 읽었을 때 "이건 가짜다"를 알 수
// 있게 POSIX 실행 형식(shebang)으로 통일한다 — Windows에서도 파일 존재/이름 매칭 자체는
// 동일하게 검증되므로 문제가 없다.
function writeMarkerScript(dir: string, name: string, markerPath: string): string {
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, name);
  writeFileSync(scriptPath, `#!/bin/sh\necho fake > "${markerPath}"\nexit 0\n`);
  try {
    chmodSync(scriptPath, 0o755);
  } catch {
    /* Windows에서는 chmod 효과가 제한적이지만 오류를 던지지 않는다 — 방어적으로만 감싼다 */
  }
  return scriptPath;
}

// =========================================================
// SECTION 1 — 단위 레벨(testDeps)
// =========================================================
function section1(): void {
  // ---- node ----
  {
    const r = resolveTrustedExecutable("node", {
      excludedRoots: ["C:\\fake-project"],
      testDeps: {
        execPath: "C:\\real\\node.exe",
        existsSyncImpl: () => true,
        statSyncImpl: () => ({ isFile: () => true }),
        realpathSyncImpl: (p: string) => p,
      },
    });
    check("[node] process.execPath를 그대로 신뢰(excludedRoots와 무관)", r.ok && r.spawnCommand === "C:\\real\\node.exe");
    check("[node] trustSource=process_exec_path", r.ok && r.trustSource === "process_exec_path");
  }
  {
    const r = resolveTrustedExecutable("node", {
      excludedRoots: [],
      testDeps: { execPath: "C:\\missing\\node.exe", existsSyncImpl: () => false },
    });
    check("[node] execPath가 존재하지 않으면 fail-closed(TRUSTED_EXECUTABLE_NOT_FOUND)", !r.ok && r.code === "TRUSTED_EXECUTABLE_NOT_FOUND");
  }

  // ---- npm/npx: colocated_with_trusted_node ----
  {
    const files = new Set(["/trusted/node", "/trusted/node_modules/npm/bin/npm-cli.js"]);
    const r = resolveTrustedExecutable("npm", {
      excludedRoots: ["/project"],
      testDeps: {
        platform: "linux",
        execPath: "/trusted/node",
        existsSyncImpl: (p: string) => files.has(p),
        statSyncImpl: () => ({ isFile: () => true }),
        realpathSyncImpl: (p: string) => p,
      },
    });
    check(
      "[npm] trusted node 옆 node_modules/npm/bin/npm-cli.js를 채택",
      r.ok && r.spawnCommand === "/trusted/node" && r.spawnArgsPrefix[0] === "/trusted/node_modules/npm/bin/npm-cli.js"
    );
    check("[npm] trustSource=colocated_with_trusted_node", r.ok && r.trustSource === "colocated_with_trusted_node");
  }
  {
    // POSIX 표준 레이아웃(<prefix>/lib/node_modules/npm/bin) 후보로 fallback.
    const files = new Set(["/trusted/bin/node", "/trusted/lib/node_modules/npm/bin/npx-cli.js"]);
    const r = resolveTrustedExecutable("npx", {
      excludedRoots: [],
      testDeps: {
        platform: "linux",
        execPath: "/trusted/bin/node",
        existsSyncImpl: (p: string) => files.has(p),
        statSyncImpl: () => ({ isFile: () => true }),
        realpathSyncImpl: (p: string) => p,
      },
    });
    check(
      "[npx] Windows 레이아웃에 없으면 POSIX 표준 레이아웃(../lib/node_modules)으로 fallback",
      r.ok && r.spawnArgsPrefix[0] === "/trusted/lib/node_modules/npm/bin/npx-cli.js"
    );
  }
  {
    const r = resolveTrustedExecutable("npm", {
      excludedRoots: [],
      testDeps: { execPath: "/trusted/node", existsSyncImpl: () => false },
    });
    check("[npm] 두 후보 모두 없으면 추측하지 않고 fail-closed", !r.ok && r.code === "TRUSTED_EXECUTABLE_NOT_FOUND");
  }
  {
    // 방어 심층 — node 설치 자체가 프로젝트 안(vendored)인 극단적 케이스도 excludedRoots로 잡는다.
    const files = new Set(["/project/node", "/project/node_modules/npm/bin/npm-cli.js"]);
    const r = resolveTrustedExecutable("npm", {
      excludedRoots: ["/project"],
      testDeps: {
        platform: "linux",
        execPath: "/project/node",
        existsSyncImpl: (p: string) => files.has(p),
        statSyncImpl: () => ({ isFile: () => true }),
        realpathSyncImpl: (p: string) => p,
      },
    });
    check("[npm] 신뢰된 node 자체가 excludedRoots 안이면 npm-cli.js도 SHADOWING", !r.ok && r.code === "EXECUTABLE_SHADOWING_DETECTED");
  }

  // ---- git/claude: PATH walk ----
  {
    const files = new Set(["/usr/bin/git"]);
    const r = resolveTrustedExecutable("git", {
      excludedRoots: [],
      testDeps: {
        platform: "linux",
        pathEnv: "/usr/bin:/usr/local/bin",
        existsSyncImpl: (p: string) => files.has(p),
        statSyncImpl: () => ({ isFile: () => true }),
        realpathSyncImpl: (p: string) => p,
      },
    });
    check("[git] PATH에서 신뢰 가능한 git 채택(POSIX)", r.ok && r.spawnCommand === "/usr/bin/git" && r.trustSource === "path_search_verified");
  }
  {
    // PATH 앞쪽(신뢰 불가 위치)에 있는 후보는 건너뛰고, 그 뒤의 신뢰 가능한 후보를 채택한다.
    const files = new Set(["/project/git", "/usr/bin/git"]);
    const r = resolveTrustedExecutable("git", {
      excludedRoots: ["/project"],
      testDeps: {
        platform: "linux",
        pathEnv: "/project:/usr/bin",
        existsSyncImpl: (p: string) => files.has(p),
        statSyncImpl: () => ({ isFile: () => true }),
        realpathSyncImpl: (p: string) => p,
      },
    });
    check(
      "[git] project 안 후보(PATH 첫 순서)는 건너뛰고 그 다음 신뢰 가능한 후보를 채택",
      r.ok && r.spawnCommand === "/usr/bin/git"
    );
  }
  {
    // 모든 후보가 신뢰 불가 위치에만 있으면 NOT_FOUND가 아니라 SHADOWING으로 구분해 보고한다.
    const files = new Set(["/project/git"]);
    const r = resolveTrustedExecutable("git", {
      excludedRoots: ["/project"],
      testDeps: {
        platform: "linux",
        pathEnv: "/project",
        existsSyncImpl: (p: string) => files.has(p),
        statSyncImpl: () => ({ isFile: () => true }),
        realpathSyncImpl: (p: string) => p,
      },
    });
    check("[git] 후보가 전부 신뢰 불가 위치뿐이면 EXECUTABLE_SHADOWING_DETECTED", !r.ok && r.code === "EXECUTABLE_SHADOWING_DETECTED");
  }
  {
    const r = resolveTrustedExecutable("git", {
      excludedRoots: [],
      testDeps: { platform: "linux", pathEnv: "", existsSyncImpl: () => false },
    });
    check("[git] PATH가 비어있으면 TRUSTED_EXECUTABLE_NOT_FOUND", !r.ok && r.code === "TRUSTED_EXECUTABLE_NOT_FOUND");
  }
  {
    // symlink escape — 파일 자체는 excludedRoots 밖에 있어도 realpath가 신뢰 불가 위치를 가리키면 거부.
    const files = new Set(["/usr/bin/git"]);
    const r = resolveTrustedExecutable("git", {
      excludedRoots: ["/project"],
      testDeps: {
        platform: "linux",
        pathEnv: "/usr/bin",
        existsSyncImpl: (p: string) => files.has(p),
        statSyncImpl: () => ({ isFile: () => true }),
        realpathSyncImpl: () => "/project/real-git",
      },
    });
    check("[git] symlink realpath가 신뢰 불가 위치를 가리키면 SHADOWING", !r.ok && r.code === "EXECUTABLE_SHADOWING_DETECTED");
  }
  {
    // Windows: .cmd/.bat/.ps1 shim 후보는 shell:false로 안전하게 spawn할 수 없어 건너뛴다.
    const files = new Set(["C:\\nodebin\\claude.cmd", "C:\\other\\claude.exe"]);
    const r = resolveTrustedExecutable("claude", {
      excludedRoots: [],
      testDeps: {
        platform: "win32",
        pathEnv: "C:\\nodebin;C:\\other",
        existsSyncImpl: (p: string) => files.has(p),
        statSyncImpl: () => ({ isFile: () => true }),
        realpathSyncImpl: (p: string) => p,
      },
    });
    check("[claude] .cmd shim 후보는 건너뛰고 .exe 후보를 채택", r.ok && r.spawnCommand === "C:\\other\\claude.exe");
  }
  {
    const files = new Set(["C:\\nodebin\\claude.cmd"]);
    const r = resolveTrustedExecutable("claude", {
      excludedRoots: [],
      testDeps: {
        platform: "win32",
        pathEnv: "C:\\nodebin",
        existsSyncImpl: (p: string) => files.has(p),
        statSyncImpl: () => ({ isFile: () => true }),
      },
    });
    check("[claude] .cmd shim만 있고 다른 후보가 없으면 TRUSTED_EXECUTABLE_NOT_FOUND(셸을 열어 우회하지 않음)", !r.ok && r.code === "TRUSTED_EXECUTABLE_NOT_FOUND");
  }

  // ---- 명시적 override(AUTODEV_TRUSTED_GIT_PATH/AUTODEV_TRUSTED_CLAUDE_PATH) ----
  {
    const r = resolveTrustedExecutable("git", {
      excludedRoots: ["/project"],
      testDeps: {
        platform: "linux",
        pathEnv: "",
        envOverride: { AUTODEV_TRUSTED_GIT_PATH: "/opt/trusted/git" },
        existsSyncImpl: (p: string) => p === "/opt/trusted/git",
        statSyncImpl: () => ({ isFile: () => true }),
        realpathSyncImpl: (p: string) => p,
      },
    });
    check("[override] AUTODEV_TRUSTED_GIT_PATH가 유효하면 채택(explicit_trusted_override)", r.ok && r.trustSource === "explicit_trusted_override" && r.canonicalPath === "/opt/trusted/git");
  }
  {
    const r = resolveTrustedExecutable("git", {
      excludedRoots: ["/project"],
      testDeps: {
        platform: "linux",
        envOverride: { AUTODEV_TRUSTED_GIT_PATH: "/project/git" },
        existsSyncImpl: (p: string) => p === "/project/git",
        statSyncImpl: () => ({ isFile: () => true }),
        realpathSyncImpl: (p: string) => p,
      },
    });
    check("[override] 값 자체를 맹목적으로 신뢰하지 않는다 — excludedRoots 안이면 SHADOWING", !r.ok && r.code === "EXECUTABLE_SHADOWING_DETECTED");
  }
  {
    const r = resolveTrustedExecutable("claude", {
      excludedRoots: [],
      testDeps: { envOverride: { AUTODEV_TRUSTED_CLAUDE_PATH: "/does/not/exist" }, existsSyncImpl: () => false },
    });
    check("[override] 존재하지 않는 경로를 가리키면 TRUSTED_EXECUTABLE_NOT_FOUND", !r.ok && r.code === "TRUSTED_EXECUTABLE_NOT_FOUND");
  }
}

// =========================================================
// SECTION 2 — 실제 이 머신의 PATH/설치를 대상으로 한 해석 전용 테스트(spawn 없음)
// =========================================================
function section2(): void {
  const nodeResult = resolveTrustedExecutable("node", { excludedRoots: [] });
  check(
    "[real] 실제 process.execPath(realpath)로 node 해석 성공",
    nodeResult.ok && existsSync(nodeResult.spawnCommand) && nodeResult.spawnCommand.toLowerCase() === realpathSync(process.execPath).toLowerCase()
  );

  const npmResult = resolveTrustedExecutable("npm", { excludedRoots: [] });
  check("[real] 실제 npm-cli.js 해석 성공(node 옆)", npmResult.ok && existsSync(npmResult.canonicalPath));

  const npxResult = resolveTrustedExecutable("npx", { excludedRoots: [] });
  check("[real] 실제 npx-cli.js 해석 성공(node 옆)", npxResult.ok && existsSync(npxResult.canonicalPath));

  const gitResult = resolveTrustedExecutable("git", { excludedRoots: [] });
  check("[real] 실제 PATH에서 git 해석 성공", gitResult.ok && existsSync(gitResult.canonicalPath));

  // claude — 실제로 실행하지는 않는다(§ 파일 상단). 이 머신에 claude가 설치돼 있지 않을 수도
  // 있으므로 결과가 ok/fail 어느 쪽이든 "구조적으로 타당한" 결과인지만 확인한다.
  const claudeResult = resolveTrustedExecutable("claude", { excludedRoots: [] });
  check(
    "[real] claude 해석 결과가 구조적으로 타당함(성공 시 실제 파일 존재, 실패 시 3개 코드 중 하나)",
    claudeResult.ok
      ? existsSync(claudeResult.canonicalPath)
      : ["TRUSTED_EXECUTABLE_NOT_FOUND", "EXECUTABLE_IDENTITY_UNTRUSTED", "EXECUTABLE_SHADOWING_DETECTED"].includes(claudeResult.code)
  );

  // 실제 PATH 문자열 + 실제 파일 하나를 tmpdir에 심어, "신뢰 불가 위치 안의 진짜 파일"이
  // 여전히 거부됨을 실제 파일시스템으로 증명한다(testDeps.pathEnv만 주입 — 진짜
  // process.env.PATH는 건드리지 않는다).
  const scratch = mkdtempSync(join(tmpdir(), "trust-resolver-real-"));
  try {
    const fakeGitPath = writeMarkerScript(scratch, process.platform === "win32" ? "git.exe" : "git", join(scratch, "MARKER.txt"));
    const realPathEnv = process.env.PATH ?? "";
    const injectedPathEnv = scratch + (process.platform === "win32" ? ";" : ":") + realPathEnv;
    const rShadowed = resolveTrustedExecutable("git", {
      excludedRoots: [scratch],
      testDeps: { pathEnv: injectedPathEnv },
    });
    check(
      "[real] tmpdir에 심은 실제 가짜 git 파일은 excludedRoots(그 tmpdir)로 제외되고, 실제 시스템 git이 대신 채택됨",
      rShadowed.ok && rShadowed.canonicalPath !== fakeGitPath
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// =========================================================
// SECTION 2.5 — 구조적 가드: claude-runner.ts가 "임의 command를 받아 spawn하는" 함수를 더
// 이상 export하지 않고, claude-developer.ts/runClaudeTask()가 항상 trusted.command만
// 쓰는지 소스 텍스트로 확인한다(SI-3.6 bounded review chunk1 HIGH, 4라운드 지적 반영 —
// claude-developer-tests.ts의 기존 "spawnSync/exec가 claude-developer.ts에 직접 없다" 소스
// 스캔 패턴과 동일한 방식). subprocess-runner.ts의 runSubprocessWithTimeout()은 claude 신뢰와
// 무관한 범용 유틸리티라 이 가드 대상이 아니다(§ 그 파일 상단 설명 — exported돼 있어도
// claude 신뢰를 우회하는 지름길이 아니다).
// =========================================================
function sectionStructuralGuards(): void {
  const runnerSrc = readFileSync(join(__dirname, "..", "src", "claude-runner.ts"), "utf-8");
  const developerSrc = readFileSync(join(__dirname, "..", "src", "claude-developer.ts"), "utf-8");

  check(
    "[guard] claude-runner.ts가 execAndClassify를 더 이상 export하지 않음(module-private)",
    !/export\s+(async\s+)?function\s+execAndClassify/.test(runnerSrc)
  );
  check(
    "[guard] claude-developer.ts가 claude-runner.ts에서 execAndClassify를 import하지 않음",
    !/import\s*\{[^}]*\bexecAndClassify\b[^}]*\}\s*from\s*["']\.\/claude-runner["']/.test(developerSrc)
  );
  check(
    "[guard] claude-developer.ts의 유일한 subprocess 실행이 trusted.command를 사용함",
    /runSubprocessWithTimeout\(trusted\.command,/.test(developerSrc)
  );
  check(
    "[guard] runClaudeTask()가 opts.command를 전혀 참조하지 않음(override 채널 완전 제거)",
    !/opts\.command/.test(runnerSrc)
  );
  check(
    "[guard] RunOptions 인터페이스에 command 필드가 없음",
    !/interface RunOptions\s*\{[^}]*\bcommand\s*[?:]/.test(runnerSrc)
  );
}

// =========================================================
// SECTION 3 — safe-executor.ts RUN_COMMAND 실제 파이프라인(spawnSync 포함) marker file 통합 테스트
// =========================================================
const REPO_ROOT = join(__dirname, "..");

function withPrependedPath<T>(dir: string, fn: () => T): T {
  const original = process.env.PATH;
  const delim = process.platform === "win32" ? ";" : ":";
  process.env.PATH = dir + delim + (original ?? "");
  try {
    return fn();
  } finally {
    process.env.PATH = original;
  }
}

async function scenarioGitShadowResistantInRealRunCommand(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "trust-resolver-git-"));
  const fakeDir = mkdtempSync(join(tmpdir(), "trust-resolver-fake-git-"));
  try {
    // 실제 git repo로 초기화한다(신뢰된 git이 실제로 실행돼야 status가 성공하기 때문).
    spawnSync("git", ["init", "-q"], { cwd: root, shell: false });
    spawnSync("git", ["config", "user.email", "a@b.c"], { cwd: root, shell: false });
    spawnSync("git", ["config", "user.name", "t"], { cwd: root, shell: false });

    const markerPath = join(fakeDir, "MARKER.txt");
    writeMarkerScript(fakeDir, process.platform === "win32" ? "git.exe" : "git", markerPath);

    const policy: ProjectExecutionPolicy = {
      allowedReadPrefixes: ["./"],
      allowedWritePrefixes: ["./"],
      allowedCommands: [{ cwd: "root", command: "git", args: ["status", "--short"] }],
    };
    configureSafeExecutor(root, policy);

    const res = await withPrependedPath(fakeDir, () =>
      validateAndExecute({ type: "RUN_COMMAND", command: "git", args: ["status", "--short"], cwd: "root" })
    );

    check("[SECTION3-git] PATH 맨 앞에 가짜 git이 있어도 RUN_COMMAND는 여전히 성공(실제 git 채택)", res.ok);
    check("[SECTION3-git] 가짜 git이 실제로는 실행되지 않음(marker 파일 없음)", !existsSync(markerPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeDir, { recursive: true, force: true });
  }
}

async function scenarioNodeIgnoresPathShadowInRealRunCommand(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "trust-resolver-node-"));
  const fakeDir = mkdtempSync(join(tmpdir(), "trust-resolver-fake-node-"));
  try {
    const markerPath = join(fakeDir, "MARKER.txt");
    writeMarkerScript(fakeDir, process.platform === "win32" ? "node.exe" : "node", markerPath);

    const policy: ProjectExecutionPolicy = {
      allowedReadPrefixes: ["./"],
      allowedWritePrefixes: ["./"],
      allowedCommands: [{ cwd: "root", command: "node", args: ["--version"] }],
    };
    configureSafeExecutor(root, policy);

    const res = await withPrependedPath(fakeDir, () =>
      validateAndExecute({ type: "RUN_COMMAND", command: "node", args: ["--version"], cwd: "root" })
    );

    check("[SECTION3-node] PATH 맨 앞에 가짜 node가 있어도 실제 node --version이 성공(process.execPath 사용)", res.ok);
    check("[SECTION3-node] 가짜 node는 전혀 실행되지 않음(marker 파일 없음)", !existsSync(markerPath));
    const stdout = (res.data as { stdout?: string } | undefined)?.stdout ?? "";
    check("[SECTION3-node] 실제 버전 문자열이 반환됨('v'로 시작)", stdout.trim().startsWith("v"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeDir, { recursive: true, force: true });
  }
}

async function scenarioNpmIgnoresPathShadowInRealRunCommand(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "trust-resolver-npm-"));
  const fakeDir = mkdtempSync(join(tmpdir(), "trust-resolver-fake-npm-"));
  try {
    const markerPath = join(fakeDir, "MARKER.txt");
    writeMarkerScript(fakeDir, process.platform === "win32" ? "npm.cmd" : "npm", markerPath);

    const realMarkerPath = join(root, "REAL_BUILD_MARKER.txt");
    // Windows에서 npm의 package.json scripts는 cmd.exe로 실행되어 중첩 큰따옴표를 제대로
    // 처리하지 못한다(실측 확인) — 경로를 forward-slash로 바꿔 작은따옴표로만 감싼다
    // (Windows fs API는 forward-slash 경로를 그대로 받아들인다).
    const posixStyleMarkerPath = realMarkerPath.split("\\").join("/");
    const buildScript = `node -e "require('fs').writeFileSync('${posixStyleMarkerPath}','ok')"`;
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { build: buildScript } }));

    const policy: ProjectExecutionPolicy = {
      allowedReadPrefixes: ["./"],
      allowedWritePrefixes: ["./"],
      allowedCommands: [{ cwd: "root", command: "npm", args: ["run", "build"] }],
    };
    configureSafeExecutor(root, policy);

    const res = await withPrependedPath(fakeDir, () =>
      validateAndExecute({ type: "RUN_COMMAND", command: "npm", args: ["run", "build"], cwd: "root" })
    );

    check("[SECTION3-npm] PATH 맨 앞에 가짜 npm.cmd가 있어도 실제 npm run build가 성공", res.ok);
    check("[SECTION3-npm] 가짜 npm은 전혀 실행되지 않음(marker 파일 없음)", !existsSync(markerPath));
    check("[SECTION3-npm] 실제 npm이 실제로 build 스크립트를 실행함(진짜 marker 존재)", existsSync(realMarkerPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(fakeDir, { recursive: true, force: true });
  }
}

async function scenarioCwdLocalFakeExecutableIsExcluded(): Promise<void> {
  // cwd 디렉터리 자체가 PATH에도 올라있는 상황(일부 CI/개발 환경에서 실제로 발생)을 재현해,
  // cwd 안에 심어진 가짜 git이 "cwd가 excludedRoots에 포함된다"는 설계로 배제되는지 증명한다.
  const root = mkdtempSync(join(tmpdir(), "trust-resolver-cwdshadow-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root, shell: false });
    spawnSync("git", ["config", "user.email", "a@b.c"], { cwd: root, shell: false });
    spawnSync("git", ["config", "user.name", "t"], { cwd: root, shell: false });

    const markerPath = join(root, "MARKER.txt");
    writeMarkerScript(root, process.platform === "win32" ? "git.exe" : "git", markerPath);

    const policy: ProjectExecutionPolicy = {
      allowedReadPrefixes: ["./"],
      allowedWritePrefixes: ["./"],
      allowedCommands: [{ cwd: "root", command: "git", args: ["status", "--short"] }],
    };
    configureSafeExecutor(root, policy);

    const res = await withPrependedPath(root, () =>
      validateAndExecute({ type: "RUN_COMMAND", command: "git", args: ["status", "--short"], cwd: "root" })
    );

    check("[SECTION3-cwd] cwd 자체가 PATH에 있어도 cwd 안의 가짜 git은 배제되고 실제 git이 채택됨", res.ok);
    check("[SECTION3-cwd] cwd 안의 가짜 git이 실행되지 않음(marker 파일 없음)", !existsSync(markerPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioSymlinkEscapeIsRejectedIfPermitted(): Promise<void> {
  // SI-3.6 bounded review(chunk2 HIGH) 지적 반영 — 이전 버전은 symlink 자체를 excludedRoots
  // 안(project root)에 두고 대상을 excludedRoots 밖에 둬서, "candidate 경로 자체가 이미
  // 신뢰 불가 위치"라는 lexical 검사만으로도 거부되는 시나리오였다(realpath 재검증을 전혀
  // 시험하지 않음). 이번에는 정반대로 구성한다 — symlink 자체는 신뢰되는(excludedRoots 밖)
  // PATH 디렉터리 안에 두고, 그 symlink의 실제 대상만 excludedRoots 안에 두어, "겉보기
  // 위치는 신뢰되지만 realpath로 재확인하면 신뢰 불가 위치를 가리킨다"는 것을 증명한다.
  // safe-executor.ts의 RUN_COMMAND 전체 파이프라인(project root/cwd 자동 배제) 대신
  // resolveTrustedExecutable()을 직접 호출해 excludedRoots를 이 시나리오에 필요한 값
  // (excludedDir 하나)만으로 명시적으로 통제한다 — trustedLookingDir이 실제로는 OS temp
  // 하위에 있어도, 이 호출 하나에 한해 "신뢰되는 PATH 위치"로 취급된다(실제 PATH 탐색
  // 코드와 real symlink를 그대로 쓰되, 무엇이 배제 대상인지만 테스트가 통제).
  const trustedLookingDir = mkdtempSync(join(tmpdir(), "trust-resolver-symlink-trusted-"));
  const excludedDir = mkdtempSync(join(tmpdir(), "trust-resolver-symlink-excluded-"));
  try {
    const markerPath = join(excludedDir, "MARKER.txt");
    const realFakeGit = writeMarkerScript(excludedDir, process.platform === "win32" ? "git.exe" : "git", markerPath);

    const linkName = process.platform === "win32" ? "git.exe" : "git";
    const linkPath = join(trustedLookingDir, linkName);
    try {
      symlinkSync(realFakeGit, linkPath, process.platform === "win32" ? "file" : undefined);
    } catch (e) {
      // SI-3.6 bounded review(chunk2 MEDIUM) 지적 반영 — 권한/플랫폼 정책 오류(EPERM/EACCES)만
      // SKIP한다 — 그 밖의 오류(잘못된 인자, 경로 처리 회귀 등)는 삼키지 않고 그대로 던져
      // 실제 결함을 FAIL로 드러낸다.
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        skip(`[SECTION3-symlink] symlink 생성 권한 없음(${code}) — 이 환경에서는 SKIP`);
        return;
      }
      throw e;
    }

    const result = resolveTrustedExecutable("git", {
      excludedRoots: [excludedDir],
      testDeps: { pathEnv: trustedLookingDir },
    });

    check(
      "[SECTION3-symlink] 신뢰되는 위치의 symlink가 실제로는 배제 대상(excludedDir)을 가리키면 SHADOWING으로 거부됨",
      !result.ok && result.code === "EXECUTABLE_SHADOWING_DETECTED"
    );
    check("[SECTION3-symlink] 가짜 git이 실제로 실행되지 않음(marker 파일 없음)", !existsSync(markerPath));
  } finally {
    rmSync(trustedLookingDir, { recursive: true, force: true });
    rmSync(excludedDir, { recursive: true, force: true });
  }
}

async function scenarioTrustedTscRealExecution(): Promise<void> {
  // 이 저장소 자신이 devDependency로 typescript를 갖고 있으므로, 별도 fixture를 만들지 않고
  // 실제 repo root를 project root로 삼아 "project-local devDependency로서의 tsc" 신뢰 경로를
  // 실제로 검증한다(§ resolveTrustedTsc — self-dev-complete.ts TSC_BIN과 동일 패턴 재사용).
  const tscBin = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tscBin)) {
    skip("[SECTION3-tsc] 이 저장소에 node_modules/typescript/bin/tsc가 없음 — SKIP(설치 문제로 별도 조사 필요)");
    return;
  }
  const policy: ProjectExecutionPolicy = {
    allowedReadPrefixes: ["./"],
    allowedWritePrefixes: ["./"],
    allowedCommands: [{ cwd: "root", command: "tsc", args: ["--version"] }],
  };
  configureSafeExecutor(REPO_ROOT, policy);
  const res = await validateAndExecute({ type: "RUN_COMMAND", command: "tsc", args: ["--version"], cwd: "root" });
  const stdout = (res.data as { stdout?: string } | undefined)?.stdout ?? "";
  check("[SECTION3-tsc] project-local devDependency tsc가 실제로 실행되어 성공", res.ok);
  check("[SECTION3-tsc] 실제 tsc 버전 문자열이 반환됨", /Version\s+\d/.test(stdout));
}

async function scenarioTrustedNpxRealExecution(): Promise<void> {
  // SI-3.6 bounded review(chunk2 HIGH) 지적 반영 — node/git/npm/tsc는 이미 실제 RUN_COMMAND
  // 실행 성공까지 증명하지만 npx는 resolver 단계(파일 존재 확인)까지만 검증됐다 — npx-cli.js
  // prefix/인자 배선이나 safe-executor 배선이 잘못돼 실제 실행이 과잉 차단돼도 그 결함을
  // 잡지 못했다. 이 저장소 자신이 devDependency로 typescript를 갖고 있으므로(§ 위 tsc 실행
  // 시나리오와 동일한 근거), network 접근 없이 "npx tsc --version"이 실제로 성공하는지
  // 검증한다 — NPX_ALLOWED_PACKAGE_NAMES가 "tsc"만 허용하므로 그 형태 그대로 쓴다.
  const tscBin = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tscBin)) {
    skip("[SECTION3-npx] 이 저장소에 node_modules/typescript/bin/tsc가 없음 — SKIP(설치 문제로 별도 조사 필요)");
    return;
  }
  const policy: ProjectExecutionPolicy = {
    allowedReadPrefixes: ["./"],
    allowedWritePrefixes: ["./"],
    allowedCommands: [{ cwd: "root", command: "npx", args: ["tsc", "--version"] }],
  };
  configureSafeExecutor(REPO_ROOT, policy);
  const res = await validateAndExecute({ type: "RUN_COMMAND", command: "npx", args: ["tsc", "--version"], cwd: "root" });
  const stdout = (res.data as { stdout?: string } | undefined)?.stdout ?? "";
  check("[SECTION3-npx] 신뢰된 npx-cli.js를 통해 project-local tsc가 실제로 실행되어 성공", res.ok);
  check("[SECTION3-npx] 실제 tsc 버전 문자열이 반환됨(npx 배선이 과잉 차단하지 않음)", /Version\s+\d/.test(stdout));
}

async function scenarioTscMissingFailsClosed(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "trust-resolver-notsc-"));
  try {
    const policy: ProjectExecutionPolicy = {
      allowedReadPrefixes: ["./"],
      allowedWritePrefixes: ["./"],
      allowedCommands: [{ cwd: "root", command: "tsc", args: ["--version"] }],
    };
    configureSafeExecutor(root, policy);
    const res = await validateAndExecute({ type: "RUN_COMMAND", command: "tsc", args: ["--version"], cwd: "root" });
    check("[SECTION3-tsc-missing] node_modules/typescript가 없는 project에서 tsc는 fail-closed로 거부됨", !res.ok);
    check(
      "[SECTION3-tsc-missing] denyReason에 Executable Identity Trust 코드가 포함됨",
      !res.ok && typeof res.denyReason === "string" && res.denyReason.includes("TRUSTED_EXECUTABLE_NOT_FOUND")
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioTscSpoofedPackageWithoutLockfileFailsClosed(): Promise<void> {
  // SI-3.6 bounded review(chunk1 HIGH, 2라운드) 지적 반영 — 악성 project가 { name:
  // "typescript" }만 자칭하는 node_modules/typescript/package.json과 임의 코드가 담긴
  // bin/tsc를 함께 심어도, package-lock.json에 버전이 일치하는 typescript 항목이 없으면
  // 실행되지 않는다는 것을 marker 파일로 직접 증명한다.
  const root = mkdtempSync(join(tmpdir(), "trust-resolver-tsc-spoof-"));
  try {
    const tscDir = join(root, "node_modules", "typescript", "bin");
    mkdirSync(tscDir, { recursive: true });
    const markerPath = join(root, "MALICIOUS_TSC_MARKER.txt");
    writeMarkerScript(tscDir, "tsc", markerPath);
    writeFileSync(join(root, "node_modules", "typescript", "package.json"), JSON.stringify({ name: "typescript", version: "9.9.9" }));
    // package-lock.json 자체를 아예 만들지 않는다 — legitimate npm install/ci를 거치지 않은
    // project를 흉내낸다.

    const policy: ProjectExecutionPolicy = {
      allowedReadPrefixes: ["./"],
      allowedWritePrefixes: ["./"],
      allowedCommands: [{ cwd: "root", command: "tsc", args: ["--version"] }],
    };
    configureSafeExecutor(root, policy);
    const res = await validateAndExecute({ type: "RUN_COMMAND", command: "tsc", args: ["--version"], cwd: "root" });

    check("[SECTION3-tsc-spoof] package-lock.json 없이 name만 자칭한 typescript는 거부됨", !res.ok);
    check(
      "[SECTION3-tsc-spoof] denyReason에 EXECUTABLE_IDENTITY_UNTRUSTED가 포함됨",
      !res.ok && typeof res.denyReason === "string" && res.denyReason.includes("EXECUTABLE_IDENTITY_UNTRUSTED")
    );
    check("[SECTION3-tsc-spoof] 악성 tsc가 실제로 실행되지 않음(marker 파일 없음)", !existsSync(markerPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioTscVersionMismatchFailsClosed(): Promise<void> {
  // package-lock.json은 있지만 실제 설치된 package.json.version과 lock에 기록된 version이
  // 다르면(변조/불일치) 거부되는지 증명한다.
  const root = mkdtempSync(join(tmpdir(), "trust-resolver-tsc-vermismatch-"));
  try {
    const tscDir = join(root, "node_modules", "typescript", "bin");
    mkdirSync(tscDir, { recursive: true });
    const markerPath = join(root, "MALICIOUS_TSC_MARKER.txt");
    writeMarkerScript(tscDir, "tsc", markerPath);
    writeFileSync(join(root, "node_modules", "typescript", "package.json"), JSON.stringify({ name: "typescript", version: "1.0.0" }));
    writeFileSync(
      join(root, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "node_modules/typescript": {
            version: "5.7.0", // 설치된 1.0.0과 의도적으로 불일치
            resolved: "https://registry.npmjs.org/typescript/-/typescript-5.7.0.tgz",
            integrity: "sha512-" + "a".repeat(88),
          },
        },
      })
    );

    const policy: ProjectExecutionPolicy = {
      allowedReadPrefixes: ["./"],
      allowedWritePrefixes: ["./"],
      allowedCommands: [{ cwd: "root", command: "tsc", args: ["--version"] }],
    };
    configureSafeExecutor(root, policy);
    const res = await validateAndExecute({ type: "RUN_COMMAND", command: "tsc", args: ["--version"], cwd: "root" });

    check("[SECTION3-tsc-vermismatch] 설치 버전과 lockfile 버전이 다르면 거부됨", !res.ok);
    check("[SECTION3-tsc-vermismatch] 가짜 tsc가 실행되지 않음(marker 파일 없음)", !existsSync(markerPath));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function scenarioClaudeRunnerResolutionDoesNotSpawn(): Promise<void> {
  // SI-3.6 bounded review(chunk2 HIGH, 3라운드) 지적 반영 — 소스 텍스트 검사(trusted-executable-
  // resolver.ts에 child_process import가 없음)는 정작 resolveTrustedClaudeCommand()가 정의된
  // claude-runner.ts를 검사하지 않아 대상이 잘못됐었다는 지적을 받아들여, 대신 실제 실행 경계
  // 자체를 spy로 감시하는 플랫폼 독립적 방식으로 교체한다 — subprocess-runner.ts의
  // runSubprocessWithTimeout(claude-runner.ts의 execAndClassify/callClaude가 실제 spawn을
  // 수행할 때 거치는 유일한 진입점, § subprocess-runner.ts 상단 설명)을 이 테스트 동안만 호출
  // 횟수를 세는 spy로 교체하고, resolveTrustedClaudeCommand()를 실제로 호출한 뒤 spy 호출
  // 횟수가 정확히 0인지 assertion한다 — marker 파일 형식/실행 가능 여부에 전혀 의존하지 않는다
  // (TS로 컴파일된 named import는 module 객체 속성 접근으로 컴파일되므로, claude-runner.ts가
  // import한 참조도 이 시점에는 이미 spy를 가리킨다 — safe-executor.ts의 PROJECT_ROOT
  // 재-export가 이미 같은 컴파일 특성에 의존하는 것과 동일한 근거).
  const spyModule = subprocessRunnerModule as unknown as Record<string, unknown>;
  const originalRunSubprocessWithTimeout = subprocessRunnerModule.runSubprocessWithTimeout;
  let spyCallCount = 0;
  spyModule.runSubprocessWithTimeout = (...args: Parameters<typeof originalRunSubprocessWithTimeout>) => {
    spyCallCount++;
    return originalRunSubprocessWithTimeout(...args);
  };

  // homedir() 하위(OneDrive 동기화 대상인 REPO_ROOT의 상위 Desktop 폴더를 피함)를 쓴다 —
  // cwd(REPO_ROOT)/tmpdir() 어느 쪽의 하위도 아니라 resolveTrustedClaudeCommand()의 자동
  // excludedRoots에 걸리지 않는다. 이 파일이 실제로 실행 가능한 형식인지는 이제 무의미하다
  // (spy가 직접 호출 여부를 세므로 marker 실행 성공/실패와 무관).
  const scratch = join(homedir(), `.si36-test-scratch-${process.pid}`);
  mkdirSync(scratch, { recursive: true });
  const originalOverride = process.env.AUTODEV_TRUSTED_CLAUDE_PATH;
  try {
    const markerExePath = writeMarkerScript(scratch, process.platform === "win32" ? "claude.exe" : "claude", join(scratch, "MARKER.txt"));
    process.env.AUTODEV_TRUSTED_CLAUDE_PATH = markerExePath;

    const result = resolveTrustedClaudeCommand();

    check(
      "[claude-runner] resolveTrustedClaudeCommand()가 cwd/tmpdir 밖의 override를 정확히 식별함(canonicalPath 일치)",
      result.ok && result.command.toLowerCase() === markerExePath.toLowerCase()
    );
    check(
      "[claude-runner] resolveTrustedClaudeCommand() 호출 중 subprocess 실행 경계(spy)가 정확히 0회 호출됨",
      spyCallCount === 0
    );
  } finally {
    spyModule.runSubprocessWithTimeout = originalRunSubprocessWithTimeout;
    if (originalOverride === undefined) delete process.env.AUTODEV_TRUSTED_CLAUDE_PATH;
    else process.env.AUTODEV_TRUSTED_CLAUDE_PATH = originalOverride;
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  section1();
  section2();
  sectionStructuralGuards();
  await scenarioGitShadowResistantInRealRunCommand();
  await scenarioNodeIgnoresPathShadowInRealRunCommand();
  await scenarioNpmIgnoresPathShadowInRealRunCommand();
  await scenarioCwdLocalFakeExecutableIsExcluded();
  await scenarioSymlinkEscapeIsRejectedIfPermitted();
  await scenarioTrustedTscRealExecution();
  await scenarioTrustedNpxRealExecution();
  await scenarioTscMissingFailsClosed();
  await scenarioTscSpoofedPackageWithoutLockfileFailsClosed();
  await scenarioTscVersionMismatchFailsClosed();
  await scenarioClaudeRunnerResolutionDoesNotSpawn();

  console.log("\n=== Trusted Executable Resolver 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  const failCount = results.filter((r) => r.startsWith("[FAIL]")).length;
  const skipCount = results.filter((r) => r.startsWith("[SKIP]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, SKIP ${skipCount}, FAIL ${failCount}`);
  if (failCount > 0) process.exitCode = 1;
}

main();
