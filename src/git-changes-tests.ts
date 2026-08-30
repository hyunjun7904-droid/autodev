import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  getWorkingTreeChanges,
  getTrackedDiff,
  readUntrackedFiles,
  buildBoundedFileSnapshot,
  isBinaryContent,
  readFileSmartly,
  classifyGeneratedCacheArtifact,
} from "./git-changes";
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

// AutoDev Core Maintenance(2026-08-30, Category B/D — Git Path Parsing Safety). git status
// --porcelain(quoting 모드)는 실측 결과 공백만 있어도(`?? "with space.txt"`) 큰따옴표로
// 감싸고, 비ASCII 문자는 8진수로 이스케이프한다(`?? "\355\225\234\352\270\200.txt"`) —
// -z(NUL 종결, quoting 없음)로 전환해 이 class의 문제를 구조적으로 막는다(§ git-changes.ts
// parsePorcelainRecords 주석).
function scenarioUntrackedFileWithSpaceInNameParsedCorrectly(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "web/app/with space.tsx", "export const v = 1;\n");
    const changes = getWorkingTreeChanges(["web/"], repo);
    check(
      "공백 포함 파일명: 경로가 quote 없이 정확히 파싱됨(web/app/with space.tsx)",
      changes.untracked.some((c) => c.path === "web/app/with space.tsx")
    );
    check("공백 포함 파일명: 큰따옴표가 경로에 남아있지 않음", !changes.all.some((c) => c.path.includes('"')));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioUntrackedFileWithUnicodeNameParsedCorrectly(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "web/app/한글파일.tsx", "export const v = 1;\n");
    const changes = getWorkingTreeChanges(["web/"], repo);
    check(
      "유니코드 파일명: 8진수 이스케이프 없이 정확히 파싱됨(web/app/한글파일.tsx)",
      changes.untracked.some((c) => c.path === "web/app/한글파일.tsx")
    );
    check("유니코드 파일명: 8진수 이스케이프 시퀀스가 남아있지 않음", !changes.all.some((c) => /\\\d{3}/.test(c.path)));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioStagedRenameWithSpaceParsedCorrectly(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "web/app/old name.tsx", "export const v = 1;\n");
    spawnSync("git", ["add", "--", "web/app/old name.tsx"], { cwd: repo });
    spawnSync("git", ["commit", "-q", "-m", "add old name"], { cwd: repo });
    spawnSync("git", ["mv", "web/app/old name.tsx", "web/app/new name.tsx"], { cwd: repo });

    const changes = getWorkingTreeChanges(["web/"], repo);
    const renamed = changes.all.find((c) => c.status === "renamed");
    check("공백 포함 rename: renamed 레코드 발견", renamed !== undefined);
    check("공백 포함 rename: 새 경로가 quote 없이 정확함(web/app/new name.tsx)", renamed?.path === "web/app/new name.tsx");
    check("공백 포함 rename: renamedFrom이 quote 없이 정확함(web/app/old name.tsx)", renamed?.renamedFrom === "web/app/old name.tsx");
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

// AutoDev Core Maintenance — Reviewer Payload Binary Safety(Category D). 실제 바이트 내용으로
// binary를 판정한다(확장자 blacklist가 아니다) — 이 시나리오는 .ts 확장자를 가진 파일이라도
// NUL 바이트가 있으면 binary로 판정되고, 반대로 확장자가 없어도 순수 텍스트면 그대로
// 읽힌다는 것을 함께 증명한다.
function scenarioBinaryContentDetection(): void {
  const textBuf = Buffer.from("export const x = 1;\n", "utf-8");
  check("isBinaryContent: 순수 텍스트는 binary가 아님", isBinaryContent(textBuf) === false);

  const binaryBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]); // PNG 헤더류 + NUL
  check("isBinaryContent: NUL 바이트가 포함되면 binary로 판정", isBinaryContent(binaryBuf) === true);

  const extensionLiesBuf = Buffer.concat([Buffer.from("looks like text but has a "), Buffer.from([0x00]), Buffer.from("nul byte")]);
  check("isBinaryContent: 확장자와 무관하게 실제 바이트 내용만으로 판정(확장자 blacklist 아님)", isBinaryContent(extensionLiesBuf) === true);
}

