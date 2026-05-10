/* User detail — Phase 2 (compacted layout v2).
   Tags / Profile / Partnership now sit in a 3-column grid, the dedicated
   Balance panel is gone (a pencil icon on the Balance KPI opens an inline
   editor), and the projects table is rendered with the same row layout the
   Apps list uses (avatar · name · status · bot · tier · cost · updated). */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};

  // Pencil icon used on the Balance KPI to expose the inline editor.
  const ICON_PENCIL = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>`;

  window.AdminPages.user = {
    title: "User",
    icon: "",
    render: async function (host, ctx) {
      const userId = ctx.params && ctx.params.id;
      if (!userId) {
        host.innerHTML = `<div class="error-state"><div class="big">!</div>Missing user id</div>`;
        return;
      }
      host.innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading user…</div>`;
      let u;
      try { u = await Api.request("/users/" + userId); }
      catch (err) {
        host.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed")}</div>`;
        return;
      }

      const display = u.firstName || u.username || ("User " + u.id);
      ctx.tab.title = display;
      window.TabBar.refresh();

      host.innerHTML = renderUser(u);
      wire(host, ctx, u);

      loadNotes(host, u.id);
    },
  };

  function renderUser(u) {
    const display = u.firstName || u.username || ("User " + u.id);
    return `
      <div class="page-hdr">
        <div style="display:flex;align-items:center;gap:14px">
          ${Avatar.lazyAvatarHtml({ kind: "user", id: u.telegramId, name: display, seed: u.id, size: 56 })}
          <div>
            <h1>${Fmt.escapeHtml(display)}${u.isPartner ? ' <span class="badge accent" style="margin-left:8px;vertical-align:middle">Partner</span>' : ""}</h1>
            <div class="sub">${u.username ? "@" + Fmt.escapeHtml(u.username) + " · " : ""}TG <code>${Fmt.escapeHtml(u.telegramId)}</code> · joined ${Fmt.escapeHtml(Fmt.date(u.createdAt))}</div>
          </div>
        </div>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="label" style="display:flex;align-items:center;justify-content:space-between">
            <span>Credits</span>
            <button class="kpi-edit-btn" id="bal-edit" title="Edit credits" aria-label="Edit credits">${ICON_PENCIL}</button>
          </div>
          <div class="value green" id="bal-val">${Fmt.creditsHtml(u.credits, '#4ade80')}</div>
          <div id="bal-editor" class="bal-editor" hidden>
            <select class="select" id="bal-action" style="width:auto">
              <option value="set">Set to</option>
              <option value="add">Add</option>
            </select>
            <input class="input" type="number" id="bal-amount" placeholder="credits" step="1" min="0" style="max-width:110px"/>
            <button class="btn btn-primary btn-xs" id="bal-btn">Apply</button>
            <button class="btn btn-ghost btn-xs" id="bal-cancel">Cancel</button>
          </div>
        </div>
        <div class="kpi-card"><div class="label">Credits Spent</div><div class="value warn">${Fmt.creditsHtml(u.totalCreditsSpent, '#fbbf24')}</div></div>
        <div class="kpi-card"><div class="label">Apps</div><div class="value">${u.projects.length}</div></div>
        <div class="kpi-card"><div class="label">Slots</div><div class="value">${u.appSlots}</div></div>
      </div>

      <div class="user-grid">
        <div class="user-grid-card">
          <div class="dash-recent-title" style="margin-top:0">Tags</div>
          <div class="card" style="display:flex;flex-direction:column;gap:8px">
            <div id="tags-chips" style="display:flex;flex-wrap:wrap;gap:6px;min-height:28px;align-items:center">
              ${(u.adminTags || []).map(renderChip).join("") || '<span style="color:var(--admin-muted);font-size:12px">No tags yet</span>'}
            </div>
            <div style="display:flex;gap:6px;align-items:center">
              <input class="input" id="tag-input" placeholder="Add tag, press Enter"/>
            </div>
            <span style="color:var(--admin-muted);font-size:11px">Up to 32 free-form labels</span>
          </div>
        </div>

        <div class="user-grid-card">
          <div class="dash-recent-title" style="margin-top:0">Profile</div>
          <div class="card" style="display:flex;flex-direction:column;gap:10px">
            ${profileField("First name",       "edit-firstName",  u.firstName  || "", "text")}
            ${profileField("Username",         "edit-username",   u.username   || "", "text")}
            ${profileField("Language",         "edit-language",   u.language   || "en", "text")}
            ${profileField("App slots",        "edit-appSlots",   String(u.appSlots ?? 5), "number")}
            ${profileField("Referred by (TG)", "edit-referredBy", u.referredBy || "", "text")}
            <div style="display:flex;justify-content:flex-end">
              <button class="btn btn-primary btn-sm" id="profile-save">Save profile</button>
            </div>
          </div>
        </div>

        <div class="user-grid-card">
          <div class="dash-recent-title" style="margin-top:0">Partnership</div>
          <div class="card" style="display:flex;flex-direction:column;gap:10px">
            <div>
              <div class="input-label">Is Partner</div>
              <label style="display:inline-flex;align-items:center;gap:8px"><input type="checkbox" id="prt-isPartner" ${u.isPartner ? "checked" : ""}/> Mark as partner</label>
            </div>
            ${profileField("Commission %",      "prt-percent",       u.partnerPercent       != null ? String(u.partnerPercent)       : "", "number")}
            ${profileField("Partner tag",       "prt-tag",            u.partnerTag           || "", "text")}
            ${profileField("Referral bonus (cr)",  "prt-refBonus",       u.partnerReferralBonus != null ? String(u.partnerReferralBonus) : "", "number")}
            <div>
              <div class="input-label">Partner balance</div>
              <div style="font-size:14px;color:var(--accent-color);font-weight:600">${Fmt.money(u.partnerBalance)}</div>
            </div>
            <div style="display:flex;justify-content:flex-end">
              <button class="btn btn-primary btn-sm" id="prt-save">Save partnership</button>
            </div>
          </div>
        </div>
      </div>

      <div class="dash-recent-title">Apps (${u.projects.length})</div>
      <div id="user-projects" style="margin-bottom:24px"></div>

      <div class="dash-recent-title">Recent Payments</div>
      <div id="user-payments" style="margin-bottom:24px"></div>

      <div class="dash-recent-title">Recent Usage</div>
      <div id="user-usage" style="margin-bottom:24px"></div>

      <div class="dash-recent-title" style="display:flex;align-items:center;justify-content:space-between">
        <span>Transactions</span>
        <a id="user-ledger-full-link" href="#" style="font-size:12px;color:var(--admin-accent);text-decoration:none;font-weight:400">View in Ledger ↗</a>
      </div>
      <div id="user-ledger" style="margin-bottom:24px"></div>

      <div class="dash-recent-title">Notes</div>
      <div class="card" style="margin-bottom:24px;display:flex;flex-direction:column;gap:10px">
        <textarea class="textarea" id="note-body" placeholder="Add a note about this user (max 4000 chars)…"></textarea>
        <div style="display:flex;justify-content:flex-end"><button class="btn btn-primary btn-sm" id="note-add">Add note</button></div>
        <div id="notes-list" style="display:flex;flex-direction:column;gap:8px;border-top:1px solid var(--admin-divider);padding-top:10px;margin-top:6px"></div>
      </div>

      <div class="dash-recent-title" style="color:var(--danger-text-color)">Danger Zone</div>
      <div class="card" style="border-color:rgba(var(--danger-color-rgb),0.3)">
        <div style="font-size:12px;color:var(--admin-muted);margin-bottom:8px">
          <b>Wipe data</b> deletes payments, conversations, usage logs, withdrawals and voucher redemptions.
          Resets credits balance, partnership, name and language. <b>Apps and bots are kept.</b>
        </div>
        <button class="btn btn-danger btn-sm" id="dz-wipe">Wipe user data</button>

        <div style="font-size:12px;color:var(--admin-muted);margin:14px 0 8px">
          <b>Full reset</b> deletes EVERYTHING including the user row and all their apps. They re-register fresh on next visit. Use only for testing attribution flows.
        </div>
        <button class="btn btn-danger btn-sm" id="dz-full">Full reset (delete user &amp; apps)</button>
      </div>
    `;
  }

  function profileField(label, id, value, type) {
    return `
      <div>
        <div class="input-label">${Fmt.escapeHtml(label)}</div>
        <input class="input" id="${id}" type="${type}" value="${Fmt.escapeHtml(value)}"/>
      </div>`;
  }

  function renderChip(tag) {
    return `<span class="badge accent" data-tag="${Fmt.escapeHtml(tag)}" style="cursor:default">${Fmt.escapeHtml(tag)}<button data-rm="${Fmt.escapeHtml(tag)}" style="background:none;border:none;color:inherit;cursor:pointer;margin-left:4px;font-size:13px;line-height:1;padding:0">×</button></span>`;
  }

  function wire(host, ctx, u) {
    const userId = u.id;

    // ── Tags ────────────────────────────────────────────────────────────
    let tagSet = new Set(u.adminTags || []);
    const chipsEl = host.querySelector("#tags-chips");
    const tagInput = host.querySelector("#tag-input");

    function rerenderChips() {
      const arr = Array.from(tagSet);
      chipsEl.innerHTML = arr.length
        ? arr.map(renderChip).join("")
        : '<span style="color:var(--admin-muted);font-size:12px">No tags yet</span>';
    }

    async function persistTags() {
      try {
        const res = await Api.request("/users/" + userId + "/tags", {
          method: "POST",
          body: { tags: Array.from(tagSet) },
        });
        tagSet = new Set(res.adminTags || []);
        rerenderChips();
      } catch (err) {
        Fmt.toast(err.message || "Failed to save tags", "err");
      }
    }

    chipsEl.addEventListener("click", e => {
      const b = e.target.closest("[data-rm]");
      if (!b) return;
      tagSet.delete(b.dataset.rm);
      persistTags();
    });
    tagInput.addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        const v = tagInput.value.trim();
        if (!v) return;
        tagSet.add(v);
        tagInput.value = "";
        persistTags();
      }
    });

    // ── Credits (inline editor on the KPI card) ────────────────────────
    const editor   = host.querySelector("#bal-editor");
    const editBtn  = host.querySelector("#bal-edit");
    const cancel   = host.querySelector("#bal-cancel");
    const balValEl = host.querySelector("#bal-val");
    const amountEl = host.querySelector("#bal-amount");
    const actionEl = host.querySelector("#bal-action");

    function openEditor() {
      editor.hidden = false;
      amountEl.value = String(Math.round(u.credits || 0));
      amountEl.focus();
      amountEl.select();
    }
    function closeEditor() {
      editor.hidden = true;
      amountEl.value = "";
    }
    editBtn.addEventListener("click", () => editor.hidden ? openEditor() : closeEditor());
    cancel.addEventListener("click", closeEditor);
    amountEl.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); host.querySelector("#bal-btn").click(); }
      if (e.key === "Escape") { closeEditor(); }
    });
    host.querySelector("#bal-btn").addEventListener("click", async () => {
      const action = actionEl.value;
      const credits = amountEl.value;
      if (credits === "") { Fmt.toast("Enter an amount", "err"); return; }
      try {
        const d = await Api.request("/users/" + userId + "/credits", { method: "POST", body: { action, credits } });
        balValEl.innerHTML = Fmt.creditsHtml(d.credits, '#4ade80');
        u.credits = d.credits;
        Fmt.toast("Credits updated to " + Fmt.credits(d.credits), "ok");
        closeEditor();
      } catch (err) { Fmt.toast(err.message || "Failed", "err"); }
    });

    // ── Profile save ────────────────────────────────────────────────────
    host.querySelector("#profile-save").addEventListener("click", async () => {
      const body = {
        firstName:  host.querySelector("#edit-firstName").value,
        username:   host.querySelector("#edit-username").value,
        language:   host.querySelector("#edit-language").value,
        appSlots:   parseInt(host.querySelector("#edit-appSlots").value, 10),
        referredBy: host.querySelector("#edit-referredBy").value,
      };
      try {
        await Api.request("/users/" + userId, { method: "PATCH", body });
        Fmt.toast("Profile saved", "ok");
      } catch (err) { Fmt.toast(err.message || "Failed", "err"); }
    });

    // ── Partner save ────────────────────────────────────────────────────
    host.querySelector("#prt-save").addEventListener("click", async () => {
      const body = {
        isPartner:            host.querySelector("#prt-isPartner").checked,
        partnerPercent:       host.querySelector("#prt-percent").value || null,
        partnerTag:           host.querySelector("#prt-tag").value     || null,
        partnerReferralBonus: host.querySelector("#prt-refBonus").value || null,
      };
      try {
        await Api.request("/users/" + userId + "/partner", { method: "POST", body });
        Fmt.toast("Partnership saved", "ok");
      } catch (err) { Fmt.toast(err.message || "Failed", "err"); }
    });

    // ── Apps table (matches the layout used by the Apps list page) ─────
    const projEl = host.querySelector("#user-projects");
    if (u.projects.length) {
      projEl.innerHTML = `
        <div class="tbl-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Status</th>
                <th>Bot</th>
                <th style="text-align:right">Cost (USD)</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              ${u.projects.map(p => `
                <tr class="clickable" data-pid="${Fmt.escapeHtml(p.id)}">
                  <td style="width:40px">${Avatar.lazyAvatarHtml({ kind: "project", id: p.id, name: p.name, seed: p.id, size: 32 })}</td>
                  <td>
                    <div style="display:flex;flex-direction:column;gap:2px">
                      <span style="font-weight:600">${Fmt.escapeHtml(p.name)}</span>
                      ${p.description ? `<span style="color:var(--admin-muted);font-size:11px;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block">${Fmt.escapeHtml(p.description)}</span>` : ""}
                    </div>
                  </td>
                  <td>${Fmt.statusBadge(p.status)}</td>
                  <td>${p.botUsername ? `<a href="https://t.me/${encodeURIComponent(p.botUsername)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">@${Fmt.escapeHtml(p.botUsername)}</a>` : '<span style="color:var(--admin-muted)">—</span>'}</td>
                  <td style="text-align:right;${Number(p.totalCost) > 0 ? "color:var(--warn-color, #fbbf24)" : ""}">${Fmt.money(p.totalCost)}</td>
                  <td style="color:var(--admin-muted)" title="${Fmt.escapeHtml(Fmt.date(p.updatedAt))}">${Fmt.escapeHtml(Fmt.relativeTime(p.updatedAt))}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>`;
      projEl.querySelectorAll("tr[data-pid]").forEach(row => {
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
    } else {
      projEl.innerHTML = `<div class="empty-state"><div class="big">·</div>No apps</div>`;
    }

    // ── Payments table ──────────────────────────────────────────────────
    const payEl = host.querySelector("#user-payments");
    if (u.payments.length) {
      payEl.innerHTML = `
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr><th>Amount</th><th>Status</th><th>Created</th><th>Confirmed</th></tr></thead>
            <tbody>
              ${u.payments.map(p => `
                <tr>
                  <td>${Fmt.money(p.amount)}</td>
                  <td>${Fmt.statusBadge(p.status)}</td>
                  <td style="color:var(--admin-muted)">${Fmt.escapeHtml(Fmt.relativeTime(p.createdAt))}</td>
                  <td style="color:var(--admin-muted)">${p.confirmedAt ? Fmt.escapeHtml(Fmt.relativeTime(p.confirmedAt)) : "—"}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>`;
    } else {
      payEl.innerHTML = `<div class="empty-state"><div class="big">·</div>No payments</div>`;
    }

    // ── Usage table ─────────────────────────────────────────────────────
    const usageEl = host.querySelector("#user-usage");
    if (u.usageLogs.length) {
      usageEl.innerHTML = `
        <div class="tbl-wrap">
          <table class="tbl">
            <thead><tr><th>App</th><th>Operation</th><th>Tier</th><th>Tokens</th><th style="text-align:right">Credits</th><th style="text-align:right;color:var(--admin-muted)">Cost (USD)</th><th>When</th></tr></thead>
            <tbody>
              ${u.usageLogs.map(l => `
                <tr>
                  <td>${Fmt.escapeHtml(l.project)}</td>
                  <td><span class="badge">${Fmt.escapeHtml(l.operation)}</span></td>
                  <td style="color:var(--admin-muted)">${Fmt.escapeHtml(l.tierId || "—")}</td>
                  <td style="color:var(--admin-muted)">${Fmt.intK(l.inputTokens)} / ${Fmt.intK(l.outputTokens)}</td>
                  <td style="text-align:right;font-weight:600">${l.creditsCharged != null ? Fmt.creditsHtml(l.creditsCharged, '#fbbf24') : "—"}</td>
                  <td style="text-align:right;color:var(--admin-muted);font-size:11px">${Fmt.money(l.cost, 4)}</td>
                  <td style="color:var(--admin-muted)" title="${Fmt.escapeHtml(Fmt.date(l.createdAt))}">${Fmt.escapeHtml(Fmt.relativeTime(l.createdAt))}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>`;
    } else {
      usageEl.innerHTML = `<div class="empty-state"><div class="big">·</div>No usage history</div>`;
    }

    // ── Ledger ──────────────────────────────────────────────────────────
    const ledgerEl = host.querySelector("#user-ledger");
    const ledgerLink = host.querySelector("#user-ledger-full-link");
    if (ledgerLink) {
      ledgerLink.addEventListener("click", (e) => {
        e.preventDefault();
        ctx.push({ pageKey: "ledger" });
      });
    }

    async function loadLedger() {
      if (!ledgerEl) return;
      ledgerEl.innerHTML = `<div class="loading-state" style="padding:18px"><div class="spinner"></div></div>`;
      try {
        const data = await Api.request("/users/" + userId + "/ledger?limit=50");
        const rows = data.rows || [];
        if (!rows.length) {
          ledgerEl.innerHTML = `<div class="empty-state"><div class="big">·</div>No transactions yet</div>`;
          return;
        }
        function fmtLedgerAmount(amount, currency) {
          const pos = amount >= 0;
          const sign = pos ? "+" : "";
          const color = pos ? "#4ade80" : "#f87171";
          const disp = Math.abs(amount) >= 0.0001 ? (Math.abs(amount) < 1 ? amount.toFixed(6) : amount.toFixed(2)) : amount.toExponential(3);
          return `<span style="font-weight:700;color:${color};font-variant-numeric:tabular-nums">${sign}${disp}</span> <span style="color:var(--admin-muted);font-size:11px">${Fmt.escapeHtml(currency)}</span>`;
        }
        function sourceBadge(source) {
          const label = source.replace(/_/g, " ");
          return `<span class="badge">${Fmt.escapeHtml(label)}</span>`;
        }
        ledgerEl.innerHTML = `
          <div class="tbl-wrap">
            <table class="tbl">
              <thead><tr><th>Date</th><th>Amount</th><th>Source</th><th>Meta</th></tr></thead>
              <tbody>
                ${rows.map(r => {
                  const meta = r.meta && Object.keys(r.meta).length ? JSON.stringify(r.meta) : "";
                  const metaHtml = meta
                    ? `<span title="${Fmt.escapeHtml(meta)}" style="cursor:help;color:var(--admin-muted);font-size:11px">ⓘ</span>`
                    : `<span style="color:var(--admin-muted)">—</span>`;
                  const date = new Date(r.date);
                  const dateStr = date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
                    + " " + date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
                  return `
                    <tr>
                      <td style="color:var(--admin-muted);font-size:11px;white-space:nowrap">${dateStr}</td>
                      <td>${fmtLedgerAmount(r.amount, r.currency)}</td>
                      <td>${sourceBadge(r.source)}</td>
                      <td>${metaHtml}</td>
                    </tr>`;
                }).join("")}
              </tbody>
            </table>
          </div>
          ${data.total > 50 ? `<div style="margin-top:6px;color:var(--admin-muted);font-size:11px">Showing first 50 of ${data.total.toLocaleString()} — <a href="#" id="user-ledger-more" style="color:var(--admin-accent);text-decoration:none">see all in Ledger</a></div>` : ""}
        `;
        const moreLink = ledgerEl.querySelector("#user-ledger-more");
        if (moreLink) moreLink.addEventListener("click", (e) => { e.preventDefault(); ctx.push({ pageKey: "ledger" }); });
      } catch (err) {
        ledgerEl.innerHTML = `<div class="error-state" style="padding:12px">${Fmt.escapeHtml(err.message || "Failed to load transactions")}</div>`;
      }
    }
    loadLedger();

    // ── Notes add ───────────────────────────────────────────────────────
    host.querySelector("#note-add").addEventListener("click", async () => {
      const body = host.querySelector("#note-body").value.trim();
      if (!body) { Fmt.toast("Enter a note", "err"); return; }
      try {
        await Api.request("/users/" + userId + "/notes", { method: "POST", body: { body } });
        host.querySelector("#note-body").value = "";
        Fmt.toast("Note added", "ok");
        loadNotes(host, userId);
      } catch (err) { Fmt.toast(err.message || "Failed", "err"); }
    });

    // ── Danger zone ─────────────────────────────────────────────────────
    host.querySelector("#dz-wipe").addEventListener("click", async () => {
      const userLabel = u.username ? "@" + u.username : (u.firstName || ("User #" + u.id));
      if (!confirm(`Wipe ALL data for ${userLabel}?\n\nDeletes payments, conversations, usage logs, withdrawals and voucher redemptions. Resets balance and profile.\n\nApps and bots are KEPT. This cannot be undone.`)) return;
      try {
        const r = await Api.request("/users/" + userId + "/data", { method: "DELETE" });
        const d = r.deleted || {};
        Fmt.toast(`Wiped: ${d.payments||0} payments, ${d.conversations||0} chats, ${d.usageLogs||0} usage`, "ok");
        ctx.replace({ pageKey: "user", params: { id: userId } });
      } catch (err) { Fmt.toast(err.message || "Failed", "err"); }
    });

    host.querySelector("#dz-full").addEventListener("click", async () => {
      const userLabel = u.username ? "@" + u.username : (u.firstName || ("User #" + u.id));
      if (!confirm(`FULL RESET for ${userLabel}?\n\nDeletes ALL data, ALL ${u.projects.length} apps, and the user row itself.\n\nThis cannot be undone.`)) return;
      try {
        const r = await Api.request("/users/" + userId + "/full", { method: "DELETE" });
        const d = r.deleted || {};
        Fmt.toast(`Reset: ${d.projects||0} apps, ${d.payments||0} payments, user deleted`, "ok");
        ctx.pop();
      } catch (err) { Fmt.toast(err.message || "Failed", "err"); }
    });
  }

  async function loadNotes(host, userId) {
    const el = host.querySelector("#notes-list");
    if (!el) return;
    el.innerHTML = `<div class="loading-state" style="padding:18px"><div class="spinner"></div></div>`;
    try {
      const data = await Api.request("/users/" + userId + "/notes");
      const notes = data.notes || [];
      if (!notes.length) {
        el.innerHTML = `<div style="color:var(--admin-muted);font-size:12px;text-align:center;padding:8px">No notes yet</div>`;
        return;
      }
      el.innerHTML = notes.map(n => `
        <div style="padding:8px 10px;border:1px solid var(--admin-card-border);border-radius:8px;background:rgba(255,255,255,0.02)">
          <div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:4px">
            <span style="font-size:11px;color:var(--admin-muted);text-transform:uppercase;letter-spacing:0.4px">${Fmt.escapeHtml(n.authorTag || "admin")} · ${Fmt.escapeHtml(Fmt.relativeTime(n.createdAt))}</span>
            <button class="btn btn-xs btn-ghost" data-del-note="${n.id}">delete</button>
          </div>
          <div style="white-space:pre-wrap;font-size:13px">${Fmt.escapeHtml(n.body)}</div>
        </div>`).join("");
      el.querySelectorAll("[data-del-note]").forEach(b => b.addEventListener("click", async () => {
        if (!confirm("Delete this note?")) return;
        try {
          await Api.request("/users/" + userId + "/notes/" + b.dataset.delNote, { method: "DELETE" });
          loadNotes(host, userId);
        } catch (err) { Fmt.toast(err.message || "Failed", "err"); }
      }));
    } catch (err) {
      el.innerHTML = `<div class="error-state" style="padding:12px">${Fmt.escapeHtml(err.message || "Failed to load notes")}</div>`;
    }
  }
})();
