import { readFileSync, writeFileSync, renameSync, mkdtempSync, rmSync, lstatSync, readdirSync, openSync, fsyncSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, sep } from "node:path";
import type { RequiredTestCommand } from "./task-registry";
import { log } from "./logger";
import { scanContentForSecrets } from "./secret-scanner";

// AutoDev / JARVIS Unattended Continuous Development Reliability Hardening — Phase 3/4.
//
// Task 1.2/1.3/1.4가 반복해서 노출한 구조적 문제: task-registry.ts가
// "npm run test:X"를 requiredTests로 선언했는데 package.json에 그 스크립트가 등록돼
// 있지 않으면, Claude Developer는 이미 구현을 끝냈는데도 "필수 테스트 실패"로만
// 관측되고 그 원인(스크립트 미등록)을 스스로 고칠 수 없다(package.json이 대부분의
// Task allowedPathPrefixes 밖이기 때문). 그 결과 GPT Reviewer가 REVISE를 반복하다
// reviewCycle이 소진되어 WAITING_HUMAN에 도달한다 — 이는 구현 실패가 아니라 인프라
// 설정 문제이므로, Claude Developer/Reviewer를 부르기 전에 결정론적으로 먼저
// 걸러낸다(§ REQUIRED_TEST_CONFIGURATION_ERROR).
//
// 이 파일은 어떤 project를 다루는지 모른다 — projectRoot/allowedPathPrefixes/
// requiredTests는 전부 호출부(autodev.ts)가 task-registry.ts 데이터로부터 그대로
// 넘긴다. package.json 자체를 실행하거나 npm을 spawn하지 않는다 — fs로 읽고
// 파싱해서 "scripts.<name>이 존재하는가"만 판정한다(dependency-scanner.ts가 이미
// 쓰는 것과 동일한 direct fs 신뢰 수준).

export interface RequiredTestConfigIssue {
  requiredTestName: string;
  npmScript: string;
}

export interface RequiredTestPreflightResult {
  ok: boolean;
  issues: RequiredTestConfigIssue[];
  /** requiredTest.cwd가 "root"가 아니어서(task-registry.ts 전체가 현재 전부 "root"만
   *  쓰지만, 이 파일은 그 전제를 강제하지 않는다) 이번 preflight가 검증하지 않은
   *  required test 이름 — 실패가 아니라 "검증 대상 밖"이라는 뜻이다. */
  skippedUnsupportedCwd: string[];
}

/** RequiredTestCommand가 "npm run <script>" 형태일 때만 그 script 이름을 반환한다.
 *  gradlew/npx/"npm test -- ..." 등 다른 형태는 이 preflight의 대상이 아니다 — 그런
 *  형태에는 package.json.scripts 등록이라는 개념 자체가 적용되지 않는다. */
export function extractNpmRunScript(rt: RequiredTestCommand): string | undefined {
  if (rt.command !== "npm") return undefined;
  if (!Array.isArray(rt.args) || rt.args.length < 2) return undefined;
  if (rt.args[0] !== "run") return undefined;
  const script = rt.args[1];
  return typeof script === "string" && script.length > 0 ? script : undefined;
}

type PackageJsonScriptsResult =
  | { ok: true; scripts: Record<string, unknown> }
  | { ok: false; reason: string };

export function readPackageJsonScripts(projectRoot: string): PackageJsonScriptsResult {
  const pkgPath = join(projectRoot, "package.json");
  let raw: string;
  try {
    raw = readFileSync(pkgPath, "utf-8");
  } catch (e) {
    return { ok: false, reason: `package.json을 읽을 수 없음: ${e instanceof Error ? e.message : String(e)}` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "package.json JSON 파싱 실패" };
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { ok: false, reason: "package.json 형식이 object가 아님" };
  }
  const scripts = (json as Record<string, unknown>).scripts;
  if (scripts === undefined) return { ok: true, scripts: {} };
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    return { ok: false, reason: "package.json scripts 필드가 object가 아님" };
  }
  return { ok: true, scripts: scripts as Record<string, unknown> };
}

/**
 * Claude Developer/GPT Reviewer를 부르기 전에 호출한다(§ Phase 3). requiredTests 중
 * "npm run X" 형태인 것만 package.json.scripts에 X가 등록돼 있는지 확인한다 — 이
 * 함수는 npm/node/claude 어떤 프로세스도 spawn하지 않는다(순수 fs read + JSON parse).
 */
