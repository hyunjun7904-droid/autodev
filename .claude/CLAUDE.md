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
- **Deterministic Dependency / Supply-chain Scanner Gate**(`src/dependency-scanner.ts`,
  Phase C Task C5) — commit(checkpoint) 대상에 `package.json`/`package-lock.json`
  변경이 있을 때만 실행되며(무관한 task는 파일시스템/네트워크 접근 없이 즉시 PASS),
  manifest/lockfile 일관성(npm lockfileVersion 2/3의 `packages[""]`가 package.json
  dependencies/devDependencies를 그대로 미러링해야 함), lockfile 존재 여부, 각 lockfile
  package entry의 설치 출처(insecure `http://`/git 미고정 참조는 BLOCK, git 커밋 SHA
  고정·`file:`·workspace link·신뢰된 registry(`registry.npmjs.org`) 밖 tarball URL은
  HUMAN_REVIEW_REQUIRED), integrity 필드 유무/형식, 신규(HEAD 대비 새로 생긴)
  `hasInstallScript` 패키지, 그리고 주입된 vulnerability audit source(운용 기본값은 공식
  `npm audit --json` — `npmAuditVulnerabilitySource`, 자동 `audit fix`/dependency
  upgrade는 수행하지 않음)의 Critical/High를 판정한다. 판정 결과는 PASS/BLOCK/
  HUMAN_REVIEW_REQUIRED 셋 중 하나이며, PASS가 아니면(BLOCK이든 HUMAN_REVIEW_REQUIRED든)
  `performTaskCheckpoint`가 git add조차 실행하기 전에 commit을 중단한다. Secret Scanner와
  마찬가지로 AI 판단에 의존하지 않으며, 어떤 policy/옵션도 받지 않아 프로젝트가 우회할 수
  없다(`PerformCheckpointOptions.dependencyVulnerabilityAuditSource`는 `cwd`와 동일한
  성격의 테스트 전용 seam일 뿐, 구조/source/integrity/install-script 검사는 이 값과 무관
  하게 항상 수행된다). 자세한 구조는 `src/dependency-scanner.ts` 상단 주석 참고.

네 모듈의 책임은 명확히 분리된다: Safe Executor(경로 접근 범위 + 명령 실행 자체의 Core
안전 게이트), Secret Scanner(commit 직전 내용 검사), Dependency / Supply-chain Scanner
(commit 직전 dependency 변경 검사), 그리고 명령 실행 permission(`policy.allowedCommands`)은
project 소유이되 Core Command Safety Gate 위에서만 동작한다.

## Capability Discovery & MCP Resolver — Core Design/Foundation

`src/capability-resolver.ts`(Phase D Task D1)는 새 프로젝트의 requirement에서 필요한
외부 capability를 구조화하고(`CapabilityRequirement`/`classifyRequirementDomain`),
MCP 서버/공식 API/SDK/CLI 등 구현 후보(`CapabilityCandidate`)를 deterministic 규칙만으로
평가·랭킹(`evaluateCandidate`/`rankCandidates`/`compareCandidates`)하는 기반이다. 이
Task는 **실제 외부 MCP를 설치/다운로드/실행하지 않는다** — Browser Worker/Agent
Router/Dashboard도 아직 시작하지 않았다. 외부 candidate catalog 조회는
`CandidateSource`(dependency-scanner.ts의 `VulnerabilityAuditSource`와 동일한 주입형
seam) 하나로 추상화돼 있고, `resolveCapability()`는 그 조회가 실패하면(`ok:false`)
근거 없이 아무 candidate도 자동 선택하지 않는다(`SOURCE_UNAVAILABLE`).

