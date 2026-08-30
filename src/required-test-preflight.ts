import { readFileSync, writeFileSync, renameSync, mkdtempSync, rmSync, lstatSync, readdirSync, openSync, fsyncSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { RequiredTestCommand, TaskDefinition } from "./task-registry";
import { findTaskById } from "./task-registry";
import { log } from "./logger";
import { scanContentForSecrets } from "./secret-scanner";
import { resolveTrustedGradleWrapper } from "./gradle-capability";
import type { GradleWrapperResolveTestDeps } from "./gradle-capability";
import { isPathInScope } from "./git-changes";
import { assertNoSymlinkInChain } from "./project-bootstrap";

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

// AutoDev Core Maintenance(2026-08-30) — Deterministic Execution-Environment Preflight.
//
// § JARVIS Task 5.2 실측 근본원인: checkRequiredTestScriptRegistration()은 "npm run X" 형태의
// requiredTest만 검증한다 — cwd 별칭이 가리키는 디렉터리가 실제로 존재하는지, gradlew류
// wrapper-style executable이 그 디렉터리 안에 실제로 있는지는 어디서도(execution-contract.ts는
// 별칭 "키"가 정의됐는지만 확인하고 fs 접근을 하지 않는다, trusted-executable-resolver.ts/
// gradle-capability.ts는 실제 RUN_COMMAND 실행 시점에만 호출된다) 사전에 확인하지 않는다.
// 그 결과 JARVIS의 wakeword-unit(cwd:"root", 실제 gradlew.bat은 android/wakeword/에 존재)
// 같은 순수 설정 오류가 Developer를 5회 호출한 뒤에야 TRUSTED_EXECUTABLE_NOT_FOUND로만
// 관측됐다 — Developer는 그 실패를 command allow-list 문제로 오인하고 gradlew/build.gradle.kts
// bootstrap 로직을 반복해서 다시 작성했다(§ logs/problem-memory/JARVIS.json).
//
// 이 함수는 Developer/Reviewer를 부르기 전에(§ autodev.ts, checkRequiredTestScriptRegistration과
// 같은 자리) requiredTest마다 cwd가 실제로 존재하는 디렉터리로 resolve되는지, 그리고
// gradlew류 wrapper-style executable이면 그 wrapper 파일 자체가 실제로 있는지를 순수 fs
// 판정으로 확인한다. Android/Node/Python/단일 파일 scope 어디에도 특정 프로젝트를 하드코딩하지
// 않는다 — "resolved cwd가 디렉터리로 존재하는가"는 어떤 project type에도 적용되는 일반
// 검사이고, wrapper 파일 존재 확인은 WRAPPER_STYLE_EXECUTABLE_BASE_NAMES에 등록된 executable
// family에만 적용된다(현재 gradlew — mvnw 등 다른 wrapper family를 추가할 여지는 남겨둔다).
//
// 자동 복구(self-heal)는 만들지 않는다 — checkRequiredTestScriptRegistration의 self-heal은
// 이미 디스크에 존재하는 테스트 파일 경로 하나를 package.json에 추가하는 것뿐이지만, 이 문제의
// 실제 수정(commandCwdAliases 추가 + requiredTest.cwd 변경)은 project adapter config
// (manifest.json의 inline executionPolicy, 그리고 taskRegistryPath가 가리키는 task-registry
// 데이터 파일)를 바꿔야 한다 — 이 두 파일은 이 프로젝트의 실행 신뢰 경계(어떤 디렉터리에서
// 명령을 실행할 수 있는지) 자체를 정의하는 데이터이므로, package.json script 등록보다 훨씬
// 민감하다. AutoDev Core는 지금까지 이 파일들에 전혀 쓰지 않았고(project-adapter-loader.ts는
// 오직 read-only), 이 Task 범위에서 그 새 쓰기 경로를 만들지 않는다 — 사람이 직접 고치거나,
// 별도로 명시적으로 승인된 Task에서 다뤄야 한다. 이 함수는 감지와 차단만 한다.

export type RequiredTestExecutionEnvironmentIssueKind = "CWD_NOT_FOUND" | "WRAPPER_NOT_FOUND";

export interface RequiredTestExecutionEnvironmentIssue {
  requiredTestName: string;
  kind: RequiredTestExecutionEnvironmentIssueKind;
  /** requiredTest.cwd 원본 값("root" 또는 별칭 이름) — 실제 별칭 매핑 값 자체는 아니다. */
  cwd: string;
  resolvedPath: string;
  reason?: string;
}

/** greenfield defer(§ evaluateGreenfieldDefer)가 적용된 required test — 차단하지 않았지만
 *  Developer 호출 전 시점에는 아직 실제로 존재하지 않는 대상이라는 뜻이다. issues와 달리
 *  ok:true에 포함되며, 순수 관찰/로그용이다(호출부가 이 값으로 무언가를 추가로 막거나
 *  허용하지 않는다). */
export interface GreenfieldDeferredRequiredTest {
  requiredTestName: string;
  cwd: string;
  resolvedPath: string;
}

export interface RequiredTestExecutionEnvironmentResult {
  ok: boolean;
  issues: RequiredTestExecutionEnvironmentIssue[];
  /** § GreenfieldDeferredRequiredTest 주석. */
  deferredGreenfield: GreenfieldDeferredRequiredTest[];
}

/** execution-contract.ts의 validateRequiredTestExecutionContract()가 이미 검증한 것과
 *  독립적으로, 이 함수는 fs 접근이 필요한 부분만 담당한다(§ 파일 상단 — 그 파일은
 *  의도적으로 fs-free로 유지된다). */
export interface RequiredTestExecutionEnvironmentExecutor {
  projectRoot: string;
  projectRootReal: string;
  policy: { commandCwdAliases?: Record<string, string> };
}

// gradlew.exe/.bat/.cmd 등은 safe-executor.ts normalizeExecutableBase()와 동일한 규칙으로
// 정규화된다 — 여기서도 그 규칙을 재사용하지 않고 최소한으로 재구현한다(이 파일은
// safe-executor.ts를 import하지 않는다, § 순환 의존성 회피 — safe-executor.ts는 이미 이
// 파일의 상위 계층인 autodev.ts에서만 함께 쓰인다).
function normalizeWrapperExecutableBase(command: string): string {
  return command.trim().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
}

/** wrapper 파일 자체의 존재를 별도로 확인해야 하는 executable family. gradlew만 등록돼
 *  있다 — 다른 wrapper family(예: mvnw)를 추가하려면 대응하는 resolveTrusted*Wrapper()
 *  함수가 먼저 필요하다(이 목록에 이름만 추가한다고 검증이 생기지 않는다). */
const WRAPPER_STYLE_EXECUTABLE_BASE_NAMES: ReadonlySet<string> = new Set(["gradlew"]);

// Greenfield Required-Test Preflight Deadlock 수정(2026-08-30, JARVIS Task 5.3 실측 — §
// .claude/CLAUDE.md 보안 섹션에 기록). 이 검사는 원래 두 종류를 구분하지 못했다: (A)
// Developer 호출 전에 반드시 이미 존재해야 하는 실행환경(JDK/신뢰 executable/기존 project
// root 등 — 계속 엄격히 차단해야 함)과 (B) 바로 이 Task 자신이 새로 만들어야 할 산출물(신규
// module 디렉터리 등 — 아직 없다는 이유만으로 Developer 자체를 영구 차단하면 그 산출물을
// 만들 기회 자체가 없다, § reassembleExecutionContract 등 어떤 재실행 경로로도 스스로
// 해소되지 않는 deadlock). 아래 evaluateGreenfieldDefer()가 (B)를 구조적으로 안전하게
// 확인된 경우에만 defer한다 — "cwd가 없으면 모두 허용"이 아니다: 5개 조건을 전부 만족해야
// 하고, 이미 존재하는 대상(디렉터리가 아니거나 symlink인 경우)이나 WRAPPER_NOT_FOUND(디렉터리는
// 있는데 wrapper가 없는 경우)는 이 defer 대상이 아니며 기존처럼 항상 즉시 BLOCK된다.
/**
 * Greenfield CWD_NOT_FOUND defer 자격 판정. 아래 전부를 만족해야 defer한다:
 *   1) rt.cwd가 "root"가 아니다 — project root 자체는 "아직 안 만들어진 산출물"일 수 없다.
 *   2) lstat 실패의 실제 원인이 ENOENT(정말로 아직 없음)다 — EACCES/EPERM 등 "확인하지
 *      못함"은 fail-closed로 defer하지 않는다(§ project-bootstrap.ts assertNoSymlinkInChain과
 *      동일한 원칙 — 확인 못 함을 "안전하다"로 취급하지 않는다).
 *   3) alias 값이 정의돼 있다(이미 project-policy.ts validateProjectExecutionPolicy()가
 *      "../"/절대경로를 거부한 안전한 상대경로임을 보장한다 — 단일 출처, 여기서 다시 파싱하지
 *      않는다).
 *   4) 그 alias가 가리키는 경로가 현재 Task의 allowedPathPrefixes(Developer의 실제 write
 *      scope) 안에 있다 — git-changes.ts isPathInScope()를 그대로 재사용(로직 복제 없음,
 *      checkpoint.ts/gpt-reviewer.ts와 동일한 구현을 공유).
 *   5) resolvedPath부터 project root까지 조상 체인에 symlink/junction이 없다 —
 *      project-bootstrap.ts assertNoSymlinkInChain()을 그대로 재사용(SI-3.5 로직 복제 없음).
 *      아직 존재하지 않는 leaf 자신은 ENOENT로 통과되고, 실제로 존재하는 조상만 검사된다.
 */
export function evaluateGreenfieldDefer(
  rt: RequiredTestCommand,
  resolvedPath: string,
  lstatErrorCode: string | undefined,
  executor: RequiredTestExecutionEnvironmentExecutor,
  allowedPathPrefixes: readonly string[]
): boolean {
  if (rt.cwd === "root") return false;
  if (lstatErrorCode !== "ENOENT") return false;
  const alias = executor.policy.commandCwdAliases?.[rt.cwd];
  if (alias === undefined) return false;
  const aliasNormalized = alias.replace(/\\/g, "/").replace(/\/+$/, "");
  const aliasScopeCheck = `${aliasNormalized}/`;
  if (!isPathInScope(aliasScopeCheck, [...allowedPathPrefixes])) return false;
  const symlinkCheck = assertNoSymlinkInChain(resolvedPath, executor.projectRootReal);
  if (!symlinkCheck.ok) return false;
  return true;
}

/**
 * Claude Developer를 부르기 전에 호출한다. requiredTests 각각에 대해 cwd가 resolve하는
 * 절대경로가 실제로 존재하는 디렉터리인지 확인하고, wrapper-style executable이면 그
 * wrapper 파일 자체의 존재/신뢰도까지 확인한다(resolveTrustedGradleWrapper 재사용 — 로직
 * 복제 없음). alias 키 자체가 정의되지 않은 경우는 이 함수의 대상이 아니다(그 구조적 오류는
 * execution-contract.ts가 spec-planning 시점에 이미 차단한다) — 조용히 skip한다.
 *
 * allowedPathPrefixes는 이 requiredTests를 소유한 Task의 taskDef.allowedPathPrefixes를
 * 그대로 넘긴다 — § evaluateGreenfieldDefer 조건 4.
 */
export function checkRequiredTestExecutionEnvironment(
  requiredTests: RequiredTestCommand[] | undefined,
  executor: RequiredTestExecutionEnvironmentExecutor,
  allowedPathPrefixes: readonly string[],
  /** 테스트 전용 — 지정하지 않으면 production과 완전히 동일(process.platform, 실제 fs/env)하게
   *  동작한다. resolveTrustedGradleWrapper()로 그대로 전달한다(로직 복제 없음) — Windows에서
   *  회귀 테스트가 JAVA_HOME 없이도 결정론적으로 동작하도록 platform을 고정할 수 있게 한다. */
  gradleTestOverrides?: { platform?: NodeJS.Platform; gradleTestDeps?: GradleWrapperResolveTestDeps }
): RequiredTestExecutionEnvironmentResult {
  if (!requiredTests || requiredTests.length === 0) return { ok: true, issues: [], deferredGreenfield: [] };
  const issues: RequiredTestExecutionEnvironmentIssue[] = [];
  const deferredGreenfield: GreenfieldDeferredRequiredTest[] = [];

  for (const rt of requiredTests) {
    let resolvedPath: string;
    if (rt.cwd === "root") {
      resolvedPath = executor.projectRoot;
    } else {
      const alias = executor.policy.commandCwdAliases?.[rt.cwd];
      if (alias === undefined) continue; // § 위 주석 — execution-contract.ts의 대상.
      resolvedPath = join(executor.projectRoot, alias);
    }

    let st;
    try {
      st = lstatSync(resolvedPath);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (evaluateGreenfieldDefer(rt, resolvedPath, code, executor, allowedPathPrefixes)) {
        deferredGreenfield.push({ requiredTestName: rt.name, cwd: rt.cwd, resolvedPath });
        continue;
      }
      issues.push({ requiredTestName: rt.name, kind: "CWD_NOT_FOUND", cwd: rt.cwd, resolvedPath, reason: "디렉터리가 존재하지 않습니다." });
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) {
      issues.push({
        requiredTestName: rt.name,
        kind: "CWD_NOT_FOUND",
        cwd: rt.cwd,
        resolvedPath,
        reason: st.isSymbolicLink() ? "경로가 symlink입니다(허용되지 않음)." : "경로가 디렉터리가 아닙니다.",
      });
      continue;
    }

    const base = normalizeWrapperExecutableBase(rt.command);
    if (!WRAPPER_STYLE_EXECUTABLE_BASE_NAMES.has(base)) continue;

    const wrapperResult = resolveTrustedGradleWrapper({
      moduleAbs: resolvedPath,
      projectRootReal: executor.projectRootReal,
      excludedRootsForJava: [executor.projectRoot, executor.projectRootReal, resolvedPath, tmpdir()],
      platform: gradleTestOverrides?.platform,
      testDeps: gradleTestOverrides?.gradleTestDeps,
    });
    if (!wrapperResult.ok) {
      issues.push({ requiredTestName: rt.name, kind: "WRAPPER_NOT_FOUND", cwd: rt.cwd, resolvedPath, reason: wrapperResult.reason });
    }
  }

  return { ok: issues.length === 0, issues, deferredGreenfield };
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

// AutoDev / JARVIS Unattended Continuous Development Reliability Hardening(2026-08-30,
// JARVIS Task 5.2 실측) — Stale REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR WAITING_HUMAN
// Reconciliation. checkRequiredTestExecutionEnvironment()가 WRAPPER_NOT_FOUND 등을 이유로
// state.deferredHumanTasks에 남긴 고정 템플릿 문자열(§ autodev.ts BLOCKED_REQUIRED_TEST_
// EXECUTION_ENVIRONMENT 분기)을 다시 파싱해, 그 실행 환경 결함이 *지금도* 재현되는지
// 동일한 checkRequiredTestExecutionEnvironment()로 재확인한다 — 이 파일이 만드는 것은 그
// 하나뿐이다: "같은 원인으로 남은 WAITING_HUMAN을 같은 deterministic 검사로 다시 확인"이지,
// WRAPPER_NOT_FOUND류 결함을 스스로 고치는 어떤 자동복구도 아니다(그런 로직은 이 함수에
// 없다). reconcileStaleRequiredTestConfigurationTasks()(§ 위)와 완전히 동일한 fail-closed
// 설계를 그대로 재사용한다 — 배열 안에 이 마커 형식이 아닌 항목이 하나라도 섞여 있거나,
// 서로 다른 taskId를 가리키는 마커가 섞여 있으면 절대 resolved로 판정하지 않는다(어떤
// genuine 사람 판단 필요 상태도, 그리고 다른 task의 상태도 이 재검사로 조용히 해제되지
// 않는다). taskRegistry에서 taskId를 찾지 못해도(레지스트리가 그 사이 바뀐 경우 등) 추측하지
// 않고 resolved:false로 fail-closed한다.
const REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR_ENTRY_PATTERN =
  /^REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR: task=(\S+) requiredTest=\S+ kind=\S+ cwd=\S+ resolvedPath=.+$/;

export interface StaleRequiredTestExecutionEnvironmentReconciliation {
  /** true면 deferredHumanTasks 전체가 REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR 형태였고
   *  전부 같은 taskId를 가리켰으며, 그 task의 required tests에 대해
   *  checkRequiredTestExecutionEnvironment()를 다시 실행한 결과 더 이상 어떤 issue도 없다
   *  — 호출부가 안전하게 WAITING_HUMAN을 해제하고 이 배열을 비울 수 있다. */
  resolved: boolean;
}

/** state.status==="WAITING_HUMAN"이고 state.humanFinalReview가 없을 때만 호출한다(§
 *  reconcileStaleRequiredTestConfigurationTasks와 동일한 호출 전제). Developer/Claude/GPT
 *  어떤 프로세스도 spawn하지 않는다 — checkRequiredTestExecutionEnvironment()와 동일하게
 *  순수 fs/실행파일 resolve 판정만 수행한다. */
export function reconcileStaleRequiredTestExecutionEnvironmentTasks(
  deferredHumanTasks: readonly string[],
  taskRegistry: readonly TaskDefinition[],
  executor: RequiredTestExecutionEnvironmentExecutor,
  /** 테스트 전용 — checkRequiredTestExecutionEnvironment()로 그대로 전달한다(§ 그 함수의
   *  동일 파라미터 주석). production 호출부(autodev.ts)는 이 값을 지정하지 않는다. */
  gradleTestOverrides?: { platform?: NodeJS.Platform; gradleTestDeps?: GradleWrapperResolveTestDeps }
): StaleRequiredTestExecutionEnvironmentReconciliation {
  if (deferredHumanTasks.length === 0) return { resolved: false };
  let taskId: string | undefined;
  for (const entry of deferredHumanTasks) {
    const m = REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR_ENTRY_PATTERN.exec(entry);
    if (!m) return { resolved: false };
    if (taskId === undefined) taskId = m[1];
    else if (taskId !== m[1]) return { resolved: false };
  }
  if (taskId === undefined) return { resolved: false };
  const taskDef = findTaskById(taskRegistry, taskId);
  if (!taskDef) return { resolved: false };
  const recheck = checkRequiredTestExecutionEnvironment(taskDef.requiredTests, executor, taskDef.allowedPathPrefixes, gradleTestOverrides);
  return { resolved: recheck.ok };
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

// AutoDev / JARVIS Unattended Continuous Development Reliability Hardening — Phase 12
// (2026-08-29, JARVIS Task 4.6 실측 근본원인). 위 findCandidateTestFiles()는
// allowedPathPrefixes 각 항목이 디렉터리일 때만 그 밑을 훑는다 — 항목 자체가 이미 구체적인
// 파일 하나("backend/memory/memory-manager-api.ts"처럼 디렉터리 슬래시 없이 끝나는 단일
// leaf path")를 가리키면 무조건 스킵된다(`!st.isDirectory()`). Task의 allowedPathPrefixes가
// 정확히 그런 단일 파일 하나뿐이면(Safe Executor의 write-path 강제 자체가 이미 그 파일
// 하나만 허용) Developer는 구조적으로 그 옆에 별도 "*.test.mjs" 파일을 만들 방법이 없다 —
// 그래서 위 glob은 항상 0개를 찾고, 실제로 존재하는 (구현+self-test를 한 파일에 함께 담은)
// 그 파일 자체는 영원히 후보로 인정되지 않아 매 attempt마다 "Missing script"로 반복
// 실패했다(§ JARVIS Task 4.6, REVISE 7회/Developer round 69회 낭비 후 실측 확인).
// allowedPathPrefixes가 정확히 이런 단일 파일 scope일 때만(디렉터리 prefix는 다른 파일이
// 여럿일 수 있어 모호하므로 대상이 아니다 — 기존 glob 판정을 그대로 유지) 그 파일 자체를
// 유일하게 안전한 후보로 인정한다 — 파일명을 추측하지 않는다(allowedPathPrefixes 자신이
// 이미 그 정확한 경로를 명시한다), 실행 가능한 확장자인지, 실제로 존재하는 regular file인지
// (symlink 아님)만 확인한다.
const EXECUTABLE_TEST_ENTRY_EXTENSIONS: ReadonlySet<string> = new Set([".ts", ".mts", ".js", ".mjs", ".cjs"]);

function singleFileScopedCandidate(projectRoot: string, allowedPathPrefixes: string[]): string | undefined {
  if (allowedPathPrefixes.length !== 1) return undefined;
  const prefix = allowedPathPrefixes[0];
  if (prefix.endsWith("/")) return undefined; // 디렉터리 scope — 여러 파일이 있을 수 있어 모호함, 대상 아님.
  const dotIdx = prefix.lastIndexOf(".");
  if (dotIdx === -1 || !EXECUTABLE_TEST_ENTRY_EXTENSIONS.has(prefix.slice(dotIdx))) return undefined;
  const absPath = join(projectRoot, ...prefix.split("/"));
  let st;
  try {
    st = lstatSync(absPath);
  } catch {
    return undefined; // 아직 구현 전(정상 상태) — 후보 아님, 추측하지 않는다.
  }
  if (st.isSymbolicLink() || !st.isFile()) return undefined;
  return prefix;
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
  // glob이 아무 *.test.mjs도 찾지 못했을 때만(모호하지 않은 경우에만) 단일 파일 scope
  // fallback을 본다 — glob이 이미 정확히 하나를 찾았다면 그 결과를 그대로 우선한다(§ 위
  // singleFileScopedCandidate 주석, Phase 12).
  const singleFileFallback = candidates.length === 0 ? singleFileScopedCandidate(projectRoot, allowedPathPrefixes) : undefined;

  for (const issue of issues) {
    if (candidates.length === 1) {
      const relPath = relative(projectRoot, candidates[0]).split(sep).join("/");
      repaired.push({ ...issue, expectedScript: `node ${relPath}` });
    } else if (singleFileFallback) {
      repaired.push({ ...issue, expectedScript: `node ${singleFileFallback}` });
    } else {
      unresolved.push(issue);
    }
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
