import { recordAttempt, confirmResolution, promoteToCommonIfGeneric, recordReuseOutcome } from "./problem-memory";
import type { ProblemMemoryStore, ProblemMemoryEntry } from "./problem-memory";
import { buildProblemSolvingSnapshot } from "./dashboard-problem-solving";
import type { ClaudeResult } from "./types";

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function makeMemoryStore(): ProblemMemoryStore {
  let entries: ProblemMemoryEntry[] = [];
  return {
    load: () => entries,
    save: (next) => {
      entries = next;
    },
  };
}

function tests(overrides: Partial<ClaudeResult["tests"][number]>[]): ClaudeResult["tests"] {
  return overrides.map((o) => ({ name: "t", pass: false, ...o })) as ClaudeResult["tests"];
}

function scenarioNoProjectIdReturnsUndefined(): void {
  const project = makeMemoryStore();
  const common = makeMemoryStore();
  const snapshot = buildProblemSolvingSnapshot(undefined, "T1", { project, common });
  check("projectId가 없으면 undefined(추측 안 함)", snapshot === undefined);
}

function scenarioNoDataAtAllReturnsUndefined(): void {
  const project = makeMemoryStore();
  const common = makeMemoryStore();
  const snapshot = buildProblemSolvingSnapshot("P1", "T1", { project, common });
  check("problem-memory 자료가 전혀 없으면 undefined", snapshot === undefined);
}

function scenarioCurrentUnresolvedProblemSurfaced(): void {
  const project = makeMemoryStore();
  const common = makeMemoryStore();
  const failing = tests([{ name: "check", pass: false, failureEvidence: { command: "npm run test:x", exitCode: 1, stderrTail: "boom" } }]);
  recordAttempt(project, { projectId: "P1", taskId: "T1", tests: failing, errorType: "IMPLEMENTATION", changedFiles: [], attemptDescription: "시도1", outcome: "FAILURE" });
  recordAttempt(project, { projectId: "P1", taskId: "T1", tests: failing, errorType: "IMPLEMENTATION", changedFiles: [], attemptDescription: "시도2", outcome: "FAILURE" });

  const snapshot = buildProblemSolvingSnapshot("P1", "T1", { project, common });
  check("현재 task의 미해결 문제가 표시됨", snapshot?.currentProblem !== undefined);
  check("반복 실패 횟수가 2로 집계됨", snapshot?.currentProblem?.repeatedFailureCount === 2);
  check("아직 해결되지 않은 상태로 표시됨(resolved=false)", snapshot?.currentProblem?.resolved === false);
}

function scenarioResolvedProblemMarkedResolved(): void {
  const project = makeMemoryStore();
  const common = makeMemoryStore();
  const failing = tests([{ name: "check", pass: false, failureEvidence: { command: "npm run test:x", exitCode: 1, stderrTail: "boom" } }]);
  const entry = recordAttempt(project, { projectId: "P1", taskId: "T1", tests: failing, errorType: "IMPLEMENTATION", changedFiles: [], attemptDescription: "해결됨", outcome: "SUCCESS" });
  confirmResolution(project, entry.id, "abc1234");

  const snapshot = buildProblemSolvingSnapshot("P1", "T1", { project, common });
  check("확정된 문제는 resolved=true로 표시됨", snapshot?.currentProblem?.resolved === true);
}

