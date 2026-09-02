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

// Phase C Task C4.1 — project policy가 "subcommand는 read-only 목록에 있지만 위험한 옵션이
// 붙은 정확한 인자 조합"을 allow-list에 명시적으로 넣어도 Core Command Safety Gate가 여전히
// 차단함을 증명한다. C4의 scenarioProjectPolicyCannotWeakenCommandSafetyGate는 subcommand
// 레벨(reset/clean/push 등) 우회만 다뤘다 — 이 시나리오는 그보다 한 단계 더 교묘한 "겉보기엔
// read-only 서브커맨드(diff/show/cat-file/blame/remote)인데 옵션으로 write/외부실행/네트워크를
// 일으키는" 우회를 다룬다.
const POLICY_WITH_DANGEROUS_READONLY_OPTIONS_IN_ALLOWLIST: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["web/"],
  allowedWritePrefixes: ["web/"],
  allowedCommands: [
    { cwd: "root", command: "git", args: ["diff", "--output=evil.txt"] },
    { cwd: "root", command: "git", args: ["log", "--ext-diff"] },
    { cwd: "root", command: "git", args: ["show", "--textconv", "HEAD:file"] },
    { cwd: "root", command: "git", args: ["cat-file", "--filters", "HEAD:file"] },
    { cwd: "root", command: "git", args: ["log", "--paginate"] },
    { cwd: "root", command: "git", args: ["blame", "--contents=C:\\secrets.txt", "README.md"] },
    { cwd: "root", command: "git", args: ["remote", "show", "origin"] },
    // 대조군 — 진짜 read-only(옵션 없음)는 여전히 허용돼야 한다.
    { cwd: "root", command: "git", args: ["diff"] },
  ],
};

function scenarioProjectPolicyCannotBypassGateViaDangerousOptions(isolatedRealisticRoot: string): void {
  const root = mkdtempSync(join(tmpdir(), "safe-executor-gate-option-override-"));
  try {
    mkdirSync(join(root, "web"), { recursive: true });
    configureSafeExecutor(root, POLICY_WITH_DANGEROUS_READONLY_OPTIONS_IN_ALLOWLIST);

    check(
      "[C4.1-1] allow-list에 있어도 git diff --output=evil.txt → BLOCK(Core gate, write 우회)",
      !validateCommand("git", ["diff", "--output=evil.txt"], "root").ok
    );
    check(
      "[C4.1-2] allow-list에 있어도 git log --ext-diff → BLOCK(Core gate, 외부 diff 실행)",
      !validateCommand("git", ["log", "--ext-diff"], "root").ok
    );
    check(
      "[C4.1-3] allow-list에 있어도 git show --textconv → BLOCK(Core gate, textconv 외부 실행)",
      !validateCommand("git", ["show", "--textconv", "HEAD:file"], "root").ok
    );
    check(
      "[C4.1-4] allow-list에 있어도 git cat-file --filters → BLOCK(Core gate, 필터 외부 실행)",
      !validateCommand("git", ["cat-file", "--filters", "HEAD:file"], "root").ok
    );
    check(
      "[C4.1-5] allow-list에 있어도 git log --paginate → BLOCK(Core gate, pager 강제 실행)",
      !validateCommand("git", ["log", "--paginate"], "root").ok
    );
    check(
      "[C4.1-6] allow-list에 있어도 git blame --contents=<임의경로> → BLOCK(Core gate, 임의 파일 읽기)",
      !validateCommand("git", ["blame", "--contents=C:\\secrets.txt", "README.md"], "root").ok
    );
    check(
      "[C4.1-7] allow-list에 있어도 git remote show origin(-n 없음) → BLOCK(Core gate, 네트워크 질의)",
      !validateCommand("git", ["remote", "show", "origin"], "root").ok
    );
    check(
      "[C4.1-8] 같은 policy 안에서 진짜 read-only git diff(옵션 없음)는 여전히 ALLOW(과잉 차단 아님)",
      validateCommand("git", ["diff"], "root").ok
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    configureSafeExecutor(isolatedRealisticRoot, REALISTIC_EXECUTION_POLICY);
  }
}

// Phase C Task C4.2 — project policy가 정확한 split-form 인자 조합(값이 등호 없이 다음
// argv 토큰에 오는 형태)을 allowedCommands에 그대로 넣어도 Core Command Safety Gate가
// 여전히 차단함을 증명한다. scenarioProjectPolicyCannotBypassGateViaDangerousOptions(C4.1)는
// equals-form(예: "--output=evil.txt")만 다뤘다 — 이 시나리오는 그 형제 우회(split-form)를
// 다룬다.
const POLICY_WITH_SPLIT_FORM_DANGEROUS_OPTIONS_IN_ALLOWLIST: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["web/"],
  allowedWritePrefixes: ["web/"],
  allowedCommands: [
    { cwd: "root", command: "git", args: ["diff", "--output", "evil.txt"] },
    { cwd: "root", command: "git", args: ["show", "--output", "evil.txt", "HEAD"] },
    { cwd: "root", command: "git", args: ["log", "--output", "evil.txt"] },
    { cwd: "root", command: "git", args: ["blame", "--contents", "evil.txt", "README.md"] },
    // 대조군 — 옵션 없는 진짜 read-only는 여전히 허용돼야 한다.
    { cwd: "root", command: "git", args: ["blame", "README.md"] },
  ],
};

