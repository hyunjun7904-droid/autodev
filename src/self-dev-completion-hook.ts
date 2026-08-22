import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { isTaskContextError, readSelfDevTaskContext, clearSelfDevTaskContext } from "./self-dev-task-context";

// Self-Dev Completion Bridge — 자동 트리거 판정(Phase G Task G7.3.1b, Self-Dev Completion
// Workflow Auto Trigger Fix).
//
// 이 파일은 Claude Code PostToolUse hook(.claude/hooks/self-dev-completion-hook.js, 그
// hook을 배선하는 .claude/settings.json)이 호출하는 판정/실행 로직이다. 이 파일 자체는
// "TASK_COMPLETED를 만들지 말지"를 판정하지 않는다 — 그 판정은 여전히 전적으로
// self-dev-complete.ts(→ self-dev-completion.ts의 deterministic fail-closed 재검증)가
// 한다. 이 파일이 하는 일은 딱 하나, "방금 실행된 Bash 명령이 self-dev-complete를
// 자동으로 호출해야 하는 시점인가"만 판정하고, 그렇다면 그 스크립트를 대신 호출하는
// 것뿐이다(§ 요구사항 6 — hook은 "completion workflow가 아직 수행되지 않았는지 확인"
// 같은 보조 역할만 한다).
//
// taskId는 self-dev-task-context.ts에 Claude가 명시적으로 선언해둔 값만 쓴다(추측 금지).
// 선언이 없거나 깨졌으면 트리거하지 않는다(fail-closed) — 이 판정 자체가
// "TASK_COMPLETED 생성 금지" 조건 중 하나("Task ID가 확실하지 않으면")를 구조적으로
// 만족시킨다.

const GIT_PUSH_PATTERN = /(^|[;&|]|\n)\s*git\s+push\b/;
const GIT_COMMIT_PATTERN = /(^|[;&|]|\n)\s*git\s+commit\b/;

export interface HookDecisionInput {
  /** 방금 실행된 Bash tool_input.command 원문. */
  command: string;
  repoRoot: string;
}

export type HookDecision =
  | { trigger: false; reason: string }
  | { trigger: true; taskId: string; pushRequired: boolean; reason: string };

/**
 * 순수 판정 함수 — git/파일 시스템을 읽기만 하고(HEAD 조회, context 파일 읽기) 아무 것도
 * 실행/기록하지 않는다. self-dev-complete.ts를 실제로 호출할지는 runSelfDevCompletionHook가
 * 이 결과를 보고 결정한다.
 */
export function decideSelfDevCompletionTrigger(input: HookDecisionInput): HookDecision {
  const isPush = GIT_PUSH_PATTERN.test(input.command);
  const isCommit = GIT_COMMIT_PATTERN.test(input.command);
  if (!isPush && !isCommit) {
    return { trigger: false, reason: "git push/commit 명령이 아닙니다." };
  }

  const context = readSelfDevTaskContext(input.repoRoot);
  if (context === undefined) {
    return {
      trigger: false,
      reason: "self-dev task context가 선언되지 않았습니다(npm run self-dev:begin 미실행) — 자동 트리거하지 않습니다.",
    };
  }
  if (isTaskContextError(context)) {
    return { trigger: false, reason: `self-dev task context가 유효하지 않습니다: ${context.error}` };
  }

  if (context.pushRequired && !isPush) {
    return { trigger: false, reason: "이 Task는 push가 필요합니다 — commit만으로는 아직 트리거하지 않고 push를 기다립니다." };
  }
  if (!context.pushRequired && !isCommit) {
    return { trigger: false, reason: "이 Task는 push가 필요하지 않습니다 — commit 시점에 트리거되며, push 단독으로는 트리거하지 않습니다." };
  }

  // context.baseHeadHash(선언 시점 HEAD)를 여기서 currentHead와 비교해 "선언 이후 새
  // commit이 없으면 stale"로 거부하지 않는다 — 그렇게 하면 self-dev:begin을 commit *직후*,
  // push *직전*에 실행하는 것도(§ SKILL.md step 5가 요구하는 순서보다 한 박자 늦게 선언한
  // 경우) 매번 오탐으로 막히게 된다: 이 경우 currentHead === baseHeadHash가 정상이고,
  // 여전히 유효한 완료 선언이다. baseHeadHash는 감사/진단용 메타데이터로만 남긴다.
  // "선언이 실제로 이 push/commit에 대응하는가"는 이미 위에서 pushRequired 일치 여부로
  // 걸러졌고, 최종적으로는 self-dev-complete.ts의 deterministic 재검증(commit/push가 실제로
  // 반영됐는지까지 포함)이 완료 여부를 판정하므로 여기서 추가 추측을 하지 않는다.

  return { trigger: true, taskId: context.taskId, pushRequired: context.pushRequired, reason: "completion workflow 트리거 조건을 충족했습니다." };
}

