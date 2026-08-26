import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoundStatusReporterForTests, readRoundStatus, isRoundStatusLive } from "./round-status";

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function scenarioReportWritesAtomicallyAndReadBackMatches(): void {
  const dir = mkdtempSync(join(tmpdir(), "round-status-"));
  const filePath = join(dir, "round-status.json");
  const reporter = createRoundStatusReporterForTests(filePath);

  reporter.report({ runId: "r1", taskId: "T1", round: 1, maxRounds: 20, stage: "DISCOVERY" });
  const first = readRoundStatus(filePath);
  check("최초 report 이후 파일이 실제로 생성됨", existsSync(filePath));
  check("round=1, maxRounds=20, stage=DISCOVERY로 읽힘", first?.round === 1 && first?.maxRounds === 20 && first?.stage === "DISCOVERY");
  check("updatedAt이 실제 ISO 시각으로 채워짐", typeof first?.updatedAt === "string" && !Number.isNaN(Date.parse(first!.updatedAt)));

  reporter.report({ runId: "r1", taskId: "T1", round: 4, maxRounds: 20, stage: "LOCKED" });
  const second = readRoundStatus(filePath);
  check("다음 report가 이전 값을 덮어씀(round=4, stage=LOCKED)", second?.round === 4 && second?.stage === "LOCKED");
  check("파일에 tmp 잔여물이 남지 않음(atomic rename)", readFileSync(filePath, "utf-8").includes('"round": 4'));

  rmSync(dir, { recursive: true, force: true });
}

function scenarioReadRoundStatusToleratesMissingOrCorruptFile(): void {
  const dir = mkdtempSync(join(tmpdir(), "round-status-"));
  const missingPath = join(dir, "does-not-exist.json");
  check("파일이 없으면 undefined(추측하지 않음)", readRoundStatus(missingPath) === undefined);
  rmSync(dir, { recursive: true, force: true });
}

function scenarioIsRoundStatusLiveMatchesRunAndTaskAndFreshness(): void {
  const now = Date.parse("2026-08-27T10:00:00.000Z");
  const status = { runId: "r1", taskId: "T1", round: 3, maxRounds: 20, stage: "DISCOVERY" as const, updatedAt: new Date(now - 5_000).toISOString() };
  check("같은 runId/taskId + 최근이면 live=true", isRoundStatusLive(status, "r1", "T1", now, 60_000));
  check("다른 runId면 live=false(다른 run의 오래된 값 오인 방지)", !isRoundStatusLive(status, "r2", "T1", now, 60_000));
  check("다른 taskId면 live=false", !isRoundStatusLive(status, "r1", "T2", now, 60_000));
  check("maxAgeMs를 초과하면 live=false(오래된 값을 진행 중으로 오인하지 않음)", !isRoundStatusLive(status, "r1", "T1", now + 120_000, 60_000));
}

function main(): void {
  scenarioReportWritesAtomicallyAndReadBackMatches();
  scenarioReadRoundStatusToleratesMissingOrCorruptFile();
  scenarioIsRoundStatusLiveMatchesRunAndTaskAndFreshness();

  console.log("\n=== round-status 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
