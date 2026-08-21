import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createSafeExecutorContext } from "./safe-executor";
import type { SafeExecutorContext } from "./safe-executor";
import type { ProjectExecutionPolicy } from "./project-policy";
import { runDeveloperTaskViaSafeExecutor } from "./claude-developer";
import { performTaskCheckpoint } from "./checkpoint";
import type { TaskDefinition } from "./task-registry";

// AutoDev Phase C Task C2 — Safe Executor Per-Run Execution Context 격리.
//
// C1까지는 safe-executor.ts의 PROJECT_ROOT/PROJECT_ROOT_REAL/currentPolicy가 module-level
// mutable 전역이었고 configureSafeExecutor()가 그 전역을 덮어썼다 — "한 프로세스 = 한
// 프로젝트"에서는 문제가 없었지만, 같은 프로세스 안에서 Project A와 Project B가 겹쳐
// 실행되면 A가 쓰던 root/policy가 B의 값으로 조용히 바뀔 위험이 있었다.
//
// 이 파일은 그 위험이 실제로 사라졌음을 직접 증명한다: createSafeExecutorContext(root, policy)
// 로 만든 두 개의 독립 context(Project Alpha/Project Beta)가 같은 프로세스 안에서
//   - 순차적으로,
//   - interleave(번갈아)되어,
//   - Promise.all로 진짜 동시에
// 쓰여도 서로의 root/policy를 절대 침범하지 못한다는 것을, 그리고 Claude Developer/
// checkpoint가 실제로 "올바른" context/repo만 쓴다는 것을 검증한다. 실제 Claude CLI/OpenAI
// API는 호출하지 않는다(Developer 시나리오는 claudeCaller를 fake로 주입).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Project Alpha / Project Beta — 완전히 다른 root + 완전히 다른 allowedWritePrefixes.
// ---------------------------------------------------------------------------
function makeProjectRoot(prefix: string, writableDir: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, writableDir), { recursive: true });
  return root;
}

function alphaPolicy(): ProjectExecutionPolicy {
  return {
    allowedReadPrefixes: ["alpha/"],
    allowedWritePrefixes: ["alpha/"],
    allowedCommands: [{ cwd: "root", command: "node", args: ["--version"] }],
  };
}
function betaPolicy(): ProjectExecutionPolicy {
  return {
    allowedReadPrefixes: ["beta/"],
    allowedWritePrefixes: ["beta/"],
    allowedCommands: [{ cwd: "root", command: "node", args: ["-v"] }],
  };
}

// ---------------------------------------------------------------------------
// 8) 순차 생성 + 교차 시나리오 — A 생성 → B 생성 → 다시 A 사용해도 A는 그대로.
// ---------------------------------------------------------------------------
function scenarioSequentialAndCrossIsolation(alphaRoot: string, betaRoot: string): void {
  const alpha = createSafeExecutorContext(alphaRoot, alphaPolicy());

  check("[8] A.validateWritePath(alpha/a.txt) → ALLOW", alpha.validateWritePath("alpha/a.txt").ok);
  check("[8] A.validateWritePath(beta/b.txt) → BLOCK(A 정책 밖)", !alpha.validateWritePath("beta/b.txt").ok);

  const beta = createSafeExecutorContext(betaRoot, betaPolicy());

  check("[8] B.validateWritePath(beta/b.txt) → ALLOW", beta.validateWritePath("beta/b.txt").ok);
  check("[8] B.validateWritePath(alpha/a.txt) → BLOCK(B 정책 밖)", !beta.validateWritePath("alpha/a.txt").ok);

  // B를 생성/사용한 뒤에도 A의 root/policy는 그대로여야 한다(핵심 회귀 방지 포인트).
  check("[8] B 생성 이후에도 A.projectRoot가 그대로 alphaRoot", alpha.projectRoot === alphaRoot);
  check("[8] B 생성 이후에도 A.validateWritePath(alpha/a2.txt) → 여전히 ALLOW", alpha.validateWritePath("alpha/a2.txt").ok);
  check("[8] B 생성 이후에도 A.validateWritePath(beta/b.txt) → 여전히 BLOCK", !alpha.validateWritePath("beta/b.txt").ok);
  check("[8] A/B가 서로 다른 객체(같은 context를 공유하지 않음)", alpha !== (beta as unknown));
  check("[8] A.policy !== B.policy(정책 객체 자체도 분리됨)", (alpha.policy as unknown) !== (beta.policy as unknown));
}

