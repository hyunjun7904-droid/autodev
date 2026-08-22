import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  checkRemoteSafeToStart,
  checkRemoteUnchangedSince,
  performSafePush,
  safeFetchRemote,
  hasRemote,
  NON_FAST_FORWARD_STDERR_PATTERNS,
} from "./remote-git-safety";
import type { RemoteGitSnapshot } from "./remote-git-safety";

// Remote Git Safety 테스트 — Phase G Task G7.3. 실제 GitHub remote는 절대 건드리지 않는다 —
// 매 시나리오마다 OS 임시 디렉터리에 temp bare repo를 origin으로 만들고, 그 origin을 가리키는
// temp clone(들)만으로 실제 git 동작(fetch/rev-parse/push)을 검증한다(§ checkpoint-tests.ts/
// project-lock-integration-tests.ts와 동일한 "실제 격리된 임시 git repo" 관례 — mock 없음).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(args: string[], cwd: string): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd, encoding: "utf-8" });
  return { ok: res.status === 0, stdout: (res.stdout || "").trim(), stderr: (res.stderr || "").trim() };
}

function makeBareOrigin(): string {
  const dir = makeTempDir("rgs-origin-");
  git(["init", "-q", "--bare", "--initial-branch=main"], dir);
  return dir;
}

function cloneRepo(originPath: string, prefix: string): string {
  const parent = makeTempDir(prefix);
  const dir = join(parent, "repo");
  git(["clone", "-q", originPath, dir], parent);
  git(["config", "user.email", "rgs-test@example.com"], dir);
  git(["config", "user.name", "RGS Test"], dir);
  return dir;
}

function commitFile(dir: string, relPath: string, content: string, message: string): void {
  writeFileSync(join(dir, relPath), content, "utf-8");
  git(["add", "--", relPath], dir);
  git(["commit", "-q", "-m", message], dir);
}

function headHash(dir: string): string {
  return git(["rev-parse", "HEAD"], dir).stdout;
}

function remoteMainHash(originPath: string): string {
  return git(["rev-parse", "refs/heads/main"], originPath).stdout;
}

/** 실제로 sync된 origin(bare) + clone A/B 3자 구도를 만든다(§ 요구사항 16 — temp bare origin
 *  + clone A + clone B로 실제 git concurrency scenario를 검증). */
function makeSyncedTriplet(): { origin: string; cloneA: string; cloneB: string } {
  const origin = makeBareOrigin();
  const seed = cloneRepo(origin, "rgs-seed-");
  commitFile(seed, "README.md", "seed\n", "init");
  git(["push", "-q", "-u", "origin", "HEAD:refs/heads/main"], seed);
  const cloneA = cloneRepo(origin, "rgs-cloneA-");
  const cloneB = cloneRepo(origin, "rgs-cloneB-");
  return { origin, cloneA, cloneB };
}

// ---------------------------------------------------------------------------
// 1) local == origin → SAFE, snapshot이 실제 값을 정확히 담는다
// ---------------------------------------------------------------------------
function scenarioSafeExactSync(): void {
  const { origin, cloneA } = makeSyncedTriplet();
  const result = checkRemoteSafeToStart(cloneA);
  check("1) local==origin → ok:true", result.ok === true);
  if (result.ok) {
    check("1.1) snapshot.remoteName === origin", result.snapshot.remoteName === "origin");
    check("1.2) snapshot.branch === main", result.snapshot.branch === "main");
    check("1.3) snapshot.localHeadAtStart === 실제 local HEAD", result.snapshot.localHeadAtStart === headHash(cloneA));
    check("1.4) snapshot.remoteHeadAtStart === 실제 origin main HEAD", result.snapshot.remoteHeadAtStart === remoteMainHash(origin));
  }
  const withExpectedBranch = checkRemoteSafeToStart(cloneA, { expectedBranch: "main" });
  check("2) expectedBranch가 실제 branch와 일치 → ok:true", withExpectedBranch.ok === true);
}

// ---------------------------------------------------------------------------
// 2) NO_REMOTE — remote가 아예 없는 일반 git repo
// ---------------------------------------------------------------------------
function scenarioNoRemote(): void {
  const dir = makeTempDir("rgs-no-remote-");
  git(["init", "-q", "--initial-branch=main"], dir);
  git(["config", "user.email", "rgs-test@example.com"], dir);
  git(["config", "user.name", "RGS Test"], dir);
  commitFile(dir, "a.txt", "a\n", "init");
  const result = checkRemoteSafeToStart(dir);
  check("3) remote 없음 → ok:false, code=NO_REMOTE", !result.ok && result.code === "NO_REMOTE");
  check("4) hasRemote()도 false를 반환한다", hasRemote(dir) === false);
}

