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
D1 CandidateSource 어댑터)를, Task D3는 D2의 EvidenceSource 위에 실제 공식 JSON
metadata endpoint에서 evidence를 가져오는 범용 Source Adapter(`src/source-adapter.ts`
— HTTP fetch seam/timeout/응답 크기 제한/redirect 거부/SSRF 방지 URL 검증/"source가
official을 자기 주장만으로 확정 못함" 설계)를, Task D4는 D1+D2+D3를 하나의 Discovery
흐름으로 배선하는 Official Source Catalog & Discovery Orchestration
(`src/discovery-orchestrator.ts` — 프로젝트에 하드코딩되지 않는 범용 SourceCatalog
구조, requirement→관련 있는 active source만 선택→D3 조회→D2 판정까지 한 함수
(`discoverCapability`)로 연결, 새 평가 로직 없이 D1/D2/D3 재사용만)를, Task D5는 실제로
존재/유지되는 공식 source 3건(GitHub REST API 하나로 통합 — Anthropic 공식 TypeScript
SDK/MCP 공식 reference servers/Puppeteer 공식 저장소, 2026-08-21 확인)을 bootstrap한
Real Official Source Catalog(`src/real-source-catalog.ts`)를 구현했다. Task E1은 API/
공식 metadata/일반 HTTP로도 부족할 때만 쓰는 최후 수단 Browser Worker의 Core 실행모델과
보안 경계(`src/browser-worker.ts` — 닫힌 BrowserAction union, D3의
`isPrivateOrMetadataHost()`를 재사용하는 URL/navigation validator, 11개 Core 고위험
범주 + CLICK_SAFE 키워드 분류, redirect 재검증, deterministic fake backend)를
구현했다. Task E2는 E1의 BrowserBackend를 실제 Playwright(공식 `playwright@1.62.1`,
Apache-2.0)로 구현하고(`src/playwright-browser-backend.ts`), 클릭 직전 DOM 구조적
신호(tag/type/href/target/download attribute/form action·method/input type/
password·credential 관련 여부)를 검사하는 Safe Interaction Preflight를
`assessClickTargetStructure()`(E1에 순수 추가)로 구현했다. Task E2.1은 `npx
playwright install chromium`(공식 CLI, Chromium만)으로 실제 브라우저를 설치해
격리된 로컬 fixture(page.setContent)로 실제 Chromium end-to-end(생성→READ_PAGE/
EXTRACT_TEXT/FIND→안전 클릭 실제 DOM 변경 확인→download/password 클릭이 Preflight로
사전 거부됨→SCREENSHOT→dispose) 11/11 PASS를 확인했고, Playwright의 optional
transitive dependency `fsevents@2.3.2`가 C5에서 `install-script-new-dependency`
(human_review)로 정확히 분류됨을 재확인했다(scanner 규칙 변경 없음). Task F1은 AutoDev가
Task 성격에 따라 필요한 전문 Agent만 선택하는 Core Agent Registry & Deterministic
Router(`src/agent-registry.ts` — 초기 6개 role(planner/research/developer/qa/
reviewer/security), developer 외 canWriteCode 금지 Core hard rule, taskType별
정적 워크플로+dependency 표현, LLM을 전혀 호출하지 않는 순수 함수 `routeTask()`)를
구현했다. Task F2는 그 RoutingPlan을 실제로 실행하는 Agent Execution Orchestration
(`src/agent-orchestrator.ts` — `executeRoutingPlan()`이 dependency가 충족된 step만
순서대로 실행하고, developer/reviewer/read-only 4개 role 모두 기존 Core 실행 경로
(claude-developer.ts/gpt-reviewer.ts/claude-runner.ts)를 그대로 재사용하며, QA
의견이 아니라 실제 required tests exit code가 최종 판정을 결정, 자세한 내용은
`.claude/CLAUDE.md` 참고)을 구현했다. D1~F2 모두 실제 외부 MCP 설치/실행이나 실제
병렬 Agent 실행, REVISE 자동 handoff loop를 하지 않는다 — Notification Service /
Dashboard는 아직 시작하지 않았다.

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
- 실제 MCP 서버 설치/다운로드/활성화(D1~D5는 Discovery/Resolver/Evidence/Source
  Adapter/Orchestration/Catalog Bootstrap의 Core 데이터 모델·판정·조회·배선·실제
  catalog 등록까지만 구현했다 — 실제 활성화 실행 경로, Browser Worker, Agent Router는
  없음)
- production credential을 실제로 사용하는 evidence/candidate 조회
- npm registry 기반 evidence source(D5에서 이번 세션의 조회 도구로 `time.modified` 필드
  존재를 신뢰성 있게 재확인하지 못해 의도적으로 제외했다 — 필요해지면 별도 Task에서
  공식 문서를 다시 확인하고 등록한다)
- MCP/API-SDK/CLI 외의 다른 capability domain(payment_or_financial/deployment/
  communication/storage 등)을 위한 real catalog entry(D5는 대표적인 3건만 최소
  bootstrap했다 — "많이 등록하지 않는다" 원칙)
- 로그인 자동화, password/credential을 실제로 입력하는 흐름(BrowserAction에 그런
  action 자체가 없다 — 향후 필요해지면 별도 Task에서 명시적으로 설계해야 한다)
- 고위험 browser action(파일 다운로드/업로드/결제/구매/production 변경 등)의 "사람
  승인 후 실제 실행" 경로(E1/E2는 HUMAN_APPROVAL_REQUIRED/BLOCKED 판정과 실제 클릭
  거부까지만 하고, 그 이후 실행 흐름은 구현하지 않았다)
