import {
  sha256Hex,
  buildScopeKey,
  buildAllowedPathPrefixesKey,
  buildTaskIdentity,
  buildFileStateSnapshot,
  buildReviewBaseline,
  computeBaselineHash,
  validateReviewBaseline,
  diffAgainstBaseline,
  snapshotsAreIdentical,
} from "./review-baseline";
import type { ReviewFileState, ReviewBaseline, FileContentReader } from "./review-baseline";
import type { WorkingTreeChanges } from "./git-changes";

// review-baseline.ts(Phase SI-3.8D) 순수 함수 단위 테스트 — git/파일시스템/OpenAI를 전혀
// 건드리지 않는다. 실제 git repo를 통한 통합 검증(FULL/INCREMENTAL 텍스트 조립, rename/
// delete/untracked 표현, working tree drift 감지)은 incremental-reviewer-tests.ts가 맡는다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function fakeChanges(entries: { path: string; status: WorkingTreeChanges["all"][number]["status"]; renamedFrom?: string }[]): WorkingTreeChanges {
  const all = entries.map((e) => ({ path: e.path, status: e.status, renamedFrom: e.renamedFrom }));
  return {
    all,
    tracked: all.filter((c) => c.status !== "untracked"),
    untracked: all.filter((c) => c.status === "untracked"),
    excluded: [],
  };
}

function readerFromMap(contents: Record<string, string>): FileContentReader {
  return {
    read(path) {
      if (!(path in contents)) return { ok: false };
      return { ok: true, content: contents[path] };
    },
  };
}

// ---------------------------------------------------------------------------
// A) 순수 identity/hash 함수 — deterministic(#15).
// ---------------------------------------------------------------------------
function scenarioA_deterministicIdentity(): void {
  check("A) sha256Hex는 동일 입력에 항상 동일 값", sha256Hex("hello") === sha256Hex("hello"));
  check("A) sha256Hex는 다른 입력에 다른 값", sha256Hex("hello") !== sha256Hex("hello2"));
  check("A) buildScopeKey는 순서와 무관하게 동일", buildScopeKey(["b/", "a/"]) === buildScopeKey(["a/", "b/"]));
  check("A) buildAllowedPathPrefixesKey도 순서와 무관하게 동일", buildAllowedPathPrefixesKey(["y/", "x/"]) === buildAllowedPathPrefixesKey(["x/", "y/"]));
  check("A) buildTaskIdentity는 동일 task 문자열에 항상 동일", buildTaskIdentity("같은 task") === buildTaskIdentity("같은 task"));
  check("A) buildTaskIdentity는 다른 task 문자열에 다른 값", buildTaskIdentity("task A") !== buildTaskIdentity("task B"));

  const fileHashes: Record<string, ReviewFileState> = { "a.ts": { status: "modified", contentHash: sha256Hex("x") } };
  const h1 = computeBaselineHash(fileHashes);
  const h2 = computeBaselineHash({ "a.ts": { status: "modified", contentHash: sha256Hex("x") } });
  check("A) computeBaselineHash는 동일 fileHashes에 항상 동일 값(review checkpoint identity deterministic)", h1 === h2);

  const baseline1 = buildReviewBaseline({ taskIdentity: "t", scopeKey: "s", allowedPathPrefixesKey: "p", reviewCycleOfBaseline: 1, fileHashes });
  const baseline2 = buildReviewBaseline({ taskIdentity: "t", scopeKey: "s", allowedPathPrefixesKey: "p", reviewCycleOfBaseline: 1, fileHashes });
  check("A) buildReviewBaseline은 동일 입력에 동일 baselineHash를 만듦", baseline1.baselineHash === baseline2.baselineHash);
}

