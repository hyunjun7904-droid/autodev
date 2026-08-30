import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installShutdownHandlers, runAbortController, startStopRequestPolling } from "./run";
import { requestStop, readStopRequestForPid } from "./runner-supervisor";

// AutoDev Core Maintenance — Canonical Stop Path(2026-08-31, JARVIS Task 5.3 실측 —
// "실행 중인 Developer/continuous run을 canonical하게 정상 중단할 수 없는 결함"). 이 파일을
// 만들며 직접 실측 확인한 사실: 이 환경(Windows)의 Node.js는 process.kill(pid, "SIGTERM"/
// "SIGINT")를 자기 자신에게도, 완전히 별도 프로세스에서 실제 spawn된 자식에게도 보내봤지만
// 등록된 handler를 한 번도 호출하지 않고 대상을 무조건 종료시켰다(3가지 방식 모두 재현) —
// 그래서 OS 신호 자체를 이 테스트의 검증 대상으로 삼지 않는다(신뢰성 있게 재현 가능한
// 대상이 아니다). 대신 실제 canonical stop 경로인 마커 파일 polling(§ run.ts
// startStopRequestPolling/runner-supervisor.ts requestStop)을 직접 검증한다 — 이것이 이제
// project-control-cli.js stop이 실제로 쓰는 경로다.
//
// runAbortController는 run.ts의 module-level singleton이라 한 번 abort()되면 되돌릴 수
// 없다 — "abort 안 됨"을 검증하는 시나리오를 먼저, "abort 됨"을 검증하는 시나리오를
// 마지막에 실행한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const logsDir = mkdtempSync(join(tmpdir(), "autodev-stop-request-tests-"));
  const adapterPath = "C:\\fake\\project\\.autodev\\manifest.json";
  const otherAdapterPath = "C:\\fake\\other-project\\.autodev\\manifest.json";
  const selfPid = process.pid;

  try {
    // 1) 마커가 아예 없으면 false(확인 불가/없음을 "중단하라"로 추측하지 않는다).
    check(
      "readStopRequestForPid: 마커 없음 → false",
      readStopRequestForPid(adapterPath, logsDir, selfPid) === false
    );

    // 2) 다른 pid를 대상으로 한 마커는 이 프로세스에 적용되지 않는다(§ race 방지 — 요청이
    //    이미 소비/무관해진 뒤 뜬 완전히 다른 writer가 stale 마커를 보고 스스로 중단하지
    //    않는다).
    requestStop(adapterPath, logsDir, "test: 다른 pid 대상", selfPid + 999);
    check(
      "readStopRequestForPid: 다른 pid 대상 마커는 false",
      readStopRequestForPid(adapterPath, logsDir, selfPid) === false
    );

    // 3) 다른 adapterPath(다른 project)의 마커는 이 project에 영향 없음(경로 자체가 다름).
    requestStop(otherAdapterPath, logsDir, "test: 다른 project 대상", selfPid);
    check(
      "readStopRequestForPid: 다른 project(adapterPath)의 마커는 이 project에 영향 없음",
      readStopRequestForPid(adapterPath, logsDir, selfPid) === false
    );

    // 4) startStopRequestPolling이 실제로 polling 중일 때, 무관한 마커들(위 2/3)이 떠 있어도
    //    아직 abort되지 않는다.
    installShutdownHandlers();
    const polling = startStopRequestPolling(adapterPath, logsDir, 30);
    await sleep(150);
    check(
      "startStopRequestPolling: 자신을 대상으로 하지 않은 마커만 있으면 abort 안 됨",
      runAbortController.signal.aborted === false
    );

    // 5) 이제 실제로 이 프로세스(selfPid)를 대상으로 한 stop 요청을 남기면, polling이 이를
    //    감지해 runAbortController.abort()를 실제로 호출하고 마커를 스스로 지운다.
    requestStop(adapterPath, logsDir, "test: 실제 stop 요청", selfPid);
    await sleep(150);
    check(
      "startStopRequestPolling: 자신을 대상으로 한 stop 요청을 감지하면 실제로 abort()됨",
      runAbortController.signal.aborted === true
    );
    check(
      "startStopRequestPolling: 소비한 마커는 스스로 지움(다음 무관한 writer가 stale 마커를 보지 않음)",
      readStopRequestForPid(adapterPath, logsDir, selfPid) === false
    );

    polling.stop();
  } finally {
    rmSync(logsDir, { recursive: true, force: true });
  }

  console.log("\n=== run.ts canonical stop path(marker polling) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
