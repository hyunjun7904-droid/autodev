import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync, spawn } from "node:child_process";
import { bootstrapProject, isRealPathWithin, debugComputeBootstrapLockFilePath } from "./project-bootstrap";
import type { BootstrapTrustedConfig, BootstrapOutcome } from "./project-bootstrap";
import { AUTODEV_ROOT } from "./project-context";

// Safe Project Bootstrap 테스트(SI-2). 이 파일은 실제 사용자 프로젝트를 만들지 않는다 —
// 모든 시나리오는 OS 임시 디렉터리(mkdtempSync) 안의 disposable fixture만 사용하고,
// main() 마지막에 전부 rmSync로 정리한다. AutoDev Core 저장소(automation/ 자체) 안에는
// 어떤 파일/디렉터리도 만들지 않는다(§ 요구사항 10/18 — side effect 없음).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}
function skip(label: string): void {
  results.push(`[SKIP] ${label}`);
}

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

const COMMIT_IDENTITY = { name: "AutoDev SI-2 Test", email: "si2-test@example.invalid" };

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

interface EnvelopeOverrides {
  handoffId?: string;
  projectId?: string;
  specVersion?: string;
  specIntegrity?: { algorithm: "sha256" | "sha512"; hash: string };
  specContentRef?: string;
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** inline specContent를 쓰는 유효한 HandoffEnvelope를 만든다. */
function makeInlineEnvelope(overrides: EnvelopeOverrides = {}, content = "이것은 SI-2 테스트용 Master Spec 본문입니다. secret이 아닙니다."): unknown {
  const hash = overrides.specIntegrity ? overrides.specIntegrity.hash : sha256Hex(content);
  return {
    handoffId: overrides.handoffId ?? nextId("handoff-si2"),
    spec: {
      projectId: overrides.projectId ?? nextId("si2-proj").replace(/[^A-Za-z0-9_-]/g, "-"),
      projectName: "SI-2 Fixture Project",
      specVersion: overrides.specVersion ?? "1.0.0",
      specStatus: "APPROVED",
      userApproval: "PASS",
      reviewerGate: { critical: 0, high: 0 },
      unresolvedCriticalCount: 0,
      contradictionCount: 0,
      specIntegrity: overrides.specIntegrity ?? { algorithm: "sha256", hash },
      specContent: content,
    },
  };
}

/** specContentRef를 쓰는 유효한 HandoffEnvelope를 만든다 — ref/hash는 호출부가 지정한다. */
function makeRefEnvelope(overrides: EnvelopeOverrides & { specContentRef: string }): unknown {
  return {
    handoffId: overrides.handoffId ?? nextId("handoff-si2"),
    spec: {
      projectId: overrides.projectId ?? nextId("si2-proj").replace(/[^A-Za-z0-9_-]/g, "-"),
      projectName: "SI-2 Fixture Project (ref)",
      specVersion: overrides.specVersion ?? "1.0.0",
      specStatus: "APPROVED",
      userApproval: "PASS",
      reviewerGate: { critical: 0, high: 0 },
      unresolvedCriticalCount: 0,
      contradictionCount: 0,
      specIntegrity: overrides.specIntegrity ?? { algorithm: "sha256", hash: "0".repeat(64) },
      specContentRef: overrides.specContentRef,
    },
  };
}

function run(envelope: unknown, config: BootstrapTrustedConfig): BootstrapOutcome {
  return bootstrapProject(JSON.stringify(envelope), config);
}

function listDirNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function gitLogCount(repoDir: string): number {
  const res = spawnSync("git", ["rev-list", "--count", "HEAD"], { cwd: repoDir, encoding: "utf-8" });
  if (res.status !== 0) return 0;
  return parseInt((res.stdout || "0").trim(), 10) || 0;
}

// ---------------------------------------------------------------------------
// 1) valid inline APPROVED Spec → disposable project bootstrap 성공
// ---------------------------------------------------------------------------
function scenarioValidInlineBootstrapSucceeds(): void {
  const baseDir = makeTempDir("si2-base-inline-");
  const content = "Inline Master Spec 본문 — SI-2 시나리오 1";
  const envelope = makeInlineEnvelope({}, content) as { handoffId: string; spec: { projectId: string } };
  const config: BootstrapTrustedConfig = { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY };

  const outcome = run(envelope, config);
  check("1) 유효한 inline APPROVED spec → COMPLETE", outcome.status === "COMPLETE");
  if (outcome.status !== "COMPLETE") return;

  check("1) projectRoot가 실제로 생성됨", existsSync(outcome.projectRoot));
  check("1) master-spec/spec.md 내용이 원문과 일치", readFileSync(outcome.masterSpecPath, "utf-8") === content);
  check("1) bootstrap-state.json stage=COMPLETED", JSON.parse(readFileSync(outcome.bootstrapStatePath, "utf-8")).stage === "COMPLETED");
  check("1) baselineCommitHash가 40자 hex", /^[0-9a-f]{40}$/.test(outcome.baselineCommitHash));
  check("1) git log에 commit 1건 존재", gitLogCount(outcome.projectRoot) === 1);
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: outcome.projectRoot, encoding: "utf-8" });
  const trackedDirty = (status.stdout || "").split("\n").filter((l) => l.trim() && !l.includes("bootstrap-state.json"));
  check("1) baseline commit 이후 tracked 파일 기준 working tree가 깨끗함", trackedDirty.length === 0);
}

// ---------------------------------------------------------------------------
// 2) SI-1 REJECT → project root 생성 0건
// ---------------------------------------------------------------------------
function scenarioRejectCreatesNothing(): void {
  const baseDir = makeTempDir("si2-base-reject-");
  const before = listDirNames(baseDir);
  const envelope = makeInlineEnvelope() as { spec: Record<string, unknown> };
  (envelope.spec as Record<string, unknown>).specStatus = "DRAFT"; // SI-1이 REJECT하는 값
  const config: BootstrapTrustedConfig = { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY };

  const outcome = run(envelope, config);
  check("2) DRAFT spec → REJECTED", outcome.status === "REJECTED");
  const after = listDirNames(baseDir);
  check("2) REJECT 이후 baseDir 안에 새 항목이 생기지 않음", JSON.stringify(before) === JSON.stringify(after));
}

// ---------------------------------------------------------------------------
// 3) valid specContentRef → 실제 파일 read → realpath/containment → hash → secret scan → 성공
// ---------------------------------------------------------------------------
function scenarioValidContentRefBootstrapSucceeds(): void {
  const sourceRoot = makeTempDir("si2-src-valid-");
  mkdirSync(join(sourceRoot, "specs"), { recursive: true });
  const content = "specContentRef를 통한 유효한 Master Spec 본문(SI-2 시나리오 3)";
  writeFileSync(join(sourceRoot, "specs", "master.md"), content, "utf-8");
  const hash = sha256Hex(content);

  const baseDir = makeTempDir("si2-base-valid-ref-");
  const envelope = makeRefEnvelope({ specContentRef: "specs/master.md", specIntegrity: { algorithm: "sha256", hash } });
  const config: BootstrapTrustedConfig = { bootstrapBaseDir: baseDir, specContentRefSourceRoot: sourceRoot, commitIdentity: COMMIT_IDENTITY };

  const outcome = run(envelope, config);
  check("3) 유효한 specContentRef → COMPLETE", outcome.status === "COMPLETE");
  if (outcome.status === "COMPLETE") {
    check("3) 보존된 spec.md 내용이 참조 파일 원문과 일치", readFileSync(outcome.masterSpecPath, "utf-8") === content);
  }
}

