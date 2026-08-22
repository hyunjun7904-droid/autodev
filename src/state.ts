import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
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

// Phase G Task G7.4 — Failure / Resume Hardening. project-state.json은 decideNextAction()이
// "다음에 어떤 task를 골라야 하는가"를 판단하는 유일한 source of truth다 — 이 파일이 write 도중
// 손상되면(프로세스가 kill/전원 차단 등으로 정확히 이 write 중간에 중단됨) 이후의 모든 재시작이
// JSON.parse 실패로 loadState()에서 즉시 crash하고, project-state.json을 고칠 방법이 없는 채로
// 계속 같은 실패를 반복한다. 같은 디렉터리(=같은 파일시스템)에 임시 파일로 전체 내용을 먼저
// 쓴 뒤 renameSync로 원자적으로 교체한다 — rename은 대상 경로에 대해 "이전 파일 그대로" 또는
// "새 파일 전체"만 관측되고 그 중간 상태가 관측되지 않는다(POSIX/Windows 둘 다 같은 볼륨 내
// rename은 원자적 교체). 임시 파일 쓰기 자체가 실패하면(디스크/권한 등) rename을 시도하지 않고
// 그대로 throw하므로, 기존 statePath는 항상 마지막으로 성공한 내용 그대로 보존된다.
export function saveState(state: ProjectState, statePath: string = DEFAULT_STATE_PATH): void {
  const tmpPath = `${statePath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmpPath, statePath);
}
