import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import { verifyInitData } from "../middleware/initdata";
import { projectService } from "../../services/project.service";
import { decryptToken } from "../../services/crypto.service";
import { runWithProject } from "../../services/console-tagger.service";
import { config } from "../../config";

const router = Router();
const PROJECTS_DIR = path.join(process.cwd(), "projects");

// ── Per-project module cache ──────────────────────────────────────────────────
// Keyed by projectId. Invalidated automatically when routes.js mtime changes
// (i.e. after every deploy / finish). Keeping the module alive means module-level
// variables (caches, counters, setIntervals …) persist between requests exactly
// as the developer expects — no spurious "DB connection not open" errors from
// closed connections being re-used by live timers.

interface ProjectEntry {
  mtime: number;
  routeFactory: Function;
  db: ReturnType<typeof createProjectDb>;
  envVars: Record<string, string>;
}

const projectCache = new Map<string, ProjectEntry>();

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

function evictProject(projectId: string): void {
  const entry = projectCache.get(projectId);
  if (entry) {
    try { entry.db.close(); } catch {}
    projectCache.delete(projectId);
  }
  // Always purge require.cache so the next require() reads the new file from
  // disk — must run even when projectCache had no entry (e.g. invalidateProjectDbCache
  // was called before any request ever hit this project).
  const backendDir = path.join(PROJECTS_DIR, projectId, "release", "backend");
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(backendDir) && !key.includes("node_modules")) {
      delete require.cache[key];
    }
  }
}

async function loadProjectEntry(
  projectId: string,
  projectDir: string,
  backendDir: string,
  routesFile: string,
): Promise<ProjectEntry> {
  const mtime = fs.statSync(routesFile).mtimeMs;
  const existing = projectCache.get(projectId);

  // Return cached entry if the file hasn't changed.
  if (existing && existing.mtime === mtime) {
    return existing;
  }

  // File changed (new release deployed) or first load — evict stale entry.
  // evictProject also purges require.cache for this project's backendDir.
  if (existing) {
    evictProject(projectId);
  }

  const routeFactory = require(routesFile);

  const project = await projectService.getProject(projectId);
  let botToken = "";
  let botUsername = "";
  if (project?.botTokenEncrypted) botToken = decryptToken(project.botTokenEncrypted);
  if (project?.botUsername) botUsername = project.botUsername;

  const releaseDir = path.join(projectDir, "release");
  const db = createProjectDb(releaseDir, botToken, botUsername, projectId);

  const envPath = path.join(backendDir, ".env");
  const envVars = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};

  // Inject platform vars so routes.js can use the AF Bucket API
  envVars.AF_INTERNAL_SECRET = process.env.AF_INTERNAL_SECRET || "";
  envVars.BASE_URL = config.baseUrl;
  envVars.PROJECT_ID = projectId;
  // INTERNAL_BASE_URL bypasses nginx/Cloudflare — use this for server-side bucket calls
  envVars.INTERNAL_BASE_URL = `http://localhost:${config.port}`;

  const entry: ProjectEntry = { mtime, routeFactory, db, envVars };
  projectCache.set(projectId, entry);
  console.log(`[API] Loaded routes.js for project ${projectId.substring(0, 8)} (mtime=${mtime})`);
  return entry;
}

// ── Request handler ───────────────────────────────────────────────────────────

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

  await runWithProject(projectId, async () => {
    try {
      const entry = await loadProjectEntry(projectId, projectDir, backendDir, routesFile);
      const { routeFactory, db, envVars } = entry;

      const projectRouter = Router();

      if (typeof routeFactory === "function") {
        try {
          routeFactory(projectRouter, db, projectId, envVars);
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
});

/** Evict a project's cached module+DB so the next request picks up the new routes.js. */
export function invalidateProjectDbCache(projectId: string): void {
  evictProject(projectId);
  console.log(`[API] Evicted cache for project ${projectId.substring(0, 8)}`);
}

export default router;
