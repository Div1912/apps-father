/* Workers — per-project Node.js worker process manager.
   Shows the live registry (worker mode only). Each row has a project mini-block
   (avatar + name + id). Clicking a row opens a full-screen detail modal. */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>`;

  // ── inject modal styles once ────────────────────────────────────────────
  if (!document.getElementById("wk-modal-styles")) {
    const s = document.createElement("style");
    s.id = "wk-modal-styles";
    s.textContent = `
      .wk-overlay {
        position: fixed; inset: 0; z-index: 2000;
        background: rgba(0,0,0,.65);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        display: flex; align-items: center; justify-content: center;
        padding: 24px;
        animation: wkFadeIn 180ms ease;
      }
      @keyframes wkFadeIn { from { opacity: 0 } to { opacity: 1 } }
      .wk-modal {
        position: relative;
        width: 100%; max-width: 700px; max-height: 90vh;
        background: var(--header-bg-color);
        border: 1px solid var(--admin-card-border);
        border-radius: 20px;
        box-shadow: 0 32px 80px rgba(0,0,0,.55);
        display: flex; flex-direction: column;
        overflow: hidden;
        animation: wkSlideUp 220ms cubic-bezier(.22,.68,0,1.2);
      }
      @keyframes wkSlideUp {
        from { transform: translateY(24px) scale(.97); opacity: 0 }
        to   { transform: translateY(0)    scale(1);   opacity: 1 }
      }
      .wk-modal-head {
        padding: 24px 24px 20px;
        border-bottom: 1px solid var(--admin-divider);
        display: flex; align-items: flex-start; gap: 16px;
        flex-shrink: 0;
      }
      .wk-modal-head-info { flex: 1; min-width: 0; }
      .wk-modal-head-name {
        font-size: 18px; font-weight: 700;
        color: var(--admin-text); line-height: 1.2;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        margin-bottom: 4px;
      }
      .wk-modal-head-id {
        font-size: 11px; font-family: monospace;
        color: var(--admin-muted); letter-spacing: .3px;
        margin-bottom: 8px;
      }
      .wk-modal-head-badges { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      .wk-modal-close {
        width: 32px; height: 32px;
        border-radius: 50%; border: 1px solid var(--admin-card-border);
        background: var(--admin-card-bg); color: var(--admin-muted);
        font-size: 16px; line-height: 1; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center;
        cursor: pointer; transition: background 120ms, color 120ms;
      }
      .wk-modal-close:hover { background: var(--admin-tab-hover-bg); color: var(--admin-text); }
      .wk-modal-body {
        padding: 20px 24px 24px;
        overflow-y: auto;
        flex: 1;
      }
      .wk-kpi-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
        gap: 10px; margin-bottom: 20px;
      }
      .wk-kpi {
        background: var(--admin-card-bg);
        border: 1px solid var(--admin-card-border);
        border-radius: 12px;
        padding: 12px 14px;
      }
      .wk-kpi-label {
        font-size: 10px; font-weight: 600; text-transform: uppercase;
        letter-spacing: .6px; color: var(--admin-muted); margin-bottom: 6px;
      }
      .wk-kpi-value {
        font-size: 20px; font-weight: 700; color: var(--admin-text); line-height: 1.1;
      }
      .wk-kpi-value.sm { font-size: 13px; font-family: monospace; }
      .wk-section-label {
        font-size: 10px; font-weight: 700; text-transform: uppercase;
        letter-spacing: .7px; color: var(--admin-muted);
        margin: 0 0 10px;
      }
      .wk-runtimes {
        display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap;
      }
      .wk-runtime {
        flex: 1; min-width: 140px;
        background: var(--admin-card-bg);
        border: 1px solid var(--admin-card-border);
        border-radius: 12px; padding: 12px 14px;
        display: flex; align-items: center; gap: 10px;
      }
      .wk-runtime.loaded { border-color: rgba(92,195,119,.35); }
      .wk-runtime.failed { border-color: rgba(var(--danger-color-rgb),.35); }
      .wk-runtime-dot {
        width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0;
      }
      .wk-runtime-dot.loaded { background: var(--success-color); box-shadow: 0 0 6px var(--success-color); }
      .wk-runtime-dot.failed { background: var(--danger-text-color); }
      .wk-runtime-dot.none   { background: var(--admin-muted); }
      .wk-runtime-text { flex: 1; }
      .wk-runtime-name { font-size: 12px; font-weight: 600; color: var(--admin-text); }
      .wk-runtime-sub  { font-size: 10px; color: var(--admin-muted); margin-top: 2px; }
      .wk-actions {
        display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 20px;
      }
      .wk-lasterr {
        background: var(--danger-bg-color);
        border: 1px solid rgba(var(--danger-color-rgb),.25);
        border-radius: 10px; padding: 10px 14px;
        font-size: 12px; color: var(--danger-text-color);
        margin-bottom: 20px;
        word-break: break-word;
      }
      .wk-logs-wrap {
        border-radius: 12px;
        overflow: hidden;
        border: 1px solid var(--admin-card-border);
      }
      .wk-logs-head {
        background: var(--table-header-bg-color);
        padding: 8px 14px;
        font-size: 10px; font-weight: 700; text-transform: uppercase;
        letter-spacing: .6px; color: var(--admin-muted);
        border-bottom: 1px solid var(--admin-card-border);
      }
      .wk-logs-body {
        background: #050608;
        height: 280px; overflow-y: auto;
        padding: 10px 0;
        font-family: "JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, monospace;
        font-size: 11.5px; line-height: 1.6;
      }
      .wk-log-line { padding: 0 14px; white-space: pre-wrap; word-break: break-all; }
      .wk-log-line.err { color: #ff7070; }
      .wk-log-line.out { color: #c9d1d9; }
      .wk-log-ts { color: #4a5764; margin-right: 8px; }
      /* Project mini-block in table row */
      .wk-project-cell { display: flex; align-items: center; gap: 10px; }
      .wk-project-info { display: flex; flex-direction: column; gap: 1px; }
      .wk-project-name { font-size: 13px; font-weight: 600; color: var(--admin-text); white-space: nowrap; }
      .wk-project-id { font-size: 10px; font-family: monospace; color: var(--admin-muted); letter-spacing: .3px; }
    `;
    document.head.appendChild(s);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────
  function stateBadge(state) {
    const map = {
      "ready":          ["success", "● ready"],
      "spawning":       ["warn",    "◌ spawning"],
      "stopping":       ["warn",    "◌ stopping"],
      "circuit-broken": ["danger",  "✕ circuit broken"],
      "stopped":        ["",        "◌ stopped"],
    };
    const [cls, label] = map[state] || ["", state || "—"];
    return `<span class="badge ${cls}">${Fmt.escapeHtml(label)}</span>`;
  }

  function fmtUptime(ms) {
    if (ms == null || ms < 0) return "—";
    const s = Math.floor(ms / 1000);
    if (s < 60)   return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m";
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h + "h " + m + "m";
  }

  function fmtRam(bytes) {
    if (bytes == null) return "—";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
  }

  function fmtCpu(pct) {
    if (pct == null) return "—";
    return pct.toFixed(1) + "%";
  }

  function cpuStyle(pct) {
    if (pct == null) return "";
    if (pct >= 80) return "color:var(--danger-text-color);font-weight:700";
    if (pct >= 40) return "color:var(--warning-text-color);font-weight:600";
    return "";
  }

  function renderLogs(lines) {
    if (!lines || !lines.length) {
      return `<div class="wk-log-line out" style="color:var(--admin-muted);padding-top:20px;text-align:center">No logs captured yet.</div>`;
    }
    return lines.map(l => {
      const cls = l.stream === "stderr" ? "err" : "out";
      const ts  = new Date(l.ts).toLocaleTimeString([], { hour12: false });
      return `<div class="wk-log-line ${cls}"><span class="wk-log-ts">${Fmt.escapeHtml(ts)}</span>${Fmt.escapeHtml(l.text)}</div>`;
    }).join("");
  }

  function toast(msg, type) {
    const el = document.createElement("div");
    el.className = "toast " + (type === "success" ? "ok" : type === "error" ? "err" : "info");
    el.textContent = msg;
    const stack = document.getElementById("toast-stack");
    if (stack) { stack.appendChild(el); setTimeout(() => el.remove(), 3500); }
  }

  async function doAction(endpoint, label, btn, onDone) {
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    try {
      await Api.request(endpoint, { method: "POST" });
      toast(label + " done", "success");
      if (onDone) await onDone();
    } catch (err) {
      toast(label + " failed: " + (err.message || err), "error");
      if (btn) { btn.disabled = false; btn.textContent = label; }
    }
  }

  // ── Modal ───────────────────────────────────────────────────────────────
  function openModal(projectId, projectMeta, onAction) {
    // Remove any existing modal
    const existing = document.getElementById("wk-detail-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "wk-overlay";
    overlay.id = "wk-detail-overlay";

    const meta = projectMeta[projectId] || {};
    const name = meta.name || ("Project " + projectId.slice(0, 8));

    overlay.innerHTML = `
      <div class="wk-modal" id="wk-modal-box">
        <div class="wk-modal-head">
          ${Avatar.lazyAvatarHtml({ kind: "project", id: projectId, name, seed: projectId, size: 56 })}
          <div class="wk-modal-head-info">
            <div class="wk-modal-head-name">${Fmt.escapeHtml(name)}</div>
            <div class="wk-modal-head-id">${Fmt.escapeHtml(projectId)}</div>
            <div class="wk-modal-head-badges" id="wk-modal-badges">
              <div class="spinner" style="width:16px;height:16px;border-width:2px"></div>
            </div>
          </div>
          <button class="wk-modal-close" id="wk-modal-close" title="Close">✕</button>
        </div>
        <div class="wk-modal-body" id="wk-modal-body">
          <div class="loading-state" style="padding:40px 0">
            <div class="spinner"></div>Loading worker details…
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    function closeModal() {
      overlay.style.animation = "wkFadeIn 160ms ease reverse";
      setTimeout(() => overlay.remove(), 160);
    }

    overlay.addEventListener("click", e => { if (e.target === overlay) closeModal(); });
    overlay.querySelector("#wk-modal-close").addEventListener("click", closeModal);

    // Fetch worker details
    Api.request("/workers/" + encodeURIComponent(projectId) + "?logs=300")
      .then(data => renderModalBody(data))
      .catch(err => {
        overlay.querySelector("#wk-modal-body").innerHTML =
          `<div class="error-state">${Fmt.escapeHtml(err.message || "Failed to load")}</div>`;
      });

    function renderModalBody(data) {
      const isRunning = data.state === "ready" || data.state === "spawning";

      // Update header badges
      const badgesEl = overlay.querySelector("#wk-modal-badges");
      badgesEl.innerHTML = stateBadge(data.state) +
        (data.pid  ? `<span class="badge">PID ${data.pid}</span>` : "") +
        (data.port ? `<span class="badge">:${data.port}</span>` : "");

      // Runtime chips
      function rtBlock(label, rt) {
        if (!rt) return `
          <div class="wk-runtime">
            <div class="wk-runtime-dot none"></div>
            <div class="wk-runtime-text">
              <div class="wk-runtime-name">${label}</div>
              <div class="wk-runtime-sub">not loaded</div>
            </div>
          </div>`;
        const cls = rt.loaded ? "loaded" : "failed";
        const sub = rt.loaded ? "loaded ✓" : (rt.error ? rt.error.slice(0, 60) : "failed");
        return `
          <div class="wk-runtime ${cls}">
            <div class="wk-runtime-dot ${cls}"></div>
            <div class="wk-runtime-text">
              <div class="wk-runtime-name">${label}</div>
              <div class="wk-runtime-sub" title="${Fmt.escapeHtml(rt.error || '')}">${Fmt.escapeHtml(sub)}</div>
            </div>
          </div>`;
      }

      const ramBytes = data.memRssBytes;
      const ramStyle = ramBytes > 200*1024*1024 ? "color:var(--warning-text-color)" :
                       ramBytes > 400*1024*1024 ? "color:var(--danger-text-color)" : "";

      overlay.querySelector("#wk-modal-body").innerHTML = `
        <!-- KPI grid -->
        <div class="wk-kpi-grid">
          <div class="wk-kpi">
            <div class="wk-kpi-label">Uptime</div>
            <div class="wk-kpi-value">${fmtUptime(data.uptimeMs)}</div>
          </div>
          <div class="wk-kpi">
            <div class="wk-kpi-label">RAM</div>
            <div class="wk-kpi-value" style="${ramStyle}">${fmtRam(data.memRssBytes)}</div>
          </div>
          <div class="wk-kpi">
            <div class="wk-kpi-label">CPU</div>
            <div class="wk-kpi-value" style="${cpuStyle(data.cpuPercent)}">${fmtCpu(data.cpuPercent)}</div>
          </div>
          <div class="wk-kpi">
            <div class="wk-kpi-label">Restarts</div>
            <div class="wk-kpi-value">${data.restartCount ?? 0}</div>
          </div>
          <div class="wk-kpi">
            <div class="wk-kpi-label">Crashes</div>
            <div class="wk-kpi-value ${(data.crashCount || 0) > 0 ? "danger" : ""}">${data.crashCount ?? 0}</div>
          </div>
          <div class="wk-kpi">
            <div class="wk-kpi-label">Linux user</div>
            <div class="wk-kpi-value sm" title="${Fmt.escapeHtml(data.username || '')}">${Fmt.escapeHtml((data.username || "—").slice(0, 18))}</div>
          </div>
        </div>

        <!-- Runtimes -->
        <div class="wk-section-label">Runtimes</div>
        <div class="wk-runtimes">
          ${rtBlock("Release", data.release)}
          ${rtBlock("Development", data.development)}
        </div>

        ${data.lastError ? `
          <div class="wk-lasterr">
            <strong>⚠ Last error:</strong><br>
            ${Fmt.escapeHtml(data.lastError)}
          </div>` : ""}

        <!-- Actions -->
        <div class="wk-section-label">Actions</div>
        <div class="wk-actions">
          ${isRunning ? `<button class="btn btn-danger" id="wk-act-stop">■ Stop worker</button>` : ""}
          <button class="btn" id="wk-act-restart">↺ Restart</button>
          <button class="btn" id="wk-act-reload">⟳ Reload routes</button>
          <button class="btn btn-ghost" id="wk-act-files">📂 Files</button>
          ${data.containerName || (data.username || "").startsWith("afp-") ? `<button class="btn" id="wk-act-console">▣ Console</button>` : ""}
        </div>

        <!-- Logs -->
        <div class="wk-section-label">Process logs <span style="font-weight:400;text-transform:none;letter-spacing:0">(last 300 lines)</span></div>
        <div class="wk-logs-wrap">
          <div class="wk-logs-head">stdout / stderr</div>
          <div class="wk-logs-body" id="wk-logs-out">${renderLogs(data.logs)}</div>
        </div>
      `;

      // Scroll logs to bottom
      const logsEl = overlay.querySelector("#wk-logs-out");
      if (logsEl) requestAnimationFrame(() => { logsEl.scrollTop = logsEl.scrollHeight; });

      const reopen = async () => {
        await onAction();
        closeModal();
        setTimeout(() => openModal(projectId, projectMeta, onAction), 80);
      };
      const closeAndRefresh = async () => { closeModal(); await onAction(); };

      overlay.querySelector("#wk-act-restart").addEventListener("click", e => {
        doAction("/workers/" + encodeURIComponent(projectId) + "/restart", "Restart", e.target, reopen);
      });
      overlay.querySelector("#wk-act-reload").addEventListener("click", e => {
        doAction("/workers/" + encodeURIComponent(projectId) + "/reload", "Reload", e.target, reopen);
      });
      const stopBtn = overlay.querySelector("#wk-act-stop");
      if (stopBtn) stopBtn.addEventListener("click", e => {
        doAction("/workers/" + encodeURIComponent(projectId) + "/stop", "Stop", e.target, closeAndRefresh);
      });

      const filesBtn = overlay.querySelector("#wk-act-files");
      if (filesBtn) filesBtn.addEventListener("click", () => {
        if (window.FilesModal) {
          window.FilesModal.open(
            projectId,
            (projectMeta[projectId] || {}).name,
            { srvPath: `/srv/apps-father/projects/${projectId}/` }
          );
        } else {
          toast("File browser not available", "error");
        }
      });

      const consoleBtn = overlay.querySelector("#wk-act-console");
      if (consoleBtn) consoleBtn.addEventListener("click", () => {
        if (window.ConsoleModal) {
          window.ConsoleModal.open(projectId, name);
        } else {
          toast("Console module not loaded", "error");
        }
      });
    }
  }

  // ── Main page ───────────────────────────────────────────────────────────
  window.AdminPages.workers = {
    title: "Workers",
    icon: ICON,

    render: async function (host, ctx) {
      if (ctx.tab._cleanupWorkers) { ctx.tab._cleanupWorkers(); ctx.tab._cleanupWorkers = null; }

      host.innerHTML = `
        <div class="page-hdr">
          <div>
            <h1>Workers</h1>
            <div class="sub" id="wk-sub">Per-project Node.js worker runtime</div>
          </div>
          <div class="actions">
            <button class="btn btn-sm btn-danger" id="wk-stop-all">Stop all</button>
            <button class="btn btn-sm btn-ghost"  id="wk-refresh">↺ Refresh</button>
          </div>
        </div>

        <div id="wk-mode-warn" style="display:none;margin-bottom:14px;padding:12px 16px;border-radius:10px;background:var(--warning-bg-color);border:1px solid rgba(var(--warning-color-rgb,227,179,65),.3);color:var(--warning-text-color);font-size:13px">
          Worker mode is not active — <code>RUNTIME_MODE</code> is not set to <code>worker</code> on this server.
        </div>

        <div id="wk-content">
          <div class="loading-state"><div class="spinner"></div>Loading workers…</div>
        </div>
      `;

      const content  = host.querySelector("#wk-content");
      const modeWarn = host.querySelector("#wk-mode-warn");
      const sub      = host.querySelector("#wk-sub");

      // Cache of projectId → { name } fetched from API
      const projectMeta = {};

      async function fetchProjectMeta(projectIds) {
        await Promise.allSettled(projectIds.map(async id => {
          if (projectMeta[id]) return;
          try {
            const p = await Api.request("/projects/" + encodeURIComponent(id));
            projectMeta[id] = p || {};
          } catch (_) {
            projectMeta[id] = {};
          }
        }));
      }

      async function load() {
        let data;
        try {
          data = await Api.request("/workers");
        } catch (err) {
          content.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed to load workers")}</div>`;
          return;
        }

        if (data.mode !== "worker" && data.mode !== "docker") {
          modeWarn.style.display = "";
          content.innerHTML = "";
          return;
        }
        modeWarn.style.display = "none";
        // Stash the mode on the page so the modal can decide whether to
        // expose the docker-only "Console" button.
        host.dataset.runtimeMode = data.mode;

        const workers = data.workers || [];
        if (sub) sub.textContent = workers.length + " worker" + (workers.length !== 1 ? "s" : "") + " in registry";

        if (workers.length === 0) {
          content.innerHTML = `
            <div class="empty-state">
              <div style="opacity:.35;width:48px;height:48px">${ICON}</div>
              <div style="font-size:15px;font-weight:600;color:var(--admin-text)">No workers running</div>
              <div style="font-size:13px">Workers start lazily on the first API request or bot webhook.</div>
            </div>`;
          return;
        }

        // Fetch project names in parallel (don't block render)
        fetchProjectMeta(workers.map(w => w.projectId)).then(() => {
          // Update name cells after metadata arrives
          workers.forEach(w => {
            const meta = projectMeta[w.projectId] || {};
            const nameEl = content.querySelector(`[data-wk-name="${CSS.escape(w.projectId)}"]`);
            if (nameEl && meta.name) nameEl.textContent = meta.name;
          });
        });

        content.innerHTML = `
          <div class="tbl-wrap">
            <table class="tbl">
              <thead>
                <tr>
                  <th>Project</th>
                  <th>State</th>
                  <th>Uptime</th>
                  <th>RAM</th>
                  <th>CPU</th>
                  <th style="text-align:center">Restarts</th>
                  <th style="text-align:center">Crashes</th>
                  <th style="text-align:center">Release</th>
                  <th style="text-align:center">Dev</th>
                </tr>
              </thead>
              <tbody id="wk-tbody"></tbody>
            </table>
          </div>`;

        const tbody = content.querySelector("#wk-tbody");

        workers.forEach(w => {
          const meta = projectMeta[w.projectId] || {};
          const displayName = meta.name || ("Project " + w.projectId.slice(0, 8) + "…");

          const relChip = w.release
            ? (w.release.loaded
                ? `<span class="badge success">✓</span>`
                : `<span class="badge danger" title="${Fmt.escapeHtml(w.release.error || '')}">✗</span>`)
            : `<span style="color:var(--admin-muted)">—</span>`;
          const devChip = w.development
            ? (w.development.loaded
                ? `<span class="badge success">✓</span>`
                : `<span class="badge danger" title="${Fmt.escapeHtml(w.development.error || '')}">✗</span>`)
            : `<span style="color:var(--admin-muted)">—</span>`;

          const tr = document.createElement("tr");
          tr.className = "clickable";
          tr.title = "Click to inspect";
          tr.innerHTML = `
            <td>
              <div class="wk-project-cell">
                ${Avatar.lazyAvatarHtml({ kind: "project", id: w.projectId, name: displayName, seed: w.projectId, size: 32 })}
                <div class="wk-project-info">
                  <span class="wk-project-name" data-wk-name="${Fmt.escapeHtml(w.projectId)}">${Fmt.escapeHtml(displayName)}</span>
                  <span class="wk-project-id">${Fmt.escapeHtml(w.projectId.slice(0, 8))}…</span>
                </div>
              </div>
            </td>
            <td>${stateBadge(w.state)}</td>
            <td style="font-size:13px">${fmtUptime(w.uptimeMs)}</td>
            <td style="font-size:13px">${fmtRam(w.memRssBytes)}</td>
            <td style="font-size:13px;${cpuStyle(w.cpuPercent)}">${fmtCpu(w.cpuPercent)}</td>
            <td style="text-align:center;font-size:13px">${w.restartCount ?? 0}</td>
            <td style="text-align:center;font-size:13px;${(w.crashCount || 0) > 0 ? "color:var(--danger-text-color);font-weight:700" : ""}">${w.crashCount ?? 0}</td>
            <td style="text-align:center">${relChip}</td>
            <td style="text-align:center">${devChip}</td>
          `;

          tr.addEventListener("click", () => openModal(w.projectId, projectMeta, load));
          tbody.appendChild(tr);
        });
      }

      host.querySelector("#wk-refresh").addEventListener("click", load);
      host.querySelector("#wk-stop-all").addEventListener("click", () => {
        if (!confirm("Stop ALL running workers?\nThey will restart lazily on the next request.")) return;
        doAction("/workers/stop-all", "Stop all", host.querySelector("#wk-stop-all"), load);
      });

      await load();

      // Auto-refresh every 4 s — only when no modal is open and tab is visible
      const timer = setInterval(() => {
        const modalOpen = !!document.getElementById("wk-detail-overlay");
        if (!modalOpen && document.visibilityState !== "hidden") load();
      }, 4000);

      ctx.tab._cleanupWorkers = () => {
        clearInterval(timer);
        const m = document.getElementById("wk-detail-overlay");
        if (m) m.remove();
      };
    },
  };
})();
