import { createHash } from "node:crypto";
import { scanContentForSecrets } from "./secret-scanner";

// AutoDev Core 선행 업그레이드 — Spec Intake Contract & Validation Foundation (SI-1).
//
// ProjectManifest(project-manifest.ts)는 targetProjectRoot/taskRegistry가 이미 존재한다고
// 가정한다 — "새 프로젝트를 어떻게 시작하는가"는 Core 어디에도 없었다. 이 모듈은 그 앞단,
// 외부에서 APPROVED된 Master Spec/Handoff를 AutoDev가 받아들일지 판정하는 data-only 계약과
// deterministic validator다. 새 프로젝트 폴더 생성/Git init/Planner LLM 호출/Task Registry
// 자동 생성/run.ts 연결은 범위 밖이다(SI-2/SI-3).
//
// 신뢰 경계: evaluateSpecIntake()는 오직 JSON 문자열만 받는다(project-adapter-loader.ts가
// project config를 readFileSync+JSON.parse로만 읽는 것과 동일한 원칙). `unknown` 객체
// 그래프를 직접 reflection(Object.getPrototypeOf/Object.keys/getOwnPropertyDescriptor)으로
// 검사하는 방식은 Proxy trap 실행·revoked Proxy의 즉시 throw를 막을 수 없어 포기했다 —
// `typeof`는 명세상 어떤 trap도 호출하지 않으므로, 문자열이 아닌 입력(Proxy 포함)은 그
// 무엇도 건드리지 않고 즉시 REJECT한다. 문자열이면 길이 상한을 먼저 확인한 뒤에만
// JSON.parse를 시도한다 — 그 출력은 ECMA-262 명세상 항상 순수 데이터(getter/setter/
// symbol/non-enumerable/Proxy 없음)라 파싱 이후에는 이 공격이 구조적으로 성립하지 않는다.
// 함수 전체를 try/catch로 감싸 어떤 경로로도 throw하지 않는다(정상 경로에서는 미발동).
// (알려진 제약: JSON.parse는 중복 top-level key를 마지막 값으로 조용히 병합한다 — 이
// 모듈이 파싱된 구조에 대한 유일한 신뢰 경계이므로, 동일 원문 텍스트를 다른 파서가 다르게
// 해석해 판정을 우회하는 상황은 여기서 발생하지 않는다.)
//
// dependency-scanner.ts/capability-resolver.ts와 동일하게 throw 대신 verdict 객체를
// 반환한다 — 첫 실패에서 멈추지 않고 위반 사항을 전부 모아 REJECT에 담는다. 애매한 값은
// 항상 REJECT("판단 불가를 PASS로 처리하지 않는다"). specContentRef처럼 이 Task가 파일을
// 열어보지 않아 완전히 검증할 수 없는 경로는 일반 ACCEPT가 아니라
// ACCEPT_PENDING_CONTENT_VERIFICATION으로 구분한다(§ SpecIntakeDecision).
//
// Safe Executor/Secret Scanner/Dependency Scanner/Core Command Safety Gate/Human Gate를
// 우회하지 않는다 — specContent는 secret-scanner.ts의 SECRET_CONTENT_PATTERNS로 재검사해
// secret 모양 문자열이 있으면 REJECT한다(매칭 원문은 결과에 담지 않음). specContent가
// 인라인 제공되면(이미 메모리에 있으므로) node:crypto로 실제 digest를 계산해
// specIntegrity.hash와 대조한다(불일치 시 SPEC_INTEGRITY_MISMATCH) — specContentRef는
// 파일 내용이 없으므로 형식만 검증하고 실제 대조는 SI-2가 한다.
//
// 입력 크기는 항상 유한하게 제한된다(정규식/순회/digest 비용 DoS 방지) — 길이(싼 검사)를
// trim/정규식/digest 계산(비싼 연산)보다 항상 먼저 확인한다. REJECT detail에도 외부 원문
// (필드명 등)을 그대로 담지 않는다(sanitizeFieldName()으로 먼저 잘라낸 뒤 허용 문자만 남김).
//
// JARVIS/MOVAN/BILLION 같은 특정 프로젝트는 이 파일 어디에도 하드코딩하지 않는다.

