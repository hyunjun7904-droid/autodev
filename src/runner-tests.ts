import { classifyFailureText, parseClaudeJsonOutput, execAndClassify, detectUsageLimitSignal } from "./claude-runner";
import { sanitizeForLog } from "./logger";

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
  const interactiveMenuScript =
    "Write-Output 'Claude usage limit reached.'; " +
    "Write-Output '1) Wait for your limit to reset'; " +
    "Write-Output '2) Upgrade your plan'; " +
    "Write-Output '3) Cancel'; " +
    "Start-Sleep -Seconds 5";
  const usageLimitHang = await execAndClassify("powershell", ["-NoProfile", "-Command", interactiveMenuScript], 800);
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

  console.log("\n=== runner 단위 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
