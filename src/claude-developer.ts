import { createHash } from "node:crypto";
import { resolveTrustedClaudeCommand, classifySubprocessOutcome } from "./claude-runner";
import type { ClaudeErrorCode } from "./claude-runner";
import { runSubprocessWithTimeout } from "./subprocess-runner";
import { validateAndExecute, PROJECT_ROOT } from "./safe-executor";
import type { ExecutorAction, SafeExecutorContext } from "./safe-executor";
import { getWorkingTreeChanges } from "./git-changes";
import type { RequiredTestCommand } from "./task-registry";
import { log, sanitizeForLog } from "./logger";
import {
  checkRequiredTestScriptRegistration,
  attemptSafeRequiredTestScriptRepair,
  commitRequiredTestScriptRepair,
  readPackageJsonScripts,
  registerValidatedRequiredTestScripts,
  commitRequiredTestRegistration,
  extractNpmRunScript,
} from "./required-test-preflight";
import type { RequiredTestRegistrationRequest } from "./required-test-preflight";

// Claude Developer — built-in Read/Edit/Write/Bash를 전혀 주지 않는다(항상 --tools "").
// 대신 Claude는 JSON ACTION_REQUEST로 무엇을 읽고/검색하고/수정하고 싶은지 "요청"만 하고,
// 실제 실행은 Node의 Safe Executor(safe-executor.ts)가 검증 후 수행한다. 하드 보안 경계는
// 전부 Safe Executor 코드에 있고, 이 파일이나 시스템 프롬프트의 지시는 신뢰 경계가 아니다.
//
// AutoDev 범용화 Phase A Task A6 — 이 파일(Core)은 이제 어떤 프로젝트를 개발하고 있는지
// 전혀 모른다. "MOVAN ERP 개발자"라고 가정하지 않고, 프로젝트 이름/허용 범위 설명/금지
// 사항 같은 실제 내용은 전부 호출부(autodev.ts)가 ProjectManifest로부터 조립해 주입하는
// DeveloperProjectContext를 통해서만 얻는다(§ DEFAULT_PROJECT_CONTEXT는 어떤 프로젝트도
// 가리키지 않는 범용 기본값이다). 실제 MOVAN 운용에서는 autodev.ts가 항상 명시적으로
// MOVAN_PROJECT_MANIFEST 기반 context를 넘기므로 기존 동작은 그대로 보존된다.

/** Claude Developer system prompt에 삽입되는 프로젝트별 맥락 — Core는 이 값의 의미를
 *  모른다(호출부가 ProjectManifest로부터 조립해 주입한다). */
export interface DeveloperProjectContext {
  /** system prompt 도입부("당신은 {projectName}의 자동 개발자입니다")에 삽입된다. */
  projectName: string;
  /** 허용 read/write 범위, 금지 사항, 프로젝트 맥락 등 — system prompt에 그대로 삽입된다. */
  instructions: string;
}

// Core 기본값 — 명시적으로 project context가 주입되지 않았을 때만 쓰인다(예: 이 함수를
// manifest 배선 없이 직접 부르는 경우). 특정 프로젝트를 가리키지 않는다 — 실제 프로젝트별
// 내용은 항상 호출부가 명시적으로 주입해야 한다(§ 요구사항: silent fallback으로 특정
// 프로젝트 규칙을 흉내내지 않는다).
const DEFAULT_PROJECT_CONTEXT: DeveloperProjectContext = {
  projectName: "AutoDev가 관리하는 프로젝트",
  instructions:
    "이 프로젝트에 대한 별도 규칙이 지정되지 않았습니다. 허용된 read/write 범위와 금지 " +
    "사항은 Safe Executor가 실제로 강제합니다 — 요청이 거부되면 denyReason을 참고해 " +
    "허용된 범위 안에서만 작업하세요.",
};

// 존재할 수 없는 경로 — changeScopeDirs가 지정되지 않았을 때 "아무것도 스캔하지 않음"을
// 보장한다(gpt-reviewer.ts의 NO_SCOPE_CONFIGURED와 동일한 이유: 빈 배열을 그대로 pathspec으로
// 넘기면 "제한 없음"이 되어 repository 전체를 스캔하게 된다).
const NO_SCOPE_CONFIGURED = ["__autodev_no_project_scope_configured__/"];

export type DeveloperErrorCode = ClaudeErrorCode | "TASK_ACTION_LIMIT" | "PROTOCOL_ERROR" | "NO_PROGRESS_STAGNATION";

// AutoDev 신뢰성 수정(2026-08-26, "JARVIS 재개 전 확인된 신뢰성 gap #2") — Claude CLI
// TIMEOUT/일시적 프로세스 가용성 실패 하나만으로 즉시 WAITING_HUMAN으로 전환하지 않는다.
// USAGE_LIMIT은 이미 runDeveloperTaskViaSafeExecutor 내부에서 자체적으로 훨씬 큰 예산
// (DEVELOPER_USAGE_LIMIT_MAX_RETRIES=12회, 매회 30분 대기)으로 재시도하므로 여기서 다시
// 재시도하지 않는다(중복 대기 방지) — orchestrator.ts의 isUsageLimitResult() 분기가 그
// 결과를 이미 별도로 처리한다. AUTH_REQUIRED(사람 로그인 필요)/NON_ZERO_EXIT(실제 exit
// code 실패 — 결정적 오류로 취급)/INVALID_OUTPUT(파싱 불가능한 응답)/
// TRUSTED_EXECUTABLE_NOT_FOUND·EXECUTABLE_IDENTITY_UNTRUSTED·EXECUTABLE_SHADOWING_DETECTED
// (실행 파일 신뢰 검증 실패 — 보안 성격, 무작정 재시도하면 안 됨)/TASK_ACTION_LIMIT·
// PROTOCOL_ERROR·NO_PROGRESS_STAGNATION(Claude 자신의 결정적 동작 문제, 재시도해도 같은
// 결과가 반복될 가능성이 높음)는 재시도 대상이 아니다 — 즉시 WAITING_HUMAN으로 넘어간다.
export const DEVELOPER_TRANSIENT_ERROR_CODES: ReadonlySet<DeveloperErrorCode> = new Set<DeveloperErrorCode>([
  "TIMEOUT",
  "CLI_NOT_FOUND",
]);

export function isTransientDeveloperFailure(result: Pick<DeveloperResult, "success" | "errorCode">): boolean {
  return !result.success && result.errorCode !== undefined && DEVELOPER_TRANSIENT_ERROR_CODES.has(result.errorCode);
}

/** AutoDev 신뢰성 보완(2026-08-27, "호출 효율 지표") — Section 16 요구사항("전체 Claude
 *  호출 횟수/유효 응답 횟수/응답 형식 실패 횟수/로컬 복구 성공 횟수")을 위한 최소 요약값.
 *  validResponseRounds + protocolFailureRounds(로컬 복구로 유효해진 라운드는
 *  validResponseRounds에만 센다 — 중복 집계 없음)가 항상 totalRounds 이하다. */
export interface DeveloperCallStats {
  totalRounds: number;
  validResponseRounds: number;
  localRecoverySuccessRounds: number;
  protocolFailureRounds: number;
}

/** AutoDev Core Maintenance — Greenfield/Timeout Discovery Progress Persistence(2026-08-31,
 *  JARVIS Task 5.3 실측: 같은 task가 TIMEOUT으로 반복될 때마다 --no-session-persistence
 *  정책 때문에 discovery(READ_FILES/SEARCH)를 매번 완전히 처음부터 반복한 production
 *  defect). 이 attempt 안에서 실제로 읽은 파일의 "경로"만 담는다(내용은 포함하지 않는다 —
 *  compact progress일 뿐 raw transcript 재주입이 아니다, § 요구사항 5) + discovery budget
 *  소진 여부. */
export interface DeveloperDiscoveryProgress {
  /** § 위 주석 — 경로만, 내용 없음. */
  filesRead: string[];
  discoveryOnlyRoundCount: number;
  /** true면 이 attempt가 끝난 시점에 이미 DISCOVERY_BUDGET_ROUNDS를 소진해 구현 전환
   *  상태였다. */
  implementationLocked: boolean;
  lastRoundReached: number;
}

/** AutoDev Core Maintenance — Progress Transfer Gap 재하드닝(2026-08-31, JARVIS Task 5.3
 *  실측: 같은 durable attempt 안의 3회 내부 transient retry가 모두 discovery를 처음부터
 *  반복한 확정 원인). discoveryProgress를 사람이 읽는 안내 문구로 바꾸는 유일한 변환
 *  지점이다 — durable retry 간(autodev.ts, cross-process/cross-durable-wait)과 내부
 *  transient retry 간(이 파일 runDeveloperTaskWithRetry, 같은 durable attempt 안의 최대
 *  3회 재시도) 둘 다 이 함수 하나만 재사용한다(텍스트를 두 곳에 복제하지 않는다).
 *  filesRead가 비어있고 아직 잠기지도 않았으면 전달할 내용이 없으므로 undefined를
 *  반환한다(기존과 동일하게 힌트를 추가하지 않는다). */
export function buildDiscoveryProgressRetryHint(
  discoveryProgress: DeveloperDiscoveryProgress,
  errorCode: string | undefined
): string | undefined {
  if (discoveryProgress.filesRead.length === 0 && !discoveryProgress.implementationLocked) return undefined;
  return (
    `# AutoDev 안내(직전 시도 — discovery 이미 진행됨)\n` +
    `직전 시도는 실패(${errorCode ?? "알 수 없는 오류"})로 끝났지만, 그 전에 이미 다음 파일을 확인했습니다:\n` +
    discoveryProgress.filesRead.map((f) => `- ${f}`).join("\n") +
    (discoveryProgress.implementationLocked
      ? "\n\ndiscovery 예산이 이미 소진된 상태였습니다 — 다시 조사부터 반복하지 말고 곧바로 구현(WRITE_FILE/APPLY_PATCH)을 시작하세요. 위 파일 내용을 다시 확인해야 한다면 최소한만 다시 읽으세요."
      : "\n\n이미 확인한 내용을 바탕으로 불필요한 재조사를 최소화하고 남은 구현으로 빠르게 진행하세요.")
  );
}

// AutoDev Core Maintenance — TIMEOUT-only/WRITE-zero 전략 사각지대 재하드닝(2026-08-31,
// JARVIS Task 5.3 실측 — 3회 연속 TIMEOUT 모두 changedFiles:[] 였는데도 기존
// problem-memory/failure-stagnation(buildEscalationGuidance)은 required-test fingerprint
// (tests[])에만 반응해 전혀 관여하지 않았음이 포렌식으로 확정됨). 이 함수는 그 required
// test 이전 단계 전용 최소 escalation 문구를 만든다 — buildEscalationGuidance()와 동일한
// "반복할수록 문구가 강해진다"는 원칙을 재사용하되, 판단 기준은 required test fingerprint가
// 아니라 "WRITE 없이 연속 실패한 횟수"(consecutiveNoWriteFailures) 하나뿐이다(새로운 scoring
// subsystem 없음). 1회는 정상적인 초기 discovery로 보고 안내하지 않는다.
export function buildNoWriteStrategyEscalationHint(consecutiveNoWriteFailures: number): string | undefined {
  if (consecutiveNoWriteFailures < 2) return undefined;
  if (consecutiveNoWriteFailures === 2) {
    return (
      "# AutoDev 안내(WRITE 없이 2회 연속 실패 — 전략 전환)\n" +
      "이 task는 지난 2번의 시도 모두 실제 코드 변경(WRITE_FILE/APPLY_PATCH) 없이 끝났습니다. " +
      "같은 범위를 넓게 다시 탐색하지 마세요 — 지금까지 확인한 정보만으로 바로 구현을 시작하거나, " +
      "정말 필요한 파일 한두 개만 targeted로 확인한 뒤 곧바로 WRITE_FILE/APPLY_PATCH로 진행하세요."
    );
  }
  return (
    `# AutoDev 안내(WRITE 없이 ${consecutiveNoWriteFailures}회 연속 실패 — 동일 전략 반복 금지)\n` +
    `이 task는 WRITE 없이 ${consecutiveNoWriteFailures}회 연속 실패했습니다. 넓은 범위의 discovery를 ` +
    "다시 반복하지 마세요. 이미 확인한 내용만으로 지금 바로 구현을 시작하고, 정말 필요한 경우에만 " +
    "구체적인 파일 하나를 targeted로 확인하세요."
  );
}

