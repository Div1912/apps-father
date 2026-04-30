'use strict';

const API_BASE = '/telegram-mini-app/api';

let authToken = localStorage.getItem('af_desktop_token');
let currentUser = null;
let projects = [];
let activeProjectId = null;
let activeProject = null;
let chatWs = null;
let wsGeneration = 0;
let isProcessing = false;
let pendingFiles = [];
let isPlanningMode = false;
let userBalance = 0;

// ── Helpers ──

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

// ── Avatar gradients (same as mini_app) ──

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

function projectAvatarHtml(project) {
  if (project.avatarUrl) {
    return `<img class="sidebar-project-avatar" src="${esc(project.avatarUrl)}" alt="">`;
  }
  const [c1, c2] = getGradient(project.name || 'A');
  return `<div class="sidebar-project-avatar" style="background:linear-gradient(135deg,${c1},${c2})">${getInitials(project.name || 'A')}</div>`;
}

function timeStr(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function apiHeaders() {
  const h = {};
  if (authToken) h['X-Desktop-Auth'] = authToken;
  // Same rationale as mini_app/app.js: attribute every request so the
  // backend can race-resolve the source on whichever endpoint fires first
  // (loadProjects / balance / etc.), not only on /web-auth.
  try {
    const sp = (typeof getDesktopStartParam === 'function')
      ? getDesktopStartParam()
      : (localStorage.getItem('af_desktop_startparam') || '');
    if (sp) h['X-Apps-Father-Start-Param'] = sp;
  } catch (_) {}
  return h;
}

function showToast(message, duration = 2500) {
  const existing = document.querySelector('.dtoast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.className = 'dtoast';
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, duration);
}

function $(id) { return document.getElementById(id); }

// ── Format content (markdown-lite) ──

function formatContent(text) {
  if (!text) return '';
  let s = esc(text);

  const codeBlocks = [];
  s = s.replace(/```([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push(code);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  const inlineCodes = [];
  s = s.replace(/`([^`]+)`/g, (_m, code) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  s = s.replace(/((?:^|\n)\|.+\|(?:\n\|.+\|)*)/g, (block) => {
    const rows = block.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return block;
    const isSep = r => /^\|[\s:?-]+(\|[\s:?-]+)*\|?$/.test(r.trim());
    const hasSep = isSep(rows[1]);
    const dataRows = hasSep ? [rows[0], ...rows.slice(2)] : rows;
    const isHeader = i => hasSep && i === 0;
    let table = '<table class="chat-table">';
    dataRows.forEach((row, i) => {
      const cells = row.split('|').slice(1);
      if (cells[cells.length - 1]?.trim() === '') cells.pop();
      const tag = isHeader(i) ? 'th' : 'td';
      table += '<tr>' + cells.map(c => `<${tag}>${c.trim()}</${tag}>`).join('') + '</tr>';
    });
    table += '</table>';
    return '\n' + table + '\n';
  });

  s = s.replace(/^### (.+)$/gm, '<h4 class="chat-h">$1</h4>');
  s = s.replace(/^## (.+)$/gm, '<h3 class="chat-h">$1</h3>');
  s = s.replace(/^# (.+)$/gm, '<h2 class="chat-h">$1</h2>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/\*(.+?)\*/g, '<i>$1</i>');
  s = s.replace(/^-{3,}$/gm, '<hr class="chat-hr">');
  s = s.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');
  s = s.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  s = s.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul class="chat-ul">$1</ul>');
  s = s.replace(/\n/g, '<br>');
  const blockEls = 'h[234]|table|ul|\/table|\/ul|pre|\/pre|hr';
  s = s.replace(new RegExp(`(<br>)+(<(?:${blockEls})[^>]*>)`, 'g'), '$2');
  s = s.replace(new RegExp(`(<\/(?:${blockEls})>)(<br>)+`, 'g'), '$1');
  s = s.replace(/<li>(.*?)<\/li><br>/g, '<li>$1</li>');
  s = s.replace(/(<br>){3,}/g, '<br><br>');

  s = s.replace(/\x00CB(\d+)\x00/g, (_m, i) => `<pre>${codeBlocks[Number(i)]}</pre>`);
  s = s.replace(/\x00IC(\d+)\x00/g, (_m, i) => `<code>${inlineCodes[Number(i)]}</code>`);

  return s;
}

function renderChecklist(items) {
  let html = '<ul class="chat-checklist">';
  for (const item of items) {
    const done = item.done ? ' done' : '';
    html += `<li class="${done}"><span class="check-icon"></span><span>${esc(item.text)}</span></li>`;
  }
  html += '</ul>';
  return html;
}

// ── Auth ──

function showLogin() {
  $('login-screen').classList.remove('hidden');
  $('desktop-layout').classList.add('hidden');
}

function showApp() {
  $('login-screen').classList.add('hidden');
  $('desktop-layout').classList.remove('hidden');
  loadProjects();
  loadBalance();
  updateUserUI();
  applyLang();
}

let botId = '';

async function fetchBotConfig() {
  try {
    const res = await fetch(`${API_BASE}/desktop-config`);
    if (res.ok) {
      const data = await res.json();
      botId = String(data.botId || '');
    }
  } catch {}
}

function getDesktopStartParam() {
  let raw = '';
  try {
    raw = new URLSearchParams(window.location.search).get('startapp') ||
          new URLSearchParams(window.location.search).get('start') || '';
  } catch (_) {}
  raw = (raw || '').trim();
  if (raw) {
    try { localStorage.setItem('af_desktop_startparam', raw); } catch (_) {}
  } else {
    try { raw = localStorage.getItem('af_desktop_startparam') || ''; } catch (_) {}
  }
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

$('btn-telegram-login').addEventListener('click', () => {
  if (!botId) { showToast('Loading bot config, please try again'); fetchBotConfig(); return; }
  Telegram.Login.auth(
    { bot_id: botId, origin: location.origin },
    (data) => {
      if (!data) return;
      const userData = data.user || data;
      const startParam = getDesktopStartParam();
      const payload = startParam ? { ...userData, startParam } : userData;
      fetch(`${API_BASE}/web-auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
        .then(r => r.json())
        .then(result => {
          if (result.token) {
            authToken = result.token;
            localStorage.setItem('af_desktop_token', authToken);
            currentUser = result.user;
            localStorage.setItem('af_desktop_user', JSON.stringify(currentUser));
            showApp();
          } else {
            showToast(result.error || 'Auth failed');
          }
        })
        .catch(() => showToast('Connection error'));
    }
  );
});

$('btn-logout').addEventListener('click', () => {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('af_desktop_token');
  localStorage.removeItem('af_desktop_user');
  closeChat();
  showLogin();
});

function updateUserUI() {
  if (!currentUser) return;
  const name = currentUser.firstName || currentUser.username || 'User';
  $('sidebar-username').textContent = name;
  const avatarEl = $('sidebar-avatar');
  if (currentUser.username) {
    avatarEl.innerHTML = `<img src="https://t.me/i/userpic/320/${currentUser.username}.svg" onerror="this.remove();this.parentNode.textContent='${esc(name[0])}'">`;
  } else {
    avatarEl.textContent = name[0];
  }
}

// ── Projects ──

async function loadProjects() {
  try {
    const res = await fetch(`${API_BASE}/projects`, { headers: apiHeaders() });
    if (!res.ok) {
      if (res.status === 401) { showLogin(); return; }
      return;
    }
    const data = await res.json();
    projects = data.projects || data;
    renderProjectList();
  } catch (err) {
    console.error('Load projects failed:', err);
  }
}

function statusLabel(status) {
  return t('status_' + status) || status;
}

function renderProjectList() {
  const container = $('sidebar-projects');
  if (!projects.length) {
    container.innerHTML = `<div class="sidebar-empty">${t('desktop_no_projects')}</div>`;
    return;
  }
  container.innerHTML = projects.map(p => {
    const active = p.id === activeProjectId ? ' active' : '';
    const isBuilding = p.status === 'building' || p.status === 'updating';
    const statusIndicator = isBuilding
      ? `<span class="loader" style="width:10px;height:10px;flex-shrink:0"></span>`
      : `<span class="tm-status-dot ${p.status}"></span>`;
    return `<div class="sidebar-project${active}" data-id="${p.id}">
      ${projectAvatarHtml(p)}
      <div class="sidebar-project-info">
        <div class="sidebar-project-name">${esc(p.name || 'Unnamed')}</div>
        <div class="sidebar-project-status${isBuilding ? ' processing' : ''}">${statusIndicator}${esc(statusLabel(p.status))}</div>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.sidebar-project').forEach(el => {
    el.addEventListener('click', () => openProject(el.dataset.id));
  });
}

function openProject(projectId) {
  activeProjectId = projectId;
  activeProject = projects.find(p => p.id === projectId) || null;
  isPlanningMode = activeProject && (!activeProject.status || activeProject.status === 'planning');

  closeAppPanel();
  renderProjectList();
  showPanel('chat');

  $('dchat-app-name').textContent = activeProject?.name || 'App';
  $('dchat-app-status').textContent = activeProject?.status || '';

  loadChatHistory(projectId);
  connectChatWS(projectId);

  if (window.innerWidth <= 768) closeSidebar();
}

// ── Balance ──

async function loadBalance() {
  try {
    const res = await fetch(`${API_BASE}/balance`, { headers: apiHeaders() });
    if (res.ok) {
      const data = await res.json();
      userBalance = data.balance;
      $('sidebar-balance').textContent = `$${Number(userBalance).toFixed(2)}`;
      $('dsettings-balance').textContent = `$${Number(userBalance).toFixed(2)}`;
    }
  } catch {}
}

// ── Panels ──

function showPanel(name) {
  $('main-empty').classList.toggle('hidden', name !== 'empty');
  $('main-chat').classList.toggle('hidden', name !== 'chat');
  $('main-settings').classList.toggle('hidden', name !== 'settings');
}

$('btn-settings').addEventListener('click', () => {
  activeProjectId = null;
  renderProjectList();
  showPanel('settings');
  updateLangChecks();
});

function updateLangChecks() {
  document.querySelectorAll('.dsettings-lang-option').forEach(row => {
    const check = row.querySelector('.lang-check');
    if (check) check.classList.toggle('hidden', row.dataset.lang !== currentLang);
  });
}

document.querySelectorAll('.dsettings-lang-option').forEach(row => {
  row.addEventListener('click', () => {
    setLang(row.dataset.lang);
    updateLangChecks();
    applyLang();
  });
});

$('dsettings-logout')?.addEventListener('click', () => {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('af_desktop_token');
  localStorage.removeItem('af_desktop_user');
  closeChat();
  showLogin();
});

// ── App Settings Panel ──

let appPanelToken = null;
let appPanelOpen = false;

function menuRowAction(label, iconClass, action) {
  return `<a class="tm-row tm-row-link" data-action="${action}"><span class="tm-icon ${iconClass}"></span><span>${esc(label)}</span></a>`;
}

function menuRow(label, iconClass, href) {
  const hrefAttr = href ? ` href="${esc(href)}" target="_blank"` : '';
  return `<a class="tm-row tm-row-link"${hrefAttr}><span class="tm-icon ${iconClass}"></span><span>${esc(label)}</span></a>`;
}

async function openAppPanel(p) {
  if (!p) return;
  const panel = $('dapp-panel');
  const btnPanel = $('btn-app-panel');

  panel.classList.remove('hidden');
  btnPanel.classList.add('active');
  appPanelOpen = true;

  // Avatar
  const avatarEl = $('dapp-avatar');
  if (p.avatarUrl) {
    avatarEl.textContent = '';
    avatarEl.style.background = `url(${p.avatarUrl}) center/cover no-repeat`;
  } else {
    const [c1, c2] = getGradient(p.name);
    avatarEl.textContent = getInitials(p.name);
    avatarEl.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
  }

  $('dapp-name').textContent = p.name;
  $('dapp-username').textContent = p.botUsername ? `@${p.botUsername}` : '';

  const version = p.currentVersion || 0;
  const cost = p.totalCostUsd ? `$${Number(p.totalCostUsd).toFixed(2)}` : '$0.00';
  $('dapp-info').innerHTML = `Version: <b>${version}</b> · Cost: <b>${cost}</b><br>ID: <b>${p.id}</b>`;

  const isLive = ['deployed', 'released'].includes(p.status);
  const baseUrl = location.origin;

  // Token + Webapp URL
  const tokenSection = $('dapp-section-token');
  tokenSection.style.display = 'none';
  appPanelToken = null;
  $('dapp-token-text').textContent = '...';
  const webappUrlRow = $('dapp-webapp-url-row');
  const webappUrl = `${baseUrl}/app/${p.id}/`;
  $('dapp-webapp-url-text').textContent = webappUrl;
  webappUrlRow.style.display = isLive ? '' : 'none';

  try {
    const res = await fetch(`${API_BASE}/token/${p.id}`, { headers: apiHeaders() });
    if (res.ok) {
      const data = await res.json();
      appPanelToken = data.token;
      $('dapp-token-text').textContent = data.token;
      tokenSection.style.display = '';
    }
  } catch {}

  // App section
  let appRows = '';
  if (isLive) {
    appRows += menuRowAction(t('detail_test_app'), 'af-icon-test', 'panel-test');
    if (p.botUsername) appRows += menuRowAction(t('detail_open_bot'), 'af-icon-open', 'panel-open-bot');
  }
  $('dapp-app-rows').innerHTML = appRows;
  $('dapp-section-app').style.display = appRows ? '' : 'none';

  // Dev section
  let devRows = menuRowAction(t('detail_update_app'), 'af-icon-update', 'panel-update');
  if (isLive) devRows += menuRowAction(t('detail_release_version'), 'af-icon-release', 'panel-release');
  devRows += menuRowAction(t('detail_versions'), 'af-icon-versions', 'panel-versions');
  devRows += menuRowAction(t('detail_suggestions'), 'af-icon-suggest', 'panel-suggestions');
  $('dapp-dev-rows').innerHTML = devRows;

  // Monetization
  const moneyRows = menuRowAction(t('detail_features'), 'af-icon-features', 'panel-features');
  $('dapp-money-rows').innerHTML = moneyRows;
  $('dapp-section-monetization').style.display = '';

  // Settings
  let settingsRows = menuRowAction(t('detail_edit_info') || 'Edit Info', 'af-icon-edit-info', 'panel-edit-info');
  if (p.botUsername) settingsRows += menuRow(`Open @${p.botUsername}`, 'af-icon-open', `https://t.me/${p.botUsername}`);
  $('dapp-settings-rows').innerHTML = settingsRows;

  // Wire up actions
  function onAction(action, fn) {
    panel.querySelector(`[data-action="${action}"]`)?.addEventListener('click', fn);
  }
  onAction('panel-test', () => window.open(`${baseUrl}/app/${p.id}/?preview=1`, '_blank'));
  onAction('panel-open-bot', () => window.open(`https://t.me/${p.botUsername}`, '_blank'));
  onAction('panel-update', () => closeAppPanel());
  onAction('panel-suggestions', () => closeAppPanel());
  onAction('panel-versions', () => openVersionsPanel(p.id));
  onAction('panel-release', () => releaseVersionPanel(p));
  onAction('panel-features', () => showToast('Features panel coming soon'));
  onAction('panel-edit-info', () => showToast('Edit Info — open in Mini App'));

  // Copy fields
  $('dapp-token-text').onclick = () => {
    if (appPanelToken) { navigator.clipboard.writeText(appPanelToken).then(() => showToast('Copied!')); }
  };
  $('dapp-webapp-url-text').onclick = () => {
    navigator.clipboard.writeText(webappUrl).then(() => showToast('Copied!'));
  };
}

function closeAppPanel() {
  $('dapp-panel').classList.add('hidden');
  $('btn-app-panel').classList.remove('active');
  appPanelOpen = false;
}

async function openVersionsPanel(projectId) {
  try {
    const res = await fetch(`${API_BASE}/versions/${projectId}`, { headers: apiHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const versions = data.versions || [];
    if (!versions.length) { showToast('No versions yet'); return; }
    const list = versions.map(v => `v${v.version}: ${v.changelog?.substring(0,60) || 'No changelog'}`).join('\n');
    showToast(`Versions:\n${list}`, 4000);
  } catch { showToast('Failed to load versions'); }
}

async function releaseVersionPanel(p) {
  try {
    const res = await fetch(`${API_BASE}/versions/${p.id}`, { headers: apiHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const versions = data.versions || [];
    if (!versions.length) { showToast('No versions to release'); return; }
    const latest = versions[0];
    if (!confirm(`Release Version #${latest.version}?`)) return;
    const r = await fetch(`${API_BASE}/versions/${p.id}/release`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: latest.version }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    showToast(`Version #${d.released} released!`);
    await loadProjects();
  } catch { showToast('Failed to release'); }
}

$('btn-app-panel').addEventListener('click', () => {
  if (appPanelOpen) {
    closeAppPanel();
  } else if (activeProject) {
    openAppPanel(activeProject);
  }
});

$('btn-close-app-panel').addEventListener('click', () => closeAppPanel());

// ── Drag-to-resize panel ──

(function initPanelResize() {
  const handle = $('dapp-resize-handle');
  const panel  = $('dapp-panel');
  if (!handle || !panel) return;

  let startX = 0;
  let startW = 0;
  let dragging = false;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startW = panel.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    // Panel is on the right; dragging left = wider, right = narrower
    const delta = startX - e.clientX;
    const newW = Math.min(Math.max(startW + delta, 220), 680);
    panel.style.width = newW + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// ── New Project ──

$('btn-new-project').addEventListener('click', showNewProjectModal);

function showNewProjectModal() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'new-project-modal';
  overlay.innerHTML = `
    <div class="modal-card">
      <h3>${t('create_new_app')}</h3>
      <input class="modal-input" id="modal-app-name" placeholder="${t('detail_name') || 'App name'}" maxlength="64">
      <textarea class="modal-input modal-textarea" id="modal-app-desc" placeholder="${t('chat_placeholder') || 'Describe your app...'}" rows="3"></textarea>
      <div class="modal-actions">
        <button class="modal-btn modal-btn-cancel" id="modal-cancel">${t('btn_cancel') || 'Cancel'}</button>
        <button class="modal-btn modal-btn-primary" id="modal-create">${t('create_new_app')}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  $('modal-cancel').addEventListener('click', () => overlay.remove());
  $('modal-create').addEventListener('click', async () => {
    const name = $('modal-app-name').value.trim();
    const desc = $('modal-app-desc').value.trim();
    if (!name) { showToast('Enter app name'); return; }

    try {
      const res = await fetch(`${API_BASE}/projects`, {
        method: 'POST',
        headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: desc }),
      });
      const data = await res.json();
      if (data.id || data.project?.id) {
        overlay.remove();
        await loadProjects();
        openProject(data.id || data.project.id);
      } else {
        showToast(data.error || 'Failed to create project');
      }
    } catch {
      showToast('Connection error');
    }
  });

  $('modal-app-name').focus();
}

// ── Sidebar toggle (mobile) ──

function openSidebar() {
  $('sidebar').classList.add('open');
  $('sidebar-overlay').classList.remove('hidden');
}

function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('sidebar-overlay').classList.add('hidden');
}

$('btn-mobile-menu')?.addEventListener('click', openSidebar);
$('sidebar-overlay').addEventListener('click', closeSidebar);
$('btn-sidebar-toggle')?.addEventListener('click', closeSidebar);

// ── WebSocket ──

function connectChatWS(projectId) {
  const gen = ++wsGeneration;

  if (chatWs) {
    try { chatWs.onclose = null; chatWs.close(); } catch {}
    chatWs = null;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}/telegram-mini-app/ws`;
  chatWs = new WebSocket(wsUrl);

  chatWs.onopen = () => {
    if (gen !== wsGeneration) return;
    chatWs.send(JSON.stringify({ type: 'auth', initData: '', desktopToken: authToken }));
  };

  chatWs.onmessage = (event) => {
    if (gen !== wsGeneration) return;
    try {
      const data = JSON.parse(event.data);
      handleWSMessage(data);
    } catch {}
  };

  chatWs.onclose = () => {
    if (gen !== wsGeneration) return;
    chatWs = null;
    setTimeout(() => {
      if (gen === wsGeneration && activeProjectId === projectId) {
        connectChatWS(projectId);
      }
    }, 3000);
  };
}

function closeChat() {
  wsGeneration++;
  if (chatWs) {
    try { chatWs.onclose = null; chatWs.close(); } catch {}
    chatWs = null;
  }
  activeProjectId = null;
  activeProject = null;
}

function scrollToBottom(instant) {
  const el = $('dchat-messages');
  if (!el) return;
  el.scrollTo({ top: el.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
}

function setTyping(show) {
  $('dchat-typing')?.classList.toggle('hidden', !show);
  if (show) scrollToBottom();
}

function setInputDisabled(disabled) {
  const input = $('dchat-input');
  const btn = $('dbtn-send');
  if (input) input.disabled = disabled;
  if (btn) btn.disabled = disabled;
}

// ── WS Message Handler ──

// Filled SVG icons — fill="currentColor" so they inherit step state color
// and are solid/visible at small sizes in all WebViews.
function agentStepIcon(kind) {
  const F = (p) => `<svg class="step-svg-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">${p}</svg>`;
  const MAP = {
    thinking:   F('<path fill="currentColor" d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 2a5 5 0 110 10A5 5 0 018 3zm.75 2.5H7.25V9l3.5 2.1.75-1.25-2.75-1.65V5.5z"/>'),
    reading:    F('<path fill="currentColor" d="M8 3C4.5 3 1.5 8 1.5 8S4.5 13 8 13s6.5-5 6.5-5S11.5 3 8 3zm0 2a3 3 0 110 6A3 3 0 018 5zm0 1.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z"/>'),
    writing:    F('<path fill="currentColor" d="M3 1h7.5L14 4.5V15H3V1zm1 1v12h9V5.5L9.5 2H4zm1.5 3.5h5v1h-5V5.5zm0 2h5v1h-5v-1zm0 2h3.5v1H5.5v-1z"/>'),
    editing:    F('<path fill="currentColor" d="M12 1.5l2.5 2.5-9 9L3 14l.5-2.5 9-10zm0 1.5L5 10.6l-.3 1.7 1.7-.3L13.5 5 12 3zM1 14.5h14v1H1v-1z"/>'),
    searching:  F('<path fill="currentColor" d="M7 2a5 5 0 100 10A5 5 0 007 2zm0 1.5a3.5 3.5 0 110 7 3.5 3.5 0 010-7zm4.47 5.53l1.06 1.06L15 12.56 13.94 13.6l-2.47-2.47 1.06-1.06-.06.06z"/>'),
    shell:      F('<path fill="currentColor" d="M1 2.5h14v11H1v-11zm1.5 2v7.5h11V4.5h-11zM4 6l3.5 2L4 10V8.5l2-.5-2-.5V6zm4 4h4v1H8v-1z"/>'),
    fetch:      F('<path fill="currentColor" d="M10.5 1.5a4 4 0 012.83 6.83l-1.06-1.06a2.5 2.5 0 10-3.54-3.54L7.67 2.67A4 4 0 0110.5 1.5zM5.5 14.5a4 4 0 01-2.83-6.83l1.06 1.06a2.5 2.5 0 003.54 3.54l1.06 1.06A4 4 0 015.5 14.5zm5.56-3.5L9.5 9.44l1.06-1.06 1.56 1.56-1.06 1.06zM5.44 6.56L4.38 5.5 5.44 4.44 6.5 5.5 5.44 6.56z"/>'),
    db:         F('<path fill="currentColor" d="M8 2C5.24 2 3 3.12 3 4.5v7C3 12.88 5.24 14 8 14s5-1.12 5-2.5v-7C13 3.12 10.76 2 8 2zm0 1.5c2.21 0 3.5.75 3.5 1 0 .25-1.29 1-3.5 1S4.5 4.75 4.5 4.5c0-.25 1.29-1 3.5-1zM4.5 6.4c.9.4 2.1.6 3.5.6s2.6-.2 3.5-.6v1.1c0 .25-1.29 1-3.5 1s-3.5-.75-3.5-1V6.4zm0 3c.9.4 2.1.6 3.5.6s2.6-.2 3.5-.6v1.1c0 .25-1.29 1-3.5 1s-3.5-.75-3.5-1V9.4z"/>'),
    telegram:   F('<path fill="currentColor" d="M14.5 2L1 7.5l5 1.5 1.5 5 2.5-3.5L14 13 14.5 2zm-2 2L6.5 9l-.8-2.8L12.5 4z"/>'),
    deploying:  F('<path fill="currentColor" d="M8 1l5.5 5.5H10V14H6V6.5H2.5L8 1zm-7 13.5h14V16H1v-1.5z"/>'),
    configuring:F('<path fill="currentColor" d="M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zm0 1.5a1 1 0 110 2 1 1 0 010-2z"/><path fill="currentColor" d="M8.75 0h-1.5l-.5 2a5.5 5.5 0 00-1.7.7L3 1.75l-1.05 1.05 1.2 2A5.5 5.5 0 002.5 6.5H.5v1.5l2 .3a5.5 5.5 0 00.65 1.7L2 12.25l1.05 1.05 2-1.2a5.5 5.5 0 001.7.65L7.25 15h1.5l.3-2.25a5.5 5.5 0 001.7-.65l2 1.2 1.05-1.05-1.25-2a5.5 5.5 0 00.65-1.7L15.5 8V6.5h-2a5.5 5.5 0 00-.65-1.7l1.2-2L13 1.75l-2 1.25a5.5 5.5 0 00-1.7-.7L8.75 0z"/>'),
    skill:      F('<polygon fill="currentColor" points="10,1 5.5,9 9.5,9 6,15 13.5,6.5 9.5,6.5"/>'),
    ask:        F('<path fill="currentColor" d="M1 1h14v10.5H9.5l-3.5 3.5v-3.5H1V1zm6 2.5v3h2v-3H7zm0 4v1.5h2V7.5H7z"/>'),
    done:       F('<path fill="currentColor" d="M6.5 11.5l-4-4L4 6l2.5 2.5 6-6 1.5 1.5z"/>'),
  };
  return MAP[kind] || F('<circle cx="8" cy="8" r="3.5" fill="currentColor"/>');
}

const AGENT_DONE_SVG = '<svg class="step-svg-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M6.5 11.5l-4-4L4 6l2.5 2.5 6-6 1.5 1.5z"/></svg>';

function handleWSMessage(data) {
  if (data.type === 'auth_ok') {
    chatWs.send(JSON.stringify({ type: 'subscribe', projectId: activeProjectId }));
    return;
  }

  if (data.type === 'stream_start') {
    setTyping(false);
    const inner = $('dchat-messages-inner');
    const el = document.createElement('div');
    el.id = `msg-${data.messageId}`;
    el.className = 'chat-bubble chat-bubble--assistant';
    el.innerHTML = `<div class="chat-bubble-content"><span class="stream-cursor"></span></div>`;
    inner.appendChild(el);
    scrollToBottom();
    return;
  }

  if (data.type === 'stream_chunk') {
    const el = $(`msg-${data.messageId}`);
    if (el) {
      el.querySelector('.chat-bubble-content').innerHTML = formatContent(data.text) + '<span class="stream-cursor"></span>';
    }
    return;
  }

  if (data.type === 'plan_stream_start') {
    setTyping(false);
    setInputDisabled(true);
    document.querySelectorAll('.chat-bubble--plan').forEach(el => el.remove());
    const inner = $('dchat-messages-inner');
    if (!inner) return;
    const el = document.createElement('div');
    el.id = `msg-${data.messageId}`;
    el.className = 'chat-bubble chat-bubble--assistant chat-bubble--plan chat-bubble--plan-streaming';
    el.innerHTML = `<div class="chat-plan-content"><span class="stream-cursor"></span></div>`;
    inner.appendChild(el);
    scrollToBottom();
    return;
  }

  if (data.type === 'plan_stream_chunk') {
    const el = $(`msg-${data.messageId}`);
    if (el) {
      const content = el.querySelector('.chat-plan-content');
      if (content) content.innerHTML = formatContent(data.text) + '<span class="stream-cursor"></span>';
    }
    return;
  }

  if (data.type === 'plan_stream_end') {
    const el = $(`msg-${data.messageId}`);
    if (!el || !data.message) return;
    const msg = data.message;
    if (msg.type === 'error') {
      el.className = 'chat-bubble chat-bubble--error';
      el.innerHTML = `<div class="chat-bubble-content">${esc(msg.content)}</div>${renderRefundBlock(msg.metadata)}<div class="chat-bubble-time">${timeStr(msg.timestamp)}</div>`;
      bindRefundRetry(el, msg.metadata);
      el.id = `msg-${msg.id}`;
      setInputDisabled(false);
      scrollToBottom();
      return;
    }
    el.className = 'chat-bubble chat-bubble--assistant chat-bubble--plan';
    let html = `<div class="chat-plan-content">${formatContent(msg.content)}</div>`;
    if (typeof msg.metadata?.costUsd === 'number') {
      html += `<div class="chat-progress-cost">Cost: $${msg.metadata.costUsd.toFixed(4)}${typeof msg.metadata?.balance === 'number' ? ` · Balance: $${msg.metadata.balance.toFixed(2)}` : ''}</div>`;
    }
    html += `<div class="chat-plan-actions">
      <button class="chat-plan-btn chat-plan-btn--build" onclick="approvePlan()">${t('chat_lets_build') || "Let's build"}</button>
      <button class="chat-plan-btn chat-plan-btn--edit" onclick="startEditPlan()">${t('chat_edit') || 'Edit'}</button>
    </div>`;
    el.innerHTML = html;
    el.id = `msg-${msg.id}`;
    setInputDisabled(false);
    scrollToBottom();
    if (typeof loadBalance === 'function') loadBalance();
    return;
  }

  if (data.type === 'stream_end') {
    const el = $(`msg-${data.messageId}`);
    if (el && data.message) {
      const msg = data.message;
      const cls = msg.type === 'error' ? 'chat-bubble--error' : 'chat-bubble--assistant';
      el.className = `chat-bubble ${cls}`;
      let html = `<div class="chat-bubble-content">${msg.type === 'error' ? esc(msg.content) : formatContent(msg.content)}</div>`;
      if (typeof msg.costUsd === 'number' && msg.costUsd > 0) {
        html += `<div class="chat-progress-cost">Cost: $${msg.costUsd.toFixed(4)}${typeof msg.balance === 'number' ? ` · Balance: $${msg.balance.toFixed(2)}` : ''}</div>`;
      }
      html += `<div class="chat-bubble-time">${timeStr(msg.timestamp)}</div>`;
      el.innerHTML = html;
      el.id = `msg-${msg.id}`;
      addCollapsible(el);
      scrollToBottom();
    }
    return;
  }

  // ── Agent narration events (collapsible "thinking" blocks) ───────────────
  if (data.type === 'agent_narration_start') {
    const el = $(`msg-${data.messageId}`);
    if (!el) return;
    if (!el.classList.contains('agent-process')) {
      el.classList.add('agent-process');
      el.innerHTML = '';
    }
    el.querySelectorAll('.agent-think-block.running').forEach(b => {
      b.classList.remove('running');
      b.classList.add('done');
      const ic = b.querySelector('.agent-think-icon');
      if (ic) ic.innerHTML = AGENT_DONE_SVG;
      const hdr = b.querySelector('.agent-think-header');
      if (hdr && !hdr._clickBound) { hdr._clickBound = true; hdr.addEventListener('click', () => b.classList.toggle('open')); }
    });
    const existingFooter = el.querySelector('.agent-footer');
    if (existingFooter) existingFooter.remove();
    const block = document.createElement('div');
    block.id = `narr-${data.stepId}`;
    block.className = 'agent-think-block running';
    block.innerHTML = `
      <div class="agent-think-header">
        <span class="agent-think-icon"><span class="step-spinner"></span></span>
        <span class="agent-think-preview">Thinking…</span>
        <span class="agent-think-toggle">›</span>
      </div>
      <div class="agent-think-body"></div>`;
    el.appendChild(block);
    scrollToBottom();
    return;
  }

  if (data.type === 'agent_narration_chunk') {
    const block = $(`narr-${data.stepId}`);
    if (!block) return;
    const body = block.querySelector('.agent-think-body');
    const preview = block.querySelector('.agent-think-preview');
    if (body) body.innerHTML = formatContent(data.text || '') + '<span class="stream-cursor"></span>';
    if (preview) {
      const plain = (data.text || '').replace(/[#*`_~\n]/g, ' ').trim();
      preview.textContent = plain.length > 72 ? plain.slice(0, 72) + '…' : (plain || 'Thinking…');
    }
    scrollToBottom();
    return;
  }

  if (data.type === 'agent_narration_end') {
    const block = $(`narr-${data.stepId}`);
    if (!block) return;
    const body = block.querySelector('.agent-think-body');
    if (body) { const cur = body.querySelector('.stream-cursor'); if (cur) cur.remove(); }
    const iconEl = block.querySelector('.agent-think-icon');
    if (iconEl) iconEl.innerHTML = AGENT_DONE_SVG;
    block.classList.remove('running');
    block.classList.add('done');
    const header = block.querySelector('.agent-think-header');
    if (header && !header._clickBound) {
      header._clickBound = true;
      header.addEventListener('click', () => block.classList.toggle('open'));
    }
    return;
  }

  // ── Agent step-card events ────────────────────────────────────────────────
  if (data.type === 'agent_step_start') {
    const el = $(`msg-${data.messageId}`);
    if (!el) return;
    if (!el.classList.contains('agent-process')) {
      el.classList.add('agent-process');
      el.innerHTML = '';
    }
    const existingFooter = el.querySelector('.agent-footer');
    if (existingFooter) existingFooter.remove();
    const targetHtml = data.target?.file || data.target?.url || data.target?.key
      ? `<div class="agent-step-target">${esc(data.target.file || data.target.url || data.target.key || '')}</div>` : '';
    const step = document.createElement('div');
    step.id = `step-${data.stepId}`;
    step.className = 'agent-step agent-step--running';
    step.innerHTML = `
      <div class="agent-step-icon agent-step-icon--kind">${agentStepIcon(data.kind)}</div>
      <div class="agent-step-body">
        <div class="agent-step-title">${esc(data.title || data.toolName || data.kind || '')}</div>
        ${targetHtml}
      </div>`;
    el.appendChild(step);
    scrollToBottom();
    return;
  }

  if (data.type === 'agent_step_end') {
    const step = $(`step-${data.stepId}`);
    if (!step) return;
    const ok = data.status !== 'error';
    step.classList.remove('agent-step--running');
    step.classList.add(ok ? 'agent-step--done' : 'agent-step--error');
    if (!ok) {
      const iconEl = step.querySelector('.agent-step-icon');
      if (iconEl) iconEl.innerHTML = '<svg class="step-svg-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>';
    }
    const body = step.querySelector('.agent-step-body');
    if (body && data.meta) {
      const m = data.meta;
      const bits = [];
      if (typeof m.lines === 'number') bits.push(`<span class="meta-neutral">${m.lines} lines</span>`);
      if (typeof m.added === 'number' && m.added > 0) bits.push(`<span class="meta-added">+${m.added}</span>`);
      if (typeof m.removed === 'number' && m.removed > 0) bits.push(`<span class="meta-removed">-${m.removed}</span>`);
      if (typeof m.bytes === 'number') bits.push(`<span class="meta-neutral">${(m.bytes/1024).toFixed(1)}KB</span>`);
      if (m.error) bits.push(`<span class="meta-removed">${esc(m.error)}</span>`);
      if (bits.length) {
        let meta = body.querySelector('.agent-step-meta');
        if (!meta) {
          meta = document.createElement('div');
          meta.className = 'agent-step-meta';
          body.appendChild(meta);
        }
        meta.innerHTML = bits.join('');
      }
    }
    return;
  }

  if (data.type === 'message') {
    const msg = data.message;
    if (msg.type === 'answer') return;
    if (msg.type === 'progress') {
      hidePlanActions();
      renderProgressBubble(msg);
    } else {
      setTyping(false);
      appendMessage(msg);
    }
    scrollToBottom();
    return;
  }

  if (data.type === 'progress') {
    updateProgressBubble(data);
    return;
  }

  if (data.type === 'question') {
    setTyping(false);
    appendMessage({
      id: data.messageId,
      role: 'assistant',
      type: 'question',
      content: data.question,
      metadata: { options: data.options || [] },
      timestamp: Date.now(),
    });
    scrollToBottom();
    return;
  }

  if (data.type === 'remove_messages') {
    if (data.messageIds && Array.isArray(data.messageIds)) {
      for (const id of data.messageIds) {
        const el = $(`msg-${id}`);
        if (el) {
          el.style.transition = 'opacity 0.3s, transform 0.3s';
          el.style.opacity = '0';
          el.style.transform = 'scale(0.95)';
          setTimeout(() => el.remove(), 300);
        }
      }
    }
    return;
  }

  if (data.type === 'finalizing_done') {
    isProcessing = false;
    setInputDisabled(false);
    return;
  }

  if (data.type === 'status_change') {
    if (activeProject) {
      activeProject.status = data.status;
      $('dchat-app-status').textContent = data.status;
      if (data.status === 'deployed' || data.status === 'released') {
        isPlanningMode = false;
      }
    }
    return;
  }

  if (data.type === 'status') {
    if (data.status === 'done') {
      setTyping(false);
      isProcessing = false;
      setInputDisabled(false);
      if (isPlanningMode) isPlanningMode = false;
      const el = $(`msg-${data.messageId}`);
      if (el) {
        el.className = 'chat-bubble chat-bubble--result';
        let html = `<div class="chat-result-header">${t('chat_update_completed') || 'Update Completed'}</div>`;
        html += `<div class="chat-bubble-content">${formatContent(data.summary || '')}</div>`;
        if (data.changelogUrl) {
          html += `<div class="changelog-card" onclick="window.open('${data.changelogUrl}','_blank')">
            <div class="changelog-card-text">
              <div class="changelog-card-title">${t('version_change_log') || 'Changelog'}</div>
              <div class="changelog-card-desc">Telegraph</div>
            </div>
            <div class="changelog-card-arrow">›</div>
          </div>`;
        }
        html += desktopResultActionsHtml(activeProjectId);
        if (typeof data.costUsd === 'number') {
          html += `<div class="chat-progress-cost">Cost: $${data.costUsd.toFixed(4)}${typeof data.balance === 'number' ? ` · Balance: $${data.balance.toFixed(2)}` : ''}</div>`;
        }
        el.innerHTML = html;
        scrollToBottom();
      }
      loadBalance();
    }
    return;
  }
}

/**
 * Desktop result-card actions. Mirrors mini_app/app.js#resultActionsHtml:
 * Text Bot projects can't be opened as a web preview (no Mini App URL),
 * so we drop the "Run & Test" button and offer "Open Bot" instead when a
 * bot is linked. Other kinds keep the Test button.
 */
function desktopResultActionsHtml(projectId) {
  const proj = (projects || []).find(p => p.id === projectId)
    || (activeProject && activeProject.id === projectId ? activeProject : null);
  const isTextBot = proj?.preferences?.kind === 'textBot';
  if (isTextBot) {
    if (proj?.botUsername) {
      const botUrl = `https://t.me/${proj.botUsername}`;
      return `<div class="result-actions">
        <button class="result-action-btn result-action-test" onclick="window.open('${botUrl}','_blank')">${t('chat_open_bot') || 'Open Bot'}</button>
      </div>`;
    }
    return '';
  }
  return `<div class="result-actions">
    <button class="result-action-btn result-action-test" onclick="window.open('/app/${projectId}/','_blank')">▶ ${t('chat_run_test') || 'Test'}</button>
  </div>`;
}

// ── Chat History ──

async function loadChatHistory(projectId) {
  const inner = $('dchat-messages-inner');
  inner.innerHTML = '<div style="padding:24px;color:rgba(255,255,255,0.3);text-align:center">Loading...</div>';

  try {
    const res = await fetch(`${API_BASE}/chat/${projectId}`, { headers: apiHeaders() });
    if (!res.ok) { inner.innerHTML = ''; return; }
    const data = await res.json();
    inner.innerHTML = '';

    for (const msg of data.messages) {
      if (msg.type === 'question' || msg.type === 'answer') continue;
      if (msg.content === 'preparing_next_update') continue;
      if (msg.type === 'progress' && msg.percent === 100) msg.type = 'result';
      appendMessage(msg, false);
    }

    const hasActiveProgress = data.messages.some(m => m.type === 'progress' && (m.percent || 0) < 100);
    if (hasActiveProgress) {
      isProcessing = true;
      setInputDisabled(true);
    }

    if (data.finalizing) {
      isProcessing = true;
      setInputDisabled(true);
    }

    if (data.messages.some(m => m.type === 'result')) {
      isPlanningMode = false;
    }

    scrollToBottom(true);
  } catch (err) {
    console.error('Failed to load chat history:', err);
    inner.innerHTML = '';
  }
}

// ── Refund + retry block under error bubbles ──
// Mirrors the mobile mini_app/app.js implementation. Server stamps
// `metadata.refunded`, `metadata.creditsRefunded`, and `metadata.retry`
// on error chat messages when the agent failed and credits were given
// back to the user.
function renderRefundBlock(metadata) {
  if (!metadata?.refunded) return '';
  const credits = Number(metadata.creditsRefunded || 0);
  const retryLabel = (typeof t === 'function' && t('btn_try_again')) || 'Try again';
  const refundSuffix = (typeof t === 'function' && t('error_credits_refunded_suffix')) || 'refunded';
  // Inline coin SVG — kept self-contained here so desktop.js doesn't need
  // to depend on app.js' coinSvg helper.
  const coin = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="9" viewBox="0 0 211.551 144.439" fill="#22c55e" style="vertical-align:middle;flex-shrink:0" aria-hidden="true"><path d="M129.743,95.01c-15.97-.027-35.976,5.02-55.714,15.292-19.706,10.273-35.326,23.73-44.495,36.873-9.174,13.1-11.654,25.3-7.141,34,4.517,8.658,15.938,13.637,31.948,13.637,16.01.045,36.017-5.024,55.709-15.252,19.738-10.273,35.348-23.775,44.5-36.873,9.2-13.1,11.618-25.3,7.132-34-4.531-8.658-15.925-13.677-31.939-13.677Zm41.225,31.531a60.545,60.545,0,0,1-9.779,20.769C151.051,161.8,134.5,175.93,113.774,186.7c-20.725,10.811-41.763,16.239-59.437,16.239a60.477,60.477,0,0,1-22.6-3.9l4.75,9.151c4.522,8.7,15.911,13.682,31.93,13.682s36.021-5.024,55.714-15.3c19.738-10.228,35.348-23.73,44.5-36.873,9.151-13.1,11.663-25.3,7.132-33.958Zm12.919,7.536c5.024,11.977.987,26.556-8.613,40.238-8.478,12.157-21.442,23.954-37.5,33.823a144.6,144.6,0,0,0,15.476.807c22.2,0,42.3-4.755,56.477-12.157,14.22-7.4,22.025-17.091,22.025-26.87s-7.805-19.468-22.025-26.87a103.163,103.163,0,0,0-25.838-8.972Zm47.864,55.983a61.176,61.176,0,0,1-18.257,13.906c-15.7,8.164-36.874,13.054-60.245,13.054a155.816,155.816,0,0,1-27.229-2.333A152.678,152.678,0,0,1,95.113,226.4c.538.314,1.077.583,1.66.9,14.175,7.4,34.272,12.157,56.477,12.157s42.3-4.755,56.477-12.157c14.22-7.4,22.025-17.091,22.025-26.87Z" transform="translate(-20.199 -95.01)"/></svg>';
  return `
    <div class="error-refund-block" data-refund-block>
      <div class="refund-line">
        <span class="refund-icon" aria-hidden="true">${coin}</span>
        <span class="refund-amount">+${credits}</span>
        <span class="refund-suffix">${esc(refundSuffix)}</span>
      </div>
      <button type="button" class="btn-retry" data-refund-retry>
        <svg class="btn-retry-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
        <span>${esc(retryLabel)}</span>
      </button>
    </div>
  `;
}

function bindRefundRetry(el, metadata) {
  if (!metadata?.refunded) return;
  const retry = metadata.retry;
  if (!retry || !retry.kind) return;
  const btn = el.querySelector('[data-refund-retry]');
  if (!btn) return;
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      if (retry.kind === 'build' && typeof window.approvePlan === 'function') {
        await window.approvePlan();
      } else if (retry.kind === 'update' && retry.text) {
        await refireUpdate(retry.text);
      }
      el.style.transition = 'opacity 0.2s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 200);
    } catch (err) {
      console.error('[refund-retry] failed:', err);
      btn.disabled = false;
    }
  });
}

async function refireUpdate(text) {
  if (!activeProjectId || !text) return;
  setInputDisabled(true);
  try {
    const res = await fetch(`${API_BASE}/chat/${activeProjectId}/send`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, type: 'update' }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[refund-retry] update re-fire failed', err);
    }
  } catch (err) {
    console.error('[refund-retry] update re-fire error:', err);
  }
}

// ── Append message ──

function appendMessage(msg, animate = true) {
  const inner = $('dchat-messages-inner');
  const el = document.createElement('div');
  el.id = `msg-${msg.id}`;

  if (msg.role === 'user') {
    el.className = 'chat-bubble chat-bubble--user';
    let html = '';
    if (msg.attachments && msg.attachments.length > 0) {
      html += '<div class="chat-bubble-attachments">';
      for (const a of msg.attachments) {
        html += `<span class="chat-bubble-attach-item">📎 ${esc(a.name || 'file')}</span>`;
      }
      html += '</div>';
    }
    html += `<div class="chat-bubble-content">${esc(msg.content)}</div>`;
    el.innerHTML = html;
  } else if (msg.type === 'balance_error') {
    el.className = 'chat-bubble chat-bubble--insufficient-funds';
    const bal = Number(msg.metadata?.balance ?? 0);
    const minBal = 5;
    const note = (t('chat_min_balance_note') || 'You can start when your balance is at least ${min}')
      .replace('${min}', `$${minBal}`);
    el.innerHTML = `
      <div class="ifc-header">
        <div class="ifc-icon">⚠️</div>
        <div class="ifc-headtext">
          <div class="ifc-title">${t('chat_insufficient_funds_title') || 'Insufficient Funds'}</div>
          <div class="ifc-sub">${t('chat_insufficient_funds_sub') || 'Top up your balance to start building'}</div>
        </div>
      </div>
      <div class="ifc-stats">
        <div class="ifc-stat">
          <div class="ifc-stat-label">${t('chat_estimated_price') || t('chat_estimated_cost') || 'Estimated price'}</div>
          <div class="ifc-stat-value">~$1–$5</div>
        </div>
        <div class="ifc-stat">
          <div class="ifc-stat-label">${t('chat_your_balance') || 'Your balance'}</div>
          <div class="ifc-stat-value low">$${Number(bal).toFixed(2)}</div>
        </div>
      </div>
      <div class="ifc-note">
        <span class="ifc-note-icon">ℹ️</span>
        <span>${note}</span>
      </div>`;
    if (isProcessing) {
      isProcessing = false;
      setInputDisabled(false);
      setTyping(false);
    }
  } else if (msg.content === 'preparing_next_update' || msg.metadata?.preparing) {
    return;
  } else if (msg.type === 'error') {
    el.className = 'chat-bubble chat-bubble--error';
    el.innerHTML = `<div class="chat-bubble-content">${esc(msg.content)}</div>${renderRefundBlock(msg.metadata)}`;
    bindRefundRetry(el, msg.metadata);
    if (isProcessing) {
      isProcessing = false;
      setInputDisabled(false);
      setTyping(false);
    }
  } else if (msg.type === 'question') {
    el.className = 'chat-bubble chat-bubble--question';
    let html = `<div class="question-card">`;
    html += `<div class="question-card-icon">❓</div>`;
    html += `<div class="question-card-title">${t('chat_question_title') || 'Agent needs your input'}</div>`;
    html += `<div class="question-card-text">${formatContent(msg.content)}</div>`;
    const options = msg.metadata?.options || [];
    if (options.length > 0) {
      html += '<div class="question-card-options">';
      for (const opt of options) {
        html += `<button class="question-opt-btn" data-answer="${esc(opt)}">${esc(opt)}</button>`;
      }
      html += '</div>';
    }
    html += `<div class="question-card-divider"></div>`;
    html += `<div class="question-card-custom">`;
    html += `<input type="text" class="question-custom-input" placeholder="Or type your own answer..." />`;
    html += `<button class="question-custom-send" disabled>Send</button>`;
    html += `</div></div>`;
    el.innerHTML = html;

    const card = el.querySelector('.question-card');
    const customInput = card.querySelector('.question-custom-input');
    const customSend = card.querySelector('.question-custom-send');

    const lockQuestion = () => {
      card.classList.add('answered');
      card.querySelectorAll('.question-opt-btn').forEach(b => { b.disabled = true; });
      customInput.disabled = true;
      customSend.disabled = true;
    };

    card.querySelectorAll('.question-opt-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.add('selected');
        lockQuestion();
        sendAnswer(btn.dataset.answer);
      });
    });

    customInput.addEventListener('input', () => { customSend.disabled = !customInput.value.trim(); });
    customInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && customInput.value.trim()) { lockQuestion(); sendAnswer(customInput.value.trim()); }
    });
    customSend.addEventListener('click', () => {
      if (customInput.value.trim()) { lockQuestion(); sendAnswer(customInput.value.trim()); }
    });
  } else if (msg.type === 'result') {
    el.className = 'chat-bubble chat-bubble--result';
    let html = `<div class="chat-result-header">${t('chat_update_completed') || 'Update Completed'}</div>`;
    html += `<div class="chat-bubble-content">${formatContent(msg.content)}</div>`;
    const changelogUrl = msg.metadata?.changelogUrl;
    if (changelogUrl) {
      html += `<div class="changelog-card" onclick="window.open('${changelogUrl}','_blank')">
        <div class="changelog-card-text">
          <div class="changelog-card-title">${t('version_change_log') || 'Changelog'}</div>
          <div class="changelog-card-desc">Telegraph</div>
        </div>
        <div class="changelog-card-arrow">›</div>
      </div>`;
    }
    html += desktopResultActionsHtml(msg.metadata?.projectId || activeProjectId);
    if (typeof msg.costUsd === 'number') {
      html += `<div class="chat-progress-cost">Cost: $${msg.costUsd.toFixed(4)}${typeof msg.balance === 'number' ? ` · Balance: $${msg.balance.toFixed(2)}` : ''}</div>`;
    }
    html += `<div class="chat-bubble-time">${timeStr(msg.timestamp)}</div>`;
    el.innerHTML = html;
  } else if (msg.type === 'plan') {
    el.className = 'chat-bubble chat-bubble--assistant chat-bubble--plan';
    let html = `<div class="chat-plan-content">${formatContent(msg.content)}</div>`;
    if (typeof msg.metadata?.costUsd === 'number') {
      html += `<div class="chat-progress-cost">Cost: $${msg.metadata.costUsd.toFixed(4)}${typeof msg.metadata?.balance === 'number' ? ` · Balance: $${msg.metadata.balance.toFixed(2)}` : ''}</div>`;
    }
    html += `<div class="chat-plan-actions">
      <button class="chat-plan-btn chat-plan-btn--build" onclick="approvePlan()">${t('chat_lets_build') || "Let's build"}</button>
      <button class="chat-plan-btn chat-plan-btn--edit" onclick="startEditPlan()">${t('chat_edit') || 'Edit'}</button>
    </div>`;
    el.innerHTML = html;
  } else if (msg.type === 'progress') {
    renderProgressBubble(msg);
    return;
  } else {
    const cls = msg.role === 'system' ? 'chat-bubble--system' : 'chat-bubble--assistant';
    el.className = `chat-bubble ${cls}`;
    let html = `<div class="chat-bubble-content">${formatContent(msg.content)}</div>`;
    if (typeof msg.costUsd === 'number' && msg.costUsd > 0) {
      html += `<div class="chat-progress-cost">Cost: $${msg.costUsd.toFixed(4)}${typeof msg.balance === 'number' ? ` · Balance: $${msg.balance.toFixed(2)}` : ''}</div>`;
    }
    html += `<div class="chat-bubble-time">${timeStr(msg.timestamp)}</div>`;
    el.innerHTML = html;
  }

  if (!animate) el.style.animation = 'none';
  inner.appendChild(el);
  addCollapsible(el);
}

function addCollapsible(_el) {
  // Desktop: messages are always fully expanded
}

// ── Progress ──

function renderProgressBubble(msg) {
  const inner = $('dchat-messages-inner');
  let el = $(`msg-${msg.id}`);
  let isNew = false;
  if (!el) {
    isNew = true;
    el = document.createElement('div');
    el.id = `msg-${msg.id}`;
    inner.appendChild(el);
  }
  el.className = 'chat-bubble chat-bubble--progress';

  const pct = msg.percent || 0;
  let html = `<div class="chat-progress-text"><span class="loader"></span> Working... <b>${pct}%</b></div>`;
  html += `<div class="chat-progress-bar"><div class="chat-progress-fill" style="width:${pct}%"></div></div>`;

  if (msg.checklist && msg.checklist.length > 0) html += renderChecklist(msg.checklist);
  if (msg.content && msg.content !== 'Starting...') html += `<div class="chat-progress-status">${esc(msg.content)}</div>`;
  if (typeof msg.costUsd === 'number' && msg.costUsd > 0) {
    html += `<div class="chat-progress-cost">Cost: $${msg.costUsd.toFixed(4)}${typeof msg.balance === 'number' ? ` · Balance: $${msg.balance.toFixed(2)}` : ''}</div>`;
  }
  html += `<button class="chat-abort-btn" onclick="abortProcess()">Stop Update</button>`;

  el.innerHTML = html;
  isProcessing = true;
  setInputDisabled(true);
  setTyping(false);
  if (isNew) scrollToBottom();
}

function updateProgressBubble(data) {
  const el = $(`msg-${data.messageId}`);
  if (!el) return;

  const pct = data.percent || 0;

  // Agent-process mode: only update cost/abort footer (no percent, no checklist).
  if (el.classList.contains('agent-process')) {
    let footer = el.querySelector('.agent-footer');
    if (!footer) {
      footer = document.createElement('div');
      footer.className = 'agent-footer';
      el.appendChild(footer);
    }
    let html = '';
    if (typeof data.costUsd === 'number' && data.costUsd > 0) {
      html += `<div class="chat-progress-cost">Cost: $${data.costUsd.toFixed(4)}${typeof data.balance === 'number' ? ` · Balance: $${data.balance.toFixed(2)}` : ''}</div>`;
    }
    html += `<button class="chat-abort-btn" onclick="abortProcess()">Stop Update</button>`;
    footer.innerHTML = html;
    return;
  }

  let html = `<div class="chat-progress-text"><span class="loader"></span> Working... <b>${pct}%</b></div>`;
  html += `<div class="chat-progress-bar"><div class="chat-progress-fill" style="width:${pct}%"></div></div>`;
  if (data.checklist && data.checklist.length > 0) html += renderChecklist(data.checklist);
  if (data.message) html += `<div class="chat-progress-status">${esc(data.message)}</div>`;
  if (typeof data.costUsd === 'number' && data.costUsd > 0) {
    html += `<div class="chat-progress-cost">Cost: $${data.costUsd.toFixed(4)}${typeof data.balance === 'number' ? ` · Balance: $${data.balance.toFixed(2)}` : ''}</div>`;
  }
  html += `<button class="chat-abort-btn" onclick="abortProcess()">Stop Update</button>`;
  el.innerHTML = html;
}

function hidePlanActions() {
  document.querySelectorAll('.chat-plan-actions').forEach(el => el.remove());
}

// ── Send Message ──

async function sendMessage() {
  const input = $('dchat-input');
  const text = input.value.trim();
  if (!text || !activeProjectId) return;

  input.value = '';
  input.style.height = 'auto';

  if (isPlanningMode) {
    const hasPlan = document.querySelector('.chat-bubble--plan');
    if (hasPlan) {
      await sendEditPlan(text);
    } else {
      await sendPlanRequest(text);
    }
    return;
  }

  setTyping(true);
  isProcessing = true;
  setInputDisabled(true);

  try {
    const body = { text, type: 'update' };
    if (pendingFiles.length > 0) {
      body.attachmentIds = pendingFiles.map(f => ({ name: f.name, path: f.name, type: f.type }));
    }

    await fetch(`${API_BASE}/chat/${activeProjectId}/send`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('Failed to send message:', err);
  }

  pendingFiles = [];
  updateAttachPreview();
}

async function sendAnswer(answer) {
  if (!activeProjectId) return;

  document.querySelectorAll('.chat-bubble--question').forEach(el => {
    el.style.transition = 'opacity 0.3s, transform 0.3s';
    el.style.opacity = '0';
    el.style.transform = 'scale(0.95)';
    setTimeout(() => el.remove(), 300);
  });

  try {
    await fetch(`${API_BASE}/chat/${activeProjectId}/answer`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer }),
    });
  } catch (err) {
    console.error('Failed to send answer:', err);
  }
}

async function sendPlanRequest(description) {
  appendMessage({ role: 'user', type: 'text', content: description, id: 'plan-user-' + Date.now(), timestamp: Date.now() });
  setTyping(true);
  setInputDisabled(true);

  try {
    const res = await fetch(`${API_BASE}/chat/${activeProjectId}/plan`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ description }),
    });

    setTyping(false);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 402) {
        appendMessage({ role: 'system', type: 'balance_error', content: 'Insufficient balance', id: 'plan-err-' + Date.now(), timestamp: Date.now(), metadata: { balance: 0 } });
      } else {
        appendMessage({ role: 'system', type: 'error', content: err.error || 'Failed', id: 'plan-err-' + Date.now(), timestamp: Date.now() });
      }
      setInputDisabled(false);
      return;
    }

    const data = await res.json();
    if (data.status === 'streaming') {
      // Plan delivered via WebSocket plan_stream_* events.
      return;
    }
    appendMessage({ role: 'assistant', type: 'plan', content: data.plan, id: 'plan-' + Date.now(), timestamp: Date.now(), metadata: { costUsd: data.costUsd, balance: data.balance } });
    setInputDisabled(false);
    scrollToBottom();
    loadBalance();
  } catch {
    setTyping(false);
    setInputDisabled(false);
    showToast('Failed to generate plan');
  }
}

async function sendEditPlan(text) {
  appendMessage({ role: 'user', type: 'text', content: text, id: 'edit-user-' + Date.now(), timestamp: Date.now() });
  setTyping(true);
  setInputDisabled(true);

  try {
    const res = await fetch(`${API_BASE}/chat/${activeProjectId}/plan`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: text }),
    });

    setTyping(false);

    if (res.ok) {
      const data = await res.json();
      if (data.status === 'streaming') {
        // Plan delivered via WebSocket plan_stream_* events.
        return;
      }
      document.querySelectorAll('.chat-bubble--plan').forEach(el => el.remove());
      appendMessage({ role: 'assistant', type: 'plan', content: data.plan, id: 'plan-' + Date.now(), timestamp: Date.now(), metadata: { costUsd: data.costUsd, balance: data.balance } });
      loadBalance();
    }
    setInputDisabled(false);
    scrollToBottom();
  } catch {
    setTyping(false);
    setInputDisabled(false);
  }
}