// ---------------------------------------------------------------------------
// 데이터 계약
// ---------------------------------------------------------------------------

/** spec 자신의 승인 상태. APPROVED만 Intake Gate를 통과할 수 있다 — 나머지는 알려진
 *  값이라도 항상 REJECT(SPEC_NOT_APPROVED)다. */
export type SpecStatus = "DRAFT" | "REVIEW_REQUIRED" | "APPROVED" | "REJECTED";

/** 사람이 이 spec을 최종 승인했는지 여부. PASS만 통과한다. */
export type UserApprovalStatus = "PASS" | "FAIL" | "PENDING";

/** GPT/사람 리뷰어가 이 spec에 남긴 severity별 미해결 건수. critical/high는 반드시 0이어야
 *  Intake를 통과한다(review-policy.ts의 ALWAYS_HUMAN 계열과 동일한 "critical/high는
 *  타협 불가" 원칙). */
export interface ReviewerGateCounts {
  critical: number;
  high: number;
}

/** sha256/sha512 hex digest만 지원한다. specContent가 인라인으로 제공되면 이 hash와
 *  실제 digest를 즉시 대조한다(SPEC_INTEGRITY_MISMATCH) — specContentRef 경로는 파일
 *  내용이 아직 없으므로 형식만 검증한다(SI-2가 실제 파일을 읽을 때 재검증한다). */
export interface SpecIntegrity {
  algorithm: "sha256" | "sha512";
  hash: string;
}

const INTEGRITY_HASH_LENGTH: Record<SpecIntegrity["algorithm"], number> = {
  sha256: 64,
  sha512: 128,
};

/** 외부에서 전달된 Master Spec 본문 + 그 spec에 대한 승인/리뷰 상태를 함께 담는 데이터
 *  계약. specContent(인라인 전문) 또는 specContentRef(안전한 상대경로 참조) 중 정확히
 *  하나만 지정한다 — 실행 가능한 코드/URL/원격 참조는 여기 표현할 수 없다. */
export interface MasterSpecIntake {
  projectId: string;
  projectName: string;
  specVersion: string;
  specStatus: SpecStatus;
  userApproval: UserApprovalStatus;
  reviewerGate: ReviewerGateCounts;
  unresolvedCriticalCount: number;
  contradictionCount: number;
  specIntegrity: SpecIntegrity;
  specContent?: string;
  specContentRef?: string;
}

/** AutoDev가 실제로 받는 최상위 페이로드. handoffId는 이 특정 인계(handoff) 시도 자체를
 *  식별하는 별도 id다 — projectId(프로젝트 자체의 식별자)와는 다른 공간이다.
 *  evaluateSpecIntake()는 이 형태의 JSON을 직렬화한 "문자열"을 입력으로 받는다(§ 신뢰
 *  경계 설계). */
export interface HandoffEnvelope {
  handoffId: string;
  spec: MasterSpecIntake;
}

const MASTER_SPEC_INTAKE_KEYS = new Set<keyof MasterSpecIntake>([
  "projectId",
  "projectName",
  "specVersion",
  "specStatus",
  "userApproval",
  "reviewerGate",
  "unresolvedCriticalCount",
  "contradictionCount",
  "specIntegrity",
  "specContent",
  "specContentRef",
]);

const HANDOFF_ENVELOPE_KEYS = new Set<keyof HandoffEnvelope>(["handoffId", "spec"]);
const REVIEWER_GATE_KEYS = new Set(["critical", "high"]);
const SPEC_INTEGRITY_KEYS = new Set(["algorithm", "hash"]);

const KNOWN_SPEC_STATUSES: ReadonlySet<SpecStatus> = new Set(["DRAFT", "REVIEW_REQUIRED", "APPROVED", "REJECTED"]);
const KNOWN_USER_APPROVAL_STATUSES: ReadonlySet<UserApprovalStatus> = new Set(["PASS", "FAIL", "PENDING"]);
const KNOWN_INTEGRITY_ALGORITHMS: ReadonlySet<SpecIntegrity["algorithm"]> = new Set(["sha256", "sha512"]);

