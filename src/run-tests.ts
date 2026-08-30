import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installShutdownHandlers, runAbortController, startStopRequestPolling } from "./run";
import { requestStop, readStopRequestForPid, clearStopRequest } from "./runner-supervisor";

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
// PID 재사용 하드닝(2026-08-31, JARVIS 5.3 조사 중 확인된 결함 수정) — targetPid만으로
// 매칭하던 이전 버전은, stop 요청 대상이 이 요청과 무관한 사유로 먼저 죽어 marker가 소비되지
// 않고 남으면(orphan) 이후 OS가 그 PID를 재사용한 완전히 다른 프로세스를 잘못 중단시킬 수
// 있었다. requestStop()/readStopRequestForPid()는 이제 project-lock.ts의
// assessOwnerLiveness()(PID 재사용 탐지를 위해 이미 있는 PID+실제 OS 시작 시각 비교, 새 로직
// 없음)를 그대로 재사용해 (targetPid, targetProcessStartedAtMs) 쌍으로 대상을 식별한다 — 아래
// "PID 재사용 시뮬레이션" 시나리오가 이를 직접 검증한다.
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
  // acquireProjectLock()이 lock 생성 시 쓰는 것과 정확히 같은 자기 자신의 실제 시작 시각
  // 추정 공식(§ project-lock.ts acquireProjectLock)이다 — 별도 계산 로직을 새로 만들지
  // 않는다. assessOwnerLiveness()가 내부적으로 PowerShell로 재조회하는 실제 OS 시작 시각과
  // START_TIME_TOLERANCE_MS(5초) 이내로 일치해야 "동일 프로세스"로 인정된다(§
  // project-lock-tests.ts scenarioRealLivenessAssessment의 13번 검증과 동일한 근거).
  const realSelfStartedAtMs = Date.now() - Math.round(process.uptime() * 1000);
  // PID는 같지만(재사용을 흉내냄) 실제 시작 시각과는 크게(10분) 다른 값 — "다른 프로세스가
  // 나중에 같은 PID를 재사용했다"는 상황을 흉내낸다.
  const reusedPidMismatchedStartedAtMs = realSelfStartedAtMs - 600_000;

  try {
    // 1) 마커가 아예 없으면 false(확인 불가/없음을 "중단하라"로 추측하지 않는다).
    check(
      "readStopRequestForPid: 마커 없음 → false",
      readStopRequestForPid(adapterPath, logsDir, selfPid) === false
    );

    // 2) 다른 pid를 대상으로 한 마커는 이 프로세스에 적용되지 않는다(§ race 방지 — 요청이
    //    이미 소비/무관해진 뒤 뜬 완전히 다른 writer가 stale 마커를 보고 스스로 중단하지
    //    않는다). targetProcessStartedAtMs는 targetPid 비교에서 이미 걸러지므로 값 자체는
    //    무관하다.
    requestStop(adapterPath, logsDir, "test: 다른 pid 대상", selfPid + 999, realSelfStartedAtMs);
    check(
      "readStopRequestForPid: 다른 pid 대상 마커는 false",
      readStopRequestForPid(adapterPath, logsDir, selfPid) === false
    );

    // 3) 다른 adapterPath(다른 project)의 마커는 이 project에 영향 없음(경로 자체가 다름).
    requestStop(otherAdapterPath, logsDir, "test: 다른 project 대상", selfPid, realSelfStartedAtMs);
    check(
      "readStopRequestForPid: 다른 project(adapterPath)의 마커는 이 project에 영향 없음",
      readStopRequestForPid(adapterPath, logsDir, selfPid) === false
    );

    // 4) PID 재사용 시뮬레이션 — targetPid는 selfPid와 같지만 targetProcessStartedAtMs가
    //    실제 시작 시각과 크게 다르면(assessOwnerLiveness가 PID_REUSED_START_TIME_MISMATCH로
    //    STALE 판정) 이 marker는 "자신에 대한 stop 요청"으로 인정되지 않아야 한다 — 이것이
    //    이번에 수정한 결함의 핵심 회귀 방지 지점이다.
    requestStop(adapterPath, logsDir, "test: PID 재사용 시뮬레이션(동일 PID, 다른 start time)", selfPid, reusedPidMismatchedStartedAtMs);
    check(
      "readStopRequestForPid: 동일 PID + 다른 start time(PID 재사용 시뮬레이션) → false(stale marker로 판단, 매칭 아님)",
      readStopRequestForPid(adapterPath, logsDir, selfPid) === false
    );

    // 5) startStopRequestPolling이 실제로 polling 중일 때도, 위 4)의 PID-재사용-시뮬레이션
    //    marker(및 2/3의 무관한 marker)가 떠 있는 상태로는 abort되지 않는다 — "stale/orphan
    //    marker가 미래에 같은 PID를 재사용한 프로세스를 중단시키지 않는다"를 실제 polling
    //    loop 레벨에서 확인한다.
    // poll 간격을 넉넉히 잡는다(§ assessOwnerLiveness가 PID 일치 marker를 볼 때마다 실제
    // PowerShell round-trip을 하므로, 이전 값(30ms)처럼 촘촘하면 그 blocking 호출이 끝나지
    // 않은 채로 다음 tick이 곧바로 이어져 불필요하게 여러 번 spawn될 수 있다).
    installShutdownHandlers();
    const polling = startStopRequestPolling(adapterPath, logsDir, 200);
    await sleep(1_500);
    check(
      "startStopRequestPolling: PID는 같지만 start time이 다른 marker만 있으면 abort 안 됨(PID 재사용 오작동 방지)",
      runAbortController.signal.aborted === false
    );
    // 이 marker는 selfPid를 향하지만 identity 불일치로 절대 소비되지 않는다 — 다음
    // 시나리오에 영향을 주지 않도록 테스트가 직접 정리한다(운영 코드의 cleanup 책임이
    // 아니라 이 테스트의 정리 책임).
    clearStopRequest(adapterPath, logsDir);

    // 6) 이제 실제로 이 프로세스(selfPid, 실제 start time 일치)를 대상으로 한 stop 요청을
    //    남기면, polling이 이를 감지해 runAbortController.abort()를 실제로 호출하고 마커를
    //    스스로 지운다 — 기존 정상 stop 동작에 회귀가 없음을 확인한다.
    requestStop(adapterPath, logsDir, "test: 실제 stop 요청", selfPid, realSelfStartedAtMs);
    await sleep(1_500);
    check(
      "startStopRequestPolling: 동일 PID + 동일 start time인 stop 요청을 감지하면 실제로 abort()됨(정상 stop 회귀 없음)",
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
