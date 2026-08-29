import { classifyFailureText, parseClaudeJsonOutput, classifySubprocessOutcome, detectUsageLimitSignal } from "./claude-runner";
import { runSubprocessWithTimeout } from "./subprocess-runner";
import { sanitizeForLog } from "./logger";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// SI-3.6(Executable Identity Trust) bounded review(chunk1 HIGH, 4라운드) 지적 반영 — 이
// 파일은 더 이상 claude-runner.ts의 exported "임의 command를 spawn하는" 함수를 쓰지 않는다
// (그 함수 자체가 제거됐다 — § claude-runner.ts execAndClassify). 대신 claude 신뢰와 무관한
// 범용 subprocess-runner.ts(runSubprocessWithTimeout)로 실제 subprocess를 실행하고, claude-
// runner.ts의 순수 분류 함수(classifySubprocessOutcome)로 결과를 해석한다 — 운용 코드
// (runClaudeTask)가 내부적으로 두 조각을 조합하는 것과 동일한 조합을 테스트 코드가 그대로
// 재현할 뿐, "claude를 신뢰 없이 실행하는" 별도 exported 지름길은 어디에도 없다.
async function execAndClassify(command: string, args: string[], timeoutMs: number, stdinInput?: string) {
  const outcome = await runSubprocessWithTimeout(command, args, timeoutMs, stdinInput);
  return classifySubprocessOutcome(outcome, timeoutMs);
}

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

