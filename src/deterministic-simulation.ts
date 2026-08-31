import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runAutodevOnce } from "./autodev";
// (decideNextAction은 이 파일이 직접 호출하지 않는다 — runAutodevOnce/runAutodevContinuous가
// 이미 내부적으로 사용하며, 이 시뮬레이션은 그 canonical 경로만 재사용한다.)
import { runAutodevContinuous } from "./continuous-runner";
import type { ClaudeResult, CoreState } from "./types";
import type { GptReviewerReturn } from "./orchestrator";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import { acquireProjectLock, releaseProjectLock } from "./project-lock";
import { classifyWaitingHumanReason } from "./human-gate-policy";
import { deriveAllowedCommandsFromRequiredTests } from "./execution-contract";

// AutoDev 1.0 Hardening — Deterministic Simulation(Section 13 of the stabilization plan).
//
// 목적: 실제 Claude/Reviewer API 없이, 기존 fixture 인프라(fixture-e2e-tests.ts와 동일한
// injectable claudeRunner/gptReviewer + 실제 임시 git repo + 실제 checkpoint/project-lock
// 코드)를 그대로 재사용해 AutoDev의 장시간 무인 연속개발 안정성을 대규모(수백 task)로
// 검증한다. 새 프레임워크를 만들지 않는다 — runAutodevOnce/runAutodevContinuous/
// decideNextAction/acquireProjectLock을 이미 있는 그대로 호출할 뿐이다.
//
// 이 파일은 build-once regression(full-regression-runner.ts)/smoke-test.ts와 동일한
// 관례로 "test:" 접두사 없는 독립 스크립트다 — 실제 git 명령을 수백 회 실행해 몇 초~1분
// 단위로 걸릴 수 있어 매 `npm run regression` 실행에 포함하지 않는다.
//
// seed 기반 결정적 PRNG — 동일 AUTODEV_SIMULATION_SEED로 항상 동일한 실패를 재현할 수
// 있다. sleep은 실제로 대기하지 않고 virtual clock만 전진시킨다(§ 과거 "fake sleep 즉시
// 반환 + retry budget reset"이 tight loop를 만들었던 문제 — 이 파일의 모든 반복 경로는
// 실제 코드의 기존 COUNT 기반 상한(MAX_REVIEW_CYCLES/MAX_GPT_CALLS/
// technicalRecoveryCount/이 파일 자체의 MAX_SIMULATED_SUPERVISOR_RESTARTS)에 의해서만
// 종료되며, 그 어떤 상한도 실제 경과 시간에 의존하지 않는다 — sleep이 즉시 끝나도 무한
// 반복이 생기지 않는다).

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = Number(process.env.AUTODEV_SIMULATION_SEED ?? 20260830);
const rand = mulberry32(SEED);
function chance(p: number): boolean {
  return rand() < p;
}
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

// ---------------------------------------------------------------------------
// 결과 집계
// ---------------------------------------------------------------------------
const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
  if (!cond) {
    // eslint-disable-next-line no-console
    console.error(`SIMULATION FAILURE (seed=${SEED}): ${label}`);
  }
}

// ---------------------------------------------------------------------------
// virtual clock — 실제로 기다리지 않되, 경과 시간을 읽는 코드(예: developerProviderNextRetryAt
// 계산)에는 시간이 실제로 흐른 것처럼 보이게 한다.
// ---------------------------------------------------------------------------
let virtualNowMs = Date.parse("2026-08-30T00:00:00.000Z");
const fakeNow = (): number => virtualNowMs;
const fakeSleep = async (ms: number): Promise<void> => {
  virtualNowMs += ms;
};

// ---------------------------------------------------------------------------
// fixture repo/manifest 헬퍼(§ fixture-e2e-tests.ts와 동일한 패턴 재사용)
// ---------------------------------------------------------------------------
const tempDirs: string[] = [];
function makeSimRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "autodev-simulation@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "AutoDev Simulation" ], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function makeSimStatePath(root: string, overrides: Partial<CoreState> = {}): string {
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

const SIM_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["src/", "tests/"],
  allowedWritePrefixes: ["src/", "tests/"],
  allowedCommands: [{ cwd: "root", command: "node", args: ["tests/run.js"] }],
};

function buildSimManifest(root: string, statePath: string, taskRegistry: TaskDefinition[], projectId: string): ProjectManifest {
  return {
    projectId,
    projectName: "AutoDev Deterministic Simulation Fixture",
    targetProjectRoot: root,
    statePath,
    taskRegistry,
    developerInstructions: "허용 범위: src/**, tests/**. 시뮬레이션 전용 fixture — 실제 프로젝트가 아님.",
    reviewInstructions: "시뮬레이션 fixture — 이 project는 fake gptReviewer로만 검토된다.",
    reviewScopeDirs: ["src/", "tests/"],
    // Hardening A(Execution Contract를 Runtime 불변조건으로) — 실제 spec-planner.ts 산출물처럼
    // allowedCommands를 이 taskRegistry의 requiredTests로부터 매번 파생시킨다. bulk simulation
    // (runBulkSimulation)은 task마다 다른 args(인덱스 포함)를 쓰므로, 고정된 단일
    // allowedCommands 항목으로는 exact-match할 수 없다 — 새 검증 로직이 아니라 이미 다른
    // fixture에서 쓴 것과 동일한 패턴을 재사용한다.
    executionPolicy: { ...SIM_EXECUTION_POLICY, allowedCommands: deriveAllowedCommandsFromRequiredTests(taskRegistry.map((t) => ({ taskId: t.id, requiredTests: t.requiredTests }))) },
  };
}