// ---------------------------------------------------------------------------
// B) buildFileStateSnapshot — 상태별 hash 계산(삭제/읽기 실패 sentinel 포함).
// ---------------------------------------------------------------------------
function scenarioB_fileStateSnapshot(): void {
  const changes = fakeChanges([
    { path: "a.ts", status: "modified" },
    { path: "b.ts", status: "deleted" },
    { path: "c.ts", status: "added" },
    { path: "new.ts", status: "untracked" },
  ]);
  const reader = readerFromMap({ "a.ts": "content-a", "c.ts": "content-c", "new.ts": "content-new" });
  const snapshot = buildFileStateSnapshot(changes, reader);

  check("B) modified 파일의 hash는 실제 내용의 sha256", snapshot["a.ts"].contentHash === sha256Hex("content-a"));
  check("B) added 파일도 정상적으로 hash됨", snapshot["c.ts"].contentHash === sha256Hex("content-c"));
  check("B) untracked 파일도 정상적으로 hash됨", snapshot["new.ts"].contentHash === sha256Hex("content-new"));
  check("B) deleted 파일은 실제 내용을 읽지 않고도 고정 identity를 가짐", snapshot["b.ts"].status === "deleted" && typeof snapshot["b.ts"].contentHash === "string");

  // 읽기 실패(권한 거부 등)는 항상 같은 파일이라도 sentinel hash를 갖는다 — "unchanged"로
  // 잘못 취급되지 않도록(fail-closed) 매 라운드 동일 sentinel이라 실제로는 "다음 라운드에서도
  // 계속 unreadable"인 경우에만 unchanged로 보이는데, 이는 기존에도 그 파일 내용이 전혀
  // review되지 않던 것과 동일한 결과다(§ gpt-reviewer.ts 주석).
  const unreadableChanges = fakeChanges([{ path: "denied.ts", status: "untracked" }]);
  const unreadableSnapshot = buildFileStateSnapshot(unreadableChanges, readerFromMap({}));
  check("B) 읽기 실패한 파일도 snapshot에 포함됨(생략되지 않음)", "denied.ts" in unreadableSnapshot);
}

// ---------------------------------------------------------------------------
// C) validateReviewBaseline — missing/stale/tampered/incompatible(#12/13/14).
// ---------------------------------------------------------------------------
function makeValidBaseline(overrides: Partial<ReviewBaseline> = {}): ReviewBaseline {
  const fileHashes: Record<string, ReviewFileState> = { "a.ts": { status: "modified", contentHash: sha256Hex("x") } };
  const base = buildReviewBaseline({
    taskIdentity: "task-identity",
    scopeKey: "scope-key",
    allowedPathPrefixesKey: "prefix-key",
    reviewCycleOfBaseline: 1,
    fileHashes,
  });
  return { ...base, ...overrides };
}

function scenarioC_baselineValidation(): void {
  const expected = { taskIdentity: "task-identity", scopeKey: "scope-key", allowedPathPrefixesKey: "prefix-key", reviewCycle: 2 };

  const valid = makeValidBaseline();
  const okResult = validateReviewBaseline(valid, expected);
  check("C) 정상 baseline(연속된 cycle, 동일 task/scope)은 ok:true", okResult.ok === true);

  const tampered = makeValidBaseline({ fileHashes: { "a.ts": { status: "modified", contentHash: sha256Hex("changed-without-rehash") } } });
  const tamperedResult = validateReviewBaseline(tampered, expected);
  check("C) fileHashes만 바뀌고 baselineHash는 그대로면 TAMPERED로 판정됨", !tamperedResult.ok && tamperedResult.reason === "TAMPERED");

  const wrongTask = makeValidBaseline({ taskIdentity: "다른-task" });
  const wrongTaskResult = validateReviewBaseline(wrongTask, expected);
  check("C) task identity가 다르면 TASK_MISMATCH", !wrongTaskResult.ok && wrongTaskResult.reason === "TASK_MISMATCH");

  const wrongScope = makeValidBaseline({ scopeKey: "다른-scope" });
  const wrongScopeResult = validateReviewBaseline(wrongScope, expected);
  check("C) scope가 다르면 SCOPE_MISMATCH", !wrongScopeResult.ok && wrongScopeResult.reason === "SCOPE_MISMATCH");

  const wrongPrefix = makeValidBaseline({ allowedPathPrefixesKey: "다른-prefix" });
  const wrongPrefixResult = validateReviewBaseline(wrongPrefix, expected);
  check("C) allowedPathPrefixes가 다르면 PATH_PREFIX_MISMATCH", !wrongPrefixResult.ok && wrongPrefixResult.reason === "PATH_PREFIX_MISMATCH");

  const nonSequential = makeValidBaseline({ reviewCycleOfBaseline: 5 }); // expected.reviewCycle=2이므로 1이어야 함
  const nonSequentialResult = validateReviewBaseline(nonSequential, expected);
  check("C) baseline이 직전 cycle이 아니면 NON_SEQUENTIAL_CYCLE(stale)", !nonSequentialResult.ok && nonSequentialResult.reason === "NON_SEQUENTIAL_CYCLE");
}

