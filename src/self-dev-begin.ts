import { join } from "node:path";
import { writeSelfDevTaskContext, isTaskContextError } from "./self-dev-task-context";

// Self-Dev Task Begin — Phase G Task G7.3.1b.
//
// task-complete Skill의 completion 절차를 시작하기 직전(typecheck/build를 통과한 뒤, commit
// 전) Claude가 실행하는 한 줄짜리 명시적 선언이다:
//
//   npm run self-dev:begin -- --task-id <TaskId> [--push] [--final]
//
// 이 명령은 "이 Task가 완료됐다"고 주장하지 않는다 — self-dev:complete(또는 그걸 자동
// 호출하는 PostToolUse hook, § self-dev-completion-hook.ts)가 이후 실제로 commit/push된
// 상태를 대상으로 typecheck/build/전체 회귀/push를 처음부터 다시 검증한 뒤에만
// TASK_COMPLETED가 만들어진다. 이 명령이 하는 일은 오직 "지금부터 이어지는 commit(+push)이
// 어떤 taskId에 대응하는가"를 self-dev-task-context.ts에 로컬로만(§ 파일, gitignored)
// 남기는 것뿐이다 — hook이 나중에 taskId를 추측하지 않아도 되게 하기 위함이다.
//
// Phase G Task G7.5 — --final은 "이 Task가 하위 Task(🟡)가 아니라 상위 Task/Phase의
// 진짜 최종 완료(✅)"라는 명시적 선언이다(§ self-dev-completion.ts
// SelfDevCompletionEvidence.isFinal, notification.ts FINAL_COMPLETED). 이 선언은 hook이
// 나중에 self-dev-complete.ts를 자동 호출할 때 그대로 전달될 뿐(§
// self-dev-completion-hook.ts) — 여전히 그 스크립트의 typecheck/build/전체 회귀/commit/
// (필요시)push 재검증을 전부 통과해야만 실제로 TASK_COMPLETED가 만들어진다. 지정하지
// 않으면(기본값) 항상 🟡 하위 Task 완료로만 알린다 — "세션이 끝났으니 최종 완료"처럼
// 추측하지 않는다.

const REPO_ROOT = join(__dirname, "..");

interface CliArgs {
  taskId: string;
  pushRequired: boolean;
  isFinal: boolean;
}

function parseArgs(argv: string[]): CliArgs | { error: string } {
  const idx = argv.indexOf("--task-id");
  const taskId = idx !== -1 ? argv[idx + 1] : undefined;
  if (!taskId || taskId.startsWith("--")) {
    return { error: "--task-id <id>가 필요합니다." };
  }
  return { taskId, pushRequired: argv.includes("--push"), isFinal: argv.includes("--final") };
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
      `isFinal=${result.isFinal} baseHeadHash=${result.baseHeadHash}`
  );
  console.log(
    "[self-dev-begin] 이후 이 저장소에서 " +
      (result.pushRequired ? "git push" : "git commit") +
      "가 성공하면 PostToolUse hook이 self-dev:complete를 자동으로 호출합니다 — 별도로 직접 실행하지 마세요."
  );
}

main();
