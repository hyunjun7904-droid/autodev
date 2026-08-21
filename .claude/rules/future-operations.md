# 향후 운영 요구사항 (설계 기록 — 미구현)

이 문서는 Phase C Task C3에서 함께 기록하기로 한 장기 설계 요구사항이다. **이 문서에
적혀 있다는 사실 자체가 구현 승인을 의미하지 않는다.** 아래 항목은 각각 명시적으로
지정된 별도 Task에서만 구현한다. Task C3는 Deterministic Secret Scanner Gate를,
Task C4는 Hooks / Permissions Enforcement(Core Command Safety Gate,
`src/safe-executor.ts`의 `coreCommandSafetyGate` — 자세한 내용은 `.claude/CLAUDE.md`
보안 섹션 참고)를, Task C5는 Deterministic Dependency / Supply-chain Scanner Gate
(`src/dependency-scanner.ts`)를, Task D1은 Capability Discovery & MCP Resolver의
Core Design/Foundation(`src/capability-resolver.ts` — 데이터 모델 + candidate 평가/
랭킹 + risk/approval 판정)을, Task D2는 그 위에 Trusted Candidate Discovery & Evidence
(`src/candidate-evidence.ts` — evidence 데이터 모델 + 신뢰도/staleness/충돌 판정 +
D1 CandidateSource 어댑터, 자세한 내용은 `.claude/CLAUDE.md` 참고)를 구현했다. D1/D2
모두 실제 외부 MCP 설치/실행을 하지 않는다 — Notification Service / Dashboard / 실제
MCP 설치·활성화 / Browser Worker / Agent Router는 아직 시작하지 않았다.

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

## 아직 시작하지 않은 것

- Notification Service
- Dashboard
- 실제 MCP 서버 설치/다운로드/활성화(D1/D2는 Discovery/Resolver/Evidence의 Core 데이터
  모델·판정 로직만 구현했다 — 실제 evidence source/candidate source 연동, 실제 활성화
  실행 경로, Browser Worker, Agent Router는 없음)
- production credential을 실제로 사용하는 evidence/candidate 조회
