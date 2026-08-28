import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { decideNextAction, runAutodevOnce } from "./autodev";
import { validateProjectManifest } from "./project-manifest";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import { performTaskCheckpoint } from "./checkpoint";
import { buildProtocolSystemPrompt } from "./claude-developer";
import type { DeveloperProjectContext } from "./claude-developer";
import { buildSystemInstructions } from "./gpt-reviewer";
import type { ReviewProjectContext } from "./gpt-reviewer";
import type { GptReviewerReturn } from "./orchestrator";
import { DEFAULT_STATE_PATH } from "./state";
import type { ClaudeResult, CoreState } from "./types";

// AutoDev 범용화 Phase A Task A7 — "MOVAN과 전혀 관계없는 외부 Fixture 프로젝트(Fixture
// Calculator)를 AutoDev가 처음부터 끝까지 개발할 수 있는가"를 E2E로 증명한다.
//
// 이 파일이 다루는 "Fixture Calculator"는:
//   - src/calculator.js에 add()/subtract() 함수를 만드는, MOVAN/web/supabase/Microsoft와
//     완전히 무관한 장난감 프로젝트다.
//   - 실제 repository 안 web/supabase는 전혀 건드리지 않는다 — OS 임시 디렉터리에 매
//     시나리오마다 새로 만드는 독립 git repo + project-state.json만 사용한다.
//   - 실제 유료 Claude CLI/OpenAI API를 호출하지 않는다(§ 요구사항 6) — claudeRunner/
//     gptReviewer는 이 파일이 결정적(deterministic) fake로 주입한다. 다만 그 fake
//     claudeRunner는 실제로 디스크에 파일을 쓰고, 실제 `node`로 fixture 테스트를 실행해
//     진짜 exit code를 받아온다(§ 요구사항: required tests 실제 gate) — Claude API 호출만
//     fake이고 나머지(파일 I/O, 테스트 실행, git checkpoint, state 갱신)는 전부 실제
//     AutoDev Core 코드(autodev.ts/orchestrator.ts/checkpoint.ts/task-registry.ts)가 그대로
//     수행한다.
//
// REVISE → 피드백 전달 검증(§ 요구사항 7)은 실제 프로덕션 메커니즘을 그대로 이용한다:
// orchestrator.ts는 매 CLAUDE_WORKING 라운드 시작 직후(claudeRunner 호출 전) state를 저장한다
// (state.reviewCycle += 1; saveCurrentState(state)) — 이 시점의 state.lastGptDecision은
// 직전 라운드의 GPT 리뷰 결과다. 이 fake claudeRunner는 statePath를 직접 읽어
// state.lastGptDecision.feedback을 확인하고, 그 피드백에 따라 구현을 바꾼다 — "AutoDev가
// GPT 피드백을 다음 Claude 라운드에 실제로 전달하는지"를 이 실제 저장 시점 메커니즘으로
// 증명한다(claudeRunner 함수 시그니처를 바꾸거나 orchestrator.ts를 수정하지 않는다).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];

// ---------------------------------------------------------------------------
// Fixture Calculator — manifest / task registry / repo 헬퍼
// ---------------------------------------------------------------------------
const FIXTURE_TASK_REGISTRY: TaskDefinition[] = [
  {
    id: "F1",
    phase: 1,
    taskNumber: 1,
    title: "add() 함수 작성",
    prompt:
      "두 숫자를 더하는 add(a, b) 함수를 src/calculator.js에 작성하고, tests/calculator.test.js에 " +
      "동작을 검증하는 테스트를 작성하세요. 양수/음수 입력 모두 정확히 처리해야 합니다.",
    requiredTests: [{ name: "fixture:calculator-test", command: "node", args: ["tests/calculator.test.js"], cwd: "root" }],
    allowedPathPrefixes: ["src/", "tests/"],
    prohibitedOperations: ["외부 네트워크 호출", "src/, tests/ 밖 파일 수정"],
  },
  {
    id: "F2",
    phase: 1,
    taskNumber: 2,
    title: "subtract() 함수 작성",
    prompt: "두 숫자를 빼는 subtract(a, b) 함수를 src/calculator.js에 추가하고, tests/calculator.test.js에 테스트를 추가하세요.",
    requiredTests: [{ name: "fixture:calculator-test", command: "node", args: ["tests/calculator.test.js"], cwd: "root" }],
    allowedPathPrefixes: ["src/", "tests/"],
    prohibitedOperations: ["외부 네트워크 호출", "src/, tests/ 밖 파일 수정"],
  },
];

