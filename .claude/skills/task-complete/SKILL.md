---
name: task-complete
description: Use when a Task on the AutoDev standalone repository itself (self-dev — developing AutoDev's own source under src/, not a target project it executes) appears finished and you are about to report it as complete. Runs the canonical verification → commit → push → Self-Dev Task Completion Bridge sequence so TASK_COMPLETED / the Telegram "Task 완료" notification is only ever created after real, freshly re-verified evidence — never from a Claude Code session simply stopping.
---

# AutoDev Self-Dev Task Completion

이 Skill은 **AutoDev standalone repository 자신을 개발하는 Task**(`src/`, `.claude/`, `package.json`
등 이 저장소 자신의 소스)를 완료 처리할 때만 쓴다. AutoDev가 실행하는 대상 프로젝트(예: MOVAN)의
Task 완료는 이 Skill의 대상이 아니다 — 그쪽은 이미 `checkpoint.ts`/`orchestrator.ts`의 production
checkpoint 파이프라인이 전담한다.

**핵심 원칙 — Claude Code 세션이 끝났다는 사실 자체는 완료의 증거가 아니다.** Stop hook이나
"작업을 다 했다"는 자기보고만으로 TASK_COMPLETED를 만들지 않는다. 아래 순서를 전부 사람이/Claude가
직접 실행하고 실제로 통과한 뒤에만, 마지막 단계에서 `self-dev-complete.ts`(deterministic bridge)가
그 evidence를 **이 저장소를 대상으로 직접 재검증**한 뒤에만 event가 만들어진다(§ 아키텍처는 아래
참고). 즉 이 Skill 자체를 건너뛰고 evidence를 조작해 CLI에 거짓 flag를 넘겨도, 마지막 bridge
재검증이 fail-closed로 막는다.

## 언제 이 Skill을 쓰지 않는가 — 즉시 STOP

다음 중 하나라도 해당하면 이 Skill을 실행하지 않는다. 이런 상태에서 TASK_COMPLETED를 만들면 안
된다(§ 요구사항):

- Task의 Acceptance Criteria를 아직 다 만족하지 못했다.
- required tests/typecheck/build 중 하나라도 FAIL이다.
- 사람의 승인/확인이 필요한 상태다(WAITING_HUMAN) — 예: production DB/배포/등 `policy.ts`의
  `ALWAYS_HUMAN` 대상 작업이 있거나, 범위를 벗어난 결정이 필요하다.
- 보안 게이트(Safe Executor/Secret Scanner/Dependency Scanner/Core Command Safety Gate)가
  BLOCK했다.
- git 상태가 불확실하다(merge/rebase/cherry-pick 진행 중, 의도하지 않은 변경 혼입 등).

이런 경우 Task를 `IN_PROGRESS`/`BLOCKED`/`WAITING_HUMAN`으로 보고하고 멈춘다. 새 알림 종류를
만들지 않는다 — 이미 같은 파이프라인에 연결된 기존 event(`HUMAN_APPROVAL_REQUIRED`/
`SECURITY_BLOCKED`/`RUN_BLOCKED` 등, § `notification.ts`)가 있고, 그 event들은 production 코드
경로(`autodev.ts`/`orchestrator.ts`)에서만 기록된다 — 이 Skill이 그 판정을 대신하지 않는다.

## 완료 절차

**0) `git status` / `git diff`로 현재 working tree 확인.** 의도하지 않은 변경, 이전 세션이 남긴
uncommitted 작업이 있는지 먼저 확인한다 — 사용자의 명시적 지시 없이 기존 변경을 삭제/덮어쓰지
않는다.

**1) Acceptance Criteria를 실제로 만족하는지 재확인.** 코드를 작성했다는 사실만으로 완료로
판단하지 않는다.

**2) Targeted test → 전체 회귀.** 지금 바꾼 모듈의 `npm run test:<module>`을 먼저 돌리고,
완료 전에는 반드시 **모든 `test:*` 스크립트**(smoke-test류는 제외, § `.claude/CLAUDE.md`)를
실행해 FAIL 0을 확인한다. 기존 보안 테스트를 삭제/약화해서 새 테스트를 통과시키지 않는다.

**3) typecheck.** `npx tsc --noEmit`. Windows에서 npm/npx의 `spawnSync` ENOENT/EINVAL이
재현되면(§ `self-dev-complete.ts` 상단 주석에 기록된 실측 문제) 다음으로 우회한다:
`node node_modules/typescript/bin/tsc --noEmit`.

**4) build.** `npm run build` (또는 동일한 이유로 `node node_modules/typescript/bin/tsc`).

