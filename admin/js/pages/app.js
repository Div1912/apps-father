/* App detail — Phase 3.
 * Header with avatar/name/status + KPI strip + sub-tabs:
 *   • Chat      — agent chat history (with admin system-note composer)
 *   • Settings  — editable name/description/status/features
 *   • Features  — paid features checklist
 *   • Files     — directory tree + read-only viewer (safe for binaries)
 *   • Logs      — persistent runtime logs (DB-backed, scoped to this app)
 *   • Agent     — per-commit JSONL parsed agent decision log
 */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};

  // ─── status select options (mirrors the project lifecycle) ───────────────
  const STATUSES = [
    "created", "planning", "building", "deployed", "released", "error", "archived",
  ];

  window.AdminPages.app = {
    title: "App",
    icon: "",
    render: async function (host, ctx) {
      const projectId = ctx.params && ctx.params.id;
      if (!projectId) {
        host.innerHTML = `<div class="error-state"><div class="big">!</div>Missing project id</div>`;
        return;
      }

      host.innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading app…</div>`;
      let p;
      try { p = await Api.request("/projects/" + projectId); }
      catch (err) {
        host.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed")}</div>`;
        return;
      }

      ctx.tab.title = p.name || "App";
      window.TabBar.refresh();

      // Per-tab sub-tab selection persists between back/forward navigations.
      const subState = (ctx.tab.appDetailState = ctx.tab.appDetailState || {});
      if (!subState[projectId]) subState[projectId] = { activeSub: "chat" };
      const localState = subState[projectId];

      host.innerHTML = `
        <div class="page-hdr">
          <div style="display:flex;align-items:center;gap:14px">
            ${Avatar.lazyAvatarHtml({ kind: "project", id: p.id, name: p.name, seed: p.id, size: 56 })}
            <div>
              <h1 style="margin-bottom:4px">${Fmt.escapeHtml(p.name)}</h1>
              <div class="sub" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
                ${Fmt.statusBadge(p.status)}
                <code style="color:var(--admin-muted);font-size:11px">${Fmt.escapeHtml(p.id)}</code>
                ${p.botUsername ? `<a href="https://t.me/${encodeURIComponent(p.botUsername)}" target="_blank" rel="noopener">@${Fmt.escapeHtml(p.botUsername)}</a>` : ""}
                · owner <a href="#" id="open-owner">${Fmt.escapeHtml(p.owner)}</a>
              </div>
            </div>
          </div>
          <div class="actions">
            <a class="btn btn-sm" href="/editor/${encodeURIComponent(p.id)}/" target="_blank">Open editor</a>
            <a class="btn btn-sm" href="/app/${encodeURIComponent(p.id)}/" target="_blank">Open app</a>
            <button class="btn btn-sm btn-ghost" id="copy-id">Copy ID</button>
          </div>
        </div>

        <div class="kpi-grid">
          <div class="kpi-card"><div class="label">Total Cost (USD)</div><div class="value warn" style="font-size:13px">${Fmt.money(p.totalCost, 4)}</div></div>
          <div class="kpi-card"><div class="label">Created</div><div class="value" style="font-size:13px">${Fmt.escapeHtml(Fmt.relativeTime(p.createdAt))}</div></div>
          <div class="kpi-card"><div class="label">Last Update</div><div class="value" style="font-size:13px">${Fmt.escapeHtml(Fmt.relativeTime(p.updatedAt))}</div></div>
        </div>

        <div class="subtabs" id="app-subtabs">
          <button class="subtab" data-sub="chat">Chat</button>
          <button class="subtab" data-sub="settings">Settings</button>
          <button class="subtab" data-sub="features">Features</button>
          <button class="subtab" data-sub="files">Files</button>
          <button class="subtab" data-sub="logs">Logs</button>
          <button class="subtab" data-sub="agent">Agent</button>
        </div>

        <div id="app-sub-host" class="subtab-host"></div>
      `;

      host.querySelector("#open-owner").addEventListener("click", e => {
        e.preventDefault();
        if (e.metaKey || e.ctrlKey) {
          window.TabBar.openTab({ pageKey: "user", params: { id: p.ownerId }, focus: false, reuseSamePage: false });
        } else {
          ctx.push({ pageKey: "user", params: { id: p.ownerId } });
        }
      });

      host.querySelector("#copy-id").addEventListener("click", () => {
        Fmt.copyToClipboard(p.id).then(() => Fmt.toast("Project ID copied", "ok"));
      });

      const subTabsEl = host.querySelector("#app-subtabs");
      const subHost   = host.querySelector("#app-sub-host");

      function renderSub(key) {
        localState.activeSub = key;
        subTabsEl.querySelectorAll("[data-sub]").forEach(b => {
          b.classList.toggle("active", b.dataset.sub === key);
        });
        if      (key === "chat")     renderChat(subHost, p, ctx);
        else if (key === "settings") renderSettings(subHost, p, ctx, async () => {
          const fresh = await Api.request("/projects/" + projectId);
          Object.assign(p, fresh);
          renderSettings(subHost, p, ctx, () => {});
        });
        else if (key === "features") renderFeatures(subHost, p, async () => {
          const fresh = await Api.request("/projects/" + projectId);
          Object.assign(p, fresh);
        });
        else if (key === "files")    renderFiles(subHost, p);
        else if (key === "logs")     renderRuntimeLogs(subHost, p, ctx);
        else if (key === "agent")    renderAgentLogs(subHost, p);
      }

      subTabsEl.querySelectorAll("[data-sub]").forEach(b => {
        b.addEventListener("click", () => renderSub(b.dataset.sub));
      });

      renderSub(localState.activeSub || "chat");
    },
  };

  // ────────────────────── Sub-tab: Chat ────────────────────────────────────
  function renderChat(host, p, ctx) {
    host.innerHTML = `
      <div class="chat-shell">
        <div class="chat-toolbar">
          <button class="btn btn-xs" id="chat-refresh">Refresh</button>
          <span style="color:var(--admin-muted);font-size:11px;margin-left:auto" id="chat-meta">—</span>
        </div>
        <div class="chat-messages" id="chat-msgs"><div class="loading-state"><div class="spinner"></div>Loading chat…</div></div>
        <div class="chat-composer">
          <textarea class="input" id="chat-text" placeholder="Send a system note to the user (visible in their chat as [Admin] …)" rows="2"></textarea>
          <button class="btn btn-primary btn-sm" id="chat-send">Send note</button>
        </div>
      </div>
    `;

    const msgsEl = host.querySelector("#chat-msgs");
    const meta   = host.querySelector("#chat-meta");
    const ta     = host.querySelector("#chat-text");
    const sendBtn = host.querySelector("#chat-send");

    async function load() {
      msgsEl.innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading chat…</div>`;
      try {
        const data = await Api.request("/projects/" + p.id + "/chat?limit=200");
        const msgs = data.messages || [];
        meta.textContent = msgs.length ? `${msgs.length} messages` : "no messages";
        if (!msgs.length) {
          msgsEl.innerHTML = `<div class="empty-state"><div class="big">·</div>No messages in this project's history</div>`;
          return;
        }
        msgsEl.innerHTML = msgs.map(renderMsg).join("");
        // auto-scroll to bottom
        requestAnimationFrame(() => { msgsEl.scrollTop = msgsEl.scrollHeight; });
      } catch (err) {
        msgsEl.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed to load")}</div>`;
      }
    }

    host.querySelector("#chat-refresh").addEventListener("click", load);
    sendBtn.addEventListener("click", async () => {
      const text = ta.value.trim();
      if (!text) return;
      sendBtn.disabled = true;
      try {
        await Api.request("/projects/" + p.id + "/chat/send", { method: "POST", body: { text } });
        ta.value = "";
        Fmt.toast("System note sent", "ok");
        await load();
      } catch (err) {
        Fmt.toast(err.message || "Send failed", "err");
      } finally {
        sendBtn.disabled = false;
      }
    });

    load();
  }

  function renderMsg(m) {
    const role = m.role || "system";
    const t = m.type || "text";
    const align = role === "user" ? "right" : "left";
    const isErr = t === "error" || t === "balance_error";
    const isProg = t === "progress";
    const ts = m.timestamp ? Fmt.escapeHtml(Fmt.date(m.timestamp)) : "";
    const tagCls = role === "user" ? "user" : (role === "assistant" ? "assistant" : "system");
    let body = "";
    if (isProg) {
      body = `
        <div style="font-size:12px">${Fmt.escapeHtml(m.content || "")}</div>
        <div class="progress"><div class="progress-bar" style="width:${Math.max(0, Math.min(100, m.percent || 0))}%"></div></div>
        <div style="font-size:10px;color:var(--admin-muted);margin-top:4px">${m.percent || 0}%${m.balance != null ? ` · balance $${Number(m.balance).toFixed(2)}` : ""}</div>
      `;
    } else {
      body = `<div style="white-space:pre-wrap;word-break:break-word">${Fmt.escapeHtml(m.content || "")}</div>`;
    }
    return `
      <div class="chat-row ${align}">
        <div class="chat-bubble ${tagCls} ${isErr ? "err" : ""}">
          <div class="chat-meta-line"><span class="chat-role">${Fmt.escapeHtml(role)}</span> · <span style="color:var(--admin-muted)">${Fmt.escapeHtml(t)}</span> · <span style="color:var(--admin-muted)">${ts}</span></div>
          ${body}
          ${m.costUsd != null ? `<div class="chat-cost">cost $${Number(m.costUsd).toFixed(4)}</div>` : ""}
        </div>
      </div>
    `;
  }

  // ────────────────────── Sub-tab: Settings ────────────────────────────────
  function renderSettings(host, p, _ctx, onSaved) {
    host.innerHTML = `
      <div class="settings-grid">
        <div class="card">
          <div class="card-title">Basic</div>
          <div class="form-row"><label>Name</label><input class="input" id="set-name" value="${Fmt.escapeHtml(p.name || "")}"/></div>
          <div class="form-row"><label>Description</label><textarea class="input" id="set-desc" rows="3">${Fmt.escapeHtml(p.description || "")}</textarea></div>
          <div class="form-row"><label>Status</label>
            <select class="select" id="set-status">
              ${STATUSES.map(s => `<option value="${s}" ${p.status === s ? "selected" : ""}>${s}</option>`).join("")}
            </select>
          </div>
          <div class="form-row"><label>Total Cost (USD)</label><input class="input" id="set-cost" type="number" step="0.0001" min="0" value="${Number(p.totalCost || 0)}"/></div>
        </div>

        <div class="card">
          <div class="card-title">Advanced</div>
          <div class="form-row">
            <label>Features (JSON)</label>
            <textarea class="input mono" id="set-features" rows="6">${Fmt.escapeHtml(p.features || "")}</textarea>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Reference</div>
          <div class="kv-row"><span class="k">Bot</span><span class="v">${p.botUsername ? "@" + Fmt.escapeHtml(p.botUsername) : "—"}</span></div>
          <div class="kv-row"><span class="k">Bot user id</span><span class="v"><code>${Fmt.escapeHtml(p.botUserId || "—")}</code></span></div>
          <div class="kv-row"><span class="k">Release commit</span><span class="v">${p.releaseCommit != null ? "#" + p.releaseCommit : "—"}</span></div>
          <div class="kv-row"><span class="k">Created</span><span class="v">${Fmt.escapeHtml(Fmt.date(p.createdAt))}</span></div>
          <div class="kv-row"><span class="k">Updated</span><span class="v">${Fmt.escapeHtml(Fmt.date(p.updatedAt))}</span></div>
        </div>
      </div>

      <div style="margin-top:16px;display:flex;gap:8px;align-items:center">
        <button class="btn btn-primary" id="set-save">Save changes</button>
        <span style="color:var(--admin-muted);font-size:12px" id="set-msg"></span>
      </div>
    `;

    host.querySelector("#set-save").addEventListener("click", async () => {
      const body = {
        name:        host.querySelector("#set-name").value.trim(),
        description: host.querySelector("#set-desc").value,
        status:      host.querySelector("#set-status").value,
        totalCost:   Number(host.querySelector("#set-cost").value),
        features:    host.querySelector("#set-features").value,
      };
      // Validate JSON blobs (allow empty string).
      for (const k of ["features"]) {
        if (body[k] && body[k].trim()) {
          try { JSON.parse(body[k]); }
          catch (err) { Fmt.toast(k + " is not valid JSON", "err"); return; }
        } else {
          body[k] = null;
        }
      }
      try {
        await Api.request("/projects/" + p.id, { method: "PATCH", body });
        Fmt.toast("Project updated", "ok");
        if (onSaved) onSaved();
      } catch (err) {
        Fmt.toast(err.message || "Save failed", "err");
      }
    });
  }

  // ────────────────────── Sub-tab: Features ────────────────────────────────
  // True checklist UI for paid features. Pulls the catalog from the backend
  // (PAID_FEATURES from features.service.ts), renders one row per feature
  // with a checkbox + price + description, and persists via the existing
  // PATCH /projects/:id endpoint.
  async function renderFeatures(host, p, onSaved) {
    host.innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading features…</div>`;
    let catalog = [];
    try {
      const r = await Api.request("/features-catalog");
      catalog = r.features || [];
    } catch (err) {
      host.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed to load")}</div>`;
      return;
    }
    let owned = [];
    try {
      owned = p.features ? JSON.parse(p.features) : [];
      if (!Array.isArray(owned)) owned = [];
    } catch { owned = []; }

    host.innerHTML = `
      <div class="card" style="display:flex;flex-direction:column;gap:0">
        <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">
          <span>Paid Features</span>
          <span style="color:var(--admin-muted);font-size:11px">Toggle and Save — admin override (no charge)</span>
        </div>
        <ul id="ft-list" style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column">
          ${catalog.map(f => `
            <li class="ft-row" data-id="${Fmt.escapeHtml(f.id)}">
              <label class="ft-check">
                <input type="checkbox" data-fid="${Fmt.escapeHtml(f.id)}" ${owned.includes(f.id) ? "checked" : ""}/>
                <span class="ft-box"><span class="ft-tick">✓</span></span>
              </label>
              <div class="ft-text">
                <div class="ft-title-row">
                  <span class="ft-title">${Fmt.escapeHtml(f.label)}</span>
                  <span class="ft-price">$${Number(f.price).toFixed(0)}</span>
                </div>
                <div class="ft-desc">${Fmt.escapeHtml(f.description)}</div>
                <div class="ft-id"><code>${Fmt.escapeHtml(f.id)}</code></div>
              </div>
            </li>
          `).join("")}
        </ul>
        <div style="display:flex;gap:8px;align-items:center;padding:14px 0 4px;border-top:1px solid var(--admin-divider);margin-top:6px">
          <button class="btn btn-primary" id="ft-save">Save features</button>
          <button class="btn btn-ghost" id="ft-clear">Clear all</button>
          <button class="btn btn-ghost" id="ft-all">Grant all</button>
          <span id="ft-msg" style="color:var(--admin-muted);font-size:12px;margin-left:auto"></span>
        </div>
      </div>
    `;

    const list = host.querySelector("#ft-list");
    function getSelected() {
      return [...list.querySelectorAll("input[type=checkbox]")]
        .filter(c => c.checked)
        .map(c => c.dataset.fid);
    }
    host.querySelector("#ft-clear").addEventListener("click", () => {
      list.querySelectorAll("input[type=checkbox]").forEach(c => (c.checked = false));
    });
    host.querySelector("#ft-all").addEventListener("click", () => {
      list.querySelectorAll("input[type=checkbox]").forEach(c => (c.checked = true));
    });
    host.querySelector("#ft-save").addEventListener("click", async () => {
      const sel = getSelected();
      try {
        await Api.request("/projects/" + p.id, {
          method: "PATCH",
          body: { features: JSON.stringify(sel) },
        });
        host.querySelector("#ft-msg").textContent = `Saved · ${sel.length} feature(s) granted`;
        Fmt.toast("Features updated", "ok");
        if (onSaved) onSaved();
      } catch (err) {
        Fmt.toast(err.message || "Failed", "err");
      }
    });
  }

  // ────────────────────── Sub-tab: Files ───────────────────────────────────
  // The legacy in-browser tree is kept around for offline use, but by default
  // we embed an external File Browser instance (configured per environment in
  // the Configuration page, keys: filesBrowserBaseUrl + filesBrowserProjectsRoot).
  // Falls back to the built-in tree if the URL is empty.
  async function renderFiles(host, p) {
    host.innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading file browser…</div>`;
    let cfg = {};
    try { cfg = await Api.request("/config"); } catch { cfg = {}; }
    const base = (cfg.filesBrowserBaseUrl || "").replace(/\/+$/, "");
    const root = (cfg.filesBrowserProjectsRoot || "").replace(/\/+$/, "");

    if (!base || !root) {
      // Configuration missing → render the legacy tree viewer.
      renderFilesLegacy(host, p);
      return;
    }

    // Trailing slash matters: most file-browser implementations interpret
    // "/path" as a download and "/path/" as a directory listing.
    const url = `${base}${root}/${encodeURIComponent(p.id)}/commits/`;
    const tok = Api.getToken();
    const dlHref = "/admin/api/projects/" + encodeURIComponent(p.id) + "/download.zip?dir=development&token=" + encodeURIComponent(tok || "");

    host.innerHTML = `
      <div class="files-iframe-shell">
        <div class="files-iframe-toolbar">
          <span class="files-iframe-label">External file browser</span>
          <code class="files-iframe-url" title="${Fmt.escapeHtml(url)}">${Fmt.escapeHtml(url)}</code>
          <div style="margin-left:auto;display:flex;gap:6px">
            <a class="btn btn-xs btn-ghost" href="${Fmt.escapeHtml(url)}" target="_blank" rel="noopener">Open in new tab ↗</a>
            <a class="btn btn-xs btn-ghost" href="${Fmt.escapeHtml(dlHref)}" target="_blank" rel="noopener">Download ZIP</a>
            <button class="btn btn-xs btn-ghost" id="files-legacy">Built-in tree</button>
          </div>
        </div>
        <iframe id="files-iframe" src="${Fmt.escapeHtml(url)}" referrerpolicy="no-referrer"></iframe>
      </div>
    `;

    host.querySelector("#files-legacy").addEventListener("click", () => renderFilesLegacy(host, p));
  }

  function renderFilesLegacy(host, p) {
    host.innerHTML = `
      <div class="files-shell">
        <div class="files-tree-wrap">
          <div class="card-title" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <span>Files</span>
            <button class="btn btn-xs btn-ghost" id="files-reveal">Copy path</button>
            <button class="btn btn-xs btn-ghost" id="files-open">Open in Explorer</button>
            <a class="btn btn-xs btn-ghost" id="files-download" target="_blank" rel="noopener">Download ZIP</a>
          </div>
          <div class="files-tree" id="files-tree"><div class="loading-state"><div class="spinner"></div>Loading…</div></div>
        </div>
        <div class="files-viewer">
          <div class="card-title" id="files-current">Select a file to preview</div>
          <pre class="file-preview" id="file-preview"><span style="color:var(--admin-muted)">No file selected</span></pre>
        </div>
      </div>
    `;

    const tree    = host.querySelector("#files-tree");
    const preview = host.querySelector("#file-preview");
    const current = host.querySelector("#files-current");

    host.querySelector("#files-reveal").addEventListener("click", async () => {
      try {
        const r = await Api.request("/projects/" + p.id + "/reveal");
        const text = r.developmentDir || r.projectDir || "";
        await Fmt.copyToClipboard(text);
        Fmt.toast("Path copied: " + text, "ok");
      } catch (err) { Fmt.toast(err.message || "Failed", "err"); }
    });

    host.querySelector("#files-open").addEventListener("click", async () => {
      try {
        const r = await Api.request("/projects/" + p.id + "/open-in-explorer", {
          method: "POST",
          body: { dir: "development" },
        });
        if (r.async) {
          Fmt.toast("Open command issued (no confirmation): " + (r.path || ""), "info");
        } else {
          Fmt.toast("Opened on server: " + (r.path || ""), "ok");
        }
      } catch (err) {
        const msg = err && err.message ? err.message : "Failed";
        if (err && err.status === 403) {
          Fmt.toast("Enable allowAdminShell in Configuration first.", "err");
        } else if (err && err.status === 409) {
          try {
            const reveal = await Api.request("/projects/" + p.id + "/reveal");
            await Fmt.copyToClipboard(reveal.developmentDir || reveal.projectDir || "");
          } catch (_) {}
          Fmt.toast(msg + " (path copied to clipboard)", "err");
        } else {
          Fmt.toast(msg, "err");
        }
      }
    });

    const tok = Api.getToken();
    const dlEl = host.querySelector("#files-download");
    dlEl.href = "/admin/api/projects/" + encodeURIComponent(p.id) + "/download.zip?dir=development&token=" + encodeURIComponent(tok || "");
    dlEl.title = "Download the development folder as a ZIP archive";

    Api.request("/projects/" + p.id + "/files").then(data => {
      const files = (data.files || []).sort((a, b) => a.path.localeCompare(b.path));
      if (!files.length) {
        tree.innerHTML = `<div class="empty-state"><div class="big">·</div>No files in development/</div>`;
        return;
      }
      const groups = new Map();
      for (const f of files) {
        const dir = f.path.includes("/") ? f.path.substring(0, f.path.lastIndexOf("/")) : "(root)";
        if (!groups.has(dir)) groups.set(dir, []);
        groups.get(dir).push(f);
      }
      const dirs = [...groups.keys()].sort();
      tree.innerHTML = dirs.map(d => `
        <div class="files-dir">
          <div class="files-dir-title">${Fmt.escapeHtml(d)}</div>
          <ul class="files-list">
            ${groups.get(d).map(f => `<li><button class="files-link" data-path="${Fmt.escapeHtml(f.path)}">${Fmt.escapeHtml(f.name)}</button></li>`).join("")}
          </ul>
        </div>
      `).join("");

      tree.querySelectorAll("button[data-path]").forEach(b => {
        b.addEventListener("click", async () => {
          tree.querySelectorAll("button[data-path]").forEach(x => x.classList.remove("active"));
          b.classList.add("active");
          const fp = b.dataset.path;
          current.textContent = fp;
          preview.textContent = "Loading…";
          try {
            const data = await Api.request("/projects/" + p.id + "/file?path=" + encodeURIComponent(fp));
            if (data.binary) {
              preview.innerHTML = `<span style="color:var(--admin-muted)">[binary file omitted — ${Fmt.escapeHtml(String(data.size))} bytes]</span>`;
            } else {
              preview.textContent = data.content || "";
            }
          } catch (err) {
            preview.innerHTML = `<span style="color:var(--danger-text-color, salmon)">${Fmt.escapeHtml(err.message || "Failed to read")}</span>`;
          }
        });
      });
    }).catch(err => {
      tree.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed")}</div>`;
    });
  }

  // ────────────────────── Sub-tab: Logs (persistent runtime) ───────────────
  // Mounts the shared logs viewer (admin/js/pages/logs.js) pinned to this
  // project's id, so the operator sees only stdout/stderr captured for the
  // current app, with category/level filtering. Backed by `prisma.appLog`.
  function renderRuntimeLogs(host, p, ctx) {
    if (!window.AdminPages || !window.AdminPages.logsViewer) {
      host.innerHTML = `<div class="error-state"><div class="big">!</div>Logs viewer not loaded</div>`;
      return;
    }
    // Persist UI state per (tab, project) so switching sub-tabs doesn't lose
    // filter selections.
    const all = (ctx.tab.runtimeLogsState = ctx.tab.runtimeLogsState || {});
    const state = (all[p.id] = all[p.id] || {});

    host.innerHTML = `<div id="app-runtime-logs"></div>`;
    const handle = window.AdminPages.logsViewer.mount(
      host.querySelector("#app-runtime-logs"),
      { state, lockedProjectId: p.id }
    );
    // Tear down polling when the host is replaced (sub-tab switched).
    const observer = new MutationObserver(() => {
      if (!document.body.contains(host)) {
        handle.destroy();
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ────────────────────── Sub-tab: Agent (per-commit JSONL) ────────────────
  function renderAgentLogs(host, p) {
    host.innerHTML = `
      <div class="app-logs-shell">
        <div class="app-logs-side">
          <div class="card-title">Commits</div>
          <div id="logs-commits"><div class="loading-state"><div class="spinner"></div>Loading…</div></div>
        </div>
        <div class="app-logs-main">
          <div class="card-title" id="logs-title">Select a commit</div>
          <div class="app-logs-content" id="logs-content"><span style="color:var(--admin-muted)">No commit selected</span></div>
        </div>
      </div>
    `;

    const sideEl = host.querySelector("#logs-commits");
    const titleEl = host.querySelector("#logs-title");
    const contentEl = host.querySelector("#logs-content");

    Api.request("/projects/" + p.id + "/logs").then(data => {
      const commits = data.commits || [];
      if (!commits.length) {
        sideEl.innerHTML = `<div class="empty-state"><div class="big">·</div>No commits yet</div>`;
        return;
      }
      sideEl.innerHTML = commits.map(c => `
        <button class="app-logs-commit" data-c="${c.commit}">
          <div class="app-logs-commit-num">#${c.commit}</div>
          <div class="app-logs-commit-meta">
            <div style="font-weight:600">${Fmt.escapeHtml(c.changelog || "(no message)")}</div>
            <div style="color:var(--admin-muted);font-size:11px">${Fmt.escapeHtml(Fmt.date(c.createdAt))} · ${Fmt.escapeHtml(humanBytes(c.sizeBytes))}${c.hasLog ? "" : " · <i>no log</i>"}</div>
          </div>
        </button>
      `).join("");
      sideEl.querySelectorAll("button[data-c]").forEach(b => {
        b.addEventListener("click", async () => {
          sideEl.querySelectorAll("button[data-c]").forEach(x => x.classList.remove("active"));
          b.classList.add("active");
          const num = b.dataset.c;
          titleEl.textContent = "Commit #" + num;
          contentEl.innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading log…</div>`;
          try {
            const data = await Api.request("/projects/" + p.id + "/logs/" + num);
            if (!data.entries || !data.entries.length) {
              contentEl.innerHTML = `<div class="empty-state"><div class="big">·</div>Empty log</div>`;
              return;
            }
            const meta = data.truncated ? `<div style="color:var(--warn-color, #fbbf24);margin-bottom:8px;font-size:12px">Log was truncated to last 5MB · total ${humanBytes(data.size)}</div>` : "";
            contentEl.innerHTML = meta + data.entries.map(renderLogEntry).join("");
          } catch (err) {
            contentEl.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed")}</div>`;
          }
        });
      });
      // auto-select first
      const first = sideEl.querySelector("button[data-c]");
      if (first) first.click();
    }).catch(err => {
      sideEl.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed")}</div>`;
    });
  }

  function renderLogEntry(e) {
    if (e.raw) {
      return `<div class="log-entry"><pre class="log-line">${Fmt.escapeHtml(e.raw)}</pre></div>`;
    }
    const ts = e.timestamp || e.ts || e.createdAt;
    const tsStr = ts ? Fmt.escapeHtml(new Date(ts).toLocaleTimeString()) : "";
    const kind = e.kind || e.type || e.event || e.level || "log";
    const summary = e.message || e.action || e.detail || (e.tool && `${e.tool} ${e.tool_input ? "→" : ""}`) || "";
    return `
      <details class="log-entry">
        <summary class="log-summary">
          <span class="log-ts">${tsStr}</span>
          <span class="log-kind">${Fmt.escapeHtml(String(kind))}</span>
          <span class="log-text">${Fmt.escapeHtml(String(summary).slice(0, 200))}</span>
        </summary>
        <pre class="log-json">${Fmt.escapeHtml(JSON.stringify(e, null, 2))}</pre>
      </details>
    `;
  }

  function humanBytes(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }
})();
