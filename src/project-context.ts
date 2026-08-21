import { resolve, join } from "node:path";
import { existsSync } from "node:fs";

// AutoDev Root / Target Project Root 분리(Phase A Task A1) — 이 파일이 두 root 개념의
// 단일 출처다. 폴더를 실제로 옮기거나 repository를 분리하지는 않지만, "AutoDev 자신의
// 위치"와 "AutoDev가 개발하는 대상 프로젝트의 위치"를 코드 레벨에서 분리해 나중에
// automation/이 완전히 별도 repository로 옮겨져도 이 seam만 갈아끼우면 되게 한다.

// AUTODEV_ROOT — AutoDev 자신의 설치/소스 위치(automation/ 폴더 자체). 컴파일 후
// __dirname은 automation/dist이므로 한 단계만 위로 올라가면 automation/ 이다. 이 계산은
// "지금 MOVAN repository 안에 중첩돼 있다"는 사실에 의존하지 않는다.
export const AUTODEV_ROOT = resolve(__dirname, "..");

// TARGET_PROJECT_ROOT — AutoDev가 실제로 읽고/쓰고/커밋할 대상 프로젝트의 root.
// AUTODEV_TARGET_PROJECT_ROOT 환경변수로 외부에서 주입할 수 있다. 지정하지 않으면
// AUTODEV_ROOT의 부모 디렉터리(현재는 MOVAN repository root — 기존 PROJECT_ROOT 계산인
// resolve(__dirname, "..", "..")와 정확히 동일한 값)를 기본값으로 써서 기존 MOVAN AutoDev
// 동작을 100% 보존한다. 실제로 두 repository가 분리되면 이 기본값 대신 항상 환경변수를
// 지정해야 한다(이번 Task에서는 폴더를 옮기지 않으므로 그 전환은 하지 않는다).
function resolveTargetProjectRoot(): string {
  const fromEnv = process.env.AUTODEV_TARGET_PROJECT_ROOT;
  if (fromEnv && fromEnv.trim().length > 0) {
    const candidate = resolve(fromEnv.trim());
    if (!existsSync(candidate)) {
      throw new Error(`AUTODEV_TARGET_PROJECT_ROOT가 존재하지 않는 경로를 가리킵니다: ${candidate}`);
    }
    return candidate;
  }
  return resolve(AUTODEV_ROOT, "..");
}

export const TARGET_PROJECT_ROOT = resolveTargetProjectRoot();

// DEFAULT_STATE_PATH — AutoDev가 project-state.json을 읽고/쓰는 기본 위치(Phase A Task A2).
// AUTODEV_STATE_PATH 환경변수로 외부에서 주입할 수 있다 — 예를 들어 MOVAN/.autodev/
// project-state.json, BILLION/.autodev/project-state.json처럼 대상 프로젝트별로 각자의
// state 파일을 분리해서 가리키게 하기 위함이다(이번 Task에서는 실제로 그 폴더 구조를
// 만들지는 않는다 — 주입 구조만 만든다). 지정하지 않으면 기존 automation/config/
// project-state.json을 그대로 써서 현재 MOVAN AutoDev 동작을 100% 보존한다.
// AUTODEV_TARGET_PROJECT_ROOT와 동일한 fail-fast 원칙을 따른다 — 사용자가 명시적으로
// 지정한 경로가 존재하지 않으면 조용히 기본 state로 fallback하지 않고 즉시 실패시킨다.
function resolveStatePath(): string {
  const fromEnv = process.env.AUTODEV_STATE_PATH;
  if (fromEnv && fromEnv.trim().length > 0) {
    const candidate = resolve(fromEnv.trim());
    if (!existsSync(candidate)) {
      throw new Error(`AUTODEV_STATE_PATH가 존재하지 않는 경로를 가리킵니다: ${candidate}`);
    }
    return candidate;
  }
  return join(AUTODEV_ROOT, "config", "project-state.json");
}

export const DEFAULT_STATE_PATH = resolveStatePath();
