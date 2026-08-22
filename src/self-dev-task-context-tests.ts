import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  readSelfDevTaskContext,
  writeSelfDevTaskContext,
  clearSelfDevTaskContext,
  isTaskContextError,
  selfDevTaskContextPath,
} from "./self-dev-task-context";

// self-dev-task-context.ts 테스트 — Phase G Task G7.3.1b. 실제 격리된 임시 git fixture
// repo에서 실제 git으로 검증한다(다른 테스트 파일들의 관례와 동일). Telegram/Claude/GPT
// 호출 없음.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeGitRepo(prefix: string, opts: { commit?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "sdtc-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "SDTC Test"], { cwd: dir });
  if (opts.commit !== false) {
    writeFileSync(join(dir, "README.md"), "fixture\n");
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  }
  return dir;
}

function headHashOf(dir: string): string {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" });
  return res.stdout.trim();
}

function commitMore(dir: string, name: string): void {
  writeFileSync(join(dir, name), "more\n");
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", name], { cwd: dir });
}

// ---------------------------------------------------------------------------
// 1) 선언되지 않은 저장소 → undefined("아직 선언 안 됨" — 에러 아님)
// ---------------------------------------------------------------------------
function scenarioNoContextIsUndefined(): void {
  const dir = makeGitRepo("sdtc-none-");
  const result = readSelfDevTaskContext(dir);
  check("1) context 파일이 없으면 undefined를 반환한다(에러 아님)", result === undefined);
}

// ---------------------------------------------------------------------------
// 2) 잘못된 taskId → write가 즉시 실패, 파일 생성 안 됨
// ---------------------------------------------------------------------------
function scenarioInvalidTaskIdFailsClosed(): void {
  const dir = makeGitRepo("sdtc-bad-taskid-");
  const badIds = ["", "-leading-dash", "has space", "a".repeat(65)];
  for (const id of badIds) {
    const result = writeSelfDevTaskContext(dir, { taskId: id, pushRequired: true });
    check(`2) taskId="${id.slice(0, 20)}" → write 실패(fail-closed)`, isTaskContextError(result));
  }
  check("2) 잘못된 taskId로는 파일이 생성되지 않는다", !existsSync(selfDevTaskContextPath(dir)));
}

// ---------------------------------------------------------------------------
// 3) commit이 없는 저장소 → HEAD를 확인할 수 없어 write 실패
// ---------------------------------------------------------------------------
function scenarioNoCommitYetFailsClosed(): void {
  const dir = makeGitRepo("sdtc-no-commit-", { commit: false });
  const result = writeSelfDevTaskContext(dir, { taskId: "G7.3.1b", pushRequired: true });
  check("3) commit이 없는 저장소 → write 실패(HEAD 확인 불가)", isTaskContextError(result));
}

// ---------------------------------------------------------------------------
// 4) 정상 write → read로 그대로 조회됨, baseHeadHash가 실제 HEAD와 일치
// ---------------------------------------------------------------------------
function scenarioWriteThenReadRoundTrip(): void {
  const dir = makeGitRepo("sdtc-roundtrip-");
  const head = headHashOf(dir);
  const written = writeSelfDevTaskContext(dir, { taskId: "G7.3.1b", pushRequired: true });
  check("4) write 성공", !isTaskContextError(written));
  if (isTaskContextError(written)) return;
  check("4) write된 baseHeadHash가 실제 HEAD와 일치", written.baseHeadHash === head);
  check("4) write된 taskId/pushRequired가 입력과 일치", written.taskId === "G7.3.1b" && written.pushRequired === true);

  const read = readSelfDevTaskContext(dir);
  check("4) read가 write와 동일한 값을 반환한다(round trip)", !isTaskContextError(read) && !!read && read.taskId === "G7.3.1b" && read.baseHeadHash === head);
}

