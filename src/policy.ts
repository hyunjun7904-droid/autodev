import type { ActionType, HighRiskAction, DevAutoAction } from "./types";

// 다음은 자동 실행 금지 — 항상 사람 승인이 필요하다.
const ALWAYS_HUMAN: ReadonlySet<HighRiskAction> = new Set([
  "production_db_change",
  "production_data_delete",
  "modify_applied_migration",
  "production_deploy",
  "production_secret_change",
  "microsoft_connect",
  "paid_external_action",
]);

// 향후 DEV 환경에서는 자동 허용할 수 있도록 구조만 열어둔다. 이번 단계는 실제로 이 목록을
// 근거로 무언가를 자동 실행하는 코드가 없다 — isDevAutoAllowable()은 분류값만 반환한다.
const DEV_AUTO_ALLOWABLE: ReadonlySet<DevAutoAction> = new Set([
  "dev_migration_create",
  "dev_migration_execute",
  "dev_test_data_create",
  "dev_test_data_delete",
  "phase_progression",
]);

export const MAX_REVIEW_CYCLES = 5;

export function requiresHumanApproval(action: ActionType): boolean {
  return ALWAYS_HUMAN.has(action as HighRiskAction);
}

export function isDevAutoAllowable(action: ActionType): boolean {
  return DEV_AUTO_ALLOWABLE.has(action as DevAutoAction);
}

// 이 사용자의 실제 지시문 스타일은 "X 금지", "Y 없이" 같은 금지절을 작업 설명 자체에
// 자주 포함시킨다(예: "Microsoft 실제 연결 없이 mock/fake만 사용", "remote DB mutation
// 금지"). 단순 키워드 존재만으로 판단하면 "하지 말라"는 지시 자체가 "하라"는 요청으로
// 오탐되어, 명시적으로 금지된 작업을 오히려 위험 작업으로 잘못 분류하는 역설이 생긴다
// (실제로 microsoft_connect가 "Microsoft ... 연결 없이"에서 오탐되는 것을 확인했다).
// trigger 정규식이 매칭된 직후 짧은 구간에 금지/부정 표현이 있으면 그 매칭은 무시한다.
// "DB 접근 금지"처럼 트리거 단어와 부정어 사이에 다른 단어(접근 등)가 끼는 경우까지
// 잡아야 하므로, 바로 뒤에 붙어야 한다는 제약(^) 없이 윈도우 안 어디에 있어도 인정한다.
const NEGATION_WORD = /(금지|없이|않는다|않음|말고|하지\s*마|불가|안\s*된다|안\s*함)/;

function matchesWithoutNegation(task: string, regex: RegExp, negationWindowChars = 20): boolean {
  const m = regex.exec(task);
  if (!m) return false;
  const after = task.slice(m.index + m[0].length, m.index + m[0].length + negationWindowChars);
  return !NEGATION_WORD.test(after);
}

// 매우 단순한 키워드 기반 분류기 — 실제 LLM 판단이 아니라, Claude worker를 부르기 전에
// 명백히 위험한 작업 요청을 최소한으로 걸러내는 안전장치다. 오탐(과잉 차단)이
// 오작동(과소 차단)보다 안전하다는 원칙은 유지하되, "금지/없이"처럼 트리거 단어 바로
// 뒤에 명시적 부정이 붙은 경우까지 위험으로 분류하지는 않는다(위 NEGATION_AFTER_MATCH).
export function classifyTaskRisk(task: string): HighRiskAction | null {
  const mentionsProduction = /production|프로덕션|운영\s*(db|디비|환경|서버)/i.test(task);

  if (mentionsProduction && matchesWithoutNegation(task, /삭제|delete|drop/i)) return "production_data_delete";
  if (mentionsProduction && matchesWithoutNegation(task, /배포|deploy/i)) return "production_deploy";
  if (
    mentionsProduction &&
    /migration|마이그레이션/i.test(task) &&
    matchesWithoutNegation(task, /수정|변경|modify|change|alter/i)
  ) {
    return "modify_applied_migration";
  }
  if (mentionsProduction && matchesWithoutNegation(task, /secret|시크릿|비밀\s*키|키\s*변경/i)) {
    return "production_secret_change";
  }
  if (
    /microsoft|oauth|onedrive|graph/i.test(task) &&
    matchesWithoutNegation(task, /(microsoft|oauth|onedrive|graph)[\s\S]{0,30}?(연결|연동|connect)/i)
  ) {
    return "microsoft_connect";
  }
  if (mentionsProduction && matchesWithoutNegation(task, /(db|디비|데이터베이스|data|데이터)/i)) {
    return "production_db_change";
  }
  if (/결제|유료|paid|구매|purchase/i.test(task) && matchesWithoutNegation(task, /api|호출|call/i)) {
    return "paid_external_action";
  }
  return null;
}