// ---------------------------------------------------------------------------
// 4) specContentRef hash mismatch → BLOCK, project 생성 금지
// ---------------------------------------------------------------------------
function scenarioContentRefHashMismatchBlocked(): void {
  const sourceRoot = makeTempDir("si2-src-mismatch-");
  mkdirSync(join(sourceRoot, "specs"), { recursive: true });
  const content = "실제 파일 내용";
  writeFileSync(join(sourceRoot, "specs", "master.md"), content, "utf-8");

  const baseDir = makeTempDir("si2-base-mismatch-");
  const projectId = nextId("si2-mismatch");
  const envelope = makeRefEnvelope({
    projectId,
    specContentRef: "specs/master.md",
    specIntegrity: { algorithm: "sha256", hash: "f".repeat(64) },
  });
  const config: BootstrapTrustedConfig = { bootstrapBaseDir: baseDir, specContentRefSourceRoot: sourceRoot, commitIdentity: COMMIT_IDENTITY };

  const outcome = run(envelope, config);
  check("4) hash mismatch → BLOCKED(SPEC_CONTENT_REF_HASH_MISMATCH)", outcome.status === "BLOCKED" && outcome.code === "SPEC_CONTENT_REF_HASH_MISMATCH");
  check("4) project 폴더가 생성되지 않음", !existsSync(join(baseDir, projectId)));
}

// ---------------------------------------------------------------------------
// 5) specContentRef symlink escape → BLOCK (파일 symlink — 권한 없으면 SKIP)
// ---------------------------------------------------------------------------
function scenarioContentRefSymlinkEscapeBlocked(): void {
  const sourceRoot = makeTempDir("si2-src-symlink-");
  const outsideDir = makeTempDir("si2-outside-symlink-");
  const outsideContent = "OUTSIDE ROOT — 이 내용이 읽히면 안 된다";
  const outsideFile = join(outsideDir, "secret.md");
  writeFileSync(outsideFile, outsideContent, "utf-8");

  mkdirSync(join(sourceRoot, "specs"), { recursive: true });
  const linkPath = join(sourceRoot, "specs", "master.md");
  let created = false;
  try {
    symlinkSync(outsideFile, linkPath, "file");
    created = true;
  } catch {
    // Windows에서 파일 symlink 생성은 관리자 권한/개발자 모드가 필요할 수 있다.
  }
  if (!created) {
    skip("5) specContentRef 파일 symlink escape — 이 환경에서 파일 symlink 생성 권한이 없어 건너뜀(junction 기반 escape는 시나리오 6에서 검증)");
    return;
  }

  const baseDir = makeTempDir("si2-base-symlink-");
  const projectId = nextId("si2-symlink");
  const envelope = makeRefEnvelope({
    projectId,
    specContentRef: "specs/master.md",
    specIntegrity: { algorithm: "sha256", hash: sha256Hex(outsideContent) },
  });
  const config: BootstrapTrustedConfig = { bootstrapBaseDir: baseDir, specContentRefSourceRoot: sourceRoot, commitIdentity: COMMIT_IDENTITY };

  const outcome = run(envelope, config);
  check("5) symlink escape → BLOCKED(SPEC_CONTENT_REF_ESCAPE)", outcome.status === "BLOCKED" && outcome.code === "SPEC_CONTENT_REF_ESCAPE");
  check("5) project 폴더가 생성되지 않음", !existsSync(join(baseDir, projectId)));
}

// ---------------------------------------------------------------------------
// 6) specContentRef junction/reparse point escape → 가능한 범위에서 검증
// ---------------------------------------------------------------------------
function scenarioContentRefJunctionEscapeBlocked(): void {
  const sourceRoot = makeTempDir("si2-src-junction-");
  const outsideDir = makeTempDir("si2-outside-junction-");
  const outsideContent = "OUTSIDE ROOT VIA JUNCTION — 이 내용이 읽히면 안 된다";
  writeFileSync(join(outsideDir, "inside.md"), outsideContent, "utf-8");

  const linkDir = join(sourceRoot, "linkdir");
  let created = false;
  try {
    symlinkSync(outsideDir, linkDir, "junction");
    created = true;
  } catch {
    // 이 Node/OS 조합에서 junction 생성이 지원되지 않을 수 있다.
  }
  if (!created) {
    skip("6) specContentRef junction/reparse point escape — 이 Node/OS 환경에서 junction 생성이 지원되지 않아 건너뜀");
    return;
  }

  const baseDir = makeTempDir("si2-base-junction-");
  const projectId = nextId("si2-junction");
  const envelope = makeRefEnvelope({
    projectId,
    specContentRef: "linkdir/inside.md",
    specIntegrity: { algorithm: "sha256", hash: sha256Hex(outsideContent) },
  });
  const config: BootstrapTrustedConfig = { bootstrapBaseDir: baseDir, specContentRefSourceRoot: sourceRoot, commitIdentity: COMMIT_IDENTITY };

  const outcome = run(envelope, config);
  check("6) junction escape → BLOCKED(SPEC_CONTENT_REF_ESCAPE)", outcome.status === "BLOCKED" && outcome.code === "SPEC_CONTENT_REF_ESCAPE");
  check("6) project 폴더가 생성되지 않음", !existsSync(join(baseDir, projectId)));
}

// ---------------------------------------------------------------------------
// 7) specContentRef target이 regular file이 아님 → BLOCK
// ---------------------------------------------------------------------------
function scenarioContentRefNotRegularFileBlocked(): void {
  const sourceRoot = makeTempDir("si2-src-notfile-");
  mkdirSync(join(sourceRoot, "specs", "master.md"), { recursive: true }); // "master.md"가 디렉터리

  const baseDir = makeTempDir("si2-base-notfile-");
  const projectId = nextId("si2-notfile");
  const envelope = makeRefEnvelope({
    projectId,
    specContentRef: "specs/master.md",
    specIntegrity: { algorithm: "sha256", hash: "a".repeat(64) },
  });
  const config: BootstrapTrustedConfig = { bootstrapBaseDir: baseDir, specContentRefSourceRoot: sourceRoot, commitIdentity: COMMIT_IDENTITY };

  const outcome = run(envelope, config);
  check(
    "7) 대상이 디렉터리(regular file 아님) → BLOCKED(SPEC_CONTENT_REF_NOT_REGULAR_FILE)",
    outcome.status === "BLOCKED" && outcome.code === "SPEC_CONTENT_REF_NOT_REGULAR_FILE"
  );
  check("7) project 폴더가 생성되지 않음", !existsSync(join(baseDir, projectId)));
}

