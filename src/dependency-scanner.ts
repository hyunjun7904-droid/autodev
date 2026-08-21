import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { WorkingTreeChange } from "./git-changes";

// Deterministic Dependency / Supply-chain Scanner Gate — Phase C Task C5.
//
// commit(checkpoint) 대상에 npm package manifest(package.json)/lockfile(package-lock.json)
// 변경이 포함돼 있을 때, 그 변경이 악성/위험 패키지·위험한 설치 출처·lockfile 이상을
// 끌어들이는지 "정규식/구조 기반 deterministic 규칙"만으로 판정한다. AI(Claude/GPT) 판단에
// 의존하지 않는다 — 이 모듈은 LLM을 호출하지 않고, 어떤 LLM 출력도 신뢰 입력으로 받지 않는다.
//
// Secret Scanner(secret-scanner.ts, commit 대상 "내용"에 secret이 있는지)/Safe Executor(무엇을
// 읽고/쓰고/실행할 수 있는지)/Core Command Safety Gate(safe-executor.ts, RUN_COMMAND 자체의
// 안전)와 책임을 분리한다 — 이 모듈은 "commit하려는 dependency 변경이 공급망 위험을
// 끌어들이는가"만 판정한다.
//
// 이 모듈의 판정 함수(scanChangesForDependencyRisk)는 어떤 ProjectExecutionPolicy도 인자로
// 받지 않는다 — 함수 시그니처 자체에 약화/우회 옵션이 없으므로, 어떤 프로젝트도 이 Core
// 보호를 끄거나 좁힐 방법이 없다(secret-scanner.ts와 동일한 설계 원칙).
//
// npm lockfileVersion 2/3("packages" 맵 형식)만 지원한다 — 이 저장소(및 실제 대상 프로젝트가
// 흔히 쓰는) package-lock.json이 이 형식이다. 지원하지 않는 lockfileVersion/형식은 "판단
// 불가"로 취급해 조용히 PASS하지 않고 BLOCK한다(요구사항: 판단불가를 PASS로 처리하지 않음).

const MANIFEST_BASENAME = "package.json";
const LOCKFILE_BASENAME = "package-lock.json";
// 공식 npm registry 호스트 — 이 밖의 https tarball URL은 "비표준 source"로 사람 확인을
// 받게 한다(사설 registry 등 정상 사용도 있을 수 있어 BLOCK이 아니라 human_review로 둔다).
const TRUSTED_REGISTRY_HOSTS = new Set(["registry.npmjs.org"]);
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;
const INTEGRITY_PATTERN = /^sha(1|256|512)-[A-Za-z0-9+/=]+$/;

export type DependencyFindingKind =
  | "manifest-parse-error"
  | "lockfile-parse-error"
  | "lockfile-missing"
  | "manifest-lockfile-mismatch"
  | "insecure-source-http"
  | "non-standard-source-git-pinned"
  | "non-standard-source-git-unpinned"
  | "non-standard-source-url-tarball"
  | "non-standard-source-file"
  | "non-standard-source-workspace-link"
  | "integrity-missing"
  | "integrity-malformed"
  | "install-script-new-dependency"
  | "vulnerability-critical"
  | "vulnerability-high"
  | "vulnerability-moderate"
  | "vulnerability-low"
  | "vulnerability-audit-unavailable";

/** "block"=이 발견만으로 checkpoint를 BLOCK, "human_review"=HUMAN_REVIEW_REQUIRED로 판정,
 *  "info"=참고용(verdict에 영향 없음, 예: moderate/low 취약점). */
export type DependencyFindingSeverity = "block" | "human_review" | "info";

export interface DependencyFinding {
  /** POSIX 상대경로(package.json 또는 package-lock.json). */
  file: string;
  packageName?: string;
  kind: DependencyFindingKind;
  severity: DependencyFindingSeverity;
  detail: string;
}

