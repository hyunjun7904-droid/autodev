import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvent, classifyEventCategory, isAuditCriticalEvent } from "./observability-event";
import type { AutoDevEventInput } from "./observability-event";
import { createInMemoryEventStore, createFileEventStore, selectDefaultEventStore, getAuditIntegrityStatus, describeAuditIntegrity } from "./event-store";
import type { EventStore } from "./event-store";

// Observability & Audit Event Foundation 테스트(Phase G Task G1/G2). 실제 Claude/GPT 유료
// API를 호출하지 않는다 — 이 파일은 순수 데이터 모델(observability-event.ts)과 append-only
// 저장소(event-store.ts)만 검증한다. MOVAN product task도 실행하지 않는다.
//
// Phase G Task G2 — query()는 이제 { events, integrityIssues }를 반환한다(예전에는 배열을
// 바로 반환했다). 이 파일의 모든 query() 호출은 .events로 접근한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-event-store-"));
  tempDirs.push(dir);
  return dir;
}

function baseInput(overrides: Partial<AutoDevEventInput> = {}): AutoDevEventInput {
  return { eventType: "RUN_STARTED", runId: "run-1", ...overrides };
}

// ---------------------------------------------------------------------------
// 1) event schema validation — 필수 필드가 항상 채워진다.
// ---------------------------------------------------------------------------
function scenarioEventSchemaValidation(): void {
  const draft = createEvent(baseInput({ eventType: "TASK_STARTED", taskId: "T1.1" }));
  check("schema: eventId가 채워짐(문자열)", typeof draft.eventId === "string" && draft.eventId.length > 0);
  check("schema: timestamp가 ISO 문자열", !Number.isNaN(new Date(draft.timestamp).getTime()));
  check("schema: runId가 그대로 보존됨", draft.runId === "run-1");
  check("schema: taskId가 그대로 보존됨", draft.taskId === "T1.1");
  check("schema: categories가 채워짐(빈 배열 아님)", draft.categories.length > 0);
  check("schema: classifyEventCategory와 draft.categories가 일치", classifyEventCategory("TASK_STARTED").join(",") === draft.categories.join(","));
}

// ---------------------------------------------------------------------------
// 2) deterministic event ordering — sequence가 append 순서대로 단조증가.
// ---------------------------------------------------------------------------
function scenarioDeterministicEventOrdering(): void {
  const store = createInMemoryEventStore();
  const r1 = store.append(baseInput({ eventType: "RUN_STARTED" }));
  const r2 = store.append(baseInput({ eventType: "TASK_STARTED" }));
  const r3 = store.append(baseInput({ eventType: "TASK_COMPLETED" }));

  check("ordering: 3개 append 모두 성공", r1.ok && r2.ok && r3.ok);
  check("ordering: sequence가 1,2,3으로 단조증가", r1.event?.sequence === 1 && r2.event?.sequence === 2 && r3.event?.sequence === 3);
  const queried = store.query({ runId: "run-1" }).events;
  check(
    "ordering: query 결과도 append 순서(sequence 오름차순)와 동일",
    queried.map((e) => e.eventType).join(",") === "RUN_STARTED,TASK_STARTED,TASK_COMPLETED"
  );
}

// ---------------------------------------------------------------------------
// 3) append-only 보장 — update/delete API가 아예 없고, query 결과를 수정해도 저장된
//    원본이 바뀌지 않는다.
// ---------------------------------------------------------------------------
function scenarioAppendOnlyGuarantee(): void {
  const store = createInMemoryEventStore() as EventStore & Record<string, unknown>;
  check("append-only: update 메서드가 존재하지 않음", typeof store["update"] === "undefined");
  check("append-only: delete 메서드가 존재하지 않음", typeof store["delete"] === "undefined");
  check("append-only: remove 메서드가 존재하지 않음", typeof store["remove"] === "undefined");

  store.append(baseInput({ eventType: "RUN_STARTED", reason: "원본" }));
  const queried = store.query({ runId: "run-1" }).events;
  queried[0].reason = "변조 시도";
  const requeried = store.query({ runId: "run-1" }).events;
  check("append-only: query 결과를 수정해도 저장된 원본은 그대로임", requeried[0].reason === "원본");
}

