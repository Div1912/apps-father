'use strict';

const tg = window.Telegram?.WebApp;
const API_BASE = '/telegram-mini-app/api';

// ── Credits coin icon SVGs ──────────────────────────────────────────────────
const COIN_PATH = 'M129.743,95.01c-15.97-.027-35.976,5.02-55.714,15.292-19.706,10.273-35.326,23.73-44.495,36.873-9.174,13.1-11.654,25.3-7.141,34,4.517,8.658,15.938,13.637,31.948,13.637,16.01.045,36.017-5.024,55.709-15.252,19.738-10.273,35.348-23.775,44.5-36.873,9.2-13.1,11.618-25.3,7.132-34-4.531-8.658-15.925-13.677-31.939-13.677Zm41.225,31.531a60.545,60.545,0,0,1-9.779,20.769C151.051,161.8,134.5,175.93,113.774,186.7c-20.725,10.811-41.763,16.239-59.437,16.239a60.477,60.477,0,0,1-22.6-3.9l4.75,9.151c4.522,8.7,15.911,13.682,31.93,13.682s36.021-5.024,55.714-15.3c19.738-10.228,35.348-23.73,44.5-36.873,9.151-13.1,11.663-25.3,7.132-33.958Zm12.919,7.536c5.024,11.977.987,26.556-8.613,40.238-8.478,12.157-21.442,23.954-37.5,33.823a144.6,144.6,0,0,0,15.476.807c22.2,0,42.3-4.755,56.477-12.157,14.22-7.4,22.025-17.091,22.025-26.87s-7.805-19.468-22.025-26.87a103.163,103.163,0,0,0-25.838-8.972Zm47.864,55.983a61.176,61.176,0,0,1-18.257,13.906c-15.7,8.164-36.874,13.054-60.245,13.054a155.816,155.816,0,0,1-27.229-2.333A152.678,152.678,0,0,1,95.113,226.4c.538.314,1.077.583,1.66.9,14.175,7.4,34.272,12.157,56.477,12.157s42.3-4.755,56.477-12.157c14.22-7.4,22.025-17.091,22.025-26.87Z';
const COIN_VIEWBOX = '0 0 211.551 144.439';
const COIN_TRANSFORM = 'translate(-20.199 -95.01)';

/** Inline coin SVG — size in px, fill colour */
function coinSvg(w, h, fill) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${COIN_VIEWBOX}" fill="${fill || 'currentColor'}" style="vertical-align:middle;flex-shrink:0" aria-hidden="true"><path d="${COIN_PATH}" transform="${COIN_TRANSFORM}"/></svg>`;
}

// ── Analytics (OpenPanel) ──────────────────────────────────────────────────

// Reserved start_param values reserved for intra-app navigation. They must
// not be treated as utm_source. Keep in sync with src/services/analytics.service.ts
const RESERVED_START_PARAMS = new Set(['open_dialog']);

function parseStartParam(param) {
  if (!param) return { source: null, referrerId: null };
  if (RESERVED_START_PARAMS.has(param)) return { source: null, referrerId: null };
  if (param.includes('|')) {
    const [src, id] = param.split('|');
    return { source: src || null, referrerId: /^\d+$/.test(id || '') ? id : null };
  }
  if (/^\d+$/.test(param)) return { source: null, referrerId: param };
  return { source: param, referrerId: null };
}

// Resolve the start parameter from EVERY surface Telegram exposes it on:
//   1. tg.initDataUnsafe.start_param  — set when launched via deep link
//      (t.me/<bot>/<app>?startapp=xxx or tg://resolve?...&startapp=xxx)
//   2. window.location.search.startapp — set when launched via web_app
//      inline button whose URL carries ?startapp=xxx (e.g. the bot welcome
//      card "Create app" button). In that case Telegram does NOT populate
//      initDataUnsafe.start_param, so without this fallback we'd lose 100%
//      of attribution for users who arrive via the bot welcome flow.
// Sanitization matches Telegram's own startapp constraint: A-Z, a-z, 0-9,
// underscore, hyphen, max 64 chars. Anything else is dropped on the floor
// to avoid storing garbage that would never round-trip back through TG.
function getStartParam() {
  let raw = '';
  try { raw = tg?.initDataUnsafe?.start_param || ''; } catch (_) {}
  if (!raw) {
    try {
      raw = new URLSearchParams(window.location.search).get('startapp') || '';
    } catch (_) {}
  }
  // Android fallback: on some Telegram Android launch paths (inline
  // web_app button, deep link via custom tabs, after a task switch),
  // tg.initDataUnsafe.start_param is empty even when the SDK was given
  // the parameter. The raw value still lives in window.location.hash as
  // tgWebAppStartParam=xxx — that's literally where the SDK reads it from.
  // iOS doesn't need this; Android does. This is the missing piece behind
  // the "Android shows Direct, iOS shows the source" pattern.
  if (!raw) {
    try {
      const hash = (window.location.hash || '').replace(/^#/, '');
      const hp = new URLSearchParams(hash);
      raw = hp.get('tgWebAppStartParam') || '';
    } catch (_) {}
  }
  // Also probe the SDK's signed initData string directly — on Android it's
  // sometimes already populated in initData (URL-encoded form fields)
  // before initDataUnsafe.start_param has been parsed out of it.
  if (!raw) {
    try {
      const initStr = tg?.initData || '';
      if (initStr) {
        const sp = new URLSearchParams(initStr);
        raw = sp.get('start_param') || '';
      }
    } catch (_) {}
  }
  raw = (raw || '').trim();
  // Persist across reloads AND sessions. localStorage survives WebView
  // close/reopen (sessionStorage does not), which matters for users who
  // arrive from an ad and then reopen the Mini App later. Cache lookup
  // runs only when neither live source had a value.
  if (!raw) {
    try { raw = localStorage.getItem('af_start_param') || ''; } catch (_) {}
    if (!raw) {
      try { raw = sessionStorage.getItem('af_start_param') || ''; } catch (_) {}
    }
  }
  if (!raw) return '';
  try { sessionStorage.setItem('af_start_param', raw); } catch (_) {}
  try { localStorage.setItem('af_start_param', raw); } catch (_) {}
  return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
}

function initAnalytics() {
  const clientId = document.documentElement.dataset.opClientId;
  if (clientId && typeof window.op === 'function') {
    window.op('init', { clientId, trackScreenViews: false });

    const startParam = getStartParam();
    const { source } = parseStartParam(startParam);
    const user = tg?.initDataUnsafe?.user;
    if (user) {
      window.op('identify', {
        profileId: String(user.id),
        firstName: user.first_name,
        lastName: user.last_name,
        username: user.username,
        avatar: user.photo_url,
        properties: { ...(source ? { utm_source: source } : {}) },
      });
    }
  }
}

// /api/init MUST run before /api/projects, /api/balance, etc., so it wins
// the user-creation race on the backend and the start_param attribution
// (referrer / partner-tag / utm_source) actually gets persisted to the
// brand-new user record. We resolve as soon as the request completes
// (success or failure) so the rest of the boot sequence is never blocked.
// Returns { serviceMode, isAdmin } from the server response (or null on error).
async function reportInit() {
  if (!tg?.initData) return null;
  const startParam = getStartParam();
  try {
    const r = await fetch(`${API_BASE}/init`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ startParam }),
    });
    if (r.ok) return await r.json();
  } catch {}
  return null;
}

function showServicePage() {
  document.body.innerHTML = `
    <div style="
      min-height:100vh;display:flex;flex-direction:column;
      align-items:center;justify-content:center;
      background:var(--tg-theme-bg-color,#18181b);
      color:var(--tg-theme-text-color,#f4f4f5);
      padding:32px 24px;box-sizing:border-box;text-align:center;
      font-family:system-ui,-apple-system,sans-serif;
    ">
      <div style="font-size:56px;margin-bottom:20px;">🔧</div>
      <h1 style="font-size:22px;font-weight:700;margin:0 0 12px;line-height:1.3;">
        Apps Father is under maintenance
      </h1>
      <p style="font-size:15px;opacity:.75;margin:0 0 8px;max-width:300px;line-height:1.6;">
        Your apps are live and working fine.
      </p>
      <p style="font-size:15px;opacity:.75;margin:0 0 32px;max-width:300px;line-height:1.6;">
        Development and other update tools will be available soon — follow our socials for updates.
      </p>
      <a href="https://t.me/apps_father" target="_blank" style="
        display:inline-flex;align-items:center;gap:8px;
        background:var(--tg-theme-button-color,#5b5ef4);
        color:var(--tg-theme-button-text-color,#fff);
        border-radius:12px;padding:13px 28px;
        font-size:15px;font-weight:600;text-decoration:none;
      ">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.562 8.248-1.97 9.287c-.145.658-.537.818-1.084.508l-3-2.21-1.447 1.394c-.16.16-.295.295-.605.295l.213-3.053 5.56-5.023c.242-.213-.054-.333-.373-.12L7.26 14.4l-2.97-.924c-.645-.204-.657-.645.136-.955l11.57-4.461c.537-.194 1.006.131.566.188z"/></svg>
        Our Telegram Channel
      </a>
    </div>
  `;
}

let projects = [];
let slots = { used: 0, total: 5 };
let currentProject = null;
let currentToken = null;
let currentView = 'list';
let editOriginal = {};

// Chat state
let chatWs = null;
let chatMode = 'update'; // 'update' | 'question'
let chatProjectId = null;
let chatHasMessages = false;
let pendingFiles = [];
let isProcessing = false;
const processingProjectIds = new Set();

function setProcessing(active) {
  isProcessing = active;
  if (chatProjectId) {
    if (active) processingProjectIds.add(chatProjectId);
    else processingProjectIds.delete(chatProjectId);
  }
}

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
  const micBtn = document.getElementById('btn-mic');
  const suggestBtn = document.getElementById('btn-get-suggestions');
  if (input) input.disabled = disabled;
  if (sendBtn) sendBtn.disabled = disabled;
  if (attachBtn) attachBtn.disabled = disabled;
  if (micBtn) micBtn.disabled = disabled;
  if (suggestBtn) suggestBtn.disabled = disabled;
  const area = document.getElementById('chat-input-area');
  if (area) {
    area.style.display = disabled ? 'none' : '';
    area.classList.toggle('chat-input-disabled', disabled);
  }
}

