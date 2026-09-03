import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { loadProjectAdapter } from "./project-adapter-loader";
import { configureSafeExecutor, validateReadPath, validateWritePath } from "./safe-executor";
import { decideNextAction, runAutodevOnce, approveHumanFinalReview } from "./autodev";
import type { GptReviewerReturn } from "./orchestrator";
import type { ClaudeResult } from "./types";
import { deriveAllowedCommandsFromRequiredTests } from "./execution-contract";

// AutoDev 범용화 Phase C Task C1 — External Project Adapter를 data-only(JSON)로 전환한
// project-adapter-loader.ts 검증.
//
// 이 파일은 project-adapter-loader.ts(AutoDev Core)가 MOVAN을 포함해 어떤 프로젝트도
// 직접 알지 못한 채, 오직 "project config(JSON) 경로 → data로 읽기 → 검증 →
// ProjectManifest" 계약만으로 동작함을 증명한다. 핵심 증명은 이 파일이 만드는 project
// config가 전부 OS 임시 디렉터리의 순수 JSON 데이터 파일이며, 어떤 executable(.js 등)도
// AutoDev가 실행하지 않는다는 것이다(§ 시나리오 "malicious .js adapter").

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeJson(dir: string, fileName: string, data: unknown): string {
  const abs = join(dir, fileName);
  writeFileSync(abs, JSON.stringify(data, null, 2) + "\n", "utf-8");
  return abs;
}

function writeText(dir: string, fileName: string, content: string): string {
  const abs = join(dir, fileName);
  writeFileSync(abs, content, "utf-8");
  return abs;
}

const VALID_FIXTURE_TASK = {
  id: "F1",
  phase: 1,
  taskNumber: 1,
  title: "fixture task",
  prompt: "fixture prompt",
  requiredTests: [{ name: "fixture:test", command: "node", args: ["tests/run.js"], cwd: "root" }],
  allowedPathPrefixes: ["fixture/"],
  prohibitedOperations: ["외부 네트워크 호출"],
};

// ---------------------------------------------------------------------------
// A) adapter 경로 미지정(undefined/빈 문자열) — 즉시 실패, 어떤 프로젝트로도 fallback 없음.
// ---------------------------------------------------------------------------
function scenarioMissingAdapterPathFailsFast(): void {
  let threwOnUndefined = false;
  try {
    loadProjectAdapter(undefined);
  } catch {
    threwOnUndefined = true;
  }
  check("A) config 경로가 undefined면 즉시 실패", threwOnUndefined);

  let threwOnEmpty = false;
  try {
    loadProjectAdapter("   ");
  } catch {
    threwOnEmpty = true;
  }
  check("A) config 경로가 공백 문자열이면 즉시 실패", threwOnEmpty);
}

// ---------------------------------------------------------------------------
// B) 존재하지 않는 project config 경로 — 즉시 실패.
// ---------------------------------------------------------------------------
function scenarioNonexistentConfigPathFailsFast(): void {
  const dir = makeTempDir("autodev-adapter-loader-missing-");
  const nonexistent = join(dir, "does-not-exist.json");
  let threw = false;
  try {
    loadProjectAdapter(nonexistent);
  } catch {
    threw = true;
  }
  check("B) 존재하지 않는 project config 경로는 즉시 실패", threw);
}

// ---------------------------------------------------------------------------
// C) malformed JSON — 즉시 실패.
// ---------------------------------------------------------------------------
function scenarioMalformedJsonFailsFast(): void {
  const dir = makeTempDir("autodev-adapter-loader-malformed-json-");
  const configPath = writeText(dir, "manifest.json", "{ this is not valid JSON ");
  let threw = false;
  try {
    loadProjectAdapter(configPath);
  } catch {
    threw = true;
  }
  check("C) malformed JSON은 즉시 실패", threw);
}

// ---------------------------------------------------------------------------
// D) 필수 필드 없음 — 즉시 실패(permissive fallback 없음).
// ---------------------------------------------------------------------------
function scenarioMissingRequiredFieldsFailsFast(): void {
  const dir = makeTempDir("autodev-adapter-loader-missing-fields-");
  const configPath = writeJson(dir, "manifest.json", { projectId: "" });
  let threw = false;
  try {
    loadProjectAdapter(configPath);
  } catch {
    threw = true;
  }
  check("D) 필수 필드가 없는 project config는 즉시 실패", threw);
}

// ---------------------------------------------------------------------------
// E) 잘못된 task registry(필수 필드 누락) — 즉시 실패.
// ---------------------------------------------------------------------------
function scenarioInvalidTaskRegistryFailsFast(): void {
  const dir = makeTempDir("autodev-adapter-loader-bad-registry-");
  const fixtureRoot = makeTempDir("autodev-adapter-loader-bad-registry-root-");
  writeText(dir, "project-state.json", "{}\n");
  const configPath = writeJson(dir, "manifest.json", {
    projectId: "bad-registry-project",
    projectName: "Bad Registry Project",
    targetProjectRoot: relativeFromTo(dir, fixtureRoot),
    statePath: "project-state.json",
    taskRegistry: [{ id: "T1" /* phase/taskNumber/title/prompt/requiredTests/allowedPathPrefixes 누락 */ }],
    developerInstructions: "dev",
    reviewInstructions: "review",
    reviewScopeDirs: ["fixture/"],
    executionPolicy: {
      allowedReadPrefixes: ["fixture/"],
      allowedWritePrefixes: ["fixture/"],
      allowedCommands: [],
    },
  });
  let threw = false;
  try {
    loadProjectAdapter(configPath);
  } catch {
    threw = true;
  }
  check("E) 필수 필드가 누락된 taskRegistry 항목은 즉시 실패", threw);
}

// ---------------------------------------------------------------------------
// F) 잘못된 execution policy — 즉시 실패.
// ---------------------------------------------------------------------------
function scenarioInvalidExecutionPolicyFailsFast(): void {
  const dir = makeTempDir("autodev-adapter-loader-bad-policy-");
  const fixtureRoot = makeTempDir("autodev-adapter-loader-bad-policy-root-");
  const configPath = writeJson(dir, "manifest.json", {
    projectId: "bad-policy-project",
    projectName: "Bad Policy Project",
    targetProjectRoot: relativeFromTo(dir, fixtureRoot),
    statePath: "project-state.json",
    taskRegistry: [VALID_FIXTURE_TASK],
    developerInstructions: "dev",
    reviewInstructions: "review",
    reviewScopeDirs: ["fixture/"],
    executionPolicy: {
      allowedReadPrefixes: [], // 비어있음 — validateProjectExecutionPolicy가 거부해야 함
      allowedWritePrefixes: ["fixture/"],
      allowedCommands: [],
    },
  });
  let threw = false;
  try {
    loadProjectAdapter(configPath);
  } catch {
    threw = true;
  }
  check("F) 빈 allowedReadPrefixes를 가진 execution policy는 즉시 실패", threw);
}