export interface DeveloperResult {
  success: boolean;
  summary: string;
  changedFiles: string[];
  tests: {
    name: string;
    pass: boolean;
    /** Phase 5 — 실패한 required test의 실제 근거(command/exitCode/stdout·stderr 꼬리).
     *  § types.ts ClaudeResult.tests의 동일 필드와 구조를 맞춘다. */
    failureEvidence?: { command: string; exitCode?: number | null; stderrTail?: string; stdoutTail?: string };
    /** AutoDev Core Maintenance(2026-08-30) — § types.ts ClaudeResult.tests.denyReason과 동일한
     *  필드/원칙(failureEvidence와 별개 — classifyFailureCategory의 기존 판정을 깨지 않는다). */
    denyReason?: string;
  }[];
  rawOutput: string;
  errorCode?: DeveloperErrorCode;
  deferredHumanTasks?: string[];
  /** errorCode==="PROTOCOL_ERROR"일 때만 채워진다 — computeProtocolFailureFingerprint()의
   *  결과를 그대로 노출해, 호출부(autodev.ts)가 problem-memory.ts에 이 정확한 실패 패턴을
   *  기록/재사용할 수 있게 한다(원문 응답 내용은 포함하지 않는다). */
  protocolFailureFingerprint?: string;
  /** AutoDev 신뢰성 보완(2026-08-27, "호출 효율 지표") — 이 attempt(1회의
   *  runDeveloperTaskViaSafeExecutor 호출) 안에서 실제로 성공한 모든 내부 round(claude CLI
   *  호출) 하나하나가 어떤 결과였는지 요약한다. USAGE_LIMIT 재시도(같은 round를 다시
   *  요청)는 세지 않는다 — 이 값은 "응답 형식 낭비"만 관측하기 위한 지표다. */
  callStats?: DeveloperCallStats;
  /** Phase G Task G3.1 — 이 developer attempt(1회의 runDeveloperTaskViaSafeExecutor 호출)
   *  안에서 실제로 성공한 모든 내부 round(claude CLI 호출)의 tokenUsage를 합산하고, model은
   *  가장 최근 round에서 관측된 값을 담는다(같은 세션이라 round마다 달라지지 않는다). CLI가
   *  값을 전혀 주지 않았으면(또는 실제 호출이 한 번도 성공하지 않았으면) undefined. */
  model?: { provider: string; name: string };
  tokenUsage?: { inputTokens?: number; outputTokens?: number };
  /** § DeveloperDiscoveryProgress 주석 — 이 attempt가 (주로 실패로) 끝난 시점에 마지막으로
   *  확인된 discovery 진행 상태. Reviewer는 이 값을 보지 않는다 — 오직 같은 task의 다음
   *  developer retry가 opts.priorDiscoveryProgress로만 소비한다. */
  discoveryProgress?: DeveloperDiscoveryProgress;
  /** AutoDev Core Maintenance — NO-WRITE Stagnation / Strategy Repeat 재하드닝(2026-08-31,
   *  JARVIS Task 5.3 실측). runDeveloperTaskWithRetry()가 내부 transient retry(최대 3회)
   *  전체에 걸쳐 이어받아 갱신한 "WRITE 없이 연속 실패한 횟수"(§
   *  opts.priorNoWriteRepeatCount에서 시작) — 3회 모두 소진되어 durable wait로 넘어갈 때만
   *  채워진다. autodev.ts가 이 값을 그대로 project-state.json(technicalRecoveryState.
   *  noWriteRepeatCount)에 이어 저장해, 다음 durable retry가 0부터 다시 세지 않게 한다. */
  noWriteRepeatCount?: number;
}

export interface DeveloperTaskOptions {
  timeoutPerRoundMs?: number;
  /** 테스트 전용 override — 기본은 항상 실제 claude CLI 호출(callClaude). 운용 코드는 절대 바꾸지 않는다. */
  claudeCaller?: (input: string, timeoutMs: number) => ReturnType<typeof callClaude>;
  /**
   * TASK_COMPLETE 이후 AutoDev가 Safe Executor로 직접 실행해 실제 exitCode로 검증하는
   * 필수 테스트(task-registry.ts). Claude의 자체 보고(summary/testsRequested 문자열)는
   * 신뢰하지 않는다 — 여기 설정된 명령만 진짜로 실행되고, 그 결과만 DeveloperResult.tests에
   * 담긴다(§ 요구사항 6). 비어 있으면 tests는 빈 배열로 반환된다(기존 동작과 동일).
   */
  requiredTests?: RequiredTestCommand[];
  /**
   * task-registry.ts TaskDefinition.allowedPathPrefixes — 지정하면 이 함수 시작 시 그 범위
   * 안에 이미 존재하는 uncommitted 변경을 감지해 "버리지 말고 이어서 진행하라"는 안내를
   * 초기 transcript에 포함시킨다(§ 이전 시도가 USAGE_LIMIT 재시도 예산을 다 써서 새
   * 프로세스로 재시작해야 하는 최후의 경우에도 이미 써둔 코드를 Claude가 인지하고 이어가게
   * 하기 위함). 지정하지 않으면 기존 동작과 동일(감지 안 함).
   */
  allowedPathPrefixes?: string[];
  /**
   * AutoDev 지능형 오류 복구 하드닝(Problem-Solving Knowledge Store) — 직전 attempt에서
   * required test가 실패했고 problem-memory.ts가 과거 해결 사례(또는 반복 실패에 따른
   * 전략 전환 안내)를 찾았을 때만 채워진다. 존재하면 opts.allowedPathPrefixes의 "재개 안내"와
   * 동일한 방식으로 초기 transcript에 그대로 덧붙인다 — 이 문자열은 이미 호출부
   * (autodev.ts)가 problem-memory.ts로 조립을 마친 값이라 이 함수는 그 내용을 해석하거나
   * 검증하지 않는다(그 값 자체를 신뢰하는 것이 아니라, Claude에게 "검토해볼 후보"로만
   * 전달한다는 점은 안내 문구 자체에 이미 담겨 있다).
   */
  memoryHint?: string;
  /** § DeveloperDiscoveryProgress 주석 — 같은 task의 직전 attempt(TIMEOUT 등으로 종료)가
   *  남긴 discovery 진행 상태. 지정하면 이 attempt는 discoveryOnlyRoundCount를 0부터가
   *  아니라 이 값에서 이어받는다 — 이미 소진된 discovery budget을 처음부터 다시 반복하지
   *  않기 위함. 지정하지 않으면 기존 동작과 완전히 동일(0/false부터 시작). */
  priorDiscoveryProgress?: DeveloperDiscoveryProgress;
  /** AutoDev Core Maintenance — NO-WRITE Stagnation / Strategy Repeat 재하드닝(2026-08-31,
   *  JARVIS Task 5.3 실측). 같은 task가 durable하게(§ types.ts DurableFailureState.
   *  noWriteRepeatCount) 연속으로 WRITE 없이 실패한 횟수 — 지정하면 이 attempt의 내부
   *  transient retry 루프가 이 값에서 이어받아 escalation 문구(§
   *  buildNoWriteStrategyEscalationHint)를 더 일찍 보여준다. 지정하지 않으면 0부터
   *  시작(기존 동작과 동일). */
  priorNoWriteRepeatCount?: number;
  /** AutoDev Core Maintenance — Canonical Stop Path(2026-08-31, JARVIS Task 5.3 실측 —
   *  "실행 중인 Developer/continuous run을 canonical하게 정상 중단할 수 없는 결함"). 지정하면
   *  진행 중인 claude CLI subprocess를 즉시 SIGKILL로 종료하고(§ subprocess-runner.ts
   *  runSubprocessWithTimeout의 timeout과 동일한 기존 종료 수단 재사용), round 시작 전/
   *  USAGE_LIMIT·transient 재시도 대기 중에도 즉시 중단한다. errorCode="ABORTED"로 반환되며
   *  절대 재시도 대상이 아니다(§ DEVELOPER_TRANSIENT_ERROR_CODES에 포함 안 함). 지정하지
   *  않으면 기존 동작과 완전히 동일(중단 불가). */
  abortSignal?: AbortSignal;
  /** USAGE_LIMIT 재시도 대기 시간(ms) — 테스트에서만 짧게 override, 실제 운용은 항상 30분. */
  usageLimitWaitMs?: number;
  /** USAGE_LIMIT 재시도 최대 횟수 — 이 횟수 안에서는 round/discovery budget/lock grace를
   *  전혀 소비하지 않고 같은 라운드를 같은 transcript로 재시도한다. */
  usageLimitMaxRetries?: number;
  /** 테스트 전용 override — 기본은 실제 setTimeout 기반 대기. */
  sleep?: (ms: number) => Promise<void>;
  /** AutoDev 신뢰성 보완(2026-08-27, "현재 개발 라운드 대시보드 실시간 표시") — 매 내부
   *  round가 실제 claude CLI 호출을 시작하기 직전에 한 번씩 호출된다(순수 관측용, fire-and-
   *  forget). 이 콜백이 무엇을 하든(파일 쓰기 등) 예외를 던지면 실제 개발 흐름에 영향을
   *  주지 않도록 호출부(이 함수)가 항상 try/catch로 감싼다(§ 요구사항 "관측 기능이 실제
   *  개발을 방해하면 안 됨") — 지정하지 않으면 아무 일도 일어나지 않는다(기존 동작과 동일). */
  onRoundStart?: (round: number, maxRounds: number, stage: "DISCOVERY" | "LOCKED") => void;
  /** 이 task를 수행할 프로젝트의 맥락(system prompt에 삽입) — 지정하지 않으면
   *  DEFAULT_PROJECT_CONTEXT(범용 기본값)를 쓴다. 실제 운용은 autodev.ts가 ProjectManifest로
   *  부터 조립해 항상 명시적으로 넘긴다. */
  projectContext?: DeveloperProjectContext;
  /** DeveloperResult.changedFiles를 계산할 때 스캔할 프로젝트 전체 소스 범위(POSIX 상대경로,
   *  trailing "/") — 지정하지 않으면 아무것도 스캔하지 않는다(§ NO_SCOPE_CONFIGURED). 실제
   *  운용은 autodev.ts가 manifest.reviewScopeDirs를 그대로 넘긴다(GPT reviewer가 스캔하는
   *  범위와 동일). */
  changeScopeDirs?: string[];
  /** Phase C Task C2 — 이 developer task가 속한 project run 전용 SafeExecutorContext.
   *  지정하면 이 함수가 실제 파일 읽기/쓰기/명령 실행(ACTION_REQUEST 처리, 필수 테스트
   *  실행)과 changedFiles 계산에 이 context의 root/policy만 쓴다 — 다른 project의
   *  configureSafeExecutor() 호출에 영향받지 않는다. 지정하지 않으면 기존과 동일하게
   *  module-level singleton(Safe Executor의 configureSafeExecutor로 주입된 것)을 쓴다
   *  (하위 호환 — 기존 테스트가 계속 동작한다). 실제 운용(autodev.ts)은 항상 명시적으로
   *  넘긴다. */
  executor?: SafeExecutorContext;
  /** AutoDev Core Maintenance(2026-08-30) — 매 round마다 buildDeveloperContextMetrics()가
   *  이미 계산한 값을 그대로 넘긴다(순수 관측용, fire-and-forget — onRoundStart와 동일한
   *  원칙: 이 콜백이 예외를 던져도 실제 개발 흐름에 영향을 주지 않도록 항상 try/catch로
   *  감싼다). 지정하지 않으면 기존과 동일(log()만, 어디에도 영속화되지 않음). 이 함수 자신은
   *  event-store.ts를 전혀 모른다 — 실제 durable 저장은 호출부(autodev.ts)가 담당한다(§
   *  claude-developer.ts가 event-store.ts에 의존하지 않는다는 기존 설계를 유지). */
  onContextMetrics?: (metrics: DeveloperContextMetrics) => void;
  /** AutoDev Core Maintenance(2026-08-30) — § work-time.ts 파일 상단 주석이 이미 문서화한
   *  한계("단일 Developer attempt 안의 USAGE_LIMIT 내부 재시도 대기는 event로 기록되지
   *  않아 실제 작업시간에 잘못 포함된다")를 메운다. 실제 sleep 직전/직후에 각각 한 번씩
   *  호출된다(§ onRoundStart와 동일한 fire-and-forget/예외 무시 원칙) — 지정하지 않으면
   *  기존과 동일(log만 남음). 이 함수 자신은 여전히 event-store.ts를 모른다(§
   *  onContextMetrics와 동일한 경계 원칙).
   */
  onUsageLimitWait?: (info: { round: number; retryCount: number; waitMs: number; phase: "START" | "END" }) => void;
}

