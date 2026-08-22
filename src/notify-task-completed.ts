import "dotenv/config";
import { randomUUID } from "node:crypto";
import { selectDefaultEventStore } from "./event-store";
import { ensureTelegramControllerStarted } from "./telegram-controller-supervisor";
import { loadProjectAdapter } from "./project-adapter-loader";
import { log } from "./logger";

// AutoDev 자체 개발(self-dev) Task 완료 알림 — Phase G Task G7.2 추가 요구사항.
//
// AutoDev 저장소 자체를 Claude Code 세션으로 개발하는 동안(production AutoDev runtime을
// 실제로 돌리는 것과는 별개)에도, 이 저장소가 이미 갖춘 production notification 경로
// (EventStore → notification-service.ts → NotificationStore/dedupe →
// telegram-controller.ts → Telegram Provider)를 그대로 재사용해 Task 완료를 Telegram으로
// 받을 수 있게 하는 최소 additive 연결점이다. 새 Telegram 시스템/새 큐를 만들지 않는다 —
// 이 파일이 하는 일은 TASK_COMPLETED event 하나를 기존 EventStore에 append하고, 기존
// telegram-controller-supervisor.ts(run.ts와 동일한 canonical entry point)로 controller가
// 떠 있는지 확인/시작한 뒤, 그 event가 최소 한 번 전달 시도되도록 짧게 기다리는 것뿐이다.
//
// "Claude Code 세션 종료 = Task 완료"가 아니다 — 이 스크립트는 호출자가 아래 완료 기준을
// 모두 명시적으로 확인했다고 주장할 때만(각 플래그를 실제로 전달했을 때만) TASK_COMPLETED를
// 기록한다. 하나라도 빠지면 즉시 실패하고 아무 event도 만들지 않는다(추측/생략 금지):
//   --task-id <id>       완료된 Task 식별자(필수)
//   --commit <hash>      실제 git commit hash(필수 — "git commit 성공"의 증거)
//   --tests-passed       required tests 전체 PASS 확인(필수 플래그)
//   --typecheck-passed   `npx tsc --noEmit` PASS 확인(필수 플래그)
//   --build-passed       `npm run build` PASS 확인(필수 플래그)
//   --push               origin/main fast-forward push까지 요구되는 Task였다면 지정
//                         (지정하면 --push-passed도 함께 요구한다)
//   --push-passed        push 성공 확인(--push가 있을 때만 검사)
// FAILED/WAITING_HUMAN/BLOCKED/중간 checkpoint에는 이 스크립트를 쓰지 않는다 — 그런
// 상태에는 이미 같은 파이프라인에 연결된 기존 notification type(HUMAN_APPROVAL_REQUIRED/
// RUN_BLOCKED/SECURITY_BLOCKED 등, § notification.ts)이 있고, 그 event들은 이미
// autodev.ts/orchestrator.ts 같은 production 코드 경로에서만 기록된다 — 이 스크립트가
// 그 판정을 대신하지 않는다.
//
// controller가 이 event를 배달하려면 실제 file-backed EventStore/NotificationStore를 써야
// 한다 — start-autodev.ps1과 동일하게 이 스크립트는 AUTOMATION_DRY_RUN을 명시적으로
// "false"로 설정한다(이 값이 이미 다른 값으로 설정돼 있어도 이 스크립트 실행 중에는
// 덮어쓴다 — production 배달이 이 도구의 유일한 목적이기 때문이다).
//
// projectId는 의도적으로 대상 project manifest의 projectId(예: "movan")를 쓰지 않는다 —
// 이 event는 "AutoDev 저장소 자신의 개발"에 대한 사실이지 대상 project의 production
// 실행 사실이 아니다(§ 요구사항: AutoDev repo/MOVAN leakage 없음). manifest는 오직
// controller singleton을 시작하는 데 필요한 GitSafety/cwd 컨텍스트로만 쓰인다 —
// run.ts/telegram-controller-main.ts와 동일한 --project/AUTODEV_PROJECT_ADAPTER 해석을
// 그대로 재사용한다(entry point마다 다른 해석 로직을 만들지 않는다).

