import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { PROJECT_ROOT, DENY_PATH_PATTERNS, SECRET_NAME_PATTERNS, validateReadPath } from "./safe-executor";

// 변경 파일 탐지의 단일 출처. 이전에는 claude-developer.ts(getActualChangedFiles)와
// gpt-reviewer.ts(getScopedDiff)가 각자 "git diff --name-only"만 사용해 신규(untracked)
// 파일을 놓쳤다(§ 요구사항 3 — GPT가 신규 파일을 review하지 못하는 치명적 구조 문제).
// git status --porcelain은 tracked modified/added/deleted와 untracked(??)를 한 번에
// 알려주므로 이걸 기준으로 삼는다. 이 모듈은 git index를 바꾸는 어떤 명령도 실행하지
// 않는다(git add -N 등 금지 — 요구사항 명시).

export interface WorkingTreeChange {
  /** POSIX 상대경로(프로젝트 루트 기준). */
  path: string;
  status: "modified" | "added" | "deleted" | "renamed" | "untracked";
}

export interface WorkingTreeChanges {
  all: WorkingTreeChange[];
  tracked: WorkingTreeChange[]; // modified/added/deleted/renamed — git diff로 내용 조회 가능
  untracked: WorkingTreeChange[]; // git이 전혀 추적하지 않는 신규 파일
  /** DENY_PATH_PATTERNS/SECRET_NAME_PATTERNS에 걸려 review/commit 대상에서 제외된 경로. */
  excluded: string[];
}

const TEMP_FILE_PATTERNS: RegExp[] = [
  // 테스트 fixture 등 항상 review/commit 대상에서 제외할 임시 파일. 이 패턴은 Safe
  // Executor의 read/write 허용 범위(DENY_PATH_PATTERNS)에는 포함시키지 않는다 —
  // safe-executor-tests.ts/claude-developer-tests.ts가 실제로 automation/tmp-*.txt에
  // 쓰기 fixture를 만들어야 하기 때문이다. review/commit 단계에서만 걸러낸다.
  /(^|\/)tmp-/i,
  /\.tmp$/i,
];

function isExcludedPath(relPath: string): boolean {
  return (
    DENY_PATH_PATTERNS.some((p) => p.test(relPath)) ||
    SECRET_NAME_PATTERNS.some((p) => p.test(relPath.split("/").pop() ?? relPath)) ||
    TEMP_FILE_PATTERNS.some((p) => p.test(relPath))
  );
}

function parsePorcelainLine(line: string): WorkingTreeChange | null {
  if (line.length < 4) return null;
  const x = line[0];
  const y = line[1];
  const rest = line.slice(3);
  if (x === "?" && y === "?") return { path: rest, status: "untracked" };
  if (x === "R" || y === "R") {
    // "R  old -> new" — 커밋 대상은 new만 취급한다.
    const arrowIdx = rest.indexOf(" -> ");
    const newPath = arrowIdx === -1 ? rest : rest.slice(arrowIdx + 4);
    return { path: newPath, status: "renamed" };
  }
  if (x === "D" || y === "D") return { path: rest, status: "deleted" };
  if (x === "A" || y === "A") return { path: rest, status: "added" };
  return { path: rest, status: "modified" };
}

/**
 * scopeDirs(예: ["web/", "automation/"]) 범위의 working tree 변경을 tracked/untracked로
 * 구분해 반환한다. index를 전혀 바꾸지 않는다(git add 등 실행 안 함).
 */