Core hard rule: `candidate.requiresSecret === true`이거나 `actionTags`에
`CORE_ALWAYS_HUMAN_APPROVAL_TAGS`(production DB write/배포/live trading·brokerage/
결제·금융 transaction/고위험 외부 action) 중 하나라도 있으면 `evaluateCandidate()`는
무조건 `HUMAN_APPROVAL_REQUIRED`로 판정한다 — `CapabilityResolverPolicy`는 이 목록에
항목을 **추가**만 할 수 있을 뿐(`additionalAlwaysHumanApprovalTags`), 대체/약화시킬
필드 자체가 타입에 없다. 이 판정은 승인 여부를 나타내는 분류값일 뿐이며, 이 모듈
자체는 Safe Executor/Secret Scanner/Core Command Safety Gate/Dependency Scanner를
전혀 우회하지 않는다(그 네 게이트 앞단에서 "무엇을 쓸지" 구조화만 한다).

`src/candidate-evidence.ts`(Phase D Task D2, Trusted Candidate Discovery & Evidence)는
D1의 `CandidateSource` seam 위에 후보의 출처/근거/신뢰도를 구조화한다 — D1
(`capability-resolver.ts`)은 이 Task에서 전혀 수정하지 않았다. `CandidateEvidence`는
source type(공식 vendor 문서 > 공식 repository > 공식 SDK/registry metadata > 신뢰
가능한 vendor-maintained > 일반 기술자료 > community_signal 순 신뢰 우선순위)/official
여부/publisher/maintenance 상태/최신성/permission/network·secret 요구/비용/license/
security signal/evidence 수집 시각을 담는 순수 입력 레코드이고, `evaluateEvidence()`가
그 근거의 신뢰도(`EvidenceConfidence`: `SUFFICIENT`/`UNKNOWN`/`HUMAN_REVIEW_REQUIRED`)를
deterministic하게 판정한다 — 근거가 부족하면 절대 추측으로 값을 채우지 않고 `UNKNOWN`
또는 `HUMAN_REVIEW_REQUIRED`로 남긴다. `detectEvidenceConflicts()`는 같은 candidate를
가리키는 evidence들이 핵심 필드(official/requiresSecret/requiresNetwork/
maintenanceStatus/costRisk)에서 서로 다른 값을 보고하면 다수결/최신값으로 조용히
병합하지 않고 무조건 `HUMAN_REVIEW_REQUIRED`로 승격한다. `discoverTrustedCandidates()`는
evidence source 조회가 실패하거나(`SOURCE_UNAVAILABLE`) evidence가 없으면
(`NO_EVIDENCE_FOUND`) 근거 없이 자동 선택하지 않는다.

Core hard rule은 D1과 동일한 설계를 그대로 재사용한다: `requiresSecret`과
`CORE_ALWAYS_HUMAN_APPROVAL_TAGS`(D1에서 import, 목록을 복제하지 않음)는 항상
`HUMAN_REVIEW_REQUIRED`를 강제하고, `TrustedDiscoveryPolicy`는 이 목록에 추가만
가능하다. staleness 기준(Core 기본값 180일)도 project policy(`maxStaleAfterDays`)로
더 엄격하게(짧게) 줄일 수만 있을 뿐, Core 기본값보다 크게 줘도 무시되고 늘려서 완화할
수 없다. `toCandidateSource()`는 D2의 신뢰도 판정을 통과한(`confidence==="SUFFICIENT"`)
candidate만 D1의 `CandidateSource`로 승격시켜 `resolveCapability()`가 그대로 소비할
수 있게 하는 어댑터다 — 근거가 부족한 candidate는 D1에 판단을 떠넘기지 않고 이
어댑터 단계에서부터 걸러낸다.

`src/source-adapter.ts`(Phase D Task D3, Official Candidate Source Integration)는 D2의
`EvidenceSource` 위에 실제 공식 JSON metadata endpoint에서 evidence를 가져오는 범용
Source Adapter를 더한다 — D1/D2 파일의 기존 동작은 바꾸지 않았다(D2에 기존 로컬
`KNOWN_ACTION_TAGS`를 `export`로 바꾼 것만 추가했다 — 순수 추가, 동작 변경 없음). MCP/
공식 API/SDK/CLI 후보 전부 `CapabilityType`(`type` 필드)만 다를 뿐 같은 JSON 스키마로
표현되므로 벤더별 adapter를 여럿 만들지 않고 `SourceAdapterConfig` 하나의 factory
(`fetchEvidenceFromOfficialJsonSource`/`createAsyncEvidenceSource`)를 재사용한다.

