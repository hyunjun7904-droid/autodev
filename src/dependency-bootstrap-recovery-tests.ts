import {
  isPureLockfileMissingFailure,
  hasApprovedLockfileInstallCapability,
  attemptDependencyBootstrapRecovery,
} from "./dependency-bootstrap-recovery";
import type { DependencyFinding } from "./dependency-scanner";
import type { AllowedCommandSpec } from "./project-policy";
import type { ExecutorResult, ExecutorAction } from "./safe-executor";

// Dependency Bootstrap Technical Auto-Recovery — 단위 테스트(순수 함수만 다룬다, 파일시스템/
// 네트워크/실제 SafeExecutorContext 없음 — validateAndExecute는 매 시나리오마다 가짜 함수로
// 주입한다).

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const LOCKFILE_MISSING: DependencyFinding = {
  file: "package-lock.json",
  kind: "lockfile-missing",
  severity: "block",
  detail: "test",
};
const VULN_HIGH: DependencyFinding = {
  file: "package-lock.json",
  packageName: "evil-pkg",
  kind: "vulnerability-high",
  severity: "block",
  detail: "test",
};
const APPROVED_COMMAND: AllowedCommandSpec = { cwd: "root", command: "npm", args: ["install", "--package-lock-only", "--ignore-scripts"] };

function scenarioIsPureLockfileMissingFailure(): void {
  check("빈 findings: false", !isPureLockfileMissingFailure([]));
  check("undefined findings: false", !isPureLockfileMissingFailure(undefined));
  check("lockfile-missing 단독 1건: true", isPureLockfileMissingFailure([LOCKFILE_MISSING]));
  check("lockfile-missing 단독 2건(여러 디렉터리): true", isPureLockfileMissingFailure([LOCKFILE_MISSING, { ...LOCKFILE_MISSING, file: "packages/a/package-lock.json" }]));
  check("lockfile-missing + 다른 finding 혼합: false(순수 기술적 상태 아님)", !isPureLockfileMissingFailure([LOCKFILE_MISSING, VULN_HIGH]));
  check("다른 finding만 있음: false", !isPureLockfileMissingFailure([VULN_HIGH]));
}

function scenarioHasApprovedLockfileInstallCapability(): void {
  check("정확한 command가 있으면 true", hasApprovedLockfileInstallCapability({ allowedCommands: [APPROVED_COMMAND] }));
  check("allowedCommands가 비어있으면 false", !hasApprovedLockfileInstallCapability({ allowedCommands: [] }));
  check(
    "다른 npm run 명령만 있으면 false(install 명령 자체가 없음)",
    !hasApprovedLockfileInstallCapability({ allowedCommands: [{ cwd: "root", command: "npm", args: ["run", "build"] }] })
  );
  check(
    "args 순서/개수가 다르면 false(정확히 같은 형태만 인정)",
    !hasApprovedLockfileInstallCapability({ allowedCommands: [{ cwd: "root", command: "npm", args: ["install", "--ignore-scripts", "--package-lock-only"] }] })
  );
  check(
    "cwd가 root가 아니면 false",
    !hasApprovedLockfileInstallCapability({ allowedCommands: [{ cwd: "apps/web", command: "npm", args: ["install", "--package-lock-only", "--ignore-scripts"] }] })
  );
}

function fakeExecutor(handler: (action: ExecutorAction) => ExecutorResult): { validateAndExecute: (action: ExecutorAction) => Promise<ExecutorResult>; calls: ExecutorAction[] } {
  const calls: ExecutorAction[] = [];
  return {
    calls,
    validateAndExecute: async (action: ExecutorAction) => {
      calls.push(action);
      return handler(action);
    },
  };
}