// ── Plan actions ──

window.approvePlan = async function() {
  if (!activeProjectId) return;
  setInputDisabled(true);

  try {
    const res = await fetch(`${API_BASE}/chat/${activeProjectId}/approve-plan`, {
      method: 'POST',
      headers: apiHeaders(),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Failed');
      setInputDisabled(false);
      return;
    }
    hidePlanActions();
  } catch {
    showToast('Connection error');
    setInputDisabled(false);
  }
};

window.startEditPlan = function() {
  $('dchat-input').focus();
};

window.abortProcess = async function() {
  if (!activeProjectId) return;
  if (!confirm('Are you sure you want to stop the current process?')) return;

  try {
    const res = await fetch(`${API_BASE}/chat/${activeProjectId}/abort`, {
      method: 'POST',
      headers: apiHeaders(),
    });
    const data = await res.json();
    if (data.ok) {
      isProcessing = false;
      setInputDisabled(false);
      showToast('Process stopped');
    } else {
      showToast(data.error || 'Failed to stop');
    }
  } catch {
    showToast('Failed to stop process');
  }
};

// ── File attachments ──

function updateAttachPreview() {
  const preview = $('dchat-attachments-preview');
  if (!pendingFiles.length) {
    preview.classList.add('hidden');
    preview.innerHTML = '';
    return;
  }
  preview.classList.remove('hidden');
  preview.innerHTML = pendingFiles.map((f, i) =>
    `<div class="dchat-attach-item">
      <span>${esc(f.name)}</span>
      <button class="dchat-attach-remove" data-idx="${i}">×</button>
    </div>`
  ).join('');

  preview.querySelectorAll('.dchat-attach-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingFiles.splice(Number(btn.dataset.idx), 1);
      updateAttachPreview();
    });
  });
}

$('dbtn-attach')?.addEventListener('click', () => $('dfile-input').click());
$('dfile-input')?.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  for (const file of files) {
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API_BASE}/upload`, {
        method: 'POST',
        headers: apiHeaders(),
        body: form,
      });
      if (res.ok) {
        const data = await res.json();
        pendingFiles.push({ name: file.name, path: data.path, type: file.type });
      }
    } catch {}
  }
  updateAttachPreview();
  e.target.value = '';
});

// ── Input handling ──

function initInput() {
  const input = $('dchat-input');
  const sendBtn = $('dbtn-send');

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  sendBtn.addEventListener('click', () => sendMessage());
}

// ── Open Bot ──

$('btn-open-bot')?.addEventListener('click', () => {
  if (activeProject?.botUsername) {
    window.open(`https://t.me/${activeProject.botUsername}`, '_blank');
  }
});

// ── Init ──

function init() {
  initInput();
  applyLang();
  fetchBotConfig();

  const saved = localStorage.getItem('af_desktop_user');
  if (saved) {
    try { currentUser = JSON.parse(saved); } catch {}
  }

  if (authToken && currentUser) {
    showApp();
  } else {
    showLogin();
  }
}

init();