function writeSimFile(root: string, relPath: string, content: string): void {
  const abs = join(root, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function gitLogSubjects(repo: string): string[] {
  const res = spawnSync("git", ["log", "--format=%s"], { cwd: repo, encoding: "utf-8" });
  return (res.stdout || "").split("\n").filter(Boolean);
}

function readState(statePath: string): CoreState {
  return JSON.parse(readFileSync(statePath, "utf-8")) as CoreState;
}

// ---------------------------------------------------------------------------
// Run A — 대규모(수백) task, 전부 "결국 완료 가능"한 프로파일만 사용한다(§ getNextTask가
// registry 순서를 엄격히 지키므로, 영구 정체 task를 섞으면 그 뒤 task들이 전부 처리되지
// 못한 채 continuous 세션이 그 자리에서 멈춘다 — 이는 실제 production 설계와 동일한
// 의도된 동작이다: genuine Human Gate는 이후 무관한 task를 건너뛰고 진행하지 않는다.
// 그래서 대량 통계 검증(Run A)과 "영구 정체" 검증(Run C/D)을 의도적으로 분리한다).
// ---------------------------------------------------------------------------
type TaskProfile = "clean" | "revise-once" | "transient-reviewer-failure" | "crash-during-developer" | "secret-attempt-then-fix";

// Positive-Provenance-Only Auto-Delete Policy(2026-08-31) — "scope-violation-then-fix"
// 프로파일은 이 목록에서 제거됐다(예전 weight 0.08). 이 프로파일의 "fix"는 실제로는 Developer
// 자신의 행동이 아니라, attempt 1이 만든 out-of-scope leftover(outside-scope-N.txt)를 예전
// autodev.ts Phase 7 자동 삭제가 다음 attempt 전에 지워줬기 때문에 성립했다 — 실제 조사 결과
// AutoDev는 이 파일을 자신이 만들었다고 증명할 방법이 없다는 것이 확인돼(§ task-change-baseline.ts
// 상단 주석) 그 자동 삭제 자체를 제거했다. Developer(LLM ACTION_REQUEST)에는 파일 삭제
// action이 아예 없으므로(§ safe-executor.ts ExecutorAction) 이 leftover는 이제 진짜로 "다음
// attempt가 스스로 fix"할 방법이 없다 — 즉 이 프로파일은 더 이상 "결국 완료 가능"한 프로파일이
// 아니라 "genuine하지는 않지만 사람이 직접 처리해야 끝나는" 프로파일이 됐다. Run A(대량,
// "전부 결국 완료 가능"이 불변식)에서 빼고, 그 새 기대 동작(사람 개입 없이는 절대 완료되지
// 않지만 무한 루프도 아니고 억지 commit도 없음)은 § Run F(runScopeViolationNeverAutoResolvesCheck)
// 에서 단일 task로 직접 검증한다.
const BULK_TASK_COUNT = Number(process.env.AUTODEV_SIMULATION_BULK_TASKS ?? 400);
const PROFILE_WEIGHTS: { profile: TaskProfile; weight: number }[] = [
  { profile: "clean", weight: 0.62 },
  { profile: "revise-once", weight: 0.15 },
  { profile: "transient-reviewer-failure", weight: 0.08 },
  { profile: "crash-during-developer", weight: 0.05 },
  { profile: "secret-attempt-then-fix", weight: 0.02 },
];

function pickProfile(): TaskProfile {
  const total = PROFILE_WEIGHTS.reduce((s, p) => s + p.weight, 0);
  let r = rand() * total;
  for (const p of PROFILE_WEIGHTS) {
    if (r < p.weight) return p.profile;
    r -= p.weight;
  }
  return "clean";
}

function buildBulkRegistry(count: number): { registry: TaskDefinition[]; profiles: Map<string, TaskProfile> } {
  const registry: TaskDefinition[] = [];
  const profiles = new Map<string, TaskProfile>();
  for (let i = 1; i <= count; i++) {
    const id = `B${i}`;
    const profile = pickProfile();
    profiles.set(id, profile);
    registry.push({
      id,
      phase: 1,
      taskNumber: i,
      title: `Simulated task ${i} (${profile})`,
      prompt: `Bulk simulation task ${i}`,
      requiredTests: [{ name: `sim:task-${i}`, command: "node", args: ["tests/run.js", String(i)], cwd: "root" }],
      allowedPathPrefixes: ["src/", "tests/"],
      prohibitedOperations: [],
    });
  }
  return { registry, profiles };
}

function writeRunnerScript(root: string): void {
  // 모든 bulk task가 공유하는 required-test 실행기 — argv[2]에 해당하는 marker 파일
  // (src/marker-<n>.txt)이 "OK"를 담고 있으면 exit 0, 아니면 exit 1. 실제 프로젝트의
  // required test를 흉내낸다(Safe Executor로 직접 spawn되어 실제 exitCode로 검증됨).
  writeSimFile(
    root,
    "tests/run.js",
    [
      "const fs = require('fs');",
      "const n = process.argv[2];",
      "const path = `src/marker-${n}.txt`;",
      "let ok = false;",
      "try { ok = fs.readFileSync(path, 'utf-8').includes('OK'); } catch {}",
      "process.exit(ok ? 0 : 1);",
    ].join("\n") + "\n"
  );
}

function makeBulkClaudeRunner(
  root: string,
  profiles: Map<string, TaskProfile>,
  attemptCounters: Map<string, number>,
  crashCounters: Map<string, number>
): (task: string, attempt: number) => Promise<ClaudeResult> {
  return async (task: string): Promise<ClaudeResult> => {
    const idMatch = /task (\d+)/.exec(task);
    const n = idMatch ? idMatch[1] : "0";
    const id = `B${n}`;
    const profile = profiles.get(id) ?? "clean";
    const attemptNo = (attemptCounters.get(id) ?? 0) + 1;
    attemptCounters.set(id, attemptNo);

    if (profile === "crash-during-developer") {
      const crashesSoFar = crashCounters.get(id) ?? 0;
      // 최대 2회까지만 "프로세스가 죽은 것처럼" throw한다 — 그 뒤에는 정상 성공한다(§
      // "runner crash" 후 crash-safe checkpoint resume이 결국 진행되는지 검증).
      if (crashesSoFar < 2) {
        crashCounters.set(id, crashesSoFar + 1);
        throw new Error(`SIMULATED_PROCESS_CRASH(taskId=${id}, attempt=${attemptNo})`);
      }
    }

    if (profile === "secret-attempt-then-fix") {
      if (attemptNo === 1) {
        // SECRET_NAME_PATTERNS(safe-executor.ts)에 매칭되는 파일명 — checkpoint의
        // Deterministic Secret Scanner Gate가 commit 자체를 BLOCK해야 한다. 이 attempt는
        // required test도 실패로 둔다(정상 required test가 통과해도 secret 파일이
        // 남아있으면 checkpoint가 막아야 하므로, 이 시나리오는 "막힌 뒤 재시도로 스스로
        // 제거"까지 함께 본다).
        writeSimFile(root, `src/my-api-key-${n}.ts`, "export const leaked = 'should-be-blocked';\n");
        writeSimFile(root, `src/marker-${n}.txt`, "NOT_OK\n");
        return {
          success: true,
          summary: "테스트: 실수로 secret 이름 패턴 파일 작성",
          changedFiles: [`src/my-api-key-${n}.ts`, `src/marker-${n}.txt`],
          tests: [{ name: `sim:task-${n}`, pass: false }],
          rawOutput: "",
        };
      }
      // 재시도 — secret 파일 제거, 정상 완료.
      writeSimFile(root, `src/marker-${n}.txt`, "OK\n");
      return {
        success: true,
        summary: "secret 파일 제거 후 정상 완료",
        changedFiles: [`src/marker-${n}.txt`],
        tests: [{ name: `sim:task-${n}`, pass: true }],
        rawOutput: "",
      };
    }

    if (profile === "revise-once" && attemptNo === 1) {
      // required test는 통과하지만 reviewer가 REVISE를 요구할 내용(예: 문서화 누락)을
      // 흉내낸다 — marker는 이미 OK이므로 required test 자체는 통과.
      writeSimFile(root, `src/marker-${n}.txt`, "OK\n");
      return {
        success: true,
        summary: "1차 구현(문서화 누락)",
        changedFiles: [`src/marker-${n}.txt`],
        tests: [{ name: `sim:task-${n}`, pass: true }],
        rawOutput: "",
      };
    }

    // clean / transient-reviewer-failure / 위 프로파일들의 이후 attempt — 정상 완료.
    writeSimFile(root, `src/marker-${n}.txt`, "OK\n");
    return {
      success: true,
      summary: `task ${n} 정상 완료(attempt ${attemptNo})`,
      changedFiles: [`src/marker-${n}.txt`],
      tests: [{ name: `sim:task-${n}`, pass: true }],
      rawOutput: "",
    };
  };
}

function makeBulkGptReviewer(
  profiles: Map<string, TaskProfile>,
  reviewAttemptCounters: Map<string, number>
): (result: ClaudeResult, reviewCycle: number, task: string) => Promise<GptReviewerReturn> {
  return async (result: ClaudeResult, _reviewCycle: number, task: string): Promise<GptReviewerReturn> => {
    const idMatch = /task (\d+)/.exec(task);
    const n = idMatch ? idMatch[1] : "0";
    const id = `B${n}`;
    const profile = profiles.get(id) ?? "clean";
    const reviewAttemptNo = (reviewAttemptCounters.get(id) ?? 0) + 1;
    reviewAttemptCounters.set(id, reviewAttemptNo);

    const hasOutOfScope = result.changedFiles.some((f) => !f.startsWith("src/") && !f.startsWith("tests/"));
    if (hasOutOfScope) {
      // scope violation은 GPT decision과 무관하게 orchestrator/checkpoint가 자체적으로
      // 감지·BLOCK한다(§ 요구사항) — reviewer는 정상 PASS를 반환해도 무방하다(실제로
      // reviewer가 못 볼 수도 있는 경로를 검증하기 위해 일부러 PASS를 준다).
      return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "정상(하지만 scope 밖 파일이 있음 — checkpoint가 독립적으로 잡아야 함)", nextTask: null };
    }

    if (profile === "revise-once" && reviewAttemptNo === 1) {
      return { decision: "REVISE", severity: { critical: 0, high: 0, medium: 1 }, feedback: "문서화가 부족합니다 — 추가하세요.", nextTask: null };
    }
    if (profile === "transient-reviewer-failure" && reviewAttemptNo === 1) {
      return {
        decision: "REVISE",
        severity: { critical: 0, high: 0, medium: 0 },
        feedback: "",
        nextTask: null,
        errorCode: "GPT_REVIEW_TEMPORARILY_UNAVAILABLE",
        requestAttempted: true,
      };
    }
    return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "정상", nextTask: null };
  };
}

