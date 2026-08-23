---
name: task-complete
description: Use when a Task on the AutoDev standalone repository itself (self-dev — developing AutoDev's own source under src/, not a target project it executes) appears finished and you are about to report it as complete. Runs the canonical verification → commit → push → Self-Dev Task Completion Bridge sequence so TASK_COMPLETED / the Telegram "🟡 작업 단계 완료" (or, only with explicit --final, "✅ 최종 완료") notification is only ever created after real, freshly re-verified evidence — never from a Claude Code session simply stopping.
---

# AutoDev Self-Dev Task Completion

이 Skill은 **AutoDev standalone repository 자신을 개발하는 Task**(`src/`, `.claude/`, `package.json`
등 이 저장소 자신의 소스)를 완료 처리할 때만 쓴다. AutoDev가 실행하는 대상 프로젝트(예: MOVAN)의
Task 완료는 이 Skill의 대상이 아니다 — 그쪽은 이미 `checkpoint.ts`/`orchestrator.ts`의 production
checkpoint 파이프라인이 전담한다.

**핵심 원칙 — Claude Code 세션이 끝났다는 사실 자체는 완료의 증거가 아니다.** Stop hook이나
"작업을 다 했다"는 자기보고만으로 TASK_COMPLETED를 만들지 않는다. 아래 순서를 전부 사람이/Claude가
직접 실행하고 실제로 통과한 뒤에만, `self-dev-complete.ts`(deterministic bridge)가 그 evidence를
**이 저장소를 대상으로 직접 재검증**한 뒤에만 event가 만들어진다(§ 아키텍처는 아래 참고). 즉 이
Skill 자체를 건너뛰고 evidence를 조작해 CLI에 거짓 flag를 넘겨도, 마지막 bridge 재검증이
fail-closed로 막는다.

**Phase G Task G7.3.1b 이후 — bridge 호출은 자동이다.** 이전에는 아래 절차의 마지막 단계
(`npm run self-dev:complete`)를 Claude가 직접 기억해서 실행해야 했고, 실제로 이 단계가 누락돼
완료 알림이 오지 않은 사고(G7.3.1a)가 있었다. 이제는 **step 5(아래)에서 context를 선언하기만
하면, 이후 commit/push가 성공하는 순간 PostToolUse hook(`.claude/settings.json` →
`.claude/hooks/self-dev-completion-hook.js` → `dist/self-dev-completion-hook.js`)이
`dist/self-dev-complete.js`를 자동으로 호출**한다. **Claude는 정상 경로에서 `npm run
self-dev:complete`/`npm run notify:task-completed`를 직접 실행하지 않는다** — 직접 실행하면
이 자동화가 실제로 동작하는지 검증할 수 없게 된다. hook이 실행되면 다음 turn에
`[self-dev completion hook] ...` systemMessage로 결과(성공/실패)가 보인다. push(또는
commit-only Task라면 commit) 이후 이 메시지가 전혀 보이지 않는다면, 대개 아래 step 5(context
선언)를 빼먹은 것이다 — 그때만 원인을 재확인하고, 임의로 수동 명령을 대신 실행하지 않는다(사람에게
알리고 STOP).

## 언제 이 Skill을 쓰지 않는가 — 즉시 STOP, terminal status bridge 실행

다음 중 하나라도 해당하면 이 Skill(완료 절차)을 실행하지 않는다. 이런 상태에서 TASK_COMPLETED를
만들면 안 된다(§ 요구사항):

- Task의 Acceptance Criteria를 아직 다 만족하지 못했다.
- required tests/typecheck/build 중 하나라도 FAIL이다(단, **고칠 수 있는** test/build/typecheck
  실패는 BLOCKED가 아니다 — 문제를 고쳐서 계속 진행한다. 더 이상 안전하게 자동으로 진행할 수
  없는 구조적 문제일 때만 아래 BLOCKED다).
- 사람의 승인/확인이 필요한 상태다(WAITING_HUMAN) — 예: production DB/배포/등 `policy.ts`의
  `ALWAYS_HUMAN` 대상 작업이 있거나, 범위를 벗어난 결정이 필요하다.
- 보안 게이트(Safe Executor/Secret Scanner/Dependency Scanner/Core Command Safety Gate)가
  BLOCK했다.
- git 상태가 불확실하다(merge/rebase/cherry-pick 진행 중, 의도하지 않은 변경 혼입 등).

**Task를 `BLOCKED` 또는 `WAITING_HUMAN`으로 최종 보고한다고 실제로 판정했다면, 그 보고를 하기
전에 반드시 아래 canonical self-dev terminal-status 명령을 먼저 실행한다(Phase G Task
G7.3.2)** — 이 저장소 자신을 개발하는 Task에서 발생한 BLOCKED/WAITING_HUMAN을 사람이 매번
"Telegram 보내라"고 따로 지시하지 않아도 알려주기 위함이다:

```
npm run self-dev:blocked -- --reason "<짧고 안전한 사유>"
npm run self-dev:waiting-human -- --reason "<짧고 안전한 사유>"
```

- 먼저 `npm run self-dev:begin -- --task-id <TaskId>`(§ step 5, 완료 전 아무 때나 미리 실행해도
  된다 — 이 명령들도 그 context를 그대로 재사용한다)로 이 Task의 taskId를 선언해 두어야 한다.
  선언이 없으면 이 명령들은 아무 event도 만들지 않고 실패한다(fail-closed) — 그때만 먼저
  `self-dev:begin`을 실행한 뒤 다시 시도한다. taskId를 transcript/commit message에서 추측하지
  않는다.
- `--reason`은 짧고 안전한 사유만 담는다(빈 값 금지, 200자 이내, Bot Token/API key/전체
  prompt/전체 Claude·GPT 출력/전체 stack trace 금지 — 그런 값은 `self-dev-terminal-status.ts`의
  `validateSelfDevTerminalReason()`이 거부한다).
- 이 명령은 `self-dev:begin`이 선언한 context를 **소비(삭제)하지 않는다** — Task가 이후 실제로
  완료되면 여전히 기존 completion 절차(step 5~8)가 정상 동작한다.
- BLOCKED는 기존 `RUN_BLOCKED`(CRITICAL) 알림 경로를, WAITING_HUMAN은 신규
  `SELF_DEV_WAITING_HUMAN` 알림 경로를 재사용한다(둘 다 `notification-service.ts`/
  `telegram-controller.ts`를 그대로 재사용 — 새 provider/controller/queue 없음). 두 경로 모두
  `approval-service.ts`가 명시적으로 ApprovalRequest 생성 대상에서 제외한다 — Telegram에
  Approve/Reject/Defer 버튼이 절대 뜨지 않는다(실제 resumable production action이 없으므로).
  같은 taskId+terminalStatus+reason으로 다시 실행해도 중복 event/알림은 만들어지지 않는다
  (dedupe, § `self-dev-terminal-status.ts`).
- 이 명령들을 실행한 뒤 Task를 `BLOCKED`/`WAITING_HUMAN`으로 보고하고 멈춘다. Stop hook이나
  세션 종료 자체를 BLOCKED/WAITING_HUMAN으로 추측해서 자동 트리거하지 않는다 — commit/push
  PostToolUse hook(§ 아래 "자동 트리거 아키텍처")은 여전히 COMPLETED 전용이다. BLOCKED/
  WAITING_HUMAN은 commit이 없을 수도 있으므로, 이 별도의 명시적 명령이 유일한 경로다.

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

**5) Self-Dev Task Context 선언 — commit 전후 아무 때나(늦어도 push 전까지).**

