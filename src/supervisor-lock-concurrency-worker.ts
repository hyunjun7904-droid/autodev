import { acquireSupervisorLockAtomic, defaultIsPidAlive } from "./dashboard-supervisor";

// dashboard-supervisor-tests.ts(§ P0-2 하드닝, 실제 concurrency test)가 spawn하는 별도 child
// process 전용 helper다 — 실제 OS 프로세스 두 개가 동시에 같은 supervisor singleton lock을
// 잡으려 할 때 정확히 하나만 성공하는지(§ "동시에 supervisor 2개 시작 시도 → 실제 active
// supervisor 정확히 1개")를 mock 없이 검증하기 위함이다. 이 파일 자체는 어떤 test 러너에도
// 등록하지 않는다(그냥 컴파일되는 helper 스크립트) — 실제 Claude/OpenAI/Telegram 호출은 없다.
//
// argv: [lockFilePath]
const [, , lockFilePath] = process.argv;

const result = acquireSupervisorLockAtomic(lockFilePath, defaultIsPidAlive);
if (result.ok) {
  // project-lock-concurrency-worker.ts와 동일한 이유로 잠깐 살아있는 상태를 유지한다(§ 그
  // 파일 주석) — 그래야 다른 worker가 liveness를 확인하는 시점에 "진짜 동시성 경쟁"이 된다.
  console.log("ACQUIRED");
  setTimeout(() => process.exit(0), 3_000);
} else {
  console.log(`BLOCKED:${result.reason}`);
}
