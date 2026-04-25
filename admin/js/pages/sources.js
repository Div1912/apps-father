/* Sources — Phase 4.
 * Funnel breakdown by UTM source / partner / referrer with date-range
 * picker and per-card "View N users" drill-down.
 * Ports the visual structure of mini_app/app.js → admBuildBlock + admSourceCard. */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;

  const META = {
    all:      { label: "TOTAL",    cls: "all" },
    organic:  { label: "ORGANIC",  cls: "organic" },
    source:   { label: "SOURCE",   cls: "source" },
    partner:  { label: "PARTNER",  cls: "partner" },
    referrer: { label: "REFERRER", cls: "referrer" },
  };

  const TABS = [
    { id: "all",       label: "All" },
    { id: "sources",   label: "Sources" },
    { id: "partners",  label: "Partners" },
    { id: "referrers", label: "Referrers" },
  ];

  // ─── range helpers ────────────────────────────────────────────────────
  function startOfTodayISO() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); }
  function endOfTodayISO()   { const d = new Date(); d.setHours(23, 59, 59, 999); return d.toISOString(); }
  function startNDaysAgoISO(n) { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(0, 0, 0, 0); return d.toISOString(); }
  function presetToRange(p) {
    if (p === "today")  return { preset: p, from: startOfTodayISO(),  to: endOfTodayISO() };
    if (p === "week")   return { preset: p, from: startNDaysAgoISO(6),to: endOfTodayISO() };
    if (p === "month")  return { preset: p, from: startNDaysAgoISO(29),to: endOfTodayISO() };
    return { preset: "all", from: null, to: null };
  }
  function isoToInput(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const yyyy = d.getFullYear(); const mm = String(d.getMonth() + 1).padStart(2, "0"); const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  function inputToIso(value, edge) {
    if (!value) return null;
    const [y, m, d] = value.split("-").map(Number);
    if (!y || !m || !d) return null;
    const dt = new Date(y, m - 1, d, edge === "end" ? 23 : 0, edge === "end" ? 59 : 0, edge === "end" ? 59 : 0, edge === "end" ? 999 : 0);
    return dt.toISOString();
  }
  function rangeLabel(r) {
    if (r.preset === "today") return "today";
    if (r.preset === "week")  return "last 7 days";
    if (r.preset === "month") return "last 30 days";
    if (r.preset === "all" || (!r.from && !r.to)) return "all time";
    return `${isoToInput(r.from) || "?"} → ${isoToInput(r.to) || "?"}`;
  }

  function buildBlock(item, kind) {
    if (kind === "all")     return { kind, title: "All Users", ...item };
    if (kind === "organic") return { kind, title: "Organic", ...item };
    if (kind === "source")  return { kind, title: item.source, ...item };
    if (kind === "partner" || kind === "referrer") {
      const name = item.firstName || item.username || `User ${item.telegramId}`;
      return {
        kind,
        title: name,
        subtitle: item.partnerTag ? `@${item.partnerTag}` : (item.username ? `@${item.username}` : `ID ${item.telegramId}`),
        ...item,
      };
    }
    return null;
  }
  function blockKey(b) {
    if (b.kind === "source")  return b.source || b.title || "";
    if (b.kind === "partner" || b.kind === "referrer") return b.telegramId || "";
    return "";
  }

  function renderCard(block) {
    const meta = META[block.kind] || META.source;
    const conv  = (Number(block.conversion) || 0).toFixed(1);
    const arpu  = (Number(block.arpu)  || 0).toFixed(2);
    const arppu = (Number(block.arppu) || 0).toFixed(2);
    const funnelPct = (n) => block.users > 0 ? Math.round((n / block.users) * 100) : 0;
    const hasPerson = block.kind === "partner" || block.kind === "referrer";

    let titleLabel = block.title;
    if (block.kind === "source" && block.title === "(direct)") titleLabel = "Direct / Unknown";

    const subtitle = block.subtitle ? `<div class="src-subtitle">${Fmt.escapeHtml(block.subtitle)}</div>` : "";
    const partnerBadge = block.kind === "partner" && block.partnerPercent != null
      ? `<span class="src-pct">${Number(block.partnerPercent).toFixed(0)}%</span>` : "";

    const avatar = hasPerson
      ? (block.avatarUrl
          ? `<div class="src-avatar"><img src="${Fmt.escapeHtml(block.avatarUrl)}" alt="" loading="lazy"></div>`
          : (block.telegramId
              ? Avatar.lazyAvatarHtml({ kind: "user", id: block.telegramId, name: block.title, seed: block.telegramId || block.title, size: 40 })
              : Avatar.avatarHtml({ name: block.title, seed: block.title, size: 40 })))
      : "";

    return `
      <div class="src-card ${meta.cls}">
        <div class="src-head">
          ${avatar}
          <div class="src-head-main">
            <div class="src-type-row">
              <span class="src-pill ${meta.cls}">${meta.label}</span>
              ${partnerBadge}
            </div>
            <div class="src-title">${Fmt.escapeHtml(titleLabel)}</div>
            ${subtitle}
          </div>
          <div class="src-users">
            <div class="src-users-num">${Fmt.intK(block.users)}</div>
            <div class="src-users-lbl">users</div>
          </div>
        </div>

        <div class="src-funnel">
          ${funnelRow("Created App",  block.createdApp,  funnelPct(block.createdApp),  "f-bot")}
          ${funnelRow("Created Plan", block.createdPlan, funnelPct(block.createdPlan), "f-plan")}
          ${funnelRow("Built App",    block.builtApp,    funnelPct(block.builtApp),    "f-app")}
          ${funnelRow("Paying",       block.payingUsers, funnelPct(block.payingUsers), "f-pay")}
        </div>

        <div class="src-metrics">
          <div class="src-metric"><div class="src-metric-label">Conversion</div><div class="src-metric-value blue">${conv}%</div></div>
          <div class="src-metric"><div class="src-metric-label">Revenue</div><div class="src-metric-value green">$${(Number(block.revenue) || 0).toFixed(2)}</div></div>
          <div class="src-metric"><div class="src-metric-label">ARPU</div><div class="src-metric-value">$${arpu}</div></div>
          <div class="src-metric"><div class="src-metric-label">ARPPU</div><div class="src-metric-value yellow">$${arppu}</div></div>
        </div>

        <button class="src-users-btn"
                data-kind="${Fmt.escapeHtml(block.kind)}"
                data-key="${Fmt.escapeHtml(blockKey(block))}"
                data-title="${Fmt.escapeHtml(titleLabel)}">
          View ${Fmt.intK(block.users)} user${block.users === 1 ? "" : "s"} →
        </button>
      </div>
    `;
  }

  function funnelRow(label, n, pct, fillCls) {
    return `<div class="funnel-row">
      <div class="funnel-label">${label}</div>
      <div class="funnel-bar"><div class="funnel-fill ${fillCls}" style="width:${pct}%"></div></div>
      <div class="funnel-val">${n} <span>·</span> ${pct}%</div>
    </div>`;
  }

  function controlsHtml(state) {
    const r = state.range;
    const presets = [
      { id: "today", label: "Today" },
      { id: "week",  label: "7 days" },
      { id: "month", label: "30 days" },
      { id: "all",   label: "All time" },
    ];
    const presetBtns = presets.map(p =>
      `<button class="btn btn-xs ${r.preset === p.id ? "btn-primary" : ""}" data-preset="${p.id}">${p.label}</button>`
    ).join("");
    return `
      <div class="src-toolbar">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">${presetBtns}</div>
        <div style="display:flex;gap:6px;align-items:center">
          <input class="input" type="date" id="src-from" value="${isoToInput(r.from)}" aria-label="From date" style="width:140px">
          <span style="color:var(--admin-muted)">→</span>
          <input class="input" type="date" id="src-to"   value="${isoToInput(r.to)}"   aria-label="To date"   style="width:140px">
          <button class="btn btn-sm btn-primary" id="src-apply">Apply</button>
        </div>
      </div>
    `;
  }

  window.AdminPages.sources = {
    title: "Sources",
    icon: ICON,
    render: async function (host, ctx) {
      const state = (ctx.tab.sourcesState = ctx.tab.sourcesState || {
        range: presetToRange("week"),
        tab:   "all",
      });

      host.innerHTML = `
        <div class="page-hdr">
          <div><h1>Sources</h1><div class="sub" id="src-sub">UTM / referrer / partner funnel · ${rangeLabel(state.range)}</div></div>
          <div class="actions"><button class="btn btn-sm btn-ghost" id="src-refresh">Refresh</button></div>
        </div>

        <div id="src-controls">${controlsHtml(state)}</div>

        <div style="display:flex;gap:6px;flex-wrap:wrap;margin:14px 0 16px" id="src-tabs">
          ${TABS.map(t => `<button class="btn btn-xs ${state.tab === t.id ? "btn-primary" : ""}" data-tab="${t.id}">${t.label}</button>`).join("")}
        </div>

        <div id="src-content"><div class="loading-state"><div class="spinner"></div>Loading sources…</div></div>
      `;

      const subEl     = host.querySelector("#src-sub");
      const tabsEl    = host.querySelector("#src-tabs");
      const contentEl = host.querySelector("#src-content");
      const refresh   = host.querySelector("#src-refresh");

      function wireControls() {
        host.querySelectorAll("[data-preset]").forEach(b => {
          b.addEventListener("click", () => { state.range = presetToRange(b.dataset.preset); load(); });
        });
        host.querySelector("#src-apply").addEventListener("click", () => {
          const fromEl = host.querySelector("#src-from");
          const toEl   = host.querySelector("#src-to");
          const from = inputToIso(fromEl.value, "start");
          const to   = inputToIso(toEl.value, "end");
          state.range = { preset: "custom", from, to };
          load();
        });
      }
      function wireTabs() {
        tabsEl.querySelectorAll("[data-tab]").forEach(b => {
          b.addEventListener("click", () => { state.tab = b.dataset.tab; rerenderTab(); });
        });
      }

      let lastData = null;

      function rerenderTab() {
        tabsEl.querySelectorAll("[data-tab]").forEach(b => b.classList.toggle("btn-primary", b.dataset.tab === state.tab));
        if (!lastData) return;
        const blocks = collectBlocks(lastData, state.tab);
        if (!blocks.length) {
          contentEl.innerHTML = `<div class="empty-state"><div class="big">·</div>No users in this bucket for the selected range</div>`;
          return;
        }
        contentEl.innerHTML = `<div class="src-grid">${blocks.map(renderCard).join("")}</div>`;
        contentEl.querySelectorAll(".src-users-btn").forEach(btn => {
          btn.addEventListener("click", () => {
            ctx.push({
              pageKey: "sourceUsers",
              params: {
                kind: btn.dataset.kind,
                key:  btn.dataset.key,
                title: btn.dataset.title,
                from: state.range.from,
                to:   state.range.to,
                rangeLabel: rangeLabel(state.range),
              },
            });
          });
        });
      }

      function collectBlocks(d, tab) {
        const out = [];
        if (tab === "all") {
          if (d.all)   out.push(buildBlock(d.all,   "all"));
          if (d.organic && d.organic.users > 0) out.push(buildBlock(d.organic, "organic"));
          for (const s of d.sources)   out.push(buildBlock(s, "source"));
          for (const p of d.partners)  out.push(buildBlock(p, "partner"));
          for (const r of d.referrers) out.push(buildBlock(r, "referrer"));
        } else if (tab === "sources")   out.push(...d.sources.map(s => buildBlock(s, "source")));
        else if  (tab === "partners")   out.push(...d.partners.map(p => buildBlock(p, "partner")));
        else if  (tab === "referrers")  out.push(...d.referrers.map(r => buildBlock(r, "referrer")));
        return out.filter(Boolean);
      }

      async function load() {
        contentEl.innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading sources…</div>`;
        subEl.textContent = `UTM / referrer / partner funnel · ${rangeLabel(state.range)}`;
        try {
          const params = new URLSearchParams();
          if (state.range.from) params.set("from", state.range.from);
          if (state.range.to)   params.set("to",   state.range.to);
          lastData = await Api.request("/stats/sources" + (params.toString() ? "?" + params.toString() : ""));
          host.querySelector("#src-controls").innerHTML = controlsHtml(state);
          wireControls();
          rerenderTab();
        } catch (err) {
          contentEl.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed")}</div>`;
        }
      }

      refresh.addEventListener("click", load);
      wireControls();
      wireTabs();
      await load();
    },
  };

  // ─── Source-users drill-down page ─────────────────────────────────────
  window.AdminPages.sourceUsers = {
    title: "Source users",
    icon: ICON,
    render: async function (host, ctx) {
      const { kind, key, title, from, to, rangeLabel } = ctx.params || {};
      ctx.tab.title = (title || "Source users") + " · users";
      window.TabBar.refresh();

      host.innerHTML = `
        <div class="page-hdr">
          <div><h1>${Fmt.escapeHtml(title || "Source users")}</h1>
            <div class="sub" id="su-sub">Loading…</div>
          </div>
          <div class="actions"><button class="btn btn-sm btn-ghost" id="su-refresh">Refresh</button></div>
        </div>
        <div id="su-content"><div class="loading-state"><div class="spinner"></div>Loading users…</div></div>
      `;

      const subEl     = host.querySelector("#su-sub");
      const contentEl = host.querySelector("#su-content");

      async function load() {
        contentEl.innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading users…</div>`;
        try {
          const params = new URLSearchParams();
          params.set("kind", kind || "all");
          if (key) params.set("key", key);
          if (from) params.set("from", from);
          if (to)   params.set("to",   to);
          const data = await Api.request("/stats/sources/users?" + params.toString());
          subEl.textContent = `${data.count} user${data.count === 1 ? "" : "s"} · registered · ${rangeLabel || "all time"}`;
          if (!data.users.length) {
            contentEl.innerHTML = `<div class="empty-state"><div class="big">·</div>No users in this bucket</div>`;
            return;
          }
          contentEl.innerHTML = `
            <div class="tbl-wrap">
              <table class="tbl">
                <thead>
                  <tr>
                    <th></th><th>Name</th><th>Telegram ID</th>
                    <th>Funnel</th><th style="text-align:right">Revenue</th>
                    <th style="text-align:right">Balance</th><th>Joined</th>
                  </tr>
                </thead>
                <tbody>
                  ${data.users.map(u => {
                    const display = u.firstName || u.username || ("User " + u.id);
                    const flags = [
                      u.hasApp   ? '<span class="badge accent">app</span>' : "",
                      u.hasPlan  ? '<span class="badge">plan</span>' : "",
                      u.hasBuilt ? '<span class="badge success">built</span>' : "",
                    ].join(" ");
                    return `
                      <tr class="clickable" data-uid="${u.id}">
                        <td style="width:40px">${Avatar.lazyAvatarHtml({ kind: "user", id: u.telegramId, name: display, seed: u.id, size: 32 })}</td>
                        <td>
                          <div style="font-weight:600">${Fmt.escapeHtml(display)}</div>
                          ${u.username ? `<div style="color:var(--admin-muted);font-size:11px">@${Fmt.escapeHtml(u.username)}</div>` : ""}
                        </td>
                        <td><code style="color:var(--admin-muted)">${Fmt.escapeHtml(u.telegramId)}</code></td>
                        <td>${flags || '<span style="color:var(--admin-muted)">—</span>'}</td>
                        <td style="text-align:right;color:${Number(u.revenue) > 0 ? "var(--success-color, #5CC377)" : "var(--admin-muted)"}">${Fmt.money(u.revenue)}</td>
                        <td style="text-align:right">${Fmt.money(u.balance)}</td>
                        <td style="color:var(--admin-muted)" title="${Fmt.escapeHtml(Fmt.date(u.createdAt))}">${Fmt.escapeHtml(Fmt.relativeTime(u.createdAt))}</td>
                      </tr>`;
                  }).join("")}
                </tbody>
              </table>
            </div>`;
          contentEl.querySelectorAll("tr[data-uid]").forEach(row => {
            row.addEventListener("click", e => {
              const uid = row.dataset.uid;
              if (e.metaKey || e.ctrlKey || e.button === 1) {
                window.TabBar.openTab({ pageKey: "user", params: { id: uid }, focus: false, reuseSamePage: false });
              } else {
                ctx.push({ pageKey: "user", params: { id: uid } });
              }
            });
          });
        } catch (err) {
          contentEl.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed")}</div>`;
        }
      }
      host.querySelector("#su-refresh").addEventListener("click", load);
      await load();
    },
  };
})();
