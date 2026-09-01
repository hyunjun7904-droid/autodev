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

/** Dashboard 운영 UX 정리/최종 정리 — querySelectorAll(".projectcard"/".filtertab[data-*]"/
 *  ".collapse-header[data-collapse-key]") 대상 동적 요소는 실제 DOM 트리를 파싱하지 않고,
 *  방금 렌더링된 content.innerHTML 문자열에서 해당 class와 구분 attribute를 정규식으로
 *  그대로 추출해 FakeElement로 감싼다 — 실제 클릭 상호작용(필터 탭 전환/카드 클릭/접힘
 *  토글 등)을 이 테스트에서 시뮬레이션할 수 있게 하기 위함이다(§ 요구사항 14 "가능하면
 *  기존 dashboard HTML test 방식에 통합한다"). selector는 ".class" 또는
 *  ".class[data-attr]" 형태만 지원한다 — client script가 실제로 쓰는 형태와 정확히
 *  일치한다(둘 다 실제 브라우저 CSS로도 유효한 선택자다). attrName을 selector에서 직접
 *  파싱하므로(§ 요구사항: attrName을 selector 문자열별로 하드코딩하지 않는다) 새 접힘
 *  섹션/필터를 추가할 때 이 함수를 다시 손댈 필요가 없다 — 단 .projectcard만 과거 호환을
 *  위해 attribute 명시 없이도 data-project-id로 인식한다. */
function queryDynamicElements(html: string, selector: string): FakeElement[] {
  const m = /^\.([\w-]+)(?:\[([\w-]+)\])?$/.exec(selector);
  if (!m) throw new Error(`queryDynamicElements: 지원하지 않는 selector 형식입니다: ${selector}`);
  const className = m[1];
  const attrName = m[2] ?? (className === "projectcard" ? "data-project-id" : "data-filter-key");
  const re = new RegExp(`class="[^"]*\\b${className}\\b[^"]*"[^>]*${attrName}="([^"]*)"`, "g");
  const ids: string[] = [];
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(html))) ids.push(mm[1]);
  return ids.map((id) =>
    makeFakeElement({
      getAttribute: ((name: string) => (name === attrName ? id : null)) as never,
    } as never)
  );
}

/** id 기반 동적 요소(예: 활동 기록 "전체 기록 보기" 버튼) — 매 render()마다 innerHTML 안에
 *  생겼다 사라졌다 하므로 정적 elements map에 미리 등록해둘 수 없다. content.innerHTML에서
 *  `id="<id>"`를 그대로 찾아 FakeElement로 감싼다 — 실제 브라우저의
 *  document.getElementById()가 매번 최신 DOM을 다시 찾는 것과 동일한 동작이다. */
function queryDynamicElementById(html: string, id: string): FakeElement | undefined {
  const re = new RegExp(`id="${id}"`);
  if (!re.test(html)) return undefined;
  return makeFakeElement();
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
  /** Dashboard 운영 UX 최종 정리 — 활동 기록/사용량·호출/Git/Baseline 접힘 토글. */
  clickCollapseHeader(key: string): Promise<void>;
  /** 활동 기록 필터 탭("전체"/"개발"/"검토"/"외부 호출"/"실패"). */
  clickActivityFilter(key: string): Promise<void>;
  /** 활동 기록 "전체 기록 보기" 버튼 — 없으면 아무 일도 하지 않는다(항목이 8건 이하). */
  clickActivityShowAll(): Promise<void>;
  /** § 요구사항 7 "frontend polling 점검" 전용 — 실제 fetch가 호출된 횟수. */
  fetchCallCount: number;
  /** setInterval(tick, REFRESH_MS)에 등록된 콜백을 그대로 호출해 "다음 polling 주기가
   *  됐다"를 시뮬레이션한다(실제 타이머 지연 없이 결정론적으로). */
  triggerPoll(): Promise<void>;
  /** opts.slowFetch일 때만 의미가 있다 — 가장 오래 대기 중인 fetch를 resolve한다. */
  releaseSlowFetch(): Promise<void>;
}

