import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ENV_FILE_PATTERNS, SECRET_NAME_PATTERNS } from "./safe-executor";
import type { WorkingTreeChange } from "./git-changes";

// Deterministic Secret Scanner Gate — Phase C Task C3.
//
// commit(checkpoint) 대상 파일에 secret/API key/token/password/private key가 포함돼
// 있는지 "정규식 기반 deterministic 규칙"만으로 판정한다. AI(Claude/GPT) 판단에 의존하지
// 않는다 — 이 모듈은 LLM을 호출하지 않고, 어떤 LLM 출력도 신뢰 입력으로 받지 않는다.
//
// Safe Executor(무엇을 읽고/쓰고/실행할 수 있는지)와 책임을 분리한다 — 이 모듈은 "commit
// 하려는 변경에 민감정보가 포함됐는가"만 판정하며, read/write 허용 여부는 전혀 판단하지
// 않는다.
//
// 이 모듈은 어떤 ProjectExecutionPolicy도, 어떤 형태의 "약화/우회" 옵션도 받지 않는다 —
// 함수 시그니처에 그런 파라미터 자체가 없으므로, 어떤 프로젝트도 이 Core 보호를 끄거나
// 좁힐 방법이 없다(safe-executor.ts의 DENY_PATH_PATTERNS/SECRET_NAME_PATTERNS와 동일한
// 설계 원칙).
//
// 탐지 결과(SecretFinding)에는 파일/줄 번호/탐지 종류만 담는다 — 실제로 매칭된 원문 문자열은
// 절대 담지 않는다. 이 결과는 그대로 로그(logger.ts)·checkpoint 실패 사유·상위 호출자에게
// 전달되므로, 여기서 원문을 담지 않는 것이 "secret 원문을 console/log/error/GPT
// review/Claude feedback 어디에도 노출하지 않는다"는 요구사항을 구조적으로 보장한다.

export type SecretFindingKind =
  | "env-file"
  | "secret-filename"
  | "private-key-header"
  | "cloud-provider-key"
  | "generic-api-key"
  | "bearer-token"
  | "credential-assignment";

export interface SecretFinding {
  /** POSIX 상대경로. */
  file: string;
  /** 파일명 기반 탐지는 0(파일 전체에 적용되는 판정이라 특정 줄이 없음). */
  line: number;
  kind: SecretFindingKind;
}

export interface SecretScanResult {
  clean: boolean;
  findings: SecretFinding[];
}

export interface ContentPattern {
  kind: SecretFindingKind;
  regex: RegExp;
}

// 각 정규식은 전역(g) 플래그를 쓰지 않는다 — .test()를 여러 줄에 반복 호출해도 lastIndex
// 상태를 공유하지 않게 하기 위함(전역 플래그 재사용 시 흔한 버그를 피한다).
//
// Phase G Task G1 — observability-event.ts가 audit event payload의 secret-shape 텍스트
// 값을 redact할 때 이 배열을 그대로 재사용한다(단일 출처, 목록 복제 금지). 이 배열은 여기
// export되지만, 그 사실이 이 Task 범위 밖에서 새로운 secret 판정 로직을 만들어도 된다는
// 뜻은 아니다 — 항상 여기서 import해서 쓴다.
export const SECRET_CONTENT_PATTERNS: ContentPattern[] = [
  { kind: "private-key-header", regex: /-----BEGIN\s+[A-Z0-9 ]*PRIVATE KEY-----/ },
  { kind: "cloud-provider-key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "generic-api-key", regex: /\bsk-(ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { kind: "generic-api-key", regex: /\b(api[_-]?key|apikey)\b\s*[:=]\s*["'][A-Za-z0-9_\-/+=]{16,}["']/i },
  { kind: "bearer-token", regex: /\bBearer\s+[A-Za-z0-9_\-.]{16,}/ },
  {
    kind: "credential-assignment",
    regex: /\b(password|passwd|pwd|secret|credential|client_secret|access_token|refresh_token)\b\s*[:=]\s*["'][^"'\s]{6,}["']/i,
  },
];

/** 파일 내용을 줄 단위로 검사한다 — 순수 함수(파일시스템 접근 없음)라 단위 테스트하기 쉽다. */
export function scanContentForSecrets(content: string, filePath: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { kind, regex } of SECRET_CONTENT_PATTERNS) {
      if (regex.test(line)) {
        findings.push({ file: filePath, line: i + 1, kind });
      }
    }
  }
  return findings;
}

/** 파일명만으로 판정한다 — safe-executor.ts의 ENV_FILE_PATTERNS/SECRET_NAME_PATTERNS를
 *  그대로 재사용한다(단일 출처, 목록 복제 금지). */
export function scanFileNameForSecrets(filePath: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const base = filePath.split("/").pop() ?? filePath;
  if (ENV_FILE_PATTERNS.some((p) => p.test(filePath))) {
    findings.push({ file: filePath, line: 0, kind: "env-file" });
  }
  if (SECRET_NAME_PATTERNS.some((p) => p.test(base))) {
    findings.push({ file: filePath, line: 0, kind: "secret-filename" });
  }
  return findings;
}

/**
 * checkpoint.ts가 실제로 commit하려는 변경(WorkingTreeChange[])을 검사하는 진입점.
 * 파일명 기반 탐지는 항상 수행하고, 삭제(deleted)가 아닌 파일은 cwd 기준으로 실제 내용을
 * 읽어 content 기반 탐지도 수행한다. 읽기에 실패하는 파일(바이너리 등)은 내용 검사만
 * 건너뛴다 — 파일명 기반 탐지는 이미 수행됐으므로 완전히 무검사 상태가 되지는 않는다.
 */
export function scanChangesForSecrets(changes: WorkingTreeChange[], cwd: string): SecretScanResult {
  const findings: SecretFinding[] = [];
  for (const change of changes) {
    findings.push(...scanFileNameForSecrets(change.path));
    if (change.status === "deleted") continue;
    let raw: string;
    try {
      raw = readFileSync(join(cwd, ...change.path.split("/")), "utf-8");
    } catch {
      continue;
    }
    findings.push(...scanContentForSecrets(raw, change.path));
  }
  return { clean: findings.length === 0, findings };
}
