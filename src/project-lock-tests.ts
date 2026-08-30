import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  acquireProjectLock,
  releaseProjectLock,
  peekProjectLock,
  resolveCanonicalProjectPath,
  assessOwnerLiveness,
  inspectProjectRuntimeLiveness,
  PROJECT_LOCK_SCHEMA_VERSION,
} from "./project-lock";
import type { ProjectLockMetadata, LivenessVerdict } from "./project-lock";

// Project Lock 테스트 — Phase G Task G7. 실제 Claude/OpenAI/Telegram 호출은 전혀 없다.
// 서로 다른 시나리오가 서로 다른 lockDir(tmpdir)를 쓰므로 시나리오 간 간섭이 없다 —
// 실제 운용 RUNTIME_LOCK_DIR(autodev repo의 logs/locks/)는 이 파일에서 건드리지 않는다
// (그 경로에 대한 production 통합 검증은 project-lock-integration-tests.ts가 담당).

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
function makeProjectRoot(prefix: string): string {
  return makeTempDir(prefix);
}
function makeLockDir(prefix: string): string {
  return makeTempDir(prefix);
}

// ---------------------------------------------------------------------------
// 1/2 — lock 없는 project acquire 성공 + metadata 존재
// ---------------------------------------------------------------------------
function scenarioAcquireFreshSucceedsWithMetadata(): void {
  const root = makeProjectRoot("plock-fresh-");
  const lockDir = makeLockDir("plock-fresh-dir-");
  const result = acquireProjectLock({ projectId: "p1", targetProjectRoot: root, ownerKind: "autodev", runId: "r1", taskId: "T1" }, { lockDir });
  check("1) lock 없는 project acquire 성공(ok:true)", result.ok === true);
  if (!result.ok) return;
  check("2) metadata.schemaVersion 존재", result.lock.metadata.schemaVersion === PROJECT_LOCK_SCHEMA_VERSION);
  check("2) metadata.projectId/lockId/pid/ownerKind 존재", result.lock.metadata.projectId === "p1" && typeof result.lock.metadata.lockId === "string" && result.lock.metadata.pid === process.pid && result.lock.metadata.ownerKind === "autodev");
  check("2) lock 파일이 실제로 디스크에 생성됨", existsSync(result.lock.filePath));
  check(
    "31) lock metadata에 secret/원문 필드가 없음(허용된 key만 존재)",
    Object.keys(JSON.parse(readFileSync(result.lock.filePath, "utf-8"))).every((k) =>
      ["schemaVersion", "projectId", "canonicalProjectPath", "lockId", "pid", "processStartedAtMs", "lockCreatedAt", "ownerKind", "runId", "taskId"].includes(k)
    )
  );
  check("33) target project root 안에는 어떤 lock 파일도 생기지 않음(runtime lock은 target repo 밖)", readdirSync(root).length === 0);
  releaseProjectLock(result.lock);
}

// ---------------------------------------------------------------------------
// 3 — same project 두 번째 acquire 차단(다른 pid로 위장, ALIVE override)
// ---------------------------------------------------------------------------
function scenarioSecondAcquireBlockedWhileFirstAlive(): void {
  const root = makeProjectRoot("plock-second-");
  const lockDir = makeLockDir("plock-second-dir-");
  const first = acquireProjectLock({ projectId: "p1", targetProjectRoot: root, ownerKind: "autodev" }, { lockDir });
  check("first acquire 성공(사전조건)", first.ok === true);
  if (!first.ok) return;

  // 같은 프로세스가 다시 시도하면 재진입(§ 함수 docstring)으로 복구되므로, "다른 프로세스"를
  // 흉내내기 위해 pid를 강제로 다르게(9999999, 실존하지 않는 안전한 값) override한다 —
  // assessLiveness override로 ALIVE를 강제해 실제 liveness 판정과 무관하게 "차단"만 검증한다.
  const alwaysAlive = (): LivenessVerdict => ({ verdict: "ALIVE" });
  const second = acquireProjectLock(
    { projectId: "p1", targetProjectRoot: root, ownerKind: "autodev" },
    { lockDir, pid: 9_999_999, assessLiveness: alwaysAlive }
  );
  check("3) same project 두 번째 acquire는 PROJECT_ALREADY_LOCKED로 차단", !second.ok && second.code === "PROJECT_ALREADY_LOCKED");
  if (!second.ok) {
    check("3) existingOwner 정보 제공(pid=현재 first owner)", second.existingOwner?.pid === first.lock.metadata.pid);
  }
  releaseProjectLock(first.lock);
}

