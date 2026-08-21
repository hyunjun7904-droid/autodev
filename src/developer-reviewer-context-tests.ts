import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { buildProtocolSystemPrompt } from "./claude-developer";
import type { DeveloperProjectContext } from "./claude-developer";
import { buildReviewInput, buildSystemInstructions } from "./gpt-reviewer";
import type { ReviewProjectContext } from "./gpt-reviewer";
import { MOVAN_PROJECT_MANIFEST } from "./project-manifests/movan";
import { configureSafeExecutor } from "./safe-executor";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { ClaudeResult } from "./types";

// AutoDev 범용화 Phase A Task A6 — Claude Developer/GPT Reviewer에게 전달되는 system
// prompt/review instruction에서 MOVAN 하드코딩이 실제로 제거됐는지 증명한다.
//
// 이 파일은 실제 claude CLI/OpenAI API를 전혀 호출하지 않는다 — buildProtocolSystemPrompt/
// buildSystemInstructions/buildReviewInput은 순수 문자열 조립 함수이고, 이 테스트는 그
// 출력 문자열만 검사한다(§ 요구사항: 실제 유료 API 호출 금지).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

// Fixture manifest — MOVAN/web/supabase/Microsoft 개념이 전혀 없는, 완전히 무관한 작은
// 프로젝트를 흉내낸다(§ 요구사항 7). targetProjectRoot는 이 프로세스가 이미 실행 중인
// automation/dist(실존 경로)를 그대로 재사용한다 — validateProjectManifest가 실제 존재
// 여부만 확인하고, 이 테스트는 targetProjectRoot의 실제 내용을 전혀 읽지 않는다.
const FIXTURE_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["calc/"],
  allowedWritePrefixes: ["calc/"],
  allowedCommands: [],
};

const FIXTURE_MANIFEST: ProjectManifest = {
  projectId: "fixture-calculator",
  projectName: "Fixture Calculator",
  targetProjectRoot: __dirname,
  statePath: join(__dirname, "fixture-calculator-state.json"),
  taskRegistry: [],
  developerInstructions:
    "허용 범위: calc/**. 금지 사항: 외부 네트워크 호출 금지. 계산기 앱의 사칙연산 로직만 다룹니다.",
  reviewInstructions: "계산 결과의 정확성과 0으로 나누기 처리만 확인하세요.",
  reviewScopeDirs: ["calc/"],
  executionPolicy: FIXTURE_EXECUTION_POLICY,
};

const FIXTURE_DEVELOPER_CONTEXT: DeveloperProjectContext = {
  projectName: FIXTURE_MANIFEST.projectName,
  instructions: FIXTURE_MANIFEST.developerInstructions,
};
const FIXTURE_REVIEW_CONTEXT: ReviewProjectContext = {
  projectName: FIXTURE_MANIFEST.projectName,
  instructions: FIXTURE_MANIFEST.reviewInstructions,
  scopeDirs: FIXTURE_MANIFEST.reviewScopeDirs,
  // rulesPath를 지정하지 않는다 — 실제 파일을 전혀 읽지 않고 "규칙 파일 미지정" 문구만
  // 나온다(§ 실제 MOVAN rules.md 내용이 우연히도 섞여 들어올 여지를 원천 차단).
};

const MOVAN_DEVELOPER_CONTEXT: DeveloperProjectContext = {
  projectName: MOVAN_PROJECT_MANIFEST.projectName,
  instructions: MOVAN_PROJECT_MANIFEST.developerInstructions,
};
const MOVAN_REVIEW_CONTEXT: ReviewProjectContext = {
  projectName: MOVAN_PROJECT_MANIFEST.projectName,
  instructions: MOVAN_PROJECT_MANIFEST.reviewInstructions,
  scopeDirs: MOVAN_PROJECT_MANIFEST.reviewScopeDirs,
  rulesPath: MOVAN_PROJECT_MANIFEST.rulesPath,
};

const MOVAN_MARKERS = ["MOVAN", "web/", "supabase", "Microsoft"];

const FAKE_CLAUDE_RESULT: ClaudeResult = {
  success: true,
  summary: "테스트: 실제 코드 변경 없음",
  changedFiles: [],
  tests: [],
  rawOutput: "",
};

