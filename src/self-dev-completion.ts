import { createHash } from "node:crypto";
import type { EventStore } from "./event-store";
import { ensureTelegramControllerStarted } from "./telegram-controller-supervisor";
import type { ProjectManifest } from "./project-manifest";
import { log } from "./logger";

// Self-Dev Task Completion Bridge — 공유 판정/기록 서비스(Phase G Task G7.2.1).
//
// AutoDev 저장소 자체를 Claude Code 세션으로 개발하는 동안("production AutoDev runtime을
// 실제로 돌리는 것"과는 별개)에도, 이미 갖춰진 production notification 경로(EventStore →
// notification-service.ts → NotificationStore/dedupe → telegram-controller.ts → Telegram
// Provider)를 그대로 재사용해 Task 완료를 Telegram으로 받는다. 이 파일은 "완료 evidence가
// 유효한가"와 "TASK_COMPLETED event를 어떻게 정확히 1회 기록하고 전달을 시도하는가"의 단일
// 출처다 — notify-task-completed.ts(사람이 명시적으로 실행하는 CLI, evidence를 flag로
// 주장)와 self-dev-complete.ts(Claude/Skill이 호출하는 자동 경로, evidence를 이 저장소를
// 대상으로 직접 재실행해 결정론적으로 만든다) 둘 다 이 파일의 세 함수(
// validateSelfDevCompletionEvidence/recordSelfDevTaskCompleted/
// deliverSelfDevCompletionNotification)만 호출한다 — "CLI와 자동 경로가 서로 다른 완료
// 판정 기준을 가지면 안 된다"는 요구사항을 이 단일 출처로 만족시킨다.
//
// "Claude Code 세션 종료 = Task 완료"가 아니다 — 이 서비스는 evidence가 명시적으로 모두
// 충족됐다고 확인됐을 때만(각 필드가 실제로 유효할 때만) TASK_COMPLETED를 기록한다.
// 하나라도 빠지거나 형식이 이상하면 즉시 실패하고 아무 event도 만들지 않는다(추측/생략
// 금지, fail-closed). FAILED/WAITING_HUMAN/BLOCKED/중간 checkpoint에는 이 서비스를 쓰지
// 않는다 — 그런 상태에는 이미 같은 파이프라인에 연결된 기존 notification type
// (HUMAN_APPROVAL_REQUIRED/RUN_BLOCKED/SECURITY_BLOCKED 등, § notification.ts)이 있고,
// 그 event들은 production 코드 경로(autodev.ts/orchestrator.ts)에서만 기록된다 — 이
// 서비스가 그 판정을 대신하지 않는다.
//
// projectId는 의도적으로 대상 project manifest의 projectId(예: "movan")를 쓰지 않는다 —
// 이 event는 "AutoDev 저장소 자신의 개발"에 대한 사실이지 대상 project의 production 실행
// 사실이 아니다(AutoDev repo/MOVAN leakage 없음). manifest는 오직 controller singleton을
// 시작하는 데 필요한 GitSafety/cwd 컨텍스트로만 쓰인다.

export const SELF_DEV_PROJECT_ID = "autodev-core-self-dev";

export type SelfDevCompletionSource = "claude-code-self-dev-cli" | "claude-code-self-dev-bridge";

export interface SelfDevCompletionEvidence {
  taskId: string;
  /** 실제 git commit hash(짧은 형식도 허용) — "git commit 성공"의 증거. */
  commitHash: string;
  testsPassed: boolean;
  typecheckPassed: boolean;
  buildPassed: boolean;
  pushRequired: boolean;
  pushPassed: boolean;
  /** 이 evidence를 누가 만들었는지 — CLI(사람이 명시적으로 주장한 flag) vs bridge(이
   *  저장소를 대상으로 직접 재실행/검증한 결과). TASK_COMPLETED event의 metadata.source에
   *  그대로 남아 사후 구분 가능하다. */
  source: SelfDevCompletionSource;
  /**
   * Phase G Task G7.5 — 이 Task가 "하위 Task(🟡)"가 아니라 "상위 Task/Phase의 진짜 최종
   * 완료(✅)"라는 명시적 선언(§ self-dev-begin.ts --final, self-dev-completion-hook.ts가
   * context를 통해 그대로 전달). 기본값 false — 추측하지 않는다(§ 요구사항: 최종 완료
   * 여부를 추측하지 말 것). true라고 해서 검증 요건이 하나라도 완화되지 않는다 — 나머지
   * testsPassed/typecheckPassed/buildPassed/(필요시) pushPassed 조건은 이 값과 무관하게
   * 동일하게 전부 충족해야 한다(§ validateSelfDevCompletionEvidence). 이 값 하나만으로
   * "최종 완료" Telegram이 나가지 않는다 — recordSelfDevTaskCompleted()가 이 값이 true일
   * 때만 buildSelfDevFinalReportSummary()로 최종 보고를 함께 생성해 event에 담고, 그 이후
   * (§ deliverSelfDevCompletionNotification)에만 전달을 시도한다(§ 요구사항 5 순서).
   */
  isFinal: boolean;
}

