import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { evaluateApproval, computeCommitPlan, performTaskCheckpoint, commitProjectStateOnly } from "./checkpoint";
import { captureTaskChangeBaseline } from "./task-change-baseline";
import type { TaskDefinition } from "./task-registry";

// 이 테스트는 실제 프로젝트 git repo에 어떤 git 명령도 실행하지 않는다 — 매 시나리오마다
// OS 임시 디렉터리에 별도의 throwaway git repo를 만들어 그 안에서만 add/commit/rev-parse를
// 수행하고, 끝나면 디렉터리 자체를 삭제한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "movan-checkpoint-test-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "autodev-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "AutoDev Test"], { cwd: dir });
  // 최초 커밋(빈 상태) — HEAD가 아예 없으면 일부 git 명령 동작이 달라지는 것을 피한다.
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

function gitLogCount(repo: string): number {
  const res = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" });
  return (res.stdout || "").split("\n").filter(Boolean).length;
}

function fakeTask(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: "99.1",
    phase: 99,
    taskNumber: 1,
    title: "체크포인트 테스트용 가짜 task",
    prompt: "(테스트 전용)",
    requiredTests: [],
    allowedPathPrefixes: ["src/allowed/"],
    prohibitedOperations: [],
    ...overrides,
  };
}

function scenarioEvaluateApproval(): void {
  check(
    "evaluateApproval: decision!=PASS → 거부",
    evaluateApproval({ decision: "REVISE", severity: { critical: 0, high: 0, medium: 0 }, requiredTestsAllPassed: true }).approved === false
  );
  check(
    "evaluateApproval: critical>0 → 거부",
    evaluateApproval({ decision: "PASS", severity: { critical: 1, high: 0, medium: 0 }, requiredTestsAllPassed: true }).approved === false
  );
  check(
    "evaluateApproval: high>0 → 거부",
    evaluateApproval({ decision: "PASS", severity: { critical: 0, high: 1, medium: 0 }, requiredTestsAllPassed: true }).approved === false
  );
  check(
    "evaluateApproval: 필수 테스트 미통과 → 거부",
    evaluateApproval({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, requiredTestsAllPassed: false }).approved === false
  );
  check(
    "evaluateApproval: PASS+critical/high=0+테스트 전부 통과 → 승인",
    evaluateApproval({ decision: "PASS", severity: { critical: 0, high: 0, medium: 2 }, requiredTestsAllPassed: true }).approved === true
  );
}

