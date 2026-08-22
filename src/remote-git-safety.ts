import { spawnSync } from "node:child_process";
import { getCurrentBranch, getCurrentHeadHash } from "./git-changes";

// Remote Git Safety — Phase G Task G7.3 (GitHub Sync & Remote Repository Safety).
//
// 목적: AutoDev가 오래된 local Git 상태나 예상하지 못한 remote 변경 위에서 계속
// 개발/commit/push하는 것을 막는다. 이 파일은 project-lock.ts와 동일한 성격의 canonical
// deterministic 판정 서비스다 — EventStore/checkpoint/orchestrator를 전혀 모른다(실제 event
// 기록/배선은 autodev.ts가 전담, § project-lock.ts 상단 주석과 동일한 관심사 분리).
//
// 이 파일의 모든 git 호출은 spawnSync로 고정 인자 배열만 실행한다(셸을 거치지 않음 —
// checkpoint.ts/git-changes.ts/project-lock.ts와 동일한 관례). fetch는 read/update-only
// 안전 작업이다 — working tree를 전혀 건드리지 않는다(git fetch는 remote-tracking ref만
// 갱신한다). 이 파일 어디에도 reset/rebase/merge/checkout/force push를 실행하는 코드가
// 없다 — 판정이 불확실하면 항상 fail-closed(BLOCK)로 반환할 뿐, 어떤 "자동 복구"도
// 시도하지 않는다.
//
// remote URL 원문은 어디에도 반환/로그하지 않는다 — 존재 여부(boolean)만 판정에 쓴다(§
// 요구사항 2, 8 — remote URL이 보안상 민감할 수 있는 경우 EventStore/log에 전체 저장하지
// 않는다).

export const DEFAULT_REMOTE_NAME = "origin";

export type RemoteGitBlockedCode =
  | "REMOTE_FETCH_FAILED"
  | "NO_REMOTE"
  | "NO_UPSTREAM"
  | "DETACHED_HEAD"
  | "UNEXPECTED_BRANCH"
  | "REMOTE_AHEAD"
  | "LOCAL_AHEAD_UNEXPECTED"
  | "DIVERGED"
  | "MALFORMED_GIT_OUTPUT"
  | "COMPARISON_UNCERTAIN";

/** run 시작 시점에 관찰한 최소 스냅샷 — push/checkpoint 직전 재비교의 기준이 된다(§
 *  요구사항 8). secret/prompt/model output을 담지 않는다 — hash/branch/remote 이름과
 *  관측 시각뿐이다. */
export interface RemoteGitSnapshot {
  remoteName: string;
  branch: string;
  localHeadAtStart: string;
  remoteHeadAtStart: string;
  observedAt: string;
}

export type RemoteSafetyCheckResult =
  | { ok: true; snapshot: RemoteGitSnapshot }
  | { ok: false; code: RemoteGitBlockedCode; reason: string };

export type RemoteChangedCheckResult =
  | { ok: true }
  | {
      ok: false;
      code: "REMOTE_FETCH_FAILED" | "REMOTE_CHANGED_DURING_RUN" | "MALFORMED_GIT_OUTPUT";
      reason: string;
      currentRemoteHead?: string;
    };

export type SafePushBlockedCode =
  | "REMOTE_FETCH_FAILED"
  | "REMOTE_CHANGED_DURING_RUN"
  | "MALFORMED_GIT_OUTPUT"
  | "NOTHING_TO_PUSH"
  | "REMOTE_PUSH_REJECTED"
  | "PUSH_FAILED";

export type SafePushResult = { ok: true; pushedHead: string } | { ok: false; code: SafePushBlockedCode; reason: string };

const COMMIT_HASH_PATTERN = /^[0-9a-f]{40}$/i;

function isValidHash(value: string): boolean {
  return COMMIT_HASH_PATTERN.test(value.trim());
}

