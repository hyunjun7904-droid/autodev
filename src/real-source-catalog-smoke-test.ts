import { REAL_OFFICIAL_SOURCE_CATALOG } from "./real-source-catalog";
import { discoverCapability } from "./discovery-orchestrator";
import type { CapabilityRequirement } from "./capability-resolver";

// Real Official Source Catalog — 실제 네트워크 smoke test(Phase D Task D5).
//
// package.json의 스크립트 이름이 의도적으로 "test:" 접두사가 아니다("smoke-test"/
// "gpt-smoke-test"와 동일한 기존 관례) — Task 완료 전 필수로 실행하는 전체 회귀
// (`npm run test:*`)에는 포함되지 않는다. 실제 GitHub API(api.github.com)에 네트워크
// 요청을 보내므로, 외부 API 장애/rate limit이 이 스크립트를 실패시킬 수 있지만 그것이
// deterministic 회귀 테스트 스위트를 불안정하게 만들지는 않는다(요구사항: "외부 장애가
// 전체 회귀 테스트를 불안정하게 만들지 않는다").
//
// 이 스크립트는 어떤 파일도 쓰거나 다운로드/설치/실행하지 않는다 — GET 요청으로 metadata만
// 조회한다.

async function main(): Promise<void> {
  console.log("=== Real Official Source Catalog smoke test(실제 네트워크) ===");
  console.log(`catalog entries: ${REAL_OFFICIAL_SOURCE_CATALOG.length}건`);

  const scenarios: { label: string; requirement: CapabilityRequirement }[] = [
    { label: "ai_model domain (Anthropic SDK + MCP servers)", requirement: { id: "smoke-ai", reason: "Claude/Anthropic 공식 SDK/MCP 서버 후보가 필요함" } },
    { label: "browser_automation domain (Puppeteer)", requirement: { id: "smoke-browser", reason: "puppeteer로 브라우저 자동화가 필요함" } },
  ];

  let anyRan = false;
  for (const { label, requirement } of scenarios) {
    console.log(`\n--- ${label} ---`);
    try {
      const result = await discoverCapability(requirement, REAL_OFFICIAL_SOURCE_CATALOG);
      anyRan = true;
      console.log(`status: ${result.status}`);
      console.log(`queriedSourceIds: ${result.queriedSourceIds.join(", ") || "(none)"}`);
      console.log(`reason: ${result.reason}`);
      if (result.trusted?.selected) {
        console.log(`selected candidateId: ${result.trusted.selected.candidateId} (official=${result.trusted.selected.official})`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`[예외] ${label}: ${message}`);
    }
  }

  console.log(
    "\n참고: 이 스크립트의 결과는 정보 제공용이다 — 외부 GitHub API 장애/rate limit로 실패할 수 " +
      "있으며, 그 실패가 npm run test:* 회귀 스위트에는 영향을 주지 않는다(별도 스크립트)."
  );
  if (!anyRan) process.exitCode = 1;
}

main();
