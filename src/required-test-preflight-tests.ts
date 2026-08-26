import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkRequiredTestScriptRegistration,
  attemptSafeRequiredTestScriptRepair,
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

  console.log("\n=== required-test-preflight 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