// ---------------------------------------------------------------------------
// G) malformed regex(writeDenyPatterns) — 즉시 실패.
// ---------------------------------------------------------------------------
function scenarioMalformedRegexFailsFast(): void {
  const dir = makeTempDir("autodev-adapter-loader-bad-regex-");
  const fixtureRoot = makeTempDir("autodev-adapter-loader-bad-regex-root-");
  const configPath = writeJson(dir, "manifest.json", {
    projectId: "bad-regex-project",
    projectName: "Bad Regex Project",
    targetProjectRoot: relativeFromTo(dir, fixtureRoot),
    statePath: "project-state.json",
    taskRegistry: [VALID_FIXTURE_TASK],
    developerInstructions: "dev",
    reviewInstructions: "review",
    reviewScopeDirs: ["fixture/"],
    executionPolicy: {
      allowedReadPrefixes: ["fixture/"],
      allowedWritePrefixes: ["fixture/"],
      writeDenyPatterns: [{ pattern: "(unterminated[" }],
      allowedCommands: [],
    },
  });
  let threw = false;
  try {
    loadProjectAdapter(configPath);
  } catch {
    threw = true;
  }
  check("G) malformed regex pattern은 즉시 실패", threw);

  const dir2 = makeTempDir("autodev-adapter-loader-bad-flags-");
  const configPath2 = writeJson(dir2, "manifest.json", {
    projectId: "bad-flags-project",
    projectName: "Bad Flags Project",
    targetProjectRoot: relativeFromTo(dir2, fixtureRoot),
    statePath: "project-state.json",
    taskRegistry: [VALID_FIXTURE_TASK],
    developerInstructions: "dev",
    reviewInstructions: "review",
    reviewScopeDirs: ["fixture/"],
    executionPolicy: {
      allowedReadPrefixes: ["fixture/"],
      allowedWritePrefixes: ["fixture/"],
      writeDenyPatterns: [{ pattern: "^secret$", flags: "g" }], // 허용되지 않은 flags
      allowedCommands: [],
    },
  });
  let threwFlags = false;
  try {
    loadProjectAdapter(configPath2);
  } catch {
    threwFlags = true;
  }
  check("G) 허용되지 않은 regex flags는 즉시 실패", threwFlags);
}

// ---------------------------------------------------------------------------
// H) 존재하지 않는 targetProjectRoot — 즉시 실패.
// ---------------------------------------------------------------------------
function scenarioNonexistentTargetRootFailsFast(): void {
  const dir = makeTempDir("autodev-adapter-loader-bad-root-");
  const configPath = writeJson(dir, "manifest.json", {
    projectId: "bad-root-project",
    projectName: "Bad Root Project",
    targetProjectRoot: "does-not-exist-subdir",
    statePath: "project-state.json",
    taskRegistry: [VALID_FIXTURE_TASK],
    developerInstructions: "dev",
    reviewInstructions: "review",
    reviewScopeDirs: ["fixture/"],
    executionPolicy: {
      allowedReadPrefixes: ["fixture/"],
      allowedWritePrefixes: ["fixture/"],
      allowedCommands: [],
    },
  });
  let threw = false;
  try {
    loadProjectAdapter(configPath);
  } catch {
    threw = true;
  }
  check("H) 존재하지 않는 targetProjectRoot는 즉시 실패", threw);
}

// ---------------------------------------------------------------------------
// I) 허용되지 않은 executable adapter(.js) — 즉시 실패, 그리고 실제로 실행되지 않는다.
//
// 이 시나리오가 이번 Task의 핵심 증명이다: 악의적인 adapter .js 파일을 만들어 그 경로를
// loadProjectAdapter에 넘겼을 때, (a) 즉시 실패하고 (b) 그 .js 파일의 최상위 코드(module
// 로드 시점에 실행되는 side effect)가 전혀 실행되지 않아야 한다 — 이전 구조(require())라면
// 이 시점에 이미 파일이 생성됐을 것이다.
// ---------------------------------------------------------------------------
function scenarioMaliciousJsAdapterNeverExecutes(): void {
  const dir = makeTempDir("autodev-adapter-loader-malicious-");
  const proofPath = join(dir, "proof-of-execution.txt");
  const maliciousJs = [
    "'use strict';",
    "// 이 파일이 require()/import()/eval 등으로 실행되면 즉시 proof 파일을 만든다.",
    `require('node:fs').writeFileSync(${JSON.stringify(proofPath)}, 'EXECUTED');`,
    "function createProjectManifest() {",
    "  return { projectId: 'malicious', projectName: 'Malicious', taskRegistry: [] };",
    "}",
    "module.exports = { createProjectManifest };",
  ].join("\n");
  const maliciousPath = writeText(dir, "malicious-adapter.js", maliciousJs);

  let threw = false;
  let message = "";
  try {
    loadProjectAdapter(maliciousPath);
  } catch (e) {
    threw = true;
    message = e instanceof Error ? e.message : String(e);
  }
  check("I) .js adapter는 즉시 실패(확장자 거부)", threw);
  check("I) 실패 메시지가 JSON/.json 요구사항을 언급함", /\.json/i.test(message));
  check("I) malicious .js adapter의 코드가 전혀 실행되지 않음(proof 파일 미생성)", !existsSync(proofPath));

  // 다른 executable 확장자(.cjs/.mjs/.ts)도 동일하게 거부되는지 확인.
  for (const ext of [".cjs", ".mjs", ".ts"]) {
    const p = writeText(dir, `adapter${ext}`, "module.exports = {};");
    let threwExt = false;
    try {
      loadProjectAdapter(p);
    } catch {
      threwExt = true;
    }
    check(`I) ${ext} adapter도 즉시 실패(확장자 거부)`, threwExt);
  }
}