function scenarioReuseCountersSummedAcrossEntries(): void {
  const project = makeMemoryStore();
  const common = makeMemoryStore();
  const t1 = tests([{ name: "a", pass: false, failureEvidence: { command: "npm run a", exitCode: 1, stderrTail: "x" } }]);
  const t2 = tests([{ name: "b", pass: false, failureEvidence: { command: "npm run b", exitCode: 1, stderrTail: "y" } }]);
  const e1 = recordAttempt(project, { projectId: "P1", taskId: "T1", tests: t1, errorType: "IMPLEMENTATION", changedFiles: [], attemptDescription: "fix1", outcome: "SUCCESS" });
  confirmResolution(project, e1.id, "abc1234");
  const e2 = recordAttempt(project, { projectId: "P1", taskId: "T2", tests: t2, errorType: "IMPLEMENTATION", changedFiles: [], attemptDescription: "fix2", outcome: "SUCCESS" });
  confirmResolution(project, e2.id, "def5678");

  recordReuseOutcome(project, e1.id, "SUCCESS");
  recordReuseOutcome(project, e1.id, "SUCCESS");
  recordReuseOutcome(project, e2.id, "FAILURE");

  const snapshot = buildProblemSolvingSnapshot("P1", "T3", { project, common });
  check("여러 항목의 reuseSuccessCount가 합산됨(2)", snapshot?.totalReuseSuccessCount === 2);
  check("여러 항목의 reuseFailureCount가 합산됨(1)", snapshot?.totalReuseFailureCount === 1);
}

function scenarioSimilarPastCaseCountedFromProjectAndCommonTiers(): void {
  const project = makeMemoryStore();
  const common = makeMemoryStore();
  const sharedFingerprint = tests([{ name: "check", pass: false, failureEvidence: { command: "npm run test:x", exitCode: 1, stderrTail: "boom" } }]);

  // T1에서 이미 확정된 해결책(같은 fingerprint) — T2가 이 문제를 겪을 때 "유사 사례"로 잡혀야 한다.
  const resolvedInT1 = recordAttempt(project, { projectId: "P1", taskId: "T1", tests: sharedFingerprint, errorType: "IMPLEMENTATION", changedFiles: [], attemptDescription: "T1 해결책", outcome: "SUCCESS" });
  confirmResolution(project, resolvedInT1.id, "abc1234");

  // T2는 아직 미해결.
  recordAttempt(project, { projectId: "P1", taskId: "T2", tests: sharedFingerprint, errorType: "IMPLEMENTATION", changedFiles: [], attemptDescription: "T2 시도1", outcome: "FAILURE" });

  const snapshot = buildProblemSolvingSnapshot("P1", "T2", { project, common });
  check("같은 fingerprint의 다른 task 확정 해결책이 유사 사례로 집계됨", snapshot?.similarPastCasesCount === 1);
}

function scenarioProjectSpecificProblemNotPromotedIsolation(): void {
  // 공통 지식으로 승격되지 않은(project-specific) 문제는 공통 저장소에 영향이 없음을
  // promoteToCommonIfGeneric의 기존 동작으로 재확인(회귀 방지 겸 이 파일이 그 결과를
  // 올바르게 무시하는지).
  const project = makeMemoryStore();
  const common = makeMemoryStore();
  const bizLogicTests = tests([{ name: "secret-storage-isolation-validation", pass: false, failureEvidence: { command: "npm run test:jarvis-storage-isolation", exitCode: 1, stderrTail: "AssertionError: CREATE POLICY" } }]);
  const entry = recordAttempt(project, { projectId: "P1", taskId: "T9", tests: bizLogicTests, errorType: "IMPLEMENTATION", changedFiles: [], attemptDescription: "정규식 수정", outcome: "SUCCESS" });
  confirmResolution(project, entry.id, "xyz9999");
  promoteToCommonIfGeneric(common, project.load()[0]);
  check("프로젝트 고유 문제는 공통 지식으로 승격되지 않음", common.load().length === 0);

  const snapshot = buildProblemSolvingSnapshot("P2", "T1", { project: makeMemoryStore(), common });
  check("다른 프로젝트(P2)는 이 공통 지식에서 아무 유사 사례도 얻지 못함(원래 없으므로 undefined)", snapshot === undefined);
}

function main(): void {
  scenarioNoProjectIdReturnsUndefined();
  scenarioNoDataAtAllReturnsUndefined();
  scenarioCurrentUnresolvedProblemSurfaced();
  scenarioResolvedProblemMarkedResolved();
  scenarioReuseCountersSummedAcrossEntries();
  scenarioSimilarPastCaseCountedFromProjectAndCommonTiers();
  scenarioProjectSpecificProblemNotPromotedIsolation();

  console.log("\n=== dashboard-problem-solving 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
