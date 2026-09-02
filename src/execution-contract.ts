import type { RequiredTestCommand } from "./task-registry";
import type { AllowedCommandSpec } from "./project-policy";
import { coreCommandSafetyGate } from "./safe-executor";

// AutoDev Core — SI-3.7(Execution Contract Closure).
//
// JARVIS v1.3 R1 Human Review가 발견한 EP-1(task-registry.requiredTests와
// execution-policy.allowedCommands가 exact-match 기준으로 불일치해 Task 검증 명령이 실행
// 불가능함)의 근본 원인은 spec-planner.ts의 두 값이 서로 다른 stage에서 서로를 전혀 모른 채
// 독립적으로 만들어진다는 데 있다 — executionPolicy.allowedCommands는 STAGE 1(ARCHITECTURE)
// LLM이 한 번 확정하고("executionPolicy는 이미 STAGE 1에서 확정됐습니다 — 여기서 다시 만들지
// 마세요", § buildPhaseTaskCorrectionPrompt) 이후 다시 만들지 않는 반면, task.requiredTests는
// STAGE 3(TASK PLAN, Phase별) LLM이 그 사실을 모른 채 자유롭게 만든다. 구조 검증
// (validateRequiredTestsArray/validateExecutionPolicyBlock)은 각자 독립적으로는 유효해도, 두
// 값이 서로 실행 가능하게 맞물리는지는 어디에서도 검증되지 않았다.
//
// 이 파일은 그 교차 검증을 Core가 소유하는 단일 deterministic 관문으로 만든다 — LLM 자유
// 출력에 의존하지 않는다:
//   1. validateRequiredTestExecutionContract() — 모든 requiredTest가 실제로 실행 가능한
//      구조인지(Core Command Safety Gate를 통과하는 capability인지, cwd가 "root"이거나
//      commandCwdAliases에 정의돼 있는지) deterministic하게 재검증한다. 통과하지 못하는
//      requiredTest가 하나라도 있으면 최종 산출물(READY_FOR_AUTODEV/HUMAN_REVIEW_REQUIRED)을
//      만들지 않는다(§ spec-planner.ts 최종 조립/재조립 호출부).
//   2. deriveAllowedCommandsFromRequiredTests()/mergeAllowedCommands()/
//      filterAllowedCommandsByCoreCapability() — "requiredTests에 적혀 있다는 이유만으로
//      위험한 명령을 자동 허용"하지 않는다. 순서는 항상 (a) 각 후보가 Core Command Safety
//      Gate(safe-executor.ts의 coreCommandSafetyGate — policy와 무관한 Core hard rule)를
//      통과하는지 먼저 확인하고, (b) 통과한 것만 최종 allowedCommands로 deterministic하게
//      생성/병합한다. STAGE 1이 제안한 allowedCommands와 STAGE 3의 requiredTests에서 파생된
//      allowedCommands를 합쳐(중복 제거) "필요한 최소 명령 계약"을 만들되, Core Command
//      Safety Gate를 통과하지 못하는 후보는 조용히 제외한다(그런 후보는 실행 시점에도 항상
//      거부됐을 것이므로 제외해도 실제 능력 손실이 없다 — fail-closed 유지).
//
// 이 모듈은 safe-executor.ts의 coreCommandSafetyGate를 그대로 재사용할 뿐(로직 복제 없음),
// 어떤 새 실행/신뢰 판정도 만들지 않는다 — "무엇이 안전한 명령인가"의 단일 출처는 여전히
// safe-executor.ts다. 이 모듈은 파일시스템/네트워크 접근이 전혀 없는 순수 함수만 담는다.

export interface ExecutionContractIssue {
  /** 사람이 읽는 위반 사유 — 원문 secret/민감값은 포함하지 않는다(입력이 이미 Planner의
   *  다른 stage validator를 통과한 구조화된 값이라 원문 노출 위험이 낮지만, command/args/cwd
   *  자체는 실행 계약 검증에 필수적인 정보라 그대로 echo한다). */
  reason: string;
  taskId?: string;
  testName?: string;
}

