import { mkdtempSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileEventStore } from "./event-store";
import type { AutoDevEventInput } from "./observability-event";
import { startDashboardServer } from "./dashboard-server";
import type { DashboardServerHandle } from "./dashboard-server";
import { resetDashboardSnapshotCacheForTests } from "./dashboard-snapshot-provider";
import type { DashboardSnapshot } from "./dashboard-snapshot-provider";

// Local Operations Dashboard — HTTP server 테스트(Phase G Task G4.1). 실제 Claude/GPT 유료
// API를 호출하지 않는다 — event fixture는 파일 기반 EventStore에 직접 append해 만들고,
// dashboard server는 그 fixture 파일만 가리키도록 eventsFilePath로 override한다(§
// dashboard-server.ts). 이 파일은 순수 GET 요청(fetch)만 보낸다 — 이 저장소의 어떤 test도
// 실제 production event 파일을 건드리지 않는다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
const openHandles: DashboardServerHandle[] = [];

function makeEventFilePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-dashboard-server-"));
  tempDirs.push(dir);
  return join(dir, "events.jsonl");
}

function ev(overrides: Partial<AutoDevEventInput> & { eventType: AutoDevEventInput["eventType"]; runId: string }): AutoDevEventInput {
  return overrides;
}

function buildFixtureFile(inputs: AutoDevEventInput[]): string {
  const filePath = makeEventFilePath();
  const store = createFileEventStore(filePath);
  for (const i of inputs) store.append(i);
  return filePath;
}

async function startServerFor(filePath: string | undefined): Promise<DashboardServerHandle> {
  resetDashboardSnapshotCacheForTests();
  const handle = await startDashboardServer({ port: 0, eventsFilePath: filePath });
  openHandles.push(handle);
  return handle;
}

async function scenarioStartStop(): Promise<void> {
  const handle = await startServerFor(undefined);
  check("start/stop: listening 후 url 존재", handle.url.startsWith("http://127.0.0.1:"));
  await handle.close();
  check("start/stop: close 이후 재요청이 실패함(서버가 실제로 내려감)", await isUnreachable(handle.url));
}

async function getSnapshotJson(url: string): Promise<DashboardSnapshot> {
  const res = await fetch(url);
  return (await res.json()) as DashboardSnapshot;
}

async function isUnreachable(url: string): Promise<boolean> {
  try {
    await fetch(`${url}/`, { signal: AbortSignal.timeout(500) });
    return false;
  } catch {
    return true;
  }
}

async function scenarioLocalhostBind(): Promise<void> {
  const handle = await startServerFor(undefined);
  check("localhost bind: host=127.0.0.1", handle.host === "127.0.0.1");
  check("localhost bind: url이 127.0.0.1을 가리킴", handle.url === `http://127.0.0.1:${handle.port}`);
  await handle.close();
}

async function scenarioSnapshotApiOk(): Promise<void> {
  const filePath = buildFixtureFile([ev({ eventType: "RUN_STARTED", runId: "run-ok" }), ev({ eventType: "TASK_STARTED", runId: "run-ok", taskId: "T1" })]);
  const handle = await startServerFor(filePath);
  const res = await fetch(`${handle.url}/api/snapshot`);
  const body = (await res.json()) as { status: string; snapshot?: { runId?: string } };
  check("snapshot API: HTTP 200", res.status === 200);
  check("snapshot API: content-type이 JSON", (res.headers.get("content-type") ?? "").includes("application/json"));
  check("snapshot API: status=OK", body.status === "OK");
  check("snapshot API: runId=run-ok", body.snapshot?.runId === "run-ok");
  await handle.close();
}

async function scenarioIdleRendersInApi(): Promise<void> {
  const filePath = buildFixtureFile([
    ev({ eventType: "RUN_STARTED", runId: "run-idle" }),
    ev({ eventType: "RUN_COMPLETED", runId: "run-idle", outcome: "SKIPPED", reason: "실행할 task 없음" }),
  ]);
  const handle = await startServerFor(filePath);
  const body = await getSnapshotJson(`${handle.url}/api/snapshot`);
  check("IDLE: taskStatus=IDLE", body.snapshot?.taskStatus === "IDLE");
  await handle.close();
}

async function scenarioRunningRendersInApi(): Promise<void> {
  const filePath = buildFixtureFile([ev({ eventType: "RUN_STARTED", runId: "run-running" }), ev({ eventType: "TASK_STARTED", runId: "run-running", taskId: "T1" })]);
  const handle = await startServerFor(filePath);
  const body = await getSnapshotJson(`${handle.url}/api/snapshot`);
  check("RUNNING: taskStatus=RUNNING", body.snapshot?.taskStatus === "RUNNING");
  await handle.close();
}

