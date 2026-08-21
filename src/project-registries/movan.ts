import type { RequiredTestCommand, TaskDefinition } from "../task-registry";

// AutoDev 범용화 Phase A Task A3 — MOVAN 프로젝트 전용 Task Registry 데이터.
//
// task-registry.ts(AutoDev Core)는 "Task를 어떻게 고르는가"라는 방법(타입 + 순수 함수)만
// 안다. "무엇을 할 것인가"(Phase 번호, Task 제목, implementationPrompt, requiredTests,
// allowedPathPrefixes, commitMessage 등 실제 MOVAN 업무 내용)는 이 파일이 담당한다.
//
// 이 파일의 내용은 리팩터링 이전 automation/src/task-registry.ts의 TASK_REGISTRY와 완전히
// 동일하다(순서/필드 값 변경 없음) — Core에서 데이터만 분리했을 뿐, MOVAN AutoDev의 실제
// 동작(다음 task 선택 결과)은 이전과 100% 같아야 한다.
//
// 향후 목표(이번 Task 범위 아님): 이 파일을 MOVAN 저장소가 실제로 분리될 때
// MOVAN/.autodev/task-registry.* 같은 위치로 옮기고, AutoDev Core는 그 경로에서 주입받은
// registry만 사용하게 한다. project-registries/ 폴더는 그때 BILLION 등 다른 프로젝트의
// task-registry 데이터도 나란히 둘 수 있도록 이름 붙였다.

const COMMON_PROHIBITIONS = [
  "automation/ 수정 금지(이 task는 web/ 전용)",
  "supabase/migrations/** 수정 금지(Safe Executor가 이미 하드 차단)",
  "실제 Microsoft/OneDrive 연결 금지",
  "production DB/배포 금지",
  "커밋 금지 — GPT 승인 후 AutoDev checkpoint가 자동으로 commit한다",
];

const TSC_WEB: RequiredTestCommand = { name: "web:tsc", command: "npx", args: ["tsc", "--noEmit"], cwd: "web" };
const BUILD_WEB: RequiredTestCommand = { name: "web:build", command: "npm", args: ["run", "build"], cwd: "web" };

