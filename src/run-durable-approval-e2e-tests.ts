import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { CoreState } from "./types";
import { CHECKPOINT_SCOPE_VIOLATION_REASON } from "./approval";
import { debugComputeLockFilePath, resolveCanonicalProjectPath, RUNTIME_LOCK_DIR } from "./project-lock";
import { resolveUsageLedgerFilePath, RUNTIME_USAGE_LEDGER_DIR } from "./usage-ledger";

// run.ts Production Entrypoint — Orphaned Genuine Human Gate Recovery Durability(2026-09-01,
// Production Wiring Defect 수정)의 실제 child-process E2E 회귀 테스트다.
//
// local-human-approval.ts/approval-store.ts의 함수 단위 테스트(orphaned-human-gate-tests.ts
// 시나리오 P, approval-store-tests.ts durability capability 시나리오)만으로는 "run.ts
// one-shot 진입점을 실제로 직접 실행했을 때도 이 invariant가 지켜지는가"를 증명하지 못한다
// (§ .claude/CLAUDE.md — 이 실제 defect는 함수가 아니라 run.ts의 store 선택 경로에서
// 재현됐다). 이 파일은 실제 컴파일된 `dist/run.js`를 실제 OS child process로 실행해
// 검증한다 — mock으로 COMPLETE 처리하지 않는다.
//
// 실제 Telegram/외부 API 호출은 절대 발생하지 않는다: AUTODEV_TELEGRAM_BOT_TOKEN/CHAT_ID를
// 두 시나리오 모두에서 명시적으로 unset한다(§ telegram-controller.ts — botToken이 없으면
// getTelegramUpdates()/notification provider 어느 쪽도 만들어지지 않는다, fetch 자체가
// 호출되지 않음). 실제 production logs/도 건드리지 않는다 — AUTODEV_APPROVAL_STORE_PATH/
// AUTODEV_EVENT_LOG_PATH/AUTODEV_TELEGRAM_CONTROLLER_RUNTIME_DIR(모두 run.ts가 이미
// 노출하는 override seam, § run.ts)를 이 테스트 전용 임시 디렉터리로 override한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
const RUN_JS = join(__dirname, "run.js");
const APPROVAL_STORE_JS = join(__dirname, "approval-store.js");

const FIXTURE_TASK_ID = "T1";
const GENUINE_SCOPE_VIOLATION_MARKER = (taskId: string, unexpected: string) =>
  `CHECKPOINT_BLOCKED(${taskId}): ${CHECKPOINT_SCOPE_VIOLATION_REASON} — unexpected: ${unexpected}`;

// § 핵심 log 문구(run.ts) — 이 정확한 부분 문자열로 durable 성공 주장 여부를 판별한다.
const SUCCESS_MARKER = "새 PENDING approval을 생성했습니다";
const BLOCKED_MARKER = "복구 차단(BLOCKED)";

function makeGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "run-durable-approval-e2e@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Run Durable Approval E2E"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function relFromTo(fromDir: string, toDir: string): string {
  return relative(fromDir, toDir).split(sep).join("/");
}

interface Fixture {
  root: string;
  adapterPath: string;
  approvalStorePath: string;
  eventLogPath: string;
  telegramRuntimeDir: string;
  projectId: string;
}