// ---------------------------------------------------------------------------
// 8) specContentRef 실제 내용에 secret-shaped content → BLOCK
// ---------------------------------------------------------------------------
function scenarioContentRefSecretDetectedBlocked(): void {
  const sourceRoot = makeTempDir("si2-src-secret-");
  mkdirSync(join(sourceRoot, "specs"), { recursive: true });
  const secretContent = 'const config = { apiKey: "not-a-real-credential-00000000" };';
  writeFileSync(join(sourceRoot, "specs", "master.md"), secretContent, "utf-8");

  const baseDir = makeTempDir("si2-base-secret-");
  const projectId = nextId("si2-secret");
  const envelope = makeRefEnvelope({
    projectId,
    specContentRef: "specs/master.md",
    specIntegrity: { algorithm: "sha256", hash: sha256Hex(secretContent) },
  });
  const config: BootstrapTrustedConfig = { bootstrapBaseDir: baseDir, specContentRefSourceRoot: sourceRoot, commitIdentity: COMMIT_IDENTITY };

  const outcome = run(envelope, config);
  check("8) secret 모양 내용 → BLOCKED(SPEC_CONTENT_REF_SECRET_DETECTED)", outcome.status === "BLOCKED" && outcome.code === "SPEC_CONTENT_REF_SECRET_DETECTED");
  check("8) project 폴더가 생성되지 않음", !existsSync(join(baseDir, projectId)));
  if (outcome.status === "BLOCKED") {
    check("8) BLOCK 결과 어디에도 secret 원문이 노출되지 않음", !JSON.stringify(outcome).includes("not-a-real-credential-00000000"));
  }
}

// ---------------------------------------------------------------------------
// REVISE(GPT Independent Reviewer, 1회차 HIGH) — containment 판정이 realpath를 무조건
// toLowerCase()해서 비교했던 버그를 isRealPathWithin()(node:path의 플랫폼 기본
// relative() 그대로 사용, 인위적인 대소문자 정규화 없음)으로 고쳤다. `node:path`가
// 플랫폼별로 다른 구현(win32/posix)을 자동으로 골라 쓰므로, 대소문자 구분 여부 판정
// 자체는 실행 중인 실제 OS의 파일시스템 의미와 항상 일치한다 — 이 프로세스가 win32이므로
// `path.relative()`도 win32 의미(대소문자 구분 없음, 진짜 Windows 파일시스템과 동일)를
// 그대로 따른다("root"/"Root"를 같은 경로로 보는 것은 이 플랫폼에서 실제로 맞는 답이다).
// 이 헬퍼가 고치려던 실제 버그는 "대소문자 구분 여부를 OS에 맡기지 않고 코드가 임의로
// 강제로 무시했던 것"이므로, 여기서는 플랫폼 의존적인 대소문자 케이스 대신 플랫폼과 무관하게
// 항상 성립해야 하는 핵심 containment 불변식(동일 경로/진짜 하위 경로/접두사만 같은 형제
// 경로 차단/상위 이탈 차단)을 직접 검증한다.
// ---------------------------------------------------------------------------
function scenarioCaseSensitiveContainmentFix(): void {
  check("REVISE) 완전히 동일한 real path는 containment로 인정됨", isRealPathWithin("/tmp/root", "/tmp/root") === true);
  check("REVISE) 진짜 하위 경로는 containment로 인정됨", isRealPathWithin("/tmp/root/specs/master.md", "/tmp/root") === true);
  check(
    "REVISE) 접두사만 같고 실제로는 형제인 경로(prefix collision)는 containment로 인정되지 않음 — 이전 버그(단순 startsWith(root+sep) 없는 문자열 비교)였다면 이런 케이스를 놓치기 쉬웠다",
    isRealPathWithin("/tmp/root-other/secret.md", "/tmp/root") === false
  );
  check("REVISE) 상위 디렉터리로의 이탈은 containment로 인정되지 않음", isRealPathWithin("/tmp", "/tmp/root") === false);
}

// ---------------------------------------------------------------------------
// 9) target folder 이미 존재 + unrelated files → COLLISION/BLOCK, 기존 파일 변경/삭제 0건
// ---------------------------------------------------------------------------
function scenarioCollisionWithUnrelatedFolder(): void {
  const baseDir = makeTempDir("si2-base-collision-");
  const projectId = nextId("si2-collision");
  const existingRoot = join(baseDir, projectId);
  mkdirSync(existingRoot, { recursive: true });
  const unrelatedFile = join(existingRoot, "README.txt");
  writeFileSync(unrelatedFile, "이미 존재하던 무관한 파일", "utf-8");

  const envelope = makeInlineEnvelope({ projectId });
  const config: BootstrapTrustedConfig = { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY };
  const outcome = run(envelope, config);

  check("9) 무관한 기존 폴더 → COLLISION", outcome.status === "COLLISION");
  if (outcome.status === "COLLISION") {
    check("9) COLLISION reason=NO_BOOTSTRAP_METADATA", outcome.reason === "NO_BOOTSTRAP_METADATA");
  }
  check("9) 기존 무관 파일 내용이 그대로 보존됨", readFileSync(unrelatedFile, "utf-8") === "이미 존재하던 무관한 파일");
  check("9) .autodev 디렉터리가 생성되지 않음(건드리지 않음)", !existsSync(join(existingRoot, ".autodev")));
}

// ---------------------------------------------------------------------------
// 10) 동일 Handoff 두 번 실행 → project root 하나만 존재, 두 번째는 idempotent result
// ---------------------------------------------------------------------------
function scenarioIdempotentRepeatedHandoff(): void {
  const baseDir = makeTempDir("si2-base-idempotent-");
  const envelope = makeInlineEnvelope();
  const config: BootstrapTrustedConfig = { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY };

  const first = run(envelope, config);
  check("10) 첫 번째 호출 → COMPLETE", first.status === "COMPLETE");
  const second = run(envelope, config);
  check("10) 두 번째(동일) 호출 → ALREADY_BOOTSTRAPPED", second.status === "ALREADY_BOOTSTRAPPED");
  if (first.status === "COMPLETE" && second.status === "ALREADY_BOOTSTRAPPED") {
    check("10) 두 호출의 project root가 동일", first.projectRoot === second.projectRoot);
    check("10) 두 호출의 baselineCommitHash가 동일(재commit 없음)", first.baselineCommitHash === second.baselineCommitHash);
  }
  check("10) baseDir 안에 project 폴더가 정확히 1개", listDirNames(baseDir).filter((n) => existsSync(join(baseDir, n)) && !n.startsWith(".")).length === 1);
  if (first.status === "COMPLETE") {
    check("10) git commit이 정확히 1건(중복 commit 없음)", gitLogCount(first.projectRoot) === 1);
  }
}

// ---------------------------------------------------------------------------
// 11) 같은 handoffId + 다른 hash → conflict BLOCK
// ---------------------------------------------------------------------------
function scenarioConflictSameHandoffDifferentHash(): void {
  const baseDir = makeTempDir("si2-base-conflict-hash-");
  const handoffId = nextId("handoff-si2-conflict-hash");
  const projectId = nextId("si2-conflict-hash");

  const first = run(makeInlineEnvelope({ handoffId, projectId }, "본문 A"), { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY });
  check("11) 첫 번째(본문 A) → COMPLETE", first.status === "COMPLETE");

  const second = run(makeInlineEnvelope({ handoffId, projectId }, "본문 B(다른 내용 → 다른 hash)"), {
    bootstrapBaseDir: baseDir,
    commitIdentity: COMMIT_IDENTITY,
  });
  check("11) 같은 handoffId/projectId, 다른 hash → CONFLICT", second.status === "CONFLICT");
}

// ---------------------------------------------------------------------------
// 12) 같은 handoffId + 다른 projectId → conflict BLOCK
// ---------------------------------------------------------------------------
function scenarioConflictSameHandoffDifferentProjectId(): void {
  const baseDir = makeTempDir("si2-base-conflict-proj-");
  const handoffId = nextId("handoff-si2-conflict-proj");

  const first = run(makeInlineEnvelope({ handoffId, projectId: nextId("si2-conflict-proj-a") }), {
    bootstrapBaseDir: baseDir,
    commitIdentity: COMMIT_IDENTITY,
  });
  check("12) 첫 번째(projectId A) → COMPLETE", first.status === "COMPLETE");

  const secondProjectId = nextId("si2-conflict-proj-b");
  const second = run(makeInlineEnvelope({ handoffId, projectId: secondProjectId }), { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY });
  check("12) 같은 handoffId, 다른 projectId → CONFLICT", second.status === "CONFLICT");
  check("12) 충돌한 두 번째 projectId의 폴더가 생성되지 않음", !existsSync(join(baseDir, secondProjectId)));
}

