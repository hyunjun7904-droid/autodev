import { mkdtempSync, writeFileSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildReviewInput, hasWorkingTreeDriftedSincePayload, reviewClaudeResultOnce, reviewClaudeResultWithRetry, buildGptReviewLedgerEntryInput } from "./gpt-reviewer";
import type { ReviewProjectContext, GptReviewApiResult } from "./gpt-reviewer";
import type { ReviewBaseline } from "./review-baseline";
import { createSafeExecutorContext } from "./safe-executor";
import type { SafeExecutorContext } from "./safe-executor";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { ClaudeResult } from "./types";
import { MAX_REVIEW_CYCLES } from "./policy";
import { applyReviewDecisionPolicy } from "./review-policy";

// Incremental GPT Reviewer(Phase SI-3.8D) 통합 테스트 — 실제 임시 git repo + 실제 파일시스템을
// 쓰지만, 실제 OpenAI API는 절대 호출하지 않는다. gpt-budget-guard-integration-tests.ts와
// 동일한 증명 방식을 그대로 재사용한다: OPENAI_API_KEY를 프로세스 안에서만 일시적으로
// 제거하면, Budget Guard가 BLOCK하지 않는 경로라도 OpenAI SDK 클라이언트 생성자가 실제
// 네트워크 요청 전에 동기적으로 throw한다(requestAttempted=false) — 즉 이 파일의 어떤
// 시나리오도 실제 네트워크 요청을 만들 수 없다(§ 요구사항 26).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "incremental-reviewer-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "Incremental Reviewer Test"], { cwd: dir });
  return dir;
}
function writeFile(repo: string, relPath: string, content: string): void {
  const abs = join(repo, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}
function commitAll(repo: string, message: string): void {
  spawnSync("git", ["add", "-A"], { cwd: repo });
  spawnSync("git", ["commit", "-q", "-m", message], { cwd: repo });
}
function stageAll(repo: string): void {
  spawnSync("git", ["add", "-A"], { cwd: repo });
}

const POLICY: ProjectExecutionPolicy = { allowedReadPrefixes: ["src/"], allowedWritePrefixes: ["src/"], allowedCommands: [] };
function makeExecutor(root: string): SafeExecutorContext {
  return createSafeExecutorContext(root, POLICY);
}
const CONTEXT: ReviewProjectContext = { projectName: "Incremental Fixture", instructions: "규칙 없음", scopeDirs: ["src/"] };

const FAKE_RESULT: ClaudeResult = { success: true, summary: "테스트", changedFiles: [], tests: [], rawOutput: "" };

/** input 텍스트에서 "## <headerStartsWith>"로 시작하는 섹션 하나만 잘라낸다(다음 "## "
 *  섹션 시작 또는 문자열 끝까지). 여러 섹션에 동일한 파일 경로 문자열이 나타날 수 있어(예:
 *  content 블록의 "--- 신규 파일: path ---" 헤더와 "생략된 파일" 목록 모두에 같은 path가
 *  나타남) 특정 섹션 안에 어떤 경로가 있는지/없는지를 정확히 검증하려면 전체 텍스트에 대한
 *  단순 includes()가 아니라 섹션 단위로 잘라 확인해야 한다. */
function extractSection(input: string, headerStartsWith: string): string {
  const idx = input.indexOf(`## ${headerStartsWith}`);
  if (idx === -1) return "";
  const rest = input.slice(idx);
  const nextIdx = rest.indexOf("\n\n## ", 1);
  return nextIdx === -1 ? rest : rest.slice(0, nextIdx);
}

// ---------------------------------------------------------------------------
// A) 3-round 전체 lifecycle: FULL → INCREMENTAL(재변경 포함, 미변경 제외, 신규 파일 포함,
//    bounded context 포함) → INCREMENTAL(재변경 재포함 확인).
//    § 요구사항 #1,#2,#3,#4,#5,#9,#10,#11.
// ---------------------------------------------------------------------------
function scenarioA_fullLifecycle(): void {
  const repo = makeTempGitRepo("incr-review-a-");
  writeFile(
    repo,
    "src/fileA.ts",
    ["export const context1 = 1;", "export const context2 = 2;", "export const a = 'A_V0';", "export const context3 = 3;", "export const context4 = 4;", ""].join("\n")
  );
  writeFile(repo, "src/fileB.ts", "export const b = 'B_V0';\n");
  commitAll(repo, "init");
  const executor = makeExecutor(repo);

  // 첫 review 이전 변경 — fileA/fileB 둘 다 수정됨.
  writeFile(
    repo,
    "src/fileA.ts",
    ["export const context1 = 1;", "export const context2 = 2;", "export const a = 'A_V1_MARKER';", "export const context3 = 3;", "export const context4 = 4;", ""].join("\n")
  );
  writeFile(repo, "src/fileB.ts", "export const b = 'B_V1_MARKER';\n");

  const round1 = buildReviewInput("task A", FAKE_RESULT, 1, ["src/"], CONTEXT, executor, undefined);
  check("A) 첫 review는 baseline 없이 항상 FULL(#1)", round1.reviewMode === "FULL");
  check("A) FULL round에는 fileA의 변경 내용이 포함됨", round1.input.includes("A_V1_MARKER"));
  check("A) FULL round에는 fileB의 변경 내용도 포함됨(첫 review는 전체)", round1.input.includes("B_V1_MARKER"));

  // round1과 round2 사이 — fileA만 다시 수정, fileB는 그대로, fileC 신규 추가(untracked).
  writeFile(
    repo,
    "src/fileA.ts",
    ["export const context1 = 1;", "export const context2 = 2;", "export const a = 'A_V2_MARKER';", "export const context3 = 3;", "export const context4 = 4;", ""].join("\n")
  );
  writeFile(repo, "src/fileC.ts", "export const c = 'C_NEW_MARKER';\n");

  const round2 = buildReviewInput("task A", FAKE_RESULT, 2, ["src/"], CONTEXT, executor, round1.newBaseline);
  check("A) baseline이 있고 유효하면 두 번째 round는 INCREMENTAL(#2)", round2.reviewMode === "INCREMENTAL");
  check("A) INCREMENTAL round에 다시 변경된 fileA의 새 내용이 포함됨(#2)", round2.input.includes("A_V2_MARKER"));
  check(
    "A) INCREMENTAL round에 변경되지 않은 fileB의 이전 내용(B_V1_MARKER)이 다시 전송되지 않음(#3/#11)",
    !round2.input.includes("B_V1_MARKER")
  );
  check("A) INCREMENTAL round가 fileB를 '생략된 파일' 목록으로 명시함(조용히 빠뜨리지 않음, #3)", round2.input.includes("src/fileB.ts"));
  check("A) INCREMENTAL round에 신규 untracked 파일(fileC)이 포함됨(#5/#9)", round2.input.includes("C_NEW_MARKER"));
  check(
    "A) INCREMENTAL round의 diff에 변경된 줄뿐 아니라 주변 bounded context(context2/context3)도 포함됨(#10)",
    round2.input.includes("context2") && round2.input.includes("context3")
  );

  // round2와 round3 사이 — fileB를 다시 변경(재포함 확인), fileA/fileC는 그대로 둠.
  writeFile(repo, "src/fileB.ts", "export const b = 'B_V2_MARKER';\n");

  const round3 = buildReviewInput("task A", FAKE_RESULT, 3, ["src/"], CONTEXT, executor, round2.newBaseline);
  check("A) 세 번째 round도 INCREMENTAL", round3.reviewMode === "INCREMENTAL");
  check("A) 이전 round에서 제외됐던 fileB가 다시 변경되자 재포함됨(#4)", round3.input.includes("B_V2_MARKER"));
  check("A) 이번 round에서 변경되지 않은 fileA(A_V2_MARKER)는 다시 전송되지 않음", !round3.input.includes("A_V2_MARKER"));
  check("A) 이번 round에서 변경되지 않은 fileC(C_NEW_MARKER)도 다시 전송되지 않음", !round3.input.includes("C_NEW_MARKER"));
}

// ---------------------------------------------------------------------------
// B) 삭제된 파일이 정확히 표현됨(#6).
// ---------------------------------------------------------------------------
function scenarioB_deletedFile(): void {
  const repo = makeTempGitRepo("incr-review-b-");
  writeFile(repo, "src/fileD.ts", "export const d = 1;\n");
  commitAll(repo, "init");
  const executor = makeExecutor(repo);

  const round1 = buildReviewInput("task B", FAKE_RESULT, 1, ["src/"], CONTEXT, executor, undefined);
  unlinkSync(join(repo, "src", "fileD.ts"));

  const round2 = buildReviewInput("task B", FAKE_RESULT, 2, ["src/"], CONTEXT, executor, round1.newBaseline);
  check("B) 삭제 이후 round도 INCREMENTAL로 진행됨", round2.reviewMode === "INCREMENTAL");
  check("B) 삭제된 파일이 '삭제된 파일' 섹션에 정확히 표현됨(#6)", round2.input.includes("src/fileD.ts") && round2.input.includes("삭제된 파일"));
}

// ---------------------------------------------------------------------------
// C) 이름만 변경된(내용 변경 없음) 파일이 정확히 표현됨(#7).
// ---------------------------------------------------------------------------
function scenarioC_renamedOnly(): void {
  const repo = makeTempGitRepo("incr-review-c-");
  writeFile(repo, "src/fileE.ts", "export const e = 'E_MARKER';\n");
  commitAll(repo, "init");
  const executor = makeExecutor(repo);

  const round1 = buildReviewInput("task C", FAKE_RESULT, 1, ["src/"], CONTEXT, executor, undefined);

  spawnSync("node", ["-e", `require('fs').renameSync('src/fileE.ts','src/fileF.ts')`], { cwd: repo });
  stageAll(repo); // rename 감지는 staged 상태에서만 porcelain "R"로 보고된다(§ git-changes.ts 주석).

  const round2 = buildReviewInput("task C", FAKE_RESULT, 2, ["src/"], CONTEXT, executor, round1.newBaseline);
  check("C) rename 이후 round도 INCREMENTAL로 진행됨", round2.reviewMode === "INCREMENTAL");
  check(
    "C) 이름이 변경된 파일이 '이름이 변경된 파일(old -> new)' 섹션에 정확히 표현됨(#7)",
    round2.input.includes("src/fileE.ts -> src/fileF.ts")
  );
}

// ---------------------------------------------------------------------------
// D) 이름 변경 + 내용 변경이 함께 정확히 표현됨(#8).
// ---------------------------------------------------------------------------
function scenarioD_renamedAndModified(): void {
  const repo = makeTempGitRepo("incr-review-d-");
  writeFile(repo, "src/fileG.ts", ["export const g1 = 1;", "export const g2 = 2;", "export const g3 = 3;", ""].join("\n"));
  commitAll(repo, "init");
  const executor = makeExecutor(repo);

  const round1 = buildReviewInput("task D", FAKE_RESULT, 1, ["src/"], CONTEXT, executor, undefined);

  spawnSync("node", ["-e", `require('fs').renameSync('src/fileG.ts','src/fileH.ts')`], { cwd: repo });
  stageAll(repo);
  writeFile(repo, "src/fileH.ts", ["export const g1 = 1;", "export const g2 = 'H_MODIFIED_MARKER';", "export const g3 = 3;", ""].join("\n"));

  const round2 = buildReviewInput("task D", FAKE_RESULT, 2, ["src/"], CONTEXT, executor, round1.newBaseline);
  check("D) rename+modification 이후 round도 INCREMENTAL로 진행됨", round2.reviewMode === "INCREMENTAL");
  check("D) rename 정보가 표현됨(#8)", round2.input.includes("src/fileG.ts -> src/fileH.ts"));
  check("D) 내용 변경도 함께 표현됨(#8)", round2.input.includes("H_MODIFIED_MARKER"));
}

// ---------------------------------------------------------------------------
// E) missing baseline 동작이 deterministic함(#14) — 매번 undefined면 항상 FULL, 동일 상태에서
//    baselineHash도 동일(review checkpoint identity deterministic, #15).
// ---------------------------------------------------------------------------
function scenarioE_missingBaselineDeterministic(): void {
  const repo = makeTempGitRepo("incr-review-e-");
  writeFile(repo, "src/fileI.ts", "export const i = 'I_V0';\n");
  commitAll(repo, "init");
  writeFile(repo, "src/fileI.ts", "export const i = 'I_V1';\n");
  const executor = makeExecutor(repo);

  const call1 = buildReviewInput("task E", FAKE_RESULT, 1, ["src/"], CONTEXT, executor, undefined);
  const call2 = buildReviewInput("task E", FAKE_RESULT, 1, ["src/"], CONTEXT, executor, undefined);
  check("E) baseline 미지정은 항상 FULL(#14)", call1.reviewMode === "FULL" && call2.reviewMode === "FULL");
  check(
    "E) 동일한 repo 상태 + 동일 task/scope/cycle이면 baselineHash가 완전히 동일함(review checkpoint identity deterministic, #15)",
    call1.newBaseline.baselineHash === call2.newBaseline.baselineHash
  );
}

// ---------------------------------------------------------------------------
// F) stale baseline(task/scope 불일치) → SAFE_FULL_FALLBACK(#12). 조용히 INCREMENTAL을
//    계속하지 않고 명시적으로 FULL과 동등한 payload로 전환됨을 함께 확인한다.
// ---------------------------------------------------------------------------
function scenarioF_staleBaselineFallsBack(): void {
  const repo = makeTempGitRepo("incr-review-f-");
  writeFile(repo, "src/fileJ.ts", "export const j = 'J_V0';\n");
  commitAll(repo, "init");
  writeFile(repo, "src/fileJ.ts", "export const j = 'J_V1_MARKER';\n");
  const executor = makeExecutor(repo);

  const round1 = buildReviewInput("original task", FAKE_RESULT, 1, ["src/"], CONTEXT, executor, undefined);
  // 다른 task 문자열로 이어서 호출 — taskIdentity가 달라 baseline이 무효화되어야 한다.
  const round2 = buildReviewInput("completely different task string", FAKE_RESULT, 2, ["src/"], CONTEXT, executor, round1.newBaseline);
  check("F) task가 바뀐 baseline은 신뢰되지 않고 SAFE_FULL_FALLBACK으로 전환됨(#12)", round2.reviewMode === "SAFE_FULL_FALLBACK");
  check("F) SAFE_FULL_FALLBACK도 실제 변경 내용을 포함함(FULL과 동등한 품질)", round2.input.includes("J_V1_MARKER"));
}

// ---------------------------------------------------------------------------
// G) tampered baseline(fileHashes만 조작, baselineHash는 그대로) → SAFE_FULL_FALLBACK(#13).
// ---------------------------------------------------------------------------
function scenarioG_tamperedBaselineFallsBack(): void {
  const repo = makeTempGitRepo("incr-review-g-");
  writeFile(repo, "src/fileK.ts", "export const k = 'K_V0';\n");
  commitAll(repo, "init");
  writeFile(repo, "src/fileK.ts", "export const k = 'K_V1_MARKER';\n");
  const executor = makeExecutor(repo);

  const round1 = buildReviewInput("task G", FAKE_RESULT, 1, ["src/"], CONTEXT, executor, undefined);
  const tampered: ReviewBaseline = {
    ...round1.newBaseline,
    fileHashes: { ...round1.newBaseline.fileHashes, "src/fileK.ts": { status: "modified", contentHash: "tampered-hash-value" } },
    // baselineHash는 의도적으로 그대로 둔다 — "객체를 직접 조작"을 흉내낸다.
  };

  const round2 = buildReviewInput("task G", FAKE_RESULT, 2, ["src/"], CONTEXT, executor, tampered);
  check("G) fileHashes가 baselineHash와 불일치하면 SAFE_FULL_FALLBACK으로 전환됨(#13)", round2.reviewMode === "SAFE_FULL_FALLBACK");
  check("G) SAFE_FULL_FALLBACK도 실제 변경 내용을 포함함", round2.input.includes("K_V1_MARKER"));
}

// ---------------------------------------------------------------------------
// H) Final Consistency Cross-check의 building block(hasWorkingTreeDriftedSincePayload) —
//    payload를 만든 시점 이후 working tree가 실제로 바뀌었는지 로컬 hash 비교만으로 감지한다
//    (#16). 실제 OpenAI 호출 없이 검증 가능.
// ---------------------------------------------------------------------------
function scenarioH_finalConsistencyDetectsDrift(): void {
  const repo = makeTempGitRepo("incr-review-h-");
  writeFile(repo, "src/fileL.ts", "export const l = 'L_V0';\n");
  commitAll(repo, "init");
  writeFile(repo, "src/fileL.ts", "export const l = 'L_V1';\n");
  const executor = makeExecutor(repo);

  const round1 = buildReviewInput("task H", FAKE_RESULT, 1, ["src/"], CONTEXT, executor, undefined);
  check("H) drift 없이 재확인하면 drifted=false", !hasWorkingTreeDriftedSincePayload(["src/"], round1.consistencySnapshot, executor));

  // review payload를 만든 "이후" 파일이 다시 바뀌었다고 가정(예: 동시 write, race).
  writeFile(repo, "src/fileL.ts", "export const l = 'L_V2_DRIFTED';\n");
  check(
    "H) payload 이후 실제로 내용이 바뀌면 drifted=true로 감지됨(이전 PASS 영역 변경 감지, #16)",
    hasWorkingTreeDriftedSincePayload(["src/"], round1.consistencySnapshot, executor)
  );
}

// ---------------------------------------------------------------------------
// I) Budget Guard가 FULL/INCREMENTAL/SAFE_FULL_FALLBACK 세 모드 모두에 동일하게 적용됨
//    (#17/#18/#19), BLOCK이면 API attempt 0(#20 — client 생성 자체가 없다).
// ---------------------------------------------------------------------------
const HUGE_TASK = "H".repeat(400_000); // 기본 payload char 상한(200_000)을 확실히 초과.

async function scenarioI_budgetGuardAppliesToAllModes(): Promise<void> {
  const repo = makeTempGitRepo("incr-review-i-");
  writeFile(repo, "src/fileM.ts", "export const m = 'M_V0';\n");
  commitAll(repo, "init");
  writeFile(repo, "src/fileM.ts", "export const m = 'M_V1';\n");
  const executor = makeExecutor(repo);

  const full = await reviewClaudeResultOnce(FAKE_RESULT, 1, HUGE_TASK, ["src/"], CONTEXT, executor, 1, 0, undefined);
  check("I) FULL round도 거대 payload면 BUDGET_EXCEEDED(#17)", full.errorCode === "BUDGET_EXCEEDED");
  check("I) FULL round 결과의 reviewMode=FULL로 정확히 표시됨", full.reviewMode === "FULL");

  writeFile(repo, "src/fileM.ts", "export const m = 'M_V2';\n");
  const incremental = await reviewClaudeResultOnce(FAKE_RESULT, 2, HUGE_TASK, ["src/"], CONTEXT, executor, 2, 0, full.reviewBaseline);
  check("I) INCREMENTAL round도 거대 payload(task 자체가 큼)면 BUDGET_EXCEEDED(#18)", incremental.errorCode === "BUDGET_EXCEEDED");
  check("I) INCREMENTAL round 결과의 reviewMode=INCREMENTAL로 정확히 표시됨", incremental.reviewMode === "INCREMENTAL");

  const tamperedBaseline: ReviewBaseline | undefined = incremental.reviewBaseline
    ? { ...incremental.reviewBaseline, fileHashes: {}, baselineHash: "will-not-match" }
    : undefined;
  const fallback = await reviewClaudeResultOnce(FAKE_RESULT, 3, HUGE_TASK, ["src/"], CONTEXT, executor, 3, 0, tamperedBaseline);
  check("I) SAFE_FULL_FALLBACK round도 거대 payload면 BUDGET_EXCEEDED(#19)", fallback.errorCode === "BUDGET_EXCEEDED");
  check("I) fallback round 결과의 reviewMode=SAFE_FULL_FALLBACK로 정확히 표시됨", fallback.reviewMode === "SAFE_FULL_FALLBACK");

  check(
    "I) 세 round 모두 BUDGET_EXCEEDED는 API 응답을 받은 적이 없음(model/tokenUsage 없음 — client 생성 자체를 시도하지 않음, #20)",
    full.model === undefined && incremental.model === undefined && fallback.model === undefined
  );
}

// ---------------------------------------------------------------------------
// J) retry wrapper는 같은 round(같은 baseline)를 재시도할 뿐 baseline/budget 판정을 우회하지
//    않는다(#21) — transient 오류로 재시도되는 동안 attempt에 전달되는 baseline이 항상 동일함을
//    확인한다.
// ---------------------------------------------------------------------------
async function scenarioJ_retryWrapperReusesSameBaseline(): Promise<void> {
  const fixedBaseline: ReviewBaseline = {
    taskIdentity: "t",
    scopeKey: "s",
    allowedPathPrefixesKey: "p",
    reviewCycleOfBaseline: 1,
    baselineHash: "fixed-hash",
    fileHashes: {},
  };
  const seenBaselines: (ReviewBaseline | undefined)[] = [];
  let calls = 0;
  const attempt = async (
    _result: ClaudeResult,
    _reviewCycle: number,
    _task?: string,
    _allowedPathPrefixes?: string[],
    _projectContext?: ReviewProjectContext,
    _executor?: SafeExecutorContext,
    _gptCallCount?: number,
    _gptRawCallTotal?: number,
    baseline?: ReviewBaseline
  ): Promise<GptReviewApiResult> => {
    calls += 1;
    seenBaselines.push(baseline);
    if (calls < 3) {
      return { decision: "HUMAN_REQUIRED", severity: { critical: 0, high: 0, medium: 0 }, feedback: "일시적 오류", nextTask: null, errorCode: "TIMEOUT", transient: true };
    }
    return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "ok", nextTask: null };
  };

  await reviewClaudeResultWithRetry(FAKE_RESULT, 2, "retry-task", {
    deps: { attempt, sleep: async () => {} },
    baseline: fixedBaseline,
  });

  check("J) attempt가 3회 호출됨(2회 실패 + 3회째 성공)", calls === 3);
  check(
    "J) 모든 재시도가 동일 baseline(baselineHash 동일)을 그대로 전달받음 — 재시도가 새 round로 오인되지 않음(#21)",
    seenBaselines.every((b) => b?.baselineHash === "fixed-hash")
  );
}