// 입력 크기 상한 — DoS 방지. 길이(싼 검사)를 trim/정규식/digest(비싼 연산)보다 항상
// 먼저 확인한다. 상한을 넘기면 "판단 불가"로 REJECT한다(관대한 fallback 없음).
const MAX_ENVELOPE_JSON_CHARS = 6_000_000;
const MAX_OBJECT_TOP_LEVEL_KEYS = 64;
// Phase D(SI-2) — export된다: project-bootstrap.ts가 specContentRef 실제 파일 검증에서
// 이 상한을 재사용한다(값을 복제하지 않는다).
export const MAX_SPEC_CONTENT_CHARS = 2_000_000;
const MAX_SPEC_CONTENT_REF_CHARS = 1024;
const MAX_SPEC_VERSION_CHARS = 32;
const UNKNOWN_FIELD_NAME_MAX_LEN = 64;
// sanitizeFieldName()이 정규식 치환 전에 먼저 잘라내는 원문 상한(비정상적으로 긴 key라도
// 정규식 비용이 입력 크기에 비례해 커지지 않게 한다).
const FIELD_NAME_RAW_PREFIX_LEN = 256;

// Phase D(SI-2) — export된다: project-bootstrap.ts가 project root 폴더명(projectId) 방어에
// 이 목록을 재사용한다(값을 복제하지 않는다).
export const RESERVED_WINDOWS_DEVICE_NAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

// ---------------------------------------------------------------------------
// 판정 결과
// ---------------------------------------------------------------------------

export type SpecIntakeRejectReasonCode =
  | "INVALID_ENVELOPE"
  | "UNKNOWN_ENVELOPE_FIELD"
  | "INVALID_HANDOFF_ID"
  | "INVALID_SPEC_OBJECT"
  | "UNKNOWN_SPEC_FIELD"
  | "INVALID_PROJECT_ID"
  | "INVALID_PROJECT_NAME"
  | "INVALID_SPEC_VERSION"
  | "INVALID_SPEC_STATUS"
  | "SPEC_NOT_APPROVED"
  | "INVALID_USER_APPROVAL"
  | "USER_APPROVAL_NOT_PASS"
  | "INVALID_REVIEWER_GATE"
  | "REVIEWER_CRITICAL_NOT_ZERO"
  | "REVIEWER_HIGH_NOT_ZERO"
  | "INVALID_UNRESOLVED_CRITICAL_COUNT"
  | "UNRESOLVED_CRITICAL_NOT_ZERO"
  | "INVALID_CONTRADICTION_COUNT"
  | "CONTRADICTION_NOT_ZERO"
  | "INVALID_SPEC_INTEGRITY"
  | "SPEC_INTEGRITY_MISMATCH"
  | "MISSING_SPEC_CONTENT"
  | "AMBIGUOUS_SPEC_CONTENT"
  | "SPEC_CONTENT_TOO_LARGE"
  | "INVALID_SPEC_CONTENT_REF"
  | "SUSPECTED_SECRET_IN_SPEC_CONTENT"
  | "VALIDATION_ERROR";

export interface SpecIntakeRejectReason {
  code: SpecIntakeRejectReasonCode;
  detail: string;
}

/** specContentRef 경로는 이 Task에서 파일시스템에 전혀 접근하지 않으므로(§ 파일 상단),
 *  참조된 파일의 실제 내용이 specIntegrity.hash와 일치하는지 확인할 방법이 없다 — 그런데도
 *  이를 일반 "ACCEPT"로 반환하면 호출자가 "완전히 검증됨"으로 오인해, 승인 이후 참조 파일이
 *  바뀌거나 symlink로 다른 내용을 가리켜도 이를 감지하지 못할 위험이 있다(GPT Independent
 *  Reviewer 지적). 따라서 게이트/형식 검증은 전부 통과했지만 참조 콘텐츠의 실제 digest
 *  대조는 아직 없었다는 사실을 타입 수준에서 명시적으로 구분한다 — SI-2가 실제로 그 파일을
 *  안전하게 읽어 digest를 재검증하기 전까지는 절대 "ACCEPT"로 격상되지 않는다. */
