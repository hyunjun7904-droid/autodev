import type { ClaudeResult } from "./types";

// Step 1의 fake/mock 구현 — AUTOMATION_DRY_RUN=true(기본값)일 때 orchestrator가 사용한다.
// 실제 claude CLI subprocess를 실행하지 않는다.
export async function runClaudeTask(task: string, attempt: number): Promise<ClaudeResult> {
  return {
    success: true,
    summary: `[FAKE] "${task}" ${attempt}차 구현 완료`,
    changedFiles: ["web/app/(app)/photos/upload-panel.tsx", "web/lib/storage/upload-ui-hooks.ts"],
    tests: [
      { name: "fake-init-flow", pass: true },
      { name: "fake-finalize-flow", pass: true },
    ],
    rawOutput: `[FAKE CLAUDE OUTPUT] task="${task}" attempt=${attempt}`,
  };
}
