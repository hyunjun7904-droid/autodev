import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { isInsideAnyRoot, verifyRegularFileOutsideExcluded } from "./trusted-executable-resolver";
import type { TrustedExecutableResult, ExecutableTrustErrorCode, FsDeps } from "./trusted-executable-resolver";

// AutoDev Core — SI-3.7(Execution Contract Closure) Android/Gradle Capability.
//
// JARVIS v1.3 R1 Human Review EP-2: Android Task가 requiredTests로 "./gradlew"류 명령을
// 요구하지만, Core Command Safety Gate(safe-executor.ts CORE_ALLOWED_EXECUTABLE_FAMILIES)는
// git/npm/npx/node/tsc만 허용해 실행 자체가 불가능했다. 이 파일은 "./gradlew"를 generic
// executable allow-list에 그냥 추가하는 방식(§ 지시서 4 "단순히 추가하지 않는다")이 아니라,
// git/npm/npx가 이미 쓰는 것과 동일한 설계 원칙(allow-list, project-relative bare 이름,
// Trusted Executable Resolution)을 그대로 재사용해 닫힌 typed capability
// (GRADLE_WRAPPER_TEST/BUILD/LINT/CONNECTED_TEST)로 노출한다.
//
// Trust Boundary 명시(§ 지시서 4 "wrapper/project build code를 실행한다는 trust boundary
// 명시") — 이 capability는 git/npm/node처럼 "AutoDev 밖의 독립적으로 신뢰되는 외부 도구"를
// 실행하는 것이 아니다. gradlew(및 gradlew.bat)는 **대상 프로젝트 자신이 커밋한 코드**다 —
// safe-executor.ts의 tsc 처리(resolveTrustedTsc, "project_local_dependency" trust source)와
// 동일한 부류다: node_modules/typescript가 프로젝트가 npm으로 설치한 자신의 devDependency이듯,
// <module>/gradlew + <module>/gradle/wrapper/gradle-wrapper.{jar,properties}는 프로젝트가
// 커밋한 자신의 build 진입점이다. 따라서 이 capability가 실제로 막는 것은 "이 프로젝트의
// 빌드 시스템이 안전한가"가 아니라(그건 프로젝트 자신의 코드를 신뢰하는 것과 동급 — Safe
// Executor의 WRITE_FILE/APPLY_PATCH가 이미 도달 가능한 범위다) "이 실행 하나가 project root
// 밖으로 새거나, 임의 인자로 Gradle 자체의 확장 지점(init script/커스텀 build file/외부
// project 참조)을 통해 project-relative 실행 계약을 벗어나지 않는가"다 — 그래서 인자는
// 정확히 하나의 allow-listed Gradle task 이름만 허용하고(플래그/옵션 전부 금지), cwd는 항상
// project root 내부의(Trusted Executable Resolution이 검증하는) 모듈 디렉터리로 고정된다.
//
// 실제 wrapper jar 내용 자체의 SRI/서명 검증은 하지 않는다(§ .claude/rules/
// filesystem-trust-model.md의 Portable Core Boundary와 동일한 한계 — 새 native subsystem
// 없이는 할 수 없다) — 대신 "이것이 정말 Gradle Wrapper인가"의 최소 감사 가능한 증거로
// gradle-wrapper.properties/gradle-wrapper.jar가 나란히 존재하는지 확인한다(resolveTrustedTsc가
// package.json의 name 필드만 확인하는 것과 같은 급의 identity evidence — 완전한 무결성
// 증명이 아니라 "우연히 같은 이름의 임의 스크립트"를 배제하는 최소 신원 확인이다).
//
// Windows에서 gradlew.bat는 .cmd/.bat shim과 동일하게 shell:false spawnSync로 직접 실행할 수
// 없다(self-dev-complete.ts가 이미 실측 확인한 제약과 동일 클래스). npm/npx가 .cmd shim
// 대신 옆의 node_modules/npm/bin/npm-cli.js를 신뢰된 node로 직접 실행하는 것과 동일한
// 원리로(§ trusted-executable-resolver.ts resolveNpmOrNpx), Windows에서는 gradlew.bat이
// 실제로 하는 일(JAVA_HOME의 java로 gradle-wrapper.jar의 GradleWrapperMain을 실행)을
// 그대로 재현한다 — java 자체의 신뢰 근거는 JAVA_HOME(Gradle 공식 문서가 권장하는 표준
// 환경변수) 또는 AUTODEV_TRUSTED_JAVA_HOME(git/claude의 AUTODEV_TRUSTED_GIT_PATH/
// AUTODEV_TRUSTED_CLAUDE_PATH와 동일한 explicit override 패턴)이며, PATH 스캔 fallback은
// 이 Task 범위에서 구현하지 않는다(§ 지시서 "필요하면 사람이 확인" 원칙 — JAVA_HOME이
// 없으면 fail-closed로 TRUSTED_EXECUTABLE_NOT_FOUND).

