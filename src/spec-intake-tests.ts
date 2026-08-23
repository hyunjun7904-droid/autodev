import { createHash } from "node:crypto";
import { evaluateSpecIntake } from "./spec-intake";
import type { HandoffEnvelope, MasterSpecIntake, SpecIntakeRejectReasonCode } from "./spec-intake";

// Spec Intake Contract & Validation Foundation 테스트(SI-1). 순수 함수(evaluateSpecIntake)
// 만 검증한다 — 파일시스템/네트워크/git 접근이 전혀 없다(이 Task는 새 프로젝트 폴더 생성/
// Git init/Planner LLM 호출을 하지 않는다).
//
// evaluateSpecIntake()는 오직 JSON 문자열만 받는다(§ spec-intake.ts 신뢰 경계 설계) —
// run()이 payload 객체를 JSON.stringify해서 넘기는 정상 호출 helper다. 문자열이 아닌
// 입력/malformed JSON/크기 초과/Proxy 등 신뢰 경계 자체를 검증하는 시나리오만 예외적으로
// evaluateSpecIntake()를 직접 호출한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const SPEC_CONTENT_TEXT = "이것은 테스트용 spec 본문입니다. secret이 아닙니다.";
const SPEC_CONTENT_SHA256 = createHash("sha256").update(SPEC_CONTENT_TEXT, "utf8").digest("hex");
const SPEC_CONTENT_SHA512 = createHash("sha512").update(SPEC_CONTENT_TEXT, "utf8").digest("hex");

const VALID_SPEC: MasterSpecIntake = {
  projectId: "jarvis-core",
  projectName: "JARVIS Core",
  specVersion: "1.0.0",
  specStatus: "APPROVED",
  userApproval: "PASS",
  reviewerGate: { critical: 0, high: 0 },
  unresolvedCriticalCount: 0,
  contradictionCount: 0,
  specIntegrity: { algorithm: "sha256", hash: SPEC_CONTENT_SHA256 },
  specContent: SPEC_CONTENT_TEXT,
};

const VALID_ENVELOPE: HandoffEnvelope = {
  handoffId: "handoff-0001",
  spec: VALID_SPEC,
};

function withSpec(overrides: Partial<MasterSpecIntake>): HandoffEnvelope {
  return { ...VALID_ENVELOPE, spec: { ...VALID_SPEC, ...overrides } };
}

/** 정상 호출 helper — payload 객체를 JSON 문자열로 직렬화해 evaluateSpecIntake()에
 *  넘긴다(실제 신뢰 경계와 동일한 형태). */
function run(payload: unknown): ReturnType<typeof evaluateSpecIntake> {
  return evaluateSpecIntake(JSON.stringify(payload));
}

function reasonCodes(result: ReturnType<typeof evaluateSpecIntake>): SpecIntakeRejectReasonCode[] {
  return result.decision === "REJECT" ? result.reasons.map((r) => r.code) : [];
}

function scenarioValidPayloadAccepted(): void {
  const result = run(VALID_ENVELOPE);
  check("valid APPROVED payload → ACCEPT", result.decision === "ACCEPT");
  if (result.decision === "ACCEPT") {
    check(
      "ACCEPT 결과에 handoffId/projectId/specVersion이 그대로 담김",
      result.handoffId === "handoff-0001" && result.projectId === "jarvis-core" && result.specVersion === "1.0.0"
    );
  }
}

