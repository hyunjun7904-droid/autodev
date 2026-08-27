export interface ClaudeResult {
  success: boolean;
  summary: string;
  changedFiles: string[];
  tests: {
    name: string;
    pass: boolean;
    /**
     * AutoDev / JARVIS Unattended Continuous Development Reliability Hardening Phase 5 —
     * 실패한 required test가 실제로 실행됐고 evidence가 있을 때만 채운다(성공한 테스트나
     * "명령 자체를 실행하지 못함" 같은 경우는 생략 — 추측성 값을 만들지 않는다). exitCode/
     * stderr·stdout 꼬리(마지막 부분 — assertion/error가 보통 끝에 있다)는 이미
     * safe-executor.ts가 sanitizeForLog로 secret을 redact하고 20,000자로 자른 값을 다시
     * bounded 크기로만 보존한다. "pass=false"만 남기고 원인을 버리지 않기 위한 필드다.
     */
    failureEvidence?: {
      command: string;
      exitCode?: number | null;
      stderrTail?: string;
      stdoutTail?: string;
    };
  }[];
  /**
   * AutoDev / JARVIS Unattended Continuous Development Reliability Hardening Phase 8 —
   * Developer가 이번 attempt에서 만든 required test 대상 파일에 대해 "이 npm script로
   * 등록해달라"고 선언하는 요청 목록(§ required-test-preflight.ts
   * validateRequiredTestRegistrationRequest). Developer는 package.json을 직접 수정할 권한이
   * 없다 — 이 필드는 등록 "요청" 정보일 뿐이며, 실제 package.json mutation은 AutoDev
   * infrastructure(claude-developer.ts TASK_COMPLETE 처리)가 엄격한 보안 검증을 통과한
   * 요청에 대해서만 수행한다. Developer가 이 필드를 채우지 않아도(undefined) 기존 glob 기반
   * 자동 복구(attemptSafeRequiredTestScriptRepair)가 그대로 동작한다 — 이 필드는 그 보완
   * 채널이다.
   */
  requiredTestRegistrations?: {
    scriptName: string;
    runner: string;
    target: string;
  }[];
  rawOutput: string;
  /** Phase G Task G3.1 — 실제 Claude CLI JSON 출력(§ claude-runner.ts parseClaudeJsonOutput)이
   *  제공한 경우만 채운다. 제공하지 않으면 undefined(추정하지 않음). */
  model?: { provider: string; name: string };
  tokenUsage?: { inputTokens?: number; outputTokens?: number };
  durationMs?: number;
}

export type GptDecision = "PASS" | "REVISE" | "HUMAN_REQUIRED" | "BLOCK";
export type Severity = "critical" | "high" | "medium";

export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
}

export interface GptReviewResult {
  decision: GptDecision;
  severity: SeverityCounts;
  feedback: string;
  nextTask: string | null;
}

