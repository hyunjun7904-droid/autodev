import "dotenv/config";
import { join } from "node:path";
import { selectDefaultEventStore } from "./event-store";
import { loadProjectAdapter } from "./project-adapter-loader";
import { readSelfDevTaskContext } from "./self-dev-task-context";
import { resolveSelfDevTerminalInput, isResolveSelfDevTerminalInputError, recordSelfDevTerminalStatus } from "./self-dev-terminal-status";
import { deliverSelfDevCompletionNotification } from "./self-dev-completion";

// Self-Dev BLOCKED Terminal Status Bridge — Phase G Task G7.3.2.
//
// `npm run self-dev:blocked -- --reason "<짧은 안전한 사유>"`
//
// Claude Code가 현재 self-dev Task를 더 이상 안전하게 자동 진행할 수 없다고(structural
// blocker/필요한 외부 설정 없음/Git safety 문제/scope·policy 위반/deterministic safety
// gate 차단 등, § task-complete/SKILL.md) 실제로 판정했을 때, 최종 보고 직전에 실행한다.
// 단순히 고칠 수 있는 test/build/typecheck 실패는 BLOCKED가 아니다 — 그런 경우는 문제를
// 고쳐서 계속 진행한다(§ 요구사항).
//
// taskId는 이 명령이 스스로 묻지 않는다 — self-dev-task-context.ts(G7.3.1b, `npm run
// self-dev:begin -- --task-id <id>`)에 이미 선언된 값만 쓴다(추측 금지). context가
// 없거나 손상됐으면 이 명령은 아무 event도 만들지 않고 실패한다(fail-closed) — 사람에게
// self-dev:begin을 먼저 실행하라고 알린다. terminal status 선언은 self-dev-task-
// context.ts의 context를 소비(삭제)하지 않는다 — COMPLETED만 그 context를 소비한다(§
// self-dev-complete.ts) — Task가 나중에 실제로 완료되면 여전히 그 completion 경로가
// 정상 동작해야 하기 때문이다.
//
// 실제 event 기록/알림 전달은 self-dev-terminal-status.ts(판정/기록의 단일 출처)와
// self-dev-completion.ts의 deliverSelfDevCompletionNotification()(controller singleton
// 시작/flush — COMPLETED 전용이 아니라 이미 범용 helper다, § 그 파일)만 재사용한다. 이
// 파일은 새 Telegram provider/controller/queue를 전혀 만들지 않는다.

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
    console.error(`[self-dev-blocked] ${parsed.error}`);
    process.exitCode = 1;
    return;
  }

  const context = readSelfDevTaskContext(REPO_ROOT);
  const resolved = resolveSelfDevTerminalInput(context, parsed.reason);
  if (isResolveSelfDevTerminalInputError(resolved)) {
    console.error(`[self-dev-blocked] ${resolved.error}`);
    process.exitCode = 1;
    return;
  }
  const { taskId, reason } = resolved;

  // self-dev-complete.ts와 동일한 이유로 여기서만 설정한다(§ 그 파일 상단 주석) — 검증을
  // 모두 통과한 뒤, EventStore/NotificationStore가 실제 파일 기반이어야 하는 시점 직전에만.
  process.env.AUTOMATION_DRY_RUN = "false";
  process.env.AUTODEV_PRODUCTION_RUNTIME = "true";

  const manifest = loadProjectAdapter(parsed.adapterPath);
  const events = selectDefaultEventStore();
  const result = recordSelfDevTerminalStatus(events, { taskId, terminalStatus: "BLOCKED", reason });
  if (!result.ok) {
    console.error(`[self-dev-blocked] BLOCKED event 기록 실패: ${result.error ?? "unknown"}`);
    process.exitCode = 1;
    return;
  }
  if (result.alreadyRecorded) {
    console.log(`[self-dev-blocked] 이미 기록된 동일 BLOCKED입니다(taskId=${taskId}) — 중복 event/알림 없이 종료합니다.`);
  } else {
    console.log(`[self-dev-blocked] BLOCKED 기록됨 taskId=${taskId} runId=${result.runId}`);
  }

  const { delivered } = await deliverSelfDevCompletionNotification(manifest);
  if (!delivered) {
    console.log("[self-dev-blocked] controller가 이번 event를 아직 전달하지 못했을 수 있습니다(dedupe되어 있으니 중복 전송은 없습니다).");
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[self-dev-blocked] 처리되지 않은 오류로 종료:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
