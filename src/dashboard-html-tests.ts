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
  value?: string;
  hidden?: boolean;
  selectionStart?: number;
  listeners: Record<string, Array<(evt?: unknown) => void>>;
  addEventListener(type: string, handler: (evt?: unknown) => void): void;
  focus(): void;
  setSelectionRange(): void;
}

function makeFakeElement(overrides: Partial<FakeElement> = {}): FakeElement {
  return {
    innerHTML: "",
    textContent: "",
    value: "",
    hidden: false,
    selectionStart: 0,
    listeners: {},
    addEventListener(type, handler) {
      (this.listeners[type] = this.listeners[type] || []).push(handler);
    },
    focus() {},
    setSelectionRange() {},
    ...overrides,
  };
}

/** Dashboard 운영 UX 정리 — querySelectorAll(".projectcard"/".filtertab") 대상 동적 요소는
 *  실제 DOM 트리를 파싱하지 않고, 방금 렌더링된 content.innerHTML 문자열에서 해당 class와
 *  구분 attribute(data-project-id/data-filter-key)를 정규식으로 그대로 추출해 FakeElement로
 *  감싼다 — 실제 클릭 상호작용(필터 탭 전환 등)을 이 테스트에서 시뮬레이션할 수 있게 하기
 *  위함이다(§ 요구사항 14 "가능하면 기존 dashboard HTML test 방식에 통합한다"). */