function scenarioTrustBoundaryRejectsNonStringOrMalformedOrOversized(): void {
  check(
    "문자열이 아닌 입력(실제 객체) → REJECT(INVALID_ENVELOPE)",
    reasonCodes(evaluateSpecIntake(VALID_ENVELOPE as unknown)).includes("INVALID_ENVELOPE")
  );
  check("빈 문자열 → REJECT(INVALID_ENVELOPE)", reasonCodes(evaluateSpecIntake("")).includes("INVALID_ENVELOPE"));
  check(
    "malformed JSON 문자열 → REJECT(INVALID_ENVELOPE)",
    reasonCodes(evaluateSpecIntake("{not valid json")).includes("INVALID_ENVELOPE")
  );
  check("JSON null → REJECT(INVALID_ENVELOPE)", reasonCodes(run(null)).includes("INVALID_ENVELOPE"));
  check("JSON 최상위가 문자열 → REJECT(INVALID_ENVELOPE)", reasonCodes(run("not-an-object")).includes("INVALID_ENVELOPE"));
  check("JSON 최상위가 배열 → REJECT(INVALID_ENVELOPE)", reasonCodes(run([VALID_ENVELOPE])).includes("INVALID_ENVELOPE"));
  check(
    "상한(6,000,000자)을 넘는 JSON 문자열 → JSON.parse 시도 없이 즉시 REJECT(INVALID_ENVELOPE)",
    reasonCodes(evaluateSpecIntake("x".repeat(6_000_001))).includes("INVALID_ENVELOPE")
  );
}

function scenarioProxyOrHostileObjectNeverThrows(): void {
  let trapCalls = 0;
  const hostile = new Proxy(
    {},
    {
      get() {
        trapCalls++;
        throw new Error("malicious get trap");
      },
      ownKeys() {
        trapCalls++;
        throw new Error("malicious ownKeys trap");
      },
      getOwnPropertyDescriptor() {
        trapCalls++;
        throw new Error("malicious getOwnPropertyDescriptor trap");
      },
      getPrototypeOf() {
        trapCalls++;
        throw new Error("malicious getPrototypeOf trap");
      },
    }
  );

  let threw = false;
  let result: ReturnType<typeof evaluateSpecIntake> | undefined;
  try {
    result = evaluateSpecIntake(hostile as unknown);
  } catch {
    threw = true;
  }
  check("악성 Proxy(모든 trap이 throw)를 직접 넘겨도 evaluateSpecIntake가 절대 throw하지 않음", !threw);
  check("악성 Proxy의 trap이 단 한 번도 호출되지 않음(typeof만으로 즉시 REJECT)", trapCalls === 0);
  check("악성 Proxy → REJECT(INVALID_ENVELOPE)", !!result && result.decision === "REJECT" && reasonCodes(result).includes("INVALID_ENVELOPE"));

  const { proxy: revocable, revoke } = Proxy.revocable({}, {});
  revoke();
  let threwRevoked = false;
  let revokedResult: ReturnType<typeof evaluateSpecIntake> | undefined;
  try {
    revokedResult = evaluateSpecIntake(revocable as unknown);
  } catch {
    threwRevoked = true;
  }
  check("revoked Proxy를 직접 넘겨도 evaluateSpecIntake가 절대 throw하지 않음", !threwRevoked);
  check(
    "revoked Proxy → REJECT(INVALID_ENVELOPE)",
    !!revokedResult && revokedResult.decision === "REJECT" && reasonCodes(revokedResult).includes("INVALID_ENVELOPE")
  );
}

function scenarioUnknownFieldsRejected(): void {
  const withExtraEnvelopeField = { ...VALID_ENVELOPE, injectCode: "rm -rf /" };
  check(
    "알 수 없는 envelope 필드 → REJECT(UNKNOWN_ENVELOPE_FIELD)",
    reasonCodes(run(withExtraEnvelopeField)).includes("UNKNOWN_ENVELOPE_FIELD")
  );

  const withExtraSpecField = { ...VALID_ENVELOPE, spec: { ...VALID_SPEC, unexpectedField: "x" } };
  check("알 수 없는 spec 필드 → REJECT(UNKNOWN_SPEC_FIELD)", reasonCodes(run(withExtraSpecField)).includes("UNKNOWN_SPEC_FIELD"));
}

