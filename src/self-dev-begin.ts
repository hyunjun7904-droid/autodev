import { join } from "node:path";
import { writeSelfDevTaskContext, isTaskContextError } from "./self-dev-task-context";

// Self-Dev Task Begin — Phase G Task G7.3.1b.
//
// task-complete Skill의 completion 절차를 시작하기 직전(typecheck/build를 통과한 뒤, commit
// 전) Claude가 실행하는 한 줄짜리 명시적 선언이다:
//
//   npm run self-dev:begin -- --task-id <TaskId> [--push]
//
// 이 명령은 "이 Task가 완료됐다"고 주장하지 않는다 — self-dev:complete(또는 그걸 자동
// 호출하는 PostToolUse hook, § self-dev-completion-hook.ts)가 이후 실제로 commit/push된
// 상태를 대상으로 typecheck/build/전체 회귀/push를 처음부터 다시 검증한 뒤에만
// TASK_COMPLETED가 만들어진다. 이 명령이 하는 일은 오직 "지금부터 이어지는 commit(+push)이
// 어떤 taskId에 대응하는가"를 self-dev-task-context.ts에 로컬로만(§ 파일, gitignored)
// 남기는 것뿐이다 — hook이 나중에 taskId를 추측하지 않아도 되게 하기 위함이다.

const REPO_ROOT = join(__dirname, "..");

interface CliArgs {
  taskId: string;
  pushRequired: boolean;
}

function parseArgs(argv: string[]): CliArgs | { error: string } {
  const idx = argv.indexOf("--task-id");
  const taskId = idx !== -1 ? argv[idx + 1] : undefined;
  if (!taskId || taskId.startsWith("--")) {
    return { error: "--task-id <id>가 필요합니다." };
  }
  return { taskId, pushRequired: argv.includes("--push") };
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`[self-dev-begin] ${parsed.error}`);
    process.exitCode = 1;
    return;
  }

  const result = writeSelfDevTaskContext(REPO_ROOT, parsed);
  if (isTaskContextError(result)) {
    console.error(`[self-dev-begin] ${result.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `[self-dev-begin] context 선언됨: taskId=${result.taskId} pushRequired=${result.pushRequired} ` +
      `baseHeadHash=${result.baseHeadHash}`
  );
  console.log(
    "[self-dev-begin] 이후 이 저장소에서 " +
      (result.pushRequired ? "git push" : "git commit") +
      "가 성공하면 PostToolUse hook이 self-dev:complete를 자동으로 호출합니다 — 별도로 직접 실행하지 마세요."
  );
}

main();
