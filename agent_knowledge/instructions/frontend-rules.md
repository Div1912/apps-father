RULES FOR FRONTEND:
1. Single-page app: HTML + CSS + vanilla JS
2. Always include BOTH scripts in <head>, in this order:
   <script src="https://telegram.org/js/telegram-web-app.js"></script>
   <script src="/af-sdk.js"></script>
3. SAFE AREA PADDING — always apply to the outermost app container:
   padding-top: max(0px, calc(var(--tg-content-safe-area-inset-top, 0px) + var(--tg-safe-area-inset-top, 0px)));
   padding-bottom: max(0px, env(safe-area-inset-bottom, 0px));
   NEVER use var(--tg-safe-area-inset-bottom) alone for bottom padding — use the env() form above.
4. ALWAYS initialize via AF.init() — never call Telegram.WebApp methods manually:
   AF.init({
     project_id: PROJECT_ID,
     colors: { header: BG_COLOR, bottom: BG_COLOR, background: BG_COLOR }
   });
   Set header, bottom, AND background all to the SAME value as the app's key background color
   (e.g. if the app background is #0d0d0d, pass '#0d0d0d' for all three).
   This makes the Telegram chrome blend seamlessly with the app.
   AF.init() calls tg.ready(), tg.expand(), tg.disableVerticalSwipes(), tg.requestFullscreen()
   on mobile, and sets all three colors. Do NOT duplicate any of these calls.
5. NEVER use Telegram theme CSS variables for app colors:
   FORBIDDEN: var(--tg-theme-bg-color), var(--tg-theme-text-color), var(--tg-theme-button-color),
              var(--tg-theme-hint-color), var(--tg-theme-link-color), var(--tg-theme-secondary-bg-color),
              and any other --tg-theme-* variable.
   WHY: These inherit the user's Telegram theme (could be any color) and break the app's
        intentional design. Define ALL colors yourself using CSS variables in :root {}.
   CORRECT: :root { --bg: #0d0d0d; --accent: #6c63ff; --text: #f0f0f0; }
6. All fetch/API calls MUST use AF.api() — never construct fetch calls manually:
   AF.api('endpoint', options?)  → Promise<Response>
   AF.api() automatically adds Content-Type and x-telegram-init-data headers,
   and routes to /devapi/ in dev mode or /api/ in production.
   NEVER define your own apiCall() function or API_BASE variable.
7. API endpoint strings passed to AF.api() MUST NOT start with a slash.
   CORRECT: AF.api('users')          → /api/<id>/users
   CORRECT: AF.api('convert?a=1')    → /api/<id>/convert?a=1
   WRONG:   AF.api('/users')         → /api/<id>//users  (404)
8. NEVER escape quotes inside HTML attributes. Correct: id="game-canvas". Wrong: id="\"game-canvas\"".
9. Use AF.haptic() for all haptic feedback — never call tg.HapticFeedback directly:
   AF.haptic('light')     → impact (light/medium/heavy/rigid/soft)
   AF.haptic('success')   → notification (success/error/warning)
   AF.haptic('selection') → selectionChanged
10. Use AF.storage for localStorage — never use localStorage directly (causes key collisions):
    AF.storage.get(key)        → parsed value | null
    AF.storage.set(key, val)   → stores as JSON, namespaced by project
    AF.storage.remove(key)
11. Use AF.back() for BackButton management — never touch tg.BackButton directly:
    AF.back(() => showScreen('main'))  → shows button, registers handler (replaces previous)
    AF.back(null)                      → hides button, removes handler
12. Read current user via AF.user (not initDataUnsafe directly):
    const user = AF.user;  // → { id, first_name, last_name, username } | null
13. Strings containing Ukrainian/Russian text with apostrophes (зв'язок, м'яч, etc.) MUST
    use double quotes or template literals — NEVER single quotes.
    WRONG:  confirm('Це розірве зв'язок')   ← SyntaxError
    CORRECT: confirm("Це розірве зв'язок")
14. ALL interactive elements MUST support both mouse (desktop) and touch (mobile).
    - Use click events for buttons and links.
    - For game controls use Pointer Events (pointerdown/pointermove/pointerup).
    - canvas must have touch-action:none AND handle both pointer and mouse events.
15. Z-INDEX RULES:
    - Layers: base (0–9), cards (10–49), dropdowns (50–99), modals (100–199), toasts (200+).
    - Hidden elements must have z-index:auto or lower than any visible interactive element.
    - Overlay divs must have pointer-events:none when hidden.

VALIDATOR — self-check before calling finish():
- Does index.html include <script src="/af-sdk.js"> before app.js? If not, add it.
- Does app.js call AF.init({...})? If not, replace manual tg.* calls with AF.init().
- Does AF.init() pass the same hex color for header, bottom, AND background? If not, fix it.
- Does styles.css or app.js use any var(--tg-theme-*)? If yes, replace with own CSS variables.
- Does app.js define its own apiCall() or API_BASE? If yes, replace with AF.api().
- Does app.js call localStorage directly? If yes, replace with AF.storage.
- Does app.js call tg.HapticFeedback directly? If yes, replace with AF.haptic().
- Does app.js call tg.BackButton directly? If yes, replace with AF.back().
- Do any AF.api() calls pass an endpoint starting with "/"? If yes, remove the leading slash.
