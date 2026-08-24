# AutoDev Core Filesystem Trust Model (SI-3.5)

이 문서는 AutoDev Core의 trusted file read / atomic write 경로(`project-bootstrap.ts`,
`spec-planner.ts`)가 실제로 방어하는 것과 방어하지 않는 것을 명시적으로 정의한다.
"portable Node.js로 완전한 kernel-level TOCTOU 제거"는 근거 없이 주장하지 않는다 —
아래는 그 대신 채택한 **Option A(Portable Core Boundary)**의 정확한 경계다.

## 결정: Option A — Portable Core Boundary

### 전제(threat model)

AutoDev가 관리하는 project root는 AutoDev를 실행하는 개발자가 통제하는 정상 로컬
workspace다. **동일 OS 사용자 권한을 가진 악의적 프로세스가, 검증과 실제 I/O 사이의
극히 짧은 창(microsecond~millisecond 단위)에 ancestor directory를 rename/swap하는
정밀 timing 공격까지는 이 Core 보장의 범위 밖으로 정의한다.**

이유:
1. 이 정도의 로컬 공격 능력(같은 사용자 권한으로 파일시스템 race를 정밀하게 실행)을
   가진 공격자는 이미 AutoDev 프로세스의 메모리/환경변수/AutoDev 자신의 소스 코드를 직접
   조작할 수 있는 위치에 있다 — ancestor directory swap은 그 공격자에게 특별히 더 강력한
   추가 능력을 주지 않는다(동등하거나 더 쉬운 다른 공격 경로가 이미 열려 있다).
2. AutoDev의 실제 배포 모델은 단일 개발자의 로컬 머신 — multi-tenant/샌드박스 환경에서
   신뢰할 수 없는 다른 사용자와 파일시스템을 공유하는 시나리오가 아니다.
3. 이 저장소의 다른 어떤 Core hard rule(Safe Executor의 `resolveSafe`/`executeReadFiles`
   포함)도 이 클래스의 위협을 막는다고 주장한 적이 없다 — 이미 알려진, 문서화된, 전체
   시스템에 공통인 한계다.

### Core가 실제로 강제하는 것(이 경계 안에서 deterministic/fail-closed)

- **project root canonicalization** — 모든 신뢰 경계 판정은 `realpathSync` 기반
  canonical path로 이뤄진다(대소문자/`.`·`..`/symlink 전부 단일 canonical 표현으로
  정규화).
- **project root 자체 및 ancestor chain의 symlink/junction 금지** — "resolve 결과가 root
  내부에 있다"는 관대한 containment 판정과 별개로, root부터 대상까지의 경로 구성요소
  **어느 것도 symlink/junction일 수 없다**(`assertNoSymlinkInChain`,
  `project-bootstrap.ts`). root 내부를 가리키는 "무해해 보이는" symlink조차 거부한다 —
  그런 symlink는 검증 이후 언제든 다른 대상을 가리키도록 재설정될 수 있어 그 자체로
  신뢰할 수 없다. 여기서 "symlink/junction"은 정확히 Node의
  `lstatSync().isSymbolicLink()`가 참으로 보고하는 것(POSIX symlink, Windows symlink/
  junction=mount point 유형 reparse point)만을 뜻한다 — Windows의 다른 필터 드라이버
  고유 reparse tag(cloud placeholder, dedup 등) 전부를 이 API가 포괄한다고 주장하지
  않는다.
- **project root containment** — 모든 대상의 realpath가 project root의 realpath
  내부여야 한다(`isRealPathWithin`).
- **regular-file enforcement** — 신뢰 대상은 반드시 regular file이어야 한다(디렉터리/
  device/기타 특수 파일 거부).
- **trusted read** — lstat(no-follow 정책) → realpath containment → fd 기반 read(POSIX는
  `O_NOFOLLOW`, Windows는 이식성 있게 강제되지 않음을 알고 있음) → fd 재확인(fstat).
- **project lock** — 동일 project에 대한 AutoDev 자신의 concurrent writer는 exclusive
  lock(`project-lock.ts`)으로 완전히 직렬화된다 — "합법적인 AutoDev 프로세스 두 개가
  서로 경쟁"하는 시나리오는 이 경계 밖이 아니라 애초에 발생하지 않는다.
- **identity/hash revalidation** — 저장된 생성물은 매 재확인(reload)마다 원본 신뢰
  소스(master-spec/spec.md)를 다시 읽어 digest를 재계산해 대조한다 — 오래된/변조된
  생성물을 조용히 계속 신뢰하지 않는다.
- **same-directory temp + atomic rename** — 임시 파일은 항상 최종 대상과 같은 디렉터리에
  만들고(cross-filesystem rename 회피), `fsync` 이후 단일 `rename()`으로 승격한다.
- **pre-promotion revalidation** — `rename()` 직전에 parent containment/ancestor
  symlink 부재를 다시 한번 재확인해 write~promote 사이의 창을 최대한 좁힌다.
- **post-promotion(destination) 검증** — `rename()` 직후 최종 경로를 다시 확인해(regular
  file, containment) 예상과 다르면 성공으로 보고하지 않는다(**prevention이 아니라
  detection** — race가 실제로 발생했다면 이미 일어난 rename을 되돌릴 수는 없지만, 그
  결과를 "성공"으로 조용히 신뢰하지는 않는다).
- **generation hash binding / mixed-generation detection** — 여러 개의 독립 파일(task
  registry/execution policy/manifest)에 걸친 생성 결과는 `generation.json`의 SHA-256
  해시와 항상 대조되어, 서로 다른 generation이 섞인 상태(부분 write 실패 등)를 탐지한다.
