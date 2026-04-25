/* ── Dashboard page: KPI grid + time-series + recent activity ──
   Date-range picker (presets + custom) drives both the KPI snapshot and the
   six time-series charts. Time-series sits *above* the recent-activity log so
   admins land on the most actionable numbers first. */
(function () {
  "use strict";

  window.AdminPages = window.AdminPages || {};

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`;

  // ── Range helpers (mirror sources.js so the two pages feel identical) ──
  function startOfTodayISO()    { const d = new Date(); d.setHours(0,0,0,0); return d.toISOString(); }
  function endOfTodayISO()      { const d = new Date(); d.setHours(23,59,59,999); return d.toISOString(); }
  function startNDaysAgoISO(n)  { const d = new Date(); d.setDate(d.getDate()-n); d.setHours(0,0,0,0); return d.toISOString(); }
  function presetToRange(p) {
    if (p === "today")   return { preset: p, from: startOfTodayISO(),   to: endOfTodayISO() };
    if (p === "week")    return { preset: p, from: startNDaysAgoISO(6), to: endOfTodayISO() };
    if (p === "month")   return { preset: p, from: startNDaysAgoISO(29),to: endOfTodayISO() };
    if (p === "quarter") return { preset: p, from: startNDaysAgoISO(89),to: endOfTodayISO() };
    return { preset: "all", from: null, to: null };
  }
  function isoToInput(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    const yyyy = d.getFullYear(), mm = String(d.getMonth()+1).padStart(2,"0"), dd = String(d.getDate()).padStart(2,"0");
    return `${yyyy}-${mm}-${dd}`;
  }
  function inputToIso(value, edge) {
    if (!value) return null;
    const [y, m, d] = value.split("-").map(Number);
    if (!y || !m || !d) return null;
    const dt = new Date(y, m-1, d, edge === "end" ? 23 : 0, edge === "end" ? 59 : 0, edge === "end" ? 59 : 0, edge === "end" ? 999 : 0);
    return dt.toISOString();
  }
  function rangeLabel(r) {
    if (r.preset === "today")   return "today";
    if (r.preset === "week")    return "last 7 days";
    if (r.preset === "month")   return "last 30 days";
    if (r.preset === "quarter") return "last 90 days";
    if (r.preset === "all" || (!r.from && !r.to)) return "all time";
    return `${isoToInput(r.from) || "?"} → ${isoToInput(r.to) || "?"}`;
  }

  function autoInterval(range) {
    if (!range.from && !range.to) return "month";
    const fromMs = new Date(range.from).getTime();
    const toMs   = new Date(range.to).getTime();
    const days   = Math.max(1, Math.round((toMs - fromMs) / 86400000));
    if (days <= 2)  return "hour";
    if (days <= 60) return "day";
    if (days <= 365) return "week";
    return "month";
  }

  function controlsHtml(state) {
    const r = state.range;
    const presets = [
      { id: "today",   label: "Today" },
      { id: "week",    label: "7d" },
      { id: "month",   label: "30d" },
      { id: "quarter", label: "90d" },
      { id: "all",     label: "All time" },
    ];
    const presetBtns = presets.map(p =>
      `<button class="btn btn-xs ${r.preset === p.id ? "btn-primary" : ""}" data-preset="${p.id}">${p.label}</button>`
    ).join("");
    const intervalOpts = ["hour","day","week","month"]
      .map(k => `<option value="${k}" ${state.interval === k ? "selected" : ""}>${k}</option>`).join("");
    return `
      <div class="src-toolbar">
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">${presetBtns}</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <input class="input" type="date" id="dash-from" value="${isoToInput(r.from)}" aria-label="From date" style="width:140px">
          <span style="color:var(--admin-muted)">→</span>
          <input class="input" type="date" id="dash-to"   value="${isoToInput(r.to)}"   aria-label="To date"   style="width:140px">
          <button class="btn btn-sm btn-primary" id="dash-apply">Apply</button>
          <span style="color:var(--admin-muted);font-size:12px;margin-left:8px">Bucket:</span>
          <select class="select" id="dash-interval" style="width:auto">${intervalOpts}</select>
        </div>
      </div>
    `;
  }

  const METRICS = [
    { id: "new_users",     title: "New Users",     color: "#a48bff", fmt: (v) => Fmt.intK(v) },
    { id: "paying_users",  title: "Paying Users",  color: "#5cc377", fmt: (v) => Fmt.intK(v) },
    { id: "conversion",    title: "Conversion %",  color: "#38b2e0", fmt: (v) => v.toFixed(1) + "%" },
    { id: "new_projects",  title: "New Apps",      color: "#ff8aa3", fmt: (v) => Fmt.intK(v) },
    { id: "revenue",       title: "Revenue",       color: "#ffb800", fmt: (v) => "$" + v.toFixed(2) },
    { id: "service_costs", title: "Service Costs", color: "#ff6b6b", fmt: (v) => "$" + v.toFixed(2) },
  ];

  window.AdminPages.dashboard = {
    title: "Dashboard",
    icon: ICON,
    render: async function (host, ctx) {
      const state = (ctx.state.dash = ctx.state.dash || {
        range:    presetToRange("week"),
        interval: "day",
      });
      // Auto-pick interval the first time a new range is chosen, but let the
      // user override via the dropdown.
      if (!state._intervalLocked) state.interval = autoInterval(state.range);

      host.innerHTML = `
        <div class="page-hdr">
          <div>
            <h1>Dashboard</h1>
            <div class="sub" id="dash-sub">Overview · ${rangeLabel(state.range)}</div>
          </div>
          <div class="actions">
            <button class="btn btn-sm btn-ghost" id="dash-refresh">Refresh</button>
          </div>
        </div>

        <div id="dash-controls">${controlsHtml(state)}</div>

        <div class="kpi-grid" id="dash-kpis" style="margin-top:14px">
          ${kpiSkeleton()}
        </div>

        <div class="dash-recent-title">Time-series</div>
        <div class="charts-grid charts-grid-2col" id="charts-grid"></div>

        <div class="dash-recent-title" style="margin-top:32px">Cost &amp; Tokens by Operation</div>
        <div class="ops-grid">
          <div class="card" id="ops-cost-card">
            <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">
              <span>Spend by operation</span>
              <span class="ops-total" id="ops-cost-total">—</span>
            </div>
            <div id="ops-cost-body"><div class="loading-state"><div class="spinner"></div>Loading…</div></div>
          </div>
          <div class="card" id="ops-tok-card">
            <div class="card-title" style="display:flex;align-items:center;justify-content:space-between">
              <span>Tokens by operation</span>
              <span class="ops-total" id="ops-tok-total">—</span>
            </div>
            <div id="ops-tok-body"><div class="loading-state"><div class="spinner"></div>Loading…</div></div>
          </div>
        </div>

        <div class="dash-recent-title" style="margin-top:32px">Recent Activity</div>
        <div id="dash-activity">
          <div class="loading-state"><div class="spinner"></div>Loading recent activity…</div>
        </div>
      `;

      const refreshBtn = host.querySelector("#dash-refresh");
      const subEl      = host.querySelector("#dash-sub");
      const kpisEl     = host.querySelector("#dash-kpis");
      const actEl      = host.querySelector("#dash-activity");
      const chartsEl   = host.querySelector("#charts-grid");
      const opsCostEl  = host.querySelector("#ops-cost-body");
      const opsTokEl   = host.querySelector("#ops-tok-body");
      const opsCostTot = host.querySelector("#ops-cost-total");
      const opsTokTot  = host.querySelector("#ops-tok-total");

      function rangeQuery() {
        const params = new URLSearchParams();
        if (state.range.from) params.set("from", state.range.from);
        if (state.range.to)   params.set("to",   state.range.to);
        return params.toString() ? `?${params.toString()}` : "";
      }

      async function loadKpisAndActivity() {
        kpisEl.innerHTML = kpiSkeleton();
        actEl.innerHTML  = `<div class="loading-state"><div class="spinner"></div>Loading recent activity…</div>`;
        try {
          const data = await Api.request("/stats" + rangeQuery());
          renderKpis(kpisEl, data);
          renderActivity(actEl, data.recentUsage || []);
        } catch (err) {
          kpisEl.innerHTML = "";
          actEl.innerHTML = `<div class="error-state"><div class="big">!</div>Failed to load: ${Fmt.escapeHtml(err.message || String(err))}</div>`;
        }
      }

      const charts = {};
      async function renderCharts() {
        // Render skeleton card per metric.
        chartsEl.innerHTML = METRICS.map(m => `
          <div class="chart-card" data-metric="${m.id}">
            <div class="chart-title">
              <span class="chart-title-text">${m.title}</span>
              <span class="chart-total" id="chart-total-${m.id}">—</span>
            </div>
            <div class="chart-canvas-wrap"><canvas id="canvas-${m.id}"></canvas></div>
          </div>
        `).join("");

        if (!window.Chart) {
          chartsEl.innerHTML = `<div class="error-state"><div class="big">!</div>Chart.js failed to load. Check your network.</div>`;
          return;
        }

        // For "all time" we don't pass from/to so the backend picks a sensible
        // default window for each metric.
        const baseParams = (key) => {
          const p = new URLSearchParams({ metric: key, interval: state.interval });
          if (state.range.from) p.set("from", state.range.from);
          if (state.range.to)   p.set("to",   state.range.to);
          return p.toString();
        };

        for (const m of METRICS) {
          try {
            const data   = await Api.request("/timeseries?" + baseParams(m.id));
            const labels = data.buckets.map(b => formatBucket(b.ts, state.interval));
            const values = data.buckets.map(b => Number(b.value) || 0);
            const total  = m.id === "conversion"
              ? (values.reduce((a, b) => a + b, 0) / Math.max(1, values.length))
              : values.reduce((a, b) => a + b, 0);
            host.querySelector("#chart-total-" + m.id).textContent = m.fmt(total);

            const ctxC = host.querySelector("#canvas-" + m.id).getContext("2d");
            if (charts[m.id]) charts[m.id].destroy();
            const grad = ctxC.createLinearGradient(0, 0, 0, 160);
            grad.addColorStop(0, m.color + "55");
            grad.addColorStop(1, m.color + "00");

            const isLight = document.documentElement.getAttribute("data-theme") === "light";
            const tickColor = isLight ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.4)";
            const gridColor = isLight ? "rgba(0,0,0,0.05)" : "rgba(255,255,255,0.05)";

            charts[m.id] = new window.Chart(ctxC, {
              type: "line",
              data: {
                labels,
                datasets: [{
                  label: m.title,
                  data: values,
                  borderColor: m.color,
                  backgroundColor: grad,
                  borderWidth: 2,
                  tension: 0.32,
                  pointRadius: 0,
                  pointHoverRadius: 4,
                  fill: true,
                }],
              },
              options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: { mode: "index", intersect: false },
                plugins: {
                  legend: { display: false },
                  tooltip: {
                    enabled: true,
                    backgroundColor: "rgba(20,20,28,0.95)",
                    titleColor: "#fff",
                    bodyColor: "#ddd",
                    borderColor: m.color,
                    borderWidth: 1,
                    padding: 10,
                    titleFont: { weight: "600" },
                    bodySpacing: 4,
                    callbacks: {
                      label: (c) => `${m.title}: ${m.fmt(c.parsed.y)}`,
                    },
                  },
                },
                hover: { mode: "index", intersect: false },
                scales: {
                  x: { ticks: { color: tickColor, maxTicksLimit: 7 }, grid: { display: false } },
                  y: {
                    ticks: { color: tickColor, callback: (v) => m.fmt(v) },
                    grid: { color: gridColor },
                    beginAtZero: true,
                  },
                },
              },
            });
          } catch (err) {
            const wrap = host.querySelector(`[data-metric="${m.id}"] .chart-canvas-wrap`);
            if (wrap) wrap.innerHTML = `<div style="padding:14px;color:var(--admin-muted);font-size:12px">${Fmt.escapeHtml(err.message || "Failed")}</div>`;
          }
        }
      }

      async function loadOps() {
        opsCostEl.innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading…</div>`;
        opsTokEl.innerHTML  = `<div class="loading-state"><div class="spinner"></div>Loading…</div>`;
        try {
          const data = await Api.request("/stats/operations" + rangeQuery());
          const rows = data.rows || [];
          renderOps(opsCostEl, opsCostTot, rows, "cost");
          renderOps(opsTokEl,  opsTokTot,  rows, "tokens");
        } catch (err) {
          opsCostEl.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed")}</div>`;
          opsTokEl.innerHTML  = "";
        }
      }

      async function reloadAll() {
        subEl.textContent = "Overview · " + rangeLabel(state.range);
        await Promise.all([loadKpisAndActivity(), renderCharts(), loadOps()]);
      }

      function wireControls() {
        host.querySelectorAll("[data-preset]").forEach(b => {
          b.addEventListener("click", () => {
            state.range = presetToRange(b.dataset.preset);
            state._intervalLocked = false;
            state.interval = autoInterval(state.range);
            host.querySelector("#dash-controls").innerHTML = controlsHtml(state);
            wireControls();
            reloadAll();
          });
        });
        host.querySelector("#dash-apply").addEventListener("click", () => {
          const fromEl = host.querySelector("#dash-from");
          const toEl   = host.querySelector("#dash-to");
          state.range = {
            preset: "custom",
            from:   inputToIso(fromEl.value, "start"),
            to:     inputToIso(toEl.value, "end"),
          };
          state._intervalLocked = false;
          state.interval = autoInterval(state.range);
          host.querySelector("#dash-controls").innerHTML = controlsHtml(state);
          wireControls();
          reloadAll();
        });
        host.querySelector("#dash-interval").addEventListener("change", (e) => {
          state.interval = e.target.value;
          state._intervalLocked = true;
          renderCharts();
        });
      }

      wireControls();
      refreshBtn.addEventListener("click", reloadAll);

      // Lazy-load Chart.js once per session.
      if (!window.Chart && !window.__chartLoadPromise) {
        window.__chartLoadPromise = new Promise((resolve, reject) => {
          const s = document.createElement("script");
          s.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js";
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
      }
      if (window.__chartLoadPromise) {
        try { await window.__chartLoadPromise; } catch (_) {}
      }

      await reloadAll();
    },
  };

  function formatBucket(iso, interval) {
    const d = new Date(iso);
    if (interval === "hour")  return d.toLocaleString("en-US", { hour: "2-digit", day: "2-digit", month: "short" });
    if (interval === "month") return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function kpiSkeleton() {
    return Array.from({ length: 4 }).map(() => `
      <div class="kpi-card">
        <div class="label">Loading…</div>
        <div class="value">—</div>
      </div>
    `).join("");
  }

  function renderKpis(el, d) {
    const items = [
      { label: "Users",          icon: iconUsers,    value: Fmt.intK(d.userCount), cls: "accent" },
      { label: "Apps",           icon: iconApps,     value: Fmt.intK(d.projectCount), cls: "" },
      { label: "Total Revenue",  icon: iconCash,     value: Fmt.money(d.totalTopups, 2), cls: "green" },
      { label: "Service Cost",   icon: iconBolt,     value: Fmt.money(d.totalSpent, 2), cls: "warn" },
    ];
    el.innerHTML = items.map(it => `
      <div class="kpi-card">
        <div class="label">${it.icon}<span>${Fmt.escapeHtml(it.label)}</span></div>
        <div class="value ${it.cls}">${Fmt.escapeHtml(it.value)}</div>
        <div class="delta">&nbsp;</div>
      </div>
    `).join("");
  }

  function renderActivity(el, rows) {
    if (!rows.length) {
      el.innerHTML = `<div class="empty-state"><div class="big">·</div>No activity in this range</div>`;
      return;
    }
    el.innerHTML = `
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>User</th>
              <th>App</th>
              <th>Operation</th>
              <th>Tokens (in / out)</th>
              <th>Cost</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => `
              <tr>
                <td>${Fmt.escapeHtml(r.username || "—")}</td>
                <td>${Fmt.escapeHtml(r.project || "—")}</td>
                <td><span class="badge">${Fmt.escapeHtml(r.operation || "—")}</span></td>
                <td style="color:var(--admin-muted)">${Fmt.intK(r.inputTokens || 0)} / ${Fmt.intK(r.outputTokens || 0)}</td>
                <td>${Fmt.money(r.cost || 0, 4)}</td>
                <td title="${Fmt.escapeHtml(Fmt.date(r.createdAt))}">${Fmt.escapeHtml(Fmt.relativeTime(r.createdAt))}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  // Color palette cycled per operation row in the breakdown panels.
  const OP_COLORS = ["#a48bff","#5cc377","#38b2e0","#ff8aa3","#ffb800","#ff6b6b","#7fc7ff","#ffc56e","#c084fc","#34d399"];

  function renderOps(host, totalEl, rows, kind) {
    if (!rows || !rows.length) {
      host.innerHTML = `<div class="empty-state"><div class="big">·</div>No usage in this range</div>`;
      totalEl.textContent = kind === "cost" ? "$0.00" : "0";
      return;
    }
    const get = kind === "cost"
      ? (r) => r.costUsd
      : (r) => (r.inputTokens || 0) + (r.outputTokens || 0);
    const fmt = kind === "cost"
      ? (n) => "$" + Number(n || 0).toFixed(2)
      : (n) => Fmt.intK(n);
    const total = rows.reduce((s, r) => s + get(r), 0) || 1;
    totalEl.textContent = fmt(total);

    const sorted = rows.slice().sort((a, b) => get(b) - get(a));
    host.innerHTML = `<ul class="ops-list">${sorted.map((r, i) => {
      const v = get(r);
      const pct = (v / total) * 100;
      const color = OP_COLORS[i % OP_COLORS.length];
      const subline = kind === "cost"
        ? `${Fmt.intK(r.count)} call${r.count === 1 ? "" : "s"} · ${Fmt.intK(r.inputTokens)} in / ${Fmt.intK(r.outputTokens)} out`
        : `${Fmt.intK(r.inputTokens)} in / ${Fmt.intK(r.outputTokens)} out · ${Fmt.intK(r.count)} call${r.count === 1 ? "" : "s"}`;
      return `
        <li class="ops-row" title="${Fmt.escapeHtml(r.operation)} · ${pct.toFixed(1)}%">
          <div class="ops-row-head">
            <span class="ops-name"><span class="ops-dot" style="background:${color}"></span>${Fmt.escapeHtml(r.operation)}</span>
            <span class="ops-val">${Fmt.escapeHtml(fmt(v))} <span class="ops-pct">${pct.toFixed(1)}%</span></span>
          </div>
          <div class="ops-bar"><div class="ops-bar-fill" style="width:${pct.toFixed(2)}%;background:${color}"></div></div>
          <div class="ops-sub">${Fmt.escapeHtml(subline)}</div>
        </li>`;
    }).join("")}</ul>`;
  }

  const iconUsers = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;
  const iconApps  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>`;
  const iconCash  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>`;
  const iconBolt  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`;
})();
