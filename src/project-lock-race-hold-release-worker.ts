import { acquireProjectLock, releaseProjectLock } from "./project-lock";

// project-lock-tests.ts(§ BLOCKER 1 재하드닝 필수 테스트 4 — "old owner release vs fresh
// owner acquire 경쟁")가 spawn하는 별도 child process 전용 helper다 — 실제 OS 프로세스
// 여러 개가 반복적으로 "acquire → 잠깐 보유 → release → 재시도"를 도는 동안, 실제
// wall-clock 구간([acquiredAt, releasedAt])이 서로 겹치는 프로세스가 절대 없는지(=
// ACTIVE_WRITER_COUNT<=1이 매 순간 유지되는지)를 실제 프로세스 timestamp로 검증하기
// 위함이다. mock/sleep으로 race를 숨기지 않는다 — 모든 대기는 이 프로세스 자신의 실제
// acquire 재시도 간격이고, 승부는 항상 실제 acquireProjectLock()의 원자적 wx create/rename
// 단일승자 연산이 가른다. 이 파일 자체는 어떤 test 러너에도 등록하지 않는다(그냥
// 컴파일되는 helper 스크립트) — 실제 Claude/OpenAI/Telegram 호출은 없다.
//
// argv: [projectId, targetProjectRoot, lockDir, holdMs, maxRetries, retryIntervalMs]
const [, , projectId, targetProjectRoot, lockDir, holdMsRaw, maxRetriesRaw, retryIntervalMsRaw] = process.argv;
const holdMs = Number(holdMsRaw);
const maxRetries = Number(maxRetriesRaw);
const retryIntervalMs = Number(retryIntervalMsRaw);

/** 동기 sleep — 이 worker는 짧고 단순한 스크립트라 async 이벤트 루프 배선 없이 Atomics.wait로
 *  실제 시간만큼 blocking 대기한다(Node 표준 API, 외부 의존성 없음). */
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let attempt = 0;
while (attempt < maxRetries) {
  const result = acquireProjectLock({ projectId, targetProjectRoot, ownerKind: "autodev" }, { lockDir });
  if (result.ok) {
    const acquiredAt = Date.now();
    sleepSync(holdMs);
    const releaseResult = releaseProjectLock(result.lock);
    const releasedAt = Date.now();
    console.log(`ACQUIRED ${acquiredAt} ${releasedAt} ${releaseResult.ok}`);
    process.exit(0);
  }
  attempt += 1;
  sleepSync(retryIntervalMs);
}
console.log("NEVER_ACQUIRED");