export type GptErrorCode =
  | "AUTH_ERROR"
  | "RATE_LIMIT"
  | "QUOTA_EXCEEDED"
  | "TIMEOUT"
  | "INVALID_OUTPUT"
  | "API_ERROR"
  | "GPT_REVIEW_TEMPORARILY_UNAVAILABLE"
  // SI-3.8A — GPT Reviewer API Budget Guard(gpt-budget-guard.ts)가 실제 OpenAI API 호출
  // 직전에 payload/추정 토큰 상한 초과를 감지해 호출 자체를 막았을 때만 쓰인다. 재시도로
  // 해결되지 않으므로 항상 transient=false다.
  | "BUDGET_EXCEEDED"
  // SI-3.8D — Incremental GPT Reviewer의 Final Consistency Cross-check(review-baseline.ts)가
  // "이번 round의 payload를 만든 시점"과 "OpenAI로부터 decision을 받은 시점" 사이에 working
  // tree 내용이 실제로 달라졌음을 감지했을 때만 쓰인다. decision=PASS를 그대로 신뢰하지 않고
  // HUMAN_REQUIRED로 강제 전환한다 — 재시도로 해결되지 않으므로 항상 transient=false다.
  | "REVIEW_CONSISTENCY_CHECK_FAILED"
  // SI-3.8E Security Ordering Correction — Provider Security Gate(provider-security-gate.ts,
  // gpt-reviewer.ts가 Budget Guard 통과 이후·provider.review() 호출 이전에 항상 실행)가
  // 이번 요청의 데이터 등급/provider 조합을 BLOCK으로 판정했을 때만 쓰인다. provider.review()가
  // 호출되기 전에 결정되므로 실제 API 오류(API_ERROR 등)로 오분류되지 않으며, Budget Guard의
  // BUDGET_EXCEEDED와도 구분된다(둘 다 provider 호출 0회를 보장하지만 사유가 다르다). 재시도로
  // 해결되지 않으므로 항상 transient=false다.
  | "PROVIDER_SECURITY_BLOCKED"
  // Final Reviewer Routing(Fireworks Primary / Groq Escalation) — escalation이 필요하다고
  // 판정됐지만(§ final-reviewer-routing.ts) escalation reviewer(Groq) 호출이 transient하게
  // 실패했을 때(rate limit/quota/timeout/일시적 provider 장애 — errorCode 자체는 RATE_LIMIT/
  // TIMEOUT/API_ERROR 중 하나였고 transient===true였음)만 쓰인다. Core의 5회 자동 재시도 루프에
  // 맡기지 않고 즉시(transient=false) HUMAN_REQUIRED로 수렴시켜, "escalation이 필요한데
  // 사용할 수 없다"는 사실을 재시도에 묻히지 않고 즉시 드러낸다(자동 승인 금지 — HOLD와
  // 동일한 의미). AUTH_ERROR(예: GROQ_API_KEY 누락)처럼 AutoDev 자체의 설정 오류인 경우는 이
  // 코드로 재분류하지 않고 원래 errorCode를 그대로 노출한다(§ 요구사항 "missing required API
  // key를 fallback으로 숨기지 않는다").
  | "ESCALATION_REVIEWER_UNAVAILABLE";

// SI-3.8A — GPT Reviewer API Budget Guard가 OpenAI API 호출을 막았을 때 별도의
// "WAITING_API_BUDGET" enum 값을 추가하는 대신 기존 WAITING_HUMAN을 그대로 재사용하기로
// 했다: "WAITING_HUMAN" 문자열은 이 파일뿐 아니라 run.ts(Telegram controller를 유지한 채
// 대기할지 판단), autodev.ts(decideNextAction의 "이미 WAITING_HUMAN이면 자동 재실행하지
// 않음" 게이트), dashboard-html.ts/live-snapshot.ts(사람 승인 필요 UI 신호)까지 exact-match
// 문자열 비교로 광범위하게 이미 소비되고 있다 — 새 상태값을 추가하면 이 소비처들이 전부
// "WAITING_API_BUDGET"을 인식하지 못해 자동 재실행/조기 종료/UI 미표시 같은 실제 회귀가
// 생긴다(SI-3.8A 리뷰에서 run.ts의 waitWhileWaitingHuman()이 실제로 이렇게 깨지는 것을
// 확인함). Task 지시("Core-wide 예상 외 변경이 필요하면 임의로 확대하지 말고 STOP 후
// 보고")에 따라 이 Task 범위에서 그 소비처들을 전부 고치는 대신, AUTH_ERROR/QUOTA_EXCEEDED/
// GPT_REVIEW_TEMPORARILY_UNAVAILABLE이 이미 쓰는 것과 동일한 패턴(기존 WAITING_HUMAN +
// deferredHumanTasks의 "BUDGET_EXCEEDED: ..." 항목 + lastGptDecision.errorCode로 구체적
// 사유 구분)을 그대로 따른다.
export type OrchestratorStatus =
  | "IDLE"
  | "CLAUDE_WORKING"
  | "WAITING_GPT_REVIEW"
  | "REVISION_REQUIRED"
  | "WAITING_HUMAN"
  | "WAITING_CLAUDE_LIMIT"
  | "WAITING_PROVIDER_RETRY"
  | "APPROVED"
  | "BLOCKED";

// 항상 사람 승인이 필요한 고위험 작업.
export type HighRiskAction =
  | "production_db_change"
  | "production_data_delete"
  | "modify_applied_migration"
  | "production_deploy"
  | "production_secret_change"
  | "microsoft_connect"
  | "paid_external_action";

// 향후 DEV 환경에서 자동 허용 가능하도록 타입만 미리 열어둔다 — 이번 단계는 실행 로직 없음.
export type DevAutoAction =
  | "dev_migration_create"
  | "dev_migration_execute"
  | "dev_test_data_create"
  | "dev_test_data_delete"
  | "phase_progression";

export type ActionType = HighRiskAction | DevAutoAction;

