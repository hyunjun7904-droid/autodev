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
  .chat-col[hidden] { display: none; }
  .chat-toggle-row { text-align: right; margin-bottom: 10px; }
  .chat-toggle-btn {
    background: var(--card-bg); border: 1px solid var(--border); color: var(--text);
    border-radius: 8px; padding: 7px 14px; font-size: 13px; cursor: pointer;
  }
  .chat-toggle-btn:hover { border-color: var(--accent); }
  @media (max-width: 980px) {
    .layout { flex-direction: column; }
    .chat-col { flex-basis: auto; width: 100%; position: static; }
    .chat-col:not([hidden]) {
      position: fixed; inset: 0; z-index: 20; background: var(--bg);
      padding: 12px; overflow-y: auto;
    }
  }
  .summarybar {
    display: flex; gap: 16px; flex-wrap: wrap; align-items: baseline;
    background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px;
    padding: 10px 14px; margin-bottom: 10px; font-size: 13px;
  }
  .summarybar .item { display: flex; gap: 6px; align-items: baseline; }
  .summarybar .item .n { font-size: 16px; font-weight: 700; }
  .summarybar .item .k { color: var(--muted); }
  .filtertabs { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
  .filtertab {
    background: var(--card-bg); border: 1px solid var(--border); color: var(--muted);
    border-radius: 999px; padding: 5px 12px; font-size: 12px; cursor: pointer;
  }
  .filtertab.active { border-color: var(--accent); color: var(--text); background: color-mix(in srgb, var(--accent) 16%, var(--card-bg)); }
  .pc-status-line { font-size: 13px; font-weight: 700; margin: 2px 0 6px; }
  .pc-blocker { font-size: 11px; color: var(--red); margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--border); }
  .stagerow { display: flex; align-items: center; gap: 4px; margin-top: 8px; font-size: 11px; color: var(--muted); }
  .stagerow .stage { display: flex; align-items: center; gap: 4px; }
  .stagerow .dot { width: 8px; height: 8px; border-radius: 999px; border: 1px solid var(--muted); display: inline-block; }
  .stagerow .stage.active .dot { background: var(--accent); border-color: var(--accent); }
  .stagerow .stage.active { color: var(--text); font-weight: 700; }
  .stagerow .arrow { color: var(--border); }
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
  .collapse-header {
    background: none; border: none; color: var(--text); font-size: 13px; text-transform: uppercase;
    letter-spacing: 0.04em; padding: 0; cursor: pointer; display: block; width: 100%; text-align: left;
  }
  .collapse-header .arrow { color: var(--muted); display: inline-block; width: 14px; }
  .collapse-teaser { display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; color: var(--muted); margin-top: 8px; }
  .collapse-teaser .value { color: var(--text); font-weight: 600; }
  .collapse-body { margin-top: 10px; }
  .lifecycle-row { display: flex; align-items: center; gap: 6px; font-size: 14px; flex-wrap: wrap; }
  .lifecycle-row .stage { display: flex; align-items: center; gap: 4px; color: var(--gray); }
  .lifecycle-row .stage.done { color: var(--green); font-weight: 600; }
  .lifecycle-row .stage.current { color: var(--accent); font-weight: 700; }
  .lifecycle-row .stage.pending { color: var(--muted); }
  .lifecycle-row .arrow { color: var(--border); }
