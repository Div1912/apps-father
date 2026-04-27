/* Apps list — Phase 3.
 * Server-side filter chips + sort + q search + pagination.
 * Uses the same toolbar conventions as the Users list. */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`;

  const FILTERS = [
    { id: "all",       label: "All" },
    { id: "deployed",  label: "Deployed" },
    { id: "released",  label: "Released" },
    { id: "building",  label: "Building" },
    { id: "planning",  label: "Planning" },
    { id: "created",   label: "Created" },
    { id: "error",     label: "Error" },
  ];
  const SORTS = [
    { id: "updated_desc", label: "Recently updated" },
    { id: "created_desc", label: "Recently created" },
    { id: "budget_desc",  label: "Cost (high → low)" },
    { id: "budget_asc",   label: "Cost (low → high)" },
    { id: "name_asc",     label: "Name (A → Z)" },
  ];

  window.AdminPages.apps = {
    title: "Apps",
    icon: ICON,
    render: async function (host, ctx) {
      const state = (ctx.tab.appsState = ctx.tab.appsState || {
        q: "", filter: "all", sort: "updated_desc", page: 1, pageSize: 50,
      });

      host.innerHTML = `
        <div class="page-hdr">
          <div><h1>Apps</h1><div class="sub" id="apps-sub">All projects across users</div></div>
          <div class="actions"><button class="btn btn-sm btn-ghost" id="apps-refresh">Refresh</button></div>
        </div>

        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
          <input class="input" id="apps-q" placeholder="Search by name, bot, owner, or id…" style="max-width:340px" value="${Fmt.escapeHtml(state.q)}"/>
          <div style="display:flex;gap:6px;flex-wrap:wrap" id="apps-filters">
            ${FILTERS.map(f => `<button class="btn btn-xs ${state.filter === f.id ? "btn-primary" : ""}" data-filter="${f.id}">${Fmt.escapeHtml(f.label)}</button>`).join("")}
          </div>
          <select class="select" id="apps-sort" style="width:auto">
            ${SORTS.map(s => `<option value="${s.id}" ${state.sort === s.id ? "selected" : ""}>${Fmt.escapeHtml(s.label)}</option>`).join("")}
          </select>
        </div>

        <div id="apps-content"><div class="loading-state"><div class="spinner"></div>Loading apps…</div></div>
        <div id="apps-pager" style="margin-top:14px;display:flex;align-items:center;justify-content:flex-end;gap:8px"></div>
      `;

      const qEl       = host.querySelector("#apps-q");
      const sortEl    = host.querySelector("#apps-sort");
      const filtersEl = host.querySelector("#apps-filters");
      const content   = host.querySelector("#apps-content");
      const pager     = host.querySelector("#apps-pager");
      const subText   = host.querySelector("#apps-sub");

      let qTimer = 0;

      function applyFilterUI() {
        filtersEl.querySelectorAll("[data-filter]").forEach(b => {
          b.classList.toggle("btn-primary", b.dataset.filter === state.filter);
        });
      }

      async function load() {
        content.innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading apps…</div>`;
        try {
          const params = new URLSearchParams({
            q: state.q || "",
            filter: state.filter,
            sort: state.sort,
            page: String(state.page),
            pageSize: String(state.pageSize),
          });
          const data = await Api.request("/projects?" + params.toString());
          subText.textContent = `${data.total} ${data.total === 1 ? "project" : "projects"} · page ${data.page} of ${data.pageCount}`;
          renderRows(data);
          renderPager(data);
        } catch (err) {
          content.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed to load")}</div>`;
        }
      }

      function renderRows(data) {
        const rows = data.projects || [];
        if (!rows.length) {
          content.innerHTML = `<div class="empty-state"><div class="big">·</div>No apps match the current filters</div>`;
          return;
        }
        content.innerHTML = `
          <div class="tbl-wrap">
            <table class="tbl">
              <thead>
                <tr>
                  <th></th>
                  <th>Name</th>
                  <th>Owner</th>
                  <th>Status</th>
                  <th>Bot</th>
                  <th style="text-align:right">Cost (USD)</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map(p => `
                  <tr class="clickable" data-pid="${Fmt.escapeHtml(p.id)}">
                    <td style="width:40px">${Avatar.lazyAvatarHtml({ kind: "project", id: p.id, name: p.name, seed: p.id, size: 32 })}</td>
                    <td>
                      <div style="display:flex;flex-direction:column;gap:2px">
                        <span style="font-weight:600">${Fmt.escapeHtml(p.name)}</span>
                        ${p.description ? `<span style="color:var(--admin-muted);font-size:11px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block">${Fmt.escapeHtml(p.description)}</span>` : ""}
                      </div>
                    </td>
                    <td style="color:var(--admin-muted)">${Fmt.escapeHtml(p.owner)}</td>
                    <td>${Fmt.statusBadge(p.status)}</td>
                    <td>${p.botUsername ? `<a href="https://t.me/${encodeURIComponent(p.botUsername)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">@${Fmt.escapeHtml(p.botUsername)}</a>` : '<span style="color:var(--admin-muted)">—</span>'}</td>
                    <td style="text-align:right;${Number(p.totalCost) > 0 ? "color:var(--warn-color, #fbbf24)" : ""}">${Fmt.money(p.totalCost)}</td>
                    <td style="color:var(--admin-muted)" title="${Fmt.escapeHtml(Fmt.date(p.updatedAt))}">${Fmt.escapeHtml(Fmt.relativeTime(p.updatedAt))}</td>
                  </tr>`).join("")}
              </tbody>
            </table>
          </div>
        `;
        content.querySelectorAll("tr[data-pid]").forEach(row => {
          row.addEventListener("click", e => {
            if (e.target.tagName === "A") return;
            const pid = row.dataset.pid;
            const newTab = e.metaKey || e.ctrlKey || e.button === 1;
            if (newTab) {
              window.TabBar.openTab({ pageKey: "app", params: { id: pid }, focus: false, reuseSamePage: false });
            } else {
              ctx.push({ pageKey: "app", params: { id: pid } });
            }
          });
        });
      }

      function renderPager(data) {
        const { page, pageCount, total } = data;
        pager.innerHTML = `
          <span style="color:var(--admin-muted);font-size:12px;margin-right:auto">Page ${page} of ${pageCount} · ${total} apps</span>
          <button class="btn btn-xs" id="pg-prev" ${page <= 1 ? "disabled" : ""}>‹ Prev</button>
          <button class="btn btn-xs" id="pg-next" ${page >= pageCount ? "disabled" : ""}>Next ›</button>
        `;
        pager.querySelector("#pg-prev").addEventListener("click", () => { state.page = Math.max(1, state.page - 1); load(); });
        pager.querySelector("#pg-next").addEventListener("click", () => { state.page = Math.min(pageCount, state.page + 1); load(); });
      }

      qEl.addEventListener("input", () => {
        clearTimeout(qTimer);
        qTimer = setTimeout(() => {
          state.q = qEl.value.trim();
          state.page = 1;
          load();
        }, 250);
      });

      sortEl.addEventListener("change", () => {
        state.sort = sortEl.value;
        state.page = 1;
        load();
      });

      filtersEl.addEventListener("click", e => {
        const b = e.target.closest("[data-filter]");
        if (!b) return;
        state.filter = b.dataset.filter;
        state.page = 1;
        applyFilterUI();
        load();
      });

      host.querySelector("#apps-refresh").addEventListener("click", load);

      await load();
    },
  };
})();
