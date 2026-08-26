import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  recordAttempt,
  confirmResolution,
  lookupSolution,
  promoteToCommonIfGeneric,
  recordReuseOutcome,
  scrubPathLikeTokens,
  isGenericCommonProblem,
} from "./problem-memory";
import type { ProblemMemoryStore, ProblemMemoryEntry } from "./problem-memory";
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

const FAILING_TESTS = tests([{ name: "check-x", pass: false, failureEvidence: { command: "npm run test:x", exitCode: 1, stderrTail: "TypeError: cannot read foo" } }]);
const PASSING_TESTS: ClaudeResult["tests"] = [{ name: "check-x", pass: true }];

// ---------------------------------------------------------------------------
// A) 같은 Task 내부 — 이미 실패한 방법을 다시 추천하지 않음(§ 요구사항 6)
// ---------------------------------------------------------------------------
function scenarioSameTaskDoesNotRecommendAlreadyFailedSolution(): void {
  const projectStore = makeMemoryStore();
  const commonStore = makeMemoryStore();

  recordAttempt(projectStore, {
    projectId: "P1",
    taskId: "T1",
    tests: FAILING_TESTS,
    errorType: "IMPLEMENTATION",
    changedFiles: ["src/a.ts"],
    attemptDescription: "방법 A: null 체크 추가",
    outcome: "FAILURE",
  });
  recordAttempt(projectStore, {
    projectId: "P1",
    taskId: "T1",
    tests: FAILING_TESTS,
    errorType: "IMPLEMENTATION",
    changedFiles: ["src/a.ts"],
    attemptDescription: "방법 B: optional chaining 사용",
    outcome: "FAILURE",
  });

  const lookup = lookupSolution({ projectId: "P1", taskId: "T1", tests: FAILING_TESTS, projectStore, commonStore });
  check("A) 성공한 해결책이 아직 없으면 lookup 결과 없음", lookup === undefined);

  const entries = projectStore.load();
  check("A) 같은 fingerprint 항목 1개로 누적됨(중복 생성 없음)", entries.length === 1);
  check("A) attemptedSolutions에 두 실패가 모두 기록됨", entries[0].attemptedSolutions.length === 2);
  check(
    "A) 이 task에서 이미 실패한 설명 목록에 둘 다 포함",
    entries[0].attemptedSolutions.every((s) => s.outcome === "FAILURE")
  );
}

// ---------------------------------------------------------------------------
// B) Task A에서 해결 → 저장, Task B(같은 프로젝트)에서 재사용
// ---------------------------------------------------------------------------
function scenarioCrossTaskReuseWithinSameProject(): void {
  const projectStore = makeMemoryStore();
  const commonStore = makeMemoryStore();

  const entry = recordAttempt(projectStore, {
    projectId: "P1",
    taskId: "T1",
    tests: FAILING_TESTS,
    errorType: "IMPLEMENTATION",
    changedFiles: ["src/a.ts"],
    attemptDescription: "null 체크 추가로 해결",
    outcome: "SUCCESS",
  });

  const lookupBeforeConfirm = lookupSolution({ projectId: "P1", taskId: "T2", tests: FAILING_TESTS, projectStore, commonStore });
  check("B) checkpoint 확정 전(pendingConfirmation)에는 재사용 후보로 나오지 않음", lookupBeforeConfirm === undefined);

  confirmResolution(projectStore, entry.id, "abc1234");

  const lookupAfterConfirm = lookupSolution({ projectId: "P1", taskId: "T2", tests: FAILING_TESTS, projectStore, commonStore });
  check("B) 확정 이후에는 다른 Task(T2)에서 같은 문제를 검색하면 재사용 후보로 나옴", lookupAfterConfirm !== undefined);
  check("B) tier=PROJECT로 보고됨", lookupAfterConfirm?.tier === "PROJECT");
  check(
    "B) 재사용 후보의 해결책 설명이 실제 성공 설명과 일치",
    lookupAfterConfirm?.entry.finalSuccessfulSolution === "null 체크 추가로 해결"
  );
}

// ---------------------------------------------------------------------------
// C) 비슷하지만 다른 문제 — fingerprint가 다르면 재사용하지 않음
// ---------------------------------------------------------------------------
function scenarioDifferentFingerprintNotReused(): void {
  const projectStore = makeMemoryStore();
  const commonStore = makeMemoryStore();
  const entry = recordAttempt(projectStore, {
    projectId: "P1",
    taskId: "T1",
    tests: FAILING_TESTS,
    errorType: "IMPLEMENTATION",
    changedFiles: [],
    attemptDescription: "해결됨",
    outcome: "SUCCESS",
  });
  confirmResolution(projectStore, entry.id, "abc1234");

  const differentTests = tests([{ name: "check-x", pass: false, failureEvidence: { command: "npm run test:x", exitCode: 1, stderrTail: "ReferenceError: y is not defined" } }]);
  const lookup = lookupSolution({ projectId: "P1", taskId: "T2", tests: differentTests, projectStore, commonStore });
  check("C) 에러 메시지가 실제로 다르면(다른 fingerprint) 재사용 후보로 나오지 않음", lookup === undefined);
}

