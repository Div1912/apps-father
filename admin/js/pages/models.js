/**
 * Admin → Models page
 * Allows configuring the OpenRouter API key and per-action model settings
 * (modelId, provider, markup, max tokens, max iterations, thinking budget).
 */
window.AdminPages = window.AdminPages || {};

window.AdminPages.models = {
  title: "Models",
  render: function (container, ctx) {

  // ── State ────────────────────────────────────────────────────────────────
  let orModels = [];    // [{id, name, pricing:{prompt,completion}}] from OR catalog
  let runtimeCfg = {}; // current runtimeConfig from /admin/api/config
  let toast = null;

  const ACTION_TYPES = [
    { key: "plan",         label: "Plan",           hasIter: false, hasThink: false },
    { key: "codegen",      label: "Code Gen",       hasIter: true,  hasThink: true },
    { key: "ask",          label: "Ask / Q&A",      hasIter: false, hasThink: false },
    { key: "suggestions",  label: "Suggestions",    hasIter: false, hasThink: false },
    { key: "passport",     label: "Passport / CTX", hasIter: false, hasThink: false },
  ];
  const PROVIDER_OPTIONS = [
    "Minimax",
    "Anthropic",
    "OpenAI",
    "Google",
    "Meta",
    "Mistral",
    "DeepSeek",
    "xAI",
    "Qwen",
    "Together",
    "Fireworks",
    "DeepInfra",
    "Novita",
    "Groq",
  ];

  // ── Render ────────────────────────────────────────────────────────────────
  function render() {
    container.innerHTML = `
      <div class="models-page">
        <div class="page-hdr">
          <div>
            <h1>Models</h1>
            <div class="sub">Configure OpenRouter API key and per-action model settings. Changes take effect immediately without restart.</div>
          </div>
        </div>

        <!-- API Key Section -->
        <div class="card models-apikey-card">
          <div class="card-header">
            <h2>OpenRouter API Key</h2>
          </div>
          <div class="models-apikey-row">
            <input type="password" id="or-apikey-input" class="input" placeholder="sk-or-..." autocomplete="off" />
            <button class="btn btn-secondary" id="or-apikey-reveal">👁</button>
            <button class="btn btn-primary" id="or-apikey-save">Save Key</button>
            <button class="btn btn-secondary" id="or-apikey-test">Test &amp; Load Models</button>
          </div>
          <div id="or-apikey-status" class="models-apikey-status"></div>
        </div>

        <!-- Per-action model table -->
        <div class="card" style="margin-top:16px">
          <div class="card-header" style="display:flex;align-items:center;justify-content:space-between">
            <h2>Model Configuration</h2>
            <button class="btn btn-primary" id="models-save-all">Save All</button>
          </div>
          <div class="models-table-wrap">
            <table class="models-table" id="models-table">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Model ID</th>
                  <th>Provider</th>
                  <th>Input $/M</th>
                  <th>Output $/M</th>
                  <th>Markup ×</th>
                  <th>Max Tokens</th>
                  <th>Max Iter</th>
                  <th>Thinking</th>
                  <th></th>
                </tr>
              </thead>
              <tbody id="models-tbody">
                <tr><td colspan="10" class="loading-cell">Loading configuration…</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div id="models-toast" class="models-toast" style="display:none"></div>
      </div>
    `;

    bindEvents();
    loadConfig();
  }

  // ── Events ────────────────────────────────────────────────────────────────
  function bindEvents() {
    document.getElementById('or-apikey-reveal').addEventListener('click', () => {
      const inp = document.getElementById('or-apikey-input');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    document.getElementById('or-apikey-save').addEventListener('click', saveApiKey);
    document.getElementById('or-apikey-test').addEventListener('click', testAndLoadModels);
    document.getElementById('models-save-all').addEventListener('click', saveAll);
  }

  // ── Data loading ──────────────────────────────────────────────────────────
  async function loadConfig() {
    try {
      const data = await Api.request('/config');
      runtimeCfg = data || {};
      // Populate API key field (masked — show placeholder only)
      const keyInput = document.getElementById('or-apikey-input');
      if (runtimeCfg.openrouterApiKey) {
        keyInput.placeholder = '(key saved — enter new value to change)';
      }
      renderTable();
    } catch (err) {
      showStatus('or-apikey-status', `Failed to load config: ${err.message}`, 'error');
    }
  }

  async function testAndLoadModels() {
    const key = document.getElementById('or-apikey-input').value.trim()
      || runtimeCfg.openrouterApiKey;
    if (!key) {
      showStatus('or-apikey-status', 'Enter an API key first.', 'error');
      return;
    }

    const btn = document.getElementById('or-apikey-test');
    btn.disabled = true;
    btn.textContent = 'Loading…';
    showStatus('or-apikey-status', 'Fetching models from OpenRouter…', '');

    try {
      const data = await Api.request('/openrouter/models');
      orModels = (data.data || []).map(m => ({
        id: m.id,
        name: m.name || m.id,
        pricing: {
          prompt:     parseFloat(m.pricing?.prompt     || '0') * 1_000_000,
          completion: parseFloat(m.pricing?.completion || '0') * 1_000_000,
        },
      }));
      showStatus('or-apikey-status', `✅ Connected — ${orModels.length} models available`, 'success');
      renderTable();
    } catch (err) {
      showStatus('or-apikey-status', `❌ ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test & Load Models';
    }
  }

  // ── Table rendering ────────────────────────────────────────────────────────
  function renderTable() {
    const tbody = document.getElementById('models-tbody');
    if (!tbody) return;
    const modelConfigs = runtimeCfg.modelConfigs || {};
    tbody.innerHTML = ACTION_TYPES.map(at => renderRow(at, modelConfigs[at.key] || {})).join('');
    attachRowEvents();
  }

  function renderRow(at, cfg) {
    const modelId = cfg.modelId || '';
    const provider = cfg.provider || '';
    const markup  = cfg.markupMultiplier ?? 5;
    const maxTok  = cfg.maxTokens ?? 16000;
    const maxIter = cfg.maxIterations ?? '';
    const thinking = cfg.thinkingBudget ?? '';

    // Pricing from catalog
    const orModel = orModels.find(m => m.id === modelId);
    const inPriceM  = orModel ? orModel.pricing.prompt.toFixed(4)     : '—';
    const outPriceM = orModel ? orModel.pricing.completion.toFixed(4) : '—';

    const datalistId = `dl-${at.key}`;
    const providerDatalistId = `providers-${at.key}`;

    return `
      <tr data-action="${at.key}">
        <td class="models-action-label">${at.label}</td>
        <td class="models-model-cell">
          <input list="${datalistId}" class="input models-model-input" data-field="modelId"
            value="${esc(modelId)}" placeholder="e.g. anthropic/claude-sonnet-4-5" />
          <datalist id="${datalistId}">
            ${orModels.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}
          </datalist>
        </td>
        <td class="models-provider-cell">
          <input list="${providerDatalistId}" class="input models-provider-input" data-field="provider"
            value="${esc(provider)}" placeholder="Auto" title="OpenRouter provider name, e.g. Minimax. Empty = auto/fallback by model." />
          <datalist id="${providerDatalistId}">
            ${PROVIDER_OPTIONS.map(p => `<option value="${esc(p)}"></option>`).join('')}
          </datalist>
        </td>
        <td><span class="models-price-cell" data-pricetype="in">${inPriceM}</span></td>
        <td><span class="models-price-cell" data-pricetype="out">${outPriceM}</span></td>
        <td><input type="number" class="input models-num-input" data-field="markupMultiplier"
              value="${markup}" min="1" step="0.5" /></td>
        <td><input type="number" class="input models-num-input" data-field="maxTokens"
              value="${maxTok}" min="256" step="256" /></td>
        <td>${at.hasIter
          ? `<input type="number" class="input models-num-input" data-field="maxIterations"
                value="${maxIter}" min="1" step="1" />`
          : '<span class="models-na">—</span>'}
        </td>
        <td>${at.hasThink
          ? `<input type="number" class="input models-num-input" data-field="thinkingBudget"
                value="${thinking}" min="0" step="500" />`
          : '<span class="models-na">—</span>'}
        </td>
        <td><button class="btn btn-secondary models-save-row-btn" data-action="${at.key}">Save</button></td>
      </tr>
    `;
  }

  function attachRowEvents() {
    // Update pricing display when model ID changes
    document.querySelectorAll('.models-model-input').forEach(inp => {
      inp.addEventListener('input', e => {
        const row = e.target.closest('tr');
        const modelId = e.target.value.trim();
        const orModel = orModels.find(m => m.id === modelId);
        const inCell  = row.querySelector('[data-pricetype="in"]');
        const outCell = row.querySelector('[data-pricetype="out"]');
        if (orModel) {
          inCell.textContent  = orModel.pricing.prompt.toFixed(4);
          outCell.textContent = orModel.pricing.completion.toFixed(4);
        } else {
          inCell.textContent  = '—';
          outCell.textContent = '—';
        }
      });
    });

    document.querySelectorAll('.models-save-row-btn').forEach(btn => {
      btn.addEventListener('click', () => saveRow(btn.dataset.action));
    });
  }

  // ── Save helpers ───────────────────────────────────────────────────────────
  function getRowValues(actionKey) {
    const row = document.querySelector(`tr[data-action="${actionKey}"]`);
    if (!row) return null;
    const get = (field) => {
      const el = row.querySelector(`[data-field="${field}"]`);
      return el ? el.value : null;
    };
    const cfg = {
      modelId:         get('modelId') || '',
      provider:        (get('provider') || '').trim(),
      markupMultiplier: parseFloat(get('markupMultiplier')) || 5,
      maxTokens:        parseInt(get('maxTokens'))  || 16000,
    };
    const iterEl     = row.querySelector('[data-field="maxIterations"]');
    const thinkingEl = row.querySelector('[data-field="thinkingBudget"]');
    if (iterEl     && iterEl.value)     cfg.maxIterations  = parseInt(iterEl.value);
    if (thinkingEl && thinkingEl.value) cfg.thinkingBudget = parseInt(thinkingEl.value);
    return cfg;
  }

  async function saveRow(actionKey) {
    const cfg = getRowValues(actionKey);
    if (!cfg) return;
    const btn = document.querySelector(`.models-save-row-btn[data-action="${actionKey}"]`);
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const modelConfigs = { ...(runtimeCfg.modelConfigs || {}) };
      modelConfigs[actionKey] = cfg;
      await Api.request('/config', { method: 'POST', body: { modelConfigs } });
      runtimeCfg.modelConfigs = modelConfigs;
      showToast(`✅ ${actionKey} saved`);
    } catch (err) {
      showToast(`❌ Save failed: ${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save';
    }
  }

  async function saveAll() {
    const btn = document.getElementById('models-save-all');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const modelConfigs = {};
      for (const at of ACTION_TYPES) {
        const cfg = getRowValues(at.key);
        if (cfg) modelConfigs[at.key] = cfg;
      }
      await Api.request('/config', { method: 'POST', body: { modelConfigs } });
      runtimeCfg.modelConfigs = modelConfigs;
      showToast('✅ All model configs saved');
    } catch (err) {
      showToast(`❌ Save failed: ${err.message}`, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save All';
    }
  }

  async function saveApiKey() {
    const key = document.getElementById('or-apikey-input').value.trim();
    if (!key) { showStatus('or-apikey-status', 'Enter a key to save.', 'error'); return; }
    const btn = document.getElementById('or-apikey-save');
    btn.disabled = true;
    try {
      await Api.request('/config', { method: 'POST', body: { openrouterApiKey: key } });
      runtimeCfg.openrouterApiKey = key;
      document.getElementById('or-apikey-input').value = '';
      document.getElementById('or-apikey-input').placeholder = '(key saved — enter new value to change)';
      showStatus('or-apikey-status', '✅ API key saved', 'success');
    } catch (err) {
      showStatus('or-apikey-status', `❌ ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────
  function showStatus(id, msg, type) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.className = `models-apikey-status ${type}`;
  }

  function showToast(msg, isError = false) {
    const el = document.getElementById('models-toast');
    if (!el) return;
    el.textContent = msg;
    el.className = `models-toast ${isError ? 'error' : 'success'}`;
    el.style.display = 'block';
    clearTimeout(toast);
    toast = setTimeout(() => { el.style.display = 'none'; }, 3000);
  }

  function esc(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  render();

  },
};
