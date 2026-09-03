import { executeRoutingPlan } from "./agent-orchestrator";
import type { AgentOrchestratorDeps, AgentExecutionInput, DeveloperAgentRunner, ReviewerAgentRunner, ReadOnlyAgentRunner, ReviewerStepData } from "./agent-orchestrator";
import { routeTask, CORE_AGENT_REGISTRY } from "./agent-registry";
import type { RoutableTaskInput } from "./agent-registry";
import type { DeveloperResult } from "./claude-developer";
import type { GptReviewRetryResult } from "./gpt-reviewer";
import { MAX_REVIEW_CYCLES } from "./policy";

// Agent Handoff & REVISE Loop 테스트(Phase F Task F3). 실제 Claude/GPT 유료 API를 전혀
// 호출하지 않는다 — developerRunner/reviewerRunner/readOnlyRunner는 항상 fake로 주입한다.
// F1의 routeTask()와 F2의 executeRoutingPlan()을 그대로 재사용한다(routing/실행 골격을
// 이 테스트에서 다시 만들지 않는다) — 이 파일은 오직 developer↔reviewer REVISE handoff
// loop(§ agent-orchestrator.ts의 executeReviewerStepWithRevise)만 검증한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function req(overrides: Partial<RoutableTaskInput> = {}): RoutableTaskInput {
  return { id: "task-1", description: "새 기능을 구현해줘", hasFixedRequiredTests: true, ...overrides };
}

function execInput(overrides: Partial<AgentExecutionInput> = {}): AgentExecutionInput {
  return { taskId: "task-1", taskGoal: "결제 모듈에 재시도 로직을 추가해줘", ...overrides };
}

interface DevCall {
  task: string;
  attempt: number;
}
interface RevCall {
  reviewCycle: number;
}

function makeReviseTrackedDeps(opts: {
  developerResponses?: (Partial<DeveloperResult> | undefined)[];
  reviewerResponses?: (Partial<GptReviewRetryResult> | undefined)[];
  defaultDeveloper?: Partial<DeveloperResult>;
  defaultReviewer?: Partial<GptReviewRetryResult>;
} = {}): {
  deps: AgentOrchestratorDeps;
  developerCalls: DevCall[];
  reviewerCalls: RevCall[];
  readOnlyCalls: string[];
} {
  const developerCalls: DevCall[] = [];
  const reviewerCalls: RevCall[] = [];
  const readOnlyCalls: string[] = [];
  let devIdx = 0;
  let revIdx = 0;

  const developerRunner: DeveloperAgentRunner = async (task, attempt) => {
    developerCalls.push({ task, attempt });
    const override = opts.developerResponses?.[devIdx] ?? opts.defaultDeveloper ?? {};
    devIdx += 1;
    return {
      success: true,
      summary: `[FAKE] developer 완료(attempt ${attempt}) — DEVELOPER_SUMMARY_SHOULD_NOT_RESEND`,
      changedFiles: [`file-attempt-${attempt}.ts`],
      tests: [{ name: "unit-1", pass: true }],
      rawOutput: `RAW_OUTPUT_SHOULD_NOT_BE_RESENT_attempt${attempt}`,
      ...override,
    };
  };

  const reviewerRunner: ReviewerAgentRunner = async (_result, reviewCycle) => {
    reviewerCalls.push({ reviewCycle });
    const override = opts.reviewerResponses?.[revIdx] ?? opts.defaultReviewer ?? {};
    revIdx += 1;
    return {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      feedback: "[FAKE] 리뷰 통과",
      nextTask: null,
      gptTransportRetry: 0,
      ...override,
    };
  };

  const readOnlyRunner: ReadOnlyAgentRunner = async () => {
    readOnlyCalls.push("readonly");
    return { success: true, summary: "[FAKE] read-only agent 완료", rawOutput: "raw" };
  };

  return { deps: { developerRunner, reviewerRunner, readOnlyRunner }, developerCalls, reviewerCalls, readOnlyCalls };
}

