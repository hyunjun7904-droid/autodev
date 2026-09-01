import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { CoreState } from "./types";
import { debugComputeLockFilePath, resolveCanonicalProjectPath, RUNTIME_LOCK_DIR } from "./project-lock";
import { resolveUsageLedgerFilePath, RUNTIME_USAGE_LEDGER_DIR } from "./usage-ledger";

// Mixed-Marker Recovery Defect — 실제 production entrypoint(dist/run.js) child-process E2E
// (2026-09-01, generic defect — § required-test-preflight.ts
// reconcileStaleRequiredTestExecutionEnvironmentTasks 상단 주석, § autodev-tests.ts
// scenarioRunAutodevOnceMixedDeferredMarkersOnlyResolvesEnvMarker의 함수 레벨 회귀와
// 동일한 시나리오를 실제 컴파일된 run.js child process로도 증명한다).
//
// 이 파일은 어떤 특정 프로젝트도 언급하지 않는다 — 전부 generic fixture(taskId "T1" 등)다.
// 실제 Claude/GPT/Telegram API를 전혀 호출하지 않는다: 이 시나리오는 항상 status="BLOCKED"로
// 남아야 하므로(무관한 STAGNATION_DETECTED marker가 남아있다) decideNextAction()이
// 곧바로 STOP을 반환하고 Developer 호출 지점 자체에 도달하지 않는다 — 그래서 실제 `claude`
// CLI/네트워크 credential 없이도 안전하게 실제 production entrypoint를 검증할 수 있다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
const RUN_JS = join(__dirname, "run.js");

const FIXTURE_TASK_ID = "T1";
const REQUIRED_TEST_NAME = "wakeword-unit";
const STAGNATION_MARKER = "STAGNATION_DETECTED(IMPLEMENTATION): reviewCycle=2에서 동일한 required test 실패가 2회 연속 반복됨";

function makeGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "mixed-marker-recovery-e2e@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Mixed Marker Recovery E2E"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function relFromTo(fromDir: string, toDir: string): string {
  return relative(fromDir, toDir).split(sep).join("/");
}

/** required-test-preflight-tests.ts의 makeGradleModule()과 동일한 fixture(로직 복제가
 *  아니라 별도 테스트 파일이 각자 독립적으로 소유하는 fixture 생성 — 두 파일 모두 이미
 *  이 패턴을 쓴다). */
function makeGradleModule(moduleAbs: string): void {
  mkdirSync(join(moduleAbs, "gradle", "wrapper"), { recursive: true });
  writeFileSync(join(moduleAbs, "gradlew"), "#!/bin/sh\necho gradlew\n", "utf-8");
  writeFileSync(join(moduleAbs, "gradlew.bat"), "@echo off\r\necho gradlew\r\n", "utf-8");
  writeFileSync(join(moduleAbs, "gradle", "wrapper", "gradle-wrapper.properties"), "distributionUrl=https://example.invalid/gradle.zip\n", "utf-8");
  writeFileSync(join(moduleAbs, "gradle", "wrapper", "gradle-wrapper.jar"), "fixture-jar-bytes", "utf-8");
}

/** win32에서 gradlew wrapper를 신뢰하려면 wrapper 파일 자체뿐 아니라 JAVA_HOME(또는
 *  AUTODEV_TRUSTED_JAVA_HOME)이 가리키는 실제 java.exe도 필요하다(§ gradle-capability.ts).
 *  이 java.exe는 절대 실행되지 않는다(reconciliation은 존재/신뢰 판정만 한다) — 그래서 빈
 *  더미 파일이면 충분하다. checkRequiredTestExecutionEnvironment()의
 *  excludedRootsForJava가 OS temp 디렉터리 전체를 항상 신뢰하지 않으므로(실제 production
 *  신뢰 모델과 동일한 이유), 이 fake JDK는 OS temp가 아니라 이 저장소(dist/..) 안의 격리된
 *  디렉터리에 만든다 — 테스트 종료 시 반드시 정리한다. */
function makeFakeTrustedJdk(): string {
  const repoRoot = join(__dirname, "..");
  const jdkHome = join(repoRoot, `.mixed-marker-e2e-fake-jdk-${randomUUID()}`);
  mkdirSync(join(jdkHome, "bin"), { recursive: true });
  writeFileSync(join(jdkHome, "bin", "java.exe"), "fixture-not-a-real-executable", "utf-8");
  return jdkHome;
}