// readFileSmartly()/readUntrackedFiles()가 실제로 binary 파일의 원문을 payload에 절대
// 포함하지 않고 path/size/hash metadata로만 대체하는지 실제 fs 경계(Safe Executor)까지
// 포함해 검증한다.
function scenarioReadUntrackedFilesNeverLeaksRawBinaryContent(): void {
  const fixtureRel = "automation/git-changes-binary-fixture.bin";
  const fixtureAbs = resolve(PROJECT_ROOT, fixtureRel);
  try {
    const binaryContent = Buffer.concat([Buffer.from("PNG-ish header "), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe])]);
    writeFileSync(fixtureAbs, binaryContent);

    const direct = readFileSmartly(fixtureAbs, fixtureRel, "untracked");
    check("readFileSmartly: binary 파일은 binary=true로 판정됨", direct.binary === true);
    check("readFileSmartly: content에 원문 바이트가 그대로 노출되지 않음(원문 문자열이 아님)", !direct.content.includes("PNG-ish header "));
    check("readFileSmartly: content에 sizeBytes metadata 포함", direct.content.includes(`sizeBytes=${binaryContent.length}`));
    check("readFileSmartly: content에 sha256 metadata 포함", typeof direct.sha256 === "string" && direct.content.includes(direct.sha256!));
    check("readFileSmartly: content에 BINARY FILE 표시 포함", direct.content.includes("BINARY FILE"));

    const { files } = readUntrackedFiles([{ path: fixtureRel, status: "untracked" }]);
    const entry = files.find((f) => f.path === fixtureRel);
    check("readUntrackedFiles: binary 파일이 결과에 포함됨", entry !== undefined);
    check("readUntrackedFiles: binary=true로 표시됨", entry?.binary === true);
    check("readUntrackedFiles: content가 metadata 요약이고 원문 바이트를 포함하지 않음", !(entry?.content ?? "").includes("PNG-ish header "));
    check("readUntrackedFiles: truncated=false(metadata는 truncation 대상이 아님)", entry?.truncated === false);
  } finally {
    if (existsSync(fixtureAbs)) unlinkSync(fixtureAbs);
    check("binary fixture 정리 완료", !existsSync(fixtureAbs));
  }
}

// AutoDev Core Maintenance(2026-08-30, Category D — Generated/Cache Artifact Exclusion).
// 실제 JARVIS Task 5.2 사고(Gradle 최초 빌드가 만든 .gradle/build 산출물 수십 개가 원문
// 그대로 Reviewer payload에 흘러들어감, payloadChars=91,718 실측)를 근거로 한 구조적
// 증거 기반 classification — 단순 디렉터리명/확장자 blacklist가 아님을 각 케이스로 증명한다.
function scenarioGeneratedCacheArtifactClassification(): void {
  // 1) 실제 source directory 이름이 "build"인 경우 — 중첩된 빌드 도구 내부 구조 세그먼트가
  // 없으므로 절대 제외돼서는 안 된다(단순 디렉터리명 blacklist가 아님을 증명).
  check(
    "generated/cache 오탐 금지: src/build/README.md(디렉터리 이름만 build)는 제외 대상 아님",
    classifyGeneratedCacheArtifact("src/build/README.md") === false
  );
  check(
    "generated/cache 오탐 금지: web/build/index.tsx(실제 소스 파일)는 제외 대상 아님",
    classifyGeneratedCacheArtifact("web/build/index.tsx") === false
  );

  // 2) 정상 .properties/.lock text — 확장자만으로 제외하지 않는다(yarn.lock/Gemfile.lock류는
  // Reviewer가 반드시 봐야 하는 실제 의존성 변경일 수 있다).
  check(
    "generated/cache 오탐 금지: config/app.properties(일반 설정 파일)는 제외 대상 아님",
    classifyGeneratedCacheArtifact("config/app.properties") === false
  );
  check("generated/cache 오탐 금지: yarn.lock(실제 lockfile)는 제외 대상 아님", classifyGeneratedCacheArtifact("yarn.lock") === false);

  // 3) 실제 Gradle 캐시/빌드 산출물 — (a) 예약된 .gradle 캐시 디렉터리, (b) build/ +
  // 빌드 도구 내부 구조 세그먼트 중첩. 둘 다 실제 JARVIS 사고의 정확한 경로 형태다.
  check(
    "generated/cache 판정: android/wakeword/.gradle/8.7/checksums/checksums.lock 제외 대상",
    classifyGeneratedCacheArtifact("android/wakeword/.gradle/8.7/checksums/checksums.lock") === true
  );
  check(
    "generated/cache 판정: android/wakeword/build/kotlin/compileKotlin/cacheable/caches-jvm/inputs/x.tab 제외 대상",
    classifyGeneratedCacheArtifact("android/wakeword/build/kotlin/compileKotlin/cacheable/caches-jvm/inputs/x.tab") === true
  );
  check(
    "generated/cache 판정: android/wakeword/build/classes/kotlin/main/Foo.class 제외 대상",
    classifyGeneratedCacheArtifact("android/wakeword/build/classes/kotlin/main/Foo.class") === true
  );

  // 4/5) 정상 source-controlled binary(gradle-wrapper.jar) — "gradle/"(점 없음, 실제
  // 커밋되는 wrapper 디렉터리)는 예약 캐시 집합(".gradle", 점 있음)과 다르다 — 구조적
  // classification으로는 제외 대상이 아니고, 대신 기존 binary 판정(isBinaryContent)이
  // 별도로 이 파일을 안전하게 처리한다(§ 아래 통합 테스트).
  check(
    "generated/cache 오탐 금지: gradle/wrapper/gradle-wrapper.jar(실제 커밋되는 wrapper)는 구조적으로 제외 대상 아님",
    classifyGeneratedCacheArtifact("gradle/wrapper/gradle-wrapper.jar") === false
  );
}