// ---------------------------------------------------------------------------
// 9) Interleaving — 순차 생성만이 아니라 호출 자체를 A/B로 번갈아 섞는다.
// ---------------------------------------------------------------------------
async function scenarioInterleavedCalls(alphaRoot: string, betaRoot: string): Promise<void> {
  const alpha = createSafeExecutorContext(alphaRoot, alphaPolicy());
  const beta = createSafeExecutorContext(betaRoot, betaPolicy());

  // A read → B read → A write validation → B command validation → A write → B write
  const aRead = alpha.validateReadPath("alpha/");
  const bRead = beta.validateReadPath("beta/");
  check("[9] interleave: A read(alpha/) → ALLOW", aRead.ok);
  check("[9] interleave: B read(beta/) → ALLOW", bRead.ok);

  const aWriteCheck = alpha.validateWritePath("alpha/interleave-a.txt");
  const bCmdCheck = beta.validateCommand("node", ["-v"], "root");
  check("[9] interleave: A write validation → ALLOW", aWriteCheck.ok);
  check("[9] interleave: B command validation(node -v) → ALLOW", bCmdCheck.ok);
  check("[9] interleave: A command validation(node -v, B의 명령)은 여전히 BLOCK", !alpha.validateCommand("node", ["-v"], "root").ok);

  const aWriteResult = await alpha.validateAndExecute({ type: "WRITE_FILE", path: "alpha/interleave-a.txt", content: "A\n" });
  const bWriteResult = await beta.validateAndExecute({ type: "WRITE_FILE", path: "beta/interleave-b.txt", content: "B\n" });
  check("[9] interleave: A write 실행 성공", aWriteResult.ok);
  check("[9] interleave: B write 실행 성공", bWriteResult.ok);
  check("[9] interleave: A가 쓴 파일이 실제로 alphaRoot에 존재", existsSync(join(alphaRoot, "alpha", "interleave-a.txt")));
  check("[9] interleave: A가 쓴 파일이 betaRoot에는 없음", !existsSync(join(betaRoot, "alpha", "interleave-a.txt")));
  check("[9] interleave: B가 쓴 파일이 실제로 betaRoot에 존재", existsSync(join(betaRoot, "beta", "interleave-b.txt")));
  check("[9] interleave: B가 쓴 파일이 alphaRoot에는 없음", !existsSync(join(alphaRoot, "beta", "interleave-b.txt")));

  // 교차 시도(A executor로 B 영역에 쓰기) — 실제로 실행되지 않고 거부돼야 한다.
  const crossAttempt = await alpha.validateAndExecute({ type: "WRITE_FILE", path: "beta/should-not-exist.txt", content: "leak\n" });
  check("[9] interleave: A executor로 beta/ 쓰기 시도 → 실제 실행 거부(ok=false)", !crossAttempt.ok);
  check("[9] interleave: 거부된 교차 쓰기가 실제로 파일을 만들지 않음", !existsSync(join(betaRoot, "beta", "should-not-exist.txt")));
}

