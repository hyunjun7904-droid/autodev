import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { getDashboardSnapshot, getMultiProjectDashboardSnapshot } from "./dashboard-snapshot-provider";
import type { DashboardSnapshot, MultiProjectDashboardSnapshot } from "./dashboard-snapshot-provider";
import { DASHBOARD_HTML } from "./dashboard-html";
import { appendDashboardLog } from "./dashboard-log";
import { join } from "node:path";

// Local Operations Dashboard — 읽기 전용 HTTP server (Phase G Task G4.1).
//
// 이 서버는 GET(및 HEAD) 두 method만 처리한다 — POST/PUT/PATCH/DELETE는 어떤 경로로
// 와도 항상 405다(§ 요구사항: Approve/Reject/Git/Claude/shell 실행/파일 수정/AutoDev 상태
// 변경 버튼 자체가 없음 — 그런 요청을 받아줄 route가 코드에 아예 없다). 라우트는 세 개뿐이다:
//   GET /              -> 정적 HTML(dashboard-html.ts, 그 안의 client JS가 /api/snapshots만
//                          polling한다)
//   GET /api/snapshot  -> (단수형, 레거시) 단일 project DashboardSnapshot을 그대로 JSON으로
//                          반환한다 — 기존 단일 project 배포/테스트와의 호환을 위해 동작을
//                          바꾸지 않는다.
//   GET /api/snapshots -> (복수형, AutoDev Dashboard 멀티프로젝트 운영센터 개선) 등록됐거나
//                          실제로 실행된 적이 있는 모든 project의 DashboardSnapshot을 배열로
//                          반환한다(dashboard-snapshot-provider.ts의
//                          getMultiProjectDashboardSnapshot()) — 이 파일은 두 route 모두
//                          응답을 만들기 전에 그 값을 가공/재해석하지 않는다.
//
// 기본 bind host는 항상 127.0.0.1이다 — 이 상수는 옵션으로 노출하지 않는다(0.0.0.0
// 공개/port forwarding/public tunnel은 이번 Task 범위 밖 — § 요구사항). 포트만 옵션으로
// 받는다.

const LOCALHOST = "127.0.0.1";
// 오토데브 대시보드 후속 개선(윈도우 자동 실행) — dashboard.ts가 실제 서버를 시작하기 전에
// "이미 이 포트에서 정상 대시보드가 떠 있는지"를 미리 확인해야 하므로(§ 요구사항 19 중복
// 실행 방지) 이 상수를 export한다(단일 출처 유지 — 다른 파일에 4590을 다시 하드코딩하지
// 않는다).
export const DEFAULT_PORT = 4590;

export interface DashboardServerOptions {
  /** 기본값 4590. 테스트에서는 0을 넘겨 OS가 빈 포트를 골라주게 한다. */
  port?: number;
  /** 테스트 전용 — 읽을 event 파일 경로를 override한다. 지정하지 않으면 production 경로
   *  (RUNTIME_EVENT_LOG_PATH)를 그대로 쓴다. */
  eventsFilePath?: string;
  /** 테스트 전용 — GET /api/snapshots(멀티프로젝트)가 project registry를 읽을 때 쓸
   *  환경변수를 override한다. 지정하지 않으면 production과 동일하게 실제 process.env를
   *  그대로 쓴다(§ dashboard-project-registry.ts) — 실제 개발 환경에 이미 설정돼 있을 수
   *  있는 AUTODEV_PROJECT_ADAPTER 등이 테스트 fixture에 우연히 섞여 들어오는 것을 막기
   *  위한 격리 seam이다. */
  projectRegistryEnv?: NodeJS.ProcessEnv;
}

export interface DashboardServerHandle {
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  res.end(html);
}

