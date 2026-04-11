'use strict';

const tg = window.Telegram?.WebApp;
const API_BASE = '/telegram-mini-app/api';

let projects = [];
let slots = { used: 0, total: 1 };
let currentProject = null;
let currentToken = null;
let currentView = 'list';
let editOriginal = {};

// Chat state
let chatWs = null;
let chatMode = 'update'; // 'update' | 'question'
let chatProjectId = null;
let pendingFiles = [];
let isProcessing = false;

function haptic(style = 'light') {
  tg?.HapticFeedback?.impactOccurred(style);
}
function hapticNotify(type = 'success') {
  tg?.HapticFeedback?.notificationOccurred(type);
}

function showToast(message, type = 'info', duration = 3500) {
  if (type === 'success') hapticNotify('success');
  else if (type === 'error') hapticNotify('error');
  else haptic('medium');
  const container = document.getElementById('toast-container');
  const icons = { success: '✓', error: '!', info: 'i' };
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${icons[type] || icons.info}</span>
    <span class="toast-text">${message}</span>
    <button class="toast-close">✕</button>
  `;
  container.appendChild(toast);

  const dismiss = () => {
    if (toast.classList.contains('toast-out')) return;
    toast.classList.add('toast-out');
    toast.addEventListener('animationend', () => toast.remove());
  };

  toast.querySelector('.toast-close').addEventListener('click', dismiss);
  toast.addEventListener('click', dismiss);
  setTimeout(dismiss, duration);
}

function setInputDisabled(disabled) {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('btn-send');
  const attachBtn = document.getElementById('btn-attach');
  const suggestBtn = document.getElementById('btn-get-suggestions');
  if (input) input.disabled = disabled;
  if (sendBtn) sendBtn.disabled = disabled;
  if (attachBtn) attachBtn.disabled = disabled;
  if (suggestBtn) suggestBtn.disabled = disabled;
  const area = document.getElementById('chat-input-area');
  if (area) area.classList.toggle('chat-input-disabled', disabled);
}

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
  const initials = getInitials(name).replace(/[<>&"']/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="100" height="100" fill="url(%23g)"/><text text-anchor="middle" x="50" y="66" fill="%23fff" font-size="44" font-weight="600" font-family="sans-serif">${initials}</text></svg>`;
  try { return 'data:image/svg+xml,' + encodeURIComponent(svg); }
  catch { return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 100 100"><rect width="100" height="100" fill="${c1}"/></svg>`); }
}

function statusLabel(status) {
  const map = {
    released: 'Released', deployed: 'Ready', building: 'Building',
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

function timeStr(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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

  document.getElementById('apps-header-count').textContent = `My Apps (${slots.used}/${slots.total})`;

  let html = `<a class="tm-row tm-row-add" id="btn-create-app"><span class="tm-icon"></span><span>Create New App</span></a>`;
  for (const p of filtered) {
    const avatarSrc = p.avatarUrl || avatarSvgDataUri(p.name);
    const username = p.botUsername ? `@${p.botUsername}` : '';
    html += `<a class="tm-row tm-row-link" data-id="${p.id}">` +
      `<img class="tm-row-pic tm-row-pic-user" src="${avatarSrc}">` +
      `<div><div class="tm-row-value">${esc(p.name)}</div>` +
      `<div class="tm-row-description">${esc(username)}</div></div>` +
      `<div class="tm-row-status">${p.status === 'building' ? '<span class="loader" style="width:16px;height:16px;margin-right:8px"></span>' : '<span class="tm-status-dot ' + p.status + '"></span>'}${statusLabel(p.status)}</div>` +
      `</a>`;
  }

  listEl.innerHTML = html;

  listEl.querySelectorAll('.tm-row-link').forEach(row => {
    row.addEventListener('click', () => openChat(row.dataset.id));
  });

  document.getElementById('btn-create-app')?.addEventListener('click', () => createNewApp());
}

// ── Create New App ──

let createPollTimer = null;

function createNewApp() {
  if (slots.used >= slots.total) {
    openSlotsFull();
    return;
  }
  const btn = document.getElementById('btn-create-app');
  if (btn) {
    const icon = btn.querySelector('.tm-icon');
    if (icon) { icon.className = 'loader'; icon.style.cssText = 'width:20px;height:20px;margin-right:4px'; }
  }
  const prevCount = projects.length;
  tg?.openTelegramLink('https://t.me/newbot/apps_father_bot/username_bot');
  startCreatePolling(prevCount);
}

function startCreatePolling(prevCount) {
  if (createPollTimer) clearInterval(createPollTimer);

  const onVisible = async () => {
    if (document.visibilityState !== 'visible') return;
    document.removeEventListener('visibilitychange', onVisible);
    pollForNewApp(prevCount);
  };
  document.addEventListener('visibilitychange', onVisible);

  pollForNewApp(prevCount);
}

function pollForNewApp(prevCount) {
  if (createPollTimer) clearInterval(createPollTimer);
  let attempts = 0;
  createPollTimer = setInterval(async () => {
    attempts++;
    if (attempts > 60) {
      clearInterval(createPollTimer);
      createPollTimer = null;
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/projects`, { headers: apiHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      const newProjects = data.projects || data;
      if (newProjects.length > prevCount) {
        clearInterval(createPollTimer);
        createPollTimer = null;
        const oldIds = new Set(projects.map(p => p.id));
        projects = newProjects;
        slots = data.slots || { used: newProjects.length, total: slots.total };
        renderAppList();
        const newest = newProjects.find(p => !oldIds.has(p.id)) || newProjects[newProjects.length - 1];
        if (newest) {
          openChat(newest.id);
        }
      }
    } catch {}
  }, 3000);
}

let slotsAnimInstance = null;

function openSlotsFull() {
  document.getElementById('slots-full-info').textContent =
    `You have used all ${slots.total} app slot${slots.total > 1 ? 's' : ''}. Purchase an additional slot to create more apps.`;
  document.getElementById('slots-full-detail').innerHTML =
    `<b>$25</b> per additional slot<br>Current slots: <b>${slots.used}/${slots.total}</b>`;
  loadSlotsTgs();
  showView('slots-full');
}

function loadSlotsTgs() {
  const container = document.getElementById('slots-anim');
  container.innerHTML = '';
  if (slotsAnimInstance) { slotsAnimInstance.destroy(); slotsAnimInstance = null; }
  fetch('tgs/duck_empty.tgs')
    .then(r => r.arrayBuffer())
    .then(buf => {
      const json = JSON.parse(pako.inflate(new Uint8Array(buf), { to: 'string' }));
      slotsAnimInstance = lottie.loadAnimation({
        container, renderer: 'svg', loop: true, autoplay: true, animationData: json,
      });
    })
    .catch(err => console.error('Failed to load slots TGS:', err));
}

async function buySlot() {
  tg?.MainButton?.showProgress();
  try {
    const res = await fetch(`${API_BASE}/buy-slot`, {
      method: 'POST',
      headers: apiHeaders(),
    });
    const data = await res.json();
    tg?.MainButton?.hideProgress();
    if (!res.ok || !data.ok) {
      showToast(data.error || 'Purchase failed', 'error');
      return;
    }
    slots.total = data.newSlots;
    showToast(`Slot purchased! You now have ${slots.used}/${data.newSlots} slots.`, 'success');
    await loadProjects();
    showView('list');
  } catch (err) {
    tg?.MainButton?.hideProgress();
    showToast('Error: ' + err.message, 'error');
  }
}

// ── Top Up ──

let topupAmount = 50;
let topupMethod = 'cryptobot';
let topupAnimInstance = null;
let topupReturnView = null;
let userBalance = 0;

function openTopup(returnTo) {
  topupReturnView = returnTo || currentView || 'list';
  topupAmount = 50;
  topupMethod = 'cryptobot';

  document.getElementById('topup-input').value = topupAmount;
  document.querySelectorAll('.topup-amount-btn').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.amount) === topupAmount);
  });
  document.querySelectorAll('.topup-method').forEach(m => {
    m.classList.toggle('active', m.dataset.method === topupMethod);
  });

  loadTopupBalance();
  loadTopupTgs();
  showView('topup');
}

async function loadTopupBalance() {
  try {
    const res = await fetch(`${API_BASE}/balance`, { headers: apiHeaders() });
    if (res.ok) {
      const data = await res.json();
      userBalance = data.balance;
      document.getElementById('topup-balance-text').textContent = `Current balance: $${Number(data.balance).toFixed(2)}`;
      const balEl = document.getElementById('balance-amount');
      if (balEl) balEl.textContent = `$${Number(data.balance).toFixed(2)}`;
    }
  } catch {}
}

function loadTopupTgs() {
  const container = document.getElementById('topup-anim');
  container.innerHTML = '';
  if (topupAnimInstance) { topupAnimInstance.destroy(); topupAnimInstance = null; }

  fetch('tgs/duck_dollars.tgs')
    .then(r => r.arrayBuffer())
    .then(buf => {
      const json = JSON.parse(pako.inflate(new Uint8Array(buf), { to: 'string' }));
      topupAnimInstance = lottie.loadAnimation({
        container,
        renderer: 'svg',
        loop: true,
        autoplay: true,
        animationData: json,
      });
    })
    .catch(err => console.error('Failed to load topup TGS:', err));
}

function updateTopupButton() {
  if (!tg?.MainButton) return;
  tg.MainButton.setText(`Pay $${topupAmount} — ${topupMethod === 'cryptobot' ? 'Crypto Bot' : topupMethod === 'stars' ? 'Stars' : 'Crypto'}`);
  tg.MainButton.color = '#248BDA';
  tg.MainButton.textColor = '#ffffff';
}

async function submitTopup() {
  const inputVal = parseInt(document.getElementById('topup-input').value);
  const amount = isNaN(inputVal) ? topupAmount : inputVal;
  if (amount < 10) {
    showToast('Minimum top-up is $10', 'error');
    return;
  }
  tg?.MainButton?.showProgress();
  try {
    const res = await fetch(`${API_BASE}/topup`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount, method: topupMethod }),
    });
    const data = await res.json();
    tg?.MainButton?.hideProgress();

    if (!res.ok || !data.ok) {
      showToast(data.error || 'Payment creation failed', 'error');
      return;
    }

    if (topupMethod === 'stars') {
      tg?.openInvoice(data.invoiceUrl);
    } else {
      tg?.openLink(data.invoiceUrl, { try_instant_view: true });
    }
  } catch (err) {
    tg?.MainButton?.hideProgress();
    showToast('Error: ' + err.message, 'error');
  }
}

function initTopupEvents() {
  const topupInput = document.getElementById('topup-input');

  document.querySelectorAll('.topup-amount-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      topupAmount = parseInt(btn.dataset.amount);
      topupInput.value = topupAmount;
      document.querySelectorAll('.topup-amount-btn').forEach(b => b.classList.toggle('active', b === btn));
      updateTopupButton();
    });
  });

  topupInput.addEventListener('input', () => {
    const val = parseInt(topupInput.value);
    topupAmount = isNaN(val) ? 0 : val;
    document.querySelectorAll('.topup-amount-btn').forEach(b => {
      b.classList.toggle('active', parseInt(b.dataset.amount) === topupAmount);
    });
    updateTopupButton();
  });

  document.querySelectorAll('.topup-method').forEach(row => {
    row.addEventListener('click', () => {
      topupMethod = row.dataset.method;
      document.querySelectorAll('.topup-method').forEach(m => m.classList.toggle('active', m === row));
      updateTopupButton();
    });
  });
}

// ── Chat ──

let isPlanningMode = false;
let planAnimInstance = null;

function openChat(projectId) {
  if (!currentProject || currentProject.id !== projectId) {
    currentProject = projects.find(p => p.id === projectId);
  }
  if (!currentProject) return;
  chatProjectId = projectId;

  const avatarEl = document.getElementById('chat-avatar');
  if (currentProject.avatarUrl) {
    avatarEl.textContent = '';
    avatarEl.style.background = `url(${currentProject.avatarUrl}) center/cover no-repeat`;
  } else {
    const [c1, c2] = getGradient(currentProject.name);
    avatarEl.textContent = getInitials(currentProject.name);
    avatarEl.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
  }

  document.getElementById('chat-app-name').textContent = currentProject.name;
  document.getElementById('chat-app-status').textContent =
    currentProject.botUsername ? `@${currentProject.botUsername}` : statusLabel(currentProject.status);

  document.getElementById('chat-messages-inner').innerHTML = '';
  document.getElementById('chat-input').value = '';
  document.getElementById('btn-send').classList.remove('active');
  pendingFiles = [];
  updateAttachPreview();

  const skelEl = document.getElementById('chat-skeleton');
  skelEl.classList.remove('hidden');

  const isNew = ['created', 'planning'].includes(currentProject.status) && !currentProject.currentVersion;
  enterPlanningMode(isNew);

  showView('chat');
  connectChatWS(projectId);
  loadChatHistory(projectId);
}

function enterPlanningMode(active) {
  isPlanningMode = active;
  const welcome = document.getElementById('chat-welcome');
  const pills = document.getElementById('chat-mode-pills');
  const inputBar = document.querySelector('.chat-input-bar');
  const suggestBtn = document.getElementById('btn-get-suggestions');
  const attachBtn = document.getElementById('btn-attach');
  const input = document.getElementById('chat-input');

  if (active) {
    welcome.classList.remove('hidden');
    pills.classList.add('hidden');
    suggestBtn.classList.add('hidden');
    inputBar.style.display = '';
    attachBtn.style.display = 'none';
    input.placeholder = 'Describe your app idea...';
    loadTgsAnimation();
  } else {
    welcome.classList.add('hidden');
    pills.classList.remove('hidden');
    attachBtn.style.display = '';
    if (planAnimInstance) {
      planAnimInstance.destroy();
      planAnimInstance = null;
    }
    switchChatMode(chatMode);
  }
}

function showEmptyChat() {
  const welcome = document.getElementById('chat-welcome');
  const welcomeText = document.querySelector('.chat-welcome-text');
  welcome.classList.remove('hidden');
  welcomeText.textContent = 'Send a message to continue building your app';
  loadTgsAnimation();
}

async function loadTgsAnimation() {
  const container = document.getElementById('chat-welcome-anim');
  container.innerHTML = '';
  if (planAnimInstance) { planAnimInstance.destroy(); planAnimInstance = null; }

  try {
    const res = await fetch('tgs/duck_planning.tgs');
    const buf = await res.arrayBuffer();
    const json = JSON.parse(pako.inflate(new Uint8Array(buf), { to: 'string' }));
    planAnimInstance = lottie.loadAnimation({
      container,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      animationData: json,
    });
  } catch (err) {
    console.error('Failed to load TGS:', err);
  }
}

function connectChatWS(projectId) {
  if (chatWs) {
    try { chatWs.close(); } catch {}
    chatWs = null;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${location.host}/telegram-mini-app/ws`;
  chatWs = new WebSocket(wsUrl);

  chatWs.onopen = () => {
    chatWs.send(JSON.stringify({ type: 'auth', initData: tg?.initData || '' }));
  };

  chatWs.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleWSMessage(data);
    } catch {}
  };

  chatWs.onclose = () => {
    setTimeout(() => {
      if (currentView === 'chat' && chatProjectId === projectId) {
        connectChatWS(projectId);
      }
    }, 3000);
  };
}

function handleWSMessage(data) {
  if (data.type === 'auth_ok') {
    chatWs.send(JSON.stringify({ type: 'subscribe', projectId: chatProjectId }));
    return;
  }

  if (data.type === 'stream_start') {
    setTyping(false);
    const inner = document.getElementById('chat-messages-inner');
    const el = document.createElement('div');
    el.id = `msg-${data.messageId}`;
    el.className = 'chat-bubble chat-bubble--assistant';
    el.innerHTML = `<div class="chat-bubble-content"><span class="stream-cursor"></span></div>`;
    inner.appendChild(el);
    scrollToBottom();
    return;
  }

  if (data.type === 'stream_chunk') {
    const el = document.getElementById(`msg-${data.messageId}`);
    if (el) {
      el.querySelector('.chat-bubble-content').innerHTML = formatContent(data.text) + '<span class="stream-cursor"></span>';
      haptic('light');
    }
    return;
  }

  if (data.type === 'stream_end') {
    const el = document.getElementById(`msg-${data.messageId}`);
    if (el && data.message) {
      const msg = data.message;
      const cls = msg.type === 'error' ? 'chat-bubble--error' : 'chat-bubble--assistant';
      el.className = `chat-bubble ${cls}`;
      let html = `<div class="chat-bubble-content">${msg.type === 'error' ? esc(msg.content) : formatContent(msg.content)}</div>`;
      html += `<div class="chat-bubble-time">${timeStr(msg.timestamp)}</div>`;
      el.innerHTML = html;
      el.id = `msg-${msg.id}`;
      scrollToBottom();
    }
    return;
  }

  if (data.type === 'message') {
    const msg = data.message;
    if (msg.type === 'progress') {
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
    setHeaderWorking(false);
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

  if (data.type === 'status_change') {
    if (currentProject) {
      currentProject.status = data.status;
      if (data.status === 'deployed' || data.status === 'released') {
        enterPlanningMode(false);
      }
    }
    return;
  }

  if (data.type === 'status') {
    if (data.status === 'done') {
      isProcessing = false;
      setInputDisabled(false);
      setTyping(false);
      setHeaderWorking(false);
      if (isPlanningMode) enterPlanningMode(false);
      // Update the progress bubble to result state
      const el = document.getElementById(`msg-${data.messageId}`);
      if (el) {
        el.className = 'chat-bubble chat-bubble--result';
        let html = `<div class="chat-result-header">Update Completed</div>`;
        html += `<div class="chat-bubble-content">${formatContent(data.summary || '')}</div>`;
        if (data.changelogUrl) {
          html += `<div class="changelog-card" onclick="tg.openLink('${data.changelogUrl}', {try_instant_view: true})">
            <div class="changelog-card-text">
              <div class="changelog-card-title">Full Change Log</div>
              <div class="changelog-card-desc">Tap to view on Telegraph</div>
            </div>
            <div class="changelog-card-arrow">›</div>
          </div>`;
        }
        html += `<div class="result-actions">
          <button class="result-action-btn result-action-test" onclick="openTestPreview('${chatProjectId}')">▶ Run & Test</button>
          <button class="result-action-btn result-action-release" onclick="releaseLatest()">Release Update</button>
        </div>`;
        if (typeof data.costUsd === 'number') {
          html += `<div class="chat-progress-cost">Cost: $${data.costUsd.toFixed(4)}${typeof data.balance === 'number' ? ` · Balance: $${data.balance.toFixed(2)}` : ''}</div>`;
        }
        el.innerHTML = html;
        scrollToBottom();
      }
    }
    return;
  }
}

async function loadChatHistory(projectId) {
  const skelEl = document.getElementById('chat-skeleton');
  try {
    const res = await fetch(`${API_BASE}/chat/${projectId}`, { headers: apiHeaders() });
    if (!res.ok) { skelEl.classList.add('hidden'); return; }
    const data = await res.json();
    const inner = document.getElementById('chat-messages-inner');
    inner.innerHTML = '';
    let hasPlanOrResult = false;
    for (const msg of data.messages) {
      if (msg.type === 'progress' && msg.percent === 100) {
        msg.type = 'result';
      }
      if (msg.type === 'plan' || msg.type === 'result') hasPlanOrResult = true;
      appendMessage(msg, false);
    }
    if (hasPlanOrResult && isPlanningMode) {
      document.getElementById('chat-welcome').classList.add('hidden');
    }
    if (data.messages.some(m => m.type === 'result')) {
      enterPlanningMode(false);
    }
    if (data.messages.length === 0 && !isPlanningMode) {
      showEmptyChat();
    }
    skelEl.classList.add('hidden');
    scrollToBottom(true);
  } catch (err) {
    console.error('Failed to load chat history:', err);
    skelEl.classList.add('hidden');
  }
}

function appendMessage(msg, animate = true) {
  const inner = document.getElementById('chat-messages-inner');
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
    el.className = 'chat-bubble chat-bubble--balance-error';
    const bal = msg.metadata?.balance ?? 0;
    el.innerHTML = `
      <div class="balance-error-icon">💳</div>
      <div class="balance-error-title">Insufficient Balance</div>
      <div class="balance-error-desc">Your balance is $${Number(bal).toFixed(2)}. Minimum $5.00 required.</div>
      <button class="balance-error-btn" onclick="openTopup()">Top Up Balance</button>`;
    if (isProcessing) {
      isProcessing = false;
      setInputDisabled(false);
      setTyping(false);
      setHeaderWorking(false);
    }
  } else if (msg.type === 'error') {
    el.className = 'chat-bubble chat-bubble--error';
    el.innerHTML = `<div class="chat-bubble-content">${esc(msg.content)}</div>`;
    if (isProcessing) {
      isProcessing = false;
      setInputDisabled(false);
      setTyping(false);
      setHeaderWorking(false);
    }
  } else if (msg.type === 'question') {
    el.className = 'chat-bubble chat-bubble--question';
    let html = `<div class="question-card">`;
    html += `<div class="question-card-icon">❓</div>`;
    html += `<div class="question-card-title">Agent needs your input</div>`;
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
    html += `<button class="question-custom-send" disabled>`;
    html += `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2L15 22L11 13L2 9L22 2Z"/></svg>`;
    html += `</button>`;
    html += `</div>`;
    html += `</div>`;
    el.innerHTML = html;

    const card = el.querySelector('.question-card');
    const customInput = card.querySelector('.question-custom-input');
    const customSend = card.querySelector('.question-custom-send');

    const lockQuestion = (chosen) => {
      card.classList.add('answered');
      card.querySelectorAll('.question-opt-btn').forEach(b => { b.disabled = true; });
      customInput.disabled = true;
      customSend.disabled = true;
    };

    card.querySelectorAll('.question-opt-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.add('selected');
        lockQuestion(btn.dataset.answer);
        sendAnswer(btn.dataset.answer);
      });
    });

    customInput.addEventListener('input', () => {
      customSend.disabled = !customInput.value.trim();
    });
    customInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && customInput.value.trim()) {
        lockQuestion(customInput.value.trim());
        sendAnswer(customInput.value.trim());
      }
    });
    customSend.addEventListener('click', () => {
      if (customInput.value.trim()) {
        lockQuestion(customInput.value.trim());
        sendAnswer(customInput.value.trim());
      }
    });
  } else if (msg.type === 'result') {
    el.className = 'chat-bubble chat-bubble--result';
    let html = `<div class="chat-result-header">Update Completed</div>`;
    html += `<div class="chat-bubble-content">${formatContent(msg.content)}</div>`;
    const changelogUrl = msg.metadata?.changelogUrl;
    if (changelogUrl) {
      html += `<div class="changelog-card" onclick="tg.openLink('${changelogUrl}', {try_instant_view: true})">
        <div class="changelog-card-text">
          <div class="changelog-card-title">Full Change Log</div>
          <div class="changelog-card-desc">Tap to view on Telegraph</div>
        </div>
        <div class="changelog-card-arrow">›</div>
      </div>`;
    }
    html += `<div class="result-actions">
      <button class="result-action-btn result-action-test" onclick="openTestPreview('${msg.metadata?.projectId || chatProjectId}')">▶ Run & Test</button>
      <button class="result-action-btn result-action-release" onclick="releaseLatest()">Release Update</button>
    </div>`;
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
      <button class="chat-plan-btn chat-plan-btn--build" onclick="approvePlan()">Let's Build</button>
      <button class="chat-plan-btn chat-plan-btn--edit" onclick="startEditPlan()">Edit</button>
    </div>`;
    el.innerHTML = html;
  } else if (msg.type === 'progress') {
    renderProgressBubble(msg);
    return;
  } else {
    // assistant text or system
    const cls = msg.role === 'system' ? 'chat-bubble--system' : 'chat-bubble--assistant';
    el.className = `chat-bubble ${cls}`;
    let html = `<div class="chat-bubble-content">${formatContent(msg.content)}</div>`;
    html += `<div class="chat-bubble-time">${timeStr(msg.timestamp)}</div>`;
    el.innerHTML = html;
  }

  if (!animate) el.style.animation = 'none';
  inner.appendChild(el);
}

function renderProgressBubble(msg) {
  const inner = document.getElementById('chat-messages-inner');
  let el = document.getElementById(`msg-${msg.id}`);
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

  if (msg.checklist && msg.checklist.length > 0) {
    html += renderChecklist(msg.checklist);
  }

  if (msg.content && msg.content !== 'Starting...') {
    html += `<div class="chat-progress-status">${esc(msg.content)}</div>`;
  }

  if (typeof msg.costUsd === 'number' && msg.costUsd > 0) {
    html += `<div class="chat-progress-cost">Cost: $${msg.costUsd.toFixed(4)}${typeof msg.balance === 'number' ? ` · Balance: $${msg.balance.toFixed(2)}` : ''}</div>`;
  }

  el.innerHTML = html;
  isProcessing = true;
  setTyping(false);
  setHeaderWorking(true, pct);
  if (isNew) scrollToBottom();
}

function updateProgressBubble(data) {
  const el = document.getElementById(`msg-${data.messageId}`);
  if (!el) return;

  const pct = data.percent || 0;
  let html = `<div class="chat-progress-text"><span class="loader"></span> Working... <b>${pct}%</b></div>`;
  html += `<div class="chat-progress-bar"><div class="chat-progress-fill" style="width:${pct}%"></div></div>`;

  if (data.checklist && data.checklist.length > 0) {
    html += renderChecklist(data.checklist);
  }

  if (data.message) {
    html += `<div class="chat-progress-status">${esc(data.message)}</div>`;
  }

  if (typeof data.costUsd === 'number' && data.costUsd > 0) {
    html += `<div class="chat-progress-cost">Cost: $${data.costUsd.toFixed(4)}${typeof data.balance === 'number' ? ` · Balance: $${data.balance.toFixed(2)}` : ''}</div>`;
  }

  el.innerHTML = html;
  setHeaderWorking(true, pct);
}

function renderChecklist(items) {
  let html = '<ul class="chat-checklist">';
  for (const item of items) {
    const done = item.done ? ' done' : '';
    html += `<li class="${done}"><span class="check-icon"></span>${esc(item.text)}</li>`;
  }
  html += '</ul>';
  return html;
}

function formatContent(text) {
  if (!text) return '';
  let s = esc(text);

  // Code blocks first (protect from other transforms)
  const codeBlocks = [];
  s = s.replace(/```([\s\S]*?)```/g, (_m, code) => {
    codeBlocks.push(code);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Inline code
  const inlineCodes = [];
  s = s.replace(/`([^`]+)`/g, (_m, code) => {
    inlineCodes.push(code);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Tables: detect lines with | separators
  s = s.replace(/((?:^|\n)\|.+\|(?:\n\|.+\|)*)/g, (block) => {
    const rows = block.trim().split('\n').filter(r => r.trim());
    if (rows.length < 2) return block;

    // Check if second row is separator (|---|---|)
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

  // Headings
  s = s.replace(/^### (.+)$/gm, '<h4 class="chat-h">$1</h4>');
  s = s.replace(/^## (.+)$/gm, '<h3 class="chat-h">$1</h3>');
  s = s.replace(/^# (.+)$/gm, '<h2 class="chat-h">$1</h2>');

  // Bold / italic
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/\*(.+?)\*/g, '<i>$1</i>');

  // Horizontal rules
  s = s.replace(/^-{3,}$/gm, '<hr class="chat-hr">');

  // Numbered lists
  s = s.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

  // Unordered lists
  s = s.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  s = s.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul class="chat-ul">$1</ul>');

  // Line breaks (but not around block elements)
  s = s.replace(/\n/g, '<br>');
  const blockEls = 'h[234]|table|ul|\/table|\/ul|pre|\/pre|hr';
  s = s.replace(new RegExp(`(<br>)+(<(?:${blockEls})[^>]*>)`, 'g'), '$2');
  s = s.replace(new RegExp(`(<\/(?:${blockEls})>)(<br>)+`, 'g'), '$1');
  s = s.replace(/<li>(.*?)<\/li><br>/g, '<li>$1</li>');
  s = s.replace(/(<br>){3,}/g, '<br><br>');

  // Restore code blocks
  s = s.replace(/\x00CB(\d+)\x00/g, (_m, i) => `<pre>${codeBlocks[Number(i)]}</pre>`);
  s = s.replace(/\x00IC(\d+)\x00/g, (_m, i) => `<code>${inlineCodes[Number(i)]}</code>`);

  return s;
}

async function sendMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !chatProjectId) return;

  input.value = '';
  input.style.height = 'auto';
  input.blur();
  document.getElementById('btn-send').classList.remove('active');

  document.getElementById('chat-welcome').classList.add('hidden');

  if (isPlanningMode) {
    const hasPlan = document.querySelector('.chat-bubble--plan');
    if (hasPlan) {
      await sendEditPlan(text);
    } else {
      await sendPlanRequest(text);
    }
    return;
  }

  const type = chatMode === 'update' ? 'update' : 'question';

  if (type === 'update') {
    setTyping(true);
    isProcessing = true;
    setInputDisabled(true);
  } else {
    setTyping(true);
  }

  try {
    const body = { text, type };
    if (pendingFiles.length > 0 && type === 'update') {
      body.attachmentIds = pendingFiles.map(f => ({ name: f.name, path: f.name, type: f.type }));
    }

    const res = await fetch(`${API_BASE}/chat/${chatProjectId}/send`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('Send failed:', err);
    }
  } catch (err) {
    console.error('Failed to send message:', err);
  }

  pendingFiles = [];
  updateAttachPreview();
}

async function sendAnswer(answer) {
  if (!chatProjectId) return;

  document.querySelectorAll('.chat-option-btn').forEach(btn => {
    if (btn.dataset.answer === answer) btn.classList.add('selected');
    btn.disabled = true;
  });

  try {
    await fetch(`${API_BASE}/chat/${chatProjectId}/answer`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer }),
    });

    if (chatWs && chatWs.readyState === WebSocket.OPEN) {
      chatWs.send(JSON.stringify({ type: 'answer', projectId: chatProjectId, answer }));
    }
  } catch (err) {
    console.error('Failed to send answer:', err);
  }
}

async function sendPlanRequest(description) {
  const welcome = document.getElementById('chat-welcome');
  welcome.classList.add('hidden');

  appendMessage({ role: 'user', type: 'text', content: description, id: 'plan-user-' + Date.now(), timestamp: Date.now() });
  setTyping(true);
  setInputDisabled(true);

  try {
    const res = await fetch(`${API_BASE}/chat/${chatProjectId}/plan`, {
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
        appendMessage({ role: 'system', type: 'error', content: err.error || 'Failed to generate plan', id: 'plan-err-' + Date.now(), timestamp: Date.now() });
      }
      setInputDisabled(false);
      return;
    }

    const data = await res.json();
    appendMessage({
      role: 'assistant', type: 'plan', content: data.plan,
      id: 'plan-' + Date.now(), timestamp: Date.now(),
      metadata: { costUsd: data.costUsd, balance: data.balance },
    });
    setInputDisabled(false);
  } catch (err) {
    setTyping(false);
    setInputDisabled(false);
    appendMessage({ role: 'system', type: 'error', content: 'Network error: ' + err.message, id: 'plan-err-' + Date.now(), timestamp: Date.now() });
  }
}

async function approvePlan() {
  if (!chatProjectId) return;

  document.querySelectorAll('.chat-plan-btn').forEach(b => {
    b.disabled = true;
    b.style.opacity = '0.4';
    b.style.pointerEvents = 'none';
  });

  isProcessing = true;
  setInputDisabled(true);

  const buildMsgId = 'build-' + Date.now();
  renderProgressBubble({
    id: buildMsgId,
    type: 'progress',
    content: 'Starting...',
    percent: 0,
    checklist: [],
  });
  scrollToBottom();

  try {
    const res = await fetch(`${API_BASE}/chat/${chatProjectId}/approve-plan`, {
      method: 'POST',
      headers: apiHeaders(),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 402) {
        appendMessage({ role: 'system', type: 'balance_error', content: 'Insufficient balance', id: 'bal-err-' + Date.now(), timestamp: Date.now(), metadata: { balance: 0 } });
        scrollToBottom();
      } else {
        showToast(err.error || 'Failed to start build', 'error');
      }
      const el = document.getElementById(`msg-${buildMsgId}`);
      if (el) el.remove();
      isProcessing = false;
      setInputDisabled(false);
      document.querySelectorAll('.chat-plan-btn').forEach(b => {
        b.disabled = false;
        b.style.opacity = '';
        b.style.pointerEvents = '';
      });
      return;
    }

    isPlanningMode = false;
    const pills = document.getElementById('chat-mode-pills');
    pills.classList.remove('hidden');
    document.getElementById('btn-attach').style.display = '';
    switchChatMode('update');
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
    const el = document.getElementById(`msg-${buildMsgId}`);
    if (el) el.remove();
    isProcessing = false;
    setInputDisabled(false);
    document.querySelectorAll('.chat-plan-btn').forEach(b => {
      b.disabled = false;
      b.style.opacity = '';
      b.style.pointerEvents = '';
    });
  }
}

function startEditPlan() {
  const input = document.getElementById('chat-input');
  input.placeholder = 'Describe what to change in the plan...';
  input.focus();
}

async function sendEditPlan(feedback) {
  appendMessage({ role: 'user', type: 'text', content: feedback, id: 'edit-plan-' + Date.now(), timestamp: Date.now() });
  setTyping(true);
  setInputDisabled(true);

  try {
    const res = await fetch(`${API_BASE}/chat/${chatProjectId}/edit-plan`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ feedback }),
    });

    setTyping(false);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      appendMessage({ role: 'system', type: 'error', content: err.error || 'Failed to update plan', id: 'edit-err-' + Date.now(), timestamp: Date.now() });
      setInputDisabled(false);
      return;
    }

    const data = await res.json();
    appendMessage({
      role: 'assistant', type: 'plan', content: data.plan,
      id: 'plan-updated-' + Date.now(), timestamp: Date.now(),
      metadata: { costUsd: data.costUsd, balance: data.balance },
    });
    setInputDisabled(false);
  } catch (err) {
    setTyping(false);
    setInputDisabled(false);
    appendMessage({ role: 'system', type: 'error', content: 'Network error: ' + err.message, id: 'edit-err-' + Date.now(), timestamp: Date.now() });
  }
}