// ---------------------------------------------------------------------------
// D) 프로젝트 격리 — P1의 지식이 P2에 잘못 적용되지 않음
// ---------------------------------------------------------------------------
function scenarioProjectIsolation(): void {
  const p1Store = makeMemoryStore();
  const p2Store = makeMemoryStore();
  const commonStore = makeMemoryStore();

  const entry = recordAttempt(p1Store, {
    projectId: "P1",
    taskId: "T1",
    tests: FAILING_TESTS,
    errorType: "IMPLEMENTATION",
    changedFiles: [],
    attemptDescription: "P1 전용 해결책",
    outcome: "SUCCESS",
  });
  confirmResolution(p1Store, entry.id, "abc1234");

  const lookupInP2 = lookupSolution({ projectId: "P2", taskId: "T1", tests: FAILING_TESTS, projectStore: p2Store, commonStore });
  check("D) P1의 project tier 지식은 P2의 store에 존재하지 않음(격리)", lookupInP2 === undefined);
}

// ---------------------------------------------------------------------------
// E) 공통 지식 — 프로젝트와 무관한 일반 오류는 다른 프로젝트에서도 재사용 가능
// ---------------------------------------------------------------------------
function scenarioCommonKnowledgeReusableAcrossProjects(): void {
  const p1Store = makeMemoryStore();
  const p2Store = makeMemoryStore();
  const commonStore = makeMemoryStore();

  const genericTests = tests([
    { name: "build", pass: false, failureEvidence: { command: "npm run build", exitCode: 1, stderrTail: "TS2345: Argument of type 'string' is not assignable" } },
  ]);
  const entry = recordAttempt(p1Store, {
    projectId: "P1",
    taskId: "T1",
    tests: genericTests,
    errorType: "IMPLEMENTATION",
    changedFiles: ["src/x.ts"],
    attemptDescription: "타입 캐스팅 추가로 해결",
    outcome: "SUCCESS",
  });
  confirmResolution(p1Store, entry.id, "def5678");
  check("E) TS 진단 코드가 포함된 문제는 공통 지식 대상으로 분류됨", isGenericCommonProblem(entry));

  promoteToCommonIfGeneric(commonStore, p1Store.load()[0]);
  check("E) 공통 저장소에 항목이 승격됨", commonStore.load().length === 1);
  check("E) 공통 항목에는 projectId/taskId가 없음(구조적으로 제외)", commonStore.load()[0].projectId === undefined && commonStore.load()[0].taskId === undefined);
  check("E) 공통 항목에는 relatedFiles/recentChangedFiles가 비어있음", commonStore.load()[0].relatedFiles.length === 0 && commonStore.load()[0].recentChangedFiles.length === 0);

  const lookupInP2 = lookupSolution({ projectId: "P2", taskId: "T9", tests: genericTests, projectStore: p2Store, commonStore });
  check("E) P2가 같은 일반 오류를 겪으면 공통 지식에서 재사용 후보를 찾음", lookupInP2 !== undefined);
  check("E) tier=COMMON으로 보고됨", lookupInP2?.tier === "COMMON");
}

function scenarioProjectSpecificProblemNotPromotedToCommon(): void {
  const commonStore = makeMemoryStore();
  const businessLogicTests = tests([
    { name: "secret-storage-isolation-validation", pass: false, failureEvidence: { command: "npm run test:jarvis-storage-isolation", exitCode: 1, stderrTail: "AssertionError: secure storage migration must not define any CREATE POLICY" } },
  ]);
  const fakeEntry: ProblemMemoryEntry = {
    id: "x",
    projectId: "JARVIS",
    taskId: "1.4",
    occurredAt: "now",
    lastSeenAt: "now",
    errorType: "IMPLEMENTATION",
    failedCheck: "secret-storage-isolation-validation",
    errorCode: "1",
    fingerprint: "fp",
    relatedFiles: [],
    recentChangedFiles: [],
    attemptedSolutions: [{ description: "정규 표현식을 statement-anchored로 변경", outcome: "SUCCESS", attemptedAt: "now" }],
    finalSuccessfulSolution: "정규 표현식을 statement-anchored로 변경",
    pendingConfirmation: false,
    verificationTests: ["secret-storage-isolation-validation"],
    reuseSuccessCount: 0,
    reuseFailureCount: 0,
  };
  check("F) JARVIS 고유 비즈니스 로직 문제는 공통 지식 대상이 아님", !isGenericCommonProblem(fakeEntry));
  promoteToCommonIfGeneric(commonStore, fakeEntry);
  check("F) 실제로 공통 저장소에 승격되지 않음", commonStore.load().length === 0);
  void businessLogicTests;
}