// ---------------------------------------------------------------------------
// J) taskRegistry/taskRegistryPath 둘 다 지정하거나 둘 다 없으면 즉시 실패.
// ---------------------------------------------------------------------------
function scenarioTaskRegistrySourceAmbiguityFailsFast(): void {
  const dir = makeTempDir("autodev-adapter-loader-registry-ambiguous-");
  const fixtureRoot = makeTempDir("autodev-adapter-loader-registry-ambiguous-root-");
  const base = {
    projectId: "ambiguous-project",
    projectName: "Ambiguous Project",
    targetProjectRoot: relativeFromTo(dir, fixtureRoot),
    statePath: "project-state.json",
    developerInstructions: "dev",
    reviewInstructions: "review",
    reviewScopeDirs: ["fixture/"],
    executionPolicy: { allowedReadPrefixes: ["fixture/"], allowedWritePrefixes: ["fixture/"], allowedCommands: [] },
  };
  const neitherPath = writeJson(dir, "neither.json", base);
  let threwNeither = false;
  try {
    loadProjectAdapter(neitherPath);
  } catch {
    threwNeither = true;
  }
  check("J) taskRegistry/taskRegistryPath 둘 다 없으면 즉시 실패", threwNeither);

  const bothPath = writeJson(dir, "both.json", { ...base, taskRegistry: [VALID_FIXTURE_TASK], taskRegistryPath: "task-registry.json" });
  writeJson(dir, "task-registry.json", [VALID_FIXTURE_TASK]);
  let threwBoth = false;
  try {
    loadProjectAdapter(bothPath);
  } catch {
    threwBoth = true;
  }
  check("J) taskRegistry/taskRegistryPath를 동시에 지정하면 즉시 실패", threwBoth);
}

// ---------------------------------------------------------------------------
// K) targetProjectRoot의 경로 escape — 절대경로/드라이브경로/UNC 경로는 즉시 실패.
// ---------------------------------------------------------------------------
function scenarioPathEscapeFailsFast(): void {
  const dir = makeTempDir("autodev-adapter-loader-escape-");
  const base = {
    projectId: "escape-project",
    projectName: "Escape Project",
    statePath: "project-state.json",
    taskRegistry: [VALID_FIXTURE_TASK],
    developerInstructions: "dev",
    reviewInstructions: "review",
    reviewScopeDirs: ["fixture/"],
    executionPolicy: { allowedReadPrefixes: ["fixture/"], allowedWritePrefixes: ["fixture/"], allowedCommands: [] },
  };

  const absPath = writeJson(dir, "abs.json", { ...base, targetProjectRoot: "C:\\Windows" });
  let threwAbs = false;
  try {
    loadProjectAdapter(absPath);
  } catch {
    threwAbs = true;
  }
  check("K) targetProjectRoot에 드라이브 절대경로를 쓰면 즉시 실패", threwAbs);

  const uncPath = writeJson(dir, "unc.json", { ...base, targetProjectRoot: "\\\\server\\share" });
  let threwUnc = false;
  try {
    loadProjectAdapter(uncPath);
  } catch {
    threwUnc = true;
  }
  check("K) targetProjectRoot에 UNC 경로를 쓰면 즉시 실패", threwUnc);

  // statePath는 ".."을 전혀 허용하지 않는다(같은 디렉터리 트리 안이어야 함).
  const stateEscapePath = writeJson(dir, "state-escape.json", { ...base, targetProjectRoot: ".", statePath: "../../outside.json" });
  let threwStateEscape = false;
  try {
    loadProjectAdapter(stateEscapePath);
  } catch {
    threwStateEscape = true;
  }
  check("K) statePath에 \"..\"을 쓰면 즉시 실패", threwStateEscape);
}

// ---------------------------------------------------------------------------
// L) 유효한 fixture project config를 명시적으로 주입하면 정상적으로 ProjectManifest를
//    얻는다(MOVAN이 아닌 임의의 fixture 프로젝트로도 동일하게 동작함을 증명). 이어서
//    Safe Executor/decideNextAction에 실제로 주입해 end-to-end로 동작함을 확인한다.
// ---------------------------------------------------------------------------
function scenarioValidFixtureConfigLoadsSuccessfully(): void {
  const dir = makeTempDir("autodev-adapter-loader-valid-");
  writeJson(dir, "task-registry.json", [VALID_FIXTURE_TASK]);
  const configPath = writeJson(dir, "manifest.json", {
    projectId: "fixture-adapter-project",
    projectName: "Fixture Adapter Project",
    targetProjectRoot: ".",
    statePath: "project-state.json",
    taskRegistryPath: "task-registry.json",
    developerInstructions: "fixture adapter developer instructions",
    reviewInstructions: "fixture adapter review instructions",
    reviewScopeDirs: ["fixture/"],
    rulesPath: "rules.md",
    executionPolicy: {
      allowedReadPrefixes: ["fixture/"],
      allowedWritePrefixes: ["fixture/"],
      writeDenyPatterns: [{ pattern: "^fixture/secret\\.txt$" }],
      allowedCommands: [],
    },
  });
  writeText(dir, "project-state.json", "{}\n");

  const manifest = loadProjectAdapter(configPath);
  check("L) 유효한 fixture project config가 정상적으로 ProjectManifest를 반환함", manifest.projectId === "fixture-adapter-project");
  check("L) 반환된 manifest.targetProjectRoot가 project config 자신의 위치 기준으로 계산됨", manifest.targetProjectRoot === dir);
  check("L) taskRegistryPath로 지정한 외부 파일에서 taskRegistry가 로드됨", manifest.taskRegistry.length === 1 && manifest.taskRegistry[0].id === "F1");
  check(
    "L) writeDenyPatterns가 실제 RegExp 인스턴스로 컴파일됨",
    Array.isArray(manifest.executionPolicy.writeDenyPatterns) &&
      manifest.executionPolicy.writeDenyPatterns.every((p) => p instanceof RegExp)
  );
  check("L) 반환된 manifest에 MOVAN 관련 필드가 전혀 없음", !JSON.stringify(manifest, (_k, v) => (v instanceof RegExp ? v.source : v)).includes("MOVAN"));

  // end-to-end — Safe Executor에 실제로 주입해 read/write 권한이 이 정책대로 강제되는지,
  // decideNextAction이 이 taskRegistry만으로 다음 task를 고르는지 확인한다(§ 요구사항 14/15).
  configureSafeExecutor(manifest.targetProjectRoot, manifest.executionPolicy);
  check("L) [E2E] fixture/ 하위 read 허용", validateReadPath("fixture/x.txt").ok === true);
  check("L) [E2E] fixture/ 밖 write 거부", validateWritePath("other/x.txt").ok === false);
  check("L) [E2E] writeDenyPatterns로 지정한 fixture/secret.txt write 거부", validateWritePath("fixture/secret.txt").ok === false);

  const decision = decideNextAction(
    { currentTask: null, reviewCycle: 0, lastClaudeResult: null, lastGptDecision: null, status: "READY", claudeLimitWaitCount: 0, deferredHumanTasks: [], completedTasks: [], gitCheckpoint: "", currentPhase: 1 },
    manifest.taskRegistry
  );
  check("L) [E2E] decideNextAction이 이 fixture taskRegistry만으로 F1을 선택함", decision.kind === "RUN_TASK" && decision.task.id === "F1");
}

