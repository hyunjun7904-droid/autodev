import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { getDashboardSnapshot } from "./dashboard-snapshot-provider";
import { DASHBOARD_HTML } from "./dashboard-html";

// Local Operations Dashboard — 읽기 전용 HTTP server (Phase G Task G4.1).
//
// 이 서버는 GET(및 HEAD) 두 method만 처리한다 — POST/PUT/PATCH/DELETE는 어떤 경로로
// 와도 항상 405다(§ 요구사항: Approve/Reject/Git/Claude/shell 실행/파일 수정/AutoDev 상태
// 변경 버튼 자체가 없음 — 그런 요청을 받아줄 route가 코드에 아예 없다). 라우트는 두 개뿐이다:
//   GET /              -> 정적 HTML(dashboard-html.ts, 그 안의 client JS가 /api/snapshot만
//                          polling한다)
//   GET /api/snapshot  -> G4 AutoDevLiveSnapshot(dashboard-snapshot-provider.ts)을 그대로
//                          JSON으로 반환 — 이 파일은 응답을 만들기 전에 그 값을 가공/재해석
//                          하지 않는다.
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

function createRequestHandler(eventsFilePath?: string) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "READ_ONLY_DASHBOARD_GET_ONLY" });
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/api/snapshot") {
      const snapshot = eventsFilePath !== undefined ? getDashboardSnapshot(eventsFilePath) : getDashboardSnapshot();
      sendJson(res, 200, snapshot);
      return;
    }
    if (path === "/" || path === "/index.html") {
      sendHtml(res, 200, DASHBOARD_HTML);
      return;
    }
    sendJson(res, 404, { error: "NOT_FOUND" });
  };
}

/** 서버를 시작하고 실제로 listening 상태가 됐을 때 resolve한다. host는 항상 127.0.0.1로
 *  고정된다 — 이 함수 시그니처 자체에 host를 바꿀 방법이 없다. */
export function startDashboardServer(opts: DashboardServerOptions = {}): Promise<DashboardServerHandle> {
  const port = opts.port ?? DEFAULT_PORT;
  return new Promise((resolvePromise, reject) => {
    const server: Server = createServer(createRequestHandler(opts.eventsFilePath));
    server.once("error", reject);
    server.listen(port, LOCALHOST, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const boundPort = typeof address === "object" && address !== null ? address.port : port;
      resolvePromise({
        url: `http://${LOCALHOST}:${boundPort}`,
        host: LOCALHOST,
        port: boundPort,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });
}