const MAX_INTERNAL_ROUNDS = 20;
const MAX_TRANSCRIPT_CHARS = 120_000;
// USAGE_LIMIT(Claude 계정 세션/사용량 제한)은 developer task의 "실패"가 아니라 "일시정지"로
// 취급한다 — 실제 3차 E2E에서 orchestrator가 USAGE_LIMIT마다 이 함수를 처음부터 다시
// 호출해 transcript/round/discovery/lock 상태를 전부 잃어버리는 문제가 실제로 발생했다
// (이미 write한 파일은 디스크에 남지만, 그 다음 세션은 그걸 썼다는 기억이 전혀 없었다).
// 이제 이 함수 내부에서 같은 라운드의 같은 input(transcript)으로 재시도하며, round 카운터/
// discoveryOnlyRoundCount/lockedNoProgressCount/MAX_INTERNAL_ROUNDS 중 어느 것도 소비하지
// 않는다. orchestrator.ts에도 이름이 비슷한 상수(MAX_CLAUDE_LIMIT_WAITS/CLAUDE_LIMIT_WAIT_MS)가
// 있지만, 그건 developer 내부 상태를 전혀 모르는 채로 세션을 통째로 재생성하던 이전 경로를
// 위한 것이다 — 실제 developer 러너(이 함수)를 쓰는 한 그 경로는 이 함수가 스스로 훨씬 큰
// 예산으로 재시도를 흡수하기 때문에 정상 운용에서는 거의 발동하지 않는다(주입된 fake
// claudeRunner를 쓰는 orchestrator 레벨 테스트를 위한 안전망으로만 남겨둔다).
const DEVELOPER_USAGE_LIMIT_MAX_RETRIES = 12;
const DEVELOPER_USAGE_LIMIT_WAIT_MS = 30 * 60 * 1000;
const defaultDeveloperSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const FORBIDDEN_REPEAT_LIMIT = 3;
// REVISE(bounded discovery, 실제 Phase 13 Task 2 E2E 실패 사후 반영) — 이전 버전은
// "novel 여부"로 게이팅했다: 매번 다른(아직 안 본) 파일을 read/search하면 무진척 카운터가
// 계속 0으로 리셋됐다. 실제 라이브 실행에서 Claude가 20라운드 내내 서로 다른 파일만 계속
// 탐색하고 단 한 번도 WRITE_FILE/APPLY_PATCH에 도달하지 못한 채 MAX_INTERNAL_ROUNDS에
// 도달해 TASK_ACTION_LIMIT으로 종료된 사례가 실제로 발생했다 — novelty만으로는 "계속 넓게
// 탐색만 하고 구현으로 전환하지 않는" 패턴을 막지 못한다.
//
// 지금은 novel 여부와 무관하게 "총 discovery-only 라운드 수"(READ_FILES/SEARCH만 있는
// ACTION_REQUEST 라운드 + PLAN 라운드)를 누적으로만 센다(§ discoveryOnlyRoundCount).
// 코드 변경(WRITE_FILE/APPLY_PATCH 성공)이 한 번이라도 성공하면(codeChangeHappened) 이후
// 이 카운트는 더 이상 갱신되지도, 검사되지도 않는다 — "정상적인 초기 조사"가 stagnation으로
// 오판되지 않게 하는 핵심 장치는 그대로 유지한다(다만 그 조사가 "코드 변경 전"이라는 조건
// 하나만으로 판단하고, 반복인지 새 파일인지는 더 이상 구분하지 않는다).
const DISCOVERY_BUDGET_ROUNDS = 6;
// REVISE(2차 실전 E2E 실패 사후 반영) — 이전 버전은 discovery 예산 소진 시 nudge를 보내되
// 그 이후에도 READ_FILES/SEARCH를 여전히 정상 실행했다(advisory nudge only). 실제 라이브
// 실행에서 Claude가 nudge를 받고도 계속 READ_FILES/SEARCH/PLAN만 요청해 grace(3회) 안에
// NO_PROGRESS_STAGNATION으로 끝난 사례가 실제로 발생했다 — "안내"만으로는 구현 전환을
// 강제하지 못한다. 이제 discovery 예산 소진 시 IMPLEMENTATION_REQUIRED 상태로 전환하고,
// 이 상태의 READ_FILES/SEARCH-only 라운드는 Safe Executor를 아예 호출하지 않고 코드
// 레벨에서 거부한다(§ DISCOVERY_REJECTION_MESSAGE). WRITE_FILE/APPLY_PATCH가 섞인 라운드나
// 성공한 write는 그대로 처리되며, 성공 즉시(codeChangeHappened=true) 이 상태 자체가
// 무의미해진다(이후 모든 검사가 스킵됨 — 기존 설계와 동일).
const IMPLEMENTATION_LOCK_GRACE = 3;
const NUDGE_MESSAGE =
  "# AutoDev 안내\n" +
  "지금까지 조사(READ_FILES/SEARCH/PLAN)만 계속되고 실제 코드 변경(WRITE_FILE/APPLY_PATCH)이 " +
  "전혀 없습니다 — 새로운 파일을 계속 찾고 있더라도 마찬가지입니다. 지금부터 READ_FILES/" +
  "SEARCH만 있는 요청은 더 이상 실제로 실행되지 않고 거부됩니다. 지금까지 확인한 정보로 " +
  "지금 바로 WRITE_FILE 또는 APPLY_PATCH로 실제 코드 변경을 시작하세요. 계획을 한 번 더 " +
  "정리해야 한다면 PLAN을 최대 1회만 쓸 수 있고, 그 이후로는 반드시 WRITE_FILE/APPLY_PATCH로 " +
  "이어가야 합니다. 이 안내 이후에도 코드 변경 없이 거부된 조사나 반복 PLAN만 계속되면 " +
  "작업이 자동 종료됩니다.";
const DISCOVERY_REJECTION_MESSAGE =
  "Discovery budget exhausted. Further READ_FILES/SEARCH is blocked. " +
  "Use the information already collected and issue WRITE_FILE or APPLY_PATCH now.";
const PLAN_LOCK_REPEAT_MESSAGE =
  "Discovery budget exhausted. The one-time post-lock PLAN has already been used. " +
  "Issue WRITE_FILE or APPLY_PATCH now instead of another PLAN.";

// AutoDev 신뢰성 수정(2026-08-27, "CLI 프로세스 성공 vs 개발 응답 유효성 미구분") — 실제
// production 로그(logs/automation.log, JARVIS 2026-08-26 17:37~17:56)에서 claude CLI
// subprocess가 매번 exitCode=0으로 정상 종료(§ claude-runner.ts classifySubprocessOutcome의
// "claude CLI 호출 완료" 로그 — 이 로그는 CLI 프로세스 성공 + 바깥쪽 CLI JSON envelope
// 파싱 성공만 의미하며, Claude가 실제로 유효한 AutoDev 프로토콜(TASK_COMPLETE/PLAN/
// ACTION_REQUEST+배열 actions)로 응답했는지는 별개다)한 직후 "developer 라운드 N 알 수
// 없는 응답 형식"이 반복 관측됐다 — 매회 실제 Claude CLI 왕복(수십 초~2분)을 그대로
// 소비하면서도 discoveryOnlyRoundCount/lockedNoProgressCount 어느 예산에도 잡히지 않고
// MAX_INTERNAL_ROUNDS(20)까지 그대로 흘러갈 수 있었다(§ 코드 증거: 옛 "알 수 없는 응답
// 형식" 분기는 로그+continue만 하고 어떤 카운터도 건드리지 않았다). 아래 메커니즘은 그
// 간극만 닫는다 — MAX_INTERNAL_ROUNDS/DISCOVERY_BUDGET_ROUNDS/IMPLEMENTATION_LOCK_GRACE
// 자체는 건드리지 않는다(다른 종류의 무진척 판정과 목적이 다르다).
//
// 1) 로컬 복구 우선(추가 Claude 호출 없이) — attemptLocalProtocolRecovery()가 "알려진 3개
//    타입의 대소문자/공백 오차"와 "actions가 배열이 아니라 단일 action 객체인 흔한 실수"만
//    보수적으로 복구한다. 내용을 추측하지 않는다 — 이 두 패턴이 아니면 복구를 포기한다.
// 2) 그래도 실패하면 실패 지문(스테이지+실패 종류+구조적 shape+응답 길이 버킷 — 원문/비밀은
//    전혀 포함하지 않음)을 만들어 "동일 지문이 연속되는지"만 추적한다(discoveryOnlyRoundCount와
//    완전히 독립된 카운터). 같은 지문 1회째는 기존과 동일하게 안내 후 계속 진행, 2회째는
//    응답 계약을 강하게 재안내(RESPONSE_CONTRACT_REINFORCEMENT_MESSAGE, 최대 1회), 3회째는
//    같은 방식으로 더 호출하지 않고 PROTOCOL_ERROR로 즉시 종료한다(§ DeveloperErrorCode에
//    이미 존재했지만 실제로 반환된 적은 없었다 — problem-memory.ts의
//    COMMON_PROBLEM_PATTERNS가 이미 이 코드를 "Claude CLI 응답 형식 문제"로 인식하도록
//    설계돼 있었다).
const PROTOCOL_FAILURE_HARD_STOP = 3;
const KNOWN_TOP_LEVEL_TYPES = new Set(["TASK_COMPLETE", "PLAN", "ACTION_REQUEST"]);
const KNOWN_ACTION_TYPES = new Set(["READ_FILES", "SEARCH", "WRITE_FILE", "APPLY_PATCH", "RUN_COMMAND"]);
const RESPONSE_CONTRACT_REINFORCEMENT_MESSAGE =
  "# AutoDev 응답 형식 재안내(중요)\n" +
  "방금 응답도 허용된 형식(TASK_COMPLETE / PLAN / ACTION_REQUEST)과 일치하지 않았습니다. " +
  "다른 텍스트나 코드펜스 없이 다음 세 형태 중 정확히 하나의 순수 JSON 객체만 출력하세요:\n" +
  '1) {"type":"ACTION_REQUEST","actions":[{"type":"READ_FILES","paths":[...]}, ...]} ' +
  "(actions는 요청이 하나뿐이어도 항상 배열이어야 합니다)\n" +
  '2) {"type":"PLAN","summary":"..."}\n' +
  '3) {"type":"TASK_COMPLETE","summary":"...","changedFiles":[...],"testsRequested":[...]}\n' +
  "이후에도 같은 방식으로 형식이 맞지 않으면 이 시도는 자동으로 중단되고 사람이 확인해야 합니다.";

type ParsedProtocolMessage = { type?: string; actions?: unknown; [key: string]: unknown };

/** 알려진 3개 타입의 대소문자/공백 오차, 그리고 ACTION_REQUEST의 actions가 배열이 아니라
 *  "그 자체로 유효해 보이는 단일 action 객체"인 흔한 실수만 보수적으로 복구한다 — 그 외에는
 *  절대 추측하지 않고 null을 반환한다(§ 요구사항: 지원되지 않는 형태를 추측해서 만들어내지
 *  않는다). 복구에 성공하면 추가 Claude 호출 없이 기존 TASK_COMPLETE/PLAN/ACTION_REQUEST
 *  분기를 그대로 재사용할 수 있는 정규화된 객체를 돌려준다. */
function attemptLocalProtocolRecovery(parsed: ParsedProtocolMessage): ParsedProtocolMessage | null {
  if (typeof parsed.type !== "string") return null;
  const canonicalType = parsed.type.trim().toUpperCase();
  if (!KNOWN_TOP_LEVEL_TYPES.has(canonicalType)) return null;

  if (canonicalType === "ACTION_REQUEST") {
    if (Array.isArray(parsed.actions)) {
      return canonicalType === parsed.type ? null : { ...parsed, type: canonicalType };
    }
    const singleAction = parsed.actions;
    if (
      singleAction &&
      typeof singleAction === "object" &&
      typeof (singleAction as Record<string, unknown>).type === "string" &&
      KNOWN_ACTION_TYPES.has(((singleAction as Record<string, unknown>).type as string).toUpperCase())
    ) {
      return { ...parsed, type: canonicalType, actions: [singleAction] };
    }
    return null;
  }

  return canonicalType === parsed.type ? null : { ...parsed, type: canonicalType };
}

/** 실패한 응답의 "구조"만 짧게 요약한다 — 원문 내용은 절대 포함하지 않는다(type 필드
 *  값만 40자로 잘라 sanitizeForLog를 거쳐 담는다, § 관측성 요구사항). */
function describeUnrecognizedShape(parsed: ParsedProtocolMessage | null): string {
  if (!parsed) return "not-json";
  const typeVal = typeof parsed.type === "string" ? sanitizeForLog(parsed.type.slice(0, 40)) : typeof parsed.type;
  if (parsed.type === "ACTION_REQUEST") {
    return `type=ACTION_REQUEST,actions=${Array.isArray(parsed.actions) ? "array" : typeof parsed.actions}`;
  }
  return `type=${typeVal}`;
}

/** stage(discovery/locked)+실패 종류+구조 요약+응답 길이 버킷만으로 만든 non-secret
 *  지문 — 원문도, task 내용도 포함하지 않는다. 같은 실패가 반복되는지만 판정하면 되므로
 *  암호학적 강도는 필요 없지만(sha256은 이미 이 저장소 다른 곳(project-lock.ts 등)에서도
 *  이런 용도로 재사용되는 표준 선택이라 그대로 따른다), 짧게(16자) 자른다. */
function computeProtocolFailureFingerprint(stageLabel: string, kind: string, shapeDescriptor: string, rawLength: number): string {
  const lenBucket = Math.floor(rawLength / 200);
  const composite = `${stageLabel}|${kind}|${shapeDescriptor}|len${lenBucket}`;
  return createHash("sha256").update(composite).digest("hex").slice(0, 16);
}

