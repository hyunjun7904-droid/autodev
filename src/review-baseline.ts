import { createHash } from "node:crypto";
import type { WorkingTreeChange, WorkingTreeChanges } from "./git-changes";

// GPT Reviewer Review Baseline / Checkpoint — Phase SI-3.8D(Incremental GPT Reviewer).
//
// 이 파일은 review round 사이의 "last-reviewed state"를 deterministic하게 표현하고 비교하는
// 순수 함수만 담는다 — OpenAI API를 호출하지 않고, git 명령도 직접 실행하지 않는다(호출부가
// git-changes.ts로 이미 조회한 WorkingTreeChanges/파일 내용만 받는다). "previous PASS를
// 단순히 신뢰"하지 않기 위해, 매 round마다 실제 파일 content의 SHA-256 hash를 이전 baseline과
// 비교해서만 "변경되지 않음"을 인정한다.
//
// gpt-reviewer.ts(reviewClaudeResultOnce)가 이 모듈의 함수만 써서 FULL/INCREMENTAL/
// SAFE_FULL_FALLBACK 중 어느 모드로 payload를 만들지, 그리고 이번 round가 끝난 뒤의 새
// baseline이 무엇인지 결정한다. orchestrator.ts/agent-orchestrator.ts는 이 baseline을
// while 루프의 loop-local 변수로만 들고 있다(gptCallCount/gptRawCallTotal과 동일한 패턴) —
// project-state.json에 영속화하지 않는다. 두 이유: (1) runOrchestrator()는 호출될 때마다
// state.reviewCycle을 0으로 리셋하므로 REVISE 루프는 항상 같은 프로세스 실행 안에서만
// 이어진다(프로세스 재시작 사이에 이어지는 개념이 애초에 없다), (2) baseline을 디스크에
// 영속화하면 "재시작 사이에 실제로는 다른 프로세스/다른 checkout 상태였는데 이전 baseline을
// 그대로 신뢰"하는 새로운 위험을 만든다 — in-memory-only로 두면 그 위험 자체가 없다.

export type ReviewPayloadMode = "FULL" | "INCREMENTAL" | "SAFE_FULL_FALLBACK";

export interface ReviewFileState {
  status: WorkingTreeChange["status"];
  /** 현재 파일 내용(삭제된 파일은 고정 sentinel)의 SHA-256 hex digest. */
  contentHash: string;
  /** status==="renamed"일 때만. */
  renamedFrom?: string;
}

export interface ReviewBaseline {
  /** task 문자열의 SHA-256 — 이 baseline이 어느 task의 REVISE 루프에 속하는지 식별한다. */
  taskIdentity: string;
  /** scopeDirs를 정렬해 합친 값 — scope가 바뀌면(있을 수 없지만 방어적으로) baseline을
   *  무효화한다. */
  scopeKey: string;
  /** allowedPathPrefixes를 정렬해 합친 값. */
  allowedPathPrefixesKey: string;
  /** 이 baseline이 만들어진 시점의 reviewCycle — 다음 round는 반드시 reviewCycle-1이어야
   *  한다(연속되지 않은 baseline 재사용 금지). */
  reviewCycleOfBaseline: number;
  /** fileHashes를 정렬해 만든 SHA-256 — baseline 객체가 그대로인지(tamper 여부) 재확인하는
   *  용도. */
  baselineHash: string;
  fileHashes: Record<string, ReviewFileState>;
}

// 삭제된 파일은 내용을 읽을 수 없다 — "삭제됨"이라는 상태 자체가 identity가 되도록 고정
// sentinel 문자열의 hash를 쓴다(실제 파일 내용을 추측/캐시하지 않는다).
const DELETED_CONTENT_SENTINEL = "__AUTODEV_REVIEW_BASELINE_DELETED_FILE__";
// 내용을 안전하게 읽을 수 없었던(권한 거부 등) 파일도 마찬가지로 "변경된 것으로 취급"해야
// 안전하다(fail-closed) — unreadable을 "unchanged"로 오인하지 않도록 별도 sentinel을 쓴다.
const UNREADABLE_CONTENT_SENTINEL = "__AUTODEV_REVIEW_BASELINE_UNREADABLE_FILE__";

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

export function buildScopeKey(scopeDirs: string[]): string {
  return [...scopeDirs].sort().join("|");
}

export function buildAllowedPathPrefixesKey(allowedPathPrefixes: string[]): string {
  return [...allowedPathPrefixes].sort().join("|");
}

export function buildTaskIdentity(task: string): string {
  return sha256Hex(task);
}

function sortedFileHashesJson(fileHashes: Record<string, ReviewFileState>): string {
  const keys = Object.keys(fileHashes).sort();
  return JSON.stringify(keys.map((k) => [k, fileHashes[k].status, fileHashes[k].contentHash, fileHashes[k].renamedFrom ?? null]));
}

export function computeBaselineHash(fileHashes: Record<string, ReviewFileState>): string {
  return sha256Hex(sortedFileHashesJson(fileHashes));
}

export interface FileContentReader {
  /** path(POSIX 상대경로)의 현재 내용을 반환한다. 읽을 수 없으면(삭제/권한 거부 등)
   *  undefined — 호출부가 "삭제됨"과 "읽기 실패"를 구분해 처리한다. */
  read(path: string, status: WorkingTreeChange["status"]): { ok: true; content: string } | { ok: false };
}

/**
 * changes.all(현재 git status 기준 변경 목록) 전체에 대해 content hash snapshot을 만든다 —
 * "변경된 subset"이 아니라 항상 전체를 만든다(다음 round의 diffAgainstBaseline이 정확히
 * 동작하려면 매 round의 baseline이 그 시점의 완전한 상태를 담고 있어야 한다).
 */
