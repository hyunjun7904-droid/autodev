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
  coreCommandSafetyGate,
  PROJECT_ROOT,
} from "./safe-executor";
import type { ProjectExecutionPolicy } from "./project-policy";

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

// Phase B Task B3 — 이 파일은 이제 어떤 특정 프로젝트(MOVAN 포함)의 manifest도 import하지
// 않는다. 대신 실제 프로젝트가 흔히 갖는 형태(web/ 앱 코드 + 불변 supabase/migrations/**
// 스키마 + 제한된 명령 allow-list)를 흉내낸 REALISTIC_EXECUTION_POLICY를 이 파일 안에서
// 스스로 정의해, Safe Executor가 그런 형태의 정책에서도 코드 변경 없이(어떤 프로젝트
// 문자열도 하드코딩하지 않고) 정상 동작함을 증명한다. 이 정책의 실제 값은 이동 전 AutoDev
// standalone repo의 src/project-manifests/movan.ts(MOVAN_EXECUTION_POLICY)와 동일했던
// 내용을 그대로 재사용한다(값 자체가 이 테스트의 목적에 잘 맞는 현실적인 예시이기 때문) —
// 다만 지금은 어떤 프로젝트도 가리키지 않는 이 파일 전용 fixture다.
const REALISTIC_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["web/", "supabase/migrations/"],
  allowedWritePrefixes: ["web/"],
  writeDenyPatterns: [/^supabase\/migrations\/.+\.sql$/, /^README\.md$/i],
  commandCwdAliases: { web: "web" },
  allowedCommands: [
    { cwd: "root", command: "git", args: ["status", "--short"] },
    { cwd: "root", command: "git", args: ["diff"] },
    { cwd: "root", command: "git", args: ["diff", "--stat"] },
    { cwd: "root", command: "git", args: ["log", "-1", "--oneline"] },
    { cwd: "web", command: "npx", args: ["tsc", "--noEmit"] },
    { cwd: "web", command: "npm", args: ["run", "build"] },
  ],
};

// Phase B Task B1 — MOVAN과 완전히 다른 경로/명령 정책을 가진 Fixture 프로젝트에서도 Safe
// Executor가 코드 변경 없이(어떤 프로젝트 문자열도 하드코딩하지 않고) 정상 동작하는지 직접
// 증명한다(§ 요구사항 8). fixture 시나리오는 이 파일 마지막에 실행하고, 끝나면 다시
// REALISTIC_EXECUTION_POLICY로 복귀시켜(이 프로세스 안에서 이후 어떤 코드도 fixture 정책을
// 물려받지 않게) 정책이 명시적으로 프로젝트별로 주입된다는 것을 보인다.
const FIXTURE_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["src/", "tests/"],
  allowedWritePrefixes: ["src/", "tests/"],
  allowedCommands: [{ cwd: "root", command: "node", args: ["--version"] }],
};

