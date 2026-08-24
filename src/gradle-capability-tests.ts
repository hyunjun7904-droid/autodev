import { join } from "node:path";
import {
  coreGradleCommandSafetyGate,
  classifyGradleTaskName,
  resolveTrustedGradleWrapper,
  GRADLE_TASK_ALLOWLIST_BY_CAPABILITY,
} from "./gradle-capability";
import type { GradleWrapperResolveTestDeps } from "./gradle-capability";

// SI-3.7(Execution Contract Closure, EP-2) — gradle-capability.ts 단위 테스트. 실제
// 파일시스템/Java/Gradle을 전혀 쓰지 않는다 — resolveTrustedGradleWrapper()의 fs injection
// seam(testDeps)으로 deterministic하게 검증한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

// ---------------------------------------------------------------------------
// 1) coreGradleCommandSafetyGate — allow-list/구조 검증
// ---------------------------------------------------------------------------
function scenarioCommandSafetyGate(): void {
  check("classify-test) test → GRADLE_WRAPPER_TEST", classifyGradleTaskName("test") === "GRADLE_WRAPPER_TEST");
  check("classify-assemble) assembleDebug → GRADLE_WRAPPER_BUILD", classifyGradleTaskName("assembleDebug") === "GRADLE_WRAPPER_BUILD");
  check("classify-lint) lint → GRADLE_WRAPPER_LINT", classifyGradleTaskName("lint") === "GRADLE_WRAPPER_LINT");
  check("classify-connected) connectedAndroidTest → GRADLE_WRAPPER_CONNECTED_TEST", classifyGradleTaskName("connectedAndroidTest") === "GRADLE_WRAPPER_CONNECTED_TEST");
  check("classify-unknown) publish → null", classifyGradleTaskName("publish") === null);

  check("gate-gradlew-test-ok) gradlew test → ok", coreGradleCommandSafetyGate("gradlew", ["test"]).ok === true);
  check("gate-gradlew-bat-test-ok) gradlew.bat test → ok(정규화)", coreGradleCommandSafetyGate("gradlew.bat", ["test"]).ok === true);
  check("gate-gradlew-cased-ok) GRADLEW.BAT TEST arg는 소문자 command만 정규화(task 대소문자는 그대로)", coreGradleCommandSafetyGate("GRADLEW.BAT", ["test"]).ok === true);

  const noArgs = coreGradleCommandSafetyGate("gradlew", []);
  check("gate-no-args-fail) 인자 없음 → 거부", noArgs.ok === false);

  const extraArgs = coreGradleCommandSafetyGate("gradlew", ["test", "--stacktrace"]);
  check("gate-extra-args-fail) 인자 2개(추가 플래그) → 거부", extraArgs.ok === false);

  const initScript = coreGradleCommandSafetyGate("gradlew", ["--init-script=evil.gradle"]);
  check("gate-init-script-fail) --init-script 단독 인자도 allow-listed task가 아니라 거부", initScript.ok === false);

  const unsupportedTask = coreGradleCommandSafetyGate("gradlew", ["publish"]);
  check("gate-unsupported-task-fail) publish → 거부(allow-list 밖)", unsupportedTask.ok === false);

  const dotSlash = coreGradleCommandSafetyGate("./gradlew", ["test"]);
  check("gate-dotslash-fail) ./gradlew → 거부(경로 구분자)", dotSlash.ok === false);

  const dotDotSlash = coreGradleCommandSafetyGate("../gradlew", ["test"]);
  check("gate-dotdotslash-fail) ../gradlew → 거부(경로 구분자)", dotDotSlash.ok === false);

  const absoluteWin = coreGradleCommandSafetyGate("C:\\tools\\gradlew.bat", ["test"]);
  check("gate-absolute-win-fail) C:\\tools\\gradlew.bat → 거부(드라이브 문자)", absoluteWin.ok === false);

  const shellWrapper = coreGradleCommandSafetyGate("sh", ["-c", "./gradlew test"]);
  check("gate-shell-wrapper-fail) sh -c \"./gradlew test\" → 거부(gradlew가 아닌 command)", shellWrapper.ok === false);

  const notGradlew = coreGradleCommandSafetyGate("gradle", ["test"]);
  check("gate-not-gradlew-fail) 시스템 전역 gradle(래퍼가 아님) → 거부", notGradlew.ok === false);

  for (const capability of Object.keys(GRADLE_TASK_ALLOWLIST_BY_CAPABILITY) as (keyof typeof GRADLE_TASK_ALLOWLIST_BY_CAPABILITY)[]) {
    for (const taskName of GRADLE_TASK_ALLOWLIST_BY_CAPABILITY[capability]) {
      const r = coreGradleCommandSafetyGate("gradlew", [taskName]);
      check(`gate-allowlist-${capability}-${taskName}-ok) 정상 capability task → ok`, r.ok === true && r.ok && r.capability === capability);
    }
  }
}

// ---------------------------------------------------------------------------
// 2) resolveTrustedGradleWrapper — fs injection 기반 Trusted Resolution
// ---------------------------------------------------------------------------
const PROJECT_ROOT = join("C:", "fixture-project");
const MODULE_ABS = join(PROJECT_ROOT, "android");
const OUTSIDE_MODULE_ABS = join("C:", "outside", "android");