- 실제 사이트(외부 네트워크) 자동조작 — E2.1은 Chromium 바이너리를 설치하고 실제
  브라우저 wiring/Preflight를 격리된 로컬 fixture로 검증했을 뿐, 실제 외부 웹사이트를
  대상으로 한 자동조작은 여전히 하지 않았다
- 멀티 페이지(popup에서의 추가 action) 워크플로 — E2는 popup을 검증 후 항상 즉시 닫을
  뿐, popup 페이지에서 추가 action을 실행하는 기능은 구현하지 않았다
- 실제 병렬 Agent 실행, Agent-to-Agent 대화, Agent가 임의로 새 Agent를 생성하는 기능
  (F1/F2 모두 순차 실행만 구현했다)
- Agent Execution Orchestrator(F2)를 실제 orchestrator.ts/autodev.ts 파이프라인에
  연결하는 작업(F2는 agent-orchestrator.ts를 독립 모듈로만 추가했고, 기존 실행 경로
  (claude-developer.ts/gpt-reviewer.ts/orchestrator.ts/autodev.ts)는 전혀 수정하지
  않았다)
- REVISE 자동 handoff loop(F2는 reviewer가 REVISE를 반환하면 그 결과를 그대로
  보고할 뿐 developer를 자동으로 다시 부르지 않는다 — orchestrator.ts의 기존 REVISE
  루프와는 별개다)
- 토큰 사용량 실측 Dashboard(F1/F2는 "필요한 Agent만 선택 + 최소 context 전달"이라는
  구조적 절감만 구현했고, 실제 토큰 측정/표시는 하지 않았다)
- read-only agent 응답에서 "자신의 권한 밖 action이 필요하다"는 요청을 자유 텍스트에서
  안정적으로 파싱하는 기능(F2의 `requestedPermission` 자기보고 필드는 타입/enforcement
  로직만 구현했고, 실제 운용 read-only runner는 이 필드를 채우지 않는다 — fake runner를
  쓰는 테스트에서만 채워 enforcement 자체를 검증한다)
- Command Execution Safety Gate(`coreCommandSafetyGate`, `src/safe-executor.ts`)의 실행
  파일 identity/trust 검증. SI-3.4(Command Execution Safety Architecture Closure)는 "어떤
  executable/wrapper 이름을 호출할 수 있는가"를 STRICT ALLOW-LIST(`CORE_ALLOWED_
  EXECUTABLE_FAMILIES` = git/npm/npx/node/tsc, bare 이름만 허용 — 경로 구분자/드라이브
  문자가 있으면 무조건 거부)로 닫았고, family 안에서도 git 서브커맨드/node eval·preload
  플래그/npm·npx 위임 형태를 추가로 제한했다. 하지만 이 gate는 spawn 시점에 그 bare 이름이
  실제로 PATH/cwd 탐색을 거쳐 어떤 파일을 가리키는지는 검증하지 않는다 — project-writable
  디렉터리가 PATH보다 먼저 탐색되거나 cwd에 동일 이름의 가짜 실행 파일(`git`/`node`/
  `git.cmd` 등)이 있으면 그 파일이 실제 git/node 대신 실행될 수 있다(PATH/cwd executable
  shadowing). 이 gap은 SI-3.4가 새로 만든 것이 아니라 Phase B의 최초 `allowedCommands`
  도입 이후 어떤 Task(C4/C4.1/C4.2/SI-3.3 포함)도 다루지 않았던 기존 특성이다 — SI-3.4
  bounded GPT Independent Review 3라운드에서 지적됐고, 닫으려면 canonical 절대 경로 해석·
  신뢰된 설치 경로 pinning 같은 별도의 "Verified Executable Trust Store" 성격의 새 Task가
  필요하다고 판단해(새 shell/parser를 만들지 않는다는 SI-3.4의 제약과 근본적으로 상충)
  SI-3.4 범위에서는 제외했다. 이 문서에 적혀 있다는 사실 자체가 착수 승인을 의미하지
  않는다 — 이 항목도 명시적으로 지정된 별도 Task에서만 구현한다.
