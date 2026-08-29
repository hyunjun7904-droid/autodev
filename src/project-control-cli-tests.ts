import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseArg,
  getProjectControlStatus,
  formatProjectControlStatus,
} from "./project-control-cli";
import { engageMaintenancePause, clearMaintenancePause, runnerSupervisorLockFilePath } from "./runner-supervisor";
import type { ProjectManifest } from "./project-manifest";
import type { ProjectRuntimeLiveness } from "./project-lock";

// AutoDev Core Maintenance — Canonical Project Control CLI(Category C) 테스트. 이 CLI는
// project-lock.ts/runner-supervisor.ts/dashboard-supervisor.ts에 이미 있고 각자 테스트된
// 순수 함수만 배선하므로, 여기서는 "그 배선이 정확한가"(올바른 경로/올바른 인자로 호출되는가)
// 만 검증한다 — lock/liveness 판정 로직 자체의 회귀는 project-lock-tests.ts/
// dashboard-supervisor-tests.ts가 전담한다(중복 검증하지 않는다). 실제 프로세스/실제
// project adapter는 전혀 쓰지 않는다 — 모든 fs 접근은 OS 임시 디렉터리 안에서만 일어난다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function makeTempLogsDir(): string {
  return mkdtempSync(join(tmpdir(), "project-control-cli-tests-"));
}

const FAKE_ADAPTER_PATH = "C:/fake/project/.autodev/manifest.json";

function fakeManifest(): ProjectManifest {
  return {
    projectId: "fake-project",
    projectName: "Fake Project",
    targetProjectRoot: "C:/fake/project",
    statePath: "C:/fake/project/.autodev/project-state.json",
    taskRegistry: [],
    developerInstructions: "",
    reviewInstructions: "",
    reviewScopeDirs: [],
    executionPolicy: { allowedReadPrefixes: [], allowedWritePrefixes: [], allowedCommands: [] },
  };
}

function scenarioParseArg(): void {
  check("parseArg: 지정된 flag 다음 값을 반환", parseArg(["--project", "/x/y", "--reason", "test"], "--project") === "/x/y");
  check("parseArg: 없는 flag는 undefined", parseArg(["--project", "/x/y"], "--reason") === undefined);
  check("parseArg: flag가 마지막에 값 없이 끝나면 undefined", parseArg(["--project"], "--project") === undefined);
}

function scenarioMaintenancePauseReflectedInStatus(): void {
  const logsDir = makeTempLogsDir();
  try {
    const before = getProjectControlStatus(FAKE_ADAPTER_PATH, logsDir, {
      loadProjectAdapter: () => fakeManifest(),
      inspectProjectRuntimeLiveness: () => ({ present: false }),
    });
    check("status: 최초에는 Maintenance Pause 비활성", before.maintenancePaused === false);

    engageMaintenancePause(FAKE_ADAPTER_PATH, logsDir, "테스트 사유");
    const afterEngage = getProjectControlStatus(FAKE_ADAPTER_PATH, logsDir, {
      loadProjectAdapter: () => fakeManifest(),
      inspectProjectRuntimeLiveness: () => ({ present: false }),
    });
    check("status: engageMaintenancePause 후 ACTIVE로 반영됨", afterEngage.maintenancePaused === true);
    check("status: format 출력에 ACTIVE 표시", formatProjectControlStatus(afterEngage).includes("Maintenance Pause: ACTIVE"));

    clearMaintenancePause(FAKE_ADAPTER_PATH, logsDir);
    const afterClear = getProjectControlStatus(FAKE_ADAPTER_PATH, logsDir, {
      loadProjectAdapter: () => fakeManifest(),
      inspectProjectRuntimeLiveness: () => ({ present: false }),
    });
    check("status: clearMaintenancePause 후 다시 inactive로 반영됨", afterClear.maintenancePaused === false);
  } finally {
    rmSync(logsDir, { recursive: true, force: true });
  }
}