function makeTestDeps(existingFiles: readonly string[], opts: { realOverrides?: Record<string, string>; envOverride?: Record<string, string | undefined> } = {}): GradleWrapperResolveTestDeps {
  const fileSet = new Set(existingFiles.map((f) => f.toLowerCase()));
  return {
    existsSyncImpl: (p: string) => fileSet.has(p.toLowerCase()),
    statSyncImpl: (p: string) => ({ isFile: () => fileSet.has(p.toLowerCase()) }),
    realpathSyncImpl: (p: string) => opts.realOverrides?.[p] ?? p,
    envOverride: opts.envOverride,
  };
}

function scenarioResolvePosix(): void {
  const wrapper = join(MODULE_ABS, "gradlew");
  const props = join(MODULE_ABS, "gradle", "wrapper", "gradle-wrapper.properties");
  const jar = join(MODULE_ABS, "gradle", "wrapper", "gradle-wrapper.jar");

  const okResult = resolveTrustedGradleWrapper({
    moduleAbs: MODULE_ABS,
    projectRootReal: PROJECT_ROOT,
    excludedRootsForJava: [],
    platform: "linux",
    testDeps: makeTestDeps([wrapper, props, jar]),
  });
  check("posix-ok) wrapper+properties+jar 모두 존재하면 resolve 성공", okResult.ok === true);
  if (okResult.ok) {
    check("posix-ok-spawn) spawnCommand가 gradlew 자신", okResult.spawnCommand === wrapper);
    check("posix-ok-no-prefix) spawnArgsPrefix가 비어있음(직접 실행)", okResult.spawnArgsPrefix.length === 0);
    check("posix-ok-kind) executableKind가 gradlew", okResult.executableKind === "gradlew");
    check("posix-ok-trust-source) trustSource가 project_local_dependency", okResult.trustSource === "project_local_dependency");
  }

  const missingWrapper = resolveTrustedGradleWrapper({
    moduleAbs: MODULE_ABS,
    projectRootReal: PROJECT_ROOT,
    excludedRootsForJava: [],
    platform: "linux",
    testDeps: makeTestDeps([props, jar]), // wrapper 자체가 없음
  });
  check("posix-missing-wrapper-fail) gradlew 파일이 없으면 실패", missingWrapper.ok === false);
  check("posix-missing-wrapper-code) TRUSTED_EXECUTABLE_NOT_FOUND", !missingWrapper.ok && missingWrapper.code === "TRUSTED_EXECUTABLE_NOT_FOUND");

  const missingProps = resolveTrustedGradleWrapper({
    moduleAbs: MODULE_ABS,
    projectRootReal: PROJECT_ROOT,
    excludedRootsForJava: [],
    platform: "linux",
    testDeps: makeTestDeps([wrapper, jar]), // properties가 없음(신원 증거 누락)
  });
  check("posix-missing-props-fail) gradle-wrapper.properties가 없으면 실패(신원 증거 부족)", missingProps.ok === false);

  const missingJar = resolveTrustedGradleWrapper({
    moduleAbs: MODULE_ABS,
    projectRootReal: PROJECT_ROOT,
    excludedRootsForJava: [],
    platform: "linux",
    testDeps: makeTestDeps([wrapper, props]), // jar가 없음
  });
  check("posix-missing-jar-fail) gradle-wrapper.jar가 없으면 실패(신원 증거 부족)", missingJar.ok === false);

  const outsideRoot = resolveTrustedGradleWrapper({
    moduleAbs: OUTSIDE_MODULE_ABS,
    projectRootReal: PROJECT_ROOT,
    excludedRootsForJava: [],
    platform: "linux",
    testDeps: makeTestDeps([join(OUTSIDE_MODULE_ABS, "gradlew"), join(OUTSIDE_MODULE_ABS, "gradle", "wrapper", "gradle-wrapper.properties"), join(OUTSIDE_MODULE_ABS, "gradle", "wrapper", "gradle-wrapper.jar")]),
  });
  check("posix-outside-root-fail) module 경로가 project root 밖이면 실패", outsideRoot.ok === false);
  check("posix-outside-root-code) EXECUTABLE_SHADOWING_DETECTED", !outsideRoot.ok && outsideRoot.code === "EXECUTABLE_SHADOWING_DETECTED");

  // wrapper 자신의 realpath가 project root 밖을 가리키는 경우(symlink escape 시뮬레이션).
  const escapedReal = join("C:", "outside", "gradlew-real");
  const symlinkEscape = resolveTrustedGradleWrapper({
    moduleAbs: MODULE_ABS,
    projectRootReal: PROJECT_ROOT,
    excludedRootsForJava: [],
    platform: "linux",
    testDeps: makeTestDeps([wrapper, props, jar], { realOverrides: { [wrapper]: escapedReal } }),
  });
  check("posix-symlink-escape-fail) gradlew realpath가 project root 밖이면 실패", symlinkEscape.ok === false);
  check("posix-symlink-escape-code) EXECUTABLE_SHADOWING_DETECTED", !symlinkEscape.ok && symlinkEscape.code === "EXECUTABLE_SHADOWING_DETECTED");
}