export type GradleWrapperCapability = "GRADLE_WRAPPER_TEST" | "GRADLE_WRAPPER_BUILD" | "GRADLE_WRAPPER_LINT" | "GRADLE_WRAPPER_CONNECTED_TEST";

/** normalizeExecutableBase("gradlew")==="gradlew"이고 normalizeExecutableBase("gradlew.bat")도
 *  ".bat" 확장자가 벗겨져 동일하게 "gradlew"가 된다(§ safe-executor.ts normalizeExecutableBase) —
 *  그래서 이 상수 하나로 두 플랫폼 표기를 모두 인식한다. */
export const GRADLE_WRAPPER_COMMAND_BASE_NAME = "gradlew";

// 닫힌(closed) allow-list — Android 프로젝트에서 실제로 필요한 test/build/lint/connected test
// 범위만 최소 허용한다(§ 지시서 4 "test/assemble/lint/connected 범위만 최소 허용"). 여기 없는
// Gradle task(예: publish/dependencies/init/wrapper 자체 재실행 등)는 전부 거부된다 —
// deny-list가 아니라 allow-list라는 이 저장소 전체의 설계 원칙과 동일하다.
export const GRADLE_TASK_ALLOWLIST_BY_CAPABILITY: Readonly<Record<GradleWrapperCapability, ReadonlySet<string>>> = {
  GRADLE_WRAPPER_TEST: new Set(["test", "testDebugUnitTest", "testReleaseUnitTest"]),
  GRADLE_WRAPPER_BUILD: new Set(["assemble", "assembleDebug", "assembleRelease"]),
  GRADLE_WRAPPER_LINT: new Set(["lint", "lintDebug", "lintRelease"]),
  GRADLE_WRAPPER_CONNECTED_TEST: new Set(["connectedAndroidTest", "connectedDebugAndroidTest"]),
};

export function classifyGradleTaskName(taskName: string): GradleWrapperCapability | null {
  for (const capability of Object.keys(GRADLE_TASK_ALLOWLIST_BY_CAPABILITY) as GradleWrapperCapability[]) {
    if (GRADLE_TASK_ALLOWLIST_BY_CAPABILITY[capability].has(taskName)) return capability;
  }
  return null;
}

export interface GradleCommandSafetyOk {
  ok: true;
  capability: GradleWrapperCapability;
  taskName: string;
}
export interface GradleCommandSafetyFail {
  ok: false;
  reason: string;
}
export type GradleCommandSafetyResult = GradleCommandSafetyOk | GradleCommandSafetyFail;

/**
 * gradlew 전용 Core Command Safety 판정 — safe-executor.ts의 coreCommandSafetyGate가
 * base(normalizeExecutableBase 기준)가 "gradlew"일 때 이 함수로 위임한다. 인자는 정확히
 * 하나의 allow-listed Gradle task 이름만 허용한다 — --init-script/-I(커스텀 init script)/
 * -D(system property injection)/-P(project property injection)/-p·--project-dir(다른
 * project 참조)/-c·--settings-file/-b·--build-file/-g·--gradle-user-home 등 어떤 플래그도
 * 허용하지 않는다(플래그를 하나라도 허용하려면 그 플래그 하나하나가 안전한지 개별적으로
 * 증명해야 하는데, 이 Task의 실제 필요(test/build/lint/connected test 실행)는 플래그 없이
 * task 이름 하나로 충분하다 — deny-list로 개별 위험 플래그를 나열하지 않고, 애초에 "정확히
 * 하나의 인자"라는 구조 자체로 그 클래스 전체를 차단한다).
 *
 * 이 함수는 command 자체(경로 구분자/드라이브 문자)도 다시 검사한다 — safe-executor.ts의
 * coreCommandSafetyGate가 family 판정 전에 이미 동일한 검사를 하지만, 이 함수 단독으로도
 * 독립적으로 안전하게 재사용/테스트될 수 있어야 하므로 단일 방어선에 의존하지 않는다.
 */