// Minimal HUMAN_FINAL_REVIEW Runtime Checkpoint Gate — Reviewer가 PASS(APPROVED)했더라도
// 사람이 명시적으로 APPROVE하기 전까지는 checkpoint(git commit)를 진행하지 않는다(§
// autodev.ts decideNextAction/approveHumanFinalReview). 정확히 하나의 대기 중인 gate만
// 표현한다 — 동시에 여러 task가 이 gate를 거칠 수 없다(Project Lock이 이미 동일 project에
// 대한 동시 writer를 막는다). taskId+reviewCycle 조합이 "이 승인이 정확히 어떤 reviewer
// 승인 결과에 결합되는지"를 표현하는 최소 identity다 — 새로운 토큰 체계를 추가하지 않고
// 기존 task-registry.ts TaskDefinition.id/orchestrator reviewCycle을 그대로 재사용한다.
export interface HumanFinalReviewGate {
  /** task-registry.ts TaskDefinition.id — 이 승인이 어떤 task에 결합되는지(stale approval이
   *  다른 task에서 재사용되는 것을 막는다). */
  taskId: string;
  /** 이 gate를 만든 시점의 CoreState.reviewCycle(= reviewer가 APPROVED한 시점) — task/
   *  reviewCycle 둘 다 정확히 일치해야 유효한 승인으로 취급한다. */
  reviewCycle: number;
  status: "PENDING" | "APPROVED" | "REJECTED";
  requestedAt: string;
  approvedAt?: string;
  rejectedAt?: string;
}

// AutoDev 범용화 Phase A Task A5 — Core 상태와 프로젝트 전용 상태 분리.
//
// 지금까지 ProjectState 하나에 AutoDev Core가 실제로 읽고/쓰는 필드(currentTask,
// completedTasks, status, reviewCycle, lastGptDecision, claudeLimitWaitCount,
// deferredHumanTasks, gitCheckpoint, currentPhase)와, MOVAN project-state.json에만 있고
// orchestrator.ts/checkpoint.ts/task-registry.ts/autodev.ts의 판단 로직 어디서도 읽지 않는
// MOVAN 전용 bookkeeping 필드(project, phase10Allowed, migrationsApplied, ... — 실제 사용처를
// 추적해 확인함, project-manifests/movan.ts의 MovanProjectExtension 참고)가 함께 섞여 있었다.
//
// CoreState는 AutoDev Core가 실제로 의존하는 최소 공통 상태만 담는다 — MOVAN이든 향후
// BILLION이든 이 필드들의 의미를 그대로 공유한다. ProjectState<TProjectData>는 여기에
// 프로젝트별 확장 데이터(TProjectData)를 합친 것이다 — 기본값(Record<string, unknown>)은
// "어떤 프로젝트 전용 필드가 와도(이름을 몰라도) 그대로 보존한다"는 뜻이며, 지금까지처럼
// bare `ProjectState`로 쓰면 기존 코드/기존 project-state.json 구조/기존 동작이 100% 그대로
// 유지된다(실제 JSON 파일 구조는 이번 Task에서 바꾸지 않는다 — TypeScript 타입/접근 경계만
// 분리). 프로젝트별 필드를 구체적인 타입으로 다루고 싶을 때는(예: MOVAN)
// `ProjectState<MovanProjectExtension>` 처럼 명시적으로 타입 인자를 준다
// (project-manifests/movan.ts의 MovanProjectState).
export interface CoreState {
  currentTask: string | null;
  reviewCycle: number;
  lastClaudeResult: ClaudeResult | null;
  lastGptDecision: GptReviewResult | null;
  /**
   * 이 필드는 두 종류의 값을 함께 담는다(기존 project-state.json이 이미 그렇게 써왔다 —
   * 예: "READY_FOR_PHASE13"은 OrchestratorStatus enum에 없는 AutoDev 레벨 plan marker):
   *   1) OrchestratorStatus enum 값 — runOrchestrator()가 실행 중일 때만 이 필드를 그
   *      상태 머신 값으로 덮어쓴다(IDLE/CLAUDE_WORKING/.../APPROVED/WAITING_HUMAN 등).
   *   2) task-registry.ts의 AutoDev 레벨 plan marker 문자열(PlanMarker) — orchestrator가
   *      실행 중이 아닐 때(다음 task 선택 대기 등) autodev.ts가 기록한다.
   * loadState()/saveState()는 이 필드의 런타임 값을 검증하지 않는다(기존 관행 유지) —
   * 두 계층(orchestrator 내부 상태 vs AutoDev 레벨 진행 상태) 모두 이 하나의 필드를
   * 공유하는 것은 설계상 의도된 것이며, 새 필드를 추가해 이원화하지 않는다.
   */
  status: OrchestratorStatus | string;

