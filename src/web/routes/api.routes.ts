import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import Database from "better-sqlite3";
import { verifyInitData } from "../middleware/initdata";
import { projectService } from "../../services/project.service";
import { decryptToken } from "../../services/crypto.service";

const router = Router();
const PROJECTS_DIR = path.join(process.cwd(), "projects");

// Persistent per-project DB connections — never closed between requests so that
// background setInterval/setTimeout loops (game schedulers, etc.) keep working.
const projectDbCache = new Map<string, ReturnType<typeof createProjectDb>>();

function createProjectDb(projectDir: string, botToken: string, botUsername: string, projectId: string) {
  const dataDir = path.join(projectDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const sqlite = new Database(path.join(dataDir, "app.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)");

  return {
    get(key: string) {
      const row = sqlite.prepare("SELECT value FROM kv WHERE key = ?").get(key) as any;
      return row ? JSON.parse(row.value) : null;
    },
    set(key: string, value: any) {
      sqlite.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
    },
    getAll() {
      const rows = sqlite.prepare("SELECT key, value FROM kv").all() as any[];
      const result: Record<string, any> = {};
      for (const row of rows) result[row.key] = JSON.parse(row.value);
      return result;
    },
    delete(key: string) {
      sqlite.prepare("DELETE FROM kv WHERE key = ?").run(key);
    },
    keys() {
      return (sqlite.prepare("SELECT key FROM kv").all() as any[]).map(r => r.key);
    },
    close() {
      sqlite.close();
    },
    botToken,
    botUsername,
    projectId,
  };
}

router.use("/:projectId/{*routePath}", verifyInitData as any);

router.all("/:projectId/{*routePath}", async (req: Request, res: Response) => {
  const projectId = String(req.params.projectId);
  const rawRoute = req.params.routePath;
  const routePath = Array.isArray(rawRoute) ? rawRoute.join("/") : String(rawRoute || "");

  const projectDir = path.join(PROJECTS_DIR, projectId);
  const backendDir = path.join(projectDir, "release", "backend");
  const routesFile = path.join(backendDir, "routes.js");

  if (!fs.existsSync(routesFile)) {
    res.status(404).json({ error: "No backend routes configured for this project" });
    return;
  }

  try {
    // Clear module cache so route code changes take effect on next request
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(backendDir) && !key.includes("node_modules")) delete require.cache[key];
    }

    const projectRouter = Router();
    const routeModule = require(routesFile);

    // Get or create a persistent DB connection for this project.
    // We intentionally do NOT close it per-request — background timers (game loops,
    // schedulers, etc.) inside routes.js hold a reference to the same db object and
    // would crash with "database connection is not open" if we closed it here.
    let db = projectDbCache.get(projectId);
    if (!db) {
      const project = await projectService.getProject(projectId);
      let botToken = "";
      let botUsername = "";
      if (project?.botTokenEncrypted) botToken = decryptToken(project.botTokenEncrypted);
      if (project?.botUsername) botUsername = project.botUsername;

      const releaseDir = path.join(projectDir, "release");
      db = createProjectDb(releaseDir, botToken, botUsername, projectId);
      projectDbCache.set(projectId, db);
      console.log(`[API] Opened persistent DB for project ${projectId.substring(0, 8)}`);
    }

    if (typeof routeModule === "function") {
      try {
        routeModule(projectRouter, db, projectId);
      } catch (regErr) {
        console.error(`[API] Route registration error for ${projectId}:`, regErr);
      }
    }

    const registeredRoutes: string[] = [];
    if (projectRouter.stack) {
      for (const layer of (projectRouter as any).stack) {
        if (layer.route) {
          const methods = Object.keys(layer.route.methods).join(",").toUpperCase();
          registeredRoutes.push(`${methods} ${layer.route.path}`);
        }
      }
    }

    // Preserve the original query string when rewriting the URL
    const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
    req.url = "/" + routePath + qs;
    projectRouter(req, res, () => {
      console.error(`[API] 404 for /${routePath} in project ${projectId.substring(0, 8)} | Registered: [${registeredRoutes.join(", ")}]`);
      res.status(404).json({ error: "Endpoint not found" });
    });
  } catch (err) {
    console.error(`[API] Error loading routes for ${projectId}:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

/** Evict a project's cached DB connection so the next request opens a fresh one. */
export function invalidateProjectDbCache(projectId: string): void {
  const db = projectDbCache.get(projectId);
  if (db) {
    try { (db as any).close?.(); } catch {}
    projectDbCache.delete(projectId);
    console.log(`[API] Evicted DB cache for project ${projectId.substring(0, 8)}`);
  }
}

export default router;
