// Local Operations Dashboard — Read-only HTML/CSS/JS page (오토데브 대시보드 후속 개선).
//
// 별도 frontend framework(React/Next/Vite 등)를 쓰지 않는다 — 이 저장소에 프론트엔드
// 빌드 도구가 전혀 없고(package.json 참고), 로컬 읽기 전용 관제판에는 하나의 정적 HTML
// 문자열 + fetch 기반 polling으로 충분하다. 이 문자열은 dashboard-server.ts가 GET / 응답으로
// 그대로 서빙한다 — 별도 static asset 빌드 단계가 필요 없다(tsc 컴파일 결과물 하나로 완결).
//
// 이 페이지는 GET /api/snapshot 하나만 호출한다 — approve/reject/실행/git/파일수정 같은
// 어떤 쓰기 요청도 만들지 않는다(client JS 전체를 봐도 fetch 호출이 이 한 곳뿐이다). 이
// 원칙은 이번 개선에서도 그대로 유지한다(§ 요구사항 1) — 화면 표시(한글화/새 카드
// 추가)만 바뀌었을 뿐 어떤 승인/제어 버튼도 추가하지 않았다.
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
  #app { max-width: 1000px; margin: 0 auto; }
</style>
</head>
<body>
<div id="app">
  <h1>오토데브 대시보드 <span style="color:var(--muted); font-weight:400;">(읽기 전용 · localhost)</span></h1>
  <div id="content"><div class="empty">불러오는 중...</div></div>
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
  var TEST_STATUS_LABEL_KO = { PASS: "통과", FAIL: "실패", UNKNOWN: "확인 불가" };
  var REVIEW_DECISION_LABEL_KO = { PASS: "통과", REVISE: "수정 필요", HUMAN_REQUIRED: "사람 확인 필요", BLOCK: "차단됨" };
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

  function renderNoRun() {
    return '<div class="banner badge-GRAY"><span>오토데브 — 실행 이력 없음</span></div>' +
      '<div class="card"><div class="empty">아직 기록된 실행 이력이 없습니다. 오토데브를 한 번 이상 실행하면 여기에 표시됩니다.</div></div>';
  }

  function renderAuditBanner(snap) {
    if (snap.integrity !== "DEGRADED") return "";
    return '<div class="audit-degraded">감사 기록 손상(AUDIT DEGRADED)<div class="note">' +
      esc(snap.integrityNote || "일부 기록이 누락되었거나 손상되었을 수 있습니다.") + "</div></div>";
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
      { k: "오토데브 상태", v: STATUS_LABEL_KO[snap.taskStatus] || snap.taskStatus, tone: STATUS_TONE[snap.taskStatus] || "GRAY" },
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

  function renderProjectProgress(data) {
    var p = data.projectProgress;
    if (!p) {
      return card("프로젝트 진행 상황", '<div class="empty">프로젝트 자료 없음(AUTODEV_PROJECT_ADAPTER 미설정)</div>');
    }
    var rows =
      row("프로젝트 이름", orDash(p.projectName)) +
      row("전체 단계 수", fmtNum(p.totalPhases)) +
      row("전체 작업 수", fmtNum(p.totalTasks)) +
      row("완료 작업 수", fmtNum(p.completedTaskCount)) +
      row("현재 작업", p.currentTaskId ? esc(p.currentTaskId) + (p.currentTaskTitle ? " · " + esc(p.currentTaskTitle) : "") : "없음(전체 완료)") +
      row("다음 작업", p.nextTaskId ? esc(p.nextTaskId) + (p.nextTaskTitle ? " · " + esc(p.nextTaskTitle) : "") : "없음");
    var bars =
      progressBar(p.overallProgressPercent, "전체 진행률") +
      (typeof p.currentPhaseProgressPercent === "number" ? progressBar(p.currentPhaseProgressPercent, "현재 단계 진행률") : "");
    return card("프로젝트 진행 상황", rows + bars);
  }

  function renderCurrentStatus(snap) {
    var agent = snap.currentOperation.activeAgentRole
      ? snap.currentOperation.activeAgentRole + " (" + orDash(snap.currentOperation.activeAgentId) + ")"
      : "없음";
    var rows =
      row("오토데브 상태", esc(STATUS_LABEL_KO[snap.runStatus] || snap.runStatus), STATUS_TONE[snap.runStatus]) +
      row("프로젝트", orDash(snap.projectId)) +
      row("실행", orDash(snap.runId ? snap.runId.slice(0, 8) : undefined)) +
      row("현재 작업", orDash(snap.taskId)) +
      row("현재 수행 중", orDash(snap.currentOperation.currentAction)) +
      row("현재 개발/검토 담당", esc(agent)) +
      row("대기시간(참고)", fmtDuration(snap.currentOperation.elapsedMs)) +
      row("감사 기록 상태", snap.integrity === "CLEAN" ? "정상" : "손상", snap.integrity === "CLEAN" ? "GREEN" : "RED");
    return card("현재 작업 상태", rows);
  }

  function renderActualWorkTime(data) {
    var w = data.actualWorkTime || {};
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

  function renderUsage(data) {
    var u = data.usageOverview;
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

  function renderServiceUsage(data) {
    var u = data.usageOverview;
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

  function renderRecentCalls(data) {
    var calls = data.recentCalls || [];
    if (calls.length === 0) {
      return card("최근 외부 인공지능 호출 기록", '<div class="empty">아직 호출 기록이 없습니다.</div>');
    }
    var html = '<div class="tablewrap"><table class="calls"><thead><tr>' +
      "<th>시각</th><th>프로젝트</th><th>작업</th><th>목적</th><th>서비스</th><th>모델</th><th>전체 토큰</th><th>성공</th>" +
      "</tr></thead><tbody>";
    calls.forEach(function (c) {
      var successLabel = c.success ? "예" : "아니오";
      var successTone = c.success ? "GREEN" : "RED";
      html += "<tr><td>" + esc(fmtDateTime(c.timestamp)) + "</td><td>" + orDash(c.projectId) + "</td><td>" + orDash(c.taskId) +
        "</td><td>" + esc(c.purpose) + "</td><td>" + esc(c.service) + "</td><td>" + orDash(c.model) + "</td><td>" +
        fmtNum(c.totalTokens) + '</td><td class="value ' + successTone + '">' + successLabel + "</td></tr>";
    });
    html += "</tbody></table></div>";
    return card("최근 외부 인공지능 호출 기록", html, true);
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

  function renderSubscription(snap) {
    var s = snap.subscriptionUsage;
    var rows =
      row("5시간 사용률", s && typeof s.fiveHourUsagePercent === "number" ? fmtPercent(s.fiveHourUsagePercent) : NOT_AVAILABLE) +
      row("7일 사용률", s && typeof s.sevenDayUsagePercent === "number" ? fmtPercent(s.sevenDayUsagePercent) : NOT_AVAILABLE) +
      row("Context 사용량", s && typeof s.currentContextTokens === "number" ? fmtNum(s.currentContextTokens) : NOT_AVAILABLE) +
      row("초기화 시각", s && s.resetTime ? esc(fmtDateTime(s.resetTime)) : NOT_AVAILABLE);
    return card("Claude 구독 사용량", rows);
  }

  function renderQuality(data) {
    var snap = data.snapshot;
    var q = snap.quality;
    var hist = snap.historical;
    var fp = q.firstPassApproved === undefined ? NOT_AVAILABLE : q.firstPassApproved ? "예" : "아니오";
    var ps = data.problemSolving;
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
    rows += row("자동 복구 횟수", NOT_AVAILABLE);
    return card("개발 품질", rows);
  }

  function renderProblemSolving(data) {
    var ps = data.problemSolving;
    if (!ps || !ps.currentProblem) {
      return card("현재 문제 해결 상황", '<div class="empty">현재 진행 중인 문제 없음</div>');
    }
    var cp = ps.currentProblem;
    var rows =
      row("문제 유형", ERROR_TYPE_LABEL_KO[cp.errorType] || cp.errorType) +
      row("실패한 검사", orDash(cp.failedCheck)) +
      row("같은 오류 반복 횟수", String(cp.repeatedFailureCount)) +
      row("과거 유사 사례 수", String(ps.similarPastCasesCount)) +
      row("과거 해결책 재사용 여부", ps.similarPastCasesCount > 0 ? "재사용 가능한 사례 있음" : "없음") +
      row("자동 복구 상태", NOT_AVAILABLE) +
      row("해결 상태", cp.resolved ? "해결됨" : "진행 중", cp.resolved ? "GREEN" : "YELLOW") +
      row("마지막 관측 시각", esc(fmtDateTime(cp.lastSeenAt)));
    return card("현재 문제 해결 상황", rows);
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

  function render(data) {
    var footer = document.getElementById("footer");
    if (data.status === "NO_RUN_YET") {
      document.getElementById("content").innerHTML = renderNoRun();
      footer.textContent = "마지막 갱신: " + fmtDateTime(data.generatedAt);
      return;
    }
    var snap = data.snapshot;
    var tone = overallTone(snap);
    var html = "";
    html += renderAuditBanner(snap);
    html += '<div class="banner badge-' + tone + '"><span>오토데브 ' + esc(STATUS_LABEL_KO[snap.taskStatus] || snap.taskStatus) +
      '</span><span class="sub">' + esc(orDash(snap.taskId)) + "</span></div>";
    html += '<div class="grid">' +
      renderQuickGlance(snap) +
      renderProjectProgress(data) +
      renderCurrentStatus(snap) +
      renderActualWorkTime(data) +
      renderLiveOperations(snap) +
      renderUsage(data) +
      renderServiceUsage(data) +
      renderRecentCalls(data) +
      renderCost(snap) +
      renderSubscription(snap) +
      renderQuality(data) +
      renderProblemSolving(data) +
      renderAdvisory(snap) +
      "</div>";
    document.getElementById("content").innerHTML = html;
    footer.textContent = "마지막 갱신: " + fmtDateTime(data.generatedAt) + " (" + (REFRESH_MS / 1000) + "초마다 자동 갱신, 읽기 전용)";
  }

  function tick() {
    fetch("/api/snapshot", { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(render)
      .catch(function () {
        document.getElementById("content").innerHTML = '<div class="empty">데이터를 불러오지 못했습니다. 대시보드 서버 상태를 확인하세요.</div>';
      });
  }

  tick();
  setInterval(tick, REFRESH_MS);
})();
</script>
</body>
</html>
`;
