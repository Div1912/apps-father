import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { config } from "../../config";
import { prisma } from "../../db";

const router = Router();

// PM2 writes logs to ~/.pm2/logs/<process_name>-out.log / -error.log,
// but in cluster mode adds an instance suffix (e.g. -out-0.log), and the
// process name differs between envs (apps-father vs apps-father-dev).
// We resolve paths in 3 steps:
//   1. explicit env var override
//   2. ask PM2 directly via `pm2 jlist` (most reliable)
//   3. scan PM2 logs dir with a permissive regex
const PM2_LOG_DIR = process.env.PM2_LOG_DIR || path.join(os.homedir(), ".pm2", "logs");

function findPm2LogsViaJlist(): { out: string; err: string } | null {
  try {
    const stdout = execSync("pm2 jlist", { encoding: "utf8", timeout: 3000 });
    const procs = JSON.parse(stdout);
    if (!Array.isArray(procs) || procs.length === 0) return null;
    const wanted =
      procs.find((p: any) => typeof p?.name === "string" && p.name.includes("apps-father")) ||
      procs[0];
    const env = wanted?.pm2_env;
    if (!env) return null;
    return {
      out: typeof env.pm_out_log_path === "string" ? env.pm_out_log_path : "",
      err: typeof env.pm_err_log_path === "string" ? env.pm_err_log_path : "",
    };
  } catch {
    return null;
  }
}