export function buildFileStateSnapshot(changes: WorkingTreeChanges, reader: FileContentReader): Record<string, ReviewFileState> {
  const result: Record<string, ReviewFileState> = {};
  for (const change of changes.all) {
    if (change.status === "deleted") {
      result[change.path] = { status: "deleted", contentHash: sha256Hex(DELETED_CONTENT_SENTINEL) };
      continue;
    }
    const read = reader.read(change.path, change.status);
    result[change.path] = {
      status: change.status,
      contentHash: read.ok ? sha256Hex(read.content) : sha256Hex(UNREADABLE_CONTENT_SENTINEL),
      renamedFrom: change.renamedFrom,
    };
  }
  return result;
}

export function buildReviewBaseline(input: {
  taskIdentity: string;
  scopeKey: string;
  allowedPathPrefixesKey: string;
  reviewCycleOfBaseline: number;
  fileHashes: Record<string, ReviewFileState>;
}): ReviewBaseline {
  return { ...input, baselineHash: computeBaselineHash(input.fileHashes) };
}

export type BaselineValidationFailureReason =
  | "TAMPERED"
  | "TASK_MISMATCH"
  | "SCOPE_MISMATCH"
  | "PATH_PREFIX_MISMATCH"
  | "NON_SEQUENTIAL_CYCLE";

export type BaselineValidationResult = { ok: true } | { ok: false; reason: BaselineValidationFailureReason };

/**
 * baseline이 이번 round에 그대로 이어서 쓰기에 안전한지 판정한다. previous PASS를 "이미
 * 봤으니 신뢰"하지 않는다는 원칙의 구조적 강제 지점 — 여기서 실패하면 호출부는 절대 조용히
 * INCREMENTAL을 계속하지 않고 SAFE_FULL_FALLBACK(또는 BLOCK)으로 명시적으로 전환해야 한다.
 */
export function validateReviewBaseline(
  baseline: ReviewBaseline,
  expected: { taskIdentity: string; scopeKey: string; allowedPathPrefixesKey: string; reviewCycle: number }
): BaselineValidationResult {
  if (computeBaselineHash(baseline.fileHashes) !== baseline.baselineHash) return { ok: false, reason: "TAMPERED" };
  if (baseline.taskIdentity !== expected.taskIdentity) return { ok: false, reason: "TASK_MISMATCH" };
  if (baseline.scopeKey !== expected.scopeKey) return { ok: false, reason: "SCOPE_MISMATCH" };
  if (baseline.allowedPathPrefixesKey !== expected.allowedPathPrefixesKey) return { ok: false, reason: "PATH_PREFIX_MISMATCH" };
  if (baseline.reviewCycleOfBaseline !== expected.reviewCycle - 1) return { ok: false, reason: "NON_SEQUENTIAL_CYCLE" };
  return { ok: true };
}

export interface BaselineDiff {
  /** baseline에 없었거나(new) status/content hash가 달라진(re-modified) 경로 — 정렬됨. */
  changedPaths: string[];
  /** baseline과 status/content hash가 완전히 동일한 경로 — 정렬됨. */
  unchangedPaths: string[];
  /** baseline(직전 round)에는 있었지만 이번 round의 current snapshot에는 전혀 나타나지 않는
   *  경로 — 정렬됨. tracked 파일의 삭제는 git status가 계속 "deleted" 상태로 보고하므로
   *  current에 그대로 남아 changedPaths로 분류된다(§ Claude code-review 지적) — 이 목록은
   *  오직 untracked 파일이 삭제되어 git status 자체에서 완전히 사라지는 경우처럼, current에서
   *  아예 관측되지 않게 된 경로만 담는다. 호출부(gpt-reviewer.ts)가 "이전에 지적된 파일이
   *  조용히 사라졌다"는 사실을 reviewer에게 명시적으로 알리는 데 쓴다. */
  removedPaths: string[];
}

/** current(이번 round의 전체 snapshot)를 baseline과 비교해 실제로 달라진 파일만 골라낸다. */
export function diffAgainstBaseline(current: Record<string, ReviewFileState>, baseline: ReviewBaseline): BaselineDiff {
  const changedPaths: string[] = [];
  const unchangedPaths: string[] = [];
  for (const path of Object.keys(current)) {
    const prior = baseline.fileHashes[path];
    const now = current[path];
    if (!prior || prior.contentHash !== now.contentHash || prior.status !== now.status || prior.renamedFrom !== now.renamedFrom) {
      changedPaths.push(path);
    } else {
      unchangedPaths.push(path);
    }
  }
  const currentKeys = new Set(Object.keys(current));
  const removedPaths = Object.keys(baseline.fileHashes).filter((p) => !currentKeys.has(p));
  changedPaths.sort();
  unchangedPaths.sort();
  removedPaths.sort();
  return { changedPaths, unchangedPaths, removedPaths };
}

/**
 * Final Consistency Cross-check(§ 요구사항 9) — 이번 round의 payload를 만든 시점의 snapshot과,
 * (실제 API 호출을 거쳐) decision을 받은 시점에 다시 계산한 snapshot을 비교한다. 완전히
 * 동일해야만 "review된 내용 == 지금 승인하려는 내용"이 보장된다. 순수 local hash 비교이므로
 * OpenAI를 다시 호출하지 않는다.
 */
export function snapshotsAreIdentical(a: Record<string, ReviewFileState>, b: Record<string, ReviewFileState>): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    const path = aKeys[i];
    if (a[path].contentHash !== b[path].contentHash || a[path].status !== b[path].status || a[path].renamedFrom !== b[path].renamedFrom) {
      return false;
    }
  }
  return true;
}
