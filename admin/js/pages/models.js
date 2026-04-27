/**
 * Admin → Models page
 * Section 1: OpenRouter API key + global status
 * Section 2: Performance Tiers — add/remove, localized name+description,
 *            per-action model/provider (live OR datalist), stats 0-10,
 *            credit pricing per action.
 */
window.AdminPages = window.AdminPages || {};

window.AdminPages.models = {
  title: "Models",
  render: function (container, ctx) {

  // ── Constants ─────────────────────────────────────────────────────────────
  const ACTION_TYPES = [
    { key: "plan",        label: "Plan",           hasIter: false, hasThink: false, hasReason: true  },
    { key: "codegen",     label: "Code Gen",        hasIter: true,  hasThink: true,  hasReason: true  },
    { key: "ask",         label: "Ask / Q&A",       hasIter: false, hasThink: false, hasReason: true  },
    { key: "suggestions", label: "Suggestions",     hasIter: false, hasThink: false, hasReason: true  },
    { key: "passport",    label: "Passport / CTX",  hasIter: false, hasThink: false, hasReason: true  },
  ];
  const PRICING_ACTIONS = ["create", "update", "plan", "ask", "suggestions", "passport"];
  const LANGS = ["en", "ru", "uk"];
  const LANG_LABELS = { en: "EN", ru: "RU", uk: "UK" };
  const PROVIDER_OPTIONS = [
    "Anthropic","OpenAI","Google","Meta","Mistral","DeepSeek","xAI","Qwen",
    "Together","Fireworks","DeepInfra","Novita","Groq","Minimax",
  ];

  // ── State ─────────────────────────────────────────────────────────────────
  let orModels = [];
  let runtimeCfg = {};
  let tiers = [];          // working copy, mutated in place by readTierCards()
  let toastTimer = null;
  const providerCache = new Map();  // modelId → string[] | null

  // Per-tier active language tab. Key = tier index (string).
  const activeLang = {};

  // ── Root render ───────────────────────────────────────────────────────────
  function render() {
    container.innerHTML = `
      <div class="models-page">
        <div class="page-hdr">
          <div>
            <h1>Models</h1>
            <div class="sub">OpenRouter key, per-action defaults, and Performance Tier configuration.</div>
          </div>
        </div>

        <!-- ① API Key -->
        <div class="card models-apikey-card">
          <div class="card-header"><h2>OpenRouter API Key</h2></div>
          <div class="models-apikey-row">
            <input type="password" id="or-apikey-input" class="input" placeholder="sk-or-…" autocomplete="off" />
            <button class="btn btn-secondary" id="or-apikey-reveal">👁</button>
            <button class="btn btn-primary"   id="or-apikey-save">Save Key</button>
            <button class="btn btn-secondary" id="or-apikey-test">Test &amp; Load Models</button>
          </div>
          <div id="or-apikey-status" class="models-apikey-status"></div>
        </div>

        <!-- ② Performance Tiers -->
        <div class="card" style="margin-top:16px" id="tiers-card">
          <div class="card-header" style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            <div>
              <h2 style="margin:0">Performance Tiers</h2>
              <div class="sub" style="margin-top:2px">Each tier defines model settings, quality/speed/cost stats, and credit pricing. Users can pick a tier in the Mini App.</div>
            </div>
            <div style="display:flex;gap:8px;flex-shrink:0">
              <button class="btn btn-secondary" id="tiers-add-btn">+ Add Tier</button>
              <button class="btn btn-primary"   id="tiers-save-btn">Save Tiers</button>
            </div>
          </div>
          <div id="tiers-list" style="display:flex;flex-direction:column;gap:20px;padding:16px 0">
            <div class="loading-cell" style="text-align:center;padding:24px">Loading tiers…</div>
          </div>
        </div>

        <div id="models-toast" class="models-toast" style="display:none"></div>
      </div>
    `;

    document.getElementById('or-apikey-reveal').addEventListener('click', () => {
      const inp = document.getElementById('or-apikey-input');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });
    document.getElementById('or-apikey-save').addEventListener('click', saveApiKey);
    document.getElementById('or-apikey-test').addEventListener('click', testAndLoadModels);
    document.getElementById('tiers-add-btn').addEventListener('click', addTier);
    document.getElementById('tiers-save-btn').addEventListener('click', saveTiers);

    loadAll();
  }

  // ── Data loading ──────────────────────────────────────────────────────────
  async function loadAll() {
    try {
      const [cfgData, tiersData] = await Promise.all([
        Api.request('/config'),
        Api.request('/config/tiers'),
      ]);
      runtimeCfg = cfgData || {};
      tiers = (tiersData.tiers || []).map(normalizeTier);
      const keyInput = document.getElementById('or-apikey-input');
      if (runtimeCfg.openrouterApiKey) {
        keyInput.placeholder = '(key saved — enter new value to change)';
      }
      renderTierList();
    } catch (err) {
      showStatus('or-apikey-status', `Failed to load config: ${err.message}`, 'error');
      document.getElementById('tiers-list').innerHTML =
        `<div class="error-state">Load failed: ${esc(err.message)}</div>`;
    }
  }

  async function testAndLoadModels() {
    const key = document.getElementById('or-apikey-input').value.trim() || runtimeCfg.openrouterApiKey;
    if (!key) { showStatus('or-apikey-status', 'Enter an API key first.', 'error'); return; }
    const btn = document.getElementById('or-apikey-test');
    btn.disabled = true; btn.textContent = 'Loading…';
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
      // Re-render tiers so datalists pick up the new model list
      renderTierList();
    } catch (err) {
      showStatus('or-apikey-status', `❌ ${err.message}`, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Test & Load Models';
    }
  }

  // ── Tier normalization ────────────────────────────────────────────────────
  function normalizeTier(t) {
    const out = JSON.parse(JSON.stringify(t));
    if (!out.nameI18n)        out.nameI18n        = { en: out.name || '', ru: '', uk: '' };
    if (!out.descriptionI18n) out.descriptionI18n = { en: '', ru: '', uk: '' };
    if (!out.stats)   out.stats   = { speed: 5, quality: 5, price: 5 };
    if (!out.pricing) out.pricing = {};
    PRICING_ACTIONS.forEach(a => { if (out.pricing[a] == null) out.pricing[a] = 0; });
    if (!out.models)  out.models  = {};
    ACTION_TYPES.forEach(at => {
      out.models[at.key] = out.models[at.key] || { modelId: '', provider: '', maxTokens: 8000 };
    });
    return out;
  }

  function newTier(index) {
    return normalizeTier({
      id:   `tier_${index}`,
      name: `Tier ${index}`,
      nameI18n:        { en: `Tier ${index}`, ru: '', uk: '' },
      descriptionI18n: { en: '', ru: '', uk: '' },
      stats:   { speed: 5, quality: 5, price: 5 },
      models:  {},
      pricing: {},
    });
  }

  // ── Tier list rendering ───────────────────────────────────────────────────
  function renderTierList() {
    const list = document.getElementById('tiers-list');
    if (!list) return;
    if (!tiers.length) {
      list.innerHTML = `<div style="text-align:center;padding:24px;opacity:0.5">No tiers yet. Click "+ Add Tier" to create one.</div>`;
      return;
    }
    list.innerHTML = '';
    tiers.forEach((tier, idx) => {
      const card = document.createElement('div');
      card.className = 'tier-editor-card';
      card.dataset.tierIdx = idx;
      card.innerHTML = renderTierCard(tier, idx);
      list.appendChild(card);
      bindTierCardEvents(card, tier, idx);
    });
    // Pre-fetch providers for already-set models
    tiers.forEach((tier, idx) => {
      ACTION_TYPES.forEach(at => {
        const mid = tier.models?.[at.key]?.modelId;
        if (mid) prefetchProvider(idx, at.key, mid);
      });
    });
  }

  function renderTierCard(tier, idx) {
    const lang = activeLang[idx] || 'en';
    const canRemove = tiers.length > 1;
    const modelRows = ACTION_TYPES.map(at => renderModelRow(tier, idx, at)).join('');

    return `
      <div class="tier-editor-header">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="tier-id-badge">${esc(tier.id)}</span>
          <span style="opacity:0.5;font-size:13px">drag to reorder</span>
        </div>
        ${canRemove
          ? `<button class="btn btn-danger-sm tier-remove-btn" data-idx="${idx}" title="Remove tier">Remove</button>`
          : ''}
      </div>

      <!-- Localized names -->
      <div class="tier-section">
        <div class="tier-section-label">Name &amp; Description</div>
        <div class="lang-tabs">
          ${LANGS.map(l => `
            <button class="lang-tab ${l === lang ? 'active' : ''}" data-lang="${l}" data-tier-idx="${idx}">
              ${LANG_LABELS[l]}
            </button>
          `).join('')}
        </div>
        <div class="tier-i18n-fields">
          ${LANGS.map(l => `
            <div class="i18n-group" data-lang-group="${l}" data-tier-idx="${idx}" ${l !== lang ? 'style="display:none"' : ''}>
              <input class="input tier-name-input" data-lang="${l}" data-tier-idx="${idx}"
                placeholder="Tier name (${l.toUpperCase()})"
                value="${esc(tier.nameI18n?.[l] || '')}" />
              <textarea class="input tier-desc-input" data-lang="${l}" data-tier-idx="${idx}"
                placeholder="Description (${l.toUpperCase()}) — shown to users in tier selector"
                rows="2">${esc(tier.descriptionI18n?.[l] || '')}</textarea>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Stats -->
      <div class="tier-section">
        <div class="tier-section-label">Stats (0 – 10)</div>
        <div class="tier-stats-row">
          ${['speed','quality','price'].map(s => `
            <div class="tier-stat-group">
              <label>${s.charAt(0).toUpperCase() + s.slice(1)}</label>
              <input type="range" class="tier-stat-range tier-stat-input" min="0" max="10" step="1"
                data-stat="${s}" data-tier-idx="${idx}" value="${tier.stats?.[s] ?? 5}">
              <span class="tier-stat-val" id="stat-val-${idx}-${s}">${tier.stats?.[s] ?? 5}</span>
            </div>
          `).join('')}
        </div>
      </div>

      <!-- Models -->
      <div class="tier-section">
        <div class="tier-section-label">Models</div>
        <div class="tier-models-wrap">
          <table class="models-table tier-models-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Model ID</th>
                <th>Provider</th>
                <th>$/M in</th>
                <th>$/M out</th>
                <th>Max Tokens</th>
                <th>Max Iter</th>
                <th>Thinking</th>
                <th title="OpenRouter reasoning.max_tokens — for Kimi, DeepSeek-R1, etc.">Reasoning</th>
              </tr>
            </thead>
            <tbody>${modelRows}</tbody>
          </table>
        </div>
      </div>

      <!-- Credit pricing -->
      <div class="tier-section">
        <div class="tier-section-label">Credit Pricing</div>
        <div class="tier-pricing-grid">
          ${PRICING_ACTIONS.map(a => `
            <div class="tier-pricing-item">
              <label>${a}</label>
              <input type="number" class="input tier-pricing-input" min="0" step="5"
                data-action="${a}" data-tier-idx="${idx}"
                value="${tier.pricing?.[a] ?? 0}" />
              <span class="pricing-unit">cr</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  function renderModelRow(tier, tierIdx, at) {
    const cfg      = tier.models?.[at.key] || {};
    const modelId  = cfg.modelId  || '';
    const provider = cfg.provider || '';
    const maxTok   = cfg.maxTokens ?? 8000;
    const maxIter  = cfg.maxIterations ?? '';
    const thinking = cfg.thinkingBudget ?? '';
    const reasoning = cfg.reasoningBudget ?? '';
    const dlModel  = `dl-t${tierIdx}-${at.key}`;
    const dlProv   = `dlp-t${tierIdx}-${at.key}`;
    const orModel  = orModels.find(m => m.id === modelId);
    const inP      = orModel ? orModel.pricing.prompt.toFixed(4) : '—';
    const outP     = orModel ? orModel.pricing.completion.toFixed(4) : '—';

    return `
      <tr data-tier-idx="${tierIdx}" data-action="${at.key}">
        <td class="models-action-label">${at.label}</td>
        <td class="models-model-cell">
          <input list="${dlModel}" class="input tier-model-input" data-field="modelId"
            data-tier-idx="${tierIdx}" data-action="${at.key}"
            value="${esc(modelId)}" placeholder="e.g. anthropic/claude-sonnet-4-5" />
          <datalist id="${dlModel}">
            ${orModels.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('')}
          </datalist>
        </td>
        <td class="models-provider-cell">
          <input list="${dlProv}" class="input tier-provider-input" data-field="provider"
            data-tier-idx="${tierIdx}" data-action="${at.key}"
            value="${esc(provider)}" placeholder="Auto" />
          <datalist id="${dlProv}">
            <option value="">Auto</option>
            ${PROVIDER_OPTIONS.map(p => `<option value="${esc(p)}"></option>`).join('')}
          </datalist>
        </td>
        <td><span class="models-price-cell" data-tier-idx="${tierIdx}" data-action="${at.key}" data-pricetype="in">${inP}</span></td>
        <td><span class="models-price-cell" data-tier-idx="${tierIdx}" data-action="${at.key}" data-pricetype="out">${outP}</span></td>
        <td><input type="number" class="input models-num-input tier-model-input" data-field="maxTokens"
              data-tier-idx="${tierIdx}" data-action="${at.key}"
              value="${maxTok}" min="256" step="256" /></td>
        <td>${at.hasIter
          ? `<input type="number" class="input models-num-input tier-model-input" data-field="maxIterations"
                data-tier-idx="${tierIdx}" data-action="${at.key}"
                value="${maxIter}" min="1" step="1" placeholder="—" />`
          : '<span class="models-na">—</span>'}
        </td>
        <td>${at.hasThink
          ? `<input type="number" class="input models-num-input tier-model-input" data-field="thinkingBudget"
                data-tier-idx="${tierIdx}" data-action="${at.key}"
                value="${thinking}" min="0" step="500" placeholder="0" />`
          : '<span class="models-na">—</span>'}
        </td>
        <td>${at.hasReason
          ? `<input type="number" class="input models-num-input tier-model-input" data-field="reasoningBudget"
                data-tier-idx="${tierIdx}" data-action="${at.key}"
                value="${reasoning}" min="0" step="1000" placeholder="off" title="OpenRouter reasoning.max_tokens. Set > 0 to cap model reasoning (Kimi, DeepSeek-R1, etc.). Must be less than Max Tokens." />`
          : '<span class="models-na">—</span>'}
        </td>
      </tr>
    `;
  }

  // ── Card events ───────────────────────────────────────────────────────────
  function bindTierCardEvents(card, tier, idx) {
    // Lang tabs
    card.querySelectorAll('.lang-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const lang = btn.dataset.lang;
        const tidx = parseInt(btn.dataset.tierIdx, 10);
        activeLang[tidx] = lang;
        card.querySelectorAll('.lang-tab').forEach(b =>
          b.classList.toggle('active', b.dataset.lang === lang));
        card.querySelectorAll('.i18n-group').forEach(g =>
          (g.style.display = g.dataset.langGroup === lang ? '' : 'none'));
      });
    });

    // Remove tier
    card.querySelector('.tier-remove-btn')?.addEventListener('click', () => {
      if (!confirm(`Remove tier "${tier.id}"? This cannot be undone without saving.`)) return;
      tiers.splice(idx, 1);
      renderTierList();
    });

    // Stat range → live value display
    card.querySelectorAll('.tier-stat-input').forEach(inp => {
      inp.addEventListener('input', () => {
        const valEl = document.getElementById(`stat-val-${inp.dataset.tierIdx}-${inp.dataset.stat}`);
        if (valEl) valEl.textContent = inp.value;
      });
    });

    // Model ID input → update pricing, debounce provider fetch
    const debounce = {};
    card.querySelectorAll('.tier-model-input[data-field="modelId"]').forEach(inp => {
      inp.addEventListener('input', () => {
        const tidx   = parseInt(inp.dataset.tierIdx, 10);
        const action = inp.dataset.action;
        const mid    = inp.value.trim();
        // Update price cells
        const orM = orModels.find(m => m.id === mid);
        const inCell  = card.querySelector(`[data-pricetype="in"][data-tier-idx="${tidx}"][data-action="${action}"]`);
        const outCell = card.querySelector(`[data-pricetype="out"][data-tier-idx="${tidx}"][data-action="${action}"]`);
        if (inCell)  inCell.textContent  = orM ? orM.pricing.prompt.toFixed(4) : '—';
        if (outCell) outCell.textContent = orM ? orM.pricing.completion.toFixed(4) : '—';
        // Debounced provider fetch
        const key = `${tidx}-${action}`;
        clearTimeout(debounce[key]);
        debounce[key] = setTimeout(() => fetchAndPopulateProvider(tidx, action, mid), 600);
      });
    });
  }

  // ── Provider fetching ─────────────────────────────────────────────────────
  async function prefetchProvider(tierIdx, action, modelId) {
    if (!modelId || !modelId.includes('/')) return;
    await fetchAndPopulateProvider(tierIdx, action, modelId);
  }

  async function fetchAndPopulateProvider(tierIdx, action, modelId) {
    const dlId = `dlp-t${tierIdx}-${action}`;
    const dl = document.getElementById(dlId);
    if (!dl) return;

    if (providerCache.has(modelId)) {
      populateDl(dl, providerCache.get(modelId));
      return;
    }

    if (!modelId.includes('/')) { populateDl(dl, null); return; }
    const [author, ...rest] = modelId.split('/');
    const slug = rest.join('/');
    try {
      const data = await Api.request(`/openrouter/models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`);
      const providers = (data?.data?.endpoints || [])
        .map(e => e.provider_name).filter(Boolean)
        .filter((v, i, a) => a.indexOf(v) === i);
      const list = providers.length ? providers : null;
      providerCache.set(modelId, list);
      populateDl(dl, list);
    } catch {
      providerCache.set(modelId, null);
      populateDl(dl, null);
    }
  }

  function populateDl(dl, providers) {
    const list = providers || PROVIDER_OPTIONS;
    dl.innerHTML = '<option value="">Auto</option>' +
      list.map(p => `<option value="${esc(p)}"></option>`).join('');
  }

  // ── Read card values → tiers array ────────────────────────────────────────
  function readAllTierCards() {
    const list = document.getElementById('tiers-list');
    if (!list) return;
    list.querySelectorAll('.tier-editor-card').forEach(card => {
      const idx = parseInt(card.dataset.tierIdx, 10);
      if (!tiers[idx]) return;
      const tier = tiers[idx];

      // i18n
      tier.nameI18n        = tier.nameI18n        || {};
      tier.descriptionI18n = tier.descriptionI18n || {};
      LANGS.forEach(l => {
        const ni = card.querySelector(`.tier-name-input[data-lang="${l}"]`);
        const di = card.querySelector(`.tier-desc-input[data-lang="${l}"]`);
        if (ni) tier.nameI18n[l]        = ni.value.trim();
        if (di) tier.descriptionI18n[l] = di.value.trim();
      });
      // Use EN name as canonical `name`
      tier.name = tier.nameI18n.en || tier.id;

      // Stats
      card.querySelectorAll('.tier-stat-input').forEach(inp => {
        tier.stats[inp.dataset.stat] = parseInt(inp.value, 10);
      });

      // Models
      card.querySelectorAll('tr[data-tier-idx]').forEach(row => {
        const action = row.dataset.action;
        if (!action) return;
        tier.models[action] = tier.models[action] || {};
        const get = field => {
          const el = row.querySelector(`[data-field="${field}"]`);
          return el ? el.value : null;
        };
        tier.models[action].modelId  = get('modelId') || '';
        tier.models[action].provider = (get('provider') || '').trim();
        const maxTok = get('maxTokens');
        if (maxTok) tier.models[action].maxTokens = parseInt(maxTok, 10);
        const maxIter = get('maxIterations');
        if (maxIter !== null && maxIter !== '') tier.models[action].maxIterations = parseInt(maxIter, 10);
        const thinking = get('thinkingBudget');
        if (thinking !== null && thinking !== '') tier.models[action].thinkingBudget = parseInt(thinking, 10);
        const reasoning = get('reasoningBudget');
        if (reasoning !== null && reasoning !== '') tier.models[action].reasoningBudget = parseInt(reasoning, 10);
        else delete tier.models[action].reasoningBudget;
      });

      // Pricing
      card.querySelectorAll('.tier-pricing-input').forEach(inp => {
        tier.pricing[inp.dataset.action] = parseInt(inp.value, 10) || 0;
      });
    });
  }

  // ── Add / save tiers ──────────────────────────────────────────────────────
  function addTier() {
    readAllTierCards();
    tiers.push(newTier(tiers.length));
    renderTierList();
    // Scroll to new card
    const list = document.getElementById('tiers-list');
    list.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function saveTiers() {
    readAllTierCards();
    const btn = document.getElementById('tiers-save-btn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      await Api.request('/config/tiers', { method: 'POST', body: { tiers } });
      showToast('✅ Tiers saved');
    } catch (err) {
      showToast(`❌ ${err.message}`, true);
    } finally {
      btn.disabled = false; btn.textContent = 'Save Tiers';
    }
  }

  // ── API key helpers ───────────────────────────────────────────────────────
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
