/* Agent Sessions — per-run cost / credits / margin explorer.
   Reads from /admin/api/sessions which aggregates usage_logs by task_id. */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;
  const ICON_TRASH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;

  const PAGE_SIZE = 50;

  function fmtUsd(n, decimals = 4) {
    return "$" + Number(n || 0).toFixed(decimals);
  }
  function fmtInt(n) {
    return Number(n || 0).toLocaleString("en-US");
  }
  function shortId(id) {
    return id && id.length > 16 ? id.slice(0, 8) + "…" + id.slice(-4) : (id || "—");
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
      + " · " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  }
  function marginClass(margin) {
    if (margin > 0.001) return "ok";
    if (margin < -0.001) return "bad";
    return "neutral";
  }

  window.AdminPages.sessions = {
    title: "Sessions",
    icon: ICON,
    render: async function (host, ctx) {
      const state = (ctx.tab.sessionsState = ctx.tab.sessionsState || {
        page: 1,
        filterProject: "",
        filterUser: "",
      });

      host.innerHTML = `
        <div class="page-hdr">
          <div>
            <h1>Agent Sessions</h1>
            <div class="sub">Per-run cost, credits charged, revenue and margin (50 credits = $1)</div>
          </div>
          <div class="actions">
            <button class="btn btn-sm btn-ghost" id="sess-refresh">Refresh</button>
          </div>
        </div>

        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
          <input class="input" id="sess-q-project" placeholder="Filter by Project ID" style="max-width:280px" value="${Fmt.escapeHtml(state.filterProject)}"/>
          <input class="input" id="sess-q-user"    placeholder="Filter by User ID"    style="max-width:180px" value="${Fmt.escapeHtml(state.filterUser)}"/>
          <button class="btn btn-sm btn-primary" id="sess-apply">Apply</button>
          <button class="btn btn-sm btn-ghost"   id="sess-clear">Clear</button>
        </div>

        <div id="sess-content"><div class="loading-state"><div class="spinner"></div>Loading sessions…</div></div>
        <div id="sess-pager" style="margin-top:14px;display:flex;align-items:center;justify-content:flex-end;gap:8px"></div>
      `;

      const content = host.querySelector("#sess-content");
      const pager   = host.querySelector("#sess-pager");

      function buildPath() {
        const params = new URLSearchParams({
          page: String(state.page),
          limit: String(PAGE_SIZE),
        });
        if (state.filterProject) params.set("projectId", state.filterProject);
        if (state.filterUser)    params.set("userId",    state.filterUser);
        return "/sessions?" + params.toString();
      }

      async function load() {
        content.innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading sessions…</div>`;
        try {
          const data = await Api.request(buildPath());
          renderRows(data);
          renderPager(data);
        } catch (err) {
          content.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed to load")}</div>`;
        }
      }

      function renderRows(data) {
        const rows = data.sessions || [];
        if (!rows.length) {
          content.innerHTML = `<div class="empty-state"><div class="big">·</div>No agent sessions yet</div>`;
          return;
        }

        const html = rows.map(s => {
          const mc = marginClass(s.marginUsd);
          const marginColor = mc === "ok"  ? "#4ade80"
                            : mc === "bad" ? "#f87171"
                            : "var(--admin-muted)";
          const sign = s.marginUsd >= 0 ? "+" : "−";
          const marginAbs = Math.abs(s.marginUsd);
          return `
            <tr data-task="${Fmt.escapeHtml(s.taskId)}" data-pid="${Fmt.escapeHtml(s.projectId)}">
              <td>
                <span class="copy-cell" title="${Fmt.escapeHtml(s.taskId)}" data-copy="${Fmt.escapeHtml(s.taskId)}" style="cursor:pointer;font-family:ui-monospace,monospace;font-size:12px">
                  ${Fmt.escapeHtml(shortId(s.taskId))}
                </span>
              </td>
              <td>
                <a class="app-link" href="#" data-pid="${Fmt.escapeHtml(s.projectId)}" style="font-weight:600">${Fmt.escapeHtml(s.projectName || "Unknown")}</a>
                <div style="font-size:11px;color:var(--admin-muted);font-family:ui-monospace,monospace">${Fmt.escapeHtml(shortId(s.projectId))}</div>
              </td>
              <td style="color:var(--admin-muted);font-size:12px;white-space:nowrap">${Fmt.escapeHtml(fmtDate(s.startedAt))}</td>
              <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtInt(s.inputTokens)} <span style="color:var(--admin-muted)">/</span> ${fmtInt(s.outputTokens)}</td>
              <td style="text-align:right;font-family:ui-monospace,monospace">${fmtUsd(s.costUsd, 5)}</td>
              <td style="text-align:right">${fmtInt(s.creditsCharged)} <span style="color:var(--admin-muted)">cr</span></td>
              <td style="text-align:right;font-family:ui-monospace,monospace">${fmtUsd(s.revenueUsd, 4)}</td>
              <td style="text-align:right;font-family:ui-monospace,monospace;font-weight:600;color:${marginColor}">
                ${sign}${fmtUsd(marginAbs, 4)}
              </td>
              <td style="text-align:right;color:var(--admin-muted)">${fmtInt(s.callCount)}</td>
              <td style="width:32px;text-align:right">
                <button class="btn btn-xs btn-ghost sess-del" title="Remove session" aria-label="Delete session">
                  ${ICON_TRASH}
                </button>
              </td>
            </tr>
          `;
        }).join("");

        content.innerHTML = `
          <div class="tbl-wrap">
            <table class="tbl">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>App</th>
                  <th>Started</th>
                  <th style="text-align:right">Tokens (in&nbsp;/&nbsp;out)</th>
                  <th style="text-align:right">Cost</th>
                  <th style="text-align:right">Credits</th>
                  <th style="text-align:right">Revenue</th>
                  <th style="text-align:right">Margin</th>
                  <th style="text-align:right">Calls</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>${html}</tbody>
            </table>
          </div>
        `;

        // Copy task id on click
        content.querySelectorAll(".copy-cell").forEach(el => {
          el.addEventListener("click", e => {
            e.stopPropagation();
            navigator.clipboard.writeText(el.dataset.copy || "").then(() => {
              const orig = el.textContent;
              el.textContent = "Copied!";
              setTimeout(() => { el.textContent = orig; }, 1100);
            });
          });
        });

        // App link → open the app detail page (same pattern as users.js / apps.js)
        content.querySelectorAll(".app-link").forEach(el => {
          el.addEventListener("click", e => {
            e.preventDefault();
            const pid = el.dataset.pid;
            if (!pid) return;
            const newTab = e.metaKey || e.ctrlKey || e.button === 1;
            if (newTab) {
              window.TabBar.openTab({ pageKey: "app", params: { id: pid }, focus: false, reuseSamePage: false });
            } else {
              ctx.push({ pageKey: "app", params: { id: pid } });
            }
          });
        });

        // Delete session
        content.querySelectorAll(".sess-del").forEach(btn => {
          btn.addEventListener("click", async e => {
            e.stopPropagation();
            const tr = btn.closest("tr");
            const taskId = tr && tr.dataset.task;
            if (!taskId) return;
            if (!confirm("Delete this session and its usage log entries? This cannot be undone.")) return;

            btn.disabled = true;
            btn.style.opacity = "0.5";
            try {
              await Api.request("/sessions/" + encodeURIComponent(taskId), { method: "DELETE" });
              tr.style.transition = "opacity .25s, transform .25s";
              tr.style.opacity = "0";
              tr.style.transform = "translateX(8px)";
              setTimeout(() => load(), 260);
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
          <span style="color:var(--admin-muted);font-size:12px;margin-right:auto">Page ${state.page} of ${pages} · ${total} sessions</span>
          <button class="btn btn-xs" id="sess-prev" ${state.page <= 1 ? "disabled" : ""}>‹ Prev</button>
          <button class="btn btn-xs" id="sess-next" ${state.page >= pages ? "disabled" : ""}>Next ›</button>
        `;
        pager.querySelector("#sess-prev").addEventListener("click", () => { state.page = Math.max(1, state.page - 1); load(); });
        pager.querySelector("#sess-next").addEventListener("click", () => { state.page = Math.min(pages, state.page + 1); load(); });
      }

      host.querySelector("#sess-apply").addEventListener("click", () => {
        state.filterProject = host.querySelector("#sess-q-project").value.trim();
        state.filterUser    = host.querySelector("#sess-q-user").value.trim();
        state.page = 1;
        load();
      });
      host.querySelector("#sess-clear").addEventListener("click", () => {
        state.filterProject = "";
        state.filterUser    = "";
        state.page = 1;
        host.querySelector("#sess-q-project").value = "";
        host.querySelector("#sess-q-user").value    = "";
        load();
      });
      host.querySelector("#sess-refresh").addEventListener("click", load);

      await load();
    },
  };
})();
