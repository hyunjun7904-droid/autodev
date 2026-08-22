import "dotenv/config";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { selectDefaultEventStore } from "./event-store";
import { loadProjectAdapter } from "./project-adapter-loader";
import { getCurrentHeadHash } from "./git-changes";
import { DEFAULT_REMOTE_NAME } from "./remote-git-safety";
import {
  validateSelfDevCompletionEvidence,
  recordSelfDevTaskCompleted,
  deliverSelfDevCompletionNotification,
} from "./self-dev-completion";

// Self-Dev Task Completion Bridge — 자동 경로(Phase G Task G7.2.1).
//
// notify-task-completed.ts(사람이 명시적으로 실행하는 CLI)는 호출자가 --tests-passed/
// --typecheck-passed/--build-passed/--commit 같은 flag로 "이미 확인했다"고 주장하는 것을
// 그대로 신뢰한다. 이 파일은 그 신뢰를 없앤다 — Claude Code의 canonical task-complete
// 절차(§ .claude/skills/task-complete/SKILL.md) 마지막 단계에서 이 스크립트 하나만
// 호출하면, 이 스크립트가 이 저장소를 대상으로 typecheck/build/전체 회귀(모든 test:*
// 스크립트)를 직접 재실행하고, git으로 HEAD commit hash와(요청 시) push 여부를 직접
// 확인한 뒤에만 self-dev-completion.ts의 동일한 canonical validate/record 함수를 통해
// TASK_COMPLETED를 기록한다. 호출자가 taskId(필수)와 --push(이 Task가 push까지
// 요구했는지) 외에는 아무 것도 "주장"할 수 없다 — 나머지는 전부 이 스크립트가 직접
// 재확인한 사실이다("Prompt omission is NOT permission relaxation" — 프롬프트에 아무
// 지시가 없어도 검증 강도가 약해지지 않는다).
//
// "Claude Code 세션 종료(Stop hook)= Task 완료"가 아니다 — 이 스크립트는 Stop hook에
// 연결돼 있지 않다. task-complete Skill이 검증/commit/(필요시)push를 모두 마친 뒤 마지막
// 단계로만 이 스크립트를 명시적으로 호출한다(§ SKILL.md). 설령 그 순서를 어기고 이
// 스크립트가 일찍 호출되더라도, typecheck/build/전체 회귀를 이 스크립트가 직접
// 재실행하므로 실패 상태에서는 구조적으로 TASK_COMPLETED를 만들 수 없다(fail-closed).
//
// 이 스크립트는 Bot Token/Chat ID를 전혀 다루지 않는다 — self-dev-completion.ts의
// deliverSelfDevCompletionNotification()이 기존 telegram-controller-supervisor.ts로만
// 전달을 위임한다.
//
// AUTOMATION_DRY_RUN="false"는 의도적으로 모듈 top-level이 아니라 main()에서
// runDeterministicCompletionChecks() 이후(§ 아래)에만 설정한다 — realCommandRunner의
// spawnSync는 env를 명시하지 않으면 현재 process.env를 그대로 자식 프로세스에 물려준다.
// 이 값을 top-level에서 먼저 설정해두면, 전체 회귀(각 test:*.js)가 자식 프로세스로 실행될
// 때 이 값을 그대로 물려받아 orchestrator.ts/agent-orchestrator.ts의 real/fake runner
// 선택이 real로 바뀌어버린다 — 실측된 문제: 이 순서 오류로 gpt-retry-tests.js의 시나리오가
// 실제 `claude` CLI를 호출해 Safe Executor 미설정 예외로 죽었다("실제 Claude Developer/
// OpenAI GPT 호출 금지" 요구사항 위반). 이 값은 오직 이후 단계(EventStore/
// NotificationStore가 실제 파일 기반이어야 하는 시점)에만 필요하므로, 그 시점 이후로
// 미룬다.
const REPO_ROOT = join(__dirname, "..");
const TSC_BIN = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");

interface CliArgs {
  taskId: string;
  pushRequired: boolean;
  adapterPath?: string;
}