async function scenarioTestPassFail(): Promise<void> {
  const passFile = buildFixtureFile([
    ev({ eventType: "RUN_STARTED", runId: "run-pass" }),
    ev({ eventType: "TASK_STARTED", runId: "run-pass", taskId: "T1" }),
    ev({ eventType: "TEST_COMPLETED", runId: "run-pass", taskId: "T1", outcome: "SUCCESS", testSummary: { total: 3, passed: 3, failed: 0 } }),
  ]);
  const passHandle = await startServerFor(passFile);
  const passBody = await getSnapshotJson(`${passHandle.url}/api/snapshot`);
  check("TEST PASS: tests.status=PASS", passBody.snapshot?.tests.status === "PASS");
  await passHandle.close();

  const failFile = buildFixtureFile([
    ev({ eventType: "RUN_STARTED", runId: "run-fail" }),
    ev({ eventType: "TASK_STARTED", runId: "run-fail", taskId: "T1" }),
    ev({ eventType: "TEST_COMPLETED", runId: "run-fail", taskId: "T1", outcome: "FAILED", testSummary: { total: 3, passed: 2, failed: 1, failedNames: ["t3"] } }),
  ]);
  const failHandle = await startServerFor(failFile);
  const failBody = await getSnapshotJson(`${failHandle.url}/api/snapshot`);
  check("TEST FAIL: tests.status=FAIL", failBody.snapshot?.tests.status === "FAIL");
  await failHandle.close();
}

async function scenarioReviewingAndRevise(): Promise<void> {
  const reviewingFile = buildFixtureFile([
    ev({ eventType: "RUN_STARTED", runId: "run-reviewing" }),
    ev({ eventType: "TASK_STARTED", runId: "run-reviewing", taskId: "T1" }),
    ev({ eventType: "REVIEW_STARTED", runId: "run-reviewing", taskId: "T1" }),
  ]);
  const reviewingHandle = await startServerFor(reviewingFile);
  const reviewingBody = await getSnapshotJson(`${reviewingHandle.url}/api/snapshot`);
  check("REVIEWING: taskStatus=REVIEWING", reviewingBody.snapshot?.taskStatus === "REVIEWING");
  await reviewingHandle.close();

  const reviseFile = buildFixtureFile([
    ev({ eventType: "RUN_STARTED", runId: "run-revise" }),
    ev({ eventType: "TASK_STARTED", runId: "run-revise", taskId: "T1" }),
    ev({ eventType: "REVIEW_STARTED", runId: "run-revise", taskId: "T1" }),
    ev({ eventType: "REVIEW_REVISE", runId: "run-revise", taskId: "T1", reviewDecision: "REVISE", reviseCycle: 1 }),
  ]);
  const reviseHandle = await startServerFor(reviseFile);
  const reviseBody = await getSnapshotJson(`${reviseHandle.url}/api/snapshot`);
  check("REVISE: taskStatus=REVISING", reviseBody.snapshot?.taskStatus === "REVISING");
  check("REVISE: quality.reviseCount=1", reviseBody.snapshot?.quality.reviseCount === 1);
  await reviseHandle.close();
}

async function scenarioWaitingHuman(): Promise<void> {
  const filePath = buildFixtureFile([
    ev({ eventType: "RUN_STARTED", runId: "run-wait" }),
    ev({ eventType: "TASK_STARTED", runId: "run-wait", taskId: "T1" }),
    ev({ eventType: "HUMAN_APPROVAL_REQUIRED", runId: "run-wait", taskId: "T1" }),
  ]);
  const handle = await startServerFor(filePath);
  const body = await getSnapshotJson(`${handle.url}/api/snapshot`);
  check("WAITING_HUMAN: taskStatus=WAITING_HUMAN", body.snapshot?.taskStatus === "WAITING_HUMAN");
  check("WAITING_HUMAN: safety.humanApprovalRequired=true", body.snapshot?.safety.humanApprovalRequired === true);
  await handle.close();
}

async function scenarioSecurityBlocked(): Promise<void> {
  const filePath = buildFixtureFile([
    ev({ eventType: "RUN_STARTED", runId: "run-secblock" }),
    ev({ eventType: "TASK_STARTED", runId: "run-secblock", taskId: "T1" }),
    ev({ eventType: "SECURITY_BLOCKED", runId: "run-secblock", taskId: "T1", outcome: "BLOCKED" }),
  ]);
  const handle = await startServerFor(filePath);
  const body = await getSnapshotJson(`${handle.url}/api/snapshot`);
  check("SECURITY_BLOCKED: taskStatus=BLOCKED", body.snapshot?.taskStatus === "BLOCKED");
  check("SECURITY_BLOCKED: safety.securityBlocked=true", body.snapshot?.safety.securityBlocked === true);
  await handle.close();
}

