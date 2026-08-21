import { readFileSync } from "node:fs";
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

  // --- autodev.ts: MOVAN 전용 import가 없고, configureSafeExecutor를 명시적으로 호출함 ---
  check("autodev.ts가 project-manifests/movan을 import하지 않음(A7부터 유지)", !/from\s+"\.\/project-manifests\/movan"/.test(autodev));
  check(
    "autodev.ts가 manifest.executionPolicy를 configureSafeExecutor에 명시적으로 넘김",
    /configureSafeExecutor\(manifest\.targetProjectRoot,\s*manifest\.executionPolicy\)/.test(autodev)
  );

  // --- task-registry.ts: MOVAN 전용 cwd 리터럴 유니온이 없음(RequiredTestCommand.cwd가 string으로 일반화) ---
  check(
    "task-registry.ts의 RequiredTestCommand.cwd가 더 이상 \"root\"|\"web\"|\"automation\" 리터럴 유니온이 아님",
    !/cwd:\s*"root"\s*\|\s*"web"\s*\|\s*"automation"/.test(taskRegistry)
  );

  console.log("\n=== Core MOVAN leakage(Phase B Task B1 — § 요구사항 9) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