function scenarioSpecStatusGate(): void {
  check("DRAFT → REJECT(SPEC_NOT_APPROVED)", reasonCodes(run(withSpec({ specStatus: "DRAFT" }))).includes("SPEC_NOT_APPROVED"));
  check(
    "REVIEW_REQUIRED → REJECT(SPEC_NOT_APPROVED)",
    reasonCodes(run(withSpec({ specStatus: "REVIEW_REQUIRED" }))).includes("SPEC_NOT_APPROVED")
  );
  check(
    "알 수 없는 specStatus 문자열 → REJECT(INVALID_SPEC_STATUS)",
    reasonCodes(run(withSpec({ specStatus: "SOMETHING_ELSE" as never }))).includes("INVALID_SPEC_STATUS")
  );
}

function scenarioUserApprovalGate(): void {
  const noApproval: Record<string, unknown> = { ...VALID_SPEC };
  delete noApproval.userApproval;
  check(
    "userApproval 필드 없음 → REJECT(INVALID_USER_APPROVAL)",
    reasonCodes(run({ ...VALID_ENVELOPE, spec: noApproval })).includes("INVALID_USER_APPROVAL")
  );
  check("userApproval FAIL → REJECT(USER_APPROVAL_NOT_PASS)", reasonCodes(run(withSpec({ userApproval: "FAIL" }))).includes("USER_APPROVAL_NOT_PASS"));
  check(
    "userApproval PENDING → REJECT(USER_APPROVAL_NOT_PASS)",
    reasonCodes(run(withSpec({ userApproval: "PENDING" }))).includes("USER_APPROVAL_NOT_PASS")
  );
}

function scenarioReviewerGateSeverity(): void {
  check(
    "reviewerGate.critical > 0 → REJECT(REVIEWER_CRITICAL_NOT_ZERO)",
    reasonCodes(run(withSpec({ reviewerGate: { critical: 1, high: 0 } }))).includes("REVIEWER_CRITICAL_NOT_ZERO")
  );
  check(
    "reviewerGate.high > 0 → REJECT(REVIEWER_HIGH_NOT_ZERO)",
    reasonCodes(run(withSpec({ reviewerGate: { critical: 0, high: 2 } }))).includes("REVIEWER_HIGH_NOT_ZERO")
  );
  check(
    "reviewerGate 형식 오류(음수) → REJECT(INVALID_REVIEWER_GATE)",
    reasonCodes(run(withSpec({ reviewerGate: { critical: -1, high: 0 } }))).includes("INVALID_REVIEWER_GATE")
  );
  check(
    "reviewerGate가 객체가 아님 → REJECT(INVALID_REVIEWER_GATE)",
    reasonCodes(run(withSpec({ reviewerGate: "none" as never }))).includes("INVALID_REVIEWER_GATE")
  );
}

function scenarioUnresolvedAndContradictionCounts(): void {
  check(
    "unresolvedCriticalCount > 0 → REJECT(UNRESOLVED_CRITICAL_NOT_ZERO)",
    reasonCodes(run(withSpec({ unresolvedCriticalCount: 3 }))).includes("UNRESOLVED_CRITICAL_NOT_ZERO")
  );
  check(
    "contradictionCount > 0 → REJECT(CONTRADICTION_NOT_ZERO)",
    reasonCodes(run(withSpec({ contradictionCount: 1 }))).includes("CONTRADICTION_NOT_ZERO")
  );
  check(
    "unresolvedCriticalCount가 정수가 아님 → REJECT(INVALID_UNRESOLVED_CRITICAL_COUNT)",
    reasonCodes(run(withSpec({ unresolvedCriticalCount: 1.5 }))).includes("INVALID_UNRESOLVED_CRITICAL_COUNT")
  );
  check(
    "contradictionCount가 음수 → REJECT(INVALID_CONTRADICTION_COUNT)",
    reasonCodes(run(withSpec({ contradictionCount: -1 }))).includes("INVALID_CONTRADICTION_COUNT")
  );
}

