import { mkdtempSync, rmSync, existsSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  createInMemoryUsageLedger,
  createFileUsageLedger,
  selectDefaultUsageLedgerForProject,
  sanitizeProjectIdForFilename,
  resolveUsageLedgerFilePath,
  aggregateUsageLedgerEntries,
  aggregateUsageLedgerByProject,
  aggregateUsageLedgerByTask,
  aggregateUsageLedgerByProvider,
  aggregateUsageLedgerByModel,
} from "./usage-ledger";
import type { UsageLedgerEntryInput, UsageLedgerEntry } from "./usage-ledger";
import { resolvePricing, calculateEstimatedCost } from "./pricing-catalog";
import type { PricingCatalogEntry } from "./pricing-catalog";
import { buildGptReviewLedgerEntryInput } from "./gpt-reviewer";

// API Usage & Cost Ledger 테스트 — Phase SI-3.8B. 실제 외부 API를 전혀 호출하지 않는다 —
// 이 파일은 Ledger 자체(persistence/aggregation)와 pricing-catalog.ts(순수 계산),
// gpt-reviewer.ts의 buildGptReviewLedgerEntryInput(순수 매핑)만 fixture로 직접 검증한다.
// 실제 orchestrator.ts/agent-orchestrator.ts 배선(gpt-reviewer 성공/BUDGET_BLOCK 경로,
// agent-orchestrator 동일 Ledger 재사용)은 usage-telemetry-tests.ts/
// gpt-budget-guard-integration-tests.ts가 담당한다(§ 요구사항 14/15/16, 기존 파일의 이미
// 확립된 orchestrator/agent-orchestrator fixture 패턴을 그대로 재사용).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempDir(prefix = "autodev-usage-ledger-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function entry(overrides: Partial<UsageLedgerEntryInput> = {}): UsageLedgerEntryInput {
  return {
    environment: "development",
    service: "gpt-reviewer",
    provider: "openai",
    operation: "gpt_review",
    requestCount: 1,
    status: "SUCCESS",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1) 정상 usage entry 기록 + 2) 여러 entry append 시 기존 기록 보존.
// ---------------------------------------------------------------------------
function scenarioBasicAppendAndPreserve(): void {
  const ledger = createInMemoryUsageLedger();
  const r1 = ledger.append(entry({ projectId: "proj-a", taskId: "task-1", inputTokens: 100, outputTokens: 50, totalTokens: 150 }));
  check("1) 첫 append 성공(ok=true)", r1.ok === true);
  check("1) entryId/timestamp/sequence가 부여됨", typeof r1.entry?.entryId === "string" && typeof r1.entry?.timestamp === "string" && r1.entry?.sequence === 1);

  const r2 = ledger.append(entry({ projectId: "proj-a", taskId: "task-2", inputTokens: 10 }));
  check("2) 두 번째 append도 성공", r2.ok === true);
  check("2) sequence가 단조증가함(1 → 2)", r2.entry?.sequence === 2);

  const all = ledger.query();
  check("2) 두 entry 모두 조회 결과에 남아있음(기존 기록 보존, overwrite 없음)", all.entries.length === 2);
  check("2) 첫 entry의 필드가 그대로 보존됨(덮어쓰이지 않음)", all.entries[0].taskId === "task-1" && all.entries[0].inputTokens === 100);
}

// ---------------------------------------------------------------------------
// 3) project/task/provider/model/operation 필드 정확성(query filter).
// ---------------------------------------------------------------------------
function scenarioFieldAccuracyAndFilter(): void {
  const ledger = createInMemoryUsageLedger();
  ledger.append(entry({ projectId: "proj-a", taskId: "t1", provider: "openai", model: "gpt-5.6", operation: "gpt_review" }));
  ledger.append(entry({ projectId: "proj-b", taskId: "t2", provider: "openai", model: "gpt-5.6", operation: "gpt_review" }));
  ledger.append(entry({ projectId: "proj-a", taskId: "t3", provider: "anthropic", model: "claude", operation: "developer_task" }));

  const byProject = ledger.query({ projectId: "proj-a" });
  check("3) projectId 필터 정확성(2건)", byProject.entries.length === 2);

  const byProvider = ledger.query({ provider: "anthropic" });
  check("3) provider 필터 정확성(1건)", byProvider.entries.length === 1 && byProvider.entries[0].model === "claude");

  const byOperation = ledger.query({ operation: "gpt_review" });
  check("3) operation 필터 정확성(2건)", byOperation.entries.length === 2);

  const byTask = ledger.query({ taskId: "t3" });
  check("3) taskId 필터 정확성(1건)", byTask.entries.length === 1 && byTask.entries[0].provider === "anthropic");
}

