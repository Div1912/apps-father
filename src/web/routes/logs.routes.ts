import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import { config } from "../../config";

const router = Router();

const OUT_LOG = "/root/.pm2/logs/apps-father-out.log";
const ERR_LOG = "/root/.pm2/logs/apps-father-error.log";

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
  input[type=text] {
    padding: 5px 10px; border-radius: 6px; border: 1px solid #30363d;
    background: #0d1117; color: #e6edf3; font-size: 12px; width: 200px;
    font-family: inherit;
  }
  input::placeholder { color: #484f58; }

  .tabs { display: flex; gap: 1px; padding: 0 20px; background: #161b22; border-bottom: 1px solid #30363d; flex-shrink: 0; }
  .tab { padding: 8px 16px; cursor: pointer; color: #8b949e; font-size: 12px; border-bottom: 2px solid transparent; transition: all 0.15s; }
  .tab:hover { color: #e6edf3; }
  .tab.active { color: #f0f6fc; border-bottom-color: #1f6feb; }

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
</div>
<div id="log-container"><div class="empty">Connecting to log stream...</div></div>

<script>
let autoScroll = true;
let currentTab = 'all';
let filterText = '';
let lineCount = 0;
const container = document.getElementById('log-container');

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

function addLine(text, source, isHistory) {
  const empty = container.querySelector('.empty');
  if (empty) empty.remove();

  lineCount++;
  document.getElementById('count-badge').textContent = lineCount + ' lines';

  const cls = classify(text, source);
  const now = new Date();
  const ts = now.toTimeString().slice(0,8);

  const div = document.createElement('div');
  div.className = 'log-line ' + cls + (isHistory ? ' history' : '');
  div.dataset.source = source;
  div.dataset.text = text.toLowerCase();

  const tsSpan = document.createElement('span');
  tsSpan.className = 'ts';
  tsSpan.textContent = ts;

  const msgSpan = document.createElement('span');
  msgSpan.className = 'msg';
  msgSpan.textContent = text;

  div.appendChild(tsSpan);
  div.appendChild(msgSpan);

  const hidden = !tabMatch(cls) || (filterText && !text.toLowerCase().includes(filterText));
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
    const tabOk = tabMatch(cls);
    const filterOk = !filterText || text.includes(filterText);
    div.classList.toggle('hidden', !tabOk || !filterOk);
  });
}

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

  sendHistory(OUT_LOG, "out");
  sendHistory(ERR_LOG, "err");

  // Send initial ping so client knows the stream is live (even if no history)
  res.write(`: ping\n\n`);

  // Track file positions for polling
  const positions: Record<string, number> = {};
  const getPos = (filePath: string) => {
    if (positions[filePath] !== undefined) return positions[filePath];
    if (!fs.existsSync(filePath)) return 0;
    return fs.statSync(filePath).size;
  };

  positions[OUT_LOG] = getPos(OUT_LOG);
  positions[ERR_LOG] = getPos(ERR_LOG);

  const poll = (filePath: string, source: "out" | "err") => {
    if (!fs.existsSync(filePath)) return;
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
    poll(OUT_LOG, "out");
    poll(ERR_LOG, "err");
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

  readTail(OUT_LOG, "out");
  readTail(ERR_LOG, "err");

  res.json(result);
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
