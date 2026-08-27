import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkRequiredTestScriptRegistration,
  attemptSafeRequiredTestScriptRepair,
  reconcileStaleRequiredTestConfigurationTasks,
  validateRequiredTestRegistrationRequest,
  registerValidatedRequiredTestScripts,
} from "./required-test-preflight";
import type { RequiredTestCommand } from "./task-registry";

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
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

  console.log("\n=== required-test-preflight 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