// ---------------------------------------------------------------------------
// 4) cached token 포함.
// ---------------------------------------------------------------------------
function scenarioCachedTokens(): void {
  const ledger = createInMemoryUsageLedger();
  const r = ledger.append(entry({ inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200, totalTokens: 1200 }));
  check("4) cachedInputTokens가 그대로 저장됨", r.entry?.cachedInputTokens === 400);
  const agg = aggregateUsageLedgerEntries(ledger.query().entries);
  check("4) 집계에서 totalCachedInputTokens에 반영됨", agg.totalCachedInputTokens === 400);
}

// ---------------------------------------------------------------------------
// 5) unknown token 필드 안전 처리 — 없는 필드는 0으로 채우지 않고 undefined로 남으며,
//    집계에서도 크래시 없이 안전하게 처리된다.
// ---------------------------------------------------------------------------
function scenarioUnknownTokenFieldsSafe(): void {
  const ledger = createInMemoryUsageLedger();
  const r = ledger.append(entry({ status: "BUDGET_BLOCKED", requestCount: 0 }));
  check("5) token 필드를 지정하지 않으면 undefined로 남음(0으로 채우지 않음)", r.entry?.inputTokens === undefined && r.entry?.outputTokens === undefined);
  const agg = aggregateUsageLedgerEntries(ledger.query().entries);
  check("5) 집계 함수가 크래시 없이 처리하고 합계는 0", agg.totalInputTokens === 0 && agg.totalOutputTokens === 0 && agg.entryCount === 1);
}

// ---------------------------------------------------------------------------
// 6) unknown model price → 임의 비용 생성 금지 / 7) known pricing fixture → 정확 계산.
// ---------------------------------------------------------------------------
function scenarioPricingCalculator(): void {
  const unknown = resolvePricing("openai", "gpt-5.6-does-not-exist");
  check("6) 등록되지 않은 model은 resolvePricing이 undefined를 반환", unknown === undefined);
  const unknownCost = calculateEstimatedCost({ inputTokens: 100, outputTokens: 50 }, unknown);
  check("6) 가격표에 없으면 PRICE_UNAVAILABLE(비용 임의 생성 없음)", unknownCost.status === "PRICE_UNAVAILABLE" && unknownCost.estimatedCostUsd === undefined);

  const missingUsage = calculateEstimatedCost({}, undefined);
  check("6) usage/pricing 둘 다 없어도 PRICE_UNAVAILABLE(크래시 없음)", missingUsage.status === "PRICE_UNAVAILABLE");

  // 테스트 전용 fixture 가격 — 실제 CORE_PRICING_CATALOG에는 존재하지 않는다(§
  // pricing-catalog.ts 상단 주석: 이번 Task는 실제 가격을 추측해 채우지 않는다).
  const fixturePricing: PricingCatalogEntry = {
    provider: "test-provider",
    model: "test-model",
    pricingUnitTokens: 1_000_000,
    inputPricePerUnitUsd: 2,
    cachedInputPricePerUnitUsd: 0.5,
    outputPricePerUnitUsd: 8,
    currency: "USD",
    source: "test fixture",
    asOf: "2026-01-01",
    version: "test-v1",
  };
  const resolved = resolvePricing("test-provider", "test-model", [fixturePricing]);
  check("7) fixture catalog에서 정확히 조회됨", resolved === fixturePricing);

  // inputTokens=1_000_000(그중 cached=200_000), outputTokens=500_000 이라고 가정.
  // 비cached input=800_000 → 800_000/1_000_000*2 = 1.6
  // cached input=200_000     → 200_000/1_000_000*0.5 = 0.1
  // output=500_000            → 500_000/1_000_000*8 = 4.0
  // 합계 = 5.7
  const calc = calculateEstimatedCost({ inputTokens: 1_000_000, cachedInputTokens: 200_000, outputTokens: 500_000 }, fixturePricing);
  check("7) known pricing fixture로 estimated cost가 정확히 계산됨(5.7)", calc.status === "CALCULATED" && Math.abs((calc.estimatedCostUsd ?? -1) - 5.7) < 1e-9);
  check("7) currency/pricingSource/pricingAsOf가 함께 채워짐", calc.currency === "USD" && calc.pricingSource === "test fixture" && calc.pricingAsOf === "2026-01-01");
}