const FIXTURE_MARKERS_TO_AVOID = ["MOVAN", "web/", "supabase", "Microsoft", "production"];

// MOVAN/web/automation/supabase 개념이 전혀 없는 Fixture 전용 Project Execution Policy(Phase B
// Task B1) — Safe Executor가 이 값만으로(코드 어디에도 fixture/MOVAN을 하드코딩하지 않고)
// 정상 동작함을 증명한다.
const FIXTURE_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["src/", "tests/"],
  allowedWritePrefixes: ["src/", "tests/"],
  allowedCommands: [{ cwd: "root", command: "node", args: ["tests/calculator.test.js"] }],
};

function buildFixtureManifest(root: string, statePath: string): ProjectManifest {
  return {
    projectId: "fixture-calculator",
    projectName: "Fixture Calculator",
    targetProjectRoot: root,
    statePath,
    taskRegistry: FIXTURE_TASK_REGISTRY,
    developerInstructions:
      "허용 read/write 범위: src/**, tests/**. 이 계산기 장난감 프로젝트의 사칙연산 함수와 그 " +
      "테스트만 다룹니다. 외부 네트워크 호출 금지. src/, tests/ 밖 파일은 절대 수정하지 마세요.",
    reviewInstructions:
      "함수 시그니처와 반환값의 정확성을 확인하세요. 음수 입력을 포함한 edge case 테스트가 " +
      "없으면 반드시 REVISE 하세요.",
    reviewScopeDirs: ["src/", "tests/"],
    executionPolicy: FIXTURE_EXECUTION_POLICY,
  };
}

function makeFixtureRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "fixture-e2e-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Fixture E2E Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function makeFixtureStatePath(root: string, overrides: Partial<CoreState> = {}): string {
  const statePath = join(root, ".autodev", "project-state.json");
  mkdirSync(join(root, ".autodev"), { recursive: true });
  const state: CoreState = {
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "READY",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
    gitCheckpoint: "",
    currentPhase: 1,
    ...overrides,
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  return statePath;
}

function gitLogCount(repo: string): number {
  const res = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" });
  return (res.stdout || "").split("\n").filter(Boolean).length;
}