async function scenarioCompleted(): Promise<void> {
  const filePath = buildFixtureFile([
    ev({ eventType: "RUN_STARTED", runId: "run-done" }),
    ev({ eventType: "TASK_STARTED", runId: "run-done", taskId: "T1" }),
    ev({ eventType: "TASK_COMPLETED", runId: "run-done", taskId: "T1", outcome: "SUCCESS" }),
    ev({ eventType: "RUN_COMPLETED", runId: "run-done", taskId: "T1", outcome: "SUCCESS" }),
  ]);
  const handle = await startServerFor(filePath);
  const body = await getSnapshotJson(`${handle.url}/api/snapshot`);
  check("COMPLETED: taskStatus=COMPLETED", body.snapshot?.taskStatus === "COMPLETED");
  check("COMPLETED: runStatus=COMPLETED", body.snapshot?.runStatus === "COMPLETED");
  await handle.close();
}

async function scenarioZeroAgentsAndAdvisoryDisplay(): Promise<void> {
  const zeroFile = buildFixtureFile([ev({ eventType: "RUN_STARTED", runId: "run-zeroagent" }), ev({ eventType: "TASK_STARTED", runId: "run-zeroagent", taskId: "T1" })]);
  const zeroHandle = await startServerFor(zeroFile);
  const zeroBody = await getSnapshotJson(`${zeroHandle.url}/api/snapshot`);
  check("Agent 0회: advisory.selected 빈 배열", zeroBody.snapshot?.advisory.selected.length === 0);
  await zeroHandle.close();

  const advisoryFile = buildFixtureFile([
    ev({ eventType: "RUN_STARTED", runId: "run-advisory" }),
    ev({ eventType: "TASK_STARTED", runId: "run-advisory", taskId: "T1" }),
    ev({ eventType: "AGENT_SELECTED", runId: "run-advisory", taskId: "T1", agentId: "planner-1", agentRole: "planner" }),
    ev({ eventType: "AGENT_STARTED", runId: "run-advisory", taskId: "T1", agentId: "planner-1", agentRole: "planner", outcome: "PENDING" }),
    ev({ eventType: "AGENT_COMPLETED", runId: "run-advisory", taskId: "T1", agentId: "planner-1", agentRole: "planner", outcome: "SUCCESS" }),
    ev({ eventType: "AGENT_SELECTED", runId: "run-advisory", taskId: "T1", agentId: "security-1", agentRole: "security" }),
    ev({ eventType: "AGENT_STARTED", runId: "run-advisory", taskId: "T1", agentId: "security-1", agentRole: "security", outcome: "PENDING" }),
    ev({ eventType: "AGENT_FAILED", runId: "run-advisory", taskId: "T1", agentId: "security-1", agentRole: "security", outcome: "FAILED" }),
  ]);
  const advisoryHandle = await startServerFor(advisoryFile);
  const advisoryBody = await getSnapshotJson(`${advisoryHandle.url}/api/snapshot`);
  const selected: { agentId: string; role?: string }[] = advisoryBody.snapshot?.advisory.selected ?? [];
  check("Advisory 표시: planner 선택됨", selected.some((s) => s.role === "planner"));
  check("Advisory 표시: security 선택됨", selected.some((s) => s.role === "security"));
  check("Advisory 표시: planner 완료", (advisoryBody.snapshot?.advisory.completedAgentIds ?? []).includes("planner-1"));
  check("Advisory 표시: security 실패", (advisoryBody.snapshot?.advisory.failedAgentIds ?? []).includes("security-1"));
  await advisoryHandle.close();
}

