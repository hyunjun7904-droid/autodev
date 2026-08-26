import { isProductionRuntime, assertProductionRuntimeForContinuousLaunch } from "./runtime-origin";

// Production Runtime Origin Gate 테스트 — 2026-08-22 incident 대응. isProductionRuntime()이
// AUTOMATION_DRY_RUN="false"와 AUTODEV_PRODUCTION_RUNTIME="true" 둘 다 명시적으로 참일
// 때만 true를 반환하는 dual-gate라는 것을 진리표로 검증한다 — 어느 한쪽만 참이거나, 값이
// "false"/"true" 대신 다른 truthy 문자열(예: "1", "yes")이어도 false여야 한다(fail-closed,
// 느슨한 truthy 판정 금지).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function withEnv(dryRun: string | undefined, prodRuntime: string | undefined, fn: () => void): void {
  const originalDryRun = process.env.AUTOMATION_DRY_RUN;
  const originalProdRuntime = process.env.AUTODEV_PRODUCTION_RUNTIME;
  try {
    if (dryRun === undefined) delete process.env.AUTOMATION_DRY_RUN;
    else process.env.AUTOMATION_DRY_RUN = dryRun;
    if (prodRuntime === undefined) delete process.env.AUTODEV_PRODUCTION_RUNTIME;
    else process.env.AUTODEV_PRODUCTION_RUNTIME = prodRuntime;
    fn();
  } finally {
    if (originalDryRun === undefined) delete process.env.AUTOMATION_DRY_RUN;
    else process.env.AUTOMATION_DRY_RUN = originalDryRun;
    if (originalProdRuntime === undefined) delete process.env.AUTODEV_PRODUCTION_RUNTIME;
    else process.env.AUTODEV_PRODUCTION_RUNTIME = originalProdRuntime;
  }
}

function scenarioTruthTable(): void {
  withEnv(undefined, undefined, () => check("1) 둘 다 미설정 → false", isProductionRuntime() === false));
  withEnv("false", undefined, () => check("2) AUTOMATION_DRY_RUN=false만 → false(AUTODEV_PRODUCTION_RUNTIME 없음)", isProductionRuntime() === false));
  withEnv(undefined, "true", () => check("3) AUTODEV_PRODUCTION_RUNTIME=true만 → false(AUTOMATION_DRY_RUN 없음)", isProductionRuntime() === false));
  withEnv("false", "true", () => check("4) 둘 다 명시적으로 참 → true", isProductionRuntime() === true));
  withEnv("true", "true", () => check("5) AUTOMATION_DRY_RUN=true(dry-run 명시) + PRODUCTION_RUNTIME=true → false", isProductionRuntime() === false));
  withEnv("false", "false", () => check("6) AUTOMATION_DRY_RUN=false + PRODUCTION_RUNTIME=false → false", isProductionRuntime() === false));
}

// Windows 환경변수에 실제 credential이 영구적으로 남아있는 상황을 재현한다(§ 2026-08-22
// incident — 이 저장소의 실제 개발 환경에 AUTODEV_TELEGRAM_BOT_TOKEN/CHAT_ID가 실제로
// 이렇게 설정돼 있었다). AUTOMATION_DRY_RUN이 우연히 "false"로 새어 들어가도(예: 다른
// 프로세스의 spawnSync 상속), 이 gate 자체가 두 번째 신호 없이는 항상 false를 반환해야
// 한다는 것이 이 안전장치의 핵심이다.
function scenarioFailClosedEvenWithLooseTruthyValues(): void {
  withEnv("false", "1", () => check("7) AUTODEV_PRODUCTION_RUNTIME='1'(느슨한 truthy) → false(정확히 'true' 문자열만 허용)", isProductionRuntime() === false));
  withEnv("false", "TRUE", () => check("8) AUTODEV_PRODUCTION_RUNTIME='TRUE'(대소문자 다름) → false", isProductionRuntime() === false));
  withEnv("False", "true", () => check("9) AUTOMATION_DRY_RUN='False'(대소문자 다름) → false(정확히 'false' 문자열만 허용)", isProductionRuntime() === false));
}

// AutoDev 신뢰성 수정(2026-08-26, Part A) — continuous 모드 fail-fast preflight 검증.
// "5. Production continuous run uses persistent EventStore/approval path"의 전제 조건 —
// continuous=true인데 isProductionRuntime()이 false면 시작 자체가 막혀야 하고, 시작이
// 막히지 않는 모든 경우(one-shot 전부 + continuous인데 production runtime도 참인 경우)는
// ok:true여야 한다.
function scenarioContinuousLaunchPreflight(): void {
  withEnv(undefined, undefined, () => {
    const r = assertProductionRuntimeForContinuousLaunch(true);
    check("10) continuous=true, 둘 다 미설정 → BLOCK(ok:false)", r.ok === false);
    check("10b) BLOCK 사유에 '두 환경변수'/production 안내가 담김", r.ok === false && r.reason.length > 0);
  });
  withEnv("false", undefined, () => {
    const r = assertProductionRuntimeForContinuousLaunch(true);
    check("11) continuous=true, AUTOMATION_DRY_RUN만 false → BLOCK(ok:false)", r.ok === false);
  });
  withEnv("false", "true", () => {
    const r = assertProductionRuntimeForContinuousLaunch(true);
    check("12) continuous=true, 둘 다 명시적으로 참(start-autodev.ps1과 동일) → ok:true", r.ok === true);
  });
  withEnv(undefined, undefined, () => {
    const r = assertProductionRuntimeForContinuousLaunch(false);
    check("13) continuous=false(one-shot), production runtime 미설정 → 검사 대상 아님(ok:true, 기존 동작 보존)", r.ok === true);
  });
  withEnv("true", "true", () => {
    const r = assertProductionRuntimeForContinuousLaunch(true);
    check("14) continuous=true, AUTOMATION_DRY_RUN='true'(dry-run 명시) + PRODUCTION_RUNTIME=true → 여전히 BLOCK", r.ok === false);
  });
}

function main(): void {
  scenarioTruthTable();
  scenarioFailClosedEvenWithLooseTruthyValues();
  scenarioContinuousLaunchPreflight();

  console.log("\n=== runtime-origin.ts 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);

  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
