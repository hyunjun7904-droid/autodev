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
// reconcileStaleRequiredTestExecutionEnvironmentTasks 상단 주석, § human-gate-policy.ts
// reconcileKnownTechnicalDeferredMarkers 상단 주석, § autodev-tests.ts의 함수 레벨 회귀와
// 동일한 시나리오를 실제 컴파일된 run.js child process로도 증명한다).
//
// 이 파일은 어떤 특정 프로젝트도 언급하지 않는다 — 전부 generic fixture(taskId "T1" 등)다.
// 실제 Claude/GPT/Telegram API를 전혀 호출하지 않는다: Durable Technical Blocker Recovery
// 수정(2026-09-01) 이후로는 이 fixture의 STAGNATION_DETECTED marker도 BLOCKED 상태에서
// env marker와 함께 독립적으로 해소되어 decideNextAction()이 이 task를 실제로 재선택하지만,
// 이 generic fixture는 gradlew requiredTest에 대응하는 allowedCommands 항목을 의도적으로
// 비워뒀으므로 Developer 호출 직전의 별도 기존 기술적 게이트(execution-contract.ts
// EXECUTION_CONTRACT_MISMATCH)가 먼저 걸려 실제 Developer는 호출되지 않는다 — 그래서 실제
// `claude` CLI/네트워크 credential 없이도 안전하게 실제 production entrypoint의 전체
// reconciliation 체인을 검증할 수 있다.

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
// E2E) BLOCKED + mixed deferredHumanTasks(STAGNATION_DETECTED + 실제로는 이미 해소된
//      REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR) 상태에서 실제 `node dist/run.js` one-shot을
//      실행했을 때: (1) env marker 재검사가 다른 marker 때문에 스킵되지 않고 실제로
//      수행되어 제거되고, (2) Durable Technical Blocker Recovery 수정(2026-09-01) 이후로는
//      STAGNATION_DETECTED도 genuine marker가 전혀 없으므로 독립적으로 함께 제거되어
//      deferredHumanTasks가 완전히 비고 READY로 전환되며, (3) decideNextAction()이 이 task를
//      정상적으로 다시 선택하지만, 이 generic fixture는 gradlew requiredTest에 대응하는
//      allowedCommands 항목을 의도적으로 비워뒀으므로(§ execution-contract.ts) Developer를
//      호출하기 직전의 별도 기존 기술적 게이트(EXECUTION_CONTRACT_MISMATCH)가 먼저 걸려
//      실제 Developer/Claude CLI는 단 한 번도 호출되지 않고 안전하게 다시 BLOCKED로
//      수렴한다는 것을, 실제 컴파일된 production entrypoint로 증명한다. (STAGNATION_DETECTED
//      단독으로 완전히 성공 checkpoint까지 도달하는 경로는 autodev-tests.ts
//      scenarioRunAutodevOnceBlockedStagnationAloneFullyRecoversAndCallsDeveloperOnce가
//      실제 Claude CLI 호출 없이 fake claudeRunner로 이미 검증한다 — 이 E2E는 실제 child
//      process 수준에서 "재현혼합 marker 재검사가 스킵되지 않는다 + 실제 Developer 호출은
//      없다"만 안전하게 함께 증명한다.)
// ---------------------------------------------------------------------------
async function scenarioMixedMarkersFullyResolveViaRealEntrypointWithoutRealDeveloperCall(): Promise<void> {
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
    check(
      "E2E) env marker 재검사가 실제로 실행되어 제거됨(무관한 marker 때문에 스킵되지 않음)",
      stdout.includes("REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR marker") && stdout.includes("해당 marker만 제거합니다")
    );
    check(
      "E2E) STAGNATION_DETECTED도 BLOCKED 상태에서 독립적으로 재검사되어 제거됨(이번 수정의 핵심)",
      stdout.includes("기술적 자동복구 대상 marker") && stdout.includes("STAGNATION_DETECTED")
    );
    check("E2E) 두 marker 모두 해소되어 '남은 사유가 없습니다' 로그(완전 해소 시에만 찍힘)를 실제로 출력함", stdout.includes("남은 사유가 없습니다"));
    check(
      "E2E) 그 다음 decideNextAction()이 이 task를 실제로 재선택하지만, Developer 호출 직전 기존 EXECUTION_CONTRACT_MISMATCH 게이트가 대신 걸려 Developer를 호출하지 않음",
      stdout.includes("EXECUTION_CONTRACT_MISMATCH") && stdout.includes("Developer를 부르지 않고")
    );
    check("E2E) 실제 Claude Developer 호출을 시사하는 로그가 전혀 없음(claude CLI가 실제로 spawn되지 않음)", !stdout.includes("[claude-developer]") && !stdout.includes("claude 실행"));

    const finalState = JSON.parse(readFileSync(fixture.statePath, "utf-8")) as CoreState;
    check(
      "E2E) 원래의 env marker/STAGNATION_DETECTED marker는 더 이상 남아있지 않음(둘 다 제거됨)",
      !finalState.deferredHumanTasks.some((t) => t.startsWith("REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR:") || t.startsWith("STAGNATION_DETECTED("))
    );
    check(
      "E2E) 최종 status가 다시 BLOCKED(EXECUTION_CONTRACT_MISMATCH라는 별개의 기존 기술적 사유로) — READY로 남아있지 않음",
      (finalState.status as unknown as string) === "BLOCKED"
    );
    check("E2E) reviewCycle이 임의로 초기화되지 않음(기존 작업물 보존)", finalState.reviewCycle === 3);
    check(
      "E2E) lastClaudeResult(이전 성공 결과)가 임의로 삭제되지 않음(기존 작업물 보존, Developer가 실제로 재호출되지 않았으므로 갱신되지도 않음)",
      finalState.lastClaudeResult !== null && finalState.lastClaudeResult.success === true
    );
    check("E2E) completedTasks에 이 task가 억지로 추가되지 않음(자동 승인 아님)", !finalState.completedTasks.includes(FIXTURE_TASK_ID));
  } finally {
    cleanupSharedRuntimeArtifacts(fixture);
    rmSync(fakeJdkHome, { recursive: true, force: true });
  }
}

