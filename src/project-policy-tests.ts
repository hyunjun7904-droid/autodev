import { validateProjectExecutionPolicy } from "./project-policy";
import type { ProjectExecutionPolicy } from "./project-policy";

// AutoDev 범용화 Phase B Task B1 — Project Execution Policy fail-fast 검증.
//
// 이 파일은 실제 Safe Executor/git/파일시스템을 전혀 건드리지 않는다 — validateProjectExecutionPolicy는
// 순수 함수(정책 객체를 보고 throw하거나 하지 않는다)이고, 이 테스트는 그 동작만 검증한다.

const results: string[] = [];
function check(label: string, cond: boolean): void {
  results.push(`[${cond ? "PASS" : "FAIL"}] ${label}`);
}

function throws(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

function validPolicy(overrides: Partial<ProjectExecutionPolicy> = {}): ProjectExecutionPolicy {
  return {
    allowedReadPrefixes: ["src/"],
    allowedWritePrefixes: ["src/"],
    allowedCommands: [{ cwd: "root", command: "node", args: ["--version"] }],
    ...overrides,
  };
}

function main(): void {
  check("유효한 최소 policy는 통과함", !throws(() => validateProjectExecutionPolicy(validPolicy())));

  check("allowedReadPrefixes 누락 → 실패", throws(() => validateProjectExecutionPolicy({ ...validPolicy(), allowedReadPrefixes: [] })));
  check(
    "allowedReadPrefixes에 절대경로 → 실패",
    throws(() => validateProjectExecutionPolicy({ ...validPolicy(), allowedReadPrefixes: ["/etc/"] }))
  );
  check(
    "allowedReadPrefixes에 exact root file 경로(package.json) → 통과",
    !throws(() => validateProjectExecutionPolicy({ ...validPolicy(), allowedReadPrefixes: ["package.json"] }))
  );
  check(
    "allowedReadPrefixes에 '..' 포함 → 실패(위험하게 전체 filesystem 허용 방지)",
    throws(() => validateProjectExecutionPolicy({ ...validPolicy(), allowedReadPrefixes: ["../"] }))
  );

  check("allowedWritePrefixes 누락 → 실패", throws(() => validateProjectExecutionPolicy({ ...validPolicy(), allowedWritePrefixes: [] })));
  check(
    "allowedWritePrefixes에 malformed 값(빈 문자열) → 실패",
    throws(() => validateProjectExecutionPolicy({ ...validPolicy(), allowedWritePrefixes: [""] }))
  );

  check(
    "allowedWritePrefixes에 exact root file 경로(package.json) → 통과",
    !throws(() => validateProjectExecutionPolicy({ ...validPolicy(), allowedWritePrefixes: ["package.json"] }))
  );
  check(
    "allowedWritePrefixes에 backslash/traversal → 실패",
    throws(() => validateProjectExecutionPolicy({ ...validPolicy(), allowedWritePrefixes: ["a\\..\\b"] }))
  );
  check(
    "allowedWritePrefixes exact file은 sibling prefix 확장이 아님(정책 shape 자체는 통과)",
    !throws(() => validateProjectExecutionPolicy({ ...validPolicy(), allowedWritePrefixes: ["package.json"] }))
  );

  check(
    "writeDenyPatterns가 RegExp 배열이 아님 → 실패",
    throws(() => validateProjectExecutionPolicy({ ...validPolicy(), writeDenyPatterns: ["not-a-regexp"] as unknown as RegExp[] }))
  );
  check(
    "writeDenyPatterns가 유효한 RegExp 배열이면 통과",
    !throws(() => validateProjectExecutionPolicy({ ...validPolicy(), writeDenyPatterns: [/^README\.md$/i] }))
  );

  check(
    "commandCwdAliases에 예약어 'root' 재정의 → 실패",
    throws(() => validateProjectExecutionPolicy({ ...validPolicy(), commandCwdAliases: { root: "x" } }))
  );
  check(
    "commandCwdAliases 값이 절대경로 → 실패",
    throws(() => validateProjectExecutionPolicy({ ...validPolicy(), commandCwdAliases: { web: "/abs/path" } }))
  );
  check(
    "commandCwdAliases 값이 유효한 상대경로면 통과",
    !throws(() =>
      validateProjectExecutionPolicy({
        ...validPolicy(),
        commandCwdAliases: { web: "web" },
        allowedCommands: [{ cwd: "web", command: "npx", args: ["tsc"] }],
      })
    )
  );

  check(
    "allowedCommands가 배열이 아님(malformed command policy) → 실패",
    throws(() => validateProjectExecutionPolicy({ ...validPolicy(), allowedCommands: "not-an-array" as unknown as ProjectExecutionPolicy["allowedCommands"] }))
  );
  check(
    "allowedCommands 항목의 cwd가 'root'도 아니고 commandCwdAliases에도 없음 → 실패",
    throws(() => validateProjectExecutionPolicy({ ...validPolicy(), allowedCommands: [{ cwd: "web", command: "npx", args: [] }] }))
  );
  check(
    "allowedCommands 항목의 command가 빈 문자열 → 실패",
    throws(() => validateProjectExecutionPolicy({ ...validPolicy(), allowedCommands: [{ cwd: "root", command: "", args: [] }] }))
  );
  check(
    "allowedCommands 항목의 args가 string[]이 아님 → 실패",
    throws(() =>
      validateProjectExecutionPolicy({ ...validPolicy(), allowedCommands: [{ cwd: "root", command: "node", args: [1] as unknown as string[] }] })
    )
  );
  check("allowedCommands가 빈 배열이어도 통과(명령이 필요 없는 프로젝트)", !throws(() => validateProjectExecutionPolicy({ ...validPolicy(), allowedCommands: [] })));

  check("policy 자체가 null → 실패(silent permissive 기본값 없음)", throws(() => validateProjectExecutionPolicy(null as unknown as ProjectExecutionPolicy)));
  check(
    "policy 자체가 undefined → 실패",
    throws(() => validateProjectExecutionPolicy(undefined as unknown as ProjectExecutionPolicy))
  );

  console.log("\n=== project-policy(Project Execution Policy fail-fast) 테스트 결과 ===");
  for (const r of results) console.log(r);
  const passCount = results.filter((r) => r.startsWith("[PASS]")).length;
  console.log(`\n총 ${results.length}건, PASS ${passCount}, FAIL ${results.length - passCount}`);
  if (results.some((r) => r.startsWith("[FAIL]"))) process.exitCode = 1;
}

main();
