// Local Operations Dashboard — Read-only HTML/CSS/JS page (Phase G Task G4.1).
//
// 별도 frontend framework(React/Next/Vite 등)를 쓰지 않는다 — 이 저장소에 프론트엔드
// 빌드 도구가 전혀 없고(package.json 참고), 이 Task 범위(로컬 읽기 전용 MVP)에는 하나의
// 정적 HTML 문자열 + fetch 기반 polling으로 충분하다. 이 문자열은 dashboard-server.ts가
// GET / 응답으로 그대로 서빙한다 — 별도 static asset 빌드 단계가 필요 없다(tsc 컴파일
// 결과물 하나로 완결).
//
// 이 페이지는 GET /api/snapshot 하나만 호출한다 — approve/reject/실행/git/파일수정 같은
// 어떤 쓰기 요청도 만들지 않는다(client JS 전체를 봐도 fetch 호출이 이 한 곳뿐이다).
export const DASHBOARD_HTML = `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AutoDev Operations Dashboard</title>
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
    font-size: 20px;
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
  .card h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 10px; }
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
  .empty { color: var(--muted); text-align: center; padding: 40px 10px; }
  .footer { color: var(--muted); font-size: 12px; text-align: center; margin-top: 14px; }
  #app { max-width: 900px; margin: 0 auto; }
</style>
</head>
<body>
<div id="app">
  <h1>AutoDev Operations Dashboard <span style="color:var(--muted); font-weight:400;">(읽기 전용 · localhost)</span></h1>
  <div id="content"><div class="empty">불러오는 중...</div></div>
  <div class="footer" id="footer"></div>
</div>
<script>
(function () {
  var REFRESH_MS = 3000;

  var STATUS_TONE = {
    IDLE: "GRAY", RUNNING: "GREEN", TESTING: "GREEN", REVIEWING: "GREEN",
    REVISING: "YELLOW", WAITING_HUMAN: "YELLOW", BLOCKED: "RED",
    CHECKPOINTING: "GREEN", COMPLETED: "GREEN", UNKNOWN: "GRAY"
  };
  var STATUS_LABEL_KO = {
    IDLE: "대기 중", RUNNING: "실행 중", TESTING: "테스트 중", REVIEWING: "리뷰 중",
    REVISING: "수정 중", WAITING_HUMAN: "사람 승인 대기", BLOCKED: "차단됨",
    CHECKPOINTING: "체크포인트 생성 중", COMPLETED: "완료", UNKNOWN: "알 수 없음"
  };
  var ADVISORY_ROLES = [
    { role: "planner", label: "Planner" },
    { role: "research", label: "Research" },
    { role: "qa", label: "QA" },
    { role: "security", label: "Security" }
  ];

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function orDash(v) {
    return v === undefined || v === null || v === "" ? "—" : esc(v);
  }
  function fmtNum(n) {
    return typeof n === "number" ? n.toLocaleString("ko-KR") : "데이터 없음";
  }
  function fmtPercent(n) {
    return typeof n === "number" ? n.toFixed(1) + "%" : "데이터 없음";
  }
  function fmtUsd(n) {
    return typeof n === "number" ? "$" + n.toFixed(4) : null;
  }
  function fmtElapsed(ms) {
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
  function row(label, valueHtml, tone) {
    return '<div class="row"><span class="label">' + esc(label) + '</span>' +
      '<span class="value' + (tone ? " " + tone : "") + '">' + valueHtml + "</span></div>";
  }
  function card(title, rowsHtml) {
    return '<div class="card"><h2>' + esc(title) + "</h2>" + rowsHtml + "</div>";
  }

  function renderNoRun() {
    return '<div class="banner badge-GRAY"><span>AutoDev — 실행 이력 없음</span></div>' +
      '<div class="card"><div class="empty">아직 기록된 run이 없습니다. AutoDev를 한 번 이상 실행하면 여기에 표시됩니다.</div></div>';
  }

  function renderAuditBanner(snap) {
    if (snap.integrity !== "DEGRADED") return "";
    return '<div class="audit-degraded">AUDIT DEGRADED<div class="note">' +
      esc(snap.integrityNote || "일부 기록이 누락/손상됐을 수 있습니다.") + "</div></div>";
  }

  function overallTone(snap) {
    if (snap.safety.securityBlocked || snap.taskStatus === "BLOCKED" || snap.runStatus === "BLOCKED") return "RED";
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

  function renderQuickGlance(snap) {
    var approvalNeeded = snap.taskStatus === "WAITING_HUMAN" || snap.safety.humanApprovalRequired;
    var items = [
      { k: "AutoDev", v: STATUS_LABEL_KO[snap.taskStatus] || snap.taskStatus, tone: STATUS_TONE[snap.taskStatus] || "GRAY" },
      { k: "승인 필요", v: approvalNeeded ? "예" : "아니오", tone: approvalNeeded ? "YELLOW" : "GREEN" },
      { k: "Test", v: snap.tests.status, tone: snap.tests.status === "PASS" ? "GREEN" : snap.tests.status === "FAIL" ? "RED" : "GRAY" },
      { k: "Reviewer", v: orDash(snap.review.decision), tone: snap.review.decision === "PASS" ? "GREEN" : snap.review.decision === "REVISE" ? "YELLOW" : snap.review.decision ? "RED" : "GRAY" },
      { k: "Security", v: snap.safety.securityBlocked ? "BLOCKED" : "정상", tone: snap.safety.securityBlocked ? "RED" : "GREEN" }
    ];
    var html = items.map(function (it) {
      return '<div class="quickitem"><div class="k">' + esc(it.k) + '</div><div class="v value ' + it.tone + '">' + esc(it.v) + "</div></div>";
    }).join("");
    return card("지금 한눈에", '<div class="quickgrid">' + html + "</div>");
  }

  function renderOverview(snap) {
    var rows =
      row("AutoDev 상태", esc(STATUS_LABEL_KO[snap.runStatus] || snap.runStatus), STATUS_TONE[snap.runStatus]) +
      row("Project", orDash(snap.projectId)) +
      row("Run", orDash(snap.runId ? snap.runId.slice(0, 8) : undefined)) +
      row("Task", orDash(snap.taskId)) +
      row("현재 작업", orDash(snap.currentOperation.currentAction)) +
      row("경과 시간", fmtElapsed(snap.currentOperation.elapsedMs)) +
      row("Audit Integrity", snap.integrity, snap.integrity === "CLEAN" ? "GREEN" : "RED");
    return card("Overview", rows);
  }

  function renderLiveOperations(snap) {
    var agent = snap.currentOperation.activeAgentRole
      ? snap.currentOperation.activeAgentRole + " (" + orDash(snap.currentOperation.activeAgentId) + ")"
      : "없음";
    var rows =
      row("현재 Agent / Role", esc(agent)) +
      row("Developer 상태", snap.development.callCount > 0 ? "호출 " + snap.development.callCount + "회" : "호출 없음") +
      row("Test 상태", snap.tests.status, snap.tests.status === "PASS" ? "GREEN" : snap.tests.status === "FAIL" ? "RED" : "GRAY") +
      row("Reviewer 상태", orDash(snap.review.decision)) +
      row("Review Cycle", String(snap.review.reviewCycle)) +
      row("Checkpoint 상태", snap.safety.checkpointStatus, snap.safety.checkpointStatus === "CREATED" ? "GREEN" : "GRAY");
    return card("Live Operations", rows);
  }

  function renderUsage(snap) {
    var u = snap.usage;
    var rows =
      row("Claude Tokens", fmtNum(u.claudeTokens ? u.claudeTokens.totalTokens : undefined)) +
      row("GPT Tokens", fmtNum(u.gptTokens ? u.gptTokens.totalTokens : undefined)) +
      row("Total Known Tokens", fmtNum(u.totalKnownTokens));
    var actual = fmtUsd(u.actualCostUsd);
    var estimated = fmtUsd(u.estimatedCostUsd);
    if (actual !== null) rows += row("실제 비용", actual);
    if (estimated !== null) rows += row("예상 비용", estimated);
    return card("Usage", rows);
  }

  function renderSubscription(snap) {
    var s = snap.subscriptionUsage;
    var rows =
      row("5시간 사용률", s ? fmtPercent(s.fiveHourUsagePercent) : "데이터 없음") +
      row("7일 사용률", s ? fmtPercent(s.sevenDayUsagePercent) : "데이터 없음") +
      row("Context 사용량", s && typeof s.currentContextTokens === "number" ? fmtNum(s.currentContextTokens) : "데이터 없음") +
      row("Reset 시각", s && s.resetTime ? esc(s.resetTime) : "데이터 없음");
    return card("Claude Subscription", rows);
  }

  function renderQuality(snap) {
    var q = snap.quality;
    var fp = q.firstPassApproved === undefined ? "UNKNOWN" : q.firstPassApproved ? "예" : "아니오";
    var rows =
      row("First-pass Approval", fp, q.firstPassApproved === true ? "GREEN" : q.firstPassApproved === false ? "YELLOW" : "GRAY") +
      row("Revise Count", String(q.reviseCount)) +
      row("Test", snap.tests.status, snap.tests.status === "PASS" ? "GREEN" : snap.tests.status === "FAIL" ? "RED" : "GRAY") +
      row("Security Block", snap.safety.securityBlocked ? "예" : "아니오", snap.safety.securityBlocked ? "RED" : "GREEN") +
      row("Review Cycle Exhausted", q.reviewCycleExhausted ? "예" : "아니오", q.reviewCycleExhausted ? "YELLOW" : "GREEN");
    return card("Quality", rows);
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
    return card("Advisory Agents", rows);
  }

  function render(data) {
    var footer = document.getElementById("footer");
    if (data.status === "NO_RUN_YET") {
      document.getElementById("content").innerHTML = renderNoRun();
      footer.textContent = "마지막 갱신: " + new Date(data.generatedAt).toLocaleString("ko-KR");
      return;
    }
    var snap = data.snapshot;
    var tone = overallTone(snap);
    var html = "";
    html += renderAuditBanner(snap);
    html += '<div class="banner badge-' + tone + '"><span>AutoDev ' + esc(STATUS_LABEL_KO[snap.taskStatus] || snap.taskStatus) +
      '</span><span class="sub">' + esc(orDash(snap.taskId)) + "</span></div>";
    html += '<div class="grid">' +
      renderQuickGlance(snap) +
      renderOverview(snap) +
      renderLiveOperations(snap) +
      renderUsage(snap) +
      renderSubscription(snap) +
      renderQuality(snap) +
      renderAdvisory(snap) +
      "</div>";
    document.getElementById("content").innerHTML = html;
    footer.textContent = "마지막 갱신: " + new Date(data.generatedAt).toLocaleString("ko-KR") + " (" + (REFRESH_MS / 1000) + "초마다 자동 갱신, 읽기 전용)";
  }

  function tick() {
    fetch("/api/snapshot", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () {
        document.getElementById("content").innerHTML = '<div class="empty">데이터를 불러오지 못했습니다. Dashboard 서버 상태를 확인하세요.</div>';
      });
  }

  tick();
  setInterval(tick, REFRESH_MS);
})();
</script>
</body>
</html>
`;
