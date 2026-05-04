# Frontend Skill — Telegram Mini App Patterns

## HTML head — always include both scripts

```html
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
  <title>App</title>
  <link rel="stylesheet" href="styles.css">
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <script src="/af-sdk.js"></script>  <!-- AF SDK — must come before app.js -->
</head>
```

## Initialization — always use AF.init()

```js
// ✅ CORRECT — single call handles everything
AF.init({
  project_id: 'YOUR_PROJECT_ID',
  colors: { header: '#0a0e1a', bottom: '#0a0e1a', background: '#0a0e1a' }
});
// AF.init() internally calls: tg.ready(), tg.expand(), tg.disableVerticalSwipes(),
// tg.requestFullscreen() on mobile, and sets all three color bars.

// ❌ WRONG — never call these manually, AF.init() already does it
Telegram.WebApp.ready();
Telegram.WebApp.expand();
Telegram.WebApp.setHeaderColor('#000');
Telegram.WebApp.disableVerticalSwipes();
```

## API calls — always use AF.api()

```js
// ✅ CORRECT — no manual headers, no API_BASE variable, no leading slash on endpoint
const data = await AF.api('rates').then(r => r.json());
const res  = await AF.api('convert?amount=100&from=USD&to=EUR');
await AF.api('favorites', { method: 'POST', body: JSON.stringify({ code: 'USD' }) });

// AF.api() automatically:
//  - adds Content-Type: application/json
//  - adds x-telegram-init-data header
//  - routes to /devapi/{id}/ in dev, /api/{id}/ in production

// ❌ WRONG — never define your own apiCall() or API_BASE
const API_BASE = `/api/${projectId}/`;
function apiCall(endpoint, options = {}) { ... }  // delete this, use AF.api()

// ❌ WRONG — leading slash on endpoint produces double slash → 404
AF.api('/rates');          // → /api/<id>//rates  (404)
AF.api('rates');           // → /api/<id>/rates   ✓
```

## Haptic feedback — use AF.haptic()

```js
// ✅ CORRECT
AF.haptic('light');      // tap feedback (light | medium | heavy | rigid | soft)
AF.haptic('success');    // notification (success | error | warning)
AF.haptic('selection');  // tab/picker selection change

// ❌ WRONG
Telegram.WebApp.HapticFeedback.impactOccurred('light');
```

## Current user — use AF.user

```js
// ✅ CORRECT
const user = AF.user;  // → { id, first_name, last_name, username, photo_url } | null
if (user) console.log('Hello', user.first_name);

// ❌ WRONG
const user = Telegram.WebApp.initDataUnsafe?.user;
```

## Local storage — use AF.storage (prevents key collisions)

```js
// ✅ CORRECT — automatically namespaced as "af:{projectId}:{key}"
AF.storage.set('theme', 'dark');
const theme = AF.storage.get('theme');   // → 'dark' | null
AF.storage.remove('theme');

// ❌ WRONG — keys collide across projects on the same domain
localStorage.setItem('theme', 'dark');
```

## Back button — use AF.back()

```js
// ✅ CORRECT — manages show/hide and prevents listener leaks
AF.back(() => showScreen('main'));  // shows BackButton, registers handler
AF.back(null);                      // hides BackButton, clears handler

// ❌ WRONG — easy to leak event listeners
Telegram.WebApp.BackButton.show();
Telegram.WebApp.BackButton.onClick(() => showScreen('main'));
```

## WebSocket — use AF.openWS()

```js
// ✅ CORRECT — routes to /devws/ or /ws/ automatically
const ws = AF.openWS({
  onMessage: (data) => { /* data is already parsed JSON */ },
  onOpen:    ()     => console.log('connected'),
  onClose:   ()     => console.log('disconnected'),
  onError:   (e)    => console.error(e)
});
```

## Environment detection

```js
if (AF.isDev) {
  console.log('Running in development mode');
}
// AF.isDev is true when URL contains /dev/{projectId}/
```

## CSS Safe Areas (ALWAYS use for mobile)

```css
/* Top safe area — combine both Telegram variables */
.app-header {
  padding-top: calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px));
}

/* Bottom safe area */
.bottom-nav, .bottom-bar {
  padding-bottom: calc(var(--tg-safe-area-inset-bottom, 0px) + var(--tg-content-safe-area-inset-bottom, 0px));
}

/* Full app container */
.app {
  padding-top: calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px));
  padding-bottom: calc(var(--tg-safe-area-inset-bottom, 0px) + var(--tg-content-safe-area-inset-bottom, 0px));
  min-height: 100vh;
  box-sizing: border-box;
}
```

## Screen Navigation (SPA pattern)

