import { runAutodevOnce } from "./autodev";
import { MOVAN_PROJECT_MANIFEST } from "./project-manifests/movan";
import { log } from "./logger";

// MOVAN 전용 AutoDev 진입점(Phase A Task A7).
//
// autodev.ts(AutoDev Core)는 이제 어떤 프로젝트를 개발하는지 전혀 모른다 — runAutodevOnce()는
// ProjectManifest를 필수로 요구하고, 지정하지 않으면 즉시 throw한다(silent MOVAN fallback
// 없음). 이 파일이 "나는 MOVAN을 실행한다"고 명시적으로 MOVAN_PROJECT_MANIFEST를 조립해
// 넘겨주는 유일한 자리다 — 그래서 실제 MOVAN 운용(start-autodev.ps1 → node dist/run-movan.js)은
// 기존과 100% 동일하게 동작한다. 프로세스 진입점 로직(main()/SIGINT 처리/require.main===module
// 가드)도 이전에는 autodev.ts에 있었지만, Core가 자기 실행 방식을 알 필요가 없으므로 이
// 파일로 옮겼다.
//
// 다른 프로젝트(예: fixture, 향후 BILLION)를 실행하려면 이 파일과 같은 자리에 별도의
// run-<project>.ts를 만들어 그 프로젝트의 ProjectManifest를 조립해 넘기면 된다 — autodev.ts는
// 손댈 필요가 없다.

let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  console.log("\n[run-movan] SIGINT 수신 — 종료합니다.");
});

async function main(): Promise<void> {
  log("MOVAN AutoDev 시작", { AUTOMATION_DRY_RUN: process.env.AUTOMATION_DRY_RUN ?? "(unset)" });
  const result = await runAutodevOnce({ manifest: MOVAN_PROJECT_MANIFEST });
  console.log(`[run-movan] 종료: outcome=${result.outcome}${result.reason ? `, reason=${result.reason}` : ""}`);
  if (interrupted) {
    console.log("[run-movan] 사용자 중단 — 종료");
  }
}

// require.main===module 가드 — 직접 실행될 때만 main()을 돌린다. 테스트에서 이 파일을
// import하는 경우는 없지만(항상 dist/run-movan.js를 별도 프로세스로 spawn해서만 다룸),
// 다른 Core 파일들과 동일한 안전 관례를 유지한다.
if (require.main === module) {
  main().catch((e) => {
    console.error("[run-movan] 처리되지 않은 오류로 종료:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
