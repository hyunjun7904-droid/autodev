import { runInNewContext } from "node:vm";
import { DASHBOARD_HTML } from "./dashboard-html";

// AutoDev / JARVIS Dashboard Stale-State Reconciliation(2026-08-28) — 이 파일이 검증하는
// 회귀: dashboard-snapshot-provider.ts는 이미 오래전부터 runtimeTruth(실제 owner 프로세스
// 생존 여부)를 계산해 DashboardSnapshot에 담아 보냈지만, 이 client script(<script> 안의
// 순수 JS 문자열, 어떤 module system도 없이 브라우저에서 그대로 실행됨)는 그 값을 전혀
// 읽지 않고 event log에서 파생된 taskStatus/runStatus만 표시했다 — 그 결과 실제
// production incident(Maintenance agent가 세션 한도로 죽은 뒤에도 11시간 넘게 대시보드가
// "검토 중"으로 표시)가 발생했다. 이 파일은 그 client script를 실제 브라우저 없이(node:vm)
// 최소 DOM/fetch stub만 주입해 실행하고, 렌더링된 innerHTML을 직접 검사한다 — 문자열
// 존재 여부(grep)가 아니라 실제 동작을 검증한다. 외부 네트워크 호출은 전혀 없다(fetch를
// 로컬 fixture로 완전히 대체).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function extractClientScript(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("dashboard-html-tests: <script> 블록을 찾지 못했습니다.");
  return match[1];
}

const CLIENT_SCRIPT = extractClientScript(DASHBOARD_HTML);

interface FakeElement {
  innerHTML: string;
  textContent: string;
}

/** CLIENT_SCRIPT를 별도 V8 context에서 실행하고(tick() → fetch → render가 자동으로 한 번
 *  실행됨), 렌더링 결과(#content/#footer)를 반환한다. fetch는 이 함수가 받은 fixture
 *  data를 그대로 resolve하는 stub이다 — 실제 HTTP 호출이 전혀 없다. */
async function renderWithFixture(data: unknown): Promise<{ content: string; footer: string }> {
  const content: FakeElement = { innerHTML: "", textContent: "" };
  const footer: FakeElement = { innerHTML: "", textContent: "" };
  const elements: Record<string, FakeElement> = { content, footer };

  const sandbox = {
    document: {
      getElementById(id: string): FakeElement {
        const el = elements[id];
        if (!el) throw new Error(`dashboard-html-tests fixture: 알 수 없는 element id ${id}`);
        return el;
      },
    },
    fetch: async (): Promise<{ json: () => Promise<unknown> }> => ({ json: async () => data }),
    setInterval: (): number => 0,
    clearInterval: (): void => {},
    console,
  };

  runInNewContext(CLIENT_SCRIPT, sandbox);
  // tick()의 fetch().then().then(render) 체인이 마이크로태스크로 끝날 때까지 매크로태스크
  // 경계를 몇 번 넘겨 기다린다(실제 지연/폴링 없이 결정론적으로 flush).
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { content: content.innerHTML, footer: footer.textContent };
}

function baseSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generatedAt: "2026-08-28T00:00:00.000Z",
    runId: "run-fixture-1234",
    projectId: "JARVIS",
    taskId: "3.1",
    taskStatus: "REVIEWING",
    runStatus: "REVIEWING",
    integrity: "CLEAN",
    integrityNote: undefined,
    currentOperation: { activeAgentRole: undefined, activeAgentId: undefined, currentAction: "리뷰 대기", elapsedMs: 1000 },
    tests: { status: "UNKNOWN" },
    review: { decision: undefined, reviewCycle: 1 },
    safety: { securityBlocked: false, checkpointStatus: "NONE", humanApprovalRequired: false },
    quality: { reviewCycleExhausted: false, firstPassApproved: undefined, reviseCount: 0 },
    historical: { firstPassApprovalRate: undefined },
    usage: { actualCostUsd: undefined, estimatedCostUsd: undefined },
    subscriptionUsage: undefined,
    development: { callCount: 0 },
    advisory: { selected: [], callCountByAgent: {}, failedAgentIds: [], completedAgentIds: [] },
    ...overrides,
  };
}

function baseData(snapshotOverrides: Record<string, unknown> = {}, dataOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "OK",
    generatedAt: "2026-08-28T00:00:00.000Z",
    snapshot: baseSnapshot(snapshotOverrides),
    projectProgress: undefined,
    actualWorkTime: {},
    usageOverview: undefined,
    recentCalls: [],
    problemSolving: undefined,
    callEfficiency: undefined,
    roundStatus: undefined,
    attemptOutcomes: undefined,
    runtimeTruth: undefined,
    ...dataOverrides,
  };
}

// ---------------------------------------------------------------------------
// A) runtimeTruth가 없으면(설정 안 됨/확인 불가) 기존 event 기반 라벨을 그대로 표시한다 —
//    기존 동작 회귀 방지.
// ---------------------------------------------------------------------------
async function scenarioNoRuntimeTruthFallsBackToEventLabel(): Promise<void> {
  const data = baseData({ taskStatus: "REVIEWING" }, { runtimeTruth: undefined });
  const { content } = await renderWithFixture(data);
  check("A) runtimeTruth 없음: 배너에 기존 이벤트 기반 라벨('검토 중')이 표시됨", content.indexOf("검토 중") !== -1);
  check("A) runtimeTruth 없음: 상태 불일치 경고가 나타나지 않음", content.indexOf("STATE_CONSISTENCY_WARNING") === -1);
}

