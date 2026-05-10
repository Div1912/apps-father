/* Balance Ledger — global transaction log.
   Reads from /admin/api/ledger with filter params:
   currency, source, userId, from, to, page. */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`;

  const PAGE_SIZE = 50;

  const SOURCES = [
    "payment", "agent_usage", "refund", "admin_grant",
    "referral_bonus", "first_deposit_bonus", "sub_bonus",
    "task", "cashback", "ton_topup", "swap_buy", "swap_sell",
    "feature_purchase",
  ];

  // Each source has an icon, label, and color
  const SOURCE_META = {
    payment:             { icon: "💳", label: "Payment",           color: "#4ade80", bg: "rgba(74,222,128,0.12)",  border: "rgba(74,222,128,0.28)"  },
    agent_usage:         { icon: "🤖", label: "Agent Usage",       color: "#f87171", bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.28)" },
    refund:              { icon: "↩️", label: "Refund",            color: "#fbbf24", bg: "rgba(251,191,36,0.12)",  border: "rgba(251,191,36,0.28)"  },
    admin_grant:         { icon: "🛡️", label: "Admin Grant",       color: "#a78bfa", bg: "rgba(167,139,250,0.12)", border: "rgba(167,139,250,0.28)" },
    referral_bonus:      { icon: "🔗", label: "Referral",          color: "#60a5fa", bg: "rgba(96,165,250,0.12)",  border: "rgba(96,165,250,0.28)"  },
    first_deposit_bonus: { icon: "🎁", label: "First Deposit",     color: "#34d399", bg: "rgba(52,211,153,0.12)",  border: "rgba(52,211,153,0.28)"  },
    sub_bonus:           { icon: "⭐", label: "Sub Bonus",         color: "#34d399", bg: "rgba(52,211,153,0.12)",  border: "rgba(52,211,153,0.28)"  },
    task:                { icon: "✅", label: "Task",              color: "#86efac", bg: "rgba(134,239,172,0.12)", border: "rgba(134,239,172,0.28)" },
    cashback:            { icon: "💰", label: "Cashback",          color: "#fbbf24", bg: "rgba(251,191,36,0.12)",  border: "rgba(251,191,36,0.28)"  },
    ton_topup:           { icon: "💎", label: "TON Top-up",        color: "#60a5fa", bg: "rgba(96,165,250,0.12)",  border: "rgba(96,165,250,0.28)"  },
    swap_buy:            { icon: "📈", label: "Swap Buy",          color: "#4ade80", bg: "rgba(74,222,128,0.12)",  border: "rgba(74,222,128,0.28)"  },
    swap_sell:           { icon: "📉", label: "Swap Sell",         color: "#f87171", bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.28)" },
    feature_purchase:    { icon: "🔓", label: "Feature",           color: "#a78bfa", bg: "rgba(167,139,250,0.12)", border: "rgba(167,139,250,0.28)" },
  };

  function sourceBadge(source) {
    const m = SOURCE_META[source] || { icon: "·", label: source, color: "#94a3b8", bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.22)" };
    return `<span style="display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 9px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:.03em;background:${m.bg};color:${m.color};border:1px solid ${m.border};white-space:nowrap">${m.icon} ${Fmt.escapeHtml(m.label)}</span>`;
  }

  // Format a numeric amount with smart precision
  function fmtAmount(amount) {
    const abs = Math.abs(amount);
    if (abs === 0) return "0";
    if (abs >= 1000000) return (amount / 1000000).toFixed(2) + "M";
    if (abs >= 1000)    return (amount / 1000).toFixed(2) + "K";
    if (abs >= 1)       return amount.toFixed(2);
    if (abs >= 0.0001)  return amount.toFixed(6);
    return amount.toExponential(3);
  }

  function currencyTag(currency) {
    const c = currency.toUpperCase();
    const special = { CREDITS: { color: "#fbbf24", bg: "rgba(251,191,36,0.10)" }, TON: { color: "#60a5fa", bg: "rgba(96,165,250,0.10)" }, USD: { color: "#4ade80", bg: "rgba(74,222,128,0.10)" } };
    const s = special[c] || { color: "#94a3b8", bg: "rgba(148,163,184,0.10)" };
    return `<span style="display:inline-flex;align-items:center;height:17px;padding:0 6px;border-radius:4px;font-size:10px;font-weight:700;letter-spacing:.06em;background:${s.bg};color:${s.color}">${Fmt.escapeHtml(c)}</span>`;
  }

  function amountCell(amount, currency) {
    const pos = amount >= 0;
    const sign = pos ? "+" : "−";
    const color = pos ? "#4ade80" : "#f87171";
    return `<div style="display:flex;align-items:center;gap:6px;justify-content:flex-end">
      <span style="font-weight:700;color:${color};font-variant-numeric:tabular-nums;font-size:13px">${sign}${fmtAmount(Math.abs(amount))}</span>
      ${currencyTag(currency)}
    </div>`;
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    const datePart = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", ...(!sameYear ? { year: "2-digit" } : {}) });
    const timePart = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    return `<div style="line-height:1.25">
      <div style="font-size:12px;font-weight:500">${datePart}</div>
      <div style="font-size:11px;color:var(--admin-muted)">${timePart}</div>
    </div>`;
  }

  function userLink(user) {
    if (!user) return `<span style="color:var(--admin-muted)">—</span>`;
    const name = user.username ? "@" + user.username : user.firstName || ("#" + (user.telegramId || user.id));
    return `<a href="/admin/users/${user.id}" style="color:var(--admin-accent);text-decoration:none;font-weight:500">${Fmt.escapeHtml(name)}</a>`;
  }

  function metaHint(meta) {
    if (!meta || Object.keys(meta).length === 0) return "";
    // Render key snippets inline, full JSON on hover
    const tip = JSON.stringify(meta, null, 2);
    const snippets = Object.entries(meta).slice(0, 2).map(([k, v]) => {
      const val = String(v).length > 18 ? String(v).slice(0, 16) + "…" : String(v);
      return `<span style="color:var(--admin-muted);font-size:10px">${Fmt.escapeHtml(k)}: <span style="color:var(--admin-fg)">${Fmt.escapeHtml(val)}</span></span>`;
    }).join("  ");
    return `<div title="${Fmt.escapeHtml(tip)}" style="cursor:help;margin-top:3px;display:flex;gap:8px;flex-wrap:wrap">${snippets}</div>`;
  }

  window.AdminPages.ledger = {
    title: "Ledger",
    icon: ICON,
    render: async function (host, ctx) {
      const state = (ctx.tab.ledgerState = ctx.tab.ledgerState || {
        page: 1,
        filterCurrency: "",
        filterSource: "",
        filterUser: "",
        filterFrom: "",
        filterTo: "",
      });

      host.innerHTML = `
        <div class="page-hdr">
          <div>
            <h1>Balance Ledger</h1>
            <div class="sub">Unified log of every credit, TON, and token balance change</div>
          </div>
          <div class="actions">
            <button class="btn btn-sm btn-ghost" id="ledger-refresh">Refresh</button>
          </div>
        </div>

        <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px;align-items:center">
          <select id="f-currency" class="input input-sm" style="width:140px">
            <option value="">All currencies</option>
            <option value="credits">Credits</option>
            <option value="TON">TON</option>
            <option value="USD">USD</option>
          </select>
          <select id="f-source" class="input input-sm" style="width:170px">
            <option value="">All sources</option>
            ${SOURCES.map(s => `<option value="${s}">${(SOURCE_META[s] || {}).icon || ""} ${(SOURCE_META[s] || {}).label || s}</option>`).join("")}
          </select>
          <input id="f-user" class="input input-sm" placeholder="User ID" style="width:90px" type="number">
          <input id="f-from" class="input input-sm" type="date" style="width:140px" title="From date">
          <input id="f-to"   class="input input-sm" type="date" style="width:140px" title="To date">
          <button class="btn btn-sm btn-primary" id="ledger-apply">Apply</button>
          <button class="btn btn-sm btn-ghost"   id="ledger-reset">Reset</button>
          <span id="ledger-count" style="margin-left:auto;color:var(--admin-muted);font-size:12px"></span>
        </div>

        <div id="ledger-table-wrap"></div>
        <div id="ledger-pagination" style="display:flex;gap:8px;align-items:center;margin-top:16px"></div>
      `;

      const wrap    = host.querySelector("#ledger-table-wrap");
      const pgEl    = host.querySelector("#ledger-pagination");
      const countEl = host.querySelector("#ledger-count");

      host.querySelector("#f-currency").value = state.filterCurrency;
      host.querySelector("#f-source").value   = state.filterSource;
      host.querySelector("#f-user").value      = state.filterUser;
      host.querySelector("#f-from").value      = state.filterFrom;
      host.querySelector("#f-to").value        = state.filterTo;

      async function load() {
        wrap.innerHTML = `<div class="loading">Loading…</div>`;
        countEl.textContent = "";

        const params = new URLSearchParams({ page: state.page, limit: PAGE_SIZE });
        if (state.filterCurrency) params.set("currency", state.filterCurrency);
        if (state.filterSource)   params.set("source",   state.filterSource);
        if (state.filterUser)     params.set("userId",   state.filterUser);
        if (state.filterFrom)     params.set("from",     state.filterFrom);
        if (state.filterTo)       params.set("to",       state.filterTo + "T23:59:59");

        let data;
        try {
          data = await Api.request("/ledger?" + params);
        } catch (e) {
          wrap.innerHTML = `<div class="error-msg">${Fmt.escapeHtml(String(e))}</div>`;
          return;
        }

        if (!data.rows || data.rows.length === 0) {
          wrap.innerHTML = `<div class="empty-msg">No transactions found.</div>`;
          pgEl.innerHTML = "";
          return;
        }

        countEl.textContent = `${data.total.toLocaleString()} transactions`;

        const rows = data.rows.map(r => `
          <tr style="border-bottom:1px solid var(--admin-divider)">
            <td style="padding:10px 12px;vertical-align:top;white-space:nowrap">${fmtDate(r.date)}</td>
            <td style="padding:10px 12px;vertical-align:top">${userLink(r.user)}</td>
            <td style="padding:10px 12px;vertical-align:top;text-align:right">${amountCell(r.amount, r.currency)}</td>
            <td style="padding:10px 12px;vertical-align:top">
              ${sourceBadge(r.source)}
              ${metaHint(r.meta)}
            </td>
          </tr>
        `).join("");

        wrap.innerHTML = `
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="border-bottom:2px solid var(--admin-divider)">
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--admin-muted);white-space:nowrap">Date</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--admin-muted)">User</th>
                <th style="padding:8px 12px;text-align:right;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--admin-muted)">Amount</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--admin-muted)">Source</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        `;

        // Add hover effect rows
        wrap.querySelectorAll("tbody tr").forEach(tr => {
          tr.style.transition = "background 0.1s";
          tr.addEventListener("mouseenter", () => tr.style.background = "rgba(255,255,255,0.03)");
          tr.addEventListener("mouseleave", () => tr.style.background = "");
        });

        // Pagination
        pgEl.innerHTML = "";
        if (data.pages <= 1) return;

        const addBtn = (label, page, disabled) => {
          const b = document.createElement("button");
          b.className = "btn btn-sm btn-ghost";
          b.textContent = label;
          b.disabled = disabled;
          b.onclick = () => { state.page = page; load(); };
          pgEl.appendChild(b);
        };
        addBtn("← Prev", state.page - 1, state.page <= 1);
        const info = document.createElement("span");
        info.style.cssText = "color:var(--admin-muted);font-size:12px;padding:0 4px";
        info.textContent = `Page ${state.page} of ${data.pages}`;
        pgEl.appendChild(info);
        addBtn("Next →", state.page + 1, state.page >= data.pages);
      }

      host.querySelector("#ledger-refresh").onclick = () => load();

      host.querySelector("#ledger-apply").onclick = () => {
        state.page = 1;
        state.filterCurrency = host.querySelector("#f-currency").value;
        state.filterSource   = host.querySelector("#f-source").value;
        state.filterUser     = host.querySelector("#f-user").value.trim();
        state.filterFrom     = host.querySelector("#f-from").value;
        state.filterTo       = host.querySelector("#f-to").value;
        load();
      };

      host.querySelector("#ledger-reset").onclick = () => {
        state.page = 1;
        state.filterCurrency = state.filterSource = state.filterUser = state.filterFrom = state.filterTo = "";
        host.querySelector("#f-currency").value = "";
        host.querySelector("#f-source").value   = "";
        host.querySelector("#f-user").value      = "";
        host.querySelector("#f-from").value      = "";
        host.querySelector("#f-to").value        = "";
        load();
      };

      load();
    },
  };
})();
