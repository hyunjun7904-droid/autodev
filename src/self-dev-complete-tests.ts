import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { runDeterministicCompletionChecks, listFullRegressionScripts, realCommandRunner } from "./self-dev-complete";
import type { CommandRunner, CommandOutcome } from "./self-dev-complete";
import { createInMemoryEventStore } from "./event-store";
import { validateSelfDevCompletionEvidence, isEvidenceError, recordSelfDevTaskCompleted } from "./self-dev-completion";

// Self-Dev Task Completion Bridge — 자동 경로(self-dev-complete.ts) 테스트(Phase G Task
// G7.2.1). 실제 typecheck/build/전체 회귀/Telegram/Claude/GPT 호출은 전혀 하지 않는다 —
// runDeterministicCompletionChecks()의 CommandRunner seam을 fake로 주입해 판정 로직만
// deterministic하게 검증한다(§ self-dev-complete.ts 상단 주석과 동일한 injectable pattern).
// git 자체(HEAD 조회/merge 상태 확인)는 이 파일이 실제로 만드는 격리된 임시 fixture repo에서
// 실제 git으로 검증한다(다른 테스트 파일들의 makeGitRepo 관례와 동일).

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

const DEFAULT_SCRIPTS: Record<string, string> = {
  build: "tsc",
  typecheck: "tsc --noEmit",
  "test:a": "npm run build && node dist/fixture-a-tests.js",
  "test:b": "npm run build && node dist/fixture-b-tests.js",
  "smoke-test": "npm run build && node dist/fixture-smoke.js",
};

function makeFixtureRepo(prefix: string, opts: { scripts?: Record<string, string>; distFiles?: string[]; commit?: boolean } = {}): string {
  const dir = makeTempDir(prefix);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "sdc-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "SDC Test"], { cwd: dir });
  const scripts = opts.scripts ?? DEFAULT_SCRIPTS;
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "sdc-fixture", version: "0.0.0", scripts }, null, 2));
  mkdirSync(join(dir, "dist"), { recursive: true });
  for (const f of opts.distFiles ?? ["fixture-a-tests.js", "fixture-b-tests.js"]) {
    writeFileSync(join(dir, "dist", f), "// fixture — 실제로 실행되지 않는다(runner는 항상 fake로 주입됨)\n");
  }
  if (opts.commit !== false) {
    spawnSync("git", ["add", "-A"], { cwd: dir });
    spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  }
  return dir;
}

function headHashOf(dir: string): string {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf-8" });
  return res.stdout.trim();
}

interface FakeRunnerConfig {
  typecheckOk?: boolean;
  buildOk?: boolean;
  testOkByBasename?: Record<string, boolean>;
  upstream?: { ok: boolean; hash?: string };
  /** 지정하지 않으면 항상 성공(기존 push 시나리오는 fetch 성공을 가정) — Phase G Task G7.3의
   *  fetch-then-compare 추가로 기존 upstream 시나리오(24~31)가 깨지지 않도록 별도 축으로
   *  분리했다. */
  fetchOk?: boolean;
}

function makeFakeRunner(cfg: FakeRunnerConfig, callLog?: { command: string; args: string[] }[]): CommandRunner {
  return (command, args, _cwd): CommandOutcome => {
    callLog?.push({ command, args });
    if (command === "git") {
      if (args[0] === "fetch") {
        const ok = cfg.fetchOk ?? true;
        return { ok, code: ok ? 0 : 1, stdout: "", stderr: ok ? "" : "fetch failed(fixture)" };
      }
      if (!cfg.upstream || !cfg.upstream.ok) {
        return { ok: false, code: 128, stdout: "", stderr: "fatal: no upstream configured(fixture)" };
      }
      return { ok: true, code: 0, stdout: `${cfg.upstream.hash}\n`, stderr: "" };
    }
    const base = basename(args[0] ?? "");
    if (base === "tsc" && args.includes("--noEmit")) {
      const ok = cfg.typecheckOk ?? true;
      return { ok, code: ok ? 0 : 2, stdout: "", stderr: ok ? "" : "typecheck failed(fixture)" };
    }
    if (base === "tsc") {
      const ok = cfg.buildOk ?? true;
      return { ok, code: ok ? 0 : 2, stdout: "", stderr: ok ? "" : "build failed(fixture)" };
    }
    const ok = cfg.testOkByBasename ? (cfg.testOkByBasename[base] ?? true) : true;
    return { ok, code: ok ? 0 : 1, stdout: "", stderr: ok ? "" : `${base} failed(fixture)` };
  };
}

