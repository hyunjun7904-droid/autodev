import { resolve, dirname, extname } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { validateProjectManifest } from "./project-manifest";
import type { ProjectManifest } from "./project-manifest";
import { validateProjectExecutionPolicy } from "./project-policy";
import type { ProjectExecutionPolicy, AllowedCommandSpec } from "./project-policy";
import type { TaskDefinition, RequiredTestCommand } from "./task-registry";

// AutoDev 범용화 Phase C Task C1 — External Project Adapter를 data-only로 전환.
//
// Phase B Task B3까지의 project adapter는 createProjectManifest()를 export하는 CommonJS
// 모듈이었고, 이 파일이 require()로 그 모듈을 로드했다. 문제는 require()가 그 모듈의
// JavaScript를 그대로 실행한다는 점이다 — validateProjectManifest()로 결과값을 검증하기
// *전에* 이미 임의 코드(파일시스템 접근, child process 실행, network 호출, 환경변수 읽기 등)가
// 돌 수 있었다. "프로젝트 설정은 데이터로 읽고, 실행은 AutoDev Core만 한다"는 원칙을 지키려면
// 외부 project adapter가 실행 가능한 코드여서는 안 된다.
//
// 이제 project adapter는 하나의 JSON 데이터 파일(project config)이다. 이 파일은
// fs.readFileSync + JSON.parse로만 그 내용을 읽는다 — require()/dynamic import()/eval()/
// new Function()/vm.* 등 외부 파일의 코드를 실행하는 어떤 경로도 쓰지 않는다. .js/.cjs/.mjs/.ts
// 등 executable 확장자는 확장자 검사만으로 즉시 거부한다(내용을 열어보기 전에 차단).
//
// project config(JSON)는 다음을 담는다:
//   - targetProjectRoot/statePath/taskRegistryPath: 이 JSON 파일 자신의 위치(dirname) 기준
//     상대경로 — 이 로더가 안전하게 절대경로로 변환한다(경로 escape는 fail-fast).
//   - taskRegistry 또는 taskRegistryPath: taskRegistry 데이터(둘 중 정확히 하나만).
//   - executionPolicy.writeDenyPatterns: RegExp 객체 대신 { pattern, flags } 데이터 표현 —
//     이 로더가 검증 후 RegExp로 컴파일한다(위험하거나 잘못된 flags/pattern은 거부).
// 그 외 필드(developerInstructions/reviewInstructions/reviewScopeDirs/rulesPath/
// executionPolicy의 나머지 필드)는 project-manifest.ts/project-policy.ts의 기존 검증 함수에
// 그대로 위임한다 — 이 파일이 그 검증 규칙을 다시 만들지 않는다.
//
// 어느 단계에서든 형식이 어긋나면 즉시 throw한다 — 어떤 프로젝트로도, 어떤 permissive한
// 기본값으로도 조용히 fallback하지 않는다.

const CONFIG_EXTENSION = ".json";
const ALLOWED_REGEX_FLAGS = new Set(["", "i"]);

function readJsonDataFile(absPath: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf-8");
  } catch (e) {
    throw new Error(
      `${label}을(를) 읽는 중 오류가 발생했습니다(${absPath}): ${e instanceof Error ? e.message : String(e)}`
    );
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `${label}이(가) 올바른 JSON이 아닙니다(${absPath}): ${e instanceof Error ? e.message : String(e)}`
    );
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// project config 안의 상대경로 필드(targetProjectRoot/statePath/taskRegistryPath)를
// baseDir(= project config 파일 자신의 dirname) 기준 절대경로로 변환한다. 절대경로/드라이브
// 경로/UNC 경로는 항상 거부한다. ".."은 targetProjectRoot에만 허용한다(project config가
// 프로젝트 repo의 하위 디렉터리에 있는 것이 일반적인 배치이므로) — statePath/
// taskRegistryPath는 project config와 같은 디렉터리 트리 안에 머물러야 한다.
function resolveConfigRelativePath(
  baseDir: string,
  candidate: unknown,
  label: string,
  opts: { allowParentEscape: boolean }
): string {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new Error(`Invalid project config: ${label}이(가) 비어있습니다.`);
  }
  if (/^[a-zA-Z]:[\\/]/.test(candidate)) {
    throw new Error(`Invalid project config: ${label}은(는) 드라이브 절대경로일 수 없습니다: ${candidate}`);
  }
  if (candidate.startsWith("/") || candidate.startsWith("\\")) {
    throw new Error(`Invalid project config: ${label}은(는) 절대경로일 수 없습니다: ${candidate}`);
  }
  if (/^\\\\/.test(candidate) || /^\/\/[^/]/.test(candidate)) {
    throw new Error(`Invalid project config: ${label}에 UNC 경로를 쓸 수 없습니다: ${candidate}`);
  }
  const segments = candidate.split(/[\\/]/);
  if (!opts.allowParentEscape && segments.includes("..")) {
    throw new Error(`Invalid project config: ${label}에 ".."을 쓸 수 없습니다(같은 디렉터리 트리 안이어야 함): ${candidate}`);
  }
  return resolve(baseDir, candidate);
}

