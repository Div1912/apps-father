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
      title: "Credits & Pricing",
      desc:  "Credits-based billing",
      fields: [
        { key: "minTopup",          label: "Min top-up (USD)",        type: "number", step: "1",   help: "Minimum amount the user can deposit." },
        { key: "creditsPerDollar",  label: "Credits per $1",          type: "number", step: "1",   help: "How many credits 1 USD buys (default 50)." },
        { key: "slotPriceCredits",  label: "Slot price (credits)",    type: "number", step: "10",  help: "Credits deducted to buy one extra app slot." },
        { key: "bundlePriceUsd",    label: "Bundle price (USD)",      type: "number", step: "1",   help: "Get-everything bundle on Features page." },
        { key: "aiAvatarPriceUsd",  label: "AI avatar price (USD)",   type: "number", step: "1",   help: "Cost of generating an AI avatar." },
      ],
    },
    {
      title: "Bonuses & Referrals",
      desc:  "Promo budget knobs",
      fields: [
        { key: "firstTopupBonusPercent", label: "First top-up bonus (%)",  type: "number", step: "1",   help: "Percent-based first-deposit bonus. 100 = double the first deposit. 0 disables." },
        { key: "referralBonusPercent", label: "Referral bonus (%)",        type: "number", step: "1",   help: "% of purchased credits given to the referrer as credits (default 15)." },
        { key: "referralBonusUsd",     label: "Referral bonus USD (legacy)",type: "number", step: "0.5",help: "Legacy USD referral bonus — no longer used." },
        { key: "partnerDefaultPercent",label: "Partner default %",         type: "number", step: "1",   help: "Default revenue share for new partners (% of deposit USD)." },
        { key: "cashbackEnabled",      label: "Enable cashback system",     type: "bool",               help: "Master switch. When off, the rating button is hidden in the mini-app and the /feedback endpoint is disabled." },
        { key: "cashbackPercent",      label: "Feedback cashback (%)",     type: "number", step: "1",   help: "% of credits charged refunded to the user when they submit a feedback rating in the mini-app (0–100, default 50)." },
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
    {
      title: "OpenRouter — Production",
      desc:  "Main key used by the user-facing agent",
      fields: [
        { key: "openrouterApiKey", label: "OpenRouter API key", type: "password", help: "Used by all production agent runs (plan / codegen / ask)." },
      ],
    },
    {
      title: "Agent Training",
      desc:  "Dedicated key + model used ONLY by the Agent Feedback → Run Analysis pipeline. Required — analysis will refuse to run without it (no silent fallback to the production key).",
      fields: [
        { key: "trainingOpenrouterApiKey", label: "Training OpenRouter API key", type: "password",        help: "REQUIRED for Run Analysis. Use a separate OpenRouter key so training spend is isolated from production user runs." },
        { key: "trainingModel",            label: "Training model",              type: "model-picker",   help: "OpenRouter model id used for the analyzer. Empty = default (anthropic/claude-sonnet-4-5). Tool-calling capable models recommended (Claude Sonnet/Opus, GPT-4.x/5.x)." },
        { key: "trainingProvider",         label: "Training provider routing",   type: "provider-picker", help: "Force OpenRouter to route the analyzer to a specific provider (e.g. \"Anthropic\"). Empty = Auto." },
      ],
    },
  ];

  // Common providers shown in the provider-picker datalist. Mirrors the list
  // used on the Models page. Users can still type any custom provider name.
  const PROVIDER_OPTIONS = [
    "Anthropic","OpenAI","Google","Meta","Mistral","DeepSeek","xAI","Qwen",
    "Together","Fireworks","DeepInfra","Novita","Groq","Minimax",
  ];

  // Cached OR model list (loaded once per page render).
  let orModelsCache = null;
  async function loadOrModels() {
    if (orModelsCache) return orModelsCache;
    try {
      const data = await Api.request("/openrouter/models");
      orModelsCache = (data?.data || []).map(m => ({ id: m.id, name: m.name || m.id }));
    } catch (err) {
      console.warn("[config] OR models fetch failed:", err.message);
      orModelsCache = [];
    }
    return orModelsCache;
  }

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
          <div id="cfg-sessions-section" style="margin-top:2rem"></div>
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
              else if (
                f.type === "text" || f.type === "password" ||
                f.type === "model-picker" || f.type === "provider-picker"
              ) v = el.value;
              else v = el.value === "" ? null : Number(el.value);
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

        // Hydrate any model-picker datalists that need the live OR catalog.
        const modelPickers = host.querySelectorAll('datalist[data-or-models="1"]');
        if (modelPickers.length) {
          loadOrModels().then(models => {
            const html = models.map(m =>
              `<option value="${Fmt.escapeHtml(m.id)}">${Fmt.escapeHtml(m.name)}</option>`
            ).join("");
            modelPickers.forEach(dl => { dl.innerHTML = html; });
          });
        }

        // Load and render agent session config
        loadSessionConfig();
      }

      async function loadSessionConfig() {
        const el = host.querySelector("#cfg-sessions-section");
        if (!el) return;
        try {
          const data = await Api.request("/config/sessions");
          renderSessionConfig(el, data.sessions || {}, data.pricing || {});
        } catch (err) {
          el.innerHTML = `<div class="error-state">Failed to load session config: ${Fmt.escapeHtml(err.message)}</div>`;
        }
      }

      function renderSessionConfig(el, sessions, pricing) {
        const SESSION_TYPES = ["router","answer","build","update","update-plan","bug-fix","suggestions","context"];
        const PRICING_LABELS = {
          build: "Build (credits)",
          update: "Update (credits)",
          "update-plan-base": "Update-Plan base (credits)",
          "update-plan-per-item": "Update-Plan per item (credits)",
          "bug-fix": "Bug-Fix (credits)",
        };

        el.innerHTML = `
          <h2 style="margin:0 0 0.5rem;font-size:1.1rem">Agent Session Configuration</h2>
          <p class="sub" style="margin-bottom:1rem">Per-session model, tokens, thinking budget, and iteration limits. Pricing is in credits (0 = free).</p>

          <section class="cfg-section" style="margin-bottom:1.5rem">
            <header><h3>Session Pricing</h3><span>Flat credit costs per session type</span></header>
            <div class="cfg-rows">
              ${Object.entries(PRICING_LABELS).map(([k, label]) => `
                <div class="cfg-row">
                  <label class="cfg-label">${Fmt.escapeHtml(label)}</label>
                  <div class="cfg-control">
                    <input class="input" data-pricing-key="${Fmt.escapeHtml(k)}" type="number" min="0" step="5" value="${pricing[k] ?? 0}" style="width:120px"/>
                  </div>
                </div>
              `).join("")}
            </div>
          </section>

          <section class="cfg-section" style="margin-bottom:1.5rem">
            <header><h3>Session Configs</h3><span>Model + limits per session type</span></header>
            <div style="overflow-x:auto">
              <table style="width:100%;border-collapse:collapse;font-size:0.82rem">
                <thead>
                  <tr style="background:var(--bg2,#f5f5f5)">
                    <th style="text-align:left;padding:6px 8px">Type</th>
                    <th style="padding:6px 8px">Model</th>
                    <th style="padding:6px 8px">Max Tokens</th>
                    <th style="padding:6px 8px">Thinking</th>
                    <th style="padding:6px 8px">Reasoning</th>
                    <th style="padding:6px 8px">Iterations</th>
                  </tr>
                </thead>
                <tbody>
                  ${SESSION_TYPES.map(type => {
                    const s = sessions[type] || {};
                    return `<tr style="border-top:1px solid var(--border,#eee)">
                      <td style="padding:6px 8px;font-weight:500">${Fmt.escapeHtml(type)}</td>
                      <td style="padding:4px"><input class="input" data-sess="${Fmt.escapeHtml(type)}" data-field="model" type="text" value="${Fmt.escapeHtml(s.model||'')}" style="width:260px" list="or-models-sess"/></td>
                      <td style="padding:4px"><input class="input" data-sess="${Fmt.escapeHtml(type)}" data-field="max_tokens" type="number" min="256" step="256" value="${s.max_tokens||0}" style="width:90px"/></td>
                      <td style="padding:4px"><input class="input" data-sess="${Fmt.escapeHtml(type)}" data-field="thinking" type="number" min="0" step="500" value="${s.thinking||0}" style="width:80px" title="0 = disabled"/></td>
                      <td style="padding:4px;text-align:center"><input type="checkbox" data-sess="${Fmt.escapeHtml(type)}" data-field="reasoning" ${s.reasoning ? 'checked' : ''} title="Enable reasoning budget"/></td>
                      <td style="padding:4px"><input class="input" data-sess="${Fmt.escapeHtml(type)}" data-field="iterations" type="number" min="1" step="1" value="${s.iterations||1}" style="width:70px"/></td>
                    </tr>`;
                  }).join("")}
                </tbody>
              </table>
              <datalist id="or-models-sess"></datalist>
            </div>
          </section>

          <button class="btn btn-primary" id="cfg-sessions-save">Save Session Config</button>
        `;

        // Hydrate model datalist
        loadOrModels().then(models => {
          const dl = el.querySelector("#or-models-sess");
          if (dl) dl.innerHTML = models.map(m => `<option value="${Fmt.escapeHtml(m.id)}">`).join("");
        });

        el.querySelector("#cfg-sessions-save").addEventListener("click", async () => {
          const pricingPayload = {};
          el.querySelectorAll("[data-pricing-key]").forEach(inp => {
            pricingPayload[inp.dataset.pricingKey] = Number(inp.value) || 0;
          });
          const sessPayload = {};
          SESSION_TYPES.forEach(type => {
            sessPayload[type] = {};
            el.querySelectorAll(`[data-sess="${type}"]`).forEach(inp => {
              const field = inp.dataset.field;
              if (inp.type === "checkbox") sessPayload[type][field] = inp.checked;
              else if (field === "model") sessPayload[type][field] = inp.value.trim();
              else sessPayload[type][field] = Number(inp.value) || 0;
            });
          });
          try {
            await Api.request("/config/sessions", { method: "POST", body: { sessions: sessPayload, pricing: pricingPayload } });
            Fmt.toast("Session config saved", "ok");
          } catch (err) { Fmt.toast(err.message || "Failed", "err"); }
        });
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
    } else if (f.type === "password") {
      const v = value ?? "";
      inputHtml = `<input class="input" id="${id}" data-cfg-key="${safeKey}" type="password" value="${Fmt.escapeHtml(String(v))}" placeholder="${Fmt.escapeHtml(f.placeholder || "Paste API key…")}" autocomplete="new-password" spellcheck="false"/>`;
    } else if (f.type === "model-picker") {
      const v = value ?? "";
      const dlId = `dl-${id}`;
      inputHtml = `<input class="input" id="${id}" data-cfg-key="${safeKey}" list="${dlId}" type="text"
        value="${Fmt.escapeHtml(String(v))}" placeholder="anthropic/claude-sonnet-4-5"
        autocomplete="off" spellcheck="false"/>
        <datalist id="${dlId}" data-or-models="1"></datalist>`;
    } else if (f.type === "provider-picker") {
      const v = value ?? "";
      const dlId = `dl-${id}`;
      const opts = '<option value="">Auto</option>' +
        PROVIDER_OPTIONS.map(p => `<option value="${Fmt.escapeHtml(p)}"></option>`).join("");
      inputHtml = `<input class="input" id="${id}" data-cfg-key="${safeKey}" list="${dlId}" type="text"
        value="${Fmt.escapeHtml(String(v))}" placeholder="Auto" autocomplete="off" spellcheck="false"/>
        <datalist id="${dlId}">${opts}</datalist>`;
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