interface MarkerRunResult {
  stdout: string;
  stderr: string;
  matchedMarker: string | undefined;
  timedOut: boolean;
}

/** run-durable-approval-e2e-tests.ts의 runOneShotAndCaptureUntilMarker()와 동일한 패턴(로직
 *  복제가 아니라 각 E2E 파일이 독립적으로 소유하는 fixture harness — 이 파일도 이미 그
 *  패턴을 위 runOneShotToCompletion()에 쓴다). genuine WAITING_HUMAN으로 끝나는 시나리오는
 *  run.ts가 controller owner인 동안 waitWhileWaitingHuman()으로 무기한 대기하므로(§ run.ts
 *  "WAITING_HUMAN — Telegram 승인 대기를 위해 controller를 유지한 채..."), stdout에 markers
 *  중 하나가 나타나면(그 시점에 이미 state.json durable write는 완료된 뒤다) 그 즉시 child를
 *  종료시킨다 — 자연 종료를 기다리지 않는다(무기한 대기가 정상 production 동작이므로). */
function runOneShotAndCaptureUntilMarker(
  fixture: Fixture,
  env: NodeJS.ProcessEnv,
  markers: string[],
  timeoutMs = 30_000
): Promise<MarkerRunResult> {
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
// E2E-2) WAITING_HUMAN + mixed deferredHumanTasks(genuine AUTH_ERROR marker + 실제로는
//        이미 해소된 REQUIRED_TEST_CONFIGURATION_ERROR) — Mixed-Marker Recovery 수정
//        (2026-09-01, § required-test-preflight.ts reconcileStaleRequiredTestConfigurationTasks
//        상단 주석)이 이 파일 상단의 ENV/STAGNATION 시나리오와 대칭적으로 다루는 generic
//        defect의 CONFIG_ERROR 쪽 재현이다: 예전에는 genuine marker가 단 하나만 섞여 있어도
//        배열 전체가 fail-closed로 취급되어 이미 해소된 npm script 등록 문제조차 영구히
//        재검사되지 않았다. 실제 `node dist/run.js` one-shot으로 (1) CONFIG marker 재검사가
//        genuine marker 때문에 스킵되지 않고 실제로 수행되어 그 marker만 제거되고, (2) genuine
//        AUTH_ERROR marker는 이 함수도 WAITING_HUMAN 전체 자동복구 정책도 절대 자동으로
//        지우거나 승인하지 않으며(§ human-gate-policy.ts classifyWaitingHumanReason —
//        AUTH_ERROR:는 GENUINE_MARKER_PREFIXES에 있다), (3) 그래서 최종 상태는 여전히
//        WAITING_HUMAN으로 남아(남은 blocker 기준 판정) decideNextAction()이 STOP하고 실제
//        Developer/Reviewer가 단 한 번도 호출되지 않는다는 것을, 실제 컴파일된 production
//        entrypoint로 증명한다.
// ---------------------------------------------------------------------------
const CONFIG_REQUIRED_TEST_NAME = "config-check-tests";
const CONFIG_MISSING_SCRIPT = "test:config-check";
const CONFIG_ERROR_MARKER = `REQUIRED_TEST_CONFIGURATION_ERROR: task=${FIXTURE_TASK_ID} requiredTest=${CONFIG_REQUIRED_TEST_NAME} missingScript=${CONFIG_MISSING_SCRIPT}`;
const GENUINE_AUTH_ERROR_MARKER = "AUTH_ERROR: fixture — 실제 사람 로그인이 필요한 상태(generic fixture, 자동 복구 대상 아님)";

function buildConfigFixture(prefix: string): Fixture {
  const root = makeGitRepo(`${prefix}-root-`);
  const configDir = mkdtempSync(join(tmpdir(), `${prefix}-cfg-`));
  tempDirs.push(configDir);
  const isolationDir = mkdtempSync(join(tmpdir(), `${prefix}-iso-`));
  tempDirs.push(isolationDir);

  // 구성 문제 해소: package.json에 필요한 npm script가 이미 등록돼 있다 — 다만
  // project-state.json은 아직 그 사실을 반영하지 못한 채 WAITING_HUMAN에 머물러 있는 상태를
  // 재현한다(§ 요구사항 "configuration 문제를 해소하고 실행한다").
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", scripts: { [CONFIG_MISSING_SCRIPT]: "node src/config-check.test.mjs" } }, null, 2)}\n`,
    "utf-8"
  );
  spawnSync("git", ["add", "--", "package.json"], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "package.json"], { cwd: root });

  const projectId = `fixture-config-mixed-marker-${randomUUID()}`;
  const statePath = join(configDir, "project-state.json");
  const state: CoreState = {
    currentTask: "fixture task — 이미 구현 완료, npm script 미등록으로만 막혀 있었음",
    reviewCycle: 3,
    lastClaudeResult: {
      success: true,
      summary: "fixture — 이미 성공한 이전 attempt(구성 결함 발생 이전)",
      changedFiles: ["src/marker.txt"],
      tests: [{ name: CONFIG_REQUIRED_TEST_NAME, pass: true }],
      rawOutput: "",
    },
    lastGptDecision: { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "fixture", nextTask: null },
    status: "WAITING_HUMAN",
    claudeLimitWaitCount: 0,
    // 순서 자체가 결과에 영향을 주면 안 된다는 것도 함께 검증한다 — genuine marker를 먼저 둔다.
    deferredHumanTasks: [GENUINE_AUTH_ERROR_MARKER, CONFIG_ERROR_MARKER],
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
            title: "config mixed marker recovery e2e fixture task",
            prompt: "fixture",
            requiredTests: [],
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
    moduleAbs: root,
  };
}