// ---------------------------------------------------------------------------
// 3) NO_UPSTREAM — remote는 있지만 현재 branch에 upstream이 없음
// ---------------------------------------------------------------------------
function scenarioNoUpstream(): void {
  const { cloneA } = makeSyncedTriplet();
  git(["checkout", "-q", "-b", "feature-no-upstream"], cloneA);
  const result = checkRemoteSafeToStart(cloneA);
  check("5) upstream 없는 새 branch → ok:false, code=NO_UPSTREAM", !result.ok && result.code === "NO_UPSTREAM");
}

// ---------------------------------------------------------------------------
// 4) DETACHED_HEAD
// ---------------------------------------------------------------------------
function scenarioDetachedHead(): void {
  const { cloneA } = makeSyncedTriplet();
  const hash = headHash(cloneA);
  git(["checkout", "-q", hash], cloneA);
  const result = checkRemoteSafeToStart(cloneA);
  check("6) detached HEAD → ok:false, code=DETACHED_HEAD", !result.ok && result.code === "DETACHED_HEAD");
}

// ---------------------------------------------------------------------------
// 5) UNEXPECTED_BRANCH — expectedBranch가 현재 branch와 다름
// ---------------------------------------------------------------------------
function scenarioUnexpectedBranch(): void {
  const { cloneA } = makeSyncedTriplet();
  const result = checkRemoteSafeToStart(cloneA, { expectedBranch: "release" });
  check("7) expectedBranch 불일치 → ok:false, code=UNEXPECTED_BRANCH", !result.ok && result.code === "UNEXPECTED_BRANCH");
}

// ---------------------------------------------------------------------------
// 6) REMOTE_AHEAD — 다른 clone이 push해서 remote가 local보다 앞섬(local이 stale)
// ---------------------------------------------------------------------------
function scenarioRemoteAhead(): void {
  const { cloneA, cloneB } = makeSyncedTriplet();
  commitFile(cloneB, "b.txt", "b\n", "cloneB commit");
  git(["push", "-q", "origin", "HEAD:refs/heads/main"], cloneB);
  // cloneA는 아직 fetch하지 않았다 — checkRemoteSafeToStart 내부의 safeFetchRemote가
  // 그 사실을 스스로 발견해야 한다.
  const result = checkRemoteSafeToStart(cloneA);
  check("8) remote가 local보다 앞섬 → ok:false, code=REMOTE_AHEAD", !result.ok && result.code === "REMOTE_AHEAD");
}

// ---------------------------------------------------------------------------
// 7) LOCAL_AHEAD_UNEXPECTED — local에 미푸시 commit이 있음
// ---------------------------------------------------------------------------
function scenarioLocalAheadUnexpected(): void {
  const { cloneA } = makeSyncedTriplet();
  commitFile(cloneA, "local-only.txt", "x\n", "local unpushed commit");
  const result = checkRemoteSafeToStart(cloneA);
  check("9) local이 remote보다 앞섬(미푸시 commit) → ok:false, code=LOCAL_AHEAD_UNEXPECTED", !result.ok && result.code === "LOCAL_AHEAD_UNEXPECTED");
}

// ---------------------------------------------------------------------------
// 8) DIVERGED — local과 remote 둘 다 서로 모르는 commit이 있음
// ---------------------------------------------------------------------------
function scenarioDiverged(): void {
  const { cloneA, cloneB } = makeSyncedTriplet();
  commitFile(cloneA, "a-only.txt", "a\n", "cloneA local commit");
  commitFile(cloneB, "b-only.txt", "b\n", "cloneB commit");
  git(["push", "-q", "origin", "HEAD:refs/heads/main"], cloneB);
  const result = checkRemoteSafeToStart(cloneA);
  check("10) local/remote 둘 다 앞섬 → ok:false, code=DIVERGED", !result.ok && result.code === "DIVERGED");
}

// ---------------------------------------------------------------------------
// 9) REMOTE_FETCH_FAILED — origin 자체가 사라짐(네트워크 장애를 흉내)
// ---------------------------------------------------------------------------
function scenarioFetchFailed(): void {
  const { origin, cloneA } = makeSyncedTriplet();
  rmSync(origin, { recursive: true, force: true });
  const result = checkRemoteSafeToStart(cloneA);
  check("11) origin이 사라짐(fetch 실패) → ok:false, code=REMOTE_FETCH_FAILED", !result.ok && result.code === "REMOTE_FETCH_FAILED");
  const fetch = safeFetchRemote(cloneA);
  check("12) safeFetchRemote() 자체도 ok:false를 반환한다", fetch.ok === false && typeof fetch.reason === "string");
}

