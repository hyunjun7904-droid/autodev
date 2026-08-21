import { execSync } from "node:child_process";
import { runClaudeTask } from "./claude-runner";
import { TARGET_PROJECT_ROOT as PROJECT_ROOT } from "./project-context";

// Phase B Task B2 — 이전에는 join(__dirname, "..", "..")로 "automation/dist가 target repo
// 안에 중첩돼 있다"는 전제를 이 파일에서 독자적으로 재계산했다(safe-executor.ts/gpt-reviewer.ts와
// 달리 project-context.ts를 거치지 않는 유일한 예외였다). AutoDev standalone repo에서는 그
// 전제가 더 이상 성립하지 않으므로(AutoDev Root와 Target Project Root가 임의의 독립 절대
// 경로일 수 있다), project-context.ts가 export하는 TARGET_PROJECT_ROOT(AUTODEV_TARGET_PROJECT_ROOT
// 환경변수 주입을 그대로 반영)를 그대로 재사용한다.

const PROBE_TASK =
  "Return a short machine-readable response indicating CLAUDE_CLI_OK. Do not modify files or execute tools.";

function gitStatusShort(): string {
  return execSync("git status --short", { cwd: PROJECT_ROOT, encoding: "utf-8" });
}

async function main(): Promise<void> {
  const before = gitStatusShort();
  const result = await runClaudeTask(PROBE_TASK, 1, { timeoutMs: 60_000 });
  const after = gitStatusShort();

  const started = result.errorCode !== "CLI_NOT_FOUND";
  const parsedOk = result.success && typeof result.summary === "string" && result.summary.length > 0;
  const noFileChange = before === after;

  console.log("=== smoke test 결과 ===");
  console.log(`[${started ? "PASS" : "FAIL"}] subprocess 정상 시작`);
  console.log(`[${result.success ? "PASS" : "FAIL"}] exit code 정상(success=${result.success}${result.errorCode ? ", errorCode=" + result.errorCode : ""})`);
  console.log(`[${parsedOk ? "PASS" : "FAIL"}] 결과 parsing 성공`);
  console.log(`[${noFileChange ? "PASS" : "FAIL"}] 파일 변경 0 (git status --short 동일)`);
  console.log(`summary: ${result.summary}`);

  if (!noFileChange) {
    console.log("--- before ---\n" + before);
    console.log("--- after ---\n" + after);
  }

  const allPass = started && result.success && parsedOk && noFileChange;
  if (!allPass) process.exitCode = 1;
}

main();
