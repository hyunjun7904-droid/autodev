import { classifyWaitingHumanReason, isTechnicalAutoRecoverableWaitingHuman, extractCheckpointScopeViolationFiles } from "./human-gate-policy";
import { CHECKPOINT_SCOPE_VIOLATION_REASON } from "./approval";
import { REVIEW_CYCLE_EXHAUSTED_REASON } from "./review-policy";
import type { CoreState } from "./types";

// human-gate-policy.ts 전용 회귀 테스트 — Canonical Human Gate Policy Evaluator가 순수
// 함수로서(LLM 재분류 없음, 동일 입력에는 항상 동일 출력) 정확히 어떤 WAITING_HUMAN 사유를
// 기술적 자동 복구 대상으로/실제 사람 판단 대상으로 분류하는지 직접 검증한다. autodev.ts/
// continuous-runner.ts에 실제로 배선됐는지는 autodev-tests.ts/continuous-runner-tests.ts가
// 별도로 검증한다 — 이 파일은 판정 로직 자체만 다룬다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function state(overrides: Partial<CoreState>): CoreState {
  return {
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "WAITING_HUMAN",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
    gitCheckpoint: "",
    currentPhase: 1,
    ...overrides,
  };
}

function scenarioHumanFinalReviewGateAlwaysGenuine(): void {
  const s = state({
    humanFinalReview: { taskId: "T1", reviewCycle: 1, status: "PENDING", requestedAt: new Date().toISOString() },
    deferredHumanTasks: [`${REVIEW_CYCLE_EXHAUSTED_REASON}: 테스트`],
    lastGptDecision: { decision: "BLOCK", severity: { critical: 0, high: 0, medium: 0 }, feedback: "", nextTask: null },
  });
  check(
    "Human Final Review gate가 있으면 다른 신호가 전부 기술적이어도 항상 GENUINE",
    classifyWaitingHumanReason(s) === "GENUINE_HUMAN_JUDGMENT"
  );
}

function scenarioReviewCycleExhaustedIsTechnical(): void {
  const s = state({ deferredHumanTasks: [`${REVIEW_CYCLE_EXHAUSTED_REASON}: MAX_REVIEW_CYCLES(5) 도달`] });
  check("REVIEW_CYCLE_EXHAUSTED 마커 → TECHNICAL_AUTO_RECOVERABLE", classifyWaitingHumanReason(s) === "TECHNICAL_AUTO_RECOVERABLE");
  check("isTechnicalAutoRecoverableWaitingHuman()도 동일하게 true", isTechnicalAutoRecoverableWaitingHuman(s));
}

function scenarioReviewBlockedDecisionIsTechnical(): void {
  const s = state({ lastGptDecision: { decision: "BLOCK", severity: { critical: 0, high: 1, medium: 0 }, feedback: "scope 밖", nextTask: null } });
  check("lastGptDecision.decision=BLOCK → TECHNICAL_AUTO_RECOVERABLE", classifyWaitingHumanReason(s) === "TECHNICAL_AUTO_RECOVERABLE");
  const s2 = state({ lastGptDecision: { decision: "HUMAN_REQUIRED", severity: { critical: 0, high: 0, medium: 0 }, feedback: "", nextTask: null } });
  check("lastGptDecision.decision=HUMAN_REQUIRED → TECHNICAL_AUTO_RECOVERABLE", classifyWaitingHumanReason(s2) === "TECHNICAL_AUTO_RECOVERABLE");
}

function scenarioCheckpointScopeViolationIsTechnical(): void {
  const s = state({ deferredHumanTasks: [`CHECKPOINT_BLOCKED(T1): ${CHECKPOINT_SCOPE_VIOLATION_REASON} — unexpected: other/x.txt`] });
  check("CHECKPOINT_BLOCKED + scope-violation 이유 → TECHNICAL_AUTO_RECOVERABLE", classifyWaitingHumanReason(s) === "TECHNICAL_AUTO_RECOVERABLE");
}