// ---------------------------------------------------------------------------
// 4) run/task/agent correlation — filter로 정확히 골라낼 수 있다. 서로 다른 run의 event가
//    섞이지 않는다는 것도 여기서 함께 증명한다.
// ---------------------------------------------------------------------------
function scenarioRunTaskAgentCorrelation(): void {
  const store = createInMemoryEventStore();
  store.append(baseInput({ eventType: "RUN_STARTED", runId: "run-A", taskId: "T1" }));
  store.append(baseInput({ eventType: "AGENT_STARTED", runId: "run-A", taskId: "T1", agentId: "core-qa", agentRole: "qa" }));
  store.append(baseInput({ eventType: "AGENT_STARTED", runId: "run-A", taskId: "T1", agentId: "core-security", agentRole: "security" }));
  store.append(baseInput({ eventType: "RUN_STARTED", runId: "run-B", taskId: "T2" }));

  check("correlation: runId=run-A로 3건만 조회됨", store.query({ runId: "run-A" }).events.length === 3);
  check("correlation: runId=run-B로 1건만 조회됨", store.query({ runId: "run-B" }).events.length === 1);
  check("correlation: run-A 조회 결과에 run-B의 event가 섞이지 않음", store.query({ runId: "run-A" }).events.every((e) => e.runId === "run-A"));
  check("correlation: taskId=T1로 3건 조회됨", store.query({ taskId: "T1" }).events.length === 3);
  check("correlation: agentId=core-qa로 정확히 1건만 조회됨", store.query({ agentId: "core-qa" }).events.length === 1);
  check("correlation: eventType=AGENT_STARTED로 정확히 2건 조회됨", store.query({ eventType: "AGENT_STARTED" }).events.length === 2);
}

// ---------------------------------------------------------------------------
// 5) agent 0회 task도 정상 기록 — AGENT_* event가 하나도 없어도 RUN/TASK/TEST/REVIEW/
//    CHECKPOINT event는 정상적으로 쌓인다.
// ---------------------------------------------------------------------------
function scenarioZeroAgentTaskRecordedNormally(): void {
  const store = createInMemoryEventStore();
  store.append(baseInput({ eventType: "RUN_STARTED", taskId: "T-plain" }));
  store.append(baseInput({ eventType: "TASK_STARTED", taskId: "T-plain" }));
  store.append(baseInput({ eventType: "TEST_COMPLETED", taskId: "T-plain", testSummary: { total: 1, passed: 1, failed: 0 } }));
  store.append(baseInput({ eventType: "REVIEW_APPROVED", taskId: "T-plain", reviewDecision: "PASS" }));
  store.append(baseInput({ eventType: "CHECKPOINT_CREATED", taskId: "T-plain" }));
  store.append(baseInput({ eventType: "RUN_COMPLETED", taskId: "T-plain" }));

  const all = store.query({ taskId: "T-plain" }).events;
  check("agent 0회: 6개 event가 전부 정상 기록됨", all.length === 6);
  check("agent 0회: AGENT 계열 event가 하나도 없음(정상)", store.query({ taskId: "T-plain", eventType: "AGENT_STARTED" }).events.length === 0);
  check("agent 0회: 순서가 RUN_STARTED로 시작해 RUN_COMPLETED로 끝남", all[0].eventType === "RUN_STARTED" && all[all.length - 1].eventType === "RUN_COMPLETED");
}

