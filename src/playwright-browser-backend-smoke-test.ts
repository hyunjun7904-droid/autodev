import { createPlaywrightBrowserBackend } from "./playwright-browser-backend";

// Playwright Browser Backend — 실제 브라우저 smoke test(Phase E Task E2).
//
// package.json의 스크립트 이름이 의도적으로 "test:" 접두사가 아니다("smoke-test"/
// "gpt-smoke-test"/"real-source-catalog-smoke-test"와 동일한 기존 관례) — Task 완료 전
// 필수로 실행하는 전체 회귀(`npm run test:*`)에는 포함되지 않는다. 이 스크립트는 실제
// Playwright(realChromiumLauncher, 기본값)로 진짜 브라우저를 실행한다 — 로컬에 Playwright
// 브라우저 바이너리(`npx playwright install`)가 설치돼 있어야 하며, 이 Task는 그 설치를
// 자동으로 수행하지 않는다(요구사항: "불필요하면 설치 범위를 확장하지 않는다"). 브라우저
// 바이너리가 없으면 이 스크립트는 그 사실을 명확히 보고하고 실패한다 — 실제 회귀 스위트
// (`npm run test:*`)는 이 스크립트에 의존하지 않으므로 그 실패가 회귀를 불안정하게
// 만들지 않는다.
//
// 로그인/결제/다운로드/업로드/production action은 전혀 수행하지 않는다 — 안정적인 공개
// 정적 페이지(example.com, IANA가 문서화 목적으로 유지하는 예약 도메인)를 한 번
// navigate해서 backend 전체 파이프라인(navigate → readPage → screenshot → dispose)이
// 실제로 동작하는지만 확인한다.

async function main(): Promise<void> {
  console.log("=== Playwright Browser Backend smoke test(실제 브라우저) ===");
  let backend: Awaited<ReturnType<typeof createPlaywrightBrowserBackend>> | undefined;
  try {
    backend = await createPlaywrightBrowserBackend({ headless: true });
    console.log("[OK] backend 생성(browser/context/page 실행) 성공");

    const nav = await backend.navigate("https://example.com/");
    console.log(`navigate: ok=${nav.ok}${nav.ok ? `, finalUrl=${nav.finalUrl}` : `, reason=${nav.reason}`}`);

    const read = await backend.readPage();
    console.log(`readPage: ok=${read.ok}${read.ok ? `, content length=${read.data?.content.length ?? 0}` : `, reason=${read.reason}`}`);

    const shot = await backend.screenshot();
    console.log(`screenshot: ok=${shot.ok}${shot.ok ? `, base64 length=${shot.data?.imageBase64.length ?? 0}` : `, reason=${shot.reason}`}`);

    const allOk = nav.ok && read.ok && shot.ok;
    if (!allOk) process.exitCode = 1;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[FAIL] 실제 브라우저 실행 실패: ${message}`);
    console.log(
      "참고: 로컬에 Playwright 브라우저 바이너리가 없으면 이런 오류가 납니다 — " +
        "`npx playwright install chromium`으로 설치할 수 있습니다(이 Task는 자동으로 설치하지 않습니다)."
    );
    process.exitCode = 1;
  } finally {
    if (backend) await backend.dispose().catch(() => {});
  }
}

main();
