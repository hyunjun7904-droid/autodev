import { buildDiagnosticEvidenceBundle } from "./diagnostic-evidence-bundle";

// Hardening F(Diagnostic Evidence Bundle) 테스트 — 순수 조합 함수. 핵심 확인 사항:
// (1) 넘긴 값은 그대로 보존된다(변형 없음), (2) 넘기지 않은 값은 추측으로 채워지지 않고
// undefined로 남는다("UNKNOWN을 0으로 표시하지 않는다" 원칙), (3) 0처럼 "진짜 유효한 값"과
// "모름"을 혼동하지 않는다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const full = buildDiagnosticEvidenceBundle({
  taskId: "T1",
  failureClass: "DETERMINISTIC_LOCAL",
  failureClassReason: "실행 환경 결함",
  failureFingerprint: "fp-123",
  requiredTestName: "rtp-check",
  cwd: "modb",
  command: "npm",
  args: ["run", "check"],
  exitCode: 1,
  executionContractOk: false,
  prerequisiteFeasibility: "MISSING_PREREQUISITE",
  prerequisiteFeasibilityReason: "다른 task 소관",
  recentChangedFiles: ["a.ts"],
  lastSuccessfulStage: "discovery",
  readCount: 3,
  duplicateReadCount: 1,
  writeCount: 0,
  writeZeroRounds: 5,
  developerCalls: 2,
  reviewerCalls: 1,
  retries: 2,
  activeTimeMs: 12345,
  problemMemoryMatch: { tier: "PROJECT", entryId: "e-1" },
  priorVerifiedResolutionSummary: "wrapper 파일 생성",
  failedStrategies: ["넓은 discovery 반복"],
  nextDeterministicAction: "project adapter를 확인하세요.",
});

check("모든 필드가 입력값 그대로 보존됨(taskId)", full.taskId === "T1");
check("모든 필드가 입력값 그대로 보존됨(failureClass)", full.failureClass === "DETERMINISTIC_LOCAL");
check("모든 필드가 입력값 그대로 보존됨(exitCode=1, 진짜 값)", full.exitCode === 1);
check("모든 필드가 입력값 그대로 보존됨(writeCount=0, 진짜 값 — undefined로 뭉개지지 않음)", full.writeCount === 0);
check("모든 필드가 입력값 그대로 보존됨(prerequisiteFeasibility)", full.prerequisiteFeasibility === "MISSING_PREREQUISITE");
check("모든 필드가 입력값 그대로 보존됨(problemMemoryMatch)", full.problemMemoryMatch?.entryId === "e-1");
check("모든 필드가 입력값 그대로 보존됨(failedStrategies)", full.failedStrategies?.[0] === "넓은 discovery 반복");

const minimal = buildDiagnosticEvidenceBundle({ taskId: "T2" });
check("최소 입력: taskId만 보존됨", minimal.taskId === "T2");
check("최소 입력: failureClass는 undefined(추측으로 채우지 않음)", minimal.failureClass === undefined);
check("최소 입력: exitCode는 undefined(0으로 추정하지 않음 — UNKNOWN != 0)", minimal.exitCode === undefined);
check("최소 입력: prerequisiteFeasibility는 undefined(확인 안 됨을 임의 분류로 채우지 않음)", minimal.prerequisiteFeasibility === undefined);
check("최소 입력: problemMemoryMatch는 undefined(null과 구분 — 조회 자체를 안 한 경우)", minimal.problemMemoryMatch === undefined);

const explicitNoMatch = buildDiagnosticEvidenceBundle({ taskId: "T3", problemMemoryMatch: null });
check("problemMemoryMatch=null은 undefined와 다르게 보존됨(조회했지만 못 찾음 vs 조회 자체를 안 함)", explicitNoMatch.problemMemoryMatch === null);

console.log("\n=== diagnostic-evidence-bundle 테스트 결과 ===");
for (const r of results) console.log(r);
const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