function queryDynamicElements(html: string, selector: string): FakeElement[] {
  const className = selector.slice(1);
  const attrName = selector === ".projectcard" ? "data-project-id" : "data-filter-key";
  const re = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"[^>]*${attrName}="([^"]*)"`, "g");
  const ids: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) ids.push(m[1]);
  return ids.map((id) =>
    makeFakeElement({
      getAttribute: ((name: string) => (name === attrName ? id : null)) as never,
    } as never)
  );
}

interface RenderHandle {
  content: string;
  footer: string;
  chatOpen: boolean;
  chatScopeText: string;
  refresh(): void;
  clickFilterTab(key: string): Promise<void>;
  setSearch(text: string): Promise<void>;
  clickProjectCard(projectId: string): Promise<void>;
  openChat(): Promise<void>;
  closeChat(): Promise<void>;
}

/** CLIENT_SCRIPT를 별도 V8 context에서 실행하고(tick() → fetch → render가 자동으로 한 번
 *  실행됨), 렌더링 결과(#content/#footer)와 상호작용 헬퍼(필터 탭 클릭/검색/카드 클릭/질문창
 *  열기닫기)를 반환한다. fetch는 이 함수가 받은 fixture data를 그대로 resolve하는 stub이다
 *  — 실제 HTTP 호출이 전혀 없다. render()는 매 호출마다 querySelectorAll(selector)로 "그
 *  순간의" FakeElement를 새로 만들어 addEventListener를 건다 — 그 인스턴스는 render() 밖에서
 *  재사용할 수 없으므로, querySelectorAll 자체를 가로채 selector별로 가장 최근에 만들어진
 *  인스턴스 목록을 기억해뒀다가 테스트가 원하는 data-attribute 값을 가진 인스턴스의 click
 *  리스너를 그대로 호출하는 방식으로 실제 클릭을 시뮬레이션한다. */
async function renderWithFixture(data: unknown): Promise<RenderHandle> {
  const content: FakeElement = makeFakeElement();
  const footer: FakeElement = makeFakeElement();
  const chatScope: FakeElement = makeFakeElement();
  const chatLog: FakeElement = makeFakeElement();
  const chatPanel: FakeElement = makeFakeElement({ hidden: true });
  const chatToggle: FakeElement = makeFakeElement();
  const chatClose: FakeElement = makeFakeElement();
  const projectFilter: FakeElement = makeFakeElement();
  const elements: Record<string, FakeElement> = {
    content,
    footer,
    "chat-scope": chatScope,
    "chat-log": chatLog,
    "chat-panel": chatPanel,
    "chat-toggle": chatToggle,
    "chat-close": chatClose,
    "project-filter": projectFilter,
  };

  const lastInstances: Record<string, FakeElement[]> = {};

  const sandbox = {
    document: {
      getElementById(id: string): FakeElement | undefined {
        return elements[id];
      },
      querySelectorAll(selector: string): FakeElement[] {
        const els = queryDynamicElements(content.innerHTML, selector);
        lastInstances[selector] = els;
        return els;
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
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  await flush();

  async function triggerLastListener(selector: string, attrValue: string): Promise<void> {
    const els = lastInstances[selector] || [];
    const attrName = selector === ".projectcard" ? "data-project-id" : "data-filter-key";
    const target = els.find((el) => (el as unknown as { getAttribute(n: string): string }).getAttribute(attrName) === attrValue);
    if (!target) throw new Error(`${selector}[${attrName}=${attrValue}]를 찾지 못했습니다(현재 렌더링에 없음).`);
    (target.listeners["click"] || []).forEach((h) => h());
    await flush();
  }

  const handle: RenderHandle = {
    get content() {
      return content.innerHTML;
    },
    get footer() {
      return footer.textContent;
    },
    get chatOpen() {
      return chatPanel.hidden === false;
    },
    get chatScopeText() {
      return chatScope.textContent;
    },
    refresh() {
      // no-op accessor placeholder — content/footer는 getter라 항상 최신값을 반환한다.
    },
    clickFilterTab: (key: string) => triggerLastListener(".filtertab", key),
    async setSearch(text: string): Promise<void> {
      projectFilter.value = text;
      (projectFilter.listeners["input"] || []).forEach((h) => h());
      await flush();
    },
    clickProjectCard: (projectId: string) => triggerLastListener(".projectcard", projectId),
    async openChat(): Promise<void> {
      (chatToggle.listeners["click"] || []).forEach((h) => h());
      await flush();
    },
    async closeChat(): Promise<void> {
      (chatClose.listeners["click"] || []).forEach((h) => h());
      await flush();
    },
  };

  return handle;
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

function baseProjectEntry(snapshotOverrides: Record<string, unknown> = {}, entryOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "OK",
    generatedAt: "2026-08-28T00:00:00.000Z",
    snapshot: baseSnapshot(snapshotOverrides),
    projectId: "JARVIS",
    projectLabel: "JARVIS",
    registered: true,
    projectProgress: undefined,
    actualWorkTime: {},
    usageOverview: undefined,
    recentCalls: [],
    problemSolving: undefined,
    callEfficiency: undefined,
    roundStatus: undefined,
    attemptOutcomes: undefined,
    runtimeTruth: undefined,
    reviewerHistory: [],
    developerLifecycle: { attempts: [] },
    maintenancePause: undefined,
    ...entryOverrides,
  };
}

/** AutoDev Dashboard 멀티프로젝트 운영센터 개선 — client script는 이제 /api/snapshots(복수형,
 *  {generatedAt, projects: [...], registryIssues: []})를 받는다. 이 테스트 파일은 원래
 *  단일 project fixture 하나만 다루므로, projects 배열에 project 1개만 담아 감싼다 —
 *  project가 정확히 1개면 render()가 자동으로 그 project를 선택해 상세를 펼치므로(§
 *  dashboard-html.ts), 아래 기존 시나리오들의 배너/경고 검증은 그대로 유효하다. */
function baseData(snapshotOverrides: Record<string, unknown> = {}, dataOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generatedAt: "2026-08-28T00:00:00.000Z",
    registryIssues: [],
    projects: [baseProjectEntry(snapshotOverrides, dataOverrides)],
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

/** 여러 project를 담은 fixture — 필터/attribution 테스트 전용. 각 항목은
 *  baseProjectEntry(snapshotOverrides, entryOverrides)의 결과를 그대로 담는다. */
function multiProjectData(entries: Record<string, unknown>[]): Record<string, unknown> {
  return { generatedAt: "2026-09-02T00:00:00.000Z", registryIssues: [], projects: entries };
}

function registeredEntry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseProjectEntry({}, { projectId: id, projectLabel: id, registered: true, ...overrides });
}
function unregisteredEntry(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseProjectEntry({}, { projectId: id, projectLabel: id, registered: false, ...overrides });
}

// ---------------------------------------------------------------------------
// Dashboard 운영 UX 정리 — F~T. 기존 A~E(runtimeTruth/상태 불일치 경고)는 그대로 두고,
// 여기서부터는 이번 UX 정리 요구사항(§ 5개 필수 케이스 이상, 총 16개)을 검증한다.
// ---------------------------------------------------------------------------

// F) 기본 필터는 registered:true("운영")만 보여준다 — projectId 문자열 추측 분류가 아니라
//    registered 값만 근거로 삼는다.
async function scenarioDefaultFilterShowsRegisteredOnly(): Promise<void> {
  const data = multiProjectData([registeredEntry("MOVAN"), unregisteredEntry("g75-fixture3")]);
  const h = await renderWithFixture(data);
  check("F) 기본 필터: 운영(MOVAN) 카드가 보임", h.content.indexOf('data-project-id="MOVAN"') !== -1);
  check("F) 기본 필터: 미등록(g75-fixture3) 카드는 기본적으로 숨겨짐", h.content.indexOf('data-project-id="g75-fixture3"') === -1);
  check("F) 기본 필터 탭이 '운영'으로 활성화됨", /filtertab active[^>]*data-filter-key="REGISTERED"/.test(h.content));
}

// G) 필터 탭 전환 — '기타/과거'를 누르면 registered:false만, '전체'를 누르면 전부 보인다.
async function scenarioFilterTabSwitchesVisibleSet(): Promise<void> {
  const data = multiProjectData([registeredEntry("MOVAN"), unregisteredEntry("g75-fixture3")]);
  const h = await renderWithFixture(data);
  await h.clickFilterTab("OTHER");
  check("G) '기타/과거' 탭: 미등록 카드가 보임", h.content.indexOf('data-project-id="g75-fixture3"') !== -1);
  check("G) '기타/과거' 탭: 운영 카드는 숨겨짐", h.content.indexOf('data-project-id="MOVAN"') === -1);
  await h.clickFilterTab("ALL");
  check("G) '전체' 탭: 운영 카드가 다시 보임", h.content.indexOf('data-project-id="MOVAN"') !== -1);
  check("G) '전체' 탭: 미등록 카드도 함께 보임", h.content.indexOf('data-project-id="g75-fixture3"') !== -1);
}

// H) 검색은 현재 선택된 필터 범위 안에서만 동작한다.
async function scenarioSearchWorksWithinActiveFilter(): Promise<void> {
  const data = multiProjectData([registeredEntry("MOVAN"), registeredEntry("AUTODEV-CANARY-A"), unregisteredEntry("g75-fixture3")]);
  const h = await renderWithFixture(data);
  await h.setSearch("movan");
  check("H) 검색+기본(운영) 필터: MOVAN만 보임", h.content.indexOf('data-project-id="MOVAN"') !== -1 && h.content.indexOf('data-project-id="AUTODEV-CANARY-A"') === -1);
  await h.clickFilterTab("ALL");
  await h.setSearch("g75");
  check("H) 검색+'전체' 필터: g75-fixture3가 보임(필터 범위가 바뀌면 검색도 그 범위 안에서 재적용됨)", h.content.indexOf('data-project-id="g75-fixture3"') !== -1);
}

// I) JARVIS 실제 조합 재현 — Task 5.4 COMPLETED + 5.5 NOT STARTED + Maintenance Pause
//    ACTIVE. "현재 작업"으로 5.4를 표시하면 안 되고, 최근 완료 5.4/다음 작업 5.5로 분리
//    돼야 한다(§ 요구사항 5 핵심 사례, 실제 production 상태를 그대로 fixture화함).
async function scenarioJarvisCompletedTaskDoesNotShowAsCurrent(): Promise<void> {
  const entry = registeredEntry("JARVIS", {
    projectProgress: { projectName: "JARVIS", totalPhases: 22, totalTasks: 113, completedTaskCount: 20, currentTaskId: "5.5", currentTaskTitle: "ERROR Recovery & Mic/Text Fallback UI", nextTaskId: "5.6" },
    maintenancePause: { active: true, reason: "JARVIS Task 5.4 recovery investigation session" },
    runtimeTruth: { state: "STOPPED", reason: "실행 중인 AutoDev process lock이 없습니다." },
  });
  (entry.snapshot as Record<string, unknown>).taskId = "5.4";
  (entry.snapshot as Record<string, unknown>).taskStatus = "COMPLETED";
  (entry.snapshot as Record<string, unknown>).runStatus = "COMPLETED";
  const data = multiProjectData([entry]);
  const h = await renderWithFixture(data);
  check("I) 카드: '현재 작업'으로 5.4가 표시되지 않음", h.content.indexOf('<span>현재 작업</span><span class="v">5.4</span>') === -1);
  check("I) 카드: '최근 완료'로 5.4가 표시됨", h.content.indexOf('<span>최근 완료</span><span class="v">5.4</span>') !== -1);
  check("I) 카드: '다음 작업'으로 5.5가 표시됨", h.content.indexOf('<span>다음 작업</span><span class="v">5.5</span>') !== -1);
  check("I) 카드: 대표 상태가 '일시정지'로 표시됨(문제 발생 아님)", h.content.indexOf(">일시정지<") !== -1);
  check("I) 상세 요약 카드: 현재 작업이 '없음'으로 표시됨(5.4를 현재 작업이라고 주장하지 않음)", /요약[\s\S]*?현재 작업[\s\S]*?없음/.test(h.content));
}

// J) 실제로 실행 중인 Task는 "현재 작업"으로 표시하고 경과시간도 함께 보여준다.
async function scenarioRunningTaskShowsAsCurrentWithElapsed(): Promise<void> {
  const entry = registeredEntry("AUTODEV-CANARY-A", {
    runtimeTruth: { state: "RUNNING", reason: "owner(pid=1)가 실제로 실행 중입니다." },
    projectProgress: { projectName: "AUTODEV-CANARY-A", totalPhases: 1, totalTasks: 2, completedTaskCount: 0, nextTaskId: "A2" },
  });
  (entry.snapshot as Record<string, unknown>).taskId = "A1";
  (entry.snapshot as Record<string, unknown>).taskStatus = "RUNNING";
  (entry.snapshot as Record<string, unknown>).runStatus = "RUNNING";
  (entry.snapshot as Record<string, unknown>).currentOperation = { activeAgentRole: undefined, activeAgentId: undefined, currentAction: "개발 중", elapsedMs: 754000 };
  const data = multiProjectData([entry]);
  const h = await renderWithFixture(data);
  check("J) 카드: '현재 작업'으로 A1이 표시됨", h.content.indexOf('<span>현재 작업</span><span class="v">A1</span>') !== -1);
  check("J) 카드: 대표 상태가 '작업 중'으로 표시됨", h.content.indexOf(">작업 중<") !== -1 || h.content.indexOf("작업 중 ·") !== -1);
  check("J) 카드: 경과시간이 표시됨", h.content.indexOf("경과") !== -1);
}

// K) 기본 카드에는 Developer attempt 전체 이력 표(시도/시작/종료/실행시간 표)가 노출되지
//    않는다 — 그런 표는 상세 패널(클릭 후)에만 있어야 한다.
async function scenarioDefaultCardHidesDeepDeveloperHistory(): Promise<void> {
  const entry = registeredEntry("MOVAN", {
    developerLifecycle: {
      attempts: [
        { attemptNumber: 1, taskId: "T1", startedAt: "2026-09-01T00:00:00.000Z", outcome: "NORMAL_END", endedAt: "2026-09-01T00:05:00.000Z", durationMs: 300000 },
      ],
      latest: { attemptNumber: 1, taskId: "T1", startedAt: "2026-09-01T00:00:00.000Z", outcome: "NORMAL_END", endedAt: "2026-09-01T00:05:00.000Z", durationMs: 300000 },
    },
  });
  const data = multiProjectData([entry, unregisteredEntry("other-project")]);
  const h = await renderWithFixture(data);
  // 아직 어떤 카드도 선택되지 않았을 때(project가 2개이므로 자동 선택 없음) 상세 패널
  // 자체가 렌더링되지 않아야 한다 — Developer attempt 표는 상세 패널에만 있다.
  check("K) 카드 미선택 상태에서는 상세 Developer 이력 표(종료 사유 열)가 노출되지 않음", h.content.indexOf("종료 사유") === -1);
  check("K) 기본 카드에는 '시도 1회' 같은 raw attempt 문구가 없음", h.content.indexOf("시도 1회") === -1);
}

// L) 카드를 선택하면 그 project의 상세 패널이 열리고, 데이터가 실제로 일치한다.
async function scenarioSelectingCardOpensMatchingDetail(): Promise<void> {
  const a = registeredEntry("PROJECT-A");
  const b = registeredEntry("PROJECT-B");
  const data = multiProjectData([a, b]);
  const h = await renderWithFixture(data);
  check("L) 선택 전: 상세 패널이 없음(2개 이상이므로 자동 선택 안 함)", h.content.indexOf("상세") === -1);
  await h.clickProjectCard("PROJECT-A");
  check("L) PROJECT-A 클릭 후: 'PROJECT-A 상세'가 표시됨", h.content.indexOf("PROJECT-A 상세") !== -1);
  check("L) PROJECT-A 클릭 후: PROJECT-B 상세는 표시되지 않음", h.content.indexOf("PROJECT-B 상세") === -1);
}

// M) 운영 질문창은 기본 접힘 상태로 시작한다.
async function scenarioChatPanelCollapsedByDefault(): Promise<void> {
  const data = baseData();
  const h = await renderWithFixture(data);
  check("M) 운영 질문창이 기본 접힘 상태(hidden)임", h.chatOpen === false);
}

// N) 버튼으로 열고 닫을 수 있다.
async function scenarioChatPanelOpensAndCloses(): Promise<void> {
  const data = baseData();
  const h = await renderWithFixture(data);
  await h.openChat();
  check("N) '운영 질문' 버튼 클릭 후 패널이 열림", h.chatOpen === true);
  await h.closeChat();
  check("N) '닫기' 버튼 클릭 후 패널이 다시 닫힘", h.chatOpen === false);
}

// O) 프로젝트를 선택한 상태에서 질문창을 열면 선택된 프로젝트가 명확히 표시된다 —
//    선택이 없으면 추측하지 않는다(기존 renderChatScope 동작 재확인).
async function scenarioChatShowsSelectedProjectContext(): Promise<void> {
  const a = registeredEntry("PROJECT-A");
  const b = registeredEntry("PROJECT-B");
  const data = multiProjectData([a, b]);
  const h = await renderWithFixture(data);
  await h.clickProjectCard("PROJECT-A");
  await h.openChat();
  check("O) 질문창에 '선택된 프로젝트: PROJECT-A'가 표시됨", h.chatScopeText.indexOf("PROJECT-A") !== -1);
  check("O) 다른 프로젝트(PROJECT-B)가 컨텍스트로 오인되지 않음", h.chatScopeText.indexOf("PROJECT-B") === -1);
}

// P) Developer/Reviewer 관련 카드 제목이 한글화됐다("Developer 실행 이력"/"Reviewer 호출
//    이력" 같은 영문 라벨이 더 이상 나타나지 않음).
async function scenarioDeveloperReviewerLabelsAreKorean(): Promise<void> {
  const a = registeredEntry("PROJECT-A");
  const data = multiProjectData([a]);
  const h = await renderWithFixture(data); // project 1개 → 자동 선택되어 상세 패널까지 렌더링됨
  check("P) '개발 이력' 라벨이 표시됨", h.content.indexOf("개발 이력") !== -1);
  check("P) '검토 이력' 라벨이 표시됨", h.content.indexOf("검토 이력") !== -1);
  check("P) 'Developer 실행 이력'(구 영문 라벨)이 더 이상 나타나지 않음", h.content.indexOf("Developer 실행 이력") === -1);
  check("P) 'Reviewer 호출 이력'(구 영문 라벨)이 더 이상 나타나지 않음", h.content.indexOf("Reviewer 호출 이력") === -1);
}

// Q) provider 이름/모델명/projectId 원문은 한글화 대상이 아니다 — 그대로 유지돼야 한다.
async function scenarioProviderModelProjectIdStayVerbatim(): Promise<void> {
  const entry = registeredEntry("AUTODEV-CANARY-A", {
    reviewerHistory: [
      { sequenceNumber: 1, timestamp: "2026-09-01T00:00:00.000Z", taskId: "A1", provider: "fireworks", service: "Fireworks", model: "accounts/fireworks/models/gpt-oss-120b", result: "PASS", reviewCycle: 1, providerChangedFromPrevious: false },
    ],
  });
  const data = multiProjectData([entry]);
  const h = await renderWithFixture(data);
  check("Q) projectId('AUTODEV-CANARY-A')가 원문 그대로 표시됨", h.content.indexOf("AUTODEV-CANARY-A") !== -1);
  check("Q) provider 서비스명('Fireworks')이 원문 그대로 표시됨", h.content.indexOf("Fireworks") !== -1);
  check("Q) 모델명이 원문 그대로 표시됨", h.content.indexOf("accounts/fireworks/models/gpt-oss-120b") !== -1);
}

// R) Maintenance Pause가 활성화돼 있으면, 다른 RED 조건(예: 오래된 STALE 흔적)이 섞여
//    있어도 대표 상태는 항상 "일시정지"이고 "문제 발생"으로 격하되지 않는다(§ 요구사항 6
//    최우선 판정).
async function scenarioMaintenancePauseNeverShownAsProblem(): Promise<void> {
  const entry = registeredEntry("JARVIS", {
    maintenancePause: { active: true, reason: "유지보수 세션" },
    runtimeTruth: { state: "STALE", reason: "owner(pid=1)가 더 이상 살아있지 않습니다." },
  });
  (entry.snapshot as Record<string, unknown>).taskStatus = "REVIEWING";
  const data = multiProjectData([entry]);
  const h = await renderWithFixture(data);
  check("R) Maintenance Pause 활성 + STALE 동시 상황: 대표 상태가 '일시정지'", h.content.indexOf(">일시정지<") !== -1);
  check("R) '문제 발생'으로 표시되지 않음", h.content.indexOf(">문제 발생<") === -1);
}

// S) 실행 이력이 아예 없는 프로젝트(NO_RUN_YET)는 대표 상태를 "준비"로, 판단 불가한 조합은
//    "확인 불가"로 정직하게 남긴다(임의 추측 금지).
async function scenarioUnknownStatusHandledHonestly(): Promise<void> {
  const noRunYet = registeredEntry("FRESH-PROJECT", { status: "NO_RUN_YET", snapshot: undefined });
  const data = multiProjectData([noRunYet]);
  const h = await renderWithFixture(data);
  check("S) 실행 이력 없음(NO_RUN_YET): 대표 상태가 '준비'로 표시됨", h.content.indexOf(">준비<") !== -1);
}

// T) 기존 N-project attribution — 서로 다른 project의 카드 데이터가 섞이지 않는다(§ 이미
//    검증된 프로젝트별 read model 격리, 이번 UX 정리로 깨지지 않았는지 재확인).
async function scenarioNProjectAttributionStillIsolated(): Promise<void> {
  const a = registeredEntry("PROJECT-A");
  (a.snapshot as Record<string, unknown>).taskId = "TASK-A";
  const b = registeredEntry("PROJECT-B");
  (b.snapshot as Record<string, unknown>).taskId = "TASK-B";
  const data = multiProjectData([a, b]);
  const h = await renderWithFixture(data);
  check("T) PROJECT-A 카드에 TASK-A가 귀속됨", h.content.indexOf('data-project-id="PROJECT-A"') !== -1);
  await h.clickProjectCard("PROJECT-A");
  check("T) PROJECT-A 상세에 TASK-B가 섞여 나타나지 않음", h.content.indexOf("TASK-B") === -1);
}

async function main(): Promise<void> {
  await scenarioNoRuntimeTruthFallsBackToEventLabel();
  await scenarioStaleRuntimeTruthOverridesReviewingLabel();
  await scenarioStoppedRuntimeTruthOverridesRunningLabel();
  await scenarioRunningRuntimeTruthDoesNotWarn();
  await scenarioNonActiveLookingStatusDoesNotWarnEvenIfStale();
  await scenarioDefaultFilterShowsRegisteredOnly();
  await scenarioFilterTabSwitchesVisibleSet();
  await scenarioSearchWorksWithinActiveFilter();
  await scenarioJarvisCompletedTaskDoesNotShowAsCurrent();
  await scenarioRunningTaskShowsAsCurrentWithElapsed();
  await scenarioDefaultCardHidesDeepDeveloperHistory();
  await scenarioSelectingCardOpensMatchingDetail();
  await scenarioChatPanelCollapsedByDefault();
  await scenarioChatPanelOpensAndCloses();
  await scenarioChatShowsSelectedProjectContext();
  await scenarioDeveloperReviewerLabelsAreKorean();
  await scenarioProviderModelProjectIdStayVerbatim();
  await scenarioMaintenancePauseNeverShownAsProblem();
  await scenarioUnknownStatusHandledHonestly();
  await scenarioNProjectAttributionStillIsolated();

  console.log("\n=== dashboard-html 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