export function checkRequiredTestScriptRegistration(
  requiredTests: RequiredTestCommand[] | undefined,
  projectRoot: string
): RequiredTestPreflightResult {
  if (!requiredTests || requiredTests.length === 0) {
    return { ok: true, issues: [], skippedUnsupportedCwd: [] };
  }
  const pkg = readPackageJsonScripts(projectRoot);
  if (!pkg.ok) {
    // package.json 자체를 읽을 수 없으면 그 안의 어떤 npm run required test도 검증할
    // 수 없다 — 이미 그 자체로 인프라 문제이므로, npm run 형태인 required test 전부를
    // issue로 보고한다(조용히 PASS로 넘기지 않는다).
    log("REQUIRED_TEST_CONFIGURATION package.json 읽기 실패", { projectRoot, reason: pkg.reason });
    const issues: RequiredTestConfigIssue[] = [];
    for (const rt of requiredTests) {
      const script = extractNpmRunScript(rt);
      if (script) issues.push({ requiredTestName: rt.name, npmScript: script });
    }
    return { ok: issues.length === 0, issues, skippedUnsupportedCwd: [] };
  }
  const issues: RequiredTestConfigIssue[] = [];
  const skippedUnsupportedCwd: string[] = [];
  for (const rt of requiredTests) {
    const script = extractNpmRunScript(rt);
    if (!script) continue;
    if (rt.cwd !== "root") {
      skippedUnsupportedCwd.push(rt.name);
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(pkg.scripts, script)) {
      issues.push({ requiredTestName: rt.name, npmScript: script });
    }
  }
  return { ok: issues.length === 0, issues, skippedUnsupportedCwd };
}

// AutoDev / JARVIS Unattended Continuous Development Reliability Hardening Phase 5 —
// Stale REQUIRED_TEST_CONFIGURATION_ERROR WAITING_HUMAN Reconciliation.
//
// checkRequiredTestScriptRegistration()이 예전(이 Phase 5 이전) 실행에서 "npm script
// 미등록"을 이유로 state.deferredHumanTasks에 남긴 고정 템플릿 문자열을 다시 파싱해, 그
// 사유가 *지금도* 유효한지 재확인한다. 사람의 판단이 필요한 다른 어떤 사유(SECURITY_BLOCKED/
// REVIEW_CYCLE_EXHAUSTED/REVIEW_BLOCKED/CHECKPOINT_SCOPE_VIOLATION/HUMAN_FINAL_REVIEW_PENDING/
// AUDIT_STORE_UNAVAILABLE_BEFORE_CHECKPOINT/REMOTE_GIT_CHANGED_DURING_RUN 등)는 이 정규식과
// 전혀 다른 문자열이므로 매칭되지 않는다 — 배열 안에 이 형태가 아닌 항목이 단 하나라도 섞여
// 있으면 fail-closed로 전체를 "해소되지 않음"으로 취급한다(어떤 실제 사람 판단 필요 상태도
// 이 재검사로 조용히 해제되지 않는다).
const REQUIRED_TEST_CONFIG_ERROR_ENTRY_PATTERN = /^REQUIRED_TEST_CONFIGURATION_ERROR: task=\S+ requiredTest=\S+ missingScript=(\S+)$/;

export interface StaleRequiredTestConfigReconciliation {
  /** true면 deferredHumanTasks 전체가 REQUIRED_TEST_CONFIGURATION_ERROR 형태였고, 그
   *  각각이 가리키는 npm script가 지금은 전부 package.json에 등록돼 있다 — 호출부가
   *  안전하게 WAITING_HUMAN을 해제하고 이 배열을 비울 수 있다. */
  resolved: boolean;
}

/** state.status==="WAITING_HUMAN"이고 state.humanFinalReview가 없을 때만 호출한다(그 gate는
 *  이 함수가 전혀 모르는 별도의, 사람의 명시적 승인이 필요한 상태다 — 호출부가 그 조건을
 *  먼저 확인해야 한다). npm/claude 어떤 프로세스도 spawn하지 않는 순수 fs 판정이다. */