export type DependencyScanVerdict = "PASS" | "BLOCK" | "HUMAN_REVIEW_REQUIRED";

export interface DependencyScanResult {
  verdict: DependencyScanVerdict;
  findings: DependencyFinding[];
}

// =========================================================
// 순수 파싱/판정 함수 — 파일시스템 접근 없음(단위 테스트하기 쉽게 분리).
// =========================================================

interface LockPackageEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  hasInstallScript?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface ParsedLockfile {
  lockfileVersion: number;
  packages: Record<string, LockPackageEntry>;
}

interface ParsedManifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

export function parseLockfileJson(content: string): { ok: true; data: ParsedLockfile } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { ok: false, reason: "package-lock.json JSON 파싱 실패" };
  }
  if (!json || typeof json !== "object") return { ok: false, reason: "package-lock.json 형식이 아님" };
  const obj = json as Record<string, unknown>;
  if (typeof obj.lockfileVersion !== "number" || obj.lockfileVersion < 2) {
    return {
      ok: false,
      reason: `지원하지 않는 lockfileVersion(${String(obj.lockfileVersion)}) — lockfileVersion 2 이상("packages" 형식)만 지원합니다.`,
    };
  }
  if (!obj.packages || typeof obj.packages !== "object") {
    return { ok: false, reason: "package-lock.json에 packages 필드가 없음" };
  }
  return { ok: true, data: { lockfileVersion: obj.lockfileVersion, packages: obj.packages as Record<string, LockPackageEntry> } };
}

export function parseManifestJson(content: string): { ok: true; data: ParsedManifest } | { ok: false; reason: string } {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { ok: false, reason: "package.json JSON 파싱 실패" };
  }
  if (!json || typeof json !== "object") return { ok: false, reason: "package.json 형식이 아님" };
  const obj = json as Record<string, unknown>;
  const dependencies = (obj.dependencies && typeof obj.dependencies === "object" ? obj.dependencies : {}) as Record<string, string>;
  const devDependencies = (obj.devDependencies && typeof obj.devDependencies === "object" ? obj.devDependencies : {}) as Record<
    string,
    string
  >;
  return { ok: true, data: { dependencies, devDependencies } };
}

function depsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  if (ak.length !== bk.length) return false;
  return ak.every((k, i) => k === bk[i] && a[k] === b[k]);
}

/** package.json의 dependencies/devDependencies가 lockfile root package("") 엔트리와
 *  정확히 일치하는지 검증한다 — npm lockfileVersion 2/3의 packages[""]는 항상 package.json의
 *  dependencies/devDependencies를 그대로 미러링한다(공식 동작). 불일치는 lockfile이 manifest
 *  변경 이후 재생성되지 않았거나(예: npm install 없이 수동 편집) lockfile이 변조됐을 가능성을
 *  뜻하므로 deterministic하게 BLOCK한다. */
export function checkManifestLockfileConsistency(manifest: ParsedManifest, lock: ParsedLockfile): DependencyFinding[] {
  const findings: DependencyFinding[] = [];
  const root = lock.packages[""];
  if (!root) {
    findings.push({
      file: LOCKFILE_BASENAME,
      kind: "manifest-lockfile-mismatch",
      severity: "block",
      detail: 'lockfile에 root package("") 엔트리가 없어 package.json과 대조할 수 없음',
    });
    return findings;
  }
  if (!depsEqual(manifest.dependencies, root.dependencies ?? {})) {
    findings.push({
      file: LOCKFILE_BASENAME,
      kind: "manifest-lockfile-mismatch",
      severity: "block",
      detail: "package.json dependencies와 lockfile root dependencies가 일치하지 않음(lockfile이 최신 상태가 아닐 수 있음)",
    });
  }
  if (!depsEqual(manifest.devDependencies, root.devDependencies ?? {})) {
    findings.push({
      file: LOCKFILE_BASENAME,
      kind: "manifest-lockfile-mismatch",
      severity: "block",
      detail: "package.json devDependencies와 lockfile root devDependencies가 일치하지 않음(lockfile이 최신 상태가 아닐 수 있음)",
    });
  }
  return findings;
}