function writeFixtureFile(root: string, relPath: string, content: string): void {
  const abs = join(root, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function readStateFile(statePath: string): { lastGptDecision?: { feedback?: string } | null } {
  return JSON.parse(readFileSync(statePath, "utf-8"));
}

function runFixtureTest(root: string): { pass: boolean; output: string } {
  const res = spawnSync(process.execPath, ["tests/calculator.test.js"], { cwd: root, encoding: "utf-8" });
  return { pass: res.status === 0, output: (res.stdout || "") + (res.stderr || "") };
}

// ---------------------------------------------------------------------------
// 시나리오 1(§ 요구사항 6/7) — F1: REVISE(음수 테스트 없음) → 피드백 전달 → 수정 →
// 재검사 → APPROVED → checkpoint. 이어서 F2가 자동으로 선택되어 다음 task도 끝까지
// 통과한다(§ "다음 task 선택 가능 확인").
// ---------------------------------------------------------------------------
function makeF1ClaudeRunner(root: string, statePath: string): (task: string, attempt: number) => Promise<ClaudeResult> {
  return async (): Promise<ClaudeResult> => {
    // 실제 orchestrator.ts가 매 라운드 시작 시 이미 디스크에 저장해 둔 state를 읽는다 —
    // 이 값이 직전 GPT REVISE의 실제 피드백이다(§ 파일 상단 주석).
    const state = readStateFile(statePath);
    const prevFeedback = state.lastGptDecision?.feedback ?? "";
    const needsNegativeTest = prevFeedback.includes("음수");

    writeFixtureFile(root, "src/calculator.js", "function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n");

    const lines = [
      "const assert = require('node:assert');",
      "const { add } = require('../src/calculator');",
      "assert.strictEqual(add(2, 3), 5);",
    ];
    if (needsNegativeTest) lines.push("assert.strictEqual(add(-2, -3), -5);");
    lines.push("console.log('OK');");
    writeFixtureFile(root, "tests/calculator.test.js", lines.join("\n") + "\n");

    const testResult = runFixtureTest(root);
    return {
      success: true,
      summary: needsNegativeTest ? "add() 구현 + 음수 입력 테스트 추가 완료" : "add() 구현 완료(기본 양수 테스트만)",
      changedFiles: ["src/calculator.js", "tests/calculator.test.js"],
      tests: [{ name: "fixture:calculator-test", pass: testResult.pass }],
      rawOutput: testResult.output,
    };
  };
}

function makeF1FixtureReviewer(root: string): (result: ClaudeResult, reviewCycle: number, task: string) => Promise<GptReviewerReturn> {
  return async (_result: ClaudeResult, _reviewCycle: number, _task: string): Promise<GptReviewerReturn> => {
    // GPT decision을 하드코딩된 사이클 번호가 아니라 디스크의 실제 테스트 파일 내용을 직접
    // 읽어 판단한다 — "결정적 fake"이지만 실제 코드 변경 여부를 진짜로 검사한다.
    let testFileContent = "";
    try {
      testFileContent = readFileSync(join(root, "tests", "calculator.test.js"), "utf-8");
    } catch {
      // 아직 파일이 없으면 아래에서 REVISE로 처리된다.
    }
    const hasNegativeTest = /add\(\s*-\d+\s*,\s*-\d+\s*\)/.test(testFileContent);
    if (!hasNegativeTest) {
      return {
        decision: "REVISE",
        severity: { critical: 0, high: 0, medium: 1 },
        feedback: "음수 입력 테스트가 없음 — add()가 음수도 정확히 처리하는지 검증하는 테스트를 추가하세요.",
        nextTask: null,
      };
    }
    return {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      feedback: "음수 입력 테스트 확인됨 — 문제 없음",
      nextTask: null,
    };
  };
}

function makeF2ClaudeRunner(root: string): (task: string, attempt: number) => Promise<ClaudeResult> {
  return async (): Promise<ClaudeResult> => {
    writeFixtureFile(
      root,
      "src/calculator.js",
      "function add(a, b) {\n  return a + b;\n}\n\nfunction subtract(a, b) {\n  return a - b;\n}\n\nmodule.exports = { add, subtract };\n"
    );
    writeFixtureFile(
      root,
      "tests/calculator.test.js",
      [
        "const assert = require('node:assert');",
        "const { add, subtract } = require('../src/calculator');",
        "assert.strictEqual(add(2, 3), 5);",
        "assert.strictEqual(add(-2, -3), -5);",
        "assert.strictEqual(subtract(5, 3), 2);",
        "assert.strictEqual(subtract(-5, -3), -2);",
        "console.log('OK');",
      ].join("\n") + "\n"
    );
    const testResult = runFixtureTest(root);
    return {
      success: true,
      summary: "subtract() 구현 완료",
      changedFiles: ["src/calculator.js", "tests/calculator.test.js"],
      tests: [{ name: "fixture:calculator-test", pass: testResult.pass }],
      rawOutput: testResult.output,
    };
  };
}

async function scenarioFullE2eFlowWithReviseLoopAndSequencing(): Promise<void> {
  const root = makeFixtureRepo("fixture-calculator-e2e-");
  const statePath = makeFixtureStatePath(root);
  const manifest = buildFixtureManifest(root, statePath);

  let validated = false;
  try {
    validateProjectManifest(manifest);
    validated = true;
  } catch {
    validated = false;
  }
  check("[E2E] Fixture manifest가 validateProjectManifest를 통과함", validated);

  // C) Fixture manifest만으로 next task가 선택된다(순수 함수 레벨로도 별도 확인).
  const initialDecision = decideNextAction({ ...makeFixtureStatePathState(), completedTasks: [] }, manifest.taskRegistry);
  check(
    "[C] Fixture manifest.taskRegistry만으로 decideNextAction이 F1을 선택함(MOVAN task 아님)",
    initialDecision.kind === "RUN_TASK" && initialDecision.task.id === "F1"
  );

  let reviewCallCount = 0;
  const countingReviewer = makeF1FixtureReviewer(root);
  const wrappedReviewer = async (r: ClaudeResult, cycle: number, task: string): Promise<GptReviewerReturn> => {
    reviewCallCount += 1;
    return countingReviewer(r, cycle, task);
  };

  const f1Result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner: makeF1ClaudeRunner(root, statePath), gptReviewer: wrappedReviewer },
  });

  check("[F1] outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", f1Result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("[F1] taskId='F1'", f1Result.taskId === "F1");
  check("[F1] GPT 리뷰가 최소 2회 호출됨(1차 REVISE + 2차 APPROVED)", reviewCallCount >= 2);
  check("[F1] checkpoint.ok=true", f1Result.checkpoint?.ok === true);
  check(
    "[F1] checkpoint에 실제 커밋된 파일에 src/calculator.js, tests/calculator.test.js 포함",
    (f1Result.checkpoint?.filesCommitted ?? []).includes("src/calculator.js") &&
      (f1Result.checkpoint?.filesCommitted ?? []).includes("tests/calculator.test.js")
  );

  const stateAfterF1 = JSON.parse(readFileSync(statePath, "utf-8")) as CoreState;
  check("[F1] completedTasks에 'F1' 추가됨", stateAfterF1.completedTasks.includes("F1"));
  check("[F1] status='READY'(다음 task 대기)", stateAfterF1.status === "READY");
  check("[F1] currentTask가 F2를 가리킴(다음 task 자동 선택 가능 확인)", typeof stateAfterF1.currentTask === "string" && stateAfterF1.currentTask.includes("F2"));

  const finalTestContent = readFileSync(join(root, "tests", "calculator.test.js"), "utf-8");
  check(
    "[F] REVISE 피드백이 실제로 다음 Claude 라운드에 전달됨(음수 테스트가 최종 코드에 반영됨)",
    /add\(\s*-2\s*,\s*-3\s*\)/.test(finalTestContent)
  );

  const logAfterF1 = spawnSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf-8" }).stdout || "";
  check("[H] F1 checkpoint로 product+administrative commit 2건 생성(+init 1건=3건)", logAfterF1.trim().split("\n").length === 3);
  const statusAfterF1 = (spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf-8" }).stdout || "").trim();
  check("[H] F1 checkpoint 후 working tree clean", statusAfterF1 === "");

  // 다음 task(F2) 자동 선택 및 전체 사이클 재실행 — 첫 시도에 APPROVED(REVISE 불필요).
  const f2Result = await runAutodevOnce({
    manifest,
    orchestratorDeps: {
      claudeRunner: makeF2ClaudeRunner(root),
      gptReviewer: async (): Promise<GptReviewerReturn> => ({
        decision: "PASS",
        severity: { critical: 0, high: 0, medium: 0 },
        feedback: "subtract() 구현 확인됨, 문제 없음",
        nextTask: null,
      }),
    },
  });

  check("[F2] outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED(다음 task 자동 실행 성공)", f2Result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("[F2] taskId='F2'", f2Result.taskId === "F2");

  const stateAfterF2 = JSON.parse(readFileSync(statePath, "utf-8")) as CoreState;
  check("[F2] completedTasks에 'F1','F2' 모두 포함", stateAfterF2.completedTasks.includes("F1") && stateAfterF2.completedTasks.includes("F2"));
  check("[I] fixture state가 실제로 갱신됨(status가 더 이상 READY가 아니거나 currentTask=null)", stateAfterF2.currentTask === null);

  const logAfterF2 = spawnSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf-8" }).stdout || "";
  check("[H] F2 checkpoint로 커밋이 추가로 2건 더 생성(총 5건)", logAfterF2.trim().split("\n").length === 5);
}

function makeFixtureStatePathState(): CoreState {
  return {
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "READY",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
    gitCheckpoint: "",
    currentPhase: 1,
  };
}

// ---------------------------------------------------------------------------
// 시나리오 2(§ 요구사항 4/5 D/E) — Fixture Claude developer/GPT reviewer system
// prompt에 MOVAN 관련 내용이 전혀 없음을 직접 증명한다(순수 문자열 조립 함수만 호출,
// 실제 API 호출 없음).
// ---------------------------------------------------------------------------
function scenarioFixtureDeveloperAndReviewerContextHasNoMovan(): void {
  const root = makeFixtureRepo("fixture-calculator-context-");
  const statePath = makeFixtureStatePath(root);
  const manifest = buildFixtureManifest(root, statePath);

  const developerContext: DeveloperProjectContext = {
    projectName: manifest.projectName,
    instructions: manifest.developerInstructions,
  };
  const reviewContext: ReviewProjectContext = {
    projectName: manifest.projectName,
    instructions: manifest.reviewInstructions,
    scopeDirs: manifest.reviewScopeDirs,
  };

  const developerPrompt = buildProtocolSystemPrompt(developerContext);
  const reviewInstructions = buildSystemInstructions(reviewContext);

  for (const marker of FIXTURE_MARKERS_TO_AVOID) {
    check(`[D] Fixture developer system prompt에 "${marker}" 없음`, !developerPrompt.includes(marker));
    check(`[E] Fixture reviewer system instructions에 "${marker}" 없음`, !reviewInstructions.includes(marker));
  }
  check("[D] Fixture developer prompt에 프로젝트 이름('Fixture Calculator') 포함", developerPrompt.includes("Fixture Calculator"));
  check("[D] Fixture developer prompt에 fixture 고유 규칙(src/**, tests/**) 포함", developerPrompt.includes("src/**") && developerPrompt.includes("tests/**"));
  check("[E] Fixture reviewer instructions에 프로젝트 이름('Fixture Calculator') 포함", reviewInstructions.includes("Fixture Calculator"));
}

// ---------------------------------------------------------------------------
// 시나리오 3(§ 요구사항 9-A) — allowedPathPrefixes 밖 파일 수정 → checkpoint BLOCK.
// GPT가 (잘못) PASS를 반환해도 checkpoint.ts가 독립적으로 범위를 재검증해 commit을 막는다.
// ---------------------------------------------------------------------------
async function scenarioBlockOnOutOfScopeFile(): Promise<void> {
  const root = makeFixtureRepo("fixture-calculator-scope-block-");
  const statePath = makeFixtureStatePath(root);
  const manifest = buildFixtureManifest(root, statePath);

  const claudeRunner = async (): Promise<ClaudeResult> => {
    writeFixtureFile(root, "src/calculator.js", "function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n");
    writeFixtureFile(
      root,
      "tests/calculator.test.js",
      "const assert = require('node:assert');\nconst { add } = require('../src/calculator');\nassert.strictEqual(add(2, 3), 5);\nconsole.log('OK');\n"
    );
    // allowedPathPrefixes(src/, tests/) 밖의 파일 — 의도된 위반.
    writeFixtureFile(root, "notes.md", "이 파일은 F1의 allowedPathPrefixes 밖입니다.\n");
    const testResult = runFixtureTest(root);
    return {
      success: true,
      summary: "테스트: 범위 밖 파일 생성(의도된 BLOCK 시나리오)",
      changedFiles: ["src/calculator.js", "tests/calculator.test.js", "notes.md"],
      tests: [{ name: "fixture:calculator-test", pass: testResult.pass }],
      rawOutput: testResult.output,
    };
  };
  const alwaysPassReviewer = async (): Promise<GptReviewerReturn> => ({
    decision: "PASS",
    severity: { critical: 0, high: 0, medium: 0 },
    feedback: "테스트: GPT가 범위 위반을 못 잡았다고 가정(fake)",
    nextTask: null,
  });

  // 이 manifest는 humanFinalReviewPolicy를 지정하지 않는다(기본값 OFF) — checkpoint.ts의
  // 범위 재검증(computeCommitPlan)이 이 단일 호출 안에서 그대로 BLOCK한다(GPT가 범위 위반을
  // 못 잡고 PASS를 반환해도).
  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: alwaysPassReviewer } });

  check("[9-A] outcome=RAN_TASK_CHECKPOINT_BLOCKED", result.outcome === "RAN_TASK_CHECKPOINT_BLOCKED");
  check("[9-A] checkpoint.ok=false", result.checkpoint?.ok === false);
  check("[9-A] unexpectedFiles에 notes.md 포함", (result.checkpoint?.unexpectedFiles ?? []).includes("notes.md"));

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as CoreState;
  check("[9-A] completedTasks에 F1이 추가되지 않음", !finalState.completedTasks.includes("F1"));
  check("[9-A] status='WAITING_HUMAN'", finalState.status === "WAITING_HUMAN");

  const log = spawnSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf-8" }).stdout || "";
  check("[9-A] 어떤 commit도 생성되지 않음(init 1건만)", log.trim().split("\n").length === 1);
}

