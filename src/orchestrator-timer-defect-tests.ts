import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// AutoDev Core Maintenance — Timer Handle Defect 재하드닝(2026-08-31, JARVIS Task 5.3
// 실측 — canonical stop이 durable-wait 도중 논리적으로는 즉시 abort됐는데도 실제 OS
// 프로세스는 원래 예정된 대기시간(실측: 30분)까지 계속 살아있던 결함).
//
// orchestrator.ts의 sleepOrAbort()/defaultSleep은 module-private이라 이 파일에서 직접
// import해 단위 테스트할 수 없다(export하지 않는다 — 새 공개 API를 만들지 않는다는 기존
// 설계 원칙을 유지). 대신 실제 export된 유일한 진입점 runOrchestrator()를 완전히 별도의
// 실제 OS 프로세스(child_process.spawn)에서 호출해, "함수가 논리적으로 빨리 반환하는지"뿐
// 아니라 "그 프로세스 자체가 실제로 빨리 종료되는지"를 직접 측정한다 — autodev-tests.ts의
// 기존 K/L/M 시나리오는 in-process로 이 함수를 호출하므로 그 자체로는 이 클래스의 결함을
// 드러내지 못한다(함수 호출은 빨리 끝나도, 뒤에 남은 setTimeout이 "이 테스트 프로세스"를
// 계속 살려두는 것과 "실제 production run.js 프로세스"가 계속 살아있는 것은 별개다 — 이미
// autodev-tests.ts L 시나리오가 통과하는 상태에서 이 결함이 production에 실제로 재현됐다).
//
// developerProviderWaitScheduleMs를 5분(300000ms)으로 설정한다 — 수정 전이었다면 이
// 자식 프로세스가 그 시간만큼 살아있어야 했다(실제 production 관측: 30분 durable-wait
// 도중 abort했는데 정확히 원래 예정 시각에 프로세스가 종료됨). 이 테스트는 그 시간을
// 기다리지 않는다 — 수정 후 몇 초 안에 실제로 종료되는지만 확인한다(타임아웃 자체를
// 늘리거나 줄이지 않는다 — 이 테스트는 orchestrator.ts의 실제 상수를 전혀 건드리지 않고
// deps로만 시간을 지정한다).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function buildInitialState(statePath: string): void {
  const initial = {
    currentPhase: 1,
    gitCheckpoint: "test",
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "IDLE",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
  };
  writeFileSync(statePath, JSON.stringify(initial, null, 2) + "\n", "utf-8");
}

/** 실제 OS 프로세스를 spawn해 runOrchestrator()를 실행하고, (a) 그 함수가 resolve될 때까지
 *  걸린 시간과 (b) 그 프로세스 자체가 종료될 때까지 걸린 시간을 각각 측정한다. */
function runInSubprocess(orchestratorDistPath: string, statePath: string, waitScheduleMs: number, abortAfterMs: number): Promise<{
  resolvedAfterMs: number | null;
  exitedAfterMs: number;
  stdout: string;
}> {
  const script = `
const { runOrchestrator } = require(${JSON.stringify(orchestratorDistPath)});
const controller = new AbortController();
setTimeout(() => controller.abort(), ${abortAfterMs});
const claudeRunner = async () => ({
  success: false,
  summary: "timeout 300000ms 초과로 강제 종료됨(시뮬레이션)",
  changedFiles: [],
  tests: [],
  rawOutput: "",
  errorCode: "TIMEOUT",
  deferredHumanTasks: ["DEVELOPER_TRANSIENT_RETRY_EXHAUSTED(TIMEOUT): 시뮬레이션"],
});
const gptReviewer = async () => ({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "ok", nextTask: null });
runOrchestrator("fake task", {
  claudeRunner,
  gptReviewer,
  developerProviderWaitScheduleMs: [${waitScheduleMs}],
  developerProviderWaitCooldownMs: ${waitScheduleMs},
  abortSignal: controller.signal,
  statePath: ${JSON.stringify(statePath)},
}).then((result) => {
  console.log("ORCHESTRATOR_RESULT " + JSON.stringify({ stopped: result.stopped === true }));
}).catch((e) => {
  console.error("ORCHESTRATOR_ERROR " + (e && e.message));
  process.exitCode = 1;
});
`;
  const dir = mkdtempSync(join(tmpdir(), "autodev-timer-defect-"));
  const scriptPath = join(dir, "child.js");
  writeFileSync(scriptPath, script, "utf-8");

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let resolvedAfterMs: number | null = null;
    let stdout = "";
    const child = spawn(process.execPath, [scriptPath], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (resolvedAfterMs === null && stdout.includes("ORCHESTRATOR_RESULT")) {
        resolvedAfterMs = Date.now() - startedAt;
      }
    });
    child.stderr.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("exit", () => {
      const exitedAfterMs = Date.now() - startedAt;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 디렉터리 정리 실패는 테스트 결과에 영향 없음.
      }
      resolve({ resolvedAfterMs, exitedAfterMs, stdout });
    });
  });
}

async function main(): Promise<void> {
  // orchestrator.ts는 이 파일과 같은 dist/ 디렉터리에 컴파일되므로 상대 require로 충분하다
  // (§ package.json test 스크립트 관례 — 항상 "npm run build && node dist/..." 순서로
  // 실행되어 dist/orchestrator.js가 최신 상태임을 보장한다).
  const orchestratorDistPath = require.resolve("./orchestrator");

  const dir = mkdtempSync(join(tmpdir(), "autodev-timer-defect-state-"));
  const statePath = join(dir, "project-state.json");
  buildInitialState(statePath);

  try {
    // durable-wait 예정 시간을 5분으로 잡는다 — 수정 전이었다면 이 프로세스가 그만큼
    // 살아있어야 했다. abort는 200ms 뒤에 건다(durable-wait sleep이 이미 시작된 뒤).
    const { resolvedAfterMs, exitedAfterMs, stdout } = await runInSubprocess(orchestratorDistPath, statePath, 300_000, 200);

    check("TIMER_HANDLE_DEFECT: 자식 프로세스가 stdout으로 ORCHESTRATOR_RESULT를 출력함(정상 실행됨)", stdout.includes("ORCHESTRATOR_RESULT"));
    check("TIMER_HANDLE_DEFECT: 결과에 stopped:true가 포함됨(abort로 정상 중단)", stdout.includes('"stopped":true'));
    check(
      `TIMER_HANDLE_DEFECT: runOrchestrator() 함수 자체는 abort 후 수 초 안에 resolve됨(실측 ${resolvedAfterMs}ms)`,
      resolvedAfterMs !== null && resolvedAfterMs < 5_000
    );
    check(
      `TIMER_HANDLE_DEFECT(핵심 회귀) — 실제 OS 프로세스가 예정된 durable-wait(300000ms)를 기다리지 않고 수 초 안에 실제로 종료됨(실측 ${exitedAfterMs}ms) — 수정 전에는 defaultSleep의 setTimeout이 clearTimeout되지 않아 이 프로세스가 300000ms 가까이 살아있었다(실제 production: 30분 durable-wait 도중 abort했는데 정확히 원래 예정 시각에 종료됨)`,
      exitedAfterMs < 10_000
    );
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 임시 디렉터리 정리 실패는 테스트 결과에 영향 없음.
    }
  }

  console.log("\n=== orchestrator Timer Handle Defect(subprocess) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