function setInputFinalizing(active) {
  const area = document.getElementById('chat-input-area');
  const chatMessages = document.getElementById('chat-messages');
  let overlay = document.getElementById('input-finalizing');
  if (active) {
    if (area) area.style.display = 'none';
    if (!overlay && chatMessages) {
      overlay = document.createElement('div');
      overlay.id = 'input-finalizing';
      overlay.className = 'input-finalizing';
      overlay.innerHTML = `<span class="preparing-spinner"></span><span>${t('chat_finalizing') || 'Finalizing previous update, please wait...'}</span>`;
      chatMessages.parentNode.insertBefore(overlay, chatMessages);
    }
  } else {
    if (overlay) overlay.remove();
    if (area) area.style.display = '';
  }
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
  const parts = (name || '').trim().split(/\s+/);
  let raw;
  if (parts.length >= 2 && parts[0] && parts[1]) {
    raw = (parts[0][0] + parts[1][0]).toUpperCase();
  } else {
    raw = (name || '').substring(0, 2).toUpperCase();
  }
  // CRITICAL: every caller drops this result into an HTML template string
  // (avatar gradient div, admin user/project rows, etc.). If a user's
  // firstName starts with HTML-significant chars like <, >, &, ", ' the
  // raw initials break the parent <a> tag (browsers auto-close <a> when
  // they encounter another <a>, and stray < eats the next attributes),
  // so the row visibly collapses into just an avatar in the admin list.
  // Escape here so callers can stay terse.
  return raw.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

function avatarSvgDataUri(name) {
  const [c1, c2] = getGradient(name);
  const initials = getInitials(name).replace(/[<>&"']/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="100" height="100" fill="url(%23g)"/><text text-anchor="middle" x="50" y="66" fill="%23fff" font-size="44" font-weight="600" font-family="sans-serif">${initials}</text></svg>`;
  try { return 'data:image/svg+xml,' + encodeURIComponent(svg); }
  catch { return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 100 100"><rect width="100" height="100" fill="${c1}"/></svg>`); }
}

function userAvatarHtml(name, username) {
  const safeName = name || 'User';
  if (username) {
    // Telegram usernames are constrained to [A-Za-z0-9_], but strip
    // anything else just to be safe before injecting into the URL.
    const clean = String(username).replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '');
    const [g1, g2] = getGradient(safeName);
    return `<img class="tm-row-pic tm-row-pic-user" src="https://t.me/i/userpic/320/${clean}.svg" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" style="object-fit:cover;"><div class="tm-row-pic tm-row-pic-user avatar-gradient" style="display:none;background:linear-gradient(135deg,${g1},${g2})">${getInitials(safeName)}</div>`;
  }
  const [c1, c2] = getGradient(safeName);
  return `<div class="tm-row-pic tm-row-pic-user avatar-gradient" style="background:linear-gradient(135deg,${c1},${c2})">${getInitials(safeName)}</div>`;
}

function statusLabel(status) {
  return t('status_' + status) || status;
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
  // Attach the start_param to EVERY API request so the backend can attribute
  // the user atomically on the very first call that creates the row, not
  // only on /api/init. Without this, any other endpoint (loadProjects,
  // checkAdmin, loadBalance, ...) that races ahead creates the user as
  // Direct and the source-backfill arrives too late for the admin notify.
  try {
    const sp = getStartParam();
    if (sp) h['X-Apps-Father-Start-Param'] = sp;
  } catch (_) {}
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

var SimpleSpoiler = {
  random: function(x, y) {
    return x + Math.floor(Math.random() * (y + 1 - x));
  },
  generateVector: function(count) {
    var speedMax = 8, speedMin = 4, lifetime = 600;
    var value = SimpleSpoiler.random(0, 2 * count + 2);
    var negative = value < count + 1;
    var mod = negative ? value : value - count - 1;
    var speed = speedMin + ((speedMax - speedMin) * mod) / count;
    var max = Math.ceil(speedMax * lifetime);
    var k = speed / lifetime;
    var x = (SimpleSpoiler.random(0, 2 * max + 1) - max) / max;
    var y = Math.sqrt(1 - x * x) * (negative ? -1 : 1);
    return { dx: k * x, dy: k * y };
  },
  resetPoint: function(point) {
    var v = SimpleSpoiler.generateVector(point.cnt);
    point.x = SimpleSpoiler.random(point.md, point.mx - point.md);
    point.y = SimpleSpoiler.random(point.md, point.my - point.md);
    point.dx = v.dx;
    point.dy = v.dy;
    point.s = SimpleSpoiler.random(60, 80) * point.my / 3600;
  },
  updatePoint: function(point) {
    var b = point.b, t = point.t;
    var d = point.fps * point.lsec / 3;
    var k = 360 / point.lsec / point.fps;
    var x = point.x + k * t * point.dx;
    var y = point.y + k * t * point.dy;
    b.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(' + point.s + ')';
    b.style.opacity = (t < d ? t / d : t < d * 2 ? 1 : (d * 3 - t) / d) * 0.95;
  },
  init: function(el) {
    SimpleSpoiler.destroy(el);
    el.style.position = 'relative';
    var el_w = el.offsetWidth || 260;
    var el_h = el.offsetHeight || 20;
    var max_d = 5, fps = 30, lsec = 0.6;
    var count = Math.min(Math.max(Math.floor(el_w * el_h / 12), 40), 300);
    var points = [];
    for (var i = 0; i < count; i++) {
      var b = document.createElement('b');
      b.className = 'point';
      var point = { b: b, mx: el_w, my: el_h, md: max_d, cnt: count, fps: fps, lsec: lsec, t: SimpleSpoiler.random(0, fps * lsec) };
      SimpleSpoiler.resetPoint(point);
      SimpleSpoiler.updatePoint(point);
      el.appendChild(b);
      points.push(point);
    }
    var interval = 1000 / fps;
    var last_render = Date.now();
    var spoiler = { points: points, active: true };
    function doRedraw() {
      if (!spoiler.active) return;
      var now = Date.now();
      if (now - last_render >= interval) {
        for (var j = 0; j < spoiler.points.length; j++) {
          var pt = spoiler.points[j];
          if (++pt.t >= fps * lsec) { pt.t = 0; SimpleSpoiler.resetPoint(pt); }
          SimpleSpoiler.updatePoint(pt);
        }
        last_render = now;
      }
      spoiler.raf = requestAnimationFrame(doRedraw);
    }
    spoiler.raf = requestAnimationFrame(doRedraw);
    el._spoiler = spoiler;
  },
  destroy: function(el) {
    var spoiler = el._spoiler;
    if (!spoiler) return;
    spoiler.active = false;
    if (spoiler.raf) cancelAnimationFrame(spoiler.raf);
    for (var i = 0; i < spoiler.points.length; i++) {
      var b = spoiler.points[i].b;
      if (b.parentNode) b.parentNode.removeChild(b);
    }
    el._spoiler = null;
  }
};

function generateSpoilerPoints(container) {
  SimpleSpoiler.init(container);
}

function destroySpoilerPoints(container) {
  SimpleSpoiler.destroy(container);
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

  document.getElementById('apps-header-count').textContent = `${t('my_apps')} (${slots.used}/${slots.total})`;

  // First-time onboarding: when the user has zero apps, give the Create App
  // button a strong gradient + nudge label so it's the obvious next action.
  const isFirstApp = projects.length === 0;
  let html;
  if (isFirstApp) {
    const ctaLabel = t('create_first_app') || t('create_new_app');
    const ctaHint = t('create_first_app_hint') || 'Start your first AI-built bot';
    html = `<a class="tm-row tm-row-add tm-row-add-pulse" id="btn-create-app">` +
      `<span class="tm-icon"></span>` +
      `<div class="tm-row-add-textcol">` +
        `<span class="tm-row-add-label">${esc(ctaLabel)}</span>` +
        `<span class="tm-row-add-hint">${esc(ctaHint)}</span>` +
      `</div>` +
      `</a>`;
  } else {
    html = `<a class="tm-row tm-row-add" id="btn-create-app">` +
      `<span class="tm-icon"></span>` +
      `<span>${esc(t('create_new_app'))}</span>` +
      `</a>`;
  }
  for (const p of filtered) {
    const username = p.botUsername ? `@${p.botUsername}` : '';
    let avatarHtml;
    if (p.avatarUrl) {
      avatarHtml = `<img class="tm-row-pic tm-row-pic-user" src="${p.avatarUrl}">`;
    } else {
      const [c1, c2] = getGradient(p.name);
      avatarHtml = `<div class="tm-row-pic tm-row-pic-user avatar-gradient" style="background:linear-gradient(135deg,${c1},${c2})">${getInitials(p.name)}</div>`;
    }
    html += `<a class="tm-row tm-row-link" data-id="${p.id}">` +
      avatarHtml +
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
// New flow: create a project row immediately (no bot yet), then open the chat
// so the user can describe their app and build it right away. The bot is
// created and linked after the first build via the managed_bot event.

async function createNewApp() {
  if (slots.used >= slots.total) {
    openSlotsFull();
    return;
  }
  const btn = document.getElementById('btn-create-app');
  const icon = btn?.querySelector('.tm-icon');
  if (icon) { icon.className = 'loader'; icon.style.cssText = 'width:20px;height:20px;margin-right:4px'; }
  if (btn) btn.style.pointerEvents = 'none';

  try {
    const res = await fetch(`${API_BASE}/projects/create`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (err.error === 'slot_limit') { openSlotsFull(); return; }
      throw new Error('create failed');
    }
    const { projectId } = await res.json();
    await loadProjects();
    openChat(projectId);
  } catch (err) {
    showToast(t('error_generic') || 'Something went wrong', 'error');
  } finally {
    if (icon) { icon.className = 'tm-icon'; icon.style.cssText = ''; }
    if (btn) btn.style.pointerEvents = '';
  }
}

// ── Poll for bot linking after the "Create Bot" button is clicked ──
// Replaces the old pollForNewApp (which waited for managed_bot to create the
// project). Now this only runs while waiting for the user to link a bot to an
// already-built project.
let linkBotPollTimer = null;

function startLinkBotPolling(projectId, onLinked) {
  if (linkBotPollTimer) clearInterval(linkBotPollTimer);
  let attempts = 0;
  linkBotPollTimer = setInterval(async () => {
    attempts++;
    if (attempts > 80) { // ~4 min
      clearInterval(linkBotPollTimer);
      linkBotPollTimer = null;
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/projects`, { headers: apiHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      const updated = (data.projects || data).find(p => p.id === projectId);
      if (updated?.botUsername) {
        clearInterval(linkBotPollTimer);
        linkBotPollTimer = null;
        // Update local state so the header and app list reflect the new bot
        projects = data.projects || data;
        slots = data.slots || slots;
        if (currentProject && currentProject.id === projectId) {
          currentProject.botUsername = updated.botUsername;
          const statusEl = document.getElementById('chat-app-status');
          if (statusEl) statusEl.textContent = `@${updated.botUsername}`;
        }
        renderAppList();
        // Remove the "Link your bot" card if still visible
        document.getElementById('link-bot-card')?.remove();
        if (typeof onLinked === 'function') {
          try { onLinked(updated); } catch (e) { console.error('[link-bot] onLinked threw', e); }
        }
      }
    } catch {}
  }, 3000);
}

let slotsAnimInstance = null;

function openSlotsFull() {
  document.getElementById('slots-full-info').textContent = t('slots_full_title');
  document.getElementById('slots-full-detail').innerHTML =
    `<b>$5</b> per additional slot<br>Current slots: <b>${slots.used}/${slots.total}</b>`;
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
    showToast(t('toast_slot_purchased'), 'success');
    await loadProjects();
    showView('list');
  } catch (err) {
    tg?.MainButton?.hideProgress();
    showToast('Error: ' + err.message, 'error');
  }
}

// ── Top Up ──

let topupMethod = 'ton';
let topupAnimInstance = null;
let topupReturnView = null;
let userBalance = 0;
let userCredits = 0;
let userTierId = 'tier_1';   // account-level default (from DB)
let userTierData = null;
let allTiers = [];
const projectTierMap = {};   // { [projectId]: tierId } — per-chat override
let creditsPerDollar = 50;
let userPaymentCount = 0;
let topupSubmitting = false;
let firstDepositBonusEligible = false;
let firstDepositBonusPercent = 0; // legacy field, kept for backwards compat
let selectedBundle = null;        // currently selected bundle object
let bundleCache = null;           // cached array of bundles from /api/bundles
const ESTIMATED_APP_COST_USD = 3;
let tonConnectUI = null;
let tonVerifyTimeout = null;
let tonVerifyAttempts = 0;
let tonVerifyingPaymentId = null;
const TON_MAX_VERIFY = 30; // 30 attempts * 10s = 5 minutes
const TON_VERIFY_INTERVAL = 10000;
let starsVerifyTimeout = null;
let starsVerifyAttempts = 0;
let starsVerifyingPaymentId = null;
const STARS_MAX_VERIFY = 36; // 36 * 5s = 3 minutes
const STARS_VERIFY_INTERVAL = 5000;
// "Other Crypto" (NowPayments) charges high fees on small invoices, so we
// only allow it when the amount is at least this much.
const OTHER_CRYPTO_MIN_USD = 15;

function openTopup(returnTo) {
  topupReturnView = returnTo || currentView || 'list';
  topupMethod = 'ton';
  selectedBundle = null;

  loadTopupBalance();
  loadTopupTgs();
  loadBundles();
  showView('topup');
}

async function loadBundles() {
  const grid = document.getElementById('bundle-grid');
  if (!grid) return;
  try {
    const res = await fetch(`${API_BASE}/bundles`, { headers: apiHeaders() });
    if (!res.ok) throw new Error('Failed to load bundles');
    const data = await res.json();
    bundleCache = data.bundles || [];
    firstDepositBonusEligible = data.isFirstPurchase || false;

    // Update bonus banner
    const bonusSection = document.getElementById('topup-bonus-section');
    if (bonusSection) bonusSection.style.display = firstDepositBonusEligible ? '' : 'none';

    renderBundleGrid(bundleCache, firstDepositBonusEligible);
  } catch (err) {
    grid.innerHTML = `<div class="bundle-grid-error">Failed to load bundles. Please try again.</div>`;
  }
}

function renderBundleGrid(bundles, isFirstPurchase) {
  const grid = document.getElementById('bundle-grid');
  if (!grid) return;

  if (!bundles || bundles.length === 0) {
    grid.innerHTML = '<div class="bundle-grid-empty">No bundles available right now.</div>';
    return;
  }

  grid.innerHTML = bundles.map(b => {
    const isSoldOut = b.isSoldOut;
    const isLimited = b.isLimited && b.limitTotal;
    const totalCredits = isFirstPurchase ? (b.credits + b.bonusCredits) * 2 : (b.credits + b.bonusCredits);
    const basePrice = b.discount > 0 ? +(b.priceUsd / (1 - b.discount / 100)).toFixed(2) : null;

    const tags = [];
    if (isFirstPurchase) tags.push(`<div class="bundle-tag-first">×2 FIRST PURCHASE</div>`);
    if (isLimited && !isSoldOut) tags.push(`<div class="bundle-tag-limited">🔥 Limited</div>`);
    if (isSoldOut) tags.push(`<div class="bundle-tag-limited" style="background:linear-gradient(90deg,rgba(100,100,100,0.6),rgba(70,70,70,0.6))">Sold Out</div>`);

    const discountBadge = b.discount > 0
      ? `<span class="bundle-discount-badge">-${b.discount}%</span>`
      : '';

    const baseTotal = b.credits + b.bonusCredits;   // without x2
    const doubledTotal = baseTotal * 2;              // with x2
    let creditsLine;
    if (isFirstPurchase) {
      // Show original amount struck through, then doubled amount
      if (b.bonusCredits > 0) {
        creditsLine =
          `${coinSvg(16, 11, '#fbbf24')}&nbsp;` +
          `<s class="bundle-credits-original">${b.credits.toLocaleString()}</s> ` +
          `<b>${(b.credits * 2).toLocaleString()}</b>` +
          `<span class="bundle-bonus"> +<s class="bundle-credits-original">${b.bonusCredits.toLocaleString()}</s> ${(b.bonusCredits * 2).toLocaleString()} bonus</span>`;
      } else {
        creditsLine =
          `${coinSvg(16, 11, '#fbbf24')}&nbsp;` +
          `<s class="bundle-credits-original">${b.credits.toLocaleString()}</s> ` +
          `<b>${doubledTotal.toLocaleString()}</b>`;
      }
    } else {
      creditsLine = b.bonusCredits > 0
        ? `${coinSvg(16, 11, '#fbbf24')}&nbsp;<b>${b.credits.toLocaleString()}</b><span class="bundle-bonus"> +${b.bonusCredits.toLocaleString()} bonus</span>`
        : `${coinSvg(16, 11, '#fbbf24')}&nbsp;<b>${totalCredits.toLocaleString()}</b>`;
    }

    const priceLine = basePrice
      ? `<span class="bundle-price-original">$${basePrice.toFixed(2)}</span> <span class="bundle-price-new">$${b.priceUsd.toFixed(2)}</span> ${discountBadge}`
      : `<span class="bundle-price-new">$${b.priceUsd.toFixed(2)}</span>`;

    const progressLine = isLimited
      ? (() => {
          const pct = Math.min(100, Math.round((b.purchaseCount / b.limitTotal) * 100));
          return `<div class="bundle-progress">
            <div class="bundle-progress-bar"><div class="bundle-progress-fill" style="width:${pct}%"></div></div>
            <span class="bundle-progress-label">${b.purchaseCount}/${b.limitTotal}</span>
          </div>`;
        })()
      : '';

    const cardClass = [
      'bundle-card',
      isSoldOut ? 'bundle-card--sold-out' : '',
      isLimited ? 'bundle-card--limited' : '',
    ].filter(Boolean).join(' ');

    return `<div class="${cardClass}" data-bundle-id="${b.id}">
      ${tags.join('')}
      <div class="bundle-name">${esc(b.name)}</div>
      <div class="bundle-credits">${creditsLine}</div>
      <div class="bundle-price">${priceLine}</div>
      ${progressLine}
    </div>`;
  }).join('');

  grid.querySelectorAll('.bundle-card:not(.bundle-card--sold-out)').forEach(card => {
    card.addEventListener('click', () => {
      const bundle = bundles.find(b => b.id === card.dataset.bundleId);
      if (bundle) openPurchaseModal(bundle);
    });
  });
}

// Minimum credits required to start a build/update (derived from user's tier).
// Falls back to safe default; the real check is server-side.
function getMinBuildCredits() {
  if (userTierData?.pricing?.create) return userTierData.pricing.create;
  return 300; // tier_1 default
}
function getMinAskCredits() {
  if (userTierData?.pricing?.ask) return userTierData.pricing.ask;
  return 20;
}
const ESTIMATED_PRICE_RANGE = '100–500';

// Single unified "Insufficient Funds" warning panel.
// Replaces the older split between the compact red bar (returning depositors)
// and the "Almost there!" conversion card (first-timers). Both audiences now
// see the same fancy amber/orange warning card; the +bonus mini-panel is
// shown inline only when the user is still eligible for the first-deposit
// bonus AND the bonus percent is enabled.
function renderInsufficientFundsCard(balance) {
  const bal      = Math.floor(Number(balance) || 0);
  const cost     = getMinBuildCredits();
  const shortfall = Math.max(0, cost - bal);
  const eligible  = firstDepositBonusEligible;

  // substitute {pct} placeholder – bonus is always ×2 (100%)
  const subPct = s => s.replace(/\{pct\}/g, '100');

  const title    = t('chat_insufficient_funds_title') || t('chat_insufficient') || 'Not Enough Credits';
  const subtitle = t('chat_insufficient_funds_sub')   || 'Top up to start building your app';
  const lblBal   = t('chat_your_balance')             || 'Your balance';
  const lblCost  = t('chat_build_cost')               || 'Build cost';
  const lblNeed  = t('chat_credits_needed')           || 'You need';

  const rawCta = eligible
    ? (t('chat_topup_cta_bonus') || 'Top Up & Get ×2 Bonus')
    : (t('chat_topup_cta') || 'Top Up Credits');
  const ctaText = subPct(rawCta);

  const bonusBadge = eligible
    ? `<span class="ifc-cta-badge">+100%</span>`
    : '';

  return `
    <div class="ifc-header">
      <div class="ifc-coin-icon">${coinSvg(36, 26, '#fbbf24')}</div>
      <div class="ifc-headtext">
        <div class="ifc-title">${esc(title)}</div>
        <div class="ifc-sub">${esc(subtitle)}</div>
      </div>
    </div>
    <div class="ifc-stats">
      <div class="ifc-stat ifc-stat--bal">
        <div class="ifc-stat-label">${esc(lblBal)}</div>
        <div class="ifc-stat-value low">${coinSvg(13, 9, '#fb923c')}&nbsp;${bal.toLocaleString()}</div>
      </div>
      <div class="ifc-stat ifc-stat--cost">
        <div class="ifc-stat-label">${esc(lblCost)}</div>
        <div class="ifc-stat-value">${coinSvg(13, 9, '#fbbf24')}&nbsp;${cost.toLocaleString()}</div>
      </div>
    </div>
    <button class="ifc-cta ${eligible ? 'with-bonus' : ''}">
      ${coinSvg(16, 11, 'currentColor')}
      <span>${esc(t('chat_topup_btn') || t('chat_topup_cta') || 'Top Up')}</span>
      ${bonusBadge}
    </button>
  `;
}

// Re-renders the unified balance-warning card into a chat-bubble wrapper.
// All previous card-class flags (`chat-bubble--balance-error`,
// `chat-bubble--insufficient`) are stripped so re-rendering is idempotent.
function renderBalancePromptCard(el, balance) {
  el.classList.remove('chat-bubble--balance-error', 'chat-bubble--insufficient');
  el.classList.add('chat-bubble--insufficient-funds');
  el.innerHTML = renderInsufficientFundsCard(balance);
  el.querySelector('.ifc-cta')?.addEventListener('click', () => openTopup('chat'));
}

async function loadTopupBalance() {
  try {
    const res = await fetch(`${API_BASE}/balance`, { headers: apiHeaders() });
    if (res.ok) {
      const data = await res.json();
      userBalance = data.balance; // now credits
      userCredits = data.credits ?? data.balance ?? 0;
      userTierId = data.tierId || 'tier_1';
      userTierData = data.tier || null;
      if (data.allTiers?.length) allTiers = data.allTiers;
      if (data.creditsPerDollar) creditsPerDollar = data.creditsPerDollar;
      userPaymentCount = data.paymentCount ?? 0;
      firstDepositBonusEligible = !!data.firstDepositBonusEligible;
      const creditsDisplay = Math.max(0, userCredits);
      const balEl = document.getElementById('balance-amount');
      if (balEl) balEl.innerHTML = `${coinSvg(18, 12, 'currentColor')}&nbsp;${creditsDisplay.toLocaleString()}`;
      const balText = document.getElementById('topup-balance-text');
      if (balText) balText.innerHTML = `${coinSvg(18, 12, 'currentColor')}&nbsp;${creditsDisplay.toLocaleString()}`;
      renderTierChip();
      updatePillPrices();
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

function openPurchaseModal(bundle) {
  selectedBundle = bundle;
  topupMethod = 'ton';
  topupSubmitting = false;

  const modal = document.getElementById('purchase-modal');
  if (!modal) return;

  // Always reset button to clean state on open (guard against stale loading state)
  const purchaseBtn = document.getElementById('pm-purchase-btn');
  if (purchaseBtn) { purchaseBtn.disabled = false; purchaseBtn.textContent = 'Purchase'; }

  // Populate bundle summary
  const isFirst = firstDepositBonusEligible;
  const pmBaseTotal = bundle.credits + bundle.bonusCredits;
  const pmFinalTotal = isFirst ? pmBaseTotal * 2 : pmBaseTotal;

  // Bundle name
  document.getElementById('pm-bundle-name').textContent = bundle.name;

  // Large credits number
  const bigEl = document.getElementById('pm-bundle-credits-big');
  if (isFirst) {
    bigEl.innerHTML =
      `<span class="pm-credits-orig">${pmBaseTotal.toLocaleString()}</span>` +
      `${coinSvg(28, 19, '#fbbf24')}${pmFinalTotal.toLocaleString()}`;
  } else {
    bigEl.innerHTML = `${coinSvg(28, 19, '#fbbf24')}${pmFinalTotal.toLocaleString()}`;
  }

  // Breakdown line
  const breakdownEl = document.getElementById('pm-bundle-breakdown');
  const parts = [];
  if (isFirst) parts.push(`<span class="pm-bd-tag pm-bd-tag--x2">×2 First Purchase</span>`);
  if (bundle.bonusCredits > 0) {
    const bonusAmt = isFirst ? bundle.bonusCredits * 2 : bundle.bonusCredits;
    parts.push(`<span class="pm-bd-tag pm-bd-tag--bonus">+${bonusAmt.toLocaleString()} bonus</span>`);
  }
  breakdownEl.innerHTML = parts.join('');

  // Price row
  const priceEl = document.getElementById('pm-bundle-price');
  const priceOrigEl = document.getElementById('pm-bundle-price-orig');
  const discountEl = document.getElementById('pm-bundle-discount-badge');
  priceEl.textContent = `$${bundle.priceUsd.toFixed(2)}`;
  if (bundle.discount > 0) {
    const origPrice = (bundle.priceUsd / (1 - bundle.discount / 100)).toFixed(2);
    priceOrigEl.textContent = `$${origPrice}`;
    discountEl.textContent = `-${bundle.discount}%`;
    priceOrigEl.style.display = '';
    discountEl.style.display = '';
  } else {
    priceOrigEl.style.display = 'none';
    discountEl.style.display = 'none';
  }

  // Glow color based on first purchase
  const glowEl = document.getElementById('pm-bundle-glow');
  if (glowEl) glowEl.style.background = isFirst
    ? 'radial-gradient(ellipse 80% 50% at 50% 0%, rgba(129,140,248,0.35) 0%, transparent 100%)'
    : 'radial-gradient(ellipse 80% 50% at 50% 0%, rgba(251,191,36,0.25) 0%, transparent 100%)';

  // Set "Other Crypto" disabled state based on bundle price
  const cryptoBtn = document.getElementById('pm-method-crypto');
  if (cryptoBtn) {
    const disabled = bundle.priceUsd < 15;
    cryptoBtn.classList.toggle('pm-method--disabled', disabled);
    cryptoBtn.title = disabled ? `Requires ≥ $15 bundle` : '';
  }

  // Reset method selection
  document.querySelectorAll('.pm-method').forEach(btn => {
    btn.classList.toggle('pm-method--active', btn.dataset.method === topupMethod);
  });

  updateTonWalletPanel();
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Animate in
  requestAnimationFrame(() => {
    modal.querySelector('.purchase-modal-sheet')?.classList.add('open');
  });
}

function closePurchaseModal() {
  const modal = document.getElementById('purchase-modal');
  if (!modal) return;
  const sheet = modal.querySelector('.purchase-modal-sheet');
  sheet?.classList.remove('open');
  setTimeout(() => {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    selectedBundle = null;
  }, 280);
}

async function submitTopup() {
  if (topupSubmitting || !selectedBundle) return;
  topupSubmitting = true;
  const btn = document.getElementById('pm-purchase-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }
  try {
    const res = await fetch(`${API_BASE}/topup`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundleId: selectedBundle.id, method: topupMethod }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      showToast(data.error || 'Payment creation failed', 'error');
      return;
    }

    if (data.ton) {
      closePurchaseModal();
      await handleTonPayment(data);
      return;
    }

    if (topupMethod === 'stars') {
      const paymentId = data.paymentId;
      if (paymentId) startStarsVerifying(paymentId);
      closePurchaseModal();
      try {
        tg?.openInvoice(data.invoiceUrl, (status) => {
          console.log('[Stars] Invoice closed with status:', status);
          if (status === 'paid') {
            showToast('Payment received, confirming...', 'info');
            if (paymentId) {
              setTimeout(() => {
                stopStarsVerifying();
                startStarsVerifying(paymentId);
              }, 500);
            }
            setTimeout(() => loadTopupBalance(), 1500);
          } else if (status === 'cancelled' || status === 'failed') {
            stopStarsVerifying();
          }
        });
      } catch (e) {
        console.error('openInvoice error:', e);
        try { tg?.openInvoice(data.invoiceUrl); } catch {}
      }
    } else {
      closePurchaseModal();
      if (data.invoiceUrl.includes('t.me/')) {
        tg?.openTelegramLink(data.invoiceUrl);
      } else {
        tg?.openLink(data.invoiceUrl);
      }
    }
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    topupSubmitting = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Purchase'; }
  }
}

function initTonConnect() {
  if (tonConnectUI) return;
  try {
    tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
      manifestUrl: `${location.origin}/telegram-mini-app/tonconnect-manifest.json`,
    });
    tonConnectUI.onStatusChange(() => updateTonWalletPanel());
  } catch (err) {
    console.error('TonConnect init error:', err);
  }
}

function formatTonAddress(raw) {
  if (!raw) return '';
  if (raw.length > 16) return raw.slice(0, 8) + '...' + raw.slice(-6);
  return raw;
}

function updateTonWalletPanel() {
  const panel = document.getElementById('ton-wallet-panel');
  if (!panel) return;

  const show = topupMethod === 'ton';
  panel.classList.toggle('hidden', !show);
  if (!show) return;

  initTonConnect();

  const connectedEl = document.getElementById('ton-wallet-connected');
  const notConnectedEl = document.getElementById('ton-wallet-not-connected');
  const addrEl = document.getElementById('ton-wallet-address');

  if (tonConnectUI && tonConnectUI.connected && tonConnectUI.account) {
    const addr = tonConnectUI.account.address || '';
    connectedEl.style.display = 'flex';
    notConnectedEl.style.display = 'none';
    addrEl.textContent = formatTonAddress(addr);
  } else {
    connectedEl.style.display = 'none';
    notConnectedEl.style.display = 'flex';
  }
}

async function encodeTextComment(text) {
  try {
    const cell = new TonWeb.boc.Cell();
    cell.bits.writeUint(0, 32);
    cell.bits.writeString(text);
    const bocBytes = await cell.toBoc();
    return TonWeb.utils.bytesToBase64(bocBytes);
  } catch (e) {
    console.error('BOC encode error:', e);
    return undefined;
  }
}

async function handleTonPayment(data) {
  const { paymentId, walletAddress, amountNano } = data;

  // Start verification polling IMMEDIATELY when invoice is created.
  // The wallet flow (TonConnect) is unreliable: connect callback may never fire,
  // user may pay from a separate wallet app, or sendTransaction promise may hang.
  // On-chain polling is the source of truth.
  startTonVerifying(paymentId);

  initTonConnect();
  if (!tonConnectUI) {
    showToast('Pay to the wallet shown in your TON app — auto-verifying for 5 min', 'info');
    return;
  }

  const connected = tonConnectUI.connected;
  if (!connected) {
    try {
      await tonConnectUI.openModal();
      await new Promise((resolve, reject) => {
        const unsub = tonConnectUI.onStatusChange((wallet) => {
          unsub();
          if (wallet) resolve(wallet);
          else reject(new Error('Wallet not connected'));
        });
      });
    } catch {
      showToast('Auto-verifying any TON payment for this invoice (5 min)...', 'info');
      return;
    }
  }

  try {
    const payload = await encodeTextComment(String(paymentId));

    const transaction = {
      validUntil: Math.floor(Date.now() / 1000) + 600,
      messages: [{
        address: walletAddress,
        amount: amountNano,
        payload: payload
      }]
    };

    showToast('Confirm in your TON wallet...', 'info');
    await tonConnectUI.sendTransaction(transaction);
    showToast('Transaction sent! Verifying...', 'success');
  } catch (err) {
    console.error('TON transaction error:', err);
    // Polling is already running — keep it. User may have paid via another wallet.
    showToast('If you already paid, balance will update automatically (5 min)', 'info');
  }
}

function startTonVerifying(paymentId) {
  // Don't start a duplicate poller for the same paymentId
  if (tonVerifyingPaymentId === paymentId && tonVerifyTimeout) return;
  stopTonVerifying();
  tonVerifyingPaymentId = paymentId;
  tonVerifyAttempts = 0;
  tg?.MainButton?.setText('Verifying payment...');
  tg?.MainButton?.showProgress();
  console.log(`[TON] Started verifying payment ${paymentId}, every ${TON_VERIFY_INTERVAL/1000}s for ${TON_MAX_VERIFY * TON_VERIFY_INTERVAL / 60000}min`);

  async function poll() {
    tonVerifyAttempts++;
    try {
      const res = await fetch(`${API_BASE}/ton-verify`, {
        method: 'POST',
        headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentId }),
      });
      const result = await res.json();

      if (result.confirmed) {
        stopTonVerifying();
        tg?.MainButton?.hideProgress();
        tg?.MainButton?.hide();
        showToast('Payment confirmed! Balance updated.', 'success');
        tg?.HapticFeedback?.notificationOccurred('success');
        loadTopupBalance();
        return;
      }
    } catch (e) {
      console.error('TON verify poll error:', e);
    }

    if (tonVerifyAttempts >= TON_MAX_VERIFY) {
      stopTonVerifying();
      tg?.MainButton?.hideProgress();
      tg?.MainButton?.hide();
      showToast('Still processing. Balance will update automatically.', 'info');
      return;
    }

    tonVerifyTimeout = setTimeout(poll, TON_VERIFY_INTERVAL);
  }

  // Quick first check after 5s, then steady 10s cadence
  tonVerifyTimeout = setTimeout(poll, 5000);
}

function stopTonVerifying() {
  if (tonVerifyTimeout) {
    clearTimeout(tonVerifyTimeout);
    tonVerifyTimeout = null;
  }
  tonVerifyingPaymentId = null;
}

// Poll generic payment status (used as fallback for Stars when the bot
// webhook misses or is delayed).
function startStarsVerifying(paymentId) {
  if (starsVerifyingPaymentId === paymentId && starsVerifyTimeout) return;
  stopStarsVerifying();
  starsVerifyingPaymentId = paymentId;
  starsVerifyAttempts = 0;
  console.log(`[Stars] Started verifying payment ${paymentId}, every ${STARS_VERIFY_INTERVAL/1000}s for ${STARS_MAX_VERIFY * STARS_VERIFY_INTERVAL / 60000}min`);

  async function poll() {
    starsVerifyAttempts++;
    try {
      const res = await fetch(`${API_BASE}/payment-status?paymentId=${paymentId}`, {
        headers: { ...apiHeaders() },
      });
      const result = await res.json();
      if (result.status === 'confirmed') {
        stopStarsVerifying();
        showToast('Payment confirmed! Balance updated.', 'success');
        tg?.HapticFeedback?.notificationOccurred('success');
        loadTopupBalance();
        return;
      }
    } catch (e) {
      console.error('Stars verify poll error:', e);
    }

    if (starsVerifyAttempts >= STARS_MAX_VERIFY) {
      stopStarsVerifying();
      return;
    }
    starsVerifyTimeout = setTimeout(poll, STARS_VERIFY_INTERVAL);
  }

  starsVerifyTimeout = setTimeout(poll, 3000);
}

function stopStarsVerifying() {
  if (starsVerifyTimeout) {
    clearTimeout(starsVerifyTimeout);
    starsVerifyTimeout = null;
  }
  starsVerifyingPaymentId = null;
}

function initTopupEvents() {
  // Purchase modal: method selection
  document.querySelectorAll('.pm-method').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.classList.contains('pm-method--disabled')) {
        showToast(`This method requires a bundle of at least $15`, 'info');
        return;
      }
      topupMethod = btn.dataset.method;
      document.querySelectorAll('.pm-method').forEach(b => b.classList.toggle('pm-method--active', b === btn));
      updateTonWalletPanel();
    });
  });

  // Purchase button
  document.getElementById('pm-purchase-btn')?.addEventListener('click', () => submitTopup());

  // Close modal on backdrop click
  document.getElementById('purchase-modal-backdrop')?.addEventListener('click', () => closePurchaseModal());

  // TON wallet panel events
  document.getElementById('ton-wallet-disconnect')?.addEventListener('click', async () => {
    if (tonConnectUI) {
      try {
        await tonConnectUI.disconnect();
        showToast('Wallet disconnected', 'info');
      } catch {}
      updateTonWalletPanel();
    }
  });

  document.getElementById('ton-wallet-connect-btn')?.addEventListener('click', async () => {
    initTonConnect();
    if (tonConnectUI) {
      try { await tonConnectUI.openModal(); } catch {}
    }
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
  chatHasMessages = false;

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

  // Clear any stale finalizing overlay from a previous chat
  setInputFinalizing(false);

  const projProcessing = processingProjectIds.has(projectId);
  isProcessing = projProcessing;
  setInputDisabled(projProcessing);
  setHeaderWorking(projProcessing);

  // Restore per-project tier (falls back to account-level default)
  if (projectTierMap[projectId]) {
    userTierId = projectTierMap[projectId];
    const tiers = allTiers.length ? allTiers : getDefaultTiers();
    userTierData = tiers.find(t => t.id === userTierId) || null;
    renderTierChip();
    updatePillPrices();
  }

  const skelEl = document.getElementById('chat-skeleton');
  skelEl.classList.remove('hidden');

  const isNew = ['created', 'planning'].includes(currentProject.status) && !currentProject.currentVersion;
  enterPlanningMode(isNew);

  showView('chat');
  connectChatWS(projectId);   // connect WS first so live updates overwrite stale history immediately
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
    input.placeholder = t('chat_placeholder');
    loadTgsAnimation();
    renderPromptSamples();
  } else {
    welcome.classList.add('hidden');
    pills.classList.remove('hidden');
    attachBtn.style.display = '';
    if (planAnimInstance) {
      planAnimInstance.destroy();
      planAnimInstance = null;
    }
    clearPromptSamples();
    switchChatMode(chatMode);
  }
}

// Onboarding hint pinned above the chat input on the planning screen:
// a single compact chip showing one localized example prompt at a time,
// rotating every ~2.8s with a smooth fade. Pure visual cue — not clickable.
let promptSamplesTimer = null;
let promptSamplesIndex = 0;

function renderPromptSamples() {
  if (chatHasMessages) return; // hide once chat has content
  const inputArea = document.getElementById('chat-input-area');
  if (!inputArea) return;
  const samples = [
    t('chat_sample_1'),
    t('chat_sample_2'),
    t('chat_sample_3'),
  ].filter(s => s && typeof s === 'string');
  if (samples.length === 0) {
    clearPromptSamples();
    return;
  }

  let chip = document.getElementById('chat-sample-chip');
  if (!chip) {
    chip = document.createElement('div');
    chip.id = 'chat-sample-chip';
    chip.className = 'chat-sample-chip';
    chip.setAttribute('aria-hidden', 'true');
    chip.innerHTML =
      `<span class="chat-sample-chip-label">${esc(t('chat_samples_title') || 'Try:')}</span>` +
      `<span class="chat-sample-chip-text"></span>`;
    // Insert just before the input bar so the chip visually attaches to it.
    const inputBar = inputArea.querySelector('.chat-input-bar');
    if (inputBar) {
      inputArea.insertBefore(chip, inputBar);
    } else {
      inputArea.appendChild(chip);
    }
  } else {
    const lbl = chip.querySelector('.chat-sample-chip-label');
    if (lbl) lbl.textContent = t('chat_samples_title') || 'Try:';
  }

  const textEl = chip.querySelector('.chat-sample-chip-text');
  promptSamplesIndex = 0;
  const setSample = (i) => {
    if (!textEl) return;
    textEl.classList.add('fading');
    setTimeout(() => {
      textEl.textContent = samples[i];
      textEl.classList.remove('fading');
    }, 220);
  };
  textEl.textContent = samples[0];

  if (promptSamplesTimer) clearInterval(promptSamplesTimer);
  if (samples.length > 1) {
    promptSamplesTimer = setInterval(() => {
      promptSamplesIndex = (promptSamplesIndex + 1) % samples.length;
      setSample(promptSamplesIndex);
    }, 2800);
  }
}

function clearPromptSamples() {
  if (promptSamplesTimer) {
    clearInterval(promptSamplesTimer);
    promptSamplesTimer = null;
  }
  document.getElementById('chat-sample-chip')?.remove();
}

function showEmptyChat() {
  const welcome = document.getElementById('chat-welcome');
  const welcomeText = document.getElementById('chat-welcome-text');
  welcome.classList.remove('hidden');
  welcomeText.textContent = t('chat_welcome_msg');
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

let wsGeneration = 0;

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
    chatWs.send(JSON.stringify({ type: 'auth', initData: tg?.initData || '' }));
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
      if (gen === wsGeneration && currentView === 'chat' && chatProjectId === projectId) {
        connectChatWS(projectId);
      }
    }, 3000);
  };
}

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
      if (typeof msg.costUsd === 'number' && msg.costUsd > 0) {
        html += `<div class="chat-progress-cost">Cost: $${msg.costUsd.toFixed(4)}${typeof msg.balance === 'number' ? ` · Balance: ${Math.floor(msg.balance)}` : ''}</div>`;
      }
      html += `<div class="chat-bubble-time">${timeStr(msg.timestamp)}</div>`;
      el.innerHTML = html;
      el.id = `msg-${msg.id}`;
      requestAnimationFrame(() => {
        const seContent = el.querySelector('.chat-bubble-content');
        if (!seContent) return;
        if (seContent.scrollHeight > 280) {
          el.classList.add('collapsed-msg');
          const seBtn = document.createElement('button');
          seBtn.className = 'msg-expand-btn';
          seBtn.textContent = t('chat_show_more') || 'Show more';
          seBtn.addEventListener('click', () => {
            haptic('light');
            const c = el.classList.toggle('collapsed-msg');
            seBtn.textContent = c ? (t('chat_show_more') || 'Show more') : (t('chat_show_less') || 'Show less');
          });
          seContent.parentNode.insertBefore(seBtn, seContent.nextSibling);
        }
      });
      scrollToBottom();
    }
    return;
  }

  // ── Agent narration events (collapsible "thinking" blocks) ───────────────
  if (data.type === 'agent_narration_start') {
    const el = document.getElementById(`msg-${data.messageId}`);
    if (!el) return;
    // First narration: convert the progress bubble to a transparent timeline
    if (!el.classList.contains('agent-process')) {
      el.classList.add('agent-process');
      el.innerHTML = ''; // wipe the old "Working X% / Starting..." UI
    }
    // Mark any still-running think blocks as done (guard for missed narration_end)
    el.querySelectorAll('.agent-think-block.running').forEach(b => {
      b.classList.remove('running');
      b.classList.add('done');
      const ic = b.querySelector('.agent-think-icon');
      if (ic) ic.innerHTML = AGENT_DONE_SVG;
      const hdr = b.querySelector('.agent-think-header');
      if (hdr && !hdr._clickBound) { hdr._clickBound = true; hdr.addEventListener('click', () => b.classList.toggle('open')); }
    });
    // Remove or hide the footer to avoid it sitting above new blocks
    const existingFooter = el.querySelector('.agent-footer');
    if (existingFooter) existingFooter.remove();
    // Create a fresh think block for this iteration
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
    // Persist: add narration entry
    const _apst0 = ensureAgentProcState(data.messageId);
    if (typeof _apst0._seq !== 'number') _apst0._seq = 0;
    _apst0.narrations.push({ stepId: data.stepId, preview: 'Thinking\u2026', body: '', done: false, order: _apst0._seq++ });
    persistAgentProcState(data.messageId);
    scrollToBottom();
    return;
  }

  if (data.type === 'agent_narration_chunk') {
    const block = document.getElementById(`narr-${data.stepId}`);
    if (!block) return;
    const body = block.querySelector('.agent-think-body');
    const preview = block.querySelector('.agent-think-preview');
    if (body) {
      body.innerHTML = formatContent(data.text || '') + '<span class="stream-cursor"></span>';
      body.scrollTop = body.scrollHeight;
    }
    const plain = (data.text || '').replace(/[#*`_~\n]/g, ' ').trim();
    const previewText = plain.length > 72 ? plain.slice(0, 72) + '…' : (plain || 'Thinking…');
    if (preview) preview.textContent = previewText;
    // Persist: update narration body + preview
    const _apst1 = agentProcState.get(data.messageId);
    if (_apst1) {
      const _narr = _apst1.narrations.find(n => n.stepId === data.stepId);
      if (_narr) { _narr.body = data.text || ''; _narr.preview = previewText; persistAgentProcState(data.messageId); }
    }
    scrollToBottom();
    return;
  }

  if (data.type === 'agent_writing_chunk') {
    // Show tool-call arguments streaming in the active narration block —
    // purely visual, gives the user feedback while the model writes files.
    const block = document.getElementById(`narr-${data.stepId}`);
    if (!block) return;
    let viewport = block.querySelector('.agent-completion-viewport');
    if (!viewport) {
      viewport = document.createElement('div');
      viewport.className = 'agent-completion-viewport';
      const label = document.createElement('div');
      label.className = 'agent-completion-label';
      const toolLabel = (data.toolName || '').replace(/_/g, ' ');
      label.textContent = toolLabel ? `${toolLabel}` : 'Writing…';
      viewport.appendChild(label);
      const pre = document.createElement('pre');
      pre.className = 'agent-completion-pre';
      viewport.appendChild(pre);
      block.appendChild(viewport);
    }
    const pre = viewport.querySelector('.agent-completion-pre');
    if (pre) {
      // Append only the new delta (not the full accumulated args JSON) and
      // auto-scroll to the bottom so the user always sees the latest output.
      pre.textContent += data.delta || '';
      pre.scrollTop = pre.scrollHeight;
    }
    scrollToBottom();
    return;
  }

  if (data.type === 'agent_narration_end') {
    const block = document.getElementById(`narr-${data.stepId}`);
    if (!block) return;
    // Remove completion viewport when narration ends — the step card that
    // follows immediately shows the tool name and result.
    block.querySelector('.agent-completion-viewport')?.remove();
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
    // Persist: mark narration done
    const _apst2 = agentProcState.get(data.messageId);
    if (_apst2) {
      const _narr = _apst2.narrations.find(n => n.stepId === data.stepId);
      if (_narr) { _narr.done = true; persistAgentProcState(data.messageId); }
    }
    return;
  }

  // ── Agent step-card events ────────────────────────────────────────────────
  if (data.type === 'agent_step_start') {
    const el = document.getElementById(`msg-${data.messageId}`);
    if (!el) return;
    if (!el.classList.contains('agent-process')) {
      el.classList.add('agent-process');
      el.innerHTML = '';
    }
    // Remove footer so it re-appends after new step
    const existingFooter = el.querySelector('.agent-footer');
    if (existingFooter) existingFooter.remove();

    const targetHtml = data.target?.file || data.target?.url || data.target?.key
      ? `<div class="agent-step-target">${esc(data.target.file || data.target.url || data.target.key || '')}</div>` : '';
    const step = document.createElement('div');
    step.id = `step-${data.stepId}`;
    step.className = 'agent-step agent-step--running';
    // Show kind icon while running (dimmed); will be replaced with ✓/✗ on end
    step.innerHTML = `
      <div class="agent-step-icon agent-step-icon--kind">${agentStepIcon(data.kind)}</div>
      <div class="agent-step-body">
        <div class="agent-step-title">${esc(data.title || data.toolName || data.kind || '')}</div>
        ${targetHtml}
      </div>`;
    el.appendChild(step);
    // Persist: add step entry
    const _apst3 = ensureAgentProcState(data.messageId);
    if (typeof _apst3._seq !== 'number') _apst3._seq = 0;
    _apst3.steps.push({ stepId: data.stepId, kind: data.kind, title: data.title || data.toolName || data.kind || '', target: data.target || null, status: 'running', meta: null, order: _apst3._seq++ });
    persistAgentProcState(data.messageId);
    scrollToBottom();
    return;
  }

  if (data.type === 'agent_step_end') {
    const step = document.getElementById(`step-${data.stepId}`);
    if (!step) return;
    const ok = data.status !== 'error';
    step.classList.remove('agent-step--running');
    step.classList.add(ok ? 'agent-step--done' : 'agent-step--error');
    // For errors only: replace with ✗. For done: keep the kind icon — CSS recolors it green.
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
    // Persist: update step status + meta
    const _apst4 = agentProcState.get(data.messageId);
    if (_apst4) {
      const _step = _apst4.steps.find(s => s.stepId === data.stepId);
      if (_step) { _step.status = ok ? 'done' : 'error'; if (data.meta) _step.meta = data.meta; persistAgentProcState(data.messageId); }
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

  if (data.type === 'update_result') {
    const el = document.getElementById(`msg-${data.messageId}`);
    if (el) {
      let html = `<div class="chat-result-header">${t('chat_update_completed') || 'Update Completed'}</div>`;
      html += `<div class="chat-bubble-content">${formatContent(data.summary || '')}</div>`;
      if (data.changelogUrl) {
        html += `<div class="changelog-card" onclick="tg.openLink('${data.changelogUrl}', {try_instant_view: true})">
          <div class="changelog-card-text">
            <div class="changelog-card-title">${t('version_change_log')}</div>
            <div class="changelog-card-desc">Telegraph</div>
          </div>
          <div class="changelog-card-arrow">›</div>
        </div>`;
      }
      const existing = el.querySelector('.result-actions');
      if (existing) html += existing.outerHTML;
      const costEl = el.querySelector('.chat-progress-cost');
      if (costEl) html += costEl.outerHTML;
      el.innerHTML = html;
    }
    return;
  }

  if (data.type === 'remove_messages') {
    if (data.messageIds && Array.isArray(data.messageIds)) {
      for (const id of data.messageIds) {
        const el = document.getElementById(`msg-${id}`);
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
    setInputFinalizing(false);
    setProcessing(false);
    setInputDisabled(false);
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
      const el = document.getElementById(`msg-${data.messageId}`);
      const isProgressBubble = el && el.classList.contains('chat-bubble--progress');
      const swap = () => {
        setTyping(false);
        setHeaderWorking(false);
        if (isPlanningMode) enterPlanningMode(false);
        progressBubbleState.delete(data.messageId);
        clearAgentProcState(data.messageId);
        if (!el) return;
        el.className = 'chat-bubble chat-bubble--result';
        let html = `<div class="chat-result-header">${t('chat_update_completed') || 'Update Completed'}</div>`;
        html += `<div class="chat-bubble-content">${formatContent(data.summary || '')}</div>`;
        if (data.changelogUrl) {
          html += `<div class="changelog-card" onclick="tg.openLink('${data.changelogUrl}', {try_instant_view: true})">
            <div class="changelog-card-text">
              <div class="changelog-card-title">${t('version_change_log')}</div>
              <div class="changelog-card-desc">Telegraph</div>
            </div>
            <div class="changelog-card-arrow">›</div>
          </div>`;
        }
        html += resultActionsHtml(chatProjectId);
        if (typeof data.costUsd === 'number') {
          html += `<div class="chat-progress-cost">${t('chat_cost')}: $${data.costUsd.toFixed(4)}${typeof data.balance === 'number' ? ` · ${t('chat_balance')}: ${Math.floor(data.balance)}` : ''}</div>`;
        }
        html += linkBotCardHtml(chatProjectId);
        el.innerHTML = html;
        scrollToBottom();
      };

      if (isProgressBubble) {
        animateProgressToComplete(data.messageId, () => swap());
      } else {
        swap();
      }
    }
    return;
  }
}

/**
 * Build the result-card action row. For Text Bot projects we drop the
 * "Run Test" preview button (there's no Mini App to preview) and replace
 * it with an "Open Bot" deep-link to the linked Telegram bot.
 */
function resultActionsHtml(projectId) {
  const proj = (projects || []).find(p => p.id === projectId) || (currentProject && currentProject.id === projectId ? currentProject : null);
  const isTextBot = proj?.preferences?.kind === 'textBot';
  const releaseBtn = `<button class="result-action-btn result-action-release" onclick="releaseLatest()">${t('chat_release_update')}</button>`;
  if (isTextBot) {
    if (proj?.botUsername) {
      const botUrl = `https://t.me/${proj.botUsername}`;
      return `<div class="result-actions">
        <button class="result-action-btn result-action-test" onclick="tg?.openTelegramLink('${botUrl}')">${t('chat_open_bot')}</button>
        ${releaseBtn}
      </div>`;
    }
    return `<div class="result-actions">${releaseBtn}</div>`;
  }
  return `<div class="result-actions">
    <button class="result-action-btn result-action-test" onclick="openTestPreview('${projectId}')">▶ ${t('chat_run_test')}</button>
    ${releaseBtn}
  </div>`;
}

// Returns the HTML for the "Link your bot" card if the current project has no
// bot yet. Injected into result cards after every successful build.
function linkBotCardHtml(projectId) {
  if (currentProject?.botUsername) return '';
  const isDev = location.hostname === 'dev.apps-father.com';
  const fatherBot = isDev ? 'apps_father_dev_bot' : 'apps_father_bot';
  const newbotUrl = `https://t.me/newbot/${fatherBot}/username_bot`;
  // Escape single quotes in projectId (UUIDs are safe, but be defensive)
  const safeId = (projectId || '').replace(/'/g, '');
  return `<div class="link-bot-card" id="link-bot-card">
    <div class="link-bot-title">${t('link_bot_title')}</div>
    <div class="link-bot-sub">${t('link_bot_sub')}</div>
    <button class="link-bot-btn" onclick="tg?.openTelegramLink('${newbotUrl}'); startLinkBotPolling('${safeId}')">
      ${t('link_bot_btn')}
    </button>
  </div>`;
}

// Smoothly drives the progress bubble from its current % up to 100%, ticks
// every checklist item, hides the Stop button, then invokes `done` after a
// 2-second total completion window so the user sees the bar fill before the
// result card replaces it.
function animateProgressToComplete(messageId, done) {
  const el = document.getElementById(`msg-${messageId}`);
  let st = progressBubbleState.get(messageId);
  if (!el || !st) {
    setTimeout(done, 2000);
    return;
  }

  st.completing = true;
  if (Array.isArray(st.checklist)) {
    st.checklist = st.checklist.map(item => ({ ...item, done: true }));
  }
  const startPct = computeProgressPct(st.createdAtMs, st.firstSeenMs);
  const startTs = performance.now();
  const fillDurationMs = 1600;

  const step = (now) => {
    const elapsed = now - startTs;
    const k = Math.min(1, elapsed / fillDurationMs);
    const eased = 1 - Math.pow(1 - k, 3);
    st.overridePct = startPct + (100 - startPct) * eased;
    paintProgressBubble(el, st);
    if (k < 1 && el.isConnected && el.classList.contains('chat-bubble--progress')) {
      requestAnimationFrame(step);
    }
  };
  requestAnimationFrame(step);

  setTimeout(done, 2000);
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
      if (msg.type === 'question' || msg.type === 'answer') continue;
      if (msg.content === 'preparing_next_update') continue;
      if (msg.type === 'balance_error') continue;   // client-only, never re-render on re-entry
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

    const hasActiveProgress = data.messages.some(m => m.type === 'progress' && (m.percent || 0) < 100);
    if (hasActiveProgress) {
      processingProjectIds.add(projectId);
      isProcessing = true;
      setInputDisabled(true);
      setHeaderWorking(true);
      hidePlanActions();
    }

    if (data.finalizing) {
      setInputFinalizing(true);
      setInputDisabled(true);
    }

    skelEl.classList.add('hidden');
    scrollToBottom(true);
  } catch (err) {
    console.error('Failed to load chat history:', err);
    skelEl.classList.add('hidden');
  }
}

function appendMessage(msg, animate = true) {
  if (!chatHasMessages) {
    chatHasMessages = true;
    clearPromptSamples();
  }
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
    el.className = 'chat-bubble';
    const bal = Number(msg.metadata?.credits ?? msg.metadata?.balance ?? userCredits ?? 0);
    renderBalancePromptCard(el, bal);
    if (isProcessing) {
      setProcessing(false);
      setInputDisabled(false);
      setTyping(false);
      setHeaderWorking(false);
    }
    // Refresh eligibility + payment count in the background so the card
    // reflects the latest state (e.g. user just made their first deposit
    // in another tab).
    fetch(`${API_BASE}/balance`, { headers: apiHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!d) return;
        userBalance = d.balance;
        userCredits = d.credits ?? d.balance ?? 0;
        if (d.tierId) userTierId = d.tierId;
        if (d.tier) userTierData = d.tier;
        if (d.allTiers?.length) allTiers = d.allTiers;
        if (d.creditsPerDollar) creditsPerDollar = d.creditsPerDollar;
        userPaymentCount = d.paymentCount ?? 0;
        firstDepositBonusEligible = !!d.firstDepositBonusEligible;
        if (typeof d.firstDepositBonusPercent === 'number') {
          firstDepositBonusPercent = d.firstDepositBonusPercent;
        }
        const fresh = el.parentElement?.querySelector(`#${el.id}`);
        if (fresh) renderBalancePromptCard(fresh, userCredits);
      })
      .catch(() => {});
  } else if (msg.content === 'preparing_next_update' || msg.metadata?.preparing) {
    setInputFinalizing(true);
    return;
  } else if (msg.type === 'error') {
    el.className = 'chat-bubble chat-bubble--error';
    el.innerHTML = `<div class="chat-bubble-content">${esc(msg.content)}</div>`;
    if (isProcessing) {
      setProcessing(false);
      setInputDisabled(false);
      setTyping(false);
      setHeaderWorking(false);
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
    let html = `<div class="chat-result-header">${t('chat_update_completed') || 'Update Completed'}</div>`;
    html += `<div class="chat-bubble-content">${formatContent(msg.content)}</div>`;
    const changelogUrl = msg.metadata?.changelogUrl;
    if (changelogUrl) {
      html += `<div class="changelog-card" onclick="tg.openLink('${changelogUrl}', {try_instant_view: true})">
        <div class="changelog-card-text">
          <div class="changelog-card-title">${t('version_change_log')}</div>
          <div class="changelog-card-desc">Telegraph</div>
        </div>
        <div class="changelog-card-arrow">›</div>
      </div>`;
    }
    html += resultActionsHtml(msg.metadata?.projectId || chatProjectId);
    if (typeof msg.costUsd === 'number') {
      html += `<div class="chat-progress-cost">Cost: $${msg.costUsd.toFixed(4)}${typeof msg.balance === 'number' ? ` · Balance: ${Math.floor(msg.balance)}` : ''}</div>`;
    }
    html += linkBotCardHtml(msg.metadata?.projectId || chatProjectId);
    html += `<div class="chat-bubble-time">${timeStr(msg.timestamp)}</div>`;
    el.innerHTML = html;
  } else if (msg.type === 'plan') {
    el.className = 'chat-bubble chat-bubble--assistant chat-bubble--plan';
    let html = `<div class="chat-plan-content">${formatContent(msg.content)}</div>`;
    if (typeof msg.metadata?.costUsd === 'number') {
      html += `<div class="chat-progress-cost">Cost: $${msg.metadata.costUsd.toFixed(4)}${typeof msg.metadata?.balance === 'number' ? ` · Balance: ${Math.floor(msg.metadata.balance)}` : ''}</div>`;
    }
    const planPrice = userTierData?.pricing?.create ?? userTierData?.pricing?.plan ?? null;
    const planPriceTag = planPrice != null ? `<span class="plan-btn-price">${coinSvg(11, 8, '#fbbf24')}${Number(planPrice).toLocaleString()}</span>` : '';
    html += `<div class="chat-plan-actions">
      <button class="chat-plan-btn chat-plan-btn--build" onclick="approvePlan()">${t('chat_lets_build')}${planPriceTag}</button>
      <button class="chat-plan-btn chat-plan-btn--edit" onclick="startEditPlan()">${t('chat_edit')}</button>
    </div>`;
    el.innerHTML = html;
  } else if (msg.type === 'progress') {
    renderProgressBubble(msg, true);
    return;
  } else {
    const cls = msg.role === 'system' ? 'chat-bubble--system' : 'chat-bubble--assistant';
    el.className = `chat-bubble ${cls}`;
    let html = `<div class="chat-bubble-content">${formatContent(msg.content)}</div>`;
    if (typeof msg.costUsd === 'number' && msg.costUsd > 0) {
      html += `<div class="chat-progress-cost">Cost: $${msg.costUsd.toFixed(4)}${typeof msg.balance === 'number' ? ` · Balance: ${Math.floor(msg.balance)}` : ''}</div>`;
    }
    html += `<div class="chat-bubble-time">${timeStr(msg.timestamp)}</div>`;
    el.innerHTML = html;
  }

  if (!animate) el.style.animation = 'none';
  inner.appendChild(el);

  if (msg.type !== 'result' && msg.type !== 'question' && msg.type !== 'balance_error' && msg.type !== 'error' && msg.type !== 'progress') {
    requestAnimationFrame(() => {
      const collapsible = el.querySelector('.chat-bubble-content') || el.querySelector('.chat-plan-content');
      if (!collapsible) return;
      const MAX_H = 280;
      if (collapsible.scrollHeight > MAX_H) {
        el.classList.add('collapsed-msg');
        const btn = document.createElement('button');
        btn.className = 'msg-expand-btn';
        btn.textContent = t('chat_show_more') || 'Show more';
        btn.addEventListener('click', () => {
          haptic('light');
          const isCollapsed = el.classList.toggle('collapsed-msg');
          btn.textContent = isCollapsed ? (t('chat_show_more') || 'Show more') : (t('chat_show_less') || 'Show less');
        });
        collapsible.parentNode.insertBefore(btn, collapsible.nextSibling);
      }
    });
  }
}

// Per-bubble cached state so the dynamic progress timer can re-render without
// re-receiving the message body. Keyed by message id.
const progressBubbleState = new Map();

// ── Agent process state persistence ──────────────────────────────────────────
// Saves the full agent timeline (think-blocks + step-cards + footer) to
// localStorage so the user sees the same view after navigating back to a chat
// that still has a running (or recently-finished) agent.
// Keyed by message ID. Structure: { narrations: [...], steps: [...], footer: {} }
const agentProcState = new Map();

function ensureAgentProcState(messageId) {
  if (!agentProcState.has(messageId)) {
    try {
      const raw = localStorage.getItem('af_proc_' + messageId);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed._seq !== 'number') parsed._seq = Math.max((parsed.narrations?.length || 0), (parsed.steps?.length || 0));
        agentProcState.set(messageId, parsed);
        return agentProcState.get(messageId);
      }
    } catch {}
    agentProcState.set(messageId, { narrations: [], steps: [], footer: {}, _seq: 0 });
  }
  return agentProcState.get(messageId);
}

function persistAgentProcState(messageId) {
  const st = agentProcState.get(messageId);
  if (!st) return;
  try { localStorage.setItem('af_proc_' + messageId, JSON.stringify(st)); } catch {}
}

function clearAgentProcState(messageId) {
  agentProcState.delete(messageId);
  try { localStorage.removeItem('af_proc_' + messageId); } catch {}
}

function restoreAgentProcessCard(el, state, isRunning) {
  el.classList.add('agent-process');
  el.innerHTML = '';

  // Merge narrations and steps into a single chronological list using the
  // `order` stamp written at push time. Items without an order (legacy saves)
  // fall back to narrations-then-steps to preserve previous behaviour.
  const narrations = (state.narrations || []).map(n => ({ ...n, _kind: 'narration' }));
  const steps      = (state.steps      || []).map(s => ({ ...s, _kind: 'step' }));
  const hasOrder   = [...narrations, ...steps].some(x => typeof x.order === 'number');
  const items = hasOrder
    ? [...narrations, ...steps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    : [...narrations, ...steps];  // legacy: narrations first

  for (const item of items) {
    if (item._kind === 'narration') {
      const n = item;
      const block = document.createElement('div');
      block.id = 'narr-' + n.stepId;
      block.className = 'agent-think-block ' + (n.done ? 'done' : 'running');
      block.innerHTML = `
        <div class="agent-think-header">
          <span class="agent-think-icon">${n.done ? AGENT_DONE_SVG : '<span class="step-spinner"></span>'}</span>
          <span class="agent-think-preview">${esc(n.preview || 'Thinking\u2026')}</span>
          <span class="agent-think-toggle">\u203a</span>
        </div>
        <div class="agent-think-body">${n.body ? formatContent(n.body) : ''}</div>`;
      if (n.done) {
        const hdr = block.querySelector('.agent-think-header');
        hdr.addEventListener('click', () => block.classList.toggle('open'));
      }
      el.appendChild(block);
    } else {
      const s = item;
      const targetHtml = (s.target?.file || s.target?.url || s.target?.key)
        ? `<div class="agent-step-target">${esc(s.target.file || s.target.url || s.target.key || '')}</div>` : '';
      const statusClass = s.status === 'error' ? 'agent-step--error'
        : s.status === 'running' ? 'agent-step--running' : 'agent-step--done';
      const iconHtml = s.status === 'error'
        ? '<svg class="step-svg-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="3" x2="13" y2="13"/><line x1="13" y1="3" x2="3" y2="13"/></svg>'
        : agentStepIcon(s.kind);
      let metaHtml = '';
      if (s.meta) {
        const m = s.meta, bits = [];
        if (typeof m.lines === 'number') bits.push(`<span class="meta-neutral">${m.lines} lines</span>`);
        if (typeof m.added === 'number' && m.added > 0) bits.push(`<span class="meta-added">+${m.added}</span>`);
        if (typeof m.removed === 'number' && m.removed > 0) bits.push(`<span class="meta-removed">-${m.removed}</span>`);
        if (typeof m.bytes === 'number') bits.push(`<span class="meta-neutral">${(m.bytes/1024).toFixed(1)}KB</span>`);
        if (m.error) bits.push(`<span class="meta-removed">${esc(m.error)}</span>`);
        if (bits.length) metaHtml = `<div class="agent-step-meta">${bits.join('')}</div>`;
      }
      const step = document.createElement('div');
      step.id = 'step-' + s.stepId;
      step.className = `agent-step ${statusClass}`;
      step.innerHTML = `
        <div class="agent-step-icon agent-step-icon--kind">${iconHtml}</div>
        <div class="agent-step-body">
          <div class="agent-step-title">${esc(s.title || s.kind || '')}</div>
          ${targetHtml}${metaHtml}
        </div>`;
      el.appendChild(step);
    }
  }
  const f = state.footer || {};
  if ((typeof f.costUsd === 'number' && f.costUsd > 0) || isRunning) {
    const footer = document.createElement('div');
    footer.className = 'agent-footer';
    let fHtml = '';
    if (typeof f.costUsd === 'number' && f.costUsd > 0) {
      fHtml += `<div class="chat-progress-cost">${t('chat_cost')}: $${f.costUsd.toFixed(4)}${typeof f.balance === 'number' ? ` \u00b7 ${t('chat_balance')}: ${Math.floor(f.balance)}` : ''}</div>`;
    }
    if (isRunning) {
      fHtml += `<button class="chat-abort-btn" onclick="abortProcess()">${t('chat_stop_update')}</button>`;
    }
    footer.innerHTML = fHtml;
    el.appendChild(footer);
  }
}
let progressTimer = null;

// Formula per product spec: y = 1 - e^(-x/100) where x is elapsed seconds.
// Result is in [0, 1). We render in percent and cap at 99 so the bar never
// claims to be done until the server actually flips the message to `result`.
//
// Dual anchor (server + client) so the bar never stalls:
//   - serverElapsed = now - createdAtMs ........ resumes correctly after reload
//   - clientElapsed = now - firstSeenMs ........ immune to client clock skew
// We take the MAX. If the device clock is behind the server (very common on
// mobile — Telegram users in airplane mode, NTP not synced, etc.), the server
// anchor would clamp to 0 for tens of seconds; the client anchor keeps moving
// from the moment the bubble appears so the user always sees progress.
function computeProgressPct(createdAtMs, firstSeenMs) {
  const now = Date.now();
  const serverElapsedSec = createdAtMs && !isNaN(createdAtMs)
    ? Math.max(0, (now - createdAtMs) / 1000)
    : 0;
  const clientElapsedSec = firstSeenMs && !isNaN(firstSeenMs)
    ? Math.max(0, (now - firstSeenMs) / 1000)
    : 0;
  const elapsedSec = Math.max(serverElapsedSec, clientElapsedSec);
  if (elapsedSec <= 0) return 0;
  const y = 1 - Math.exp(-elapsedSec / 100);
  return Math.min(99, Math.max(0, y * 100));
}

function ensureProgressTimer() {
  if (progressTimer) return;
  progressTimer = setInterval(() => {
    if (progressBubbleState.size === 0) {
      clearInterval(progressTimer);
      progressTimer = null;
      return;
    }
    for (const [id, st] of progressBubbleState) {
      const el = document.getElementById(`msg-${id}`);
      if (!el || !el.classList.contains('chat-bubble--progress')) {
        progressBubbleState.delete(id);
        continue;
      }
      paintProgressBubble(el, st);
    }
  }, 1000);
}

function removeEmoji(str) {
  return str
    .replace(/\p{Extended_Pictographic}/gu, '') // emojis
    .replace(/\p{Emoji_Component}/gu, '')        // skin tones, ZWJ, variation selectors, flag letters
    .replace(/\s+/g, ' ')                        // clean up double spaces left behind
    .trim();
}

function paintProgressBubble(el, st) {
  // Agent-process mode handled by updateProgressBubble (footer only).
  if (el && el.classList.contains('agent-process')) {
    setHeaderWorking(true);
    return;
  }
  const pct = (typeof st.overridePct === 'number') ? st.overridePct : computeProgressPct(st.createdAtMs, st.firstSeenMs);
  const pctRounded = Math.floor(pct);
  let html = `<div class="chat-progress-text"><span class="loader"></span> ${t('chat_working')} <b>${pctRounded}%</b></div>`;
  html += `<div class="chat-progress-bar"><div class="chat-progress-fill" style="width:${pct}%"></div></div>`;

  if (st.checklist && st.checklist.length > 0) {
    html += renderChecklist(st.checklist);
  }

  if (st.statusText) {
    html += `<div class="chat-progress-status">${removeEmoji(esc(st.statusText))}</div>`;
  }

  if (typeof st.costUsd === 'number' && st.costUsd > 0) {
    html += `<div class="chat-progress-cost">${t('chat_cost')}: $${st.costUsd.toFixed(4)}${typeof st.balance === 'number' ? ` · ${t('chat_balance')}: ${Math.floor(st.balance)}` : ''}</div>`;
  }

  if (!st.completing) {
    html += `<button class="chat-abort-btn" onclick="abortProcess()">${t('chat_stop_update')}</button>`;
  }

  el.innerHTML = html;
  setHeaderWorking(true, pctRounded);
}

function parseUtc(s) {
  if (!s) return 0;
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;
}

function renderProgressBubble(msg, fromHistory = false) {
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

  // If we have a saved agent process timeline, restore it instead of the
  // plain progress bar — the user will see the same step/narration view
  // they saw during the live streaming run.
  const savedProcState = (() => {
    if (agentProcState.has(msg.id)) return agentProcState.get(msg.id);
    try {
      const raw = localStorage.getItem('af_proc_' + msg.id);
      if (raw) {
        const parsed = JSON.parse(raw);
        agentProcState.set(msg.id, parsed);
        return parsed;
      }
    } catch {}
    return null;
  })();
  if (savedProcState && (savedProcState.narrations?.length || savedProcState.steps?.length)) {
    restoreAgentProcessCard(el, savedProcState, (msg.percent || 0) < 100);
    setProcessing(true);
    setInputDisabled(true);
    setTyping(false);
    if (isNew) scrollToBottom();
    return;
  }

  // Prefer createdAtUtc (server-issued ISO string); fall back to local
  // `timestamp` (ms) which has been on the message forever; finally fall back
  // to "now" so the bar at least starts animating from this moment.
  const createdAtMs = parseUtc(msg.createdAtUtc) || (msg.timestamp ? Number(msg.timestamp) : 0) || Date.now();

  // Preserve any pre-existing client anchor so re-renders don't reset the
  // skew-immune timer (otherwise the bar would visually restart on every
  // websocket update for the same bubble).
  const prev = progressBubbleState.get(msg.id);
  const firstSeenMs = (prev && prev.firstSeenMs) ? prev.firstSeenMs : Date.now();

  const st = {
    createdAtMs,
    firstSeenMs,
    checklist: msg.checklist || null,
    statusText: (msg.content && msg.content !== 'Starting...') ? msg.content : null,
    costUsd: typeof msg.costUsd === 'number' ? msg.costUsd : null,
    balance: typeof msg.balance === 'number' ? msg.balance : null,
  };
  progressBubbleState.set(msg.id, st);
  paintProgressBubble(el, st);
  ensureProgressTimer();

  // If loaded from history and still in-progress, mark stale until WS updates
  if (fromHistory && (msg.percent || 0) < 100) {
    el.classList.add('progress-bubble--stale');
    if (!el.querySelector('.progress-stale-sync')) {
      const syncEl = document.createElement('div');
      syncEl.className = 'progress-stale-sync';
      syncEl.textContent = t('chat_syncing') || 'Syncing…';
      el.appendChild(syncEl);
    }
  }

  setProcessing(true);
  setInputDisabled(true);
  setTyping(false);
  if (isNew) scrollToBottom();
}

function updateProgressBubble(data) {
  const el = document.getElementById(`msg-${data.messageId}`);
  if (!el) return;

  // Clear stale indicator on first live WS update
  if (el.classList.contains('progress-bubble--stale')) {
    el.classList.remove('progress-bubble--stale');
    el.querySelector('.progress-stale-sync')?.remove();
  }

  let st = progressBubbleState.get(data.messageId);
  if (!st) {
    st = { createdAtMs: Date.now(), firstSeenMs: Date.now(), checklist: null, statusText: null, costUsd: null, balance: null };
    progressBubbleState.set(data.messageId, st);
  }
  if (data.checklist && data.checklist.length > 0) st.checklist = data.checklist;
  if (data.message) st.statusText = data.message;
  if (typeof data.costUsd === 'number') st.costUsd = data.costUsd;
  if (typeof data.balance === 'number') st.balance = data.balance;

  // In agent-process mode: only update the cost/abort footer. No percent bar,
  // no checklist — those are replaced by the think-block timeline.
  if (el.classList.contains('agent-process')) {
    let footer = el.querySelector('.agent-footer');
    if (!footer) {
      footer = document.createElement('div');
      footer.className = 'agent-footer';
      el.appendChild(footer);
    }
    let html = '';
    if (typeof st.costUsd === 'number' && st.costUsd > 0) {
      html += `<div class="chat-progress-cost">${t('chat_cost')}: $${st.costUsd.toFixed(4)}${typeof st.balance === 'number' ? ` · ${t('chat_balance')}: ${Math.floor(st.balance)}` : ''}</div>`;
    }
    if (!st.completing) {
      html += `<button class="chat-abort-btn" onclick="abortProcess()">${t('chat_stop_update')}</button>`;
    }
    footer.innerHTML = html;
    // Show/hide the "agent is still working" ghost step
    let ghost = el.querySelector('.agent-step--ghost');
    if (!st.completing) {
      if (!ghost) {
        ghost = document.createElement('div');
        ghost.className = 'agent-step agent-step--ghost';
        ghost.innerHTML = `<div class="agent-step-icon"><span class="step-spinner"></span></div><div class="agent-step-body"><div class="agent-step-title agent-step-title--ghost"></div></div>`;
        el.insertBefore(ghost, footer);
      }
    } else {
      if (ghost) ghost.remove();
    }
    // Persist footer cost/balance so they survive navigation
    const _apst5 = agentProcState.get(data.messageId);
    if (_apst5) {
      if (!_apst5.footer) _apst5.footer = {};
      if (typeof st.costUsd === 'number') _apst5.footer.costUsd = st.costUsd;
      if (typeof st.balance === 'number') _apst5.footer.balance = st.balance;
      persistAgentProcState(data.messageId);
    }
    setHeaderWorking(true);
    return;
  }

  paintProgressBubble(el, st);
  ensureProgressTimer();
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

async function abortProcess() {
  if (!currentProject) return;
  tg?.showConfirm('Are you sure you want to stop the current process?', async (ok) => {
    if (!ok) return;
    try {
      const res = await fetch(`${API_BASE}/chat/${currentProject.id}/abort`, {
        method: 'POST',
        headers: apiHeaders(),
      });
      const data = await res.json();
      if (data.ok) {
        setProcessing(false);
        setInputDisabled(false);
        setHeaderWorking(false);
        showToast('Process stopped', 'success');
      } else {
        showToast(data.error || 'Failed to stop', 'error');
      }
    } catch {
      showToast('Failed to stop process', 'error');
    }
  });
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
    setProcessing(true);
    setInputDisabled(true);
  } else {
    setTyping(true);
  }

  try {
    const body = { text, type, tierId: userTierId };
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

  document.querySelectorAll('.chat-bubble--question').forEach(el => {
    el.style.transition = 'opacity 0.3s, transform 0.3s';
    el.style.opacity = '0';
    el.style.transform = 'scale(0.95)';
    setTimeout(() => el.remove(), 300);
  });

  try {
    await fetch(`${API_BASE}/chat/${chatProjectId}/answer`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer }),
    });
  } catch (err) {
    console.error('Failed to send answer:', err);
  }
}

async function sendPlanRequest(description, opts = {}) {
  const welcome = document.getElementById('chat-welcome');
  welcome.classList.add('hidden');

  // Optimistically render the user's prompt only on the first attempt — when
  // we retry after the preferences modal saves we keep the existing bubble.
  // We track the bubble id so a Back-out from the prefs modal can remove
  // it and restore the chat to its pre-prompt "plan-ready" state.
  let userBubbleId = opts.userBubbleId || null;
  if (!opts.skipUserBubble) {
    userBubbleId = 'plan-user-' + Date.now();
    appendMessage({ role: 'user', type: 'text', content: description, id: userBubbleId, timestamp: Date.now() });
  }

  // Before hitting /plan, make sure preferences exist. The server also
  // enforces this with a 412 — this client check just avoids the round-trip.
  if (!opts.skipPrefsCheck) {
    try {
      const prefsRes = await fetch(`${API_BASE}/chat/${chatProjectId}/preferences`, {
        headers: { ...apiHeaders() },
      });
      if (prefsRes.ok) {
        const prefsData = await prefsRes.json();
        if (!prefsData.current) {
          openPreferencesModal({
            initial: null,
            catalog: prefsData.catalog,
            userBubbleId,
            description,
            onSaved: () => sendPlanRequest(description, { skipUserBubble: true, skipPrefsCheck: true, userBubbleId }),
          });
          return;
        }
      }
    } catch (err) {
      console.warn('[prefs] pre-flight check failed, will rely on 412:', err);
    }
  }

  setTyping(true);
  setInputDisabled(true);

  try {
    const res = await fetch(`${API_BASE}/chat/${chatProjectId}/plan`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ description, tierId: userTierId }),
    });

    setTyping(false);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 412 && err.error === 'preferences_required') {
        // Server says we still don't have prefs — open the modal then retry.
        setInputDisabled(false);
        openPreferencesModal({
          initial: null,
          userBubbleId,
          description,
          onSaved: () => sendPlanRequest(description, { skipUserBubble: true, skipPrefsCheck: true, userBubbleId }),
        });
        return;
      }
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

// ═════════════════════════════════════════════════════════════════════
// Preferences modal — full-screen pre-plan questionnaire.
// Opens after the user's first prompt and BEFORE /plan can run.
// Captures Style + Theme + Header + Density + Bottom-menu and persists
// them on the project. The agent rules baked into each option become
// hard constraints in the planner + build prompts.
// ═════════════════════════════════════════════════════════════════════

// `prefModalState` shape:
//   { catalog, selection, onSaved, projectId, stepIndex, totalSteps,
//     userBubbleId, description }
//
// `userBubbleId` is the optimistic chat bubble that was rendered for the
// user's prompt that triggered the modal. Pressing Telegram BackButton
// while the modal is open removes it and reverts the chat to the pre-prompt
// "plan-ready" state.
let prefModalState = null;
let prefModalCatalogCache = null;
const PREF_AUTO_ADVANCE_MS = 280;
const PREF_AUTO_VALUE = '__auto__';

async function loadPreferencesCatalog(projectId) {
  if (prefModalCatalogCache) return prefModalCatalogCache;
  const res = await fetch(`${API_BASE}/chat/${projectId}/preferences`, { headers: { ...apiHeaders() } });
  if (!res.ok) throw new Error(`prefs fetch failed: ${res.status}`);
  const data = await res.json();
  prefModalCatalogCache = data;
  return data;
}

async function openPreferencesModal({ initial, catalog, onSaved, userBubbleId, description } = {}) {
  if (!chatProjectId) return;
  const modal = document.getElementById('preferences-modal');
  if (!modal) {
    console.warn('[prefs] modal element missing');
    return;
  }

  let payload;
  if (catalog) {
    payload = { catalog, current: initial };
  } else {
    try {
      payload = await loadPreferencesCatalog(chatProjectId);
    } catch (err) {
      console.error('[prefs] failed to load catalog', err);
      return;
    }
  }

  // Default everything to AUTO so the user explicitly opts INTO opinions
  // for the categories that matter to them, instead of the modal silently
  // pre-picking some style they didn't ask for.
  const selection = { ...(initial || payload.current || {}) };
  for (const cat of payload.catalog) {
    if (selection[cat.id] == null) selection[cat.id] = PREF_AUTO_VALUE;
  }

  prefModalState = {
    catalog: payload.catalog,
    selection,
    onSaved,
    projectId: chatProjectId,
    stepIndex: 0,
    visibleCatalog: [],
    totalSteps: 0,
    userBubbleId: userBubbleId || null,
    description: description || '',
  };

  // Drop any selections that don't belong under the current `kind` so the
  // first render shows a clean state.
  clearHiddenSelections();

  // Always reset the submit button before rendering so stale busy/disabled
  // state from a previous session (e.g. a failed or cancelled submit) never
  // leaks into the freshly opened modal.
  const _submitBtn = document.getElementById('pref-modal-submit');
  if (_submitBtn) {
    _submitBtn.disabled = false;
    _submitBtn.classList.remove('busy', 'waiting-for-bot', 'ready');
  }

  renderPreferencesModal();
  bindPrefModalChrome();
  goToPrefStep(0, { animate: false });

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.classList.add('pref-modal-open');
  applyPrefModalChromeColors();
}

function closePreferencesModal() {
  const modal = document.getElementById('preferences-modal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.classList.remove('pref-modal-open');
  prefModalState = null;
  restoreChromeColors();
}

/**
 * Cancel the prefs modal (Telegram BackButton from step 0). Removes the
 * optimistically-rendered user bubble that triggered the prompt, restores
 * the chat input to a clean plan-ready state, and closes the modal without
 * persisting anything.
 */
function cancelPreferencesModal() {
  if (!prefModalState) return;
  const { userBubbleId } = prefModalState;
  closePreferencesModal();
  if (userBubbleId) {
    const bubbleEl = document.getElementById('msg-' + userBubbleId);
    if (bubbleEl) bubbleEl.remove();
  }
  // If the chat is now empty, bring back the welcome screen.
  const inner = document.getElementById('chat-messages-inner');
  if (inner && inner.children.length === 0) {
    const welcome = document.getElementById('chat-welcome');
    if (welcome) welcome.classList.remove('hidden');
  }
  setInputDisabled(false);
}

const PREF_MODAL_CHROME = '#0F1011';
const DEFAULT_CHROME = '#000000';

function applyPrefModalChromeColors() {
  if (!tg) return;
  try { tg.setHeaderColor(PREF_MODAL_CHROME); } catch {}
  try { tg.setBackgroundColor(PREF_MODAL_CHROME); } catch {}
  try { if (typeof tg.setBottomBarColor === 'function') tg.setBottomBarColor(PREF_MODAL_CHROME); } catch {}
}

function restoreChromeColors() {
  if (!tg) return;
  try { tg.setHeaderColor(DEFAULT_CHROME); } catch {}
  try { tg.setBackgroundColor(DEFAULT_CHROME); } catch {}
  try { if (typeof tg.setBottomBarColor === 'function') tg.setBottomBarColor(DEFAULT_CHROME); } catch {}
}

/**
 * Resolve a gating value the same way the backend does (AUTO collapses to
 * the catalog default — see `resolveGatingValue` in
 * `src/services/preferences.catalog.ts`). Used by `isCatActive` below to
 * gate game-only / app-only categories on the live selection.
 */
function prefDefaultFor(catId) {
  const cat = (prefModalState && prefModalState.catalog.find((c) => c.id === catId));
  if (!cat || !cat.options || !cat.options.length) return null;
  // Prefer an explicit default; otherwise the first option keeps modal
  // behaviour deterministic. The catalog ships `kind` first with `app`
  // as its first option, which matches the backend default.
  return cat.options[0].id;
}

function prefResolveGating(catId) {
  if (!prefModalState) return null;
  const v = prefModalState.selection[catId];
  if (!v || v === PREF_AUTO_VALUE) return prefDefaultFor(catId);
  return v;
}

function isCatActive(cat) {
  if (!cat.appliesWhen) return true;
  for (const [key, allowed] of Object.entries(cat.appliesWhen)) {
    if (!Array.isArray(allowed) || allowed.length === 0) continue;
    const actual = prefResolveGating(key);
    if (!allowed.includes(actual)) return false;
  }
  return true;
}

/**
 * Returns the live list of categories the user is actually walking through.
 * Game-only categories disappear when Kind = App, and vice-versa.
 *
 * Caches on `prefModalState.visibleCatalog` so other helpers (step counter,
 * navigation, submit) all read off the same array.
 */
function computeVisibleCatalog() {
  if (!prefModalState) return [];
  const visible = prefModalState.catalog.filter(isCatActive);
  prefModalState.visibleCatalog = visible;
  prefModalState.totalSteps = visible.length;
  return visible;
}

function renderPreferencesModal() {
  if (!prefModalState) return;
  const stepsEl = document.getElementById('pref-steps');
  const progressEl = document.getElementById('pref-modal-progress');
  if (!stepsEl) return;

  stepsEl.innerHTML = '';
  if (progressEl) progressEl.innerHTML = '';

  const visible = computeVisibleCatalog();
  const total = visible.length;
  visible.forEach((cat, idx) => {
    const catLabel = prefCategoryLabel(cat);
    const catPrompt = prefCategoryPrompt(cat);

    const step = document.createElement('section');
    step.className = 'pref-step';
    step.dataset.cat = cat.id;
    step.dataset.idx = String(idx);
    step.setAttribute('aria-hidden', 'true');

    const isAuto = prefModalState.selection[cat.id] === PREF_AUTO_VALUE;
    step.innerHTML = `
      <div class="pref-step-header">
        <span class="pref-step-eyebrow">${escapeHtml(catLabel)}</span>
        <h2 class="pref-step-title">${escapeHtml(catPrompt)}</h2>
      </div>
      <button type="button" class="pref-auto-btn ${isAuto ? 'selected' : ''}" data-cat="${cat.id}">
        <span class="pref-auto-btn-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/><circle cx="12" cy="12" r="3"/></svg>
        </span>
        <span class="pref-auto-btn-text">
          <span class="pref-auto-btn-title">${escapeHtml(t('pref_modal_auto'))}</span>
          <span class="pref-auto-btn-sub">${escapeHtml(t('pref_modal_auto_desc'))}</span>
        </span>
        <span class="pref-auto-btn-check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>
        </span>
      </button>
      <div class="pref-step-grid"></div>
    `;

    const grid = step.querySelector('.pref-step-grid');
    grid.classList.add(`pref-step-grid--${cat.id}`);

    const autoBtn = step.querySelector('.pref-auto-btn');
    autoBtn.addEventListener('click', () => onPrefAutoPick(cat.id, step, idx));

    for (const opt of cat.options) {
      const optLabel = prefOptionLabel(cat.id, opt);
      const optDesc = prefOptionDesc(cat.id, opt);

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'pref-card';
      card.dataset.cat = cat.id;
      card.dataset.opt = opt.id;
      if (prefModalState.selection[cat.id] === opt.id) card.classList.add('selected');

      card.innerHTML = `
        <div class="pref-card-preview">${renderPreferencePreview({ ...opt, label: optLabel })}</div>
        <div class="pref-card-meta">
          <div class="pref-card-label">${escapeHtml(optLabel)}</div>
          <div class="pref-card-desc">${escapeHtml(optDesc)}</div>
        </div>
        <div class="pref-card-check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>
        </div>
      `;

      card.addEventListener('click', () => onPrefCardPick(cat.id, opt.id, card, step, idx));
      grid.appendChild(card);
    }

    // Append a non-interactive "AI Agent (soon)" teaser card in the kind step.
    if (cat.id === 'kind') {
      const agentLabel = t('pref_opt_kind_aiAgent_label') || 'AI Agent';
      const agentDesc  = t('pref_opt_kind_aiAgent_desc')  || 'Autonomous agent that acts on its own. No UI — just results.';
      const soonLabel  = t('pref_soon') || 'Soon';
      const teaser = document.createElement('div');
      teaser.className = 'pref-card pref-card--soon';
      teaser.setAttribute('aria-disabled', 'true');
      teaser.innerHTML = `
        <div class="pref-card-preview">
          ${renderAiAgentPreviewCard()}
        </div>
        <div class="pref-card-meta">
          <div class="pref-card-label">
            ${escapeHtml(agentLabel)}
            <span class="pref-soon-badge">${escapeHtml(soonLabel)}</span>
          </div>
          <div class="pref-card-desc">${escapeHtml(agentDesc)}</div>
        </div>
      `;
      grid.appendChild(teaser);
    }

    stepsEl.appendChild(step);

    if (progressEl) {
      const dot = document.createElement('span');
      dot.className = 'pref-progress-dot';
      dot.dataset.idx = String(idx);
      dot.addEventListener('click', () => goToPrefStep(idx));
      progressEl.appendChild(dot);
    }
  });

  // Translate the static modal chrome (submit / back labels).
  const submitBtn = document.getElementById('pref-modal-submit');
  if (submitBtn && !submitBtn.classList.contains('busy')) {
    submitBtn.textContent = textBotNeedsBotFirst() ? t('pref_modal_create_bot') : t('pref_modal_submit');
  }
  const backBtn = document.getElementById('pref-modal-back');
  if (backBtn) backBtn.setAttribute('aria-label', t('pref_modal_back'));
}

// ── i18n lookups for catalog entries ────────────────────────────────
// Catalog ships with English labels/descriptions baked in; the mini-app
// looks for a matching i18n key first and falls back to the catalog
// string so adding a new option doesn't require touching i18n.js.
function prefCategoryLabel(cat) {
  const key = `pref_cat_${cat.id}_label`;
  const v = t(key);
  return v === key ? (cat.label || cat.id) : v;
}
function prefCategoryPrompt(cat) {
  const key = `pref_cat_${cat.id}_prompt`;
  const v = t(key);
  return v === key ? (cat.prompt || cat.label || '') : v;
}
function prefOptionLabel(catId, opt) {
  const key = `pref_opt_${catId}_${opt.id}_label`;
  const v = t(key);
  return v === key ? (opt.label || opt.id) : v;
}
function prefOptionDesc(catId, opt) {
  const key = `pref_opt_${catId}_${opt.id}_desc`;
  const v = t(key);
  return v === key ? (opt.description || '') : v;
}

function bindPrefModalChrome() {
  const submitBtn = document.getElementById('pref-modal-submit');
  if (submitBtn && !submitBtn.dataset.bound) {
    submitBtn.dataset.bound = '1';
    submitBtn.addEventListener('click', submitPreferences);
  }
  const backBtn = document.getElementById('pref-modal-back');
  if (backBtn && !backBtn.dataset.bound) {
    backBtn.dataset.bound = '1';
    backBtn.addEventListener('click', () => {
      if (!prefModalState) return;
      goToPrefStep(prefModalState.stepIndex - 1);
    });
  }
}

/**
 * Categories whose `appliesWhen` references *this* category, i.e. which
 * categories' visibility might change when the user picks a different
 * value here. If a gating cat changes (e.g. `kind`), the whole modal must
 * re-render because steps appear/disappear and indexes shift.
 */
function isGatingCategory(catId) {
  if (!prefModalState) return false;
  return prefModalState.catalog.some((c) => c.appliesWhen && Object.prototype.hasOwnProperty.call(c.appliesWhen, catId));
}

/**
 * Wipe selections for any category that's no longer visible under the
 * current gating, so they don't leak into the saved JSON or stale-cache
 * the modal next time it opens.
 */
function clearHiddenSelections() {
  if (!prefModalState) return;
  const visible = prefModalState.catalog.filter(isCatActive);
  const visibleIds = new Set(visible.map((c) => c.id));
  for (const cat of prefModalState.catalog) {
    if (!visibleIds.has(cat.id)) {
      prefModalState.selection[cat.id] = PREF_AUTO_VALUE;
    }
  }
}

function onPrefCardPick(catId, optId, cardEl, stepEl, stepIdx) {
  if (!prefModalState) return;
  const previous = prefModalState.selection[catId];
  prefModalState.selection[catId] = optId;
  stepEl.querySelectorAll('.pref-card').forEach((el) => el.classList.remove('selected'));
  cardEl.classList.add('selected');
  const autoBtn = stepEl.querySelector('.pref-auto-btn');
  if (autoBtn) autoBtn.classList.remove('selected');

  // If this is a gating category (e.g. `kind`), the visible step list may
  // have changed. Re-render and route to the next visible step.
  if (isGatingCategory(catId) && previous !== optId) {
    handleGatingChange(catId, stepIdx);
    return;
  }

  scheduleAutoAdvance(stepIdx);
}

function onPrefAutoPick(catId, stepEl, stepIdx) {
  if (!prefModalState) return;
  const previous = prefModalState.selection[catId];
  prefModalState.selection[catId] = PREF_AUTO_VALUE;
  stepEl.querySelectorAll('.pref-card').forEach((el) => el.classList.remove('selected'));
  const autoBtn = stepEl.querySelector('.pref-auto-btn');
  if (autoBtn) autoBtn.classList.add('selected');

  if (isGatingCategory(catId) && previous !== PREF_AUTO_VALUE) {
    handleGatingChange(catId, stepIdx);
    return;
  }

  scheduleAutoAdvance(stepIdx);
}

/**
 * The user just changed a gating category (e.g. flipped App → Game).
 * Wipe stale selections for newly-hidden categories, re-render the modal,
 * and auto-advance to whatever step now sits *after* the gating one.
 */
function handleGatingChange(gatingCatId, currentStepIdx) {
  clearHiddenSelections();
  renderPreferencesModal();
  // Find where the gating category now lives in the visible list, then
  // schedule the same auto-advance UX so the user keeps moving forward.
  const visible = prefModalState.visibleCatalog || [];
  const newIdx = visible.findIndex((c) => c.id === gatingCatId);
  const targetIdx = newIdx >= 0 ? newIdx : Math.min(currentStepIdx, visible.length - 1);
  // Keep the user on the gating step (so they see the click landed) and
  // then auto-advance into the freshly-revealed branch.
  goToPrefStep(targetIdx, { animate: false });
  scheduleAutoAdvance(targetIdx);
}

function scheduleAutoAdvance(stepIdx) {
  const isLast = stepIdx >= prefModalState.totalSteps - 1;
  if (isLast) {
    // Last step: highlight the submit button instead of auto-submitting so
    // users still get a chance to review/back out.
    const submitBtn = document.getElementById('pref-modal-submit');
    if (submitBtn) submitBtn.classList.add('ready');
    return;
  }

  setTimeout(() => {
    if (!prefModalState) return;
    if (prefModalState.stepIndex !== stepIdx) return; // user already navigated
    goToPrefStep(stepIdx + 1);
  }, PREF_AUTO_ADVANCE_MS);
}

function goToPrefStep(idx, { animate = true } = {}) {
  if (!prefModalState) return;
  const visible = prefModalState.visibleCatalog || computeVisibleCatalog();
  const total = visible.length || 1;
  const clamped = Math.max(0, Math.min(total - 1, idx));
  prefModalState.stepIndex = clamped;

  const stepsEl = document.getElementById('pref-steps');
  if (stepsEl) {
    stepsEl.querySelectorAll('.pref-step').forEach((el) => {
      const i = Number(el.dataset.idx);
      const isActive = i === clamped;
      const isBefore = i < clamped;
      if (!animate) el.classList.add('no-anim');
      el.classList.toggle('active', isActive);
      el.classList.toggle('before', isBefore);
      el.setAttribute('aria-hidden', isActive ? 'false' : 'true');
      // Land at the top of every step so the header/prompt is always visible.
      if (isActive) el.scrollTop = 0;
      if (!animate) {
        // Force reflow so removing `no-anim` doesn't restart the just-set transform.
        void el.offsetWidth;
        el.classList.remove('no-anim');
      }
    });
  }

  const progressEl = document.getElementById('pref-modal-progress');
  if (progressEl) {
    progressEl.querySelectorAll('.pref-progress-dot').forEach((el) => {
      const i = Number(el.dataset.idx);
      el.classList.toggle('done', i < clamped);
      el.classList.toggle('active', i === clamped);
    });
  }

  const counterEl = document.getElementById('pref-modal-step-counter');
  if (counterEl) counterEl.textContent = `${clamped + 1}/${total}`;

  const backBtn = document.getElementById('pref-modal-back');
  if (backBtn) backBtn.classList.toggle('hidden', clamped === 0);

  const submitBtn = document.getElementById('pref-modal-submit');
  if (submitBtn) {
    const isLast = clamped === total - 1;
    submitBtn.classList.toggle('hidden', !isLast);
    submitBtn.classList.remove('ready');
  }
}

function renderPreferencePreview(opt) {
  const spec = opt.preview || {};
  switch (spec.kind) {
    case 'style':
      return renderStylePreviewCard(opt);
    case 'theme':
      return renderThemePreviewCard(opt);
    case 'header':
      return renderHeaderPreviewCard(opt);
    case 'density':
      return renderDensityPreviewCard(opt);
    case 'bottomMenu':
      return renderBottomMenuPreviewCard(opt);
    case 'kind':
      return renderKindPreviewCard(opt);
    case 'gameDimension':
      return renderGameDimensionPreviewCard(opt);
    case 'gameGenre':
      return renderGameGenrePreviewCard(opt);
    case 'gameArtStyle':
      return renderGameArtStylePreviewCard(opt);
    case 'gameControls':
      return renderGameControlsPreviewCard(opt);
    case 'botKeyboardStyle':
      return renderBotKeyboardStylePreviewCard(opt);
    default:
      return `<div class="pref-preview-fallback">${escapeHtml(opt.label)}</div>`;
  }
}

// ── Kind / Game preview cards ───────────────────────────────────────
// Static SVG/CSS mocks only — no live Three.js inside the modal so the
// preferences screen stays light and snappy on low-end devices.

function renderKindPreviewCard(opt) {
  const variant = opt.preview.variant;
  if (variant === 'app') {
    return `
      <div class="gp-card gp-card-kind gp-card-kind-app">
        <div class="gp-phone">
          <div class="gp-phone-header"><span class="gp-bar"></span><span class="gp-bar gp-bar-sm"></span></div>
          <div class="gp-phone-body">
            <div class="gp-row"></div>
            <div class="gp-row"></div>
            <div class="gp-row"></div>
            <div class="gp-row"></div>
          </div>
          <div class="gp-phone-tabs">
            <span class="gp-dot active"></span><span class="gp-dot"></span><span class="gp-dot"></span><span class="gp-dot"></span>
          </div>
        </div>
      </div>
    `;
  }
  if (variant === 'textBot') {
    // Mini Telegram chat exchange — bot welcome → user reply → bot answer →
    // command chips. Fills the square card naturally so it doesn't look like
    // an empty bubble floating in a void.
    return `
      <div class="gp-card gp-card-kind gp-card-kind-textbot">
        <div class="tb-chat">
          <div class="tb-msg tb-msg-bot">
            <div class="tb-avatar">B</div>
            <div class="tb-bubble">
              <div class="tb-line tb-line-w-full"></div>
              <div class="tb-line tb-line-w-md"></div>
              <div class="tb-line tb-line-w-sm"></div>
            </div>
          </div>
          <div class="tb-msg tb-msg-user">
            <div class="tb-bubble tb-bubble-user">
              <div class="tb-line tb-line-w-md"></div>
              <div class="tb-line tb-line-w-sm"></div>
            </div>
          </div>
          <div class="tb-msg tb-msg-bot">
            <div class="tb-avatar">B</div>
            <div class="tb-bubble">
              <div class="tb-line tb-line-w-full"></div>
              <div class="tb-line tb-line-w-md"></div>
            </div>
          </div>
          <div class="tb-chips">
            <span class="tb-chip">/start</span>
            <span class="tb-chip">/help</span>
            <span class="tb-chip tb-chip-accent">Buy</span>
          </div>
        </div>
      </div>
    `;
  }
  // game variant — full-bleed canvas mock with iso cubes
  return `
    <div class="gp-card gp-card-kind gp-card-kind-game">
      <div class="gp-canvas">
        ${renderIsoScene()}
        <span class="gp-score">SCORE 0042</span>
      </div>
    </div>
  `;
}

// ── AI Agent teaser illustration ────────────────────────────────────
// A "coming soon" card shown in the kind grid. Not selectable.
function renderAiAgentPreviewCard() {
  return `
    <div class="gp-card gp-card-kind gp-card-kind-agent">
      <svg class="gp-iso" viewBox="0 0 120 120" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <!-- Dark background -->
        <rect width="120" height="120" fill="#0d1117"/>
        <!-- Central "brain" hexagon ring -->
        <polygon points="60,22 78,32 78,52 60,62 42,52 42,32" fill="none" stroke="rgba(139,92,246,0.55)" stroke-width="1.5"/>
        <polygon points="60,30 72,37 72,51 60,58 48,51 48,37" fill="rgba(139,92,246,0.12)"/>
        <!-- Pulsing center dot -->
        <circle cx="60" cy="44" r="6" fill="#8b5cf6" opacity="0.9"/>
        <circle cx="60" cy="44" r="10" fill="none" stroke="#8b5cf6" stroke-width="1" opacity="0.35"/>
        <!-- Connector lines to outer nodes -->
        <line x1="60" y1="44" x2="24" y2="30" stroke="rgba(139,92,246,0.4)" stroke-width="1"/>
        <line x1="60" y1="44" x2="96" y2="30" stroke="rgba(139,92,246,0.4)" stroke-width="1"/>
        <line x1="60" y1="44" x2="24" y2="80" stroke="rgba(139,92,246,0.4)" stroke-width="1"/>
        <line x1="60" y1="44" x2="96" y2="80" stroke="rgba(139,92,246,0.4)" stroke-width="1"/>
        <line x1="60" y1="44" x2="60" y2="90" stroke="rgba(139,92,246,0.4)" stroke-width="1"/>
        <!-- Outer nodes -->
        <circle cx="24" cy="30" r="4" fill="#a78bfa" opacity="0.75"/>
        <circle cx="96" cy="30" r="4" fill="#a78bfa" opacity="0.75"/>
        <circle cx="24" cy="80" r="4" fill="#6366f1" opacity="0.75"/>
        <circle cx="96" cy="80" r="4" fill="#6366f1" opacity="0.75"/>
        <circle cx="60" cy="90" r="4" fill="#a78bfa" opacity="0.75"/>
        <!-- Tiny "task" pill rows at bottom -->
        <rect x="28" y="100" width="42" height="6" rx="3" fill="rgba(139,92,246,0.22)"/>
        <rect x="28" y="110" width="28" height="6" rx="3" fill="rgba(139,92,246,0.14)"/>
      </svg>
    </div>
  `;
}

// ── Bot keyboard style previews ─────────────────────────────────────
// Shown ONLY when kind === "textBot". Tiny static mocks of the four
// Telegram-side UX patterns.
function renderBotKeyboardStylePreviewCard(opt) {
  const scheme = opt.preview.scheme;
  if (scheme === 'reply') {
    return `
      <div class="gp-card gp-card-bks">
        <div class="tb-chat tb-chat-compact">
          <div class="tb-msg tb-msg-bot">
            <div class="tb-bubble"><div class="tb-line"></div></div>
          </div>
          <div class="tb-replykb">
            <div class="tb-replykb-row">
              <span class="tb-replykb-btn">📦 Orders</span>
              <span class="tb-replykb-btn">🛒 Catalog</span>
            </div>
            <div class="tb-replykb-row">
              <span class="tb-replykb-btn">💰 Balance</span>
              <span class="tb-replykb-btn">ℹ️ Help</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }
  if (scheme === 'inline') {
    return `
      <div class="gp-card gp-card-bks">
        <div class="tb-chat tb-chat-compact">
          <div class="tb-msg tb-msg-bot">
            <div class="tb-bubble">
              <div class="tb-line"></div>
              <div class="tb-line tb-line-sm"></div>
              <div class="tb-inlinekb">
                <span class="tb-inline-btn">🛒 Buy</span>
                <span class="tb-inline-btn">← Back</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;
  }
  if (scheme === 'commands') {
    return `
      <div class="gp-card gp-card-bks">
        <div class="tb-chat tb-chat-compact">
          <div class="tb-cmdmenu">
            <div class="tb-cmdmenu-row"><span class="tb-cmd">/start</span><span class="tb-cmd-desc">Start</span></div>
            <div class="tb-cmdmenu-row"><span class="tb-cmd">/help</span><span class="tb-cmd-desc">Show all</span></div>
            <div class="tb-cmdmenu-row"><span class="tb-cmd">/buy</span><span class="tb-cmd-desc">Buy item</span></div>
          </div>
        </div>
      </div>
    `;
  }
  // mixed — reply keyboard at bottom, inline buttons on a message above
  return `
    <div class="gp-card gp-card-bks">
      <div class="tb-chat tb-chat-compact">
        <div class="tb-msg tb-msg-bot">
          <div class="tb-bubble">
            <div class="tb-line"></div>
            <div class="tb-inlinekb">
              <span class="tb-inline-btn">🛒 Buy</span>
            </div>
          </div>
        </div>
        <div class="tb-replykb">
          <div class="tb-replykb-row">
            <span class="tb-replykb-btn">📦 Orders</span>
            <span class="tb-replykb-btn">ℹ️ Help</span>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderIsoScene() {
  // A tiny isometric scene: ground tile + 3 stacked cubes for "voxel" feel.
  // `preserveAspectRatio="xMidYMid slice"` makes the SVG fill the entire
  // container (cropping sides if needed) so there's no letterbox seam
  // between the SVG sky and the parent card background.
  return `
    <svg class="gp-iso" viewBox="0 0 120 90" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="gpSky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#bde7ff"/>
          <stop offset="1" stop-color="#88c8ff"/>
        </linearGradient>
      </defs>
      <rect width="120" height="90" fill="url(#gpSky)"/>
      <!-- ground tile — shifted up 10 units so the scene sits near vertical center -->
      <polygon points="20,50 60,30 100,50 60,70" fill="#7cb342"/>
      <polygon points="60,70 100,50 100,58 60,78" fill="#558b2f"/>
      <polygon points="20,50 20,58 60,78 60,70" fill="#689f38"/>
      <!-- voxel block -->
      <polygon points="50,42 65,34 80,42 65,50" fill="#ffd54f"/>
      <polygon points="65,50 80,42 80,52 65,60" fill="#f9a825"/>
      <polygon points="50,42 50,52 65,60 65,50" fill="#fbc02d"/>
      <!-- back tree -->
      <polygon points="38,35 46,31 54,35 46,39" fill="#2e7d32"/>
      <polygon points="46,39 54,35 54,42 46,46" fill="#1b5e20"/>
      <polygon points="38,35 38,42 46,46 46,39" fill="#256527"/>
    </svg>
  `;
}

function renderGameDimensionPreviewCard(opt) {
  const dim = opt.preview.dimension;
  if (dim === '2d') {
    return `
      <div class="gp-card gp-card-dim gp-card-dim-2d">
        <div class="gp-canvas">
          <svg viewBox="0 0 120 90" xmlns="http://www.w3.org/2000/svg" class="gp-grid2d">
            <rect width="120" height="90" fill="#0e1116"/>
            ${gpGrid2dLines()}
            <rect x="54" y="40" width="12" height="12" fill="#00e5ff"/>
            <rect x="20" y="60" width="8" height="8" fill="#ff4081"/>
            <rect x="92" y="20" width="8" height="8" fill="#ffeb3b"/>
          </svg>
          <span class="gp-tag">2D</span>
        </div>
      </div>
    `;
  }
  return `
    <div class="gp-card gp-card-dim gp-card-dim-3d">
      <div class="gp-canvas">${renderIsoScene()}<span class="gp-tag">3D</span></div>
    </div>
  `;
}

function gpGrid2dLines() {
  let out = '';
  for (let x = 0; x <= 120; x += 12) {
    out += `<line x1="${x}" y1="0" x2="${x}" y2="90" stroke="rgba(0,229,255,0.18)" stroke-width="0.5"/>`;
  }
  for (let y = 0; y <= 90; y += 12) {
    out += `<line x1="0" y1="${y}" x2="120" y2="${y}" stroke="rgba(0,229,255,0.18)" stroke-width="0.5"/>`;
  }
  return out;
}

function renderGameGenrePreviewCard(opt) {
  const genre = opt.preview.genre;
  const palette = {
    arcade: { bg: '#1a1a2e', fg: '#f9d342', accent: '#e94560' },
    runner: { bg: '#88c8ff', fg: '#7cb342', accent: '#ff7043' },
    puzzle: { bg: '#ede7f6', fg: '#5e35b1', accent: '#ff8a65' },
    shooter: { bg: '#0e1116', fg: '#00e5ff', accent: '#ff4081' },
    platformer: { bg: '#42a5f5', fg: '#43a047', accent: '#ffb300' },
    sandbox: { bg: '#fff8e1', fg: '#6d4c41', accent: '#26a69a' },
  }[genre] || { bg: '#222', fg: '#fff', accent: '#999' };

  let inner = '';
  if (genre === 'arcade') {
    inner = `
      <circle cx="60" cy="50" r="10" fill="${palette.fg}"/>
      <circle cx="30" cy="30" r="4" fill="${palette.accent}"/>
      <circle cx="92" cy="32" r="4" fill="${palette.accent}"/>
      <circle cx="40" cy="68" r="4" fill="${palette.accent}"/>
      <circle cx="84" cy="70" r="4" fill="${palette.accent}"/>
    `;
  } else if (genre === 'runner') {
    inner = `
      <rect x="0" y="60" width="120" height="30" fill="${palette.fg}"/>
      <rect x="0" y="58" width="120" height="2" fill="rgba(0,0,0,0.18)"/>
      <rect x="56" y="40" width="10" height="20" fill="${palette.accent}"/>
      <rect x="22" y="48" width="10" height="12" fill="#5d4037"/>
      <rect x="92" y="48" width="10" height="12" fill="#5d4037"/>
    `;
  } else if (genre === 'puzzle') {
    inner = `
      <rect x="20" y="20" width="20" height="20" fill="${palette.fg}" rx="3"/>
      <rect x="50" y="20" width="20" height="20" fill="${palette.accent}" rx="3"/>
      <rect x="80" y="20" width="20" height="20" fill="${palette.fg}" rx="3"/>
      <rect x="20" y="50" width="20" height="20" fill="${palette.accent}" rx="3"/>
      <rect x="50" y="50" width="20" height="20" fill="${palette.fg}" rx="3"/>
      <rect x="80" y="50" width="20" height="20" fill="${palette.accent}" rx="3"/>
    `;
  } else if (genre === 'shooter') {
    inner = `
      <polygon points="60,68 56,76 64,76" fill="${palette.fg}"/>
      <line x1="60" y1="60" x2="60" y2="20" stroke="${palette.accent}" stroke-width="2" stroke-dasharray="3 3"/>
      <circle cx="30" cy="30" r="6" fill="${palette.accent}" opacity="0.7"/>
      <circle cx="90" cy="40" r="6" fill="${palette.accent}" opacity="0.7"/>
      <circle cx="60" cy="20" r="5" fill="${palette.accent}"/>
    `;
  } else if (genre === 'platformer') {
    inner = `
      <rect x="0" y="78" width="120" height="12" fill="${palette.fg}"/>
      <rect x="20" y="58" width="24" height="6" fill="${palette.fg}"/>
      <rect x="60" y="42" width="28" height="6" fill="${palette.fg}"/>
      <rect x="92" y="60" width="20" height="6" fill="${palette.fg}"/>
      <rect x="28" y="48" width="8" height="10" fill="${palette.accent}"/>
    `;
  } else if (genre === 'sandbox') {
    inner = `
      <rect x="20" y="50" width="14" height="14" fill="${palette.fg}"/>
      <rect x="36" y="50" width="14" height="14" fill="${palette.accent}"/>
      <rect x="52" y="50" width="14" height="14" fill="${palette.fg}"/>
      <rect x="36" y="34" width="14" height="14" fill="${palette.accent}"/>
      <rect x="76" y="44" width="14" height="20" fill="${palette.fg}"/>
      <rect x="92" y="50" width="14" height="14" fill="${palette.accent}"/>
    `;
  }

  return `
    <div class="gp-card gp-card-genre">
      <svg viewBox="0 0 120 90" xmlns="http://www.w3.org/2000/svg" class="gp-svg">
        <rect width="120" height="90" fill="${palette.bg}"/>
        ${inner}
      </svg>
    </div>
  `;
}

function renderGameArtStylePreviewCard(opt) {
  const art = opt.preview.art;
  if (art === 'voxel') {
    return `<div class="gp-card gp-card-art">${renderIsoScene()}</div>`;
  }
  if (art === 'low_poly') {
    return `
      <div class="gp-card gp-card-art">
        <svg viewBox="0 0 120 90" xmlns="http://www.w3.org/2000/svg" class="gp-svg">
          <rect width="120" height="90" fill="#a3c8e2"/>
          <polygon points="0,90 40,60 80,80 120,55 120,90" fill="#3d7a3d"/>
          <polygon points="40,60 70,30 100,55" fill="#6f4e37"/>
          <polygon points="70,30 85,40 100,30 90,20" fill="#fff3d6"/>
          <polygon points="20,80 30,68 40,80" fill="#2f5a2f"/>
        </svg>
      </div>
    `;
  }
  if (art === 'flat') {
    return `
      <div class="gp-card gp-card-art">
        <svg viewBox="0 0 120 90" xmlns="http://www.w3.org/2000/svg" class="gp-svg">
          <rect width="120" height="90" fill="#0e1116"/>
          <polygon points="60,20 78,55 42,55" fill="#00e5ff"/>
          <circle cx="30" cy="68" r="10" fill="#ff4081"/>
          <rect x="80" y="58" width="20" height="20" fill="#ffeb3b"/>
        </svg>
      </div>
    `;
  }
  if (art === 'pixel') {
    return `
      <div class="gp-card gp-card-art">
        <svg viewBox="0 0 16 12" xmlns="http://www.w3.org/2000/svg" class="gp-svg gp-pixel">
          <rect width="16" height="12" fill="#1a1c2c"/>
          <rect x="4" y="4" width="2" height="2" fill="#ffcd75"/>
          <rect x="6" y="4" width="2" height="2" fill="#ef7d57"/>
          <rect x="6" y="6" width="2" height="2" fill="#ef7d57"/>
          <rect x="4" y="6" width="2" height="2" fill="#ef7d57"/>
          <rect x="3" y="6" width="1" height="2" fill="#b13e53"/>
          <rect x="8" y="6" width="1" height="2" fill="#b13e53"/>
          <rect x="0" y="10" width="16" height="2" fill="#38b764"/>
          <rect x="12" y="2" width="2" height="2" fill="#73eff7"/>
        </svg>
      </div>
    `;
  }
  if (art === 'wireframe') {
    return `
      <div class="gp-card gp-card-art">
        <svg viewBox="0 0 120 90" xmlns="http://www.w3.org/2000/svg" class="gp-svg">
          <rect width="120" height="90" fill="#000"/>
          <g stroke="#00ff66" stroke-width="1" fill="none">
            <polygon points="60,20 90,40 90,70 60,80 30,70 30,40"/>
            <line x1="60" y1="20" x2="60" y2="80"/>
            <line x1="30" y1="40" x2="90" y2="70"/>
            <line x1="90" y1="40" x2="30" y2="70"/>
          </g>
        </svg>
      </div>
    `;
  }
  return `<div class="pref-preview-fallback">${escapeHtml(opt.label)}</div>`;
}

function renderGameControlsPreviewCard(opt) {
  const scheme = opt.preview.scheme;
  let inner = '';
  if (scheme === 'touch') {
    inner = `
      <circle cx="40" cy="50" r="14" fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.5)" stroke-width="1"/>
      <circle cx="40" cy="50" r="6" fill="#ffffff"/>
      <circle cx="86" cy="38" r="10" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.3)"/>
      <circle cx="86" cy="60" r="10" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.3)"/>
    `;
  } else if (scheme === 'swipe') {
    inner = `
      <circle cx="40" cy="55" r="6" fill="#ffffff"/>
      <path d="M40 55 L92 30" stroke="#00e5ff" stroke-width="2" fill="none" stroke-linecap="round"/>
      <polygon points="92,30 86,30 90,36" fill="#00e5ff"/>
      <path d="M40 55 L40 80" stroke="rgba(0,229,255,0.4)" stroke-width="2" stroke-dasharray="3 3"/>
    `;
  } else if (scheme === 'dpad') {
    inner = `
      <rect x="22" y="44" width="14" height="14" rx="3" fill="rgba(255,255,255,0.18)"/>
      <rect x="38" y="28" width="14" height="14" rx="3" fill="rgba(255,255,255,0.18)"/>
      <rect x="38" y="60" width="14" height="14" rx="3" fill="rgba(255,255,255,0.18)"/>
      <rect x="54" y="44" width="14" height="14" rx="3" fill="rgba(255,255,255,0.18)"/>
      <circle cx="92" cy="55" r="12" fill="#ff4081"/>
    `;
  } else if (scheme === 'tilt') {
    inner = `
      <g transform="translate(60 50) rotate(-12) translate(-30 -20)">
        <rect x="0" y="0" width="60" height="40" rx="6" fill="rgba(255,255,255,0.15)" stroke="rgba(255,255,255,0.4)"/>
        <circle cx="30" cy="20" r="4" fill="#00e5ff"/>
      </g>
      <path d="M30 75 Q60 85 90 75" stroke="rgba(255,255,255,0.4)" stroke-width="1" fill="none"/>
    `;
  }
  return `
    <div class="gp-card gp-card-controls">
      <svg viewBox="0 0 120 90" xmlns="http://www.w3.org/2000/svg" class="gp-svg">
        <rect width="120" height="90" fill="#1a1a2e"/>
        ${inner}
      </svg>
    </div>
  `;
}

// Each preview is a tiny, fully-rendered phone mockup so the option's
// look — fonts, palette, geometry, motion — is on display, not described.
// All variables come straight from the catalog spec so there's a single
// source of truth.

function styleCssVars(p) {
  return `
    --pp-bg:${p.bg};
    --pp-surface:${p.surface};
    --pp-text:${p.text};
    --pp-muted:${p.textMuted};
    --pp-primary:${p.primary};
    --pp-primary-text:${p.primaryText};
    --pp-accent:${p.accent};
    --pp-border:${p.border};
    --pp-radius:${p.radius}px;
    --pp-shadow:${p.shadow};
    --pp-display:'${p.displayFont}', system-ui, sans-serif;
    --pp-body:'${p.bodyFont}', system-ui, sans-serif;
  `;
}

function renderStylePreviewCard(opt) {
  const p = opt.preview;
  const previewByStyle = {
    basic: stylePreviewGeneric(p, opt.label),
    neon: stylePreviewNeon(p, opt.label),
    crypto: stylePreviewCrypto(p, opt.label),
    minimal: stylePreviewMinimal(p, opt.label),
    playful: stylePreviewPlayful(p, opt.label),
    nature: stylePreviewNature(p, opt.label),
    corporate: stylePreviewCorporate(p, opt.label),
    paper: stylePreviewPaper(p, opt.label),
    aurora: stylePreviewAurora(p, opt.label),
    brutalist: stylePreviewBrutalist(p, opt.label),
    liquid: stylePreviewLiquid(p, opt.label),
    titanium: stylePreviewTitanium(p, opt.label),
    signal: stylePreviewSignal(p, opt.label),
    holo: stylePreviewHolo(p, opt.label),
  };
  return `<div class="pp pp-style" data-style="${opt.id}" style="${styleCssVars(p)}">${previewByStyle[opt.id] || stylePreviewGeneric(p, opt.label)}</div>`;
}

function ppNotch() {
  return `<div class="pp-notch"></div>`;
}

function stylePreviewGeneric(p, label) {
  return `
    ${ppNotch()}
    <div class="pp-screen">
      <div class="pp-h">
        <span class="pp-h-title">${escapeHtml(label)}</span>
        <span class="pp-h-icon"></span>
      </div>
      <div class="pp-card pp-card-hero">
        <div class="pp-card-eyebrow">Balance</div>
        <div class="pp-card-amount">$12,480</div>
      </div>
      <div class="pp-row">
        <div class="pp-row-dot"></div>
        <div class="pp-row-lines"><i></i><i class="short"></i></div>
      </div>
      <div class="pp-cta">Continue</div>
      <div class="pp-tabs">
        <span></span><span></span><span class="on"></span><span></span>
      </div>
    </div>
  `;
}

function stylePreviewNeon(p, label) {
  return `
    ${ppNotch()}
    <div class="pp-screen pp-glass">
      <div class="pp-glow"></div>
      <div class="pp-h">
        <span class="pp-h-title">${escapeHtml(label.toUpperCase())}</span>
        <span class="pp-h-icon"></span>
      </div>
      <div class="pp-card pp-card-hero pp-card-glow">
        <div class="pp-card-eyebrow">PORTFOLIO</div>
        <div class="pp-card-amount">$24.8K</div>
        <div class="pp-spark"></div>
      </div>
      <div class="pp-cta pp-cta-glow">LAUNCH</div>
      <div class="pp-tabs">
        <span></span><span class="on"></span><span></span><span></span>
      </div>
    </div>
  `;
}

function stylePreviewCrypto(p, label) {
  return `
    ${ppNotch()}
    <div class="pp-screen">
      <div class="pp-h">
        <span class="pp-h-title">${escapeHtml(label)}</span>
        <span class="pp-h-pill">+2.4%</span>
      </div>
      <div class="pp-card pp-card-hero">
        <div class="pp-card-eyebrow">USDT · TON</div>
        <div class="pp-card-amount pp-mono">$8,124.50</div>
      </div>
      <div class="pp-row pp-row-mono">
        <span class="pp-mono">0x9f...4e</span>
        <span class="pp-mono pp-up">+0.42</span>
      </div>
      <div class="pp-row pp-row-mono">
        <span class="pp-mono">0xab...19</span>
        <span class="pp-mono pp-down">-0.18</span>
      </div>
      <div class="pp-cta">Trade</div>
    </div>
  `;
}

function stylePreviewMinimal(p, label) {
  return `
    ${ppNotch()}
    <div class="pp-screen">
      <div class="pp-h pp-h-thin">
        <span class="pp-h-overline">EDITORIAL</span>
      </div>
      <div class="pp-card pp-card-hero pp-card-flat">
        <div class="pp-card-amount pp-serif">${escapeHtml(label)}</div>
        <div class="pp-card-eyebrow">Quiet, considered, calm.</div>
      </div>
      <div class="pp-rule"></div>
      <div class="pp-row pp-row-flat"><i></i><i class="short"></i></div>
      <div class="pp-cta pp-cta-square">Read</div>
    </div>
  `;
}

function stylePreviewPlayful(p, label) {
  return `
    ${ppNotch()}
    <div class="pp-screen">
      <div class="pp-h">
        <span class="pp-h-emoji">✨</span>
        <span class="pp-h-title">${escapeHtml(label)}</span>
      </div>
      <div class="pp-card pp-card-hero pp-card-gradient">
        <div class="pp-card-eyebrow">Streak</div>
        <div class="pp-card-amount">7 🔥</div>
      </div>
      <div class="pp-cta pp-cta-pill">Let's go!</div>
      <div class="pp-tabs">
        <span class="on"></span><span></span><span></span><span></span>
      </div>
    </div>
  `;
}

function stylePreviewNature(p, label) {
  return `
    ${ppNotch()}
    <div class="pp-screen pp-nature">
      <div class="pp-h pp-h-nature">
        <span class="pp-h-emoji">🌿</span>
        <span class="pp-h-title">Eco</span>
      </div>
      <div class="pp-nature-hero">
        <div class="pp-nature-hero-num">247</div>
        <div class="pp-nature-hero-lbl">kg CO₂<br/>saved</div>
      </div>
      <div class="pp-nature-row"><span class="pp-nature-dot"></span><span>Transport</span><span class="pp-nature-val">−84</span></div>
      <div class="pp-nature-row"><span class="pp-nature-dot"></span><span>Food</span><span class="pp-nature-val">−112</span></div>
      <div class="pp-cta pp-cta-pill">Log impact</div>
    </div>
  `;
}

function stylePreviewCorporate(p, label) {
  return `
    ${ppNotch()}
    <div class="pp-screen pp-corp">
      <div class="pp-corp-h">
        <div class="pp-corp-logo">AF</div>
        <span class="pp-corp-title">Analytics</span>
      </div>
      <div class="pp-corp-section">OVERVIEW · Q2</div>
      <div class="pp-corp-kpis">
        <div class="pp-corp-kpi"><b>$48K</b><span>Revenue</span><i>▲ 12%</i></div>
        <div class="pp-corp-kpi"><b>1,284</b><span>Users</span><i>▲ 8%</i></div>
        <div class="pp-corp-kpi"><b>94%</b><span>Retention</span><i>▲ 3%</i></div>
      </div>
      <div class="pp-corp-list">
        <div class="pp-corp-li">Invoice #4821<span class="pp-corp-badge">Pending</span></div>
        <div class="pp-corp-li">Report exported<span class="pp-corp-badge">PDF</span></div>
      </div>
      <div class="pp-cta pp-cta-square">Export Report</div>
    </div>
  `;
}

function stylePreviewPaper(p, label) {
  return `
    ${ppNotch()}
    <div class="pp-screen pp-paper">
      <div class="pp-paper-noise"></div>
      <div class="pp-paper-h">
        <div>
          <div class="pp-paper-issue">Invoice · #0042</div>
          <div class="pp-paper-title">Order<br/>Summary</div>
        </div>
        <div class="pp-paper-stamp">Confirmed</div>
      </div>
      <div class="pp-paper-item"><span>Pro Plan</span><span class="pp-paper-price">$29.00</span></div>
      <div class="pp-paper-item"><span>Workspace ×3</span><span class="pp-paper-price">$9.00</span></div>
      <div class="pp-paper-item"><span>API Access</span><span class="pp-paper-price">$12.00</span></div>
      <div class="pp-paper-total"><span>Total</span><span>$50.00</span></div>
      <div class="pp-cta pp-cta-square">Pay Now</div>
      <div class="pp-paper-bar">||||||  042-2025  ||||||</div>
    </div>
  `;
}

function stylePreviewAurora(p, label) {
  return `
    ${ppNotch()}
    <div class="pp-screen pp-aurora">
      <div class="pp-aurora-bg"></div>
      <div class="pp-h">
        <span class="pp-aurora-dot"></span>
        <span class="pp-h-title">Pulse</span>
        <span class="pp-aurora-badge">Live</span>
      </div>
      <div class="pp-card pp-card-hero pp-aurora-glass">
        <div class="pp-card-eyebrow">EARNINGS</div>
        <div class="pp-card-amount pp-aurora-grad">$12,480</div>
        <div class="pp-card-sub">↑ 24% vs last month</div>
      </div>
      <div class="pp-aurora-mini">
        <div class="pp-aurora-mini-c"><b>2,841</b><span>Users</span></div>
        <div class="pp-aurora-mini-c"><b>48K</b><span>Sessions</span></div>
        <div class="pp-aurora-mini-c"><b>1.4%</b><span>Churn</span></div>
      </div>
      <div class="pp-cta pp-aurora-cta">View Analytics</div>
    </div>
  `;
}

function stylePreviewBrutalist(p, label) {
  return `
    ${ppNotch()}
    <div class="pp-screen pp-brut">
      <div class="pp-brut-h">
        <span class="pp-brut-title">APPS<i>.</i>FATHER</span>
        <span class="pp-brut-num">#042</span>
      </div>
      <div class="pp-brut-ticker">BTC ▲2.4 · ETH ▼0.8 · SOL ▲11</div>
      <div class="pp-brut-big">$48K</div>
      <div class="pp-brut-big-lbl">MONTHLY REVENUE</div>
      <div class="pp-brut-grid">
        <div class="pp-brut-cell"><b>1,284</b><span>USERS</span></div>
        <div class="pp-brut-cell pp-brut-hl"><b>94%</b><span>RETENTION</span></div>
        <div class="pp-brut-cell"><b>+31%</b><span>GROWTH</span></div>
        <div class="pp-brut-cell"><b>12ms</b><span>RESPONSE</span></div>
      </div>
      <div class="pp-cta pp-brut-cta">→ CONNECT NOW</div>
    </div>
  `;
}

function stylePreviewLiquid(p, label) {
  return `
    ${ppNotch()}
    <div class="pp-screen pp-liq">
      <div class="pp-liq-blob pp-liq-blob-1"></div>
      <div class="pp-liq-blob pp-liq-blob-2"></div>
      <div class="pp-h">
        <span class="pp-h-title">Hydra</span>
        <span class="pp-liq-tag">Live sync</span>
      </div>
      <div class="pp-liq-ring">
        <div class="pp-liq-ring-inner">
          <b>84%</b>
          <span>HEALTH</span>
        </div>
      </div>
      <div class="pp-liq-pills">
        <span class="pp-liq-pill on">Network</span>
        <span class="pp-liq-pill">Storage</span>
        <span class="pp-liq-pill">Memory</span>
      </div>
      <div class="pp-cta pp-liq-cta">View Dashboard</div>
    </div>
  `;
}

function stylePreviewTitanium(p, label) {
  return `
    ${ppNotch()}
    <div class="pp-screen pp-mag">
      <div class="pp-mag-metal"></div>
      <div class="pp-h">
        <span class="pp-mag-icon"><i></i></span>
        <span class="pp-h-title">Titanium</span>
        <span class="pp-mag-live"><i></i>LIVE</span>
      </div>
      <div class="pp-mag-hero">
        <div class="pp-card-eyebrow">TOTAL BALANCE</div>
        <div class="pp-mag-amount">$284,500</div>
        <div class="pp-mag-change">↑ $3,200 today · +1.14%</div>
      </div>
      <div class="pp-mag-divider"></div>
      <div class="pp-mag-stats">
        <div><b>14.2%</b><span>YTD</span></div>
        <div><b>$2.1K</b><span>Dividends</span></div>
        <div><b>0.82</b><span>Beta</span></div>
      </div>
      <div class="pp-cta pp-mag-cta">View Portfolio</div>
    </div>
  `;
}

function stylePreviewSignal(p, label) {
  return `
    ${ppNotch()}
    <div class="pp-screen pp-sig">
      <div class="pp-sig-scan"></div>
      <div class="pp-sig-h">
        <span class="pp-sig-prompt">root@af:~$</span>
        <span class="pp-sig-clock">14:32</span>
      </div>
      <div class="pp-sig-line"><i>→</i> fetch --stats revenue</div>
      <div class="pp-sig-big">
        <b>$48,200</b>
        <span>MONTHLY REVENUE</span>
      </div>
      <div class="pp-sig-line"><i>→</i> ping nodes --all</div>
      <div class="pp-sig-line">  node-01 <em class="pp-sig-ok">OK</em> <i>3ms</i></div>
      <div class="pp-sig-line">  node-02 <em class="pp-sig-ok">OK</em> <i>7ms</i></div>
      <div class="pp-sig-line">  node-03 <em class="pp-sig-warn">WARN</em> <i>142ms</i></div>
      <div class="pp-sig-bar"><div class="pp-sig-bar-fill" style="width:78%"></div></div>
      <div class="pp-sig-cur"><i>→</i><span class="pp-sig-cursor"></span></div>
    </div>
  `;
}

function stylePreviewHolo(p, label) {
  return `
    ${ppNotch()}
    <div class="pp-screen pp-holo">
      <div class="pp-holo-grid"></div>
      <div class="pp-holo-glow"></div>
      <div class="pp-h pp-holo-h">
        <span class="pp-holo-hex"><i></i></span>
        <span class="pp-h-title">Nexus · Core</span>
        <span class="pp-holo-corner"><i></i><i></i><i></i></span>
      </div>
      <div class="pp-card pp-holo-3d">
        <div class="pp-card-eyebrow">NETWORK VALUE</div>
        <div class="pp-card-amount pp-holo-grad">$2.48M</div>
        <div class="pp-card-sub">↑ 24.8% · 2,841 nodes</div>
      </div>
      <div class="pp-holo-mini">
        <div><b>14.2%</b><span>APY</span></div>
        <div><b>99.98%</b><span>Uptime</span></div>
        <div><b>3ms</b><span>Latency</span></div>
      </div>
      <div class="pp-holo-scan"></div>
      <div class="pp-cta pp-holo-cta">Access Dashboard</div>
    </div>
  `;
}

function renderThemePreviewCard(opt) {
  const mode = opt.preview.mode;
  return `
    <div class="pp pp-theme" data-mode="${mode}">
      ${ppNotch()}
      <div class="pp-theme-grid">
        <div class="pp-theme-half pp-theme-light">
          <div class="pp-theme-h"></div>
          <div class="pp-theme-card"></div>
          <div class="pp-theme-card sm"></div>
          <div class="pp-theme-tag">Light</div>
        </div>
        <div class="pp-theme-half pp-theme-dark">
          <div class="pp-theme-h"></div>
          <div class="pp-theme-card"></div>
          <div class="pp-theme-card sm"></div>
          <div class="pp-theme-tag">Dark</div>
        </div>
      </div>
      ${mode === 'auto' ? '<div class="pp-theme-auto-badge">AUTO</div>' : ''}
    </div>
  `;
}

function renderHeaderPreviewCard(opt) {
  const layout = opt.preview.layout;
  let header = '';
  if (layout === 'minimal') {
    header = `
      <div class="pp-h pp-h-thin">
        <span class="pp-h-title">Inbox</span>
        <span class="pp-h-icon-sm"></span>
      </div>
    `;
  } else if (layout === 'branded') {
    header = `
      <div class="pp-h pp-h-branded">
        <span class="pp-h-logo"></span>
        <span class="pp-h-title">App</span>
        <span class="pp-h-icon"></span>
      </div>
    `;
  } else {
    header = `
      <div class="pp-h-large">
        <span class="pp-h-overline">SECTION</span>
        <span class="pp-h-bigtitle">Discover</span>
      </div>
    `;
  }
  return `
    <div class="pp pp-header">
      ${ppNotch()}
      <div class="pp-screen">
        ${header}
        <div class="pp-card pp-card-flat"><i></i><i class="short"></i></div>
        <div class="pp-card pp-card-flat"><i></i><i class="short"></i></div>
      </div>
    </div>
  `;
}

function renderDensityPreviewCard(opt) {
  const isCompact = opt.id === 'compact';
  const rows = isCompact ? 6 : 3;
  let body = '';
  for (let i = 0; i < rows; i++) {
    body += `
      <div class="pp-d-row ${isCompact ? 'compact' : 'comfy'}">
        <div class="pp-d-avatar"></div>
        <div class="pp-d-text"><i></i><i class="short"></i></div>
      </div>
    `;
  }
  return `
    <div class="pp pp-density" data-density="${opt.id}">
      ${ppNotch()}
      <div class="pp-screen">
        <div class="pp-h pp-h-thin"><span class="pp-h-title">${isCompact ? 'Compact' : 'Comfortable'}</span></div>
        <div class="pp-d-list">${body}</div>
      </div>
    </div>
  `;
}

function renderBottomMenuPreviewCard(opt) {
  const layout = opt.preview.layout;
  const renderers = {
    tabbar: navPreviewFlat,
    tabbar_pill: navPreviewPill,
    tabbar_glass: navPreviewGlass,
    tabbar_fab: navPreviewFab,
    floating_cta: navPreviewFloatingCta,
    action_grid: navPreviewActionGrid,
    none: navPreviewNone,
  };
  const renderer = renderers[layout] || navPreviewFlat;
  return `
    <div class="pp pp-nav-card" data-nav="${layout}">
      ${ppNotch()}
      ${renderer()}
    </div>
  `;
}

// ── small SVG primitives reused across the nav previews ─────────────
const NAV_ICONS = {
  home: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 3 10v11h6v-7h6v7h6V10z"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="16.5" y1="16.5" x2="21" y2="21"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/></svg>',
  compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  library: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
};

function navStatusBar() {
  return `
    <div class="pp-nav-status">
      <span>9:41</span>
      <span class="pp-nav-status-icons">
        <svg width="10" height="6" viewBox="0 0 12 8"><path d="M1 7 L6 2 L11 7" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>
        <svg width="12" height="6" viewBox="0 0 14 8"><rect x="0.5" y="0.5" width="11" height="7" rx="1.5" stroke="currentColor" fill="none"/><rect x="2" y="2" width="8" height="4" fill="currentColor"/></svg>
      </span>
    </div>
  `;
}

function navListRow(avatarBg, w1, w2) {
  const bg = avatarBg || 'linear-gradient(135deg,#3a3a40,#24242a)';
  return `
    <div class="pp-nav-row">
      <div class="pp-nav-avatar" style="background:${bg};"></div>
      <div class="pp-nav-lines">
        <div class="pp-nav-line" style="width:${w1}%"></div>
        <div class="pp-nav-line short" style="width:${w2}%"></div>
      </div>
    </div>
  `;
}

function navHomeIndicator() {
  return `<div class="pp-nav-home-ind"></div>`;
}

// ── 1. Flat tab bar ─────────────────────────────────────────────────
function navPreviewFlat() {
  return `
    <div class="pp-nav-screen pp-nav-screen-flat">
      ${navStatusBar()}
      <div class="pp-nav-header">
        <span class="pp-nav-title pp-nav-title-serif">Messages</span>
        <span class="pp-nav-icon-btn">${NAV_ICONS.search}</span>
      </div>
      <div class="pp-nav-body">
        ${navListRow('linear-gradient(135deg,#4da2ff,#2d6bc7)', 60, 80)}
        ${navListRow('linear-gradient(135deg,#ff8aa8,#c7506e)', 45, 60)}
        ${navListRow('linear-gradient(135deg,#8affa0,#3cc768)', 60, 45)}
        ${navListRow(null, 80, 45)}
      </div>
      <nav class="pp-nav-flat">
        <div class="pp-nav-flat-item on" style="color:#4da2ff;">
          <span class="pp-nav-flat-ico">${NAV_ICONS.home}</span>
          <span class="pp-nav-flat-lbl">Chats</span>
        </div>
        <div class="pp-nav-flat-item">
          <span class="pp-nav-flat-ico">${NAV_ICONS.search}</span>
          <span class="pp-nav-flat-lbl">Search</span>
        </div>
        <div class="pp-nav-flat-item">
          <span class="pp-nav-flat-ico">${NAV_ICONS.compass}</span>
          <span class="pp-nav-flat-lbl">Discover</span>
        </div>
        <div class="pp-nav-flat-item">
          <span class="pp-nav-flat-ico">${NAV_ICONS.bolt}</span>
          <span class="pp-nav-flat-lbl">Activity</span>
        </div>
        <div class="pp-nav-flat-item">
          <span class="pp-nav-flat-ico">${NAV_ICONS.user}</span>
          <span class="pp-nav-flat-lbl">Me</span>
        </div>
      </nav>
      ${navHomeIndicator()}
    </div>
  `;
}

// ── 2. Floating pill ────────────────────────────────────────────────
function navPreviewPill() {
  return `
    <div class="pp-nav-screen pp-nav-screen-pill">
      ${navStatusBar()}
      <div class="pp-nav-header">
        <span class="pp-nav-title pp-nav-title-sans">Library</span>
        <span class="pp-nav-icon-btn pp-nav-icon-btn-purple">${NAV_ICONS.plus}</span>
      </div>
      <div class="pp-nav-body pp-nav-body-tight">
        <div class="pp-nav-tile-grid">
          <div class="pp-nav-tile" style="background:linear-gradient(135deg,#ff8aa8,#b784ff);"></div>
          <div class="pp-nav-tile" style="background:linear-gradient(135deg,#6ae3ff,#b784ff);"></div>
          <div class="pp-nav-tile" style="background:linear-gradient(135deg,#ffb347,#ff6b8a);"></div>
          <div class="pp-nav-tile" style="background:linear-gradient(135deg,#8aff9e,#6ae3ff);"></div>
        </div>
      </div>
      <nav class="pp-nav-pill">
        <div class="pp-nav-pill-item on">${NAV_ICONS.home}</div>
        <div class="pp-nav-pill-item">${NAV_ICONS.search}</div>
        <div class="pp-nav-pill-item">${NAV_ICONS.library}</div>
        <div class="pp-nav-pill-item">${NAV_ICONS.user}</div>
      </nav>
      ${navHomeIndicator()}
    </div>
  `;
}

// ── 3. Liquid glass ─────────────────────────────────────────────────
function navPreviewGlass() {
  return `
    <div class="pp-nav-screen pp-nav-screen-glass">
      <div class="pp-nav-glass-blobs"></div>
      ${navStatusBar()}
      <div class="pp-nav-header">
        <span class="pp-nav-title pp-nav-title-serif" style="color:#fff;">Moments</span>
        <span class="pp-nav-icon-btn pp-nav-icon-btn-glass">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></svg>
        </span>
      </div>
      <div class="pp-nav-body pp-nav-body-tight">
        <div class="pp-nav-tile-grid">
          <div class="pp-nav-glass-tile"></div>
          <div class="pp-nav-glass-tile"></div>
          <div class="pp-nav-glass-tile"></div>
          <div class="pp-nav-glass-tile"></div>
        </div>
      </div>
      <nav class="pp-nav-glass">
        <span class="pp-nav-glass-shine"></span>
        <div class="pp-nav-glass-item on">${NAV_ICONS.home}</div>
        <div class="pp-nav-glass-item">${NAV_ICONS.search}</div>
        <div class="pp-nav-glass-item">${NAV_ICONS.heart}</div>
        <div class="pp-nav-glass-item">${NAV_ICONS.user}</div>
      </nav>
      ${navHomeIndicator()}
    </div>
  `;
}

// ── 4. Flat + center FAB ────────────────────────────────────────────
function navPreviewFab() {
  return `
    <div class="pp-nav-screen pp-nav-screen-flat">
      ${navStatusBar()}
      <div class="pp-nav-header">
        <span class="pp-nav-title pp-nav-title-sans">Feed</span>
        <span class="pp-nav-icon-btn pp-nav-icon-btn-pink">${NAV_ICONS.heart}</span>
      </div>
      <div class="pp-nav-body">
        <div class="pp-nav-feed-card">
          <div class="pp-nav-feed-head">
            <span class="pp-nav-avatar small" style="background:linear-gradient(135deg,#ff7a7a,#ff4e8a);"></span>
            <span class="pp-nav-line short" style="width:45%;"></span>
          </div>
          <span class="pp-nav-line" style="width:80%;"></span>
          <span class="pp-nav-line" style="width:60%;"></span>
        </div>
        <div class="pp-nav-feed-card">
          <div class="pp-nav-feed-head">
            <span class="pp-nav-avatar small" style="background:linear-gradient(135deg,#8affa0,#3cc768);"></span>
            <span class="pp-nav-line short" style="width:45%;"></span>
          </div>
          <span class="pp-nav-line" style="width:80%;"></span>
          <span class="pp-nav-line" style="width:45%;"></span>
        </div>
      </div>
      <nav class="pp-nav-fab-bar">
        <div class="pp-nav-flat-item on" style="color:#ff6b8a;">
          <span class="pp-nav-flat-ico">${NAV_ICONS.home}</span>
          <span class="pp-nav-flat-lbl">Home</span>
        </div>
        <div class="pp-nav-flat-item">
          <span class="pp-nav-flat-ico">${NAV_ICONS.search}</span>
          <span class="pp-nav-flat-lbl">Search</span>
        </div>
        <div class="pp-nav-fab-center">${NAV_ICONS.plus}</div>
        <div class="pp-nav-flat-item">
          <span class="pp-nav-flat-ico">${NAV_ICONS.heart}</span>
          <span class="pp-nav-flat-lbl">Likes</span>
        </div>
        <div class="pp-nav-flat-item">
          <span class="pp-nav-flat-ico">${NAV_ICONS.user}</span>
          <span class="pp-nav-flat-lbl">Me</span>
        </div>
      </nav>
      ${navHomeIndicator()}
    </div>
  `;
}

// ── unchanged: keep simple shapes for the existing 3 ───────────────
function navPreviewFloatingCta() {
  return `
    <div class="pp-nav-screen pp-nav-screen-flat">
      ${navStatusBar()}
      <div class="pp-nav-header">
        <span class="pp-nav-title pp-nav-title-serif">Notes</span>
        <span class="pp-nav-icon-btn">${NAV_ICONS.search}</span>
      </div>
      <div class="pp-nav-body">
        ${navListRow(null, 80, 45)}
        ${navListRow(null, 60, 80)}
        ${navListRow(null, 45, 60)}
      </div>
      <button class="pp-nav-fab-corner">${NAV_ICONS.plus}</button>
      ${navHomeIndicator()}
    </div>
  `;
}

function navPreviewActionGrid() {
  return `
    <div class="pp-nav-screen pp-nav-screen-flat">
      ${navStatusBar()}
      <div class="pp-nav-header">
        <span class="pp-nav-title pp-nav-title-serif">Hello</span>
      </div>
      <div class="pp-nav-body">
        <div class="pp-nav-action-grid">
          <div class="pp-nav-action-card amber"><span class="num">01</span><span class="lbl">Send</span></div>
          <div class="pp-nav-action-card slate"><span class="num">02</span><span class="lbl">Receive</span></div>
          <div class="pp-nav-action-card ink"><span class="num">03</span><span class="lbl">Scan</span></div>
          <div class="pp-nav-action-card cream"><span class="num">04</span><span class="lbl">History</span></div>
        </div>
      </div>
      ${navHomeIndicator()}
    </div>
  `;
}

function navPreviewNone() {
  return `
    <div class="pp-nav-screen pp-nav-screen-flat">
      ${navStatusBar()}
      <div class="pp-nav-header">
        <span class="pp-nav-back">${'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>'}</span>
        <span class="pp-nav-title pp-nav-title-serif">Scan</span>
        <span></span>
      </div>
      <div class="pp-nav-single-body">
        <div class="pp-nav-qr"></div>
        <span class="pp-nav-single-lbl">Point at any QR</span>
      </div>
      ${navHomeIndicator()}
    </div>
  `;
}

async function submitPreferences() {
  if (!prefModalState) return;
  const submitBtn = document.getElementById('pref-modal-submit');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.classList.add('busy');
    submitBtn.textContent = t('pref_modal_submitting');
  }
  try {
    const res = await fetch(`${API_BASE}/chat/${prefModalState.projectId}/preferences`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(prefModalState.selection),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error('[prefs] save failed', err);
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.classList.remove('busy');
        submitBtn.textContent = textBotNeedsBotFirst() ? t('pref_modal_create_bot') : t('pref_modal_submit');
      }
      alert(t('pref_modal_save_failed'));
      return;
    }

    // Text Bot fork: prefs persisted, but we cannot proceed to planning
    // until the user actually creates the Telegram bot in BotFather.
    // Open the deep link, switch the modal into a "waiting for bot..."
    // state, and poll for the link. Once linked, close the modal and
    // auto-resume planning with the user's original prompt.
    if (textBotNeedsBotFirst()) {
      const description = prefModalState.description || '';
      const userBubbleId = prefModalState.userBubbleId || null;
      const projectId = prefModalState.projectId;
      const isDev = location.hostname === 'dev.apps-father.com';
      const fatherBot = isDev ? 'apps_father_dev_bot' : 'apps_father_bot';
      const newbotUrl = `https://t.me/newbot/${fatherBot}/username_bot`;
      try { tg?.openTelegramLink(newbotUrl); } catch (e) { console.warn('[prefs] openTelegramLink failed', e); }
      enterTextBotWaitingState();
      startLinkBotPolling(projectId, () => {
        closePreferencesModal();
        resumePlanningAfterBotLink({ description, userBubbleId });
      });
      return;
    }

    const onSaved = prefModalState.onSaved;
    closePreferencesModal();
    if (typeof onSaved === 'function') onSaved();
  } catch (err) {
    console.error('[prefs] save error', err);
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.classList.remove('busy');
      submitBtn.textContent = textBotNeedsBotFirst() ? t('pref_modal_create_bot') : t('pref_modal_submit');
    }
  }
}

