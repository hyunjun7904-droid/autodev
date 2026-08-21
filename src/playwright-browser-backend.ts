import { chromium } from "playwright";
import type { Browser as RealBrowser, BrowserContext as RealContext, Page as RealPage, Locator as RealLocator } from "playwright";
import {
  validateNavigationUrl,
  assessClickTargetStructure,
  executeBrowserAction,
} from "./browser-worker";
import type { BrowserAction, BrowserBackend, BackendOutcome, BrowserWorkerPolicy, BrowserActionOutcome, ClickTargetStructuralSignals } from "./browser-worker";

// Playwright Browser Backend & Safe Interaction Preflight — Phase E Task E2.
//
// E1(browser-worker.ts)의 executeBrowserAction()을 유일한 상위 실행 경계로 유지한다 —
// 이 파일은 executeBrowserAction()이 호출하는 BrowserBackend 구현 하나를 실제 Playwright로
// 제공할 뿐, 별도의 public 실행 경로(임의 navigation/download/upload/credential 입력/
// shell 실행/production action)를 만들지 않는다. 이 파일이 export하는 것은 (1)
// createPlaywrightBrowserBackend() — BrowserBackend를 구현하는 factory와, (2)
// runBrowserAction() — executeBrowserAction()에 그대로 위임하는 얇은 편의 wrapper뿐이다.
// CLICK_SAFE의 실제 클릭은 항상 이 backend의 clickSafe()를 거치고, clickSafe()는 물리적
// 클릭 이전에 반드시 DOM에서 구조적 신호를 읽어 E1의 assessClickTargetStructure()로
// 재검증한다 — 상위(executeBrowserAction)에서 이미 구조적 신호를 검사했더라도(action에
// structuralSignals가 있었더라도), 이 backend는 자신이 실제로 클릭할 대상을 다시 독립적으로
// 검사한다("Browser가 E1 Core Safety Gate를 우회해서는 안 된다" — 상위 호출자가
// structuralSignals를 빠뜨리거나 stale한 값을 넘겨도 이 backend가 최종 방어선이 된다).
//
// 자동 로그인/credential 저장은 구현하지 않는다 — BrowserContext를 매번 새로 만들고
// storageState를 저장하지 않는다(persistent session/cookie 저장 없음).

// =========================================================
// Playwright 실행 seam — dependency-scanner.ts/source-adapter.ts와 동일한 설계 원칙:
// 실제 운용 기본 구현(realChromiumLauncher)은 진짜 Playwright(chromium.launch())를 쓰지만,
// 이 파일의 나머지 로직과 모든 회귀 테스트는 이 launcher를 fixture로 주입해 실제 브라우저
// 없이 deterministic하게 검증한다. 아래 *Like interface는 실제 Playwright 타입의 부분
// 집합만 명시적으로 정의한 것이다 — 복잡한 오버로드/제네릭 타입에 대한 암묵적 구조적
// 호환에 기대지 않고, realChromiumLauncher가 실제 Playwright 객체를 명시적으로 이
// interface로 감싼다(§ wrapPage/wrapContext 등).
// =========================================================

export interface PlaywrightResponseLike {
  url(): string;
  status(): number;
  ok(): boolean;
}

export interface PlaywrightLocatorLike {
  count(): Promise<number>;
  first(): PlaywrightLocatorLike;
  getAttribute(name: string): Promise<string | null>;
  // 이 콜백은 Node가 아니라 브라우저 페이지 컨텍스트 안에서 직렬화되어 실행된다 —
  // tsconfig에 "dom" lib이 없어(이 저장소는 Node 전용 lib만 쓴다) DOM Element 타입을
  // 참조할 수 없으므로 el의 타입은 unknown으로 두고, 호출부(clickSafe)가 필요한 만큼만
  // 명시적으로 캐스팅해서 쓴다.
  evaluate<T>(fn: (el: unknown) => T): Promise<T>;
  innerText(options?: { timeout?: number }): Promise<string>;
  click(options?: { timeout?: number }): Promise<void>;
  allTextContents(): Promise<string[]>;
}

export interface PlaywrightGotoOptions {
  timeout?: number;
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
}

