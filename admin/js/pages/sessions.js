/* Agent Sessions Explorer — reads from /admin/api/agent-sessions (agent_sessions table).
   Shows per-session type, model, duration, cost, credits, margin, and success status. */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
  const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;

  const PAGE_SIZE = 50;

  // ── Type palette ───────────────────────────────────────────────────────────
  const TYPE_META = {
    router:       { label: "Router",       color: "#a78bfa", bg: "rgba(167,139,250,0.14)", border: "rgba(167,139,250,0.28)" },
    answer:       { label: "Answer",       color: "#60a5fa", bg: "rgba(96,165,250,0.14)",  border: "rgba(96,165,250,0.28)"  },
    build:        { label: "Build",        color: "#34d399", bg: "rgba(52,211,153,0.14)",  border: "rgba(52,211,153,0.28)"  },
    update:       { label: "Update",       color: "#86efac", bg: "rgba(134,239,172,0.14)", border: "rgba(134,239,172,0.28)" },
    "update-plan":{ label: "Update Plan",  color: "#6ee7b7", bg: "rgba(110,231,183,0.14)", border: "rgba(110,231,183,0.28)" },
    "bug-fix":    { label: "Bug Fix",      color: "#f87171", bg: "rgba(248,113,113,0.14)", border: "rgba(248,113,113,0.28)" },
    suggestions:  { label: "Suggestions",  color: "#fbbf24", bg: "rgba(251,191,36,0.14)",  border: "rgba(251,191,36,0.28)"  },
    context:      { label: "Context",      color: "#94a3b8", bg: "rgba(148,163,184,0.14)", border: "rgba(148,163,184,0.28)" },
  };

  function typeBadge(type) {
    const m = TYPE_META[type] || { label: type, color: "#94a3b8", bg: "rgba(148,163,184,0.12)", border: "rgba(148,163,184,0.24)" };
    return `<span style="display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;background:${m.bg};color:${m.color};border:1px solid ${m.border};white-space:nowrap">${Fmt.escapeHtml(m.label)}</span>`;
  }

  function successBadge(ok) {
    return ok
      ? `<span style="color:#4ade80;font-size:11px;font-weight:600">✓ ok</span>`
      : `<span style="color:#f87171;font-size:11px;font-weight:600">✗ fail</span>`;
  }

  // Complexity / MAX-MODE badges. Values mirror what the router stamps on
  // each AgentSession row. Null complexity (free sessions / pre-matrix legacy
  // rows) renders as a quiet em-dash.
  const COMPLEXITY_META = {
    trivial: { color: "#a3a3a3", bg: "rgba(163,163,163,0.10)", border: "rgba(163,163,163,0.20)" },
    small:   { color: "#86efac", bg: "rgba(134,239,172,0.10)", border: "rgba(134,239,172,0.22)" },
    medium:  { color: "#60a5fa", bg: "rgba(96,165,250,0.12)",  border: "rgba(96,165,250,0.24)" },
    large:   { color: "#fbbf24", bg: "rgba(251,191,36,0.12)",  border: "rgba(251,191,36,0.24)" },
    huge:    { color: "#f87171", bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.24)" },
  };
  function complexityBadge(c) {
    if (!c) return `<span style="color:var(--admin-muted)">—</span>`;
    const m = COMPLEXITY_META[c] || { color: "#94a3b8", bg: "rgba(148,163,184,0.12)", border: "rgba(148,163,184,0.24)" };
    return `<span style="display:inline-flex;align-items:center;height:18px;padding:0 7px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;background:${m.bg};color:${m.color};border:1px solid ${m.border}">${Fmt.escapeHtml(c)}</span>`;
  }
  function maxModeBadge(on) {
    if (!on) return `<span style="color:var(--admin-muted);font-size:11px">—</span>`;
    return `<span style="display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 7px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.05em;background:rgba(255,184,77,0.14);color:#ffb84d;border:1px solid rgba(255,184,77,0.30)" title="MAX MODE was enabled by the user">⚡MAX</span>`;
  }

  function fmtUsd(n, d = 4) { return "$" + Number(n || 0).toFixed(d); }
  function fmtInt(n)         { return Number(n || 0).toLocaleString("en-US"); }
  function fmtDur(ms)        {
    if (!ms) return "—";
    if (ms < 1000) return ms + "ms";
    const s = (ms / 1000).toFixed(1);
    return s + "s";
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
      + " · " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  function shortModel(m) {
    if (!m) return "—";
    const parts = m.split("/");
    const name = parts[parts.length - 1] || m;
    return name.length > 30 ? name.slice(0, 28) + "…" : name;
  }

  window.AdminPages.sessions = {
    title: "Sessions",
    icon: ICON,
    render: async function (host, ctx) {
      const state = (ctx.tab.sessionsState = ctx.tab.sessionsState || {
        page: 1,
        filterType: "",
        filterProject: "",
        filterUser: "",
        filterSuccess: "",
      });

      const ALL_TYPES = ["router", "answer", "build", "update", "update-plan", "bug-fix", "suggestions", "context"];

      host.innerHTML = `
        <div class="page-hdr">
          <div>
            <h1>Agent Sessions</h1>
            <div class="sub">Per-session log from agent_sessions table — type, model, tokens, cost, margin, duration</div>
          </div>
          <div class="actions">
            <button class="btn btn-sm btn-ghost" id="sess-refresh">Refresh</button>
          </div>
        </div>

        <div id="sess-summary" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px"></div>

        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
          <select class="input" id="sess-q-type" style="max-width:160px">
            <option value="">All types</option>
            ${ALL_TYPES.map(t => `<option value="${t}" ${state.filterType === t ? "selected" : ""}>${TYPE_META[t]?.label || t}</option>`).join("")}
          </select>
          <input class="input" id="sess-q-project" placeholder="Project ID" style="max-width:240px" value="${Fmt.escapeHtml(state.filterProject)}"/>
          <input class="input" id="sess-q-user"    placeholder="User ID"    style="max-width:120px" value="${Fmt.escapeHtml(state.filterUser)}"/>
          <select class="input" id="sess-q-success" style="max-width:120px">
            <option value="">All</option>
            <option value="true"  ${state.filterSuccess === "true"  ? "selected" : ""}>Success</option>
            <option value="false" ${state.filterSuccess === "false" ? "selected" : ""}>Failed</option>
          </select>
          <button class="btn btn-sm btn-primary" id="sess-apply">Apply</button>
          <button class="btn btn-sm btn-ghost"   id="sess-clear">Clear</button>
        </div>

        <div id="sess-content"><div class="loading-state"><div class="spinner"></div>Loading sessions…</div></div>
        <div id="sess-pager" style="margin-top:14px;display:flex;align-items:center;justify-content:flex-end;gap:8px"></div>
      `;

      const content = host.querySelector("#sess-content");
      const pager   = host.querySelector("#sess-pager");
      const summary = host.querySelector("#sess-summary");

      function buildPath() {
        const p = new URLSearchParams({ page: String(state.page), limit: String(PAGE_SIZE) });
        if (state.filterType)    p.set("type",      state.filterType);
        if (state.filterProject) p.set("projectId", state.filterProject);
        if (state.filterUser)    p.set("userId",    state.filterUser);
        if (state.filterSuccess) p.set("success",   state.filterSuccess);
        return "/agent-sessions?" + p.toString();
      }

      async function load() {
        content.innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading…</div>`;
        summary.innerHTML = "";
        try {
          const data = await Api.request(buildPath());
          renderSummary(data);
          renderRows(data);
          renderPager(data);
        } catch (err) {
          content.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed to load")}</div>`;
        }
      }

      function renderSummary(data) {
        const rows = data.sessions || [];
        if (!rows.length) { summary.innerHTML = ""; return; }
        const totalCost    = rows.reduce((a, r) => a + (r.costUsd || 0), 0);
        const totalRev     = rows.reduce((a, r) => a + (r.revenueUsd || 0), 0);
        const totalMargin  = rows.reduce((a, r) => a + (r.marginUsd || 0), 0);
        const failCount    = rows.filter(r => !r.success).length;
        const avgDurMs     = rows.filter(r => r.durationMs).reduce((a, r, _i, arr) => a + r.durationMs / arr.length, 0);

        const card = (label, value, color) =>
          `<div style="flex:1;min-width:120px;background:var(--admin-card-bg,rgba(255,255,255,0.04));border:1px solid var(--admin-border);border-radius:10px;padding:10px 14px">
            <div style="font-size:11px;color:var(--admin-muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">${label}</div>
            <div style="font-size:18px;font-weight:700;font-variant-numeric:tabular-nums;color:${color || "inherit"}">${value}</div>
          </div>`;

        const marginColor = totalMargin > 0 ? "#4ade80" : totalMargin < 0 ? "#f87171" : "var(--admin-muted)";
        summary.innerHTML =
          card("This page", fmtInt(rows.length), "") +
          card("Total (filtered)", fmtInt(data.total), "") +
          card("Cost", fmtUsd(totalCost, 5), "#94a3b8") +
          card("Revenue", fmtUsd(totalRev, 4), "#60a5fa") +
          card("Margin", (totalMargin >= 0 ? "+" : "") + fmtUsd(totalMargin, 4), marginColor) +
          (failCount > 0 ? card("Failed", fmtInt(failCount), "#f87171") : "") +
          (avgDurMs > 0 ? card("Avg duration", fmtDur(Math.round(avgDurMs)), "") : "");
      }

      function renderRows(data) {
        const rows = data.sessions || [];
        if (!rows.length) {
          content.innerHTML = `<div class="empty-state"><div class="big">·</div>No sessions match your filters</div>`;
          return;
        }

        const html = rows.map(s => {
          const mc = s.marginUsd > 0.001 ? "#4ade80" : s.marginUsd < -0.001 ? "#f87171" : "var(--admin-muted)";
          const sign = s.marginUsd >= 0 ? "+" : "−";
          return `
            <tr data-id="${Fmt.escapeHtml(s.id)}">
              <td>${typeBadge(s.type)}</td>
              <td style="text-align:center">${complexityBadge(s.complexity)}</td>
              <td style="text-align:center">${maxModeBadge(s.isMaxMode)}</td>
              <td>
                ${s.projectId
                  ? `<a class="app-link" href="#" data-pid="${Fmt.escapeHtml(s.projectId)}" style="font-weight:600">${Fmt.escapeHtml(s.projectName || "Unknown")}</a>
                     <div style="font-size:11px;color:var(--admin-muted);font-family:ui-monospace,monospace">${s.projectId.slice(0,8)}…</div>`
                  : `<span style="color:var(--admin-muted)">—</span>`}
              </td>
              <td style="font-size:11px;color:var(--admin-muted);font-family:ui-monospace,monospace;white-space:nowrap;max-width:130px;overflow:hidden;text-overflow:ellipsis" title="${Fmt.escapeHtml(s.model)}">${Fmt.escapeHtml(shortModel(s.model))}</td>
              <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--admin-muted)" title="${Fmt.escapeHtml(s.input)}">${Fmt.escapeHtml(s.input)}</td>
              <td style="color:var(--admin-muted);font-size:12px;white-space:nowrap">${fmtDate(s.createdAt)}</td>
              <td style="text-align:right;white-space:nowrap;font-size:12px;color:var(--admin-muted)">${fmtDur(s.durationMs)}</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums;font-size:12px">${fmtInt(s.inputTokens)}&nbsp;<span style="color:var(--admin-muted)">/</span>&nbsp;${fmtInt(s.outputTokens)}</td>
              <td style="text-align:right;font-family:ui-monospace,monospace;font-size:12px;line-height:1.2">
                <div>${fmtUsd(s.costUsd, 5)}</div>
                ${s.costUsdInput != null || s.costUsdOutput != null ? `
                  <div style="font-size:10px;color:var(--admin-muted);font-weight:500;letter-spacing:0.02em;display:flex;gap:6px;justify-content:flex-end;margin-top:2px">
                    <span title="Input cost (upstream prompt)">in&nbsp;${fmtUsd(s.costUsdInput || 0, 5)}</span>
                    <span style="opacity:0.4">·</span>
                    <span title="Output cost (upstream completion)">out&nbsp;${fmtUsd(s.costUsdOutput || 0, 5)}</span>
                  </div>
                ` : ``}
              </td>
              <td style="text-align:right;font-size:12px">${fmtInt(s.creditsCharged)}&nbsp;<span style="color:var(--admin-muted)">cr</span></td>
              <td style="text-align:right;font-family:ui-monospace,monospace;font-size:12px;font-weight:600;color:${mc}">${sign}${fmtUsd(Math.abs(s.marginUsd), 4)}</td>
              <td style="text-align:center">${successBadge(s.success)}</td>
              <td style="width:32px;text-align:right">
                <button class="btn btn-xs btn-ghost sess-del" title="Delete this log entry">${ICON_TRASH}</button>
              </td>
            </tr>
          `;
        }).join("");

        content.innerHTML = `
          <div class="tbl-wrap">
            <table class="tbl">
              <thead>
                <tr>
                  <th>Type</th>
                  <th style="text-align:center">Complexity</th>
                  <th style="text-align:center">MAX</th>
                  <th>App</th>
                  <th>Model</th>
                  <th>Input</th>
                  <th>Date</th>
                  <th style="text-align:right">Duration</th>
                  <th style="text-align:right">Tokens in / out</th>
                  <th style="text-align:right">Cost</th>
                  <th style="text-align:right">Credits</th>
                  <th style="text-align:right">Margin</th>
                  <th style="text-align:center">Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>${html}</tbody>
            </table>
          </div>
        `;

        content.querySelectorAll(".app-link").forEach(el => {
          el.addEventListener("click", e => {
            e.preventDefault();
            const pid = el.dataset.pid;
            if (!pid) return;
            if (e.metaKey || e.ctrlKey || e.button === 1) {
              window.TabBar.openTab({ pageKey: "app", params: { id: pid }, focus: false, reuseSamePage: false });
            } else {
              ctx.push({ pageKey: "app", params: { id: pid } });
            }
          });
        });

        content.querySelectorAll(".sess-del").forEach(btn => {
          btn.addEventListener("click", async e => {
            e.stopPropagation();
            const tr  = btn.closest("tr");
            const id  = tr && tr.dataset.id;
            if (!id) return;
            if (!confirm("Delete this session log entry? This cannot be undone.")) return;
            btn.disabled = true;
            btn.style.opacity = "0.5";
            try {
              await Api.request("/agent-sessions/" + encodeURIComponent(id), { method: "DELETE" });
              tr.style.transition = "opacity .2s, transform .2s";
              tr.style.opacity = "0";
              tr.style.transform = "translateX(8px)";
              setTimeout(() => load(), 220);
            } catch (err) {
              alert("Delete failed: " + (err.message || err));
              btn.disabled = false;
              btn.style.opacity = "";
            }
          });
        });
      }

      function renderPager(data) {
        const total = data.total || 0;
        const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
        pager.innerHTML = `
          <span style="color:var(--admin-muted);font-size:12px;margin-right:auto">Page ${state.page} of ${pages} · ${fmtInt(total)} sessions</span>
          <button class="btn btn-xs" id="sess-prev" ${state.page <= 1 ? "disabled" : ""}>‹ Prev</button>
          <button class="btn btn-xs" id="sess-next" ${state.page >= pages ? "disabled" : ""}>Next ›</button>
        `;
        pager.querySelector("#sess-prev").addEventListener("click", () => { state.page = Math.max(1, state.page - 1); load(); });
        pager.querySelector("#sess-next").addEventListener("click", () => { state.page = Math.min(pages, state.page + 1); load(); });
      }

      host.querySelector("#sess-apply").addEventListener("click", () => {
        state.filterType    = host.querySelector("#sess-q-type").value;
        state.filterProject = host.querySelector("#sess-q-project").value.trim();
        state.filterUser    = host.querySelector("#sess-q-user").value.trim();
        state.filterSuccess = host.querySelector("#sess-q-success").value;
        state.page = 1;
        load();
      });
      host.querySelector("#sess-clear").addEventListener("click", () => {
        state.filterType = state.filterProject = state.filterUser = state.filterSuccess = "";
        state.page = 1;
        host.querySelector("#sess-q-type").value    = "";
        host.querySelector("#sess-q-project").value = "";
        host.querySelector("#sess-q-user").value    = "";
        host.querySelector("#sess-q-success").value = "";
        load();
      });
      host.querySelector("#sess-refresh").addEventListener("click", load);

      await load();
    },
  };
})();
