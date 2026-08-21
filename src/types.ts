export interface ClaudeResult {
  success: boolean;
  summary: string;
  changedFiles: string[];
  tests: { name: string; pass: boolean }[];
  rawOutput: string;
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
  | "GPT_REVIEW_TEMPORARILY_UNAVAILABLE";

export type OrchestratorStatus =
  | "IDLE"
  | "CLAUDE_WORKING"
  | "WAITING_GPT_REVIEW"
  | "REVISION_REQUIRED"
  | "WAITING_HUMAN"
  | "WAITING_CLAUDE_LIMIT"
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
}

/**
 * 프로젝트별 확장 상태를 CoreState에 합친 전체 project-state 타입. TProjectData를 지정하지
 * 않으면 Record<string, unknown>이 기본값이라 어떤 프로젝트 전용 필드든(이름을 모르는 것도
 * 포함) 그대로 통과한다 — 지금까지 코드 전체가 이렇게 bare `ProjectState`로 써왔고, 이번
 * Task도 그 동작을 바꾸지 않는다.
 */
export type ProjectState<TProjectData = Record<string, unknown>> = CoreState & TProjectData;
