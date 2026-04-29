RULES FOR FRONTEND:
1. Single-page app: HTML + CSS + vanilla JS
2. Always include: <script src="https://telegram.org/js/telegram-web-app.js"></script>
3. Use Telegram theme vars: var(--tg-theme-bg-color), var(--tg-theme-text-color), padding-top: max(12px, calc(var(--tg-content-safe-area-inset-top, 0px) + var(--tg-safe-area-inset-top, 0px))); padding-bottom: var(--tg-safe-area-inset-bottom); - for safe area of app, etc.
4. ALWAYS call on load: Telegram.WebApp.ready(); Telegram.WebApp.expand(); Telegram.WebApp.setHeaderColor("#000000"); Telegram.WebApp.setBottomBarColor("#000000"); Telegram.WebApp.setBackgroundColor("#000000"); Telegram.WebApp.disableVerticalSwipes(); On mobile if (['android', 'ios'].includes(tg.platform)): Telegram.WebApp.requestFullscreen();
5. All fetch calls MUST include initData header:
   function apiCall(endpoint, options = {}) {
     const headers = { 'Content-Type': 'application/json', 'x-telegram-init-data': (window.Telegram?.WebApp?.initData || ''), ...(options.headers || {}) };
     return fetch(endpoint, { ...options, headers });
   }
6. API base URL: /api/{projectId}/
7. NEVER escape quotes inside HTML attributes. Correct: id="game-canvas" and class="screen active". Wrong: id="\"game-canvas\"", id='"game-canvas"', or document.getElementById("\"game-canvas\""). JavaScript must query the plain id: document.getElementById("game-canvas").
8. API_BASE already ends with "/". Endpoints must NEVER start with "/".
   WRONG:  fetch(API_BASE + '/users')   → produces ".../api/id//users" (double slash, request fails)
   CORRECT: fetch(API_BASE + 'users')   → produces ".../api/id/users"
   Pattern: const API_BASE = `/api/${projectId}/`; then always fetch(API_BASE + 'endpoint', ...)
9. Strings containing Ukrainian/Russian text with apostrophes (зв'язок, м'яч, з'єднання, etc.) MUST
   use double quotes or template literals — NEVER single quotes.
   WRONG:  confirm('Ви впевнені? Це розірве зв'язок')   ← inner apostrophe terminates string → SyntaxError
   CORRECT: confirm("Ви впевнені? Це розірве зв'язок")
   CORRECT: confirm(`Ви впевнені? Це розірве зв'язок`)
10. ALL interactive elements MUST support both mouse (desktop) and touch (mobile).
    - Use click events for buttons and links — click fires on both desktop and mobile.
    - If you add touchstart/touchend/touchmove, also add the equivalent mousedown/mousemove/mouseup.
    - For game controls and gestures use Pointer Events (pointerdown/pointermove/pointerup) which
      unify mouse and touch in a single API. NEVER attach game controls to touch events only.
    - canvas should have touch-action:none AND handle both pointer and mouse events on the same element.
    - Test mentally: "does this work if the user clicks with a mouse on desktop?" before finishing.
11. Z-INDEX RULES — broken z-index is the #1 reported UI bug.
    - Define explicit layers: base (0–9), cards (10–49), dropdowns (50–99),
      modals/overlays (100–199), toasts/notifications (200+).
    - Hidden elements (display:none, visibility:hidden, opacity:0) MUST have z-index:auto
      or lower than any visible interactive element. NEVER assign a high z-index to a hidden element.
    - When an element becomes visible set its z-index; when hidden reset it to auto or 0.
    - Overlay/backdrop divs must cover the viewport but NOT intercept clicks when inactive —
      add pointer-events:none when the overlay is hidden or transparent.
    - Verify after every modal/panel open: buttons behind the overlay must NOT be clickable.
      Verify after close: they MUST be clickable again.