// 실제 fs 경계(readFileSmartly/readUntrackedFiles)까지 포함해 generated/cache artifact가
// metadata로 대체되고, oversized artifact도 원본 크기와 무관하게 짧은 metadata만 소비하며,
// 정상 source-controlled binary(gradle-wrapper.jar류)는 generatedCache가 아니라 binary
// 경로로 안전하게 처리됨을 증명한다.
function scenarioReadUntrackedFilesExcludesGeneratedCacheArtifacts(): void {
  const cacheFixtureRel = "automation/.gradle/8.7/checksums/checksums.lock";
  const cacheFixtureAbs = resolve(PROJECT_ROOT, cacheFixtureRel);
  const oversizedFixtureRel = "automation/build/kotlin/compileKotlin/cacheable/caches-jvm/oversized-source-to-output.tab";
  const oversizedFixtureAbs = resolve(PROJECT_ROOT, oversizedFixtureRel);
  const wrapperFixtureRel = "automation/gradle/wrapper/gradle-wrapper.jar";
  const wrapperFixtureAbs = resolve(PROJECT_ROOT, wrapperFixtureRel);
  try {
    mkdirSync(join(cacheFixtureAbs, ".."), { recursive: true });
    writeFileSync(cacheFixtureAbs, "checksum-entry=abc123\nchecksum-entry=def456\n", "utf-8");
    const cacheRead = readFileSmartly(cacheFixtureAbs, cacheFixtureRel, "untracked");
    check("readFileSmartly: 텍스트 형식 캐시 파일도 generatedCache=true로 판정됨", cacheRead.generatedCache === true);
    check("readFileSmartly: 텍스트 캐시 파일이라도 binary=false(정직한 metadata)", cacheRead.binary === false);
    check("readFileSmartly: 캐시 파일 원문(checksum-entry)이 content에 노출되지 않음", !cacheRead.content.includes("checksum-entry"));
    check("readFileSmartly: content에 GENERATED/CACHE ARTIFACT 표시 포함", cacheRead.content.includes("GENERATED/CACHE ARTIFACT"));

    // oversized — 원본이 perFileMaxChars(20,000)보다 훨씬 커도 metadata 크기만 소비해야
    // 한다(§ "oversized generated artifact → Reviewer 호출 전 차단/축약").
    mkdirSync(join(oversizedFixtureAbs, ".."), { recursive: true });
    const oversizedContent = "x".repeat(200_000);
    writeFileSync(oversizedFixtureAbs, oversizedContent, "utf-8");
    const { files: oversizedFiles } = readUntrackedFiles([{ path: oversizedFixtureRel, status: "untracked" }], { perFileMaxChars: 20_000, totalBudgetChars: 65_000 });
    const oversizedEntry = oversizedFiles.find((f) => f.path === oversizedFixtureRel);
    check("oversized generated artifact: 결과에 포함됨", oversizedEntry !== undefined);
    check("oversized generated artifact: generatedCache=true", oversizedEntry?.generatedCache === true);
    check(
      "oversized generated artifact: content가 200,000자 원문이 아니라 짧은 metadata임(예산을 태우지 않음)",
      (oversizedEntry?.content.length ?? 0) < 1_000
    );
    check("oversized generated artifact: truncated=false(metadata는 truncation 대상 아님)", oversizedEntry?.truncated === false);

    // 정상 source-controlled binary(gradle-wrapper.jar) — generatedCache가 아니라 기존
    // binary 경로로 처리돼야 한다(§ 위 classify 단위 테스트와 짝을 이루는 통합 검증).
    mkdirSync(join(wrapperFixtureAbs, ".."), { recursive: true });
    const fakeJarBytes = Buffer.concat([Buffer.from("PK\x03\x04fake-jar-header"), Buffer.from([0x00, 0x01, 0x02])]);
    writeFileSync(wrapperFixtureAbs, fakeJarBytes);
    const wrapperRead = readFileSmartly(wrapperFixtureAbs, wrapperFixtureRel, "untracked");
    check("정상 source-controlled binary(gradle-wrapper.jar): generatedCache=false", wrapperRead.generatedCache !== true);
    check("정상 source-controlled binary(gradle-wrapper.jar): binary=true로 안전하게 metadata 처리됨", wrapperRead.binary === true);
  } finally {
    rmSync(resolve(PROJECT_ROOT, "automation/.gradle"), { recursive: true, force: true });
    rmSync(resolve(PROJECT_ROOT, "automation/build"), { recursive: true, force: true });
    rmSync(resolve(PROJECT_ROOT, "automation/gradle"), { recursive: true, force: true });
    check(
      "generated/cache fixture 정리 완료",
      !existsSync(cacheFixtureAbs) && !existsSync(oversizedFixtureAbs) && !existsSync(wrapperFixtureAbs)
    );
  }
}

