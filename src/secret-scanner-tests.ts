import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  scanContentForSecrets,
  scanFileNameForSecrets,
  scanChangesForSecrets,
} from "./secret-scanner";
import { performTaskCheckpoint } from "./checkpoint";
import type { TaskDefinition } from "./task-registry";
import type { WorkingTreeChange } from "./git-changes";

// Deterministic Secret Scanner Gate 테스트(Phase C Task C3). 실제 Claude/GPT 유료 API를
// 전혀 호출하지 않고, MOVAN product task도 실행하지 않는다 — 순수 문자열/파일 기반
// deterministic 판정과, checkpoint-tests.ts와 동일하게 매 시나리오마다 만드는 OS 임시
// git repo만 사용한다(실제 이 저장소의 git repo에는 어떤 명령도 실행하지 않는다).
//
// 여기서 쓰는 "가짜 secret" 값들은 전부 테스트 전용 더미 문자열이며 실제 자격증명이
// 아니다 — "secret 원문이 로그에 남지 않음" 시나리오는 이 더미 문자열이 console 출력
// 어디에도 그대로 나타나지 않는지를 검증한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function makeTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "autodev-secret-scanner-test-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "autodev-test@example.com"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "AutoDev Test"], { cwd: dir });
  writeFileSync(join(dir, ".gitkeep"), "");
  spawnSync("git", ["add", "--", ".gitkeep"], { cwd: dir });
  spawnSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
  return dir;
}

