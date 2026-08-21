import { TARGET_PROJECT_ROOT, DEFAULT_STATE_PATH } from "../project-context";
import { MOVAN_TASK_REGISTRY } from "../project-registries/movan";
import type { ProjectManifest } from "../project-manifest";
import type { ProjectExecutionPolicy } from "../project-policy";
import type { ProjectState } from "../types";

// AutoDev 범용화 Phase A Task A4 — MOVAN Project Manifest.
//
// 기존에 흩어져 있던 세 값(TARGET_PROJECT_ROOT — A1, DEFAULT_STATE_PATH — A2,
// MOVAN_TASK_REGISTRY — A3)을 그대로 참조해 하나의 ProjectManifest로 조립만 한다 — 값 자체를
// 다시 계산하거나 바꾸지 않는다. autodev.ts는 이제 MOVAN_TASK_REGISTRY를 직접 import하지
// 않고 이 manifest를 통해서만 MOVAN 데이터에 접근한다.
//
// AutoDev 범용화 Phase A Task A6 — developerInstructions/reviewInstructions/reviewScopeDirs/
// rulesPath 추가. 지금까지 claude-developer.ts/gpt-reviewer.ts Core 파일에 직접 하드코딩돼
// 있던 "MOVAN ERP 프로젝트의 자동 개발자/리뷰어입니다", 허용 read/write 범위(web/**,
// automation/**, supabase/migrations/**), 허용 명령 목록, Phase 규칙(migration 불변 등)
// 같은 MOVAN 전용 내용을 그대로(문구 변경 없이) 여기로 옮겨왔다 — Core의 동작이나 실제
// Safe Executor의 강제(enforcement)는 전혀 바뀌지 않는다(§ project-manifest.ts 상단 주석).

// AutoDev 범용화 Phase B Task B1 — Safe Executor의 실제 read/write 허용 경로·명령
// allow-list(이전까지 safe-executor.ts에 하드코딩돼 있던 MOVAN 전용 enforcement 데이터)를
// 이 파일로 옮긴다. Safe Executor(safe-executor.ts) 자체는 이제 이 값들을 전혀 모른다 —
// configureSafeExecutor()로 이 정책을 명시적으로 주입받아야만 동작한다.
//
// AutoDev 범용화 Phase B Task B2 — 물리적 repository 분리. automation/이 더 이상
// MOVAN targetProjectRoot 하위에 존재하지 않으므로("automation/" cwd 별칭 및 관련
// allowedCommands/allowedReadPrefixes/allowedWritePrefixes 항목이 가리키던 경로가
// 실제로 사라졌다) 그 항목들을 제거했다 — 현재 MOVAN_TASK_REGISTRY의 어떤 task도
// automation/을 allowedPathPrefixes에 포함하지 않고(COMMON_PROHIBITIONS가 이미
// "automation/ 수정 금지"를 명시), 이 명령들은 애초에 MOVAN task 실행 중 쓰인 적이
// 없다(AutoDev 자신의 개발/회귀테스트용 명령이었다 — 이제 AutoDev standalone repo
// 자신의 package.json 안에서만 의미가 있다). web/·supabase 관련 값은 그대로 둔다.
export const MOVAN_EXECUTION_POLICY: ProjectExecutionPolicy = {
  allowedReadPrefixes: ["web/", "supabase/migrations/"],
  allowedWritePrefixes: ["web/"],
  // supabase/migrations/**는 read는 허용되지만 write는 절대 금지(0001~0018 포함 전체) —
  // README.md도 AutoDev가 직접 덮어쓰지 않는다.
  writeDenyPatterns: [/^supabase\/migrations\/.+\.sql$/, /^README\.md$/i],
  commandCwdAliases: { web: "web" },
  allowedCommands: [
    { cwd: "root", command: "git", args: ["status", "--short"] },
    { cwd: "root", command: "git", args: ["diff"] },
    { cwd: "root", command: "git", args: ["diff", "--stat"] },
    { cwd: "root", command: "git", args: ["log", "-1", "--oneline"] },
    { cwd: "web", command: "npx", args: ["tsc", "--noEmit"] },
    { cwd: "web", command: "npm", args: ["run", "build"] },
  ],
};

