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
export function normalizeErrorSignature(text: string | undefined): string {
  if (!text) return "";
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return "";
  return firstLine.replace(/\d+/g, "#").slice(0, 200);
}

/**
 * 실패한 required test들(이름/명령/exitCode/정규화된 에러 첫 줄)만으로 결정론적
 * fingerprint를 만든다 — taskId/projectId를 포함하지 않는다. AutoDev / JARVIS 지능형 오류
 * 복구 하드닝(문제 해결 지식 저장소) — 이 fingerprint가 Task/Project 경계를 넘어 재사용
 * 가능해야 하므로(§ problem-memory.ts) 특정 task/project에 종속된 값을 절대 섞지 않는다.
 * computeFailureFingerprint()는 이 값에 taskId만 덧붙여 "이 task 안에서의 반복"을 구분한다.
 */
export function computeProblemFingerprint(tests: ClaudeResult["tests"]): string {
  const failed = tests.filter((t) => !t.pass);
  const parts = failed
    .map((t) => {
      const ev = t.failureEvidence;
      return [t.name, ev?.command ?? "", String(ev?.exitCode ?? ""), normalizeErrorSignature(ev?.stderrTail)].join("|");
    })
    .sort();
  return parts.join(";;");
}

/** taskId + computeProblemFingerprint()만으로 결정론적 fingerprint를 만든다 — 같은 원인의
 *  실패는 재실행해도 항상 같은 fingerprint를 낸다. 이 값은 "이 task 안에서 반복되는지"를
 *  감지하는 stagnation tracker 전용이다 — cross-task/cross-project 재사용 검색에는
 *  computeProblemFingerprint()를 직접 써야 한다(§ problem-memory.ts). */
export function computeFailureFingerprint(taskId: string, tests: ClaudeResult["tests"]): string {
  return `${taskId}::${computeProblemFingerprint(tests)}`;
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

// AutoDev 지능형 오류 복구 하드닝 — 반복 횟수가 늘어날수록 해결 전략 자체가 달라져야 한다
// (§ 요구사항 10). 이 함수는 어떤 코드도 되돌리거나 실행하지 않는다 — Claude Developer의
// 다음 라운드 프롬프트에 덧붙일 안내 문구만 결정론적으로 만든다(순수 함수, LLM 호출 없음).
// 1회차는 안내 없음(일반적인 원인 분석), 2회차는 "이 전략이 틀렸을 가능성" 경고, 3회차는
// 같은 전략 재사용을 명시적으로 금지, 4회차 이상은 구현 접근 자체의 재검토를 요구한다.
// 실제 git revert 등 자동 되돌리기는 하지 않는다(§ 요구사항 19 — 새 기능/대규모 개편 금지,
// 이 계층은 어디까지나 안내 텍스트만 바꾼다).
export function buildEscalationGuidance(repeatCount: number, priorAttemptedDescriptions: string[]): string | undefined {
  if (repeatCount <= 1) return undefined;
  const priorList = priorAttemptedDescriptions
    .slice(-repeatCount + 1)
    .map((d, i) => `  ${i + 1}) ${d.length > 300 ? `${d.slice(0, 300)}…` : d}`)
    .join("\n");
  if (repeatCount === 2) {
    return (
      "# AutoDev 안내(반복 실패 2회차)\n" +
      "직전 시도가 같은 required test 실패를 해결하지 못했습니다. 그 시도가 잘못된 접근이었을 가능성이 높습니다.\n" +
      "직전 시도 내용:\n" +
      priorList
    );
  }
  if (repeatCount === 3) {
    return (
      "# AutoDev 안내(반복 실패 3회차 — 전략 재사용 금지)\n" +
      "같은 required test 실패가 3회 연속 반복되었습니다. 아래에 나열된 이미 실패한 접근을 그대로 다시 시도하지 마세요 — 근본 원인을 처음부터 다시 분석하세요.\n" +
      "이미 실패한 접근:\n" +
      priorList
    );
  }
  return (
    "# AutoDev 안내(반복 실패 4회 이상 — 구현 접근 재검토)\n" +
    "같은 required test 실패가 4회 이상 반복되었습니다. 지금까지의 개별 수정을 반복하지 말고, 이 기능을 구현하는 접근 자체가 올바른지부터 재검토하세요. 필요하면 지금까지의 변경 중 문제를 일으킨 부분을 되돌리고 다른 구현 방법을 선택하세요.\n" +
    "이미 실패한 접근:\n" +
    priorList
  );
}