// ---------------------------------------------------------------------------
// 1) first-pass APPROVED → developer 1회 / reviewer 1회.
// ---------------------------------------------------------------------------
async function scenarioFirstPassApproved(): Promise<void> {
  const plan = routeTask(req());
  const { deps, developerCalls, reviewerCalls } = makeReviseTrackedDeps();
  const result = await executeRoutingPlan(plan, execInput(), CORE_AGENT_REGISTRY, deps);

  check("first-pass: overallStatus=COMPLETED", result.overallStatus === "COMPLETED");
  check("first-pass: developer가 정확히 1회 호출됨", developerCalls.length === 1);
  check("first-pass: reviewer가 정확히 1회 호출됨", reviewerCalls.length === 1);
  const reviewerStep = result.stepResults.find((r) => r.role === "reviewer");
  check("first-pass: reviewer step data.reviseCycles=0", (reviewerStep?.data as ReviewerStepData).reviseCycles === 0);
}

// ---------------------------------------------------------------------------
// 2) REVISE 1회 → developer 수정 → test 재실행 → reviewer 재Review.
// ---------------------------------------------------------------------------
async function scenarioReviseOnceThenApprove(): Promise<void> {
  const plan = routeTask(req());
  // severity를 high:1로 명시 — severity가 critical/high 없이 0/0/0이면 AutoDev Efficiency
  // 개선(2026-09-04, § review-policy.ts applyReviewDecisionPolicy)이 REVISE를 즉시
  // PASS로 완화하므로, 이 시나리오("진짜 REVISE 1회를 거쳐 재작업 후 승인")를 검증하려면
  // 실제로 REVISE를 유지시키는 severity가 필요하다.
  const { deps, developerCalls, reviewerCalls } = makeReviseTrackedDeps({
    reviewerResponses: [
      { decision: "REVISE", severity: { critical: 0, high: 1, medium: 0 }, feedback: "[FAKE] 에러 핸들링이 빠졌습니다." },
      { decision: "PASS" },
    ],
  });
  const result = await executeRoutingPlan(plan, execInput(), CORE_AGENT_REGISTRY, deps);

  check("REVISE 1회: overallStatus=COMPLETED(재작업 후 승인)", result.overallStatus === "COMPLETED");
  check("REVISE 1회: developer가 정확히 2회 호출됨(최초 + 재작업)", developerCalls.length === 2);
  check("REVISE 1회: reviewer가 정확히 2회 호출됨(최초 + 재리뷰)", reviewerCalls.length === 2);
  check("REVISE 1회: 두 번째 developer 호출의 attempt=2", developerCalls[1].attempt === 2);
  check("REVISE 1회: 두 번째 reviewer 호출의 reviewCycle=2", reviewerCalls[1].reviewCycle === 2);
  const reviewerStep = result.stepResults.find((r) => r.role === "reviewer");
  check("REVISE 1회: 최종 reviewer step data.reviseCycles=1", (reviewerStep?.data as ReviewerStepData).reviseCycles === 1);
  const developerStep = result.stepResults.find((r) => r.role === "developer");
  check(
    "REVISE 1회: stepResults의 developer 항목이 마지막(2번째) 시도 결과를 담음",
    (developerStep?.data as DeveloperResult).changedFiles[0] === "file-attempt-2.ts"
  );
}

