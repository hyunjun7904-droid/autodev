import { createInMemoryEventStore } from "./event-store";
import type { EventStore, AppendResult } from "./event-store";
import {
  SELF_DEV_PROJECT_ID,
  validateSelfDevCompletionEvidence,
  isEvidenceError,
  deriveSelfDevRunId,
  recordSelfDevTaskCompleted,
} from "./self-dev-completion";
import type { SelfDevCompletionEvidence } from "./self-dev-completion";

// Self-Dev Task Completion Bridge — 공유 판정/기록 서비스 테스트(Phase G Task G7.2.1).
// 실제 Claude/GPT 유료 호출, 실제 Telegram 네트워크 전송 없음(전부 in-memory/순수 함수 검증).
// deliverSelfDevCompletionNotification()은 telegram-controller-supervisor.ts(이미
// telegram-controller-supervisor-tests.ts에서 singleton/bounded restart/health를 전부
// 검증한)의 얇은 wrapper일 뿐이라 여기서 그 내부 로직을 다시 검증하지 않는다 — self-dev-complete.ts
// 쪽 통합 시나리오와 실제 live smoke가 그 wiring 자체를 확인한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const VALID_COMMIT = "abc1234";
const VALID_COMMIT_2 = "def5678";

function baseEvidence(overrides: Partial<SelfDevCompletionEvidence> = {}): Partial<SelfDevCompletionEvidence> {
  return {
    taskId: "G7.2.1",
    commitHash: VALID_COMMIT,
    testsPassed: true,
    typecheckPassed: true,
    buildPassed: true,
    pushRequired: false,
    pushPassed: false,
    source: "claude-code-self-dev-bridge",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1) validateSelfDevCompletionEvidence — fail-closed 판정
// ---------------------------------------------------------------------------
function scenarioValidateHappyPath(): void {
  const result = validateSelfDevCompletionEvidence(baseEvidence());
  check("1) 유효한 evidence는 error 없이 통과한다", !isEvidenceError(result));
}

function scenarioValidateRejectsMissingTaskId(): void {
  const result = validateSelfDevCompletionEvidence(baseEvidence({ taskId: undefined }));
  check("2) taskId 없음 → error", isEvidenceError(result));
}

function scenarioValidateRejectsBadTaskIdFormat(): void {
  const result = validateSelfDevCompletionEvidence(baseEvidence({ taskId: "../etc/passwd" }));
  check("3) taskId 형식 위반 → error", isEvidenceError(result));
}

function scenarioValidateRejectsMissingCommit(): void {
  const result = validateSelfDevCompletionEvidence(baseEvidence({ commitHash: undefined }));
  check("4) commitHash 없음(commit 없음) → TASK_COMPLETED 생성 금지(error)", isEvidenceError(result));
}

function scenarioValidateRejectsBadCommitFormat(): void {
  const result = validateSelfDevCompletionEvidence(baseEvidence({ commitHash: "not-a-hash!" }));
  check("5) commitHash 형식 불일치 → TASK_COMPLETED 생성 금지(error)", isEvidenceError(result));
}

function scenarioValidateRejectsTestsFailed(): void {
  const result = validateSelfDevCompletionEvidence(baseEvidence({ testsPassed: false }));
  check("6) testsPassed=false(tests FAIL) → TASK_COMPLETED 생성 금지(error)", isEvidenceError(result));
}

function scenarioValidateRejectsTestsOmitted(): void {
  const { testsPassed, ...rest } = baseEvidence();
  const result = validateSelfDevCompletionEvidence(rest);
  check("7) testsPassed 생략(omission) → 여전히 생성 금지(error, 값 누락과 false를 동일 취급)", isEvidenceError(result));
}

function scenarioValidateRejectsTypecheckFailed(): void {
  const result = validateSelfDevCompletionEvidence(baseEvidence({ typecheckPassed: false }));
  check("8) typecheckPassed=false(typecheck FAIL) → TASK_COMPLETED 생성 금지(error)", isEvidenceError(result));
}

function scenarioValidateRejectsBuildFailed(): void {
  const result = validateSelfDevCompletionEvidence(baseEvidence({ buildPassed: false }));
  check("9) buildPassed=false(build FAIL) → TASK_COMPLETED 생성 금지(error)", isEvidenceError(result));
}

function scenarioValidateRejectsPushRequiredButNotPassed(): void {
  const result = validateSelfDevCompletionEvidence(baseEvidence({ pushRequired: true, pushPassed: false }));
  check("10) push 필요 + push 실패 → TASK_COMPLETED 생성 금지(error)", isEvidenceError(result));
}

function scenarioValidateAllowsPushNotRequired(): void {
  const result = validateSelfDevCompletionEvidence(baseEvidence({ pushRequired: false, pushPassed: false }));
  check("11) push가 필요하지 않은 Task는 pushPassed=false여도 통과한다", !isEvidenceError(result));
}

function scenarioValidateRejectsUnknownSource(): void {
  const result = validateSelfDevCompletionEvidence({ ...baseEvidence(), source: "not-a-real-source" as SelfDevCompletionEvidence["source"] });
  check("12) 알 수 없는 evidence source → error", isEvidenceError(result));
}

// ---------------------------------------------------------------------------
// 2) deriveSelfDevRunId — deterministic runId(idempotency/dedupe의 기반)
// ---------------------------------------------------------------------------
function scenarioRunIdDeterministic(): void {
  const a = deriveSelfDevRunId("G7.2.1", VALID_COMMIT);
  const b = deriveSelfDevRunId("G7.2.1", VALID_COMMIT);
  check("13) 같은 taskId+commitHash → 항상 같은 runId", a === b);
}

function scenarioRunIdDiffersByCommit(): void {
  const a = deriveSelfDevRunId("G7.2.1", VALID_COMMIT);
  const b = deriveSelfDevRunId("G7.2.1", VALID_COMMIT_2);
  check("14) 같은 taskId라도 commitHash가 다르면 runId도 다르다", a !== b);
}

function scenarioRunIdDiffersByTaskId(): void {
  const a = deriveSelfDevRunId("G7.2.1", VALID_COMMIT);
  const b = deriveSelfDevRunId("G7.3", VALID_COMMIT);
  check("15) 같은 commitHash라도 taskId가 다르면 runId도 다르다", a !== b);
}

// ---------------------------------------------------------------------------
// 3) recordSelfDevTaskCompleted — 정확히 1회 기록 + idempotency/dedupe
// ---------------------------------------------------------------------------
function requireValid(candidate: Partial<SelfDevCompletionEvidence>): SelfDevCompletionEvidence {
  const result = validateSelfDevCompletionEvidence(candidate);
  if (isEvidenceError(result)) throw new Error(`fixture evidence가 유효하지 않습니다: ${result.error}`);
  return result;
}

function scenarioRecordExactlyOnce(): void {
  const events = createInMemoryEventStore();
  const evidence = requireValid(baseEvidence({ taskId: "G7.2.1-record-once", commitHash: VALID_COMMIT }));
  const result = recordSelfDevTaskCompleted(events, evidence);

  check("16) 정상 완료 → ok:true, alreadyRecorded:false", result.ok === true && result.alreadyRecorded === false);

  const { events: stored } = events.query({ taskId: evidence.taskId, eventType: "TASK_COMPLETED" });
  check("17) 정상 완료 → 정확히 1건의 TASK_COMPLETED event", stored.length === 1);
  const e = stored[0];
  check("18) event.projectId는 self-dev 전용 상수(대상 프로젝트 projectId 아님, leakage 없음)", e?.projectId === SELF_DEV_PROJECT_ID);
  check("19) event.outcome === SUCCESS", e?.outcome === "SUCCESS");
  check("20) event.runId는 deriveSelfDevRunId 결과와 동일(deterministic)", e?.runId === deriveSelfDevRunId(evidence.taskId, evidence.commitHash));
}

function scenarioRecordIdempotentSameTaskCommit(): void {
  const events = createInMemoryEventStore();
  const evidence = requireValid(baseEvidence({ taskId: "G7.2.1-idempotent", commitHash: VALID_COMMIT }));

  const first = recordSelfDevTaskCompleted(events, evidence);
  const second = recordSelfDevTaskCompleted(events, evidence);

  check("21) 동일 task+commit 재실행 → 두 번째 호출은 alreadyRecorded:true", second.ok === true && second.alreadyRecorded === true);
  check("22) 동일 task+commit 재실행 → runId가 최초 호출과 동일", first.runId === second.runId);

  const { events: stored } = events.query({ taskId: evidence.taskId, eventType: "TASK_COMPLETED" });
  check("23) 동일 task+commit을 두 번 기록해도 event는 여전히 1건뿐(dedupe)", stored.length === 1);
}

function scenarioRecordNewEventForDifferentCommit(): void {
  const events = createInMemoryEventStore();
  const taskId = "G7.2.1-recommit";
  const first = recordSelfDevTaskCompleted(events, requireValid(baseEvidence({ taskId, commitHash: VALID_COMMIT })));
  const second = recordSelfDevTaskCompleted(events, requireValid(baseEvidence({ taskId, commitHash: VALID_COMMIT_2 })));

  check("24) 같은 taskId라도 커밋이 다르면 새 event가 기록된다(alreadyRecorded:false)", second.alreadyRecorded === false);
  check("25) 커밋이 다르면 runId도 다르다(잘못된 dedupe 없음)", first.runId !== second.runId);

  const { events: stored } = events.query({ taskId, eventType: "TASK_COMPLETED" });
  check("26) 서로 다른 커밋 2건 → event 2건", stored.length === 2);
}

function scenarioRecordAppendFailurePropagates(): void {
  const failingStore: EventStore = {
    append(): AppendResult {
      return { ok: false, error: "disk full(fixture)" };
    },
    query() {
      return { events: [], integrityIssues: [] };
    },
  };
  const evidence = requireValid(baseEvidence({ taskId: "G7.2.1-append-fail", commitHash: VALID_COMMIT }));
  const result = recordSelfDevTaskCompleted(failingStore, evidence);
  check("27) EventStore.append 실패 → ok:false, error 전달됨(조용히 성공으로 위장하지 않음)", result.ok === false && result.error === "disk full(fixture)");
}

// ---------------------------------------------------------------------------
// 4) Telegram credential이 completion bridge(evidence/event)에 노출되지 않음
// ---------------------------------------------------------------------------
function scenarioNoTelegramCredentialInEventMetadata(): void {
  const events = createInMemoryEventStore();
  const evidence = requireValid(baseEvidence({ taskId: "G7.2.1-no-secret", commitHash: VALID_COMMIT }));
  recordSelfDevTaskCompleted(events, evidence);

  const { events: stored } = events.query({ taskId: evidence.taskId, eventType: "TASK_COMPLETED" });
  const serialized = JSON.stringify(stored);
  const noTokenLeak = !/BOT_TOKEN|CHAT_ID|telegram/i.test(serialized);

  const metadata = (stored[0]?.metadata ?? {}) as Record<string, unknown>;
  const expectedKeys = ["commitHash", "testsPassed", "typecheckPassed", "buildPassed", "pushRequired", "pushPassed", "source"].sort();
  const actualKeys = Object.keys(metadata).sort();

  check("28) 기록된 TASK_COMPLETED event에 Telegram Bot Token/Chat ID 관련 문자열이 없다", noTokenLeak);
  check("29) event.metadata는 정확히 기대한 필드만 담는다(추가 secret 필드 없음)", JSON.stringify(actualKeys) === JSON.stringify(expectedKeys));
}

function main(): void {
  scenarioValidateHappyPath();
  scenarioValidateRejectsMissingTaskId();
  scenarioValidateRejectsBadTaskIdFormat();
  scenarioValidateRejectsMissingCommit();
  scenarioValidateRejectsBadCommitFormat();
  scenarioValidateRejectsTestsFailed();
  scenarioValidateRejectsTestsOmitted();
  scenarioValidateRejectsTypecheckFailed();
  scenarioValidateRejectsBuildFailed();
  scenarioValidateRejectsPushRequiredButNotPassed();
  scenarioValidateAllowsPushNotRequired();
  scenarioValidateRejectsUnknownSource();
  scenarioRunIdDeterministic();
  scenarioRunIdDiffersByCommit();
  scenarioRunIdDiffersByTaskId();
  scenarioRecordExactlyOnce();
  scenarioRecordIdempotentSameTaskCommit();
  scenarioRecordNewEventForDifferentCommit();
  scenarioRecordAppendFailurePropagates();
  scenarioNoTelegramCredentialInEventMetadata();

  console.log("\n=== self-dev-completion.ts(G7.2.1) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);

  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