function setTyping(visible) {
  document.getElementById('chat-typing').classList.toggle('hidden', !visible);
  if (visible) scrollToBottom();
}

async function releaseLatest() {
  const projectId = chatProjectId || currentProject?.id;
  if (!projectId) return;

  tg?.showConfirm('Are you sure you want to release this update?', async (confirmed) => {
    if (!confirmed) return;
    try {
      const res = await fetch(`${API_BASE}/versions/${projectId}/release`, {
        method: 'POST',
        headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) {
        showToast(data.error || 'Release failed', 'error');
        return;
      }
      showToast(`Version ${data.released} released!`, 'success');
    } catch (err) {
      showToast('Error: ' + err.message, 'error');
    }
  });
}

function openTestPreview(projectId) {
  const hash = location.hash || '';
  const tgData = hash.includes('tgWebAppData') ? hash : '';
  const devUrl = `${location.origin}/dev/${projectId}/${tgData}`;

  let overlay = document.getElementById('test-preview-overlay');
  if (overlay) { overlay.remove(); }

  overlay = document.createElement('div');
  overlay.id = 'test-preview-overlay';
  overlay.className = 'test-preview-overlay';
  overlay.innerHTML = `
    <div class="test-preview-header">
      <button class="test-preview-back" onclick="closeTestPreview()">← Back</button>
      <span class="test-preview-title">Dev Preview</span>
      <span class="test-preview-badge">DEV</span>
    </div>
    <iframe class="test-preview-iframe" src="${devUrl}"></iframe>
  `;
  document.body.appendChild(overlay);
}

function closeTestPreview() {
  const overlay = document.getElementById('test-preview-overlay');
  if (overlay) overlay.remove();
}

function setHeaderWorking(working, pct) {
  const statusEl = document.getElementById('chat-app-status');
  if (!statusEl) return;
  if (working) {
    statusEl.innerHTML = `<span class="loader loader--small"></span> Working... ${pct || 0}%`;
    statusEl.classList.add('header-working');
  } else {
    statusEl.textContent = currentProject?.botUsername
      ? `@${currentProject.botUsername}`
      : statusLabel(currentProject?.status);
    statusEl.classList.remove('header-working');
  }
}

function scrollToBottom(instant) {
  const container = document.getElementById('chat-messages');
  requestAnimationFrame(() => {
    container.scrollTo({ top: container.scrollHeight, behavior: instant ? 'instant' : 'smooth' });
  });
}

function updateAttachPreview() {
  const preview = document.getElementById('chat-attachments-preview');
  if (pendingFiles.length === 0) {
    preview.classList.add('hidden');
    preview.innerHTML = '';
    return;
  }
  preview.classList.remove('hidden');
  let html = '';
  for (let i = 0; i < pendingFiles.length; i++) {
    const f = pendingFiles[i];
    if (f.type && f.type.startsWith('image/')) {
      html += `<div class="chat-attach-thumb"><img src="${URL.createObjectURL(f)}"><button class="chat-attach-remove" data-idx="${i}">×</button></div>`;
    } else {
      html += `<div class="chat-attach-thumb"><span class="file-label">${esc(f.name)}</span><button class="chat-attach-remove" data-idx="${i}">×</button></div>`;
    }
  }
  preview.innerHTML = html;
  preview.querySelectorAll('.chat-attach-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      pendingFiles.splice(parseInt(btn.dataset.idx), 1);
      updateAttachPreview();
    });
  });
}