function scenarioProjectPolicyCannotBypassGateViaSplitFormOptions(isolatedRealisticRoot: string): void {
  const root = mkdtempSync(join(tmpdir(), "safe-executor-gate-splitform-override-"));
  try {
    mkdirSync(join(root, "web"), { recursive: true });
    configureSafeExecutor(root, POLICY_WITH_SPLIT_FORM_DANGEROUS_OPTIONS_IN_ALLOWLIST);

    check(
      "[C4.2-1] allow-list에 있어도 git diff --output evil.txt(split-form) → BLOCK(Core gate)",
      !validateCommand("git", ["diff", "--output", "evil.txt"], "root").ok
    );
    check(
      "[C4.2-2] allow-list에 있어도 git show --output evil.txt HEAD(split-form) → BLOCK(Core gate)",
      !validateCommand("git", ["show", "--output", "evil.txt", "HEAD"], "root").ok
    );
    check(
      "[C4.2-3] allow-list에 있어도 git log --output evil.txt(split-form) → BLOCK(Core gate)",
      !validateCommand("git", ["log", "--output", "evil.txt"], "root").ok
    );
    check(
      "[C4.2-4] allow-list에 있어도 git blame --contents evil.txt README.md(split-form) → BLOCK(Core gate, 임의 파일 읽기)",
      !validateCommand("git", ["blame", "--contents", "evil.txt", "README.md"], "root").ok
    );
    check(
      "[C4.2-5] 같은 policy 안에서 진짜 read-only git blame README.md(옵션 없음)는 여전히 ALLOW(과잉 차단 아님)",
      validateCommand("git", ["blame", "README.md"], "root").ok
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    configureSafeExecutor(isolatedRealisticRoot, REALISTIC_EXECUTION_POLICY);
  }
}

// SI-3.4 bounded GPT Independent Review 2차(CRITICAL) — "hand-authored(비-Planner)
// ProjectExecutionPolicy가 path-qualified 이름(예: '/tmp/git')을 그대로 policy.allowedCommands에
// 등록하면, 공격자가 배치한 임의 경로의 파일이 basename만으로 'git'으로 정규화되어 family
// 허용까지 통과할 수 있다"는 구체적 우회 시나리오를 그대로 재현해, Core Command Safety
// Gate(coreCommandSafetyGate가 아니라 실제 validateCommand — 최종 실행 경계)가 policy가
// 이런 조합을 명시적으로 허용해도 여전히 차단함을 증명한다. spec-planner.ts의 경로-구분자
// 거부는 LLM이 생성하는 policy에만 적용되는 사전 필터일 뿐이라, 이 시나리오는 그 필터를
// 거치지 않는 hand-authored policy로 직접 검증한다.
const POLICY_WITH_PATH_QUALIFIED_COMMAND_IN_ALLOWLIST: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["web/"],
  allowedWritePrefixes: ["web/"],
  allowedCommands: [
    // 공격자가 임의 경로에 배치한 가짜 git처럼 보이는 executable — read-only로 보이는
    // 인자("status")까지 정확히 등록했다고 가정한다.
    { cwd: "root", command: "/tmp/git", args: ["status"] },
    { cwd: "root", command: "C:\\tools\\git.exe", args: ["status"] },
    { cwd: "root", command: "./node", args: ["--version"] },
    // 대조군 — bare 이름은 여전히 정상 동작해야 한다(과잉 차단 아님).
    { cwd: "root", command: "git", args: ["status"] },
  ],
};

