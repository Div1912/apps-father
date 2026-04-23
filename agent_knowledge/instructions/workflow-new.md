WORKFLOW FOR NEW APP:
0. Read the PREFERENCES block at the top of this prompt FIRST. The `Kind` field determines which workflow you follow:

   **Kind = Game** — single-file Three.js build. See `preferences/kind/game.md`.
   - The build is ONE file: `mini_app/index.html` with inline CSS and a single `<script type="module">` block. NO `app.js`, NO `styles.css`, NO `routes.js`, NO database, NO bot webhook.
   - SKIP steps 5, 6, 7 below entirely (no backend, no separate frontend files, no `npm install`). The plan-before-code discipline in `preferences/kind/game.md` REPLACES step 4.
   - Step 8 (`configure_bot`) still runs when `db.botToken` is set — the menu button just opens the game.
   - Step 10 (`deploy_to_dev`) and step 11 (`finish`) still run as normal.
   - If the game truly needs a server (multiplayer, server-side leaderboard), and only then, you MAY add `routes.js` — but document why in the plan.

   **Kind = Text Bot** — backend-only, no Mini App. See `preferences/kind/textBot.md`.
   - The build is ONLY `backend/routes.js`. NO `mini_app/index.html`, NO `app.js`, NO `styles.css`, NO HTML at all. If you generate any frontend file you have misunderstood the project.
   - `routes.js` MUST export `router.post("/bot-webhook", async (req, res) => { ... })` (exact path) — the platform forwards every Telegram update there. See `agent_knowledge/skills/bot-management.md` for the full webhook contract; load it before writing the handler.
   - SKIP step 6 entirely (no frontend files).
   - SKIP step 7 unless an external library is genuinely required (use `fetch` against `https://api.telegram.org/bot${db.botToken}/...` directly).
   - Step 8 (`configure_bot`): pass `menuButtonText: ""` so the chat menu stays on Telegram's default. The platform also force-clears any stale Mini App menu button when `kind === "textBot"`.
   - Step 10 (`deploy_to_dev`) and step 11 (`finish`) still run as normal.
   - The bot token is ALREADY linked when planning starts (the user created it in BotFather first), so `db.botToken` and `db.botUsername` are populated from turn 1 — use them.

   **Kind = App** (or AUTO) — standard Mini App. Continue with steps 1-11 below.
1. list_files + read existing files (parallel calls to understand current state)
2. Decide: does this app need real-time? (chat, games, live updates → YES → load_skill('websocket'))
3. Decide: does this app need custom bot behavior? (custom commands, /start <param> deep links, callback buttons, push notifications → YES → load_skill('bot-management'))
4. Plan ALL files mentally: decide endpoints, db keys, WS message types, frontend API calls BEFORE writing any code
5. Write backend/routes.js FIRST — REST endpoints + module.exports.ws handler if real-time needed + router.post("/bot-webhook", ...) (EXACT path, no variants) if custom bot behavior needed
6. Write frontend files (index.html, styles.css, app.js) — endpoint names and WS message types MUST match routes.js exactly
7. shell("npm install <pkg>") if external packages needed
8. configure_bot(name, description, shortDescription, menuButtonText) — call ONLY if db.botToken is non-empty. If db.botToken is an empty string (bot not yet linked), skip this step entirely — the bot will be configured automatically when the user links it after the build. When called: ONE atomic call sets name + description + short description + menu button (the `name` is also saved as the app name in Apps Father, so the user sees a meaningful name in the app list instead of "New App"). ONLY on first build. NEVER call telegram_api(setMyName/setMyDescription/setMyShortDescription/setChatMenuButton) — those are merged into configure_bot. NEVER use setMyCommands.
9. fetch_url to read API docs only when you actually need to learn an unfamiliar external API
10. deploy_to_dev() to deploy your code
11. Final turn: call finish(shortSummary, summary) — ONE atomic call. There is NO separate short_summary/summary/done.