  /** Claude 사용량 제한(USAGE_LIMIT) 대기 횟수 — 재시작 후에도 이어가기 위해 저장. */
  claudeLimitWaitCount: number;

  /**
   * AutoDev / JARVIS 신뢰성 보완 — Claude Developer Timeout Durable Retry. Developer가
   * 일시적 오류(TIMEOUT/CLI_NOT_FOUND)로 attempt 내 재시도까지 소진했을 때(§
   * claude-developer.ts DEVELOPER_TRANSIENT_RETRY_EXHAUSTED_PREFIX), claudeLimitWaitCount와
   * 완전히 동일한 방식으로 이 값을 늘리며 durable하게 대기 후 같은 task를 재시도한다(§
   * orchestrator.ts WAITING_PROVIDER_RETRY). MAX_DEVELOPER_PROVIDER_WAITS를 넘으면 그때만
   * genuine WAITING_HUMAN으로 넘어간다 — Task 위험도(예: security-critical)와 실패 원인
   * 위험도(provider timeout)를 분리한다: provider가 일시적으로 응답하지 못했다는 사실 자체는
   * 사람 판단이 필요한 사유가 아니다 — 이 값은 상한이 없다(재시도 횟수 자체를 bounded로
   * 제한해 결국 사람에게 넘기지 않는다, § 2026-08-28 정책 수정). 같은 task를 이어가는 동안만
   * 누적되고(프로세스가 죽었다 재시작돼도 durable하게 보존됨), 다른 task로 전환되면
   * 리셋된다(§ orchestrator.ts resumingSameTask). optional인 이유는 humanFinalReview와
   * 동일하다 — 지정하지 않으면(undefined) 기존 project-state.json 파일과 100% 하위
   * 호환된다.
   */
  developerProviderWaitCount?: number;

  /**
   * 위 developerProviderWaitCount와 짝을 이루는 durable timestamp(ISO 8601) — 다음 재시도가
   * 예정된 시각. orchestrator.ts가 durable wait을 시작하기 "전에"(sleep 전에) 저장해, 그
   * 대기 도중 프로세스가 죽어도 재시작 후 남은 시간만큼만 마저 기다리고 재시도한다(전체
   * 간격을 처음부터 다시 기다리지 않는다 — § 요구사항 "nextRetryAt 저장/복원"). 대기가 실제로
   * 끝나면(같은 프로세스 안에서 살아남았든, 재시작 후 남은 시간을 마저 기다렸든) null로
   * 되돌린다 — 남아있는 값이 있으면 그 자체가 "아직 대기가 끝나지 않았다"는 뜻이다.
   */
  developerProviderNextRetryAt?: string | null;

  /**
   * developerProviderWaitCount와 동일한 설계지만 GPT Reviewer 자신의 provider 일시적
   * 장애(gpt-reviewer.ts reviewClaudeResultWithRetry가 MAX_ATTEMPTS까지 소진했을 때
   * errorCode==="GPT_REVIEW_TEMPORARILY_UNAVAILABLE")를 위한 것이다 — 같은 diff로
   * 재리뷰만 반복하고(Developer는 다시 호출하지 않음), 아무리 반복돼도 genuine
   * WAITING_HUMAN으로 승격하지 않는다. 다른(새) task로 전환될 때만 리셋된다.
   */
  reviewerProviderWaitCount?: number;

  /**
   * 위 reviewerProviderWaitCount와 짝을 이루는 durable timestamp — 다만 developerProviderNextRetryAt
   * 과 달리 프로세스 재시작 시 "남은 시간만 대기"하는 로직에는 쓰이지 않는다(claudeResult
   * 자체가 재시작에도 살아남지 않으므로 재시작하면 Developer 호출부터 다시 해야 한다 — §
   * orchestrator.ts 주석). 관측(대시보드/로그)용으로만 저장된다.
   */
  reviewerProviderNextRetryAt?: string | null;

  /** 사람 검토가 필요해 뒤로 미뤄진 항목(반복 거부된 action, GPT 일시 장애 등). */
  deferredHumanTasks: string[];