// ---------------------------------------------------------------------------
// 13) 중간 Bootstrap 단계 실패 → state 보존 → 다음 실행에서 안전 Resume
// ---------------------------------------------------------------------------
function scenarioMidStageFailureThenResume(): void {
  const baseDir = makeTempDir("si2-base-resume-");
  const envelope = makeInlineEnvelope() as { handoffId: string; spec: { projectId: string } };
  // git identity를 일부러 지정하지 않고, PATH를 비워 "git" 실행 자체가 실패하게 만들어
  // GIT_INITIALIZED 단계에서 멈추게 한다 — 이후 재시도는 정상 PATH로 실행해 SPEC_PRESERVED
  // stage부터 안전하게 이어간다는 것을 증명한다.
  const brokenConfig: BootstrapTrustedConfig = { bootstrapBaseDir: baseDir }; // commitIdentity 없음, 문제는 PATH로 유발
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  let firstOutcome: BootstrapOutcome;
  try {
    firstOutcome = run(envelope, brokenConfig);
  } finally {
    process.env.PATH = originalPath;
  }
  check("13) git 실행 불가 상태에서 첫 시도 → WAITING_HUMAN", firstOutcome.status === "WAITING_HUMAN");
  if (firstOutcome.status !== "WAITING_HUMAN") return;
  check("13) 실패 시점 stage가 SPEC_PRESERVED(그 다음 단계에서 막힘)", firstOutcome.stage === "SPEC_PRESERVED");

  const stateFile = join(firstOutcome.projectRoot, ".autodev", "bootstrap-state.json");
  check("13) 실패 이후에도 bootstrap-state.json이 보존됨", existsSync(stateFile));
  const specFile = join(firstOutcome.projectRoot, ".autodev", "master-spec", "spec.md");
  check("13) 실패 이후에도 이미 완료된 SPEC_PRESERVED 산출물이 보존됨", existsSync(specFile));

  const resumed = run(envelope, { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY });
  check("13) 정상 환경에서 재실행 → COMPLETE(resume 성공)", resumed.status === "COMPLETE");
  if (resumed.status === "COMPLETE") {
    check("13) resume 이후에도 project root가 동일", resumed.projectRoot === firstOutcome.projectRoot);
  }
}

// ---------------------------------------------------------------------------
// 14) Git init 실패 → 성공으로 보고하지 않음
// ---------------------------------------------------------------------------
function scenarioGitInitFailureNotReportedAsSuccess(): void {
  const baseDir = makeTempDir("si2-base-gitinit-fail-");
  const envelope = makeInlineEnvelope();
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  let outcome: BootstrapOutcome;
  try {
    outcome = run(envelope, { bootstrapBaseDir: baseDir });
  } finally {
    process.env.PATH = originalPath;
  }
  check("14) git 실행 불가 → WAITING_HUMAN(성공 아님)", outcome.status === "WAITING_HUMAN");
  check("14) COMPLETE로 보고되지 않음", (outcome as { status: string }).status !== "COMPLETE");
}

// ---------------------------------------------------------------------------
// 15) baseline commit 실패 → 성공으로 보고하지 않음
// ---------------------------------------------------------------------------
function scenarioBaselineCommitFailureNotReportedAsSuccess(): void {
  const baseDir = makeTempDir("si2-base-commit-fail-");
  const envelope = makeInlineEnvelope();
  // commitIdentity를 지정하지 않고, git identity가 없는 격리된 HOME/USERPROFILE로 commit이
  // 실패하도록 강제한다(전역 git config를 건드리지 않고 이 프로세스 안에서만 격리).
  const isolatedHome = makeTempDir("si2-isolated-home-");
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.GIT_CONFIG_GLOBAL = join(isolatedHome, "nonexistent-gitconfig");
  let outcome: BootstrapOutcome;
  try {
    outcome = run(envelope, { bootstrapBaseDir: baseDir }); // commitIdentity 없음 → ambient(격리된, 비어있는) config에 의존
  } finally {
    process.env.HOME = originalHome;
    process.env.USERPROFILE = originalUserProfile;
    if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
  }
  check("15) git identity 없이 commit 시도 → WAITING_HUMAN(성공 아님)", outcome.status === "WAITING_HUMAN");
  check("15) COMPLETE로 보고되지 않음", (outcome as { status: string }).status !== "COMPLETE");
}

// ---------------------------------------------------------------------------
// 16) Windows path edge cases — traversal/absolute/drive/UNC/reserved device/trailing dot-space/ADS 방어
// ---------------------------------------------------------------------------
function scenarioWindowsPathEdgeCases(): void {
  const baseDir = makeTempDir("si2-base-edgecases-");
  const config: BootstrapTrustedConfig = { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY };

  // 이 네 형태(traversal/드라이브 절대경로/UNC/ADS)는 이미 SI-1(evaluateSpecIntake)의
  // isSafeRelativeSpecRef 형식 검증에서 REJECT된다 — ACCEPT_PENDING_CONTENT_VERIFICATION까지
  // 도달하지 못하므로 SI-2의 verifySpecContentRefFile(BLOCKED/SPEC_CONTENT_REF_ESCAPE)까지
  // 갈 필요가 없다(§ "SI-1 validation rule을 복제하지 말고 재사용" 원칙 그대로 동작).
  const traversalOutcome = run(makeRefEnvelope({ specContentRef: "../../etc/passwd" }), { ...config, specContentRefSourceRoot: baseDir });
  check("16) specContentRef traversal → REJECTED(SI-1 형식 검증)", traversalOutcome.status === "REJECTED");

  const absoluteOutcome = run(makeRefEnvelope({ specContentRef: "C:\\secrets\\master.md" }), { ...config, specContentRefSourceRoot: baseDir });
  check("16) specContentRef drive 절대경로 → REJECTED(SI-1 형식 검증)", absoluteOutcome.status === "REJECTED");

  const uncOutcome = run(makeRefEnvelope({ specContentRef: "\\\\server\\share\\master.md" }), { ...config, specContentRefSourceRoot: baseDir });
  check("16) specContentRef UNC 경로 → REJECTED(SI-1 형식 검증)", uncOutcome.status === "REJECTED");

  const adsOutcome = run(makeRefEnvelope({ specContentRef: "specs/master.md:hidden" }), { ...config, specContentRefSourceRoot: baseDir });
  check("16) specContentRef NTFS ADS 형태 → REJECTED(SI-1 형식 검증)", adsOutcome.status === "REJECTED");

  const reservedNameProjectId = "CON";
  const reservedOutcome = run(makeInlineEnvelope({ projectId: reservedNameProjectId }), config);
  check(
    "16) projectId가 Windows 예약 장치명(CON) → BLOCKED(PROJECT_ROOT_RESERVED_NAME)",
    reservedOutcome.status === "BLOCKED" && reservedOutcome.code === "PROJECT_ROOT_RESERVED_NAME"
  );
}