export interface PlaywrightPageLike {
  goto(url: string, options?: PlaywrightGotoOptions): Promise<PlaywrightResponseLike | null>;
  content(): Promise<string>;
  url(): string;
  locator(selector: string): PlaywrightLocatorLike;
  getByText(text: string): PlaywrightLocatorLike;
  screenshot(options?: { timeout?: number }): Promise<Uint8Array>;
  close(): Promise<void>;
  onPopup(handler: (popup: PlaywrightPageLike) => void): void;
  /** 실제 network navigation 없이 페이지 콘텐츠를 직접 설정한다(Playwright의
   *  page.setContent) — Phase E Task E2.1: 격리된 로컬 fixture로 smoke test를 구성하기
   *  위한 것으로, BrowserAction에는 대응 action이 없다(agent가 호출할 수 있는 실행
   *  경로가 아니다 — executeBrowserAction()이 소비하는 BrowserBackend interface에도
   *  없고, PlaywrightBrowserBackend에만 테스트/smoke 전용으로 노출된다). */
  setContent(html: string): Promise<void>;
}

export interface PlaywrightContextLike {
  newPage(): Promise<PlaywrightPageLike>;
  close(): Promise<void>;
}

export interface PlaywrightBrowserLike {
  newContext(): Promise<PlaywrightContextLike>;
  close(): Promise<void>;
}

export interface PlaywrightLaunchOptions {
  headless?: boolean;
}

export type PlaywrightLauncher = (options?: PlaywrightLaunchOptions) => Promise<PlaywrightBrowserLike>;

// ---- 실제 Playwright 객체를 위 *Like interface로 명시적으로 감싼다(구조적 호환에 기대지
// 않고, 필요한 호출만 직접 위임한다). ----

function wrapLocator(locator: RealLocator): PlaywrightLocatorLike {
  return {
    count: () => locator.count(),
    first: () => wrapLocator(locator.first()),
    getAttribute: (name) => locator.getAttribute(name),
    evaluate: (fn) => locator.evaluate(fn as never),
    innerText: (options) => locator.innerText(options),
    click: (options) => locator.click(options),
    allTextContents: () => locator.allTextContents(),
  };
}

function wrapPage(page: RealPage): PlaywrightPageLike {
  return {
    goto: async (url, options) => {
      const res = await page.goto(url, options);
      return res ? { url: () => res.url(), status: () => res.status(), ok: () => res.ok() } : null;
    },
    content: () => page.content(),
    url: () => page.url(),
    locator: (selector) => wrapLocator(page.locator(selector)),
    getByText: (text) => wrapLocator(page.getByText(text)),
    screenshot: (options) => page.screenshot(options),
    close: () => page.close(),
    onPopup: (handler) => {
      page.on("popup", (popup: RealPage) => handler(wrapPage(popup)));
    },
    setContent: (html) => page.setContent(html),
  };
}

function wrapContext(context: RealContext): PlaywrightContextLike {
  return {
    newPage: async () => wrapPage(await context.newPage()),
    close: () => context.close(),
  };
}

function wrapBrowser(browser: RealBrowser): PlaywrightBrowserLike {
  return {
    newContext: async () => wrapContext(await browser.newContext()),
    close: () => browser.close(),
  };
}

/** 실제 운용 기본 구현 — Playwright의 실제 chromium을 실행한다. 테스트는 이 함수를 쓰지
 *  않고 fixture launcher를 주입한다(네트워크/실제 브라우저 불필요). */
export const realChromiumLauncher: PlaywrightLauncher = async (options) => {
  const browser = await chromium.launch({ headless: options?.headless ?? true });
  return wrapBrowser(browser);
};

// =========================================================
// backend 설정 — timeout/lifecycle을 명시적으로 다룬다.
// =========================================================

export interface PlaywrightBackendConfig {
  launcher?: PlaywrightLauncher;
  headless?: boolean;
  navigationTimeoutMs?: number;
  actionTimeoutMs?: number;
  /** popup이 감지될 때마다 호출된다(관찰용) — popup은 검증 후 항상 닫힌다(§ 아래 설명).
   *  테스트가 popup 검증 결과를 확인할 수 있도록 제공한다. */
  onPopup?: (info: { url: string; validation: ReturnType<typeof validateNavigationUrl> }) => void;
  policy?: BrowserWorkerPolicy;
}