// ---------------------------------------------------------------------------
// 0) realCommandRunner — 2026-08-22 incident 대응. 전체 회귀를 자식 프로세스로 spawn하는
//    이 함수가 AUTOMATION_DRY_RUN/AUTODEV_PRODUCTION_RUNTIME/실제 Telegram credential을
//    자식에게 물려주지 않는지 실제 spawnSync로(fake 아님) 직접 검증한다 — 자식 프로세스가
//    node -e로 자신이 물려받은 env를 그대로 출력하게 해서 확인한다.
// ---------------------------------------------------------------------------
function scenarioRealCommandRunnerSanitizesChildEnv(): void {
  const sensitiveKeys = [
    "AUTOMATION_DRY_RUN",
    "AUTODEV_PRODUCTION_RUNTIME",
    "AUTODEV_TELEGRAM_BOT_TOKEN",
    "AUTODEV_TELEGRAM_CHAT_ID",
    "AUTODEV_TELEGRAM_USER_ID",
    // AutoDev / JARVIS 지능형 오류 복구 하드닝 § 12/16 — ntfy 자격증명도 동일하게 제거돼야 한다.
    "AUTODEV_NTFY_TOPIC",
    "AUTODEV_NTFY_TOKEN",
    "AUTODEV_NTFY_BASE_URL",
  ];
  const saved: Record<string, string | undefined> = {};
  for (const k of sensitiveKeys) saved[k] = process.env[k];
  try {
    process.env.AUTOMATION_DRY_RUN = "false";
    process.env.AUTODEV_PRODUCTION_RUNTIME = "true";
    process.env.AUTODEV_TELEGRAM_BOT_TOKEN = "123456:fake-looks-real-for-test";
    process.env.AUTODEV_TELEGRAM_CHAT_ID = "999999";
    process.env.AUTODEV_TELEGRAM_USER_ID = "111111";
    process.env.AUTODEV_NTFY_TOPIC = "fake-topic-for-test";
    process.env.AUTODEV_NTFY_TOKEN = "fake-ntfy-token-for-test";
    process.env.AUTODEV_NTFY_BASE_URL = "https://ntfy.example.invalid";

    const printEnvScript = `console.log(JSON.stringify(${JSON.stringify(sensitiveKeys)}.map((k) => process.env[k] ?? null)))`;
    const result = realCommandRunner(process.execPath, ["-e", printEnvScript], process.cwd());

    check("0-1) realCommandRunner: 자식 프로세스가 정상 실행됨", result.ok === true);
    let values: (string | null)[] = [];
    try {
      values = JSON.parse(result.stdout.trim()) as (string | null)[];
    } catch {
      values = [];
    }
    check("0-2) realCommandRunner: 자식이 물려받은 민감 환경변수가 전부 null(제거됨)", values.length === sensitiveKeys.length && values.every((v) => v === null));
  } finally {
    for (const k of sensitiveKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ---------------------------------------------------------------------------
// 1) listFullRegressionScripts — package.json의 test:* 스크립트만 선택
// ---------------------------------------------------------------------------
function scenarioListFullRegressionScripts(): void {
  const dir = makeFixtureRepo("sdc-list-");
  const scripts = listFullRegressionScripts(dir);
  const names = scripts.map((s) => s.name);
  check("1) test: 접두사 스크립트만 선택된다", names.includes("test:a") && names.includes("test:b"));
  check("2) test: 접두사가 아닌 smoke-test/build/typecheck는 제외된다", !names.includes("smoke-test") && !names.includes("build") && !names.includes("typecheck"));
  check("3) name 기준 오름차순 정렬", JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b))));
  const a = scripts.find((s) => s.name === "test:a");
  check("4) distFile이 스크립트 문자열에서 정확히 추출된다", a?.distFile === "dist/fixture-a-tests.js");
}