// ---------------------------------------------------------------------------
// 17) AutoDev Core repo 내부 생성 시도 → BLOCK
// ---------------------------------------------------------------------------
function scenarioCoreRepoNestedCreationBlocked(): void {
  const envelope = makeInlineEnvelope();
  const outcomeAtRoot = run(envelope, { bootstrapBaseDir: AUTODEV_ROOT, commitIdentity: COMMIT_IDENTITY });
  check("17) bootstrapBaseDir=AUTODEV_ROOT 자체 → BLOCKED(INVALID_CONFIG)", outcomeAtRoot.status === "BLOCKED" && outcomeAtRoot.code === "INVALID_CONFIG");

  const srcSubdir = join(AUTODEV_ROOT, "src");
  const outcomeInSubdir = run(envelope, { bootstrapBaseDir: srcSubdir, commitIdentity: COMMIT_IDENTITY });
  check(
    "17) bootstrapBaseDir=AUTODEV_ROOT 하위(src/) → BLOCKED(INVALID_CONFIG)",
    outcomeInSubdir.status === "BLOCKED" && outcomeInSubdir.code === "INVALID_CONFIG"
  );
}

// ---------------------------------------------------------------------------
// REVISE(GPT Independent Reviewer, 4회차 CRITICAL) — 이미 존재하는 project root 경로 자체가
// symlink/junction으로 bootstrapBaseDir 밖(동일 identity metadata를 담은 외부 디렉터리)을
// 가리키면, 그 metadata를 신뢰해 resume 단계의 write/git 실행이 bootstrapBaseDir 밖에서
// 일어날 수 있었다. evaluateExistingProjectRoot()가 metadata를 읽기 전에 realpath
// containment부터 확인하도록 고쳤다.
// ---------------------------------------------------------------------------
function scenarioExistingProjectRootJunctionEscapeBlocked(): void {
  const baseDir = makeTempDir("si2-base-root-escape-");
  const outsideDir = makeTempDir("si2-outside-root-escape-");
  const projectId = nextId("si2-root-escape");

  // 공격자가 outsideDir 안에 "이미 완료된 것처럼 보이는" 동일 identity metadata를 미리
  // 심어둔 상황을 흉내낸다 — containment 검사가 먼저 막아야 metadata 내용 자체는 전혀
  // 문제가 되지 않는다는 것을 증명한다.
  mkdirSync(join(outsideDir, ".autodev"), { recursive: true });
  writeFileSync(join(outsideDir, ".autodev", "planted.txt"), "이 디렉터리 내용은 절대 신뢰되면 안 된다", "utf-8");

  const linkPath = join(baseDir, projectId);
  let created = false;
  try {
    symlinkSync(outsideDir, linkPath, "junction");
    created = true;
  } catch {
    // 이 Node/OS 조합에서 junction 생성이 지원되지 않을 수 있다(시나리오 6과 동일한 방어적 처리).
  }
  if (!created) {
    skip("REVISE) 기존 project root 자체가 junction으로 bootstrapBaseDir 밖을 가리키는 경우 — 이 환경에서 junction 생성이 지원되지 않아 건너뜀");
    return;
  }

  const envelope = makeInlineEnvelope({ projectId });
  const outcome = run(envelope, { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY });
  check("REVISE) project root 자체가 junction으로 bootstrapBaseDir 밖을 가리킴 → BLOCKED(PROJECT_ROOT_ESCAPE)", outcome.status === "BLOCKED" && outcome.code === "PROJECT_ROOT_ESCAPE");
  check("REVISE) 외부 디렉터리 내용이 그대로 보존됨(전혀 건드리지 않음)", existsSync(join(outsideDir, ".autodev", "planted.txt")));
}

// ---------------------------------------------------------------------------
// REVISE(GPT Independent Reviewer, 5회차 CRITICAL) — project root 자체는 정상(실제
// 디렉터리)이어도, 그 하위의 `.autodev` 또는 `.autodev/master-spec`가 각각 별도의
// junction으로 project root 밖을 가리킬 수 있었다. evaluateExistingProjectRoot()가 이제
// 두 경로를 각각 metadata를 읽기 전에 realpath containment로 확인한다.
// ---------------------------------------------------------------------------
function scenarioExistingSubPathJunctionEscapeBlocked(): void {
  // 5a) .autodev 자체가 junction으로 project root 밖을 가리키는 경우.
  {
    const baseDir = makeTempDir("si2-base-subpath-escape-a-");
    const outsideDir = makeTempDir("si2-outside-subpath-escape-a-");
    const projectId = nextId("si2-subpath-escape-a");
    const projectRoot = join(baseDir, projectId);
    mkdirSync(projectRoot, { recursive: true }); // project root 자체는 진짜 디렉터리
    writeFileSync(join(outsideDir, "planted.txt"), "이 디렉터리 내용은 절대 신뢰되면 안 된다", "utf-8");

    let created = false;
    try {
      symlinkSync(outsideDir, join(projectRoot, ".autodev"), "junction");
      created = true;
    } catch {
      // 이 Node/OS 조합에서 junction 생성이 지원되지 않을 수 있다.
    }
    if (!created) {
      skip("REVISE) .autodev 자체가 junction으로 project root 밖을 가리키는 경우 — 이 환경에서 junction 생성이 지원되지 않아 건너뜀");
    } else {
      const envelope = makeInlineEnvelope({ projectId });
      const outcome = run(envelope, { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY });
      check(
        "REVISE 5a) .autodev 자체가 junction으로 project root 밖을 가리킴 → BLOCKED(PROJECT_ROOT_ESCAPE)",
        outcome.status === "BLOCKED" && outcome.code === "PROJECT_ROOT_ESCAPE"
      );
      check("REVISE 5a) 외부 디렉터리 내용이 그대로 보존됨", existsSync(join(outsideDir, "planted.txt")));
    }
  }

  // 5b) .autodev는 진짜 디렉터리이지만 그 하위 master-spec만 junction으로 밖을 가리키는 경우.
  {
    const baseDir = makeTempDir("si2-base-subpath-escape-b-");
    const outsideDir = makeTempDir("si2-outside-subpath-escape-b-");
    const projectId = nextId("si2-subpath-escape-b");
    const projectRoot = join(baseDir, projectId);
    mkdirSync(join(projectRoot, ".autodev"), { recursive: true });
    writeFileSync(join(outsideDir, "planted.txt"), "이 디렉터리 내용은 절대 신뢰되면 안 된다", "utf-8");

    let created = false;
    try {
      symlinkSync(outsideDir, join(projectRoot, ".autodev", "master-spec"), "junction");
      created = true;
    } catch {
      // 이 Node/OS 조합에서 junction 생성이 지원되지 않을 수 있다.
    }
    if (!created) {
      skip("REVISE) master-spec만 junction으로 project root 밖을 가리키는 경우 — 이 환경에서 junction 생성이 지원되지 않아 건너뜀");
      return;
    }
    const envelope = makeInlineEnvelope({ projectId });
    const outcome = run(envelope, { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY });
    check(
      "REVISE 5b) master-spec만 junction으로 project root 밖을 가리킴 → BLOCKED(PROJECT_ROOT_ESCAPE)",
      outcome.status === "BLOCKED" && outcome.code === "PROJECT_ROOT_ESCAPE"
    );
    check("REVISE 5b) 외부 디렉터리 내용이 그대로 보존됨", existsSync(join(outsideDir, "planted.txt")));
  }
}