async function scenarioConfigMarkerReconciledViaRealEntrypointWithoutRealDeveloperCall(): Promise<void> {
  const fixture = buildConfigFixture("config-mixed-marker-recovery");
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
    // 최종 상태가 genuine WAITING_HUMAN으로 남으므로(§ 아래 검증), run.ts가 controller owner인
    // 동안 Telegram 승인을 기다리며 무기한 대기한다(§ run.ts) — 이것이 정상 production 동작이라
    // 자연 종료를 기다리지 않고, 그 대기에 진입했다는 로그가 찍히는 즉시 child를 종료한다(§
    // runOneShotAndCaptureUntilMarker 상단 주석 — 그 시점에 이미 state.json durable write는
    // 완료돼 있다).
    const { stdout, matchedMarker, timedOut } = await runOneShotAndCaptureUntilMarker(fixture, env, [
      "WAITING_HUMAN — Telegram 승인 대기를 위해 controller를 유지한 채",
    ]);
    check("E2E-2) timeout 없이 genuine WAITING_HUMAN 대기 진입 로그를 실제로 관측함", !timedOut && matchedMarker !== undefined);
    check(
      "E2E-2) config marker 재검사가 실제로 수행되어 제거됨(무관한 genuine marker 때문에 스킵되지 않음)",
      stdout.includes("REQUIRED_TEST_CONFIGURATION_ERROR marker") && stdout.includes("해당 marker만 제거합니다")
    );
    check(
      "E2E-2) '남은 사유가 없습니다' 로그는 찍히지 않음(genuine marker가 남아있으므로 완전 해소가 아님)",
      !stdout.includes("남은 사유가 없습니다")
    );
    check("E2E-2) 실제 Claude Developer 호출을 시사하는 로그가 전혀 없음(claude CLI가 실제로 spawn되지 않음)", !stdout.includes("[claude-developer]") && !stdout.includes("claude 실행"));

    const finalState = JSON.parse(readFileSync(fixture.statePath, "utf-8")) as CoreState;
    check(
      "E2E-2) 해결된 CONFIG marker만 제거됨(더 이상 남아있지 않음)",
      !finalState.deferredHumanTasks.some((t) => t.startsWith("REQUIRED_TEST_CONFIGURATION_ERROR:"))
    );
    check(
      "E2E-2) genuine AUTH_ERROR marker는 자동으로 지워지거나 승인되지 않고 그대로 보존됨",
      finalState.deferredHumanTasks.length === 1 && finalState.deferredHumanTasks[0] === GENUINE_AUTH_ERROR_MARKER
    );
    check(
      "E2E-2) 상태는 remaining blocker(genuine marker) 기준으로 결정되어 여전히 WAITING_HUMAN(자동 READY 강제전환 금지)",
      (finalState.status as unknown as string) === "WAITING_HUMAN"
    );
    check("E2E-2) reviewCycle이 임의로 초기화되지 않음(기존 작업물 보존)", finalState.reviewCycle === 3);
    check(
      "E2E-2) lastClaudeResult(이전 성공 결과)가 임의로 삭제되지 않음(기존 작업물 보존, Developer가 실제로 재호출되지 않았으므로 갱신되지도 않음)",
      finalState.lastClaudeResult !== null && finalState.lastClaudeResult.success === true
    );
    check("E2E-2) completedTasks에 이 task가 억지로 추가되지 않음(자동 승인 아님)", !finalState.completedTasks.includes(FIXTURE_TASK_ID));
  } finally {
    cleanupSharedRuntimeArtifacts(fixture);
  }
}