// ---------------------------------------------------------------------------
// 3) 여러 REVISE도 기존 max cycle 안에서만 실행.
// ---------------------------------------------------------------------------
async function scenarioMultipleRevisesWithinMaxCycle(): Promise<void> {
  const plan = routeTask(req());
  // MAX_REVIEW_CYCLES=3(2026-09-04 Efficiency 개선, § policy.ts): cycle 1~2는 REVISE,
  // cycle 3에 PASS — 예산(3) 안에서 끝나는 것을 검증한다. REVISE 응답은 severity high:1을
  // 명시해 applyReviewDecisionPolicy의 severity 기반 자동 완화(REVISE→PASS, severity
  // 0/0/0일 때만 적용)에 걸리지 않고 실제로 REVISE 상태를 유지하게 한다.
  const { deps, developerCalls, reviewerCalls } = makeReviseTrackedDeps({
    reviewerResponses: [
      { decision: "REVISE", severity: { critical: 0, high: 1, medium: 0 } },
      { decision: "REVISE", severity: { critical: 0, high: 1, medium: 0 } },
      { decision: "PASS" },
    ],
  });
  const result = await executeRoutingPlan(plan, execInput(), CORE_AGENT_REGISTRY, deps);

  check("여러 REVISE: max cycle(3) 이내에서 정상 승인됨(overallStatus=COMPLETED)", result.overallStatus === "COMPLETED");
  check("여러 REVISE: developer가 정확히 3회 호출됨", developerCalls.length === 3);
  check("여러 REVISE: reviewer가 정확히 3회 호출됨", reviewerCalls.length === 3);
  check("여러 REVISE: MAX_REVIEW_CYCLES(3) 이내로 끝남", developerCalls.length <= MAX_REVIEW_CYCLES);
}

// ---------------------------------------------------------------------------
// 4) max cycle 초과 → 자동 진행 중단(무한 REVISE loop 금지). "승인하면 통과"로 오해될 수
//    있는 HUMAN_APPROVAL_REQUIRED가 아니라 BLOCKED + REVIEW_CYCLE_EXHAUSTED reason을
//    쓰고, critical/high와 REVISE 상태가 그대로 보존되는지(강제로 PASS/COMPLETED로 덮어
//    쓰이지 않는지)까지 증명한다.
// ---------------------------------------------------------------------------
async function scenarioMaxCycleExceeded(): Promise<void> {
  const plan = routeTask(req());
  // critical=1을 계속 유지한 채 매번 REVISE를 반환 — "승인만 하면 통과"가 아니라 실제로
  // critical이 해결되지 않은 채로 멈춘다는 것을 증명하기 위함.
  const { deps, developerCalls, reviewerCalls } = makeReviseTrackedDeps({
    defaultReviewer: { decision: "REVISE", severity: { critical: 1, high: 0, medium: 0 }, feedback: "[FAKE] 여전히 critical 이슈가 남아있습니다." },
  });
  const result = await executeRoutingPlan(plan, execInput(), CORE_AGENT_REGISTRY, deps);

  check("max cycle 초과: overallStatus가 COMPLETED가 아님(자동 완료로 넘어가지 않음)", result.overallStatus !== "COMPLETED");
  check(
    "max cycle 초과: overallStatus=BLOCKED(HUMAN_APPROVAL_REQUIRED가 아님 — '승인하면 통과'로 오해될 수 있는 상태를 쓰지 않음)",
    result.overallStatus === "BLOCKED"
  );
  check("max cycle 초과: reason이 REVIEW_CYCLE_EXHAUSTED로 명확함", result.reason.includes("REVIEW_CYCLE_EXHAUSTED"));
  check(`max cycle 초과: reason에 MAX_REVIEW_CYCLES 도달이 명시됨`, result.reason.includes("MAX_REVIEW_CYCLES"));
  check(`max cycle 초과: developer가 정확히 MAX_REVIEW_CYCLES(${MAX_REVIEW_CYCLES})회만 호출됨(무한루프 아님)`, developerCalls.length === MAX_REVIEW_CYCLES);
  check(`max cycle 초과: reviewer도 정확히 MAX_REVIEW_CYCLES(${MAX_REVIEW_CYCLES})회만 호출됨`, reviewerCalls.length === MAX_REVIEW_CYCLES);

  const reviewerStep = result.stepResults.find((r) => r.role === "reviewer");
  const data = reviewerStep?.data as ReviewerStepData;
  check("max cycle 초과: reviewer step data.decision이 여전히 REVISE로 보존됨(강제로 PASS로 덮어쓰지 않음)", data.decision === "REVISE");
  check("max cycle 초과: reviewer step data.severity.critical=1이 그대로 보존됨(사라지지 않음)", data.severity.critical === 1);
  check("max cycle 초과: reviewCycleExhausted 플래그가 true로 기록됨", data.reviewCycleExhausted === true);
}