/**
 * True iff the modal is on a Text Bot project AND the bot hasn't been
 * linked yet. In that case the Submit button needs to launch BotFather
 * before any planning can happen — the agent needs `db.botToken` from
 * turn 1 because there's no Mini App fallback.
 */
function textBotNeedsBotFirst() {
  if (!prefModalState) return false;
  if (prefModalState.selection?.kind !== 'textBot') return false;
  // currentProject reflects the chat's project; botUsername is set the
  // moment managed_bot fires.
  if (currentProject?.botUsername) return false;
  return true;
}

/**
 * Replace the Submit button label with the spinner-style "Waiting for
 * bot..." state. The button itself stays disabled — we wait for the
 * polling callback to close the modal.
 */
function enterTextBotWaitingState() {
  const submitBtn = document.getElementById('pref-modal-submit');
  if (!submitBtn) return;
  submitBtn.disabled = true;
  submitBtn.classList.add('busy', 'waiting-for-bot');
  submitBtn.textContent = t('pref_modal_waiting_for_bot');
}

/**
 * Re-emit the user's original prompt into the chat pipeline. Same path
 * as if the user had just hit Send, but with `skipUserBubble` so the
 * existing optimistic bubble is reused. Triggered after the bot has been
 * linked to a Text Bot project.
 */