Core hard rule — **source는 스스로 official 여부를 주장할 수 없다**: fetch되는 JSON 응답
스키마(`RawCandidateMetadata`)에는 `official`/`sourceType`/`sourceRef`/
`evidenceTimestamp` 필드가 아예 존재하지 않는다 — 이 네 값은 오직 코드 레벨
`SourceAdapterConfig`(응답과 무관하게 배포 시점에 고정)로만 채워진다. 응답 바디에
`"official": true` 같은 필드를 끼워 넣어도 파싱 단계에서 아예 읽히지 않는다(테스트로
직접 검증됨).

SSRF 방지도 Core hard rule이다(`validateSourceUrl`) — https만 허용, URL에 embedded
credential(userinfo) 금지, `allowedHosts`(adapter 설정, 요청 내용으로 바뀌지 않는 고정
목록) 밖은 전부 거부, 그리고 **localhost/private network(10/8, 172.16/12, 192.168/16)/
link-local·cloud metadata endpoint(169.254/16, 169.254.169.254 포함)/IPv6 loopback·ULA·
link-local은 `allowedHosts`에 들어있어도 항상 차단**한다(defense in depth —
`validateSourceAdapterConfig`도 이런 host가 `allowedHosts`에 있으면 config 생성 자체를
throw로 막는다). 실제 fetch(`nodeHttpFetch`)는 `redirect:"manual"`로 3xx를 자동으로
따라가지 않고 즉시 거부하고, timeout(`AbortController`)과 응답 크기 한도
(`maxBodyBytes`, 초과 시 잘라서 계속 쓰지 않고 전체 거부)를 강제하며, 어떤 header/
credential도 요청에 추가하지 않는다(secret 자동 전송 금지 — `HttpFetch` 시그니처 자체에
그런 파라미터가 없다).

fetch로 얻은 evidence는 곧바로 신뢰되지 않는다 — `discoverTrustedCandidatesAsync()`가
비동기 fetch 결과를 D2의 동기 `discoverTrustedCandidates()`(판정 로직 그대로, 복제
없음)에 위임하므로, source 조회 실패/timeout/malformed response는 전부
`SOURCE_UNAVAILABLE`로, 그리고 secret 요구/Core action tag/충돌/stale evidence는 D2가
이미 강제하는 것과 동일하게 `HUMAN_REVIEW_REQUIRED`로 처리된다 — 이 adapter 계층은 그
판정을 약화시킬 방법이 없다.

`src/discovery-orchestrator.ts`(Phase D Task D4, Official Source Catalog & Discovery
Orchestration)는 D1+D2+D3를 하나의 흐름으로 배선한다: `CapabilityRequirement` →
(이 파일) `SourceCatalog`에서 관련 있는 `status:"active"` entry만 선택
(`selectRelevantSources` — domain은 D1의 `classifyRequirementDomain()`을 그대로
재사용) → 그 entry들만 D3(`createAsyncEvidenceSource`/`combineAsyncEvidenceSources`)로
조회 → D3의 `discoverTrustedCandidatesAsync()`가 D2의 판정에 그대로 위임. **평가/랭킹/
충돌/staleness/승인 판정 로직은 이 파일에 전혀 없다** — D1/D2/D3 파일도 이 Task에서
바꾸지 않았다(D3에 기존 로컬 `KNOWN_CAPABILITY_TYPES`/`KNOWN_EVIDENCE_SOURCE_TYPES`를
`export`로 바꾼 것만 추가 — D2의 `KNOWN_ACTION_TAGS` export와 동일한 순수 추가 패턴).
결과는 D2의 4개 상태를 그대로 1:1 매핑한 4개 상태(`SELECTED`/`HUMAN_REVIEW_REQUIRED`/
`NO_TRUSTED_CANDIDATE`/`SOURCE_UNAVAILABLE`)로만 나온다.

