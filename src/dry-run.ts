import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOrchestrator, MAX_GPT_CALLS, MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT } from "./orchestrator";
import { sanitizeForLog } from "./logger";
import { MAX_REVIEW_CYCLES } from "./policy";
import { DEFAULT_STATE_PATH } from "./state";
import type { ClaudeResult, GptReviewResult, OrchestratorStatus, ProjectState } from "./types";

// REVISE(project-state 테스트 격리) — 이전 버전은 실제 automation/config/project-state.json을
// 직접 덮어쓴 뒤 끝에서 원본을 복원했다(정상 종료 시에만 안전, 중간에 프로세스가 죽으면
// 복원되지 않는 위험이 있었다). 이제 모든 시나리오가 OS 임시 디렉터리의 별도 state 파일만
// 사용한다 — 실제 파일은 read조차 결과 비교용으로만 하고 절대 쓰지 않는다.
function makeTempStatePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "movan-dry-run-state-"));
  const statePath = join(dir, "project-state.json");
  const initial: ProjectState = {
    project: "MOVAN ERP (DRY-RUN)",
    currentPhase: 13,
    phase10Allowed: true,
    migrationsApplied: [],
    migrationsImmutable: true,
    devSupabaseCreated: true,
    devSupabaseConnected: false,
    microsoftConnected: false,
    productionDeployAllowed: false,
    gitCheckpoint: "test",
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "IDLE",
    claudeLimitWaitCount: 0,
    developerProviderWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
  };
  writeFileSync(statePath, JSON.stringify(initial, null, 2) + "\n", "utf-8");
  return statePath;
}

const results: string[] = [];

function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

async function scenarioNormalFlow(statePath: string): Promise<void> {
  const { finalState, statusHistory } = await runOrchestrator("Phase 9 사진 업로드 UI 구현", { statePath });

  const expected: OrchestratorStatus[] = [
    "IDLE",
    "CLAUDE_WORKING",
    "WAITING_GPT_REVIEW",
    "REVISION_REQUIRED",
    "CLAUDE_WORKING",
    "WAITING_GPT_REVIEW",
    "APPROVED",
  ];
  check(
    "정상 흐름: 상태 시퀀스 IDLE→...→APPROVED 일치",
    JSON.stringify(statusHistory) === JSON.stringify(expected)
  );
  check("정상 흐름: 최종 상태 APPROVED", finalState.status === "APPROVED");
  check("정상 흐름: reviewCycle 2회 소요(1차 REVISE, 2차 PASS)", finalState.reviewCycle === 2);
}

async function scenarioDangerousTask(statePath: string): Promise<void> {
  let claudeCalls = 0;
  const trackedRunner = async (task: string, attempt: number): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return {
      success: true,
      summary: "should not run",
      changedFiles: [],
      tests: [],
      rawOutput: `${task}:${attempt}`,
    };
  };

  const { finalState, statusHistory } = await runOrchestrator("production Supabase 데이터를 삭제해줘", {
    claudeRunner: trackedRunner,
    statePath,
  });

  check("위험 작업: 최종 상태 WAITING_HUMAN", finalState.status === "WAITING_HUMAN");
  check("위험 작업: Claude worker 호출 0회(실제 호출 카운트로 증명)", claudeCalls === 0);
  check("위험 작업: statusHistory에 CLAUDE_WORKING 없음", !statusHistory.includes("CLAUDE_WORKING"));
}

