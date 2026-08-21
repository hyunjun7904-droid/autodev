# AutoDev 개발/토큰 운영 원칙

AutoDev 자신을 개발하는 세션(AutoDev Core에 대한 Task)과, AutoDev가 실행하는 대상
프로젝트(Claude Developer worker)에 공통으로 적용되는 운영 원칙이다. 저장소 파일 /
`.autodev`류 project-state / task registry / manifest / rules / Skills를 장기
기억으로 쓰고, Claude와의 과거 대화 자체에는 의존하지 않는다(Context가 compact되거나
세션이 끊겨도 저장소 상태만으로 이어서 작업할 수 있어야 한다).

## 세션 경계 — One Task = One Fresh Claude Worker Session

- 원칙적으로 Task 하나당 새 Claude Worker 세션 하나를 쓴다. 이전 Task의 대화 전체를
  다음 Task 세션에 다시 넣지 않는다.
- 같은 Task의 REVISE(GPT reviewer가 되돌린 재작업)는 예외다 — 그 Task를 이해하는 데
  필요한 context를 유지한 채 같은 세션(또는 이어지는 세션)에서 처리한다. REVISE
  전달에는 프로젝트 전체를 다시 보내지 않고, 지적된 문제와 그와 관련된 변경 범위만
  전달한다(§ GPT Reviewer 전달 범위).
- 새 세션(새 Task)은 Thin Prompt를 쓴다 — 저장소에 이미 강제된 규칙(코드/Hook/Gate로
  구현된 것)은 매 Task Prompt에서 반복 설명하지 않는다. 아직 코드/Hook/Gate로 강제
  되지 않은 중요한 안전 규칙만 Task Prompt에 남긴다. 규칙이 코드/Gate로 강제되면 그
  즉시 반복 Prompt에서 제거한다.

## Context 조사 — 최소 반복 탐색

- 관련 파일부터 읽는다 — 저장소 전체를 매번 처음부터 반복 탐색하지 않는다.
- 자료 조사 우선순위: (1) 실제 코드/Git/project-state → (2) 이미 확정된 설계/Decision
  → (3) 공식 문서 → (4) 공식 GitHub/SDK/Vendor 문서 → (5) 일반 기술자료 → (6)
  블로그/커뮤니티(후보 발견용). 외부 조사는 실제로 필요한 Task에서만 수행하고, 최신
  규격/API/외부 서비스 동작처럼 외부 확인이 꼭 필요한 경우 공식 자료를 우선한다.

## 테스트 — Targeted 우선, 완료 전 Full Regression

- 개발 중에는 지금 바꾸는 모듈에 대응하는 targeted test(`npm run test:<module>`)를
  우선 실행한다.
- Task 완료 checkpoint/commit 전에는 반드시 전체 회귀(모든 `test:*`)를 실행하고
  FAIL 0을 확인한다. 실행하지 않은 검증을 PASS로 보고하지 않는다.
- 기존 보안 테스트(Safe Executor, Secret Scanner, Data-only Adapter, Per-Run
  Execution Context, Fixture E2E 등)를 삭제하거나 약화해서 새 테스트를 통과시키지
  않는다.

## GPT Reviewer 전달 범위

- 최초 리뷰: Task 요구사항 + 실제 diff + 관련 파일 + test 결과 중심으로 전달한다.
  프로젝트 전체를 매번 다시 보내지 않는다.
- REVISE 재전달: 전체 프로젝트를 다시 보내지 않는다. GPT가 지적한 사항과 그와 관련된
  변경 범위(수정된 파일/diff) 중심으로 전달한다.
- 중복 토큰은 줄이되 보안/설계/검증 품질은 낮추지 않는다 — 전달 범위를 줄이는 것과
  검증 엄격도를 낮추는 것은 다른 문제다.

## Git / project-state / manifest / rules / Skills = 장기 기억

- Claude의 이전 대화 내용만으로 프로젝트 현재 상태를 판단하지 않는다 — 저장소의 실제
  파일, project-state, task registry/manifest, Git 이력을 기준으로 판단한다.
- 저장소 실제 상태와 대화 내용이 충돌하면 저장소를 조사한 뒤 판단한다.
- 완료된 이전 Task의 대화/로그를 다음 Task까지 계속 끌고 가지 않는다. 독립적인 새
  Task는 가능하면 새 세션에서 시작한다.