// ---------------------------------------------------------------------------
// 10) fetch가 working tree를 건드리지 않는다(read/update-only)
// ---------------------------------------------------------------------------
function scenarioFetchDoesNotTouchWorkingTree(): void {
  const { cloneA, cloneB } = makeSyncedTriplet();
  writeFileSync(join(cloneA, "README.md"), "local uncommitted change\n", "utf-8");
  commitFile(cloneB, "b.txt", "b\n", "cloneB commit");
  git(["push", "-q", "origin", "HEAD:refs/heads/main"], cloneB);
  checkRemoteSafeToStart(cloneA); // BLOCK(REMOTE_AHEAD)이 나더라도 fetch 자체는 이미 실행된다.
  const content = readFileSync(join(cloneA, "README.md"), "utf-8");
  check("13) fetch 이후에도 로컬 uncommitted 변경이 그대로 보존된다(reset/checkout 없음)", content === "local uncommitted change\n");
  const status = git(["status", "--porcelain"], cloneA);
  check("14) working tree가 여전히 dirty로 보고된다(fetch가 index/working tree를 건드리지 않음)", status.stdout.includes("README.md"));
}

// ---------------------------------------------------------------------------
// 11) checkRemoteUnchangedSince — run 시작 이후 remote가 안 바뀜/바뀜
// ---------------------------------------------------------------------------
function scenarioUnchangedSince(): void {
  const { cloneA } = makeSyncedTriplet();
  const started = checkRemoteSafeToStart(cloneA);
  if (!started.ok) throw new Error("fixture 시나리오 자체가 실패했습니다(테스트 버그).");
  const unchanged = checkRemoteUnchangedSince(cloneA, started.snapshot);
  check("15) 아무 것도 안 바뀌었으면 ok:true", unchanged.ok === true);
}

function scenarioChangedDuringRun(): void {
  const { origin, cloneA, cloneB } = makeSyncedTriplet();
  const started = checkRemoteSafeToStart(cloneA);
  if (!started.ok) throw new Error("fixture 시나리오 자체가 실패했습니다(테스트 버그).");
  const snapshot = started.snapshot;

  // A가 작업하는 "동안" B가 origin에 새 commit을 push한다(§ 요구사항 16 concurrency scenario).
  commitFile(cloneB, "concurrent.txt", "c\n", "cloneB concurrent push");
  git(["push", "-q", "origin", "HEAD:refs/heads/main"], cloneB);

  const recheck = checkRemoteUnchangedSince(cloneA, snapshot);
  check("16) run 도중 remote가 바뀜 → ok:false, code=REMOTE_CHANGED_DURING_RUN", !recheck.ok && recheck.code === "REMOTE_CHANGED_DURING_RUN");
  if (!recheck.ok) {
    check("17) currentRemoteHead가 실제 새 origin HEAD와 일치", recheck.currentRemoteHead === remoteMainHash(origin));
  }
}

// ---------------------------------------------------------------------------
// 12) performSafePush — 정상 성공/nothing-to-push/remote 변경으로 차단/실제 non-ff 거부
// ---------------------------------------------------------------------------
function scenarioPushSuccess(): void {
  const { origin, cloneA } = makeSyncedTriplet();
  const started = checkRemoteSafeToStart(cloneA);
  if (!started.ok) throw new Error("fixture 시나리오 자체가 실패했습니다(테스트 버그).");
  commitFile(cloneA, "new-file.txt", "new\n", "cloneA new commit");
  const newHead = headHash(cloneA);
  const pushResult = performSafePush(cloneA, started.snapshot);
  check("18) 정상 fast-forward push → ok:true", pushResult.ok === true);
  if (pushResult.ok) {
    check("19) pushedHead === local HEAD", pushResult.pushedHead === newHead);
  }
  check("20) origin main이 실제로 그 commit을 갖게 됨", remoteMainHash(origin) === newHead);
}

function scenarioPushNothingToPush(): void {
  const { cloneA } = makeSyncedTriplet();
  const started = checkRemoteSafeToStart(cloneA);
  if (!started.ok) throw new Error("fixture 시나리오 자체가 실패했습니다(테스트 버그).");
  const pushResult = performSafePush(cloneA, started.snapshot);
  check("21) 새 local commit이 없으면 → ok:false, code=NOTHING_TO_PUSH", !pushResult.ok && pushResult.code === "NOTHING_TO_PUSH");
}

