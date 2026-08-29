import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PROJECT_ROOT, DENY_PATH_PATTERNS, SECRET_NAME_PATTERNS, validateReadPath } from "./safe-executor";
import type { SafeExecutorContext } from "./safe-executor";

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
  /** status==="renamed"일 때만 채워진다 — rename 이전 경로(POSIX 상대경로). Incremental GPT
   *  Reviewer(SI-3.8D)가 rename을 정확히 표현하는 데 쓴다. 기존 소비처(checkpoint.ts/
   *  secret-scanner.ts/dependency-scanner.ts)는 이 필드를 읽지 않으므로 동작에 영향 없다. */
  renamedFrom?: string;
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
    // "R  old -> new" — 커밋 대상은 new만 취급하되, old 경로도 renamedFrom으로 보존한다
    // (SI-3.8D Incremental GPT Reviewer가 rename을 modification/deletion과 구분해 정확히
    // 표현하는 데 쓴다 — § 요구사항 7).
    const arrowIdx = rest.indexOf(" -> ");
    if (arrowIdx === -1) return { path: rest, status: "renamed" };
    const oldPath = rest.slice(0, arrowIdx);
    const newPath = rest.slice(arrowIdx + 4);
    return { path: newPath, status: "renamed", renamedFrom: oldPath };
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
 *  (파일명을 셸 문자열에 이어붙이지 않음, injection 방지). pathspec에는 scopeDirs(디렉터리
 *  prefix)뿐 아니라 개별 파일 경로 목록도 그대로 넘길 수 있다(git diff pathspec 문법이
 *  동일) — SI-3.8D Incremental GPT Reviewer가 "변경된 파일만"의 diff를 얻는 데 이 함수를
 *  그대로 재사용한다(중복 구현 없음). -M(rename detection)을 추가해 rename을 delete+add
 *  두 hunk로 쪼개 보여주는 대신 "rename from X to Y" 형태로 정확히 표현한다(§ 요구사항 7) —
 *  rename을 감지하려면 old/new 경로가 모두 같은 git diff 호출의 pathspec 범위 안에 있어야
 *  하므로, 호출부(SI-3.8D)는 renamed 파일의 old path도 함께 pathspec에 포함해서 넘긴다.
 *
 *  HEAD를 명시적으로 기준으로 준다(기존에는 인자 없이 "git diff"만 써서 사실상 index 기준
 *  — unstaged만 — 비교였다) — getWorkingTreeChanges()(git status --porcelain)는 staged(X
 *  column)와 unstaged(Y column) 변경을 이미 모두 합쳐서 보고하는데, 예전 "git diff"(HEAD 생략)
 *  는 staged 변경(예: rename이 git add로 index에 반영된 경우)의 실제 diff 내용을 전혀 보여주지
 *  못했다(실제로 재현해 확인함 — staged rename 이후 "git diff"는 빈 문자열을 반환하지만
 *  "git diff HEAD"는 정확한 rename diff를 반환한다). 이 저장소의 실제 운용 흐름은 review 시점
 *  이전에 git add를 하지 않으므로(index === HEAD인 게 보통) 대다수 경우 결과가 동일하지만,
 *  staged 상태가 섞여 있어도 항상 "HEAD 대비 실제 working tree 전체 차이"를 정확히 반영하도록
 *  고쳤다. */
export function getTrackedDiff(scopeDirs: string[], cwd: string = PROJECT_ROOT): string {
  const res = spawnSync("git", ["diff", "-M", "HEAD", "--", ...scopeDirs], { cwd, shell: false, encoding: "utf-8" });
  if (res.status !== 0) return "";
  return res.stdout || "";
}

/** 현재 HEAD commit hash(읽기 전용) — Phase G Task G6 Auto Resume의 Git Safety recheck가
 *  "승인 생성 시점 이후 HEAD가 바뀌었는가"를 판정하는 데 재사용한다(git-changes.ts를 이
 *  판단의 단일 출처로 유지 — auto-resume.ts가 별도 spawnSync 로직을 새로 만들지 않는다).
 *  실패하면(예: HEAD가 아직 없는 repo) undefined — 호출부가 "알 수 없으면 진행하지 않는다"로
 *  처리한다. */
export function getCurrentHeadHash(cwd: string = PROJECT_ROOT): string | undefined {
  const res = spawnSync("git", ["rev-parse", "HEAD"], { cwd, shell: false, encoding: "utf-8" });
  if (res.status !== 0) return undefined;
  const hash = (res.stdout || "").trim();
  return hash.length > 0 ? hash : undefined;
}