// ---------------------------------------------------------------------------
// D) diffAgainstBaseline — changed/unchanged 분리, re-modified 재포함.
// ---------------------------------------------------------------------------
function scenarioD_diffAgainstBaseline(): void {
  const baseline = buildReviewBaseline({
    taskIdentity: "t",
    scopeKey: "s",
    allowedPathPrefixesKey: "p",
    reviewCycleOfBaseline: 1,
    fileHashes: {
      "unchanged.ts": { status: "modified", contentHash: sha256Hex("same") },
      "will-change-again.ts": { status: "modified", contentHash: sha256Hex("v2") },
    },
  });

  const current: Record<string, ReviewFileState> = {
    "unchanged.ts": { status: "modified", contentHash: sha256Hex("same") },
    "will-change-again.ts": { status: "modified", contentHash: sha256Hex("v3") },
    "brand-new.ts": { status: "untracked", contentHash: sha256Hex("new") },
  };

  const diff = diffAgainstBaseline(current, baseline);
  check("D) 내용이 그대로인 파일은 unchangedPaths에 포함(#3)", diff.unchangedPaths.includes("unchanged.ts"));
  check("D) 내용이 그대로인 파일은 changedPaths에 없음", !diff.changedPaths.includes("unchanged.ts"));
  check("D) 이전에 PASS된 뒤 다시 변경된 파일은 changedPaths로 재포함됨(#4)", diff.changedPaths.includes("will-change-again.ts"));
  check("D) 새 파일도 changedPaths에 포함됨", diff.changedPaths.includes("brand-new.ts"));

  // baseline에는 있었지만 current(이번 round의 git status)에는 전혀 나타나지 않는 경로 —
  // 보통 untracked 파일이 삭제되어 git status 자체에서 사라진 경우(Claude code-review 지적).
  const baselineWithExtra = buildReviewBaseline({
    taskIdentity: "t",
    scopeKey: "s",
    allowedPathPrefixesKey: "p",
    reviewCycleOfBaseline: 1,
    fileHashes: { ...baseline.fileHashes, "vanished-untracked.ts": { status: "untracked", contentHash: sha256Hex("gone") } },
  });
  const diffWithRemoval = diffAgainstBaseline(current, baselineWithExtra);
  check(
    "D) baseline에는 있었지만 current에서 완전히 사라진 파일은 removedPaths로 보고됨(조용히 무시되지 않음)",
    diffWithRemoval.removedPaths.includes("vanished-untracked.ts")
  );
  check("D) removedPaths는 changedPaths/unchangedPaths와 별개(중복 집계 없음)", !diffWithRemoval.changedPaths.includes("vanished-untracked.ts") && !diffWithRemoval.unchangedPaths.includes("vanished-untracked.ts"));
}

// ---------------------------------------------------------------------------
// E) snapshotsAreIdentical — Final Consistency Cross-check의 핵심 비교(#16).
// ---------------------------------------------------------------------------
function scenarioE_snapshotsAreIdentical(): void {
  const a: Record<string, ReviewFileState> = { "x.ts": { status: "modified", contentHash: sha256Hex("v1") } };
  const bSame: Record<string, ReviewFileState> = { "x.ts": { status: "modified", contentHash: sha256Hex("v1") } };
  const bChanged: Record<string, ReviewFileState> = { "x.ts": { status: "modified", contentHash: sha256Hex("v2") } };
  const bExtra: Record<string, ReviewFileState> = {
    "x.ts": { status: "modified", contentHash: sha256Hex("v1") },
    "y.ts": { status: "untracked", contentHash: sha256Hex("y") },
  };

  check("E) 완전히 동일한 snapshot은 identical", snapshotsAreIdentical(a, bSame));
  check("E) 내용이 바뀐 snapshot은 identical이 아님(이전 PASS 영역이 이후 변경되면 감지됨)", !snapshotsAreIdentical(a, bChanged));
  check("E) 파일이 추가된 snapshot도 identical이 아님", !snapshotsAreIdentical(a, bExtra));
}

function main(): void {
  scenarioA_deterministicIdentity();
  scenarioB_fileStateSnapshot();
  scenarioC_baselineValidation();
  scenarioD_diffAgainstBaseline();
  scenarioE_snapshotsAreIdentical();

  console.log("\n=== review-baseline.ts(Incremental GPT Reviewer 순수 함수) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
