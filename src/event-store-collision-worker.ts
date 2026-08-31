import { existsSync, writeFileSync } from "node:fs";
import { createFileEventStore } from "./event-store";

// event-store-tests.ts(§ 실제 multi-process ordering fixture)가 spawn하는 별도 child
// process 전용 helper다 — 2026-09-01 읽기 전용 조사에서 실측 재현했던 "먼저 뜬(process-local
// sequence 카운터가 stale해질) 프로세스가 나중에 event를 남기면, 나중에 시작한 프로세스가
// 그 사이 많이 append해 실제로는 더 이른 event보다 낮은 sequence를 받는" 시나리오를 그대로
// 재현한다. 이 파일 자체는 어떤 test 러너에도 등록하지 않는다 — 실제 Claude/OpenAI/Telegram
// 호출은 없다.
//
// argv: [filePath, role, markerPath]
//   role="early" — EventStore를 먼저 구성(그래서 local sequence 카운터가 나중에 stale해짐).
//     warm-up event 5개를 남긴 뒤 markerPath가 생길 때까지 기다렸다가, 공유 taskId에 대해
//     "나중에" 실제로 일어난 event 하나를 남긴다(예: controller가 뒤늦게 반응).
//   role="late" — EventStore를 나중에 구성(그래서 그 시점의 실제 디스크 max sequence를 안다).
//     노이즈 event 60개를 append하며 그 중간에 공유 taskId에 대해 "먼저" 실제로 일어난
//     event를 남기고, 끝나면 markerPath를 만들어 "early"가 이어서 진행하게 한다.
const [, , filePath, role, markerPath] = process.argv;
const store = createFileEventStore(filePath);

if (role === "early") {
  for (let i = 0; i < 5; i++) {
    store.append({ eventType: "TASK_STARTED", runId: "owner-run", taskId: `warmup-${i}`, projectId: "proj-owner" });
  }
  const deadline = Date.now() + 15_000;
  while (!existsSync(markerPath)) {
    if (Date.now() > deadline) {
      console.log(JSON.stringify({ ok: false, reason: "TIMEOUT_WAITING_FOR_MARKER" }));
      process.exit(1);
    }
    const spinUntil = Date.now() + 20;
    while (Date.now() < spinUntil) {
      /* short busy-wait poll — fine for a short-lived fixture worker */
    }
  }
  const r = store.append({
    eventType: "APPROVAL_REQUESTED",
    runId: "shared-run",
    taskId: "SHARED",
    projectId: "proj-b",
    reason: "early-process reacting late (stale local sequence counter)",
  });
  console.log(JSON.stringify({ ok: r.ok, eventId: r.event?.eventId, sequence: r.event?.sequence, timestamp: r.event?.timestamp }));
} else if (role === "late") {
  let humanApprovalEventId: string | undefined;
  let humanApprovalSequence: number | undefined;
  for (let i = 0; i < 60; i++) {
    store.append({ eventType: "TASK_STARTED", runId: "shared-run", taskId: `noise-${i}`, projectId: "proj-b" });
    if (i === 30) {
      const hr = store.append({
        eventType: "HUMAN_APPROVAL_REQUIRED",
        runId: "shared-run",
        taskId: "SHARED",
        projectId: "proj-b",
        reason: "orchestrator status=WAITING_HUMAN(x)",
      });
      humanApprovalEventId = hr.event?.eventId;
      humanApprovalSequence = hr.event?.sequence;
    }
  }
  writeFileSync(markerPath, "done\n", "utf-8");
  console.log(JSON.stringify({ eventId: humanApprovalEventId, sequence: humanApprovalSequence }));
} else {
  console.log(JSON.stringify({ ok: false, reason: `UNKNOWN_ROLE:${role}` }));
  process.exit(1);
}