// AutoDev Reviewer Snapshot Truncation Fix(2026-08-26, JARVIS Task 1.3) — buildBoundedFileSnapshot()는
// 순수 함수라 git/Safe Executor 없이 직접 검증한다. 실제 사고 재현: 20,235자 test 파일이
// perFileMaxChars=20_000 head-only truncation으로 잘려 Fireworks가 "파일이 물리적으로 손상/
// 미완성"이라고 오판, 5회 연속 REVISE로 WAITING_HUMAN까지 갔다.
function scenarioBoundedFileSnapshotTruncation(): void {
  // Case 1 — 예산 이하 파일은 완전히 그대로, truncated 표시 없음(기존 동작 100% 보존).
  const small = "small file content, well under any budget\n";
  const smallResult = buildBoundedFileSnapshot(small, 20_000);
  check("Case1) cap 이하 파일은 원본과 완전히 동일한 content", smallResult.content === small);
  check("Case1) cap 이하 파일은 truncated=false", smallResult.truncated === false);

  // Case 2 — 실제 사고와 같은 모양: 20,000자 초과 + 파일 맨 끝에 유일한 sentinel(닫는 함수
  // 호출 등을 대표).
  const cap = 20_000;
  const tailSentinel = "run();\nTAIL_SENTINEL_UNIQUE_MARKER\n";
  const headFiller = "x".repeat(cap + 500 - tailSentinel.length);
  const oversized = headFiller + tailSentinel;
  check("Case2) 시나리오 전제 — 합성 파일이 실제로 cap을 초과함", oversized.length > cap);
  const oversizedResult = buildBoundedFileSnapshot(oversized, cap);
  check("Case2) truncated=true", oversizedResult.truncated === true);
  check("Case2) head 내용이 남아있음(앞부분 filler 포함)", oversizedResult.content.startsWith("x"));
  check(
    "Case2) explicit truncation marker 포함(원본 길이/생략 글자 수/tail 보존 여부를 기계가 읽을 수 있는 형태로)",
    /\[AUTODEV REVIEW SNAPSHOT TRUNCATED original_chars=\d+ omitted_chars=\d+ tail_preserved=true\]/.test(oversizedResult.content)
  );
  check(
    "Case2) marker에 기록된 original_chars가 실제 원본 길이와 정확히 일치",
    oversizedResult.content.includes(`original_chars=${oversized.length}`)
  );
  check("Case2) 실제 파일의 물리적 마지막 부분(tail sentinel)이 스냅샷에 그대로 보존됨", oversizedResult.content.includes(tailSentinel.trim()));
  check("Case2) 스냅샷이 tail sentinel로 끝남(marker 뒤에 tail이 옴 — head-only truncation처럼 마커 앞에서 끊기지 않음)", oversizedResult.content.trimEnd().endsWith("TAIL_SENTINEL_UNIQUE_MARKER"));
  check(
    "Case2) 출력이 bounded — cap + marker 같은 작은 고정 오버헤드 안에서만 커짐(임의로 크게 늘어나지 않음)",
    oversizedResult.content.length <= cap + 200
  );

  // Case 3 — 훨씬 더 큰 파일(수십 배)에서도 동일하게 bounded/head/tail/명시적 표시가 유지됨을
  // 증명한다(단순히 "20,000을 30,000으로 늘려서 우연히 통과"하는 게 아님을 확인).
  const hugeTailSentinel = "export default HUGE_FILE_END;\nHUGE_TAIL_SENTINEL\n";
  const huge = "y".repeat(500_000) + hugeTailSentinel;
  const hugeResult = buildBoundedFileSnapshot(huge, cap);
  check("Case3) 훨씬 큰 파일도 truncated=true", hugeResult.truncated === true);
  check("Case3) 훨씬 큰 파일도 출력이 bounded(원본 500KB+ vs 스냅샷은 cap 근처)", hugeResult.content.length <= cap + 200);
  check("Case3) 훨씬 큰 파일도 head가 살아남음", hugeResult.content.startsWith("y"));
  check("Case3) 훨씬 큰 파일도 실제 물리적 tail이 살아남음", hugeResult.content.includes(hugeTailSentinel.trim()));
  check(
    "Case3) 훨씬 큰 파일도 omitted_chars가 truncated 상태를 명시적으로 나타냄(0이 아님)",
    /omitted_chars=([1-9]\d*)/.test(hugeResult.content)
  );

  // Case 4 — AutoDev / JARVIS Unattended Continuous Development Reliability Hardening
  // Phase 7 요구사항 7 — 결정론적(no LLM) 순수 함수이므로 동일 입력에는 항상 동일 출력을
  // 내야 한다(reviewer가 매 round 다른 snapshot을 받아 불필요하게 REVISE를 반복하지 않도록).
  const repeat1 = buildBoundedFileSnapshot(oversized, cap);
  const repeat2 = buildBoundedFileSnapshot(oversized, cap);
  check("Case4) 동일 입력을 두 번 호출해도 완전히 동일한 snapshot을 생성함(결정론적)", repeat1.content === repeat2.content && repeat1.truncated === repeat2.truncated);
}