// Phase C Task C4(Hooks / Permissions Enforcement) — Core Command Safety Gate가
// policy.allowedCommands에 무엇이 들어있든(악의적/실수로 destructive git 조합이 들어있어도)
// 절대 약화되지 않는다는 것을 직접 증명한다. 기존 REALISTIC_EXECUTION_POLICY는 애초에
// destructive git 명령을 allow-list에 넣지 않았으므로 지금까지의 테스트는 "policy가 그냥
// 안 넣었을 뿐"이라는 우연한 안전과 "Core가 강제로 막는다"는 보장을 구분하지 못했다 —
// 이 시나리오는 그 둘을 명확히 구분한다.
const POLICY_WITH_DESTRUCTIVE_GIT_IN_ALLOWLIST: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["web/"],
  allowedWritePrefixes: ["web/"],
  allowedCommands: [
    // 이 프로젝트 정책이 실수로(또는 악의적으로) destructive git 조합을 allow-list에
    // 명시적으로 넣었다고 가정한다 — Core Command Safety Gate는 이런 policy 내용과 무관하게
    // 항상 먼저 적용되어야 한다.
    { cwd: "root", command: "git", args: ["reset", "--hard"] },
    { cwd: "root", command: "git", args: ["clean", "-fd"] },
    { cwd: "root", command: "git", args: ["push", "--force"] },
    { cwd: "root", command: "git", args: ["rebase", "-i", "HEAD~3"] },
    { cwd: "root", command: "git", args: ["stash", "drop"] },
    { cwd: "root", command: "git", args: ["stash"] },
    { cwd: "root", command: "git", args: ["checkout", "--", "."] },
    { cwd: "root", command: "git", args: ["commit", "-m", "x"] },
    // read-only 서브커맨드도 함께 등록해 "Core gate가 read-only까지 과잉 차단하지 않는다"는
    // 것도 같은 시나리오에서 증명한다.
    { cwd: "root", command: "git", args: ["stash", "list"] },
    { cwd: "root", command: "git", args: ["branch", "--list"] },
    // secret/env를 참조하는 명령도 명시적으로 allow-list에 넣었다고 가정한다.
    { cwd: "root", command: "cat", args: ["web/.env"] },
  ],
};

function scenarioProjectPolicyCannotWeakenCommandSafetyGate(isolatedRealisticRoot: string): void {
  const root = mkdtempSync(join(tmpdir(), "safe-executor-gate-override-"));
  try {
    mkdirSync(join(root, "web"), { recursive: true });
    configureSafeExecutor(root, POLICY_WITH_DESTRUCTIVE_GIT_IN_ALLOWLIST);

    check("[C4-1] allow-list에 있어도 git reset --hard → BLOCK(Core gate)", !validateCommand("git", ["reset", "--hard"], "root").ok);
    check("[C4-2] allow-list에 있어도 git clean -fd → BLOCK(Core gate)", !validateCommand("git", ["clean", "-fd"], "root").ok);
    check("[C4-3] allow-list에 있어도 git push --force → BLOCK(Core gate)", !validateCommand("git", ["push", "--force"], "root").ok);
    check(
      "[C4-4] allow-list에 있어도 git rebase -i → BLOCK(Core gate)",
      !validateCommand("git", ["rebase", "-i", "HEAD~3"], "root").ok
    );
    check("[C4-5] allow-list에 있어도 git stash drop → BLOCK(Core gate)", !validateCommand("git", ["stash", "drop"], "root").ok);
    check("[C4-6] allow-list에 있어도 인자 없는 git stash → BLOCK(Core gate, push와 동일)", !validateCommand("git", ["stash"], "root").ok);
    check(
      "[C4-7] allow-list에 있어도 git checkout -- . → BLOCK(Core gate, working tree 변경 삭제)",
      !validateCommand("git", ["checkout", "--", "."], "root").ok
    );
    check("[C4-8] allow-list에 있어도 git commit → BLOCK(Core gate, checkpoint.ts만 commit 가능)", !validateCommand("git", ["commit", "-m", "x"], "root").ok);
    check(
      "[C4-9] allow-list에 있어도 cat web/.env → BLOCK(Core gate, secret/env 인자)",
      !validateCommand("cat", ["web/.env"], "root").ok
    );

    // read-only는 여전히 통과(과잉 차단 아님) — allow-list에도 있고 Core gate도 read-only로
    // 판정하는 경우에만 최종 ALLOW.
    check("[C4-10] git stash list → ALLOW(read-only, Core gate 통과 + allow-list 일치)", validateCommand("git", ["stash", "list"], "root").ok);
    check(
      "[C4-11] git branch --list → ALLOW(read-only, Core gate 통과 + allow-list 일치)",
      validateCommand("git", ["branch", "--list"], "root").ok
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    configureSafeExecutor(isolatedRealisticRoot, REALISTIC_EXECUTION_POLICY);
  }
}

function scenarioFixtureProjectPolicyWorksWithoutRealisticPolicyKnowledge(isolatedRealisticRoot: string): void {
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

    // H) Fixture policy에 특정 프로젝트 문자열이 전혀 없어도 정상 작동함을 직접 증명
    const policyJson = JSON.stringify(FIXTURE_EXECUTION_POLICY);
    check(
      "[8-H] Fixture policy 정의 자체에 MOVAN/web/supabase 문자열이 없음",
      !/MOVAN|web\/|supabase/i.test(policyJson)
    );
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
    // G) 이전(REALISTIC_EXECUTION_POLICY) 정책으로 복귀 — 이후(이 파일 안 또는 같은 프로세스의
    // 다른 코드) 어떤 동작도 fixture 정책을 암묵적으로 물려받지 않는다는 것을 명시적
    // 재설정으로 보인다.
    configureSafeExecutor(isolatedRealisticRoot, REALISTIC_EXECUTION_POLICY);
    check("[8-G] 이전 정책으로 명시적 복귀 후 PROJECT_ROOT가 다시 그 root를 가리킴", PROJECT_ROOT === isolatedRealisticRoot);
  }
}