async function scenarioMaxReviewCycles(statePath: string): Promise<void> {
  let claudeCalls = 0;
  const trackedRunner = async (task: string, attempt: number): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return {
      success: true,
      summary: `attempt ${attempt}`,
      changedFiles: [],
      tests: [],
      rawOutput: `${task}:${attempt}`,
    };
  };
  // severity high:1 명시 — critical/high가 전혀 없는 REVISE(medium 이하)는 AutoDev
  // Efficiency 개선(2026-09-04, § review-policy.ts applyReviewDecisionPolicy)이 즉시 PASS로
  // 완화하므로, 이 시나리오("REVISE가 절대 수렴하지 않는다")를 검증하려면 실제로 REVISE를
  // 유지시키는 severity가 필요하다.
  const alwaysRevise = async (): Promise<GptReviewResult> => ({
    decision: "REVISE",
    severity: { critical: 0, high: 1, medium: 0 },
    feedback: "[FAKE] 항상 REVISE(무한루프 방지 테스트 전용)",
    nextTask: "재시도",
  });

  const { finalState, statusHistory } = await runOrchestrator("무한 루프 방지 테스트 태스크", {
    claudeRunner: trackedRunner,
    gptReviewer: alwaysRevise,
    statePath,
  });

  check("5회 제한: 최종 상태 WAITING_HUMAN", finalState.status === "WAITING_HUMAN");
  check(`5회 제한: reviewCycle 정확히 ${MAX_REVIEW_CYCLES}에서 중단`, finalState.reviewCycle === MAX_REVIEW_CYCLES);
  const claudeWorkingCount = statusHistory.filter((s) => s === "CLAUDE_WORKING").length;
  check(`5회 제한: Claude 호출 정확히 ${MAX_REVIEW_CYCLES}회(실제 호출 카운트로 증명)`, claudeCalls === MAX_REVIEW_CYCLES);
  check(`5회 제한: statusHistory 내 CLAUDE_WORKING도 ${MAX_REVIEW_CYCLES}회`, claudeWorkingCount === MAX_REVIEW_CYCLES);
}

async function scenarioCriticalForcesRevise(statePath: string): Promise<void> {
  // GPT가 decision=PASS를 반환해도 critical이 있으면 오케스트레이터가 REVISE로 강제해야 한다.
  const fakePass: ClaudeResult = { success: true, summary: "x", changedFiles: [], tests: [], rawOutput: "x" };
  void fakePass;
  const reviewer = async (): Promise<GptReviewResult> => ({
    decision: "PASS",
    severity: { critical: 1, high: 0, medium: 0 },
    feedback: "critical 있음에도 PASS 반환(테스트용 결함 GPT 시뮬레이션)",
    nextTask: null,
  });
  const { finalState, statusHistory } = await runOrchestrator("critical 강제 REVISE 테스트", {
    gptReviewer: reviewer,
    statePath,
  });
  check(
    "critical 안전장치: GPT의 PASS를 무시하고 REVISE로 강제 전환됨(REVISION_REQUIRED 등장)",
    statusHistory.includes("REVISION_REQUIRED")
  );
  check("critical 안전장치: 최종적으로 APPROVED로 끝나지 않음", finalState.status !== "APPROVED");
}

async function scenarioMaxGptCalls(statePath: string): Promise<void> {
  let claudeCalls = 0;
  const trackedRunner = async (task: string, attempt: number): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return { success: true, summary: `attempt ${attempt}`, changedFiles: [], tests: [], rawOutput: `${task}:${attempt}` };
  };
  // severity high:1 명시 — § scenarioMaxReviewCycles의 alwaysRevise와 동일한 이유.
  const alwaysRevise = async (): Promise<GptReviewResult> => ({
    decision: "REVISE",
    severity: { critical: 0, high: 1, medium: 0 },
    feedback: "[FAKE] MAX_GPT_CALLS 테스트 전용",
    nextTask: "재시도",
  });
  const { finalState } = await runOrchestrator("GPT 호출 상한 테스트 태스크", {
    claudeRunner: trackedRunner,
    gptReviewer: alwaysRevise,
    statePath,
  });
  // MAX_REVIEW_CYCLES(§ policy.ts)가 MAX_GPT_CALLS보다 먼저 걸리므로, 실제로는
  // MAX_REVIEW_CYCLES회에서 멈춘다 — 이 자체가 "GPT 호출이 MAX_GPT_CALLS를 절대 넘지
  // 않는다"는 것의 증거다.
  check(
    `GPT 호출 상한: 실제 호출 수가 MAX_GPT_CALLS(${MAX_GPT_CALLS})를 절대 넘지 않음`,
    claudeCalls <= MAX_GPT_CALLS
  );
  check("GPT 호출 상한: 최종 상태 WAITING_HUMAN", finalState.status === "WAITING_HUMAN");
}