function relativeFromTo(fromDir: string, toDir: string): string {
  return relative(fromDir, toDir).split(sep).join("/");
}

// ---------------------------------------------------------------------------
// M~T) Phase G Task G7.3.1a — Project Adapter RemoteGitSafety Passthrough Fix.
//
// project-adapter-loader.ts가 raw project config(.autodev/manifest.json)의 remoteGitSafety
// 필드를 ProjectManifest로 전달하지 않아, 실제 run.ts → loadProjectAdapter() production
// 경로에서 manifest.remoteGitSafety가 항상 undefined였던 data-path gap을 고정한다.
// ---------------------------------------------------------------------------
function baseRemoteGitSafetyConfigFields(dir: string, fixtureRoot: string): Record<string, unknown> {
  return {
    projectId: "rgs-passthrough-project",
    projectName: "RGS Passthrough Project",
    targetProjectRoot: relativeFromTo(dir, fixtureRoot),
    statePath: "project-state.json",
    taskRegistry: [VALID_FIXTURE_TASK],
    developerInstructions: "dev",
    reviewInstructions: "review",
    reviewScopeDirs: ["fixture/"],
    executionPolicy: { allowedReadPrefixes: ["fixture/"], allowedWritePrefixes: ["fixture/"], allowedCommands: [] },
  };
}

function scenarioRemoteGitSafetyAbsentIsUndefined(): void {
  const dir = makeTempDir("autodev-adapter-loader-rgs-absent-");
  const fixtureRoot = makeTempDir("autodev-adapter-loader-rgs-absent-root-");
  const configPath = writeJson(dir, "manifest.json", baseRemoteGitSafetyConfigFields(dir, fixtureRoot));
  const manifest = loadProjectAdapter(configPath);
  check("M) remoteGitSafety가 없는 project config → manifest.remoteGitSafety === undefined(backward compatible)", manifest.remoteGitSafety === undefined);
}

function scenarioRemoteGitSafetyValidPassesThrough(): void {
  const dir = makeTempDir("autodev-adapter-loader-rgs-valid-");
  const fixtureRoot = makeTempDir("autodev-adapter-loader-rgs-valid-root-");
  const configPath = writeJson(dir, "manifest.json", {
    ...baseRemoteGitSafetyConfigFields(dir, fixtureRoot),
    remoteGitSafety: { remoteName: "upstream", expectedBranch: "release" },
  });
  const manifest = loadProjectAdapter(configPath);
  check("N) valid remoteGitSafety가 loader 결과(ProjectManifest)에 그대로 존재함", manifest.remoteGitSafety !== undefined);
  check("N) remoteGitSafety.remoteName이 그대로 passthrough됨", manifest.remoteGitSafety?.remoteName === "upstream");
  check("N) remoteGitSafety.expectedBranch가 그대로 passthrough됨", manifest.remoteGitSafety?.expectedBranch === "release");

  const dir2 = makeTempDir("autodev-adapter-loader-rgs-partial-");
  const configPath2 = writeJson(dir2, "manifest.json", {
    ...baseRemoteGitSafetyConfigFields(dir2, fixtureRoot),
    remoteGitSafety: {},
  });
  const manifest2 = loadProjectAdapter(configPath2);
  check("N) remoteGitSafety={}(필드 전부 optional)도 정상적으로 로드되어 존재함", manifest2.remoteGitSafety !== undefined);
  check("N) 지정하지 않은 remoteName은 undefined로 유지됨(호출부 DEFAULT_REMOTE_NAME 책임)", manifest2.remoteGitSafety?.remoteName === undefined);
}

function scenarioRemoteGitSafetyInvalidRemoteNameFailsFast(): void {
  const fixtureRoot = makeTempDir("autodev-adapter-loader-rgs-bad-remote-root-");

  const dir1 = makeTempDir("autodev-adapter-loader-rgs-bad-remote-empty-");
  const configPath1 = writeJson(dir1, "manifest.json", {
    ...baseRemoteGitSafetyConfigFields(dir1, fixtureRoot),
    remoteGitSafety: { remoteName: "" },
  });
  let threwEmpty = false;
  try {
    loadProjectAdapter(configPath1);
  } catch {
    threwEmpty = true;
  }
  check("P) remoteGitSafety.remoteName이 빈 문자열이면 즉시 실패(fail-closed, silent disable 아님)", threwEmpty);

  const dir2 = makeTempDir("autodev-adapter-loader-rgs-bad-remote-type-");
  const configPath2 = writeJson(dir2, "manifest.json", {
    ...baseRemoteGitSafetyConfigFields(dir2, fixtureRoot),
    remoteGitSafety: { remoteName: 123 },
  });
  let threwType = false;
  try {
    loadProjectAdapter(configPath2);
  } catch {
    threwType = true;
  }
  check("P) remoteGitSafety.remoteName이 문자열이 아니면 즉시 실패(fail-closed)", threwType);
}

function scenarioRemoteGitSafetyInvalidExpectedBranchFailsFast(): void {
  const fixtureRoot = makeTempDir("autodev-adapter-loader-rgs-bad-branch-root-");

  const dir1 = makeTempDir("autodev-adapter-loader-rgs-bad-branch-empty-");
  const configPath1 = writeJson(dir1, "manifest.json", {
    ...baseRemoteGitSafetyConfigFields(dir1, fixtureRoot),
    remoteGitSafety: { expectedBranch: "" },
  });
  let threwEmpty = false;
  try {
    loadProjectAdapter(configPath1);
  } catch {
    threwEmpty = true;
  }
  check("Q) remoteGitSafety.expectedBranch가 빈 문자열이면 즉시 실패(fail-closed)", threwEmpty);

  const dir2 = makeTempDir("autodev-adapter-loader-rgs-bad-branch-type-");
  const configPath2 = writeJson(dir2, "manifest.json", {
    ...baseRemoteGitSafetyConfigFields(dir2, fixtureRoot),
    remoteGitSafety: { expectedBranch: 42 },
  });
  let threwType = false;
  try {
    loadProjectAdapter(configPath2);
  } catch {
    threwType = true;
  }
  check("Q) remoteGitSafety.expectedBranch가 문자열이 아니면 즉시 실패(fail-closed)", threwType);
}

