import { Router, Request, Response, NextFunction } from "express";
import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { prisma } from "../../db";
import { config } from "../../config";
import { runtimeConfig } from "../../services/runtime-config.service";
import { Decimal } from "@prisma/client/runtime/library";
import { sendTon } from "../../services/wallet.service";
import {
  listUsers,
  getUserDetail,
  setUserBalance,
  setUserCredits,
  updateUserPartner,
  patchUser,
  setUserTags,
  listUserNotes,
  addUserNote,
  deleteUserNote,
  wipeUserData,
  fullResetUser,
  listProjects,
  getProjectDetail,
  patchProject,
  getSourcesStats,
  listSourceUsers,
  getTimeseries,
  getOperationBreakdown,
} from "../../services/admin-queries.service";
import { commitService } from "../../services/commit.service";
import { chatService } from "../../services/chat.service";
import { getOutLog, getErrLog, readTailLines } from "./logs.routes";
import { decryptToken } from "../../services/crypto.service";
import { PAID_FEATURES } from "../../services/features.service";
import { exec } from "child_process";
import { runnerManager } from "../../services/runner-manager.service";

const router = Router();
const PROJECTS_DIR = path.join(process.cwd(), "projects");
// Project root (resolves correctly whether running from src/ via ts-node or
// from compiled dist/web/routes — both end up two `..` away from project root).
const ADMIN_DIR = path.join(__dirname, "..", "..", "..", "admin");

const activeTokens = new Set<string>();

function generateToken(): string {
  const token = crypto.randomBytes(32).toString("hex");
  activeTokens.add(token);
  return token;
}

/**
 * Validate an admin bearer token. Used by non-Express call sites that can't
 * route through {@link authMiddleware} — primarily the WebSocket console
 * upgrade path in `console-ws.ts`, where the browser supplies the token as
 * `?token=…` because the WebSocket constructor cannot set custom headers.
 *
 * Tokens live in-memory only (stored at `/admin/api/login` time), so this
 * is a constant-time membership check on a `Set<string>`.
 */