// ---------------------------------------------------------------------------
// 6) REVISE 2회 cycle별 event 순서 검증(§ orchestrator.ts의 새 instrumentation을 그대로
//    모사 — 이 파일은 event-store만 검증하므로 orchestrator.ts를 호출하지 않고 동일한
//    순서로 직접 append한다. 실제 orchestrator.ts 배선은 production-agent-integration-
//    tests.ts가 담당한다).
// ---------------------------------------------------------------------------
function scenarioReviseCycleEventOrder(): void {
  const store = createInMemoryEventStore();
  // cycle 1: REVISE.
  store.append(baseInput({ eventType: "TEST_COMPLETED", reviseCycle: 1, testSummary: { total: 1, passed: 1, failed: 0 } }));
  store.append(baseInput({ eventType: "REVIEW_STARTED", reviseCycle: 1 }));
  store.append(baseInput({ eventType: "REVIEW_REVISE", reviewDecision: "REVISE", reviseCycle: 1, reason: "테스트 커버리지 부족" }));
  // cycle 2: 재시도 후 APPROVED.
  store.append(baseInput({ eventType: "DEVELOPER_RETRY_STARTED", reviseCycle: 2 }));
  store.append(baseInput({ eventType: "TEST_COMPLETED", reviseCycle: 2, testSummary: { total: 1, passed: 1, failed: 0 } }));
  store.append(baseInput({ eventType: "REVIEW_STARTED", reviseCycle: 2 }));
  const approved = store.append(baseInput({ eventType: "REVIEW_APPROVED", reviewDecision: "PASS", reviseCycle: 2 }));

  const all = store.query({ runId: "run-1" }).events;
  check(
    "REVISE 2회: cycle별 event 순서가 정확함",
    all.map((e) => e.eventType).join(",") ===
      "TEST_COMPLETED,REVIEW_STARTED,REVIEW_REVISE,DEVELOPER_RETRY_STARTED,TEST_COMPLETED,REVIEW_STARTED,REVIEW_APPROVED"
  );
  check("REVISE 2회: DEVELOPER_RETRY_STARTED는 정확히 1회(최초 시도는 재시도가 아님)", all.filter((e) => e.eventType === "DEVELOPER_RETRY_STARTED").length === 1);
  check("REVISE 2회: 최종 REVIEW_APPROVED의 reviseCycle=2", approved.event?.reviseCycle === 2);
  check("REVISE 2회: 첫 REVIEW_REVISE의 reviseCycle=1", all.find((e) => e.eventType === "REVIEW_REVISE")?.reviseCycle === 1);
}

// ---------------------------------------------------------------------------
// 7) BLOCKED/REVIEW_CYCLE_EXHAUSTED 기록 — 둘 다 audit 카테고리를 반드시 포함한다.
// ---------------------------------------------------------------------------
function scenarioBlockedAndReviewCycleExhaustedRecorded(): void {
  const store = createInMemoryEventStore();
  const blocked = store.append(baseInput({ eventType: "REVIEW_BLOCKED", reviewDecision: "BLOCK", reason: "allowedPathPrefixes 밖 변경" }));
  const exhausted = store.append(baseInput({ eventType: "REVIEW_CYCLE_EXHAUSTED", reviseCycle: 5, reason: "REVIEW_CYCLE_EXHAUSTED: MAX_REVIEW_CYCLES(5) 도달" }));
  const securityBlocked = store.append(baseInput({ eventType: "SECURITY_BLOCKED", reason: "secret finding 발견" }));

  check("BLOCKED 기록: 성공", blocked.ok && blocked.event?.eventType === "REVIEW_BLOCKED");
  check("BLOCKED 기록: audit 카테고리 포함", blocked.event?.categories.includes("audit") === true);
  check("REVIEW_CYCLE_EXHAUSTED 기록: 성공 + reviseCycle=5", exhausted.ok && exhausted.event?.reviseCycle === 5);
  check("REVIEW_CYCLE_EXHAUSTED 기록: audit 카테고리 포함", exhausted.event?.categories.includes("audit") === true);
  check("SECURITY_BLOCKED 기록: audit 카테고리 포함", securityBlocked.event?.categories.includes("audit") === true);
  check("audit-critical 판정: REVIEW_BLOCKED/REVIEW_CYCLE_EXHAUSTED/SECURITY_BLOCKED 모두 audit-critical", [
    isAuditCriticalEvent("REVIEW_BLOCKED"),
    isAuditCriticalEvent("REVIEW_CYCLE_EXHAUSTED"),
    isAuditCriticalEvent("SECURITY_BLOCKED"),
  ].every(Boolean));
  check("audit-critical 판정: REVIEW_STARTED/TEST_STARTED 같은 순수 telemetry는 audit-critical이 아님", !isAuditCriticalEvent("REVIEW_STARTED") && !isAuditCriticalEvent("TEST_STARTED"));
}