function scenarioRemoteGitSafetyInvalidShapeFailsClosed(): void {
  const fixtureRoot = makeTempDir("autodev-adapter-loader-rgs-bad-shape-root-");
  const badValues: unknown[] = ["origin", 123, ["origin"], null];
  for (let i = 0; i < badValues.length; i++) {
    const dir = makeTempDir(`autodev-adapter-loader-rgs-bad-shape-${i}-`);
    const configPath = writeJson(dir, "manifest.json", {
      ...baseRemoteGitSafetyConfigFields(dir, fixtureRoot),
      remoteGitSafety: badValues[i],
    });
    let threw = false;
    try {
      loadProjectAdapter(configPath);
    } catch {
      threw = true;
    }
    check(`R) remoteGitSafety가 object shape이 아니면(${JSON.stringify(badValues[i])}) 즉시 실패(fail-closed)`, threw);
  }
}

function scenarioRemoteGitSafetyValidConfigPassesManifestValidation(): void {
  const dir = makeTempDir("autodev-adapter-loader-rgs-manifest-valid-");
  const fixtureRoot = makeTempDir("autodev-adapter-loader-rgs-manifest-valid-root-");
  const configPath = writeJson(dir, "manifest.json", {
    ...baseRemoteGitSafetyConfigFields(dir, fixtureRoot),
    remoteGitSafety: { remoteName: "origin", expectedBranch: "main" },
  });
  let threw = false;
  let manifestOk = false;
  try {
    const manifest = loadProjectAdapter(configPath);
    manifestOk = manifest.projectId === "rgs-passthrough-project";
  } catch {
    threw = true;
  }
  check("S) valid remoteGitSafety를 포함한 manifest가 validateProjectManifest()를 그대로 통과함(예외 없음)", !threw && manifestOk);
}

// T) [E2E] loader가 반환한 manifest.remoteGitSafety를 실제 runAutodevOnce()가 사용하는지
//    확인한다 — remote가 없는 temp git repo이므로 Gate가 NO_REMOTE로 fail-closed BLOCK한다
//    (실제 GitHub remote/네트워크 호출 없음). Claude worker가 호출되면 안 된다는 것까지 함께
//    증명한다(Gate가 loadState/orchestrator보다 먼저 막는다 — § autodev.ts).
async function scenarioRemoteGitSafetyVisibleToRunAutodevOnce(): Promise<void> {
  const dir = makeTempDir("autodev-adapter-loader-rgs-e2e-");
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "autodev-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "AutoDev Test"], { cwd: dir });
  writeText(dir, ".gitkeep", "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

  writeJson(dir, "task-registry.json", [VALID_FIXTURE_TASK]);
  writeJson(dir, "project-state.json", {
    currentPhase: 1,
    gitCheckpoint: "test",
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "READY",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
  });
  const configPath = writeJson(dir, "manifest.json", {
    projectId: "rgs-e2e-project",
    projectName: "RGS E2E Project",
    targetProjectRoot: ".",
    statePath: "project-state.json",
    taskRegistryPath: "task-registry.json",
    developerInstructions: "dev",
    reviewInstructions: "review",
    reviewScopeDirs: ["fixture/"],
    executionPolicy: { allowedReadPrefixes: ["fixture/"], allowedWritePrefixes: ["fixture/"], allowedCommands: [] },
    remoteGitSafety: {},
  });

  const manifest = loadProjectAdapter(configPath);
  check("T) [E2E] loader 결과에 remoteGitSafety가 존재함(runAutodevOnce에 넘기기 전 사전조건)", manifest.remoteGitSafety !== undefined);

  let claudeCalls = 0;
  const claudeRunner = async (): Promise<ClaudeResult> => {
    claudeCalls += 1;
    return { success: true, summary: "호출되면 안 됨", changedFiles: [], tests: [], rawOutput: "" };
  };
  const result = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner } });
  check(
    "T) [E2E] loader→runAutodevOnce data path: remote가 없으면 outcome=BLOCKED_REMOTE_GIT(Gate가 실제로 remoteGitSafety를 봄)",
    result.outcome === "BLOCKED_REMOTE_GIT"
  );
  check("T) [E2E] Gate가 막았으므로 Claude worker가 전혀 호출되지 않음", claudeCalls === 0);
}

// ---------------------------------------------------------------------------
// U~Z) Generic HUMAN_FINAL_REVIEW opt-in — project config의 humanFinalReviewPolicy 필드가
// project-adapter-loader.ts를 거쳐 실제 ProjectManifest.humanFinalReviewPolicy로 전달되는지
// 검증한다(§ buildRemoteGitSafetyFromData와 동일한 data-path passthrough 관례).
// ---------------------------------------------------------------------------
function fakePassReviewerForHfr(): () => Promise<GptReviewerReturn> {
  return async () => ({ decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "테스트: 문제 없음", nextTask: null });
}

function scenarioHumanFinalReviewPolicyAbsentIsUndefined(): void {
  const dir = makeTempDir("autodev-adapter-loader-hfr-absent-");
  const fixtureRoot = makeTempDir("autodev-adapter-loader-hfr-absent-root-");
  const configPath = writeJson(dir, "manifest.json", baseRemoteGitSafetyConfigFields(dir, fixtureRoot));
  const manifest = loadProjectAdapter(configPath);
  check(
    "U) humanFinalReviewPolicy가 없는 project config → manifest.humanFinalReviewPolicy === undefined(backward compatible, 기본 OFF)",
    manifest.humanFinalReviewPolicy === undefined
  );
}

function scenarioHumanFinalReviewPolicyValidPassesThrough(): void {
  const dir = makeTempDir("autodev-adapter-loader-hfr-valid-");
  const fixtureRoot = makeTempDir("autodev-adapter-loader-hfr-valid-root-");
  const configPath = writeJson(dir, "manifest.json", {
    ...baseRemoteGitSafetyConfigFields(dir, fixtureRoot),
    humanFinalReviewPolicy: { enabled: true },
  });
  const manifest = loadProjectAdapter(configPath);
  check("V) humanFinalReviewPolicy={enabled:true}가 loader 결과(ProjectManifest)에 그대로 존재함", manifest.humanFinalReviewPolicy !== undefined);
  check("V) humanFinalReviewPolicy.enabled=true가 그대로 passthrough됨", manifest.humanFinalReviewPolicy?.enabled === true);

  const dir2 = makeTempDir("autodev-adapter-loader-hfr-false-");
  const configPath2 = writeJson(dir2, "manifest.json", {
    ...baseRemoteGitSafetyConfigFields(dir2, fixtureRoot),
    humanFinalReviewPolicy: { enabled: false },
  });
  const manifest2 = loadProjectAdapter(configPath2);
  check("V) humanFinalReviewPolicy={enabled:false}도 정상적으로 로드되어 존재함(명시적 OFF)", manifest2.humanFinalReviewPolicy !== undefined);
  check("V) humanFinalReviewPolicy.enabled=false가 그대로 passthrough됨", manifest2.humanFinalReviewPolicy?.enabled === false);
}

