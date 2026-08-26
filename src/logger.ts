import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = join(__dirname, "..", "logs");
const LOG_FILE = join(LOG_DIR, "automation.log");

// 최소 마스킹 대상 — key:value / key=value 형태 어디에서 나오든 값 부분을 전부 가린다.
const REDACT_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "SUPABASE_SECRET_KEY",
  "AUTODEV_TELEGRAM_BOT_TOKEN",
  "access_token",
  "refresh_token",
  "client_secret",
  "authorization",
  "uploadUrl",
  // AutoDev / JARVIS Unattended Continuous Development Reliability Hardening Phase 8 —
  // secret-scanner.ts의 SECRET_CONTENT_PATTERNS(commit 대상 내용 판정)와 동일한 일반
  // key 집합을 log() 출력에도 defense-in-depth로 추가한다(§ 요구사항: password/Secret
  // plaintext가 진단 로그에 남지 않아야 함). 이 파일의 게이트는 log()를 거치는 값에만
  // 적용되며 Secret Scanner Gate(commit 차단)를 대체하지 않는다.
  "password",
  "passwd",
  "secret",
  "credential",
];

// key 뒤에 JSON 닫는따옴표(")가 올 수도 있으므로(예: "access_token":"...") "?로 허용한다.
const KV_PATTERN = new RegExp(`(${REDACT_KEYS.join("|")})"?\\s*[:=]\\s*[^\\n,;}]+`, "gi");

// Authorization 헤더가 key:value 형태 없이 "Bearer <token>"만 단독으로 등장하는 경우(예:
// curl -H 문자열을 그대로 로그에 남기는 경우)까지 방어한다 — 위 KV_PATTERN은 key가 있어야만
// 매칭되므로 이 패턴을 별도로 둔다.
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g;

export function sanitizeForLog(input: string): string {
  const kvRedacted = input.replace(KV_PATTERN, (_match, key: string) => `${key}=[REDACTED]`);
  return kvRedacted.replace(BEARER_TOKEN_PATTERN, "Bearer [REDACTED]");
}

// process.env 전체를 그대로 문자열화해 로그로 남기는 함수는 의도적으로 만들지 않는다.
export function log(message: string, meta?: unknown): void {
  const safeMessage = sanitizeForLog(message);
  const safeMeta = meta === undefined ? "" : ` ${sanitizeForLog(JSON.stringify(meta))}`;
  const line = `[${new Date().toISOString()}] ${safeMessage}${safeMeta}`;
  console.log(line);
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line + "\n", "utf-8");
  } catch {
    // 로그 파일 기록 실패는 치명적이지 않다 — 콘솔 출력은 이미 이루어졌다.
  }
}