export function getWorkingTreeChanges(scopeDirs: string[], cwd: string = PROJECT_ROOT): WorkingTreeChanges {
  // --untracked-files=all은 필수다: 기본값(normal)은 완전히 새로운(전체가 untracked인)
  // 디렉터리를 파일 단위가 아니라 "디렉터리 하나"로 뭉쳐서 보고한다(예: 새 web/app/x.tsx
  // 하나만 있어도 "?? web/"로만 나옴) — 이러면 개별 파일 경로를 전혀 알 수 없어 read/
  // allowedPathPrefixes 판정이 모두 깨진다. .gitignore된 node_modules/.next/dist/logs는
  // 이 옵션과 무관하게(--ignored를 별도로 주지 않는 한) 여전히 제외되므로, 대형 디렉터리를
  // 전부 훑는 성능 문제는 발생하지 않는다.
  const res = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ...scopeDirs], {
    cwd,
    shell: false,
    encoding: "utf-8",
  });
  const all: WorkingTreeChange[] = [];
  const excluded: string[] = [];
  if (res.status === 0) {
    for (const rawLine of (res.stdout || "").split("\n")) {
      if (!rawLine) continue;
      const parsed = parsePorcelainLine(rawLine);
      if (!parsed) continue;
      if (isExcludedPath(parsed.path)) {
        excluded.push(parsed.path);
        continue;
      }
      all.push(parsed);
    }
  }
  const untracked = all.filter((c) => c.status === "untracked");
  const tracked = all.filter((c) => c.status !== "untracked");
  return { all, tracked, untracked, excluded };
}

/** tracked 파일들의 diff 텍스트 — 기존 gpt-reviewer.ts의 고정 인자 방식을 그대로 유지한다
 *  (파일명을 셸 문자열에 이어붙이지 않음, injection 방지). */
export function getTrackedDiff(scopeDirs: string[], cwd: string = PROJECT_ROOT): string {
  const res = spawnSync("git", ["diff", "--", ...scopeDirs], { cwd, shell: false, encoding: "utf-8" });
  if (res.status !== 0) return "";
  return res.stdout || "";
}

/** relPath가 allowedPathPrefixes(예: task-registry.ts TaskDefinition.allowedPathPrefixes)
 *  중 하나에 속하는지 판정한다 — checkpoint.ts(commit 대상 판정)와 gpt-reviewer.ts(review
 *  payload 범위/scope-violation 판정)가 이 하나의 구현만 공유한다(중복 구현 금지). */
export function isPathInScope(relPath: string, allowedPathPrefixes: string[]): boolean {
  return allowedPathPrefixes.some((prefix) => {
    const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
    return relPath === prefix || relPath.startsWith(normalized);
  });
}

export interface UntrackedFileContent {
  path: string;
  content: string;
  truncated: boolean;
}

/**
 * untracked 파일들의 내용을 안전하게 읽는다 — Safe Executor의 validateReadPath()를 그대로
 * 재사용해 읽기 허용 범위(web/**, automation/**, supabase/migrations/**) 밖이거나
 * secret 이름 패턴에 걸리는 파일은 아예 읽지 않는다(이중 방어). totalBudgetChars를
 * 넘기면 그 이후 파일은 건너뛰고 skipped에 기록한다(어떤 파일이 잘렸는지 호출부가 알 수
 * 있게 하기 위함 — 요구사항: "truncation 시 어떤 파일이 잘렸는지 reviewer가 알 수 있게").
 */
export function readUntrackedFiles(
  changes: WorkingTreeChange[],
  opts: { perFileMaxChars?: number; totalBudgetChars?: number } = {}
): { files: UntrackedFileContent[]; skipped: string[] } {
  const perFileMaxChars = opts.perFileMaxChars ?? 20_000;
  const totalBudgetChars = opts.totalBudgetChars ?? 65_000;
  const files: UntrackedFileContent[] = [];
  const skipped: string[] = [];
  let used = 0;

  for (const change of changes) {
    if (used >= totalBudgetChars) {
      skipped.push(change.path);
      continue;
    }
    const v = validateReadPath(change.path);
    if (!v.ok) {
      skipped.push(`${change.path} (읽기 거부: ${v.reason})`);
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(v.abs, "utf-8");
    } catch {
      skipped.push(`${change.path} (읽기 실패)`);
      continue;
    }
    const remaining = totalBudgetChars - used;
    const cap = Math.min(perFileMaxChars, remaining);
    const truncated = raw.length > cap;
    const content = truncated ? raw.slice(0, cap) : raw;
    used += content.length;
    files.push({ path: change.path, content, truncated });
  }

  return { files, skipped };
}