/** CLIENT_SCRIPT를 별도 V8 context에서 실행하고(tick() → fetch → render가 자동으로 한 번
 *  실행됨), 렌더링 결과(#content/#footer)와 상호작용 헬퍼(필터 탭 클릭/검색/카드 클릭/질문창
 *  열기닫기)를 반환한다. fetch는 이 함수가 받은 fixture data를 그대로 resolve하는 stub이다
 *  — 실제 HTTP 호출이 전혀 없다. render()는 매 호출마다 querySelectorAll(selector)로 "그
 *  순간의" FakeElement를 새로 만들어 addEventListener를 건다 — 그 인스턴스는 render() 밖에서
 *  재사용할 수 없으므로, querySelectorAll 자체를 가로채 selector별로 가장 최근에 만들어진
 *  인스턴스 목록을 기억해뒀다가 테스트가 원하는 data-attribute 값을 가진 인스턴스의 click
 *  리스너를 그대로 호출하는 방식으로 실제 클릭을 시뮬레이션한다. */
async function renderWithFixture(data: unknown, opts: { slowFetch?: boolean } = {}): Promise<RenderHandle> {
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
  // id 기반 동적 요소(예: "activity-show-all")도 render()마다 다시 찾아야 하므로 selector와
  // 동일하게 "가장 최근에 찾은 인스턴스"를 기억해둔다.
  const lastById: Record<string, FakeElement | undefined> = {};

  let fetchCallCount = 0;
  const pendingFetchResolvers: Array<() => void> = [];
  let capturedIntervalFn: (() => void) | undefined;

  const sandbox = {
    document: {
      getElementById(id: string): FakeElement | undefined {
        if (elements[id]) return elements[id];
        const el = queryDynamicElementById(content.innerHTML, id);
        lastById[id] = el;
        return el;
      },
      querySelectorAll(selector: string): FakeElement[] {
        const els = queryDynamicElements(content.innerHTML, selector);
        lastInstances[selector] = els;
        return els;
      },
    },
    // § 요구사항 7 "frontend polling 점검" — opts.slowFetch면 fetch가 releaseSlowFetch()를
    // 호출할 때까지 resolve되지 않는다(실제로 snapshot 계산이 느려 응답이 늦는 상황을
    // 재현). fetchCallCount로 "이전 요청이 끝나기 전에 다음 요청이 나갔는지"를 직접 센다.
    fetch: async (): Promise<{ json: () => Promise<unknown> }> => {
      fetchCallCount += 1;
      if (opts.slowFetch) {
        await new Promise<void>((resolve) => pendingFetchResolvers.push(resolve));
      }
      return { json: async () => data };
    },
    // 실제 3초 타이머 대신, 이 콜백을 캡처해두고 triggerPoll()이 수동으로 호출한다(결정론적).
    setInterval: (fn: () => void): number => {
      capturedIntervalFn = fn;
      return 0;
    },
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

  async function triggerLastListener(selector: string, attrName: string, attrValue: string): Promise<void> {
    const els = lastInstances[selector] || [];
    const target = els.find((el) => (el as unknown as { getAttribute(n: string): string }).getAttribute(attrName) === attrValue);
    if (!target) throw new Error(`${selector}[${attrName}=${attrValue}]를 찾지 못했습니다(현재 렌더링에 없음).`);
    (target.listeners["click"] || []).forEach((h) => h());
    await flush();
  }

  async function triggerById(id: string): Promise<void> {
    const target = lastById[id];
    if (!target) return; // 존재하지 않으면(예: 항목이 적어 "전체 기록 보기" 버튼이 없음) 조용히 무시한다.
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
    clickFilterTab: (key: string) => triggerLastListener(".filtertab[data-filter-key]", "data-filter-key", key),
    clickCollapseHeader: (key: string) => triggerLastListener(".collapse-header[data-collapse-key]", "data-collapse-key", key),
    clickActivityFilter: (key: string) => triggerLastListener(".filtertab[data-activity-filter]", "data-activity-filter", key),
    clickActivityShowAll: () => triggerById("activity-show-all"),
    get fetchCallCount() {
      return fetchCallCount;
    },
    async triggerPoll(): Promise<void> {
      if (capturedIntervalFn) capturedIntervalFn();
      await flush();
    },
    async releaseSlowFetch(): Promise<void> {
      const resolve = pendingFetchResolvers.shift();
      if (resolve) resolve();
      await flush();
    },
    async setSearch(text: string): Promise<void> {
      projectFilter.value = text;
      (projectFilter.listeners["input"] || []).forEach((h) => h());
      await flush();
    },
    clickProjectCard: (projectId: string) => triggerLastListener(".projectcard", "data-project-id", projectId),
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

// ---------------------------------------------------------------------------
// Dashboard 운영 UX 최종 정리 — U~AB. 활동 기록 통합/접힘 섹션/문제·Blocker 통합/작업 흐름/
// 진행률 단순화/frontend polling backlog 방지를 검증한다.
// ---------------------------------------------------------------------------

function activityFixtureEntry(): Record<string, unknown> {
  return registeredEntry("ACT-PROJECT", {
    developerLifecycle: {
      attempts: [
        { attemptNumber: 1, taskId: "T1", startedAt: "2026-09-01T00:00:00.000Z", outcome: "NORMAL_END", endedAt: "2026-09-01T00:05:00.000Z", durationMs: 300000 },
        { attemptNumber: 2, taskId: "T1", startedAt: "2026-09-01T00:10:00.000Z", outcome: "ABNORMAL_END", endedAt: "2026-09-01T00:12:00.000Z", durationMs: 120000 },
      ],
      latest: { attemptNumber: 2, taskId: "T1", startedAt: "2026-09-01T00:10:00.000Z", outcome: "ABNORMAL_END", endedAt: "2026-09-01T00:12:00.000Z", durationMs: 120000 },
    },
    reviewerHistory: [
      { sequenceNumber: 1, timestamp: "2026-09-01T00:06:00.000Z", taskId: "T1", provider: "fireworks", service: "Fireworks", model: "gpt-oss-120b", result: "REVISE", reviewCycle: 1, providerChangedFromPrevious: false },
    ],
    recentCalls: [
      { timestamp: "2026-09-01T00:07:00.000Z", taskId: "T1", purpose: "개발", service: "Anthropic", model: "claude", totalTokens: 100, success: true },
    ],
    usageOverview: { allTime: { totals: { inputTokens: 10, outputTokens: 10, totalTokens: 20, callCount: 42 }, byService: [] }, currentTask: undefined, usageLedgerEntryCount: 0 },
    attemptOutcomes: {
      successCount: 3,
      failureCount: 2,
      recent: [
        { occurredAt: "2026-09-01T00:12:00.000Z", taskId: "T1", result: "FAILURE", reason: "테스트 실패", commitHash: undefined },
        { occurredAt: "2026-09-01T00:01:00.000Z", taskId: "T0", result: "SUCCESS", reason: undefined, commitHash: "abc1234" },
      ],
    },
  });
}

// U) 활동 기록은 기본 접힘이며, 접힌 상태에서도 개발/검토/외부 호출/성공/실패 요약 숫자가
//    보인다(§ 요구사항 16 예시 teaser).
async function scenarioActivityLogCollapsedByDefaultWithTeaser(): Promise<void> {
  const data = multiProjectData([activityFixtureEntry()]);
  const h = await renderWithFixture(data);
  check("U) 활동 기록 제목이 보임", h.content.indexOf("활동 기록") !== -1);
  check("U) 접힌 상태에서도 '개발 2회' teaser가 보임", h.content.indexOf("개발") !== -1 && h.content.indexOf("2회") !== -1);
  check("U) 접힌 상태에서도 '외부 호출 42회'(usageOverview 누적 호출 수) teaser가 보임", h.content.indexOf("42회") !== -1);
  check("U) 접힌 상태에서는 상세 표(구분/내용 헤더)가 그려지지 않음", h.content.indexOf("<th>구분</th>") === -1);
}

// V) 헤더를 클릭하면 펼쳐지고, 기본은 최근 항목만 보이며 "전체 기록 보기"로 전체를 볼 수 있다.
async function scenarioActivityLogExpandsAndShowsAll(): Promise<void> {
  const data = multiProjectData([activityFixtureEntry()]);
  const h = await renderWithFixture(data);
  await h.clickCollapseHeader("activity");
  check("V) 펼친 뒤에는 상세 표 헤더가 보임", h.content.indexOf("<th>구분</th>") !== -1);
  check("V) 개발 시도 항목이 목록에 보임", h.content.indexOf("1번째 시도") !== -1);
  check("V) Reviewer 호출 항목이 목록에 보임", h.content.indexOf("REVISE") !== -1 || h.content.indexOf("수정 요청") !== -1);
}

// W) 활동 기록 필터 탭 — "개발"을 선택하면 검토/외부 호출 항목은 사라지고 개발 항목만 남는다.
async function scenarioActivityLogFilterNarrowsToOneType(): Promise<void> {
  const data = multiProjectData([activityFixtureEntry()]);
  const h = await renderWithFixture(data);
  await h.clickCollapseHeader("activity");
  await h.clickActivityFilter("개발");
  check("W) '개발' 필터: 개발 시도 항목이 보임", h.content.indexOf("1번째 시도") !== -1);
  // 참고: "최근 검토" 요약 카드(항상 보임, § renderReviewerHistory)에도 service명이 나타날 수
  // 있으므로, 활동 기록 항목 고유 형식("#순번 · service", § buildActivityItems)으로 검사한다.
  check("W) '개발' 필터: 활동 기록 목록에는 검토 항목('#1 · Fireworks')이 나타나지 않음", h.content.indexOf("#1 · Fireworks") === -1);
}

// X) 사용량/호출, Git, Baseline은 기본 접힘이고 헤더 클릭으로 펼쳐진다 — 데이터는 삭제되지
//    않는다(펼치면 그대로 나타남).
async function scenarioUsageGitBaselineCollapsedThenExpand(): Promise<void> {
  const entry = registeredEntry("COLLAPSE-PROJECT", {
    usageOverview: { allTime: { totals: { inputTokens: 1, outputTokens: 1, totalTokens: 2, callCount: 1 }, byService: [] }, currentTask: undefined, usageLedgerEntryCount: 0 },
    attemptOutcomes: { successCount: 1, failureCount: 0, recent: [{ occurredAt: "2026-09-01T00:00:00.000Z", taskId: "T1", result: "SUCCESS", reason: undefined, commitHash: "deadbee" }] },
    baseline: { developerCallCount: 1, reviewerCallCount: 1, taskDurationMs: 1000, reviseCount: 0 },
  });
  const data = multiProjectData([entry]);
  const h = await renderWithFixture(data);
  check("X) 접힌 상태: 커밋 해시(deadbee)가 보이지 않음", h.content.indexOf("deadbee") === -1);
  check("X) 접힌 상태: '기준 데이터 없음' 문구가 보이지 않음", h.content.indexOf("기준 데이터 없음") === -1);
  await h.clickCollapseHeader("git");
  check("X) Git 섹션 펼침: 커밋 해시가 보임", h.content.indexOf("deadbee") !== -1);
  await h.clickCollapseHeader("baseline");
  check("X) Baseline 섹션 펼침: '기준 데이터 없음'이 보임(가짜 %로 채우지 않음)", h.content.indexOf("기준 데이터 없음") !== -1);
}

// Y) "현재 문제 해결 상황" 카드가 지연/Blocker 근거를 흡수한다(별도 카드가 없다) — 문제가
//    없어도 사람 승인 대기 같은 blocker가 있으면 카드 자체는 보인다.
async function scenarioProblemCardAbsorbsBlockerEvidence(): Promise<void> {
  const entry = registeredEntry("BLOCKER-PROJECT");
  (entry.snapshot as Record<string, unknown>).taskStatus = "WAITING_HUMAN";
  const data = multiProjectData([entry]);
  const h = await renderWithFixture(data);
  check("Y) '현재 문제 해결 상황' 카드가 보임", h.content.indexOf("현재 문제 해결 상황") !== -1);
  check("Y) '현재 Blocker' 행에 사람 승인 대기 근거가 표시됨", h.content.indexOf("현재 Blocker") !== -1 && h.content.indexOf("사람 승인 대기") !== -1);
  check("Y) 더 이상 별도의 '지연/Blocker 근거' 카드 제목이 없음", h.content.indexOf("지연/Blocker 근거") === -1);
}

// Z) 문제도 Blocker도 없으면 "현재 문제 없음"으로 정직하게 표시한다(추측 금지).
async function scenarioNoProblemShowsHonestEmptyState(): Promise<void> {
  // baseSnapshot()의 기본 taskStatus는 "REVIEWING"이라 delayEvidence()가 항상 "Reviewer
  // 응답 대기" 근거를 만든다(§ delayEvidence) — 이 테스트는 그 항목마저 없는 완전히 깨끗한
  // 상태(RUNNING)를 명시적으로 만든다.
  const entry = registeredEntry("CLEAN-PROJECT");
  (entry.snapshot as Record<string, unknown>).taskStatus = "RUNNING";
  const data = multiProjectData([entry]);
  const h = await renderWithFixture(data);
  check("Z) 문제/Blocker가 전혀 없으면 '현재 문제 없음'이 표시됨", h.content.indexOf("현재 문제 없음") !== -1);
}

// AA) 현재 작업 흐름(워크플로 단계) — 실제 lifecycle 데이터에 근거해 현재 단계만 진행 중으로
//     표시하고, 완료되면 4단계 모두 완료 표시로 바뀐다(가짜 진행 상태 금지).
async function scenarioWorkflowStagesReflectRealLifecycle(): Promise<void> {
  const running = registeredEntry("WF-RUNNING");
  (running.snapshot as Record<string, unknown>).taskStatus = "RUNNING";
  const dataRunning = multiProjectData([running]);
  const hRunning = await renderWithFixture(dataRunning);
  check("AA) RUNNING: '개발' 단계가 진행 중(●)으로 표시됨", /개발\s*●/.test(hRunning.content));
  check("AA) RUNNING: '테스트' 단계는 아직 시작 전(○)으로 표시됨", /테스트\s*○/.test(hRunning.content));

  const completed = registeredEntry("WF-DONE");
  (completed.snapshot as Record<string, unknown>).taskStatus = "COMPLETED";
  (completed.snapshot as Record<string, unknown>).development = { callCount: 1 };
  (completed.snapshot as Record<string, unknown>).tests = { status: "PASS" };
  (completed.snapshot as Record<string, unknown>).review = { decision: "PASS", reviewCycle: 1 };
  (completed.snapshot as Record<string, unknown>).safety = { securityBlocked: false, checkpointStatus: "CREATED", humanApprovalRequired: false };
  const dataCompleted = multiProjectData([completed]);
  const hCompleted = await renderWithFixture(dataCompleted);
  check("AA) COMPLETED: 4단계 모두 완료(✓)로 표시됨", /개발\s*✓/.test(hCompleted.content) && /테스트\s*✓/.test(hCompleted.content) && /검토\s*✓/.test(hCompleted.content) && /저장\s*✓/.test(hCompleted.content));
}

// AB) 프로젝트 진행률 카드가 단순화됐다 — 다음 진행 예정/그 다음 작업처럼 요약 카드와
//     중복되는 행이 더 이상 없다(§ 요구사항 14).
async function scenarioProjectProgressSimplified(): Promise<void> {
  const entry = registeredEntry("PROGRESS-PROJECT", {
    projectProgress: { projectName: "PROGRESS-PROJECT", totalPhases: 22, totalTasks: 113, completedTaskCount: 20, currentTaskPhase: 5, currentTaskId: "5.5", currentTaskTitle: "다음 작업", overallProgressPercent: 17.7 },
  });
  const data = multiProjectData([entry]);
  const h = await renderWithFixture(data);
  check("AB) '현재 단계' 행이 보임(5 / 22)", h.content.indexOf("5 / 22") !== -1);
  check("AB) '완료 작업' 행이 보임(20 / 113)", h.content.indexOf("20 / 113") !== -1);
  check("AB) '다음 진행 예정' 중복 행은 더 이상 없음", h.content.indexOf("다음 진행 예정") === -1);
  check("AB) '그 다음 작업' 중복 행은 더 이상 없음", h.content.indexOf("그 다음 작업") === -1);
}

// AC) frontend polling backlog 방지(§ 요구사항 7) — 이전 fetch가 아직 끝나지 않았으면 다음
//     polling tick은 새 요청을 보내지 않는다. 응답이 오면 그 다음 tick부터는 다시 정상
//     동작한다.
async function scenarioPollingSkipsOverlappingRequest(): Promise<void> {
  const data = baseData();
  const h = await renderWithFixture(data, { slowFetch: true });
  check("AC) 최초 tick()으로 fetch가 1회 호출됨(아직 응답 대기 중)", h.fetchCallCount === 1);
  await h.triggerPoll();
  check("AC) 이전 요청이 끝나지 않은 상태에서 poll을 한 번 더 트리거해도 fetch가 추가로 나가지 않음(여전히 1회)", h.fetchCallCount === 1);
  await h.releaseSlowFetch();
  await h.triggerPoll();
  check("AC) 첫 요청이 끝난 뒤 다시 poll하면 fetch가 2회째 나감", h.fetchCallCount === 2);
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
  await scenarioActivityLogCollapsedByDefaultWithTeaser();
  await scenarioActivityLogExpandsAndShowsAll();
  await scenarioActivityLogFilterNarrowsToOneType();
  await scenarioUsageGitBaselineCollapsedThenExpand();
  await scenarioProblemCardAbsorbsBlockerEvidence();
  await scenarioNoProblemShowsHonestEmptyState();
  await scenarioWorkflowStagesReflectRealLifecycle();
  await scenarioProjectProgressSimplified();
  await scenarioPollingSkipsOverlappingRequest();

  console.log("\n=== dashboard-html 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
