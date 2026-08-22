import { randomUUID } from "node:crypto";
import { createFakeNotificationProvider, createLogNotificationProvider } from "./notification-provider";
import type { NotificationMessage } from "./notification";

// Delivery Provider 테스트(Phase G Task G5). 실제 외부 notification 전송은 하지 않는다 —
// fake provider(순수 in-memory)와 log provider(이 저장소의 기존 logger.ts 재사용, 실제
// 외부 서비스 아님)만 검증한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function msg(overrides: Partial<NotificationMessage> = {}): NotificationMessage {
  return {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    runId: "r1",
    taskId: "T1",
    notificationType: "TASK_COMPLETED",
    severity: "INFO",
    title: "[AutoDev] Task 완료",
    shortMessage: "Task T1가 완료되었습니다.",
    requiresHumanAction: false,
    dedupeKey: "r1::T1::TASK_COMPLETED::-",
    sourceEventType: "TASK_COMPLETED",
    sourceEventId: randomUUID(),
    ...overrides,
  };
}

function scenarioFakeProviderSuccess(): void {
  const provider = createFakeNotificationProvider();
  const n = msg();
  const result = provider.send(n);
  check("fake provider: 기본값은 성공", result.ok === true);
  check("fake provider: error 없음", result.error === undefined);
  check("fake provider: sent에 기록됨", provider.sent.length === 1 && provider.sent[0].id === n.id);
}

function scenarioFakeProviderAlwaysFail(): void {
  const provider = createFakeNotificationProvider({ alwaysFail: true });
  const result = provider.send(msg());
  check("fake provider(alwaysFail): 실패 반환(예외 아님)", result.ok === false);
  check("fake provider(alwaysFail): error 문자열 존재", typeof result.error === "string" && result.error.length > 0);
  check("fake provider(alwaysFail): sent에 기록 안 됨", provider.sent.length === 0);

  const result2 = provider.send(msg({ id: "another-id" }));
  check("fake provider(alwaysFail): deterministic(항상 같은 error)", result2.error === result.error);
}

function scenarioLogProviderDoesNotThrow(): void {
  const provider = createLogNotificationProvider();
  let threw = false;
  let result: { ok: boolean; error?: string } = { ok: false };
  try {
    result = provider.send(msg({ notificationType: "SECURITY_BLOCKED", severity: "CRITICAL", requiresHumanAction: true }));
  } catch {
    threw = true;
  }
  check("log provider: send()가 예외를 던지지 않음", threw === false);
  check("log provider: 정상 기록 시 ok=true", result.ok === true);
}

async function main(): Promise<void> {
  scenarioFakeProviderSuccess();
  scenarioFakeProviderAlwaysFail();
  scenarioLogProviderDoesNotThrow();

  console.log("\n=== notification-provider(G5) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