export function reconcileStaleRequiredTestConfigurationTasks(
  deferredHumanTasks: readonly string[],
  projectRoot: string
): StaleRequiredTestConfigReconciliation {
  if (deferredHumanTasks.length === 0) return { resolved: false };
  const scripts: string[] = [];
  for (const entry of deferredHumanTasks) {
    const m = REQUIRED_TEST_CONFIG_ERROR_ENTRY_PATTERN.exec(entry);
    if (!m) return { resolved: false };
    scripts.push(m[1]);
  }
  const pkg = readPackageJsonScripts(projectRoot);
  if (!pkg.ok) return { resolved: false };
  const allRegistered = scripts.every((s) => Object.prototype.hasOwnProperty.call(pkg.scripts, s));
  return { resolved: allRegistered };
}

const IGNORED_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build"]);
const CANDIDATE_TEST_FILE_SUFFIX = ".test.mjs";

/** allowedPathPrefixes 아래에서 "*.test.mjs" 후보 파일을 찾는다. symlink는 따라가지
 *  않는다(§ filesystem-trust-model.md와 동일한 원칙 — 이 파일도 신뢰 경계를 넓히지
 *  않는다). 재귀 깊이는 안전하게 제한한다. */
function findCandidateTestFiles(projectRoot: string, allowedPathPrefixes: string[]): string[] {
  const found = new Set<string>();
  const MAX_DEPTH = 8;

  function walk(absDir: string, depth: number): void {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORED_DIR_NAMES.has(entry)) continue;
      const absPath = join(absDir, entry);
      let st;
      try {
        st = lstatSync(absPath);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(absPath, depth + 1);
      } else if (st.isFile() && entry.endsWith(CANDIDATE_TEST_FILE_SUFFIX)) {
        found.add(absPath);
      }
    }
  }

  for (const prefix of allowedPathPrefixes) {
    const absPrefixDir = join(projectRoot, prefix);
    let st;
    try {
      st = lstatSync(absPrefixDir);
    } catch {
      continue;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue;
    walk(absPrefixDir, 0);
  }
  return [...found];
}

export interface RequiredTestScriptRepairResult {
  /** 정확히 하나의 후보 파일을 찾아 안전하게 package.json에 등록한 항목. */
  repaired: (RequiredTestConfigIssue & { expectedScript: string })[];
  /** 후보가 0개(아직 구현되지 않음) 또는 2개 이상(모호함)이라 자동 등록하지 않은 항목. */
  unresolved: RequiredTestConfigIssue[];
}

/**
 * Phase 4 — Safe deterministic self-recovery. 오직 "이 issue의 npm script 이름에
 * 대응하는 *.test.mjs 파일이 이 task의 allowedPathPrefixes 안에 정확히 하나만
 * 존재한다"는 조건에서만 package.json.scripts에 그 파일을 가리키는 항목을 추가한다.
 * 후보가 없거나(아직 구현 전) 여럿이면(모호함) 아무것도 쓰지 않고 unresolved로
 * 분류한다 — 어떤 경우에도 파일명을 추측해서 만들어내지 않는다. 기존 scripts 항목은
 * 절대 덮어쓰지 않는다(이미 등록된 값과 다르더라도 건드리지 않고 unresolved로 남긴다
 * — "이미 등록돼 있던 값을 조용히 바꾸지 않는다").
 */
