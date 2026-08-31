import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { PROJECT_ROOT } from "./safe-executor";
import { getWorkingTreeChanges } from "./git-changes";
import type { WorkingTreeChange } from "./git-changes";
import type { TaskChangeBaseline, TaskChangeBaselineEntry } from "./types";

// Checkpoint Provenance/Baseline Hardening(2026-08-31, JARVIS Task 5.3 Canary 사실검증으로
// 확인된 production 결함) — root cause: checkpoint.ts(computeCommitPlan)는 지금까지 "현재
// working tree 전체"만 보고 allowedPathPrefixes(경로) 하나만으로 allowed/unexpected를
// 나눴다 — 그 변경이 "이 task가 실제로 만든 것"인지 "task 시작 전부터 이미 있던 것"인지는
// 전혀 구분하지 않았다. 그 결과 (1) task와 무관한 pre-existing 파일이 매번 scope violation
// 으로 checkpoint 전체를 막고, (2) CHECKPOINT_SCOPE_VIOLATION의 기존 기술적 자동복구
// (human-gate-policy.ts TECHNICAL_AUTO_RECOVERABLE, autodev.ts leftover cleanup)가 다음
// 실행에서 그 pre-existing 파일을 "이 task의 leftover"로 오인해 실제로 삭제할 수 있었다 —
// 실제 JARVIS 저장소에서 이 task와 무관한 사용자 파일 2건이 정확히 이 상태로 관측됨.
//
// 이 모듈은 "task 시작 시점의 working tree 스냅샷(baseline)"을 캡처/비교하는 유일한 구현이다
// — checkpoint.ts(commit 대상 판정: 이 task가 만든 것으로 보이는 변경만 commit하고, pre-
// existing unchanged 변경은 건드리지 않는다)가 이 모듈을 쓴다. 판정은 오직 실제 파일 내용의
// sha256 비교로만 이뤄진다 — mtime은 어디에도 쓰이지 않는다(파일 시스템에 따라 mtime 해상도가
// 낮거나, 내용을 바꾸지 않는 재저장 등으로 mtime만 바뀌는 경우가 있어 신뢰할 수 없다).
//
// Positive-Provenance-Only Auto-Delete Policy(2026-08-31) — 이 모듈의 baseline-absence
// 판정("이 경로가 task 시작 시점엔 없었다")은 "AutoDev/Claude Developer가 이 파일을 만들었다"
// 는 증명이 아니다 — 실제 조사 결과 이 저장소에는 파일 경로를 taskId/attempt/round에 연결하는
// durable action log가 어디에도 없다(claude-developer.ts의 ClaudeResult.changedFiles조차
// 매 라운드 git status로 다시 계산한 diff일 뿐, "AutoDev가 이 action으로 이 파일을 썼다"는
// 기록이 아니다). 그래서 autodev.ts는 이 모듈을 파일 자동 삭제 판단에 더 이상 쓰지 않는다 —
// commit 대상 판정(부작위·보존 방향)과 삭제 판정(작위·파괴적 방향)은 요구되는 증명의 수준이
// 다르며, 후자에는 이 모듈이 제공하는 신호로 충분하지 않다.
//
// 캡처 시점: orchestrator.ts가 이 task의 진짜 첫 attempt를 시작할 때(resumingSameTask===false)
// 딱 한 번만 호출한다 — 같은 task를 재시도/크래시-재시작으로 이어가는 동안(resumingSameTask
// ===true)은 절대 재캡처하지 않는다. 재캡처하면 이 task 자신이 이미 만든(아직 commit 전인)
// 변경을 "task 시작 전부터 있던 것"으로 오분류해 그 변경을 영원히 commit하지 못하게 된다.

const DELETED_CONTENT_TOKEN = "DELETED";
// 파일을 읽을 수 없으면(권한/race 등) "동일하다"고 증명할 방법이 없다 — fail-closed로
// baseline 값과 항상 다르게 취급되도록 baseline contentHash로도, 현재 비교값으로도 쓰일 수
// 있는 고정 sentinel을 쓴다(실제 sha256 hex와 절대 charset이 겹치지 않도록 hex가 아닌 문자를
// 포함한다).
const UNREADABLE_CONTENT_TOKEN = "UNREADABLE-CANNOT-PROVE-UNCHANGED";

function hashFileBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** 현재 시점의 "내용 토큰"— baseline 캡처와 delta 비교가 완전히 동일한 함수를 공유한다(값이
 *  서로 다른 기준으로 계산되면 비교 자체가 무의미해진다). status==="deleted"는 디스크에 읽을
 *  내용이 없으므로 고정 sentinel을 쓴다. */