function scenarioHumanFinalReviewPolicyInvalidEnabledFailsFast(): void {
  const fixtureRoot = makeTempDir("autodev-adapter-loader-hfr-bad-enabled-root-");
  const dir = makeTempDir("autodev-adapter-loader-hfr-bad-enabled-");
  const configPath = writeJson(dir, "manifest.json", {
    ...baseRemoteGitSafetyConfigFields(dir, fixtureRoot),
    humanFinalReviewPolicy: { enabled: "yes" },
  });
  let threw = false;
  try {
    loadProjectAdapter(configPath);
  } catch {
    threw = true;
  }
  check("W) humanFinalReviewPolicy.enabled가 boolean이 아니면 즉시 실패(fail-closed)", threw);
}

function scenarioHumanFinalReviewPolicyInvalidShapeFailsClosed(): void {
  const fixtureRoot = makeTempDir("autodev-adapter-loader-hfr-bad-shape-root-");
  const badValues: unknown[] = ["true", 1, [true], null];
  for (let i = 0; i < badValues.length; i++) {
    const dir = makeTempDir(`autodev-adapter-loader-hfr-bad-shape-${i}-`);
    const configPath = writeJson(dir, "manifest.json", {
      ...baseRemoteGitSafetyConfigFields(dir, fixtureRoot),
      humanFinalReviewPolicy: badValues[i],
    });
    let threw = false;
    try {
      loadProjectAdapter(configPath);
    } catch {
      threw = true;
    }
    check(`X) humanFinalReviewPolicy가 object shape이 아니면(${JSON.stringify(badValues[i])}) 즉시 실패(fail-closed)`, threw);
  }
}

// Y) [E2E] loader가 반환한 manifest.humanFinalReviewPolicy를 실제 runAutodevOnce()가
//    사용하는지 확인한다 — enabled:true인 project config에서는 reviewer APPROVED 직후
//    checkpoint 대신 RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW로 멈추고, 사람이 명시적으로
//    APPROVE한 뒤에만 checkpoint까지 이어진다(§ autodev.ts isHumanFinalReviewEnabled).
async function scenarioHumanFinalReviewPolicyVisibleToRunAutodevOnce(): Promise<void> {
  const dir = makeTempDir("autodev-adapter-loader-hfr-e2e-");
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "autodev-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "AutoDev Test"], { cwd: dir });
  writeText(dir, ".gitkeep", "");

  writeJson(dir, "task-registry.json", [VALID_FIXTURE_TASK]);
  writeJson(dir, "project-state.json", {
    currentPhase: 1,
    gitCheckpoint: "test",
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "READY",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
  });
  const statePath = join(dir, "project-state.json");
  const configPath = writeJson(dir, "manifest.json", {
    projectId: "hfr-e2e-project",
    projectName: "HFR E2E Project",
    targetProjectRoot: ".",
    statePath: "project-state.json",
    taskRegistryPath: "task-registry.json",
    developerInstructions: "dev",
    reviewInstructions: "review",
    reviewScopeDirs: ["fixture/"],
    // Hardening A(Execution Contract를 Runtime 불변조건으로) — 이 시나리오는 실제로
    // runAutodevOnce()까지 도달해 checkpoint를 완료하므로(§ E2E), allowedCommands가
    // VALID_FIXTURE_TASK.requiredTests와 exact-match해야 autodev.ts의 runtime
    // execution-contract 재검증을 통과한다(실제 spec-planner.ts 산출물과 동일하게).
    executionPolicy: {
      allowedReadPrefixes: ["fixture/"],
      allowedWritePrefixes: ["fixture/"],
      allowedCommands: deriveAllowedCommandsFromRequiredTests([{ taskId: VALID_FIXTURE_TASK.id, requiredTests: VALID_FIXTURE_TASK.requiredTests }]),
    },
    humanFinalReviewPolicy: { enabled: true },
  });
  // manifest.json/task-registry.json/project-state.json은 이 fixture project의 project-state
  // bookkeeping 파일이지 F1 task가 만드는 산출물이 아니다 — task의 allowedPathPrefixes(fixture/)
  // 밖에 있으므로, checkpoint.ts의 범위 재검증이 "예상치 못한 변경"으로 BLOCK하지 않도록 init
  // commit에 미리 포함시킨다(§ 다른 E2E 시나리오와 달리 이 시나리오는 실제로 checkpoint까지
  // 도달하므로, RGS E2E 시나리오에는 없던 이 문제가 여기서 처음 드러난다).
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

  const manifest = loadProjectAdapter(configPath);
  check("Y) [E2E] loader 결과에 humanFinalReviewPolicy가 존재함(runAutodevOnce에 넘기기 전 사전조건)", manifest.humanFinalReviewPolicy?.enabled === true);

  const claudeRunner = async (): Promise<ClaudeResult> => {
    mkdirSync(join(dir, "fixture"), { recursive: true });
    writeText(join(dir, "fixture"), "marker.txt", "marker\n");
    return { success: true, summary: "테스트", changedFiles: ["fixture/marker.txt"], tests: [{ name: "fixture:test", pass: true }], rawOutput: "" };
  };
  const firstResult = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: fakePassReviewerForHfr() } });
  check(
    "Y) [E2E] loader→runAutodevOnce data path: humanFinalReviewPolicy.enabled=true → outcome=RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW(즉시 checkpoint 아님)",
    firstResult.outcome === "RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW"
  );

  const approval = approveHumanFinalReview(statePath, "F1");
  check("Y) [E2E] approveHumanFinalReview ok=true", approval.ok === true);
  const result = await runAutodevOnce({ manifest });
  check("Y) [E2E] 사람 APPROVE 후 resume outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
}

