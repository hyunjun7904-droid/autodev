import { existsSync, readFileSync } from "node:fs";
import { loadProjectAdapter } from "./project-adapter-loader";
import type { ProjectManifest } from "./project-manifest";
import { maintenancePauseMarkerPath } from "./runner-supervisor";

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