// ---------------------------------------------------------------------------
// REVISE(GPT Independent Reviewer, 4회차 HIGH) — 여러 프로세스가 동시에 같은 projectId를
// bootstrap하면 서로의 mkdir/state/git index를 덮어쓸 수 있었다. projectId 단위 exclusive
// lock(acquireBootstrapLock)을 추가했다 — 실제로 살아있는 다른 프로세스가 잡고 있으면
// BLOCK하고, 죽은 프로세스가 남긴 lock(stale)은 project-lock.ts의 동일한 판정 로직
// (assessOwnerLiveness)으로 안전하게 복구한다.
// ---------------------------------------------------------------------------
function waitForPidDeath(pid: number, timeoutMs = 5000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // 더 이상 살아있지 않음
    }
  }
}

function scenarioConcurrentAndStaleBootstrapLock(): void {
  const baseDir = makeTempDir("si2-base-lock-");
  const projectId = nextId("si2-lock-proj");
  const envelope = makeInlineEnvelope({ projectId });

  // 이 실행 중인 테스트 프로세스와는 다른, 실제로 살아있는 별도 프로세스를 하나 띄워
  // 그 pid로 lock을 미리 심는다(진짜 "다른 프로세스가 이미 진행 중" 상황을 재현).
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", detached: true });
  child.unref();
  const childPid = child.pid as number;

  try {
    const lockPath = debugComputeBootstrapLockFilePath(baseDir, "project", projectId);
    mkdirSync(join(baseDir, ".autodev-bootstrap-locks"), { recursive: true });
    writeFileSync(
      lockPath,
      JSON.stringify({ schemaVersion: 1, pid: childPid, processStartedAtMs: Date.now(), lockId: "fake-live-lock", createdAt: new Date().toISOString() }, null, 2),
      "utf-8"
    );

    const blockedOutcome = run(envelope, { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY });
    check(
      "REVISE) 살아있는 다른 프로세스가 이미 잡은 lock → BLOCKED(CONCURRENT_BOOTSTRAP_IN_PROGRESS)",
      blockedOutcome.status === "BLOCKED" && blockedOutcome.code === "CONCURRENT_BOOTSTRAP_IN_PROGRESS"
    );
    check("REVISE) lock에 막혀 project 폴더가 생성되지 않음", !existsSync(join(baseDir, projectId)));

    process.kill(childPid);
    waitForPidDeath(childPid);

    // lock 파일은 그대로 남겨둔 채(수동 삭제 없이) 재시도한다 — 죽은 owner의 lock이
    // 자동으로 stale 복구되어야 한다.
    const resumedOutcome = run(envelope, { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY });
    check("REVISE) owner 프로세스가 죽은 뒤에는 stale lock이 자동 복구되어 정상 진행됨 → COMPLETE", resumedOutcome.status === "COMPLETE");
  } finally {
    try {
      if (childPid) process.kill(childPid);
    } catch {
      // 이미 종료됨 — 무시.
    }
  }
}

// ---------------------------------------------------------------------------
// REVISE(GPT Independent Reviewer, 5회차 HIGH) — projectId 단위 lock 하나만으로는 같은
// handoffId를 서로 다른 projectId로 동시에 bootstrap하는 두 호출을 직렬화하지 못했다(서로
// 다른 lock을 각자 얻어 handoff index 부재를 동시에 관찰할 수 있었다). handoffId 단위
// lock을 추가로 잡도록 고쳤다 — 살아있는 다른 프로세스가 같은 handoffId에 대한 handoff
// lock을 먼저 잡고 있으면, 이번 호출의 projectId가 그 프로세스와 다르더라도 즉시 막혀야
// 한다(이전에는 projectId가 다르면 그냥 통과했다).
// ---------------------------------------------------------------------------
function scenarioSameHandoffDifferentProjectIdConcurrencyBlocked(): void {
  const baseDir = makeTempDir("si2-base-handoff-lock-");
  const handoffId = nextId("handoff-si2-lock");
  const projectId = nextId("si2-handoff-lock-proj");
  const envelope = makeInlineEnvelope({ handoffId, projectId });

  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", detached: true });
  child.unref();
  const childPid = child.pid as number;

  try {
    // 다른(가상의) projectId로 이미 이 handoffId를 처리 중인 프로세스가 있는 것처럼
    // handoff lock을 미리 심는다 — 이번 호출의 projectId는 이 lock과 무관하게 다르다.
    const handoffLockPath = debugComputeBootstrapLockFilePath(baseDir, "handoff", handoffId);
    mkdirSync(join(baseDir, ".autodev-bootstrap-locks"), { recursive: true });
    writeFileSync(
      handoffLockPath,
      JSON.stringify({ schemaVersion: 1, pid: childPid, processStartedAtMs: Date.now(), lockId: "fake-handoff-lock", createdAt: new Date().toISOString() }, null, 2),
      "utf-8"
    );

    const blockedOutcome = run(envelope, { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY });
    check(
      "REVISE) 같은 handoffId를 다른 프로세스가 이미 처리 중(handoff lock) → projectId가 달라도 BLOCKED(CONCURRENT_BOOTSTRAP_IN_PROGRESS)",
      blockedOutcome.status === "BLOCKED" && blockedOutcome.code === "CONCURRENT_BOOTSTRAP_IN_PROGRESS"
    );
    check("REVISE) handoff lock에 막혀 project 폴더가 생성되지 않음", !existsSync(join(baseDir, projectId)));
  } finally {
    try {
      if (childPid) process.kill(childPid);
    } catch {
      // 이미 종료됨 — 무시.
    }
  }
}

// ---------------------------------------------------------------------------
// REVISE(GPT Independent Reviewer, 6회차 CRITICAL #1) — bootstrapBaseDir 바로 아래의
// `.autodev-bootstrap-index`/`.autodev-bootstrap-locks` 디렉터리 자체가 symlink/junction으로
// 밖을 가리킬 수 있었다. 사용 전에 그 realpath containment를 확인하도록 고쳤다.
// ---------------------------------------------------------------------------
function scenarioBaseLevelIndexAndLockDirJunctionEscapeBlocked(): void {
  // index 디렉터리 자체가 junction인 경우.
  {
    const baseDir = makeTempDir("si2-base-indexdir-escape-");
    const outsideDir = makeTempDir("si2-outside-indexdir-escape-");
    writeFileSync(join(outsideDir, "planted.txt"), "외부 index 디렉터리 내용은 절대 신뢰되면 안 된다", "utf-8");
    let created = false;
    try {
      symlinkSync(outsideDir, join(baseDir, ".autodev-bootstrap-index"), "junction");
      created = true;
    } catch {
      // 이 Node/OS 조합에서 junction 생성이 지원되지 않을 수 있다.
    }
    if (!created) {
      skip("REVISE) .autodev-bootstrap-index 자체가 junction으로 baseDir 밖을 가리키는 경우 — 이 환경에서 junction 생성이 지원되지 않아 건너뜀");
    } else {
      const outcome = run(makeInlineEnvelope(), { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY });
      check(
        "REVISE 6) .autodev-bootstrap-index가 junction으로 baseDir 밖을 가리킴 → BLOCKED(CORRUPT_HANDOFF_INDEX)",
        outcome.status === "BLOCKED" && outcome.code === "CORRUPT_HANDOFF_INDEX"
      );
      check("REVISE 6) 외부 index 디렉터리 내용이 그대로 보존됨", existsSync(join(outsideDir, "planted.txt")));
    }
  }

  // lock 디렉터리 자체가 junction인 경우.
  {
    const baseDir = makeTempDir("si2-base-lockdir-escape-");
    const outsideDir = makeTempDir("si2-outside-lockdir-escape-");
    writeFileSync(join(outsideDir, "planted.txt"), "외부 lock 디렉터리 내용은 절대 신뢰되면 안 된다", "utf-8");
    let created = false;
    try {
      symlinkSync(outsideDir, join(baseDir, ".autodev-bootstrap-locks"), "junction");
      created = true;
    } catch {
      // 이 Node/OS 조합에서 junction 생성이 지원되지 않을 수 있다.
    }
    if (!created) {
      skip("REVISE) .autodev-bootstrap-locks 자체가 junction으로 baseDir 밖을 가리키는 경우 — 이 환경에서 junction 생성이 지원되지 않아 건너뜀");
      return;
    }
    const outcome = run(makeInlineEnvelope(), { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY });
    check(
      "REVISE 6) .autodev-bootstrap-locks가 junction으로 baseDir 밖을 가리킴 → BLOCKED(CONCURRENT_BOOTSTRAP_IN_PROGRESS)",
      outcome.status === "BLOCKED" && outcome.code === "CONCURRENT_BOOTSTRAP_IN_PROGRESS"
    );
    check("REVISE 6) 외부 lock 디렉터리 내용이 그대로 보존됨", existsSync(join(outsideDir, "planted.txt")));
  }
}

