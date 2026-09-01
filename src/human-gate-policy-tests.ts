import {
  classifyWaitingHumanReason,
  isTechnicalAutoRecoverableWaitingHuman,
  extractCheckpointScopeViolationFiles,
  reconcileKnownTechnicalDeferredMarkers,
  isKnownGenuineDeferredMarker,
  isKnownRetryEligibleTechnicalMarker,
} from "./human-gate-policy";
import { CHECKPOINT_SCOPE_VIOLATION_REASON } from "./approval";
import { REVIEW_CYCLE_EXHAUSTED_REASON } from "./review-policy";
import { STAGNATION_DETECTED_MARKER_PREFIX } from "./failure-stagnation";
import { DEVELOPER_TRANSIENT_RETRY_EXHAUSTED_PREFIX } from "./claude-developer";
import {
  MAX_GPT_CALLS_EXCEEDED_MARKER_PREFIX,
  CLAUDE_STRUCTURAL_FAILURE_MARKER_PREFIX,
  DETERMINISTIC_REVIEW_CYCLE_EXHAUSTED_MARKER_PREFIX,
} from "./orchestrator";
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

// No-Safe-Recovery-Action Gate(2026-08-31) — Positive-Provenance-Only Auto-Delete Policy
// (a490700)로 scope-violation leftover 자동 삭제가 완전히 제거된 이후로는, Developer/
// Reviewer를 아무리 재시도해도 이 blocker는 스스로 해결되지 않는다(Developer에게 삭제
// action이 없고, 그 경로 밖 파일이라 WRITE_FILE로도 지울 수 없다) — 그래서 더 이상
// TECHNICAL_AUTO_RECOVERABLE이 아니라 GENUINE_HUMAN_JUDGMENT다(§ 요구사항: "실제 파일
// 삭제/보존 판단처럼 사용자 판단이 필요한 경우"). 이 시나리오 이름/기대값을 새 정책에 맞게
// 뒤집었다 — 기존 이름(...IsTechnical)이 그대로 남아있으면 오히려 이 재분류가 실수인 것처럼
// 오해될 수 있어 이름도 함께 바꿨다.
function scenarioCheckpointScopeViolationIsGenuine(): void {
  const s = state({ deferredHumanTasks: [`CHECKPOINT_BLOCKED(T1): ${CHECKPOINT_SCOPE_VIOLATION_REASON} — unexpected: other/x.txt`] });
  check("CHECKPOINT_BLOCKED + scope-violation 이유 → GENUINE_HUMAN_JUDGMENT(No-Safe-Recovery-Action Gate)", classifyWaitingHumanReason(s) === "GENUINE_HUMAN_JUDGMENT");
  check("isTechnicalAutoRecoverableWaitingHuman()도 동일하게 false", isTechnicalAutoRecoverableWaitingHuman(s) === false);
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

// Task 4.1 조사에서 재현된 실제 stale 사례 — STAGNATION_DETECTED 마커만 있고 다른 genuine
// 신호가 전혀 없는 WAITING_HUMAN(§ human-gate-policy.ts 상단 주석 "STAGNATION_DETECTED_MARKER_
// PREFIX 마커" 항목). 이 마커는 관측용 표시일 뿐 사람 판단이 필요하다는 신호가 아니므로,
// 어떤 FailureCategory가 붙어 있든(INFRASTRUCTURE_CONFIGURATION/IMPLEMENTATION/PROVIDER/
// UNKNOWN) TECHNICAL_AUTO_RECOVERABLE로 분류돼야 한다.
function scenarioStagnationDetectedAloneIsTechnical(): void {
  for (const category of ["INFRASTRUCTURE_CONFIGURATION", "IMPLEMENTATION", "PROVIDER", "UNKNOWN"]) {
    const s = state({
      deferredHumanTasks: [`${STAGNATION_DETECTED_MARKER_PREFIX}${category}): reviewCycle=3에서 동일한 required test 실패가 2회 연속 반복됨`],
    });
    check(
      `STAGNATION_DETECTED(${category}) 마커만 있으면 → TECHNICAL_AUTO_RECOVERABLE(사람 판단 신호 아님)`,
      classifyWaitingHumanReason(s) === "TECHNICAL_AUTO_RECOVERABLE"
    );
    check("isTechnicalAutoRecoverableWaitingHuman()도 동일하게 true", isTechnicalAutoRecoverableWaitingHuman(s));
  }
}

// STAGNATION_DETECTED가 실제 genuine 마커와 함께 섞여 있으면(예: 반복되던 required test
// 실패가 결국 SECURITY_BLOCKED류의 CHECKPOINT_BLOCKED로 이어진 경우) 여전히 GENUINE으로
// 남아야 한다 — "섞여 있으면 보수적으로 사람 판단 유지" 원칙(§
// scenarioKnownGenuineMarkersStayGenuineEvenWithTechnicalSignal과 동일한 원칙을
// STAGNATION_DETECTED에도 적용).
function scenarioStagnationDetectedWithGenuineMarkerStaysGenuine(): void {
  const s = state({
    deferredHumanTasks: [
      `${STAGNATION_DETECTED_MARKER_PREFIX}IMPLEMENTATION): reviewCycle=2에서 동일한 required test 실패가 2회 연속 반복됨`,
      "CHECKPOINT_BLOCKED(T1): secret으로 의심되는 패턴이 발견되었습니다.",
    ],
  });
  check(
    "STAGNATION_DETECTED와 genuine 마커(SECURITY_BLOCKED류 CHECKPOINT_BLOCKED)가 함께 있으면 GENUINE 유지",
    classifyWaitingHumanReason(s) === "GENUINE_HUMAN_JUDGMENT"
  );
}

// 실제 회귀에서 발견된 사례(§ production-agent-integration-tests.ts
// scenarioAdvisoryCannotOverrideCoreTestFailure) — 같은 required test 실패가 반복되는
// REVISE 루프가 도중에 STAGNATION_DETECTED 마커를 남긴 뒤에도 계속 진행되다가, 결국
// MAX_GPT_CALLS(비용 상한)에 도달해 genuine WAITING_HUMAN이 될 수 있다. STAGNATION_DETECTED
// 마커 하나만 보고 자동 복구하면 이 비용 신호를 조용히 무시하게 되므로, orchestrator.ts가
// 이 시점에 남기는 MAX_GPT_CALLS_EXCEEDED_MARKER_PREFIX 마커가 반드시 GENUINE으로 이겨야
// 한다.
function scenarioStagnationDetectedWithMaxGptCallsExceededStaysGenuine(): void {
  const s = state({
    deferredHumanTasks: [
      `${STAGNATION_DETECTED_MARKER_PREFIX}INFRASTRUCTURE_CONFIGURATION): reviewCycle=2에서 동일한 required test 실패가 2회 연속 반복됨`,
      `${MAX_GPT_CALLS_EXCEEDED_MARKER_PREFIX} 총 11회`,
    ],
  });
  check(
    "STAGNATION_DETECTED와 MAX_GPT_CALLS_EXCEEDED가 함께 있으면 GENUINE 유지(비용 신호를 조용히 무시하지 않음)",
    classifyWaitingHumanReason(s) === "GENUINE_HUMAN_JUDGMENT"
  );
}

// § P0-3 재하드닝(독립 감사) → § BLOCKER 2 재하드닝(독립 최종 감사, 2026-08-30 후속)이
// 범위를 넓혔다. CLAUDE_STRUCTURAL_FAILURE_MARKER_PREFIX는 errorCode에 따라 갈린다:
// PROTOCOL_ERROR/INVALID_OUTPUT/NON_ZERO_EXIT/TASK_ACTION_LIMIT/NO_PROGRESS_STAGNATION
// (전부 claude-developer.ts/claude-runner.ts 실제 생성 의미를 확인함 — "응답을 해석하지
// 못함"/"프로세스 실행 실패"/"반복·무진척 예산 소진" 순수 기술적 상황)은
// TECHNICAL_AUTO_RECOVERABLE이어야 한다 — 이전 정책(PROTOCOL_ERROR만 예외, 나머지 전부
// GENUINE)이 독립 감사에서 오분류로 재확인됐다. AUTH_REQUIRED(사람 로그인 필요 — 재시도로
// 해결 불가)와 실행 파일 신뢰 검증 실패(보안 성격, § 그 코드 주석)는 여전히 GENUINE을
// 유지한다 — provider가 응답을 아예 못 준 것(DEVELOPER_TRANSIENT_RETRY_EXHAUSTED_PREFIX)과
// 다른, 사람이 봐야 할 진짜 문제일 수 있다. UNKNOWN(알 수 없는 errorCode)도 fail-closed로
// GENUINE을 유지한다.
function scenarioClaudeStructuralFailureProtocolErrorIsTechnical(): void {
  const s = state({ deferredHumanTasks: [`${CLAUDE_STRUCTURAL_FAILURE_MARKER_PREFIX}PROTOCOL_ERROR): Claude 결과가 구조적으로 실패`] });
  check(
    "P0-3) CLAUDE_STRUCTURAL_FAILURE(PROTOCOL_ERROR) 단독 → TECHNICAL_AUTO_RECOVERABLE(protocol parse failure는 genuine 아님)",
    classifyWaitingHumanReason(s) === "TECHNICAL_AUTO_RECOVERABLE"
  );

  const s2 = state({
    deferredHumanTasks: [
      `${STAGNATION_DETECTED_MARKER_PREFIX}IMPLEMENTATION): reviewCycle=2에서 동일한 required test 실패가 2회 연속 반복됨`,
      `${CLAUDE_STRUCTURAL_FAILURE_MARKER_PREFIX}PROTOCOL_ERROR): Claude 결과가 구조적으로 실패`,
    ],
  });
  check(
    "P0-3) STAGNATION_DETECTED와 CLAUDE_STRUCTURAL_FAILURE(PROTOCOL_ERROR)가 함께 있어도 둘 다 기술적 신호라 TECHNICAL_AUTO_RECOVERABLE",
    classifyWaitingHumanReason(s2) === "TECHNICAL_AUTO_RECOVERABLE"
  );

  for (const code of ["INVALID_OUTPUT", "NON_ZERO_EXIT", "TASK_ACTION_LIMIT", "NO_PROGRESS_STAGNATION"]) {
    const sTech = state({ deferredHumanTasks: [`${CLAUDE_STRUCTURAL_FAILURE_MARKER_PREFIX}${code}): Claude 결과가 구조적으로 실패`] });
    check(
      `BLOCKER2) CLAUDE_STRUCTURAL_FAILURE(${code}) → TECHNICAL_AUTO_RECOVERABLE(순수 파싱/실행/무진척 실패, genuine 아님)`,
      classifyWaitingHumanReason(sTech) === "TECHNICAL_AUTO_RECOVERABLE"
    );
  }

  for (const code of ["AUTH_REQUIRED", "TRUSTED_EXECUTABLE_NOT_FOUND", "EXECUTABLE_IDENTITY_UNTRUSTED", "EXECUTABLE_SHADOWING_DETECTED", "UNKNOWN"]) {
    const sGenuine = state({ deferredHumanTasks: [`${CLAUDE_STRUCTURAL_FAILURE_MARKER_PREFIX}${code}): Claude 결과가 구조적으로 실패`] });
    check(
      `BLOCKER2) CLAUDE_STRUCTURAL_FAILURE(${code})는 여전히 GENUINE_HUMAN_JUDGMENT(재시도로 해결 불가 또는 보안 성격 또는 알 수 없는 코드)`,
      classifyWaitingHumanReason(sGenuine) === "GENUINE_HUMAN_JUDGMENT"
    );
  }
}

// AutoDev Core Maintenance(2026-08-30) — 같은 cycle에 STAGNATION_DETECTED가 먼저 push되고
// (repeatCount===2 시점) 그 후 이 마커가 MAX_REVIEW_CYCLES 소진 시점에 함께 push되는 실제
// 순서를 그대로 재현한다. § 위 두 시나리오와 동일한 co-occurrence 안전장치 패턴.
function scenarioStagnationDetectedWithDeterministicReviewCycleExhaustedStaysGenuine(): void {
  const s = state({
    deferredHumanTasks: [
      `${STAGNATION_DETECTED_MARKER_PREFIX}IMPLEMENTATION): reviewCycle=2에서 동일한 required test 실패가 2회 연속 반복됨`,
      `${DETERMINISTIC_REVIEW_CYCLE_EXHAUSTED_MARKER_PREFIX} reviewCycle=5에서 동일 required test 실패가 4회 반복된 채 MAX_REVIEW_CYCLES(5) 도달`,
    ],
  });
  check(
    "STAGNATION_DETECTED와 DETERMINISTIC_REVIEW_CYCLE_EXHAUSTED가 함께 있으면 GENUINE 유지(무제한 backoff로 조용히 새지 않음)",
    classifyWaitingHumanReason(s) === "GENUINE_HUMAN_JUDGMENT"
  );
  check("isTechnicalAutoRecoverableWaitingHuman()도 동일하게 false", !isTechnicalAutoRecoverableWaitingHuman(s));
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

// ---------------------------------------------------------------------------
// Durable Technical Blocker Recovery — reconcileKnownTechnicalDeferredMarkers() /
// isKnownGenuineDeferredMarker() / isKnownRetryEligibleTechnicalMarker() (2026-09-01,
// generic defect — BLOCKED 상태에서도 STAGNATION_DETECTED 등이 자동복구 자격을 잃지 않아야
// 한다). generic fixture만 사용한다 — JARVIS/Task 5.3 이름을 쓰지 않는다.
// ---------------------------------------------------------------------------

const GENERIC_STAGNATION_MARKER = `${STAGNATION_DETECTED_MARKER_PREFIX}IMPLEMENTATION): reviewCycle=2에서 동일한 required test 실패가 2회 연속 반복됨`;
const GENERIC_REVIEW_CYCLE_EXHAUSTED_MARKER = `${REVIEW_CYCLE_EXHAUSTED_REASON}: 5회 REVISE 소진`;
const GENERIC_DEVELOPER_TRANSIENT_RETRY_MARKER = `${DEVELOPER_TRANSIENT_RETRY_EXHAUSTED_PREFIX}TIMEOUT)`;
const GENERIC_GENUINE_MARKER = "CHECKPOINT_BLOCKED(T1): secret detected — human review required";
const GENERIC_ENV_MARKER = "REQUIRED_TEST_EXECUTION_ENVIRONMENT_ERROR: task=T1 requiredTest=unit kind=WRAPPER_NOT_FOUND cwd=mod resolvedPath=/tmp/mod";
const GENERIC_CONFIG_MARKER = "REQUIRED_TEST_CONFIGURATION_ERROR: task=T1 requiredTest=unit missingScript=test:unit";
const GENERIC_MALFORMED_STAGNATION_LIKE = "STAGNATION_DETECTED IMPLEMENTATION reviewCycle=2에서 동일한 실패가 반복됨"; // 여는 괄호 누락

function scenarioReconcileEmptyIsNoop(): void {
  const empty: readonly string[] = [];
  const result = reconcileKnownTechnicalDeferredMarkers(empty);
  check("Durable-Technical/H) 빈 배열은 no-op(resolvedMarkers 비어있음)", result.resolvedMarkers.length === 0);
  check("Durable-Technical/H) 빈 배열은 원본 참조와 동일", result.remainingDeferredHumanTasks === empty);
}

function scenarioReconcileStagnationAloneResolves(): void {
  // A) STAGNATION_DETECTED 단독 → 제거되어 완전히 빈 배열이 됨(호출부가 이걸 근거로 READY
  // 전환 가능).
  const markers: readonly string[] = [GENERIC_STAGNATION_MARKER];
  const result = reconcileKnownTechnicalDeferredMarkers(markers);
  check("Durable-Technical/A) STAGNATION_DETECTED 단독 marker가 resolved됨", result.resolvedMarkers.length === 1 && result.resolvedMarkers[0] === GENERIC_STAGNATION_MARKER);
  check("Durable-Technical/A) 남은 marker가 완전히 없음", result.remainingDeferredHumanTasks.length === 0);
}

function scenarioReconcileMixedWithEnvMarkerOnlyResolvesStagnation(): void {
  // C) STAGNATION_DETECTED + 이미 해결된 것으로 가정한 ENV marker(이 함수 자신은 ENV marker의
  // 해결 여부를 판정하지 않는다 — 그건 reconcileStaleRequiredTestExecutionEnvironmentTasks의
  // 몫이다. 여기서는 "이 함수가 ENV marker 자체를 절대 건드리지 않는다"만 검증한다).
  const markers: readonly string[] = [GENERIC_STAGNATION_MARKER, GENERIC_ENV_MARKER];
  const result = reconcileKnownTechnicalDeferredMarkers(markers);
  check("Durable-Technical/C) STAGNATION_DETECTED만 resolved됨", result.resolvedMarkers.length === 1 && result.resolvedMarkers[0] === GENERIC_STAGNATION_MARKER);
  check("Durable-Technical/C) ENV marker는 이 함수가 전혀 건드리지 않고 그대로 보존", result.remainingDeferredHumanTasks.length === 1 && result.remainingDeferredHumanTasks[0] === GENERIC_ENV_MARKER);
}

function scenarioReconcileMixedWithGenuineMarkerResolvesStagnationButKeepsGenuine(): void {
  // D) STAGNATION_DETECTED + GENUINE_HUMAN_MARKER → STAGNATION_DETECTED는 독립적으로
  // resolved되지만 genuine marker는 이 함수가 알 수 있는 어떤 marker 형식에도 매칭되지
  // 않으므로 항상 그대로 남는다 — 호출부가 remainingDeferredHumanTasks를 완전히 비우지
  // 못해 자동 READY 전환이 구조적으로 불가능해진다.
  const markers: readonly string[] = [GENERIC_STAGNATION_MARKER, GENERIC_GENUINE_MARKER];
  const result = reconcileKnownTechnicalDeferredMarkers(markers);
  check("Durable-Technical/D) genuine marker와 섞여 있어도 STAGNATION_DETECTED는 독립적으로 resolved됨", result.resolvedMarkers.length === 1 && result.resolvedMarkers[0] === GENERIC_STAGNATION_MARKER);
  check("Durable-Technical/D) genuine marker는 자동 제거/승인되지 않고 그대로 보존됨", result.remainingDeferredHumanTasks.length === 1 && result.remainingDeferredHumanTasks[0] === GENERIC_GENUINE_MARKER);
}

function scenarioReconcileMultipleKnownTechnicalMarkersAllResolve(): void {
  // 알려진 기술적 marker 여러 종류(STAGNATION_DETECTED/REVIEW_CYCLE_EXHAUSTED/
  // DEVELOPER_TRANSIENT_RETRY_EXHAUSTED)가 함께 있어도 전부 독립적으로 resolved됨 —
  // classifyWaitingHumanReason()이 이 셋을 전부 TECHNICAL_AUTO_RECOVERABLE로 보는 것과
  // 동일한 taxonomy를 재사용한다는 것을 직접 증명한다.
  const markers: readonly string[] = [GENERIC_STAGNATION_MARKER, GENERIC_REVIEW_CYCLE_EXHAUSTED_MARKER, GENERIC_DEVELOPER_TRANSIENT_RETRY_MARKER];
  const result = reconcileKnownTechnicalDeferredMarkers(markers);
  check("Durable-Technical) 알려진 기술적 marker 3종 전부 resolved됨", result.resolvedMarkers.length === 3);
  check("Durable-Technical) 남은 marker가 완전히 없음", result.remainingDeferredHumanTasks.length === 0);
}

function scenarioReconcileMalformedStagnationLikeMarkerNeverRemoved(): void {
  // G) STAGNATION_DETECTED_MARKER_PREFIX("STAGNATION_DETECTED(")와 정확히 일치하지 않는
  // (여는 괄호가 없는) 자유 문장 — fail-closed로 절대 제거되지 않는다.
  const markers: readonly string[] = [GENERIC_MALFORMED_STAGNATION_LIKE];
  const result = reconcileKnownTechnicalDeferredMarkers(markers);
  check("Durable-Technical/G) 형식이 정확히 일치하지 않는 marker는 절대 제거되지 않음", result.resolvedMarkers.length === 0);
  check("Durable-Technical/G) remainingDeferredHumanTasks가 원본과 동일", result.remainingDeferredHumanTasks === markers);
}

function scenarioReconcileNoKnownMarkerIsNoop(): void {
  // I) 이 함수가 아는 형식의 marker가 전혀 없으면(ENV/CONFIG만 있으면) no-op.
  const markers: readonly string[] = [GENERIC_ENV_MARKER, GENERIC_CONFIG_MARKER];
  const result = reconcileKnownTechnicalDeferredMarkers(markers);
  check("Durable-Technical/I) 알려진 기술적 marker가 없으면 resolvedMarkers가 비어있음", result.resolvedMarkers.length === 0);
  check("Durable-Technical/I) remainingDeferredHumanTasks가 원본 참조와 동일(no-op)", result.remainingDeferredHumanTasks === markers);
}

function scenarioGenuineAndTechnicalPredicatesAreMutuallyExclusive(): void {
  // 구조적 invariant 회귀: 이 파일이 아는 모든 genuine marker 예시와 모든 기술적 marker
  // 예시가 서로의 predicate에 절대 동시에 매칭되지 않는다 — 그래야
  // reconcileKnownTechnicalDeferredMarkers()가 genuine marker를 실수로 제거할 구조적
  // 가능성 자체가 없다고 보장할 수 있다(요구사항 E).
  const genuineExamples = [
    "AUDIT_STORE_UNAVAILABLE_BEFORE_CHECKPOINT(disk full)",
    "REMOTE_GIT_CHANGED_DURING_RUN(origin/main advanced)",
    "GPT_RAW_CALL_LIMIT_EXCEEDED: 100회 초과",
    "BUDGET_EXCEEDED: $50 초과",
    "AUTH_ERROR: invalid api key",
    "QUOTA_EXCEEDED: rate limit",
    "PROVIDER_SECURITY_BLOCKED: policy violation",
    `${MAX_GPT_CALLS_EXCEEDED_MARKER_PREFIX}10회 초과)`,
    `${DETERMINISTIC_REVIEW_CYCLE_EXHAUSTED_MARKER_PREFIX}STAGNATION_DETECTED와 동시 발생)`,
    GENERIC_GENUINE_MARKER,
    `${CLAUDE_STRUCTURAL_FAILURE_MARKER_PREFIX}AUTH_REQUIRED)`,
  ];
  const technicalExamples = [GENERIC_STAGNATION_MARKER, GENERIC_REVIEW_CYCLE_EXHAUSTED_MARKER, GENERIC_DEVELOPER_TRANSIENT_RETRY_MARKER, `${CLAUDE_STRUCTURAL_FAILURE_MARKER_PREFIX}PROTOCOL_ERROR)`];

  const genuineLeaksIntoTechnical = genuineExamples.filter((m) => isKnownRetryEligibleTechnicalMarker(m));
  check("Durable-Technical) genuine marker 예시가 기술적 predicate에 매칭되지 않음(상호배타성)", genuineLeaksIntoTechnical.length === 0);

  const technicalLeaksIntoGenuine = technicalExamples.filter((m) => isKnownGenuineDeferredMarker(m));
  check("Durable-Technical) 기술적 marker 예시가 genuine predicate에 매칭되지 않음(상호배타성)", technicalLeaksIntoGenuine.length === 0);
}

function main(): void {
  scenarioHumanFinalReviewGateAlwaysGenuine();
  scenarioReviewCycleExhaustedIsTechnical();
  scenarioReviewBlockedDecisionIsTechnical();
  scenarioCheckpointScopeViolationIsGenuine();
  scenarioCheckpointBlockedOtherReasonIsGenuine();
  scenarioKnownGenuineMarkersStayGenuineEvenWithTechnicalSignal();
  scenarioDeveloperTransientRetryExhaustedIsTechnical();
  scenarioStaleGptReviewUnavailableMarkerStaysGenuineByDefault();
  scenarioStagnationDetectedAloneIsTechnical();
  scenarioStagnationDetectedWithGenuineMarkerStaysGenuine();
  scenarioStagnationDetectedWithMaxGptCallsExceededStaysGenuine();
  scenarioStagnationDetectedWithDeterministicReviewCycleExhaustedStaysGenuine();
  scenarioClaudeStructuralFailureProtocolErrorIsTechnical();
  scenarioUnknownReasonDefaultsToGenuine();
  scenarioExtractCheckpointScopeViolationFiles();

  scenarioReconcileEmptyIsNoop();
  scenarioReconcileStagnationAloneResolves();
  scenarioReconcileMixedWithEnvMarkerOnlyResolvesStagnation();
  scenarioReconcileMixedWithGenuineMarkerResolvesStagnationButKeepsGenuine();
  scenarioReconcileMultipleKnownTechnicalMarkersAllResolve();
  scenarioReconcileMalformedStagnationLikeMarkerNeverRemoved();
  scenarioReconcileNoKnownMarkerIsNoop();
  scenarioGenuineAndTechnicalPredicatesAreMutuallyExclusive();

  console.log("\n=== human-gate-policy 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