// ---------------------------------------------------------------------------
// 10) Promise.all 병렬 — 같은 이벤트 루프 안에서 A/B 작업을 실제로 동시에 실행한다.
// ---------------------------------------------------------------------------
async function scenarioPromiseAllParallel(alphaRoot: string, betaRoot: string): Promise<void> {
  const alpha = createSafeExecutorContext(alphaRoot, alphaPolicy());
  const beta = createSafeExecutorContext(betaRoot, betaPolicy());

  const N = 6;
  const alphaTasks = Array.from({ length: N }, (_, i) =>
    (async () => {
      await sleep(Math.random() * 8);
      return alpha.validateAndExecute({ type: "WRITE_FILE", path: `alpha/parallel-${i}.txt`, content: `alpha-${i}\n` });
    })()
  );
  const betaTasks = Array.from({ length: N }, (_, i) =>
    (async () => {
      await sleep(Math.random() * 8);
      return beta.validateAndExecute({ type: "WRITE_FILE", path: `beta/parallel-${i}.txt`, content: `beta-${i}\n` });
    })()
  );

  const [alphaResults, betaResults] = await Promise.all([Promise.all(alphaTasks), Promise.all(betaTasks)]);

  check("[10] Promise.all: Alpha의 모든 write가 성공", alphaResults.every((r) => r.ok));
  check("[10] Promise.all: Beta의 모든 write가 성공", betaResults.every((r) => r.ok));

  const alphaFiles = readdirSync(join(alphaRoot, "alpha"));
  const betaFiles = readdirSync(join(betaRoot, "beta"));
  check("[10] Promise.all: alphaRoot/alpha/에 Alpha 파일만 존재(N개)", alphaFiles.filter((f) => f.startsWith("parallel-")).length === N);
  check("[10] Promise.all: betaRoot/beta/에 Beta 파일만 존재(N개)", betaFiles.filter((f) => f.startsWith("parallel-")).length === N);
  check("[10] Promise.all: alphaRoot에 beta/ 디렉터리가 생기지 않음", !existsSync(join(alphaRoot, "beta")));
  check("[10] Promise.all: betaRoot에 alpha/ 디렉터리가 생기지 않음", !existsSync(join(betaRoot, "alpha")));
  check("[10] Promise.all 이후에도 alpha.projectRoot가 그대로", alpha.projectRoot === alphaRoot);
  check("[10] Promise.all 이후에도 beta.projectRoot가 그대로", beta.projectRoot === betaRoot);
}

// ---------------------------------------------------------------------------
// 12) Claude Developer 격리 — Developer A/B가 같은 프로세스에 존재해도 각자 자신의
//     executor만 쓴다. 실제 Claude CLI는 호출하지 않는다(claudeCaller fake 주입).
// ---------------------------------------------------------------------------
function makeFixedClaudeCaller(scriptedResponses: string[]): (input: string, timeoutMs: number) => Promise<{
  success: true;
  summary: string;
  changedFiles: string[];
  tests: never[];
  rawOutput: string;
}> {
  let i = 0;
  return async () => {
    const summary = scriptedResponses[Math.min(i, scriptedResponses.length - 1)];
    i++;
    return { success: true, summary, changedFiles: [], tests: [], rawOutput: summary };
  };
}

async function scenarioDeveloperUsesCorrectExecutor(alphaRoot: string, betaRoot: string): Promise<void> {
  const alpha = createSafeExecutorContext(alphaRoot, alphaPolicy());
  const beta = createSafeExecutorContext(betaRoot, betaPolicy());

  const alphaWrite = JSON.stringify({
    type: "ACTION_REQUEST",
    actions: [{ type: "WRITE_FILE", path: "alpha/dev-a.txt", content: "developer-A\n" }],
  });
  const alphaComplete = JSON.stringify({ type: "TASK_COMPLETE", summary: "A done", changedFiles: ["alpha/dev-a.txt"], testsRequested: [] });
  const betaWrite = JSON.stringify({
    type: "ACTION_REQUEST",
    actions: [{ type: "WRITE_FILE", path: "beta/dev-b.txt", content: "developer-B\n" }],
  });
  const betaComplete = JSON.stringify({ type: "TASK_COMPLETE", summary: "B done", changedFiles: ["beta/dev-b.txt"], testsRequested: [] });

  // 실제로 "같은 process에 두 developer가 동시에 존재"함을 증명하기 위해 Promise.all로
  // 두 runDeveloperTaskViaSafeExecutor 호출을 겹쳐서 실행한다.
  const [devAResult, devBResult] = await Promise.all([
    runDeveloperTaskViaSafeExecutor("Developer A task", 1, {
      claudeCaller: makeFixedClaudeCaller([alphaWrite, alphaComplete]),
      executor: alpha,
    }),
    runDeveloperTaskViaSafeExecutor("Developer B task", 1, {
      claudeCaller: makeFixedClaudeCaller([betaWrite, betaComplete]),
      executor: beta,
    }),
  ]);

  check("[12] Developer A 성공", devAResult.success === true);
  check("[12] Developer B 성공", devBResult.success === true);
  check("[12] Developer A의 ACTION_REQUEST가 alphaRoot에만 파일을 만듦", existsSync(join(alphaRoot, "alpha", "dev-a.txt")));
  check("[12] Developer A가 betaRoot를 건드리지 않음", !existsSync(join(betaRoot, "alpha", "dev-a.txt")));
  check("[12] Developer B의 ACTION_REQUEST가 betaRoot에만 파일을 만듦", existsSync(join(betaRoot, "beta", "dev-b.txt")));
  check("[12] Developer B가 alphaRoot를 건드리지 않음", !existsSync(join(alphaRoot, "beta", "dev-b.txt")));

  // Developer A가 (실수로든 악의적으로든) B의 영역에 쓰려는 ACTION_REQUEST를 받으면
  // A의 executor(alphaPolicy)가 거부해야 한다 — Developer가 "자신의" executor만 쓴다는
  // 직접 증거.
  const alphaAttemptsBetaWrite = JSON.stringify({
    type: "ACTION_REQUEST",
    actions: [{ type: "WRITE_FILE", path: "beta/leak.txt", content: "leak\n" }],
  });
  const alphaGivesUp = JSON.stringify({ type: "TASK_COMPLETE", summary: "gave up after denial", changedFiles: [], testsRequested: [] });
  const leakResult = await runDeveloperTaskViaSafeExecutor("Developer A tries beta/", 1, {
    claudeCaller: makeFixedClaudeCaller([alphaAttemptsBetaWrite, alphaGivesUp]),
    executor: alpha,
  });
  check("[12] Developer A가 자신의 executor로 beta/ 쓰기를 시도해도 실제로 실행되지 않음", !existsSync(join(betaRoot, "beta", "leak.txt")));
  check("[12] Developer A(beta/ 쓰기 거부 후 포기) 자체는 TASK_COMPLETE로 정상 종료", leakResult.success === true);
}