function writeFile(repo: string, relPath: string, content: string): void {
  const abs = join(repo, ...relPath.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function gitLogCount(repo: string): number {
  const res = spawnSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf-8" });
  return (res.stdout || "").split("\n").filter(Boolean).length;
}

function fakeTask(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: "99.3",
    phase: 99,
    taskNumber: 3,
    title: "secret scanner 테스트용 가짜 task",
    prompt: "(테스트 전용)",
    requiredTests: [],
    allowedPathPrefixes: ["src/allowed/"],
    prohibitedOperations: [],
    ...overrides,
  };
}

function change(path: string, status: WorkingTreeChange["status"] = "untracked"): WorkingTreeChange {
  return { path, status };
}

// 더미 값 — 실제 자격증명이 아니다. 로그 노출 검증에도 그대로 재사용한다.
const FAKE_OPENAI_KEY = "sk-THISISFAKEDUMMYTESTKEY1234567890ABCDEF";
const FAKE_BEARER = "Bearer FAKE-DUMMY-BEARER-TOKEN-0000000000";
const FAKE_PASSWORD_LINE = 'password: "SuperFakeDummyPass123"';
const FAKE_PRIVATE_KEY_HEADER = "-----BEGIN RSA PRIVATE KEY-----";

function scenarioFakeApiKeyDetected(): void {
  const findings = scanContentForSecrets(`const key = "${FAKE_OPENAI_KEY}";\n`, "src/allowed/a.ts");
  check("fake API key(sk-...) 탐지됨", findings.some((f) => f.kind === "generic-api-key"));

  // GitHub Push Protection이 "AKIA"+16자 연속 문자열을 실제 AWS Access Key ID 형태로
  // 인식해 push를 막으므로, 소스 파일 안에는 그 20자가 연속으로 존재하지 않도록 두
  // 조각으로 나눠 런타임에만 합친다(런타임 content 문자열은 여전히 우리 정규식과
  // 정확히 동일하게 매칭된다 — 탐지 로직 검증 자체는 그대로 유지됨).
  const fakeAwsLikeKey = "AKIA" + "ABCDEFGHIJKLMNOP";
  const findings2 = scanContentForSecrets(`apiKey: "${fakeAwsLikeKey}"\n`, "src/allowed/b.ts");
  check(
    "AWS류 access key id(AKIA...) 탐지됨",
    findings2.some((f) => f.kind === "cloud-provider-key" || f.kind === "generic-api-key")
  );
}

function scenarioFakeBearerTokenDetected(): void {
  const findings = scanContentForSecrets(`headers.set("Authorization", "${FAKE_BEARER}");\n`, "src/allowed/c.ts");
  check("fake bearer/token 탐지됨", findings.some((f) => f.kind === "bearer-token"));
}

function scenarioCredentialPasswordDetected(): void {
  const findings = scanContentForSecrets(`${FAKE_PASSWORD_LINE}\n`, "src/allowed/d.ts");
  check("credential/password 형태 탐지됨", findings.some((f) => f.kind === "credential-assignment"));

  const findings2 = scanContentForSecrets(`client_secret = "abcdef1234567890"\n`, "src/allowed/e.ts");
  check("client_secret 할당 탐지됨", findings2.some((f) => f.kind === "credential-assignment"));
}

function scenarioPrivateKeyHeaderDetected(): void {
  const findings = scanContentForSecrets(`${FAKE_PRIVATE_KEY_HEADER}\nMIIFAKEDATA...\n-----END RSA PRIVATE KEY-----\n`, "src/allowed/f.pem");
  check("private key header 탐지됨", findings.some((f) => f.kind === "private-key-header"));
}

function scenarioSecretLikeFilenameDetected(): void {
  check("'.env' 파일명 탐지됨", scanFileNameForSecrets(".env").some((f) => f.kind === "env-file"));
  check("'.env.production' 파일명 탐지됨", scanFileNameForSecrets(".env.production").some((f) => f.kind === "env-file"));
  check(
    "'automation/config/api-key.json' 파일명 탐지됨",
    scanFileNameForSecrets("automation/config/api-key.json").some((f) => f.kind === "secret-filename")
  );
  check("'id_rsa' 파일명 탐지됨", scanFileNameForSecrets("id_rsa").some((f) => f.kind === "secret-filename"));
}

function scenarioNormalCodePasses(): void {
  const ts = `export function add(a: number, b: number): number {\n  return a + b;\n}\n`;
  const json = `{\n  "name": "fixture",\n  "value": 42\n}\n`;
  const fixture = `export const sampleTask = {\n  id: "1.1",\n  title: "샘플 task",\n};\n`;
  check("정상 TypeScript 코드 통과(findings 없음)", scanContentForSecrets(ts, "src/allowed/normal.ts").length === 0);
  check("정상 JSON 통과(findings 없음)", scanContentForSecrets(json, "src/allowed/normal.json").length === 0);
  check("정상 fixture 통과(findings 없음)", scanContentForSecrets(fixture, "src/allowed/normal-fixture.ts").length === 0);
  check("정상 파일명 통과(findings 없음)", scanFileNameForSecrets("src/allowed/normal.ts").length === 0);
}

function scenarioNoRawSecretInLogs(): void {
  const originalLog = console.log;
  const captured: string[] = [];
  console.log = (...args: unknown[]) => {
    captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };

  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "src/allowed/leak.ts", `const key = "${FAKE_OPENAI_KEY}";\nconst auth = "${FAKE_BEARER}";\n`);
    performTaskCheckpoint(fakeTask(), {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
    });
  } finally {
    console.log = originalLog;
    rmSync(repo, { recursive: true, force: true });
  }

  const allOutput = captured.join("\n");
  check(
    "checkpoint BLOCK 로그에 fake API key 원문이 등장하지 않음",
    !allOutput.includes(FAKE_OPENAI_KEY)
  );
  check("checkpoint BLOCK 로그에 fake bearer 원문이 등장하지 않음", !allOutput.includes(FAKE_BEARER));

  // logs/automation.log에도 원문이 남지 않아야 한다(logger.ts가 실제로 파일에 append함).
  try {
    const logPath = join(__dirname, "..", "logs", "automation.log");
    const logContent = readFileSync(logPath, "utf-8");
    check("automation.log 파일에도 fake API key 원문이 남지 않음", !logContent.includes(FAKE_OPENAI_KEY));
  } catch {
    // 로그 파일이 아직 없다면(첫 실행 등) 이 하위 검증은 건너뛴다 — console 검증만으로도
    // 핵심 요구사항(원문 미노출)은 이미 검증된다.
  }
}

function scenarioSecretFindingsContainNoRawValue(): void {
  const findings = scanContentForSecrets(`const key = "${FAKE_OPENAI_KEY}";\n`, "src/allowed/g.ts");
  const serialized = JSON.stringify(findings);
  check("SecretFinding 직렬화 결과에 원문 값이 없음", !serialized.includes(FAKE_OPENAI_KEY));
  check(
    "SecretFinding은 file/line/kind 필드만 가짐",
    findings.every((f) => Object.keys(f).sort().join(",") === "file,kind,line")
  );
}

