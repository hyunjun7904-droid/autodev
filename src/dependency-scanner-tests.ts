import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  scanChangesForDependencyRisk,
  parseLockfileJson,
  parseManifestJson,
  checkManifestLockfileConsistency,
  classifyPackageSource,
  checkIntegrity,
  findNewInstallScriptPackages,
} from "./dependency-scanner";
import type { VulnerabilityAuditOutcome } from "./dependency-scanner";
import { performTaskCheckpoint } from "./checkpoint";
import type { TaskDefinition } from "./task-registry";
import type { WorkingTreeChange } from "./git-changes";

// Deterministic Dependency / Supply-chain Scanner Gate 테스트(Phase C Task C5). 실제
// Claude/GPT 유료 API를 호출하지 않고, MOVAN product task도 실행하지 않으며, 실제 production
// dependency 설치/업데이트도 하지 않는다 — 순수 구조 판정(scanChangesForDependencyRisk)과,
// checkpoint-tests.ts/secret-scanner-tests.ts와 동일하게 매 시나리오마다 만드는 OS 임시 git
// repo만 사용한다(실제 이 저장소의 git repo에는 어떤 명령도 실행하지 않는다). vulnerability
// 조회는 전부 fixture 함수(네트워크 없음)로 주입한다 — 실제 npm audit(네트워크)는 호출하지
// 않는다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-dependency-scanner-test-"));
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

function commitAll(repo: string): void {
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "-q", "-m", "fixture commit"], { cwd: repo });
}

function gitLogCount(repo: string): number {
  const res = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" });
  return (res.stdout || "").split("\n").filter(Boolean).length;
}

function fakeTask(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: "99.5",
    phase: 99,
    taskNumber: 5,
    title: "dependency scanner 테스트용 가짜 task",
    prompt: "(테스트 전용)",
    requiredTests: [],
    allowedPathPrefixes: ["package.json", "package-lock.json", "src/"],
    prohibitedOperations: [],
    ...overrides,
  };
}

function change(path: string, status: WorkingTreeChange["status"] = "untracked"): WorkingTreeChange {
  return { path, status };
}

function manifestJson(deps: Record<string, string>, devDeps: Record<string, string> = {}, workspaces: string[] = []): string {
  return (
    JSON.stringify(
      { name: "fixture", version: "0.0.0", dependencies: deps, devDependencies: devDeps, ...(workspaces.length > 0 ? { workspaces } : {}) },
      null,
      2
    ) + "\n"
  );
}

function lockfileJson(
  rootDeps: Record<string, string>,
  rootDevDeps: Record<string, string>,
  packages: Record<string, unknown>,
  lockfileVersion = 3
): string {
  return (
    JSON.stringify(
      {
        name: "fixture",
        lockfileVersion,
        requires: true,
        packages: {
          "": { name: "fixture", version: "0.0.0", dependencies: rootDeps, devDependencies: rootDevDeps },
          ...packages,
        },
      },
      null,
      2
    ) + "\n"
  );
}

const FAKE_SHA512 = "sha512-" + "A".repeat(86) + "==";

function safeRegistryPkg(name: string, version = "1.0.0", extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: FAKE_SHA512,
    license: "MIT",
    ...extra,
  };
}

const emptyAudit = (): VulnerabilityAuditOutcome => ({ ok: true, entries: [] });

