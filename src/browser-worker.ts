import { isPrivateOrMetadataHost } from "./source-adapter";

// Browser Worker Safety Boundary & Core Foundation — Phase E Task E1.
//
// Browser Worker는 최후 수단이다 — 기존 프로젝트 코드/데이터 → 공식 API/metadata(D1~D5의
// Capability Discovery/Source Adapter) → 공식 HTTP/document source로도 부족할 때만 쓴다.
// 이 파일은 그 상위 우선순위 로직을 구현하지 않는다(그건 호출부/오케스트레이션의 몫이다) —
// 여기 있는 것은 실제로 Browser Worker를 "쓰기로 결정했을 때" 지켜야 하는 Core 실행모델과
// 보안 경계뿐이다.
//
// 이번 E1은 범용 웹 자동화를 완성하지 않는다 — 실제 Playwright 연결, 로그인 자동화,
// password/credential 사용, 파일 다운로드/업로드, 결제/구매, production 변경, Agent
// Router, Dashboard, Notification Service는 이 Task에서 하지 않는다. AI(Claude/GPT)
// 판단에 의존하지 않는다 — 이 모듈은 LLM을 호출하지 않고, 어떤 LLM 출력(페이지 콘텐츠
// 포함)도 신뢰 입력으로 받지 않는다.
//
// SSRF 방지(localhost/private network/link-local/cloud metadata 차단)는 D3
// (source-adapter.ts)의 `isPrivateOrMetadataHost()`를 그대로 재사용한다(재조사 결과:
// D3의 `validateSourceUrl()`은 고정 `allowedHosts` allow-list가 필수라 "임의의(사전에
// 알 수 없는) 공식 문서 URL을 방문해야 하는" Browser Worker의 threat model과 맞지 않는다
// — Source Adapter는 항상 사전 등록된 catalog host만 조회하지만, Browser Worker는
// "최후 수단"으로 그때그때 다른 공식 문서/페이지를 봐야 하므로 고정 allow-list를 강제할
// 수 없다. 그래서 host 판정 자체(localhost/private/metadata 여부)만 공유하고, scheme/
// allow-list 정책은 이 파일이 독자적으로 둔다 — SSRF 하드룰 로직을 복제하지 않는다).

// =========================================================
// Browser Action — 구조화된 action으로만 행동을 제한한다. 임의 shell/browser scripting
// (예: "임의 JS 실행", "임의 명령 실행") action은 이 union에 존재하지 않는다 — 즉 애초에
// 표현할 수 없다(closed action vocabulary가 Core 안전규칙의 상당 부분을 이 타입
// 시스템만으로 이미 강제한다: 파일 다운로드/업로드/password·secret 입력/임의 executable
// 실행을 위한 action 자체가 없다).
// =========================================================

export interface NavigateAction {
  type: "NAVIGATE";
  url: string;
}
export interface ReadPageAction {
  type: "READ_PAGE";
}
export interface ExtractTextAction {
  type: "EXTRACT_TEXT";
  selector?: string;
}
export interface FindAction {
  type: "FIND";
  query: string;
}
/** CLICK_SAFE만 결과를 사전에 완전히 통제할 수 없는 action이다(클릭 대상이 실제로 무엇을
 *  하는지는 페이지 내부 로직에 달려있다) — 그래서 label(사람이 읽을 수 있는, 페이지에서
 *  실제로 관찰한 클릭 대상 설명, 예: 버튼/링크 텍스트)을 반드시 함께 받아 Core Safety
 *  Gate가 위험 키워드로 사전 분류한다(§ classifyClickRisk). */
export interface ClickSafeAction {
  type: "CLICK_SAFE";
  selector: string;
  label: string;
}
export interface ScreenshotAction {
  type: "SCREENSHOT";
}

export type BrowserAction = NavigateAction | ReadPageAction | ExtractTextAction | FindAction | ClickSafeAction | ScreenshotAction;

// =========================================================
// 결과/오류 타입.
// =========================================================

export interface BrowserActionSuccess {
  ok: true;
  action: BrowserAction["type"];
  data?: unknown;
  /** NAVIGATE/CLICK_SAFE가 실제로 landing한 URL(redirect 반영) — 있으면 Core Safety
   *  Gate가 다시 검증한다(§ executeBrowserAction). */
  finalUrl?: string;
}
export interface BrowserActionFailure {
  ok: false;
  action: BrowserAction["type"];
  reason: string;
}
export type BrowserActionResult = BrowserActionSuccess | BrowserActionFailure;

