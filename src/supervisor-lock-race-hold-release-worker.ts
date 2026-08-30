import { acquireSupervisorLockAtomic, releaseSupervisorLockAtomic, defaultIsPidAlive } from "./dashboard-supervisor";

// dashboard-supervisor-tests.ts(§ BLOCKER 1 재하드닝 필수 테스트 6 — "old supervisor
// release vs fresh supervisor acquire 경쟁")가 spawn하는 별도 child process 전용 helper다 —
// project-lock-race-hold-release-worker.ts와 정확히 동일한 원칙(§ 그 파일 상단 주석)을
// supervisor singleton lock에 적용한다. 이 파일 자체는 어떤 test 러너에도 등록하지 않는다
// — 실제 Claude/OpenAI/Telegram 호출은 없다.
//
// argv: [lockFilePath, holdMs, maxRetries, retryIntervalMs]
const [, , lockFilePath, holdMsRaw, maxRetriesRaw, retryIntervalMsRaw] = process.argv;
const holdMs = Number(holdMsRaw);
const maxRetries = Number(maxRetriesRaw);
const retryIntervalMs = Number(retryIntervalMsRaw);

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let attempt = 0;
while (attempt < maxRetries) {
  const result = acquireSupervisorLockAtomic(lockFilePath, defaultIsPidAlive);
  if (result.ok) {
    const acquiredAt = Date.now();
    sleepSync(holdMs);
    const releaseResult = releaseSupervisorLockAtomic(lockFilePath, result.lockId);
    const releasedAt = Date.now();
    console.log(`ACQUIRED ${acquiredAt} ${releasedAt} ${releaseResult.ok}`);
    process.exit(0);
  }
  attempt += 1;
  sleepSync(retryIntervalMs);
}
console.log("NEVER_ACQUIRED");