```js
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');

  if (screenId === 'main') {
    AF.back(null);                          // hide back button on root screen
  } else {
    AF.back(() => showScreen('main'));      // show back button on sub-screens
  }
}

/* CSS for screens */
/*
.screen { display: none; }
.screen.active { display: block; animation: fadeIn 0.3s ease; }
@keyframes fadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
*/
```

## Telegram WebApp — advanced APIs (access via AF.tg)

```js
// AF.tg is the raw Telegram.WebApp object for things not wrapped by AF SDK
const tg = AF.tg;

// Popup / confirm
tg.showPopup({
  title: 'Confirm',
  message: 'Are you sure?',
  buttons: [
    { id: 'yes', type: 'destructive', text: 'Delete' },
    { id: 'no', type: 'cancel' }
  ]
}, (buttonId) => { if (buttonId === 'yes') doDelete(); });

// Main button (bottom CTA)
tg.MainButton.setText('Submit');
tg.MainButton.show();
tg.MainButton.onClick(() => { /* action */ });
tg.MainButton.showProgress();
tg.MainButton.hideProgress();
tg.MainButton.hide();

// Share
tg.switchInlineQuery('check this out', ['users', 'groups']);

// Close
tg.close();

// Theme
const theme = tg.themeParams;
// theme.bg_color, theme.text_color, theme.hint_color, theme.button_color
```

## Toast Notification

```js
function showToast(message, duration = 2000) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, duration);
}

/* CSS:
.toast { position:fixed; bottom:100px; left:50%; transform:translateX(-50%) translateY(20px); background:rgba(30,30,30,0.95); backdrop-filter:blur(16px); color:#fff; padding:12px 24px; border-radius:12px; font-size:14px; z-index:1000; opacity:0; transition:all 0.3s ease; pointer-events:none; }
.toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
*/
```

## Tab Navigation

```js
function setupTabs(tabsContainer, contentContainer) {
  tabsContainer.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      tabsContainer.querySelector('.tab.active')?.classList.remove('active');
      tab.classList.add('active');
      const target = tab.dataset.tab;
      contentContainer.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      contentContainer.querySelector(`[data-tab-content="${target}"]`)?.classList.add('active');
      AF.haptic('selection');
    });
  });
}
```

## Bottom Sheet / Modal

```js
function openModal(modalEl) {
  modalEl.classList.add('open');
  AF.haptic('light');
}
function closeModal(modalEl) {
  modalEl.classList.remove('open');
}

/* HTML structure:
<div class="modal-overlay" id="myModal" onclick="if(event.target===this)closeModal(this)">
  <div class="modal-sheet">
    <div class="modal-handle"></div>
    <div class="modal-content">...</div>
  </div>
</div>
*/

/* CSS:
.modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.5); backdrop-filter:blur(4px); z-index:100; display:none; }
.modal-overlay.open { display:flex; align-items:flex-end; }
.modal-sheet { width:100%; background:#141414; border-radius:24px 24px 0 0; padding:16px; max-height:85vh; overflow-y:auto; animation:slideUp 0.3s ease-out; }
.modal-handle { width:36px; height:5px; border-radius:9999px; background:rgba(255,255,255,0.4); margin:0 auto 16px; }
@keyframes slideUp { from { transform:translateY(100%); } to { transform:translateY(0); } }
*/
```

## Loading Skeleton

```js
function showSkeleton(container, count = 3) {
  container.innerHTML = Array(count).fill(0).map(() => `
    <div class="skeleton-card">
      <div class="skeleton-line" style="width:60%"></div>
      <div class="skeleton-line" style="width:40%"></div>
    </div>
  `).join('');
}

/* CSS:
.skeleton-card { background:#1E1E1E; border-radius:16px; padding:16px; margin-bottom:12px; }
.skeleton-line { height:14px; background:rgba(255,255,255,0.08); border-radius:4px; margin-bottom:8px; animation:shimmer 1.5s infinite; }
@keyframes shimmer { 0%{opacity:0.3} 50%{opacity:0.6} 100%{opacity:0.3} }
*/
```

## Infinite Scroll

```js
function setupInfiniteScroll(containerEl, loadMoreFn) {
  let loading = false, hasMore = true;
  containerEl.addEventListener('scroll', async () => {
    if (loading || !hasMore) return;
    if (containerEl.scrollTop + containerEl.clientHeight >= containerEl.scrollHeight - 100) {
      loading = true;
      hasMore = await loadMoreFn();
      loading = false;
    }
  });
}
```

## Number Formatting

```js
function formatNumber(num) {
  if (num >= 1e9) return (num / 1e9).toFixed(1) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(1) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
  return num.toString();
}

function formatCurrency(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}
```