async function scenarioAttemptRecovery(): Promise<void> {
  const policyWithCapability = { allowedCommands: [APPROVED_COMMAND] };
  const policyWithoutCapability = { allowedCommands: [] as AllowedCommandSpec[] };

  // 1) verdict가 BLOCK이 아니면(예: HUMAN_REVIEW_REQUIRED) 절대 개입하지 않는다 — 실행기를
  // 아예 호출하지 않는다(진짜 사람 판단이 필요한 경우를 자동으로 건드리지 않음).
  {
    const exec = fakeExecutor(() => ({ ok: true, action: "RUN_COMMAND" }));
    const outcome = await attemptDependencyBootstrapRecovery("HUMAN_REVIEW_REQUIRED", [LOCKFILE_MISSING], policyWithCapability, exec);
    check("1) verdict!=BLOCK: attempted=false", outcome.attempted === false);
    check("1) verdict!=BLOCK: 실행기 호출 없음", exec.calls.length === 0);
  }

  // 2) lockfile-missing 외 다른 finding이 섞여 있으면 절대 개입하지 않는다(진짜 공급망
  // 위험은 이 자동복구로 절대 우회되지 않는다).
  {
    const exec = fakeExecutor(() => ({ ok: true, action: "RUN_COMMAND" }));
    const outcome = await attemptDependencyBootstrapRecovery("BLOCK", [LOCKFILE_MISSING, VULN_HIGH], policyWithCapability, exec);
    check("2) 다른 finding 혼합: attempted=false", outcome.attempted === false);
    check("2) 다른 finding 혼합: 실행기 호출 없음(취약점 자동 우회 금지)", exec.calls.length === 0);
  }

  // 3) execution-policy에 안전한 명령이 승인돼 있지 않으면 개입하지 않는다(스스로 새 권한을
  // 만들어내지 않는다).
  {
    const exec = fakeExecutor(() => ({ ok: true, action: "RUN_COMMAND" }));
    const outcome = await attemptDependencyBootstrapRecovery("BLOCK", [LOCKFILE_MISSING], policyWithoutCapability, exec);
    check("3) 승인된 명령 없음: attempted=false", outcome.attempted === false);
    check("3) 승인된 명령 없음: 실행기 호출 없음", exec.calls.length === 0);
  }

  // 4) 정상 개입 — 조건을 모두 만족하면 정확히 그 고정 명령 하나만, 정확히 한 번 실행한다.
  {
    const exec = fakeExecutor(() => ({ ok: true, action: "RUN_COMMAND", data: { exitCode: 0 } }));
    const outcome = await attemptDependencyBootstrapRecovery("BLOCK", [LOCKFILE_MISSING], policyWithCapability, exec);
    check("4) 정상 개입: attempted=true", outcome.attempted === true);
    check("4) 정상 개입: commandSucceeded=true", outcome.commandSucceeded === true);
    check("4) 정상 개입: 실행기가 정확히 1번만 호출됨(bounded)", exec.calls.length === 1);
    const call = exec.calls[0];
    check(
      "4) 실행된 명령이 정확히 npm install --package-lock-only --ignore-scripts(root)",
      call.type === "RUN_COMMAND" &&
        call.command === "npm" &&
        JSON.stringify(call.args) === JSON.stringify(["install", "--package-lock-only", "--ignore-scripts"]) &&
        call.cwd === "root"
    );
  }

  // 5) 실행 자체가 실패하면(예: Core Command Safety Gate 거부, 네트워크 오류 등)
  // commandSucceeded=false만 보고할 뿐 스스로 재시도하지 않는다(bounded — 호출부가 이미
  // 한 번만 시도).
  {
    const exec = fakeExecutor(() => ({ ok: false, action: "RUN_COMMAND", denyReason: "테스트 시뮬레이션 실패" }));
    const outcome = await attemptDependencyBootstrapRecovery("BLOCK", [LOCKFILE_MISSING], policyWithCapability, exec);
    check("5) 실행 실패: attempted=true", outcome.attempted === true);
    check("5) 실행 실패: commandSucceeded=false", outcome.commandSucceeded === false);
    check("5) 실행 실패: 실행기가 정확히 1번만 호출됨(재시도 없음)", exec.calls.length === 1);
  }
}

async function main(): Promise<void> {
  scenarioIsPureLockfileMissingFailure();
  scenarioHasApprovedLockfileInstallCapability();
  await scenarioAttemptRecovery();

  for (const r of results) console.log(r);
  const fail = results.filter((r) => r.startsWith("[FAIL]")).length;
  const pass = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${pass}, FAIL ${fail}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
