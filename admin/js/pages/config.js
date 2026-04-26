/* Configuration — Phase 6: full RuntimeConfig editor.
   Form is generated from a schema grouped into sections. Save All
   posts the diff back to /admin/api/config. */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

  // ── Schema ─────────────────────────────────────────────────────────────
  const SCHEMA = [
    {
      title: "Pricing",
      desc:  "Top-ups, markup, multipliers",
      fields: [
        { key: "minTopup",          label: "Min top-up (USD)",        type: "number", step: "1",   help: "Minimum amount the user can deposit." },
        { key: "markupMultiplier",  label: "Markup multiplier",       type: "number", step: "0.1", help: "Multiplier on top of raw provider rates." },
        { key: "askMultiplier",     label: "Ask multiplier",          type: "number", step: "0.1", help: "Multiplier applied for ask-mode answers." },
        { key: "bundlePriceUsd",    label: "Bundle price (USD)",      type: "number", step: "1",   help: "Get-everything bundle on Features page." },
        { key: "aiAvatarPriceUsd",  label: "AI avatar price (USD)",   type: "number", step: "1",   help: "Cost of generating an AI avatar." },
      ],
    },
    {
      title: "Bonuses & Referrals",
      desc:  "Promo budget knobs",
      fields: [
        { key: "firstTopupBonusPercent", label: "First top-up bonus (%)",  type: "number", step: "1",   help: "Percent-based first-deposit bonus. 100 = double the first deposit. 0 disables." },
        { key: "referralBonusUsd",     label: "Referral bonus (USD)",      type: "number", step: "0.5", help: "Awarded to referrer when invitee tops up." },
        { key: "partnerDefaultPercent",label: "Partner default %",         type: "number", step: "1",   help: "Default revenue share for new partners." },
      ],
    },
    {
      title: "Limits",
      desc:  "Agent loops & timeouts",
      fields: [
        { key: "maxAgentIterations", label: "Max agent iterations", type: "number", step: "1",    help: "Hard cap on tool calls per run." },
        { key: "agentTimeoutMs",     label: "Agent timeout (ms)",   type: "number", step: "1000", help: "Per-iteration upper bound." },
        { key: "splashSecondsBeforeContinue", label: "Splash seconds", type: "number", step: "1", help: "Force user to wait on splash." },
      ],
    },
    {
      title: "Defaults",
      desc:  "Localization & UX defaults",
      fields: [
        { key: "defaultLanguage", label: "Default language", type: "select", options: [
          { value: "en", label: "English" },
          { value: "ru", label: "Русский" },
          { value: "uk", label: "Українська" },
        ]},
      ],
    },
    {
      title: "Feature Flags",
      desc:  "Kill switches and admin tools",
      fields: [
        { key: "serviceMode",        label: "Service mode",         type: "bool", help: "Show maintenance page to all non-admin users in the Mini App." },
        { key: "disableNewSignups",  label: "Disable new signups",  type: "bool", help: "Block /start for unknown users." },
        { key: "disableNewProjects", label: "Disable new projects", type: "bool", help: "Block project creation site-wide." },
        { key: "allowAdminShell",    label: "Allow admin shell",    type: "bool", help: "Enable reveal-in-explorer / shell ops." },
      ],
    },
    {
      title: "External File Browser",
      desc:  "Iframe used by the App → Files sub-tab",
      fields: [
        { key: "filesBrowserBaseUrl",      label: "Base URL",      type: "text", help: "e.g. http://204.168.219.20:9090/files" },
        { key: "filesBrowserProjectsRoot", label: "Projects root", type: "text", help: "Server path the browser exposes, e.g. /opt/apps-father/projects" },
      ],
    },
  ];

  function getPath(obj, path) {
    return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
  }
  function setPath(obj, path, value) {
    const parts = path.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      cur[parts[i]] = cur[parts[i]] || {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  window.AdminPages.config = {
    title: "Configuration",
    icon: ICON,
    render: async function (host, ctx) {
      host.innerHTML = `
        <div class="page-hdr">
          <div><h1>Configuration</h1><div class="sub">Runtime knobs &middot; saved without redeploy</div></div>
          <div class="actions">
            <button class="btn btn-sm btn-ghost" id="cfg-reload">Reload</button>
            <button class="btn btn-sm btn-primary" id="cfg-save-top">Save All</button>
          </div>
        </div>
        <div id="cfg-content"><div class="loading-state"><div class="spinner"></div>Loading…</div></div>
      `;

      const content = host.querySelector("#cfg-content");

      async function load() {
        content.innerHTML = `<div class="loading-state"><div class="spinner"></div>Loading…</div>`;
        try {
          const cfg = await Api.request("/config");
          render(cfg);
        } catch (err) {
          content.innerHTML = `<div class="error-state"><div class="big">!</div>${Fmt.escapeHtml(err.message || "Failed")}</div>`;
        }
      }

      function render(cfg) {
        content.innerHTML = `
          <div class="cfg-grid">
            ${SCHEMA.map(section => `
              <section class="cfg-section">
                <header>
                  <h3>${Fmt.escapeHtml(section.title)}</h3>
                  <span>${Fmt.escapeHtml(section.desc || "")}</span>
                </header>
                <div class="cfg-rows">
                  ${section.fields.map(f => fieldHtml(f, getPath(cfg, f.key))).join("")}
                </div>
              </section>
            `).join("")}
          </div>
          <div class="cfg-footer">
            <button class="btn btn-primary" id="cfg-save">Save All</button>
          </div>
        `;

        const onSave = async () => {
          const payload = {};
          for (const section of SCHEMA) {
            for (const f of section.fields) {
              const el = host.querySelector(`[data-cfg-key="${f.key}"]`);
              if (!el) continue;
              let v;
              if (f.type === "bool") v = el.checked;
              else if (f.type === "select") v = el.value;
              else if (f.type === "text") v = el.value;            // free-form string, may be empty
              else v = el.value === "" ? null : Number(el.value);
              // Skip null number fields (preserves existing value), but include
              // empty strings for text fields so admins can clear an override.
              if (v !== null) setPath(payload, f.key, v);
            }
          }
          try {
            const updated = await Api.request("/config", { method: "POST", body: payload });
            Fmt.toast("Configuration saved", "ok");
            render(updated);
          } catch (err) { Fmt.toast(err.message || "Failed", "err"); }
        };

        host.querySelector("#cfg-save").addEventListener("click", onSave);
        host.querySelector("#cfg-save-top").addEventListener("click", onSave);
      }

      host.querySelector("#cfg-reload").addEventListener("click", load);
      await load();
    },
  };

  function fieldHtml(f, value) {
    const id = "cfg-" + f.key.replace(/\./g, "_");
    const safeKey = Fmt.escapeHtml(f.key);
    let inputHtml;
    if (f.type === "bool") {
      const checked = value ? "checked" : "";
      inputHtml = `
        <label class="cfg-toggle">
          <input type="checkbox" id="${id}" data-cfg-key="${safeKey}" ${checked}/>
          <span class="cfg-toggle-track"><span class="cfg-toggle-thumb"></span></span>
        </label>`;
    } else if (f.type === "select") {
      inputHtml = `<select class="select" id="${id}" data-cfg-key="${safeKey}">
        ${(f.options || []).map(o => `<option value="${Fmt.escapeHtml(o.value)}" ${o.value === value ? "selected" : ""}>${Fmt.escapeHtml(o.label)}</option>`).join("")}
      </select>`;
    } else if (f.type === "text") {
      const v = value ?? "";
      inputHtml = `<input class="input" id="${id}" data-cfg-key="${safeKey}" type="text" value="${Fmt.escapeHtml(String(v))}" placeholder="${Fmt.escapeHtml(f.placeholder || "")}"/>`;
    } else {
      const v = value ?? "";
      inputHtml = `<input class="input" id="${id}" data-cfg-key="${safeKey}" type="number" step="${Fmt.escapeHtml(f.step || "1")}" value="${Fmt.escapeHtml(String(v))}"/>`;
    }
    return `
      <div class="cfg-row">
        <div class="cfg-row-label">
          <label for="${id}">${Fmt.escapeHtml(f.label)}</label>
          ${f.help ? `<span class="cfg-row-help">${Fmt.escapeHtml(f.help)}</span>` : ""}
        </div>
        <div class="cfg-row-input">${inputHtml}</div>
      </div>
    `;
  }
})();