export const MOVAN_TASK_REGISTRY: TaskDefinition[] = [
  {
    id: "13.1",
    phase: 13,
    taskNumber: 1,
    title: "문서 관리 서버/데이터 계층",
    prompt: "(COMPLETE — Git checkpoint 40bbcec. 이 항목은 기록용으로만 registry에 남긴다.)",
    requiredTests: [TSC_WEB, BUILD_WEB],
    allowedPathPrefixes: ["web/lib/storage/", "web/lib/validation/", "web/app/api/sites/", "web/types/", "supabase/migrations/0018_document_upload_jobs.sql"],
    prohibitedOperations: COMMON_PROHIBITIONS,
  },
  {
    id: "13.2",
    phase: 13,
    taskNumber: 2,
    title: "문서관리 UI 구현",
    prompt: `Phase 13 Task 2 — 문서관리 UI 구현.

Phase 13 Task 1(문서 관리 서버/데이터 계층, Git checkpoint 40bbcec)이 이미 완료되어 있다.
web/lib/storage/document-query.ts, document-upload.ts, web/lib/validation/document.ts,
web/app/api/sites/[id]/documents/route.ts, web/app/api/sites/[id]/documents/upload-session/route.ts
를 그대로 재사용한다 — 서버/데이터 계층을 다시 만들거나 바꾸지 마라.

구현 범위:
1. 현장 상세 화면에 "문서" 탭 추가 — 문서 목록(GET /api/sites/[id]/documents) 표시,
   doc_type/is_important 필터, 중요문서 표시(is_important=true 강조).
2. 문서 업로드 UI — upload-session 발급 → 브라우저가 실제로 파일을 업로드 → finalize
   (POST /api/sites/[id]/documents)까지 이어지는 흐름을 화면에서 실제로 구현한다. 단,
   실제 OneDrive/Microsoft Graph 서버 연결은 이번 작업에서 실행하지 않는다(현재
   OneDriveStorageService.getAccessToken()이 StorageNotConnectedError를 던지는 스텁
   상태 그대로 둔다) — UI는 이 오류를 화면에 명확히 안내하는 방식으로 처리한다.
3. 업로드 진행률/실패 상태 UI(진행 중/성공/실패/거부 사유 표시).
4. 권한 없음, 삭제된 현장(404), StorageNotConnected(503) 각각의 사용자 안내 처리.
5. 반응형 기본 지원(PC/태블릿/폰) — 기존 화면들의 Tailwind 컨벤션을 따른다.

완료 전 반드시: 관련 targeted test(있다면), npx tsc --noEmit, npm run build 모두 실행하고
결과를 보고한다. 실제 Microsoft 연결은 시도하지 마라.`,
    requiredTests: [TSC_WEB, BUILD_WEB],
    allowedPathPrefixes: ["web/app/", "web/components/", "web/lib/hooks/", "web/lib/upload/"],
    prohibitedOperations: COMMON_PROHIBITIONS,
  },
  {
    id: "14.1",
    phase: 14,
    taskNumber: 1,
    title: "audit log 기록 범위 전체 점검/누락 보완",
    prompt: `Phase 14 Task 1 — audit log 기록 범위 전체 점검 및 누락 보완.

0003_audit_triggers.sql(record_audit_log 트리거)이 어느 테이블에 이미 적용돼 있는지,
Phase 7~13에서 새로 추가된 테이블/쓰기 경로 중 감사 로그가 누락된 곳이 있는지 점검한다.
0001~0018 migration은 어떤 것도 수정하지 마라(Safe Executor가 write 자체를 차단한다) —
새 트리거가 정말 필요하면 새 migration을 만들지 말고 그 사실을 blocker로 보고만 해라
(이번 task 범위에서 migration을 새로 만드는 것도 금지).
web/ 서버 API 레이어에서 트리거로 커버되지 않는 감사 필요 지점(예: 세션 강제 종료,
관리자 전용 작업 등)이 있다면 web/ 코드로 보완 가능한 범위에서만 수정한다.

완료 전 반드시: 관련 targeted test, npx tsc --noEmit, npm run build 실행.`,
    requiredTests: [TSC_WEB, BUILD_WEB],
    allowedPathPrefixes: ["web/"],
    prohibitedOperations: [...COMMON_PROHIBITIONS, "신규 migration 생성 금지(이번 task 범위 아님, blocker로 보고)"],
  },
  {
    id: "14.2",
    phase: 14,
    taskNumber: 2,
    title: "soft-delete 정책 전체 점검/누락 보완 + 회귀테스트",
    prompt: `Phase 14 Task 2 — soft-delete 정책 전체 점검 및 누락 보완.

전체 테이블/API 경로에서 deleted_at 기반 soft-delete 규칙이 일관되게 적용되고 있는지
점검한다(목록 조회가 deleted_at is null을 빠뜨리지 않는지, 삭제된 참조를 fail-closed로
거부하는지 등 — Phase 13 Task 1 REVISE에서 정립된 패턴을 기준으로 삼는다).
발견한 누락은 web/ 코드 수정으로 보완하고, 각 수정 지점마다 회귀 테스트를 추가한다.
0001~0018 migration은 수정하지 마라. 새 migration이 필요하면 만들지 말고 blocker로 보고.

완료 전 반드시: 관련 targeted test, npx tsc --noEmit, npm run build 실행.`,
    requiredTests: [TSC_WEB, BUILD_WEB],
    allowedPathPrefixes: ["web/"],
    prohibitedOperations: [...COMMON_PROHIBITIONS, "신규 migration 생성 금지(이번 task 범위 아님, blocker로 보고)"],
  },
  {
    id: "15.1",
    phase: 15,
    taskNumber: 1,
    title: "dashboard aggregate/data API",
    prompt: `Phase 15 Task 1 — 대시보드 집계 데이터 API.

velvet-seeking-thompson.md §2 "대시보드" 및 §5 금액 계산 공식을 근거로, admin 전용
전사 집계(이번달 계약금액/수금액/총 미수금/예상·실제이익)와 staff용 본인 배정 현장 요약을
각각 반환하는 서버 API를 구현한다. 기존 estimates/contracts/payments/site_actual_costs
계산 로직·RLS 패턴을 재사용하고 중복 계산 로직을 만들지 마라. UI는 이번 task 범위가
아니다(Task 2에서 구현).

완료 전 반드시: 관련 targeted test, npx tsc --noEmit, npm run build 실행.`,
    requiredTests: [TSC_WEB, BUILD_WEB],
    allowedPathPrefixes: ["web/lib/", "web/app/api/", "web/types/"],
    prohibitedOperations: [...COMMON_PROHIBITIONS, "신규 migration 생성 금지(집계는 쿼리 레벨로만, blocker로 보고)"],
  },
  {
    id: "15.2",
    phase: 15,
    taskNumber: 2,
    title: "dashboard UI/charts",
    prompt: `Phase 15 Task 2 — 대시보드 UI/차트.

Phase 15 Task 1의 데이터 API를 그대로 사용해 /dashboard 화면(진행중 현장 리스트,
이번달 계약금액/수금액, 총 미수금, 예상 vs 실제이익 비교, Recharts 기반 차트,
staff/admin 화면 분리)을 구현한다. 서버 데이터 계층을 다시 만들지 마라.

완료 전 반드시: 관련 targeted test(있다면), npx tsc --noEmit, npm run build 실행.`,
    requiredTests: [TSC_WEB, BUILD_WEB],
    allowedPathPrefixes: ["web/app/", "web/components/"],
    prohibitedOperations: COMMON_PROHIBITIONS,
  },
  {
    id: "16.1",
    phase: 16,
    taskNumber: 1,
    title: "전체 responsive/mobile 점검 및 수정",
    prompt: `Phase 16 Task 1 — 전체 반응형/모바일 점검 및 수정.

지금까지 구현된 모든 화면을 모바일/태블릿 뷰포트 기준으로 점검하고, 레이아웃 깨짐/
터치 타겟 크기/가로 스크롤 문제 등을 수정한다. 서버/API 로직은 변경하지 마라(순수
UI/CSS 레벨 수정).

완료 전 반드시: npx tsc --noEmit, npm run build 실행.`,
    requiredTests: [TSC_WEB, BUILD_WEB],
    allowedPathPrefixes: ["web/app/", "web/components/"],
    prohibitedOperations: COMMON_PROHIBITIONS,
  },
  {
    id: "16.2",
    phase: 16,
    taskNumber: 2,
    title: "전체 permission/security regression",
    prompt: `Phase 16 Task 2 — 전체 권한/보안 회귀 점검.

velvet-seeking-thompson.md §4 권한 구조를 기준으로 전체 API 라우트를 다시 훑어 admin
전용 API에 staff가 접근할 수 있는 경로, RLS 우회 가능 지점, 민감 컬럼 노출 등을 점검하고
발견한 문제를 수정한다. 각 수정마다 회귀 테스트를 추가한다. 0001~0018 migration은
수정하지 마라 — RLS 변경이 꼭 필요하면 새 migration을 만들지 말고 blocker로 보고한다.

완료 전 반드시: 관련 targeted test, npx tsc --noEmit, npm run build 실행.`,
    requiredTests: [TSC_WEB, BUILD_WEB],
    allowedPathPrefixes: ["web/"],
    prohibitedOperations: [...COMMON_PROHIBITIONS, "신규 migration 생성 금지(이번 task 범위 아님, blocker로 보고)"],
  },
  {
    id: "16.3",
    phase: 16,
    taskNumber: 3,
    title: "deployment readiness/config/documentation",
    prompt: `Phase 16 Task 3 — 배포 준비 상태 점검/설정/문서화 (실제 배포는 하지 않는다).

배포에 필요한 환경변수 목록, 빌드 설정, 운영 체크리스트를 정리하고 문서화한다.
vercel.json/next.config.mjs 등 배포 관련 설정 파일이 실제로 준비돼 있는지 점검하고
누락을 web/ 범위에서 보완한다. automation/config/rules.md 등 운영 문서를 갱신할 수
있다. 실제 production 배포, 실제 도메인 연결, 실제 배포 트리거는 절대 실행하지 마라 —
이 task가 끝나도 실제 배포는 사람이 별도로 트리거해야 한다(HUMAN GATE).

완료 전 반드시: npx tsc --noEmit, npm run build 실행.`,
    requiredTests: [TSC_WEB, BUILD_WEB],
    allowedPathPrefixes: ["web/", "automation/config/rules.md"],
    prohibitedOperations: [...COMMON_PROHIBITIONS, "실제 production 배포/도메인 연결/배포 트리거 절대 금지 — 이 task 완료 후에도 배포는 사람이 수행"],
    isHumanGate: true,
  },
  {
    id: "17.1",
    phase: 17,
    taskNumber: 1,
    title: "Supabase 백업 정책 + OneDrive 휴지통/복구 정책 조사·문서화",
    prompt: `Phase 17 Task 1 — Supabase 백업 정책 + OneDrive 휴지통/복구 정책 조사·문서화.

velvet-seeking-thompson.md §7 Phase 17("백업/복구 및 데이터 무결성 점검") 및 §9(버전
업데이트/데이터 보존 정책)를 근거로, 현재 dev Supabase 프로젝트의 백업/PITR(Point-in-Time
Recovery) 설정 상태와 OneDrive 휴지통 보존기간·복구 절차를 조사해 web/DEPLOYMENT.md에
새 섹션으로 문서화한다.

조사 범위:
1. 현재 dev Supabase 프로젝트의 백업 관련 설정(플랜/PITR 가능 여부 등)을 확인 가능한
   범위에서 확인한다. 실제로 확인할 수 없는 항목(예: 콘솔에서만 보이는 설정)은 추측하지
   말고 NOT_VERIFIED로 명시한다.
2. OneDrive(Microsoft Graph) 휴지통 보존기간, 파일 복구 절차를 조사해 정리한다. 현재
   OneDriveStorageService가 StorageNotConnectedError를 던지는 stub 상태이므로 실제
   연결을 시도하지 말고 문서(Microsoft 공식 정책 등)를 근거로 정리하되, 실제 연결 여부에
   의존하는 항목은 NOT_VERIFIED로 남긴다.
3. production 배포 전 반드시 확인해야 할 백업 체크리스트를 작성한다(§9 "운영 DB 스키마
   변경은 반드시 versioned migration" 및 "모든 migration 실행 전 백업/복구가 실제로
   가능한 상태인지 확인" 원칙 반영).

완료 전 반드시: npx tsc --noEmit, npm run build 실행(문서 전용 변경이라도 web/ 빌드에
영향이 없는지 확인).`,
    requiredTests: [TSC_WEB, BUILD_WEB],
    allowedPathPrefixes: ["web/DEPLOYMENT.md"],
    prohibitedOperations: [
      ...COMMON_PROHIBITIONS,
      "실제 Supabase 백업/PITR 설정 변경·활성화 금지(조사·문서화만, 설정 변경은 사람이 Supabase 콘솔에서 직접 수행)",
    ],
  },
  {
    id: "17.2",
    phase: 17,
    taskNumber: 2,
    title: "DB ↔ OneDrive 데이터 정합성 점검 기능 (읽기 전용)",
    prompt: `Phase 17 Task 2 — DB ↔ OneDrive 데이터 정합성 점검 기능(읽기 전용).

velvet-seeking-thompson.md §7 Phase 17 "DB↔OneDrive 정합성 점검(DB엔 있는데 파일 없음 /
파일은 있는데 DB 참조 없는 고아 파일)"을 구현한다. admin 전용 점검 기능(API + 화면, 또는
관리자 설정 화면 내 진입점)으로, 다음을 탐지해 목록으로 보여준다:
1. DB 쪽 orphan — files/photos/documents 테이블에 참조는 있지만 실제 파일이 존재하지
   않는 것으로 보이는 레코드(예: deleted_at 없는데 연결된 files 행이 없는 경우 등, DB
   레벨에서 실제로 검증 가능한 것만 다룬다).
2. 파일 쪽 orphan — OneDrive에는 있지만 DB(files 테이블)에 참조가 없는 파일. **현재
   OneDrive 연결이 stub 상태(StorageNotConnectedError)이므로 실제 Microsoft Graph 호출을
   시도하지 마라** — 이 경로는 연결이 안 된 상태를 NOT_CONNECTED로 안전하게 처리하고,
   실제 연결 이후에나 확인 가능하다는 점을 화면/응답에 명확히 표시한다. DB 자체 조회로
   확인 불가능한 항목은 임의로 "정상"이라 단정하지 말고 NOT_VERIFIED로 표시한다.

반드시 지켜야 할 원칙:
- **읽기 전용 — 탐지된 orphan을 자동으로 삭제·수정하지 않는다.** 리포트(목록) 생성까지만
  구현한다. 실제 삭제/정리는 이 task 범위가 아니다.
- 기존 StorageService 추상화, RLS/admin 권한 패턴(§4)을 재사용하고 새로 만들지 마라.
- 0001~0018 및 기존 migration은 수정하지 마라. 새 migration이 꼭 필요하면 만들지 말고
  blocker로 보고한다.

완료 전 반드시: 관련 targeted test(정상 케이스 + OneDrive 미연결 케이스 포함), npx tsc
--noEmit, npm run build 실행.`,
    requiredTests: [TSC_WEB, BUILD_WEB],
    allowedPathPrefixes: ["web/lib/", "web/app/api/", "web/app/(app)/settings/", "web/types/"],
    prohibitedOperations: [
      ...COMMON_PROHIBITIONS,
      "탐지된 orphan 레코드/파일 자동 삭제·수정 금지(리포트 생성까지만, 실제 정리는 사람이 별도로 결정)",
      "신규 migration 생성 금지(이번 task 범위 아님, blocker로 보고)",
    ],
  },
  {
    id: "17.3",
    phase: 17,
    taskNumber: 3,
    title: "admin 전용 데이터 Export + 복구 절차 문서화",
    prompt: `Phase 17 Task 3 — admin 전용 데이터 Export + 복구 절차 문서화 (HUMAN GATE).

velvet-seeking-thompson.md §4 "데이터 Export 제한(admin 전용)" 및 §7 Phase 17에 정의된
관리자 데이터 Export 기능(전체 고객/견적/원가/협력업체 Export, 현장 전체 ZIP 다운로드,
사진·문서 대량 다운로드, 전체 DB Export)을 구현한다.

반드시 지켜야 할 원칙:
- **서버측에서 반드시 admin role을 재검증**한다(§4 "UI 노출 여부뿐 아니라 서버에서도 role을
  재검증") — 프론트엔드에서 버튼을 숨기는 것만으로 끝내지 않는다. staff가 API를 직접
  호출해도 반드시 거부되어야 하며, 이 부분은 회귀 테스트로 검증한다.
- §4 "감사 기록" 및 audit_logs 트리거/기존 audit 기록 패턴(Phase 14에서 점검·보완된 구조,
  web/ 서버 API 레이어의 기존 audit 기록 방식)을 그대로 재사용해 "대량 Export 실행"을
  기록한다. 기존 구조로 커버되지 않아 신규 migration이 꼭 필요하면 만들지 말고 blocker로
  보고한다.
- 이 task에서 실제 대량 Export를 실 운영 데이터에 대해 실행하지 않는다 — 코드 구현과
  자동화된 테스트(예: 테스트 데이터 기준 응답 검증, 권한 회귀 테스트)로만 검증한다.
- Export 대상 데이터는 고객/견적/원가/협력업체/사진/문서 등 민감정보를 포함할 수 있으므로,
  다운로드 응답에 캐시 방지 헤더 등 기존 민감 API 규칙(§4 "직원 PC 데이터 최소화")을 따른다.

이어서 복구 절차 문서화: Task 17.1(백업 정책)·17.2(정합성 점검 도구)를 근거로, 실제 장애
발생 시 "DB 복구 → OneDrive 복구 → 17.2 정합성 재점검" 순서의 복구 절차를
web/DEPLOYMENT.md에 문서화한다.

이 task는 Phase 17의 마지막 task다(HUMAN GATE) — 완료 후에도 실제 Export 기능의 실행,
production 데이터에 대한 사용은 반드시 사람이 별도로 검토·트리거해야 한다.

완료 전 반드시: 관련 targeted test(admin/staff 권한 회귀 포함), npx tsc --noEmit,
npm run build 실행.`,
    requiredTests: [TSC_WEB, BUILD_WEB],
    allowedPathPrefixes: ["web/app/", "web/components/", "web/lib/", "web/app/api/", "web/DEPLOYMENT.md"],
    prohibitedOperations: [
      ...COMMON_PROHIBITIONS,
      "서버측 admin role 재검증 없이 Export 엔드포인트 노출 금지",
      "실제 대량 Export를 production/실 운영 데이터에 대해 실행 금지 — 코드/테스트 검증까지만, 실행은 사람이 결정",
      "신규 migration 생성 금지(이번 task 범위 아님, blocker로 보고)",
    ],
    isHumanGate: true,
  },
  {
    id: "18.1",
    phase: 18,
    taskNumber: 1,
    title: "Agent Orchestrator + Agent Registry + LlmProvider 골격, MockLlmProvider, agent_jobs migration, read-only 예시 Agent",
    prompt: `Phase 18 Task 1(18.1) — MOVAN AI 비서 + Agent Orchestrator 확장, 최소 골격.

이 task는 Phase 17 완료 후 사람의 명시적 지시로 시작됐다(docs/plans/phase18-ai-assistant-agents.md
§12). 그 문서 §0(AutoDev와의 경계 — 이 Agent Orchestrator는 automation/과 코드 공유 없는
완전히 별도의 web/ 제품 기능이다), §3(핵심 컴포넌트), §5(Human Approval 원칙), §7(admin
전용, RLS 범위 내), §11(18.1 범위 정의)을 근거로 한다.

구현 범위:
1. supabase/migrations/0020_agent_jobs.sql — agent_jobs 원장 테이블(설계문서 §8).
   0001~0019는 수정하지 않는다(additive). service_role 전용(authenticated/anon 권한
   회수 + RLS enable), as_requests/documents와 동일한 수준으로 audit_logs 트리거 대상에
   포함(audit_sensitive_keys_for_table()에 agent_jobs 케이스 추가).
2. web/lib/agents/types.ts — AgentJobStatus, LlmProvider/LlmCompletionInput/Result,
   AgentContext, AgentDefinition 등 핵심 타입.
3. web/lib/agents/llm/mock-provider.ts + llm/index.ts — MockLlmProvider(결정적,
   실제 벤더 호출 없음) + getLlmProvider() 팩토리(web/lib/storage/index.ts의
   getStorageService()와 동일한 설계 원칙). 기본값은 항상 mock이다.
4. web/lib/agents/registry.ts — AGENT_REGISTRY(순수 데이터) + findAgentById(). 등록되지
   않은 Agent는 Orchestrator가 호출할 수 없다.
5. web/lib/agents/orchestrator.ts — runAgentJob(). agent_jobs 레코드 생성(service-role
   클라이언트로만) → requiresApproval이면 waiting_approval에서 멈춤, 아니면 즉시 실행 →
   결과를 completed/failed로 기록. Agent의 실제 업무 데이터 조회는 항상 호출한 admin의
   세션(RLS) 클라이언트로만 한다(service-role을 Agent에 임의로 부여하지 않는다, §7).
6. web/lib/agents/agents/site-summary.ts — 유일한 예시 Agent("현장 요약", 읽기 전용,
   requiresApproval:false). 지정한 siteId의 현재 상태를 조회해 LlmProvider로 요약한다.
7. web/app/api/admin/agents/run/route.ts — admin 전용 최소 실행 엔드포인트(requireAdmin
   재검증, POST만 노출). AI Team Dashboard 화면은 이 task 범위가 아니다(18.2).

완료 전 반드시: 관련 targeted test(mock provider, registry, site-summary 실행 로직,
orchestrator 상태 전이, route guard 전부 fake-db/정적 스타일로), npx tsc --noEmit,
npm run build 실행. 0020이 audit_sensitive_keys_for_table()/record_audit_log()를
create or replace로 다시 정의하므로, 이를 정적으로 파싱하는 기존 회귀 테스트
(lib/supabase/__tests__/audit-trigger-coverage.test.mjs,
audit-sensitive-data-policy.test.mjs)도 agent_jobs를 포함하도록 갱신하고 재실행한다.`,
    requiredTests: [TSC_WEB, BUILD_WEB],
    allowedPathPrefixes: [
      "web/lib/agents/",
      "web/app/api/admin/agents/",
      "web/types/database.ts",
      "web/lib/supabase/__tests__/audit-trigger-coverage.test.mjs",
      "web/lib/supabase/__tests__/audit-sensitive-data-policy.test.mjs",
      "supabase/migrations/0020_agent_jobs.sql",
    ],
    prohibitedOperations: [
      "0001~0019 기존 migration 수정 금지 — agent_jobs는 반드시 신규 migration(0020)으로만 추가",
      "automation/ 수정 금지(task-registry.ts에 이 task를 등록하는 것 자체는 사람의 명시적 지시에 따른 예외)",
      "실제 Anthropic 등 LLM 벤더 API 연결 금지 — 이번 task는 MockLlmProvider만(벤더 연동은 Phase 18 Task 3(18.3) 범위)",
      "AI Team Dashboard 화면/승인 큐 UI 구현 금지(Phase 18 Task 2(18.2) 범위)",
      "requiresApproval:true Agent 추가 금지 — 이번 task의 유일한 예시 Agent는 읽기 전용/승인불필요(site-summary)",
      "production DB/배포 금지",
      "커밋 금지 — 사람이 검증 결과 확인 후 별도로 checkpoint를 지시한다",
    ],
  },
  {
    id: "18.2",
    phase: 18,
    taskNumber: 2,
    title: "AI Team Dashboard — Agent 목록/실행 이력/Human Approval 승인·반려/사용량 요약",
    prompt: `Phase 18 Task 2(18.2) — AI Team Dashboard 화면(admin 전용).

Phase 18 Task 1(18.1, Git checkpoint e5c5b08 + 0319a37)이 이미 완료되어 있다.
web/lib/agents/{types,registry,orchestrator}.ts, web/lib/agents/llm/*,
web/lib/agents/agents/site-summary.ts, web/app/api/admin/agents/run/route.ts, agent_jobs
(migration 0020, dev Supabase 적용/검증 완료)를 그대로 재사용한다 — 18.1 구조를 다시
설계하지 않는다. 이 task는 docs/plans/phase18-ai-assistant-agents.md §4(AI Team
Dashboard), §5(Human Approval 원칙), §11(18.2 범위: "AI Team Dashboard 화면(admin 전용),
Human Approval 큐 UI, 승인/반려 플로우")를 근거로 한다.

구현 범위:
1. web/lib/agents/orchestrator.ts에 조회/승인/반려 함수 추가 — listAgentJobs()(최근 실행
   이력 + status 필터로 승인 대기 큐 조회 겸용), approveAgentJob()(waiting_approval →
   running(approved_by 기록) → completed/failed, 승인한 admin의 세션 클라이언트로 Agent를
   실행), rejectAgentJob()(waiting_approval → rejected, Agent를 실행하지 않고 즉시 종료,
   approved_by는 채우지 않음 — "실제로 승인한 admin"만을 위한 컬럼이라는 0020 주석 의미를
   그대로 유지). runAgentJob()의 즉시 실행 경로와 승인 실행 경로가 완료/실패 기록 로직을
   공유하도록 executeAndFinalize() 헬퍼로 정리(중복 로직 분리, 동작 변경 아님).
2. admin 전용 API 4개 — GET web/app/api/admin/agents/jobs/route.ts(실행 이력·승인 대기
   조회), GET web/app/api/admin/agents/registry/route.ts(등록된 Agent 목록, execute 함수는
   직렬화하지 않음), POST web/app/api/admin/agents/jobs/[id]/approve/route.ts, POST
   web/app/api/admin/agents/jobs/[id]/reject/route.ts. 전부 requireAdmin() 재검증,
   contract-changes의 [id]/approve·reject 라우트와 동일한 404/409 응답 패턴.
3. web/app/(app)/ai/page.tsx + ai-team-dashboard.tsx — admin 전용 화면(settings/users와
   동일한 role 리다이렉트 패턴). 등록된 Agent 목록, 새 요청 제출(Agent 선택 + JSON 입력),
   승인 대기 큐(승인/반려 버튼), 토큰/비용 사용량 요약, 최근 실행 이력 테이블을 표시한다.
   web/components/layout/sidebar-nav.tsx에 "AI 비서"(/ai, adminOnly) 항목 추가.

완료 전 반드시: 관련 targeted test(listAgentJobs/approveAgentJob/rejectAgentJob 상태
전이·에러 케이스, 신규 라우트 4개의 admin guard/메서드 노출 — 전부 fake-db/정적 스타일),
npx tsc --noEmit, npm run build, 18.1 기존 회귀 테스트 전부 재실행. 실제 브라우저(Playwright)
검증은 읽기 전용으로만 수행하고 요청 실행/승인/반려처럼 agent_jobs에 쓰기가 발생하는
액션은 클릭하지 않는다(dev Supabase agent_jobs가 빈 테이블로 유지되는지 read-only MCP로
재확인).`,
    requiredTests: [TSC_WEB, BUILD_WEB],
    allowedPathPrefixes: [
      "web/app/(app)/ai/",
      "web/app/api/admin/agents/jobs/",
      "web/app/api/admin/agents/registry/",
      "web/lib/agents/orchestrator.ts",
      "web/lib/agents/__tests__/orchestrator-jobs.fake-db.test.mjs",
      "web/lib/agents/__tests__/jobs-routes-guard.test.mjs",
      "web/components/layout/sidebar-nav.tsx",
    ],
    prohibitedOperations: [
      "automation/ 수정 금지(task-registry.ts에 이 task를 등록하는 것 자체는 사람의 명시적 지시에 따른 예외)",
      "supabase/migrations/** 수정 금지 — 이번 task는 신규 migration이 필요 없다(0020을 그대로 재사용)",
      "실제 Anthropic 등 LLM 벤더 API 연결 금지 — 이번 task도 MockLlmProvider만(벤더 연동은 Phase 18 Task 3(18.3) 범위)",
      "18.1 산출물(web/lib/agents/types.ts·registry.ts·llm/*·agents/site-summary.ts, web/app/api/admin/agents/run/route.ts) 재설계 금지 — 그대로 재사용",
      "Agent Registry에 새 Agent 추가 금지 — 이번 task는 화면/승인 큐 인프라만 만든다(18.1의 유일한 Agent인 site-summary만 유지)",
      "실제 요청 실행/승인/반려 버튼을 눌러 agent_jobs에 쓰기를 발생시키는 방식의 브라우저 검증 금지 — 읽기 전용 렌더링 확인 + fake-db/정적 테스트로 대체",
      "production DB/배포 금지",
      "커밋 금지 — 사람이 검증 결과 확인 후 별도로 checkpoint를 지시한다",
    ],
  },
  {
    id: "18.3",
    phase: 18,
    taskNumber: 3,
    title: "Anthropic Provider 실제 연동(명시적 활성화 옵션), 토큰/비용 기록",
    prompt: `Phase 18 Task 3(18.3) — Anthropic Provider 실제 연동.

Phase 18 Task 1(18.1)/Task 2(18.2, Git checkpoint d61d720 + f019c5d)가 이미 완료되어 있다.
web/lib/agents/{types,registry,orchestrator}.ts, web/lib/agents/llm/mock-provider.ts,
web/lib/agents/agents/site-summary.ts, web/app/(app)/ai/**, web/app/api/admin/agents/**,
agent_jobs(migration 0020)를 그대로 재사용한다 — 재설계하지 않는다. 이 task는
docs/plans/phase18-ai-assistant-agents.md §3.3(LLM Provider Interface)/§3.4(mock 우선)/
§3.5(Anthropic API Provider)/§6(비용/토큰 절약 원칙)/§11(18.3 범위: "Anthropic Provider
실제 연동(명시적 활성화 옵션), 토큰/비용 기록 및 대시보드 노출")를 근거로 한다.

구현 범위:
1. web/lib/agents/llm/anthropic-provider.ts — @anthropic-ai/sdk(TypeScript SDK)로 LlmProvider
   인터페이스를 구현하는 AnthropicLlmProvider(id="anthropic"). complete()는 messages.create()를
   호출해 text 블록을 이어붙이고, usage.input_tokens+output_tokens를 tokensUsed(기존 단일
   숫자 계약 유지)에 매핑하며, model은 응답의 실제 model 값을 쓴다. Anthropic 벤더 오류
   (인증/rate limit/bad request/서버 오류/timeout/abort/connection)는 typed 예외
   (Anthropic.APIError 및 하위 클래스)를 사람이 읽을 수 있는 메시지로 변환해 던진다 —
   API Key 값 자체는 어떤 메시지에도 포함하지 않는다. 모델명은 이 파일 한 곳에서만 기본값을
   정의하고 ANTHROPIC_MODEL 환경변수로 재정의 가능하게 한다(모델명 중앙 설정).
2. web/lib/agents/llm/index.ts의 getLlmProvider() — AGENT_LLM_PROVIDER 환경변수가 정확히
   "anthropic"이고 ANTHROPIC_API_KEY가 비어있지 않을 때만 AnthropicLlmProvider를 반환한다.
   그 외 모든 경우(환경변수 미설정, 알 수 없는 값, anthropic이지만 키 없음)는 안전하게
   MockLlmProvider를 반환한다 — 기본값은 항상 mock(§3.4/§6).
3. web/lib/agents/agents/site-summary.ts — costEstimate를 ctx.llmProvider.id 기준으로
   결정한다(mock이면 0, 그 외에는 null). 설계문서에 cost_estimate 계산식(모델별 단가표)이
   명시되어 있지 않으므로 임의 가격표를 하드코딩하지 않는다 — null(측정 불가)로 구조만
   마련해둔다.
4. web/package.json — @anthropic-ai/sdk 의존성 추가(npm install).
5. web/.env.local.example — AGENT_LLM_PROVIDER/ANTHROPIC_API_KEY/ANTHROPIC_MODEL 변수 이름만
   추가(실제 값 금지, 기존 파일 패턴과 동일한 주석 스타일).

완료 전 반드시: AnthropicLlmProvider unit test(fake client 주입, 실제 네트워크 호출 0건 —
정상 응답/usage 매핑/여러 text 블록/모델 override/응답에 text 블록이 없는 경우/각 벤더
오류 타입별 안전한 메시지 변환/API Key 미노출), getLlmProvider() factory test(기본값
mock/명시적 anthropic 선택/키 없을 때 안전한 mock 폴백/알 수 없는 provider 값의 안전한
처리), 18.1/18.2 기존 회귀 테스트 전부(9개 파일) 재실행. npx tsc --noEmit, npm run build
(빌드 산출물에 ANTHROPIC_API_KEY/AnthropicLlmProvider 문자열이 클라이언트 static 번들에
없는지 확인). 실제 Anthropic API 유료 호출(smoke test)은 사람의 별도 승인 없이는 절대
실행하지 않는다 — API Key가 로컬에 설정되어 있어도 마찬가지다.`,
    requiredTests: [TSC_WEB, BUILD_WEB],
    allowedPathPrefixes: [
      "web/lib/agents/llm/",
      "web/lib/agents/agents/site-summary.ts",
      "web/lib/agents/__tests__/anthropic-provider.test.mjs",
      "web/lib/agents/__tests__/llm-factory.test.mjs",
      "web/package.json",
      "web/package-lock.json",
      "web/.env.local.example",
    ],
    prohibitedOperations: [
      "automation/ 수정 금지(task-registry.ts에 이 task를 등록하는 것 자체는 사람의 명시적 지시에 따른 예외)",
      "supabase/migrations/** 수정 금지 — 이번 task는 신규 migration이 필요 없다",
      "18.1/18.2 산출물(orchestrator.ts의 상태 전이 로직, AI Team Dashboard 화면, admin API 라우트) 재설계 금지 — getLlmProvider()의 반환값만 바뀐다",
      "실제 유료 Anthropic API 호출 금지 — 코드 구현/typecheck/build/mock 기반 테스트까지만, 실제 smoke test 실행은 사람이 별도로 결정한다",
      "API Key/secret을 코드·커밋·로그·project-state.json에 기록하거나 출력 금지",
      "cost_estimate 계산을 위한 임의 가격표(모델별 단가) 하드코딩 금지 — 설계문서에 명시되지 않았으므로 구조(null)만 마련",
      "직원(staff)용 AI 비서 RBAC 확장 금지 — admin 전용 원칙 유지",
      "production DB/배포 금지",
      "커밋 금지 — 사람이 검증 결과 확인 후 별도로 checkpoint를 지시한다",
    ],
  },
];