// AutoDev Core Maintenance(2026-08-30) — seed=7 재실행에서 이 값(원래 40)이 너무 타이트해
// FAIL로 나온 것을 발견했다: "crash-during-developer" 프로파일 하나만으로도 기대값이
// (BULK_TASK_COUNT × 0.05 × 2) ≈ 40에 이른다(각 task가 최대 2회 crash 후 정상 완료하도록
// 의도적으로 설계됨 — 이는 정상적인 bounded retry이지 결함이 아니다). 이 bound는 "무한
// 루프 방지" 그 자체가 아니라(그건 Run B/C가 각 task 단위로 직접 검증한다) 이 시뮬레이션
// 전체가 비정상적으로 영원히 재시작하지 않는지에 대한 거친 안전망일 뿐이므로, 기대값 대비
// 충분한 여유(약 3배)를 둔다 — 시드에 따라 우연히 FAIL하지 않도록.
const MAX_SIMULATED_SUPERVISOR_RESTARTS = Math.max(150, BULK_TASK_COUNT);

async function runBulkSimulation(): Promise<void> {
  const root = makeSimRepo("autodev-sim-bulk-");
  writeRunnerScript(root);
  const { registry, profiles } = buildBulkRegistry(BULK_TASK_COUNT);
  const statePath = makeSimStatePath(root);
  const manifest = buildSimManifest(root, statePath, registry, "autodev-simulation-bulk");

  const attemptCounters = new Map<string, number>();
  const crashCounters = new Map<string, number>();
  const reviewAttemptCounters = new Map<string, number>();
  const claudeRunner = makeBulkClaudeRunner(root, profiles, attemptCounters, crashCounters);
  const gptReviewer = makeBulkGptReviewer(profiles, reviewAttemptCounters);

  let restarts = 0;
  let finalStopKind = "";
  const commitCountSamples: number[] = [];
  try {
    while (restarts <= MAX_SIMULATED_SUPERVISOR_RESTARTS) {
      try {
        const result = await runAutodevContinuous({
          manifest,
          orchestratorDeps: { claudeRunner, gptReviewer, now: fakeNow, sleep: fakeSleep },
        });
        finalStopKind = result.stop.kind;
        commitCountSamples.push(gitLogSubjects(root).length);
        const state = readState(statePath);
        if (state.completedTasks.length >= BULK_TASK_COUNT) break;
        if (result.stop.kind === "OUTCOME_STOP" && (result.stop as { outcome?: string }).outcome === "WAITING_HUMAN") {
          // genuine WAITING_HUMAN — bulk registry는 전부 "결국 해결 가능"한 프로파일만
          // 쓰므로 여기 도달하면 결함이다(아래 invariant 체크가 이를 FAIL로 잡는다).
          break;
        }
        // 그 외(예: TECHNICAL_RECOVERY_LIMIT_REACHED) — supervisor 재시작을 흉내낸다.
        restarts += 1;
      } catch (e) {
        // claudeRunner의 SIMULATED_PROCESS_CRASH — 실제 프로세스가 죽은 것과 동일하게
        // 취급하고, supervisor가 재시작하듯 runAutodevContinuous를 다시 호출한다.
        restarts += 1;
        if (!(e instanceof Error) || !e.message.startsWith("SIMULATED_PROCESS_CRASH")) {
          throw e; // 시뮬레이션이 만들지 않은 예외는 그대로 실패시킨다.
        }
      }
    }
  } finally {
    // no explicit cleanup needed mid-way; final cleanup happens in main().
  }

  const finalState = readState(statePath);
  check(`Run A) bulk task ${BULK_TASK_COUNT}개 전부 완료됨(completedTasks.length===${BULK_TASK_COUNT})`, finalState.completedTasks.length === BULK_TASK_COUNT);
  check("Run A) completedTasks에 중복 id 없음", new Set(finalState.completedTasks).size === finalState.completedTasks.length);
  check(`Run A) simulated supervisor restart가 bound 안에서 끝남(restarts=${restarts} <= ${MAX_SIMULATED_SUPERVISOR_RESTARTS})`, restarts <= MAX_SIMULATED_SUPERVISOR_RESTARTS);
  check("Run A) genuine WAITING_HUMAN에 도달하지 않음(모든 프로파일이 기술적으로 해결 가능해야 함)", finalState.status !== "WAITING_HUMAN" || classifyWaitingHumanReason(finalState) !== "GENUINE_HUMAN_JUDGMENT");

  const subjects = gitLogSubjects(root);
  const productSubjects = subjects.filter((s) => s.startsWith("feat: implement Phase"));
  const subjectCounts = new Map<string, number>();
  for (const s of productSubjects) subjectCounts.set(s, (subjectCounts.get(s) ?? 0) + 1);
  const duplicateSubjects = [...subjectCounts.entries()].filter(([, c]) => c > 1);
  check(`Run A) duplicate product commit = 0 (검사한 product commit ${productSubjects.length}건)`, duplicateSubjects.length === 0);
  check(`Run A) product commit 수가 완료된 task 수와 정확히 일치(${productSubjects.length} === ${finalState.completedTasks.length})`, productSubjects.length === finalState.completedTasks.length);

  // secret leak = 0 — 어떤 commit message/파일 목록에도 secret-attempt task가 작성한
  // my-api-key-*.ts가 실제로 commit되지 않았어야 한다(1차 attempt는 secret scanner가
  // BLOCK, 재시도에서 제거 후 정상 commit).
  const trackedFiles = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf-8" }).stdout || "";
  check("Run A) secret leak = 0 (my-api-key-*.ts가 git tracked 파일에 없음)", !/my-api-key-\d+\.ts/.test(trackedFiles));

  // git 파괴적 명령 없음 — commit 수가 매 샘플마다 단조 비감소였는지 확인(reset/rebase
  // 등으로 되돌아간 적이 없음).
  let monotonic = true;
  for (let i = 1; i < commitCountSamples.length; i++) {
    if (commitCountSamples[i] < commitCountSamples[i - 1]) monotonic = false;
  }
  check("Run A) commit 수가 항상 단조 비감소(destructive git operation 없음)", monotonic);

  // scope violation이 실제로 한 번이라도 committed되지 않았는지 확인.
  check("Run A) scope 밖 파일(outside-scope-*.txt)이 git tracked 파일에 없음", !/outside-scope-\d+\.txt/.test(trackedFiles));

  console.log(`Run A(bulk simulation, seed=${SEED}, tasks=${BULK_TASK_COUNT}) finalStopKind=${finalStopKind}, restarts=${restarts}`);
}

