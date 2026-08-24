import {
  validateRequiredTestCoreCapability,
  validateRequiredTestExecutionContract,
  deriveAllowedCommandsFromRequiredTests,
  mergeAllowedCommands,
  filterAllowedCommandsByCoreCapability,
} from "./execution-contract";
import type { RequiredTestOwner } from "./execution-contract";
import type { RequiredTestCommand } from "./task-registry";
import type { AllowedCommandSpec } from "./project-policy";

// SI-3.7(Execution Contract Closure) — execution-contract.ts 단위 테스트. 이 모듈은 순수
// 함수만 담으므로(파일시스템/네트워크 없음) 모든 테스트는 in-process로 즉시 실행된다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function rt(overrides: Partial<RequiredTestCommand> = {}): RequiredTestCommand {
  return { name: "unit", command: "npm", args: ["run", "test:unit"], cwd: "root", ...overrides };
}

// ---------------------------------------------------------------------------
// 1) validateRequiredTestCoreCapability — cwd alias 유효성
// ---------------------------------------------------------------------------
function scenarioCwdValidity(): void {
  check("cwd-root-always-ok) cwd=root는 alias 없이도 통과", validateRequiredTestCoreCapability(rt({ cwd: "root" }), undefined).length === 0);
  check(
    "cwd-known-alias-ok) cwd가 commandCwdAliases에 정의돼 있으면 통과",
    validateRequiredTestCoreCapability(rt({ cwd: "android" }), { android: "android/" }).length === 0
  );
  check(
    "cwd-unknown-alias-fail) cwd가 정의되지 않은 별칭이면 실패",
    validateRequiredTestCoreCapability(rt({ cwd: "android" }), { web: "web/" }).some((i) => i.reason.includes("commandCwdAliases"))
  );
  check(
    "cwd-no-aliases-at-all-fail) commandCwdAliases 자체가 없고 cwd!=root면 실패",
    validateRequiredTestCoreCapability(rt({ cwd: "android" }), undefined).some((i) => i.reason.includes("commandCwdAliases"))
  );
}

// ---------------------------------------------------------------------------
// 2) validateRequiredTestCoreCapability — Core Command Safety Gate 위임
// ---------------------------------------------------------------------------
function scenarioCoreCommandSafetyDelegation(): void {
  check("npm-run-ok) npm run <script>는 통과", validateRequiredTestCoreCapability(rt({ command: "npm", args: ["run", "test:unit"] }), undefined).length === 0);
  check(
    "npm-exec-fail) npm exec는 거부(Core Command Safety Gate)",
    validateRequiredTestCoreCapability(rt({ command: "npm", args: ["exec", "malicious"] }), undefined).some((i) => i.reason.includes("Core Command Safety Gate"))
  );
  check(
    "git-mutating-fail) git reset --hard는 거부",
    validateRequiredTestCoreCapability(rt({ command: "git", args: ["reset", "--hard"] }), undefined).some((i) => i.reason.includes("Core Command Safety Gate"))
  );
  check(
    "unknown-family-fail) bash -c는 family 자체가 거부",
    validateRequiredTestCoreCapability(rt({ command: "bash", args: ["-c", "echo hi"] }), undefined).some((i) => i.reason.includes("Core Command Safety Gate"))
  );
  check(
    "node-eval-fail) node -e는 거부",
    validateRequiredTestCoreCapability(rt({ command: "node", args: ["-e", "1"] }), undefined).some((i) => i.reason.includes("Core Command Safety Gate"))
  );
  check(
    "path-qualified-fail) ./gradlew처럼 경로가 포함된 command는 거부",
    validateRequiredTestCoreCapability(rt({ command: "./gradlew", args: ["test"], cwd: "android" }), { android: "android/" }).some((i) =>
      i.reason.includes("Core Command Safety Gate")
    )
  );
  check(
    "gradlew-bare-allowed-task-ok) 정확한 gradlew test는 통과",
    validateRequiredTestCoreCapability(rt({ command: "gradlew", args: ["test"], cwd: "android" }), { android: "android/" }).length === 0
  );
}