export type SpecIntakeDecision =
  | { decision: "ACCEPT"; handoffId: string; projectId: string; specVersion: string }
  | {
      decision: "ACCEPT_PENDING_CONTENT_VERIFICATION";
      handoffId: string;
      projectId: string;
      specVersion: string;
      /** SI-2가 안전하게 resolve해 실제 digest를 재검증해야 하는 참조(형식만 검증됨). */
      specContentRef: string;
    }
  | { decision: "REJECT"; reasons: SpecIntakeRejectReason[] };

function reject(code: SpecIntakeRejectReasonCode, detail: string): SpecIntakeDecision {
  return { decision: "REJECT", reasons: [{ code, detail }] };
}

// ---------------------------------------------------------------------------
// 순수 형식 검증 helper — 전부 파일시스템/네트워크 접근 없이 문자열/숫자 구조만 본다.
// ---------------------------------------------------------------------------

/** 외부에서 온 필드명을 REJECT detail에 담기 전에 항상 거치는 sanitizer — 먼저 원문을
 *  짧게 잘라(정규식 비용을 입력 크기에 비례해 키우지 않기 위함) 허용 문자(영문/숫자/
 *  `_`/`.`/`-`) 외에는 `?`로 치환하고, 최종 길이도 다시 제한한다. secret/제어문자/개행이
 *  포함된 필드명이 그대로 로그·결과에 노출되는 것을 막는다. */
function sanitizeFieldName(name: string): string {
  const rawPrefix = name.length > FIELD_NAME_RAW_PREFIX_LEN ? name.slice(0, FIELD_NAME_RAW_PREFIX_LEN) : name;
  const cleaned = rawPrefix.replace(/[^A-Za-z0-9_.-]/g, "?");
  return cleaned.length > UNKNOWN_FIELD_NAME_MAX_LEN ? `${cleaned.slice(0, UNKNOWN_FIELD_NAME_MAX_LEN)}…` : cleaned;
}

type SnapshotOutcome = { ok: true; data: Record<string, unknown> } | { ok: false; reason: string };

/** JSON.parse() 출력(이 함수의 유일한 호출 경로)을 순수 데이터 객체로 좁힌다 — 명세상
 *  이미 안전하지만(accessor/symbol/non-enumerable 없음), 필드 개수 상한만 추가로
 *  강제한다(대용량 객체 순회 비용 DoS 방지). 성공하면 null-prototype 복사본을 반환한다. */
function toSafeDataSnapshot(v: unknown): SnapshotOutcome {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { ok: false, reason: "비어있거나 객체가 아닙니다." };
  }
  const keys = Object.keys(v);
  if (keys.length > MAX_OBJECT_TOP_LEVEL_KEYS) {
    return { ok: false, reason: `필드 개수가 너무 많습니다(최대 ${MAX_OBJECT_TOP_LEVEL_KEYS}개).` };
  }
  const data: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    data[key] = (v as Record<string, unknown>)[key];
  }
  return { ok: true, data };
}

/** 사람이 읽는 이름(projectName)이 아니라 projectId/handoffId처럼 나중에 폴더명/식별자로
 *  쓰일 수 있는 값을 위한 안전한 slug 형식이다(영문/숫자/`-`/`_`만, 4~128자) — path
 *  traversal이나 특수문자를 원천적으로 배제한다. */
function isSafeIdentifier(value: unknown, minLen: number, maxLen: number): value is string {
  if (typeof value !== "string") return false;
  if (value.length < minLen || value.length > maxLen) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

/** 길이(싼 검사)를 먼저 확인한 뒤에만 trim()(더 비싼 연산)을 수행한다. */
function isNonEmptyTrimmedString(value: unknown, maxLen: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLen) return false;
  return value.trim().length > 0;
}

/** major.minor[.patch] 형태만 유효한 specVersion으로 인정한다 — 임의 자유 문자열은
 *  "버전"으로서의 정렬/비교 의미가 없어 거부한다. 길이부터 먼저 제한해 정규식 검사
 *  자체가 임의로 큰 입력을 훑지 않게 한다. */