// targetProjectRoot가 malformed/과도한 ".."로 filesystem root(드라이브 루트 등)를 가리키는
// 것을 막는다 — targetProjectRoot는 project config가 있는 자리에서 합리적으로 도달 가능한
// 하위 프로젝트 저장소여야 하며, 존재하지 않거나 디렉터리가 아니거나 drive/OS root 자체를
// 가리키면 즉시 거부한다.
function assertSaneTargetRoot(absRoot: string): void {
  if (!existsSync(absRoot)) {
    throw new Error(`Invalid project config: targetProjectRoot가 존재하지 않는 경로입니다: ${absRoot}`);
  }
  let st;
  try {
    st = statSync(absRoot);
  } catch (e) {
    throw new Error(`Invalid project config: targetProjectRoot 확인 실패(${absRoot}): ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`Invalid project config: targetProjectRoot가 디렉터리가 아닙니다: ${absRoot}`);
  }
  const parent = dirname(absRoot);
  if (parent === absRoot) {
    // dirname(x) === x는 x가 filesystem/드라이브 root(예: "C:\", "/")일 때만 성립한다.
    throw new Error(`Invalid project config: targetProjectRoot가 filesystem root를 가리킬 수 없습니다: ${absRoot}`);
  }
}

function compileWriteDenyPatterns(raw: unknown, projectLabel: string): RegExp[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new Error(`Invalid project config(${projectLabel}): executionPolicy.writeDenyPatterns가 배열이 아닙니다.`);
  }
  return raw.map((entry, i) => {
    if (!isPlainObject(entry) || typeof entry.pattern !== "string" || entry.pattern.length === 0) {
      throw new Error(
        `Invalid project config(${projectLabel}): executionPolicy.writeDenyPatterns[${i}]는 { pattern: string, flags?: string } 형태여야 합니다.`
      );
    }
    const flags = entry.flags === undefined ? "" : entry.flags;
    if (typeof flags !== "string" || !ALLOWED_REGEX_FLAGS.has(flags)) {
      throw new Error(
        `Invalid project config(${projectLabel}): executionPolicy.writeDenyPatterns[${i}].flags가 허용되지 않습니다(허용: "", "i").`
      );
    }
    try {
      return new RegExp(entry.pattern, flags);
    } catch (e) {
      throw new Error(
        `Invalid project config(${projectLabel}): executionPolicy.writeDenyPatterns[${i}].pattern이 잘못된 정규식입니다: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
    }
  });
}

function buildExecutionPolicyFromData(raw: unknown, projectLabel: string): ProjectExecutionPolicy {
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid project config(${projectLabel}): executionPolicy가 비어있거나 객체가 아닙니다.`);
  }
  const policy: ProjectExecutionPolicy = {
    allowedReadPrefixes: raw.allowedReadPrefixes as string[],
    allowedWritePrefixes: raw.allowedWritePrefixes as string[],
    writeDenyPatterns: compileWriteDenyPatterns(raw.writeDenyPatterns, projectLabel),
    commandCwdAliases: raw.commandCwdAliases as Record<string, string> | undefined,
    allowedCommands: (raw.allowedCommands as AllowedCommandSpec[] | undefined) ?? [],
  };
  // 나머지 형식/의미 검증(allowedReadPrefixes 형식, commandCwdAliases 형식, allowedCommands
  // 항목 형식 등)은 project-policy.ts의 기존 검증 함수에 위임한다 — 이 파일이 그 규칙을
  // 다시 만들지 않는다.
  validateProjectExecutionPolicy(policy, projectLabel);
  return policy;
}

function buildTaskDefinitionFromData(raw: unknown, index: number, projectLabel: string): TaskDefinition {
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid project config(${projectLabel}): taskRegistry[${index}]가 객체가 아닙니다.`);
  }
  const id = raw.id;
  const title = raw.title;
  const prompt = raw.prompt;
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new Error(`Invalid project config(${projectLabel}): taskRegistry[${index}].id가 비어있습니다.`);
  }
  if (typeof raw.phase !== "number" || typeof raw.taskNumber !== "number") {
    throw new Error(`Invalid project config(${projectLabel}): taskRegistry[${index}](${id}).phase/taskNumber가 숫자가 아닙니다.`);
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error(`Invalid project config(${projectLabel}): taskRegistry[${index}](${id}).title이 비어있습니다.`);
  }
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new Error(`Invalid project config(${projectLabel}): taskRegistry[${index}](${id}).prompt가 비어있습니다.`);
  }
  if (!Array.isArray(raw.requiredTests)) {
    throw new Error(`Invalid project config(${projectLabel}): taskRegistry[${index}](${id}).requiredTests가 배열이 아닙니다.`);
  }
  const requiredTests: RequiredTestCommand[] = raw.requiredTests.map((t, i) => {
    if (!isPlainObject(t) || typeof t.name !== "string" || typeof t.command !== "string" || !isStringArray(t.args) || typeof t.cwd !== "string") {
      throw new Error(
        `Invalid project config(${projectLabel}): taskRegistry[${index}](${id}).requiredTests[${i}]가 { name, command, args:string[], cwd } 형태가 아닙니다.`
      );
    }
    return { name: t.name, command: t.command, args: t.args, cwd: t.cwd };
  });
  if (!isStringArray(raw.allowedPathPrefixes) || raw.allowedPathPrefixes.length === 0) {
    throw new Error(`Invalid project config(${projectLabel}): taskRegistry[${index}](${id}).allowedPathPrefixes가 비어있습니다.`);
  }
  if (!isStringArray(raw.prohibitedOperations)) {
    throw new Error(`Invalid project config(${projectLabel}): taskRegistry[${index}](${id}).prohibitedOperations가 string[]이 아닙니다.`);
  }
  if (raw.isHumanGate !== undefined && typeof raw.isHumanGate !== "boolean") {
    throw new Error(`Invalid project config(${projectLabel}): taskRegistry[${index}](${id}).isHumanGate가 boolean이 아닙니다.`);
  }
  return {
    id,
    phase: raw.phase,
    taskNumber: raw.taskNumber,
    title,
    prompt,
    requiredTests,
    allowedPathPrefixes: raw.allowedPathPrefixes,
    prohibitedOperations: raw.prohibitedOperations,
    ...(raw.isHumanGate !== undefined ? { isHumanGate: raw.isHumanGate as boolean } : {}),
  };
}