// ---------------------------------------------------------------------------
// Run B — 결정론적으로 항상 동일하게 실패하는 required test(§ 이미 autodev-tests.ts에
// 전용 테스트가 있으므로 여기서는 "대량 시뮬레이션 문맥에서도 동일하게 bounded하게
// 끝나는지"만 가볍게 재확인한다 — 반복 검증이 아니라 통합 확인).
// ---------------------------------------------------------------------------
async function runDeterministicBlockerIsolation(): Promise<void> {
  const root = makeSimRepo("autodev-sim-blocker-");
  const registry: TaskDefinition[] = [
    {
      id: "D1",
      phase: 1,
      taskNumber: 1,
      title: "Deterministic blocker",
      prompt: "Deterministic blocker task",
      // Hardening A(Execution Contract를 Runtime 불변조건으로) — node -e는 Core Command
      // Safety Gate가 항상 거부하는 eval 플래그다(이 fixture가 실제 명령을 spawn하지 않고
      // claudeRunner가 tests 결과를 직접 합성하므로 이전에는 이 무효함이 드러나지 않았다).
      // SIM_EXECUTION_POLICY.allowedCommands가 이미 허용하는 형태로 맞춘다.
      requiredTests: [{ name: "sim:always-fails", command: "node", args: ["tests/run.js"], cwd: "root" }],
      allowedPathPrefixes: ["src/"],
      prohibitedOperations: [],
    },
  ];
  const statePath = makeSimStatePath(root);
  const manifest = buildSimManifest(root, statePath, registry, "autodev-simulation-blocker");

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return { success: true, summary: "항상 동일하게 실패", changedFiles: [], tests: [{ name: "sim:always-fails", pass: false }], rawOutput: "" };
  };
  const gptReviewer = async (): Promise<GptReviewerReturn> => ({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "정상", nextTask: null });

  await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer, now: fakeNow, sleep: fakeSleep } });
  const finalState = readState(statePath);

  // P0-4/P1-2 하드닝(2026-08-30, 독립 감사) — "test failure/deterministic blocker"는
  // 아무리 반복돼도 genuine Human Gate가 아니다(§ CLAUDE.md P0-4). 이전 정책(감사 이전)은
  // 이 정확한 시나리오를 genuine WAITING_HUMAN으로 승격했었다 — 이 Run B가 실제로 그
  // 오분류를 재현해 독립 감사에서 확인됐다. 이제는 항상 기술적 durable wait-then-retry로
  // bounded하게 처리되다가(§ MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT) terminal 기술적
  // BLOCKED로 수렴한다.
  check("Run B) 결정론적 blocker: genuine WAITING_HUMAN으로 승격되지 않음(Human Gate 0)", (finalState.status as unknown as string) !== "WAITING_HUMAN");
  check("Run B) 결정론적 blocker: terminal 상태는 기술적 BLOCKED", (finalState.status as unknown as string) === "BLOCKED");
  check("Run B) 결정론적 blocker: classifyWaitingHumanReason≠GENUINE_HUMAN_JUDGMENT", classifyWaitingHumanReason(finalState) !== "GENUINE_HUMAN_JUDGMENT");
  check("Run B) 결정론적 blocker: task가 completedTasks에 없음(자동 승인 아님)", !finalState.completedTasks.includes("D1"));
  check(
    `Run B) 결정론적 blocker: Developer 호출이 bounded되고 무한 반복이 아님(claudeCalls=${claudeCalls} <= 30, MAX_REVIEW_CYCLES×(MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT+1) 근방)`,
    claudeCalls <= 30
  );
}