export function coreGradleCommandSafetyGate(command: string, args: readonly string[]): GradleCommandSafetyResult {
  if (/[\\/]/.test(command) || command.includes(":")) {
    return {
      ok: false,
      reason:
        'Gradle Wrapper Capability: 경로 구분자/드라이브 문자가 포함된 command는 허용되지 않습니다 — "gradlew" 또는 ' +
        '"gradlew.bat" bare 이름만 허용됩니다(예: "./gradlew"/"../gradlew"/외부 경로/shell wrapper는 항상 거부).',
    };
  }
  const base = command.trim().toLowerCase().replace(/\.(bat|cmd|exe|com)$/, "");
  if (base !== GRADLE_WRAPPER_COMMAND_BASE_NAME) {
    return {
      ok: false,
      reason: `Gradle Wrapper Capability: 인식되지 않은 command입니다(${JSON.stringify(command)}) — gradlew/gradlew.bat만 허용됩니다.`,
    };
  }
  if (args.length !== 1) {
    return {
      ok: false,
      reason:
        "Gradle Wrapper Capability: 정확히 하나의 Gradle task 인자만 허용됩니다 — 추가 플래그/옵션/여러 task 조합" +
        "(--init-script/-I/-D/-P/-p/--project-dir/-c/--settings-file/-b/--build-file/-g/--gradle-user-home 등 포함)은 " +
        "어떤 project policy로도 허용되지 않습니다.",
    };
  }
  const taskName = args[0];
  const capability = classifyGradleTaskName(taskName);
  if (!capability) {
    return {
      ok: false,
      reason: `Gradle Wrapper Capability: 인식되지 않거나 지원되지 않는 Gradle task입니다(${JSON.stringify(taskName)}) — Core가 지원하는 task만 허용됩니다.`,
    };
  }
  return { ok: true, capability, taskName };
}

// =========================================================
// Trusted Gradle Wrapper Resolution — safe-executor.ts의 SI-3.6 Trusted Executable
// Resolution과 동일한 성격(이름/인자 allow-list를 통과해도 "실제로 무엇이 실행되는가"는
// 별도 질문)이지만, 신뢰 모델이 근본적으로 다르기 때문에(§ 파일 상단 trust boundary
// 설명 — 외부 도구가 아니라 project-owned 코드) trusted-executable-resolver.ts를 수정하지
// 않고 이 파일에 독립적으로 둔다(tsc가 safe-executor.ts 안에 resolveTrustedTsc()로 별도
// 존재하는 것과 동일한 선례).
// =========================================================

export interface GradleWrapperResolveTestDeps {
  existsSyncImpl?: (p: string) => boolean;
  statSyncImpl?: (p: string) => { isFile(): boolean };
  realpathSyncImpl?: (p: string) => string;
  envOverride?: Record<string, string | undefined>;
}

// SI-3.7 bounded code-review 지적(MEDIUM) 반영 — isInsideAnyRoot()/verifyRegularFileOutsideExcluded()는
// trusted-executable-resolver.ts(SI-3.6)의 동일 함수를 그대로 재사용한다(export만 추가됐을
// 뿐 그 파일의 판정 로직은 전혀 바뀌지 않았다) — java.exe 신뢰 판정(project 밖 외부 도구
// 모델)이 git/claude와 완전히 같은 보장을 받도록, 그리고 향후 그 함수가 강화될 때 이 파일이
// 조용히 뒤처지지 않도록 로직을 복제하지 않는다. fsDepsFrom()이 반환하는 형태는
// trusted-executable-resolver.ts가 export하는 FsDeps와 구조적으로 동일하므로 그대로 넘길 수
// 있다.
function fsDepsFrom(testDeps?: GradleWrapperResolveTestDeps): FsDeps {
  return {
    exists: testDeps?.existsSyncImpl ?? existsSync,
    stat: testDeps?.statSyncImpl ?? statSync,
    realpath: testDeps?.realpathSyncImpl ?? realpathSync,
  };
}

