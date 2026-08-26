import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isProductionRuntime } from "./runtime-origin";

// AutoDev 신뢰성 보완(2026-08-27, "현재 개발 라운드 대시보드 실시간 표시") — 대시보드
// 후속 개선 § 요구사항 13("현재 개발 라운드/최대 개발 라운드")을 위한 최소 live scratch
// 파일이다. claude-developer.ts의 internal round loop는 한 번의 runDeveloperTaskViaSafeExecutor
// 호출(수십 초~2분 걸리는 claude CLI 왕복을 최대 20라운드까지 반복) 동안 EventStore에 아무
// event도 남기지 않는다(각 round는 그 호출이 끝나야만 알 수 있는 결과다) — 그래서 이 호출이
// "진행 중인 동안" 대시보드가 보여줄 자료가 구조적으로 없다. 이 파일은 그 간극만 메운다:
// 매 round 시작 직전(§ claude-developer.ts opts.onRoundStart) round/maxRounds/stage 4개
// 원시값만 파일 하나에 덮어쓴다 — EventStore(감사 기록)에는 전혀 개입하지 않고, 이미
// problem-memory.ts/usage-ledger.ts가 쓰는 것과 동일한 same-directory temp + atomic
// rename 패턴을 그대로 재사용한다(새 저장 방식을 만들지 않는다). 이 파일의 내용은 순수
// observability다 — 어떤 production 판정도 이 파일을 다시 읽지 않는다(대시보드만 읽는다).

export interface RoundStatusSnapshot {
  runId: string;
  taskId: string;
  round: number;
  maxRounds: number;
  stage: "DISCOVERY" | "LOCKED";
  updatedAt: string;
}

// usage-ledger.ts RUNTIME_USAGE_LEDGER_DIR/problem-memory.ts RUNTIME_PROBLEM_MEMORY_DIR와
// 동일한 위치 계산 방식 — AutoDev 자신의 runtime data로 logs/ 아래(이미 .gitignore 대상)에
// 둔다. project별로 나누지 않는다 — AutoDev는 한 번에 하나의 project만 실행하고(§
// dashboard-snapshot-provider.ts "AutoDev는 한 번에 하나의 run만 실행"과 동일한 전제), 이
// 값은 "지금 이 순간의 진행 상황" 하나만 의미 있으면 충분하다(과거 이력을 쌓지 않는다).
export const RUNTIME_ROUND_STATUS_PATH = join(__dirname, "..", "logs", "round-status.json");

export interface RoundStatusReporter {
  report(info: Omit<RoundStatusSnapshot, "updatedAt">): void;
}

function writeAtomic(filePath: string, data: RoundStatusSnapshot): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, filePath);
}

function createNoopReporter(): RoundStatusReporter {
  return { report: () => {} };
}

function createFileReporter(filePath: string): RoundStatusReporter {
  return {
    report(info: Omit<RoundStatusSnapshot, "updatedAt">): void {
      try {
        writeAtomic(filePath, { ...info, updatedAt: new Date().toISOString() });
      } catch {
        // 순수 관측용 — 기록 실패가 실제 개발을 막아서는 안 된다(§ 요구사항 20).
      }
    },
  };
}

/** production 여부에 따라 file/no-op을 선택한다(event-store.ts/usage-ledger.ts/
 *  problem-memory.ts와 동일한 fail-closed 원칙) — 테스트가 실제 운용 round-status 파일을
 *  건드리지 않는다. 테스트가 파일 동작 자체를 검증하려면 filePath를 명시적으로 override한
 *  createFileReporter를 통해서만 한다(§ createRoundStatusReporterForTests). */
export function selectDefaultRoundStatusReporter(filePath: string = RUNTIME_ROUND_STATUS_PATH): RoundStatusReporter {
  if (!isProductionRuntime()) return createNoopReporter();
  return createFileReporter(filePath);
}

/** 테스트 전용 — production 게이트를 우회해 실제 파일에 쓰는 reporter를 명시적으로
 *  만든다(항상 임시 경로로 호출해야 한다). 운용 호출부는 이 함수를 쓰지 않는다. */
export function createRoundStatusReporterForTests(filePath: string): RoundStatusReporter {
  return createFileReporter(filePath);
}

function isRoundStatusSnapshot(v: unknown): v is RoundStatusSnapshot {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.runId === "string" &&
    typeof r.taskId === "string" &&
    typeof r.round === "number" &&
    typeof r.maxRounds === "number" &&
    (r.stage === "DISCOVERY" || r.stage === "LOCKED") &&
    typeof r.updatedAt === "string"
  );
}

/**
 * 대시보드 전용 읽기 — event-store.ts/problem-memory.ts의 다른 대시보드 read helper와
 * 동일하게 production 여부와 무관하게 항상 실제 파일을 읽는다(대시보드는 별도 읽기 전용
 * 프로세스다). 파일이 없거나 손상됐으면(추측하지 않고) undefined를 반환한다.
 */
export function readRoundStatus(filePath: string = RUNTIME_ROUND_STATUS_PATH): RoundStatusSnapshot | undefined {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) return undefined;
  try {
    const raw = readFileSync(resolved, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    return isRoundStatusSnapshot(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 이 status가 지금 보여줄 snapshot(runId/taskId)과 실제로 일치하고, "충분히 최근"인지
 *  판정한다 — 다른(이미 끝난) run/task의 오래된 round 상태를 지금 진행 중인 것처럼 잘못
 *  보여주지 않기 위함이다(§ 요구사항 17 "실제 자료 없이 추측해서 판단하지 않는다"). */
export function isRoundStatusLive(status: RoundStatusSnapshot, runId: string, taskId: string, now: number, maxAgeMs: number): boolean {
  if (status.runId !== runId || status.taskId !== taskId) return false;
  const age = now - Date.parse(status.updatedAt);
  return Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
}