// ---------------------------------------------------------------------------
// B) 실제 production incident 재현 — 마지막 event는 REVIEWING이지만 owner 프로세스가
//    죽었음(runtimeTruth.state=STALE). 배너가 더 이상 "검토 중"이라고 주장하면 안 된다.
// ---------------------------------------------------------------------------
async function scenarioStaleRuntimeTruthOverridesReviewingLabel(): Promise<void> {
  const data = baseData(
    { taskStatus: "REVIEWING", runStatus: "REVIEWING" },
    { runtimeTruth: { state: "STALE", reason: "owner(pid=28592)가 더 이상 살아있지 않습니다(PID_NOT_RUNNING)." } }
  );
  const { content } = await renderWithFixture(data);
  check("B) STALE: 배너가 더 이상 '검토 중'을 단독으로 주장하지 않음", content.indexOf(">오토데브 검토 중<") === -1);
  check("B) STALE: 배너/카드에 정체됨 라벨이 표시됨", content.indexOf("정체됨") !== -1);
  check("B) STALE: 상태 불일치 경고 배너가 표시됨(저장된 상태와 실제 프로세스 생존 여부가 어긋남)", content.indexOf("STATE_CONSISTENCY_WARNING") !== -1);
  check("B) STALE: 경고에 실제 사유(reason)가 그대로 포함됨", content.indexOf("PID_NOT_RUNNING") !== -1);
  check("B) STALE: 배너 톤이 RED(눈에 띄게 경고)", content.indexOf('banner badge-RED') !== -1);
}

// ---------------------------------------------------------------------------
// C) lock 자체가 없는 경우(STOPPED) — 프로세스가 죽은 것과는 다른 사유지만 마찬가지로
//    "지금 실행 중"이라고 주장하면 안 된다.
// ---------------------------------------------------------------------------
async function scenarioStoppedRuntimeTruthOverridesRunningLabel(): Promise<void> {
  const data = baseData(
    { taskStatus: "RUNNING", runStatus: "RUNNING" },
    { runtimeTruth: { state: "STOPPED", reason: "실행 중인 AutoDev process lock이 없습니다." } }
  );
  const { content } = await renderWithFixture(data);
  check("C) STOPPED: 배너가 더 이상 '실행 중'을 단독으로 주장하지 않음", content.indexOf(">오토데브 실행 중<") === -1);
  check("C) STOPPED: 중단됨 라벨이 표시됨", content.indexOf("중단됨") !== -1);
  check("C) STOPPED: 상태 불일치 경고 배너가 표시됨", content.indexOf("STATE_CONSISTENCY_WARNING") !== -1);
}

// ---------------------------------------------------------------------------
// D) owner가 실제로 살아있고 정상 RUNNING이면(§ 요구사항 30 정반대 사례) 기존처럼 정상
//    라벨을 그대로 보여주고, 상태 불일치 경고를 띄우지 않는다(오탐 방지).
// ---------------------------------------------------------------------------
async function scenarioRunningRuntimeTruthDoesNotWarn(): Promise<void> {
  const data = baseData(
    { taskStatus: "RUNNING", runStatus: "RUNNING" },
    { runtimeTruth: { state: "RUNNING", reason: "owner(pid=1234)가 실제로 실행 중입니다." } }
  );
  const { content } = await renderWithFixture(data);
  check("D) 실제로 살아있는 RUNNING: 정상 라벨이 표시됨", content.indexOf(">오토데브 실행 중<") !== -1);
  check("D) 실제로 살아있는 RUNNING: 상태 불일치 경고가 나타나지 않음(오탐 없음)", content.indexOf("STATE_CONSISTENCY_WARNING") === -1);
}

// ---------------------------------------------------------------------------
// E) WAITING_HUMAN처럼 원래도 "작업 중"으로 보이지 않는 상태는, 설령 STALE이어도 상태
//    불일치 경고를 띄우지 않는다(모순되는 조합이 아니므로) — 과도한 경고 방지.
// ---------------------------------------------------------------------------
async function scenarioNonActiveLookingStatusDoesNotWarnEvenIfStale(): Promise<void> {
  const data = baseData(
    { taskStatus: "WAITING_HUMAN", runStatus: "WAITING_HUMAN" },
    { runtimeTruth: { state: "STALE", reason: "owner(pid=1)가 더 이상 살아있지 않습니다." } }
  );
  const { content } = await renderWithFixture(data);
  check(
    "E) WAITING_HUMAN + STALE: '작업 중처럼 보이는' 상태가 아니므로 STATE_CONSISTENCY_WARNING을 띄우지 않음",
    content.indexOf("STATE_CONSISTENCY_WARNING") === -1
  );
}

async function main(): Promise<void> {
  await scenarioNoRuntimeTruthFallsBackToEventLabel();
  await scenarioStaleRuntimeTruthOverridesReviewingLabel();
  await scenarioStoppedRuntimeTruthOverridesRunningLabel();
  await scenarioRunningRuntimeTruthDoesNotWarn();
  await scenarioNonActiveLookingStatusDoesNotWarnEvenIfStale();

  console.log("\n=== dashboard-html 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
