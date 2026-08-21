import { existsSync, unlinkSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { runDeveloperTaskViaSafeExecutor } from "./claude-developer";
import { PROJECT_ROOT, configureSafeExecutor } from "./safe-executor";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { RealClaudeResult, ClaudeErrorCode } from "./claude-runner";
import type { RequiredTestCommand } from "./task-registry";

// 실제 claude CLI를 호출하지 않는다 — DeveloperTaskOptions.claudeCaller에 스크립트된 fake
// 응답을 주입해, claude-developer.ts의 라운드 진행/bounded discovery/nudge/PLAN/필수테스트
// 실행 로직만 독립적으로 검증한다(§ claude-runner/safe-executor 자체는 각각
// runner-tests.ts/safe-executor-tests.ts가 이미 커버). ACTION_REQUEST의 READ_FILES/
// WRITE_FILE은 실제 Safe Executor를 그대로 통과해 automation/ 범위 안에서 실제로
// 실행된다(읽기 전용 파일은 실제 존재하는 automation/src 파일들, 쓰기는 전용 fixture 하나).
//
// REVISE(bounded discovery) — 실제 Phase 13 Task 2 E2E 라이브 실행에서 Claude가 20라운드
// 내내 서로 다른(novel) 파일만 계속 읽고 단 한 번도 WRITE_FILE에 도달하지 못한 채
// TASK_ACTION_LIMIT으로 종료되는 사례가 실제로 발생했다. 이전 novelty 기반 무진척 감지는
// "같은 요청 반복"만 막았지 "계속 새 파일만 넓게 탐색"은 막지 못했다 — 이 파일의 시나리오는
// 그 실패를 직접 재현/검증한다.
//
// Phase B Task B2 — 물리적 repository 분리 이전에는 이 파일이 MOVAN_PROJECT_MANIFEST(targetProjectRoot=
// 실제 MOVAN repo root)를 그대로 주입해 실행했다 — PROJECT_ROOT가 곧 이 automation/ 소스가
// 실제로 존재하는 MOVAN repo였기 때문에 "automation/src/*.ts"가 항상 읽을 수 있었다.
// AutoDev standalone repo에서는 PROJECT_ROOT(targetProjectRoot)가 MOVAN repo와 전혀 무관한
// 임의의 경로일 수 있으므로, 이 파일은 이제 스스로 격리된 임시 git repo를 만들어(§
// makeIsolatedTestRoot) 그 안에 이 repo 자신의 src/*.ts 파일 9개를 automation/src/ 밑에 복사해
// 넣은 뒤 그 임시 repo를 PROJECT_ROOT로 주입한다 — 어떤 프로젝트가 실제 target으로 설정돼
// 있든(또는 아무것도 설정돼 있지 않든) 이 Core 단위테스트가 항상 동일하게 동작한다.
const TEST_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["automation/"],
  allowedWritePrefixes: ["automation/"],
  allowedCommands: [{ cwd: "root", command: "git", args: ["status", "--short"] }],
};

function makeIsolatedTestRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "claude-developer-tests-"));
  spawnSync("git", ["init", "-q"], { cwd: root });
  spawnSync("git", ["config", "user.email", "claude-developer-tests@example.com"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Claude Developer Tests"], { cwd: root });
  const srcDir = join(root, "automation", "src");
  mkdirSync(srcDir, { recursive: true });
  const thisRepoSrcDir = join(__dirname, "..", "src"); // 빌드 후 dist 기준 이 repo 자신의 src/
  for (const rel of DISTINCT_REAL_FILES) {
    const base = rel.split("/").pop() as string;
    copyFileSync(join(thisRepoSrcDir, base), join(srcDir, base));
  }
  writeFileSync(join(root, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep", "automation"], { cwd: root });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: root });
  return root;
}

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function makeScriptedClaudeCaller(scripts: string[]): {
  call: (input: string, timeoutMs: number) => Promise<RealClaudeResult>;
  callCount: () => number;
  receivedInputs: string[];
} {
  let i = 0;
  const receivedInputs: string[] = [];
  return {
    call: async (input: string) => {
      receivedInputs.push(input);
      const summary = scripts[Math.min(i, scripts.length - 1)];
      i++;
      return { success: true, summary, changedFiles: [], tests: [], rawOutput: summary };
    },
    callCount: () => i,
    receivedInputs,
  };
}

// USAGE_LIMIT continuation(3차 실전 E2E 사후 반영) 시나리오 전용 — 정상 JSON 응답 문자열과
// "이번 호출은 이 errorCode로 실패한다"를 섞어서 스크립트할 수 있어야, USAGE_LIMIT을 겪은
// 뒤 같은 라운드가 같은 transcript로 재시도되는지 직접 검증할 수 있다.
type UsageLimitScriptEntry = string | { errorCode: ClaudeErrorCode };
function makeUsageLimitAwareScriptedCaller(scripts: UsageLimitScriptEntry[]): {
  call: (input: string, timeoutMs: number) => Promise<RealClaudeResult>;
  callCount: () => number;
  receivedInputs: string[];
} {
  let i = 0;
  const receivedInputs: string[] = [];
  return {
    call: async (input: string) => {
      receivedInputs.push(input);
      const entry = scripts[Math.min(i, scripts.length - 1)];
      i++;
      if (typeof entry === "string") {
        return { success: true, summary: entry, changedFiles: [], tests: [], rawOutput: entry };
      }
      return {
        success: false,
        summary: `simulated ${entry.errorCode}`,
        changedFiles: [],
        tests: [],
        rawOutput: `simulated ${entry.errorCode}`,
        errorCode: entry.errorCode,
      };
    },
    callCount: () => i,
    receivedInputs,
  };
}

function makeFastSleep(): { sleep: (ms: number) => Promise<void>; callCount: () => number } {
  let count = 0;
  return { sleep: async () => { count += 1; }, callCount: () => count };
}

const READ_ONLY_ROUND = JSON.stringify({
  type: "ACTION_REQUEST",
  actions: [{ type: "READ_FILES", paths: ["automation/src/logger.ts"] }],
});

// 실제 automation/src 밑에 존재하는, 서로 다른 파일 9개 — 매 라운드 전부 새로운(=novel)
// 파일을 읽는 "넓게 탐색만 계속하는" 시나리오를 재현하는 데 쓴다.
const DISTINCT_REAL_FILES = [
  "automation/src/logger.ts",
  "automation/src/types.ts",
  "automation/src/policy.ts",
  "automation/src/state.ts",
  "automation/src/orchestrator.ts",
  "automation/src/safe-executor.ts",
  "automation/src/git-changes.ts",
  "automation/src/checkpoint.ts",
  "automation/src/task-registry.ts",
];
function novelReadRound(path: string): string {
  return JSON.stringify({ type: "ACTION_REQUEST", actions: [{ type: "READ_FILES", paths: [path] }] });
}

async function scenarioC_repeatedReadStagnationRegression(): Promise<void> {
  // C(회귀): 동일 요청을 계속 반복하는 worker는 20라운드를 다 채우지 않고, discovery 예산
  // (6회) 소진 시 nudge를 정확히 한 번 보낸 뒤 grace(3회) 안에도 코드 변경이 없으면
  // 무진척으로 조기 종료돼야 한다. round1~6: discoveryOnlyRoundCount 1→6(6에서 nudge 전송)
  // → round7~9: grace 1→3(3에서 실패) = 총 9회 호출.
  const scripted = makeScriptedClaudeCaller([READ_ONLY_ROUND]);
  const result = await runDeveloperTaskViaSafeExecutor("무진척 시나리오(반복 read)", 1, { claudeCaller: scripted.call });

  check("C: success=false", result.success === false);
  check("C: errorCode=NO_PROGRESS_STAGNATION", result.errorCode === "NO_PROGRESS_STAGNATION");
  check("C: nudge 이후에도 무진척이면 정확히 9회에서 조기 종료", scripted.callCount() === 9);
  check("C: claude 호출 횟수가 MAX_INTERNAL_ROUNDS(20) 미만", scripted.callCount() < 20);
  check(
    "C: nudge 메시지가 실제로 이후 라운드 입력에 포함됨(구현 단계 전환 안내)",
    scripted.receivedInputs.some((inp) => inp.includes("AutoDev 안내") && inp.includes("WRITE_FILE"))
  );
}

async function scenarioC2_novelDiscoveryLoopBounded(): Promise<void> {
  // C2(핵심 신규 시나리오 — 실제 라이브 실패 재현): 매 라운드 서로 다른(novel) 파일을
  // 계속 READ하는 worker도 MAX_INTERNAL_ROUNDS(20)까지 가지 않고 C와 정확히 동일하게
  // bounded discovery/nudge가 작동해 9회에서 조기 종료돼야 한다 — novelty 여부가
  // discovery 예산 소진을 막지 못한다는 것을 직접 증명한다.
  const scripts = DISTINCT_REAL_FILES.map(novelReadRound);
  const scripted = makeScriptedClaudeCaller(scripts);
  const result = await runDeveloperTaskViaSafeExecutor("무진척 시나리오(매번 새 파일 read)", 1, { claudeCaller: scripted.call });

  check("C2: success=false(novel 파일을 계속 읽어도 무진척으로 판정됨)", result.success === false);
  check("C2: errorCode=NO_PROGRESS_STAGNATION", result.errorCode === "NO_PROGRESS_STAGNATION");
  check("C2: MAX_INTERNAL_ROUNDS(20)까지 가지 않고 정확히 9회에서 조기 종료", scripted.callCount() === 9);
  check(
    "C2: nudge 메시지가 실제로 이후 라운드 입력에 포함됨",
    scripted.receivedInputs.some((inp) => inp.includes("AutoDev 안내") && inp.includes("새로운 파일을 계속 찾고 있더라도"))
  );
}

async function scenarioC3_novelDiscoveryThenNudgeThenWriteSucceeds(): Promise<void> {
  // C3: discovery 예산을 다 쓸 만큼(6회) 서로 다른 파일을 읽어 nudge를 받은 뒤에도,
  // 곧바로 WRITE_FILE로 전환하면(grace 안에서) 정상적으로 TASK_COMPLETE까지 성공해야
  // 한다 — "실패시키는 것이 아니라 구현 단계로 전환시키는 것"이 목적임을 확인한다.
  const fixtureRel = "automation/tmp-claude-developer-c3-fixture.txt";
  const fixtureAbs = resolve(PROJECT_ROOT, fixtureRel);
  const writeRound = JSON.stringify({
    type: "ACTION_REQUEST",
    actions: [{ type: "WRITE_FILE", path: fixtureRel, content: "post-nudge write\n" }],
  });
  const taskComplete = JSON.stringify({ type: "TASK_COMPLETE", summary: "done-after-nudge", changedFiles: [fixtureRel], testsRequested: [] });

  const scripts = [...DISTINCT_REAL_FILES.slice(0, 6).map(novelReadRound), writeRound, taskComplete];
  const scripted = makeScriptedClaudeCaller(scripts);

  try {
    const result = await runDeveloperTaskViaSafeExecutor("novel discovery → nudge → write 시나리오", 1, {
      claudeCaller: scripted.call,
    });
    check("C3: nudge 이후 WRITE로 전환하면 정상 성공", result.success === true);
    check("C3: errorCode가 NO_PROGRESS_STAGNATION이 아님", result.errorCode !== "NO_PROGRESS_STAGNATION");
    check("C3: summary가 TASK_COMPLETE 값과 일치", result.summary === "done-after-nudge");
    check("C3: 정확히 8라운드 소모(6 discovery + nudge 유발 + write + complete)", scripted.callCount() === 8);
  } finally {
    if (existsSync(fixtureAbs)) unlinkSync(fixtureAbs);
  }
}

async function scenarioC4_normalShortDiscoveryThenWriteSucceeds(): Promise<void> {
  // C4: 정상적인 짧은 초기 조사(예산 6회 미만) 뒤 곧바로 WRITE로 이어지면, nudge조차
  // 발생하지 않고 그대로 성공해야 한다(정상 흐름이 방해받지 않음을 확인).
  const fixtureRel = "automation/tmp-claude-developer-c4-fixture.txt";
  const fixtureAbs = resolve(PROJECT_ROOT, fixtureRel);
  const writeRound = JSON.stringify({
    type: "ACTION_REQUEST",
    actions: [{ type: "WRITE_FILE", path: fixtureRel, content: "short discovery then write\n" }],
  });
  const taskComplete = JSON.stringify({ type: "TASK_COMPLETE", summary: "done-short-discovery", changedFiles: [fixtureRel], testsRequested: [] });

  const scripts = [...DISTINCT_REAL_FILES.slice(0, 3).map(novelReadRound), writeRound, taskComplete];
  const scripted = makeScriptedClaudeCaller(scripts);

  try {
    const result = await runDeveloperTaskViaSafeExecutor("정상 초기 조사(3회) → write 시나리오", 1, {
      claudeCaller: scripted.call,
    });
    check("C4: 정상 성공", result.success === true);
    check("C4: summary가 TASK_COMPLETE 값과 일치", result.summary === "done-short-discovery");
    check("C4: 정확히 5라운드 소모(discovery 3 + write + complete), nudge 없이 통과", scripted.callCount() === 5);
    check(
      "C4: nudge 메시지가 전송되지 않음(예산 안에서 정상 종료)",
      !scripted.receivedInputs.some((inp) => inp.includes("AutoDev 안내"))
    );
  } finally {
    if (existsSync(fixtureAbs)) unlinkSync(fixtureAbs);
  }
}

async function scenarioD_writeFirstThenRepeatedReadNeverStagnates(): Promise<void> {
  // D(회귀): 실제 write 진척이 한 번이라도 있으면, 이후 read만 아무리 반복돼도(예산 초과
  // 포함) 조기 종료되지 않고 정상적으로 TASK_COMPLETE까지 진행돼야 한다 — 이 시나리오는
  // discovery 예산 로직 자체를 건드리지 않으므로 이번 REVISE로 회귀가 없어야 한다.
  const fixtureRel = "automation/tmp-claude-developer-progress-fixture.txt";
  const fixtureAbs = resolve(PROJECT_ROOT, fixtureRel);

  const writeRound = JSON.stringify({
    type: "ACTION_REQUEST",
    actions: [{ type: "WRITE_FILE", path: fixtureRel, content: "progress marker\n" }],
  });
  const readFixtureRound = JSON.stringify({
    type: "ACTION_REQUEST",
    actions: [{ type: "READ_FILES", paths: [fixtureRel] }],
  });
  const taskComplete = JSON.stringify({
    type: "TASK_COMPLETE",
    summary: "done",
    changedFiles: [fixtureRel],
    testsRequested: [],
  });

  // round1: write(진척 발생) → round2~9: read만 반복(8회, discovery 예산 6 초과) → round10: 완료.
  const scripts = [writeRound, ...Array(8).fill(readFixtureRound), taskComplete];
  const scripted = makeScriptedClaudeCaller(scripts);

  try {
    const result = await runDeveloperTaskViaSafeExecutor("write 후 read 반복 시나리오", 1, {
      claudeCaller: scripted.call,
    });

    check("D: success=true(조기 종료되지 않음)", result.success === true);
    check("D: errorCode가 NO_PROGRESS_STAGNATION이 아님", result.errorCode !== "NO_PROGRESS_STAGNATION");
    check("D: TASK_COMPLETE까지 전체 10라운드 정상 소모", scripted.callCount() === 10);
    check("D: summary가 TASK_COMPLETE 값과 일치", result.summary === "done");
  } finally {
    if (existsSync(fixtureAbs)) unlinkSync(fixtureAbs);
    check("D: fixture 정리 완료", !existsSync(fixtureAbs));
  }
}

async function scenarioE_planCannotResetDiscoveryBudgetIndefinitely(): Promise<void> {
  // E(REVISE) — 이전 버전은 PLAN이 무진척 카운터를 매번 0으로 리셋해, PLAN만 반복하면
  // 20라운드 전부를 소모한 뒤에야 TASK_ACTION_LIMIT으로 끝났다. 이제 PLAN도 discovery-only
  // 라운드로 예산에 그대로 포함되므로, PLAN만 반복해도 read 반복과 동일하게(9회) bounded
  // discovery/nudge로 조기 종료돼야 한다 — "PLAN 반복만으로 discovery budget을 무한
  // reset할 수 없음"을 직접 검증한다.
  const planRound = JSON.stringify({ type: "PLAN", summary: "구현 계획: A를 먼저 하고 B를 한다." });
  const scripted = makeScriptedClaudeCaller([planRound]);
  const result = await runDeveloperTaskViaSafeExecutor("PLAN만 반복하는 시나리오", 1, { claudeCaller: scripted.call });

  check("E: PLAN만 반복 → 결코 success=true가 아님(코드 변경 없이 완료 처리되지 않음)", result.success === false);
  check("E: errorCode=NO_PROGRESS_STAGNATION(더 이상 20라운드까지 가지 않음)", result.errorCode === "NO_PROGRESS_STAGNATION");
  check("E: PLAN 반복도 read 반복과 동일하게 정확히 9회에서 조기 종료(무한 리셋 불가)", scripted.callCount() === 9);
  check(
    "E: 잠금 중 2번째 이후 PLAN은 protocol-level rejection 메시지를 받음(1회 한도 초과가 실제로 거부됨)",
    scripted.receivedInputs.some((inp) => inp.includes("one-time post-lock PLAN has already been used"))
  );
}

async function scenarioF_planThenWriteSucceeds(): Promise<void> {
  // F: PLAN 이후 바로 WRITE_FILE → TASK_COMPLETE로 이어지면 정상 성공해야 한다(PLAN이
  // 방해가 되지 않음을 확인) — discovery 예산 안에서는 PLAN도 정상적인 흐름의 일부다.
  const fixtureRel = "automation/tmp-claude-developer-plan-fixture.txt";
  const fixtureAbs = resolve(PROJECT_ROOT, fixtureRel);
  const planRound = JSON.stringify({ type: "PLAN", summary: "먼저 fixture 파일을 만든다." });
  const writeRound = JSON.stringify({
    type: "ACTION_REQUEST",
    actions: [{ type: "WRITE_FILE", path: fixtureRel, content: "plan-then-write\n" }],
  });
  const taskComplete = JSON.stringify({ type: "TASK_COMPLETE", summary: "done-after-plan", changedFiles: [fixtureRel], testsRequested: [] });
  const scripted = makeScriptedClaudeCaller([planRound, writeRound, taskComplete]);

  try {
    const result = await runDeveloperTaskViaSafeExecutor("PLAN 후 구현 시나리오", 1, { claudeCaller: scripted.call });
    check("F: PLAN → WRITE → TASK_COMPLETE 정상 성공", result.success === true);
    check("F: summary가 TASK_COMPLETE 값과 일치", result.summary === "done-after-plan");
    check("F: 정확히 3라운드만 소모(PLAN이 불필요한 반복을 만들지 않음)", scripted.callCount() === 3);
  } finally {
    if (existsSync(fixtureAbs)) unlinkSync(fixtureAbs);
  }
}

async function scenarioG_requiredTestsExecutedForReal(): Promise<void> {
  // G: TASK_COMPLETE 이후 requiredTests가 AutoDev(Safe Executor)에 의해 실제로 실행되고,
  // 그 실제 exitCode가 DeveloperResult.tests에 반영되어야 한다 — Claude의 자체 보고
  // (summary/testsRequested)는 전혀 신뢰하지 않는다.
  const taskComplete = JSON.stringify({
    type: "TASK_COMPLETE",
    summary: "실제로는 아무 테스트도 안 돌렸지만 다 통과했다고 거짓 주장",
    changedFiles: [],
    testsRequested: ["존재하지-않는-가짜-테스트"],
  });
  const scripted = makeScriptedClaudeCaller([taskComplete]);
  // 실제로 allow-list에 있는, 빠르고 부작용 없는 명령을 requiredTests로 지정한다.
  const requiredTests: RequiredTestCommand[] = [{ name: "root:git-status", command: "git", args: ["status", "--short"], cwd: "root" }];

  const result = await runDeveloperTaskViaSafeExecutor("필수 테스트 실행 시나리오(성공)", 1, {
    claudeCaller: scripted.call,
    requiredTests,
  });

  check("G: success=true", result.success === true);
  check("G: tests 배열에 실제 requiredTests 이름이 담김(Claude가 보고한 가짜 이름이 아님)", result.tests.some((t) => t.name === "root:git-status"));
  check("G: 실제 exitCode 기준으로 pass=true", result.tests.find((t) => t.name === "root:git-status")?.pass === true);
  check("G: Claude가 자체 보고한 가짜 테스트 이름은 결과에 없음", !result.tests.some((t) => t.name === "존재하지-않는-가짜-테스트"));
}

async function scenarioH_requiredTestFailureReflectedForReal(): Promise<void> {
  // H: requiredTests에 allow-list 밖(잘못 설정된) 명령을 넣으면 실제로 거부되어
  // pass=false로 반영돼야 한다(Claude의 "성공" 주장과 무관하게 실제 실행 결과만 반영).
  const taskComplete = JSON.stringify({ type: "TASK_COMPLETE", summary: "성공했다고 주장", changedFiles: [], testsRequested: [] });
  const scripted = makeScriptedClaudeCaller([taskComplete]);
  const requiredTests: RequiredTestCommand[] = [
    { name: "root:git-status", command: "git", args: ["status", "--short"], cwd: "root" },
    { name: "misconfigured:not-allowed", command: "git", args: ["push"], cwd: "root" }, // allow-list에 없음 → 거부되어야 함
  ];

  const result = await runDeveloperTaskViaSafeExecutor("필수 테스트 실행 시나리오(실패 반영)", 1, {
    claudeCaller: scripted.call,
    requiredTests,
  });

  check("H: success=true(TASK_COMPLETE 자체는 성공)", result.success === true);
  check("H: 정상 명령은 pass=true", result.tests.find((t) => t.name === "root:git-status")?.pass === true);
  check("H: allow-list 밖 명령은 pass=false로 실제 반영됨", result.tests.find((t) => t.name === "misconfigured:not-allowed")?.pass === false);
}

async function scenarioI_lockBlocksReadThenWriteSucceeds(): Promise<void> {
  // I(신규 — 2차 실전 E2E 실패 사후 반영 핵심 시나리오): discovery 예산(6회)을 다 쓴 뒤
  // 잠금(IMPLEMENTATION_REQUIRED) 상태에서 또 다른 새 파일을 READ 요청하면, 이번에는 그
  // 요청이 Safe Executor로 실제 실행되지 않고 protocol-level rejection만 돌아와야 한다.
  // 그 직후 WRITE_FILE로 전환하면 정상적으로 TASK_COMPLETE까지 성공해야 한다.
  const fixtureRel = "automation/tmp-claude-developer-i-fixture.txt";
  const fixtureAbs = resolve(PROJECT_ROOT, fixtureRel);
  const seventhRead = novelReadRound(DISTINCT_REAL_FILES[6]); // git-changes.ts — 잠금 후 요청되는 "7번째 READ"
  const writeRound = JSON.stringify({
    type: "ACTION_REQUEST",
    actions: [{ type: "WRITE_FILE", path: fixtureRel, content: "post-lock write\n" }],
  });
  const taskComplete = JSON.stringify({ type: "TASK_COMPLETE", summary: "done-after-lock-write", changedFiles: [fixtureRel], testsRequested: [] });

  const scripts = [...DISTINCT_REAL_FILES.slice(0, 6).map(novelReadRound), seventhRead, writeRound, taskComplete];
  const scripted = makeScriptedClaudeCaller(scripts);

  try {
    const result = await runDeveloperTaskViaSafeExecutor("잠금 후 READ 거부 → WRITE 성공 시나리오", 1, {
      claudeCaller: scripted.call,
    });
    check("I: 잠금 후 WRITE로 전환하면 정상 성공", result.success === true);
    check("I: errorCode가 NO_PROGRESS_STAGNATION이 아님", result.errorCode !== "NO_PROGRESS_STAGNATION");
    check("I: summary가 TASK_COMPLETE 값과 일치", result.summary === "done-after-lock-write");
    check("I: 정확히 9라운드 소모(6 discovery + 거부된 7번째 READ + write + complete)", scripted.callCount() === 9);

    // round 9(WRITE 요청 직전, 0-indexed[7])의 입력에 7번째 READ에 대한 protocol rejection이
    // 포함돼 있어야 하고, git-changes.ts의 실제 소스 내용(export function getWorkingTreeChanges)은
    // 전혀 포함되지 않아야 한다 — Safe Executor가 실제로 그 파일을 읽지 않았다는 직접 증거.
    const inputAfterSeventhRead = scripted.receivedInputs[7];
    check(
      "I: 7번째 READ 요청이 protocol-level rejection 메시지를 받음(Discovery budget exhausted)",
      inputAfterSeventhRead.includes("Discovery budget exhausted")
    );
    check(
      "I: 7번째 READ의 실제 파일 내용(git-changes.ts 소스)은 transcript에 전혀 없음 — Safe Executor가 실제로 실행하지 않았다는 증거",
      !inputAfterSeventhRead.includes("export function getWorkingTreeChanges")
    );
  } finally {
    if (existsSync(fixtureAbs)) unlinkSync(fixtureAbs);
  }
}

async function scenarioJ_lockBlocksContinuedReadUntilStagnation(): Promise<void> {
  // J(신규): 잠금 이후에도 계속 READ만 요청하면(더 이상 실제 실행되지 않고 매번 거부), 짧은
  // grace(IMPLEMENTATION_LOCK_GRACE=3) 안에 NO_PROGRESS_STAGNATION으로 조기 종료돼야 한다 —
  // 그리고 거부된 라운드들의 파일 내용은 transcript 어디에도 실제로 나타나면 안 된다.
  const scripts = DISTINCT_REAL_FILES.map(novelReadRound); // 9개 전부 READ만(6 discovery + 3 잠금 후 거부)
  const scripted = makeScriptedClaudeCaller(scripts);
  const result = await runDeveloperTaskViaSafeExecutor("잠금 후 READ 계속 반복 시나리오", 1, { claudeCaller: scripted.call });

  check("J: success=false(잠금 후 거부된 READ만 계속되면 무진척)", result.success === false);
  check("J: errorCode=NO_PROGRESS_STAGNATION", result.errorCode === "NO_PROGRESS_STAGNATION");
  check("J: 짧은 grace(3회) 안에 정확히 9회에서 조기 종료", scripted.callCount() === 9);
  check(
    "J: 잠금 후 거부된 라운드에 protocol rejection 메시지가 포함됨",
    scripted.receivedInputs.some((inp) => inp.includes("Discovery budget exhausted"))
  );
  // 7~9번째 READ 대상 파일(git-changes.ts, checkpoint.ts, task-registry.ts) 소스 내용은
  // 잠금 이후 요청이므로 transcript 어디에도 실제로 나타나면 안 된다.
  const fullTranscriptSeen = scripted.receivedInputs.join("\n");
  check(
    "J: 잠금 후 거부된 파일들의 실제 소스 내용은 어디에도 없음(export function getWorkingTreeChanges 등)",
    !fullTranscriptSeen.includes("export function getWorkingTreeChanges")
  );
}

async function scenarioK_lockPlanOnceThenWriteSucceeds(): Promise<void> {
  // K(신규): discovery 6회 후 잠금 상태에서 "구현 전환용" PLAN을 1회 사용하고 곧바로
  // WRITE_FILE로 이어가면 정상적으로 TASK_COMPLETE까지 성공해야 한다(PLAN 1회 허용이
  // 실제로 방해가 되지 않음을 확인).
  const fixtureRel = "automation/tmp-claude-developer-k-fixture.txt";
  const fixtureAbs = resolve(PROJECT_ROOT, fixtureRel);
  const planRound = JSON.stringify({ type: "PLAN", summary: "잠금 이후 구현 계획 정리." });
  const writeRound = JSON.stringify({
    type: "ACTION_REQUEST",
    actions: [{ type: "WRITE_FILE", path: fixtureRel, content: "post-lock plan then write\n" }],
  });
  const taskComplete = JSON.stringify({ type: "TASK_COMPLETE", summary: "done-after-lock-plan", changedFiles: [fixtureRel], testsRequested: [] });

  const scripts = [...DISTINCT_REAL_FILES.slice(0, 6).map(novelReadRound), planRound, writeRound, taskComplete];
  const scripted = makeScriptedClaudeCaller(scripts);

  try {
    const result = await runDeveloperTaskViaSafeExecutor("discovery 6회 → 잠금 PLAN 1회 → WRITE 시나리오", 1, {
      claudeCaller: scripted.call,
    });
    check("K: 잠금 중 PLAN 1회 → WRITE → TASK_COMPLETE 정상 성공", result.success === true);
    check("K: errorCode가 NO_PROGRESS_STAGNATION이 아님", result.errorCode !== "NO_PROGRESS_STAGNATION");
    check("K: summary가 TASK_COMPLETE 값과 일치", result.summary === "done-after-lock-plan");
    check("K: 정확히 9라운드 소모(6 discovery + PLAN 1회 + write + complete)", scripted.callCount() === 9);
  } finally {
    if (existsSync(fixtureAbs)) unlinkSync(fixtureAbs);
  }
}

async function scenarioL_lockBlocksSearchSameAsRead(): Promise<void> {
  // L(신규): 잠금 이후 SEARCH-only 요청도 READ_FILES와 동일하게 실제 실행되지 않고
  // protocol-level rejection을 받아야 한다 — READ만 특별 취급하지 않는다는 것을 확인한다.
  const fixtureRel = "automation/tmp-claude-developer-l-fixture.txt";
  const fixtureAbs = resolve(PROJECT_ROOT, fixtureRel);
  const searchRound = JSON.stringify({
    type: "ACTION_REQUEST",
    actions: [{ type: "SEARCH", pattern: "getWorkingTreeChanges", globs: ["automation"] }],
  });
  const writeRound = JSON.stringify({
    type: "ACTION_REQUEST",
    actions: [{ type: "WRITE_FILE", path: fixtureRel, content: "post-lock search then write\n" }],
  });
  const taskComplete = JSON.stringify({ type: "TASK_COMPLETE", summary: "done-after-lock-search", changedFiles: [fixtureRel], testsRequested: [] });

  const scripts = [...DISTINCT_REAL_FILES.slice(0, 6).map(novelReadRound), searchRound, writeRound, taskComplete];
  const scripted = makeScriptedClaudeCaller(scripts);

  try {
    const result = await runDeveloperTaskViaSafeExecutor("잠금 후 SEARCH 거부 → WRITE 성공 시나리오", 1, {
      claudeCaller: scripted.call,
    });
    check("L: 잠금 후 SEARCH가 거부돼도 WRITE로 전환하면 정상 성공", result.success === true);
    check("L: 정확히 9라운드 소모(6 discovery + 거부된 SEARCH + write + complete)", scripted.callCount() === 9);

    const inputAfterSearch = scripted.receivedInputs[7];
    check(
      "L: SEARCH 요청도 READ와 동일하게 protocol-level rejection을 받음(Discovery budget exhausted)",
      inputAfterSearch.includes("Discovery budget exhausted")
    );
    check(
      "L: 거부된 SEARCH의 실제 검색 결과(matches)는 transcript에 없음 — 실제로 실행되지 않았다는 증거",
      !inputAfterSearch.includes('"matches"')
    );
  } finally {
    if (existsSync(fixtureAbs)) unlinkSync(fixtureAbs);
  }
}

async function scenarioM_usageLimitMidTaskPreservesTranscriptAndPartialWork(): Promise<void> {
  // M(신규 — 3차 실전 E2E 실패 사후 반영 핵심 시나리오): discovery → WRITE_FILE 성공 →
  // 다음 Claude call에서 USAGE_LIMIT → wait → 같은 transcript로 continuation → 추가 WRITE →
  // TASK_COMPLETE. USAGE_LIMIT 전후로 같은 라운드의 input(transcript)이 완전히 동일해야
  // 하고(재요청이지 새 세션이 아님), 이미 쓴 파일 내용도 이어서 누적돼야 한다.
  const fixtureRel = "automation/tmp-claude-developer-m-fixture.txt";
  const fixtureAbs = resolve(PROJECT_ROOT, fixtureRel);
  const readRound = novelReadRound(DISTINCT_REAL_FILES[0]);
  const writeStep1 = JSON.stringify({
    type: "ACTION_REQUEST",
    actions: [{ type: "WRITE_FILE", path: fixtureRel, content: "step1\n" }],
  });
  const writeStep2 = JSON.stringify({
    type: "ACTION_REQUEST",
    actions: [{ type: "WRITE_FILE", path: fixtureRel, content: "step1\nstep2-after-usage-limit\n" }],
  });
  const taskComplete = JSON.stringify({ type: "TASK_COMPLETE", summary: "done-after-mid-task-usage-limit", changedFiles: [fixtureRel], testsRequested: [] });

  const scripted = makeUsageLimitAwareScriptedCaller([readRound, writeStep1, { errorCode: "USAGE_LIMIT" }, writeStep2, taskComplete]);
  const fastSleep = makeFastSleep();
  const requiredTests: RequiredTestCommand[] = [{ name: "root:git-status", command: "git", args: ["status", "--short"], cwd: "root" }];

  try {
    const result = await runDeveloperTaskViaSafeExecutor("USAGE_LIMIT 도중 발생 시나리오", 1, {
      claudeCaller: scripted.call,
      sleep: fastSleep.sleep,
      usageLimitWaitMs: 1,
      requiredTests,
    });

    check("M: USAGE_LIMIT을 겪고도 정상 성공", result.success === true);
    check("M: summary가 TASK_COMPLETE 값과 일치", result.summary === "done-after-mid-task-usage-limit");
    check("M: 정확히 5회 Claude 호출(discovery1 + write1 + usageLimit재시도1 + write2 + complete)", scripted.callCount() === 5);
    check("M: USAGE_LIMIT 재시도가 정확히 1회 발생(sleep 1회 호출)", fastSleep.callCount() === 1);
    check(
      "M: USAGE_LIMIT 직전/재시도 호출의 input(transcript)이 완전히 동일함(새 세션이 아니라 같은 라운드 재요청)",
      scripted.receivedInputs[2] === scripted.receivedInputs[3]
    );
    check("M: requiredTests까지 정상 진입", result.tests.some((t) => t.name === "root:git-status"));

    const finalContent = existsSync(fixtureAbs) ? readFileSync(fixtureAbs, "utf-8") : "";
    check("M: USAGE_LIMIT 이전 write(step1)와 이후 write(step2)가 모두 반영됨(파일이 유지된 채 이어서 진행)", finalContent.includes("step1") && finalContent.includes("step2-after-usage-limit"));
  } finally {
    if (existsSync(fixtureAbs)) unlinkSync(fixtureAbs);
  }
}

async function scenarioN_usageLimitAfterImplementationLockThenResumeSucceeds(): Promise<void> {
  // N(신규): discovery 6회 → implementation lock → WRITE 성공 → USAGE_LIMIT → resume →
  // TASK_COMPLETE. 잠금 상태(implementationLocked/discoveryOnlyRoundCount 등)가 USAGE_LIMIT
  // 재시도로 인해 리셋되지 않는다는 것을 간접적으로도 증명한다 — 만약 리셋됐다면 이후
  // WRITE 없는 라운드가 다시 정상 discovery로 취급됐을 텐데, 여기서는 애초에 write 뒤
  // 곧바로 TASK_COMPLETE라 재잠금 여부를 시험할 필요조차 없이 그냥 성공해야 한다.
  const fixtureRel = "automation/tmp-claude-developer-n-fixture.txt";
  const fixtureAbs = resolve(PROJECT_ROOT, fixtureRel);
  const writeRound = JSON.stringify({
    type: "ACTION_REQUEST",
    actions: [{ type: "WRITE_FILE", path: fixtureRel, content: "post-lock write before usage limit\n" }],
  });
  const taskComplete = JSON.stringify({ type: "TASK_COMPLETE", summary: "done-after-lock-usage-limit", changedFiles: [fixtureRel], testsRequested: [] });

  const scripts: UsageLimitScriptEntry[] = [...DISTINCT_REAL_FILES.slice(0, 6).map(novelReadRound), writeRound, { errorCode: "USAGE_LIMIT" }, taskComplete];
  const scripted = makeUsageLimitAwareScriptedCaller(scripts);
  const fastSleep = makeFastSleep();

  try {
    const result = await runDeveloperTaskViaSafeExecutor("잠금 이후 USAGE_LIMIT → resume 시나리오", 1, {
      claudeCaller: scripted.call,
      sleep: fastSleep.sleep,
      usageLimitWaitMs: 1,
    });

    check("N: 잠금 이후 USAGE_LIMIT을 겪고도 정상 성공", result.success === true);
    check("N: summary가 TASK_COMPLETE 값과 일치", result.summary === "done-after-lock-usage-limit");
    check("N: 정확히 9회 Claude 호출(6 discovery + write + usageLimit재시도1 + complete)", scripted.callCount() === 9);
    check(
      "N: USAGE_LIMIT 직전/재시도 호출의 input이 완전히 동일함(잠금 상태를 포함한 transcript가 그대로 유지됨)",
      scripted.receivedInputs[7] === scripted.receivedInputs[8]
    );
  } finally {
    if (existsSync(fixtureAbs)) unlinkSync(fixtureAbs);
  }
}

async function scenarioO_manyConsecutiveUsageLimitRetriesStillRecoverWithoutConsumingRoundBudget(): Promise<void> {
  // O(신규): USAGE_LIMIT이 MAX_INTERNAL_ROUNDS(20)보다 많은 횟수(22회) 연속으로 발생해도,
  // round 카운터를 전혀 소비하지 않으므로 결국 정상 복구돼야 한다 — round가 잘못 소비됐다면
  // 20라운드를 넘겨 TASK_ACTION_LIMIT으로 실패했을 것이다. 이 하나의 시나리오가
  // "USAGE_LIMIT 여러 번 → 정상 복구"와 "round budget 미소비"를 동시에 직접 증명한다.
  const fixtureRel = "automation/tmp-claude-developer-o-fixture.txt";
  const fixtureAbs = resolve(PROJECT_ROOT, fixtureRel);
  const writeRound = JSON.stringify({
    type: "ACTION_REQUEST",
    actions: [{ type: "WRITE_FILE", path: fixtureRel, content: "progress before many usage limits\n" }],
  });
  const taskComplete = JSON.stringify({ type: "TASK_COMPLETE", summary: "done-after-many-usage-limits", changedFiles: [fixtureRel], testsRequested: [] });
  const manyUsageLimits: UsageLimitScriptEntry[] = Array(22).fill({ errorCode: "USAGE_LIMIT" as const });

  const scripted = makeUsageLimitAwareScriptedCaller([writeRound, ...manyUsageLimits, taskComplete]);
  const fastSleep = makeFastSleep();

  try {
    const result = await runDeveloperTaskViaSafeExecutor("USAGE_LIMIT 22회 연속 시나리오", 1, {
      claudeCaller: scripted.call,
      sleep: fastSleep.sleep,
      usageLimitWaitMs: 1,
      usageLimitMaxRetries: 25,
    });

    check("O: MAX_INTERNAL_ROUNDS(20)보다 많은 USAGE_LIMIT(22회)을 겪고도 정상 복구", result.success === true);
    check("O: summary가 TASK_COMPLETE 값과 일치", result.summary === "done-after-many-usage-limits");
    check("O: 총 24회 Claude 호출(write1 + usageLimit 22회 + complete) — round 20 제한과 무관하게 성공", scripted.callCount() === 24);
    check("O: sleep이 정확히 22회 호출됨(매 USAGE_LIMIT마다 대기)", fastSleep.callCount() === 22);
    check("O: errorCode가 TASK_ACTION_LIMIT이 아님(round budget이 소비되지 않았다는 직접 증거)", result.errorCode !== "TASK_ACTION_LIMIT");
  } finally {
    if (existsSync(fixtureAbs)) unlinkSync(fixtureAbs);
  }
}

async function scenarioP_usageLimitRetryExhaustionReturnsFailureWithoutHanging(): Promise<void> {
  // P: usageLimitMaxRetries를 초과하도록 USAGE_LIMIT만 계속되면(끝내 복구되지 않으면),
  // 무한 대기하지 않고 정확히 그 횟수만큼 재시도한 뒤 실패를 반환해야 한다(오케스트레이터가
  // 이를 넘겨받아 WAITING_HUMAN으로 전환할 수 있도록).
  const allUsageLimits: UsageLimitScriptEntry[] = Array(10).fill({ errorCode: "USAGE_LIMIT" as const });
  const scripted = makeUsageLimitAwareScriptedCaller(allUsageLimits);
  const fastSleep = makeFastSleep();

  const result = await runDeveloperTaskViaSafeExecutor("USAGE_LIMIT 재시도 예산 초과 시나리오", 1, {
    claudeCaller: scripted.call,
    sleep: fastSleep.sleep,
    usageLimitWaitMs: 1,
    usageLimitMaxRetries: 3,
  });

  check("P: 재시도 예산(3회) 초과 시 무한 대기하지 않고 실패 반환", result.success === false);
  check("P: errorCode=USAGE_LIMIT(오케스트레이터가 WAITING_HUMAN으로 처리할 수 있도록)", result.errorCode === "USAGE_LIMIT");
  check("P: sleep이 정확히 재시도 한도(3회)만큼만 호출됨", fastSleep.callCount() === 3);
  check("P: 총 Claude 호출 4회(최초 1회 + 재시도 3회)", scripted.callCount() === 4);
}

async function scenarioQ_nonRetriableClaudeErrorFailsImmediatelyWithoutRetry(): Promise<void> {
  // Q: AUTH_REQUIRED(계정 인증 문제 — GPT 레벨 AUTH_ERROR/QUOTA_EXCEEDED에 대응하는 Claude
  // 레벨의 실제 non-retriable 에러코드)는 USAGE_LIMIT과 달리 재시도 대상이 아니다 — 기존과
  // 동일하게 즉시 실패를 반환해 오케스트레이터가 WAITING_HUMAN으로 전환하게 해야 한다.
  const scripted = makeUsageLimitAwareScriptedCaller([{ errorCode: "AUTH_REQUIRED" }]);
  const fastSleep = makeFastSleep();

  const result = await runDeveloperTaskViaSafeExecutor("non-retriable 오류 시나리오", 1, {
    claudeCaller: scripted.call,
    sleep: fastSleep.sleep,
  });

  check("Q: success=false", result.success === false);
  check("Q: errorCode=AUTH_REQUIRED(USAGE_LIMIT으로 오분류되지 않음)", result.errorCode === "AUTH_REQUIRED");
  check("Q: 재시도 없이 즉시 실패(호출 1회만)", scripted.callCount() === 1);
  check("Q: sleep이 전혀 호출되지 않음(재시도 대상이 아님)", fastSleep.callCount() === 0);
}

async function scenarioR_resumeContextDetectedForExistingInScopeChanges(): Promise<void> {
  // R(신규): 새 developer 실행이 불가피한 상황(예: 재시도 예산을 다 쓴 뒤 새 프로세스로
  // 재시작)에서도, 시작 시 task.allowedPathPrefixes 안에 이미 존재하는 uncommitted 변경을
  // 감지해 "버리지 말고 이어서 진행하라"는 안내를 초기 transcript에 포함시켜야 한다.
  // "tmp-" 접두사 파일은 git-changes.ts의 TEMP_FILE_PATTERNS에 의해 review/commit 대상에서
  // 의도적으로 제외된다(다른 시나리오들이 fixture로 tmp-*를 쓰는 이유) — 이 시나리오는 정반대로
  // "실제 in-scope 변경으로 감지돼야" 하므로 일부러 tmp- 접두사를 쓰지 않는다.
  const fixtureRel = "automation/claude-developer-resume-fixture.txt";
  const fixtureAbs = resolve(PROJECT_ROOT, fixtureRel);
  writeFileSync(fixtureAbs, "이전 시도가 이미 만들어둔 미완성 작업물\n", "utf-8");

  const taskComplete = JSON.stringify({ type: "TASK_COMPLETE", summary: "done-resume-aware", changedFiles: [], testsRequested: [] });
  const scripted = makeScriptedClaudeCaller([taskComplete]);

  try {
    const result = await runDeveloperTaskViaSafeExecutor("재개 컨텍스트 감지 시나리오", 1, {
      claudeCaller: scripted.call,
      allowedPathPrefixes: ["automation/claude-developer-resume-fixture.txt"],
    });

    check("R: 정상 성공(재개 안내가 진행을 방해하지 않음)", result.success === true);
    check(
      "R: 초기 입력에 재개 안내 문구가 포함됨(Existing in-scope partial changes)",
      scripted.receivedInputs[0].includes("Existing in-scope partial changes from the previous attempt were detected")
    );
    check(
      "R: 재개 안내에 실제 변경 파일 경로가 포함됨",
      scripted.receivedInputs[0].includes(fixtureRel)
    );
  } finally {
    if (existsSync(fixtureAbs)) unlinkSync(fixtureAbs);
  }
}

// Phase C Task C4.1(Read-only Git Command Hardening) — 요구된 source regression: "AutoDev
// Claude Worker의 production 경로가 직접 Bash/tool 실행으로 Safe Executor를 우회할 수
// 없는 현재 구조"를 확인한다. 이 파일의 나머지 시나리오는 fake claudeCaller로 라운드
// 진행/discovery/lock 로직만 검증하므로, "실제 production 호출이 항상 --tools ""로
// Claude에게 built-in 도구를 주지 않는가"와 "claude-developer.ts 자신이 Claude가 요청한
// 명령을 Safe Executor 없이 직접 spawn하지 않는가"는 별도로 소스를 직접 읽어 검증해야
// 한다(런타임 mock으로는 "존재하지 않는 우회 경로가 없다"는 부정 명제를 증명할 수 없다).
function scenarioS_sourceRegressionProductionPathCannotBypassSafeExecutor(): void {
  const claudeDeveloperSource = readFileSync(join(__dirname, "..", "src", "claude-developer.ts"), "utf-8");
  const orchestratorSource = readFileSync(join(__dirname, "..", "src", "orchestrator.ts"), "utf-8");

  // 1) 실제 claude CLI 호출은 항상 --tools ""(빈 문자열)를 넘긴다 — Claude 세션 자체에
  //    built-in Read/Edit/Write/Bash가 전혀 없다.
  check(
    '소스 회귀(C4.1): claude-developer.ts의 callClaude가 항상 "--tools", ""를 넘김(built-in 도구 없음)',
    /"--tools",\s*\n\s*""/.test(claudeDeveloperSource)
  );

  // 2) claude-developer.ts 자신은 child_process를 직접 spawn하지 않는다 — claude CLI
  //    호출은 claude-runner.ts의 execAndClassify에, Claude가 요청한 명령 실행은
  //    safe-executor.ts의 validateAndExecute에 위임한다. 이 파일 안에 spawn/spawnSync/exec가
  //    직접 나타나면 Safe Executor를 거치지 않는 우회 실행 경로가 새로 생겼다는 뜻이다.
  check(
    "소스 회귀(C4.1): claude-developer.ts에 child_process spawn/exec 직접 호출 없음(전부 claude-runner/safe-executor에 위임)",
    !/\b(spawnSync|spawn|execSync|exec)\s*\(/.test(claudeDeveloperSource.replace(/execAndClassify/g, ""))
  );

  // 3) Claude의 ACTION_REQUEST 처리는 doValidateAndExecute(Safe Executor 경유) 단 한
  //    지점에서만 실행된다 — 다른 실행 경로가 추가되지 않았는지 호출 지점 개수로 확인한다.
  const validateAndExecuteCallSites = (claudeDeveloperSource.match(/doValidateAndExecute\(/g) ?? []).length;
  check(
    `소스 회귀(C4.1): claude-developer.ts에서 doValidateAndExecute 호출 지점이 정확히 2곳(ACTION_REQUEST 처리 1 + 필수 테스트 실행 1)(실제 ${validateAndExecuteCallSites}곳)`,
    validateAndExecuteCallSites === 2
  );

  // 4) production 경로(AUTOMATION_DRY_RUN="false")는 runDeveloperTaskViaSafeExecutor만
  //    선택한다 — orchestrator.ts가 다른 runner로 조용히 대체되지 않았는지 확인한다.
  check(
    "소스 회귀(C4.1): orchestrator.ts의 selectDefaultClaudeRunner가 dry-run=false일 때 runDeveloperTaskViaSafeExecutor를 씀",
    /AUTOMATION_DRY_RUN\s*!==\s*"false"[\s\S]{0,80}return[\s\S]{0,200}runDeveloperTaskViaSafeExecutor/.test(orchestratorSource)
  );
}

async function main(): Promise<void> {
  // Phase C Task C4.1 — 실제 Safe Executor/파일 fixture와 무관한 순수 source-regression
  // 검사라 격리 root 준비 이전에 먼저 실행한다.
  scenarioS_sourceRegressionProductionPathCannotBypassSafeExecutor();

  // 이 파일의 시나리오는 ACTION_REQUEST를 통해 실제 Safe Executor(automation/ 범위)를
  // 통과한다 — Safe Executor는 configureSafeExecutor()로 명시적으로 주입되기 전까지 어떤
  // 프로젝트로도 조용히 fallback하지 않으므로, 여기서 이 파일 전용 격리된 임시 root+정책을
  // 주입한다(§ 파일 상단 주석 — Phase B Task B2).
  const testRoot = makeIsolatedTestRoot();
  try {
    configureSafeExecutor(testRoot, TEST_EXECUTION_POLICY);

    await scenarioC_repeatedReadStagnationRegression();
    await scenarioC2_novelDiscoveryLoopBounded();
    await scenarioC3_novelDiscoveryThenNudgeThenWriteSucceeds();
    await scenarioC4_normalShortDiscoveryThenWriteSucceeds();
    await scenarioD_writeFirstThenRepeatedReadNeverStagnates();
    await scenarioE_planCannotResetDiscoveryBudgetIndefinitely();
    await scenarioF_planThenWriteSucceeds();
    await scenarioG_requiredTestsExecutedForReal();
    await scenarioH_requiredTestFailureReflectedForReal();
    await scenarioI_lockBlocksReadThenWriteSucceeds();
    await scenarioJ_lockBlocksContinuedReadUntilStagnation();
    await scenarioK_lockPlanOnceThenWriteSucceeds();
    await scenarioL_lockBlocksSearchSameAsRead();
    await scenarioM_usageLimitMidTaskPreservesTranscriptAndPartialWork();
    await scenarioN_usageLimitAfterImplementationLockThenResumeSucceeds();
    await scenarioO_manyConsecutiveUsageLimitRetriesStillRecoverWithoutConsumingRoundBudget();
    await scenarioP_usageLimitRetryExhaustionReturnsFailureWithoutHanging();
    await scenarioQ_nonRetriableClaudeErrorFailsImmediatelyWithoutRetry();
    await scenarioR_resumeContextDetectedForExistingInScopeChanges();
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }

  console.log("\n=== claude-developer bounded discovery/nudge/PLAN/필수테스트 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