// system prompt 자체는 신뢰 경계가 아니다(§ 상단 주석) — 여기 들어가는 프로젝트별 내용은
// 순수 안내문이고, 실제 강제는 Safe Executor(safe-executor.ts)가 코드 레벨로 한다. 그래서
// ctx.instructions에 어떤 문자열이 와도(빈 프로젝트 규칙 포함) 안전 경계 자체는 약화되지
// 않는다.
// export: developer-reviewer-context-tests.ts가 실제 claude CLI를 호출하지 않고도 system
// prompt에 프로젝트별 내용이 정확히 삽입되는지(그리고 다른 프로젝트 내용이 섞이지 않는지)
// 직접 검증할 수 있게 한다.
export function buildProtocolSystemPrompt(ctx: DeveloperProjectContext): string {
  return `당신은 ${ctx.projectName}의 자동 개발자입니다.
이 세션에는 built-in 파일/명령 도구가 전혀 없습니다(Read/Edit/Write/Bash 사용 불가).
대신 Safe Executor를 통해서만 파일을 읽고, 검색하고, 수정하고, 명령을 실행할 수 있습니다.

매 턴 반드시 순수 JSON 객체 하나만 출력하세요(설명 텍스트, 마크다운 코드펜스 금지).

파일/검색/명령이 필요하면:
{"type":"ACTION_REQUEST","actions":[...]}

action 종류:
- {"type":"READ_FILES","paths":["path/to/file.ts"]}
- {"type":"SEARCH","pattern":"정규식","globs":["src"]}
- {"type":"WRITE_FILE","path":"...","content":"..."} (새 파일 생성 또는 전체 덮어쓰기)
- {"type":"APPLY_PATCH","path":"...","oldString":"...","newString":"...","replaceAll":false}
  (oldString은 대상 파일과 정확히 일치해야 하고, 여러 번 일치하면 replaceAll:true 필요)
- {"type":"RUN_COMMAND","command":"...","args":["..."],"cwd":"root"}

권장 흐름: 초기 조사(READ_FILES/SEARCH) → 필요하면 구현 계획 정리 → WRITE_FILE/APPLY_PATCH
→ 검증. 확인한 정보를 바탕으로 구현 계획을 한 번 정리하고 싶다면
{"type":"PLAN","summary":"..."}로 응답할 수 있습니다(선택 사항, 최대 몇 번이든 가능하지만
계획만 반복하고 실제 구현으로 이어지지 않으면 무진척으로 간주됩니다) — PLAN 이후에는 바로
WRITE_FILE/APPLY_PATCH로 이어가세요.

라운드 수를 아끼세요: 서로 독립적인 READ_FILES/SEARCH 요청은 여러 라운드로 나누지 말고,
가능한 한 하나의 ACTION_REQUEST의 actions 배열 안에 함께 담아 한 번에 요청하세요
(예: 파일 3개를 읽어야 하면 별도 라운드 3번이 아니라 READ_FILES 액션 1개에 paths 3개,
또는 READ_FILES/SEARCH 여러 개를 같은 actions 배열에 함께 넣으세요). 조사(READ_FILES/
SEARCH/PLAN)만 계속되고 코드 변경(WRITE_FILE/APPLY_PATCH)이 없는 라운드가 일정 횟수
쌓이면 — 매번 새로운 파일을 찾고 있더라도 마찬가지로 — AutoDev가 구현 단계로 전환하라는
안내를 한 번 보냅니다. 그 이후로는 READ_FILES/SEARCH만 있는 요청을 실제로 실행하지 않고
거부합니다(응답에 결과 대신 거부 안내가 옵니다) — 지금까지 얻은 정보로 바로 WRITE_FILE/
APPLY_PATCH를 시작하세요. 계획 정리가 꼭 필요하면 PLAN을 이 시점 이후 최대 1회만 쓸 수
있고, 그래도 코드 변경이 없으면 자동으로 조기 종료됩니다.

# 프로젝트 규칙(${ctx.projectName})
${ctx.instructions}

각 action은 실행 전 검증됩니다. 거부되면 ok:false와 denyReason이 돌아옵니다 — 거부된 방식을
반복하지 말고 다른 방법을 시도하세요. 같은 방식이 3번 거부되면 그 항목은 사람 검토용으로
넘겨지니 다른 접근으로 계속 진행하세요.

작업이 끝났다고 판단되면 반드시 이 형태로만 응답하세요:
{"type":"TASK_COMPLETE","summary":"...","changedFiles":["..."],"testsRequested":["..."]}
(changedFiles/testsRequested는 참고용일 뿐이며, 실제 채택되는 값은 AutoDev가 git status로
직접 산출하고 task에 지정된 필수 테스트를 AutoDev가 직접 실행해 검증합니다 — 당신이 "테스트
통과"라고 적는 것만으로는 승인되지 않습니다. git commit은 절대 시도하지 마세요 — AutoDev가
검토 후 자동으로 처리합니다.)

내부 라운드는 최대 ${MAX_INTERNAL_ROUNDS}회로 제한됩니다. 위 프로젝트 규칙에서 사람 확인이
필요하다고 명시한 고위험 작업은 시도하지 말고 TASK_COMPLETE의 summary에 사람 확인이
필요하다고 명시하세요.`;
}

// AutoDev Claude Developer context/token 소비 계측(Stage 4, 2026-08-29) — 매 round
// claudeCall() 직전 context 규모를 안전하게(원문 코드/Secret 없이 문자 수·개수만) 기록해
// 향후 다시 추측하지 않고 실측으로 확인할 수 있게 한다. 순수 함수라 실제 Claude 호출 없이
// 단위 테스트로 검증 가능하다.
export interface DeveloperContextMetrics {
  attempt: number;
  round: number;
  systemPromptChars: number;
  transcriptChars: number;
  transcriptEntryCount: number;
  fileSnapshotChars: number;
  fileSnapshotCount: number;
  duplicateReadCount: number;
  trimmedThisRound: boolean;
}

export function buildDeveloperContextMetrics(input: {
  attempt: number;
  round: number;
  systemPromptChars: number;
  transcriptInput: string;
  transcriptEntryCount: number;
  fileSnapshots: ReadonlyMap<string, string>;
  duplicateReadCount: number;
  trimmedThisRound: boolean;
}): DeveloperContextMetrics {
  let fileSnapshotChars = 0;
  for (const content of input.fileSnapshots.values()) fileSnapshotChars += content.length;
  return {
    attempt: input.attempt,
    round: input.round,
    systemPromptChars: input.systemPromptChars,
    transcriptChars: input.transcriptInput.length,
    transcriptEntryCount: input.transcriptEntryCount,
    fileSnapshotChars,
    fileSnapshotCount: input.fileSnapshots.size,
    duplicateReadCount: input.duplicateReadCount,
    trimmedThisRound: input.trimmedThisRound,
  };
}

// getActualChangedFiles/reviewer가 같은 기준(git-changes.ts)을 쓰도록 통일한다 — 이전에는
// "git diff --name-only"만 써서 신규(untracked) 파일이 changedFiles에서 누락됐다. scopeDirs는
// 호출부(runDeveloperTaskViaSafeExecutor)가 opts.changeScopeDirs로 넘긴다 — 이 함수는 어떤
// 프로젝트의 소스 범위인지 모른다.
function getActualChangedFiles(scopeDirs: string[], executor: SafeExecutorContext | undefined): string[] {
  const { all } = getWorkingTreeChanges(scopeDirs, executor?.projectRoot);
  return all.map((c) => c.path);
}

// Phase 5 — required test가 실제로 실행됐다면(denyReason이 아니라 실제 spawn 결과) 그
// stdout/stderr의 "꼬리"(마지막 부분)를 보존한다. assertion/error 메시지는 보통 출력의
// 끝부분에 나온다 — 전체를 다 보내면 다음 라운드/Reviewer 프롬프트가 불필요하게 커지므로
// bounded 크기로만 자른다(safe-executor.ts가 이미 20,000자로 자르고 secret을 redact한
// 값을 다시 여기서 4,000자로 좁힌다).
const FAILURE_EVIDENCE_TAIL_CHARS = 4_000;
function tailChars(s: string | undefined, max: number): string | undefined {
  if (!s) return undefined;
  return s.length > max ? s.slice(-max) : s;
}

async function runRequiredTests(
  requiredTests: RequiredTestCommand[] | undefined,
  executor: SafeExecutorContext | undefined
): Promise<DeveloperResult["tests"]> {
  if (!requiredTests || requiredTests.length === 0) return [];
  const doValidateAndExecute = executor?.validateAndExecute ?? validateAndExecute;
  const results: DeveloperResult["tests"] = [];
  for (const t of requiredTests) {
    const res = await doValidateAndExecute({ type: "RUN_COMMAND", command: t.command, args: t.args, cwd: t.cwd });
    if (res.ok) {
      results.push({ name: t.name, pass: true });
      continue;
    }
    log(`필수 테스트 실패(${t.name})`, { command: t.command, args: t.args, cwd: t.cwd, denyReason: res.denyReason });
    const commandLabel = [t.command, ...t.args].join(" ");
    // res.data는 실제로 명령이 spawn되어 실행됐을 때만 exitCode/stdout/stderr를 담는다(§
    // safe-executor.ts executeRunCommand) — Command Safety Gate가 애초에 명령을 막았으면
    // (denyReason만 있고 data는 없음) 그 사실 자체가 이미 인프라 원인이므로 없는 stdout/
    // stderr를 지어내지 않는다.
    const data = res.data as { exitCode?: number | null; stdout?: string; stderr?: string } | undefined;
    if (data && (typeof data.exitCode === "number" || data.exitCode === null)) {
      results.push({
        name: t.name,
        pass: false,
        failureEvidence: {
          command: commandLabel,
          exitCode: data.exitCode,
          stderrTail: tailChars(data.stderr, FAILURE_EVIDENCE_TAIL_CHARS),
          stdoutTail: tailChars(data.stdout, FAILURE_EVIDENCE_TAIL_CHARS),
        },
      });
    } else {
      // AutoDev Core Maintenance(2026-08-30) — § types.ts ClaudeResult.tests.denyReason 주석.
      // res.denyReason은 이미 위 log()로 남고 있었지만 결과 객체 자체에는 전혀 담기지 않아
      // Developer/Reviewer 어느 쪽도 볼 수 없었다. failureEvidence는 여전히 채우지 않는다
      // (§ classifyFailureCategory의 "명령이 spawn됐는가" 판정을 그대로 보존).
      results.push({ name: t.name, pass: false, ...(res.denyReason ? { denyReason: res.denyReason } : {}) });
    }
  }
  return results;
}

async function callClaude(input: string, timeoutMs: number, systemPrompt: string, projectRoot?: string, abortSignal?: AbortSignal) {
  // 프롬프트를 CLI 인자로 넘기지 않고 stdin으로 전달한다 — 라운드가 쌓여 프롬프트가 커지면
  // OS 명령행 길이 제한(Windows에서 실제로 ENAMETOOLONG 발생 확인)에 걸리기 때문이다.
  // "claude -p"(positional prompt 생략)가 stdin에서 읽는 것은 실제 호출로 직접 검증했다.
  const args = [
    "-p",
    "--output-format",
    "json",
    "--tools",
    "",
    "--no-session-persistence",
    "--system-prompt",
    systemPrompt,
  ];
  // SI-3.6(Executable Identity Trust) — bare "claude" 문자열을 더 이상 spawn에 직접 넘기지
  // 않는다(§ claude-runner.ts resolveTrustedClaudeCommand 상단 설명 — 이 호출부가 실제로
  // 개발 대상 project 내용을 다루는 가장 공격 표면이 큰 경로다). projectRoot를 함께
  // 넘겨 project-local 가짜 claude 실행 파일도 PATH 탐색 후보에서 제외한다.
  const trusted = resolveTrustedClaudeCommand(projectRoot ? [projectRoot] : []);
  if (!trusted.ok) return trusted.result;
  // 2026-08-29 — 개발 대상 프로젝트 root를 이 claude subprocess의 cwd로 명시적으로 넘긴다.
  // 지정하지 않으면 이 Node 프로세스(runner) 자신의 cwd를 그대로 물려받는데, production
  // 운용에서 그건 AutoDev Core 저장소 자신이다(runner-supervisor.ts가 continuous runner를
  // 그 cwd로 spawn한다) — Claude Code CLI가 spawn 시점 cwd 기준으로 자체 환경 컨텍스트를
  // 읽어들이므로, 실제 개발 대상(JARVIS 등)과 무관한 AutoDev Core 자신의 CLAUDE.md/rules가
  // 매 호출마다 섞여 들어갈 수 있다(§ 실측: JARVIS Task 5.2). projectRoot가 없으면(테스트 등
  // 기존 호출부) 기존과 동일하게 상속된 cwd를 그대로 쓴다.
  const outcome = await runSubprocessWithTimeout(trusted.command, args, timeoutMs, input, projectRoot, abortSignal);
  return classifySubprocessOutcome(outcome, timeoutMs);
}

function actionKey(action: ExecutorAction): string {
  return JSON.stringify(action).slice(0, 300);
}