// =========================================================
// URL/Navigation validator — Core hard rule. https만 허용(allow-list 자체가 "https:"
// 하나뿐이므로 javascript:/data:/file:/blob:/ftp: 등은 나열해서 막을 필요 없이 전부
// 자동으로 거부된다), embedded credential(userinfo) 금지, localhost/private/link-local/
// cloud metadata endpoint는 D3의 isPrivateOrMetadataHost()로 차단한다. Browser Worker는
// (Source Adapter와 달리) 고정 host allow-list를 두지 않는다 — 그때그때 다른 공식 문서를
// last-resort로 방문해야 하기 때문이다.
// =========================================================

export interface NavigationUrlValidationOk {
  ok: true;
  url: URL;
}
export interface NavigationUrlValidationFail {
  ok: false;
  reason: string;
}
export type NavigationUrlValidation = NavigationUrlValidationOk | NavigationUrlValidationFail;

export function validateNavigationUrl(rawUrl: string): NavigationUrlValidation {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "URL을 파싱할 수 없습니다." };
  }
  if (url.protocol !== "https:") {
    return { ok: false, reason: `허용되지 않은 scheme(${url.protocol}) — https만 허용됩니다(javascript:/data:/file: 등은 전부 거부).` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: "URL에 embedded credential(userinfo)이 포함될 수 없습니다." };
  }
  if (isPrivateOrMetadataHost(url.hostname)) {
    return { ok: false, reason: `localhost/private network/link-local/cloud metadata endpoint로 판단되는 host(${url.hostname})는 허용되지 않습니다.` };
  }
  return { ok: true, url };
}

// =========================================================
// Core 안전규칙 — "기본 자동 차단" 12개 고위험 action 범주. 이 목록에 걸리면 항상
// HUMAN_APPROVAL_REQUIRED로만 갈 수 있다(D1~D5와 동일한 용어/설계 — 별도의 "BLOCKED"
// 상태가 아니라, "자동 실행되지 않고 사람 승인 없이는 절대 진행되지 않는다"는 뜻이다).
// 이번 E1은 승인 후 실제 실행까지는 구현하지 않는다 — executeBrowserAction()은
// HUMAN_APPROVAL_REQUIRED로 판정된 action을 backend에 아예 전달하지 않는다(fail-closed).
//
// 이 중 상당수(파일 다운로드/업로드/password·secret 입력/browser extension 설치/임의
// executable 실행)는 BrowserAction 타입 자체에 대응하는 action이 없어 애초에 구성할 수
// 없다 — 남은 위험은 CLICK_SAFE 하나의 side effect로만 발생할 수 있으므로,
// classifyClickRisk()가 클릭 대상의 label(관찰된 텍스트)을 키워드로 검사해 그 위험을
// 사전에 잡아낸다. NAVIGATE/READ_PAGE/EXTRACT_TEXT/FIND/SCREENSHOT은 순수 읽기 action이라
// 이 범주에 해당할 수 없다.
// =========================================================

export type HighRiskBrowserCategory =
  | "file_download"
  | "file_upload"
  | "password_or_secret_input"
  | "payment_or_purchase"
  | "financial_transaction"
  | "brokerage_or_trading"
  | "production_db_change"
  | "production_deploy"
  | "account_security_settings_change"
  | "extension_install"
  | "arbitrary_executable_run";

export const CORE_HIGH_RISK_BROWSER_CATEGORIES: ReadonlySet<HighRiskBrowserCategory> = new Set([
  "file_download",
  "file_upload",
  "password_or_secret_input",
  "payment_or_purchase",
  "financial_transaction",
  "brokerage_or_trading",
  "production_db_change",
  "production_deploy",
  "account_security_settings_change",
  "extension_install",
  "arbitrary_executable_run",
]);

interface RiskPattern {
  category: HighRiskBrowserCategory;
  regex: RegExp;
}