export interface CommandOutcome {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[], cwd: string) => CommandOutcome;

// self-dev-complete.ts와 동일한 이유로 "npm run ..."을 거치지 않는다 — npm은 Windows에서
// .cmd shim이라 shell:false spawnSync로 직접 실행하면 ENOENT/EINVAL이 실측됐다(§
// self-dev-complete.ts 상단 주석). 대신 이미 빌드된 dist/self-dev-complete.js를 node로
// 직접 실행한다 — self-dev-complete.ts 자신의 runDeterministicCompletionChecks()가
// typecheck/build/전체 회귀를 그 안에서 다시 수행하므로, 여기서 별도로 "npm run build"를
// 먼저 실행할 필요가 없다(중복 build 방지).
export const realCommandRunner: CommandRunner = (command, args, cwd) => {
  const res = spawnSync(command, args, { cwd, shell: false, encoding: "utf-8" });
  return { ok: res.status === 0, code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

export interface HookRunResult {
  /** self-dev-complete를 실제로 호출했는지 여부. false면 이 Bash 호출은 완전히 무관했다는
   *  뜻이다(대부분의 호출 — hook이 조용히 종료해야 하는 정상 경로). */
  triggered: boolean;
  ok: boolean;
  message: string;
}

/**
 * 판정 후, 트리거 조건을 충족했다면 dist/self-dev-complete.js를 실제로 호출한다. 완료
 * evidence 검증/기록/알림 전달은 전부 self-dev-complete.ts(→ self-dev-completion.ts)가
 * 그대로 재검증한다 — 이 함수는 그 결과(exit code)만 보고 context를 소비할지 결정한다.
 */
export function runSelfDevCompletionHook(input: HookDecisionInput, runner: CommandRunner = realCommandRunner): HookRunResult {
  const decision = decideSelfDevCompletionTrigger(input);
  if (!decision.trigger) {
    return { triggered: false, ok: true, message: decision.reason };
  }

  const entry = join(input.repoRoot, "dist", "self-dev-complete.js");
  if (!existsSync(entry)) {
    return {
      triggered: true,
      ok: false,
      message: `dist/self-dev-complete.js가 없습니다(빌드 필요) — taskId=${decision.taskId} 자동 완료를 시도하지 못했습니다. context는 유지됩니다(재시도 가능).`,
    };
  }

  const args = [entry, "--task-id", decision.taskId, ...(decision.pushRequired ? ["--push"] : [])];
  const result = runner(process.execPath, args, input.repoRoot);

  if (result.ok) {
    clearSelfDevTaskContext(input.repoRoot);
    return {
      triggered: true,
      ok: true,
      message: `self-dev completion bridge 성공(taskId=${decision.taskId}). ${summarize(result.stdout)}`,
    };
  }
  return {
    triggered: true,
    ok: false,
    message:
      `self-dev completion bridge가 완료 조건을 충족하지 못했습니다(taskId=${decision.taskId}) — TASK_COMPLETED를 만들지 않았습니다. ` +
      `context는 유지됩니다(문제를 고친 뒤 같은 taskId로 다시 push하면 재시도됩니다). ${summarize(result.stdout || result.stderr)}`,
  };
}

function summarize(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  return trimmed.length > 1500 ? `${trimmed.slice(0, 1500)}…(생략)` : trimmed;
}