function runGit(args: string[], cwd: string, timeoutMs = 15_000): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd, shell: false, encoding: "utf-8", timeout: timeoutMs });
  return { ok: res.status === 0, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

/** remote가 존재하는지만(URL 원문은 반환하지 않음) 확인한다. */
export function hasRemote(cwd: string, remoteName: string = DEFAULT_REMOTE_NAME): boolean {
  const res = runGit(["remote", "get-url", remoteName], cwd);
  return res.ok && res.stdout.length > 0;
}

/**
 * remote 상태 비교 전 반드시 거치는 안전 fetch — working tree를 전혀 수정하지 않는다(§
 * 요구사항 3). 실패하면 network 장애를 "local이 clean하다"로 오판하지 않고 그대로
 * ok:false를 반환한다(호출부가 REMOTE_FETCH_FAILED로 BLOCK).
 */
export function safeFetchRemote(cwd: string, remoteName: string = DEFAULT_REMOTE_NAME): { ok: boolean; reason?: string } {
  const res = runGit(["fetch", "--prune", "--", remoteName], cwd, 30_000);
  if (!res.ok) {
    return { ok: false, reason: `git fetch 실패(remote=${remoteName}): ${res.stderr || "알 수 없는 오류"}` };
  }
  return { ok: true };
}

function getUpstreamRef(cwd: string): string | undefined {
  const res = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd);
  return res.ok && res.stdout.length > 0 ? res.stdout : undefined;
}

function getRemoteBranchHead(cwd: string, remoteName: string, branch: string): string | undefined {
  const res = runGit(["rev-parse", `refs/remotes/${remoteName}/${branch}`], cwd);
  if (!res.ok) return undefined;
  return isValidHash(res.stdout) ? res.stdout.trim() : undefined;
}

/** "<remoteRef>...HEAD" 기준 behind(remote에만 있는 commit 수)/ahead(local에만 있는 commit
 *  수)를 계산한다. 출력이 예상 형식이 아니면(malformed) undefined — 호출부가 COMPARISON_
 *  UNCERTAIN으로 fail-closed 처리한다. */
function computeAheadBehind(cwd: string, remoteRef: string): { behind: number; ahead: number } | undefined {
  const res = runGit(["rev-list", "--left-right", "--count", `${remoteRef}...HEAD`], cwd);
  if (!res.ok) return undefined;
  const parts = res.stdout.split(/\s+/).filter(Boolean);
  if (parts.length !== 2) return undefined;
  const behind = Number(parts[0]);
  const ahead = Number(parts[1]);
  if (!Number.isInteger(behind) || !Number.isInteger(ahead) || behind < 0 || ahead < 0) return undefined;
  return { behind, ahead };
}

export interface CheckRemoteSafeToStartOptions {
  remoteName?: string;
  /** 지정하면 현재 branch가 반드시 이 값과 같아야 한다(project policy가 기대하는 branch). */
  expectedBranch?: string;
}

/**
 * Start-of-run Remote Safety Gate — 실제 writer(Developer 실행/checkpoint)가 시작되기
 * 전에 한 번 호출한다(§ 요구사항 4). 어떤 git 상태 변경(reset/rebase/checkout 등)도
 * 수행하지 않는다 — read-only 조회 + fetch(remote-tracking ref 갱신)만 한다.
 *
 * 허용되는 유일한 성공 상태는 local HEAD == origin/<branch>다(§ 요구사항 4). 그 외
 * (remote ahead/local ahead/diverged/detached HEAD/upstream 없음/remote 없음/fetch 실패/
 * 비교 불가)는 전부 fail-closed BLOCK이다.
 */