// AutoDev / JARVIS Unattended Continuous Development Reliability Hardening Phase 6 —
// Write-time task scope enforcement. Safe Executor(safe-executor.ts)의
// allowedReadPrefixes/allowedWritePrefixes는 project 전체 기준(project-wide)이고 task 단위
// 경계를 모른다 — 그래서 실제 JARVIS Task 2.1 실행에서 Developer가 이 task의
// allowedPathPrefixes(예: "backend/device-trust/") 밖(예: "backend/device-trust-manager.mjs")에
// WRITE_FILE을 요청해도 Safe Executor는 그대로 통과시켰고, 그 결과 GPT Reviewer 단계에서야
// scope violation으로 발견되어 WAITING_HUMAN(BLOCK)으로 종료됐다. 이 함수는 그 경계를
// WRITE_FILE/APPLY_PATCH 요청 시점에 미리 검사해, Reviewer까지 가지 않고 같은 attempt 안에서
// Developer에게 즉시 거부 사유를 돌려준다(§ 아래 호출부 — 실제 Safe Executor 호출 전에
// 막는다, denyReason이 있는 기존 result.ok===false 처리 경로를 그대로 재사용한다).
//
// 단순 문자열 startsWith만 쓰면 "backend/device-trust/"가 "backend/device-trust-evil/"까지
// 허용된 것으로 오판할 수 있다(§ 요구사항) — 반드시 경로 세그먼트 경계에서만 일치해야
// 한다("backend/device-trust" 자체이거나 그 뒤에 "/"가 와야 함). 절대경로(Windows 드라이브
// 문자, POSIX 절대경로, UNC)와 ".." 상위 탈출 세그먼트는 무조건 거부한다(project root 밖으로
// 나가려는 시도는 allowedPathPrefixes와 무관하게 항상 범위 밖이다). Windows `\`와 POSIX `/`
// 구분자, 연속된 구분자를 모두 `/` 하나로 정규화한 뒤 비교한다.
function normalizeActionPathForScopeCheck(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export function isPathWithinAllowedPrefixes(path: string, allowedPathPrefixes: readonly string[]): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  const normalized = normalizeActionPathForScopeCheck(path);
  if (/^[a-zA-Z]:\//.test(normalized)) return false; // Windows 드라이브 절대경로
  if (normalized.startsWith("/")) return false; // POSIX 절대경로 또는 UNC(//)
  const segments = normalized.split("/");
  if (segments.some((s) => s === "..")) return false; // 상위 디렉터리 탈출 시도
  return allowedPathPrefixes.some((rawPrefix) => {
    const prefix = normalizeActionPathForScopeCheck(rawPrefix).replace(/\/+$/, "");
    if (prefix.length === 0) return false;
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

// Claude가 지시를 어기고 마크다운 코드펜스나 설명 텍스트를 덧붙이는 경우까지 관대하게
// 처리한다 — 코드펜스 제거 후 직접 파싱을 시도하고, 그래도 실패하면 첫 번째 균형 잡힌
// {...} 블록을 브레이스 카운팅으로 찾아 그 부분만 파싱한다.
function tryParseProtocolJson(raw: string): { type?: string; [key: string]: unknown } | null {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
  try {
    return JSON.parse(stripped);
  } catch {
    // fallthrough
  }

  const start = stripped.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = stripped.slice(start, i + 1);
        try {
          return JSON.parse(candidate);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function runDeveloperTaskViaSafeExecutor(
  task: string,
  attempt: number,
  opts: DeveloperTaskOptions = {}
): Promise<DeveloperResult> {
  const timeoutMs = opts.timeoutPerRoundMs ?? 300_000;
  const changeScopeDirs = opts.changeScopeDirs ?? NO_SCOPE_CONFIGURED;
  const projectContext = opts.projectContext ?? DEFAULT_PROJECT_CONTEXT;
  const systemPrompt = buildProtocolSystemPrompt(projectContext);
  // SI-3.6 bounded review(chunk1 HIGH) 지적 반영 — executor가 지정되지 않은 호출(하위 호환
  // module-level singleton 경로)도 target project root를 빠뜨리지 않는다. PROJECT_ROOT는
  // configureSafeExecutor()가 갱신하는 살아있는 재-export 바인딩이라(§ checkpoint.ts/git-
  // changes.ts/gpt-reviewer.ts가 이미 같은 방식으로 참조) executor가 없을 때도 실제 활성
  // project root를 반영한다.
  const claudeCall =
    opts.claudeCaller ??
    ((input: string, callTimeoutMs: number) =>
      callClaude(input, callTimeoutMs, systemPrompt, opts.executor?.projectRoot ?? PROJECT_ROOT, opts.abortSignal));
  const sleepFn = opts.sleep ?? defaultDeveloperSleep;
  // AutoDev Core Maintenance — Canonical Stop Path(2026-08-31). abortSignal이 이미
  // 발동된 채로 들어오면(예: 여러 quick retry 사이 abort) claude CLI를 한 번도 더 부르지
  // 않고 즉시 ABORTED로 반환한다 — round 진입 직전마다 재확인한다(§ 아래 round loop).
  function abortedResultIfRequested(round: number): DeveloperResult | undefined {
    if (!opts.abortSignal?.aborted) return undefined;
    log(`developer 중단 요청(abortSignal) 감지 — 라운드 ${round} 시작 전 즉시 종료`);
    return {
      success: false,
      summary: "중단 요청(canonical stop)으로 종료했습니다.",
      changedFiles: getActualChangedFiles(changeScopeDirs, executor),
      tests: [],
      rawOutput: "",
      errorCode: "ABORTED",
      discoveryProgress: captureDiscoveryProgress(round),
      ...usageFields(),
    };
  }
  function reportRoundStart(round: number, stage: "DISCOVERY" | "LOCKED"): void {
    if (!opts.onRoundStart) return;
    try {
      opts.onRoundStart(round, MAX_INTERNAL_ROUNDS, stage);
    } catch (e) {
      log("developer onRoundStart 콜백 실패 — 관측용이므로 무시하고 개발을 계속합니다", { error: e instanceof Error ? e.message : undefined });
    }
  }
  const usageLimitWaitMs = opts.usageLimitWaitMs ?? DEVELOPER_USAGE_LIMIT_WAIT_MS;
  const usageLimitMaxRetries = opts.usageLimitMaxRetries ?? DEVELOPER_USAGE_LIMIT_MAX_RETRIES;
  // Phase C Task C2 — 이 run 전용 SafeExecutorContext(지정 안 되면 module-level singleton
  // 하위 호환). 이 함수 안의 모든 실제 read/write/명령 실행과 changedFiles 계산이 이 하나의
  // 값만 참조한다 — 다른 developer run이 자신의 executor로 무엇을 하든 이 run에는 보이지
  // 않는다.
  const executor = opts.executor;
  const doValidateAndExecute = executor?.validateAndExecute ?? validateAndExecute;

  const transcript: string[] = [`# Task\n${task}`];

  // AutoDev 지능형 오류 복구 하드닝 — problem-memory.ts가 찾은 과거 해결 사례/반복 실패
  // 전략 전환 안내가 있으면 그대로 덧붙인다(§ opts.memoryHint 문서 참고). 이 값은 "정답"이
  // 아니라 검토할 후보일 뿐이라는 점을 안내 문구 자체에 명시한다(§ 요구사항 5 — 과거
  // 해결책을 무조건 적용하지 않는다).
  if (opts.memoryHint) {
    transcript.push(opts.memoryHint);
  }

  // AutoDev / JARVIS Unattended Continuous Development Reliability Hardening Phase 6 —
  // required test의 정확한 npm 명령과(등록돼 있다면) 그 명령이 실제로 가리키는 테스트 파일
  // 경로, 그리고 이 task의 허용 경로를 Developer에게 명시적으로 전달한다. 실제 JARVIS Task
  // 2.1에서 Developer가 required test 이름/경로를 임의로 다르게 지어(등록/폐기 통합 단일
  // 테스트 파일을 허용 경로 밖에 생성) required test가 MODULE_NOT_FOUND로 실패한 사례를
  // 재현하지 않기 위함이다 — 이 정보는 이미 taskDef.requiredTests/allowedPathPrefixes(task-
  // registry.ts)에 존재하는 데이터를 그대로 노출할 뿐, 새 계약을 만들지 않는다.
  if (opts.requiredTests && opts.requiredTests.length > 0) {
    const pkg = executor?.projectRoot ? readPackageJsonScripts(executor.projectRoot) : { ok: false as const, reason: "no executor" };
    const unregisteredNpmScripts: string[] = [];
    const lines = opts.requiredTests.map((rt) => {
      const cmdLabel = [rt.command, ...rt.args].join(" ");
      const npmScript = extractNpmRunScript(rt);
      if (npmScript && pkg.ok) {
        const resolved = pkg.scripts[npmScript];
        if (typeof resolved === "string") {
          return `- ${rt.name}: \`${cmdLabel}\` → 실제 실행 명령: \`${resolved}\``;
        }
        unregisteredNpmScripts.push(npmScript);
        return `- ${rt.name}: \`${cmdLabel}\`(아직 package.json에 등록되지 않음 — npm script 이름은 정확히 \`${npmScript}\`입니다. 이 task의 허용 경로 안에 대응하는 테스트 파일을 정확히 하나만 만들면 AutoDev가 자동으로 등록합니다)`;
      }
      return `- ${rt.name}: \`${cmdLabel}\``;
    });
    transcript.push(
      "# AutoDev 안내(필수 테스트 계약)\n" +
        "이 task는 다음 required test가 실제 exitCode로 검증됩니다(Claude의 자체 완료 보고는 신뢰되지 않습니다):\n" +
        lines.join("\n") +
        (opts.allowedPathPrefixes && opts.allowedPathPrefixes.length > 0
          ? `\n반드시 이 허용 경로 안에만 파일을 작성/수정하세요: ${opts.allowedPathPrefixes.join(", ")}. ` +
            "위에 \"실제 실행 명령\"이 표시된 항목이 있다면 그 정확한 파일 경로에 테스트를 작성하세요 — " +
            "다른 이름이나 다른 위치에 테스트 파일을 만들면 그 required test는 파일을 찾지 못해 실패합니다."
          : "") +
        (unregisteredNpmScripts.length > 0
          ? "\n아직 등록되지 않은 required test가 있고 이 task의 허용 경로 안에 그 테스트 파일을 " +
            "정확히 어디에 만들었는지 명시하고 싶다면, TASK_COMPLETE 응답에 " +
            '`"requiredTestRegistrations":[{"scriptName":"<npm script 이름 그대로 — 예: ' +
            `${unregisteredNpmScripts[0]}` +
            '(위 목록에서 " → 실제 실행 명령"이 아니라 "npm script 이름은 정확히" 뒤에 나온 문자열을 그대로 쓰세요, ' +
            'required test의 표시 이름(콜론 앞 이름)이 아닙니다)>","runner":"node",' +
            '"target":"<이 task의 허용 경로 안의 실제 파일 경로>"}]`를 추가하세요 ' +
            "(package.json을 직접 쓸 권한은 없습니다 — 이 요청은 AutoDev가 검증 후에만 등록합니다)."
          : "")
    );
  }

  // 이전 시도(새 프로세스로 재시작 등)의 in-scope 미완성 작업물이 이미 디스크에 있으면,
  // 버리라고 하지 않고 이어서 진행하라고 명시적으로 안내한다. scope 밖 변경 차단은 여기서
  // 다루지 않는다 — 그건 기존 checkpoint/GPT reviewer의 scope-violation BLOCK 정책이 그대로
  // 담당한다(이 안내는 순수 정보 제공이지 권한 확장이 아니다).
  if (opts.allowedPathPrefixes && opts.allowedPathPrefixes.length > 0) {
    const existingInScope = getWorkingTreeChanges(opts.allowedPathPrefixes, executor?.projectRoot).all.map((c) => c.path);
    if (existingInScope.length > 0) {
      log(`developer 재개 감지 — 이전 시도의 in-scope 미완성 변경 ${existingInScope.length}개`, { files: existingInScope });
      transcript.push(
        "# AutoDev 안내(재개)\n" +
          "Existing in-scope partial changes from the previous attempt were detected. " +
          "Do not discard them. Inspect and continue the existing implementation.\n" +
          `변경된 파일 목록:\n${existingInScope.map((p) => `- ${p}`).join("\n")}`
      );
    }
  }

  // AutoDev Claude Developer context/token 소비 근본 조사(2026-08-29) — 같은 파일을 여러
  // round에 걸쳐 READ_FILES하면 그 전체 내용이 매번 별도 "# Round N 결과" transcript
  // 항목으로 영구히 쌓였다(실측: JARVIS Task 5.2). path별 "가장 최근에 읽은 내용"만
  // fileSnapshots에 보관하고, 그 내용 전체는 transcript 안의 단 하나의 전용 항목
  // (fileSnapshotEntryIndex가 가리키는 위치)에만 매번 덮어써서 유지한다 — 개별 round의
  // "결과" 항목에는 READ_FILES의 실제 content 대신 어떤 경로를 읽었는지와 이 전용 항목을
  // 참고하라는 짧은 안내만 남긴다(§ 아래 ACTION_REQUEST 처리 부분). WRITE_FILE/APPLY_PATCH
  // 자체는 건드리지 않는다 — 그 이후 다시 READ_FILES하면 Safe Executor가 항상 디스크의
  // 최신 내용을 그대로 반환하므로 "최신 내용 사용"은 자연히 보장된다.
  const fileSnapshots = new Map<string, string>();
  let fileSnapshotEntryIndex: number | undefined;
  // 계측 전용(§ Stage 4) — 같은 경로가 이미 fileSnapshots에 있던 상태에서 다시 읽힌
  // 횟수(=dedup이 실제로 몇 번 작동했는지). fileSnapshots.size(고유 파일 수)와는 다른 값이다.
  let duplicateReadCount = 0;
  // AutoDev Core Maintenance(2026-08-30) — fileSnapshots 총 크기 상한(§ Part 1-2, "동일
  // 파일은 항상 최신 snapshot 1개" 원칙 자체는 유지하되, 서로 다른 파일 수가 많은 task에서
  // fileSnapshots 자체가 무한히 커지는 것은 별개 문제다 — round당 char 상한(capTranscript)
  // 안에서 evict되긴 하지만, 그 evict는 "가장 오래된 transcript 항목 전체"를 통째로 버리는
  // 방식이라 그 시점까지 fileSnapshots 자체는 계속 무제한으로 자란다). least-recently-*read*
  // 항목부터 evict한다(Map의 insertion order는 재-read 시 갱신되지 않으므로 별도로
  // 추적한다) — 이번 round에 실제로 읽은 경로는 절대 evict하지 않는다.
  const MAX_FILE_SNAPSHOTS_TOTAL_CHARS = 400_000;
  const fileSnapshotLastReadRound = new Map<string, number>();
  function enforceFileSnapshotsCap(currentRound: number, justReadPaths: ReadonlySet<string>): void {
    let total = 0;
    for (const content of fileSnapshots.values()) total += content.length;
    if (total <= MAX_FILE_SNAPSHOTS_TOTAL_CHARS) return;
    // 가장 오래 전에 읽힌 경로부터(오름차순) evict — 이번 round에 읽은 경로는 건너뛴다.
    const byAge = [...fileSnapshotLastReadRound.entries()]
      .filter(([path]) => !justReadPaths.has(path))
      .sort((a, b) => a[1] - b[1]);
    for (const [path] of byAge) {
      if (total <= MAX_FILE_SNAPSHOTS_TOTAL_CHARS) break;
      const content = fileSnapshots.get(path);
      if (content === undefined) continue;
      total -= content.length;
      fileSnapshots.delete(path);
      fileSnapshotLastReadRound.delete(path);
    }
  }

  const forbiddenRepeatCount = new Map<string, number>();
  const deferredHumanTasks: string[] = [];
  let codeChangeHappened = false;
  // false(DISCOVERY): 기존처럼 READ_FILES/SEARCH/PLAN이 정상 실행된다. discoveryOnlyRoundCount가
  // DISCOVERY_BUDGET_ROUNDS에 도달하면 true(IMPLEMENTATION_REQUIRED)로 전환되고 다시는
  // false로 되돌아가지 않는다(코드 변경이 성공하면 codeChangeHappened가 모든 검사를 무력화
  // 한다 — 잠금 자체를 되돌릴 필요가 없다).
  let implementationLocked = false;
  let discoveryOnlyRoundCount = 0;
  // § DeveloperDiscoveryProgress 주석 — 같은 task의 직전 attempt가 이미 discovery budget을
  // 소진했다면(implementationLocked===true) 이번 attempt는 정확히 1 round만 grace로 허용한
  // 뒤 다시 잠근다(DISCOVERY_BUDGET_ROUNDS - 1에서 시작 — 기존 상수를 그대로 재사용할 뿐 새
  // 숫자를 만들지 않는다). 아직 discovery 도중에 끝났다면(budget 미소진) 그 카운트를 그대로
  // 이어받아 처음부터 다시 세지 않는다. priorDiscoveryProgress가 없으면 기존과 완전히 동일
  // (0/false부터 시작).
  if (opts.priorDiscoveryProgress) {
    discoveryOnlyRoundCount = opts.priorDiscoveryProgress.implementationLocked
      ? DISCOVERY_BUDGET_ROUNDS - 1
      : opts.priorDiscoveryProgress.discoveryOnlyRoundCount;
  }
  // IMPLEMENTATION_REQUIRED 상태에서 "진척 없는 시도"(거부된 discovery-only 라운드 + 1회
  // 한도를 넘긴 PLAN 반복) 누적 횟수 — novel 여부와 무관, discoveryOnlyRoundCount와 동일한
  // 정신으로 누적만 한다.
  let lockedNoProgressCount = 0;
  // IMPLEMENTATION_REQUIRED로 전환된 뒤 "구현 전환용" PLAN을 정확히 1회까지만 정상 처리한다
  // (두 번째부터는 PLAN_LOCK_REPEAT_MESSAGE로 거부).
  let planUsedInLock = false;

  // discoveryOnlyRoundCount/lockedNoProgressCount와 완전히 독립된 카운터 — "응답을 아예
  // 유효한 프로토콜로 해석하지 못한 라운드"만 추적한다(§ PROTOCOL_FAILURE_HARD_STOP 상단 주석).
  let consecutiveProtocolFailureCount = 0;
  let lastProtocolFailureFingerprint: string | undefined;
  let reinforcementSentForFingerprint: string | undefined;

  // AutoDev 신뢰성 보완(2026-08-27, "호출 효율 지표") — 대시보드(§ Section 16)가 "호출은
  // 많은데 실제 개발은 안 되는 상황"을 새 사용량 체계 없이 이 attempt 하나의 요약값만으로
  // 판단할 수 있게 한다. round 루프 밖에서 별도로 추정하지 않고, 이미 그 판정을 내리는
  // 지점(dispatchable/recovered 계산부)에서 그대로 1씩만 더한다 — 새 판정 로직이 아니다.
  let totalRounds = 0;
  let validResponseRounds = 0;
  let localRecoverySuccessRounds = 0;
  let protocolFailureRounds = 0;

  // Phase G Task G3.1 — 이 developer attempt 안에서 실제로 성공한 모든 내부 round(claude CLI
  // 호출)의 tokenUsage를 합산한다. round마다 별도 event로 쪼개 기록하지 않고(canonical 위치는
  // 이 함수의 반환값 하나뿐이다) 이 attempt 전체를 대표하는 값 하나로만 반환한다 — 호출부
  // (orchestrator.ts)가 이 DeveloperResult 하나당 정확히 한 번만 event에 반영한다.
  let accInputTokens: number | undefined;
  let accOutputTokens: number | undefined;
  let lastModel: { provider: string; name: string } | undefined;
  function accumulateUsage(raw: { model?: { provider: string; name: string }; tokenUsage?: { inputTokens?: number; outputTokens?: number } }): void {
    if (raw.model) lastModel = raw.model;
    if (raw.tokenUsage?.inputTokens !== undefined) accInputTokens = (accInputTokens ?? 0) + raw.tokenUsage.inputTokens;
    if (raw.tokenUsage?.outputTokens !== undefined) accOutputTokens = (accOutputTokens ?? 0) + raw.tokenUsage.outputTokens;
  }
  function usageFields(): Pick<DeveloperResult, "model" | "tokenUsage" | "callStats"> {
    return {
      ...(lastModel ? { model: lastModel } : {}),
      ...(accInputTokens !== undefined || accOutputTokens !== undefined
        ? { tokenUsage: { inputTokens: accInputTokens, outputTokens: accOutputTokens } }
        : {}),
      callStats: { totalRounds, validResponseRounds, localRecoverySuccessRounds, protocolFailureRounds },
    };
  }

  // 2026-08-29(Prompt Cache 안정성) — trim이 배열 "중간"의 임의 항목을 제거하면 그 시점부터
  // 이후 모든 호출의 prefix가 이전 호출들과 완전히 달라져 prompt cache가 통째로 무효화된다
  // (실측: JARVIS Task 5.2에서 대규모 re-cache 관찰). Task 본문(index 0)과 현재 파일
  // snapshot 항목(fileSnapshotEntryIndex — 이미 위 dedup으로 각 파일당 최신 내용 하나만
  // 담고 있어 그 자체로 크기가 억제됨)은 절대 제거 대상에서 제외해, 실제로 제거되는 것은
  // 항상 "오래된 round 서술" 쪽이 되게 한다 — trim이 일어나는 빈도 자체를 줄이지는 않지만,
  // Developer가 여전히 필요로 하는 최신 파일 내용을 trim이 지워버리는 일은 없앤다.
  const capTranscript = () => {
    let joined = transcript.join("\n\n---\n\n");
    while (joined.length > MAX_TRANSCRIPT_CHARS && transcript.length > 1) {
      let removeAt = -1;
      for (let i = 1; i < transcript.length; i++) {
        if (i === fileSnapshotEntryIndex) continue;
        removeAt = i;
        break;
      }
      if (removeAt === -1) break; // Task 본문 + snapshot뿐 — 더 이상 안전하게 제거할 항목이 없음.
      transcript.splice(removeAt, 1);
      if (fileSnapshotEntryIndex !== undefined && fileSnapshotEntryIndex > removeAt) fileSnapshotEntryIndex -= 1;
      joined = transcript.join("\n\n---\n\n");
    }
    return joined;
  };

  function noProgressFailure(round: number, count: number): DeveloperResult {
    log(
      `developer 무진척 감지 — 구현 잠금 이후에도 진척 없는 시도(거부된 discovery/PLAN 반복)가 ${count}회 계속됨(라운드 ${round}/${MAX_INTERNAL_ROUNDS}) — 조기 종료`
    );
    return {
      success: false,
      summary: `구현 단계 전환(잠금) 이후에도 실제 코드 변경 없이 거부된 조사 시도나 반복 PLAN만 ${count}회 계속되어 무진척으로 판단해 조기 종료했습니다.`,
      changedFiles: getActualChangedFiles(changeScopeDirs, executor),
      tests: [],
      rawOutput: "",
      errorCode: "NO_PROGRESS_STAGNATION",
      deferredHumanTasks,
      discoveryProgress: captureDiscoveryProgress(round),
      ...usageFields(),
    };
  }

  // 잠금 전(!implementationLocked) 상태에서만 호출된다(PLAN 또는 READ_FILES/SEARCH-only
  // ACTION_REQUEST 라운드). 예산 소진 시 잠금으로 전환하고 nudge를 transcript에 남긴다 —
  // 이 함수는 실패를 반환하지 않는다(잠금 이후의 무진척 판정은 별도로 lockedNoProgressCount가
  // 담당).
  function advanceDiscoveryBudget(round: number): void {
    discoveryOnlyRoundCount += 1;
    if (discoveryOnlyRoundCount < DISCOVERY_BUDGET_ROUNDS) return;
    implementationLocked = true;
    log(
      `developer discovery 예산 소진 — 구현 단계 전환 안내 전송 및 READ_FILES/SEARCH 잠금(라운드 ${round}/${MAX_INTERNAL_ROUNDS}, discovery-only 누적 ${discoveryOnlyRoundCount}회)`
    );
    transcript.push(NUDGE_MESSAGE);
  }

  // § DeveloperDiscoveryProgress 주석 — fileSnapshots.keys()는 이미 이 attempt가 실제로 읽은
  // 파일의 "경로"만 담고 있다(내용은 별도 Map value). 경로만 뽑아 compact snapshot을 만든다 —
  // 새 추적 구조를 추가하지 않고 이미 있는 fileSnapshots/discoveryOnlyRoundCount/
  // implementationLocked를 그대로 재사용한다.
  function captureDiscoveryProgress(round: number): DeveloperDiscoveryProgress {
    return {
      filesRead: [...fileSnapshots.keys()],
      discoveryOnlyRoundCount,
      implementationLocked,
      lastRoundReached: round,
    };
  }

  for (let round = 1; round <= MAX_INTERNAL_ROUNDS; round++) {
    const abortedBeforeRound = abortedResultIfRequested(round);
    if (abortedBeforeRound) return abortedBeforeRound;
    reportRoundStart(round, implementationLocked ? "LOCKED" : "DISCOVERY");
    const transcriptEntryCountBeforeCap = transcript.length;
    const input = capTranscript();
    const trimmedThisRound = transcript.length < transcriptEntryCountBeforeCap;
    const contextMetrics = buildDeveloperContextMetrics({
      attempt,
      round,
      systemPromptChars: systemPrompt.length,
      transcriptInput: input,
      transcriptEntryCount: transcript.length,
      fileSnapshots,
      duplicateReadCount,
      trimmedThisRound,
    });
    log("developer context 계측(round 직전)", contextMetrics as unknown as Record<string, unknown>);
    if (opts.onContextMetrics) {
      try {
        opts.onContextMetrics(contextMetrics);
      } catch (e) {
        log("onContextMetrics 콜백 실패(무시하고 계속 진행)", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    let claudeRaw = await claudeCall(input, timeoutMs);

    // USAGE_LIMIT은 일시정지다 — 같은 라운드/같은 input(transcript)으로 재시도한다. round
    // 카운터를 증가시키지 않고, transcript/discoveryOnlyRoundCount/lockedNoProgressCount/
    // implementationLocked/planUsedInLock/codeChangeHappened 중 아무것도 건드리지 않는다.
    let usageLimitRetries = 0;
    while (!claudeRaw.success && claudeRaw.errorCode === "USAGE_LIMIT") {
      if (usageLimitRetries >= usageLimitMaxRetries) {
        log(
          `developer USAGE_LIMIT 재시도 ${usageLimitMaxRetries}회 초과(라운드 ${round}는 소비되지 않음, transcript 보존) — 사람 확인 필요`
        );
        return {
          success: false,
          summary: claudeRaw.summary,
          changedFiles: getActualChangedFiles(changeScopeDirs, executor),
          tests: [],
          rawOutput: claudeRaw.rawOutput,
          errorCode: "USAGE_LIMIT",
          deferredHumanTasks,
          discoveryProgress: captureDiscoveryProgress(round),
          ...usageFields(),
        };
      }
      usageLimitRetries += 1;
      log(
        `developer Claude 사용량 제한 감지 — round/discovery budget/lock grace 소비 없이 ${usageLimitWaitMs}ms 대기 후 같은 라운드(${round}) 재시도 (${usageLimitRetries}/${usageLimitMaxRetries})`
      );
      const waitInfo = { round, retryCount: usageLimitRetries, waitMs: usageLimitWaitMs } as const;
      if (opts.onUsageLimitWait) {
        try {
          opts.onUsageLimitWait({ ...waitInfo, phase: "START" });
        } catch (e) {
          log("onUsageLimitWait(START) 콜백 실패(무시하고 계속 진행)", { error: e instanceof Error ? e.message : String(e) });
        }
      }
      await sleepFn(usageLimitWaitMs);
      if (opts.onUsageLimitWait) {
        try {
          opts.onUsageLimitWait({ ...waitInfo, phase: "END" });
        } catch (e) {
          log("onUsageLimitWait(END) 콜백 실패(무시하고 계속 진행)", { error: e instanceof Error ? e.message : String(e) });
        }
      }
      claudeRaw = await claudeCall(input, timeoutMs); // 같은 input = 같은 transcript 상태 그대로 재요청
    }

    // claudeRaw가 실제로 성공한 경우에만 model/tokenUsage가 채워져 있다(§ claude-runner.ts) —
    // 실패 결과는 그대로 무시된다(추정하지 않는다).
    accumulateUsage(claudeRaw);

    if (!claudeRaw.success) {
      log(`developer 라운드 ${round} Claude 호출 실패(${claudeRaw.errorCode})`);
      return {
        success: false,
        summary: claudeRaw.summary,
        changedFiles: getActualChangedFiles(changeScopeDirs, executor),
        tests: [],
        rawOutput: claudeRaw.rawOutput,
        errorCode: claudeRaw.errorCode,
        deferredHumanTasks,
        discoveryProgress: captureDiscoveryProgress(round),
        ...usageFields(),
      };
    }

    let parsed = tryParseProtocolJson(claudeRaw.summary);
    let recoveredThisRound = false;
    if (parsed) {
      // CLI 프로세스 성공(claudeRaw.success)과 개발 응답 유효성은 별개다 — JSON은 파싱됐지만
      // 알려진 3개 타입/shape와 정확히 일치하지 않으면, 추가 Claude 호출 없이 로컬에서 먼저
      // 복구를 시도한다(§ PROTOCOL_FAILURE_HARD_STOP 상단 주석).
      const isRecognizedShape =
        parsed.type === "TASK_COMPLETE" ||
        parsed.type === "PLAN" ||
        (parsed.type === "ACTION_REQUEST" && Array.isArray(parsed.actions));
      if (!isRecognizedShape) {
        const recovered = attemptLocalProtocolRecovery(parsed);
        if (recovered) {
          log(`developer 라운드 ${round} 응답 해석: 형식 이상 감지 → 로컬 복구 성공(추가 Claude 호출 없음)`);
          parsed = recovered;
          recoveredThisRound = true;
        }
      }
    }

    const dispatchable =
      !!parsed &&
      (parsed.type === "TASK_COMPLETE" ||
        parsed.type === "PLAN" ||
        (parsed.type === "ACTION_REQUEST" && Array.isArray(parsed.actions)));

    // § DeveloperCallStats 상단 주석 — USAGE_LIMIT 재시도는 위에서 이미 별도로 처리되고
    // 여기 도달하지 않으므로(같은 round를 다시 요청) 여기 도달한 시점이 곧 "실제로 한 번의
    // 응답을 받아 해석을 시도한 라운드"다.
    totalRounds += 1;
    if (dispatchable) {
      validResponseRounds += 1;
      if (recoveredThisRound) localRecoverySuccessRounds += 1;
    } else {
      protocolFailureRounds += 1;
    }

    if (dispatchable) {
      // 유효한 개발 응답을 실제로 받았다 — 이전에 이어지던 응답 해석 실패 연쇄를 끊는다.
      consecutiveProtocolFailureCount = 0;
      lastProtocolFailureFingerprint = undefined;
    } else {
      const kind = parsed ? "UNRECOGNIZED_SHAPE" : "NOT_JSON";
      const shapeDescriptor = describeUnrecognizedShape(parsed);
      const fingerprint = computeProtocolFailureFingerprint(
        implementationLocked ? "LOCKED" : "DISCOVERY",
        kind,
        shapeDescriptor,
        claudeRaw.summary.length
      );

      if (fingerprint === lastProtocolFailureFingerprint) {
        consecutiveProtocolFailureCount += 1;
      } else {
        consecutiveProtocolFailureCount = 1;
        lastProtocolFailureFingerprint = fingerprint;
        reinforcementSentForFingerprint = undefined;
      }

      log(
        `developer 라운드 ${round} 응답 해석 실패 — CLI 프로세스: 정상, 응답 수신: 정상, 응답 해석: 실패` +
          `(${kind}, shape=${shapeDescriptor}, 동일 지문 연속 ${consecutiveProtocolFailureCount}회, fingerprint=${fingerprint})`
      );

      if (consecutiveProtocolFailureCount >= PROTOCOL_FAILURE_HARD_STOP) {
        log(
          `developer 응답 해석 실패가 동일 패턴(fingerprint=${fingerprint})으로 ${consecutiveProtocolFailureCount}회 연속 반복 — ` +
            `동일 방식 재호출을 중단하고 PROTOCOL_ERROR로 종료합니다(라운드 ${round}/${MAX_INTERNAL_ROUNDS})`
        );
        return {
          success: false,
          summary: `Claude 응답을 동일한 방식(${kind})으로 ${consecutiveProtocolFailureCount}회 연속 해석하지 못해 재호출을 중단했습니다.`,
          changedFiles: getActualChangedFiles(changeScopeDirs, executor),
          tests: [],
          rawOutput: "",
          errorCode: "PROTOCOL_ERROR",
          protocolFailureFingerprint: fingerprint,
          deferredHumanTasks: [
            ...deferredHumanTasks,
            `PROTOCOL_ERROR: 동일한 응답 해석 실패(${kind}, shape=${shapeDescriptor})가 ${consecutiveProtocolFailureCount}회 연속 반복되어 재호출을 중단했습니다.`,
          ],
          discoveryProgress: captureDiscoveryProgress(round),
          ...usageFields(),
        };
      }

      if (consecutiveProtocolFailureCount === 2 && reinforcementSentForFingerprint !== fingerprint) {
        reinforcementSentForFingerprint = fingerprint;
        transcript.push(RESPONSE_CONTRACT_REINFORCEMENT_MESSAGE);
      } else if (kind === "NOT_JSON") {
        transcript.push(
          `# Round ${round} 오류\n응답이 JSON이 아닙니다. 코드펜스나 설명 텍스트 없이 ACTION_REQUEST 또는 TASK_COMPLETE JSON 객체 하나만 출력하세요.`
        );
      } else {
        transcript.push(`# Round ${round} 오류\n알 수 없는 응답 형식입니다. ACTION_REQUEST 또는 TASK_COMPLETE만 허용됩니다.`);
      }
      continue;
    }

    // dispatchable===true를 계산한 시점에 이미 !!parsed를 확인했다 — TypeScript narrowing용.
    if (!parsed) continue;

    if (parsed.type === "TASK_COMPLETE") {
      const summary = typeof parsed.summary === "string" ? parsed.summary : "(summary 없음)";
      // AutoDev / JARVIS Unattended Continuous Development Reliability Hardening Phase 5 —
      // required test npm script가 아직 package.json에 등록돼 있지 않더라도, 방금 이
      // attempt에서 Claude가 만든(§ opts.allowedPathPrefixes 범위) *.test.mjs 후보가 정확히
      // 하나로 확정되면 여기서 즉시 등록하고 별도 commit으로 확정한다(§
      // required-test-preflight.ts checkRequiredTestScriptRegistration/
      // attemptSafeRequiredTestScriptRepair/commitRequiredTestScriptRepair — 판정/복구
      // 로직을 복제하지 않고 그대로 재사용한다). 이 자체 복구는 TASK_COMPLETE를 선언한 이
      // 라운드 안에서 조용히 일어나므로 새로운 REVISE 라운드를 소비하지 않는다. 후보가
      // 아직 없거나(파일을 만들지 않음) 모호하면(여러 개) 여기서는 아무것도 등록하지 않고
      // 그대로 넘어간다 — 아래 runRequiredTests()가 실제 npm 실행 결과(예: "Missing
      // script")를 그대로 tests[].failureEvidence에 남기고, 그 실패는 기존 GPT Reviewer
      // REVISE 루프가 일반 구현 미완료와 동일하게 처리한다(§ 새 사람 대기 경로를 만들지
      // 않는다 — autodev.ts REQUIRED_TEST_CONFIGURATION_ERROR 처리와 동일한 원칙).
      const changedFilesForTaskComplete = getActualChangedFiles(changeScopeDirs, executor);
      let requiredTestRegistrationDrift = false;
      if (executor?.projectRoot && opts.allowedPathPrefixes && opts.allowedPathPrefixes.length > 0) {
        // Phase 8 — Developer가 명시적으로 선언한 registration 요청(있으면)을 먼저 검증/등록한다.
        // Developer는 package.json을 직접 쓸 권한이 없다 — 이 함수가 엄격히 검증한 요청만
        // AutoDev infrastructure가 등록한다(§ required-test-preflight.ts
        // validateRequiredTestRegistrationRequest).
        const rawRegistrations = (parsed as { requiredTestRegistrations?: unknown }).requiredTestRegistrations;
        if (Array.isArray(rawRegistrations) && rawRegistrations.length > 0) {
          const requests: RequiredTestRegistrationRequest[] = rawRegistrations
            .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
            .map((r) => ({
              scriptName: typeof r.scriptName === "string" ? r.scriptName : "",
              runner: typeof r.runner === "string" ? r.runner : "",
              target: typeof r.target === "string" ? r.target : "",
            }));
          const registration = registerValidatedRequiredTestScripts(
            requests,
            opts.requiredTests,
            opts.allowedPathPrefixes,
            executor.projectRoot,
            changedFilesForTaskComplete
          );
          requiredTestRegistrationDrift = registration.outcomes.some((o) => o.outcome === "DRIFT");
          if (registration.outcomes.length > 0) {
            log("developer TASK_COMPLETE — required test registration 요청 처리", { outcomes: registration.outcomes });
          }
          if (registration.toCommit.length > 0) {
            const commit = commitRequiredTestRegistration(executor.projectRoot, registration.toCommit);
            if (!commit.ok) {
              log("developer TASK_COMPLETE — required test registration commit 실패(package.json은 등록된 채로 남음, 다음 attempt가 재시도할 수 있음)", {
                reason: commit.reason,
              });
            }
          }
        }

        const requiredTestPreflight = checkRequiredTestScriptRegistration(opts.requiredTests, executor.projectRoot);
        if (!requiredTestPreflight.ok) {
          const repair = attemptSafeRequiredTestScriptRepair(requiredTestPreflight.issues, executor.projectRoot, opts.allowedPathPrefixes);
          if (repair.repaired.length > 0) {
            const commit = commitRequiredTestScriptRepair(executor.projectRoot, repair.repaired);
            if (commit.ok) {
              log("developer TASK_COMPLETE — required test npm script 자체 복구", {
                repaired: repair.repaired.map((r) => ({ npmScript: r.npmScript, expectedScript: r.expectedScript })),
                commitHash: commit.commitHash,
              });
            } else {
              log("developer TASK_COMPLETE — required test npm script 자체 복구 commit 실패(package.json은 등록된 채로 남음, 다음 attempt가 재시도할 수 있음)", {
                reason: commit.reason,
              });
            }
          }
        }
      }
      // Claude의 자체 보고를 신뢰하지 않는다 — task-registry에 지정된 필수 테스트만
      // AutoDev(Safe Executor)가 직접 실행해 실제 exitCode로 결과를 만든다(§ 요구사항 6).
      const tests = await runRequiredTests(opts.requiredTests, executor);
      return {
        success: true,
        summary,
        changedFiles: changedFilesForTaskComplete,
        tests,
        rawOutput: sanitizeForLog(claudeRaw.summary),
        deferredHumanTasks,
        ...(requiredTestRegistrationDrift ? { requiredTestRegistrationDrift: true } : {}),
        ...usageFields(),
      };
    }

    // PLAN — 선택적 중간 산출물. 실제 코드 변경(codeChangeHappened)으로 치지는 않는다.
    if (parsed.type === "PLAN") {
      const planSummary = typeof parsed.summary === "string" ? parsed.summary : "(PLAN summary 없음)";
      log(`developer 라운드 ${round} PLAN 수신`);

      if (codeChangeHappened) {
        transcript.push(`# Round ${round} PLAN\n${planSummary}`);
        continue;
      }

      if (implementationLocked) {
        if (!planUsedInLock) {
          // 구현 전환용 PLAN 1회 한도 — 정상 처리하되 무진척 카운트에도 반영한다(PLAN만
          // 반복해도 grace를 무한정 소모할 수는 없다).
          planUsedInLock = true;
          transcript.push(`# Round ${round} PLAN\n${planSummary}`);
        } else {
          log(`developer 라운드 ${round} PLAN 반복 — 잠금 중 1회 한도 초과, protocol rejection`);
          transcript.push(`# Round ${round} PLAN 요청\n${planSummary}`);
          transcript.push(`# Round ${round} 오류\n${PLAN_LOCK_REPEAT_MESSAGE}`);
        }
        lockedNoProgressCount += 1;
        if (lockedNoProgressCount >= IMPLEMENTATION_LOCK_GRACE) return noProgressFailure(round, lockedNoProgressCount);
        continue;
      }

      // !implementationLocked (아직 DISCOVERY)
      transcript.push(`# Round ${round} PLAN\n${planSummary}`);
      advanceDiscoveryBudget(round);
      continue;
    }

    if (parsed.type === "ACTION_REQUEST" && Array.isArray(parsed.actions)) {
      const roundActions = parsed.actions as ExecutorAction[];
      // novel 여부는 보지 않는다 — READ_FILES/SEARCH만 있는 라운드는 이미 본 파일이든 새
      // 파일이든 동일하게 취급한다(§ 상단 주석, 실제 E2E 실패 사후 반영).
      const isDiscoveryOnlyRound = roundActions.every((a) => a.type === "READ_FILES" || a.type === "SEARCH");

      if (!codeChangeHappened && implementationLocked && isDiscoveryOnlyRound) {
        // 구현 잠금 상태 — Safe Executor를 아예 호출하지 않는다(실제 read/search를 실행하지
        // 않고 protocol-level rejection만 transcript에 남긴다).
        log(`developer 라운드 ${round} — 구현 잠금 중 READ_FILES/SEARCH-only 요청 실행 거부(protocol rejection)`);
        transcript.push(`# Round ${round} 요청\n${JSON.stringify(parsed)}`);
        transcript.push(`# Round ${round} 결과\n${DISCOVERY_REJECTION_MESSAGE}`);
        lockedNoProgressCount += 1;
        if (lockedNoProgressCount >= IMPLEMENTATION_LOCK_GRACE) return noProgressFailure(round, lockedNoProgressCount);
        continue;
      }

      const roundResults: unknown[] = [];
      for (const rawAction of roundActions) {
        // Phase 6 — WRITE_FILE/APPLY_PATCH가 이 task의 allowedPathPrefixes 밖을 가리키면
        // Safe Executor를 호출하기 전에 여기서 막는다(§ isPathWithinAllowedPrefixes 상단
        // 주석). opts.allowedPathPrefixes가 지정되지 않은 호출부(기존 테스트 등)는 이 검사
        // 자체가 no-op이라 기존 동작이 100% 보존된다.
        if (
          opts.allowedPathPrefixes &&
          opts.allowedPathPrefixes.length > 0 &&
          (rawAction.type === "WRITE_FILE" || rawAction.type === "APPLY_PATCH") &&
          !isPathWithinAllowedPrefixes(rawAction.path, opts.allowedPathPrefixes)
        ) {
          const denyReason = `이 task에 허용된 경로(${opts.allowedPathPrefixes.join(", ")}) 밖입니다: "${rawAction.path}". 반드시 허용된 경로 안에 파일을 작성/수정하세요.`;
          log(`developer 라운드 ${round} — task scope 밖 ${rawAction.type} 거부(Safe Executor 호출 전 차단)`, {
            path: rawAction.path,
            allowedPathPrefixes: opts.allowedPathPrefixes,
          });
          const key = actionKey(rawAction);
          const count = (forbiddenRepeatCount.get(key) ?? 0) + 1;
          forbiddenRepeatCount.set(key, count);
          const deniedResult = { ok: false, action: rawAction.type, denyReason };
          if (count >= FORBIDDEN_REPEAT_LIMIT) {
            deferredHumanTasks.push(`반복 거부(${count}회): ${key} — ${denyReason}`);
            roundResults.push({ ...deniedResult, deferred: true, note: "3회 이상 거부됨 — 사람 검토로 넘겨짐, 다른 접근 필요" });
          } else {
            roundResults.push(deniedResult);
          }
          continue;
        }
        const result = await doValidateAndExecute(rawAction);
        if (!result.ok) {
          const key = actionKey(rawAction);
          const count = (forbiddenRepeatCount.get(key) ?? 0) + 1;
          forbiddenRepeatCount.set(key, count);
          if (count >= FORBIDDEN_REPEAT_LIMIT) {
            deferredHumanTasks.push(`반복 거부(${count}회): ${key} — ${result.denyReason}`);
            roundResults.push({ ...result, deferred: true, note: "3회 이상 거부됨 — 사람 검토로 넘겨짐, 다른 접근 필요" });
            continue;
          }
        } else if (rawAction.type === "WRITE_FILE" || rawAction.type === "APPLY_PATCH") {
          codeChangeHappened = true;
        }
        // 2026-08-29(transcript 중복 제거) — READ_FILES가 성공하면 실제 파일 내용은
        // fileSnapshots에만 최신 상태로 보관하고, 이 round 자신의 "결과" 항목에는 어떤
        // 경로를 읽었는지와 전용 snapshot 항목을 보라는 안내만 남긴다. 다른 action
        // 타입(WRITE_FILE/APPLY_PATCH/SEARCH/RUN_COMMAND)의 result는 기존과 완전히 동일하게
        // 그대로 담는다 — 이 dedup은 READ_FILES 전용이다.
        if (result.ok && rawAction.type === "READ_FILES" && (result as { action?: string }).action === "READ_FILES") {
          const data = (result as { data?: unknown }).data;
          if (data && typeof data === "object" && !Array.isArray(data)) {
            const dataMap = data as Record<string, string>;
            const justReadPaths = new Set<string>();
            for (const [relPath, content] of Object.entries(dataMap)) {
              if (typeof content !== "string") continue;
              if (fileSnapshots.has(relPath)) duplicateReadCount += 1;
              fileSnapshots.set(relPath, content);
              fileSnapshotLastReadRound.set(relPath, round);
              justReadPaths.add(relPath);
            }
            enforceFileSnapshotsCap(round, justReadPaths);
            roundResults.push({
              ok: true,
              action: "READ_FILES",
              paths: Object.keys(dataMap),
              note: "전체 내용은 이 transcript의 '# 현재 파일 snapshot' 섹션에서 항상 최신 상태로 확인하세요(중복 방지를 위해 여기서는 생략됨).",
            });
            continue;
          }
        }
        roundResults.push(result);
      }
      transcript.push(`# Round ${round} 요청\n${JSON.stringify(parsed)}`);
      transcript.push(`# Round ${round} 결과\n${sanitizeForLog(JSON.stringify(roundResults))}`);

      if (fileSnapshots.size > 0) {
        // 파일 경로 오름차순 정렬 — 매번 같은 순서라 diff/캐시 안정성에도 도움이 된다.
        const sortedPaths = [...fileSnapshots.keys()].sort();
        const snapshotText = sanitizeForLog(
          `# 현재 파일 snapshot(각 파일당 가장 최근에 읽은 내용 하나만 — 과거 read 중복 없음)\n\n` +
            sortedPaths.map((p) => `## ${p}\n${fileSnapshots.get(p)}`).join("\n\n")
        );
        if (fileSnapshotEntryIndex === undefined) {
          transcript.push(snapshotText);
          fileSnapshotEntryIndex = transcript.length - 1;
        } else {
          transcript[fileSnapshotEntryIndex] = snapshotText;
        }
      }

      if (!codeChangeHappened && !implementationLocked && isDiscoveryOnlyRound) {
        advanceDiscoveryBudget(round);
      }
      continue;
    }

    // dispatchable 판정에서 TASK_COMPLETE/PLAN/ACTION_REQUEST(배열 actions) 중 하나가 이미
    // 보장됐고 위 세 분기가 각각 return/continue로 끝나므로 이 지점에는 도달하지 않는다.
  }

  return {
    success: false,
    summary: `내부 라운드 ${MAX_INTERNAL_ROUNDS}회를 초과했습니다.`,
    changedFiles: getActualChangedFiles(changeScopeDirs, executor),
    tests: [],
    rawOutput: "",
    errorCode: "TASK_ACTION_LIMIT",
    deferredHumanTasks,
    discoveryProgress: captureDiscoveryProgress(MAX_INTERNAL_ROUNDS),
    ...usageFields(),
  };
}

// initial attempt + 재시도 2회 = 총 3회(§ 요구사항 B "initial attempt / automatic retry #1 /
// automatic retry #2"). 무한 재시도가 아니다 — 3회 모두 같은 종류의 transient 실패면 아래
// exhausted 분기가 즉시 반환한다(추가 대기/재시도 없음).
const DEVELOPER_TRANSIENT_MAX_ATTEMPTS = 3;
// 1차 실패→15초, 2차 실패→30초 대기 후 재시도(gpt-reviewer.ts reviewClaudeResultWithRetry의
// RETRY_WAITS_MS와 동일한 관례 — 점진적으로 늘어나는 짧은 대기).
const DEVELOPER_TRANSIENT_RETRY_WAITS_MS = [15_000, 30_000];

export interface DeveloperRetryDeps {
  /** 테스트 전용 override — 기본은 항상 실제 runDeveloperTaskViaSafeExecutor. */
  attempt?: (task: string, attempt: number, opts?: DeveloperTaskOptions) => Promise<DeveloperResult>;
  /** 테스트 전용 override — 기본은 항상 실제 setTimeout 기반 대기. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * runDeveloperTaskViaSafeExecutor()를 감싸 TIMEOUT/CLI_NOT_FOUND처럼 명확히 일시적인 실패에
 * 대해서만 짧게 재시도한다(§ isTransientDeveloperFailure) — orchestrator.ts는 이 함수가 반환한
 * 최종 DeveloperResult 하나만 보므로, 재시도는 orchestrator 입장에서 완전히 투명하다(GPT
 * reviewer 쪽 reviewClaudeResultWithRetry와 동일한 설계, § gpt-reviewer.ts). 재시도마다
 * attempt()를 처음부터 다시 호출하므로 매 시도는 새 transcript로 시작하는 완전히 새로운
 * stateless 호출이다(기존 --no-session-persistence 정책 그대로 유지 — 세션을 이어붙이지
 * 않는다). 3회 모두 같은 종류의 transient 실패로 끝나면, 마지막 결과를 그대로 반환하되
 * summary/deferredHumanTasks에 "반복된 일시적 실패로 사람 확인이 필요하다"는 사유를 명시적으로
 * 남긴다 — orchestrator.ts는 이미 DeveloperResult.deferredHumanTasks를 성공/실패와 무관하게
 * state.deferredHumanTasks에 병합하므로(§ orchestrator.ts claudeDeferred), 이 함수는
 * orchestrator.ts/autodev.ts를 전혀 건드리지 않고도 WAITING_HUMAN 전환 시 그 사유가 승인
 * 기록/Telegram 알림에 그대로 드러나게 한다.
 */
export async function runDeveloperTaskWithRetry(
  task: string,
  attempt: number,
  opts: DeveloperTaskOptions = {},
  retryDeps: DeveloperRetryDeps = {}
): Promise<DeveloperResult> {
  const attemptFn = retryDeps.attempt ?? runDeveloperTaskViaSafeExecutor;
  const sleep = retryDeps.sleep ?? defaultDeveloperSleep;

  let last: DeveloperResult | undefined;
  // AutoDev Core Maintenance — Progress Transfer Gap 재하드닝(2026-08-31, JARVIS Task 5.3
  // 실측 — "저장은 됐는데 다음 재시도에 전달 안 됨"이 정확히 이 3회 내부 루프 사이에서
  // 발생함을 코드+로그로 확정). 이 loop는 원래 매 iteration마다 동일한 opts 객체를 그대로
  // 재사용해, sub-attempt 1이 남긴 discoveryProgress가 sub-attempt 2에, 2가 남긴 것이
  // 3에 전혀 전달되지 않았다 — 매번 discoveryOnlyRoundCount가 0부터, transcript가 빈
  // 상태부터 다시 시작해 동일한 discovery를 반복했다. currentOpts는 실패할 때마다 그
  // 직전 sub-attempt 자신의 discoveryProgress(TIMEOUT을 포함한 모든 실패 경로에서 이미
  // captureDiscoveryProgress()로 채워져 있다)로 갱신된다 — durable retry 간에는 이미
  // autodev.ts가 동일한 원칙(priorDiscoveryProgress 이어받기 + 힌트 텍스트)을 적용하고
  // 있었다(§ buildDiscoveryProgressRetryHint 주석) — 여기서는 같은 durable attempt 안의
  // 더 짧은 내부 재시도 사이에도 그 원칙을 그대로 적용할 뿐, 새 저장 구조를 만들지 않는다.
  let currentOpts = opts;
  // AutoDev Core Maintenance — TIMEOUT-only/WRITE-zero 전략 사각지대 재하드닝(2026-08-31,
  // JARVIS Task 5.3 실측). opts.priorNoWriteRepeatCount로 durable(이전 attempt들에 걸친)
  // 연속 실패 횟수를 이어받아, 같은 durable attempt 안의 내부 재시도까지 하나의 연속된
  // 카운트로 취급한다 — 실제 WRITE가 성공하면(changedFiles.length>0) 즉시 0으로 리셋된다.
  let consecutiveNoWriteFailures = opts.priorNoWriteRepeatCount ?? 0;
  for (let i = 0; i < DEVELOPER_TRANSIENT_MAX_ATTEMPTS; i++) {
    const result = await attemptFn(task, attempt, currentOpts);
    last = result;
    if (!isTransientDeveloperFailure(result)) return result;
    log(`developer transient 실패(${result.errorCode}) — 시도 ${i + 1}/${DEVELOPER_TRANSIENT_MAX_ATTEMPTS} 실패, 재시도 예정`);
    consecutiveNoWriteFailures = result.changedFiles.length === 0 ? consecutiveNoWriteFailures + 1 : 0;
    const strategyHint = buildNoWriteStrategyEscalationHint(consecutiveNoWriteFailures);
    if (result.discoveryProgress && (result.discoveryProgress.filesRead.length > 0 || result.discoveryProgress.implementationLocked)) {
      const discoveryHint = buildDiscoveryProgressRetryHint(result.discoveryProgress, result.errorCode);
      currentOpts = {
        ...currentOpts,
        priorDiscoveryProgress: result.discoveryProgress,
        memoryHint: [currentOpts.memoryHint, discoveryHint, strategyHint]
          .filter((s): s is string => Boolean(s))
          .join("\n\n"),
      };
    } else if (strategyHint) {
      currentOpts = {
        ...currentOpts,
        memoryHint: [currentOpts.memoryHint, strategyHint].filter((s): s is string => Boolean(s)).join("\n\n"),
      };
    }
    // AutoDev Core Maintenance — Canonical Stop Path(2026-08-31). 이 짧은 재시도 대기
    // (15s/30s) 중에 abortSignal이 발동하면 남은 대기를 즉시 끝낸다 — 다음 attemptFn() 호출은
    // opts.abortSignal.aborted를 즉시 확인해(§ runDeveloperTaskViaSafeExecutor
    // abortedResultIfRequested) ABORTED를 반환하고, isTransientDeveloperFailure가 false라
    // 더 이상 재시도하지 않는다. sleep()은 여전히 실제 대기시간 그대로 호출한다(§ 기존
    // retryDeps.sleep 테스트 override의 호출 횟수/인자 계약을 그대로 보존) — abortSignal이
    // 있으면 그 호출을 abort event와 경합시켜 먼저 끝나는 쪽을 기다릴 뿐이다.
    if (i < DEVELOPER_TRANSIENT_MAX_ATTEMPTS - 1) {
      const waitMs = DEVELOPER_TRANSIENT_RETRY_WAITS_MS[i];
      if (opts.abortSignal) {
        await Promise.race([
          sleep(waitMs),
          new Promise<void>((resolve) => {
            if (opts.abortSignal!.aborted) resolve();
            else opts.abortSignal!.addEventListener("abort", () => resolve(), { once: true });
          }),
        ]);
      } else {
        await sleep(waitMs);
      }
    }
  }

  const exhausted = last as DeveloperResult;
  log(
    `developer transient 재시도 소진(${DEVELOPER_TRANSIENT_MAX_ATTEMPTS}회, 마지막 오류=${exhausted.errorCode}) — orchestrator의 durable provider wait으로 넘어갑니다`
  );
  return {
    ...exhausted,
    summary: `Claude Developer가 ${DEVELOPER_TRANSIENT_MAX_ATTEMPTS}회 연속 일시적 오류(${exhausted.errorCode})로 실패했습니다 — 마지막 오류: ${exhausted.summary}`,
    deferredHumanTasks: [
      ...(exhausted.deferredHumanTasks ?? []),
      `${DEVELOPER_TRANSIENT_RETRY_EXHAUSTED_PREFIX}${exhausted.errorCode}): Claude Developer가 ${DEVELOPER_TRANSIENT_MAX_ATTEMPTS}회 연속 일시적 오류로 응답하지 못했습니다.`,
    ],
    noWriteRepeatCount: consecutiveNoWriteFailures,
  };
}

// AutoDev / JARVIS 신뢰성 보완 — Claude Developer Timeout Durable Retry(2026-08-27 후속).
// 이 prefix는 orchestrator.ts(진짜 사람 판단 전에 durable provider wait으로 먼저 흡수)와
// human-gate-policy.ts(같은 마커가 저장된 stale WAITING_HUMAN을 자동 복구 대상으로 분류)가
// 그대로 재사용하는 단일 출처다 — 문자열을 복제하지 않는다.
export const DEVELOPER_TRANSIENT_RETRY_EXHAUSTED_PREFIX = "DEVELOPER_TRANSIENT_RETRY_EXHAUSTED(";
