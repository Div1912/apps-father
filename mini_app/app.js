'use strict';

const tg = window.Telegram?.WebApp;
const API_BASE = '/telegram-mini-app/api';

let projects = [];
let currentProject = null;
let currentToken = null;
let currentView = 'list';
let editOriginal = {};

const AVATAR_GRADIENTS = [
  ['#82b1ff', '#665fff'],
  ['#ffcd6a', '#ffa85c'],
  ['#e0a2f3', '#d669ed'],
  ['#a0de7e', '#54cb68'],
  ['#72d5fd', '#2a9ef1'],
  ['#ff8a80', '#ff5252'],
  ['#80cbc4', '#26a69a'],
  ['#ffab91', '#ff7043'],
];

function getGradient(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_GRADIENTS[Math.abs(hash) % AVATAR_GRADIENTS.length];
}

function getInitials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.substring(0, 2).toUpperCase();
}

function avatarSvgDataUri(name) {
  const [c1, c2] = getGradient(name);
  const initials = getInitials(name);
  const svg = `<svg width="160" height="160" preserveAspectRatio="none" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0%" x2="0%" y1="0%" y2="100%"><stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs><style>text{font:600 44px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-user-select:none;user-select:none}</style><rect width="100" height="100" fill="url(#g)"/><text text-anchor="middle" x="50" y="66" fill="#fff">${initials}</text></svg>`;
  return 'data:image/svg+xml;base64,' + btoa(svg);
}

function statusLabel(status) {
  const map = {
    released: 'Released', deployed: 'Deployed', building: 'Building',
    planning: 'Planning', created: 'Created', error: 'Error',
  };
  return map[status] || status;
}

function hasFeature(project, feature) {
  try {
    const features = JSON.parse(project.features || '[]');
    return features.includes(feature);
  } catch { return false; }
}

