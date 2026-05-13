/* eslint-disable */
/**
 * Per-project worker entry point.
 *
 * Spawned by the main apps-father process via `child_process.spawn` once per
 * project, dropped to a per-project Linux user (afp_<10hex(projectId)>) and
 * `cwd = /srv/apps-father/projects/<id>/`.
 *
 * Protocol with the supervisor (main process):
 *   - Listens on 127.0.0.1:PORT only.
 *   - Internal endpoints gated by X-Runner-Secret:
 *       GET  /__worker/health      → health body (always 200 if listener up)
 *       POST /__worker/shutdown    → graceful drain + process.exit(0)
 *       POST /__worker/reload      → clean exit(0); supervisor respawns
 *       POST /__worker/bot-update  → forward Telegram webhook update into release runtime
 *   - User-facing endpoints (no secret required, OS-isolated already):
 *       /release/api/...  → release runtime router
 *       /dev/api/...      → development runtime router
 *       /release/ws       → release ws upgrade
 *       /dev/ws           → development ws upgrade
 *       /bucket/:id/...   → backward-compat bucket proxy (adds AF_INTERNAL_SECRET)
 *
 * Security model:
 *   - process.env.RUNNER_SECRET / AF_INTERNAL_SECRET / BOT_TOKEN are captured
 *     into private locals at startup, then deleted from process.env BEFORE any
 *     `require(routesFile)` runs. process.env is then frozen.
 *   - User code (routes.js) receives `env` as the 4th arg containing only
 *     BASE_URL, PROJECT_ID, INTERNAL_BASE_URL plus the project's own .env file.
 *     BOT_TOKEN reaches user code only via `db.botToken` for the release runtime.
 */

"use strict";

const http = require("http");
const path = require("path");
const fs = require("fs");
const url = require("url");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer } = require("ws");

// ── 1. Capture env into private locals & scrub ───────────────────────────────
const NODE_ENV               = process.env.NODE_ENV || "production";
const PROJECT_ID             = process.env.PROJECT_ID || "";
const PROJECT_ROOT           = process.env.PROJECT_ROOT || process.cwd();
const RELEASE_BACKEND_DIR    = process.env.RELEASE_BACKEND_DIR    || path.join(PROJECT_ROOT, "release", "backend");
const RELEASE_DATA_DIR       = process.env.RELEASE_DATA_DIR       || path.join(PROJECT_ROOT, "release", "data");
const RELEASE_DB_PATH        = process.env.RELEASE_DB_PATH        || path.join(RELEASE_DATA_DIR, "db.sqlite");
const DEVELOPMENT_BACKEND_DIR= process.env.DEVELOPMENT_BACKEND_DIR|| path.join(PROJECT_ROOT, "development", "backend");
const DEVELOPMENT_DATA_DIR   = process.env.DEVELOPMENT_DATA_DIR   || path.join(PROJECT_ROOT, "development", "data");
const DEVELOPMENT_DB_PATH    = process.env.DEVELOPMENT_DB_PATH    || path.join(DEVELOPMENT_DATA_DIR, "db.sqlite");
const PORT                   = parseInt(process.env.PORT || "0", 10);
const BASE_URL               = process.env.BASE_URL || "";
const RUNNER_SECRET          = process.env.RUNNER_SECRET || "";
const AF_INTERNAL_SECRET     = process.env.AF_INTERNAL_SECRET || "";
const BOT_TOKEN              = process.env.BOT_TOKEN || "";
const BOT_USERNAME           = process.env.BOT_USERNAME || "";

if (!PROJECT_ID || !PORT || !RUNNER_SECRET) {
  console.error("[worker] Missing required env (PROJECT_ID, PORT, RUNNER_SECRET).");
  process.exit(2);
}

// ── 2. Scrub secrets from process.env BEFORE loading user code ───────────────
for (const k of ["RUNNER_SECRET", "AF_INTERNAL_SECRET", "BOT_TOKEN"]) {
  delete process.env[k];
}
// Best-effort freeze; some user code may try to overwrite process.env in tests.
// If freeze() fails (some Node builds), it's no big deal — keys are already deleted.
try { Object.freeze(process.env); } catch {}

// One-shot rename fallback: legacy in-process mode used "app.db", worker uses
// "db.sqlite". Migration script handles this for known projects, but newly
// migrated projects that slipped through get a runtime fix here.
function maybeRenameLegacyDb(dataDir) {
  const legacy = path.join(dataDir, "app.db");
  const current = path.join(dataDir, "db.sqlite");
  try {
    if (fs.existsSync(legacy) && !fs.existsSync(current)) {
      fs.renameSync(legacy, current);
      console.log("[worker] Renamed legacy app.db → db.sqlite in " + dataDir);
    }
  } catch (err) {
    console.warn("[worker] db rename skipped:", err.message);
  }
}
fs.mkdirSync(RELEASE_DATA_DIR,    { recursive: true });
fs.mkdirSync(DEVELOPMENT_DATA_DIR,{ recursive: true });
maybeRenameLegacyDb(RELEASE_DATA_DIR);
maybeRenameLegacyDb(DEVELOPMENT_DATA_DIR);