/** SPEC_PRESERVED 단계까지 이미 정상적으로 진행된 것처럼 project root 상태를 직접
 *  구성한다(실제 bootstrapProject() 호출 없이) — "그다음 단계(git init/commit)에서 무엇을
 *  만나는지"만 격리해서 검증하기 위한 공용 fixture다. */
function makeSpecPreservedFixture(
  baseDir: string,
  content: string
): { envelope: { handoffId: string; spec: { projectId: string } }; projectRoot: string; identity: Record<string, unknown> } {
  const projectId = nextId("si2-fixture");
  const hash = sha256Hex(content);
  const envelope = makeInlineEnvelope({ projectId, specIntegrity: { algorithm: "sha256", hash } }, content) as {
    handoffId: string;
    spec: { projectId: string };
  };

  const projectRoot = join(baseDir, projectId);
  mkdirSync(join(projectRoot, ".autodev", "master-spec"), { recursive: true });
  writeFileSync(join(projectRoot, ".autodev", "master-spec", "spec.md"), content, "utf-8");
  writeFileSync(
    join(projectRoot, ".autodev", "master-spec", "manifest.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        projectId,
        projectName: "SI-2 Fixture Project",
        specVersion: "1.0.0",
        handoffId: envelope.handoffId,
        specIntegrity: { algorithm: "sha256", hash },
        specStatus: "APPROVED",
        userApproval: "PASS",
        reviewerGate: { critical: 0, high: 0 },
        unresolvedCriticalCount: 0,
        contradictionCount: 0,
        bootstrapProvenance: { sourceKind: "INLINE", bootstrappedAt: new Date().toISOString() },
        storedContentDigest: { algorithm: "sha256", hash },
      },
      null,
      2
    ),
    "utf-8"
  );
  const identity = {
    handoffId: envelope.handoffId,
    projectId,
    specVersion: "1.0.0",
    specIntegrityAlgorithm: "sha256",
    specIntegrityHash: hash,
  };
  writeFileSync(
    join(projectRoot, ".autodev", "bootstrap-state.json"),
    JSON.stringify({ schemaVersion: 1, identity, stage: "SPEC_PRESERVED", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }, null, 2),
    "utf-8"
  );
  return { envelope, projectRoot, identity };
}

// ---------------------------------------------------------------------------
// REVISE(GPT Independent Reviewer, 6회차 CRITICAL #2) — resume 시 `.git`이 project root
// 내부의 진짜 디렉터리라는 보장이 없었다 — "gitfile"(`gitdir: <외부경로>` 형태의 일반
// 텍스트 파일, git worktree/submodule이 정상 사용하는 형식)로 만들어져 있으면 git이 그대로
// 외부 저장소를 따라갈 수 있었다. assertGitDirSafe()가 이제 git을 실행하기 전에 `.git`이
// 일반 디렉터리인지 먼저 확인한다.
// ---------------------------------------------------------------------------
function scenarioGitfileRedirectBlocked(): void {
  const baseDir = makeTempDir("si2-base-gitfile-");
  const { envelope, projectRoot } = makeSpecPreservedFixture(baseDir, "gitfile redirect 방어 테스트용 Master Spec 본문");
  // .git을 진짜 디렉터리가 아니라 "gitfile"(일반 텍스트 파일)로 만든다.
  writeFileSync(join(projectRoot, ".git"), "gitdir: ../../somewhere-outside-this-project\n", "utf-8");

  const outcome = run(envelope, { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY });
  check("REVISE 6) .git이 gitfile(일반 파일)로 존재 → WAITING_HUMAN(git 실행 거부, 성공 아님)", outcome.status === "WAITING_HUMAN");
}

// ---------------------------------------------------------------------------
// REVISE(GPT Independent Reviewer, 7회차 CRITICAL) — resume이 재사용하는 기존 `.git`은
// project root 내부의 진짜 디렉터리여도, 그 `.git/config`/`.gitattributes` 내용 자체가
// 알려진 RCE 벡터(core.hooksPath/core.worktree/core.fsmonitor, filter.*.clean)로 변조돼
// 있으면 git add/commit 과정에서 임의 명령이 실행되거나 엉뚱한 worktree를 조작할 수
// 있었다. runHardenedGit()의 `-c` override(hooksPath/fsmonitor/worktree는 명령줄이 항상
// 파일 기반 config보다 우선)와 checkNoFilterAttribute()(add 이전 filter attribute 확인)로
// 막는다 — 두 방어를 서로 다른 시나리오로 분리해 검증한다(하나의 fixture에 전부 넣으면
// filter 방어가 먼저 걸려 worktree/hooksPath override가 실제로 검증됐는지 알 수 없다).
// ---------------------------------------------------------------------------
function scenarioMaliciousGitConfigOverridden(): void {
  const baseDir = makeTempDir("si2-base-git-hijack-");
  const outsideDir = makeTempDir("si2-outside-git-hijack-");
  const { envelope, projectRoot } = makeSpecPreservedFixture(baseDir, "악의적 git config 무력화 테스트용 Master Spec 본문");

  // 실제 git repo를 만들고(gitfile 아님, containment도 정상 — assertGitDirSafe는 통과해야
  // 한다) config를 악의적으로 변조한다.
  spawnSync("git", ["init"], { cwd: projectRoot });
  spawnSync("git", ["config", "user.name", "Fixture"], { cwd: projectRoot });
  spawnSync("git", ["config", "user.email", "fixture-si2@example.invalid"], { cwd: projectRoot });

  const maliciousHooksDir = join(outsideDir, "malicious-hooks");
  mkdirSync(maliciousHooksDir, { recursive: true });
  const hookMarker = join(outsideDir, "hook-executed.txt");
  writeFileSync(join(maliciousHooksDir, "pre-commit"), `#!/bin/sh\necho pwned > "${hookMarker.replace(/\\/g, "/")}"\n`, "utf-8");
  const maliciousWorktree = join(outsideDir, "malicious-worktree");
  mkdirSync(maliciousWorktree, { recursive: true });

  spawnSync("git", ["config", "core.hooksPath", maliciousHooksDir], { cwd: projectRoot });
  spawnSync("git", ["config", "core.worktree", maliciousWorktree], { cwd: projectRoot });
  spawnSync("git", ["config", "core.fsmonitor", join(outsideDir, "fsmonitor-hook")], { cwd: projectRoot });

  const outcome = run(envelope, { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY });
  check(
    "REVISE 7) 악의적 core.hooksPath/core.worktree/core.fsmonitor가 설정된 기존 repo에서도 -c override로 무력화되어 정상 COMPLETE",
    outcome.status === "COMPLETE"
  );
  check("REVISE 7) 악의적 pre-commit hook이 실행되지 않음(marker 파일 없음)", !existsSync(hookMarker));
  if (outcome.status === "COMPLETE") {
    check("REVISE 7) commit이 (redirect된 외부 worktree가 아니라) 실제 project root 안에 만들어짐", gitLogCount(projectRoot) === 1);
  }
}

