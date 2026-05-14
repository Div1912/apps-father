import * as http from "http";
import * as net from "net";
import * as url from "url";
import { WebSocketServer, WebSocket } from "ws";
import { config } from "../../config";
import { isValidAdminToken } from "./admin.routes";
import { dockerRunnerService } from "../../services/docker-runner.service";

/**
 * WebSocket-backed shell console for project containers (docker mode only).
 *
 * Endpoint:  /admin/api/projects/:projectId/console/ws?token=<adminToken>
 *
 * Browser → server frame protocol (text frames for control, binary for stdin):
 *   - Binary frames: forwarded straight to the container's stdin.
 *     The browser is expected to send keystrokes as utf-8 binary chunks
 *     (xterm.js's `term.onData(buf => ws.send(buf))` does this naturally).
 *   - Text frames: JSON control messages
 *     {"type":"resize","cols":N,"rows":N}  — sent on terminal resize.
 *
 * Server → browser frames:
 *   - Binary frames: stdout / stderr from the docker exec process.
 *   - Text frames:   JSON status messages
 *     {"type":"status","state":"connected"|"closed","exitCode":N}
 *
 * Auth:
 *   - Admin bearer token passed via `?token=` (WebSocket constructor cannot
 *     attach custom headers from a browser). Validated against the in-memory
 *     activeTokens Set in admin.routes.ts via {@link isValidAdminToken}.
 *
 * Isolation:
 *   - The shell runs inside the project's container as the unprivileged
 *     `node` user, with cwd=/workspace. It cannot reach the platform host or
 *     any platform secrets. Container resource limits (memory/cpu/pids) apply.
 *   - node-pty allocates a real PTY so docker exec accepts --tty, giving the
 *     shell a proper interactive session (prompt, echo, SIGWINCH on resize).
 */

const wss = new WebSocketServer({ noServer: true });
const PATH_RE = /^\/admin\/api\/projects\/([0-9a-f-]{8,})\/console\/ws(?:\?(.*))?$/;

/**
 * Match an upgrade request and, if it targets the console endpoint, perform
 * the upgrade. Returns true when the URL belongs to this subsystem (the
 * outer dispatcher should stop searching for handlers).
 */
export async function handleConsoleUpgrade(
  request: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
): Promise<boolean> {
  const reqUrl = request.url || "";
  const match = PATH_RE.exec(reqUrl);
  if (!match) return false;

  const projectId = match[1];
  const query = match[2] || "";
  const params = new URLSearchParams(query);
  const token = params.get("token");

  if (!isValidAdminToken(token)) {
    safeReject(socket, 401, "unauthorized");
    return true;
  }
  if (config.runtimeMode !== "docker") {
    safeReject(socket, 409, "console requires RUNTIME_MODE=docker");
    return true;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    attachConsoleSession(ws, projectId).catch((err) => {
      try {
        ws.send(JSON.stringify({
          type: "status",
          state: "error",
          message: (err as Error).message,
        }));
        ws.close(1011, "session_attach_failed");
      } catch { /* socket already closed */ }
    });
  });
  return true;
}

async function attachConsoleSession(ws: WebSocket, projectId: string): Promise<void> {
  // Make sure the container is up; surfaces a clean error to the client if
  // not (e.g. project crashed and is in circuit-break).
  try {
    await dockerRunnerService.ensureRunning(projectId);
  } catch (err) {
    ws.send(JSON.stringify({
      type: "status",
      state: "error",
      message: `worker_unavailable: ${(err as Error).message}`,
    }));
    ws.close(1011, "worker_unavailable");
    return;
  }

  // Start with a sensible default; the browser sends a resize message
  // immediately after receiving "connected" so the PTY adjusts to the
  // actual xterm.js dimensions within milliseconds.
  const stream = dockerRunnerService.execStreaming(projectId, {
    cmd: ["sh"],
    cols: 80,
    rows: 24,
  });

  ws.send(JSON.stringify({ type: "status", state: "connected" }));

  // ── PTY output → WebSocket binary frames ─────────────────────────────────
  // node-pty merges stdout and stderr into a single data event.
  stream.onData((chunk) => {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(chunk, { binary: true }); } catch { /* socket closing */ }
  });

  // ── WebSocket → PTY stdin + resize ───────────────────────────────────────
  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      try { stream.write(data as Buffer); } catch { /* pty closed */ }
      return;
    }
    // Text frame: JSON control message.
    let msg: { type?: string; cols?: number; rows?: number };
    try { msg = JSON.parse((data as Buffer).toString("utf8")); } catch { return; }
    if (msg.type === "resize" && msg.cols && msg.rows) {
      stream.resize(msg.cols, msg.rows);
    }
  });

  // ── Cleanup ──────────────────────────────────────────────────────────────
  const closeAll = (exitCode: number | null) => {
    if (ws.readyState === ws.OPEN) {
      try {
        ws.send(JSON.stringify({
          type: "status",
          state: "closed",
          exitCode: exitCode ?? -1,
        }));
        ws.close(1000, "session_ended");
      } catch { /* ignore */ }
    }
  };

  stream.onExit((code) => closeAll(code));

  ws.on("close", () => stream.kill("SIGTERM"));
  ws.on("error", () => stream.kill("SIGTERM"));
}

function safeReject(socket: net.Socket, status: number, reason: string): void {
  try {
    const body = JSON.stringify({ error: reason });
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\n` +
      `Content-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      `Connection: close\r\n\r\n` +
      body,
    );
  } catch { /* ignore */ }
  try { socket.destroy(); } catch { /* ignore */ }
}