// ── 3. Load runtime modules ──────────────────────────────────────────────────
const { loadRuntime } = require("./lib/loadRuntime");
const { createBotBridge } = require("./lib/bot-bridge");

const startedAt = Date.now();

// CPU% tracking — sampled on each /__worker/health call.
let _prevCpuUsage = process.cpuUsage();
let _prevCpuTime  = Date.now();
const INTERNAL_BASE_URL = `http://127.0.0.1:${PORT}`;

const releaseEnv = {
  BASE_URL,
  PROJECT_ID,
  INTERNAL_BASE_URL,
};
const developmentEnv = {
  BASE_URL,
  PROJECT_ID,
  INTERNAL_BASE_URL,
};

const release = loadRuntime({
  kind: "release",
  projectId: PROJECT_ID,
  backendDir: RELEASE_BACKEND_DIR,
  dbPath: RELEASE_DB_PATH,
  baseEnv: releaseEnv,
  botToken: BOT_TOKEN || null,
  botUsername: BOT_USERNAME || "",
  afInternalSecret: AF_INTERNAL_SECRET,
  baseUrl: BASE_URL,
});

const development = loadRuntime({
  kind: "development",
  projectId: PROJECT_ID,
  backendDir: DEVELOPMENT_BACKEND_DIR,
  dbPath: DEVELOPMENT_DB_PATH,
  baseEnv: developmentEnv,
  botToken: null,                 // dev runtime never gets a live bot token
  botUsername: BOT_USERNAME || "",
  afInternalSecret: AF_INTERNAL_SECRET,
  baseUrl: BASE_URL,
});

// Optional bot bridge: only release runtime gets a live bot dispatcher.
const botBridge = BOT_TOKEN
  ? createBotBridge({ token: BOT_TOKEN, projectId: PROJECT_ID, runtime: release })
  : null;

// ── 4. Express app: mount everything on a single 127.0.0.1 listener ──────────
const app = express();

// JSON body parser only for our internal endpoints; user routers manage their
// own body parsing as before.
app.use("/__worker", express.json({ limit: "10mb" }));

