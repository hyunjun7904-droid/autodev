import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { validateProjectManifest } from "./project-manifest";
import type { ProjectManifest } from "./project-manifest";

// AutoDev 범용화 Phase B Task B3 — External Project Adapter 로더.
//
// 지금까지(A4~B2) ProjectManifest 자체는 이미 범용 타입이었지만, 실제로 어떤 프로젝트의
// manifest를 쓸지는 이 repository 안에 있던 특정 프로젝트 전용 진입점이 그 프로젝트의
// manifest/registry 모듈을 소스 코드로 직접 import해서 조립하는 방식이었다 — 그래서 AutoDev
// repository 소스 안에 여전히 그 프로젝트의 이름이 남아 있었다. 이 파일이 그 마지막 결합을
// 끊는 유일한 자리다.
//
// project adapter는 이제 AutoDev repository 밖(예: 대상 프로젝트 저장소의
// .autodev/manifest.js)에 있는 하나의 CommonJS 모듈이며, 이 파일은 그 모듈을 절대경로로
// require()해 다음 계약을 강제한다:
//   - 모듈은 반드시 createProjectManifest(): ProjectManifest 함수를 export해야 한다.
//   - 그 함수가 반환한 값은 validateProjectManifest()를 통과해야 한다.
// 어느 한쪽이라도 어긋나면 즉시 throw한다 — 어떤 프로젝트로도 조용히 fallback하지 않는다. adapter 모듈이 무엇을 import하든(자신의 targetProjectRoot/
// statePath를 자기 파일 위치 기준으로 스스로 계산하든) 이 파일은 그 내부를 전혀 모른다 —
// 반환된 ProjectManifest 객체의 형태만 검증한다.

export function loadProjectAdapter(adapterPath: string | undefined): ProjectManifest {
  if (!adapterPath || adapterPath.trim().length === 0) {
    throw new Error(
      "project adapter 경로가 지정되지 않았습니다 — --project <path> 또는 " +
        "AUTODEV_PROJECT_ADAPTER 환경변수로 명시적으로 지정하세요(기본 프로젝트 없음, " +
        "silent fallback 없음)."
    );
  }

  const resolvedPath = resolve(adapterPath.trim());
  if (!existsSync(resolvedPath)) {
    throw new Error(`project adapter 모듈을 찾을 수 없습니다: ${resolvedPath}`);
  }

  let mod: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require(resolvedPath);
  } catch (e) {
    throw new Error(
      `project adapter 모듈을 로드하는 중 오류가 발생했습니다(${resolvedPath}): ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  const factory = (mod as { createProjectManifest?: unknown })?.createProjectManifest;
  if (typeof factory !== "function") {
    throw new Error(
      `project adapter 모듈(${resolvedPath})이 createProjectManifest() 함수를 export하지 않습니다.`
    );
  }

  const manifest = (factory as () => ProjectManifest)();
  validateProjectManifest(manifest);
  return manifest;
}