// ---------------------------------------------------------------------------
// Run C — 매 attempt마다 프로세스 자체가 죽는(claudeRunner가 항상 throw) 영구 crash-loop.
// 이것이 이번 하드닝에서 가장 중요하게 검증해야 할 시나리오다: mid-flight 프로세스 크래시
// 재시작에 상한이 있는지(§ autodev.ts MID_FLIGHT_ORCHESTRATOR_STATUSES 재조정 경로).
// ---------------------------------------------------------------------------
const MAX_CRASH_LOOP_RESTARTS = 20;

async function runPermanentCrashLoopIsolation(): Promise<{ terminal: boolean; restarts: number; finalState: CoreState }> {
  const root = makeSimRepo("autodev-sim-crashloop-");
  const registry: TaskDefinition[] = [
    {
      id: "C1",
      phase: 1,
      taskNumber: 1,
      title: "Permanent crash loop",
      prompt: "Permanent crash loop task",
      // Hardening A — § sim:always-fails와 동일한 이유(node -e는 항상 무효).
      requiredTests: [{ name: "sim:never-reached", command: "node", args: ["tests/run.js"], cwd: "root" }],
      allowedPathPrefixes: ["src/"],
      prohibitedOperations: [],
    },
  ];
  const statePath = makeSimStatePath(root);
  const manifest = buildSimManifest(root, statePath, registry, "autodev-simulation-crashloop");
  const claudeRunner = async (): Promise<ClaudeResult> => {
    throw new Error("SIMULATED_PROCESS_CRASH(taskId=C1, permanent)");
  };
  const gptReviewer = async (): Promise<GptReviewerReturn> => ({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "호출되면 안 됨", nextTask: null });

  let restarts = 0;
  let terminal = false;
  while (restarts < MAX_CRASH_LOOP_RESTARTS && !terminal) {
    try {
      await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer, now: fakeNow, sleep: fakeSleep } });
      // claudeRunner가 항상 throw하므로 정상 반환되면 예상 밖이다 — 그래도 상태로 판정한다.
    } catch (e) {
      if (!(e instanceof Error) || !e.message.startsWith("SIMULATED_PROCESS_CRASH")) throw e;
    }
    restarts += 1;
    const state = readState(statePath);
    // AutoDev Core Maintenance(2026-08-30) — 상한 초과 시 이제 WAITING_HUMAN이 아니라
    // BLOCKED(기술적 안전정지, Human Gate 아님)로 전환된다(§ autodev.ts
    // MID_FLIGHT_CRASH_LOOP_DETECTED).
    if ((state.status as unknown as string) === "BLOCKED" || state.completedTasks.includes("C1")) {
      terminal = true;
    }
  }
  return { terminal, restarts, finalState: readState(statePath) };
}