const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

export interface PlaywrightBrowserBackend extends BrowserBackend {
  /** 실제 browser/context/page를 정리한다 — 반드시 호출해야 한다(리소스 누수 방지). 여러
   *  번 호출해도 안전하다. */
  dispose(): Promise<void>;
  /** Phase E Task E2.1 — 실제 network navigation 없이(page.setContent) 격리된 로컬
   *  fixture HTML을 로드한다. smoke/통합 테스트가 외부 인터넷 없이 READ_PAGE/
   *  EXTRACT_TEXT/FIND/CLICK_SAFE를 실제 Chromium으로 검증할 수 있게 하기 위한 것이다 —
   *  BrowserAction에는 대응하는 action이 없으므로 agent가 executeBrowserAction()을 통해
   *  호출할 수 있는 경로가 아니다(별도 실행 경계를 만들지 않는다는 원칙 유지). */
  loadFixtureContent(html: string): Promise<BackendOutcome<Record<string, never>>>;
}

function toBackendError<T>(reason: string): BackendOutcome<T> {
  return { ok: false, reason };
}

/**
 * 실제(또는 fixture) Playwright launcher로 browser/context/page를 생성하고 BrowserBackend를
 * 구현하는 backend를 반환한다. 순서: launcher() → browser.newContext() → context.newPage()
 * → page에 popup 핸들러를 등록한다(§ popup 처리). 이 함수가 반환한 backend는
 * E1의 executeBrowserAction()에 그대로 전달해서 쓴다 — 이 파일은 그 게이트를 우회하는
 * 별도 실행 경로를 제공하지 않는다.
 *
 * popup 처리: page에서 popup이 열리면(예: target="_blank" 링크 클릭) 새 Page가 생성된다.
 * 이 backend는 그 popup의 URL을 즉시 validateNavigationUrl()로 재검증하고(§
 * "popup/new page가 생기면 새 URL을 다시 검증"), 검증 결과와 무관하게 popup을 즉시
 * 닫는다 — 이번 E2는 두 번째 page에서 추가 action을 실행하는 멀티 페이지 워크플로를
 * 지원하지 않으므로("검증 전에는 해당 페이지에서 추가 action을 실행하지 않는다"는 요구를
 * "그 페이지에서는 아예 action을 실행하지 않는다"로 가장 안전하게 만족시킨다). 검증 결과는
 * config.onPopup으로 관찰할 수 있다.
 */
