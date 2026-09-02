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
  /** AutoDev Core Maintenance — Canonical Stop Path(2026-08-31). true면 timeout이 아니라
   *  호출부가 넘긴 abortSignal이 발동해 child를 종료했다는 뜻이다 — timedOut과 배타적이며
   *  분류(§ claude-runner.ts classifySubprocessOutcome)에서 반드시 timedOut보다 먼저
   *  확인해야 한다(둘 다 SIGKILL로 이어지지만 "의도된 정상 중단"과 "진짜 timeout"은 재시도
   *  정책이 완전히 다르다 — abort는 절대 재시도 대상이 아니다). */
  aborted?: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** spawn 자체가 실패했을 때만 채워진다(예: ENOENT) — 프로세스가 일단 시작된 뒤의 종료
   *  코드/timeout과는 다른 실패 단계다. */
  spawnErrorCode?: string;
  spawnErrorMessage?: string;
  /** AutoDev Core Maintenance — Two-Tier Round Timeout(2026-09-03, § 요구사항 "10분
   *  no-progress + 30분 hard cap"). timedOut===true일 때만 의미가 있고, 항상 어느 타이머가
   *  실제로 강제종료를 유발했는지 정확히 반영한다(hard cap timer는 noProgressTimeoutMs
   *  지정 여부와 무관하게 항상 존재하므로, 지정하지 않은 호출부도 timedOut=true면 항상
   *  "HARD_CAP"을 받는다 — 새 필드를 추가했을 뿐 기존 timedOut/code/stdout/stderr 등 다른
   *  필드의 동작은 전혀 바꾸지 않았으므로 하위 호환에 영향 없다). */
  timeoutKind?: "HARD_CAP" | "NO_PROGRESS";
}

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // stdout/stderr 각각 2MB로 제한

/**
 * command/args를 shell:false로 직접 spawn하고, timeout/출력/spawn 실패를 관측해 반환한다.
 * 이 함수는 command의 신뢰 여부를 전혀 판단하지 않는다 — 호출부가 이미 검증한 값만 넘겨야
 * 한다(§ 파일 상단 설명).
 *
 * cwd(2026-08-29, AutoDev Claude Developer context/token 소비 근본 조사) — 지정하지 않으면
 * 기존과 완전히 동일하게 이 Node 프로세스 자신의 process.cwd()를 그대로 물려받는다(기존
 * 모든 호출부의 동작을 전혀 바꾸지 않는다). claude-developer.ts의 callClaude()만 실제
 * 대상 프로젝트 root를 명시적으로 넘긴다 — Claude Code CLI가 spawn 시점의 cwd를 기준으로
 * 자체적으로 환경 컨텍스트(CLAUDE.md 등)를 읽어들이므로, 지정하지 않으면 이 함수를 호출한
 * AutoDev Core 프로세스 자신의 cwd(예: runner-supervisor.ts가 continuous runner를 spawn할
 * 때 쓰는 AutoDev Core 저장소 root)가 그대로 상속되어 개발 대상 프로젝트와 무관한 큰
 * context가 매 호출마다 섞여 들어갈 수 있다(실측: JARVIS Task 5.2에서 관찰됨).
 */
export function runSubprocessWithTimeout(
  command: string,
  args: string[],
  timeoutMs: number,
  stdinInput?: string,
  cwd?: string,
  /** AutoDev Core Maintenance — Canonical Stop Path(2026-08-31, JARVIS Task 5.3 실측 —
   *  "실행 중인 Developer/continuous run을 canonical하게 정상 중단할 수 없는 결함"). 발동되면
   *  timeout과 동일하게 child를 SIGKILL로 종료하지만(§ 이 파일이 이미 갖고 있던 유일한 종료
   *  수단을 재사용 — 새 종료 경로를 만들지 않는다), outcome.aborted=true로 timeout과
   *  구분한다. */
  abortSignal?: AbortSignal,
  /** AutoDev Core Maintenance — Two-Tier Round Timeout(2026-09-03). 지정하면 timeoutMs는
   *  "hard cap"(절대 상한, 진행 여부와 무관하게 이 시간이 지나면 무조건 종료)의 의미가 되고,
   *  이 값은 "no-progress" 상한이 된다 — stdout/stderr에 새 데이터가 도착할 때마다 이 타이머만
   *  리셋된다(hard cap 타이머는 활동과 무관하게 그대로 진행). 즉 실제로 진행 중인 호출은 계속
   *  살아있고, 정말 응답이 끊긴(hang) 호출만 이 no-progress 상한에서 먼저 종료된다. 지정하지
   *  않으면(undefined, 기존 모든 호출부의 기본값) 기존과 완전히 동일한 단일 hard-cap timer
   *  동작이다 — 이 파라미터를 추가했다는 사실만으로 기존 호출부의 동작이 바뀌지 않는다. */
  noProgressTimeoutMs?: number
): Promise<SubprocessOutcome> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { shell: false, ...(cwd ? { cwd } : {}) });
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
    let aborted = false;
    let timeoutKind: "HARD_CAP" | "NO_PROGRESS" | undefined;

    const hardCapTimer = setTimeout(() => {
      timedOut = true;
      timeoutKind = "HARD_CAP";
      child.kill("SIGKILL");
    }, timeoutMs);

    // no-progress timer는 noProgressTimeoutMs가 지정됐을 때만 존재한다 — 매 stdout/stderr
    // data 이벤트마다 clearTimeout 후 재설정("활동이 있으면 리셋")한다. hard cap timer와
    // 완전히 독립적으로 동작하며 둘 중 먼저 발동하는 쪽이 child를 종료한다.
    let noProgressTimer: ReturnType<typeof setTimeout> | undefined;
    const armNoProgressTimer = (): void => {
      if (noProgressTimeoutMs === undefined) return;
      if (noProgressTimer) clearTimeout(noProgressTimer);
      noProgressTimer = setTimeout(() => {
        timedOut = true;
        timeoutKind = "NO_PROGRESS";
        child.kill("SIGKILL");
      }, noProgressTimeoutMs);
    };
    armNoProgressTimer();

    const onAbort = (): void => {
      if (settled) return;
      aborted = true;
      child.kill("SIGKILL");
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardCapTimer);
      if (noProgressTimer) clearTimeout(noProgressTimer);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      resolve({ timedOut: false, code: null, stdout, stderr, spawnErrorCode: err.code, spawnErrorMessage: err.message });
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf-8");
      armNoProgressTimer();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf-8");
      armNoProgressTimer();
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardCapTimer);
      if (noProgressTimer) clearTimeout(noProgressTimer);
      if (abortSignal) abortSignal.removeEventListener("abort", onAbort);
      resolve({ timedOut, aborted, code, stdout, stderr, ...(timeoutKind ? { timeoutKind } : {}) });
    });
  });
}
