# 향후 운영 요구사항 (설계 기록 — 미구현)

이 문서는 Phase C Task C3에서 함께 기록하기로 한 장기 설계 요구사항이다. **이 문서에
적혀 있다는 사실 자체가 구현 승인을 의미하지 않는다.** 아래 항목은 각각 명시적으로
지정된 별도 Task에서만 구현한다. 이번 Task(C3)는 Deterministic Secret Scanner
Gate만 구현했고, Notification Service / Dashboard / Hooks·Permissions / Dependency
Scanner / MCP Resolver는 시작하지 않았다.

## Notification 이벤트

다음 이벤트가 발생하면 향후 Notification Service를 통해 휴대폰 알림을 받을 수 있어야
한다:

- `TASK_COMPLETED`
- `PHASE_COMPLETED`
- `PROJECT_COMPLETED`
- `APPROVAL_REQUIRED` / `WAITING_HUMAN`
- `SECURITY_BLOCKED`
- `TEST_FAILED`
- `AUTODEV_ERROR`
- `CLAUDE_USAGE_LIMIT`
- `GPT_RETRY_EXHAUSTED`
- `GIT_SYNC_BLOCKED` / `REMOTE_DIVERGENCE`

## 모바일 승인 흐름

사람 승인이 필요한 경우, 향후 모바일에서 다음 흐름을 지원해야 한다:

1. `Approve` / `Reject` / `Defer` 선택
2. AutoDev 안전 상태 재검사(승인 시점에 다시 한번 안전 조건을 확인 — 승인 요청 시점과
   실행 시점 사이 상태 변화를 신뢰하지 않는다)
3. 승인된 경우 Auto Resume

## 재알림 정책

중요 승인 알림이 미확인 상태로 남아 있으면 제한된 재알림(rate-limited)을 지원한다.
단, **사람의 승인이 필요한 위험 작업(`policy.ts`의 `ALWAYS_HUMAN` — production DB
변경/삭제, 적용된 migration 수정, production 배포, production secret 변경,
Microsoft 연결, 유료 외부 action 등)을 재알림 미확인을 이유로 자동 승인해서는
안 된다.** 재알림은 사람에게 다시 알리는 것이지, 시스템이 대신 승인하는 것이 아니다.

## 이번 Task(C3)에서 시작하지 않는 것

- Hooks / Permissions
- Dependency Scanner
- Notification Service
- Dashboard
- MCP Resolver
