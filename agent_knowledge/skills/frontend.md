# Frontend Skill — Telegram Mini App Patterns

## Telegram WebApp API

```js
// Initialize (ALWAYS include all of these)
Telegram.WebApp.ready();
Telegram.WebApp.expand();
Telegram.WebApp.setHeaderColor("#000000");
Telegram.WebApp.setBottomBarColor("#000000");
Telegram.WebApp.setBackgroundColor("#000000");
Telegram.WebApp.disableVerticalSwipes();
if (Telegram.WebApp.platform === "ios" || Telegram.WebApp.platform === "android") {
  Telegram.WebApp.requestFullscreen();
}

// Theme
const theme = Telegram.WebApp.themeParams;
// theme.bg_color, theme.text_color, theme.hint_color, theme.button_color, theme.button_text_color

// Haptic feedback
Telegram.WebApp.HapticFeedback.impactOccurred('light'); // light | medium | heavy | rigid | soft
Telegram.WebApp.HapticFeedback.notificationOccurred('success'); // success | error | warning
Telegram.WebApp.HapticFeedback.selectionChanged();

// Main button (bottom CTA)
Telegram.WebApp.MainButton.setText('Submit');
Telegram.WebApp.MainButton.show();
Telegram.WebApp.MainButton.onClick(() => { /* action */ });
Telegram.WebApp.MainButton.showProgress();
Telegram.WebApp.MainButton.hideProgress();
Telegram.WebApp.MainButton.hide();

// Back button
Telegram.WebApp.BackButton.show();
Telegram.WebApp.BackButton.onClick(() => { showScreen('main'); });
Telegram.WebApp.BackButton.hide();

// Popup / confirm
Telegram.WebApp.showPopup({
  title: 'Confirm',
  message: 'Are you sure?',
  buttons: [
    { id: 'yes', type: 'destructive', text: 'Delete' },
    { id: 'no', type: 'cancel' }
  ]
}, (buttonId) => { if (buttonId === 'yes') doDelete(); });

// Share
Telegram.WebApp.switchInlineQuery('check this out', ['users', 'groups']);

// Close
Telegram.WebApp.close();

// Get user info
const user = Telegram.WebApp.initDataUnsafe?.user;
// user.id, user.first_name, user.last_name, user.username, user.photo_url

// Platform detection
const platform = Telegram.WebApp.platform; // 'android' | 'ios' | 'tdesktop' | 'web'
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

## API Call Helper (always use this pattern)

CRITICAL — `API_BASE` MUST end with a trailing slash, and endpoint strings
MUST NOT start with a slash. Otherwise fetch produces a malformed URL like
`/api/<id>convert` (no separator) or `/api/<id>//convert` (double slash),
both of which 404 silently and the agent only finds out via runtime errors.

```js
// ✅ CORRECT — API_BASE ends with "/", endpoints have no leading "/"
const API_BASE = '/api/{PROJECT_ID}/';

async function apiCall(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'x-telegram-init-data': Telegram.WebApp?.initData || '',
    ...(options.headers || {})
  };
  const response = await fetch(API_BASE + endpoint, { ...options, headers });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

// Usage:
apiCall('convert?amount=100&from=USD&to=EUR'); // → /api/<id>/convert?...
apiCall('preferences');                        // → /api/<id>/preferences
```

```js
// ❌ WRONG — missing trailing slash on API_BASE produces /api/<id>convert
const API_BASE = '/api/{PROJECT_ID}';
fetch(API_BASE + 'convert'); // → /api/<id>convert  (404)

// ❌ WRONG — leading slash on endpoint produces /api/<id>//convert
const API_BASE = '/api/{PROJECT_ID}/';
fetch(API_BASE + '/convert'); // → /api/<id>//convert  (404)
```

## Direct External API Calls (no backend needed)

For read-only public APIs, call directly from frontend:

```js
// Pattern: fetch external API directly
async function fetchExternalData(query) {
  try {
    const response = await fetch(`https://api.example.com/data?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('API error:', error);
    showToast('Failed to load data');
    return null;
  }
}
```

## Search with Debounce

```js
let searchTimeout = null;

function setupSearch(inputEl, resultsEl, searchFn) {
  inputEl.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const query = inputEl.value.trim();
    if (query.length < 2) { resultsEl.innerHTML = ''; return; }
    searchTimeout = setTimeout(async () => {
      resultsEl.innerHTML = '<div class="loading">Searching...</div>';
      const results = await searchFn(query);
      renderResults(resultsEl, results);
    }, 300);
  });
}
```

## Screen Navigation (SPA pattern)

```js
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
  
  if (screenId === 'main') {
    Telegram.WebApp.BackButton.hide();
  } else {
    Telegram.WebApp.BackButton.show();
    Telegram.WebApp.BackButton.onClick(() => showScreen('main'));
  }
}

/* CSS for screens */
/*
.screen { display: none; }
.screen.active { display: block; animation: fadeIn 0.3s ease; }
@keyframes fadeIn { from { opacity:0; transform:translateY(10px); } to { opacity:1; transform:translateY(0); } }
*/
```

## Bottom Sheet / Modal

```js
function openModal(modalEl) {
  modalEl.classList.add('open');
  Telegram.WebApp.HapticFeedback.impactOccurred('light');
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

## Pull to Refresh

```js
function setupPullToRefresh(containerEl, refreshFn) {
  let startY = 0, pulling = false;
  containerEl.addEventListener('touchstart', (e) => {
    if (containerEl.scrollTop === 0) { startY = e.touches[0].clientY; pulling = true; }
  });
  containerEl.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const diff = e.touches[0].clientY - startY;
    if (diff > 80) { pulling = false; refreshFn(); }
  });
  containerEl.addEventListener('touchend', () => { pulling = false; });
}
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
      Telegram.WebApp.HapticFeedback.selectionChanged();
    });
  });
}
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