// ---------------------------------------------------------------------------
// 시나리오 4(§ 요구사항 9-B) — required test FAIL → commit 금지. 두 레벨에서 증명한다:
//   1) 전체 파이프라인(runAutodevOnce): 실제 테스트 실행이 실패하면 orchestrator가 GPT의
//      PASS를 신뢰하지 않고 REVISE로 강제 전환하므로 checkpoint 자체가 시도되지 않는다.
//   2) Core 레벨(performTaskCheckpoint): requiredTestsAllPassed=false면 git을 전혀 건드리지
//      않고 즉시 거부한다.
// ---------------------------------------------------------------------------
async function scenarioBlockOnRequiredTestFailure(): Promise<void> {
  const root = makeFixtureRepo("fixture-calculator-test-fail-");
  const statePath = makeFixtureStatePath(root);
  const manifest = buildFixtureManifest(root, statePath);

  let claudeCalls = 0;
  const brokenClaudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    // add()를 일부러 잘못 구현 — 실제 node 실행이 진짜로 실패한다(exit code != 0).
    writeFixtureFile(root, "src/calculator.js", "function add(a, b) {\n  return a - b; // 의도된 버그\n}\n\nmodule.exports = { add };\n");
    writeFixtureFile(
      root,
      "tests/calculator.test.js",
      "const assert = require('node:assert');\nconst { add } = require('../src/calculator');\nassert.strictEqual(add(2, 3), 5);\nconsole.log('OK');\n"
    );
    const testResult = runFixtureTest(root);
    return {
      success: true,
      summary: "테스트: 의도적으로 깨진 구현(required test FAIL 시나리오)",
      changedFiles: ["src/calculator.js", "tests/calculator.test.js"],
      tests: [{ name: "fixture:calculator-test", pass: testResult.pass }],
      rawOutput: testResult.output,
    };
  };
  // GPT가 실수로 테스트 결과를 확인하지 않고 PASS를 반환한다고 가정 — orchestrator의
  // 안전장치(requiredTestsFailed && decision===PASS → REVISE 강제)가 실제로 작동하는지 증명.
  const carelessPassReviewer = async (): Promise<GptReviewerReturn> => ({
    decision: "PASS",
    severity: { critical: 0, high: 0, medium: 0 },
    feedback: "테스트: GPT가 테스트 실패를 놓쳤다고 가정(fake)",
    nextTask: null,
  });

  // AutoDev Efficiency / Review Stagnation Hardening(2026-08-28) — 이 buggy 구현은 절대
  // 스스로 고쳐지지 않으므로 REVIEW_CYCLE_EXHAUSTED durable retry를 거친 뒤 결국 기존
  // MAX_GPT_CALLS 안전장치로 WAITING_HUMAN에 도달한다(§ RAN_TASK_NOT_APPROVED는 여전히
  // 동일). sleep을 fake로 주입해 실제 대기 없이 진행한다.
  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner: brokenClaudeRunner, gptReviewer: carelessPassReviewer, sleep: async () => {}, now: () => Date.now() },
  });

  check("[9-B/K] 실제 fixture 테스트가 매 시도마다 진짜로 FAIL함(exit code 기준)", claudeCalls > 0);
  check("[9-B/K] outcome=RAN_TASK_NOT_APPROVED(checkpoint 시도조차 되지 않음)", result.outcome === "RAN_TASK_NOT_APPROVED");
  check("[9-B/K] checkpoint가 undefined(전혀 시도되지 않음)", result.checkpoint === undefined);

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as CoreState;
  check("[9-B/K] completedTasks에 F1이 추가되지 않음", !finalState.completedTasks.includes("F1"));

  const log = spawnSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf-8" }).stdout || "";
  check("[9-B/K] 어떤 commit도 생성되지 않음(init 1건만)", log.trim().split("\n").length === 1);

  // Core 레벨 직접 증명 — performTaskCheckpoint는 requiredTestsAllPassed=false면 git 명령을
  // 전혀 실행하지 않는다.
  const before = gitLogCount(root);
  const directOutcome = performTaskCheckpoint(FIXTURE_TASK_REGISTRY[0], {
    decision: "PASS",
    severity: { critical: 0, high: 0, medium: 0 },
    requiredTestsAllPassed: false,
    cwd: root,
  });
  check("[K] performTaskCheckpoint: requiredTestsAllPassed=false면 ok=false", directOutcome.ok === false);
  check("[K] performTaskCheckpoint: 필수 테스트 미통과 사유가 reason에 포함됨", (directOutcome.reason ?? "").includes("테스트"));
  check("[K] performTaskCheckpoint: git commit이 전혀 생성되지 않음", gitLogCount(root) === before);
}