// ---------------------------------------------------------------------------
// 2) typecheck FAIL → 완료 조건 불충족(TASK_COMPLETED 생성 금지로 이어짐)
// ---------------------------------------------------------------------------
function scenarioTypecheckFail(): void {
  const dir = makeFixtureRepo("sdc-typecheck-fail-");
  const checks = runDeterministicCompletionChecks(dir, false, makeFakeRunner({ typecheckOk: false }));
  check("5) typecheck FAIL → checks.ok=false", checks.ok === false);
  check("6) typecheck FAIL → typecheckPassed=false", checks.typecheckPassed === false);
  check("7) typecheck FAIL → reasons에 typecheck 실패 사유 포함", checks.reasons.some((r) => r.includes("typecheck")));
}

// ---------------------------------------------------------------------------
// 3) build FAIL → 전체 회귀를 실행조차 하지 않고 완료 조건 불충족
// ---------------------------------------------------------------------------
function scenarioBuildFail(): void {
  const dir = makeFixtureRepo("sdc-build-fail-");
  const calls: { command: string; args: string[] }[] = [];
  const checks = runDeterministicCompletionChecks(dir, false, makeFakeRunner({ buildOk: false }, calls));
  check("8) build FAIL → checks.ok=false", checks.ok === false);
  check("9) build FAIL → buildPassed=false", checks.buildPassed === false);
  check("10) build FAIL → testsPassed=false(전체 회귀 미실행)", checks.testsPassed === false);
  const testCallAttempted = calls.some((c) => basename(c.args[0] ?? "").endsWith("-tests.js"));
  check("11) build FAIL → 실제 test dist 파일은 실행 시도되지 않는다", !testCallAttempted);
}

// ---------------------------------------------------------------------------
// 4) tests FAIL(개별 회귀 실패) → 완료 조건 불충족
// ---------------------------------------------------------------------------
function scenarioTestsFail(): void {
  const dir = makeFixtureRepo("sdc-tests-fail-");
  const checks = runDeterministicCompletionChecks(dir, false, makeFakeRunner({ testOkByBasename: { "fixture-a-tests.js": false } }));
  check("12) 개별 회귀 실패 → checks.ok=false", checks.ok === false);
  check("13) 개별 회귀 실패 → testsPassed=false", checks.testsPassed === false);
  check("14) 개별 회귀 실패 → failedTests에 실패한 스크립트 이름 포함", checks.failedTests.includes("test:a"));
  check("15) 개별 회귀 실패 → 통과한 스크립트는 failedTests에 없음", !checks.failedTests.includes("test:b"));
}

// ---------------------------------------------------------------------------
// 5) 빌드 산출물(dist)이 없는 test:* 스크립트 → 실패로 취급
// ---------------------------------------------------------------------------
function scenarioMissingDistArtifact(): void {
  const dir = makeFixtureRepo("sdc-missing-dist-", { distFiles: ["fixture-a-tests.js"] }); // fixture-b-tests.js를 만들지 않음
  const checks = runDeterministicCompletionChecks(dir, false, makeFakeRunner({}));
  check("16) 빌드 산출물이 없는 test 스크립트 → checks.ok=false", checks.ok === false);
  check("17) 빌드 산출물이 없는 test 스크립트 → failedTests에 '빌드 산출물 없음' 사유 포함", checks.failedTests.some((f) => f.includes("test:b") && f.includes("빌드 산출물 없음")));
}

