import { runAutodevOnce } from "./autodev";
import { loadProjectAdapter } from "./project-adapter-loader";
import { log } from "./logger";

// AutoDev 범용 진입점(Phase B Task B3 — run-movan.ts 대체, Phase C Task C1 — project adapter
// data-only 전환).
//
// 이 파일은 어떤 프로젝트를 개발하는지 전혀 모른다 — --project <path> 커맨드라인 인자
// 또는 AUTODEV_PROJECT_ADAPTER 환경변수로 명시된 project config(JSON 데이터 파일) 경로를
// project-adapter-loader.ts에 넘겨 ProjectManifest를 얻고, 그것을 runAutodevOnce()에
// 그대로 전달한다. 경로가 없거나, .json이 아니거나, 내용이 스키마를 어기면 즉시 실패한다
// — 어떤 기본 프로젝트로도 조용히 fallback하지 않는다. project-adapter-loader.ts는 이
// JSON을 fs.readFileSync+JSON.parse로만 읽는다 — require()/import()/eval() 등으로 프로젝트가
// 제공한 코드를 실행하지 않는다(§ project-adapter-loader.ts 상단 주석).
//
// 특정 프로젝트를 실행하려면: AUTODEV_PROJECT_ADAPTER(또는 --project)에 그 프로젝트 저장소가
// 소유한 project config(예: <project-repo>/.autodev/manifest.json)의 절대경로를 지정한다 —
// 그 프로젝트 쪽이 소유하는 wrapper 스크립트가 이 경로를 조립해 넘기는 방식을 권장한다. 새
// 프로젝트를 붙이려면 그 프로젝트가 같은 JSON 스키마(project-adapter-loader.ts 참고)를 따르는
// project config를 자신의 저장소 안에 두고 그 경로를 지정하면 된다 — 이 파일은 손댈 필요가 없다.

function resolveAdapterPathFromArgs(): string | undefined {
  const idx = process.argv.indexOf("--project");
  if (idx !== -1 && typeof process.argv[idx + 1] === "string" && process.argv[idx + 1].length > 0) {
    return process.argv[idx + 1];
  }
  const fromEnv = process.env.AUTODEV_PROJECT_ADAPTER;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv;
  return undefined;
}

let interrupted = false;
process.on("SIGINT", () => {
  interrupted = true;
  console.log("\n[run] SIGINT 수신 — 종료합니다.");
});

async function main(): Promise<void> {
  const manifest = loadProjectAdapter(resolveAdapterPathFromArgs());
  log("AutoDev 시작", { project: manifest.projectId, AUTOMATION_DRY_RUN: process.env.AUTOMATION_DRY_RUN ?? "(unset)" });
  const result = await runAutodevOnce({ manifest });
  console.log(`[run] 종료: outcome=${result.outcome}${result.reason ? `, reason=${result.reason}` : ""}`);
  if (interrupted) {
    console.log("[run] 사용자 중단 — 종료");
  }
}

// require.main===module 가드 — 직접 실행될 때만 main()을 돌린다.
if (require.main === module) {
  main().catch((e) => {
    console.error("[run] 처리되지 않은 오류로 종료:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