async function uploadFiles(files) {
  if (!chatProjectId || files.length === 0) return;
  const formData = new FormData();
  for (const f of files) formData.append('files', f);

  try {
    const res = await fetch(`${API_BASE}/chat/${chatProjectId}/upload`, {
      method: 'POST',
      headers: apiHeaders(),
      body: formData,
    });
    if (res.ok) {
      const data = await res.json();
      console.log('Uploaded:', data.files);
    }
  } catch (err) {
    console.error('Upload error:', err);
  }
}

// ── Detail view (settings) ──

async function openDetail(id) {
  const p = currentProject || projects.find(pp => pp.id === id);
  if (!p) return;
  currentProject = p;

  document.getElementById('detail-name').textContent = p.name;
  document.getElementById('detail-username').textContent = p.botUsername ? `@${p.botUsername}` : '';

  const avatarEl = document.getElementById('detail-avatar');
  if (p.avatarUrl) {
    avatarEl.textContent = '';
    avatarEl.style.background = `url(${p.avatarUrl}) center/cover no-repeat`;
  } else {
    const [c1, c2] = getGradient(p.name);
    avatarEl.textContent = getInitials(p.name);
    avatarEl.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
  }

  const version = p.currentVersion || 0;
  const cost = p.totalCostUsd ? `$${Number(p.totalCostUsd).toFixed(2)}` : '$0.00';
  document.getElementById('detail-info').innerHTML =
    `Version: <b>${version}</b> · Total cost: <b>${cost}</b> · Quality: <b>Tier ${p.qualityTier || 1}</b>`;

  const isLive = ['deployed', 'released'].includes(p.status);
  const baseUrl = location.origin;

  currentToken = null;
  const tokenSection = document.getElementById('section-token');
  const spoiler = document.getElementById('token-spoiler');
  spoiler.classList.add('spoiler-active');
  spoiler.classList.remove('js-spoiler-revealed');
  document.getElementById('token-text').textContent = '';
  tokenSection.style.display = 'none';
  fetchToken(p.id);

  let appRows = '';
  if (isLive) {
    appRows += menuRowAction('Test App', 'af-icon-test', 'open-test-preview');
    if (p.botUsername) {
      appRows += menuRowAction('Open App & Bot', 'af-icon-open', 'open-bot');
    }
  }
  document.getElementById('detail-app-rows').innerHTML = appRows;
  document.getElementById('section-app').style.display = appRows ? '' : 'none';

  document.getElementById('detail-app-rows').querySelector('[data-action="open-test-preview"]')
    ?.addEventListener('click', () => openTestPreview(p.id));
  document.getElementById('detail-app-rows').querySelector('[data-action="open-bot"]')
    ?.addEventListener('click', () => tg?.openTelegramLink(`https://t.me/${p.botUsername}`));

  let devRows = menuRowAction('Update App', 'af-icon-update', 'open-update');
  if (isLive) devRows += menuRowAction('Release Version', 'af-icon-release', 'open-release');
  devRows += menuRowAction('Versions', 'af-icon-versions', 'open-versions');
  devRows += menuRowAction('Get Update Suggestions', 'af-icon-suggest', 'open-suggestions');
  document.getElementById('detail-dev-rows').innerHTML = devRows;

  let moneyRows = menuRowAction('Features', 'af-icon-features', 'open-features');
  if (hasFeature(p, 'ton_payment')) moneyRows += menuRow('Wallet', 'af-icon-wallet');
  document.getElementById('detail-money-rows').innerHTML = moneyRows;
  document.getElementById('section-monetization').style.display = '';

  let settingsRows = '';
  settingsRows += menuRowAction('Edit Bot Info', 'af-icon-edit-info', 'open-edit-info');
  settingsRows += menuRowAction('Quality Tier', 'af-icon-quality', 'open-quality');
  if (hasFeature(p, 'get_code')) settingsRows += menuRow('Edit Code', 'af-icon-code', `${baseUrl}/editor/${p.id}/`);
  if (hasFeature(p, 'admin_panel')) settingsRows += menuRow('Admin Panel', 'af-icon-admin', `${baseUrl}/admin/${p.id}/`);
  document.getElementById('detail-settings-rows').innerHTML = settingsRows;

  document.getElementById('detail-settings-rows').querySelector('[data-action="open-edit-info"]')
    ?.addEventListener('click', () => openEditInfo());
  document.getElementById('detail-settings-rows').querySelector('[data-action="open-quality"]')
    ?.addEventListener('click', () => openQuality(p.id));

  document.getElementById('detail-money-rows').querySelector('[data-action="open-features"]')
    ?.addEventListener('click', () => openFeatures(p.id));

  document.getElementById('detail-dev-rows').querySelector('[data-action="open-update"]')
    ?.addEventListener('click', () => {
      switchChatMode('update');
      showView('chat');
    });

  document.getElementById('detail-dev-rows').querySelector('[data-action="open-versions"]')
    ?.addEventListener('click', () => openVersions(p.id));

  document.getElementById('detail-dev-rows').querySelector('[data-action="open-release"]')
    ?.addEventListener('click', async () => {
      try {
        const res = await fetch(`${API_BASE}/versions/${p.id}`, { headers: apiHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const versions = data.versions || [];
        if (versions.length === 0) {
          showToast('No versions to release. Send an update first.', 'info');
          return;
        }
        const latest = versions[0];
        tg?.showConfirm(`Release Version #${latest.version}?`, async (ok) => {
          if (!ok) return;
          try {
            const r = await fetch(`${API_BASE}/versions/${p.id}/release`, {
              method: 'POST',
              headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
              body: JSON.stringify({ version: latest.version }),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const d = await r.json();
            showToast(`Version #${d.released} released!`, 'success');
            await loadProjects();
            openDetail(p.id);
          } catch (err) {
            console.error('Release error:', err);
            showToast('Failed to release.', 'error');
          }
        });
      } catch (err) {
        console.error('Fetch versions error:', err);
        showToast('Failed to load versions.', 'error');
      }
    });

  document.getElementById('detail-dev-rows').querySelector('[data-action="open-suggestions"]')
    ?.addEventListener('click', () => {
      switchChatMode('suggestion');
      showView('chat');
    });

  let actionsRows = '';
  actionsRows += `<a class="tm-row tm-row-add" data-action="open-transfer"><span class="tm-icon" style="--icon-s:var(--image-url-transfer-ownership)"></span><span>Transfer Ownership</span></a>`;
  actionsRows += `<a class="tm-row tm-row-destructive" data-action="open-delete"><span class="tm-icon" style="--icon-s:var(--image-url-trash)"></span><span>Delete App</span></a>`;
  document.getElementById('detail-actions-rows').innerHTML = actionsRows;

  document.getElementById('detail-actions-rows').querySelector('[data-action="open-transfer"]')
    ?.addEventListener('click', () => openTransfer());
  document.getElementById('detail-actions-rows').querySelector('[data-action="open-delete"]')
    ?.addEventListener('click', () => openDeleteApp());

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

let editPhotoFile = null;

function autosizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

function initAutosize() {
  document.querySelectorAll('.tm-autosize').forEach(el => {
    el.addEventListener('input', () => autosizeTextarea(el));
  });
}

async function openEditInfo() {
  if (!currentProject || !currentToken) {
    showToast('Token not loaded yet. Please wait.', 'info');
    return;
  }
  const p = currentProject;
  editPhotoFile = null;

  const avatarEl = document.getElementById('edit-avatar');
  if (p.avatarUrl) {
    avatarEl.textContent = '';
    avatarEl.style.backgroundImage = `url(${p.avatarUrl})`;
    avatarEl.style.backgroundSize = 'cover';
    avatarEl.style.backgroundPosition = 'center';
  } else {
    const [c1, c2] = getGradient(p.name);
    avatarEl.textContent = getInitials(p.name);
    avatarEl.style.backgroundImage = '';
    avatarEl.style.background = `linear-gradient(135deg, ${c1}, ${c2})`;
  }

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
  setTimeout(() => {
    document.querySelectorAll('#view-edit-info .tm-autosize').forEach(el => autosizeTextarea(el));
  }, 50);
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
  if (!currentProject) return;

  const name = document.getElementById('edit-name').value.trim();
  const about = document.getElementById('edit-about').value.trim();
  const description = document.getElementById('edit-description').value.trim();

  if (!name) {
    showToast('Bot name cannot be empty', 'error');
    return;
  }

  tg?.MainButton?.showProgress();

  try {
    const formData = new FormData();
    if (name !== editOriginal.name) formData.append('name', name);
    if (about !== editOriginal.about) formData.append('about', about);
    if (description !== editOriginal.description) formData.append('description', description);
    if (editPhotoFile) formData.append('photo', editPhotoFile);

    const res = await fetch(`${API_BASE}/bot-info/${currentProject.id}`, {
      method: 'POST',
      headers: { 'X-Telegram-Init-Data': tg?.initData || '' },
      body: formData,
    });
    const data = await res.json();

    tg?.MainButton?.hideProgress();

    if (data.errors?.length > 0) {
      const friendlyErrors = data.errors.map(e => {
        if (e.includes('PHOTO_CROP_SIZE_SMALL')) return 'Photo is too small. Please upload a larger image (at least 150x150 pixels).';
        return e;
      });
      showToast(friendlyErrors.join(' '), 'error');
    } else {
      showToast('Bot info updated!', 'success');
      if (name !== editOriginal.name) {
        currentProject.name = name;
        const p = projects.find(pp => pp.id === currentProject.id);
        if (p) p.name = name;
      }
      if (description !== editOriginal.description) {
        currentProject.description = description;
      }
      editPhotoFile = null;
      await loadProjects();
      openDetail(currentProject.id);
    }
  } catch (err) {
    tg?.MainButton?.hideProgress();
    showToast('Error: ' + err.message, 'error');
  }
}

// ── Transfer Ownership ──

function openTransfer() {
  if (!currentProject) return;
  document.getElementById('transfer-username').value = '';
  showView('transfer');
}

async function submitTransfer() {
  if (!currentProject) return;
  const username = document.getElementById('transfer-username').value.trim();
  if (!username) {
    showToast('Please enter a username', 'error');
    return;
  }

  tg?.MainButton?.showProgress();
  try {
    const res = await fetch(`${API_BASE}/transfer/${currentProject.id}`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    const data = await res.json();
    tg?.MainButton?.hideProgress();

    if (!res.ok || !data.ok) {
      showToast(data.error || 'Transfer failed', 'error');
      return;
    }

    showToast(`App transferred to @${data.transferredTo}`, 'success');
    currentProject = null;
    currentToken = null;
    await loadProjects();
    showView('list');
  } catch (err) {
    tg?.MainButton?.hideProgress();
    showToast('Error: ' + err.message, 'error');
  }
}

// ── Delete App ──

function openDeleteApp() {
  if (!currentProject) return;
  const appName = currentProject.name || 'this app';
  document.getElementById('delete-confirm-input').value = '';
  document.getElementById('delete-confirm-input').placeholder = `Type "${appName}" to confirm`;
  document.getElementById('delete-help-text').textContent = `Type the app name "${appName}" exactly to confirm deletion.`;
  showView('delete');
}

async function submitDelete() {
  if (!currentProject) return;
  const appName = currentProject.name || 'this app';
  const typed = document.getElementById('delete-confirm-input').value.trim();

  if (typed !== appName) {
    showToast('Name does not match. Please type it exactly.', 'error');
    return;
  }

  tg?.MainButton?.showProgress();
  try {
    const res = await fetch(`${API_BASE}/delete/${currentProject.id}`, {
      method: 'POST',
      headers: apiHeaders(),
    });
    const data = await res.json();
    tg?.MainButton?.hideProgress();

    if (!res.ok || !data.ok) {
      showToast(data.error || 'Delete failed', 'error');
      return;
    }

    showToast('App deleted', 'success');
    currentProject = null;
    currentToken = null;
    chatProjectId = null;
    await loadProjects();
    showView('list');
  } catch (err) {
    tg?.MainButton?.hideProgress();
    showToast('Error: ' + err.message, 'error');
  }
}

// ── Referral Program ──

let referralAnimInstance = null;

function openReferral() {
  const userId = tg?.initDataUnsafe?.user?.id || '';
  const refLink = `https://t.me/apps_father_bot?start=${userId}`;

  const container = document.getElementById('referral-anim');
  container.innerHTML = '';
  if (referralAnimInstance) { referralAnimInstance.destroy(); referralAnimInstance = null; }
  fetch('tgs/duck_burn.tgs')
    .then(r => r.arrayBuffer())
    .then(buf => {
      const json = JSON.parse(pako.inflate(new Uint8Array(buf), { to: 'string' }));
      referralAnimInstance = lottie.loadAnimation({
        container, renderer: 'svg', loop: true, autoplay: true, animationData: json,
      });
    })
    .catch(err => console.error('Failed to load referral TGS:', err));

  document.getElementById('referral-content').innerHTML = `
    <div class="tm-info-list" style="gap:0">
      <div class="tm-info-item" style="padding:0"><b>1.</b> Share your personal invite link</div>
      <div class="tm-info-item" style="padding:0"><b>2.</b> Your friend signs up and tops up their balance</div>
      <div class="tm-info-item" style="padding:0"><b>3.</b> You receive <b>15%</b> of their top-up as a bonus</div>
    </div>
  `;

  document.getElementById('referral-link-text').textContent = refLink;

  const shareText = encodeURIComponent('Build Telegram Mini Apps without code!\nJust describe your idea and Apps Father turns it into a real app.\nTry it now:');
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${shareText}`;

  document.getElementById('btn-copy-referral').onclick = () => {
    navigator.clipboard.writeText(refLink).then(() => {
      const btn = document.getElementById('btn-copy-referral');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    });
  };

  document.getElementById('btn-share-referral').onclick = () => {
    tg?.openTelegramLink(shareUrl);
  };

  showView('referral');
}

// ── Help ──

async function openReleaseNotes() {
  const container = document.getElementById('release-notes-content');
  container.innerHTML = '<div class="loading-spinner"></div>';
  showView('release-notes');
  try {
    const res = await fetch('release-notes.json');
    const notes = await res.json();
    let html = '';
    for (const v of notes) {
      const date = new Date(v.date).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
      html += `<div class="rn-version">`;
      html += `<div class="rn-version-header"><span class="rn-version-badge">${v.version}</span><span class="rn-version-date">${date}</span></div>`;
      if (v.title) html += `<div class="rn-version-title">${v.title}</div>`;
      for (const s of v.sections) {
        html += `<div class="rn-section"><div class="rn-section-label">${s.label}</div><div class="rn-items">`;
        for (const item of s.items) {
          html += `<div class="rn-item">${item}</div>`;
        }
        html += `</div></div>`;
      }
      html += `</div>`;
    }
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = '<p style="padding:16px;opacity:0.5;">Failed to load release notes.</p>';
  }
}

function openHelp() {
  document.getElementById('help-content').innerHTML = `
    <div class="tm-info-heading">How it works</div>
    <div class="tm-info-list" style="gap:0">
      <div class="tm-info-item" style="padding:0"><b>1.</b> Create a new project</div>
      <div class="tm-info-item" style="padding:0"><b>2.</b> A new bot will be created for your app</div>
      <div class="tm-info-item" style="padding:0"><b>3.</b> Describe what your app should do</div>
      <div class="tm-info-item" style="padding:0"><b>4.</b> I'll generate a plan for you to review</div>
      <div class="tm-info-item" style="padding:0"><b>5.</b> Approve the plan and I'll build the app</div>
      <div class="tm-info-item" style="padding:0"><b>6.</b> Test your app via the bot's Launch button</div>
      <div class="tm-info-item" style="padding:0"><b>7.</b> Request updates and improvements anytime</div>
    </div>
    <div class="tm-info-heading">Features</div>
    <div class="tm-info-list" style="gap:0">
      <div class="tm-info-item" style="padding:0">AI-generated Mini Apps with database & backend</div>
      <div class="tm-info-item" style="padding:0">Send images to use as design references</div>
      <div class="tm-info-item" style="padding:0">AI-powered improvement suggestions</div>
      <div class="tm-info-item" style="padding:0">Version management & releases</div>
      <div class="tm-info-item" style="padding:0">Admin analytics panel for each project</div>
    </div>
  `;

  document.getElementById('btn-help-guide').onclick = () => {
    tg?.openLink('https://cooperative-postbox-f64.notion.site/Apps-Father-User-Guide-33bb63eb0f25800688fde83c353b5891?source=copy_link');
  };
  document.getElementById('btn-help-promo').onclick = () => {
    tg?.openLink('https://cooperative-postbox-f64.notion.site/Apps-Father-Promo-33bb63eb0f258090bff4e63cffd8e1ae?source=copy_link');
  };
  document.getElementById('btn-help-channel').onclick = () => {
    tg?.openTelegramLink('https://t.me/apps_father');
  };
  document.getElementById('btn-help-community').onclick = () => {
    tg?.openTelegramLink('https://t.me/+of-sS1zbZHBmMDJi');
  };

  showView('help');
}

function initEditPhoto() {
  document.getElementById('btn-set-photo').addEventListener('click', () => {
    document.getElementById('edit-photo-input').click();
  });

  document.getElementById('edit-photo-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    editPhotoFile = file;
    const url = URL.createObjectURL(file);
    const avatarEl = document.getElementById('edit-avatar');
    avatarEl.textContent = '';
    avatarEl.style.backgroundImage = `url(${url})`;
    avatarEl.style.backgroundSize = 'cover';
    avatarEl.style.backgroundPosition = 'center';
  });
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
          showToast('Token revoked. Generate a new one via @BotFather.', 'success');
        } else {
          showToast('Failed: ' + (r.description || 'unknown error'), 'error');
        }
      } catch (err) {
        showToast('Error: ' + err.message, 'error');
      }
    });
  });
}

// ── Navigation ──

// ── Versions ──

let versionsData = [];

async function openVersions(projectId) {
  try {
    const res = await fetch(`${API_BASE}/versions/${projectId}`, { headers: apiHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    versionsData = data.versions || [];

    const subtitle = document.getElementById('versions-subtitle');
    if (data.releaseCommit !== null && data.releaseCommit !== undefined) {
      subtitle.textContent = `Released: Version #${data.releaseCommit}`;
    } else {
      subtitle.textContent = 'No version released yet';
    }

    const listEl = document.getElementById('versions-list');
    if (versionsData.length === 0) {
      listEl.innerHTML = '<div class="tm-row-container tm-row-results-empty"><b>No versions yet</b><div>Updates will appear here as versions.</div></div>';
    } else {
      let html = '';
      for (const v of versionsData) {
        const label = v.changelog ? v.changelog.substring(0, 60) + (v.changelog.length > 60 ? '...' : '') : 'No description';
        const date = new Date(v.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        const badge = v.isReleased ? '<span class="version-badge version-badge--released">LIVE</span>' : '';
        html += `<a class="tm-row tm-row-link" data-version="${v.version}">` +
          `<span class="tm-icon af-icon-commit"></span>` +
          `<div style="flex:1;min-width:0;"><div class="tm-row-value">#${v.version}${badge}</div>` +
          `<div class="tm-row-description">${esc(label)}</div>` +
          `<div class="tm-row-description" style="font-size:11px;opacity:0.5;">${date}</div></div>` +
          `</a>`;
      }
      listEl.innerHTML = html;

      listEl.querySelectorAll('.tm-row-link').forEach(row => {
        row.addEventListener('click', () => openVersionDetail(parseInt(row.dataset.version, 10)));
      });
    }

    showView('versions');
  } catch (err) {
    console.error('Failed to load versions:', err);
  }
}

function openVersionDetail(versionNum) {
  const v = versionsData.find(ver => ver.version === versionNum);
  if (!v) return;

  document.getElementById('version-detail-title').textContent = `Version #${v.version}`;

  const date = new Date(v.createdAt).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  document.getElementById('version-detail-date').textContent = date;

  const changelogEl = document.getElementById('version-detail-changelog');
  changelogEl.innerHTML = v.changelog ? formatContent(v.changelog) : '<span style="opacity:0.5">No changelog available</span>';

  const actionsEl = document.getElementById('version-detail-actions');
  let actionsHtml = '';

  if (!v.isReleased) {
    actionsHtml += `<a class="tm-row tm-row-link" id="btn-release-version"><span class="tm-icon af-icon-release"></span><span>Release this Version</span></a>`;
    actionsHtml += `<a class="tm-row tm-row-link" id="btn-revert-version"><span class="tm-icon af-icon-revert"></span><span>Revert to this Version</span></a>`;
  } else {
    actionsHtml += `<a class="tm-row tm-row-link" style="opacity:0.5;pointer-events:none;"><span class="tm-icon af-icon-release"></span><span>Currently Released</span></a>`;
  }

  if (v.changelogUrl) {
    actionsHtml += `<a class="tm-row tm-row-link" id="btn-changelog-link"><span class="tm-icon af-icon-changelog"></span><span>Change Log</span></a>`;
  }

  if (v.hasLog) {
    actionsHtml += `<a class="tm-row tm-row-link" id="btn-download-log"><span class="tm-icon af-icon-download"></span><span>Download Log</span></a>`;
  }

  actionsEl.innerHTML = actionsHtml;

  document.getElementById('btn-release-version')?.addEventListener('click', async () => {
    if (!currentProject) return;
    tg?.showConfirm(`Release Version #${v.version}? This will make it live.`, async (ok) => {
      if (!ok) return;
      try {
        const res = await fetch(`${API_BASE}/versions/${currentProject.id}/release`, {
          method: 'POST',
          headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: v.version }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast(`Version #${v.version} released!`, 'success');
        openVersions(currentProject.id);
      } catch (err) {
        console.error('Release error:', err);
        showToast('Failed to release version.', 'error');
      }
    });
  });

  document.getElementById('btn-revert-version')?.addEventListener('click', async () => {
    if (!currentProject) return;
    tg?.showConfirm(`Revert to Version #${v.version}? All newer versions will be deleted.`, async (ok) => {
      if (!ok) return;
      try {
        const res = await fetch(`${API_BASE}/versions/${currentProject.id}/revert`, {
          method: 'POST',
          headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ version: v.version }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        showToast(`Reverted to Version #${v.version}`, 'success');
        openVersions(currentProject.id);
      } catch (err) {
        console.error('Revert error:', err);
        showToast('Failed to revert.', 'error');
      }
    });
  });

  document.getElementById('btn-changelog-link')?.addEventListener('click', () => {
    tg?.openLink(v.changelogUrl, { try_instant_view: true });
  });

  document.getElementById('btn-download-log')?.addEventListener('click', async () => {
    if (!currentProject) return;
    try {
      const res = await fetch(`${API_BASE}/versions/${currentProject.id}/log/${v.version}`, { headers: apiHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `update-${v.version}.log`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download log error:', err);
      showToast('Failed to download log.', 'error');
    }
  });

  showView('version-detail');
}

// ── Features ──

async function openFeatures(projectId) {
  try {
    const res = await fetch(`${API_BASE}/features/${projectId}`, { headers: apiHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    document.getElementById('features-balance').textContent = `Balance: $${Number(data.balance).toFixed(2)}`;

    const listEl = document.getElementById('features-list');
    let html = '';
    for (const f of data.features) {
      const statusText = f.owned
        ? '<span class="feature-status feature-status--owned">Unlocked</span>'
        : `<span class="feature-status feature-status--price">$${f.price}</span>`;
      html += `<a style="padding: 14px 14px;" class="tm-row tm-row-link feature-row${f.owned ? ' feature-row--owned' : ''}" data-feature="${f.id}" data-price="${f.price}" data-label="${esc(f.label)}" data-owned="${f.owned}">` +
        `<div style="flex:1;min-width:0;">` +
        `<div class="tm-row-value">${esc(f.label)} — ${statusText}</div>` +
        `<div class="tm-row-description">${esc(f.description)}</div>` +
        `</div></a>`;
    }
    listEl.innerHTML = `<div class="tm-table-wrap">${html}</div>`;

    listEl.querySelectorAll('.feature-row').forEach(row => {
      if (row.dataset.owned === 'true') return;
      row.addEventListener('click', () => {
        const featureId = row.dataset.feature;
        const price = row.dataset.price;
        const label = row.dataset.label;
        tg?.showConfirm(`Unlock "${label}" for $${price}?`, async (ok) => {
          if (!ok) return;
          try {
            const r = await fetch(`${API_BASE}/features/${projectId}/buy`, {
              method: 'POST',
              headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
              body: JSON.stringify({ featureId }),
            });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || 'Purchase failed');
            showToast(`${label} unlocked!`, 'success');
            if (currentProject) {
              const owned = JSON.parse(currentProject.features || '[]');
              owned.push(featureId);
              currentProject.features = JSON.stringify(owned);
              const p = projects.find(pp => pp.id === projectId);
              if (p) p.features = currentProject.features;
            }
            openFeatures(projectId);
          } catch (err) {
            console.error('Purchase error:', err);
            showToast(err.message || 'Failed to purchase.', 'error');
          }
        });
      });
    });

    showView('features');
  } catch (err) {
    console.error('Failed to load features:', err);
    showToast('Failed to load features.', 'error');
  }
}

// ── Quality Tier ──

const QUALITY_TIERS = [
  { tier: 1, name: 'Good (Sonnet)', model: 'Sonnet 4.6, 60 iterations', desc: 'Regular pricing' },
  { tier: 2, name: 'Better (Sonnet+)', model: 'Sonnet 4.6+, 100 iterations', desc: '+~50% pricing' },
  { tier: 3, name: 'Best (Opus)', model: 'Opus 4.6, 60 iterations', desc: '+~75% pricing' },
  { tier: 4, name: 'The Best (Opus+)', model: 'Opus 4.6+, 100 iterations', desc: '+~100% pricing' },
];

function openQuality(projectId) {
  const currentTier = currentProject?.qualityTier || 1;
  const listEl = document.getElementById('quality-tier-list');

  let html = '';
  for (const t of QUALITY_TIERS) {
    const isActive = t.tier === currentTier;
    html += `<a class="tm-row tm-row-link quality-tier-row" data-tier="${t.tier}">` +
      `<span class="select-radio${isActive ? ' select-radio--active' : ''}"></span>` +
      `<div style="flex:1;min-width:0;">` +
      `<div class="tm-row-value">${esc(t.name)} — <span class="tm-row-hint">${esc(t.desc)}</span></div>` +
      `<div class="tm-row-description">${esc(t.model)}</div>` +
      `</div></a>`;
  }
  listEl.innerHTML = html;

  listEl.querySelectorAll('.quality-tier-row').forEach(row => {
    row.addEventListener('click', async () => {
      const tier = parseInt(row.dataset.tier, 10);
      if (tier === currentTier) return;
      try {
        const res = await fetch(`${API_BASE}/quality/${projectId}`, {
          method: 'POST',
          headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ tier }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        currentProject.qualityTier = tier;
        const p = projects.find(pp => pp.id === projectId);
        if (p) p.qualityTier = tier;
        openQuality(projectId);
      } catch (err) {
        console.error('Quality tier error:', err);
        showToast('Failed to update quality tier.', 'error');
      }
    });
  });

  showView('quality');
}

// ═══ ADMIN PANEL ═══

let isAdmin = false;
let admTab = 'dashboard';
let admChatReturn = false;

async function checkAdmin() {
  try {
    const res = await fetch(`${API_BASE}/admin/check`, { headers: apiHeaders() });
    const data = await res.json();
    isAdmin = data.isAdmin === true;
    const btn = document.getElementById('btn-admin');
    if (btn) btn.classList.toggle('hidden', !isAdmin);
  } catch {}
}

function admApi(path, opts = {}) {
  return fetch(`${API_BASE}/admin${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...apiHeaders(), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  }).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

function admFmtDate(d) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function admFmtMoney(n) { return '$' + Number(n).toFixed(2); }
function admFmtTokens(n) { return n > 999999 ? (n/1000000).toFixed(1)+'M' : n > 999 ? (n/1000).toFixed(0)+'K' : String(n); }
function admBadge(status) { return `<span class="adm-badge ${status}">${status}</span>`; }

function openAdmin() {
  admTab = 'dashboard';
  showView('admin');
  initAdmTabs();
  loadAdmTab('dashboard');
}

function initAdmTabs() {
  document.querySelectorAll('.adm-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.adm-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      admTab = tab.dataset.tab;
      loadAdmTab(admTab);
    });
  });
}

function loadAdmTab(tab) {
  const el = document.getElementById('adm-content');
  el.innerHTML = '<div class="loading-spinner"></div>';
  switch (tab) {
    case 'dashboard': loadAdmDashboard(el); break;
    case 'users': loadAdmUsers(el); break;
    case 'projects': loadAdmProjects(el); break;
    case 'vouchers': loadAdmVouchers(el); break;
    case 'config': loadAdmConfig(el); break;
  }
}

async function loadAdmDashboard(el) {
  try {
    const d = await admApi('/stats');
    let html = `<div class="adm-stats">
      <div class="adm-stat-card"><div class="adm-stat-label">Users</div><div class="adm-stat-value blue">${d.userCount}</div></div>
      <div class="adm-stat-card"><div class="adm-stat-label">Projects</div><div class="adm-stat-value">${d.projectCount}</div></div>
      <div class="adm-stat-card"><div class="adm-stat-label">Revenue</div><div class="adm-stat-value green">${admFmtMoney(d.totalTopups)}</div></div>
      <div class="adm-stat-card"><div class="adm-stat-label">Spent</div><div class="adm-stat-value yellow">${admFmtMoney(d.totalSpent)}</div></div>
    </div>`;
    html += `<div class="adm-section-title">Recent Activity</div>`;
    if (!d.recentUsage.length) {
      html += `<div class="adm-empty">No activity yet</div>`;
    } else {
      html += `<div class="adm-table-scroll"><table class="adm-table"><thead><tr><th>User</th><th>Project</th><th>Op</th><th>Cost</th></tr></thead><tbody>`;
      for (const u of d.recentUsage) {
        html += `<tr><td>${esc(u.username)}</td><td>${esc(u.project)}</td><td>${u.operation}</td><td>${admFmtMoney(u.cost)}</td></tr>`;
      }
      html += `</tbody></table></div>`;
    }
    el.innerHTML = html;
  } catch (err) { el.innerHTML = `<div class="adm-empty">Failed to load: ${esc(err.message)}</div>`; }
}

async function loadAdmUsers(el) {
  try {
    const users = await admApi('/users');
    if (!users.length) { el.innerHTML = '<div class="adm-empty">No users yet</div>'; return; }
    let html = `<div class="tm-table-wrap">`;
    for (const u of users) {
      html += `<div class="adm-row" data-user-id="${u.id}">
        <div class="adm-row-main">
          <div class="adm-row-title">${esc(u.username || u.firstName || 'User ' + u.id)}</div>
          <div class="adm-row-sub">${u.projectCount} app${u.projectCount !== 1 ? 's' : ''} · Joined ${admFmtDate(u.createdAt)}</div>
        </div>
        <div class="adm-row-right"><div class="adm-row-value">${admFmtMoney(u.balance)}</div></div>
        <div class="adm-row-chevron">›</div>
      </div>`;
    }
    html += `</div>`;
    el.innerHTML = html;
    el.querySelectorAll('[data-user-id]').forEach(row => {
      row.addEventListener('click', () => openAdmUserDetail(row.dataset.userId));
    });
  } catch (err) { el.innerHTML = `<div class="adm-empty">Failed to load users: ${esc(String(err))}</div>`; }
}

async function openAdmUserDetail(userId) {
  showView('admin-user');
  const nameEl = document.getElementById('adm-user-name');
  const subEl = document.getElementById('adm-user-sub');
  const contentEl = document.getElementById('adm-user-content');
  nameEl.textContent = 'Loading...';
  subEl.textContent = '';
  contentEl.innerHTML = '<div class="loading-spinner"></div>';

  try {
    const u = await admApi('/users/' + userId);
    nameEl.textContent = u.username || u.firstName || 'User ' + u.id;
    subEl.textContent = 'Telegram ID: ' + u.telegramId;

    let html = `<div class="adm-info-grid">
      <div class="adm-info-card"><div class="lbl">Balance</div><div class="val" id="adm-bal-val">${admFmtMoney(u.balance)}</div></div>
      <div class="adm-info-card"><div class="lbl">Total Spent</div><div class="val">${admFmtMoney(u.totalSpent)}</div></div>
      <div class="adm-info-card"><div class="lbl">Projects</div><div class="val">${u.projects.length}</div></div>
      <div class="adm-info-card"><div class="lbl">Slots</div><div class="val">${u.appSlots}</div></div>
    </div>`;

    if (u.referredBy) {
      html += `<div class="adm-section-title">Referred By</div>
        <div style="padding:0 16px;font-size:13px;color:rgba(255,255,255,0.6);margin-bottom:8px;">${u.referredBy}</div>`;
    }

    html += `<div class="adm-section-title">Balance Management</div>
      <div class="adm-inline-form">
        <select id="adm-bal-action"><option value="set">Set to</option><option value="add">Add</option></select>
        <input type="number" id="adm-bal-amount" placeholder="Amount" step="0.01" style="width:100px">
        <button class="adm-btn adm-btn-primary" id="adm-bal-btn">Apply</button>
      </div>`;

    if (u.projects.length) {
      html += `<div class="adm-section-title">Projects</div><div class="tm-table-wrap" style="">`;
      for (const p of u.projects) {
        html += `<div class="adm-row" data-proj-id="${p.id}">
          <div class="adm-row-main">
            <div class="adm-row-title">${esc(p.name)}</div>
            <div class="adm-row-sub">${p.botUsername ? '@' + esc(p.botUsername) : 'No bot'}</div>
          </div>
          <div class="adm-row-right">${admBadge(p.status)}</div>
          <div class="adm-row-chevron">›</div>
        </div>`;
      }
      html += `</div>`;
    }

    if (u.payments.length) {
      html += `<div class="adm-section-title">Payments</div>
        <div class="adm-table-scroll"><table class="adm-table"><thead><tr><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>`;
      for (const p of u.payments) {
        html += `<tr><td>${admFmtMoney(p.amount)}</td><td>${admBadge(p.status)}</td><td>${admFmtDate(p.createdAt)}</td></tr>`;
      }
      html += `</tbody></table></div>`;
    }

    if (u.usageLogs.length) {
      html += `<div class="adm-section-title">Usage History</div>
        <div class="adm-table-scroll"><table class="adm-table"><thead><tr><th>Project</th><th>Op</th><th>Cost</th><th>Date</th></tr></thead><tbody>`;
      for (const l of u.usageLogs) {
        html += `<tr><td>${esc(l.project)}</td><td>${l.operation}</td><td>${admFmtMoney(l.cost)}</td><td>${admFmtDate(l.createdAt)}</td></tr>`;
      }
      html += `</tbody></table></div>`;
    }

    contentEl.innerHTML = html;

    document.getElementById('adm-bal-btn')?.addEventListener('click', async () => {
      const action = document.getElementById('adm-bal-action').value;
      const amount = document.getElementById('adm-bal-amount').value;
      try {
        const d = await admApi('/users/' + userId + '/balance', { method: 'POST', body: { action, amount } });
        document.getElementById('adm-bal-val').textContent = admFmtMoney(d.balance);
        document.getElementById('adm-bal-amount').value = '';
        showToast('Balance updated to ' + admFmtMoney(d.balance), 'success');
      } catch { showToast('Failed to update balance', 'error'); }
    });

    contentEl.querySelectorAll('[data-proj-id]').forEach(row => {
      row.addEventListener('click', () => {
        openAdmProjectChat(row.dataset.projId);
      });
    });
  } catch (err) { contentEl.innerHTML = `<div class="adm-empty">Failed to load user: ${esc(String(err))}</div>`; }
}

async function openAdmProjectChat(projectId) {
  try {
    const p = await admApi('/projects/' + projectId);
    currentProject = {
      id: p.id, name: p.name, status: p.status, description: p.description,
      botUsername: p.botUsername, totalCostUsd: p.totalCost, userId: p.userId,
    };
    admChatReturn = true;
    openChat(projectId);
  } catch { showToast('Failed to open project', 'error'); }
}

async function loadAdmProjects(el) {
  try {
    const allProjects = await admApi('/projects');
    if (!allProjects.length) { el.innerHTML = '<div class="adm-empty">No projects yet</div>'; return; }
    let html = `<div class="tm-table-wrap">`;
    for (const p of allProjects) {
      const avatarSrc = avatarSvgDataUri(p.name);
      const username = p.botUsername ? `@${esc(p.botUsername)}` : '';
      const statusDot = p.status === 'building'
        ? '<span class="loader" style="width:16px;height:16px;margin-right:8px"></span>'
        : `<span class="tm-status-dot ${p.status}"></span>`;
      html += `<a class="tm-row tm-row-link" data-proj-id="${p.id}" style="align-items:center;">` +
        `<img class="tm-row-pic tm-row-pic-user" src="${avatarSrc}">` +
        `<div style="flex:1;min-width:0;overflow:hidden;"><div class="tm-row-value" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.name)}</div>` +
        `<div class="tm-row-description" style="white-space:nowrap;">${username}</div></div>` +
        `<div class="tm-row-status">${statusDot}${statusLabel(p.status)}</div>` +
        `</a>`;
    }
    html += `</div>`;
    el.innerHTML = html;
    el.querySelectorAll('[data-proj-id]').forEach(row => {
      row.addEventListener('click', () => openAdmProjectChat(row.dataset.projId));
    });
  } catch (err) { el.innerHTML = `<div class="adm-empty">Failed to load projects: ${esc(String(err))}</div>`; }
}

async function loadAdmVouchers(el) {
  try {
    const vouchers = await admApi('/vouchers');
    let html = `<div class="adm-section-title">Create Voucher</div>
      <div class="adm-inline-form">
        <input type="number" id="adm-v-amount" placeholder="Amount ($)" step="0.01" style="width:100px">
        <input type="number" id="adm-v-max" placeholder="Max uses" value="1" step="1" style="width:80px">
        <button class="adm-btn adm-btn-primary" id="adm-v-create">Create</button>
      </div>
      <div class="adm-section-title">All Vouchers</div>`;

    if (!vouchers.length) {
      html += `<div class="adm-empty">No vouchers yet</div>`;
    } else {
      html += `<div class="tm-table-wrap">`;
      for (const v of vouchers) {
        html += `<div class="adm-row" style="cursor:default;">
          <div class="adm-row-main">
            <div class="adm-row-title"><span class="adm-voucher-code">${esc(v.code)}</span> · ${admFmtMoney(v.amountUsd)}</div>
            <div class="adm-row-sub">${v.usedCount}/${v.maxUses} used · ${admFmtDate(v.createdAt)}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            ${admBadge(v.active ? 'active' : 'inactive')}
            <button class="adm-btn" data-toggle-v="${v.id}" data-active="${v.active}" style="font-size:11px;padding:4px 10px;">${v.active ? 'Off' : 'On'}</button>
            <button class="adm-btn adm-btn-danger" data-del-v="${v.id}" style="font-size:11px;padding:4px 10px;">Del</button>
            <button class="adm-btn" data-copy-link="${esc(v.link)}" style="font-size:11px;padding:4px 10px;">Link</button>
          </div>
        </div>`;
      }
      html += `</div>`;
    }
    el.innerHTML = html;

    document.getElementById('adm-v-create')?.addEventListener('click', async () => {
      const amount = document.getElementById('adm-v-amount').value;
      const maxUses = document.getElementById('adm-v-max').value || '1';
      if (!amount || parseFloat(amount) <= 0) { showToast('Enter a valid amount', 'error'); return; }
      try {
        const v = await admApi('/vouchers', { method: 'POST', body: { amount, maxUses } });
        showToast('Voucher created: ' + v.code, 'success');
        loadAdmTab('vouchers');
      } catch { showToast('Failed to create', 'error'); }
    });

    el.querySelectorAll('[data-toggle-v]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newActive = btn.dataset.active === 'true' ? false : true;
        await admApi('/vouchers/' + btn.dataset.toggleV, { method: 'PUT', body: { active: newActive } });
        showToast(newActive ? 'Voucher enabled' : 'Voucher disabled', 'success');
        loadAdmTab('vouchers');
      });
    });

    el.querySelectorAll('[data-del-v]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await admApi('/vouchers/' + btn.dataset.delV, { method: 'DELETE' });
          showToast('Voucher deleted', 'success');
          loadAdmTab('vouchers');
        } catch { showToast('Failed to delete', 'error'); }
      });
    });

    el.querySelectorAll('[data-copy-link]').forEach(btn => {
      btn.addEventListener('click', () => {
        navigator.clipboard.writeText(btn.dataset.copyLink).then(() => showToast('Link copied', 'success')).catch(() => showToast('Copy failed', 'error'));
      });
    });
  } catch (err) { el.innerHTML = `<div class="adm-empty">Failed to load vouchers: ${esc(String(err))}</div>`; }
}

async function loadAdmConfig(el) {
  try {
    const cfg = await admApi('/config');
    el.innerHTML = `
      <div>
        <div class="adm-config-row">
          <div><div class="adm-config-label">Markup Multiplier</div><div class="adm-config-desc">Applied on top of base rates</div></div>
          <input type="number" id="adm-cfg-markup" value="${cfg.markupMultiplier}" step="0.5">
        </div>
        <div class="adm-config-row">
          <div><div class="adm-config-label">Min Top-up</div><div class="adm-config-desc">Minimum USD amount</div></div>
          <input type="number" id="adm-cfg-topup" value="${cfg.minTopup}" step="1">
        </div>
        <div class="adm-config-row">
          <div><div class="adm-config-label">Max Agent Iterations</div><div class="adm-config-desc">Tool calls per run</div></div>
          <input type="number" id="adm-cfg-iter" value="${cfg.maxAgentIterations}" step="1">
        </div>
        <div style="margin-top:16px;">
          <button class="adm-btn adm-btn-primary" id="adm-cfg-save" style="width:100%;">Save Configuration</button>
        </div>
      </div>`;
    document.getElementById('adm-cfg-save').addEventListener('click', async () => {
      const data = {
        markupMultiplier: parseFloat(document.getElementById('adm-cfg-markup').value),
        minTopup: parseFloat(document.getElementById('adm-cfg-topup').value),
        maxAgentIterations: parseInt(document.getElementById('adm-cfg-iter').value),
      };
      try {
        await admApi('/config', { method: 'POST', body: data });
        showToast('Configuration saved', 'success');
      } catch { showToast('Failed to save', 'error'); }
    });
  } catch (err) { el.innerHTML = `<div class="adm-empty">Failed to load config</div>`; }
}

function showView(view) {
  currentView = view;
  document.body.classList.toggle('scroll-lock', view === 'chat');
  if (view === 'list') loadProjects();
  document.getElementById('view-list').classList.toggle('hidden', view !== 'list');
  document.getElementById('view-detail').classList.toggle('hidden', view !== 'detail');
  document.getElementById('view-edit-info').classList.toggle('hidden', view !== 'edit-info');
  document.getElementById('view-transfer').classList.toggle('hidden', view !== 'transfer');
  document.getElementById('view-delete').classList.toggle('hidden', view !== 'delete');
  document.getElementById('view-referral').classList.toggle('hidden', view !== 'referral');
  document.getElementById('view-help').classList.toggle('hidden', view !== 'help');
  document.getElementById('view-release-notes').classList.toggle('hidden', view !== 'release-notes');
  document.getElementById('view-admin').classList.toggle('hidden', view !== 'admin');
  document.getElementById('view-admin-user').classList.toggle('hidden', view !== 'admin-user');
  document.getElementById('view-versions').classList.toggle('hidden', view !== 'versions');
  document.getElementById('view-version-detail').classList.toggle('hidden', view !== 'version-detail');
  document.getElementById('view-quality').classList.toggle('hidden', view !== 'quality');
  document.getElementById('view-features').classList.toggle('hidden', view !== 'features');
  document.getElementById('view-slots-full').classList.toggle('hidden', view !== 'slots-full');
  document.getElementById('view-topup').classList.toggle('hidden', view !== 'topup');

  const headerDropdown = document.getElementById('chat-header-dropdown');
  if (headerDropdown) headerDropdown.classList.add('hidden');

  const chatEl = document.getElementById('view-chat');
  if (chatEl) chatEl.classList.toggle('hidden', view !== 'chat');

  if (tg) {
    if (view === 'chat') {
      tg.setHeaderColor('#000000');
      tg.setBackgroundColor('#000000');
      tg.setBottomBarColor('#000000');
    } else {
      tg.setHeaderColor('#000000');
      tg.setBackgroundColor('#000000');
      tg.setBottomBarColor('#000000');
    }
  }

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
      tg.MainButton.color = tg.themeParams?.button_color || '#3390ec';
      tg.MainButton.textColor = tg.themeParams?.button_text_color || '#ffffff';
      tg.MainButton.show();
    } else if (view === 'transfer') {
      tg.MainButton.setText('Transfer');
      tg.MainButton.color = tg.themeParams?.button_color || '#3390ec';
      tg.MainButton.textColor = tg.themeParams?.button_text_color || '#ffffff';
      tg.MainButton.show();
    } else if (view === 'delete') {
      tg.MainButton.setText('Delete App');
      tg.MainButton.color = '#e53935';
      tg.MainButton.textColor = '#ffffff';
      tg.MainButton.show();
    } else if (view === 'slots-full') {
      tg.MainButton.setText('Buy App Slot — $25');
      tg.MainButton.color = tg.themeParams?.button_color || '#3390ec';
      tg.MainButton.textColor = tg.themeParams?.button_text_color || '#ffffff';
      tg.MainButton.show();
    } else if (view === 'topup') {
      updateTopupButton();
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
    const data = await res.json();
    projects = data.projects || data;
    slots = data.slots || { used: projects.length, total: 1 };
    renderAppList();
    loadTopupBalance();
    loadSamples();
  } catch (err) {
    console.error('Failed to load projects:', err);
    document.getElementById('app-list').innerHTML =
      `<div class="tm-row-container tm-row-results-empty"><b>Failed to load apps</b><div>${esc(err.message)}</div></div>`;
  }
}

let samplesLoaded = false;
async function loadSamples() {
  if (samplesLoaded) return;
  try {
    const res = await fetch(`${API_BASE}/samples`);
    if (!res.ok) return;
    const data = await res.json();
    const list = document.getElementById('samples-list');
    if (!data.samples?.length) { list.closest('section')?.remove(); return; }
    let html = '';
    for (const s of data.samples) {
      const avatar = s.avatarUrl
        ? `<img class="tm-row-pic" src="${s.avatarUrl}" alt="">`
        : `<div class="tm-row-pic-placeholder">${s.name.charAt(0)}</div>`;
      html += `<a class="tm-row tm-row-link sample-row" data-id="${s.id}" data-name="${esc(s.name)}">
        ${avatar}
        <div class="tm-row-text">
          <div class="tm-row-value">${esc(s.name)}</div>
          <div class="tm-row-description">@${esc(s.botUsername)}</div>
        </div>
        <span class="tm-row-chevron">›</span>
      </a>`;
    }
    list.innerHTML = html;
    list.querySelectorAll('.sample-row').forEach(row => {
      row.addEventListener('click', () => openSamplePreview(row.dataset.id, row.dataset.name));
    });
    samplesLoaded = true;
  } catch (err) {
    console.error('Failed to load samples:', err);
  }
}

function openSamplePreview(projectId, name) {
  const hash = location.hash || '';
  const tgData = hash.includes('tgWebAppData') ? hash : '';
  const url = `${location.origin}/app/${projectId}/${tgData}`;

  let overlay = document.getElementById('test-preview-overlay');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'test-preview-overlay';
  overlay.className = 'test-preview-overlay';
  overlay.innerHTML = `
    <div class="test-preview-header">
      <button class="test-preview-back" onclick="closeTestPreview()">← Back</button>
      <span class="test-preview-title">${esc(name || 'Sample')}</span>
      <span class="test-preview-badge" style="background:#34c759">SAMPLE</span>
    </div>
    <iframe class="test-preview-iframe" src="${url}"></iframe>
  `;
  document.body.appendChild(overlay);
}

const chatPlaceholders = {
  update: 'Describe your update...',
  question: 'Ask about your app...',
  suggestion: 'Get improvement suggestions...',
};

function switchChatMode(mode) {
  chatMode = mode;
  document.querySelectorAll('.chat-pill').forEach(p => {
    p.classList.toggle('active', p.dataset.mode === mode);
  });

  const inputBar = document.querySelector('.chat-input-bar');
  const suggestBtn = document.getElementById('btn-get-suggestions');

  if (mode === 'suggestion') {
    inputBar.style.display = 'none';
    suggestBtn.classList.remove('hidden');
  } else {
    inputBar.style.display = '';
    suggestBtn.classList.add('hidden');
    const input = document.getElementById('chat-input');
    if (input) {
      input.placeholder = chatPlaceholders[mode] || chatPlaceholders.update;
      input.focus();
    }
  }
}

async function fetchSuggestions() {
  if (!chatProjectId) return;

  const btn = document.getElementById('btn-get-suggestions');
  btn.disabled = true;
  btn.textContent = 'Analyzing your app...';
  btn.classList.add('loading');

  const processingEl = document.createElement('div');
  processingEl.className = 'chat-bubble chat-bubble--assistant';
  processingEl.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
  processingEl.id = 'suggestions-processing';
  document.getElementById('chat-messages-inner').appendChild(processingEl);
  scrollToBottom();

  try {
    const res = await fetch(`${API_BASE}/chat/${chatProjectId}/suggestions`, {
      method: 'POST',
      headers: apiHeaders(),
    });
    const data = await res.json();

    const proc = document.getElementById('suggestions-processing');
    if (proc) proc.remove();

    if (data.suggestions && data.suggestions.length > 0) {
      const el = document.createElement('div');
      el.className = 'chat-bubble chat-bubble--assistant suggestions-result';
      let html = '<div class="suggestions-title">Here are some ideas for your next update:</div>';
      html += '<div class="suggestions-cards">';
      data.suggestions.forEach((s, i) => {
        html += `<button class="suggestion-card" data-index="${i}">
          <div class="suggestion-card-title">${esc(s.title)}</div>
          <div class="suggestion-card-desc">${esc(s.description)}</div>
        </button>`;
      });
      html += '</div>';
      el.innerHTML = html;
      document.getElementById('chat-messages-inner').appendChild(el);
      scrollToBottom();

      el.querySelectorAll('.suggestion-card').forEach(card => {
        card.addEventListener('click', () => {
          const idx = parseInt(card.dataset.index);
          const suggestion = data.suggestions[idx];
          selectSuggestion(suggestion, el);
        });
      });

    }
  } catch (err) {
    console.error('Failed to fetch suggestions:', err);
    const proc = document.getElementById('suggestions-processing');
    if (proc) proc.remove();
    const errEl = document.createElement('div');
    errEl.className = 'chat-bubble chat-bubble--assistant';
    errEl.innerHTML = `<div class="chat-bubble-text">Failed to get suggestions. Please try again.</div>`;
    document.getElementById('chat-messages-inner').appendChild(errEl);
    scrollToBottom();
  }

  btn.disabled = false;
  btn.textContent = 'Get Suggestions For Next Update';
  btn.classList.remove('loading');
}

function selectSuggestion(suggestion, cardsContainer) {
  cardsContainer.querySelectorAll('.suggestion-card').forEach(c => c.classList.remove('selected'));
  event.currentTarget.classList.add('selected');

  switchChatMode('update');
  const input = document.getElementById('chat-input');
  input.value = suggestion.title + ': ' + suggestion.description;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  document.getElementById('btn-send').classList.add('active');
  input.focus();
}

function initChatInput() {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('btn-send');
  const fileInput = document.getElementById('file-input');

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    sendBtn.classList.toggle('active', !!input.value.trim());
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.value.trim()) sendMessage();
    }
  });

  sendBtn.addEventListener('click', () => {
    if (sendBtn.classList.contains('active')) sendMessage();
  });

  document.getElementById('btn-attach').addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files || []);
    pendingFiles.push(...files);
    updateAttachPreview();
    if (pendingFiles.length > 0) uploadFiles(files);
    fileInput.value = '';
  });

  document.querySelectorAll('.chat-pill').forEach(pill => {
    pill.addEventListener('click', () => switchChatMode(pill.dataset.mode));
  });

  document.getElementById('btn-get-suggestions').addEventListener('click', () => fetchSuggestions());

  const inputArea = document.querySelector('.chat-input-area');
  inputArea.addEventListener('touchmove', (e) => {
    e.preventDefault();
  }, { passive: false });
}

function init() {
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, a, .tm-row, .chat-pill, .topup-amount-btn, .topup-method, .chat-plan-btn, .result-action-btn, .question-opt-btn, .feature-row, .quality-row');
    if (t) haptic('light');
  }, true);

  if (tg) {
    tg.ready();
    tg.setHeaderColor('#000000');
      tg.setBackgroundColor('#000000');
      tg.setBottomBarColor('#000000');
    tg.MainButton.setParams({ color: '#248BDA' });
    tg.disableVerticalSwipes();

    if (['android', 'ios'].includes(tg.platform)) {
      document.body.classList.add('mobile', 'platform-' + tg.platform);
      tg.requestFullscreen();
    }
  }

  if (tg?.BackButton) {
    tg.BackButton.onClick(() => {
      if (currentView === 'version-detail') {
        openVersions(currentProject.id);
      } else if (currentView === 'versions') {
        showView('detail');
      } else if (currentView === 'quality') {
        showView('detail');
      } else if (currentView === 'features') {
        showView('detail');
      } else if (currentView === 'edit-info') {
        showView('detail');
      } else if (currentView === 'transfer') {
        showView('detail');
      } else if (currentView === 'delete') {
        showView('detail');
      } else if (currentView === 'slots-full') {
        showView('list');
      } else if (currentView === 'topup') {
        showView(topupReturnView || 'list');
        topupReturnView = null;
      } else if (currentView === 'referral') {
        showView('list');
      } else if (currentView === 'help') {
        showView('list');
      } else if (currentView === 'release-notes') {
        showView('list');
      } else if (currentView === 'admin-user') {
        showView('admin');
        loadAdmTab('users');
        document.querySelectorAll('.adm-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'users'));
      } else if (currentView === 'admin') {
        showView('list');
      } else if (currentView === 'detail') {
        showView('chat');
      } else if (currentView === 'chat') {
        if (chatWs) { try { chatWs.close(); } catch {} chatWs = null; }
        chatProjectId = null;
        currentProject = null;
        currentToken = null;
        if (admChatReturn) {
          admChatReturn = false;
          openAdmin();
        } else {
          showView('list');
        }
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
      } else if (currentView === 'transfer') {
        submitTransfer();
      } else if (currentView === 'delete') {
        submitDelete();
      } else if (currentView === 'slots-full') {
        buySlot();
      } else if (currentView === 'topup') {
        submitTopup();
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

  document.getElementById('btn-chat-settings')?.addEventListener('click', () => {
    if (currentProject) openDetail(currentProject.id);
  });

  const headerInfo = document.getElementById('chat-header-info');
  const dropdown = document.getElementById('chat-header-dropdown');

  headerInfo?.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!dropdown.classList.contains('hidden') && !dropdown.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });

  document.getElementById('btn-dropdown-test')?.addEventListener('click', () => {
    dropdown.classList.add('hidden');
    if (chatProjectId) openTestPreview(chatProjectId);
  });

  document.getElementById('btn-dropdown-open-bot')?.addEventListener('click', () => {
    dropdown.classList.add('hidden');
    if (currentProject?.botUsername) {
      tg?.openTelegramLink(`https://t.me/${currentProject.botUsername}`);
    }
  });

  document.getElementById('btn-topup')?.addEventListener('click', () => openTopup('list'));
  document.getElementById('btn-referral-page').addEventListener('click', () => openReferral());
  document.getElementById('btn-release-notes-page').addEventListener('click', () => openReleaseNotes());
  document.getElementById('btn-help-page').addEventListener('click', () => openHelp());
  document.getElementById('btn-admin')?.addEventListener('click', () => openAdmin());

  checkAdmin();
  initTokenActions();
  initChatInput();
  initAutosize();
  initEditPhoto();
  initTopupEvents();
  loadBalance();
  loadProjects();
}

init();