// ---------------------------------------------------------------------------
// 8) actualCost가 없으면 임의 생성 안 됨 — buildGptReviewLedgerEntryInput은 절대
//    actualCostUsd를 채우지 않는다.
// ---------------------------------------------------------------------------
function scenarioNoFabricatedActualCost(): void {
  const successInput = buildGptReviewLedgerEntryInput(
    { model: { provider: "openai", name: "gpt-5.6" }, tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } },
    { projectId: "proj-a", taskId: "task-1", operationCycle: 1 }
  );
  check("8) 성공 응답이어도 actualCostUsd는 절대 채워지지 않음", successInput.actualCostUsd === undefined);
  check("8) 실제 pricing catalog가 비어있으므로 estimatedCostUsd도 undefined(임의 추정 없음)", successInput.estimatedCostUsd === undefined);
}

// ---------------------------------------------------------------------------
// Budget Guard BLOCK 매핑 — requestCount=0, token/cost 없음(§ 요구사항 8/15의 순수 매핑 단위
// 검증. 실제 orchestrator.ts 배선 통합 검증은 gpt-budget-guard-integration-tests.ts).
// ---------------------------------------------------------------------------
function scenarioBudgetBlockedMapping(): void {
  const blockedInput = buildGptReviewLedgerEntryInput({ errorCode: "BUDGET_EXCEEDED" }, { projectId: "proj-a", taskId: "task-1", operationCycle: 1 });
  check("Budget Guard BLOCK → requestCount=0", blockedInput.requestCount === 0);
  check("Budget Guard BLOCK → token 필드 없음", blockedInput.inputTokens === undefined && blockedInput.outputTokens === undefined);
  check("Budget Guard BLOCK → status=BUDGET_EXCEEDED", blockedInput.status === "BUDGET_EXCEEDED");

  const apiErrorInput = buildGptReviewLedgerEntryInput({ errorCode: "API_ERROR", gptTransportRetry: 2 }, { projectId: "proj-a", taskId: "task-1", operationCycle: 1 });
  check("일반 API 오류는 실제 시도 횟수(1+retry)로 requestCount 기록됨(BLOCK과 구분)", apiErrorInput.requestCount === 3);

  // Claude code-review(SI-3.8B) 지적 — OpenAI SDK 클라이언트 생성 자체가 실패하면(예:
  // OPENAI_API_KEY 미설정) 실제 네트워크 요청이 전혀 나가지 않았는데도 classifyApiError()가
  // 이를 일반 네트워크 실패와 같은 errorCode(API_ERROR)로 분류할 수 있다 — requestAttempted
  // ===false일 때는 gptTransportRetry가 있어도 requestCount가 항상 0이어야 한다(§
  // reviewClaudeResultOnce의 client 생성 분리).
  const preflightFailureInput = buildGptReviewLedgerEntryInput(
    { errorCode: "API_ERROR", gptTransportRetry: 0, requestAttempted: false },
    { projectId: "proj-a", taskId: "task-1", operationCycle: 1 }
  );
  check("클라이언트 생성 실패(requestAttempted=false)는 API_ERROR여도 requestCount=0", preflightFailureInput.requestCount === 0);
  check("클라이언트 생성 실패 entry에도 token/비용이 없음", preflightFailureInput.inputTokens === undefined && preflightFailureInput.estimatedCostUsd === undefined);
}

