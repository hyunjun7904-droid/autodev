import { spawnSync } from "node:child_process";
import { PROJECT_ROOT } from "./safe-executor";
import { getWorkingTreeChanges, isPathInScope } from "./git-changes";
import type { WorkingTreeChange } from "./git-changes";
import type { TaskDefinition } from "./task-registry";
import type { GptDecision, SeverityCounts } from "./types";
import { log } from "./logger";
import { scanChangesForSecrets } from "./secret-scanner";
import type { SecretFinding } from "./secret-scanner";

// 자동 Git CHECKPOINT — GPT 승인(Critical 0 / High 0) + 필수 테스트 전부 PASS일 때만
// commit을 만든다. commit 대상은 해당 task가 실제로 바꾼(allowedPathPrefixes 안의) 파일만
// 이며, 그 밖의 변경이 하나라도 있으면 통째로 BLOCK한다(부분 commit으로 넘어가지 않는다 —
// "unexpected file modification이 있으면 BLOCK"). git add -N 등 index를 임의로 바꾸는
// 방식은 쓰지 않는다 — git-changes.ts(git status --porcelain, 읽기 전용)로 계산한 뒤,
// 실제로 add할 파일 목록을 명시적으로 골라 git add -- <파일들>만 실행한다.
//
// 이 모듈의 모든 git 명령은 cwd 인자를 받는다 — 실제 운용은 PROJECT_ROOT(기본값)를 쓰고,
// 테스트는 반드시 별도의 임시 git repo를 만들어 그 경로를 넘긴다(실제 프로젝트 repo에는
// 어떤 git 명령도 실행하지 않는다).

export interface CommitPlan {
  allowed: WorkingTreeChange[];
  unexpected: WorkingTreeChange[];
}

/** taskDef.allowedPathPrefixes 기준으로 실제 변경 파일을 allowed/unexpected로 나눈다.
 *  scope는 repo 전체(".")로 잡는다 — web/automation/supabase 바깥에서 뭔가 바뀌었다면
 *  그것도 놓치지 않고 unexpected로 잡아야 하기 때문이다.
 *
 *  excludePaths(보통 project-state.json 경로 하나)는 allowed에도 unexpected에도 넣지
 *  않는다 — orchestrator가 이 task를 실행하는 동안에도(진행 상황 저장을 위해) 정상적으로
 *  project-state.json을 계속 갱신하므로, 이 product commit의 "이 task가 실제로 만든
 *  변경" 판정에서는 완전히 무시한다. project-state.json은 checkpoint 성공 이후 별도의
 *  administrative commit(commitProjectStateOnly)으로만 다뤄진다. */
export function computeCommitPlan(
  taskDef: TaskDefinition,
  cwd: string = PROJECT_ROOT,
  excludePaths: string[] = []
): CommitPlan {
  const changes = getWorkingTreeChanges(["."], cwd);
  const excludeSet = new Set(excludePaths);
  const allowed: WorkingTreeChange[] = [];
  const unexpected: WorkingTreeChange[] = [];
  for (const c of changes.all) {
    if (excludeSet.has(c.path)) continue;
    const inScope = isPathInScope(c.path, taskDef.allowedPathPrefixes);
    (inScope ? allowed : unexpected).push(c);
  }
  return { allowed, unexpected };
}

export interface ApprovalInput {
  decision: GptDecision;
  severity: SeverityCounts;
  requiredTestsAllPassed: boolean;
}

/** GPT 승인 + Critical 0 / High 0 + 필수 테스트 전부 PASS일 때만 checkpoint를 진행할 수
 *  있다. 이 함수는 git을 전혀 건드리지 않는 순수 판단이다 — 단위 테스트하기 쉽게 분리. */
export function evaluateApproval(input: ApprovalInput): { approved: boolean; reason?: string } {
  if (!input.requiredTestsAllPassed) {
    return { approved: false, reason: "필수 테스트가 전부 PASS하지 않았습니다 — checkpoint 불가." };
  }
  if (input.decision !== "PASS") {
    return { approved: false, reason: `GPT decision이 PASS가 아닙니다(${input.decision}) — checkpoint 불가.` };
  }
  if (input.severity.critical > 0 || input.severity.high > 0) {
    return {
      approved: false,
      reason: `Critical/High가 남아있습니다(critical=${input.severity.critical}, high=${input.severity.high}) — checkpoint 불가.`,
    };
  }
  return { approved: true };
}