function main(): void {
  // 순수 함수 시나리오 — git/Safe Executor 불필요, 격리된 root 설정 이전에 바로 실행한다.
  scenarioBoundedFileSnapshotTruncation();
  scenarioBinaryContentDetection();
  scenarioGeneratedCacheArtifactClassification();

  // scenarioReadUntrackedFilesContentAndTruncation()이 readUntrackedFiles()를 통해 실제
  // Safe Executor(validateReadPath)를 호출한다 — configureSafeExecutor()로 명시적으로
  // 주입되기 전까지 어떤 프로젝트로도 조용히 fallback하지 않으므로 먼저 이 파일 전용 격리된
  // root+정책을 주입한다(§ 파일 상단 주석 — Phase B Task B2).
  const isolatedRoot = makeIsolatedTestRoot();
  try {
    configureSafeExecutor(isolatedRoot, TEST_EXECUTION_POLICY);

    scenarioUntrackedFilesDetected();
    scenarioTrackedModifiedDetected();
    scenarioUntrackedFileWithSpaceInNameParsedCorrectly();
    scenarioUntrackedFileWithUnicodeNameParsedCorrectly();
    scenarioStagedRenameWithSpaceParsedCorrectly();
    scenarioSecretAndBuildArtifactsExcluded();
    scenarioTempFixtureFilesExcludedFromReview();
    scenarioReadUntrackedFilesContentAndTruncation();
    scenarioReadUntrackedFilesNeverLeaksRawBinaryContent();
    scenarioReadUntrackedFilesExcludesGeneratedCacheArtifacts();
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