// ---------------------------------------------------------------------------
// G) 적용 조건 검증 — 해결 commit이 더 이상 현재 HEAD의 조상이 아니면 재사용하지 않음
// ---------------------------------------------------------------------------
function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "problem-memory-tests-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(join(dir, "a.txt"), "1\n", "utf-8");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function commitHashAt(dir: string): string {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" });
  return res.stdout.trim();
}

function scenarioAncestryCheckRejectsUnreachableCommit(): void {
  const repo = makeTempGitRepo();
  try {
    const projectStore = makeMemoryStore();
    const commonStore = makeMemoryStore();
    const entry = recordAttempt(projectStore, {
      projectId: "P1",
      taskId: "T1",
      tests: FAILING_TESTS,
      errorType: "IMPLEMENTATION",
      changedFiles: [],
      attemptDescription: "해결됨",
      outcome: "SUCCESS",
    });
    const realCommit = commitHashAt(repo);
    confirmResolution(projectStore, entry.id, realCommit);

    const lookupOk = lookupSolution({
      projectId: "P1",
      taskId: "T2",
      tests: FAILING_TESTS,
      projectStore,
      commonStore,
      projectRootForAncestryCheck: repo,
    });
    check("G) 해결 commit이 실제로 현재 HEAD의 조상이면 재사용 후보로 나옴", lookupOk !== undefined);

    // 존재하지 않는(조상이 될 수 없는) commit hash로 바꿔치기 — "이후 변경/재작성"을 흉내낸다.
    confirmResolution(projectStore, entry.id, "0000000000000000000000000000000000000000");
    const lookupRejected = lookupSolution({
      projectId: "P1",
      taskId: "T2",
      tests: FAILING_TESTS,
      projectStore,
      commonStore,
      projectRootForAncestryCheck: repo,
    });
    check("G) 해결 commit이 더 이상 유효한 조상이 아니면 재사용 후보에서 제외됨", lookupRejected === undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// H) 비밀정보 미저장 — 자유 텍스트 필드는 sanitize된다
// ---------------------------------------------------------------------------
function scenarioSecretsNotStoredInFreeText(): void {
  const projectStore = makeMemoryStore();
  recordAttempt(projectStore, {
    projectId: "P1",
    taskId: "T1",
    tests: FAILING_TESTS,
    errorType: "IMPLEMENTATION",
    changedFiles: [],
    attemptDescription: 'fixed by hardcoding access_token: "leak-me-1234567890" temporarily',
    outcome: "FAILURE",
  });
  const stored = JSON.stringify(projectStore.load());
  check("H) attemptDescription에 담긴 비밀값 후보가 저장 전 redact됨", !stored.includes("leak-me-1234567890") && stored.includes("[REDACTED]"));
}

function scenarioPathScrubbing(): void {
  const scrubbed = scrubPathLikeTokens("File at C:\\Users\\hyunj\\OneDrive\\Desktop\\Projects\\JARVIS\\src\\db\\schema\\x.ts caused this");
  check("H) Windows 절대경로가 <path>로 치환됨", !scrubbed.includes("hyunj") && scrubbed.includes("<path>"));
  const scrubbedPosix = scrubPathLikeTokens("at src/db/schema/supabase-secure-storage-schema.test.mjs line 42");
  check("H) POSIX 상대경로도 <path>로 치환됨", !scrubbedPosix.includes("supabase-secure-storage") && scrubbedPosix.includes("<path>"));
}

// ---------------------------------------------------------------------------
// I) 재사용 성공/실패 카운터
// ---------------------------------------------------------------------------
function scenarioReuseCounters(): void {
  const store = makeMemoryStore();
  const entry = recordAttempt(store, {
    projectId: "P1",
    taskId: "T1",
    tests: FAILING_TESTS,
    errorType: "IMPLEMENTATION",
    changedFiles: [],
    attemptDescription: "해결",
    outcome: "SUCCESS",
  });
  recordReuseOutcome(store, entry.id, "SUCCESS");
  recordReuseOutcome(store, entry.id, "SUCCESS");
  recordReuseOutcome(store, entry.id, "FAILURE");
  const reloaded = store.load()[0];
  check("I) 재사용 성공 카운트가 정확히 누적됨", reloaded.reuseSuccessCount === 2);
  check("I) 재사용 실패 카운트가 정확히 누적됨", reloaded.reuseFailureCount === 1);
}

function main(): void {
  scenarioSameTaskDoesNotRecommendAlreadyFailedSolution();
  scenarioCrossTaskReuseWithinSameProject();
  scenarioDifferentFingerprintNotReused();
  scenarioProjectIsolation();
  scenarioCommonKnowledgeReusableAcrossProjects();
  scenarioProjectSpecificProblemNotPromotedToCommon();
  scenarioAncestryCheckRejectsUnreachableCommit();
  scenarioSecretsNotStoredInFreeText();
  scenarioPathScrubbing();
  scenarioReuseCounters();

  console.log("\n=== problem-memory 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
