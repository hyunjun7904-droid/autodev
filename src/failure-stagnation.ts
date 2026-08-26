import type { ClaudeResult } from "./types";

// AutoDev / JARVIS Unattended Continuous Development Reliability Hardening — Phase 6.
//
// Tasks 1.2/1.3/1.4는 같은 실패가 5회 REVISE 내내 반복돼도 그 사실 자체를 관측할 방법이
// 없었다 — reviewCycle이 소진되면 그냥 "REVIEW_CYCLE_EXHAUSTED"로만 WAITING_HUMAN에
// 도달했다. 이 파일은 그 반복을 deterministic하게 감지해서(순수 함수, LLM 호출 없음)
// 사람에게 "무엇이 반복됐는지" 구체적으로 남긴다 — reviewCycle 상한을 늘리거나, REVISE를
// 자동으로 더 허용하거나, 실패를 조용히 통과시키지 않는다(§ 요구사항 — 5회 제한 자체는
// review-policy.ts/orchestrator.ts의 기존 MAX_REVIEW_CYCLES 그대로 유지).
//
// 분류는 의도적으로 보수적이다: PROVIDER(기존 errorCode로 이미 명확히 알 수 있음)와
// INFRASTRUCTURE_CONFIGURATION(required test 명령 자체가 spawn조차 되지 못함 — Command
// Safety Gate/allow-list 미등록 등)는 deterministic하게 판정할 수 있지만, "테스트 코드
// 자체의 버그(TEST_LOGIC)"와 "실제 구현 결함(IMPLEMENTATION)"의 구분은 실제로 명령이
// 실행되어 실패했다는 사실만으로는 안전하게 추측할 수 없다(그 둘을 가르는 건 코드의 의미를
// 이해해야 하는 판단이라 Developer/Reviewer의 몫이다 — 이 계층이 잘못 추측해 사람을
// 오도하지 않기 위해 일부러 IMPLEMENTATION 쪽으로 안전하게 묶는다. 그 경우의 실제 동작은
// "기존 Developer↔Reviewer REVISE 루프를 그대로 계속한다"이므로 잘못 분류해도 동작이
// 달라지지 않는다 — § requiredTests의 실제 stderr/stdout 근거는 Phase 5가 이미 Developer/
// Reviewer에게 그대로 전달한다).
export type FailureCategory = "INFRASTRUCTURE_CONFIGURATION" | "IMPLEMENTATION" | "PROVIDER" | "UNKNOWN";

const PROVIDER_CLAUDE_ERROR_CODES = new Set(["TIMEOUT", "CLI_NOT_FOUND", "USAGE_LIMIT"]);
const PROVIDER_GPT_ERROR_CODES = new Set([
  "AUTH_ERROR",
  "QUOTA_EXCEEDED",
  "GPT_REVIEW_TEMPORARILY_UNAVAILABLE",
  "BUDGET_EXCEEDED",
  "PROVIDER_SECURITY_BLOCKED",
]);

/** stderr/stdout 꼬리의 "첫 유의미한 줄"만 취해 정규화한다 — 타임스탬프/임시 경로/PID 같은
 *  매 실행마다 달라지는 숫자는 '#'으로 치환해 같은 실패를 같은 fingerprint로 묶는다. */
function normalizeErrorSignature(text: string | undefined): string {
  if (!text) return "";
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return "";
  return firstLine.replace(/\d+/g, "#").slice(0, 200);
}

/** taskId + 실패한 required test들(이름/명령/exitCode/정규화된 에러 첫 줄)만으로 결정론적
 *  fingerprint를 만든다 — 같은 원인의 실패는 재실행해도 항상 같은 fingerprint를 낸다. */
export function computeFailureFingerprint(taskId: string, tests: ClaudeResult["tests"]): string {
  const failed = tests.filter((t) => !t.pass);
  const parts = failed
    .map((t) => {
      const ev = t.failureEvidence;
      return [t.name, ev?.command ?? "", String(ev?.exitCode ?? ""), normalizeErrorSignature(ev?.stderrTail)].join("|");
    })
    .sort();
  return `${taskId}::${parts.join(";;")}`;
}

export function classifyFailureCategory(
  claudeErrorCode: string | undefined,
  gptErrorCode: string | undefined,
  tests: ClaudeResult["tests"]
): FailureCategory {
  if (claudeErrorCode && PROVIDER_CLAUDE_ERROR_CODES.has(claudeErrorCode)) return "PROVIDER";
  if (gptErrorCode && PROVIDER_GPT_ERROR_CODES.has(gptErrorCode)) return "PROVIDER";
  const failed = tests.filter((t) => !t.pass);
  if (failed.length === 0) return "UNKNOWN";
  // required test 명령이 spawn조차 되지 못했다(denyReason만 있고 failureEvidence 자체가
  // 없음 — § claude-developer.ts runRequiredTests) — Command Safety Gate/allow-list
  // 미등록 같은 인프라 문제일 가능성이 높다.
  const anyNeverExecuted = failed.some((t) => !t.failureEvidence);
  if (anyNeverExecuted) return "INFRASTRUCTURE_CONFIGURATION";
  return "IMPLEMENTATION";
}

export interface StagnationTracker {
  /** 이번 fingerprint가 몇 번째 연속 반복인지 반환한다(새 fingerprint면 1). 호출부는
   *  정확히 2가 되는 시점(권장 임계값 — "같은 의미 있는 실패가 두 번")에만 진단을
   *  기록해 매 cycle 중복 기록을 피한다. */
  observe(fingerprint: string): number;
}

/** orchestrator.ts의 while(true) REVISE 루프 한 번(runOrchestrator 호출 1회) 동안만
 *  유효한 in-memory tracker — project-state.json에 영속화하지 않는다(gptCallCount와
 *  동일한 loop-local 값). */
export function createStagnationTracker(): StagnationTracker {
  let lastFingerprint: string | undefined;
  let repeatCount = 0;
  return {
    observe(fingerprint: string): number {
      if (fingerprint === lastFingerprint) {
        repeatCount += 1;
      } else {
        lastFingerprint = fingerprint;
        repeatCount = 1;
      }
      return repeatCount;
    },
  };
}
