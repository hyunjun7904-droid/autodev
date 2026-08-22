import { startDashboardServer } from "./dashboard-server";

// Local Operations Dashboard — 실행 entry point (Phase G Task G4.1, `npm run dashboard`).
// 포트만 AUTODEV_DASHBOARD_PORT로 override할 수 있다 — host(127.0.0.1)는 override 경로
// 자체가 없다(§ dashboard-server.ts).
async function main(): Promise<void> {
  const portEnv = process.env.AUTODEV_DASHBOARD_PORT;
  const port = portEnv && portEnv.trim().length > 0 ? Number(portEnv) : undefined;
  if (portEnv && (port === undefined || Number.isNaN(port))) {
    throw new Error(`AUTODEV_DASHBOARD_PORT가 유효한 숫자가 아닙니다: ${portEnv}`);
  }
  const handle = await startDashboardServer({ port });
  console.log(`AutoDev Operations Dashboard(읽기 전용): ${handle.url}`);
}

main().catch((err) => {
  console.error("Dashboard 시작 실패:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