// ---------------------------------------------------------------------------
// K) Usage Ledger 매핑 — reviewMode/payloadChars가 반영되고 기존 필드(operationCycle/
//    requestCount)는 회귀 없음(#22).
// ---------------------------------------------------------------------------
function scenarioK_ledgerMappingIncludesReviewModeAndPayloadChars(): void {
  const entry = buildGptReviewLedgerEntryInput(
    { errorCode: undefined, gptTransportRetry: 0, reviewMode: "INCREMENTAL", payloadChars: 12345 },
    { projectId: "p", taskId: "t", operationCycle: 2 }
  );
  check("K) reviewMode가 Ledger entry에 그대로 반영됨(#22)", entry.reviewMode === "INCREMENTAL");
  check("K) payloadChars가 Ledger entry에 그대로 반영됨(#22)", entry.payloadChars === 12345);
  check("K) operationCycle은 기존과 동일하게 매핑됨(회귀 없음)", entry.operationCycle === 2);
  check("K) requestCount 계산은 기존과 동일(성공 시 1)", entry.requestCount === 1);
}

// ---------------------------------------------------------------------------
// L) MAX_REVIEW_CYCLES/Critical·High override 정책은 이번 Task로 변경되지 않음(#23/#24).
// ---------------------------------------------------------------------------
function scenarioL_maxReviewCyclesAndSeverityPolicyUnchanged(): void {
  check("L) MAX_REVIEW_CYCLES는 그대로 5", MAX_REVIEW_CYCLES === 5);
  const decision = applyReviewDecisionPolicy(
    { decision: "PASS", severity: { critical: 1, high: 0, medium: 0 }, scopeViolations: [] },
    false
  );
  check("L) reviewMode 필드 추가와 무관하게 critical>0 + PASS는 여전히 REVISE로 override됨(#24)", decision === "REVISE");
}

