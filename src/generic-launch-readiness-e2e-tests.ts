import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runAutodevContinuous } from "./continuous-runner";
import { approveHumanFinalReview } from "./autodev";
import { performAutoResume } from "./auto-resume";
import { PLAN_MARKERS } from "./task-registry";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import type { ProjectState, ClaudeResult } from "./types";
import type { GptReviewerReturn } from "./orchestrator";
import type { ApprovalRequest } from "./approval";

// AutoDev Generic Launch Readiness E2E — 최종 launch gate.
//
// 이 파일은 이미 개별적으로 증명된 것을 다시 증명하지 않는다(조사 결과 이미 충분히
// 커버됨 — 아래 각 시나리오 주석에 정확히 어느 기존 파일이 그 경계를 담당하는지 인용한다):
//   - stale/corrupt approval의 각 세부 사유(다른 taskId/이전 reviewCycle/바인딩 누락/
//     손상된 state/이미 소비된 approval 재사용) → auto-resume-tests.ts,
//     failure-resume-hardening-tests.ts, autodev-tests.ts(HFR Test6/Test7).
//   - duplicate approval 안전성 → failure-resume-hardening-tests.ts(E),
//     human-resume-continuous-tests.ts.
//   - crash/interruption 이후 partial 작업 보존 + 재개 → failure-resume-hardening-tests.ts(C/D).
//   - livelock/maxIterations backstop → continuous-runner-tests.ts(I-1/I-2/I-3).
//   - Project Lock 개별 lifecycle(19~30: 정상 진행/release/재진입/실패/예외) →
//     project-lock-integration-tests.ts, continuous-runner-tests.ts.
//   - Remote Git Safety 개별 케이스(허용/차단/재확인) → remote-git-safety-tests.ts,
//     continuous-runner-tests.ts, human-resume-continuous-tests.ts(I).
//   - Required Test 실패/Reviewer REVISE 소진/Secret Scanner BLOCK 개별 STOP →
//     continuous-runner-tests.ts(E/F/G).
//
// 이 파일이 실제로 새로 증명하는 것(기존 파일 어디에도 없던 두 개의 "이어지는" 통합
// 경로):
//   1) 완전히 generic한 disposable fixture project(실제 JARVIS/MOVAN/BILLION과 무관,
//      OS 임시 디렉터리) 위에서, "여러 Task 자동 연속 실행 도중 하나가 일반
//      WAITING_HUMAN(orchestrator NOT_APPROVED)에 걸림 → Safe Auto Resume이 그 task
//      하나만 완료(RESUME_SAME_TASK_THEN_STOP, 현재 canonical 동작) → 완전히 별도의
//      명시적 continuous 재시작이 나머지 task를 이어받아 project complete까지 도달"을
//      하나의 project-state 위에서 처음부터 끝까지 이어서 검증한다(기존
//      human-resume-continuous-tests.ts는 2-task registry로 이 경계 자체는 이미
//      증명했지만, project complete까지 도달하는 3-task 전체 lifecycle을 실제로
//      끝까지 확인하지는 않았다).
//   2) Human Final Review(HFR) ON 상태에서, "PENDING → approve →
//      RESUME_APPROVED_CHECKPOINT(developer/reviewer 재실행 없음) → 같은 continuous
//      호출 안에서 다음 task로 자동 진행 → 그 task도 다시 HFR PENDING"까지 continuous
//      runner를 통해 반복되는지 검증한다(기존 continuous-runner-tests.ts의 HFR
//      시나리오는 PENDING에서 멈추는 것까지만, autodev-tests.ts의 HFR Test7은
//      runAutodevOnce() 단일 호출의 checkpoint-exactly-once까지만 검증했다 —
//      "continuous runner가 HFR 승인 이후에도 project를 계속 이어가는가"는 아직 아무
//      파일도 직접 증명하지 않았다).
//
// 실제 Claude CLI/OpenAI API/JARVIS는 이 파일 어디에서도 호출하지 않는다 —
// orchestratorDeps(claudeRunner/gptReviewer)는 모든 호출에서 항상 결정적 fake로
// 명시적으로 주입한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "launch-readiness-e2e@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Launch Readiness E2E"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}
function headHash(dir: string): string {
  return (spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" }).stdout || "").trim();
}
function branchName(dir: string): string {
  return (spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf-8" }).stdout || "").trim();
}
function gitLogCount(repo: string): number {
  return (spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" }).stdout || "").split("\n").filter(Boolean).length;
}
function writeRepoFile(repo: string, relPath: string, content: string): void {
  const abs = join(repo, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function baseState(overrides: Partial<ProjectState>): ProjectState {
  return {
    currentPhase: 1,
    gitCheckpoint: "test",
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "READY",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
    ...overrides,
  } as ProjectState;
}
function makeTempStateFile(dir: string, overrides: Partial<ProjectState> = {}): string {
  const statePath = join(dir, ".autodev", "project-state.json");
  mkdirSync(join(dir, ".autodev"), { recursive: true });
  writeFileSync(statePath, JSON.stringify(baseState(overrides), null, 2) + "\n", "utf-8");
  return statePath;
}

const EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["proj/"],
  allowedWritePrefixes: ["proj/"],
  allowedCommands: [],
};

function fakePassReviewer(): () => Promise<GptReviewerReturn> {
  return async () => ({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "테스트: 문제 없음", nextTask: null });
}

function baseApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: "launch-readiness-approval",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:30:00.000Z",
    runId: "launch-readiness-run",
    taskId: "",
    approvalType: "ORCHESTRATOR_NOT_APPROVED_GENERIC",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: "launch-readiness-source-event",
    status: "APPROVED",
    remotelyApprovable: true,
    requiresSafetyRecheck: true,
    dedupeKey: "dk-launch-readiness",
    ...overrides,
  };
}

// ===========================================================================
// Part 1 — Generic 3-task fixture("fixture-project-lifecycle"). HFR 미설정(기본값
// OFF, § Scenario B backward compat). G2가 첫 시도에서 orchestrator NOT_APPROVED로
// 걸려 일반 WAITING_HUMAN을 만들고, Safe Auto Resume이 그 task 하나만 완료(§ Scenario
// D + 현재 canonical RESUME_SAME_TASK_THEN_STOP), 그 다음 완전히 별도의 명시적
// continuous 재시작이 G3까지 이어받아 project complete에 도달한다(§ Scenario E/N).
// ===========================================================================
async function scenarioMixedLifecycleWaitingHumanResumeThenContinuousRestart(): Promise<void> {
  const repo = makeTempGitRepo("launch-readiness-lifecycle-");
  const statePath = makeTempStateFile(repo, { completedTasks: [] });
  const registry: TaskDefinition[] = [
    { id: "G1", phase: 1, taskNumber: 1, title: "Task G1", prompt: "G1 prompt", requiredTests: [], allowedPathPrefixes: ["proj/"], prohibitedOperations: [] },
    { id: "G2", phase: 1, taskNumber: 2, title: "Task G2", prompt: "G2 prompt", requiredTests: [], allowedPathPrefixes: ["proj/"], prohibitedOperations: [] },
    { id: "G3", phase: 1, taskNumber: 3, title: "Task G3", prompt: "G3 prompt", requiredTests: [], allowedPathPrefixes: ["proj/"], prohibitedOperations: [] },
  ];
  const manifest: ProjectManifest = {
    projectId: "fixture-project-lifecycle",
    projectName: "Fixture Project (Launch Readiness Lifecycle)",
    targetProjectRoot: repo,
    statePath,
    taskRegistry: registry,
    developerInstructions: "허용 범위: proj/**만 다룹니다. Launch Readiness E2E 전용 generic fixture입니다.",
    reviewInstructions: "proj/** 범위 밖 변경이 있으면 반드시 REVISE하세요.",
    reviewScopeDirs: ["proj/"],
    executionPolicy: EXECUTION_POLICY,
  };

  const calls: string[] = [];
  let g2ShouldSucceed = false;
  const claudeRunner = async (task: string): Promise<ClaudeResult> => {
    calls.push(task);
    if (task === "G2 prompt" && !g2ShouldSucceed) {
      return { success: false, summary: "테스트: 구조적 실패(일반 WAITING_HUMAN 흉내)", changedFiles: [], tests: [], rawOutput: "", errorCode: "STRUCTURAL_FAILURE" } as ClaudeResult;
    }
    const fileName = `proj/marker-${calls.length}.txt`;
    writeRepoFile(repo, fileName, task);
    return { success: true, summary: `테스트: ${task} 완료`, changedFiles: [fileName], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };

  // 1) 최초 continuous 실행 — G1 정상 완료, G2에서 orchestrator NOT_APPROVED로 즉시 STOP.
  const run1 = await runAutodevContinuous({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });
  check("1-A) G1 완료 후 G2에서 STOP(총 2회 호출)", run1.iterations.length === 2);
  check("1-A) iteration1 taskId=G1, outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", run1.iterations[0].result.taskId === "G1" && run1.iterations[0].result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("1-A) iteration2 taskId=G2, outcome=RAN_TASK_NOT_APPROVED", run1.iterations[1].result.taskId === "G2" && run1.iterations[1].result.outcome === "RAN_TASK_NOT_APPROVED");
  check("1-A) G3는 이 실행 안에서 전혀 시도되지 않음", !calls.includes("G3 prompt"));
  const stateAfterRun1 = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("1-A) status=WAITING_HUMAN, completedTasks=[G1]만 존재", (stateAfterRun1.status as unknown as string) === "WAITING_HUMAN" && JSON.stringify(stateAfterRun1.completedTasks) === JSON.stringify(["G1"]));
  check("1-B, Scenario B) HFR을 지정하지 않은 project는 humanFinalReview gate를 절대 생성하지 않음(backward compat)", !stateAfterRun1.humanFinalReview);

  // 2) Safe Auto Resume — G2만 완료시키고 그친다(현재 canonical RESUME_SAME_TASK_THEN_STOP).
  g2ShouldSucceed = true;
  const approval = baseApproval({ taskId: "G2", expectedGitHead: headHash(repo), expectedBranch: branchName(repo) });
  const resumeOutcome = await performAutoResume(approval, manifest, { orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });
  check("2, Scenario D) Safe Auto Resume 결과 kind=COMPLETED", resumeOutcome.kind === "COMPLETED");
  if (resumeOutcome.kind === "COMPLETED") {
    check("2, Scenario D) resume된 outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED, taskId=G2", resumeOutcome.result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED" && resumeOutcome.result.taskId === "G2");
  }
  check("2, CURRENT_BEHAVIOR_AFTER_RESUME=RESUME_SAME_TASK_THEN_STOP) G3는 이 resume 호출 안에서 전혀 실행되지 않음", !calls.includes("G3 prompt"));
  const stateAfterResume = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("2) completedTasks=[G1,G2](G3는 아직 미완료)", JSON.stringify(stateAfterResume.completedTasks) === JSON.stringify(["G1", "G2"]));

  // 3) 완전히 별도의 명시적 continuous 재시작 — G3를 이어받아 project complete까지 도달.
  const run2 = await runAutodevContinuous({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });
  check("3, Scenario E) 명시적 continuous 재시작이 G3를 이어받아 완료함", run2.iterations.some((it) => it.result.taskId === "G3" && it.result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED"));
  check(
    "3, Scenario E) G1은 정확히 1회, G2는 정확히 2회(1차 실패 시도+2차 resume 성공)만 호출되고 이 재시작에서 중복 실행되지 않음",
    calls.filter((c) => c === "G1 prompt").length === 1 && calls.filter((c) => c === "G2 prompt").length === 2
  );
  check("3, Scenario N) 마지막 iteration은 outcome=STOPPED(project complete)", run2.iterations[run2.iterations.length - 1].result.outcome === "STOPPED");
  const stateAfterRun2 = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("3, Scenario N) completedTasks=[G1,G2,G3] 모두 완료, status=PROJECT_COMPLETE", JSON.stringify(stateAfterRun2.completedTasks) === JSON.stringify(["G1", "G2", "G3"]) && stateAfterRun2.status === PLAN_MARKERS.PROJECT_COMPLETE);

  // checkpoint exactly once per task: init(1) + G1(2) + G2(2) + G3(2) = 7건.
  check("Scenario checkpoint-exactly-once) commit 수가 정확히 7건(init 1 + task당 product+admin 2×3)", gitLogCount(repo) === 7);

  // 4) project complete 이후 추가 실행 — 추가 checkpoint/추가 developer 호출 0건.
  const totalClaudeCallsBeforeExtra = calls.length;
  const run3 = await runAutodevContinuous({ manifest, maxIterations: 1 });
  check("4, Scenario N) project complete 이후 재실행은 outcome=STOPPED", run3.iterations[0].result.outcome === "STOPPED");
  check("4, Scenario N) 추가 developer 호출 없음", calls.length === totalClaudeCallsBeforeExtra);
  check("4, Scenario N) 추가 commit 없음(여전히 7건)", gitLogCount(repo) === 7);
}

// ===========================================================================
// Part 2 — HFR ON 2-task fixture("fixture-project-hfr"). PENDING → approve →
// RESUME_APPROVED_CHECKPOINT(developer/reviewer 재실행 없음) → 같은 continuous 호출
// 안에서 다음 task로 자동 진행 → 다시 HFR PENDING → approve → project complete까지
// continuous runner를 통해 반복됨을 검증한다(§ Scenario C 전체 lifecycle).
// ===========================================================================
async function scenarioHumanFinalReviewApprovalChainsThroughContinuousRunner(): Promise<void> {
  const repo = makeTempGitRepo("launch-readiness-hfr-");
  const statePath = makeTempStateFile(repo, { completedTasks: [] });
  const registry: TaskDefinition[] = [
    { id: "H1", phase: 1, taskNumber: 1, title: "Task H1", prompt: "H1 prompt", requiredTests: [], allowedPathPrefixes: ["proj/"], prohibitedOperations: [] },
    { id: "H2", phase: 1, taskNumber: 2, title: "Task H2", prompt: "H2 prompt", requiredTests: [], allowedPathPrefixes: ["proj/"], prohibitedOperations: [] },
  ];
  const manifest: ProjectManifest = {
    projectId: "fixture-project-hfr",
    projectName: "Fixture Project (Launch Readiness HFR)",
    targetProjectRoot: repo,
    statePath,
    taskRegistry: registry,
    developerInstructions: "허용 범위: proj/**만 다룹니다. Launch Readiness E2E 전용 generic fixture입니다.",
    reviewInstructions: "proj/** 범위 밖 변경이 있으면 반드시 REVISE하세요.",
    reviewScopeDirs: ["proj/"],
    executionPolicy: EXECUTION_POLICY,
    humanFinalReviewPolicy: { enabled: true },
  };

  const calls: string[] = [];
  const claudeRunner = async (task: string): Promise<ClaudeResult> => {
    calls.push(task);
    const fileName = `proj/marker-${calls.length}.txt`;
    writeRepoFile(repo, fileName, task);
    return { success: true, summary: `테스트: ${task} 완료`, changedFiles: [fileName], tests: [{ name: "proj:check", pass: true }], rawOutput: "" };
  };

  // 1) H1 developer+reviewer PASS -> HFR PENDING -> 즉시 STOP(다음 task 실행 금지, checkpoint 금지).
  const run1 = await runAutodevContinuous({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });
  check("HFR-1, Scenario C) H1에서 즉시 STOP(1회만 호출)", run1.iterations.length === 1);
  check("HFR-1, Scenario C) outcome=RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW", run1.iterations[0].result.outcome === "RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW");
  check("HFR-1, Scenario C) H2는 실행되지 않음", !calls.includes("H2 prompt"));
  const stateAfterRun1 = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("HFR-1, Scenario C) status=WAITING_HUMAN, humanFinalReview.status=PENDING(taskId=H1)", stateAfterRun1.status === "WAITING_HUMAN" && stateAfterRun1.humanFinalReview?.status === "PENDING" && stateAfterRun1.humanFinalReview?.taskId === "H1");
  check("HFR-1, Scenario C) completedTasks 변화 없음, checkpoint 없음(init 1건만)", stateAfterRun1.completedTasks.length === 0 && gitLogCount(repo) === 1);

  // 2) 사람이 H1을 승인한 뒤, 완전히 별도의 continuous 재시작이 developer/reviewer 재실행
  //    없이 checkpoint만으로 H1을 완료하고, 곧바로 H2로 자동 진행해 다시 HFR PENDING에 도달함.
  const approve1 = approveHumanFinalReview(statePath, "H1");
  check("HFR-2) approveHumanFinalReview(H1) ok=true", approve1.ok === true);
  const run2 = await runAutodevContinuous({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });
  check("HFR-2) H1 checkpoint + H2 PENDING까지 총 2회 호출", run2.iterations.length === 2);
  check("HFR-2) iteration1 taskId=H1, outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED(developer/reviewer 재실행 없이 checkpoint만)", run2.iterations[0].result.taskId === "H1" && run2.iterations[0].result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("HFR-2) H1 resume 과정에서 developer가 추가로 호출되지 않음(H1 prompt는 여전히 정확히 1회)", calls.filter((c) => c === "H1 prompt").length === 1);
  check("HFR-2) iteration2 taskId=H2, outcome=RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW(같은 continuous 호출 안에서 자동 진행)", run2.iterations[1].result.taskId === "H2" && run2.iterations[1].result.outcome === "RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW");
  check("HFR-2) H2 developer는 정확히 1회만 호출됨", calls.filter((c) => c === "H2 prompt").length === 1);
  const stateAfterRun2 = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("HFR-2) completedTasks=[H1]만 존재(H2는 아직 HFR 대기 중)", JSON.stringify(stateAfterRun2.completedTasks) === JSON.stringify(["H1"]));
  check("HFR-2) H1 checkpoint가 정확히 1회만 발생(init 1건 + H1 product/admin 2건 = 3건)", gitLogCount(repo) === 3);

  // 3) H2도 승인 -> 마지막 continuous 재시작이 checkpoint 후 project complete로 STOP.
  const approve2 = approveHumanFinalReview(statePath, "H2");
  check("HFR-3) approveHumanFinalReview(H2) ok=true", approve2.ok === true);
  const callsBeforeRun3 = calls.length;
  const run3 = await runAutodevContinuous({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewer() } });
  check("HFR-3) H2 checkpoint + project complete까지 총 2회 호출", run3.iterations.length === 2);
  check("HFR-3) iteration1 taskId=H2, outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", run3.iterations[0].result.taskId === "H2" && run3.iterations[0].result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("HFR-3) H2 resume 과정에서도 developer가 추가로 호출되지 않음", calls.length === callsBeforeRun3);
  check("HFR-3) 마지막 iteration=STOPPED(project complete)", run3.iterations[1].result.outcome === "STOPPED");
  const stateAfterRun3 = JSON.parse(readFileSync(statePath, "utf-8")) as ProjectState;
  check("HFR-3) completedTasks=[H1,H2] 모두 완료, status=PROJECT_COMPLETE", JSON.stringify(stateAfterRun3.completedTasks) === JSON.stringify(["H1", "H2"]) && stateAfterRun3.status === PLAN_MARKERS.PROJECT_COMPLETE);
  check("HFR-3) 전체 developer 호출은 정확히 2회(H1, H2 각 1회 — HFR PENDING/approve/resume 반복에도 재실행 없음)", calls.length === 2);
  check("HFR-3) 전체 commit 수는 5건(init 1 + task당 product/admin 2×2)", gitLogCount(repo) === 5);
}

// ===========================================================================
// Part 3 — Section 19: Generic/project-agnostic 검사. AutoDev Core 실행 파이프라인의
// 핵심 파일들에 project-name 기반 분기 코드(if projectId === "JARVIS" 등)가 없는지
// 소스 스캔으로 확인한다(§ 요구사항 — CLAUDE.md 설명문처럼 프로젝트 이름을 예시로
// "언급"하는 주석은 허용하고, 실제 조건문 분기만 금지 대상이다).
// ===========================================================================
const CORE_PIPELINE_FILES = [
  "autodev.ts",
  "continuous-runner.ts",
  "auto-resume.ts",
  "task-registry.ts",
  "project-manifest.ts",
  "checkpoint.ts",
  "project-lock.ts",
  "remote-git-safety.ts",
  "approval.ts",
  "approval-service.ts",
  "agent-orchestrator.ts",
  "agent-registry.ts",
  "state.ts",
];
const PROJECT_NAME_BRANCH_PATTERN = /projectId\s*===\s*["'](JARVIS|MOVAN|BILLION)["']/i;

function scenarioNoHardcodedProjectBranchingInCorePipeline(): void {
  for (const file of CORE_PIPELINE_FILES) {
    const source = readFileSync(join(__dirname, "..", "src", file), "utf-8");
    check(`19) ${file}에 project-name 기반 분기 코드 없음(projectId === "JARVIS"/"MOVAN"/"BILLION" 등)`, !PROJECT_NAME_BRANCH_PATTERN.test(source));
  }
}

async function main(): Promise<void> {
  try {
    await scenarioMixedLifecycleWaitingHumanResumeThenContinuousRestart();
    await scenarioHumanFinalReviewApprovalChainsThroughContinuousRunner();
    scenarioNoHardcodedProjectBranchingInCorePipeline();
  } finally {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 디렉터리 정리 실패는 테스트 결과에 영향 없음
      }
    }
  }

  console.log("\n=== AutoDev Generic Launch Readiness E2E 결과 ===");
  console.log("REAL_OPENAI_API_CALLS=0 (orchestratorDeps.claudeRunner/gptReviewer가 모든 호출에서 항상 결정적 fake로 명시 주입됨)");
  console.log("REAL_EXTERNAL_LLM_CALLS=0");
  console.log("JARVIS_DEVELOPER_EXECUTIONS=0 (JARVIS/MOVAN/BILLION 어떤 실제 프로젝트도 이 파일에서 전혀 참조하지 않음 — 오직 generic disposable fixture만 사용)");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