function scenarioCheckpointBlocksOnSecret(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "src/allowed/a.ts", "export const a = 1;\n");
    writeFile(repo, "src/allowed/config.ts", `export const apiKey = "${FAKE_OPENAI_KEY}";\n`);
    const before = gitLogCount(repo);
    const outcome = performTaskCheckpoint(fakeTask(), {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
    });
    check("secret 포함 시 checkpoint ok=false(BLOCK)", outcome.ok === false);
    check(
      "secret 포함 시 secretFindings에 src/allowed/config.ts 포함",
      (outcome.secretFindings ?? []).some((f) => f.file === "src/allowed/config.ts")
    );
    check("secret 포함 시 실제 git commit이 생성되지 않음", gitLogCount(repo) === before);

    const statusAfter = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: repo, encoding: "utf-8" });
    check(
      "secret 포함 시 파일들이 미staged 상태로 남음(git add조차 실행되지 않음)",
      (statusAfter.stdout || "").split("\n").every((l) => l === "" || l.startsWith("??"))
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioCleanChangesStillCommit(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "src/allowed/a.ts", "export const a = 1;\n");
    const before = gitLogCount(repo);
    const outcome = performTaskCheckpoint(fakeTask(), {
      decision: "PASS",
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
    });
    check("secret 없는 정상 변경은 checkpoint ok=true", outcome.ok === true);
    check("secret 없는 정상 변경은 실제 commit 생성됨", gitLogCount(repo) === before + 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioProjectPolicyCannotBypassScanner(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "src/allowed/config.ts", `export const apiKey = "${FAKE_OPENAI_KEY}";\n`);
    const before = gitLogCount(repo);
    // performTaskCheckpoint의 옵션 타입(PerformCheckpointOptions)에는 secret scanner를
    // 끄거나 약화시킬 필드가 존재하지 않는다 — 그런 필드를 흉내내 억지로 끼워 넣어도
    // (as any) 런타임이 그 필드를 전혀 읽지 않으므로 여전히 BLOCK되어야 한다.
    const bypassAttempt = {
      decision: "PASS" as const,
      severity: { critical: 0, high: 0, medium: 0 },
      requiredTestsAllPassed: true,
      cwd: repo,
      disableSecretScanner: true,
      skipSecretScan: true,
      projectPolicy: { allowSecrets: true },
    };
    const outcome = performTaskCheckpoint(fakeTask(), bypassAttempt as unknown as Parameters<typeof performTaskCheckpoint>[1]);
    check("가짜 '우회' 필드를 넣어도 checkpoint는 여전히 BLOCK", outcome.ok === false);
    check("가짜 '우회' 필드를 넣어도 commit이 생성되지 않음", gitLogCount(repo) === before);
    check(
      "가짜 '우회' 필드를 넣어도 secretFindings가 비어있지 않음",
      (outcome.secretFindings ?? []).length > 0
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function scenarioScanChangesForSecretsFilenameAndContentTogether(): void {
  const repo = makeTempGitRepo();
  try {
    writeFile(repo, "src/allowed/normal.ts", "export const ok = true;\n");
    const result = scanChangesForSecrets(
      [change("src/allowed/normal.ts"), change("src/allowed/.env")],
      repo
    );
    check("scanChangesForSecrets: 정상 파일은 findings 없음", !result.findings.some((f) => f.file === "src/allowed/normal.ts"));
    check("scanChangesForSecrets: .env 파일명은 findings에 포함", result.findings.some((f) => f.file === "src/allowed/.env" && f.kind === "env-file"));
    check("scanChangesForSecrets: clean=false(하나라도 발견됨)", result.clean === false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

function main(): void {
  scenarioFakeApiKeyDetected();
  scenarioFakeBearerTokenDetected();
  scenarioCredentialPasswordDetected();
  scenarioPrivateKeyHeaderDetected();
  scenarioSecretLikeFilenameDetected();
  scenarioNormalCodePasses();
  scenarioSecretFindingsContainNoRawValue();
  scenarioNoRawSecretInLogs();
  scenarioCheckpointBlocksOnSecret();
  scenarioCleanChangesStillCommit();
  scenarioProjectPolicyCannotBypassScanner();
  scenarioScanChangesForSecretsFilenameAndContentTogether();

  console.log("\n=== secret-scanner 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