interface Fixture {
  root: string;
  adapterPath: string;
  statePath: string;
  approvalStorePath: string;
  eventLogPath: string;
  telegramRuntimeDir: string;
  projectId: string;
  moduleAbs: string;
}

function buildFixture(prefix: string): Fixture {
  const root = makeGitRepo(`${prefix}-root-`);
  const configDir = mkdtempSync(join(tmpdir(), `${prefix}-cfg-`));
  tempDirs.push(configDir);
  const isolationDir = mkdtempSync(join(tmpdir(), `${prefix}-iso-`));
  tempDirs.push(isolationDir);

  const moduleAbs = join(root, "android", "wakeword");
  makeGradleModule(moduleAbs);

  const projectId = `fixture-mixed-marker-${randomUUID()}`;
  const statePath = join(configDir, "project-state.json");
  const state: CoreState = {
    currentTask: "fixture task — 이미 구현 완료, 환경 결함으로만 막혀 있었음",
    reviewCycle: 3,
    lastClaudeResult: {
      success: true,
      summary: "fixture — 이미 성공한 이전 attempt(환경 결함 발생 이전)",
      changedFiles: ["src/marker.txt"],
      tests: [{ name: REQUIRED_TEST_NAME, pass: true }],
      rawOutput: "",
    },
    lastGptDecision: { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "fixture", nextTask: null },
    status: "BLOCKED",
    claudeLimitWaitCount: 0,
    // 순서 자체가 결과에 영향을 주면 안 된다는 것도 함께 검증한다 — 무관한 marker를 먼저 둔다.
    deferredHumanTasks: [
      STAGNATION_MARKER,
      `REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR: task=${FIXTURE_TASK_ID} requiredTest=${REQUIRED_TEST_NAME} kind=WRAPPER_NOT_FOUND cwd=wakeword resolvedPath=${moduleAbs}`,
    ],
    completedTasks: [],
    gitCheckpoint: "",
    currentPhase: 1,
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");

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
            title: "mixed marker recovery e2e fixture task",
            prompt: "fixture",
            requiredTests: [{ name: REQUIRED_TEST_NAME, command: "gradlew", args: ["testDebugUnitTest"], cwd: "wakeword" }],
            allowedPathPrefixes: ["src/"],
            prohibitedOperations: [],
          },
        ],
        developerInstructions: "fixture",
        reviewInstructions: "fixture",
        reviewScopeDirs: ["src/"],
        executionPolicy: {
          allowedReadPrefixes: ["src/"],
          allowedWritePrefixes: ["src/"],
          allowedCommands: [],
          commandCwdAliases: { wakeword: "android/wakeword" },
        },
      },
      null,
      2
    )}\n`,
    "utf-8"
  );

  return {
    root,
    adapterPath,
    statePath,
    approvalStorePath: join(isolationDir, "approvals.json"),
    eventLogPath: join(isolationDir, "events.jsonl"),
    telegramRuntimeDir: join(isolationDir, "telegram-runtime"),
    projectId,
    moduleAbs,
  };
}

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
  exitCode: number | null;
}

function runOneShotToCompletion(fixture: Fixture, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<ChildRunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUN_JS, "--project", fixture.adapterPath], { env });
    let stdout = "";
    let stderr = "";
    let resolved = false;

    const overallTimer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      try {
        child.kill();
      } catch {
        /* 이미 종료됨 */
      }
      resolve({ stdout, stderr, exitCode: null });
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(overallTimer);
      resolve({ stdout, stderr, exitCode: code });
    });
    child.on("error", () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(overallTimer);
      resolve({ stdout, stderr, exitCode: null });
    });
  });
}

// ---------------------------------------------------------------------------
// E2E) BLOCKED + mixed deferredHumanTasks(무관한 STAGNATION_DETECTED + 실제로는 이미 해소된
//      REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR) 상태에서 실제 `node dist/run.js` one-shot을
//      실행했을 때: (1) env marker 재검사가 무관한 marker 때문에 스킵되지 않고 실제로
//      수행되며, (2) 해소된 env marker만 제거되고, (3) 무관한 marker는 그대로 보존되며,
//      (4) status가 READY로 강제전환되지 않고 BLOCKED로 남고, (5) Developer가 단 한 번도
//      호출되지 않는다(항상 이 프로세스는 API 호출 없이 안전하게 종료된다)는 것을 실제
//      컴파일된 production entrypoint로 증명한다.
// ---------------------------------------------------------------------------
async function scenarioMixedMarkersResolveOnlyEnvMarkerViaRealEntrypoint(): Promise<void> {
  const fixture = buildFixture("mixed-marker-recovery");
  const fakeJdkHome = makeFakeTrustedJdk();
  const env = buildChildEnv({
    AUTOMATION_DRY_RUN: undefined,
    AUTODEV_PRODUCTION_RUNTIME: undefined,
    AUTODEV_TELEGRAM_BOT_TOKEN: undefined,
    AUTODEV_TELEGRAM_CHAT_ID: undefined,
    AUTODEV_APPROVAL_STORE_PATH: fixture.approvalStorePath,
    AUTODEV_EVENT_LOG_PATH: fixture.eventLogPath,
    AUTODEV_TELEGRAM_CONTROLLER_RUNTIME_DIR: fixture.telegramRuntimeDir,
    // gradlew wrapper 파일 자체는 이미 fixture에 존재한다 — 이 env 없이는(trusted Java
    // 부재) 이 머신(win32)에서 여전히 WRAPPER_NOT_FOUND로 재현될 것이므로, "환경이 실제로
    // 해소됨"을 표현하려면 이 값이 반드시 필요하다.
    AUTODEV_TRUSTED_JAVA_HOME: fakeJdkHome,
    JAVA_HOME: undefined,
  });

  try {
    const { stdout, exitCode } = await runOneShotToCompletion(fixture, env);
    check("E2E) 실제 child process가 timeout 없이 정상 종료함", exitCode !== null);
    check("E2E) STOP(BLOCKED) 로그를 실제로 출력함 — Developer 호출 경로에 진입하지 않음", stdout.includes("이미 BLOCKED 상태"));
    check("E2E) STOP 로그가 '근본 원인이 해소되지 않는 한'이라는 기존 문구를 그대로 유지함(회귀 없음)", stdout.includes("근본 원인이 해소되지 않는 한"));
    check(
      "E2E) env marker 부분 해소 로그를 실제로 출력함(무관한 marker 때문에 스킵되지 않음)",
      stdout.includes("REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR marker") && stdout.includes("해당 marker만 제거합니다")
    );
    check("E2E) '남은 사유가 없습니다' 로그(전체 해소 시에만 찍힘)는 출력되지 않음 — 부분 해소이므로 READY 전환 로그가 없어야 함", !stdout.includes("남은 사유가 없습니다"));

    const finalState = JSON.parse(readFileSync(fixture.statePath, "utf-8")) as CoreState;
    check(
      "E2E) 실행 환경 결함(env marker)만 실제로 제거됨",
      !finalState.deferredHumanTasks.some((t) => t.startsWith("REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR:"))
    );
    check(
      "E2E) 무관한 STAGNATION_DETECTED marker는 실제 파일에서도 그대로 보존됨(임의 삭제 없음)",
      finalState.deferredHumanTasks.length === 1 && finalState.deferredHumanTasks[0] === STAGNATION_MARKER
    );
    check("E2E) 최종 status가 여전히 BLOCKED(READY로 강제전환되지 않음)", (finalState.status as unknown as string) === "BLOCKED");
    check("E2E) reviewCycle이 임의로 초기화되지 않음(기존 작업물 보존)", finalState.reviewCycle === 3);
    check(
      "E2E) lastClaudeResult(이전 성공 결과)가 임의로 삭제되지 않음(기존 작업물 보존)",
      finalState.lastClaudeResult !== null && finalState.lastClaudeResult.success === true
    );
    check("E2E) completedTasks에 이 task가 억지로 추가되지 않음(자동 승인 아님)", !finalState.completedTasks.includes(FIXTURE_TASK_ID));
  } finally {
    cleanupSharedRuntimeArtifacts(fixture);
    rmSync(fakeJdkHome, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  try {
    await scenarioMixedMarkersResolveOnlyEnvMarkerViaRealEntrypoint();
  } finally {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // OS 임시 디렉터리 — 정리 실패는 테스트 결과에 영향 없음.
      }
    }
  }

  console.log("\n=== Mixed-Marker Recovery — 실제 production entrypoint E2E 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