// ---------------------------------------------------------------------------
// 11) Checkpoint가 다른 repo로 새지 않는지 확인 — checkpoint.ts는 이미 cwd를 명시적으로
//     받고 Safe Executor 전역과 무관하다(§ CLAUDE 지시 요구사항 11 "불필요한 중복 테스트를
//     만들지 말고 그 사실을 검증/보고"). 여기서는 그 사실을 두 개의 disposable git repo +
//     두 개의 독립 SafeExecutorContext로 직접 한 번 증명한다.
// ---------------------------------------------------------------------------
function makeGitRepo(prefix: string, writableDir: string): string {
  const dir = makeProjectRoot(prefix, writableDir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "safe-executor-context-tests@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Safe Executor Context Tests"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function fakeTask(id: string, allowedPathPrefixes: string[]): TaskDefinition {
  return {
    id,
    phase: 1,
    taskNumber: 1,
    title: `checkpoint isolation ${id}`,
    prompt: "(테스트 전용)",
    requiredTests: [],
    allowedPathPrefixes,
    prohibitedOperations: [],
  };
}

function scenarioCheckpointDoesNotLeakAcrossRepos(alphaRepo: string, betaRepo: string): void {
  writeFileSync(join(alphaRepo, "alpha", "checkpoint-a.txt"), "a\n", "utf-8");
  writeFileSync(join(betaRepo, "beta", "checkpoint-b.txt"), "b\n", "utf-8");

  const alphaOutcome = performTaskCheckpoint(fakeTask("ALPHA-1", ["alpha/"]), {
    decision: "PASS",
    severity: { critical: 0, high: 0, medium: 0 },
    requiredTestsAllPassed: true,
    cwd: alphaRepo,
  });
  const betaOutcome = performTaskCheckpoint(fakeTask("BETA-1", ["beta/"]), {
    decision: "PASS",
    severity: { critical: 0, high: 0, medium: 0 },
    requiredTestsAllPassed: true,
    cwd: betaRepo,
  });

  check("[11] Alpha checkpoint ok=true", alphaOutcome.ok === true);
  check("[11] Beta checkpoint ok=true", betaOutcome.ok === true);
  check(
    "[11] Alpha commit에 alpha/checkpoint-a.txt만 포함",
    JSON.stringify(alphaOutcome.filesCommitted) === JSON.stringify(["alpha/checkpoint-a.txt"])
  );
  check(
    "[11] Beta commit에 beta/checkpoint-b.txt만 포함",
    JSON.stringify(betaOutcome.filesCommitted) === JSON.stringify(["beta/checkpoint-b.txt"])
  );

  const alphaLog = spawnSync("git", ["log", "--oneline"], { cwd: alphaRepo, encoding: "utf-8" }).stdout || "";
  const betaLog = spawnSync("git", ["log", "--oneline"], { cwd: betaRepo, encoding: "utf-8" }).stdout || "";
  check("[11] Alpha repo에 커밋 2건(init+checkpoint), Beta 내용이 섞이지 않음", alphaLog.trim().split("\n").length === 2 && !alphaLog.includes("checkpoint-b"));
  check("[11] Beta repo에 커밋 2건(init+checkpoint), Alpha 내용이 섞이지 않음", betaLog.trim().split("\n").length === 2 && !betaLog.includes("checkpoint-a"));
}

// ---------------------------------------------------------------------------
// 22) Source Regression — production 경로가 실제로 module-global mutable state를 쓰지
//     않는다는 것을 소스 레벨로도 확인한다.
// ---------------------------------------------------------------------------
function scenarioSourceRegression(): void {
  const safeExecutorSrc = readFileSync(join(__dirname, "..", "src", "safe-executor.ts"), "utf-8");
  const autodevSrc = readFileSync(join(__dirname, "..", "src", "autodev.ts"), "utf-8");
  const claudeDeveloperSrc = readFileSync(join(__dirname, "..", "src", "claude-developer.ts"), "utf-8");

  check(
    "[22-A] autodev.ts가 configureSafeExecutor()(module-global setter)를 호출하지 않음",
    !/configureSafeExecutor\(/.test(autodevSrc)
  );
  check(
    "[22-A] autodev.ts가 createSafeExecutorContext(manifest.targetProjectRoot, manifest.executionPolicy)를 명시적으로 호출함",
    /createSafeExecutorContext\(manifest\.targetProjectRoot,\s*manifest\.executionPolicy\)/.test(autodevSrc)
  );

  // createSafeExecutorContext()가 반환하는 buildContext()의 실제 검증/실행 로직은
  // module-level singleton(PROJECT_ROOT/PROJECT_ROOT_REAL/activeContext)을 전혀 참조하지
  // 않는다 — buildContext 함수 본문(다음 export까지) 안에 그 식별자가 등장하지 않는지 직접
  // 검사한다.
  const buildContextStart = safeExecutorSrc.indexOf("function buildContext(");
  const buildContextEnd = safeExecutorSrc.indexOf("\nexport function createSafeExecutorContext");
  const buildContextBody = safeExecutorSrc.slice(buildContextStart, buildContextEnd);
  check("[22-C] buildContext() 함수를 실제로 찾음(회귀 검사 대상 확보)", buildContextStart !== -1 && buildContextEnd !== -1);
  check(
    "[22-C] buildContext() 본문이 module-level singleton(activeContext)을 참조하지 않음",
    !/activeContext/.test(buildContextBody)
  );

  check(
    "[22-B] claude-developer.ts의 ACTION_REQUEST 처리가 executor 미지정 시에만 폴백하는 doValidateAndExecute를 통해서만 validateAndExecute를 호출함(직접 호출 없음)",
    !/await validateAndExecute\(rawAction\)/.test(claudeDeveloperSrc) && /doValidateAndExecute\(rawAction\)/.test(claudeDeveloperSrc)
  );
}

async function main(): Promise<void> {
  const alphaRoot = makeProjectRoot("safe-executor-ctx-alpha-", "alpha");
  const betaRoot = makeProjectRoot("safe-executor-ctx-beta-", "beta");
  const alphaRepo = makeGitRepo("safe-executor-ctx-alpha-repo-", "alpha");
  const betaRepo = makeGitRepo("safe-executor-ctx-beta-repo-", "beta");

  try {
    scenarioSequentialAndCrossIsolation(alphaRoot, betaRoot);
    await scenarioInterleavedCalls(alphaRoot, betaRoot);
    await scenarioPromiseAllParallel(alphaRoot, betaRoot);
    await scenarioDeveloperUsesCorrectExecutor(alphaRoot, betaRoot);
    scenarioCheckpointDoesNotLeakAcrossRepos(alphaRepo, betaRepo);
    scenarioSourceRegression();
  } finally {
    for (const dir of [alphaRoot, betaRoot, alphaRepo, betaRepo]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 디렉터리 정리 실패는 테스트 결과에 영향 없음
      }
    }
  }

  console.log("\n=== Safe Executor Per-Run Execution Context 격리(Phase C Task C2) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