// ---------------------------------------------------------------------------
// 4 — different project는 동시 acquire 허용
// ---------------------------------------------------------------------------
function scenarioDifferentProjectsBothAcquire(): void {
  const rootA = makeProjectRoot("plock-diffA-");
  const rootB = makeProjectRoot("plock-diffB-");
  const lockDir = makeLockDir("plock-diff-dir-");
  const a = acquireProjectLock({ projectId: "pA", targetProjectRoot: rootA, ownerKind: "autodev" }, { lockDir });
  const b = acquireProjectLock({ projectId: "pB", targetProjectRoot: rootB, ownerKind: "autodev" }, { lockDir });
  check("4) 서로 다른 project는 둘 다 동시에 acquire 성공", a.ok === true && b.ok === true);
  if (a.ok) releaseProjectLock(a.lock);
  if (b.ok) releaseProjectLock(b.lock);
}

// ---------------------------------------------------------------------------
// 5/6 — 경로 표현/대소문자 canonicalize
// ---------------------------------------------------------------------------
function scenarioPathVariationsCanonicalizeToSameProject(): void {
  const root = makeProjectRoot("plock-canon-");
  const lockDir = makeLockDir("plock-canon-dir-");
  const dotted = join(root, ".", "sub", "..");
  const canonA = resolveCanonicalProjectPath(root);
  const canonB = resolveCanonicalProjectPath(dotted);
  check("5) `.`/`..` 다른 표현도 같은 canonical path로 정규화됨", canonA === canonB);

  const first = acquireProjectLock({ projectId: "p1", targetProjectRoot: root, ownerKind: "autodev" }, { lockDir });
  check("5) 사전조건: root로 acquire 성공", first.ok === true);
  if (!first.ok) return;
  const alwaysAlive = (): LivenessVerdict => ({ verdict: "ALIVE" });
  const second = acquireProjectLock(
    { projectId: "p1", targetProjectRoot: dotted, ownerKind: "autodev" },
    { lockDir, pid: 9_999_998, assessLiveness: alwaysAlive }
  );
  check("5) `.`/`..` 다른 표현으로 같은 project를 다시 잡으려 해도 PROJECT_ALREADY_LOCKED", !second.ok && second.code === "PROJECT_ALREADY_LOCKED");

  if (process.platform === "win32") {
    const upper = root.toUpperCase();
    const third = acquireProjectLock(
      { projectId: "p1", targetProjectRoot: upper, ownerKind: "autodev" },
      { lockDir, pid: 9_999_997, assessLiveness: alwaysAlive }
    );
    check("6) Windows 대소문자만 다른 경로도 같은 project로 판정(PROJECT_ALREADY_LOCKED)", !third.ok && third.code === "PROJECT_ALREADY_LOCKED");
  } else {
    check("6) (win32 아님 — 대소문자 검증 스킵)", true);
  }
  releaseProjectLock(first.lock);
}