// ---------------------------------------------------------------------------
// 5) 손상된 JSON → read 실패(구체적 에러)
// ---------------------------------------------------------------------------
function scenarioCorruptedJsonFailsClosed(): void {
  const dir = makeGitRepo("sdtc-corrupt-");
  const path = selfDevTaskContextPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "{ not valid json", "utf-8");

  const result = readSelfDevTaskContext(dir);
  check("5) 손상된 JSON → read 실패(fail-closed)", isTaskContextError(result));
}

// ---------------------------------------------------------------------------
// 6) 필수 필드 누락 → read 실패
// ---------------------------------------------------------------------------
function scenarioMissingFieldFailsClosed(): void {
  const dir = makeGitRepo("sdtc-missing-field-");
  const path = selfDevTaskContextPath(dir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ taskId: "G7.3.1b" }), "utf-8"); // pushRequired/baseHeadHash/declaredAt 없음

  const result = readSelfDevTaskContext(dir);
  check("6) 필수 필드 누락(pushRequired 등) → read 실패(fail-closed)", isTaskContextError(result));
}

// ---------------------------------------------------------------------------
// 7) clear → 파일 삭제됨, 이후 read는 undefined
// ---------------------------------------------------------------------------
function scenarioClearRemovesContext(): void {
  const dir = makeGitRepo("sdtc-clear-");
  writeSelfDevTaskContext(dir, { taskId: "G7.3.1b", pushRequired: false });
  check("7) clear 전에는 파일이 존재한다", existsSync(selfDevTaskContextPath(dir)));
  clearSelfDevTaskContext(dir);
  check("7) clear 후 파일이 삭제된다", !existsSync(selfDevTaskContextPath(dir)));
  check("7) clear 후 read는 undefined를 반환한다", readSelfDevTaskContext(dir) === undefined);
}

// ---------------------------------------------------------------------------
// 8) 파일이 없는 상태에서 clear를 호출해도 예외를 던지지 않는다
// ---------------------------------------------------------------------------
function scenarioClearWithoutContextDoesNotThrow(): void {
  const dir = makeGitRepo("sdtc-clear-noop-");
  let threw = false;
  try {
    clearSelfDevTaskContext(dir);
  } catch {
    threw = true;
  }
  check("8) context가 없는 상태에서 clear() → 예외 없음", !threw);
}

// ---------------------------------------------------------------------------
// 9) 새 commit 이후 재선언 → baseHeadHash가 갱신된다(덮어쓰기)
// ---------------------------------------------------------------------------
function scenarioRedeclareAfterNewCommitUpdatesBaseline(): void {
  const dir = makeGitRepo("sdtc-redeclare-");
  const first = writeSelfDevTaskContext(dir, { taskId: "G7.3.1b", pushRequired: true });
  check("9) 최초 write 성공", !isTaskContextError(first));
  if (isTaskContextError(first)) return;

  commitMore(dir, "extra.txt");
  const newHead = headHashOf(dir);
  check("9) 새 commit 이후 HEAD가 baseline과 달라짐", newHead !== first.baseHeadHash);

  const second = writeSelfDevTaskContext(dir, { taskId: "G7.3.2", pushRequired: false });
  check("9) 재선언 성공", !isTaskContextError(second));
  if (isTaskContextError(second)) return;
  check("9) 재선언된 baseHeadHash가 새 HEAD와 일치한다", second.baseHeadHash === newHead);
  check("9) 재선언된 taskId가 새 값으로 덮어써진다", second.taskId === "G7.3.2");
}

function main(): void {
  scenarioNoContextIsUndefined();
  scenarioInvalidTaskIdFailsClosed();
  scenarioNoCommitYetFailsClosed();
  scenarioWriteThenReadRoundTrip();
  scenarioCorruptedJsonFailsClosed();
  scenarioMissingFieldFailsClosed();
  scenarioClearRemovesContext();
  scenarioClearWithoutContextDoesNotThrow();
  scenarioRedeclareAfterNewCommitUpdatesBaseline();

  console.log("\n=== self-dev-task-context.ts(G7.3.1b) 테스트 결과 ===");
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