// ---------------------------------------------------------------------------
// 9) Secret/API key가 Ledger에 기록되지 않음 — 스키마 자체에 자유 텍스트 필드가 없다.
//    append()가 입력을 그대로 반영할 뿐 별도 필드를 추가하지 않는지(구조적 secret 부재)를
//    직접 확인한다.
// ---------------------------------------------------------------------------
function scenarioNoSecretFields(): void {
  const ledger = createInMemoryUsageLedger();
  const secretLike = "sk-THIS_LOOKS_LIKE_A_SECRET_1234567890";
  // 이 스키마에는 secret이 담길 수 있는 자유 텍스트 필드가 없다 — model/service/operation/
  // status에 일부러 secret-like 문자열을 넣어도(실수로 호출부가 그렇게 했다고 가정) 그
  // 값이 그대로 저장은 되지만(문자열 필드 자체의 존재는 막지 않는다), 이 테스트가 실제로
  // 확인하는 것은 "그 외의 어떤 필드에도 secret이 새어나가지 않는다"는 구조적 보장이다 —
  // append() 결과 entry의 키 집합이 UsageLedgerEntryInput + entryId/timestamp/sequence
  // 정확히 그대로다(추가 필드가 몰래 생기지 않음).
  const r = ledger.append(entry({ model: secretLike }));
  const expectedKeys = new Set([...Object.keys(entry()), "model", "entryId", "timestamp", "sequence"]);
  const actualKeys = Object.keys(r.entry ?? {});
  check("9) entry에 정의되지 않은 추가 필드가 없음(자유 텍스트 secret 유입 경로 없음)", actualKeys.every((k) => expectedKeys.has(k)));
  check("9) 이 스키마에는 prompt/diff/에러 원문을 담는 필드가 아예 없음(reason 등)", !("reason" in (r.entry ?? {})) && !("rawOutput" in (r.entry ?? {})));
}

// ---------------------------------------------------------------------------
// 10) malformed ledger 안전 처리 — event-store.ts와 동일한 fail-open 금지 원칙.
// ---------------------------------------------------------------------------
function scenarioMalformedLedgerSafe(): void {
  const dir = makeTempDir();
  const filePath = join(dir, "ledger.jsonl");
  const ledger = createFileUsageLedger(filePath);
  ledger.append(entry({ projectId: "proj-a", taskId: "t1" }));
  appendFileSync(filePath, "{ this is not valid json\n", "utf-8");
  appendFileSync(filePath, `${JSON.stringify({ notAnEntry: true })}\n`, "utf-8");
  ledger.append(entry({ projectId: "proj-a", taskId: "t2" }));

  const result = ledger.query();
  check("10) 파싱 가능한 entry는 정상적으로 조회됨(2건)", result.entries.length === 2);
  check("10) 손상된 줄이 integrityIssues로 표면화됨(조용히 무시하지 않음)", result.integrityIssues.length === 2);
  check(
    "10) integrityIssues가 JSON_PARSE_ERROR/SCHEMA_INVALID를 정확히 구분함",
    result.integrityIssues.some((i) => i.reason === "JSON_PARSE_ERROR") && result.integrityIssues.some((i) => i.reason === "SCHEMA_INVALID")
  );

  const resumed = createFileUsageLedger(filePath);
  const nextAppend = resumed.append(entry({ projectId: "proj-a", taskId: "t3" }));
  check("10) 손상된 줄이 있어도 재시작 후 sequence가 파싱 가능한 마지막 값부터 안전하게 이어짐", nextAppend.entry?.sequence === 3);
}

