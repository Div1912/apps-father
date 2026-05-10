/* TON Withdrawals — auto-processed history log with retry for failed sends */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};

  const STATUS_META = {
    pending:  { label: "Processing…", color: "var(--warning-text-color)",  bg: "var(--warning-bg-color)"  },
    approved: { label: "Sent",        color: "var(--success-color)",       bg: "var(--success-bg-color)"  },
    failed:   { label: "Failed",      color: "var(--danger-text-color)",   bg: "var(--danger-bg-color)"   },
  };

  function statusBadge(status) {
    const m = STATUS_META[status] || { label: status, color: "var(--admin-muted)", bg: "var(--admin-card-bg)" };
    return `<span style="display:inline-flex;align-items:center;height:22px;padding:0 10px;border-radius:999px;font-size:11px;font-weight:700;background:${m.bg};color:${m.color}">${Fmt.escapeHtml(m.label)}</span>`;
  }

  function shortAddr(addr) {
    if (!addr) return "—";
    return addr.length > 12 ? addr.slice(0, 6) + "…" + addr.slice(-4) : addr;
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    const now = new Date();
    const sameYear = d.getFullYear() === now.getFullYear();
    const datePart = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", ...(!sameYear ? { year: "2-digit" } : {}) });
    const timePart = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    return `<div style="line-height:1.25"><div style="font-size:12px;font-weight:500">${datePart}</div><div style="font-size:11px;color:var(--admin-muted)">${timePart}</div></div>`;
  }

  window.AdminPages.withdrawals = {
    title: "Withdrawals",
    icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.4 19.4q-.5.2-.95-.09T3 18.5V14l8-2-8-2V5.5q0-.55.45-.84t.95-.09l15.4 6.5q.625.275.625.925t-.625.925z"/></svg>`,

    render(host, ctx) {
      let currentFilter = ctx.tab.wdFilter ?? "";
      let currentPage   = ctx.tab.wdPage  ?? 1;
      let totalPages    = 1;

      const FILTERS = [
        { key: "",         label: "All"      },
        { key: "pending",  label: "Pending"  },
        { key: "approved", label: "Sent"     },
        { key: "failed",   label: "Failed"   },
      ];

      host.innerHTML = `
        <div class="page-hdr">
          <div>
            <h1>TON Withdrawals</h1>
            <div class="sub">Auto-processed TON withdrawals from user balances to their wallets</div>
          </div>
          <div class="actions">
            <button class="btn btn-sm btn-ghost" id="wd-refresh">Refresh</button>
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap">
          ${FILTERS.map(f => `
            <button class="btn btn-sm wd-filter-btn ${f.key === currentFilter ? "btn-primary" : "btn-ghost"}"
              data-key="${f.key}">${f.label}</button>`).join("")}
        </div>

        <div id="wd-table-wrap">
          <div class="loading">Loading…</div>
        </div>
        <div id="wd-pagination" style="display:flex;gap:8px;align-items:center;margin-top:16px"></div>

        <!-- Manual retry dialog (for failed withdrawals) -->
        <dialog id="wd-retry-dlg" style="border-radius:12px;border:1px solid var(--admin-card-border);background:var(--header-bg-color);color:var(--admin-text);padding:28px;min-width:340px;box-shadow:var(--admin-shadow-lg)">
          <h3 style="margin:0 0 6px;font-size:17px">Retry Withdrawal</h3>
          <p id="wd-retry-desc" style="margin:0 0 6px;font-size:13px;color:var(--admin-muted)"></p>
          <p style="margin:0 0 18px;font-size:12px;color:var(--warning-text-color)">⚠ Ensure the hot wallet has enough TON before retrying.</p>
          <div style="display:flex;gap:10px">
            <button class="btn btn-ghost" id="wd-retry-cancel" style="flex:1">Cancel</button>
            <button class="btn btn-primary" id="wd-retry-confirm" style="flex:1">Retry Send</button>
          </div>
        </dialog>

        <!-- Manual refund dialog (for failed withdrawals) -->
        <dialog id="wd-refund-dlg" style="border-radius:12px;border:1px solid var(--admin-card-border);background:var(--header-bg-color);color:var(--admin-text);padding:28px;min-width:340px;box-shadow:var(--admin-shadow-lg)">
          <h3 style="margin:0 0 6px;font-size:17px">Refund to User Balance</h3>
          <p id="wd-refund-desc" style="margin:0 0 18px;font-size:13px;color:var(--admin-muted)"></p>
          <div style="display:flex;gap:10px">
            <button class="btn btn-ghost" id="wd-refund-cancel" style="flex:1">Cancel</button>
            <button class="btn" id="wd-refund-confirm" style="flex:1;background:var(--warning-text-color);color:#fff">Refund Balance</button>
          </div>
        </dialog>
      `;

      let pendingRetryId  = null;
      let pendingRefundId = null;

      const retryDlg  = host.querySelector("#wd-retry-dlg");
      const refundDlg = host.querySelector("#wd-refund-dlg");

      host.querySelector("#wd-retry-cancel").onclick  = () => retryDlg.close();
      host.querySelector("#wd-refund-cancel").onclick = () => refundDlg.close();
      host.querySelector("#wd-refresh").onclick       = () => loadPage();

      host.querySelector("#wd-retry-confirm").onclick = async () => {
        const btn = host.querySelector("#wd-retry-confirm");
        btn.disabled = true; btn.textContent = "Sending…";
        try {
          const r = await Api.request(`/ton-withdrawals/${pendingRetryId}/retry`, { method: "POST" });
          if (r.ok) { retryDlg.close(); setTimeout(loadPage, 2000); }
          else       { alert("Error: " + (r.error || "Failed")); }
        } finally { btn.disabled = false; btn.textContent = "Retry Send"; }
      };

      host.querySelector("#wd-refund-confirm").onclick = async () => {
        const btn = host.querySelector("#wd-refund-confirm");
        btn.disabled = true; btn.textContent = "Refunding…";
        try {
          const r = await Api.request(`/ton-withdrawals/${pendingRefundId}/refund`, { method: "POST" });
          if (r.ok) { refundDlg.close(); loadPage(); }
          else       { alert("Error: " + (r.error || "Failed")); }
        } finally { btn.disabled = false; btn.textContent = "Refund Balance"; }
      };

      // Filter tabs
      host.querySelectorAll(".wd-filter-btn").forEach(btn => {
        btn.onclick = () => {
          currentFilter = btn.dataset.key;
          currentPage = 1;
          ctx.tab.wdFilter = currentFilter;
          ctx.tab.wdPage   = currentPage;
          host.querySelectorAll(".wd-filter-btn").forEach(b => {
            b.className = "btn btn-sm wd-filter-btn " + (b.dataset.key === currentFilter ? "btn-primary" : "btn-ghost");
          });
          loadPage();
        };
      });

      async function loadPage() {
        const wrap  = host.querySelector("#wd-table-wrap");
        const pgEl  = host.querySelector("#wd-pagination");
        wrap.innerHTML = `<div class="loading">Loading…</div>`;
        pgEl.innerHTML = "";

        const params = new URLSearchParams({ page: currentPage, limit: 50 });
        if (currentFilter) params.set("status", currentFilter);

        let data;
        try { data = await Api.request(`/ton-withdrawals?${params}`); }
        catch (e) { wrap.innerHTML = `<div class="error-msg">${Fmt.escapeHtml(String(e))}</div>`; return; }

        totalPages = data.pages || 1;

        if (!data.rows || data.rows.length === 0) {
          wrap.innerHTML = `<div class="empty-msg">No ${currentFilter || ""} withdrawal records found.</div>`;
          return;
        }

        const failedCount = data.rows.filter(r => r.status === "failed").length;
        const banner = failedCount > 0 ? `
          <div style="display:flex;align-items:center;gap:10px;background:var(--danger-bg-color);border:1px solid rgba(var(--danger-color-rgb),0.3);border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:13px;color:var(--danger-text-color)">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span><strong>${failedCount} failed</strong> — use Retry to resend, or Refund to return TON balance to the user.</span>
          </div>` : "";

        const rows = data.rows.map(row => {
          const user     = row.user || {};
          const userName = user.username ? `@${Fmt.escapeHtml(user.username)}` : Fmt.escapeHtml(user.firstName || `ID ${user.telegramId || row.userId}`);
          const userLink = `<a href="/admin/users/${row.userId}" style="color:var(--accent-color);font-weight:500">${userName}</a>`;

          const txCell = row.txHash
            ? `<a href="https://tonviewer.com/transaction/${Fmt.escapeHtml(row.txHash)}" target="_blank" style="font-family:monospace;font-size:11px;color:var(--accent-color)">${row.txHash.slice(0,10)}…</a>`
            : `<span style="color:var(--admin-muted);font-size:11px">—</span>`;

          const noteCell = row.adminNote
            ? `<div style="max-width:180px;font-size:11px;color:var(--danger-text-color);white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${Fmt.escapeHtml(row.adminNote)}">${Fmt.escapeHtml(row.adminNote)}</div>`
            : "";

          const actions = row.status === "failed" ? `
            <div style="display:flex;gap:6px;flex-wrap:wrap">
              <button class="btn btn-sm wd-retry-btn"
                data-id="${row.id}"
                data-amount="${row.amountTon}"
                data-addr="${Fmt.escapeHtml(row.tonAddress)}"
                data-user="${Fmt.escapeHtml(userName)}"
                style="background:var(--success-bg-color);color:var(--success-color);border-color:transparent">↻ Retry</button>
              <button class="btn btn-sm wd-refund-btn"
                data-id="${row.id}"
                data-amount="${row.amountTon}"
                data-user="${Fmt.escapeHtml(userName)}"
                style="background:var(--warning-bg-color);color:var(--warning-text-color);border-color:transparent">↩ Refund</button>
            </div>` :
            `<span style="font-size:12px;color:var(--admin-muted)">${row.status === "approved" ? "Auto-sent" : "In progress…"}</span>`;

          return `
            <tr style="border-bottom:1px solid var(--admin-divider)">
              <td style="padding:11px 12px;color:var(--admin-muted);font-size:12px">#${row.id}</td>
              <td style="padding:11px 12px">${userLink}<div style="font-size:11px;color:var(--admin-muted)">ID ${row.userId}</div></td>
              <td style="padding:11px 12px;font-weight:700;color:var(--accent-color);font-size:14px">${Number(row.amountTon).toFixed(4)} TON</td>
              <td style="padding:11px 12px;font-size:11px">
                <span title="${Fmt.escapeHtml(row.tonAddress)}" style="cursor:help;color:var(--admin-text);font-family:monospace">${shortAddr(row.tonAddress)}</span>
                <button onclick="navigator.clipboard.writeText('${Fmt.escapeHtml(row.tonAddress)}')" class="btn btn-sm btn-ghost" style="margin-left:4px;padding:1px 7px;font-size:10px">Copy</button>
              </td>
              <td style="padding:11px 12px">${statusBadge(row.status)}${noteCell}</td>
              <td style="padding:11px 12px">${txCell}</td>
              <td style="padding:11px 12px">${fmtDate(row.createdAt)}</td>
              <td style="padding:11px 12px">${actions}</td>
            </tr>`;
        }).join("");

        wrap.innerHTML = `
          ${banner}
          <table style="width:100%;border-collapse:collapse;font-size:13px">
            <thead>
              <tr style="border-bottom:2px solid var(--admin-divider)">
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--admin-muted)">#</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--admin-muted)">User</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--admin-muted)">Amount</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--admin-muted)">To Address</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--admin-muted)">Status</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--admin-muted)">Tx Hash</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--admin-muted)">Date</th>
                <th style="padding:8px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--admin-muted)">Actions</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        `;

        // Hover rows
        wrap.querySelectorAll("tbody tr").forEach(tr => {
          tr.addEventListener("mouseenter", () => tr.style.background = "var(--table-bg-hover-color)");
          tr.addEventListener("mouseleave", () => tr.style.background = "");
        });

        // Wire retry/refund buttons
        wrap.querySelectorAll(".wd-retry-btn").forEach(btn => {
          btn.onclick = () => {
            pendingRetryId = parseInt(btn.dataset.id);
            host.querySelector("#wd-retry-desc").textContent =
              `${Number(btn.dataset.amount).toFixed(4)} TON → ${shortAddr(btn.dataset.addr)} (${btn.dataset.user})`;
            retryDlg.showModal();
          };
        });

        wrap.querySelectorAll(".wd-refund-btn").forEach(btn => {
          btn.onclick = () => {
            pendingRefundId = parseInt(btn.dataset.id);
            host.querySelector("#wd-refund-desc").textContent =
              `Return ${Number(btn.dataset.amount).toFixed(4)} TON to ${btn.dataset.user}'s internal balance.`;
            refundDlg.showModal();
          };
        });

        // Pagination
        if (totalPages > 1) {
          pgEl.innerHTML = `
            <button class="btn btn-sm btn-ghost" id="wd-prev" ${currentPage <= 1 ? "disabled" : ""}>← Prev</button>
            <span style="font-size:13px;color:var(--admin-muted)">Page ${currentPage} / ${totalPages}</span>
            <button class="btn btn-sm btn-ghost" id="wd-next" ${currentPage >= totalPages ? "disabled" : ""}>Next →</button>
          `;
          const prev = pgEl.querySelector("#wd-prev");
          const next = pgEl.querySelector("#wd-next");
          if (prev) prev.onclick = () => { currentPage--; ctx.tab.wdPage = currentPage; loadPage(); };
          if (next) next.onclick = () => { currentPage++; ctx.tab.wdPage = currentPage; loadPage(); };
        }
      }

      loadPage();
    },
  };
})();