// Phase B Task B2/B3 — 이 파일 전용 격리된 임시 git repo(web/ 포함, REALISTIC_EXECUTION_POLICY
// 값은 그대로 사용)를 만들어 주입한다 — 검증하는 정책 내용은 바뀌지 않고, "어디에 실제로
// 쓰는가"만 항상 안전한 isolated temp 경로로 격리된다(실제 프로젝트 repo는 절대 건드리지
// 않는다).
function makeIsolatedRealisticRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "safe-executor-tests-realistic-"));
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
  // 이 파일의 나머지 시나리오는 전부 REALISTIC_EXECUTION_POLICY를 대상으로 한다 — Safe
  // Executor는 configureSafeExecutor()로 명시적으로 주입되기 전까지 어떤 프로젝트로도 조용히
  // fallback하지 않으므로, 여기서 이 파일 전용 격리된 root에 그 정책 값을 주입한다(§ 위
  // makeIsolatedRealisticRoot 주석).
  const isolatedRealisticRoot = makeIsolatedRealisticRoot();
  configureSafeExecutor(isolatedRealisticRoot, REALISTIC_EXECUTION_POLICY);

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

  // ---- applied migration 보호 ----
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
  // automation/은 이 fixture policy의 allowedWritePrefixes에 없으므로 DENY되는 것이 올바른
  // 동작이다(실제 프로젝트에서도 AutoDev 자신의 소스 디렉터리는 대상 프로젝트가 쓰기를
  // 허용할 이유가 없다).
  const w2 = await validateAndExecute({ type: "WRITE_FILE", path: "automation/tmp-safe-fixture.txt", content: "should be denied\n" });
  check("automation/tmp-safe-fixture.txt write → DENY(automation/은 이 정책의 허용 범위가 아님)", !w2.ok);

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

  // ---- Phase C Task C4 — Core Command Safety Gate 단위 테스트(coreCommandSafetyGate 직접
  // 호출, ProjectExecutionPolicy/allow-list와 완전히 무관하게 순수 판정만 검증) ----
  check("coreCommandSafetyGate: git status → ALLOW", coreCommandSafetyGate("git", ["status"]).ok);
  check("coreCommandSafetyGate: git.exe status → ALLOW(실행파일 확장자 무관)", coreCommandSafetyGate("git.exe", ["status"]).ok);
  check("coreCommandSafetyGate: git stash list → ALLOW(read-only)", coreCommandSafetyGate("git", ["stash", "list"]).ok);
  check("coreCommandSafetyGate: git stash show → ALLOW(read-only)", coreCommandSafetyGate("git", ["stash", "show"]).ok);
  check(
    "coreCommandSafetyGate: git stash list를 단순 'stash' 문자열 매칭으로 잘못 차단하지 않음",
    coreCommandSafetyGate("git", ["stash", "list"]).ok === true
  );
  check("coreCommandSafetyGate: 인자 없는 git stash → BLOCK(push와 동일, mutating)", !coreCommandSafetyGate("git", ["stash"]).ok);
  check("coreCommandSafetyGate: git stash push → BLOCK", !coreCommandSafetyGate("git", ["stash", "push"]).ok);
  check("coreCommandSafetyGate: git stash pop → BLOCK", !coreCommandSafetyGate("git", ["stash", "pop"]).ok);
  check("coreCommandSafetyGate: git stash drop → BLOCK", !coreCommandSafetyGate("git", ["stash", "drop"]).ok);
  check("coreCommandSafetyGate: git stash clear → BLOCK", !coreCommandSafetyGate("git", ["stash", "clear"]).ok);
  check("coreCommandSafetyGate: git reset --hard → BLOCK", !coreCommandSafetyGate("git", ["reset", "--hard"]).ok);
  check("coreCommandSafetyGate: git reset(인자 없음) → BLOCK", !coreCommandSafetyGate("git", ["reset"]).ok);
  check("coreCommandSafetyGate: git clean -fd → BLOCK", !coreCommandSafetyGate("git", ["clean", "-fd"]).ok);
  check("coreCommandSafetyGate: git rebase -i → BLOCK", !coreCommandSafetyGate("git", ["rebase", "-i", "HEAD~3"]).ok);
  check("coreCommandSafetyGate: git push → BLOCK", !coreCommandSafetyGate("git", ["push"]).ok);
  check("coreCommandSafetyGate: git push --force → BLOCK", !coreCommandSafetyGate("git", ["push", "--force"]).ok);
  check("coreCommandSafetyGate: git checkout -- . → BLOCK", !coreCommandSafetyGate("git", ["checkout", "--", "."]).ok);
  check("coreCommandSafetyGate: git restore . → BLOCK", !coreCommandSafetyGate("git", ["restore", "."]).ok);
  check("coreCommandSafetyGate: git branch -D feature-x → BLOCK", !coreCommandSafetyGate("git", ["branch", "-D", "feature-x"]).ok);
  check("coreCommandSafetyGate: git branch --list → ALLOW(read-only)", coreCommandSafetyGate("git", ["branch", "--list"]).ok);
  check("coreCommandSafetyGate: git remote -v → ALLOW(read-only)", coreCommandSafetyGate("git", ["remote", "-v"]).ok);
  check("coreCommandSafetyGate: git remote add origin x → BLOCK", !coreCommandSafetyGate("git", ["remote", "add", "origin", "x"]).ok);
  check("coreCommandSafetyGate: git commit → BLOCK", !coreCommandSafetyGate("git", ["commit", "-m", "x"]).ok);
  check("coreCommandSafetyGate: git config user.email → BLOCK", !coreCommandSafetyGate("git", ["config", "user.email", "x"]).ok);
  check(
    "coreCommandSafetyGate: 명령 인자에 .env 파일 → BLOCK(git 아닌 명령도 적용)",
    !coreCommandSafetyGate("cat", ["web/.env"]).ok
  );
  check(
    "coreCommandSafetyGate: 명령 인자에 secret 이름 패턴 파일 → BLOCK",
    !coreCommandSafetyGate("cat", ["web/lib/my-secret-key.ts"]).ok
  );
  check(
    "coreCommandSafetyGate: 관계없는 인자 → ALLOW(과잉 차단 아님)",
    coreCommandSafetyGate("node", ["--version"]).ok
  );

  // ---- Phase C Task C4 — project policy가 Core Command Safety Gate를 약화할 수 없음을 증명 ----
  scenarioProjectPolicyCannotWeakenCommandSafetyGate(isolatedRealisticRoot);

  // ---- Phase B Task B1 — Fixture 프로젝트 정책 범용성 증명(§ 요구사항 8) ----
  scenarioFixtureProjectPolicyWorksWithoutRealisticPolicyKnowledge(isolatedRealisticRoot);

  rmSync(isolatedRealisticRoot, { recursive: true, force: true });

  console.log("\n=== Safe Executor 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