// ---------------------------------------------------------------------------
// 6) commit 없음 → 완료 조건 불충족(git HEAD 자체가 없음)
// ---------------------------------------------------------------------------
function scenarioNoCommitYet(): void {
  const dir = makeFixtureRepo("sdc-no-commit-", { commit: false });
  const checks = runDeterministicCompletionChecks(dir, false, makeFakeRunner({}));
  check("18) commit이 아직 없음 → commitHash=undefined", checks.commitHash === undefined);
  check("19) commit이 아직 없음 → checks.ok=false", checks.ok === false);
  check("20) commit이 아직 없음 → reasons에 HEAD 확인 불가 사유 포함", checks.reasons.some((r) => r.includes("HEAD")));
}

// ---------------------------------------------------------------------------
// 7) merge/rebase 진행 중 → 다른 검사를 시도조차 하지 않고 즉시 거부
// ---------------------------------------------------------------------------
function scenarioMergeInProgress(): void {
  const dir = makeFixtureRepo("sdc-merge-inprogress-");
  writeFileSync(join(dir, ".git", "MERGE_HEAD"), `${headHashOf(dir)}\n`);
  const calls: { command: string; args: string[] }[] = [];
  const checks = runDeterministicCompletionChecks(dir, false, makeFakeRunner({}, calls));
  check("21) merge 진행 중 → checks.ok=false", checks.ok === false);
  check("22) merge 진행 중 → reasons에 merge/rebase 사유 포함", checks.reasons.some((r) => r.includes("merge") || r.includes("rebase")));
  check("23) merge 진행 중 → typecheck/build/test를 전혀 시도하지 않는다(즉시 거부)", calls.length === 0);
}

// ---------------------------------------------------------------------------
// 8) push 필요 + push 실패(업스트림 없음/불일치) → 완료 조건 불충족
// ---------------------------------------------------------------------------
function scenarioPushRequiredNoUpstream(): void {
  const dir = makeFixtureRepo("sdc-push-no-upstream-");
  const checks = runDeterministicCompletionChecks(dir, true, makeFakeRunner({ upstream: { ok: false } }));
  check("24) push 필요 + upstream 확인 불가 → checks.ok=false", checks.ok === false);
  check("25) push 필요 + upstream 확인 불가 → pushPassed=false", checks.pushPassed === false);
  check("26) push 필요 + upstream 확인 불가 → reasons에 upstream 사유 포함", checks.reasons.some((r) => r.includes("upstream")));
}

function scenarioPushRequiredMismatch(): void {
  const dir = makeFixtureRepo("sdc-push-mismatch-");
  const staleHash = "0".repeat(40);
  const checks = runDeterministicCompletionChecks(dir, true, makeFakeRunner({ upstream: { ok: true, hash: staleHash } }));
  check("27) push 필요 + HEAD≠upstream(push 미반영) → checks.ok=false", checks.ok === false);
  check("28) push 필요 + HEAD≠upstream → pushPassed=false", checks.pushPassed === false);
}

// ---------------------------------------------------------------------------
// 8.1) push 필요 + fetch 실패(Phase G Task G7.3) → upstream을 아예 확인하지 않고 fail-closed
// ---------------------------------------------------------------------------
function scenarioPushRequiredFetchFailed(): void {
  const dir = makeFixtureRepo("sdc-push-fetch-failed-");
  const actualHead = headHashOf(dir);
  const calls: { command: string; args: string[] }[] = [];
  const checks = runDeterministicCompletionChecks(dir, true, makeFakeRunner({ fetchOk: false, upstream: { ok: true, hash: actualHead } }, calls));
  check("28.1) push 필요 + fetch 실패 → checks.ok=false", checks.ok === false);
  check("28.2) push 필요 + fetch 실패 → pushPassed=false", checks.pushPassed === false);
  check("28.3) push 필요 + fetch 실패 → reasons에 fetch 사유 포함", checks.reasons.some((r) => r.includes("fetch")));
  check(
    "28.4) push 필요 + fetch 실패 → fetch 실패 이후 upstream(@{u})은 조회하지 않는다(fail-closed, 낙관적 rev-parse 없음)",
    !calls.some((c) => c.command === "git" && c.args[0] === "rev-parse" && c.args.includes("@{u}"))
  );
}

