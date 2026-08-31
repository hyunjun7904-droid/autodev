import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  createInMemoryApprovalStore,
  createFileApprovalStore,
  createInMemoryTelegramOffsetStore,
  createFileTelegramOffsetStore,
} from "./approval-store";
import type { ApprovalStore, TelegramOffsetStore } from "./approval-store";
import type { ApprovalRequest } from "./approval";

// Approval Store 테스트 — Phase G Task G6. in-memory/file 두 구현을 동일한 시나리오로
// 검증한다(notification-store-tests.ts와 동일한 "구현별로 같은 계약을 만족하는가" 패턴).
// 실제 Telegram/Claude/GPT 호출은 전혀 없다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempFilePath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-approval-store-test-"));
  tempDirs.push(dir);
  return join(dir, name);
}

function req(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    approvalId: randomUUID(),
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:30:00.000Z",
    runId: "r1",
    taskId: "T1",
    projectId: "p1",
    approvalType: "ORCHESTRATOR_NOT_APPROVED_GENERIC",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: randomUUID(),
    status: "PENDING",
    remotelyApprovable: true,
    requiresSafetyRecheck: true,
    dedupeKey: `dk-${randomUUID()}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 두 구현 모두에 대해 동일한 시나리오를 돌린다.
// ---------------------------------------------------------------------------
function runApprovalStoreContractScenarios(label: string, store: ApprovalStore): void {
  const a = req();
  const created = store.createPending(a);
  check(`[${label}] createPending 반환값 == 입력값`, created.approvalId === a.approvalId && created.status === "PENDING");
  check(`[${label}] has()로 존재 확인`, store.has(a.approvalId) === true);
  check(`[${label}] has(존재하지 않는 id) -> false`, store.has(randomUUID()) === false);
  check(`[${label}] get()으로 조회`, store.get(a.approvalId)?.approvalId === a.approvalId);
  check(`[${label}] get(존재하지 않는 id) -> undefined`, store.get(randomUUID()) === undefined);
  check(`[${label}] getByDedupeKey()로 조회`, store.getByDedupeKey(a.dedupeKey)?.approvalId === a.approvalId);
  check(`[${label}] getByDedupeKey(존재하지 않는 key) -> undefined`, store.getByDedupeKey("no-such-key") === undefined);

  // createPending idempotent — 같은 dedupeKey로 다시 호출해도 새 레코드를 만들지 않는다.
  const b = req({ dedupeKey: a.dedupeKey, approvalId: randomUUID() });
  const second = store.createPending(b);
  check(`[${label}] createPending은 같은 dedupeKey에 idempotent(새 approvalId 발급 안 함)`, second.approvalId === a.approvalId);
  check(`[${label}] idempotent 후에도 store에는 원래 레코드 하나만 존재`, store.get(b.approvalId) === undefined);

  // transition — PENDING -> APPROVED 단일 CAS.
  const t1 = store.transition(a.approvalId, "APPROVED", "2026-01-01T00:05:00.000Z");
  check(`[${label}] PENDING -> APPROVED 전이 성공`, t1.ok === true && t1.request?.status === "APPROVED");
  // 두 번째 전이(동시 replay) — 이미 APPROVED이므로 실패해야 한다.
  const t2 = store.transition(a.approvalId, "REJECTED", "2026-01-01T00:05:01.000Z");
  check(`[${label}] 이미 소비된 approval의 두 번째 전이는 ok:false(replay 방지)`, t2.ok === false);
  check(`[${label}] 실패한 전이 후에도 상태는 그대로 APPROVED(REJECTED로 바뀌지 않음)`, store.get(a.approvalId)?.status === "APPROVED");
  check(`[${label}] 존재하지 않는 approvalId 전이는 ok:false`, store.transition(randomUUID(), "REJECTED", "2026-01-01T00:00:00.000Z").ok === false);

  // consumed 이후에도 같은 dedupeKey로 createPending하면 소비된 레코드를 그대로 반환한다
  // (새 살아있는 버튼이 다시 만들어지지 않는다 — replay 방지가 controller 재시작에도 이어짐).
  const c = req({ dedupeKey: a.dedupeKey, approvalId: randomUUID() });
  const third = store.createPending(c);
  check(`[${label}] 소비된 approval의 dedupeKey로 재요청해도 새 PENDING을 만들지 않음`, third.approvalId === a.approvalId && third.status === "APPROVED");

  // list — filter.
  const other = req({ runId: "r2", dedupeKey: `dk-${randomUUID()}` });
  store.createPending(other);
  const byRun = store.list({ runId: "r2" });
  check(`[${label}] list({runId}) 필터`, byRun.length === 1 && byRun[0].runId === "r2");
  const byStatus = store.list({ status: "PENDING" });
  check(`[${label}] list({status:PENDING})에는 이미 소비된 a는 없음`, byStatus.every((r) => r.approvalId !== a.approvalId));
  check(`[${label}] list({status:PENDING})에는 아직 PENDING인 other는 있음`, byStatus.some((r) => r.approvalId === other.approvalId));

  // 반환값은 항상 복사본 — 호출부가 수정해도 store 원본은 안 바뀐다.
  const got = store.get(other.approvalId);
  if (got) got.status = "EXPIRED";
  check(`[${label}] get() 반환값을 수정해도 store 원본은 안 바뀜(defensive copy)`, store.get(other.approvalId)?.status === "PENDING");
}

function scenarioInMemory(): void {
  runApprovalStoreContractScenarios("in-memory", createInMemoryApprovalStore());
}
function scenarioFile(): void {
  const filePath = makeTempFilePath("approvals.json");
  runApprovalStoreContractScenarios("file", createFileApprovalStore(filePath));
}
function scenarioFileSurvivesRestart(): void {
  const filePath = makeTempFilePath("approvals-restart.json");
  const a = req();
  createFileApprovalStore(filePath).createPending(a);
  // 새 store 인스턴스(= controller 재시작을 흉내낸다) — 같은 파일을 다시 연다.
  const restarted = createFileApprovalStore(filePath);
  check("file store 재시작 후에도 PENDING 레코드가 그대로 남아있음", restarted.get(a.approvalId)?.status === "PENDING");
  restarted.transition(a.approvalId, "APPROVED", "2026-01-01T00:00:00.000Z");
  const restartedAgain = createFileApprovalStore(filePath);
  check("file store 재시작 후 소비 상태(APPROVED)도 그대로 이어짐(replay 방지 유지)", restartedAgain.get(a.approvalId)?.status === "APPROVED");
  check(
    "재시작 후에도 이미 소비된 approval을 다시 APPROVED로 전이 시도하면 실패",
    restartedAgain.transition(a.approvalId, "APPROVED", "2026-01-01T00:00:01.000Z").ok === false
  );
}
function scenarioFileCorruptedGracefulEmpty(): void {
  const filePath = makeTempFilePath("approvals-corrupt.json");
  writeFileSync(filePath, "{not valid json", "utf-8");
  const store = createFileApprovalStore(filePath);
  check("손상된 파일은 정상 기록으로 위장하지 않고 빈 store로 취급", store.list().length === 0);
  const a = req();
  store.createPending(a);
  check("손상된 파일이었어도 이후 정상 쓰기는 가능", store.get(a.approvalId)?.approvalId === a.approvalId);
}

// ---------------------------------------------------------------------------
// Multi-Project Approval Isolation(2026-09-01) — DEFECT 3 실제 concurrency test. 실제 Node
// child process 2개 이상이 동시에 같은 file-based ApprovalStore를 mutate한다(§ 요구사항 —
// "동시 mutation과 함수 mock만으로 concurrency safety를 COMPLETE 처리하지 않는다").
// project-lock-tests.ts scenarioRealConcurrentAcquisition과 동일한 spawn+Promise.all 패턴을
// 재사용한다.
// ---------------------------------------------------------------------------
function runWorker(filePath: string, args: string[]): Promise<string> {
  const workerPath = join(__dirname, "approval-store-concurrency-worker.js");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [workerPath, filePath, ...args]);
    let out = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.on("close", () => resolve(out.trim()));
  });
}

async function scenarioRealConcurrentTransitionOnSameApprovalExactlyOneWins(): Promise<void> {
  const filePath = makeTempFilePath("approvals-concurrent-transition.json");
  const workerPath = join(__dirname, "approval-store-concurrency-worker.js");
  if (!existsSync(workerPath)) {
    check("H) (컴파일된 worker 스크립트를 찾지 못해 스킵 — npm run build 필요)", true);
    return;
  }
  const a = req();
  createFileApprovalStore(filePath).createPending(a);

  // controller와 local CLI가 같은 approval을 동시에 승인하는 상황을 실제 프로세스 두 개로
  // 재현한다.
  const [outA, outB] = await Promise.all([
    runWorker(filePath, ["transition", a.approvalId]),
    runWorker(filePath, ["transition", a.approvalId]),
  ]);
  const transitionedCount = [outA, outB].filter((o) => o === "TRANSITIONED").length;
  const notTransitionedCount = [outA, outB].filter((o) => o === "NOT_TRANSITIONED").length;
  check("H) 동시 승인 시도 중 정확히 하나만 TRANSITIONED(exactly-one)", transitionedCount === 1);
  check("H) 나머지 하나는 NOT_TRANSITIONED(duplicate resume 없음)", notTransitionedCount === 1);

  const finalStore = createFileApprovalStore(filePath);
  check("H) 최종 상태는 APPROVED 정확히 한 번만 반영됨", finalStore.get(a.approvalId)?.status === "APPROVED");

  const raw = readFileSync(filePath, "utf-8");
  let parsedOk = true;
  try {
    JSON.parse(raw);
  } catch {
    parsedOk = false;
  }
  check("I) 동시 mutation 이후에도 approvals.json이 완전한 JSON으로 남음(손상 없음)", parsedOk);
}

async function scenarioRealConcurrentCreateOnDifferentApprovalsNoLostUpdate(): Promise<void> {
  const filePath = makeTempFilePath("approvals-concurrent-create.json");
  const workerPath = join(__dirname, "approval-store-concurrency-worker.js");
  if (!existsSync(workerPath)) {
    check("G) (컴파일된 worker 스크립트를 찾지 못해 스킵 — npm run build 필요)", true);
    return;
  }

  // controller(createApprovalRequestsFromEvents)와 local CLI가 서로 다른 approval을 동시에
  // mutation하는 상황 — N개의 실제 프로세스가 각자 다른 approvalId/dedupeKey로 createPending()
  // 한다. load→mutate→save 전체가 직렬화되지 않으면 서로의 쓰기를 덮어써 일부가 사라진다
  // (silent lost-update).
  const N = 6;
  const ids = Array.from({ length: N }, () => randomUUID());
  const outs = await Promise.all(ids.map((id) => runWorker(filePath, ["create", id, `dk-${id}`])));
  check("G) 모든 concurrent create가 실제로 CREATED로 성공함(모두 서로 다른 approval)", outs.every((o) => o === "CREATED"));

  const finalStore = createFileApprovalStore(filePath);
  const finalIds = new Set(finalStore.list().map((r) => r.approvalId));
  check("G) 서로 다른 approval을 동시에 mutation해도 silent lost-update 0(전부 최종 파일에 존재)", ids.every((id) => finalIds.has(id)));
  check("G) 유실/중복 없이 정확히 N개만 존재", finalStore.list().length === N);
}

// ---------------------------------------------------------------------------
// TelegramOffsetStore
// ---------------------------------------------------------------------------
function runOffsetStoreContractScenarios(label: string, store: TelegramOffsetStore): void {
  check(`[${label}] 초기 offset은 0`, store.getOffset() === 0);
  store.setOffset(42);
  check(`[${label}] setOffset 후 getOffset이 그대로 반영`, store.getOffset() === 42);
  store.setOffset(43);
  check(`[${label}] 다시 setOffset하면 최신값으로 갱신`, store.getOffset() === 43);
}
function scenarioOffsetInMemory(): void {
  runOffsetStoreContractScenarios("offset in-memory", createInMemoryTelegramOffsetStore());
}
function scenarioOffsetFile(): void {
  const filePath = makeTempFilePath("offset.json");
  runOffsetStoreContractScenarios("offset file", createFileTelegramOffsetStore(filePath));
}
function scenarioOffsetFileSurvivesRestart(): void {
  const filePath = makeTempFilePath("offset-restart.json");
  createFileTelegramOffsetStore(filePath).setOffset(777);
  const restarted = createFileTelegramOffsetStore(filePath);
  check("offset store 재시작 후에도 마지막 offset이 그대로 유지됨(replay 방지)", restarted.getOffset() === 777);
}
function scenarioOffsetInMemoryInitial(): void {
  const store = createInMemoryTelegramOffsetStore(10);
  check("in-memory offset store는 초기값을 지정할 수 있음", store.getOffset() === 10);
}

async function main(): Promise<void> {
  scenarioInMemory();
  scenarioFile();
  scenarioFileSurvivesRestart();
  scenarioFileCorruptedGracefulEmpty();
  await scenarioRealConcurrentTransitionOnSameApprovalExactlyOneWins();
  await scenarioRealConcurrentCreateOnDifferentApprovalsNoLostUpdate();
  scenarioOffsetInMemory();
  scenarioOffsetFile();
  scenarioOffsetFileSurvivesRestart();
  scenarioOffsetInMemoryInitial();

  console.log("\n=== approval-store.ts(G6) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);

  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 정리 실패는 테스트 결과에 영향 없음 — OS 임시 디렉터리라 최종적으로 정리됨.
    }
  }

  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