// ---------------------------------------------------------------------------
// M) Claude code-review 지적(Critical) — 예산 초과로 truncate되어 실제로는 전달되지 않은
//    파일 내용을 baseline이 "review됨"으로 기록해서는 안 된다. truncate된 파일은 다음 round
//    에도 계속 "변경됨"으로 재시도되어야 한다(조용히 영구 제외되면 안 됨).
// ---------------------------------------------------------------------------
function scenarioM_budgetTruncatedFileNeverSilentlyMarkedReviewed(): void {
  const repo = makeTempGitRepo("incr-review-m-");
  writeFile(repo, "src/fileSmall.ts", "export const small = 'SMALL_V0';\n");
  commitAll(repo, "init");
  const executor = makeExecutor(repo);

  // perFileMaxChars=20_000이므로 이 파일은 그 자체로 truncate된다(f.truncated=true).
  const hugeContent = "HUGE_MARKER_START\n" + "x".repeat(25_000) + "\nHUGE_MARKER_END\n";
  writeFile(repo, "src/fileHuge.ts", hugeContent); // untracked, 첫 round부터 truncate 대상.
  writeFile(repo, "src/fileSmall.ts", "export const small = 'SMALL_V1';\n");

  const round1 = buildReviewInput("task M", FAKE_RESULT, 1, ["src/"], CONTEXT, executor, undefined);
  check("M) round1은 FULL", round1.reviewMode === "FULL");
  check("M) truncate된 fileHuge는 baseline(review됨으로 기록되는 파일 목록)에서 제외됨", !("src/fileHuge.ts" in round1.newBaseline.fileHashes));
  check("M) 정상적으로 전달된 fileSmall은 baseline에 포함됨", "src/fileSmall.ts" in round1.newBaseline.fileHashes);

  // fileHuge 내용은 그대로 두고(재변경 없음) round2 진행 — baseline에 없었으므로 여전히
  // "변경됨"으로 재시도되어야 한다(조용히 "이미 검토된 unchanged 파일"로 취급되면 안 됨).
  const round2 = buildReviewInput("task M", FAKE_RESULT, 2, ["src/"], CONTEXT, executor, round1.newBaseline);
  check("M) round2도 INCREMENTAL", round2.reviewMode === "INCREMENTAL");
  const round2UnchangedSection = extractSection(round2.input, "이전 review 이후 내용이 전혀 변경되지 않아");
  check(
    "M) truncate로 인해 review되지 못했던 fileHuge가 round2에서 '이미 검토됨(unchanged)' 목록에 없음",
    !round2UnchangedSection.includes("src/fileHuge.ts")
  );
  check("M) round2에서도 fileHuge 내용이 다시 시도됨(마커가 다시 등장)", round2.input.includes("HUGE_MARKER_START"));
  check("M) round2에서도 여전히 truncate되어 baseline에 들어가지 못함(무한정 재시도 대상으로 유지)", !("src/fileHuge.ts" in round2.newBaseline.fileHashes));
}