function apiHeaders() {
  const h = {};
  if (tg?.initData) h['X-Telegram-Init-Data'] = tg.initData;
  return h;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

// ── Spoiler points ──

function generateSpoilerPoints(container, text) {
  container.querySelectorAll('.point').forEach(p => p.remove());
  const rect = container.getBoundingClientRect();
  const w = rect.width || 260;
  const h = rect.height || 20;
  const count = Math.min(Math.floor(w / 1.5), 180);
  for (let i = 0; i < count; i++) {
    const b = document.createElement('b');
    b.className = 'point';
    const x = Math.random() * w;
    const y = Math.random() * h;
    const s = 0.33 + Math.random() * 0.12;
    const o = [0.158, 0.316, 0.475, 0.633, 0.791, 0.95][Math.floor(Math.random() * 6)];
    b.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    b.style.opacity = o;
    b.style.animationDelay = `${Math.random() * 1.5}s`;
    container.appendChild(b);
  }
}

// ── Rendering ──

function renderAppList(filter) {
  const listEl = document.getElementById('app-list');
  const noResults = document.getElementById('no-results');
  const noResultsText = document.getElementById('no-results-text');

  const filtered = filter
    ? projects.filter(p =>
        p.name.toLowerCase().includes(filter) ||
        (p.botUsername || '').toLowerCase().includes(filter)
      )
    : projects;

  if (filtered.length === 0 && projects.length > 0) {
    listEl.classList.add('hidden');
    noResults.classList.remove('hidden');
    noResultsText.textContent = filter ? `No results for "${filter}"` : '';
    return;
  }

  noResults.classList.add('hidden');
  listEl.classList.remove('hidden');

  let html = '';
  for (const p of filtered) {
    const avatarSrc = avatarSvgDataUri(p.name);
    const username = p.botUsername ? `@${p.botUsername}` : '';
    html += `<a class="tm-row tm-row-link" data-id="${p.id}">` +
      `<img class="tm-row-pic tm-row-pic-user" src="${avatarSrc}">` +
      `<div><div class="tm-row-value">${esc(p.name)}</div>` +
      `<div class="tm-row-description">${esc(username)}</div></div>` +
      `<div class="tm-row-status"><span class="tm-status-dot ${p.status}"></span>${statusLabel(p.status)}</div>` +
      `</a>`;
  }

  listEl.innerHTML = html;

  listEl.querySelectorAll('.tm-row').forEach(row => {
    row.addEventListener('click', () => openDetail(row.dataset.id));
  });
}

async function openDetail(id) {
  currentProject = projects.find(p => p.id === id);
  if (!currentProject) return;
  const p = currentProject;

  document.getElementById('detail-name').textContent = p.name;
  document.getElementById('detail-username').textContent = p.botUsername ? `@${p.botUsername}` : '';
  document.getElementById('detail-description').textContent = p.description || '';

  const [c1, c2] = getGradient(p.name);
  const avatarEl = document.getElementById('detail-avatar');
  avatarEl.textContent = getInitials(p.name);
  avatarEl.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;

  const version = p.currentVersion || 0;
  const cost = p.totalCostUsd ? `$${Number(p.totalCostUsd).toFixed(2)}` : '$0.00';
  document.getElementById('detail-info').innerHTML =
    `Version: <b>${version}</b> · Total cost: <b>${cost}</b> · Quality: <b>Tier ${p.qualityTier || 1}</b>`;

  const isLive = ['deployed', 'released'].includes(p.status);
  const baseUrl = location.origin;

  // Token section
  currentToken = null;
  const tokenSection = document.getElementById('section-token');
  const spoiler = document.getElementById('token-spoiler');
  spoiler.classList.add('spoiler-active');
  spoiler.classList.remove('js-spoiler-revealed');
  document.getElementById('token-text').textContent = '';
  tokenSection.style.display = 'none';

  fetchToken(p.id);

  // App section
  let appRows = '';
  if (isLive) {
    appRows += menuRow('Test App', 'af-icon-test', `${baseUrl}/dev/${p.id}/`);
    if (p.botUsername) {
      appRows += menuRow('Open App', 'af-icon-open', `https://t.me/${p.botUsername}`);
    }
  }
  document.getElementById('detail-app-rows').innerHTML = appRows;
  document.getElementById('section-app').style.display = appRows ? '' : 'none';

  // Development
  let devRows = menuRow('Update App', 'af-icon-update');
  if (isLive) {
    devRows += menuRow('Release Version', 'af-icon-release');
  }
  devRows += menuRow('Versions', 'af-icon-versions');
  devRows += menuRow('Suggestions', 'af-icon-suggest');
  document.getElementById('detail-dev-rows').innerHTML = devRows;

  // Monetization
  let moneyRows = menuRow('Features', 'af-icon-features');
  if (hasFeature(p, 'ton_payment')) {
    moneyRows += menuRow('Wallet', 'af-icon-wallet');
  }
  document.getElementById('detail-money-rows').innerHTML = moneyRows;
  document.getElementById('section-monetization').style.display = '';

  // Settings
  let settingsRows = '';
  settingsRows += menuRowAction('Edit Bot Info', 'af-icon-edit-info', 'open-edit-info');
  settingsRows += menuRow('Quality Tier', 'af-icon-quality');
  if (hasFeature(p, 'get_code')) {
    settingsRows += menuRow('Edit Code', 'af-icon-code', `${baseUrl}/editor/${p.id}/`);
  }
  if (hasFeature(p, 'admin_panel')) {
    settingsRows += menuRow('Admin Panel', 'af-icon-admin', `${baseUrl}/admin/${p.id}/`);
  }
  document.getElementById('detail-settings-rows').innerHTML = settingsRows;

  document.getElementById('detail-settings-rows').querySelector('[data-action="open-edit-info"]')
    ?.addEventListener('click', () => openEditInfo());

  // Actions
  let actionsRows = '';
  actionsRows += `<a class="tm-row tm-row-add"><span class="tm-icon" style="--icon-s:var(--image-url-transfer-ownership)"></span><span>Transfer Ownership</span></a>`;
  actionsRows += `<a class="tm-row tm-row-destructive"><span class="tm-icon" style="--icon-s:var(--image-url-trash)"></span><span>Delete App</span></a>`;
  document.getElementById('detail-actions-rows').innerHTML = actionsRows;

  showView('detail');
}

async function fetchToken(projectId) {
  try {
    const res = await fetch(`${API_BASE}/token/${projectId}`, { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    currentToken = data.token;
    document.getElementById('token-text').textContent = currentToken;
    document.getElementById('section-token').style.display = '';

    const spoiler = document.getElementById('token-spoiler');
    generateSpoilerPoints(spoiler, currentToken);
  } catch (err) {
    console.error('Failed to fetch token:', err);
  }
}

function menuRow(label, iconClass, href) {
  const hrefAttr = href ? ` href="${href}" target="_blank"` : '';
  return `<a class="tm-row tm-row-link"${hrefAttr}><span class="tm-icon ${iconClass}"></span><span>${esc(label)}</span></a>`;
}

function menuRowAction(label, iconClass, action) {
  return `<a class="tm-row tm-row-link" data-action="${action}"><span class="tm-icon ${iconClass}"></span><span>${esc(label)}</span></a>`;
}

async function loadBalance() {
  try {
    const res = await fetch(`${API_BASE}/balance`, { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('balance-amount').textContent = `$${Number(data.balance).toFixed(2)}`;
  } catch (err) {
    console.error('Failed to load balance:', err);
  }
}

// ── Edit Info ──

async function openEditInfo() {
  if (!currentProject || !currentToken) {
    tg?.showAlert('Token not loaded yet. Please wait.');
    return;
  }
  const p = currentProject;

  const [c1, c2] = getGradient(p.name);
  const avatarEl = document.getElementById('edit-avatar');
  avatarEl.textContent = getInitials(p.name);
  avatarEl.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
  document.getElementById('edit-bot-title').textContent = p.name;
  document.getElementById('edit-bot-username').textContent = p.botUsername ? `@${p.botUsername}` : '';

  // Fetch current bot info from Telegram API
  try {
    const me = await tgApi('getMe');
    const infoRes = await tgApi('getMyDescription');
    const shortRes = await tgApi('getMyShortDescription');

    document.getElementById('edit-name').value = me?.result?.first_name || p.name;
    document.getElementById('edit-about').value = shortRes?.result?.short_description || '';
    document.getElementById('edit-description').value = infoRes?.result?.description || '';

    editOriginal = {
      name: document.getElementById('edit-name').value,
      about: document.getElementById('edit-about').value,
      description: document.getElementById('edit-description').value,
    };
  } catch (err) {
    console.error('Failed to fetch bot info:', err);
    document.getElementById('edit-name').value = p.name;
    document.getElementById('edit-about').value = '';
    document.getElementById('edit-description').value = p.description || '';
    editOriginal = {
      name: document.getElementById('edit-name').value,
      about: document.getElementById('edit-about').value,
      description: document.getElementById('edit-description').value,
    };
  }

  showView('edit-info');
}

async function tgApi(method, body) {
  const opts = { method: body ? 'POST' : 'GET' };
  if (body) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`https://api.telegram.org/bot${currentToken}/${method}`, opts);
  return res.json();
}

async function saveEditInfo() {
  if (!currentToken) return;

  const name = document.getElementById('edit-name').value.trim();
  const about = document.getElementById('edit-about').value.trim();
  const description = document.getElementById('edit-description').value.trim();

  if (!name) {
    tg?.showAlert('Bot name cannot be empty');
    return;
  }

  tg?.MainButton?.showProgress();
  let errors = [];

  try {
    if (name !== editOriginal.name) {
      const r = await tgApi('setMyName', { name });
      if (!r.ok) errors.push(`Name: ${r.description || 'failed'}`);
    }
    if (about !== editOriginal.about) {
      const r = await tgApi('setMyShortDescription', { short_description: about });
      if (!r.ok) errors.push(`About: ${r.description || 'failed'}`);
    }
    if (description !== editOriginal.description) {
      const r = await tgApi('setMyDescription', { description });
      if (!r.ok) errors.push(`Description: ${r.description || 'failed'}`);
    }

    tg?.MainButton?.hideProgress();

    if (errors.length > 0) {
      tg?.showAlert('Some updates failed:\n' + errors.join('\n'));
    } else {
      tg?.showAlert('Bot info updated!');
      if (name !== editOriginal.name && currentProject) {
        currentProject.name = name;
      }
      showView('detail');
    }
  } catch (err) {
    tg?.MainButton?.hideProgress();
    tg?.showAlert('Error: ' + err.message);
  }
}

// ── Token actions ──

function initTokenActions() {
  document.getElementById('token-spoiler').addEventListener('click', () => {
    const spoiler = document.getElementById('token-spoiler');
    const isRevealed = spoiler.classList.contains('js-spoiler-revealed');
    if (isRevealed) {
      spoiler.classList.remove('js-spoiler-revealed');
      spoiler.classList.add('spoiler-active');
      generateSpoilerPoints(spoiler, currentToken);
    } else {
      spoiler.classList.add('js-spoiler-revealed');
      spoiler.classList.remove('spoiler-active');
      spoiler.querySelectorAll('.point').forEach(p => p.remove());
    }
  });

  document.getElementById('btn-copy-token').addEventListener('click', () => {
    if (!currentToken) return;
    navigator.clipboard.writeText(currentToken).then(() => {
      const btn = document.getElementById('btn-copy-token');
      btn.textContent = 'Copied!';
      setTimeout(() => btn.textContent = 'Copy', 1500);
    });
  });

  document.getElementById('btn-revoke-token').addEventListener('click', () => {
    tg?.showConfirm('Are you sure you want to revoke this token? Your bot will stop working until you set a new one.', async (ok) => {
      if (!ok || !currentToken) return;
      try {
        const r = await tgApi('logOut');
        if (r.ok) {
          tg?.showAlert('Token revoked. Generate a new one via @BotFather.');
        } else {
          tg?.showAlert('Failed: ' + (r.description || 'unknown error'));
        }
      } catch (err) {
        tg?.showAlert('Error: ' + err.message);
      }
    });
  });
}

// ── Navigation ──

function showView(view) {
  currentView = view;
  document.getElementById('view-list').classList.toggle('hidden', view !== 'list');
  document.getElementById('view-detail').classList.toggle('hidden', view !== 'detail');
  document.getElementById('view-edit-info').classList.toggle('hidden', view !== 'edit-info');

  if (tg?.BackButton) {
    if (view === 'list') {
      tg.BackButton.hide();
    } else {
      tg.BackButton.show();
    }
  }

  if (tg?.MainButton) {
    if (view === 'edit-info') {
      tg.MainButton.setText('Update');
      tg.MainButton.show();
    } else {
      tg.MainButton.hide();
    }
  }
}

// ── Init ──

async function loadProjects() {
  try {
    const res = await fetch(`${API_BASE}/projects`, { headers: apiHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    projects = await res.json();
    renderAppList();
  } catch (err) {
    console.error('Failed to load projects:', err);
    document.getElementById('app-list').innerHTML =
      `<div class="tm-row-container tm-row-results-empty"><b>Failed to load apps</b><div>${esc(err.message)}</div></div>`;
  }
}

function init() {
  if (tg) {
    tg.ready();
    tg.setHeaderColor('#212a33');
    tg.setBackgroundColor('#1a2026');
    tg.setBottomBarColor('#212a33');
    tg.MainButton.setParams({ color: '#248BDA' });
    tg.disableVerticalSwipes();

    if (['android', 'ios'].includes(tg.platform)) {
      document.body.classList.add('mobile', 'platform-' + tg.platform);
      tg.requestFullscreen();
    }
  }

  if (tg?.BackButton) {
    tg.BackButton.onClick(() => {
      if (currentView === 'edit-info') {
        showView('detail');
      } else {
        showView('list');
        currentProject = null;
        currentToken = null;
      }
    });
  }

  if (tg?.MainButton) {
    tg.MainButton.onClick(() => {
      if (currentView === 'edit-info') {
        saveEditInfo();
      }
    });
  }

  const searchInput = document.getElementById('search-input');
  searchInput.addEventListener('input', () => {
    renderAppList(searchInput.value.trim().toLowerCase());
  });

  document.getElementById('search-clear').addEventListener('click', () => {
    searchInput.value = '';
    renderAppList();
  });

  initTokenActions();
  loadBalance();
  loadProjects();
}

init();
