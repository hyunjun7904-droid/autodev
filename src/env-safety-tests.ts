import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// AutoDev / JARVIS 지능형 오류 복구 하드닝 § 16 — 이 세션 도중 raw shell 환경변수 조회
// (`env | grep ...`)로 실제 Telegram credential이 화면에 노출된 사고가 있었다. 그 사고는
// Claude Code 세션 자신의 Bash 도구 사용이 원인이었고 AutoDev 코드 결함은 아니었지만, 이
// 기회에 AutoDev 소스 전체가 process.env를 통째로 문자열화/로그화하는 코드 경로를 실제로
// 갖고 있지 않은지 결정론적으로 재확인한다(§ logger.ts 상단 주석 — "process.env 전체를
// 그대로 문자열화해 로그로 남기는 함수는 의도적으로 만들지 않는다"는 그 파일의 기존
// 주장을 이 테스트가 소스 전체에 대해 직접 증명한다). 이 파일 자신도 절대 process.env를
// 출력하지 않는다 — PRESENT/MISSING 형태의 존재 여부 검사만 한다(§ 요구사항).

const SRC_DIR = join(__dirname, "..", "src");

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

// 프로덕션 소스만 스캔한다 — 테스트 파일은 fixture로 의도적으로 이런 패턴을 문자열로
// "언급"할 수 있다(예: 이 파일 자신의 주석, 또는 다른 테스트가 검증 목적으로 이 패턴을
// 문자열 리터럴에 담는 경우) — 그런 언급까지 실패시키는 허술한 검사로 만들지 않는다.
function listProductionSourceFiles(): string[] {
  return readdirSync(SRC_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith("-tests.ts"));
}

// 이 저장소 어떤 프로덕션 파일도 process.env 전체를 하나의 값으로 직렬화/순회하지 않아야
// 한다 — 개별 키(process.env.SPECIFIC_NAME)를 읽는 것은 전혀 문제 없다(이 저장소 전체가
// 그렇게 개별 키만 읽는다, 예: AUTODEV_TELEGRAM_BOT_TOKEN). 아래 패턴은 "환경변수 전체를
// 한 덩어리로 다루는" 구조만 잡아낸다.
const DANGEROUS_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "Object.entries(process.env)", pattern: /Object\.entries\(\s*process\.env\s*\)/ },
  { name: "Object.keys(process.env) 순회 후 값 접근", pattern: /Object\.keys\(\s*process\.env\s*\)/ },
  { name: "process.env 전체 spread(...process.env)", pattern: /\.\.\.\s*process\.env\b/ },
  { name: "JSON.stringify(process.env)", pattern: /JSON\.stringify\(\s*process\.env\s*\)/ },
  { name: "for...in process.env 순회", pattern: /for\s*\([^)]*\bin\s+process\.env\b/ },
];

// self-dev-complete.ts의 sanitizedChildEnv()는 이미 이 파일이 검증하는(§
// scenarioChildProcessDenylistCoversAllNotificationCredentials) denylist 삭제를 곧바로
// 수행하는 검토된 유일한 예외다 — process.env를 spread한 직후 민감 키를 delete하고, 그
// 결과만 자식 프로세스 env로 쓴다(로그/출력 어디에도 남기지 않는다). 다른 어떤 파일도 이
// 패턴을 새로 도입해서는 안 된다.
const REVIEWED_ENV_SPREAD_EXCEPTIONS: ReadonlySet<string> = new Set(["self-dev-complete.ts"]);

function scenarioNoBroadEnvDumpInProductionSource(): void {
  const files = listProductionSourceFiles();
  check("스캔 대상 프로덕션 소스 파일이 실제로 존재함(빈 검사 아님)", files.length > 50);

  for (const { name, pattern } of DANGEROUS_PATTERNS) {
    const offenders: string[] = [];
    for (const file of files) {
      if (REVIEWED_ENV_SPREAD_EXCEPTIONS.has(file)) continue;
      const content = readFileSync(join(SRC_DIR, file), "utf-8");
      if (pattern.test(content)) offenders.push(file);
    }
    check(`검토된 예외 외 프로덕션 소스 어디에도 '${name}' 패턴이 없음(위반 파일: ${offenders.join(", ") || "없음"})`, offenders.length === 0);
  }
}

// self-dev-complete.ts의 CHILD_PROCESS_ENV_DENYLIST(실제 실행되는 유일한 자식 프로세스
// 경계)가 Telegram/ntfy 자격증명 관련 키를 전부 포함하는지 직접 확인한다 — 이 목록에서
// 하나라도 빠지면 그 값이 test/fixture 자식 프로세스로 새어 들어갈 수 있다(§ 2026-08-22
// incident와 동일한 위협 모델).
function scenarioChildProcessDenylistCoversAllNotificationCredentials(): void {
  const content = readFileSync(join(SRC_DIR, "self-dev-complete.ts"), "utf-8");
  const requiredKeys = [
    "AUTODEV_TELEGRAM_BOT_TOKEN",
    "AUTODEV_TELEGRAM_CHAT_ID",
    "AUTODEV_TELEGRAM_USER_ID",
    "AUTODEV_NTFY_TOPIC",
    "AUTODEV_NTFY_TOKEN",
    "AUTODEV_NTFY_BASE_URL",
  ];
  for (const key of requiredKeys) {
    check(`CHILD_PROCESS_ENV_DENYLIST에 ${key} 포함됨`, content.includes(`"${key}"`));
  }
}

// Core Command Safety Gate의 실행 파일 allow-list(git/npm/npx/node/nodejs/tsc/gradlew)에
// 광범위한 환경변수 출력 명령(env/printenv/set/cmd/powershell/bash/sh)이 없는지 직접
// 확인한다 — Claude Developer는 이 allow-list 밖의 실행 파일을 구조적으로 spawn할 수
// 없으므로(§ safe-executor.ts CORE_ALLOWED_EXECUTABLE_FAMILIES), 이 목록이 좁게 유지되는
// 한 "env 전체 출력" 같은 명령 자체가 애초에 실행 후보가 될 수 없다.
function scenarioCoreCommandAllowlistExcludesEnvDumpExecutables(): void {
  const content = readFileSync(join(SRC_DIR, "safe-executor.ts"), "utf-8");
  const match = content.match(/CORE_ALLOWED_EXECUTABLE_FAMILIES:\s*ReadonlySet<string>\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  check("safe-executor.ts에서 CORE_ALLOWED_EXECUTABLE_FAMILIES 정의를 찾음", match !== null);
  const listBody = match?.[1] ?? "";
  const bannedExecutables = ["env", "printenv", "set", "cmd", "powershell", "bash", "sh"];
  for (const exe of bannedExecutables) {
    const re = new RegExp(`"${exe}"`);
    check(`CORE_ALLOWED_EXECUTABLE_FAMILIES에 '${exe}'가 없음(env 전체 출력 명령 실행 불가)`, !re.test(listBody));
  }
}

function main(): void {
  scenarioNoBroadEnvDumpInProductionSource();
  scenarioChildProcessDenylistCoversAllNotificationCredentials();
  scenarioCoreCommandAllowlistExcludesEnvDumpExecutables();

  console.log("\n=== env-safety 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
