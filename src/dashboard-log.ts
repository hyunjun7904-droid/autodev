import { appendFileSync, existsSync, renameSync, statSync } from "node:fs";

// AutoDev Dashboard 서버 장애 원인분석·복구·하드닝 — 구조화 로그(§ 요구사항 12/13).
//
// 이 파일이 하는 일은 두 가지뿐이다: (1) "무엇이 언제 일어났는가"를 한 줄 JSON으로 append하고,
// (2) 그 로그 파일이 무한히 커지지 않게 크기 기준으로 회전(rotate)한다. 새 무거운 logging
// 프레임워크는 도입하지 않는다 — fs만 쓴다.
//
// 절대 여기서 하지 않는 것: 환경변수 전체 덤프, secret/토큰/비밀번호 원문 기록. 호출부(§
// dashboard-server.ts/dashboard-supervisor.ts)는 이미 알고 있는 구조화된 필드(event 이름,
// pid, port, exitCode 같은 짧은 고정 어휘/숫자)만 넘긴다 — 임의 예외 메시지를 그대로 전달하지
// 않는다(예외 메시지에 파일 경로 이상의 민감한 내용이 섞여 있을 수 있다는 가정 하에).
//
// 로그 기록 자체가 실패해도(디스크 가득 참, 권한 문제 등) 절대 호출자를 향해 throw하지 않는다
// — 로그는 관측 수단일 뿐, 로그 실패가 대시보드/supervisor 프로세스를 죽이는 새로운 원인이
// 되어서는 안 된다(§ 요구사항 5의 정신을 로깅 자체에도 적용).

export interface DashboardLogFields {
  event: string;
  [key: string]: unknown;
}

/** 로그 파일이 maxBytes를 넘으면 단일 backup(`<path>.1`)으로 회전하고 새 파일을 시작한다 —
 *  무한 rotation 체인을 만들지 않는다(가장 단순한 크기 제한). */
export function pruneLogIfTooLarge(logFilePath: string, maxBytes: number): void {
  try {
    if (!existsSync(logFilePath)) return;
    const size = statSync(logFilePath).size;
    if (size < maxBytes) return;
    const backupPath = `${logFilePath}.1`;
    if (existsSync(backupPath)) {
      try {
        renameSync(backupPath, `${backupPath}.tmp-delete`);
      } catch {
        // 무시하고 그냥 덮어쓰기 시도로 진행한다.
      }
    }
    renameSync(logFilePath, backupPath);
  } catch {
    // 회전 실패는 로그 손실일 뿐 프로세스에 영향을 주지 않는다.
  }
}

/** 한 줄 JSON으로 append한다 — timestamp/pid는 항상 자동으로 채운다(호출부가 매번 반복
 *  하지 않도록). 실패해도 절대 throw하지 않는다. */
export function appendDashboardLog(logFilePath: string, fields: DashboardLogFields, maxBytes = 5 * 1024 * 1024): void {
  try {
    pruneLogIfTooLarge(logFilePath, maxBytes);
    const line = JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, ...fields });
    appendFileSync(logFilePath, line + "\n", "utf-8");
  } catch {
    // 로그를 남기지 못해도 호출자에게 전파하지 않는다(§ 상단 주석).
  }
}
