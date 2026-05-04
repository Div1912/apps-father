import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
import Database from "better-sqlite3";
import { verifyInitData } from "../middleware/initdata";
import { projectService } from "../../services/project.service";
import { decryptToken } from "../../services/crypto.service";
import { runWithProject } from "../../services/console-tagger.service";

const router = Router();
const PROJECTS_DIR = path.join(process.cwd(), "projects");

// ── Per-project module cache ──────────────────────────────────────────────────
// Keyed by projectId. Invalidated automatically when routes.js mtime changes
// (i.e. after every deploy_to_dev).  Keeping the module alive means module-level
// variables (caches, counters, setIntervals …) persist between requests exactly
// as the developer expects.

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
}

async function loadProjectEntry(
  projectId: string,
  projectDir: string,
  backendDir: string,
  routesFile: string,
): Promise<ProjectEntry> {
  const mtime = fs.statSync(routesFile).mtimeMs;
  const existing = projectCache.get(projectId);

  if (existing && existing.mtime === mtime) {
    return existing;
  }

  // File changed (new deploy) or first load — evict stale entry.
  if (existing) {
    evictProject(projectId);
    // Clear Node require cache so the new file is actually read from disk.
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(backendDir) && !key.includes("node_modules")) {
        delete require.cache[key];
      }
    }
  }

  const routeFactory = require(routesFile);

  const project = await projectService.getProject(projectId);
  let botToken = "";
  let botUsername = "";
  if (project?.botTokenEncrypted) botToken = decryptToken(project.botTokenEncrypted);
  if (project?.botUsername) botUsername = project.botUsername;

  const devDir = path.join(projectDir, "development");
  const db = createProjectDb(devDir, botToken, botUsername, projectId);

  const envPath = path.join(backendDir, ".env");
  const envVars = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};

  const entry: ProjectEntry = { mtime, routeFactory, db, envVars };
  projectCache.set(projectId, entry);
  return entry;
}

// ── Request handler ───────────────────────────────────────────────────────────

router.use("/:projectId/{*routePath}", verifyInitData as any);

router.all("/:projectId/{*routePath}", async (req: Request, res: Response) => {
  const projectId = String(req.params.projectId);
  const rawRoute = req.params.routePath;
  const routePath = Array.isArray(rawRoute) ? rawRoute.join("/") : String(rawRoute || "");

  const projectDir = path.join(PROJECTS_DIR, projectId);
  const backendDir = path.join(projectDir, "development", "backend");
  const routesFile = path.join(backendDir, "routes.js");

  if (!fs.existsSync(routesFile)) {
    res.status(404).json({ error: "No backend routes configured for this project" });
    return;
  }

  await runWithProject(projectId, async () => {
    try {
      const entry = await loadProjectEntry(projectId, projectDir, backendDir, routesFile);

      // Expose deploy timestamp so the agent / devtools can confirm which
      // version is running (mtime = milliseconds since epoch of the deployed file).
      res.setHeader("X-App-Deploy-Time", entry.mtime.toString());

      const projectRouter = Router();

      if (typeof entry.routeFactory === "function") {
        try {
          entry.routeFactory(projectRouter, entry.db, projectId, entry.envVars);
        } catch (regErr) {
          console.error(`[DevAPI] Route registration error for ${projectId}:`, regErr);
        }
      }

      // Preserve the original query string — req.params strips it, but
      // Express re-parses req.query from req.url when the sub-router runs,
      // so we must keep the "?" portion or req.query will be empty.
      const qsIdx = req.originalUrl.indexOf("?");
      const qs = qsIdx !== -1 ? req.originalUrl.slice(qsIdx) : "";
      req.url = "/" + routePath + qs;
      projectRouter(req, res, () => {
        res.status(404).json({ error: "Endpoint not found" });
      });
    } catch (err) {
      console.error(`[DevAPI] Error loading routes for ${projectId}:`, err);
      // Evict on error so the next request gets a clean retry.
      evictProject(projectId);
      res.status(500).json({ error: "Internal server error" });
    }
  });
});

// ── Cache eviction endpoint (called by deploy_to_dev / ws-manager) ────────────
// Exported so other parts of the server can force-evict a project's module
// cache immediately after syncing new files to development/.
export function evictDevApiCache(projectId: string): void {
  evictProject(projectId);
}

export default router;
