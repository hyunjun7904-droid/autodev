import "dotenv/config";
import { join } from "node:path";
import { selectDefaultEventStore } from "./event-store";
import { loadProjectAdapter } from "./project-adapter-loader";
import { readSelfDevTaskContext } from "./self-dev-task-context";
import { resolveSelfDevTerminalInput, isResolveSelfDevTerminalInputError, recordSelfDevTerminalStatus } from "./self-dev-terminal-status";
import { deliverSelfDevCompletionNotification } from "./self-dev-completion";

// Self-Dev WAITING_HUMAN Terminal Status Bridge — Phase G Task G7.3.2.
//
// `npm run self-dev:waiting-human -- --reason "<짧은 안전한 사유>"`
//
// Claude Code가 현재 self-dev Task에 사람의 선택/확인이 실제로 필요하지만, Telegram의
// 기존 승인 callback으로 자동 재개할 수 없다고(§ task-complete/SKILL.md, self-dev Claude
// Code 세션에는 production runAutodevOnce()의 실제 resumable action이 없음) 판정했을 때,
// 최종 보고 직전에 실행한다. 정보성 Telegram 알림 1건만 보낸다 — 승인 버튼은 절대
// 만들어지지 않는다(§ observability-event.ts SELF_DEV_WAITING_HUMAN, notification.ts,
// approval-service.ts의 명시적 제외).
//
// taskId는 self-dev-task-context.ts(G7.3.1b)에 이미 선언된 값만 쓴다(추측 금지) — context가
// 없거나 손상됐으면 event를 만들지 않는다(fail-closed). context는 소비하지 않는다(§
// self-dev-blocked.ts와 동일한 이유 — COMPLETED만 소비한다).

const REPO_ROOT = join(__dirname, "..");

interface CliArgs {
  reason: string;
  adapterPath?: string;
}

function parseArgs(argv: string[]): CliArgs | { error: string } {
  const idx = argv.indexOf("--reason");
  const reason = idx !== -1 ? argv[idx + 1] : undefined;
  if (reason === undefined || reason.startsWith("--")) {
    return { error: "--reason \"<짧은 안전한 사유>\"가 필요합니다." };
  }
  const projIdx = argv.indexOf("--project");
  const adapterPath =
    projIdx !== -1 && typeof argv[projIdx + 1] === "string" && argv[projIdx + 1].length > 0
      ? argv[projIdx + 1]
      : process.env.AUTODEV_PROJECT_ADAPTER && process.env.AUTODEV_PROJECT_ADAPTER.trim().length > 0
        ? process.env.AUTODEV_PROJECT_ADAPTER
        : undefined;
  return { reason, adapterPath };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`[self-dev-waiting-human] ${parsed.error}`);
    process.exitCode = 1;
    return;
  }

  const context = readSelfDevTaskContext(REPO_ROOT);
  const resolved = resolveSelfDevTerminalInput(context, parsed.reason);
  if (isResolveSelfDevTerminalInputError(resolved)) {
    console.error(`[self-dev-waiting-human] ${resolved.error}`);
    process.exitCode = 1;
    return;
  }
  const { taskId, reason } = resolved;

  process.env.AUTOMATION_DRY_RUN = "false";
  process.env.AUTODEV_PRODUCTION_RUNTIME = "true";

  const manifest = loadProjectAdapter(parsed.adapterPath);
  const events = selectDefaultEventStore();
  const result = recordSelfDevTerminalStatus(events, { taskId, terminalStatus: "WAITING_HUMAN", reason });
  if (!result.ok) {
    console.error(`[self-dev-waiting-human] WAITING_HUMAN event 기록 실패: ${result.error ?? "unknown"}`);
    process.exitCode = 1;
    return;
  }
  if (result.alreadyRecorded) {
    console.log(`[self-dev-waiting-human] 이미 기록된 동일 WAITING_HUMAN입니다(taskId=${taskId}) — 중복 event/알림 없이 종료합니다.`);
  } else {
    console.log(`[self-dev-waiting-human] WAITING_HUMAN 기록됨 taskId=${taskId} runId=${result.runId}`);
  }

  const { delivered } = await deliverSelfDevCompletionNotification(manifest);
  if (!delivered) {
    console.log("[self-dev-waiting-human] controller가 이번 event를 아직 전달하지 못했을 수 있습니다(dedupe되어 있으니 중복 전송은 없습니다).");
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[self-dev-waiting-human] 처리되지 않은 오류로 종료:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
