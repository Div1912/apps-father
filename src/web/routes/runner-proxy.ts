import { Router, Request, Response, NextFunction } from "express";
import * as http from "http";
import * as net from "net";
import { config } from "../../config";
import { runnerManager } from "../../services/runner-manager.service";
import { verifyInitData } from "../middleware/initdata";

/**
 * Worker-mode HTTP + WebSocket proxy.
 *
 * Routes /app/:projectId/api/*, /dev/:projectId/api/* and the legacy aliases
 * /api/:projectId/* and /devapi/:projectId/* into the per-project worker.
 *
 * WebSocket upgrades for /app/:id/ws, /dev/:id/ws, /ws/:id, /devws/:id are
 * proxied via {@link proxyWebSocketUpgrade}, which is called from
 * server.on("upgrade", ...) before the existing in-process WS manager.
 *
 * On every inbound call we lazy-spawn the worker via
 * `runnerManager.ensureRunning(projectId)` — Phase 1 lifecycle.
 */

const HTTP_TIMEOUT_MS = 30 * 60_000; // long enough for slow user routes

export function createRunnerProxyRouter(): Router {
  const router = Router();

  // /app/:projectId/api/<rest>  → worker /release/api/<rest>
  router.all("/app/:projectId/api/*splat",     (req, res) => proxyHttp(req, res, "release"));
  router.all("/app/:projectId/api",            (req, res) => proxyHttp(req, res, "release"));
  // /dev/:projectId/api/<rest>  → worker /dev/api/<rest>
  router.all("/dev/:projectId/api/*splat",     (req, res) => proxyHttp(req, res, "development"));
  router.all("/dev/:projectId/api",            (req, res) => proxyHttp(req, res, "development"));

  // Legacy aliases (apps still calling /api/:id/... and /devapi/:id/...)
  router.all("/api/:projectId/*splat",         (req, res) => proxyHttp(req, res, "release"));
  router.all("/api/:projectId",                (req, res) => proxyHttp(req, res, "release"));
  router.all("/devapi/:projectId/*splat",      (req, res) => proxyHttp(req, res, "development"));
  router.all("/devapi/:projectId",             (req, res) => proxyHttp(req, res, "development"));

  return router;
}

/**
 * Forward an HTTP request into the worker. The path inside the worker is
 *   /release/api/<rest>  or  /dev/api/<rest>
 *
 * Body, headers (minus hop-by-hop) and query string are passthrough.
 */