function computeCurrentContentToken(cwd: string, change: Pick<WorkingTreeChange, "path" | "status">): string {
  if (change.status === "deleted") return DELETED_CONTENT_TOKEN;
  const abs = join(cwd, ...change.path.split("/"));
  try {
    return hashFileBytes(readFileSync(abs));
  } catch {
    return UNREADABLE_CONTENT_TOKEN;
  }
}

/** 이 task의 진짜 첫 attempt 시작 시점에 현재 working tree 전체(scope 안/밖 무관 — 나중에
 *  scope 판정을 하려면 scope 밖 pre-existing 파일도 알아야 한다)를 스냅샷한다. 순수 읽기
 *  전용 — git index/working tree 어느 쪽도 바꾸지 않는다. */
export function captureTaskChangeBaseline(taskId: string, cwd: string = PROJECT_ROOT): TaskChangeBaseline {
  const changes = getWorkingTreeChanges(["."], cwd).all;
  const entries: TaskChangeBaselineEntry[] = changes.map((c) => ({
    path: c.path,
    status: c.status,
    contentHash: computeCurrentContentToken(cwd, c),
  }));
  return { taskId, capturedAt: new Date().toISOString(), entries };
}

export interface TaskChangeDeltaPlan {
  /** baseline에 전혀 없던 경로 — 이 task/attempt 동안 새로 생긴(순수 신규) 변경. */
  newSinceBaseline: WorkingTreeChange[];
  /** baseline에 있었지만 현재 내용(또는 존재 여부)이 baseline과 다른 경로 — task 시작 전부터
   *  있던 파일이지만 이번 task 동안 내용이 바뀌었다(pre-existing과 task 변경이 한 파일에
   *  섞여 있어 안전하게 분리할 수 없다). */
  modifiedSinceBaseline: WorkingTreeChange[];
  /** baseline과 내용이 완전히 동일해(hash 일치) 이 task와 무관하다고 확인된 변경. */
  preExistingUnchanged: WorkingTreeChange[];
}

/** baseline 대비 현재 변경을 세 그룹으로 나눈다. baseline이 없으면(예: 이 기능 도입 이전에
 *  이미 진행 중이던 task — 레거시 project-state.json) 모든 변경을 newSinceBaseline으로
 *  본다 — 이는 이 함수 도입 이전의 기존 checkpoint 동작(working tree 전체를 이 task의 몫으로
 *  취급)과 완전히 동일한 fallback이다(새로운 위험을 만들지 않는다).
 *
 *  주의 — 이 분류는 commit 대상 판정(checkpoint.ts)에만 쓰인다. "baseline에 없다(=task
 *  시작 후 새로 생겼다)"는 사실은 "AutoDev/Claude Developer가 이 파일을 만들었다"는 증명이
 *  아니다(같은 시간 창에 사용자/IDE/빌드도구/동기화 프로그램이 만들었을 수 있다 — 이
 *  저장소에는 파일 경로를 taskId/attempt/round에 연결하는 durable action log가 없다, §
 *  Positive-Provenance-Only Auto-Delete Policy 조사). 그래서 이 함수의 결과를 파일 삭제
 *  판단에 재사용하지 않는다 — 자동 삭제는 이 baseline-absence 신호를 아예 쓰지 않는다(§
 *  autodev.ts scope-violation cleanup, 2026-08-31 이후로는 어떤 경우에도 삭제하지 않는다). */
export function classifyTaskChangeDelta(
  baseline: TaskChangeBaseline | null | undefined,
  changes: WorkingTreeChange[],
  cwd: string = PROJECT_ROOT
): TaskChangeDeltaPlan {
  const baselineMap = new Map((baseline?.entries ?? []).map((e) => [e.path, e]));
  const newSinceBaseline: WorkingTreeChange[] = [];
  const modifiedSinceBaseline: WorkingTreeChange[] = [];
  const preExistingUnchanged: WorkingTreeChange[] = [];

  for (const c of changes) {
    const entry = baselineMap.get(c.path);
    if (!entry) {
      newSinceBaseline.push(c);
      continue;
    }
    const currentToken = computeCurrentContentToken(cwd, c);
    if (currentToken === entry.contentHash) {
      preExistingUnchanged.push(c);
    } else {
      modifiedSinceBaseline.push(c);
    }
  }

  return { newSinceBaseline, modifiedSinceBaseline, preExistingUnchanged };
}