function scenarioPushBlockedByRemoteChanged(): void {
  const { origin, cloneA, cloneB } = makeSyncedTriplet();
  const started = checkRemoteSafeToStart(cloneA);
  if (!started.ok) throw new Error("fixture 시나리오 자체가 실패했습니다(테스트 버그).");
  const snapshot = started.snapshot;

  commitFile(cloneA, "a-work.txt", "work\n", "cloneA work-in-progress commit");
  // B가 그 사이 origin에 push해버린다(race) — A는 여전히 예전 snapshot을 들고 push를 시도한다.
  commitFile(cloneB, "b-race.txt", "race\n", "cloneB races ahead");
  git(["push", "-q", "origin", "HEAD:refs/heads/main"], cloneB);
  const beforePushRemoteHead = remoteMainHash(origin);

  const localHeadBeforePush = headHash(cloneA);
  const pushResult = performSafePush(cloneA, snapshot);
  check("22) remote가 그 사이 바뀜 → push 시도 자체를 하지 않고 ok:false, code=REMOTE_CHANGED_DURING_RUN", !pushResult.ok && pushResult.code === "REMOTE_CHANGED_DURING_RUN");
  check("23) origin main HEAD가 A의 push 시도로 바뀌지 않았다(push가 실제로 전송되지 않음)", remoteMainHash(origin) === beforePushRemoteHead);
  check(
    "24) A의 local commit(work-in-progress)은 reset/되돌림 없이 그대로 보존된다",
    headHash(cloneA) === localHeadBeforePush && git(["log", "--oneline", "-1"], cloneA).stdout.includes("work-in-progress")
  );
}

/** 실제 git이 non-fast-forward push를 거부할 때 내는 stderr가 우리 분류 정규식과 실제로
 *  매칭되는지 직접 검증한다(§ 요구사항 19 — push race/non-fast-forward reject 안전 처리의
 *  핵심 위험은 "우리 분류가 실제 git 메시지를 놓치는 것"이다). performSafePush는 push
 *  직전에 항상 먼저 재확인하므로 이 정확한 race를 API를 통해 재현할 수는 없다 — 대신 실제
 *  git push 자체를 직접 호출해 그 결과가 우리 export된 패턴과 일치하는지 확인한다. */
function scenarioRealGitRejectsNonFastForward(): void {
  const { cloneA, cloneB } = makeSyncedTriplet();
  commitFile(cloneB, "b-ahead.txt", "b\n", "cloneB pushes ahead");
  git(["push", "-q", "origin", "HEAD:refs/heads/main"], cloneB);
  // cloneA는 fetch하지 않은 채(stale 상태) 직접 push를 시도한다.
  const res = spawnSync("git", ["push", "origin", "HEAD:refs/heads/main"], { cwd: cloneA, encoding: "utf-8" });
  check("25) stale local이 직접 push를 시도하면 실제로 거부된다(exit != 0)", res.status !== 0);
  const stderr = res.stderr || "";
  check(
    "26) 실제 git의 거부 메시지가 NON_FAST_FORWARD_STDERR_PATTERNS 중 하나와 매칭된다",
    NON_FAST_FORWARD_STDERR_PATTERNS.some((p) => p.test(stderr))
  );
}

// ---------------------------------------------------------------------------
// 13) remote URL/local 경로 원문이 결과 어디에도 노출되지 않는다
// ---------------------------------------------------------------------------
function scenarioNoCredentialLeak(): void {
  const { origin, cloneA, cloneB } = makeSyncedTriplet();
  const started = checkRemoteSafeToStart(cloneA);
  commitFile(cloneB, "leak-check.txt", "x\n", "cloneB push");
  git(["push", "-q", "origin", "HEAD:refs/heads/main"], cloneB);
  const changed = started.ok ? checkRemoteUnchangedSince(cloneA, started.snapshot) : undefined;

  const haystacks: string[] = [];
  if (started.ok) haystacks.push(JSON.stringify(started.snapshot));
  else haystacks.push(started.reason);
  if (changed && !changed.ok) haystacks.push(changed.reason);

  const leaked = haystacks.some((h) => h.includes(origin));
  check("27) snapshot/사유 문자열 어디에도 origin의 실제 파일시스템 경로가 노출되지 않는다", !leaked);
}

function main(): void {
  scenarioSafeExactSync();
  scenarioNoRemote();
  scenarioNoUpstream();
  scenarioDetachedHead();
  scenarioUnexpectedBranch();
  scenarioRemoteAhead();
  scenarioLocalAheadUnexpected();
  scenarioDiverged();
  scenarioFetchFailed();
  scenarioFetchDoesNotTouchWorkingTree();
  scenarioUnchangedSince();
  scenarioChangedDuringRun();
  scenarioPushSuccess();
  scenarioPushNothingToPush();
  scenarioPushBlockedByRemoteChanged();
  scenarioRealGitRejectsNonFastForward();
  scenarioNoCredentialLeak();

  console.log("\n=== remote-git-safety 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);

  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // OS 임시 디렉터리 — 정리 실패는 테스트 결과에 영향 없음.
    }
  }

  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
