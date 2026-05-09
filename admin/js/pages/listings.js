/* App Store listings — moderation queue.
   Reads /admin/api/listings (?status=pending|approved|published|rejected). */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l1-6h16l1 6"/><path d="M5 9v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><path d="M9 13h6"/></svg>`;

  const STATUS_META = {
    draft:              { label: "Draft",    color: "#94a3b8", bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.22)" },
    ready:              { label: "Draft",    color: "#94a3b8", bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.22)" },
    submitting:         { label: "Draft",    color: "#94a3b8", bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.22)" },
    pending:            { label: "Review",   color: "#60a5fa", bg: "rgba(96,165,250,0.12)",  border: "rgba(96,165,250,0.24)" },
    review:             { label: "Review",   color: "#60a5fa", bg: "rgba(96,165,250,0.12)",  border: "rgba(96,165,250,0.24)" },
    approved:           { label: "Live",     color: "#4ade80", bg: "rgba(74,222,128,0.12)",  border: "rgba(74,222,128,0.24)" },
    deployed_pending_lp:{ label: "Live",     color: "#4ade80", bg: "rgba(74,222,128,0.12)",  border: "rgba(74,222,128,0.24)" },
    published:          { label: "Live",     color: "#4ade80", bg: "rgba(74,222,128,0.12)",  border: "rgba(74,222,128,0.24)" },
    rejected:           { label: "Rejected", color: "#f87171", bg: "rgba(248,113,113,0.12)", border: "rgba(248,113,113,0.24)" },
  };

  function statusBadge(s) {
    const m = STATUS_META[s] || { label: s, color: "#94a3b8", bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.22)" };
    return `<span style="display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;background:${m.bg};color:${m.color};border:1px solid ${m.border}">${Fmt.escapeHtml(m.label)}</span>`;
  }

  function bucketUrl(projectId, filename) {
    return `/bucket/${projectId}/${filename}`;
  }

  function renderScreenshots(projectId, list) {
    const arr = Array.isArray(list) ? list : [];
    if (!arr.length) return `<span style="color:var(--admin-muted);font-size:12px">no screenshots</span>`;
    return `<div style="display:flex;gap:6px;flex-wrap:wrap">${arr.map(f =>
      `<a href="${bucketUrl(projectId, f)}" target="_blank" style="display:block;width:60px;height:90px;border-radius:6px;overflow:hidden;border:1px solid var(--admin-border)"><img src="${bucketUrl(projectId, f)}" style="width:100%;height:100%;object-fit:cover" alt=""></a>`,
    ).join("")}</div>`;
  }

  function renderSocials(socials) {
    if (!socials || typeof socials !== "object") return `<span style="color:var(--admin-muted);font-size:12px">—</span>`;
    const items = [];
    for (const [k, v] of Object.entries(socials)) {
      if (!v) continue;
      const label = k.charAt(0).toUpperCase() + k.slice(1);
      items.push(`<a href="${Fmt.escapeHtml(String(v))}" target="_blank" style="color:#60a5fa;font-size:11px">${Fmt.escapeHtml(label)}</a>`);
    }
    return items.length
      ? `<div style="display:flex;flex-direction:column;gap:2px">${items.join("")}</div>`
      : `<span style="color:var(--admin-muted);font-size:12px">—</span>`;
  }

  function fmtDate(d) {
    if (!d) return "—";
    return new Date(d).toLocaleString();
  }

  window.AdminPages.listings = {
    title: "App Store",
    icon: ICON,
    render: async function (host, ctx) {
      const state = (ctx.tab.listingsState = ctx.tab.listingsState || {
        statusFilter: "pending",
      });

      host.innerHTML = `
        <div class="page-hdr">
          <div>
            <h1>App Store Listings</h1>
            <div class="sub">Moderation queue — approve submissions to go live, reject with a reason, or hide live listings.</div>
          </div>
          <div class="actions">
            <button class="btn btn-sm btn-ghost" id="lst-refresh">Refresh</button>
          </div>
        </div>

        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px">
          ${[{v:"review",l:"Review"},{v:"published",l:"Live"},{v:"rejected",l:"Rejected"},{v:"draft",l:"Draft"},{v:"",l:"All"}].map(({v:s,l:label}) => {
            const active = state.statusFilter === s;
            return `<button class="btn btn-sm ${active ? "btn-primary" : "btn-ghost"}" data-status="${s}">${label}</button>`;
          }).join("")}
        </div>

        <div id="lst-content"><div class="loading-state"><div class="spinner"></div>Loading…</div></div>
      `;

      const content = host.querySelector("#lst-content");

      async function load() {
        content.innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading…</div>`;
        try {
          const url = state.statusFilter
            ? `/listings?status=${encodeURIComponent(state.statusFilter)}`
            : "/listings";
          const data = await Api.request(url);
          renderRows(data.items || []);
        } catch (err) {
          content.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed to load")}</div>`;
        }
      }

      function renderRows(rows) {
        if (!rows.length) {
          content.innerHTML = `<div class="empty-state"><div class="big">·</div>No listings in this state</div>`;
          return;
        }
        const html = rows.map((r) => {
          const owner = r.ownerUsername ? "@" + r.ownerUsername : (r.ownerFirstName || `tg:${r.ownerTg}`);
          const tokenInfo = r.token
            ? `<div style="display:flex;align-items:center;gap:8px">
                 <img src="${bucketUrl(r.projectId, r.token.logoFilename)}" style="width:28px;height:28px;border-radius:50%;object-fit:cover;border:1px solid var(--admin-border)" alt="" onerror="this.style.display='none'">
                 <div>
                   <div style="font-weight:600">${Fmt.escapeHtml(r.token.name)} <span style="color:var(--admin-muted);font-weight:400">($${Fmt.escapeHtml(r.token.symbol)})</span></div>
                   ${r.token.jettonMasterAddress ? `<div style="font-size:10px;color:var(--admin-muted);font-family:monospace">${Fmt.escapeHtml(r.token.jettonMasterAddress.slice(0,16))}…</div>` : ""}
                 </div>
               </div>`
            : `<span style="color:var(--admin-muted);font-size:12px">no token yet</span>`;

          const showApprove = r.status === "review" || r.status === "pending";
          const showReject = r.status === "review" || r.status === "pending" || r.status === "submitting";
          const showHide = r.status === "published" && !r.hidden;
          const showUnhide = r.status === "published" && r.hidden;

          return `
            <tr data-id="${r.id}">
              <td>${statusBadge(r.status)}${r.hidden ? `<div style="font-size:10px;color:#f87171;margin-top:4px">HIDDEN</div>` : ""}</td>
              <td>
                <div style="font-weight:600">${Fmt.escapeHtml(r.projectName || "(unnamed)")}</div>
                ${r.botUsername ? `<div style="font-size:11px;color:var(--admin-muted)">@${Fmt.escapeHtml(r.botUsername)}</div>` : ""}
                <div style="font-size:11px;color:var(--admin-muted)">by ${Fmt.escapeHtml(owner)}</div>
              </td>
              <td>${tokenInfo}</td>
              <td style="max-width:280px">
                <div style="font-size:12px;line-height:1.4">${Fmt.escapeHtml(r.shortDescription || "")}</div>
                ${r.category ? `<div style="font-size:10px;color:var(--admin-muted);margin-top:4px">${Fmt.escapeHtml(r.category)}</div>` : ""}
              </td>
              <td>${renderScreenshots(r.projectId, r.screenshots)}</td>
              <td>${renderSocials(r.socials)}</td>
              <td style="font-size:11px;color:var(--admin-muted)">
                ${r.submittedAt ? `<div>Sub: ${fmtDate(r.submittedAt)}</div>` : ""}
                ${r.approvedAt ? `<div>Apr: ${fmtDate(r.approvedAt)}</div>` : ""}
                ${r.publishedAt ? `<div>Pub: ${fmtDate(r.publishedAt)}</div>` : ""}
                ${r.publishFeeTxHash ? `<div title="Publish fee TX">tx: ${Fmt.escapeHtml(r.publishFeeTxHash.slice(0, 10))}…</div>` : ""}
                ${r.rejectedReason ? `<div style="color:#f87171;margin-top:4px">${Fmt.escapeHtml(r.rejectedReason)}</div>` : ""}
              </td>
              <td style="text-align:right;white-space:nowrap">
                ${showApprove ? `<button class="btn btn-sm btn-primary act-approve">Approve</button>` : ""}
                ${showReject  ? `<button class="btn btn-sm act-reject" style="background:rgba(248,113,113,0.14);color:#f87171;border:1px solid rgba(248,113,113,0.28)">Reject</button>` : ""}
                ${showHide    ? `<button class="btn btn-sm btn-ghost act-hide">Hide</button>` : ""}
                ${showUnhide  ? `<button class="btn btn-sm btn-ghost act-unhide">Unhide</button>` : ""}
              </td>
            </tr>
          `;
        }).join("");

        content.innerHTML = `
          <div class="tbl-wrap">
            <table class="tbl">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>App</th>
                  <th>Token</th>
                  <th>Description</th>
                  <th>Screenshots</th>
                  <th>Socials</th>
                  <th>Timestamps</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>${html}</tbody>
            </table>
          </div>
        `;

        content.querySelectorAll("tr[data-id]").forEach((tr) => {
          const id = tr.dataset.id;
          tr.querySelector(".act-approve")?.addEventListener("click", async () => {
            if (!confirm("Approve this listing? A jetton master will be deployed on TON.")) return;
            try {
              await Api.request(`/listings/${id}/approve`, { method: "POST" });
              load();
            } catch (e) { alert("Approve failed: " + (e.message || e)); }
          });
          tr.querySelector(".act-reject")?.addEventListener("click", async () => {
            const reason = prompt("Rejection reason (shown to user)") || "";
            if (!reason) return;
            try {
              await Api.request(`/listings/${id}/reject`, { method: "POST", body: { reason } });
              load();
            } catch (e) { alert("Reject failed: " + (e.message || e)); }
          });
          tr.querySelector(".act-hide")?.addEventListener("click", async () => {
            if (!confirm("Hide this listing from the public store?")) return;
            try {
              await Api.request(`/listings/${id}/hide`, { method: "POST", body: { hidden: true } });
              load();
            } catch (e) { alert(e.message || e); }
          });
          tr.querySelector(".act-unhide")?.addEventListener("click", async () => {
            try {
              await Api.request(`/listings/${id}/hide`, { method: "POST", body: { hidden: false } });
              load();
            } catch (e) { alert(e.message || e); }
          });
        });
      }

      // Status filter buttons.
      host.querySelectorAll("button[data-status]").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.statusFilter = btn.dataset.status;
          host.querySelectorAll("button[data-status]").forEach((b) => {
            b.classList.toggle("btn-primary", b.dataset.status === state.statusFilter);
            b.classList.toggle("btn-ghost", b.dataset.status !== state.statusFilter);
          });
          load();
        });
      });
      host.querySelector("#lst-refresh").addEventListener("click", load);
      load();
    },
  };
})();