const allowedCommandsText = MOVAN_EXECUTION_POLICY.allowedCommands
  .map((c) => `- (${c.cwd}) ${c.command} ${c.args.join(" ")}`)
  .join("\n");

const MOVAN_DEVELOPER_INSTRUCTIONS = `허용 read 범위: web/**, supabase/migrations/**(읽기 전용).
허용 write 범위: web/** (.env 계열/node_modules/.next/.git 제외).
supabase/migrations/**는 절대 WRITE 불가(0001~0018 포함 전체). README.md도 WRITE 불가.

허용 명령(정확히 일치해야 함, 그 외 전부 거부):
${allowedCommandsText}

production DB/Microsoft/OAuth/실제 배포 작업이 필요하면 시도하지 말고 TASK_COMPLETE의
summary에 사람 확인이 필요하다고 명시하세요.`;

const MOVAN_REVIEW_INSTRUCTIONS = `Phase 규칙 준수 여부도 함께 확인하세요: 0013~0016 migration은
불변이며 절대 수정되면 안 됩니다. Phase 10 관련 작업은 금지되어 있습니다.`;

export const MOVAN_PROJECT_MANIFEST: ProjectManifest = {
  projectId: "movan",
  projectName: "MOVAN ERP",
  targetProjectRoot: TARGET_PROJECT_ROOT,
  statePath: DEFAULT_STATE_PATH,
  taskRegistry: MOVAN_TASK_REGISTRY,
  developerInstructions: MOVAN_DEVELOPER_INSTRUCTIONS,
  reviewInstructions: MOVAN_REVIEW_INSTRUCTIONS,
  // Phase B Task B2 — automation/이 targetProjectRoot(MOVAN repo) 밖으로 물리적으로
  // 옮겨졌으므로 reviewScopeDirs/rulesPath도 더 이상 automation/을 가리키지 않는다.
  // rules.md는 MOVAN 소유 운영 규칙 문서이므로 MOVAN repo의 .autodev/로 이동했다.
  reviewScopeDirs: ["web/"],
  rulesPath: ".autodev/rules.md",
  executionPolicy: MOVAN_EXECUTION_POLICY,
};

// AutoDev 범용화 Phase A Task A5 — MOVAN 전용 project-state 확장 필드.
//
// types.ts의 CoreState(AutoDev Core가 실제로 읽고/쓰는 최소 공통 상태)와 분리해, 실제
// automation/config/project-state.json에는 있지만 orchestrator.ts/checkpoint.ts/
// task-registry.ts/autodev.ts의 판단 로직 어디서도 읽지 않는(사용처를 실제로 추적해 확인한)
// MOVAN 전용 bookkeeping 필드만 여기 모은다. Core 파일들은 이 인터페이스를 import하지
// 않는다 — MOVAN 전용 필드가 늘어나거나 바뀌어도 Core 파일을 다시 손댈 필요가 없어야 한다는
// 것이 A5의 목적이다. 향후 BILLION 같은 다른 프로젝트를 붙일 때도 이 파일과 같은 자리에
// BillionProjectExtension을 별도로 만들면 되고, Core는 그 내부 필드를 몰라도 된다.
//
// 실제 project-state.json에는 여기 나열한 필드 외에도 phase9Status~phase20Note,
// migrationsAppliedNote 같은 자유 형식 서술 필드가 더 있다(Phase마다 사람이 추가해온 기록).
// 이번 A5는 그 필드들을 전부 열거해 타입으로 고정하지 않는다(범위 밖) — bare `ProjectState`
// (기본 타입 인자 Record<string, unknown>)로 load/save하는 한 그 필드들도 그대로 보존된다.
export interface MovanProjectExtension {
  project: string;
  phase10Allowed: boolean;

  migrationsApplied: string[];
  migrationsImmutable: boolean;

  devSupabaseCreated: boolean;
  devSupabaseConnected: boolean;

  microsoftConnected: boolean;
  productionDeployAllowed: boolean;
}

/** MOVAN project-state.json 전체를 가리키는 구체 타입(CoreState + MOVAN 전용 필드). 이번
 *  A5에서는 기존 소비자를 이 타입으로 강제 전환하지 않는다 — 필요할 때 선택적으로 쓴다. */
export type MovanProjectState = ProjectState<MovanProjectExtension>;