function scenarioIdentifierAndVersionFormat(): void {
  check("빈 projectId → REJECT(INVALID_PROJECT_ID)", reasonCodes(run(withSpec({ projectId: "" }))).includes("INVALID_PROJECT_ID"));
  check(
    "path traversal 형태 projectId → REJECT(INVALID_PROJECT_ID)",
    reasonCodes(run(withSpec({ projectId: "../../etc/passwd" }))).includes("INVALID_PROJECT_ID")
  );
  check("빈 projectName → REJECT(INVALID_PROJECT_NAME)", reasonCodes(run(withSpec({ projectName: "   " }))).includes("INVALID_PROJECT_NAME"));
  check("빈 handoffId → REJECT(INVALID_HANDOFF_ID)", reasonCodes(run({ ...VALID_ENVELOPE, handoffId: "" })).includes("INVALID_HANDOFF_ID"));
  check(
    "너무 짧은 handoffId → REJECT(INVALID_HANDOFF_ID)",
    reasonCodes(run({ ...VALID_ENVELOPE, handoffId: "abc" })).includes("INVALID_HANDOFF_ID")
  );
  check("잘못된 specVersion(빈 값) → REJECT(INVALID_SPEC_VERSION)", reasonCodes(run(withSpec({ specVersion: "" }))).includes("INVALID_SPEC_VERSION"));
  check(
    "잘못된 specVersion(자유 문자열) → REJECT(INVALID_SPEC_VERSION)",
    reasonCodes(run(withSpec({ specVersion: "latest" }))).includes("INVALID_SPEC_VERSION")
  );
  check("major.minor만 있는 specVersion은 유효 → ACCEPT", run(withSpec({ specVersion: "2.3" })).decision === "ACCEPT");
}

function scenarioIntegrityFormat(): void {
  const noIntegrity: Record<string, unknown> = { ...VALID_SPEC };
  delete noIntegrity.specIntegrity;
  check(
    "specIntegrity 필드 없음 → REJECT(INVALID_SPEC_INTEGRITY)",
    reasonCodes(run({ ...VALID_ENVELOPE, spec: noIntegrity })).includes("INVALID_SPEC_INTEGRITY")
  );
  check(
    "알 수 없는 algorithm → REJECT(INVALID_SPEC_INTEGRITY)",
    reasonCodes(run(withSpec({ specIntegrity: { algorithm: "md5" as never, hash: "a".repeat(32) } }))).includes("INVALID_SPEC_INTEGRITY")
  );
  check(
    "sha256인데 hash 길이가 틀림 → REJECT(INVALID_SPEC_INTEGRITY)",
    reasonCodes(run(withSpec({ specIntegrity: { algorithm: "sha256", hash: "abc123" } }))).includes("INVALID_SPEC_INTEGRITY")
  );
  check(
    "hash에 hex가 아닌 문자 → REJECT(INVALID_SPEC_INTEGRITY)",
    reasonCodes(run(withSpec({ specIntegrity: { algorithm: "sha256", hash: "z".repeat(64) } }))).includes("INVALID_SPEC_INTEGRITY")
  );
  check(
    "실제 specContent와 일치하는 sha512 hash → ACCEPT",
    run(withSpec({ specIntegrity: { algorithm: "sha512", hash: SPEC_CONTENT_SHA512 } })).decision === "ACCEPT"
  );
}

function scenarioSpecIntegrityMismatch(): void {
  const result = run(withSpec({ specIntegrity: { algorithm: "sha256", hash: "f".repeat(64) } }));
  check(
    "형식은 유효하지만 실제 specContent와 일치하지 않는 hash → REJECT(SPEC_INTEGRITY_MISMATCH)",
    reasonCodes(result).includes("SPEC_INTEGRITY_MISMATCH")
  );
}

