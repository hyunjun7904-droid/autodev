import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, realpathSync, existsSync, statSync } from "node:fs";
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
  classifyPrerequisiteFeasibility,
} from "./required-test-preflight";
import type { RequiredTestCommand, TaskDefinition } from "./task-registry";
import type { GradleWrapperResolveTestDeps } from "./gradle-capability";

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
//    WAITING_HUMAN 재검사(Phase 5). Mixed-Marker Recovery 수정(2026-09-01, § M 섹션과 동일한
//    generic defect/동일한 수정 원칙) 이후에는 배열 전체를 단일 단위로 판정하지 않고, marker별로
//    독립적으로 재검사한다.
// ---------------------------------------------------------------------------
function configErrorMarker(taskId: string, requiredTestName: string, missingScript: string): string {
  return `REQUIRED_TEST_CONFIGURATION_ERROR: task=${taskId} requiredTest=${requiredTestName} missingScript=${missingScript}`;
}

function scenarioReconcileResolvedWhenAllScriptsNowRegistered(): void {
  // A) 해소된 단일 CONFIG_ERROR marker → 제거되고 기존 정책상 정상 recovery(remaining이 빈 배열).
  const root = makeProjectRoot({ "test:device-trust-registration": "node backend/device-trust/device-trust-registration.test.mjs" });
  try {
    const marker = configErrorMarker("2.1", "device-trust-registration-tests", "test:device-trust-registration");
    const result = reconcileStaleRequiredTestConfigurationTasks([marker], root);
    check("C/A) 해소된 CONFIG_ERROR marker가 resolvedMarkers에 포함됨", result.resolvedMarkers.length === 1 && result.resolvedMarkers[0] === marker);
    check("C/A) marker가 이것 하나뿐이었으므로 remainingDeferredHumanTasks가 빈 배열", result.remainingDeferredHumanTasks.length === 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioReconcileNotResolvedWhenStillMissing(): void {
  // G) config 문제가 아직 해소되지 않았으면 marker를 그대로 보존한다(BLOCKED/WAITING_HUMAN 유지).
  const root = makeProjectRoot({});
  try {
    const marker = configErrorMarker("2.1", "device-trust-registration-tests", "test:device-trust-registration");
    const result = reconcileStaleRequiredTestConfigurationTasks([marker], root);
    check("C/G) 아직 미등록이면 resolvedMarkers가 비어 있음(아무것도 제거하지 않음)", result.resolvedMarkers.length === 0);
    check("C/G) remainingDeferredHumanTasks가 원본과 동일(marker 보존)", result.remainingDeferredHumanTasks.length === 1 && result.remainingDeferredHumanTasks[0] === marker);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioReconcileMixedWithStagnationDetectedOnlyRemovesConfigMarker(): void {
  // B) [STAGNATION_DETECTED, CONFIG_ERROR] — config 해결 → CONFIG만 제거, STAGNATION은 독립
  // 보존(이 함수가 임의로 삭제하지 않음, 그 marker의 recovery는 자신의 기존 canonical 경로에
  // 맡긴다).
  const root = makeProjectRoot({ "test:device-trust-registration": "node backend/device-trust/device-trust-registration.test.mjs" });
  try {
    const stagnation = genericStagnationDetectedMarker();
    const configMarker = configErrorMarker("2.1", "device-trust-registration-tests", "test:device-trust-registration");
    const result = reconcileStaleRequiredTestConfigurationTasks([stagnation, configMarker], root);
    check("C/B) 무관한 STAGNATION_DETECTED가 섞여 있어도 config marker 재검사가 스킵되지 않고 resolved됨", result.resolvedMarkers.length === 1 && result.resolvedMarkers[0] === configMarker);
    check("C/B) STAGNATION_DETECTED marker는 그대로 보존됨(임의 삭제 없음)", result.remainingDeferredHumanTasks.length === 1 && result.remainingDeferredHumanTasks[0] === stagnation);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioReconcileMixedWithGenuineMarkerOnlyRemovesConfigMarker(): void {
  // C) [genuine marker, CONFIG_ERROR] — config 해결 → CONFIG만 제거, genuine은 반드시 보존되고
  // 자동 승인/삭제되지 않는다(호출부가 remainingDeferredHumanTasks가 비어있지 않으므로 READY로
  // 강제 전환하지 않는다).
  const root = makeProjectRoot({ "test:device-trust-registration": "node backend/device-trust/device-trust-registration.test.mjs" });
  try {
    const genuine = genericGenuineMarker("2.1");
    const configMarker = configErrorMarker("2.1", "device-trust-registration-tests", "test:device-trust-registration");
    const result = reconcileStaleRequiredTestConfigurationTasks([genuine, configMarker], root);
    check("C/C) 사람 판단이 필요한 genuine marker가 섞여 있어도 config marker는 독립적으로 resolved됨", result.resolvedMarkers.length === 1 && result.resolvedMarkers[0] === configMarker);
    check("C/C) genuine marker는 이 함수가 절대 지우지 않음(자동 READY 강제전환 금지의 전제)", result.remainingDeferredHumanTasks.length === 1 && result.remainingDeferredHumanTasks[0] === genuine);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioReconcileMixedWithEnvMarkerOnlyRemovesConfigMarker(): void {
  // D) [ENV_ERROR, CONFIG_ERROR] — config 해결 → CONFIG만 제거, ENV marker는 보존(자신의 기존
  // reconcileStaleRequiredTestExecutionEnvironmentTasks 경로에 맡긴다).
  const root = makeProjectRoot({ "test:device-trust-registration": "node backend/device-trust/device-trust-registration.test.mjs" });
  try {
    const envMarker = envErrorMarker("2.1", "wakeword-unit", join(root, "android", "wakeword"));
    const configMarker = configErrorMarker("2.1", "device-trust-registration-tests", "test:device-trust-registration");
    const result = reconcileStaleRequiredTestConfigurationTasks([envMarker, configMarker], root);
    check("C/D) 다른 종류의 기술적 마커(ENV_ERROR)와 섞여 있어도 config marker는 resolved됨", result.resolvedMarkers.length === 1 && result.resolvedMarkers[0] === configMarker);
    check("C/D) ENV_ERROR marker는 이 함수가 임의로 제거하지 않음", result.remainingDeferredHumanTasks.length === 1 && result.remainingDeferredHumanTasks[0] === envMarker);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioReconcilePartialAcrossTwoConfigMarkersOnlyResolvedRemoved(): void {
  // E) CONFIG_ERROR 2개 — 하나는 해결됐고 하나는 여전히 미등록. 해결된 것만 제거되고 미해결은
  // 유지되어야 한다.
  const root = makeProjectRoot({ "test:device-trust-registration": "node backend/device-trust/device-trust-registration.test.mjs" });
  try {
    const resolvedMarker = configErrorMarker("2.1", "device-trust-registration-tests", "test:device-trust-registration");
    const unresolvedMarker = configErrorMarker("2.1", "device-trust-revocation-tests", "test:device-trust-revocation");
    const result = reconcileStaleRequiredTestConfigurationTasks([resolvedMarker, unresolvedMarker], root);
    check("C/E) 해결된 CONFIG_ERROR marker만 제거됨", result.resolvedMarkers.length === 1 && result.resolvedMarkers[0] === resolvedMarker);
    check("C/E) 아직 해결되지 않은 CONFIG_ERROR marker는 유지됨", result.remainingDeferredHumanTasks.length === 1 && result.remainingDeferredHumanTasks[0] === unresolvedMarker);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioReconcileFailClosedOnMalformedConfigLikeEntry(): void {
  // F) "REQUIRED_TEST_CONFIGURATION_ERROR:"로 시작하지만 정확한 필드 형식과 다른 marker(예:
  // missingScript= 필드 누락) — 정규식이 매칭하지 않으므로 이 함수는 이걸 아예 파싱하지 않고
  // 그대로 보존해야 한다(임의로 "비슷하니까 지워도 되겠지"라고 추측하지 않는다).
  const root = makeProjectRoot({ "test:device-trust-registration": "node backend/device-trust/device-trust-registration.test.mjs" });
  try {
    const malformed = "REQUIRED_TEST_CONFIGURATION_ERROR: task=2.1 requiredTest=device-trust-registration-tests"; // missingScript= 필드 누락
    const result = reconcileStaleRequiredTestConfigurationTasks([malformed], root);
    check("C/F) 형식이 정확히 일치하지 않는 marker는 절대 제거되지 않음(fail-closed)", result.resolvedMarkers.length === 0);
    check("C/F) remainingDeferredHumanTasks가 원본과 동일", result.remainingDeferredHumanTasks.length === 1 && result.remainingDeferredHumanTasks[0] === malformed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioReconcileNoConfigMarkerLeavesEntriesUntouched(): void {
  // H) CONFIG marker가 전혀 없으면(무관한 항목만 있으면) 아무것도 재검사하지 않고 원본을 그대로
  // 참조 동일성까지 보존한다.
  const root = makeProjectRoot({});
  try {
    const unrelated: readonly string[] = [genericStagnationDetectedMarker(), genericGenuineMarker("2.1")];
    const result = reconcileStaleRequiredTestConfigurationTasks(unrelated, root);
    check("C/H) config marker가 없으면 resolvedMarkers가 비어 있음", result.resolvedMarkers.length === 0);
    check("C/H) remainingDeferredHumanTasks가 원본 참조와 동일(unrelated entries 변경 없음)", result.remainingDeferredHumanTasks === unrelated);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioReconcileIdempotentAcrossRepeatedCalls(): void {
  // I) reconciliation 반복 실행 → idempotent, 무한 상태변경 없음. 첫 호출로 해소된 marker를
  // 제거한 뒤(remaining) 그 결과를 다시 넣고 재호출해도 더 이상 아무것도 변하지 않아야 한다.
  const root = makeProjectRoot({ "test:device-trust-registration": "node backend/device-trust/device-trust-registration.test.mjs" });
  try {
    const resolvedMarker = configErrorMarker("2.1", "device-trust-registration-tests", "test:device-trust-registration");
    const unresolvedMarker = configErrorMarker("2.1", "device-trust-revocation-tests", "test:device-trust-revocation");
    const genuine = genericGenuineMarker("2.1");
    const first = reconcileStaleRequiredTestConfigurationTasks([resolvedMarker, unresolvedMarker, genuine], root);
    check("C/I) 첫 호출에서 해결된 marker만 제거됨", first.resolvedMarkers.length === 1 && first.resolvedMarkers[0] === resolvedMarker);
    const second = reconcileStaleRequiredTestConfigurationTasks(first.remainingDeferredHumanTasks, root);
    check("C/I) 같은 입력을 다시 재검사해도 더 이상 제거되는 marker가 없음(idempotent)", second.resolvedMarkers.length === 0);
    check(
      "C/I) 두 번째 호출의 remainingDeferredHumanTasks가 첫 번째 결과와 동일(무한 상태변경 없음)",
      second.remainingDeferredHumanTasks.length === first.remainingDeferredHumanTasks.length &&
        second.remainingDeferredHumanTasks.every((v, i) => v === first.remainingDeferredHumanTasks[i])
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioReconcileEmptyIsNoop(): void {
  const task_root = makeProjectRoot({});
  try {
    const empty: readonly string[] = [];
    const result = reconcileStaleRequiredTestConfigurationTasks(empty, task_root);
    check("C) deferredHumanTasks가 비어 있으면 resolvedMarkers도 비어 있음(재검사할 대상 자체가 없음)", result.resolvedMarkers.length === 0);
    check("C) remainingDeferredHumanTasks가 원본 참조와 동일(no-op)", result.remainingDeferredHumanTasks === empty);
  } finally {
    rmSync(task_root, { recursive: true, force: true });
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

// Task-Scoped Script Registration False-Positive Closure(2026-09-02, Revenue OS Task 1.2
// 실제 운영 incident) — package.json이 scope 밖인 task가 이 채널로 정상적인 ".js"/".mjs"/
// ".cjs" 검증 스크립트를 등록할 수 있는지(더 이상 ".test.mjs" 하나로만 제한되지 않는지),
// 그리고 그 외 확장자는 여전히 거부되는지(닫힌 allow-list가 실제로 닫혀 있는지) 확인한다.
function scenarioBroadenedExtensionAllowList(): void {
  const requiredTests = [npmRun("version-baseline-tests", "test:version-baseline")];

  // H) 일반 ".js" 검증 스크립트(Task 1.1이 실제로 쓴 관례와 동일) → 이제 정상 등록된다.
  {
    const root = makeProjectRoot({});
    try {
      mkdirSync(join(root, "packages", "version-baseline", "scripts"), { recursive: true });
      writeFileSync(join(root, "packages", "version-baseline", "scripts", "verify-version-baseline.js"), "// fixture\n", "utf-8");
      const validation = validateRequiredTestRegistrationRequest(
        { scriptName: "test:version-baseline", runner: "node", target: "packages/version-baseline/scripts/verify-version-baseline.js" },
        requiredTests,
        ["packages/"],
        root,
        ["packages/version-baseline/scripts/verify-version-baseline.js"]
      );
      check("H) 일반 .js 검증 스크립트는 이제 통과함(Revenue OS Task 1.2 실제 재현)", validation.ok === true);
      if (validation.ok) {
        const outcome = registerValidatedRequiredTestScripts(
          [{ scriptName: "test:version-baseline", runner: "node", target: "packages/version-baseline/scripts/verify-version-baseline.js" }],
          requiredTests,
          ["packages/"],
          root,
          ["packages/version-baseline/scripts/verify-version-baseline.js"]
        );
        check("H) 실제로 package.json에 등록됨", outcome.outcomes[0]?.outcome === "REGISTERED");
        const pkgAfter = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
        check(
          "H) 등록된 값이 정확히 node <target>",
          pkgAfter.scripts["test:version-baseline"] === "node packages/version-baseline/scripts/verify-version-baseline.js"
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // I) ".mjs"/".cjs"도 허용됨(닫힌 목록 안).
  for (const ext of [".mjs", ".cjs"]) {
    const root = makeProjectRoot({});
    try {
      mkdirSync(join(root, "packages", "x"), { recursive: true });
      writeFileSync(join(root, "packages", "x", `verify${ext}`), "// fixture\n", "utf-8");
      const validation = validateRequiredTestRegistrationRequest(
        { scriptName: "test:version-baseline", runner: "node", target: `packages/x/verify${ext}` },
        requiredTests,
        ["packages/"],
        root,
        [`packages/x/verify${ext}`]
      );
      check(`I) ${ext} 검증 스크립트도 통과함`, validation.ok === true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // J) 그 외 확장자(.sh/.py/확장자 없음)는 여전히 거부됨 — 닫힌 allow-list가 실제로 닫혀
  // 있는지 확인(임의 확장자 전체 허용으로 조용히 넓어지지 않았는지).
  for (const target of ["packages/x/evil.sh", "packages/x/evil.py", "packages/x/evil.exe", "packages/x/noext"]) {
    const root = makeProjectRoot({});
    try {
      mkdirSync(join(root, "packages", "x"), { recursive: true });
      writeFileSync(join(root, ...target.split("/")), "// fixture\n", "utf-8");
      const validation = validateRequiredTestRegistrationRequest(
        { scriptName: "test:version-baseline", runner: "node", target },
        requiredTests,
        ["packages/"],
        root,
        [target]
      );
      check(`J) 허용 목록 밖 확장자(${target})는 여전히 거부됨(닫힌 allow-list 유지)`, validation.ok === false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

// ---------------------------------------------------------------------------
// N) classifyPrerequisiteFeasibility — Hardening G(Prerequisite Feasibility).
// ---------------------------------------------------------------------------
function makeScopedTask(id: string, allowedPathPrefixes: string[]): TaskDefinition {
  return { id, phase: 1, taskNumber: 1, title: "fixture", prompt: "fixture", requiredTests: [], allowedPathPrefixes, prohibitedOperations: [] };
}

function scenarioPrerequisiteFeasibilityExpectedGreenfield(): void {
  const registry = [makeScopedTask("T1", ["module-a/"]), makeScopedTask("T2", ["module-b/"])];
  const result = classifyPrerequisiteFeasibility("module-a/src/index.ts", "T1", ["module-a/"], registry);
  check("N/G1) 현재 task 자신의 scope 안 → EXPECTED_GREENFIELD", result.feasibility === "EXPECTED_GREENFIELD");
  check("N/G1) candidateResponsibleTaskIds가 없음(자기 자신 소관이므로)", result.candidateResponsibleTaskIds === undefined);
}

function scenarioPrerequisiteFeasibilityMissingPrerequisite(): void {
  const registry = [makeScopedTask("T1", ["module-a/"]), makeScopedTask("T2", ["module-b/"])];
  const result = classifyPrerequisiteFeasibility("module-b/gradlew", "T1", ["module-a/"], registry);
  check("N/G2) 다른 task(T2)의 scope 안 → MISSING_PREREQUISITE", result.feasibility === "MISSING_PREREQUISITE");
  check("N/G2) candidateResponsibleTaskIds에 T2가 포함됨", (result.candidateResponsibleTaskIds ?? []).includes("T2"));
  check("N/G2) 현재 task(T1) 자신은 후보에서 제외됨", !(result.candidateResponsibleTaskIds ?? []).includes("T1"));
}

function scenarioPrerequisiteFeasibilityUnsatisfiable(): void {
  const registry = [makeScopedTask("T1", ["module-a/"]), makeScopedTask("T2", ["module-b/"])];
  const result = classifyPrerequisiteFeasibility("module-c/gradlew", "T1", ["module-a/"], registry);
  check("N/G3) 어떤 task의 scope도 아님 → UNSATISFIABLE_PREREQUISITE", result.feasibility === "UNSATISFIABLE_PREREQUISITE");
  check("N/G3) candidateResponsibleTaskIds가 없음", result.candidateResponsibleTaskIds === undefined);
}

function scenarioPrerequisiteFeasibilityMultipleCandidates(): void {
  // 두 task가 겹치는 scope를 선언한 경우(계획 결함 자체를 이 함수가 만들어내지 않는다 —
  // 있는 그대로 후보 전부를 보고한다).
  const registry = [makeScopedTask("T1", ["shared/"]), makeScopedTask("T2", ["shared/"]), makeScopedTask("T3", ["other/"])];
  const result = classifyPrerequisiteFeasibility("shared/lib.ts", "T3", ["other/"], registry);
  check("N/G4) 겹치는 scope 후보 T1/T2가 모두 보고됨", (result.candidateResponsibleTaskIds ?? []).sort().join(",") === "T1,T2");
}

function scenarioCheckRequiredTestExecutionEnvironmentAttachesFeasibilityWhenContextGiven(): void {
  const root = mkdtempSync(join(tmpdir(), "autodev-prereq-feasibility-"));
  const registry = [makeScopedTask("T1", ["module-a/"]), makeScopedTask("T2", ["module-b/"])];
  const executor = { projectRoot: root, projectRootReal: realpathSync(root), policy: { commandCwdAliases: { modb: "module-b" } } };
  const rt: RequiredTestCommand = { name: "check", command: "npm", args: ["run", "check"], cwd: "modb" };

  const withoutContext = checkRequiredTestExecutionEnvironment([rt], executor, ["module-a/"]);
  check("N/G5) feasibilityContext 미지정 시 기존 동작 그대로(prerequisiteFeasibility 없음)", withoutContext.issues[0]?.prerequisiteFeasibility === undefined);

  const withContext = checkRequiredTestExecutionEnvironment([rt], executor, ["module-a/"], undefined, { currentTaskId: "T1", registry });
  check(
    "N/G5) feasibilityContext 지정 시 MISSING_PREREQUISITE로 분류됨(module-b/는 T2 소관)",
    withContext.issues[0]?.prerequisiteFeasibility?.feasibility === "MISSING_PREREQUISITE"
  );
  check("N/G5) candidateResponsibleTaskIds에 T2가 포함됨", (withContext.issues[0]?.prerequisiteFeasibility?.candidateResponsibleTaskIds ?? []).includes("T2"));

  rmSync(root, { recursive: true, force: true });
}

function envErrorMarker(taskId: string, requiredTestName: string, resolvedPath: string): string {
  return `REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR: task=${taskId} requiredTest=${requiredTestName} kind=WRAPPER_NOT_FOUND cwd=wakeword resolvedPath=${resolvedPath}`;
}

// Mixed-Marker Recovery 회귀 테스트용 generic fixture marker(§ human-gate-policy.ts와 동일한
// 실제 저장 형식) — 특정 프로젝트/Task 이름을 쓰지 않는다.
function genericStagnationDetectedMarker(): string {
  return "STAGNATION_DETECTED(IMPLEMENTATION): reviewCycle=2에서 동일한 required test 실패가 2회 연속 반복됨";
}
function genericGenuineMarker(taskId: string): string {
  return `HUMAN_FINAL_REVIEW_PENDING(${taskId}): reviewer APPROVED — checkpoint 전 사람의 최종 승인이 필요합니다.`;
}
function genericUnrelatedTechnicalMarker(taskId: string): string {
  return `REQUIRED_TEST_CONFIGURATION_ERROR: task=${taskId} requiredTest=other-unit missingScript=test:other`;
}

function scenarioEnvReconcileResolvedWhenWrapperNowPresent(): void {
  // A) § 실제 JARVIS Task 5.2 재현: 이전엔 wrapper가 없어 WAITING_HUMAN이 됐고, 그 뒤 공식
  // Gradle wrapper 생성 절차로 wrapper가 복구됐다 — 같은 검사를 다시 돌리면 이제 green이어야
  // 한다. marker가 이것 하나뿐이면 전부 제거되어 remaining이 빈 배열이 된다.
  const root = makeExecutionEnvRoot();
  try {
    const moduleAbs = join(root, "android", "wakeword");
    makeGradleModule(moduleAbs);
    const task = makeMinimalTask("T1", [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" }]);
    const marker = envErrorMarker("T1", "wakeword-unit", moduleAbs);
    const result = reconcileStaleRequiredTestExecutionEnvironmentTasks([marker], [task], makeExecutor(root, { wakeword: "android/wakeword" }), POSIX_OVERRIDE);
    check("M/A) wrapper가 실제로 복구된 뒤 재검사하면 해당 marker가 resolvedMarkers에 포함됨", result.resolvedMarkers.length === 1 && result.resolvedMarkers[0] === marker);
    check("M/A) marker가 이것 하나뿐이었으므로 remainingDeferredHumanTasks가 빈 배열", result.remainingDeferredHumanTasks.length === 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioEnvReconcileNotResolvedWhenStillMissing(): void {
  // G) 환경 결함이 아직 재현되면 marker를 그대로 보존하고 BLOCKED/WAITING_HUMAN을 유지한다.
  const root = makeExecutionEnvRoot();
  try {
    const moduleAbs = join(root, "android", "wakeword");
    // wrapper를 만들지 않는다 — 결함이 아직 그대로 남아있는 상태.
    const task = makeMinimalTask("T1", [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" }]);
    const marker = envErrorMarker("T1", "wakeword-unit", moduleAbs);
    const result = reconcileStaleRequiredTestExecutionEnvironmentTasks([marker], [task], makeExecutor(root, { wakeword: "android/wakeword" }), POSIX_OVERRIDE);
    check("M/G) wrapper가 여전히 없으면 resolvedMarkers가 비어 있음(아무것도 제거하지 않음)", result.resolvedMarkers.length === 0);
    check("M/G) remainingDeferredHumanTasks가 원본과 동일(marker 보존)", result.remainingDeferredHumanTasks.length === 1 && result.remainingDeferredHumanTasks[0] === marker);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioEnvReconcileMixedWithStagnationDetectedOnlyRemovesEnvMarker(): void {
  // B) Generic mixed-marker defect의 실제 재현 형태: [STAGNATION_DETECTED, ENV] — 예전에는
  // all-or-nothing 조건 때문에 이 배열 전체가 재검사조차 되지 않았다. 이제는 STAGNATION_
  // DETECTED는 건드리지 않고 ENV marker만 독립적으로 재검사/제거되어야 한다.
  const root = makeExecutionEnvRoot();
  try {
    const moduleAbs = join(root, "android", "wakeword");
    makeGradleModule(moduleAbs);
    const task = makeMinimalTask("T1", [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" }]);
    const stagnation = genericStagnationDetectedMarker();
    const envMarker = envErrorMarker("T1", "wakeword-unit", moduleAbs);
    const result = reconcileStaleRequiredTestExecutionEnvironmentTasks(
      [stagnation, envMarker],
      [task],
      makeExecutor(root, { wakeword: "android/wakeword" }),
      POSIX_OVERRIDE
    );
    check("M/B) 무관한 STAGNATION_DETECTED가 섞여 있어도 env marker 재검사가 스킵되지 않고 resolved됨", result.resolvedMarkers.length === 1 && result.resolvedMarkers[0] === envMarker);
    check("M/B) STAGNATION_DETECTED marker는 그대로 보존됨(임의 삭제 없음)", result.remainingDeferredHumanTasks.length === 1 && result.remainingDeferredHumanTasks[0] === stagnation);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioEnvReconcileMixedWithGenuineMarkerOnlyRemovesEnvMarker(): void {
  // C) [genuine marker, ENV] — env marker만 제거되고 genuine marker는 반드시 보존되어야
  // 한다(호출부가 remainingDeferredHumanTasks가 비어있지 않으므로 READY로 전환하지 않는다 —
  // 이 함수 자체는 상태 전이를 하지 않지만, 반환값이 그 판단을 가능하게 해야 한다).
  const root = makeExecutionEnvRoot();
  try {
    const moduleAbs = join(root, "android", "wakeword");
    makeGradleModule(moduleAbs);
    const task = makeMinimalTask("T1", [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" }]);
    const genuine = genericGenuineMarker("T1");
    const envMarker = envErrorMarker("T1", "wakeword-unit", moduleAbs);
    const result = reconcileStaleRequiredTestExecutionEnvironmentTasks([genuine, envMarker], [task], makeExecutor(root, { wakeword: "android/wakeword" }), POSIX_OVERRIDE);
    check("M/C) 사람 판단이 필요한 genuine marker가 섞여 있어도 env marker는 독립적으로 resolved됨", result.resolvedMarkers.length === 1 && result.resolvedMarkers[0] === envMarker);
    check("M/C) genuine marker는 이 함수가 절대 지우지 않음(READY 강제전환 금지의 전제)", result.remainingDeferredHumanTasks.length === 1 && result.remainingDeferredHumanTasks[0] === genuine);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioEnvReconcileMixedWithUnrelatedTechnicalMarkerPreservesIt(): void {
  // D) [무관한 다른 기술적 마커(REQUIRED_TEST_CONFIGURATION_ERROR), ENV] — env marker만
  // 제거되고, 그 다른 기술적 마커는 이 함수가 건드리지 않는다(자신의 기존 reconciliation
  // 경로에 맡긴다).
  const root = makeExecutionEnvRoot();
  try {
    const moduleAbs = join(root, "android", "wakeword");
    makeGradleModule(moduleAbs);
    const task = makeMinimalTask("T1", [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" }]);
    const unrelatedTechnical = genericUnrelatedTechnicalMarker("T1");
    const envMarker = envErrorMarker("T1", "wakeword-unit", moduleAbs);
    const result = reconcileStaleRequiredTestExecutionEnvironmentTasks(
      [unrelatedTechnical, envMarker],
      [task],
      makeExecutor(root, { wakeword: "android/wakeword" }),
      POSIX_OVERRIDE
    );
    check("M/D) 다른 종류의 기술적 마커(REQUIRED_TEST_CONFIGURATION_ERROR)와 섞여 있어도 env marker는 resolved됨", result.resolvedMarkers.length === 1 && result.resolvedMarkers[0] === envMarker);
    check("M/D) 무관한 기술적 마커는 이 함수가 임의로 제거하지 않음", result.remainingDeferredHumanTasks.length === 1 && result.remainingDeferredHumanTasks[0] === unrelatedTechnical);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioEnvReconcilePartialWithinSameTaskOnlyResolvedRemoved(): void {
  // E) 같은 task에 env marker 2개(서로 다른 requiredTest) — 하나는 wrapper가 복구됐고 다른
  // 하나는 여전히 없다. 해결된 것만 제거되고 미해결 blocker는 유지되어야 한다.
  const root = makeExecutionEnvRoot();
  try {
    const okModuleAbs = join(root, "android", "wakeword");
    const stillMissingModuleAbs = join(root, "android", "conversation");
    makeGradleModule(okModuleAbs);
    // conversation 모듈은 디렉터리만 만들고 wrapper는 만들지 않는다 — 여전히 결함.
    mkdirSync(stillMissingModuleAbs, { recursive: true });
    const task = makeMinimalTask("T1", [
      { name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" },
      { name: "conversation-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "conversation" },
    ]);
    const resolvedMarker = envErrorMarker("T1", "wakeword-unit", okModuleAbs);
    const unresolvedMarker = envErrorMarker("T1", "conversation-unit", stillMissingModuleAbs);
    const result = reconcileStaleRequiredTestExecutionEnvironmentTasks(
      [resolvedMarker, unresolvedMarker],
      [task],
      makeExecutor(root, { wakeword: "android/wakeword", conversation: "android/conversation" }),
      POSIX_OVERRIDE
    );
    check("M/E) 같은 task 안에서 해결된 requiredTest의 marker만 제거됨", result.resolvedMarkers.length === 1 && result.resolvedMarkers[0] === resolvedMarker);
    check("M/E) 아직 해결되지 않은 requiredTest의 marker는 유지됨", result.remainingDeferredHumanTasks.length === 1 && result.remainingDeferredHumanTasks[0] === unresolvedMarker);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioEnvReconcileFailClosedOnMalformedEnvLikeEntry(): void {
  // F) "REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR:"로 시작하지만 정확한 필드 형식과 다른
  // marker(예: kind= 필드 누락) — 정규식이 매칭하지 않으므로 이 함수는 이걸 아예 파싱하지
  // 않고 그대로 보존해야 한다(임의로 "비슷하니까 지워도 되겠지"라고 추측하지 않는다).
  const root = makeExecutionEnvRoot();
  try {
    const moduleAbs = join(root, "android", "wakeword");
    makeGradleModule(moduleAbs);
    const task = makeMinimalTask("T1", [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" }]);
    const malformed = `REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR: task=T1 requiredTest=wakeword-unit cwd=wakeword resolvedPath=${moduleAbs}`; // kind= 필드 누락
    const result = reconcileStaleRequiredTestExecutionEnvironmentTasks([malformed], [task], makeExecutor(root, { wakeword: "android/wakeword" }), POSIX_OVERRIDE);
    check("M/F) 형식이 정확히 일치하지 않는 marker는 절대 제거되지 않음(fail-closed)", result.resolvedMarkers.length === 0);
    check("M/F) remainingDeferredHumanTasks가 원본과 동일", result.remainingDeferredHumanTasks.length === 1 && result.remainingDeferredHumanTasks[0] === malformed);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioEnvReconcileFailClosedOnFreeTextEntry(): void {
  // 정규식 패턴과 전혀 무관한 자유 문장 — 이 형식으로 시작조차 하지 않으므로 당연히 매칭되지
  // 않아야 한다(§ M/F와 별개로, "이 형식 접두어조차 없는" 가장 단순한 케이스도 명시적으로 커버).
  const root = makeExecutionEnvRoot();
  try {
    const moduleAbs = join(root, "android", "wakeword");
    makeGradleModule(moduleAbs);
    const task = makeMinimalTask("T1", [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" }]);
    const freeText = "some unrelated free-text marker that is not the expected template";
    const result = reconcileStaleRequiredTestExecutionEnvironmentTasks([freeText], [task], makeExecutor(root, { wakeword: "android/wakeword" }), POSIX_OVERRIDE);
    check("M) 정규식과 전혀 무관한 자유 문장은 절대 매칭시키지 않고 그대로 보존", result.resolvedMarkers.length === 0 && result.remainingDeferredHumanTasks.length === 1 && result.remainingDeferredHumanTasks[0] === freeText);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioEnvReconcileUnknownTaskIdSingleGroupNotResolved(): void {
  // taskRegistry에서 해당 taskId를 찾지 못하면(레지스트리가 그 사이 바뀐 경우 등) 추측해서
  // 통과시키지 않는다 — marker가 이것 하나뿐이어도 그대로 보존된다.
  const root = makeExecutionEnvRoot();
  try {
    const moduleAbs = join(root, "android", "wakeword");
    makeGradleModule(moduleAbs);
    const marker = envErrorMarker("T1", "wakeword-unit", moduleAbs);
    // taskRegistry에 "T1"이 없다.
    const result = reconcileStaleRequiredTestExecutionEnvironmentTasks([marker], [], makeExecutor(root, { wakeword: "android/wakeword" }), POSIX_OVERRIDE);
    check("M) taskRegistry에서 해당 taskId를 찾지 못하면 fail-closed로 보존됨(추측 없음)", result.resolvedMarkers.length === 0 && result.remainingDeferredHumanTasks.length === 1 && result.remainingDeferredHumanTasks[0] === marker);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioEnvReconcileEmptyIsNoop(): void {
  // H) deferredHumanTasks가 비어 있으면 아무 것도 하지 않는다(mutation 없음).
  const task = makeMinimalTask("T1", [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" }]);
  const empty: readonly string[] = [];
  const result = reconcileStaleRequiredTestExecutionEnvironmentTasks(empty, [task], makeExecutor(process.cwd(), {}), POSIX_OVERRIDE);
  check("M/H) deferredHumanTasks가 비어 있으면 resolvedMarkers도 비어 있음", result.resolvedMarkers.length === 0);
  check("M/H) remainingDeferredHumanTasks가 원본 참조와 동일(no-op)", result.remainingDeferredHumanTasks === empty);
}

function scenarioEnvReconcileNoEnvMarkerLeavesEntriesUntouched(): void {
  // I) env marker가 전혀 없으면(무관한 항목만 있으면) 아무것도 재검사하지 않고 그대로 통과.
  const task = makeMinimalTask("T1", [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" }]);
  const unrelated: readonly string[] = [genericStagnationDetectedMarker(), genericGenuineMarker("T1")];
  const result = reconcileStaleRequiredTestExecutionEnvironmentTasks(unrelated, [task], makeExecutor(process.cwd(), {}), POSIX_OVERRIDE);
  check("M/I) env marker가 없으면 resolvedMarkers가 비어 있음", result.resolvedMarkers.length === 0);
  check("M/I) remainingDeferredHumanTasks가 원본 참조와 동일(byte/semantic 동일)", result.remainingDeferredHumanTasks === unrelated);
}

function scenarioEnvReconcileDifferentTaskIdsHandledIndependently(): void {
  // 서로 다른 taskId를 가리키는 env marker는 예전처럼 서로를 fail-closed로 막지 않고 각자
  // 독립적으로 판정된다: taskRegistry에 있는 taskId는 재검사되어 해결되면 제거되고,
  // taskRegistry에 없는 taskId는 그 자신만 fail-closed로 보존된다(다른 task의 판정에
  // 영향을 주지 않는다).
  const root = makeExecutionEnvRoot();
  try {
    const moduleAbs = join(root, "android", "wakeword");
    makeGradleModule(moduleAbs);
    const knownTask = makeMinimalTask("T1", [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" }]);
    const knownMarker = envErrorMarker("T1", "wakeword-unit", moduleAbs);
    const unknownTaskMarker = envErrorMarker("T2", "other-unit", moduleAbs); // "T2"는 registry에 없음
    const result = reconcileStaleRequiredTestExecutionEnvironmentTasks(
      [knownMarker, unknownTaskMarker],
      [knownTask],
      makeExecutor(root, { wakeword: "android/wakeword" }),
      POSIX_OVERRIDE
    );
    check("M) registry에 있는 taskId(T1)의 marker는 독립적으로 resolved됨", result.resolvedMarkers.length === 1 && result.resolvedMarkers[0] === knownMarker);
    check("M) registry에 없는 taskId(T2)의 marker는 추측 없이 fail-closed로 보존됨(다른 task 판정에 영향받지 않음)", result.remainingDeferredHumanTasks.length === 1 && result.remainingDeferredHumanTasks[0] === unknownTaskMarker);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// 이번 재검사에서만 쓰는 fake trusted-JDK 위치 — 실제 OS temp 디렉터리 밖의 합성 경로다
// (checkRequiredTestExecutionEnvironment가 excludedRootsForJava에 항상 tmpdir()을 포함시켜
// temp 경로의 java를 신뢰하지 않기 때문에, 우리 fixture root(mkdtempSync 기반)를 그대로
// java 위치로 쓸 수 없다 — 실제 프로덕션 신뢰 모델과 동일한 이유). 실제 디스크에 이 경로를
// 만들지 않는다 — existsSync/statSync/realpathSync를 이 경로에 대해서만 가로채고, 그 외
// 모든 경로는 진짜 fs로 그대로 위임한다(fixture root의 실제 wrapper 파일 검증은 그대로
// 정직하게 수행된다).
const FAKE_TRUSTED_JAVA_HOME = join("C:", "fixture-trusted-jdk-mixed-marker-recovery");
const FAKE_TRUSTED_JAVA_EXE = join(FAKE_TRUSTED_JAVA_HOME, "bin", "java.exe");

function makeWin32TrustedJavaTestDeps(javaPresent: boolean): GradleWrapperResolveTestDeps {
  return {
    existsSyncImpl: (p) => (p === FAKE_TRUSTED_JAVA_EXE ? javaPresent : existsSync(p)),
    statSyncImpl: (p) => (p === FAKE_TRUSTED_JAVA_EXE ? { isFile: () => true } : statSync(p)),
    realpathSyncImpl: (p) => (p === FAKE_TRUSTED_JAVA_EXE ? FAKE_TRUSTED_JAVA_EXE : realpathSync(p)),
    envOverride: { AUTODEV_TRUSTED_JAVA_HOME: FAKE_TRUSTED_JAVA_HOME, JAVA_HOME: undefined },
  };
}

function scenarioEnvReconcileWin32RequiresTrustedJavaBeforeMarkerResolves(): void {
  // § Task 요구사항 8 — 실제 execution environment 재검증: gradlew wrapper 파일 자체(§
  // makeGradleModule)는 처음부터 실제로 존재하지만, win32에서는 그것만으로 부족하고
  // trusted Java(JAVA_HOME/AUTODEV_TRUSTED_JAVA_HOME)가 별도로 필요하다(§
  // gradle-capability.ts resolveTrustedGradleWrapper). 처음엔 trusted Java가 없어 env
  // marker가 유지되고, trusted Java 환경이 제공된 뒤 재실행하면 그 marker만 해소되어야
  // 한다 — 그 사이 섞여 있는 무관한 STAGNATION_DETECTED marker는 두 재검사 모두에서 항상
  // 그대로 보존되어야 한다(외부 API/Claude 호출 없이, 순수 fs 판정만으로 검증).
  const root = makeExecutionEnvRoot();
  try {
    const moduleAbs = join(root, "android", "wakeword");
    makeGradleModule(moduleAbs);
    const task = makeMinimalTask("T1", [{ name: "wakeword-unit", command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" }]);
    const stagnation = genericStagnationDetectedMarker();
    const envMarker = envErrorMarker("T1", "wakeword-unit", moduleAbs);
    const executor = makeExecutor(root, { wakeword: "android/wakeword" });

    const before = reconcileStaleRequiredTestExecutionEnvironmentTasks([stagnation, envMarker], [task], executor, {
      platform: "win32",
      gradleTestDeps: makeWin32TrustedJavaTestDeps(false),
    });
    check("M/win32) trusted Java가 아직 없으면 env marker가 유지됨(resolvedMarkers 비어있음)", before.resolvedMarkers.length === 0);
    check(
      "M/win32) trusted Java 없음 단계에서도 무관한 STAGNATION_DETECTED는 보존됨",
      before.remainingDeferredHumanTasks.length === 2 && before.remainingDeferredHumanTasks.includes(stagnation) && before.remainingDeferredHumanTasks.includes(envMarker)
    );

    const after = reconcileStaleRequiredTestExecutionEnvironmentTasks([stagnation, envMarker], [task], executor, {
      platform: "win32",
      gradleTestDeps: makeWin32TrustedJavaTestDeps(true),
    });
    check("M/win32) trusted Java 환경 제공 후 재실행하면 env marker만 해소됨", after.resolvedMarkers.length === 1 && after.resolvedMarkers[0] === envMarker);
    check(
      "M/win32) trusted Java 제공 후에도 무관한 STAGNATION_DETECTED marker는 그대로 보존됨",
      after.remainingDeferredHumanTasks.length === 1 && after.remainingDeferredHumanTasks[0] === stagnation
    );
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
  scenarioReconcileMixedWithStagnationDetectedOnlyRemovesConfigMarker();
  scenarioReconcileMixedWithGenuineMarkerOnlyRemovesConfigMarker();
  scenarioReconcileMixedWithEnvMarkerOnlyRemovesConfigMarker();
  scenarioReconcilePartialAcrossTwoConfigMarkersOnlyResolvedRemoved();
  scenarioReconcileFailClosedOnMalformedConfigLikeEntry();
  scenarioReconcileNoConfigMarkerLeavesEntriesUntouched();
  scenarioReconcileIdempotentAcrossRepeatedCalls();
  scenarioReconcileEmptyIsNoop();
  scenarioDeclaredRegistrationValidAndRegistered();
  scenarioUnknownScriptNameRejected();
  scenarioOutsideWritablePathRejected();
  scenarioBroadenedExtensionAllowList();
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
  scenarioEnvReconcileMixedWithStagnationDetectedOnlyRemovesEnvMarker();
  scenarioEnvReconcileMixedWithGenuineMarkerOnlyRemovesEnvMarker();
  scenarioEnvReconcileMixedWithUnrelatedTechnicalMarkerPreservesIt();
  scenarioEnvReconcilePartialWithinSameTaskOnlyResolvedRemoved();
  scenarioEnvReconcileFailClosedOnMalformedEnvLikeEntry();
  scenarioEnvReconcileFailClosedOnFreeTextEntry();
  scenarioEnvReconcileUnknownTaskIdSingleGroupNotResolved();
  scenarioEnvReconcileEmptyIsNoop();
  scenarioEnvReconcileNoEnvMarkerLeavesEntriesUntouched();
  scenarioEnvReconcileDifferentTaskIdsHandledIndependently();
  scenarioEnvReconcileWin32RequiresTrustedJavaBeforeMarkerResolves();

  scenarioPrerequisiteFeasibilityExpectedGreenfield();
  scenarioPrerequisiteFeasibilityMissingPrerequisite();
  scenarioPrerequisiteFeasibilityUnsatisfiable();
  scenarioPrerequisiteFeasibilityMultipleCandidates();
  scenarioCheckRequiredTestExecutionEnvironmentAttachesFeasibilityWhenContextGiven();

  console.log("\n=== required-test-preflight 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  const skipCount = results.filter((r) => r.startsWith("[SKIP]")).length;
  const failCount = results.length - passCount - skipCount;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, SKIP ${skipCount}, FAIL ${failCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