// ---------------------------------------------------------------------------
// 7/8/9 — release 성공 / 다른 owner의 release 거부 / release 후 재acquire
// ---------------------------------------------------------------------------
function scenarioReleaseOwnershipAndReacquire(): void {
  const root = makeProjectRoot("plock-release-");
  const lockDir = makeLockDir("plock-release-dir-");
  const first = acquireProjectLock({ projectId: "p1", targetProjectRoot: root, ownerKind: "autodev" }, { lockDir });
  check("사전조건: acquire 성공", first.ok === true);
  if (!first.ok) return;

  const fakeHandle = { filePath: first.lock.filePath, metadata: { ...first.lock.metadata, lockId: "not-the-real-lock-id" } };
  const rejected = releaseProjectLock(fakeHandle);
  check("8) 다른 lockId로 release 시도는 거부됨", rejected.ok === false);
  check("8) 거부된 release 후에도 lock 파일이 그대로 존재", existsSync(first.lock.filePath));

  const released = releaseProjectLock(first.lock);
  check("7) 실제 owner의 release 성공", released.ok === true);
  check("7) release 후 lock 파일이 사라짐", !existsSync(first.lock.filePath));

  const reacquired = acquireProjectLock({ projectId: "p1", targetProjectRoot: root, ownerKind: "autodev" }, { lockDir });
  check("9) release 후 다시 acquire 가능", reacquired.ok === true);
  if (reacquired.ok) releaseProjectLock(reacquired.lock);
}

// ---------------------------------------------------------------------------
// 10/11/12 — malformed / unknown schema / 필수 필드 누락 lock은 fail-closed(CORRUPT_LOCK)
// ---------------------------------------------------------------------------
function scenarioCorruptLocksFailClosed(): void {
  const lockDir = makeLockDir("plock-corrupt-dir-");

  const rootMalformed = makeProjectRoot("plock-malformed-");
  const pathMalformed = join(lockDir, "will-not-match-hash.lock.json"); // 실제 경로는 acquire가 계산 — 우리는 acquire를 먼저 시도해 실제 경로를 얻는다.
  void pathMalformed;
  const probe = acquireProjectLock({ projectId: "p1", targetProjectRoot: rootMalformed, ownerKind: "autodev" }, { lockDir });
  check("사전조건: 첫 acquire 성공(실제 lock 경로 확인용)", probe.ok === true);
  if (!probe.ok) return;
  const realPath = probe.lock.filePath;
  releaseProjectLock(probe.lock);

  writeFileSync(realPath, "{ this is not valid json ", "utf-8");
  const malformedResult = acquireProjectLock({ projectId: "p1", targetProjectRoot: rootMalformed, ownerKind: "autodev" }, { lockDir });
  check("10) malformed JSON lock은 CORRUPT_LOCK으로 fail-closed", !malformedResult.ok && malformedResult.code === "CORRUPT_LOCK");
  check("10) malformed lock 파일을 자동 삭제하지 않음", existsSync(realPath) && readFileSync(realPath, "utf-8").includes("not valid json"));

  const unknownSchemaMeta = { ...validMetadataFixture(rootMalformed), schemaVersion: 999 };
  writeFileSync(realPath, JSON.stringify(unknownSchemaMeta), "utf-8");
  const unknownSchemaResult = acquireProjectLock({ projectId: "p1", targetProjectRoot: rootMalformed, ownerKind: "autodev" }, { lockDir });
  check("11) unknown schemaVersion은 CORRUPT_LOCK으로 fail-closed", !unknownSchemaResult.ok && unknownSchemaResult.code === "CORRUPT_LOCK");

  const missingFieldMeta: Partial<ProjectLockMetadata> = { ...validMetadataFixture(rootMalformed) };
  delete missingFieldMeta.pid;
  writeFileSync(realPath, JSON.stringify(missingFieldMeta), "utf-8");
  const missingFieldResult = acquireProjectLock({ projectId: "p1", targetProjectRoot: rootMalformed, ownerKind: "autodev" }, { lockDir });
  check("12) 필수 metadata(pid) 누락은 CORRUPT_LOCK으로 fail-closed", !missingFieldResult.ok && missingFieldResult.code === "CORRUPT_LOCK");

  // 정리 — 다음 시나리오에 영향 주지 않도록 수동으로 지운다(releaseProjectLock은 lockId
  // 불일치로 거부하므로 직접 지운다).
  try {
    rmSync(realPath, { force: true });
  } catch {
    /* 정리 실패는 테스트 결과에 영향 없음 */
  }
}