function scenarioCheckpointBlockedOtherReasonIsGenuine(): void {
  const s = state({ deferredHumanTasks: ["CHECKPOINT_BLOCKED(T1): secret으로 의심되는 패턴이 발견되었습니다."] });
  check("CHECKPOINT_BLOCKED + scope-violation이 아닌 이유(secret 등) → GENUINE_HUMAN_JUDGMENT", classifyWaitingHumanReason(s) === "GENUINE_HUMAN_JUDGMENT");
}

function scenarioKnownGenuineMarkersStayGenuineEvenWithTechnicalSignal(): void {
  const genuineMarkers = [
    "AUDIT_STORE_UNAVAILABLE_BEFORE_CHECKPOINT(T1): disk full",
    "REMOTE_GIT_CHANGED_DURING_RUN(T1): remote ahead",
    "GPT_RAW_CALL_LIMIT_EXCEEDED: 총 21회",
    "BUDGET_EXCEEDED: 예산 초과",
    "AUTH_ERROR: 인증 실패",
    "QUOTA_EXCEEDED: 쿼터 소진",
    "PROVIDER_SECURITY_BLOCKED: provider 보안 정책",
  ];
  for (const marker of genuineMarkers) {
    // 기술적 신호(REVIEW_CYCLE_EXHAUSTED)가 함께 섞여 있어도 genuine 마커가 하나라도 있으면
    // 전체가 GENUINE으로 남아야 한다 — "섞여 있으면 보수적으로 사람 판단 유지" 원칙.
    const s = state({ deferredHumanTasks: [marker, `${REVIEW_CYCLE_EXHAUSTED_REASON}: 테스트`] });
    check(`genuine 마커(${marker.split(":")[0]}) 존재 시 기술적 신호가 섞여도 GENUINE 유지`, classifyWaitingHumanReason(s) === "GENUINE_HUMAN_JUDGMENT");
  }
}

// AutoDev / JARVIS 신뢰성 보완(2026-08-27 후속) — 실제 JARVIS project-state.json(Phase 2
// Task 2.2)에서 발견된 정확한 stale 마커 형식으로 재현한다: Developer가 TIMEOUT으로 attempt
// 내 재시도까지 소진했을 때 저장되는 마커 하나만 있고 다른 genuine 신호는 전혀 없는 상태.
function scenarioDeveloperTransientRetryExhaustedIsTechnical(): void {
  const s = state({
    deferredHumanTasks: ["DEVELOPER_TRANSIENT_RETRY_EXHAUSTED(TIMEOUT): Claude Developer가 3회 연속 일시적 오류로 응답하지 못했습니다."],
  });
  check(
    "실제 JARVIS 사례 재현: DEVELOPER_TRANSIENT_RETRY_EXHAUSTED(TIMEOUT) 마커 → TECHNICAL_AUTO_RECOVERABLE(Task 위험도와 실패 원인 위험도 분리)",
    classifyWaitingHumanReason(s) === "TECHNICAL_AUTO_RECOVERABLE"
  );
  check("isTechnicalAutoRecoverableWaitingHuman()도 동일하게 true", isTechnicalAutoRecoverableWaitingHuman(s));
}

// GPT_REVIEW_TEMPORARILY_UNAVAILABLE은 2026-08-28 정책 수정으로 GENUINE_MARKER_PREFIXES에서
// 빠졌다(orchestrator.ts가 이제 이 errorCode를 저장하지 않고 무한히 재시도만 하기 때문) — 그
// 목록에서 빠졌다고 해서 auto-recoverable로 잘못 분류되지는 않는다는 것을 확인한다: 이
// 마커는 어떤 auto-recoverable 조건과도 매칭되지 않으므로 fail-closed 기본값(GENUINE)으로
// 그대로 남아야 한다(혹시 이 정책 이전에 만들어진 stale 상태가 있어도 안전).
function scenarioStaleGptReviewUnavailableMarkerStaysGenuineByDefault(): void {
  const s = state({ deferredHumanTasks: ["GPT_REVIEW_TEMPORARILY_UNAVAILABLE: 일시 장애"] });
  check(
    "GPT_REVIEW_TEMPORARILY_UNAVAILABLE 마커는 명시적 genuine 목록에서 빠져도 fail-closed 기본값으로 GENUINE 유지(auto-recoverable로 새지 않음)",
    classifyWaitingHumanReason(s) === "GENUINE_HUMAN_JUDGMENT"
  );
}