// ---------------------------------------------------------------------------
// Z) AutoDev Core Maintenance(2026-09-03, RevenueOS Task 2.5 실전 재발 방지) —
//    task-registry.ts TaskDefinition.requiresHumanReview Passthrough Fix.
//    buildTaskDefinitionFromData()가 이 필드를 알려진 key 목록에 추가하지 않아 조용히
//    드롭했다 — task-registry.json에 requiresHumanReview:true를 직접 지정해도 실제
//    production 경로(project-adapter-loader.ts → runAutodevOnce)에서는 항상 undefined로
//    도착했다(§ M~T RemoteGitSafety Passthrough Fix와 정확히 같은 클래스의 data-path
//    gap — 이번엔 실제 RevenueOS 운영 환경에서 재현됨: task-registry.json에는
//    requiresHumanReview:true가 있었지만 GPT reviewer가 계속 실제로 호출됐다). 이
//    섹션이 그 회귀를 고정한다.
// ---------------------------------------------------------------------------
function baseTaskRegistryPathConfigFields(projectId: string): Record<string, unknown> {
  return {
    projectId,
    projectName: projectId,
    targetProjectRoot: ".",
    statePath: "project-state.json",
    taskRegistryPath: "task-registry.json",
    developerInstructions: "dev",
    reviewInstructions: "review",
    reviewScopeDirs: ["fixture/"],
    executionPolicy: { allowedReadPrefixes: ["fixture/"], allowedWritePrefixes: ["fixture/"], allowedCommands: [] },
  };
}

function scenarioRequiresHumanReviewAbsentIsUndefined(): void {
  const dir = makeTempDir("autodev-adapter-loader-rhr-absent-");
  writeJson(dir, "task-registry.json", [VALID_FIXTURE_TASK]);
  const configPath = writeJson(dir, "manifest.json", baseTaskRegistryPathConfigFields("rhr-absent-project"));
  writeText(dir, "project-state.json", "{}\n");
  const manifest = loadProjectAdapter(configPath);
  check(
    "Z) requiresHumanReview가 없는 task → manifest.taskRegistry[0].requiresHumanReview === undefined(backward compatible, 기본 false와 동일)",
    manifest.taskRegistry[0].requiresHumanReview === undefined
  );
}

function scenarioRequiresHumanReviewValidPassesThrough(): void {
  const dir = makeTempDir("autodev-adapter-loader-rhr-valid-");
  writeJson(dir, "task-registry.json", [{ ...VALID_FIXTURE_TASK, requiresHumanReview: true }]);
  const configPath = writeJson(dir, "manifest.json", baseTaskRegistryPathConfigFields("rhr-valid-project"));
  writeText(dir, "project-state.json", "{}\n");
  const manifest = loadProjectAdapter(configPath);
  check(
    "Z) requiresHumanReview:true인 외부 task-registry.json → loader가 반환한 taskRegistry[0].requiresHumanReview에 그대로 존재함(핵심 회귀 — RevenueOS에서 이 값이 실제로 드롭됐었음)",
    manifest.taskRegistry[0].requiresHumanReview === true
  );

  const dir2 = makeTempDir("autodev-adapter-loader-rhr-false-");
  writeJson(dir2, "task-registry.json", [{ ...VALID_FIXTURE_TASK, requiresHumanReview: false }]);
  const configPath2 = writeJson(dir2, "manifest.json", baseTaskRegistryPathConfigFields("rhr-false-project"));
  writeText(dir2, "project-state.json", "{}\n");
  const manifest2 = loadProjectAdapter(configPath2);
  check("Z) requiresHumanReview:false도 명시적으로 그대로 passthrough됨", manifest2.taskRegistry[0].requiresHumanReview === false);
}

function scenarioRequiresHumanReviewInvalidShapeFailsFast(): void {
  const badValues: unknown[] = ["true", 1, [true], null];
  for (let i = 0; i < badValues.length; i++) {
    const dir = makeTempDir(`autodev-adapter-loader-rhr-bad-${i}-`);
    writeJson(dir, "task-registry.json", [{ ...VALID_FIXTURE_TASK, requiresHumanReview: badValues[i] }]);
    const configPath = writeJson(dir, "manifest.json", baseTaskRegistryPathConfigFields(`rhr-bad-project-${i}`));
    writeText(dir, "project-state.json", "{}\n");
    let threw = false;
    try {
      loadProjectAdapter(configPath);
    } catch {
      threw = true;
    }
    check(`Z) requiresHumanReview가 boolean이 아니면(${JSON.stringify(badValues[i])}) 즉시 실패(fail-closed)`, threw);
  }
}

// [E2E] loader가 반환한 taskRegistry[].requiresHumanReview가 실제 runAutodevOnce()에서
// GPT reviewer 호출을 생략하고(0 calls) Human Final Review Gate로 직행시키는지 —
// manifest.humanFinalReviewPolicy 없이도(§ 위 Y와 달리 project-wide opt-in이 전혀 없다).
// 정확히 RevenueOS Task 2.5가 실제로 겪은 data path(loadProjectAdapter → runAutodevOnce)를
// 그대로 재현한다.
async function scenarioRequiresHumanReviewVisibleToRunAutodevOnce(): Promise<void> {
  const dir = makeTempDir("autodev-adapter-loader-rhr-e2e-");
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "autodev-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "AutoDev Test"], { cwd: dir });
  writeText(dir, ".gitkeep", "");

  const rhrTask = { ...VALID_FIXTURE_TASK, requiresHumanReview: true };
  writeJson(dir, "task-registry.json", [rhrTask]);
  writeJson(dir, "project-state.json", {
    currentPhase: 1,
    gitCheckpoint: "test",
    currentTask: null,
    reviewCycle: 0,
    lastClaudeResult: null,
    lastGptDecision: null,
    status: "READY",
    claudeLimitWaitCount: 0,
    deferredHumanTasks: [],
    completedTasks: [],
  });
  const statePath = join(dir, "project-state.json");
  const configPath = writeJson(dir, "manifest.json", {
    projectId: "rhr-e2e-project",
    projectName: "RHR E2E Project",
    targetProjectRoot: ".",
    statePath: "project-state.json",
    taskRegistryPath: "task-registry.json",
    developerInstructions: "dev",
    reviewInstructions: "review",
    reviewScopeDirs: ["fixture/"],
    executionPolicy: {
      allowedReadPrefixes: ["fixture/"],
      allowedWritePrefixes: ["fixture/"],
      allowedCommands: deriveAllowedCommandsFromRequiredTests([{ taskId: rhrTask.id, requiredTests: rhrTask.requiredTests }]),
    },
    // 의도적으로 humanFinalReviewPolicy를 지정하지 않는다 — task 자신의
    // requiresHumanReview:true만으로 동일 gate가 발동함을 증명한다.
  });
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });

  const manifest = loadProjectAdapter(configPath);
  check("Z) [E2E] loader 결과에 requiresHumanReview:true가 존재함(runAutodevOnce에 넘기기 전 사전조건)", manifest.taskRegistry[0].requiresHumanReview === true);
  check("Z) [E2E] humanFinalReviewPolicy는 지정하지 않았으므로 undefined(프로젝트 전체 opt-in과 무관함을 증명)", manifest.humanFinalReviewPolicy === undefined);

  let reviewerCalls = 0;
  const countingReviewer = async (): Promise<GptReviewerReturn> => {
    reviewerCalls += 1;
    return { decision: "PASS", severity: { critical: 0, high: 0, medium: 0 }, feedback: "호출되면 안 됨(테스트 실패 신호)", nextTask: null };
  };
  const claudeRunner = async (): Promise<ClaudeResult> => {
    mkdirSync(join(dir, "fixture"), { recursive: true });
    writeText(join(dir, "fixture"), "marker.txt", "marker\n");
    return { success: true, summary: "테스트", changedFiles: ["fixture/marker.txt"], tests: [{ name: "fixture:test", pass: true }], rawOutput: "" };
  };
  const firstResult = await runAutodevOnce({ manifest, orchestratorDeps: { claudeRunner, gptReviewer: countingReviewer } });
  check(
    "Z) [E2E] loader→runAutodevOnce data path: requiresHumanReview:true(정책 opt-in 없이) → outcome=RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW",
    firstResult.outcome === "RAN_TASK_AWAITING_HUMAN_FINAL_REVIEW"
  );
  check("Z) [E2E] GPT reviewer 호출 0회(핵심 회귀 — RevenueOS에서 이 값이 실제로 2회 이상 호출됐었음)", reviewerCalls === 0);

  const approval = approveHumanFinalReview(statePath, rhrTask.id);
  check("Z) [E2E] approveHumanFinalReview ok=true", approval.ok === true);
  const result = await runAutodevOnce({ manifest });
  check("Z) [E2E] 사람 APPROVE 후 resume outcome=RAN_TASK_APPROVED_AND_CHECKPOINTED", result.outcome === "RAN_TASK_APPROVED_AND_CHECKPOINTED");
  check("Z) [E2E] 승인 후에도 GPT reviewer 호출 0회 유지", reviewerCalls === 0);
}