function parseArgs(argv: string[]): CliArgs | { error: string } {
  const idx = argv.indexOf("--task-id");
  const taskId = idx !== -1 ? argv[idx + 1] : undefined;
  if (!taskId || taskId.startsWith("--")) {
    return { error: "--task-id <id>가 필요합니다." };
  }
  const pushRequired = argv.includes("--push");
  const projIdx = argv.indexOf("--project");
  const adapterPath =
    projIdx !== -1 && typeof argv[projIdx + 1] === "string" && argv[projIdx + 1].length > 0
      ? argv[projIdx + 1]
      : process.env.AUTODEV_PROJECT_ADAPTER && process.env.AUTODEV_PROJECT_ADAPTER.trim().length > 0
        ? process.env.AUTODEV_PROJECT_ADAPTER
        : undefined;
  return { taskId, pushRequired, adapterPath };
}

export interface CommandOutcome {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * spawnSync 래퍼 seam — dependency-scanner.ts의 VulnerabilityAuditSource와 동일한
 * injectable pattern이다. 테스트는 이 함수를 fake로 주입해 실제 typecheck/build/전체
 * 회귀/git을 실행하지 않고도 판정 로직(runDeterministicCompletionChecks)을 검증한다.
 * 실 운용 기본값(realCommandRunner)만 실제 child process를 띄운다. npm/npx는 Windows에서
 * .cmd shim이라 shell:false로 직접 spawn할 수 없다(ENOENT/EINVAL로 실측 확인됨) — 그래서
 * "npm run build"/"npx tsc --noEmit" 대신 로컬 node_modules/typescript/bin/tsc를 node로
 * 직접 실행하고(TSC_BIN), test 스크립트도 "node dist/xxx.js"를 node 실행파일로 직접
 * 실행한다 — 셸을 거치지 않으므로 인자 이스케이프/셸 injection 위험이 없다.
 */
export type CommandRunner = (command: string, args: string[], cwd: string) => CommandOutcome;

// 2026-08-22 incident — 이 함수가 전체 회귀(각 test:*.js)를 자식 프로세스로 spawn하는
// 유일한 지점이다. spawnSync는 env를 명시하지 않으면 현재 process.env를 자식에게 그대로
// 물려준다 — 그래서 이 프로세스가 나중에 AUTOMATION_DRY_RUN/AUTODEV_PRODUCTION_RUNTIME을
// "production" 값으로 바꾸거나, 이 Windows 환경변수에 실제 AUTODEV_TELEGRAM_BOT_TOKEN/
// CHAT_ID가 영구적으로 존재하더라도, 그 값들이 test 자식 프로세스로 새어 들어가면
// production 파일 store 선택/실제 Telegram 배달이 test/fixture event에 대해서까지
// 트리거될 수 있다(실측된 사고 — F1/T1.1/P1.2/R1 fixture taskId가 실제 채널로 배달됨).
// runtime-origin.ts의 dual-gate(순서 재배치)가 근본 원인을 막지만, 이 목록은 그와
// 무관하게 자식 프로세스 경계 자체에서 한 번 더 방어한다(2중 방어) — 이 목록에 없는
// 값은 그대로 상속된다(빌드/테스트에 필요한 PATH 등은 그대로 전달됨).
const CHILD_PROCESS_ENV_DENYLIST: readonly string[] = [
  "AUTOMATION_DRY_RUN",
  "AUTODEV_PRODUCTION_RUNTIME",
  "AUTODEV_TELEGRAM_BOT_TOKEN",
  "AUTODEV_TELEGRAM_CHAT_ID",
  "AUTODEV_TELEGRAM_USER_ID",
];

function sanitizedChildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of CHILD_PROCESS_ENV_DENYLIST) delete env[key];
  return env;
}

