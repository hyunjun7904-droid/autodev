import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { log } from "./logger";
import { isProductionRuntime } from "./runtime-origin";

// API Usage & Cost Ledger — Phase SI-3.8B.
//
// event-store.ts(Phase G1/G2)가 "무슨 일이 일어났는가"(audit/observability event)를
// append-only로 기록하는 것과 별개로, 이 파일은 "API 호출이 실제로 얼마나 썼는가"(요청 수/
// token/추정 비용)를 Project/Task/Provider/Model/Operation 단위로 deterministic하게
// 축적하는 것만 전담한다 — 이름/목적을 특정 provider(OpenAI 등)에 묶지 않는다(§ 요구사항
// 4 범용 데이터 모델).
//
// event-store.ts의 append-only JSONL file store(createFileEventStore)와 정확히 동일한
// 안전 패턴을 그대로 따른다: 한 줄에 entry 하나(JSON.stringify)씩 appendFileSync로 추가하고
// (기존 기록을 절대 다시쓰지 않는다), 손상된 줄은 조용히 무시하지 않고 integrityIssues로
// 표면화하며(fail-open 금지), sequence는 파일에 남아있는 파싱 가능한 마지막 값부터 이어간다.
// 이 파일은 그 구현을 import해서 재사용하지 않고 자체 구현을 둔다 — Ledger entry 스키마가
// AutoDevEvent와 근본적으로 다르고(§ 아래 UsageLedgerEntry), event-store.ts의 append()가
// 이미 policy 인자를 받지 않는 Core hard rule 함수라 그 파일을 이 모듈 전용으로 변형할
// 여지가 없기 때문이다. "중복 Ledger 구현 금지"(§ 요구사항 9)는 이 파일 자체를 여러 벌 만들지
// 않는다는 뜻이다 — gpt-reviewer 호출부(orchestrator.ts)와 agent-orchestrator.ts는 모두
// 아래 UsageLedger 인터페이스 하나만 소비한다.
//
// Secret 미저장(§ 요구사항 3/9) — 이 파일의 스키마에는 자유 텍스트 필드(prompt/diff/에러
// 메시지 원문 등)가 구조적으로 존재하지 않는다. service/provider/model/operation/status는
// 전부 호출부가 이미 알고 있는 짧은 식별자 문자열(예: "gpt-reviewer", "openai", "gpt-5.6",
// "gpt_review", "BUDGET_BLOCKED")만 채우도록 설계했다 — observability-event.ts처럼 별도
// redaction 단계를 두는 대신,애초에 secret이 담길 수 있는 필드 자체를 두지 않는 것으로
// 이 요구사항을 구조적으로 만족한다.

export type UsageLedgerEnvironment = "development" | "production";

export interface UsageLedgerEntryInput {
  // identity/context — 호출부가 실제로 알고 있는 값만 채운다. 모르면 undefined로 남기고
  // 가짜 값을 만들어내지 않는다(§ 요구사항 9 agent-orchestrator 적용 원칙).
  projectId?: string;
  phaseId?: string;
  taskId?: string;
  agentId?: string;
  environment: UsageLedgerEnvironment;

  // API identity
  /** 이 API를 호출한 AutoDev 내부 컴포넌트(예: "gpt-reviewer"). */
  service: string;
  /** 예: "openai", "anthropic". */
  provider: string;
  /** 실제 응답이 echo한 모델명만 담는다(요청 시 지정한 상수가 아니라 실제 응답값) — 관측되지
   *  않았으면 undefined. */
  model?: string;
  /** 예: "gpt_review", "developer_task", "read_only_agent". */
  operation: string;

  // usage — 실제로 확인 가능한 값만 채운다. 0으로 채우지 않는다(§ 요구사항 4).
  /** 이 entry가 나타내는 실제 API 요청 수(재시도 포함). Budget Guard가 API 호출 전에 막은
   *  경우는 반드시 0이어야 한다(§ 요구사항 8). */
  requestCount: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  payloadChars?: number;
  durationMs?: number;
  /** Phase SI-3.8D — "FULL" | "INCREMENTAL" | "SAFE_FULL_FALLBACK"(review-baseline.ts
   *  ReviewPayloadMode). string으로 받는 이유는 gpt-budget-guard.ts의 status 필드와 동일한
   *  근거 — 이 파일이 review-baseline.ts의 타입에 직접 의존하지 않게 해서(Ledger는 provider별
   *  세부 개념을 몰라도 되는 범용 스키마로 유지) 순환 의존을 만들지 않는다. */
  reviewMode?: string;