```
npm run self-dev:begin -- --task-id <TaskId> [--push] [--final]
```

- `<TaskId>`는 이 저장소의 Task 식별자(예: `G7.3.1b`)다. 추측/생략 금지 — 명시적으로 알고 있는
  값만 넘긴다.
- 이 Task가 push까지 요구한다면 `--push`를 반드시 붙인다(아래 step 7과 반드시 일치해야 한다 —
  여기서 `--push`를 붙였는데 실제로 push를 하지 않으면 hook이 계속 push를 기다리기만 하고
  트리거되지 않는다).
- 이 명령은 **완료를 주장하지 않는다** — 로컬 전용(gitignored) context 파일에 "지금부터 이어지는
  commit(+push)이 이 taskId에 대응한다"는 사실과 현재 HEAD(baseline)만 남긴다(§
  `self-dev-task-context.ts`). 실제 완료 판정은 여전히 아래 자동 트리거가 호출하는
  `self-dev-complete.ts`가 전담한다.
- **`--final`(Phase G Task G7.5)은 기본적으로 붙이지 않는다.** 붙이지 않으면 이 Task는 항상 🟡
  "작업 단계 완료"(다음 프로젝트 시작 가능: 아니오)로만 알린다 — 대부분의 Task는 이 기본값이
  맞다. **`--final`은 이 Task가 끝나면 지금 진행 중인 상위 Task/Phase(또는 지시받은 전체 작업)가
  정말로 더 기다릴 것 없이 끝난다고 사용자/Task Prompt가 명시적으로 확인했을 때만** 붙인다 —
  세션이 끝나간다거나 "이 정도면 충분히 한 것 같다"는 자체 판단으로 붙이지 않는다(추측 금지).
  `--final`을 붙여도 typecheck/build/전체 회귀/commit/(필요시)push 재검증 요건은 전혀 완화되지
  않는다 — `--final`이 하는 일은 오직 "재검증을 전부 통과하면 ✅ 최종 완료로 알린다"는 표시뿐이다.

**6) 변경 파일만 정확히 stage하고 commit.** `git add -A`/`git add .` 금지 — 이번 Task에서 실제로
바뀐 파일만 경로를 지정해 stage한다. `git status`로 예상치 못한 파일이 섞이지 않았는지 확인한 뒤
commit한다. **push가 필요 없는 Task라면 이 commit이 성공하는 순간 hook이 자동으로 완료 조건을
재검증한다** — 이후 아무 것도 수동으로 실행하지 않는다.

