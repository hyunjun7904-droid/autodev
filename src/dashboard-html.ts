// Local Operations Dashboard — Read-only HTML/CSS/JS page.
// AutoDev Dashboard 멀티프로젝트 운영센터 개선(2026-09) — Project Office 레이아웃으로 개편.
//
// 별도 frontend framework(React/Next/Vite 등)를 쓰지 않는다 — 이 저장소에 프론트엔드
// 빌드 도구가 전혀 없고(package.json 참고), 로컬 읽기 전용 관제판에는 하나의 정적 HTML
// 문자열 + fetch 기반 polling으로 충분하다. 이 문자열은 dashboard-server.ts가 GET / 응답으로
// 그대로 서빙한다.
//
// 이 페이지는 GET /api/snapshots(멀티프로젝트) 하나만 호출한다 — approve/reject/실행/git/
// 파일수정 같은 어떤 쓰기 요청도 만들지 않는다(client JS 전체를 봐도 fetch 호출이 이 한
// 곳뿐이다). 오른쪽 운영 질문창(§ 요구사항 8)도 이미 이 fetch로 받아온 데이터만 keyword
// 매칭으로 조회한다 — 별도 API를 호출하지 않고, LLM도 호출하지 않는다(추측 답변 없음,
// 모르면 "확인 불가").
// dashboard.ts가 "이미 이 포트에서 우리 대시보드가 정상 실행 중인지"를 식별할 때
// <title> 문자열을 그대로 재사용한다(§ 요구사항 19 중복 실행 방지) — 두 파일에 같은
// 문자열을 따로 적어두지 않기 위해 export한다.
export const DASHBOARD_TITLE = "오토데브 대시보드";