- **fail-closed resume** — 애매하거나 확인할 수 없는 상태는 절대 "성공"으로 조용히
  진행하지 않는다 — 항상 명시적 BLOCKED 코드로 중단한다.

### 이 경계 밖(Core가 방어한다고 주장하지 않는 것)

- 검증(realpath/lstat)과 실제 I/O(open/write/rename) 사이의 **진짜 원자적 결합**.
  POSIX `openat2(RESOLVE_BENEATH)`나 Windows의 handle-relative API 없이는, "검증한
  대상과 실제로 연 대상이 정확히 같음"을 커널 수준에서 증명할 방법이 portable Node.js
  `fs`에는 없다.
- 동일 OS 사용자 권한의 악의적 프로세스가 이 정확한 창을 정밀하게 노려 ancestor
  directory를 rename/swap하는 공격(§ 전제).
- Windows에서 `O_NOFOLLOW`를 신뢰성 있게 강제하는 것 — Node/libuv가 Windows에서 이
  플래그를 이식성 있게 보장하지 않는다(알려진 플랫폼 한계, 이 문서 작성 시점에 직접
  확인함: `fs.constants.O_NOFOLLOW`가 win32에서 `undefined`).

## 검토한 대안: Option B — Native OS Security Primitive

Windows(handle-relative/reparse-safe native file API — 예: `CreateFile` +
`GetFinalPathNameByHandle` 조합, 또는 native addon으로 `NtCreateFile`
`FILE_OPEN_REPARSE_POINT` 제어) / Linux(`openat`/`openat2(RESOLVE_BENEATH)`)를 통해
검증과 I/O를 하나의 커널 호출/handle 계보로 묶으면 이 클래스의 race를 이론적으로
제거하거나 크게 좁힐 수 있다.

### 비용 분석 (이번 SI-3.5에서 채택하지 않은 이유)

- **portability** — Node.js `fs`는 이 수준의 API를 노출하지 않는다. 네이티브 addon
  (N-API) 또는 별도 helper 프로세스가 필요하며, Windows/Linux/macOS 세 플랫폼마다 다른
  구현이 필요하다(AutoDev는 크로스플랫폼 자동 개발 오케스트레이션 엔진이다).
- **maintenance** — 네이티브 코드는 이 저장소의 나머지(순수 TypeScript, 배포 시
  `tsc`만으로 빌드)와 근본적으로 다른 빌드/테스트/디버깅 부담을 진다. 이 저장소의 기존
  원칙("과도한 새 subsystem을 만들지 않는다")과도 상충한다.
- **dependency** — 네이티브 addon은 Node.js ABI 버전에 종속적이다(N-API가 이를
  완화하지만 완전히 없애지는 않는다) — Node 버전 업그레이드마다 재빌드/재검증 부담이
  생긴다.
- **signing/distribution** — Windows에서 배포되는 네이티브 바이너리는 실행 시 SmartScreen/
  Defender 경고를 유발할 수 있어 code signing이 사실상 필요해진다 — 이 프로젝트에는 그런
  서명 파이프라인이 없다.
- **security surface** — 네이티브 코드는 그 자체로 메모리 안전성 문제(buffer overflow
  등)를 새로 만들 수 있는 표면이다. portable Node.js API는 이런 클래스의 버그가 구조적으로
  없다.
- 무엇보다, 위 threat model 분석(§ 결정)에 따르면 이 race를 완전히 막아도 AutoDev의 실제
  보안 태세가 유의미하게 달라지지 않는다 — 그 정도 로컬 공격 능력을 가진 공격자는 이미
  더 쉬운 다른 공격 경로를 갖고 있다.

### 결론

**Option A가 AutoDev의 실제 threat model에 충분하다고 판단한다.** Option B는 지금
구현하지 않는다 — 이 문서에 비용 분석이 있다는 사실 자체가 향후 착수 승인을 의미하지
않는다. 필요성이 실제로 제기되면(예: multi-tenant 배포, 신뢰할 수 없는 사용자와 파일시스템
공유) 별도 Task에서 이 문서를 갱신하고 사용자 승인을 받아야 한다.

## 코드 매핑

- `assertNoSymlinkInChain()` (`src/project-bootstrap.ts`) — ancestor chain symlink/junction
  금지의 단일 구현. `isRealPathWithin()`과 나란히 정의되며, `spec-planner.ts`가 그대로
  import해서 쓴다(로직 복제 없음).
- `readTrustedGeneratedFile()` (`src/spec-planner.ts`) / `verifySpecContentRefFile()`
  (`src/project-bootstrap.ts`) — trusted read.
- `writeJsonAtomic()` (`src/spec-planner.ts`) / `writeBootstrapStateAtomic()`·
  `preserveMasterSpec()`의 manifest 저장 (`src/project-bootstrap.ts`) — atomic write +
  pre-promotion revalidation + post-promotion 검증.
- `project-lock.ts` — project 단위 exclusive lock.
- `generationManifestPath()`/`reloadAndValidateGeneratedData()` (`src/spec-planner.ts`) —
  generation hash binding / mixed-generation detection.

## 테스트 매핑

`src/project-bootstrap-tests.ts`/`src/spec-planner-tests.ts`의 SI-3.5 표시 테스트가 이
문서의 "Core가 실제로 강제하는 것" 목록을 각 항목별로 직접 검증한다. Windows에서 symlink
생성 권한이 없는 환경(관리자 권한/개발자 모드 미설정)에서는 해당 테스트가 SKIP으로
명시적으로 표시된다(실패로 위장하지 않음).