// ---------------------------------------------------------------------------
// A) MOVAN manifest 사용 시 기존에 필요한 MOVAN developer/reviewer context가 보존된다.
// ---------------------------------------------------------------------------
function scenarioA_movanContextPreserved(): void {
  const developerPrompt = buildProtocolSystemPrompt(MOVAN_DEVELOPER_CONTEXT);
  check("A) MOVAN developer prompt에 프로젝트 이름('MOVAN ERP') 포함", developerPrompt.includes("MOVAN ERP"));
  check("A) MOVAN developer prompt에 허용 read 범위(web/**) 포함", developerPrompt.includes("web/**"));
  check("A) MOVAN developer prompt에 supabase/migrations 불변 규칙 포함", developerPrompt.includes("supabase/migrations/**"));
  check("A) MOVAN developer prompt에 허용 명령 목록(npx tsc --noEmit) 포함", developerPrompt.includes("npx tsc --noEmit"));
  check("A) MOVAN developer prompt에 Microsoft/OAuth 사람 확인 caution 포함", developerPrompt.includes("Microsoft"));

  const reviewInstructions = buildSystemInstructions(MOVAN_REVIEW_CONTEXT);
  check("A) MOVAN reviewer instructions에 프로젝트 이름('MOVAN ERP') 포함", reviewInstructions.includes("MOVAN ERP"));
  check("A) MOVAN reviewer instructions에 Phase 규칙(migration 불변) 포함", reviewInstructions.includes("migration"));

  const { input } = buildReviewInput("테스트 task", FAKE_CLAUDE_RESULT, 1, MOVAN_REVIEW_CONTEXT.scopeDirs, MOVAN_REVIEW_CONTEXT);
  check("A) MOVAN reviewer input에 실제 rules.md 요약(운영 규칙) 포함", input.includes("MOVAN 자동개발 시스템"));
}

// ---------------------------------------------------------------------------
// B) Fixture manifest 사용 시 Claude Developer prompt에 MOVAN/web/supabase/Microsoft
//    전용 내용이 섞이지 않는다.
// ---------------------------------------------------------------------------
function scenarioB_fixtureDeveloperPromptIsolated(): void {
  const developerPrompt = buildProtocolSystemPrompt(FIXTURE_DEVELOPER_CONTEXT);
  for (const marker of MOVAN_MARKERS) {
    check(`B) Fixture developer prompt에 "${marker}" 문자열이 없음`, !developerPrompt.includes(marker));
  }
  check("B) Fixture developer prompt에 fixture 프로젝트 이름 포함", developerPrompt.includes("Fixture Calculator"));
  check("B) Fixture developer prompt에 fixture 고유 규칙(calc/**) 포함", developerPrompt.includes("calc/**"));
}

// ---------------------------------------------------------------------------
// C) Fixture manifest 사용 시 GPT Reviewer prompt(system instructions + review input)에도
//    MOVAN 전용 내용이 섞이지 않는다.
// ---------------------------------------------------------------------------
function scenarioC_fixtureReviewerPromptIsolated(): void {
  const reviewInstructions = buildSystemInstructions(FIXTURE_REVIEW_CONTEXT);
  for (const marker of MOVAN_MARKERS) {
    check(`C) Fixture reviewer system instructions에 "${marker}" 문자열이 없음`, !reviewInstructions.includes(marker));
  }
  check("C) Fixture reviewer system instructions에 fixture 프로젝트 이름 포함", reviewInstructions.includes("Fixture Calculator"));

  // scopeDirs를 실제 MOVAN repo에 존재하지 않는 "calc/"로 지정했으므로, 실제 git 작업트리
  // 스캔 결과에는 (현재 이 repo에서 진행 중인 다른 MOVAN 변경과 무관하게) 아무것도 잡히지
  // 않는다 — 그래서 review input 검사도 노이즈 없이 신뢰할 수 있다.
  const { input, scopeViolations } = buildReviewInput("fixture 테스트 task", FAKE_CLAUDE_RESULT, 1, FIXTURE_REVIEW_CONTEXT.scopeDirs, FIXTURE_REVIEW_CONTEXT);
  for (const marker of MOVAN_MARKERS) {
    check(`C) Fixture reviewer input에 "${marker}" 문자열이 없음`, !input.includes(marker));
  }
  check("C) Fixture reviewer input에 규칙 파일 미지정 문구 포함(rules.md를 읽지 않음)", input.includes("프로젝트 규칙 파일이 지정되지 않음"));
  check("C) Fixture scopeDirs 안에서는 scope violation이 없음(빈 배열)", scopeViolations.length === 0);
}