export const DASHBOARD_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${DASHBOARD_TITLE}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #0f1115;
    --card-bg: #171a21;
    --border: #2a2e38;
    --text: #e6e8ec;
    --muted: #9aa1ac;
    --green: #2fbf71;
    --yellow: #e0a52c;
    --red: #e0524c;
    --gray: #5a6170;
    --accent: #4a8cff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, "Segoe UI", "Malgun Gothic", sans-serif;
    padding: 12px;
  }
  h1 { font-size: 18px; margin: 4px 0 12px; }
  .banner {
    padding: 14px 16px;
    border-radius: 10px;
    font-weight: 700;
    font-size: 16px;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .banner .sub { font-size: 13px; font-weight: 400; opacity: 0.85; }
  .badge-GREEN { background: color-mix(in srgb, var(--green) 22%, var(--card-bg)); border: 1px solid var(--green); color: var(--green); }
  .badge-YELLOW { background: color-mix(in srgb, var(--yellow) 22%, var(--card-bg)); border: 1px solid var(--yellow); color: var(--yellow); }
  .badge-RED { background: color-mix(in srgb, var(--red) 22%, var(--card-bg)); border: 1px solid var(--red); color: var(--red); }
  .badge-GRAY { background: color-mix(in srgb, var(--gray) 22%, var(--card-bg)); border: 1px solid var(--gray); color: var(--gray); }
  .audit-degraded {
    background: color-mix(in srgb, var(--red) 25%, var(--card-bg));
    border: 1px solid var(--red);
    color: var(--red);
    padding: 10px 14px;
    border-radius: 8px;
    font-weight: 700;
    margin-bottom: 10px;
  }
  .audit-degraded .note { font-weight: 400; font-size: 13px; margin-top: 4px; color: var(--text); }
  .layout { display: flex; gap: 12px; align-items: flex-start; }
  .main-col { flex: 1 1 auto; min-width: 0; }
  .chat-col { flex: 0 0 320px; position: sticky; top: 12px; }
  @media (max-width: 980px) {
    .layout { flex-direction: column; }
    .chat-col { flex-basis: auto; width: 100%; position: static; }
  }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }
  .toolbar input[type="search"] {
    background: var(--card-bg); border: 1px solid var(--border); color: var(--text);
    border-radius: 8px; padding: 6px 10px; font-size: 13px; flex: 1 1 200px;
  }
  .toolbar .count { color: var(--muted); font-size: 12px; }
  .officegrid { display: grid; gap: 10px; margin-bottom: 14px; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); }
  .officegrid.dense { grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 8px; }
  .projectcard {
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 12px; cursor: pointer; transition: border-color 0.15s;
  }
  .projectcard:hover { border-color: var(--accent); }
  .projectcard.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .projectcard .pc-head { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; margin-bottom: 6px; }
  .projectcard .pc-name { font-weight: 700; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .projectcard .pc-id { font-size: 11px; color: var(--muted); margin-bottom: 6px; }
  .pill {
    display: inline-block; border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 600;
    border: 1px solid currentColor;
  }
  .pc-row { display: flex; justify-content: space-between; font-size: 12px; padding: 2px 0; color: var(--muted); gap: 8px; }
  .pc-row .v { color: var(--text); text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pc-tags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 6px; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 10px;
  }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 12px 14px;
  }
  .card.wide { grid-column: 1 / -1; }
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 10px; }
  .card h3 { font-size: 12px; color: var(--muted); margin: 12px 0 6px; }
  .card h3:first-of-type { margin-top: 0; }
  .row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 5px 0;
    border-bottom: 1px dashed var(--border);
    font-size: 14px;
    gap: 10px;
  }
  .row:last-child { border-bottom: none; }
  .row .label { color: var(--muted); }
  .row .value { font-weight: 600; text-align: right; }
  .value.GREEN { color: var(--green); }
  .value.YELLOW { color: var(--yellow); }
  .value.RED { color: var(--red); }
  .value.GRAY { color: var(--gray); }
  .quickgrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; }
  .quickitem {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 8px 10px;
    text-align: center;
  }
  .quickitem .k { font-size: 11px; color: var(--muted); margin-bottom: 4px; }
  .quickitem .v { font-size: 15px; font-weight: 700; }
  .progressbar { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; height: 10px; overflow: hidden; margin: 4px 0 2px; }
  .progressbar .fill { background: var(--green); height: 100%; }
  .progresslabel { font-size: 12px; color: var(--muted); display: flex; justify-content: space-between; }
  table.calls { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.calls th { text-align: left; color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase; padding: 4px 6px; border-bottom: 1px solid var(--border); }
  table.calls td { padding: 5px 6px; border-bottom: 1px dashed var(--border); white-space: nowrap; }
  table.calls tr:last-child td { border-bottom: none; }
  .tablewrap { overflow-x: auto; }
  .empty { color: var(--muted); text-align: center; padding: 40px 10px; }
  .footer { color: var(--muted); font-size: 12px; text-align: center; margin-top: 14px; }
  #app { max-width: 1400px; margin: 0 auto; }
  .section-title { font-size: 15px; font-weight: 700; margin: 16px 0 8px; }
  .chatbox {
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px;
    display: flex; flex-direction: column; height: 70vh; min-height: 360px;
  }
  .chatbox .chat-scope { padding: 8px 10px; border-bottom: 1px solid var(--border); font-size: 12px; color: var(--muted); }
  .chatbox .chat-log { flex: 1; overflow-y: auto; padding: 10px; font-size: 13px; }
  .chatbox .chat-msg { margin-bottom: 10px; }
  .chatbox .chat-msg .who { font-size: 11px; color: var(--muted); margin-bottom: 2px; }
  .chatbox .chat-msg .text { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; white-space: pre-wrap; }
  .chatbox .chat-msg.user .text { background: color-mix(in srgb, var(--accent) 16%, var(--card-bg)); }
  .chatbox form { display: flex; gap: 6px; padding: 8px; border-top: 1px solid var(--border); }
  .chatbox input[type="text"] {
    flex: 1; background: var(--bg); border: 1px solid var(--border); color: var(--text);
    border-radius: 8px; padding: 8px 10px; font-size: 13px;
  }
  .chatbox button {
    background: var(--accent); color: white; border: none; border-radius: 8px; padding: 8px 14px;
    font-size: 13px; cursor: pointer;
  }
  .chatbox .hint { padding: 6px 10px; font-size: 11px; color: var(--muted); border-top: 1px dashed var(--border); }
</style>
</head>
<body>
<div id="app">
  <h1>오토데브 대시보드 <span style="color:var(--muted); font-weight:400;">(읽기 전용 · localhost)</span></h1>
  <div class="layout">
    <div class="main-col">
      <div id="content"><div class="empty">불러오는 중...</div></div>
    </div>
    <div class="chat-col">
      <div class="section-title">운영 질문창</div>
      <div class="chatbox">
        <div class="chat-scope" id="chat-scope">선택된 프로젝트 없음 — 질문에 프로젝트 이름을 포함하거나 카드를 먼저 선택하세요.</div>
        <div class="chat-log" id="chat-log"></div>
        <form id="chat-form">
          <input type="text" id="chat-input" autocomplete="off" placeholder="예: JARVIS 지금 뭐해?" />
          <button type="submit">질문</button>
        </form>
        <div class="hint">읽기 전용 — 이미 불러온 대시보드 자료만 조회합니다(승인/재개/중지 등 제어 불가, LLM 미사용).</div>
      </div>
    </div>
  </div>
  <div class="footer" id="footer"></div>
</div>
<script>
(function () {
  var REFRESH_MS = 3000;
  var NO_DATA = "데이터 없음";
  var NOT_AVAILABLE = "확인 불가";

  var STATUS_TONE = {
    IDLE: "GRAY", RUNNING: "GREEN", TESTING: "GREEN", REVIEWING: "GREEN",
    REVISING: "YELLOW", WAITING_HUMAN: "YELLOW", BLOCKED: "RED",
    CHECKPOINTING: "GREEN", COMPLETED: "GREEN", UNKNOWN: "GRAY"
  };
  var STATUS_LABEL_KO = {
    IDLE: "대기", RUNNING: "실행 중", TESTING: "검사 중", REVIEWING: "검토 중",
    REVISING: "수정 중", WAITING_HUMAN: "사람 승인 대기", BLOCKED: "차단됨",
    CHECKPOINTING: "저장 지점 생성 중", COMPLETED: "완료", UNKNOWN: "확인 불가"
  };
  // AutoDev / JARVIS Dashboard Stale-State Reconciliation — runtimeTruth.state가
  // STALE/STOPPED이면 event log가 무엇을 마지막으로 기록했든 실제로는 그 작업을 수행하는
  // 프로세스가 없다는 뜻이다 — STATUS_LABEL_KO만으로 표시하지 않고 이 값으로 덮어쓴다.
  var RUNTIME_STALE_LABEL_KO = {
    STOPPED: "중단됨(실행 중인 프로세스 없음)",
    STALE: "정체됨(응답 없음 — 확인 필요)"
  };
  function resolveRuntimeStatus(taskStatus, runtimeTruth) {
    if (runtimeTruth && (runtimeTruth.state === "STOPPED" || runtimeTruth.state === "STALE")) {
      return { label: RUNTIME_STALE_LABEL_KO[runtimeTruth.state], tone: runtimeTruth.state === "STALE" ? "RED" : "GRAY" };
    }
    return { label: STATUS_LABEL_KO[taskStatus] || taskStatus, tone: STATUS_TONE[taskStatus] || "GRAY" };
  }
  var TEST_STATUS_LABEL_KO = { PASS: "통과", FAIL: "실패", UNKNOWN: "확인 불가" };
  var REVIEW_DECISION_LABEL_KO = { PASS: "통과", REVISE: "수정 필요", HUMAN_REQUIRED: "사람 확인 필요", BLOCK: "차단됨" };
  var REVIEWER_CALL_RESULT_LABEL_KO = { PASS: "통과", REVISE: "수정 요청", BLOCK: "차단" };
  var REVIEWER_CALL_RESULT_TONE = { PASS: "GREEN", REVISE: "YELLOW", BLOCK: "RED" };
  var DEVELOPER_OUTCOME_LABEL_KO = { RUNNING: "진행 중(종료 없음)", NORMAL_END: "정상 종료", ABNORMAL_END: "비정상 종료" };
  var DEVELOPER_OUTCOME_TONE = { RUNNING: "YELLOW", NORMAL_END: "GREEN", ABNORMAL_END: "RED" };
  var ADVISORY_ROLES = [
    { role: "planner", label: "기획" },
    { role: "research", label: "조사" },
    { role: "qa", label: "품질보증" },
    { role: "security", label: "보안" }
  ];
  var ERROR_TYPE_LABEL_KO = {
    INFRASTRUCTURE_CONFIGURATION: "기반시설/설정 문제",
    IMPLEMENTATION: "구현 문제",
    PROVIDER: "외부 서비스 문제",
    UNKNOWN: "확인 불가"
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function orDash(v) {
    return v === undefined || v === null || v === "" ? "—" : esc(v);
  }
  function fmtNum(n) {
    return typeof n === "number" ? n.toLocaleString("ko-KR") : NO_DATA;
  }
  function fmtPercent(n) {
    return typeof n === "number" ? n.toFixed(1) + "%" : NO_DATA;
  }
  function fmtUsd(n) {
    return typeof n === "number" ? "$" + n.toFixed(4) : null;
  }
  function fmtDuration(ms) {
    if (typeof ms !== "number" || ms < 0) return "—";
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    var parts = [];
    if (h > 0) parts.push(h + "시간");
    if (h > 0 || m > 0) parts.push(m + "분");
    parts.push(sec + "초");
    return parts.join(" ");
  }
  function fmtDateTime(iso) {
    if (!iso) return "—";
    try { return new Date(iso).toLocaleString("ko-KR"); } catch (e) { return "—"; }
  }
  function row(label, valueHtml, tone) {
    return '<div class="row"><span class="label">' + esc(label) + '</span>' +
      '<span class="value' + (tone ? " " + tone : "") + '">' + valueHtml + "</span></div>";
  }
  function card(title, innerHtml, wide) {
    return '<div class="card' + (wide ? " wide" : "") + '"><h2>' + esc(title) + "</h2>" + innerHtml + "</div>";
  }
  function subheading(title) {
    return "<h3>" + esc(title) + "</h3>";
  }
  function progressBar(percent, label) {
    var pct = typeof percent === "number" ? Math.max(0, Math.min(100, percent)) : 0;
    var text = typeof percent === "number" ? percent.toFixed(1) + "%" : NO_DATA;
    return (
      '<div class="progresslabel"><span>' + esc(label) + '</span><span>' + esc(text) + "</span></div>" +
      '<div class="progressbar"><div class="fill" style="width:' + pct + '%"></div></div>'
    );
  }
  function pill(text, tone) {
    return '<span class="pill value ' + (tone || "GRAY") + '">' + esc(text) + "</span>";
  }

  // ---------------------------------------------------------------------
  // Maintenance Pause / 지연·blocker 판정(§ 요구사항 7) — 임의 시간 기준 하나로 뭉뚱그리지
  // 않고, 실제로 관측 가능한 근거를 각각 구분해서 보여준다. 의도적 Maintenance Pause는
  // 장애로 표시하지 않는다.
  // ---------------------------------------------------------------------
  function delayEvidence(p) {
    var evidence = [];
    if (p.maintenancePause && p.maintenancePause.active) {
      evidence.push({ label: "유지보수 일시정지(의도적)", tone: "GRAY", detail: p.maintenancePause.reason || "사유 미기록" });
    }
    if (p.runtimeTruth && (p.runtimeTruth.state === "STOPPED" || p.runtimeTruth.state === "STALE")) {
      evidence.push({ label: p.runtimeTruth.state === "STALE" ? "프로세스 정체(응답 없음)" : "프로세스 중단", tone: "RED", detail: p.runtimeTruth.reason });
    }
    var taskStatus = p.snapshot && p.snapshot.taskStatus;
    if (taskStatus === "WAITING_HUMAN") {
      evidence.push({ label: "사람 승인 대기(Human Gate)", tone: "YELLOW", detail: null });
    }
    var repeated = p.problemSolving && p.problemSolving.currentProblem ? p.problemSolving.currentProblem.repeatedFailureCount : undefined;
    if (typeof repeated === "number" && repeated > 1) {
      evidence.push({ label: "동일 실패 반복 " + repeated + "회", tone: "YELLOW", detail: null });
    }
    if (taskStatus === "REVIEWING") {
      evidence.push({ label: "Reviewer 응답 대기", tone: "GRAY", detail: null });
    }
    return evidence;
  }

  // ---------------------------------------------------------------------
  // Project Office — N개 project 카드 grid.
  // ---------------------------------------------------------------------
  var state = { projects: [], selectedProjectId: null, filter: "", chatHistory: [], autoSelectAttempted: false };

  function projectDensityClass(count) {
    if (count > 12) return "dense";
    return "";
  }

  function projectCardHtml(p) {
    var snap = p.snapshot;
    var runtimeStatus = snap ? resolveRuntimeStatus(snap.taskStatus, p.runtimeTruth) : { label: "실행 이력 없음", tone: "GRAY" };
    var evidence = delayEvidence(p);
    var isPaused = p.maintenancePause && p.maintenancePause.active;
    var tags = "";
    if (isPaused) tags += pill("일시정지", "GRAY");
    if (!isPaused && evidence.some(function (e) { return e.tone === "RED"; })) tags += pill("장애 의심", "RED");
    if (!isPaused && evidence.some(function (e) { return e.tone === "YELLOW"; })) tags += pill("대기/지연", "YELLOW");
    if (!p.registered) tags += pill("미등록(event만 존재)", "GRAY");

    var developerRow = "";
    var latestAttempt = p.developerLifecycle && p.developerLifecycle.latest;
    if (latestAttempt) {
      developerRow =
        '<div class="pc-row"><span>Developer</span><span class="v">시도 ' + latestAttempt.attemptNumber + '회 · ' +
        esc(DEVELOPER_OUTCOME_LABEL_KO[latestAttempt.outcome] || latestAttempt.outcome) + "</span></div>";
    }
    var reviewerRow = "";
    var revHistory = p.reviewerHistory || [];
    if (revHistory.length > 0) {
      var lastRev = revHistory[revHistory.length - 1];
      reviewerRow =
        '<div class="pc-row"><span>Reviewer</span><span class="v">' + esc(lastRev.service) + " · " +
        esc(REVIEWER_CALL_RESULT_LABEL_KO[lastRev.result] || lastRev.result) + " (" + revHistory.length + "회)</span></div>";
    }

    return (
      '<div class="projectcard' + (state.selectedProjectId === p.projectId ? " selected" : "") + '" data-project-id="' + esc(p.projectId) + '">' +
      '<div class="pc-head"><span class="pc-name">' + esc(p.projectLabel) + "</span>" + pill(runtimeStatus.label, runtimeStatus.tone) + "</div>" +
      '<div class="pc-id">' + esc(p.projectId) + "</div>" +
      '<div class="pc-row"><span>현재 작업</span><span class="v">' + orDash(snap && snap.taskId) + "</span></div>" +
      developerRow +
      reviewerRow +
      '<div class="pc-row"><span>경과</span><span class="v">' + fmtDuration(snap && snap.currentOperation && snap.currentOperation.elapsedMs) + "</span></div>" +
      '<div class="pc-tags">' + tags + "</div>" +
      "</div>"
    );
  }

  function renderOfficeGrid() {
    var filtered = state.projects.filter(function (p) {
      if (!state.filter) return true;
      var needle = state.filter.toLowerCase();
      return p.projectLabel.toLowerCase().indexOf(needle) !== -1 || p.projectId.toLowerCase().indexOf(needle) !== -1;
    });
    var toolbar =
      '<div class="toolbar">' +
      '<input type="search" id="project-filter" placeholder="프로젝트 이름/ID 검색" value="' + esc(state.filter) + '" />' +
      '<span class="count">' + filtered.length + " / " + state.projects.length + "개 표시</span>" +
      "</div>";
    if (state.projects.length === 0) {
      return toolbar + '<div class="card"><div class="empty">표시할 프로젝트가 없습니다. AUTODEV_DASHBOARD_PROJECT_ADAPTERS(또는 AUTODEV_PROJECT_ADAPTER) 설정과 event 기록을 확인하세요.</div></div>';
    }
    var html = '<div class="officegrid ' + projectDensityClass(state.projects.length) + '">';
    filtered.forEach(function (p) { html += projectCardHtml(p); });
    html += "</div>";
    return toolbar + html;
  }

  // ---------------------------------------------------------------------
  // 선택된 project 상세 — 기존 단일 project 카드들을 그대로 재사용(§ 요구사항: 최소 변경).
  // ---------------------------------------------------------------------
  function renderAuditBanner(snap) {
    if (!snap || snap.integrity !== "DEGRADED") return "";
    return '<div class="audit-degraded">감사 기록 손상(AUDIT DEGRADED)<div class="note">' +
      esc(snap.integrityNote || "일부 기록이 누락되었거나 손상되었을 수 있습니다.") + "</div></div>";
  }

  var ACTIVE_LOOKING_TASK_STATUSES = { RUNNING: true, TESTING: true, REVIEWING: true, REVISING: true, CHECKPOINTING: true };
  function renderConsistencyWarning(snap, runtimeTruth) {
    if (!snap || !runtimeTruth || (runtimeTruth.state !== "STALE" && runtimeTruth.state !== "STOPPED")) return "";
    if (!ACTIVE_LOOKING_TASK_STATUSES[snap.taskStatus]) return "";
    return '<div class="audit-degraded">상태 불일치(STATE_CONSISTENCY_WARNING)<div class="note">' +
      "저장된 상태는 '" + esc(STATUS_LABEL_KO[snap.taskStatus] || snap.taskStatus) + "'이나 실제로는 실행 중인 프로세스가 없습니다 — " +
      esc(runtimeTruth.reason) + "</div></div>";
  }

  function renderMaintenanceBanner(p) {
    if (!p.maintenancePause || !p.maintenancePause.active) return "";
    return '<div class="audit-degraded" style="background:color-mix(in srgb, var(--gray) 25%, var(--card-bg)); border-color:var(--gray); color:var(--text);">' +
      "유지보수 일시정지 중(의도적 — 장애 아님)" +
      '<div class="note">' + (p.maintenancePause.reason ? esc(p.maintenancePause.reason) : "사유 미기록") +
      (p.maintenancePause.engagedAt ? " · 시작: " + esc(fmtDateTime(p.maintenancePause.engagedAt)) : "") + "</div></div>";
  }

  function overallTone(snap, runtimeTruth) {
    if (runtimeTruth && runtimeTruth.state === "STALE") return "RED";
    if (snap.safety.securityBlocked || snap.taskStatus === "BLOCKED" || snap.runStatus === "BLOCKED") return "RED";
    if (runtimeTruth && runtimeTruth.state === "STOPPED") return "GRAY";
    if (
      snap.taskStatus === "WAITING_HUMAN" ||
      snap.taskStatus === "REVISING" ||
      snap.tests.status === "FAIL" ||
      snap.integrity === "DEGRADED" ||
      snap.quality.reviewCycleExhausted
    ) {
      return "YELLOW";
    }
    var tone = STATUS_TONE[snap.taskStatus] || "GRAY";
    return tone === "RED" ? "YELLOW" : tone;
  }

  function renderQuickGlance(p) {
    var snap = p.snapshot;
    var approvalNeeded = snap.taskStatus === "WAITING_HUMAN" || snap.safety.humanApprovalRequired;
    var runtimeStatus = resolveRuntimeStatus(snap.taskStatus, p.runtimeTruth);
    var items = [
      { k: "오토데브 상태", v: runtimeStatus.label, tone: runtimeStatus.tone },
      { k: "승인 필요", v: approvalNeeded ? "예" : "아니오", tone: approvalNeeded ? "YELLOW" : "GREEN" },
      { k: "검사", v: TEST_STATUS_LABEL_KO[snap.tests.status] || snap.tests.status, tone: snap.tests.status === "PASS" ? "GREEN" : snap.tests.status === "FAIL" ? "RED" : "GRAY" },
      { k: "검토", v: snap.review.decision ? (REVIEW_DECISION_LABEL_KO[snap.review.decision] || snap.review.decision) : "없음", tone: snap.review.decision === "PASS" ? "GREEN" : snap.review.decision === "REVISE" ? "YELLOW" : snap.review.decision ? "RED" : "GRAY" },
      { k: "보안 차단", v: snap.safety.securityBlocked ? "차단됨" : "정상", tone: snap.safety.securityBlocked ? "RED" : "GREEN" }
    ];
    var html = items.map(function (it) {
      return '<div class="quickitem"><div class="k">' + esc(it.k) + '</div><div class="v value ' + it.tone + '">' + esc(it.v) + "</div></div>";
    }).join("");
    return card("지금 한눈에", '<div class="quickgrid">' + html + "</div>");
  }

  function renderProjectProgress(p) {
    var pr = p.projectProgress;
    if (!pr) {
      return card("프로젝트 진행 상황", '<div class="empty">' + (p.registered ? "task-registry/project-state를 읽지 못했습니다." : "이 project는 registry에 등록되지 않아 전체 진행률을 알 수 없습니다(event 기반 정보만 표시).") + "</div>");
    }
    var rows =
      row("프로젝트 이름", orDash(pr.projectName)) +
      row("전체 단계 수", fmtNum(pr.totalPhases)) +
      row("전체 작업 수", fmtNum(pr.totalTasks)) +
      row("완료 작업 수", fmtNum(pr.completedTaskCount)) +
      row("현재 작업", pr.currentTaskId ? esc(pr.currentTaskId) + (pr.currentTaskTitle ? " · " + esc(pr.currentTaskTitle) : "") : "없음(전체 완료)") +
      row("다음 작업", pr.nextTaskId ? esc(pr.nextTaskId) + (pr.nextTaskTitle ? " · " + esc(pr.nextTaskTitle) : "") : "없음");
    var bars =
      progressBar(pr.overallProgressPercent, "전체 진행률") +
      (typeof pr.currentPhaseProgressPercent === "number" ? progressBar(pr.currentPhaseProgressPercent, "현재 단계 진행률") : "");
    return card("프로젝트 진행 상황", rows + bars);
  }

  function renderCurrentStatus(p) {
    var snap = p.snapshot;
    var agent = snap.currentOperation.activeAgentRole
      ? snap.currentOperation.activeAgentRole + " (" + orDash(snap.currentOperation.activeAgentId) + ")"
      : "없음";
    var rs = p.roundStatus;
    var runtimeStatus = resolveRuntimeStatus(snap.runStatus, p.runtimeTruth);
    var rows =
      row("오토데브 상태", esc(runtimeStatus.label), runtimeStatus.tone) +
      row("프로젝트", orDash(snap.projectId)) +
      row("실행", orDash(snap.runId ? snap.runId.slice(0, 8) : undefined)) +
      row("현재 작업", orDash(snap.taskId)) +
      row("현재 수행 중", orDash(snap.currentOperation.currentAction)) +
      row("현재 개발/검토 담당", esc(agent)) +
      row("개발 진행(현재 라운드/최대)", rs ? rs.round + " / 최대 " + rs.maxRounds : NOT_AVAILABLE) +
      row("마지막 활동 후 경과", rs ? fmtDuration(Date.now() - Date.parse(rs.updatedAt)) : fmtDuration(snap.currentOperation.elapsedMs)) +
      row("감사 기록 상태", snap.integrity === "CLEAN" ? "정상" : "손상", snap.integrity === "CLEAN" ? "GREEN" : "RED");
    return card("현재 작업 상태", rows);
  }

  function renderActualWorkTime(p) {
    var w = p.actualWorkTime || {};
    var rows =
      row("현재 작업 실제 작업시간", fmtDuration(w.currentTaskMs)) +
      row("프로젝트 전체 실제 작업시간", fmtDuration(w.projectTotalMs));
    return card("실제 작업시간", rows);
  }

  function renderLiveOperations(snap) {
    var rows =
      row("개발 담당 상태", snap.development.callCount > 0 ? "호출 " + snap.development.callCount + "회" : "호출 없음") +
      row("검사 상태", TEST_STATUS_LABEL_KO[snap.tests.status] || snap.tests.status, snap.tests.status === "PASS" ? "GREEN" : snap.tests.status === "FAIL" ? "RED" : "GRAY") +
      row("검토 상태", snap.review.decision ? (REVIEW_DECISION_LABEL_KO[snap.review.decision] || snap.review.decision) : "없음") +
      row("검토 반복 횟수", String(snap.review.reviewCycle)) +
      row("저장 지점 상태", snap.safety.checkpointStatus === "CREATED" ? "생성됨" : "없음", snap.safety.checkpointStatus === "CREATED" ? "GREEN" : "GRAY");
    return card("실시간 작업", rows);
  }

  // § 요구사항 5 — Developer 생애주기(시작/종료/실행시간/attempt/종료상태·사유).
  function renderDeveloperLifecycle(p) {
    var lc = p.developerLifecycle;
    if (!lc || lc.attempts.length === 0) {
      return card("Developer 실행 이력", '<div class="empty">이 작업에 대한 Developer 호출 기록이 아직 없습니다.</div>');
    }
    var html = '<div class="tablewrap"><table class="calls"><thead><tr>' +
      "<th>시도</th><th>시작</th><th>종료</th><th>실행시간</th><th>종료 상태</th><th>종료 사유</th>" +
      "</tr></thead><tbody>";
    lc.attempts.slice().reverse().forEach(function (a) {
      var outcomeLabel = DEVELOPER_OUTCOME_LABEL_KO[a.outcome] || a.outcome;
      var outcomeTone = DEVELOPER_OUTCOME_TONE[a.outcome] || "GRAY";
      var reason = a.exitReason ? esc(a.exitReason) : (a.exitDetail ? esc(a.exitDetail) : (a.outcome === "RUNNING" ? "아직 없음" : "—"));
      html += "<tr><td>" + a.attemptNumber + "회</td><td>" + esc(fmtDateTime(a.startedAt)) + "</td><td>" +
        (a.endedAt ? esc(fmtDateTime(a.endedAt)) : "아직 없음") + "</td><td>" +
        (a.durationMs !== undefined ? fmtDuration(a.durationMs) : "—") + '</td><td class="value ' + outcomeTone + '">' +
        esc(outcomeLabel) + "</td><td>" + reason + "</td></tr>";
    });
    html += "</tbody></table></div>";
    return card("Developer 실행 이력(현재 작업)", html, true);
  }

  // § 요구사항 6 — Reviewer 호출 이력(provider/model/결과/순번/escalation 관측 여부).
  function renderReviewerHistory(p) {
    var history = p.reviewerHistory || [];
    if (history.length === 0) {
      return card("Reviewer 호출 이력", '<div class="empty">아직 Reviewer가 호출된 적이 없습니다.</div>');
    }
    var html = '<div class="tablewrap"><table class="calls"><thead><tr>' +
      "<th>순번</th><th>시각</th><th>작업</th><th>서비스</th><th>모델</th><th>결과</th><th>검토 cycle</th><th>비고</th>" +
      "</tr></thead><tbody>";
    history.slice().reverse().forEach(function (r) {
      var tone = REVIEWER_CALL_RESULT_TONE[r.result] || "GRAY";
      var note = r.providerChangedFromPrevious ? "이전 호출과 다른 provider" : "";
      html += "<tr><td>#" + r.sequenceNumber + "</td><td>" + esc(fmtDateTime(r.timestamp)) + "</td><td>" + orDash(r.taskId) +
        "</td><td>" + esc(r.service) + "</td><td>" + orDash(r.model) + '</td><td class="value ' + tone + '">' +
        esc(REVIEWER_CALL_RESULT_LABEL_KO[r.result] || r.result) + "</td><td>" + orDash(r.reviewCycle) + "</td><td>" + esc(note) + "</td></tr>";
    });
    html += "</tbody></table></div>";
    return card("Reviewer 호출 이력(호출 " + history.length + "회)", html, true);
  }

  // § 요구사항 7 — 지연/blocker 근거를 항목별로 구분해서 표시.
  function renderDelayEvidence(p) {
    var evidence = delayEvidence(p);
    if (evidence.length === 0) {
      return card("지연/Blocker 근거", '<div class="empty">현재 관측된 지연/장애 근거가 없습니다.</div>');
    }
    var html = evidence.map(function (e) {
      return row(e.label, e.detail ? esc(e.detail) : "관측됨", e.tone);
    }).join("");
    return card("지연/Blocker 근거", html);
  }

  function renderUsage(p) {
    var u = p.usageOverview;
    if (!u) return card("사용량", '<div class="empty">' + NO_DATA + "</div>");
    function totalsRows(t) {
      return (
        row("입력 토큰", fmtNum(t.totals.inputTokens)) +
        row("출력 토큰", fmtNum(t.totals.outputTokens)) +
        row("전체 토큰", fmtNum(t.totals.totalTokens)) +
        row("외부 인공지능 호출 횟수", fmtNum(t.totals.callCount))
      );
    }
    var html = subheading("전체 누적") + totalsRows(u.allTime);
    html += subheading("현재 작업") + (u.currentTask ? totalsRows(u.currentTask) : '<div class="empty">현재 작업 없음</div>');
    return card("사용량", html);
  }

  function renderServiceUsage(p) {
    var u = p.usageOverview;
    var list = u ? u.allTime.byService : [];
    if (!list || list.length === 0) {
      return card("서비스별 호출량", '<div class="empty">아직 호출된 외부 인공지능 서비스가 없습니다.</div>');
    }
    var html = '<div class="tablewrap"><table class="calls"><thead><tr>' +
      "<th>서비스</th><th>모델</th><th>호출 횟수</th><th>입력 토큰</th><th>출력 토큰</th><th>전체 토큰</th>" +
      "</tr></thead><tbody>";
    list.forEach(function (u2) {
      html += "<tr><td>" + esc(u2.service) + "</td><td>" + orDash(u2.model) + "</td><td>" + fmtNum(u2.callCount) + "</td><td>" +
        fmtNum(u2.inputTokens) + "</td><td>" + fmtNum(u2.outputTokens) + "</td><td>" + fmtNum(u2.totalTokens) + "</td></tr>";
    });
    html += "</tbody></table></div>";
    return card("서비스별 호출량", html, true);
  }

  function renderRecentCalls(p) {
    var calls = p.recentCalls || [];
    if (calls.length === 0) {
      return card("최근 외부 인공지능 호출 기록", '<div class="empty">아직 호출 기록이 없습니다.</div>');
    }
    var html = '<div class="tablewrap"><table class="calls"><thead><tr>' +
      "<th>시각</th><th>작업</th><th>목적</th><th>서비스</th><th>모델</th><th>전체 토큰</th><th>성공</th>" +
      "</tr></thead><tbody>";
    calls.forEach(function (c) {
      var successLabel = c.success ? "예" : "아니오";
      var successTone = c.success ? "GREEN" : "RED";
      html += "<tr><td>" + esc(fmtDateTime(c.timestamp)) + "</td><td>" + orDash(c.taskId) +
        "</td><td>" + esc(c.purpose) + "</td><td>" + esc(c.service) + "</td><td>" + orDash(c.model) + "</td><td>" +
        fmtNum(c.totalTokens) + '</td><td class="value ' + successTone + '">' + successLabel + "</td></tr>";
    });
    html += "</tbody></table></div>";
    return card("최근 외부 인공지능 호출 기록", html, true);
  }

  function renderAttemptOutcomes(p) {
    var ao = p.attemptOutcomes;
    if (!ao || (ao.successCount === 0 && ao.failureCount === 0)) {
      return card("작업 시도 결과(성공/실패 사례)", '<div class="empty">아직 확정된 시도(checkpoint 성공 또는 최종 차단)가 없습니다.</div>');
    }
    var html = row("성공 사례", fmtNum(ao.successCount), ao.successCount > 0 ? "GREEN" : "GRAY") +
      row("실패 사례", fmtNum(ao.failureCount), ao.failureCount > 0 ? "YELLOW" : "GRAY");
    var recent = ao.recent || [];
    if (recent.length > 0) {
      html += '<div class="tablewrap"><table class="calls"><thead><tr>' +
        "<th>시각</th><th>작업</th><th>결과</th><th>사유</th>" +
        "</tr></thead><tbody>";
      recent.forEach(function (a) {
        var tone = a.result === "SUCCESS" ? "GREEN" : "RED";
        var label = a.result === "SUCCESS" ? "성공" : "실패";
        html += "<tr><td>" + esc(fmtDateTime(a.occurredAt)) + "</td><td>" + orDash(a.taskId) + '</td><td class="value ' + tone + '">' +
          label + "</td><td>" + esc(orDash(a.reason)) + "</td></tr>";
      });
      html += "</tbody></table></div>";
    }
    return card("작업 시도 결과(성공/실패 사례)", html, true);
  }

  function renderCost(snap) {
    var u = snap.usage;
    var actual = fmtUsd(u.actualCostUsd);
    var estimated = fmtUsd(u.estimatedCostUsd);
    if (actual === null && estimated === null) {
      return card("비용", '<div class="empty">비용 계산 자료 없음</div>');
    }
    var rows = "";
    if (actual !== null) rows += row("실제 비용", actual);
    if (estimated !== null) rows += row("예상 비용", estimated);
    return card("비용", rows);
  }

  function renderQuality(p) {
    var snap = p.snapshot;
    var q = snap.quality;
    var hist = snap.historical;
    var fp = q.firstPassApproved === undefined ? NOT_AVAILABLE : q.firstPassApproved ? "예" : "아니오";
    var ps = p.problemSolving;
    var rows =
      row("첫 검토 통과율", typeof hist.firstPassApprovalRate === "number" ? fmtPercent(hist.firstPassApprovalRate * 100) : NO_DATA) +
      row("현재 작업 수정 횟수", String(q.reviseCount)) +
      row("첫 검토 통과 여부(현재 작업)", fp, q.firstPassApproved === true ? "GREEN" : q.firstPassApproved === false ? "YELLOW" : "GRAY") +
      row("검사 상태", TEST_STATUS_LABEL_KO[snap.tests.status] || snap.tests.status, snap.tests.status === "PASS" ? "GREEN" : snap.tests.status === "FAIL" ? "RED" : "GRAY") +
      row("보안 검사 상태", snap.safety.securityBlocked ? "차단됨" : "정상", snap.safety.securityBlocked ? "RED" : "GREEN") +
      row("검토 반복 한도 소진", q.reviewCycleExhausted ? "예" : "아니오", q.reviewCycleExhausted ? "YELLOW" : "GREEN");
    if (ps) {
      rows += row("과거 해결 사례 재사용 성공", fmtNum(ps.totalReuseSuccessCount));
      rows += row("과거 해결 사례 재사용 실패", fmtNum(ps.totalReuseFailureCount));
    } else {
      rows += row("과거 해결 사례 재사용 횟수", NO_DATA);
    }
    var ce = p.callEfficiency;
    rows += row("자동 복구 횟수(현재 작업)", ce ? fmtNum(ce.localRecoverySuccessRounds) : NOT_AVAILABLE);
    return card("개발 품질", rows);
  }

  function renderProblemSolving(p) {
    var ps = p.problemSolving;
    if (!ps || !ps.currentProblem) {
      return card("현재 문제 해결 상황", '<div class="empty">현재 진행 중인 문제 없음</div>');
    }
    var cp = ps.currentProblem;
    var ce = p.callEfficiency;
    var localRecoveryLabel = ce ? (ce.localRecoverySuccessRounds > 0 ? "로컬 복구 " + ce.localRecoverySuccessRounds + "회" : "로컬 복구 없음") : NOT_AVAILABLE;
    var rows =
      row("문제 유형", ERROR_TYPE_LABEL_KO[cp.errorType] || cp.errorType) +
      row("실패한 검사", orDash(cp.failedCheck)) +
      row("같은 오류 반복 횟수", String(cp.repeatedFailureCount)) +
      row("과거 유사 사례 수", String(ps.similarPastCasesCount)) +
      row("과거 해결책 재사용 여부", ps.similarPastCasesCount > 0 ? "재사용 가능한 사례 있음" : "없음") +
      row("자동 복구 상태(현재 작업)", localRecoveryLabel) +
      row("해결 상태", cp.resolved ? "해결됨" : "진행 중", cp.resolved ? "GREEN" : "YELLOW") +
      row("마지막 관측 시각", esc(fmtDateTime(cp.lastSeenAt)));
    return card("현재 문제 해결 상황", rows);
  }

  function renderCallEfficiency(p) {
    var ce = p.callEfficiency;
    if (!ce) {
      return card("호출 효율", '<div class="empty">현재 작업에 대한 개발 담당 호출 기록이 아직 없습니다.</div>');
    }
    var wastedTone = ce.protocolFailureRounds > 0 ? "YELLOW" : "GREEN";
    var rows =
      row("현재 작업 개발 담당 호출(내부 라운드) 총합", fmtNum(ce.totalRounds)) +
      row("유효한 개발 응답 라운드", fmtNum(ce.validResponseRounds), "GREEN") +
      row("로컬 복구 성공 라운드(추가 호출 없음)", fmtNum(ce.localRecoverySuccessRounds)) +
      row("응답 형식 실패 라운드", fmtNum(ce.protocolFailureRounds), wastedTone);
    return card("호출 효율", rows);
  }

  function renderAdvisory(snap) {
    var a = snap.advisory;
    var rows = ADVISORY_ROLES.map(function (r) {
      var entries = a.selected.filter(function (s) { return s.role === r.role; });
      if (entries.length === 0) return row(r.label, "호출 안 됨", "GRAY");
      var calls = entries.reduce(function (sum, e) { return sum + (a.callCountByAgent[e.agentId] || 0); }, 0);
      var failed = entries.some(function (e) { return a.failedAgentIds.indexOf(e.agentId) !== -1; });
      var completed = entries.some(function (e) { return a.completedAgentIds.indexOf(e.agentId) !== -1; });
      var status = failed ? "실패" : completed ? "완료" : "진행 중";
      var tone = failed ? "RED" : completed ? "GREEN" : "YELLOW";
      return row(r.label, status + " (호출 " + calls + "회)", tone);
    }).join("");
    return card("보조 담당", rows);
  }

  function renderProjectDetail(p) {
    if (!p) return "";
    if (p.status === "NO_RUN_YET" || !p.snapshot) {
      return (
        '<div class="section-title">' + esc(p.projectLabel) + " 상세" + "</div>" +
        renderMaintenanceBanner(p) +
        '<div class="grid">' + renderProjectProgress(p) + card("실행 이력", '<div class="empty">이 프로젝트는 아직 실행된 적이 없습니다(NO_RUN_YET).</div>') + "</div>"
      );
    }
    var snap = p.snapshot;
    var tone = overallTone(snap, p.runtimeTruth);
    var bannerStatus = resolveRuntimeStatus(snap.taskStatus, p.runtimeTruth);
    var html = '<div class="section-title">' + esc(p.projectLabel) + " 상세" + "</div>";
    html += renderAuditBanner(snap);
    html += renderMaintenanceBanner(p);
    html += renderConsistencyWarning(snap, p.runtimeTruth);
    html += '<div class="banner badge-' + tone + '"><span>오토데브 ' + esc(bannerStatus.label) +
      '</span><span class="sub">' + esc(orDash(snap.taskId)) + "</span></div>";
    html += '<div class="grid">' +
      renderQuickGlance(p) +
      renderProjectProgress(p) +
      renderCurrentStatus(p) +
      renderActualWorkTime(p) +
      renderDelayEvidence(p) +
      renderLiveOperations(snap) +
      renderDeveloperLifecycle(p) +
      renderReviewerHistory(p) +
      renderUsage(p) +
      renderServiceUsage(p) +
      renderRecentCalls(p) +
      renderAttemptOutcomes(p) +
      renderCost(snap) +
      renderQuality(p) +
      renderProblemSolving(p) +
      renderCallEfficiency(p) +
      renderAdvisory(snap) +
      "</div>";
    return html;
  }

  // ---------------------------------------------------------------------
  // 운영 질문창(§ 요구사항 8) — deterministic keyword 매칭만 사용한다. LLM을 호출하지
  // 않으며, 답을 알 수 없으면 "확인 불가"라고만 답한다(추측 답변 금지).
  // ---------------------------------------------------------------------
  function findProjectMentionedIn(text) {
    var lower = text.toLowerCase();
    var matches = state.projects.filter(function (p) {
      return lower.indexOf(p.projectLabel.toLowerCase()) !== -1 || lower.indexOf(p.projectId.toLowerCase()) !== -1;
    });
    return matches.length === 1 ? matches[0] : null;
  }

  function resolveChatScope(question) {
    var mentioned = findProjectMentionedIn(question);
    if (mentioned) return mentioned;
    if (state.selectedProjectId) {
      var found = state.projects.filter(function (p) { return p.projectId === state.selectedProjectId; });
      if (found.length === 1) return found[0];
    }
    return null;
  }

  function answerQuestion(question) {
    var p = resolveChatScope(question);
    if (!p) {
      return "어떤 프로젝트에 대한 질문인지 확인할 수 없습니다 — 프로젝트 카드를 선택하거나 질문에 프로젝트 이름을 포함해주세요.";
    }
    var q = question.toLowerCase();
    var snap = p.snapshot;

    if (q.indexOf("일시정지") !== -1 || q.indexOf("멈춰") !== -1 || q.indexOf("pause") !== -1) {
      if (p.maintenancePause === undefined) return "[" + p.projectLabel + "] 유지보수 일시정지 여부를 확인할 수 없습니다(등록되지 않은 프로젝트).";
      return p.maintenancePause.active
        ? "[" + p.projectLabel + "] 예 — 유지보수 일시정지 중입니다" + (p.maintenancePause.reason ? "(사유: " + p.maintenancePause.reason + ")" : "") + "."
        : "[" + p.projectLabel + "] 아니오 — 유지보수 일시정지 상태가 아닙니다.";
    }
    if (q.indexOf("승인") !== -1 || q.indexOf("approval") !== -1) {
      if (!snap) return "[" + p.projectLabel + "] 실행 이력이 없어 확인 불가합니다.";
      var needsApproval = snap.taskStatus === "WAITING_HUMAN" || snap.safety.humanApprovalRequired;
      return "[" + p.projectLabel + "] " + (needsApproval ? "예 — 현재 사람 승인이 필요합니다." : "아니오 — 현재 사람 승인 대기 상태가 아닙니다.");
    }
    if (q.indexOf("왜 늦") !== -1 || q.indexOf("지연") !== -1 || q.indexOf("blocker") !== -1 || q.indexOf("블로커") !== -1) {
      var evidence = delayEvidence(p);
      if (evidence.length === 0) return "[" + p.projectLabel + "] 현재 관측된 지연/블로커 근거가 없습니다.";
      return "[" + p.projectLabel + "] 지연/블로커 근거: " + evidence.map(function (e) { return e.label + (e.detail ? "(" + e.detail + ")" : ""); }).join(", ");
    }
    if ((q.indexOf("몇 번째") !== -1 || q.indexOf("attempt") !== -1) && (q.indexOf("검토") !== -1 || q.indexOf("리뷰") !== -1 || q.indexOf("review") !== -1)) {
      var revHist = p.reviewerHistory || [];
      if (revHist.length === 0) return "[" + p.projectLabel + "] 아직 Reviewer가 호출된 적이 없습니다.";
      return "[" + p.projectLabel + "] Reviewer는 지금까지 " + revHist.length + "회 호출됐습니다(마지막: " + revHist[revHist.length - 1].service + " · " + (REVIEWER_CALL_RESULT_LABEL_KO[revHist[revHist.length - 1].result] || revHist[revHist.length - 1].result) + ").";
    }
    if (q.indexOf("어떤 리뷰어") !== -1 || q.indexOf("어떤 api") !== -1 || q.indexOf("provider") !== -1 || q.indexOf("fireworks") !== -1 || q.indexOf("groq") !== -1) {
      var revHist2 = p.reviewerHistory || [];
      var mentionedProvider = q.indexOf("fireworks") !== -1 ? "fireworks" : q.indexOf("groq") !== -1 ? "groq" : null;
      if (mentionedProvider) {
        var called = revHist2.some(function (r) { return r.provider === mentionedProvider; });
        return "[" + p.projectLabel + "] " + mentionedProvider + "는 " + (called ? "실제로 호출됐습니다." : "호출된 기록이 없습니다.");
      }
      if (revHist2.length === 0) return "[" + p.projectLabel + "] 아직 호출된 Reviewer provider가 없습니다.";
      var providers = revHist2.map(function (r) { return r.service; }).filter(function (v, i, arr) { return arr.indexOf(v) === i; });
      return "[" + p.projectLabel + "] 실제로 호출된 Reviewer provider: " + providers.join(", ") + ".";
    }
    if ((q.indexOf("몇 번째") !== -1 || q.indexOf("attempt") !== -1) && q.indexOf("실행") !== -1) {
      var lc = p.developerLifecycle;
      if (!lc || lc.attempts.length === 0) return "[" + p.projectLabel + "] 아직 Developer가 호출된 적이 없습니다.";
      return "[" + p.projectLabel + "] Developer는 현재 " + lc.latest.attemptNumber + "번째 시도입니다(총 " + lc.attempts.length + "회 시도).";
    }
    if (q.indexOf("언제 시작") !== -1 || (q.indexOf("시작") !== -1 && q.indexOf("종료") === -1 && q.indexOf("끝") === -1)) {
      var lc2 = p.developerLifecycle;
      if (!lc2 || !lc2.latest) return "[" + p.projectLabel + "] Developer 시작 기록이 없습니다.";
      return "[" + p.projectLabel + "] 현재(또는 마지막) Developer 시도 시작 시각: " + fmtDateTime(lc2.latest.startedAt) + ".";
    }
    if (q.indexOf("언제 끝") !== -1 || q.indexOf("종료") !== -1) {
      var lc3 = p.developerLifecycle;
      if (!lc3 || !lc3.latest) return "[" + p.projectLabel + "] Developer 실행 기록이 없습니다.";
      if (!lc3.latest.endedAt) return "[" + p.projectLabel + "] 아직 종료되지 않았습니다(진행 중).";
      return "[" + p.projectLabel + "] 마지막 Developer 시도 종료 시각: " + fmtDateTime(lc3.latest.endedAt) + "(" + (DEVELOPER_OUTCOME_LABEL_KO[lc3.latest.outcome] || lc3.latest.outcome) + ").";
    }
    if (q.indexOf("테스트") !== -1 || q.indexOf("test") !== -1 || q.indexOf("실패") !== -1) {
      if (!snap) return "[" + p.projectLabel + "] 실행 이력이 없어 확인 불가합니다.";
      var testLabel = TEST_STATUS_LABEL_KO[snap.tests.status] || snap.tests.status;
      var failedNames = snap.tests.failedNames && snap.tests.failedNames.length > 0 ? " · 실패 목록: " + snap.tests.failedNames.join(", ") : "";
      return "[" + p.projectLabel + "] 최근 테스트 결과: " + testLabel + failedNames + ".";
    }
    if (q.indexOf("지금") !== -1 || q.indexOf("뭐해") !== -1 || q.indexOf("상태") !== -1) {
      if (!snap) return "[" + p.projectLabel + "] 아직 실행 이력이 없습니다(NO_RUN_YET).";
      var rs = resolveRuntimeStatus(snap.taskStatus, p.runtimeTruth);
      return "[" + p.projectLabel + "] 현재 상태: " + rs.label + (snap.currentOperation.currentAction ? "(" + snap.currentOperation.currentAction + ")" : "") + ".";
    }

    return "[" + p.projectLabel + "] 이 질문은 아직 해석할 수 없습니다 — 확인 불가. (지원 예: 상태/지연 사유/실패 테스트/Developer 시작·종료·시도 횟수/Reviewer 호출 횟수·provider/승인 필요 여부/일시정지 여부)";
  }

  function appendChatMessage(who, text) {
    state.chatHistory.push({ who: who, text: text });
    renderChatLog();
  }

  function renderChatLog() {
    var log = document.getElementById("chat-log");
    if (!log) return;
    log.innerHTML = state.chatHistory.map(function (m) {
      return '<div class="chat-msg ' + (m.who === "user" ? "user" : "bot") + '"><div class="who">' + (m.who === "user" ? "나" : "대시보드") +
        '</div><div class="text">' + esc(m.text) + "</div></div>";
    }).join("");
    log.scrollTop = log.scrollHeight;
  }

  function renderChatScope() {
    var scopeEl = document.getElementById("chat-scope");
    if (!scopeEl) return;
    if (state.selectedProjectId) {
      var found = state.projects.filter(function (p) { return p.projectId === state.selectedProjectId; });
      scopeEl.textContent = found.length === 1 ? "선택된 프로젝트: " + found[0].projectLabel : "선택된 프로젝트 없음";
    } else {
      scopeEl.textContent = "선택된 프로젝트 없음 — 질문에 프로젝트 이름을 포함하거나 카드를 먼저 선택하세요.";
    }
  }

  // ---------------------------------------------------------------------
  // Render 진입점 + polling.
  // ---------------------------------------------------------------------
  function render(data) {
    var footer = document.getElementById("footer");
    state.projects = (data && data.projects) || [];
    // 프로젝트가 정확히 1개뿐이면(단일 프로젝트 배포와 동일한 흔한 경우) 클릭 없이 바로
    // 상세를 보여준다 — 최초 1회만 자동 선택하고, 이후 사용자가 명시적으로 선택 해제하면
    // 다음 polling에서 다시 강제로 펼치지 않는다. 2개 이상이면 자동 선택하지 않는다(§
    // 요구사항: 프로젝트가 선택되지 않으면 임의로 추측하지 않는다).
    if (!state.autoSelectAttempted && state.projects.length === 1) {
      state.selectedProjectId = state.projects[0].projectId;
      state.autoSelectAttempted = true;
    }

    var html = "";
    if (data && data.registryIssues && data.registryIssues.length > 0) {
      html += '<div class="audit-degraded">프로젝트 등록 오류(REGISTRY_ISSUE)<div class="note">' +
        data.registryIssues.map(function (i) { return esc(i.reason); }).join("<br/>") + "</div></div>";
    }
    html += renderOfficeGrid();

    var selected = state.projects.filter(function (p) { return p.projectId === state.selectedProjectId; })[0];
    if (selected) html += renderProjectDetail(selected);

    document.getElementById("content").innerHTML = html;
    document.querySelectorAll(".projectcard").forEach(function (el) {
      el.addEventListener("click", function () {
        var id = el.getAttribute("data-project-id");
        state.selectedProjectId = state.selectedProjectId === id ? null : id;
        renderChatScope();
        render(data);
        var filterEl = document.getElementById("project-filter");
        if (filterEl) filterEl.focus({ preventScroll: true });
      });
    });
    var filterInput = document.getElementById("project-filter");
    if (filterInput) {
      filterInput.addEventListener("input", function () {
        state.filter = filterInput.value;
        var caret = filterInput.selectionStart;
        render(data);
        var again = document.getElementById("project-filter");
        if (again) {
          again.focus();
          try { again.setSelectionRange(caret, caret); } catch (e) {}
        }
      });
    }
    renderChatScope();
    footer.textContent = "마지막 갱신: " + fmtDateTime(data ? data.generatedAt : undefined) + " (" + (REFRESH_MS / 1000) + "초마다 자동 갱신, 읽기 전용, " + state.projects.length + "개 프로젝트)";
  }

  function tick() {
    fetch("/api/snapshots", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () {
        document.getElementById("content").innerHTML = '<div class="empty">데이터를 불러오지 못했습니다. 대시보드 서버 상태를 확인하세요.</div>';
      });
  }

  var chatForm = document.getElementById("chat-form");
  if (chatForm) {
    chatForm.addEventListener("submit", function (evt) {
      evt.preventDefault();
      var input = document.getElementById("chat-input");
      var question = (input.value || "").trim();
      if (!question) return;
      appendChatMessage("user", question);
      appendChatMessage("bot", answerQuestion(question));
      input.value = "";
    });
  }

  tick();
  setInterval(tick, REFRESH_MS);
})();
</script>
</body>
</html>
`;
