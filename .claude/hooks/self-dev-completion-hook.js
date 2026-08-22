#!/usr/bin/env node
"use strict";

// Claude Code PostToolUse(Bash) hook entry point — Phase G Task G7.3.1b.
//
// 이 파일은 순수 IO 배선(plumbing)만 한다: stdin에서 hook 이벤트 JSON을 읽고, 실제
// 판정/실행 로직(dist/self-dev-completion-hook.js, src/self-dev-completion-hook.ts에서
// 컴파일됨)에 넘긴 뒤 그 결과를 Claude Code가 기대하는 JSON(stdout, exit 0)으로 되돌려
// 준다. 판정 로직 자체를 여기 다시 작성하지 않는다(단일 출처 — src/self-dev-completion-
// hook-tests.ts가 그 로직을 실제로 검증한다).
//
// 이 파일은 TypeScript로 컴파일되지 않는 일반 CommonJS다 — dist/가 아직 빌드되지 않았거나
// 손상돼 있어도(require 실패) 이 진입점 자체는 항상 안전하게 조용히 종료해야 한다(hook이
// Claude Code 세션의 다른 Bash 호출을 절대 막아서는 안 된다 — PostToolUse는 이미 실행된
// 명령 뒤에 붙는 보조 단계일 뿐이다).

function readStdin() {
  try {
    return require("node:fs").readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function emit(payload) {
  if (payload) console.log(JSON.stringify(payload));
}

function main() {
  const raw = readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return; // stdin이 비었거나 JSON이 아니면 조용히 종료
  }

  const command = input && input.tool_input && typeof input.tool_input.command === "string" ? input.tool_input.command : "";
  if (!command) return;

  const path = require("node:path");
  const repoRoot = path.resolve(__dirname, "..", "..");

  let mod;
  try {
    mod = require(path.join(repoRoot, "dist", "self-dev-completion-hook.js"));
  } catch (e) {
    emit({
      systemMessage:
        "[self-dev completion hook] dist/self-dev-completion-hook.js를 불러올 수 없습니다(npm run build 필요) — " +
        "자동 트리거를 건너뜁니다: " +
        (e && e.message ? e.message : String(e)),
    });
    return;
  }

  let result;
  try {
    result = mod.runSelfDevCompletionHook({ command, repoRoot });
  } catch (e) {
    emit({
      systemMessage: "[self-dev completion hook] 실행 중 처리되지 않은 오류: " + (e && e.message ? e.message : String(e)),
    });
    return;
  }

  if (!result || !result.triggered) return; // 대부분의 Bash 호출 — 조용히 종료(노이즈 없음)

  emit({
    systemMessage: (result.ok ? "[self-dev completion hook] " : "[self-dev completion hook] FAILED — ") + result.message,
  });
}

try {
  main();
} catch {
  // 이 hook은 절대 Claude Code 세션을 막으면 안 된다 — 예상치 못한 예외는 조용히 삼킨다.
}
