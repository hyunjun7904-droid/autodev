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
];

// key 뒤에 JSON 닫는따옴표(")가 올 수도 있으므로(예: "access_token":"...") "?로 허용한다.
const KV_PATTERN = new RegExp(`(${REDACT_KEYS.join("|")})"?\\s*[:=]\\s*[^\\n,;}]+`, "gi");

export function sanitizeForLog(input: string): string {
  return input.replace(KV_PATTERN, (_match, key: string) => `${key}=[REDACTED]`);
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