function scenarioSpecContentPresenceAndRef(): void {
  const noContentSpec: Record<string, unknown> = { ...VALID_SPEC };
  delete noContentSpec.specContent;
  check(
    "specContent/specContentRef 둘 다 없음 → REJECT(MISSING_SPEC_CONTENT)",
    reasonCodes(run({ ...VALID_ENVELOPE, spec: noContentSpec })).includes("MISSING_SPEC_CONTENT")
  );

  check(
    "specContent와 specContentRef 동시 지정 → REJECT(AMBIGUOUS_SPEC_CONTENT)",
    reasonCodes(run(withSpec({ specContentRef: "specs/master.md" }))).includes("AMBIGUOUS_SPEC_CONTENT")
  );

  const refOnlySpec: Record<string, unknown> = { ...VALID_SPEC, specContentRef: "specs/master.md" };
  delete refOnlySpec.specContent;
  const refOnlyResult = run({ ...VALID_ENVELOPE, spec: refOnlySpec });
  check(
    "안전한 specContentRef만 지정 → ACCEPT_PENDING_CONTENT_VERIFICATION(일반 ACCEPT 아님)",
    refOnlyResult.decision === "ACCEPT_PENDING_CONTENT_VERIFICATION"
  );
  if (refOnlyResult.decision === "ACCEPT_PENDING_CONTENT_VERIFICATION") {
    check("ACCEPT_PENDING_CONTENT_VERIFICATION 결과에 specContentRef가 그대로 담김", refOnlyResult.specContentRef === "specs/master.md");
  }

  const traversalRefSpec: Record<string, unknown> = { ...VALID_SPEC, specContentRef: "../../etc/passwd" };
  delete traversalRefSpec.specContent;
  check(
    "path traversal specContentRef → REJECT(INVALID_SPEC_CONTENT_REF)",
    reasonCodes(run({ ...VALID_ENVELOPE, spec: traversalRefSpec })).includes("INVALID_SPEC_CONTENT_REF")
  );

  const absoluteRefSpec: Record<string, unknown> = { ...VALID_SPEC, specContentRef: "C:\\secrets\\master.md" };
  delete absoluteRefSpec.specContent;
  check(
    "드라이브 절대경로 specContentRef → REJECT(INVALID_SPEC_CONTENT_REF)",
    reasonCodes(run({ ...VALID_ENVELOPE, spec: absoluteRefSpec })).includes("INVALID_SPEC_CONTENT_REF")
  );
}

function scenarioSecretShapedSpecContentRejected(): void {
  const secretLikeContent = 'const config = { apiKey: "not-a-real-credential-00000000" };';
  const result = run(withSpec({ specContent: secretLikeContent }));
  check("secret 모양 문자열이 담긴 specContent → REJECT(SUSPECTED_SECRET_IN_SPEC_CONTENT)", reasonCodes(result).includes("SUSPECTED_SECRET_IN_SPEC_CONTENT"));
  if (result.decision === "REJECT") {
    const serialized = JSON.stringify(result);
    check("REJECT 결과 어디에도 secret 원문이 그대로 노출되지 않음", !serialized.includes("not-a-real-credential-00000000"));
  }
}

function scenarioMultipleReasonsCollectedNotFailFast(): void {
  const badEnvelope = withSpec({
    specStatus: "DRAFT",
    userApproval: "FAIL",
    reviewerGate: { critical: 1, high: 1 },
    unresolvedCriticalCount: 1,
    contradictionCount: 1,
  });
  const result = run(badEnvelope);
  check("REJECT", result.decision === "REJECT");
  if (result.decision === "REJECT") {
    check(
      "여러 위반 사항이 첫 실패에서 멈추지 않고 전부 모여서 반환됨",
      result.reasons.some((r) => r.code === "SPEC_NOT_APPROVED") &&
        result.reasons.some((r) => r.code === "USER_APPROVAL_NOT_PASS") &&
        result.reasons.some((r) => r.code === "REVIEWER_CRITICAL_NOT_ZERO") &&
        result.reasons.some((r) => r.code === "REVIEWER_HIGH_NOT_ZERO") &&
        result.reasons.some((r) => r.code === "UNRESOLVED_CRITICAL_NOT_ZERO") &&
        result.reasons.some((r) => r.code === "CONTRADICTION_NOT_ZERO")
    );
  }
}

function scenarioDeterministicRepeatedCalls(): void {
  const a = run(VALID_ENVELOPE);
  const b = run(VALID_ENVELOPE);
  check("동일 입력 → 동일 decision(ACCEPT)", a.decision === "ACCEPT" && b.decision === "ACCEPT");
}