function resumePlanningAfterBotLink({ description, userBubbleId }) {
  if (!description) return;
  // sendPlanRequest will also re-check preferences (now persisted), and
  // since `botUsername` is now set on `currentProject`, the textBot
  // submit path is a no-op the next time around — planning runs normally.
  sendPlanRequest(description, {
    skipUserBubble: !!userBubbleId,
    skipPrefsCheck: true,
    userBubbleId,
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hidePlanActions() {
  document.querySelectorAll('.chat-plan-actions').forEach(el => el.style.display = 'none');
}
function showPlanActions() {
  document.querySelectorAll('.chat-plan-actions').forEach(el => el.style.display = '');
}

async function approvePlan() {
  if (!chatProjectId) return;

  hidePlanActions();

  setProcessing(true);
  setInputDisabled(true);

  try {
    const res = await fetch(`${API_BASE}/chat/${chatProjectId}/approve-plan`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId: userTierId }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (res.status === 402) {
        appendMessage({ role: 'system', type: 'balance_error', content: 'Insufficient balance', id: 'bal-err-' + Date.now(), timestamp: Date.now(), metadata: { balance: 0 } });
        scrollToBottom();
      } else {
        showToast(err.error || 'Failed to start build', 'error');
      }
      setProcessing(false);
      setInputDisabled(false);
      showPlanActions();
      return;
    }

    isPlanningMode = false;
    const pills = document.getElementById('chat-mode-pills');
    pills.classList.remove('hidden');
    document.getElementById('btn-attach').style.display = '';
    switchChatMode('update');
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
    setProcessing(false);
    setInputDisabled(false);
    showPlanActions();
  }
}

function startEditPlan() {
  const input = document.getElementById('chat-input');
  input.placeholder = t('chat_placeholder');
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
      body: JSON.stringify({ feedback, tierId: userTierId }),
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

  tg?.showConfirm(t('chat_release_confirm'), async (confirmed) => {
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
      showToast(t('toast_released'), 'success');
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

/** Full-screen log viewer inside WebApp (iframe + #initData for API auth). */
function openAgentLogViewer(projectId, versionNum) {
  const raw = tg?.initData || '';
  if (!raw) {
    showToast('Cannot open log: missing Telegram session.', 'error');
    return;
  }
  let overlay = document.getElementById('agent-log-overlay');
  if (overlay) overlay.remove();

  const base = `${location.origin}/telegram-mini-app/log-viewer.html?projectId=${encodeURIComponent(projectId)}&version=${encodeURIComponent(String(versionNum))}`;
  const iframeSrc = `${base}#initData=${encodeURIComponent(raw)}`;

  overlay = document.createElement('div');
  overlay.id = 'agent-log-overlay';
  overlay.className = 'test-preview-overlay';
  overlay.innerHTML = `
    <div class="test-preview-header">
      <button class="test-preview-back" type="button" id="agent-log-back">← Back</button>
      <span class="test-preview-title">${esc(t('version_view_log') || 'Agent log')} #${esc(String(versionNum))}</span>
      <span class="test-preview-badge" style="background:#4facfe">LOG</span>
    </div>
    <iframe class="test-preview-iframe" title="Agent log" src="${iframeSrc}"></iframe>
  `;
  document.body.appendChild(overlay);
  document.getElementById('agent-log-back')?.addEventListener('click', closeAgentLogViewer);
  haptic('light');
}

function closeAgentLogViewer() {
  const overlay = document.getElementById('agent-log-overlay');
  if (overlay) overlay.remove();
}

function setHeaderWorking(working, pct) {
  const statusEl = document.getElementById('chat-app-status');
  if (!statusEl) return;
  if (working) {
    statusEl.innerHTML = `<span class="loader loader--small"></span> ${t('chat_working')} ${pct || 0}%`;
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
    `Version: <b>${version}</b> · Total cost: <b>${cost}</b><br>Project ID: <b>${p.id}</b>`;

  const isLive = ['deployed', 'released'].includes(p.status);
  const baseUrl = location.origin;

  const webappUrl = `${baseUrl}/app/${p.id}/`;
  const webappUrlRow = document.getElementById('webapp-url-row');
  const webappUrlSpoiler = document.getElementById('webapp-url-spoiler');
  document.getElementById('webapp-url-text').textContent = webappUrl;
  webappUrlRow.style.display = isLive ? '' : 'none';
  webappUrlSpoiler.classList.add('spoiler-active');
  webappUrlSpoiler.classList.remove('js-spoiler-revealed');
  destroySpoilerPoints(webappUrlSpoiler);
  setTimeout(() => generateSpoilerPoints(webappUrlSpoiler), 50);

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
    appRows += menuRowAction(t('detail_test_app'), 'af-icon-test', 'open-test-preview');
    if (p.botUsername) {
      appRows += menuRowAction(t('detail_open_bot'), 'af-icon-open', 'open-bot');
    }
  }
  document.getElementById('detail-app-rows').innerHTML = appRows;
  document.getElementById('section-app').style.display = appRows ? '' : 'none';

  document.getElementById('detail-app-rows').querySelector('[data-action="open-test-preview"]')
    ?.addEventListener('click', () => openTestPreview(p.id));
  document.getElementById('detail-app-rows').querySelector('[data-action="open-bot"]')
    ?.addEventListener('click', () => tg?.openTelegramLink(`https://t.me/${p.botUsername}`));

  let devRows = menuRowAction(t('detail_update_app'), 'af-icon-update', 'open-update');
  if (isLive) devRows += menuRowAction(t('detail_release_version'), 'af-icon-release', 'open-release');
  devRows += menuRowAction(t('detail_versions'), 'af-icon-versions', 'open-versions');
  devRows += menuRowAction(t('detail_suggestions'), 'af-icon-suggest', 'open-suggestions');
  document.getElementById('detail-dev-rows').innerHTML = devRows;

  let moneyRows = menuRowAction(t('detail_features'), 'af-icon-features', 'open-features');
  // if (hasFeature(p, 'ton_payment')) moneyRows += menuRow('Wallet', 'af-icon-wallet');
  document.getElementById('detail-money-rows').innerHTML = moneyRows;
  document.getElementById('section-monetization').style.display = '';

  let settingsRows = '';
  settingsRows += menuRowAction(t('detail_edit_info'), 'af-icon-edit-info', 'open-edit-info');
  if (isAdmin) settingsRows += menuRowAction(t('detail_regen_context'), 'af-icon-refresh', 'open-regen-context');
  if (hasFeature(p, 'get_code')) settingsRows += menuRow('Edit Code', 'af-icon-code', `${baseUrl}/editor/${p.id}/`);
  settingsRows += menuRowAction(t('detail_env_vars') || 'Environment Variables', 'af-icon-code', 'open-env-vars');
  // if (hasFeature(p, 'admin_panel')) settingsRows += menuRow('Admin Panel', 'af-icon-admin', `${baseUrl}/admin/${p.id}/`);
  document.getElementById('detail-settings-rows').innerHTML = settingsRows;

  document.getElementById('detail-settings-rows').querySelector('[data-action="open-edit-info"]')
    ?.addEventListener('click', () => openEditInfo());
  document.getElementById('detail-settings-rows').querySelector('[data-action="open-regen-context"]')
    ?.addEventListener('click', () => regenerateContext(p.id));
  document.getElementById('detail-settings-rows').querySelector('[data-action="open-env-vars"]')
    ?.addEventListener('click', () => openProjectEnv(p.id));

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
  actionsRows += `<a class="tm-row tm-row-add" data-action="open-transfer"><span class="tm-icon" style="--icon-s:var(--image-url-transfer-ownership)"></span><span>${t('detail_transfer')}</span></a>`;
  actionsRows += `<a class="tm-row tm-row-destructive" data-action="open-delete"><span class="tm-icon" style="--icon-s:var(--image-url-trash)"></span><span>${t('detail_delete')}</span></a>`;
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
    generateSpoilerPoints(spoiler);
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
    userCredits = data.credits ?? data.balance ?? 0;
    userTierId = data.tierId || userTierId;
    userTierData = data.tier || userTierData;
    if (data.allTiers) allTiers = data.allTiers;
    if (data.creditsPerDollar) creditsPerDollar = data.creditsPerDollar;
    const balEl = document.getElementById('balance-amount');
    if (balEl) balEl.innerHTML = `${coinSvg(18, 12, 'currentColor')}&nbsp;${Math.max(0, userCredits).toLocaleString()}`;
    renderTierChip();
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
      headers: apiHeaders(),
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
      showToast(t('toast_saved'), 'success');
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

    showToast(t('toast_deleted'), 'success');
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
  // Direct Mini App deep link — opens the app right away with the referrer
  // ID in `start_param`, which is processed by /api/init for attribution.
  const refLink = `https://t.me/apps_father_bot/app?startapp=${userId}`;

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
      <div class="tm-info-item" style="padding:0"><b>1.</b> ${t('referral_step1')}</div>
      <div class="tm-info-item" style="padding:0"><b>2.</b> ${t('referral_step2')}</div>
      <div class="tm-info-item" style="padding:0"><b>3.</b> ${t('referral_step3')}</div>
    </div>
  `;

  document.getElementById('referral-link-text').textContent = refLink;

  const shareText = encodeURIComponent('Build Telegram Mini Apps without code!\nJust describe your idea and Apps Father turns it into a real app.\nTry it now:');
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${shareText}`;

  document.getElementById('btn-copy-referral').onclick = () => {
    navigator.clipboard.writeText(refLink).then(() => {
      const btn = document.getElementById('btn-copy-referral');
      btn.textContent = t('toast_copied');
      setTimeout(() => { btn.textContent = t('referral_copy'); }, 1500);
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
      if (v.image) html += `<div class="rn-banner"><img src="${v.image}" alt="v${v.version}" loading="lazy"></div>`;
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
    <div class="tm-info-heading">${t('help_how')}</div>
    <div class="tm-info-list" style="gap:0">
      <div class="tm-info-item" style="padding:0"><b>1.</b> ${t('help_s1')}</div>
      <div class="tm-info-item" style="padding:0"><b>2.</b> ${t('help_s2')}</div>
      <div class="tm-info-item" style="padding:0"><b>3.</b> ${t('help_s3')}</div>
      <div class="tm-info-item" style="padding:0"><b>4.</b> ${t('help_s4')}</div>
      <div class="tm-info-item" style="padding:0"><b>5.</b> ${t('help_s5')}</div>
      <div class="tm-info-item" style="padding:0"><b>6.</b> ${t('help_s6')}</div>
      <div class="tm-info-item" style="padding:0"><b>7.</b> ${t('help_s7')}</div>
    </div>
    <div class="tm-info-heading">${t('help_features')}</div>
    <div class="tm-info-list" style="gap:0">
      <div class="tm-info-item" style="padding:0">${t('help_f1')}</div>
      <div class="tm-info-item" style="padding:0">${t('help_f2')}</div>
      <div class="tm-info-item" style="padding:0">${t('help_f3')}</div>
      <div class="tm-info-item" style="padding:0">${t('help_f4')}</div>
      <div class="tm-info-item" style="padding:0">${t('help_f5')}</div>
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

// ── Modal System ──

function openModal(title, bodyHtml) {
  const overlay = document.getElementById('app-modal-overlay');
  document.getElementById('app-modal-title').textContent = title;
  document.getElementById('app-modal-body').innerHTML = bodyHtml;
  overlay.classList.remove('hidden');
  document.getElementById('app-modal-close').onclick = closeModal;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });
}

function closeModal() {
  document.getElementById('app-modal-overlay').classList.add('hidden');
}

function openTransferModal(partnerBalance, onSuccess) {
  openModal('Transfer to App Balance', `
    <div class="app-modal-balance">
      <div class="app-modal-balance-label">Partner Balance</div>
      <div class="app-modal-balance-value">$${partnerBalance.toFixed(2)}</div>
    </div>
    <div class="app-modal-input-group">
      <label>Amount to transfer</label>
      <input type="number" class="app-modal-input" id="modal-transfer-amount" placeholder="0.00" step="0.01" min="0.01" max="${partnerBalance.toFixed(2)}" autofocus>
    </div>
    <button class="app-modal-btn app-modal-btn-primary" id="modal-transfer-btn">Transfer</button>
    <p class="app-modal-note">Funds will be moved to your app balance for building apps.</p>
  `);

  document.getElementById('modal-transfer-btn').addEventListener('click', async () => {
    const amount = document.getElementById('modal-transfer-amount').value;
    if (!amount || parseFloat(amount) <= 0) { showToast('Enter a valid amount', 'error'); return; }
    if (parseFloat(amount) > partnerBalance) { showToast('Insufficient partner balance', 'error'); return; }
    const btn = document.getElementById('modal-transfer-btn');
    btn.disabled = true;
    btn.textContent = 'Transferring...';
    try {
      const res = await fetch(`${API_BASE}/partner/transfer`, {
        method: 'POST',
        headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
      });
      const result = await res.json();
      if (!res.ok) { showToast(result.error || 'Transfer failed', 'error'); btn.disabled = false; btn.textContent = 'Transfer'; return; }
      closeModal();
      showToast(`$${parseFloat(amount).toFixed(2)} transferred to app balance`, 'success');
      if (onSuccess) onSuccess(result);
    } catch { showToast('Transfer failed', 'error'); btn.disabled = false; btn.textContent = 'Transfer'; }
  });
}

function openWithdrawModal(partnerBalance) {
  openModal('Withdraw USDT', `
    <div class="app-modal-balance">
      <div class="app-modal-balance-label">Partner Balance</div>
      <div class="app-modal-balance-value">$${partnerBalance.toFixed(2)}</div>
    </div>
    <div class="app-modal-input-group">
      <label>Amount (USDT)</label>
      <input type="number" class="app-modal-input" id="modal-withdraw-amount" placeholder="0.00" step="0.01" min="5" max="${partnerBalance.toFixed(2)}">
    </div>
    <div class="app-modal-input-group">
      <label>TON Wallet Address</label>
      <input type="text" class="app-modal-input" id="modal-withdraw-address" placeholder="UQ...">
    </div>
    <button class="app-modal-btn app-modal-btn-primary" id="modal-withdraw-btn">Request Withdrawal</button>
    <p class="app-modal-note">USDT will be sent on the TON network.<br>Minimum withdrawal: $5.00</p>
  `);

  document.getElementById('modal-withdraw-btn').addEventListener('click', async () => {
    const amount = document.getElementById('modal-withdraw-amount').value;
    const address = document.getElementById('modal-withdraw-address').value.trim();
    if (!amount || parseFloat(amount) < 5) { showToast('Minimum withdrawal is $5.00', 'error'); return; }
    if (parseFloat(amount) > partnerBalance) { showToast('Insufficient partner balance', 'error'); return; }
    if (!address) { showToast('Enter your wallet address', 'error'); return; }
    const btn = document.getElementById('modal-withdraw-btn');
    btn.disabled = true;
    btn.textContent = 'Submitting...';
    try {
      const res = await fetch(`${API_BASE}/partner/withdraw`, {
        method: 'POST',
        headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, address }),
      });
      const result = await res.json();
      if (!res.ok) { showToast(result.error || 'Request failed', 'error'); btn.disabled = false; btn.textContent = 'Request Withdrawal'; return; }
      closeModal();
      showToast(result.message || 'Withdrawal request submitted', 'success');
      openPartner();
    } catch { showToast('Request failed', 'error'); btn.disabled = false; btn.textContent = 'Request Withdrawal'; }
  });
}

// ── Partner Dashboard ──

let isPartnerUser = false;

async function checkPartner() {
  try {
    const res = await fetch(`${API_BASE}/partner`, { headers: apiHeaders() });
    const data = await res.json();
    isPartnerUser = data.isPartner === true;
    const btn = document.getElementById('btn-partner');
    if (btn) btn.classList.toggle('hidden', !isPartnerUser);
  } catch {}
}

async function openPartner() {
  showView('partner');
  const statsEl = document.getElementById('partner-stats');
  const listEl = document.getElementById('partner-referrals-list');
  statsEl.innerHTML = '<div class="loading-spinner"></div>';
  listEl.innerHTML = '';

  try {
    const res = await fetch(`${API_BASE}/partner`, { headers: apiHeaders() });
    const d = await res.json();
    if (!d.isPartner) { showView('list'); return; }

    document.getElementById('partner-subtitle').textContent = d.partnerTag ? `@${d.partnerTag}` : 'Partner';

    statsEl.innerHTML = `
      <div class="adm-info-card"><div class="lbl">Partner Balance</div><div class="val" id="partner-bal-val">$${d.partnerBalance.toFixed(2)}</div></div>
      <div class="adm-info-card"><div class="lbl">Total Earned</div><div class="val">$${d.totalEarned.toFixed(2)}</div></div>
      <div class="adm-info-card"><div class="lbl">Referrals</div><div class="val">${d.referrals.length}</div></div>
      <div class="adm-info-card"><div class="lbl">Commission</div><div class="val">${d.partnerPercent}%</div></div>
    `;

    if (d.inviteLink) {
      document.getElementById('partner-link-text').textContent = d.inviteLink;
      document.getElementById('btn-copy-partner-link').onclick = () => {
        navigator.clipboard.writeText(d.inviteLink).then(() => {
          const btn = document.getElementById('btn-copy-partner-link');
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
        });
      };
      document.getElementById('btn-share-partner-link').onclick = () => {
        const shareText = encodeURIComponent('Build Telegram Mini Apps with AI!\nTry Apps Father:');
        tg?.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(d.inviteLink)}&text=${shareText}`);
      };
    }

    if (d.referrals.length) {
      let rhtml = '<div class="tm-table-wrap">';
      for (const r of d.referrals) {
        const rName = r.username || r.firstName || 'User';
        const avatar = userAvatarHtml(rName, r.username);
        rhtml += `<div class="tm-row" style="cursor:default;align-items:center">` +
          avatar +
          `<div style="flex:1;min-width:0;overflow:hidden;"><div class="tm-row-value" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(rName)}</div>` +
          `<div class="tm-row-description">${admFmtDate(r.joinedAt)} · $${r.deposits.toFixed(2)} deposits</div></div>` +
          `<div class="tm-row-status"><span class="tm-status-dot" style="background:#5CC377"></span>+$${r.earned.toFixed(2)}</div>` +
          `</div>`;
      }
      rhtml += '</div>';
      listEl.innerHTML = rhtml;
    } else {
      listEl.innerHTML = '<p class="help-text" style="text-align:center">No referrals yet. Share your invite link!</p>';
    }

    // Transfer modal
    document.getElementById('btn-partner-transfer').onclick = () => {
      openTransferModal(d.partnerBalance, (result) => {
        document.getElementById('partner-bal-val').textContent = '$' + result.partnerBalance.toFixed(2);
        d.partnerBalance = result.partnerBalance;
      });
    };

    // Withdraw modal
    document.getElementById('btn-partner-withdraw').onclick = () => {
      openWithdrawModal(d.partnerBalance);
    };

  } catch (err) {
    statsEl.innerHTML = `<p class="help-text" style="text-align:center">Failed to load partner data</p>`;
  }
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

  const aiBtn = document.getElementById('btn-generate-avatar');
  if (aiBtn) {
    aiBtn.addEventListener('click', () => generateAiAvatar());
  }
}

// ── Generate Avatar with AI ──
// Two-step UX matching the backend split:
//   1. POST /generate-avatar — runs ~30 s and charges $0.10 on success.
//   2. After the user confirms, POST /apply-avatar — uploads to Telegram.
async function generateAiAvatar() {
  if (!currentProject) return;
  if (!currentProject.botUsername) {
    showToast(t('ai_avatar_no_bot') || 'Link a bot first to set its avatar.', 'info');
    return;
  }

  const btn = document.getElementById('btn-generate-avatar');
  if (!btn || btn.disabled) return;
  const originalHtml = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('is-loading');
  btn.innerHTML = `<span class="ai-avatar-spinner"></span><span class="ai-avatar-btn-text">${t('ai_avatar_generating') || 'Generating…'}</span>`;
  tg?.HapticFeedback?.impactOccurred?.('light');

  try {
    const res = await fetch(`${API_BASE}/projects/${currentProject.id}/generate-avatar`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.error === 'insufficient_balance') {
        showToast(t('ai_avatar_low_balance') || 'Insufficient balance for AI avatar ($0.10)', 'error');
      } else {
        showToast(data.error || t('ai_avatar_failed') || 'Avatar generation failed', 'error');
      }
      return;
    }

    const imageUrl = data.imageUrl;
    if (!imageUrl) {
      showToast(t('ai_avatar_failed') || 'Avatar generation failed', 'error');
      return;
    }

    // Refresh balance immediately so the user sees the credit deduction.
    if (typeof data.newCredits === 'number' || typeof data.newBalance === 'number') {
      const newCr = data.newCredits ?? data.newBalance;
      userCredits = newCr;
      const balEl = document.getElementById('balance-amount');
      if (balEl) balEl.innerHTML = `${coinSvg(18, 12, 'currentColor')}&nbsp;${Math.max(0, Math.floor(newCr)).toLocaleString()}`;
    }

    showAiAvatarPreview(imageUrl);
  } catch (err) {
    showToast(t('ai_avatar_failed') || 'Avatar generation failed', 'error');
    console.error('[AI Avatar] generation error:', err);
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
    btn.innerHTML = originalHtml;
  }
}

// Show the freshly-generated image and ask the user to confirm replacement.
function showAiAvatarPreview(imageUrl) {
  // Preload — gives the confirm dialog instant feedback when the user accepts.
  const img = new Image();
  img.src = imageUrl;

  // Update the preview avatar so the user sees what they'd get.
  const avatarEl = document.getElementById('edit-avatar');
  const previousBg = avatarEl?.style.backgroundImage || '';
  if (avatarEl) {
    avatarEl.textContent = '';
    avatarEl.style.backgroundImage = `url(${imageUrl})`;
    avatarEl.style.backgroundSize = 'cover';
    avatarEl.style.backgroundPosition = 'center';
  }

  const message = t('ai_avatar_confirm') || 'Do you want to replace the actual avatar for this bot?';
  const onAnswer = (ok) => {
    if (!ok) {
      // Revert preview if the user declined.
      if (avatarEl) avatarEl.style.backgroundImage = previousBg;
      return;
    }
    applyAiAvatar(imageUrl, previousBg);
  };

  if (tg?.showConfirm) {
    tg.showConfirm(message, onAnswer);
  } else {
    onAnswer(window.confirm(message));
  }
}

async function applyAiAvatar(imageUrl, previousBg) {
  if (!currentProject) return;
  tg?.MainButton?.showProgress?.();
  try {
    const res = await fetch(`${API_BASE}/projects/${currentProject.id}/apply-avatar`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageUrl }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      const avatarEl = document.getElementById('edit-avatar');
      if (avatarEl && previousBg !== undefined) avatarEl.style.backgroundImage = previousBg;
      showToast(data.error || t('ai_avatar_apply_failed') || 'Failed to set avatar', 'error');
      return;
    }
    showToast(t('ai_avatar_applied') || 'Avatar updated!', 'success');
    // Reload list so the new avatar shows up everywhere; pulls a fresh URL.
    await loadProjects();
    const fresh = projects.find(p => p.id === currentProject.id);
    if (fresh) {
      currentProject.avatarUrl = fresh.avatarUrl;
    }
  } catch (err) {
    console.error('[AI Avatar] apply error:', err);
    showToast(t('ai_avatar_apply_failed') || 'Failed to set avatar', 'error');
  } finally {
    tg?.MainButton?.hideProgress?.();
  }
}

// ── Token actions ──

function revealAndCopy(spoilerEl, text) {
  if (!text) return;
  spoilerEl.classList.add('js-spoiler-revealed');
  spoilerEl.classList.remove('spoiler-active');
  destroySpoilerPoints(spoilerEl);
  navigator.clipboard.writeText(text).then(() => {
    showToast(t('toast_copied'), 'success');
  });
  setTimeout(() => {
    spoilerEl.classList.remove('js-spoiler-revealed');
    spoilerEl.classList.add('spoiler-active');
    generateSpoilerPoints(spoilerEl);
  }, 2500);
}

function initTokenActions() {
  document.getElementById('webapp-url-row').addEventListener('click', () => {
    const url = document.getElementById('webapp-url-text').textContent;
    revealAndCopy(document.getElementById('webapp-url-spoiler'), url);
  });

  document.getElementById('token-spoiler').addEventListener('click', () => {
    revealAndCopy(document.getElementById('token-spoiler'), currentToken);
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
    actionsHtml += `<a class="tm-row tm-row-link" id="btn-release-version"><span class="tm-icon af-icon-release"></span><span>${t('version_release')}</span></a>`;
    actionsHtml += `<a class="tm-row tm-row-link" id="btn-revert-version"><span class="tm-icon af-icon-revert"></span><span>${t('version_revert')}</span></a>`;
  } else {
    actionsHtml += `<a class="tm-row tm-row-link" style="opacity:0.5;pointer-events:none;"><span class="tm-icon af-icon-release"></span><span>Currently Released</span></a>`;
  }

  if (v.changelogUrl) {
    actionsHtml += `<a class="tm-row tm-row-link" id="btn-changelog-link"><span class="tm-icon af-icon-changelog"></span><span>${t('version_change_log')}</span></a>`;
  }

  if (v.hasLog && isAdmin) {
    actionsHtml += `<a class="tm-row tm-row-link" id="btn-view-log"><span class="tm-icon af-icon-log"></span><span>${t('version_view_log')}</span></a>`;
    actionsHtml += `<a class="tm-row tm-row-link" id="btn-download-log"><span class="tm-icon af-icon-download"></span><span>${t('version_download_log')}</span></a>`;
  }
  if (v.hasDetailedLog && isAdmin) {
    actionsHtml += `<a class="tm-row tm-row-link" id="btn-download-detailed-log"><span class="tm-icon af-icon-download"></span><span>${t('version_download_detailed_log')}</span></a>`;
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

  document.getElementById('btn-view-log')?.addEventListener('click', () => {
    if (!currentProject) return;
    openAgentLogViewer(currentProject.id, v.version);
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

  document.getElementById('btn-download-detailed-log')?.addEventListener('click', async () => {
    if (!currentProject) return;
    try {
      const res = await fetch(`${API_BASE}/versions/${currentProject.id}/detailed-log/${v.version}`, { headers: apiHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `detailed-log-${v.version}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download detailed log error:', err);
      showToast('Failed to download detailed log.', 'error');
    }
  });

  showView('version-detail');
}

// ── Features ──

// Inline SVG illustrations per feature id. Kept as pure SVG (no external assets)
// so they inherit theme colors and stay crisp on any DPI.
const FEATURE_ICONS = {
  stars_payment: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="fi-stars-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#FFD66B"/>
          <stop offset="100%" stop-color="#FF9A3C"/>
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#fi-stars-bg)"/>
      <path d="M32 14l4.6 10.5 11.4 1.1-8.6 7.7 2.6 11.2L32 38.7l-10 5.8 2.6-11.2-8.6-7.7 11.4-1.1L32 14z"
            fill="#fff" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>
      <circle cx="48" cy="18" r="2.4" fill="#fff" opacity="0.85"/>
      <circle cx="16" cy="46" r="1.8" fill="#fff" opacity="0.7"/>
    </svg>`,
  ton_payment: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="fi-ton-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#3CB6FF"/>
          <stop offset="100%" stop-color="#1F6FE0"/>
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#fi-ton-bg)"/>
      <!-- Diamond / gem outline -->
      <path d="M32 50 L14 24 L24 18 H40 L50 24 Z"
            fill="#fff" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/>
      <!-- Inner facets: two diagonals from top corners meeting at center, then down -->
      <path d="M24 18 L32 30 L40 18 M14 24 L32 30 L50 24 M32 30 V50"
            stroke="#1F6FE0" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>`,
  admin_panel: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="fi-admin-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#A07BFF"/>
          <stop offset="100%" stop-color="#5B3DDB"/>
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#fi-admin-bg)"/>
      <rect x="12" y="16" width="40" height="32" rx="4" fill="#fff" opacity="0.95"/>
      <rect x="12" y="16" width="40" height="7" rx="4" fill="#fff"/>
      <circle cx="16.5" cy="19.5" r="1.2" fill="#5B3DDB"/>
      <circle cx="20.5" cy="19.5" r="1.2" fill="#5B3DDB"/>
      <circle cx="24.5" cy="19.5" r="1.2" fill="#5B3DDB"/>
      <rect x="16" y="28" width="14" height="4" rx="1.5" fill="#5B3DDB"/>
      <rect x="16" y="34" width="22" height="3" rx="1.5" fill="#A07BFF"/>
      <rect x="16" y="39" width="18" height="3" rx="1.5" fill="#A07BFF"/>
      <rect x="38" y="28" width="10" height="14" rx="2" fill="#5B3DDB"/>
    </svg>`,
  disable_splash: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="fi-splash-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#3FE0A2"/>
          <stop offset="100%" stop-color="#1A9F70"/>
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#fi-splash-bg)"/>
      <rect x="18" y="12" width="28" height="40" rx="5" fill="#fff"/>
      <rect x="22" y="18" width="20" height="22" rx="2" fill="#1A9F70" opacity="0.18"/>
      <circle cx="32" cy="46" r="2" fill="#1A9F70" opacity="0.4"/>
      <path d="M14 14l36 36" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
      <path d="M14 14l36 36" stroke="#E94B4B" stroke-width="2.4" stroke-linecap="round"/>
    </svg>`,
  get_code: `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="fi-code-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#2AB7CA"/>
          <stop offset="100%" stop-color="#1668B0"/>
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#fi-code-bg)"/>
      <rect x="9" y="14" width="46" height="36" rx="4" fill="#0E2A45"/>
      <rect x="9" y="14" width="46" height="7" rx="4" fill="#1668B0"/>
      <circle cx="13.5" cy="17.5" r="1.1" fill="#FF6B6B"/>
      <circle cx="17.5" cy="17.5" r="1.1" fill="#FFD166"/>
      <circle cx="21.5" cy="17.5" r="1.1" fill="#3FE0A2"/>
      <path d="M22 30l-5 5 5 5M42 30l5 5-5 5M36 28l-8 14"
            stroke="#7FE7FF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    </svg>`,
};
const FEATURE_ICON_FALLBACK = `
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="2" y="2" width="60" height="60" rx="16" fill="#3a3a3a"/>
      <path d="M32 18v22M21 29h22" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
    </svg>`;

function featureLabel(f) {
  const key = `feature_${f.id}_label`;
  const localized = t(key);
  return localized && localized !== key ? localized : (f.label || f.id);
}

function featureDescription(f) {
  const key = `feature_${f.id}_desc`;
  const localized = t(key);
  return localized && localized !== key ? localized : (f.description || '');
}

function fmtBalance(amount) {
  const cr = Math.floor(Number(amount) || 0);
  return `${coinSvg(15, 10, 'currentColor')}&nbsp;${cr.toLocaleString()}`;
}

function fmtTemplate(key, vars) {
  let s = t(key);
  if (!s) return '';
  for (const k of Object.keys(vars)) {
    s = s.split(`{${k}}`).join(vars[k]);
  }
  return s;
}

function renderBundleCard(bundle) {
  if (!bundle || !bundle.available) return '';
  const cp = Number(bundle.creditsPrice || 0);
  const cfull = Number(bundle.fullCreditsPrice || 0);
  const csave = Number(bundle.saveCredits || 0);
  const tag = esc(t('bundle_offer_tag'));
  const title = esc(t('bundle_title'));
  const subtitle = esc(t('bundle_subtitle'));
  const cta = cp > 0
    ? `Unlock all · ${coinSvg(12, 8, '#000')}${cp.toLocaleString()}`
    : `Unlock all · $${Number(bundle.price)}`;
  const saveText = csave > 0
    ? `SAVE ${coinSvg(10, 7, '#1a3a1f')}${csave.toLocaleString()}`
    : `SAVE $${Math.max(0, Number(bundle.fullPrice) - Number(bundle.price))}`;
  return `
    <button type="button" class="feature-bundle" data-bundle="1"
            data-price="${esc(String(bundle.price))}" data-full="${esc(String(bundle.fullPrice))}"
            data-credits-price="${cp}" data-full-credits="${cfull}">
      <span class="feature-bundle-tag">${tag}</span>
      <div class="feature-bundle-body">
        <div class="feature-bundle-icon" aria-hidden="true">
          <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="fb-gift" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="#FFE680"/>
                <stop offset="100%" stop-color="#FF8A3D"/>
              </linearGradient>
            </defs>
            <rect x="8" y="22" width="48" height="34" rx="5" fill="url(#fb-gift)"/>
            <rect x="8" y="22" width="48" height="10" rx="5" fill="#fff" opacity="0.35"/>
            <rect x="29" y="22" width="6" height="34" fill="#fff" opacity="0.85"/>
            <path d="M32 22c-6-8-16-2-12 4 2 3 8 3 12 0z" fill="#fff" opacity="0.85"/>
            <path d="M32 22c6-8 16-2 12 4-2 3-8 3-12 0z" fill="#fff" opacity="0.85"/>
            <circle cx="14" cy="14" r="2" fill="#fff" opacity="0.7"/>
            <circle cx="54" cy="48" r="1.6" fill="#fff" opacity="0.6"/>
            <path d="M50 14l1.5 3 3 .4-2.2 2 .5 3-2.8-1.5-2.8 1.5.5-3-2.2-2 3-.4z" fill="#fff" opacity="0.85"/>
          </svg>
        </div>
        <div class="feature-bundle-text">
          <div class="feature-bundle-title">${title}</div>
          <div class="feature-bundle-subtitle">${subtitle}</div>
          <div class="feature-bundle-pricing">
            <span class="feature-bundle-price">${coinSvg(12, 8, '#fbbf24')}${cp.toLocaleString()}</span>
            ${cfull > 0 ? `<span class="feature-bundle-strike">${coinSvg(10, 7, 'rgba(255,255,255,0.4)')}&nbsp;${cfull.toLocaleString()}</span>` : ''}
            <span class="feature-bundle-save">${saveText}</span>
          </div>
        </div>
      </div>
      <div class="feature-bundle-cta">${cta}</div>
    </button>`;
}

async function openFeatures(projectId) {
  try {
    const res = await fetch(`${API_BASE}/features/${projectId}`, { headers: apiHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    document.getElementById('features-balance').innerHTML = fmtBalance(data.balance);

    const listEl = document.getElementById('features-list');
    const visible = data.features.filter(f => f.id !== 'admin_panel');
    const cards = visible.map(f => {
      const label = featureLabel(f);
      const desc = featureDescription(f);
      const icon = FEATURE_ICONS[f.id] || FEATURE_ICON_FALLBACK;
      // Status pill always lives in the same slot below the description so
      // owned and locked cards share an identical layout regardless of how
      // long the title is. Owned → green check pill. Locked → blue CTA pill.
      const status = f.owned
        ? `<div class="feature-card-cta feature-card-cta--owned">
             <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
             <span>${esc(t('feature_status_unlocked'))}</span>
           </div>`
        : `<div class="feature-card-cta">${esc(t('feature_status_unlock'))} · ${f.creditsPrice > 0 ? (coinSvg(11, 8, '#fbbf24') + Number(f.creditsPrice).toLocaleString()) : ('$' + f.price)}</div>`;
      return `
        <button type="button" class="feature-card${f.owned ? ' feature-card--owned' : ''}"
                data-feature="${esc(f.id)}" data-price="${esc(String(f.price))}"
                data-credits-price="${f.creditsPrice || 0}"
                data-label="${esc(label)}" data-owned="${f.owned ? 'true' : 'false'}">
          <div class="feature-card-icon">${icon}</div>
          <div class="feature-card-body">
            <div class="feature-card-head">
              <div class="feature-card-title">${esc(label)}</div>
            </div>
            <div class="feature-card-desc">${esc(desc)}</div>
            ${status}
          </div>
        </button>`;
    }).join('');
    const bundleHtml = renderBundleCard(data.bundle);
    listEl.innerHTML = `<div class="feature-card-grid">${bundleHtml}${cards}</div>`;

    const refreshOwnedCache = (newlyOwnedIds) => {
      if (!currentProject) return;
      let owned = [];
      try { owned = JSON.parse(currentProject.features || '[]'); } catch (_) {}
      for (const id of newlyOwnedIds) if (!owned.includes(id)) owned.push(id);
      currentProject.features = JSON.stringify(owned);
      const p = projects.find(pp => pp.id === projectId);
      if (p) p.features = currentProject.features;
    };

    const bundleEl = listEl.querySelector('.feature-bundle');
    if (bundleEl) {
      bundleEl.addEventListener('click', () => {
        const price = bundleEl.dataset.price;
        const full = bundleEl.dataset.full;
        const creditsP = bundleEl.dataset.creditsPrice;
        const msg = creditsP > 0
          ? `Unlock all premium features for ${creditsP} credits?`
          : (fmtTemplate('bundle_confirm', { price, full }) || `Unlock all premium features for ${price}?`);
        const doBuy = async () => {
          try {
            const r = await fetch(`${API_BASE}/features/${projectId}/buy-bundle`, {
              method: 'POST',
              headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
              body: JSON.stringify({ payWith: 'credits' }),
            });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || 'Purchase failed');
            showToast(t('bundle_unlocked_toast') || 'All premium features unlocked!', 'success');
            refreshOwnedCache(d.granted || []);
            openFeatures(projectId);
          } catch (err) {
            console.error('Bundle purchase error:', err);
            showToast(err.message || t('feature_purchase_failed') || 'Failed to purchase.', 'error');
          }
        };
        if (tg?.showConfirm) {
          tg.showConfirm(msg, (ok) => { if (ok) doBuy(); });
        } else if (confirm(msg)) {
          doBuy();
        }
      });
    }

    listEl.querySelectorAll('.feature-card').forEach(row => {
      if (row.dataset.owned === 'true') return;
      row.addEventListener('click', () => {
        const featureId = row.dataset.feature;
        const price = row.dataset.price;
        const label = row.dataset.label;
        const msg = fmtTemplate('feature_unlock_confirm', { label, price })
          || `Unlock "${label}" for $${price}?`;
        const doBuy = async () => {
          try {
            const r = await fetch(`${API_BASE}/features/${projectId}/buy`, {
              method: 'POST',
              headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
              body: JSON.stringify({ featureId, payWith: 'credits' }),
            });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || 'Purchase failed');
            const okMsg = fmtTemplate('feature_unlocked_toast', { label }) || `${label} unlocked!`;
            showToast(okMsg, 'success');
            refreshOwnedCache([featureId]);
            openFeatures(projectId);
          } catch (err) {
            console.error('Purchase error:', err);
            showToast(err.message || t('feature_purchase_failed') || 'Failed to purchase.', 'error');
          }
        };
        if (tg?.showConfirm) {
          tg.showConfirm(msg, (ok) => { if (ok) doBuy(); });
        } else if (confirm(msg)) {
          doBuy();
        }
      });
    });

    showView('features');
  } catch (err) {
    console.error('Failed to load features:', err);
    showToast(t('feature_load_failed') || 'Failed to load features.', 'error');
  }
}

// ═══ REGENERATE CONTEXT ═══

async function regenerateContext(projectId) {
  const btn = document.getElementById('detail-settings-rows')
    ?.querySelector('[data-action="open-regen-context"]');
  if (!btn) return;

  const origHtml = btn.innerHTML;
  btn.classList.add('regen-loading');
  btn.innerHTML = `<span class="tm-icon af-icon-refresh regen-spin"></span><span>${t('detail_regen_loading')}</span>`;
  btn.style.pointerEvents = 'none';
  haptic('light');

  try {
    const res = await fetch(`${API_BASE}/regenerate-context/${projectId}`, {
      method: 'POST',
      headers: apiHeaders(),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');

    haptic('light');
    btn.innerHTML = `<span class="tm-icon af-icon-refresh"></span><span>${t('detail_regen_done')}</span>`;
    btn.classList.remove('regen-loading');
    btn.classList.add('regen-success');
    setTimeout(() => {
      btn.innerHTML = origHtml;
      btn.classList.remove('regen-success');
      btn.style.pointerEvents = '';
    }, 2500);
  } catch (e) {
    haptic('light');
    btn.innerHTML = `<span class="tm-icon af-icon-refresh"></span><span>${t('detail_regen_error')}</span>`;
    btn.classList.remove('regen-loading');
    btn.classList.add('regen-error');
    setTimeout(() => {
      btn.innerHTML = origHtml;
      btn.classList.remove('regen-error');
      btn.style.pointerEvents = '';
    }, 2500);
  }
}

// ═══ ADMIN PANEL ═══

let isAdmin = false;
let admChatReturn = false;
let admLastSubpage = null;

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
  showView('admin');
  const rows = document.getElementById('adm-menu-rows');
  rows.innerHTML =
    menuRowAction('Dashboard', 'af-icon-dashboard', 'adm-open-dashboard') +
    menuRowAction('Sources', 'af-icon-dashboard', 'adm-open-sources') +
    menuRowAction('Activities', 'af-icon-activities', 'adm-open-activities') +
    menuRowAction('Users', 'af-icon-users', 'adm-open-users') +
    menuRowAction('Apps', 'af-icon-apps', 'adm-open-apps') +
    menuRowAction('Vouchers', 'af-icon-vouchers', 'adm-open-vouchers') +
    menuRowAction('Configuration', 'af-icon-config', 'adm-open-config') +
    menuRowAction('Onboarding (preview)', 'af-icon-help', 'adm-open-onboarding') +
    `<a class="tm-row tm-row-link" id="adm-open-desktop"><span class="tm-icon af-icon-open"></span><span>Desktop Version</span></a>`;
  rows.querySelector('[data-action="adm-open-dashboard"]')?.addEventListener('click', openAdmDashboard);
  rows.querySelector('[data-action="adm-open-sources"]')?.addEventListener('click', openAdmSources);
  rows.querySelector('[data-action="adm-open-activities"]')?.addEventListener('click', openAdmActivities);
  rows.querySelector('[data-action="adm-open-users"]')?.addEventListener('click', openAdmUsers);
  rows.querySelector('[data-action="adm-open-apps"]')?.addEventListener('click', openAdmApps);
  rows.querySelector('[data-action="adm-open-vouchers"]')?.addEventListener('click', openAdmVouchers);
  rows.querySelector('[data-action="adm-open-config"]')?.addEventListener('click', openAdmConfig);
  rows.querySelector('[data-action="adm-open-onboarding"]')?.addEventListener('click', openOnboarding);
  rows.querySelector('#adm-open-desktop')?.addEventListener('click', () => {
    tg?.openLink(`${location.origin}/telegram-mini-app/desktop.html`);
  });
  admApi('/stats').then(d => {
    document.getElementById('adm-info').innerHTML =
      `Users: <b>${d.userCount}</b> · Apps: <b>${d.projectCount}</b> · Revenue: <b>${admFmtMoney(d.totalTopups)}</b>`;
  }).catch(() => {});
}

async function openAdmDashboard() {
  admLastSubpage = 'adm-dashboard';
  showView('adm-dashboard');
  const el = document.getElementById('adm-dashboard-content');
  el.innerHTML = '<div class="loading-spinner"></div>';
  try {
    const d = await admApi('/stats');
    const conv = d.userCount > 0 ? ((d.payingUsers / d.userCount) * 100).toFixed(1) : '0.0';
    let html = `<div class="adm-stats" style="width:100%;">
      <div class="adm-stat-card"><div class="adm-stat-label">Users</div><div class="adm-stat-value blue">${d.userCount}</div></div>
      <div class="adm-stat-card"><div class="adm-stat-label">Paying Users</div><div class="adm-stat-value blue">${d.payingUsers || 0}</div></div>
      <div class="adm-stat-card"><div class="adm-stat-label">Conversion</div><div class="adm-stat-value">${conv}%</div></div>
      <div class="adm-stat-card"><div class="adm-stat-label">Projects</div><div class="adm-stat-value">${d.projectCount}</div></div>
      <div class="adm-stat-card"><div class="adm-stat-label">Revenue</div><div class="adm-stat-value green">${admFmtMoney(d.totalTopups)}</div></div>
      <div class="adm-stat-card"><div class="adm-stat-label">Spent</div><div class="adm-stat-value yellow">${admFmtMoney(d.totalSpent)}</div></div>
      <div class="adm-stat-card"><div class="adm-stat-label">Active (7d)</div><div class="adm-stat-value blue">${d.activeUsers7d || 0}</div></div>
      <div class="adm-stat-card"><div class="adm-stat-label">Avg Spend</div><div class="adm-stat-value">${d.payingUsers > 0 ? admFmtMoney(d.totalTopups / d.payingUsers) : '$0.00'}</div></div>
    </div>`;
    el.innerHTML = html;
  } catch (err) { el.innerHTML = `<div class="adm-empty">Failed to load: ${esc(err.message)}</div>`; }
}

function admFmtInt(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

// Cache for Sources screen data + active tab
let admSourcesData = null;
let admSourcesTab = 'all'; // 'all' | 'sources' | 'partners' | 'referrers'
let admSourcesRange = { preset: 'all', from: null, to: null }; // preset: 'today' | 'week' | 'all' | 'custom'

function admIsoStartOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function admIsoStartDaysAgo(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function admIsoEndOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

function admPresetToRange(preset) {
  switch (preset) {
    case 'today': return { preset, from: admIsoStartOfToday(),    to: admIsoEndOfToday() };
    case 'week':  return { preset, from: admIsoStartDaysAgo(6),   to: admIsoEndOfToday() };
    case 'all':   return { preset, from: null,                    to: null };
    default:      return { preset: 'all', from: null, to: null };
  }
}

// Convert an ISO string into the value expected by <input type="date"> (YYYY-MM-DD)
function admIsoToDateInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Convert a YYYY-MM-DD value into ISO timestamps for the start of that
// local day (for `from`) or the very end of the day (for `to`).
function admDateInputToIso(value, edge) {
  if (!value) return null;
  const [y, m, d] = value.split('-').map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d, edge === 'end' ? 23 : 0, edge === 'end' ? 59 : 0, edge === 'end' ? 59 : 0, edge === 'end' ? 999 : 0);
  return dt.toISOString();
}

// Build a uniform "block" object from any type (source/partner/referrer/organic/all)
function admBuildBlock(item, kind) {
  switch (kind) {
    case 'all':
      return { kind: 'all', title: 'All Users', ...item };
    case 'organic':
      return { kind: 'organic', title: 'Organic', ...item };
    case 'source':
      return { kind: 'source', title: item.source, ...item };
    case 'partner': {
      const name = item.firstName || item.username || `User ${item.telegramId}`;
      return {
        kind: 'partner',
        title: name,
        subtitle: item.partnerTag ? `@${item.partnerTag}` : (item.username ? `@${item.username}` : ''),
        avatarUrl: item.avatarUrl || null,
        partnerPercent: item.partnerPercent,
        ...item,
      };
    }
    case 'referrer': {
      const name = item.firstName || item.username || `User ${item.telegramId}`;
      return {
        kind: 'referrer',
        title: name,
        subtitle: item.username ? `@${item.username}` : `ID ${item.telegramId}`,
        avatarUrl: item.avatarUrl || null,
        ...item,
      };
    }
  }
  return null;
}

const ADM_KIND_META = {
  all:      { label: 'TOTAL',    cssClass: 'all' },
  organic:  { label: 'ORGANIC',  cssClass: 'organic' },
  source:   { label: 'SOURCE',   cssClass: 'source' },
  partner:  { label: 'PARTNER',  cssClass: 'partner' },
  referrer: { label: 'REFERRER', cssClass: 'referrer' },
};

function admAvatarBlock(b) {
  if (b.avatarUrl) {
    return `<div class="adm-src-avatar"><img src="${esc(b.avatarUrl)}" alt="" loading="lazy"></div>`;
  }
  const initial = (b.title || '?').trim().charAt(0).toUpperCase() || '?';
  const hue = Math.abs(
    Array.from(String(b.telegramId || b.title || '?'))
      .reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)
  ) % 360;
  return `<div class="adm-src-avatar placeholder" style="background:hsl(${hue}, 55%, 35%);">${esc(initial)}</div>`;
}

function admSourceCard(block) {
  const meta = ADM_KIND_META[block.kind] || ADM_KIND_META.source;
  const conv = block.conversion.toFixed(1);
  const arpu = block.arpu.toFixed(2);
  const arppu = block.arppu.toFixed(2);
  const funnelPct = (num) => block.users > 0 ? Math.round((num / block.users) * 100) : 0;
  const hasPerson = block.kind === 'partner' || block.kind === 'referrer';

  // Title label
  let titleLabel = block.title;
  if (block.kind === 'source' && block.title === '(direct)') titleLabel = 'Direct / Unknown';

  const subtitle = block.subtitle
    ? `<div class="adm-src-subtitle">${esc(block.subtitle)}</div>`
    : '';

  const partnerBadge = block.kind === 'partner' && block.partnerPercent != null
    ? `<span class="adm-src-pct">${Number(block.partnerPercent).toFixed(0)}%</span>`
    : '';

  return `
    <div class="adm-src-card ${meta.cssClass}">
      <div class="adm-src-head">
        ${hasPerson ? admAvatarBlock(block) : ''}
        <div class="adm-src-head-main">
          <div class="adm-src-type-row">
            <span class="adm-src-pill ${meta.cssClass}">${meta.label}</span>
            ${partnerBadge}
          </div>
          <div class="adm-src-title">${esc(titleLabel)}</div>
          ${subtitle}
        </div>
        <div class="adm-src-users">
          <div class="adm-src-users-num">${admFmtInt(block.users)}</div>
          <div class="adm-src-users-lbl">users</div>
        </div>
      </div>

      <div class="adm-src-funnel">
        <div class="adm-funnel-row">
          <div class="adm-funnel-label">Created App</div>
          <div class="adm-funnel-bar"><div class="adm-funnel-fill bot" style="width:${funnelPct(block.createdApp)}%"></div></div>
          <div class="adm-funnel-val">${block.createdApp} <span>·</span> ${funnelPct(block.createdApp)}%</div>
        </div>
        <div class="adm-funnel-row">
          <div class="adm-funnel-label">Created Plan</div>
          <div class="adm-funnel-bar"><div class="adm-funnel-fill plan" style="width:${funnelPct(block.createdPlan)}%"></div></div>
          <div class="adm-funnel-val">${block.createdPlan} <span>·</span> ${funnelPct(block.createdPlan)}%</div>
        </div>
        <div class="adm-funnel-row">
          <div class="adm-funnel-label">Built App</div>
          <div class="adm-funnel-bar"><div class="adm-funnel-fill app" style="width:${funnelPct(block.builtApp)}%"></div></div>
          <div class="adm-funnel-val">${block.builtApp} <span>·</span> ${funnelPct(block.builtApp)}%</div>
        </div>
        <div class="adm-funnel-row">
          <div class="adm-funnel-label">Paying</div>
          <div class="adm-funnel-bar"><div class="adm-funnel-fill pay" style="width:${funnelPct(block.payingUsers)}%"></div></div>
          <div class="adm-funnel-val">${block.payingUsers} <span>·</span> ${funnelPct(block.payingUsers)}%</div>
        </div>
      </div>

      <div class="adm-src-metrics">
        <div class="adm-src-metric">
          <div class="adm-src-metric-label">Conversion</div>
          <div class="adm-src-metric-value blue">${conv}%</div>
        </div>
        <div class="adm-src-metric">
          <div class="adm-src-metric-label">Revenue</div>
          <div class="adm-src-metric-value green">$${block.revenue.toFixed(2)}</div>
        </div>
        <div class="adm-src-metric">
          <div class="adm-src-metric-label">ARPU</div>
          <div class="adm-src-metric-value">$${arpu}</div>
        </div>
        <div class="adm-src-metric">
          <div class="adm-src-metric-label">ARPPU</div>
          <div class="adm-src-metric-value yellow">$${arppu}</div>
        </div>
      </div>

      <button class="adm-src-users-btn"
              data-users-kind="${esc(block.kind)}"
              data-users-key="${esc(admBlockKey(block))}"
              data-users-title="${esc(titleLabel)}">
        View ${admFmtInt(block.users)} user${block.users === 1 ? '' : 's'} →
      </button>
    </div>
  `;
}

// Identifier that uniquely picks this bucket on the backend.
//   source:  utm_source value
//   partner / referrer: referrer's telegramId
//   all / organic: empty (the kind alone is enough)
function admBlockKey(block) {
  if (block.kind === 'source')  return block.source || block.title || '';
  if (block.kind === 'partner' || block.kind === 'referrer') return block.telegramId || '';
  return '';
}

function admRenderSources() {
  const el = document.getElementById('adm-sources-content');
  if (!admSourcesData) { el.innerHTML = '<div class="loading-spinner"></div>'; return; }
  const d = admSourcesData;

  const tabs = [
    { id: 'all',       label: 'All' },
    { id: 'sources',   label: 'Sources',   count: d.sources.length },
    { id: 'partners',  label: 'Partners',  count: d.partners.length },
    { id: 'referrers', label: 'Referrers', count: d.referrers.length },
  ];

  const tabsHtml = `<div class="adm-tabs">${
    tabs.map(t => {
      const badge = t.count != null ? `<span class="adm-tab-count">${t.count}</span>` : '';
      return `<button class="adm-tab ${t.id === admSourcesTab ? 'active' : ''}" data-tab="${t.id}">${t.label}${badge}</button>`;
    }).join('')
  }</div>`;

  let blocks = [];
  if (admSourcesTab === 'all') {
    blocks.push(admBuildBlock(d.all, 'all'));
    if (d.organic.users > 0) blocks.push(admBuildBlock(d.organic, 'organic'));
    for (const s of d.sources)   blocks.push(admBuildBlock(s, 'source'));
    for (const p of d.partners)  blocks.push(admBuildBlock(p, 'partner'));
    for (const r of d.referrers) blocks.push(admBuildBlock(r, 'referrer'));
  } else if (admSourcesTab === 'sources') {
    blocks = d.sources.map(s => admBuildBlock(s, 'source'));
  } else if (admSourcesTab === 'partners') {
    blocks = d.partners.map(p => admBuildBlock(p, 'partner'));
  } else if (admSourcesTab === 'referrers') {
    blocks = d.referrers.map(r => admBuildBlock(r, 'referrer'));
  }

  const body = blocks.length
    ? blocks.map(admSourceCard).join('')
    : `<div class="adm-empty">No users registered in this date range</div>`;

  el.innerHTML = admSourcesControlsHtml() + tabsHtml + body;

  admWireSourcesControls();

  el.querySelectorAll('.adm-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      admSourcesTab = btn.dataset.tab;
      admRenderSources();
    });
  });

  el.querySelectorAll('.adm-src-users-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openAdmSourceUsers(btn.dataset.usersKind, btn.dataset.usersKey, btn.dataset.usersTitle);
    });
  });
}