function buildFixture(prefix: string): Fixture {
  const root = makeGitRepo(`${prefix}-root-`);
  const configDir = mkdtempSync(join(tmpdir(), `${prefix}-cfg-`));
  tempDirs.push(configDir);
  const isolationDir = mkdtempSync(join(tmpdir(), `${prefix}-iso-`));
  tempDirs.push(isolationDir);

  const projectId = `fixture-run-durable-${randomUUID()}`;
  const state: CoreState = {
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "WAITING_HUMAN",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [GENUINE_SCOPE_VIOLATION_MARKER(FIXTURE_TASK_ID, "leftover.txt")],
    completedTasks: [],
    gitCheckpoint: "",
    currentPhase: 1,
  };
  writeFileSync(join(configDir, "project-state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf-8");

  const adapterPath = join(configDir, "manifest.json");
  writeFileSync(
    adapterPath,
    `${JSON.stringify(
      {
        projectId,
        projectName: projectId,
        targetProjectRoot: relFromTo(configDir, root),
        statePath: "project-state.json",
        taskRegistry: [
          {
            id: FIXTURE_TASK_ID,
            phase: 1,
            taskNumber: 1,
            title: "run durable approval e2e fixture task",
            prompt: "fixture",
            requiredTests: [],
            allowedPathPrefixes: ["src/"],
            prohibitedOperations: [],
          },
        ],
        developerInstructions: "fixture",
        reviewInstructions: "fixture",
        reviewScopeDirs: ["src/"],
        executionPolicy: { allowedReadPrefixes: ["src/"], allowedWritePrefixes: ["src/"], allowedCommands: [] },
      },
      null,
      2
    )}\n`,
    "utf-8"
  );

  return {
    root,
    adapterPath,
    approvalStorePath: join(isolationDir, "approvals.json"),
    eventLogPath: join(isolationDir, "events.jsonl"),
    telegramRuntimeDir: join(isolationDir, "telegram-runtime"),
    projectId,
  };
}

/** project-lock.ts/usage-ledger.ts는 production runtime 여부와 무관하게(또는 production
 *  runtime일 때만, ledger는) 실제 real logs/ 트리 아래에 이 fixture project 전용(canonical
 *  path/projectId로 격리된) 파일을 남길 수 있다 — 다른 실제 project와 절대 충돌하지 않지만,
 *  테스트 위생을 위해 직접 정리한다. */
function cleanupSharedRuntimeArtifacts(fixture: Fixture): void {
  try {
    const canonical = resolveCanonicalProjectPath(fixture.root);
    const lockPath = debugComputeLockFilePath(canonical, RUNTIME_LOCK_DIR);
    rmSync(lockPath, { force: true });
  } catch {
    /* 이미 없거나 계산 실패 — 정리 실패는 테스트 결과에 영향 없음. */
  }
  try {
    const resolved = resolveUsageLedgerFilePath(RUNTIME_USAGE_LEDGER_DIR, fixture.projectId);
    if (resolved.ok) rmSync(resolved.path, { force: true });
  } catch {
    /* 위와 동일. */
  }
}

function buildChildEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // 이 프로세스(테스트 러너) 자신의 실행 컨텍스트에서 우연히 물려받을 수 있는 값들 —
  // 자식 프로세스가 이 정확한 시나리오만 재현하도록 항상 명시적으로 지운다.
  for (const k of ["AUTODEV_SUPERVISOR_PID", "AUTODEV_SUPERVISOR_STARTED_AT_MS", "AUTODEV_PROJECT_ADAPTER", "AUTODEV_CONTINUOUS_RUN"]) {
    delete env[k];
  }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

interface ChildRunResult {
  stdout: string;
  stderr: string;
  matchedMarker: string | undefined;
  timedOut: boolean;
}

/** 실제 `node dist/run.js --project <adapterPath>`를 spawn하고, stdout에 markers 중 하나가
 *  나타나거나 timeoutMs가 지나면 그 즉시 child를 종료시키고 결과를 반환한다. WAITING_HUMAN
 *  동안 controller owner면 run.ts가 waitWhileWaitingHuman()으로 무기한 대기하므로(§ run.ts),
 *  recovery 로그가 찍힌 시점 이후에는 더 기다릴 이유가 없다 — 이 시점에 이미 durable
 *  write(파일 store라면 동기 write+rename)는 완료된 뒤다(§ local-human-approval.ts
 *  createPending → return → log 순서, 이 세션의 조사에서 코드로 확인됨). */
function runOneShotAndCaptureUntilMarker(
  fixture: Fixture,
  env: NodeJS.ProcessEnv,
  markers: string[],
  timeoutMs = 30_000
): Promise<ChildRunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUN_JS, "--project", fixture.adapterPath], { env });
    let stdout = "";
    let stderr = "";
    let resolved = false;

    const overallTimer = setTimeout(() => finish(undefined, true), timeoutMs);

    function finish(matchedMarker: string | undefined, timedOut: boolean): void {
      if (resolved) return;
      resolved = true;
      clearTimeout(overallTimer);
      try {
        child.kill();
      } catch {
        /* 이미 종료됨 */
      }
      const fallback = setTimeout(() => resolve({ stdout, stderr, matchedMarker, timedOut }), 5_000);
      child.once("close", () => {
        clearTimeout(fallback);
        resolve({ stdout, stderr, matchedMarker, timedOut });
      });
    }

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (resolved) return;
      const hit = markers.find((m) => stdout.includes(m));
      if (hit) finish(hit, false);
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", () => finish(undefined, false));
  });
}

// ---------------------------------------------------------------------------
// E2E-1) production runtime 환경변수 미설정 + 실제 genuine WAITING_HUMAN → 실제
//        `node dist/run.js` 프로세스가 durable 성공을 절대 주장하지 않고, 실제로 아무 파일도
//        만들지 않는다(fail-closed, § 핵심 invariant).
// ---------------------------------------------------------------------------
async function scenarioEnvUnsetRefusesDurableSuccessClaim(): Promise<void> {
  const fixture = buildFixture("run-durable-unset");
  const env = buildChildEnv({
    AUTOMATION_DRY_RUN: undefined,
    AUTODEV_PRODUCTION_RUNTIME: undefined,
    AUTODEV_TELEGRAM_BOT_TOKEN: undefined,
    AUTODEV_TELEGRAM_CHAT_ID: undefined,
    AUTODEV_APPROVAL_STORE_PATH: fixture.approvalStorePath,
    AUTODEV_EVENT_LOG_PATH: fixture.eventLogPath,
    AUTODEV_TELEGRAM_CONTROLLER_RUNTIME_DIR: fixture.telegramRuntimeDir,
  });

  try {
    const { stdout, matchedMarker, timedOut } = await runOneShotAndCaptureUntilMarker(fixture, env, [SUCCESS_MARKER, BLOCKED_MARKER]);
    check("E2E-1) production env 미설정 상태로 실제 child process가 recovery 분기에 도달함(timeout 아님)", !timedOut);
    check("E2E-1) durable 성공 문구를 절대 출력하지 않음", !stdout.includes(SUCCESS_MARKER));
    check("E2E-1) 대신 명시적 BLOCKED 문구를 출력함(fail-closed, 승인 가능 상태로 오인시키지 않음)", matchedMarker === BLOCKED_MARKER);
    check(
      "E2E-1) process 종료 후에도 approvals.json은 실제로 한 번도 만들어지지 않음(가짜 durable approval 없음)",
      !existsSync(fixture.approvalStorePath)
    );
  } finally {
    cleanupSharedRuntimeArtifacts(fixture);
  }
}

