import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { decideSelfDevCompletionTrigger, runSelfDevCompletionHook } from "./self-dev-completion-hook";
import type { CommandRunner, CommandOutcome } from "./self-dev-completion-hook";
import { writeSelfDevTaskContext, readSelfDevTaskContext, isTaskContextError } from "./self-dev-task-context";

// self-dev-completion-hook.ts 테스트 — Phase G Task G7.3.1b(Self-Dev Completion Workflow
// Auto Trigger Fix). 실제 self-dev-complete.js/typecheck/build/전체 회귀/Telegram은 전혀
// 실행하지 않는다 — runSelfDevCompletionHook의 CommandRunner seam을 fake로 주입한다(§
// self-dev-complete-tests.ts와 동일한 injectable pattern). git 상태(HEAD/commit)는 실제
// 격리된 임시 fixture repo에서 실제 git으로 만든다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "sdch-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "SDCH Test"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "fixture\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function commitMore(dir: string, name: string): void {
  writeFileSync(join(dir, name), "more\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", name], { cwd: dir });
}

function makeFakeRunner(outcome: CommandOutcome, callLog?: { command: string; args: string[] }[]): CommandRunner {
  return (command, args) => {
    callLog?.push({ command, args });
    return outcome;
  };
}

function makeDistEntry(dir: string): void {
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "self-dev-complete.js"), "// fixture — 실제로 실행되지 않는다(runner는 항상 fake)\n");
}

// ---------------------------------------------------------------------------
// 1) git push/commit이 아닌 명령 → 트리거하지 않는다(context 유무와 무관)
// ---------------------------------------------------------------------------
function scenarioIrrelevantCommandNeverTriggers(): void {
  const dir = makeGitRepo("sdch-irrelevant-");
  writeSelfDevTaskContext(dir, { taskId: "G7.3.1b", pushRequired: true });
  const decision = decideSelfDevCompletionTrigger({ command: "npm run build", repoRoot: dir });
  check("1) git push/commit이 아닌 명령 → trigger=false", decision.trigger === false);
}

// ---------------------------------------------------------------------------
// 2) context 미선언 상태에서 git push → 트리거하지 않는다(fail-closed)
// ---------------------------------------------------------------------------
function scenarioNoContextNeverTriggers(): void {
  const dir = makeGitRepo("sdch-no-context-");
  const decision = decideSelfDevCompletionTrigger({ command: "git push origin main", repoRoot: dir });
  check("2) context 미선언 + git push → trigger=false", decision.trigger === false);
  check("2) reason에 self-dev:begin 안내 포함", !decision.trigger && decision.reason.includes("self-dev:begin"));
}

// ---------------------------------------------------------------------------
// 3) push 필요 Task + commit만(push 아직) → 아직 트리거하지 않는다
// ---------------------------------------------------------------------------
function scenarioPushRequiredWaitsForPush(): void {
  const dir = makeGitRepo("sdch-push-wait-");
  writeSelfDevTaskContext(dir, { taskId: "G7.3.1b", pushRequired: true });
  commitMore(dir, "a.txt");
  const decision = decideSelfDevCompletionTrigger({ command: 'git commit -m "a"', repoRoot: dir });
  check("3) push 필요 Task + commit만 → trigger=false(push 대기)", decision.trigger === false);
}

// ---------------------------------------------------------------------------
// 4) push 필요 Task + 새 commit + git push → 트리거한다
// ---------------------------------------------------------------------------
function scenarioPushRequiredTriggersOnPush(): void {
  const dir = makeGitRepo("sdch-push-trigger-");
  writeSelfDevTaskContext(dir, { taskId: "G7.3.1b", pushRequired: true });
  commitMore(dir, "a.txt");
  const decision = decideSelfDevCompletionTrigger({ command: "git push origin main", repoRoot: dir });
  check("4) push 필요 Task + 새 commit + git push → trigger=true", decision.trigger === true);
  if (decision.trigger) {
    check("4) taskId가 선언값과 일치", decision.taskId === "G7.3.1b");
    check("4) pushRequired가 선언값과 일치", decision.pushRequired === true);
  }
}

// ---------------------------------------------------------------------------
// 5) push 불필요 Task + 새 commit → commit 시점에 트리거한다
// ---------------------------------------------------------------------------
function scenarioCommitOnlyTriggersOnCommit(): void {
  const dir = makeGitRepo("sdch-commit-trigger-");
  writeSelfDevTaskContext(dir, { taskId: "G7.3.2", pushRequired: false });
  commitMore(dir, "a.txt");
  const decision = decideSelfDevCompletionTrigger({ command: 'git commit -m "a"', repoRoot: dir });
  check("5) push 불필요 Task + 새 commit + git commit → trigger=true", decision.trigger === true);
}