// ---------------------------------------------------------------------------
// E2E-3) CRITICAL defect fix — WAITING_HUMAN + STAGNATION_DETECTED(알려진 기술적 marker) +
//        아직 실제로 해소되지 않은 REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR(trusted JDK
//        미지정 — WRAPPER_NOT_FOUND가 그대로 재현됨) + 아직 실제로 해소되지 않은
//        REQUIRED_TEST_CONFIGURATION_ERROR(package.json 자체가 없음 — fail-closed로 미해결) +
//        이 저장소가 전혀 모르는 UNKNOWN 형식의 marker가 함께 있는 조합. 수정 전에는
//        autodev.ts의 WAITING_HUMAN 전용 블록이 배열 전체 단위 aggregate 판정
//        (isTechnicalAutoRecoverableWaitingHuman)만으로 "genuine marker가 하나도 없다"고
//        보고 deferredHumanTasks 전체를 통째로 비운 뒤 status를 READY로 강제전환했다 — 세
//        marker 모두 아직 실제로 해소되지 않았는데도 근거 없이 삭제되는 CRITICAL defect였다.
//        이 E2E는 실제 컴파일된 production entrypoint(dist/run.js)로 (1) STAGNATION_DETECTED만
//        독립적으로 제거되고, (2) 아직 해소되지 않은 ENV/CONFIG/UNKNOWN marker 셋 다 절대
//        삭제되지 않으며, (3) status가 READY로 강제전환되지 않고 WAITING_HUMAN을 유지하며
//        (남은 marker 기준으로 classifyWaitingHumanReason이 이제 genuine으로 판정해 실제로
//        Telegram 승인 대기로 들어감), (4) 실제 Developer/Reviewer가 단 한 번도 호출되지
//        않는다는 것을 함께 증명한다.
// ---------------------------------------------------------------------------
const UNKNOWN_FORMAT_MARKER = "SOME_FUTURE_UNRECOGNIZED_MARKER_FORMAT: fixture — 이 저장소의 어떤 reconciliation 함수도 이 형식을 알지 못함";

