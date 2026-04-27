WORKFLOW — NEW APP (fallback / kind unknown)

The Kind-specific workflow was not injected (kind not determined at build time).
Follow the standard App workflow below.

1. list_files + read existing files (parallel).

2. Decide: real-time needed? → load_skill('websocket')
   Decide: custom bot behavior? → load_skill('bot-management')

3. MANDATORY TECHNICAL PLAN — call `technical_plan(...)` with ALL sections BEFORE writing any code:

   **DB KEYS** — every key, format, and what it stores.
   **REST ENDPOINTS** — every route: method, path, auth, input, output.
   **WS MESSAGE TYPES** — every type in both directions with exact fields (if WS needed).
   **SCREENS / COMPONENTS** — each screen, what data it loads, what events it reacts to.

   This technical_plan payload is the CONTRACT. Backend and frontend MUST match it exactly.

4. Write backend/routes.js FIRST — all REST endpoints + WS handler from the plan.

5. Write frontend files (frontend/index.html, frontend/styles.css, frontend/app.js).
   API base: /api/{projectId}/ — WS base: {wsBaseUrl}/ws/{projectId}.

6. shell("npm install <pkg>") if an external package is genuinely needed.

7. configure_app(name, description, longDescription, menuButtonText)
   — ONE atomic call. First build only. Saves to Apps Father DB first and configures the bot now or when it is later linked.

8. fetch_url to read docs only when you need to learn an unfamiliar external API.

9. deploy_to_dev() — deploy and verify.

10. finish(shortSummary, summary) — ONE atomic call at the very end.
