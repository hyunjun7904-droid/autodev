import { createFileApprovalStore } from "./approval-store";
import { ensureDurableApprovalForGenuineWaitingHuman } from "./local-human-approval";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { TaskDefinition } from "./task-registry";

// orphaned-human-gate-tests.ts(§ 실제 concurrency/multi-project test)가 spawn하는 별도 child
// process 전용 helper다 — approval-store-concurrency-worker.ts와 동일한 패턴(실제 OS 프로세스
// 두 개 이상이 동시에 같은 durable state/file-based ApprovalStore를 대상으로
// ensureDurableApprovalForGenuineWaitingHuman()을 호출할 때 mock 없이 exactly-one을
// 검증한다). 이 파일 자체는 어떤 test 러너에도 등록하지 않는다.
//
// argv: [statePath, approvalStoreFilePath, projectId, targetProjectRoot, taskId]
const [, , statePath, approvalStoreFilePath, projectId, targetProjectRoot, taskId] = process.argv;

const FIXTURE_TASK: TaskDefinition = {
  id: taskId,
  phase: 1,
  taskNumber: 1,
  title: "orphaned human gate recovery fixture task",
  prompt: "fixture",
  requiredTests: [],
  allowedPathPrefixes: ["src/"],
  prohibitedOperations: [],
};
const FIXTURE_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["src/"],
  allowedWritePrefixes: ["src/"],
  allowedCommands: [],
};

const manifest: ProjectManifest = {
  projectId,
  projectName: `Fixture ${projectId}`,
  targetProjectRoot,
  statePath,
  taskRegistry: [FIXTURE_TASK],
  developerInstructions: "fixture",
  reviewInstructions: "fixture",
  reviewScopeDirs: ["src/"],
  executionPolicy: FIXTURE_EXECUTION_POLICY,
};

const approvalStore = createFileApprovalStore(approvalStoreFilePath);
const outcome = ensureDurableApprovalForGenuineWaitingHuman(taskId, { approvalStore, statePath, manifest, cwd: targetProjectRoot });
console.log(JSON.stringify({ kind: outcome.kind, approvalId: "approval" in outcome ? outcome.approval.approvalId : null, projectId: "approval" in outcome ? outcome.approval.projectId : null }));
