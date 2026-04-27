/* Vouchers — Phase-1 minimal (functional list/create/toggle/delete using existing endpoints). */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};
  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12V8a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v4a2 2 0 0 1 0 4v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4a2 2 0 0 1 0-4z"/><line x1="12" y1="6" x2="12" y2="18"/></svg>`;

  window.AdminPages.vouchers = {
    title: "Vouchers",
    icon: ICON,
    render: async function (host) {
      host.innerHTML = `
        <div class="page-hdr">
          <div><h1>Vouchers</h1><div class="sub">Create and manage redemption codes</div></div>
        </div>

        <div class="card" style="margin-bottom:18px">
          <div class="dash-recent-title" style="margin-top:0">Create voucher</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end">
            <div><div class="input-label">Credits</div><input class="input" type="number" id="v-credits" step="1" placeholder="100" style="width:140px"/></div>
            <div><div class="input-label">Max uses</div><input class="input" type="number" id="v-max" step="1" value="1" style="width:120px"/></div>
            <button class="btn btn-primary" id="v-create">Create</button>
          </div>
        </div>

        <div id="vouchers-list"><div class="loading-state"><div class="spinner"></div>Loading…</div></div>
      `;

      const listEl = host.querySelector("#vouchers-list");

      async function refresh() {
        try {
          const vouchers = await Api.request("/vouchers");
          if (!vouchers.length) {
            listEl.innerHTML = `<div class="empty-state"><div class="big">·</div>No vouchers yet</div>`;
            return;
          }
          listEl.innerHTML = `
            <div class="tbl-wrap">
              <table class="tbl">
                <thead><tr><th>Code</th><th>Credits</th><th>Used / Max</th><th>Status</th><th>Created</th><th></th></tr></thead>
                <tbody>
                  ${vouchers.map(v => `
                    <tr>
                      <td><code>${Fmt.escapeHtml(v.code)}</code></td>
                      <td>${v.credits != null ? v.credits.toLocaleString() + ' cr' : (Fmt.money(v.amountUsd) + ' USD')}</td>
                      <td>${v.usedCount} / ${v.maxUses}</td>
                      <td>${v.active ? '<span class="badge success"><span class="dot"></span>active</span>' : '<span class="badge danger"><span class="dot"></span>inactive</span>'}</td>
                      <td style="color:var(--admin-muted)">${Fmt.escapeHtml(Fmt.relativeTime(v.createdAt))}</td>
                      <td style="text-align:right;white-space:nowrap">
                        <button class="btn btn-xs" data-copy="${Fmt.escapeHtml(v.link)}">Copy link</button>
                        <button class="btn btn-xs" data-toggle="${v.id}" data-active="${v.active}">${v.active ? "Disable" : "Enable"}</button>
                        <button class="btn btn-xs btn-danger" data-del="${v.id}">Delete</button>
                      </td>
                    </tr>`).join("")}
                </tbody>
              </table>
            </div>`;

          listEl.querySelectorAll("[data-copy]").forEach(b => b.addEventListener("click", () => {
            Fmt.copyToClipboard(b.dataset.copy).then(() => Fmt.toast("Link copied", "ok"));
          }));
          listEl.querySelectorAll("[data-toggle]").forEach(b => b.addEventListener("click", async () => {
            const next = b.dataset.active !== "true";
            try {
              await Api.request("/vouchers/" + b.dataset.toggle, { method: "PUT", body: { active: next } });
              Fmt.toast(next ? "Voucher enabled" : "Voucher disabled", "ok");
              refresh();
            } catch (err) { Fmt.toast(err.message || "Failed", "err"); }
          }));
          listEl.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", async () => {
            if (!confirm("Delete this voucher?")) return;
            try {
              await Api.request("/vouchers/" + b.dataset.del, { method: "DELETE" });
              Fmt.toast("Voucher deleted", "ok");
              refresh();
            } catch (err) { Fmt.toast(err.message || "Failed", "err"); }
          }));
        } catch (err) {
          listEl.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed")}</div>`;
        }
      }

      host.querySelector("#v-create").addEventListener("click", async () => {
        const credits = host.querySelector("#v-credits").value;
        const maxUses = host.querySelector("#v-max").value || "1";
        if (!credits || parseInt(credits, 10) <= 0) { Fmt.toast("Enter a valid credits amount", "err"); return; }
        try {
          const v = await Api.request("/vouchers", { method: "POST", body: { credits, maxUses } });
          Fmt.toast("Voucher created: " + v.code, "ok");
          host.querySelector("#v-credits").value = "";
          host.querySelector("#v-max").value = "1";
          refresh();
        } catch (err) { Fmt.toast(err.message || "Failed", "err"); }
      });

      await refresh();
    },
  };
})();