// ---------------------------------------------------------------------------
// 6) push 불필요 Task에서 push만 실행됨 → 트리거하지 않는다(commit 시점에 이미 트리거됐어야 함)
// ---------------------------------------------------------------------------
function scenarioCommitOnlyIgnoresPush(): void {
  const dir = makeGitRepo("sdch-commit-only-ignore-push-");
  writeSelfDevTaskContext(dir, { taskId: "G7.3.2", pushRequired: false });
  commitMore(dir, "a.txt");
  const decision = decideSelfDevCompletionTrigger({ command: "git push origin main", repoRoot: dir });
  check("6) push 불필요 Task + git push만 → trigger=false", decision.trigger === false);
}

// ---------------------------------------------------------------------------
// 7) commit *직후*(push 직전)에 선언해도(baseHeadHash === 현재 HEAD) 정상적으로 트리거한다
//    — self-dev:begin을 SKILL.md가 권장하는 순서(commit 전)보다 한 박자 늦게, commit
//    직후에 실행한 경우에도 오탐으로 막히면 안 된다(§ self-dev-completion-hook.ts 주석).
// ---------------------------------------------------------------------------
function scenarioDeclareAfterCommitStillTriggers(): void {
  const dir = makeGitRepo("sdch-declare-after-commit-");
  // 먼저 "완료용" commit을 만들고, 그 다음에야 context를 선언한다(권장 순서의 역순).
  commitMore(dir, "a.txt");
  writeSelfDevTaskContext(dir, { taskId: "G7.3.1b", pushRequired: true });
  const decision = decideSelfDevCompletionTrigger({ command: "git push origin main", repoRoot: dir });
  check("7) commit 직후 선언(baseHeadHash===현재 HEAD) → trigger=true(오탐 없음)", decision.trigger === true);
}

// ---------------------------------------------------------------------------
// 8) 손상된 context 파일 → 트리거하지 않는다
// ---------------------------------------------------------------------------
function scenarioCorruptedContextNeverTriggers(): void {
  const dir = makeGitRepo("sdch-corrupt-");
  const ctxDir = join(dir, ".autodev-self-dev");
  mkdirSync(ctxDir, { recursive: true });
  writeFileSync(join(ctxDir, "current-task.local.json"), "{ broken", "utf-8");
  commitMore(dir, "a.txt");
  const decision = decideSelfDevCompletionTrigger({ command: "git push origin main", repoRoot: dir });
  check("8) 손상된 context → trigger=false(fail-closed)", decision.trigger === false);
}

// ---------------------------------------------------------------------------
// 9) 체이닝된 명령("commit && push") 안에서도 push를 정확히 감지한다
// ---------------------------------------------------------------------------
function scenarioChainedCommandDetectsPush(): void {
  const dir = makeGitRepo("sdch-chained-");
  writeSelfDevTaskContext(dir, { taskId: "G7.3.1b", pushRequired: true });
  commitMore(dir, "a.txt");
  const decision = decideSelfDevCompletionTrigger({
    command: 'git add -- a.txt && git commit -m "a" && git push origin main',
    repoRoot: dir,
  });
  check("9) 체이닝된 commit&&push 명령 → trigger=true(push 감지)", decision.trigger === true);
}

// ---------------------------------------------------------------------------
// 10) runSelfDevCompletionHook: 트리거 안 되면 runner를 전혀 호출하지 않는다
// ---------------------------------------------------------------------------
function scenarioRunHookSkipsRunnerWhenNotTriggered(): void {
  const dir = makeGitRepo("sdch-run-skip-");
  const calls: { command: string; args: string[] }[] = [];
  const runner = makeFakeRunner({ ok: true, code: 0, stdout: "", stderr: "" }, calls);
  const result = runSelfDevCompletionHook({ command: "npm test", repoRoot: dir }, runner);
  check("10) 트리거 안 됨 → triggered=false", result.triggered === false);
  check("10) 트리거 안 됨 → runner 호출 없음", calls.length === 0);
}

// ---------------------------------------------------------------------------
// 11) runSelfDevCompletionHook: dist/self-dev-complete.js가 없으면 runner를 호출하지 않고
//     실패로 보고하며 context는 유지한다(재시도 가능)
// ---------------------------------------------------------------------------
function scenarioRunHookFailsClosedWhenDistMissing(): void {
  const dir = makeGitRepo("sdch-run-nodist-");
  writeSelfDevTaskContext(dir, { taskId: "G7.3.1b", pushRequired: true });
  commitMore(dir, "a.txt");
  const calls: { command: string; args: string[] }[] = [];
  const runner = makeFakeRunner({ ok: true, code: 0, stdout: "", stderr: "" }, calls);
  const result = runSelfDevCompletionHook({ command: "git push origin main", repoRoot: dir }, runner);
  check("11) dist 없음 → triggered=true, ok=false", result.triggered === true && result.ok === false);
  check("11) dist 없음 → runner 호출 없음", calls.length === 0);
  const ctx = readSelfDevTaskContext(dir);
  check("11) dist 없음 → context는 유지된다(재시도 가능)", !isTaskContextError(ctx) && !!ctx);
}

