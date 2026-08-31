import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { log, sanitizeForLog } from "./logger";
import { computeProblemFingerprint } from "./failure-stagnation";
import type { FailureCategory } from "./failure-stagnation";
import type { ClaudeResult } from "./types";
import { isProductionRuntime } from "./runtime-origin";

// AutoDev 지능형 오류 복구 하드닝 — Problem-Solving Knowledge Store.
//
// 목표: AutoDev가 과거에 해결한 오류를 다음 Task/다른 Task/다른 프로젝트에서도 재사용해,
// 같은 문제를 매번 Claude Developer/GPT Reviewer를 새로 불러 처음부터 다시 진단하지 않게
// 한다(§ 요구사항 2~11). 이 파일은 그 지식의 데이터 모델 + 저장 + 조회 + 재사용 조건
// 검증만 담당한다 — 언제 이 store를 조회/기록할지는 호출부(autodev.ts)가 결정한다(이
// 파일은 LLM을 전혀 호출하지 않는 순수 데이터 계층이다).
//
// 저장 위치 — usage-ledger.ts(RUNTIME_USAGE_LEDGER_DIR)와 동일한 관례를 그대로 따른다:
// AutoDev 자신의 runtime data로 AutoDev Core 저장소의 logs/ 아래(target project repo
// 안이 아님, 이미 .gitignore 대상)에 project별 파일로 분리해서 저장한다. "프로젝트 기억"은
// projectId별 파일(logs/problem-memory/<projectId>.json), "AutoDev 공통 기억"은 고정된
// 예약 파일명(logs/problem-memory/_common.json) 하나뿐이다 — 프로젝트 고유 데이터가 이
// 파일에 섞이지 않도록 기록 시점에 구조적으로 분리한다(§ 요구사항 7/15).
//
// "작업 내부 기억"(1단계)은 별도 저장소가 아니다 — 같은 project 파일 안에서 projectId+
// taskId+fingerprint로 필터링한 결과가 그 자체로 "이 Task 안에서 이미 시도한 것"이다(더
// 정확하고, 프로세스 재시작에도 안전하다).
//
// 비밀정보(§ 요구사항 2/15) — 자유 텍스트 필드(suspectedCause/confirmedRootCause/
// attemptedSolutions[].description)는 저장 전 항상 logger.ts의 sanitizeForLog()를 거친다
// (Secret Scanner Gate와 동일한 key 이름 기반 redaction). 공통 지식(COMMON tier)으로
// 승격될 때는 추가로 scrubPathLikeTokens()로 파일 경로처럼 보이는 조각을 제거한다 — 프로젝트
// 고유 디렉터리 구조가 AutoDev Core 공통 지식으로 새어나가지 않게 하기 위함이다(완벽한
// 익명화를 주장하지 않는다 — filesystem-trust-model.md와 동일한 정직한 한계 표기 원칙).

export type MemoryTier = "PROJECT" | "COMMON";

export interface AttemptedSolution {
  description: string;
  outcome: "SUCCESS" | "FAILURE";
  attemptedAt: string;
  /** 이 시도가 실제 checkpoint commit으로 이어졌다면 그 commit hash(사후에 채워짐). */
  gitRef?: string;
}