function validMetadataFixture(root: string): ProjectLockMetadata {
  return {
    schemaVersion: PROJECT_LOCK_SCHEMA_VERSION,
    projectId: "p1",
    canonicalProjectPath: resolveCanonicalProjectPath(root),
    lockId: "fixture-lock-id",
    pid: 123456,
    processStartedAtMs: Date.now(),
    lockCreatedAt: new Date().toISOString(),
    ownerKind: "autodev",
  };
}

// ---------------------------------------------------------------------------
// 13/14/15/16/17 — 실제 liveness(살아있는/죽은 real child process pid) + override 기반 검증
// ---------------------------------------------------------------------------
function scenarioRealLivenessAssessment(): void {
  // 실제로 죽은 pid — spawnSync는 child가 종료된 뒤에야 반환하므로, 반환된 pid는 이 시점에
  // 확실히 죽어있다(PID가 그 사이 재사용될 확률은 사실상 0에 가깝다).
  const deadChild = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const deadPid = deadChild.pid;
  if (typeof deadPid === "number") {
    const verdict = assessOwnerLiveness(deadPid, Date.now());
    check("14) 실제로 종료된 pid는 STALE(PID_NOT_RUNNING)로 판정", verdict.verdict === "STALE" && verdict.evidence === "PID_NOT_RUNNING");
  } else {
    check("14) (죽은 child pid를 얻지 못해 스킵)", true);
  }

  // 실제로 살아있는 pid — 이 테스트 프로세스 자신을 alive 대상으로 쓴다(자기 자신이므로
  // 100% 살아있음이 보장된다). processStartedAtMs는 자기 자신의 실제 uptime 기반 추정값을
  // 그대로 쓴다.
  const selfStartedAtMs = Date.now() - Math.round(process.uptime() * 1000);
  const selfVerdict = assessOwnerLiveness(process.pid, selfStartedAtMs);
  check("13) 실제로 살아있는 pid(+정확한 시작시각)는 ALIVE로 판정", selfVerdict.verdict === "ALIVE");

  // 15 — stale이 증명됐을 때만 acquireProjectLock이 실제로 recover한다(정확히 실제 죽은
  // pid를 lock에 기록해두고 검증).
  if (typeof deadPid === "number") {
    const root = makeProjectRoot("plock-stale-recover-");
    const lockDir = makeLockDir("plock-stale-recover-dir-");
    const staleMeta: ProjectLockMetadata = {
      schemaVersion: PROJECT_LOCK_SCHEMA_VERSION,
      projectId: "p1",
      canonicalProjectPath: resolveCanonicalProjectPath(root),
      lockId: "stale-owner-lock-id",
      pid: deadPid,
      processStartedAtMs: Date.now() - 60_000,
      lockCreatedAt: new Date(Date.now() - 60_000).toISOString(),
      ownerKind: "autodev",
    };
    // acquireProjectLock을 통해서만 실제 경로를 알 수 있으므로 한 번 잡았다 놓아 경로를
    // 얻은 뒤, 그 자리에 stale metadata를 직접 심는다.
    const probe = acquireProjectLock({ projectId: "p1", targetProjectRoot: root, ownerKind: "autodev" }, { lockDir });
    if (probe.ok) {
      const filePath = probe.lock.filePath;
      releaseProjectLock(probe.lock);
      writeFileSync(filePath, JSON.stringify(staleMeta), "utf-8");
      const recovered = acquireProjectLock({ projectId: "p1", targetProjectRoot: root, ownerKind: "autodev" }, { lockDir });
      check("15) 죽은 pid로 증명된 stale lock은 자동 recovery되어 acquire 성공", recovered.ok === true);
      if (recovered.ok) {
        check("15) recoveredFromStale.evidence=PID_NOT_RUNNING로 보고됨", recovered.recoveredFromStale?.evidence === "PID_NOT_RUNNING");
        releaseProjectLock(recovered.lock);
      }
    } else {
      check("15) (probe acquire 실패로 스킵)", true);
    }
  }

  // 16 — liveness가 불확실하면(UNCERTAIN) 절대 자동 삭제하지 않는다.
  const root2 = makeProjectRoot("plock-uncertain-");
  const lockDir2 = makeLockDir("plock-uncertain-dir-");
  const alwaysUncertain = (): LivenessVerdict => ({ verdict: "UNCERTAIN", reason: "테스트 override" });
  const probe2 = acquireProjectLock({ projectId: "p1", targetProjectRoot: root2, ownerKind: "autodev" }, { lockDir: lockDir2 });
  check("사전조건: probe2 acquire 성공", probe2.ok === true);
  if (probe2.ok) {
    const filePath = probe2.lock.filePath;
    releaseProjectLock(probe2.lock);
    const fakeMeta: ProjectLockMetadata = {
      schemaVersion: PROJECT_LOCK_SCHEMA_VERSION,
      projectId: "p1",
      canonicalProjectPath: resolveCanonicalProjectPath(root2),
      lockId: "uncertain-owner-lock-id",
      pid: 8_888_888,
      processStartedAtMs: Date.now(),
      lockCreatedAt: new Date().toISOString(),
      ownerKind: "autodev",
    };
    writeFileSync(filePath, JSON.stringify(fakeMeta), "utf-8");
    const uncertainResult = acquireProjectLock(
      { projectId: "p1", targetProjectRoot: root2, ownerKind: "autodev" },
      { lockDir: lockDir2, assessLiveness: alwaysUncertain }
    );
    check("16) liveness가 불확실하면 LOCK_STATE_UNCERTAIN으로 fail-closed", !uncertainResult.ok && uncertainResult.code === "LOCK_STATE_UNCERTAIN");
    check("16) 불확실한 경우 lock 파일을 자동 삭제하지 않음(그대로 존재)", existsSync(filePath));
    try {
      rmSync(filePath, { force: true });
    } catch {
      /* 정리 실패는 테스트 결과에 영향 없음 */
    }
  }

  // 17 — PID reuse(시작 시각 불일치)로 증명되면 stale로 recovery 허용.
  const root3 = makeProjectRoot("plock-reuse-");
  const lockDir3 = makeLockDir("plock-reuse-dir-");
  const probe3 = acquireProjectLock({ projectId: "p1", targetProjectRoot: root3, ownerKind: "autodev" }, { lockDir: lockDir3 });
  check("사전조건: probe3 acquire 성공", probe3.ok === true);
  if (probe3.ok) {
    const filePath = probe3.lock.filePath;
    releaseProjectLock(probe3.lock);
    const reusedMeta: ProjectLockMetadata = {
      schemaVersion: PROJECT_LOCK_SCHEMA_VERSION,
      projectId: "p1",
      canonicalProjectPath: resolveCanonicalProjectPath(root3),
      lockId: "reused-owner-lock-id",
      pid: 7_777_777,
      processStartedAtMs: Date.now() - 500_000, // 실제 프로세스 시작시각과 크게 다름을 흉내
      lockCreatedAt: new Date(Date.now() - 500_000).toISOString(),
      ownerKind: "autodev",
    };
    writeFileSync(filePath, JSON.stringify(reusedMeta), "utf-8");
    const reuseAssessor = (): LivenessVerdict => ({ verdict: "STALE", evidence: "PID_REUSED_START_TIME_MISMATCH" });
    const reuseResult = acquireProjectLock(
      { projectId: "p1", targetProjectRoot: root3, ownerKind: "autodev" },
      { lockDir: lockDir3, assessLiveness: reuseAssessor }
    );
    check("17) PID 재사용(시작시각 불일치)이 증명되면 recovery 허용", reuseResult.ok === true);
    if (reuseResult.ok) {
      check("17) evidence=PID_REUSED_START_TIME_MISMATCH로 보고됨", reuseResult.recoveredFromStale?.evidence === "PID_REUSED_START_TIME_MISMATCH");
      releaseProjectLock(reuseResult.lock);
    }
  }
}

