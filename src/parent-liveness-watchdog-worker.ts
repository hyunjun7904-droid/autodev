import { startParentLivenessWatchdog } from "./parent-liveness-watchdog";
import { defaultIsPidAlive } from "./dashboard-supervisor";

// parent-liveness-watchdog-tests.ts(§ P0-3 실제 concurrency/liveness test)가 spawn하는 별도
// child process 전용 helper다 — 실제 OS 프로세스가 실제로 살아있는 "가짜 supervisor"를
// 감시하다가, 그 프로세스가 실제로 kill됐을 때 정말로(mock 없이) 스스로 종료하는지 검증하기
// 위함이다. 이 파일 자체는 어떤 test 러너에도 등록하지 않는다 — 실제 Claude/OpenAI/Telegram
// 호출은 없다.
//
// argv: [parentPid]
const [, , parentPidRaw] = process.argv;
const parentPid = Number(parentPidRaw);

startParentLivenessWatchdog(
  parentPid,
  {
    isPidAlive: defaultIsPidAlive,
    onParentDead: () => {
      console.log("SELF_TERMINATED");
      process.exit(0);
    },
  },
  200
);

// 안전장치 — 어떤 이유로든 감지에 실패해도 테스트가 무기한 걸리지 않도록 스스로 timeout한다.
setTimeout(() => {
  console.log("TIMEOUT");
  process.exit(2);
}, 8_000);