// 클릭 대상 label(버튼/링크 텍스트 등 관찰된 문자열)만 검사한다 — 페이지의 다른 어떤
// 콘텐츠도 이 분류에 입력으로 쓰지 않는다(§ 파일 상단 "데이터 처리" 설계: 페이지 콘텐츠는
// 신뢰할 수 없는 외부 입력이며, 이 함수 자체가 "명령"으로 해석되는 게 아니라 오직 위험
// 신호를 찾아 더 보수적으로(HUMAN_APPROVAL_REQUIRED) 판정하는 데만 쓰인다 — 매칭되지
// 않는다고 안전을 보장하지도 않는다, 매칭되면 반드시 승인이 필요하다는 단방향 규칙이다).
const CORE_RISK_PATTERNS: RiskPattern[] = [
  { category: "file_download", regex: /(download|다운로드|save\s*file|파일\s*저장)/i },
  { category: "file_upload", regex: /(upload|업로드|파일\s*선택|choose\s*file|attach\s*file|첨부)/i },
  { category: "password_or_secret_input", regex: /(log\s*in|sign\s*in|로그인|password|비밀번호|secret|api\s*key|credential|2fa|otp)/i },
  { category: "payment_or_purchase", regex: /(buy|purchase|구매|주문|checkout|결제|order\s*now)/i },
  { category: "financial_transaction", regex: /(pay(ment)?\b|송금|이체|transfer\s*funds|wire\s*transfer|invoice)/i },
  { category: "brokerage_or_trading", regex: /(trade|trading|매수|매도|주문체결|buy\s*stock|sell\s*stock|brokerage)/i },
  { category: "production_db_change", regex: /(delete\s*database|drop\s*table|production\s*db|운영\s*(db|디비)|truncate)/i },
  { category: "production_deploy", regex: /(deploy|배포|publish\s*to\s*production|release\s*to\s*production)/i },
  { category: "account_security_settings_change", regex: /(change\s*password|보안\s*설정|비밀번호\s*변경|2단계\s*인증|revoke\s*access|계정\s*삭제|delete\s*account)/i },
  { category: "extension_install", regex: /(add\s*to\s*chrome|install\s*extension|확장\s*프로그램\s*설치|add-on)/i },
  { category: "arbitrary_executable_run", regex: /(run\s*installer|\.exe\b|실행\s*파일|open\s*terminal|execute\s*command)/i },
];

/** label(클릭 대상에 대해 실제로 관찰된 텍스트)만 검사해 매칭되는 고위험 범주를 전부
 *  반환한다 — 아무것도 매칭되지 않으면 빈 배열(그렇다고 클릭이 100% 안전하다는 뜻은
 *  아니다, 단지 알려진 고위험 신호가 없다는 뜻이다). */
export function classifyClickRisk(label: string, policy?: BrowserWorkerPolicy): HighRiskBrowserCategory[] {
  const matched = new Set<HighRiskBrowserCategory>();
  for (const { category, regex } of CORE_RISK_PATTERNS) {
    if (regex.test(label)) matched.add(category);
  }
  for (const extra of policy?.additionalHighRiskLabelKeywords ?? []) {
    if (extra.pattern.test(label)) matched.add(extra.category);
  }
  return [...matched];
}

// =========================================================
// Project Policy — Core 위험등급을 완화할 수 없다(D1~D5와 동일한 설계: 추가만 가능,
// 대체/약화 불가). CORE_HIGH_RISK_BROWSER_CATEGORIES를 줄이거나, CORE_RISK_PATTERNS를
// 대체하거나, validateNavigationUrl의 SSRF 차단을 끌 수 있는 필드는 이 타입에 없다.
// =========================================================

export interface BrowserWorkerPolicy {
  /** Core 키워드 패턴 위에 프로젝트가 추가로 HUMAN_APPROVAL_REQUIRED로 취급하고 싶은
   *  패턴만 더할 수 있다(Core 패턴을 대체/제거하는 필드는 없다). */
  additionalHighRiskLabelKeywords?: { category: HighRiskBrowserCategory; pattern: RegExp }[];
}

export function validateBrowserWorkerPolicy(policy: BrowserWorkerPolicy): void {
  if (!policy || typeof policy !== "object") {
    throw new Error("Invalid BrowserWorkerPolicy: policy가 비어있거나 객체가 아닙니다.");
  }
  if (policy.additionalHighRiskLabelKeywords !== undefined) {
    if (
      !Array.isArray(policy.additionalHighRiskLabelKeywords) ||
      !policy.additionalHighRiskLabelKeywords.every(
        (p) => p && typeof p === "object" && CORE_HIGH_RISK_BROWSER_CATEGORIES.has(p.category) && p.pattern instanceof RegExp
      )
    ) {
      throw new Error(
        "Invalid BrowserWorkerPolicy: additionalHighRiskLabelKeywords는 { category(알려진 값), pattern(RegExp) } 배열이어야 합니다."
      );
    }
  }
}

