import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkRequiredTestScriptRegistration,
  attemptSafeRequiredTestScriptRepair,
  reconcileStaleRequiredTestConfigurationTasks,
  validateRequiredTestRegistrationRequest,
  registerValidatedRequiredTestScripts,
  checkRequiredTestExecutionEnvironment,
  evaluateGreenfieldDefer,
  reconcileStaleRequiredTestExecutionEnvironmentTasks,
} from "./required-test-preflight";
import type { RequiredTestCommand, TaskDefinition } from "./task-registry";

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}
function skip(label: string): void {
  results.push(`[SKIP] ${label}`);
}

function makeProjectRoot(pkgScripts: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "autodev-required-test-preflight-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", scripts: pkgScripts }, null, 2) + "\n", "utf-8");
  return root;
}

function npmRun(name: string, script: string): RequiredTestCommand {
  return { name, command: "npm", args: ["run", script], cwd: "root" };
}

// ---------------------------------------------------------------------------
// A) checkRequiredTestScriptRegistration
// ---------------------------------------------------------------------------
function scenarioRegisteredScriptPasses(): void {
  const root = makeProjectRoot({ "test:foo": "node src/foo.test.mjs" });
  try {
    const result = checkRequiredTestScriptRegistration([npmRun("foo-test", "test:foo")], root);
    check("A) 이미 등록된 npm run script는 issue 없이 ok=true", result.ok === true && result.issues.length === 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioMissingScriptFlagged(): void {
  const root = makeProjectRoot({});
  try {
    const result = checkRequiredTestScriptRegistration([npmRun("bar-test", "test:bar")], root);
    check(
      "A) 등록되지 않은 npm run script는 issue로 보고되고 ok=false",
      result.ok === false && result.issues.length === 1 && result.issues[0].npmScript === "test:bar"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioNonNpmRunCommandsIgnored(): void {
  const root = makeProjectRoot({});
  try {
    const gradle: RequiredTestCommand = { name: "android-test", command: "gradlew", args: ["testDebugUnitTest"], cwd: "root" };
    const npx: RequiredTestCommand = { name: "typecheck", command: "npx", args: ["tsc", "--noEmit"], cwd: "root" };
    const result = checkRequiredTestScriptRegistration([gradle, npx], root);
    check("A) gradlew/npx 형태는 이 preflight 대상이 아니므로 항상 ok=true", result.ok === true && result.issues.length === 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioUnsupportedCwdSkipped(): void {
  const root = makeProjectRoot({});
  try {
    const rt: RequiredTestCommand = { name: "aliased", command: "npm", args: ["run", "test:aliased"], cwd: "some-alias" };
    const result = checkRequiredTestScriptRegistration([rt], root);
    check(
      "A) cwd!=='root'인 required test는 검증 대상에서 제외되고 skippedUnsupportedCwd에 기록됨",
      result.ok === true && result.issues.length === 0 && result.skippedUnsupportedCwd.includes("aliased")
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioUnreadablePackageJsonFlagsAllNpmRunEntries(): void {
  const root = mkdtempSync(join(tmpdir(), "autodev-required-test-preflight-"));
  // package.json을 아예 만들지 않는다 — 읽기 자체가 실패하는 상황.
  try {
    const result = checkRequiredTestScriptRegistration([npmRun("x", "test:x"), npmRun("y", "test:y")], root);
    check(
      "A) package.json을 읽을 수 없으면 npm run 형태 required test 전부를 issue로 보고함(조용히 PASS하지 않음)",
      result.ok === false && result.issues.length === 2
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// B) attemptSafeRequiredTestScriptRepair
// ---------------------------------------------------------------------------
function scenarioExactlyOneCandidateIsSafelyRegistered(): void {
  const root = makeProjectRoot({});
  try {
    mkdirSync(join(root, "src", "db", "schema"), { recursive: true });
    writeFileSync(join(root, "src", "db", "schema", "supabase-secure-storage-schema.test.mjs"), "// fixture test\n", "utf-8");

    const issue = { requiredTestName: "secret-storage-isolation-validation", npmScript: "test:jarvis-storage-isolation" };
    const repair = attemptSafeRequiredTestScriptRepair([issue], root, ["src/db/schema/"]);

    check("B) 후보가 정확히 1개면 repaired에 담김", repair.repaired.length === 1 && repair.unresolved.length === 0);
    check(
      "B) expectedScript가 실제 파일 상대경로를 가리키는 node 명령으로 계산됨",
      repair.repaired[0]?.expectedScript === "node src/db/schema/supabase-secure-storage-schema.test.mjs"
    );

    const pkgAfter = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    check(
      "B) package.json에 실제로 반영됨",
      pkgAfter.scripts["test:jarvis-storage-isolation"] === "node src/db/schema/supabase-secure-storage-schema.test.mjs"
    );

    const recheck = checkRequiredTestScriptRegistration(
      [{ name: issue.requiredTestName, command: "npm", args: ["run", issue.npmScript], cwd: "root" }],
      root
    );
    check("B) 복구 이후 재검사하면 ok=true(같은 preflight가 통과로 재분류)", recheck.ok === true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioZeroCandidatesAreUnresolvedWithoutFabrication(): void {
  const root = makeProjectRoot({});
  try {
    const issue = { requiredTestName: "not-yet-built", npmScript: "test:not-yet-built" };
    const repair = attemptSafeRequiredTestScriptRepair([issue], root, ["src/not/created/yet/"]);
    check("B) 후보 파일이 0개면 unresolved로만 분류되고 package.json은 그대로", repair.repaired.length === 0 && repair.unresolved.length === 1);
    const pkgAfter = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    check("B) 후보가 없을 때 package.json에 어떤 스크립트도 발명해 추가하지 않음", Object.keys(pkgAfter.scripts).length === 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioAmbiguousCandidatesAreUnresolved(): void {
  const root = makeProjectRoot({});
  try {
    mkdirSync(join(root, "src", "a"), { recursive: true });
    mkdirSync(join(root, "src", "b"), { recursive: true });
    writeFileSync(join(root, "src", "a", "one.test.mjs"), "// a\n", "utf-8");
    writeFileSync(join(root, "src", "b", "two.test.mjs"), "// b\n", "utf-8");

    const issue = { requiredTestName: "ambiguous", npmScript: "test:ambiguous" };
    const repair = attemptSafeRequiredTestScriptRepair([issue], root, ["src/a/", "src/b/"]);
    check("B) 후보가 2개 이상이면 모호함으로 unresolved 처리(추측하지 않음)", repair.repaired.length === 0 && repair.unresolved.length === 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioNeverOverwritesExistingConflictingEntry(): void {
  const root = makeProjectRoot({ "test:conflict": "node src/some/other/already-wired.test.mjs" });
  try {
    mkdirSync(join(root, "src", "c"), { recursive: true });
    writeFileSync(join(root, "src", "c", "candidate.test.mjs"), "// c\n", "utf-8");

    // check가 "missing"이라고 착각하고 넘겼더라도(예: 상위 호출부의 stale 판단), repair
    // 함수 자신이 package.json을 다시 읽어 이미 존재하는 값을 덮어쓰지 않아야 한다.
    const issue = { requiredTestName: "conflict-test", npmScript: "test:conflict" };
    const repair = attemptSafeRequiredTestScriptRepair([issue], root, ["src/c/"]);

    check("B) 이미 등록된 script key는 절대 덮어쓰지 않고 unresolved로 되돌림", repair.repaired.length === 0 && repair.unresolved.length === 1);
    const pkgAfter = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    check(
      "B) 기존에 등록돼 있던 값이 그대로 보존됨",
      pkgAfter.scripts["test:conflict"] === "node src/some/other/already-wired.test.mjs"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioSymlinkedDirectoryIsNotFollowed(): void {
  const root = makeProjectRoot({});
  const outside = mkdtempSync(join(tmpdir(), "autodev-required-test-preflight-outside-"));
  try {
    writeFileSync(join(outside, "sneaky.test.mjs"), "// outside\n", "utf-8");
    mkdirSync(join(root, "src"), { recursive: true });
    let symlinkOk = true;
    try {
      symlinkSync(outside, join(root, "src", "linked"), "junction");
    } catch {
      symlinkOk = false;
    }
    if (!symlinkOk) {
      check("B) symlink 생성 권한 없음 — SKIP(환경 제약, 실패로 위장하지 않음)", true);
      return;
    }
    const issue = { requiredTestName: "no-symlink-follow", npmScript: "test:no-symlink-follow" };
    const repair = attemptSafeRequiredTestScriptRepair([issue], root, ["src/"]);
    check("B) symlink로 연결된 디렉터리 밖 파일은 후보로 인정하지 않음(0개 후보 → unresolved)", repair.repaired.length === 0 && repair.unresolved.length === 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// B') 단일 파일 scope fallback(Phase 12, 2026-08-29 — JARVIS Task 4.6 실측 근본원인).
//     allowedPathPrefixes가 디렉터리가 아니라 정확히 하나의 구체적 파일(예:
//     "backend/memory/memory-manager-api.ts")만 가리키는 task는 *.test.mjs 관례를 따를
//     구조적 방법이 없다(Safe Executor가 그 파일 하나로만 write를 강제) — 그 파일 자체를
//     유일하게 안전한 후보로 인정해야 한다.
// ---------------------------------------------------------------------------
function scenarioSingleFileScopeSelfTestFileIsSafelyRegistered(): void {
  const root = makeProjectRoot({});
  try {
    mkdirSync(join(root, "backend", "memory"), { recursive: true });
    writeFileSync(join(root, "backend", "memory", "memory-manager-api.ts"), "// impl + embedded self-test\n", "utf-8");

    const issue = { requiredTestName: "memory-manager-api-tests", npmScript: "test:memory-manager-api" };
    // allowedPathPrefixes가 디렉터리 슬래시 없이 이 파일 하나만 정확히 가리킨다(실제 JARVIS
    // task-registry.json 4.6과 동일한 형태) — *.test.mjs glob은 0개를 찾지만(디렉터리가
    // 아니므로 findCandidateTestFiles가 아예 훑지 않는다), 이 파일 자체가 유일한 후보다.
    const repair = attemptSafeRequiredTestScriptRepair([issue], root, ["backend/memory/memory-manager-api.ts"]);

    check("B') 디렉터리 없는 단일 파일 scope도 후보로 인정되어 repaired에 담김", repair.repaired.length === 1 && repair.unresolved.length === 0);
    check(
      "B') expectedScript가 그 파일을 그대로 가리키는 node 명령으로 계산됨",
      repair.repaired[0]?.expectedScript === "node backend/memory/memory-manager-api.ts"
    );
    const pkgAfter = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    check(
      "B') package.json에 실제로 반영됨",
      pkgAfter.scripts["test:memory-manager-api"] === "node backend/memory/memory-manager-api.ts"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioSingleFileScopeNotYetImplementedStaysUnresolved(): void {
  const root = makeProjectRoot({});
  try {
    // 파일이 아직 만들어지지 않은 정상 "구현 전" 상태 — 파일명을 추측해 만들어내지 않는다.
    const issue = { requiredTestName: "not-yet-built", npmScript: "test:not-yet-built" };
    const repair = attemptSafeRequiredTestScriptRepair([issue], root, ["backend/memory/not-yet-created.ts"]);
    check("B') 단일 파일 scope라도 파일이 아직 없으면 unresolved(추측하지 않음)", repair.repaired.length === 0 && repair.unresolved.length === 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioSingleFileScopeWithNonExecutableExtensionStaysUnresolved(): void {
  const root = makeProjectRoot({});
  try {
    mkdirSync(join(root, "backend", "memory"), { recursive: true });
    writeFileSync(join(root, "backend", "memory", "config.json"), "{}\n", "utf-8");

    const issue = { requiredTestName: "config-tests", npmScript: "test:config" };
    const repair = attemptSafeRequiredTestScriptRepair([issue], root, ["backend/memory/config.json"]);
    check(
      "B') 실행 가능한 확장자가 아닌 단일 파일 scope(.json 등)는 후보로 인정하지 않음",
      repair.repaired.length === 0 && repair.unresolved.length === 1
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioMultiplePrefixesNeverUseSingleFileFallback(): void {
  const root = makeProjectRoot({});
  try {
    mkdirSync(join(root, "backend", "memory"), { recursive: true });
    writeFileSync(join(root, "backend", "memory", "memory-manager-api.ts"), "// impl\n", "utf-8");
    mkdirSync(join(root, "backend", "other"), { recursive: true });

    // allowedPathPrefixes가 2개 이상이면(하나가 단일 파일이어도) 모호함으로 보고 fallback을
    // 적용하지 않는다 — "정확히 하나의 scope"일 때만 안전하다(§ 요구사항).
    const issue = { requiredTestName: "ambiguous-multi-prefix", npmScript: "test:ambiguous-multi-prefix" };
    const repair = attemptSafeRequiredTestScriptRepair([issue], root, ["backend/memory/memory-manager-api.ts", "backend/other/"]);
    check("B') allowedPathPrefixes가 2개 이상이면 단일 파일 fallback을 적용하지 않음", repair.repaired.length === 0 && repair.unresolved.length === 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// C) reconcileStaleRequiredTestConfigurationTasks — 오래된 REQUIRED_TEST_CONFIGURATION_ERROR
//    WAITING_HUMAN 재검사(Phase 5).
// ---------------------------------------------------------------------------
function scenarioReconcileResolvedWhenAllScriptsNowRegistered(): void {
  const root = makeProjectRoot({ "test:device-trust-registration": "node backend/device-trust/device-trust-registration.test.mjs", "test:device-trust-revocation": "node backend/device-trust/device-trust-revocation.test.mjs" });
  try {
    const result = reconcileStaleRequiredTestConfigurationTasks(
      [
        "REQUIRED_TEST_CONFIGURATION_ERROR: task=2.1 requiredTest=device-trust-registration-tests missingScript=test:device-trust-registration",
        "REQUIRED_TEST_CONFIGURATION_ERROR: task=2.1 requiredTest=device-trust-revocation-tests missingScript=test:device-trust-revocation",
      ],
      root
    );
    check("C) 전부 REQUIRED_TEST_CONFIGURATION_ERROR 형태 + 전부 등록됨 → resolved=true", result.resolved === true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioReconcileNotResolvedWhenStillMissing(): void {
  const root = makeProjectRoot({ "test:device-trust-registration": "node backend/device-trust/device-trust-registration.test.mjs" });
  try {
    const result = reconcileStaleRequiredTestConfigurationTasks(
      [
        "REQUIRED_TEST_CONFIGURATION_ERROR: task=2.1 requiredTest=device-trust-registration-tests missingScript=test:device-trust-registration",
        "REQUIRED_TEST_CONFIGURATION_ERROR: task=2.1 requiredTest=device-trust-revocation-tests missingScript=test:device-trust-revocation",
      ],
      root
    );
    check("C) 일부만 등록됨 → resolved=false(전부 해소돼야만 안전하게 복구)", result.resolved === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioReconcileFailClosedOnUnrelatedReason(): void {
  const root = makeProjectRoot({ "test:device-trust-registration": "node backend/device-trust/device-trust-registration.test.mjs" });
  try {
    const result = reconcileStaleRequiredTestConfigurationTasks(
      [
        "REQUIRED_TEST_CONFIGURATION_ERROR: task=2.1 requiredTest=device-trust-registration-tests missingScript=test:device-trust-registration",
        "HUMAN_FINAL_REVIEW_PENDING(2.1): reviewer APPROVED — checkpoint 전 사람의 최종 승인이 필요합니다.",
      ],
      root
    );
    check(
      "C) 실제 사람 판단이 필요한 다른 사유가 섞여 있으면 fail-closed로 resolved=false(자동 해제 안 함)",
      result.resolved === false
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioReconcileEmptyIsNotResolved(): void {
  const root = makeProjectRoot({});
  try {
    const result = reconcileStaleRequiredTestConfigurationTasks([], root);
    check("C) deferredHumanTasks가 비어 있으면 resolved=false(재검사할 대상 자체가 없음)", result.resolved === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// D~K) Phase 8 — Developer-declared Required Test Registration Channel
// ---------------------------------------------------------------------------
function scenarioDeclaredRegistrationValidAndRegistered(): void {
  // D) Developer가 유효한 test target 생성 및 registration 선언 → 검증 후 등록.
  const root = makeProjectRoot({});
  try {
    mkdirSync(join(root, "backend", "device-trust"), { recursive: true });
    writeFileSync(join(root, "backend", "device-trust", "device-trust-revocation.test.mjs"), "// fixture\n", "utf-8");
    const requiredTests = [npmRun("device-trust-revocation-tests", "test:device-trust-revocation")];
    const outcome = registerValidatedRequiredTestScripts(
      [{ scriptName: "test:device-trust-revocation", runner: "node", target: "backend/device-trust/device-trust-revocation.test.mjs" }],
      requiredTests,
      ["backend/device-trust/"],
      root,
      ["backend/device-trust/device-trust-revocation.test.mjs"]
    );
    check("D) 유효한 registration은 REGISTERED로 분류됨", outcome.outcomes[0]?.outcome === "REGISTERED");
    check("D) toCommit에 정확히 1건 반영됨", outcome.toCommit.length === 1);
    const pkgAfter = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    check(
      "D) package.json에 실제로 등록되어 이후 preflight가 통과함",
      pkgAfter.scripts["test:device-trust-revocation"] === "node backend/device-trust/device-trust-revocation.test.mjs"
    );
    const recheck = checkRequiredTestScriptRegistration(requiredTests, root);
    check("D) 등록 이후 재검사하면 ok=true", recheck.ok === true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioUnknownScriptNameRejected(): void {
  // E) Developer가 임의 script 이름 요청 → 거부.
  const root = makeProjectRoot({});
  try {
    mkdirSync(join(root, "backend", "device-trust"), { recursive: true });
    writeFileSync(join(root, "backend", "device-trust", "sneaky.test.mjs"), "// fixture\n", "utf-8");
    const requiredTests = [npmRun("device-trust-revocation-tests", "test:device-trust-revocation")];
    const validation = validateRequiredTestRegistrationRequest(
      { scriptName: "test:not-a-real-required-test", runner: "node", target: "backend/device-trust/sneaky.test.mjs" },
      requiredTests,
      ["backend/device-trust/"],
      root,
      ["backend/device-trust/sneaky.test.mjs"]
    );
    check("E) canonical requiredTests에 없는 임의 scriptName은 거부됨", validation.ok === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioOutsideWritablePathRejected(): void {
  // F) Developer가 writablePaths 밖 target 요청 → 거부.
  const root = makeProjectRoot({});
  try {
    mkdirSync(join(root, "src", "outside"), { recursive: true });
    writeFileSync(join(root, "src", "outside", "sneaky.test.mjs"), "// fixture\n", "utf-8");
    const requiredTests = [npmRun("device-trust-revocation-tests", "test:device-trust-revocation")];
    const validation = validateRequiredTestRegistrationRequest(
      { scriptName: "test:device-trust-revocation", runner: "node", target: "src/outside/sneaky.test.mjs" },
      requiredTests,
      ["backend/device-trust/"],
      root,
      ["src/outside/sneaky.test.mjs"]
    );
    check("F) allowedPathPrefixes 밖 target은 거부됨", validation.ok === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioAbsoluteDotDotUncRejected(): void {
  // G) absolute/../UNC path → 거부.
  const root = makeProjectRoot({});
  try {
    const requiredTests = [npmRun("device-trust-revocation-tests", "test:device-trust-revocation")];
    const cases = ["/etc/passwd.test.mjs", "C:\\evil\\file.test.mjs", "backend/device-trust/../../../etc/evil.test.mjs", "//server/share/evil.test.mjs"];
    let allRejected = true;
    for (const target of cases) {
      const validation = validateRequiredTestRegistrationRequest(
        { scriptName: "test:device-trust-revocation", runner: "node", target },
        requiredTests,
        ["backend/device-trust/"],
        root,
        [target]
      );
      if (validation.ok) allRejected = false;
    }
    check("G) absolute/traversal/UNC 경로는 전부 거부됨", allRejected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioShellInjectionRejected(): void {
  // H) shell injection 형태 command → 거부.
  const root = makeProjectRoot({});
  try {
    const requiredTests = [npmRun("device-trust-revocation-tests", "test:device-trust-revocation")];
    const cases = [
      "backend/device-trust/x.test.mjs; rm -rf /",
      "backend/device-trust/x.test.mjs && echo pwned",
      "backend/device-trust/x.test.mjs`whoami`",
      "backend/device-trust/x.test.mjs | cat /etc/passwd",
      "backend/device-trust/x.test.mjs$(id)",
    ];
    let allRejected = true;
    for (const target of cases) {
      const validation = validateRequiredTestRegistrationRequest(
        { scriptName: "test:device-trust-revocation", runner: "node", target },
        requiredTests,
        ["backend/device-trust/"],
        root,
        [target]
      );
      if (validation.ok) allRejected = false;
    }
    check("H) shell metacharacter가 포함된 target은 전부 거부됨", allRejected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioConflictingTargetIsDriftNotOverwrite(): void {
  // I) 기존 script와 다른 target 충돌 → 자동 overwrite 금지, drift 분류.
  const root = makeProjectRoot({ "test:device-trust-revocation": "node backend/device-trust/original.test.mjs" });
  try {
    mkdirSync(join(root, "backend", "device-trust"), { recursive: true });
    writeFileSync(join(root, "backend", "device-trust", "different.test.mjs"), "// fixture\n", "utf-8");
    const requiredTests = [npmRun("device-trust-revocation-tests", "test:device-trust-revocation")];
    const outcome = registerValidatedRequiredTestScripts(
      [{ scriptName: "test:device-trust-revocation", runner: "node", target: "backend/device-trust/different.test.mjs" }],
      requiredTests,
      ["backend/device-trust/"],
      root,
      ["backend/device-trust/different.test.mjs"]
    );
    check("I) 기존 값과 다른 target 요청은 DRIFT로 분류됨", outcome.outcomes[0]?.outcome === "DRIFT");
    check("I) 자동 덮어쓰기하지 않음(toCommit 비어있음)", outcome.toCommit.length === 0);
    const pkgAfter = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    check("I) 기존 등록값이 그대로 보존됨", pkgAfter.scripts["test:device-trust-revocation"] === "node backend/device-trust/original.test.mjs");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioIdempotentDoubleRegistration(): void {
  // J) 동일 registration 두 번 수행 → 두 번째는 변경 없음.
  const root = makeProjectRoot({});
  try {
    mkdirSync(join(root, "backend", "device-trust"), { recursive: true });
    writeFileSync(join(root, "backend", "device-trust", "device-trust-revocation.test.mjs"), "// fixture\n", "utf-8");
    const requiredTests = [npmRun("device-trust-revocation-tests", "test:device-trust-revocation")];
    const request = [{ scriptName: "test:device-trust-revocation", runner: "node", target: "backend/device-trust/device-trust-revocation.test.mjs" }];
    const changedFiles = ["backend/device-trust/device-trust-revocation.test.mjs"];

    const first = registerValidatedRequiredTestScripts(request, requiredTests, ["backend/device-trust/"], root, changedFiles);
    check("J) 첫 번째 등록은 REGISTERED", first.outcomes[0]?.outcome === "REGISTERED");

    const second = registerValidatedRequiredTestScripts(request, requiredTests, ["backend/device-trust/"], root, changedFiles);
    check("J) 두 번째 등록은 ALREADY_REGISTERED(추가 변경 없음)", second.outcomes[0]?.outcome === "ALREADY_REGISTERED" && second.toCommit.length === 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioNonExistentTargetRejected(): void {
  const root = makeProjectRoot({});
  try {
    const requiredTests = [npmRun("device-trust-revocation-tests", "test:device-trust-revocation")];
    const validation = validateRequiredTestRegistrationRequest(
      { scriptName: "test:device-trust-revocation", runner: "node", target: "backend/device-trust/not-created-yet.test.mjs" },
      requiredTests,
      ["backend/device-trust/"],
      root,
      ["backend/device-trust/not-created-yet.test.mjs"]
    );
    check("실제로 존재하지 않는 target은 거부됨(추측으로 등록하지 않음)", validation.ok === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioNotInChangedFilesRejected(): void {
  const root = makeProjectRoot({});
  try {
    mkdirSync(join(root, "backend", "device-trust"), { recursive: true });
    writeFileSync(join(root, "backend", "device-trust", "device-trust-revocation.test.mjs"), "// fixture\n", "utf-8");
    const requiredTests = [npmRun("device-trust-revocation-tests", "test:device-trust-revocation")];
    const validation = validateRequiredTestRegistrationRequest(
      { scriptName: "test:device-trust-revocation", runner: "node", target: "backend/device-trust/device-trust-revocation.test.mjs" },
      requiredTests,
      ["backend/device-trust/"],
      root,
      [] // 이번 attempt의 changedFiles에 없음
    );
    check("이번 attempt의 changedFiles에 없는 target은 거부됨", validation.ok === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioDisallowedRunnerRejected(): void {
  const root = makeProjectRoot({});
  try {
    mkdirSync(join(root, "backend", "device-trust"), { recursive: true });
    writeFileSync(join(root, "backend", "device-trust", "device-trust-revocation.test.mjs"), "// fixture\n", "utf-8");
    const requiredTests = [npmRun("device-trust-revocation-tests", "test:device-trust-revocation")];
    const validation = validateRequiredTestRegistrationRequest(
      { scriptName: "test:device-trust-revocation", runner: "bash", target: "backend/device-trust/device-trust-revocation.test.mjs" },
      requiredTests,
      ["backend/device-trust/"],
      root,
      ["backend/device-trust/device-trust-revocation.test.mjs"]
    );
    check("allow-list 밖 runner(bash 등)는 거부됨", validation.ok === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioWhitespaceArgumentSmugglingRejected(): void {
  // 공백으로 추가 CLI flag를 밀반입해 node 실행 시점에 임의 모듈을 로드시키는 시도 방지.
  const root = makeProjectRoot({});
  try {
    const requiredTests = [npmRun("device-trust-revocation-tests", "test:device-trust-revocation")];
    const validation = validateRequiredTestRegistrationRequest(
      { scriptName: "test:device-trust-revocation", runner: "node", target: "backend/device-trust/x.test.mjs --require /tmp/evil.js" },
      requiredTests,
      ["backend/device-trust/"],
      root,
      ["backend/device-trust/x.test.mjs --require /tmp/evil.js"]
    );
    check("target에 공백으로 추가 CLI flag를 밀반입하려는 요청은 거부됨", validation.ok === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioLifecycleScriptNameRejected(): void {
  const root = makeProjectRoot({});
  try {
    const validation = validateRequiredTestRegistrationRequest(
      { scriptName: "postinstall", runner: "node", target: "backend/device-trust/device-trust-revocation.test.mjs" },
      [npmRun("x", "postinstall")],
      ["backend/device-trust/"],
      root,
      ["backend/device-trust/device-trust-revocation.test.mjs"]
    );
    check("K) npm lifecycle hook 이름(postinstall 등)은 명시적으로 거부됨", validation.ok === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// L) checkRequiredTestExecutionEnvironment — AutoDev Core Maintenance(2026-08-30)
// ---------------------------------------------------------------------------
function makeExecutionEnvRoot(): string {
  return mkdtempSync(join(tmpdir(), "autodev-required-test-exec-env-"));
}

function makeGradleModule(moduleAbs: string): void {
  mkdirSync(join(moduleAbs, "gradle", "wrapper"), { recursive: true });
  writeFileSync(join(moduleAbs, "gradlew"), "#!/bin/sh\necho gradlew\n", "utf-8");
  writeFileSync(join(moduleAbs, "gradlew.bat"), "@echo off\r\necho gradlew\r\n", "utf-8");
  writeFileSync(join(moduleAbs, "gradle", "wrapper", "gradle-wrapper.properties"), "distributionUrl=https://example.invalid/gradle.zip\n", "utf-8");
  writeFileSync(join(moduleAbs, "gradle", "wrapper", "gradle-wrapper.jar"), "fixture-jar-bytes", "utf-8");
}

function makeExecutor(root: string, commandCwdAliases?: Record<string, string>) {
  return { projectRoot: root, projectRootReal: realpathSync(root), policy: { commandCwdAliases } };
}

// resolveTrustedGradleWrapper의 win32 분기는 JAVA_HOME을 요구한다(§ gradle-capability.ts) —
// 이 회귀 테스트는 wrapper 파일 존재/신뢰 판정 자체만 검증하면 충분하므로, platform을
// "linux"로 고정해 JAVA_HOME 없이도 결정론적으로 동작하게 한다(posix 분기는 java를 거치지
// 않는다). 실제 production 호출(autodev.ts)은 이 override를 전혀 넘기지 않는다.
const POSIX_OVERRIDE = { platform: "linux" as NodeJS.Platform };

function scenarioRootCwdWithNonGradleCommandOk(): void {
  const root = makeExecutionEnvRoot();
  try {
    const rt: RequiredTestCommand = { name: "unit", command: "npm", args: ["run", "test:unit"], cwd: "root" };
    const result = checkRequiredTestExecutionEnvironment([rt], makeExecutor(root), [], POSIX_OVERRIDE);
    check("L) cwd:root + 비-gradle command는 항상 ok=true(디렉터리는 항상 존재)", result.ok === true && result.issues.length === 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioAliasedCwdDirectoryMissingFlagged(): void {
  const root = makeExecutionEnvRoot();
  try {
    // greenfield defer(§ evaluateGreenfieldDefer)는 alias 대상이 현재 Task의
    // allowedPathPrefixes 안에 있을 때만 적용된다 — 여기서는 의도적으로 allowedPathPrefixes를
    // 다른 경로("frontend/")로 둬서 "backend"가 scope 밖임을 재현한다: 여전히 즉시 BLOCK되어야
    // 한다(TEST 4 — greenfield scope 밖은 defer하지 않는다).
    const rt: RequiredTestCommand = { name: "backend-unit", command: "npm", args: ["run", "test:backend"], cwd: "backend" };
    const result = checkRequiredTestExecutionEnvironment([rt], makeExecutor(root, { backend: "backend" }), ["frontend/"], POSIX_OVERRIDE);
    check(
      "L) alias가 가리키는 디렉터리가 실제로 없고 Task의 allowedPathPrefixes 밖이면 CWD_NOT_FOUND(defer 안 함)",
      result.ok === false &&
        result.issues.length === 1 &&
        result.issues[0].kind === "CWD_NOT_FOUND" &&
        result.issues[0].requiredTestName === "backend-unit" &&
        result.deferredGreenfield.length === 0
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioUndefinedAliasKeySkipped(): void {
  const root = makeExecutionEnvRoot();
  try {
    const rt: RequiredTestCommand = { name: "x", command: "npm", args: ["run", "test:x"], cwd: "no-such-alias" };
    const result = checkRequiredTestExecutionEnvironment([rt], makeExecutor(root, {}), [], POSIX_OVERRIDE);
    check(
      "L) commandCwdAliases에 없는 alias 키는 이 함수의 대상이 아니므로 조용히 skip(ok=true) — execution-contract.ts의 몫",
      result.ok === true && result.issues.length === 0
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioGradlewAtRootWithoutWrapperFlagged(): void {
  // § JARVIS Task 5.2 실제 재현: task-registry.json이 cwd:"root"로 gradlew를 선언했지만
  // 실제 wrapper는 projectRoot에 없다(항상 android/wakeword/ 처럼 하위 module에 있다).
  const root = makeExecutionEnvRoot();
  try {
    const rt: RequiredTestCommand = { name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "root" };
    const result = checkRequiredTestExecutionEnvironment([rt], makeExecutor(root), [], POSIX_OVERRIDE);
    check(
      "L) cwd:root인데 projectRoot에 gradlew wrapper가 없으면 WRAPPER_NOT_FOUND(JARVIS Task 5.2 재현)",
      result.ok === false && result.issues.length === 1 && result.issues[0].kind === "WRAPPER_NOT_FOUND"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioGradlewWithCorrectAliasPasses(): void {
  const root = makeExecutionEnvRoot();
  try {
    makeGradleModule(join(root, "android", "wakeword"));
    const rt: RequiredTestCommand = { name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" };
    const result = checkRequiredTestExecutionEnvironment([rt], makeExecutor(root, { wakeword: "android/wakeword" }), ["android/wakeword/"], POSIX_OVERRIDE);
    check(
      "L/TEST10) 기존 wakeword path 계약 회귀 없음 — alias가 실제 wrapper가 있는 디렉터리를 정확히 가리키면 ok=true(deferredGreenfield도 비어있음)",
      result.ok === true && result.issues.length === 0 && result.deferredGreenfield.length === 0
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioGradlewBatVariantRecognized(): void {
  const root = makeExecutionEnvRoot();
  try {
    const rt: RequiredTestCommand = { name: "wakeword-unit", command: "gradlew.bat", args: ["testDebugUnitTest"], cwd: "root" };
    const result = checkRequiredTestExecutionEnvironment([rt], makeExecutor(root), [], POSIX_OVERRIDE);
    check(
      "L) command이 gradlew.bat(Windows 표기)이어도 동일하게 wrapper 검증 대상(정규화)",
      result.ok === false && result.issues[0].kind === "WRAPPER_NOT_FOUND"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioNonAndroidProjectUnaffected(): void {
  // 일반 Node 프로젝트 회귀 방지 — gradlew가 전혀 없는 project는 이 preflight가 항상 통과한다.
  const root = makeExecutionEnvRoot();
  try {
    const rts: RequiredTestCommand[] = [
      { name: "unit", command: "npm", args: ["run", "test:unit"], cwd: "root" },
      { name: "typecheck", command: "npx", args: ["tsc", "--noEmit"], cwd: "root" },
    ];
    const result = checkRequiredTestExecutionEnvironment(rts, makeExecutor(root), [], POSIX_OVERRIDE);
    check("L) gradlew가 없는 일반 Node 프로젝트는 항상 ok=true(회귀 없음)", result.ok === true && result.issues.length === 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioJarvisShapedFixtureSanitized(): void {
  // § JARVIS Task 5.2의 실제 .autodev/task-registry.json + execution-policy.json 데이터를
  // sanitize(프로젝트 고유 이름/경로만 유지)해 그대로 재현한다 — 이 preflight가 실제
  // 사고를 결정론적으로 잡아냈을 것임을 회귀 테스트로 증명한다.
  const root = makeExecutionEnvRoot();
  try {
    makeGradleModule(join(root, "android", "wakeword"));
    const rts: RequiredTestCommand[] = [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "root" }];
    // 실제 JARVIS execution-policy.json은 backend 별칭만 갖고 있었고 wakeword 별칭이 없었다 —
    // wrapper 자신은 android/wakeword/에 실제로 존재하지만 requiredTest는 그걸 가리키지 않는다.
    const result = checkRequiredTestExecutionEnvironment(rts, makeExecutor(root, { backend: "backend" }), [], POSIX_OVERRIDE);
    check(
      "L) JARVIS Task 5.2 sanitized fixture — Developer를 부르기 전에 결정론적으로 감지됨",
      result.ok === false && result.issues.length === 1 && result.issues[0].kind === "WRAPPER_NOT_FOUND" && result.issues[0].requiredTestName === "wakeword-unit"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// N) Greenfield Required-Test Preflight Deadlock 수정(2026-08-30, JARVIS Task 5.3 실측) —
//    evaluateGreenfieldDefer()/checkRequiredTestExecutionEnvironment()의 새 allowedPathPrefixes
//    defer 경계. TEST1/TEST4/TEST10은 위 L 섹션에서 기존 시나리오를 그대로/조정해 재사용한다
//    (scenarioGradlewWithCorrectAliasPasses=TEST1+TEST10, scenarioAliasedCwdDirectoryMissingFlagged=TEST4).
// ---------------------------------------------------------------------------

function scenarioExistingModuleWrapperMissingStaysStrictBlock(): void {
  // TEST2 — 기존 cwd(디렉터리는 실제로 존재)인데 wrapper가 없으면, 그 경로가 현재 Task의
  // allowedPathPrefixes 안에 있어도(=greenfield defer 조건 나머지를 전부 만족해도) 절대
  // defer하지 않는다 — greenfield defer는 오직 ENOENT(정말로 아직 없음)에만 적용되고,
  // "존재하는데 환경이 깨짐"은 항상 즉시 BLOCK이어야 한다(§ 요구사항 4-A).
  const root = makeExecutionEnvRoot();
  try {
    mkdirSync(join(root, "android", "conversation"), { recursive: true }); // wrapper 없이 디렉터리만 존재
    const rt: RequiredTestCommand = { name: "voice-conversation-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "conversation" };
    const result = checkRequiredTestExecutionEnvironment(
      [rt],
      makeExecutor(root, { conversation: "android/conversation" }),
      ["android/conversation/"],
      POSIX_OVERRIDE
    );
    check(
      "N/TEST2) 기존 module 디렉터리인데 wrapper가 없으면 allowedPathPrefixes 안에 있어도 항상 WRAPPER_NOT_FOUND(defer 안 함)",
      result.ok === false &&
        result.issues.length === 1 &&
        result.issues[0].kind === "WRAPPER_NOT_FOUND" &&
        result.deferredGreenfield.length === 0
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioGreenfieldCwdInScopeDefersAndUnblocksDeveloper(): void {
  // TEST3 — 핵심 수정: 신규 greenfield cwd가 아직 없어도(ENOENT) 현재 Task의
  // allowedPathPrefixes 안이면 CWD_NOT_FOUND로 차단하지 않는다(ok:true) — Developer 호출이
  // 실제로 진행될 수 있어야 한다. deferredGreenfield에 정확히 이 항목이 기록된다.
  const root = makeExecutionEnvRoot();
  try {
    const rt: RequiredTestCommand = { name: "voice-conversation-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "conversation" };
    const result = checkRequiredTestExecutionEnvironment(
      [rt],
      makeExecutor(root, { conversation: "android/conversation" }),
      ["android/conversation/"],
      POSIX_OVERRIDE
    );
    check(
      "N/TEST3) greenfield cwd 미존재 + allowedPathPrefixes 안 → 차단하지 않음(ok=true), deferredGreenfield에 기록됨",
      result.ok === true &&
        result.issues.length === 0 &&
        result.deferredGreenfield.length === 1 &&
        result.deferredGreenfield[0].requiredTestName === "voice-conversation-unit" &&
        result.deferredGreenfield[0].cwd === "conversation"
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioGreenfieldRootCwdNeverDeferred(): void {
  // TEST3 경계 — "root" 자체는 project root이므로 절대 defer 대상이 아니다(§ evaluateGreenfieldDefer
  // 조건 1). project root는 executor가 이미 mkdtempSync로 만든 실제 디렉터리라 이 케이스는
  // 원천적으로 ENOENT가 될 수 없지만, 그 불변식을 evaluateGreenfieldDefer 자체로도 직접 확인한다.
  const root = makeExecutionEnvRoot();
  try {
    const rt: RequiredTestCommand = { name: "x", command: "gradlew", args: ["testDebugUnitTest"], cwd: "root" };
    const deferred = evaluateGreenfieldDefer(rt, root, "ENOENT", makeExecutor(root), ["anything/"]);
    check("N/TEST3-경계) cwd:root는 ENOENT가 나더라도 evaluateGreenfieldDefer가 항상 false", deferred === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioPathTraversalOrSymlinkEscapeBlocked(): void {
  // TEST5 — greenfield 대상의 조상 경로에 project root 밖을 가리키는 symlink/junction이
  // 있으면, 그 defer 조건(4/5)이 전부 구조적으로는 충족돼 보여도 항상 BLOCK한다(§
  // project-bootstrap.ts assertNoSymlinkInChain 재사용). junction 생성이 지원되지 않는
  // 환경(관리자 권한/개발자 모드 미설정)에서는 SKIP으로 명시한다(§ filesystem-trust-model.md
  // 동일 원칙).
  const root = makeExecutionEnvRoot();
  const outsideDir = makeExecutionEnvRoot();
  try {
    const linkPath = join(root, "android");
    let created = false;
    try {
      symlinkSync(outsideDir, linkPath, "junction");
      created = true;
    } catch {
      // 이 Node/OS 조합에서 junction 생성이 지원되지 않을 수 있다.
    }
    if (!created) {
      skip("N/TEST5) path traversal/symlink escape — 이 환경에서 junction 생성이 지원되지 않아 건너뜀");
      return;
    }
    const rt: RequiredTestCommand = { name: "voice-conversation-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "conversation" };
    const result = checkRequiredTestExecutionEnvironment(
      [rt],
      makeExecutor(root, { conversation: "android/conversation" }),
      ["android/conversation/"],
      POSIX_OVERRIDE
    );
    check(
      "N/TEST5) greenfield 조상 경로가 project root 밖을 가리키는 symlink/junction이면 defer하지 않고 BLOCK",
      result.ok === false && result.issues.length === 1 && result.issues[0].kind === "CWD_NOT_FOUND" && result.deferredGreenfield.length === 0
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
}

function scenarioDeveloperCreatedGreenfieldArtifactsThenGreen(): void {
  // TEST6 — Developer가 실제로 greenfield cwd와 wrapper를 만든 뒤 동일한 preflight를 다시
  // 실행하면(§ autodev.ts는 매 attempt/재시작마다 이 함수를 다시 호출한다) 더 이상 defer가
  // 아니라 일반 경로로 ok:true다 — GREEN이 실제로 가능해진다.
  const root = makeExecutionEnvRoot();
  try {
    const rt: RequiredTestCommand = { name: "voice-conversation-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "conversation" };
    const executor = makeExecutor(root, { conversation: "android/conversation" });
    const before = checkRequiredTestExecutionEnvironment([rt], executor, ["android/conversation/"], POSIX_OVERRIDE);
    check("N/TEST6-사전) Developer 호출 전에는 defer 상태(ok=true, deferredGreenfield 1건)", before.ok === true && before.deferredGreenfield.length === 1);

    makeGradleModule(join(root, "android", "conversation")); // Developer가 실제로 만든 것을 재현
    const after = checkRequiredTestExecutionEnvironment([rt], executor, ["android/conversation/"], POSIX_OVERRIDE);
    check(
      "N/TEST6) Developer가 greenfield cwd+wrapper를 만든 뒤에는 defer가 아니라 일반 경로로 ok=true(GREEN 가능)",
      after.ok === true && after.issues.length === 0 && after.deferredGreenfield.length === 0
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioRepeatedCallsPureAndDeterministic(): void {
  // TEST9 — 이 함수 자신은 Developer/네트워크 어떤 호출도 하지 않는 순수 fs 판정이다(§ 함수
  // 상단 주석 — checkRequiredTestScriptRegistration과 동일한 설계). process restart로 이
  // 경로가 반복 실행돼도(§ runner-supervisor.ts backoff) 이 함수 자체가 부수효과로 Developer/
  // API 호출을 만들 방법이 없다는 것을, "같은 입력 → 같은 결과"(순수성) + "호출 자체가
  // 디렉터리를 만들지 않음"(부수효과 없음)으로 직접 증명한다.
  const root = makeExecutionEnvRoot();
  try {
    const rt: RequiredTestCommand = { name: "voice-conversation-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "conversation" };
    const executor = makeExecutor(root, { conversation: "android/conversation" });
    const first = checkRequiredTestExecutionEnvironment([rt], executor, ["android/conversation/"], POSIX_OVERRIDE);
    const second = checkRequiredTestExecutionEnvironment([rt], executor, ["android/conversation/"], POSIX_OVERRIDE);
    check(
      "N/TEST9) 반복 호출은 결정론적으로 동일한 결과를 낸다(같은 입력 → 같은 defer 판정)",
      first.ok === second.ok &&
        first.deferredGreenfield.length === second.deferredGreenfield.length &&
        JSON.stringify(first) === JSON.stringify(second)
    );
    check(
      "N/TEST9) defer 판정 자체는 디렉터리를 생성하는 부수효과가 없다(여전히 존재하지 않음)",
      !existsSync(join(root, "android", "conversation"))
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// M) reconcileStaleRequiredTestExecutionEnvironmentTasks — AutoDev / JARVIS 신뢰성 보완
//    (2026-08-30, JARVIS Task 5.2 실측: WRAPPER_NOT_FOUND 복구 후 남은 WAITING_HUMAN).
// ---------------------------------------------------------------------------
function makeMinimalTask(id: string, requiredTests: RequiredTestCommand[]): TaskDefinition {
  return {
    id,
    phase: 5,
    taskNumber: 2,
    title: "fixture task",
    prompt: "fixture",
    requiredTests,
    allowedPathPrefixes: [],
    prohibitedOperations: [],
  };
}

function envErrorMarker(taskId: string, requiredTestName: string, resolvedPath: string): string {
  return `REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR: task=${taskId} requiredTest=${requiredTestName} kind=WRAPPER_NOT_FOUND cwd=wakeword resolvedPath=${resolvedPath}`;
}

function scenarioEnvReconcileResolvedWhenWrapperNowPresent(): void {
  // § 실제 JARVIS Task 5.2 재현: 이전엔 wrapper가 없어 WAITING_HUMAN이 됐고, 그 뒤 공식
  // Gradle wrapper 생성 절차로 wrapper가 복구됐다 — 같은 검사를 다시 돌리면 이제 green이어야
  // 한다.
  const root = makeExecutionEnvRoot();
  try {
    const moduleAbs = join(root, "android", "wakeword");
    makeGradleModule(moduleAbs);
    const task = makeMinimalTask("5.2", [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" }]);
    const result = reconcileStaleRequiredTestExecutionEnvironmentTasks(
      [envErrorMarker("5.2", "wakeword-unit", moduleAbs)],
      [task],
      makeExecutor(root, { wakeword: "android/wakeword" }),
      POSIX_OVERRIDE
    );
    check("M) wrapper가 실제로 복구된 뒤 재검사하면 resolved=true", result.resolved === true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioEnvReconcileNotResolvedWhenStillMissing(): void {
  const root = makeExecutionEnvRoot();
  try {
    const moduleAbs = join(root, "android", "wakeword");
    // wrapper를 만들지 않는다 — 결함이 아직 그대로 남아있는 상태.
    const task = makeMinimalTask("5.2", [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" }]);
    const result = reconcileStaleRequiredTestExecutionEnvironmentTasks(
      [envErrorMarker("5.2", "wakeword-unit", moduleAbs)],
      [task],
      makeExecutor(root, { wakeword: "android/wakeword" }),
      POSIX_OVERRIDE
    );
    check("M) wrapper가 여전히 없으면 resolved=false(안전하게 WAITING_HUMAN 유지)", result.resolved === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioEnvReconcileFailClosedOnUnrelatedGenuineReason(): void {
  const root = makeExecutionEnvRoot();
  try {
    const moduleAbs = join(root, "android", "wakeword");
    makeGradleModule(moduleAbs);
    const task = makeMinimalTask("5.2", [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" }]);
    const result = reconcileStaleRequiredTestExecutionEnvironmentTasks(
      [
        envErrorMarker("5.2", "wakeword-unit", moduleAbs),
        "HUMAN_FINAL_REVIEW_PENDING(5.2): reviewer APPROVED — checkpoint 전 사람의 최종 승인이 필요합니다.",
      ],
      [task],
      makeExecutor(root, { wakeword: "android/wakeword" }),
      POSIX_OVERRIDE
    );
    check(
      "M) wrapper는 복구됐어도 실제 사람 판단이 필요한 다른 사유가 섞여 있으면 fail-closed로 resolved=false",
      result.resolved === false
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioEnvReconcileFailClosedOnMixedTaskIds(): void {
  const root = makeExecutionEnvRoot();
  try {
    const moduleAbs = join(root, "android", "wakeword");
    makeGradleModule(moduleAbs);
    const task = makeMinimalTask("5.2", [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" }]);
    const result = reconcileStaleRequiredTestExecutionEnvironmentTasks(
      [envErrorMarker("5.2", "wakeword-unit", moduleAbs), envErrorMarker("5.3", "other-unit", moduleAbs)],
      [task],
      makeExecutor(root, { wakeword: "android/wakeword" }),
      POSIX_OVERRIDE
    );
    check("M) 서로 다른 taskId를 가리키는 마커가 섞여 있으면 fail-closed로 resolved=false(다른 task 상태를 건드리지 않음)", result.resolved === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioEnvReconcileEmptyIsNotResolved(): void {
  const task = makeMinimalTask("5.2", [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" }]);
  const result = reconcileStaleRequiredTestExecutionEnvironmentTasks([], [task], makeExecutor(process.cwd(), {}), POSIX_OVERRIDE);
  check("M) deferredHumanTasks가 비어 있으면 resolved=false(재검사할 대상 자체가 없음)", result.resolved === false);
}

function scenarioEnvReconcileUnknownTaskIdNotResolved(): void {
  const root = makeExecutionEnvRoot();
  try {
    const moduleAbs = join(root, "android", "wakeword");
    makeGradleModule(moduleAbs);
    // taskRegistry에 "5.2"가 없다 — 추측해서 통과시키지 않는다.
    const result = reconcileStaleRequiredTestExecutionEnvironmentTasks(
      [envErrorMarker("5.2", "wakeword-unit", moduleAbs)],
      [],
      makeExecutor(root, { wakeword: "android/wakeword" }),
      POSIX_OVERRIDE
    );
    check("M) taskRegistry에서 해당 taskId를 찾지 못하면 resolved=false(fail-closed, 추측 없음)", result.resolved === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioEnvReconcileFailClosedOnMalformedEntry(): void {
  const root = makeExecutionEnvRoot();
  try {
    const moduleAbs = join(root, "android", "wakeword");
    makeGradleModule(moduleAbs);
    const task = makeMinimalTask("5.2", [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" }]);
    const result = reconcileStaleRequiredTestExecutionEnvironmentTasks(
      ["some unrelated free-text marker that is not the expected template"],
      [task],
      makeExecutor(root, { wakeword: "android/wakeword" }),
      POSIX_OVERRIDE
    );
    check("M) 정규식과 맞지 않는 임의 문자열은 절대 매칭시키지 않고 resolved=false", result.resolved === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function main(): void {
  scenarioRegisteredScriptPasses();
  scenarioMissingScriptFlagged();
  scenarioNonNpmRunCommandsIgnored();
  scenarioUnsupportedCwdSkipped();
  scenarioUnreadablePackageJsonFlagsAllNpmRunEntries();
  scenarioExactlyOneCandidateIsSafelyRegistered();
  scenarioZeroCandidatesAreUnresolvedWithoutFabrication();
  scenarioAmbiguousCandidatesAreUnresolved();
  scenarioNeverOverwritesExistingConflictingEntry();
  scenarioSymlinkedDirectoryIsNotFollowed();
  scenarioSingleFileScopeSelfTestFileIsSafelyRegistered();
  scenarioSingleFileScopeNotYetImplementedStaysUnresolved();
  scenarioSingleFileScopeWithNonExecutableExtensionStaysUnresolved();
  scenarioMultiplePrefixesNeverUseSingleFileFallback();
  scenarioReconcileResolvedWhenAllScriptsNowRegistered();
  scenarioReconcileNotResolvedWhenStillMissing();
  scenarioReconcileFailClosedOnUnrelatedReason();
  scenarioReconcileEmptyIsNotResolved();
  scenarioDeclaredRegistrationValidAndRegistered();
  scenarioUnknownScriptNameRejected();
  scenarioOutsideWritablePathRejected();
  scenarioAbsoluteDotDotUncRejected();
  scenarioShellInjectionRejected();
  scenarioConflictingTargetIsDriftNotOverwrite();
  scenarioIdempotentDoubleRegistration();
  scenarioNonExistentTargetRejected();
  scenarioNotInChangedFilesRejected();
  scenarioDisallowedRunnerRejected();
  scenarioWhitespaceArgumentSmugglingRejected();
  scenarioLifecycleScriptNameRejected();

  scenarioRootCwdWithNonGradleCommandOk();
  scenarioAliasedCwdDirectoryMissingFlagged();
  scenarioUndefinedAliasKeySkipped();
  scenarioGradlewAtRootWithoutWrapperFlagged();
  scenarioGradlewWithCorrectAliasPasses();
  scenarioGradlewBatVariantRecognized();
  scenarioNonAndroidProjectUnaffected();
  scenarioJarvisShapedFixtureSanitized();

  scenarioExistingModuleWrapperMissingStaysStrictBlock();
  scenarioGreenfieldCwdInScopeDefersAndUnblocksDeveloper();
  scenarioGreenfieldRootCwdNeverDeferred();
  scenarioPathTraversalOrSymlinkEscapeBlocked();
  scenarioDeveloperCreatedGreenfieldArtifactsThenGreen();
  scenarioRepeatedCallsPureAndDeterministic();

  scenarioEnvReconcileResolvedWhenWrapperNowPresent();
  scenarioEnvReconcileNotResolvedWhenStillMissing();
  scenarioEnvReconcileFailClosedOnUnrelatedGenuineReason();
  scenarioEnvReconcileFailClosedOnMixedTaskIds();
  scenarioEnvReconcileEmptyIsNotResolved();
  scenarioEnvReconcileUnknownTaskIdNotResolved();
  scenarioEnvReconcileFailClosedOnMalformedEntry();

  console.log("\n=== required-test-preflight 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  const skipCount = results.filter((r) => r.startsWith("[SKIP]")).length;
  const failCount = results.length - passCount - skipCount;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, SKIP ${skipCount}, FAIL ${failCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