export function checkRemoteSafeToStart(cwd: string, opts: CheckRemoteSafeToStartOptions = {}): RemoteSafetyCheckResult {
  const remoteName = opts.remoteName ?? DEFAULT_REMOTE_NAME;

  const branch = getCurrentBranch(cwd);
  if (branch === undefined) {
    return { ok: false, code: "DETACHED_HEAD", reason: "현재 HEAD가 detached 상태이거나 branch 이름을 확인할 수 없습니다." };
  }
  if (opts.expectedBranch !== undefined && branch !== opts.expectedBranch) {
    return {
      ok: false,
      code: "UNEXPECTED_BRANCH",
      reason: `현재 branch(${branch})가 예상 branch(${opts.expectedBranch})와 다릅니다.`,
    };
  }

  if (!hasRemote(cwd, remoteName)) {
    return { ok: false, code: "NO_REMOTE", reason: `remote "${remoteName}"가 존재하지 않습니다.` };
  }

  const upstream = getUpstreamRef(cwd);
  if (upstream === undefined) {
    return { ok: false, code: "NO_UPSTREAM", reason: `현재 branch(${branch})에 upstream tracking branch가 설정되어 있지 않습니다.` };
  }
  const expectedUpstream = `${remoteName}/${branch}`;
  if (upstream !== expectedUpstream) {
    return {
      ok: false,
      code: "UNEXPECTED_BRANCH",
      reason: `upstream(${upstream})이 예상 값(${expectedUpstream})과 다릅니다.`,
    };
  }

  const fetch = safeFetchRemote(cwd, remoteName);
  if (!fetch.ok) {
    return { ok: false, code: "REMOTE_FETCH_FAILED", reason: fetch.reason ?? "git fetch 실패" };
  }

  const localHead = getCurrentHeadHash(cwd);
  if (localHead === undefined || !isValidHash(localHead)) {
    return { ok: false, code: "MALFORMED_GIT_OUTPUT", reason: "local HEAD commit hash를 확인할 수 없습니다." };
  }
  const remoteHead = getRemoteBranchHead(cwd, remoteName, branch);
  if (remoteHead === undefined) {
    return {
      ok: false,
      code: "MALFORMED_GIT_OUTPUT",
      reason: `remote-tracking ref(refs/remotes/${remoteName}/${branch})를 확인할 수 없습니다.`,
    };
  }

  if (localHead === remoteHead) {
    return {
      ok: true,
      snapshot: { remoteName, branch, localHeadAtStart: localHead, remoteHeadAtStart: remoteHead, observedAt: new Date().toISOString() },
    };
  }

  const aheadBehind = computeAheadBehind(cwd, `refs/remotes/${remoteName}/${branch}`);
  if (aheadBehind === undefined) {
    return { ok: false, code: "COMPARISON_UNCERTAIN", reason: "local과 remote의 divergence를 확인할 수 없습니다." };
  }
  const { behind, ahead } = aheadBehind;
  if (behind > 0 && ahead > 0) {
    return {
      ok: false,
      code: "DIVERGED",
      reason: `local과 remote(${remoteName}/${branch})가 분기되었습니다(ahead=${ahead}, behind=${behind}).`,
    };
  }
  if (behind > 0) {
    return {
      ok: false,
      code: "REMOTE_AHEAD",
      reason: `remote(${remoteName}/${branch})가 local보다 앞서 있습니다(behind=${behind}) — local이 stale합니다.`,
    };
  }
  return {
    ok: false,
    code: "LOCAL_AHEAD_UNEXPECTED",
    reason: `local이 remote(${remoteName}/${branch})보다 앞서 있습니다(ahead=${ahead}) — 예상치 못한 미푸시 commit이 있습니다.`,
  };
}

/**
 * checkpoint/push 직전에 다시 호출한다(§ 요구사항 5) — run 시작 시점 snapshot 이후 remote가
 * 바뀌었는지 fetch로 재확인한다. 바뀌었으면 REMOTE_CHANGED_DURING_RUN — 호출부는 이 결과를
 * 받으면 commit/push를 진행하지 않고 기존 working changes를 그대로 보존해야 한다(이 함수
 * 자체는 어떤 git 상태도 바꾸지 않는다).
 */
