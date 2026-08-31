import { existsSync } from "node:fs";
import type { TaskDefinition } from "./task-registry";
import { validateProjectExecutionPolicy } from "./project-policy";
import type { ProjectExecutionPolicy } from "./project-policy";
import { DEFAULT_REMOTE_NAME } from "./remote-git-safety";

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
  /**
   * Phase G Task G7.3 — GitHub Sync & Remote Repository Safety. 지정하면 runAutodevOnce()가
   * 이 project의 targetProjectRoot를 대상으로 run 시작 전 Remote Safety Gate(local HEAD ==
   * origin/<branch>인지 fetch로 재확인)와 checkpoint 직전 재확인(REMOTE_CHANGED_DURING_RUN)을
   * 수행한다. 지정하지 않으면(기본값, 기존 manifest는 전부 이 필드가 없다) 이 Gate는 완전히
   * 비활성화된다 — remote가 아예 없는 fixture/temp git repo를 쓰는 기존 테스트/manifest의
   * 동작을 100% 보존하기 위한 명시적 opt-in이다(project가 스스로 이 안전장치를 요청해야만
   * 켜진다 — 어떤 project도 "silent" 강제 대상이 아니다).
   */
  remoteGitSafety?: RemoteGitSafetyPolicy;
  /**
   * Minimal HUMAN_FINAL_REVIEW Runtime Checkpoint Gate(autodev.ts) — 지정하면(그리고
   * enabled===true) 이 project는 GPT Reviewer가 APPROVED한 뒤에도 checkpoint(git commit)
   * 전에 사람의 명시적 최종 승인(approveHumanFinalReview())을 기다린다. 지정하지 않으면
   * (기본값, 기존 manifest는 전부 이 필드가 없다) 이 Gate는 완전히 비활성화되고 AutoDev의
   * 기존 동작(Reviewer PASS → 즉시 checkpoint)을 그대로 유지한다 — remoteGitSafety와 동일한
   * 설계: 어떤 project도 이 Gate의 "silent" 강제 대상이 아니다(project가 스스로 opt-in해야만
   * 켜진다). AutoDev Core(autodev.ts) 자신은 이 필드를 어떤 프로젝트 이름으로도 분기하지
   * 않는다 — Project Adapter/Manifest가 명시적으로 주입하는 값만 본다.
   */
  humanFinalReviewPolicy?: HumanFinalReviewPolicy;
  /**
   * Multi-Project Approval Isolation(2026-09-01) — 이 manifest를 실제로 로드한 project
   * config(JSON) 파일의 절대경로. loadProjectAdapter()가 항상 채운다(project-adapter-loader.ts
   * — resolvedPath). installation-wide Telegram controller처럼 "지금 이 event/approval이
   * 어느 project에 속하는가"를 owner project의 manifest로 짐작하지 않고, 이 값(이미
   * loadProjectAdapter()가 신뢰하는 유일한 project 진입점)으로 그 project 자신의 manifest를
   * 다시 안전하게 로드하기 위한 용도다. 새 project registry를 만들지 않는다 — 이미 존재하는
   * loadProjectAdapter() 하나만 재사용한다. loadProjectAdapter()를 거치지 않고 manifest를
   * 직접 구성하는 테스트/fixture는 이 필드가 없을 수 있다(그 경우 cross-project 승인 처리는
   * fail-closed로 거부된다 — owner manifest로 대체하지 않는다).
   */
  adapterPath?: string;
}

export interface RemoteGitSafetyPolicy {
  /** 기본값 "origin". */
  remoteName?: string;
  /** 지정하면 이 branch가 아닐 때 즉시 UNEXPECTED_BRANCH로 BLOCK한다. */
  expectedBranch?: string;
}

