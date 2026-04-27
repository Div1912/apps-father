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