export interface EvidenceValidationError {
  error: string;
}

// self-dev-task-context.ts(Phase G Task G7.3.1b)도 동일한 taskId 형식을 재검증할 때 이
// 패턴을 그대로 재사용한다 — "무엇이 유효한 taskId인가"의 기준이 두 곳에서 갈라지지 않게
// 한다.
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,40}$/i;
const VALID_SOURCES: ReadonlySet<string> = new Set<SelfDevCompletionSource>([
  "claude-code-self-dev-cli",
  "claude-code-self-dev-bridge",
]);

export function isEvidenceError(
  value: SelfDevCompletionEvidence | EvidenceValidationError
): value is EvidenceValidationError {
  return typeof (value as EvidenceValidationError).error === "string";
}

/**
 * 완료 evidence 후보가 유효한지 판정하는 단일 출처. taskId/commitHash가 잘못된 형식이거나
 * 필수 조건 중 하나라도 명시적으로 true/유효하지 않으면 즉시 { error } 를 반환한다 —
 * "Prompt omission is NOT permission relaxation" 원칙대로, 값이 빠져있는 것과 false인
 * 것을 구분하지 않고 둘 다 실패로 처리한다.
 */
export function validateSelfDevCompletionEvidence(
  candidate: Partial<SelfDevCompletionEvidence>
): SelfDevCompletionEvidence | EvidenceValidationError {
  const taskId = candidate.taskId;
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    return { error: "taskId가 비어있습니다." };
  }
  if (!TASK_ID_PATTERN.test(taskId)) {
    return { error: `taskId 형식이 올바르지 않습니다(영숫자로 시작, 영숫자/._- 만 허용, 1~64자): ${taskId}` };
  }

  const commitHash = candidate.commitHash;
  if (typeof commitHash !== "string" || !COMMIT_HASH_PATTERN.test(commitHash)) {
    return { error: "commitHash가 유효한 git commit hash 형식이 아닙니다(실제 git commit 성공의 증거가 필요합니다)." };
  }

  if (candidate.testsPassed !== true) {
    return { error: "testsPassed가 확인되지 않았습니다(required tests 전체 PASS 필요)." };
  }
  if (candidate.typecheckPassed !== true) {
    return { error: "typecheckPassed가 확인되지 않았습니다(`npx tsc --noEmit` PASS 필요)." };
  }
  if (candidate.buildPassed !== true) {
    return { error: "buildPassed가 확인되지 않았습니다(`npm run build` PASS 필요)." };
  }

  const pushRequired = candidate.pushRequired === true;
  if (pushRequired && candidate.pushPassed !== true) {
    return { error: "push가 필요한 Task인데 push 성공이 확인되지 않았습니다(fast-forward push 성공 필요)." };
  }

  const source = candidate.source;
  if (typeof source !== "string" || !VALID_SOURCES.has(source)) {
    return { error: "evidence source가 유효하지 않습니다." };
  }

  return {
    taskId,
    commitHash,
    testsPassed: true,
    typecheckPassed: true,
    buildPassed: true,
    pushRequired,
    pushPassed: pushRequired ? true : false,
    source: source as SelfDevCompletionSource,
    isFinal: candidate.isFinal === true,
  };
}

/**
 * evidence(이미 재검증을 통과한 값)로부터 결정론적 최종 보고 요약을 만든다 — Claude가
 * 자유 텍스트로 "다 됐습니다"라고 주장하는 것이 아니라, 이 함수가 이미 검증된 필드만
 * 조합해서 만드는 짧은 한 줄 요약이다(§ 요구사항 8 — 최종 완료 여부를 추측하지 않는다).
 * evidence.isFinal이 true일 때만 recordSelfDevTaskCompleted()가 이 값을 호출해 event
 * metadata에 남긴다 — "최종 보고가 생성된 이후에만 최종 Telegram을 보낸다"는 순서(§
 * 요구사항 5)를 이 함수 호출이 recordSelfDevTaskCompleted()(state 기록) 이전에, 그리고
 * deliverSelfDevCompletionNotification()(Telegram 전달) 이전에 이뤄지는 것으로 만족시킨다.
 */
export function buildSelfDevFinalReportSummary(evidence: SelfDevCompletionEvidence): string {
  const parts = [
    `commit ${evidence.commitHash}`,
    "tests/typecheck/build 통과",
    evidence.pushRequired ? "push 반영 확인" : undefined,
  ].filter((p): p is string => Boolean(p));
  return parts.join(", ");
}

/**
 * taskId+commitHash로부터 결정론적 runId를 만든다 — 동일 Task/commit에 대해 completion
 * bridge/CLI가 여러 번 호출돼도(재시도, 중복 호출 등) 항상 같은 runId가 나온다.
 * notification.ts의 dedupeKey(`runId::taskId::type::cycle`)가 이미 이 값을 기준으로
 * dedupe를 보장하므로(§ notification-store.ts), 이 함수 하나가 별도 dedupe 시스템을 새로
 * 만들지 않고도 "동일 Task/commit 중복 호출 → 중복 알림 금지"를 만족시키는 단일 출처다.
 * randomUUID()를 그대로 쓰면(과거 notify-task-completed.ts) 호출마다 runId가 달라져
 * dedupe가 무력화된다는 문제를 해결한다.
 */