// AutoDev 대시보드 서버 장애 원인분석·복구·하드닝 — 실제 재현된 결함: 이전에는 이 파일의
// request handler가 getDashboardSnapshot()의 예외를 전혀 잡지 않았다. event 파일이 순간적으로
// 없거나/잠겨 있거나/손상됐거나(§ 요구사항 4의 fault-injection 목록, 예: EISDIR/ENOENT/EACCES)
// project adapter 설정이 잘못돼 있으면 그 예외가 이 request listener 밖으로 그대로 전파되어
// Node의 HTTP 서버 전체가 uncaught exception으로 죽었다(직접 실제 서버로 재현해 확인함 —
// eventsFilePath를 디렉터리로 바꿔 GET /api/snapshot 한 번으로 프로세스가 죽는 것을 관찰했다).
// 이제 이 경계(§ trySnapshot)가 모든 snapshot 생성 예외를 흡수해 500/DEGRADED로만 응답하고
// 프로세스는 항상 살아있게 한다 — 성공한 것처럼 응답하지 않고, 보안 오류를 무시하지도 않는다
// (실제 실패는 정직하게 DEGRADED/500으로 드러낸다, 원문 예외 메시지/경로는 응답에 담지 않는다).
type SnapshotAttempt = { ok: true; snapshot: DashboardSnapshot } | { ok: false; reason: string };

function trySnapshot(eventsFilePath?: string): SnapshotAttempt {
  try {
    const snapshot = eventsFilePath !== undefined ? getDashboardSnapshot(eventsFilePath) : getDashboardSnapshot();
    return { ok: true, snapshot };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.constructor.name : "UNKNOWN_ERROR" };
  }
}

// AutoDev Dashboard 멀티프로젝트 운영센터 개선 — GET /api/snapshots(복수형, 새 route).
// 기존 GET /api/snapshot(단수형)은 단일 project 배포/기존 테스트와의 호환을 위해 동작을
// 전혀 바꾸지 않는다 — 새 멀티프로젝트 화면은 이 새 route만 쓴다. 실패 시 흡수 규칙은 위
// trySnapshot()과 완전히 동일하다(§ 요구사항: 어떤 요청 하나의 실패도 서버 프로세스 전체를
// 끌고 내려가서는 안 된다).
type MultiSnapshotAttempt = { ok: true; snapshot: MultiProjectDashboardSnapshot } | { ok: false; reason: string };

function tryMultiSnapshot(eventsFilePath?: string, projectRegistryEnv?: NodeJS.ProcessEnv): MultiSnapshotAttempt {
  try {
    const snapshot = getMultiProjectDashboardSnapshot(eventsFilePath, undefined, { env: projectRegistryEnv });
    return { ok: true, snapshot };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.constructor.name : "UNKNOWN_ERROR" };
  }
}

const DASHBOARD_LOG_PATH = join(process.cwd(), "logs", "dashboard.log");