function isGitSource(resolved: string): boolean {
  return /^(git\+[a-z]+:\/\/|git:\/\/|github:)/i.test(resolved);
}
function isInsecureGitTransport(resolved: string): boolean {
  return /^git:\/\//i.test(resolved) || /^git\+http:\/\//i.test(resolved);
}

/** lockfile package 엔트리 하나의 설치 출처(resolved)를 분류한다. 표준(https 공식 registry)
 *  출처는 null(문제 없음)을 반환하고, git/url/file/link 등 비표준 출처나 http 평문 출처는
 *  finding으로 분류해 반환한다. root("")나 link(workspace) 엔트리는 각각 별도 처리한다. */
export function classifyPackageSource(
  key: string,
  entry: LockPackageEntry
): { kind: DependencyFindingKind; severity: DependencyFindingSeverity; detail: string } | null {
  if (key === "") return null;
  if (entry.link === true) {
    return {
      kind: "non-standard-source-workspace-link",
      severity: "human_review",
      detail: `${key}: workspace/local link 의존성(레지스트리를 거치지 않고 로컬 경로를 직접 참조함)`,
    };
  }
  const resolved = entry.resolved;
  if (resolved === undefined) return null; // bundled 등 — checkIntegrity에서 별도 처리.

  if (isGitSource(resolved)) {
    if (isInsecureGitTransport(resolved)) {
      return {
        kind: "insecure-source-http",
        severity: "block",
        detail: `${key}: 암호화되지 않은 git 전송(${resolved.split("://")[0]}://) — 중간자 공격으로 내용이 바뀔 수 있음`,
      };
    }
    const fragment = resolved.split("#")[1] ?? "";
    const pinned = FULL_COMMIT_SHA.test(fragment);
    return pinned
      ? {
          kind: "non-standard-source-git-pinned",
          severity: "human_review",
          detail: `${key}: git 소스(커밋 SHA로 고정됨) — 레지스트리 게시 검증을 거치지 않음`,
        }
      : {
          kind: "non-standard-source-git-unpinned",
          severity: "block",
          detail: `${key}: git 소스가 고정된 커밋 SHA를 참조하지 않음(브랜치/태그 등 가변 참조) — 참조 대상이 이후에도 바뀔 수 있음`,
        };
  }
  if (/^file:/i.test(resolved)) {
    return { kind: "non-standard-source-file", severity: "human_review", detail: `${key}: 로컬 file: 소스(레지스트리를 거치지 않음)` };
  }
  if (/^http:\/\//i.test(resolved)) {
    return {
      kind: "insecure-source-http",
      severity: "block",
      detail: `${key}: 암호화되지 않은 http:// 소스 — 중간자 공격으로 내용이 바뀔 수 있음`,
    };
  }
  if (/^https:\/\//i.test(resolved)) {
    let host = "";
    try {
      host = new URL(resolved).host;
    } catch {
      return { kind: "non-standard-source-url-tarball", severity: "human_review", detail: `${key}: resolved URL을 파싱할 수 없음(${resolved})` };
    }
    if (!TRUSTED_REGISTRY_HOSTS.has(host)) {
      return {
        kind: "non-standard-source-url-tarball",
        severity: "human_review",
        detail: `${key}: 신뢰된 registry(${[...TRUSTED_REGISTRY_HOSTS].join(", ")}) 밖의 tarball URL(host=${host})`,
      };
    }
    return null;
  }
  return { kind: "non-standard-source-url-tarball", severity: "human_review", detail: `${key}: 알 수 없는 형식의 resolved 소스(${resolved})` };
}

