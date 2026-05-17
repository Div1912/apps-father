/* eslint-disable */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const dotenv = require("dotenv");
const express = require("express");
const { WebSocketServer } = require("ws");
const { createKvDb } = require("./sqlite-kv");
const { makeBucketHelper } = require("./bucket-helper");

/**
 * Loads one of the two runtimes (release or development) for a project.
 *
 * Returns:
 *   {
 *     kind, loaded, error,
 *     router,         // Express Router (always non-null; returns 503 if unloaded)
 *     wssFactory,     // function(httpServer) → WebSocketServer | null
 *     close,          // closes the sqlite db
 *   }
 *
 * Graceful failure modes:
 *   - routes.js missing       → loaded=false, error="no_routes"
 *   - require throws          → loaded=false, error=<message>
 *   - module.exports not fn   → loaded=false, error="not_a_function"
 *
 * The worker stays alive in all cases — the listener is up and /__worker/health
 * returns 200 with per-runtime status.
 */
function loadRuntime(opts) {
  const {
    kind,                  // "release" | "development"
    projectId,
    backendDir,
    dbPath,
    baseEnv,               // { BASE_URL, PROJECT_ID, INTERNAL_BASE_URL }
    botToken,              // string | null
    botUsername,           // string
    afInternalSecret,      // captured local; user code never sees this directly
    baseUrl,
  } = opts;

  const routesFile = path.join(backendDir, "routes.js");

  // Ensure the data directory exists before SQLite tries to open the file.
  // SQLite can create the .sqlite file but cannot mkdir the parent directory.
  try { fs.mkdirSync(path.dirname(dbPath), { recursive: true }); } catch {}

  // Always create the db wrapper — even broken routes.js can be reloaded with
  // a working db once the user fixes the file. Helper exposes `db.bucket.upload`
  // backed by the worker's local /bucket/:id/upload proxy.
  const dbHandle = createKvDb({
    dbPath,
    botToken: botToken || "",
    botUsername: botUsername || "",
    projectId,
  });

  // Attach the typed bucket helper. It posts to the worker's own listener,
  // which appends the captured AF_INTERNAL_SECRET when forwarding upstream.
  dbHandle.bucket = makeBucketHelper({
    internalBaseUrl: baseEnv.INTERNAL_BASE_URL,
    projectId,
  });

  // Read the project's own backend/.env (parsed) and inject our minimal
  // whitelist of platform vars. AF_INTERNAL_SECRET is intentionally NOT
  // included here — bucket access goes via the local proxy.
  const envFilePath = path.join(backendDir, ".env");
  let envVars = {};
  try {
    if (fs.existsSync(envFilePath)) {
      envVars = dotenv.parse(fs.readFileSync(envFilePath));
    }
  } catch (err) {
    console.warn(`[worker:${kind}] could not read backend/.env:`, err.message);
  }
  envVars.BASE_URL = baseEnv.BASE_URL;
  envVars.PROJECT_ID = baseEnv.PROJECT_ID;
  envVars.INTERNAL_BASE_URL = baseEnv.INTERNAL_BASE_URL;
  // Placeholder so legacy projects that check `if (env.AF_INTERNAL_SECRET)`
  // pass the guard. The real secret is never exposed — bucket uploads must go
  // through INTERNAL_BASE_URL which injects the real secret via the local proxy.
  envVars.AF_INTERNAL_SECRET = "<hidden>";

  // Default state — replaced once routes.js loads cleanly.
  let loaded = false;
  let error = null;
  let routeFactory = null;
  let wsFactory = null;

  if (!fs.existsSync(routesFile)) {
    error = "no_routes";
    return wrap();
  }

  // Load routes.js in an isolated VM context so each runtime (release /
  // development) gets its own `global` object. This prevents shared singletons
  // like `global._crashGame` from bleeding between runtimes.
  //
  // We seed the context with `{ ...global }` so every built-in (fetch,
  // setTimeout, Buffer, TextEncoder, crypto, …) is available without
  // enumerating them manually. Only `global` itself is replaced with a
  // fresh empty object to provide the isolation we need.
  let mod;
  try {
    const sandboxRequire = Module.createRequire(routesFile);
    const fakeModule = { exports: {} };
    const ctx = vm.createContext({
      ...global,
      global: Object.create(null),   // isolated per-runtime global
      require: sandboxRequire,
      module: fakeModule,
      exports: fakeModule.exports,
      __filename: routesFile,
      __dirname: path.dirname(routesFile),
    });
    const src = fs.readFileSync(routesFile, "utf8");
    // Wrap in a function so `return` works at top level (common pattern).
    vm.runInContext(
      `(function(module, exports, require, __filename, __dirname) {\n${src}\n})(module, module.exports, require, __filename, __dirname)`,
      ctx,
      { filename: routesFile }
    );
    mod = fakeModule.exports;
  } catch (err) {
    error = `require_failed: ${err && err.message}`;
    console.error(`[worker:${kind}] require(routes.js) failed:`, err && err.stack || err);
    return wrap();
  }

  if (typeof mod === "function") {
    routeFactory = mod;
    // routes.js may attach a .ws export directly onto the function:
    // module.exports = function(router,...){...}; module.exports.ws = function(wss,...){...}
    if (typeof mod.ws === "function") wsFactory = mod.ws;
  } else if (mod && typeof mod === "object") {
    // Modules that do `module.exports.default = function(...){}` or assign
    // both `default` and `ws`. Support both shapes.
    if (typeof mod.default === "function") routeFactory = mod.default;
    if (typeof mod.ws === "function") wsFactory = mod.ws;
    if (!routeFactory && !wsFactory) {
      error = "not_a_function";
      return wrap();
    }
  } else {
    error = "not_a_function";
    return wrap();
  }

  loaded = true;
  return wrap();

  function wrap() {
    // Lazily build the router on every request — keeps the contract identical
    // to the in-process path (api.routes.ts), where `routeFactory(...)` is
    // invoked per-request to register handlers fresh.
    //
    // The router is stable between requests (same handlers); we re-call the
    // factory only when the user's routes.js intentionally registers new
    // routes per request — extremely rare in practice — so we cache the
    // built router after first use to avoid the overhead.
    let cachedRouter = null;

    function buildRouter() {
      const r = express.Router();
      // Built-in body parsers — most user code expects req.body populated.
      r.use(express.json({ limit: "10mb" }));
      r.use(express.urlencoded({ extended: true, limit: "10mb" }));
      r.use((req, res, next) => {
        // Mirror the project tagging (single-line console prefix) by attaching
        // a project header so the main process can correlate logs.
        res.setHeader("X-Project-Id", projectId);
        next();
      });
      if (typeof routeFactory === "function") {
        try {
          routeFactory(r, dbHandle, projectId, envVars);
        } catch (err) {
          console.error(`[worker:${kind}] route registration error:`, err && err.stack || err);
          // Don't tip the runtime over — return a router that 500s for every
          // request until reload. Errors during route registration usually mean
          // a bad import path inside the user's helpers.
          loaded = false;
          error = `routeFactory_threw: ${err && err.message}`;
        }
      }
      return r;
    }

    // Public router — always defined; checks `loaded` on each request and
    // delegates to the cached user router.
    const publicRouter = (req, res, next) => {
      if (!loaded) {
        const code = error === "no_routes" ? 404 : 503;
        return res.status(code).json({
          error: error === "no_routes" ? "no_routes_for_runtime" : "runtime_load_failed",
          runtime: kind,
          message: error,
        });
      }
      if (!cachedRouter) cachedRouter = buildRouter();
      return cachedRouter(req, res, next);
    };

    // WebSocket factory: returns a WebSocketServer with `noServer:true` so the
    // outer worker-entry can route /release/ws and /dev/ws upgrades onto it.
    let wssFactory = null;
    if (typeof wsFactory === "function" && loaded) {
      wssFactory = function () {
        const wss = new WebSocketServer({ noServer: true });
        const clients = new Set();
        let connectionHandler = null;

        wss.on("connection", (socket, req) => {
          clients.add(socket);
          socket.on("close", () => clients.delete(socket));
          if (connectionHandler) {
            try {
              connectionHandler(socket, req);
            } catch (err) {
              console.error(`[worker:${kind}] ws connection handler error:`, err);
            }
          }
        });

        const wssApi = {
          clients,
          broadcast(data) {
            const msg = typeof data === "string" ? data : JSON.stringify(data);
            for (const client of clients) {
              if (client.readyState === 1 /* OPEN */) client.send(msg);
            }
          },
          broadcastExcept(sender, data) {
            const msg = typeof data === "string" ? data : JSON.stringify(data);
            for (const client of clients) {
              if (client !== sender && client.readyState === 1) client.send(msg);
            }
          },
          onConnection(handler) {
            connectionHandler = handler;
          },
        };

        try {
          wsFactory(wssApi, dbHandle, projectId, envVars);
        } catch (err) {
          console.error(`[worker:${kind}] ws() registration error:`, err && err.stack || err);
        }

        return wss;
      };
    }

    return {
      kind,
      get loaded() { return loaded; },
      get error()  { return error;  },
      router: publicRouter,
      wssFactory,
      close: () => {
        try { dbHandle.close(); } catch {}
      },
      /** Used by bot-bridge to dispatch a Telegram update through the cached router. */
      get cachedRouter() { return cachedRouter || (cachedRouter = buildRouter()); },
      get db() { return dbHandle; },
      get envVars() { return envVars; },
    };
  }
}

module.exports = { loadRuntime };