// § P1-3 재하드닝(독립 감사, 2026-08-30) — 이 데모는 예전에 "USAGE_LIMIT은 상한 없이 계속
// 재시도한다"는 2026-08-28 정책을 보여줬다. 그 정책은 이후 P1-2 하드닝(§ orchestrator.ts
// blockOnDurableWaitRetryExhausted)으로 대체됐다 — 재시도 "간격"만 bounded이던 것에서 재시도
// "횟수"도 MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT로 bounded하게 바뀌었다("느리지만 무한한
// 반복"도 금지). production 동작이 이미 바뀌었으므로 이 데모도 실제 현재 정책(상한 도달 후
// terminal 기술적 BLOCKED)에 맞춘다 — sentinel로 강제 종료할 필요 없이 orchestrator 스스로
// bounded하게 끝난다.
async function scenarioClaudeLimitRetry(statePath: string): Promise<void> {
  let claudeCalls = 0;
  let sleepCalls = 0;
  const alwaysUsageLimit = async (task: string, attempt: number): Promise<ClaudeResult & { errorCode?: string }> => {
    claudeCalls += 1;
    return {
      success: false,
      summary: "usage limit",
      changedFiles: [],
      tests: [],
      rawOutput: `${task}:${attempt}`,
      errorCode: "USAGE_LIMIT",
    };
  };
  const fastSleep = async (_ms: number) => {
    sleepCalls += 1;
  };

  const { finalState } = await runOrchestrator("Claude 사용량 제한 재시도 테스트", {
    claudeRunner: alwaysUsageLimit,
    claudeLimitWaitMs: 1,
    sleep: fastSleep,
    statePath,
  });

  check(
    `사용량 제한 재시도: durable wait 횟수도 상한(MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT=${MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT})으로 bounded됨(무한 반복 아님)`,
    sleepCalls === MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT
  );
  check(
    `사용량 제한 재시도: Claude 호출도 상한+1(${MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT + 1})에서 멈춤(마지막 호출은 대기 없이 즉시 BLOCKED로 판정됨)`,
    claudeCalls === MAX_DURABLE_PROVIDER_WAIT_RETRY_COUNT + 1
  );
  check(
    "사용량 제한 재시도: 상한 도달 시 genuine WAITING_HUMAN이 아니라 terminal 기술적 BLOCKED로 수렴함",
    (finalState.status as unknown as string) === "BLOCKED"
  );
}

function scenarioSanitizer(): void {
  const dirty =
    'OPENAI_API_KEY=sk-test-abc123, access_token: "ghi_super_secret", ' +
    "Authorization: Bearer xyz.jwt.token.value, " +
    "uploadUrl=https://graph.microsoft.com/upload/secretpath123, " +
    "client_secret=topsecretvalue999";
  const clean = sanitizeForLog(dirty);
  const leaked = /sk-test-abc123|ghi_super_secret|xyz\.jwt\.token\.value|secretpath123|topsecretvalue999/.test(
    clean
  );
  check("secret sanitizer: 원본 민감값이 출력에 전혀 남지 않음", !leaked);
  check("secret sanitizer: [REDACTED] 마커 포함", clean.includes("[REDACTED]"));
}

async function main(): Promise<void> {
  // 실제 project-state.json은 read-only 증거로만 쓴다 — 어떤 시나리오도 이 파일을 쓰지
  // 않는다는 것을 실행 전/후 내용 비교로 증명한다(§ 요구사항 4 project-state 테스트 격리).
  const realStateBefore = readFileSync(DEFAULT_STATE_PATH, "utf-8");

  const tempDirs: string[] = [];
  const newTempStatePath = () => {
    const p = makeTempStatePath();
    tempDirs.push(join(p, ".."));
    return p;
  };

  try {
    await scenarioNormalFlow(newTempStatePath());
    await scenarioDangerousTask(newTempStatePath());
    await scenarioMaxReviewCycles(newTempStatePath());
    await scenarioCriticalForcesRevise(newTempStatePath());
    await scenarioMaxGptCalls(newTempStatePath());
    await scenarioClaudeLimitRetry(newTempStatePath());
    scenarioSanitizer();
  } finally {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 디렉터리 정리 실패는 테스트 결과에 영향 없음
      }
    }
  }

  const realStateAfter = readFileSync(DEFAULT_STATE_PATH, "utf-8");
  check("project-state 격리: 실제 project-state.json이 테스트 실행 전후 완전히 동일함", realStateBefore === realStateAfter);

  console.log("\n=== dry-run 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);

  if (results.some((r) => r.startsWith("[FAIL]"))) {
    process.exitCode = 1;
  }
}

main();