// ---------------------------------------------------------------------------
// Run D — lock contention: 동일 project를 향한 두 번째 acquire는 반드시 막혀야 한다(§
// project-lock.ts 자체 단위 테스트는 이미 충분히 있으므로, 여기서는 "이 시뮬레이션이
// 실제로 project-lock.ts를 우회하지 않고 그대로 통과시키는지"만 가볍게 통합 확인한다).
// ---------------------------------------------------------------------------
function runLockContentionCheck(): void {
  const root = makeSimRepo("autodev-sim-lock-");
  const first = acquireProjectLock({ projectId: "autodev-simulation-lock", targetProjectRoot: root, ownerKind: "autodev" });
  check("Run D) 첫 acquire 성공", first.ok === true);
  if (!first.ok) return;
  // 같은 프로세스(같은 pid)가 다시 acquire를 시도하면 project-lock.ts는 이를 "재진입"(§
  // acquireProjectLock 문서 — 이전 호출이 WAITING_HUMAN 등으로 lock을 kept한 뒤 같은
  // 프로세스가 순차적으로 다시 시도하는 경우)으로 간주해 안전하게 복구한다 — 이는 project-
  // lock.ts의 의도된 설계이지 결함이 아니다. "다른 프로세스(다른 pid)"의 동시 접근을
  // 정확히 흉내내려면 project-lock-tests.ts의 기존 기법과 동일하게 testDeps.pid를 실제와
  // 다른 값으로 override해야 한다(project-lock.ts 자체의 concurrent-acquisition 로직은
  // project-lock-tests.ts/project-lock-integration-tests.ts가 이미 충분히 검증했으므로,
  // 여기서는 "이 시뮬레이션의 fixture 배선이 project-lock.ts를 올바르게 호출하는지"만
  // 가볍게 통합 확인한다).
  const second = acquireProjectLock(
    { projectId: "autodev-simulation-lock", targetProjectRoot: root, ownerKind: "autodev" },
    { pid: first.lock.metadata.pid + 1, assessLiveness: () => ({ verdict: "ALIVE" }) }
  );
  check("Run D) 다른 프로세스(pid)의 두 번째 acquire는 PROJECT_ALREADY_LOCKED로 차단됨(active writer > 1 = 0)", !second.ok && second.code === "PROJECT_ALREADY_LOCKED");
  const released = releaseProjectLock(first.lock);
  check("Run D) 최초 lock 정상 release", released.ok === true);
}