function readEnv(name: string, testDeps?: GradleWrapperResolveTestDeps): string | undefined {
  if (testDeps?.envOverride && name in testDeps.envOverride) return testDeps.envOverride[name];
  return process.env[name];
}

type VerifyResult = { ok: true; real: string } | { ok: false; code: ExecutableTrustErrorCode; reason: string };

/** 대상이 project root **안**에 있어야 하는 경우(gradlew 스크립트 자신/wrapper jar/
 *  properties — 프로젝트가 커밋한 project-owned 파일이어야 한다). trusted-executable-
 *  resolver.ts에는 이 "안"(containment) 방향의 검증이 없다(그 파일은 항상 "밖"(exclusion)만
 *  다룬다 — git/npm/node/claude가 전부 project 외부의 신뢰된 도구이기 때문) — gradlew만의
 *  고유한 trust boundary(project-owned 코드)라 여기 남아있는 것이 맞다(§ 파일 상단 설명).
 *  isInsideAnyRoot()만 재사용한다(로직 복제 없음). */
function verifyRegularFileWithinRoot(candidate: string, projectRootReal: string, fs: FsDeps): VerifyResult {
  if (!fs.exists(candidate)) return { ok: false, code: "TRUSTED_EXECUTABLE_NOT_FOUND", reason: `${candidate}가 존재하지 않습니다.` };
  let st: { isFile(): boolean };
  try {
    st = fs.stat(candidate);
  } catch {
    return { ok: false, code: "EXECUTABLE_IDENTITY_UNTRUSTED", reason: `${candidate} 상태 확인 실패.` };
  }
  if (!st.isFile()) return { ok: false, code: "EXECUTABLE_IDENTITY_UNTRUSTED", reason: `${candidate}는 일반 파일이 아닙니다.` };
  let real: string;
  try {
    real = fs.realpath(candidate);
  } catch {
    return { ok: false, code: "EXECUTABLE_IDENTITY_UNTRUSTED", reason: `${candidate} realpath 확인 실패.` };
  }
  if (!isInsideAnyRoot(real, [projectRootReal])) {
    return { ok: false, code: "EXECUTABLE_SHADOWING_DETECTED", reason: `${candidate}(실제 위치: ${real})가 project root 밖을 가리킵니다.` };
  }
  return { ok: true, real };
}

export interface ResolveTrustedGradleWrapperOptions {
  /** 이미 검증된(commandCwdAliases를 통해 project root 내부로 확정된) 절대경로 — Gradle
   *  module(gradlew가 위치한) 디렉터리. */
  moduleAbs: string;
  projectRootReal: string;
  /** java 신뢰 판정에만 쓰인다(§ verifyRegularFileOutsideExcluded) — project root/
   *  projectRootReal/cwd/OS temp를 호출부가 조립해서 전달한다(git/npm/npx와 동일한 관례). */
  excludedRootsForJava: readonly string[];
  platform?: NodeJS.Platform;
  testDeps?: GradleWrapperResolveTestDeps;
}

/**
 * moduleAbs 안의 gradlew(POSIX)/gradlew.bat(win32)를 검증된 canonical spawn 대상으로
 * 해석한다. 실패하면 TrustedExecutableFail(TRUSTED_EXECUTABLE_NOT_FOUND/
 * EXECUTABLE_IDENTITY_UNTRUSTED/EXECUTABLE_SHADOWING_DETECTED)을 반환한다 — 어떤 경우에도
 * "비슷해 보이는 대체"로 조용히 넘어가지 않는다(fail-closed).
 */