**5) 변경 파일만 정확히 stage하고 commit.** `git add -A`/`git add .` 금지 — 이번 Task에서 실제로
바뀐 파일만 경로를 지정해 stage한다. `git status`로 예상치 못한 파일이 섞이지 않았는지 확인한 뒤
commit한다.

**6) push가 필요한 Task라면.** origin과의 divergence를 먼저 확인하고, fast-forward push만
수행한다(force push 금지). push 후 실제로 반영됐는지 확인한다.

**7) Self-Dev Task Completion Bridge 실행 — 이 Task가 만드는 유일한 완료 신호.**

```
npm run self-dev:complete -- --task-id <TaskId> [--push]
```

- `<TaskId>`는 이 저장소의 Task 식별자(예: `G7.2.1`)다.
- 이 Task가 push까지 요구했다면 `--push`를 반드시 붙인다(붙이지 않으면 이 bridge는 push
  여부를 검증하지 않는다 — 요구사항을 느슨하게 만들지 않도록 실제로 push가 필요했는지 먼저
  확인한다).
- `AUTODEV_PROJECT_ADAPTER`가 로컬에 설정돼 있지 않다면(gitignored `.env`, § 아래 "로컬 설정")
  `--project <manifest.json 경로>`를 직접 지정한다.

이 명령은 **호출자가 주장하는 값을 신뢰하지 않는다** — 이 저장소를 대상으로 typecheck/build/
전체 회귀를 자체적으로 다시 실행하고, git으로 HEAD commit과(`--push`가 있으면) push 반영 여부를
직접 재확인한 뒤에만 `TASK_COMPLETED`를 기록하고 기존 production notification 경로(EventStore →
notification-service.ts → NotificationStore/dedupe → telegram-controller.ts → Telegram
Provider)로 전달을 시도한다. 1)~6)을 건너뛰고 이 명령만 실행해도, 이 재검증 자체가
fail-closed이므로 실패 상태에서는 event가 만들어지지 않는다.

## 아키텍처 — 단일 판정 출처

```
notify-task-completed.ts (사람이 명시적으로 실행하는 CLI, evidence를 flag로 주장)
self-dev-complete.ts     (이 Skill이 호출하는 자동 bridge, evidence를 이 저장소에서 직접 재실행)
                              │
                              ▼  둘 다 아래 세 함수만 호출한다(단일 출처)
                    self-dev-completion.ts
                      - validateSelfDevCompletionEvidence()
                      - recordSelfDevTaskCompleted()          → EventStore(TASK_COMPLETED,
                                                                  projectId="autodev-core-self-dev",
                                                                  deterministic runId=hash(taskId,commit))
                      - deliverSelfDevCompletionNotification() → telegram-controller-supervisor.ts
                                                                  (singleton controller 시작/재사용)
                                                                → notification-service.ts
                                                                → Telegram
```

`projectId`는 의도적으로 대상 프로젝트(예: `movan`)를 쓰지 않는다 — `autodev-core-self-dev` 고정값
이다(AutoDev repo/대상 project leakage 없음). `runId`는 `taskId`+`commitHash`의 결정론적 해시라,
같은 Task/commit으로 이 명령을 여러 번 실행해도(재시도, 중복 호출) 새 event/중복 알림이 생기지
않는다(idempotent — `notification.ts`의 `dedupeKey`가 이 `runId`를 기준으로 dedupe한다).

## 로컬 설정 — `AUTODEV_PROJECT_ADAPTER`

`self-dev-complete.ts`/`notify-task-completed.ts`는 controller singleton을 시작하는 데 필요한
GitSafety/cwd 컨텍스트로만 project manifest를 쓴다(대상 프로젝트의 실행 로직에는 관여하지 않는다).
`--project`를 매번 지정하지 않으려면, 이미 존재하는 대상 프로젝트의 wrapper manifest(예: MOVAN
저장소의 `.autodev/manifest.json`)를 가리키는 절대경로를 이 저장소의 **gitignored** `.env`에
`AUTODEV_PROJECT_ADAPTER=<절대경로>`로 로컬에만 설정한다. Bot Token/Chat ID 등 실제 secret 값은
이 설정과 무관하게 `.env`에만 있고, 이 Skill이나 completion bridge 어디에도 원문으로 노출되지
않는다(§ `telegram-controller-supervisor.ts` — ownership/status metadata에 credential을 담지
않음).

## 완료 후

Task를 `COMPLETED`로 보고한다. 다음 Task/Phase를 자동으로 시작하지 않는다(§ `.claude/CLAUDE.md`
Task 범위). 세션이 끊기면 이 저장소의 실제 상태(git 이력, `logs/events.jsonl`)를 다시 조사해
이어서 판단한다 — 이전 대화 내용만으로 완료 여부를 판단하지 않는다.