  // cost — estimatedCostUsd와 actualCostUsd를 절대 혼동하지 않는다(§ 요구사항 5).
  /** pricing-catalog.ts의 calculateEstimatedCost()로 계산된 값만 채운다 — 가격표가 없으면
   *  undefined로 남긴다(임의 추정 금지). */
  estimatedCostUsd?: number;
  /** API 응답/billing source가 실제로 제공한 청구 금액만 담는다 — 이번 Task는 그런 source를
   *  연결하지 않으므로 항상 undefined다(추정값을 실제값처럼 채우지 않는다). */
  actualCostUsd?: number;
  currency?: string;

  // execution
  /** review cycle/operation cycle 등 — 가능한 경우만. */
  operationCycle?: number;
  /** 예: "SUCCESS", "BUDGET_BLOCKED", "AUTH_ERROR", "API_ERROR", "INVALID_OUTPUT". 자유
   *  서술문이 아니라 짧은 상태 코드만 담는다(§ 파일 상단 Secret 미저장 설계). */
  status: string;
}

export interface UsageLedgerEntry extends UsageLedgerEntryInput {
  entryId: string;
  timestamp: string;
  sequence: number;
}

export interface UsageLedgerQueryFilter {
  projectId?: string;
  taskId?: string;
  provider?: string;
  model?: string;
  operation?: string;
  service?: string;
}

export interface UsageLedgerAppendResult {
  ok: boolean;
  entry?: UsageLedgerEntry;
  error?: string;
}

export type UsageLedgerIntegrityIssueReason = "JSON_PARSE_ERROR" | "SCHEMA_INVALID";

export interface UsageLedgerIntegrityIssue {
  file: string;
  line: number;
  reason: UsageLedgerIntegrityIssueReason;
}

export interface UsageLedgerQueryResult {
  entries: UsageLedgerEntry[];
  integrityIssues: UsageLedgerIntegrityIssue[];
}

export interface UsageLedger {
  append(input: UsageLedgerEntryInput): UsageLedgerAppendResult;
  query(filter?: UsageLedgerQueryFilter): UsageLedgerQueryResult;
}

function matchesFilter(entry: UsageLedgerEntry, filter: UsageLedgerQueryFilter): boolean {
  if (filter.projectId !== undefined && entry.projectId !== filter.projectId) return false;
  if (filter.taskId !== undefined && entry.taskId !== filter.taskId) return false;
  if (filter.provider !== undefined && entry.provider !== filter.provider) return false;
  if (filter.model !== undefined && entry.model !== filter.model) return false;
  if (filter.operation !== undefined && entry.operation !== filter.operation) return false;
  if (filter.service !== undefined && entry.service !== filter.service) return false;
  return true;
}

/** 메모리 기반 Ledger — 프로세스 생존 동안만 유지된다(테스트/dry-run 기본값). */
export function createInMemoryUsageLedger(): UsageLedger {
  const entries: UsageLedgerEntry[] = [];
  let sequence = 0;

  return {
    append(input) {
      sequence += 1;
      const entry: UsageLedgerEntry = { ...input, entryId: randomUUID(), timestamp: new Date().toISOString(), sequence };
      entries.push(entry);
      return { ok: true, entry };
    },
    query(filter = {}) {
      return { entries: entries.filter((e) => matchesFilter(e, filter)).map((e) => ({ ...e })), integrityIssues: [] };
    },
  };
}

function isValidStoredEntry(value: unknown): value is UsageLedgerEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.entryId === "string" &&
    typeof v.timestamp === "string" &&
    typeof v.sequence === "number" &&
    (v.environment === "development" || v.environment === "production") &&
    typeof v.service === "string" &&
    typeof v.provider === "string" &&
    typeof v.operation === "string" &&
    typeof v.requestCount === "number" &&
    typeof v.status === "string"
  );
}

