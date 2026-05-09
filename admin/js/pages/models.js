/**
 * Admin → Agent page
 * Single section: Agent Session Configuration — complexity-bucketed credit
 * price matrix and per-session model/iteration limits.
 *
 * The OpenRouter API key lives on the Configuration tab now (single source
 * of truth) — duplicating it here was confusing and let two saves race.
 */
window.AdminPages = window.AdminPages || {};

window.AdminPages.models = {
  title: "Agent",
  render: function (container, ctx) {

  // ── Constants ─────────────────────────────────────────────────────────────
  const PROVIDER_OPTIONS = [
    "Anthropic","OpenAI","Google","Meta","Mistral","DeepSeek","xAI","Qwen",
    "Together","Fireworks","DeepInfra","Novita","Groq","Minimax",
  ];

  // 'max-mode' is a synthetic slot. Not chosen by the router; used when the
  // user toggles MAX MODE on a paid proposal. Listed last so admins see the
  // ordinary types first.
  const SESSION_TYPES = [
    'router','answer','build','update','update-plan','bug-fix','suggestions','context','max-mode',
  ];
  const COMPLEXITIES  = ['trivial','small','medium','large','huge'];
  const PRICING_ROWS  = [
    { key: 'build',                  label: 'Build',                  hint: 'Credit cost when router classifies a build.' },
    { key: 'update',                 label: 'Update',                 hint: 'Credit cost for a single-step update.' },
    { key: 'update-plan',            label: 'Update-Plan (base)',     hint: 'Base cost for a multi-step plan, before per-item.' },
    { key: 'update-plan-per-item',   label: 'Update-Plan (per item)', hint: 'Added per checklist item: total = base + N × this.' },
    { key: 'bug-fix',                label: 'Bug-Fix',                hint: 'Credit cost for a router-routed bug fix.' },
  ];

  // ── State ─────────────────────────────────────────────────────────────────
  let orModels = [];
  let toastTimer = null;

  // ── Root render ───────────────────────────────────────────────────────────
  function render() {
    container.innerHTML = `
      <div class="models-page">
        <div class="page-hdr">
          <div>
            <h1>Agent</h1>
            <div class="sub">
              Per-session model, tokens, thinking budget, iteration caps and
              the complexity-bucketed credit pricing matrix.
              The OpenRouter API key is on the <strong>Configuration</strong> tab.
            </div>
          </div>
        </div>

        <!-- Agent Session Configuration (pricing matrix + per-type model config) -->
        <div class="card" id="agent-sessions-card">
          <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            <div>
              <h2 style="margin:0">Agent Session Configuration</h2>
              <div class="sub" style="margin-top:2px">
                Per-session model, tokens, thinking budget, and iteration limits.
                Pricing is in credits and selected by the router-classified <em>complexity</em>
                bucket (trivial &middot; small &middot; medium &middot; large &middot; huge).
              </div>
            </div>
            <div style="display:flex;gap:8px;flex-shrink:0">
              <button class="btn btn-primary" id="agent-sessions-save">Save Session Config</button>
            </div>
          </div>
          <div id="agent-sessions-body" style="padding:16px 0">
            <div class="loading-cell" style="text-align:center;padding:24px">Loading…</div>
          </div>
        </div>

        <div id="models-toast" class="models-toast" style="display:none"></div>
      </div>
    `;

    document.getElementById('agent-sessions-save').addEventListener('click', saveAgentSessions);

    loadAgentSessions();
    // Kick off a background OR-models fetch so the model picker dropdown
    // has the live catalog by the time the user clicks into a model field.
    Api.request('/openrouter/models').then(data => {
      orModels = (data?.data || []).map(m => ({ id: m.id, name: m.name || m.id }));
      const dl = document.getElementById('ag-sess-models');
      if (dl && orModels.length) {
        dl.innerHTML = orModels.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
      }
    }).catch(() => {});
  }

  // ── Agent Session Configuration (pricing matrix + per-type config) ────────
  async function loadAgentSessions() {
    const body = document.getElementById('agent-sessions-body');
    if (!body) return;
    try {
      const [data, cfg] = await Promise.all([
        Api.request('/config/sessions'),
        Api.request('/config').catch(() => ({})),
      ]);
      renderAgentSessions(data.sessions || {}, data.pricing || {}, cfg.maxModeMultiplier ?? 3);
    } catch (err) {
      body.innerHTML = `<div class="error-state">Failed to load: ${esc(err.message)}</div>`;
    }
  }

  function renderAgentSessions(sessions, pricing, maxModeMultiplier) {
    const body = document.getElementById('agent-sessions-body');
    if (!body) return;

    body.innerHTML = `
      <h3 style="margin:0 0 6px;font-size:14px">Session Pricing</h3>
      <div class="sub" style="margin-bottom:10px">
        Each cell is the credit cost for that session type at that complexity bucket.
        Final price = matrix[type][complexity], plus N × matrix["update-plan-per-item"][c] for plans.
      </div>

      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;padding:10px 12px;border:1px solid var(--admin-card-border);border-radius:10px;background:rgba(255,184,77,0.05)">
        <div style="font-size:18px">⚡</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:13px">MAX Mode markup</div>
          <div class="sub" style="font-size:11px">Multiplier applied to the matrix price when a user enables MAX MODE on the proposal card. Floor 1× — we won't let it undercharge.</div>
        </div>
        <input id="ag-maxmode-mult" type="number" min="1" step="0.25"
          value="${Number(maxModeMultiplier) || 3}"
          class="input" style="width:90px;text-align:center;font-weight:600" />
        <span class="sub" style="font-size:11px;font-weight:600">×</span>
      </div>
      <div style="overflow-x:auto;margin-bottom:24px">
        <table class="models-table" style="width:100%">
          <thead>
            <tr>
              <th style="text-align:left">Type</th>
              ${COMPLEXITIES.map(c => `<th style="text-align:center;text-transform:capitalize">${c}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${PRICING_ROWS.map(row => `
              <tr>
                <td>
                  <div style="font-weight:500">${esc(row.label)}</div>
                  <div class="sub" style="font-size:11px">${esc(row.hint)}</div>
                </td>
                ${COMPLEXITIES.map(c => `
                  <td style="text-align:center">
                    <input class="input ag-price"
                      data-type="${esc(row.key)}" data-complexity="${esc(c)}"
                      type="number" min="0" step="1"
                      value="${Number((pricing[row.key] || {})[c] ?? 0)}"
                      style="width:70px;text-align:center" />
                  </td>
                `).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <h3 style="margin:0 0 6px;font-size:14px">Session Configs</h3>
      <div class="sub" style="margin-bottom:10px">Model + limits per session type.</div>
      <div style="overflow-x:auto">
        <table class="models-table" style="width:100%">
          <thead>
            <tr>
              <th style="text-align:left">Type</th>
              <th>Model</th>
              <th>Provider</th>
              <th>Max Tokens</th>
              <th>Thinking</th>
              <th>Reasoning</th>
              <th>Iterations</th>
            </tr>
          </thead>
          <tbody>
            ${SESSION_TYPES.map(type => {
              const s = sessions[type] || {};
              return `<tr>
                <td style="font-weight:500">${esc(type)}</td>
                <td><input class="input ag-sess" data-type="${esc(type)}" data-field="model" type="text" value="${esc(s.model||'')}" list="ag-sess-models" style="min-width:200px"/></td>
                <td><input class="input ag-sess" data-type="${esc(type)}" data-field="provider" type="text" value="${esc(s.provider||'')}" list="ag-sess-providers" placeholder="auto" style="min-width:110px"/></td>
                <td><input class="input ag-sess" data-type="${esc(type)}" data-field="max_tokens" type="number" min="256" step="256" value="${s.max_tokens||0}" style="width:90px"/></td>
                <td><input class="input ag-sess" data-type="${esc(type)}" data-field="thinking" type="number" min="0" step="500" value="${s.thinking||0}" style="width:80px" title="0 = disabled"/></td>
                <td style="text-align:center"><input type="checkbox" class="ag-sess" data-type="${esc(type)}" data-field="reasoning" ${s.reasoning ? 'checked' : ''}/></td>
                <td><input class="input ag-sess" data-type="${esc(type)}" data-field="iterations" type="number" min="1" step="1" value="${s.iterations||1}" style="width:70px"/></td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        <datalist id="ag-sess-models"></datalist>
        <datalist id="ag-sess-providers">
          ${PROVIDER_OPTIONS.map(p => `<option value="${esc(p)}"></option>`).join('')}
        </datalist>
      </div>
    `;

    // Hydrate the model datalist with whatever OR catalog the boot fetch
    // has already loaded. The boot fetch retries on first render, so even
    // if it lost the race here it'll fill the dropdown a moment later.
    const dl = document.getElementById('ag-sess-models');
    if (dl && orModels.length) {
      dl.innerHTML = orModels.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
    }
  }

  async function saveAgentSessions() {
    const body = document.getElementById('agent-sessions-body');
    if (!body) return;

    const pricing = {};
    PRICING_ROWS.forEach(row => { pricing[row.key] = {}; });
    body.querySelectorAll('.ag-price').forEach(inp => {
      const t = inp.dataset.type;
      const c = inp.dataset.complexity;
      if (t && c) pricing[t][c] = Math.max(0, Number(inp.value) || 0);
    });

    const sessions = {};
    SESSION_TYPES.forEach(type => { sessions[type] = {}; });
    body.querySelectorAll('.ag-sess').forEach(inp => {
      const type = inp.dataset.type;
      const field = inp.dataset.field;
      if (!type || !field) return;
      if (inp.type === 'checkbox') sessions[type][field] = inp.checked;
      else if (field === 'model' || field === 'provider') sessions[type][field] = (inp.value || '').trim();
      else sessions[type][field] = Math.max(0, Number(inp.value) || 0);
    });

    const multInput = body.querySelector('#ag-maxmode-mult');
    const maxModeMultiplier = multInput ? Math.max(1, Number(multInput.value) || 1) : undefined;

    const btn = document.getElementById('agent-sessions-save');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await Api.request('/config/sessions', { method: 'POST', body: { sessions, pricing } });
      // Multiplier lives on the top-level RuntimeConfig, not the
      // session-config doc — POST it through the generic /config endpoint.
      if (maxModeMultiplier !== undefined) {
        await Api.request('/config', { method: 'POST', body: { maxModeMultiplier } });
      }
      showToast('✅ Session config saved');
    } catch (err) {
      showToast(`❌ ${err.message}`, true);
    } finally {
      btn.disabled = false; btn.textContent = 'Save Session Config';
    }
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────
  function showToast(msg, isError = false) {
    const el = document.getElementById('models-toast');
    if (!el) return;
    el.textContent = msg;
    el.className = `models-toast ${isError ? 'error' : 'success'}`;
    el.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.display = 'none'; }, 3500);
  }

  function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  render();

  },
};