export interface ProblemMemoryEntry {
  id: string;
  /** COMMON tier 항목은 이 필드가 없다(§ 프로젝트 고유 정보 미포함). */
  projectId?: string;
  /** COMMON tier 항목은 이 필드가 없다. */
  taskId?: string;
  occurredAt: string;
  lastSeenAt: string;
  errorType: FailureCategory;
  failedCheck?: string;
  errorCode?: string;
  /** computeProblemFingerprint() 결과 — taskId/projectId를 포함하지 않는다. */
  fingerprint: string;
  /** COMMON tier 항목은 이 필드가 없다(프로젝트 파일 구조 비노출). */
  relatedFiles: string[];
  relatedFunctionOrLocation?: string;
  /** COMMON tier 항목은 이 필드가 없다. */
  recentChangedFiles: string[];
  suspectedCause?: string;
  confirmedRootCause?: string;
  attemptedSolutions: AttemptedSolution[];
  finalSuccessfulSolution?: string;
  /** finalSuccessfulSolution이 아직 실제 checkpoint로 확정되지 않은 후보 상태인지 여부.
   *  true인 동안은 재사용 대상에서 제외한다(§ 요구사항 5 — 검증되지 않은 해결책을 정답으로
   *  단정하지 않는다). */
  pendingConfirmation?: boolean;
  verificationTests: string[];
  finalVerificationResult?: "PASS" | "FAIL";
  resolvedAtCommit?: string;
  applicableConditions?: string;
  inapplicableConditions?: string;
  reuseSuccessCount: number;
  reuseFailureCount: number;
  /** AutoDev 최종 통합 하드닝(§15~21, Self-Reinforcing Knowledge Loop) — VERIFIED 승격
   *  조건(재현/root cause 증거 연결/최소 수정/targeted test PASS/fault simulation PASS/
   *  regression PASS) 중 이 store가 직접 관측할 수 없는 3개(targeted test/fault
   *  simulation/regression 각각의 실제 PASS 여부)를 호출부가 실제로 확인했을 때만
   *  명시적으로 채운다. 이 필드가 없으면(대부분의 기존 항목) classifyKnowledgeLifecycleState()
   *  는 VERIFIED로 승격하지 않는다 — 증거 없이 추측으로 최고 신뢰등급을 주지 않는다는
   *  원칙(§ 요구사항 17)을 지키기 위함이다. */
  verifiedEvidence?: {
    targetedTestPass: boolean;
    faultSimulationPass: boolean;
    regressionPass: boolean;
  };
}

// AutoDev 최종 통합 하드닝(§15~21) — Knowledge 신뢰등급. 새 저장소를 만들지 않는다 — 이미
// 있는 필드(finalSuccessfulSolution/pendingConfirmation/finalVerificationResult/
// verificationTests/reuseSuccessCount/reuseFailureCount/verifiedEvidence)를 그대로
// 읽어서 6개 상태(OBSERVED/HYPOTHESIS/REPRODUCED/VERIFIED/SUPERSEDED/INVALIDATED) 중
// 하나로 순수 분류만 한다(부수효과 없음, 저장 스키마 변경 없음). 이 분류는 lookupSolution()
// 등 기존 재사용/승격 로직의 동작을 바꾸지 않는다 — 순수 진단/보고용 오버레이다(§
// failure-taxonomy.ts와 동일한 설계 원칙: 이미 내려진 판단에 이름을 붙일 뿐, 새 판단을
// 이 함수가 대신 내리지 않는다).
export type KnowledgeLifecycleState = "OBSERVED" | "HYPOTHESIS" | "REPRODUCED" | "VERIFIED" | "SUPERSEDED" | "INVALIDATED";

export interface KnowledgeLifecycleClassification {
  state: KnowledgeLifecycleState;
  reason: string;
}

/**
 * SUPERSEDED는 이 함수가 자동으로 판정하지 않는다 — "더 나은 해결책으로 대체됨"은 같은
 * fingerprint를 가리키는 다른 entry와의 관계를 추적해야 하는데, 이 store는 현재 entry
 * 간 supersession 관계를 저장하지 않는다(§ 알려진 한계, 추측으로 판정하지 않음 원칙).
 * 필요해지면 별도 필드/Task에서 다뤄야 한다.
 */