**7) push가 필요한 Task라면.** origin과의 divergence를 먼저 확인하고, fast-forward push만
수행한다(force push 금지). **이 push가 성공하는 순간 hook이 자동으로 완료 조건을 재검증한다** —
이후 아무 것도 수동으로 실행하지 않는다.

**8) 완료 신호는 자동이다 — 확인만 한다.** step 5에서 선언한 context와, step 6/7의 commit(또는
push)이 성공하면, PostToolUse hook이 `dist/self-dev-complete.js --task-id <TaskId> [--push]
[--final]`를 자동으로 호출한다(§ 아래 "자동 트리거 아키텍처"). Claude는 다음 turn에 나타나는
`[self-dev completion hook] ...` systemMessage로 결과만 확인한다:

- 성공 메시지가 보이면 완료다(다음 절차 없음) — Telegram은 step 5에서 `--final`을 붙이지 않았으면
  🟡 "작업 단계 완료"(다음 프로젝트 시작 가능: 아니오), `--final`을 붙였으면 ✅ "최종 완료"(다음
  프로젝트 시작 가능: 예)로 온다.
- `FAILED`가 보이면 완료 조건을 충족하지 못한 것이다(원인은 메시지에 그대로 담겨 있다 —
  typecheck/build/전체 회귀/push 중 하나) — 문제를 고치고 다시 step 6/7(commit 또는 push)을
  반복한다. context는 실패 시 그대로 유지되므로 step 5를 다시 실행할 필요는 없다. Phase G Task
  G7.5부터는 이 실패도 ❌ "최종 미완료" Telegram으로 함께 통보된다(§ `self-dev-terminal-status.ts`
  `SelfDevTerminalStatus="FAILED"`) — 콘솔 메시지만 보고 넘어가지 않아도 된다.
- 아무 메시지도 보이지 않으면(가장 흔한 원인) step 5를 빼먹었거나 `--push` 지정이 step 7과
  어긋난 것이다 — 이 경우에만 원인을 재확인하고, **임의로 `npm run self-dev:complete`를 대신
  실행하지 않는다**(사람에게 알리고 상태를 `BLOCKED`/`WAITING_HUMAN`으로 보고한 뒤 STOP —
  hook 자체가 고장났는지 원인 파악이 먼저다. § 아래 "Hook을 못 쓰는 예외적인 경우").

## Hook을 못 쓰는 예외적인 경우

이 저장소가 아닌 다른 환경(hooks가 비활성화된 세션 등)에서 부득이하게 수동으로 완료 신호를
만들어야 한다면, 사람에게 그 사실을 명시적으로 알리고 승인을 받은 뒤에만
`npm run self-dev:complete -- --task-id <TaskId> [--push] [--final]`를 직접 실행한다. 이것은 예외
경로이지 정상 경로가 아니다 — 정상 경로에서 이 명령을 Claude가 스스로 판단해서 직접 실행하면 이
Task(G7.3.1b)가 검증하려는 것(자동 트리거가 실제로 동작하는가)을 증명할 수 없다.

## 자동 트리거 아키텍처 — 단일 판정 출처

```
.claude/settings.json (PostToolUse/Bash) → .claude/hooks/self-dev-completion-hook.js (IO만)
                                              │
                                              ▼
                        dist/self-dev-completion-hook.js (src/self-dev-completion-hook.ts)
                          - decideSelfDevCompletionTrigger() — git push/commit 감지 +
                            self-dev-task-context.ts에 선언된 taskId/pushRequired/baseline
                            HEAD를 읽어 "지금 트리거해야 하는가"만 판정(추측 없음, 없으면
                            트리거 안 함)
                          - runSelfDevCompletionHook()      — 트리거 조건 충족 시에만
                            dist/self-dev-complete.js를 호출하고, 성공하면 context를 소비
                            (clear)한다. 실패하면 context를 남겨 재시도를 허용한다.
                              │
                              ▼
notify-task-completed.ts (사람이 명시적으로 실행하는 CLI, evidence를 flag로 주장)
self-dev-complete.ts     (hook이 호출하는 자동 bridge, evidence를 이 저장소에서 직접 재실행)
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

**TASK_COMPLETED를 실제로 만들지 말지는 여전히 전적으로 `self-dev-complete.ts` →
`self-dev-completion.ts`의 deterministic 재검증이 결정한다** — hook(`self-dev-completion-hook.ts`)은
"지금이 그 스크립트를 호출할 시점인가"만 판정할 뿐, 완료 여부를 스스로 판정하지 않는다. hook
판정이 틀려서 엉뚱한 시점에 호출되더라도(예: 잘못된 명령 매칭), 아래 재검증이 fail-closed이므로
완료 조건을 충족하지 못한 상태에서는 여전히 event가 만들어지지 않는다.

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