// ---------------------------------------------------------------------------
// N) Claude code-review 지적(High) — INCREMENTAL round에서 allowedPathPrefixes 밖의 untracked
//    파일 내용이 FULL과 달리 payload에 그대로 포함되던 문제(scope 위반 파일의 내용 노출).
// ---------------------------------------------------------------------------
function scenarioN_incrementalDoesNotLeakOutOfScopeUntrackedContent(): void {
  const repo = makeTempGitRepo("incr-review-n-");
  writeFile(repo, "src/allowed/fileO.ts", "export const o = 'O_V0';\n");
  commitAll(repo, "init");
  // scopeDirs("src/")는 review 스캔 범위, allowedPathPrefixes("src/allowed/")는 이 task가 실제로
  // 허용된 좁은 범위 — reviewScopeDirs가 allowedPathPrefixes보다 넓어야 scope 위반을 탐지할 수
  // 있다는 기존 설계를 그대로 활용한다.
  const executor = makeExecutor(repo);
  writeFile(repo, "src/allowed/fileO.ts", "export const o = 'O_V1';\n");

  const round1 = buildReviewInput("task N", FAKE_RESULT, 1, ["src/allowed/"], CONTEXT, executor, undefined);

  // round1과 round2 사이 — allowedPathPrefixes 밖에 untracked 파일 신규 생성(정책 위반).
  // 파일명에 SECRET_NAME_PATTERNS(secret/token/credential/...)가 매칭되면 git-changes.ts가
  // scope 판정 이전에 이미 changes.excluded로 걸러버려 이 시나리오가 검증하려는 "scope 위반
  // 판정 자체"를 가리게 되므로, 그 패턴에 걸리지 않는 이름을 쓴다.
  writeFile(repo, "src/outside/other.ts", "export const leak = 'OUT_OF_SCOPE_CONTENT_MARKER';\n");
  writeFile(repo, "src/allowed/fileO.ts", "export const o = 'O_V2';\n");

  const round2 = buildReviewInput("task N", FAKE_RESULT, 2, ["src/allowed/"], CONTEXT, executor, round1.newBaseline);
  check("N) round2는 INCREMENTAL", round2.reviewMode === "INCREMENTAL");
  check("N) scope 위반 파일 경로는 scopeViolations에 잡힘", round2.scopeViolations.includes("src/outside/other.ts"));
  check(
    "N) scope 밖 untracked 파일의 실제 내용은 INCREMENTAL payload에 포함되지 않음(정책 위반 파일 내용 노출 금지)",
    !round2.input.includes("OUT_OF_SCOPE_CONTENT_MARKER")
  );
  check("N) 정상 in-scope 변경(O_V2)은 그대로 포함됨", round2.input.includes("O_V2"));
}