export function classifyKnowledgeLifecycleState(entry: ProblemMemoryEntry): KnowledgeLifecycleClassification {
  if (!entry.finalSuccessfulSolution) {
    return { state: "OBSERVED", reason: "실패는 기록됐지만 아직 성공한 해결책이 기록되지 않음." };
  }
  if (entry.finalVerificationResult === "FAIL") {
    return { state: "INVALIDATED", reason: "검증 시도에서 최종적으로 FAIL로 확인됨 — 더 이상 신뢰할 수 없음." };
  }
  if (entry.pendingConfirmation) {
    return { state: "HYPOTHESIS", reason: "해결책 후보는 있으나 아직 실제 checkpoint로 확정되지 않음(§ pendingConfirmation=true)." };
  }
  // 이 시점: finalSuccessfulSolution 있음 + pendingConfirmation=false(confirmResolution을
  // 이미 거쳐 실제 checkpoint commit으로 확정됨).
  if (entry.reuseFailureCount > 0 && entry.reuseSuccessCount === 0) {
    return {
      state: "INVALIDATED",
      reason: `이후 재사용 시도가 전부 실패함(reuseFailureCount=${entry.reuseFailureCount}, reuseSuccessCount=0) — 더 이상 자동 재사용 대상으로 신뢰하지 않아야 함.`,
    };
  }
  const evidence = entry.verifiedEvidence;
  if (evidence && evidence.targetedTestPass && evidence.faultSimulationPass && evidence.regressionPass) {
    return {
      state: "VERIFIED",
      reason: "checkpoint로 확정됐고 targeted test/fault simulation/regression 3개 증거가 모두 PASS로 기록됨(§ 요구사항 17 승격 조건 충족).",
    };
  }
  return {
    state: "REPRODUCED",
    reason: evidence
      ? "checkpoint로 확정됐지만 targeted test/fault simulation/regression 중 일부가 아직 PASS로 확인되지 않음 — VERIFIED로 승격하지 않음."
      : "checkpoint로 확정됐지만 targeted test/fault simulation/regression 각각의 개별 PASS 증거가 기록되지 않음 — VERIFIED로 자동 승격하지 않음(증거 없는 낙관적 승격 금지).",
  };
}

export interface ProblemMemoryStore {
  load(): ProblemMemoryEntry[];
  save(entries: ProblemMemoryEntry[]): void;
}

// AutoDev 자신의 runtime data다(usage-ledger.ts RUNTIME_USAGE_LEDGER_DIR과 동일한 위치 계산
// 방식/근거) — target project repository 안이 아니다. logs/는 이미 .gitignore에 포함돼 있다.
export const RUNTIME_PROBLEM_MEMORY_DIR = join(__dirname, "..", "logs", "problem-memory");
export const COMMON_MEMORY_FILE_BASENAME = "_common";