export function resolveTrustedGradleWrapper(opts: ResolveTrustedGradleWrapperOptions): TrustedExecutableResult {
  const fs = fsDepsFrom(opts.testDeps);
  const platform = opts.platform ?? process.platform;

  // moduleAbs 자체가 project root 안인지 이 함수도 독립적으로 재확인한다(호출부인
  // safe-executor.ts가 이미 commandCwdAliases/cwdToPath로 보장하지만, resolveTrustedTsc와
  // 동일하게 단일 방어선에 의존하지 않는다).
  let moduleReal: string;
  try {
    moduleReal = fs.realpath(opts.moduleAbs);
  } catch {
    return { ok: false, code: "TRUSTED_EXECUTABLE_NOT_FOUND", reason: "Gradle module 디렉터리를 확인할 수 없습니다." };
  }
  if (!isInsideAnyRoot(moduleReal, [opts.projectRootReal])) {
    return { ok: false, code: "EXECUTABLE_SHADOWING_DETECTED", reason: "Gradle module 경로가 project root 밖을 가리킵니다." };
  }

  const wrapperFileName = platform === "win32" ? "gradlew.bat" : "gradlew";
  const wrapperVerified = verifyRegularFileWithinRoot(join(opts.moduleAbs, wrapperFileName), opts.projectRootReal, fs);
  if (!wrapperVerified.ok) return wrapperVerified;

  // 신원 증거(§ 파일 상단 설명) — 실제 Gradle Wrapper의 일부인지 wrapper jar/properties가
  // 나란히 있는지로 최소 확인한다.
  const propsVerified = verifyRegularFileWithinRoot(join(opts.moduleAbs, "gradle", "wrapper", "gradle-wrapper.properties"), opts.projectRootReal, fs);
  if (!propsVerified.ok) {
    return { ok: false, code: propsVerified.code, reason: `gradle-wrapper.properties 확인 실패: ${propsVerified.reason}` };
  }
  const jarVerified = verifyRegularFileWithinRoot(join(opts.moduleAbs, "gradle", "wrapper", "gradle-wrapper.jar"), opts.projectRootReal, fs);
  if (!jarVerified.ok) {
    return { ok: false, code: jarVerified.code, reason: `gradle-wrapper.jar 확인 실패: ${jarVerified.reason}` };
  }

  if (platform !== "win32") {
    return {
      ok: true,
      requestedName: "gradlew",
      executableKind: "gradlew",
      trustSource: "project_local_dependency",
      verified: true,
      spawnCommand: wrapperVerified.real,
      spawnArgsPrefix: [],
      canonicalPath: wrapperVerified.real,
    };
  }

  // Windows — gradlew.bat은 shell:false로 직접 spawn할 수 없다(§ 파일 상단 설명). 실제
  // wrapper.bat이 하는 일을 그대로 재현한다: JAVA_HOME(또는 AUTODEV_TRUSTED_JAVA_HOME)의
  // java.exe로 gradle-wrapper.jar의 GradleWrapperMain을 직접 실행한다.
  const javaHome = readEnv("AUTODEV_TRUSTED_JAVA_HOME", opts.testDeps) ?? readEnv("JAVA_HOME", opts.testDeps);
  if (!javaHome || javaHome.trim().length === 0) {
    return {
      ok: false,
      code: "TRUSTED_EXECUTABLE_NOT_FOUND",
      reason: "Windows에서 Gradle Wrapper를 실행하려면 JAVA_HOME(또는 AUTODEV_TRUSTED_JAVA_HOME)이 설정돼 있어야 합니다.",
    };
  }
  const javaVerified = verifyRegularFileOutsideExcluded(join(javaHome, "bin", "java.exe"), [...opts.excludedRootsForJava], fs);
  if (!javaVerified.ok) {
    return { ok: false, code: javaVerified.code, reason: `java.exe(JAVA_HOME 기준) 확인 실패: ${javaVerified.reason}` };
  }

  return {
    ok: true,
    requestedName: "gradlew",
    executableKind: "gradlew",
    trustSource: "project_local_dependency",
    verified: true,
    spawnCommand: javaVerified.real,
    spawnArgsPrefix: ["-cp", jarVerified.real, "org.gradle.wrapper.GradleWrapperMain"],
    // 사람이 읽는 canonical identity는 실제 spawn 대상(java)이 아니라 여전히 gradlew.bat
    // 자체로 유지한다 — npm/npx의 canonicalPath 관례(spawnCommand가 아니라 실제 JS
    // 진입점)와 유사하게, "이 실행이 논리적으로 무엇을 실행하는가"를 감사 로그에서 바로
    // 알아볼 수 있게 한다.
    canonicalPath: wrapperVerified.real,
  };
}
