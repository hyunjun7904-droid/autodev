import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDashboardLog, pruneLogIfTooLarge } from "./dashboard-log";

// AutoDev 대시보드 서버 장애 원인분석·복구·하드닝 § 요구사항 12/13 — 구조화 로그 + 크기 제한
// 테스트. 실제 파일시스템(임시 디렉터리)에 직접 쓰고 읽어 검증한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-dashboard-log-"));
  tempDirs.push(dir);
  return dir;
}

function readLines(filePath: string): string[] {
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

function scenarioAppendWritesStructuredLine(): void {
  const dir = makeTempDir();
  const logPath = join(dir, "dashboard.log");
  appendDashboardLog(logPath, { event: "LISTENING", port: 4590 });
  const lines = readLines(logPath);
  check("한 줄 append됨", lines.length === 1);
  const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
  check("timestamp 필드 존재", typeof parsed.timestamp === "string" && parsed.timestamp.length > 0);
  check("pid 필드 존재", typeof parsed.pid === "number");
  check("event 필드가 그대로 보존됨", parsed.event === "LISTENING");
  check("port 필드가 그대로 보존됨", parsed.port === 4590);
}

function scenarioMultipleAppendsAccumulate(): void {
  const dir = makeTempDir();
  const logPath = join(dir, "dashboard.log");
  appendDashboardLog(logPath, { event: "A" });
  appendDashboardLog(logPath, { event: "B" });
  appendDashboardLog(logPath, { event: "C" });
  const lines = readLines(logPath);
  check("3번 append하면 3줄", lines.length === 3);
  check("순서 보존", JSON.parse(lines[0]).event === "A" && JSON.parse(lines[2]).event === "C");
}

function scenarioRotationOnSize(): void {
  const dir = makeTempDir();
  const logPath = join(dir, "dashboard.log");
  writeFileSync(logPath, "x".repeat(1000) + "\n", "utf-8");
  pruneLogIfTooLarge(logPath, 500);
  appendDashboardLog(logPath, { event: "AFTER_ROTATION" }, 500);
  const rotated = readFileSync(`${logPath}.1`, "utf-8");
  check("초과분은 .1 backup으로 회전됨", rotated.startsWith("xxxx"));
  const current = readLines(logPath);
  check("회전 후 현재 파일은 새 내용만 담음", current.length === 1 && JSON.parse(current[0]).event === "AFTER_ROTATION");
}

function scenarioNoRotationWhenUnderLimit(): void {
  const dir = makeTempDir();
  const logPath = join(dir, "dashboard.log");
  appendDashboardLog(logPath, { event: "SMALL" }, 5 * 1024 * 1024);
  appendDashboardLog(logPath, { event: "SMALL2" }, 5 * 1024 * 1024);
  const lines = readLines(logPath);
  check("한도 이내면 회전하지 않고 계속 누적됨", lines.length === 2);
}

function scenarioLogFailureDoesNotThrow(): void {
  const dir = makeTempDir();
  // logPath 자체를 디렉터리로 만들어(존재하지만 파일로 열 수 없음) append가 내부적으로
  // 실패하게 만든다 — 그래도 호출자에게 예외가 전파되지 않아야 한다(§ 요구사항: 로깅 실패가
  // 새로운 크래시 원인이 되지 않아야 함).
  const asDir = join(dir, "not-a-file.log");
  require("node:fs").mkdirSync(asDir);
  let threw = false;
  try {
    appendDashboardLog(asDir, { event: "SHOULD_NOT_THROW" });
  } catch {
    threw = true;
  }
  check("로그 대상이 디렉터리라 쓰기 실패해도 throw하지 않음", !threw);
}

function main(): void {
  try {
    scenarioAppendWritesStructuredLine();
    scenarioMultipleAppendsAccumulate();
    scenarioRotationOnSize();
    scenarioNoRotationWhenUnderLimit();
    scenarioLogFailureDoesNotThrow();
  } finally {
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // OS temp 정리 실패는 테스트 결과에 영향 없음.
      }
    }
  }

  console.log("\n=== dashboard-log 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