// ---------------------------------------------------------------------------
// 12) runSelfDevCompletionHook: 정상 트리거 + runner 성공 → context를 소비(clear)하고
//     node <dist entry> --task-id <id> --push 형태로 호출한다
// ---------------------------------------------------------------------------
function scenarioRunHookSuccessClearsContext(): void {
  const dir = makeGitRepo("sdch-run-success-");
  makeDistEntry(dir);
  writeSelfDevTaskContext(dir, { taskId: "G7.3.1b", pushRequired: true });
  commitMore(dir, "a.txt");
  const calls: { command: string; args: string[] }[] = [];
  const runner = makeFakeRunner({ ok: true, code: 0, stdout: "done", stderr: "" }, calls);
  const result = runSelfDevCompletionHook({ command: "git push origin main", repoRoot: dir }, runner);

  check("12) 정상 트리거 + runner 성공 → triggered=true, ok=true", result.triggered === true && result.ok === true);
  check("12) runner가 정확히 1회 호출된다", calls.length === 1);
  check("12) runner 호출 인자에 dist/self-dev-complete.js 포함", calls[0]?.args.some((a) => a.endsWith(join("dist", "self-dev-complete.js"))));
  check("12) runner 호출 인자에 --task-id G7.3.1b 포함", calls[0]?.args.includes("--task-id") && calls[0]?.args.includes("G7.3.1b"));
  check("12) pushRequired=true → --push 포함", calls[0]?.args.includes("--push"));
  check("12) 성공 후 context가 소비(삭제)된다", readSelfDevTaskContext(dir) === undefined);
}

// ---------------------------------------------------------------------------
// 13) runSelfDevCompletionHook: 정상 트리거 + runner 실패 → context를 유지한다(재시도 가능)
// ---------------------------------------------------------------------------
function scenarioRunHookFailureKeepsContext(): void {
  const dir = makeGitRepo("sdch-run-fail-");
  makeDistEntry(dir);
  writeSelfDevTaskContext(dir, { taskId: "G7.3.1b", pushRequired: true });
  commitMore(dir, "a.txt");
  const runner = makeFakeRunner({ ok: false, code: 1, stdout: "", stderr: "typecheck failed(fixture)" });
  const result = runSelfDevCompletionHook({ command: "git push origin main", repoRoot: dir }, runner);

  check("13) 정상 트리거 + runner 실패 → triggered=true, ok=false", result.triggered === true && result.ok === false);
  const ctx = readSelfDevTaskContext(dir);
  check("13) 실패 → context가 유지된다(재시도 가능)", !isTaskContextError(ctx) && ctx?.taskId === "G7.3.1b");
}

// ---------------------------------------------------------------------------
// 14) pushRequired=false Task → runner 호출 인자에 --push가 없다
// ---------------------------------------------------------------------------
function scenarioRunHookCommitOnlyOmitsPushFlag(): void {
  const dir = makeGitRepo("sdch-run-commit-only-");
  makeDistEntry(dir);
  writeSelfDevTaskContext(dir, { taskId: "G7.3.2", pushRequired: false });
  commitMore(dir, "a.txt");
  const calls: { command: string; args: string[] }[] = [];
  const runner = makeFakeRunner({ ok: true, code: 0, stdout: "", stderr: "" }, calls);
  runSelfDevCompletionHook({ command: 'git commit -m "a"', repoRoot: dir }, runner);
  check("14) pushRequired=false → 호출 인자에 --push 없음", !(calls[0]?.args.includes("--push") ?? true));
}

function main(): void {
  scenarioIrrelevantCommandNeverTriggers();
  scenarioNoContextNeverTriggers();
  scenarioPushRequiredWaitsForPush();
  scenarioPushRequiredTriggersOnPush();
  scenarioCommitOnlyTriggersOnCommit();
  scenarioCommitOnlyIgnoresPush();
  scenarioDeclareAfterCommitStillTriggers();
  scenarioCorruptedContextNeverTriggers();
  scenarioChainedCommandDetectsPush();
  scenarioRunHookSkipsRunnerWhenNotTriggered();
  scenarioRunHookFailsClosedWhenDistMissing();
  scenarioRunHookSuccessClearsContext();
  scenarioRunHookFailureKeepsContext();
  scenarioRunHookCommitOnlyOmitsPushFlag();

  console.log("\n=== self-dev-completion-hook.ts(G7.3.1b) 테스트 결과 ===");
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