function scanFixture(files: Record<string, string>, opts: Parameters<typeof scanChangesForDependencyRisk>[2] = {}) {
  const repo = makeTempGitRepo();
  try {
    const changes: WorkingTreeChange[] = [];
    for (const [rel, content] of Object.entries(files)) {
      writeFile(repo, rel, content);
      changes.push(change(rel));
    }
    return { result: scanChangesForDependencyRisk(changes, repo, opts), repo };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1) 관련 없는 변경은 파일시스템/네트워크 접근 없이 즉시 PASS.
// ---------------------------------------------------------------------------
function scenarioIrrelevantChangesSkipScan(): void {
  const repo = makeTempGitRepo();
  try {
    const result = scanChangesForDependencyRisk([change("src/allowed/a.ts")], repo);
    check("package.json/lockfile 변경이 없으면 즉시 PASS", result.verdict === "PASS");
    check("package.json/lockfile 변경이 없으면 findings 없음", result.findings.length === 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 2) 정상 package.json + lockfile → PASS(과잉 차단 없음).
// ---------------------------------------------------------------------------
function scenarioNormalDependencyPasses(): void {
  const manifest = manifestJson({ dotenv: "^17.4.2" }, { typescript: "^5.7.0" });
  const lock = lockfileJson(
    { dotenv: "^17.4.2" },
    { typescript: "^5.7.0" },
    {
      "node_modules/dotenv": safeRegistryPkg("dotenv", "17.4.2"),
      "node_modules/typescript": safeRegistryPkg("typescript", "5.9.3", { dev: true }),
    }
  );
  const { result } = scanFixture({ "package.json": manifest, "package-lock.json": lock });
  check("정상 dependency: verdict=PASS", result.verdict === "PASS");
  check("정상 dependency: findings 없음(과잉 차단 없음)", result.findings.length === 0);
}

// ---------------------------------------------------------------------------
// 3) manifest/lockfile 불일치 탐지.
// ---------------------------------------------------------------------------
function scenarioManifestLockfileMismatch(): void {
  const manifest = manifestJson({ dotenv: "^17.4.2", "extra-dep": "^1.0.0" });
  const lock = lockfileJson({ dotenv: "^17.4.2" }, {}, { "node_modules/dotenv": safeRegistryPkg("dotenv", "17.4.2") });
  const { result } = scanFixture({ "package.json": manifest, "package-lock.json": lock });
  check("manifest/lockfile 불일치: verdict=BLOCK", result.verdict === "BLOCK");
  check(
    "manifest/lockfile 불일치: manifest-lockfile-mismatch finding 포함",
    result.findings.some((f) => f.kind === "manifest-lockfile-mismatch")
  );
}

// ---------------------------------------------------------------------------
// 4) lockfile 부재(존재 검증).
// ---------------------------------------------------------------------------
function scenarioLockfileMissing(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "package.json", manifestJson({ dotenv: "^17.4.2" }));
    const result = scanChangesForDependencyRisk([change("package.json")], repo);
    check("lockfile 부재: verdict=BLOCK", result.verdict === "BLOCK");
    check("lockfile 부재: lockfile-missing finding 포함", result.findings.some((f) => f.kind === "lockfile-missing"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4-A) 신규 bootstrap package.json이 dependency 없이 scripts/private만 갖는 경우 lockfile 없이 PASS.
// ---------------------------------------------------------------------------
function scenarioNewManifestWithoutDependenciesDoesNotRequireLockfile(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(
      repo,
      "package.json",
      JSON.stringify({ private: true, scripts: { "verify:root": "node scripts/verify-root.cjs" } }, null, 2) + "\n"
    );
    let auditCalls = 0;
    const result = scanChangesForDependencyRisk([change("package.json")], repo, {
      vulnerabilityAuditSource: () => {
        auditCalls += 1;
        return { ok: false, reason: "scripts-only 변경에는 호출되면 안 됨" };
      },
    });
    check("신규 dependency 없는 package.json: lockfile 없이 PASS", result.verdict === "PASS");
    check("신규 dependency 없는 package.json: findings 없음", result.findings.length === 0);
    check("신규 dependency 없는 package.json: npm audit 호출 없음", auditCalls === 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 4-B) 기존 package.json의 dependency 선언이 그대로이고 scripts만 바뀌면 lockfile/audit 재검사 생략.
// ---------------------------------------------------------------------------
function scenarioExistingManifestScriptsOnlyChangeDoesNotRescanDependencies(): void {
  const repo = makeTempGitRepo();
  try {
    const baseline = JSON.stringify({ private: true, scripts: { test: "node old.cjs" } }, null, 2) + "\n";
    writeFile(repo, "package.json", baseline);
    spawnSync("git", ["add", "--", "package.json"], { cwd: repo });
    spawnSync("git", ["commit", "-q", "-m", "baseline package manifest"], { cwd: repo });

    writeFile(repo, "package.json", JSON.stringify({ private: true, scripts: { test: "node new.cjs" } }, null, 2) + "\n");
    let auditCalls = 0;
    const result = scanChangesForDependencyRisk([change("package.json", "modified")], repo, {
      vulnerabilityAuditSource: () => {
        auditCalls += 1;
        return { ok: false, reason: "scripts-only 변경에는 호출되면 안 됨" };
      },
    });
    check("기존 scripts-only package.json 변경: lockfile 없이 PASS", result.verdict === "PASS");
    check("기존 scripts-only package.json 변경: findings 없음", result.findings.length === 0);
    check("기존 scripts-only package.json 변경: npm audit 호출 없음", auditCalls === 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 5) insecure http source 탐지.
// ---------------------------------------------------------------------------
function scenarioInsecureHttpSource(): void {
  const manifest = manifestJson({ "insecure-pkg": "^1.0.0" });
  const lock = lockfileJson(
    { "insecure-pkg": "^1.0.0" },
    {},
    {
      "node_modules/insecure-pkg": {
        version: "1.0.0",
        resolved: "http://registry.npmjs.org/insecure-pkg/-/insecure-pkg-1.0.0.tgz",
        integrity: FAKE_SHA512,
      },
    }
  );
  const { result } = scanFixture({ "package.json": manifest, "package-lock.json": lock });
  check("insecure http source: verdict=BLOCK", result.verdict === "BLOCK");
  check("insecure http source: insecure-source-http finding 포함", result.findings.some((f) => f.kind === "insecure-source-http"));
}

// ---------------------------------------------------------------------------
// 6) git source — 커밋 SHA 고정 여부에 따라 BLOCK/HUMAN_REVIEW 구분.
// ---------------------------------------------------------------------------
function scenarioGitSourceDistinguishesPinning(): void {
  const pinnedSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const manifest = manifestJson({
    "unpinned-git-dep": "git+https://github.com/example/unpinned.git#main",
    "pinned-git-dep": `git+https://github.com/example/pinned.git#${pinnedSha}`,
  });
  const lock = lockfileJson(
    {
      "unpinned-git-dep": "git+https://github.com/example/unpinned.git#main",
      "pinned-git-dep": `git+https://github.com/example/pinned.git#${pinnedSha}`,
    },
    {},
    {
      "node_modules/unpinned-git-dep": { version: "1.0.0", resolved: "git+https://github.com/example/unpinned.git#main" },
      "node_modules/pinned-git-dep": { version: "1.0.0", resolved: `git+https://github.com/example/pinned.git#${pinnedSha}` },
    }
  );
  const { result } = scanFixture({ "package.json": manifest, "package-lock.json": lock });
  check("git source: 고정되지 않은 참조가 있으면 verdict=BLOCK", result.verdict === "BLOCK");
  check(
    "git source: 브랜치 참조(고정되지 않음)는 non-standard-source-git-unpinned",
    result.findings.some((f) => f.kind === "non-standard-source-git-unpinned")
  );
  check(
    "git source: 커밋 SHA로 고정된 참조는 non-standard-source-git-pinned",
    result.findings.some((f) => f.kind === "non-standard-source-git-pinned")
  );

  // 고정된 git 참조만 있는 경우 — BLOCK이 아니라 HUMAN_REVIEW_REQUIRED여야 한다.
  const manifest2 = manifestJson({ "pinned-git-dep": `git+https://github.com/example/pinned.git#${pinnedSha}` });
  const lock2 = lockfileJson(
    { "pinned-git-dep": `git+https://github.com/example/pinned.git#${pinnedSha}` },
    {},
    { "node_modules/pinned-git-dep": { version: "1.0.0", resolved: `git+https://github.com/example/pinned.git#${pinnedSha}` } }
  );
  const { result: result2 } = scanFixture({ "package.json": manifest2, "package-lock.json": lock2 });
  check("git source: 커밋 고정된 것만 있으면 verdict=HUMAN_REVIEW_REQUIRED(BLOCK 아님)", result2.verdict === "HUMAN_REVIEW_REQUIRED");
}

// ---------------------------------------------------------------------------
// 7) file:/workspace link 등 비표준 source — human_review로 구분 처리.
// ---------------------------------------------------------------------------
function scenarioFileAndWorkspaceLinkSources(): void {
  const manifest = manifestJson({ "local-pkg": "file:../local-pkg", "workspace-pkg": "*" });
  const lock = lockfileJson(
    { "local-pkg": "file:../local-pkg", "workspace-pkg": "*" },
    {},
    {
      "node_modules/local-pkg": { version: "1.0.0", resolved: "file:../local-pkg" },
      "node_modules/workspace-pkg": { resolved: "../workspace-pkg", link: true },
    }
  );
  const { result } = scanFixture({ "package.json": manifest, "package-lock.json": lock });
  check("file: source는 non-standard-source-file로 분류", result.findings.some((f) => f.kind === "non-standard-source-file"));
  check(
    "workspace link는 non-standard-source-workspace-link로 분류",
    result.findings.some((f) => f.kind === "non-standard-source-workspace-link")
  );
  check("file:/workspace link만 있으면 verdict=HUMAN_REVIEW_REQUIRED(BLOCK 아님)", result.verdict === "HUMAN_REVIEW_REQUIRED");
}

// ---------------------------------------------------------------------------
// 7-A) 1st-party npm Workspace False-Positive Closure(2026-09-02, Revenue OS Task 1.1 실제
// 운영 incident) — 검증된 1st-party workspace 멤버는 PASS, 그 외 모든 위장/불일치/탈출
// 시도는 여전히 기존과 동일하게 human_review로 남는지 확인한다.
// ---------------------------------------------------------------------------

/** 검증 가능한 최소 1st-party workspace 픽스처를 만든다 — package.json(workspaces 선언) +
 *  실제 디스크 위의 packages/shared-kernel/package.json + 그 둘을 반영한 lockfile 두 entry
 *  (local 자기 자신 + node_modules alias)까지 전부 일관되게 맞춘다. 개별 테스트가 이 중
 *  하나만 의도적으로 깨뜨려(이름 다르게/경로 다르게/파일 누락 등) 각 검증 조건을 개별
 *  확인한다. */
function verifiedWorkspaceFixture(overrides: {
  workspaceGlob?: string;
  localDirKey?: string;
  localDeclaredName?: string;
  onDiskPackageName?: string;
  skipOnDiskFile?: boolean;
  nodeModulesResolved?: string;
  nodeModulesKey?: string;
  extraLockPackages?: Record<string, unknown>;
}): { repo: string; manifest: string; lock: string } {
  const workspaceGlob = overrides.workspaceGlob ?? "packages/*";
  const localDirKey = overrides.localDirKey ?? "packages/shared-kernel";
  const declaredName = overrides.localDeclaredName ?? "@fixture/shared-kernel";
  const onDiskName = overrides.onDiskPackageName ?? declaredName;
  const nodeModulesKey = overrides.nodeModulesKey ?? `node_modules/${declaredName}`;
  const nodeModulesResolved = overrides.nodeModulesResolved ?? localDirKey;

  const manifest = manifestJson({}, { typescript: "^5.7.0" }, [workspaceGlob]);
  const lockPackages: Record<string, unknown> = {
    "node_modules/typescript": safeRegistryPkg("typescript", "5.9.3", { dev: true }),
    [nodeModulesKey]: { resolved: nodeModulesResolved, link: true },
    [localDirKey]: { name: declaredName, version: "0.1.0" },
    ...(overrides.extraLockPackages ?? {}),
  };
  const lock = lockfileJson({}, { typescript: "^5.7.0" }, lockPackages);

  const repo = makeTempGitRepo();
  writeFile(repo, "package.json", manifest);
  writeFile(repo, "package-lock.json", lock);
  if (!overrides.skipOnDiskFile) {
    writeFile(repo, `${localDirKey}/package.json`, JSON.stringify({ name: onDiskName, version: "0.1.0" }, null, 2) + "\n");
  }
  return { repo, manifest, lock };
}

function scenarioFirstPartyWorkspaceVerification(): void {
  // Case 1 — 모든 조건이 일치하는 정상 1st-party workspace: PASS, finding 없음.
  {
    const { repo } = verifiedWorkspaceFixture({});
    try {
      const result = scanChangesForDependencyRisk([change("package.json"), change("package-lock.json")], repo);
      check("검증된 1st-party workspace: verdict=PASS", result.verdict === "PASS");
      check("검증된 1st-party workspace: workspace-link finding 없음", !result.findings.some((f) => f.kind === "non-standard-source-workspace-link"));
      check("검증된 1st-party workspace: integrity-missing finding 없음", !result.findings.some((f) => f.kind === "integrity-missing"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // Case 2 — node_modules alias 이름과 실제 package.json name이 다름(위장 시도) → 여전히 human_review.
  {
    const { repo } = verifiedWorkspaceFixture({ onDiskPackageName: "@fixture/totally-different-name" });
    try {
      const result = scanChangesForDependencyRisk([change("package.json"), change("package-lock.json")], repo);
      check(
        "name 불일치: 여전히 workspace-link finding 유지(위장 차단)",
        result.findings.some((f) => f.kind === "non-standard-source-workspace-link")
      );
      check("name 불일치: verdict=HUMAN_REVIEW_REQUIRED(자동 PASS 아님)", result.verdict === "HUMAN_REVIEW_REQUIRED");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // Case 3 — root manifest.workspaces glob과 실제 디렉터리가 매칭되지 않음 → 여전히 human_review.
  {
    const { repo } = verifiedWorkspaceFixture({ workspaceGlob: "other-dir/*" });
    try {
      const result = scanChangesForDependencyRisk([change("package.json"), change("package-lock.json")], repo);
      check(
        "workspace glob 불일치: 여전히 workspace-link finding 유지",
        result.findings.some((f) => f.kind === "non-standard-source-workspace-link")
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // Case 4 — lockfile은 workspace 멤버를 선언하지만 실제 디스크에 그 package.json이 없음
  // (선언과 실물 불일치) → 확인할 수 없으므로 fail-closed, 여전히 human_review.
  {
    const { repo } = verifiedWorkspaceFixture({ skipOnDiskFile: true });
    try {
      const result = scanChangesForDependencyRisk([change("package.json"), change("package-lock.json")], repo);
      check(
        "실제 파일 없음: 확인 불가로 fail-closed, workspace-link finding 유지",
        result.findings.some((f) => f.kind === "non-standard-source-workspace-link")
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // Case 5 — resolved가 ".."로 repo 밖을 가리키려는 path traversal 시도 → 여전히 human_review
  // (경로 형태 검사만으로 즉시 거부 — 파일시스템 접근조차 하지 않음).
  {
    const { repo } = verifiedWorkspaceFixture({
      localDirKey: "packages/shared-kernel",
      nodeModulesResolved: "../../outside-repo",
      extraLockPackages: { "../../outside-repo": { name: "@fixture/shared-kernel", version: "0.1.0" } },
    });
    try {
      const result = scanChangesForDependencyRisk([change("package.json"), change("package-lock.json")], repo);
      check(
        "path traversal(resolved=\"../../outside-repo\"): 여전히 workspace-link finding 유지",
        result.findings.some((f) => f.kind === "non-standard-source-workspace-link")
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // Case 6 — node_modules alias가 resolved로 가리키는 local entry 자체가 lockfile에 없음
  // (dangling reference) → 여전히 human_review.
  {
    const repo = makeTempGitRepo();
    try {
      const manifest = manifestJson({}, {}, ["packages/*"]);
      const lock = lockfileJson({}, {}, {
        "node_modules/@fixture/shared-kernel": { resolved: "packages/shared-kernel", link: true },
      });
      writeFile(repo, "package.json", manifest);
      writeFile(repo, "package-lock.json", lock);
      writeFile(repo, "packages/shared-kernel/package.json", JSON.stringify({ name: "@fixture/shared-kernel", version: "0.1.0" }) + "\n");
      const result = scanChangesForDependencyRisk([change("package.json"), change("package-lock.json")], repo);
      check(
        "dangling local entry(lockfile에 local entry 자체가 없음): 여전히 workspace-link finding 유지",
        result.findings.some((f) => f.kind === "non-standard-source-workspace-link")
      );
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  // Case 7 — 검증된 workspace 멤버와 정말 위험한 외부 dependency(git 미고정 참조)가 같은
  // lockfile에 공존 — workspace는 PASS로 스킵되지만 git finding은 그대로 살아남아야 한다
  // (이 검증이 "관련 없는 다른 finding까지 함께 삼키지" 않는지 확인).
  {
    const { repo } = verifiedWorkspaceFixture({
      extraLockPackages: {
        "node_modules/risky-git-dep": { resolved: "git+https://github.com/example/risky#main" },
      },
    });
    try {
      const result = scanChangesForDependencyRisk([change("package.json"), change("package-lock.json")], repo);
      check(
        "workspace는 PASS로 스킵되지만, 공존하는 git 미고정 참조 finding은 그대로 유지됨",
        result.findings.some((f) => f.kind === "non-standard-source-git-unpinned")
      );
      check("workspace-link finding은 여전히 없음(검증된 workspace는 계속 스킵됨)", !result.findings.some((f) => f.kind === "non-standard-source-workspace-link"));
      check("git 미고정 참조가 있으므로 verdict=BLOCK", result.verdict === "BLOCK");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 8) 신뢰된 registry 밖의 tarball URL — 비표준 source로 사람 확인.
// ---------------------------------------------------------------------------
function scenarioNonStandardTarballHost(): void {
  const manifest = manifestJson({ "custom-tarball": "https://example.com/custom-tarball-1.0.0.tgz" });
  const lock = lockfileJson(
    { "custom-tarball": "https://example.com/custom-tarball-1.0.0.tgz" },
    {},
    {
      "node_modules/custom-tarball": {
        version: "1.0.0",
        resolved: "https://example.com/custom-tarball-1.0.0.tgz",
        integrity: FAKE_SHA512,
      },
    }
  );
  const { result } = scanFixture({ "package.json": manifest, "package-lock.json": lock });
  check(
    "비표준 registry host: non-standard-source-url-tarball 포함",
    result.findings.some((f) => f.kind === "non-standard-source-url-tarball")
  );
  check("비표준 registry host만 있으면 verdict=HUMAN_REVIEW_REQUIRED", result.verdict === "HUMAN_REVIEW_REQUIRED");
}

// ---------------------------------------------------------------------------
// 9) integrity 이상(누락/형식오류) 탐지.
// ---------------------------------------------------------------------------
function scenarioIntegrityIssues(): void {
  const manifest = manifestJson({ "no-integrity-pkg": "^1.0.0", "bad-integrity-pkg": "^1.0.0" });
  const lock = lockfileJson(
    { "no-integrity-pkg": "^1.0.0", "bad-integrity-pkg": "^1.0.0" },
    {},
    {
      "node_modules/no-integrity-pkg": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/no-integrity-pkg/-/no-integrity-pkg-1.0.0.tgz",
      },
      "node_modules/bad-integrity-pkg": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/bad-integrity-pkg/-/bad-integrity-pkg-1.0.0.tgz",
        integrity: "not-a-valid-hash",
      },
    }
  );
  const { result } = scanFixture({ "package.json": manifest, "package-lock.json": lock });
  check("integrity 누락: verdict=BLOCK", result.verdict === "BLOCK");
  check("integrity 누락: integrity-missing finding 포함", result.findings.some((f) => f.kind === "integrity-missing"));
  check("integrity 형식오류: integrity-malformed finding 포함", result.findings.some((f) => f.kind === "integrity-malformed"));
}

// ---------------------------------------------------------------------------
// 10) 신규 install-script 의존성만 flag(기존 install-script 의존성은 과잉 차단하지 않음).
// ---------------------------------------------------------------------------
function scenarioInstallScriptNewDependencyFlagged(): void {
  const repo = makeTempGitRepo();
  try {
    const baseManifest = manifestJson({ "existing-install-script-pkg": "^1.0.0" });
    const baseLock = lockfileJson(
      { "existing-install-script-pkg": "^1.0.0" },
      {},
      {
        "node_modules/existing-install-script-pkg": safeRegistryPkg("existing-install-script-pkg", "1.0.0", {
          hasInstallScript: true,
        }),
      }
    );
    writeFile(repo, "package.json", baseManifest);
    writeFile(repo, "package-lock.json", baseLock);
    commitAll(repo);

    const newManifest = manifestJson({
      "existing-install-script-pkg": "^1.0.0",
      "new-install-script-pkg": "^1.0.0",
    });
    const newLock = lockfileJson(
      { "existing-install-script-pkg": "^1.0.0", "new-install-script-pkg": "^1.0.0" },
      {},
      {
        "node_modules/existing-install-script-pkg": safeRegistryPkg("existing-install-script-pkg", "1.0.0", {
          hasInstallScript: true,
        }),
        "node_modules/new-install-script-pkg": safeRegistryPkg("new-install-script-pkg", "1.0.0", { hasInstallScript: true }),
      }
    );
    writeFile(repo, "package.json", newManifest);
    writeFile(repo, "package-lock.json", newLock);

    const result = scanChangesForDependencyRisk(
      [change("package.json", "modified"), change("package-lock.json", "modified")],
      repo
    );
    check(
      "install-script: 새로 추가된 패키지만 install-script-new-dependency로 flag됨",
      result.findings.some((f) => f.kind === "install-script-new-dependency" && f.packageName === "node_modules/new-install-script-pkg")
    );
    check(
      "install-script: 기존(HEAD에도 있던) install-script 패키지는 다시 flag하지 않음(과잉 차단 없음)",
      !result.findings.some(
        (f) => f.kind === "install-script-new-dependency" && f.packageName === "node_modules/existing-install-script-pkg"
      )
    );
    check("install-script만 새로 생기면 verdict=HUMAN_REVIEW_REQUIRED(BLOCK 아님)", result.verdict === "HUMAN_REVIEW_REQUIRED");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 11) vulnerability fixture — Critical/High는 BLOCK, moderate/low는 과잉 차단하지 않음.
// ---------------------------------------------------------------------------
function scenarioVulnerabilityFixtureBlocksCriticalHigh(): void {
  const manifest = manifestJson({ "vulnerable-pkg": "^1.0.0" });
  const lock = lockfileJson(
    { "vulnerable-pkg": "^1.0.0" },
    {},
    { "node_modules/vulnerable-pkg": safeRegistryPkg("vulnerable-pkg", "1.0.0") }
  );
  const { result } = scanFixture(
    { "package.json": manifest, "package-lock.json": lock },
    { vulnerabilityAuditSource: () => ({ ok: true, entries: [{ name: "vulnerable-pkg", severity: "critical" }] }) }
  );
  check("vulnerability fixture(critical): verdict=BLOCK", result.verdict === "BLOCK");
  check("vulnerability fixture(critical): vulnerability-critical finding 포함", result.findings.some((f) => f.kind === "vulnerability-critical"));

  const { result: highResult } = scanFixture(
    { "package.json": manifest, "package-lock.json": lock },
    { vulnerabilityAuditSource: () => ({ ok: true, entries: [{ name: "vulnerable-pkg", severity: "high" }] }) }
  );
  check("vulnerability fixture(high): verdict=BLOCK", highResult.verdict === "BLOCK");

  const { result: lowResult } = scanFixture(
    { "package.json": manifest, "package-lock.json": lock },
    { vulnerabilityAuditSource: () => ({ ok: true, entries: [{ name: "vulnerable-pkg", severity: "low" }] }) }
  );
  check("vulnerability fixture(low): 과잉 차단 없음(verdict=PASS)", lowResult.verdict === "PASS");
  check(
    "vulnerability fixture(low): finding은 남기되 severity=info",
    lowResult.findings.some((f) => f.kind === "vulnerability-low" && f.severity === "info")
  );
}

// ---------------------------------------------------------------------------
// 12) vulnerability audit 실패(네트워크 오류/timeout)를 조용히 PASS로 처리하지 않음.
// ---------------------------------------------------------------------------
function scenarioVulnerabilityAuditFailureNotSilentPass(): void {
  const manifest = manifestJson({ "some-pkg": "^1.0.0" });
  const lock = lockfileJson({ "some-pkg": "^1.0.0" }, {}, { "node_modules/some-pkg": safeRegistryPkg("some-pkg", "1.0.0") });
  const { result } = scanFixture(
    { "package.json": manifest, "package-lock.json": lock },
    { vulnerabilityAuditSource: () => ({ ok: false, reason: "네트워크 timeout(테스트 fixture)" }) }
  );
  check("vulnerability audit 실패: verdict=HUMAN_REVIEW_REQUIRED(PASS 아님)", result.verdict === "HUMAN_REVIEW_REQUIRED");
  check(
    "vulnerability audit 실패: vulnerability-audit-unavailable finding 포함",
    result.findings.some((f) => f.kind === "vulnerability-audit-unavailable")
  );
}

// ---------------------------------------------------------------------------
// 13) scanner 자체 오류(파싱 실패/미지원 형식)를 조용히 PASS로 처리하지 않음.
// ---------------------------------------------------------------------------
function scenarioScannerErrorsNotSilentPass(): void {
  const { result: badLockJson } = scanFixture({
    "package.json": manifestJson({ a: "^1.0.0" }),
    "package-lock.json": "{ this is not valid json",
  });
  check("lockfile JSON 파싱 실패: verdict=BLOCK(PASS 아님)", badLockJson.verdict === "BLOCK");
  check("lockfile JSON 파싱 실패: lockfile-parse-error finding 포함", badLockJson.findings.some((f) => f.kind === "lockfile-parse-error"));

  const { result: unsupportedVersion } = scanFixture({
    "package.json": manifestJson({ a: "^1.0.0" }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 1, dependencies: {} }),
  });
  check(
    "미지원 lockfileVersion(1): verdict=BLOCK(판단불가를 PASS로 처리하지 않음)",
    unsupportedVersion.verdict === "BLOCK"
  );

  const { result: badManifestJson } = scanFixture({
    "package.json": "{ not valid json",
    "package-lock.json": lockfileJson({}, {}, {}),
  });
  check("manifest JSON 파싱 실패: verdict=BLOCK(PASS 아님)", badManifestJson.verdict === "BLOCK");
  check(
    "manifest JSON 파싱 실패: manifest-parse-error finding 포함",
    badManifestJson.findings.some((f) => f.kind === "manifest-parse-error")
  );
}

// ---------------------------------------------------------------------------
// 14) 순수 판정 함수 단위 테스트(파일시스템 없이).
// ---------------------------------------------------------------------------
function scenarioPureFunctionUnitChecks(): void {
  check(
    "parseLockfileJson: 정상 lockfileVersion 3 파싱 성공",
    parseLockfileJson(lockfileJson({}, {}, {})).ok === true
  );
  check("parseManifestJson: 정상 manifest 파싱 성공", parseManifestJson(manifestJson({ a: "^1.0.0" })).ok === true);
  check(
    "checkManifestLockfileConsistency: 일치하면 findings 없음",
    checkManifestLockfileConsistency(
      { dependencies: { a: "^1.0.0" }, devDependencies: {}, workspaces: [] },
      { lockfileVersion: 3, packages: { "": { dependencies: { a: "^1.0.0" }, devDependencies: {} } } }
    ).length === 0
  );
  check(
    "classifyPackageSource: 표준 registry https 소스는 null(문제없음)",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    classifyPackageSource("node_modules/a", safeRegistryPkg("a") as any) === null
  );
  check(
    "checkIntegrity: link 엔트리는 검사 대상 아님(null)",
    checkIntegrity("node_modules/a", { link: true }) === null
  );
  check(
    "findNewInstallScriptPackages: oldLock이 null이면 전부 신규로 취급",
    findNewInstallScriptPackages(null, {
      lockfileVersion: 3,
      packages: { "node_modules/a": { hasInstallScript: true } },
    }).includes("node_modules/a")
  );
}

// ---------------------------------------------------------------------------
// 15) checkpoint 통합 — 위험 dependency 발견 시 실제 commit 차단.
// ---------------------------------------------------------------------------
function scenarioCheckpointBlocksOnInsecureDependency(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "package.json", manifestJson({ "insecure-pkg": "^1.0.0" }));
    writeFile(
      repo,
      "package-lock.json",
      lockfileJson(
        { "insecure-pkg": "^1.0.0" },
        {},
        {
          "node_modules/insecure-pkg": {
            version: "1.0.0",
            resolved: "http://registry.npmjs.org/insecure-pkg/-/insecure-pkg-1.0.0.tgz",
            integrity: FAKE_SHA512,
          },
        }
      )
    );
    const before = gitLogCount(repo);
    const outcome = performTaskCheckpoint(fakeTask(), {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
      dependencyVulnerabilityAuditSource: emptyAudit,
    });
    check("checkpoint: insecure dependency 발견 시 ok=false(BLOCK)", outcome.ok === false);
    check("checkpoint: dependencyScanVerdict=BLOCK", outcome.dependencyScanVerdict === "BLOCK");
    check(
      "checkpoint: dependencyFindings에 insecure-source-http 포함",
      (outcome.dependencyFindings ?? []).some((f) => f.kind === "insecure-source-http")
    );
    check("checkpoint: 실제 git commit이 생성되지 않음", gitLogCount(repo) === before);

    const statusAfter = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf-8" });
    check(
      "checkpoint: insecure dependency 발견 시 파일들이 미staged 상태로 남음(git add조차 실행되지 않음)",
      (statusAfter.stdout || "").split("\n").every((l) => l === "" || l.startsWith("??"))
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioCheckpointBlocksOnCriticalVulnerability(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "package.json", manifestJson({ "vulnerable-pkg": "^1.0.0" }));
    writeFile(
      repo,
      "package-lock.json",
      lockfileJson({ "vulnerable-pkg": "^1.0.0" }, {}, { "node_modules/vulnerable-pkg": safeRegistryPkg("vulnerable-pkg", "1.0.0") })
    );
    const before = gitLogCount(repo);
    const outcome = performTaskCheckpoint(fakeTask(), {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
      dependencyVulnerabilityAuditSource: () => ({ ok: true, entries: [{ name: "vulnerable-pkg", severity: "critical" }] }),
    });
    check("checkpoint: Critical 취약점 발견 시 ok=false(BLOCK)", outcome.ok === false);
    check("checkpoint: Critical 취약점 발견 시 commit이 생성되지 않음", gitLogCount(repo) === before);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioCheckpointPassesCleanDependencyChange(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "package.json", manifestJson({ dotenv: "^17.4.2" }));
    writeFile(repo, "package-lock.json", lockfileJson({ dotenv: "^17.4.2" }, {}, { "node_modules/dotenv": safeRegistryPkg("dotenv", "17.4.2") }));
    const before = gitLogCount(repo);
    const outcome = performTaskCheckpoint(fakeTask(), {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
      dependencyVulnerabilityAuditSource: emptyAudit,
    });
    check("checkpoint: 정상 dependency 변경은 ok=true", outcome.ok === true);
    check("checkpoint: 정상 dependency 변경은 실제 commit 생성됨", gitLogCount(repo) === before + 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioCheckpointUnrelatedChangeNotAffected(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "src/allowed.ts", "export const a = 1;\n");
    const before = gitLogCount(repo);
    const outcome = performTaskCheckpoint(fakeTask(), {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
      // vulnerabilityAuditSource를 일부러 넘기지 않는다 — package.json/lockfile 변경이
      // 전혀 없으므로 scanChangesForDependencyRisk가 opts를 전혀 건드리지 않고(네트워크
      // 접근 없이) 즉시 PASS해야 한다(기본값 npmAuditVulnerabilitySource가 호출되면 이
      // 테스트가 네트워크에 의존하게 되므로, 호출되지 않음을 이 시나리오 자체로 증명한다).
    });
    check("checkpoint: dependency 변경이 없는 일반 task는 ok=true", outcome.ok === true);
    check("checkpoint: dependency 변경이 없는 일반 task는 commit 생성됨", gitLogCount(repo) === before + 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 15-A) 실제 Canary 회귀: dependency 없는 신규 root package.json + scripts 변경은 checkpoint 가능.
// ---------------------------------------------------------------------------
function scenarioCheckpointAllowsNewScriptsOnlyManifestWithoutLockfile(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(
      repo,
      "package.json",
      JSON.stringify({ private: true, scripts: { "verify:root": "node scripts/verify-root.cjs" } }, null, 2) + "\n"
    );
    writeFile(repo, "scripts/verify-root.cjs", "process.exit(0);\n");
    const before = gitLogCount(repo);
    let auditCalls = 0;
    const outcome = performTaskCheckpoint(
      fakeTask({ allowedPathPrefixes: ["package.json", "scripts/"] }),
      {
        decision: "PASS",
        severity: { critical: 0, high: 0, medium: 0 },
        requiredTestsAllPassed: true,
        cwd: repo,
        dependencyVulnerabilityAuditSource: () => {
          auditCalls += 1;
          return { ok: false, reason: "dependency 없는 신규 manifest에서는 호출되면 안 됨" };
        },
      }
    );
    check("checkpoint canary regression: 신규 dependency 없는 root package.json은 ok=true", outcome.ok === true);
    check("checkpoint canary regression: product commit 1건 생성", gitLogCount(repo) === before + 1);
    check("checkpoint canary regression: npm audit 호출 없음", auditCalls === 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 16) Project Policy로 Core gate 우회 불가.
// ---------------------------------------------------------------------------
function scenarioProjectPolicyCannotBypassDependencyScanner(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "package.json", manifestJson({ "insecure-pkg": "^1.0.0" }));
    writeFile(
      repo,
      "package-lock.json",
      lockfileJson(
        { "insecure-pkg": "^1.0.0" },
        {},
        {
          "node_modules/insecure-pkg": {
            version: "1.0.0",
            resolved: "http://registry.npmjs.org/insecure-pkg/-/insecure-pkg-1.0.0.tgz",
            integrity: FAKE_SHA512,
          },
        }
      )
    );
    const before = gitLogCount(repo);
    // performTaskCheckpoint의 옵션 타입(PerformCheckpointOptions)에는 dependency scanner를
    // 끄거나 약화시킬 필드가 존재하지 않는다 — 그런 필드를 흉내내 억지로 끼워 넣어도(as any)
    // 런타임이 그 필드를 전혀 읽지 않으므로 여전히 BLOCK되어야 한다.
    const bypassAttempt = {
      decision: "PASS" as const,
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
      dependencyVulnerabilityAuditSource: emptyAudit,
      disableDependencyScanner: true,
      skipDependencyScan: true,
      projectPolicy: { allowInsecureDependencies: true },
    };
    const outcome = performTaskCheckpoint(fakeTask(), bypassAttempt as unknown as Parameters<typeof performTaskCheckpoint>[1]);
    check("가짜 '우회' 필드를 넣어도 checkpoint는 여전히 BLOCK", outcome.ok === false);
    check("가짜 '우회' 필드를 넣어도 commit이 생성되지 않음", gitLogCount(repo) === before);
    check("가짜 '우회' 필드를 넣어도 dependencyFindings가 비어있지 않음", (outcome.dependencyFindings ?? []).length > 0);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function main(): void {
  scenarioIrrelevantChangesSkipScan();
  scenarioNormalDependencyPasses();
  scenarioManifestLockfileMismatch();
  scenarioLockfileMissing();
  scenarioNewManifestWithoutDependenciesDoesNotRequireLockfile();
  scenarioExistingManifestScriptsOnlyChangeDoesNotRescanDependencies();
  scenarioInsecureHttpSource();
  scenarioGitSourceDistinguishesPinning();
  scenarioFileAndWorkspaceLinkSources();
  scenarioFirstPartyWorkspaceVerification();
  scenarioNonStandardTarballHost();
  scenarioIntegrityIssues();
  scenarioInstallScriptNewDependencyFlagged();
  scenarioVulnerabilityFixtureBlocksCriticalHigh();
  scenarioVulnerabilityAuditFailureNotSilentPass();
  scenarioScannerErrorsNotSilentPass();
  scenarioPureFunctionUnitChecks();
  scenarioCheckpointBlocksOnInsecureDependency();
  scenarioCheckpointBlocksOnCriticalVulnerability();
  scenarioCheckpointPassesCleanDependencyChange();
  scenarioCheckpointUnrelatedChangeNotAffected();
  scenarioCheckpointAllowsNewScriptsOnlyManifestWithoutLockfile();
  scenarioProjectPolicyCannotBypassDependencyScanner();

  console.log("\n=== dependency-scanner 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