function scenarioTooManyTopLevelKeysRejected(): void {
  const bloated: Record<string, unknown> = { ...VALID_SPEC };
  for (let i = 0; i < 100; i++) bloated[`extra_${i}`] = "x";
  const result = run({ ...VALID_ENVELOPE, spec: bloated });
  check("최상위 필드가 상한(64)을 초과하면 → REJECT(INVALID_SPEC_OBJECT)", reasonCodes(result).includes("INVALID_SPEC_OBJECT"));
}

function scenarioOversizedSpecContentRejected(): void {
  const huge = "a".repeat(2_000_001);
  const result = run(withSpec({ specContent: huge }));
  check("specContent가 상한(2,000,000자)을 넘으면 → REJECT(SPEC_CONTENT_TOO_LARGE)", reasonCodes(result).includes("SPEC_CONTENT_TOO_LARGE"));
}

function scenarioSpecContentRefHardening(): void {
  const refSpec = (ref: string): Record<string, unknown> => {
    const s: Record<string, unknown> = { ...VALID_SPEC, specContentRef: ref };
    delete s.specContent;
    return s;
  };

  check(
    "제어문자(NUL)가 포함된 specContentRef → REJECT(INVALID_SPEC_CONTENT_REF)",
    reasonCodes(run({ ...VALID_ENVELOPE, spec: refSpec("specs/master\x00.md") })).includes("INVALID_SPEC_CONTENT_REF")
  );
  check(
    "NTFS alternate-data-stream 형태(콜론) specContentRef → REJECT(INVALID_SPEC_CONTENT_REF)",
    reasonCodes(run({ ...VALID_ENVELOPE, spec: refSpec("specs/master.md:hidden") })).includes("INVALID_SPEC_CONTENT_REF")
  );
  check(
    "Windows 예약 장치명(CON) specContentRef → REJECT(INVALID_SPEC_CONTENT_REF)",
    reasonCodes(run({ ...VALID_ENVELOPE, spec: refSpec("specs/CON") })).includes("INVALID_SPEC_CONTENT_REF")
  );
  check(
    "너무 긴 specContentRef(1024자 초과) → REJECT(INVALID_SPEC_CONTENT_REF)",
    reasonCodes(run({ ...VALID_ENVELOPE, spec: refSpec("a".repeat(1025)) })).includes("INVALID_SPEC_CONTENT_REF")
  );
}

function scenarioUnknownFieldNameSanitizedInDetail(): void {
  const maliciousKey = "secret\x01\x02" + "x".repeat(200);
  const withMalicious: Record<string, unknown> = { ...VALID_SPEC, [maliciousKey]: "y" };
  const result = run({ ...VALID_ENVELOPE, spec: withMalicious });
  check("REJECT", result.decision === "REJECT");
  if (result.decision === "REJECT") {
    const serialized = JSON.stringify(result);
    check("알 수 없는 필드명의 제어문자/원문이 그대로 결과에 노출되지 않음", !serialized.includes(maliciousKey) && !serialized.includes("\x01"));
  }
}

function main(): void {
  scenarioValidPayloadAccepted();
  scenarioTrustBoundaryRejectsNonStringOrMalformedOrOversized();
  scenarioProxyOrHostileObjectNeverThrows();
  scenarioUnknownFieldsRejected();
  scenarioSpecStatusGate();
  scenarioUserApprovalGate();
  scenarioReviewerGateSeverity();
  scenarioUnresolvedAndContradictionCounts();
  scenarioIdentifierAndVersionFormat();
  scenarioIntegrityFormat();
  scenarioSpecIntegrityMismatch();
  scenarioSpecContentPresenceAndRef();
  scenarioSecretShapedSpecContentRejected();
  scenarioMultipleReasonsCollectedNotFailFast();
  scenarioDeterministicRepeatedCalls();
  scenarioTooManyTopLevelKeysRejected();
  scenarioOversizedSpecContentRejected();
  scenarioSpecContentRefHardening();
  scenarioUnknownFieldNameSanitizedInDetail();

  console.log("\n=== spec-intake 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