// ---------------------------------------------------------------------------
// 8) test PASS/FAIL 기록.
// ---------------------------------------------------------------------------
function scenarioTestPassFailRecorded(): void {
  const store = createInMemoryEventStore();
  const result = store.append(
    baseInput({ eventType: "TEST_COMPLETED", testSummary: { total: 3, passed: 2, failed: 1, failedNames: ["unit-3"] } })
  );
  check("test 기록: testSummary가 그대로 보존됨", result.event?.testSummary?.total === 3 && result.event?.testSummary?.passed === 2 && result.event?.testSummary?.failed === 1);
  check("test 기록: 실패한 test 이름이 보존됨", result.event?.testSummary?.failedNames?.[0] === "unit-3");
}

// ---------------------------------------------------------------------------
// 9) secret-like 값이 audit payload에 그대로 남지 않음 — key 기반(logger.ts)과 모양 기반
//    (secret-scanner.ts) 둘 다. raw prompt/전체 Claude output도 애초에 이 event 모델에
//    담을 필드 자체가 없다(reason/error.message/metadata만 있고, 전체 transcript 필드가
//    없다).
// ---------------------------------------------------------------------------
function scenarioSecretLikeValuesRedacted(): void {
  const store = createInMemoryEventStore();
  const keyBased = store.append(
    baseInput({ eventType: "AGENT_FAILED", reason: 'ANTHROPIC_API_KEY="sk-ant-verysecretvalue1234567890" 때문에 실패했습니다.' })
  );
  const shapeBased = store.append(
    baseInput({ eventType: "AGENT_FAILED", error: { message: "sk-ant-abcdefghijklmnopqrstuvwxyz012345 가 노출된 채로 로그에 남았습니다." } })
  );
  const inMetadata = store.append(baseInput({ eventType: "AGENT_FAILED", metadata: { note: "token=sk-ant-zzzzzzzzzzzzzzzzzzzzzzzzz" } }));
  const reviewerFeedback = store.append(
    baseInput({ eventType: "REVIEW_REVISE", reason: ".env 파일에 client_secret=abcdef1234567890 이 그대로 커밋됐습니다." })
  );

  check("secret 보호(key 기반): reason에 실제 key 값이 남아있지 않음", !keyBased.event?.reason?.includes("verysecretvalue1234567890"));
  check("secret 보호(key 기반): [REDACTED] 마커가 포함됨", keyBased.event?.reason?.includes("[REDACTED]") === true);
  check("secret 보호(모양 기반, key 이름 없음): error.message에 실제 key 값이 남아있지 않음", !shapeBased.event?.error?.message.includes("abcdefghijklmnopqrstuvwxyz012345"));
  check("secret 보호(모양 기반): [REDACTED] 마커가 포함됨", shapeBased.event?.error?.message.includes("[REDACTED]") === true);
  check("secret 보호(metadata): metadata 문자열 값도 redact됨", !String(inMetadata.event?.metadata?.note).includes("zzzzzzzzzzzzzzzzzzzzzzzzz"));
  check("secret 보호(reviewer feedback/reason): .env 안의 client_secret 값이 남지 않음", !reviewerFeedback.event?.reason?.includes("abcdef1234567890"));
}

// ---------------------------------------------------------------------------
// 10) unknown token/cost는 임의 숫자로 채우지 않음.
// ---------------------------------------------------------------------------
function scenarioUnknownTokenCostNotFabricated(): void {
  const store = createInMemoryEventStore();
  const result = store.append(baseInput({ eventType: "AGENT_COMPLETED" })); // tokenUsage 미지정.
  check("token/cost: tokenUsage 필드 자체가 undefined(0이나 임의값으로 채워지지 않음)", result.event?.tokenUsage === undefined);

  const partial = store.append(baseInput({ eventType: "AGENT_COMPLETED", tokenUsage: { inputTokens: 120 } }));
  check("token/cost: 실제로 아는 값(inputTokens)만 채워지고 나머지는 undefined 유지", partial.event?.tokenUsage?.inputTokens === 120);
  check("token/cost: outputTokens를 모르면 0으로 채우지 않고 undefined", partial.event?.tokenUsage?.outputTokens === undefined);
  check("token/cost: estimatedCostUsd를 모르면 undefined", partial.event?.tokenUsage?.estimatedCostUsd === undefined);
}