const SELF_DEV_PROJECT_ID = "autodev-core-self-dev";

process.env.AUTOMATION_DRY_RUN = "false";

interface ParsedArgs {
  taskId: string;
  commitHash: string;
  testsPassed: boolean;
  typecheckPassed: boolean;
  buildPassed: boolean;
  pushRequired: boolean;
  pushPassed: boolean;
  adapterPath?: string;
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(name);
}
function value(argv: string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const v = argv[idx + 1];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const taskId = value(argv, "--task-id");
  if (!taskId) return { error: "--task-id <id>가 필요합니다." };
  const commitHash = value(argv, "--commit");
  if (!commitHash) return { error: "--commit <hash>가 필요합니다(실제 git commit 성공의 증거)." };
  const testsPassed = flag(argv, "--tests-passed");
  if (!testsPassed) return { error: "--tests-passed가 필요합니다(required tests 전체 PASS 확인)." };
  const typecheckPassed = flag(argv, "--typecheck-passed");
  if (!typecheckPassed) return { error: "--typecheck-passed가 필요합니다(`npx tsc --noEmit` PASS 확인)." };
  const buildPassed = flag(argv, "--build-passed");
  if (!buildPassed) return { error: "--build-passed가 필요합니다(`npm run build` PASS 확인)." };
  const pushRequired = flag(argv, "--push");
  const pushPassed = flag(argv, "--push-passed");
  if (pushRequired && !pushPassed) return { error: "--push가 지정되었으면 --push-passed도 필요합니다(fast-forward push 성공 확인)." };

  const idx = argv.indexOf("--project");
  const adapterPath =
    idx !== -1 && typeof argv[idx + 1] === "string" && argv[idx + 1].length > 0
      ? argv[idx + 1]
      : process.env.AUTODEV_PROJECT_ADAPTER && process.env.AUTODEV_PROJECT_ADAPTER.trim().length > 0
        ? process.env.AUTODEV_PROJECT_ADAPTER
        : undefined;

  return { taskId, commitHash, testsPassed, typecheckPassed, buildPassed, pushRequired, pushPassed, adapterPath };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`[notify-task-completed] ${parsed.error}`);
    process.exitCode = 1;
    return;
  }

  const manifest = loadProjectAdapter(parsed.adapterPath);

  const runId = randomUUID();
  const events = selectDefaultEventStore();
  const appendResult = events.append({
    eventType: "TASK_COMPLETED",
    runId,
    projectId: SELF_DEV_PROJECT_ID,
    taskId: parsed.taskId,
    executionPhase: "state_update",
    outcome: "SUCCESS",
    metadata: {
      commitHash: parsed.commitHash,
      testsPassed: parsed.testsPassed,
      typecheckPassed: parsed.typecheckPassed,
      buildPassed: parsed.buildPassed,
      pushRequired: parsed.pushRequired,
      pushPassed: parsed.pushRequired ? parsed.pushPassed : null,
      source: "claude-code-self-dev",
    },
  });
  if (!appendResult.ok) {
    console.error(`[notify-task-completed] TASK_COMPLETED event 기록 실패: ${appendResult.error ?? "unknown"}`);
    process.exitCode = 1;
    return;
  }
  log("self-dev TASK_COMPLETED event 기록됨", { taskId: parsed.taskId, runId });
  console.log(`[notify-task-completed] TASK_COMPLETED 기록됨 taskId=${parsed.taskId} runId=${runId} commit=${parsed.commitHash}`);

  const supervisor = await ensureTelegramControllerStarted(manifest);
  const delivered = supervisor.isOwner() ? await supervisor.flushOnce() : true;
  if (!delivered) {
    console.log("[notify-task-completed] controller가 이번 event를 아직 전달하지 못했을 수 있습니다(다음 tick에서 재시도됩니다) — dedupe되어 있으니 중복 전송은 없습니다.");
  }
  await supervisor.stop();
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[notify-task-completed] 처리되지 않은 오류로 종료:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