async function main(): Promise<void> {
  // 정상 output 파싱
  const okParsed = parseClaudeJsonOutput('{"result":"CLAUDE_CLI_OK"}');
  check("정상 output 파싱 성공", okParsed.ok === true && okParsed.summary === "CLAUDE_CLI_OK");

  // INVALID_OUTPUT mock — JSON이 아닌 stdout
  const badParsed = parseClaudeJsonOutput("not valid json {{{");
  check("INVALID_OUTPUT: JSON 파싱 실패 감지", badParsed.ok === false);

  // USAGE_LIMIT mock
  check(
    "USAGE_LIMIT 텍스트 분류",
    classifyFailureText("Error: usage limit reached, please try again later") === "USAGE_LIMIT"
  );
  check("USAGE_LIMIT(한글) 텍스트 분류", classifyFailureText("현재 사용량 제한에 도달했습니다") === "USAGE_LIMIT");

  // AUTH_REQUIRED mock
  check(
    "AUTH_REQUIRED 텍스트 분류",
    classifyFailureText("Error: not authenticated, please run `claude auth login`") === "AUTH_REQUIRED"
  );

  // NON_ZERO_EXIT mock (인식되지 않는 일반 오류 텍스트로 fallback)
  check(
    "NON_ZERO_EXIT fallback 분류",
    classifyFailureText("Error: something unexpected happened") === "NON_ZERO_EXIT"
  );

  // secret sanitize — 실제 claude CLI 출력과 유사한 JSON 페이로드 형태로 검증
  const dirtyRaw = '{"result":"ok","session_id":"abc123","access_token":"leak-if-not-masked-999"}';
  const clean = sanitizeForLog(dirtyRaw);
  check("secret sanitize: rawOutput 마스킹", !clean.includes("leak-if-not-masked-999") && clean.includes("[REDACTED]"));

  // AutoDev / JARVIS Unattended Continuous Development Reliability Hardening Phase 8 —
  // password/generic secret/credential key와 key 없이 단독으로 등장하는 Bearer 토큰도
  // 마스킹되는지 확인한다(§ logger.ts REDACT_KEYS/BEARER_TOKEN_PATTERN).
  const dirtyPassword = '{"username":"svc","password":"do-not-leak-pw-777"}';
  const cleanPassword = sanitizeForLog(dirtyPassword);
  check(
    "secret sanitize: password 필드 마스킹",
    !cleanPassword.includes("do-not-leak-pw-777") && cleanPassword.includes("[REDACTED]")
  );

  const dirtySecret = '{"client":"jarvis","secret":"do-not-leak-secret-888"}';
  const cleanSecret = sanitizeForLog(dirtySecret);
  check(
    "secret sanitize: 일반 secret 필드 마스킹",
    !cleanSecret.includes("do-not-leak-secret-888") && cleanSecret.includes("[REDACTED]")
  );

  const dirtyBearerHeader = "curl -H \"Authorization: Bearer do-not-leak-bearer-token-999abcXYZ\" https://api.example.com";
  const cleanBearerHeader = sanitizeForLog(dirtyBearerHeader);
  check(
    "secret sanitize: 'Authorization: Bearer <token>' 형태(key 매칭)도 마스킹됨",
    !cleanBearerHeader.includes("do-not-leak-bearer-token-999abcXYZ")
  );

  // key:value 형태가 전혀 아니라 "Bearer <token>"만 문자열 안에 단독으로 등장하는 경우
  // (예: 다른 프로세스의 curl 커맨드 로그를 그대로 남기는 경우)까지 방어한다.
  const dirtyBearerBare = "요청 헤더 복사: Bearer do-not-leak-bare-bearer-token-1234567890";
  const cleanBearerBare = sanitizeForLog(dirtyBearerBare);
  check(
    "secret sanitize: key 없이 단독으로 등장하는 'Bearer <token>'도 마스킹됨",
    !cleanBearerBare.includes("do-not-leak-bare-bearer-token-1234567890") && cleanBearerBare.includes("Bearer [REDACTED]")
  );

  // CLI_NOT_FOUND — 실제 존재하지 않는 커맨드로 진짜 spawn ENOENT 경로를 검증한다
  // (claude CLI는 호출하지 않음 — 완전히 별개의 안전한 커맨드명).
  const notFound = await execAndClassify("movan-automation-nonexistent-binary-xyz123", [], 5000);
  check("CLI_NOT_FOUND: 존재하지 않는 커맨드 실제 감지", notFound.success === false && notFound.errorCode === "CLI_NOT_FOUND");

  // TIMEOUT — claude CLI가 아닌 순수 더미 sleep 프로세스로 실제 timeout-kill 경로를 검증한다.
  const timedOut = await execAndClassify(
    "powershell",
    ["-NoProfile", "-Command", "Start-Sleep -Seconds 5"],
    500
  );
  check("TIMEOUT: 더미 sleep 프로세스 실제 강제종료 감지", timedOut.success === false && timedOut.errorCode === "TIMEOUT");

  // NON_ZERO_EXIT — 실제로 0이 아닌 코드로 종료하는 더미 커맨드
  const nonZero = await execAndClassify("powershell", ["-NoProfile", "-Command", "exit 1"], 10000);
  check("NON_ZERO_EXIT: 실제 비정상 종료 코드 감지", nonZero.success === false && nonZero.errorCode !== undefined);

  // USAGE_LIMIT via interactive menu hang — 실제 Claude CLI가 usage limit에 도달했을 때
  // 대화형 1/2/3 선택 메뉴를 stdout에 찍고 keypress를 기다리며 멈추는 상황을 재현한다.
  // 이 subprocess의 stdin은 즉시 닫혀 있어(execAndClassify 자체가 이미 그렇게 동작) 응답할
  // 방법이 없고, 그대로면 timeout까지 hang한다 — 그 hang이 TIMEOUT이 아니라 USAGE_LIMIT으로
  // 분류되는지 검증한다.
  //
  // TIMING_FLAKINESS 조사·수정(2026-08-26) — 이 fixture는 Windows PowerShell(5.1)이 아니라
  // 이미 실행 중인 것과 동일한 node 실행파일(process.execPath)로 만든다. 실측 진단 결과
  // (repo 밖 TEMP 스크립트로 재현, 8/8) powershell.exe는 -NoProfile로도 실제 Write-Output
  // 실행에 도달하기까지 이 환경에서 일관되게 약 1.3~1.4초가 걸렸다(호스트 초기화
  // 오버헤드) — 이 timeout(800ms)보다 길어서 Write-Output이 실행되기도 전에 SIGKILL로
  // 종료되어 stdout이 항상 빈 문자열이었다(재현 5/5). classifySubprocessOutcome/
  // detectUsageLimitSignal 자체는 이미 도착한 stdout+stderr를 정확히 검사하므로 production
  // 판정 로직에는 결함이 없다(PRODUCTION_BUG 아님) — 문제는 이 test fixture가 고른
  // 인터프리터의 시작 지연이 test의 timeout 예산을 초과한다는 점이었다. node -e는 이
  // 환경에서 실제 stdout 도착까지 약 70~150ms(8/8 재현) — 800ms 안에 안정적으로 들어온다.
  // timeout 숫자 자체는 그대로 두고(임의로 늘리지 않는다), 시간에 덜 민감한 fixture로만
  // 바꾼다.
  const menuText =
    "Claude usage limit reached.\n" +
    "1) Wait for your limit to reset\n" +
    "2) Upgrade your plan\n" +
    "3) Cancel\n";
  const interactiveMenuNodeScript = `process.stdout.write(${JSON.stringify(menuText)}); setInterval(() => {}, 1000);`;
  const usageLimitHang = await execAndClassify(process.execPath, ["-e", interactiveMenuNodeScript], 800);
  check(
    "USAGE_LIMIT: 대화형 1/2/3 메뉴로 hang하는 상황이 TIMEOUT이 아니라 USAGE_LIMIT으로 분류됨(mock 재현)",
    usageLimitHang.success === false && usageLimitHang.errorCode === "USAGE_LIMIT"
  );

  // detectUsageLimitSignal 자체도 순수 함수로 직접 검증(문구 기반 + 숫자 메뉴 구조 기반 둘 다)
  check(
    "detectUsageLimitSignal: 문구 기반 탐지",
    detectUsageLimitSignal("You have reached your usage limit. Try again later.")
  );
  check(
    "detectUsageLimitSignal: 숫자 메뉴 구조 기반 탐지(정확한 문구 몰라도 구조로 탐지)",
    detectUsageLimitSignal("Some unexpected message\n1) Option A\n2) Option B\n3) Option C\n")
  );
  check(
    "detectUsageLimitSignal: 무관한 텍스트는 오탐하지 않음",
    !detectUsageLimitSignal("Error: unexpected token in JSON at position 4")
  );

  // 일반 네트워크 지연 등 진짜 TIMEOUT은 여전히 TIMEOUT으로 남아야 한다(오분류 방지 회귀).
  const plainTimeout = await execAndClassify("powershell", ["-NoProfile", "-Command", "Start-Sleep -Seconds 5"], 500);
  check("일반 TIMEOUT은 여전히 TIMEOUT으로 분류(과다 재분류 방지 회귀)", plainTimeout.errorCode === "TIMEOUT");

  // SI-3.2 — spec-planner.ts가 Planner raw-output 호출에 더 긴 timeout(PLANNER_RAW_OUTPUT_
  // TIMEOUT_MS=300000)을 쓰도록 바뀌었어도, 빠르게 끝나는 정상 응답은 여전히 그 timeout보다
  // 훨씬 먼저 성공 처리돼야 한다(회귀 방지 — timeout 값을 키운 것이 정상 경로를 늦추거나
  // 깨뜨리지 않는지 확인).
  const fastOkWithLargeTimeout = await execAndClassify(
    "powershell",
    ["-NoProfile", "-Command", "Write-Output '{\"result\":\"ok-fast\"}'"],
    300_000
  );
  check(
    "정상 응답은 큰 timeout(Planner 기본값 300000ms) 안에서도 즉시 성공 처리됨",
    fastOkWithLargeTimeout.success === true && fastOkWithLargeTimeout.summary === "ok-fast"
  );

  // AutoDev Claude Developer context/token 소비 근본 조사(2026-08-29, Stage 1) —
  // runSubprocessWithTimeout()의 새 cwd 옵션이 실제로 spawn되는 프로세스의 작업 디렉터리를
  // 바꾸는지, process.execPath(현재 실행 중인 node 자신)로 실제 subprocess를 띄워 그
  // 프로세스가 보고하는 process.cwd()로 직접 검증한다(claude CLI 실제 호출 없음).
  const cwdProbeDir = realpathSync(mkdtempSync(join(tmpdir(), "autodev-cwd-probe-")));
  try {
    const withExplicitCwd = await runSubprocessWithTimeout(
      process.execPath,
      ["-e", "process.stdout.write(process.cwd())"],
      5000,
      undefined,
      cwdProbeDir
    );
    check(
      "cwd 옵션을 지정하면 실제 spawn된 프로세스의 cwd가 그 경로가 됨(AutoDev Core cwd 상속 회귀 방지)",
      withExplicitCwd.code === 0 && realpathSync(withExplicitCwd.stdout.trim()) === cwdProbeDir
    );

    const withoutCwd = await runSubprocessWithTimeout(process.execPath, ["-e", "process.stdout.write(process.cwd())"], 5000);
    check(
      "cwd 옵션을 지정하지 않으면 기존과 동일하게 이 테스트 프로세스 자신의 cwd를 그대로 물려받음(기존 호출부 회귀 없음)",
      withoutCwd.code === 0 && realpathSync(withoutCwd.stdout.trim()) === realpathSync(process.cwd())
    );
  } finally {
    rmSync(cwdProbeDir, { recursive: true, force: true });
  }

  console.log("\n=== runner 단위 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