async function scenarioTokensAndUnknownSubscription(): Promise<void> {
  const filePath = buildFixtureFile([
    ev({ eventType: "RUN_STARTED", runId: "run-tokens" }),
    ev({ eventType: "TASK_STARTED", runId: "run-tokens", taskId: "T1" }),
    ev({ eventType: "TEST_COMPLETED", runId: "run-tokens", taskId: "T1", outcome: "SUCCESS", model: { provider: "anthropic", name: "claude" }, tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, testSummary: { total: 1, passed: 1, failed: 0 } }),
    ev({ eventType: "REVIEW_APPROVED", runId: "run-tokens", taskId: "T1", reviewDecision: "PASS", model: { provider: "openai", name: "gpt" }, tokenUsage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 } }),
  ]);
  const handle = await startServerFor(filePath);
  const body = await getSnapshotJson(`${handle.url}/api/snapshot`);
  check("Claude tokens=150", body.snapshot?.usage.claudeTokens?.totalTokens === 150);
  check("GPT tokens=50", body.snapshot?.usage.gptTokens?.totalTokens === 50);
  check("Total known tokens=200", body.snapshot?.usage.totalKnownTokens === 200);
  check("구독 usage source 없음: subscriptionUsage=undefined(추정값 없음)", body.snapshot?.subscriptionUsage === undefined);
  await handle.close();
}

async function scenarioDegradedIntegrityWarning(): Promise<void> {
  const filePath = buildFixtureFile([ev({ eventType: "RUN_STARTED", runId: "run-degraded" }), ev({ eventType: "TASK_STARTED", runId: "run-degraded", taskId: "T1" })]);
  appendFileSync(filePath, "{not valid json\n", "utf-8");
  const handle = await startServerFor(filePath);
  const body = await getSnapshotJson(`${handle.url}/api/snapshot`);
  check("DEGRADED 경고: integrity=DEGRADED", body.snapshot?.integrity === "DEGRADED");
  check("DEGRADED 경고: integrityNote 존재", typeof body.snapshot?.integrityNote === "string" && body.snapshot.integrityNote.length > 0);
  await handle.close();
}

async function scenarioNoSecretExposure(): Promise<void> {
  const filePath = buildFixtureFile([
    ev({ eventType: "RUN_STARTED", runId: "run-secret" }),
    ev({ eventType: "TASK_STARTED", runId: "run-secret", taskId: "T1", reason: "OPENAI_API_KEY=sk-should-not-leak" }),
  ]);
  const handle = await startServerFor(filePath);
  const [snapshotText, htmlText] = await Promise.all([
    (await fetch(`${handle.url}/api/snapshot`)).text(),
    (await fetch(`${handle.url}/`)).text(),
  ]);
  check("secret 비노출: /api/snapshot에 원문 reason이 없음", !snapshotText.includes("sk-should-not-leak"));
  check("secret 비노출: HTML에 원문 reason이 없음", !htmlText.includes("sk-should-not-leak"));
  check("HTML: fetch 호출은 /api/snapshot 하나뿐(다른 쓰기 API 호출 없음)", (htmlText.match(/fetch\(/g) ?? []).length === 1);
  await handle.close();
}

async function scenarioNoWriteEndpoints(): Promise<void> {
  const handle = await startServerFor(undefined);
  const postSnapshot = await fetch(`${handle.url}/api/snapshot`, { method: "POST" });
  check("write endpoint 없음: POST /api/snapshot -> 405", postSnapshot.status === 405);

  const deleteRoot = await fetch(`${handle.url}/`, { method: "DELETE" });
  check("write endpoint 없음: DELETE / -> 405", deleteRoot.status === 405);

  const approve = await fetch(`${handle.url}/api/approve`, { method: "GET" });
  check("write endpoint 없음: /api/approve 자체가 없음(GET도 404)", approve.status === 404);

  const runCommand = await fetch(`${handle.url}/api/run`, { method: "GET" });
  check("write endpoint 없음: /api/run GET도 없음(404, 실행 경로 자체가 없음)", runCommand.status === 404);
  await handle.close();
}

async function main(): Promise<void> {
  try {
    await scenarioStartStop();
    await scenarioLocalhostBind();
    await scenarioSnapshotApiOk();
    await scenarioIdleRendersInApi();
    await scenarioRunningRendersInApi();
    await scenarioTestPassFail();
    await scenarioReviewingAndRevise();
    await scenarioWaitingHuman();
    await scenarioSecurityBlocked();
    await scenarioCompleted();
    await scenarioZeroAgentsAndAdvisoryDisplay();
    await scenarioTokensAndUnknownSubscription();
    await scenarioDegradedIntegrityWarning();
    await scenarioNoSecretExposure();
    await scenarioNoWriteEndpoints();
  } finally {
    resetDashboardSnapshotCacheForTests();
    for (const h of openHandles) {
      try {
        await h.close();
      } catch {
        // 이미 닫혔으면 무시(scenarioStartStop이 의도적으로 두 번 닫는다).
      }
    }
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // 정리 실패는 테스트 결과에 영향 없음(OS 임시 디렉터리).
      }
    }
  }

  console.log("\n=== dashboard-server(G4.1) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