async function proxyHttp(
  req: Request,
  res: Response,
  runtime: "release" | "development",
): Promise<void> {
  const projectId = String(req.params.projectId || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(projectId)) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  // Run the same initData auth that api.routes.ts middleware did in in-process
  // mode. This validates X-Telegram-Init-Data against the project's bot token
  // and sets req.telegramUser so user routes can identify the caller.
  // verifyInitData always calls next() — it never blocks — so we just await it.
  await new Promise<void>((resolve) => {
    (req as any).params = (req as any).params || {};
    (req as any).params.projectId = projectId;
    verifyInitData(req as any, res as any, resolve as NextFunction);
  });
  if (res.headersSent) return; // rare: verifyInitData sent a 400

  let workerPort: number;
  try {
    const handle = await runnerManager.ensureRunning(projectId);
    workerPort = handle.port;
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[runner-proxy] ensureRunning failed for ${projectId}:`, msg);
    res.status(503).json({ error: "worker_unavailable", message: msg });
    return;
  }

  // Recover the path tail after :projectId. Express 5's params handling for
  // wildcard is inconsistent across versions, so we slice originalUrl by hand.
  // Examples we need to handle:
  //   /app/<id>/api          → ""
  //   /app/<id>/api/foo/bar  → "foo/bar"
  //   /api/<id>              → ""
  //   /api/<id>/foo/bar?q=1  → "foo/bar?q=1"
  const tail = extractTailAfterProjectId(req.originalUrl, projectId);
  const targetPath =
    runtime === "release"
      ? `/release/api${tail ? "/" + tail : ""}`
      : `/dev/api${tail ? "/" + tail : ""}`;

  // Forward verified Telegram user info captured by the upstream auth
  // middleware, since the worker no longer has the bot token to verify.
  // This stays internal because the worker only listens on 127.0.0.1.
  const tgUser = (req as any).telegramUser;
  if (tgUser) {
    try {
      req.headers["x-telegram-user"] = Buffer.from(JSON.stringify(tgUser)).toString("base64");
    } catch {}
  }

  forwardHttp(req, res, workerPort, targetPath);
}

/** Slice path tail after the projectId param. Returns "" if at boundary. */
function extractTailAfterProjectId(originalUrl: string, projectId: string): string {
  // originalUrl is e.g. "/app/<id>/api/foo?a=1" or "/api/<id>/foo".
  const idIdx = originalUrl.indexOf(projectId);
  if (idIdx < 0) return "";
  let rest = originalUrl.slice(idIdx + projectId.length); // "/api/foo?a=1" or "/foo"
  // Strip the next /api or just leading slash for legacy paths.
  if (rest.startsWith("/api/")) rest = rest.slice(5);
  else if (rest.startsWith("/api")) rest = rest.slice(4);
  else if (rest.startsWith("/")) rest = rest.slice(1);
  return rest;
}

function forwardHttp(
  req: Request,
  res: Response,
  workerPort: number,
  targetPath: string,
): void {
  // Strip headers that don't make sense to forward.
  const fwdHeaders: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (lower === "host" || lower === "connection" || lower === "content-length") continue;
    if (v !== undefined) fwdHeaders[k] = v as any;
  }
  fwdHeaders.host = `127.0.0.1:${workerPort}`;
  fwdHeaders["x-forwarded-host"] = req.headers.host || "";
  fwdHeaders["x-forwarded-proto"] = req.protocol;
  fwdHeaders["x-forwarded-for"] = req.ip || req.socket.remoteAddress || "";

  const upstream = http.request(
    {
      host: "127.0.0.1",
      port: workerPort,
      path: targetPath,
      method: req.method,
      headers: fwdHeaders,
      timeout: HTTP_TIMEOUT_MS,
    },
    (upRes) => {
      res.status(upRes.statusCode || 502);
      for (const k of Object.keys(upRes.headers)) {
        try { res.setHeader(k, upRes.headers[k] as any); } catch {}
      }
      upRes.pipe(res);
    },
  );

  upstream.on("error", (err) => {
    console.error(`[runner-proxy] upstream error for ${targetPath}:`, err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: "worker_upstream_failed", message: err.message });
    } else {
      try { res.end(); } catch {}
    }
  });

  upstream.on("timeout", () => {
    upstream.destroy(new Error("worker request timeout"));
  });

  // If body was already buffered (json/urlencoded handlers ran upstream), we
  // need to send it as a fresh payload. Otherwise pipe the raw stream.
  const buffered = (req as any).body;
  if (buffered !== undefined && buffered !== null && Object.keys(buffered).length > 0) {
    let payload: Buffer;
    if (Buffer.isBuffer(buffered)) payload = buffered;
    else if (typeof buffered === "string") payload = Buffer.from(buffered);
    else payload = Buffer.from(JSON.stringify(buffered));
    upstream.setHeader("Content-Type", req.headers["content-type"] || "application/json");
    upstream.setHeader("Content-Length", String(payload.length));
    upstream.end(payload);
  } else if (req.readable) {
    req.pipe(upstream);
  } else {
    upstream.end();
  }
}

/**
 * Proxy a WebSocket upgrade into the worker. Mirrors the "/ws/<id>", 
 * "/devws/<id>", "/app/<id>/ws", and "/dev/<id>/ws" paths.
 *
 * Returns true if the URL matched (and was either proxied or rejected); false
 * if the URL belongs to another subsystem (mini-app, etc).
 */
export async function proxyWebSocketUpgrade(
  request: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
): Promise<boolean> {
  const reqUrl = request.url || "";
  const match = matchWsPath(reqUrl);
  if (!match) return false;

  const { projectId, runtime } = match;

  let workerPort: number;
  try {
    const handle = await runnerManager.ensureRunning(projectId);
    workerPort = handle.port;
  } catch (err) {
    console.error(`[runner-proxy] WS ensureRunning failed for ${projectId}:`, (err as Error).message);
    try {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    } catch {}
    socket.destroy();
    return true;
  }

  const targetPath = runtime === "release" ? "/release/ws" : "/dev/ws";

  const upstream = net.connect({ host: "127.0.0.1", port: workerPort });

  upstream.on("connect", () => {
    // Reconstruct the upgrade request to the worker. Strip Host, set new path.
    const headers = filterUpgradeHeaders(request.rawHeaders);
    let raw = `${request.method} ${targetPath} HTTP/1.1\r\nHost: 127.0.0.1:${workerPort}\r\n`;
    for (const [name, value] of headers) {
      if (name.toLowerCase() === "host") continue;
      raw += `${name}: ${value}\r\n`;
    }
    raw += "\r\n";
    upstream.write(raw);
    if (head && head.length > 0) upstream.write(head);

    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  const cleanup = () => {
    try { upstream.destroy(); } catch {}
    try { socket.destroy(); } catch {}
  };
  upstream.on("error", (err) => {
    console.error(`[runner-proxy] WS upstream error for ${projectId}:`, err.message);
    cleanup();
  });
  socket.on("error", () => cleanup());
  socket.on("close", () => { try { upstream.destroy(); } catch {} });

  return true;
}

function filterUpgradeHeaders(rawHeaders: string[]): [string, string][] {
  const out: [string, string][] = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    out.push([rawHeaders[i], rawHeaders[i + 1]]);
  }
  return out;
}

function matchWsPath(url: string): { projectId: string; runtime: "release" | "development" } | null {
  // Newer aliases:
  let m = /^\/app\/([a-f0-9-]+)\/ws(?:[/?].*)?$/.exec(url);
  if (m) return { projectId: m[1], runtime: "release" };
  m = /^\/dev\/([a-f0-9-]+)\/ws(?:[/?].*)?$/.exec(url);
  if (m) return { projectId: m[1], runtime: "development" };
  // Legacy paths:
  m = /^\/ws\/([a-f0-9-]+)(?:[/?].*)?$/.exec(url);
  if (m) return { projectId: m[1], runtime: "release" };
  m = /^\/devws\/([a-f0-9-]+)(?:[/?].*)?$/.exec(url);
  if (m) return { projectId: m[1], runtime: "development" };
  return null;
}

/**
 * Phase 1 helper used by server.ts: returns true when this request belongs to
 * a worker-handled path. The caller (in worker mode) should `next()` only the
 * matching prefix into createRunnerProxyRouter, and skip the in-process
 * api/devapi handlers entirely.
 */
export function isWorkerProxyPath(url: string): boolean {
  return /^\/(?:app|dev|api|devapi)\/[a-f0-9-]+/.test(url);
}