async function openAdmSources() {
  admLastSubpage = 'adm-sources';
  showView('adm-sources');
  await admReloadSources();
}

async function admReloadSources() {
  const el = document.getElementById('adm-sources-content');
  admSourcesData = null;
  el.innerHTML = admSourcesControlsHtml() + '<div class="loading-spinner"></div>';
  admWireSourcesControls();
  try {
    const params = new URLSearchParams();
    if (admSourcesRange.from) params.set('from', admSourcesRange.from);
    if (admSourcesRange.to)   params.set('to',   admSourcesRange.to);
    const qs = params.toString();
    admSourcesData = await admApi('/stats/sources' + (qs ? `?${qs}` : ''));
    admRenderSources();
  } catch (err) {
    el.innerHTML = admSourcesControlsHtml() + `<div class="adm-empty">Failed to load: ${esc(err.message)}</div>`;
    admWireSourcesControls();
  }
}

function admSourcesControlsHtml() {
  const r = admSourcesRange;
  const presets = [
    { id: 'today', label: 'Today' },
    { id: 'week',  label: 'Week' },
    { id: 'all',   label: 'All Time' },
  ];
  const presetBtns = presets.map(p =>
    `<button class="adm-range-btn ${r.preset === p.id ? 'active' : ''}" data-range-preset="${p.id}">${p.label}</button>`
  ).join('');

  const fromVal = admIsoToDateInput(r.from);
  const toVal   = admIsoToDateInput(r.to);

  return `
    <div class="adm-range">
      <div class="adm-range-presets">${presetBtns}</div>
      <div class="adm-range-custom">
        <input type="date" id="adm-range-from" value="${fromVal}" aria-label="From date">
        <span class="adm-range-sep">→</span>
        <input type="date" id="adm-range-to"   value="${toVal}"   aria-label="To date">
        <button class="adm-range-apply" id="adm-range-apply">Apply</button>
      </div>
    </div>
  `;
}

