// AutoDev 범용화 Phase B Task B1 — Project Execution Policy.
//
// 지금까지 safe-executor.ts(AutoDev Core)에 직접 하드코딩돼 있던 "이 프로젝트에서 무엇을
// 읽고/쓰고/실행할 수 있는가"라는 실제 enforcement 데이터(read/write 허용 경로, 명령
// allow-list)를 프로젝트가 명시적으로 주입하는 하나의 타입으로 뽑아낸다. Safe Executor 자체
// (resolveSafe의 root 탈출/symlink 방어, DENY_PATH_PATTERNS/SECRET_NAME_PATTERNS 같은 Core
// hard rule)는 이 파일이 손대지 않는다 — Project Policy는 Core 보안을 강화할 수는 있어도
// (writeDenyPatterns로 추가 차단 규칙을 더할 수 있다) 약화할 수는 없다(Core hard rule은
// safe-executor.ts에만 있고, 이 타입에는 그것을 끄는 필드가 없다).

export interface AllowedCommandSpec {
  /** "root"(항상 사용 가능 — targetProjectRoot 자체)이거나 commandCwdAliases에 정의된 별칭. */
  cwd: string;
  command: string;
  args: string[];
}

export interface ProjectExecutionPolicy {
  /** POSIX 상대경로 prefix(trailing "/") — Safe Executor read 허용 범위. */
  allowedReadPrefixes: string[];
  /** POSIX 상대경로 prefix(trailing "/") — Safe Executor write 허용 범위. */
  allowedWritePrefixes: string[];
  /** allowedWritePrefixes 안에서도 항상 write를 금지할 프로젝트별 추가 패턴(예: MOVAN의
   *  immutable migration 파일, README.md) — Core의 DENY_PATH_PATTERNS/SECRET_NAME_PATTERNS
   *  위에 추가될 뿐 그것을 대체하지 않는다. */
  writeDenyPatterns?: RegExp[];
  /** "root" 외에 명령 실행에 쓸 수 있는 cwd 별칭 → targetProjectRoot 기준 상대경로. */
  commandCwdAliases?: Record<string, string>;
  /** 정확히 일치하는 command+args+cwd 조합만 허용(패턴 아님) — allow-list 밖은 전부 거부. */
  allowedCommands: AllowedCommandSpec[];
}

function isRelativeDirPrefix(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (!value.endsWith("/")) return false;
  if (value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) return false;
  if (value.split("/").includes("..")) return false;
  return true;
}

function isRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) return false;
  if (value.split(/[\\/]/).includes("..")) return false;
  return true;
}

/**
 * policy가 명시적으로 주입됐을 때 즉시 검증한다 — 잘못된 필드가 있으면 여기서 바로 throw하고,
 * 절대 permissive한 기본값으로 조용히 대체하지 않는다.
 */
export function validateProjectExecutionPolicy(policy: ProjectExecutionPolicy, projectLabel = "(project)"): void {
  if (!policy || typeof policy !== "object") {
    throw new Error(`Invalid ProjectExecutionPolicy(${projectLabel}): policy가 비어있거나 객체가 아닙니다.`);
  }
  if (!Array.isArray(policy.allowedReadPrefixes) || policy.allowedReadPrefixes.length === 0) {
    throw new Error(`Invalid ProjectExecutionPolicy(${projectLabel}): allowedReadPrefixes가 비어있습니다.`);
  }
  if (!policy.allowedReadPrefixes.every(isRelativeDirPrefix)) {
    throw new Error(
      `Invalid ProjectExecutionPolicy(${projectLabel}): allowedReadPrefixes는 "/"로 끝나는 상대경로여야 합니다(절대경로/".." 금지).`
    );
  }
  if (!Array.isArray(policy.allowedWritePrefixes) || policy.allowedWritePrefixes.length === 0) {
    throw new Error(`Invalid ProjectExecutionPolicy(${projectLabel}): allowedWritePrefixes가 비어있습니다.`);
  }
  if (!policy.allowedWritePrefixes.every(isRelativeDirPrefix)) {
    throw new Error(
      `Invalid ProjectExecutionPolicy(${projectLabel}): allowedWritePrefixes는 "/"로 끝나는 상대경로여야 합니다(절대경로/".." 금지).`
    );
  }
  if (policy.writeDenyPatterns !== undefined) {
    if (!Array.isArray(policy.writeDenyPatterns) || !policy.writeDenyPatterns.every((p) => p instanceof RegExp)) {
      throw new Error(`Invalid ProjectExecutionPolicy(${projectLabel}): writeDenyPatterns는 RegExp 배열이어야 합니다.`);
    }
  }
  const aliases = policy.commandCwdAliases;
  if (aliases !== undefined) {
    if (typeof aliases !== "object" || aliases === null || Array.isArray(aliases)) {
      throw new Error(`Invalid ProjectExecutionPolicy(${projectLabel}): commandCwdAliases는 객체여야 합니다.`);
    }
    if ("root" in aliases) {
      throw new Error(`Invalid ProjectExecutionPolicy(${projectLabel}): commandCwdAliases에 예약어 "root"를 재정의할 수 없습니다.`);
    }
    for (const [alias, rel] of Object.entries(aliases)) {
      if (!isRelativePath(rel)) {
        throw new Error(`Invalid ProjectExecutionPolicy(${projectLabel}): commandCwdAliases["${alias}"]가 유효한 상대경로가 아닙니다.`);
      }
    }
  }
  if (!Array.isArray(policy.allowedCommands)) {
    throw new Error(`Invalid ProjectExecutionPolicy(${projectLabel}): allowedCommands가 배열이 아닙니다.`);
  }
  for (const c of policy.allowedCommands) {
    if (!c || typeof c !== "object") {
      throw new Error(`Invalid ProjectExecutionPolicy(${projectLabel}): allowedCommands 항목이 객체가 아닙니다.`);
    }
    if (typeof c.cwd !== "string" || c.cwd.length === 0) {
      throw new Error(`Invalid ProjectExecutionPolicy(${projectLabel}): allowedCommands 항목의 cwd가 비어있습니다.`);
    }
    if (c.cwd !== "root" && !(aliases && c.cwd in aliases)) {
      throw new Error(
        `Invalid ProjectExecutionPolicy(${projectLabel}): allowedCommands 항목의 cwd("${c.cwd}")가 "root"도 아니고 commandCwdAliases에도 정의되지 않았습니다.`
      );
    }
    if (typeof c.command !== "string" || c.command.length === 0) {
      throw new Error(`Invalid ProjectExecutionPolicy(${projectLabel}): allowedCommands 항목의 command가 비어있습니다.`);
    }
    if (!Array.isArray(c.args) || !c.args.every((a) => typeof a === "string")) {
      throw new Error(`Invalid ProjectExecutionPolicy(${projectLabel}): allowedCommands 항목의 args가 string[]이 아닙니다.`);
    }
  }
}
