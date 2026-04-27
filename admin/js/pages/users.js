/* Users list — Phase 2.
   Server-side filter + sort + pagination + free-text search. */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;

  const FILTERS = [
    { id: "all",          label: "All" },
    { id: "paying",       label: "Paying" },
    { id: "free",         label: "Free" },
    { id: "partner",      label: "Partners" },
    { id: "has_apps",     label: "Has apps" },
    { id: "no_apps",      label: "No apps" },
    { id: "inactive_30d", label: "Inactive 30d" },
  ];
  const SORTS = [
    { id: "newest",       label: "Newest" },
    { id: "oldest",       label: "Oldest" },
    { id: "balance_desc", label: "Highest credits" },
    { id: "spent_desc",   label: "Highest spend" },
    { id: "apps_desc",    label: "Most apps" },
  ];

  window.AdminPages.users = {
    title: "Users",
    icon: ICON,
    render: async function (host, ctx) {
      // State held in a closure so refresh / filter changes don't lose the page.
      const state = (ctx.tab.usersState = ctx.tab.usersState || {
        q: "", filter: "all", sort: "newest", page: 1, pageSize: 50,
      });

      host.innerHTML = `
        <div class="page-hdr">
          <div><h1>Users</h1><div class="sub">All registered users</div></div>
          <div class="actions"><button class="btn btn-sm btn-ghost" id="users-refresh">Refresh</button></div>
        </div>

        <div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
          <input class="input" id="users-q" placeholder="Search name, @username, Telegram ID…" style="max-width:340px" value="${Fmt.escapeHtml(state.q)}"/>
          <div style="display:flex;gap:6px;flex-wrap:wrap" id="users-filters">
            ${FILTERS.map(f => `<button class="btn btn-xs ${state.filter === f.id ? "btn-primary" : ""}" data-filter="${f.id}">${Fmt.escapeHtml(f.label)}</button>`).join("")}
          </div>
          <select class="select" id="users-sort" style="width:auto">
            ${SORTS.map(s => `<option value="${s.id}" ${state.sort === s.id ? "selected" : ""}>${Fmt.escapeHtml(s.label)}</option>`).join("")}
          </select>
        </div>

        <div id="users-content"><div class="loading-state"><div class="spinner"></div>Loading users…</div></div>
        <div id="users-pager" style="margin-top:14px;display:flex;align-items:center;justify-content:flex-end;gap:8px"></div>
      `;

      const qEl       = host.querySelector("#users-q");
      const sortEl    = host.querySelector("#users-sort");
      const filtersEl = host.querySelector("#users-filters");
      const content   = host.querySelector("#users-content");
      const pager     = host.querySelector("#users-pager");

      let qTimer = 0;

      function applyFilterUI() {
        filtersEl.querySelectorAll("[data-filter]").forEach(b => {
          b.classList.toggle("btn-primary", b.dataset.filter === state.filter);
        });
      }

      async function load() {
        content.innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading users…</div>`;
        try {
          const params = new URLSearchParams({
            q: state.q || "",
            filter: state.filter,
            sort: state.sort,
            page: String(state.page),
            pageSize: String(state.pageSize),
          });
          const data = await Api.request("/users?" + params.toString());
          renderRows(data);
          renderPager(data);
        } catch (err) {
          content.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed to load")}</div>`;
        }
      }

      function renderRows(data) {
        const rows = data.users || [];
        if (!rows.length) {
          content.innerHTML = `<div class="empty-state"><div class="big">·</div>No users match the current filters</div>`;
          return;
        }
        content.innerHTML = `
          <div class="tbl-wrap">
            <table class="tbl">
              <thead>
                <tr>
                  <th></th>
                  <th>Name</th>
                  <th>Telegram ID</th>
                  <th style="text-align:right">Credits</th>
                  <th style="text-align:right">Spent (cr)</th>
                  <th style="text-align:right">Apps</th>
                  <th>Tags</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                ${rows.map(u => {
                  const display = u.firstName || u.username || ("User " + u.id);
                  const tags = (u.adminTags || []).slice(0, 3);
                  return `
                    <tr class="clickable" data-uid="${u.id}">
                      <td style="width:40px">${Avatar.lazyAvatarHtml({ kind: "user", id: u.telegramId, name: display, seed: u.id, size: 32 })}</td>
                      <td>
                        <div style="display:flex;flex-direction:column;gap:2px">
                          <span style="font-weight:600">${Fmt.escapeHtml(display)}${u.isPartner ? ' <span class="badge accent" style="margin-left:6px">Partner</span>' : ""}</span>
                          ${u.username ? `<span style="color:var(--admin-muted);font-size:11px">@${Fmt.escapeHtml(u.username)}</span>` : ""}
                        </div>
                      </td>
                      <td><code style="color:var(--admin-muted)">${Fmt.escapeHtml(u.telegramId)}</code></td>
                      <td style="text-align:right">${Fmt.creditsHtml(u.credits, Number(u.credits) > 0 ? '#4ade80' : 'currentColor')}</td>
                      <td style="text-align:right;color:var(--admin-muted)">${Fmt.creditsHtml(u.totalSpent || 0)}</td>
                      <td style="text-align:right">${u.projectCount}</td>
                      <td>${tags.length ? tags.map(t => `<span class="badge" style="margin-right:3px">${Fmt.escapeHtml(t)}</span>`).join("") : '<span style="color:var(--admin-muted)">—</span>'}</td>
                      <td style="color:var(--admin-muted)" title="${Fmt.escapeHtml(Fmt.date(u.createdAt))}">${Fmt.escapeHtml(Fmt.relativeTime(u.createdAt))}</td>
                    </tr>`;
                }).join("")}
              </tbody>
            </table>
          </div>
        `;
        content.querySelectorAll("tr[data-uid]").forEach(row => {
          row.addEventListener("click", e => {
            const uid = row.dataset.uid;
            const newTab = e.metaKey || e.ctrlKey || e.button === 1;
            if (newTab) {
              window.TabBar.openTab({ pageKey: "user", params: { id: uid }, focus: false, reuseSamePage: false });
            } else {
              ctx.push({ pageKey: "user", params: { id: uid } });
            }
          });
        });
      }

      function renderPager(data) {
        const { page, pageCount, total } = data;
        pager.innerHTML = `
          <span style="color:var(--admin-muted);font-size:12px;margin-right:auto">Page ${page} of ${pageCount} · ${total} users</span>
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

      host.querySelector("#users-refresh").addEventListener("click", load);

      await load();
    },
  };
})();