function admWireSourcesControls() {
  const root = document.getElementById('adm-sources-content');
  if (!root) return;

  root.querySelectorAll('[data-range-preset]').forEach(btn => {
    btn.addEventListener('click', () => {
      admSourcesRange = admPresetToRange(btn.dataset.rangePreset);
      admReloadSources();
    });
  });

  const apply = root.querySelector('#adm-range-apply');
  if (apply) {
    apply.addEventListener('click', () => {
      const fromInput = root.querySelector('#adm-range-from');
      const toInput   = root.querySelector('#adm-range-to');
      const from = admDateInputToIso(fromInput && fromInput.value, 'start');
      const to   = admDateInputToIso(toInput && toInput.value, 'end');
      admSourcesRange = { preset: 'custom', from, to };
      admReloadSources();
    });
  }
}

// ---- Source-Users drill-down ----
// Opens a sub-view listing every user that registered in the active Sources
// date range AND belongs to the bucket (kind+key) the admin tapped on.
let admSourceUsersCtx = null; // { kind, key, title }

function admSourceRangeLabel() {
  const r = admSourcesRange;
  if (r.preset === 'today')  return 'today';
  if (r.preset === 'week')   return 'last 7 days';
  if (r.preset === 'all' || (!r.from && !r.to)) return 'all time';
  const fmt = (iso) => admIsoToDateInput(iso) || '?';
  return `${fmt(r.from)} → ${fmt(r.to)}`;
}