// ---------------------------------------------------------------------------
// 5) 실제 required test 실패 → reviewer가 PASS라고 해도 강제 REVISE.
// ---------------------------------------------------------------------------
async function scenarioTestFailureForcesRevise(): Promise<void> {
  const plan = routeTask(req());
  const { deps, developerCalls, reviewerCalls } = makeReviseTrackedDeps({
    developerResponses: [{ tests: [{ name: "unit-1", pass: false }] }],
    defaultReviewer: { decision: "PASS" }, // reviewer는 매번 PASS라고 주장.
  });
  const result = await executeRoutingPlan(plan, execInput(), CORE_AGENT_REGISTRY, deps);

  check("test 실패: 1차 developer의 실제 test 실패에도 reviewer 주장(PASS)이 아니라 재작업이 트리거됨", developerCalls.length >= 2);
  check("test 실패: 2차부터는 tests가 통과하므로 최종 COMPLETED", result.overallStatus === "COMPLETED");
  check("test 실패: reviewer도 developer와 같은 횟수만큼 호출됨", reviewerCalls.length === developerCalls.length);
}

// ---------------------------------------------------------------------------
// 6) Critical/High가 있으면 reviewer가 PASS라고 해도 강제 REVISE(APPROVED 금지).
// ---------------------------------------------------------------------------
async function scenarioCriticalHighForcesRevise(): Promise<void> {
  const plan = routeTask(req());
  const { deps, developerCalls } = makeReviseTrackedDeps({
    reviewerResponses: [{ decision: "PASS", severity: { critical: 1, high: 0, medium: 0 } }, { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 } }],
  });
  const result = await executeRoutingPlan(plan, execInput(), CORE_AGENT_REGISTRY, deps);

  check("critical 존재: 1차 PASS+critical=1은 무시되고 재작업이 트리거됨(developer 2회)", developerCalls.length === 2);
  check("critical 존재: critical이 사라진 2차에서 최종 COMPLETED", result.overallStatus === "COMPLETED");
}

// ---------------------------------------------------------------------------
// 7) reviewer timeout/error → fail-open 금지(PASS로 처리되지 않음).
// ---------------------------------------------------------------------------
async function scenarioReviewerTimeoutNotFailOpen(): Promise<void> {
  const plan = routeTask(req());
  const { deps, developerCalls, reviewerCalls } = makeReviseTrackedDeps({
    defaultReviewer: {
      decision: "HUMAN_REQUIRED",
      feedback: "GPT reviewer가 5회 연속 일시적 오류로 응답하지 않았습니다.",
      errorCode: "GPT_REVIEW_TEMPORARILY_UNAVAILABLE",
    },
  });
  const result = await executeRoutingPlan(plan, execInput(), CORE_AGENT_REGISTRY, deps);

  check("reviewer timeout: overallStatus가 COMPLETED가 아님(fail-open 아님)", result.overallStatus !== "COMPLETED");
  check("reviewer timeout: overallStatus=HUMAN_APPROVAL_REQUIRED", result.overallStatus === "HUMAN_APPROVAL_REQUIRED");
  check("reviewer timeout: 재시도로 무한히 호출하지 않고 1회로 끝남(reviewClaudeResultWithRetry가 이미 내부에서 재시도를 흡수)", developerCalls.length === 1 && reviewerCalls.length === 1);
}