/** spec-planner.ts의 PlannerRawTask/TaskDefinition 둘 다 이 최소 shape로 어댑팅해서 넘긴다
 *  (이 모듈이 두 타입 중 어느 쪽에도 직접 의존하지 않게 하기 위함). */
export interface RequiredTestOwner {
  taskId: string;
  requiredTests: readonly RequiredTestCommand[];
}

function describeTest(taskId: string | undefined, rt: RequiredTestCommand): string {
  const owner = taskId ? `task "${taskId}"의 ` : "";
  return `${owner}requiredTest "${rt.name}"(command="${rt.command}", args=${JSON.stringify(rt.args)}, cwd="${rt.cwd}")`;
}

/**
 * 하나의 requiredTest가 실제로 실행 가능한 구조인지 확인한다:
 *   - cwd가 "root"이거나 commandCwdAliases에 정의돼 있는가(정의되지 않은 별칭은 safe-
 *     executor.ts의 cwdToPath()가 항상 거부한다 — 여기서 미리 잡아 계획 단계에서 드러낸다).
 *   - command/args가 Core Command Safety Gate(coreCommandSafetyGate)를 통과하는가 — git
 *     read-only allow-list/node eval 플래그 차단/npm·npx subcommand 제한/gradlew task
 *     allow-list 등 이 게이트가 강제하는 모든 규칙이 그대로 적용된다(로직 복제 없음).
 */
export function validateRequiredTestCoreCapability(
  rt: RequiredTestCommand,
  commandCwdAliases: Record<string, string> | undefined,
  taskId?: string
): ExecutionContractIssue[] {
  const issues: ExecutionContractIssue[] = [];
  if (rt.cwd !== "root" && !(commandCwdAliases && Object.prototype.hasOwnProperty.call(commandCwdAliases, rt.cwd))) {
    issues.push({
      taskId,
      testName: rt.name,
      reason: `${describeTest(taskId, rt)}의 cwd가 "root"도 아니고 executionPolicy.commandCwdAliases에도 정의되지 않았습니다.`,
    });
  }
  const gate = coreCommandSafetyGate(rt.command, rt.args);
  if (!gate.ok) {
    issues.push({
      taskId,
      testName: rt.name,
      reason: `${describeTest(taskId, rt)}가 Core Command Safety Gate를 통과하지 못했습니다: ${gate.reason}`,
    });
  }
  return issues;
}

/**
 * SI-3.7 Required Test Execution Contract — 모든 task의 모든 requiredTest에 대해:
 *   1) validateRequiredTestCoreCapability(위)를 적용하고,
 *   2) finalAllowedCommands가 주어지면(최종/재조립된 executionPolicy.allowedCommands) 그
 *      requiredTest와 정확히 일치하는(cwd+command+args exact-match) 항목이 실제로 존재하는지도
 *      확인한다 — deriveAllowedCommandsFromRequiredTests()로 파생한 값이면 항상 참이어야
 *      하지만(구성상 보장), 이 함수를 그 파생 로직 자체의 회귀 방지용 defense-in-depth
 *      재확인으로도 그대로 재사용한다(§ spec-planner.ts 최종 조립의 "재조립 직후 재확인").
 * finalAllowedCommands를 생략하면 1)만 확인한다(§ 최종 allowedCommands가 아직 만들어지지
 * 않은 시점에도 호출 가능해야 하는 spec-planner.ts final assembly의 첫 관문).
 */