// ---------------------------------------------------------------------------
// 11) Agent/Project policy로 audit 비활성화 불가 — append()/createEvent()가 그런 인자를
//     아예 받지 않는다(구조적 hard rule). append는 항상 실제로 기록되고 query에 나타난다.
// ---------------------------------------------------------------------------
function scenarioPolicyCannotDisableAudit(): void {
  check("정책 무력화 불가: createEvent()는 event 데이터 하나만 인자로 받는다(길이 1)", createEvent.length === 1);
  const store = createInMemoryEventStore();
  check("정책 무력화 불가: append()는 event 데이터 하나만 인자로 받는다(길이 1)", store.append.length === 1);

  // "비활성화 policy"를 흉내내려는 시도(임의 여분 필드)를 넘겨도 무시되고 정상 기록된다.
  const attempted = { ...baseInput({ eventType: "SECURITY_BLOCKED" }), disabled: true, skipAudit: true } as unknown as AutoDevEventInput;
  const result = store.append(attempted);
  check("정책 무력화 불가: 임의의 disabled/skipAudit 필드를 넣어도 정상 기록됨", result.ok && store.query({ eventType: "SECURITY_BLOCKED" }).events.length === 1);
}

// ---------------------------------------------------------------------------
// 12) 파일 기반 store — append-only, 재시작해도 sequence가 이어지고 기존 history가
//     보존된다.
// ---------------------------------------------------------------------------
function scenarioFileStorePersistsAcrossRestarts(): void {
  const dir = makeTempDir();
  const filePath = join(dir, "events.jsonl");

  const store1 = createFileEventStore(filePath);
  store1.append(baseInput({ eventType: "RUN_STARTED" }));
  store1.append(baseInput({ eventType: "TASK_STARTED" }));

  // "재시작" — 새 store 인스턴스가 같은 파일을 가리킨다.
  const store2 = createFileEventStore(filePath);
  const third = store2.append(baseInput({ eventType: "TASK_COMPLETED" }));

  check("file store: 재시작 후 sequence가 이어짐(3)", third.event?.sequence === 3);
  const result = store2.query({ runId: "run-1" });
  check("file store: 재시작 전에 기록된 event까지 전부 조회됨(3건)", result.events.length === 3);
  check("file store: 순서가 append 순서와 동일", result.events.map((e) => e.eventType).join(",") === "RUN_STARTED,TASK_STARTED,TASK_COMPLETED");
  check("file store: 손상이 없으면 integrityIssues가 빈 배열", result.integrityIssues.length === 0);
}

// ---------------------------------------------------------------------------
// 13) Audit Integrity(Phase G Task G2) — 손상된 JSONL 줄을 조용히 정상 처리하지 않는다.
//     JSON_PARSE_ERROR와 SCHEMA_INVALID(파싱은 되지만 필수 필드가 없는 경우) 둘 다 잡고,
//     file/line/reason만 보고하며 손상된 원문은 절대 담지 않는다. 이후 query가 "완전한
//     기록"인 것처럼 굴지 않는다 — integrityIssues가 그 사실을 명시적으로 드러낸다.
// ---------------------------------------------------------------------------
function scenarioAuditIntegrityNotSilentlySkipped(): void {
  const dir = makeTempDir();
  const filePath = join(dir, "events.jsonl");
  writeFileSync(filePath, "", "utf-8");
  const store = createFileEventStore(filePath);
  store.append(baseInput({ eventType: "RUN_STARTED" }));

  const secretLikeCorruptLine = 'ANTHROPIC_API_KEY=sk-ant-thisIsNotValidJsonAtAll1234567890';
  appendFileSync(filePath, `${secretLikeCorruptLine}\n`, "utf-8");
  appendFileSync(filePath, `${JSON.stringify({ foo: "bar" })}\n`, "utf-8"); // JSON은 맞지만 event 스키마가 아님.
  store.append(baseInput({ eventType: "RUN_COMPLETED" }));

  const result = store.query({ runId: "run-1" });

  check("audit integrity: 정상 파싱된 2건은 여전히 조회됨(best-effort)", result.events.length === 2);
  check("audit integrity: 손상을 조용히 넘기지 않음(integrityIssues가 비어있지 않음)", result.integrityIssues.length === 2);
  check(
    "audit integrity: JSON 자체가 깨진 줄은 JSON_PARSE_ERROR로 보고됨",
    result.integrityIssues.some((i) => i.reason === "JSON_PARSE_ERROR")
  );
  check(
    "audit integrity: JSON은 맞지만 event 스키마가 아닌 줄은 SCHEMA_INVALID로 보고됨(정상 event로 위장되지 않음)",
    result.integrityIssues.some((i) => i.reason === "SCHEMA_INVALID")
  );
  check("audit integrity: 손상 위치가 file/line만 안전하게 보고됨", result.integrityIssues.every((i) => typeof i.file === "string" && typeof i.line === "number"));
  check(
    "audit integrity: 손상된 줄의 원문(secret-like 값 포함)이 integrityIssues 어디에도 그대로 남지 않음",
    !JSON.stringify(result.integrityIssues).includes("thisIsNotValidJsonAtAll1234567890")
  );
}