function isValidSpecVersion(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SPEC_VERSION_CHARS) return false;
  return /^\d+\.\d+(\.\d+)?$/.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** project-adapter-loader.ts와 동일한 상대경로 규칙(절대경로/드라이브/UNC/".." 거부) +
 *  길이 상한/NUL·제어문자/NTFS ADS("name:stream")/Windows 예약 장치명 거부 — 나중에(SI-2)
 *  실제 파일 경로로 resolve될 수 있는 참조라서 미리 형식만 걸러낸다(파일시스템 접근 없음).
 *  Phase D(SI-2) — export된다: project-bootstrap.ts가 specContentRef를 실제로 resolve하기
 *  전에 이 동일한 형식 검증을 재사용한다(정규식/규칙을 복제하지 않는다, defense-in-depth). */
export function isSafeRelativeSpecRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_SPEC_CONTENT_REF_CHARS) return false;
  if (value.trim().length === 0) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(value)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (/^\\\\/.test(value) || /^\/\/[^/]/.test(value)) return false;
  const segments = value.split(/[\\/]/);
  if (segments.some((s) => s.length === 0)) return false;
  if (segments.includes("..")) return false;
  for (const seg of segments) {
    if (seg.includes(":")) return false;
    if (/[ .]$/.test(seg)) return false;
    const base = seg.split(".")[0].toLowerCase();
    if (RESERVED_WINDOWS_DEVICE_NAMES.has(base)) return false;
  }
  return true;
}

function checkUnknownFields(
  data: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  code: SpecIntakeRejectReasonCode,
  label: string,
  reasons: SpecIntakeRejectReason[]
): void {
  for (const key of Object.keys(data)) {
    if (!allowed.has(key)) {
      reasons.push({ code, detail: `${label}에 알 수 없는 필드가 있습니다: "${sanitizeFieldName(key)}"` });
    }
  }
}