export function attemptSafeRequiredTestScriptRepair(
  issues: RequiredTestConfigIssue[],
  projectRoot: string,
  allowedPathPrefixes: string[]
): RequiredTestScriptRepairResult {
  const repaired: (RequiredTestConfigIssue & { expectedScript: string })[] = [];
  const unresolved: RequiredTestConfigIssue[] = [];
  if (issues.length === 0) return { repaired, unresolved };

  const candidates = findCandidateTestFiles(projectRoot, allowedPathPrefixes);

  for (const issue of issues) {
    if (candidates.length !== 1) {
      unresolved.push(issue);
      continue;
    }
    const relPath = relative(projectRoot, candidates[0]).split(sep).join("/");
    repaired.push({ ...issue, expectedScript: `node ${relPath}` });
  }

  if (repaired.length === 0) return { repaired, unresolved };

  const pkgPath = join(projectRoot, "package.json");
  const raw = readFileSync(pkgPath, "utf-8");
  const json = JSON.parse(raw) as Record<string, unknown>;
  const scripts = (json.scripts && typeof json.scripts === "object" && !Array.isArray(json.scripts)
    ? (json.scripts as Record<string, unknown>)
    : {}) as Record<string, unknown>;

  const actuallyRepaired: (RequiredTestConfigIssue & { expectedScript: string })[] = [];
  for (const r of repaired) {
    if (Object.prototype.hasOwnProperty.call(scripts, r.npmScript)) {
      // 이미 다른 값으로 등록돼 있었다면(경합) 조용히 덮어쓰지 않는다 — unresolved로
      // 되돌린다(§ 기존 등록값을 절대 덮어쓰지 않는다).
      unresolved.push({ requiredTestName: r.requiredTestName, npmScript: r.npmScript });
      continue;
    }
    scripts[r.npmScript] = r.expectedScript;
    actuallyRepaired.push(r);
  }
  json.scripts = scripts;

  if (actuallyRepaired.length > 0) {
    const serialized = JSON.stringify(json, null, 2) + "\n";
    // Deterministic Secret Scanner Gate를 이 write에도 그대로 적용한다(§ CLAUDE.md — commit
    // 대상 내용은 어디서든 이 게이트를 통과해야 한다). 이 write가 실제로 추가하는 값은 항상
    // "node <이미 디스크에 존재하는 파일의 상대경로>" 형태뿐이지만, 어떤 project data도
    // 예외로 두지 않는다.
    const secretFindings = scanContentForSecrets(serialized, "package.json");
    if (secretFindings.length > 0) {
      log("REQUIRED_TEST_CONFIGURATION 자동 복구 BLOCK — package.json 갱신 내용에서 secret 패턴 감지", {
        findingKinds: secretFindings.map((f) => f.kind),
      });
      return {
        repaired: [],
        unresolved: [...unresolved, ...actuallyRepaired.map((r) => ({ requiredTestName: r.requiredTestName, npmScript: r.npmScript }))],
      };
    }
    // same-directory temp + atomic rename(§ filesystem-trust-model.md와 동일한 패턴).
    const tmpDir = mkdtempSync(join(projectRoot, ".autodev-pkg-repair-"));
    const tmpPath = join(tmpDir, "package.json.tmp");
    try {
      writeFileSync(tmpPath, serialized, "utf-8");
      const fd = openSync(tmpPath, "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmpPath, pkgPath);
      log("REQUIRED_TEST_CONFIGURATION 자동 복구 — package.json scripts 등록", {
        repaired: actuallyRepaired.map((r) => ({ npmScript: r.npmScript, expectedScript: r.expectedScript })),
      });
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup — temp dir 잔존은 안전(다음 실행에 영향 없음).
      }
    }
  }

  return { repaired: actuallyRepaired, unresolved };
}

