import { createFileApprovalStore } from "./approval-store";
import type { ApprovalRequest } from "./approval";

// approval-store-tests.ts(§ 실제 concurrency test)가 spawn하는 별도 child process 전용
// helper다 — project-lock-concurrency-worker.ts와 동일한 패턴(실제 OS 프로세스 두 개 이상이
// 동시에 같은 file-based ApprovalStore를 mutate할 때 lost-update/중복 성공이 없는지를 mock
// 없이 검증). 이 파일 자체는 어떤 test 러너에도 등록하지 않는다.
//
// argv:
//   [filePath, "transition", approvalId] — PENDING -> APPROVED 전이를 시도한다.
//   [filePath, "create", approvalId, dedupeKey] — createPending()을 시도한다.
const [, , filePath, mode, ...rest] = process.argv;
const store = createFileApprovalStore(filePath);

if (mode === "transition") {
  const [approvalId] = rest;
  const result = store.transition(approvalId, "APPROVED", new Date().toISOString());
  console.log(result.ok ? "TRANSITIONED" : "NOT_TRANSITIONED");
} else if (mode === "create") {
  const [approvalId, dedupeKey] = rest;
  const request: ApprovalRequest = {
    approvalId,
    createdAt: new Date().toISOString(),
    expiresAt: "2099-01-01T00:00:00.000Z",
    runId: `r-${approvalId}`,
    approvalType: "UNKNOWN",
    sourceEventType: "HUMAN_APPROVAL_REQUIRED",
    sourceEventId: `evt-${approvalId}`,
    status: "PENDING",
    remotelyApprovable: false,
    requiresSafetyRecheck: true,
    dedupeKey,
  };
  const created = store.createPending(request);
  console.log(created.approvalId === approvalId ? "CREATED" : "DEDUPED");
} else {
  console.log(`UNKNOWN_MODE:${mode}`);
}