// ---------------------------------------------------------------------------
// 8) handoff에는 필요한 feedback만 담김(원래 목표 + 지적사항 + 변경 파일 + 실패 test).
// ---------------------------------------------------------------------------
async function scenarioHandoffMinimalFeedbackContent(): Promise<void> {
  const plan = routeTask(req());
  const { deps, developerCalls } = makeReviseTrackedDeps({
    developerResponses: [{ changedFiles: ["src/payment.ts"], tests: [{ name: "payment-retry-test", pass: false }] }],
    reviewerResponses: [{ decision: "REVISE", feedback: "재시도 횟수 상한이 없습니다." }],
  });
  await executeRoutingPlan(plan, execInput({ taskGoal: "결제 모듈에 재시도 로직을 추가해줘" }), CORE_AGENT_REGISTRY, deps);

  const reviseTask = developerCalls[1].task;
  check("handoff: 원래 Task 목표가 포함됨", reviseTask.includes("결제 모듈에 재시도 로직을 추가해줘"));
  check("handoff: reviewer의 구체적 지적사항이 포함됨", reviseTask.includes("재시도 횟수 상한이 없습니다"));
  check("handoff: 관련 변경 파일이 포함됨", reviseTask.includes("src/payment.ts"));
  check("handoff: 실패한 test 이름이 포함됨", reviseTask.includes("payment-retry-test"));
}

// ---------------------------------------------------------------------------
// 9) unrelated/전체 context 재전송 없음.
// ---------------------------------------------------------------------------
async function scenarioNoUnrelatedContextResent(): Promise<void> {
  const plan = routeTask(req());
  // severity high:1 명시 — 0/0/0이면 AutoDev Efficiency 개선(§ review-policy.ts)이 REVISE를
  // 즉시 PASS로 완화해 이 시나리오(REVISE handoff 내용 검증)가 발동하지 않는다.
  const { deps, developerCalls } = makeReviseTrackedDeps({
    reviewerResponses: [{ decision: "REVISE", severity: { critical: 0, high: 1, medium: 0 }, feedback: "수정 필요" }],
  });
  await executeRoutingPlan(
    plan,
    execInput({ roleContext: { qa: "QA_ONLY_SECRET_CONTEXT_SHOULD_NOT_LEAK" } }),
    CORE_AGENT_REGISTRY,
    deps
  );

  const reviseTask = developerCalls[1].task;
  check("no-unrelated-context: 1차 developer의 rawOutput(원본 raw)이 재전송되지 않음", !reviseTask.includes("RAW_OUTPUT_SHOULD_NOT_BE_RESENT"));
  check("no-unrelated-context: 1차 developer의 summary가 그대로 재전송되지 않음", !reviseTask.includes("DEVELOPER_SUMMARY_SHOULD_NOT_RESEND"));
  check("no-unrelated-context: 다른 role의 roleContext(qa 전용)가 섞여 들어가지 않음", !reviseTask.includes("QA_ONLY_SECRET_CONTEXT_SHOULD_NOT_LEAK"));
}

// ---------------------------------------------------------------------------
// 10) REVISE 중에도 qa는 다시 호출되지 않음(불필요 Agent 호출 없음).
// ---------------------------------------------------------------------------
async function scenarioQaNotReCalledDuringRevise(): Promise<void> {
  const plan = routeTask(req({ hasFixedRequiredTests: false })); // developer,qa,reviewer 플랜.
  // severity high:1 명시 — § scenarioNoUnrelatedContextResent와 동일한 이유.
  const { deps, developerCalls, readOnlyCalls } = makeReviseTrackedDeps({
    reviewerResponses: [{ decision: "REVISE", severity: { critical: 0, high: 1, medium: 0 } }, { decision: "PASS" }],
  });
  const result = await executeRoutingPlan(plan, execInput(), CORE_AGENT_REGISTRY, deps);

  check("qa 재호출 없음: developer는 REVISE로 2회 호출됨", developerCalls.length === 2);
  check("qa 재호출 없음: readonly(qa)는 정확히 1회만 호출됨(REVISE cycle과 무관)", readOnlyCalls.length === 1);
  check("qa 재호출 없음: role 순서는 여전히 developer,qa,reviewer(3개 step)", result.stepResults.map((r) => r.role).join(",") === "developer,qa,reviewer");
}