/** 현재 branch 이름(읽기 전용) — HEAD hash와 동일한 목적(Auto Resume Git Safety recheck)으로
 *  재사용된다. detached HEAD 등으로 이름을 알 수 없으면 undefined. */
export function getCurrentBranch(cwd: string = PROJECT_ROOT): string | undefined {
  const res = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, shell: false, encoding: "utf-8" });
  if (res.status !== 0) return undefined;
  const branch = (res.stdout || "").trim();
  return branch.length > 0 && branch !== "HEAD" ? branch : undefined;
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
  /** AutoDev Core Maintenance — Reviewer Payload Binary Safety. true면 content는 실제 파일
   *  내용이 아니라 § readFileSmartly()가 만든 metadata 요약이다(원문은 payload에 전혀
   *  들어가지 않았다). */
  binary?: boolean;
}

const BINARY_SNIFF_SAMPLE_BYTES = 8_000;

/** git 자신의 binary 판정 휴리스틱(xdiff buffer_is_binary — 앞부분 표본에 NUL 바이트가
 *  있으면 binary)과 동일한 원칙을 그대로 쓴다 — 확장자 blacklist가 아니라 실제 바이트
 *  내용을 본다(§ 요구사항 — "정상 source-controlled binary도 존재할 수 있다"). */