export function validateRequiredTestExecutionContract(
  tasks: readonly RequiredTestOwner[],
  commandCwdAliases: Record<string, string> | undefined,
  finalAllowedCommands?: readonly AllowedCommandSpec[]
): ExecutionContractIssue[] {
  const issues: ExecutionContractIssue[] = [];
  for (const t of tasks) {
    for (const rt of t.requiredTests) {
      issues.push(...validateRequiredTestCoreCapability(rt, commandCwdAliases, t.taskId));
      if (finalAllowedCommands) {
        const matched = finalAllowedCommands.some(
          (c) => c.cwd === rt.cwd && c.command === rt.command && c.args.length === rt.args.length && c.args.every((a, i) => a === rt.args[i])
        );
        if (!matched) {
          issues.push({
            taskId: t.taskId,
            testName: rt.name,
            reason: `${describeTest(t.taskId, rt)}가 최종 executionPolicy.allowedCommands에 정확히 일치하는 항목이 없습니다.`,
          });
        }
      }
    }
  }
  return issues;
}

function commandSpecKey(c: { cwd: string; command: string; args: readonly string[] }): string {
  return JSON.stringify([c.cwd, c.command, c.args]);
}

/**
 * 모든 task의 모든 requiredTest에서 (cwd, command, args) exact triple을 중복 제거해
 * deterministic하게 파생한다 — 이 함수는 Core Command Safety Gate를 스스로 확인하지 않는다
 * (그 확인은 validateRequiredTestExecutionContract가 이미 앞단에서 담당 — § 요구사항 3의
 * "Task requiredTest → Core-supported capability validation → 최소 allowedCommands 생성"
 * 순서. 이 함수는 그 검증을 통과한 뒤에만 호출돼야 한다). 반환 순서는 항상 동일한 정렬
 * (cwd/command/args 직렬화 기준)이라 호출 시점의 배열 순서나 iteration 순서에 관계없이
 * 동일한 입력에는 항상 동일한 출력이 나온다.
 */
export function deriveAllowedCommandsFromRequiredTests(tasks: readonly RequiredTestOwner[]): AllowedCommandSpec[] {
  const seen = new Map<string, AllowedCommandSpec>();
  for (const t of tasks) {
    for (const rt of t.requiredTests) {
      const spec: AllowedCommandSpec = { cwd: rt.cwd, command: rt.command, args: [...rt.args] };
      const key = commandSpecKey(spec);
      if (!seen.has(key)) seen.set(key, spec);
    }
  }
  return [...seen.values()].sort((a, b) => commandSpecKey(a).localeCompare(commandSpecKey(b)));
}

/** 여러 AllowedCommandSpec 그룹을 중복 제거해 하나로 합친다(먼저 나온 그룹의 항목을 우선
 *  유지 — 값이 완전히 exact-match 동일할 때만 중복으로 취급하므로 "우선순위"가 실질적인
 *  의미를 가지는 경우는 없다). 결과는 항상 동일하게 정렬된다(§ 위 설명). */
export function mergeAllowedCommands(...groups: readonly (readonly AllowedCommandSpec[])[]): AllowedCommandSpec[] {
  const seen = new Map<string, AllowedCommandSpec>();
  for (const group of groups) {
    for (const c of group) {
      const key = commandSpecKey(c);
      if (!seen.has(key)) seen.set(key, c);
    }
  }
  return [...seen.values()].sort((a, b) => commandSpecKey(a).localeCompare(commandSpecKey(b)));
}

/**
 * requiredTests에서 파생되지 않은 다른 allowedCommands 후보(예: STAGE 1 LLM이 직접 제안한
 * 값)에도 동일한 검증을 적용한다 — "위험한 명령을 자동 허용하지 않는다"를 requiredTests
 * 파생분에만 국한하지 않고 전체 allowedCommands 생성 경로에 일관되게 적용하기 위함이다.
 * Core Command Safety Gate뿐 아니라 cwd 유효성(§ validateRequiredTestCoreCapability와
 * 동일한 기준 — "root"이거나 commandCwdAliases에 정의됨)도 함께 확인한다 — bounded code-
 * review 지적: cwd를 확인하지 않으면 정의되지 않은 별칭을 가진 STAGE 1 후보가 이 필터를
 * 그대로 통과해 merge된 뒤 validateProjectExecutionPolicy()의 범용 예외로만 뒤늦게
 * (GENERATED_DATA_INVALID로) 잡혀, SI-3.7이 이 클래스의 문제를 위해 만든 더 구체적인
 * REQUIRED_TEST_NOT_EXECUTABLE 판정 경로를 우회하게 된다.
 *
 * 어느 쪽이든 통과하지 못하는 후보는 REJECTED/BLOCKED하지 않고 조용히 제외한다 — 이
 * 후보들은(필수 테스트가 아니라) Developer가 쓸 수도 있는 부가적인 RUN_COMMAND 여유분일
 * 뿐이라, 빠져도 계획 자체를 막을 이유가 없다(실행 시점에도 Core Command Safety Gate/cwd
 * 해석이 항상 거부했을 명령이므로 제외해도 실제 능력 손실이 없다).
 */