  /**
   * task-registry.ts TaskDefinition.id(예: "13.1") 목록 — 이미 GPT 승인 + checkpoint까지
   * 끝난 task만 여기 들어간다. getNextTask()가 이 목록을 보고 다음 미완료 task를 고른다.
   */
  completedTasks: string[];

  /** 마지막 성공 checkpoint(performTaskCheckpoint)의 git commit hash — autodev.ts가 프로젝트에
   *  상관없이 checkpoint 직후 동일한 방식으로 갱신한다(§ 요구사항: 실제 사용처 기준 분류). */
  gitCheckpoint: string;

  /** 마지막으로 진행된 task-registry.ts TaskDefinition.phase — autodev.ts가 checkpoint 직후
   *  taskDef.phase로 그대로 갱신한다(어느 프로젝트의 taskRegistry든 동일). 이 값의 의미
   *  자체(Phase 번호 체계)는 프로젝트가 정하지만, 갱신 코드는 Core에 있다. */
  currentPhase: number;

  /** Minimal HUMAN_FINAL_REVIEW Runtime Checkpoint Gate — reviewer가 APPROVED한 뒤
   *  checkpoint 전 사람의 최종 승인을 기다리는 동안(status="WAITING_HUMAN")에만 채워진다.
   *  checkpoint 성공 후에는 null로 되돌린다(§ autodev.ts). 지정하지 않으면(undefined) 이
   *  gate가 전혀 없다는 뜻 — 기존 project-state.json 파일과 100% 하위 호환된다. */
  humanFinalReview?: HumanFinalReviewGate | null;

  /**
   * AutoDev / JARVIS 최종 무인개발 구조 보완 — Durable Failure/Recovery State(§
   * durable-recovery-state.ts). orchestrator.ts의 gptCallCount/stagnationTracker와 달리
   * 이 값은 loop-local이 아니라 project-state.json에 그대로 저장되는 durable 값이다 —
   * AutoDev 프로세스가 재시작돼도(수동 종료/timeout/kill 어떤 이유든) 동일 task에 대한
   * failure fingerprint/Fireworks 호출 횟수/RCA 횟수/provider timeout 횟수/예상치 못한
   * 프로세스 종료 횟수가 0으로 초기화되지 않게 한다. taskId가 현재 진행 중인 task와
   * 다르면(새 task로 전환) 이 필드는 안전하게 리셋된다(§ loadDurableFailureStateForTask) —
   * 다른 task로 이 상태가 새어나가지 않는다. 지정하지 않으면(undefined) 기존
   * project-state.json 파일과 100% 하위 호환된다.
   */
  technicalRecoveryState?: DurableFailureState | null;
}

/** § durable-recovery-state.ts에도 재수출되는 것과 동일한 타입 — CoreState가 이 타입을
 *  참조해야 하므로 여기(types.ts)에 원본을 둔다(순환 import 방지). */
export interface DurableFailureState {
  taskId: string;
  failureFingerprint?: string;
  /** 동일 fingerprint가 연속으로 REVISE 판정을 받은 횟수(= 그 fingerprint에 대해 실제로
   *  소비된 Fireworks 호출 횟수와 동일 — § root-cause-analysis.ts 설계). */
  sameFailureCount: number;
  rootCauseAnalysisCount: number;
  providerTimeoutCount: number;
  /** 이 task가 완료되지 않은 채(비정상 종료) 새 프로세스가 다시 이 task를 발견한 횟수. */
  unexpectedExitCount: number;
  lastRecoveryAction?: string;
  /** RCA가 현재 pending 상태(로컬 재검증을 아직 통과하지 못해 다음 Fireworks 호출이 차단된
   *  상태)인지 — 이 값과 pendingSnapshotKey가 함께 있어야 프로세스 재시작 후에도
   *  "세 번째 호출 차단" 상태를 정확히 복원할 수 있다(§ root-cause-analysis.ts). */
  pendingRootCauseCategory?: string;
  pendingSnapshotKey?: string;
  updatedAt: string;
}

/**
 * 프로젝트별 확장 상태를 CoreState에 합친 전체 project-state 타입. TProjectData를 지정하지
 * 않으면 Record<string, unknown>이 기본값이라 어떤 프로젝트 전용 필드든(이름을 모르는 것도
 * 포함) 그대로 통과한다 — 지금까지 코드 전체가 이렇게 bare `ProjectState`로 써왔고, 이번
 * Task도 그 동작을 바꾸지 않는다.
 */
export type ProjectState<TProjectData = Record<string, unknown>> = CoreState & TProjectData;