// ---------------------------------------------------------------------------
// P0-1 하드닝 — stale lock(X) 판정 후, 실제 삭제 직전에 다른 프로세스가 fresh lock(Y)으로
// 교체했다면 그 삭제 시도는 Y를 지우지 못해야 한다(CAS-equivalent compare-before-delete,
// § tryRemoveStaleLock). assessLiveness override의 부수효과로 "X를 stale로 판정하는 바로 그
// 순간 다른 프로세스가 X를 Y로 교체한다"는 race를 결정적으로 재현한다.
// ---------------------------------------------------------------------------
function scenarioStaleLockReplacedByFreshLockDuringRemoval(): void {
  const root = makeProjectRoot("plock-race-swap-");
  const lockDir = makeLockDir("plock-race-swap-dir-");

  const probe = acquireProjectLock({ projectId: "p1", targetProjectRoot: root, ownerKind: "autodev" }, { lockDir });
  check("P0-1 사전조건: probe acquire 성공", probe.ok === true);
  if (!probe.ok) return;
  const filePath = probe.lock.filePath;
  releaseProjectLock(probe.lock);

  const staleXMeta: ProjectLockMetadata = {
    schemaVersion: PROJECT_LOCK_SCHEMA_VERSION,
    projectId: "p1",
    canonicalProjectPath: resolveCanonicalProjectPath(root),
    lockId: "stale-X-lock-id",
    pid: 5_555_555,
    processStartedAtMs: Date.now() - 999_000,
    lockCreatedAt: new Date(Date.now() - 999_000).toISOString(),
    ownerKind: "autodev",
  };
  writeFileSync(filePath, JSON.stringify(staleXMeta), "utf-8");

  // Y(fresh, 실제로 살아있는 owner)로 바꿔치기할 metadata — 이 테스트 프로세스 자신을 owner로
  // 써서 "진짜 살아있는 lock"임을 실제로 증명 가능하게 한다.
  const freshYMeta: ProjectLockMetadata = {
    schemaVersion: PROJECT_LOCK_SCHEMA_VERSION,
    projectId: "p1",
    canonicalProjectPath: resolveCanonicalProjectPath(root),
    lockId: "fresh-Y-lock-id",
    pid: process.pid,
    processStartedAtMs: Date.now() - Math.round(process.uptime() * 1000),
    lockCreatedAt: new Date().toISOString(),
    ownerKind: "autodev",
  };

  let swapped = false;
  const raceAssessor = (pid: number): LivenessVerdict => {
    if (pid === staleXMeta.pid && !swapped) {
      // A가 "X는 죽었다"는 판정을 받는 바로 그 순간, 다른 프로세스(B)가 X를 fresh Y로
      // 교체했다고 흉내낸다 — judge-then-delete 사이의 race window.
      swapped = true;
      writeFileSync(filePath, JSON.stringify(freshYMeta), "utf-8");
      return { verdict: "STALE", evidence: "PID_NOT_RUNNING" };
    }
    if (pid === freshYMeta.pid) return { verdict: "ALIVE" };
    return { verdict: "STALE", evidence: "PID_NOT_RUNNING" };
  };

  const result = acquireProjectLock(
    { projectId: "p1", targetProjectRoot: root, ownerKind: "autodev" },
    { lockDir, pid: 4_444_444, assessLiveness: raceAssessor }
  );

  check(
    "P0-1) X를 stale로 판정한 프로세스는 삭제 직전 교체된 fresh Y를 삭제하지 못함(PROJECT_ALREADY_LOCKED)",
    !result.ok && result.code === "PROJECT_ALREADY_LOCKED"
  );
  if (!result.ok && result.code === "PROJECT_ALREADY_LOCKED") {
    check("P0-1) 최종 active owner는 여전히 Y(active writer ≤ 1 유지)", result.existingOwner?.pid === freshYMeta.pid);
  }
  check(
    "P0-1) Y의 lock 파일이 실수로 삭제되지 않고 그대로 존재",
    existsSync(filePath) && JSON.parse(readFileSync(filePath, "utf-8")).lockId === "fresh-Y-lock-id"
  );

  try {
    rmSync(filePath, { force: true });
  } catch {
    /* 정리 실패는 테스트 결과에 영향 없음 */
  }
}