function runGit(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd, shell: false, encoding: "utf-8" });
  return { ok: res.status === 0, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

export function buildCommitMessage(taskDef: TaskDefinition, reviewFeedback?: string): string {
  const header = `feat: implement Phase ${taskDef.phase} Task ${taskDef.taskNumber} — ${taskDef.title}`;
  const body = reviewFeedback ? `\n\nGPT review: ${reviewFeedback.slice(0, 500)}` : "";
  return `${header}${body}`;
}

export interface PerformCheckpointOptions {
  decision: GptDecision;
  severity: SeverityCounts;
  requiredTestsAllPassed: boolean;
  reviewFeedback?: string;
  cwd?: string;
  /** project-state.json의 cwd 기준 상대경로 등 — 이 product commit의 대상/판정에서
   *  완전히 제외한다(별도 administrative commit으로 처리되므로). */
  excludePaths?: string[];
}

export interface CheckpointOutcome {
  ok: boolean;
  reason?: string;
  commitHash?: string;
  filesCommitted?: string[];
  unexpectedFiles?: string[];
  /** Deterministic Secret Scanner Gate(Phase C Task C3)가 commit 대상에서 발견한 항목 —
   *  file/line/kind만 담는다(secret 원문은 절대 담기지 않는다). */
  secretFindings?: SecretFinding[];
}

/**
 * 실제 commit을 만드는 유일한 지점. 순서:
 *   1) evaluateApproval — 승인 조건 미달이면 git을 전혀 건드리지 않고 즉시 반환.
 *   2) computeCommitPlan — unexpected가 하나라도 있으면 BLOCK(부분 commit 없음).
 *   3) allowed가 비어있으면(커밋할 것이 없음) 실패로 반환.
 *   4) Deterministic Secret Scanner Gate(scanChangesForSecrets) — allowed(commit 대상)만
 *      검사한다. 하나라도 발견되면 git add조차 실행하지 않고 즉시 BLOCK(fail-open 금지).
 *      이 단계는 어떤 policy도 받지 않으므로 프로젝트가 약화/우회할 수 없다.
 *   5) git add -- <allowed 파일들>만 정확히 실행 → git diff --cached --name-only로 staged
 *      집합이 기대한 것과 정확히 일치하는지 재검증(TOCTOU 방지) → 불일치 시 add를 되돌리고
 *      BLOCK.
 *   6) git commit -m <task metadata 기반 메시지>.
 *   7) git rev-parse HEAD로 hash 획득.
 */
export function performTaskCheckpoint(taskDef: TaskDefinition, opts: PerformCheckpointOptions): CheckpointOutcome {
  const cwd = opts.cwd ?? PROJECT_ROOT;

  const approval = evaluateApproval(opts);
  if (!approval.approved) {
    log("checkpoint 거부(승인 조건 미달)", { taskId: taskDef.id, reason: approval.reason });
    return { ok: false, reason: approval.reason };
  }

  const plan = computeCommitPlan(taskDef, cwd, opts.excludePaths ?? []);
  if (plan.unexpected.length > 0) {
    const unexpectedFiles = plan.unexpected.map((c) => c.path);
    log("checkpoint BLOCK — allowedPathPrefixes 밖 예상치 못한 변경 발견", { taskId: taskDef.id, unexpectedFiles });
    return { ok: false, reason: "예상치 못한 범위 밖 파일 변경이 있어 commit을 중단했습니다.", unexpectedFiles };
  }
  if (plan.allowed.length === 0) {
    return { ok: false, reason: "commit할 변경 파일이 없습니다." };
  }

  const secretScan = scanChangesForSecrets(plan.allowed, cwd);
  if (!secretScan.clean) {
    log("checkpoint BLOCK — commit 대상에서 민감정보(secret) 패턴 발견", {
      taskId: taskDef.id,
      findings: secretScan.findings,
    });
    return {
      ok: false,
      reason: "commit 대상 파일에서 민감정보(secret) 패턴이 발견되어 commit을 중단했습니다.",
      secretFindings: secretScan.findings,
    };
  }

  const filesToAdd = plan.allowed.map((c) => c.path);
  const addRes = runGit(["add", "--", ...filesToAdd], cwd);
  if (!addRes.ok) {
    log("checkpoint 실패 — git add 실패", { taskId: taskDef.id, stderr: addRes.stderr });
    return { ok: false, reason: "git add 실패." };
  }

  // TOCTOU 방지: add 직후 실제로 staged된 파일 집합이 계획한 것과 정확히 일치하는지
  // 재확인한다(그 사이 다른 프로세스가 워킹트리를 바꿨을 가능성 등에 대비).
  const stagedRes = runGit(["diff", "--cached", "--name-only"], cwd);
  const stagedSet = new Set(stagedRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean));
  const expectedSet = new Set(filesToAdd);
  const stagedMatchesExpected =
    stagedSet.size === expectedSet.size && [...expectedSet].every((f) => stagedSet.has(f));
  if (!stagedMatchesExpected) {
    runGit(["reset"], cwd);
    log("checkpoint BLOCK — staged 파일 집합이 계획과 불일치(TOCTOU 방지)", {
      taskId: taskDef.id,
      expected: [...expectedSet],
      staged: [...stagedSet],
    });
    return { ok: false, reason: "staged 파일 집합이 예상과 달라 commit을 중단했습니다(index reset됨)." };
  }

  const message = buildCommitMessage(taskDef, opts.reviewFeedback);
  const commitRes = runGit(["commit", "-m", message], cwd);
  if (!commitRes.ok) {
    runGit(["reset"], cwd);
    log("checkpoint 실패 — git commit 실패", { taskId: taskDef.id, stderr: commitRes.stderr });
    return { ok: false, reason: "git commit 실패(index reset됨)." };
  }

  const hashRes = runGit(["rev-parse", "HEAD"], cwd);
  if (!hashRes.ok) {
    log("checkpoint 경고 — commit은 성공했지만 hash 조회 실패", { taskId: taskDef.id });
    return { ok: true, filesCommitted: filesToAdd };
  }

  log("checkpoint 성공", { taskId: taskDef.id, commitHash: hashRes.stdout, files: filesToAdd });
  return { ok: true, commitHash: hashRes.stdout, filesCommitted: filesToAdd };
}