/** integrity 필드 유무/형식을 검증한다. git/file 소스는 npm이 integrity를 기록하지 않으므로
 *  대상에서 제외한다(classifyPackageSource가 그 위험은 이미 별도로 분류함). */
export function checkIntegrity(key: string, entry: LockPackageEntry): DependencyFinding | null {
  if (key === "" || entry.link === true) return null;
  const resolved = entry.resolved;
  if (resolved === undefined) {
    return {
      file: LOCKFILE_BASENAME,
      packageName: key,
      kind: "integrity-missing",
      severity: "human_review",
      detail: `${key}: resolved 정보가 없어 설치 출처를 확인할 수 없음(bundled dependency 등 가능) — 사람 확인 필요`,
    };
  }
  if (isGitSource(resolved) || /^file:/i.test(resolved)) return null;
  if (!entry.integrity) {
    return {
      file: LOCKFILE_BASENAME,
      packageName: key,
      kind: "integrity-missing",
      severity: "block",
      detail: `${key}: integrity 필드 없음 — 무결성(체크섬) 검증 불가`,
    };
  }
  if (!INTEGRITY_PATTERN.test(entry.integrity)) {
    return {
      file: LOCKFILE_BASENAME,
      packageName: key,
      kind: "integrity-malformed",
      severity: "block",
      detail: `${key}: integrity 값 형식이 올바르지 않음(sha1/sha256/sha512-<base64> 형식이 아님)`,
    };
  }
  return null;
}

/** 이전(HEAD) lockfile 대비 새로 hasInstallScript:true가 된(=새로 추가됐거나 새로 install
 *  script를 갖게 된) 패키지만 골라낸다 — 이미 기존에 있던 install-script 패키지를 매 commit마다
 *  다시 flag하지 않아 정상 dependency 과잉 차단을 피한다. */
export function findNewInstallScriptPackages(oldLock: ParsedLockfile | null, newLock: ParsedLockfile): string[] {
  const oldHad = new Set<string>();
  if (oldLock) {
    for (const [key, entry] of Object.entries(oldLock.packages)) {
      if (key !== "" && entry.hasInstallScript) oldHad.add(key);
    }
  }
  const result: string[] = [];
  for (const [key, entry] of Object.entries(newLock.packages)) {
    if (key === "") continue;
    if (entry.hasInstallScript && !oldHad.has(key)) result.push(key);
  }
  return result;
}

function packageNameFromLockKey(key: string): string {
  const idx = key.lastIndexOf("node_modules/");
  return idx === -1 ? key : key.slice(idx + "node_modules/".length);
}

// =========================================================
// Vulnerability audit — 공식 npm audit(JSON) 결과를 신뢰 가능한 데이터 경로로 우선한다.
// =========================================================

export interface VulnerabilityEntry {
  name: string;
  severity: "critical" | "high" | "moderate" | "low";
}

export type VulnerabilityAuditOutcome = { ok: true; entries: VulnerabilityEntry[] } | { ok: false; reason: string };

/** cwd(lockfile이 있는 디렉터리)를 대상으로 취약점 정보를 조회한다. 실제 운용 기본 구현은
 *  네트워크(레지스트리 advisory DB)를 쓴다 — 테스트는 이 함수를 쓰지 않고 fixture 함수를
 *  주입한다(scanChangesForDependencyRisk의 opts.vulnerabilityAuditSource). */
export type VulnerabilityAuditSource = (cwd: string) => VulnerabilityAuditOutcome;

/** 공식 `npm audit --json`을 실행해 결과를 파싱한다. 어떤 이유로든(네트워크 오류/timeout/
 *  파싱 실패) 신뢰 가능한 결과를 얻지 못하면 반드시 { ok: false }를 반환한다 — 호출부가
 *  이를 조용한 PASS로 취급하지 않고 HUMAN_REVIEW_REQUIRED로 승격한다(요구사항: audit
 *  오류/timeout을 PASS로 처리하지 않음). 이 함수 자체는 `npm audit fix`나 dependency
 *  upgrade를 전혀 수행하지 않는다(읽기 전용 조회). */
