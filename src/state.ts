import { readFileSync, writeFileSync } from "node:fs";
import { DEFAULT_STATE_PATH } from "./project-context";
import type { ProjectState } from "./types";

// 실제 운영 경로 — production AutoDev(autodev.ts main(), 실제 dry-run 등)는 이 경로를
// 그대로 쓴다. 어떤 automation test도 이 경로를 직접 loadState()/saveState()로 건드려서는
// 안 된다(§ 요구사항: project-state 테스트 격리) — 테스트는 반드시 statePath 인자로 임시
// 파일 경로를 넘겨야 한다.
//
// 실제 계산(AUTODEV_STATE_PATH 환경변수 주입 포함, Phase A Task A2)은 project-context.ts가
// 전담한다 — 이 파일은 기존 소비자(autodev.ts, orchestrator.ts, dry-run.ts 등)가
// `from "./state"`로 import하는 경로를 그대로 유지하기 위해 재export만 한다.
export { DEFAULT_STATE_PATH };

export function loadState(statePath: string = DEFAULT_STATE_PATH): ProjectState {
  const raw = readFileSync(statePath, "utf-8");
  return JSON.parse(raw) as ProjectState;
}

export function saveState(state: ProjectState, statePath: string = DEFAULT_STATE_PATH): void {
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
}