function buildStagnationWithUnresolvedMixedMarkersFixture(prefix: string): Fixture {
  const root = makeGitRepo(`${prefix}-root-`);
  const configDir = mkdtempSync(join(tmpdir(), `${prefix}-cfg-`));
  tempDirs.push(configDir);
  const isolationDir = mkdtempSync(join(tmpdir(), `${prefix}-iso-`));
  tempDirs.push(isolationDir);

  const moduleAbs = join(root, "android", "wakeword");
  makeGradleModule(moduleAbs);
  // package.json을 의도적으로 만들지 않는다 — CONFIG marker가 fail-closed로 절대 해소되지
  // 않는 상태를 재현한다(§ reconcileStaleRequiredTestConfigurationTasks의 pkg.ok===false
  // 분기).

  const projectId = `fixture-waiting-human-mixed-unresolved-${randomUUID()}`;
  const statePath = join(configDir, "project-state.json");
  const state: CoreState = {
    currentTask: "fixture task — 아직 세 가지 사유 모두 해소되지 않음",
    reviewCycle: 3,
    lastClaudeResult: {
      success: true,
      summary: "fixture — 이전 attempt(결함 발생 이전)",
      changedFiles: ["src/marker.txt"],
      tests: [{ name: REQUIRED_TEST_NAME, pass: true }],
      rawOutput: "",
    },
    lastGptDecision: { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "fixture", nextTask: null },
    status: "WAITING_HUMAN",
    claudeLimitWaitCount: 0,
    // 순서 자체가 결과에 영향을 주면 안 된다 — STAGNATION_DETECTED를 가운데 둔다.
    deferredHumanTasks: [
      `REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR: task=${FIXTURE_TASK_ID} requiredTest=${REQUIRED_TEST_NAME} kind=WRAPPER_NOT_FOUND cwd=wakeword resolvedPath=${moduleAbs}`,
      STAGNATION_MARKER,
      CONFIG_ERROR_MARKER,
      UNKNOWN_FORMAT_MARKER,
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
            title: "waiting-human mixed unresolved marker e2e fixture task",
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

async function scenarioWaitingHumanStagnationWithUnresolvedMixedMarkersPreservesAllUnresolved(): Promise<void> {
  const fixture = buildStagnationWithUnresolvedMixedMarkersFixture("waiting-human-mixed-unresolved");
  // 의도적으로 AUTODEV_TRUSTED_JAVA_HOME을 지정하지 않는다 — 실행 환경 결함이 실제로
  // 해소되지 않은 상태를 그대로 유지한다(§ 이 시나리오의 핵심 전제).
  const env = buildChildEnv({
    AUTOMATION_DRY_RUN: undefined,
    AUTODEV_PRODUCTION_RUNTIME: undefined,
    AUTODEV_TELEGRAM_BOT_TOKEN: undefined,
    AUTODEV_TELEGRAM_CHAT_ID: undefined,
    AUTODEV_APPROVAL_STORE_PATH: fixture.approvalStorePath,
    AUTODEV_EVENT_LOG_PATH: fixture.eventLogPath,
    AUTODEV_TELEGRAM_CONTROLLER_RUNTIME_DIR: fixture.telegramRuntimeDir,
    AUTODEV_TRUSTED_JAVA_HOME: undefined,
    JAVA_HOME: undefined,
  });

  try {
    // 남은 marker(ENV/CONFIG/UNKNOWN) 기준으로 classifyWaitingHumanReason()이 이제 genuine으로
    // 판정하므로(§ 위 주석), run.ts가 controller owner인 동안 Telegram 승인 대기로 무기한
    // 진입한다 — 그 로그가 찍히는 즉시 child를 종료한다(§ runOneShotAndCaptureUntilMarker
    // 상단 주석과 동일한 패턴, 그 시점에 이미 state.json durable write는 완료돼 있다).
    const { stdout, matchedMarker, timedOut } = await runOneShotAndCaptureUntilMarker(fixture, env, [
      "WAITING_HUMAN — Telegram 승인 대기를 위해 controller를 유지한 채",
    ]);
    check("E2E-3) timeout 없이 genuine WAITING_HUMAN 대기 진입 로그를 실제로 관측함(남은 marker 기준으로 재판정됨)", !timedOut && matchedMarker !== undefined);
    check(
      "E2E-3) 기술적 자동복구 대상 marker(STAGNATION_DETECTED)가 실제로 재검사되어 제거됨",
      stdout.includes("기술적 WAITING_HUMAN을 재검사했습니다") || stdout.includes("STAGNATION_DETECTED")
    );
    check(
      "E2E-3) '남은 사유가 없습니다' 로그는 찍히지 않음(ENV/CONFIG/UNKNOWN marker가 여전히 남아있으므로 완전 해소가 아님)",
      !stdout.includes("남은 사유가 없습니다")
    );
    check("E2E-3) 실제 Claude Developer 호출을 시사하는 로그가 전혀 없음(claude CLI가 실제로 spawn되지 않음)", !stdout.includes("[claude-developer]") && !stdout.includes("claude 실행"));

    const finalState = JSON.parse(readFileSync(fixture.statePath, "utf-8")) as CoreState;
    check(
      "E2E-3) STAGNATION_DETECTED marker는 더 이상 남아있지 않음(독립적으로 제거됨)",
      !finalState.deferredHumanTasks.some((t) => t.startsWith("STAGNATION_DETECTED("))
    );
    check(
      "E2E-3) 아직 해소되지 않은 ENV marker는 절대 삭제되지 않고 그대로 보존됨",
      finalState.deferredHumanTasks.some((t) => t.startsWith("REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR:"))
    );
    check(
      "E2E-3) 아직 해소되지 않은 CONFIG marker는 절대 삭제되지 않고 그대로 보존됨",
      finalState.deferredHumanTasks.some((t) => t.startsWith("REQUIRED_TEST_CONFIGURATION_ERROR:"))
    );
    check(
      "E2E-3) 이 저장소가 전혀 모르는 UNKNOWN 형식 marker는 절대 삭제되지 않고 그대로 보존됨(CRITICAL defect 수정의 핵심 검증)",
      finalState.deferredHumanTasks.includes(UNKNOWN_FORMAT_MARKER)
    );
    check("E2E-3) 남은 marker가 3건 그대로 보존됨(ENV/CONFIG/UNKNOWN, STAGNATION만 제거)", finalState.deferredHumanTasks.length === 3);
    check(
      "E2E-3) 남은 marker가 있으므로 status가 READY로 강제전환되지 않고 WAITING_HUMAN을 유지함(CRITICAL defect 수정의 핵심 검증)",
      (finalState.status as unknown as string) === "WAITING_HUMAN"
    );
    check("E2E-3) reviewCycle이 임의로 초기화되지 않음(기존 작업물 보존)", finalState.reviewCycle === 3);
    check("E2E-3) completedTasks에 이 task가 억지로 추가되지 않음(자동 승인 아님)", !finalState.completedTasks.includes(FIXTURE_TASK_ID));
  } finally {
    cleanupSharedRuntimeArtifacts(fixture);
  }
}

async function main(): Promise<void> {
  try {
    await scenarioMixedMarkersFullyResolveViaRealEntrypointWithoutRealDeveloperCall();
    await scenarioConfigMarkerReconciledViaRealEntrypointWithoutRealDeveloperCall();
    await scenarioWaitingHumanStagnationWithUnresolvedMixedMarkersPreservesAllUnresolved();
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
