import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadProjectAdapter } from "./project-adapter-loader";
import type { ProjectManifest } from "./project-manifest";
import { maintenancePauseMarkerPath } from "./runner-supervisor";
import { compareEventsChronologically } from "./observability-event";
import type { AutoDevEvent } from "./observability-event";

// AutoDev Dashboard 멀티프로젝트 운영센터 개선 — Dashboard Project Registry.
//
// 대시보드 프로세스는 AutoDev Core와 마찬가지로 어떤 프로젝트가 등록돼 있는지 스스로
// 알지 못한다(§ CLAUDE.md) — 이 파일도 예외가 아니다. 이 파일이 하는 일은 딱 하나: "이
// 대시보드가 표시해야 할 project adapter 경로 목록"을 환경변수에서 읽어 각 경로를
// loadProjectAdapter()(project-adapter-loader.ts, 기존 검증 로직 그대로 재사용 — 새 파싱
// 로직을 만들지 않는다)로 검증하는 것뿐이다. run.ts/autodev.ts가 실제로 실행하는 project
// 목록과 이 registry는 완전히 분리돼 있다 — 이 파일은 오직 "무엇을 화면에 보여줄지"만
// 결정하고, 어떤 project를 실행/재개/일시정지할지는 전혀 결정하지 않는다(읽기 전용).
//
// 여러 project를 동시에 보여주려면 여러 adapter 경로가 필요하므로
// AUTODEV_DASHBOARD_PROJECT_ADAPTERS(JSON 문자열 배열)를 새로 도입한다. 이 환경변수가
// 없으면 기존 단일 프로젝트 배포와 완전히 동일하게 동작하도록 AUTODEV_PROJECT_ADAPTER
// (dashboard-project-progress.ts가 이미 쓰는 것과 동일한 변수) 하나만 등록된 것으로
// 취급한다 — 기존 단일 프로젝트 Dashboard 배포/테스트는 이 변경으로 동작이 바뀌지 않는다.

export const DASHBOARD_PROJECT_ADAPTERS_ENV = "AUTODEV_DASHBOARD_PROJECT_ADAPTERS";
export const SINGLE_PROJECT_ADAPTER_ENV = "AUTODEV_PROJECT_ADAPTER";

export interface RegisteredProject {
  adapterPath: string;
  projectId: string;
  projectName: string;
  manifest: ProjectManifest;
}

export interface ProjectRegistryLoadIssue {
  adapterPath: string;
  reason: string;
}

export interface ProjectRegistryResult {
  projects: RegisteredProject[];
  issues: ProjectRegistryLoadIssue[];
}

/**
 * AUTODEV_DASHBOARD_PROJECT_ADAPTERS는 JSON 문자열 배열이어야 한다(예:
 * '["C:/proj-a/.autodev/manifest.json","C:/proj-b/.autodev/manifest.json"]'). 형식이
 * 잘못됐으면 추측해서 일부만 쓰지 않고 빈 목록으로 취급한다 — 호출부가 issues로 그 사실을
 * 알 수 있게 별도 반환하지 않는 이유는, 환경변수 자체가 통째로 무효면 "어떤 project를
 * 등록하려 했는지"조차 알 수 없어 개별 adapterPath 단위의 issue를 만들 수 없기 때문이다
 * (이 경우 프로세스 시작 시 로그로만 알린다 — 이 함수는 순수 함수로 남긴다).
 */
function candidateAdapterPaths(env: NodeJS.ProcessEnv): { paths: string[]; malformed: boolean } {
  const multi = env[DASHBOARD_PROJECT_ADAPTERS_ENV];
  if (multi !== undefined && multi.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(multi);
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string" && p.trim().length > 0)) {
        return { paths: parsed as string[], malformed: false };
      }
      return { paths: [], malformed: true };
    } catch {
      return { paths: [], malformed: true };
    }
  }
  const single = env[SINGLE_PROJECT_ADAPTER_ENV];
  return { paths: single && single.trim().length > 0 ? [single] : [], malformed: false };
}

