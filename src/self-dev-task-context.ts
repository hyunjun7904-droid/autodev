import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getCurrentHeadHash } from "./git-changes";
import { TASK_ID_PATTERN } from "./self-dev-completion";

// Self-Dev Task Context — Phase G Task G7.3.1b (Self-Dev Completion Workflow Auto
// Trigger Fix).
//
// G7.2.1의 Self-Dev Completion Bridge(self-dev-complete.ts)는 존재하지만, 이걸 언제
// 호출할지는 전적으로 Claude Code 세션이 절차 마지막에 "기억해서" 실행하는 것에 의존했다
// (§ .claude/skills/task-complete/SKILL.md 기존 step 7) — G7.3.1a에서 실제로 이 단계가
// 누락되어 완료 알림이 오지 않는 사고가 재현됐다. 이 파일은 그 gap을 메우는 자동 트리거
// (self-dev-completion-hook.ts, Claude Code PostToolUse hook)가 "지금 이 git push/commit이
// 어느 Task의 완료를 의미하는가"를 추측하지 않고 알 수 있게 하는 유일한 명시적 경로다.
//
// taskId를 커밋 메시지나 세션 transcript에서 파싱하지 않는다(추측 금지, § 요구사항) — 대신
// Claude가 완료 절차를 시작하기 직전(§ SKILL.md 새 step) `npm run self-dev:begin --
// --task-id <id> [--push]`를 명시적으로 실행해 이 파일에 선언한다. 이 파일이 없거나
// 형식이 깨지면 hook은 아무 것도 트리거하지 않는다(fail-closed — "선언 안 됨"과 "선언이
// 손상됨"을 구분해서 완화하지 않는다).
//
// 이 파일은 로컬 전용(gitignored, `.autodev-self-dev/`)이다 — repo 이력에 남기지 않는다.
// git-tracked 상태가 아니므로 이 선언 자체가 "완료됐다"는 증거가 되지 않는다(여전히
// self-dev-complete.ts의 deterministic 재검증만이 TASK_COMPLETED를 만든다).
//
// baseHeadHash(선언 시점의 HEAD)는 감사/진단용 메타데이터로 함께 기록한다 — hook의 트리거
// 판정에는 쓰지 않는다(§ self-dev-completion-hook.ts 주석 — "선언 이후 새 commit이
// 있어야만 트리거"로 만들면, self-dev:begin을 commit 직후/push 직전에 실행하는 것도(권장
// 순서보다 한 박자 늦게 선언한 정상적인 경우) 매번 오탐으로 막히기 때문이다). "선언이
// 실제로 이 push/commit에 대응하는가"는 pushRequired 일치 여부로 걸러지고, 최종 완료
// 여부는 self-dev-complete.ts의 deterministic 재검증이 판정한다.

export const SELF_DEV_TASK_CONTEXT_DIR = ".autodev-self-dev";
export const SELF_DEV_TASK_CONTEXT_FILENAME = "current-task.local.json";

export function selfDevTaskContextPath(repoRoot: string): string {
  return join(repoRoot, SELF_DEV_TASK_CONTEXT_DIR, SELF_DEV_TASK_CONTEXT_FILENAME);
}

export interface SelfDevTaskContext {
  taskId: string;
  pushRequired: boolean;
  /** 선언 시점의 git HEAD commit hash — stale context 재사용 방지(위 주석 참고). */
  baseHeadHash: string;
  declaredAt: string;
}

export interface TaskContextError {
  error: string;
}

export function isTaskContextError(value: unknown): value is TaskContextError {
  return typeof value === "object" && value !== null && typeof (value as TaskContextError).error === "string";
}

/**
 * context 파일이 없으면 undefined를 반환한다("선언되지 않음" — 자동 트리거를 하지 않을
 * 정상적인 이유다). 파일은 있지만 JSON이 깨졌거나 필수 필드가 없거나 형식이 잘못되면
 * {error}를 반환한다 — 두 경우 모두 호출부(hook)는 트리거하지 않지만, 이유를 구체적으로
 * 구분해서 보고할 수 있다.
 */
export function readSelfDevTaskContext(repoRoot: string): SelfDevTaskContext | TaskContextError | undefined {
  const path = selfDevTaskContextPath(repoRoot);
  if (!existsSync(path)) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { error: `${path}가 유효한 JSON이 아닙니다.` };
  }
  if (typeof raw !== "object" || raw === null) {
    return { error: `${path}의 내용이 object가 아닙니다.` };
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.taskId !== "string" || !TASK_ID_PATTERN.test(r.taskId)) {
    return { error: `${path}의 taskId가 없거나 형식이 올바르지 않습니다.` };
  }
  if (typeof r.pushRequired !== "boolean") {
    return { error: `${path}의 pushRequired가 boolean이 아닙니다.` };
  }
  if (typeof r.baseHeadHash !== "string" || r.baseHeadHash.trim().length === 0) {
    return { error: `${path}의 baseHeadHash가 없습니다.` };
  }
  if (typeof r.declaredAt !== "string" || r.declaredAt.trim().length === 0) {
    return { error: `${path}의 declaredAt이 없습니다.` };
  }

  return { taskId: r.taskId, pushRequired: r.pushRequired, baseHeadHash: r.baseHeadHash, declaredAt: r.declaredAt };
}

/**
 * 현재 git HEAD를 baseHeadHash로 기록하며 context를 (덮어)쓴다. taskId 형식이 잘못됐거나
 * HEAD를 확인할 수 없으면(예: 아직 commit이 하나도 없는 저장소) {error}를 반환하고 아무
 * 파일도 쓰지 않는다.
 */
export function writeSelfDevTaskContext(
  repoRoot: string,
  input: { taskId: string; pushRequired: boolean }
): SelfDevTaskContext | TaskContextError {
  if (typeof input.taskId !== "string" || !TASK_ID_PATTERN.test(input.taskId)) {
    return { error: `taskId 형식이 올바르지 않습니다(영숫자로 시작, 영숫자/._- 만 허용, 1~64자): ${input.taskId}` };
  }
  const baseHeadHash = getCurrentHeadHash(repoRoot);
  if (!baseHeadHash) {
    return { error: "git HEAD commit hash를 확인할 수 없습니다(초기 commit이 없는 저장소일 수 있습니다)." };
  }

  const context: SelfDevTaskContext = {
    taskId: input.taskId,
    pushRequired: input.pushRequired === true,
    baseHeadHash,
    declaredAt: new Date().toISOString(),
  };
  const path = selfDevTaskContextPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(context, null, 2) + "\n", "utf-8");
  return context;
}

/**
 * 선언을 소비(삭제)한다 — self-dev-complete.ts가 TASK_COMPLETED를 실제로 기록(또는 이미
 * 기록돼 있음을 확인)한 뒤에만 호출한다. 완료 조건을 충족하지 못해 실패한 경우에는 호출하지
 * 않는다 — 그래야 Claude가 문제를 고친 뒤 같은 taskId로 다시 push했을 때 hook이 여전히
 * 자동으로 재시도한다.
 */
export function clearSelfDevTaskContext(repoRoot: string): void {
  const path = selfDevTaskContextPath(repoRoot);
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // 삭제 실패(권한 등)는 치명적이지 않다 — 다음 self-dev:begin 호출이 어차피 덮어쓴다.
  }
}