// ---------------------------------------------------------------------------
// 3) validateRequiredTestExecutionContract — 여러 task/finalAllowedCommands 대조
// ---------------------------------------------------------------------------
function scenarioContractAggregation(): void {
  const tasks: RequiredTestOwner[] = [
    { taskId: "1.1", requiredTests: [rt({ name: "a", command: "npm", args: ["run", "test:unit"], cwd: "root" })] },
    { taskId: "1.2", requiredTests: [rt({ name: "b", command: "gradlew", args: ["test"], cwd: "android" })] },
  ];
  const aliases = { android: "android/" };

  const capabilityOnly = validateRequiredTestExecutionContract(tasks, aliases);
  check("aggregate-capability-only-ok) 두 task 모두 capability 통과 시 issue 없음", capabilityOnly.length === 0);

  const matchingCommands: AllowedCommandSpec[] = [
    { cwd: "root", command: "npm", args: ["run", "test:unit"] },
    { cwd: "android", command: "gradlew", args: ["test"] },
  ];
  check("aggregate-final-match-ok) finalAllowedCommands가 정확히 일치하면 issue 없음", validateRequiredTestExecutionContract(tasks, aliases, matchingCommands).length === 0);

  const missingOneCommand: AllowedCommandSpec[] = [{ cwd: "root", command: "npm", args: ["run", "test:unit"] }];
  const withMismatch = validateRequiredTestExecutionContract(tasks, aliases, missingOneCommand);
  check(
    "aggregate-final-mismatch-fail) finalAllowedCommands에 하나라도 없으면 그 task만 issue로 보고",
    withMismatch.length === 1 && withMismatch[0].taskId === "1.2" && withMismatch[0].reason.includes("정확히 일치")
  );

  const argsMismatchCommands: AllowedCommandSpec[] = [
    { cwd: "root", command: "npm", args: ["run", "test:unit"] },
    { cwd: "android", command: "gradlew", args: ["assemble"] }, // args가 다름(test vs assemble)
  ];
  check(
    "aggregate-args-mismatch-fail) args가 다르면(부분 일치) exact-match 실패로 보고",
    validateRequiredTestExecutionContract(tasks, aliases, argsMismatchCommands).some((i) => i.taskId === "1.2")
  );

  const cwdMismatchCommands: AllowedCommandSpec[] = [
    { cwd: "root", command: "npm", args: ["run", "test:unit"] },
    { cwd: "root", command: "gradlew", args: ["test"] }, // cwd가 다름(android vs root)
  ];
  check(
    "aggregate-cwd-mismatch-fail) cwd가 다르면 exact-match 실패로 보고",
    validateRequiredTestExecutionContract(tasks, aliases, cwdMismatchCommands).some((i) => i.taskId === "1.2")
  );
}

// ---------------------------------------------------------------------------
// 4) deriveAllowedCommandsFromRequiredTests — dedupe + deterministic ordering
// ---------------------------------------------------------------------------
function scenarioDerive(): void {
  const tasks: RequiredTestOwner[] = [
    { taskId: "1.1", requiredTests: [rt({ name: "a", command: "npm", args: ["run", "test:unit"], cwd: "root" })] },
    { taskId: "1.2", requiredTests: [rt({ name: "b", command: "npm", args: ["run", "test:unit"], cwd: "root" })] }, // 중복
    { taskId: "1.3", requiredTests: [rt({ name: "c", command: "npx", args: ["tsc"], cwd: "root" })] },
  ];
  const derived = deriveAllowedCommandsFromRequiredTests(tasks);
  check("derive-dedupe) 동일 triple은 하나로 합쳐짐", derived.length === 2);
  check(
    "derive-content) 파생된 항목 내용이 정확함",
    derived.some((c) => c.cwd === "root" && c.command === "npm" && JSON.stringify(c.args) === JSON.stringify(["run", "test:unit"])) &&
      derived.some((c) => c.cwd === "root" && c.command === "npx" && JSON.stringify(c.args) === JSON.stringify(["tsc"]))
  );

  const tasksReversedOrder: RequiredTestOwner[] = [tasks[2], tasks[0], tasks[1]];
  const derivedReversed = deriveAllowedCommandsFromRequiredTests(tasksReversedOrder);
  check(
    "derive-deterministic-ordering) 입력 순서가 달라도 출력 순서가 동일함",
    JSON.stringify(derived) === JSON.stringify(derivedReversed)
  );
}