/** specContent의 실제 sha256/sha512 hex digest — 순수 계산(파일시스템/네트워크 없음). */
function computeContentDigestHex(algorithm: SpecIntegrity["algorithm"], content: string): string {
  return createHash(algorithm).update(content, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Intake Gate
// ---------------------------------------------------------------------------

function evaluateParsedEnvelope(parsed: unknown): SpecIntakeDecision {
  const reasons: SpecIntakeRejectReason[] = [];

  const envelopeSnapshot = toSafeDataSnapshot(parsed);
  if (!envelopeSnapshot.ok) {
    return reject("INVALID_ENVELOPE", `HandoffEnvelope가 유효하지 않습니다: ${envelopeSnapshot.reason}`);
  }
  const envelope = envelopeSnapshot.data;

  checkUnknownFields(envelope, HANDOFF_ENVELOPE_KEYS, "UNKNOWN_ENVELOPE_FIELD", "HandoffEnvelope", reasons);

  const handoffId = envelope.handoffId;
  if (!isSafeIdentifier(handoffId, 8, 128)) {
    reasons.push({
      code: "INVALID_HANDOFF_ID",
      detail: "handoffId가 비어있거나 형식이 올바르지 않습니다(영문/숫자/-/_ 8~128자).",
    });
  }

  const specSnapshot = toSafeDataSnapshot(envelope.spec);
  if (!specSnapshot.ok) {
    reasons.push({ code: "INVALID_SPEC_OBJECT", detail: `spec이 유효하지 않습니다: ${specSnapshot.reason}` });
    return { decision: "REJECT", reasons };
  }
  const spec = specSnapshot.data;

  checkUnknownFields(spec, MASTER_SPEC_INTAKE_KEYS, "UNKNOWN_SPEC_FIELD", "MasterSpecIntake", reasons);

  const projectId = spec.projectId;
  if (!isSafeIdentifier(projectId, 2, 128)) {
    reasons.push({
      code: "INVALID_PROJECT_ID",
      detail: "spec.projectId가 비어있거나 형식이 올바르지 않습니다(영문/숫자/-/_ 2~128자).",
    });
  }

  if (!isNonEmptyTrimmedString(spec.projectName, 256)) {
    reasons.push({ code: "INVALID_PROJECT_NAME", detail: "spec.projectName이 비어있거나 너무 깁니다." });
  }

  const specVersion = spec.specVersion;
  if (!isValidSpecVersion(specVersion)) {
    reasons.push({
      code: "INVALID_SPEC_VERSION",
      detail: "spec.specVersion이 비어있거나 major.minor[.patch] 형식이 아니거나 너무 깁니다.",
    });
  }

  const specStatus = spec.specStatus;
  if (typeof specStatus !== "string" || !KNOWN_SPEC_STATUSES.has(specStatus as SpecStatus)) {
    reasons.push({
      code: "INVALID_SPEC_STATUS",
      detail: `spec.specStatus가 알려진 값이 아닙니다(허용: ${[...KNOWN_SPEC_STATUSES].join(", ")}).`,
    });
  } else if (specStatus !== "APPROVED") {
    reasons.push({ code: "SPEC_NOT_APPROVED", detail: `spec.specStatus가 APPROVED가 아닙니다(현재: ${specStatus}).` });
  }

  const userApproval = spec.userApproval;
  if (typeof userApproval !== "string" || !KNOWN_USER_APPROVAL_STATUSES.has(userApproval as UserApprovalStatus)) {
    reasons.push({
      code: "INVALID_USER_APPROVAL",
      detail: `spec.userApproval이 알려진 값이 아닙니다(허용: ${[...KNOWN_USER_APPROVAL_STATUSES].join(", ")}).`,
    });
  } else if (userApproval !== "PASS") {
    reasons.push({ code: "USER_APPROVAL_NOT_PASS", detail: `spec.userApproval이 PASS가 아닙니다(현재: ${userApproval}).` });
  }

  const reviewerGateSnapshot = toSafeDataSnapshot(spec.reviewerGate);
  if (!reviewerGateSnapshot.ok) {
    reasons.push({
      code: "INVALID_REVIEWER_GATE",
      detail: `spec.reviewerGate가 { critical: number>=0, high: number>=0 } 형태가 아닙니다: ${reviewerGateSnapshot.reason}`,
    });
  } else {
    const reviewerGate = reviewerGateSnapshot.data;
    checkUnknownFields(reviewerGate, REVIEWER_GATE_KEYS, "INVALID_REVIEWER_GATE", "spec.reviewerGate", reasons);
    if (!isNonNegativeInteger(reviewerGate.critical) || !isNonNegativeInteger(reviewerGate.high)) {
      reasons.push({
        code: "INVALID_REVIEWER_GATE",
        detail: "spec.reviewerGate.critical/high가 0 이상의 정수가 아닙니다.",
      });
    } else {
      if (reviewerGate.critical !== 0) {
        reasons.push({ code: "REVIEWER_CRITICAL_NOT_ZERO", detail: `spec.reviewerGate.critical이 0이 아닙니다(현재: ${reviewerGate.critical}).` });
      }
      if (reviewerGate.high !== 0) {
        reasons.push({ code: "REVIEWER_HIGH_NOT_ZERO", detail: `spec.reviewerGate.high가 0이 아닙니다(현재: ${reviewerGate.high}).` });
      }
    }
  }

  const unresolvedCriticalCount = spec.unresolvedCriticalCount;
  if (!isNonNegativeInteger(unresolvedCriticalCount)) {
    reasons.push({ code: "INVALID_UNRESOLVED_CRITICAL_COUNT", detail: "spec.unresolvedCriticalCount가 0 이상의 정수가 아닙니다." });
  } else if (unresolvedCriticalCount !== 0) {
    reasons.push({
      code: "UNRESOLVED_CRITICAL_NOT_ZERO",
      detail: `spec.unresolvedCriticalCount가 0이 아닙니다(현재: ${unresolvedCriticalCount}).`,
    });
  }

  const contradictionCount = spec.contradictionCount;
  if (!isNonNegativeInteger(contradictionCount)) {
    reasons.push({ code: "INVALID_CONTRADICTION_COUNT", detail: "spec.contradictionCount가 0 이상의 정수가 아닙니다." });
  } else if (contradictionCount !== 0) {
    reasons.push({ code: "CONTRADICTION_NOT_ZERO", detail: `spec.contradictionCount가 0이 아닙니다(현재: ${contradictionCount}).` });
  }

  // specIntegrity 형식이 완전히 유효할 때만 validIntegrity를 채운다 — 아래 specContent
  // 처리 단계가 "형식이 맞을 때만" 실제 digest 대조(SPEC_INTEGRITY_MISMATCH)를 시도한다.
  let validIntegrity: SpecIntegrity | null = null;
  const specIntegritySnapshot = toSafeDataSnapshot(spec.specIntegrity);
  if (!specIntegritySnapshot.ok) {
    reasons.push({
      code: "INVALID_SPEC_INTEGRITY",
      detail: `spec.specIntegrity가 { algorithm: "sha256"|"sha512", hash: string } 형태가 아닙니다: ${specIntegritySnapshot.reason}`,
    });
  } else {
    const specIntegrity = specIntegritySnapshot.data;
    checkUnknownFields(specIntegrity, SPEC_INTEGRITY_KEYS, "INVALID_SPEC_INTEGRITY", "spec.specIntegrity", reasons);
    const algorithm = specIntegrity.algorithm;
    const hash = specIntegrity.hash;
    if (typeof algorithm !== "string" || !KNOWN_INTEGRITY_ALGORITHMS.has(algorithm as SpecIntegrity["algorithm"]) || typeof hash !== "string") {
      reasons.push({
        code: "INVALID_SPEC_INTEGRITY",
        detail: "spec.specIntegrity.algorithm/hash가 올바르지 않습니다.",
      });
    } else {
      const expectedLen = INTEGRITY_HASH_LENGTH[algorithm as SpecIntegrity["algorithm"]];
      const hashPattern = new RegExp(`^[0-9a-f]{${expectedLen}}$`, "i");
      if (hash.length !== expectedLen || !hashPattern.test(hash)) {
        reasons.push({
          code: "INVALID_SPEC_INTEGRITY",
          detail: `spec.specIntegrity.hash가 ${algorithm} 형식(hex ${expectedLen}자)이 아닙니다.`,
        });
      } else {
        validIntegrity = { algorithm: algorithm as SpecIntegrity["algorithm"], hash: hash.toLowerCase() };
      }
    }
  }

  const hasSpecContent = spec.specContent !== undefined;
  const hasSpecContentRef = spec.specContentRef !== undefined;
  if (!hasSpecContent && !hasSpecContentRef) {
    reasons.push({ code: "MISSING_SPEC_CONTENT", detail: "spec.specContent 또는 spec.specContentRef 중 하나가 반드시 있어야 합니다." });
  } else if (hasSpecContent && hasSpecContentRef) {
    reasons.push({ code: "AMBIGUOUS_SPEC_CONTENT", detail: "spec.specContent와 spec.specContentRef를 동시에 지정할 수 없습니다." });
  } else if (hasSpecContent) {
    const specContent = spec.specContent;
    if (typeof specContent !== "string") {
      reasons.push({ code: "MISSING_SPEC_CONTENT", detail: "spec.specContent가 문자열이 아닙니다." });
    } else if (specContent.length > MAX_SPEC_CONTENT_CHARS) {
      reasons.push({
        code: "SPEC_CONTENT_TOO_LARGE",
        detail: `spec.specContent가 너무 큽니다(최대 ${MAX_SPEC_CONTENT_CHARS}자, 현재 ${specContent.length}자).`,
      });
    } else if (specContent.trim().length === 0) {
      reasons.push({ code: "MISSING_SPEC_CONTENT", detail: "spec.specContent가 비어있습니다." });
    } else {
      if (validIntegrity) {
        const expectedHash = computeContentDigestHex(validIntegrity.algorithm, specContent);
        if (expectedHash !== validIntegrity.hash) {
          reasons.push({
            code: "SPEC_INTEGRITY_MISMATCH",
            detail: `spec.specIntegrity.hash가 spec.specContent의 실제 ${validIntegrity.algorithm} digest와 일치하지 않습니다.`,
          });
        }
      }
      const findings = scanContentForSecrets(specContent, "<spec-content>");
      if (findings.length > 0) {
        reasons.push({
          code: "SUSPECTED_SECRET_IN_SPEC_CONTENT",
          detail: `spec.specContent에서 secret으로 의심되는 패턴이 발견됐습니다(${findings.length}건, 종류: ${[
            ...new Set(findings.map((f) => f.kind)),
          ].join(", ")}). 원문은 기록하지 않습니다.`,
        });
      }
    }
  } else if (hasSpecContentRef && !isSafeRelativeSpecRef(spec.specContentRef)) {
    reasons.push({
      code: "INVALID_SPEC_CONTENT_REF",
      detail: "spec.specContentRef가 안전한 상대경로가 아닙니다(절대경로/드라이브/UNC/제어문자/\"..\"/예약 장치명/길이 초과 금지).",
    });
  }

  if (reasons.length > 0) {
    return { decision: "REJECT", reasons };
  }

  if (hasSpecContentRef) {
    return {
      decision: "ACCEPT_PENDING_CONTENT_VERIFICATION",
      handoffId: handoffId as string,
      projectId: projectId as string,
      specVersion: specVersion as string,
      specContentRef: spec.specContentRef as string,
    };
  }

  return {
    decision: "ACCEPT",
    handoffId: handoffId as string,
    projectId: projectId as string,
    specVersion: specVersion as string,
  };
}

/**
 * 외부에서 전달된 HandoffEnvelope를 deterministic 규칙만으로 판정한다(§ 파일 상단
 * 신뢰 경계 설명). 입력이 문자열이 아니면 그 무엇도 건드리지 않고 즉시 REJECT한다.
 * LLM을 호출하지 않고, 동일 입력에는 항상 동일 결과를 반환하며, 절대 throw하지 않는다.
 * 모든 게이트(specStatus===APPROVED, userApproval===PASS, reviewerGate/카운트===0 등)와
 * 형식 검증을 통과해야만 REJECT가 아닌 결과가 나온다 — 하나라도 어긋나면 위반 사항을
 * 전부 모아 REJECT한다(첫 실패에서 멈추지 않음). 인라인 specContent면 실제 digest까지
 * 대조해 일치할 때만 "ACCEPT"(완전 검증)를 반환한다. specContentRef면(이 Task는 파일을
 * 열어보지 않으므로) "ACCEPT_PENDING_CONTENT_VERIFICATION"을 반환한다 — SI-2가 실제 파일을
 * 읽어 digest를 재검증하기 전까지는 완전히 승인된 것으로 취급해서는 안 된다.
 */
export function evaluateSpecIntake(rawInput: unknown): SpecIntakeDecision {
  try {
    if (typeof rawInput !== "string") {
      return reject("INVALID_ENVELOPE", "HandoffEnvelope는 JSON 문자열로 전달돼야 합니다.");
    }
    if (rawInput.length === 0 || rawInput.length > MAX_ENVELOPE_JSON_CHARS) {
      return reject("INVALID_ENVELOPE", `HandoffEnvelope JSON 문자열이 비어있거나 너무 큽니다(최대 ${MAX_ENVELOPE_JSON_CHARS}자).`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawInput);
    } catch {
      return reject("INVALID_ENVELOPE", "HandoffEnvelope가 올바른 JSON이 아닙니다.");
    }

    return evaluateParsedEnvelope(parsed);
  } catch (e) {
    // 방어적 안전망 — 위 경로가 전부 순수 함수이므로 정상적으로는 여기 도달하지 않는다.
    // 그래도 이 함수는 어떤 경우에도 절대 throw하지 않는다는 계약을 지킨다. 실제 예외
    // 메시지는 로그/reason 어디에도 그대로 담지 않는다(예외 원문에 무엇이 들어있는지
    // 알 수 없으므로).
    return reject("VALIDATION_ERROR", "Intake 판정 중 예상치 못한 내부 오류가 발생해 안전하게 REJECT 처리했습니다.");
  }
}
