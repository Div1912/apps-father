WORKFLOW — NEW APP (Kind = App / standard Telegram Mini App)

1. list_files + read existing files (parallel) — understand the current state.

2. Decide real-time needs:
   - Chat, live updates, multiplayer → load_skill('websocket')
   - Custom bot commands, /start deep-links, push notifications → load_skill('bot-management')

3. MANDATORY TECHNICAL PLAN — call `technical_plan(...)` BEFORE writing any code.
   Skip any section only if it genuinely does not apply (e.g. no WS in a CRUD app).

   **DB KEYS** — every key, its format, and what it stores:
   ```
   user:{uid}          → { name, avatar, createdAt }
   item:{id}           → { title, body, authorUid, createdAt }
   items               → [id, id, ...]            // global index
   user_items:{uid}    → [id, id, ...]            // per-user index
   ```

   **REST ENDPOINTS** — every route: method, path, auth required, input, output:
   ```
   GET  /profile          → own profile or null
   POST /profile          → create/update { name }
   GET  /items            → list of items (paginated, ?offset=&limit=)
   POST /items            → create { title, body } → returns { id }
   DELETE /items/:id      → delete if owner
   ```

   **WS MESSAGE TYPES** (only if real-time is needed) — every type, both directions:
   ```
   client → server:
     { type: "auth",     initData }      // FIRST message after connect; server derives user id
     { type: "send_msg", roomId, text }
   server → client:
     { type: "authed" }
     { type: "new_msg",  roomId, msg: { from, text, ts } }
   ```

   **SCREENS / COMPONENTS** — each screen, what data it loads, what events it reacts to:
   ```
   Home      — GET /items on mount; WS "new_item" event
   Detail    — GET /items/:id on mount
   Profile   — GET /profile on mount
   ```

   **TEST SCENARIOS** — every important behaviour you will verify before finish.
   For multi-user or real-time apps, include concrete users and expected event types:
   ```
   registration-flow:
     simulate_api({ userId: -100, method: "POST", path: "/profile", body: {...} })
   chat-message:
     simulate_ws({
       scenarioId: "chat-message",
       seedDb: [{ key: "matches", value: [{ id: "m1", users: ["-100", "-101"] }] }],
       steps: [
         { type: "ws", clientId: "a", data: { type: "auth" } },
         { type: "ws", clientId: "b", data: { type: "auth" } },
         { type: "ws", clientId: "a", data: { type: "send_msg", matchId: "m1", toUserId: "-101", text: "Hi" } }
       ],
       expectTypes: ["authed", "new_msg"]
     })
   ```
   Use `simulate_api({ userId: -101, ... })` for a second REST user. Use `seedDb` with real arrays/objects, never stringified JSON.

   This `technical_plan` payload is the CONTRACT. Backend and frontend MUST match it exactly.
   Do NOT invent new endpoint names or WS types mid-coding — stick to the plan.

4. Write `backend/routes.js` FIRST — every REST endpoint and WS handler from the plan.
   - Use `req.telegramUser` for the authenticated user (set by middleware).
   - Every endpoint that returns user-specific data MUST check `if (!req.telegramUser) { res.status(401).json({ error: 'Unauthorized' }); return; }`.
   - WS: every message type from the plan must be handled; derive the user id from Telegram initData during `auth`, never trust a raw `userId` from the client.

5. Write frontend files (`frontend/index.html`, `frontend/styles.css`, `frontend/app.js`).
   - API base URL in frontend: `/api/${projectId}/`  (rewritten to `/devapi/` in dev automatically).
   - WS URL: `{wsBaseUrl}/ws/${projectId}`.
   - All API calls and WS types MUST match routes.js exactly — copy names from the plan.

6. shell("npm install <pkg>") only if an external package is genuinely needed.

7. configure_app(name, description, longDescription, menuButtonText)
   - ONE atomic call. ONLY on the first build. NEVER call telegram_api for app/bot setup.
   - It saves metadata to Apps Father DB first. If no bot is connected yet, the platform applies it automatically when the bot is linked.
   - NEVER use setMyCommands.

8. fetch_url to read docs only when you need to learn an unfamiliar external API.

9. deploy_to_dev() — deploy to dev and verify via the Dev URLs.

10. Verify with simulate_api / simulate_ws / server_logs.
   - For REST multi-user flows, pass `userId` explicitly.
   - For WS flows, pass `scenarioId` and `expectTypes` for each planned test scenario.
   - Do not add simulator-specific hacks to generated app code. Fix the app logic or the test setup.

11. finish(shortSummary, summary, context_diff) — ONE atomic call at the very end. See finish-tool.md.