export const npmAuditVulnerabilitySource: VulnerabilityAuditSource = (cwd: string) => {
  const res = spawnSync("npm", ["audit", "--json"], { cwd, shell: false, encoding: "utf-8", timeout: 60_000 });
  if (res.error) return { ok: false, reason: `npm audit 실행 실패: ${res.error.message}` };
  const raw = res.stdout || "";
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "npm audit --json 출력 파싱 실패" };
  }
  const obj = json as Record<string, unknown>;
  const vulns = obj.vulnerabilities;
  if (!vulns || typeof vulns !== "object") return { ok: false, reason: "npm audit 응답에 vulnerabilities 필드가 없음" };
  const entries: VulnerabilityEntry[] = [];
  for (const [name, v] of Object.entries(vulns as Record<string, unknown>)) {
    const severity = (v as { severity?: unknown } | null)?.severity;
    if (severity === "critical" || severity === "high" || severity === "moderate" || severity === "low") {
      entries.push({ name, severity });
    }
  }
  return { ok: true, entries };
};

function vulnerabilityFindingKind(severity: VulnerabilityEntry["severity"]): DependencyFindingKind {
  switch (severity) {
    case "critical":
      return "vulnerability-critical";
    case "high":
      return "vulnerability-high";
    case "moderate":
      return "vulnerability-moderate";
    default:
      return "vulnerability-low";
  }
}