// =========================================================
// Browser Backend — 실제 실행(예: Playwright)을 주입하는 seam. 이 파일은 실제 브라우저를
// 전혀 실행하지 않는다 — 아래 createFakeBrowserBackend()가 deterministic 테스트 전용
// 구현을 제공한다. 실제 Playwright 연결은 이 interface를 구현하는 별도 모듈로 나중에
// 추가할 수 있으나(이 Task에서 만들지 않는다), 이 interface 자체가 이미 "임의 스크립트
// 실행"을 표현할 방법이 없다는 점에서 안전 경계를 유지한다.
// =========================================================

export interface BackendOutcome<T> {
  ok: boolean;
  data?: T;
  finalUrl?: string;
  reason?: string;
}

export interface BrowserBackend {
  navigate(url: string): Promise<BackendOutcome<{ title?: string }>>;
  readPage(): Promise<BackendOutcome<{ content: string }>>;
  extractText(selector?: string): Promise<BackendOutcome<{ text: string }>>;
  find(query: string): Promise<BackendOutcome<{ matches: string[] }>>;
  clickSafe(selector: string): Promise<BackendOutcome<Record<string, never>>>;
  screenshot(): Promise<BackendOutcome<{ imageBase64: string }>>;
}

export interface FakeBrowserBackendScript {
  navigate?: (url: string) => BackendOutcome<{ title?: string }>;
  readPage?: () => BackendOutcome<{ content: string }>;
  extractText?: (selector?: string) => BackendOutcome<{ text: string }>;
  find?: (query: string) => BackendOutcome<{ matches: string[] }>;
  clickSafe?: (selector: string) => BackendOutcome<Record<string, never>>;
  screenshot?: () => BackendOutcome<{ imageBase64: string }>;
}

/** deterministic fake backend — 실제 브라우저/네트워크를 전혀 쓰지 않는다. script로
 *  각 메서드의 동작을 미리 정의한다(지정하지 않으면 기본값: navigate는 요청한 URL을
 *  그대로 finalUrl로 반환, read/extract/find/screenshot은 고정된 안전한 값을 반환,
 *  clickSafe는 성공). 페이지 콘텐츠(readPage/extractText/find의 결과)에 프롬프트
 *  injection 문자열을 넣어도 이 backend/Core Safety Gate의 동작에는 전혀 영향을 주지
 *  않는다 — 그 결과는 호출부에 그대로 반환될 뿐, 이 모듈 어디에서도 "실행할 명령"으로
 *  다시 파싱되지 않는다(§ 파일 상단 설계 원칙, 테스트로 직접 증명한다). */
export function createFakeBrowserBackend(script: FakeBrowserBackendScript = {}): BrowserBackend {
  return {
    async navigate(url: string) {
      if (script.navigate) return script.navigate(url);
      return { ok: true, data: { title: "fake page" }, finalUrl: url };
    },
    async readPage() {
      if (script.readPage) return script.readPage();
      return { ok: true, data: { content: "fake page content" } };
    },
    async extractText(selector?: string) {
      if (script.extractText) return script.extractText(selector);
      return { ok: true, data: { text: "fake extracted text" } };
    },
    async find(query: string) {
      if (script.find) return script.find(query);
      return { ok: true, data: { matches: [] } };
    },
    async clickSafe(selector: string) {
      if (script.clickSafe) return script.clickSafe(selector);
      return { ok: true, data: {} };
    },
    async screenshot() {
      if (script.screenshot) return script.screenshot();
      return { ok: true, data: { imageBase64: "" } };
    },
  };
}

// =========================================================
// Core Safety Gate + 실행 — 유일한 진입점. BrowserAction을 backend에 넘기기 전에 항상
// 이 게이트를 거친다.
// =========================================================

export type BrowserActionVerdict = "ALLOWED" | "BLOCKED" | "HUMAN_APPROVAL_REQUIRED";

export interface BrowserActionOutcome {
  verdict: BrowserActionVerdict;
  result?: BrowserActionResult;
  /** verdict===HUMAN_APPROVAL_REQUIRED일 때만 채워진다. */
  highRiskCategories?: HighRiskBrowserCategory[];
  reason: string;
}