export interface HumanFinalReviewPolicy {
  /** true일 때만 Minimal HUMAN_FINAL_REVIEW Runtime Checkpoint Gate가 활성화된다. false
   *  또는 이 policy 자체를 지정하지 않으면 기존 AutoDev 기본 동작(즉시 checkpoint)이다. */
  enabled: boolean;
}

/** manifest.remoteGitSafety가 명시적으로 주입됐을 때만 검증한다 — validateProjectManifest와
 *  동일하게 잘못된 필드는 즉시 throw하고, 절대 permissive한 기본값으로 대체하지 않는다. */
export function validateRemoteGitSafetyPolicy(policy: RemoteGitSafetyPolicy, projectLabel = "(project)"): void {
  if (!policy || typeof policy !== "object") {
    throw new Error(`Invalid RemoteGitSafetyPolicy(${projectLabel}): policy가 비어있거나 객체가 아닙니다.`);
  }
  if (policy.remoteName !== undefined && (typeof policy.remoteName !== "string" || policy.remoteName.trim().length === 0)) {
    throw new Error(`Invalid RemoteGitSafetyPolicy(${projectLabel}): remoteName이 비어있지 않은 문자열이어야 합니다.`);
  }
  if (policy.expectedBranch !== undefined && (typeof policy.expectedBranch !== "string" || policy.expectedBranch.trim().length === 0)) {
    throw new Error(`Invalid RemoteGitSafetyPolicy(${projectLabel}): expectedBranch가 비어있지 않은 문자열이어야 합니다.`);
  }
}

/** manifest.remoteGitSafety가 있으면 remoteName 기본값(DEFAULT_REMOTE_NAME)까지 채운
 *  완전한 형태로 정규화한다 — 호출부(autodev.ts)가 매번 "?? DEFAULT_REMOTE_NAME"을 반복하지
 *  않게 하는 단일 출처. */
export function resolveRemoteGitSafetyPolicy(policy: RemoteGitSafetyPolicy): Required<Pick<RemoteGitSafetyPolicy, "remoteName">> & RemoteGitSafetyPolicy {
  return { ...policy, remoteName: policy.remoteName ?? DEFAULT_REMOTE_NAME };
}

/** manifest.humanFinalReviewPolicy가 명시적으로 주입됐을 때만 검증한다 — 잘못된 필드는 즉시
 *  throw하고, 절대 permissive한 기본값으로 대체하지 않는다. */
export function validateHumanFinalReviewPolicy(policy: HumanFinalReviewPolicy, projectLabel = "(project)"): void {
  if (!policy || typeof policy !== "object") {
    throw new Error(`Invalid HumanFinalReviewPolicy(${projectLabel}): policy가 비어있거나 객체가 아닙니다.`);
  }
  if (typeof policy.enabled !== "boolean") {
    throw new Error(`Invalid HumanFinalReviewPolicy(${projectLabel}): enabled가 boolean이어야 합니다.`);
  }
}

/** manifest.humanFinalReviewPolicy?.enabled === true일 때만 Minimal HUMAN_FINAL_REVIEW
 *  Runtime Checkpoint Gate가 켜진다 — autodev.ts를 포함한 모든 호출부가 이 단일 함수로만
 *  판단한다(중복된 "?? false" 판정을 여기저기 반복하지 않는다). manifest.humanFinalReviewPolicy가
 *  없으면(기존 project 전부 해당) 항상 false — 기본값은 기존 AutoDev 동작(즉시 checkpoint)이다. */
export function isHumanFinalReviewEnabled(manifest: Pick<ProjectManifest, "humanFinalReviewPolicy">): boolean {
  return manifest.humanFinalReviewPolicy?.enabled === true;
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
  if (manifest.remoteGitSafety !== undefined) {
    validateRemoteGitSafetyPolicy(manifest.remoteGitSafety, manifest.projectId);
  }
  if (manifest.humanFinalReviewPolicy !== undefined) {
    validateHumanFinalReviewPolicy(manifest.humanFinalReviewPolicy, manifest.projectId);
  }
}
