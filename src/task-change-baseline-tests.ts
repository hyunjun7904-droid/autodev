import { mkdtempSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { captureTaskChangeBaseline, classifyTaskChangeDelta, isProvenTaskCreatedPath } from "./task-change-baseline";
import { getWorkingTreeChanges } from "./git-changes";

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "movan-task-change-baseline-test-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "autodev-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "AutoDev Test"], { cwd: dir });
  writeFileSync(join(dir, "tracked.txt"), "원본 내용\n");
  spawnSync("git", ["add", "--", "tracked.txt"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function writeFile(repo: string, relPath: string, content: string): void {
  const abs = join(repo, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function scenarioCaptureBaselineRecordsCurrentChanges(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "untracked-a.txt", "새 파일 A\n");
    const baseline = captureTaskChangeBaseline("T1", repo);
    check("captureTaskChangeBaseline: taskId 보존", baseline.taskId === "T1");
    check("captureTaskChangeBaseline: capturedAt이 ISO 문자열", typeof baseline.capturedAt === "string" && baseline.capturedAt.length > 0);
    check("captureTaskChangeBaseline: untracked-a.txt가 entries에 기록됨", baseline.entries.some((e) => e.path === "untracked-a.txt"));
    const entry = baseline.entries.find((e) => e.path === "untracked-a.txt");
    check("captureTaskChangeBaseline: contentHash가 실제 sha256 hex(64자)", !!entry && /^[0-9a-f]{64}$/.test(entry.contentHash));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioClassifyDeltaUnchangedVsModifiedVsNew(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "pre-existing-unchanged.txt", "안 바뀜\n");
    writeFile(repo, "pre-existing-will-change.txt", "바뀔 예정\n");
    const baseline = captureTaskChangeBaseline("T1", repo);

    // task 진행 — 세 종류 변경을 만든다.
    writeFile(repo, "pre-existing-will-change.txt", "실제로 바뀜\n");
    writeFile(repo, "new-during-task.txt", "새로 생김\n");

    const changes = getWorkingTreeChanges(["."], repo).all;
    const delta = classifyTaskChangeDelta(baseline, changes, repo);

    check(
      "classifyTaskChangeDelta: pre-existing-unchanged.txt → preExistingUnchanged",
      delta.preExistingUnchanged.some((c) => c.path === "pre-existing-unchanged.txt")
    );
    check(
      "classifyTaskChangeDelta: pre-existing-will-change.txt → modifiedSinceBaseline",
      delta.modifiedSinceBaseline.some((c) => c.path === "pre-existing-will-change.txt")
    );
    check(
      "classifyTaskChangeDelta: new-during-task.txt → newSinceBaseline",
      delta.newSinceBaseline.some((c) => c.path === "new-during-task.txt")
    );
    check(
      "classifyTaskChangeDelta: 세 그룹이 서로 겹치지 않음(unchanged에 나머지 둘이 없음)",
      !delta.preExistingUnchanged.some((c) => c.path === "pre-existing-will-change.txt" || c.path === "new-during-task.txt")
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// 삭제(status=deleted)도 "내용이 바뀜"으로 취급돼야 한다 — mtime이 아니라 존재 여부 변화도
// content token 비교로 감지된다.
function scenarioClassifyDeltaDetectsDeletion(): void {
  const repo = makeTempGitRepo();
  try {
    const baseline = captureTaskChangeBaseline("T1", repo); // tracked.txt는 이미 commit됨(baseline 시점엔 dirty 없음)
    unlinkSync(join(repo, "tracked.txt"));
    const changes = getWorkingTreeChanges(["."], repo).all;
    const delta = classifyTaskChangeDelta(baseline, changes, repo);
    check("classifyTaskChangeDelta: 삭제는 baseline에 없던 경로이므로 newSinceBaseline", delta.newSinceBaseline.some((c) => c.path === "tracked.txt" && c.status === "deleted"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// baseline이 이미 "deleted" 상태를 기록했고 그 뒤로 계속 삭제 상태 그대로면 unchanged여야 한다.
function scenarioClassifyDeltaDeletedThenStillDeletedIsUnchanged(): void {
  const repo = makeTempGitRepo();
  try {
    unlinkSync(join(repo, "tracked.txt"));
    const baseline = captureTaskChangeBaseline("T1", repo); // 이미 삭제된 상태로 캡처
    const entry = baseline.entries.find((e) => e.path === "tracked.txt");
    check("baseline: 삭제 상태는 DELETED sentinel로 기록됨", entry?.contentHash === "DELETED");

    writeFile(repo, "new-during-task.txt", "이 task가 만든 진짜 변경\n");
    const changes = getWorkingTreeChanges(["."], repo).all;
    const delta = classifyTaskChangeDelta(baseline, changes, repo);
    check(
      "classifyTaskChangeDelta: 이미 삭제된 채였던 tracked.txt는 여전히 preExistingUnchanged",
      delta.preExistingUnchanged.some((c) => c.path === "tracked.txt")
    );
    check("classifyTaskChangeDelta: new-during-task.txt는 newSinceBaseline", delta.newSinceBaseline.some((c) => c.path === "new-during-task.txt"));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioClassifyDeltaMissingBaselineFallsBackToAllNew(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "pre-existing.txt", "이 기능 도입 전부터 있던 파일\n");
    const changes = getWorkingTreeChanges(["."], repo).all;
    const delta = classifyTaskChangeDelta(null, changes, repo);
    check(
      "classifyTaskChangeDelta: baseline=null이면 모든 변경이 newSinceBaseline(레거시 fallback)",
      delta.newSinceBaseline.some((c) => c.path === "pre-existing.txt") && delta.preExistingUnchanged.length === 0
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioIsProvenTaskCreatedPath(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "pre-existing.txt", "이미 있던 파일\n");
    const baseline = captureTaskChangeBaseline("T1", repo);
    writeFile(repo, "new-during-task.txt", "새로 생긴 파일\n");

    check(
      "isProvenTaskCreatedPath: baseline에 있던 경로는 false(삭제 금지 대상)",
      isProvenTaskCreatedPath(baseline, "pre-existing.txt") === false
    );
    check(
      "isProvenTaskCreatedPath: baseline에 없던 경로는 true(삭제 가능 후보)",
      isProvenTaskCreatedPath(baseline, "new-during-task.txt") === true
    );
    check("isProvenTaskCreatedPath: baseline이 null이면 항상 false(provenance 불확실 → 삭제 금지)", isProvenTaskCreatedPath(null, "new-during-task.txt") === false);
    check(
      "isProvenTaskCreatedPath: baseline이 undefined여도 항상 false",
      isProvenTaskCreatedPath(undefined, "new-during-task.txt") === false
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function main(): void {
  scenarioCaptureBaselineRecordsCurrentChanges();
  scenarioClassifyDeltaUnchangedVsModifiedVsNew();
  scenarioClassifyDeltaDetectsDeletion();
  scenarioClassifyDeltaDeletedThenStillDeletedIsUnchanged();
  scenarioClassifyDeltaMissingBaselineFallsBackToAllNew();
  scenarioIsProvenTaskCreatedPath();

  console.log("\n=== task-change-baseline 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