// ---------------------------------------------------------------------------
// 14) Audit Integrity status/설명 helper(Phase G Task G2.1) — integrityIssues가 없으면
//     CLEAN, 있으면 DEGRADED로 단일 판정한다. describeAuditIntegrity()는 손상 건수/사유만
//     요약하고 원문은 절대 포함하지 않는다.
// ---------------------------------------------------------------------------
function scenarioAuditIntegrityStatusHelper(): void {
  const cleanResult = { integrityIssues: [] };
  check("integrity status: 손상 없으면 CLEAN", getAuditIntegrityStatus(cleanResult) === "CLEAN");
  check("integrity 설명: CLEAN일 때 손상 없음을 명시", describeAuditIntegrity(cleanResult).startsWith("CLEAN"));

  const dir = makeTempDir();
  const filePath = join(dir, "events.jsonl");
  writeFileSync(filePath, "", "utf-8");
  const store = createFileEventStore(filePath);
  store.append(baseInput({ eventType: "RUN_STARTED" }));
  appendFileSync(filePath, "NOT_VALID_JSON_AT_ALL\n", "utf-8");
  appendFileSync(filePath, `${JSON.stringify({ foo: "bar" })}\n`, "utf-8");
  const degradedResult = store.query({ runId: "run-1" });

  check("integrity status: 손상이 있으면 DEGRADED", getAuditIntegrityStatus(degradedResult) === "DEGRADED");
  const description = describeAuditIntegrity(degradedResult);
  check("integrity 설명: DEGRADED로 시작하고 손상 건수(2)를 포함", description.startsWith("DEGRADED") && description.includes("2건"));
  check("integrity 설명: JSON_PARSE_ERROR/SCHEMA_INVALID 사유별 건수를 포함", description.includes("JSON_PARSE_ERROR=1") && description.includes("SCHEMA_INVALID=1"));
  check("integrity 설명: 손상된 원문이 설명 문자열에 남지 않음", !description.includes("NOT_VALID_JSON_AT_ALL"));
}

