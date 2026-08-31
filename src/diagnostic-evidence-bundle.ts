import type { FailureClass } from "./failure-taxonomy";
import type { PrerequisiteFeasibility } from "./required-test-preflight";

// AutoDev 최종 통합 하드닝(Hardening F, Diagnostic Evidence Bundle) — 새 대형 subsystem을
// 만들지 않는다. 이 파일은 이미 여러 곳(failure-taxonomy.ts/problem-memory.ts/
// required-test-preflight.ts/durable-recovery-state.ts/claude-developer.ts 등)이 흩어져서
// 알고 있는 정보를 "다음 round/다음 project가 다시 조사하지 않고 그대로 재사용할 수 있는"
// 하나의 안전한 구조로 조합만 한다 — 새 조사 로직, 새 fs/network 접근, 새 state 저장소를
// 만들지 않는다(순수 함수, 부수효과 없음).
//
// 실제 secret 값은 이 파일이 직접 다루지 않는다 — 이 bundle을 로그로 남길 때는 항상
// logger.ts의 log(message, meta)를 통해서만 남긴다(log()가 이미 JSON 직렬화 결과 전체에
// sanitizeForLog를 적용한다 — 이 파일이 별도 redaction을 다시 구현하지 않는다, 단일 출처
// 원칙). 이 파일 자신은 어떤 필드도 "확실하지 않은데 0/빈 문자열로 채우기"를 하지 않는다 —
// 호출부가 실제로 알고 있는 값만 넘기고, 모르면 필드 자체를 생략한다(undefined로 남는다).

export interface DiagnosticEvidenceBundleInput {
  taskId: string;
  failureClass?: FailureClass;
  failureClassReason?: string;
  /** problem-memory.ts computeProblemFingerprint()가 계산한 값을 그대로 받는다(재계산 없음). */
  failureFingerprint?: string;
  requiredTestName?: string;
  cwd?: string;
  command?: string;
  args?: readonly string[];
  exitCode?: number;
  executionContractOk?: boolean;
  prerequisiteFeasibility?: PrerequisiteFeasibility;
  prerequisiteFeasibilityReason?: string;
  recentChangedFiles?: readonly string[];
  lastSuccessfulStage?: string;
  readCount?: number;
  duplicateReadCount?: number;
  writeCount?: number;
  /** claude-developer.ts consecutiveNoWriteFailures/DurableFailureState.noWriteRepeatCount. */
  writeZeroRounds?: number;
  developerCalls?: number;
  reviewerCalls?: number;
  retries?: number;
  activeTimeMs?: number;
  /** problem-memory.ts lookupSolution()/lookupSolutionsByRootCauseClass() 결과 요약 —
   *  원본 solution 전문이 아니라 "무엇을 찾았는지"만(§ 토큰 효율, 이미 각 호출부가 요약해
   *  넘긴다). */
  problemMemoryMatch?: { tier: "PROJECT" | "COMMON"; entryId: string } | null;
  priorVerifiedResolutionSummary?: string | null;
  /** 이미 시도했지만 실패로 확인된 접근(§ problem-memory attemptedSolutions) — 다음 round가
   *  같은 접근을 다시 시도하지 않도록. */
  failedStrategies?: readonly string[];
  /** 사람이 읽는 "다음에 결정론적으로 할 수 있는 행동" 한 줄 — 이 필드가 없으면 UNKNOWN으로
   *  남는다(추측으로 채우지 않는다). */
  nextDeterministicAction?: string;
}

export type DiagnosticEvidenceBundle = DiagnosticEvidenceBundleInput;

/**
 * 순수 조합 함수 — 입력을 그대로 구조화해 반환한다. 새 필드를 추측으로 채우지 않고, 호출부가
 * 넘기지 않은 값은 그대로 undefined로 남는다("UNKNOWN을 0으로 표시하지 않는다" 원칙과 동일).
 * exitCode/counts처럼 실제로 0이 유효한 값인 필드와, "확인 안 됨"을 구분해야 하는 필드
 * (예: prerequisiteFeasibility)를 혼동하지 않도록 값을 변형하지 않고 그대로 통과시킨다.
 */
export function buildDiagnosticEvidenceBundle(input: DiagnosticEvidenceBundleInput): DiagnosticEvidenceBundle {
  return { ...input };
}