export const realCommandRunner: CommandRunner = (command, args, cwd) => {
  const res = spawnSync(command, args, { cwd, shell: false, encoding: "utf-8", env: sanitizedChildEnv() });
  return { ok: res.status === 0, code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

interface RegressionScript {
  name: string;
  distFile: string;
}

/**
 * package.json의 "test:" 접두사 스크립트만 전체 회귀 대상으로 선택한다 — smoke-test류
 * (test: 접두사가 없는 별도 스크립트, § .claude/CLAUDE.md)는 이미 이 이름 관례로
 * 자동으로 제외된다. 각 스크립트 문자열에서 "node dist/xxx.js" 부분만 정규식으로
 * 추출한다("npm run build && node dist/xxx-tests.js" 형태 — build는 이 스크립트가 별도
 * 단계에서 한 번만 수행하므로 여기서는 무시한다).
 */
export function listFullRegressionScripts(repoRoot: string): RegressionScript[] {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  const out: RegressionScript[] = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    if (!name.startsWith("test:")) continue;
    const match = /node\s+(dist\/[\w./-]+\.js)/.exec(cmd);
    if (!match) continue;
    out.push({ name, distFile: match[1] });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface DeterministicCheckResult {
  ok: boolean;
  typecheckPassed: boolean;
  buildPassed: boolean;
  testsPassed: boolean;
  failedTests: string[];
  commitHash?: string;
  pushPassed: boolean;
  reasons: string[];
}

/**
 * 이 저장소를 대상으로 typecheck/build/전체 회귀를 직접 재실행하고, git으로 HEAD commit과
 * (pushRequired일 때만) push 여부를 직접 확인한다 — 호출자가 주장하는 값을 신뢰하지 않는다.
 * 하나라도 실패하면 ok:false이고 reasons에 구체적인 사유가 남는다(추측 없음).
 */
export function runDeterministicCompletionChecks(
  repoRoot: string,
  pushRequired: boolean,
  runner: CommandRunner = realCommandRunner
): DeterministicCheckResult {
  const reasons: string[] = [];

  // merge/rebase 진행 중이면 working tree 상태를 신뢰할 수 없다 — 안전 정책상 즉시 거부한다.
  const midOperation =
    existsSync(join(repoRoot, ".git", "MERGE_HEAD")) ||
    existsSync(join(repoRoot, ".git", "rebase-merge")) ||
    existsSync(join(repoRoot, ".git", "rebase-apply")) ||
    existsSync(join(repoRoot, ".git", "CHERRY_PICK_HEAD"));
  if (midOperation) {
    reasons.push("working tree가 merge/rebase/cherry-pick 진행 중입니다 — 완료로 판정하지 않습니다.");
    return { ok: false, typecheckPassed: false, buildPassed: false, testsPassed: false, failedTests: [], pushPassed: false, reasons };
  }

  const typecheck = runner(process.execPath, [TSC_BIN, "--noEmit"], repoRoot);
  if (!typecheck.ok) reasons.push(`typecheck 실패(npx tsc --noEmit, exit ${typecheck.code}).`);

  const build = runner(process.execPath, [TSC_BIN], repoRoot);
  if (!build.ok) reasons.push(`build 실패(npm run build, exit ${build.code}).`);

  const failedTests: string[] = [];
  let testsPassed = false;
  if (build.ok) {
    const scripts = listFullRegressionScripts(repoRoot);
    if (scripts.length === 0) {
      reasons.push("실행할 전체 회귀 test:* 스크립트를 찾지 못했습니다.");
    } else {
      for (const s of scripts) {
        const distPath = join(repoRoot, s.distFile);
        if (!existsSync(distPath)) {
          failedTests.push(`${s.name} (빌드 산출물 없음: ${s.distFile})`);
          continue;
        }
        const result = runner(process.execPath, [distPath], repoRoot);
        if (!result.ok) failedTests.push(s.name);
      }
      testsPassed = failedTests.length === 0;
      if (!testsPassed) reasons.push(`전체 회귀 실패: ${failedTests.join(", ")}`);
    }
  } else {
    reasons.push("build가 실패해 전체 회귀를 실행하지 않았습니다.");
  }

  const commitHash = getCurrentHeadHash(repoRoot);
  if (!commitHash) reasons.push("git HEAD commit hash를 확인할 수 없습니다.");

  // Phase G Task G7.3(GitHub Sync & Remote Repository Safety) 이전에는 push 검증이 fetch를
  // 하지 않았다("GitHub Sync는 범위 밖") — 로컬 remote-tracking ref(@{u})가 실제로는 오래된
  // 값이어도(예: 이 push 이후 다른 clone/PC가 같은 branch에 추가로 push했는데 이 로컬은 아직
  // 그 사실을 모르는 경우) "push가 반영됐다"로 잘못 판정할 여지가 있었다. 이제는 비교 전에
  // 실제 fetch를 한 번 수행한다 — fetch는 read-only(remote-tracking ref만 갱신, working
  // tree는 건드리지 않음, § remote-git-safety.ts safeFetchRemote와 동일한 원칙)이므로 이
  // 재검증 자체가 새로운 위험을 만들지 않는다. fetch가 실패하면(network 장애 등) 그것을
  // "반영 안 됨"으로 조용히 넘기지 않고 별도 사유로 명시한다(fail-closed).
  let pushPassed = !pushRequired;
  if (pushRequired) {
    const fetch = runner("git", ["fetch", "--prune", "--", DEFAULT_REMOTE_NAME], repoRoot);
    if (!fetch.ok) {
      reasons.push(`remote(${DEFAULT_REMOTE_NAME}) fetch에 실패했습니다 — push 반영 여부를 신뢰할 수 있게 검증할 수 없습니다.`);
    } else {
      const upstream = runner("git", ["rev-parse", "@{u}"], repoRoot);
      if (!upstream.ok) {
        reasons.push("upstream tracking branch(@{u})를 확인할 수 없습니다 — push 여부를 검증할 수 없습니다.");
      } else {
        const upstreamHash = upstream.stdout.trim();
        if (commitHash && upstreamHash === commitHash) {
          pushPassed = true;
        } else {
          reasons.push(`HEAD(${commitHash ?? "?"})가 upstream(${upstreamHash})과 다릅니다 — push가 아직 반영되지 않은 것으로 보입니다.`);
        }
      }
    }
  }

  const ok = typecheck.ok && build.ok && testsPassed && Boolean(commitHash) && pushPassed && reasons.length === 0;
  return {
    ok,
    typecheckPassed: typecheck.ok,
    buildPassed: build.ok,
    testsPassed,
    failedTests,
    commitHash,
    pushPassed,
    reasons,
  };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`[self-dev-complete] ${parsed.error}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `[self-dev-complete] Task ${parsed.taskId} 완료 조건을 이 저장소에서 직접 재검증합니다 ` +
      `(typecheck/build/전체 회귀/commit${parsed.pushRequired ? "/push" : ""})...`
  );

  const checks = runDeterministicCompletionChecks(REPO_ROOT, parsed.pushRequired);
  if (!checks.ok) {
    console.error("[self-dev-complete] 완료 조건을 충족하지 못했습니다 — TASK_COMPLETED event를 만들지 않습니다.");
    for (const r of checks.reasons) console.error(`  - ${r}`);
    process.exitCode = 1;
    return;
  }

  const evidence = validateSelfDevCompletionEvidence({
    taskId: parsed.taskId,
    commitHash: checks.commitHash,
    testsPassed: checks.testsPassed,
    typecheckPassed: checks.typecheckPassed,
    buildPassed: checks.buildPassed,
    pushRequired: parsed.pushRequired,
    pushPassed: checks.pushPassed,
    source: "claude-code-self-dev-bridge",
  });
  if ("error" in evidence) {
    console.error(`[self-dev-complete] ${evidence.error}`);
    process.exitCode = 1;
    return;
  }

  // 이 시점부터는 더 이상 전체 회귀를 자식 프로세스로 spawn하지 않는다 — 이제부터
  // production EventStore/NotificationStore(파일 기반)를 실제로 써야 하므로 여기서만
  // 설정한다(§ 파일 상단 주석 — 순서를 앞당기면 안 되는 이유). AUTODEV_PRODUCTION_RUNTIME도
  // 함께 설정한다 — runtime-origin.ts의 isProductionRuntime()은 두 값이 모두 명시적으로
  // 참일 때만 실제 파일 store/Telegram credential을 활성화한다(2026-08-22 incident 이후
  // dual-gate로 강화됨, § runtime-origin.ts).
  process.env.AUTOMATION_DRY_RUN = "false";
  process.env.AUTODEV_PRODUCTION_RUNTIME = "true";

  const manifest = loadProjectAdapter(parsed.adapterPath);
  const events = selectDefaultEventStore();
  const result = recordSelfDevTaskCompleted(events, evidence);
  if (!result.ok) {
    console.error(`[self-dev-complete] TASK_COMPLETED event 기록 실패: ${result.error ?? "unknown"}`);
    process.exitCode = 1;
    return;
  }
  if (result.alreadyRecorded) {
    console.log(
      `[self-dev-complete] 이미 기록된 완료입니다(taskId=${evidence.taskId}, commit=${evidence.commitHash}) — ` +
        `중복 event/알림 없이 종료합니다.`
    );
  } else {
    console.log(`[self-dev-complete] TASK_COMPLETED 기록됨 taskId=${evidence.taskId} runId=${result.runId} commit=${evidence.commitHash}`);
  }

  const { delivered } = await deliverSelfDevCompletionNotification(manifest);
  if (!delivered) {
    console.log("[self-dev-complete] controller가 이번 event를 아직 전달하지 못했을 수 있습니다(dedupe되어 있으니 중복 전송은 없습니다).");
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[self-dev-complete] 처리되지 않은 오류로 종료:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