export function deriveSelfDevRunId(taskId: string, commitHash: string): string {
  const digest = createHash("sha256").update(`${SELF_DEV_PROJECT_ID}:${taskId}:${commitHash}`).digest("hex");
  return [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16), digest.slice(16, 20), digest.slice(20, 32)].join("-");
}

export interface RecordSelfDevCompletionResult {
  ok: boolean;
  /** true면 이번 호출 이전에 이미 같은 taskId+commitHash로 기록돼 있었다는 뜻이다 — 새
   *  event를 append하지 않았다(§ idempotency). */
  alreadyRecorded: boolean;
  runId: string;
  error?: string;
}

/**
 * EventStore에 TASK_COMPLETED를 기록한다. 같은 taskId+commitHash 조합이 이미
 * SELF_DEV_PROJECT_ID로 기록돼 있으면(= 같은 deriveSelfDevRunId() 결과) 새로 append하지
 * 않고 기존 runId를 그대로 반환한다 — 동일 Task/commit 중복 호출에도 audit event가 여러
 * 번 쌓이지 않는다. 이 사전 조회가 동시 호출(race)로 놓치더라도, 결정론적 runId 덕분에
 * downstream notification-store.ts의 dedupeKey가 동일하므로 중복 Telegram 알림은 여전히
 * 막힌다(2중 방어).
 */
export function recordSelfDevTaskCompleted(
  events: EventStore,
  evidence: SelfDevCompletionEvidence
): RecordSelfDevCompletionResult {
  const runId = deriveSelfDevRunId(evidence.taskId, evidence.commitHash);

  const existing = events
    .query({ taskId: evidence.taskId, eventType: "TASK_COMPLETED" })
    .events.find((e) => e.projectId === SELF_DEV_PROJECT_ID && e.runId === runId);
  if (existing) {
    log("self-dev TASK_COMPLETED event 이미 기록됨 — 중복 append/알림 없이 재사용", {
      taskId: evidence.taskId,
      runId,
    });
    return { ok: true, alreadyRecorded: true, runId };
  }

  // Phase G Task G7.5 — isFinal일 때만(§ 요구사항 5 순서) 최종 보고를 이 시점에 생성해
  // event에 함께 남긴다 — TASK_COMPLETED.metadata.completionScope="FINAL"이 있어야만
  // notification.ts가 이 event를 🟡가 아니라 ✅ FINAL_COMPLETED로 승격한다(§ 그 파일).
  const finalReportSummary = evidence.isFinal ? buildSelfDevFinalReportSummary(evidence) : undefined;

  const appendResult = events.append({
    eventType: "TASK_COMPLETED",
    runId,
    projectId: SELF_DEV_PROJECT_ID,
    taskId: evidence.taskId,
    executionPhase: "state_update",
    outcome: "SUCCESS",
    metadata: {
      commitHash: evidence.commitHash,
      testsPassed: evidence.testsPassed,
      typecheckPassed: evidence.typecheckPassed,
      buildPassed: evidence.buildPassed,
      pushRequired: evidence.pushRequired,
      pushPassed: evidence.pushRequired ? evidence.pushPassed : null,
      source: evidence.source,
      completionScope: evidence.isFinal ? "FINAL" : "SUBTASK",
      ...(finalReportSummary !== undefined ? { finalReportGenerated: true, finalReportSummary } : {}),
    },
  });
  if (!appendResult.ok) {
    return { ok: false, alreadyRecorded: false, runId, error: appendResult.error ?? "unknown" };
  }
  log("self-dev TASK_COMPLETED event 기록됨", { taskId: evidence.taskId, runId });
  return { ok: true, alreadyRecorded: false, runId };
}

/**
 * controller singleton을 확인/시작하고, 이번에 기록한 event가 최소 한 번 전달 시도되도록
 * 짧게 기다린 뒤 정리한다 — notify-task-completed.ts(CLI)와 self-dev-complete.ts(자동
 * bridge)가 이 함수 하나만 공유한다("CLI와 자동 경로가 서로 다른 완료 판정 기준을 가지면
 * 안 된다"는 요구사항을 전달 절차에도 동일하게 적용). Bot Token/Chat ID는 이 함수도 전혀
 * 다루지 않는다 — ensureTelegramControllerStarted()가 그 경계를 그대로 유지한다(§
 * telegram-controller-supervisor.ts).
 */
export async function deliverSelfDevCompletionNotification(manifest: ProjectManifest): Promise<{ delivered: boolean }> {
  const supervisor = await ensureTelegramControllerStarted(manifest);
  const delivered = supervisor.isOwner() ? await supervisor.flushOnce() : true;
  await supervisor.stop();
  return { delivered };
}