export function isBinaryContent(buf: Buffer): boolean {
  const len = Math.min(buf.length, BINARY_SNIFF_SAMPLE_BYTES);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export interface SmartFileRead {
  content: string;
  binary: boolean;
  sizeBytes: number;
  sha256?: string;
}

/**
 * AutoDev Core Maintenance — Reviewer Payload Binary Safety(Category D). 파일을 항상
 * utf-8로 강제 디코딩하지 않는다 — 먼저 Buffer로 읽어 실제 바이트 내용으로 binary 여부를
 * 판정하고(§ isBinaryContent), binary로 판정되면 raw content 대신 path/size/hash만 담은
 * 사람이 읽을 수 있는 metadata 한 줄을 반환한다(원문은 어디에도 포함되지 않는다). text
 * 파일은 기존과 100% 동일하게 그대로 utf-8 문자열을 반환한다 — 이 함수는 이 저장소 전체에서
 * "파일을 읽어 review/commit payload에 넣는" 두 지점(이 파일의 readUntrackedFiles,
 * gpt-reviewer.ts의 makeFileStateReader)이 공유하는 단일 구현이다(로직 복제 없음).
 */
export function readFileSmartly(absPath: string, relPathForMetadata: string, changeType: string): SmartFileRead {
  const buf = readFileSync(absPath);
  if (isBinaryContent(buf)) {
    const sha256 = createHash("sha256").update(buf).digest("hex");
    return {
      content: `[AUTODEV BINARY FILE — raw content not included] path=${relPathForMetadata} changeType=${changeType} sizeBytes=${buf.length} sha256=${sha256}`,
      binary: true,
      sizeBytes: buf.length,
      sha256,
    };
  }
  return { content: buf.toString("utf-8"), binary: false, sizeBytes: buf.length };
}

// AutoDev Reviewer Snapshot Truncation Fix(2026-08-26, JARVIS Task 1.3 — Fireworks가 20,235자
// 테스트 파일을 head-only truncation 때문에 "물리적으로 잘린/미완성 파일"로 오판해 반복 REVISE함).
// 이전에는 예산 초과 시 raw.slice(0, cap)만 반환했다 — 파일 끝(닫는 함수 호출/export/summary
// 등)이 통째로 사라지고, 그 사실을 알려주는 표시는 호출부(gpt-reviewer.ts)가 붙이는 헤더 한 줄
// ("(내용 일부 truncated)")뿐이라 실제 잘린 지점 자체는 아무 경계 표시 없이 그냥 끊겼다 —
// reviewer 입장에서는 "물리적으로 손상된 파일"과 "AutoDev가 예산 때문에 자른 파일"을 구분할
// 방법이 없었다.
//
// 요구사항: per-file 예산은 그대로 bounded(임의로 늘리지 않음) — 대신 그 예산 안에서 HEAD +
// 명시적 truncation marker + TAIL(파일의 실제 물리적 끝) 세 부분으로 재분배한다. tail을 항상
// 일정 길이 확보해두면(TRUNCATION_TAIL_CHARS) "닫는 syntax/마지막 함수 호출/summary"가 예산
// 크기와 무관하게 항상 보이게 된다. marker 자체의 길이만큼만 총 출력이 cap을 살짝 넘을 수 있다
// (명시적으로 계산해 로그/코드에 남기는 것이지 조용히 예산을 어기는 게 아니다).
const TRUNCATION_TAIL_CHARS = 2_000;

/** 결정적(no LLM) 순수 함수 — 동일 입력엔 항상 동일 출력. cap 이하 파일은 완전히 그대로
 *  반환한다(truncated:false, marker 없음 — 기존 동작 100% 보존). cap을 넘으면 head(cap의 앞
 *  대부분) + explicit marker + tail(파일의 실제 마지막 부분)을 이어붙인다 — marker에는
 *  reviewer가 "물리적으로 잘린 게 아니라 AutoDev가 잘랐다"를 판단할 수 있는 정보
 *  (원본 길이/생략된 글자 수/tail 보존 여부)를 그대로 담는다. */
export function buildBoundedFileSnapshot(raw: string, cap: number): { content: string; truncated: boolean } {
  if (raw.length <= cap) return { content: raw, truncated: false };

  const tailChars = Math.max(0, Math.min(TRUNCATION_TAIL_CHARS, Math.floor(cap / 4)));
  const headChars = Math.max(0, cap - tailChars);
  const head = raw.slice(0, headChars);
  const tail = tailChars > 0 ? raw.slice(raw.length - tailChars) : "";
  const omittedChars = raw.length - head.length - tail.length;
  const marker = `\n[AUTODEV REVIEW SNAPSHOT TRUNCATED original_chars=${raw.length} omitted_chars=${omittedChars} tail_preserved=${tail.length > 0}]\n`;
  return { content: `${head}${marker}${tail}`, truncated: true };
}

/**
 * untracked 파일들의 내용을 안전하게 읽는다 — Safe Executor의 validateReadPath()를 그대로
 * 재사용해 읽기 허용 범위(web/**, automation/**, supabase/migrations/**) 밖이거나
 * secret 이름 패턴에 걸리는 파일은 아예 읽지 않는다(이중 방어). totalBudgetChars를
 * 넘기면 그 이후 파일은 건너뛰고 skipped에 기록한다(어떤 파일이 잘렸는지 호출부가 알 수
 * 있게 하기 위함 — 요구사항: "truncation 시 어떤 파일이 잘렸는지 reviewer가 알 수 있게").
 *
 * Phase C Task C2 — executor(SafeExecutorContext)를 지정하면 그 context의
 * validateReadPath만 쓴다(그 project run 전용 root/policy로 검증) — module-level 전역
 * validateReadPath/currentPolicy에 의존하지 않는다. 지정하지 않으면 기존과 동일하게
 * module-level singleton(configureSafeExecutor로 주입된 것)을 쓴다(하위 호환).
 */
export function readUntrackedFiles(
  changes: WorkingTreeChange[],
  opts: { perFileMaxChars?: number; totalBudgetChars?: number } = {},
  executor?: Pick<SafeExecutorContext, "validateReadPath">
): { files: UntrackedFileContent[]; skipped: string[] } {
  const perFileMaxChars = opts.perFileMaxChars ?? 20_000;
  const totalBudgetChars = opts.totalBudgetChars ?? 65_000;
  const doValidateReadPath = executor?.validateReadPath ?? validateReadPath;
  const files: UntrackedFileContent[] = [];
  const skipped: string[] = [];
  let used = 0;

  for (const change of changes) {
    if (used >= totalBudgetChars) {
      skipped.push(change.path);
      continue;
    }
    const v = doValidateReadPath(change.path);
    if (!v.ok) {
      skipped.push(`${change.path} (읽기 거부: ${v.reason})`);
      continue;
    }
    let smartRead: SmartFileRead;
    try {
      smartRead = readFileSmartly(v.abs, change.path, change.status);
    } catch {
      skipped.push(`${change.path} (읽기 실패)`);
      continue;
    }
    if (smartRead.binary) {
      // binary metadata 요약은 이미 짧고 고정된 형태다 — buildBoundedFileSnapshot의 truncation
      // 로직을 적용할 대상이 아니다(원문 자체가 없으므로 "잘릴 원본"이 없다).
      used += smartRead.content.length;
      files.push({ path: change.path, content: smartRead.content, truncated: false, binary: true });
      continue;
    }
    const remaining = totalBudgetChars - used;
    const cap = Math.min(perFileMaxChars, remaining);
    const { content, truncated } = buildBoundedFileSnapshot(smartRead.content, cap);
    used += content.length;
    files.push({ path: change.path, content, truncated });
  }

  return { files, skipped };
}