// ---------------------------------------------------------------------------
// O) Claude code-review 지적(Medium) — untracked 파일이 review 사이에 삭제되면 git status
//    자체에서 완전히 사라진다(tracked 삭제와 달리 "D"로 남지 않음) — 이 경우도 조용히 무시되지
//    않고 명시적으로 표현되어야 한다.
// ---------------------------------------------------------------------------
function scenarioO_untrackedFileRemovedBetweenRoundsIsSurfaced(): void {
  const repo = makeTempGitRepo("incr-review-o-");
  writeFile(repo, "src/fileP.ts", "export const p = 'P_V0';\n");
  commitAll(repo, "init");
  const executor = makeExecutor(repo);

  writeFile(repo, "src/fileQ.ts", "export const q = 'Q_NEW_MARKER';\n"); // untracked 신규 파일.
  const round1 = buildReviewInput("task O", FAKE_RESULT, 1, ["src/"], CONTEXT, executor, undefined);
  check("O) round1 baseline에 fileQ가 기록됨", "src/fileQ.ts" in round1.newBaseline.fileHashes);

  unlinkSync(join(repo, "src", "fileQ.ts")); // git이 전혀 추적하지 않던 파일이므로 삭제해도 git status에 어떤 흔적도 남지 않음.
  writeFile(repo, "src/fileP.ts", "export const p = 'P_V1';\n"); // round에 뭔가 실제 변경이 있어야 하므로 함께 수정.

  const round2 = buildReviewInput("task O", FAKE_RESULT, 2, ["src/"], CONTEXT, executor, round1.newBaseline);
  check("O) round2는 INCREMENTAL", round2.reviewMode === "INCREMENTAL");
  check(
    "O) 사라진 untracked 파일(fileQ)이 '더 이상 나타나지 않는 파일' 섹션에 명시적으로 표현됨(조용히 무시되지 않음)",
    round2.input.includes("src/fileQ.ts") && round2.input.includes("더 이상 나타나지 않는 파일")
  );
  check("O) 사라진 fileQ는 다음 baseline에도 더 이상 남지 않음", !("src/fileQ.ts" in round2.newBaseline.fileHashes));
}