Core hard rule — **"알 수 없는 source 자동 호출 금지"**: `discoverCapability()`가 실제로
호출하는 URL은 오직 catalog entry의 고정 `endpointUrl`뿐이다 — `requirement`의 내용
(사람이 입력한 자유 텍스트, 조작 가능하다고 가정)으로부터 어떤 URL도 만들지 않는다.
관련 있는 catalog entry가 하나도 없으면(예: 그 capability domain을 다루는 source가
등록돼 있지 않음) 어떤 source도 호출하지 않고 즉시 `NO_TRUSTED_CANDIDATE`를 반환한다.
`CatalogSourceEntry`의 `allowedHosts`는 D3에 그대로 넘어가는 `canonicalHost` 하나뿐이라
"Source Catalog 밖 endpoint"는 애초에 조회 대상이 될 수 없다.

Core hard rule — **"공식 여부를 임의 문자열만으로 결정하지 않는다"**: `officialBasis`
(사람이 읽는 근거 설명)는 그 자체로 신뢰를 만들지 않는다 — `maxOfficiality:"official"`
entry는 `officialBasis`가 비어있거나 10자 미만이면 `validateSourceCatalog()`가 즉시
throw하고(placeholder 방지), 실제 official 상한은 D3의 구조적 검증(https 전용/
allowedHosts/localhost·private·metadata host 차단, `validateSourceAdapterConfig`+
`validateSourceUrl` 그대로 재사용 — SSRF 로직 복제 없음)을 그대로 통과해야만 catalog에
등록될 수 있다.

`src/real-source-catalog.ts`(Phase D Task D5, Real Official Source Catalog Bootstrap)는
D1~D4 구조를 그대로 쓰는 실제 공식 catalog 3건을 등록한다 — 전부 GitHub REST API
(`api.github.com`, 공식 문서로 필드 확인·public repo는 인증 없이 조회 가능함을 확인)
하나의 실제 vendor 통합만 쓴다: `anthropics/anthropic-sdk-typescript`(Anthropic 공식
조직 소유, npm의 `@anthropic-ai/sdk` `repository.url`이 가리킴), 
`modelcontextprotocol/servers`(MCP 공식 문서 사이트가 소개하는 프로토콜의 Anthropic
관리 reference server 저장소), `puppeteer/puppeteer`(Chrome DevTools 계보 공식 조직).
세 값 모두 2026-08-21에 실제 GitHub API를 직접 조회해 확인했다 — npm registry 기반
evidence는 이 세션의 조회 도구로 `time.modified` 필드 존재를 신뢰성 있게 재확인하지
못해 등록하지 않았다("오래됐거나 공식 여부가 불명확하면 등록하지 말고 보고한다" 원칙
적용).

D3에 `SourceAdapterConfig.responseMapper?: RawResponseMapper`(응답을 JSON.parse 직후·
스키마 검증 직전에 순수 재구성하는 훅, 실패 시 malformed response로 처리)를, D4의
`CatalogSourceEntry`에 동일한 필드를 추가했다 — 둘 다 optional field 추가뿐이라
기존 47/34개 테스트가 수정 없이 그대로 통과한다. `createGithubRepoResponseMapper()`
(`real-source-catalog.ts`)가 GitHub의 `full_name`/`archived`/`pushed_at`/
`license.spdx_id`/`stargazers_count` 같은 실제 응답 필드만 근거로 evidence를 조립한다
— `official`/`sourceType`/`sourceRef`/`evidenceTimestamp`에는 전혀 관여하지 않으며
(그 넷은 여전히 config/fetch 메타데이터로만 채워짐), `license.spdx_id==="NOASSERTION"`
이면 추측하지 않고 생략하고, `archived`처럼 필수 필드가 없으면 throw해 malformed
response로 처리된다.

실제 네트워크로 이 catalog를 검증하는 `real-source-catalog-smoke-test.ts`는
`smoke-test`/`gpt-smoke-test`와 동일하게 `test:` 접두사가 없는 별도 스크립트다 —
Task 완료 전 필수 전체 회귀(`npm run test:*`)에는 포함되지 않는다(외부 API 장애가
deterministic 회귀를 불안정하게 만들지 않기 위함). `real-source-catalog-tests.ts`
(전체 회귀에 포함됨)는 실제 네트워크를 전혀 쓰지 않고, 2026-08-21에 확인한 실제 응답을
그대로 스냅샷한 fixture로 매퍼/catalog/discoverCapability를 검증한다.

