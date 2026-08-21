import { classifyTaskRisk } from "./policy";

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

// 회귀(실제 버그): "Microsoft 실제 연결 없이 mock/fake 구조만 사용"이 microsoft_connect로
// 오탐되어 Task 2가 시작도 못 하고 WAITING_HUMAN에 빠지는 것을 실제로 관찰했다.
check(
  "부정 표현: 'Microsoft 실제 연결 없이 mock/fake 구조만 사용' → 차단 안 됨",
  classifyTaskRisk("Phase 9 UI 구현. Microsoft 실제 연결 없이 mock/fake 구조만 사용한다.") === null
);
check(
  "부정 표현: 'Microsoft 실제 연결 금지' → 차단 안 됨",
  classifyTaskRisk("작업 진행. Microsoft 실제 연결 금지.") === null
);
check(
  "부정 표현: 'remote DB mutation 금지' → 차단 안 됨(production 키워드 없음, 애초에 무관)",
  classifyTaskRisk("remote DB mutation 금지, mock 기반 검증만 사용.") === null
);
check(
  "부정 표현: 'production DB 접근 금지' → 차단 안 됨",
  classifyTaskRisk("이 작업에서는 production DB 접근 금지, dev만 사용한다.") === null
);
check(
  "부정 표현: 'production 환경에 배포 금지' → 차단 안 됨",
  classifyTaskRisk("production 환경에 배포 금지, 로컬 빌드만 확인한다.") === null
);

// 진짜 위험 요청은 여전히 정확히 차단돼야 한다(안전장치 약화 방지 회귀).
check(
  "진짜 위험: 'production Supabase 데이터를 삭제해줘' → production_data_delete",
  classifyTaskRisk("production Supabase 데이터를 삭제해줘") === "production_data_delete"
);
check(
  "진짜 위험: 'Microsoft OAuth에 연결해줘' → microsoft_connect",
  classifyTaskRisk("지금 Microsoft OAuth에 연결해줘") === "microsoft_connect"
);
check(
  "진짜 위험: 'OneDrive에 연결하고 실제 업로드 테스트를 진행해' → microsoft_connect",
  classifyTaskRisk("OneDrive에 연결하고 실제 업로드 테스트를 진행해") === "microsoft_connect"
);
check(
  "진짜 위험: 'production 환경에 배포해줘' → production_deploy",
  classifyTaskRisk("production 환경에 배포해줘") === "production_deploy"
);
check(
  "진짜 위험: '0013 migration을 수정해줘(production)' → modify_applied_migration",
  classifyTaskRisk("production db의 0013 migration 파일을 수정해줘") === "modify_applied_migration"
);

console.log("\n=== policy 테스트 결과 ===");
for (const r of results) console.log(r);
const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
