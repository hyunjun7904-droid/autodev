import { createPlaywrightBrowserBackend } from "./playwright-browser-backend";

// Playwright Browser Backend — 실제 브라우저 smoke test(Phase E Task E2, 보완 E2.1).
//
// package.json의 스크립트 이름이 의도적으로 "test:" 접두사가 아니다("smoke-test"/
// "gpt-smoke-test"/"real-source-catalog-smoke-test"와 동일한 기존 관례) — Task 완료 전
// 필수로 실행하는 전체 회귀(`npm run test:*`)에는 포함되지 않는다. 이 스크립트는 실제
// Playwright(realChromiumLauncher, 기본값)로 진짜 브라우저를 실행한다 — 로컬에 Playwright
// Chromium 바이너리(`npx playwright install chromium`)가 설치돼 있어야 하며, 이 Task는
// 그 설치를 자동으로 수행하지 않는다(요구사항: "불필요하면 설치 범위를 확장하지 않는다").
// 브라우저 바이너리가 없으면 이 스크립트는 그 사실을 명확히 보고하고 실패한다 — 실제 회귀
// 스위트(`npm run test:*`)는 이 스크립트에 의존하지 않으므로 그 실패가 회귀를 불안정하게
// 만들지 않는다.
//
// Phase E Task E2.1 — 외부 인터넷 없이 검증하도록 loadFixtureContent()(page.setContent,
// network navigation 없음)로 완전히 격리된 로컬 fixture 페이지를 로드한다. 로그인/결제/
// 파일 다운로드/production 사이트 조작은 전혀 수행하지 않는다 — 이 fixture는 이 스크립트
// 안에서만 존재하는 정적 HTML 문자열이다.

const FIXTURE_HTML = `
<!doctype html>
<html>
<body>
  <h1>Local Fixture Page</h1>
  <div id="status">not-clicked</div>
  <button id="safe-button" onclick="document.getElementById('status').textContent='clicked'">Click me (safe)</button>
  <a id="download-link" href="https://example.com/file.pdf" download>Download PDF</a>
  <input id="password-field" type="password" name="password" />
  <p>PRICING: contact sales for pricing information.</p>
</body>
</html>
`;

async function main(): Promise<void> {
  console.log("=== Playwright Browser Backend smoke test(실제 브라우저, 로컬 fixture) ===");
  let backend: Awaited<ReturnType<typeof createPlaywrightBrowserBackend>> | undefined;
  const checks: { label: string; ok: boolean; detail?: string }[] = [];
  const record = (label: string, ok: boolean, detail?: string) => checks.push({ label, ok, detail });

  try {
    backend = await createPlaywrightBrowserBackend({ headless: true });
    record("browser/context/page 생성", true);

    const loaded = await backend.loadFixtureContent(FIXTURE_HTML);
    record("격리된 로컬 fixture 로드(page.setContent, 네트워크 없음)", loaded.ok, loaded.ok ? undefined : loaded.reason);

    const read = await backend.readPage();
    record(
      "READ_PAGE: fixture 내용을 그대로 읽음",
      read.ok === true && (read.data?.content.includes("Local Fixture Page") ?? false),
      read.ok ? undefined : read.reason
    );

    const extract = await backend.extractText("h1");
    record(
      "EXTRACT_TEXT: h1 텍스트 추출",
      extract.ok === true && (extract.data?.text.includes("Local Fixture Page") ?? false),
      extract.ok ? undefined : extract.reason
    );

    const found = await backend.find("PRICING");
    record("FIND: 'PRICING' 텍스트를 찾음", found.ok === true && (found.data?.matches.length ?? 0) > 0, found.ok ? undefined : found.reason);

    const safeClick = await backend.clickSafe("#safe-button");
    record("정상 safe click: Preflight 통과 + 실제 클릭 성공", safeClick.ok === true, safeClick.ok ? undefined : safeClick.reason);

    const afterClick = await backend.extractText("#status");
    record(
      "정상 safe click이 실제로 DOM을 변경함(status: not-clicked → clicked)",
      afterClick.ok === true && afterClick.data?.text === "clicked",
      afterClick.ok ? `text=${afterClick.data?.text}` : afterClick.reason
    );

    const downloadClick = await backend.clickSafe("#download-link");
    record(
      "Preflight가 download attribute 클릭을 실제 클릭 전에 차단함",
      downloadClick.ok === false,
      downloadClick.ok ? "차단되지 않음(위험)" : downloadClick.reason
    );

    const passwordClick = await backend.clickSafe("#password-field");
    record(
      "Preflight가 password input 클릭을 실제 클릭 전에 차단함",
      passwordClick.ok === false,
      passwordClick.ok ? "차단되지 않음(위험)" : passwordClick.reason
    );

    const shot = await backend.screenshot();
    record("SCREENSHOT: 정상 캡처됨", shot.ok === true && (shot.data?.imageBase64.length ?? 0) > 0, shot.ok ? undefined : shot.reason);

    await backend.dispose();
    record("browser/context/page 정상 종료(dispose)", true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[FAIL] 실제 브라우저 실행 중 예외: ${message}`);
    console.log(
      "참고: 로컬에 Playwright Chromium 바이너리가 없으면 이런 오류가 납니다 — " +
        "`npx playwright install chromium`으로 설치할 수 있습니다(이 Task는 자동으로 설치하지 않습니다)."
    );
    if (backend) await backend.dispose().catch(() => {});
    process.exitCode = 1;
    printResults(checks);
    return;
  }

  printResults(checks);
}

function printResults(checks: { label: string; ok: boolean; detail?: string }[]): void {
  for (const c of checks) {
    console.log(`[${c.ok ? "PASS" : "FAIL"}] ${c.label}${c.detail ? ` (${c.detail})` : ""}`);
  }
  const passCount = checks.filter((c) => c.ok).length;
  console.log(`\n총 ${checks.length}건, PASS ${passCount}, FAIL ${checks.length - passCount}`);
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
}

main();