async function openAdmSourceUsers(kind, key, title) {
  admSourceUsersCtx = { kind, key: key || '', title: title || 'Users' };
  showView('adm-source-users');

  const titleEl = document.getElementById('adm-source-users-title');
  const subEl   = document.getElementById('adm-source-users-sub');
  const el      = document.getElementById('adm-source-users-content');
  if (titleEl) titleEl.textContent = admSourceUsersCtx.title;
  if (subEl)   subEl.textContent   = `Registered · ${admSourceRangeLabel()}`;
  if (el)      el.innerHTML        = '<div class="loading-spinner"></div>';

  try {
    const params = new URLSearchParams();
    params.set('kind', kind);
    if (key) params.set('key', key);
    if (admSourcesRange.from) params.set('from', admSourcesRange.from);
    if (admSourcesRange.to)   params.set('to',   admSourcesRange.to);
    const data = await admApi('/stats/sources/users?' + params.toString());
    admRenderSourceUsers(data);
  } catch (err) {
    if (el) el.innerHTML = `<div class="adm-empty">Failed to load: ${esc(String(err && err.message || err))}</div>`;
  }
}

function admRenderSourceUsers(data) {
  const el = document.getElementById('adm-source-users-content');
  if (!el) return;
  const subEl = document.getElementById('adm-source-users-sub');
  if (subEl) {
    subEl.textContent = `${data.count} user${data.count === 1 ? '' : 's'} · registered · ${admSourceRangeLabel()}`;
  }

  if (!data.users || !data.users.length) {
    el.innerHTML = '<div class="adm-empty">No users in this bucket for the selected range</div>';
    return;
  }

  let html = '<div class="tm-table-wrap">';
  for (const u of data.users) {
    const name = u.username || u.firstName || 'User ' + u.id;
    const avatar = userAvatarHtml(name, u.username);
    const flags = [
      u.hasApp   ? 'app'   : null,
      u.hasPlan  ? 'plan'  : null,
      u.hasBuilt ? 'built' : null,
      u.revenue > 0 ? `$${u.revenue.toFixed(2)}` : null,
    ].filter(Boolean).join(' · ') || 'no activity';
    html += `<a class="tm-row tm-row-link" data-user-id="${u.id}">` +
      avatar +
      `<div style="flex:1;min-width:0;overflow:hidden;">` +
        `<div class="tm-row-value" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(name)}</div>` +
        `<div class="tm-row-description">${esc(flags)} · ${admFmtDate(u.createdAt)}</div>` +
      `</div>` +
      `<div class="tm-row-status"><span class="tm-status-dot" style="background:${Number(u.balance) > 0 ? '#5CC377' : '#708499'}"></span>${admFmtMoney(u.balance)}</div>` +
      `</a>`;
  }
  html += '</div>';
  el.innerHTML = html;

  el.querySelectorAll('[data-user-id]').forEach(row => {
    row.addEventListener('click', () => openAdmUserDetail(row.dataset.userId));
  });
}

async function openAdmActivities() {
  admLastSubpage = 'adm-activities';
  showView('adm-activities');
  const el = document.getElementById('adm-activities-content');
  el.innerHTML = '<div class="loading-spinner"></div>';
  try {
    const d = await admApi('/stats');
    if (!d.recentUsage.length) {
      el.innerHTML = '<div class="adm-empty">No activity yet</div>';
      return;
    }
    let html = '<div class="tm-table-wrap">';
    for (const u of d.recentUsage) {
      html += `<div class="adm-row" style="cursor:default;">
        <div class="adm-row-main">
          <div class="adm-row-title">${esc(u.username)}</div>
          <div class="adm-row-sub">${esc(u.project)} · ${u.operation}</div>
        </div>
        <div class="adm-row-right"><div class="adm-row-value">${admFmtMoney(u.cost)}</div></div>
      </div>`;
    }
    html += '</div>';
    el.innerHTML = html;
  } catch (err) { el.innerHTML = `<div class="adm-empty">Failed to load: ${esc(err.message)}</div>`; }
}

async function openAdmUsers() {
  admLastSubpage = 'adm-users';
  showView('adm-users');
  const el = document.getElementById('adm-users-content');
  el.innerHTML = '<div class="loading-spinner"></div>';
  try {
    const users = await admApi('/users');
    if (!users.length) { el.innerHTML = '<div class="adm-empty">No users yet</div>'; return; }
    let html = '<div class="tm-table-wrap">';
    for (const u of users) {
      const name = u.username || u.firstName || 'User ' + u.id;
      const avatar = userAvatarHtml(name, u.username);
      html += `<a class="tm-row tm-row-link" data-user-id="${u.id}">` +
        avatar +
        `<div style="flex:1;min-width:0;overflow:hidden;"><div class="tm-row-value" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(name)}</div>` +
        `<div class="tm-row-description">${u.projectCount} app${u.projectCount !== 1 ? 's' : ''} · ${admFmtDate(u.createdAt)}</div></div>` +
        `<div class="tm-row-status"><span class="tm-status-dot" style="background:${Number(u.balance) > 0 ? '#5CC377' : '#708499'}"></span>${admFmtMoney(u.balance)}</div>` +
        `</a>`;
    }
    html += '</div>';
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
    subEl.textContent = '@' + (u.username || u.telegramId);

    let html = '';

    // Stats section
    html += `<section class="tm-section"><div class="adm-info-grid">
      <div class="adm-info-card"><div class="lbl">Balance</div><div class="val" id="adm-bal-val">${admFmtMoney(u.balance)}</div></div>
      <div class="adm-info-card"><div class="lbl">Total Spent</div><div class="val">${admFmtMoney(u.totalSpent)}</div></div>
      <div class="adm-info-card"><div class="lbl">Projects</div><div class="val">${u.projects.length}</div></div>
      <div class="adm-info-card"><div class="lbl">Slots</div><div class="val">${u.appSlots}</div></div>
    </div></section>`;

    if (u.referredBy) {
      html += `<section class="tm-section"><p class="help-text" style="margin:0">Referred by: ${u.referredBy}</p></section>`;
    }

    // Balance Management
    html += `<section class="tm-section tm-menu-items">
      <div class="tm-section-header"><h2 class="tm-section-header-text">Balance Management</h2></div>
      <div class="adm-inline-form">
        <select id="adm-bal-action"><option value="set">Set to</option><option value="add">Add</option></select>
        <input type="number" id="adm-bal-amount" placeholder="Amount" step="0.01" style="width:100px">
        <button class="adm-btn adm-btn-primary" id="adm-bal-btn">Apply</button>
      </div>
    </section>`;

    // Partnership section
    html += `<section class="tm-section tm-menu-items">
      <div class="tm-section-header"><h2 class="tm-section-header-text">Partnership</h2></div>
      <div class="tm-table-wrap">
        <div class="tm-row" style="justify-content:space-between;cursor:default">
          <span>Is Partner</span>
          <label class="adm-toggle"><input type="checkbox" id="adm-partner-toggle" ${u.isPartner ? 'checked' : ''}><span class="adm-toggle-slider"></span></label>
        </div>
        <div class="tm-row" style="flex-wrap:wrap;gap:8px;cursor:default">
          <span style="min-width:100px">Commission %</span>
          <input type="number" id="adm-partner-percent" value="${u.partnerPercent ?? ''}" placeholder="e.g. 20" step="0.1" min="0" max="100" class="adm-input-sm">
        </div>
        <div class="tm-row" style="flex-wrap:wrap;gap:8px;cursor:default">
          <span style="min-width:100px">Partner Tag</span>
          <input type="text" id="adm-partner-tag" value="${u.partnerTag || ''}" placeholder="e.g. john_promo" class="adm-input-sm">
        </div>
        <div class="tm-row" style="flex-wrap:wrap;gap:8px;cursor:default">
          <span style="min-width:100px">Referral Bonus $</span>
          <input type="number" id="adm-partner-bonus" value="${u.partnerReferralBonus ?? ''}" placeholder="0.00" step="0.01" min="0" class="adm-input-sm">
        </div>
        <div class="tm-row" style="cursor:default">
          <span>Partner Balance</span>
          <span style="color:var(--tg-theme-accent-text-color,#4ea4f6);font-weight:600">${admFmtMoney(u.partnerBalance)}</span>
        </div>
      </div>
      <button class="adm-btn adm-btn-primary" id="adm-partner-save" style="margin-top:8px;width:100%">Save Partnership</button>
    </section>`;

    // Projects
    if (u.projects.length) {
      html += `<section class="tm-section tm-menu-items">
        <div class="tm-section-header"><h2 class="tm-section-header-text">Projects</h2></div>
        <div class="tm-table-wrap">`;
      for (const p of u.projects) {
        const [c1, c2] = getGradient(p.name);
        const pAvatar = `<div class="tm-row-pic tm-row-pic-user avatar-gradient" style="background:linear-gradient(135deg,${c1},${c2})">${getInitials(p.name)}</div>`;
        const statusDot = p.status === 'building'
          ? '<span class="loader" style="width:16px;height:16px;margin-right:8px"></span>'
          : `<span class="tm-status-dot ${p.status}"></span>`;
        html += `<a class="tm-row tm-row-link" data-proj-id="${p.id}" style="align-items:center;">` +
          pAvatar +
          `<div style="flex:1;min-width:0;overflow:hidden;"><div class="tm-row-value" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.name)}</div>` +
          `<div class="tm-row-description">${p.botUsername ? '@' + esc(p.botUsername) : 'No bot'}</div></div>` +
          `<div class="tm-row-status">${statusDot}${statusLabel(p.status)}</div>` +
          `</a>`;
      }
      html += `</div></section>`;
    }

    // Payments
    if (u.payments.length) {
      html += `<section class="tm-section tm-menu-items">
        <div class="tm-section-header"><h2 class="tm-section-header-text">Payments</h2></div>
        <div class="adm-table-scroll"><table class="adm-table"><thead><tr><th>Amount</th><th>Status</th><th>Date</th></tr></thead><tbody>`;
      for (const p of u.payments) {
        html += `<tr><td>${admFmtMoney(p.amount)}</td><td>${admBadge(p.status)}</td><td>${admFmtDate(p.createdAt)}</td></tr>`;
      }
      html += `</tbody></table></div></section>`;
    }

    // Usage History
    if (u.usageLogs.length) {
      html += `<section class="tm-section tm-menu-items">
        <div class="tm-section-header"><h2 class="tm-section-header-text">Usage History</h2></div>
        <div class="adm-table-scroll"><table class="adm-table"><thead><tr><th>Project</th><th>Op</th><th>Cost</th><th>Date</th></tr></thead><tbody>`;
      for (const l of u.usageLogs) {
        html += `<tr><td>${esc(l.project)}</td><td>${l.operation}</td><td>${admFmtMoney(l.cost)}</td><td>${admFmtDate(l.createdAt)}</td></tr>`;
      }
      html += `</tbody></table></div></section>`;
    }

    // Info
    html += `<section class="tm-section"><p class="help-text" style="text-align:center">Telegram ID: ${u.telegramId}<br>Joined: ${admFmtDate(u.createdAt)}</p></section>`;

    // Danger zone — wipe user data (keeps apps) + full reset (testing)
    html += `<section class="tm-section tm-menu-items">
      <div class="tm-section-header"><h2 class="tm-section-header-text" style="color:#ff4d4f">Danger Zone</h2></div>
      <p class="help-text" style="margin:0 0 8px">Permanently delete all data attached to this user (payments, conversations, usage logs, withdrawals, voucher redemptions) and reset their profile (balance, partnership, name, language) to defaults. <b>Apps and bots are kept</b> and continue to work.</p>
      <button class="adm-btn adm-btn-danger" id="adm-wipe-user" style="width:100%">Wipe User Data</button>
      <p class="help-text" style="margin:12px 0 8px"><b style="color:#ff6b6b">Full Reset (testing)</b> — deletes EVERYTHING for this user: all data, all apps, the user row itself. After this, opening the Mini App registers them fresh, so source / referrer / partner-tag attribution can be re-tested from scratch.</p>
      <button class="adm-btn adm-btn-danger" id="adm-full-reset" style="width:100%">Full Reset (Delete User &amp; Apps)</button>
    </section>`;

    contentEl.innerHTML = html;

    // Balance handler
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

    // Partnership save handler
    document.getElementById('adm-partner-save')?.addEventListener('click', async () => {
      const btn = document.getElementById('adm-partner-save');
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        const body = {
          isPartner: document.getElementById('adm-partner-toggle').checked,
          partnerPercent: document.getElementById('adm-partner-percent').value || null,
          partnerTag: document.getElementById('adm-partner-tag').value || null,
          partnerReferralBonus: document.getElementById('adm-partner-bonus').value || null,
        };
        await admApi('/users/' + userId + '/partner', { method: 'POST', body });
        showToast('Partnership settings saved', 'success');
      } catch { showToast('Failed to save partnership', 'error'); }
      btn.disabled = false;
      btn.textContent = 'Save Partnership';
    });

    contentEl.querySelectorAll('[data-proj-id]').forEach(row => {
      row.addEventListener('click', () => {
        openAdmProjectChat(row.dataset.projId);
      });
    });

    document.getElementById('adm-wipe-user')?.addEventListener('click', () => {
      const userLabel = u.username ? '@' + u.username : (u.firstName || ('User #' + u.id));
      const msg = `Wipe ALL data for ${userLabel}?\n\nDeletes payments, conversations, usage logs, withdrawals and voucher redemptions. Resets balance, partnership, name and language.\n\nApps and bots are KEPT. This cannot be undone.`;
      const doWipe = async () => {
        const btn = document.getElementById('adm-wipe-user');
        if (!btn) return;
        btn.disabled = true;
        btn.textContent = 'Wiping...';
        try {
          const r = await admApi('/users/' + userId + '/data', { method: 'DELETE' });
          const d = r.deleted || {};
          showToast(`Wiped: ${d.payments||0} payments, ${d.conversations||0} chats, ${d.usageLogs||0} usage, ${d.withdrawals||0} withdrawals`, 'success');
          openAdmUserDetail(userId);
        } catch (err) {
          showToast('Failed to wipe user data', 'error');
          btn.disabled = false;
          btn.textContent = 'Wipe User Data';
        }
      };
      if (tg?.showConfirm) {
        tg.showConfirm(msg, (ok) => { if (ok) doWipe(); });
      } else if (confirm(msg)) {
        doWipe();
      }
    });

    document.getElementById('adm-full-reset')?.addEventListener('click', () => {
      const userLabel = u.username ? '@' + u.username : (u.firstName || ('User #' + u.id));
      const projCount = u.projects.length;
      const msg = `FULL RESET for ${userLabel}?\n\nDeletes ALL data, ALL ${projCount} app${projCount === 1 ? '' : 's'}, and the user row itself.\n\nNext time they open the Mini App they will register as a brand new user — useful for testing referral / source / partner attribution.\n\nThis cannot be undone.`;
      const doFullReset = async () => {
        const btn = document.getElementById('adm-full-reset');
        if (!btn) return;
        btn.disabled = true;
        btn.textContent = 'Resetting...';
        try {
          const r = await admApi('/users/' + userId + '/full', { method: 'DELETE' });
          const d = r.deleted || {};
          showToast(`Full reset: ${d.projects||0} apps, ${d.payments||0} payments, ${d.usageLogs||0} usage, user deleted`, 'success');
          setTimeout(() => openAdmUsers(), 1200);
        } catch (err) {
          showToast('Failed to full-reset user', 'error');
          btn.disabled = false;
          btn.textContent = 'Full Reset (Delete User & Apps)';
        }
      };
      if (tg?.showConfirm) {
        tg.showConfirm(msg, (ok) => { if (ok) doFullReset(); });
      } else if (confirm(msg)) {
        doFullReset();
      }
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

// ── Admin Apps: state shared across renders ──────────────────────────────
let admAppsList = null;            // cached fetch (server source of truth)
let admAppsStatusFilter = 'all';   // 'all' | 'released' | 'deployed' | 'building' | 'planning' | 'created' | 'error'
let admAppsSort = 'updated_desc';  // see ADM_APPS_SORTERS below

// Order chosen so the most actionable statuses are leftmost.
const ADM_APPS_STATUS_ORDER = ['released', 'deployed', 'building', 'planning', 'created', 'error'];

const ADM_APPS_SORTERS = {
  updated_desc: { label: 'Recently updated', cmp: (a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt) },
  created_desc: { label: 'Recently created', cmp: (a, b) => +new Date(b.createdAt) - +new Date(a.createdAt) },
  budget_desc:  { label: 'Budget: high → low', cmp: (a, b) => (b.totalCost || 0) - (a.totalCost || 0) },
  budget_asc:   { label: 'Budget: low → high', cmp: (a, b) => (a.totalCost || 0) - (b.totalCost || 0) },
  name_asc:     { label: 'Name (A → Z)',     cmp: (a, b) => String(a.name || '').localeCompare(String(b.name || '')) },
  status:       { label: 'Status',           cmp: (a, b) => ADM_APPS_STATUS_ORDER.indexOf(a.status) - ADM_APPS_STATUS_ORDER.indexOf(b.status) },
};

async function openAdmApps() {
  admLastSubpage = 'adm-apps';
  showView('adm-apps');
  const el = document.getElementById('adm-apps-content');
  el.innerHTML = '<div class="loading-spinner"></div>';
  try {
    admAppsList = await admApi('/projects');
    if (!admAppsList.length) { el.innerHTML = '<div class="adm-empty">No projects yet</div>'; return; }
    admRenderApps();
  } catch (err) { el.innerHTML = `<div class="adm-empty">Failed to load projects: ${esc(String(err))}</div>`; }
}

function admRenderApps() {
  const el = document.getElementById('adm-apps-content');
  if (!el || !admAppsList) return;

  // Build status counts off the unfiltered list so chips don't shift.
  const counts = { all: admAppsList.length };
  for (const s of ADM_APPS_STATUS_ORDER) counts[s] = 0;
  for (const p of admAppsList) counts[p.status] = (counts[p.status] || 0) + 1;

  const chips = [{ id: 'all', label: 'All' }]
    .concat(ADM_APPS_STATUS_ORDER
      .filter(s => counts[s] > 0)
      .map(s => ({ id: s, label: statusLabel(s) })));

  const chipsHtml = `<div class="adm-tabs" id="adm-apps-status-chips">${
    chips.map(c => {
      const active = c.id === admAppsStatusFilter ? ' active' : '';
      return `<button class="adm-tab${active}" data-status="${c.id}">${esc(c.label)}<span class="adm-tab-count">${counts[c.id] || 0}</span></button>`;
    }).join('')
  }</div>`;

  const sortHtml = `<div class="adm-apps-toolbar">
    <label class="adm-apps-sort-label">Sort by</label>
    <select class="adm-apps-sort" id="adm-apps-sort">${
      Object.entries(ADM_APPS_SORTERS).map(([id, s]) =>
        `<option value="${id}"${id === admAppsSort ? ' selected' : ''}>${esc(s.label)}</option>`
      ).join('')
    }</select>
  </div>`;

  const filtered = admAppsStatusFilter === 'all'
    ? admAppsList.slice()
    : admAppsList.filter(p => p.status === admAppsStatusFilter);
  const sorter = ADM_APPS_SORTERS[admAppsSort] || ADM_APPS_SORTERS.updated_desc;
  filtered.sort(sorter.cmp);

  // Total budget for the currently-filtered slice — useful at a glance.
  const totalBudget = filtered.reduce((s, p) => s + (p.totalCost || 0), 0);
  const summaryHtml = `<div class="adm-apps-summary">
    <span><b>${filtered.length}</b> ${filtered.length === 1 ? 'app' : 'apps'}</span>
    <span class="adm-apps-summary-sep">·</span>
    <span>Total spend <b>${admFmtMoney(totalBudget)}</b></span>
  </div>`;

  let listHtml;
  if (!filtered.length) {
    listHtml = `<div class="adm-empty">No apps with status “${esc(statusLabel(admAppsStatusFilter))}”</div>`;
  } else {
    listHtml = '<div class="tm-table-wrap">';
    for (const p of filtered) {
      const username = p.botUsername ? `@${esc(p.botUsername)}` : '';
      const [c1, c2] = getGradient(p.name);
      const avatarHtml = `<div class="tm-row-pic tm-row-pic-user avatar-gradient" style="background:linear-gradient(135deg,${c1},${c2})">${getInitials(p.name)}</div>`;
      const statusDot = p.status === 'building'
        ? '<span class="loader" style="width:16px;height:16px;margin-right:8px"></span>'
        : `<span class="tm-status-dot ${p.status}"></span>`;
      const cost = Number(p.totalCost || 0);
      const budgetPill = `<span class="adm-apps-budget${cost ? '' : ' zero'}" title="Total spend">${admFmtMoney(cost)}</span>`;
      listHtml += `<a class="tm-row tm-row-link" data-proj-id="${p.id}" style="align-items:center;">` +
        avatarHtml +
        `<div style="flex:1;min-width:0;overflow:hidden;">` +
          `<div class="tm-row-value" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.name)}</div>` +
          `<div class="tm-row-description" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${username || '<span style="opacity:0.5">no bot</span>'}</div>` +
        `</div>` +
        `<div class="tm-row-status" style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">` +
          `<div style="display:flex;align-items:center;">${statusDot}${statusLabel(p.status)}</div>` +
          budgetPill +
        `</div>` +
        `</a>`;
    }
    listHtml += '</div>';
  }

  el.innerHTML = chipsHtml + sortHtml + summaryHtml + listHtml;

  el.querySelectorAll('#adm-apps-status-chips .adm-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      admAppsStatusFilter = btn.dataset.status;
      admRenderApps();
    });
  });

  const sortEl = document.getElementById('adm-apps-sort');
  if (sortEl) {
    sortEl.addEventListener('change', () => {
      admAppsSort = sortEl.value;
      admRenderApps();
    });
  }

  el.querySelectorAll('[data-proj-id]').forEach(row => {
    row.addEventListener('click', () => openAdmProjectChat(row.dataset.projId));
  });
}

async function openAdmVouchers() {
  admLastSubpage = 'adm-vouchers';
  showView('adm-vouchers');
  const el = document.getElementById('adm-vouchers-content');
  el.innerHTML = '<div class="loading-spinner"></div>';
  try {
    const vouchers = await admApi('/vouchers');
    let html = `<div class="adm-section-title">Create Voucher</div>
      <div class="adm-inline-form">
        <input type="number" id="adm-v-credits" placeholder="Credits" step="1" min="1" style="width:110px">
        <input type="number" id="adm-v-max" placeholder="Max uses" value="1" step="1" style="width:80px">
        <button class="adm-btn adm-btn-primary" id="adm-v-create">Create</button>
      </div>
      <div class="adm-section-title">All Vouchers</div>`;

    if (!vouchers.length) {
      html += '<div class="adm-empty">No vouchers yet</div>';
    } else {
      html += '<div class="tm-table-wrap">';
      for (const v of vouchers) {
        html += `<div class="adm-row" style="cursor:default;">
          <div class="adm-row-main">
            <div class="adm-row-title"><span class="adm-voucher-code">${esc(v.code)}</span> · 🪙 ${(v.credits || 0).toLocaleString()}</div>
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
      html += '</div>';
    }
    el.innerHTML = html;

    document.getElementById('adm-v-create')?.addEventListener('click', async () => {
      const credits = document.getElementById('adm-v-credits').value;
      const maxUses = document.getElementById('adm-v-max').value || '1';
      if (!credits || parseInt(credits) <= 0) { showToast('Enter valid credits amount', 'error'); return; }
      try {
        const v = await admApi('/vouchers', { method: 'POST', body: { credits, maxUses } });
        showToast('Voucher created: ' + v.code, 'success');
        openAdmVouchers();
      } catch { showToast('Failed to create', 'error'); }
    });

    el.querySelectorAll('[data-toggle-v]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const newActive = btn.dataset.active === 'true' ? false : true;
        await admApi('/vouchers/' + btn.dataset.toggleV, { method: 'PUT', body: { active: newActive } });
        showToast(newActive ? 'Voucher enabled' : 'Voucher disabled', 'success');
        openAdmVouchers();
      });
    });

    el.querySelectorAll('[data-del-v]').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await admApi('/vouchers/' + btn.dataset.delV, { method: 'DELETE' });
          showToast('Voucher deleted', 'success');
          openAdmVouchers();
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

async function openAdmConfig() {
  admLastSubpage = 'adm-config';
  showView('adm-config');
  const el = document.getElementById('adm-config-content');
  el.innerHTML = '<div class="loading-spinner"></div>';
  try {
    const cfg = await admApi('/config');
    el.innerHTML = `
      <div style="width:100%;">
        <div class="adm-config-row">
          <div><div class="adm-config-label">Markup Multiplier</div><div class="adm-config-desc">Applied on top of base rates (updates)</div></div>
          <input type="number" id="adm-cfg-markup" value="${cfg.markupMultiplier}" step="0.5">
        </div>
        <div class="adm-config-row">
          <div><div class="adm-config-label">Ask Multiplier</div><div class="adm-config-desc">Applied on top of base rates (ask mode)</div></div>
          <input type="number" id="adm-cfg-ask" value="${cfg.askMultiplier || 10}" step="0.5">
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
        askMultiplier: parseFloat(document.getElementById('adm-cfg-ask').value),
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
  document.getElementById('view-partner').classList.toggle('hidden', view !== 'partner');
  document.getElementById('view-referral').classList.toggle('hidden', view !== 'referral');
  document.getElementById('view-help').classList.toggle('hidden', view !== 'help');
  document.getElementById('view-release-notes').classList.toggle('hidden', view !== 'release-notes');
  document.getElementById('view-admin').classList.toggle('hidden', view !== 'admin');
  document.getElementById('view-adm-dashboard').classList.toggle('hidden', view !== 'adm-dashboard');
  document.getElementById('view-adm-sources').classList.toggle('hidden', view !== 'adm-sources');
  document.getElementById('view-adm-source-users').classList.toggle('hidden', view !== 'adm-source-users');
  document.getElementById('view-adm-activities').classList.toggle('hidden', view !== 'adm-activities');
  document.getElementById('view-adm-users').classList.toggle('hidden', view !== 'adm-users');
  document.getElementById('view-adm-apps').classList.toggle('hidden', view !== 'adm-apps');
  document.getElementById('view-adm-vouchers').classList.toggle('hidden', view !== 'adm-vouchers');
  document.getElementById('view-adm-config').classList.toggle('hidden', view !== 'adm-config');
  document.getElementById('view-admin-user').classList.toggle('hidden', view !== 'admin-user');
  document.getElementById('view-versions').classList.toggle('hidden', view !== 'versions');
  document.getElementById('view-version-detail').classList.toggle('hidden', view !== 'version-detail');
  document.getElementById('view-features').classList.toggle('hidden', view !== 'features');
  document.getElementById('view-slots-full').classList.toggle('hidden', view !== 'slots-full');
  document.getElementById('view-topup').classList.toggle('hidden', view !== 'topup');
  document.getElementById('view-language').classList.toggle('hidden', view !== 'language');
  document.getElementById('view-onboarding').classList.toggle('hidden', view !== 'onboarding');
  document.getElementById('view-project-env')?.classList.toggle('hidden', view !== 'project-env');

  const headerDropdown = document.getElementById('chat-header-dropdown');
  if (headerDropdown) headerDropdown.classList.add('hidden');

  const chatEl = document.getElementById('view-chat');
  if (chatEl) chatEl.classList.toggle('hidden', view !== 'chat');

  if (tg) {
    try { tg.setHeaderColor('#000000'); } catch {}
    try { tg.setBackgroundColor('#000000'); } catch {}
    try { if (typeof tg.setBottomBarColor === 'function') tg.setBottomBarColor('#000000'); } catch {}
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
      tg.MainButton.setText(t('edit_update'));
      tg.MainButton.color = tg.themeParams?.button_color || '#3390ec';
      tg.MainButton.textColor = tg.themeParams?.button_text_color || '#ffffff';
      tg.MainButton.show();
    } else if (view === 'transfer') {
      tg.MainButton.setText(t('transfer_btn'));
      tg.MainButton.color = tg.themeParams?.button_color || '#3390ec';
      tg.MainButton.textColor = tg.themeParams?.button_text_color || '#ffffff';
      tg.MainButton.show();
    } else if (view === 'delete') {
      tg.MainButton.setText(t('delete_btn'));
      tg.MainButton.color = '#e53935';
      tg.MainButton.textColor = '#ffffff';
      tg.MainButton.show();
    } else if (view === 'slots-full') {
      tg.MainButton.setText(t('slots_full_title') + ' — $5');
      tg.MainButton.color = tg.themeParams?.button_color || '#3390ec';
      tg.MainButton.textColor = tg.themeParams?.button_text_color || '#ffffff';
      tg.MainButton.show();
    } else if (view === 'topup') {
      tg.MainButton.hide();
    } else {
      tg.MainButton.hide();
    }
  }
}

// ── Init ──

async function loadProjects(retry = 0) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(`${API_BASE}/projects`, { headers: apiHeaders(), signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    projects = data.projects || data;
    slots = data.slots || { used: projects.length, total: 5 };
    renderAppList();
    loadTopupBalance();
    loadSamples();
  } catch (err) {
    console.error('Failed to load projects:', err);
    if (retry < 2) {
      setTimeout(() => loadProjects(retry + 1), 1500);
      return;
    }
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
      html += `<a class="tm-row tm-row-link sample-row" data-id="${s.id}" data-name="${esc(s.name)}" data-bot="${esc(s.botUsername || '')}">
        ${avatar}
        <div class="tm-row-text">
          <div class="tm-row-value">${esc(s.name)}</div>
          <div class="tm-row-description">@${esc(s.botUsername)}</div>
        </div>
      </a>`;
    }
    list.innerHTML = html;
    list.querySelectorAll('.sample-row').forEach(row => {
      row.addEventListener('click', () => openSampleBot(row.dataset.bot, row.dataset.name));
    });
    samplesLoaded = true;
  } catch (err) {
    console.error('Failed to load samples:', err);
  }
}

// Opens a sample by deep-linking the user into the sample's bot itself
// (real chat → real Mini App), instead of embedding our /app/<id> route
// in an iframe inside this Mini App. The latter caused two problems:
//   1. nested Mini App rendering in some clients (white screen / loops),
//   2. broken auth — initData of *this* app is not valid for the sample.
// `tg.openLink` with `try_instant_view: true` lets Telegram render the
// link inline if it can, otherwise it falls through to the regular
// in-client browser. For t.me/<bot> links Telegram resolves them as
// bot deep-links automatically.
function openSampleBot(botUsername, _name) {
  if (!botUsername) return;
  const link = `https://t.me/${botUsername}`;
  try {
    tg.openTelegramLink(link, { try_instant_view: true });
  } catch (_) {}
  // Fallback for environments where Telegram WebApp isn't available
  // (desktop dev preview, accidental browser open).
  // window.open(link, '_blank');
}

function getChatPlaceholder(mode) {
  return t('chat_placeholder');
}

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
      input.placeholder = getChatPlaceholder(mode);
      input.focus();
    }
  }
}

async function fetchSuggestions() {
  if (!chatProjectId) return;

  const btn = document.getElementById('btn-get-suggestions');
  btn.disabled = true;
  btn.textContent = '...';
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
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId: userTierId }),
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
  btn.textContent = t('chat_get_suggestions');
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

// Map UI language code -> ElevenLabs ISO 639-3 hint. Returning '' lets the
// model auto-detect, which is the right default for users who switch languages
// mid-session or whose UI language doesn't match what they're saying.
const SPEECH_LANG_MAP = { en: 'eng', ru: 'rus', ua: 'ukr', uk: 'ukr' };