// ---------------------------------------------------------------------------
// D) MOVAN과 Fixture 사이에 project-specific rules가 서로 누출되지 않는다(양방향).
// ---------------------------------------------------------------------------
function scenarioD_noCrossLeakBetweenProjects(): void {
  const movanDeveloperPrompt = buildProtocolSystemPrompt(MOVAN_DEVELOPER_CONTEXT);
  const movanReviewInstructions = buildSystemInstructions(MOVAN_REVIEW_CONTEXT);
  check("D) MOVAN developer prompt에 Fixture 고유 규칙(calc/**)이 섞이지 않음", !movanDeveloperPrompt.includes("calc/**"));
  check("D) MOVAN developer prompt에 Fixture 프로젝트 이름이 섞이지 않음", !movanDeveloperPrompt.includes("Fixture Calculator"));
  check("D) MOVAN reviewer instructions에 Fixture 프로젝트 이름이 섞이지 않음", !movanReviewInstructions.includes("Fixture Calculator"));

  const fixtureDeveloperPrompt = buildProtocolSystemPrompt(FIXTURE_DEVELOPER_CONTEXT);
  const fixtureReviewInstructions = buildSystemInstructions(FIXTURE_REVIEW_CONTEXT);
  check("D) Fixture developer prompt에 MOVAN 허용 명령(npx tsc --noEmit)이 섞이지 않음", !fixtureDeveloperPrompt.includes("npx tsc --noEmit"));
  check("D) Fixture reviewer instructions에 MOVAN Phase 규칙(migration)이 섞이지 않음", !fixtureReviewInstructions.includes("migration"));
}

// ---------------------------------------------------------------------------
// G) OPENAI_API_KEY 없이도 gpt-reviewer.ts(dist)를 정상 import/실행할 수 있다(lazy init).
//    fake attempt로 실제 API를 전혀 호출하지 않고 reviewClaudeResultWithRetry가 정상
//    작동함을 별도 Node 프로세스(OPENAI_API_KEY 삭제)로 직접 증명한다.
// ---------------------------------------------------------------------------
function scenarioG_lazyOpenAIClientWorksWithoutApiKey(): void {
  const distDir = __dirname; // 빌드 후 automation/dist
  const script = [
    "const gr = require(process.argv[1]);",
    "gr.reviewClaudeResultWithRetry(",
    "  { success: true, summary: 'probe', changedFiles: [], tests: [], rawOutput: '' },",
    "  1,",
    "  'probe task',",
    "  { deps: { attempt: async () => ({ decision: 'PASS', severity: { critical: 0, high: 0, medium: 0 }, feedback: 'ok', nextTask: null }) } }",
    ").then((r) => { console.log(JSON.stringify({ ok: true, decision: r.decision })); })",
    " .catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e) })); process.exitCode = 1; });",
  ].join("\n");
  const gptReviewerPath = join(distDir, "gpt-reviewer.js");
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  const res = spawnSync(process.execPath, ["-e", script, gptReviewerPath], {
    cwd: distDir,
    encoding: "utf-8",
    env,
  });
  check("G) OPENAI_API_KEY 없이 gpt-reviewer.js 프로브 프로세스가 정상 종료(exit 0)", res.status === 0);
  if (res.status !== 0) {
    check("G) 프로브 stderr 없음(실패 원인 기록용)", false);
    console.log("[G stderr]", res.stderr);
    return;
  }
  const parsed = JSON.parse((res.stdout || "").trim()) as { ok: boolean; decision?: string; error?: string };
  check("G) OPENAI_API_KEY 없이도 모듈 import + fake attempt 주입 리뷰가 정상 완료됨", parsed.ok === true);
  check("G) fake attempt의 decision(PASS)이 그대로 반영됨(실제 API 호출 없이)", parsed.decision === "PASS");
}

function main(): void {
  // scenarioA_movanContextPreserved()/scenarioC_fixtureReviewerPromptIsolated()가
  // buildReviewInput → buildChangeSection → readUntrackedFiles를 거쳐 실제 Safe Executor
  // (validateReadPath)를 호출한다 — configureSafeExecutor()로 명시적으로 주입되기 전까지
  // 어떤 프로젝트로도 조용히 fallback하지 않으므로 먼저 MOVAN 정책을 주입한다.
  configureSafeExecutor(MOVAN_PROJECT_MANIFEST.targetProjectRoot, MOVAN_PROJECT_MANIFEST.executionPolicy);

  scenarioA_movanContextPreserved();
  scenarioB_fixtureDeveloperPromptIsolated();
  scenarioC_fixtureReviewerPromptIsolated();
  scenarioD_noCrossLeakBetweenProjects();
  scenarioG_lazyOpenAIClientWorksWithoutApiKey();

  console.log("\n=== developer/reviewer prompt 범용화(Phase A Task A6) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