async function main(): Promise<void> {
  try {
    scenarioMissingAdapterPathFailsFast();
    scenarioNonexistentConfigPathFailsFast();
    scenarioMalformedJsonFailsFast();
    scenarioMissingRequiredFieldsFailsFast();
    scenarioInvalidTaskRegistryFailsFast();
    scenarioInvalidExecutionPolicyFailsFast();
    scenarioMalformedRegexFailsFast();
    scenarioNonexistentTargetRootFailsFast();
    scenarioMaliciousJsAdapterNeverExecutes();
    scenarioTaskRegistrySourceAmbiguityFailsFast();
    scenarioPathEscapeFailsFast();
    scenarioValidFixtureConfigLoadsSuccessfully();
    scenarioRemoteGitSafetyAbsentIsUndefined();
    scenarioRemoteGitSafetyValidPassesThrough();
    scenarioRemoteGitSafetyInvalidRemoteNameFailsFast();
    scenarioRemoteGitSafetyInvalidExpectedBranchFailsFast();
    scenarioRemoteGitSafetyInvalidShapeFailsClosed();
    scenarioRemoteGitSafetyValidConfigPassesManifestValidation();
    await scenarioRemoteGitSafetyVisibleToRunAutodevOnce();
    scenarioHumanFinalReviewPolicyAbsentIsUndefined();
    scenarioHumanFinalReviewPolicyValidPassesThrough();
    scenarioHumanFinalReviewPolicyInvalidEnabledFailsFast();
    scenarioHumanFinalReviewPolicyInvalidShapeFailsClosed();
    await scenarioHumanFinalReviewPolicyVisibleToRunAutodevOnce();

    scenarioRequiresHumanReviewAbsentIsUndefined();
    scenarioRequiresHumanReviewValidPassesThrough();
    scenarioRequiresHumanReviewInvalidShapeFailsFast();
    await scenarioRequiresHumanReviewVisibleToRunAutodevOnce();
  } finally {
    for (const dir of tempDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // 임시 디렉터리 정리 실패는 테스트 결과에 영향 없음
      }
    }
  }

  // 소스 회귀 — run.ts(범용 진입점)가 project-manifests/movan을 import하지 않고, adapter
  // 경로 없이는 즉시 실패하며, 기본 프로젝트 상수를 갖지 않는다.
  const runSource = readFileSync(join(__dirname, "..", "src", "run.ts"), "utf-8");
  check("소스 회귀: run.ts가 project-manifests/movan을 import하지 않음", !/from\s+"\.\/project-manifests\/movan"/.test(runSource));
  check("소스 회귀: run.ts가 project-adapter-loader를 통해서만 manifest를 얻음", /loadProjectAdapter\(/.test(runSource));
  check("소스 회귀: run.ts에 MOVAN 하드코딩 문자열이 없음", !/MOVAN/.test(runSource));

  // 주석에 남아있는 "이런 걸 쓰지 않는다"는 설명 문구(예: "eval()/new Function() 등을 쓰지
  // 않는다")까지 실패시키는 허술한 문자열 검사가 되지 않도록, // 줄 주석을 제거한 코드만
  // 검사한다(§ core-movan-leakage-tests.ts와 동일한 원칙 — 코드가 실제로 무엇을 하는지만 본다).
  const loaderSourceRaw = readFileSync(join(__dirname, "..", "src", "project-adapter-loader.ts"), "utf-8");
  const loaderSource = loaderSourceRaw
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  check("소스 회귀: project-adapter-loader.ts가 require(resolvedPath)로 외부 adapter를 실행하지 않음", !/require\(\s*resolvedPath\s*\)/.test(loaderSource));
  check("소스 회귀: project-adapter-loader.ts에 동적 import()가 없음", !/\bimport\(/.test(loaderSource));
  check("소스 회귀: project-adapter-loader.ts에 eval()이 없음", !/\beval\(/.test(loaderSource));
  check("소스 회귀: project-adapter-loader.ts에 new Function()이 없음", !/new\s+Function\(/.test(loaderSource));
  check("소스 회귀: project-adapter-loader.ts에 vm 모듈 사용이 없음", !/require\(\s*["']node:vm["']\s*\)/.test(loaderSource) && !/from\s+"node:vm"/.test(loaderSource));
  check("소스 회귀: project-adapter-loader.ts가 readFileSync+JSON.parse로만 project config를 읽음", /JSON\.parse\(/.test(loaderSource));

  console.log("\n=== project-adapter-loader(Phase C Task C1 — Data-only External Project Adapter) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