function scenarioResolveWindows(): void {
  const wrapperBat = join(MODULE_ABS, "gradlew.bat");
  const props = join(MODULE_ABS, "gradle", "wrapper", "gradle-wrapper.properties");
  const jar = join(MODULE_ABS, "gradle", "wrapper", "gradle-wrapper.jar");
  const javaHome = join("C:", "trusted-jdk");
  const javaExe = join(javaHome, "bin", "java.exe");

  const noJavaHome = resolveTrustedGradleWrapper({
    moduleAbs: MODULE_ABS,
    projectRootReal: PROJECT_ROOT,
    excludedRootsForJava: [PROJECT_ROOT],
    platform: "win32",
    testDeps: makeTestDeps([wrapperBat, props, jar], { envOverride: { JAVA_HOME: undefined, AUTODEV_TRUSTED_JAVA_HOME: undefined } }),
  });
  check("win-no-java-home-fail) JAVA_HOME 미설정 시 실패(fail-closed)", noJavaHome.ok === false);
  check("win-no-java-home-code) TRUSTED_EXECUTABLE_NOT_FOUND", !noJavaHome.ok && noJavaHome.code === "TRUSTED_EXECUTABLE_NOT_FOUND");

  const okResult = resolveTrustedGradleWrapper({
    moduleAbs: MODULE_ABS,
    projectRootReal: PROJECT_ROOT,
    excludedRootsForJava: [PROJECT_ROOT, MODULE_ABS],
    platform: "win32",
    testDeps: makeTestDeps([wrapperBat, props, jar, javaExe], { envOverride: { JAVA_HOME: javaHome } }),
  });
  check("win-ok) JAVA_HOME이 유효하면 resolve 성공", okResult.ok === true);
  if (okResult.ok) {
    check("win-ok-spawn-is-java) spawnCommand가 java.exe", okResult.spawnCommand === javaExe);
    check(
      "win-ok-args-prefix) spawnArgsPrefix가 -cp <jar> GradleWrapperMain",
      okResult.spawnArgsPrefix.length === 3 && okResult.spawnArgsPrefix[0] === "-cp" && okResult.spawnArgsPrefix[1] === jar && okResult.spawnArgsPrefix[2] === "org.gradle.wrapper.GradleWrapperMain"
    );
    check("win-ok-canonical-is-wrapper) canonicalPath는 여전히 gradlew.bat 자신", okResult.canonicalPath === wrapperBat);
  }

  const explicitOverride = resolveTrustedGradleWrapper({
    moduleAbs: MODULE_ABS,
    projectRootReal: PROJECT_ROOT,
    excludedRootsForJava: [PROJECT_ROOT, MODULE_ABS],
    platform: "win32",
    testDeps: makeTestDeps([wrapperBat, props, jar, javaExe], {
      envOverride: { JAVA_HOME: join("C:", "wrong-jdk"), AUTODEV_TRUSTED_JAVA_HOME: javaHome },
    }),
  });
  check("win-explicit-override-wins) AUTODEV_TRUSTED_JAVA_HOME이 JAVA_HOME보다 우선", explicitOverride.ok === true);

  const javaInProjectRoot = resolveTrustedGradleWrapper({
    moduleAbs: MODULE_ABS,
    projectRootReal: PROJECT_ROOT,
    excludedRootsForJava: [PROJECT_ROOT, MODULE_ABS],
    platform: "win32",
    testDeps: makeTestDeps([wrapperBat, props, jar, join(PROJECT_ROOT, "bin", "java.exe")], { envOverride: { JAVA_HOME: PROJECT_ROOT } }),
  });
  check("win-java-in-excluded-root-fail) JAVA_HOME이 신뢰할 수 없는 위치(project root)를 가리키면 실패", javaInProjectRoot.ok === false);
  check("win-java-in-excluded-root-code) EXECUTABLE_SHADOWING_DETECTED", !javaInProjectRoot.ok && javaInProjectRoot.code === "EXECUTABLE_SHADOWING_DETECTED");

  const javaExeMissing = resolveTrustedGradleWrapper({
    moduleAbs: MODULE_ABS,
    projectRootReal: PROJECT_ROOT,
    excludedRootsForJava: [PROJECT_ROOT, MODULE_ABS],
    platform: "win32",
    testDeps: makeTestDeps([wrapperBat, props, jar], { envOverride: { JAVA_HOME: javaHome } }), // java.exe 자체가 없음
  });
  check("win-java-exe-missing-fail) JAVA_HOME은 있지만 java.exe가 없으면 실패", javaExeMissing.ok === false);
}

async function main(): Promise<void> {
  scenarioCommandSafetyGate();
  scenarioResolvePosix();
  scenarioResolveWindows();

  for (const r of results) console.log(r);
  const fail = results.filter((r) => r.startsWith("[FAIL]")).length;
  const pass = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${pass}, FAIL ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