`src/browser-worker.ts`(Phase E Task E1, Browser Worker Safety Boundary & Core
Foundation)는 API/공식 metadata/일반 HTTP 조회로도 해결할 수 없을 때만 쓰는 최후
수단의 Core 실행모델이다. `BrowserAction`은 닫힌 union(`NAVIGATE`/`READ_PAGE`/
`EXTRACT_TEXT`/`FIND`/`CLICK_SAFE`/`SCREENSHOT`)이라 파일 다운로드/업로드/password·
secret 입력/임의 executable 실행/browser extension 설치를 표현할 action 자체가 없다
— 이 타입 시스템 자체가 Core 안전규칙의 상당 부분을 이미 강제한다. SSRF 방지
(`validateNavigationUrl`)는 D3의 `isPrivateOrMetadataHost()`를 그대로 재사용한다(추가
export 1건 — D3의 47개 테스트는 수정 없이 그대로 통과) — D3의 `validateSourceUrl()`은
고정 `allowedHosts` allow-list가 필수라 "그때그때 다른 공식 문서를 봐야 하는" Browser
Worker의 threat model과 맞지 않아 그대로 재사용할 수 없었고, host 판정 자체(localhost/
private/link-local/cloud metadata)만 공유하고 scheme(https만 허용, 그 외 전부 자동
거부)/allow-list 정책은 이 파일이 독자적으로 둔다.