// ---------------------------------------------------------------------------
// peekProjectLock — 읽기 전용 사전확인(auto-resume.ts가 쓰는 것과 동일한 함수)
// ---------------------------------------------------------------------------
function scenarioPeekProjectLock(): void {
  const root = makeProjectRoot("plock-peek-");
  const lockDir = makeLockDir("plock-peek-dir-");
  const peekBeforeAcquire = peekProjectLock("p1", root, { lockDir });
  check("peek: lock이 없으면 locked:false", peekBeforeAcquire.locked === false);

  const acquired = acquireProjectLock({ projectId: "p1", targetProjectRoot: root, ownerKind: "autodev" }, { lockDir });
  check("사전조건: acquire 성공", acquired.ok === true);
  if (!acquired.ok) return;

  const peekSameProcess = peekProjectLock("p1", root, { lockDir });
  check("peek: 같은 프로세스가 잡은 lock은 locked:false(자기 자신)", peekSameProcess.locked === false);
  releaseProjectLock(acquired.lock);

  // 다른(가짜) alive owner를 심어 peek이 locked:true를 보고하는지 확인.
  writeFileSync(
    acquired.lock.filePath,
    JSON.stringify({ ...validMetadataFixture(root), pid: 6_666_666, lockId: "other-owner" } satisfies ProjectLockMetadata),
    "utf-8"
  );
  const alwaysAlive = (): LivenessVerdict => ({ verdict: "ALIVE" });
  const peekBlocked = peekProjectLock("p1", root, { lockDir, assessLiveness: alwaysAlive });
  check("peek: 다른 살아있는 owner가 있으면 locked:true", peekBlocked.locked === true);
  try {
    rmSync(acquired.lock.filePath, { force: true });
  } catch {
    /* 정리 실패는 테스트 결과에 영향 없음 */
  }
}