function readAllEntriesWithIntegrity(filePath: string): { entries: UsageLedgerEntry[]; integrityIssues: UsageLedgerIntegrityIssue[] } {
  if (!existsSync(filePath)) return { entries: [], integrityIssues: [] };
  const lines = readFileSync(filePath, "utf-8").split("\n");
  const entries: UsageLedgerEntry[] = [];
  const integrityIssues: UsageLedgerIntegrityIssue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue; // 순수 빈 줄(마지막 개행 등)은 손상이 아니다.
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      integrityIssues.push({ file: filePath, line: i + 1, reason: "JSON_PARSE_ERROR" });
      continue;
    }
    if (!isValidStoredEntry(parsed)) {
      integrityIssues.push({ file: filePath, line: i + 1, reason: "SCHEMA_INVALID" });
      continue;
    }
    entries.push(parsed);
  }
  return { entries, integrityIssues };
}

function readLastKnownSequence(filePath: string): number {
  let max = 0;
  for (const e of readAllEntriesWithIntegrity(filePath).entries) {
    if (e.sequence > max) max = e.sequence;
  }
  return max;
}

/**
 * append-only JSONL 파일 기반 Ledger — event-store.ts의 createFileEventStore와 동일한
 * append-safety 패턴(같은 append 방식, 손상 줄 fail-open 금지, 재시작 시 마지막 sequence부터
 * 이어감)을 이 스키마에 맞춰 재구현했다(§ 파일 상단 주석 — 두 파일이 서로 다른 스키마의
 * append-only store를 각자 소유하는 것이지, "Ledger 구현"이 여러 벌 있는 게 아니다).
 */