// ---------------------------------------------------------------------------
// 9) 정상 완료(push 필요 + push 성공 포함) → checks.ok=true, 완료 조건 전부 충족
// ---------------------------------------------------------------------------
function scenarioAllChecksPassWithPush(): void {
  const dir = makeFixtureRepo("sdc-all-pass-push-");
  const actualHead = headHashOf(dir);
  const checks = runDeterministicCompletionChecks(dir, true, makeFakeRunner({ upstream: { ok: true, hash: actualHead } }));
  check("29) typecheck/build/tests/commit/push 전부 충족 → checks.ok=true", checks.ok === true);
  check("30) 이 시나리오의 commitHash가 실제 fixture repo의 HEAD와 일치", checks.commitHash === actualHead);
  check("31) pushPassed=true(HEAD===upstream)", checks.pushPassed === true);
}

// ---------------------------------------------------------------------------
// 10) 통합 — runDeterministicCompletionChecks(성공) → self-dev-completion.ts로 정확히 1회 기록
// ---------------------------------------------------------------------------
function scenarioIntegrationRecordsExactlyOnce(): void {
  const dir = makeFixtureRepo("sdc-integration-");
  const checks = runDeterministicCompletionChecks(dir, false, makeFakeRunner({}));
  if (!checks.ok || !checks.commitHash) throw new Error("fixture 시나리오 자체가 실패했습니다(테스트 버그) — checks.ok/commitHash를 확인하세요.");

  const evidence = validateSelfDevCompletionEvidence({
    taskId: "G7.2.1-bridge-integration",
    commitHash: checks.commitHash,
    testsPassed: checks.testsPassed,
    typecheckPassed: checks.typecheckPassed,
    buildPassed: checks.buildPassed,
    pushRequired: false,
    pushPassed: checks.pushPassed,
    source: "claude-code-self-dev-bridge",
  });
  check("32) 통합: deterministic checks 결과가 evidence 검증을 통과한다", !isEvidenceError(evidence));
  if (isEvidenceError(evidence)) return;

  const events = createInMemoryEventStore();
  const first = recordSelfDevTaskCompleted(events, evidence);
  const second = recordSelfDevTaskCompleted(events, evidence); // 동일 task+commit 재실행

  check("33) 통합: 최초 기록 ok:true", first.ok === true);
  check("34) 통합: 동일 task+commit 재실행 → idempotent(alreadyRecorded:true)", second.alreadyRecorded === true);

  const { events: stored } = events.query({ taskId: evidence.taskId, eventType: "TASK_COMPLETED" });
  check("35) 통합: 정확히 1회만 기록됨(재실행에도 이벤트 1건)", stored.length === 1);
  check("36) 통합: evidence.source가 bridge 값으로 event에 남는다(CLI와 구분 가능)", stored[0]?.metadata?.source === "claude-code-self-dev-bridge");
}

function main(): void {
  scenarioRealCommandRunnerSanitizesChildEnv();
  scenarioListFullRegressionScripts();
  scenarioTypecheckFail();
  scenarioBuildFail();
  scenarioTestsFail();
  scenarioMissingDistArtifact();
  scenarioNoCommitYet();
  scenarioMergeInProgress();
  scenarioPushRequiredNoUpstream();
  scenarioPushRequiredMismatch();
  scenarioPushRequiredFetchFailed();
  scenarioAllChecksPassWithPush();
  scenarioIntegrationRecordsExactlyOnce();

  console.log("\n=== self-dev-complete.ts(G7.2.1) 테스트 결과 ===");
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
