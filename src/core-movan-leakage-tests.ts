import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// AutoDev 범용화 Phase B Task B1 — Core MOVAN leakage 검사(§ 요구사항 9).
//
// "프롬프트에 써 있는 규칙"(안내문/주석 — 삭제 대상 아님)과 "코드가 실제로 차단하는
// 규칙"(하드코딩된 import/상수/타입 — 삭제 대상)을 구분한다. 이 파일은 후자만, 그것도
// 소스 전체 substring 검색이 아니라 실제 import문/상수 식별자/타입 리터럴 패턴으로만
// 검사한다 — 주석에 "web/", "automation/", "MOVAN" 같은 설명이 남아있는 것은 정상이고
// 실패시키지 않는다(§ 요구사항: "주석의 역사 설명까지 무조건 실패시키는 허술한 문자열
// 검사로 만들지는 않는다").

const SRC_DIR = join(__dirname, "..", "src");

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function readSrc(fileName: string): string {
  return readFileSync(join(SRC_DIR, fileName), "utf-8");
}

function main(): void {
  const safeExecutor = readSrc("safe-executor.ts");
  const claudeDeveloper = readSrc("claude-developer.ts");
  const gptReviewer = readSrc("gpt-reviewer.ts");
  const orchestrator = readSrc("orchestrator.ts");
  const autodev = readSrc("autodev.ts");
  const taskRegistry = readSrc("task-registry.ts");
  const projectContext = readSrc("project-context.ts");
  const state = readSrc("state.ts");
  const checkpoint = readSrc("checkpoint.ts");
  const projectAdapterLoader = readSrc("project-adapter-loader.ts");
  const run = readSrc("run.ts");

  // --- safe-executor.ts: MOVAN 전용 import/상수/타입이 남아있지 않음 ---
  check(
    "safe-executor.ts가 project-manifests/movan을 import하지 않음",
    !/from\s+"\.\/project-manifests\/movan"/.test(safeExecutor)
  );
  check(
    "safe-executor.ts가 project-registries/movan을 import하지 않음",
    !/from\s+"\.\/project-registries\/movan"/.test(safeExecutor)
  );
  check(
    "safe-executor.ts에 하드코딩된 MOVAN read/write allow-list 배열(['web/','automation/'])이 없음",
    !/\[\s*["']web\/["']\s*,\s*["']automation\/["']/.test(safeExecutor)
  );
  check("safe-executor.ts에 MOVAN 전용 ALLOWED_COMMANDS 상수가 없음(정책으로 이동됨)", !/\bALLOWED_COMMANDS\b/.test(safeExecutor));
  check(
    "safe-executor.ts에 MOVAN 전용 MIGRATION_FILE_PATTERN 상수가 없음(정책의 writeDenyPatterns로 이동됨)",
    !/\bMIGRATION_FILE_PATTERN\b/.test(safeExecutor)
  );
  check(
    "safe-executor.ts의 RunCommandAction.cwd가 더 이상 \"root\"|\"web\"|\"automation\" 리터럴 유니온이 아님(string으로 일반화)",
    !/cwd\?\s*:\s*"root"\s*\|\s*"web"\s*\|\s*"automation"/.test(safeExecutor)
  );
  check("safe-executor.ts가 configureSafeExecutor()로 정책을 명시적으로 주입받음", /export function configureSafeExecutor/.test(safeExecutor));

  // --- claude-developer.ts: MOVAN 전용 scope 하드코딩이 없음 ---
  check(
    "claude-developer.ts에 하드코딩된 changedFiles 스캔 범위(['web/','automation/'])가 없음",
    !/\[\s*["']web\/["']\s*,\s*["']automation\/["']\s*\]/.test(claudeDeveloper)
  );
  check(
    "claude-developer.ts가 project-manifests/movan을 import하지 않음",
    !/from\s+"\.\/project-manifests\/movan"/.test(claudeDeveloper)
  );

  // --- gpt-reviewer.ts: MOVAN 전용 import가 없음(A6에서 이미 확인된 것을 재확인) ---
  check(
    "gpt-reviewer.ts가 project-manifests/movan을 import하지 않음",
    !/from\s+"\.\/project-manifests\/movan"/.test(gptReviewer)
  );

  // --- orchestrator.ts: MOVAN 전용 import가 없음 ---
  check(
    "orchestrator.ts가 project-manifests/movan을 import하지 않음",
    !/from\s+"\.\/project-manifests\/movan"/.test(orchestrator)
  );

  // --- autodev.ts: MOVAN 전용 import가 없고, per-run SafeExecutorContext를 명시적으로 생성함 ---
  check("autodev.ts가 project-manifests/movan을 import하지 않음(A7부터 유지)", !/from\s+"\.\/project-manifests\/movan"/.test(autodev));
  check(
    "autodev.ts가 manifest.executionPolicy를 createSafeExecutorContext에 명시적으로 넘김",
    /createSafeExecutorContext\(manifest\.targetProjectRoot,\s*manifest\.executionPolicy\)/.test(autodev)
  );
  // Phase C Task C2 — Per-Run Execution Context 격리: production 실행 경로(runAutodevOnce)는
  // module-level mutable singleton을 설정하는 configureSafeExecutor()를 더 이상 호출하지
  // 않는다(다른 project run이 같은 프로세스에서 나중에 그 전역을 덮어쓸 수 있는 위험을
  // 제거하기 위함) — 대신 이 run 전용 context를 만들어 필요한 곳에 명시적으로 전달한다.
  check(
    "autodev.ts가 configureSafeExecutor()를 호출하지 않음(module-global 설정 제거)",
    !/configureSafeExecutor\(/.test(autodev)
  );

  // --- task-registry.ts: MOVAN 전용 cwd 리터럴 유니온이 없음(RequiredTestCommand.cwd가 string으로 일반화) ---
  check(
    "task-registry.ts의 RequiredTestCommand.cwd가 더 이상 \"root\"|\"web\"|\"automation\" 리터럴 유니온이 아님",
    !/cwd:\s*"root"\s*\|\s*"web"\s*\|\s*"automation"/.test(taskRegistry)
  );

  // --- Phase B Task B3 — External Project Adapter 분리 이후 강화된 검사 ---
  // project-context.ts/state.ts/checkpoint.ts: MOVAN 전용 import/경로 상수가 없음.
  check(
    "project-context.ts가 project-manifests/movan을 import하지 않음",
    !/from\s+"\.\/project-manifests\/movan"/.test(projectContext)
  );
  check(
    "state.ts가 project-manifests/movan을 import하지 않음",
    !/from\s+"\.\/project-manifests\/movan"/.test(state)
  );
  check(
    "checkpoint.ts가 project-manifests/movan을 import하지 않음",
    !/from\s+"\.\/project-manifests\/movan"/.test(checkpoint)
  );

  // entry point(run.ts, run-movan.ts 대체) + project-adapter-loader.ts: MOVAN을 전혀 모르고
  // 항상 외부 adapter 경로를 요구한다.
  check(
    "run.ts가 project-manifests/movan을 import하지 않음",
    !/from\s+"\.\/project-manifests\/movan"/.test(run)
  );
  check("run.ts에 MOVAN 하드코딩 문자열이 없음(주석 포함)", !/MOVAN/.test(run));
  check("run.ts가 project-adapter-loader를 통해서만 manifest를 얻음", /loadProjectAdapter\(/.test(run));
  check(
    "project-adapter-loader.ts가 project-manifests/movan을 import하지 않음",
    !/from\s+"\.\/project-manifests\/movan"/.test(projectAdapterLoader)
  );
  check("project-adapter-loader.ts에 MOVAN 하드코딩 문자열이 없음(주석 포함)", !/MOVAN/.test(projectAdapterLoader));

  // --- Phase C Task C1 — External Project Adapter Trust Boundary: project-adapter-loader.ts가
  // 외부 project config의 코드를 실행하지 않고 데이터로만 읽음(§ 요구사항 13). "이런 걸 쓰지
  // 않는다"는 주석 설명(예: "eval()을 쓰지 않는다")까지 실패시키지 않도록 // 줄 주석을 제거한
  // 코드만 검사한다.
  const projectAdapterLoaderNoComments = projectAdapterLoader
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  check(
    "project-adapter-loader.ts가 외부 adapter 경로를 require()하지 않음(resolvedPath 대상)",
    !/require\(\s*resolvedPath\s*\)/.test(projectAdapterLoaderNoComments)
  );
  check("project-adapter-loader.ts에 동적 import()가 없음", !/\bimport\(/.test(projectAdapterLoaderNoComments));
  check("project-adapter-loader.ts에 eval()이 없음", !/\beval\(/.test(projectAdapterLoaderNoComments));
  check("project-adapter-loader.ts에 new Function()이 없음", !/new\s+Function\(/.test(projectAdapterLoaderNoComments));
  check(
    "project-adapter-loader.ts가 node:vm을 사용하지 않음",
    !/require\(\s*["']node:vm["']\s*\)/.test(projectAdapterLoaderNoComments) && !/from\s+"node:vm"/.test(projectAdapterLoaderNoComments)
  );
  check(
    "project-adapter-loader.ts가 project config를 JSON.parse로만 읽음(readFileSync+JSON.parse)",
    /JSON\.parse\(/.test(projectAdapterLoaderNoComments) && /readFileSync\(/.test(projectAdapterLoaderNoComments)
  );

  // --- 목표 상태(§ 요구사항 11) — MOVAN 전용 adapter/registry/entry point 파일 자체가
  // AutoDev repo 안에 더 이상 존재하지 않는다. ---
  check(
    "src/project-manifests/movan.ts가 존재하지 않음(MOVAN adapter가 MOVAN repo로 이동됨)",
    !existsSync(join(SRC_DIR, "project-manifests", "movan.ts"))
  );
  check(
    "src/project-registries/movan.ts가 존재하지 않음(MOVAN task registry가 MOVAN repo로 이동됨)",
    !existsSync(join(SRC_DIR, "project-registries", "movan.ts"))
  );
  check("src/run-movan.ts가 존재하지 않음(범용 run.ts로 대체됨)", !existsSync(join(SRC_DIR, "run-movan.ts")));

  console.log("\n=== Core MOVAN leakage(Phase B Task B1/B3 — § 요구사항 9/11) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
