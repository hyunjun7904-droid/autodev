import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { ClaudeResult, SeverityCounts, DurableFailureState } from "./types";
import type { SafeExecutorContext } from "./safe-executor";
import type { OrchestratorDeps, GptReviewerReturn } from "./orchestrator";
import { hasFailedRequiredTest } from "./review-policy";
import { computeProblemFingerprint, classifyFailureCategory } from "./failure-stagnation";
import { scanContentForSecrets } from "./secret-scanner";
import { log } from "./logger";

// AutoDev / JARVIS 최종 무인개발 하드닝 — Same-Finding Fireworks Call Limiting & Root Cause
// Analysis.
//
// 배경(§ 실제 JARVIS Task 2.1 재현): failure-stagnation.ts의 기존 stagnation tracker/
// problem-memory.ts는 전부 "required test가 실패했는가"(hasFailedRequiredTest)로만
// 반복을 감지한다 — Task 2.1은 required test가 매 cycle 통과했는데도 Fireworks Reviewer가
// 사실상 같은 지적(동시성/락, fingerprint 검증, audit 로깅)으로 3회 연속 REVISE를 반환했고,
// 이 경로는 기존 어떤 반복 감지 메커니즘에도 걸리지 않았다. 이 파일은 그 gap을 메운다:
// required test 통과 여부와 무관하게 "Reviewer의 REVISE 판정 자체가 반복되는지"를
// deterministic fingerprint로 추적하고, 동일 fingerprint로 2회 연속 REVISE를 받으면 세
// 번째 Fireworks 호출 전에 반드시 로컬 근본원인 분석/로컬 검증으로 전환한다(§ 요구사항 —
// Fireworks 2회 제한).
//
// 이 파일은 orchestrator.ts의 while(true) 루프를 전혀 수정하지 않는다 — 대신
// wrapGptReviewerWithFireworksCallLimiter()가 실제 gptReviewer 함수를 감싸는 decorator로
// 동작한다. orchestrator.ts는 "review 1회를 호출했다"는 사실만 알고, 그 review가 실제
// Fireworks API를 호출했는지(정상 케이스) 아니면 로컬 검증 실패로 Fireworks를 호출하지
// 않고 합성된 REVISE를 돌려받았는지(RCA 케이스)는 구분하지 않는다 — 기존 MAX_REVIEW_CYCLES/
// MAX_GPT_CALLS 상한이 그대로 전체 안전장치로 작동한다(무한 루프 방지는 이미 있는 것을
// 재사용할 뿐 새로 만들지 않는다). 이 decorator는 순수하게 "이번 호출을 실제로 Fireworks에
// 보낼지"만 결정하며, gpt-reviewer.ts/gpt-budget-guard.ts/provider-security-gate.ts 등
// 기존 Fireworks 호출 경로 자체는 전혀 수정하지 않는다.

export const MAX_SAME_FINDING_FIREWORKS_REVIEWS = 2;

export type RootCauseCategory =
  | "INFRASTRUCTURE_CONFIGURATION"
  | "REQUIRED_TEST_REGISTRATION_DRIFT"
  | "TEST_LOGIC_ERROR"
  | "IMPLEMENTATION_ERROR"
  | "REVIEW_EVIDENCE_ERROR"
  | "DEVELOPER_RESPONSE_PARSE_ERROR"
  | "SCOPE_STATE_ERROR"
  | "PROVIDER_ERROR"
  | "SECURITY_OR_POLICY"
  | "UNKNOWN";

/** 리뷰 feedback 원문(자유 텍스트)을 fingerprint 입력으로 쓸 수 있게 정규화한다 — 표현이
 *  조금씩 달라도(숫자/공백 차이 등) 의미상 같은 지적이면 같은 fingerprint가 되도록
 *  숫자를 '#'으로 접고 공백을 하나로 모은 뒤 앞부분만 취한다(§ failure-stagnation.ts
 *  normalizeErrorSignature와 동일한 원칙 — 완벽한 의미 비교가 아니라 결정론적 근사치다,
 *  이 파일도 그 정직한 한계를 그대로 물려받는다). */