// ---------------------------------------------------------------------------
// 15) checkAuditWritable(Phase G Task G2.1) — checkpoint 전 audit-critical 저장소 사용
//     가능 여부를 부수효과 없이 미리 확인한다. 정상 경로에서는 ok:true이고 실제 파일이
//     새로 생기지 않는다(순수 점검). 저장소가 쓰기 불가능한 상황(디렉터리 자리에 파일이
//     있어 mkdir/access가 구조적으로 실패하는 경우)에서는 ok:false + error를 반환한다.
// ---------------------------------------------------------------------------
function scenarioCheckAuditWritable(): void {
  const dir = makeTempDir();
  const filePath = join(dir, "events.jsonl");
  const store = createFileEventStore(filePath);

  const beforeCheck = existsSync(filePath);
  const health = store.checkAuditWritable?.();
  check("checkAuditWritable: 정상 경로에서 ok:true", health?.ok === true);
  check("checkAuditWritable: 파일이 없던 상태 그대로 유지됨(부수효과 없음)", beforeCheck === false && !existsSync(filePath));

  // 디렉터리가 있어야 할 자리에 일반 파일을 둬서 실제 fs 오류를 유발한다(OS 권한을
  // 건드리지 않는 이식 가능한 방법).
  const blockerFile = join(dir, "not-a-directory");
  writeFileSync(blockerFile, "x", "utf-8");
  const blockedFilePath = join(blockerFile, "sub", "events.jsonl");
  const blockedStore = createFileEventStore(blockedFilePath);
  const blockedHealth = blockedStore.checkAuditWritable?.();
  check("checkAuditWritable: 저장소를 쓸 수 없으면 ok:false + error를 반환", blockedHealth?.ok === false && typeof blockedHealth?.error === "string");

  const inMemory = createInMemoryEventStore();
  check("checkAuditWritable: in-memory store는 이 메서드를 구현하지 않음(항상 사용 가능한 것으로 간주)", typeof inMemory.checkAuditWritable === "undefined");
}

// ---------------------------------------------------------------------------
// 16) Production EventStore 선택 — AUTOMATION_DRY_RUN이 명시적으로 "false"일 때만 실제
//     파일 store를 고른다(production과 test storage 분리).
// ---------------------------------------------------------------------------
function scenarioDefaultEventStoreSelection(): void {
  // 실제 production runtime 경로(logs/events.jsonl)는 절대 건드리지 않는다 — 이
  // 테스트에서 AUTOMATION_DRY_RUN=false 분기를 확인할 때도 임시 경로만 override로 넘긴다
  // (§ selectDefaultEventStore의 filePath 테스트 override).
  const dir = makeTempDir();
  const tempEventLogPath = join(dir, "prod-like-events.jsonl");
  const original = process.env.AUTOMATION_DRY_RUN;
  try {
    delete process.env.AUTOMATION_DRY_RUN;
    const dryRunStore = selectDefaultEventStore(tempEventLogPath);
    const dryRunResult = dryRunStore.append(baseInput({ eventType: "RUN_STARTED" }));
    check("기본 선택: AUTOMATION_DRY_RUN 미설정이면 in-memory store(같은 경로를 줘도 파일이 생기지 않음)", dryRunResult.ok === true);
    check("기본 선택: in-memory이므로 override 경로에 파일이 생성되지 않음", !existsSync(tempEventLogPath));

    process.env.AUTOMATION_DRY_RUN = "false";
    const prodStore = selectDefaultEventStore(tempEventLogPath);
    check("기본 선택: AUTOMATION_DRY_RUN=false면 실제 파일 store가 선택됨(append 성공)", prodStore.append(baseInput({ eventType: "RUN_STARTED" })).ok === true);
    check("기본 선택: false일 때는 override 경로에 실제로 파일이 생성됨", existsSync(tempEventLogPath));
  } finally {
    if (original === undefined) delete process.env.AUTOMATION_DRY_RUN;
    else process.env.AUTOMATION_DRY_RUN = original;
  }
}

async function main(): Promise<void> {
  try {
    scenarioEventSchemaValidation();
    scenarioDeterministicEventOrdering();
    scenarioAppendOnlyGuarantee();
    scenarioRunTaskAgentCorrelation();
    scenarioZeroAgentTaskRecordedNormally();
    scenarioReviseCycleEventOrder();
    scenarioBlockedAndReviewCycleExhaustedRecorded();
    scenarioTestPassFailRecorded();
    scenarioSecretLikeValuesRedacted();
    scenarioUnknownTokenCostNotFabricated();
    scenarioPolicyCannotDisableAudit();
    scenarioFileStorePersistsAcrossRestarts();
    scenarioAuditIntegrityNotSilentlySkipped();
    scenarioAuditIntegrityStatusHelper();
    scenarioCheckAuditWritable();
    scenarioDefaultEventStoreSelection();
  } finally {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // 정리 실패는 테스트 결과에 영향 없음(OS 임시 디렉터리).
      }
    }
  }

  console.log("\n=== event-store(G1/G2) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