// ---------------------------------------------------------------------------
// Run E — stale technical WAITING_HUMAN 재조정: 이미 autodev-tests.ts에 전용 커버리지가
// 있으므로(§ "이미 COVERED로 증명된 개별 fault test를 반복하지 마라") 여기서는 대량
// 시뮬레이션과 같은 fixture 인프라 위에서 한 번만 통합 확인한다.
// ---------------------------------------------------------------------------
async function runStaleWaitingHumanReconciliationCheck(): Promise<void> {
  const root = makeSimRepo("autodev-sim-stale-");
  const registry: TaskDefinition[] = [
    {
      id: "E1",
      phase: 1,
      taskNumber: 1,
      title: "Stale technical WAITING_HUMAN",
      prompt: "Stale WAITING_HUMAN reconciliation task",
      // Hardening A — § sim:always-fails와 동일한 이유(node -e는 항상 무효).
      requiredTests: [{ name: "sim:e1", command: "node", args: ["tests/run.js"], cwd: "root" }],
      allowedPathPrefixes: ["src/"],
      prohibitedOperations: [],
    },
  ];
  const statePath = makeSimStatePath(root, {
    status: "WAITING_HUMAN",
    currentTask: "Stale WAITING_HUMAN reconciliation task",
    // STAGNATION_DETECTED_MARKER_PREFIX(failure-stagnation.ts)의 실제 값은
    // "STAGNATION_DETECTED("(여는 괄호 포함)이다 — 콜론이 아니다.
    deferredHumanTasks: ["STAGNATION_DETECTED(repeatCount=2)"],
  });
  const manifest = buildSimManifest(root, statePath, registry, "autodev-simulation-stale");
  const claudeRunner = async (): Promise<ClaudeResult> => {
    writeSimFile(root, "src/e1.txt", "OK\n");
    return { success: true, summary: "정상 완료", changedFiles: ["src/e1.txt"], tests: [{ name: "sim:e1", pass: true }], rawOutput: "" };
  };
  const gptReviewer = async (): Promise<GptReviewerReturn> => ({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "정상", nextTask: null });

  await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer, now: fakeNow, sleep: fakeSleep } });
  const finalState = readState(statePath);
  check("Run E) stale STAGNATION_DETECTED-only WAITING_HUMAN이 사람 승인 없이 자동 복구됨", finalState.completedTasks.includes("E1"));
}