</style>
</head>
<body>
<div id="app">
  <h1>오토데브 대시보드 <span style="color:var(--muted); font-weight:400;">(읽기 전용 · localhost)</span></h1>
  <div class="layout">
    <div class="main-col">
      <div class="chat-toggle-row"><button type="button" class="chat-toggle-btn" id="chat-toggle">운영 질문</button></div>
      <div id="content"><div class="empty">불러오는 중...</div></div>
    </div>
    <div class="chat-col" id="chat-panel" hidden>
      <div class="section-title">운영 질문창 <button type="button" class="chat-toggle-btn" id="chat-close" style="float:right;">닫기</button></div>
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

  // Dashboard 운영 UX 최종 정리(§ 요구사항 15/20/21) — 활동 기록/사용량·호출/Git/기준선을
  // 기본 접힘으로 표시하는 공용 wrapper. teaserHtml(선택)은 접힌 상태에서도 항상 보이는
  // 한 줄 요약이다(예: 활동 기록의 "개발 N회/검토 N회/..."). bodyHtml은 펼쳤을 때만 그린다 —
  // 접힌 상태에서는 아예 DOM에 넣지 않는다(§ 요구사항 3 "CSS display:none 금지" — project
  // 계산 자체가 아니라 렌더링 비용 얘기지만, 같은 원칙으로 불필요한 큰 표를 접힌 상태에서
  // 매 polling마다 다시 그리지 않는다).
  function collapsibleSection(key, title, teaserHtml, bodyHtml) {
    var open = isOpen(key);
    var html = '<div class="card wide collapsible">' +
      '<button type="button" class="collapse-header" data-collapse-key="' + esc(key) + '">' +
      '<span class="arrow">' + (open ? "▼" : "▶") + "</span> " + esc(title) + "</button>";
    if (teaserHtml) html += '<div class="collapse-teaser">' + teaserHtml + "</div>";
    if (open) html += '<div class="collapse-body">' + bodyHtml + "</div>";
    html += "</div>";
    return html;
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
  var state = {
    projects: [], selectedProjectId: null, filter: "", chatHistory: [], autoSelectAttempted: false,
    // Dashboard 운영 UX 정리 — 최초 진입 기본값은 "운영"(registered:true)만 보여준다(§
    // 요구사항 2). 사용자가 명시적으로 탭을 바꾸기 전까지는 polling이 반복돼도 이 값이
    // 임의로 바뀌지 않는다.
    registryFilter: "REGISTERED",
    // 운영 질문창은 기본 접힘 상태로 시작한다(§ 요구사항 9) — 버튼으로만 연다.
    chatOpen: false,
    // Dashboard 운영 UX 최종 정리(§ 요구사항 15/20/21) — 활동 기록/사용량·호출/Git/Baseline은
    // 전부 기본 접힘이다. key가 없으면(초기 상태) 접힘으로 취급한다 — true로 명시된 key만
    // 펼쳐진 것으로 본다.
    collapsedOpen: {},
    activityFilter: "전체",
    activityShowAll: false
  };
  function isOpen(key) {
    return state.collapsedOpen[key] === true;
  }

  // ---------------------------------------------------------------------
  // Dashboard 운영 UX 정리 — 대표 상태 6종 단순화(§ 요구사항 6). 내부 enum
  // (taskStatus/runtimeTruth.state)은 전혀 바꾸지 않는다 — 이 함수는 이미 존재하는 값들의
  // 조합만 보고 사람이 5초 안에 읽을 수 있는 대표 라벨 하나로 매핑할 뿐이다. Maintenance
  // Pause는 반드시 "일시정지"이고 절대 "문제 발생"으로 격하되지 않는다(최우선 판정).
  // ---------------------------------------------------------------------
  var REPRESENTATIVE_SUBPHASE_KO = { RUNNING: "개발", TESTING: "테스트", REVIEWING: "검토", REVISING: "수정", CHECKPOINTING: "저장" };
  function representativeStatus(p) {
    if (p.maintenancePause && p.maintenancePause.active) {
      return { label: "일시정지", tone: "GRAY", sub: null };
    }
    if (!p.snapshot) {
      return { label: "준비", tone: "GRAY", sub: null };
    }
    var snap = p.snapshot;
    var rt = p.runtimeTruth;
    if (snap.safety.securityBlocked || snap.taskStatus === "BLOCKED" || snap.runStatus === "BLOCKED") {
      return { label: "문제 발생", tone: "RED", sub: null };
    }
    if (rt && rt.state === "STALE") {
      return { label: "문제 발생", tone: "RED", sub: "정체됨 — 응답 없음" };
    }
    if (snap.taskStatus === "WAITING_HUMAN" || snap.safety.humanApprovalRequired) {
      return { label: "승인 필요", tone: "YELLOW", sub: null };
    }
    if (rt && (rt.state === "RUNNING" || rt.state === "WAITING")) {
      return { label: "작업 중", tone: "GREEN", sub: REPRESENTATIVE_SUBPHASE_KO[snap.taskStatus] || null };
    }
    if (snap.taskStatus === "COMPLETED" || (rt && rt.state === "STOPPED")) {
      return { label: "준비", tone: "GRAY", sub: null };
    }
    return { label: "확인 불가", tone: "GRAY", sub: null };
  }

  // ---------------------------------------------------------------------
  // Dashboard 운영 UX 정리 — 현재 작업/최근 완료/다음 작업 의미 분리(§ 요구사항 5). 실제로
  // 실행 중일 때만 "현재 작업"이라고 주장한다 — 이미 끝난 task를 "현재 작업"으로 표시하던
  // 기존 결함(예: JARVIS 5.4가 COMPLETED인데도 "현재 작업 5.4"로 보이는 것)을 여기서 고정
  // 한다. 확정할 수 없는 조합은 항상 null(UNKNOWN)로 남긴다 — 임의로 추측하지 않는다.
  // ---------------------------------------------------------------------
  function deriveTaskDisplay(p) {
    var snap = p.snapshot;
    var rep = representativeStatus(p);
    var isRunningNow = rep.label === "작업 중" || rep.label === "승인 필요" || (rep.label === "문제 발생" && snap && snap.taskStatus === "BLOCKED");
    var pr = p.projectProgress;
    if (!snap) {
      return { current: null, lastCompleted: null, next: pr && pr.currentTaskId ? { id: pr.currentTaskId, title: pr.currentTaskTitle } : null };
    }
    if (isRunningNow && snap.taskId) {
      return {
        current: { id: snap.taskId, title: undefined },
        lastCompleted: null,
        next: pr && pr.nextTaskId ? { id: pr.nextTaskId, title: pr.nextTaskTitle } : null
      };
    }
    if (snap.taskStatus === "COMPLETED" && snap.taskId) {
      return {
        current: null,
        lastCompleted: { id: snap.taskId, title: undefined },
        next: pr && pr.currentTaskId ? { id: pr.currentTaskId, title: pr.currentTaskTitle } : null
      };
    }
    // 실행 중도 아니고 완료도 아닌 애매한 조합(예: 확인 불가) — 임의로 현재/완료로 단정하지
    // 않는다.
    return { current: null, lastCompleted: null, next: pr && pr.currentTaskId ? { id: pr.currentTaskId, title: pr.currentTaskTitle } : null };
  }

  var STAGE_ORDER = ["개발", "테스트", "검토"];
  function stageRowHtml(sub) {
    if (!sub || STAGE_ORDER.indexOf(sub) === -1) return "";
    var idx = STAGE_ORDER.indexOf(sub);
    var html = '<div class="stagerow">';
    STAGE_ORDER.forEach(function (s, i) {
      if (i > 0) html += '<span class="arrow">→</span>';
      html += '<span class="stage' + (i === idx ? " active" : "") + '"><span class="dot"></span>' + esc(s) + "</span>";
    });
    html += "</div>";
    return html;
  }

  // Dashboard 운영 UX 최종 정리(§ 요구사항 13 "현재 작업 흐름 단순화") — 개발→테스트→검토→
  // 저장 4단계를 실제 lifecycle 데이터로만 판정한다(가짜 진행 상태 금지). 각 단계는 실제로
  // 관측된 값(호출 여부/검사 결과/검토 판정/checkpoint 생성 여부)이 있으면 done, 없고
  // taskStatus가 그 단계를 가리키면 current, 그 외에는 pending이다 — REVISING(수정 중)은
  // Developer가 다시 작업 중이라는 뜻이므로 "개발" 단계의 current로 되돌린다.
  var WORKFLOW_CURRENT_STAGE_BY_STATUS = { RUNNING: "개발", REVISING: "개발", TESTING: "테스트", REVIEWING: "검토", CHECKPOINTING: "저장" };
  function workflowStages(p) {
    var snap = p.snapshot;
    if (!snap) return null;
    var currentKey = WORKFLOW_CURRENT_STAGE_BY_STATUS[snap.taskStatus];
    var defs = [
      { key: "개발", done: snap.development.callCount > 0 },
      { key: "테스트", done: snap.tests.status !== "UNKNOWN" },
      { key: "검토", done: !!snap.review.decision },
      { key: "저장", done: snap.safety.checkpointStatus === "CREATED" }
    ];
    return defs.map(function (d) {
      var state2 = d.done ? "done" : (d.key === currentKey ? "current" : "pending");
      return { key: d.key, state: state2 };
    });
  }
  function renderWorkflowStages(p) {
    var stages = workflowStages(p);
    if (!stages) return card("현재 작업 흐름", '<div class="empty">이 프로젝트는 아직 실행된 적이 없습니다.</div>');
    var marks = { done: "✓", current: "●", pending: "○" };
    var html = '<div class="lifecycle-row">';
    stages.forEach(function (s, i) {
      if (i > 0) html += '<span class="arrow">→</span>';
      html += '<span class="stage ' + s.state + '">' + esc(s.key) + " " + marks[s.state] + "</span>";
    });
    html += "</div>";
    return card("현재 작업 흐름", html);
  }

  function projectDensityClass(count) {
    if (count > 12) return "dense";
    return "";
  }

  // Dashboard 운영 UX 정리(§ 요구사항 4) — 기본 카드는 7개 필수 항목만 보여준다: 이름/
  // 대표상태/현재·완료·다음 작업/경과시간(작업 중일 때만)/현재 단계/최근 검토 결과/blocker
  // 한 줄. Developer attempt 전체 이력·Reviewer 전체 호출이력·Git hash·세부 테스트 같은
  // 깊은 정보는 카드 클릭 후 상세 패널(renderProjectDetail, Level 3)에서만 보여준다.
  function projectCardHtml(p) {
    var rep = representativeStatus(p);
    var taskDisplay = deriveTaskDisplay(p);
    var snap = p.snapshot;

    var taskRows = "";
    if (taskDisplay.current) {
      taskRows += '<div class="pc-row"><span>현재 작업</span><span class="v">' + esc(taskDisplay.current.id) + "</span></div>";
    } else if (taskDisplay.lastCompleted) {
      taskRows += '<div class="pc-row"><span>최근 완료</span><span class="v">' + esc(taskDisplay.lastCompleted.id) + "</span></div>";
    } else {
      taskRows += '<div class="pc-row"><span>최근 완료</span><span class="v">' + NOT_AVAILABLE + "</span></div>";
    }
    if (taskDisplay.next) {
      taskRows += '<div class="pc-row"><span>다음 작업</span><span class="v">' + esc(taskDisplay.next.id) + "</span></div>";
    } else if (p.registered) {
      taskRows += '<div class="pc-row"><span>다음 작업</span><span class="v">' + (p.projectProgress ? "없음(전체 완료)" : NOT_AVAILABLE) + "</span></div>";
    }

    var elapsedRow = "";
    if (rep.label === "작업 중" && snap && snap.currentOperation) {
      elapsedRow = '<div class="pc-row"><span>경과</span><span class="v">' + fmtDuration(snap.currentOperation.elapsedMs) + "</span></div>";
    }

    var phaseRow = "";
    if (p.projectProgress && typeof p.projectProgress.currentTaskPhase === "number") {
      phaseRow = '<div class="pc-row"><span>현재 단계</span><span class="v">' + p.projectProgress.currentTaskPhase +
        (p.projectProgress.totalPhases ? " / " + p.projectProgress.totalPhases : "") + "</span></div>";
    }

    var reviewRow = "";
    var revHistory = p.reviewerHistory || [];
    if (revHistory.length > 0) {
      var lastRev = revHistory[revHistory.length - 1];
      reviewRow = '<div class="pc-row"><span>최근 검토</span><span class="v">' +
        esc(REVIEWER_CALL_RESULT_LABEL_KO[lastRev.result] || lastRev.result) + "</span></div>";
    } else {
      reviewRow = '<div class="pc-row"><span>최근 검토</span><span class="v">' + NOT_AVAILABLE + "</span></div>";
    }

    var blockerLine = "";
    if (rep.label === "문제 발생" || rep.label === "승인 필요") {
      var evidence = delayEvidence(p);
      if (evidence.length > 0) {
        blockerLine = '<div class="pc-blocker">' + esc(evidence[0].label) + (evidence[0].detail ? " — " + esc(evidence[0].detail) : "") + "</div>";
      }
    }

    var regTag = !p.registered ? '<div class="pc-tags">' + pill("미등록(event만 존재)", "GRAY") + "</div>" : "";

    return (
      '<div class="projectcard' + (state.selectedProjectId === p.projectId ? " selected" : "") + '" data-project-id="' + esc(p.projectId) + '">' +
      '<div class="pc-head"><span class="pc-name">' + esc(p.projectLabel) + "</span></div>" +
      '<div class="pc-status-line value ' + rep.tone + '">' + esc(rep.label) + (rep.sub ? " · " + esc(rep.sub) : "") + "</div>" +
      taskRows + phaseRow + reviewRow + elapsedRow +
      stageRowHtml(rep.label === "작업 중" ? rep.sub : null) +
      blockerLine + regTag +
      "</div>"
    );
  }

  // Dashboard 운영 UX 정리(§ 요구사항 2/3) — 기본 화면은 registered:true("운영")만 보여준다.
  // projectId 이름 문자열로 canary/fixture를 추측 분류하지 않는다 — 오직 registered 값만
  // 근거로 쓴다(§ 요구사항: "그런 metadata가 없다면 최소한 운영=registered:true, 기타/과거=
  // registered:false로 정확히 나눈다").
  var REGISTRY_FILTER_TABS = [
    { key: "REGISTERED", label: "운영" },
    { key: "OTHER", label: "기타/과거" },
    { key: "ALL", label: "전체" }
  ];
  function matchesRegistryFilter(p, filterKey) {
    if (filterKey === "REGISTERED") return p.registered === true;
    if (filterKey === "OTHER") return p.registered !== true;
    return true;
  }
  function renderFilterTabs() {
    var html = '<div class="filtertabs">';
    REGISTRY_FILTER_TABS.forEach(function (t) {
      var count = state.projects.filter(function (p) { return matchesRegistryFilter(p, t.key); }).length;
      html += '<button type="button" class="filtertab' + (state.registryFilter === t.key ? " active" : "") +
        '" data-filter-key="' + t.key + '">' + esc(t.label) + " " + count + "</button>";
    });
    html += "</div>";
    return html;
  }

  // Dashboard 운영 UX 정리(§ 요구사항 3 LEVEL 1) — "운영"(registered:true) 프로젝트 전체를
  // 대상으로 5초 안에 읽을 수 있는 요약 한 줄. 현재 선택된 필터 탭과 무관하게 항상 운영
  // 프로젝트 기준으로 집계한다(전체 상황 요약이라는 목적 자체가 필터 전환과 별개다).
  function renderSummaryBar() {
    var ops = state.projects.filter(function (p) { return p.registered === true; });
    var counts = { 작업중: 0, 준비: 0, 문제: 0, 승인필요: 0 };
    ops.forEach(function (p) {
      var label = representativeStatus(p).label;
      if (label === "작업 중") counts.작업중++;
      else if (label === "준비") counts.준비++;
      else if (label === "문제 발생") counts.문제++;
      else if (label === "승인 필요") counts.승인필요++;
    });
    var items = [
      { k: "운영 프로젝트", n: ops.length },
      { k: "작업 중", n: counts.작업중 },
      { k: "준비", n: counts.준비 },
      { k: "문제", n: counts.문제 },
      { k: "승인 필요", n: counts.승인필요 }
    ];
    var html = '<div class="summarybar">';
    items.forEach(function (it) {
      html += '<span class="item"><span class="n">' + it.n + '</span><span class="k">' + esc(it.k) + "</span></span>";
    });
    html += "</div>";
    return html;
  }

  function renderOfficeGrid() {
    var byRegistryFilter = state.projects.filter(function (p) { return matchesRegistryFilter(p, state.registryFilter); });
    var filtered = byRegistryFilter.filter(function (p) {
      if (!state.filter) return true;
      var needle = state.filter.toLowerCase();
      return p.projectLabel.toLowerCase().indexOf(needle) !== -1 || p.projectId.toLowerCase().indexOf(needle) !== -1;
    });
    var toolbar =
      renderFilterTabs() +
      '<div class="toolbar">' +
      '<input type="search" id="project-filter" placeholder="현재 필터 안에서 이름/ID 검색" value="' + esc(state.filter) + '" />' +
      '<span class="count">' + filtered.length + " / " + byRegistryFilter.length + "개 표시</span>" +
      "</div>";
    if (state.projects.length === 0) {
      return renderSummaryBar() + toolbar + '<div class="card"><div class="empty">표시할 프로젝트가 없습니다. AUTODEV_DASHBOARD_PROJECT_ADAPTERS(또는 AUTODEV_PROJECT_ADAPTER) 설정과 event 기록을 확인하세요.</div></div>';
    }
    if (byRegistryFilter.length === 0) {
      var emptyMsg = state.registryFilter === "REGISTERED"
        ? "운영(registered) 프로젝트가 없습니다 — '전체' 탭에서 다른 프로젝트를 확인할 수 있습니다."
        : "이 필터에 해당하는 프로젝트가 없습니다.";
      return renderSummaryBar() + toolbar + '<div class="card"><div class="empty">' + esc(emptyMsg) + "</div></div>";
    }
    var html = '<div class="officegrid ' + projectDensityClass(byRegistryFilter.length) + '">';
    filtered.forEach(function (p) { html += projectCardHtml(p); });
    html += "</div>";
    return renderSummaryBar() + toolbar + html;
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

  // Dashboard 운영 UX 최종 정리(§ 요구사항 14 "프로젝트 진행률") — 현재 단계/전체 단계,
  // 완료 작업/전체 작업, 전체 진행률로만 제한한다. "다음 진행 예정"/"그 다음 작업"은
  // renderTaskSummaryCard의 "다음 작업"(§ deriveTaskDisplay)과 중복이라 여기서는 뺀다(§
  // 요구사항: 중복되는 프로젝트 진행 상황 카드가 여러 군데 있으면 통합).
  function renderProjectProgress(p) {
    var pr = p.projectProgress;
    if (!pr) {
      return card("프로젝트 진행 상황", '<div class="empty">' + (p.registered ? "task-registry/project-state를 읽지 못했습니다." : "이 project는 registry에 등록되지 않아 전체 진행률을 알 수 없습니다(event 기반 정보만 표시).") + "</div>");
    }
    var rows =
      row("현재 단계", (typeof pr.currentTaskPhase === "number" ? pr.currentTaskPhase : NOT_AVAILABLE) + " / " + fmtNum(pr.totalPhases)) +
      row("완료 작업", fmtNum(pr.completedTaskCount) + " / " + fmtNum(pr.totalTasks));
    var bars = progressBar(pr.overallProgressPercent, "전체 진행률");
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
      // 이 행은 "지금 이 run/snapshot이 어떤 task에 대한 것인가"를 보여줄 뿐, 그 task가
      // 실제로 지금 실행 중이라고 주장하지 않는다(완료된 task여도 그대로 표시됨) — "현재
      // 작업"이라는 이름은 그 오해를 만들 수 있어 대상 작업으로 부른다(§ 요구사항 5, 위
      // renderTaskSummaryCard의 "현재 작업"만 실제 실행 여부를 판정한다).
      row("대상 작업", orDash(snap.taskId)) +
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

  // Dashboard 운영 UX 최종 정리(§ 요구사항 19 "Developer 표시 축소") — 기본 화면에는 가장
  // 최근 시도 하나만 보여준다. 전체 attempt 이력은 "개발 이력" 라벨을 그대로 유지한 채
  // 아래 활동 기록(§ renderActivityLog, "개발" 필터)에서 볼 수 있다 — 데이터/판정 로직은
  // 그대로 재사용할 뿐 새로 만들지 않는다.
  function renderDeveloperLifecycle(p) {
    var lc = p.developerLifecycle;
    if (!lc || lc.attempts.length === 0) {
      return card("개발 이력", '<div class="empty">이 작업에 대한 개발 담당 호출 기록이 아직 없습니다.</div>');
    }
    var latest = lc.latest || lc.attempts[lc.attempts.length - 1];
    var outcomeLabel = DEVELOPER_OUTCOME_LABEL_KO[latest.outcome] || latest.outcome;
    var outcomeTone = DEVELOPER_OUTCOME_TONE[latest.outcome] || "GRAY";
    var rows =
      row(latest.attemptNumber + "번째 시도", esc(outcomeLabel), outcomeTone) +
      row("시작", esc(fmtDateTime(latest.startedAt))) +
      row("실행시간", latest.durationMs !== undefined ? fmtDuration(latest.durationMs) : (latest.outcome === "RUNNING" ? "진행 중" : "—")) +
      row("전체 시도 횟수", String(lc.attempts.length));
    return card("개발 이력(최근)", rows);
  }

  // Dashboard 운영 UX 최종 정리(§ 요구사항 18 "Reviewer 표시 축소") — 최근 호출 1건만 표시.
  // 전체 호출 이력(provider/model/순번/cycle)은 활동 기록("검토" 필터)에서 그대로 확인할 수
  // 있다.
  function renderReviewerHistory(p) {
    var history = p.reviewerHistory || [];
    if (history.length === 0) {
      return card("검토 이력", '<div class="empty">아직 검토 담당이 호출된 적이 없습니다.</div>');
    }
    var last = history[history.length - 1];
    var tone = REVIEWER_CALL_RESULT_TONE[last.result] || "GRAY";
    var rows =
      row("서비스", esc(last.service)) +
      row("모델", orDash(last.model)) +
      row("결과", esc(REVIEWER_CALL_RESULT_LABEL_KO[last.result] || last.result), tone) +
      row("전체 호출 횟수", String(history.length));
    return card("검토 이력(최근)", rows);
  }

  function usageTotalsRows(t) {
    return (
      row("입력 토큰", fmtNum(t.totals.inputTokens)) +
      row("출력 토큰", fmtNum(t.totals.outputTokens)) +
      row("전체 토큰", fmtNum(t.totals.totalTokens)) +
      row("외부 인공지능 호출 횟수", fmtNum(t.totals.callCount))
    );
  }
  function serviceUsageTableHtml(list) {
    if (!list || list.length === 0) return '<div class="empty">아직 호출된 외부 인공지능 서비스가 없습니다.</div>';
    var html = '<div class="tablewrap"><table class="calls"><thead><tr>' +
      "<th>서비스</th><th>모델</th><th>호출 횟수</th><th>입력 토큰</th><th>출력 토큰</th><th>전체 토큰</th>" +
      "</tr></thead><tbody>";
    list.forEach(function (u2) {
      html += "<tr><td>" + esc(u2.service) + "</td><td>" + orDash(u2.model) + "</td><td>" + fmtNum(u2.callCount) + "</td><td>" +
        fmtNum(u2.inputTokens) + "</td><td>" + fmtNum(u2.outputTokens) + "</td><td>" + fmtNum(u2.totalTokens) + "</td></tr>";
    });
    html += "</tbody></table></div>";
    return html;
  }
  function recentCallsTableHtml(calls) {
    if (!calls || calls.length === 0) return '<div class="empty">아직 호출 기록이 없습니다.</div>';
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
    return html;
  }

  // Dashboard 운영 UX 최종 정리(§ 요구사항 20 "사용량 / 호출") — 기존 4개 카드(사용량/
  // 서비스별 호출량/최근 호출 기록/비용)를 하나의 접힌 섹션으로 묶는다. 데이터는 삭제하지
  // 않는다 — 펼쳤을 때만 계산 없이 그대로 다시 보여준다(집계 로직 재사용, 새로 만들지 않음).
  function renderUsageSection(p) {
    var u = p.usageOverview;
    var snap = p.snapshot;
    var body = "";
    if (!u) {
      body += subheading("사용량") + '<div class="empty">' + NO_DATA + "</div>";
    } else {
      body += subheading("전체 누적") + usageTotalsRows(u.allTime);
      body += subheading("현재 작업") + (u.currentTask ? usageTotalsRows(u.currentTask) : '<div class="empty">현재 작업 없음</div>');
      body += subheading("서비스별 호출량") + serviceUsageTableHtml(u.allTime.byService);
    }
    body += subheading("최근 외부 인공지능 호출 기록") + recentCallsTableHtml(p.recentCalls);
    if (snap) {
      var actual = fmtUsd(snap.usage.actualCostUsd);
      var estimated = fmtUsd(snap.usage.estimatedCostUsd);
      if (actual !== null || estimated !== null) {
        var costRows = (actual !== null ? row("실제 비용", actual) : "") + (estimated !== null ? row("예상 비용", estimated) : "");
        body += subheading("비용") + costRows;
      }
    }
    return collapsibleSection("usage", "사용량 / 호출", null, body);
  }

  // Dashboard 운영 UX 최종 정리(§ 요구사항 17 "작업 성공/실패 기록") — 수십 건짜리 표를 기본
  // 화면에 그대로 두지 않는다. 성공/실패 총계와 가장 최근 실패 한 줄만 보여주고, 상세 목록은
  // 아래 활동 기록("실패" 필터, § renderActivityLog)에서 확인하게 한다 — 같은 데이터를 두
  // 곳에서 서로 다른 형태로 유지하지 않는다.
  function renderAttemptOutcomes(p) {
    var ao = p.attemptOutcomes;
    if (!ao || (ao.successCount === 0 && ao.failureCount === 0)) {
      return card("작업 시도 결과(성공/실패)", '<div class="empty">아직 확정된 시도(checkpoint 성공 또는 최종 차단)가 없습니다.</div>');
    }
    var html = row("성공", fmtNum(ao.successCount), ao.successCount > 0 ? "GREEN" : "GRAY") +
      row("실패", fmtNum(ao.failureCount), ao.failureCount > 0 ? "YELLOW" : "GRAY");
    var recent = ao.recent || [];
    var latestFailure = recent.filter(function (a) { return a.result !== "SUCCESS"; })[0];
    if (latestFailure) {
      html += row("최근 실패", orDash(latestFailure.taskId) + " · " + esc(orDash(latestFailure.reason)));
    }
    if (ao.failureCount > 0) {
      html += '<div class="pc-blocker" style="border-top:none;padding-top:0;color:var(--muted);">상세 목록은 아래 "활동 기록 → 실패"에서 확인할 수 있습니다.</div>';
    }
    return card("작업 시도 결과(성공/실패)", html);
  }

  // Dashboard 운영 UX 정리(§ 요구사항 8 상세 패널 Git) — 새 기록 경로를 만들지 않는다.
  // attemptOutcomes.recent(이미 CHECKPOINT_CREATED event만 근거로 삼는 기존 집계, §
  // dashboard-attempt-outcomes.ts)에서 가장 최근 SUCCESS 항목의 commitHash를 그대로
  // 노출할 뿐이다 — commitHash가 기록돼 있지 않으면 추측하지 않고 확인 불가로 남긴다.
  // Dashboard 운영 UX 최종 정리(§ 요구사항 21) — 기본 접힘.
  function renderGitInfo(p) {
    var recent = (p.attemptOutcomes && p.attemptOutcomes.recent) || [];
    var latestSuccess = recent.filter(function (a) { return a.result === "SUCCESS" && a.commitHash; })[0];
    var body = latestSuccess
      ? row("최근 checkpoint", latestSuccess.commitHash) + row("작업", orDash(latestSuccess.taskId))
      : '<div class="empty">최근 checkpoint commit 기록이 없습니다.</div>';
    return collapsibleSection("git", "Git", null, body);
  }

  // Dashboard 운영 UX 정리(§ 요구사항 12 Baseline/Telemetry) — dashboard-baseline.ts가
  // 계산한 "현재 task의 실측치"를 그대로 보여준다. 비교할 이전 기준을 어디에도 저장하지
  // 않으므로(§ dashboard-baseline.ts 주석) 가짜 %/증감을 만들지 않고 "기준 데이터 없음"을
  // 그대로 표시한다 — 원시 수치만 보조 정보로 함께 보여준다. Dashboard 운영 UX 최종
  // 정리(§ 요구사항 21) — 기본 접힘. Baseline 기능 자체는 삭제하지 않는다(Graphify A/B에서
  // 다시 쓴다).
  function renderBaseline(p) {
    var b = p.baseline;
    var body = !b
      ? '<div class="empty">현재 작업에 대한 실측 자료가 아직 없습니다.</div>'
      : row("기준 대비", "기준 데이터 없음") +
        row("개발 담당 호출(현재 작업)", fmtNum(b.developerCallCount)) +
        row("검토 담당 호출(현재 작업)", fmtNum(b.reviewerCallCount)) +
        row("작업시간(현재 작업)", fmtDuration(b.taskDurationMs)) +
        row("수정 요청(REVISE) 횟수", fmtNum(b.reviseCount));
    return collapsibleSection("baseline", "기준(Baseline)", null, body);
  }

  // Dashboard 운영 UX 최종 정리(§ 요구사항 15/16 "활동 기록 통합") — developerLifecycle/
  // reviewerHistory/recentCalls/attemptOutcomes(전부 기존 read model, 새 집계 로직 없음)를
  // 실제 timestamp 기준으로 하나의 시간순 목록으로 합친다(네 소스 모두 실제 ISO timestamp
  // 필드를 갖고 있어 억지로 섞는 게 아니다). recentCalls/attemptOutcomes.recent는
  // 백엔드에서 이미 최근 20건으로 제한돼 있다(§ dashboard-snapshot-provider.ts
  // RECENT_CALLS_LIMIT, dashboard-attempt-outcomes.ts RECENT_LIMIT) — "외부 호출" 총
  // 횟수는 그래서 이 목록 길이가 아니라 usageOverview.allTime.totals.callCount(누적 실제
  // 호출 수)로 표시한다.
  var ACTIVITY_TYPE_LABEL_KO = { dev: "개발", review: "검토", call: "외부 호출", fail: "실패" };
  var ACTIVITY_FILTER_TABS = ["전체", "개발", "검토", "외부 호출", "실패"];
  var ACTIVITY_DEFAULT_COUNT = 8;
  function buildActivityItems(p, filterKey) {
    var items = [];
    var lc = p.developerLifecycle;
    if (lc && (filterKey === "전체" || filterKey === "개발")) {
      lc.attempts.forEach(function (a) {
        items.push({
          type: "dev",
          time: a.startedAt,
          text: a.attemptNumber + "번째 시도 · " + esc(DEVELOPER_OUTCOME_LABEL_KO[a.outcome] || a.outcome),
          tone: DEVELOPER_OUTCOME_TONE[a.outcome] || "GRAY"
        });
      });
    }
    var rh = p.reviewerHistory || [];
    if (filterKey === "전체" || filterKey === "검토") {
      rh.forEach(function (r) {
        items.push({
          type: "review",
          time: r.timestamp,
          text: "#" + r.sequenceNumber + " · " + esc(r.service) + (r.model ? " · " + esc(r.model) : "") + " · " + esc(REVIEWER_CALL_RESULT_LABEL_KO[r.result] || r.result),
          tone: REVIEWER_CALL_RESULT_TONE[r.result] || "GRAY"
        });
      });
    }
    var calls = p.recentCalls || [];
    if (filterKey === "전체" || filterKey === "외부 호출") {
      calls.forEach(function (c) {
        items.push({
          type: "call",
          time: c.timestamp,
          text: esc(c.purpose) + " · " + esc(c.service) + (c.model ? " · " + esc(c.model) : ""),
          tone: c.success ? "GREEN" : "RED"
        });
      });
    }
    var ao = (p.attemptOutcomes && p.attemptOutcomes.recent) || [];
    if (filterKey === "전체" || filterKey === "실패") {
      ao.filter(function (a) { return a.result !== "SUCCESS"; }).forEach(function (a) {
        items.push({ type: "fail", time: a.occurredAt, text: orDash(a.taskId) + " · " + esc(orDash(a.reason)), tone: "RED" });
      });
    }
    items.sort(function (x, y) { return Date.parse(y.time || 0) - Date.parse(x.time || 0); });
    return items;
  }
  function renderActivityLog(p) {
    var devCount = (p.developerLifecycle && p.developerLifecycle.attempts.length) || 0;
    var revCount = (p.reviewerHistory && p.reviewerHistory.length) || 0;
    var callCount = p.usageOverview ? p.usageOverview.allTime.totals.callCount : 0;
    var successCount = (p.attemptOutcomes && p.attemptOutcomes.successCount) || 0;
    var failureCount = (p.attemptOutcomes && p.attemptOutcomes.failureCount) || 0;
    var teaser =
      '<span>개발 <span class="value">' + devCount + '회</span></span>' +
      '<span>검토 <span class="value">' + revCount + '회</span></span>' +
      '<span>외부 호출 <span class="value">' + fmtNum(callCount) + '회</span></span>' +
      '<span>성공 <span class="value GREEN">' + successCount + '</span></span>' +
      '<span>실패 <span class="value ' + (failureCount > 0 ? "YELLOW" : "GRAY") + '">' + failureCount + "</span></span>";

    if (!isOpen("activity")) {
      return collapsibleSection("activity", "활동 기록", teaser, "");
    }
    var filterKey = state.activityFilter;
    var items = buildActivityItems(p, filterKey);
    var tabsHtml = '<div class="filtertabs">' + ACTIVITY_FILTER_TABS.map(function (f) {
      return '<button type="button" class="filtertab' + (filterKey === f ? " active" : "") + '" data-activity-filter="' + esc(f) + '">' + esc(f) + "</button>";
    }).join("") + "</div>";
    var body;
    if (items.length === 0) {
      body = tabsHtml + '<div class="empty">이 분류에 기록이 없습니다.</div>';
    } else {
      var showAll = state.activityShowAll;
      var visible = showAll ? items : items.slice(0, ACTIVITY_DEFAULT_COUNT);
      var listHtml = '<div class="tablewrap"><table class="calls"><thead><tr><th>시각</th><th>구분</th><th>내용</th></tr></thead><tbody>' +
        visible.map(function (it) {
          return "<tr><td>" + esc(fmtDateTime(it.time)) + "</td><td>" + esc(ACTIVITY_TYPE_LABEL_KO[it.type]) + '</td><td class="value ' + it.tone + '">' + it.text + "</td></tr>";
        }).join("") + "</tbody></table></div>";
      var moreBtn = !showAll && items.length > ACTIVITY_DEFAULT_COUNT
        ? '<button type="button" class="chat-toggle-btn" id="activity-show-all" style="margin-top:8px;">전체 기록 보기(' + items.length + "건)</button>"
        : "";
      body = tabsHtml + listHtml + moreBtn;
    }
    return collapsibleSection("activity", "활동 기록", teaser, body);
  }


  function renderQuality(p) {
    var snap = p.snapshot;
    var q = snap.quality;
    var hist = snap.historical;
    var fp = q.firstPassApproved === undefined ? NOT_AVAILABLE : q.firstPassApproved ? "예" : "아니오";
    var ps = p.problemSolving;
    var rows =
      row("첫 검토 통과율", typeof hist.firstPassApprovalRate === "number" ? fmtPercent(hist.firstPassApprovalRate * 100) : NO_DATA) +
      row("현재 작업 검토 반복 횟수", String(snap.review.reviewCycle)) +
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

  // Dashboard 운영 UX 최종 정리(§ 요구사항 11/12 "현재 문제 해결 상황 최우선 이동 +
  // 지연/Blocker 카드 통합") — 기존에 별도 카드였던 지연/Blocker 근거(delayEvidence)를 이
  // 카드 하나로 합친다("현재 Blocker" 행). 의도적 Maintenance Pause는 여기서도 blocker로
  // 취급하지 않는다 — delayEvidence()가 이미 그 항목을 GRAY 톤의 "의도적" 항목으로만 담고,
  // 대표 상태 판정(representativeStatus)도 별도로 "일시정지"를 최우선 처리한다(§ 요구사항 6).
  function renderProblemSolving(p) {
    var ps = p.problemSolving;
    var evidence = delayEvidence(p);
    var blockerRow = row("현재 Blocker", evidence.length > 0 ? esc(evidence[0].label) + (evidence[0].detail ? " — " + esc(evidence[0].detail) : "") : "없음", evidence.length > 0 ? evidence[0].tone : "GREEN");
    if (!ps || !ps.currentProblem) {
      if (evidence.length === 0) {
        return card("현재 문제 해결 상황", '<div class="empty">현재 문제 없음</div>');
      }
      return card("현재 문제 해결 상황", blockerRow);
    }
    var cp = ps.currentProblem;
    var ce = p.callEfficiency;
    var localRecoveryLabel = ce ? (ce.localRecoverySuccessRounds > 0 ? "로컬 복구 " + ce.localRecoverySuccessRounds + "회" : "로컬 복구 없음") : NOT_AVAILABLE;
    var rows =
      row("문제 유형", ERROR_TYPE_LABEL_KO[cp.errorType] || cp.errorType) +
      row("실패한 검사", orDash(cp.failedCheck)) +
      row("같은 오류 반복 횟수", String(cp.repeatedFailureCount)) +
      blockerRow +
      row("해결 상태", cp.resolved ? "해결됨" : "진행 중", cp.resolved ? "GREEN" : "YELLOW") +
      row("마지막 관측 시각", esc(fmtDateTime(cp.lastSeenAt))) +
      row("과거 유사 사례 수", String(ps.similarPastCasesCount)) +
      row("과거 해결책 재사용 여부", ps.similarPastCasesCount > 0 ? "재사용 가능한 사례 있음" : "없음") +
      row("자동 복구 상태(현재 작업)", localRecoveryLabel);
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

  // Dashboard 운영 UX 정리(§ 요구사항 8) — 상세 패널 맨 위에 카드에서 이미 봤던 대표
  // 상태/최근완료/다음작업을 한 번 더 요약해준다(깊은 표로 내려가기 전에 다시 확인).
  function renderTaskSummaryCard(p) {
    var rep = representativeStatus(p);
    var taskDisplay = deriveTaskDisplay(p);
    var rows = row("상태", esc(rep.label) + (rep.sub ? " · " + esc(rep.sub) : ""), rep.tone);
    rows += row("최근 완료", taskDisplay.lastCompleted ? esc(taskDisplay.lastCompleted.id) : NOT_AVAILABLE);
    rows += row("현재 작업", taskDisplay.current ? esc(taskDisplay.current.id) : "없음");
    rows += row("다음 작업", taskDisplay.next ? esc(taskDisplay.next.id) : NOT_AVAILABLE);
    return card("요약", rows);
  }

  // Dashboard 운영 UX 최종 정리(§ 요구사항 8 "메인 화면 정보 순서") — 상세 패널 카드 순서를
  // "요약 → 현재 문제 해결 상황 → 현재 작업 흐름 → 진행률 → 품질/최근 검토 → 접힌 상세
  // 기록"으로 고정한다. 판정 로직은 전혀 바꾸지 않는다 — 이미 존재하는 render 함수들을
  // 재배치/재구성했을 뿐이다.
  function renderProjectDetail(p) {
    if (!p) return "";
    if (p.status === "NO_RUN_YET" || !p.snapshot) {
      return (
        '<div class="section-title">' + esc(p.projectLabel) + " 상세" + "</div>" +
        renderMaintenanceBanner(p) +
        '<div class="grid">' + renderTaskSummaryCard(p) + renderProblemSolving(p) + renderProjectProgress(p) + card("실행 이력", '<div class="empty">이 프로젝트는 아직 실행된 적이 없습니다(NO_RUN_YET).</div>') + "</div>"
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
      // 1) 요약
      renderTaskSummaryCard(p) +
      // 2) 현재 문제 해결 상황(+ 지연/Blocker 통합, § 요구사항 11/12)
      renderProblemSolving(p) +
      // 3) 현재 작업 흐름(§ 요구사항 13) + 그 흐름을 뒷받침하는 상세 상태
      renderWorkflowStages(p) +
      renderQuickGlance(p) +
      renderCurrentStatus(p) +
      renderActualWorkTime(p) +
      // 4) 프로젝트 진행률(§ 요구사항 14)
      renderProjectProgress(p) +
      // 5) 품질 / 최근 검토(§ 요구사항 6)
      renderQuality(p) +
      renderReviewerHistory(p) +
      renderDeveloperLifecycle(p) +
      renderAttemptOutcomes(p) +
      // 6) 접힌 상세 기록(§ 요구사항 7) — 활동 기록/사용량·호출/Git/Baseline
      renderActivityLog(p) +
      renderUsageSection(p) +
      renderGitInfo(p) +
      renderBaseline(p) +
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
    document.querySelectorAll(".filtertab[data-filter-key]").forEach(function (el) {
      el.addEventListener("click", function () {
        state.registryFilter = el.getAttribute("data-filter-key");
        render(data);
      });
    });
    // Dashboard 운영 UX 최종 정리(§ 요구사항 15/16) — 활동 기록 필터 탭. registry 필터 탭과
    // 같은 .filtertab 시각 스타일을 재사용하되 data-activity-filter로 구분한다(§ 요구사항:
    // 새 CSS를 중복 정의하지 않는다).
    document.querySelectorAll(".filtertab[data-activity-filter]").forEach(function (el) {
      el.addEventListener("click", function () {
        state.activityFilter = el.getAttribute("data-activity-filter");
        state.activityShowAll = false;
        render(data);
      });
    });
    // Dashboard 운영 UX 최종 정리(§ 요구사항 15/20/21) — 활동 기록/사용량·호출/Git/Baseline
    // 공용 접힘 토글. isOpen()이 유일한 진실 출처다.
    document.querySelectorAll(".collapse-header[data-collapse-key]").forEach(function (el) {
      el.addEventListener("click", function () {
        var key = el.getAttribute("data-collapse-key");
        state.collapsedOpen[key] = !isOpen(key);
        if (key === "activity") state.activityShowAll = false;
        render(data);
      });
    });
    var activityShowAllBtn = document.getElementById("activity-show-all");
    if (activityShowAllBtn) {
      activityShowAllBtn.addEventListener("click", function () {
        state.activityShowAll = true;
        render(data);
      });
    }
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

  // Dashboard 운영 UX 최종 정리(§ 요구사항 7 "frontend polling 점검") — snapshot 계산
  // 시간이 polling 주기(REFRESH_MS)보다 길어지면 이전 fetch가 끝나기 전에 다음 fetch가
  // 나가 요청이 계속 쌓일 수 있다(scheduler/Core와 무관한, 이 client script만의 안전장치).
  // requestInFlight === true면 다음 tick을 건너뛴다 — 서버가 일시적으로 느려져도 요청
  // backlog가 스스로 커지지 않는다.
  var requestInFlight = false;
  function tick() {
    if (requestInFlight) return;
    requestInFlight = true;
    fetch("/api/snapshots", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () {
        document.getElementById("content").innerHTML = '<div class="empty">데이터를 불러오지 못했습니다. 대시보드 서버 상태를 확인하세요.</div>';
      })
      .then(function () {
        requestInFlight = false;
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

  // Dashboard 운영 UX 정리(§ 요구사항 9) — 운영 질문창은 기본 접힘. panel/버튼은 정적
  // 셸에 고정으로 존재하므로(카드처럼 매 polling마다 다시 그려지지 않는다) 리스너를 한 번만
  // 붙인다. state.chatOpen이 유일한 진실 출처이고, panel의 hidden attribute만 그 값을
  // 따라간다 — 다른 렌더링 로직에는 영향을 주지 않는다.
  function applyChatOpenState() {
    var panel = document.getElementById("chat-panel");
    if (panel) panel.hidden = !state.chatOpen;
  }
  var chatToggleBtn = document.getElementById("chat-toggle");
  if (chatToggleBtn) {
    chatToggleBtn.addEventListener("click", function () {
      state.chatOpen = true;
      applyChatOpenState();
      renderChatScope();
    });
  }
  var chatCloseBtn = document.getElementById("chat-close");
  if (chatCloseBtn) {
    chatCloseBtn.addEventListener("click", function () {
      state.chatOpen = false;
      applyChatOpenState();
    });
  }
  applyChatOpenState();

  tick();
  setInterval(tick, REFRESH_MS);
})();
</script>
</body>
</html>
`;