// ---------------------------------------------------------------------------
// REVISE(GPT Independent Reviewer, 8회차 CRITICAL) — commit.gpgSign(repo config)이
// true이면 gpg.program/gpg.ssh.program에 지정된(마찬가지로 config로 지정되는) 외부
// 프로그램을 git commit이 그대로 실행한다 — hooksPath와 동일한 유형의 config 기반 임의
// 프로그램 실행 벡터다. runHardenedGit()이 이제 매 호출에 -c commit.gpgSign=false를
// 강제한다.
// ---------------------------------------------------------------------------
function scenarioMaliciousGpgSignProgramNotExecuted(): void {
  const baseDir = makeTempDir("si2-base-git-gpgsign-");
  const outsideDir = makeTempDir("si2-outside-git-gpgsign-");
  const { envelope, projectRoot } = makeSpecPreservedFixture(baseDir, "commit.gpgSign 무력화 테스트용 Master Spec 본문");

  spawnSync("git", ["init"], { cwd: projectRoot });
  spawnSync("git", ["config", "user.name", "Fixture"], { cwd: projectRoot });
  spawnSync("git", ["config", "user.email", "fixture-si2@example.invalid"], { cwd: projectRoot });

  const gpgMarker = join(outsideDir, "gpg-program-executed.txt");
  const fakeGpgScript = join(outsideDir, process.platform === "win32" ? "fake-gpg.cmd" : "fake-gpg.sh");
  const fakeGpgContent =
    process.platform === "win32"
      ? `@echo off\r\necho pwned > "${gpgMarker}"\r\nexit /b 0\r\n`
      : `#!/bin/sh\necho pwned > "${gpgMarker}"\nexit 0\n`;
  writeFileSync(fakeGpgScript, fakeGpgContent, "utf-8");

  spawnSync("git", ["config", "commit.gpgSign", "true"], { cwd: projectRoot });
  spawnSync("git", ["config", "gpg.program", fakeGpgScript], { cwd: projectRoot });

  const outcome = run(envelope, { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY });
  check(
    "REVISE 8) commit.gpgSign=true + 악의적 gpg.program이 설정된 기존 repo에서도 -c commit.gpgSign=false로 무력화되어 정상 COMPLETE",
    outcome.status === "COMPLETE"
  );
  check("REVISE 8) 악의적 gpg.program이 실행되지 않음(marker 파일 없음)", !existsSync(gpgMarker));
}

function scenarioMaliciousFilterAttributeBlocked(): void {
  const baseDir = makeTempDir("si2-base-git-filter-");
  const outsideDir = makeTempDir("si2-outside-git-filter-");
  const { envelope, projectRoot } = makeSpecPreservedFixture(baseDir, "gitattributes clean filter 방어 테스트용 Master Spec 본문");

  spawnSync("git", ["init"], { cwd: projectRoot });
  spawnSync("git", ["config", "user.name", "Fixture"], { cwd: projectRoot });
  spawnSync("git", ["config", "user.email", "fixture-si2@example.invalid"], { cwd: projectRoot });

  const filterMarker = join(outsideDir, "filter-executed.txt");
  const filterCmd =
    process.platform === "win32" ? `cmd /c echo pwned > "${filterMarker}"` : `sh -c "echo pwned > '${filterMarker}'"`;
  spawnSync("git", ["config", "filter.evil.clean", filterCmd], { cwd: projectRoot });
  writeFileSync(join(projectRoot, ".gitattributes"), "* filter=evil\n", "utf-8");

  const outcome = run(envelope, { bootstrapBaseDir: baseDir, commitIdentity: COMMIT_IDENTITY });
  check(
    "REVISE 7) .gitattributes clean filter가 설정된 파일 → WAITING_HUMAN(add 시도 전 filter attribute 확인으로 차단)",
    outcome.status === "WAITING_HUMAN"
  );
  check("REVISE 7) 악의적 clean filter가 실행되지 않음(marker 파일 없음, add 자체를 시도하지 않았음)", !existsSync(filterMarker));
}

// ---------------------------------------------------------------------------
// 18) test fixture cleanup 이후 AutoDev repository에 생성 side effect 없음
// ---------------------------------------------------------------------------
function scenarioNoSideEffectOnAutodevRepo(before: string[]): void {
  const after = readdirSync(AUTODEV_ROOT);
  check("18) 이 테스트 실행 전후로 AutoDev 저장소 최상위 디렉터리 목록이 그대로임", JSON.stringify(before) === JSON.stringify(after));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main(): void {
  const autodevRootTopLevelBefore = readdirSync(AUTODEV_ROOT);

  try {
    scenarioValidInlineBootstrapSucceeds();
    scenarioRejectCreatesNothing();
    scenarioValidContentRefBootstrapSucceeds();
    scenarioContentRefHashMismatchBlocked();
    scenarioContentRefSymlinkEscapeBlocked();
    scenarioContentRefJunctionEscapeBlocked();
    scenarioContentRefNotRegularFileBlocked();
    scenarioContentRefSecretDetectedBlocked();
    scenarioCaseSensitiveContainmentFix();
    scenarioCollisionWithUnrelatedFolder();
    scenarioIdempotentRepeatedHandoff();
    scenarioConflictSameHandoffDifferentHash();
    scenarioConflictSameHandoffDifferentProjectId();
    scenarioMidStageFailureThenResume();
    scenarioGitInitFailureNotReportedAsSuccess();
    scenarioBaselineCommitFailureNotReportedAsSuccess();
    scenarioWindowsPathEdgeCases();
    scenarioCoreRepoNestedCreationBlocked();
    scenarioExistingProjectRootJunctionEscapeBlocked();
    scenarioExistingSubPathJunctionEscapeBlocked();
    scenarioConcurrentAndStaleBootstrapLock();
    scenarioSameHandoffDifferentProjectIdConcurrencyBlocked();
    scenarioBaseLevelIndexAndLockDirJunctionEscapeBlocked();
    scenarioGitfileRedirectBlocked();
    scenarioMaliciousGitConfigOverridden();
    scenarioMaliciousGpgSignProgramNotExecuted();
    scenarioMaliciousFilterAttributeBlocked();
  } finally {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }

  scenarioNoSideEffectOnAutodevRepo(autodevRootTopLevelBefore);

  console.log("\n=== project-bootstrap 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  const skipCount = results.filter((r) => r.startsWith("[SKIP]")).length;
  const failCount = results.filter((r) => r.startsWith("[FAIL]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, SKIP ${skipCount}, FAIL ${failCount}`);
  if (failCount > 0) process.exitCode = 1;
}

main();
