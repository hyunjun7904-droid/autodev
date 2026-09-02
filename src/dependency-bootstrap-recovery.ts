import type { DependencyFinding, DependencyScanVerdict } from "./dependency-scanner";
import type { AllowedCommandSpec, ProjectExecutionPolicy } from "./project-policy";
import type { SafeExecutorContext } from "./safe-executor";

// Dependency Bootstrap Technical Auto-Recovery(2026-09-02, Revenue OS Task 1.1 실제 운영
// incident) — Bounded Technical Recovery, Not a New Human Gate Exception.
//
// checkpoint.ts의 기존 원칙("No-Safe-Recovery-Action Gate", § autodev.ts 주석)은 "checkpoint
// 실패는 Developer/Reviewer 재시도로 스스로 해결되지 않으므로 항상 genuine Human Gate"라고
// 못박았다 — 이건 여전히 맞다. 이 파일은 그 원칙을 깨지 않는다: Developer를 다시 부르지
// 않고, 사람의 판단을 대신하지도 않는다. 이 파일이 다루는 것은 정확히 하나의 순수 기술적
// 상태뿐이다 — "package.json이 dependency를 선언했는데 package-lock.json이 아예 없어서
// Dependency Scanner(C5)가 아무것도 검증할 수 없다"는 lockfile-missing. 이건 보안 판단이
// 아니라 누락된 산출물이며, Core가 이미 execution-policy에 명시적으로 승인해 둔 단 하나의
// 고정 명령(npm install --package-lock-only --ignore-scripts, § safe-executor.ts
// NPM_INSTALL_SAFE_ARGS/dependency-scanner.ts와 별개)으로 결정론적으로 채울 수 있다.
//
// 개입 범위는 의도적으로 아주 좁다 — 아래 전부를 만족할 때만 개입한다:
//   1) dependency scan의 findings가 전부 kind==="lockfile-missing"이다(다른 어떤 finding —
//      취약점/insecure source/integrity 위반/install-script 등 — 이 단 하나라도 섞여
//      있으면 절대 개입하지 않는다. 그런 경우는 진짜 사람 판단이 필요하므로 기존과 동일하게
//      genuine Human Gate로 흘러간다).
//   2) execution-policy.allowedCommands에 그 lockfile 생성 명령이 이미 명시적으로 등록돼
//      있다(spec-planner.ts deriveDependencyResolutionCommands가 dependency 있는 프로젝트에
//      항상 심어두는 그 명령, § execution-contract.ts — 없으면 이 프로젝트가 그 capability를
//      아예 승인받지 않은 것이므로 개입하지 않는다, arbitrary npm/shell 권한을 몰래 확장하지
//      않는다).
// 실제 명령 실행은 SafeExecutorContext.validateAndExecute()를 그대로 통과한다 — Core Command
// Safety Gate/Trusted Executable Resolution 등 기존 모든 안전장치가 동일하게 적용된다(새
// 실행 경로를 만들지 않는다). 이 함수는 딱 한 번만 시도한다(호출부가 재호출하지 않는 한
// 루프하지 않음) — 실패하면 그 결과를 그대로 반환할 뿐 재시도하지 않는다(bounded).
// 성공/실패 어느 쪽이든 호출부는 반드시 performTaskCheckpoint()를 다시 호출해 실제
// Dependency Scanner로 재검증해야 한다 — 이 함수 자신은 "이제 안전하다"고 스스로 선언하지
// 않는다(그 판단은 여전히 deterministic scanner의 몫이다).

export interface DependencyBootstrapRecoveryOutcome {
  /** 개입 조건(§ 위 1/2번)을 만족해 실제로 복구를 시도했는지 — false면 아래 필드는 전부
   *  무의미하고, 호출부는 기존과 동일하게 genuine Human Gate 경로로 진행해야 한다. */
  attempted: boolean;
  /** attempted===true일 때만 유효 — 명령이 실제로 exitCode 0으로 끝났는지. true라도 이건
   *  "명령이 성공했다"는 뜻일 뿐 "checkpoint가 이제 통과한다"는 보장이 아니다 — 호출부가
   *  반드시 checkpoint를 다시 실행해 재검증해야 한다. */
  commandSucceeded: boolean;
  /** 사람이 읽는 진단 텍스트 — 로그/감사용. secret 원문은 포함하지 않는다(명령 자체가
   *  고정 literal이라 실행 결과에 임의 사용자 입력이 섞이지 않는다). */
  detail: string;
}