// ---------------------------------------------------------------------------
// P) Claude code-review 지적(Medium) — FULL/SAFE_FULL_FALLBACK에는 있던 "secret/빌드산출물/
//    로그/temp 등으로 제외된 경로" 섹션이 INCREMENTAL에는 없어서, REVISE 도중 secret 이름
//    패턴에 걸리는 파일이 생겨도 reviewer가 전혀 알 수 없던 문제.
// ---------------------------------------------------------------------------
function scenarioP_incrementalSurfacesExcludedSecretPaths(): void {
  const repo = makeTempGitRepo("incr-review-p-");
  writeFile(repo, "src/fileR.ts", "export const r = 'R_V0';\n");
  commitAll(repo, "init");
  const executor = makeExecutor(repo);
  writeFile(repo, "src/fileR.ts", "export const r = 'R_V1';\n");

  const round1 = buildReviewInput("task P", FAKE_RESULT, 1, ["src/"], CONTEXT, executor, undefined);

  writeFile(repo, "src/fileR.ts", "export const r = 'R_V2';\n");
  writeFile(repo, "src/my-secret-key.ts", "export const leak = 'should-not-appear';\n"); // SECRET_NAME_PATTERNS에 걸리는 파일명.

  const round2 = buildReviewInput("task P", FAKE_RESULT, 2, ["src/"], CONTEXT, executor, round1.newBaseline);
  check("P) round2는 INCREMENTAL", round2.reviewMode === "INCREMENTAL");
  check(
    "P) secret 이름 패턴에 걸리는 경로가 INCREMENTAL payload에도 제외 경로로 명시됨(FULL과 동일한 가시성)",
    round2.input.includes("src/my-secret-key.ts") && round2.input.includes("제외된 경로")
  );
  check("P) 실제 secret 파일 내용은 노출되지 않음", !round2.input.includes("should-not-appear"));
}