function scenarioUnknownReasonDefaultsToGenuine(): void {
  const s = state({ deferredHumanTasks: [] });
  check("알려진 기술 마커가 전혀 없으면(예: HIGH_RISK_ACTION_PREGATE/사용량 제한) fail-closed로 GENUINE", classifyWaitingHumanReason(s) === "GENUINE_HUMAN_JUDGMENT");
  const s2 = state({ deferredHumanTasks: ["UNKNOWN_FUTURE_MARKER_FORMAT_NOT_YET_CLASSIFIED(T1): 새로운 형태"] });
  check("매칭되지 않는 새로운 마커 형식도 fail-closed로 GENUINE", classifyWaitingHumanReason(s2) === "GENUINE_HUMAN_JUDGMENT");
}

function scenarioExtractCheckpointScopeViolationFiles(): void {
  const single = extractCheckpointScopeViolationFiles([`CHECKPOINT_BLOCKED(T1): ${CHECKPOINT_SCOPE_VIOLATION_REASON} — unexpected: a/b.txt`]);
  check("단일 파일 추출", single.length === 1 && single[0] === "a/b.txt");

  const multi = extractCheckpointScopeViolationFiles([`CHECKPOINT_BLOCKED(T1): ${CHECKPOINT_SCOPE_VIOLATION_REASON} — unexpected: a/b.txt, c/d.txt`]);
  check("복수 파일 추출(쉼표 구분)", multi.length === 2 && multi[0] === "a/b.txt" && multi[1] === "c/d.txt");

  const wrongReason = extractCheckpointScopeViolationFiles(["CHECKPOINT_BLOCKED(T1): secret 발견 — unexpected: a/b.txt"]);
  check("scope-violation 이유가 아니면 추출하지 않음(secret 등)", wrongReason.length === 0);

  const noFileList = extractCheckpointScopeViolationFiles([`CHECKPOINT_BLOCKED(T1): ${CHECKPOINT_SCOPE_VIOLATION_REASON}`]);
  check("unexpected 목록이 없으면 빈 배열(추측하지 않음)", noFileList.length === 0);

  const mixed = extractCheckpointScopeViolationFiles([
    `CHECKPOINT_BLOCKED(T1): ${CHECKPOINT_SCOPE_VIOLATION_REASON} — unexpected: a/b.txt`,
    "REQUIRED_TEST_CONFIGURATION_ERROR: task=T2 requiredTest=x missingScript=test:x",
  ]);
  check("무관한 마커가 섞여 있어도 scope-violation 마커만 추출", mixed.length === 1 && mixed[0] === "a/b.txt");
}

function main(): void {
  scenarioHumanFinalReviewGateAlwaysGenuine();
  scenarioReviewCycleExhaustedIsTechnical();
  scenarioReviewBlockedDecisionIsTechnical();
  scenarioCheckpointScopeViolationIsTechnical();
  scenarioCheckpointBlockedOtherReasonIsGenuine();
  scenarioKnownGenuineMarkersStayGenuineEvenWithTechnicalSignal();
  scenarioDeveloperTransientRetryExhaustedIsTechnical();
  scenarioStaleGptReviewUnavailableMarkerStaysGenuineByDefault();
  scenarioUnknownReasonDefaultsToGenuine();
  scenarioExtractCheckpointScopeViolationFiles();

  console.log("\n=== human-gate-policy 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