const LOCKFILE_ONLY_INSTALL_ARGS: readonly string[] = ["install", "--package-lock-only", "--ignore-scripts"];

/** findings가 전부 kind==="lockfile-missing"인지(그리고 최소 1개 이상인지) 확인한다 — 다른
 *  finding이 단 하나라도 섞여 있으면 false(순수 기술적 상태가 아니므로 개입하지 않는다). */
export function isPureLockfileMissingFailure(findings: readonly DependencyFinding[] | undefined): boolean {
  return !!findings && findings.length > 0 && findings.every((f) => f.kind === "lockfile-missing");
}

function commandSpecMatchesLockfileOnlyInstall(c: AllowedCommandSpec): boolean {
  return (
    c.cwd === "root" &&
    c.command === "npm" &&
    c.args.length === LOCKFILE_ONLY_INSTALL_ARGS.length &&
    c.args.every((a, i) => a === LOCKFILE_ONLY_INSTALL_ARGS[i])
  );
}

/** 이 프로젝트가 실제로 그 lockfile 생성 명령을 execution-policy에 명시적으로 승인해
 *  뒀는지 확인한다 — 없으면 이 파일이 스스로 그 권한을 만들어내지 않는다(어떤
 *  arbitrary npm/shell 권한도 새로 허용하지 않는다는 원칙, § 파일 상단 주석). */
export function hasApprovedLockfileInstallCapability(policy: Pick<ProjectExecutionPolicy, "allowedCommands">): boolean {
  return policy.allowedCommands.some(commandSpecMatchesLockfileOnlyInstall);
}

/**
 * lockfile-missing 단독 실패에 한해, 이미 승인된 lockfile 생성 명령을 SafeExecutorContext를
 * 통해 정확히 한 번 실행한다. 그 외 모든 경우 attempted=false로 즉시 반환한다(기존
 * genuine Human Gate 경로를 그대로 둔다).
 */
export async function attemptDependencyBootstrapRecovery(
  dependencyScanVerdict: DependencyScanVerdict | undefined,
  dependencyFindings: readonly DependencyFinding[] | undefined,
  policy: Pick<ProjectExecutionPolicy, "allowedCommands">,
  executor: Pick<SafeExecutorContext, "validateAndExecute">
): Promise<DependencyBootstrapRecoveryOutcome> {
  if (dependencyScanVerdict !== "BLOCK" || !isPureLockfileMissingFailure(dependencyFindings)) {
    return { attempted: false, commandSucceeded: false, detail: "lockfile-missing 단독 실패가 아니어서 자동복구 대상이 아님(genuine Human Gate 유지)." };
  }
  if (!hasApprovedLockfileInstallCapability(policy)) {
    return {
      attempted: false,
      commandSucceeded: false,
      detail: "execution-policy.allowedCommands에 승인된 lockfile 생성 명령이 없어 자동복구 불가(genuine Human Gate 유지).",
    };
  }
  const result = await executor.validateAndExecute({
    type: "RUN_COMMAND",
    command: "npm",
    args: [...LOCKFILE_ONLY_INSTALL_ARGS],
    cwd: "root",
  });
  if (!result.ok) {
    return {
      attempted: true,
      commandSucceeded: false,
      detail: `lockfile 생성 명령 실행 실패 — ${result.denyReason ?? `exitCode=${(result.data as { exitCode?: number } | undefined)?.exitCode ?? "unknown"}`}`,
    };
  }
  return { attempted: true, commandSucceeded: true, detail: "npm install --package-lock-only --ignore-scripts 실행 성공(exitCode 0) — checkpoint 재검증 필요." };
}