function findPm2LogViaScan(suffix: "out" | "error"): string {
  try {
    if (!fs.existsSync(PM2_LOG_DIR)) return "";
    // Match both `-out.log` and cluster-mode `-out-0.log` etc.
    const re = suffix === "out" ? /-out(-\d+)?\.log$/ : /-error(-\d+)?\.log$/;
    const all = fs
      .readdirSync(PM2_LOG_DIR)
      .filter((f) => re.test(f))
      .map((f) => {
        const full = path.join(PM2_LOG_DIR, f);
        try {
          const stat = fs.statSync(full);
          return { full, name: f, mtime: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a: any, b: any) => b.mtime - a.mtime) as { full: string; name: string; mtime: number }[];
    if (all.length === 0) return "";
    // Prefer files whose name mentions our app, otherwise take the most recent.
    const preferred = all.find((c) => c.name.includes("apps-father"));
    return (preferred || all[0]).full;
  } catch {
    return "";
  }
}

function findPm2Log(suffix: "out" | "error"): string {
  const explicit = suffix === "out" ? process.env.PM2_OUT_LOG : process.env.PM2_ERR_LOG;
  if (explicit) return explicit;
  const viaJlist = findPm2LogsViaJlist();
  if (viaJlist) {
    const candidate = suffix === "out" ? viaJlist.out : viaJlist.err;
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return findPm2LogViaScan(suffix);
}

export function getOutLog(): string { return findPm2Log("out"); }
export function getErrLog(): string { return findPm2Log("error"); }

/** Read the tail (last N lines) of a log file. Caps the read at 512 KB so
 *  enormous log files still respond quickly. Returns an array of trimmed
 *  lines from oldest → newest. */
export function readTailLines(filePath: string, lines: number): string[] {
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    const stat = fs.statSync(filePath);
    const chunkSize = Math.min(stat.size, 512 * 1024);
    const buf = Buffer.alloc(chunkSize);
    const fd = fs.openSync(filePath, "r");
    fs.readSync(fd, buf, 0, chunkSize, stat.size - chunkSize);
    fs.closeSync(fd);
    return buf.toString("utf8").split("\n").filter((l) => l.length).slice(-Math.max(1, lines));
  } catch {
    return [];
  }
}

// Simple token auth — use WEBHOOK_SECRET as the token
function isAuthorized(req: Request): boolean {
  const token = req.query.token as string;
  return token === config.webhookSecret;
}

// Serve the log viewer HTML page
router.get("/", (req: Request, res: Response) => {
  if (!isAuthorized(req)) {
    res.status(401).send("Unauthorized");
    return;
  }

  const token = req.query.token as string;

  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Apps Father — Logs</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; color: #e6edf3; font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 13px; height: 100vh; display: flex; flex-direction: column; }

  header {
    background: #161b22;
    border-bottom: 1px solid #30363d;
    padding: 12px 20px;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }
  header h1 { font-size: 15px; font-weight: 600; color: #f0f6fc; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 12px; background: #21262d; color: #8b949e; border: 1px solid #30363d; }
  .badge.live { background: #0d3b1e; color: #3fb950; border-color: #238636; }
  .spacer { flex: 1; }

  .controls { display: flex; gap: 8px; align-items: center; }
  button {
    padding: 5px 12px; border-radius: 6px; border: 1px solid #30363d;
    background: #21262d; color: #e6edf3; cursor: pointer; font-size: 12px;
    transition: background 0.15s;
  }
  button:hover { background: #30363d; }
  button.active { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  input[type=text], select {
    padding: 5px 10px; border-radius: 6px; border: 1px solid #30363d;
    background: #0d1117; color: #e6edf3; font-size: 12px;
    font-family: inherit;
  }
  input[type=text] { width: 200px; }
  select { width: 220px; cursor: pointer; }
  input::placeholder { color: #484f58; }

  .tabs { display: flex; gap: 1px; padding: 0 20px; background: #161b22; border-bottom: 1px solid #30363d; flex-shrink: 0; align-items: center; }
  .tab { padding: 8px 16px; cursor: pointer; color: #8b949e; font-size: 12px; border-bottom: 2px solid transparent; transition: all 0.15s; }
  .tab:hover { color: #e6edf3; }
  .tab.active { color: #f0f6fc; border-bottom-color: #1f6feb; }
  .tab-spacer { flex: 1; }
  .tabs select { margin: 4px 0; }

  .pid-tag {
    display: inline-block; padding: 0 6px; border-radius: 10px; font-size: 10px;
    background: #1f2a3a; color: #79c0ff; border: 1px solid #30404f; margin-right: 6px;
    white-space: nowrap;
  }
  .pid-tag.core { background: #2a1f3a; color: #d2a8ff; border-color: #3f304f; }

  #log-container { flex: 1; overflow-y: auto; padding: 12px 20px; }
  .log-line { padding: 1px 0; line-height: 1.6; white-space: pre-wrap; word-break: break-all; display: flex; gap: 12px; }
  .log-line .ts { color: #484f58; flex-shrink: 0; font-size: 11px; padding-top: 1px; }
  .log-line .msg { flex: 1; }
  .log-line.out .msg { color: #e6edf3; }
  .log-line.err .msg { color: #ff7b72; }
  .log-line.err.agent .msg { color: #d2a8ff; }
  .log-line.info .msg { color: #79c0ff; }
  .log-line.warn .msg { color: #e3b341; }
  .log-line.success .msg { color: #3fb950; }
  .log-line.hidden { display: none; }

  .empty { color: #484f58; text-align: center; padding: 60px 0; }
</style>
</head>
<body>
<header>
  <h1>⚡ Apps Father Logs</h1>
  <span class="badge live" id="status-badge">● LIVE</span>
  <span class="badge" id="count-badge">0 lines</span>
  <div class="spacer"></div>
  <div class="controls">
    <input type="text" id="filter" placeholder="Filter logs..." oninput="applyFilter()">
    <button onclick="clearLogs()">Clear</button>
    <button id="scroll-btn" class="active" onclick="toggleScroll()">Auto-scroll</button>
  </div>
</header>
<div class="tabs">
  <div class="tab active" onclick="setTab('all')">All</div>
  <div class="tab" onclick="setTab('out')">stdout</div>
  <div class="tab" onclick="setTab('err')">stderr</div>
  <div class="tab" onclick="setTab('agent')">Agent</div>
  <div class="tab" onclick="setTab('bot')">Bot</div>
  <div class="tab-spacer"></div>
  <select id="project-select" onchange="applyFilter()">
    <option value="all">All sources</option>
    <option value="__core__">Apps Father (core)</option>
  </select>
</div>
<div id="log-container"><div class="empty">Connecting to log stream...</div></div>

<script>
let autoScroll = true;
let currentTab = 'all';
let filterText = '';
let lineCount = 0;
const container = document.getElementById('log-container');
const projectSelect = document.getElementById('project-select');

// Map of projectId -> display name. Populated lazily from /logs/projects and
// extended on the fly when previously-unseen project tags appear in the stream.
const projectNames = {};
const seenProjectIds = new Set();

const APP_TAG_RE = /^\\[app:([A-Za-z0-9_\\-]+)\\]\\s?(.*)$/;

function shortId(id) {
  return id && id.length > 12 ? id.slice(0, 8) : id;
}

function parseAppTag(text) {
  const m = APP_TAG_RE.exec(text);
  if (!m) return { projectId: null, body: text };
  return { projectId: m[1], body: m[2] };
}

function ensureProjectOption(projectId) {
  if (!projectId || seenProjectIds.has(projectId)) return;
  seenProjectIds.add(projectId);
  const opt = document.createElement('option');
  opt.value = projectId;
  const name = projectNames[projectId];
  opt.textContent = name ? (name + ' (' + shortId(projectId) + ')') : shortId(projectId);
  projectSelect.appendChild(opt);
}

function refreshProjectOptionLabels() {
  for (const opt of projectSelect.options) {
    const id = opt.value;
    if (id === 'all' || id === '__core__') continue;
    const name = projectNames[id];
    opt.textContent = name ? (name + ' (' + shortId(id) + ')') : shortId(id);
  }
}

function classify(text, source) {
  const t = text.toLowerCase();
  if (source === 'err') {
    if (t.includes('[agent]')) return 'err agent';
    return 'err';
  }
  if (t.includes('✅') || t.includes('started') || t.includes('loaded') || t.includes('connected')) return 'out success';
  if (t.includes('warn') || t.includes('warning')) return 'out warn';
  if (t.includes('[bot]') || t.includes('[botrunner]')) return 'out info';
  if (t.includes('[agent]')) return 'out agent';
  return 'out';
}

function tabMatch(cls) {
  if (currentTab === 'all') return true;
  if (currentTab === 'out') return cls.includes('out') && !cls.includes('err');
  if (currentTab === 'err') return cls.includes('err');
  if (currentTab === 'agent') return cls.includes('agent');
  if (currentTab === 'bot') return cls.includes('info');
  return true;
}

function projectMatch(projectId) {
  const sel = projectSelect.value;
  if (sel === 'all') return true;
  if (sel === '__core__') return !projectId;       // core / apps_father lines (no app tag)
  return projectId === sel;
}

function addLine(text, source, isHistory) {
  const empty = container.querySelector('.empty');
  if (empty) empty.remove();

  lineCount++;
  document.getElementById('count-badge').textContent = lineCount + ' lines';

  const { projectId, body } = parseAppTag(text);
  if (projectId) ensureProjectOption(projectId);

  const cls = classify(body, source);
  const now = new Date();
  const ts = now.toTimeString().slice(0,8);

  const div = document.createElement('div');
  div.className = 'log-line ' + cls + (isHistory ? ' history' : '');
  div.dataset.source = source;
  div.dataset.text = body.toLowerCase();
  div.dataset.projectId = projectId || '';

  const tsSpan = document.createElement('span');
  tsSpan.className = 'ts';
  tsSpan.textContent = ts;

  const msgSpan = document.createElement('span');
  msgSpan.className = 'msg';

  if (projectId) {
    const tag = document.createElement('span');
    tag.className = 'pid-tag';
    const name = projectNames[projectId];
    tag.textContent = name ? name : shortId(projectId);
    tag.title = projectId;
    msgSpan.appendChild(tag);
  } else {
    const tag = document.createElement('span');
    tag.className = 'pid-tag core';
    tag.textContent = 'core';
    tag.title = 'Apps Father (untagged)';
    msgSpan.appendChild(tag);
  }
  msgSpan.appendChild(document.createTextNode(body));

  div.appendChild(tsSpan);
  div.appendChild(msgSpan);

  const hidden = !tabMatch(cls)
    || !projectMatch(projectId)
    || (filterText && !body.toLowerCase().includes(filterText));
  if (hidden) div.classList.add('hidden');

  container.appendChild(div);

  if (autoScroll) container.scrollTop = container.scrollHeight;

  // Keep max 2000 lines
  const lines = container.querySelectorAll('.log-line');
  if (lines.length > 2000) lines[0].remove();
}

function setTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab').forEach((t, i) => {
    t.classList.toggle('active', ['all','out','err','agent','bot'][i] === tab);
  });
  applyFilter();
}

function applyFilter() {
  filterText = document.getElementById('filter').value.toLowerCase();
  document.querySelectorAll('.log-line').forEach(div => {
    const cls = div.className;
    const text = div.dataset.text || '';
    const projectId = div.dataset.projectId || null;
    const tabOk = tabMatch(cls);
    const projOk = projectMatch(projectId);
    const filterOk = !filterText || text.includes(filterText);
    div.classList.toggle('hidden', !tabOk || !projOk || !filterOk);
  });
}

// Fetch project name index so the dropdown shows readable names instead of bare IDs.
fetch('/logs/projects?token=${token}')
  .then(r => r.ok ? r.json() : [])
  .then(list => {
    if (!Array.isArray(list)) return;
    for (const p of list) {
      if (p && p.id) projectNames[p.id] = p.name || '';
    }
    refreshProjectOptionLabels();
  })
  .catch(() => {});

function toggleScroll() {
  autoScroll = !autoScroll;
  document.getElementById('scroll-btn').classList.toggle('active', autoScroll);
}

function clearLogs() {
  container.innerHTML = '';
  lineCount = 0;
  document.getElementById('count-badge').textContent = '0 lines';
}

// Connect to SSE stream
const evtSource = new EventSource('/logs/stream?token=${token}');

evtSource.onmessage = (e) => {
  const data = JSON.parse(e.data);
  addLine(data.text, data.source, !!data.history);
};

evtSource.onerror = () => {
  document.getElementById('status-badge').textContent = '● DISCONNECTED';
  document.getElementById('status-badge').className = 'badge';
};

evtSource.onopen = () => {
  document.getElementById('status-badge').textContent = '● LIVE';
  document.getElementById('status-badge').className = 'badge live';
  const empty = container.querySelector('.empty');
  if (empty) empty.textContent = 'Connected. Waiting for logs...';
};

// Stop auto-scroll on manual scroll
container.addEventListener('scroll', () => {
  const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
  if (!atBottom && autoScroll) {
    autoScroll = false;
    document.getElementById('scroll-btn').classList.remove('active');
  }
});
</script>
</body>
</html>`);
});

// SSE stream endpoint — polls both log files every second
router.get("/stream", (req: Request, res: Response) => {
  if (!isAuthorized(req)) {
    res.status(401).end();
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable Nginx buffering
  res.flushHeaders();

  const send = (text: string, source: "out" | "err") => {
    const lines = text.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      res.write(`data: ${JSON.stringify({ text: line, source })}\n\n`);
    }
  };

  // Send last 100 lines of history on connect — read only the tail to avoid loading huge files
  const sendHistory = (filePath: string, source: "out" | "err") => {
    if (!fs.existsSync(filePath)) return;
    try {
      const stat = fs.statSync(filePath);
      const chunkSize = Math.min(stat.size, 128 * 1024); // read at most 128 KB from end
      const buf = Buffer.alloc(chunkSize);
      const fd = fs.openSync(filePath, "r");
      fs.readSync(fd, buf, 0, chunkSize, stat.size - chunkSize);
      fs.closeSync(fd);
      const lines = buf.toString("utf8").split("\n").filter((l) => l.trim()).slice(-100);
      for (const line of lines) {
        res.write(`data: ${JSON.stringify({ text: line, source, history: true })}\n\n`);
      }
    } catch {}
  };

  // Resolve log paths once per connection — handles env differences (apps-father vs apps-father-dev).
  const outLog = getOutLog();
  const errLog = getErrLog();

  // Surface a debug line so the user sees what we're tailing (helps diagnose empty-stream issues).
  const debugInfo = `[logs] tailing out=${outLog || "<none found>"} err=${errLog || "<none found>"} dir=${PM2_LOG_DIR}`;
  res.write(`data: ${JSON.stringify({ text: debugInfo, source: "out", history: true })}\n\n`);

  // If neither path was resolved, show the user what's actually in the dir so they can diagnose.
  if (!outLog && !errLog) {
    try {
      const listing = fs.existsSync(PM2_LOG_DIR)
        ? fs.readdirSync(PM2_LOG_DIR).slice(0, 30).join(", ")
        : "(directory does not exist)";
      const hint = `[logs] dir contents: ${listing || "(empty)"}`;
      res.write(`data: ${JSON.stringify({ text: hint, source: "err", history: true })}\n\n`);
    } catch (e: any) {
      res.write(`data: ${JSON.stringify({ text: `[logs] cannot read dir: ${e?.message || e}`, source: "err", history: true })}\n\n`);
    }
    try {
      const pm2List = execSync("pm2 jlist", { encoding: "utf8", timeout: 3000 });
      const procs = JSON.parse(pm2List);
      const summary = Array.isArray(procs)
        ? procs.map((p: any) => `${p.name}#${p.pm_id}(${p.pm2_env?.status || "?"})`).join(", ")
        : "(unexpected pm2 jlist output)";
      res.write(`data: ${JSON.stringify({ text: `[logs] pm2 processes: ${summary || "(none)"}`, source: "err", history: true })}\n\n`);
    } catch (e: any) {
      res.write(`data: ${JSON.stringify({ text: `[logs] pm2 jlist failed: ${e?.message || e}`, source: "err", history: true })}\n\n`);
    }
  }

  if (outLog) sendHistory(outLog, "out");
  if (errLog) sendHistory(errLog, "err");

  // Send initial ping so client knows the stream is live (even if no history)
  res.write(`: ping\n\n`);

  // Track file positions for polling
  const positions: Record<string, number> = {};
  const getPos = (filePath: string) => {
    if (positions[filePath] !== undefined) return positions[filePath];
    if (!fs.existsSync(filePath)) return 0;
    return fs.statSync(filePath).size;
  };

  if (outLog) positions[outLog] = getPos(outLog);
  if (errLog) positions[errLog] = getPos(errLog);

  const poll = (filePath: string, source: "out" | "err") => {
    if (!filePath || !fs.existsSync(filePath)) return;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size < positions[filePath]) positions[filePath] = 0; // rotated
      if (stat.size === positions[filePath]) return;

      const len = stat.size - positions[filePath];
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(filePath, "r");
      fs.readSync(fd, buf, 0, len, positions[filePath]);
      fs.closeSync(fd);
      positions[filePath] = stat.size;
      send(buf.toString("utf8"), source);
    } catch {}
  };

  let tickCount = 0;
  const interval = setInterval(() => {
    poll(outLog, "out");
    poll(errLog, "err");
    // Send SSE comment ping every ~30s to keep connection alive through proxies
    if (++tickCount % 37 === 0) res.write(`: ping\n\n`);
  }, 800);

  req.on("close", () => {
    clearInterval(interval);
  });
});

// Last N lines endpoint (for initial load)
router.get("/history", (req: Request, res: Response) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const lines = parseInt(req.query.lines as string) || 200;
  const result: { text: string; source: string }[] = [];

  const readTail = (filePath: string, source: string) => {
    if (!fs.existsSync(filePath)) return;
    try {
      const stat = fs.statSync(filePath);
      const chunkSize = Math.min(stat.size, 256 * 1024); // read at most 256 KB from end
      const buf = Buffer.alloc(chunkSize);
      const fd = fs.openSync(filePath, "r");
      fs.readSync(fd, buf, 0, chunkSize, stat.size - chunkSize);
      fs.closeSync(fd);
      const fileLines = buf.toString("utf8").split("\n").filter((l) => l.trim());
      fileLines.slice(-lines).forEach((l) => result.push({ text: l, source }));
    } catch {}
  };

  const outLog = getOutLog();
  const errLog = getErrLog();
  if (outLog) readTail(outLog, "out");
  if (errLog) readTail(errLog, "err");

  res.json(result);
});

// Project name index for the log viewer's project filter dropdown.
// Returns a slim list so the client can show "MyApp (a1b2c3)" instead of bare IDs.
router.get("/projects", async (req: Request, res: Response) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const projects = await prisma.project.findMany({
      select: { id: true, name: true },
      orderBy: { updatedAt: "desc" },
    });
    res.json(projects);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

// Agent log download for a specific commit
router.get("/agent/:projectId/:commitNum", (req: Request, res: Response) => {
  const projectId = req.params.projectId as string;
  const commitNum = req.params.commitNum as string;
  const num = parseInt(commitNum, 10);
  if (isNaN(num)) { res.status(400).send("Invalid commit number"); return; }

  const logFile = path.join(process.cwd(), "projects", projectId, "commits", String(num), "agent.log");
  if (!fs.existsSync(logFile)) {
    res.status(404).send("Log file not found");
    return;
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="agent-commit-${num}.log"`);
  fs.createReadStream(logFile).pipe(res);
});

export default router;
