import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvent, classifyEventCategory } from "./observability-event";
import type { AutoDevEventInput } from "./observability-event";
import { createInMemoryEventStore, createFileEventStore } from "./event-store";
import type { EventStore } from "./event-store";

// Observability & Audit Event Foundation 테스트(Phase G Task G1). 실제 Claude/GPT 유료
// API를 호출하지 않는다 — 이 파일은 순수 데이터 모델(observability-event.ts)과 append-only
// 저장소(event-store.ts)만 검증한다. MOVAN product task도 실행하지 않는다.

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
  const queried = store.query({ runId: "run-1" });
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
  const queried = store.query({ runId: "run-1" });
  queried[0].reason = "변조 시도";
  const requeried = store.query({ runId: "run-1" });
  check("append-only: query 결과를 수정해도 저장된 원본은 그대로임", requeried[0].reason === "원본");
}

// ---------------------------------------------------------------------------
// 4) run/task/agent correlation — filter로 정확히 골라낼 수 있다.
// ---------------------------------------------------------------------------
function scenarioRunTaskAgentCorrelation(): void {
  const store = createInMemoryEventStore();
  store.append(baseInput({ eventType: "RUN_STARTED", runId: "run-A", taskId: "T1" }));
  store.append(baseInput({ eventType: "AGENT_STARTED", runId: "run-A", taskId: "T1", agentId: "core-qa", agentRole: "qa" }));
  store.append(baseInput({ eventType: "AGENT_STARTED", runId: "run-A", taskId: "T1", agentId: "core-security", agentRole: "security" }));
  store.append(baseInput({ eventType: "RUN_STARTED", runId: "run-B", taskId: "T2" }));

  check("correlation: runId=run-A로 3건만 조회됨", store.query({ runId: "run-A" }).length === 3);
  check("correlation: runId=run-B로 1건만 조회됨", store.query({ runId: "run-B" }).length === 1);
  check("correlation: taskId=T1로 3건 조회됨", store.query({ taskId: "T1" }).length === 3);
  check("correlation: agentId=core-qa로 정확히 1건만 조회됨", store.query({ agentId: "core-qa" }).length === 1);
  check("correlation: eventType=AGENT_STARTED로 정확히 2건 조회됨", store.query({ eventType: "AGENT_STARTED" }).length === 2);
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

  const all = store.query({ taskId: "T-plain" });
  check("agent 0회: 6개 event가 전부 정상 기록됨", all.length === 6);
  check("agent 0회: AGENT 계열 event가 하나도 없음(정상)", store.query({ taskId: "T-plain", eventType: "AGENT_STARTED" }).length === 0);
  check("agent 0회: 순서가 RUN_STARTED로 시작해 RUN_COMPLETED로 끝남", all[0].eventType === "RUN_STARTED" && all[all.length - 1].eventType === "RUN_COMPLETED");
}

// ---------------------------------------------------------------------------
// 6) REVISE cycle 기록.
// ---------------------------------------------------------------------------
function scenarioReviseCycleRecorded(): void {
  const store = createInMemoryEventStore();
  const result = store.append(baseInput({ eventType: "REVIEW_REVISE", reviewDecision: "REVISE", reviseCycle: 2, reason: "테스트 커버리지 부족" }));
  check("REVISE cycle: 기록 성공", result.ok);
  check("REVISE cycle: reviseCycle=2가 그대로 보존됨", result.event?.reviseCycle === 2);
  check("REVISE cycle: reviewDecision=REVISE가 보존됨", result.event?.reviewDecision === "REVISE");
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
//    (secret-scanner.ts) 둘 다.
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

  check("secret 보호(key 기반): reason에 실제 key 값이 남아있지 않음", !keyBased.event?.reason?.includes("verysecretvalue1234567890"));
  check("secret 보호(key 기반): [REDACTED] 마커가 포함됨", keyBased.event?.reason?.includes("[REDACTED]") === true);
  check("secret 보호(모양 기반, key 이름 없음): error.message에 실제 key 값이 남아있지 않음", !shapeBased.event?.error?.message.includes("abcdefghijklmnopqrstuvwxyz012345"));
  check("secret 보호(모양 기반): [REDACTED] 마커가 포함됨", shapeBased.event?.error?.message.includes("[REDACTED]") === true);
  check("secret 보호(metadata): metadata 문자열 값도 redact됨", !String(inMetadata.event?.metadata?.note).includes("zzzzzzzzzzzzzzzzzzzzzzzzz"));
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
  check("정책 무력화 불가: 임의의 disabled/skipAudit 필드를 넣어도 정상 기록됨", result.ok && store.query({ eventType: "SECURITY_BLOCKED" }).length === 1);
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
  const all = store2.query({ runId: "run-1" });
  check("file store: 재시작 전에 기록된 event까지 전부 조회됨(3건)", all.length === 3);
  check("file store: 순서가 append 순서와 동일", all.map((e) => e.eventType).join(",") === "RUN_STARTED,TASK_STARTED,TASK_COMPLETED");
}

function scenarioFileStoreSkipsCorruptedLines(): void {
  const dir = makeTempDir();
  const filePath = join(dir, "events.jsonl");
  writeFileSync(filePath, "", "utf-8");
  const store = createFileEventStore(filePath);
  store.append(baseInput({ eventType: "RUN_STARTED" }));
  appendFileSync(filePath, "이건 유효한 JSON이 아닙니다\n", "utf-8");
  store.append(baseInput({ eventType: "RUN_COMPLETED" }));

  const all = store.query({ runId: "run-1" });
  check("file store: 손상된 줄은 건너뛰고 나머지 2건은 정상 조회됨", all.length === 2);
}

async function main(): Promise<void> {
  try {
    scenarioEventSchemaValidation();
    scenarioDeterministicEventOrdering();
    scenarioAppendOnlyGuarantee();
    scenarioRunTaskAgentCorrelation();
    scenarioZeroAgentTaskRecordedNormally();
    scenarioReviseCycleRecorded();
    scenarioBlockedAndReviewCycleExhaustedRecorded();
    scenarioTestPassFailRecorded();
    scenarioSecretLikeValuesRedacted();
    scenarioUnknownTokenCostNotFabricated();
    scenarioPolicyCannotDisableAudit();
    scenarioFileStorePersistsAcrossRestarts();
    scenarioFileStoreSkipsCorruptedLines();
  } finally {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // 정리 실패는 테스트 결과에 영향 없음(OS 임시 디렉터리).
      }
    }
  }

  console.log("\n=== event-store(G1) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