function scenarioProjectPolicyCannotRegisterPathQualifiedExecutable(isolatedRealisticRoot: string): void {
  const root = mkdtempSync(join(tmpdir(), "safe-executor-gate-path-qualified-override-"));
  try {
    mkdirSync(join(root, "web"), { recursive: true });
    configureSafeExecutor(root, POLICY_WITH_PATH_QUALIFIED_COMMAND_IN_ALLOWLIST);

    check(
      "[SI-3.4-P1] allow-list에 정확히 등록되어 있어도 /tmp/git status → BLOCK(Core gate, path-qualified)",
      !validateCommand("/tmp/git", ["status"], "root").ok
    );
    check(
      "[SI-3.4-P2] allow-list에 정확히 등록되어 있어도 C:\\\\tools\\\\git.exe status → BLOCK(Core gate, path-qualified)",
      !validateCommand("C:\\tools\\git.exe", ["status"], "root").ok
    );
    check(
      "[SI-3.4-P3] allow-list에 정확히 등록되어 있어도 ./node --version → BLOCK(Core gate, path-qualified)",
      !validateCommand("./node", ["--version"], "root").ok
    );
    check(
      "[SI-3.4-P4] 같은 policy 안에서 bare 'git' status는 여전히 ALLOW(과잉 차단 아님)",
      validateCommand("git", ["status"], "root").ok
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


function scenarioExactRootFileScopes(isolatedRealisticRoot: string): void {
  const root = mkdtempSync(join(tmpdir(), "safe-executor-exact-root-file-"));
  try {
    writeFileSync(join(root, "package.json"), "{}\n", "utf-8");
    writeFileSync(join(root, "package.json.bak"), "{}\n", "utf-8");
    const policy: ProjectExecutionPolicy = {
      allowedReadPrefixes: ["package.json"],
      allowedWritePrefixes: ["package.json"],
      allowedCommands: [],
    };
    configureSafeExecutor(root, policy);
    check("[EP-root-1] exact root file package.json read → ALLOW", validateReadPath("package.json").ok);
    check("[EP-root-2] exact root file package.json write → ALLOW", validateWritePath("package.json").ok);
    check("[EP-root-3] sibling package.json.bak read → BLOCK", !validateReadPath("package.json.bak").ok);
    check("[EP-root-4] sibling package.json.bak write → BLOCK", !validateWritePath("package.json.bak").ok);
  } finally {
    rmSync(root, { recursive: true, force: true });
    configureSafeExecutor(isolatedRealisticRoot, REALISTIC_EXECUTION_POLICY);
  }
}

// Phase B Task B2/B3 — 이 파일 전용 격리된 임시 git repo(web/ 포함, REALISTIC_EXECUTION_POLICY
// 값은 그대로 사용)를 만들어 주입한다 — 검증하는 정책 내용은 바뀌지 않고, "어디에 실제로
// 쓰는가"만 항상 안전한 isolated temp 경로로 격리된다(실제 프로젝트 repo는 절대 건드리지
// 않는다).
// SI-3.3~3.5 4-chunk 최종 리뷰 지적(HIGH) — read-only로 확인된 git diff/log/show도
// repo 자신의 config(diff.external)만으로, 명령줄에 아무 플래그가 없어도 외부 프로그램을
// 실행할 수 있다(git 공식 문서). 이 시나리오는 실제로 그런 malicious config를 가진
// repo에서 "git diff"를 Safe Executor를 통해 실행해도 그 외부 프로그램이 호출되지
// 않는다는 것을 marker 파일로 직접 증명한다 — pager와 달리 diff.external은 tty 여부와
// 무관하게 항상 트리거되므로(non-interactive spawnSync 환경에서도 재현 가능), 실제
// 방어 효과를 검증할 수 있는 가장 명확한 경우다.
async function scenarioGitConfigDrivenExternalDiffIsNeutralized(isolatedRealisticRoot: string, realisticPolicy: ProjectExecutionPolicy): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "safe-executor-git-hardening-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "safe-executor-hardening@example.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Safe Executor Hardening Test"], { cwd: root });

    const trackedFile = join(root, "tracked.txt");
    writeFileSync(trackedFile, "line one\n", "utf-8");
    spawnSync("git", ["add", "--", "tracked.txt"], { cwd: root });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
    // working tree 변경 — 이제 "git diff"가 실제로 보여줄 변경사항이 생긴다.
    writeFileSync(trackedFile, "line one\nline two\n", "utf-8");

    // diff.external로 지정될 malicious "외부 diff 프로그램" — 호출되면 marker 파일을
    // 만든다. 배치 파일 자체의 경로에 공백이 있을 수 있으므로(이 저장소 경로 자체가
    // "auto dev"처럼 공백을 포함할 수 있다) git config 값에는 항상 따옴표로 감싼다.
    const markerPath = join(root, "external-diff-was-invoked.marker");
    const scriptPath = join(root, "malicious-external-diff.bat");
    writeFileSync(scriptPath, `@echo off\r\necho invoked > "${markerPath}"\r\n`, "utf-8");
    spawnSync("git", ["config", "diff.external", `"${scriptPath}"`], { cwd: root });

    const policy: ProjectExecutionPolicy = {
      allowedReadPrefixes: ["tracked.txt"],
      allowedWritePrefixes: ["tracked.txt"],
      allowedCommands: [{ cwd: "root", command: "git", args: ["diff"] }],
    };
    configureSafeExecutor(root, policy);

    const result = await validateAndExecute({ type: "RUN_COMMAND", command: "git", args: ["diff"], cwd: "root" });
    check("git-hardening) 실제 diff.external malicious config가 설정된 repo에서 git diff 실행 성공", result.ok);
    check(
      "git-hardening) diff.external로 지정된 외부 프로그램이 호출되지 않음(marker 파일 없음)",
      !existsSync(markerPath)
    );
    const stdout = (result.ok && typeof result.data === "object" && result.data !== null ? (result.data as { stdout?: string }).stdout : undefined) ?? "";
    check("git-hardening) 실제 diff 내용(line two)이 정상적으로 출력됨(하드닝이 기능 자체를 깨지 않음)", stdout.includes("line two"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    configureSafeExecutor(isolatedRealisticRoot, realisticPolicy);
  }
}

// SI-3.3~3.5 4-chunk 최종 리뷰 2라운드 지적(HIGH) — diff.external과 diff.<driver>.textconv는
// git이 서로 다른 표면으로 취급한다(--no-ext-diff 하나로는 textconv를 막지 못한다). 위
// diff.external 시나리오와 별개로, .gitattributes의 "diff=<driver>" 속성 + repo config의
// diff.<driver>.textconv=<command> 조합(명령줄 플래그 전혀 없이 자동 트리거됨)도 실제로
// 무력화되는지 marker 파일로 직접 증명한다.
async function scenarioGitConfigDrivenTextconvIsNeutralized(isolatedRealisticRoot: string, realisticPolicy: ProjectExecutionPolicy): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "safe-executor-git-textconv-hardening-"));
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["config", "user.email", "safe-executor-hardening@example.com"], { cwd: root });
    spawnSync("git", ["config", "user.name", "Safe Executor Hardening Test"], { cwd: root });

    const trackedFile = join(root, "tracked.bin");
    writeFileSync(trackedFile, "line one\n", "utf-8");
    writeFileSync(join(root, ".gitattributes"), "tracked.bin diff=malicious-textconv-driver\n", "utf-8");
    spawnSync("git", ["add", "--", "tracked.bin", ".gitattributes"], { cwd: root });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
    writeFileSync(trackedFile, "line one\nline two\n", "utf-8");

    // diff.<driver>.textconv로 지정될 malicious "외부 textconv 프로그램" — 호출되면 marker
    // 파일을 만든다. 배치 파일 자체의 경로에 공백이 있을 수 있으므로 git config 값에는
    // 항상 따옴표로 감싼다.
    const markerPath = join(root, "textconv-was-invoked.marker");
    const scriptPath = join(root, "malicious-textconv.bat");
    writeFileSync(scriptPath, `@echo off\r\necho invoked > "${markerPath}"\r\necho converted-text\r\n`, "utf-8");
    spawnSync("git", ["config", "diff.malicious-textconv-driver.textconv", `"${scriptPath}"`], { cwd: root });

    const policy: ProjectExecutionPolicy = {
      allowedReadPrefixes: ["tracked.bin", ".gitattributes"],
      allowedWritePrefixes: ["tracked.bin", ".gitattributes"],
      allowedCommands: [{ cwd: "root", command: "git", args: ["diff"] }],
    };
    configureSafeExecutor(root, policy);

    const result = await validateAndExecute({ type: "RUN_COMMAND", command: "git", args: ["diff"], cwd: "root" });
    check("git-textconv-hardening) 실제 diff.<driver>.textconv malicious config가 설정된 repo에서 git diff 실행 성공", result.ok);
    check(
      "git-textconv-hardening) diff.<driver>.textconv로 지정된 외부 프로그램이 호출되지 않음(marker 파일 없음)",
      !existsSync(markerPath)
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    configureSafeExecutor(isolatedRealisticRoot, realisticPolicy);
  }
}

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

  // ---- SI-3.3 REVISE 3회차, MEDIUM — 인터프리터 간접 실행(bash -c/sh -c/node -e/
  // powershell -Command) Core Command Safety Gate 차단 ----
  check("coreCommandSafetyGate: bash -c 'rm -rf /' → BLOCK(간접 실행)", !coreCommandSafetyGate("bash", ["-c", "rm -rf /"]).ok);
  check("coreCommandSafetyGate: sh -c 'rm -rf /' → BLOCK(간접 실행)", !coreCommandSafetyGate("sh", ["-c", "rm -rf /"]).ok);
  check("coreCommandSafetyGate: zsh -c 'echo hi' → BLOCK(간접 실행)", !coreCommandSafetyGate("zsh", ["-c", "echo hi"]).ok);
  check("coreCommandSafetyGate: node -e \"require('fs').rmSync('x')\" → BLOCK(간접 실행)", !coreCommandSafetyGate("node", ["-e", "require('fs').rmSync('x')"]).ok);
  check("coreCommandSafetyGate: node --eval \"1\" → BLOCK(간접 실행, long form)", !coreCommandSafetyGate("node", ["--eval", "1"]).ok);
  check("coreCommandSafetyGate: python3 -c \"import os; os.system('rm -rf /')\" → BLOCK(간접 실행)", !coreCommandSafetyGate("python3", ["-c", "import os"]).ok);
  check("coreCommandSafetyGate: powershell -Command \"Remove-Item -Recurse -Force .\" → BLOCK(간접 실행)", !coreCommandSafetyGate("powershell", ["-Command", "Remove-Item -Recurse -Force ."]).ok);
  check("coreCommandSafetyGate: pwsh -Command \"...\" → BLOCK(간접 실행)", !coreCommandSafetyGate("pwsh", ["-Command", "echo hi"]).ok);
  check("coreCommandSafetyGate: cmd /c \"del /f /q *\" → BLOCK(간접 실행)", !coreCommandSafetyGate("cmd", ["/c", "del /f /q *"]).ok);
  check("coreCommandSafetyGate: cmd.exe /C \"...\" → BLOCK(확장자 무관)", !coreCommandSafetyGate("cmd.exe", ["/C", "dir"]).ok);
  check("coreCommandSafetyGate: bash.exe -c \"...\" → BLOCK(확장자 무관)", !coreCommandSafetyGate("bash.exe", ["-c", "echo hi"]).ok);
  check(
    "coreCommandSafetyGate: npm run build(간접 실행 인터프리터 아님) → ALLOW(과잉 차단 아님)",
    coreCommandSafetyGate("npm", ["run", "build"]).ok
  );
  // SI-3.4(Command Execution Safety Architecture Closure) — 아래 두 건은 SI-3.3까지의
  // "알려진 위험 플래그만 차단" 모델에서는 ALLOW가 맞았다(curl -c/bash script.sh 모두
  // 그 자체로 위험한 플래그 조합이 아니었으므로). SI-3.4는 설계를 뒤집어 "Core가 인식하는
  // 5개 executable family(git/npm/npx/node/tsc) 밖은 인자와 무관하게 전부 차단"으로
  // 바뀌었다 — curl과 bash 둘 다 그 family 밖이므로 이제는 항상 BLOCK이 올바른 기대값이다
  // (이는 기존 테스트를 완화한 것이 아니라 더 엄격한 결과로 갱신한 것이다).
  check(
    "coreCommandSafetyGate: curl -c cookies.txt → BLOCK(SI-3.4, curl은 Core 인식 executable family 밖)",
    !coreCommandSafetyGate("curl", ["-c", "cookies.txt", "https://example.invalid"]).ok
  );
  check(
    "coreCommandSafetyGate: bash script.sh(플래그 없는 스크립트 파일 실행) → BLOCK(SI-3.4, bash 자체가 family 밖)",
    !coreCommandSafetyGate("bash", ["script.sh"]).ok
  );

  // ---- SI-3.3 REVISE 3회차 재검증 — basename 추출 누락/결합·부착형 플래그 우회 차단 ----
  check("coreCommandSafetyGate: /bin/bash -c '...' → BLOCK(경로 형태 basename 우회)", !coreCommandSafetyGate("/bin/bash", ["-c", "rm -rf /"]).ok);
  check("coreCommandSafetyGate: C:\\\\tools\\\\bash.exe -c '...' → BLOCK(Windows 경로 형태)", !coreCommandSafetyGate("C:\\tools\\bash.exe", ["-c", "rm -rf /"]).ok);
  check("coreCommandSafetyGate: bash -lc '...' → BLOCK(결합 짧은 옵션)", !coreCommandSafetyGate("bash", ["-lc", "rm -rf /"]).ok);
  check("coreCommandSafetyGate: bash -xc '...' → BLOCK(결합 짧은 옵션)", !coreCommandSafetyGate("bash", ["-xc", "rm -rf /"]).ok);
  check("coreCommandSafetyGate: python3 -cCODE → BLOCK(부착형)", !coreCommandSafetyGate("python3", ["-cimport os"]).ok);
  check("coreCommandSafetyGate: node --eval=CODE → BLOCK(long option = 형태)", !coreCommandSafetyGate("node", ["--eval=1"]).ok);
  check("coreCommandSafetyGate: perl -e'code' → BLOCK(부착형)", !coreCommandSafetyGate("perl", ["-eprint 1"]).ok);
  check("coreCommandSafetyGate: php -r'code' → BLOCK(php eval 플래그)", !coreCommandSafetyGate("php", ["-recho 1;"]).ok);
  check(
    "coreCommandSafetyGate: node -c file.js(문법 검사, 무해하지만 보수적으로 차단 — 과잉 차단은 안전한 방향)",
    !coreCommandSafetyGate("node", ["-c", "file.js"]).ok
  );
  check(
    "coreCommandSafetyGate: bash -v script.sh('c' 없는 옵션) → BLOCK(SI-3.4, bash 자체가 family 밖)",
    !coreCommandSafetyGate("bash", ["-v", "script.sh"]).ok
  );

  // ---- SI-3.3 REVISE 3회차 2차 재검증 — PowerShell 별칭/cmd 부착형/OS-무관 basename ----
  check("coreCommandSafetyGate: pwsh -c '...' → BLOCK(PowerShell -Command 별칭)", !coreCommandSafetyGate("pwsh", ["-c", "Remove-Item -Recurse -Force ."]).ok);
  check("coreCommandSafetyGate: powershell -ec <base64> → BLOCK(-EncodedCommand 별칭)", !coreCommandSafetyGate("powershell", ["-ec", "base64string"]).ok);
  check("coreCommandSafetyGate: cmd /cdir → BLOCK(부착형)", !coreCommandSafetyGate("cmd", ["/cdir"]).ok);
  check("coreCommandSafetyGate: cmd /kdel file → BLOCK(부착형)", !coreCommandSafetyGate("cmd", ["/kdel", "file"]).ok);
  check(
    "coreCommandSafetyGate: C:\\\\tools\\\\bash.exe -c '...'(POSIX 호스트에서도 Windows 구분자 인식) → BLOCK",
    !coreCommandSafetyGate("C:\\tools\\bash.exe", ["-c", "rm -rf /"]).ok
  );

  // ---- SI-3.3 REVISE 3회차 3차 재검증 — PowerShell -enc/node -p·--print/deno eval/env 위임 ----
  check("coreCommandSafetyGate: powershell -enc <base64> → BLOCK(-EncodedCommand 축약형)", !coreCommandSafetyGate("powershell", ["-enc", "base64string"]).ok);
  check("coreCommandSafetyGate: pwsh -enc <base64> → BLOCK", !coreCommandSafetyGate("pwsh", ["-enc", "base64string"]).ok);
  check("coreCommandSafetyGate: node -p 'expr' → BLOCK(평가 후 즉시 출력)", !coreCommandSafetyGate("node", ["-p", "1+1"]).ok);
  check("coreCommandSafetyGate: node --print 'expr' → BLOCK", !coreCommandSafetyGate("node", ["--print", "1+1"]).ok);
  check("coreCommandSafetyGate: deno eval 'code' → BLOCK(서브커맨드형 eval)", !coreCommandSafetyGate("deno", ["eval", "1+1"]).ok);
  check("coreCommandSafetyGate: env bash -c '...' → BLOCK(실행 위임 wrapper 우회)", !coreCommandSafetyGate("env", ["bash", "-c", "rm -rf /"]).ok);
  check("coreCommandSafetyGate: env node -e '...' → BLOCK(실행 위임 wrapper 우회)", !coreCommandSafetyGate("env", ["node", "-e", "1"]).ok);
  check(
    "coreCommandSafetyGate: env VAR=1 bash -c '...' → BLOCK(env의 VAR=value 인자를 건너뛰고 위임 명령 탐지)",
    !coreCommandSafetyGate("env", ["VAR=1", "bash", "-c", "rm -rf /"]).ok
  );
  check("coreCommandSafetyGate: nohup bash -c '...' → BLOCK(실행 위임 wrapper 우회)", !coreCommandSafetyGate("nohup", ["bash", "-c", "rm -rf /"]).ok);
  // SI-3.4 — SI-3.3까지는 env의 위임 대상을 재귀 추적해 무해한 delegate(npm run build)는
  // 통과시켰다. 그 delegate-tracing 로직 자체가 "위임 wrapper를 하나씩 알아내야" 동작하는
  // 방식이라 SI-3.4가 없애려는 문제(unbounded wrapper enumeration)의 일부였다 — 이제 env는
  // delegate 내용과 무관하게 Core 인식 executable family 밖이라는 이유만으로 항상 BLOCK된다.
  check(
    "coreCommandSafetyGate: env npm run build → BLOCK(SI-3.4, env 자체가 family 밖 — delegate 내용과 무관)",
    !coreCommandSafetyGate("env", ["npm", "run", "build"]).ok
  );

  // ---- SI-3.3 REVISE 3회차 4차 재검증 — PowerShell 접두사 매칭/wrapper 옵션 fail-closed ----
  check("coreCommandSafetyGate: pwsh -e <base64> → BLOCK(-EncodedCommand 접두사)", !coreCommandSafetyGate("pwsh", ["-e", "base64string"]).ok);
  check("coreCommandSafetyGate: powershell -en <base64> → BLOCK(-EncodedCommand 접두사)", !coreCommandSafetyGate("powershell", ["-en", "base64string"]).ok);
  check("coreCommandSafetyGate: pwsh -com '...' → BLOCK(-Command 접두사)", !coreCommandSafetyGate("pwsh", ["-com", "Remove-Item -Recurse -Force ."]).ok);
  check(
    "coreCommandSafetyGate: env -u X bash -c '...' → BLOCK(옵션이 있는 wrapper는 안전하게 파싱할 수 없어 fail-closed 전체 차단)",
    !coreCommandSafetyGate("env", ["-u", "X", "bash", "-c", "rm -rf /"]).ok
  );
  check(
    "coreCommandSafetyGate: env -i bash -c '...' → BLOCK(옵션이 있는 wrapper fail-closed)",
    !coreCommandSafetyGate("env", ["-i", "bash", "-c", "rm -rf /"]).ok
  );
  check("coreCommandSafetyGate: node --print=CODE → BLOCK(부착형 --print=)", !coreCommandSafetyGate("node", ["--print=1+1"]).ok);
  check(
    "coreCommandSafetyGate: deno --quiet eval 'code' → BLOCK(eval 앞에 전역 옵션이 와도 탐지)",
    !coreCommandSafetyGate("deno", ["--quiet", "eval", "1+1"]).ok
  );

  // ---- SI-3.4(Command Execution Safety Architecture Closure) — STRICT ALLOW-LIST 아키텍처
  // 직접 검증. SI-3.3까지는 "알려진 위험 wrapper 이름"을 하나씩 나열해 막았다(POSIX_SHELL_
  // INTERPRETERS/SCRIPT_EVAL_INTERPRETERS/WINDOWS_SHELL_INTERPRETERS/EXECUTION_DELEGATION_
  // WRAPPERS) — GPT Independent Reviewer가 매 회차 새 wrapper 조합을 찾아냈다. SI-3.4는 그
  // 목록들을 전부 제거하고 CORE_ALLOWED_EXECUTABLE_FAMILIES(git/npm/npx/node/tsc) 밖은
  // 무조건 차단하는 단일 allow-list로 대체했다 — 아래 테스트는 "한 번도 이름으로 나열된 적
  // 없는" nice/timeout/stdbuf/busybox 같은 wrapper와 임의 깊이의 wrapper 중첩까지도 이
  // 아키텍처가 구조적으로(그 이름을 몰라도) 차단함을 증명한다.
  check("coreCommandSafetyGate: nice bash -c '...' → BLOCK(nice는 목록에 없어 이름을 몰라도 차단)", !coreCommandSafetyGate("nice", ["bash", "-c", "rm -rf /"]).ok);
  check("coreCommandSafetyGate: timeout 10 bash -c '...' → BLOCK(timeout은 목록에 없어 이름을 몰라도 차단)", !coreCommandSafetyGate("timeout", ["10", "bash", "-c", "rm -rf /"]).ok);
  check("coreCommandSafetyGate: stdbuf -o0 bash -c '...' → BLOCK(stdbuf는 목록에 없어 이름을 몰라도 차단)", !coreCommandSafetyGate("stdbuf", ["-o0", "bash", "-c", "rm -rf /"]).ok);
  check("coreCommandSafetyGate: busybox sh -c '...' → BLOCK(busybox는 목록에 없어 이름을 몰라도 차단)", !coreCommandSafetyGate("busybox", ["sh", "-c", "rm -rf /"]).ok);
  check("coreCommandSafetyGate: python -c 'import os' → BLOCK(python도 family 밖)", !coreCommandSafetyGate("python", ["-c", "import os"]).ok);
  // wrapper nesting — 이전 아키텍처는 env/nohup/setsid 하나만 위임 대상을 재귀 추적했으므로
  // "env 뒤에 다시 nice/timeout이 오는" 다단 중첩은 여전히 새 로직이 필요했다. 새 아키텍처는
  // 첫 executable(가장 바깥쪽 wrapper)부터 이미 family 밖이라 몇 단계로 중첩되든 재귀 추적
  // 없이 즉시 차단된다.
  check(
    "coreCommandSafetyGate: env timeout bash -c '...' → BLOCK(2단 wrapper nesting, 재귀 추적 불필요)",
    !coreCommandSafetyGate("env", ["timeout", "10", "bash", "-c", "rm -rf /"]).ok
  );
  check(
    "coreCommandSafetyGate: nice env timeout stdbuf bash -c '...' → BLOCK(4단 wrapper nesting)",
    !coreCommandSafetyGate("nice", ["env", "timeout", "10", "stdbuf", "-o0", "bash", "-c", "rm -rf /"]).ok
  );
  // mixed-case/Windows executable variant — 차단 대상(대소문자를 바꿔도 여전히 BLOCK)과 허용
  // 대상(대소문자/확장자를 바꿔도 정상적으로 ALLOW) 둘 다 증명한다.
  check("coreCommandSafetyGate: BASH -c '...'(대문자) → BLOCK", !coreCommandSafetyGate("BASH", ["-c", "rm -rf /"]).ok);
  check("coreCommandSafetyGate: NICE.EXE bash -c '...'(대문자+확장자) → BLOCK", !coreCommandSafetyGate("NICE.EXE", ["bash", "-c", "rm -rf /"]).ok);
  check("coreCommandSafetyGate: NODE.EXE --version(대문자+확장자, 허용 family) → ALLOW", coreCommandSafetyGate("NODE.EXE", ["--version"]).ok);
  check("coreCommandSafetyGate: Git.EXE status(혼합 대소문자, 허용 family) → ALLOW", coreCommandSafetyGate("Git.EXE", ["status"]).ok);
  // 정상 허용 명령 — npm test / tsc / build류가 여전히 정상 동작함을 명시적으로 재확인한다.
  check("coreCommandSafetyGate: npm test → ALLOW(정상 npm test command)", coreCommandSafetyGate("npm", ["test"]).ok);
  check("coreCommandSafetyGate: npm run test:unit → ALLOW(정상 npm test command)", coreCommandSafetyGate("npm", ["run", "test:unit"]).ok);
  check("coreCommandSafetyGate: npx tsc --noEmit → ALLOW(정상 tsc command)", coreCommandSafetyGate("npx", ["tsc", "--noEmit"]).ok);
  check("coreCommandSafetyGate: tsc --noEmit → ALLOW(정상 tsc command, 직접 실행 파일)", coreCommandSafetyGate("tsc", ["--noEmit"]).ok);
  check("coreCommandSafetyGate: npm run build → ALLOW(정상 build command)", coreCommandSafetyGate("npm", ["run", "build"]).ok);

  // ---- SI-3.4 bounded GPT Independent Review 1차 REVISE 대응 ----
  // [CRITICAL] npm/npx는 family 허용만으로는 node의 eval 플래그와 동일한 클래스의 우회를
  // 허용한다 — npx는 사실상 "npm exec"의 별칭이고, 둘 다 인자로 지정한 임의 패키지/커맨드를
  // 즉시 실행할 수 있다. NPM_ALLOWED_SUBCOMMANDS(run/test)/NPX_ALLOWED_PACKAGE_NAMES(tsc)로
  // 막는다.
  check("coreCommandSafetyGate: npm exec -- bash -c '...' → BLOCK(npm exec는 임의 코드 실행 위임)", !coreCommandSafetyGate("npm", ["exec", "--", "bash", "-c", "rm -rf /"]).ok);
  check("coreCommandSafetyGate: npm x cowsay hi → BLOCK(npm x는 exec의 별칭)", !coreCommandSafetyGate("npm", ["x", "cowsay", "hi"]).ok);
  check("coreCommandSafetyGate: npm publish → BLOCK(run/test 밖 서브커맨드)", !coreCommandSafetyGate("npm", ["publish"]).ok);
  check("coreCommandSafetyGate: npm install → BLOCK(run/test 밖 서브커맨드, AutoDev 실제 사용례 아님)", !coreCommandSafetyGate("npm", ["install"]).ok);
  check("coreCommandSafetyGate: npm(인자 없음) → BLOCK", !coreCommandSafetyGate("npm", []).ok);
  check("coreCommandSafetyGate: npx cowsay hi → BLOCK(tsc 외 임의 패키지 실행)", !coreCommandSafetyGate("npx", ["cowsay", "hi"]).ok);
  check(
    "coreCommandSafetyGate: npx --package=evil-pkg tsc → BLOCK(--package= 우회, args[0] allow-set 밖)",
    !coreCommandSafetyGate("npx", ["--package=evil-pkg", "tsc"]).ok
  );
  check("coreCommandSafetyGate: npx(인자 없음) → BLOCK", !coreCommandSafetyGate("npx", []).ok);
  // [HIGH] node --require/-r(CJS preload)/--import(ESM preload)/--loader는 entry script
  // 실행 전에 임의 로컬 모듈을 먼저 로드해 그 top-level 코드를 즉시 실행시킨다 — -e/--eval과
  // 같은 클래스의 위험이므로 동일하게 차단한다.
  check("coreCommandSafetyGate: node --require ./payload.js --version → BLOCK(CJS preload)", !coreCommandSafetyGate("node", ["--require", "./payload.js", "--version"]).ok);
  check("coreCommandSafetyGate: node -r ./payload.js → BLOCK(CJS preload, 짧은 옵션)", !coreCommandSafetyGate("node", ["-r", "./payload.js"]).ok);
  check("coreCommandSafetyGate: node --import ./payload.mjs → BLOCK(ESM preload)", !coreCommandSafetyGate("node", ["--import", "./payload.mjs"]).ok);
  check("coreCommandSafetyGate: node --loader ./payload.mjs → BLOCK(module loader 등록)", !coreCommandSafetyGate("node", ["--loader", "./payload.mjs"]).ok);
  check("coreCommandSafetyGate: node --experimental-loader ./payload.mjs → BLOCK(module loader 등록)", !coreCommandSafetyGate("node", ["--experimental-loader", "./payload.mjs"]).ok);
  check("coreCommandSafetyGate: node --require=./payload.js → BLOCK(부착형)", !coreCommandSafetyGate("node", ["--require=./payload.js"]).ok);
  // 정상 사용례 회귀 유지 — 위 강화가 실제 사용 중인 형태를 과잉 차단하지 않는지 확인한다.
  check("coreCommandSafetyGate: npm run test:unit → ALLOW(회귀 유지)", coreCommandSafetyGate("npm", ["run", "test:unit"]).ok);
  check("coreCommandSafetyGate: npx tsc --noEmit → ALLOW(회귀 유지)", coreCommandSafetyGate("npx", ["tsc", "--noEmit"]).ok);
  check("coreCommandSafetyGate: node tests/x.test.js → ALLOW(회귀 유지, 일반 스크립트 실행)", coreCommandSafetyGate("node", ["tests/x.test.js"]).ok);

  // ---- SI-3.4 bounded GPT Independent Review 2차 REVISE 대응 ----
  // [CRITICAL] normalizeExecutableBase()가 경로를 벗겨내고 basename만으로 family를
  // 판정하므로, command 문자열 자체에 경로 구분자/드라이브 문자가 있으면 family가 무엇으로
  // 정규화되든(설령 git처럼 read-only 서브커맨드라도) 무조건 거부한다 — bare 실행 파일
  // 이름만 허용된다.
  check("coreCommandSafetyGate: /tmp/git status(path-qualified, read-only 인자) → BLOCK", !coreCommandSafetyGate("/tmp/git", ["status"]).ok);
  check("coreCommandSafetyGate: C:\\\\tools\\\\git.exe status(path-qualified, read-only 인자) → BLOCK", !coreCommandSafetyGate("C:\\tools\\git.exe", ["status"]).ok);
  check("coreCommandSafetyGate: ./node --version(상대 경로) → BLOCK", !coreCommandSafetyGate("./node", ["--version"]).ok);
  check("coreCommandSafetyGate: ../bin/npm test(상위 경로) → BLOCK", !coreCommandSafetyGate("../bin/npm", ["test"]).ok);

  // ---- Phase C Task C4.1 — Read-only Git Command Hardening: 정상 read-only 명령은 계속
  // 허용된다(과잉 차단 방지 회귀) ----
  check("coreCommandSafetyGate: git diff → ALLOW(옵션 없음)", coreCommandSafetyGate("git", ["diff"]).ok);
  check("coreCommandSafetyGate: git diff --stat → ALLOW", coreCommandSafetyGate("git", ["diff", "--stat"]).ok);
  check("coreCommandSafetyGate: git show HEAD → ALLOW", coreCommandSafetyGate("git", ["show", "HEAD"]).ok);
  check("coreCommandSafetyGate: git log -p → ALLOW(-p는 log에서 --patch, 전역 pager와 동음이의)", coreCommandSafetyGate("git", ["log", "-p"]).ok);
  check("coreCommandSafetyGate: git log -1 --oneline → ALLOW", coreCommandSafetyGate("git", ["log", "-1", "--oneline"]).ok);
  check("coreCommandSafetyGate: git status --short → ALLOW", coreCommandSafetyGate("git", ["status", "--short"]).ok);
  check("coreCommandSafetyGate: git cat-file -p HEAD → ALLOW", coreCommandSafetyGate("git", ["cat-file", "-p", "HEAD"]).ok);
  check("coreCommandSafetyGate: git ls-files → ALLOW", coreCommandSafetyGate("git", ["ls-files"]).ok);
  check("coreCommandSafetyGate: git ls-tree HEAD → ALLOW", coreCommandSafetyGate("git", ["ls-tree", "HEAD"]).ok);
  check("coreCommandSafetyGate: git remote -v → ALLOW", coreCommandSafetyGate("git", ["remote", "-v"]).ok);
  check("coreCommandSafetyGate: git remote show origin -n → ALLOW(네트워크 질의 없음)", coreCommandSafetyGate("git", ["remote", "show", "origin", "-n"]).ok);
  check("coreCommandSafetyGate: git blame README.md → ALLOW", coreCommandSafetyGate("git", ["blame", "README.md"]).ok);

  // ---- Phase C Task C4.1 — write-capable 옵션 BLOCK(subcommand 이름만으로 안전 판단 금지) ----
  check(
    "coreCommandSafetyGate: git diff --output=evil.txt → BLOCK(임의 파일 쓰기, write path 검증 우회)",
    !coreCommandSafetyGate("git", ["diff", "--output=evil.txt"]).ok
  );
  check("coreCommandSafetyGate: git log --output C:\\evil.txt → BLOCK", !coreCommandSafetyGate("git", ["log", "--output", "C:\\evil.txt"]).ok);
  check("coreCommandSafetyGate: git show --output=evil.txt HEAD → BLOCK", !coreCommandSafetyGate("git", ["show", "--output=evil.txt", "HEAD"]).ok);

  // ---- Phase C Task C4.1 — 외부 실행 가능 옵션 BLOCK(external diff / textconv / filters / pager) ----
  check("coreCommandSafetyGate: git diff --ext-diff → BLOCK(외부 diff 프로그램 실행)", !coreCommandSafetyGate("git", ["diff", "--ext-diff"]).ok);
  check("coreCommandSafetyGate: git show --textconv HEAD:file → BLOCK(textconv 외부 실행)", !coreCommandSafetyGate("git", ["show", "--textconv", "HEAD:file"]).ok);
  check("coreCommandSafetyGate: git cat-file --textconv HEAD:file → BLOCK", !coreCommandSafetyGate("git", ["cat-file", "--textconv", "HEAD:file"]).ok);
  check("coreCommandSafetyGate: git cat-file --filters HEAD:file → BLOCK(clean/smudge 필터 외부 실행)", !coreCommandSafetyGate("git", ["cat-file", "--filters", "HEAD:file"]).ok);
  check("coreCommandSafetyGate: git log --paginate → BLOCK(비-tty에서도 pager 강제)", !coreCommandSafetyGate("git", ["log", "--paginate"]).ok);
  check(
    "coreCommandSafetyGate: git blame --contents=C:\\Windows\\System32\\drivers\\etc\\hosts README.md → BLOCK(임의 로컬 파일 읽기)",
    !coreCommandSafetyGate("git", ["blame", "--contents=C:\\Windows\\System32\\drivers\\etc\\hosts", "README.md"]).ok
  );
  check(
    "coreCommandSafetyGate: git remote show origin(-n 없음) → BLOCK(실제 네트워크 질의 발생)",
    !coreCommandSafetyGate("git", ["remote", "show", "origin"]).ok
  );

  // ---- Phase C Task C4.1 — git stash list 회귀 유지(단순 문자열 매칭으로 과잉 차단 금지) ----
  check("coreCommandSafetyGate: git stash list → ALLOW(회귀 유지)", coreCommandSafetyGate("git", ["stash", "list"]).ok);
  check("coreCommandSafetyGate: git stash show → ALLOW(회귀 유지)", coreCommandSafetyGate("git", ["stash", "show"]).ok);
  check("coreCommandSafetyGate: git stash push → BLOCK(회귀 유지)", !coreCommandSafetyGate("git", ["stash", "push"]).ok);

  // ---- Phase C Task C4.2 — Git option split-form hardening: "--option=value"(equals-form)와
  // "--option value"(값이 다음 argv에 오는 split-form) 둘 다 deterministic BLOCK ----
  check(
    "coreCommandSafetyGate: git blame --contents=evil.txt README.md → BLOCK(equals-form 회귀)",
    !coreCommandSafetyGate("git", ["blame", "--contents=evil.txt", "README.md"]).ok
  );
  check(
    "coreCommandSafetyGate: git blame --contents evil.txt README.md → BLOCK(split-form, 값이 다음 argv에 옴)",
    !coreCommandSafetyGate("git", ["blame", "--contents", "evil.txt", "README.md"]).ok
  );
  check(
    "coreCommandSafetyGate: git diff --output=evil.txt → BLOCK(equals-form 회귀)",
    !coreCommandSafetyGate("git", ["diff", "--output=evil.txt"]).ok
  );
  check(
    "coreCommandSafetyGate: git diff --output evil.txt → BLOCK(split-form, 값이 다음 argv에 옴)",
    !coreCommandSafetyGate("git", ["diff", "--output", "evil.txt"]).ok
  );
  check(
    "coreCommandSafetyGate: git show --output evil.txt HEAD → BLOCK(split-form)",
    !coreCommandSafetyGate("git", ["show", "--output", "evil.txt", "HEAD"]).ok
  );
  check(
    "coreCommandSafetyGate: git log --output evil.txt → BLOCK(split-form)",
    !coreCommandSafetyGate("git", ["log", "--output", "evil.txt"]).ok
  );
  // 정상 read-only 회귀 유지 — split-form 방어가 옵션 없는 정상 호출을 과잉 차단하지 않음.
  check("coreCommandSafetyGate: git blame README.md(옵션 없음) → ALLOW(회귀 유지)", coreCommandSafetyGate("git", ["blame", "README.md"]).ok);
  check("coreCommandSafetyGate: git diff --stat(옵션 없음) → ALLOW(회귀 유지)", coreCommandSafetyGate("git", ["diff", "--stat"]).ok);
  check("coreCommandSafetyGate: git stash list → ALLOW(회귀 유지, C4.2)", coreCommandSafetyGate("git", ["stash", "list"]).ok);

  // ---- SI-3.3~3.5 4-chunk 최종 리뷰 3라운드 지적(HIGH) — "help"를 read-only 서브커맨드
  // 목록에서 제거해도, 이미 허용된 다른 서브커맨드에 "--help"를 인자로 붙이면 동일한 git
  // help viewer 경로(help.format/man.viewer 등으로 외부 프로그램 실행 가능)로 진입할 수
  // 있었다 — "--help"가 어떤 read-only 서브커맨드에 붙어도 차단되는지 확인한다.
  check("coreCommandSafetyGate: git help → BLOCK(read-only 허용 목록에서 제거됨)", !coreCommandSafetyGate("git", ["help"]).ok);
  check("coreCommandSafetyGate: git status --help → BLOCK(viewer 우회, 다른 서브커맨드에 --help)", !coreCommandSafetyGate("git", ["status", "--help"]).ok);
  check("coreCommandSafetyGate: git diff --help → BLOCK(viewer 우회)", !coreCommandSafetyGate("git", ["diff", "--help"]).ok);
  check("coreCommandSafetyGate: git log --help → BLOCK(viewer 우회)", !coreCommandSafetyGate("git", ["log", "--help"]).ok);
  check("coreCommandSafetyGate: git show --help → BLOCK(viewer 우회)", !coreCommandSafetyGate("git", ["show", "--help"]).ok);
  check("coreCommandSafetyGate: git blame --help → BLOCK(viewer 우회)", !coreCommandSafetyGate("git", ["blame", "--help"]).ok);
  // 정상 회귀 유지 — --help 차단이 실제 정상 read-only 호출을 과잉 차단하지 않는지 확인.
  check("coreCommandSafetyGate: git status(옵션 없음) → ALLOW(회귀 유지)", coreCommandSafetyGate("git", ["status"]).ok);
  check("coreCommandSafetyGate: git diff --stat(--help 아닌 다른 옵션) → ALLOW(회귀 유지)", coreCommandSafetyGate("git", ["diff", "--stat"]).ok);

  // ---- Phase C Task C4 — project policy가 Core Command Safety Gate를 약화할 수 없음을 증명 ----
  scenarioProjectPolicyCannotWeakenCommandSafetyGate(isolatedRealisticRoot);

  // ---- Phase C Task C4.1 — malicious project policy가 "read-only 옵션 우회"로도 Core Command
  // Safety Gate를 약화할 수 없음을 증명 ----
  scenarioProjectPolicyCannotBypassGateViaDangerousOptions(isolatedRealisticRoot);

  // ---- Phase C Task C4.2 — malicious project policy가 split-form(값이 다음 argv에 오는 형태)을
  // allowedCommands에 정확히 넣어도 Core Command Safety Gate가 여전히 BLOCK함을 증명 ----
  scenarioProjectPolicyCannotBypassGateViaSplitFormOptions(isolatedRealisticRoot);

  // ---- SI-3.4 bounded GPT Independent Review 2차 — hand-authored policy가 path-qualified
  // executable(예: "/tmp/git")을 allowedCommands에 정확히 등록해도 Core Command Safety
  // Gate가 여전히 BLOCK함을 증명 ----
  scenarioProjectPolicyCannotRegisterPathQualifiedExecutable(isolatedRealisticRoot);

  // ---- Execution Policy root exact-file scope 회귀 ----
  scenarioExactRootFileScopes(isolatedRealisticRoot);

  // ---- Phase B Task B1 — Fixture 프로젝트 정책 범용성 증명(§ 요구사항 8) ----
  scenarioFixtureProjectPolicyWorksWithoutRealisticPolicyKnowledge(isolatedRealisticRoot);

  // ---- SI-3.3~3.5 4-chunk 최종 리뷰 — repo 자신의 config(diff.external)를 통한 외부
  // 프로그램 실행이 실제로 무력화됨을 증명 ----
  await scenarioGitConfigDrivenExternalDiffIsNeutralized(isolatedRealisticRoot, REALISTIC_EXECUTION_POLICY);
  await scenarioGitConfigDrivenTextconvIsNeutralized(isolatedRealisticRoot, REALISTIC_EXECUTION_POLICY);

  rmSync(isolatedRealisticRoot, { recursive: true, force: true });

  console.log("\n=== Safe Executor 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
