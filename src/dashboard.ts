import { startDashboardServer, DEFAULT_PORT } from "./dashboard-server";
import { DASHBOARD_TITLE } from "./dashboard-html";

// Local Operations Dashboard — 실행 entry point (오토데브 대시보드 후속 개선, 윈도우 로그인
// 자동 실행 대상). 포트만 AUTODEV_DASHBOARD_PORT로 override할 수 있다 — host(127.0.0.1)는
// override 경로 자체가 없다(§ dashboard-server.ts).
//
// § 요구사항 19 — 중복 실행 방지. 윈도우 로그인 자동 실행(작업 스케줄러)과 사용자의 수동
// 실행이 겹칠 수 있으므로, 실제로 listen을 시도하기 전에 그 포트에 이미 "우리 자신의"
// 대시보드가 떠 있는지 먼저 확인한다:
//   - 이미 우리 대시보드가 응답하면(§ isOurDashboardRunning, GET /의 <title> 문자열로
//     식별) 새 서버를 띄우지 않고 exit code 0으로 조용히 종료한다(중복 실행 아님 — 정상
//     상황).
//   - 연결 자체가 안 되면(ECONNREFUSED 등) 포트가 비어있다는 뜻이므로 정상적으로 새
//     서버를 시작한다.
//   - 무언가 응답은 하지만 우리 대시보드처럼 보이지 않으면(다른 프로그램이 이 포트를
//     쓰고 있음) 절대 다른 포트로 조용히 넘어가지 않는다 — 바로가기/작업 스케줄러가
//     가리키는 주소가 예고 없이 바뀌면 안 되기 때문이다(§ 요구사항: "주소가 임의로
//     바뀌면 바탕화면 바로가기가 무의미해짐"). 이 경우 명확한 오류로 종료한다.
const PROBE_TIMEOUT_MS = 2_000;

export type PortCheckResult = "OURS" | "OTHER" | "FREE";

export async function checkExistingServer(port: number): Promise<PortCheckResult> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return "OTHER";
    const text = await res.text();
    return text.includes(`<title>${DASHBOARD_TITLE}</title>`) ? "OURS" : "OTHER";
  } catch {
    return "FREE";
  }
}

async function main(): Promise<void> {
  const portEnv = process.env.AUTODEV_DASHBOARD_PORT;
  const port = portEnv && portEnv.trim().length > 0 ? Number(portEnv) : DEFAULT_PORT;
  if (portEnv && Number.isNaN(port)) {
    throw new Error(`AUTODEV_DASHBOARD_PORT가 유효한 숫자가 아닙니다: ${portEnv}`);
  }

  const existing = await checkExistingServer(port);
  if (existing === "OURS") {
    console.log(`AutoDev Operations Dashboard(읽기 전용): 이미 http://127.0.0.1:${port}에서 정상 실행 중입니다 — 새 서버를 띄우지 않고 종료합니다.`);
    return;
  }
  if (existing === "OTHER") {
    console.error(
      `대시보드를 시작할 수 없습니다 — 포트 ${port}을(를) 다른 프로그램이 이미 사용 중입니다(우리 대시보드가 아닙니다). ` +
        `다른 포트를 자동으로 선택하지 않습니다(주소 고정 유지) — 그 프로그램을 종료하거나 AUTODEV_DASHBOARD_PORT로 다른 포트를 지정하세요.`
    );
    process.exitCode = 1;
    return;
  }

  const handle = await startDashboardServer({ port });
  console.log(`AutoDev Operations Dashboard(읽기 전용): ${handle.url}`);
}

// require.main===module 가드(§ run.ts/telegram-controller-main.ts와 동일한 관례) — 이
// 파일을 테스트가 import해도 실제 서버가 자동으로 시작되지 않는다.
if (require.main === module) {
  main().catch((err) => {
    console.error("Dashboard 시작 실패:", err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