export function checkRemoteUnchangedSince(cwd: string, snapshot: RemoteGitSnapshot): RemoteChangedCheckResult {
  const fetch = safeFetchRemote(cwd, snapshot.remoteName);
  if (!fetch.ok) {
    return { ok: false, code: "REMOTE_FETCH_FAILED", reason: fetch.reason ?? "git fetch 실패" };
  }
  const currentRemoteHead = getRemoteBranchHead(cwd, snapshot.remoteName, snapshot.branch);
  if (currentRemoteHead === undefined) {
    return {
      ok: false,
      code: "MALFORMED_GIT_OUTPUT",
      reason: `remote-tracking ref(refs/remotes/${snapshot.remoteName}/${snapshot.branch})를 확인할 수 없습니다.`,
    };
  }
  if (currentRemoteHead !== snapshot.remoteHeadAtStart) {
    return {
      ok: false,
      code: "REMOTE_CHANGED_DURING_RUN",
      reason: `remote(${snapshot.remoteName}/${snapshot.branch})가 이 run 시작 이후 변경되었습니다.`,
      currentRemoteHead,
    };
  }
  return { ok: true };
}

// export하는 이유 — remote-git-safety-tests.ts가 실제 git(temp bare origin + 2 clone)이
// non-fast-forward push를 거부할 때 내는 실제 stderr를 이 패턴으로 직접 재검증한다(이
// 분류 로직 자체가 옳은지, 회귀 테스트 안에서 정규식을 복제하지 않고 단일 출처로 검증하기
// 위함 — safe-executor.ts의 DENY_PATH_PATTERNS export와 동일한 관례).
export const NON_FAST_FORWARD_STDERR_PATTERNS: RegExp[] = [/non-fast-forward/i, /\[rejected\]/i, /fetch first/i, /behind its remote/i];

/**
 * 일반 fast-forward push만 허용한다 — force/force-with-lease 옵션은 코드상 아예 없다(§
 * 요구사항 6). 순서: 1) checkRemoteUnchangedSince로 remote가 이 run 동안 바뀌지 않았는지
 * 재확인 2) local HEAD가 실제로 snapshot 이후 새 commit을 만들었는지 확인(안 그러면 push할
 * 것이 없음) 3) `git push <remote> HEAD:refs/heads/<branch>`(refspec 고정, force 없음 — git
 * 기본 동작이 non-fast-forward를 스스로 거부한다) 4) 거부되면(다른 프로세스가 그 사이
 * push한 race 포함) REMOTE_PUSH_REJECTED로 정직하게 반환하고 어떤 rebase/merge/force도
 * 자동 시도하지 않는다 — local commit은 그대로 보존된다(push 실패가 commit을 되돌리지
 * 않는다).
 */
export function performSafePush(cwd: string, snapshot: RemoteGitSnapshot): SafePushResult {
  const changed = checkRemoteUnchangedSince(cwd, snapshot);
  if (!changed.ok) {
    return { ok: false, code: changed.code, reason: changed.reason };
  }

  const localHead = getCurrentHeadHash(cwd);
  if (localHead === undefined || !isValidHash(localHead)) {
    return { ok: false, code: "MALFORMED_GIT_OUTPUT", reason: "local HEAD commit hash를 확인할 수 없습니다." };
  }
  if (localHead === snapshot.remoteHeadAtStart) {
    return { ok: false, code: "NOTHING_TO_PUSH", reason: "local에 remote로 push할 새 commit이 없습니다." };
  }

  const pushRes = runGit(["push", "--", snapshot.remoteName, `HEAD:refs/heads/${snapshot.branch}`], cwd, 30_000);
  if (!pushRes.ok) {
    const rejected = NON_FAST_FORWARD_STDERR_PATTERNS.some((p) => p.test(pushRes.stderr));
    return {
      ok: false,
      code: rejected ? "REMOTE_PUSH_REJECTED" : "PUSH_FAILED",
      reason: rejected
        ? `push가 non-fast-forward로 거부되었습니다 — remote가 그 사이 변경된 것으로 보입니다(force push를 시도하지 않습니다).`
        : `git push 실패: ${pushRes.stderr.slice(0, 500) || "알 수 없는 오류"}`,
    };
  }

  return { ok: true, pushedHead: localHead };
}
