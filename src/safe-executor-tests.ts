import { existsSync, unlinkSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  validateAndExecute,
  validateReadPath,
  validateWritePath,
  validateCommand,
  configureSafeExecutor,
  PROJECT_ROOT,
} from "./safe-executor";
import { MOVAN_PROJECT_MANIFEST } from "./project-manifests/movan";
import type { ProjectExecutionPolicy } from "./project-policy";

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

// AutoDev 범용화 Phase B Task B1 — MOVAN과 완전히 다른 경로/명령 정책을 가진 Fixture
// 프로젝트에서도 Safe Executor가 코드 변경 없이(어떤 프로젝트 문자열도 하드코딩하지 않고)
// 정상 동작하는지 직접 증명한다(§ 요구사항 8). fixture 시나리오는 이 파일 마지막에 실행하고,
// 끝나면 다시 MOVAN 정책으로 복귀시켜(이 프로세스 안에서 이후 어떤 코드도 fixture 정책을
// 물려받지 않게) 정책이 명시적으로 프로젝트별로 주입된다는 것을 보인다.
const FIXTURE_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["src/", "tests/"],
  allowedWritePrefixes: ["src/", "tests/"],
  allowedCommands: [{ cwd: "root", command: "node", args: ["--version"] }],
};

function scenarioFixtureProjectPolicyWorksWithoutMovanKnowledge(): void {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "safe-executor-fixture-policy-"));
  try {
    mkdirSync(join(fixtureRoot, "src"), { recursive: true });
    mkdirSync(join(fixtureRoot, "tests"), { recursive: true });
    mkdirSync(join(fixtureRoot, "notes"), { recursive: true });
    configureSafeExecutor(fixtureRoot, FIXTURE_EXECUTION_POLICY);

    // A) 허용 경로 write → 허용
    const srcAbs = resolve(fixtureRoot, "src", "calc.js");
    const wOk = validateWritePath("src/calc.js");
    check("[8-A] Fixture: src/calc.js write → ALLOW", wOk.ok);
    if (wOk.ok) writeFileSync(srcAbs, "// fixture\n", "utf-8");
    check("[8-A] Fixture: 실제로 파일이 생성됨", existsSync(srcAbs));

    // B) 허용되지 않은 경로 write → BLOCK
    check("[8-B] Fixture: notes/readme.txt write → BLOCK(allowedWritePrefixes 밖)", !validateWritePath("notes/readme.txt").ok);

    // C) target root 밖 write → BLOCK
    check("[8-C] Fixture: ../outside.txt write → BLOCK(root 밖)", !validateWritePath("../outside.txt").ok);

    // D) 허용 명령 → 실행 가능
    check("[8-D] Fixture: node --version(root) → ALLOW", validateCommand("node", ["--version"], "root").ok);

    // E) 허용되지 않은 command → BLOCK
    check("[8-E] Fixture: git status(allow-list에 없음) → BLOCK", !validateCommand("git", ["status"], "root").ok);

    // F) destructive git → BLOCK(Fixture policy가 git을 아예 허용하지 않으므로 당연히 BLOCK)
    check("[8-F] Fixture: git reset --hard → BLOCK", !validateCommand("git", ["reset", "--hard"], "root").ok);

    // H) Fixture policy에 MOVAN/web/supabase 문자열이 전혀 없어도 정상 작동함을 직접 증명
    const policyJson = JSON.stringify(FIXTURE_EXECUTION_POLICY);
    check(
      "[8-H] Fixture policy 정의 자체에 MOVAN/web/supabase 문자열이 없음",
      !/MOVAN|web\/|supabase/i.test(policyJson)
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    // G) MOVAN policy로 복귀 — 이후(이 파일 안 또는 같은 프로세스의 다른 코드) 어떤 동작도
    // fixture 정책을 암묵적으로 물려받지 않는다는 것을 명시적 재설정으로 보인다.
    configureSafeExecutor(MOVAN_PROJECT_MANIFEST.targetProjectRoot, MOVAN_PROJECT_MANIFEST.executionPolicy);
    check("[8-G] MOVAN policy로 명시적 복귀 후 PROJECT_ROOT가 다시 MOVAN root를 가리킴", PROJECT_ROOT === MOVAN_PROJECT_MANIFEST.targetProjectRoot);
  }
}

