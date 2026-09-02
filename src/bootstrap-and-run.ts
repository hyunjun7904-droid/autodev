import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { bootstrapProject } from "./project-bootstrap";
import type { BootstrapTrustedConfig, BootstrapOutcome, BootstrapRequestIdentity } from "./project-bootstrap";
import { runPlanner } from "./spec-planner";
import type { PlannerOutcome, PlannerTrustedConfig, PersistedProjectManifestFile } from "./spec-planner";
import type { PlannerValidationIssue } from "./spec-planner";
import type { ProjectExecutionPolicy } from "./project-policy";
import type { SpecIntakeRejectReason } from "./spec-intake";
import { MAX_SPEC_CONTENT_CHARS } from "./spec-intake";
import { loadProjectAdapter } from "./project-adapter-loader";
import { AUTODEV_ROOT } from "./project-context";
import type { CoreState } from "./types";

// bootstrap-and-run — 마스터 스펙(.md/.txt) 파일 → 새 프로젝트 폴더 생성 → Planner 실행 →
// run.ts(--project)가 바로 소비할 수 있는 adapter(.autodev/manifest.json) 조립까지를 하나로
// 잇는 CLI 진입점.
//
// 이 파일이 잇는 세 단계(bootstrapProject/runPlanner/adapter 조립)는 각각 이미 독립적으로
// 존재하고 검증돼 있었지만, 이를 순서대로 호출해 사람이 바탕화면에 저장한 스펙 파일 하나로
// 실행 준비까지 끝내는 진입점이 저장소 어디에도 없었다 — 이 파일이 그 접착 코드다.
//
// 이 스크립트를 실행하는 사람 자신이 스펙의 최종 승인자라는 전제로, HandoffEnvelope의
// specStatus/userApproval/reviewerGate/unresolvedCriticalCount/contradictionCount를 이
// 스크립트가 직접 self-attest한다(별도 GPT/사람 리뷰 파이프라인이 아직 이 앞단에 없는
// 개인 프로젝트 워크플로우를 위함) — spec-intake.ts의 실제 검증 게이트(secret 스캔/
// digest 대조 등)는 조금도 우회하지 않는다.
//
// 이 스크립트는 실제 개발(run.js/start-autodev.ps1)을 스스로 시작하지 않는다 — adapter
// 조립까지만 하고, 사람이 검토 후 직접 실행할 정확한 다음 명령어만 안내한다.

export interface BootstrapAndRunArgs {
  specFilePath: string;
  projectId: string;
  projectName: string;
  baseDir?: string;
  specVersion?: string;
}

export interface BootstrapAndRunDeps {
  /** 기본값은 실제 Claude CLI를 호출하는 createClaudeCliRawOutputSource(runPlanner의 기본
   *  동작 그대로) — 테스트만 fake를 주입한다. */
  plannerConfig?: PlannerTrustedConfig;
  bootstrapConfigOverrides?: Partial<BootstrapTrustedConfig>;
  /** 기본값은 실제 readFileSync — 테스트가 파일시스템 없이 spec 내용을 주입할 때만 override. */
  readSpecFile?: (path: string) => string;
  now?: () => Date;
}

export type BootstrapAndRunResult =
  | { kind: "INVALID_ARGS"; detail: string }
  | { kind: "SPEC_FILE_ERROR"; detail: string }
  | { kind: "SPEC_TOO_LARGE"; detail: string }
  | { kind: "BASE_DIR_ERROR"; detail: string }
  | { kind: "BOOTSTRAP_REJECTED"; reasons: SpecIntakeRejectReason[] }
  | { kind: "BOOTSTRAP_BLOCKED"; code: string; detail: string }
  | { kind: "BOOTSTRAP_COLLISION"; reason: string; detail: string; existingProjectRoot: string }
  | { kind: "BOOTSTRAP_CONFLICT"; detail: string }
  | { kind: "BOOTSTRAP_WAITING_HUMAN"; detail: string }
  | { kind: "PLANNER_BLOCKED"; code: string; detail: string }
  | { kind: "PLANNER_CONFLICT"; detail: string }
  | { kind: "PLANNER_REJECTED"; issues: PlannerValidationIssue[] }
  | { kind: "HUMAN_REVIEW_REQUIRED"; projectRoot: string; projectManifestPath: string; fixedConstraintComplianceNote: string }
  | { kind: "ADAPTER_ASSEMBLY_FAILED"; detail: string }
  | { kind: "READY"; projectRoot: string; adapterPath: string; startCommand: string };