function normalizeReviewFeedback(feedback: string): string {
  return feedback
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export interface ReviewFingerprintInput {
  severity: SeverityCounts;
  feedback: string;
  scopeViolations?: string[];
}

/**
 * taskId + (required test 실패 신호 + severity + scope violation 목록 + 정규화된 feedback)
 * 로 결정론적 fingerprint를 만든다. required test가 전부 통과했다면 computeProblemFingerprint
 * 부분은 항상 빈 문자열이므로, 이 fingerprint는 사실상 "Reviewer가 무엇을 근거로 REVISE를
 * 냈는지"만으로 반복 여부를 판정한다 — required test 실패가 있는 경우(더 강한 신호)는 그
 * 실패 신호도 함께 포함해 더 정밀하게 구분한다.
 */
export function computeReviewCycleFingerprint(taskId: string, review: ReviewFingerprintInput, tests: ClaudeResult["tests"]): string {
  const testPart = computeProblemFingerprint(tests);
  const scopePart = [...(review.scopeViolations ?? [])].sort().join(",");
  const sevPart = `${review.severity.critical}.${review.severity.high}.${review.severity.medium}`;
  const feedbackPart = normalizeReviewFeedback(review.feedback);
  const raw = [taskId, sevPart, scopePart, testPart, feedbackPart].join("::");
  return createHash("sha256").update(raw).digest("hex").slice(0, 24);
}

export interface ReviewCallLimiter {
  /** decision==="REVISE"일 때만 호출한다. repeatCount는 이 fingerprint의 연속 반복 횟수(새
   *  fingerprint면 1). triggerRootCauseAnalysis가 true면 다음 호출 전에 반드시 Root Cause
   *  Analysis로 전환해야 한다(§ MAX_SAME_FINDING_FIREWORKS_REVIEWS). */
  observeReviseFingerprint(fingerprint: string): { repeatCount: number; triggerRootCauseAnalysis: boolean };
  reset(): void;
  /** 현재 추적 중인 fingerprint(없으면 undefined) — durable 상태 저장용. */
  currentFingerprint(): string | undefined;
  /** 현재 fingerprint의 연속 반복 횟수(fingerprint가 없으면 0) — durable 상태 저장용. */
  currentRepeatCount(): number;
}

/** orchestrator 1회 실행(REVISE 루프 전체) 동안만 유효한 loop-local tracker — failure-
 *  stagnation.ts의 StagnationTracker와 동일한 원칙으로 project-state.json에 저장하지
 *  않는다. */
export function createReviewCallLimiter(
  maxSameFinding: number = MAX_SAME_FINDING_FIREWORKS_REVIEWS,
  seed?: { fingerprint?: string; repeatCount?: number }
): ReviewCallLimiter {
  // durable seed(§ durable-recovery-state.ts) — 프로세스가 재시작돼도 이전에 이미 관측된
  // fingerprint/반복 횟수를 이어받는다. seed.fingerprint가 없으면(새 task 등) 기존과 동일한
  // 빈 상태로 시작한다.
  let lastFingerprint: string | undefined = seed?.fingerprint;
  let repeatCount = seed?.fingerprint ? (seed.repeatCount ?? 0) : 0;
  return {
    observeReviseFingerprint(fingerprint: string) {
      if (fingerprint === lastFingerprint) repeatCount += 1;
      else {
        lastFingerprint = fingerprint;
        repeatCount = 1;
      }
      return { repeatCount, triggerRootCauseAnalysis: repeatCount >= maxSameFinding };
    },
    reset() {
      lastFingerprint = undefined;
      repeatCount = 0;
    },
    currentFingerprint() {
      return lastFingerprint;
    },
    currentRepeatCount() {
      return lastFingerprint ? repeatCount : 0;
    },
  };
}

export interface RootCauseEvidence {
  claudeErrorCode?: string;
  gptErrorCode?: string;
  scopeViolations?: string[];
  requiredTestRegistrationDrift?: boolean;
  tests: ClaudeResult["tests"];
}

/**
 * 순수 로컬 증거만으로 근본원인을 분류한다(§ 요구사항 15 — Fireworks 호출 0회). 이 함수는
 * 어떤 provider도 호출하지 않는다. TEST_LOGIC_ERROR/REVIEW_EVIDENCE_ERROR는 코드/evidence
 * pipeline의 의미를 이해해야 판정 가능한 범주라 이 계층이 안전하게 추측하지 않는다(§
 * failure-stagnation.ts classifyFailureCategory의 기존 원칙과 동일) — 더 구체적인 신호가
 * 없으면 IMPLEMENTATION_ERROR(가장 흔한, 안전한 기본값: targeted Developer repair로 이어짐)
 * 로 fail-closed한다.
 */
export function classifyRootCause(evidence: RootCauseEvidence): RootCauseCategory {
  if (evidence.claudeErrorCode === "PROTOCOL_ERROR") return "DEVELOPER_RESPONSE_PARSE_ERROR";
  if (evidence.requiredTestRegistrationDrift) return "REQUIRED_TEST_REGISTRATION_DRIFT";
  if (evidence.gptErrorCode === "PROVIDER_SECURITY_BLOCKED") return "SECURITY_OR_POLICY";
  if (evidence.scopeViolations && evidence.scopeViolations.length > 0) return "SCOPE_STATE_ERROR";
  const category = classifyFailureCategory(evidence.claudeErrorCode, evidence.gptErrorCode, evidence.tests);
  if (category === "INFRASTRUCTURE_CONFIGURATION") return "INFRASTRUCTURE_CONFIGURATION";
  if (category === "PROVIDER") return "PROVIDER_ERROR";
  return "IMPLEMENTATION_ERROR";
}

export function describeRootCauseRecoveryAction(category: RootCauseCategory): string {
  switch (category) {
    case "INFRASTRUCTURE_CONFIGURATION":
      return "AutoDev infrastructure가 결정론적으로 해결 가능한지 먼저 확인합니다(Fireworks 호출 없음).";
    case "REQUIRED_TEST_REGISTRATION_DRIFT":
      return "package.json script 등록 충돌 — 자동 덮어쓰기하지 않고 로컬 근본원인 분석으로 처리합니다(Fireworks 호출 없음).";
    case "DEVELOPER_RESPONSE_PARSE_ERROR":
      return "Developer 응답 해석 실패로 분류 — 동일 개발 작업을 처음부터 다시 호출하지 않고 안전한 재해석을 먼저 시도합니다(Fireworks 호출 없음).";
    case "SCOPE_STATE_ERROR":
      return "허용 경로 밖 변경(scope violation) — 기존 안전한 leftover cleanup 경로를 사용합니다(tracked 파일은 삭제하지 않습니다).";
    case "PROVIDER_ERROR":
      return "일시적 provider 오류로 분류 — 기존 재시도/capacity 정책을 사용하고 구현 수정으로 보내지 않습니다.";
    case "TEST_LOGIC_ERROR":
      return "테스트 자체 결함으로 의심됨 — 요구사항을 약화하지 않고 실제 증거와 함께 테스트 수정을 검토합니다.";
    case "IMPLEMENTATION_ERROR":
      return "구현 결함으로 분류 — 실패 근거(직전 Reviewer 지적)를 함께 전달해 targeted repair를 수행합니다.";
    case "REVIEW_EVIDENCE_ERROR":
      return "Reviewer evidence pipeline 문제로 의심됨 — 구현을 왜곡하지 않고 evidence 재확인을 먼저 수행합니다.";
    case "SECURITY_OR_POLICY":
      return "실제 보안/정책 판단 — 자동 승인하지 않고 genuine Human Gate를 유지합니다.";
    case "UNKNOWN":
      return "원인을 결정론적으로 특정할 수 없음 — 추측 수정 없이 fail-closed로 처리합니다.";
  }
}

export interface LocalVerificationResult {
  pass: boolean;
  reason?: string;
}

/**
 * Fireworks 재호출 전 로컬 독립 검증(§ 요구사항 19) — required tests(이미 이번 attempt에서
 * 실행된 결과를 재사용, 추가 실행 없음)/scope 검사(allowedPathPrefixes 기준 단순 prefix
 * 비교, gpt-reviewer.ts의 scope 판정과 별개의 결정론적 로컬 판정)/secret 검사(변경된 파일의
 * 현재 디스크 내용을 scanContentForSecrets로 재검사)만 수행한다. typecheck/build는 이 task의
 * requiredTests가 이미 그것을 포함한 경우 위 tests 결과에 이미 반영되어 있다 — 이 함수가
 * 새로운 명령을 spawn하지는 않는다(Core Command Safety Gate 밖에서 임의 명령을 실행하지
 * 않는다는 원칙 유지). executor가 없으면(테스트 등) secret 재검사만 건너뛴다 — 이 함수는
 * 최종 보안 게이트가 아니라 "Fireworks를 다시 부를 가치가 있는가"를 판단하는 최적화이므로,
 * 확인 불가 시 fail-open으로 건너뛰어도 안전하다(실제 secret gate는 checkpoint 시점에
 * 별도로 항상 강제된다 — § secret-scanner.ts).
 */
export function runLocalVerificationBeforeFireworksRecall(
  result: ClaudeResult,
  allowedPathPrefixes: string[] | undefined,
  executor: SafeExecutorContext | undefined
): LocalVerificationResult {
  if (hasFailedRequiredTest(result.tests)) {
    return { pass: false, reason: "required tests still failing" };
  }
  if (allowedPathPrefixes && allowedPathPrefixes.length > 0) {
    const violations = result.changedFiles.filter((f) => !allowedPathPrefixes.some((p) => f.startsWith(p)));
    if (violations.length > 0) {
      return { pass: false, reason: `scope violation: ${violations.join(", ")}` };
    }
  }
  if (executor?.projectRoot) {
    for (const f of result.changedFiles) {
      let content: string;
      try {
        content = readFileSync(join(executor.projectRoot, ...f.split("/")), "utf-8");
      } catch {
        continue; // 파일이 삭제됐거나 읽을 수 없음 — 이 사전 최적화 검사에서는 치명적이지 않다.
      }
      const findings = scanContentForSecrets(content, f);
      if (findings.length > 0) {
        return { pass: false, reason: `secret pattern detected in ${f}` };
      }
    }
  }
  return { pass: true };
}

export interface RootCauseAnalysisEvent {
  category: RootCauseCategory;
  fingerprint: string;
  priorFeedback: string;
  recoveryAction: string;
  triggered: boolean;
  localVerification?: "PASS" | "FAIL";
  reason?: string;
}

export type GptReviewerFn = NonNullable<OrchestratorDeps["gptReviewer"]>;

export interface FireworksCallLimiterOptions {
  taskId: string;
  executor?: SafeExecutorContext;
  /** RCA가 트리거되거나(triggered=true) 로컬 검증 결과가 나올 때마다 호출된다 — 호출부
   *  (autodev.ts)가 이 정보를 다음 Developer 라운드의 memoryHint에 반영할 수 있게 한다.
   *  지정하지 않으면 순수 로그만 남긴다(기존 다른 optional deps와 동일한 no-op 원칙). */
  onRootCauseAnalysis?: (event: RootCauseAnalysisEvent) => void;
  maxSameFinding?: number;
  /** AutoDev / JARVIS 최종 무인개발 구조 보완 — durable-recovery-state.ts가 loadState()
   *  직후 계산한 이 task의 이전 durable 상태. 지정하지 않으면(undefined) 이전과 완전히
   *  동일한 in-memory-only 동작이다(§ 요구사항 19는 opt-in — autodev.ts만 실제로 이 값을
   *  채운다). */
  initialDurableState?: DurableFailureState;
  /** fingerprint/repeatCount/rootCauseAnalysisCount가 바뀔 때마다 호출된다 — 호출부가
   *  project-state.json에 즉시 반영해 프로세스 재시작에도 살아남게 한다. */
  onDurableStateChange?: (next: DurableFailureState) => void;
}

/**
 * 실제(또는 fake) gptReviewer 함수를 감싸 Fireworks Same-Finding Call Limiting + Root Cause
 * Analysis를 적용한다. orchestrator.ts는 이 wrapper를 "평범한 gptReviewer"로만 인식한다 —
 * 내부에서 실제 provider를 호출했는지 여부는 orchestrator.ts의 어떤 로직에도 영향을 주지
 * 않는다(기존 MAX_REVIEW_CYCLES/MAX_GPT_CALLS 상한이 전체 무한루프 방지를 그대로 담당).
 */
/** RECOVERY_APPLIED 판정(§ 요구사항 20)의 근거 — Developer가 이 attempt에서 실제로 새로운
 *  산출물을 냈는지 결정론적으로 비교하기 위한 snapshot. summary(TASK_COMPLETE 자체 설명 —
 *  실제로 뭔가 다시 시도했다면 매번 새로 생성된다)와 changedFiles 목록을 함께 묶는다. */
function computeAttemptSnapshotKey(result: ClaudeResult): string {
  return `${result.summary}::${[...result.changedFiles].sort().join(",")}`;
}

/** wrapGptReviewerWithFireworksCallLimiter()가 반환하는 함수의 실제 반환 타입 — orchestrator.ts
 *  가 기대하는 GptReviewerFn(Promise<GptReviewerReturn>)의 subtype이라 그대로 대입 가능하다
 *  (함수 반환 타입 covariance). durable 상태(§ 요구사항 19)는 이 extra field를 통해서만
 *  전달된다 — orchestrator.ts를 전혀 수정하지 않고도 그 파일이 이미 하는
 *  `state.lastGptDecision = { ...gptResult, decision }` 스프레드 + 기존 saveCurrentState()
 *  호출에 그대로 편승해 project-state.json에 저장된다(§ 파일 상단 주석과 동일한 원칙 —
 *  claude-developer.ts의 errorCode/requiredTestRegistrationDrift처럼 이 저장소 전반에서
 *  이미 쓰이는 "결과 객체에 extra field를 얹는다" 관례를 그대로 재사용한다).
 */
export type GptReviewerFnWithDurableState = (
  ...args: Parameters<GptReviewerFn>
) => Promise<GptReviewerReturn & { technicalRecoveryState?: DurableFailureState }>;

export function wrapGptReviewerWithFireworksCallLimiter(inner: GptReviewerFn, opts: FireworksCallLimiterOptions): GptReviewerFnWithDurableState {
  const seed = opts.initialDurableState;
  const limiter = createReviewCallLimiter(
    opts.maxSameFinding,
    seed?.failureFingerprint ? { fingerprint: seed.failureFingerprint, repeatCount: seed.sameFailureCount } : undefined
  );
  let rootCauseAnalysisCount = seed?.rootCauseAnalysisCount ?? 0;
  // durable seed가 이미 RCA-pending 상태였다면(프로세스 재시작 전에 트리거됐지만 아직 로컬
  // 재검증을 통과하지 못한 상태) 이 새 wrapper 인스턴스도 그 상태를 그대로 복원한다 — 그렇지
  // 않으면 재시작 직후 첫 review 호출이 곧바로(차단 없이) 세 번째 실제 Fireworks 호출이 되어
  // durable 추적의 의미가 없어진다.
  let pendingRootCause: { category: RootCauseCategory; fingerprint: string; priorFeedback: string; snapshotKey: string } | undefined =
    seed?.pendingRootCauseCategory && seed?.pendingSnapshotKey && seed?.failureFingerprint
      ? {
          category: seed.pendingRootCauseCategory as RootCauseCategory,
          fingerprint: seed.failureFingerprint,
          priorFeedback: seed.lastRecoveryAction ?? "(이전 프로세스의 Reviewer 지적 — 세부 내용은 로그를 참고하세요)",
          snapshotKey: seed.pendingSnapshotKey,
        }
      : undefined;

  let durableSnapshot: DurableFailureState = {
    taskId: opts.taskId,
    failureFingerprint: seed?.failureFingerprint,
    sameFailureCount: seed?.sameFailureCount ?? 0,
    rootCauseAnalysisCount,
    providerTimeoutCount: seed?.providerTimeoutCount ?? 0,
    unexpectedExitCount: seed?.unexpectedExitCount ?? 0,
    pendingRootCauseCategory: seed?.pendingRootCauseCategory,
    pendingSnapshotKey: seed?.pendingSnapshotKey,
    lastRecoveryAction: seed?.lastRecoveryAction,
    updatedAt: new Date().toISOString(),
  };

  const persistDurableState = (patch: Partial<DurableFailureState>): void => {
    durableSnapshot = {
      taskId: opts.taskId,
      failureFingerprint: limiter.currentFingerprint(),
      sameFailureCount: limiter.currentRepeatCount(),
      rootCauseAnalysisCount,
      providerTimeoutCount: durableSnapshot.providerTimeoutCount,
      unexpectedExitCount: durableSnapshot.unexpectedExitCount,
      pendingRootCauseCategory: durableSnapshot.pendingRootCauseCategory,
      pendingSnapshotKey: durableSnapshot.pendingSnapshotKey,
      lastRecoveryAction: durableSnapshot.lastRecoveryAction,
      updatedAt: new Date().toISOString(),
      ...patch,
    };
    opts.onDurableStateChange?.(durableSnapshot);
  };

  return async (result, reviewCycle, task, allowedPathPrefixes, projectContext, gptCallCount, gptRawCallTotal, baseline) => {
    if (pendingRootCause) {
      const recoveryAction = describeRootCauseRecoveryAction(pendingRootCause.category);
      const currentSnapshotKey = computeAttemptSnapshotKey(result);
      // RECOVERY_APPLIED=YES가 실제로 확인될 때만 로컬 검증을 거쳐 재호출을 허용한다(§ 요구사항
      // 20) — Developer가 직전에 이미 검토된 것과 구분되지 않는 산출물을 다시 냈다면(변화 없음)
      // 로컬 검사가 우연히 통과하더라도 Fireworks를 다시 부르지 않는다. 이렇게 하지 않으면
      // "같은 문제가 매 cycle 로컬 검증만 통과하고 실제로는 해결되지 않았는데 계속 재호출"되는
      // 회귀가 생긴다.
      if (currentSnapshotKey === pendingRootCause.snapshotKey) {
        log("ROOT_CAUSE_ANALYSIS — RECOVERY_APPLIED=NO(직전과 구분되지 않는 산출물), Fireworks 호출 없이 재시도", {
          taskId: opts.taskId,
          category: pendingRootCause.category,
        });
        opts.onRootCauseAnalysis?.({
          category: pendingRootCause.category,
          fingerprint: pendingRootCause.fingerprint,
          priorFeedback: pendingRootCause.priorFeedback,
          recoveryAction,
          triggered: true,
          localVerification: "FAIL",
          reason: "RECOVERY_APPLIED=NO — 직전에 이미 검토된 산출물과 구분되지 않음",
        });
        return {
          decision: "REVISE",
          severity: { critical: 0, high: 0, medium: 0 },
          feedback: `AUTODEV_ROOT_CAUSE_ANALYSIS(${pendingRootCause.category}): 아직 새로운 수정이 확인되지 않아 Fireworks를 호출하지 않고 재시도합니다.`,
          nextTask: null,
          requestAttempted: false,
          technicalRecoveryState: durableSnapshot,
        };
      }
      const local = runLocalVerificationBeforeFireworksRecall(result, allowedPathPrefixes, opts.executor);
      if (!local.pass) {
        // 새로운 시도이긴 하지만 로컬 검증에 아직 실패함 — snapshot을 이번 시도로 갱신해 다음
        // 비교 기준으로 삼는다(다음 시도가 이번과 동일하면 위 RECOVERY_APPLIED=NO 분기로
        // 수렴한다).
        pendingRootCause = { ...pendingRootCause, snapshotKey: currentSnapshotKey };
        persistDurableState({ pendingRootCauseCategory: pendingRootCause.category, pendingSnapshotKey: currentSnapshotKey, lastRecoveryAction: local.reason });
        log("ROOT_CAUSE_ANALYSIS — 로컬 검증 실패, Fireworks 호출 없이 Developer 재시도로 되돌림", {
          taskId: opts.taskId,
          category: pendingRootCause.category,
          reason: local.reason,
        });
        opts.onRootCauseAnalysis?.({
          category: pendingRootCause.category,
          fingerprint: pendingRootCause.fingerprint,
          priorFeedback: pendingRootCause.priorFeedback,
          recoveryAction,
          triggered: true,
          localVerification: "FAIL",
          reason: local.reason,
        });
        return {
          decision: "REVISE",
          severity: { critical: 0, high: 0, medium: 0 },
          feedback: `AUTODEV_ROOT_CAUSE_ANALYSIS(${pendingRootCause.category}): 로컬 검증 실패(${local.reason}) — Fireworks를 호출하지 않고 재시도합니다.`,
          nextTask: null,
          requestAttempted: false,
          technicalRecoveryState: durableSnapshot,
        };
      }
      log("ROOT_CAUSE_ANALYSIS — 로컬 검증 통과, Fireworks 재검증 1회 허용", { taskId: opts.taskId, category: pendingRootCause.category });
      opts.onRootCauseAnalysis?.({
        category: pendingRootCause.category,
        fingerprint: pendingRootCause.fingerprint,
        priorFeedback: pendingRootCause.priorFeedback,
        recoveryAction,
        triggered: true,
        localVerification: "PASS",
      });
      pendingRootCause = undefined;
      persistDurableState({ pendingRootCauseCategory: undefined, pendingSnapshotKey: undefined, lastRecoveryAction: `${recoveryAction}(로컬 검증 통과 — 재검증 진행)` });
    }

    const gptResult = await inner(result, reviewCycle, task, allowedPathPrefixes, projectContext, gptCallCount, gptRawCallTotal, baseline);

    if (gptResult.decision === "REVISE") {
      const fingerprint = computeReviewCycleFingerprint(opts.taskId, gptResult, result.tests);
      const { repeatCount, triggerRootCauseAnalysis } = limiter.observeReviseFingerprint(fingerprint);
      if (triggerRootCauseAnalysis) {
        const category = classifyRootCause({
          claudeErrorCode: (result as ClaudeResult & { errorCode?: string }).errorCode,
          requiredTestRegistrationDrift: (result as ClaudeResult & { requiredTestRegistrationDrift?: boolean }).requiredTestRegistrationDrift,
          gptErrorCode: gptResult.errorCode,
          scopeViolations: gptResult.scopeViolations,
          tests: result.tests,
        });
        pendingRootCause = { category, fingerprint, priorFeedback: gptResult.feedback, snapshotKey: computeAttemptSnapshotKey(result) };
        rootCauseAnalysisCount += 1;
        const recoveryAction = describeRootCauseRecoveryAction(category);
        persistDurableState({
          failureFingerprint: fingerprint,
          sameFailureCount: repeatCount,
          rootCauseAnalysisCount,
          pendingRootCauseCategory: category,
          pendingSnapshotKey: pendingRootCause.snapshotKey,
          lastRecoveryAction: recoveryAction,
        });
        log("ROOT_CAUSE_ANALYSIS_TRIGGERED — 동일 reviewer finding이 연속 REVISE로 반복됨", {
          taskId: opts.taskId,
          category,
          repeatCount,
          fingerprint,
        });
        // 다음 Developer 라운드(claudeRunner)가 이 gptReviewer 호출보다 먼저 실행되므로,
        // 그 라운드가 이 분류/권장 조치를 프롬프트에 반영할 수 있도록 즉시 알린다 — 실제
        // 로컬 검증 결과(PASS/FAIL)는 그 다음 gptReviewer 호출 시점에 별도로 다시 알린다.
        opts.onRootCauseAnalysis?.({
          category,
          fingerprint,
          priorFeedback: gptResult.feedback,
          recoveryAction,
          triggered: true,
        });
      } else {
        // 아직 임계치에 도달하지 않은 반복(1회차 또는 새 fingerprint) — durable 카운터만
        // 최신 상태로 반영해 다음 프로세스 재시작에도 이 진행 상황이 보존되게 한다.
        persistDurableState({ failureFingerprint: fingerprint, sameFailureCount: repeatCount });
      }
    } else {
      limiter.reset();
      // PASS/BLOCK/HUMAN_REQUIRED — 이 review cycle의 REVISE 반복 추적은 끝났다. task
      // 완료(checkpoint)/새 task 전환 시점의 최종 초기화는 autodev.ts가
      // clearDurableFailureState()로 명시적으로 수행한다(§ durable-recovery-state.ts) — 이
      // wrapper는 그 결정을 내리지 않는다(BLOCK/HUMAN_REQUIRED는 아직 "완료"가 아닐 수 있음).
    }

    return { ...gptResult, technicalRecoveryState: durableSnapshot };
  };
}