function runGit(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd, shell: false, encoding: "utf-8" });
  return { ok: res.status === 0, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

export interface RequiredTestScriptRepairCommitResult {
  ok: boolean;
  commitHash?: string;
  reason?: string;
}

/**
 * attemptSafeRequiredTestScriptRepair()가 만든 package.json 변경을 그 즉시 별도 commit으로
 * 확정한다(§ Phase 11 — 인프라 수정과 Task 자신의 구현 commit을 절대 섞지 않는다). 이
 * commit을 만들지 않고 그대로 두면, package.json이 uncommitted 상태로 남아 있다가 이어지는
 * Task의 checkpoint가 "allowedPathPrefixes 밖 예상치 못한 변경"으로 이 파일을 발견하고
 * BLOCK한다(checkpoint.ts의 기존 scope-violation 방어 — 실제로 회귀 테스트에서 확인됨).
 * package.json 외에 다른 파일이 함께 staged되면(동시에 다른 프로세스가 손댔을 가능성)
 * 절대 그대로 commit하지 않고 index를 reset한 뒤 실패를 반환한다(§ commitProjectStateOnly와
 * 동일한 원칙 — checkpoint.ts).
 */
export function commitRequiredTestScriptRepair(
  projectRoot: string,
  repaired: (RequiredTestConfigIssue & { expectedScript: string })[]
): RequiredTestScriptRepairCommitResult {
  if (repaired.length === 0) return { ok: true };

  const addRes = runGit(["add", "--", "package.json"], projectRoot);
  if (!addRes.ok) return { ok: false, reason: `git add(package.json) 실패: ${addRes.stderr}` };

  const stagedRes = runGit(["diff", "--cached", "--name-only"], projectRoot);
  const staged = stagedRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (staged.length === 0) {
    // package.json이 실질적으로 바뀌지 않았다(예: 이미 동일 내용으로 다른 프로세스가 먼저
    // commit함) — 정상.
    return { ok: true };
  }
  if (staged.length !== 1 || staged[0] !== "package.json") {
    runGit(["reset"], projectRoot);
    return { ok: false, reason: `package.json 외 다른 파일이 함께 staged됨(index reset됨): ${staged.join(", ")}` };
  }

  const message =
    `fix: register canonical required test script(s)\n\n` +
    repaired.map((r) => `- ${r.npmScript}: ${r.expectedScript}`).join("\n") +
    `\n\nAutoDev required-test configuration preflight가 이미 존재하는 구현 산출물(*.test.mjs)에 ` +
    `대응하는 npm script가 package.json에 등록되지 않은 것을 감지해 자동으로 등록했습니다.`;
  const commitRes = runGit(["commit", "-m", message], projectRoot);
  if (!commitRes.ok) {
    runGit(["reset"], projectRoot);
    return { ok: false, reason: `git commit(package.json) 실패(index reset됨): ${commitRes.stderr}` };
  }
  const hashRes = runGit(["rev-parse", "HEAD"], projectRoot);
  log("REQUIRED_TEST_CONFIGURATION 자동 복구 commit 생성", {
    commitHash: hashRes.ok ? hashRes.stdout : undefined,
    repaired: repaired.map((r) => r.npmScript),
  });
  return { ok: true, commitHash: hashRes.ok ? hashRes.stdout : undefined };
}

// AutoDev / JARVIS Unattended Continuous Development Reliability Hardening Phase 8 —
// Developer-declared Required Test Registration Channel.
//
// 위 attemptSafeRequiredTestScriptRepair()는 allowedPathPrefixes 안에 후보 *.test.mjs가
// "정확히 하나"일 때만 자동 등록한다 — 후보가 모호하거나(여러 개) Developer가 다른 확장자/
// 위치를 선택했다면 그 glob 기반 추측은 안전하게 포기하고 unresolved로 남긴다. 이 섹션은
// 그 보완 채널이다: Developer가 TASK_COMPLETE 응답에 명시적으로 "이 npm script를 이 파일에
// 등록해달라"(ClaudeResult.requiredTestRegistrations)고 선언하면, 그 요청을 절대 그대로
// 신뢰하지 않고 아래 validateRequiredTestRegistrationRequest()가 전부 검증한 것만
// registerValidatedRequiredTestScripts()가 등록한다. Developer는 여전히 package.json을
// 직접 쓸 수 없다 — "요청"만 반환하고, 실제 mutation은 이 파일(AutoDev infrastructure)이
// 수행한다.

export interface RequiredTestRegistrationRequest {
  scriptName: string;
  runner: string;
  target: string;
}

export type RequiredTestRegistrationValidation =
  | { ok: true; expectedScript: string; canonicalRequiredTestName: string }
  | { ok: false; reason: string };

// 허용되는 실행기는 기존 JARVIS/AutoDev required-test convention이 실제로 쓰는 형태로만
// 제한한다(§ 요구사항 9) — package.json의 모든 기존 required-test script가 "node <path>"
// 형태다(§ CANDIDATE_TEST_FILE_SUFFIX 기반 glob 복구가 만드는 값과 동일). 다른 실행기는
// 이 채널에서 등록할 수 없다(새 위험한 실행 형태를 열지 않는다).
const ALLOWED_TEST_RUNNERS: ReadonlySet<string> = new Set(["node"]);

// npm/yarn lifecycle hook 이름 — scriptName이 canonical requiredTests 목록에 정확히
// 일치해야 한다는 검증만으로도 구조적으로 막히지만(task-registry.ts가 이런 이름을 절대
// requiredTests로 선언하지 않는다), 방어적으로 한 번 더 명시적으로 거부한다.
const FORBIDDEN_LIFECYCLE_SCRIPT_NAMES: ReadonlySet<string> = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "preversion",
  "version",
  "postversion",
]);

