/* Console modal — interactive shell into a project's Docker container.
 *
 * Usage:
 *   window.ConsoleModal.open(projectId, projectName);
 *
 * Wire-up:
 *   Connects to /admin/api/projects/:projectId/console/ws?token=<adminToken>.
 *   Lazily loads xterm.js and its CSS from a CDN on first open and reuses the
 *   <script> across subsequent invocations.
 *
 * UI contract:
 *   - Opens a fullscreen overlay matching the existing wk-overlay styling.
 *   - Renders an xterm.js terminal sized to the modal body.
 *   - Resends terminal cols/rows as a JSON {type:"resize"} text frame.
 *   - All keystrokes are sent as binary frames (utf-8) to the server.
 *   - All server frames are written verbatim to xterm.write().
 */
(function () {
  "use strict";
  if (window.ConsoleModal) return;

  const XTERM_JS  = "https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js";
  const XTERM_CSS = "https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css";
  const FIT_JS    = "https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js";

  let xtermLoadingPromise = null;

  function loadXterm() {
    if (window.Terminal) return Promise.resolve();
    if (xtermLoadingPromise) return xtermLoadingPromise;
    xtermLoadingPromise = new Promise((resolve, reject) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = XTERM_CSS;
      document.head.appendChild(link);

      const s1 = document.createElement("script");
      s1.src = XTERM_JS;
      s1.onload = () => {
        const s2 = document.createElement("script");
        s2.src = FIT_JS;
        s2.onload = () => resolve();
        s2.onerror = () => reject(new Error("Failed to load xterm-fit"));
        document.head.appendChild(s2);
      };
      s1.onerror = () => reject(new Error("Failed to load xterm.js"));
      document.head.appendChild(s1);
    });
    return xtermLoadingPromise;
  }

  function ensureStyles() {
    if (document.getElementById("af-console-styles")) return;
    const s = document.createElement("style");
    s.id = "af-console-styles";
    s.textContent = `
      .afc-overlay {
        position: fixed; inset: 0; z-index: 2200;
        background: rgba(0,0,0,.72);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        display: flex; align-items: center; justify-content: center;
        padding: 24px;
        animation: wkFadeIn 180ms ease;
      }
      .afc-modal {
        position: relative;
        width: 100%; max-width: 1100px; height: 80vh; max-height: 760px;
        background: #060810;
        border: 1px solid var(--admin-card-border);
        border-radius: 16px;
        box-shadow: 0 32px 80px rgba(0,0,0,.55);
        display: flex; flex-direction: column;
        overflow: hidden;
      }
      .afc-head {
        display: flex; align-items: center; gap: 12px;
        padding: 14px 18px; border-bottom: 1px solid #1a1f2a;
        background: #0a0d15; flex-shrink: 0;
      }
      .afc-head-title {
        flex: 1; min-width: 0;
        font-size: 13px; font-weight: 600; color: #d8e0ec;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .afc-head-status {
        font-size: 10.5px; font-family: monospace;
        padding: 3px 9px; border-radius: 999px;
        background: #1a1f2a; color: #6f7c8c;
        text-transform: uppercase; letter-spacing: .5px;
        flex-shrink: 0;
      }
      .afc-head-status.connected { background: rgba(92,195,119,.18); color: #5cc377; }
      .afc-head-status.error     { background: rgba(255,80,80,.18); color: #ff7777; }
      .afc-close {
        width: 32px; height: 32px; border-radius: 50%;
        background: #1a1f2a; color: #b9c2d0;
        border: 1px solid #232938;
        font-size: 16px; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      }
      .afc-close:hover { background: #232938; color: #fff; }
      .afc-body {
        flex: 1; min-height: 0;
        padding: 8px;
        background: #060810;
      }
      .afc-term {
        width: 100%; height: 100%;
      }
      .afc-foot {
        padding: 8px 18px; border-top: 1px solid #1a1f2a;
        background: #0a0d15;
        font-size: 11px; color: #6f7c8c;
        font-family: monospace;
        display: flex; align-items: center; gap: 14px;
        flex-shrink: 0;
      }
      .afc-foot kbd {
        background: #1a1f2a; color: #b9c2d0;
        border: 1px solid #232938;
        border-radius: 4px;
        padding: 1px 6px;
        font-size: 10px;
        font-family: inherit;
      }
    `;
    document.head.appendChild(s);
  }

  function buildWsUrl(projectId, token) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${window.location.host}/admin/api/projects/${encodeURIComponent(projectId)}/console/ws?token=${encodeURIComponent(token)}`;
  }

  async function open(projectId, projectName) {
    ensureStyles();
    try { await loadXterm(); } catch (err) { alert("Failed to load terminal: " + err.message); return; }

    // Token lives in Api.getToken() (admin/js/api.js).
    const token = (window.Api && Api.getToken && Api.getToken()) || "";
    if (!token) { alert("Admin token missing — please re-login."); return; }

    const overlay = document.createElement("div");
    overlay.className = "afc-overlay";
    overlay.innerHTML = `
      <div class="afc-modal">
        <div class="afc-head">
          <div class="afc-head-title">▣ Console — ${escapeHtml(projectName || projectId.slice(0, 8))}</div>
          <span class="afc-head-status" id="afc-status">connecting…</span>
          <button class="afc-close" id="afc-close" title="Close (or Ctrl+])">✕</button>
        </div>
        <div class="afc-body" id="afc-body">
          <div class="afc-term" id="afc-term"></div>
        </div>
        <div class="afc-foot">
          <span><kbd>Ctrl</kbd>+<kbd>]</kbd> close</span>
          <span style="opacity:.6">Container: <code>afp-${escapeHtml(projectId.slice(0, 18))}…</code> · cwd: <code>/workspace</code> · user: <code>node</code></span>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const statusEl = overlay.querySelector("#afc-status");
    const termEl   = overlay.querySelector("#afc-term");
    const closeEl  = overlay.querySelector("#afc-close");

    const term = new window.Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
      fontSize: 13,
      theme: {
        background: "#060810",
        foreground: "#d8e0ec",
        cursor:     "#5cc377",
      },
      convertEol: true,
      scrollback: 5000,
    });
    const fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(termEl);
    requestAnimationFrame(() => { try { fitAddon.fit(); } catch {} });

    let ws;
    try {
      ws = new WebSocket(buildWsUrl(projectId, token));
    } catch (err) {
      term.write("\x1b[31mConnection failed: " + err.message + "\x1b[0m\r\n");
      return;
    }
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", () => {
      statusEl.textContent = "connecting…";
    });

    ws.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === "status") {
          if (msg.state === "connected") {
            statusEl.textContent = "connected"; statusEl.classList.add("connected");
            // Send initial geometry so PTY-mode upgrades pick it up.
            sendResize();
          } else if (msg.state === "closed") {
            statusEl.textContent = `closed (exit ${msg.exitCode ?? "?"})`;
            statusEl.classList.remove("connected");
          } else if (msg.state === "error") {
            statusEl.textContent = "error";
            statusEl.classList.add("error");
            term.write("\r\n\x1b[31m[error] " + (msg.message || "unknown") + "\x1b[0m\r\n");
          }
        }
        return;
      }
      // Binary stdout/stderr → write straight to xterm.
      const data = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ev.data;
      term.write(data);
    });

    ws.addEventListener("close", (ev) => {
      statusEl.textContent = `closed (${ev.code})`;
      statusEl.classList.remove("connected");
      term.write("\r\n\x1b[2;90m[connection closed]\x1b[0m\r\n");
    });
    ws.addEventListener("error", () => {
      statusEl.textContent = "error";
      statusEl.classList.add("error");
    });

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });

    function sendResize() {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
        } catch { /* ignore */ }
      }
    }

    const onResize = () => {
      try { fitAddon.fit(); } catch {}
      sendResize();
    };
    window.addEventListener("resize", onResize);

    function cleanup() {
      window.removeEventListener("resize", onResize);
      try { ws.close(); } catch {}
      try { term.dispose(); } catch {}
      overlay.remove();
    }

    closeEl.addEventListener("click", cleanup);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(); });
    overlay.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === "]") {
        e.preventDefault();
        cleanup();
      }
    });
    // Capture key events on the terminal too (xterm absorbs keydown).
    termEl.addEventListener("keydown", (e) => {
      if (e.ctrlKey && e.key === "]") {
        e.preventDefault();
        cleanup();
      }
    }, true);

    setTimeout(() => term.focus(), 50);
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  window.ConsoleModal = { open };
})();