// ---------------------------------------------------------------------------
// E2E-2) 정상 production wrapper 조건(AUTOMATION_DRY_RUN=false, AUTODEV_PRODUCTION_RUNTIME=
//        true) — 실제 file-backed ApprovalStore로 durable하게 저장되고, 그 사실만 로그에
//        정직하게 반영되며, 완전히 새로운 별도 process에서 다시 열어도 존재를 확인할 수 있다
//        (§ 요구사항 6.C/D/E, 정상 production wrapper 회귀 § 요구사항 5).
// ---------------------------------------------------------------------------
async function scenarioProductionEnvPersistsDurablyAndLogsHonestly(): Promise<void> {
  const fixture = buildFixture("run-durable-prod");
  const env = buildChildEnv({
    AUTOMATION_DRY_RUN: "false",
    AUTODEV_PRODUCTION_RUNTIME: "true",
    // 이 머신에 실제 Telegram credential이 영구 환경변수로 남아있어도(§ runtime-origin.ts
    // 상단 주석 — 2026-08-22 incident) 이 테스트는 명시적으로 unset해 실제 API 호출 경로
    // 자체를 차단한다(§ telegram-controller.ts — botToken 없으면 fetch가 전혀 일어나지 않음).
    AUTODEV_TELEGRAM_BOT_TOKEN: undefined,
    AUTODEV_TELEGRAM_CHAT_ID: undefined,
    AUTODEV_APPROVAL_STORE_PATH: fixture.approvalStorePath,
    AUTODEV_EVENT_LOG_PATH: fixture.eventLogPath,
    AUTODEV_TELEGRAM_CONTROLLER_RUNTIME_DIR: fixture.telegramRuntimeDir,
  });

  try {
    const { stdout, matchedMarker, timedOut } = await runOneShotAndCaptureUntilMarker(fixture, env, [SUCCESS_MARKER, BLOCKED_MARKER]);
    check("E2E-2) production env(true/true) 상태로 실제 child process가 recovery 분기에 도달함(timeout 아님)", !timedOut);
    check("E2E-2) durable 성공 로그를 실제로 출력함", matchedMarker === SUCCESS_MARKER);
    check("E2E-2) fail-closed BLOCKED 문구는 출력되지 않음(정상 production 경로 회귀 없음)", !stdout.includes(BLOCKED_MARKER));

    // 완전히 새로운 별도 process에서 같은 파일을 다시 연다(§ 요구사항 — process 종료 후 새
    // process가 logs/approvals.json을 다시 열어 approval이 실제 존재함을 확인).
    const verify = spawnSync(
      process.execPath,
      [
        "-e",
        `const { createFileApprovalStore } = require(${JSON.stringify(APPROVAL_STORE_JS)});
const store = createFileApprovalStore(${JSON.stringify(fixture.approvalStorePath)});
const records = store.list({ projectId: ${JSON.stringify(fixture.projectId)}, taskId: ${JSON.stringify(FIXTURE_TASK_ID)} });
process.stdout.write(JSON.stringify(records));`,
      ],
      { encoding: "utf-8" }
    );
    let records: Array<{ status: string }> = [];
    try {
      records = JSON.parse(verify.stdout || "[]");
    } catch {
      records = [];
    }
    check("E2E-2) 완전히 새로운 process에서 store를 재open해도 성공적으로 조회됨(exit=0)", verify.status === 0);
    check(
      "E2E-2) 그 approval이 durable file에 정확히 1건 PENDING으로 실제 존재함(로그가 주장한 durable 생성과 실제 persistence가 일치)",
      records.length === 1 && records[0]?.status === "PENDING"
    );
  } finally {
    cleanupSharedRuntimeArtifacts(fixture);
  }
}

async function main(): Promise<void> {
  try {
    await scenarioEnvUnsetRefusesDurableSuccessClaim();
    await scenarioProductionEnvPersistsDurablyAndLogsHonestly();
  } finally {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // OS 임시 디렉터리 — 정리 실패는 테스트 결과에 영향 없음.
      }
    }
  }

  console.log("\n=== run.ts 실제 production entrypoint — durable approval E2E 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