function loadTaskRegistry(configDir: string, raw: Record<string, unknown>, projectLabel: string): TaskDefinition[] {
  const hasInline = raw.taskRegistry !== undefined;
  const hasPath = raw.taskRegistryPath !== undefined;
  if (hasInline === hasPath) {
    throw new Error(
      `Invalid project config(${projectLabel}): taskRegistry 또는 taskRegistryPath 중 정확히 하나만 지정해야 합니다.`
    );
  }
  let rawRegistry: unknown;
  if (hasInline) {
    rawRegistry = raw.taskRegistry;
  } else {
    const abs = resolveConfigRelativePath(configDir, raw.taskRegistryPath, "taskRegistryPath", { allowParentEscape: false });
    if (!existsSync(abs)) {
      throw new Error(`Invalid project config(${projectLabel}): taskRegistryPath가 가리키는 파일이 존재하지 않습니다: ${abs}`);
    }
    rawRegistry = readJsonDataFile(abs, `taskRegistry 데이터 파일(${abs})`);
  }
  if (!Array.isArray(rawRegistry)) {
    throw new Error(`Invalid project config(${projectLabel}): taskRegistry가 배열이 아닙니다.`);
  }
  return rawRegistry.map((t, i) => buildTaskDefinitionFromData(t, i, projectLabel));
}

export function loadProjectAdapter(adapterPath: string | undefined): ProjectManifest {
  if (!adapterPath || adapterPath.trim().length === 0) {
    throw new Error(
      "project config 경로가 지정되지 않았습니다 — --project <path> 또는 " +
        "AUTODEV_PROJECT_ADAPTER 환경변수로 명시적으로 지정하세요(기본 프로젝트 없음, " +
        "silent fallback 없음)."
    );
  }

  const resolvedPath = resolve(adapterPath.trim());
  if (!existsSync(resolvedPath)) {
    throw new Error(`project config 파일을 찾을 수 없습니다: ${resolvedPath}`);
  }
  if (extname(resolvedPath).toLowerCase() !== CONFIG_EXTENSION) {
    throw new Error(
      `project config는 JSON 데이터 파일이어야 합니다(.json) — 실행 가능한 adapter 모듈(.js/.cjs/.mjs/.ts 등)은 ` +
        `더 이상 지원되지 않습니다: ${resolvedPath}`
    );
  }

  const raw = readJsonDataFile(resolvedPath, "project config");
  if (!isPlainObject(raw)) {
    throw new Error(`Invalid project config: 최상위 값이 객체가 아닙니다(${resolvedPath}).`);
  }

  const projectLabel = typeof raw.projectId === "string" ? raw.projectId : "(project)";
  const configDir = dirname(resolvedPath);

  const targetProjectRoot = resolveConfigRelativePath(configDir, raw.targetProjectRoot, "targetProjectRoot", {
    allowParentEscape: true,
  });
  assertSaneTargetRoot(targetProjectRoot);

  const statePath = resolveConfigRelativePath(configDir, raw.statePath, "statePath", { allowParentEscape: false });
  const taskRegistry = loadTaskRegistry(configDir, raw, projectLabel);
  const executionPolicy = buildExecutionPolicyFromData(raw.executionPolicy, projectLabel);

  const manifest: ProjectManifest = {
    projectId: raw.projectId as string,
    projectName: raw.projectName as string,
    targetProjectRoot,
    statePath,
    taskRegistry,
    developerInstructions: raw.developerInstructions as string,
    reviewInstructions: raw.reviewInstructions as string,
    reviewScopeDirs: raw.reviewScopeDirs as string[],
    executionPolicy,
    ...(raw.rulesPath !== undefined ? { rulesPath: raw.rulesPath as string } : {}),
  };

  validateProjectManifest(manifest);
  return manifest;
}