// ---------------------------------------------------------------------------
// Q) Final Consistency Cross-check false positive 수정(2026-08-26, JARVIS Task 1.3 실전 사고).
//    REVIEW COVERAGE baseline(newBaseline.fileHashes, fullyIncludedPaths로 필터링됨)과
//    CONSISTENCY snapshot(consistencySnapshot, truncation과 무관하게 scope 전체)이 서로 다른
//    개념으로 완전히 분리됐는지 직접 증명한다. 실제 사고: truncated된 파일 하나가 baseline에서는
//    빠지고 재검사 시점 스냅샷에는 있어(키 개수 1 vs 2) 아무 내용도 안 바뀌었는데
//    REVIEW_CONSISTENCY_CHECK_FAILED가 발생했다.
// ---------------------------------------------------------------------------
function scenarioQ_finalConsistencyUsesUnfilteredSnapshotNotCoverageBaseline(): void {
  const repo = makeTempGitRepo("incr-review-q-");
  writeFile(repo, "src/fileSmallQ.ts", "export const smallQ = 'SMALLQ_V0';\n");
  commitAll(repo, "init");
  const executor = makeExecutor(repo);

  // perFileMaxChars=20_000 — 이 파일은 truncate된다(실제 JARVIS Task 1.3의 20,235자 파일과 동일한
  // 모양의 재현).
  const hugeContent = "HUGE_Q_MARKER_START\n" + "x".repeat(25_000) + "\nHUGE_Q_MARKER_END\n";
  writeFile(repo, "src/fileHugeQ.ts", hugeContent); // untracked, 첫 round부터 truncate 대상.
  writeFile(repo, "src/fileSmallQ.ts", "export const smallQ = 'SMALLQ_V1';\n");

  const round1 = buildReviewInput("task Q", FAKE_RESULT, 1, ["src/"], CONTEXT, executor, undefined);

  // Case 6 — REVIEW COVERAGE semantics는 전혀 바뀌지 않았다: truncated 파일은 여전히 baseline
  // (newBaseline.fileHashes)에서 제외된다 — "fully included로 잘못 취급되지 않음"을 직접 증명.
  check(
    "Q6) truncated fileHugeQ는 여전히 REVIEW COVERAGE baseline(newBaseline.fileHashes)에서 제외됨(semantics 보존)",
    !("src/fileHugeQ.ts" in round1.newBaseline.fileHashes)
  );
  check("Q6) 반면 CONSISTENCY snapshot에는 truncated 파일도 포함됨(별개 목적)", "src/fileHugeQ.ts" in round1.consistencySnapshot);
  check(
    "Q) fully included 파일(fileSmallQ)은 newBaseline과 consistencySnapshot 양쪽 모두에 포함됨",
    "src/fileSmallQ.ts" in round1.newBaseline.fileHashes && "src/fileSmallQ.ts" in round1.consistencySnapshot
  );

  // Case 1 + Case 2 — fully-included 파일도, truncated 파일도 실제로는 아무것도 안 바뀌면
  // drift=false여야 한다(이게 바로 JARVIS Task 1.3 production false positive의 직접 회귀 테스트).
  check(
    "Q1+Q2) 아무 파일도 review 도중 바뀌지 않으면(truncated 파일 포함) drift=false — 실제 프로덕션 false positive 직접 재현/수정 확인",
    !hasWorkingTreeDriftedSincePayload(["src/"], round1.consistencySnapshot, executor)
  );

  // Case 3 — truncated 파일이 review 도중 "진짜로" 바뀌면 여전히 drift=true여야 한다(안전장치가
  // 약해지지 않았음을 증명 — 이 케이스가 없으면 그냥 truncated 파일을 통째로 무시하는 것과
  // 구분이 안 된다).
  writeFile(repo, "src/fileHugeQ.ts", "HUGE_Q_MARKER_START\n" + "z".repeat(25_000) + "\nHUGE_Q_MARKER_END_MODIFIED\n");
  check(
    "Q3) truncated 파일이 review 도중 실제로 변경되면 drift=true(안전장치 유지 확인)",
    hasWorkingTreeDriftedSincePayload(["src/"], round1.consistencySnapshot, executor)
  );
  writeFile(repo, "src/fileHugeQ.ts", hugeContent); // 원상복구.
  check(
    "Q3 복원 확인) 원상복구 후 다시 drift=false로 돌아옴(hash 비교가 실제 내용 기준임을 확인)",
    !hasWorkingTreeDriftedSincePayload(["src/"], round1.consistencySnapshot, executor)
  );

  // Case 4 — review 도중 관련 있는 새 파일이 나타나면 drift=true.
  writeFile(repo, "src/fileNewQ.ts", "export const newQ = 'NEW_DURING_REVIEW';\n");
  check("Q4) review 도중 새 관련 파일이 나타나면 drift=true", hasWorkingTreeDriftedSincePayload(["src/"], round1.consistencySnapshot, executor));
  unlinkSync(join(repo, "src/fileNewQ.ts")); // 원상복구.
  check("Q4 복원 확인) 새 파일을 지우면 다시 drift=false로 돌아옴", !hasWorkingTreeDriftedSincePayload(["src/"], round1.consistencySnapshot, executor));

  // Case 5 — review 도중 baseline에 있던(=payload 시점에 존재했던) 관련 파일이 사라지면 drift=true.
  unlinkSync(join(repo, "src/fileSmallQ.ts"));
  check("Q5) review 도중 관련 파일이 사라지면 drift=true", hasWorkingTreeDriftedSincePayload(["src/"], round1.consistencySnapshot, executor));
}

