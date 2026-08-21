import { existsSync } from "node:fs";
import type { TaskDefinition } from "./task-registry";
import { validateProjectExecutionPolicy } from "./project-policy";
import type { ProjectExecutionPolicy } from "./project-policy";

// AutoDev 범용화 Phase A Task A4 — Project Manifest 최소 골격.
//
// AutoDev Core(autodev.ts)가 "어느 프로젝트를 개발하고 있는가"를 하나의 값으로 알 수 있게
// 하는 자리다. 지금까지(A1~A3) TARGET_PROJECT_ROOT/DEFAULT_STATE_PATH/MOVAN_TASK_REGISTRY가
// 각각 project-context.ts/project-registries/movan.ts로 흩어져 있었는데, 이 파일은 그
// 세 가지(+ 프로젝트 식별자)를 하나의 타입으로 묶는 역할만 한다 — 실제 계산 로직은 옮기지
// 않는다(project-manifests/movan.ts가 기존 값들을 그대로 참조해 조립한다).
//
// allowedCommands/commitMessageTemplate 등 Safe Executor 정책 전체를 여기로 옮기는 것은
// 이번 Task 범위가 아니다 — 아직 쓰지 않는 필드를 미리 만들어두지 않는다(실제로 필요해지는
// Task에서 추가한다).
//
// AutoDev 범용화 Phase A Task A6 — developerInstructions/reviewInstructions/reviewScopeDirs/
// rulesPath 추가.
//
// Claude Developer(claude-developer.ts)와 GPT Reviewer(gpt-reviewer.ts)의 system prompt/
// review instruction Core 템플릿은 이제 어떤 프로젝트인지 전혀 모른다 — "이 프로젝트에서는
// 무엇이 허용/금지되는가"라는 실제 내용은 여기 이 필드들을 통해 프로젝트별로 주입된다.
// Safe Executor 자체의 read/write allow-list·명령 allow-list(safe-executor.ts)는 여전히
// 코드 레벨 하드 경계로 남아 바뀌지 않는다 — 이 필드들은 그 경계를 설명하는 "안내문"만
// 프로젝트별로 바꿀 뿐, 실제 강제(enforcement)는 이번 Task에서 손대지 않는다(§ claude-developer.ts
// 상단 주석: 시스템 프롬프트 지시는 신뢰 경계가 아니다).

export interface ProjectManifest {
  /** 프로젝트를 구분하는 고유 식별자(예: "movan"). completedTasks의 id 공간과는 별개다. */
  projectId: string;
  /** 사람이 읽는 프로젝트 이름(로그/보고에 사용, developer/reviewer system prompt에도 삽입됨). */
  projectName: string;
  /** AutoDev가 실제로 읽고/쓰고/커밋할 대상 프로젝트의 root. */
  targetProjectRoot: string;
  /** 이 프로젝트의 project-state.json 위치. */
  statePath: string;
  /** 이 프로젝트의 Task Registry(task-registry.ts 엔진에 주입되는 데이터). */
  taskRegistry: readonly TaskDefinition[];
  /** Claude Developer system prompt에 그대로 삽입되는 프로젝트별 지시문(허용 read/write
   *  범위 설명, 금지 사항, 프로젝트 맥락 등) — claude-developer.ts Core는 이 내용을 모른다. */
  developerInstructions: string;
  /** GPT Reviewer system instructions에 그대로 삽입되는 프로젝트별 검토 규칙 — gpt-reviewer.ts
   *  Core는 이 내용을 모른다. */
  reviewInstructions: string;
  /** GPT Reviewer가 실제 git 변경을 스캔하는 프로젝트 전체 소스 범위(POSIX 상대경로,
   *  trailing "/"). 개별 task의 allowedPathPrefixes보다 넓어야 scope-violation(허용 경로
   *  밖 변경)을 실제로 탐지할 수 있다. */
  reviewScopeDirs: string[];
  /** GPT Reviewer의 "프로젝트 규칙 요약" 섹션에 쓸 문서 경로(targetProjectRoot 기준 상대
   *  경로). 지정하지 않으면 규칙 요약 섹션을 생략한다. */
  rulesPath?: string;
  /** Safe Executor 실제 enforcement(read/write 허용 경로, 명령 allow-list)를 결정하는
   *  Project Execution Policy(Phase B Task B1). Safe Executor 자체(root 탈출/symlink 방어,
   *  secret 패턴 등 Core hard rule)는 이 값과 무관하게 항상 적용된다 — 이 필드는 그 위에서
   *  프로젝트별로 "무엇을 추가로 허용/차단할지"만 정한다. */
  executionPolicy: ProjectExecutionPolicy;
}

/**
 * manifest가 명시적으로 주입됐을 때 즉시 검증한다 — 잘못된 필드가 있으면 여기서 바로
 * throw하고, 절대 기본(MOVAN) manifest로 조용히 fallback하지 않는다(호출부가 이 함수의
 * 결과를 무시하고 계속 진행하지 않는 한).
 */
export function validateProjectManifest(manifest: ProjectManifest): void {
  if (!manifest || typeof manifest !== "object") {
    throw new Error("Invalid ProjectManifest: manifest가 비어있거나 객체가 아닙니다.");
  }
  if (typeof manifest.projectId !== "string" || manifest.projectId.trim().length === 0) {
    throw new Error("Invalid ProjectManifest: projectId가 비어있습니다.");
  }
  if (typeof manifest.projectName !== "string" || manifest.projectName.trim().length === 0) {
    throw new Error(`Invalid ProjectManifest(${manifest.projectId}): projectName이 비어있습니다.`);
  }
  if (!Array.isArray(manifest.taskRegistry)) {
    throw new Error(`Invalid ProjectManifest(${manifest.projectId}): taskRegistry가 배열이 아닙니다.`);
  }
  if (typeof manifest.targetProjectRoot !== "string" || manifest.targetProjectRoot.trim().length === 0 || !existsSync(manifest.targetProjectRoot)) {
    throw new Error(`Invalid ProjectManifest(${manifest.projectId}): targetProjectRoot가 존재하지 않는 경로입니다: ${manifest.targetProjectRoot}`);
  }
  if (typeof manifest.statePath !== "string" || manifest.statePath.trim().length === 0) {
    throw new Error(`Invalid ProjectManifest(${manifest.projectId}): statePath가 비어있습니다.`);
  }
  if (typeof manifest.developerInstructions !== "string" || manifest.developerInstructions.trim().length === 0) {
    throw new Error(`Invalid ProjectManifest(${manifest.projectId}): developerInstructions가 비어있습니다.`);
  }
  if (typeof manifest.reviewInstructions !== "string" || manifest.reviewInstructions.trim().length === 0) {
    throw new Error(`Invalid ProjectManifest(${manifest.projectId}): reviewInstructions가 비어있습니다.`);
  }
  if (!Array.isArray(manifest.reviewScopeDirs) || manifest.reviewScopeDirs.length === 0) {
    throw new Error(`Invalid ProjectManifest(${manifest.projectId}): reviewScopeDirs가 비어있습니다.`);
  }
  // executionPolicy는 자체 검증 함수(project-policy.ts)에 위임한다 — 여기서 permissive한
  // 기본값으로 대체하지 않는다(정책 누락/잘못된 정책은 여기서 바로 throw).
  validateProjectExecutionPolicy(manifest.executionPolicy, manifest.projectId);
}