// shell metacharacter — 이 채널이 만드는 값은 항상 "<runner> <target>" 형태의 단순 문자열로
// npm이 그대로 shell에 넘기므로, target 자체에 이런 문자가 있으면 명령 연결/치환/리다이렉션이
// 가능해진다(§ 요구사항 11/13). 세미콜론/파이프/앰퍼샌드/백틱/달러/리다이렉션/따옴표/괄호/
// 개행을 모두 거부한다.
const SHELL_METACHARACTER_PATTERN = /[;&|`$<>"'(){}\r\n\\]/;

function isSafeRepositoryRelativeTarget(target: string): boolean {
  if (typeof target !== "string" || target.length === 0) return false;
  if (SHELL_METACHARACTER_PATTERN.test(target)) return false;
  // 공백 문자(스페이스/탭)도 거부한다 — "<runner> <target>" 문자열은 npm이 그대로 셸에 넘기므로,
  // target에 공백이 있으면 "node x.test.mjs --require <악성 모듈>"처럼 추가 CLI flag를
  // 밀반입해 node 실행 시점에 임의 모듈을 로드시킬 수 있다(§ 요구사항 16 arbitrary command
  // injection 불가). 정상적인 테스트 파일 경로는 공백을 필요로 하지 않는다.
  if (/\s/.test(target)) return false;
  // 절대경로(POSIX "/" 시작, Windows drive letter, UNC "\\server\share" 또는 "//server/share").
  if (target.startsWith("/") || target.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(target)) return false;
  const normalized = target.split("\\").join("/");
  if (normalized.startsWith("//")) return false;
  // ".." traversal — 경로 구성요소 단위로 확인한다(예: "..foo"는 허용, "../foo"는 거부).
  if (normalized.split("/").some((seg) => seg === "..")) return false;
  return true;
}

/**
 * Developer가 반환한 registration 요청 하나를 검증한다(§ 요구사항 9, 16개 항목). 이 함수는
 * 어떤 파일도 쓰지 않는다 — 순수 판정만 한다. `changedFiles`는 이번 Developer attempt에서
 * 실제로 변경된 파일 목록(ClaudeResult.changedFiles)이어야 한다 — 다른 attempt/다른 task의
 * 파일을 등록 대상으로 인정하지 않는다.
 */
export function validateRequiredTestRegistrationRequest(
  request: RequiredTestRegistrationRequest,
  requiredTests: RequiredTestCommand[] | undefined,
  allowedPathPrefixes: string[],
  projectRoot: string,
  changedFiles: string[]
): RequiredTestRegistrationValidation {
  if (!request || typeof request !== "object") return { ok: false, reason: "요청이 object가 아님" };
  if (typeof request.scriptName !== "string" || request.scriptName.length === 0) {
    return { ok: false, reason: "scriptName이 비어있음" };
  }
  if (FORBIDDEN_LIFECYCLE_SCRIPT_NAMES.has(request.scriptName)) {
    return { ok: false, reason: `scriptName이 npm lifecycle hook 이름과 동일함: ${request.scriptName}` };
  }
  // 1/2 — scriptName이 현재 task의 canonical requiredTests(npm run 형태)에 정확히 존재해야
  // 한다. 여기 없는 임의 이름은 새 script를 추가하는 것이므로 거부한다(§ 요구사항 1/2).
  const canonicalNames = (requiredTests ?? []).map(extractNpmRunScript).filter((s): s is string => typeof s === "string");
  if (!canonicalNames.includes(request.scriptName)) {
    return { ok: false, reason: `scriptName(${request.scriptName})이 현재 task의 canonical requiredTests에 없음` };
  }
  // runner allow-list(§ 요구사항 — 허용되는 runner는 기존 convention에서 실제 쓰는 형태만).
  if (typeof request.runner !== "string" || !ALLOWED_TEST_RUNNERS.has(request.runner)) {
    return { ok: false, reason: `허용되지 않은 runner: ${String(request.runner)}` };
  }
  // 3~6 — repository-relative path, 절대경로/".."/UNC 금지, shell metacharacter 금지.
  if (!isSafeRepositoryRelativeTarget(request.target)) {
    return { ok: false, reason: "target이 안전한 repository-relative 경로가 아님(절대경로/traversal/UNC/shell metacharacter 금지)" };
  }
  const normalizedTarget = request.target.split("\\").join("/");
  // 7 — target이 이 task의 writablePaths(allowedPathPrefixes) 안에 있어야 한다.
  if (!allowedPathPrefixes.some((prefix) => normalizedTarget.startsWith(prefix))) {
    return { ok: false, reason: `target이 이 task의 allowedPathPrefixes 밖: ${normalizedTarget}` };
  }
  // 10 — 확장자/형식이 기존 repository 정책(§ CANDIDATE_TEST_FILE_SUFFIX)과 일치해야 한다.
  if (!normalizedTarget.endsWith(CANDIDATE_TEST_FILE_SUFFIX)) {
    return { ok: false, reason: `target이 ${CANDIDATE_TEST_FILE_SUFFIX} 확장자가 아님: ${normalizedTarget}` };
  }
  // 8 — target 파일이 실제로 존재해야 한다(추측으로 아직 없는 파일을 등록하지 않는다).
  const absTarget = join(projectRoot, ...normalizedTarget.split("/"));
  // 방어적 재확인 — join 결과가 실제로 projectRoot 내부에 있는지(경로 조합 결과가 어떤 경로
  // 정규화 특이 케이스로든 벗어나지 않았는지)를 한 번 더 확인한다.
  const relFromRoot = relative(projectRoot, absTarget).split(sep).join("/");
  if (relFromRoot.startsWith("..") || relFromRoot !== normalizedTarget) {
    return { ok: false, reason: "target이 project root 밖으로 벗어남" };
  }
  let st;
  try {
    st = lstatSync(absTarget);
  } catch {
    return { ok: false, reason: "target 파일이 존재하지 않음(아직 구현 전 — 나중에 다시 시도)" };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    return { ok: false, reason: "target이 실제 regular file이 아님(symlink/디렉터리 등)" };
  }
  // 9 — 이번 Developer attempt에서 실제로 생성/변경된 파일이어야 한다(다른 attempt의 파일을
  // 끌어다 등록할 수 없다).
  if (!changedFiles.includes(normalizedTarget)) {
    return { ok: false, reason: "target이 이번 attempt에서 변경된 파일 목록(changedFiles)에 없음" };
  }
  return { ok: true, expectedScript: `${request.runner} ${normalizedTarget}`, canonicalRequiredTestName: request.scriptName };
}

export interface RequiredTestRegistrationOutcome {
  scriptName: string;
  expectedScript: string;
  outcome: "REGISTERED" | "ALREADY_REGISTERED" | "REJECTED" | "DRIFT";
  reason?: string;
}

/**
 * 검증된 요청들을 실제로 package.json에 등록한다(§ 요구사항 11 — idempotent, 최소 변경,
 * JSON 유효성, atomic write, Secret Scanner Gate 재적용). 이미 동일한 값으로 등록돼 있으면
 * 아무것도 쓰지 않는다(ALREADY_REGISTERED — 두 번째 실행이 추가 변경을 만들지 않는다, §
 * 요구사항 J). 다른 값으로 이미 등록돼 있으면 절대 덮어쓰지 않고 DRIFT로 분류한다(§ 요구사항
 * 10 — REQUIRED_TEST_REGISTRATION_DRIFT).
 */
export function registerValidatedRequiredTestScripts(
  requests: RequiredTestRegistrationRequest[],
  requiredTests: RequiredTestCommand[] | undefined,
  allowedPathPrefixes: string[],
  projectRoot: string,
  changedFiles: string[]
): { outcomes: RequiredTestRegistrationOutcome[]; toCommit: { scriptName: string; expectedScript: string }[] } {
  const outcomes: RequiredTestRegistrationOutcome[] = [];
  const toWrite: { scriptName: string; expectedScript: string }[] = [];

  const validations = requests.map((r) => ({ request: r, validation: validateRequiredTestRegistrationRequest(r, requiredTests, allowedPathPrefixes, projectRoot, changedFiles) }));

  const pkg = readPackageJsonScripts(projectRoot);
  const existingScripts: Record<string, unknown> = pkg.ok ? pkg.scripts : {};

  for (const { request, validation } of validations) {
    if (!validation.ok) {
      outcomes.push({ scriptName: request.scriptName, expectedScript: `${request.runner} ${request.target}`, outcome: "REJECTED", reason: validation.reason });
      continue;
    }
    const existing = existingScripts[validation.canonicalRequiredTestName];
    if (existing === undefined) {
      toWrite.push({ scriptName: validation.canonicalRequiredTestName, expectedScript: validation.expectedScript });
      outcomes.push({ scriptName: validation.canonicalRequiredTestName, expectedScript: validation.expectedScript, outcome: "REGISTERED" });
    } else if (existing === validation.expectedScript) {
      outcomes.push({ scriptName: validation.canonicalRequiredTestName, expectedScript: validation.expectedScript, outcome: "ALREADY_REGISTERED" });
    } else {
      // 기존 script가 다른 target을 가리킴 — 절대 덮어쓰지 않는다(§ 요구사항 10).
      outcomes.push({
        scriptName: validation.canonicalRequiredTestName,
        expectedScript: validation.expectedScript,
        outcome: "DRIFT",
        reason: `package.json에 이미 다른 값으로 등록됨: ${String(existing)}`,
      });
    }
  }

  if (toWrite.length === 0) return { outcomes, toCommit: [] };

  const pkgPath = join(projectRoot, "package.json");
  const raw = readFileSync(pkgPath, "utf-8");
  const json = JSON.parse(raw) as Record<string, unknown>;
  const scripts = (json.scripts && typeof json.scripts === "object" && !Array.isArray(json.scripts) ? (json.scripts as Record<string, unknown>) : {}) as Record<string, unknown>;
  for (const w of toWrite) scripts[w.scriptName] = w.expectedScript;
  json.scripts = scripts;

  const serialized = JSON.stringify(json, null, 2) + "\n";
  const secretFindings = scanContentForSecrets(serialized, "package.json");
  if (secretFindings.length > 0) {
    log("REQUIRED_TEST_REGISTRATION BLOCK — package.json 갱신 내용에서 secret 패턴 감지", {
      findingKinds: secretFindings.map((f) => f.kind),
    });
    return {
      outcomes: outcomes.map((o) => (toWrite.some((w) => w.scriptName === o.scriptName) ? { ...o, outcome: "REJECTED", reason: "secret 패턴 감지로 등록 취소" } : o)),
      toCommit: [],
    };
  }

  const tmpDir = mkdtempSync(join(projectRoot, ".autodev-pkg-registration-"));
  const tmpPath = join(tmpDir, "package.json.tmp");
  try {
    writeFileSync(tmpPath, serialized, "utf-8");
    const fd = openSync(tmpPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, pkgPath);
    log("REQUIRED_TEST_REGISTRATION — Developer 선언 registration 등록", { registered: toWrite });
  } finally {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup.
    }
  }

  return { outcomes, toCommit: toWrite };
}

/**
 * registerValidatedRequiredTestScripts()가 만든 변경을 별도 infra commit으로 확정한다(§
 * commitRequiredTestScriptRepair와 동일한 원칙 — Task 자신의 구현 commit과 섞지 않는다,
 * package.json 외 다른 파일이 함께 staged되면 index를 reset하고 실패로 반환한다).
 */
export function commitRequiredTestRegistration(
  projectRoot: string,
  toCommit: { scriptName: string; expectedScript: string }[]
): RequiredTestScriptRepairCommitResult {
  if (toCommit.length === 0) return { ok: true };

  const addRes = runGit(["add", "--", "package.json"], projectRoot);
  if (!addRes.ok) return { ok: false, reason: `git add(package.json) 실패: ${addRes.stderr}` };

  const stagedRes = runGit(["diff", "--cached", "--name-only"], projectRoot);
  const staged = stagedRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (staged.length === 0) return { ok: true };
  if (staged.length !== 1 || staged[0] !== "package.json") {
    runGit(["reset"], projectRoot);
    return { ok: false, reason: `package.json 외 다른 파일이 함께 staged됨(index reset됨): ${staged.join(", ")}` };
  }

  const message =
    `fix: register developer-declared required test script(s)\n\n` +
    toCommit.map((r) => `- ${r.scriptName}: ${r.expectedScript}`).join("\n") +
    `\n\nDeveloper가 선언한 required-test registration 요청을 AutoDev infrastructure가 검증 후 등록했습니다.`;
  const commitRes = runGit(["commit", "-m", message], projectRoot);
  if (!commitRes.ok) {
    runGit(["reset"], projectRoot);
    return { ok: false, reason: `git commit(package.json) 실패(index reset됨): ${commitRes.stderr}` };
  }
  const hashRes = runGit(["rev-parse", "HEAD"], projectRoot);
  log("REQUIRED_TEST_REGISTRATION commit 생성", { commitHash: hashRes.ok ? hashRes.stdout : undefined, registered: toCommit.map((r) => r.scriptName) });
  return { ok: true, commitHash: hashRes.ok ? hashRes.stdout : undefined };
}
