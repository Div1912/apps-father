import { Router, Request, Response, NextFunction } from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { prisma } from "../../db";
import { config } from "../../config";
import { runtimeConfig } from "../../services/runtime-config.service";
import { Decimal } from "@prisma/client/runtime/library";

const router = Router();
const PROJECTS_DIR = path.join(process.cwd(), "projects");

const activeTokens = new Set<string>();

function generateToken(): string {
  const token = crypto.randomBytes(32).toString("hex");
  activeTokens.add(token);
  return token;
}

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace("Bearer ", "");
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

// --- Dashboard Stats ---

router.get("/api/stats", async (_req: Request, res: Response) => {
  try {
    const [userCount, projectCount, totalSpent, totalTopups] = await Promise.all([
      prisma.user.count(),
      prisma.project.count(),
      prisma.usageLog.aggregate({ _sum: { costUsd: true } }),
      prisma.payment.aggregate({ _sum: { amountUsd: true }, where: { status: "confirmed" } }),
    ]);

    const recentUsage = await prisma.usageLog.findMany({
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { user: { select: { username: true, firstName: true } }, project: { select: { name: true } } },
    });

    res.json({
      userCount,
      projectCount,
      totalSpent: Number(totalSpent._sum.costUsd || 0),
      totalTopups: Number(totalTopups._sum.amountUsd || 0),
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

router.get("/api/users", async (_req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      include: {
        _count: { select: { projects: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json(users.map(u => ({
      id: u.id,
      telegramId: u.telegramId.toString(),
      username: u.username,
      firstName: u.firstName,
      balance: Number(u.balance),
      projectCount: u._count.projects,
      createdAt: u.createdAt,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/users/:id", async (req: Request<{id: string}>, res: Response) => {
  try {
    const userId = parseInt(req.params.id);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        projects: { orderBy: { updatedAt: "desc" } },
        payments: { orderBy: { createdAt: "desc" }, take: 20 },
        usageLogs: { orderBy: { createdAt: "desc" }, take: 30, include: { project: { select: { name: true } } } },
      },
    });

    if (!user) { res.status(404).json({ error: "User not found" }); return; }

    const totalSpent = await prisma.usageLog.aggregate({
      _sum: { costUsd: true },
      where: { userId },
    });

    res.json({
      id: user.id,
      telegramId: user.telegramId.toString(),
      username: user.username,
      firstName: user.firstName,
      balance: Number(user.balance),
      totalSpent: Number(totalSpent._sum.costUsd || 0),
      createdAt: user.createdAt,
      projects: user.projects.map(p => ({
        id: p.id,
        name: p.name,
        status: p.status,
        botUsername: p.botUsername,
        totalCost: Number(p.totalCostUsd),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      })),
      payments: user.payments.map(p => ({
        id: p.id,
        amount: Number(p.amountUsd),
        status: p.status,
        createdAt: p.createdAt,
        confirmedAt: p.confirmedAt,
      })),
      usageLogs: user.usageLogs.map(l => ({
        id: l.id,
        project: l.project?.name || "-",
        operation: l.operation,
        inputTokens: l.inputTokens,
        outputTokens: l.outputTokens,
        cost: Number(l.costUsd),
        createdAt: l.createdAt,
      })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/users/:id/balance", async (req: Request<{id: string}>, res: Response) => {
  try {
    const userId = parseInt(req.params.id);
    const { action, amount } = req.body;
    const val = parseFloat(amount);
    if (isNaN(val) || val < 0) { res.status(400).json({ error: "Invalid amount" }); return; }

    let updated;
    if (action === "set") {
      updated = await prisma.user.update({ where: { id: userId }, data: { balance: new Decimal(val.toFixed(4)) } });
    } else if (action === "add") {
      updated = await prisma.user.update({ where: { id: userId }, data: { balance: { increment: new Decimal(val.toFixed(4)) } } });
    } else {
      res.status(400).json({ error: "action must be 'set' or 'add'" });
      return;
    }

    res.json({ balance: Number(updated.balance) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Projects ---

router.get("/api/projects", async (_req: Request, res: Response) => {
  try {
    const projects = await prisma.project.findMany({
      include: { user: { select: { username: true, firstName: true } } },
      orderBy: { updatedAt: "desc" },
    });

    res.json(projects.map(p => ({
      id: p.id,
      name: p.name,
      status: p.status,
      owner: p.user.username || p.user.firstName || `User ${p.userId}`,
      userId: p.userId,
      botUsername: p.botUsername,
      totalCost: Number(p.totalCostUsd),
      description: p.description?.substring(0, 120),
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/projects/:id", async (req: Request<{id: string}>, res: Response) => {
  try {
    const projectId = req.params.id;
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      include: { user: { select: { username: true, firstName: true, id: true } } },
    });
    if (!project) { res.status(404).json({ error: "Not found" }); return; }

    res.json({
      id: project.id,
      name: project.name,
      status: project.status,
      description: project.description,
      plan: project.plan,
      projectSummary: project.projectSummary,
      botUsername: project.botUsername,
      totalCost: Number(project.totalCostUsd),
      owner: project.user.username || project.user.firstName || `User ${project.user.id}`,
      userId: project.userId,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/projects/:id/files", (req: Request<{id: string}>, res: Response) => {
  const projectId = req.params.id;
  const projectDir = path.join(PROJECTS_DIR, projectId);
  if (!fs.existsSync(projectDir)) { res.json({ files: [] }); return; }
  res.json({ files: walkDir(projectDir, projectDir) });
});

router.get("/api/projects/:id/file", (req: Request<{id: string}>, res: Response) => {
  const projectId = req.params.id;
  const filePath = String(req.query.path || "");
  if (!filePath || filePath.includes("..")) { res.status(400).json({ error: "Invalid path" }); return; }
  const fullPath = path.join(PROJECTS_DIR, projectId, filePath);
  if (!fullPath.startsWith(path.join(PROJECTS_DIR, projectId))) { res.status(403).json({ error: "Forbidden" }); return; }
  if (!fs.existsSync(fullPath)) { res.status(404).json({ error: "Not found" }); return; }
  res.json({ content: fs.readFileSync(fullPath, "utf-8") });
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
      maxUses: v.maxUses,
      usedCount: v.usedCount,
      active: v.active,
      createdAt: v.createdAt,
      link: `https://t.me/apps_father_bot?start=${v.code}`,
    })));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/vouchers", async (req: Request, res: Response) => {
  try {
    const { amount, maxUses } = req.body;
    const val = parseFloat(amount);
    const uses = parseInt(maxUses, 10);
    if (isNaN(val) || val <= 0) { res.status(400).json({ error: "Invalid amount" }); return; }
    if (isNaN(uses) || uses <= 0) { res.status(400).json({ error: "Invalid maxUses" }); return; }

    const code = "v_" + crypto.randomBytes(4).toString("hex");
    const voucher = await prisma.voucher.create({
      data: {
        code,
        amountUsd: new Decimal(val.toFixed(4)),
        maxUses: uses,
      },
    });
    res.json({
      id: voucher.id,
      code: voucher.code,
      amountUsd: Number(voucher.amountUsd),
      maxUses: voucher.maxUses,
      usedCount: 0,
      active: true,
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
    const voucher = await prisma.voucher.update({ where: { id }, data });
    res.json({ id: voucher.id, amountUsd: Number(voucher.amountUsd), maxUses: voucher.maxUses, active: voucher.active });
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

router.get("/", (_req: Request, res: Response) => {
  res.type("html").send(ADMIN_HTML);
});


const ADMIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Apps Father — Admin</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0f0f11;--surface:#17171a;--surface2:#1e1e22;--border:#2a2a30;--text:#e4e4e7;--dim:#71717a;--accent:#6366f1;--accent-hover:#818cf8;--green:#22c55e;--red:#ef4444;--yellow:#eab308;--blue:#3b82f6;--radius:8px}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;background:var(--bg);color:var(--text);height:100vh;overflow:hidden}
button{font-family:inherit;cursor:pointer}
input,select{font-family:inherit}

.login{display:flex;align-items:center;justify-content:center;height:100vh;background:var(--bg)}
.login-box{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;width:360px;text-align:center}
.login-box h1{font-size:20px;margin-bottom:4px}
.login-box p{color:var(--dim);font-size:13px;margin-bottom:24px}
.login-box input{width:100%;padding:10px 14px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:14px;outline:none;margin-bottom:16px}
.login-box input:focus{border-color:var(--accent)}
.login-box .btn-login{width:100%;padding:10px;background:var(--accent);color:#fff;border:none;border-radius:var(--radius);font-size:14px;font-weight:600}
.login-box .btn-login:hover{background:var(--accent-hover)}
.login-err{color:var(--red);font-size:12px;margin-top:8px;min-height:16px}

.app{display:flex;height:100vh}
.sidebar{width:220px;background:var(--surface);border-right:1px solid var(--border);display:flex;flex-direction:column;flex-shrink:0}
.sidebar-brand{padding:20px 16px 16px;font-size:15px;font-weight:700;border-bottom:1px solid var(--border);letter-spacing:-0.3px}
.sidebar-brand span{color:var(--accent)}
.sidebar-nav{flex:1;padding:8px}
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:var(--radius);font-size:13px;font-weight:500;color:var(--dim);cursor:pointer;transition:all .15s;border:none;background:none;width:100%;text-align:left}
.nav-item:hover{background:var(--surface2);color:var(--text)}
.nav-item.active{background:var(--accent);color:#fff}
.nav-item .icon{font-size:16px;width:20px;text-align:center}
.sidebar-foot{padding:12px 16px;border-top:1px solid var(--border);font-size:11px;color:var(--dim)}

.content{flex:1;overflow-y:auto;padding:24px 32px}
.page{display:none}
.page.active{display:block}

.page-hdr{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.page-hdr h2{font-size:18px;font-weight:700}
.page-hdr .sub{color:var(--dim);font-size:13px;margin-top:2px}

.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:24px}
.stat-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px 20px}
.stat-card .label{font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--dim);margin-bottom:6px}
.stat-card .value{font-size:26px;font-weight:700}
.stat-card .value.green{color:var(--green)}
.stat-card .value.blue{color:var(--blue)}
.stat-card .value.yellow{color:var(--yellow)}

table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:10px 12px;background:var(--surface);border-bottom:1px solid var(--border);font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--dim);position:sticky;top:0;z-index:1}
td{padding:10px 12px;border-bottom:1px solid var(--border)}
tr:hover td{background:var(--surface2)}
.clickable{cursor:pointer}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
.badge.deployed{background:rgba(34,197,94,.15);color:var(--green)}
.badge.building{background:rgba(234,179,8,.15);color:var(--yellow)}
.badge.error{background:rgba(239,68,68,.15);color:var(--red)}
.badge.created{background:rgba(99,102,241,.15);color:var(--accent)}

.detail-back{display:inline-flex;align-items:center;gap:4px;color:var(--dim);font-size:13px;cursor:pointer;margin-bottom:16px;border:none;background:none;padding:0}
.detail-back:hover{color:var(--text)}

.info-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:20px}
.info-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 18px}
.info-card .lbl{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.info-card .val{font-size:16px;font-weight:600}

.section-title{font-size:14px;font-weight:600;margin:20px 0 10px}

.btn{padding:7px 16px;border-radius:var(--radius);font-size:13px;font-weight:500;border:1px solid var(--border);background:var(--surface);color:var(--text);transition:all .15s}
.btn:hover{background:var(--surface2)}
.btn-primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.btn-primary:hover{background:var(--accent-hover)}
.btn-sm{padding:4px 10px;font-size:12px}

.inline-form{display:flex;gap:8px;align-items:center;margin-bottom:16px}
.inline-form input,.inline-form select{padding:7px 12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:13px;outline:none}
.inline-form input:focus{border-color:var(--accent)}

.config-form{max-width:500px}
.config-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border)}
.config-row .clbl{font-size:13px;font-weight:500}
.config-row .cdesc{font-size:11px;color:var(--dim)}
.config-row input{width:140px;padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);color:var(--text);font-size:13px;text-align:right;outline:none}
.config-row input:focus{border-color:var(--accent)}

.code-viewer{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;margin-top:12px}
.code-files{display:flex;flex-wrap:wrap;gap:4px;padding:8px 12px;border-bottom:1px solid var(--border);background:var(--surface2)}
.code-tab{padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer;color:var(--dim);border:none;background:none}
.code-tab:hover{color:var(--text)}
.code-tab.active{background:var(--accent);color:#fff}
.code-content{padding:12px 16px;font-family:'Cascadia Code','Fira Code','Consolas',monospace;font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-x:auto;max-height:500px;overflow-y:auto;tab-size:2;color:#d4d4d4}

.toast{position:fixed;bottom:20px;right:20px;padding:10px 20px;border-radius:var(--radius);font-size:13px;z-index:1000;animation:slideIn .3s ease;color:#fff}
.toast.ok{background:var(--green)}.toast.err{background:var(--red)}
@keyframes slideIn{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}

.empty-state{text-align:center;padding:48px;color:var(--dim)}
.empty-state .big{font-size:36px;margin-bottom:8px}
</style>
</head>
<body>
<div id="root"></div>
<script>
(function(){
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
let token = localStorage.getItem('af_admin_token');
let currentPage = 'dashboard';
let cache = {};

function api(path, opts = {}) {
  return fetch('/admin/api' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token, ...(opts.headers||{}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(r => {
    if (r.status === 401) { token = null; localStorage.removeItem('af_admin_token'); render(); throw new Error('Unauthorized'); }
    return r.json();
  });
}

function toast(msg, type='ok') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function esc(s) { const d = document.createElement('div'); d.textContent = s||''; return d.innerHTML; }
function fmtDate(d) { return new Date(d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' }); }
function fmtMoney(n) { return '$' + Number(n).toFixed(2); }
function fmtTokens(n) { return n > 999999 ? (n/1000000).toFixed(1)+'M' : n > 999 ? (n/1000).toFixed(0)+'K' : n; }
function statusBadge(s) { return '<span class="badge '+s+'">'+s+'</span>'; }

function render() {
  if (!token) { renderLogin(); return; }
  renderApp();
}

function renderLogin() {
  $('#root').innerHTML = '<div class="login"><div class="login-box"><h1>Apps Father</h1><p>Admin Panel</p><input type="password" id="pw" placeholder="Password" /><button class="btn-login" id="login-btn">Sign In</button><div class="login-err" id="login-err"></div></div></div>';
  const pw = $('#pw');
  const btn = $('#login-btn');
  const err = $('#login-err');
  pw.focus();
  pw.addEventListener('keydown', e => { if (e.key==='Enter') doLogin(); });
  btn.addEventListener('click', doLogin);
  function doLogin() {
    err.textContent = '';
    fetch('/admin/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({password:pw.value}) })
      .then(r => r.json()).then(d => {
        if (d.token) { token = d.token; localStorage.setItem('af_admin_token', token); render(); }
        else { err.textContent = d.error || 'Login failed'; pw.value=''; pw.focus(); }
      }).catch(() => { err.textContent = 'Connection failed'; });
  }
}

function renderApp() {
  $('#root').innerHTML = \`
  <div class="app">
    <div class="sidebar">
      <div class="sidebar-brand">Apps <span>Father</span></div>
      <div class="sidebar-nav">
        <button class="nav-item active" data-page="dashboard"><span class="icon">📊</span> Dashboard</button>
        <button class="nav-item" data-page="users"><span class="icon">👤</span> Users</button>
        <button class="nav-item" data-page="projects"><span class="icon">📁</span> Projects</button>
        <button class="nav-item" data-page="vouchers"><span class="icon">🎟️</span> Vouchers</button>
        <button class="nav-item" data-page="config"><span class="icon">⚙️</span> Configuration</button>
      </div>
      <div class="sidebar-foot">
        <button class="nav-item" id="logout-btn"><span class="icon">🚪</span> Logout</button>
      </div>
    </div>
    <div class="content">
      <div class="page active" id="page-dashboard"></div>
      <div class="page" id="page-users"></div>
      <div class="page" id="page-projects"></div>
      <div class="page" id="page-vouchers"></div>
      <div class="page" id="page-config"></div>
    </div>
  </div>\`;

  $$('.nav-item[data-page]').forEach(el => el.addEventListener('click', () => navigate(el.dataset.page)));
  $('#logout-btn').addEventListener('click', () => { token=null; localStorage.removeItem('af_admin_token'); render(); });
  loadPage('dashboard');
}

function navigate(page) {
  currentPage = page;
  $$('.nav-item[data-page]').forEach(el => el.classList.toggle('active', el.dataset.page===page));
  $$('.page').forEach(el => el.classList.toggle('active', el.id==='page-'+page));
  loadPage(page);
}

function loadPage(page) {
  switch(page) {
    case 'dashboard': loadDashboard(); break;
    case 'users': loadUsers(); break;
    case 'projects': loadProjects(); break;
    case 'vouchers': loadVouchers(); break;
    case 'config': loadConfig(); break;
  }
}

// === DASHBOARD ===
function loadDashboard() {
  const el = $('#page-dashboard');
  el.innerHTML = '<div class="page-hdr"><div><h2>Dashboard</h2><div class="sub">Overview of your platform</div></div></div><div class="stats-grid" id="dash-stats"></div><div class="section-title">Recent Activity</div><div id="dash-activity"></div>';
  api('/stats').then(d => {
    $('#dash-stats').innerHTML = \`
      <div class="stat-card"><div class="label">Users</div><div class="value blue">\${d.userCount}</div></div>
      <div class="stat-card"><div class="label">Projects</div><div class="value">\${d.projectCount}</div></div>
      <div class="stat-card"><div class="label">Total Revenue</div><div class="value green">\${fmtMoney(d.totalTopups)}</div></div>
      <div class="stat-card"><div class="label">Total Spent</div><div class="value yellow">\${fmtMoney(d.totalSpent)}</div></div>
    \`;
    if (!d.recentUsage.length) { $('#dash-activity').innerHTML = '<div class="empty-state"><div class="big">📭</div>No activity yet</div>'; return; }
    $('#dash-activity').innerHTML = '<table><thead><tr><th>User</th><th>Project</th><th>Operation</th><th>Tokens</th><th>Cost</th><th>Date</th></tr></thead><tbody>' +
      d.recentUsage.map(u => '<tr><td>'+esc(u.username)+'</td><td>'+esc(u.project)+'</td><td>'+u.operation+'</td><td>'+fmtTokens(u.inputTokens)+' / '+fmtTokens(u.outputTokens)+'</td><td>'+fmtMoney(u.cost)+'</td><td>'+fmtDate(u.createdAt)+'</td></tr>').join('') +
      '</tbody></table>';
  });
}

// === USERS ===
function loadUsers() {
  const el = $('#page-users');
  el.innerHTML = '<div class="page-hdr"><div><h2>Users</h2><div class="sub">All registered users</div></div></div><div id="users-content"></div>';
  api('/users').then(users => {
    if (!users.length) { $('#users-content').innerHTML = '<div class="empty-state"><div class="big">👥</div>No users yet</div>'; return; }
    $('#users-content').innerHTML = '<table><thead><tr><th>ID</th><th>Username</th><th>Name</th><th>Balance</th><th>Projects</th><th>Joined</th><th></th></tr></thead><tbody>' +
      users.map(u => '<tr class="clickable" data-uid="'+u.id+'"><td>'+u.id+'</td><td>'+esc(u.username||'-')+'</td><td>'+esc(u.firstName||'-')+'</td><td>'+fmtMoney(u.balance)+'</td><td>'+u.projectCount+'</td><td>'+fmtDate(u.createdAt)+'</td><td><button class="btn btn-sm" data-view-user="'+u.id+'">View</button></td></tr>').join('') +
      '</tbody></table>';
    $$('[data-view-user]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); loadUserDetail(b.dataset.viewUser); }));
    $$('tr[data-uid]').forEach(r => r.addEventListener('click', () => loadUserDetail(r.dataset.uid)));
  });
}

function loadUserDetail(userId) {
  const el = $('#page-users');
  api('/users/' + userId).then(u => {
    el.innerHTML = \`
      <button class="detail-back" id="back-users">← Back to Users</button>
      <div class="page-hdr"><div><h2>\${esc(u.username || u.firstName || 'User '+u.id)}</h2><div class="sub">Telegram ID: \${u.telegramId}</div></div></div>
      <div class="info-grid">
        <div class="info-card"><div class="lbl">Balance</div><div class="val" id="bal-val">\${fmtMoney(u.balance)}</div></div>
        <div class="info-card"><div class="lbl">Total Spent</div><div class="val">\${fmtMoney(u.totalSpent)}</div></div>
        <div class="info-card"><div class="lbl">Projects</div><div class="val">\${u.projects.length}</div></div>
      </div>
      <div class="section-title">Balance Management</div>
      <div class="inline-form">
        <select id="bal-action"><option value="set">Set to</option><option value="add">Add</option></select>
        <input type="number" id="bal-amount" placeholder="Amount" step="0.01" style="width:120px" />
        <button class="btn btn-primary btn-sm" id="bal-btn">Apply</button>
      </div>
      <div class="section-title">Projects</div>
      <div id="user-projects"></div>
      <div class="section-title">Usage History</div>
      <div id="user-usage"></div>
    \`;

    $('#back-users').addEventListener('click', () => loadUsers());
    $('#bal-btn').addEventListener('click', () => {
      const action = $('#bal-action').value;
      const amount = $('#bal-amount').value;
      api('/users/'+userId+'/balance', { method:'POST', body:{action,amount} }).then(d => {
        $('#bal-val').textContent = fmtMoney(d.balance);
        $('#bal-amount').value = '';
        toast('Balance updated to '+fmtMoney(d.balance));
      }).catch(() => toast('Failed','err'));
    });

    if (u.projects.length) {
      $('#user-projects').innerHTML = '<table><thead><tr><th>Name</th><th>Status</th><th>Bot</th><th>Cost</th><th>Updated</th><th></th></tr></thead><tbody>'+
        u.projects.map(p => '<tr><td>'+esc(p.name)+'</td><td>'+statusBadge(p.status)+'</td><td>'+(p.botUsername?'@'+esc(p.botUsername):'-')+'</td><td>'+fmtMoney(p.totalCost)+'</td><td>'+fmtDate(p.updatedAt)+'</td><td><button class="btn btn-sm" data-view-proj="'+p.id+'">View</button></td></tr>').join('')+
        '</tbody></table>';
      $$('[data-view-proj]').forEach(b => b.addEventListener('click', () => { navigate('projects'); loadProjectDetail(b.dataset.viewProj); }));
    } else {
      $('#user-projects').innerHTML = '<div class="empty-state">No projects</div>';
    }

    if (u.usageLogs.length) {
      $('#user-usage').innerHTML = '<table><thead><tr><th>Project</th><th>Operation</th><th>In / Out</th><th>Cost</th><th>Date</th></tr></thead><tbody>'+
        u.usageLogs.map(l => '<tr><td>'+esc(l.project)+'</td><td>'+l.operation+'</td><td>'+fmtTokens(l.inputTokens)+' / '+fmtTokens(l.outputTokens)+'</td><td>'+fmtMoney(l.cost)+'</td><td>'+fmtDate(l.createdAt)+'</td></tr>').join('')+
        '</tbody></table>';
    } else {
      $('#user-usage').innerHTML = '<div class="empty-state">No usage history</div>';
    }
  });
}

// === PROJECTS ===
function loadProjects() {
  const el = $('#page-projects');
  el.innerHTML = '<div class="page-hdr"><div><h2>Projects</h2><div class="sub">All projects across users</div></div></div><div id="projects-content"></div>';
  api('/projects').then(projects => {
    if (!projects.length) { $('#projects-content').innerHTML = '<div class="empty-state"><div class="big">📁</div>No projects yet</div>'; return; }
    $('#projects-content').innerHTML = '<table><thead><tr><th>Name</th><th>Owner</th><th>Status</th><th>Bot</th><th>Cost</th><th>Updated</th><th></th></tr></thead><tbody>' +
      projects.map(p => '<tr class="clickable" data-pid="'+p.id+'"><td>'+esc(p.name)+'</td><td>'+esc(p.owner)+'</td><td>'+statusBadge(p.status)+'</td><td>'+(p.botUsername?'@'+esc(p.botUsername):'-')+'</td><td>'+fmtMoney(p.totalCost)+'</td><td>'+fmtDate(p.updatedAt)+'</td><td><button class="btn btn-sm" data-view-proj="'+p.id+'">View</button></td></tr>').join('') +
      '</tbody></table>';
    $$('[data-view-proj]').forEach(b => b.addEventListener('click', e => { e.stopPropagation(); loadProjectDetail(b.dataset.viewProj); }));
    $$('tr[data-pid]').forEach(r => r.addEventListener('click', () => loadProjectDetail(r.dataset.pid)));
  });
}

function loadProjectDetail(projectId) {
  const el = $('#page-projects');
  Promise.all([
    api('/projects/' + projectId),
    api('/projects/' + projectId + '/files'),
  ]).then(([p, filesData]) => {
    const files = filesData.files || [];
    el.innerHTML = \`
      <button class="detail-back" id="back-projects">← Back to Projects</button>
      <div class="page-hdr"><div><h2>\${esc(p.name)}</h2><div class="sub">\${p.id}</div></div><div style="display:flex;gap:8px"><a class="btn btn-sm" href="/editor/\${p.id}/" target="_blank">Open Editor</a><a class="btn btn-sm" href="/app/\${p.id}/" target="_blank">Open App</a></div></div>
      <div class="info-grid">
        <div class="info-card"><div class="lbl">Status</div><div class="val">\${statusBadge(p.status)}</div></div>
        <div class="info-card"><div class="lbl">Owner</div><div class="val">\${esc(p.owner)}</div></div>
        <div class="info-card"><div class="lbl">Total Cost</div><div class="val">\${fmtMoney(p.totalCost)}</div></div>
        <div class="info-card"><div class="lbl">Bot</div><div class="val">\${p.botUsername ? '@'+esc(p.botUsername) : '-'}</div></div>
        <div class="info-card"><div class="lbl">Created</div><div class="val" style="font-size:13px">\${fmtDate(p.createdAt)}</div></div>
        <div class="info-card"><div class="lbl">Updated</div><div class="val" style="font-size:13px">\${fmtDate(p.updatedAt)}</div></div>
      </div>
      \${p.description ? '<div class="section-title">Description</div><div style="color:var(--dim);font-size:13px;margin-bottom:12px">'+esc(p.description)+'</div>' : ''}
      <div class="section-title">Status Management</div>
      <div class="inline-form">
        <select id="status-sel"><option value="created">created</option><option value="building">building</option><option value="deployed">deployed</option><option value="error">error</option></select>
        <button class="btn btn-primary btn-sm" id="status-btn">Update Status</button>
      </div>
      <div class="section-title">Code (\${files.length} files)</div>
      <div class="code-viewer" id="code-viewer">
        <div class="code-files" id="code-tabs">\${files.map((f,i) => '<button class="code-tab'+(i===0?' active':'')+'" data-fpath="'+f.path+'">'+esc(f.name)+'</button>').join('')}</div>
        <pre class="code-content" id="code-pre">Loading...</pre>
      </div>
      \${p.projectSummary ? '<div class="section-title">AI Summary</div><div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:14px 18px;font-size:13px;white-space:pre-wrap;color:var(--dim);max-height:300px;overflow-y:auto">'+esc(p.projectSummary)+'</div>' : ''}
    \`;

    $('#back-projects').addEventListener('click', () => loadProjects());
    
    const statusSel = $('#status-sel');
    statusSel.value = p.status;
    $('#status-btn').addEventListener('click', () => {
      api('/projects/'+projectId+'/status', { method:'POST', body:{ status: statusSel.value } }).then(() => toast('Status updated'));
    });

    if (files.length > 0) {
      loadProjectFile(projectId, files[0].path);
      $$('.code-tab').forEach(t => t.addEventListener('click', () => {
        $$('.code-tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        loadProjectFile(projectId, t.dataset.fpath);
      }));
    } else {
      $('#code-pre').textContent = '(no files)';
    }
  });
}

function loadProjectFile(projectId, filePath) {
  $('#code-pre').textContent = 'Loading...';
  api('/projects/'+projectId+'/file?path='+encodeURIComponent(filePath)).then(d => {
    $('#code-pre').textContent = d.content;
  }).catch(() => { $('#code-pre').textContent = 'Failed to load file'; });
}

// === VOUCHERS ===
function loadVouchers() {
  const el = $('#page-vouchers');
  el.innerHTML = \`
    <div class="page-hdr"><div><h2>Vouchers</h2><div class="sub">Create and manage voucher codes</div></div></div>
    <div class="section-title">Create Voucher</div>
    <div class="inline-form">
      <input type="number" id="v-amount" placeholder="Amount ($)" step="0.01" style="width:120px" />
      <input type="number" id="v-max" placeholder="Max uses" step="1" value="1" style="width:100px" />
      <button class="btn btn-primary btn-sm" id="v-create">Create</button>
    </div>
    <div class="section-title">All Vouchers</div>
    <div id="vouchers-list"></div>
  \`;

  $('#v-create').addEventListener('click', () => {
    const amount = $('#v-amount').value;
    const maxUses = $('#v-max').value;
    if (!amount || parseFloat(amount) <= 0) { toast('Enter a valid amount','err'); return; }
    api('/vouchers', { method:'POST', body:{ amount, maxUses: maxUses||'1' } }).then(v => {
      toast('Voucher created: '+v.code);
      $('#v-amount').value = '';
      $('#v-max').value = '1';
      refreshVoucherList();
    }).catch(() => toast('Failed to create','err'));
  });

  refreshVoucherList();
}

function refreshVoucherList() {
  api('/vouchers').then(vouchers => {
    const el = $('#vouchers-list');
    if (!vouchers.length) { el.innerHTML = '<div class="empty-state"><div class="big">🎟️</div>No vouchers yet</div>'; return; }
    el.innerHTML = '<table><thead><tr><th>Code</th><th>Amount</th><th>Used / Max</th><th>Status</th><th>Link</th><th>Created</th><th>Actions</th></tr></thead><tbody>' +
      vouchers.map(v => '<tr><td><code>'+esc(v.code)+'</code></td><td>'+fmtMoney(v.amountUsd)+'</td><td>'+v.usedCount+' / '+v.maxUses+'</td><td>'+(v.active ? '<span class="badge deployed">active</span>' : '<span class="badge error">inactive</span>')+'</td><td><button class="btn btn-sm" data-copy-link="'+esc(v.link)+'">Copy</button></td><td>'+fmtDate(v.createdAt)+'</td><td><button class="btn btn-sm" data-toggle-v="'+v.id+'" data-active="'+v.active+'">'+(v.active?'Disable':'Enable')+'</button> <button class="btn btn-sm" style="color:var(--red)" data-del-v="'+v.id+'">Delete</button></td></tr>').join('') +
      '</tbody></table>';

    $$('[data-copy-link]').forEach(b => b.addEventListener('click', () => {
      navigator.clipboard.writeText(b.dataset.copyLink).then(() => toast('Link copied!')).catch(() => {
        const ta = document.createElement('textarea'); ta.value = b.dataset.copyLink; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); toast('Link copied!');
      });
    }));

    $$('[data-toggle-v]').forEach(b => b.addEventListener('click', () => {
      const newActive = b.dataset.active === 'true' ? false : true;
      api('/vouchers/'+b.dataset.toggleV, { method:'PUT', body:{ active: newActive } }).then(() => {
        toast(newActive ? 'Voucher enabled' : 'Voucher disabled');
        refreshVoucherList();
      });
    }));

    $$('[data-del-v]').forEach(b => b.addEventListener('click', () => {
      if (!confirm('Delete this voucher?')) return;
      api('/vouchers/'+b.dataset.delV, { method:'DELETE' }).then(() => {
        toast('Voucher deleted');
        refreshVoucherList();
      }).catch(() => toast('Failed to delete','err'));
    }));
  });
}

// === CONFIG ===
function loadConfig() {
  const el = $('#page-config');
  el.innerHTML = '<div class="page-hdr"><div><h2>Configuration</h2><div class="sub">Runtime pricing and agent settings</div></div></div><div id="config-content"></div>';
  api('/config').then(cfg => {
    const el2 = $('#config-content');
    el2.innerHTML = \`
      <div class="config-form">
        <div class="config-row">
          <div><div class="clbl">Markup Multiplier</div><div class="cdesc">Applied on top of per-model base rates</div></div>
          <input type="number" id="cfg-markupMultiplier" value="\${cfg.markupMultiplier}" step="0.5" />
        </div>
        <div class="config-row">
          <div><div class="clbl">Min Top-up</div><div class="cdesc">Minimum top-up amount (USD)</div></div>
          <input type="number" id="cfg-minTopup" value="\${cfg.minTopup}" step="1" />
        </div>
        <div class="config-row">
          <div><div class="clbl">Max Agent Iterations</div><div class="cdesc">Maximum tool calls per agent run</div></div>
          <input type="number" id="cfg-maxAgentIterations" value="\${cfg.maxAgentIterations}" step="1" />
        </div>
        <div style="margin-top:20px">
          <button class="btn btn-primary" id="cfg-save">Save Configuration</button>
        </div>
      </div>
    \`;

    $('#cfg-save').addEventListener('click', () => {
      const data = {
        markupMultiplier: parseFloat($('#cfg-markupMultiplier').value),
        minTopup: parseFloat($('#cfg-minTopup').value),
        maxAgentIterations: parseInt($('#cfg-maxAgentIterations').value),
      };
      api('/config', { method:'POST', body:data }).then(() => toast('Configuration saved'));
    });
  });
}

render();
})();
</script>
</body>
</html>`;

export default router;
