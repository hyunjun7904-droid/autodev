# AutoDev 개발 가이드

AutoDev는 여러 프로젝트(MOVAN 등)를 대상으로 실행되는 범용 자동 개발 오케스트레이션
엔진이다. MOVAN repository와 물리적으로 분리된 standalone Node.js/TypeScript
패키지다(Phase B Task B2). 이 저장소 소스는 어떤 특정 프로젝트도 알지 못한다 — 실행
대상 프로젝트(read/write 허용 경로, task registry, project state 등)는 항상 외부
project adapter(`--project` / `AUTODEV_PROJECT_ADAPTER`)로 명시적으로 주입받는다
(Phase B Task B3, External Project Adapter 분리).

## 세션 / Task 운영 원칙

Claude Worker 세션 운영, GPT Reviewer 전달 범위, context 관리 원칙은
[`.claude/rules/development-operations.md`](rules/development-operations.md)를 따른다.

## 보안 — Core hard rule

- **Safe Executor**(`src/safe-executor.ts`) — 어디를 읽고/쓰고/실행할 수 있는지 통제한다.
  `DENY_PATH_PATTERNS`/`SECRET_NAME_PATTERNS`/`ENV_FILE_PATTERNS`는 어떤
  `ProjectExecutionPolicy`도 약화시킬 수 없는 Core 상수다.
- **Deterministic Secret Scanner Gate**(`src/secret-scanner.ts`) — commit(checkpoint)
  대상 파일에 secret/API key/token/password/private key가 포함됐는지 정규식 기반으로
  판정하고, 발견 시 `performTaskCheckpoint`가 git add조차 실행하기 전에 BLOCK한다.
  AI 판단에 의존하지 않으며, 어떤 policy/옵션도 받지 않아 프로젝트가 우회할 수 없다.
  자세한 구조는 `src/secret-scanner.ts` 상단 주석 참고.
- **Core Command Safety Gate**(`src/safe-executor.ts`의 `coreCommandSafetyGate`, Phase C
  Task C4 — Hooks / Permissions Enforcement) — RUN_COMMAND가 `validateCommand()`로
  `policy.allowedCommands`(project 소유 exact-match allow-list)를 확인하기 *전에* 항상
  먼저 적용되는 PreToolUse 성격의 Core hard rule이다. (1) git은 read-only로 명시적으로
  확인된 서브커맨드(status/diff/log/show 등, `stash list`/`branch --list` 같은 세부
  read-only 형태 포함)만 통과하고 그 외(reset/clean/rebase/push/checkout/restore/commit/
  stash push·pop·drop 등)는 project policy의 allowedCommands에 그 조합이 들어있어도 항상
  BLOCK한다. (2) 명령 인자가 ENV_FILE_PATTERNS/SECRET_NAME_PATTERNS(단일 출처, path 검증과
  동일한 상수)에 매칭되면 git이 아닌 명령이라도 BLOCK한다. 이 함수는 ProjectExecutionPolicy를
  인자로 받지 않으므로 어떤 프로젝트도 이 판정을 약화시킬 방법이 없다. (3) Phase C Task
  C4.1(Read-only Git Command Hardening) — subcommand 이름만으로는 안전을 판정하지 않는다.
  `GIT_DANGEROUS_OPTION_PATTERNS`(`--output`/`--ext-diff`/`--textconv`/`--filters`/
  `--paginate`/`--contents=`)가 read-only로 확인된 git 서브커맨드에 붙어도 항상 BLOCK한다 —
  이 옵션들은 git 공식 문서 기준으로 임의 파일 쓰기(`--output`, write path 검증 우회)나
  외부 프로그램 실행(`--ext-diff`/`--textconv`/`--filters`, diff/textconv/필터 드라이버),
  임의 로컬 파일 읽기(`--contents=`)를 유발할 수 있다. `git remote show <name>`은 `-n`
  없이는 실제 원격 서버에 네트워크 질의를 보내므로 `-n`이 있을 때만 read-only로 인정한다.
- 실제 secret 원문은 console / log / error / GPT review prompt / Claude feedback /
  audit output 어디에도 노출하지 않는다 — 탐지 보고에는 파일/위치/탐지 종류만 담는다.

세 모듈의 책임은 명확히 분리된다: Safe Executor(경로 접근 범위 + 명령 실행 자체의 Core
안전 게이트), Secret Scanner(commit 직전 내용 검사), 그리고 명령 실행 permission
(`policy.allowedCommands`)은 project 소유이되 Core Command Safety Gate 위에서만 동작한다.

## 향후 운영 요구사항 (미구현)

아직 구현되지 않은 장기 설계 요구사항(Notification Service, 모바일 승인 흐름 등)은
[`.claude/rules/future-operations.md`](rules/future-operations.md)에 기록한다. 이
문서의 항목은 명시적으로 지정된 Task에서만 구현하며, 이 문서에 적혀 있다는 사실 자체가
구현 승인을 의미하지 않는다.

## 검증

- TypeScript 변경 시: `npx tsc --noEmit`
- 빌드: `npm run build`
- 개별 테스트: `npm run test:<module>` (`package.json`의 `scripts` 참고)
- Task 완료 전 전체 회귀(모든 `test:*` 스크립트) PASS 필수 — 기존 보안 테스트를
  삭제하거나 약화해서 새 테스트를 통과시키지 않는다.

## Task 범위

항상 현재 지정된 Task만 수행한다. 다음 Task/Phase를 자동으로 시작하지 않는다. 상세
Git 안전 / 검증 규칙은 이 저장소를 대상으로 실행되는 각 Task Prompt(Hybrid Thin
Prompt 원칙)에 따르되, 이미 이 문서와 rules 파일에 기록된 규칙은 반복 설명하지
않는다.