// ---------------------------------------------------------------------------
// 11) requestedPermission 자기보고로 권한 확대 불가(REVISE 경로와 무관하게 유지됨).
// ---------------------------------------------------------------------------
async function scenarioRequestedPermissionStillBlocked(): Promise<void> {
  const plan = routeTask({ id: "task-2", description: "시스템 아키텍처를 설계해줘" });
  const { deps } = makeReviseTrackedDeps();
  deps.readOnlyRunner = async () => ({ success: true, summary: "[FAKE] planner", rawOutput: "raw", requestedPermission: "canWriteCode" });
  const result = await executeRoutingPlan(plan, execInput({ taskGoal: "시스템 아키텍처를 설계해줘" }), CORE_AGENT_REGISTRY, deps);

  check("requestedPermission: planner의 자기보고만으로 권한이 확대되지 않고 BLOCKED", result.stepResults[0]?.status === "BLOCKED");
  check("requestedPermission: overallStatus=BLOCKED", result.overallStatus === "BLOCKED");
}

// ---------------------------------------------------------------------------
// 12) high-risk human gate 유지(REVISE 로직이 추가돼도 게이트를 우회하지 않음).
// ---------------------------------------------------------------------------
async function scenarioHighRiskGateStillHolds(): Promise<void> {
  const plan = routeTask(req({ description: "production DB에서 데이터를 삭제해줘" }));
  check("high-risk: F1이 이미 requiresHumanApproval=true로 판정함", plan.requiresHumanApproval === true);
  const { deps, developerCalls, reviewerCalls } = makeReviseTrackedDeps();
  const result = await executeRoutingPlan(plan, execInput({ taskGoal: "production DB에서 데이터를 삭제해줘" }), CORE_AGENT_REGISTRY, deps);

  check("high-risk: overallStatus=HUMAN_APPROVAL_REQUIRED", result.overallStatus === "HUMAN_APPROVAL_REQUIRED");
  check("high-risk: developer/reviewer가 전혀 호출되지 않음(REVISE loop 진입 자체가 없음)", developerCalls.length === 0 && reviewerCalls.length === 0);
}

// ---------------------------------------------------------------------------
// 13) developer 재시도가 구조적으로 실패하면 그 자리에서 멈추고 reviewer는 다시 부르지 않음.
// ---------------------------------------------------------------------------
async function scenarioDeveloperReviseFailureStopsLoop(): Promise<void> {
  const plan = routeTask(req());
  // severity high:1 명시 — § scenarioNoUnrelatedContextResent와 동일한 이유(REVISE가
  // 자동 PASS로 완화되면 재시도 자체가 트리거되지 않아 이 시나리오가 검증되지 않는다).
  const { deps, developerCalls, reviewerCalls } = makeReviseTrackedDeps({
    reviewerResponses: [{ decision: "REVISE", severity: { critical: 0, high: 1, medium: 0 } }],
    developerResponses: [undefined, { success: false, errorCode: "NON_ZERO_EXIT" as never }],
  });
  const result = await executeRoutingPlan(plan, execInput(), CORE_AGENT_REGISTRY, deps);

  check("developer 재시도 실패: overallStatus=FAILED", result.overallStatus === "FAILED");
  check("developer 재시도 실패: developer는 2회(최초+실패한 재시도) 호출됨", developerCalls.length === 2);
  check("developer 재시도 실패: reviewer는 재시도 실패 이후 다시 호출되지 않음(1회만)", reviewerCalls.length === 1);
}

async function main(): Promise<void> {
  await scenarioFirstPassApproved();
  await scenarioReviseOnceThenApprove();
  await scenarioMultipleRevisesWithinMaxCycle();
  await scenarioMaxCycleExceeded();
  await scenarioTestFailureForcesRevise();
  await scenarioCriticalHighForcesRevise();
  await scenarioReviewerTimeoutNotFailOpen();
  await scenarioHandoffMinimalFeedbackContent();
  await scenarioNoUnrelatedContextResent();
  await scenarioQaNotReCalledDuringRevise();
  await scenarioRequestedPermissionStillBlocked();
  await scenarioHighRiskGateStillHolds();
  await scenarioDeveloperReviseFailureStopsLoop();

  console.log("\n=== agent-orchestrator REVISE loop 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
