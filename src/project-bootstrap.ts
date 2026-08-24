import {
  existsSync,
  statSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  renameSync,
  realpathSync,
  openSync,
  fstatSync,
  fsyncSync,
  closeSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { resolve, join, relative, dirname, isAbsolute, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  evaluateSpecIntake,
  isSafeRelativeSpecRef,
  RESERVED_WINDOWS_DEVICE_NAMES,
  MAX_SPEC_CONTENT_CHARS,
} from "./spec-intake";
import type { HandoffEnvelope, MasterSpecIntake, SpecIntakeRejectReason, SpecStatus, UserApprovalStatus } from "./spec-intake";
import { scanContentForSecrets } from "./secret-scanner";
import { AUTODEV_ROOT } from "./project-context";
import { assessOwnerLiveness } from "./project-lock";
import { sanitizeForLog } from "./logger";
import type { LivenessVerdict } from "./project-lock";

// AutoDev Core 선행 업그레이드 — Safe Project Bootstrap (SI-2).
//
// SI-1(spec-intake.ts)은 "이 Handoff를 받아들일지" 순수하게 판정만 한다(파일시스템/git에
// 전혀 손대지 않음). 이 모듈은 그 판정을 실제로 실행한다 — 새 project root를 안전하게
// 만들고, 검증된 Master Spec을 보존하고, Git baseline을 만든다. 특정 프로젝트(JARVIS/
// MOVAN/BILLION 등) 이름/경로/로직은 이 파일 어디에도 하드코딩하지 않는다 — 항상
// BootstrapTrustedConfig로 명시적으로 주입받는다(project-adapter-loader.ts가 project
// config를 항상 외부에서 주입받는 것과 동일한 원칙).
//
// 신뢰 경계: bootstrapProject()는 evaluateSpecIntake()와 정확히 동일한 rawInput(JSON
// 문자열)을 받는다 — SI-1의 신뢰 경계(§ spec-intake.ts 상단 주석: 문자열이 아니면 아무것도
// 건드리지 않고 즉시 REJECT, JSON.parse 이후에는 항상 순수 데이터)를 그대로 물려받는다.
// evaluateSpecIntake()가 REJECT를 반환하면 이 함수는 파일시스템에 단 한 번도 접근하지
// 않는다. REJECT가 아닌 결정이 나온 뒤에만(즉 이 정확히 동일한 rawInput 문자열에 대해
// SI-1의 모든 게이트가 이미 통과한 뒤에만) rawInput을 다시 JSON.parse해 실제 필드 값을
// 꺼낸다(parseTrustedEnvelope) — SI-1의 검증 규칙(SPEC_NOT_APPROVED/해시 대조/unknown
// field 등)을 다시 구현하지 않는다(재사용, 복제 금지).
//
// bootstrapBaseDir(새 project root를 만들 위치)와 specContentRefSourceRoot(specContentRef를
// resolve할 위치)는 항상 caller(trusted intake pipeline)가 명시적으로 주입한다 — Handoff/Spec
// payload 어디에도 이 두 경로를 지정하는 필드가 없으므로, 외부 payload가 임의의 절대
// filesystem 위치를 지정할 방법이 구조적으로 없다.
//
// Core hard rule: bootstrapBaseDir는 AutoDev Core 저장소(AUTODEV_ROOT) 내부/외부로 서로
// 중첩될 수 없다(§ validateBootstrapConfig) — 이 저장소 안에 새 project를 만들거나, 이
// 저장소를 삼키는 위치를 base로 잡는 시도 둘 다 config 검증 단계에서 즉시 BLOCK된다.

// ---------------------------------------------------------------------------
// 데이터 계약
// ---------------------------------------------------------------------------

export interface BootstrapTrustedConfig {
  /** 새 project root를 만들 trusted base directory. 반드시 존재하는 디렉터리여야 하며,
   *  AutoDev Core 저장소(AUTODEV_ROOT)와 중첩되지 않아야 한다. Handoff/Spec payload에서
   *  파생되지 않는다 — 항상 caller가 이 값을 직접 지정한다. */
  bootstrapBaseDir: string;
  /** decision이 ACCEPT_PENDING_CONTENT_VERIFICATION일 때만 필요 — specContentRef를 resolve할
   *  trusted intake/package root. 지정하지 않으면 그 경우 즉시 BLOCK(MISSING_SOURCE_ROOT)한다
   *  (추측으로 root를 고르지 않는다). Handoff/Spec payload에서 파생되지 않는다. */
  specContentRefSourceRoot?: string;
  /** 새로 만든 repo의 baseline commit author identity. 지정하지 않으면 ambient(global) git
   *  설정을 그대로 쓴다 — 어느 쪽이든 이 모듈이 --author 등으로 검증/hook을 우회하지 않는다.
   *  git identity가 없어 commit이 안전하게 불가능하면 성공으로 위장하지 않고 WAITING_HUMAN을
   *  반환한다. */
  commitIdentity?: { name: string; email: string };
}

export const BOOTSTRAP_STATE_SCHEMA_VERSION = 1 as const;

export type BootstrapStage = "PROJECT_ROOT_CREATED" | "SPEC_PRESERVED" | "GIT_INITIALIZED" | "BASELINE_READY" | "COMPLETED";

const BOOTSTRAP_STAGE_ORDER: readonly BootstrapStage[] = [
  "PROJECT_ROOT_CREATED",
  "SPEC_PRESERVED",
  "GIT_INITIALIZED",
  "BASELINE_READY",
  "COMPLETED",
];

/** 동일 Bootstrap 요청을 식별하는 최소 identity — handoffId/projectId/specVersion/
 *  specIntegrity 넷 모두 같아야 "같은 요청"이다(§ 요구사항 6). */
export interface BootstrapRequestIdentity {
  handoffId: string;
  projectId: string;
  specVersion: string;
  specIntegrityAlgorithm: "sha256" | "sha512";
  specIntegrityHash: string;
}

export interface BootstrapStateFile {
  schemaVersion: typeof BOOTSTRAP_STATE_SCHEMA_VERSION;
  identity: BootstrapRequestIdentity;
  stage: BootstrapStage;
  createdAt: string;
  updatedAt: string;
  /** BASELINE_READY 이상에서만 채워진다. */
  baselineCommitHash?: string;
}

export type BootstrapContentProvenance =
  | { sourceKind: "INLINE" }
  | { sourceKind: "CONTENT_REF"; sourceRef: string };

export interface MasterSpecManifest {
  schemaVersion: 1;
  projectId: string;
  projectName: string;
  specVersion: string;
  handoffId: string;
  specIntegrity: { algorithm: "sha256" | "sha512"; hash: string };
  specStatus: SpecStatus;
  userApproval: UserApprovalStatus;
  reviewerGate: { critical: number; high: number };
  unresolvedCriticalCount: number;
  contradictionCount: number;
  bootstrapProvenance: BootstrapContentProvenance & { bootstrappedAt: string };
  /** spec.md로 실제 저장된 뒤 다시 계산한 digest — 이후 조용한 변조/손상을 감지하는 근거. */
  storedContentDigest: { algorithm: "sha256" | "sha512"; hash: string };
}

export type BootstrapBlockedCode =
  | "INVALID_CONFIG"
  | "MISSING_SOURCE_ROOT"
  | "SPEC_CONTENT_REF_NOT_FOUND"
  | "SPEC_CONTENT_REF_ESCAPE"
  | "SPEC_CONTENT_REF_NOT_REGULAR_FILE"
  | "SPEC_CONTENT_REF_TOO_LARGE"
  | "SPEC_CONTENT_REF_READ_FAILED"
  | "SPEC_CONTENT_REF_HASH_MISMATCH"
  | "SPEC_CONTENT_REF_SECRET_DETECTED"
  | "PROJECT_ROOT_ESCAPE"
  | "PROJECT_ROOT_RESERVED_NAME"
  | "PROJECT_ROOT_CREATE_FAILED"
  | "CORRUPT_HANDOFF_INDEX"
  | "CONCURRENT_BOOTSTRAP_IN_PROGRESS"
  | "BOOTSTRAP_LOCK_UNAVAILABLE";

export type BootstrapCollisionReason = "NO_BOOTSTRAP_METADATA" | "CORRUPT_BOOTSTRAP_METADATA";

export type BootstrapOutcome =
  | { status: "REJECTED"; reasons: SpecIntakeRejectReason[] }
  | { status: "BLOCKED"; code: BootstrapBlockedCode; detail: string }
  | { status: "COLLISION"; reason: BootstrapCollisionReason; detail: string; existingProjectRoot: string }
  | {
      status: "CONFLICT";
      detail: string;
      existingIdentity: BootstrapRequestIdentity;
      requestedIdentity: BootstrapRequestIdentity;
    }
  | { status: "ALREADY_BOOTSTRAPPED"; projectRoot: string; baselineCommitHash?: string }
  | { status: "WAITING_HUMAN"; projectRoot: string; stage: BootstrapStage; detail: string }
  | { status: "COMPLETE"; projectRoot: string; baselineCommitHash: string; masterSpecPath: string; bootstrapStatePath: string };

// ---------------------------------------------------------------------------
// Trusted config 검증
// ---------------------------------------------------------------------------

/**
 * childReal이 parentReal과 같거나 그 내부인지 판정한다 — realpath 두 값을 그대로(대소문자
 * 정규화 없이) `path.relative()`로 비교한다. GPT Independent Reviewer 지적(SI-2 REVISE
 * 1회차): 이전 구현은 두 realpath를 무조건 `toLowerCase()`한 뒤 비교했는데, 이는
 * case-sensitive 파일시스템에서 대소문자만 다른 완전히 다른 디렉터리(예: "/tmp/Root"와
 * "/tmp/root")를 같은 경로로 오판할 수 있었다. `path.relative()`는 각 플랫폼의 `path`
 * 구현(win32/posix)이 이미 그 플랫폼에 맞는 의미로 두 경로를 비교하므로, 대소문자를
 * 인위적으로 정규화하지 않아도 Windows(대소문자 구분 없음)에서는 여전히 정확하고
 * case-sensitive 플랫폼에서도 서로 다른 대소문자 경로를 다른 경로로 정확히 구분한다.
 */
export function isRealPathWithin(childReal: string, parentReal: string): boolean {
  if (childReal === parentReal) return true;
  const rel = relative(parentReal, childReal);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * SI-3.5(Trusted Filesystem / TOCTOU Security Boundary Closure — Option A, Portable Core
 * Boundary, § `.claude/rules/filesystem-trust-model.md`) — `startAbsPath`부터
 * `rootReal`(이미 realpath로 canonicalize된 신뢰 root)까지의 전체 조상 체인 중 어떤
 * 구성요소도 symlink/junction이 아님을 확인한다. 여기서 "symlink/junction"은 정확히
 * Node의 `lstatSync().isSymbolicLink()`가 참으로 보고하는 것(POSIX symlink, Windows
 * symlink/junction — mount point 유형 reparse point)만을 뜻한다 — Windows의 다른 필터
 * 드라이버 고유 reparse tag(예: cloud placeholder, dedup) 전부를 이 API가 포괄한다고
 * 주장하지 않는다("portable Node.js로 완전한 kernel-level TOCTOU 제거"라고 근거 없이
 * 주장하지 않는다는 이 Task의 원칙과 동일하게, 이 함수의 보장 범위도 정확히 명시한다).
 *
 * 기존 `isRealPathWithin()` containment 판정은 "resolve 결과가 root 내부에 있는가"만
 * 본다 — root 내부의 다른 위치를 가리키는 symlink는(escape가 아니므로) 그 판정을
 * 통과한다. 하지만 그런 symlink는 검증 이후 언제든 다시 다른 대상을 가리키도록
 * 재설정될 수 있어, 검증 시점과 실제 I/O 시점 사이에 완전히 다른 대상으로 바뀔 수
 * 있다(§ threat model 문서 "ancestor directory symlink swap"). 이 함수는 "root 밖을
 * 가리키지 않는 symlink"조차 구조적으로 거부해 그 위험 자체를 원천적으로 없앤다.
 *
 * `rootReal`이 이미 존재를 전제로 하므로 각 조상 레벨의 stop 조건은 문자열 비교가 아니라
 * "그 레벨 자신의 realpath가 rootReal과 같은가"로 판정한다 — 호출부가 매번 별도의
 * "정규화 전(raw) root 문자열"을 함께 넘길 필요가 없어(정규화된 root 하나만 알면 충분),
 * 여러 파일이 서로 다른 방식(join/resolve)으로 만든 경로에도 안전하게 동작한다. 아직
 * 존재하지 않는 조상(정상적으로 아직 만들어지지 않은 경로 — 예: 새로 쓰려는 파일)은
 * symlink일 수 없으므로 통과시키고 계속 위로 올라간다.
 *
 * SI-3.5 bounded GPT Independent Review 지적(HIGH) — 이전 구현은 1024회 안에
 * `rootReal`에 도달하지 못하면(비정상적으로 깊은 경로, 또는 realpath 계산이 실제 root와
 * 끝내 일치하지 않는 경우) 그대로 반복문을 빠져나가 지금까지 확인한 조상만으로 조용히
 * `{ok:true}`를 반환했다 — root 근처(1025번째 이상)의 symlink를 놓치는 fail-open이었다.
 * 이제 `reachedRoot`를 명시적으로 추적해, 상한 안에 root에 도달하지 못하면 무조건
 * `{ok:false}`로 fail-closed한다(대상을 신뢰하지 못했다는 뜻 — "symlink가 없었다"고
 * 잘못 보고하지 않는다).
 *
 * `testDeps.realpathSyncImpl`(SI-3.5 bounded GPT Independent Review 2차 MEDIUM 지적) —
 * 위 1024-경계 fail-closed 동작 자체를 회귀 테스트하려면 실제로 1024단계 깊이의 디렉터리가
 * 필요한데, 이 환경(Windows, 기본 MAX_PATH=260, long path opt-in 없음)에서는 그런 경로를
 * 실제로 만드는 것 자체가 별개의 이유(경로 길이 제한)로 실패한다. `realpathSync`만
 * 주입 가능하게 분리하면(실제 운용 코드는 이 매개변수를 전혀 쓰지 않고 항상 진짜
 * `realpathSync`를 쓴다 — production 동작 변경 없음) 테스트가 순수 문자열 경로(디스크에
 * 존재할 필요 없음)로 "1024번째에 정확히 root 도달 성공"과 "1024회 소진 후 fail-closed"
 * 경계를 직접, 결정적으로 재현할 수 있다.
 *
 * `testDeps.lstatSyncImpl`(SI-3.3~3.5 4-chunk 최종 리뷰 지적, HIGH) — 아래 lstat 루프는
 * ENOENT(정말로 아직 만들어지지 않은 조상)만 통과시키고 EACCES/EPERM/EIO 등 다른 오류는
 * fail-closed로 거부한다. 이 분기를 실제 권한 거부 디렉터리를 만들지 않고 결정적으로
 * 회귀 테스트하기 위해 `lstatSync`도 동일한 방식으로 주입 가능하게 분리한다(운용 코드는
 * 이 매개변수를 쓰지 않는다).
 */
export function assertNoSymlinkInChain(
  startAbsPath: string,
  rootReal: string,
  testDeps: { realpathSyncImpl?: (p: string) => string; lstatSyncImpl?: (p: string) => { isSymbolicLink(): boolean } } = {}
): { ok: true } | { ok: false; detail: string } {
  const realpathImpl = testDeps.realpathSyncImpl ?? realpathSync;
  const lstatImpl = testDeps.lstatSyncImpl ?? lstatSync;
  const resolvedStart = resolve(startAbsPath);
  const resolvedRoot = resolve(rootReal);
  const checked: string[] = [];
  let current = resolvedStart;
  let reachedRoot = false;
  // 비정상적으로 깊은 경로/무한루프 방지를 위한 안전 상한 — 일반적인 파일시스템 깊이를
  // 크게 웃도는 값이라 정상 사용에는 전혀 영향이 없다. 이 상한 안에 root에 도달하지
  // 못하면(아래) fail-closed로 거부한다 — 상한 자체가 fail-open의 원인이 되지 않는다.
  for (let i = 0; i < 1024; i++) {
    checked.push(current);
    let currentReal: string | undefined;
    try {
      currentReal = realpathImpl(current);
    } catch {
      currentReal = undefined;
    }
    if (currentReal !== undefined && currentReal === resolvedRoot) {
      reachedRoot = true;
      break;
    }
    const parent = dirname(current);
    if (parent === current) {
      return {
        ok: false,
        detail: `${resolvedStart}에서 신뢰 root(${resolvedRoot})까지 도달하지 못하고 파일시스템 최상위에 도달했습니다 — 대상이 신뢰 root 하위 경로가 아닙니다.`,
      };
    }
    current = parent;
  }
  if (!reachedRoot) {
    return {
      ok: false,
      detail: `${resolvedStart}에서 신뢰 root(${resolvedRoot})까지 1024단계 안에 도달하지 못했습니다 — 비정상적으로 깊은 경로이거나 root를 확인할 수 없어 fail-closed로 거부합니다.`,
    };
  }
  for (const seg of checked) {
    let st;
    try {
      st = lstatImpl(seg);
    } catch (e) {
      // SI-3.5 4-chunk final review 지적(HIGH) — 이전에는 모든 예외(ENOENT뿐 아니라
      // EACCES/EPERM/EIO 등)를 "아직 존재하지 않는 조상"으로 간주해 조용히 건너뛰었다.
      // 하지만 EACCES/EPERM/EIO는 그 경로가 존재하지 않는다는 뜻이 아니다 — 단지 그
      // 경로가 symlink인지 확인하지 못했을 뿐이다. 확인하지 못한 조상을 "symlink가
      // 아니다"로 조용히 취급하는 것은 fail-open이다. ENOENT(정말로 아직 만들어지지
      // 않은 정상 상태)만 통과시키고, 그 외 모든 오류는 "이 조상을 신뢰할 수 있게
      // 확인하지 못했다"는 뜻으로 fail-closed 거부한다.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      return {
        ok: false,
        detail: `${seg} 확인 실패(${(e as NodeJS.ErrnoException).code ?? "UNKNOWN"}) — symlink 여부를 신뢰할 수 있게 확인하지 못해 거부합니다: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        detail: `${seg}가 symlink/junction입니다 — 신뢰 root(${resolvedRoot})부터 대상까지 어떤 구성요소도 symlink일 수 없습니다.`,
      };
    }
  }
  return { ok: true };
}

/**
 * bootstrapBaseDir가 AutoDev Core 저장소(AUTODEV_ROOT)와 어느 방향으로도 중첩되지 않는지
 * 확인한다 — "AutoDev Core repository 내부 중첩 생성 금지"(§ 요구사항 4/10/17)의 단일
 * 판정 지점이다. realpath 기준으로 비교해 symlink로 우회하는 것도 막는다. 이 함수가 만나는
 * 모든 filesystem 호출은 예외를 던지지 않고 명시적인 { ok:false } 결과로 변환한다(GPT
 * Independent Reviewer 지적 — 권한 오류/경합 상태에서 예외가 그대로 밖으로 새어나가 호출자를
 * crash시키지 않게 한다).
 */
function validateBootstrapConfig(config: BootstrapTrustedConfig): { ok: true; baseDirReal: string } | { ok: false; reason: string } {
  if (!config || typeof config !== "object") {
    return { ok: false, reason: "BootstrapTrustedConfig가 비어있거나 객체가 아닙니다." };
  }
  if (typeof config.bootstrapBaseDir !== "string" || config.bootstrapBaseDir.trim().length === 0) {
    return { ok: false, reason: "bootstrapBaseDir가 지정되지 않았습니다." };
  }
  const resolvedBase = resolve(config.bootstrapBaseDir);
  if (!existsSync(resolvedBase)) {
    return { ok: false, reason: `bootstrapBaseDir가 존재하지 않는 경로입니다: ${resolvedBase}` };
  }
  let baseStat;
  try {
    baseStat = statSync(resolvedBase);
  } catch (e) {
    return { ok: false, reason: `bootstrapBaseDir 확인 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!baseStat.isDirectory()) {
    return { ok: false, reason: `bootstrapBaseDir가 디렉터리가 아닙니다: ${resolvedBase}` };
  }
  let baseReal: string;
  let autodevRootReal: string;
  try {
    baseReal = realpathSync(resolvedBase);
    autodevRootReal = realpathSync(AUTODEV_ROOT);
  } catch (e) {
    return { ok: false, reason: `bootstrapBaseDir/AutoDev Core 저장소 realpath 확인 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (isRealPathWithin(baseReal, autodevRootReal) || isRealPathWithin(autodevRootReal, baseReal)) {
    return {
      ok: false,
      reason: "bootstrapBaseDir가 AutoDev Core 저장소(AUTODEV_ROOT)와 중첩됩니다 — 어떤 방향으로도 허용되지 않습니다.",
    };
  }
  if (config.specContentRefSourceRoot !== undefined) {
    if (typeof config.specContentRefSourceRoot !== "string" || config.specContentRefSourceRoot.trim().length === 0) {
      return { ok: false, reason: "specContentRefSourceRoot가 지정됐지만 비어있습니다." };
    }
    const resolvedSrc = resolve(config.specContentRefSourceRoot);
    let srcStat;
    try {
      srcStat = existsSync(resolvedSrc) ? statSync(resolvedSrc) : undefined;
    } catch (e) {
      return { ok: false, reason: `specContentRefSourceRoot 확인 실패: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!srcStat || !srcStat.isDirectory()) {
      return { ok: false, reason: `specContentRefSourceRoot가 존재하지 않거나 디렉터리가 아닙니다: ${resolvedSrc}` };
    }
  }
  if (config.commitIdentity !== undefined) {
    const ci = config.commitIdentity;
    if (typeof ci.name !== "string" || ci.name.trim().length === 0 || typeof ci.email !== "string" || ci.email.trim().length === 0) {
      return { ok: false, reason: "commitIdentity가 지정됐지만 name/email이 비어있습니다." };
    }
  }
  return { ok: true, baseDirReal: baseReal };
}

// ---------------------------------------------------------------------------
// specContentRef 실제 파일 검증 (§ 요구사항 3)
// ---------------------------------------------------------------------------

type SpecContentRefVerifyResult = { ok: true; content: string } | { ok: false; code: BootstrapBlockedCode; detail: string };

/**
 * specContentRef를 안전하게 resolve하고 실제 내용을 검증한다:
 *   A) trusted sourceRoot(caller가 명시적으로 지정, payload에서 파생되지 않음) 기준으로만 resolve.
 *   B) SI-1과 동일한 형식 검증(isSafeRelativeSpecRef, 재사용 — 복제 아님)을 defense-in-depth로 재확인.
 *   C) 실제 filesystem 검증 — sourceRoot/대상 둘 다 realpath로 확인하고, 대상의 realpath가
 *      sourceRoot의 realpath 내부에 있는지 검증한다(symlink/junction/reparse point로 root
 *      밖을 가리키면 문자열이 안전해 보여도 이 단계에서 BLOCK된다). 대상이 regular file이
 *      아니면(디렉터리/기타) BLOCK.
 *   D) 실제 내용 검증 — 크기 상한, specIntegrity.algorithm 기준 digest 재계산 후 정확히 일치
 *      확인, secret-scanner.ts로 재검사. 원문은 어떤 결과에도 담기지 않는다.
 */
function verifySpecContentRefFile(
  sourceRoot: string,
  ref: string,
  integrity: { algorithm: "sha256" | "sha512"; hash: string }
): SpecContentRefVerifyResult {
  if (!isSafeRelativeSpecRef(ref)) {
    return { ok: false, code: "SPEC_CONTENT_REF_ESCAPE", detail: "specContentRef 형식이 안전한 상대경로가 아닙니다." };
  }

  const resolvedSourceRoot = resolve(sourceRoot);
  let sourceRootStat;
  try {
    sourceRootStat = existsSync(resolvedSourceRoot) ? statSync(resolvedSourceRoot) : undefined;
  } catch (e) {
    return { ok: false, code: "SPEC_CONTENT_REF_NOT_FOUND", detail: `specContentRefSourceRoot 확인 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!sourceRootStat || !sourceRootStat.isDirectory()) {
    return { ok: false, code: "SPEC_CONTENT_REF_NOT_FOUND", detail: "specContentRefSourceRoot가 존재하지 않거나 디렉터리가 아닙니다." };
  }
  let sourceRootReal: string;
  try {
    sourceRootReal = realpathSync(resolvedSourceRoot);
  } catch (e) {
    return { ok: false, code: "SPEC_CONTENT_REF_NOT_FOUND", detail: `specContentRefSourceRoot realpath 확인 실패: ${e instanceof Error ? e.message : String(e)}` };
  }

  const candidate = resolve(resolvedSourceRoot, ref);
  if (!existsSync(candidate)) {
    return { ok: false, code: "SPEC_CONTENT_REF_NOT_FOUND", detail: "specContentRef가 가리키는 파일이 존재하지 않습니다." };
  }

  let real: string;
  try {
    real = realpathSync(candidate);
  } catch (e) {
    return { ok: false, code: "SPEC_CONTENT_REF_NOT_FOUND", detail: `specContentRef 경로 확인 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
  // GPT Independent Reviewer 지적(SI-2 REVISE 1회차) — 이전에는 두 realpath를 무조건
  // toLowerCase()한 뒤 비교해, case-sensitive 파일시스템에서 대소문자만 다른 완전히 다른
  // 디렉터리를 같은 경로로 오판할 수 있었다. isRealPathWithin()(대소문자 정규화 없음, §
  // validateBootstrapConfig 상단 주석)로 교체한다.
  if (!isRealPathWithin(real, sourceRootReal)) {
    return {
      ok: false,
      code: "SPEC_CONTENT_REF_ESCAPE",
      detail: "specContentRef가 symlink/junction/reparse point를 통해 source root 밖을 가리킵니다.",
    };
  }
  // SI-3.5 — containment(위)만으로는 "source root 내부의 다른 위치를 가리키는 symlink"를
  // 잡지 못한다(§ assertNoSymlinkInChain 상단 주석). ref가 가리키는 경로 체인 중 어느
  // 구성요소도 symlink/junction일 수 없다.
  const chainCheck = assertNoSymlinkInChain(candidate, sourceRootReal);
  if (!chainCheck.ok) {
    return { ok: false, code: "SPEC_CONTENT_REF_ESCAPE", detail: chainCheck.detail };
  }

  // GPT Independent Reviewer 지적(SI-2 REVISE 2~4회차, HIGH, 최종 정리) — 순수 Node.js
  // 동기 API만으로는 open()이 실제로 어떤 객체를 열었는지와 우리가 realpath로 판정한
  // 객체가 "정확히 동일함"을 원자적으로 증명할 방법이 없다(POSIX openat2
  // RESOLVE_BENEATH, Windows CreateFile 이후 GetFinalPathNameByHandle 같은 handle 기준
  // 원자적 조합 API가 Node fs 모듈에 없다 — 이 환경(win32)에서
  // fs.constants.O_NOFOLLOW가 undefined임도 직접 확인했다). 아주 정교하게 매 syscall
  // 사이마다 중간 디렉터리를 symlink/junction으로 교체·원복하는 공격자를 상대로는 어떤
  // 조합의 재검증(sandwich)도 이론적으로 완전히 막지 못한다 — 이는 네이티브 addon 없이는
  // 해결할 수 없는 플랫폼/런타임 자체의 한계이며, 이 저장소의 Core hard rule인 Safe
  // Executor(safe-executor.ts resolveSafe/executeReadFiles)도 동일한 유형의 gap을 이미
  // 갖고 있다(containment 판정에는 realpath를 쓰지만 실제 read는 별도의, 나중의
  // readFileSync(v.abs)로 미해석 경로를 다시 연다 — 이 모듈보다 더 넓은 gap).
  //
  // 그래도 이 함수는 실현 가능한 최대치를 모두 적용한다:
  //   1) open 이전 realpath 1회로 containment 판정.
  //   2) 그 real을 그대로 열어 fd 하나로 fstat(regular-file/크기)+read를 수행 — 검증에 쓴
  //      경로와 실제로 읽는 객체가 분리되지 않게 한다(Safe Executor보다 엄격).
  //   3) open 직후 candidate를 다시 한번 독립적으로 realpath 재조회해 여전히 동일한
  //      canonical path(=여전히 source root 내부)로 resolve되는지 확인하고, 그 결과의
  //      stat이 fd의 fstat(dev/ino)과 일치하는지도 확인한다(sandwich) — open 앞뒤로
  //      candidate가 가리키는 대상이 바뀌지 않았다는 최선의(그러나 완전히 원자적이지는
  //      않은) 증거를 남긴다.
  //   4) bootstrapProject()의 projectId 단위 exclusive lock(§ acquireBootstrapLock)이 이미
  //      "합법적인 동시 caller"가 서로 겹치는 시나리오는 완전히 차단한다 — 남은 위협은
  //      그 lock 프로토콜을 거치지 않는 진짜 로컬 공격자가 specContentRefSourceRoot(항상
  //      caller가 명시적으로 지정하는 trusted root이지 spec/handoff payload에서 파생되지
  //      않는다)에 동시 쓰기 권한을 갖고 정밀한 타이밍으로 symlink를 반복 교체하는
  //      경우뿐이다 — 그 정도 권한을 가진 공격자는 symlink 없이도 대상 파일 내용을 직접
  //      바꿀 수 있다.
  let fd: number;
  try {
    fd = openSync(real, "r");
  } catch (e) {
    return { ok: false, code: "SPEC_CONTENT_REF_READ_FAILED", detail: `specContentRef 대상 파일 열기 실패: ${e instanceof Error ? e.message : String(e)}` };
  }

  let content: string;
  try {
    let fdStat;
    try {
      fdStat = fstatSync(fd);
    } catch (e) {
      return { ok: false, code: "SPEC_CONTENT_REF_NOT_FOUND", detail: `specContentRef 대상 fd 확인 실패: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!fdStat.isFile()) {
      return { ok: false, code: "SPEC_CONTENT_REF_NOT_REGULAR_FILE", detail: "specContentRef 대상이 regular file이 아닙니다(디렉터리 등)." };
    }

    // sandwich 재검증 — open 전에 판정한 real(canonical path)이 open 직후에도 여전히 동일한
    // canonical path로 resolve되는지, 그리고 그 결과의 identity(dev/ino)가 fd와 일치하는지
    // 다시 확인한다. 다르면 open 전후 사이에 대상이 바뀐 것으로 보고 원문을 읽지 않고
    // 즉시 BLOCK한다(완전한 원자성은 아니지만 실현 가능한 최선의 재확인 — 위 주석 참고).
    let realAfterOpen: string;
    try {
      realAfterOpen = realpathSync(candidate);
    } catch (e) {
      return { ok: false, code: "SPEC_CONTENT_REF_NOT_FOUND", detail: `specContentRef 대상 재확인 실패: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (realAfterOpen !== real || !isRealPathWithin(realAfterOpen, sourceRootReal)) {
      return {
        ok: false,
        code: "SPEC_CONTENT_REF_NOT_FOUND",
        detail: "specContentRef 대상이 검증 도중 변경된 것으로 보여 안전하게 중단했습니다(TOCTOU 방지).",
      };
    }
    let postOpenStat;
    try {
      postOpenStat = statSync(realAfterOpen);
    } catch (e) {
      return { ok: false, code: "SPEC_CONTENT_REF_NOT_FOUND", detail: `specContentRef 대상 재확인 실패: ${e instanceof Error ? e.message : String(e)}` };
    }
    if (!postOpenStat.isFile() || postOpenStat.dev !== fdStat.dev || postOpenStat.ino !== fdStat.ino) {
      return {
        ok: false,
        code: "SPEC_CONTENT_REF_NOT_FOUND",
        detail: "specContentRef 대상이 검증 도중 변경된 것으로 보여 안전하게 중단했습니다(TOCTOU 방지, fd/경로 identity 불일치).",
      };
    }

    // UTF-8 기준 문자당 최대 4바이트 — 실제 문자 수 확인(비싼 read) 전에 값싼 byte 크기로
    // 먼저 걸러낸다(대용량 파일 read 자체를 방지). fd 기준 fstat 값을 쓴다(경로 재조회 없음).
    if (fdStat.size > MAX_SPEC_CONTENT_CHARS * 4) {
      return { ok: false, code: "SPEC_CONTENT_REF_TOO_LARGE", detail: `specContentRef 대상 파일이 너무 큽니다(최대 ${MAX_SPEC_CONTENT_CHARS}자).` };
    }
    try {
      content = readFileSync(fd, "utf-8");
    } catch (e) {
      return { ok: false, code: "SPEC_CONTENT_REF_READ_FAILED", detail: `specContentRef 대상 파일 읽기 실패: ${e instanceof Error ? e.message : String(e)}` };
    }
  } finally {
    try {
      closeSync(fd);
    } catch {
      // 이미 닫혔거나 닫기 실패 — 위에서 이미 필요한 내용을 다 읽었으므로 치명적이지 않다.
    }
  }
  if (content.length > MAX_SPEC_CONTENT_CHARS) {
    return { ok: false, code: "SPEC_CONTENT_REF_TOO_LARGE", detail: `specContentRef 대상 파일이 너무 큽니다(최대 ${MAX_SPEC_CONTENT_CHARS}자).` };
  }

  const actualHash = createHash(integrity.algorithm).update(content, "utf8").digest("hex");
  if (actualHash !== integrity.hash) {
    return {
      ok: false,
      code: "SPEC_CONTENT_REF_HASH_MISMATCH",
      detail: `specIntegrity.hash가 specContentRef 대상의 실제 ${integrity.algorithm} digest와 일치하지 않습니다.`,
    };
  }

  const findings = scanContentForSecrets(content, ref);
  if (findings.length > 0) {
    return {
      ok: false,
      code: "SPEC_CONTENT_REF_SECRET_DETECTED",
      detail: `specContentRef 대상 내용에서 secret으로 의심되는 패턴이 발견됐습니다(${findings.length}건). 원문은 기록하지 않습니다.`,
    };
  }

  return { ok: true, content };
}

// ---------------------------------------------------------------------------
// Project root 경로 계산 (§ 요구사항 4)
// ---------------------------------------------------------------------------

function resolveProjectRootPath(
  bootstrapBaseDirReal: string,
  projectId: string
): { ok: true; path: string } | { ok: false; code: BootstrapBlockedCode; detail: string } {
  const base = projectId.split(".")[0].toLowerCase();
  if (RESERVED_WINDOWS_DEVICE_NAMES.has(base)) {
    return { ok: false, code: "PROJECT_ROOT_RESERVED_NAME", detail: `projectId가 Windows 예약 장치명과 충돌합니다: ${projectId}` };
  }
  const candidate = resolve(bootstrapBaseDirReal, projectId);
  const rel = relative(bootstrapBaseDirReal, candidate);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).length !== 1) {
    return {
      ok: false,
      code: "PROJECT_ROOT_ESCAPE",
      detail: "계산된 project root가 bootstrap base directory의 직계 하위 디렉터리가 아닙니다.",
    };
  }
  return { ok: true, path: candidate };
}

// ---------------------------------------------------------------------------
// Bootstrap state 파일 — atomic write(state.ts와 동일한 tmp+rename 패턴), corrupt 판정
// (project-lock.ts의 readLockFile과 동일한 absent/corrupt/valid 3분류 패턴).
// ---------------------------------------------------------------------------

function bootstrapStateFilePath(projectRoot: string): string {
  return join(projectRoot, ".autodev", "bootstrap-state.json");
}

function masterSpecDir(projectRoot: string): string {
  return join(projectRoot, ".autodev", "master-spec");
}

function isValidBootstrapStateFile(v: unknown): v is BootstrapStateFile {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.schemaVersion !== BOOTSTRAP_STATE_SCHEMA_VERSION) return false;
  if (typeof o.stage !== "string" || !BOOTSTRAP_STAGE_ORDER.includes(o.stage as BootstrapStage)) return false;
  if (typeof o.createdAt !== "string" || typeof o.updatedAt !== "string") return false;
  if (o.baselineCommitHash !== undefined && typeof o.baselineCommitHash !== "string") return false;
  const id = o.identity;
  if (!id || typeof id !== "object") return false;
  const i = id as Record<string, unknown>;
  if (typeof i.handoffId !== "string" || i.handoffId.length === 0) return false;
  if (typeof i.projectId !== "string" || i.projectId.length === 0) return false;
  if (typeof i.specVersion !== "string" || i.specVersion.length === 0) return false;
  if (i.specIntegrityAlgorithm !== "sha256" && i.specIntegrityAlgorithm !== "sha512") return false;
  if (typeof i.specIntegrityHash !== "string" || i.specIntegrityHash.length === 0) return false;
  return true;
}

type ReadBootstrapStateResult = { kind: "absent" } | { kind: "corrupt"; detail: string } | { kind: "valid"; state: BootstrapStateFile };

function readBootstrapState(projectRoot: string): ReadBootstrapStateResult {
  const p = bootstrapStateFilePath(projectRoot);
  if (!existsSync(p)) return { kind: "absent" };
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return { kind: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", detail: "bootstrap-state.json이 올바른 JSON이 아닙니다." };
  }
  if (!isValidBootstrapStateFile(parsed)) {
    return { kind: "corrupt", detail: "bootstrap-state.json이 예상된 schema와 일치하지 않습니다." };
  }
  return { kind: "valid", state: parsed };
}

// SI-3.5(§ `.claude/rules/filesystem-trust-model.md`) — spec-planner.ts의 writeJsonAtomic과
// 동일한 hardening 패턴(fsync, 대상 symlink 재확인, pre-promotion revalidation,
// post-promotion 검증)을 적용한다. projectRoot는 이 함수가 호출되는 시점(PROJECT_ROOT_
// CREATED 직후 또는 evaluateExistingProjectRoot가 이미 검증한 resume 경로)에 이미 검증된
// 값이다.
function writeBootstrapStateAtomic(projectRoot: string, state: BootstrapStateFile): { ok: true } | { ok: false; detail: string } {
  const dir = join(projectRoot, ".autodev");
  let tmp: string | undefined;
  try {
    mkdirSync(dir, { recursive: true });
    const projectRootReal = realpathSync(projectRoot);
    const dirReal = realpathSync(dir);
    if (!isRealPathWithin(dirReal, projectRootReal)) {
      return { ok: false, detail: "bootstrap state 저장 실패: .autodev가 project root 밖을 가리킵니다." };
    }
    const chainCheck = assertNoSymlinkInChain(dir, projectRootReal);
    if (!chainCheck.ok) return { ok: false, detail: `bootstrap state 저장 실패: ${chainCheck.detail}` };

    const target = bootstrapStateFilePath(projectRoot);
    tmp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      const targetReal = realpathSync(target);
      if (!isRealPathWithin(targetReal, projectRootReal)) {
        throw new Error("대상 경로가 project root 밖을 가리키는 symlink로 바뀌었습니다.");
      }
    }
    // pre-promotion revalidation.
    const preRenameCheck = assertNoSymlinkInChain(dir, projectRootReal);
    if (!preRenameCheck.ok) throw new Error(preRenameCheck.detail);

    renameSync(tmp, target);
    tmp = undefined;

    // post-promotion 검증(destination swap detection 가능한 범위) — prevention이 아니라
    // detection이다.
    const postLstat = lstatSync(target);
    if (!postLstat.isFile()) {
      return { ok: false, detail: "bootstrap state 저장 실패: write 이후 재확인에서 대상이 regular file이 아닙니다(가능한 race 탐지)." };
    }
    const postReal = realpathSync(target);
    if (!isRealPathWithin(postReal, projectRootReal)) {
      return { ok: false, detail: "bootstrap state 저장 실패: write 이후 재확인에서 대상이 project root 밖을 가리킵니다(가능한 race 탐지)." };
    }
    return { ok: true };
  } catch (e) {
    if (tmp !== undefined) {
      try {
        unlinkSync(tmp);
      } catch {
        // 정리 실패는 원래 오류를 덮지 않는다.
      }
    }
    return { ok: false, detail: `bootstrap state 저장 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---------------------------------------------------------------------------
// handoffId 단위 conflict guard(§ 요구사항 6) — 같은 projectId는 같은 project root 폴더로
// 매핑되므로 폴더 단위 identity 검사(evaluateExistingProjectRoot)만으로 "같은 handoffId,
// 다른 projectId"까지는 잡지 못한다(서로 다른 폴더라 애초에 충돌하지 않는다). 이 index는
// bootstrapBaseDir 하나당 handoffId별로 "이 handoffId가 이미 어떤 identity로 쓰였는가"를
// 별도로 기록해, projectId가 달라 폴더가 겹치지 않는 경우까지 conflict로 잡는다. 이
// 파일이 사라지거나 손상돼도 폴더 단위 검사(같은 projectId 재사용)는 여전히 독립적으로
// 동작한다 — 이 index는 추가 방어선이지 유일한 방어선이 아니다.
// ---------------------------------------------------------------------------

interface HandoffIndexEntry {
  schemaVersion: 1;
  handoffId: string;
  projectId: string;
  specVersion: string;
  specIntegrityAlgorithm: "sha256" | "sha512";
  specIntegrityHash: string;
  projectRoot: string;
  createdAt: string;
}

function handoffIndexDir(baseDirReal: string): string {
  return join(baseDirReal, ".autodev-bootstrap-index");
}

function handoffIndexFilePath(baseDirReal: string, handoffId: string): string {
  const h = createHash("sha256").update(handoffId, "utf8").digest("hex").slice(0, 32);
  return join(handoffIndexDir(baseDirReal), `${h}.json`);
}

function isValidHandoffIndexEntry(v: unknown): v is HandoffIndexEntry {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  if (o.schemaVersion !== 1) return false;
  if (typeof o.handoffId !== "string" || o.handoffId.length === 0) return false;
  if (typeof o.projectId !== "string" || o.projectId.length === 0) return false;
  if (typeof o.specVersion !== "string" || o.specVersion.length === 0) return false;
  if (o.specIntegrityAlgorithm !== "sha256" && o.specIntegrityAlgorithm !== "sha512") return false;
  if (typeof o.specIntegrityHash !== "string" || o.specIntegrityHash.length === 0) return false;
  if (typeof o.projectRoot !== "string" || o.projectRoot.length === 0) return false;
  if (typeof o.createdAt !== "string") return false;
  return true;
}

type ReadHandoffIndexResult = { kind: "absent" } | { kind: "corrupt"; detail: string } | { kind: "valid"; entry: BootstrapRequestIdentity };

function readHandoffIndexEntry(baseDirReal: string, handoffId: string): ReadHandoffIndexResult {
  // GPT Independent Reviewer 지적(SI-2 REVISE 6회차, CRITICAL) — bootstrapBaseDir 자체의
  // containment만으로는 부족하다. 그 바로 아래에 있는 `.autodev-bootstrap-index`도 별도의
  // symlink/junction으로 미리 심어질 수 있다 — 존재한다면 읽기 전에 그 realpath가 여전히
  // baseDirReal 내부인지 확인한다.
  const indexDirCheck = assertExistingSubPathContained(baseDirReal, baseDirReal, ".autodev-bootstrap-index");
  if (!indexDirCheck.ok) return { kind: "corrupt", detail: indexDirCheck.detail };
  const p = handoffIndexFilePath(baseDirReal, handoffId);
  if (!existsSync(p)) return { kind: "absent" };
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return { kind: "absent" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", detail: "handoff index 파일이 올바른 JSON이 아닙니다." };
  }
  if (!isValidHandoffIndexEntry(parsed)) return { kind: "corrupt", detail: "handoff index 파일이 예상된 schema와 일치하지 않습니다." };
  return {
    kind: "valid",
    entry: {
      handoffId: parsed.handoffId,
      projectId: parsed.projectId,
      specVersion: parsed.specVersion,
      specIntegrityAlgorithm: parsed.specIntegrityAlgorithm,
      specIntegrityHash: parsed.specIntegrityHash,
    },
  };
}

/** 실패해도 이 함수를 호출한 bootstrap 자체를 막지 않는다 — 이 index는 폴더 단위 검사 위의
 *  추가 방어선일 뿐, 유일한 identity 판정 근거가 아니다(그 근거는 항상
 *  `.autodev/bootstrap-state.json`이다). */
function writeHandoffIndexEntryBestEffort(baseDirReal: string, identity: BootstrapRequestIdentity, projectRoot: string): void {
  try {
    // GPT Independent Reviewer 지적(SI-2 REVISE 6회차, CRITICAL) — 이미 존재하는
    // `.autodev-bootstrap-index`가 symlink/junction으로 baseDirReal 밖을 가리키면 그 안에
    // 쓰지 않는다(이 index는 best-effort 보조 방어선이므로, 쓰기를 건너뛸 뿐 전체 bootstrap을
    // 막지는 않는다 — 판정의 유일한 근거는 항상 각 project의 bootstrap-state.json이다).
    const indexDirCheck = assertExistingSubPathContained(baseDirReal, baseDirReal, ".autodev-bootstrap-index");
    if (!indexDirCheck.ok) return;
    mkdirSync(handoffIndexDir(baseDirReal), { recursive: true });
    const target = handoffIndexFilePath(baseDirReal, identity.handoffId);
    const entry: HandoffIndexEntry = {
      schemaVersion: 1,
      handoffId: identity.handoffId,
      projectId: identity.projectId,
      specVersion: identity.specVersion,
      specIntegrityAlgorithm: identity.specIntegrityAlgorithm,
      specIntegrityHash: identity.specIntegrityHash,
      projectRoot,
      createdAt: new Date().toISOString(),
    };
    const tmp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(entry, null, 2) + "\n", "utf-8");
    renameSync(tmp, target);
  } catch {
    // best-effort — 위 docstring 참고.
  }
}

function identitiesMatch(a: BootstrapRequestIdentity, b: BootstrapRequestIdentity): boolean {
  return (
    a.handoffId === b.handoffId &&
    a.projectId === b.projectId &&
    a.specVersion === b.specVersion &&
    a.specIntegrityAlgorithm === b.specIntegrityAlgorithm &&
    a.specIntegrityHash === b.specIntegrityHash
  );
}

// ---------------------------------------------------------------------------
// Master Spec 보존 (§ 요구사항 8)
// ---------------------------------------------------------------------------

function preserveMasterSpec(
  projectRoot: string,
  content: string,
  spec: MasterSpecIntake,
  envelope: HandoffEnvelope,
  provenance: BootstrapContentProvenance
): { ok: true } | { ok: false; detail: string } {
  const dir = masterSpecDir(projectRoot);
  const specPath = join(dir, "spec.md");
  const manifestPath = join(dir, "manifest.json");
  const algorithm = spec.specIntegrity.algorithm;
  const expectedHash = spec.specIntegrity.hash.toLowerCase();

  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(specPath, content, "utf-8");
  } catch (e) {
    return { ok: false, detail: `Master Spec 파일 쓰기 실패: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 저장 후 다시 digest 검증 — 쓰기 도중 손상이 있었다면 여기서 잡는다.
  let reread: string;
  try {
    reread = readFileSync(specPath, "utf-8");
  } catch (e) {
    return { ok: false, detail: `저장된 Master Spec 재확인 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
  const rehash = createHash(algorithm).update(reread, "utf8").digest("hex");
  if (rehash !== expectedHash) {
    return { ok: false, detail: "저장된 Master Spec의 digest가 검증된 원본과 일치하지 않습니다(쓰기 손상 의심)." };
  }

  const manifest: MasterSpecManifest = {
    schemaVersion: 1,
    projectId: spec.projectId,
    projectName: spec.projectName,
    specVersion: spec.specVersion,
    handoffId: envelope.handoffId,
    specIntegrity: { algorithm, hash: expectedHash },
    specStatus: spec.specStatus,
    userApproval: spec.userApproval,
    reviewerGate: { critical: spec.reviewerGate.critical, high: spec.reviewerGate.high },
    unresolvedCriticalCount: spec.unresolvedCriticalCount,
    contradictionCount: spec.contradictionCount,
    bootstrapProvenance: { ...provenance, bootstrappedAt: new Date().toISOString() },
    storedContentDigest: { algorithm, hash: rehash },
  };
  // SI-3.5(§ `.claude/rules/filesystem-trust-model.md`) — writeBootstrapStateAtomic/
  // spec-planner.ts의 writeJsonAtomic과 동일한 hardening 패턴을 적용한다.
  let tmp: string | undefined;
  try {
    const projectRootReal = realpathSync(projectRoot);
    const dirReal = realpathSync(dir);
    if (!isRealPathWithin(dirReal, projectRootReal)) {
      return { ok: false, detail: "Master Spec manifest 쓰기 실패: master-spec 디렉터리가 project root 밖을 가리킵니다." };
    }
    const chainCheck = assertNoSymlinkInChain(dir, projectRootReal);
    if (!chainCheck.ok) return { ok: false, detail: `Master Spec manifest 쓰기 실패: ${chainCheck.detail}` };

    tmp = `${manifestPath}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (existsSync(manifestPath) && lstatSync(manifestPath).isSymbolicLink()) {
      const targetReal = realpathSync(manifestPath);
      if (!isRealPathWithin(targetReal, projectRootReal)) {
        throw new Error("대상 경로가 project root 밖을 가리키는 symlink로 바뀌었습니다.");
      }
    }
    const preRenameCheck = assertNoSymlinkInChain(dir, projectRootReal);
    if (!preRenameCheck.ok) throw new Error(preRenameCheck.detail);

    renameSync(tmp, manifestPath);
    tmp = undefined;

    const postLstat = lstatSync(manifestPath);
    if (!postLstat.isFile()) {
      return { ok: false, detail: "Master Spec manifest 쓰기 실패: write 이후 재확인에서 대상이 regular file이 아닙니다(가능한 race 탐지)." };
    }
    const postReal = realpathSync(manifestPath);
    if (!isRealPathWithin(postReal, projectRootReal)) {
      return { ok: false, detail: "Master Spec manifest 쓰기 실패: write 이후 재확인에서 대상이 project root 밖을 가리킵니다(가능한 race 탐지)." };
    }
  } catch (e) {
    if (tmp !== undefined) {
      try {
        unlinkSync(tmp);
      } catch {
        // 정리 실패는 원래 오류를 덮지 않는다.
      }
    }
    return { ok: false, detail: `Master Spec manifest 쓰기 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Git baseline (§ 요구사항 9)
//
// GPT Independent Reviewer 지적(SI-2 REVISE 6~7회차, CRITICAL) — resume 시 `.git`이 project
// root 내부의 "신뢰할 수 있는" 디렉터리라는 보장이 없었다. 방어를 세 층으로 나눈다:
//   1) assertGitDirSafe() — `.git`이 (존재한다면) 반드시 일반 디렉터리여야 하고(symlink/
//      "gitfile" — `gitdir: <외부경로>` 형태의 일반 텍스트 파일, git worktree/submodule이
//      정상 사용하는 형식 — 전부 거부), 그 realpath가 project root 내부여야 한다.
//   2) runHardenedGit() — 이 모듈이 `.git`이 이미 존재할 수 있는 상태에서 실행하는 모든
//      git 호출의 유일한 통로다. (a) GIT_DIR/GIT_WORK_TREE 등 git 자체의 redirect
//      환경변수 + GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n(환경변수를 통한
//      config 주입)까지 전부 제거한다. (b) `--git-dir`/`--work-tree`를 항상 명시해 repo
//      config의 `core.worktree`로 인한 redirect를 무력화한다(명령줄 인자가 config보다
//      우선한다). (c) 매 호출마다 새로 만드는, 비어있는 전용 디렉터리를
//      `-c core.hooksPath=`로 강제해 repo config의 `core.hooksPath`를 통한 hook 실행을
//      무력화하고, `-c core.fsmonitor=false`로 fsmonitor hook을, `-c commit.gpgSign=false`로
//      commit.gpgSign+gpg.program/gpg.ssh.program 조합을 통한 서명 프로그램 실행을 끈다
//      (`-c`는 파일 기반 config보다 항상 우선하므로 repo-local/`include`/`includeIf`로
//      주입된 값도 덮어쓴다).
//   3) checkNoFilterAttribute() — `.gitattributes`의 clean/smudge filter는 `-c` override로
//      막을 수 없다(파일 내용이 아니라 경로attribute 매칭이라 별도 확인이 필요하다) — add하기
//      전에 대상 파일들에 filter attribute가 전혀 설정되지 않았는지(`git check-attr`)
//      확인하고, 하나라도 있으면 add 자체를 시도하지 않는다.
// git stderr는 사용자가 만들지 않은 hook/filter가 있었다면 임의 내용을 담을 수 있으므로,
// 결과 detail에는 항상 secret-scanner.ts와 동일한 sanitizeForLog()를 거친 뒤에만 담는다.
//
// 남기는 경계: 이 세 층은 "project root 내부의 진짜 .git이지만 그 config/attributes 내용
// 자체가 (이 코드가 만든 것이 아니라 외부에서) 알려진 RCE 벡터(hooksPath/fsmonitor/worktree/
// filter/commit signing)로 변조된 경우"를 구체적으로 막는다 — 그러나 git 생태계 전체의 모든
// 잠재적 config 기반 동작(예: 아직 알려지지 않은 새 config 옵션)까지 이론적으로 전부
// 봉쇄한다고 주장하지 않는다. 이 저장소가 스스로 `git init`으로 새로 만드는 `.git`은 항상
// 기본 설정이므로, 이 gap은 "우리가 만들지 않은 기존 .git을 resume이 재사용하는" 경우로
// 한정된다.
// ---------------------------------------------------------------------------

const GIT_REDIRECT_ENV_KEYS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_CEILING_DIRECTORIES",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_INDEX_FILE",
];

/** 상속된 GIT_* redirect/config-injection 환경변수를 전부 제거한다. */
function stripGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of GIT_REDIRECT_ENV_KEYS) delete out[k];
  delete out.GIT_CONFIG_COUNT;
  for (const k of Object.keys(out)) {
    if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(k)) delete out[k];
  }
  return out;
}

/** git stderr/stdout은 hook/filter가 있었다면 임의 내용(secret 포함)을 담을 수 있으므로,
 *  결과에 담기 전 항상 이 함수를 거친다(secret-scanner.ts와 동일한 sanitizeForLog 재사용). */
function gitFailureDetail(prefix: string, stderr: string): string {
  return `${prefix}: ${sanitizeForLog(stderr.trim().slice(0, 500))}`;
}

interface HardenedGitResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** git을 실행하기 직전 항상 호출한다 — `.git`이 존재한다면(이미 git init된 상태, 주로
 *  resume 경로) 반드시 일반 디렉터리여야 하고(symlink/"gitdir: ..." 형태의 gitfile 전부
 *  거부), 그 realpath가 project root 내부여야 한다. `.git`이 아직 없으면(첫 git init 전)
 *  통과시킨다. */
function assertGitDirSafe(projectRoot: string, projectRootReal: string): { ok: true } | { ok: false; detail: string } {
  const gitDir = join(projectRoot, ".git");
  if (!existsSync(gitDir)) return { ok: true };
  let st;
  try {
    st = statSync(gitDir); // symlink를 따라간 뒤의 타입을 본다.
  } catch (e) {
    return { ok: false, detail: `.git 확인 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!st.isDirectory()) {
    return { ok: false, detail: ".git이 일반 디렉터리가 아닙니다(gitfile/symlink 등으로 의심됨) — 신뢰할 수 없어 중단합니다." };
  }
  let real: string;
  try {
    real = realpathSync(gitDir);
  } catch (e) {
    return { ok: false, detail: `.git realpath 확인 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isRealPathWithin(real, projectRootReal)) {
    return { ok: false, detail: ".git이 symlink/junction/reparse point를 통해 project root 밖을 가리킵니다." };
  }
  return { ok: true };
}

/** `.git`이 이미 존재할 수 있는 상태에서 실행하는 모든 git 호출의 유일한 통로 — § 상단
 *  주석 (2)의 세 방어(env 제거, --git-dir/--work-tree 명시, 매 호출 전용의 빈
 *  core.hooksPath + core.fsmonitor=false)를 전부 강제한다. */
function runHardenedGit(projectRoot: string, gitDir: string, args: string[]): HardenedGitResult {
  const hooksDir = mkdtempSync(join(tmpdir(), "autodev-si2-git-hooks-"));
  try {
    // GPT Independent Reviewer 지적(SI-2 REVISE 8회차, CRITICAL) — commit.gpgSign(repo
    // config)이 true이면 gpg.program/gpg.ssh.program에 지정된(마찬가지로 config로 지정되는)
    // 외부 프로그램을 git commit이 그대로 실행한다 — hooksPath/fsmonitor와 동일한 유형의
    // config 기반 임의 프로그램 실행 벡터다. commit.gpgSign=false를 강제해 기존 config가
    // 무엇을 지정하든 서명 프로그램 자체가 호출되지 않게 한다.
    const fullArgs = [
      "--git-dir",
      gitDir,
      "--work-tree",
      projectRoot,
      "-c",
      `core.hooksPath=${hooksDir}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "commit.gpgSign=false",
      ...args,
    ];
    const res = spawnSync("git", fullArgs, { cwd: projectRoot, shell: false, encoding: "utf-8", env: stripGitEnv(process.env) });
    return { status: res.status, stdout: res.stdout || "", stderr: res.stderr || "" };
  } finally {
    try {
      rmSync(hooksDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup — OS 임시 디렉터리이므로 치명적이지 않다.
    }
  }
}

/** HEAD commit hash를 이 모듈 자체의 hardened git 통로로 조회한다 — git-changes.ts의
 *  getCurrentHeadHash()는 이 파일이 만드는 env/redirect 방어를 거치지 않는 별도의
 *  spawnSync를 쓰므로(그 함수는 이 저장소 전역에서 널리 재사용되는 Core 공용 함수라 이
 *  Task가 그 시그니처/동작을 바꾸지 않는다), 이 Task가 실제로 실행하는 git 호출 안에서는
 *  이 hardened 버전만 쓴다. */
function getHardenedHeadHash(projectRoot: string, gitDir: string): string | undefined {
  const res = runHardenedGit(projectRoot, gitDir, ["rev-parse", "HEAD"]);
  if (res.status !== 0) return undefined;
  const hash = res.stdout.trim();
  return hash.length > 0 ? hash : undefined;
}

function ensureGitInitialized(
  projectRoot: string,
  projectRootReal: string,
  commitIdentity?: { name: string; email: string }
): { ok: true } | { ok: false; detail: string } {
  const preCheck = assertGitDirSafe(projectRoot, projectRootReal);
  if (!preCheck.ok) return preCheck;

  const gitDir = join(projectRoot, ".git");
  if (!existsSync(gitDir)) {
    // .git이 아직 없다 — 지금 막 새로 만드는 것이므로 신뢰할 수 없는 기존 config/hook이
    // 있을 수 없다(runHardenedGit의 hooksPath/worktree override가 굳이 필요하지 않다).
    // env는 일관성을 위해 그대로 제거한다.
    const res = spawnSync("git", ["init"], { cwd: projectRoot, shell: false, encoding: "utf-8", env: stripGitEnv(process.env) });
    if (res.status !== 0) {
      return { ok: false, detail: gitFailureDetail("git init 실패", res.stderr || "") };
    }
    const postCheck = assertGitDirSafe(projectRoot, projectRootReal);
    if (!postCheck.ok) return postCheck;
  }
  if (commitIdentity) {
    const n = runHardenedGit(projectRoot, gitDir, ["config", "user.name", commitIdentity.name]);
    const e = runHardenedGit(projectRoot, gitDir, ["config", "user.email", commitIdentity.email]);
    if (n.status !== 0 || e.status !== 0) {
      return { ok: false, detail: "baseline commit identity(local git config) 설정 실패." };
    }
  }
  return { ok: true };
}

function buildBaselineCommitMessage(spec: MasterSpecIntake, envelope: HandoffEnvelope): string {
  return `chore(bootstrap): preserve APPROVED Master Spec (project=${spec.projectId}, specVersion=${spec.specVersion}, handoff=${envelope.handoffId})`;
}

const BASELINE_FILES = [".autodev/master-spec/spec.md", ".autodev/master-spec/manifest.json"];

/** BASELINE_FILES 중 하나라도 `.gitattributes` clean/smudge filter가 지정돼 있으면(파일
 *  내용이 정확해도, 그 filter로 지정된 외부 명령이 add 시점에 실행될 수 있다) add 자체를
 *  거부한다. `-c` config override로는 이 벡터를 막을 수 없어(attribute는 config가 아니라
 *  경로 매칭이다) 별도로 확인한다. */
function checkNoFilterAttribute(projectRoot: string, gitDir: string): { ok: true } | { ok: false; detail: string } {
  const res = runHardenedGit(projectRoot, gitDir, ["check-attr", "filter", "--", ...BASELINE_FILES]);
  if (res.status !== 0) {
    return { ok: false, detail: "git check-attr 실행 실패 — filter attribute 여부를 안전하게 확인할 수 없어 중단합니다." };
  }
  const lines = res.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.endsWith("filter: unspecified")) {
      return {
        ok: false,
        detail: "commit 대상 파일에 filter attribute(.gitattributes clean/smudge)가 설정되어 있어 안전하게 중단했습니다(임의 명령 실행 방지).",
      };
    }
  }
  return { ok: true };
}

/**
 * 정확히 BASELINE_FILES만 stage해 commit한다 — `git add .` 금지, 그 외 아무 파일도 만들지
 * 않는다. checkpoint.ts(performTaskCheckpoint)와 동일한 TOCTOU 방지(staged 집합이 계획과
 * 정확히 일치하는지 add 직후 재검증) 패턴을 따른다.
 */
function createBaselineCommit(projectRoot: string, projectRootReal: string, commitMessage: string): { ok: true; commitHash: string } | { ok: false; detail: string } {
  const preCheck = assertGitDirSafe(projectRoot, projectRootReal);
  if (!preCheck.ok) return preCheck;
  const gitDir = join(projectRoot, ".git");

  const attrCheck = checkNoFilterAttribute(projectRoot, gitDir);
  if (!attrCheck.ok) return attrCheck;

  const addRes = runHardenedGit(projectRoot, gitDir, ["add", "--", ...BASELINE_FILES]);
  if (addRes.status !== 0) {
    return { ok: false, detail: gitFailureDetail("git add 실패", addRes.stderr) };
  }

  const stagedRes = runHardenedGit(projectRoot, gitDir, ["diff", "--cached", "--name-only"]);
  const staged = new Set(stagedRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
  const expected = new Set(BASELINE_FILES);
  const matches = staged.size === expected.size && [...expected].every((f) => staged.has(f));
  if (!matches) {
    runHardenedGit(projectRoot, gitDir, ["reset"]);
    return { ok: false, detail: "staged 파일 집합이 예상(baseline 파일)과 달라 commit을 중단했습니다(index reset됨)." };
  }

  const commitRes = runHardenedGit(projectRoot, gitDir, ["commit", "-m", commitMessage]);
  if (commitRes.status !== 0) {
    runHardenedGit(projectRoot, gitDir, ["reset"]);
    return { ok: false, detail: gitFailureDetail("git commit 실패", commitRes.stderr) };
  }

  const hash = getHardenedHeadHash(projectRoot, gitDir);
  if (!hash) {
    return { ok: false, detail: "commit은 성공한 것으로 보이지만 HEAD hash 조회에 실패했습니다." };
  }
  return { ok: true, commitHash: hash };
}

// ---------------------------------------------------------------------------
// 단계 진행(신규/Resume 공통) — § 요구사항 7 최소 상태: PROJECT_ROOT_CREATED 도달 시점에
// 이미 INTAKE_VERIFIED + CONTENT_VERIFIED가 끝난 상태다(이 함수 호출 전 bootstrapProject()가
// evaluateSpecIntake + 필요시 verifySpecContentRefFile을 모두 통과시켰을 때만 호출된다).
// ---------------------------------------------------------------------------

function advanceBootstrap(
  projectRoot: string,
  initialState: BootstrapStateFile,
  verifiedContent: string,
  spec: MasterSpecIntake,
  envelope: HandoffEnvelope,
  provenance: BootstrapContentProvenance,
  config: BootstrapTrustedConfig,
  bootstrapBaseDirReal: string
): BootstrapOutcome {
  // GPT Independent Reviewer 지적(SI-2 REVISE 5회차, CRITICAL) — "project root만 base 안에
  // 있다고 하위 write/git 실행이 안전해지는 것은 아니다"(예: git 단계 직전에 root 또는 .git이
  // 교체될 가능성). advanceBootstrap()이 실제로 write/git을 수행하기 직전에 다시 한번
  // projectRoot의 realpath containment를 확인한다 — 이 호출이 fresh 생성 직후(방금 우리가
  // 만든 경로)든 resume(다른 프로세스 호출에서 이미 존재하던 경로, evaluateExistingProjectRoot가
  // 한 번 확인한 뒤)든 동일하게 적용된다.
  let projectRootRealAtStart: string;
  try {
    projectRootRealAtStart = realpathSync(projectRoot);
  } catch (e) {
    return { status: "BLOCKED", code: "PROJECT_ROOT_ESCAPE", detail: `project root 확인 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isRealPathWithin(projectRootRealAtStart, bootstrapBaseDirReal)) {
    return {
      status: "BLOCKED",
      code: "PROJECT_ROOT_ESCAPE",
      detail: "project root가 symlink/junction/reparse point를 통해 bootstrapBaseDir 밖을 가리켜(write/git 직전 재확인) 중단했습니다.",
    };
  }

  let cur = initialState;

  if (cur.stage === "PROJECT_ROOT_CREATED") {
    const preserve = preserveMasterSpec(projectRoot, verifiedContent, spec, envelope, provenance);
    if (!preserve.ok) return { status: "WAITING_HUMAN", projectRoot, stage: cur.stage, detail: preserve.detail };
    cur = { ...cur, stage: "SPEC_PRESERVED", updatedAt: new Date().toISOString() };
    const w = writeBootstrapStateAtomic(projectRoot, cur);
    if (!w.ok) return { status: "WAITING_HUMAN", projectRoot, stage: "PROJECT_ROOT_CREATED", detail: w.detail };
  }

  if (cur.stage === "SPEC_PRESERVED") {
    const git = ensureGitInitialized(projectRoot, projectRootRealAtStart, config.commitIdentity);
    if (!git.ok) return { status: "WAITING_HUMAN", projectRoot, stage: cur.stage, detail: git.detail };
    cur = { ...cur, stage: "GIT_INITIALIZED", updatedAt: new Date().toISOString() };
    const w = writeBootstrapStateAtomic(projectRoot, cur);
    if (!w.ok) return { status: "WAITING_HUMAN", projectRoot, stage: "SPEC_PRESERVED", detail: w.detail };
  }

  if (cur.stage === "GIT_INITIALIZED") {
    const gitDirCheck = assertGitDirSafe(projectRoot, projectRootRealAtStart);
    if (!gitDirCheck.ok) return { status: "WAITING_HUMAN", projectRoot, stage: cur.stage, detail: gitDirCheck.detail };
    // Resume 자가치유: 이전 시도가 실제로 commit까지는 성공했지만 그 직후 state 저장이
    // 실패했을 가능성이 있다 — 재시도 전에 HEAD가 이미 있는지 먼저 확인해 중복 commit을
    // 만들지 않는다(§ 요구사항 13/15).
    const existingHead = getHardenedHeadHash(projectRoot, join(projectRoot, ".git"));
    if (existingHead) {
      cur = { ...cur, stage: "BASELINE_READY", baselineCommitHash: existingHead, updatedAt: new Date().toISOString() };
    } else {
      const commit = createBaselineCommit(projectRoot, projectRootRealAtStart, buildBaselineCommitMessage(spec, envelope));
      if (!commit.ok) return { status: "WAITING_HUMAN", projectRoot, stage: cur.stage, detail: commit.detail };
      cur = { ...cur, stage: "BASELINE_READY", baselineCommitHash: commit.commitHash, updatedAt: new Date().toISOString() };
    }
    const w = writeBootstrapStateAtomic(projectRoot, cur);
    if (!w.ok) return { status: "WAITING_HUMAN", projectRoot, stage: "GIT_INITIALIZED", detail: w.detail };
  }

  if (cur.stage === "BASELINE_READY") {
    cur = { ...cur, stage: "COMPLETED", updatedAt: new Date().toISOString() };
    const w = writeBootstrapStateAtomic(projectRoot, cur);
    if (!w.ok) return { status: "WAITING_HUMAN", projectRoot, stage: "BASELINE_READY", detail: w.detail };
  }

  return {
    status: "COMPLETE",
    projectRoot,
    baselineCommitHash: cur.baselineCommitHash as string,
    masterSpecPath: join(masterSpecDir(projectRoot), "spec.md"),
    bootstrapStatePath: bootstrapStateFilePath(projectRoot),
  };
}

/** parentAbs 아래 subPathRel이 존재한다면(존재하지 않으면 아직 만들어지지 않은 정상 상태이므로
 *  통과) 그 realpath가 여전히 parentReal 내부로 resolve되는지 확인한다 — 개별 하위 경로가
 *  각자 다른 symlink/junction으로 이탈하는 것을 막는다(§ evaluateExistingProjectRoot 상단
 *  주석). realpathSync는 경로 전체(중간 구성요소 포함)를 해석하므로 여러 단계로 된
 *  subPathRel(예: ".autodev/master-spec")도 한 번에 검증된다. */
function assertExistingSubPathContained(parentAbs: string, parentReal: string, subPathRel: string): { ok: true } | { ok: false; detail: string } {
  const candidate = join(parentAbs, subPathRel);
  if (!existsSync(candidate)) return { ok: true };
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch (e) {
    return { ok: false, detail: `${subPathRel} 확인 실패: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isRealPathWithin(real, parentReal)) {
    return { ok: false, detail: `${subPathRel}가 symlink/junction/reparse point를 통해 project root 밖을 가리킵니다.` };
  }
  // SI-3.5 — containment(위)만으로는 "root 내부의 다른 위치를 가리키는 symlink"를 잡지
  // 못한다(§ assertNoSymlinkInChain 상단 주석). subPathRel 자체가 symlink/junction이면
  // 그 목적지가 root 안이든 밖이든 구조적으로 거부한다.
  const chainCheck = assertNoSymlinkInChain(candidate, parentReal);
  if (!chainCheck.ok) return { ok: false, detail: chainCheck.detail };
  return { ok: true };
}

/** 이미 존재하는 projectRoot 경로를 collision/conflict/resume 중 무엇으로 다룰지 판정한다
 *  (§ 요구사항 5/6). 어떤 경우에도 기존 파일을 지우거나 바꾸지 않는다.
 *
 *  GPT Independent Reviewer 지적(SI-2 REVISE 4회차, CRITICAL) — 이전에는 projectRoot가
 *  이미 존재할 때 그 경로 자체가 symlink/junction으로 bootstrapBaseDir 밖을 가리키는지
 *  전혀 확인하지 않고 바로 `.autodev/bootstrap-state.json`을 읽었다 — 공격자가 동일 identity
 *  metadata를 담은 symlink 폴더를 미리 심어두면 이후 resume 단계의 write/rename/git 실행이
 *  bootstrapBaseDir 밖에서 일어날 수 있었다. 이제 상태 파일을 읽기 전에 projectRoot의
 *  realpath가 여전히 bootstrapBaseDirReal 내부인지(isRealPathWithin, § 대소문자 정규화
 *  없음) 가장 먼저 확인하고, 벗어나면 metadata 신뢰 여부와 무관하게 즉시 BLOCK한다. */
function evaluateExistingProjectRoot(
  projectRoot: string,
  identity: BootstrapRequestIdentity,
  bootstrapBaseDirReal: string
): { outcome: BootstrapOutcome } | { state: BootstrapStateFile } {
  let projectRootReal: string;
  try {
    projectRootReal = realpathSync(projectRoot);
  } catch (e) {
    return {
      outcome: {
        status: "BLOCKED",
        code: "PROJECT_ROOT_ESCAPE",
        detail: `기존 project root 경로 확인 실패: ${e instanceof Error ? e.message : String(e)}`,
      },
    };
  }
  if (!isRealPathWithin(projectRootReal, bootstrapBaseDirReal)) {
    return {
      outcome: {
        status: "BLOCKED",
        code: "PROJECT_ROOT_ESCAPE",
        detail: "기존 project root가 symlink/junction/reparse point를 통해 bootstrapBaseDir 밖을 가리킵니다 — metadata를 신뢰하지 않고 즉시 중단합니다.",
      },
    };
  }
  // SI-3.5 — containment(위)만으로는 "bootstrapBaseDir 내부의 다른(예: 다른 프로젝트)
  // 위치를 가리키는 symlink"를 잡지 못한다(§ assertNoSymlinkInChain 상단 주석). project
  // root 자체가 symlink/junction이면 그 목적지가 base 안이든 밖이든 구조적으로 거부한다 —
  // "우연히 base 내부를 가리켜 통과"하는 identity 혼동을 막는다.
  const projectRootChainCheck = assertNoSymlinkInChain(projectRoot, bootstrapBaseDirReal);
  if (!projectRootChainCheck.ok) {
    return {
      outcome: { status: "BLOCKED", code: "PROJECT_ROOT_ESCAPE", detail: projectRootChainCheck.detail },
    };
  }

  // GPT Independent Reviewer 지적(SI-2 REVISE 5회차, CRITICAL) — project root 자체의
  // containment만으로는 부족하다: `.autodev`나 `.autodev/master-spec`이 각각 별도의
  // symlink/junction으로 project root 밖(base 안의 다른 프로젝트 또는 완전히 외부)을
  // 가리키게 만들 수 있고, 이후 코드는 이 두 경로 하위를 join()만으로 그대로 읽고/쓴다.
  // 존재한다면(아직 만들어지지 않은 정상 상태는 통과) 이 둘의 realpath가 여전히
  // projectRootReal 내부인지 metadata를 읽기 전에 먼저 확인한다.
  const autodevCheck = assertExistingSubPathContained(projectRoot, projectRootReal, ".autodev");
  if (!autodevCheck.ok) {
    return { outcome: { status: "BLOCKED", code: "PROJECT_ROOT_ESCAPE", detail: autodevCheck.detail } };
  }
  const masterSpecCheck = assertExistingSubPathContained(projectRoot, projectRootReal, join(".autodev", "master-spec"));
  if (!masterSpecCheck.ok) {
    return { outcome: { status: "BLOCKED", code: "PROJECT_ROOT_ESCAPE", detail: masterSpecCheck.detail } };
  }

  const read = readBootstrapState(projectRoot);
  if (read.kind === "absent") {
    return {
      outcome: {
        status: "COLLISION",
        reason: "NO_BOOTSTRAP_METADATA",
        detail: "target project 경로가 이미 존재하지만 AutoDev Bootstrap 소유 metadata(.autodev/bootstrap-state.json)가 없습니다.",
        existingProjectRoot: projectRoot,
      },
    };
  }
  if (read.kind === "corrupt") {
    return {
      outcome: {
        status: "COLLISION",
        reason: "CORRUPT_BOOTSTRAP_METADATA",
        detail: `bootstrap state metadata가 손상되었습니다: ${read.detail}`,
        existingProjectRoot: projectRoot,
      },
    };
  }
  if (!identitiesMatch(read.state.identity, identity)) {
    return {
      outcome: {
        status: "CONFLICT",
        detail: "같은 project root 경로에 다른 identity(handoffId/projectId/specVersion/specIntegrity)의 Bootstrap 상태가 이미 존재합니다.",
        existingIdentity: read.state.identity,
        requestedIdentity: identity,
      },
    };
  }
  if (read.state.stage === "COMPLETED") {
    return { outcome: { status: "ALREADY_BOOTSTRAPPED", projectRoot, baselineCommitHash: read.state.baselineCommitHash } };
  }
  return { state: read.state };
}

// ---------------------------------------------------------------------------
// Bootstrap Lock — GPT Independent Reviewer 지적(SI-2 REVISE 4회차, HIGH) — 여러 프로세스가
// 동시에 같은 projectId를 bootstrap하면(정상적인 재시도 포함, 공격 시나리오가 아니어도)
// mkdir/state 작성/handoff index 갱신/git init·add·commit이 서로 겹쳐 정상 요청이 잘못
// COLLISION으로 오판되거나 git index/state.json이 서로 덮어써질 수 있다.
// project-lock.ts(Project Lock & Concurrent Writer Safety, Phase G Task G7)가 이미 이
// 저장소의 "동시 writer 방지"에 대한 단일 설계 원칙(check-then-create 금지, wx exclusive
// create만으로 원자적 승부, TTL만으로 삭제하지 않고 owner PID 생존을 실제로 증명해야만
// stale 복구)을 갖고 있으므로 그 판정 로직(assessOwnerLiveness, PID 재사용까지 감지)을
// 그대로 재사용한다(복제 금지) — 다만 project-lock.ts의 acquireProjectLock()은 lock key를
// `realpathSync(targetProjectRoot)`로 계산해 대상이 이미 존재해야 하므로, 아직 존재하지
// 않는 신규 project(가장 흔한 bootstrap 경로)에는 그대로 쓸 수 없다. 이 lock은 대신
// projectId(트리 경로가 아니라 식별자)로 키를 잡아 bootstrapBaseDir 하나당
// `.autodev-bootstrap-locks/`에 둔다 — mkdir 이전에도 동작해야 하기 때문이다.
//
// GPT Independent Reviewer 지적(SI-2 REVISE 5회차, HIGH) — projectId 단위 lock 하나만으로는
// 같은 handoffId를 서로 다른 projectId로 동시에 bootstrap하는 두 호출을 직렬화하지 못한다
// (서로 다른 lock을 각자 얻어 handoff index 부재를 동시에 관찰할 수 있었다). 그래서 lock
// key에 kind("handoff" | "project")를 추가해 두 개의 독립된 lock 공간을 만들고,
// bootstrapProject()가 항상 고정된 순서(handoff → project)로 둘 다 획득한다(고정 순서라
// 서로 다른 두 호출이 반대 순서로 잡아 교착되는 상황 자체가 생기지 않는다) — handoffId가
// 같은 두 호출도, projectId가 같은 두 호출도 모두 이 조합으로 직렬화된다.
// ---------------------------------------------------------------------------

type BootstrapLockKind = "handoff" | "project";

interface BootstrapLockMetadata {
  schemaVersion: 1;
  pid: number;
  processStartedAtMs: number;
  lockId: string;
  createdAt: string;
}

function bootstrapLockDir(baseDirReal: string): string {
  return join(baseDirReal, ".autodev-bootstrap-locks");
}

function bootstrapLockFilePath(baseDirReal: string, kind: BootstrapLockKind, id: string): string {
  const h = createHash("sha256").update(`${kind}:${id}`, "utf8").digest("hex").slice(0, 32);
  return join(bootstrapLockDir(baseDirReal), `${kind}-${h}.lock.json`);
}

/** 테스트/진단 전용 — project-lock.ts의 debugComputeLockFilePath()와 동일한 목적이다.
 *  실제 production 코드는 이 경로를 직접 계산할 필요가 없다(항상 acquireBootstrapLock/
 *  releaseBootstrapLock을 통해서만 lock을 다룬다). */
export function debugComputeBootstrapLockFilePath(baseDirReal: string, kind: BootstrapLockKind, id: string): string {
  return bootstrapLockFilePath(baseDirReal, kind, id);
}

function isValidBootstrapLockMetadata(v: unknown): v is BootstrapLockMetadata {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    o.schemaVersion === 1 &&
    typeof o.pid === "number" &&
    Number.isInteger(o.pid) &&
    o.pid > 0 &&
    typeof o.processStartedAtMs === "number" &&
    Number.isFinite(o.processStartedAtMs) &&
    typeof o.lockId === "string" &&
    o.lockId.length > 0 &&
    typeof o.createdAt === "string"
  );
}

const MAX_BOOTSTRAP_LOCK_ACQUIRE_ATTEMPTS = 5;

type AcquireBootstrapLockResult = { ok: true; filePath: string; lockId: string } | { ok: false; detail: string };

/**
 * (kind, id) 하나에 대한 exclusive lock을 원자적으로 얻는다(wx create 자체의 원자성에
 * 의존 — check-then-create 아님, project-lock.ts와 동일한 원칙). 이미 살아있는 다른
 * owner가 있으면 즉시 실패(대기하지 않음 — 이 모듈은 완전히 동기적이라 진짜 대기를
 * 구현할 수 없고, 짧은 재시도로 흉내내지 않는다: 호출자가 나중에 다시 시도하면 된다).
 * owner가 죽었다고 증명되면(assessOwnerLiveness) 안전하게 밀어내고 재시도한다.
 */
function acquireBootstrapLock(baseDirReal: string, kind: BootstrapLockKind, id: string): AcquireBootstrapLockResult {
  // GPT Independent Reviewer 지적(SI-2 REVISE 6회차, CRITICAL) — 이미 존재하는
  // `.autodev-bootstrap-locks`가 symlink/junction으로 baseDirReal 밖을 가리키면 lock
  // 생성/판정 자체가 trusted base 밖에서 일어날 수 있다 — 사용하기 전에 먼저 확인한다.
  const lockDirCheck = assertExistingSubPathContained(baseDirReal, baseDirReal, ".autodev-bootstrap-locks");
  if (!lockDirCheck.ok) return { ok: false, detail: lockDirCheck.detail };
  const filePath = bootstrapLockFilePath(baseDirReal, kind, id);
  const pid = process.pid;
  const processStartedAtMs = Date.now() - Math.round(process.uptime() * 1000);

  for (let attempt = 0; attempt < MAX_BOOTSTRAP_LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    try {
      mkdirSync(bootstrapLockDir(baseDirReal), { recursive: true });
    } catch (e) {
      return { ok: false, detail: `bootstrap lock 디렉터리 생성 실패: ${e instanceof Error ? e.message : String(e)}` };
    }
    const lockId = randomUUID();
    const metadata: BootstrapLockMetadata = { schemaVersion: 1, pid, processStartedAtMs, lockId, createdAt: new Date().toISOString() };
    try {
      writeFileSync(filePath, JSON.stringify(metadata, null, 2) + "\n", { encoding: "utf-8", flag: "wx" });
      return { ok: true, filePath, lockId };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        return { ok: false, detail: `bootstrap lock 생성 실패: ${err instanceof Error ? err.message : String(err)}` };
      }
    }

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      continue; // 방금 사라짐(release됨) — 재시도.
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, detail: "bootstrap lock 파일이 손상되었습니다(JSON 파싱 실패) — 자동 삭제하지 않고 중단합니다." };
    }
    if (!isValidBootstrapLockMetadata(parsed)) {
      return { ok: false, detail: "bootstrap lock 파일이 예상된 schema와 일치하지 않습니다 — 자동 삭제하지 않고 중단합니다." };
    }
    if (parsed.pid === pid) {
      // 같은 프로세스의 재진입 — 이전 lock을 정리하고 재시도한다(같은 프로세스가 동시에
      // 두 번째 writer일 수는 없다, project-lock.ts와 동일한 원칙).
      try {
        unlinkSync(filePath);
      } catch {
        /* 무시 — 다음 attempt의 wx create가 최종 판정한다. */
      }
      continue;
    }
    const verdict: LivenessVerdict = assessOwnerLiveness(parsed.pid, parsed.processStartedAtMs);
    if (verdict.verdict === "ALIVE") {
      return { ok: false, detail: `다른 프로세스(pid=${parsed.pid})가 이미 이 ${kind}("${id}")에 대한 bootstrap을 진행 중입니다 — 나중에 다시 시도하세요.` };
    }
    if (verdict.verdict === "UNCERTAIN") {
      return { ok: false, detail: `기존 bootstrap lock owner(pid=${parsed.pid})의 생존 여부를 확인할 수 없습니다.` };
    }
    // STALE로 증명됨 — 밀어내고 재시도.
    try {
      unlinkSync(filePath);
    } catch {
      /* 무시 — 다음 attempt/다른 프로세스가 최종 판정한다. */
    }
  }
  return { ok: false, detail: `bootstrap lock 획득을 ${MAX_BOOTSTRAP_LOCK_ACQUIRE_ATTEMPTS}회 시도했지만 확정하지 못했습니다.` };
}

/** "내가 잡은 lock"만 release한다(lockId 일치 확인) — project-lock.ts의
 *  releaseProjectLock()과 동일한 원칙(다른 owner의 lock을 절대 지우지 않음). */
function releaseBootstrapLock(filePath: string, lockId: string): void {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (isValidBootstrapLockMetadata(parsed) && parsed.lockId === lockId) {
      unlinkSync(filePath);
    }
  } catch {
    // best-effort — release 실패는 치명적이지 않다(다음 attempt가 staleness로 복구 가능).
  }
}

// ---------------------------------------------------------------------------
// 신뢰 경계 파싱 — rawInput은 이 시점에 이미 evaluateSpecIntake()가 REJECT가 아닌 결정을
// 내린 정확히 동일한 문자열이다. SI-1의 게이트(SPEC_NOT_APPROVED/해시 대조/unknown field 등)를
// 다시 구현하지 않는다 — 그 결정이 이미 이 문자열의 구조/값을 전부 보증하므로, 여기서는
// JSON.parse로 이미 검증된 필드를 그대로 꺼내기만 한다.
// ---------------------------------------------------------------------------

function parseTrustedEnvelope(rawInput: string): HandoffEnvelope {
  return JSON.parse(rawInput) as HandoffEnvelope;
}

// ---------------------------------------------------------------------------
// 진입점
// ---------------------------------------------------------------------------

export function bootstrapProject(rawInput: unknown, config: BootstrapTrustedConfig): BootstrapOutcome {
  const cfgCheck = validateBootstrapConfig(config);
  if (!cfgCheck.ok) return { status: "BLOCKED", code: "INVALID_CONFIG", detail: cfgCheck.reason };

  const decision = evaluateSpecIntake(rawInput);
  if (decision.decision === "REJECT") {
    return { status: "REJECTED", reasons: decision.reasons };
  }

  const envelope = parseTrustedEnvelope(rawInput as string);
  const spec = envelope.spec;
  const integrity = { algorithm: spec.specIntegrity.algorithm, hash: spec.specIntegrity.hash.toLowerCase() };
  const identity: BootstrapRequestIdentity = {
    handoffId: envelope.handoffId,
    projectId: spec.projectId,
    specVersion: spec.specVersion,
    specIntegrityAlgorithm: integrity.algorithm,
    specIntegrityHash: integrity.hash,
  };

  // GPT Independent Reviewer 지적(SI-2 REVISE 4~5회차, HIGH) — 이 지점부터(handoffId
  // conflict 판정 → content 검증 → project root 존재 확인/생성 → state/spec/git write)
  // 전부를 handoffId lock + projectId lock 두 개로 감싼다. projectId lock 하나만으로는
  // 같은 handoffId를 서로 다른 projectId로 동시에 bootstrap하는 두 호출을 직렬화하지
  // 못했다(서로 다른 lock을 각자 얻어 handoff index 부재를 동시에 관찰할 수 있었다) —
  // 항상 고정된 순서(handoff 먼저, project 다음)로 두 lock을 모두 얻어(교착 방지)
  // handoffId가 같은 호출과 projectId가 같은 호출 양쪽 모두를 직렬화한다.
  const handoffLockAcquire = acquireBootstrapLock(cfgCheck.baseDirReal, "handoff", identity.handoffId);
  if (!handoffLockAcquire.ok) {
    return { status: "BLOCKED", code: "CONCURRENT_BOOTSTRAP_IN_PROGRESS", detail: handoffLockAcquire.detail };
  }
  try {
    const projectLockAcquire = acquireBootstrapLock(cfgCheck.baseDirReal, "project", identity.projectId);
    if (!projectLockAcquire.ok) {
      return { status: "BLOCKED", code: "CONCURRENT_BOOTSTRAP_IN_PROGRESS", detail: projectLockAcquire.detail };
    }
    try {
      return bootstrapProjectLocked(decision, envelope, spec, integrity, identity, config, cfgCheck.baseDirReal);
    } finally {
      releaseBootstrapLock(projectLockAcquire.filePath, projectLockAcquire.lockId);
    }
  } finally {
    releaseBootstrapLock(handoffLockAcquire.filePath, handoffLockAcquire.lockId);
  }
}

/** bootstrapProject()가 projectId 단위 lock을 잡은 뒤에만 호출하는 실제 판정/실행 본체 —
 *  lock 밖에서 이미 확정된 config/decision/envelope/identity를 그대로 받는다. */
function bootstrapProjectLocked(
  decision: Extract<ReturnType<typeof evaluateSpecIntake>, { decision: "ACCEPT" | "ACCEPT_PENDING_CONTENT_VERIFICATION" }>,
  envelope: HandoffEnvelope,
  spec: MasterSpecIntake,
  integrity: { algorithm: "sha256" | "sha512"; hash: string },
  identity: BootstrapRequestIdentity,
  config: BootstrapTrustedConfig,
  baseDirReal: string
): BootstrapOutcome {
  // handoffId 단위 conflict guard — projectId가 달라 project root 폴더 자체가 겹치지 않는
  // 경우까지 잡는다(§ 요구사항 6, § handoffIndexDir 상단 주석).
  const indexRead = readHandoffIndexEntry(baseDirReal, identity.handoffId);
  if (indexRead.kind === "corrupt") {
    return { status: "BLOCKED", code: "CORRUPT_HANDOFF_INDEX", detail: indexRead.detail };
  }
  if (indexRead.kind === "valid" && !identitiesMatch(indexRead.entry, identity)) {
    return {
      status: "CONFLICT",
      detail: "같은 handoffId가 이전에 다른 identity(projectId/specVersion/specIntegrity)로 이미 사용되었습니다.",
      existingIdentity: indexRead.entry,
      requestedIdentity: identity,
    };
  }

  let verifiedContent: string;
  let provenance: BootstrapContentProvenance;
  if (decision.decision === "ACCEPT") {
    verifiedContent = spec.specContent as string;
    provenance = { sourceKind: "INLINE" };
  } else {
    if (!config.specContentRefSourceRoot) {
      return {
        status: "BLOCKED",
        code: "MISSING_SOURCE_ROOT",
        detail: "specContentRef 검증을 위한 trusted source root(config.specContentRefSourceRoot)가 지정되지 않았습니다.",
      };
    }
    const verify = verifySpecContentRefFile(config.specContentRefSourceRoot, decision.specContentRef, integrity);
    if (!verify.ok) return { status: "BLOCKED", code: verify.code, detail: verify.detail };
    verifiedContent = verify.content;
    provenance = { sourceKind: "CONTENT_REF", sourceRef: decision.specContentRef };
  }

  const rootCheck = resolveProjectRootPath(baseDirReal, identity.projectId);
  if (!rootCheck.ok) return { status: "BLOCKED", code: rootCheck.code, detail: rootCheck.detail };
  const projectRoot = rootCheck.path;

  const MAX_CREATE_RACE_ATTEMPTS = 2;
  for (let attempt = 0; attempt < MAX_CREATE_RACE_ATTEMPTS; attempt++) {
    if (existsSync(projectRoot)) {
      const existing = evaluateExistingProjectRoot(projectRoot, identity, baseDirReal);
      if ("outcome" in existing) return existing.outcome;
      writeHandoffIndexEntryBestEffort(baseDirReal, identity, projectRoot);
      return advanceBootstrap(projectRoot, existing.state, verifiedContent, spec, envelope, provenance, config, baseDirReal);
    }
    try {
      mkdirSync(projectRoot);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue; // race — 다음 루프에서 existsSync 분기로 재평가
      return { status: "BLOCKED", code: "PROJECT_ROOT_CREATE_FAILED", detail: `project root 생성 실패: ${e instanceof Error ? e.message : String(e)}` };
    }
    const initialState: BootstrapStateFile = {
      schemaVersion: BOOTSTRAP_STATE_SCHEMA_VERSION,
      identity,
      stage: "PROJECT_ROOT_CREATED",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const w = writeBootstrapStateAtomic(projectRoot, initialState);
    if (!w.ok) return { status: "WAITING_HUMAN", projectRoot, stage: "PROJECT_ROOT_CREATED", detail: w.detail };
    writeHandoffIndexEntryBestEffort(baseDirReal, identity, projectRoot);
    return advanceBootstrap(projectRoot, initialState, verifiedContent, spec, envelope, provenance, config, baseDirReal);
  }
  return { status: "BLOCKED", code: "PROJECT_ROOT_CREATE_FAILED", detail: "project root 생성 경쟁 상태(race)를 해결하지 못했습니다." };
}