// ---------------------------------------------------------------------------
// 5) mergeAllowedCommands — 여러 그룹 dedupe
// ---------------------------------------------------------------------------
function scenarioMerge(): void {
  const a: AllowedCommandSpec[] = [{ cwd: "root", command: "npm", args: ["run", "test:unit"] }];
  const b: AllowedCommandSpec[] = [
    { cwd: "root", command: "npm", args: ["run", "test:unit"] }, // a와 완전히 동일 → 중복 제거
    { cwd: "root", command: "npx", args: ["tsc"] },
  ];
  const merged = mergeAllowedCommands(a, b);
  check("merge-dedupe) 중복 제거 후 2개만 남음", merged.length === 2);
  check("merge-empty-groups-ok) 빈 그룹들의 병합은 빈 배열", mergeAllowedCommands([], []).length === 0);
  check("merge-no-groups-ok) 그룹 없이 호출해도 빈 배열", mergeAllowedCommands().length === 0);
}

// ---------------------------------------------------------------------------
// 6) filterAllowedCommandsByCoreCapability — 위험/미지원 후보를 조용히 제외
// ---------------------------------------------------------------------------
function scenarioFilter(): void {
  const candidates: AllowedCommandSpec[] = [
    { cwd: "root", command: "npm", args: ["run", "test:unit"] }, // 통과
    { cwd: "root", command: "npm", args: ["exec", "malicious"] }, // 거부
    { cwd: "root", command: "git", args: ["push"] }, // 거부
    { cwd: "root", command: "git", args: ["status"] }, // 통과
    { cwd: "root", command: "bash", args: ["-c", "echo hi"] }, // 거부(family)
    { cwd: "android", command: "gradlew", args: ["test"] }, // 통과(commandCwdAliases에 정의됨)
    { cwd: "ios", command: "npm", args: ["run", "test:unit"] }, // 거부(cwd 별칭 미정의)
  ];
  const filtered = filterAllowedCommandsByCoreCapability(candidates, { android: "android/" });
  check("filter-keeps-safe) 안전한 후보 3개만 남음", filtered.length === 3);
  check(
    "filter-content) 남은 항목이 정확히 npm run/git status/gradlew test",
    filtered.some((c) => c.command === "npm" && c.args[0] === "run" && c.cwd === "root") &&
      filtered.some((c) => c.command === "git" && c.args[0] === "status") &&
      filtered.some((c) => c.command === "gradlew" && c.cwd === "android")
  );
  check(
    "filter-undefined-cwd-alias-excluded) cwd 별칭이 없으면 명령 자체가 안전해도 제외됨",
    !filtered.some((c) => c.cwd === "ios")
  );
  check(
    "filter-no-aliases-object-still-allows-root) commandCwdAliases 자체가 undefined여도 cwd=root는 통과",
    filterAllowedCommandsByCoreCapability([{ cwd: "root", command: "npm", args: ["test"] }], undefined).length === 1
  );
}

async function main(): Promise<void> {
  scenarioCwdValidity();
  scenarioCoreCommandSafetyDelegation();
  scenarioContractAggregation();
  scenarioDerive();
  scenarioMerge();
  scenarioFilter();

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