async function main(): Promise<void> {
  const originalApiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY; // § 요구사항 26 — 이 파일의 어떤 시나리오도 실제 API를 호출하지 않는다.

  try {
    scenarioA_fullLifecycle();
    scenarioB_deletedFile();
    scenarioC_renamedOnly();
    scenarioD_renamedAndModified();
    scenarioE_missingBaselineDeterministic();
    scenarioF_staleBaselineFallsBack();
    scenarioG_tamperedBaselineFallsBack();
    scenarioH_finalConsistencyDetectsDrift();
    await scenarioI_budgetGuardAppliesToAllModes();
    await scenarioJ_retryWrapperReusesSameBaseline();
    scenarioK_ledgerMappingIncludesReviewModeAndPayloadChars();
    scenarioL_maxReviewCyclesAndSeverityPolicyUnchanged();
    scenarioM_budgetTruncatedFileNeverSilentlyMarkedReviewed();
    scenarioN_incrementalDoesNotLeakOutOfScopeUntrackedContent();
    scenarioO_untrackedFileRemovedBetweenRoundsIsSurfaced();
    scenarioP_incrementalSurfacesExcludedSecretPaths();
    scenarioQ_finalConsistencyUsesUnfilteredSnapshotNotCoverageBaseline();
  } finally {
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 디렉터리 정리 실패는 테스트 결과에 영향 없음(OS temp는 결국 정리됨)
      }
    }
  }

  console.log("\n=== Incremental GPT Reviewer(Phase SI-3.8D) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