// ---------------------------------------------------------------------------
// 18 — 실제 concurrency test: 실제 Node child process 2개가 동시에 같은 project lock을
// acquisition 시도한다(§ 요구사항 17) — mock이 아니라 실제 OS 프로세스 두 개.
// ---------------------------------------------------------------------------
async function scenarioRealConcurrentAcquisition(): Promise<void> {
  const root = makeProjectRoot("plock-race-");
  const lockDir = makeLockDir("plock-race-dir-");
  const workerPath = join(__dirname, "project-lock-concurrency-worker.js");
  if (!existsSync(workerPath)) {
    check("18) (컴파일된 worker 스크립트를 찾지 못해 스킵 — npm run build 필요)", true);
    return;
  }

  function runWorker(): Promise<string> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [workerPath, "p1", root, lockDir]);
      let out = "";
      child.stdout.on("data", (d) => {
        out += d.toString();
      });
      child.on("close", () => resolve(out.trim()));
    });
  }

  const [outA, outB] = await Promise.all([runWorker(), runWorker()]);
  const acquiredCount = [outA, outB].filter((o) => o === "ACQUIRED").length;
  const blockedCount = [outA, outB].filter((o) => o.startsWith("BLOCKED:")).length;
  check("18) 동시 acquire 시도 중 정확히 하나만 ACQUIRED", acquiredCount === 1);
  check("18) 나머지 하나는 PROJECT_ALREADY_LOCKED로 BLOCKED", blockedCount === 1 && (outA === "BLOCKED:PROJECT_ALREADY_LOCKED" || outB === "BLOCKED:PROJECT_ALREADY_LOCKED"));

  // 정리 — 승자가 release하지 않고 종료했으므로(worker는 acquire만 하고 끝난다) 남은 lock을
  // 직접 지운다.
  try {
    const filePath = join(lockDir, readdirSync(lockDir)[0] ?? "");
    if (readdirSync(lockDir).length > 0) rmSync(filePath, { force: true });
  } catch {
    /* 정리 실패는 테스트 결과에 영향 없음 */
  }
}