export function isValidAdminToken(token: string | undefined | null): boolean {
  if (!token || typeof token !== "string") return false;
  return activeTokens.has(token);
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  // Accept the token from either an Authorization header (preferred — used by
  // the SPA's fetch calls) or a `?token=` query string (needed for plain
  // anchor downloads such as /admin/api/projects/:id/download.zip).
  const headerToken = req.headers.authorization?.replace("Bearer ", "");
  const queryToken  = typeof req.query.token === "string" ? req.query.token : undefined;
  const token = headerToken || queryToken;
  if (!token || !activeTokens.has(token)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// --- Auth ---

router.post("/api/login", (req: Request, res: Response) => {
  const { password } = req.body;
  if (password !== config.adminPassword) {
    res.status(401).json({ error: "Invalid password" });
    return;
  }
  const token = generateToken();
  res.json({ token });
});

// All API routes below require auth
router.use("/api", authMiddleware);

// --- Server Uptime ---

router.get("/api/uptime", (_req: Request, res: Response) => {
  res.json({ uptimeSeconds: Math.floor(process.uptime()) });
});

// --- Dashboard Stats ---

router.get("/api/stats", async (req: Request, res: Response) => {
  try {
    const from = parseIsoQuery(req.query.from);
    const to   = parseIsoQuery(req.query.to);
    // Build a `createdAt` filter that we can reuse for everything below.
    const createdAtFilter: { gte?: Date; lte?: Date } = {};
    if (from) createdAtFilter.gte = from;
    if (to)   createdAtFilter.lte = to;
    const dateWhere = (from || to) ? { createdAt: createdAtFilter } : {};

    const [userCount, projectCount, totalSpent, totalTopups, paymentCount] = await Promise.all([
      prisma.user.count({ where: dateWhere }),
      prisma.project.count({ where: dateWhere }),
      prisma.usageLog.aggregate({ _sum: { costUsd: true }, where: dateWhere }),
      prisma.payment.aggregate({
        _sum: { amountUsd: true },
        where: { status: "confirmed", ...dateWhere },
      }),
      prisma.payment.count({ where: { status: "confirmed", ...dateWhere } }),
    ]);

    // Recent activity always shows the latest 20 — date range applies to KPIs
    // only, like a typical analytics dashboard.
    const recentUsage = await prisma.usageLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      where: (from || to) ? { createdAt: createdAtFilter } : undefined,
      include: { user: { select: { username: true, firstName: true } }, project: { select: { name: true } } },
    });

    res.json({
      from: from ? from.toISOString() : null,
      to:   to   ? to.toISOString()   : null,
      userCount,
      projectCount,
      totalSpent: Number(totalSpent._sum.costUsd || 0),
      totalTopups: Number(totalTopups._sum.amountUsd || 0),
      paymentCount,
      recentUsage: recentUsage.map(u => ({
        id: u.id,
        username: u.user.username || u.user.firstName || `User ${u.userId}`,
        project: u.project?.name || "-",
        operation: u.operation,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cost: Number(u.costUsd),
        createdAt: u.createdAt,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Users ---
// All user endpoints are backed by src/services/admin-queries.service.ts so
// the legacy Mini-App admin and the new browser CRM share identical logic.

router.get("/api/users", async (req: Request, res: Response) => {
  try {
    const result = await listUsers({
      q:        typeof req.query.q === "string" ? req.query.q : undefined,
      filter:   req.query.filter as any,
      sort:     req.query.sort   as any,
      page:     req.query.page     ? parseInt(String(req.query.page),     10) : undefined,
      pageSize: req.query.pageSize ? parseInt(String(req.query.pageSize), 10) : undefined,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/users/:id", async (req: Request<{id: string}>, res: Response) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const user = await getUserDetail(userId);
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    res.json(user);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/api/users/:id", async (req: Request<{id: string}>, res: Response) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const updated = await patchUser(userId, req.body || {});
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/api/users/:id/balance", async (req: Request<{id: string}>, res: Response) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const action = req.body?.action;
    const amount = parseFloat(req.body?.amount);
    if (action !== "set" && action !== "add") {
      res.status(400).json({ error: "action must be 'set' or 'add'" });
      return;
    }
    const result = await setUserBalance(userId, action, amount);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/api/users/:id/credits", async (req: Request<{id: string}>, res: Response) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const action = req.body?.action;
    const credits = parseFloat(req.body?.credits);
    if (action !== "set" && action !== "add") {
      res.status(400).json({ error: "action must be 'set' or 'add'" });
      return;
    }
    const result = await setUserCredits(userId, action, credits);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/api/users/:id/partner", async (req: Request<{id: string}>, res: Response) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const result = await updateUserPartner(userId, req.body || {});
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/api/users/:id/tags", async (req: Request<{id: string}>, res: Response) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const tags = Array.isArray(req.body?.tags) ? req.body.tags : [];
    const result = await setUserTags(userId, tags);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/api/users/:id/notes", async (req: Request<{id: string}>, res: Response) => {
  try {
    const userId = parseInt(req.params.id, 10);
    res.json({ notes: await listUserNotes(userId) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/users/:id/notes", async (req: Request<{id: string}>, res: Response) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const note = await addUserNote(userId, req.body?.body || "", req.body?.authorTag);
    res.json(note);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/api/users/:id/notes/:noteId", async (req: Request<{id: string, noteId: string}>, res: Response) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const noteId = parseInt(req.params.noteId, 10);
    await deleteUserNote(userId, noteId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/api/users/:id/data", async (req: Request<{id: string}>, res: Response) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const deleted = await wipeUserData(userId);
    console.log(`[Admin CRM] Wiped data for user ${userId}:`, deleted);
    res.json({ ok: true, deleted });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete("/api/users/:id/full", async (req: Request<{id: string}>, res: Response) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const deleted = await fullResetUser(userId);
    console.log(`[Admin CRM] Full reset for user ${userId}:`, deleted);
    res.json({ ok: true, deleted });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- Projects ---

router.get("/api/projects", async (req: Request, res: Response) => {
  try {
    const result = await listProjects({
      q:        typeof req.query.q === "string" ? req.query.q : undefined,
      filter:   req.query.filter as any,
      sort:     req.query.sort   as any,
      page:     req.query.page     ? parseInt(String(req.query.page),     10) : undefined,
      pageSize: req.query.pageSize ? parseInt(String(req.query.pageSize), 10) : undefined,
    });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/projects/:id", async (req: Request<{id: string}>, res: Response) => {
  try {
    const project = await getProjectDetail(req.params.id);
    if (!project) { res.status(404).json({ error: "Not found" }); return; }
    res.json(project);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.patch("/api/projects/:id", async (req: Request<{id: string}>, res: Response) => {
  try {
    const updated = await patchProject(req.params.id, req.body || {});
    res.json(updated);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// The PAID_FEATURES catalog (id, label, price, description) so the App
// detail page can render its Features sub-tab as a true checklist instead
// of the raw JSON blob that the Settings tab still exposes for power users.
router.get("/api/features-catalog", (_req: Request, res: Response) => {
  res.json({ features: PAID_FEATURES });
});

router.get("/api/projects/:id/files", (req: Request<{id: string}>, res: Response) => {
  const projectId = req.params.id;
  const devDir = path.join(PROJECTS_DIR, projectId, "development");
  if (!fs.existsSync(devDir)) { res.json({ files: [] }); return; }
  res.json({ files: walkDir(devDir, devDir) });
});

router.get("/api/projects/:id/file", (req: Request<{id: string}>, res: Response) => {
  const projectId = req.params.id;
  const filePath = String(req.query.path || "");
  if (!filePath || filePath.includes("..")) { res.status(400).json({ error: "Invalid path" }); return; }
  const devDir = path.join(PROJECTS_DIR, projectId, "development");
  const fullPath = path.join(devDir, filePath);
  if (!fullPath.startsWith(devDir)) { res.status(403).json({ error: "Forbidden" }); return; }
  if (!fs.existsSync(fullPath)) { res.status(404).json({ error: "Not found" }); return; }
  // Block obvious binaries; cap response to ~1MB.
  const stat = fs.statSync(fullPath);
  if (stat.size > 1_000_000) { res.status(413).json({ error: "File too large to view in browser (>1MB)" }); return; }
  const buf = fs.readFileSync(fullPath);
  // Heuristic: if NUL byte appears in first 4KB, treat as binary.
  if (buf.subarray(0, Math.min(4096, buf.length)).includes(0)) {
    res.json({ content: "[binary file omitted]", binary: true, size: stat.size });
    return;
  }
  res.json({ content: buf.toString("utf-8"), size: stat.size });
});

router.get("/api/projects/:id/reveal", (req: Request<{id: string}>, res: Response) => {
  const projectId = req.params.id;
  const projectDir = path.join(PROJECTS_DIR, projectId);
  const devDir = path.join(projectDir, "development");
  res.json({
    projectDir,
    developmentDir: fs.existsSync(devDir) ? devDir : null,
  });
});

router.post("/api/projects/:id/status", async (req: Request<{id: string}>, res: Response) => {
  try {
    const projectId = req.params.id;
    const { status } = req.body;
    await prisma.project.update({ where: { id: projectId }, data: { status } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Project chat (read-only history + admin system note) -------------------

router.get("/api/projects/:id/chat", (req: Request<{id: string}>, res: Response) => {
  try {
    const projectId = req.params.id;
    const before = req.query.before ? Number(req.query.before) : undefined;
    const limit  = req.query.limit  ? Number(req.query.limit)  : 100;
    const messages = chatService.getHistory(projectId, before, limit);
    res.json({ messages });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/projects/:id/chat/send", (req: Request<{id: string}>, res: Response) => {
  try {
    const projectId = req.params.id;
    const text = String(req.body?.text || "").trim();
    if (!text) { res.status(400).json({ error: "Empty message" }); return; }
    // Admin-side messages are appended as a system note so the project owner
    // sees them in their chat. Triggering a full agent run is out of scope
    // for the read-only CRM viewer.
    const msg = chatService.addMessage(projectId, {
      role: "system",
      type: "text",
      content: `[Admin] ${text}`,
    });
    res.json({ message: msg });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- Project commits / logs -------------------------------------------------

router.get("/api/projects/:id/logs", async (req: Request<{id: string}>, res: Response) => {
  try {
    const projectId = req.params.id;
    const versions = await commitService.getCommits(projectId);
    const commitsRoot = path.join(PROJECTS_DIR, projectId, "commits");
    const items = versions.map((v) => {
      const num = Number(v.version);
      let sizeBytes = 0;
      const logFile = path.join(commitsRoot, String(num), "agent.log");
      if (fs.existsSync(logFile)) {
        try { sizeBytes = fs.statSync(logFile).size; } catch {}
      }
      return {
        commit: num,
        version: v.version,
        changelog: v.changelog,
        createdAt: v.createdAt,
        sizeBytes,
        hasLog: sizeBytes > 0,
      };
    });
    res.json({ commits: items });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/projects/:id/logs/:commit", (req: Request<{id: string, commit: string}>, res: Response) => {
  try {
    const projectId = req.params.id;
    const commitNum = parseInt(req.params.commit, 10);
    if (!Number.isFinite(commitNum)) { res.status(400).json({ error: "Invalid commit" }); return; }
    const logPath = commitService.getLogPath(projectId, commitNum);
    if (!logPath) { res.status(404).json({ error: "No log for that commit" }); return; }
    const stat = fs.statSync(logPath);
    if (stat.size > 5_000_000) {
      // Tail the last 5MB if huge
      const fd = fs.openSync(logPath, "r");
      const buf = Buffer.alloc(5_000_000);
      fs.readSync(fd, buf, 0, 5_000_000, stat.size - 5_000_000);
      fs.closeSync(fd);
      res.json({
        truncated: true,
        size: stat.size,
        entries: parseLogText(buf.toString("utf-8")),
      });
      return;
    }
    const text = fs.readFileSync(logPath, "utf-8");
    res.json({ size: stat.size, entries: parseLogText(text) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

function parseLogText(text: string): any[] {
  const out: any[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      out.push({ raw: trimmed });
    }
  }
  return out;
}

// --- Sources / Funnel ---

function parseIsoQuery(raw: unknown): Date | null {
  if (typeof raw !== "string" || !raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

router.get("/api/stats/sources", async (req: Request, res: Response) => {
  try {
    const result = await getSourcesStats({
      from: parseIsoQuery(req.query.from),
      to:   parseIsoQuery(req.query.to),
      // Avatar resolution intentionally skipped here — the browser CRM
      // renders gradient initials for partners/referrers (cheap & offline).
    });
    res.json(result);
  } catch (err: any) {
    console.error("[Admin CRM] Sources stats error:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Persistent runtime logs (app_logs table) -------------------------------
//
// Backed by `prisma.appLog` (see schema.prisma). The console tee in
// console-tagger.service.ts pushes every stdout/stderr line into this table,
// indexed by (projectId, category, ts). These endpoints power the Admin
// Logs tab and the per-app "Logs" sub-tab on the App page.

interface AppLogQueryFilters {
  projectId?: string;
  category?: string;
  level?: string;
  source?: string;
  q?: string;
  from?: Date;
  to?: Date;
  // Cursor pagination — return rows STRICTLY OLDER than this (id descending).
  beforeId?: bigint;
  // Incremental poll — return rows STRICTLY NEWER than this (id ascending), then re-sort.
  afterId?: bigint;
  // Hard ceiling on result size; client may request smaller.
  limit: number;
}

function parseAppLogQuery(req: Request): AppLogQueryFilters {
  const q: AppLogQueryFilters = {
    limit: Math.max(10, Math.min(2000, parseInt(String(req.query.limit ?? "300"), 10) || 300)),
  };

  const projectId = typeof req.query.projectId === "string" ? req.query.projectId.trim() : "";
  if (projectId) {
    if (projectId === "__system__") q.projectId = "__system__"; // sentinel
    else q.projectId = projectId;
  }

  const cat = typeof req.query.category === "string" ? req.query.category.trim() : "";
  if (cat && cat !== "all") q.category = cat;

  const lvl = typeof req.query.level === "string" ? req.query.level.trim() : "";
  if (lvl && lvl !== "all") q.level = lvl;

  const src = typeof req.query.source === "string" ? req.query.source.trim() : "";
  if (src && src !== "all") q.source = src;

  const text = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (text) q.q = text.slice(0, 200);

  const from = typeof req.query.from === "string" ? req.query.from : "";
  if (from) {
    const d = new Date(from);
    if (!isNaN(d.getTime())) q.from = d;
  }
  const to = typeof req.query.to === "string" ? req.query.to : "";
  if (to) {
    const d = new Date(to);
    if (!isNaN(d.getTime())) q.to = d;
  }

  const beforeId = typeof req.query.beforeId === "string" ? req.query.beforeId : "";
  if (beforeId && /^\d+$/.test(beforeId)) {
    try { q.beforeId = BigInt(beforeId); } catch { /* ignore */ }
  }

  const afterId = typeof req.query.afterId === "string" ? req.query.afterId : "";
  if (afterId && /^\d+$/.test(afterId)) {
    try { q.afterId = BigInt(afterId); } catch { /* ignore */ }
  }

  return q;
}

function buildAppLogWhere(q: AppLogQueryFilters): any {
  const where: any = {};
  if (q.projectId === "__system__") where.projectId = null;
  else if (q.projectId)             where.projectId = q.projectId;

  if (q.category) where.category = q.category;
  if (q.level)    where.level    = q.level;
  if (q.source)   where.source   = q.source;
  if (q.q)        where.message  = { contains: q.q, mode: "insensitive" };

  if (q.from || q.to) {
    where.ts = {};
    if (q.from) where.ts.gte = q.from;
    if (q.to)   where.ts.lte = q.to;
  }
  if (q.beforeId) {
    where.id = { lt: q.beforeId };
  } else if (q.afterId) {
    where.id = { gt: q.afterId };
  }
  return where;
}

router.get("/api/applogs", async (req: Request, res: Response) => {
  try {
    const q = parseAppLogQuery(req);
    const where = buildAppLogWhere(q);
    // afterId polls only request rows newer than a cursor — order ascending so
    // we get the oldest-new rows first (they arrive oldest→newest naturally).
    const isIncremental = !!q.afterId;
    const rows = await prisma.appLog.findMany({
      where,
      orderBy: { id: isIncremental ? "asc" : "desc" },
      take: q.limit,
    });
    // For normal (desc) queries: reverse to get oldest→newest for the UI.
    // For incremental (asc) queries: already oldest→newest, no reverse needed.
    if (!isIncremental) rows.reverse();
    const nextCursor = rows.length > 0 ? rows[0].id.toString() : null;
    res.json({
      lines: rows.map(r => ({
        id: r.id.toString(),
        ts: r.ts,
        projectId: r.projectId,
        category: r.category,
        level: r.level,
        source: r.source,
        message: r.message,
      })),
      nextCursor,
      hasMore: rows.length === q.limit,
    });
  } catch (err: any) {
    console.error("[Admin CRM] AppLogs query error:", err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Distinct categories present in the table — used to populate the dropdown.
// Cached in-process for 30s so we don't hammer Postgres every refresh tick.
let categoriesCache: { ts: number; data: string[] } | null = null;
router.get("/api/applogs/categories", async (_req: Request, res: Response) => {
  try {
    if (categoriesCache && Date.now() - categoriesCache.ts < 30_000) {
      res.json({ categories: categoriesCache.data });
      return;
    }
    const rows = await prisma.appLog.findMany({
      select: { category: true },
      distinct: ["category"],
      orderBy: { category: "asc" },
      take: 200,
    });
    const data = rows.map(r => r.category).filter(Boolean);
    categoriesCache = { ts: Date.now(), data };
    res.json({ categories: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Per-project shorthand: same query as /applogs but pins projectId.
router.get("/api/projects/:id/applogs", async (req: Request, res: Response) => {
  try {
    (req.query as any).projectId = req.params.id;
    const q = parseAppLogQuery(req);
    const where = buildAppLogWhere(q);
    const rows = await prisma.appLog.findMany({
      where,
      orderBy: { id: "desc" },
      take: q.limit,
    });
    rows.reverse();
    const nextCursor = rows.length > 0 ? rows[0].id.toString() : null;
    res.json({
      lines: rows.map(r => ({
        id: r.id.toString(),
        ts: r.ts,
        projectId: r.projectId,
        category: r.category,
        level: r.level,
        source: r.source,
        message: r.message,
      })),
      nextCursor,
      hasMore: rows.length === q.limit,
    });
  } catch (err: any) {
    console.error("[Admin CRM] Project AppLogs query error:", err);
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// --- Recent process logs (legacy PM2 tail; kept for backward compatibility) -

router.get("/api/logs/recent", (req: Request, res: Response) => {
  try {
    const source  = String(req.query.source || "out");
    const lines   = Math.max(50, Math.min(5000, parseInt(String(req.query.lines || "500"), 10) || 500));

    let filePath = "";
    if      (source === "out") filePath = getOutLog();
    else if (source === "err") filePath = getErrLog();
    else { res.status(400).json({ error: "Unknown source: use out|err" }); return; }

    if (!filePath) {
      res.json({ source, file: null, lines: [] });
      return;
    }
    const text = readTailLines(filePath, lines);
    let size = 0;
    try { size = fs.statSync(filePath).size; } catch {}
    res.json({ source, file: filePath, size, lines: text });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// --- Avatar resolution (cached, talks to Telegram on miss) ------------------
//
// The Mini-App fetches avatars on the fly via the project's own bot token; the
// browser CRM uses these dedicated endpoints so we can:
//   • cache the URL for 30 minutes (avatars rotate rarely),
//   • cache misses too (so we don't hammer Telegram for users with no photo),
//   • use the master Apps-Father bot token as a fallback for plain Telegram
//     IDs that don't belong to any project bot.
const AVATAR_TTL_MS = 30 * 60 * 1000;
type AvatarCacheEntry = { url: string | null; ts: number };
const avatarCache: Map<string, AvatarCacheEntry> = new Map();

function getCachedAvatar(key: string): AvatarCacheEntry | null {
  const e = avatarCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > AVATAR_TTL_MS) { avatarCache.delete(key); return null; }
  return e;
}
function setCachedAvatar(key: string, url: string | null) {
  avatarCache.set(key, { url, ts: Date.now() });
}

async function fetchTelegramAvatarUrl(botToken: string, telegramUserId: string | number): Promise<string | null> {
  try {
    const photosRes = await fetch(`https://api.telegram.org/bot${botToken}/getUserProfilePhotos?user_id=${telegramUserId}&limit=1`);
    const photosData = await photosRes.json() as any;
    if (!photosData.ok || !photosData.result?.photos?.length) return null;
    const photo = photosData.result.photos[0];
    const biggest = photo[photo.length - 1];
    const fileId = biggest.file_id;
    const fileRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
    const fileData = await fileRes.json() as any;
    if (!fileData.ok || !fileData.result?.file_path) return null;
    return `https://api.telegram.org/file/bot${botToken}/${fileData.result.file_path}`;
  } catch {
    return null;
  }
}

router.get("/api/avatar/project/:id", async (req: Request<{id: string}>, res: Response) => {
  const projectId = req.params.id;
  const cacheKey = `project:${projectId}`;
  const cached = getCachedAvatar(cacheKey);
  if (cached) { res.json({ url: cached.url, cached: true }); return; }

  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { botUserId: true, botTokenEncrypted: true },
    });
    if (!project || !project.botTokenEncrypted || !project.botUserId) {
      setCachedAvatar(cacheKey, null);
      res.json({ url: null });
      return;
    }
    const token = decryptToken(project.botTokenEncrypted);
    const url = await fetchTelegramAvatarUrl(token, String(project.botUserId));
    setCachedAvatar(cacheKey, url);
    res.json({ url });
  } catch (err: any) {
    res.status(500).json({ url: null, error: err.message || String(err) });
  }
});

router.get("/api/avatar/user/:telegramId", async (req: Request<{telegramId: string}>, res: Response) => {
  const tgId = String(req.params.telegramId || "").trim();
  if (!tgId || !/^\d+$/.test(tgId)) { res.status(400).json({ error: "Invalid telegramId" }); return; }
  const cacheKey = `user:${tgId}`;
  const cached = getCachedAvatar(cacheKey);
  if (cached) { res.json({ url: cached.url, cached: true }); return; }

  try {
    if (!config.botToken) { res.json({ url: null }); return; }
    const url = await fetchTelegramAvatarUrl(config.botToken, tgId);
    setCachedAvatar(cacheKey, url);
    res.json({ url });
  } catch (err: any) {
    res.status(500).json({ url: null, error: err.message || String(err) });
  }
});

// --- Reveal in explorer (gated) ---------------------------------------------

router.post("/api/projects/:id/open-in-explorer", (req: Request<{id: string}>, res: Response) => {
  try {
    if (!runtimeConfig.get().allowAdminShell) {
      res.status(403).json({ error: "Admin shell is disabled. Enable allowAdminShell in Configuration." });
      return;
    }
    const projectId = req.params.id;
    const which = String(req.body?.dir || "project");
    const base  = which === "development"
      ? path.join(PROJECTS_DIR, projectId, "development")
      : path.join(PROJECTS_DIR, projectId);
    if (!fs.existsSync(base)) { res.status(404).json({ error: "Directory does not exist" }); return; }

    // Detect headless Linux (no DISPLAY) up front and bail with a useful
    // message — there's no way to open a GUI explorer on a remote PM2 server,
    // so the admin should download the folder as a zip instead.
    if (process.platform === "linux" && !process.env.DISPLAY) {
      res.status(409).json({
        error: "Server is headless (no DISPLAY). Use 'Download ZIP' to inspect files locally, or 'Copy path' if you're SSH'd into the server.",
        path: base,
        headless: true,
      });
      return;
    }

    const cmd = process.platform === "win32"
      ? `start "" "${base}"`
      : process.platform === "darwin"
        ? `open "${base}"`
        : `xdg-open "${base}"`;

    // Wait for the exec to finish so we can report the *real* outcome rather
    // than always claiming success. Cap the wait at 4s to keep the request
    // snappy.
    let answered = false;
    const timeout = setTimeout(() => {
      if (answered) return;
      answered = true;
      res.json({ ok: true, path: base, async: true });
    }, 4000);
    exec(cmd, { windowsHide: true, timeout: 5000 }, (err) => {
      if (answered) return;
      answered = true;
      clearTimeout(timeout);
      if (err) {
        console.error("[Admin CRM] open-in-explorer failed:", err.message);
        res.status(500).json({ error: `Open command failed: ${err.message}`, path: base });
        return;
      }
      res.json({ ok: true, path: base });
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Download the project's development folder as a streaming zip. Useful on
// headless Linux deployments where Open-in-Explorer can't pop a window.
router.get("/api/projects/:id/download.zip", async (req: Request<{id: string}>, res: Response) => {
  try {
    const projectId = req.params.id;
    const which = String(req.query.dir || "development");
    const base  = which === "development"
      ? path.join(PROJECTS_DIR, projectId, "development")
      : path.join(PROJECTS_DIR, projectId);
    if (!fs.existsSync(base)) { res.status(404).json({ error: "Directory does not exist" }); return; }

    let archiver: any;
    try { archiver = require("archiver"); }
    catch {
      res.status(500).json({ error: "archiver module not installed on server" });
      return;
    }

    const safeName = `${projectId.slice(0, 8)}-${which}.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName}"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("warning", (err: any) => console.warn("[Admin CRM] zip warning:", err?.message || err));
    archive.on("error",   (err: any) => { console.error("[Admin CRM] zip error:", err); try { res.end(); } catch {} });
    archive.pipe(res);
    archive.glob("**/*", { cwd: base, dot: true, ignore: ["node_modules/**", ".git/**"] });
    await archive.finalize();
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err?.message || String(err) });
  }
});

router.get("/api/timeseries", async (req: Request, res: Response) => {
  try {
    const metric = String(req.query.metric || "new_users") as any;
    const interval = String(req.query.interval || "day") as any;
    const result = await getTimeseries({
      metric,
      interval,
      from: parseIsoQuery(req.query.from),
      to:   parseIsoQuery(req.query.to),
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Cost & token breakdown grouped by `usage_logs.operation`. Backs the
// Dashboard's "Cost by operation" / "Tokens by operation" panels so admins
// can see at-a-glance which agent step is burning the most spend.
router.get("/api/stats/operations", async (req: Request, res: Response) => {
  try {
    const rows = await getOperationBreakdown({
      from: parseIsoQuery(req.query.from),
      to:   parseIsoQuery(req.query.to),
    });
    res.json({
      from: parseIsoQuery(req.query.from)?.toISOString() || null,
      to:   parseIsoQuery(req.query.to)?.toISOString()   || null,
      rows,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Tier stats and config ──

router.get("/api/stats/tiers", async (req: Request, res: Response) => {
  try {
    const from = parseIsoQuery(req.query.from);
    const to   = parseIsoQuery(req.query.to);

    const where: any = {};
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to)   where.createdAt.lte = to;
    }

    const rows = await prisma.usageLog.groupBy({
      by: ["operation"],
      where,
      _count: { id: true },
      _sum: { creditsCharged: true, costUsd: true },
    });

    const operationStats: Record<string, any> = {};
    for (const row of rows) {
      operationStats[row.operation] = {
        count: row._count.id,
        creditsCharged: row._sum.creditsCharged || 0,
        costUsd: Number(row._sum.costUsd || 0),
      };
    }

    // Session stats from new agent_sessions table
    const sessionRows = await prisma.agentSession.groupBy({
      by: ["type"],
      _count: { id: true },
      _sum: { creditsCharged: true, costUsd: true },
    });
    const sessionStats: Record<string, any> = {};
    for (const row of sessionRows) {
      sessionStats[row.type] = {
        count: row._count.id,
        creditsCharged: row._sum.creditsCharged || 0,
        costUsd: Number(row._sum.costUsd || 0),
      };
    }

    const creditSummary = await prisma.user.aggregate({ _sum: { credits: true } });
    const usageSum = await prisma.usageLog.aggregate({ where, _sum: { creditsCharged: true, costUsd: true } });

    res.json({
      operations: operationStats,
      sessions: sessionStats,
      totalCreditsOutstanding: creditSummary._sum.credits || 0,
      totalCreditsSpent: usageSum._sum.creditsCharged || 0,
      totalRealCostUsd: Number(usageSum._sum.costUsd || 0),
      from: from?.toISOString() || null,
      to: to?.toISOString() || null,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agent Sessions ────────────────────────────────────────────────────────────
// Returns usage_logs grouped by task_id so the admin can see per-run cost/revenue.
// Rows with task_id = NULL are skipped (non-agent operations like avatar_generation).
router.get("/api/sessions", async (req: Request, res: Response) => {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page  || "1"), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10)));
    const skip  = (page - 1) * limit;
    const projectIdFilter = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    const userIdFilter    = typeof req.query.userId    === "string" ? parseInt(req.query.userId, 10) : undefined;

    // Raw query: aggregate per task_id
    const whereClauses: string[] = ["ul.task_id IS NOT NULL"];
    if (projectIdFilter) whereClauses.push(`ul.project_id = '${projectIdFilter.replace(/'/g, "''")}'`);
    if (userIdFilter)    whereClauses.push(`ul.user_id = ${userIdFilter}`);
    const whereStr = whereClauses.join(" AND ");

    const rows: any[] = await prisma.$queryRawUnsafe(`
      SELECT
        ul.task_id          AS "taskId",
        ul.project_id       AS "projectId",
        ul.user_id          AS "userId",
        p.name              AS "projectName",
        MIN(ul.created_at)  AS "startedAt",
        SUM(ul.input_tokens)    AS "inputTokens",
        SUM(ul.output_tokens)   AS "outputTokens",
        SUM(ul.cost_usd)        AS "costUsd",
        SUM(ul.credits_charged) AS "creditsCharged",
        COUNT(*)                AS "callCount"
      FROM usage_logs ul
      LEFT JOIN projects p ON p.id = ul.project_id
      WHERE ${whereStr}
      GROUP BY ul.task_id, ul.project_id, ul.user_id, p.name
      ORDER BY MIN(ul.created_at) DESC
      LIMIT ${limit} OFFSET ${skip}
    `);

    const countResult: any[] = await prisma.$queryRawUnsafe(`
      SELECT COUNT(DISTINCT ul.task_id) AS total FROM usage_logs ul WHERE ${whereStr}
    `);
    const total = Number(countResult[0]?.total || 0);

    // Credits-to-dollar rate from runtime config (default 50 credits = $1).
    // Revenue in USD = credits / creditsPerDollar.
    const creditsPerDollar = runtimeConfig.getCreditsPerDollar() || 50;
    const sessions = rows.map((r: any) => {
      const costUsd      = Number(r.costUsd || 0);
      const credits      = Number(r.creditsCharged || 0);
      const revenueUsd   = credits / creditsPerDollar;
      const marginUsd    = revenueUsd - costUsd;
      return {
        taskId:       r.taskId,
        projectId:    r.projectId,
        projectName:  r.projectName || "Unknown",
        userId:       r.userId,
        startedAt:    r.startedAt,
        inputTokens:  Number(r.inputTokens || 0),
        outputTokens: Number(r.outputTokens || 0),
        costUsd:      parseFloat(costUsd.toFixed(6)),
        creditsCharged: credits,
        revenueUsd:   parseFloat(revenueUsd.toFixed(4)),
        marginUsd:    parseFloat(marginUsd.toFixed(4)),
        callCount:    Number(r.callCount || 0),
      };
    });

    res.json({ sessions, total, page, limit, creditsPerDollar });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agent Sessions Explorer (reads from agent_sessions table) ────────────────
// Returns per-session rows with type, model, duration, cost, credits, success.
router.get("/api/agent-sessions", async (req: Request, res: Response) => {
  try {
    const page  = Math.max(1, parseInt(String(req.query.page  || "1"), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "50"), 10)));
    const skip  = (page - 1) * limit;

    const typeFilter      = typeof req.query.type      === "string" ? req.query.type : undefined;
    const projectIdFilter = typeof req.query.projectId === "string" ? req.query.projectId.trim() || undefined : undefined;
    const userIdFilter    = typeof req.query.userId    === "string" ? parseInt(req.query.userId, 10) : undefined;
    const successFilter   = typeof req.query.success   === "string" ? req.query.success === "true" : undefined;
    const fromDate = typeof req.query.from === "string" ? new Date(req.query.from) : undefined;
    const toDate   = typeof req.query.to   === "string" ? new Date(req.query.to)   : undefined;

    const where: any = {};
    if (typeFilter)                     where.type      = typeFilter;
    if (projectIdFilter)                where.projectId = projectIdFilter;
    if (!isNaN(userIdFilter as any))    where.userId    = userIdFilter;
    if (successFilter !== undefined)    where.success   = successFilter;
    if (fromDate || toDate) {
      where.createdAt = {};
      if (fromDate && !isNaN(fromDate.getTime())) where.createdAt.gte = fromDate;
      if (toDate   && !isNaN(toDate.getTime()))   where.createdAt.lte = toDate;
    }

    const [rows, total, agg, failCount] = await Promise.all([
      prisma.agentSession.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: { project: { select: { name: true } } },
      }),
      prisma.agentSession.count({ where }),
      prisma.agentSession.aggregate({
        where,
        _sum: { costUsd: true, creditsCharged: true, durationMs: true },
      }),
      prisma.agentSession.count({ where: { ...where, success: false } }),
    ]);

    const creditsPerDollar = runtimeConfig.getCreditsPerDollar() || 50;
    const sessions = rows.map((s: any) => {
      const costUsd       = Number(s.costUsd   || 0);
      const costUsdInput  = s.costUsdInput  != null ? Number(s.costUsdInput)  : null;
      const costUsdOutput = s.costUsdOutput != null ? Number(s.costUsdOutput) : null;
      const credits       = Number(s.creditsCharged || 0);
      const revenueUsd    = credits / creditsPerDollar;
      const marginUsd     = revenueUsd - costUsd;
      return {
        id:             s.id,
        type:           s.type,
        projectId:      s.projectId,
        projectName:    s.project?.name || "Unknown",
        userId:         s.userId,
        model:          s.model,
        input:          (s.input  || "").substring(0, 120),
        creditsCharged: credits,
        costUsd:        parseFloat(costUsd.toFixed(6)),
        // Input/output split — null when the row is older than the OR
        // usage-accounting wiring. Frontend hides the breakdown row in that
        // case rather than showing $0.000000 for both.
        costUsdInput:   costUsdInput  != null ? parseFloat(costUsdInput.toFixed(6))  : null,
        costUsdOutput:  costUsdOutput != null ? parseFloat(costUsdOutput.toFixed(6)) : null,
        revenueUsd:     parseFloat(revenueUsd.toFixed(4)),
        marginUsd:      parseFloat(marginUsd.toFixed(4)),
        inputTokens:    s.inputTokens,
        outputTokens:   s.outputTokens,
        durationMs:     s.durationMs,
        success:        s.success,
        createdAt:      s.createdAt,
        complexity:     s.complexity ?? null,
        isMaxMode:      !!s.isMaxMode,
      };
    });

    const totalCostUsd      = Number(agg._sum.costUsd       || 0);
    const totalCredits      = Number(agg._sum.creditsCharged || 0);
    const totalRevenueUsd   = totalCredits / creditsPerDollar;
    const totalMarginUsd    = totalRevenueUsd - totalCostUsd;
    const totalDurationMs   = Number(agg._sum.durationMs    || 0);
    const avgDurationMs     = total > 0 ? Math.round(totalDurationMs / total) : 0;

    res.json({
      sessions,
      total,
      page,
      limit,
      creditsPerDollar,
      totals: {
        costUsd:    parseFloat(totalCostUsd.toFixed(5)),
        revenueUsd: parseFloat(totalRevenueUsd.toFixed(4)),
        marginUsd:  parseFloat(totalMarginUsd.toFixed(4)),
        failCount,
        avgDurationMs,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE a single agent session log entry by id.
router.delete("/api/agent-sessions/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) { res.status(400).json({ error: "id is required" }); return; }
    await prisma.agentSession.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── App Store moderation ─────────────────────────────────────────────────────
// Browser admin (bearer auth via /admin/api) endpoints. All listing/token
// access goes through appStoreService so DB integrity stays in one place.
router.get("/api/listings", async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || undefined;
    const { appStoreService } = await import("../../services/app-store.service");
    const items = await appStoreService.listForReview(status);
    res.json({
      items: items.map((row: any) => ({
        id: row.id,
        projectId: row.projectId,
        projectName: row.project?.name,
        botUsername: row.project?.botUsername,
        ownerTg: row.project?.user?.telegramId?.toString(),
        ownerUsername: row.project?.user?.username,
        ownerFirstName: row.project?.user?.firstName,
        status: row.status,
        shortDescription: row.shortDescription,
        longDescription: row.longDescription,
        category: row.category,
        socials: row.socials,
        screenshots: row.screenshots,
        publishFeeTxHash: row.publishFeeTxHash,
        submittedAt: row.submittedAt,
        approvedAt: row.approvedAt,
        publishedAt: row.publishedAt,
        rejectedReason: row.rejectedReason,
        hidden: row.hidden,
        token: row.token ? {
          id: row.token.id,
          name: row.token.name,
          symbol: row.token.symbol,
          logoFilename: row.token.logoFilename,
          status: row.token.status,
          jettonMasterAddress: row.token.jettonMasterAddress,
          deployTxHash: row.token.deployTxHash,
        } : null,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/listings/:id/approve", async (req: Request, res: Response) => {
  try {
    const { appStoreService } = await import("../../services/app-store.service");
    // Admin user id 0 → not a real user, but appStoreService.approve only
    // stores it in approvedBy. The browser admin doesn't have a paired User
    // row by default, so 0 is a sentinel "browser admin".
    const result = await appStoreService.approve(req.params.id as string, 0);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/api/listings/:id/reject", async (req: Request, res: Response) => {
  try {
    const reason = String(req.body?.reason || "rejected");
    const { appStoreService } = await import("../../services/app-store.service");
    const result = await appStoreService.reject(req.params.id as string, reason);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/api/listings/:id/hide", async (req: Request, res: Response) => {
  try {
    const hidden = req.body?.hidden !== false;
    const { appStoreService } = await import("../../services/app-store.service");
    const result = await appStoreService.setHidden(req.params.id as string, hidden);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE all usage_log rows for a given agent session (task_id).
// Used by Admin → Sessions to purge a single run from the table.
router.delete("/api/sessions/:taskId", async (req: Request, res: Response) => {
  try {
    const taskId = String(req.params.taskId || "").trim();
    if (!taskId) {
      res.status(400).json({ error: "taskId is required" });
      return;
    }
    const result = await prisma.usageLog.deleteMany({ where: { taskId } });
    res.json({ ok: true, deleted: result.count });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET agent session configurations and pricing.
// `pricing` returns the complexity matrix:
//   { build: { trivial, small, medium, large, huge },
//     update: {...}, "update-plan": {...},
//     "update-plan-per-item": {...}, "bug-fix": {...} }
router.get("/api/config/sessions", async (_req: Request, res: Response) => {
  res.json({
    sessions: runtimeConfig.getAllSessionConfigs(),
    pricing: runtimeConfig.getAgentPricing(),
  });
});

// POST update agent session configuration and pricing
router.post("/api/config/sessions", async (req: Request, res: Response) => {
  try {
    const { sessions, pricing } = req.body;
    const update: any = {};
    if (sessions && typeof sessions === "object") update.agentSessions = sessions;
    if (pricing && typeof pricing === "object") update.agentPricing = pricing;
    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "sessions or pricing required" });
      return;
    }
    runtimeConfig.update(update);
    res.json({ ok: true, sessions: runtimeConfig.getAllSessionConfigs(), pricing: runtimeConfig.get().agentPricing });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/stats/sources/users", async (req: Request, res: Response) => {
  try {
    const result = await listSourceUsers({
      from: parseIsoQuery(req.query.from),
      to:   parseIsoQuery(req.query.to),
      kind: String(req.query.kind || "all") as any,
      key:  typeof req.query.key === "string" ? req.query.key : "",
    });
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- Runtime Config ---

router.get("/api/config", (_req: Request, res: Response) => {
  res.json(runtimeConfig.get());
});

router.post("/api/config", (req: Request, res: Response) => {
  try {
    runtimeConfig.update(req.body);
    res.json(runtimeConfig.get());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Runner npm allowlist ---
//
// Backs the admin "Allowed npm packages" page. The file is the single source
// of truth read by both:
//   * src/services/runner-npm-allowlist.service.ts (agent-side npm_install tool)
//   * security-migrations/runner-npm-scan.sh       (server-side post-deploy scan)
// Both load it from $APP_DIR/runner-npm-allowlist.json (= cwd at runtime).
//
// PUT writes the file atomically (write-then-rename) so a concurrent reader
// never sees a half-written JSON. The runtime allowlist service mtime-checks
// on every read, so changes are picked up by the very next npm_install call
// without restarting node.

const RUNNER_ALLOWLIST_PATH = path.join(process.cwd(), "runner-npm-allowlist.json");

interface AllowlistEntryAdmin {
  minVersion?: string;
  description: string;
}
interface AllowlistFileAdmin {
  version?: number;
  allowedPackages: Record<string, AllowlistEntryAdmin>;
  $comment?: string[];
}

function readAllowlistFile(): { exists: boolean; raw: string; parsed: AllowlistFileAdmin } {
  if (!fs.existsSync(RUNNER_ALLOWLIST_PATH)) {
    return {
      exists: false,
      raw: "",
      parsed: { version: 1, allowedPackages: {} },
    };
  }
  const raw = fs.readFileSync(RUNNER_ALLOWLIST_PATH, "utf-8");
  let parsed: AllowlistFileAdmin;
  try {
    parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.allowedPackages || typeof parsed.allowedPackages !== "object") {
      throw new Error("file does not contain an allowedPackages object");
    }
  } catch (err) {
    throw Object.assign(new Error("Existing allowlist file is not valid JSON: " + (err as Error).message), { status: 500 });
  }
  return { exists: true, raw, parsed };
}

function validatePackageName(name: string): string | null {
  if (!name || typeof name !== "string") return "package name is required";
  if (name.length > 214) return "package name too long";
  // Bare package name OR scoped (@scope/name).
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    return `"${name}" is not a valid bare npm package name (use lowercase letters, digits, dot, dash, underscore; scoped names @scope/name are OK)`;
  }
  return null;
}

router.get("/api/runner-allowlist", (_req: Request, res: Response) => {
  try {
    const { exists, raw, parsed } = readAllowlistFile();
    res.json({
      path: RUNNER_ALLOWLIST_PATH,
      exists,
      raw,
      version: parsed.version || 1,
      allowedPackages: parsed.allowedPackages || {},
      comment: Array.isArray(parsed.$comment) ? parsed.$comment : [],
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/api/runner-allowlist", (req: Request, res: Response) => {
  try {
    let next: AllowlistFileAdmin;

    if (typeof req.body?.raw === "string") {
      // Raw-text save (whole-file JSON paste). Parse + validate before writing.
      let parsed: any;
      try {
        parsed = JSON.parse(req.body.raw);
      } catch (err) {
        res.status(400).json({ error: "Body is not valid JSON: " + (err as Error).message });
        return;
      }
      if (!parsed || typeof parsed !== "object" || !parsed.allowedPackages || typeof parsed.allowedPackages !== "object") {
        res.status(400).json({ error: "JSON must have an 'allowedPackages' object at the top level" });
        return;
      }
      next = parsed as AllowlistFileAdmin;
    } else if (req.body?.allowedPackages && typeof req.body.allowedPackages === "object") {
      // Form-mode save: caller passes the new packages map; preserve $comment +
      // version from disk (or from the body if explicitly provided).
      const current = (() => {
        try { return readAllowlistFile().parsed; }
        catch { return { version: 1, allowedPackages: {} } as AllowlistFileAdmin; }
      })();
      next = {
        $comment: Array.isArray(req.body.$comment) ? req.body.$comment : current.$comment,
        version: typeof req.body.version === "number" ? req.body.version : (current.version || 1),
        allowedPackages: req.body.allowedPackages,
      };
    } else {
      res.status(400).json({ error: "Body must include either { raw: '<json>' } or { allowedPackages: {...} }" });
      return;
    }

    // Validate every package entry.
    const issues: string[] = [];
    const sanitised: Record<string, AllowlistEntryAdmin> = {};
    for (const [rawName, rawEntry] of Object.entries(next.allowedPackages)) {
      const name = String(rawName || "").trim();
      const nameErr = validatePackageName(name);
      if (nameErr) { issues.push(nameErr); continue; }
      if (!rawEntry || typeof rawEntry !== "object") { issues.push(`"${name}": entry must be an object`); continue; }
      const entry = rawEntry as unknown as Record<string, unknown>;
      const description = typeof entry.description === "string" ? entry.description.trim() : "";
      if (!description) { issues.push(`"${name}": description is required`); continue; }
      const sanitisedEntry: AllowlistEntryAdmin = { description };
      if (typeof entry.minVersion === "string" && entry.minVersion.trim()) {
        const v = entry.minVersion.trim();
        // Light-weight semver-ish check; accept things like "1", "1.2", "1.2.3", "1.2.3-beta".
        if (!/^\d+(?:\.\d+){0,2}(?:-[A-Za-z0-9.-]+)?$/.test(v)) {
          issues.push(`"${name}": minVersion "${v}" doesn't look like a semver (expected e.g. 1.2.3)`);
          continue;
        }
        sanitisedEntry.minVersion = v;
      }
      sanitised[name] = sanitisedEntry;
    }
    if (issues.length) {
      res.status(400).json({ error: "Validation failed", issues });
      return;
    }

    next.allowedPackages = sanitised;
    if (typeof next.version !== "number") next.version = 1;

    // Re-emit with stable key order: $comment, version, allowedPackages (sorted).
    const sortedKeys = Object.keys(sanitised).sort((a, b) => a.localeCompare(b));
    const ordered: AllowlistFileAdmin = {
      $comment: next.$comment,
      version: next.version,
      allowedPackages: Object.fromEntries(sortedKeys.map(k => [k, sanitised[k]])),
    };

    const newRaw = JSON.stringify(ordered, null, 2) + "\n";
    const tmpPath = RUNNER_ALLOWLIST_PATH + ".tmp." + process.pid;
    fs.writeFileSync(tmpPath, newRaw, "utf-8");
    fs.renameSync(tmpPath, RUNNER_ALLOWLIST_PATH);

    res.json({
      ok: true,
      path: RUNNER_ALLOWLIST_PATH,
      raw: newRaw,
      version: ordered.version,
      allowedPackages: ordered.allowedPackages,
      comment: Array.isArray(ordered.$comment) ? ordered.$comment : [],
      packageCount: sortedKeys.length,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- DANGER: Erase entire database + project folders + bucket files ---
// Wipes all user-generated state (users, projects, listings, tokens, holdings,
// etc.) and the on-disk artefacts (projects/* and bucket/*). Runtime config,
// bundles and bot-managed catalogues are preserved.
router.post("/api/erase-all", async (req: Request, res: Response) => {
  try {
    const confirm = String(req.body?.confirm || "");
    if (confirm !== "ERASE EVERYTHING") {
      res.status(400).json({ error: 'Pass { "confirm": "ERASE EVERYTHING" } to proceed.' });
      return;
    }

    // Order matters: leaf tables first, then parents.
    // Use raw DELETE so we don't have to worry about cascade nuances.
    await prisma.$transaction([
      // Token / market related
      prisma.tokenTrade.deleteMany({}),
      prisma.tokenHolding.deleteMany({}),
      prisma.liquidityEvent.deleteMany({}),
      prisma.liquidityPosition.deleteMany({}),
      prisma.appToken.deleteMany({}),
      prisma.appListing.deleteMany({}),
      prisma.tonTopup.deleteMany({}),

      // App / build artefacts
      prisma.appLog.deleteMany({}),
      prisma.agentCodePatch.deleteMany({}),
      prisma.agentFeedback.deleteMany({}),
      prisma.agentSession.deleteMany({}),
      prisma.usageLog.deleteMany({}),
      prisma.conversation.deleteMany({}),
      prisma.asset.deleteMany({}),
      prisma.version.deleteMany({}),

      // Tasks / vouchers / payments
      prisma.taskCompletion.deleteMany({}),
      prisma.voucherRedemption.deleteMany({}),
      prisma.payment.deleteMany({}),
      prisma.withdrawal.deleteMany({}),

      // Projects
      prisma.project.deleteMany({}),

      // Per-user side data
      prisma.adminUserNote.deleteMany({}),
      prisma.retentionPush.deleteMany({}),

      // Users last (everything else FK's to them)
      prisma.user.deleteMany({}),
    ]);

    // Wipe on-disk artefacts: projects/* + bucket/*
    const fsp = await import("fs/promises");
    const wipeDir = async (dir: string) => {
      try {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        await Promise.all(entries.map(e =>
          fsp.rm(path.join(dir, e.name), { recursive: true, force: true })
        ));
      } catch { /* dir might not exist */ }
    };
    await wipeDir(PROJECTS_DIR);
    await wipeDir(path.join(process.cwd(), "bucket"));

    res.json({ ok: true, message: "Everything erased." });
  } catch (err: any) {
    console.error("[admin/erase-all]", err);
    res.status(500).json({ error: err.message || "Erase failed" });
  }
});

// --- Vouchers ---

router.get("/api/vouchers", async (_req: Request, res: Response) => {
  try {
    const vouchers = await prisma.voucher.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { redemptions: true } } },
    });
    res.json(vouchers.map(v => ({
      id: v.id,
      code: v.code,
      amountUsd: Number(v.amountUsd),
      credits: v.credits,
      maxUses: v.maxUses,
      usedCount: v.usedCount,
      active: v.active,
      payingOnly: v.payingOnly,
      createdAt: v.createdAt,
      link: `https://t.me/apps_father_bot?start=${v.code}`,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/vouchers", async (req: Request, res: Response) => {
  try {
    const { credits, maxUses, payingOnly } = req.body;
    const cr = parseInt(credits, 10);
    const uses = parseInt(maxUses, 10);
    if (isNaN(cr) || cr <= 0) { res.status(400).json({ error: "Invalid credits" }); return; }
    if (isNaN(uses) || uses <= 0) { res.status(400).json({ error: "Invalid maxUses" }); return; }

    const code = "v_" + crypto.randomBytes(4).toString("hex");
    const voucher = await prisma.voucher.create({
      data: {
        code,
        amountUsd: new Decimal("0"),
        credits: cr,
        maxUses: uses,
        payingOnly: Boolean(payingOnly),
      },
    });
    res.json({
      id: voucher.id,
      code: voucher.code,
      amountUsd: Number(voucher.amountUsd),
      credits: voucher.credits,
      maxUses: voucher.maxUses,
      usedCount: 0,
      active: true,
      payingOnly: voucher.payingOnly,
      createdAt: voucher.createdAt,
      link: `https://t.me/apps_father_bot?start=${voucher.code}`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/api/vouchers/:id", async (req: Request<{id: string}>, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const data: any = {};
    if (req.body.amount !== undefined) data.amountUsd = new Decimal(parseFloat(req.body.amount).toFixed(4));
    if (req.body.maxUses !== undefined) data.maxUses = parseInt(req.body.maxUses, 10);
    if (req.body.active !== undefined) data.active = Boolean(req.body.active);
    if (req.body.payingOnly !== undefined) data.payingOnly = Boolean(req.body.payingOnly);
    const voucher = await prisma.voucher.update({ where: { id }, data });
    res.json({ id: voucher.id, amountUsd: Number(voucher.amountUsd), maxUses: voucher.maxUses, active: voucher.active, payingOnly: voucher.payingOnly });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/api/vouchers/:id", async (req: Request<{id: string}>, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    await prisma.voucherRedemption.deleteMany({ where: { voucherId: id } });
    await prisma.voucher.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Helpers ---

function walkDir(dir: string, base: string): { path: string; name: string }[] {
  const results: { path: string; name: string }[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(base, fullPath).replace(/\\/g, "/");
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, base));
    } else {
      results.push({ path: relPath, name: entry.name });
    }
  }
  return results;
}

// --- Serve the SPA for any non-API path under /admin ---
// Static assets: admin/css/*, admin/js/*, etc.
router.use(express.static(ADMIN_DIR, { fallthrough: true, index: false }));

// SPA fallback: anything that isn't /api/* falls back to index.html so the
// vanilla-JS router on the client can take over.
// Proxy the OpenRouter model catalog so the Models admin page can show live pricing.
router.get("/api/openrouter/models", authMiddleware, async (_req: Request, res: Response) => {
  const key = runtimeConfig.getOpenRouterApiKey() || config.openrouterApiKey;
  if (!key) {
    res.status(400).json({ error: "OpenRouter API key not configured" });
    return;
  }
  try {
    const r = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = await r.json();
    res.json(data);
  } catch (err: any) {
    res.status(502).json({ error: `Failed to fetch OpenRouter models: ${err.message}` });
  }
});

router.get("/api/openrouter/models/:author/:slug/endpoints", authMiddleware, async (req: Request, res: Response) => {
  const key = runtimeConfig.getOpenRouterApiKey() || config.openrouterApiKey;
  if (!key) {
    res.status(400).json({ error: "OpenRouter API key not configured" });
    return;
  }
  const author = String(req.params.author || "");
  const slug = String(req.params.slug || "");
  try {
    const r = await fetch(`https://openrouter.ai/api/v1/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!r.ok) {
      res.status(r.status).json({ error: `OpenRouter returned ${r.status}` });
      return;
    }
    const data = await r.json();
    res.json(data);
  } catch (err: any) {
    res.status(502).json({ error: `Failed to fetch endpoints: ${err.message}` });
  }
});

// ── Bundles CRUD ─────────────────────────────────────────────────────────────

router.get("/api/bundles", async (_req: Request, res: Response) => {
  try {
    const bundles = await prisma.bundle.findMany({ orderBy: { sortOrder: "asc" } });
    res.json(bundles.map((b) => ({
      id: b.id,
      name: b.name,
      credits: b.credits,
      bonusCredits: b.bonusCredits,
      priceUsd: Number(b.priceUsd),
      discount: b.discount,
      isLimited: b.isLimited,
      limitTotal: b.limitTotal,
      purchaseCount: b.purchaseCount,
      isActive: b.isActive,
      sortOrder: b.sortOrder,
      createdAt: b.createdAt,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/bundles", async (req: Request, res: Response) => {
  try {
    const { name, credits, bonusCredits, priceUsd, discount, isLimited, limitTotal, isActive, sortOrder } = req.body;
    if (!name || !credits || !priceUsd) {
      res.status(400).json({ error: "name, credits, and priceUsd are required" });
      return;
    }
    const id = `bundle_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const bundle = await prisma.bundle.create({
      data: {
        id,
        name: String(name),
        credits: parseInt(credits, 10),
        bonusCredits: parseInt(bonusCredits || 0, 10),
        priceUsd: new Decimal(Number(priceUsd).toFixed(4)),
        discount: parseInt(discount || 0, 10),
        isLimited: Boolean(isLimited),
        limitTotal: isLimited && limitTotal ? parseInt(limitTotal, 10) : null,
        isActive: isActive !== false,
        sortOrder: parseInt(sortOrder || 0, 10),
      },
    });
    res.json(bundle);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/api/bundles/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { name, credits, bonusCredits, priceUsd, discount, isLimited, limitTotal, isActive, sortOrder } = req.body;
    const bundle = await prisma.bundle.update({
      where: { id: req.params.id },
      data: {
        ...(name !== undefined && { name: String(name) }),
        ...(credits !== undefined && { credits: parseInt(credits, 10) }),
        ...(bonusCredits !== undefined && { bonusCredits: parseInt(bonusCredits, 10) }),
        ...(priceUsd !== undefined && { priceUsd: new Decimal(Number(priceUsd).toFixed(4)) }),
        ...(discount !== undefined && { discount: parseInt(discount, 10) }),
        ...(isLimited !== undefined && { isLimited: Boolean(isLimited) }),
        ...(limitTotal !== undefined && { limitTotal: isLimited && limitTotal ? parseInt(limitTotal, 10) : null }),
        ...(isActive !== undefined && { isActive: Boolean(isActive) }),
        ...(sortOrder !== undefined && { sortOrder: parseInt(sortOrder, 10) }),
      },
    });
    res.json(bundle);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/api/bundles/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    await prisma.bundle.update({
      where: { id: req.params.id },
      data: { isActive: false },
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/bundles/:id/reset-count", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const bundle = await prisma.bundle.update({
      where: { id: req.params.id },
      data: { purchaseCount: 0 },
    });
    res.json({ ok: true, purchaseCount: bundle.purchaseCount });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── Tasks CRUD ──────────────────────────────────────────────────────────────

const TASK_UPLOADS_DIR = path.join(ADMIN_DIR, "uploads", "tasks");
if (!fs.existsSync(TASK_UPLOADS_DIR)) fs.mkdirSync(TASK_UPLOADS_DIR, { recursive: true });

const taskImageStorage = (require("multer") as any).diskStorage({
  destination: (_req: any, _file: any, cb: any) => cb(null, TASK_UPLOADS_DIR),
  filename: (_req: any, file: any, cb: any) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`);
  },
});
const taskImageUpload = (require("multer") as any)({ storage: taskImageStorage, limits: { fileSize: 5 * 1024 * 1024 } });

router.post("/api/tasks/upload-image", taskImageUpload.single("image"), async (req: Request, res: Response) => {
  try {
    if (!req.file) { res.status(400).json({ error: "No file" }); return; }
    const url = `/admin/uploads/tasks/${req.file.filename}`;
    res.json({ url });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/tasks", async (_req: Request, res: Response) => {
  try {
    const tasks = await prisma.task.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    });
    const counts = await prisma.taskCompletion.groupBy({
      by: ["taskId"],
      _count: { taskId: true },
    });
    const countMap = new Map(counts.map(c => [c.taskId, c._count.taskId]));
    res.json(tasks.map(t => ({ ...t, _completionCount: countMap.get(t.id) ?? 0 })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/tasks", async (req: Request, res: Response) => {
  try {
    const { title, description, imageUrl, reward, link, type, payload, targeting, delaySeconds, isActive, sortOrder } = req.body;
    const task = await prisma.task.create({
      data: {
        title: title || { en: "", ru: "", uk: "" },
        description: description || { en: "", ru: "", uk: "" },
        imageUrl: imageUrl || null,
        reward: Number(reward) || 0,
        link: link || "",
        type: type || "open_link",
        payload: payload || null,
        targeting: targeting || "all",
        delaySeconds: Number(delaySeconds) || 5,
        isActive: isActive !== false,
        sortOrder: Number(sortOrder) || 0,
      },
    });
    res.json(task);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/api/tasks/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { title, description, imageUrl, reward, link, type, payload, targeting, delaySeconds, isActive, sortOrder } = req.body;
    const task = await prisma.task.update({
      where: { id },
      data: {
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(imageUrl !== undefined && { imageUrl: imageUrl || null }),
        ...(reward !== undefined && { reward: Number(reward) }),
        ...(link !== undefined && { link }),
        ...(type !== undefined && { type }),
        ...(payload !== undefined && { payload: payload || null }),
        ...(targeting !== undefined && { targeting }),
        ...(delaySeconds !== undefined && { delaySeconds: Number(delaySeconds) }),
        ...(isActive !== undefined && { isActive }),
        ...(sortOrder !== undefined && { sortOrder: Number(sortOrder) }),
      },
    });
    res.json(task);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/api/tasks/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    await prisma.task.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Serve uploaded task images
router.use("/uploads/tasks", express.static(TASK_UPLOADS_DIR));

// ── Agent Lessons & Code Patches (training knowledge) ──────────────────────
//
// Two stores share one Import/Export pipeline:
//   * agent-lessons  — text rules, runtime-injected when enabled.
//   * agent-patches  — text suggestions for editing agent code, never auto-applied.
// See agent-lessons.service.ts for per-env semantics.
import * as agentKnowledge from "../../services/agent-lessons.service";

// In-memory upload storage for the import preview/apply endpoints (small JSON files).
const knowledgeImportUpload = (require("multer") as any)({
  storage: (require("multer") as any).memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

// --- Lessons CRUD ---

router.get("/api/agent-lessons", async (req: Request, res: Response) => {
  try {
    const enabled =
      req.query.enabled === "true" ? true : req.query.enabled === "false" ? false : undefined;
    const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const lessons = await agentKnowledge.listLessons({ enabled, tag, q });
    res.json(lessons);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/api/agent-lessons", async (req: Request, res: Response) => {
  try {
    const lesson = await agentKnowledge.createLesson(req.body || {});
    res.json(lesson);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get("/api/agent-lessons/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const lesson = await agentKnowledge.getLesson(req.params.id);
    if (!lesson) {
      res.status(404).json({ error: "Lesson not found" });
      return;
    }
    res.json(lesson);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.patch("/api/agent-lessons/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const lesson = await agentKnowledge.updateLesson(req.params.id, req.body || {});
    res.json(lesson);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete("/api/agent-lessons/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    await agentKnowledge.deleteLesson(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/api/agent-lessons/:id/enable", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const lesson = await agentKnowledge.setLessonEnabled(req.params.id, true);
    res.json(lesson);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/api/agent-lessons/:id/disable", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const lesson = await agentKnowledge.setLessonEnabled(req.params.id, false);
    res.json(lesson);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/api/agent-lessons/bulk-enable", async (req: Request, res: Response) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const result = await agentKnowledge.bulkSetLessonEnabled(ids, true);
    res.json({ ok: true, count: result.count });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/api/agent-lessons/bulk-disable", async (req: Request, res: Response) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const result = await agentKnowledge.bulkSetLessonEnabled(ids, false);
    res.json({ ok: true, count: result.count });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- Code Patches CRUD ---

router.get("/api/agent-patches", async (req: Request, res: Response) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const patches = await agentKnowledge.listPatches({ status, tag, q });
    res.json(patches);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/api/agent-patches", async (req: Request, res: Response) => {
  try {
    const patch = await agentKnowledge.createPatch(req.body || {});
    res.json(patch);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get("/api/agent-patches/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const patch = await agentKnowledge.getPatch(req.params.id);
    if (!patch) {
      res.status(404).json({ error: "Patch not found" });
      return;
    }
    res.json(patch);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.patch("/api/agent-patches/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const patch = await agentKnowledge.updatePatch(req.params.id, req.body || {});
    res.json(patch);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete("/api/agent-patches/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    await agentKnowledge.deletePatch(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/api/agent-patches/:id/mark-applied", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const commit = typeof req.body?.commit === "string" ? req.body.commit : undefined;
    const patch = await agentKnowledge.setPatchStatus(req.params.id, "applied", { commit });
    res.json(patch);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/api/agent-patches/:id/mark-rejected", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const patch = await agentKnowledge.setPatchStatus(req.params.id, "rejected");
    res.json(patch);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/api/agent-patches/:id/reopen", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const patch = await agentKnowledge.setPatchStatus(req.params.id, "proposed");
    res.json(patch);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// --- Unified Export / Import (one file, both kinds) ---

router.get("/api/agent-knowledge/export", async (req: Request, res: Response) => {
  try {
    const includeRaw =
      typeof req.query.include === "string" ? req.query.include : undefined;
    const include = includeRaw
      ? (includeRaw.split(",").map((s) => s.trim()).filter(Boolean) as any)
      : undefined;
    const { json, filename } = await agentKnowledge.exportKnowledge({ include });
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(json);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post(
  "/api/agent-knowledge/import/preview",
  knowledgeImportUpload.single("file"),
  async (req: Request, res: Response) => {
    try {
      const raw = req.file?.buffer?.toString("utf-8");
      if (!raw) {
        res.status(400).json({ error: "No file uploaded" });
        return;
      }
      const diff = await agentKnowledge.previewImport(raw);
      res.json(diff);
    } catch (err: any) {
      res.status(err.status || 500).json({ error: err.message });
    }
  },
);

router.post("/api/agent-knowledge/import/apply", async (req: Request, res: Response) => {
  try {
    const { json, lessonActions, patchActions, enableNewLessons } = req.body || {};
    if (typeof json !== "string" || !json.trim()) {
      res.status(400).json({ error: "Missing 'json' string in body" });
      return;
    }
    const result = await agentKnowledge.applyImport(json, {
      lessonActions: lessonActions || {},
      patchActions: patchActions || {},
      enableNewLessons: !!enableNewLessons,
    });
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Agent Feedback (cashback issues) — review & analysis ────────────────────
//
// Admin reviews cases collected by the mini app, then either:
//   1. Clicks "Run Analysis" → fires LLM in background (status: learning)
//   2. After result_ready, clicks "Apply" → creates AgentLesson / AgentCodePatch
//      rows from the LLM's suggestions.
import * as agentFeedbackService from "../../services/agent-feedback.service";

router.get("/api/agent-feedback", async (req: Request, res: Response) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const where: any = {};
    if (status && status !== "all") where.analysisStatus = status;
    if (q) {
      where.OR = [
        { userPrompt: { contains: q, mode: "insensitive" } },
        { userDescription: { contains: q, mode: "insensitive" } },
      ];
    }
    // Guard against orphaned rows (project deleted after feedback was created).
    // Prisma throws "got null instead" for required relations, so we pre-filter.
    where.project = { id: { not: "" } };
    const items = await prisma.agentFeedback.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      include: {
        user: { select: { id: true, telegramId: true, username: true, firstName: true } },
        project: { select: { id: true, name: true, botUsername: true } },
      },
    });
    // Convert BigInt telegramId for JSON.
    const safe = items.map((it: any) => ({
      ...it,
      user: it.user
        ? { ...it.user, telegramId: it.user.telegramId ? String(it.user.telegramId) : null }
        : null,
    }));
    res.json(safe);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get("/api/agent-feedback/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const fb = await prisma.agentFeedback.findFirst({
      where: { id: req.params.id, project: { id: { not: "" } } },
      include: {
        user: { select: { id: true, telegramId: true, username: true, firstName: true } },
        project: { select: { id: true, name: true, botUsername: true } },
      },
    });
    if (!fb) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // Lazy-load the parsed agent log only on the detail endpoint to keep the
    // list payload light.
    const logEntries = agentFeedbackService.readAgentLogEntries(fb.projectId, fb.commitNumAfter);
    res.json({
      ...fb,
      user: fb.user
        ? { ...fb.user, telegramId: fb.user.telegramId ? String(fb.user.telegramId) : null }
        : null,
      logEntries,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/api/agent-feedback/:id/analyze", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const fb = await prisma.agentFeedback.findUnique({ where: { id: req.params.id } });
    if (!fb) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (fb.analysisStatus === "learning") {
      res.status(409).json({ error: "already_learning" });
      return;
    }
    // Fire-and-forget: respond immediately so admin UI can poll for status.
    // Errors are caught + recorded to analysisError on the row.
    agentFeedbackService.analyzeCase(req.params.id).catch((err) => {
      console.warn(`[Admin] analyzeCase background failure: ${err?.message || err}`);
    });
    res.json({ ok: true, status: "learning" });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post("/api/agent-feedback/:id/apply", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const fb = await prisma.agentFeedback.findUnique({ where: { id: req.params.id } });
    if (!fb) { res.status(404).json({ error: "Not found" }); return; }
    if (fb.analysisStatus !== "result_ready") {
      res.status(409).json({ error: "not_ready" });
      return;
    }
    const result = (fb.analysisResult as any) || {};
    const lessons = Array.isArray(result.suggestedLessons) ? result.suggestedLessons : [];
    const patches = Array.isArray(result.suggestedPatches) ? result.suggestedPatches : [];

    // Optional: caller can specify which suggestions to apply. Default = all.
    const lessonPicks: number[] = Array.isArray(req.body?.lessonIndexes)
      ? req.body.lessonIndexes.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
      : lessons.map((_: any, i: number) => i);
    const patchPicks: number[] = Array.isArray(req.body?.patchIndexes)
      ? req.body.patchIndexes.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n))
      : patches.map((_: any, i: number) => i);

    const createdLessonIds: string[] = [];
    for (const idx of lessonPicks) {
      const l = lessons[idx];
      if (!l || !l.rule) continue;
      const created = await agentKnowledge.createLesson({
        rule: String(l.rule),
        context: l.context ? String(l.context) : null,
        tags: Array.isArray(l.tags) ? l.tags.map(String) : [],
        notes: l.notes ? String(l.notes) : `From feedback case ${fb.id}`,
      });
      createdLessonIds.push(created.id);
    }

    const createdPatchIds: string[] = [];
    for (const idx of patchPicks) {
      const p = patches[idx];
      if (!p || !p.title || !p.problem || !p.suggestion || !p.cursorPrompt) continue;
      const created = await agentKnowledge.createPatch({
        title: String(p.title),
        problem: String(p.problem),
        targetFiles: Array.isArray(p.targetFiles) ? p.targetFiles.map(String) : [],
        suggestion: String(p.suggestion),
        cursorPrompt: String(p.cursorPrompt),
        tags: Array.isArray(p.tags) ? p.tags.map(String) : [],
        notes: p.notes ? String(p.notes) : `From feedback case ${fb.id}`,
      });
      createdPatchIds.push(created.id);
    }

    const updated = await prisma.agentFeedback.update({
      where: { id: fb.id },
      data: {
        analysisStatus: "applied",
        appliedAt: new Date(),
        appliedLessonIds: createdLessonIds,
        appliedPatchIds: createdPatchIds,
      },
    });
    res.json({
      ok: true,
      createdLessons: createdLessonIds.length,
      createdPatches: createdPatchIds.length,
      feedback: updated,
    });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.patch("/api/agent-feedback/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const status = typeof req.body?.analysisStatus === "string" ? req.body.analysisStatus : undefined;
    const allowed = new Set(["pending", "learning", "result_ready", "applied", "skipped"]);
    if (!status || !allowed.has(status)) {
      res.status(400).json({ error: "Invalid analysisStatus" });
      return;
    }
    const data: any = { analysisStatus: status };
    if (status === "skipped") data.appliedAt = new Date();
    if (status === "pending") data.analysisError = null;
    const updated = await prisma.agentFeedback.update({ where: { id: req.params.id }, data });
    res.json(updated);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.delete("/api/agent-feedback/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    await prisma.agentFeedback.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ── Balance Ledger API ──────────────────────────────────────────────────────

/** GET /api/ledger?page=1&limit=50&userId=&currency=&source=&from=&to= */
router.get("/api/ledger", async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1")));
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"))));
    const skip = (page - 1) * limit;

    const userId = req.query.userId ? parseInt(String(req.query.userId)) : undefined;
    const currency = req.query.currency ? String(req.query.currency) : undefined;
    const source = req.query.source ? String(req.query.source) : undefined;
    const from = req.query.from ? new Date(String(req.query.from)) : undefined;
    const to = req.query.to ? new Date(String(req.query.to)) : undefined;

    const where: any = {};
    if (userId && !isNaN(userId)) where.userId = userId;
    if (currency) where.currency = currency;
    if (source) where.source = source;
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to) where.createdAt.lte = to;
    }

    const [rows, total] = await Promise.all([
      prisma.balanceLedger.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          user: { select: { id: true, username: true, firstName: true, telegramId: true } },
        },
      }),
      prisma.balanceLedger.count({ where }),
    ]);

    res.json({
      rows: rows.map((r) => ({
        id: r.id.toString(),
        date: r.createdAt,
        currency: r.currency,
        amount: Number(r.amount),
        source: r.source,
        meta: r.meta,
        user: r.user,
      })),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /api/users/:id/ledger?page=1&limit=50 */
router.get("/api/users/:id/ledger", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const userId = parseInt(req.params.id);
    if (isNaN(userId)) { res.status(400).json({ error: "Invalid user id" }); return; }

    const page = Math.max(1, parseInt(String(req.query.page ?? "1")));
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"))));
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      prisma.balanceLedger.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.balanceLedger.count({ where: { userId } }),
    ]);

    res.json({
      rows: rows.map((r) => ({
        id: r.id.toString(),
        date: r.createdAt,
        currency: r.currency,
        amount: Number(r.amount),
        source: r.source,
        meta: r.meta,
      })),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── TON Withdrawals ──────────────────────────────────────────────────────────

/** GET /api/ton-withdrawals?status=pending&page=1&limit=50 */
router.get("/api/ton-withdrawals", async (req: Request, res: Response) => {
  try {
    const statusFilter = String(req.query.status || "");
    const page = Math.max(1, parseInt(String(req.query.page ?? "1")));
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "50"))));
    const skip = (page - 1) * limit;

    const where = statusFilter ? { status: statusFilter } : {};

    const [rows, total] = await Promise.all([
      prisma.tonWithdrawal.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          user: { select: { id: true, telegramId: true, username: true, firstName: true } },
        },
      }),
      prisma.tonWithdrawal.count({ where }),
    ]);

    res.json({
      rows: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        user: r.user,
        amountTon: Number(r.amountTon),
        tonAddress: r.tonAddress,
        status: r.status,
        txHash: r.txHash,
        adminNote: r.adminNote,
        createdAt: r.createdAt,
        processedAt: r.processedAt,
      })),
      total,
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/ton-withdrawals/:id/retry — re-attempt sendTon for a failed withdrawal */
router.post("/api/ton-withdrawals/:id/retry", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const withdrawal = await prisma.tonWithdrawal.findUnique({ where: { id } });
    if (!withdrawal) { res.status(404).json({ error: "Not found" }); return; }
    if (withdrawal.status !== "failed") {
      res.status(400).json({ error: "Only failed withdrawals can be retried" }); return;
    }

    // Reset to pending, then attempt send in background
    await prisma.tonWithdrawal.update({
      where: { id },
      data: { status: "pending", adminNote: null, processedAt: null },
    });

    res.json({ ok: true });

    setImmediate(async () => {
      const amountTon = Number(withdrawal.amountTon);
      try {
        const txHash = await sendTon(withdrawal.tonAddress, amountTon);
        await prisma.tonWithdrawal.update({
          where: { id },
          data: { status: "approved", txHash, processedAt: new Date() },
        });
        console.log(`[Admin] Retry withdrawal #${id} succeeded: ${txHash}`);
      } catch (err: any) {
        await prisma.tonWithdrawal.update({
          where: { id },
          data: { status: "failed", adminNote: err.message, processedAt: new Date() },
        }).catch(() => {});
        console.error(`[Admin] Retry withdrawal #${id} failed again:`, err.message);
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/ton-withdrawals/:id/refund — cancel a failed withdrawal and return TON balance */
router.post("/api/ton-withdrawals/:id/refund", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

    const withdrawal = await prisma.tonWithdrawal.findUnique({ where: { id } });
    if (!withdrawal) { res.status(404).json({ error: "Not found" }); return; }
    if (withdrawal.status !== "failed") {
      res.status(400).json({ error: "Only failed withdrawals can be refunded" }); return;
    }

    const amountTon = Number(withdrawal.amountTon);

    await prisma.$transaction([
      prisma.tonWithdrawal.update({
        where: { id },
        data: { status: "rejected", adminNote: "Refunded by admin", processedAt: new Date() },
      }),
      prisma.user.update({
        where: { id: withdrawal.userId },
        data: { tonBalance: { increment: amountTon } },
      }),
    ]);

    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// Phase 1 worker admin API. JSON-only, no SPA tab. Behind authMiddleware via
// the `/api` mount above.
//
// Lists, inspects, and manually controls per-project workers. Phase 2 will
// add provision / pin / set-tier / clear-cache / log-streaming endpoints
// plus a Workers tab in the admin SPA.

router.get("/api/workers", (_req: Request, res: Response) => {
  if (!config.isWorkerRuntime) {
    res.json({ mode: "in-process", workers: [] });
    return;
  }
  res.json({ mode: config.runtimeMode, workers: runnerManager.list() });
});

// stop-all defined BEFORE :id routes so Express does not interpret "stop-all"
// as a project id.
router.post("/api/workers/stop-all", async (_req: Request, res: Response) => {
  if (!config.isWorkerRuntime) {
    res.status(409).json({ error: "not_in_worker_mode" });
    return;
  }
  try {
    await runnerManager.killAll();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: "stop_all_failed", message: err.message });
  }
});

router.get("/api/workers/:id", (req: Request<{ id: string }>, res: Response) => {
  if (!config.isWorkerRuntime) {
    res.status(409).json({ error: "not_in_worker_mode" });
    return;
  }
  const id = req.params.id;
  const metrics = runnerManager.getMetrics(id);
  if (!metrics) {
    res.status(404).json({ error: "worker_not_running", projectId: id });
    return;
  }
  const limit = req.query.logs ? parseInt(String(req.query.logs), 10) : 200;
  const logs = runnerManager.getLogs(id, Number.isFinite(limit) ? limit : 200);
  res.json({ ...metrics, logs });
});

router.post("/api/workers/:id/stop", async (req: Request<{ id: string }>, res: Response) => {
  if (!config.isWorkerRuntime) {
    res.status(409).json({ error: "not_in_worker_mode" });
    return;
  }
  try {
    await runnerManager.stop(req.params.id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: "stop_failed", message: err.message });
  }
});

router.post("/api/workers/:id/restart", async (req: Request<{ id: string }>, res: Response) => {
  if (!config.isWorkerRuntime) {
    res.status(409).json({ error: "not_in_worker_mode" });
    return;
  }
  try {
    const handle = await runnerManager.restart(req.params.id);
    res.json({ ok: true, port: handle.port, pid: handle.pid });
  } catch (err: any) {
    res.status(500).json({ error: "restart_failed", message: err.message });
  }
});

router.post("/api/workers/:id/reload", async (req: Request<{ id: string }>, res: Response) => {
  if (!config.isWorkerRuntime) {
    res.status(409).json({ error: "not_in_worker_mode" });
    return;
  }
  try {
    const handle = await runnerManager.reload(req.params.id);
    res.json({ ok: true, port: handle.port, pid: handle.pid });
  } catch (err: any) {
    res.status(500).json({ error: "reload_failed", message: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────

router.get(/^\/(?!api(\/|$)).*/, (_req: Request, res: Response) => {
  const indexPath = path.join(ADMIN_DIR, "index.html");
  if (!fs.existsSync(indexPath)) {
    res.status(500).type("text/plain").send("admin/ folder not built \u2014 missing index.html");
    return;
  }
  res.sendFile(indexPath);
});

export default router;