// ---------------------------------------------------------------------------
// 11) project root escape 차단.
// ---------------------------------------------------------------------------
function scenarioProjectRootEscapeBlocked(): void {
  const maliciousIds = ["../../../etc/passwd", "..\\..\\windows\\system32", "/etc/passwd", "a/b/c", "..", ".", ""];
  for (const id of maliciousIds) {
    const safeName = sanitizeProjectIdForFilename(id);
    check(`11) sanitize 결과("${id}")에 경로 구분자가 없음`, !safeName.includes("/") && !safeName.includes("\\"));
    check(`11) sanitize 결과("${id}")가 "." 또는 ".."이 아님`, safeName !== "." && safeName !== "..");
  }

  const dir = makeTempDir();
  for (const id of maliciousIds) {
    const resolved = resolveUsageLedgerFilePath(dir, id);
    check(`11) resolveUsageLedgerFilePath("${id}")가 안전하게 성공하거나 명시적으로 실패함(throw 없음)`, resolved.ok === true || resolved.ok === false);
    if (resolved.ok) {
      const normalizedDir = join(dir);
      check(`11) resolveUsageLedgerFilePath("${id}") 결과가 base 디렉터리 바로 안에 있음(탈출 없음)`, resolved.path.startsWith(normalizedDir));
    }
  }

  // undefined projectId는 고정된 "unscoped" bucket으로 안전하게 매핑된다.
  const unscoped = resolveUsageLedgerFilePath(dir, undefined);
  check("11) projectId 미지정 시 고정된 unscoped 파일로 매핑됨", unscoped.ok === true && unscoped.path.includes("_unscoped"));

  // Claude code-review(SI-3.8B) 지적 — sanitize의 allow-list만으로는 서로 다른 원본
  // projectId가 같은 파일명으로 뭉개질 수 있다("proj@a"/"proj#a"/"proj a" 모두 "proj_a"로
  // sanitize됨). 실제 resolveUsageLedgerFilePath는 원본 전체 기반 해시 접미사를 붙여 이
  // 충돌을 방지한다.
  const collisionCandidates = ["proj@a", "proj#a", "proj a", "proj-a"];
  const collisionPaths = collisionCandidates.map((id) => resolveUsageLedgerFilePath(dir, id));
  check("11) sanitize 결과가 같은 서로 다른 projectId가 서로 다른 ledger 파일로 분리됨(충돌 방지)", new Set(collisionPaths.map((r) => (r.ok ? r.path : r.error))).size === collisionCandidates.length);
  check("11) 같은 projectId는 항상 같은 파일로 결정론적으로 매핑됨", resolveUsageLedgerFilePath(dir, "proj@a").ok === true && (resolveUsageLedgerFilePath(dir, "proj@a") as { ok: true; path: string }).path === (collisionPaths[0] as { ok: true; path: string }).path);

  // Windows 예약 장치 이름(CON/PRN/AUX/NUL/COM1-9/LPT1-9)이 sanitize를 그대로 통과해도(허용된
  // 문자로만 구성되어 있으므로) 해시 접미사가 항상 붙어 파일명 stem이 예약어와 정확히
  // 일치하지 않는다.
  for (const reserved of ["CON", "con", "PRN", "NUL", "COM1", "LPT1"]) {
    const resolved = resolveUsageLedgerFilePath(dir, reserved);
    check(`11) Windows 예약 장치 이름("${reserved}")이 그대로 파일명 stem이 되지 않음`, resolved.ok === true && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])\.jsonl$/i.test(basename(resolved.path)));
  }
}

// ---------------------------------------------------------------------------
// 12) aggregation 정확성 / 13) unknown-cost entry가 집계에서 명시적으로 드러남.
// ---------------------------------------------------------------------------
function scenarioAggregation(): void {
  const entries: UsageLedgerEntry[] = [
    { ...entry({ projectId: "proj-a", taskId: "t1", provider: "openai", model: "gpt-5.6", inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedCostUsd: 0.01 }), entryId: "e1", timestamp: "t", sequence: 1 },
    { ...entry({ projectId: "proj-a", taskId: "t2", provider: "openai", model: "gpt-5.6", inputTokens: 200, outputTokens: 100, totalTokens: 300 }), entryId: "e2", timestamp: "t", sequence: 2 }, // cost unknown
    { ...entry({ projectId: "proj-b", taskId: "t3", provider: "anthropic", model: "claude", inputTokens: 10, outputTokens: 5, totalTokens: 15, estimatedCostUsd: 0.002 }), entryId: "e3", timestamp: "t", sequence: 3 },
  ];

  const total = aggregateUsageLedgerEntries(entries);
  check("12) entryCount 정확성", total.entryCount === 3);
  check("12) totalRequestCount 정확성", total.totalRequestCount === 3);
  check("12) totalInputTokens 정확성(100+200+10=310)", total.totalInputTokens === 310);
  check("12) totalOutputTokens 정확성(50+100+5=155)", total.totalOutputTokens === 155);
  check("13) knownEstimatedCostUsd는 값이 있는 entry만 합산(0.01+0.002)", Math.abs(total.knownEstimatedCostUsd - 0.012) < 1e-9);
  check("13) unknownCostEntryCount가 명시적으로 1로 드러남(전체 비용처럼 오해되지 않음)", total.unknownCostEntryCount === 1);

  const byProject = aggregateUsageLedgerByProject(entries);
  check("12) project별 집계 정확성(proj-a=2건, proj-b=1건)", byProject["proj-a"].entryCount === 2 && byProject["proj-b"].entryCount === 1);

  const byTask = aggregateUsageLedgerByTask(entries);
  check("12) task별 집계 정확성", byTask["t1"].totalInputTokens === 100 && byTask["t3"].totalInputTokens === 10);

  const byProvider = aggregateUsageLedgerByProvider(entries);
  check("12) provider별 집계 정확성", byProvider["openai"].entryCount === 2 && byProvider["anthropic"].entryCount === 1);

  const byModel = aggregateUsageLedgerByModel(entries);
  check("12) model별 집계 정확성", byModel["gpt-5.6"].entryCount === 2 && byModel["claude"].entryCount === 1);
}