/** projectId 기준으로 결정적으로 파생한다 — 동일 --project-id 재실행은 항상 같은 handoffId를
 *  얻어 bootstrapProject/runPlanner의 identity 대조가 "같은 요청"으로 안전하게 resume되고,
 *  spec 내용만 바뀌면(같은 projectId, 다른 hash) CONFLICT로 fail-closed된다. */
function deriveHandoffId(projectId: string): string {
  return "hf" + createHash("sha256").update(`bootstrap-and-run:${projectId}`, "utf8").digest("hex").slice(0, 40);
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// 사용자 지정 기본값 — "C:\autodev-projects"(revenue-os가 있는 SSD/로컬 디스크)가 아니라
// 여유 공간이 훨씬 큰 D 드라이브(하드 디스크)에 새 프로젝트를 만든다. 필요하면 --base-dir로
// 언제든 다른 위치를 지정할 수 있다 — 이 값은 그 인자를 생략했을 때만 쓰이는 기본값이다.
// 기존에 C 드라이브에 이미 만들어진 프로젝트(예: revenue-os)는 이 기본값 변경과 무관하게
// 그 자리에 그대로 남는다.
const DEFAULT_BASE_DIR = "D:\\autodev-projects";

function defaultBaseDir(): string {
  return DEFAULT_BASE_DIR;
}

export async function runBootstrapAndPlan(args: BootstrapAndRunArgs, deps: BootstrapAndRunDeps = {}): Promise<BootstrapAndRunResult> {
  const readSpecFile = deps.readSpecFile ?? ((p: string) => readFileSync(p, "utf-8"));

  if (typeof args.specFilePath !== "string" || args.specFilePath.trim().length === 0) {
    return { kind: "INVALID_ARGS", detail: "--spec-file 경로가 비어있습니다." };
  }
  if (typeof args.projectId !== "string" || args.projectId.trim().length === 0) {
    return { kind: "INVALID_ARGS", detail: "--project-id가 비어있습니다." };
  }
  if (typeof args.projectName !== "string" || args.projectName.trim().length === 0) {
    return { kind: "INVALID_ARGS", detail: "--project-name이 비어있습니다." };
  }

  let specContentRaw: string;
  try {
    specContentRaw = readSpecFile(args.specFilePath);
  } catch (e) {
    return { kind: "SPEC_FILE_ERROR", detail: `spec 파일을 읽을 수 없습니다(${args.specFilePath}): ${e instanceof Error ? e.message : String(e)}` };
  }
  const specContent = specContentRaw.replace(/^﻿/, "");
  if (specContent.trim().length === 0) {
    return { kind: "SPEC_FILE_ERROR", detail: `spec 파일이 비어 있습니다: ${args.specFilePath}` };
  }
  if (specContent.length > MAX_SPEC_CONTENT_CHARS) {
    return { kind: "SPEC_TOO_LARGE", detail: `spec 파일이 너무 큽니다(최대 ${MAX_SPEC_CONTENT_CHARS}자, 현재 ${specContent.length}자): ${args.specFilePath}` };
  }

  const specVersion = args.specVersion ?? "1.0.0";
  const specHash = sha256Hex(specContent);
  const handoffId = deriveHandoffId(args.projectId);

  const envelope = {
    handoffId,
    spec: {
      projectId: args.projectId,
      projectName: args.projectName,
      specVersion,
      specStatus: "APPROVED" as const,
      userApproval: "PASS" as const,
      reviewerGate: { critical: 0, high: 0 },
      unresolvedCriticalCount: 0,
      contradictionCount: 0,
      specIntegrity: { algorithm: "sha256" as const, hash: specHash },
      specContent,
    },
  };

  const baseDir = resolve(args.baseDir ?? defaultBaseDir());
  try {
    mkdirSync(baseDir, { recursive: true });
  } catch (e) {
    return { kind: "BASE_DIR_ERROR", detail: `--base-dir을 만들 수 없습니다(${baseDir}): ${e instanceof Error ? e.message : String(e)}` };
  }

  const bootstrapConfig: BootstrapTrustedConfig = { bootstrapBaseDir: baseDir, ...deps.bootstrapConfigOverrides };
  const bootstrapOutcome: BootstrapOutcome = bootstrapProject(JSON.stringify(envelope), bootstrapConfig);

  let projectRoot: string;
  let baselineCommitHash: string | undefined;
  switch (bootstrapOutcome.status) {
    case "REJECTED":
      return { kind: "BOOTSTRAP_REJECTED", reasons: bootstrapOutcome.reasons };
    case "BLOCKED":
      return { kind: "BOOTSTRAP_BLOCKED", code: bootstrapOutcome.code, detail: bootstrapOutcome.detail };
    case "COLLISION":
      return {
        kind: "BOOTSTRAP_COLLISION",
        reason: bootstrapOutcome.reason,
        detail: bootstrapOutcome.detail,
        existingProjectRoot: bootstrapOutcome.existingProjectRoot,
      };
    case "CONFLICT":
      return {
        kind: "BOOTSTRAP_CONFLICT",
        detail:
          `${bootstrapOutcome.detail} 이 project-id는 이미 다른 내용의 spec으로 시작되었습니다 — ` +
          "새로운 --project-id를 쓰거나, 의도적으로 spec을 바꿨다면 --spec-version을 올려서 다시 실행하세요.",
      };
    case "WAITING_HUMAN":
      return { kind: "BOOTSTRAP_WAITING_HUMAN", detail: bootstrapOutcome.detail };
    case "ALREADY_BOOTSTRAPPED":
      projectRoot = bootstrapOutcome.projectRoot;
      baselineCommitHash = bootstrapOutcome.baselineCommitHash;
      break;
    case "COMPLETE":
      projectRoot = bootstrapOutcome.projectRoot;
      baselineCommitHash = bootstrapOutcome.baselineCommitHash;
      break;
  }

  const identity: BootstrapRequestIdentity = {
    handoffId,
    projectId: args.projectId,
    specVersion,
    specIntegrityAlgorithm: "sha256",
    specIntegrityHash: specHash,
  };

  const plannerOutcome: PlannerOutcome = await runPlanner(projectRoot, identity, deps.plannerConfig);

  switch (plannerOutcome.status) {
    case "BLOCKED":
      return { kind: "PLANNER_BLOCKED", code: plannerOutcome.code, detail: plannerOutcome.detail };
    case "CONFLICT":
      return { kind: "PLANNER_CONFLICT", detail: plannerOutcome.detail };
    case "REJECTED":
      return { kind: "PLANNER_REJECTED", issues: plannerOutcome.issues };
    case "HUMAN_REVIEW_REQUIRED":
      return {
        kind: "HUMAN_REVIEW_REQUIRED",
        projectRoot: plannerOutcome.projectRoot,
        projectManifestPath: plannerOutcome.projectManifestPath,
        fixedConstraintComplianceNote: plannerOutcome.fixedConstraintComplianceNote ?? "",
      };
    case "READY_FOR_AUTODEV":
    case "ALREADY_READY":
      break;
  }

  let persistedManifest: PersistedProjectManifestFile;
  let executionPolicy: ProjectExecutionPolicy;
  try {
    persistedManifest = JSON.parse(readFileSync(plannerOutcome.projectManifestPath, "utf-8")) as PersistedProjectManifestFile;
    executionPolicy = JSON.parse(readFileSync(plannerOutcome.executionPolicyPath, "utf-8")) as ProjectExecutionPolicy;
  } catch (e) {
    return { kind: "ADAPTER_ASSEMBLY_FAILED", detail: `planner 산출물을 읽는 중 오류가 발생했습니다: ${e instanceof Error ? e.message : String(e)}` };
  }

  const autodevDir = join(projectRoot, ".autodev");
  const adapterPath = join(autodevDir, "manifest.json");
  // project-adapter-loader.ts 스키마: targetProjectRoot는 이 config 파일(.autodev/manifest.json)
  // 자신의 위치 기준 상대경로이고, 오직 이 필드만 ".."을 허용한다 — projectRoot는 .autodev의
  // 부모이므로 항상 "..". statePath/taskRegistryPath는 같은 디렉터리 트리 안(".." 불가)이어야
  // 하므로 project-state.json/task-registry.json이라는 sibling 파일명 그대로 참조한다.
  const combinedAdapter = {
    projectId: persistedManifest.projectId,
    projectName: persistedManifest.projectName,
    targetProjectRoot: "..",
    statePath: "project-state.json",
    taskRegistryPath: "task-registry.json",
    developerInstructions: persistedManifest.developerInstructions,
    reviewInstructions: persistedManifest.reviewInstructions,
    reviewScopeDirs: persistedManifest.reviewScopeDirs,
    executionPolicy,
  };

  const statePath = join(autodevDir, "project-state.json");
  try {
    writeFileSync(adapterPath, JSON.stringify(combinedAdapter, null, 2) + "\n", "utf-8");
    // 이미 개발이 진행되어 project-state.json이 존재하면(재실행 시나리오) 절대 덮어쓰지
    // 않는다 — completedTasks/gitCheckpoint 등 실제 진행 상황을 조용히 초기화하는 것을
    // 막기 위함이다. 아직 없을 때(최초 실행)만 최소 유효 CoreState를 새로 만든다.
    if (!existsSync(statePath)) {
      const initialState: CoreState = {
        currentTask: null,
        reviewCycle: 0,
        lastClaudeResult: null,
        lastGptDecision: null,
        status: "IDLE",
        claudeLimitWaitCount: 0,
        deferredHumanTasks: [],
        completedTasks: [],
        gitCheckpoint: baselineCommitHash ?? "",
        currentPhase: 0,
      };
      writeFileSync(statePath, JSON.stringify(initialState, null, 2) + "\n", "utf-8");
    }
  } catch (e) {
    return { kind: "ADAPTER_ASSEMBLY_FAILED", detail: `adapter 파일 작성 중 오류가 발생했습니다: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 조립 직후 run.ts가 실제로 쓸 로더로 자체 검증한다 — 조립 실수를 "준비 완료"로 오인시키지
  // 않기 위함이다(loadProjectAdapter는 형식이 어긋나면 throw한다).
  try {
    loadProjectAdapter(adapterPath);
  } catch (e) {
    return { kind: "ADAPTER_ASSEMBLY_FAILED", detail: `조립된 adapter 자체 검증에 실패했습니다: ${e instanceof Error ? e.message : String(e)}` };
  }

  const startCommand = `powershell -ExecutionPolicy Bypass -File "${join(AUTODEV_ROOT, "start-autodev.ps1")}" -ProjectAdapter "${adapterPath}"`;
  return { kind: "READY", projectRoot, adapterPath, startCommand };
}

// ---------------------------------------------------------------------------
// CLI 배선 — run.ts와 동일한 관례(단순 process.argv indexOf 파싱, 얇은 main()).
// ---------------------------------------------------------------------------

export function parseCliArgs(argv: string[]): BootstrapAndRunArgs | { error: string } {
  function getFlag(name: string): string | undefined {
    const idx = argv.indexOf(name);
    if (idx === -1) return undefined;
    const value = argv[idx + 1];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  const specFilePath = getFlag("--spec-file");
  const projectId = getFlag("--project-id");
  const projectName = getFlag("--project-name");
  const baseDir = getFlag("--base-dir");
  const specVersion = getFlag("--spec-version");

  if (!specFilePath) return { error: "--spec-file <path>가 필요합니다." };
  if (!projectId) return { error: "--project-id <id>가 필요합니다." };
  if (!projectName) return { error: "--project-name <name>이 필요합니다." };

  return {
    specFilePath,
    projectId,
    projectName,
    ...(baseDir ? { baseDir } : {}),
    ...(specVersion ? { specVersion } : {}),
  };
}

export function formatResultForHuman(result: BootstrapAndRunResult): { message: string; exitCode: number } {
  switch (result.kind) {
    case "INVALID_ARGS":
      return { message: `[bootstrap-and-run] 잘못된 인자: ${result.detail}`, exitCode: 1 };
    case "SPEC_FILE_ERROR":
      return { message: `[bootstrap-and-run] spec 파일 오류: ${result.detail}`, exitCode: 1 };
    case "SPEC_TOO_LARGE":
      return { message: `[bootstrap-and-run] spec 파일이 너무 큽니다: ${result.detail}`, exitCode: 1 };
    case "BASE_DIR_ERROR":
      return { message: `[bootstrap-and-run] 프로젝트 저장 위치 오류: ${result.detail}`, exitCode: 1 };
    case "BOOTSTRAP_REJECTED":
      return {
        message: `[bootstrap-and-run] spec이 거부되었습니다:\n${result.reasons.map((r) => `  - (${r.code}) ${r.detail}`).join("\n")}`,
        exitCode: 1,
      };
    case "BOOTSTRAP_BLOCKED":
      return { message: `[bootstrap-and-run] 프로젝트 생성이 중단되었습니다(${result.code}): ${result.detail}`, exitCode: 1 };
    case "BOOTSTRAP_COLLISION":
      return {
        message: `[bootstrap-and-run] 이미 존재하는 경로와 충돌했습니다(${result.reason}): ${result.detail} (경로: ${result.existingProjectRoot})`,
        exitCode: 1,
      };
    case "BOOTSTRAP_CONFLICT":
      return { message: `[bootstrap-and-run] 충돌: ${result.detail}`, exitCode: 1 };
    case "BOOTSTRAP_WAITING_HUMAN":
      return {
        message:
          `[bootstrap-and-run] 사람 확인이 필요합니다: ${result.detail}\n` +
          "  git config --global user.name / user.email이 설정되어 있는지 확인한 뒤 다시 실행하세요.",
        exitCode: 1,
      };
    case "PLANNER_BLOCKED":
      return { message: `[bootstrap-and-run] 계획 수립이 중단되었습니다(${result.code}): ${result.detail}`, exitCode: 1 };
    case "PLANNER_CONFLICT":
      return { message: `[bootstrap-and-run] 계획 수립 충돌: ${result.detail}`, exitCode: 1 };
    case "PLANNER_REJECTED":
      return {
        message: `[bootstrap-and-run] 생성된 계획이 검증을 통과하지 못했습니다:\n${result.issues.map((i) => `  - (${i.code}) ${i.detail}`).join("\n")}`,
        exitCode: 1,
      };
    case "HUMAN_REVIEW_REQUIRED":
      return {
        message:
          `[bootstrap-and-run] 사람 검토가 필요합니다 — "절대 바꾸면 안 되는 제약(Fixed Constraint)"이 포함된 스펙이라, ` +
          "AI가 생성한 계획이 그 제약을 실제로 지키는지 자동으로 검증할 수 없습니다.\n" +
          `  생성된 계획: ${result.projectManifestPath}\n` +
          `  ${result.fixedConstraintComplianceNote}\n` +
          "  사람이 위 계획을 직접 검토해 제약 위반이 없는지 확인한 뒤, 이 도구를 다시 실행하지 말고 " +
          "필요하면 별도 절차로 adapter를 조립하세요.",
        exitCode: 1,
      };
    case "ADAPTER_ASSEMBLY_FAILED":
      return { message: `[bootstrap-and-run] 실행 설정 조립에 실패했습니다: ${result.detail}`, exitCode: 1 };
    case "READY":
      return {
        message:
          `[bootstrap-and-run] 준비 완료 — 프로젝트 폴더: ${result.projectRoot}\n` +
          `[bootstrap-and-run] 다음 명령으로 실제 개발을 시작하세요(검토 후 직접 실행):\n` +
          `  ${result.startCommand}`,
        exitCode: 0,
      };
  }
}

async function main(): Promise<void> {
  const parsed = parseCliArgs(process.argv.slice(2));
  if ("error" in parsed) {
    console.error(`[bootstrap-and-run] ${parsed.error}`);
    console.error(
      "사용법: npm run bootstrap -- --spec-file <path> --project-id <id> --project-name <name> " +
        "[--base-dir <dir>] [--spec-version <major.minor[.patch]>]"
    );
    process.exitCode = 1;
    return;
  }
  const result = await runBootstrapAndPlan(parsed);
  const { message, exitCode } = formatResultForHuman(result);
  if (exitCode === 0) console.log(message);
  else console.error(message);
  process.exitCode = exitCode;
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[bootstrap-and-run] 처리되지 않은 오류로 종료:", e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
