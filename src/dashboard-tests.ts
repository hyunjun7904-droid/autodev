import { createServer } from "node:http";
import type { Server } from "node:http";
import { checkExistingServer } from "./dashboard";
import { startDashboardServer } from "./dashboard-server";

// 오토데브 대시보드 후속 개선 § 요구사항 19 — dashboard.ts의 중복 실행 방지 판정
// (checkExistingServer)을 검증한다. 이 파일은 require.main===module 가드(§ dashboard.ts)
// 덕분에 dashboard.ts를 import해도 실제 서버가 자동으로 시작되지 않는다는 사실에 의존한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

async function scenarioFreePortDetected(): Promise<void> {
  // 어떤 서버도 없는 포트 — OS가 빈 포트를 골라주게 한 뒤 즉시 닫아서 "확실히 비어있는
  // 포트 번호"를 얻는다.
  const probe = await startDashboardServer({ port: 0 });
  const freePort = probe.port;
  await probe.close();

  const result = await checkExistingServer(freePort);
  check("빈 포트는 FREE로 판정됨", result === "FREE");
}

async function scenarioOurOwnDashboardDetected(): Promise<void> {
  const handle = await startDashboardServer({ port: 0 });
  try {
    const result = await checkExistingServer(handle.port);
    check("실제 우리 대시보드가 떠 있으면 OURS로 판정됨", result === "OURS");
  } finally {
    await handle.close();
  }
}

async function scenarioOtherProgramDetected(): Promise<void> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("this is not the autodev dashboard");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    const result = await checkExistingServer(port);
    check("우리 대시보드가 아닌 다른 프로그램이 그 포트를 쓰고 있으면 OTHER로 판정됨", result === "OTHER");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function main(): Promise<void> {
  await scenarioFreePortDetected();
  await scenarioOurOwnDashboardDetected();
  await scenarioOtherProgramDetected();

  console.log("\n=== dashboard(entry point) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