function timingSafeEq(a, b) {
  try {
    const ab = Buffer.from(String(a || ""));
    const bb = Buffer.from(String(b || ""));
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function requireRunnerSecret(req, res, next) {
  const got = req.headers["x-runner-secret"];
  if (!timingSafeEq(got, RUNNER_SECRET)) {
    return res.status(401).json({ error: "invalid_runner_secret" });
  }
  next();
}

// Worker internal endpoints
app.get("/__worker/health", requireRunnerSecret, (req, res) => {
  const mem    = process.memoryUsage();
  const cpuNow = process.cpuUsage();
  const now    = Date.now();

  const elapsedUs = (now - _prevCpuTime) * 1000; // ms → μs
  const cpuUs     = (cpuNow.user - _prevCpuUsage.user) + (cpuNow.system - _prevCpuUsage.system);
  const cpuPercent = elapsedUs > 0 ? Math.min(100, (cpuUs / elapsedUs) * 100) : 0;

  _prevCpuUsage = cpuNow;
  _prevCpuTime  = now;

  res.json({
    ok: true,
    uptimeMs: Date.now() - startedAt,
    release:     { loaded: release.loaded,     error: release.error || null },
    development: { loaded: development.loaded, error: development.error || null },
    mem: {
      rssBytes:       mem.rss,
      heapUsedBytes:  mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
    },
    cpuPercent: Math.round(cpuPercent * 10) / 10,
  });
});

app.post("/__worker/shutdown", requireRunnerSecret, (req, res) => {
  res.json({ ok: true });
  setImmediate(() => gracefulExit(0));
});

app.post("/__worker/reload", requireRunnerSecret, (req, res) => {
  // Same effect as shutdown — supervisor sees clean exit and respawns.
  res.json({ ok: true });
  setImmediate(() => gracefulExit(0));
});

app.post("/__worker/bot-update", requireRunnerSecret, async (req, res) => {
  if (!botBridge) {
    return res.status(503).json({ error: "no_bot_bridge", message: "release runtime has no bot token" });
  }
  try {
    await botBridge.handleUpdate(req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error("[worker] bot-update failed:", err);
    res.status(500).json({ error: "bot_dispatch_failed", message: err && err.message });
  }
});

// ── 5. Bucket proxy (backward compat for env.INTERNAL_BASE_URL fetches) ──────
// User routes calling fetch(env.INTERNAL_BASE_URL + '/bucket/<id>/upload') now
// hit this worker-local proxy. The proxy:
//   1. Validates the request projectId matches our PROJECT_ID.
//   2. Streams the body upstream to ${BASE_URL}/bucket/<id>/upload with the
//      captured AF_INTERNAL_SECRET as x-af-internal.
//   3. Pipes the upstream response back to the caller.
const { proxyBucket } = require("./lib/bucket-proxy");
app.all("/bucket/:projectId/*splat", (req, res) => proxyBucket(req, res, {
  ownProjectId: PROJECT_ID,
  baseUrl: BASE_URL,
  afInternalSecret: AF_INTERNAL_SECRET,
}));
// Express 5 wildcard syntax differs across versions; mount a fallback:
app.all("/bucket/*splat", (req, res) => proxyBucket(req, res, {
  ownProjectId: PROJECT_ID,
  baseUrl: BASE_URL,
  afInternalSecret: AF_INTERNAL_SECRET,
}));

// ── 6. User runtime mount points ─────────────────────────────────────────────

// Decode the X-Telegram-User header that runner-proxy.ts forwards after
// verifying initData HMAC against the project's bot token. This populates
// req.telegramUser so user routes can identify the caller identically to
// the in-process mode (where api.routes.ts / verifyInitData did the same).
app.use(["/release/api", "/dev/api"], (req, res, next) => {
  const raw = req.headers["x-telegram-user"];
  if (raw) {
    try {
      req.telegramUser = JSON.parse(Buffer.from(String(raw), "base64").toString("utf8"));
    } catch {
      // Malformed header — ignore, leave req.telegramUser undefined.
    }
  }
  next();
});

function mountRuntime(prefix, runtime) {
  app.use(prefix, (req, res, next) => {
    if (!runtime.loaded) {
      const err = runtime.error || "unloaded";
      const code = err === "no_routes" ? 404 : 503;
      return res.status(code).json({
        error: err === "no_routes" ? "no_routes_for_runtime" : "runtime_load_failed",
        runtime: runtime.kind,
        message: err,
      });
    }
    return runtime.router(req, res, next);
  });
}
mountRuntime("/release/api", release);
mountRuntime("/dev/api",     development);

// 404 fallback for everything else
app.use((req, res) => {
  res.status(404).json({ error: "not_found", path: req.url });
});

// ── 7. HTTP server + WS upgrade ──────────────────────────────────────────────
const server = http.createServer(app);

// Two ws servers, one per runtime, attached to the same HTTP server.
const wssRelease     = release.wssFactory     ? release.wssFactory(server)     : null;
const wssDevelopment = development.wssFactory ? development.wssFactory(server) : null;

server.on("upgrade", (req, socket, head) => {
  const { pathname } = url.parse(req.url || "");
  if (pathname === "/release/ws" && wssRelease) {
    wssRelease.handleUpgrade(req, socket, head, (ws) => wssRelease.emit("connection", ws, req));
  } else if (pathname === "/dev/ws" && wssDevelopment) {
    wssDevelopment.handleUpgrade(req, socket, head, (ws) => wssDevelopment.emit("connection", ws, req));
  } else {
    // Reject unknown WS paths or runtime not loaded
    socket.write("HTTP/1.1 1011 unsupported\r\n\r\n");
    socket.destroy();
  }
});

// ── 8. Lifecycle ─────────────────────────────────────────────────────────────
let exiting = false;
function gracefulExit(code) {
  if (exiting) return;
  exiting = true;
  // Stop accepting new connections; existing requests have a 30s drain window
  // (matches the supervisor's SIGTERM timeout in runner-manager.service.ts).
  try { server.close(); } catch {}
  try { release.close && release.close(); } catch {}
  try { development.close && development.close(); } catch {}
  setTimeout(() => process.exit(code), 30_000).unref();
  // Try to exit fast if no in-flight connections remain.
  setImmediate(() => process.exit(code));
}

process.on("SIGTERM", () => {
  console.log("[worker] SIGTERM received, draining…");
  gracefulExit(0);
});

process.on("SIGINT", () => {
  console.log("[worker] SIGINT received, draining…");
  gracefulExit(0);
});

process.on("uncaughtException", (err) => {
  console.error("[worker] uncaughtException:", err && err.stack || err);
  // Log and continue — user code crashing should not take the worker down
  // until it's persistent (the supervisor handles repeated crashes).
});

process.on("unhandledRejection", (reason) => {
  console.error("[worker] unhandledRejection:", reason);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[worker] project=${PROJECT_ID.slice(0, 8)} listening on 127.0.0.1:${PORT}` +
    ` release=${release.loaded} development=${development.loaded}`
  );
});

server.on("error", (err) => {
  console.error("[worker] server error:", err);
  process.exit(3);
});