function readHeadFileContent(cwd: string, relPath: string): string | null {
  const res = spawnSync("git", ["show", `HEAD:${relPath}`], { cwd, shell: false, encoding: "utf-8" });
  if (res.status !== 0) return null; // HEAD에 없음(신규 파일) 또는 HEAD 자체가 없음.
  return res.stdout;
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

// =========================================================
// checkpoint.ts가 실제로 쓰는 진입점.
// =========================================================

export interface DependencyScanOptions {
  vulnerabilityAuditSource?: VulnerabilityAuditSource;
}

/**
 * checkpoint 대상 변경(WorkingTreeChange[]) 중 package.json/package-lock.json이 있는
 * 디렉터리만 골라 스캔한다(요구사항: dependency manifest/lockfile 변경 시에만 scanner 실행).
 * 해당 변경이 없으면 즉시 PASS(파일시스템/네트워크 접근 없음).
 *
 * 디렉터리별로: manifest/lockfile 일관성 → 각 lockfile package의 source 분류(insecure http/
 * git/url/file/workspace) → integrity 검증 → 새로 추가된 install-script 패키지 탐지 →
 * (vulnerabilityAuditSource가 주어졌다면) 취약점 조회 순으로 검사한다. 하나라도 BLOCK급
 * finding이 있으면 verdict=BLOCK, 없지만 human_review급이 있으면 HUMAN_REVIEW_REQUIRED,
 * 둘 다 없으면 PASS다.
 */
export function scanChangesForDependencyRisk(
  changes: WorkingTreeChange[],
  cwd: string,
  opts: DependencyScanOptions = {}
): DependencyScanResult {
  const relevantDirs = new Set<string>();
  for (const c of changes) {
    if (c.status === "deleted") continue;
    const base = c.path.split("/").pop();
    if (base === MANIFEST_BASENAME || base === LOCKFILE_BASENAME) {
      relevantDirs.add(dirOf(c.path));
    }
  }
  if (relevantDirs.size === 0) return { verdict: "PASS", findings: [] };

  const findings: DependencyFinding[] = [];

  for (const dir of relevantDirs) {
    const manifestRel = dir ? `${dir}/${MANIFEST_BASENAME}` : MANIFEST_BASENAME;
    const lockRel = dir ? `${dir}/${LOCKFILE_BASENAME}` : LOCKFILE_BASENAME;

    let manifestRaw: string;
    try {
      manifestRaw = readFileSync(join(cwd, ...manifestRel.split("/")), "utf-8");
    } catch {
      findings.push({ file: manifestRel, kind: "manifest-parse-error", severity: "block", detail: "package.json을 읽을 수 없음" });
      continue;
    }

    let lockRaw: string;
    try {
      lockRaw = readFileSync(join(cwd, ...lockRel.split("/")), "utf-8");
    } catch {
      findings.push({
        file: lockRel,
        kind: "lockfile-missing",
        severity: "block",
        detail: "package.json 변경과 함께 있어야 할 package-lock.json이 없음 — lockfile 없이는 의존성 무결성/출처를 검증할 수 없음",
      });
      continue;
    }

    const manifestParsed = parseManifestJson(manifestRaw);
    if (!manifestParsed.ok) {
      findings.push({ file: manifestRel, kind: "manifest-parse-error", severity: "block", detail: manifestParsed.reason });
      continue;
    }
    const lockParsed = parseLockfileJson(lockRaw);
    if (!lockParsed.ok) {
      findings.push({ file: lockRel, kind: "lockfile-parse-error", severity: "block", detail: lockParsed.reason });
      continue;
    }

    findings.push(...checkManifestLockfileConsistency(manifestParsed.data, lockParsed.data).map((f) => ({ ...f, file: lockRel })));

    for (const [key, entry] of Object.entries(lockParsed.data.packages)) {
      const srcFinding = classifyPackageSource(key, entry);
      if (srcFinding) findings.push({ file: lockRel, packageName: key, ...srcFinding });
      const integrityFinding = checkIntegrity(key, entry);
      if (integrityFinding) findings.push(integrityFinding);
    }

    const oldLockRaw = readHeadFileContent(cwd, lockRel);
    const oldLockParsed = oldLockRaw !== null ? parseLockfileJson(oldLockRaw) : null;
    const oldLock = oldLockParsed && oldLockParsed.ok ? oldLockParsed.data : null;
    for (const pkg of findNewInstallScriptPackages(oldLock, lockParsed.data)) {
      findings.push({
        file: lockRel,
        packageName: pkg,
        kind: "install-script-new-dependency",
        severity: "human_review",
        detail: `${pkg}: 새로 추가됐거나 새로 install script를 갖게 된 의존성에 install/preinstall/postinstall lifecycle script가 있음 — 설치 시 임의 코드가 실행될 수 있음`,
      });
    }

    if (opts.vulnerabilityAuditSource) {
      const dirAbs = dir ? join(cwd, ...dir.split("/")) : cwd;
      const outcome = opts.vulnerabilityAuditSource(dirAbs);
      if (!outcome.ok) {
        findings.push({
          file: lockRel,
          kind: "vulnerability-audit-unavailable",
          severity: "human_review",
          detail: `vulnerability audit 조회 실패 — 오류/timeout을 PASS로 처리하지 않고 사람 확인이 필요한 것으로 판정합니다: ${outcome.reason}`,
        });
      } else {
        const packagesInLockfile = new Set(Object.keys(lockParsed.data.packages).map(packageNameFromLockKey));
        for (const v of outcome.entries) {
          if (!packagesInLockfile.has(v.name)) continue;
          const severity: DependencyFindingSeverity = v.severity === "critical" || v.severity === "high" ? "block" : "info";
          findings.push({
            file: lockRel,
            packageName: v.name,
            kind: vulnerabilityFindingKind(v.severity),
            severity,
            detail: `${v.name}: npm audit ${v.severity} 등급 취약점`,
          });
        }
      }
    }
  }

  const hasBlock = findings.some((f) => f.severity === "block");
  const hasHumanReview = findings.some((f) => f.severity === "human_review");
  const verdict: DependencyScanVerdict = hasBlock ? "BLOCK" : hasHumanReview ? "HUMAN_REVIEW_REQUIRED" : "PASS";
  return { verdict, findings };
}