function scenarioSupervisorLockReflectedInStatus(): void {
  const logsDir = makeTempLogsDir();
  try {
    const noLock = getProjectControlStatus(FAKE_ADAPTER_PATH, logsDir, {
      loadProjectAdapter: () => fakeManifest(),
      inspectProjectRuntimeLiveness: () => ({ present: false }),
    });
    check("status: supervisor lock 파일이 없으면 not running", noLock.supervisor.action === "PROCEED");
    check("status: format 출력에 not running 표시", formatProjectControlStatus(noLock).includes("Supervisor: not running"));

    const lockPath = runnerSupervisorLockFilePath(FAKE_ADAPTER_PATH, logsDir);
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: 424242, adapterPath: FAKE_ADAPTER_PATH, startedAt: new Date().toISOString() }), "utf-8");

    const aliveResult = getProjectControlStatus(FAKE_ADAPTER_PATH, logsDir, {
      loadProjectAdapter: () => fakeManifest(),
      inspectProjectRuntimeLiveness: () => ({ present: false }),
      isPidAlive: (pid) => pid === 424242,
    });
    check("status: isPidAlive가 true를 반환하면 RUNNING으로 판정", aliveResult.supervisor.action === "ALREADY_RUNNING");
    check("status: format 출력에 RUNNING 표시", formatProjectControlStatus(aliveResult).includes("Supervisor: RUNNING"));

    const deadResult = getProjectControlStatus(FAKE_ADAPTER_PATH, logsDir, {
      loadProjectAdapter: () => fakeManifest(),
      inspectProjectRuntimeLiveness: () => ({ present: false }),
      isPidAlive: () => false,
    });
    check("status: isPidAlive가 false를 반환하면 stale lock으로 판정(not running)", deadResult.supervisor.action === "PROCEED");
  } finally {
    rmSync(logsDir, { recursive: true, force: true });
  }
}

function scenarioProjectLockStatusVariants(): void {
  const logsDir = makeTempLogsDir();
  try {
    const absent = getProjectControlStatus(FAKE_ADAPTER_PATH, logsDir, {
      loadProjectAdapter: () => fakeManifest(),
      inspectProjectRuntimeLiveness: () => ({ present: false }),
    });
    check("status: project lock 없음이 그대로 반영됨", absent.projectLock.present === false && !("error" in absent.projectLock));
    check("status: format 출력에 '없음' 표시", formatProjectControlStatus(absent).includes("Project Lock: 없음"));

    const present: ProjectRuntimeLiveness = {
      present: true,
      pid: 12345,
      ownerKind: "local-human-approval",
      taskId: "5.3",
      liveness: { verdict: "ALIVE" },
    };
    const presentResult = getProjectControlStatus(FAKE_ADAPTER_PATH, logsDir, {
      loadProjectAdapter: () => fakeManifest(),
      inspectProjectRuntimeLiveness: () => present,
    });
    check("status: project lock 보유자 정보가 그대로 반영됨", presentResult.projectLock.present === true);
    const formatted = formatProjectControlStatus(presentResult);
    check("status: format 출력에 pid 포함", formatted.includes("pid=12345"));
    check("status: format 출력에 ownerKind 포함", formatted.includes("ownerKind=local-human-approval"));
    check("status: format 출력에 taskId 포함", formatted.includes("taskId=5.3"));
    check("status: format 출력에 liveness verdict 포함", formatted.includes("liveness=ALIVE"));

    const brokenAdapter = getProjectControlStatus(FAKE_ADAPTER_PATH, logsDir, {
      loadProjectAdapter: () => {
        throw new Error("MANIFEST_NOT_FOUND");
      },
    });
    check(
      "status: project adapter를 읽을 수 없으면 project lock을 '없음'으로 조용히 단정하지 않고 오류로 구분함",
      "error" in brokenAdapter.projectLock && brokenAdapter.projectLock.error === "MANIFEST_NOT_FOUND"
    );
    check("status: format 출력에 확인 불가 표시", formatProjectControlStatus(brokenAdapter).includes("확인 불가"));
  } finally {
    rmSync(logsDir, { recursive: true, force: true });
  }
}

function main(): void {
  scenarioParseArg();
  scenarioMaintenancePauseReflectedInStatus();
  scenarioSupervisorLockReflectedInStatus();
  scenarioProjectLockStatusVariants();

  console.log("\n=== project-control-cli 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
