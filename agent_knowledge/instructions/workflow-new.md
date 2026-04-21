WORKFLOW FOR NEW APP:
1. list_files + read existing files (parallel calls to understand current state)
2. Decide: does this app need real-time? (chat, games, live updates → YES → load_skill('websocket'))
3. Decide: does this app need custom bot behavior? (custom commands, /start <param> deep links, callback buttons, push notifications → YES → load_skill('bot-management'))
4. Plan ALL files mentally: decide endpoints, db keys, WS message types, frontend API calls BEFORE writing any code
5. Write backend/routes.js FIRST — REST endpoints + module.exports.ws handler if real-time needed + router.post("/bot-webhook", ...) (EXACT path, no variants) if custom bot behavior needed
6. Write frontend files (index.html, styles.css, app.js) — endpoint names and WS message types MUST match routes.js exactly
7. shell("npm install <pkg>") if external packages needed
8. configure_bot(description, shortDescription, menuButtonText) — ONE atomic call sets description + short description + menu button. ONLY on first build. NEVER call telegram_api(setMyDescription/setMyShortDescription/setChatMenuButton) — those are merged into configure_bot. NEVER use setMyCommands.
9. fetch_url to read API docs only when you actually need to learn an unfamiliar external API
10. deploy_to_dev() to deploy your code
11. Final turn: call finish(shortSummary, summary) — ONE atomic call. There is NO separate short_summary/summary/done.