// ---------------------------------------------------------------------------
// AutoDev / JARVIS 최종 무인개발 구조 보완 — inspectProjectRuntimeLiveness(§ 요구사항 24,
// 대시보드 실행상태 보완의 근거 데이터).
// ---------------------------------------------------------------------------
function scenarioInspectRuntimeLivenessNoLock(): void {
  const root = makeProjectRoot("plock-inspect-none-");
  const lockDir = makeLockDir("plock-inspect-none-dir-");
  const result = inspectProjectRuntimeLiveness("p1", root, { lockDir });
  check("inspect: lock 파일이 없으면 present:false", result.present === false);
}

function scenarioInspectRuntimeLivenessAliveOwner(): void {
  const root = makeProjectRoot("plock-inspect-alive-");
  const lockDir = makeLockDir("plock-inspect-alive-dir-");
  const acquired = acquireProjectLock({ projectId: "p1", targetProjectRoot: root, ownerKind: "autodev", taskId: "2.2" }, { lockDir });
  check("사전조건: acquire 성공", acquired.ok === true);
  if (!acquired.ok) return;
  const alwaysAlive = (): LivenessVerdict => ({ verdict: "ALIVE" });
  const result = inspectProjectRuntimeLiveness("p1", root, { lockDir, assessLiveness: alwaysAlive });
  check("inspect: 살아있는 owner는 present:true + liveness ALIVE", result.present === true && result.liveness.verdict === "ALIVE");
  check("inspect: taskId가 그대로 노출됨", result.present === true && result.taskId === "2.2");
  releaseProjectLock(acquired.lock);
}

function scenarioInspectRuntimeLivenessStaleOwner(): void {
  const root = makeProjectRoot("plock-inspect-stale-");
  const lockDir = makeLockDir("plock-inspect-stale-dir-");
  const acquired = acquireProjectLock({ projectId: "p1", targetProjectRoot: root, ownerKind: "autodev" }, { lockDir });
  check("사전조건: acquire 성공", acquired.ok === true);
  if (!acquired.ok) return;
  const alwaysStale = (): LivenessVerdict => ({ verdict: "STALE", evidence: "PID_NOT_RUNNING" });
  const result = inspectProjectRuntimeLiveness("p1", root, { lockDir, assessLiveness: alwaysStale });
  check(
    "inspect: 죽은 owner(stale lock)는 present:true + liveness STALE — 실행 중이라고 주장하지 않음",
    result.present === true && result.liveness.verdict === "STALE"
  );
  try {
    rmSync(acquired.lock.filePath, { force: true });
  } catch {
    /* 정리 실패는 테스트 결과에 영향 없음 */
  }
}

async function main(): Promise<void> {
  scenarioAcquireFreshSucceedsWithMetadata();
  scenarioSecondAcquireBlockedWhileFirstAlive();
  scenarioDifferentProjectsBothAcquire();
  scenarioPathVariationsCanonicalizeToSameProject();
  scenarioReleaseOwnershipAndReacquire();
  scenarioCorruptLocksFailClosed();
  scenarioRealLivenessAssessment();
  scenarioStaleLockReplacedByFreshLockDuringRemoval();
  scenarioPeekProjectLock();
  scenarioInspectRuntimeLivenessNoLock();
  scenarioInspectRuntimeLivenessAliveOwner();
  scenarioInspectRuntimeLivenessStaleOwner();
  await scenarioRealConcurrentAcquisition();

  console.log("\n=== project-lock.ts(G7) 테스트 결과 ===");
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
