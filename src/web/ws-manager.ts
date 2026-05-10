import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import { projectService } from "../services/project.service";
import { decryptToken } from "../services/crypto.service";
import { runWithProject } from "../services/console-tagger.service";
import { config } from "../config";

const PROJECTS_DIR = path.join(process.cwd(), "projects");

export interface ProjectWss {
  clients: Set<WebSocket>;
  broadcast(data: any): void;
  broadcastExcept(sender: WebSocket, data: any): void;
  onConnection(handler: (socket: WebSocket, req: IncomingMessage) => void): void;
}

interface ProjectWsState {
  clients: Set<WebSocket>;
  connectionHandler: ((socket: WebSocket, req: IncomingMessage) => void) | null;
  db: ReturnType<typeof createProjectDb> | null;
  timers: Set<ReturnType<typeof setInterval>>;
}

const projectStates = new Map<string, ProjectWsState>();
const projectInitPromises = new Map<string, Promise<ProjectWsState | null>>();

function createProjectDb(projectDir: string, botToken: string, botUsername: string, projectId: string) {
  const dataDir = path.join(projectDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const sqlite = new Database(path.join(dataDir, "app.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)");

  let closed = false;

  return {
    get open() { return !closed; },
    get(key: string) {
      if (closed) return null;
      const row = sqlite.prepare("SELECT value FROM kv WHERE key = ?").get(key) as any;
      return row ? JSON.parse(row.value) : null;
    },
    set(key: string, value: any) {
      if (closed) return;
      sqlite.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
    },
    getAll() {
      if (closed) return {};
      const rows = sqlite.prepare("SELECT key, value FROM kv").all() as any[];
      const result: Record<string, any> = {};
      for (const row of rows) result[row.key] = JSON.parse(row.value);
      return result;
    },
    delete(key: string) {
      if (closed) return;
      sqlite.prepare("DELETE FROM kv WHERE key = ?").run(key);
    },
    keys() {
      if (closed) return [];
      return (sqlite.prepare("SELECT key FROM kv").all() as any[]).map((r: any) => r.key);
    },
    close() {
      if (closed) return;
      closed = true;
      sqlite.close();
    },
    botToken,
    botUsername,
    projectId,
  };
}

async function initProjectWs(projectId: string, isDev: boolean): Promise<ProjectWsState | null> {
  const projectDir = path.join(PROJECTS_DIR, projectId);
  const releaseBackend = path.join(projectDir, "release", "backend", "routes.js");
  const devBackend = path.join(projectDir, "development", "backend", "routes.js");
  const routesFile = isDev ? devBackend : releaseBackend;

  if (!fs.existsSync(routesFile)) return null;

  try {
    delete require.cache[require.resolve(routesFile)];
  } catch {}

  const routeModule = require(routesFile);
  if (typeof routeModule.ws !== "function") return null;

  const project = await projectService.getProject(projectId);
  let botToken = "";
  let botUsername = "";
  if (project?.botTokenEncrypted) {
    botToken = decryptToken(project.botTokenEncrypted);
  }
  if (project?.botUsername) {
    botUsername = project.botUsername;
  }

  const envDir = isDev ? path.join(projectDir, "development") : path.join(projectDir, "release");
  const db = createProjectDb(envDir, botToken, botUsername, projectId);

  const backendDir = isDev
    ? path.join(projectDir, "development", "backend")
    : path.join(projectDir, "release", "backend");
  const envFilePath = path.join(backendDir, ".env");
  const envVars = fs.existsSync(envFilePath)
    ? dotenv.parse(fs.readFileSync(envFilePath))
    : {};
  // Inject platform vars so routes.js can use the AF Bucket API
  envVars.AF_INTERNAL_SECRET = config.internalSecret;
  envVars.BASE_URL = config.baseUrl;
  envVars.PROJECT_ID = projectId;
  envVars.INTERNAL_BASE_URL = `http://localhost:${config.port}`;
  const state: ProjectWsState = {
    clients: new Set(),
    connectionHandler: null,
    db,
    timers: new Set(),
  };

  const wss: ProjectWss = {
    clients: state.clients,

    broadcast(data: any) {
      const msg = typeof data === "string" ? data : JSON.stringify(data);
      for (const client of state.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(msg);
        }
      }
    },

    broadcastExcept(sender: WebSocket, data: any) {
      const msg = typeof data === "string" ? data : JSON.stringify(data);
      for (const client of state.clients) {
        if (client !== sender && client.readyState === WebSocket.OPEN) {
          client.send(msg);
        }
      }
    },

    onConnection(handler: (socket: WebSocket, req: IncomingMessage) => void) {
      state.connectionHandler = handler;
    },
  };

  const origSetInterval = global.setInterval;
  const origSetTimeout = global.setTimeout;
  const trackedTimers = state.timers;

  (global as any).setInterval = function (...args: any[]) {
    const id = origSetInterval.apply(global, args as any);
    trackedTimers.add(id);
    return id;
  };
  (global as any).setTimeout = function (...args: any[]) {
    const id = origSetTimeout.apply(global, args as any);
    trackedTimers.add(id);
    return id;
  };

  try {
    // Run inside the project's tagging context so any timers/listeners
    // registered by routeModule.ws() inherit the AsyncLocalStorage and their
    // console output is tagged automatically.
    runWithProject(projectId, () => {
      routeModule.ws(wss, db, projectId, envVars);
    });
  } finally {
    global.setInterval = origSetInterval;
    global.setTimeout = origSetTimeout;
  }

  console.log(`[WS] Project ${projectId.substring(0, 8)} ws() initialized, tracking ${trackedTimers.size} timer(s)`);
  return state;
}

function cleanupProject(stateKey: string) {
  const state = projectStates.get(stateKey);
  if (!state) return;

  for (const timer of state.timers) {
    clearInterval(timer);
    clearTimeout(timer);
  }
  if (state.timers.size > 0) {
    console.log(`[WS] Cleared ${state.timers.size} timer(s) for ${stateKey.substring(0, 12)}`);
  }
  state.timers.clear();

  if (state.db) {
    try { state.db.close(); } catch {}
    state.db = null;
  }
  state.connectionHandler = null;
  projectStates.delete(stateKey);
  projectInitPromises.delete(stateKey);
}

/**
 * Force-reload a project's WebSocket handler.
 * Closes all connected clients (they will auto-reconnect), clears timers,
 * closes the DB, and removes the cached state so the next connection
 * re-initializes from the latest routes.js on disk.
 */
export function forceReloadProjectWs(projectId: string, isDev: boolean): void {
  const stateKey = (isDev ? "dev:" : "rel:") + projectId;
  const state = projectStates.get(stateKey);

  if (!state) return; // nothing running — no-op

  const clientCount = state.clients.size;

  // Tell clients to reconnect (graceful close with code 1012 = Service Restart)
  for (const client of state.clients) {
    try {
      client.close(1012, "Server reload");
    } catch {}
  }
  state.clients.clear();

  cleanupProject(stateKey);
  console.log(`[WS] Force-reloaded ${isDev ? "dev" : "release"} WS for project ${projectId.substring(0, 8)} (${clientCount} client(s) disconnected)`);
}

export function setupWebSocket(server: import("http").Server, miniAppWss?: import("ws").WebSocketServer) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (request: IncomingMessage, socket, head) => {
    const url = request.url || "";

    if (url.startsWith("/telegram-mini-app/ws") && miniAppWss) {
      miniAppWss.handleUpgrade(request, socket, head, (ws) => {
        miniAppWss.emit("connection", ws, request);
      });
      return;
    }

    const devMatch = url.match(/^\/devws\/([a-f0-9-]+)/);
    const releaseMatch = url.match(/^\/ws\/([a-f0-9-]+)/);
    const match = devMatch || releaseMatch;
    const isDev = !!devMatch;

    if (!match) {
      socket.destroy();
      return;
    }

    const projectId = match[1];
    const stateKey = (isDev ? "dev:" : "rel:") + projectId;

    try {
      let state = projectStates.get(stateKey);

      if (!state) {
        // Deduplicate concurrent init calls — only one initProjectWs per stateKey at a time
        let initPromise = projectInitPromises.get(stateKey);
        if (!initPromise) {
          initPromise = initProjectWs(projectId, isDev).finally(() => {
            projectInitPromises.delete(stateKey);
          });
          projectInitPromises.set(stateKey, initPromise);
        }
        const newState = await initPromise;
        if (!newState) {
          console.error(`[WS] No ws handler in routes.js for project ${projectId.substring(0, 8)}`);
          socket.destroy();
          return;
        }
        // Another concurrent connection may have already stored the state
        state = projectStates.get(stateKey) || newState;
        if (!projectStates.has(stateKey)) {
          projectStates.set(stateKey, state);
          console.log(`[WS] Initialized ${isDev ? "dev" : "release"} WS for project ${projectId.substring(0, 8)}`);
        }
      }

      const finalState = state;
      wss.handleUpgrade(request, socket, head, (ws) => {
        finalState.clients.add(ws);

        ws.on("close", () => {
          finalState.clients.delete(ws);
          if (finalState.clients.size === 0) {
            console.log(`[WS] All clients disconnected from ${stateKey.substring(0, 12)}, cleaning up`);
            cleanupProject(stateKey);
          }
        });

        if (finalState.connectionHandler) {
          try {
            // Run the user's onConnection callback inside the project's tagging
            // context so any ws.on(...) listeners it registers inherit the
            // AsyncLocalStorage and emit logs tagged with [app:<projectId>].
            runWithProject(projectId, () => {
              finalState.connectionHandler!(ws, request);
            });
          } catch (err) {
            console.error(`[WS] onConnection error for ${projectId.substring(0, 8)}:`, err);
          }
        }
      });
    } catch (err) {
      console.error(`[WS] Upgrade error for ${projectId.substring(0, 8)}:`, err);
      socket.destroy();
    }
  });

  console.log("[WS] WebSocket manager ready (paths: /ws/{projectId}, /devws/{projectId})");
  return wss;
}
