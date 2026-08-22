import { acquireProjectLock } from "./project-lock";

// project-lock-tests.ts(§ 실제 concurrency test)가 spawn하는 별도 child process 전용
// helper다 — 실제 OS 프로세스 두 개가 동시에 같은 project lock을 잡으려 할 때 정확히
// 하나만 성공하는지(§ 요구사항 17/18)를 mock 없이 검증하기 위함이다. 이 파일 자체는
// 어떤 test 러너에도 등록하지 않는다(그냥 컴파일되는 helper 스크립트) — 실제 Claude/
// OpenAI/Telegram 호출은 없다.
//
// argv: [projectId, targetProjectRoot, lockDir]
const [, , projectId, targetProjectRoot, lockDir] = process.argv;

const result = acquireProjectLock({ projectId, targetProjectRoot, ownerKind: "autodev" }, { lockDir });
if (result.ok) {
  // 이 프로세스가 즉시 종료하면 다른 worker가 liveness를 확인하는 시점에는 이미 정말로
  // 죽어있을 수 있다(그 경우 "stale 복구"가 정답이 되어버려 진짜 동시성 경쟁을 검증하지
  // 못한다) — 실제 AutoDev 실행이 lock을 분 단위로 들고 있는 상황을 흉내내기 위해 잠깐
  // 살아있는 상태를 유지한다.
  console.log("ACQUIRED");
  setTimeout(() => process.exit(0), 3_000);
} else {
  console.log(`BLOCKED:${result.code}`);
}