// Phase B Task B2 — 물리적 repository 분리 이전에는 MOVAN_PROJECT_MANIFEST.targetProjectRoot가
// 곧 실제 MOVAN repo(항상 존재하는 git repo, web/ 실제 존재)였다. AutoDev standalone repo에서는
// (AUTODEV_TARGET_PROJECT_ROOT를 지정하지 않고 이 파일을 실행하면) 그 값이 임의의 기본 경로로
// fallback하므로, 아래 main()의 WRITE_FILE ALLOW/RUN_COMMAND 시나리오가 실제 파일을 쓰거나
// git 명령을 실행할 안전한 곳이 보장되지 않는다(실제로 한 번은 그 기본 경로 밑에 빈 web/lib/
// 디렉터리가 생성되는 부작용이 있었다 — 즉시 정리함). 이제 이 파일 전용 격리된 임시 git
// repo(web/ 포함, MOVAN_EXECUTION_POLICY의 실제 값은 그대로 사용)를 만들어 주입한다 — 검증하는
// 정책 내용(MOVAN_EXECUTION_POLICY)은 바뀌지 않고, "어디에 실제로 쓰는가"만 항상 안전한
// isolated temp 경로로 바뀐다.
function makeIsolatedMovanLikeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "safe-executor-tests-movan-like-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "safe-executor-tests@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Safe Executor Tests"], { cwd: root });
  mkdirSync(join(root, "web", "lib"), { recursive: true });
  writeFileSync(join(root, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  return root;
}

async function main(): Promise<void> {
  // 이 파일의 나머지 시나리오는 전부 MOVAN 정책을 대상으로 한다 — Safe Executor는
  // configureSafeExecutor()로 명시적으로 주입되기 전까지 어떤 프로젝트로도 조용히
  // fallback하지 않으므로, 여기서 이 파일 전용 격리된 MOVAN-like root에 MOVAN의 실제
  // 정책 값을 주입한다(§ 위 makeIsolatedMovanLikeRoot 주석).
  const isolatedMovanRoot = makeIsolatedMovanLikeRoot();
  configureSafeExecutor(isolatedMovanRoot, MOVAN_PROJECT_MANIFEST.executionPolicy);

  // ---- secret path 보호 ----
  check("web/.env.local read → DENY", !validateReadPath("web/.env.local").ok);
  check("automation/.env read → DENY", !validateReadPath("automation/.env").ok);
  check("web/.env.local write → DENY", !validateWritePath("web/.env.local").ok);
  check("automation/.env write → DENY", !validateWritePath("automation/.env").ok);
  check("web/.env write → DENY(패턴)", !validateWritePath("web/.env").ok);
  check("secret 이름 패턴 read → DENY", !validateReadPath("web/lib/my-secret-key.ts").ok);

  // ---- path traversal 방어 ----
  check("../ 상위 탈출 → DENY", !validateReadPath("../outside.txt").ok);
  check("../../ 다중 상위 탈출 → DENY", !validateWritePath("../../evil.txt").ok);
  check(
    "절대경로 root 탈출 → DENY",
    !validateReadPath("C:\\Windows\\System32\\drivers\\etc\\hosts").ok
  );
  check("UNC 경로 → DENY", !validateReadPath("\\\\attacker-host\\share\\file.txt").ok);
  check("다른 드라이브 절대경로 write → DENY", !validateWritePath("D:\\evil.txt").ok);

  // ---- applied migration 보호 (0001~0016) ----
  const migResult1 = await validateAndExecute({
    type: "WRITE_FILE",
    path: "supabase/migrations/0001_init_schema.sql",
    content: "-- tampered",
  });
  check("0001_init_schema.sql write → DENY", !migResult1.ok);
  const migResult16 = await validateAndExecute({
    type: "WRITE_FILE",
    path: "supabase/migrations/0016_photo_upload_jobs.sql",
    content: "-- tampered",
  });
  check("0016_photo_upload_jobs.sql write → DENY", !migResult16.ok);
  const migPatch = await validateAndExecute({
    type: "APPLY_PATCH",
    path: "supabase/migrations/0013_audit_actor_fix.sql",
    oldString: "begin;",
    newString: "begin; -- tampered",
  });
  check("migration APPLY_PATCH → DENY", !migPatch.ok);
  check("migration READ → ALLOW(읽기는 허용)", validateReadPath("supabase/migrations/0016_photo_upload_jobs.sql").ok);

  // ---- 정상 범위 ALLOW (fixture 생성 후 삭제) ----
  const webFixtureRel = "web/lib/test-safe-fixture.ts";
  const webFixtureAbs = resolve(PROJECT_ROOT, webFixtureRel);

  const w1 = await validateAndExecute({ type: "WRITE_FILE", path: webFixtureRel, content: "// safe executor fixture\n" });
  check("web/lib/test-safe-fixture.ts write → ALLOW", w1.ok && existsSync(webFixtureAbs));
  // Phase B Task B2 — automation/이 더 이상 MOVAN targetProjectRoot 하위에 존재하지 않으므로
  // MOVAN_EXECUTION_POLICY.allowedWritePrefixes에서도 제거됐다(§ project-manifests/movan.ts).
  // 이전에는 여기서 "automation/tmp-safe-fixture.txt write → ALLOW"를 확인했지만, 이제는
  // 정반대로 DENY되는 것이 올바른 동작이다.
  const w2 = await validateAndExecute({ type: "WRITE_FILE", path: "automation/tmp-safe-fixture.txt", content: "should be denied\n" });
  check("automation/tmp-safe-fixture.txt write → DENY(automation/은 더 이상 MOVAN 허용 범위가 아님)", !w2.ok);

  // APPLY_PATCH ALLOW 경로도 함께 검증
  const patchResult = await validateAndExecute({
    type: "APPLY_PATCH",
    path: webFixtureRel,
    oldString: "// safe executor fixture",
    newString: "// safe executor fixture (patched)",
  });
  check(
    "허용 범위 APPLY_PATCH → ALLOW",
    patchResult.ok && readFileSync(webFixtureAbs, "utf-8").includes("(patched)")
  );

  // fixture 정리
  if (existsSync(webFixtureAbs)) unlinkSync(webFixtureAbs);
  check("fixture 정리 완료", !existsSync(webFixtureAbs));

  // ---- command allow-list ----
  check("git status --short(root) → ALLOW", validateCommand("git", ["status", "--short"], "root").ok);
  check("git push → DENY", !validateCommand("git", ["push"], "root").ok);
  check("git reset --hard → DENY", !validateCommand("git", ["reset", "--hard"], "root").ok);
  check("git clean → DENY", !validateCommand("git", ["clean", "-fd"], "root").ok);
  check("git checkout -- . → DENY", !validateCommand("git", ["checkout", "--", "."], "root").ok);
  check("supabase db push → DENY", !validateCommand("supabase", ["db", "push"], "root").ok);
  check("psql → DENY", !validateCommand("psql", ["-c", "select 1"], "root").ok);
  check(
    "powershell Get-Content web/.env.local → DENY",
    !validateCommand("powershell", ["-Command", "Get-Content web/.env.local"], "root").ok
  );
  check(
    "cmd /c type automation/.env → DENY",
    !validateCommand("cmd", ["/c", "type automation/.env"], "root").ok
  );
  check("curl → DENY", !validateCommand("curl", ["https://example.com"], "root").ok);
  check("wget → DENY", !validateCommand("wget", ["https://example.com"], "root").ok);
  check("bash -c → DENY", !validateCommand("bash", ["-c", "echo hi"], "root").ok);
  check("vercel deploy → DENY", !validateCommand("vercel", ["deploy"], "root").ok);
  check("git diff(web cwd, allow-list은 root만 등록) → DENY", !validateCommand("git", ["diff"], "web").ok);

  // 실제로 안전한 명령 하나만 진짜 실행해 RUN_COMMAND 경로 자체도 검증한다.
  const runResult = await validateAndExecute({ type: "RUN_COMMAND", command: "git", args: ["status", "--short"], cwd: "root" });
  check("RUN_COMMAND 실제 실행(git status --short) 성공", runResult.ok);

  // ---- Phase B Task B1 — Fixture 프로젝트 정책 범용성 증명(§ 요구사항 8) ----
  scenarioFixtureProjectPolicyWorksWithoutMovanKnowledge();

  rmSync(isolatedMovanRoot, { recursive: true, force: true });

  console.log("\n=== Safe Executor 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