/**
 * 등록된 모든 adapter 경로를 읽어 검증한다 — 하나가 실패해도(파일 없음/JSON 오류/manifest
 * 검증 실패) 나머지 project는 계속 표시할 수 있어야 하므로 예외를 던지지 않고 issues에
 * 담는다(§ 요구사항: 한 프로젝트 오류가 다른 카드 상태를 오염시키지 않음). 같은 projectId가
 * 서로 다른 adapter 경로에 중복 등록되면 먼저 나온 것만 쓰고 나머지는 issue로 보고한다
 * (projectId collision 방지).
 */
export function loadProjectRegistry(env: NodeJS.ProcessEnv = process.env): ProjectRegistryResult {
  const { paths, malformed } = candidateAdapterPaths(env);
  const projects: RegisteredProject[] = [];
  const issues: ProjectRegistryLoadIssue[] = [];
  if (malformed) {
    issues.push({
      adapterPath: env[DASHBOARD_PROJECT_ADAPTERS_ENV] ?? "",
      reason: `${DASHBOARD_PROJECT_ADAPTERS_ENV}가 문자열 JSON 배열이 아닙니다.`,
    });
  }
  const seenProjectIds = new Set<string>();
  for (const adapterPath of paths) {
    try {
      const manifest = loadProjectAdapter(adapterPath);
      if (seenProjectIds.has(manifest.projectId)) {
        issues.push({ adapterPath, reason: `중복된 projectId(${manifest.projectId}) — 먼저 등록된 project만 표시합니다.` });
        continue;
      }
      seenProjectIds.add(manifest.projectId);
      projects.push({ adapterPath, projectId: manifest.projectId, projectName: manifest.projectName, manifest });
    } catch (e) {
      issues.push({ adapterPath, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { projects, issues };
}

// ---------------------------------------------------------------------------
// Dashboard Project Auto-Discovery — 새 프로젝트를 사용자가 별도로 등록하지 않아도 자동으로
// 표시한다(2026-09-03).
// ---------------------------------------------------------------------------
//
// 지금까지 이 파일의 유일한 project 출처는 위 candidateAdapterPaths()의 두 환경변수뿐이었다
// — 즉 "AutoDev가 정식 manifest로 실제 실행을 시작했다"는 사실만으로는 Dashboard가 그
// project를 "등록됨(운영)"으로 표시할 방법이 없고, 사람이 매번 그 adapter 경로를
// AUTODEV_DASHBOARD_PROJECT_ADAPTERS(또는 AUTODEV_PROJECT_ADAPTER)에 손으로 추가하고
// Dashboard 프로세스를 재시작해야만 했다(Revenue OS가 실제로 겪은 결함).
//
// autodev.ts는 RUN_STARTED emit 시점(validateProjectManifest 통과 + project lock 획득 성공
// 직후 — Task 성격의 project 실행이 시작됐다고 확정할 수 있는 유일한 지점)에
// manifest.adapterPath(§ project-manifest.ts, Multi-Project Approval Isolation이 이미 쓰는
// 것과 동일한 단일 출처)를 event.metadata.adapterPath로 싣는다. Dashboard는 이미 매 요청마다
// 이 project와 무관하게 event 전체를 다시 읽으므로(§ dashboard-snapshot-provider.ts
// readQueryResult, mtime/size 캐시만 있을 뿐 재시작이 필요 없다), 그 event만 보고도 즉시
// adapterPath를 알아내 loadProjectAdapter()(기존 검증 로직 그대로 재사용)로 다시 검증할 수
// 있다 — 새 registry 파일/저장소를 전혀 만들지 않는다(§ 요구사항: "기존 구조가 있으면
// 재사용한다").
export function discoverProjectsFromEvents(events: readonly Pick<AutoDevEvent, "eventType" | "projectId" | "metadata" | "timestamp" | "sequence">[]): ProjectRegistryResult {
  // 같은 projectId에 대해 여러 RUN_STARTED가 있으면(재실행/재시작) 가장 최근 것만 "지금 이
  // projectId가 실제로 가리키는 manifest 경로"로 신뢰한다(§ 요구사항 F "재실행 시 중복 카드가
  // 아니라 기존 project 갱신") — sequence만으로는 여러 프로세스가 동시에 append할 때 순서가
  // 뒤바뀔 수 있어(§ observability-event.ts compareEventsChronologically 문서) timestamp를
  // 우선 기준으로 쓴다.
  const latestByProjectId = new Map<string, Pick<AutoDevEvent, "eventType" | "projectId" | "metadata" | "timestamp" | "sequence">>();
  for (const e of events) {
    if (e.eventType !== "RUN_STARTED" || !e.projectId) continue;
    if (typeof e.metadata?.adapterPath !== "string" || e.metadata.adapterPath.trim().length === 0) continue;
    const existing = latestByProjectId.get(e.projectId);
    if (!existing || compareEventsChronologically(existing, e) < 0) {
      latestByProjectId.set(e.projectId, e);
    }
  }

  const projects: RegisteredProject[] = [];
  const issues: ProjectRegistryLoadIssue[] = [];
  for (const [projectId, event] of latestByProjectId) {
    const adapterPath = event.metadata!.adapterPath as string;
    // Stale Discovered-Registration Reconciliation(2026-09-03 실제 운영 결함 — E2E 검증용
    // 임시 project를 정리한 뒤에도 REGISTRY_ISSUE가 매 요청마다 영구히 재발생함을 실제
    // production Dashboard에서 확인) — RUN_STARTED event는 절대 삭제되지 않는 영구 기록이므로
    // (§ 요구사항 E, I), "그 경로에 manifest 파일이 지금 없다"는 사실은 매 요청마다 무한히
    // 반복된다. 이 상태는 사람이 직접 고칠 수 있는 "설정 오류"가 아니라(사람이 잘못 입력한
    // adapterPath가 아니라 과거 실행이 실제로 남긴 흔적일 뿐이다) 프로젝트가 정상적으로
    // 끝난 뒤 정리됐거나(테스트 fixture, 완료된 project 등) manifest가 일시적으로 접근 불가한
    // 흔한 정상 상태다 — 그래서 issue로 격상하지 않고 조용히 "지금은 등록 불가"로만 처리한다.
    // 이 project는 event 기반 미등록 카드(§ eventsByProjectId)로는 계속 보인다 — 데이터 손실이
    // 아니라 표시만 "등록됨" 대신 "미등록"으로 남을 뿐이다. 반대로 파일이 실제로 "존재하는데"
    // 내용이 깨졌거나(JSON 오류/스키마 위반) projectId가 다른 project로 교체됐다면, 그건 지금
    // 누군가 그 파일을 실제로 건드렸다는 뜻이라 여전히 issue로 표면화한다(사람이 확인해야 할
    // 진짜 이상 신호).
    if (!existsSync(resolve(adapterPath.trim()))) {
      continue;
    }
    try {
      const manifest = loadProjectAdapter(adapterPath);
      if (manifest.projectId !== projectId) {
        // event가 기록된 이후 그 경로의 manifest가 다른 project로 교체된 경우(§ 요구사항 G
        // "manifestPath 충돌") — 추측해서 아무 쪽으로나 연결하지 않고 등록을 보류한다. event
        // 자체(§ eventsByProjectId 기반 미등록 카드)로는 계속 표시된다.
        issues.push({
          adapterPath,
          reason: `RUN_STARTED가 기록한 projectId(${projectId})와 현재 manifest의 projectId(${manifest.projectId})가 달라 자동 등록하지 않습니다 — manifest 파일이 다른 project로 교체됐을 수 있습니다.`,
        });
        continue;
      }
      projects.push({ adapterPath, projectId, projectName: manifest.projectName, manifest });
    } catch (e) {
      // 파일은 존재하는데(위 existsSync 통과) 읽기/파싱/검증에 실패한 경우 — 손상된 상태를
      // 조용히 감추지 않고 issue로 남긴다(파일이 아예 없는 경우와 달리, 이건 지금 그 경로에
      // 뭔가 있는데 잘못됐다는 실제 이상 신호다).
      issues.push({ adapterPath, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { projects, issues };
}

/**
 * loadProjectRegistry()(명시적 환경변수 등록)와 discoverProjectsFromEvents()(RUN_STARTED
 * event 기반 자동 발견)의 합집합이다 — dashboard-snapshot-provider.ts의
 * getMultiProjectDashboardSnapshot() 하나만 이 함수를 쓴다. 두 출처가 같은 projectId를
 * 서로 다른 adapterPath로 보고하면(§ 요구사항 G) 명시적으로 등록된 쪽을 그대로 유지하고
 * (사람이 의도적으로 설정한 값을 event가 임의로 덮어쓰지 않는다), 그 사실을 issue로
 * 남긴다 — 조용히 아무거나 선택하지 않는다.
 */
export function loadCombinedProjectRegistry(
  env: NodeJS.ProcessEnv,
  events: readonly Pick<AutoDevEvent, "eventType" | "projectId" | "metadata" | "timestamp" | "sequence">[]
): ProjectRegistryResult {
  const explicit = loadProjectRegistry(env);
  const discovered = discoverProjectsFromEvents(events);

  const projects = [...explicit.projects];
  const issues = [...explicit.issues, ...discovered.issues];
  const explicitByProjectId = new Map(explicit.projects.map((p) => [p.projectId, p]));

  for (const d of discovered.projects) {
    const existing = explicitByProjectId.get(d.projectId);
    if (existing) {
      if (existing.adapterPath !== d.adapterPath) {
        issues.push({
          adapterPath: d.adapterPath,
          reason: `projectId(${d.projectId})는 이미 ${existing.adapterPath}로 명시적으로 등록돼 있어, event에서 자동 발견된 다른 manifestPath는 무시합니다(임의 덮어쓰기 금지).`,
        });
      }
      continue;
    }
    projects.push(d);
    explicitByProjectId.set(d.projectId, d);
  }

  return { projects, issues };
}

export interface MaintenancePauseStatus {
  active: boolean;
  /** active일 때만 채워진다 — 마커 파일 내용을 못 읽어도(§ 아래 주석) active 판정 자체는
   *  파일 존재 여부만으로 이미 확정된다(추측 없이 판정, 진단 메타데이터만 optional). */
  engagedAt?: string;
  reason?: string;
}

/**
 * runner-supervisor.ts의 maintenancePauseMarkerPath()(단일 출처)를 그대로 재사용해 이
 * project의 Maintenance Pause 마커 파일 경로를 계산하고 존재 여부만 판정한다(§
 * runner-supervisor.ts 주석: "파일이 존재하는가만이 유일한 상태다"). 내용(engagedAt/reason)은
 * 순수 진단 표시용이며 판정에 쓰이지 않는다 — 손상돼 있어도 active 자체는 그대로 true로
 * 남는다(마커 파일이 있다는 사실 자체는 여전히 유효).
 */
export function readMaintenancePauseStatus(adapterPath: string, logsDir: string): MaintenancePauseStatus {
  const markerPath = maintenancePauseMarkerPath(adapterPath, logsDir);
  if (!existsSync(markerPath)) return { active: false };
  try {
    const raw = JSON.parse(readFileSync(markerPath, "utf-8")) as { engagedAt?: unknown; reason?: unknown };
    return {
      active: true,
      engagedAt: typeof raw.engagedAt === "string" ? raw.engagedAt : undefined,
      reason: typeof raw.reason === "string" ? raw.reason : undefined,
    };
  } catch {
    return { active: true };
  }
}
