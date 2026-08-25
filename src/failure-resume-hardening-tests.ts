import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runAutodevOnce } from "./autodev";
import { performAutoResume } from "./auto-resume";
import { loadState, saveState, DEFAULT_STATE_PATH } from "./state";
import { debugComputeLockFilePath, resolveCanonicalProjectPath, RUNTIME_LOCK_DIR } from "./project-lock";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";
import type { ClaudeResult, CoreState, ProjectState } from "./types";
import type { GptReviewerReturn } from "./orchestrator";
import type { ApprovalRequest } from "./approval";

// Phase G Task G7.4 — Failure / Resume Hardening.
//
// 이 파일은 기존 테스트(autodev-tests.ts/checkpoint-tests.ts/auto-resume-tests.ts/
// project-lock-integration-tests.ts/gpt-retry-tests.ts/claude-developer-tests.ts)가 이미
// 증명한 것을 중복 검증하지 않는다 — 조사 결과 이미 커버된 것: GPT transient 재시도(bounded)/
// 소진, Claude USAGE_LIMIT 중간 재시도, unexpected file → checkpoint BLOCK(단일 attempt),
// evaluateApproval의 필수 테스트 미통과 거부, Remote Git Safety 시작 전/도중 재확인, Project
// Lock corrupt/stale/재진입/예외 lifecycle. 이 파일은 그 위에서 아직 비어있던 두 층만 새로
// 채운다:
//   1) "process가 실제로 재시작됐다"를 흉내내는 완전히 분리된 두 번의 runAutodevOnce() 호출
//      사이에서 partial diff가 보존/이어짐(C)과 그 사이 무관한 변경이 섞이면 BLOCK(D)되는지 —
//      기존 테스트는 전부 단일 attempt(단일 claudeRunner 호출) 안에서만 시나리오를 구성했다.
//   2) project-state.json 자체가 손상된 경우(B)와, 이번 Task에서 saveState()를 원자적 쓰기로
//      바꾼 변경 자체의 회귀(G) — 기존 테스트에는 전혀 없었다.
//   3) 실제로 완료된 task에 대해 Telegram Auto Resume이 두 번째로 다시 호출되는 경우
//      claudeRunner/gptReviewer가 중복 실행되지 않는지(E) — 기존 테스트는 이미 completedTasks가
//      세팅된 상태로 단일 호출만 검증했다. 이 파일은 실제 두 번의 연속 호출로 직접 증명한다.
//
// 실제 Claude CLI/OpenAI API는 어디에서도 호출하지 않는다 — orchestratorDeps는 항상 결정적
// fake다. 모든 git/state 조작은 OS 임시 디렉터리 안에서만 일어난다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "autodev-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "AutoDev Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}
function gitLogCount(repo: string): number {
  const res = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" });
  return (res.stdout || "").split("\n").filter(Boolean).length;
}
function writeRepoFile(repo: string, relPath: string, content: string): void {
  const abs = join(repo, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

const SINGLE_TASK_REGISTRY: TaskDefinition[] = [
  {
    id: "RH1",
    phase: 1,
    taskNumber: 1,
    title: "Resume-Hardening fixture task",
    prompt: "proj/ 범위 안에서 partial.txt를 작성하세요.",
    requiredTests: [],
    allowedPathPrefixes: ["proj/"],
    prohibitedOperations: [],
  },
];
const EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["proj/"],
  allowedWritePrefixes: ["proj/"],
  allowedCommands: [],
};

function buildManifest(root: string, statePath: string): ProjectManifest {
  return {
    projectId: "failure-resume-fixture",
    projectName: "Failure Resume Fixture",
    targetProjectRoot: root,
    statePath,
    taskRegistry: SINGLE_TASK_REGISTRY,
    developerInstructions: "허용 범위: proj/**만 다룹니다.",
    reviewInstructions: "proj/** 범위 밖 변경이 있으면 반드시 REVISE하세요.",
    reviewScopeDirs: ["proj/"],
    executionPolicy: EXECUTION_POLICY,
  };
}

function makeStateFile(dir: string, overrides: Partial<ProjectState> = {}): string {
  const statePath = join(dir, ".autodev", "project-state.json");
  mkdirSync(join(dir, ".autodev"), { recursive: true });
  const state: ProjectState = {
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
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  return statePath;
}

function fakePassReviewer(): (result: ClaudeResult, reviewCycle: number, task: string) => Promise<GptReviewerReturn> {
  return async () => ({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "테스트: 문제 없음", nextTask: null });
}

function lockFilePathFor(root: string): string {
  return debugComputeLockFilePath(resolveCanonicalProjectPath(root), RUNTIME_LOCK_DIR);
}

// ---------------------------------------------------------------------------
// B) project-state.json 자체가 손상됨(malformed JSON) — loadState()가 던지는 예외가
//    삼켜지지 않고, git/lock 어느 쪽도 잘못된 방향으로 바뀌지 않는지 확인한다(§ 요구사항 8,
//    타당한 상태 전이만 허용 — "손상된 state를 정상으로 오인해 다음 task를 진행"하지 않음).
// ---------------------------------------------------------------------------
async function scenarioCorruptStateFileFailsClosed(): Promise<void> {
  const root = makeTempGitRepo("frh-corrupt-state-");
  const statePath = join(root, ".autodev", "project-state.json");
  mkdirSync(join(root, ".autodev"), { recursive: true });
  const corrupt = "{ this is not valid JSON at all ";
  writeFileSync(statePath, corrupt, "utf-8");
  const manifest = buildManifest(root, statePath);

  let claudeCalls = 0;
  let threw = false;
  try {
    await runAutodevOnce({
      manifest,
      orchestratorDeps: {
        claudeRunner: async (): Promise<ClaudeResult> => {
          claudeCalls += 1;
          return { success: true, summary: "호출되면 안 됨", changedFiles: [], tests: [], rawOutput: "" };
        },
      },
    });
  } catch {
    threw = true;
  }

  check("B) 손상된 project-state.json은 예외를 던지고(삼켜지지 않음) 실행이 중단됨", threw);
  check("B) state 손상 시 Claude worker가 전혀 호출되지 않음(잘못된 task 진행 없음)", claudeCalls === 0);
  check("B) 손상된 state.json 파일 내용이 그대로 보존됨(임의로 덮어쓰거나 복구 시도하지 않음)", readFileSync(statePath, "utf-8") === corrupt);
  check("B) git repo에 어떤 commit도 생성되지 않음(init 1건만)", gitLogCount(root) === 1);
  check("B) Project Lock이 release되지 않고 유지됨(fail-closed — 다른 writer가 이 위에서 시작 못 함)", existsSync(lockFilePathFor(root)));
}

// ---------------------------------------------------------------------------
// C) / D) "process 재시작"을 완전히 분리된 두 번의 runAutodevOnce() 호출로 흉내낸다.
//
// 1회차의 claudeRunner는 파일을 실제로 disk에 쓴 뒤 예외를 던진다(reject) — 이것이 진짜
// "process가 중간에 죽었다"에 해당하는 형태다: orchestrator.ts는 claudeRunner를 호출하기
// *직전*에 이미 state.status="CLAUDE_WORKING"을 저장해뒀고(§ orchestrator.ts saveCurrentState),
// claudeRunner가 정상적으로 ClaudeResult를 반환하지 못하고 그대로 죽으면(reject) 그 예외가
// runOrchestrator/runAutodevOnce를 그대로 뚫고 나가 프로세스가 죽는 것과 동일한 결과를 남긴다
// — 즉 statePath에 남는 마지막 status는 "WAITING_HUMAN"이 아니라 "CLAUDE_WORKING"이다.
// (claudeRunner가 success:false를 "정상적으로 반환"하는 것은 다른 시나리오다 — 그건 orchestrator가
// 스스로 WAITING_HUMAN을 "결정"한 것이라 Safe Auto Resume의 명시적 승인 절차를 거쳐야 재개할 수
// 있다 — auto-resume-tests.ts/project-lock-integration-tests.ts가 이미 그 경로를 검증한다. 여기서
// 검증하려는 것은 그것과 다른 경우, 즉 orchestrator가 어떤 결정도 내리지 못한 채 프로세스 자체가
// 죽는 경우다 — 이때는 사람의 승인 없이도 다음 실행이 안전하게 그대로 이어받아야 한다, §
// 요구사항 3/4 "불확실하면 fail-closed지만, 이미 확정된 WAITING_HUMAN이 아니라면 다시 실행했을 때
// 가능한 경우 정확히 이어서 진행한다").
// ---------------------------------------------------------------------------
async function scenarioRestartResumesWithPartialChangePreserved(): Promise<void> {
  const root = makeTempGitRepo("frh-restart-resume-");
  const statePath = makeStateFile(root, { status: "READY" });
  const manifest = buildManifest(root, statePath);

  // 1회차 — Claude가 파일을 실제로 쓴 뒤 process가 죽는다(claudeRunner가 reject).
  let firstThrew = false;
  try {
    await runAutodevOnce({
      manifest,
      orchestratorDeps: {
        claudeRunner: async (): Promise<ClaudeResult> => {
          writeRepoFile(root, "proj/partial.txt", "step1\n");
          throw new Error("테스트: partial write 직후 process 종료(crash 흉내)");
        },
      },
    });
  } catch {
    firstThrew = true;
  }

  check("C) 1회차: process crash가 삼켜지지 않고 그대로 전파됨", firstThrew);
  check("C) 1회차: 이미 써진 partial 파일이 working tree에 그대로 남음(삭제되지 않음)", existsSync(join(root, "proj", "partial.txt")));
  check("C) 1회차: partial 파일 내용이 정확히 step1", readFileSync(join(root, "proj", "partial.txt"), "utf-8") === "step1\n");
  const stateAfterFirst = loadState(statePath);
  check("C) 1회차: RH1이 completedTasks에 추가되지 않음(아직 미완료)", !stateAfterFirst.completedTasks.includes("RH1"));
  check(
    "C) 1회차: crash 시점의 마지막 저장된 status는 WAITING_HUMAN이 아니라 CLAUDE_WORKING(orchestrator가 스스로 WAITING_HUMAN을 결정한 것이 아님)",
    (stateAfterFirst.status as unknown as string) === "CLAUDE_WORKING"
  );
  check("C) 1회차: 커밋이 생성되지 않음(init 1건만)", gitLogCount(root) === 1);
  check(
    "C) 1회차: 미완료 상태이므로 Project Lock을 유지함(다음 writer가 이 위에서 계속 이어가도록)",
    existsSync(lockFilePathFor(root))
  );

  // 2회차 — 같은 statePath/repo로 다시 실행(재시작 흉내). decideNextAction은 completedTasks
  // 기준으로만 다음 task를 고르므로(§ task-registry.ts) RH1을 다시 선택한다. 이번 developer는
  // "새로 만드는" 것이 아니라 이미 있는 partial.txt를 실제로 읽어 이어서 쓴다 — 처음부터
  // 다시 만드는지 아니면 기존 작업을 잇는지를 직접 증명한다.
  let secondClaudeCalls = 0;
  const secondAttempt = await runAutodevOnce({
    manifest,
    orchestratorDeps: {
      claudeRunner: async (): Promise<ClaudeResult> => {
        secondClaudeCalls += 1;
        const existing = readFileSync(join(root, "proj", "partial.txt"), "utf-8");
        writeRepoFile(root, "proj/partial.txt", `${existing}step2-after-restart\n`);
        return {
          success: true,
          summary: "테스트: 재시작 후 기존 partial 작업을 이어서 완료",
          changedFiles: ["proj/partial.txt"],
          tests: [{ name: "proj:check", pass: true }],
          rawOutput: "",
        };
      },
      gptReviewer: fakePassReviewer(),
    },
  });

  check("C) 2회차: 같은 프로세스 재진입이 lock에 막히지 않음(BLOCKED_PROJECT_LOCK 아님)", secondAttempt.outcome !== "BLOCKED_PROJECT_LOCK");
  check("C) 2회차: developer가 정확히 1회만 호출됨(중복 실행 없음)", secondClaudeCalls === 1);
  // 이 manifest는 humanFinalReviewPolicy를 지정하지 않는다(기본값 OFF) — reviewer APPROVED
  // 즉시 checkpoint까지 이어지는 기존 동작을 그대로 유지한다.
  check("C) 2회차: outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED(재개 후 정상 완료)", secondAttempt.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  const finalContent = readFileSync(join(root, "proj", "partial.txt"), "utf-8");
  check("C) 2회차: 최종 파일에 1회차(step1)와 2회차(step2) 내용이 모두 남음(처음부터 다시 만들지 않음)", finalContent.includes("step1") && finalContent.includes("step2-after-restart"));
  const stateAfterSecond = loadState(statePath);
  check("C) 2회차: RH1이 completedTasks에 추가됨(재개된 작업이 실제로 완료됨)", stateAfterSecond.completedTasks.includes("RH1"));
  check("C) 2회차: 성공 후 Project Lock이 release됨", !existsSync(lockFilePathFor(root)));
}

// D) C)와 동일한 "1회차 partial write 후 process crash" 상황에서, 재시작 사이에 task 범위 밖의
//    무관한 변경이 섞이면(다른 프로세스/사람이 직접 만든 파일 등) 2회차가 그 변경까지 함께
//    commit하지 않고 통째로 BLOCK해야 한다(§ 요구사항 4 — "unrelated changes 발견 시 BLOCK").
async function scenarioUnrelatedChangeBetweenRestartsBlocksCheckpoint(): Promise<void> {
  const root = makeTempGitRepo("frh-restart-unrelated-");
  const statePath = makeStateFile(root, { status: "READY" });
  const manifest = buildManifest(root, statePath);

  try {
    await runAutodevOnce({
      manifest,
      orchestratorDeps: {
        claudeRunner: async (): Promise<ClaudeResult> => {
          writeRepoFile(root, "proj/partial.txt", "step1\n");
          throw new Error("테스트: partial write 직후 process 종료(crash 흉내)");
        },
      },
    });
  } catch {
    // 예상된 crash — C) 시나리오에서 이미 이 전파 자체를 별도로 검증했다.
  }

  // 재시작 사이(사람이 직접 만들었거나 다른 프로세스가 남긴) task 범위 밖의 무관한 변경.
  writeRepoFile(root, "other/unrelated-stray-file.txt", "이 task와 무관한 변경\n");

  const secondAttempt = await runAutodevOnce({
    manifest,
    orchestratorDeps: {
      claudeRunner: async (): Promise<ClaudeResult> => ({
        success: true,
        summary: "테스트: 재개 후 정상 완료(하지만 무관한 변경이 섞여 있음)",
        changedFiles: ["proj/partial.txt"],
        tests: [{ name: "proj:check", pass: true }],
        rawOutput: "",
      }),
      gptReviewer: fakePassReviewer(),
    },
  });

  // 이 manifest는 humanFinalReviewPolicy를 지정하지 않는다(기본값 OFF) — checkpoint.ts의
  // 범위 재검증(computeCommitPlan)이 이 단일 호출 안에서 그대로 BLOCK한다.
  check("D) 무관한 변경이 섞이면 outcome=RAN_TASK_CHECKPOINT_BLOCKED", secondAttempt.outcome === "RAN_TASK_CHECKPOINT_BLOCKED");
  check(
    "D) unexpectedFiles에 other/unrelated-stray-file.txt 포함",
    (secondAttempt.checkpoint?.unexpectedFiles ?? []).includes("other/unrelated-stray-file.txt")
  );
  const stateAfter = loadState(statePath);
  check("D) RH1이 completedTasks에 추가되지 않음(부분 commit 없음)", !stateAfter.completedTasks.includes("RH1"));
  check("D) status='WAITING_HUMAN'", stateAfter.status === "WAITING_HUMAN");
  check("D) 커밋이 생성되지 않음(init 1건만)", gitLogCount(root) === 1);
  check(
    "D) task 자신의 partial 작업물도(무관한 변경과 함께) 삭제되지 않고 그대로 보존됨(사람이 검토 가능)",
    existsSync(join(root, "proj", "partial.txt")) && existsSync(join(root, "other", "unrelated-stray-file.txt"))
  );
  check("D) 실패 상태이므로 Project Lock을 유지함", existsSync(lockFilePathFor(root)));
}

// ---------------------------------------------------------------------------
// E) Telegram Auto Resume 중복 호출 — 첫 호출이 실제로 task를 완료시킨 뒤, 같은 approval로
//    두 번째 호출이 들어와도 developer/reviewer가 다시 실행되지 않아야 한다(§ 요구사항 9 —
//    duplicate resume → no duplicate writer).
// ---------------------------------------------------------------------------
function baseApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: randomUUID(),
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:30:00.000Z",
    runId: "run-1",
    taskId: "RH1",
    approvalType: "ORCHESTRATOR_NOT_APPROVED_GENERIC",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: randomUUID(),
    status: "APPROVED",
    remotelyApprovable: true,
    requiresSafetyRecheck: true,
    dedupeKey: `dk-${randomUUID()}`,
    ...overrides,
  };
}

async function scenarioDuplicateResumeDoesNotDoubleRun(): Promise<void> {
  const root = makeTempGitRepo("frh-duplicate-resume-");
  const statePath = makeStateFile(root, { status: "WAITING_HUMAN" });
  // 이 시나리오는 "old Auto Resume 경로가 HFR gate를 우회하지 못함"을 직접 검증하는 전용
  // 시나리오다(§ HFR 요구사항 7) — 이 project는 humanFinalReviewPolicy를 명시적으로
  // opt-in한다. buildManifest() 자체(다른 시나리오가 공유)는 기본값 OFF를 유지한다.
  const manifest = { ...buildManifest(root, statePath), humanFinalReviewPolicy: { enabled: true } };
  const approval = baseApproval({});

  let claudeCalls = 0;
  let gptCalls = 0;
  const orchestratorDeps = {
    claudeRunner: async (): Promise<ClaudeResult> => {
      claudeCalls += 1;
      writeRepoFile(root, "proj/resume-done.txt", "done\n");
      return {
        success: true,
        summary: "테스트: 정상 완료",
        changedFiles: ["proj/resume-done.txt"],
        tests: [{ name: "proj:check", pass: true }],
        rawOutput: "",
      };
    },
    gptReviewer: fakePassReviewer(),
  };

  const first = await performAutoResume(approval, manifest, { orchestratorDeps });
  check("E) 1차 resume: COMPLETED", first.kind === "COMPLETED");
  check("E) 1차 resume: developer 정확히 1회 호출", claudeCalls === 1);
  // Minimal HUMAN_FINAL_REVIEW Runtime Checkpoint Gate — reviewer APPROVED 직후에도 이
  // task는 아직 "완료"가 아니다(사람의 최종 승인 대기 중) — 1차 resume의 실제 outcome은
  // AWAITING_HUMAN_FINAL_REVIEW다.
  if (first.kind === "COMPLETED") {
    check("E) 1차 resume: 실제 outcome은 아직 AWAITING_HUMAN_FINAL_REVIEW(체크포인트 전)", first.result.outcome === "RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW");
  }

  // 같은 approval을 재사용한 2차 resume 시도 — RH1이 아직 completedTasks에 없으므로(위
  // gate가 checkpoint 전에 먼저 멈췄다) STALE_APPROVAL_TASK_ALREADY_COMPLETED로는 막히지
  // 않는다. 대신 auto-resume.ts가 "이 WAITING_HUMAN은 Human Final Review gate가 대기 중"
  // 이라는 것을 직접 인식해 developer/reviewer를 처음부터 재실행하는 옛 Auto Resume 경로
  // 자체를 거부한다(§ auto-resume.ts — approveHumanFinalReview()를 통해서만 이 gate를
  // 넘길 수 있다).
  const second = await performAutoResume(approval, manifest, { orchestratorDeps });
  check("E) 2차 resume(같은 approval 재사용): BLOCKED(Human Final Review gate 대기 중)", second.kind === "BLOCKED");
  if (second.kind === "BLOCKED") {
    check("E) 2차 resume 사유=HUMAN_FINAL_REVIEW_GATE_PENDING", second.reason === "HUMAN_FINAL_REVIEW_GATE_PENDING");
  }
  check("E) 2차 resume에서 developer가 추가로 호출되지 않음(여전히 1회)", claudeCalls === 1);
  check("E) 2차 resume에서 GPT reviewer도 추가로 호출되지 않음", gptCalls === 0);
}

// ---------------------------------------------------------------------------
// G) saveState() 원자적 쓰기(이번 Task에서 state.ts에 추가) 회귀.
// ---------------------------------------------------------------------------
function scenarioAtomicStateWriteLeavesNoTempFilesAndRoundTrips(): void {
  const dir = mkdtempSync(join(tmpdir(), "frh-atomic-state-"));
  tempDirs.push(dir);
  const statePath = join(dir, "project-state.json");

  let lastState: CoreState | undefined;
  for (let i = 0; i < 20; i++) {
    const state: CoreState = {
      currentTask: `task-${i}`,
      reviewCycle: i,
      lastClaudeResult: null,
      lastGptDecision: null,
      status: "READY",
      claudeLimitWaitCount: 0,
      deferredHumanTasks: [],
      completedTasks: Array.from({ length: i }, (_, k) => `T${k}`),
      gitCheckpoint: `hash-${i}`,
      currentPhase: 1,
    };
    saveState(state as ProjectState, statePath);
    const onDisk = JSON.parse(readFileSync(statePath, "utf-8")) as CoreState;
    if (onDisk.currentTask !== `task-${i}` || onDisk.reviewCycle !== i) {
      check(`G) 저장 #${i} 직후 즉시 읽으면 완전한 유효 JSON이며 방금 저장한 값과 정확히 일치`, false);
      return;
    }
    lastState = onDisk;
  }
  check("G) 반복 저장 20회 모두 매번 완전한 유효 JSON을 남김(부분/손상 기록 없음)", lastState?.currentTask === "task-19");

  const leftoverTmpFiles = readdirSync(dir).filter((f) => f.includes(".tmp"));
  check("G) 저장 완료 후 임시(.tmp) 파일이 남지 않음", leftoverTmpFiles.length === 0);
}

function scenarioAtomicStateWriteFailsLoudOnMissingDirectory(): void {
  const dir = mkdtempSync(join(tmpdir(), "frh-atomic-state-missing-"));
  tempDirs.push(dir);
  const statePath = join(dir, "missing-subdir", "project-state.json"); // "missing-subdir"를 만들지 않음.
  const state: CoreState = {
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "READY",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
    gitCheckpoint: "x",
    currentPhase: 1,
  };
  let threw = false;
  try {
    saveState(state as ProjectState, statePath);
  } catch {
    threw = true;
  }
  check("G) 존재하지 않는 디렉터리로의 저장은 조용히 무시되지 않고 즉시 예외를 던짐(silent no-op 아님)", threw);
  check("G) 실패한 저장은 대상 경로에 아무 파일도 남기지 않음", !existsSync(statePath));
}

async function main(): Promise<void> {
  const realStateBefore = existsSync(DEFAULT_STATE_PATH) ? readFileSync(DEFAULT_STATE_PATH, "utf-8") : undefined;

  await scenarioCorruptStateFileFailsClosed();
  await scenarioRestartResumesWithPartialChangePreserved();
  await scenarioUnrelatedChangeBetweenRestartsBlocksCheckpoint();
  await scenarioDuplicateResumeDoesNotDoubleRun();
  scenarioAtomicStateWriteLeavesNoTempFilesAndRoundTrips();
  scenarioAtomicStateWriteFailsLoudOnMissingDirectory();

  const realStateAfter = existsSync(DEFAULT_STATE_PATH) ? readFileSync(DEFAULT_STATE_PATH, "utf-8") : undefined;
  check("project-state 격리: 실제 project-state.json이 테스트 실행 전후 완전히 동일함", realStateBefore === realStateAfter);

  console.log("\n=== Failure / Resume Hardening(G7.4) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);

  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // OS 임시 디렉터리 — 정리 실패는 테스트 결과에 영향 없음.
    }
  }

  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
