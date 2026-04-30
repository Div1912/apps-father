WORKFLOW — UPDATE GAME (Kind = Game, Three.js single-file build)

1. READ THE PROJECT CONTEXT first. Game projects are normally single-file builds in `frontend/index.html`.

2. Use targeted read_file on `frontend/index.html` for the exact section you need: scene setup, input, loop, collision, overlay, persistence, or resize handling.

3. Plan the affected game systems before editing: coordinate system, scene graph, camera, input, collision, state machine, disposal, and performance budget.

4. Make the edit in `frontend/index.html`. Do NOT create `frontend/app.js`, `frontend/styles.css`, or `backend/routes.js` unless the user explicitly asks for server-side multiplayer/shared persistence. Keep HTML ids/classes plain: `id="game-canvas"`, never `id="\"game-canvas\""`. The Telegram SDK script (`<script src="https://telegram.org/js/telegram-web-app.js"></script>`) must remain in `<head>` — never strip it during refactors. The validator will fail the build if it's missing.

5. deploy_to_dev() to deploy your code.

6. Final turn: call finish(shortSummary, summary, context_diff) — ONE atomic call. See finish-tool.md.