function createRequestHandler(eventsFilePath?: string, projectRegistryEnv?: NodeJS.ProcessEnv) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    // 클라이언트가 응답 중간에 연결을 끊으면(§ 요구사항 4 시나리오 16) res(ServerResponse)에
    // 'error' 이벤트가 뜰 수 있다 — EventEmitter는 'error' 리스너가 하나도 없으면 그 예외를
    // 다시 throw해 프로세스를 죽인다. 리스너를 달아 조용히 흡수한다(응답을 이미 보낼 수 없는
    // 상태이므로 추가로 할 일이 없다 — 성공으로 위장하지 않는다, 그냥 로그만 남긴다).
    res.on("error", () => {
      appendDashboardLog(DASHBOARD_LOG_PATH, { event: "RESPONSE_STREAM_ERROR", path: req.url ?? "/" });
    });

    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "READ_ONLY_DASHBOARD_GET_ONLY" });
        return;
      }
      const path = (req.url ?? "/").split("?")[0];
      if (path === "/api/snapshot") {
        const attempt = trySnapshot(eventsFilePath);
        if (attempt.ok) {
          sendJson(res, 200, attempt.snapshot);
        } else {
          appendDashboardLog(DASHBOARD_LOG_PATH, { event: "SNAPSHOT_READ_FAILED", reason: attempt.reason });
          sendJson(res, 500, { status: "DEGRADED", error: "SNAPSHOT_READ_FAILED" });
        }
        return;
      }
      if (path === "/api/snapshots") {
        const attempt = tryMultiSnapshot(eventsFilePath, projectRegistryEnv);
        if (attempt.ok) {
          sendJson(res, 200, attempt.snapshot);
        } else {
          appendDashboardLog(DASHBOARD_LOG_PATH, { event: "MULTI_SNAPSHOT_READ_FAILED", reason: attempt.reason });
          sendJson(res, 500, { status: "DEGRADED", error: "SNAPSHOT_READ_FAILED" });
        }
        return;
      }
      if (path === "/health") {
        const attempt = trySnapshot(eventsFilePath);
        sendJson(res, 200, {
          server: "UP",
          snapshotSource: attempt.ok ? "OK" : "DEGRADED",
          generatedAt: new Date().toISOString(),
        });
        return;
      }
      if (path === "/" || path === "/index.html") {
        sendHtml(res, 200, DASHBOARD_HTML);
        return;
      }
      sendJson(res, 404, { error: "NOT_FOUND" });
    } catch (e) {
      // 위 분기 어디선가(예: sendJson/sendHtml 자체) 예외가 나도 마지막 방어선으로 여기서
      // 흡수한다 — 이 서버는 읽기 전용 관측 도구일 뿐이므로 어떤 요청 하나의 실패도 서버
      // 프로세스 전체를 끌고 내려가서는 안 된다.
      appendDashboardLog(DASHBOARD_LOG_PATH, {
        event: "REQUEST_HANDLER_EXCEPTION",
        reason: e instanceof Error ? e.constructor.name : "UNKNOWN_ERROR",
      });
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { status: "DEGRADED", error: "REQUEST_HANDLER_EXCEPTION" });
        } catch {
          // 응답조차 보낼 수 없는 상태(예: 소켓이 이미 닫힘) — 더 이상 손쓸 방법이 없으니
          // 조용히 포기한다. 프로세스는 이미 안전하다(예외가 여기서 더 전파되지 않는다).
        }
      }
    }
  };
}

/** 서버를 시작하고 실제로 listening 상태가 됐을 때 resolve한다. host는 항상 127.0.0.1로
 *  고정된다 — 이 함수 시그니처 자체에 host를 바꿀 방법이 없다. */
export function startDashboardServer(opts: DashboardServerOptions = {}): Promise<DashboardServerHandle> {
  const port = opts.port ?? DEFAULT_PORT;
  return new Promise((resolvePromise, reject) => {
    const server: Server = createServer(createRequestHandler(opts.eventsFilePath, opts.projectRegistryEnv));
    // § 요구사항 5 — startup 실패(예: EADDRINUSE)는 이 Promise를 reject해야 하지만, listen이
    // 이미 성공한 뒤에 발생하는 'error'(드물지만 가능 — 예: accept 단계의 일시적 OS 오류)까지
    // 조용히 삼키면 안 되면서도 프로세스를 죽여서는 안 된다. 이전 코드는 `server.once("error",
    // reject)` 뒤 listen 성공 시 그 리스너를 완전히 제거했다 — 그 뒤로는 'error' 리스너가
    // 하나도 없는 상태가 되어, listen 이후 서버에서 나는 어떤 'error'든 uncaught exception으로
    // 프로세스를 죽일 수 있었다(EventEmitter는 'error' 리스너가 0개면 그 값을 throw한다). 이제
    // 리스너를 절대 제거하지 않고, "아직 시작 전인가"만 플래그로 구분한다.
    let started = false;
    server.on("error", (err) => {
      if (!started) {
        reject(err);
        return;
      }
      appendDashboardLog(DASHBOARD_LOG_PATH, {
        event: "SERVER_ERROR",
        port,
        reason: err instanceof Error ? err.constructor.name : "UNKNOWN_ERROR",
      });
    });
    server.listen(port, LOCALHOST, () => {
      started = true;
      const address = server.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      appendDashboardLog(DASHBOARD_LOG_PATH, { event: "LISTENING", port: boundPort });
      resolvePromise({
        url: `http://${LOCALHOST}:${boundPort}`,
        host: LOCALHOST,
        port: boundPort,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((err) => {
              if (err) {
                rejectClose(err);
              } else {
                appendDashboardLog(DASHBOARD_LOG_PATH, { event: "SHUTDOWN", port: boundPort });
                resolveClose();
              }
            });
          }),
      });
    });
  });
}