function scenarioComputeCommitPlan(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "src/allowed/a.ts", "export const a = 1;\n");
    writeFile(repo, "src/outside/b.ts", "export const b = 2;\n");
    const plan = computeCommitPlan(fakeTask(), repo);
    check("computeCommitPlan: allowed에 src/allowed/a.ts 포함", plan.allowed.some((c) => c.path === "src/allowed/a.ts"));
    check("computeCommitPlan: unexpected에 src/outside/b.ts 포함", plan.unexpected.some((c) => c.path === "src/outside/b.ts"));
    check("computeCommitPlan: allowed에 src/outside/b.ts 없음", !plan.allowed.some((c) => c.path === "src/outside/b.ts"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// Checkpoint Provenance/Baseline Hardening(2026-08-31, JARVIS Task 5.3 Canary 사실검증 —
// §9 회귀 시나리오 A~H) — baseline이 "task 시작 전부터 있던 변경"과 "이 task가 실제로 만든
// 변경"을 실제 파일 내용(sha256)으로 구분하는지 검증한다. 두 실제 JARVIS 손상 파일은 이
// fixture로 절대 쓰지 않는다 — 임시 git repo에 이 테스트가 직접 만드는 파일만 쓴다.

// §9-A. pre-existing out-of-scope untracked unchanged → 보존, checkpoint 방해 안 함.
function scenarioBaselinePreExistingOutOfScopeUnchangedPreserved(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "src/outside/stray.txt", "이 task와 무관한 기존 파일\n");
    const baseline = captureTaskChangeBaseline("99.1", repo);
    writeFile(repo, "src/allowed/a.ts", "export const a = 1;\n");
    const outcome = performTaskCheckpoint(fakeTask(), {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
      baseline,
    });
    check("§9-A pre-existing out-of-scope unchanged: checkpoint가 BLOCK되지 않음(ok=true)", outcome.ok === true);
    check(
      "§9-A pre-existing out-of-scope unchanged: commit 대상에 stray.txt가 없음",
      !(outcome.filesCommitted ?? []).includes("src/outside/stray.txt")
    );
    const statusAfter = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf-8" });
    check(
      "§9-A pre-existing out-of-scope unchanged: 파일 자체는 삭제되지 않고 그대로 남음",
      (statusAfter.stdout || "").includes("stray.txt")
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// §9-B. pre-existing out-of-scope untracked modified during Task → BLOCK.
function scenarioBaselinePreExistingOutOfScopeModifiedBlocks(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "src/outside/stray.txt", "원래 내용\n");
    const baseline = captureTaskChangeBaseline("99.1", repo);
    writeFile(repo, "src/allowed/a.ts", "export const a = 1;\n");
    writeFile(repo, "src/outside/stray.txt", "이번 task 도중 내용이 바뀜\n");
    const outcome = performTaskCheckpoint(fakeTask(), {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
      baseline,
    });
    check("§9-B pre-existing out-of-scope modified: BLOCK(ok=false)", outcome.ok === false);
    check("§9-B pre-existing out-of-scope modified: unexpectedFiles에 stray.txt 포함", (outcome.unexpectedFiles ?? []).includes("src/outside/stray.txt"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// §9-C. new out-of-scope untracked created during Task(baseline 있어도) → BLOCK.
function scenarioBaselineNewOutOfScopeCreatedDuringTaskBlocks(): void {
  const repo = makeTempGitRepo();
  try {
    const baseline = captureTaskChangeBaseline("99.1", repo); // 시작 시점 clean
    writeFile(repo, "src/allowed/a.ts", "export const a = 1;\n");
    writeFile(repo, "src/outside/new-junk.txt", "이 task 도중 새로 생김\n");
    const outcome = performTaskCheckpoint(fakeTask(), {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
      baseline,
    });
    check("§9-C new out-of-scope created during task: BLOCK(ok=false)", outcome.ok === false);
    check(
      "§9-C new out-of-scope created during task: unexpectedFiles에 new-junk.txt 포함",
      (outcome.unexpectedFiles ?? []).includes("src/outside/new-junk.txt")
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// §9-F. pre-existing in-scope dirty unchanged → current Task commit에 포함 금지.
function scenarioBaselinePreExistingInScopeUnchangedExcludedFromCommit(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "src/allowed/pre-existing-wip.ts", "// 사용자가 이미 작업 중이던 미완성 코드\n");
    const baseline = captureTaskChangeBaseline("99.1", repo);
    writeFile(repo, "src/allowed/a.ts", "export const a = 1;\n"); // 이 task 자신의 실제 산출물
    const before = gitLogCount(repo);
    const outcome = performTaskCheckpoint(fakeTask(), {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
      baseline,
    });
    check("§9-F pre-existing in-scope unchanged: checkpoint 성공(ok=true)", outcome.ok === true);
    check("§9-F pre-existing in-scope unchanged: commit 1건 생성", gitLogCount(repo) === before + 1);
    check(
      "§9-F pre-existing in-scope unchanged: commit 대상에 이 task 산출물(a.ts)만 포함되고 pre-existing-wip.ts는 빠짐",
      (outcome.filesCommitted ?? []).includes("src/allowed/a.ts") && !(outcome.filesCommitted ?? []).includes("src/allowed/pre-existing-wip.ts")
    );
    const statusAfter = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf-8" });
    check(
      "§9-F pre-existing in-scope unchanged: 사용자의 기존 파일은 삭제되지 않고 미커밋 상태로 남음",
      (statusAfter.stdout || "").includes("pre-existing-wip.ts")
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// §9-G. pre-existing in-scope file modified during Task → 훼손하거나 통째로 commit하지 않음
// (내용을 건드리지 않고 checkpoint 전체를 BLOCK — provenance가 섞여 안전하게 분리할 수 없다).
function scenarioBaselinePreExistingInScopeModifiedBlocksWithoutCorrupting(): void {
  const repo = makeTempGitRepo();
  try {
    const originalContent = "// 사용자의 기존 미완성 작업\nexport const wip = 1;\n";
    writeFile(repo, "src/allowed/mixed.ts", originalContent);
    const baseline = captureTaskChangeBaseline("99.1", repo);
    const taskModifiedContent = "// 사용자의 기존 미완성 작업\nexport const wip = 1;\nexport const addedByTask = 2;\n";
    writeFile(repo, "src/allowed/mixed.ts", taskModifiedContent); // 같은 in-scope 파일을 task가 이어서 수정
    const before = gitLogCount(repo);
    const outcome = performTaskCheckpoint(fakeTask(), {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
      baseline,
    });
    check("§9-G pre-existing in-scope modified: BLOCK(ok=false, 통째로 commit하지 않음)", outcome.ok === false);
    check("§9-G pre-existing in-scope modified: unexpectedFiles에 mixed.ts 포함", (outcome.unexpectedFiles ?? []).includes("src/allowed/mixed.ts"));
    check("§9-G pre-existing in-scope modified: commit이 생성되지 않음", gitLogCount(repo) === before);
    const actualContent = readFileSync(join(repo, "src/allowed/mixed.ts"), "utf-8");
    check("§9-G pre-existing in-scope modified: 파일 내용 자체는 전혀 훼손되지 않음(task가 만든 내용 그대로 보존)", actualContent === taskModifiedContent);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// §9-H. clean baseline의 정상 Task → 기존 checkpoint 동작 회귀 없음(baseline을 명시적으로
// 넘겨도 결과가 baseline 없이 호출했을 때(§ scenarioPerformCheckpointHappyPath)와 동일하다).
function scenarioBaselineCleanStartNoRegression(): void {
  const repo = makeTempGitRepo();
  try {
    const baseline = captureTaskChangeBaseline("99.1", repo); // 시작 시점 완전히 clean
    writeFile(repo, "src/allowed/a.ts", "export const a = 1;\n");
    writeFile(repo, "src/allowed/b.ts", "export const b = 2;\n");
    const before = gitLogCount(repo);
    const outcome = performTaskCheckpoint(fakeTask(), {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
      baseline,
    });
    check("§9-H clean baseline 정상 task: ok=true(회귀 없음)", outcome.ok === true);
    check(
      "§9-H clean baseline 정상 task: 두 파일 모두 commit됨",
      (outcome.filesCommitted ?? []).includes("src/allowed/a.ts") && (outcome.filesCommitted ?? []).includes("src/allowed/b.ts")
    );
    check("§9-H clean baseline 정상 task: commit 1건 생성", gitLogCount(repo) === before + 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// 레거시 호환 — baseline을 아예 넘기지 않으면(이 기능 도입 이전 project-state.json) 이
// 기능 도입 이전과 완전히 동일한 fallback(pre-existing out-of-scope 파일도 여전히 BLOCK)
// 으로 동작해야 한다. §9-A와 대비해 baseline의 실제 효과를 증명한다.
function scenarioBaselineMissingFallsBackToLegacyBehavior(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "src/outside/stray.txt", "이 task와 무관한 기존 파일\n");
    writeFile(repo, "src/allowed/a.ts", "export const a = 1;\n");
    const outcome = performTaskCheckpoint(fakeTask(), {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
      // baseline 미지정 — 레거시 fallback
    });
    check("baseline 미지정(레거시): 여전히 BLOCK됨(회귀 아님, 도입 이전과 동일)", outcome.ok === false);
    check("baseline 미지정(레거시): unexpectedFiles에 stray.txt 포함", (outcome.unexpectedFiles ?? []).includes("src/outside/stray.txt"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioPerformCheckpointHappyPath(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "src/allowed/a.ts", "export const a = 1;\n");
    writeFile(repo, "src/allowed/b.ts", "export const b = 2;\n");
    const before = gitLogCount(repo);
    const outcome = performTaskCheckpoint(fakeTask(), {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      reviewFeedback: "테스트 통과, 문제 없음",
      cwd: repo,
    });
    check("performTaskCheckpoint happy path: ok=true", outcome.ok === true);
    check("performTaskCheckpoint happy path: commitHash 반환됨", typeof outcome.commitHash === "string" && outcome.commitHash.length > 0);
    check(
      "performTaskCheckpoint happy path: filesCommitted에 두 파일 모두 포함",
      (outcome.filesCommitted ?? []).includes("src/allowed/a.ts") && (outcome.filesCommitted ?? []).includes("src/allowed/b.ts")
    );
    check("performTaskCheckpoint happy path: 실제로 commit 1건 생성됨", gitLogCount(repo) === before + 1);

    const statusAfter = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf-8" });
    check("performTaskCheckpoint happy path: commit 후 working tree clean", (statusAfter.stdout || "").trim() === "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioPerformCheckpointUnexpectedBlocks(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "src/allowed/a.ts", "export const a = 1;\n");
    writeFile(repo, "src/outside/evil.ts", "export const evil = true;\n");
    const before = gitLogCount(repo);
    const outcome = performTaskCheckpoint(fakeTask(), {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
    });
    check("performTaskCheckpoint unexpected: ok=false(BLOCK)", outcome.ok === false);
    check("performTaskCheckpoint unexpected: unexpectedFiles에 src/outside/evil.ts 포함", (outcome.unexpectedFiles ?? []).includes("src/outside/evil.ts"));
    check("performTaskCheckpoint unexpected: commit이 생성되지 않음", gitLogCount(repo) === before);

    const statusAfter = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf-8" });
    check(
      "performTaskCheckpoint unexpected: 두 파일 모두 여전히 미커밋 상태로 남음(부분 commit 없음)",
      (statusAfter.stdout || "").includes("src/allowed/a.ts") && (statusAfter.stdout || "").includes("src/outside/evil.ts")
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioPerformCheckpointRejectedApproval(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "src/allowed/a.ts", "export const a = 1;\n");
    const before = gitLogCount(repo);
    const outcome = performTaskCheckpoint(fakeTask(), {
      decision: "REVISE",
      severity: { critical: 0, high: 1, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
    });
    check("performTaskCheckpoint 미승인(REVISE): ok=false", outcome.ok === false);
    check("performTaskCheckpoint 미승인(REVISE): git 명령 자체가 실행되지 않음(commit 없음)", gitLogCount(repo) === before);

    const statusAfter = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf-8" });
    check("performTaskCheckpoint 미승인(REVISE): 파일이 손대지지 않고(미staged) 그대로 남음", (statusAfter.stdout || "").startsWith("??"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioNoChangesToCommit(): void {
  const repo = makeTempGitRepo();
  try {
    const outcome = performTaskCheckpoint(fakeTask(), {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
    });
    check("performTaskCheckpoint 변경 없음: ok=false", outcome.ok === false);
    check("performTaskCheckpoint 변경 없음: reason에 '변경 파일이 없습니다' 포함", (outcome.reason ?? "").includes("변경 파일이 없습니다"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// AutoDev Core Maintenance — Crash-safe Checkpoint Idempotency(Category B). 실제 production
// 재시작 시나리오를 재현한다: product commit이 이미 성공한 뒤(예: autodev.ts
// RESUME_APPROVED_CHECKPOINT 경로로 재시도되는 crash 직후) 같은 taskDef로 performTaskCheckpoint를
// 다시 호출하면 working tree는 이미 clean하다 — 이때 새 commit을 만들지 않고 기존 HEAD를
// idempotent success로 반환해야 한다(§ checkpoint.ts plan.allowed.length===0 분기).
function scenarioPerformCheckpointIdempotentResume(): void {
  const repo = makeTempGitRepo();
  try {
    const task = fakeTask({ id: "77.1", phase: 77, taskNumber: 1, title: "재시작 재현용 task" });
    writeFile(repo, "src/allowed/a.ts", "export const a = 1;\n");
    const first = performTaskCheckpoint(task, {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
    });
    check("idempotent resume: 최초 commit ok=true", first.ok === true);
    const afterFirst = gitLogCount(repo);

    // 같은 task를 같은 옵션으로 다시 호출한다 — working tree는 이미 clean(직전 commit으로
    // 아무 변경도 남지 않음). 실제로는 이 두 번째 호출 사이에 프로세스가 죽고 재시작됐다는
    // 뜻이다.
    const second = performTaskCheckpoint(task, {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
    });
    check("idempotent resume: 재시도 ok=true(WAITING_HUMAN으로 잘못 막히지 않음)", second.ok === true);
    check(
      "idempotent resume: 재시도 commitHash가 최초 commit과 정확히 동일함(새 commit 아님)",
      second.commitHash !== undefined && second.commitHash === first.commitHash
    );
    check("idempotent resume: 새 commit이 실제로 생성되지 않음(commit 개수 불변)", gitLogCount(repo) === afterFirst);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// 대조군 — HEAD가 우연히 clean하더라도 이 task의 commit이 아니면(다른 task/무관한 이유로
// clean한 경우) idempotent success로 오판하지 않고 기존과 동일하게 실패해야 한다.
function scenarioPerformCheckpointNoFalseIdempotentMatch(): void {
  const repo = makeTempGitRepo();
  try {
    const before = gitLogCount(repo);
    const outcome = performTaskCheckpoint(fakeTask({ id: "77.2", phase: 77, taskNumber: 2, title: "다른 task" }), {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
    });
    check("idempotent 오판 방지: HEAD가 이 task의 commit이 아니면 여전히 ok=false", outcome.ok === false);
    check("idempotent 오판 방지: commit이 생성되지 않음", gitLogCount(repo) === before);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioCommitProjectStateOnly(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "automation/config/project-state.json", '{"status":"READY"}\n');
    const before = gitLogCount(repo);
    const outcome = commitProjectStateOnly("automation/config/project-state.json", "chore: test state commit", repo);
    check("commitProjectStateOnly: ok=true", outcome.ok === true);
    check("commitProjectStateOnly: commit 1건 생성", gitLogCount(repo) === before + 1);
    check("commitProjectStateOnly: filesCommitted가 project-state.json만 포함", JSON.stringify(outcome.filesCommitted) === JSON.stringify(["automation/config/project-state.json"]));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioCommitProjectStateOnlyBlocksOnPollutedIndex(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "automation/config/project-state.json", '{"status":"READY"}\n');
    writeFile(repo, "src/allowed/unrelated.ts", "export const x = 1;\n");
    // index를 미리 오염시킨다(예: 다른 코드 경로가 실수로 다른 파일까지 add해버린 상황을
    // 재현) — commitProjectStateOnly는 project-state 파일 하나만 add하지만, 이미 다른
    // 파일이 staged돼 있으면 diff --cached --name-only에 함께 잡혀 BLOCK되어야 한다.
    spawnSync("git", ["add", "--", "src/allowed/unrelated.ts"], { cwd: repo });
    const before = gitLogCount(repo);
    const outcome = commitProjectStateOnly("automation/config/project-state.json", "chore: test state commit", repo);
    check("commitProjectStateOnly 오염된 index: ok=false(BLOCK)", outcome.ok === false);
    check("commitProjectStateOnly 오염된 index: commit 생성되지 않음", gitLogCount(repo) === before);
    const statusAfter = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf-8" });
    check(
      "commitProjectStateOnly 오염된 index: reset되어 두 파일 모두 미staged 상태로 남음",
      !(statusAfter.stdout || "").includes("A  ") && !(statusAfter.stdout || "").includes("M  ")
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function main(): void {
  scenarioEvaluateApproval();
  scenarioComputeCommitPlan();
  scenarioBaselinePreExistingOutOfScopeUnchangedPreserved();
  scenarioBaselinePreExistingOutOfScopeModifiedBlocks();
  scenarioBaselineNewOutOfScopeCreatedDuringTaskBlocks();
  scenarioBaselinePreExistingInScopeUnchangedExcludedFromCommit();
  scenarioBaselinePreExistingInScopeModifiedBlocksWithoutCorrupting();
  scenarioBaselineCleanStartNoRegression();
  scenarioBaselineMissingFallsBackToLegacyBehavior();
  scenarioPerformCheckpointHappyPath();
  scenarioPerformCheckpointUnexpectedBlocks();
  scenarioPerformCheckpointRejectedApproval();
  scenarioNoChangesToCommit();
  scenarioPerformCheckpointIdempotentResume();
  scenarioPerformCheckpointNoFalseIdempotentMatch();
  scenarioCommitProjectStateOnly();
  scenarioCommitProjectStateOnlyBlocksOnPollutedIndex();

  console.log("\n=== checkpoint 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