/**
 * 유일한 실행 진입점. 순서:
 *   1) action별 사전 판정:
 *      - NAVIGATE: validateNavigationUrl(action.url) — 실패하면 즉시 BLOCKED, backend를
 *        전혀 호출하지 않는다.
 *      - CLICK_SAFE: classifyClickRisk(action.label, policy) — 하나라도 매칭되면 즉시
 *        HUMAN_APPROVAL_REQUIRED, backend를 전혀 호출하지 않는다(이번 E1은 승인 후 실행을
 *        구현하지 않는다 — fail-closed).
 *      - READ_PAGE/EXTRACT_TEXT/FIND/SCREENSHOT: 항상 ALLOWED(순수 읽기, 새 위험 없음).
 *   2) ALLOWED로 판정된 action만 backend에 위임한다. backend가 ok:false를 반환하면 그대로
 *      실패로 보고한다(성공으로 처리하지 않음).
 *   3) backend 결과에 finalUrl이 있으면(NAVIGATE/CLICK_SAFE가 실제로 다른 곳으로
 *      landing했을 수 있음) validateNavigationUrl로 다시 검증한다 — 최초 요청 URL은
 *      통과했더라도 실제 도착 URL이 금지 대상이면 결과 전체를 BLOCKED로 뒤집는다("redirect가
 *      금지 origin으로 가면 BLOCK", "page가 다른 URL로 유도해도 Core 규칙 재검사").
 * 이 함수는 policy로 이 순서/판정 자체를 바꿀 방법을 제공하지 않는다 — policy는
 * classifyClickRisk()의 추가 키워드에만 영향을 준다.
 */
export async function executeBrowserAction(
  action: BrowserAction,
  backend: BrowserBackend,
  policy?: BrowserWorkerPolicy
): Promise<BrowserActionOutcome> {
  if (action.type === "NAVIGATE") {
    const urlCheck = validateNavigationUrl(action.url);
    if (!urlCheck.ok) {
      return { verdict: "BLOCKED", reason: `NAVIGATE 차단: ${urlCheck.reason}` };
    }
  }

  if (action.type === "CLICK_SAFE") {
    const risks = classifyClickRisk(action.label, policy);
    if (risks.length > 0) {
      return {
        verdict: "HUMAN_APPROVAL_REQUIRED",
        highRiskCategories: risks,
        reason: `CLICK_SAFE 대상("${action.label}")이 고위험 범주(${risks.join(", ")})에 해당해 사람 승인이 필요합니다 — 이번 버전은 승인 후 실행을 구현하지 않습니다.`,
      };
    }
  }

  const result = await runOnBackend(action, backend);

  if (result.ok && result.finalUrl !== undefined) {
    const finalCheck = validateNavigationUrl(result.finalUrl);
    if (!finalCheck.ok) {
      return {
        verdict: "BLOCKED",
        result: { ok: false, action: action.type, reason: `landing URL 재검증 실패: ${finalCheck.reason}` },
        reason: `실제 도착 URL(${result.finalUrl})이 Core 규칙을 위반해 BLOCK되었습니다(예: redirect로 금지 origin 진입) — 원래 요청 URL이 통과했더라도 결과 전체를 무효화합니다.`,
      };
    }
  }

  return {
    verdict: "ALLOWED",
    result,
    reason: result.ok ? "action이 정상적으로 실행되었습니다." : `backend 실행 실패: ${result.reason}`,
  };
}

async function runOnBackend(action: BrowserAction, backend: BrowserBackend): Promise<BrowserActionResult> {
  switch (action.type) {
    case "NAVIGATE": {
      const outcome = await backend.navigate(action.url);
      return toResult(action.type, outcome);
    }
    case "READ_PAGE": {
      const outcome = await backend.readPage();
      return toResult(action.type, outcome);
    }
    case "EXTRACT_TEXT": {
      const outcome = await backend.extractText(action.selector);
      return toResult(action.type, outcome);
    }
    case "FIND": {
      const outcome = await backend.find(action.query);
      return toResult(action.type, outcome);
    }
    case "CLICK_SAFE": {
      const outcome = await backend.clickSafe(action.selector);
      return toResult(action.type, outcome);
    }
    case "SCREENSHOT": {
      const outcome = await backend.screenshot();
      return toResult(action.type, outcome);
    }
  }
}

function toResult(actionType: BrowserAction["type"], outcome: BackendOutcome<unknown>): BrowserActionResult {
  if (!outcome || outcome.ok !== true) {
    return { ok: false, action: actionType, reason: outcome?.reason ?? "backend가 실패를 보고했습니다(원인 불명)." };
  }
  return { ok: true, action: actionType, data: outcome.data, finalUrl: outcome.finalUrl };
}