CLICK_SAFE만 결과를 미리 완전히 통제할 수 없는 action이다(클릭 대상의 실제 동작은
페이지 로직에 달려있다) — `label`(관찰된 버튼/링크 텍스트)을 `classifyClickRisk()`가
키워드로 검사해 11개 Core 고위험 범주(file_download/file_upload/
password_or_secret_input/payment_or_purchase/financial_transaction/
brokerage_or_trading/production_db_change/production_deploy/
account_security_settings_change/extension_install/arbitrary_executable_run) 중
하나라도 매칭되면 `HUMAN_APPROVAL_REQUIRED`로 판정하고 **backend를 전혀 호출하지
않는다**(fail-closed — 이번 E1은 승인 후 실행까지 구현하지 않는다). `BrowserWorkerPolicy`
는 D1~D5와 동일한 설계로 이 Core 목록에 키워드를 **추가**만 할 수 있을 뿐 대체/약화시킬
필드가 없다. NAVIGATE의 backend 실행 결과에 `finalUrl`(실제 landing URL, redirect
반영)이 있으면 `validateNavigationUrl`로 다시 검증한다 — 최초 요청 URL이 통과했어도
redirect로 금지 origin에 도착하면 전체 결과를 BLOCKED로 무효화한다("page가 다른 URL로
유도해도 Core 규칙 재검사"). 페이지 콘텐츠(READ_PAGE/EXTRACT_TEXT/FIND 결과)는 어디서도
"실행할 명령"으로 다시 파싱되지 않는다 — 그 결과는 순수 데이터로만 호출부에 반환되며,
페이지가 "이 명령을 실행하라"/"보안 규칙을 무시하라" 같은 텍스트를 담고 있어도 이
모듈의 판정에 구조적으로 전혀 영향을 줄 수 없다(테스트로 직접 증명). `createFakeBrowserBackend()`
가 deterministic 테스트 전용 backend를 제공하며, 실제 Playwright 연결은 이 Task에서
만들지 않았다.

`src/playwright-browser-backend.ts`(Phase E Task E2, Playwright Browser Backend & Safe
Interaction Preflight)는 E1의 `BrowserBackend`를 실제 Playwright(공식 Microsoft
패키지, `playwright@1.62.1`, Apache-2.0)로 구현한다. E1의 `executeBrowserAction()`이
여전히 유일한 상위 실행 경계다 — 이 파일은 그 게이트가 호출하는 backend 구현 하나와,
그대로 위임하는 `runBrowserAction()` 편의 wrapper만 제공할 뿐, arbitrary
navigation/download/upload/credential 입력/shell 실행/production action을 수행할 수
있는 별도 public 경로를 만들지 않는다. 자동 로그인/credential 저장은 구현하지 않는다
(매 backend 생성마다 새 `BrowserContext`를 쓰고 `storageState`를 저장하지 않는다).

E1에 두 가지를 순수 추가했다: `ClickSafeAction.structuralSignals`(선택 필드, 지정하지
않으면 기존 동작과 완전히 동일 — E1의 75개 테스트는 무수정 통과)와
`assessClickTargetStructure()`(element tag/type, href, target, download attribute,
form association/action/method, input/button type, javascript URL 여부, 새 origin
이동 가능성(href를 `validateNavigationUrl`로 재검증 — 로직 복제 없음), 파일 업로드
input 여부, password/credential 관련 input 여부를 검사해 BLOCKED/HUMAN_APPROVAL_REQUIRED/
ALLOWED를 판정하며, form action 텍스트는 `classifyClickRisk()`를 그대로 재사용한다).
`executeBrowserAction()`의 CLICK_SAFE 분기는 label 검사를 통과한 뒤 `structuralSignals`가
있으면 이 판정도 함께 적용한다 — 둘 중 하나라도 걸리면 backend를 전혀 호출하지 않는다.

실제 `PlaywrightBrowserBackend.clickSafe()`는 물리적 클릭 직전에 DOM에서 구조적 신호를
직접 읽어(`locator.evaluate(...)`) `assessClickTargetStructure()`로 **독립적으로 다시
검사**한다 — 상위 호출자가 `structuralSignals`를 빠뜨리거나 stale한 값을 넘겨도 이
backend가 최종 방어선이 된다("Browser가 E1 Core Safety Gate를 우회해서는 안 된다").
위험하다고 판정되면 실제 `locator.click()`을 호출하지 않고 `{ok:false}`만 반환한다.
NAVIGATE/CLICK_SAFE가 반환하는 `finalUrl`은 항상 `page.url()`(landing 시점의 실제 URL)
이라 E1의 redirect 재검증이 그대로 작동한다. popup(`page.on("popup", ...)`)이 열리면
그 URL을 `validateNavigationUrl()`로 즉시 재검증하고(`config.onPopup`으로 관찰 가능),
검증 결과와 무관하게 즉시 닫는다 — 이 backend는 두 번째 page에서 추가 action을 실행하는
멀티 페이지 워크플로를 지원하지 않으므로, "검증 전에는 추가 action을 실행하지 않는다"를
"그 페이지에서는 아예 action을 실행하지 않는다"로 가장 안전하게 만족시킨다. 모든 backend
메서드는 Playwright 예외(timeout 포함)를 try/catch로 감싸 `{ok:false}`로 변환한다
(fail-open 없음).

`PlaywrightPageLike`/`PlaywrightLocatorLike` 등은 실제 Playwright 타입의 부분집합만
명시적으로 정의한 자체 interface다 — `realChromiumLauncher`가 실제
`chromium.launch()` 결과를 이 interface로 명시적으로 감싼다(암묵적 구조적 호환에
기대지 않음). 회귀 테스트는 이 launcher를 fixture로 주입해 실제 브라우저 없이
deterministic하게 검증한다 — 실제 브라우저로 검증하는
`playwright-browser-backend-smoke-test.ts`는 `smoke-test`/`real-source-catalog-smoke-test`와
동일하게 `test:` 접두사가 없는 별도 스크립트다(회귀에 미포함). 이 세션에서는 로컬에
설치된 Playwright 브라우저 바이너리가 이 패키지 버전이 기대하는 revision과 달라 실제
실행이 실패했고(`npx playwright install`이 필요하다는 안내 메시지 확인), 이 Task는
"불필요하면 설치 범위를 확장하지 않는다"에 따라 새 브라우저 바이너리를 다운로드하지
않았다 — 필요 시 사람이 `npx playwright install chromium` 실행 후 이 smoke test로
직접 확인할 수 있다.

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