export function filterAllowedCommandsByCoreCapability(
  commands: readonly AllowedCommandSpec[],
  commandCwdAliases: Record<string, string> | undefined
): AllowedCommandSpec[] {
  return commands.filter((c) => {
    if (c.cwd !== "root" && !(commandCwdAliases && Object.prototype.hasOwnProperty.call(commandCwdAliases, c.cwd))) return false;
    return coreCommandSafetyGate(c.command, c.args).ok;
  });
}

/** safe-executor.ts의 NPM_INSTALL_SAFE_ARGS와 정확히 같은 값 — coreCommandSafetyGate가
 *  이 형태만 허용하므로, 여기서 다른 형태를 derive해도 실행 시점에 항상 거부된다(그래서
 *  이 상수는 project별로 달라질 수 없는 고정값이다. § 아래 deriveDependencyResolutionCommands). */
const NPM_INSTALL_LOCKFILE_ONLY_COMMAND: AllowedCommandSpec = {
  cwd: "root",
  command: "npm",
  args: ["install", "--package-lock-only", "--ignore-scripts"],
};

/**
 * Dependency/Lockfile Bootstrap Gap Closure(2026-09-02, Revenue OS Task 1.1 실제 운영
 * incident) — deriveAllowedCommandsFromRequiredTests()는 각 task의 requiredTests에서만
 * allowedCommands를 파생하므로, "package.json에 dependency를 선언하는" task가 있어도 그
 * dependency의 실제 설치/lockfile 생성 자체는 어떤 requiredTest에도 나타나지 않아
 * allowedCommands에 절대 포함되지 않았다. 그런데 dependency-scanner.ts(C5)는 package.json이
 * dependency를 선언했는데 package-lock.json이 없으면 항상 commit을 BLOCK한다(의도된 정상
 * 동작 — 완화하지 않는다) — 그 결과 npm workspaces를 쓰는 모든 프로젝트가 최초 bootstrap
 * task에서 구조적으로 이 BLOCK을 벗어날 방법이 없었다.
 *
 * 이 함수는 프로젝트가 root package.json을 실제로 쓴다는 사실이 이미 확정된 시점(최종
 * allowedWritePrefixes에 exact "package.json"이 있음 — STAGE 1 policy든 어떤 task의 scope
 * 든)에만, 그 lockfile을 생성할 수 있는 이 하나의 고정된 안전 명령(NPM_INSTALL_LOCKFILE_
 * ONLY_COMMAND — lockfile 생성 전용, lifecycle script 미실행, 임의 패키지 설치 불가, §
 * safe-executor.ts NPM_INSTALL_SAFE_ARGS 주석)을 deterministic하게 더한다. package.json을
 * 전혀 쓰지 않는 프로젝트에는 아무것도 더하지 않는다(최소 권한 — 불필요한 npm capability를
 * 열지 않는다). project별 customize는 불가능하다(project-agnostic Core 규칙, 어떤
 * ProjectExecutionPolicy 입력도 이 반환값을 바꿀 수 없다).
 */
export function deriveDependencyResolutionCommands(allowedWritePrefixes: readonly string[]): AllowedCommandSpec[] {
  return allowedWritePrefixes.includes("package.json") ? [NPM_INSTALL_LOCKFILE_ONLY_COMMAND] : [];
}