// ---------------------------------------------------------------------------
// Run F — Positive-Provenance-Only Auto-Delete Policy(2026-08-31). Developer가 실수로
// allowedPathPrefixes 밖에 파일을 하나 만들면(attempt 1), 그 leftover는 이후 attempt에서도
// 지워지지 않는다(Developer에게 삭제 action이 없고, AutoDev도 자신이 만들었다고 증명할 방법이
// 없어 자동 삭제하지 않는다 — § task-change-baseline.ts/autodev.ts 상단 주석).
//
// No-Safe-Recovery-Action Gate(2026-08-31) — 처음에는 이 blocker가 continuous-runner.ts의
// technicalRecoveryCount 상한(50)까지 조용히 재시도될 수 있다는 것도 함께 확인됐다(§ 요구사항
// 조사) — Developer/Reviewer 재시도로는 이 blocker가 절대 스스로 풀리지 않는다는 것이 이미
// 구조적으로 확인된 상태에서, 그 50회까지 API를 낭비하는 것은 무의미하다. 그래서
// CHECKPOINT_SCOPE_VIOLATION은 이제 genuine으로 재분류됐다(§ human-gate-policy.ts) — 이 Run은
// 그 결과로 이 task가 (1) 재시도를 단 한 번도 하지 않고 즉시 멈추는지(무인화보다 안전을
// 우선), (2) 억지로 completedTasks에 들어가지 않는지, (3) leftover 파일이 끝까지 디스크에
// 남아있고 절대 commit되지 않는지를 직접 검증한다.
// ---------------------------------------------------------------------------
async function runScopeViolationNeverAutoResolvesCheck(): Promise<void> {
  const root = makeSimRepo("autodev-sim-scope-violation-");
  const registry: TaskDefinition[] = [
    {
      id: "F1",
      phase: 1,
      taskNumber: 1,
      title: "Scope violation leftover never auto-resolves",
      prompt: "Scope violation leftover simulation task",
      requiredTests: [{ name: "sim:f1", command: "node", args: ["tests/run.js"], cwd: "root" }],
      allowedPathPrefixes: ["src/"],
      prohibitedOperations: [],
    },
  ];
  const statePath = makeSimStatePath(root);
  const manifest = buildSimManifest(root, statePath, registry, "autodev-simulation-scope-violation");

  writeSimFile(
    root,
    "tests/run.js",
    ["const fs = require('fs');", "let ok = false;", "try { ok = fs.readFileSync('src/f1-marker.txt', 'utf-8').includes('OK'); } catch {}", "process.exit(ok ? 0 : 1);"].join(
      "\n"
    ) + "\n"
  );

  let attemptNo = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    attemptNo += 1;
    if (attemptNo === 1) {
      // allowedPathPrefixes(src/) 밖에 실수로 파일을 하나 만든다 — checkpoint가 scope
      // violation으로 BLOCK해야 한다.
      writeSimFile(root, "outside-scope-f1.txt", "should never be committed or deleted\n");
      writeSimFile(root, "src/f1-marker.txt", "OK\n");
      return {
        success: true,
        summary: "테스트: 실수로 scope 밖 파일도 함께 작성(F1)",
        changedFiles: ["outside-scope-f1.txt", "src/f1-marker.txt"],
        tests: [{ name: "sim:f1", pass: true }],
        rawOutput: "",
      };
    }
    // 이후 attempt들은 스스로는 정상 동작한다(같은 실수를 반복하지 않음) — Developer에게는
    // 파일 삭제 action이 없으므로 outside-scope-f1.txt는 건드릴 수 없다(정상 동작).
    writeSimFile(root, "src/f1-marker.txt", "OK\n");
    return { success: true, summary: `F1 attempt ${attemptNo} 정상 완료`, changedFiles: ["src/f1-marker.txt"], tests: [{ name: "sim:f1", pass: true }], rawOutput: "" };
  };
  const gptReviewer = async (result: ClaudeResult): Promise<GptReviewerReturn> => {
    const hasOutOfScope = result.changedFiles.some((f) => !f.startsWith("src/"));
    return {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      feedback: hasOutOfScope ? "정상(하지만 scope 밖 파일이 있음 — checkpoint가 독립적으로 잡아야 함)" : "정상",
      nextTask: null,
    };
  };

  const result = await runAutodevContinuous({
    manifest,
    orchestratorDeps: { claudeRunner, gptReviewer, now: fakeNow, sleep: fakeSleep },
  });
  const finalState = readState(statePath);

  check("Run F) 단 1회 iteration만 실행됨(재시도 없이 즉시 STOP)", result.iterations.length === 1);
  check("Run F) Developer가 정확히 1회만 호출됨(scope violation 발견 이후 재호출 없음)", attemptNo === 1);
  check(
    "Run F) stop.kind=OUTCOME_STOP(TECHNICAL_RECOVERY_LIMIT_REACHED로 50회를 소진하는 구조가 아님)",
    result.stop.kind === "OUTCOME_STOP"
  );
  check("Run F) F1이 completedTasks에 절대 들어가지 않음(억지 승인 없음)", !finalState.completedTasks.includes("F1"));
  check(
    "Run F) 최종 status=WAITING_HUMAN이고 GENUINE_HUMAN_JUDGMENT로 분류됨(No-Safe-Recovery-Action Gate)",
    (finalState.status as unknown as string) === "WAITING_HUMAN" && classifyWaitingHumanReason(finalState) === "GENUINE_HUMAN_JUDGMENT"
  );
  check("Run F) outside-scope-f1.txt가 끝까지 디스크에 그대로 남아있음(삭제되지 않음)", existsSync(join(root, "outside-scope-f1.txt")));
  const trackedFilesF = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf-8" }).stdout || "";
  check("Run F) outside-scope-f1.txt가 git tracked 파일에 절대 없음(commit되지 않음)", !trackedFilesF.includes("outside-scope-f1.txt"));
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log(`=== AutoDev 1.0 Deterministic Simulation (seed=${SEED}) ===`);
  try {
    await runBulkSimulation();
    await runDeterministicBlockerIsolation();

    const crashLoop = await runPermanentCrashLoopIsolation();
    check(
      `Run C) 영구 crash-loop: bounded restarts(${crashLoop.restarts} <= ${MAX_CRASH_LOOP_RESTARTS}) 안에 terminal 상태 도달(infinite retry/tight loop = 0)`,
      crashLoop.terminal
    );
    if (crashLoop.terminal) {
      // AutoDev Core Maintenance(2026-08-30) — 판단 결과 이 상태는 genuine Human Gate가
      // 아니라(run.ts가 실제 Telegram 승인 대기를 켜는 것은 정확히 status==="WAITING_HUMAN"
      // 문자열일 때뿐이다) 기술적 안전정지(BLOCKED)다 — Human approval 요구가 0이어야 한다.
      check(
        "Run C) 영구 crash-loop: terminal 상태가 기술적 BLOCKED(Human Gate 아님, 자동 승인 아님, task 미완료)",
        (crashLoop.finalState.status as unknown as string) === "BLOCKED" && !crashLoop.finalState.completedTasks.includes("C1")
      );
      check(
        "Run C) 영구 crash-loop: WAITING_HUMAN으로 승격되지 않음(Human approval 요구 0)",
        (crashLoop.finalState.status as unknown as string) !== "WAITING_HUMAN"
      );
    } else {
      results.push(
        `[FAIL] Run C) ROOT CAUSE: mid-flight 프로세스 크래시 재시작에 상한이 없음(autodev.ts MID_FLIGHT_ORCHESTRATOR_STATUSES 재조정 경로, unexpectedExitCount가 기록만 되고 cap이 없음) — seed=${SEED}로 재현 가능, restarts=${crashLoop.restarts}에도 status=${crashLoop.finalState.status}로 계속 mid-flight`
      );
    }

    runLockContentionCheck();
    await runStaleWaitingHumanReconciliationCheck();
    await runScopeViolationNeverAutoResolvesCheck();
  } finally {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  }

  console.log("\n=== Deterministic Simulation 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  console.log(`SEED=${SEED} (재현하려면 AUTODEV_SIMULATION_SEED=${SEED} npm run simulation)`);
  if (passCount !== results.length) process.exitCode = 1;
}

if (require.main === module) {
  main();
}