// Voice input: hold-to-talk style is overkill on Telegram WebView (touch+keyboard
// races, sleep timers, MainButton conflicts), so we use a simple toggle:
// click once to start, click again (or click anywhere outside) to stop & send.
let voiceRecorderState = 'idle'; // 'idle' | 'recording' | 'uploading'
let voiceMediaRecorder = null;
let voiceChunks = [];
let voiceStream = null;

function setMicState(state) {
  voiceRecorderState = state;
  const btn = document.getElementById('btn-mic');
  if (!btn) return;
  btn.classList.toggle('recording', state === 'recording');
  btn.classList.toggle('uploading', state === 'uploading');
  btn.disabled = state === 'uploading';
  const labelKey = state === 'recording'
    ? 'chat_mic_stop'
    : state === 'uploading'
      ? 'chat_mic_uploading'
      : 'chat_mic_title';
  const label = t(labelKey) || (state === 'recording' ? 'Tap to stop' : state === 'uploading' ? 'Transcribing...' : 'Voice input');
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

function pickVoiceMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
    'audio/mpeg',
  ];
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  for (const mt of candidates) {
    if (MediaRecorder.isTypeSupported(mt)) return mt;
  }
  return '';
}

async function startVoiceRecording() {
  if (voiceRecorderState !== 'idle') return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    showToast(t('chat_mic_unsupported') || 'Voice input not supported on this device', 'error');
    return;
  }
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    showToast(
      denied
        ? (t('chat_mic_denied') || 'Microphone access denied')
        : (t('chat_mic_failed') || 'Could not start microphone'),
      'error',
    );
    return;
  }

  const mimeType = pickVoiceMimeType();
  try {
    voiceMediaRecorder = mimeType
      ? new MediaRecorder(voiceStream, { mimeType })
      : new MediaRecorder(voiceStream);
  } catch (err) {
    voiceStream.getTracks().forEach(t => t.stop());
    voiceStream = null;
    showToast(t('chat_mic_failed') || 'Could not start microphone', 'error');
    return;
  }

  voiceChunks = [];
  voiceMediaRecorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size > 0) voiceChunks.push(e.data);
  });
  voiceMediaRecorder.addEventListener('stop', () => {
    const tracks = voiceStream ? voiceStream.getTracks() : [];
    tracks.forEach(t => t.stop());
    voiceStream = null;
    const blob = new Blob(voiceChunks, { type: mimeType || 'audio/webm' });
    voiceChunks = [];
    void uploadVoiceForTranscription(blob);
  });

  voiceMediaRecorder.start();
  setMicState('recording');
  try { tg?.HapticFeedback?.impactOccurred?.('light'); } catch {}
}

function stopVoiceRecording() {
  if (voiceRecorderState !== 'recording') return;
  setMicState('uploading');
  try {
    voiceMediaRecorder?.stop();
  } catch {
    setMicState('idle');
  }
  try { tg?.HapticFeedback?.impactOccurred?.('light'); } catch {}
}

async function uploadVoiceForTranscription(blob) {
  if (!blob || blob.size === 0) {
    setMicState('idle');
    showToast(t('chat_mic_empty') || 'No audio captured', 'error');
    return;
  }
  // Cap at 10 MB (server multer limit) — at ~64 kbps opus that's ~20 minutes,
  // far longer than any sane chat input. We never expect to hit this.
  if (blob.size > 10 * 1024 * 1024) {
    setMicState('idle');
    showToast(t('chat_mic_too_long') || 'Recording too long', 'error');
    return;
  }
  try {
    const ext = (blob.type.includes('mp4') ? 'm4a'
      : blob.type.includes('mpeg') ? 'mp3'
      : blob.type.includes('ogg') ? 'ogg'
      : 'webm');
    const fd = new FormData();
    fd.append('audio', blob, `voice-${Date.now()}.${ext}`);
    const langHint = SPEECH_LANG_MAP[currentLang] || '';
    if (langHint) fd.append('languageCode', langHint);

    const res = await fetch(`${API_BASE}/transcribe`, {
      method: 'POST',
      headers: apiHeaders(),
      body: fd,
    });
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    const text = (data && typeof data.text === 'string') ? data.text.trim() : '';

    const input = document.getElementById('chat-input');
    if (input && text) {
      // Append (with a space) instead of overwriting so users can dictate on
      // top of an in-progress message.
      const existing = input.value.trim();
      input.value = existing ? `${existing} ${text}` : text;
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 120) + 'px';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      try { tg?.HapticFeedback?.notificationOccurred?.('success'); } catch {}
    } else if (!text) {
      showToast(t('chat_mic_empty') || 'No speech detected', 'error');
    }
  } catch (err) {
    console.error('[Voice] transcription failed:', err);
    showToast(t('chat_mic_failed') || 'Transcription failed', 'error');
  } finally {
    setMicState('idle');
  }
}

function initVoiceRecorder() {
  const btn = document.getElementById('btn-mic');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (voiceRecorderState === 'recording') stopVoiceRecording();
    else if (voiceRecorderState === 'idle') void startVoiceRecording();
  });
  setMicState('idle');
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
    if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
      e.preventDefault();
      if (input.value.trim()) sendMessage();
    }
  });

  sendBtn.addEventListener('click', () => {
    if (sendBtn.classList.contains('active')) sendMessage();
  });

  document.getElementById('btn-attach').addEventListener('click', () => fileInput.click());

  initVoiceRecorder();

  input.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles = [];
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          const ext = file.type.split('/')[1] || 'png';
          const named = new File([file], `pasted-image-${Date.now()}.${ext}`, { type: file.type });
          imageFiles.push(named);
        }
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      pendingFiles.push(...imageFiles);
      updateAttachPreview();
      uploadFiles(imageFiles);
    }
  });

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

function openLanguage() {
  document.querySelectorAll('.lang-option').forEach(row => {
    const check = row.querySelector('.lang-check');
    if (check) check.classList.toggle('hidden', row.dataset.lang !== currentLang);
    // Use onclick assignment to avoid accumulating listeners on repeated opens
    row.onclick = () => {
      setLang(row.dataset.lang);
      document.querySelectorAll('.lang-option .lang-check').forEach(c => c.classList.add('hidden'));
      row.querySelector('.lang-check')?.classList.remove('hidden');
      showToast(t('toast_saved'), 'success');
    };
  });
  showView('language');
}

// ─── Onboarding flow ──────────────────────────────────────────
// 4-screen welcome carousel. Wired up only when the user explicitly
// opens it (currently from Admin → "Onboarding (test)"). Once the
// product owner is happy with it, a single line in init() can flip
// it on for first-run users (see `af_onboarding_seen` flag).

let onbCurrent = 1;
let onbWired = false;
// Active onboarding slide IDs in the order they appear. Slide 2 is currently
// disabled (commented out in index.html), so we skip from 1 → 3 → 4. The
// indices into this array map 1:1 to the visible nav dots.
const ONB_SLIDES = [1, 3, 4];
const ONB_LAST = ONB_SLIDES[ONB_SLIDES.length - 1];

function onbGo(n) {
  if (n === onbCurrent) return;
  const prev = document.getElementById('onb-s' + onbCurrent);
  const next = document.getElementById('onb-s' + n);
  if (!prev || !next) return;

  prev.style.opacity = '0';
  prev.style.transform = 'translateX(-30px)';
  prev.style.pointerEvents = 'none';

  setTimeout(() => {
    prev.classList.remove('active');
    prev.style.transform = '';
    onbCurrent = n;
    next.style.opacity = '0';
    next.style.transform = 'translateX(30px)';
    next.classList.add('active');
    requestAnimationFrame(() => {
      next.style.opacity = '1';
      next.style.transform = 'translateX(0)';
      next.style.pointerEvents = 'all';
    });
    const activeDotIdx = ONB_SLIDES.indexOf(onbCurrent);
    document.querySelectorAll('#view-onboarding .onb-dot').forEach((d, i) => {
      d.classList.toggle('active', i === activeDotIdx);
    });
    const skip = document.getElementById('onb-skip');
    if (skip) skip.style.visibility = onbCurrent === ONB_LAST ? 'hidden' : 'visible';
  }, 300);
}

function onbReset() {
  onbCurrent = 1;
  document.querySelectorAll('#view-onboarding .onb-screen').forEach((el, i) => {
    el.classList.toggle('active', i === 0);
    el.style.opacity = '';
    el.style.transform = '';
    el.style.pointerEvents = '';
  });
  document.querySelectorAll('#view-onboarding .onb-dot').forEach((d, i) => {
    d.classList.toggle('active', i === 0);
  });
  const skip = document.getElementById('onb-skip');
  if (skip) skip.style.visibility = 'visible';
}

function onbFinish() {
  try { localStorage.setItem('af_onboarding_seen', '1'); } catch (_) {}
  showView('list');
  // The 5-second timer for the follow-channel modal starts only AFTER
  // the user lands on the main menu — we never want to interrupt the
  // onboarding flow with another modal on top.
  scheduleSubModalCheck();
}

// ─── Follow-channel bonus modal ───────────────────────────────
// 5 seconds after the user lands on the main menu (post-onboarding,
// or immediately on cold-start if onboarding was already seen) we ask
// the backend whether they're subscribed to @apps_father AND still
// eligible for the one-time $0.10 bonus. If both → show modal. The
// modal will fire at most once per session (sessionStorage flag) and
// is fully easy-close: X / "Maybe later" / backdrop / ESC.

const SUB_MODAL_DELAY_MS = 5_000;
const SUB_MODAL_SESSION_KEY = 'af_sub_modal_shown_session';
let subModalScheduled = false;
let subModalWired = false;

function openSubModal(channelLink, bonusUsd) {
  const overlay = document.getElementById('sub-modal');
  if (!overlay) return;

  if (typeof bonusUsd === 'number' && !isNaN(bonusUsd)) {
    const valEl = document.getElementById('sub-modal-bonus');
    if (valEl) valEl.textContent = '$' + bonusUsd.toFixed(2);
  }

  if (!subModalWired) {
    subModalWired = true;
    document.getElementById('sub-modal-close')?.addEventListener('click', closeSubModal);
    document.getElementById('sub-modal-skip')?.addEventListener('click', closeSubModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSubModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeSubModal();
    });

    document.getElementById('sub-modal-subscribe')?.addEventListener('click', () => {
      const link = overlay.dataset.channelLink || 'https://t.me/apps_father';
      try {
        if (tg && typeof tg.openTelegramLink === 'function') {
          tg.openTelegramLink(link);
        } else {
          window.open(link, '_blank');
        }
      } catch (_) {
        window.open(link, '_blank');
      }
    });

    document.getElementById('sub-modal-check')?.addEventListener('click', claimSubBonus);

    // Swipe-down to dismiss on the drag handle
    const sheet = overlay.querySelector('.sub-modal');
    const handle = document.getElementById('sub-modal-handle');
    if (sheet && handle) {
      let startY = 0, dy = 0, dragging = false;
      const onStart = (e) => {
        dragging = true;
        startY = (e.touches ? e.touches[0].clientY : e.clientY);
        dy = 0;
        sheet.style.transition = 'none';
      };
      const onMove = (e) => {
        if (!dragging) return;
        const y = (e.touches ? e.touches[0].clientY : e.clientY);
        dy = Math.max(0, y - startY);
        sheet.style.transform = `translateY(${dy}px)`;
      };
      const onEnd = () => {
        if (!dragging) return;
        dragging = false;
        sheet.style.transition = '';
        if (dy > 80) {
          closeSubModal();
        } else {
          sheet.style.transform = '';
        }
      };
      handle.addEventListener('touchstart', onStart, { passive: true });
      handle.addEventListener('touchmove', onMove, { passive: true });
      handle.addEventListener('touchend', onEnd);
      handle.addEventListener('mousedown', onStart);
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onEnd);
    }
  }

  overlay.dataset.channelLink = channelLink || 'https://t.me/apps_father';
  overlay.classList.remove('hidden');
  overlay.setAttribute('aria-hidden', 'false');
  try { sessionStorage.setItem(SUB_MODAL_SESSION_KEY, '1'); } catch (_) {}
}

function closeSubModal() {
  const overlay = document.getElementById('sub-modal');
  if (!overlay || overlay.classList.contains('hidden')) return;
  overlay.classList.add('closing');
  const finish = () => {
    overlay.classList.remove('closing');
    overlay.classList.add('hidden');
    overlay.setAttribute('aria-hidden', 'true');
    const sheet = overlay.querySelector('.sub-modal');
    if (sheet) sheet.style.transform = '';
  };
  setTimeout(finish, 240);
}

async function claimSubBonus() {
  const checkBtn = document.getElementById('sub-modal-check');
  const subBtn = document.getElementById('sub-modal-subscribe');
  if (checkBtn) checkBtn.disabled = true;
  if (subBtn) subBtn.disabled = true;
  try {
    const res = await fetch(`${API_BASE}/sub-claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...apiHeaders() },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.subscribed) {
      showToast(t('sub_modal_toast_not_yet'), 'error');
      return;
    }
    if (data.claimed) {
      try { localStorage.setItem('af_sub_claimed', '1'); } catch (_) {}
      showToast(t('sub_modal_toast_claimed'), 'success');
      try { loadBalance(); } catch (_) {}
      closeSubModal();
      return;
    }
    if (data.alreadyClaimed) {
      try { localStorage.setItem('af_sub_claimed', '1'); } catch (_) {}
      showToast(t('sub_modal_toast_already'), 'info');
      closeSubModal();
      return;
    }
    showToast(t('sub_modal_toast_error'), 'error');
  } catch (err) {
    console.warn('[SubBonus] claim failed:', err);
    showToast(t('sub_modal_toast_error'), 'error');
  } finally {
    if (checkBtn) checkBtn.disabled = false;
    if (subBtn) subBtn.disabled = false;
  }
}

async function checkAndShowSubModal() {
  // Fast paths — avoid every unnecessary API hit:
  //   - already shown this session
  //   - bonus already claimed on this device (cached locally)
  try {
    if (sessionStorage.getItem(SUB_MODAL_SESSION_KEY)) return;
  } catch (_) {}
  try {
    if (localStorage.getItem('af_sub_claimed') === '1') return;
  } catch (_) {}

  try {
    const res = await fetch(`${API_BASE}/sub-status`, { headers: apiHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.eligible) {
      try { localStorage.setItem('af_sub_claimed', '1'); } catch (_) {}
      return;
    }
    if (data.subscribed) return; // Already a member — don't pester.
    openSubModal(data.channelLink, data.bonusUsd);
  } catch (err) {
    console.warn('[SubBonus] status check failed:', err);
  }
}

function scheduleSubModalCheck() {
  if (subModalScheduled) return;
  subModalScheduled = true;
  setTimeout(checkAndShowSubModal, SUB_MODAL_DELAY_MS);
}

function openOnboarding() {
  onbReset();
  if (!onbWired) {
    onbWired = true;
    document.querySelectorAll('#view-onboarding [data-onb-go]').forEach(btn => {
      btn.addEventListener('click', () => {
        const n = parseInt(btn.dataset.onbGo, 10);
        if (!isNaN(n)) onbGo(n);
      });
    });
    document.getElementById('onb-skip')?.addEventListener('click', () => onbGo(4));
    document.getElementById('onb-finish')?.addEventListener('click', onbFinish);
  }
  showView('onboarding');
}

async function init() {
  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, a, .tm-row, .chat-pill, .chat-plan-btn, .result-action-btn, .question-opt-btn, .feature-row, .quality-row');
    if (t) haptic('light');
  }, true);

  if (tg) {
    // Each call must be guarded individually: older iOS/Android Telegram
    // clients are missing newer methods (setBottomBarColor: 7.10+,
    // disableVerticalSwipes: 7.7+, requestFullscreen: 8.0+). A single
    // TypeError here would abort init() and leave the page looking
    // unstyled / unresponsive ("broken styles + broken script").
    const safe = (fn) => { try { fn(); } catch (e) { console.warn('[tg]', e?.message || e); } };

    safe(() => tg.ready());
    safe(() => tg.setHeaderColor('#000000'));
    safe(() => tg.setBackgroundColor('#000000'));
    if (typeof tg.setBottomBarColor === 'function') safe(() => tg.setBottomBarColor('#000000'));
    safe(() => tg.MainButton?.setParams({ color: '#248BDA' }));
    if (typeof tg.disableVerticalSwipes === 'function') safe(() => tg.disableVerticalSwipes());

    if (['android', 'ios'].includes(tg.platform)) {
      document.body.classList.add('mobile', 'platform-' + tg.platform);
      if (typeof tg.requestFullscreen === 'function') safe(() => tg.requestFullscreen());
    }
  }

  if (tg?.BackButton) {
    tg.BackButton.onClick(() => {
      if (document.getElementById('agent-log-overlay')) {
        closeAgentLogViewer();
        return;
      }
      if (document.getElementById('test-preview-overlay')) {
        closeTestPreview();
        return;
      }
      // Preferences modal: BackButton always cancels — drops the optimistic
      // user bubble and reverts the chat to the pre-prompt plan-ready state,
      // regardless of which step we're on. (The in-modal arrow handles
      // step-by-step back navigation.)
      if (prefModalState) {
        cancelPreferencesModal();
        return;
      }
      if (currentView === 'version-detail') {
        openVersions(currentProject.id);
      } else if (currentView === 'versions') {
        showView('detail');
      } else if (currentView === 'features') {
        showView('detail');
      } else if (currentView === 'edit-info') {
        showView('detail');
      } else if (currentView === 'project-env') {
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
      } else if (currentView === 'partner') {
        showView('list');
      } else if (currentView === 'referral') {
        showView('list');
      } else if (currentView === 'help') {
        showView('list');
      } else if (currentView === 'release-notes') {
        showView('list');
      } else if (currentView === 'language') {
        showView('list');
      } else if (currentView === 'onboarding') {
        // Treat Back the same as the final "Begin" button so people
        // who hit it early aren't dumped onto a half-shown carousel.
        onbFinish();
      } else if (currentView === 'admin-user') {
        // Detail returns to whichever list we came from (Sources drill-down
        // or the top-level Users page) so Back doesn't yank the admin out
        // of the funnel they were inspecting.
        if (admSourceUsersCtx) {
          openAdmSourceUsers(admSourceUsersCtx.kind, admSourceUsersCtx.key, admSourceUsersCtx.title);
        } else {
          openAdmUsers();
        }
      } else if (currentView === 'adm-source-users') {
        admSourceUsersCtx = null;
        openAdmSources();
      } else if (currentView === 'adm-dashboard' || currentView === 'adm-sources' || currentView === 'adm-activities' || currentView === 'adm-users' || currentView === 'adm-apps' || currentView === 'adm-vouchers' || currentView === 'adm-config') {
        openAdmin();
      } else if (currentView === 'admin') {
        showView('list');
      } else if (currentView === 'detail') {
        showView('chat');
      } else if (currentView === 'chat') {
        wsGeneration++;
        if (chatWs) { try { chatWs.onclose = null; chatWs.close(); } catch {} chatWs = null; }
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
  document.getElementById('btn-language-page')?.addEventListener('click', () => openLanguage());
  document.getElementById('btn-support')?.addEventListener('click', () => {
    if (tg?.openLink) tg.openLink('https://t.me/AppsFather_support');
    else window.open('https://t.me/AppsFather_support', '_blank');
  });
  document.getElementById('btn-admin')?.addEventListener('click', () => openAdmin());
  document.getElementById('btn-partner')?.addEventListener('click', () => openPartner());

  // Auto-pick the language on first launch from Telegram's locale.
  // We only do this when the user has never explicitly chosen one
  // (i.e. nothing in `af_lang`). After that, their choice always wins.
  // setLang() persists to localStorage AND POSTs to the backend so
  // server-side language-aware features (notifications, etc.) match.
  try {
    if (!localStorage.getItem('af_lang') && typeof detectTelegramLang === 'function') {
      const detected = detectTelegramLang();
      // setLang persists to localStorage AND POSTs to the backend so
      // server-side language-aware features (notifications, etc.) match.
      // Even when detected === currentLang ('en' default), we call it
      // once so we don't re-detect on every cold start.
      if (detected) setLang(detected);
    }
  } catch (_) {}
  applyLang();

  // First-run onboarding. The 4-screen carousel is shown exactly once
  // per device — the "Begin" button (and Back / Skip → Begin) sets
  // `af_onboarding_seen` in localStorage via onbFinish(), so subsequent
  // launches skip straight to the app. Admin → "Onboarding (preview)"
  // can always re-trigger it for testing without resetting the flag.
  // It's a fixed-position fullscreen overlay (z-index 999), so the
  // background reportInit/checkAdmin/loadBalance calls keep running
  // underneath while the user reads the slides.
  try {
    if (!localStorage.getItem('af_onboarding_seen')) {
      openOnboarding();
    } else {
      // Returning user: skip onboarding, but kick off the 5-second
      // follow-channel modal check exactly the same way onbFinish()
      // would — once per session, only if not subscribed and still
      // eligible for the one-time bonus.
      scheduleSubModalCheck();
    }
  } catch (_) {}

  initTokenActions();
  initChatInput();
  initAutosize();
  initEditPhoto();
  initTopupEvents();
  initAnalytics();
  // CRITICAL: /api/init MUST complete BEFORE any other API call that lands
  // on getOrCreateUser. The backend uses the very first request to lock in
  // the new user's start_param attribution (referrer / partner-tag /
  // utm_source) and to send the admin "new user" notification exactly
  // once. Calls like /api/admin/check, /api/partner, /api/balance,
  // /api/projects all hit getOrCreateUser too — if any of them lands
  // first, the source data is lost.
  const initData = await reportInit();
  if (initData?.serviceMode && !initData?.isAdmin) {
    showServicePage();
    return;
  }
  checkAdmin();
  checkPartner();
  loadBalance();
  await loadProjects();
  maybeHandleReservedStartParam();
}

// When the user lands here from the user-bot's "Open Apps Father" button,
// start_param is `open_dialog`. We jump straight into the chat for their most
// recent project so they can finish the build, then clear the sentinel from
// storage so subsequent opens don't keep re-triggering the auto-navigation.
function maybeHandleReservedStartParam() {
  const sp = getStartParam();
  if (sp !== 'open_dialog') return;
  try { localStorage.removeItem('af_start_param'); } catch (_) {}
  try { sessionStorage.removeItem('af_start_param'); } catch (_) {}
  if (!Array.isArray(projects) || projects.length === 0) return;
  const sorted = projects.slice().sort((a, b) => {
    const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return tb - ta;
  });
  const target = sorted[0];
  if (target?.id) openChat(target.id);
}

// ── Tier Selector Modal ──────────────────────────────────────────────────────

function openTierModal() {
  const modal = document.getElementById('tier-modal');
  if (!modal) return;
  renderTierCards();
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  try { tg.setHeaderColor(PREF_MODAL_CHROME); } catch {}
  try { tg.setBackgroundColor(PREF_MODAL_CHROME); } catch {}
  try { if (typeof tg.setBottomBarColor === 'function') tg.setBottomBarColor(PREF_MODAL_CHROME); } catch {}
}

function closeTierModal() {
  const modal = document.getElementById('tier-modal');
  if (!modal) return;
  modal.style.animation = 'tierFadeIn 0.18s ease reverse forwards';
  setTimeout(() => {
    modal.style.animation = '';
    modal.classList.add('hidden');
    modal.setAttribute('aria-hidden', 'true');
  }, 170);
  try { tg.setHeaderColor(DEFAULT_CHROME); } catch {}
  try { tg.setBackgroundColor(DEFAULT_CHROME); } catch {}
  try { if (typeof tg.setBottomBarColor === 'function') tg.setBottomBarColor(DEFAULT_CHROME); } catch {}
}

function renderSegBar(value) {
  const filled = Math.round(Math.min(10, Math.max(0, value)));
  let html = '';
  for (let i = 0; i < 10; i++) {
    html += `<span class="tier-seg${i < filled ? ' tier-seg--on' : ''}"></span>`;
  }
  return `<div class="tier-seg-bar">${html}</div>`;
}

const PRICE_META = {
  create:  { label: 'Create app',   hint: 'Full project generation' },
  update:  { label: 'Update app',   hint: 'Apply changes to existing app' },
  plan:    { label: 'Plan',         hint: 'Planning & architecture step' },
  ask:     { label: 'Ask',          hint: 'Quick question or advice' },
};

function priceRow(key, val) {
  const meta = PRICE_META[key] || { label: key, hint: '' };
  const n = (val === '—' || val == null) ? '—' : Number(val).toLocaleString();
  const valHtml = n === '—'
    ? `<span class="tier-price-val">—</span>`
    : `<span class="tier-price-val">${coinSvg(13, 9, '#fbbf24')}${n}</span>`;
  return `<div class="tier-price-row">
    <div class="tier-price-info">
      <span class="tier-price-label">${meta.label}</span>
      ${meta.hint ? `<span class="tier-price-hint">${meta.hint}</span>` : ''}
    </div>
    ${valHtml}
  </div>`;
}

function renderTierCards() {
  const container = document.getElementById('tier-modal-cards');
  if (!container) return;
  const tiers = allTiers.length ? allTiers : getDefaultTiers();
  container.innerHTML = tiers.map((tier, idx) => {
    const isActive = tier.id === userTierId;
    const speed   = tier.stats?.speed   ?? 5;
    const quality = tier.stats?.quality ?? 5;
    const price   = tier.stats?.price   ?? 5;
    const createP = tier.pricing?.create ?? '—';
    const updateP = tier.pricing?.update ?? '—';
    const askP    = tier.pricing?.ask    ?? '—';
    const planP   = tier.pricing?.plan   ?? '—';

    // Localized name and description
    const tierName = (tier.nameI18n?.[currentLang] || tier.nameI18n?.en || tier.name || tier.id);
    const tierDesc = (tier.descriptionI18n?.[currentLang] || tier.descriptionI18n?.en || '');

    // Accent color per tier
    const accents = ['#38bdf8','#818cf8','#f472b6','#fb923c','#4ade80'];
    const accent = accents[idx % accents.length];

    return `
      <div class="tier-card ${isActive ? 'tier-card--active' : ''}" data-tier-id="${esc(tier.id)}" style="--tier-accent:${accent};animation-delay:${idx * 55}ms">
        <div class="tier-card-top">
          <div>
            <div class="tier-card-name">${esc(tierName)}</div>
            ${tierDesc ? `<div class="tier-card-desc">${esc(tierDesc)}</div>` : ''}
          </div>
          ${isActive ? '<span class="tier-card-badge">✓ Active</span>' : ''}
        </div>
        <div class="tier-stats">
          <div class="tier-stat-row">
            <span class="tier-stat-label">Quality</span>
            ${renderSegBar(quality)}
            <span class="tier-stat-val">${quality}</span>
          </div>
          <div class="tier-stat-row">
            <span class="tier-stat-label">Speed</span>
            ${renderSegBar(speed)}
            <span class="tier-stat-val">${speed}</span>
          </div>
          <div class="tier-stat-row">
            <span class="tier-stat-label">Cost</span>
            ${renderSegBar(price)}
            <span class="tier-stat-val">${price}</span>
          </div>
        </div>
        <div class="tier-pricing">
          ${priceRow('create', createP)}
          ${priceRow('update', updateP)}
          ${priceRow('plan',   planP)}
          ${priceRow('ask',    askP)}
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.tier-card').forEach(card => {
    card.addEventListener('click', () => selectTier(card.dataset.tierId));
  });

  // Tint header to match the active tier's accent
  applyTierHeaderAccent();
}

function applyTierHeaderAccent() {
  const tiers = allTiers.length ? allTiers : getDefaultTiers();
  const accents = ['#38bdf8','#818cf8','#f472b6','#fb923c','#4ade80'];
  const activeIdx = tiers.findIndex(t => t.id === userTierId);
  const accent = activeIdx >= 0 ? accents[activeIdx % accents.length] : '#818cf8';

  const sheet = document.querySelector('.tier-modal-sheet');
  if (sheet) sheet.style.setProperty('--tier-header-accent', accent);

  const title = document.getElementById('tier-modal-title');
  if (title) title.style.color = accent;
}

function renderStatDots(value) {
  const filled = Math.round(Math.min(10, Math.max(0, value)));
  let html = '';
  for (let i = 0; i < 10; i++) {
    html += `<span class="tier-dot ${i < filled ? 'tier-dot--on' : ''}"></span>`;
  }
  return html;
}

function getDefaultTiers() {
  return [
    { id: 'tier_0', name: 'Tier 0 · Fast', stats: { speed: 9, quality: 3, price: 1 }, pricing: { create: 200, update: 75, ask: 15 } },
    { id: 'tier_1', name: 'Tier 1 · Balanced', stats: { speed: 6, quality: 6, price: 4 }, pricing: { create: 300, update: 100, ask: 20 } },
    { id: 'tier_2', name: 'Tier 2 · Best', stats: { speed: 3, quality: 9, price: 8 }, pricing: { create: 500, update: 200, ask: 40 } },
  ];
}

async function selectTier(tierId) {
  if (!tierId) return;
  try {
    const res = await fetch(`${API_BASE}/user/performance-tier`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ tierId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    userTierId = tierId;
    const tiers = allTiers.length ? allTiers : getDefaultTiers();
    userTierData = tiers.find(t => t.id === tierId) || null;
    // Save per-project override so switching chats restores the right tier
    if (chatProjectId) projectTierMap[chatProjectId] = tierId;
    closeTierModal();
    renderTierChip();
    updatePillPrices();
    showToast('Performance tier updated', 'success');
  } catch (err) {
    console.error('Failed to set tier:', err);
    showToast('Failed to update tier', 'error');
  }
}

function updatePillPrices() {
  const pricing = userTierData?.pricing || {};
  const map = { update: pricing.update, question: pricing.ask, suggestion: pricing.suggestions };
  document.querySelectorAll('.chat-pill').forEach(pill => {
    const mode = pill.dataset.mode;
    const price = map[mode];
    let tag = pill.querySelector('.pill-price-tag');
    if (price == null) { tag?.remove(); return; }
    if (!tag) {
      tag = document.createElement('span');
      tag.className = 'pill-price-tag';
      pill.appendChild(tag);
    }
    tag.innerHTML = coinSvg(10, 7, '#fbbf24') + Number(price).toLocaleString();
  });
}

const TIER_COLORS = [
  [74,  222, 128],  // 0 — green
  [233, 178,   0],  // 1 — yellow
  [233,   0,  80],  // 2 — red
];

function getTierColor(safeIdx, total) {
  const stops = TIER_COLORS;
  if (stops.length === 1 || total <= 1) return stops[0];
  const t = safeIdx / (total - 1);
  const scaled = t * (stops.length - 1);
  const lo = Math.floor(scaled);
  const hi = Math.min(lo + 1, stops.length - 1);
  const frac = scaled - lo;
  return stops[lo].map((c, i) => Math.round(c + (stops[hi][i] - c) * frac));
}

function renderTierChip() {
  const chip = document.getElementById('tier-chip');
  if (!chip) return;
  const tiers = allTiers.length ? allTiers : getDefaultTiers();
  const idx = tiers.findIndex(t => t.id === userTierId);
  const total = tiers.length || 1;
  const safeIdx = idx < 0 ? 0 : idx;

  const [r, g, b] = getTierColor(safeIdx, total);
  const color = `rgb(${r},${g},${b})`;

  chip.style.borderColor = `rgba(${r},${g},${b},0.55)`;
  chip.style.backgroundColor = `color-mix(in srgb, #000000 30%, rgba(${r},${g},${b},0.4))`;

  const speedo = document.getElementById('tier-chip-speedo');
  if (speedo) speedo.style.fill = color;
}

document.addEventListener('DOMContentLoaded', () => {
  const tierChip = document.getElementById('tier-chip');
  if (tierChip) tierChip.addEventListener('click', openTierModal);
  const closeBtn = document.getElementById('tier-modal-close');
  if (closeBtn) closeBtn.addEventListener('click', closeTierModal);
  const backdrop = document.getElementById('tier-modal-backdrop');
  if (backdrop) backdrop.addEventListener('click', closeTierModal);
});

// ── Project Env Variables ─────────────────────────────────────────────────────

let envProjectId = null;
let envCurrentType = 'dev'; // 'dev' | 'release'
let envVarsData = {}; // { KEY: VALUE }

async function openProjectEnv(projectId) {
  envProjectId = projectId;
  envCurrentType = 'dev';
  document.getElementById('btn-env-dev')?.classList.add('active');
  document.getElementById('btn-env-release')?.classList.remove('active');
  showView('project-env');
  await loadEnvVars();
}

async function loadEnvVars() {
  if (!envProjectId) return;
  try {
    const res = await fetch(`${API_BASE}/project-env/${envProjectId}?env=${envCurrentType}`, { headers: apiHeaders() });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    envVarsData = data.vars || {};
    renderEnvRows();
  } catch (err) {
    console.error('Failed to load env vars:', err);
    showToast('Failed to load variables', 'error');
  }
}

function renderEnvRows() {
  const container = document.getElementById('env-rows');
  if (!container) return;
  const entries = Object.entries(envVarsData);
  if (entries.length === 0) {
    container.innerHTML = '<div class="env-empty">No variables yet. Add one below.</div>';
    return;
  }
  container.innerHTML = entries.map(([key, val], idx) => `
    <div class="env-row" data-idx="${idx}">
      <input class="env-key-input" type="text" value="${esc(key)}" placeholder="KEY" data-idx="${idx}" />
      <input class="env-val-input" type="text" value="${esc(val)}" placeholder="VALUE" data-idx="${idx}" />
      <button class="env-del-btn" data-idx="${idx}" title="Remove">✕</button>
    </div>
  `).join('');

  container.querySelectorAll('.env-del-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const keys = Object.keys(envVarsData);
      const k = keys[parseInt(btn.dataset.idx, 10)];
      if (k !== undefined) delete envVarsData[k];
      renderEnvRows();
    });
  });
}

function collectEnvVars() {
  const rows = document.querySelectorAll('#env-rows .env-row');
  const vars = {};
  rows.forEach(row => {
    const key = row.querySelector('.env-key-input')?.value?.trim();
    const val = row.querySelector('.env-val-input')?.value ?? '';
    if (key) vars[key] = val;
  });
  return vars;
}

async function saveEnvVars() {
  if (!envProjectId) return;
  const vars = collectEnvVars();
  try {
    const res = await fetch(`${API_BASE}/project-env/${envProjectId}`, {
      method: 'POST',
      headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ vars, env: envCurrentType }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    envVarsData = vars;
    renderEnvRows();
    showToast('Variables saved', 'success');
  } catch (err) {
    console.error('Failed to save env vars:', err);
    showToast('Failed to save variables', 'error');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // Back navigation for project-env is handled via Telegram BackButton (see BackButton.onClick handler)
  document.getElementById('btn-env-dev')?.addEventListener('click', async () => {
    envCurrentType = 'dev';
    document.getElementById('btn-env-dev')?.classList.add('active');
    document.getElementById('btn-env-release')?.classList.remove('active');
    await loadEnvVars();
  });
  document.getElementById('btn-env-release')?.addEventListener('click', async () => {
    envCurrentType = 'release';
    document.getElementById('btn-env-release')?.classList.add('active');
    document.getElementById('btn-env-dev')?.classList.remove('active');
    await loadEnvVars();
  });
  document.getElementById('btn-env-add-row')?.addEventListener('click', () => {
    const vars = collectEnvVars();
    vars[''] = '';
    envVarsData = vars;
    renderEnvRows();
    const rows = document.querySelectorAll('#env-rows .env-row');
    const last = rows[rows.length - 1];
    if (last) last.querySelector('.env-key-input')?.focus();
  });
  document.getElementById('btn-env-save')?.addEventListener('click', () => saveEnvVars());
});

init();