function sanitizeProjectIdForFilename(projectId: string): string {
  // 파일 경로 escape 방지 — 영숫자/-/_/. 외 문자는 전부 _로 치환한다(§ usage-ledger.ts
  // resolveUsageLedgerFilePath와 동일한 방어적 원칙).
  return projectId.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function memoryFilePath(baseDir: string, tier: MemoryTier, projectId: string | undefined): string {
  const fileBaseName = tier === "COMMON" ? COMMON_MEMORY_FILE_BASENAME : sanitizeProjectIdForFilename(projectId ?? "unknown-project");
  return join(resolve(baseDir), `${fileBaseName}.json`);
}

function createInMemoryStore(): ProblemMemoryStore {
  let entries: ProblemMemoryEntry[] = [];
  return {
    load: () => entries,
    save: (next) => {
      entries = next;
    },
  };
}

/**
 * 대시보드 후속 작업 — 항상 실제 파일을 읽는(§ isProductionRuntime() 게이트를 거치지 않는)
 * 직접 생성자. event-store.ts의 createFileEventStore()/usage-ledger.ts의
 * createFileUsageLedger()와 동일한 기존 관례를 그대로 따른다 — 대시보드는 AutoDev
 * 개발 실행 자체가 아니라 "이미 디스크에 있는 기록을 읽기만 하는 별도 프로세스"이므로,
 * 그 실행의 production 여부와 무관하게 항상 실제 파일을 봐야 한다. 판정/기록 로직은 전혀
 * 바뀌지 않는다(순수 가시성 확장).
 */
export function createFileProblemMemoryStore(tier: MemoryTier, projectId: string | undefined, baseDir: string = RUNTIME_PROBLEM_MEMORY_DIR): ProblemMemoryStore {
  return createFileStore(memoryFilePath(baseDir, tier, projectId));
}

function createFileStore(filePath: string): ProblemMemoryStore {
  return {
    load(): ProblemMemoryEntry[] {
      if (!existsSync(filePath)) return [];
      try {
        const raw = readFileSync(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed as ProblemMemoryEntry[];
      } catch (e) {
        log("problem-memory 파일 읽기 실패 — 빈 목록으로 처리합니다(손상된 파일은 덮어쓰지 않고 다음 save가 복구)", {
          filePath,
          error: e instanceof Error ? e.message : undefined,
        });
        return [];
      }
    },
    save(entries: ProblemMemoryEntry[]): void {
      const dir = dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      // same-directory temp + atomic rename(§ state.ts saveState와 동일한 패턴).
      const tmpPath = `${filePath}.${randomUUID()}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(entries, null, 2) + "\n", "utf-8");
      renameSync(tmpPath, filePath);
    },
  };
}

/**
 * production 여부에 따라 file/in-memory를 선택한다(event-store.ts/usage-ledger.ts와 동일한
 * fail-closed 원칙 — 두 신호 중 하나라도 없으면 항상 in-memory, 테스트가 실제 운영
 * problem-memory 파일을 건드리지 않는다). 테스트는 반드시 baseDir을 임시 경로로 override한다.
 */
export function selectDefaultProblemMemoryStore(
  tier: MemoryTier,
  projectId: string | undefined,
  baseDir: string = RUNTIME_PROBLEM_MEMORY_DIR
): ProblemMemoryStore {
  if (!isProductionRuntime()) return createInMemoryStore();
  return createFileStore(memoryFilePath(baseDir, tier, projectId));
}

const MAX_FREE_TEXT_CHARS = 2_000;

function sanitizeFreeText(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const sanitized = sanitizeForLog(text).trim();
  if (sanitized.length === 0) return undefined;
  return sanitized.length > MAX_FREE_TEXT_CHARS ? `${sanitized.slice(0, MAX_FREE_TEXT_CHARS)}…` : sanitized;
}

// COMMON tier로 승격할 때만 적용한다 — 절대경로/상대경로처럼 보이는 조각을 <path>로
// 치환해 프로젝트 고유 디렉터리 구조가 공통 지식으로 새어나가는 것을 줄인다. 완전한
// 보장은 아니다(자유 텍스트의 완벽한 비식별화는 일반적으로 불가능하다) — 결정론적이고
// 테스트 가능한 최선의 방어선이다.
const PATH_LIKE_PATTERN = /(?:[A-Za-z]:[\\/])?(?:[\w.-]+[\\/])+[\w.-]+/g;
export function scrubPathLikeTokens(text: string): string {
  return text.replace(PATH_LIKE_PATTERN, "<path>");
}

export interface RecordAttemptInput {
  projectId: string;
  taskId: string;
  tests: ClaudeResult["tests"];
  errorType: FailureCategory;
  claudeErrorCode?: string;
  changedFiles: string[];
  /** Claude Developer 자신의 요약(TASK_COMPLETE summary) — "시도한 해결 방법"의 실제 근거로
   *  쓴다(추측으로 만들어내지 않는다, § 요구사항). */
  attemptDescription: string;
  outcome: "SUCCESS" | "FAILURE";
  now?: () => Date;
}

function findFailedTest(tests: ClaudeResult["tests"]): ClaudeResult["tests"][number] | undefined {
  return tests.find((t) => !t.pass);
}

/** 새 시도를 project tier store에 기록한다 — 같은 (projectId, taskId, fingerprint) 항목이
 *  이미 있으면 attemptedSolutions에 추가만 하고, 없으면 새 항목을 만든다. 항목을 반환한다
 *  (호출부가 checkpoint 성공 후 resolvedAtCommit을 확정하는 데 쓴다). */
export function recordAttempt(store: ProblemMemoryStore, input: RecordAttemptInput): ProblemMemoryEntry {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const fingerprint = computeProblemFingerprint(input.tests);
  const failedTest = findFailedTest(input.tests);
  const entries = store.load();

  let entry = entries.find((e) => e.projectId === input.projectId && e.taskId === input.taskId && e.fingerprint === fingerprint);
  if (!entry) {
    entry = {
      id: randomUUID(),
      projectId: input.projectId,
      taskId: input.taskId,
      occurredAt: now,
      lastSeenAt: now,
      errorType: input.errorType,
      failedCheck: failedTest?.name,
      errorCode: input.claudeErrorCode ?? String(failedTest?.failureEvidence?.exitCode ?? ""),
      fingerprint,
      relatedFiles: failedTest?.failureEvidence?.command ? [failedTest.failureEvidence.command] : [],
      recentChangedFiles: input.changedFiles.slice(0, 50),
      attemptedSolutions: [],
      verificationTests: input.tests.map((t) => t.name),
      reuseSuccessCount: 0,
      reuseFailureCount: 0,
    };
    entries.push(entry);
  }
  entry.lastSeenAt = now;
  entry.recentChangedFiles = input.changedFiles.slice(0, 50);
  const description = sanitizeFreeText(input.attemptDescription) ?? "(요약 없음)";
  entry.attemptedSolutions.push({ description, outcome: input.outcome, attemptedAt: now });
  if (input.outcome === "SUCCESS") {
    entry.finalSuccessfulSolution = description;
    entry.pendingConfirmation = true;
    entry.finalVerificationResult = "PASS";
  }
  store.save(entries);
  return entry;
}

/** checkpoint가 실제로 성공한 뒤에만 호출한다 — pendingConfirmation을 내리고 실제 commit
 *  hash를 기록해야 비로소 이 해결책이 "확정된 성공 사례"로 재사용 대상이 된다(§ 요구사항 5
 *  — 검증 전 해결책을 정답으로 단정하지 않는다). */
export function confirmResolution(store: ProblemMemoryStore, entryId: string, commitHash: string): void {
  const entries = store.load();
  const entry = entries.find((e) => e.id === entryId);
  if (!entry) return;
  entry.pendingConfirmation = false;
  entry.resolvedAtCommit = commitHash;
  const last = entry.attemptedSolutions[entry.attemptedSolutions.length - 1];
  if (last) last.gitRef = commitHash;
  store.save(entries);
}

/** 호출부가 targeted test/fault simulation/regression 각각을 실제로 확인했을 때만
 *  호출한다(§ classifyKnowledgeLifecycleState VERIFIED 조건) — 추측으로 채우지 않는다.
 *  entryId가 이미 confirmResolution()을 거치지 않았어도(pendingConfirmation=true) 값 자체는
 *  기록한다 — VERIFIED 판정은 classifyKnowledgeLifecycleState()가 pendingConfirmation을
 *  먼저 확인하므로 순서가 뒤바뀌어도 안전하다. */
export function recordVerifiedEvidence(
  store: ProblemMemoryStore,
  entryId: string,
  evidence: { targetedTestPass: boolean; faultSimulationPass: boolean; regressionPass: boolean }
): void {
  const entries = store.load();
  const entry = entries.find((e) => e.id === entryId);
  if (!entry) return;
  entry.verifiedEvidence = evidence;
  store.save(entries);
}

export interface LookupContext {
  projectId: string;
  taskId: string;
  tests: ClaudeResult["tests"];
  /** project tier store — 이미 선택된 store를 그대로 넘긴다(호출부가 selectDefaultProblemMemoryStore로 구성). */
  projectStore: ProblemMemoryStore;
  commonStore: ProblemMemoryStore;
  /** 해결책의 resolvedAtCommit이 현재 HEAD의 ancestor인지 확인할 project repo 경로. 지정하지
   *  않으면 이 검증을 건너뛴다(§ 적용조건 검증 — 코드가 이후 변경되지 않았는지). */
  projectRootForAncestryCheck?: string;
}

export interface MemoryLookupResult {
  tier: MemoryTier;
  entry: ProblemMemoryEntry;
  /** 이 task 안에서 이미 실패한 것으로 기록된 설명 목록(§ 요구사항 6 — 같은 해결 전략
   *  반복 금지에 그대로 활용). */
  alreadyFailedDescriptionsInThisTask: string[];
}

function isCommitAncestorOfHead(projectRoot: string, commitHash: string): boolean {
  const res = spawnSync("git", ["merge-base", "--is-ancestor", commitHash, "HEAD"], { cwd: projectRoot, shell: false });
  return res.status === 0;
}

/**
 * Section 4/5 — 과거 해결 사례 검색. PROJECT tier(같은 project, 어떤 task든)를 먼저 보고,
 * 없으면 COMMON tier(project 무관)를 본다. "같은 문제"의 판정은 fingerprint 완전 일치만
 * 신뢰한다(느슨한 유사도 매칭은 하지 않는다 — 오탐 방지, § 요구사항 5). pendingConfirmation
 * 항목/이미 이 task에서 실패로 기록된 해결책은 추천하지 않는다(§ 요구사항 6).
 */
export function lookupSolution(ctx: LookupContext): MemoryLookupResult | undefined {
  const fingerprint = computeProblemFingerprint(ctx.tests);

  const projectEntries = ctx.projectStore.load().filter((e) => e.projectId === ctx.projectId && e.fingerprint === fingerprint);
  const alreadyFailedDescriptionsInThisTask = projectEntries
    .filter((e) => e.taskId === ctx.taskId)
    .flatMap((e) => e.attemptedSolutions.filter((s) => s.outcome === "FAILURE").map((s) => s.description));

  const candidateFrom = (entries: ProblemMemoryEntry[], tier: MemoryTier): MemoryLookupResult | undefined => {
    const confirmed = entries.filter((e) => e.finalSuccessfulSolution && !e.pendingConfirmation);
    for (const entry of confirmed) {
      // § 요구사항 5 — 해당 코드가 이후 변경되지 않았는지: resolvedAtCommit이 있고 검증
      // 대상 repo가 주어졌으면, 그 commit이 여전히 현재 HEAD의 조상인지 확인한다. 확인할
      // 수 없으면(정보 부족) 보수적으로 계속 진행한다 — 없는 근거로 거부하지 않는다.
      if (entry.resolvedAtCommit && ctx.projectRootForAncestryCheck) {
        if (!isCommitAncestorOfHead(ctx.projectRootForAncestryCheck, entry.resolvedAtCommit)) continue;
      }
      // 이 task 안에서 이미 이 정확한 해결책을 시도해 실패했다면 다시 추천하지 않는다.
      if (alreadyFailedDescriptionsInThisTask.includes(entry.finalSuccessfulSolution!)) continue;
      return { tier, entry, alreadyFailedDescriptionsInThisTask };
    }
    return undefined;
  };

  const projectHit = candidateFrom(projectEntries, "PROJECT");
  if (projectHit) return projectHit;

  const commonEntries = ctx.commonStore.load().filter((e) => e.fingerprint === fingerprint);
  return candidateFrom(commonEntries, "COMMON");
}

export interface RootCauseClassLookupContext {
  errorType: FailureCategory;
  projectStore: ProblemMemoryStore;
  commonStore: ProblemMemoryStore;
  /** 이 project 안에서, 이미 이 정확한 해결책을 시도해 실패로 기록한 것은 제외한다(§
   *  lookupSolution의 alreadyFailedDescriptionsInThisTask와 동일한 원칙 — projectId 전체
   *  기준, taskId 무관: 다른 task에서 이미 실패로 확인된 해결책을 그대로 다시 추천하지
   *  않는다). */
  projectId: string;
  /** 결과 개수 상한(advisory 힌트 크기를 bounded로 유지) — 기본 3건. */
  limit?: number;
}

/**
 * AutoDev Core Maintenance(2026-08-30) — LOCAL_ROOT_CAUSE_MODE 전용 advisory lookup.
 * lookupSolution()의 정확한 fingerprint 일치 원칙(§ 위 "느슨한 유사도 매칭은 하지 않는다")은
 * 절대 바꾸지 않는다 — 이 함수는 그 원칙과 별개로, "정확히 같은 문제"가 아니라 "같은
 * 종류(errorType)의 문제"였던 과거 확정 해결 사례를 여러 건 advisory로 반환한다. 정확도가
 * 낮으므로(같은 종류일 뿐 같은 근본원인이라는 보장이 없다) 호출부는 반드시 "검증된 정답이
 * 아니라 우선 검토할 후보"로만 제시해야 한다(§ lookupSolution의 기존 힌트 문구 관례를
 * 그대로 따른다). PROJECT tier를 COMMON tier보다 우선한다(같은 프로젝트 사례가 더
 * 관련성이 높다) — 두 tier를 섞어 정렬하지 않는다.
 */
export function lookupSolutionsByRootCauseClass(ctx: RootCauseClassLookupContext): MemoryLookupResult[] {
  const limit = ctx.limit ?? 3;
  if (limit <= 0) return [];

  const alreadyFailedDescriptionsByFingerprint = new Map<string, string[]>();
  const collectAlreadyFailed = (entries: ProblemMemoryEntry[]): string[] => {
    const key = entries.map((e) => e.fingerprint).sort().join("|");
    const cached = alreadyFailedDescriptionsByFingerprint.get(key);
    if (cached) return cached;
    const descriptions = entries.flatMap((e) => e.attemptedSolutions.filter((s) => s.outcome === "FAILURE").map((s) => s.description));
    alreadyFailedDescriptionsByFingerprint.set(key, descriptions);
    return descriptions;
  };

  const collect = (entries: ProblemMemoryEntry[], tier: MemoryTier, alreadyFailedDescriptionsInThisTask: string[]): MemoryLookupResult[] => {
    const results: MemoryLookupResult[] = [];
    // 가장 최근에 관측된 해결책을 우선한다(오래된 해결책보다 최신 코드베이스와 맞을
    // 가능성이 더 높다) — lastSeenAt 내림차순.
    const sorted = [...entries]
      .filter((e) => e.errorType === ctx.errorType && e.finalSuccessfulSolution && !e.pendingConfirmation)
      .sort((a, b) => (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? ""));
    for (const entry of sorted) {
      if (results.length >= limit) break;
      if (alreadyFailedDescriptionsInThisTask.includes(entry.finalSuccessfulSolution!)) continue;
      results.push({ tier, entry, alreadyFailedDescriptionsInThisTask });
    }
    return results;
  };

  const projectEntries = ctx.projectStore.load().filter((e) => e.projectId === ctx.projectId);
  const projectAlreadyFailed = collectAlreadyFailed(projectEntries);
  const projectHits = collect(projectEntries, "PROJECT", projectAlreadyFailed);
  if (projectHits.length >= limit) return projectHits.slice(0, limit);

  const commonEntries = ctx.commonStore.load();
  const commonHits = collect(commonEntries, "COMMON", []);
  return [...projectHits, ...commonHits].slice(0, limit);
}

// AutoDev 공통 기억으로 승격할 수 있는 "프로젝트와 무관한 일반 문제" 패턴(§ 요구사항 7 예시:
// TypeScript 빌드 오류/Windows 경로 처리/Git 잠금 문제/npm 의존성 문제/Claude 응답 형식
// 문제/외부 제공자 사용량 제한/일시적 네트워크 오류/상태 파일-Git 불일치/필수 테스트 명령
// 누락). errorCode/failedCheck/fingerprint 문자열에 대해서만 판정한다 — 프로젝트 고유
// 비즈니스 로직 키워드는 이 목록에 절대 넣지 않는다(AutoDev Core는 특정 프로젝트를 모른다).
const COMMON_PROBLEM_PATTERNS: RegExp[] = [
  // TypeScript 컴파일러 진단 코드 — fingerprint는 normalizeErrorSignature()가 이미 연속된
  // 숫자를 '#' 하나로 접어 정규화한 뒤의 문자열이므로("TS2345" -> "TS#"), 그 정규화된 형태로
  // 매칭한다(errorCode/failedCheck처럼 정규화되지 않은 원본 필드에도 우연히 매칭될 수 있게
  // 원본 형태도 함께 허용한다).
  /\bTS#|\bTS\d{4}\b/,
  /\bENOENT\b|\bEPERM\b|\bEACCES\b|\bEBUSY\b/, // Node/OS 파일시스템 오류(Windows 경로 문제 포함)
  /index\.lock|unable to create .*\.lock/i, // git 잠금 파일 문제
  /ERESOLVE|peer dep|npm ERR!/i, // npm 의존성 문제
  /INVALID_OUTPUT|PROTOCOL_ERROR/i, // Claude CLI 응답 형식 문제
  /USAGE_LIMIT|RATE_LIMIT|TIMEOUT|QUOTA_EXCEEDED/i, // 제공자 사용량 제한/일시적 장애
  /ECONNRESET|ETIMEDOUT|ENOTFOUND|network/i, // 일시적 네트워크 오류
  /REQUIRED_TEST_CONFIGURATION_ERROR/i, // 필수 테스트 명령 누락
];

export function isGenericCommonProblem(entry: Pick<ProblemMemoryEntry, "errorCode" | "failedCheck" | "fingerprint" | "errorType">): boolean {
  if (entry.errorType === "PROVIDER" || entry.errorType === "INFRASTRUCTURE_CONFIGURATION") return true;
  const haystack = `${entry.errorCode ?? ""} ${entry.failedCheck ?? ""} ${entry.fingerprint}`;
  return COMMON_PROBLEM_PATTERNS.some((p) => p.test(haystack));
}

/** 확정된(pendingConfirmation=false) PROJECT tier 항목 중 일반화 가능한 것만 COMMON tier에
 *  merge한다 — 프로젝트 고유 필드(projectId/taskId/relatedFiles/recentChangedFiles)는
 *  구조적으로 제외하고, 자유 텍스트는 scrubPathLikeTokens()로 한 번 더 다듬는다. 이미 같은
 *  fingerprint의 COMMON 항목이 있으면 새 항목을 또 만들지 않고 그 항목의 재사용 카운트만
 *  공유한다(중복 축적 방지). */
export function promoteToCommonIfGeneric(commonStore: ProblemMemoryStore, projectEntry: ProblemMemoryEntry): void {
  if (projectEntry.pendingConfirmation || !projectEntry.finalSuccessfulSolution) return;
  if (!isGenericCommonProblem(projectEntry)) return;

  const commonEntries = commonStore.load();
  const existing = commonEntries.find((e) => e.fingerprint === projectEntry.fingerprint);
  if (existing) return; // 이미 공통 지식으로 등록됨 — 중복 생성하지 않는다.

  const scrub = (s: string | undefined) => (s ? scrubPathLikeTokens(s) : s);
  const commonEntry: ProblemMemoryEntry = {
    id: randomUUID(),
    occurredAt: projectEntry.occurredAt,
    lastSeenAt: projectEntry.lastSeenAt,
    errorType: projectEntry.errorType,
    failedCheck: projectEntry.failedCheck,
    errorCode: projectEntry.errorCode,
    fingerprint: projectEntry.fingerprint,
    relatedFiles: [],
    recentChangedFiles: [],
    suspectedCause: scrub(projectEntry.suspectedCause),
    confirmedRootCause: scrub(projectEntry.confirmedRootCause),
    attemptedSolutions: projectEntry.attemptedSolutions
      .filter((s) => s.outcome === "SUCCESS")
      .map((s) => ({ description: scrubPathLikeTokens(s.description), outcome: s.outcome, attemptedAt: s.attemptedAt })),
    finalSuccessfulSolution: scrub(projectEntry.finalSuccessfulSolution),
    verificationTests: projectEntry.verificationTests,
    finalVerificationResult: projectEntry.finalVerificationResult,
    applicableConditions: scrub(projectEntry.applicableConditions),
    inapplicableConditions: scrub(projectEntry.inapplicableConditions),
    reuseSuccessCount: 0,
    reuseFailureCount: 0,
  };
  commonEntries.push(commonEntry);
  commonStore.save(commonEntries);
}

/** 재사용이 실제로 적용된 뒤(§ orchestrator 결과) 성공/실패를 이 항목의 카운터에 반영한다
 *  — reuseSuccessCount/reuseFailureCount(§ 요구사항 2). */
export function recordReuseOutcome(store: ProblemMemoryStore, entryId: string, outcome: "SUCCESS" | "FAILURE"): void {
  const entries = store.load();
  const entry = entries.find((e) => e.id === entryId);
  if (!entry) return;
  if (outcome === "SUCCESS") entry.reuseSuccessCount += 1;
  else entry.reuseFailureCount += 1;
  store.save(entries);
}