/**
 * project-state.json 자체는 tracked라 자기참조(commit hash를 그 commit 안에 넣는 것) 문제가
 * 있다 — product commit(위 performTaskCheckpoint)이 이미 끝난 뒤, project-state.json 변경만
 * 별도의 "administrative commit"으로 만든다(요구사항: 2단계 commit으로 clean working tree
 * 보장). statePath는 항상 automation/config/project-state.json 하나뿐이므로 파일 목록을
 * 계산할 필요 없이 고정 경로로 add한다.
 */
export function commitProjectStateOnly(statePathRel: string, message: string, cwd: string = PROJECT_ROOT): CheckpointOutcome {
  const addRes = runGit(["add", "--", statePathRel], cwd);
  if (!addRes.ok) return { ok: false, reason: "git add(project-state) 실패." };

  const stagedRes = runGit(["diff", "--cached", "--name-only"], cwd);
  const staged = stagedRes.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  if (staged.length === 0) {
    // project-state.json 자체가 실질적으로 바뀌지 않은 경우(예: 이미 동일 내용) — 정상.
    return { ok: true, filesCommitted: [] };
  }
  if (staged.length !== 1 || staged[0] !== statePathRel) {
    runGit(["reset"], cwd);
    return { ok: false, reason: "project-state 외 다른 파일이 함께 staged됨(index reset됨).", unexpectedFiles: staged };
  }

  const commitRes = runGit(["commit", "-m", message], cwd);
  if (!commitRes.ok) {
    runGit(["reset"], cwd);
    return { ok: false, reason: "git commit(project-state) 실패(index reset됨)." };
  }
  const hashRes = runGit(["rev-parse", "HEAD"], cwd);
  return { ok: true, commitHash: hashRes.ok ? hashRes.stdout : undefined, filesCommitted: [statePathRel] };
}
