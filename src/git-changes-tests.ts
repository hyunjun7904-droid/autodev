import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { getWorkingTreeChanges, getTrackedDiff, readUntrackedFiles } from "./git-changes";
import { PROJECT_ROOT, configureSafeExecutor } from "./safe-executor";
import type { ProjectExecutionPolicy } from "./project-policy";

// Phase B Task B2 — 물리적 repository 분리 이전에는 MOVAN_PROJECT_MANIFEST(targetProjectRoot=
// 실제 MOVAN repo root)를 그대로 주입했다 — PROJECT_ROOT가 곧 automation/ 하위에 실제로 파일을
// 쓸 수 있는 MOVAN repo였기 때문이다. AutoDev standalone repo에서는 targetProjectRoot가 MOVAN과
// 무관한 임의의 경로일 수 있으므로, scenarioReadUntrackedFilesContentAndTruncation() 전용으로
// 이 파일 자신의 격리된 임시 git repo(automation/ 하위 write 가능)를 만들어 주입한다.
const TEST_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["automation/"],
  allowedWritePrefixes: ["automation/"],
  allowedCommands: [],
};

function makeIsolatedTestRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "git-changes-tests-root-"));
  mkdirSync(join(root, "automation"), { recursive: true });
  return root;
}

// git-changes.ts는 이전 gpt-reviewer.ts(GPT가 신규 untracked 파일을 review 대상에서
// 전혀 보지 못하던 치명적 구조 문제)와 claude-developer.ts(getActualChangedFiles가
// "git diff --name-only"만 써서 신규 파일을 놓치던 문제)가 공유하는 단일 출처다. 여기서는
// 실제 프로젝트 repo가 아니라 OS 임시 디렉터리에 만든 throwaway git repo로 검증한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "movan-git-changes-test-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "autodev-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "AutoDev Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function writeFile(repo: string, relPath: string, content: string): void {
  const abs = join(repo, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function scenarioUntrackedFilesDetected(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "web/app/new-page.tsx", "export default function P() { return null; }\n");
    writeFile(repo, "automation/src/new-module.ts", "export const x = 1;\n");
    const changes = getWorkingTreeChanges(["web/", "automation/"], repo);
    check("untracked: web/app/new-page.tsx가 untracked로 잡힘(디렉터리 단위로 뭉개지지 않음)", changes.untracked.some((c) => c.path === "web/app/new-page.tsx"));
    check("untracked: automation/src/new-module.ts가 untracked로 잡힘", changes.untracked.some((c) => c.path === "automation/src/new-module.ts"));
    check("untracked: all에도 두 파일 모두 포함(getActualChangedFiles가 쓰는 값)", changes.all.length === 2);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioTrackedModifiedDetected(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "web/app/existing.tsx", "export const v = 1;\n");
    spawnSync("git", ["add", "--", "web/app/existing.tsx"], { cwd: repo });
    spawnSync("git", ["commit", "-q", "-m", "add existing"], { cwd: repo });
    writeFile(repo, "web/app/existing.tsx", "export const v = 2;\n");

    const changes = getWorkingTreeChanges(["web/"], repo);
    check("tracked: 수정된 기존 파일이 tracked로 분류됨", changes.tracked.some((c) => c.path === "web/app/existing.tsx" && c.status === "modified"));
    check("tracked: untracked에는 포함되지 않음", !changes.untracked.some((c) => c.path === "web/app/existing.tsx"));

    const diff = getTrackedDiff(["web/"], repo);
    check("getTrackedDiff: 실제 diff 내용에 변경된 값(v = 2)이 포함됨", diff.includes("v = 2"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioSecretAndBuildArtifactsExcluded(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "web/lib/my-secret-key.ts", "export const leak = 'oops';\n");
    writeFile(repo, "automation/.env", "OPENAI_API_KEY=should-not-appear\n");
    writeFile(repo, "web/app/safe.tsx", "export default function S() { return null; }\n");

    const changes = getWorkingTreeChanges(["web/", "automation/"], repo);
    check("제외: web/lib/my-secret-key.ts(secret 이름 패턴)가 excluded에 포함", changes.excluded.includes("web/lib/my-secret-key.ts"));
    check("제외: automation/.env가 excluded에 포함", changes.excluded.includes("automation/.env"));
    check("제외: secret/env 파일이 all/untracked에는 없음(review/commit 대상에서 완전히 빠짐)", !changes.all.some((c) => c.path.includes("secret-key")) && !changes.all.some((c) => c.path === "automation/.env"));
    check("정상 파일: web/app/safe.tsx는 여전히 포함됨(과잉 차단 아님)", changes.all.some((c) => c.path === "web/app/safe.tsx"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioTempFixtureFilesExcludedFromReview(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "automation/tmp-some-fixture.txt", "fixture only, not real work\n");
    const changes = getWorkingTreeChanges(["automation/"], repo);
    check("제외: automation/tmp-*.txt(테스트 fixture)가 review/commit 대상에서 제외됨", changes.excluded.includes("automation/tmp-some-fixture.txt"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioReadUntrackedFilesContentAndTruncation(): void {
  // readUntrackedFiles()는 Safe Executor의 validateReadPath()를 통해서만 파일을 읽는다 —
  // 이 검증은 항상 "실제" PROJECT_ROOT를 기준으로 경로를 해석한다(보안 경계이므로 임의의
  // cwd override를 받지 않는다). 그래서 이 시나리오만은 throwaway temp git repo가 아니라
  // 실제 프로젝트 밑(automation/)에 짧게 존재하는 fixture 파일을 만들어 검증하고, 끝나면
  // 바로 지운다 — safe-executor-tests.ts/claude-developer-tests.ts가 이미 쓰는 것과 동일한
  // 패턴이다(project-state.json 등 상태 파일은 전혀 건드리지 않는다).
  const fixtureRel = "automation/git-changes-read-fixture.ts";
  const fixtureAbs = resolve(PROJECT_ROOT, fixtureRel);
  try {
    writeFileSync(fixtureAbs, "export const small = true;\n", "utf-8");

    const { files, skipped } = readUntrackedFiles([{ path: fixtureRel, status: "untracked" }]);
    check("readUntrackedFiles: 정상 파일 내용을 읽어옴", files.some((f) => f.path === fixtureRel && f.content.includes("small")));
    check("readUntrackedFiles: skipped 없음(정상 케이스)", skipped.length === 0);

    // 예산 초과 — totalBudgetChars를 아주 작게 주면 skipped에 기록되어야 한다("어떤 파일이
    // 잘렸는지 reviewer가 알 수 있게" 요구사항).
    const tiny = readUntrackedFiles([{ path: fixtureRel, status: "untracked" }], { totalBudgetChars: 1 });
    check(
      "readUntrackedFiles: 예산 초과 시 skipped에 파일이 기록됨(잘림 추적 가능)",
      tiny.skipped.length + tiny.files.length > 0 && (tiny.skipped.length > 0 || tiny.files[0].truncated)
    );
  } finally {
    if (existsSync(fixtureAbs)) unlinkSync(fixtureAbs);
    check("readUntrackedFiles fixture 정리 완료", !existsSync(fixtureAbs));
  }
}

function main(): void {
  // scenarioReadUntrackedFilesContentAndTruncation()이 readUntrackedFiles()를 통해 실제
  // Safe Executor(validateReadPath)를 호출한다 — configureSafeExecutor()로 명시적으로
  // 주입되기 전까지 어떤 프로젝트로도 조용히 fallback하지 않으므로 먼저 이 파일 전용 격리된
  // root+정책을 주입한다(§ 파일 상단 주석 — Phase B Task B2).
  const isolatedRoot = makeIsolatedTestRoot();
  try {
    configureSafeExecutor(isolatedRoot, TEST_EXECUTION_POLICY);

    scenarioUntrackedFilesDetected();
    scenarioTrackedModifiedDetected();
    scenarioSecretAndBuildArtifactsExcluded();
    scenarioTempFixtureFilesExcludedFromReview();
    scenarioReadUntrackedFilesContentAndTruncation();
  } finally {
    rmSync(isolatedRoot, { recursive: true, force: true });
  }

  console.log("\n=== git-changes(untracked 파일 포함/제외 정책) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