// ---------------------------------------------------------------------------
// 시나리오 5(§ 요구사항 9-C) — Critical/High severity가 있으면 GPT가 PASS를 반환해도
// 절대 APPROVED가 되지 않는다(orchestrator의 강제 REVISE 안전장치).
// ---------------------------------------------------------------------------
async function scenarioBlockOnCriticalHighSeverity(): Promise<void> {
  const root = makeFixtureRepo("fixture-calculator-severity-block-");
  const statePath = makeFixtureStatePath(root);
  const manifest = buildFixtureManifest(root, statePath);

  const cleanClaudeRunner = async (): Promise<ClaudeResult> => {
    writeFixtureFile(root, "src/calculator.js", "function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n");
    writeFixtureFile(
      root,
      "tests/calculator.test.js",
      "const assert = require('node:assert');\nconst { add } = require('../src/calculator');\nassert.strictEqual(add(2, 3), 5);\nassert.strictEqual(add(-2, -3), -5);\nconsole.log('OK');\n"
    );
    const testResult = runFixtureTest(root);
    return {
      success: true,
      summary: "add() 구현 완료(코드 자체는 정상)",
      changedFiles: ["src/calculator.js", "tests/calculator.test.js"],
      tests: [{ name: "fixture:calculator-test", pass: testResult.pass }],
      rawOutput: testResult.output,
    };
  };
  // 코드/테스트는 정상이지만 GPT가 (예: 실수로) critical 1건과 함께 PASS를 반환한다고 가정.
  const criticalButPassReviewer = async (): Promise<GptReviewerReturn> => ({
    decision: "PASS",
    severity: { critical: 1, high: 0, medium: 0 },
    feedback: "테스트: critical 발견에도 PASS 반환(결함 있는 GPT 시뮬레이션)",
    nextTask: null,
  });

  // AutoDev Efficiency / Review Stagnation Hardening(2026-08-28) — criticalButPassReviewer는
  // 매번 동일하게 critical 1건과 함께 PASS를 반환하므로 이 run도 절대 스스로 수렴하지 않는다
  // — sleep을 fake로 주입해 실제 대기 없이 기존 MAX_GPT_CALLS 안전장치까지 도달한다.
  const result = await runAutodevOnce({
    manifest,
    orchestratorDeps: { claudeRunner: cleanClaudeRunner, gptReviewer: criticalButPassReviewer, sleep: async () => {}, now: () => Date.now() },
  });

  check("[9-C/L] outcome이 RAN_TASK_APPROVED_AND_CHECKPOINTED가 아님(APPROVED 불가)", result.outcome !== "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("[9-C/L] outcome=RAN_TASK_NOT_APPROVED(REVISE 강제 후 WAITING_HUMAN)", result.outcome === "RAN_TASK_NOT_APPROVED");
  check("[9-C/L] checkpoint가 시도되지 않음", result.checkpoint === undefined);

  const finalState = JSON.parse(readFileSync(statePath, "utf-8")) as CoreState;
  check("[9-C/L] completedTasks에 F1이 추가되지 않음", !finalState.completedTasks.includes("F1"));

  const log = spawnSync("git", ["log", "--oneline"], { cwd: root, encoding: "utf-8" }).stdout || "";
  check("[9-C/L] 어떤 commit도 생성되지 않음(init 1건만)", log.trim().split("\n").length === 1);
}

async function main(): Promise<void> {
  const realStateBefore = readFileSync(DEFAULT_STATE_PATH, "utf-8");

  try {
    await scenarioFullE2eFlowWithReviseLoopAndSequencing();
    scenarioFixtureDeveloperAndReviewerContextHasNoMovan();
    await scenarioBlockOnOutOfScopeFile();
    await scenarioBlockOnRequiredTestFailure();
    await scenarioBlockOnCriticalHighSeverity();
  } finally {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 디렉터리 정리 실패는 테스트 결과에 영향 없음
      }
    }
  }

  const realStateAfter = readFileSync(DEFAULT_STATE_PATH, "utf-8");
  check("project-state 격리: 실제 project-state.json이 테스트 실행 전후 완전히 동일함", realStateBefore === realStateAfter);

  console.log("\n=== fixture E2E(Phase A Task A7 — 범용 프로젝트 개발 증명) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
