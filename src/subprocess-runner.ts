import { spawn } from "node:child_process";

// SI-3.6(Executable Identity Trust) bounded review(chunk1 HIGH, 4라운드) 지적 반영 — 이전에는
// claude-runner.ts가 exported `execAndClassify(command: string, ...)`를 통해 "claude 신뢰
// 경로"와 "임의 command를 그대로 spawn하는 범용 실행기"를 한 함수에 묶어 노출했다. 그
// export 자체가 production 코드(또는 미래의 production 코드)가 trust resolution을 건너뛰고
// 임의 executable을 spawn할 수 있는 정상 API였다 — production 호출부가 실제로 그렇게 하고
// 있지 않다는 사실은 "그럴 수 없다"는 구조적 보장이 아니었다.
//
// 이 파일은 claude 신뢰와 완전히 무관한, 진짜 범용 subprocess 실행 유틸리티만 담는다 —
// timeout/stdout·stderr 캡처/spawn 실패(ENOENT 등) 관측만 하고, "이 command가 신뢰할 수
// 있는가"는 전혀 판단하지 않는다(그 판단은 항상 trusted-executable-resolver.ts +
// claude-runner.ts의 resolveTrustedClaudeCommand()가 호출 전에 이미 끝내야 한다). 이 함수가
// exported돼 있다는 사실 자체는 node:child_process.spawn이 전역적으로 접근 가능한 것과 같은
// 성격이다 — claude 관련 브랜딩/암묵적 신뢰가 전혀 없으므로, 이 함수가 널리 재사용된다고
// 해서 "claude 신뢰가 우회됐다"는 뜻이 되지 않는다. claude-runner.ts(runClaudeTask)와
// claude-developer.ts(callClaude)는 이 함수를 항상 이미 신뢰가 확인된 command로만 호출한다.
export interface SubprocessOutcome {
  timedOut: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** spawn 자체가 실패했을 때만 채워진다(예: ENOENT) — 프로세스가 일단 시작된 뒤의 종료
   *  코드/timeout과는 다른 실패 단계다. */
  spawnErrorCode?: string;
  spawnErrorMessage?: string;
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // stdout/stderr 각각 2MB로 제한

/**
 * command/args를 shell:false로 직접 spawn하고, timeout/출력/spawn 실패를 관측해 반환한다.
 * 이 함수는 command의 신뢰 여부를 전혀 판단하지 않는다 — 호출부가 이미 검증한 값만 넘겨야
 * 한다(§ 파일 상단 설명).
 */
export function runSubprocessWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number,
  stdinInput?: string
): Promise<SubprocessOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { shell: false });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      resolve({ timedOut: false, code: null, stdout: "", stderr: "", spawnErrorCode: err?.code, spawnErrorMessage: String(e) });
      return;
    }

    // 프롬프트가 큰 경우 CLI 인자로 넘기면 OS 명령행 길이 제한(Windows 등)에 걸릴 수 있다
    // (실제로 ENAMETOOLONG 발생 확인) — stdin으로 전달해 이 제한을 피한다.
    if (stdinInput !== undefined) {
      child.stdin?.write(stdinInput, "utf-8");
      child.stdin?.end();
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, code: null, stdout, stderr, spawnErrorCode: err.code, spawnErrorMessage: err.message });
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf-8");
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut, code, stdout, stderr });
    });
  });
}