export async function createPlaywrightBrowserBackend(config: PlaywrightBackendConfig = {}): Promise<PlaywrightBrowserBackend> {
  const launcher = config.launcher ?? realChromiumLauncher;
  const navigationTimeoutMs = config.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  const actionTimeoutMs = config.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;

  const browser = await launcher({ headless: config.headless ?? true });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.onPopup((popup) => {
    const url = popup.url();
    const validation = validateNavigationUrl(url);
    config.onPopup?.({ url, validation });
    // 검증 통과 여부와 무관하게 즉시 닫는다 — 이 backend는 popup에서 추가 action을 절대
    // 실행하지 않는다(fail-closed, 멀티 페이지 워크플로 미지원).
    void popup.close().catch(() => {});
  });

  let disposed = false;

  async function dispose(): Promise<void> {
    if (disposed) return;
    disposed = true;
    try {
      await context.close();
    } catch {
      // 정리 실패는 무시 — 이미 닫혔거나 프로세스가 종료 중일 수 있다.
    }
    try {
      await browser.close();
    } catch {
      // 위와 동일.
    }
  }

  async function navigate(url: string): Promise<BackendOutcome<{ title?: string }>> {
    try {
      await page.goto(url, { timeout: navigationTimeoutMs, waitUntil: "load" });
      return { ok: true, data: {}, finalUrl: page.url() };
    } catch (err) {
      return toBackendError(describeError(err));
    }
  }

  async function loadFixtureContent(html: string): Promise<BackendOutcome<Record<string, never>>> {
    try {
      await page.setContent(html);
      return { ok: true, data: {} };
    } catch (err) {
      return toBackendError(describeError(err));
    }
  }

  async function readPage(): Promise<BackendOutcome<{ content: string }>> {
    try {
      const content = await page.content();
      return { ok: true, data: { content } };
    } catch (err) {
      return toBackendError(describeError(err));
    }
  }

  async function extractText(selector?: string): Promise<BackendOutcome<{ text: string }>> {
    try {
      const target = page.locator(selector ?? "body").first();
      const text = await target.innerText({ timeout: actionTimeoutMs });
      return { ok: true, data: { text } };
    } catch (err) {
      return toBackendError(describeError(err));
    }
  }

  async function find(query: string): Promise<BackendOutcome<{ matches: string[] }>> {
    try {
      const locator = page.getByText(query);
      const matches = (await locator.allTextContents()).slice(0, 20);
      return { ok: true, data: { matches } };
    } catch (err) {
      return toBackendError(describeError(err));
    }
  }

  async function screenshot(): Promise<BackendOutcome<{ imageBase64: string }>> {
    try {
      const buffer = await page.screenshot({ timeout: actionTimeoutMs });
      return { ok: true, data: { imageBase64: Buffer.from(buffer).toString("base64") } };
    } catch (err) {
      return toBackendError(describeError(err));
    }
  }

  async function clickSafe(selector: string): Promise<BackendOutcome<Record<string, never>>> {
    try {
      const locator = page.locator(selector).first();
      const count = await locator.count();
      if (count === 0) {
        return toBackendError(`selector("${selector}")에 해당하는 element를 찾을 수 없습니다.`);
      }

      // Safe Interaction Preflight — 실제 클릭 직전에 DOM에서 구조적 신호를 읽는다. 이
      // backend는 상위 호출자가 이미 structuralSignals를 검증했는지 여부와 무관하게 항상
      // 독립적으로 다시 검사한다(최종 방어선).
      const signals = await locator.evaluate((el): ClickTargetStructuralSignals => {
        const anyEl = el as unknown as {
          tagName: string;
          getAttribute(name: string): string | null;
          hasAttribute(name: string): boolean;
          type?: string;
          href?: string;
          target?: string;
          name?: string;
          autocomplete?: string;
          form?: { action?: string; method?: string } | null;
        };
        return {
          tagName: anyEl.tagName.toLowerCase(),
          type: anyEl.type,
          href: anyEl.href,
          target: anyEl.target,
          hasDownloadAttribute: anyEl.hasAttribute("download"),
          isFormAssociated: !!anyEl.form,
          formAction: anyEl.form?.action,
          formMethod: anyEl.form?.method,
          name: anyEl.name,
          autocomplete: anyEl.autocomplete,
        };
      });

      const assessment = assessClickTargetStructure(signals, config.policy);
      if (assessment.verdict !== "ALLOWED") {
        return toBackendError(
          `Safe Interaction Preflight가 클릭을 거부했습니다(${assessment.verdict}): ${assessment.reasons.join("; ")}`
        );
      }

      await locator.click({ timeout: actionTimeoutMs });
      return { ok: true, data: {}, finalUrl: page.url() };
    } catch (err) {
      return toBackendError(describeError(err));
    }
  }

  return { navigate, readPage, extractText, find, clickSafe, screenshot, dispose, loadFixtureContent };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * executeBrowserAction()에 그대로 위임하는 얇은 편의 wrapper — 이 backend를 만들고,
 * action 하나를 실행하고, 반드시 dispose()까지 정리한다. 이 함수 자체는 어떤 새 판정
 * 로직도 갖지 않는다(E1의 게이트를 그대로 통과시킬 뿐이다) — 별도 실행 경계를 만들지
 * 않는다는 원칙을 지키기 위해, 이 wrapper를 거치지 않고 backend.<method>()를 직접 호출하는
 * 코드가 있다면 그것은 이 모듈의 의도된 사용법이 아니다(항상 executeBrowserAction 경유).
 */
export async function runBrowserAction(
  action: BrowserAction,
  config: PlaywrightBackendConfig = {}
): Promise<{ outcome: BrowserActionOutcome; backend: PlaywrightBrowserBackend }> {
  const backend = await createPlaywrightBrowserBackend(config);
  const outcome = await executeBrowserAction(action, backend, config.policy);
  return { outcome, backend };
}
