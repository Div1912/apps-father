/* Bundles — Credit pack editor for the topup system */
(function () {
  "use strict";
  window.AdminPages = window.AdminPages || {};

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;

  let bundles = [];
  let editingId = null;

  function esc(s) {
    return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function bundlePreview(b, isFirst) {
    const total = isFirst ? (b.credits + b.bonusCredits) * 2 : (b.credits + b.bonusCredits);
    const basePrice = b.discount > 0 ? +(b.priceUsd / (1 - b.discount / 100)).toFixed(2) : null;
    return `
      <div class="bundle-preview-card">
        ${isFirst ? '<div class="bundle-preview-tag">×2 FIRST</div>' : ''}
        <div class="bundle-preview-name">${esc(b.name)}</div>
        <div class="bundle-preview-credits">
          ${Fmt.creditsHtml(total, '#fbbf24')}${b.bonusCredits > 0 ? ` <span style="opacity:.6;font-size:11px;">(+${(b.bonusCredits * (isFirst ? 2 : 1)).toLocaleString()} bonus)</span>` : ''}
        </div>
        <div class="bundle-preview-price">
          ${basePrice ? `<s style="opacity:.4">$${basePrice.toFixed(2)}</s> ` : ''}<b>$${Number(b.priceUsd).toFixed(2)}</b>
          ${b.discount > 0 ? `<span class="badge badge--green">-${b.discount}%</span>` : ''}
        </div>
        ${b.isLimited && b.limitTotal ? `<div class="bundle-preview-limit">${b.purchaseCount}/${b.limitTotal} sold</div>` : ''}
        ${!b.isActive ? '<div style="color:#f87171;font-size:11px;">Inactive</div>' : ''}
      </div>`;
  }

  function renderTable(host) {
    const tbody = host.querySelector('#bundles-tbody');
    if (!tbody) return;
    if (!bundles.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="table-empty">No bundles yet. Click "Add Bundle" to create one.</td></tr>`;
      return;
    }
    tbody.innerHTML = bundles.map(b => `
      <tr class="${!b.isActive ? 'row-inactive' : ''}">
        <td><b>${esc(b.name)}</b></td>
        <td>${Fmt.creditsHtml(b.credits)}</td>
        <td>${b.bonusCredits > 0 ? Fmt.creditsHtml(b.bonusCredits, '#fbbf24') : '—'}</td>
        <td>$${Number(b.priceUsd).toFixed(2)}</td>
        <td>${b.discount > 0 ? `<span class="badge badge--green">-${b.discount}%</span>` : '—'}</td>
        <td>${b.isLimited && b.limitTotal ? `${b.purchaseCount}/${b.limitTotal}` : '—'}</td>
        <td><span class="badge ${b.isActive ? 'badge--green' : 'badge--gray'}">${b.isActive ? 'Active' : 'Inactive'}</span></td>
        <td class="table-actions">
          <button class="btn btn-sm" data-edit="${b.id}">Edit</button>
          ${b.isLimited ? `<button class="btn btn-sm btn--outline" data-reset="${b.id}" title="Reset sold count">Reset</button>` : ''}
          <button class="btn btn-sm btn--danger" data-delete="${b.id}">Delete</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => openEditor(host, btn.dataset.edit));
    });
    tbody.querySelectorAll('[data-reset]').forEach(btn => {
      btn.addEventListener('click', () => resetCount(host, btn.dataset.reset));
    });
    tbody.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', () => deleteBundle(host, btn.dataset.delete));
    });
  }

  function openEditor(host, id) {
    editingId = id || null;
    const bundle = id ? bundles.find(b => b.id === id) : null;
    const b = bundle || { name: '', credits: 500, bonusCredits: 0, priceUsd: 9.99, discount: 0, isLimited: false, limitTotal: null, isActive: true, sortOrder: 0 };

    const panel = host.querySelector('#bundle-editor');
    const title = host.querySelector('#editor-title');
    if (title) title.textContent = id ? 'Edit Bundle' : 'Add Bundle';

    host.querySelector('#be-name').value = b.name;
    host.querySelector('#be-credits').value = b.credits;
    host.querySelector('#be-bonus').value = b.bonusCredits;
    host.querySelector('#be-price').value = b.priceUsd;
    host.querySelector('#be-discount').value = b.discount;
    host.querySelector('#be-limited').checked = !!b.isLimited;
    host.querySelector('#be-limit-total').value = b.limitTotal || '';
    host.querySelector('#be-active').checked = b.isActive !== false;
    host.querySelector('#be-sort').value = b.sortOrder || 0;

    host.querySelector('#be-limit-row').style.display = b.isLimited ? '' : 'none';

    panel.classList.remove('hidden');
    updatePreview(host);
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function closeEditor(host) {
    editingId = null;
    host.querySelector('#bundle-editor')?.classList.add('hidden');
  }

  function getFormData(host) {
    return {
      name: host.querySelector('#be-name').value.trim(),
      credits: parseInt(host.querySelector('#be-credits').value, 10),
      bonusCredits: parseInt(host.querySelector('#be-bonus').value, 10) || 0,
      priceUsd: parseFloat(host.querySelector('#be-price').value),
      discount: parseInt(host.querySelector('#be-discount').value, 10) || 0,
      isLimited: host.querySelector('#be-limited').checked,
      limitTotal: host.querySelector('#be-limited').checked ? (parseInt(host.querySelector('#be-limit-total').value, 10) || null) : null,
      isActive: host.querySelector('#be-active').checked,
      sortOrder: parseInt(host.querySelector('#be-sort').value, 10) || 0,
    };
  }

  function updatePreview(host) {
    const b = getFormData(host);
    const prevEl = host.querySelector('#bundle-preview');
    if (prevEl) prevEl.innerHTML = bundlePreview(b, false) + bundlePreview(b, true);
  }

  async function saveBundle(host) {
    const data = getFormData(host);
    if (!data.name) { Fmt.toast('Name is required', 'err'); return; }
    if (!data.credits || data.credits < 1) { Fmt.toast('Credits must be ≥ 1', 'err'); return; }
    if (!data.priceUsd || data.priceUsd <= 0) { Fmt.toast('Price must be > 0', 'err'); return; }

    const path = editingId ? `/admin/api/bundles/${editingId}` : '/admin/api/bundles';
    const method = editingId ? 'PUT' : 'POST';
    try {
      await Api.request(path, { method, body: data });
      Fmt.toast(editingId ? 'Bundle updated' : 'Bundle created', 'ok');
      closeEditor(host);
      await loadBundles(host);
    } catch (err) {
      Fmt.toast(err.message || 'Save failed', 'err');
    }
  }

  async function deleteBundle(host, id) {
    if (!confirm('Deactivate this bundle?')) return;
    try {
      await Api.request(`/admin/api/bundles/${id}`, { method: 'DELETE' });
      Fmt.toast('Bundle deactivated', 'ok');
      await loadBundles(host);
    } catch (err) {
      Fmt.toast(err.message || 'Delete failed', 'err');
    }
  }

  async function resetCount(host, id) {
    if (!confirm('Reset purchase count to 0?')) return;
    try {
      await Api.request(`/admin/api/bundles/${id}/reset-count`, { method: 'POST' });
      Fmt.toast('Count reset', 'ok');
      await loadBundles(host);
    } catch (err) {
      Fmt.toast(err.message || 'Reset failed', 'err');
    }
  }

  async function loadBundles(host) {
    try {
      bundles = await Api.request('/admin/api/bundles');
      renderTable(host);
    } catch (err) {
      Fmt.toast('Failed to load bundles', 'err');
    }
  }

  window.AdminPages.bundles = {
    title: "Bundles",
    icon: ICON,
    render: async function (host) {
      host.innerHTML = `
        <div class="page-hdr">
          <div>
            <h1>Bundles</h1>
            <div class="sub">Credit packs users can purchase in the mini-app</div>
          </div>
          <button class="btn btn--primary" id="add-bundle-btn">+ Add Bundle</button>
        </div>

        <!-- Editor panel -->
        <div class="card hidden" id="bundle-editor" style="margin-bottom:20px;">
          <div class="card-title" id="editor-title">Add Bundle</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 20px;margin-bottom:16px;">
            <div>
              <div class="input-label">Name</div>
              <input class="input" id="be-name" type="text" placeholder="Starter Pack" style="width:100%">
            </div>
            <div>
              <div class="input-label">Sort order</div>
              <input class="input" id="be-sort" type="number" value="0" style="width:100%">
            </div>
            <div>
              <div class="input-label">Base credits</div>
              <input class="input" id="be-credits" type="number" value="500" min="1" style="width:100%">
            </div>
            <div>
              <div class="input-label">Bonus credits</div>
              <input class="input" id="be-bonus" type="number" value="0" min="0" style="width:100%">
            </div>
            <div>
              <div class="input-label">Price (USD)</div>
              <input class="input" id="be-price" type="number" value="9.99" step="0.01" min="0.01" style="width:100%">
            </div>
            <div>
              <div class="input-label">Discount % (0 = none)</div>
              <input class="input" id="be-discount" type="number" value="0" min="0" max="99" style="width:100%">
            </div>
          </div>
          <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap;margin-bottom:12px;">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" id="be-limited"> Limited bundle
            </label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
              <input type="checkbox" id="be-active" checked> Active
            </label>
          </div>
          <div id="be-limit-row" style="display:none;margin-bottom:12px;">
            <div class="input-label">Limit (total purchasable)</div>
            <input class="input" id="be-limit-total" type="number" value="50" min="1" style="width:160px">
          </div>

          <div class="input-label" style="margin-bottom:8px;">Preview</div>
          <div id="bundle-preview" style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px;"></div>

          <div style="display:flex;gap:10px;">
            <button class="btn btn--primary" id="save-bundle-btn">Save</button>
            <button class="btn btn--outline" id="cancel-bundle-btn">Cancel</button>
          </div>
        </div>

        <!-- Table -->
        <div class="card">
          <table class="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Credits</th>
                <th>Bonus</th>
                <th>Price</th>
                <th>Discount</th>
                <th>Sold/Limit</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="bundles-tbody">
              <tr><td colspan="8" class="table-empty">Loading…</td></tr>
            </tbody>
          </table>
        </div>
      `;

      // Wire editor events
      host.querySelector('#add-bundle-btn').addEventListener('click', () => openEditor(host, null));
      host.querySelector('#save-bundle-btn').addEventListener('click', () => saveBundle(host));
      host.querySelector('#cancel-bundle-btn').addEventListener('click', () => closeEditor(host));

      host.querySelector('#be-limited').addEventListener('change', (e) => {
        host.querySelector('#be-limit-row').style.display = e.target.checked ? '' : 'none';
        updatePreview(host);
      });

      // Live preview update
      ['#be-name','#be-credits','#be-bonus','#be-price','#be-discount','#be-active'].forEach(sel => {
        host.querySelector(sel)?.addEventListener('input', () => updatePreview(host));
      });

      await loadBundles(host);
    },
  };
})();
