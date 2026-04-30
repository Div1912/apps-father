WORKFLOW — NEW TEXT BOT (Kind = textBot, backend-only)

The full Text Bot rules are in the PREFERENCES block (textBot.md). Read them FIRST.
There is NO Mini App, NO frontend, NO HTML. The ONLY file you produce is `backend/routes.js`.

1. list_files (quick scan — the project is almost certainly empty on first build).

2. Load mandatory skills (REQUIRED before planning):
   - load_skill("textbot")        — state persistence model, conversation scaffold, deduplication
   - load_skill("bot-management") — webhook contract, platform behaviour, deep links

3. MANDATORY TECHNICAL PLAN — call `technical_plan(...)` with ALL sections below BEFORE writing any code.

   **Bot purpose** — one sentence describing what the bot does end-to-end.

   **User state shape** — the object stored under `"state:{uid}"` in DB:
   ```js
   // db.get("state:" + uid)
   {
     step: "idle" | "ask_name" | "ask_age" | "browsing" | ...,
     name: string | null,
     age:  number | null,
     // ... every field the bot needs across sessions
   }
   ```

   **DB KEYS** — every key and what it stores:
   ```
   state:{uid}         → user state object (see above)
   catalog             → [{ id, title, price, ... }]    // global data
   order:{orderId}     → { uid, items, total, status }
   pending:{uid}       → [message, ...]                 // offline queue if needed
   ```

   **Conversation flow** — every state.step and what triggers the next step:
   ```
   /start            → step "idle"       → send welcome + main keyboard
   step "idle"
     "📋 Orders"     → show orders
     "🛍 Catalog"    → step "browsing"   → send catalog
     "👤 Profile"    → show profile

   step "ask_name"
     any text        → save name         → step "ask_age" → "How old are you?"
   step "ask_age"
     numeric text    → save age          → step "idle"    → send main menu
     non-numeric     → re-ask
   ```

   **Keyboard layouts** — define every reply keyboard and inline keyboard:
   ```
   mainKeyboard = [["📋 Orders", "🛍 Catalog"], ["👤 Profile", "ℹ️ Help"]]

   catalogItem(item) = inline:
     [{ text: "Buy", callback_data: "buy:" + item.id }]
     [{ text: "« Back", callback_data: "catalog" }]
   ```

   **Commands for setMyCommands**:
   ```
   /start   — Start the bot / main menu
   /help    — Help and command list
   /orders  — My orders
   ```

   This `technical_plan` payload is the CONTRACT. The code MUST match it exactly — don't rename steps or keyboard buttons mid-coding.

4. Write `backend/routes.js` — the ONLY file.
   Structure:
   - Top-level `tg(method, payload)` helper
   - `getOrCreateState(uid, languageCode)` + `saveState(uid, state)`
   - `sendMainMenu(chatId)` helper (used on /start and after any flow completion)
   - `handleMessage(msg)` — dispatches on text and state.step
   - `handleCallback(cq)` — dispatches on callback_data
   - `router.post("/bot-webhook", ...)` — answers 200 first, then calls handlers in try/catch

   CRITICAL structural rules:
   - Always `res.json({ ok: true })` BEFORE any async logic.
   - Always call `saveState(uid, state)` after mutating state.
   - Every `router.post(...)` call MUST close with `});` — missing this causes a syntax error.
   - Inside `handleCallback`, always declare `const state = getOrCreateState(uid, ...);` at the top of each branch that needs it.
   - Use HTML parse mode for all messages. Escape user text with:
     ```js
     const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
     ```

5. configure_app(name, description, longDescription, menuButtonText: "")
   - menuButtonText MUST be "" (empty string). Text bots have no Mini App.
   - ONE atomic call. First build only.

6. set_bot_commands({ commands: [...] }) — list all commands from the plan.

7. deploy_to_dev() — deploy and verify with simulate_telegram + server_logs.

8. finish(shortSummary, summary, context_diff) — ONE atomic call at the very end. See finish-tool.md.