export function createFileUsageLedger(filePath: string): UsageLedger {
  let sequence = readLastKnownSequence(filePath);

  return {
    append(input) {
      sequence += 1;
      const entry: UsageLedgerEntry = { ...input, entryId: randomUUID(), timestamp: new Date().toISOString(), sequence };
      try {
        const dir = dirname(filePath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf-8");
        return { ok: true, entry };
      } catch (err) {
        return { ok: false, entry, error: err instanceof Error ? err.message : String(err) };
      }
    },
    query(filter = {}) {
      const { entries, integrityIssues } = readAllEntriesWithIntegrity(filePath);
      return {
        entries: entries.filter((e) => matchesFilter(e, filter)).sort((a, b) => a.sequence - b.sequence),
        integrityIssues,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Project 단위 파일 분리 & escape 방지(§ 요구사항 7 "프로젝트 단위로 append", "project root
// escape 금지").
//
// projectId는 외부에서 주입되는 문자열이다(ProjectManifest.projectId는 "비어있지 않은
// 문자열"만 검증하고 그 외 형식을 강제하지 않는다 — project-manifest.ts) — 그대로 파일명에
// 쓰면 "../../etc/passwd" 같은 경로 조작 문자열이 ledger base 디렉터리를 벗어난 임의 경로에
// 쓰기를 시도하게 만들 수 있다. sanitizeProjectIdForFilename()은 [A-Za-z0-9_-]만 허용하는
// allow-list로 이 클래스의 이스케이프를 구조적으로 불가능하게 만든다(경로 구분자/".."을
// 애초에 결과 문자열에 포함시킬 수 없다) — resolveUsageLedgerFilePath()의 realpath containment
// 재확인은 그 위에 얹는 defense-in-depth다(project-bootstrap.ts의 ancestor containment 재확인
// 철학과 동일).
// ---------------------------------------------------------------------------

const UNSCOPED_LEDGER_FILE_NAME = "_unscoped";
const PROJECT_ID_MAX_LEN = 128;
const PROJECT_ID_HASH_HEX_LEN = 10;

export function sanitizeProjectIdForFilename(projectId: string | undefined): string {
  if (projectId === undefined) return UNSCOPED_LEDGER_FILE_NAME;
  const trimmed = projectId.trim();
  if (trimmed.length === 0) return UNSCOPED_LEDGER_FILE_NAME;
  const cleaned = trimmed.slice(0, PROJECT_ID_MAX_LEN).replace(/[^A-Za-z0-9_-]/g, "_");
  return cleaned.length > 0 ? cleaned : UNSCOPED_LEDGER_FILE_NAME;
}

function isEffectivelyUnscoped(projectId: string | undefined): boolean {
  return projectId === undefined || projectId.trim().length === 0;
}

/** projectId 원문 전체를 반영하는 짧은 hex digest — sanitizeProjectIdForFilename()의
 *  allow-list(§ 위)는 서로 다른 원본 문자열을 같은 결과로 뭉갤 수 있다(예: "proj@a"와
 *  "proj#a"가 둘 다 "proj_a"가 됨, Claude code-review 지적) — 이 해시를 파일명 접미사로
 *  덧붙여 서로 다른 projectId가 같은 ledger 파일에 뒤섞이는 것을 실질적으로 방지한다. */
function shortProjectIdHash(projectId: string): string {
  return createHash("sha256").update(projectId, "utf-8").digest("hex").slice(0, PROJECT_ID_HASH_HEX_LEN);
}

/** ledger 파일명(확장자 제외)을 계산한다 — projectId가 미지정/공백이면 고정된 단일
 *  "_unscoped" 버킷을 그대로 쓰고(충돌 대상이 없으므로 해시가 불필요하다), 그 외에는
 *  sanitize된 사람이 읽는 접두어 + 원본 전체 기반 해시 접미사를 결합한다. 이 접미사 덕분에
 *  파일명 stem이 Windows 예약 장치 이름(CON/PRN/AUX/NUL/COM1-9/LPT1-9, Claude code-review
 *  지적)과 정확히 일치할 수도 없다. */
function ledgerFileBaseName(projectId: string | undefined): string {
  const safeName = sanitizeProjectIdForFilename(projectId);
  if (isEffectivelyUnscoped(projectId)) return safeName;
  return `${safeName}-${shortProjectIdHash(projectId as string)}`;
}

export type ResolveUsageLedgerPathResult = { ok: true; path: string } | { ok: false; error: string };

/** baseDir 안에 projectId별로 분리된 ledger 파일 경로를 계산한다. sanitize 이후에도 결과
 *  파일의 부모 디렉터리가 baseDir 그 자체가 아니면(구조적으로 발생할 수 없어야 하지만) 실제
 *  경로를 반환하지 않고 명시적으로 실패시킨다(fail-closed — § 요구사항: project root escape
 *  금지를 조회 단계에서 다시 한번 확인). */
export function resolveUsageLedgerFilePath(baseDir: string, projectId: string | undefined): ResolveUsageLedgerPathResult {
  const fileBaseName = ledgerFileBaseName(projectId);
  if (fileBaseName.includes("/") || fileBaseName.includes("\\") || fileBaseName === "." || fileBaseName === "..") {
    return { ok: false, error: `sanitize 이후에도 안전하지 않은 파일명이 남았습니다: ${fileBaseName}` };
  }
  const resolvedBaseDir = resolve(baseDir);
  const candidate = join(resolvedBaseDir, `${fileBaseName}.jsonl`);
  if (dirname(candidate) !== resolvedBaseDir) {
    return { ok: false, error: `Ledger 파일 경로가 base 디렉터리(${resolvedBaseDir})를 벗어났습니다: ${candidate}` };
  }
  return { ok: true, path: candidate };
}

// AutoDev 자신의 runtime data다(event-store.ts의 RUNTIME_EVENT_LOG_PATH와 동일한 위치 계산
// 방식/근거) — target project(MOVAN 등) repository 안이 아니다. logs/는 이미 .gitignore에
// 포함돼 있다.
export const RUNTIME_USAGE_LEDGER_DIR = join(__dirname, "..", "logs", "usage-ledger");

/**
 * production 여부(isProductionRuntime — AUTOMATION_DRY_RUN="false" *그리고*
 * AUTODEV_PRODUCTION_RUNTIME="true")에 따라 file/in-memory를 선택한다(event-store.ts의
 * selectDefaultEventStore와 동일한 fail-closed 원칙 — 두 신호 중 하나라도 없으면 항상
 * in-memory). 경로 확인 자체가 실패하면(이론상 sanitize 이후 발생할 수 없지만 방어적으로)
 * 파일 쓰기를 시도하지 않고 in-memory로 대체한다 — 조용히 잘못된 경로에 쓰지 않는다.
 */
export function selectDefaultUsageLedgerForProject(projectId: string | undefined, baseDir: string = RUNTIME_USAGE_LEDGER_DIR): UsageLedger {
  if (!isProductionRuntime()) return createInMemoryUsageLedger();
  const resolved = resolveUsageLedgerFilePath(baseDir, projectId);
  if (!resolved.ok) {
    log(`Usage Ledger 경로 확인 실패 — in-memory로 대체합니다: ${resolved.error}`);
    return createInMemoryUsageLedger();
  }
  return createFileUsageLedger(resolved.path);
}

// ---------------------------------------------------------------------------
// Aggregation(§ 요구사항 10) — 순수 함수, 어떤 I/O도 하지 않는다. metrics.ts와 동일한 원칙:
// unknown cost가 있으면 "전체 actual cost"처럼 오해할 수 있는 합계를 만들지 않는다.
// ---------------------------------------------------------------------------

export interface UsageLedgerAggregate {
  entryCount: number;
  totalRequestCount: number;
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  /** estimatedCostUsd가 실제로 있는 entry만 합산한 값 — "전체 추정 비용"이 아니라 "알려진
   *  추정 비용의 합"이라는 의미를 이름에 명시한다. */
  knownEstimatedCostUsd: number;
  /** estimatedCostUsd가 없는(가격표에 없거나 usage 미확인) entry 수 — 위 knownEstimatedCostUsd
   *  가 완전한 합계가 아닐 수 있다는 신호를 명시적으로 보존한다(§ 요구사항 10/13). */
  unknownCostEntryCount: number;
  /** actualCostUsd가 실제로 있는 entry만 합산한 값 — estimatedCostUsd와 절대 합산하지 않는다. */
  knownActualCostUsd: number;
  unknownActualCostEntryCount: number;
}

function emptyAggregate(): UsageLedgerAggregate {
  return {
    entryCount: 0,
    totalRequestCount: 0,
    totalInputTokens: 0,
    totalCachedInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    knownEstimatedCostUsd: 0,
    unknownCostEntryCount: 0,
    knownActualCostUsd: 0,
    unknownActualCostEntryCount: 0,
  };
}

function foldEntry(agg: UsageLedgerAggregate, e: UsageLedgerEntry): void {
  agg.entryCount += 1;
  agg.totalRequestCount += e.requestCount;
  if (e.inputTokens !== undefined) agg.totalInputTokens += e.inputTokens;
  if (e.cachedInputTokens !== undefined) agg.totalCachedInputTokens += e.cachedInputTokens;
  if (e.outputTokens !== undefined) agg.totalOutputTokens += e.outputTokens;
  if (e.totalTokens !== undefined) agg.totalTokens += e.totalTokens;
  if (e.estimatedCostUsd !== undefined) agg.knownEstimatedCostUsd += e.estimatedCostUsd;
  else agg.unknownCostEntryCount += 1;
  if (e.actualCostUsd !== undefined) agg.knownActualCostUsd += e.actualCostUsd;
  else agg.unknownActualCostEntryCount += 1;
}

/** entries 전체를 하나로 합산한다. */
export function aggregateUsageLedgerEntries(entries: readonly UsageLedgerEntry[]): UsageLedgerAggregate {
  const agg = emptyAggregate();
  for (const e of entries) foldEntry(agg, e);
  return agg;
}

const UNKNOWN_GROUP_KEY = "(unknown)";

function groupBy(entries: readonly UsageLedgerEntry[], keyFn: (e: UsageLedgerEntry) => string | undefined): Record<string, UsageLedgerAggregate> {
  const result: Record<string, UsageLedgerAggregate> = {};
  for (const e of entries) {
    const key = keyFn(e) ?? UNKNOWN_GROUP_KEY;
    if (!result[key]) result[key] = emptyAggregate();
    foldEntry(result[key], e);
  }
  return result;
}

export function aggregateUsageLedgerByProject(entries: readonly UsageLedgerEntry[]): Record<string, UsageLedgerAggregate> {
  return groupBy(entries, (e) => e.projectId);
}
export function aggregateUsageLedgerByTask(entries: readonly UsageLedgerEntry[]): Record<string, UsageLedgerAggregate> {
  return groupBy(entries, (e) => e.taskId);
}
export function aggregateUsageLedgerByProvider(entries: readonly UsageLedgerEntry[]): Record<string, UsageLedgerAggregate> {
  return groupBy(entries, (e) => e.provider);
}
export function aggregateUsageLedgerByModel(entries: readonly UsageLedgerEntry[]): Record<string, UsageLedgerAggregate> {
  return groupBy(entries, (e) => e.model);
}
export function aggregateUsageLedgerByOperation(entries: readonly UsageLedgerEntry[]): Record<string, UsageLedgerAggregate> {
  return groupBy(entries, (e) => e.operation);
}