// ---------------------------------------------------------------------------
// production 여부에 따른 file/in-memory 선택(event-store.ts의 selectDefaultEventStore와
// 동일한 dual-gate 원칙) — 실제 production runtime 경로(logs/usage-ledger/)는 건드리지 않고
// 임시 baseDir override만 쓴다.
// ---------------------------------------------------------------------------
function scenarioDefaultLedgerSelection(): void {
  const dir = makeTempDir();
  const originalDryRun = process.env.AUTOMATION_DRY_RUN;
  const originalProdRuntime = process.env.AUTODEV_PRODUCTION_RUNTIME;
  const expectedPath = resolveUsageLedgerFilePath(dir, "proj-a");
  if (!expectedPath.ok) throw new Error("테스트 fixture 오류: proj-a 경로 계산 실패");
  try {
    delete process.env.AUTOMATION_DRY_RUN;
    delete process.env.AUTODEV_PRODUCTION_RUNTIME;
    const devLedger = selectDefaultUsageLedgerForProject("proj-a", dir);
    devLedger.append(entry());
    check("기본 선택: 둘 다 미설정이면 in-memory(파일이 생기지 않음)", !existsSync(expectedPath.path));

    process.env.AUTOMATION_DRY_RUN = "false";
    process.env.AUTODEV_PRODUCTION_RUNTIME = "true";
    const prodLedger = selectDefaultUsageLedgerForProject("proj-a", dir);
    const appendResult = prodLedger.append(entry());
    check("기본 선택: 둘 다 true면 실제 파일 store가 선택됨(append 성공)", appendResult.ok === true);
    check("기본 선택: 프로젝트별 파일이 실제로 생성됨", existsSync(expectedPath.path));
  } finally {
    if (originalDryRun === undefined) delete process.env.AUTOMATION_DRY_RUN;
    else process.env.AUTOMATION_DRY_RUN = originalDryRun;
    if (originalProdRuntime === undefined) delete process.env.AUTODEV_PRODUCTION_RUNTIME;
    else process.env.AUTODEV_PRODUCTION_RUNTIME = originalProdRuntime;
  }
}

async function main(): Promise<void> {
  try {
    scenarioBasicAppendAndPreserve();
    scenarioFieldAccuracyAndFilter();
    scenarioCachedTokens();
    scenarioUnknownTokenFieldsSafe();
    scenarioPricingCalculator();
    scenarioNoFabricatedActualCost();
    scenarioBudgetBlockedMapping();
    scenarioNoSecretFields();
    scenarioMalformedLedgerSafe();
    scenarioProjectRootEscapeBlocked();
    scenarioAggregation();
    scenarioDefaultLedgerSelection();
  } finally {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 디렉터리 정리 실패는 테스트 결과에 영향 없음(OS temp는 결국 정리됨)
      }
    }
  }

  console.log("\n=== Usage & Cost Ledger 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
