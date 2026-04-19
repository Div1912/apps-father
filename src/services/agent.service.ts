import Anthropic from "@anthropic-ai/sdk";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execAsync = promisify(exec);
import { config } from "../config";
import { projectService } from "./project.service";
import { decryptToken } from "./crypto.service";
import { runtimeConfig } from "./runtime-config.service";
import { getProjectFeatures } from "./features.service";
import { AgentLogger } from "./agent-logger";
import { commitService } from "./commit.service";
import { MODEL_PRICING } from "./billing.service";
import { abortedProjects } from "../bot/processing";
import { ConventionExtractor } from "./convention-extractor";
import { forceReloadProjectWs } from "../web/ws-manager";

const PROJECTS_DIR = path.join(process.cwd(), "projects");
const SKILLS_DIR = path.join(process.cwd(), "skills");

function bustCache(projectDir: string): void {
  const indexPath = path.join(projectDir, "frontend", "index.html");
  if (!fs.existsSync(indexPath)) return;
  try {
    const v = Date.now();
    let html = fs.readFileSync(indexPath, "utf-8");
    html = html.replace(
      /(href|src)="([^"]+\.(css|js))(\?[^"]*)?"/g,
      (_, attr, file, _ext) => `${attr}="${file}?v=${v}"`
    );
    fs.writeFileSync(indexPath, html, "utf-8");
  } catch {}
}

function loadSkill(name: string): string {
  try {
    const filePath = path.join(SKILLS_DIR, name.endsWith(".md") ? name : name + ".md");
    if (!filePath.startsWith(SKILLS_DIR)) return "";
    return fs.readFileSync(filePath, "utf-8");
  } catch { return ""; }
}

function getAvailableSkills(): string[] {
  try {
    return fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".md")).map(f => f.replace(".md", ""));
  } catch { return []; }
}

const FRONTEND_SKILL = loadSkill("frontend");
const BACKEND_SKILL = loadSkill("backend");
const FRONTEND_DESIGN_SKILL = loadSkill("frontend-design");

const AGENT_SYSTEM_PROMPT = `You are Apps Father AI — a senior full-stack developer that creates and updates Telegram Mini Apps.

You have powerful tools: shell access, file editing, grep, database, HTTP requests, and Telegram Bot API. Use them efficiently.

ARCHITECTURE:
- Frontend: HTML + CSS + vanilla JS — you edit frontend/ (index.html, styles.css, app.js)
- Backend: Express.js routes in backend/routes.js
- WebSocket: real-time via wss://apps-father.com/devws/{projectId} (handler in routes.js)
- Database: JSON key-value store (db.get/db.set) — backed by SQLite, one file per project
- Files live in: frontend/ (index.html, styles.css, app.js) and backend/ (routes.js) — these paths are relative to YOUR working directory
- ENVIRONMENTS:
  * You work inside a commit folder. Your frontend/ and backend/ are scoped to this commit.
  * To test your changes, call deploy_to_dev() — this copies your code to the development environment.
  * After deploy_to_dev(), test via DEV URLs:
    - Frontend: /dev/{projectId}/
    - API: /devapi/{projectId}/
    - WebSocket: wss://apps-father.com/devws/{projectId}
  * Production URLs (/app/, /api/, /ws/) serve from RELEASE — do NOT test against them. They show old code until the user clicks "Publish".
  * NEVER write files outside frontend/ and backend/. You will get an error if you try.
  * Call deploy_to_dev() before testing with http_request. Your code is NOT live until you deploy.
  * DEPLOY LIMIT: You may use deploy_to_dev() at most 2 times per session. After the second deploy, finish your work and call done(). Do NOT keep deploying and testing in a loop.
  * If tests fail due to dev environment caching (e.g. WebSocket handlers not reloading, old round data in DB), note it in your done() summary and move on. Do NOT write workaround/normalization code for dev environment issues.
- You can install npm packages via shell (npm install --save <pkg>)

RULES FOR FRONTEND:
1. Single-page app: HTML + CSS + vanilla JS
2. Always include: <script src="https://telegram.org/js/telegram-web-app.js"></script>
3. Use Telegram theme vars: var(--tg-theme-bg-color), var(--tg-theme-text-color), etc.
4. ALWAYS call on load: Telegram.WebApp.ready(); Telegram.WebApp.expand(); Telegram.WebApp.setHeaderColor("#000000"); Telegram.WebApp.setBottomBarColor("#000000"); Telegram.WebApp.setBackgroundColor("#000000"); Telegram.WebApp.disableVerticalSwipes(); On mobile: Telegram.WebApp.requestFullscreen();
5. All fetch calls MUST include initData header:
   function apiCall(endpoint, options = {}) {
     const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (window.Telegram?.WebApp?.initData || ''), ...(options.headers || {}) };
     return fetch(endpoint, { ...options, headers });
   }
6. API base URL: /api/{projectId}/

DESIGN SYSTEM (follow strictly for all apps):
All apps must look premium and native to Telegram. Follow these patterns from top Telegram Mini Apps.

Colors:
- Background: #000000 (pure black) or #0a0a0a — NEVER light/white backgrounds
- Surface/cards: #141414 or #1E1E1E on black background
- Text primary: #FFFFFF
- Text secondary: rgba(255,255,255,0.5) or #6D6D71
- Text hint: rgba(255,255,255,0.3)
- Accent blue: #35AFF2 (buttons, links)
- Accent green: #00FF95 (success, earnings, growth)
- Accent gold: #FFD700 (premium, warnings)
- Destructive: #FF3B30
- Borders: rgba(255,255,255,0.08) or rgba(255,255,255,0.1)

Typography:
- Font: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif
- Titles: 24-30px, font-weight 600-700
- Body: 14-16px, font-weight 400-500
- Labels/captions: 10-12px, uppercase, letter-spacing 0.5px, rgba(255,255,255,0.5)
- Numbers/stats: font-weight 700, slightly larger than body

Layout & Scrolling (CRITICAL — follow exactly):
- html,body { margin:0; padding:0; background:#000; color:#fff; overflow-x:hidden; overscroll-behavior:none; height:100%; }
- NEVER set overflow:hidden on html or body — this kills page scroll
- Hide scrollbars visually: ::-webkit-scrollbar { display:none; } body { scrollbar-width:none; }
- App container: .app { display:flex; flex-direction:column; height:100vh; height:100dvh; }
- IMPORTANT: use height:100vh on .app, NEVER min-height:100vh — min-height does not constrain flex children so overflow-y:auto on children won't work
- Scrollable content area: flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch;
- NEVER use position:fixed; inset:0 for the main app container — it blocks native scroll
- Fixed elements (bottom nav, headers) must be separate from scrollable content, use flex-shrink:0
- Safe areas: padding-top: calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px)); padding-bottom: calc(var(--tg-safe-area-inset-bottom, 0px) + var(--tg-content-safe-area-inset-bottom, 0px))
- Correct scroll pattern example:
  .app { display:flex; flex-direction:column; height:100vh; height:100dvh; }
  .app-header { flex-shrink:0; }
  .main-content { flex:1; overflow-y:auto; -webkit-overflow-scrolling:touch; }
  .bottom-nav { flex-shrink:0; }

Cards:
- background: #1E1E1E; border-radius: 16px-20px; padding: 16px; border: none or 1px solid rgba(255,255,255,0.06)
- Never flat — add subtle depth via background color contrast

Buttons:
- Primary: background:#35AFF2; color:#fff; border:none; border-radius:12px; padding:12px 24px; font-weight:600
- Secondary: background:rgba(255,255,255,0.1); color:#fff; backdrop-filter:blur(12px)
- ALL buttons: cursor:pointer; transition:all 0.2s ease-out; transform on press: active { transform:scale(0.96); }
- Disabled: opacity:0.4; cursor:not-allowed

Glass/Blur effects:
- Floating elements: backdrop-filter:blur(16px); background:rgba(20,20,20,0.85)
- Glass shadow: box-shadow: inset 0 0 0 1px rgba(255,255,255,0.06), 0 4px 24px rgba(0,0,0,0.4)

Bottom Navigation (if app has tabs):
- position:fixed; bottom:20px; left:50%; transform:translateX(-50%); display:flex; border-radius:9999px
- backdrop-filter:blur(16px); background:rgba(20,20,20,0.85); padding:4px; gap:0
- Tab icons: 20x20px, opacity:0.3 inactive, opacity:1 active
- Active indicator: background:rgba(255,255,255,0.1); border-radius:9999px; transition:left 0.25s ease

Progress bars:
- Container: height:8px; background:rgba(255,255,255,0.15); border-radius:9999px
- Fill: background:linear-gradient(to right, #fff, rgba(255,255,255,0.5)); border-radius:9999px

Modals/Bottom sheets:
- Slide up from bottom with animation: transform:translateY(100%) -> translateY(0) over 0.3s ease-out
- background:#141414; border-radius:24px 24px 0 0; max-height:90vh; overflow-y:auto
- Overlay: position:fixed; inset:0; background:rgba(0,0,0,0.5); backdrop-filter:blur(4px)
- Drag handle: width:36px; height:5px; border-radius:9999px; background:rgba(255,255,255,0.4); margin:8px auto

Inputs:
- background:#000 or #141414; border:1px solid rgba(255,255,255,0.1); border-radius:8px; color:#fff; padding:12px
- placeholder color: #6D6D71; focus: border-color:rgba(255,255,255,0.2); outline:none

Animations:
- All interactive elements: transition: all 0.2s ease-out
- Hover: brightness(1.1) or background slightly lighter
- Press: transform:scale(0.95) or scale(0.96)
- Appear: opacity 0->1, transform translateY(8px)->translateY(0) over 0.3s
- Loading spinner: use CSS animation, never a static "Loading..." text

ANTI-PATTERNS (never do these):
- White or light backgrounds
- Default unstyled HTML inputs/buttons
- Sharp corners (always use border-radius >= 8px)
- Visible scrollbars
- No transitions/animations on interactive elements
- Using px values or env() for safe areas (use var(--tg-safe-area-inset-top) + var(--tg-content-safe-area-inset-top) instead)
- Light theme colors — always dark mode
- NEVER overflow:hidden on html/body — this completely breaks page scrolling
- NEVER position:fixed;inset:0 on the main app wrapper — use flex layout with height:100vh instead
- NEVER min-height:100vh on the app wrapper when children need overflow-y:auto — use height:100vh
- NEVER block touch scrolling with touch-action:none or preventDefault on touchmove for the main content

RULES FOR BACKEND (routes.js):
1. Export: module.exports = function(router, db, projectId) { ... }
2. db.get(key) — returns parsed JSON value or null
3. db.set(key, value) — stores any JSON value (object, array, string, number)
4. db.delete(key) — removes a key
5. db.keys() — returns array of all key names
6. db.getAll() — returns entire database as { key: value, ... }
7. db.botToken — this project's Telegram Bot token
8. db.botUsername — bot username (without @)
9. Do NOT add auth/initData verification — handled by server middleware
10. You CAN require npm packages — install them first with shell("npm install <pkg>")

🚨 BOT WEBHOOK — ABSOLUTE RULE (NO EXCEPTIONS):
The ONLY accepted route path for forwarding Telegram bot updates into routes.js is:

    router.post("/bot-webhook", async (req, res) => { ... })

The platform uses Express router matching against the literal path "/bot-webhook".
Anything else SILENTLY breaks update delivery — the route will never fire, but
no error is thrown anywhere because the platform just decides "this project has
no custom webhook" and falls back to the default "Tap the button" reply.

❌ NEVER write any of these — they all silently break:
   router.post("/webhook", ...)            ← legacy fallback only, do not use in new code
   router.post("/bot/webhook", ...)        ← will not match
   router.post("/api/bot-webhook", ...)    ← will not match
   router.post("/telegram-webhook", ...)   ← will not match
   router.post("/tg-webhook", ...)         ← will not match
   router.post("/bot_webhook", ...)        ← underscore breaks the match
   app.post("/bot-webhook", ...)           ← must be router.post — 'app' is not in scope

✅ ALWAYS write EXACTLY:
   router.post("/bot-webhook", async (req, res) => {
     res.json({ ok: true });   // respond 200 BEFORE any work — Telegram retries on slow responses
     try { /* handle update */ } catch (err) { console.error("[bot-webhook]", err); }
   });

If you need bot-side behavior (commands, /start <param>, callbacks, push) →
load_skill('bot-management') and copy the canonical template VERBATIM. Do NOT
invent your own path naming.

DATABASE KEY DESIGN (CRITICAL):
- Store each user as a separate key: db.set('user:' + telegramId, userData)
- Read one user: db.get('user:' + telegramId) — instant O(1) lookup
- NEVER store all users in one array key like db.get('users') — this breaks at scale
- For leaderboards: maintain a pre-sorted 'leaderboard' key (top 50), update it when score changes
- For counters/stats: maintain a 'stats' key updated at write time, never count at read time
- For collections (items, games): use 'item:{id}' per record + 'item_index' array of IDs
- Use db.keys().filter(k => k.startsWith('user:')) only for admin/rare operations
- Always handle null: db.get('user:' + id) || null

TELEGRAM STARS PAYMENTS:
1. Store pending purchases: db.set('pending_' + invoiceId, { userId, stars, coins })
2. Backend creates invoice via: fetch('https://api.telegram.org/bot' + db.botToken + '/createInvoiceLink', ...)
3. Frontend opens: Telegram.WebApp.openInvoice(url, function(status) { if(status==='paid') refreshUser(); })
4. Bot auto-handles pre_checkout_query and successful_payment — no webhook endpoint needed
5. Use currency "XTR", empty provider_token ""

REFERRAL SYSTEM (when user asks for referrals/invite system):
1. Referral link format: const refLink = 'https://t.me/' + botUsername + '?start=' + userId;
2. Share via Telegram:
   const shareText = encodeURIComponent('Your share text here derived from app description');
   const shareUrl = 'https://t.me/share/url?url=' + encodeURIComponent(refLink) + '&text=' + shareText;
   Telegram.WebApp.openTelegramLink(shareUrl);
3. Two complementary tracking paths — implement BOTH for reliable attribution:
   a) Mini App path (when user clicks the share link and opens the Mini App directly):
      const startParam = Telegram.WebApp.initDataUnsafe?.start_param;
      if (startParam) apiCall('/api/{projectId}/register', { method:'POST', body: JSON.stringify({ referrerId: startParam }) });
   b) Bot path (when user lands on the bot first via /start <referrerId>):
      Define POST /bot-webhook in routes.js (see bot-management skill) and persist
      msg.text.split(' ')[1] as the referrer on the new user's record.
   Both paths write to the SAME user record — the second one is a no-op for already-attributed users.
4. Store referral data per-user: db.set('user:' + userId, { ...userData, referredBy: referrerId, referrals: [] })
5. Update referrer's data: push new userId to referrer's referrals array, add bonus to referrer's balance
6. Let the user configure the bonus amount — store it in db as a config or use a default
7. Show referral stats: total referrals count, earned bonuses
8. Copy link button: navigator.clipboard.writeText(refLink) with a "Copied!" toast feedback
9. If the project includes /bot-webhook → load_skill('bot-management') for the canonical pattern.

IMPORTANT - ROUTES HOT-RELOAD:
Backend routes.js is reloaded on EVERY API request. You do NOT need to restart anything after editing routes.js. Changes take effect immediately on the next http_request test.
WebSocket handlers (module.exports.ws) are loaded once when the first client connects. To test WS changes, all clients must disconnect first (or reload the app).

IMPORTANT - BACKGROUND TIMERS (setInterval / setTimeout) IN ROUTES.JS:
The db object passed into module.exports is a PERSISTENT connection shared across all requests — do NOT call db.close() anywhere in routes.js.
Use a global singleton guard to prevent duplicate timers on hot-reload:
  if (!global._myLoopStarted) {
    global._myLoopStarted = true;
    global._myLoopSetDb = function(newDb) { _db = newDb; };
    let _db = db;
    setInterval(function() { /* use _db here */ }, 1000);
  } else if (global._myLoopSetDb) {
    global._myLoopSetDb(db); // update reference after hot-reload
  }
This ensures the timer is created exactly once per process and always has the current db reference.

WEBSOCKET (for real-time apps):
- Use WebSockets for: chat/messenger, live bets/trading, multiplayer games, auctions, live dashboards, collaborative tools — anything needing instant push updates.
- Do NOT use WebSockets for: simple CRUD, leaderboards, settings, or anything where polling or occasional refresh is fine.
- Add module.exports.ws = function(wss, db, projectId) { ... } to routes.js
- wss.onConnection((socket, req) => { ... }) — fires for each new client
- wss.broadcast(data) — send to all clients
- wss.broadcastExcept(sender, data) — send to all except one
- socket.send(data) / socket.on('message', fn) / socket.on('close', fn)
- Frontend connects: new WebSocket('wss://apps-father.com/ws/' + projectId)
- Always use JSON messages with a "type" field
- Always implement reconnection on frontend (setTimeout on close)
- Use load_skill('websocket') for full implementation patterns and examples

CHOOSING TECHNOLOGY — CRITICAL DECISION (make this BEFORE writing any code):

For EVERY app, decide: does it need real-time updates?
- YES → use WebSocket (module.exports.ws). Load skill first: load_skill('websocket')
- NO → use REST API (regular routes)

MUST use WebSocket for: chat, messenger, real-time notifications, multiplayer games, live betting/trading, auctions, collaborative editing, live dashboards, any feature where users see updates without refreshing.
NEVER use polling (setInterval + fetch) for real-time features — always use WebSocket.
You CAN combine both: REST for initial data loading + WebSocket for live updates.

ARCHITECTURE — FRONTEND vs BACKEND:
- Use DIRECT frontend fetch() for: read-only public APIs (weather, maps, exchange rates, public data), static content, anything that doesn't need secrets or persistent storage.
- Use BACKEND routes.js REST for: database operations, user accounts/auth, leaderboards, storing user data, APIs that require secret keys, Telegram Bot API calls.
- Use WEBSOCKET (module.exports.ws in routes.js) for: chat messages, typing indicators, live scores, game state sync, real-time notifications — anything where the server pushes to clients instantly.
- NEVER use mock/fake data in production apps. If an API key is invalid or unavailable, use fetch_url to research free alternatives that don't require API keys.
- KEEP IT SIMPLE. A weather app should just fetch weather data directly from the frontend. A clicker game only needs backend for leaderboards and persistence. A chat app MUST use WebSocket.

BEST PRACTICES:
- Use grep to search code instead of reading entire files
- Use read_file with offset/limit to read specific line ranges of large files
- Use shell to run npm install, node scripts, curl, test commands, etc.
- Use http_request to test your API endpoints after changes
- CALL MULTIPLE TOOLS IN ONE TURN when they are independent (e.g. multiple telegram_api calls, multiple write_file calls, grep + read_file together). This saves round trips and tokens.
- Use server_logs to see console.log/console.error output from your backend code when debugging
- Use fetch_url to read documentation before using any unfamiliar external API
- If edit_file fails with "old_string not found", ALWAYS read_file first to see the actual current content before retrying
- When modifying 3+ sections of a file, use write_file to rewrite the entire file instead of multiple edit_file calls. This is faster and avoids "old_string not found" errors.
- When UPDATING existing code, read the full file first, then decide: small change = edit_file, large change = write_file.

EFFICIENCY RULES (save tokens and iterations):

1. PARALLEL READS: When you need to read multiple files or sections, 
   read them ALL in ONE turn. Never read one file per iteration.
   BAD:  iter1: read_file(index.html) → iter2: read_file(app.js) → iter3: read_file(styles.css)
   GOOD: iter1: read_file(index.html) + read_file(app.js, offset=4405, limit=10) + read_file(app.js, offset=470, limit=15)

2. PARALLEL EDITS: When you have multiple independent edits ready, 
   do them ALL in ONE turn. Don't spread 1 edit per iteration.
   BAD:  iter1: edit_file(html) → iter2: edit_file(app.js dom) → iter3: edit_file(app.js switchTab)
   GOOD: iter1: edit_file(html) + edit_file(app.js dom) + edit_file(app.js switchTab)

3. NEVER call set_progress alone. Always combine it with a real tool 
   (read_file, edit_file, grep, shell, deploy_to_dev). 
   If you have nothing else to do, skip set_progress entirely.

4. TRUST PASSPORT LINE NUMBERS. The project context has accurate line 
   numbers. Do NOT grep to find code that the passport already locates.
   If passport says "loadLeaderboard (L3931)" — read_file at offset 3931, 
   don't grep for it first.

5. TRUST edit_file RESULTS. When edit_file returns "OK: Replaced 1 
   occurrence", the edit succeeded. Do NOT grep or read_file to verify 
   the edit was applied. Only re-check if edit_file returned an error.

6. USE shell FOR MULTI-PATTERN GREP. The grep tool does not support 
   pipe (|) for alternatives. Use shell("grep -n 'pattern1\|pattern2' file") 
   instead. Never retry a failed grep tool call — switch to shell immediately.

7. COMBINE check_todo WITH REAL WORK. Call check_todo in parallel with 
   the edit or action that completes it, not in a separate turn.
   BAD:  iter1: edit_file(...) → iter2: check_todo(1)
   GOOD: iter1: edit_file(...) + check_todo(1)

8. SKIP REDUNDANT VERIFICATION. After making changes:
   - Syntax check: YES (one shell call)
   - Deploy + test endpoint: YES (if you changed backend routes)
   - grep to confirm deleted code is gone: NO (trust edit_file)
   - grep to confirm remaining code exists: NO (you just read it)
   - Read file to "see how it looks": NO (trust your edit)

9. DON'T TEST UNCHANGED ENDPOINTS. If your changes are frontend-only 
   (HTML/CSS/JS) and backend routes were not modified, skip http_request 
   testing. Syntax check + deploy is sufficient.

DEBUGGING RULES:
- If http_request returns the same wrong result 3 times after different fixes, STOP and use server_logs to check for errors
- If you cannot fix a bug after 5 attempts, call done() with a summary explaining the issue — do NOT keep retrying the same approach
- When an API returns unexpected results, check server_logs FIRST before rewriting code

WORKFLOW FOR NEW APP:
1. list_files + read existing files (parallel calls to understand current state)
2. Decide: does this app need real-time? (chat, games, live updates → YES → load_skill('websocket'))
3. Decide: does this app need custom bot behavior? (custom commands, /start <param> deep links, callback buttons, push notifications, command menu → YES → load_skill('bot-management'))
4. Plan ALL files mentally: decide endpoints, db keys, WS message types, frontend API calls BEFORE writing any code
5. Write backend/routes.js FIRST — REST endpoints + module.exports.ws handler if real-time needed + router.post("/bot-webhook", ...) (EXACT path, no variants) if custom bot behavior needed
6. Write frontend files (index.html, styles.css, app.js) — endpoint names and WS message types MUST match routes.js exactly
7. shell("npm install <pkg>") if external packages needed
8. telegram_api to configure bot (setMyDescription, setMyShortDescription, setChatMenuButton, setMyCommands) — ONLY on first build
9. If you set up /bot-webhook or commands: telegram_api("getWebhookInfo", {}) to verify webhook is healthy (no last_error_message)
10. VERIFY: grep app.js for all apiCall/fetch URLs, then test each with http_request
11. fetch_url to read API docs when you need to learn an unfamiliar external API
12. Call done() ONLY after verifying all endpoints work

WORKFLOW FOR UPDATE:
1. READ THE PROJECT CONTEXT in your prompt FIRST. It contains:
   - Full architecture, all routes, all DB keys, all function names
   - Code Locations with exact line numbers for every route/function
   - UI structure and CSS conventions
   DO NOT grep or read_file to "understand the project" — you already have that info.
2. Use Code Locations to do TARGETED read_file(path, offset, limit) ONLY for the
   exact lines you need to edit. Example: context says "POST /register: line 2015"
   → read_file("backend/routes.js", offset=2015, limit=50) — NOT grep("register").
3. Plan ALL changes before writing any code. Decide which files and which lines.
4. Make changes with edit_file (small) or write_file (large).
5. If changing backend routes, grep frontend for affected apiCall URLs.
6. Run syntax check: shell("node -e \"new Function(require('fs').readFileSync('backend/routes.js','utf8'))\"") BEFORE deploy.
7. Call done().
IMPORTANT: Do NOT call telegram_api(setMyDescription) during updates — only set bot description on first build.

BOT-SIDE UPDATES (commands, /start params, callbacks, push):
- If the user wants to add/change bot commands, /start <param> handling, callback buttons,
  push notifications, or anything that runs INSIDE the bot (not in the Mini App) →
  load_skill('bot-management') BEFORE writing code. Pattern depends on what's needed:
  pure menu config (setMyCommands) is one tool call; actual command replies need a
  route in routes.js with the EXACT path: router.post("/bot-webhook", ...). Any other
  path (/webhook, /bot/webhook, /tg-webhook, etc.) silently breaks — see the
  "BOT WEBHOOK — ABSOLUTE RULE" block above.
- BEFORE you finish, grep routes.js for the literal string "/bot-webhook" to confirm
  the path is correct. If you find "/webhook" or any other variant in a router.post
  intended for Telegram updates, RENAME it to "/bot-webhook" immediately.
- After adding/changing /bot-webhook or commands, ALWAYS run telegram_api("getWebhookInfo", {})
  and confirm result.last_error_message is null. If not null, read server_logs and fix.

AFTER WRITING CODE — DO NOT RE-READ:
- After a successful edit_file or write_file, the confirmation ("OK: Replaced 1 occurrence" / "OK: Written N lines") proves the change was applied. Do NOT re-read the same file to "verify" your edit.
- Only re-read a file if you need the EXACT current content for a SUBSEQUENT edit_file on that same file (because old_string must match current content).
- If you're done editing a file, move on to the next file or task. Never read a file just to confirm it looks right.

TOKEN BUDGET RULE:
You have a limited token budget. Every unnecessary grep, read_file, or shell command
costs ~3000+ tokens per round trip. A typical update should take 15-35 iterations.
If you're at iteration 40+ without writing code, something is wrong — start writing.

TESTING WITH http_request:
- Auth-protected endpoints (those using getUserId/initData) will ALWAYS return 401
  when tested from http_request because you don't have valid initData.
  DO NOT test these — it wastes iterations. The 401 proves nothing.
- ONLY test: unauthenticated endpoints, static file serving, or endpoints you
  can call with valid test data.
- ALWAYS run syntax check on routes.js and app.js BEFORE deploy_to_dev.
- deploy_to_dev is mainly for the USER to visually verify — not for your http_request tests.

ASKING THE USER (ask_user tool):
- Use ask_user ONLY when you need information the user MUST provide: API keys, credentials, external account IDs, or a choice between fundamentally different approaches where guessing wrong wastes significant effort.
- NEVER use ask_user for implementation details, design choices, styling, naming, or anything you can decide yourself.
- NEVER call ask_user in parallel with other tools — it must be the ONLY tool in its turn.
- Always provide clear options as buttons when the question has a finite set of answers.
- If the user clicks Skip or doesn't answer, proceed with the best default.

PROGRESS REPORTING:
- FIRST call create_todo() with your task breakdown (2-8 short actionable items). This creates a live checklist the user sees.
- After completing each task, call check_todo(id) with the task number (1-based).
- Call check_todo in parallel with other tool calls — it costs nothing.
- Call done() ONLY after ALL checklist tasks are checked off.
- You may also call set_progress(percent, message) for fine-grained status updates between checklist items.
- MANDATORY final tasks are always appended to your checklist: deploy & test, then finish with done().

PARALLEL TOOL CALLS — USE AGGRESSIVELY:
- Read multiple files at once: read_file(routes.js) + read_file(app.js) + read_file(styles.css) in ONE turn
- Write related files together: write_file(index.html) + write_file(styles.css) in ONE turn
- Initialize multiple db keys: db(set, 'users', []) + db(set, 'settings', {}) in ONE turn
- Test multiple endpoints: http_request(GET /user) + http_request(GET /leaderboard) in ONE turn
- Configure bot: telegram_api(setMyDescription) + telegram_api(setChatMenuButton) in ONE turn
- NEVER make 1 tool call when you could make 2-5 independent calls in the same turn
- check_todo calls are FREE — always batch them with other tool calls, never alone

MANDATORY PARALLELISM EXAMPLES:
WRONG (5 iterations):
  Turn 1: grep("register") → Turn 2: grep("start_param") → Turn 3: grep("deposit")
  → Turn 4: read_file(routes.js:2015) → Turn 5: read_file(app.js:1238)
RIGHT (1-2 iterations):
  Turn 1: grep("register") + grep("start_param") + grep("deposit") +
           read_file(routes.js, offset=2015, limit=50) + read_file(app.js, offset=1238, limit=20)

${FRONTEND_DESIGN_SKILL ? "FRONTEND DESIGN SKILL (apply when creating or redesigning the app UI — build distinctive, production-grade interfaces):\n" + FRONTEND_DESIGN_SKILL : ""}

${FRONTEND_SKILL ? "FRONTEND PATTERNS REFERENCE:\n" + FRONTEND_SKILL : ""}

${BACKEND_SKILL ? "BACKEND PATTERNS REFERENCE:\n" + BACKEND_SKILL : ""}`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: "list_files",
    description: "List all files in the project directory with sizes. Returns lines like 'frontend/app.js (340 lines, 12KB)'.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "read_file",
    description: "Read a file from the project. Supports optional line range to read only specific lines (1-indexed). Returns numbered lines.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "File path relative to project root" },
        offset: { type: "number" as const, description: "Start line number (1-indexed, optional)" },
        limit: { type: "number" as const, description: "Number of lines to read (optional)" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with complete content. Use for new files or full rewrites. For small changes, prefer edit_file.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "File path relative to project root" },
        content: { type: "string" as const, description: "Complete file content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Edit a file by replacing an exact string with new content. Much cheaper than rewriting the whole file. Use replace_all to replace every occurrence.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "File path relative to project root" },
        old_string: { type: "string" as const, description: "Exact string to find (must be unique in file unless replace_all)" },
        new_string: { type: "string" as const, description: "Replacement string" },
        replace_all: { type: "boolean" as const, description: "Replace all occurrences (default false)" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "grep",
    description: "Search for a pattern in project files. Returns matching lines with file:line format. Supports regex.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string" as const, description: "Search pattern (regex supported)" },
        path: { type: "string" as const, description: "Relative path to search in (default: entire project)" },
        include: { type: "string" as const, description: "File glob filter, e.g. '*.js' or '*.html'" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "shell",
    description: "Execute a shell command in the project directory. Use for npm install, node scripts, curl, ls, find, wc, diff, etc. Timeout: 30s.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string" as const, description: "Shell command to execute" },
      },
      required: ["command"],
    },
  },
  {
    name: "http_request",
    description: "Make an HTTP request. Use to test API endpoints, fetch external resources, etc. Timeout: 10s.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string" as const, description: "Full URL" },
        method: { type: "string" as const, description: "HTTP method (GET, POST, PUT, DELETE). Default: GET" },
        headers: { type: "object" as const, description: "Request headers (optional)" },
        body: { type: "string" as const, description: "Request body as string (optional)" },
      },
      required: ["url"],
    },
  },
  {
    name: "db",
    description: "Read/write project database (JSON key-value store backed by SQLite). get(key) returns parsed JSON or null. set(key, value) stores any JSON value. delete(key) removes a key. keys() lists all keys.",
    input_schema: {
      type: "object" as const,
      properties: {
        operation: { type: "string" as const, enum: ["get", "set", "delete", "keys"], description: "Operation to perform" },
        key: { type: "string" as const, description: "Key name, e.g. 'users', 'settings', 'scores'" },
        value: { description: "Value to store (any JSON — object, array, string, number). Required for 'set'." },
      },
      required: ["operation"],
    },
  },
  {
    name: "telegram_api",
    description: "Call Telegram Bot API method using the project's bot token.",
    input_schema: {
      type: "object" as const,
      properties: {
        method: { type: "string" as const, description: "API method name, e.g. 'setMyDescription'" },
        params: { type: "object" as const, description: "Method parameters as JSON object" },
      },
      required: ["method", "params"],
    },
  },
  {
    name: "fetch_url",
    description: "Fetch a web page or API documentation URL and return its text content (HTML tags stripped). Use to read API docs, READMEs, examples, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string" as const, description: "URL to fetch" },
      },
      required: ["url"],
    },
  },
  {
    name: "load_skill",
    description: `Load a skill file with code patterns and best practices. Available skills: ${getAvailableSkills().join(", ")}`,
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "Skill name to load" },
      },
      required: ["name"],
    },
  },
  {
    name: "server_logs",
    description: "Read recent server logs (last N lines). Use to see console.log/console.error output from your backend routes.js, API errors, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        lines: { type: "number" as const, description: "Number of recent log lines to read (default 30, max 100)" },
      },
      required: [],
    },
  },
  {
    name: "ask_user",
    description: "Ask the app owner a question and wait for their answer. Use ONLY when you truly need user input (API keys, credentials, choosing between fundamentally different approaches). Do NOT use for trivial or implementation decisions you can make yourself. Provide options as buttons when possible. The user can also type free text or press Skip.",
    input_schema: {
      type: "object" as const,
      properties: {
        question: { type: "string" as const, description: "The question to ask the user" },
        options: { type: "array" as const, items: { type: "string" as const }, description: "Optional list of choices shown as buttons (e.g. ['Option A', 'Option B'])" },
      },
      required: ["question"],
    },
  },
  {
    name: "set_progress",
    description: "Report your approximate progress as a percentage (0-100). Call this periodically so the user sees a progress bar. Example: 10% after reading files, 30% after writing HTML, 60% after backend, 80% after testing, 95% before done.",
    input_schema: {
      type: "object" as const,
      properties: {
        percent: { type: "number" as const, description: "Progress percentage 0-100" },
        message: { type: "string" as const, description: "Short status message, e.g. 'Writing frontend code'" },
      },
      required: ["percent"],
    },
  },
  {
    name: "create_todo",
    description: "Create your task checklist. Call this FIRST before starting any work. Break down the request into concrete, actionable items. The user sees this as a live checklist.",
    input_schema: {
      type: "object" as const,
      properties: {
        items: { type: "array" as const, items: { type: "string" as const }, description: "Array of short, actionable task descriptions (2-8 items)" },
      },
      required: ["items"],
    },
  },
  {
    name: "check_todo",
    description: "Mark a checklist item as done. Call this after completing each task from your checklist. The user sees a live checklist that updates when you call this.",
    input_schema: {
      type: "object" as const,
      properties: {
        id: { type: "number" as const, description: "Task ID (1-based index from your checklist)" },
      },
      required: ["id"],
    },
  },
  {
    name: "deploy_to_dev",
    description: "Deploy your current code to the development environment for live testing. After calling this, your frontend is available at /dev/{projectId}/ and API at /devapi/{projectId}/. Call this BEFORE testing with http_request.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "short_summary",
    description: "Write a short user-facing summary of this update. Call this AFTER deploy & test, BEFORE done(). Format: 'Update title (3-5 words)\\n\\n1-2 sentences in simple non-technical language.' No jargon.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: { type: "string" as const, description: "Short user-facing summary (no technical jargon)" },
      },
      required: ["text"],
    },
  },
  {
    name: "summary",
    description: "Write a detailed technical summary/changelog. Call this AFTER short_summary, BEFORE done(). Include architecture decisions, new files, changes made, and anything the next update should know.",
    input_schema: {
      type: "object" as const,
      properties: {
        text: { type: "string" as const, description: "Detailed technical summary of all changes" },
      },
      required: ["text"],
    },
  },
  {
    name: "done",
    description: "Signal that the update is complete. You MUST call short_summary() and summary() before calling this.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// Commands that must never run
const BLOCKED_COMMANDS = [
  "rm -rf /", "shutdown", "reboot", "mkfs", "dd if=",
  "chmod 777 /", "chown", "passwd", "useradd", "userdel",
  "systemctl", "service ", "kill -9 1", "pkill",
];

export interface AgentProgress {
  action: string;
  detail: string;
  percent?: number;
  costUsd?: number;
  balance?: number;
}

export class AgentAbortedError extends Error {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  model: string;
  constructor(model: string, inputTokens: number, outputTokens: number, cacheWriteTokens: number, cacheReadTokens: number) {
    super("ABORTED");
    this.model = model;
    this.inputTokens = inputTokens;
    this.outputTokens = outputTokens;
    this.cacheWriteTokens = cacheWriteTokens;
    this.cacheReadTokens = cacheReadTokens;
  }
}

export interface AgentResult {
  summary: string;
  shortSummary: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  logPath?: string;
  commitNum?: number;
  commitDir?: string;
}

export const QUALITY_TIERS: Record<number, { model: string; thinking: number; maxIterations: number }> = {
  1: { model: "claude-sonnet-4-6", thinking: 2000, maxIterations: 100 },
  2: { model: "claude-sonnet-4-6", thinking: 4000, maxIterations: 140 },
  3: { model: "claude-opus-4-7", thinking: 2000, maxIterations: 100 },
  4: { model: "claude-opus-4-7", thinking: 4000, maxIterations: 140 },
};

export class AgentService {
  private client: Anthropic;

  constructor() {
    this.client = new Anthropic({ apiKey: config.anthropicApiKey });
  }

  private async callWithRetry(params: any, maxRetries = 3): Promise<Anthropic.Message> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const stream = this.client.messages.stream(params);
        return await stream.finalMessage();
      } catch (err: any) {
        const status = err?.status || err?.error?.status;
        if (status === 429 && attempt < maxRetries) {
          const retryAfter = parseInt(err?.headers?.["retry-after"] || "0", 10);
          const delay = retryAfter > 0
            ? retryAfter * 1000
            : Math.min(2000 * Math.pow(2, attempt), 30000);
          console.log(`[Agent] Rate limited (429). Retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error("Max retries exceeded");
  }

  private async buildFeatureGating(projectId: string): Promise<string> {
    const features = await getProjectFeatures(projectId);
    const project = await projectService.getProject(projectId);
    const starsStatus = features.includes("stars_payment")
      ? "UNLOCKED — you may implement Telegram Stars / XTR payment logic"
      : "LOCKED — do NOT implement any Telegram Stars / XTR payment logic. If the user asks for it, respond that they need to purchase this feature first.";
    let tonStatus: string;
    if (features.includes("ton_payment")) {
      const wallet = project?.tonWallet || "NOT SET";
      tonStatus = `UNLOCKED — you may implement TON payment logic. Use load_skill('ton-payments') for full implementation patterns. Wallet address: ${wallet}`;
    } else {
      tonStatus = "LOCKED — do NOT implement any TON / blockchain payment logic. If the user asks for it, respond that they need to purchase this feature first.";
    }
    return `\nPAID FEATURES STATUS:\n- Stars Payment System: ${starsStatus}\n- TON Payment System: ${tonStatus}\n`;
  }


  async answerQuestionStream(
    projectId: string,
    question: string,
    onChunk: (text: string, fullText: string) => void,
    lastUpdate?: string,
    appDescription?: string,
    conversationHistory?: { role: "user" | "assistant"; content: string }[],
    lang?: string,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const project: any = await projectService.getProject(projectId);
    const context = this.loadLatestContext(projectId)
      || project?.projectSummary
      || "No project context available.";

    const dbSummary = this.getDbSummary(projectId);
    const description = appDescription || project?.description || "";

    const langInstruction = lang === "ru" ? "\nAlways reply in Russian."
      : lang === "ua" ? "\nAlways reply in Ukrainian."
      : "";

    const systemPrompt = `You are a friendly assistant helping an app owner (non-technical person) understand their Telegram Mini App.
Answer in simple, everyday language. NO programming terms, NO code, NO file names, NO technical jargon.
Talk as if explaining to a friend who doesn't know anything about coding.
Use markdown formatting: **bold**, lists (- item), headings (## Title) to keep it readable.
If the question is about app data/users/stats, give clear numbers and insights.
Keep answers concise and actionable.${langInstruction}

APP DESCRIPTION:
${description.substring(0, 2000)}

PROJECT CONTEXT:
${context.substring(0, 6000)}

${lastUpdate ? `LAST UPDATE SUMMARY:\n${lastUpdate.substring(0, 2000)}\n` : ""}
${dbSummary ? `DB KEYS SUMMARY:\n${dbSummary}\n` : ""}`;

    const messages: { role: "user" | "assistant"; content: string }[] = [];
    if (conversationHistory && conversationHistory.length > 0) {
      for (const msg of conversationHistory) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
    messages.push({ role: "user", content: question });

    const stream = this.client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: systemPrompt,
      messages,
    });

    let fullText = "";
    stream.on("text", (chunk) => {
      fullText += chunk;
      onChunk(chunk, fullText);
    });

    const finalMessage = await stream.finalMessage();
    const text = finalMessage.content[0]?.type === "text" ? finalMessage.content[0].text : fullText || "Unable to answer.";
    return {
      text,
      inputTokens: finalMessage.usage?.input_tokens || 0,
      outputTokens: finalMessage.usage?.output_tokens || 0,
    };
  }

  async getSuggestions(projectId: string, lang?: string): Promise<{ title: string; description: string }[]> {
    const project: any = await projectService.getProject(projectId);
    const context = this.loadLatestContext(projectId)
      || project?.projectSummary
      || "No project context available.";

    const dbSummary = this.getDbSummary(projectId);
    const description = project?.description || "";

    const langInstruction = lang === "ru" ? "\nWrite all titles and descriptions in Russian."
      : lang === "ua" ? "\nWrite all titles and descriptions in Ukrainian."
      : "";

    const prompt = `You are a product advisor for a Telegram Mini App. Analyze the current app and suggest 5 practical improvements the owner could make next.

APP DESCRIPTION:
${description.substring(0, 2000)}

PROJECT CONTEXT:
${context.substring(0, 8000)}

${dbSummary ? `DB KEYS SUMMARY:\n${dbSummary}\n` : ""}

Return EXACTLY a JSON array of 5 objects, each with "title" (short, 3-8 words) and "description" (1-2 sentences, simple non-technical language explaining the benefit for users). No markdown, no code blocks, just raw JSON array.

Focus on:
- UX improvements
- New features users would love
- Design/visual enhancements
- Performance or usability fixes
- Engagement or retention ideas

Keep suggestions practical and specific to THIS app.${langInstruction}`;

    const response = await this.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    try {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) return JSON.parse(match[0]);
    } catch {}
    return [{ title: "Improve your app", description: "Ask for a specific update to enhance your app." }];
  }

  private getDbSummary(projectId: string): string | null {
    try {
      const Database = require("better-sqlite3");
      const dbPath = path.join(PROJECTS_DIR, projectId, "development", "data", "app.db");
      if (!fs.existsSync(dbPath)) return null;
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare("SELECT key FROM kv").all() as any[];
      const keys = rows.map((r: any) => r.key);
      const summary: string[] = [`Keys (${keys.length}): ${keys.slice(0, 30).join(", ")}`];
      for (const key of keys.slice(0, 5)) {
        const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as any;
        if (row) {
          const val = row.value.substring(0, 200);
          summary.push(`  ${key}: ${val}${row.value.length > 200 ? "..." : ""}`);
        }
      }
      db.close();
      return summary.join("\n");
    } catch { return null; }
  }

  async buildApp(
    projectId: string,
    description: string,
    plan: string,
    onProgress?: (p: AgentProgress) => Promise<void>,
    onAskUser?: (question: string, options: string[]) => Promise<string>,
    onCreateTodo?: (items: string[]) => Promise<void>,
    onCheckTodo?: (id: number) => Promise<void>,
    lang?: string,
    userBalance?: number,
  ): Promise<AgentResult> {
    const featureGating = await this.buildFeatureGating(projectId);
    const langInstruction = lang && lang !== "en"
      ? `\n\nIMPORTANT: All user-facing text in the app (UI labels, buttons, messages, placeholders, titles) must be written in ${lang === "ru" ? "Russian" : "Ukrainian"}. The code, comments, and variable names should stay in English.`
      : "";

    const prompt = `Build a complete Telegram Mini App from scratch.

Project ID: ${projectId}
Dev Frontend URL: ${config.baseUrl}/dev/${projectId}/
Dev API URL: ${config.baseUrl}/devapi/${projectId}/
Production App URL: ${config.baseUrl}/app/${projectId}/

Description: ${description}

Plan:
${plan}
${featureGating}
Create all necessary files (frontend/index.html, frontend/styles.css, frontend/app.js, backend/routes.js) and configure the bot. Database is handled via db.get/db.set in routes.js — no schema setup needed. Make it beautiful and functional. Use deploy_to_dev() to deploy and test your code via the Dev URLs. In frontend code, use /api/${projectId}/ as the API base URL (this will be rewritten to /devapi/ in dev mode automatically).${langInstruction}`;

    return this.runAgent(projectId, prompt, onProgress, onAskUser, onCreateTodo, onCheckTodo, userBalance);
  }

  async updateApp(
    projectId: string,
    updateDescription: string,
    onProgress?: (p: AgentProgress) => Promise<void>,
    attachments?: { localPath: string; projectPath: string; originalName: string; caption?: string }[],
    onAskUser?: (question: string, options: string[]) => Promise<string>,
    onCreateTodo?: (items: string[]) => Promise<void>,
    onCheckTodo?: (id: number) => Promise<void>,
    lang?: string,
    userBalance?: number,
  ): Promise<AgentResult> {
    const project: any = await projectService.getProject(projectId);
    const contextParts: string[] = [];

    // Determine current commit number for context decisions
    let currentCommitNum = 0;
    try {
      const commitsDir = path.join(PROJECTS_DIR, projectId, "commits");
      if (fs.existsSync(commitsDir)) {
        const nums = fs.readdirSync(commitsDir).map(Number).filter(n => !isNaN(n));
        if (nums.length > 0) currentCommitNum = Math.max(...nums);
      }
    } catch {}

    // Load structured context from latest commit
    const latestContext = this.loadLatestContext(projectId);
    if (latestContext) {
      const maxContextChars = 64000; // ~4000 tokens
      const truncated = latestContext.length > maxContextChars
        ? latestContext.substring(0, maxContextChars) + "\n...[context truncated]"
        : latestContext;
      contextParts.push(`PROJECT CONTEXT:\n${truncated}`);
    } else if (project?.projectSummary) {
      contextParts.push(`PROJECT CONTEXT (from previous builds):\n${project.projectSummary}`);
    }
    // Only include original plan for the first few updates — it becomes stale
    if (project?.plan && currentCommitNum <= 3) {
      contextParts.push(`ORIGINAL PLAN:\n${project.plan}`);
    }

    let attachmentInfo = "";
    if (attachments && attachments.length > 0) {
      const lines = attachments.map(a =>
        `- ${a.projectPath} (original: ${a.originalName})${a.caption ? ` — "${a.caption}"` : ""}`
      );
      attachmentInfo = `\nATTACHED FILES (already saved to project):\n${lines.join("\n")}\nThe user uploaded these files for you to use in the app. Reference them in your code (e.g. in <img src="assets/filename.jpg"> or as needed). Use read_file to inspect non-image files if needed.\n`;
    }

    const context = contextParts.length > 0 ? contextParts.join("\n\n") + "\n\n" : "";

    const featureGating = await this.buildFeatureGating(projectId);

    const langInstruction = lang && lang !== "en"
      ? `\n\nIMPORTANT: All user-facing text in the app (UI labels, buttons, messages, placeholders, titles) must be written in ${lang === "ru" ? "Russian" : "Ukrainian"}. The code, comments, and variable names should stay in English.`
      : "";

    const prompt = `Update an existing Telegram Mini App.

Project ID: ${projectId}
Dev Frontend URL: ${config.baseUrl}/dev/${projectId}/
Dev API URL: ${config.baseUrl}/devapi/${projectId}/
Production App URL: ${config.baseUrl}/app/${projectId}/

${context}Update request: ${updateDescription}
${attachmentInfo}${featureGating}
Use grep and read_file to verify current state before making changes. Use edit_file for targeted modifications. Use deploy_to_dev() to deploy and test your changes via the Dev URLs.${langInstruction}`;

    return this.runAgent(projectId, prompt, onProgress, onAskUser, onCreateTodo, onCheckTodo, userBalance, attachments);
  }

  private async runAgent(
    projectId: string,
    userPrompt: string,
    onProgress?: (p: AgentProgress) => Promise<void>,
    onAskUser?: (question: string, options: string[]) => Promise<string>,
    onCreateTodo?: (items: string[]) => Promise<void>,
    onCheckTodo?: (id: number) => Promise<void>,
    userBalance?: number,
    attachments?: { localPath: string; projectPath: string; originalName: string; caption?: string }[],
  ): Promise<AgentResult> {
    let liveCostUsd = 0;
    const startBalance = userBalance ?? 0;
    const rawProgress = onProgress || (async () => {});
    const progress = async (p: AgentProgress) => {
      p.costUsd = liveCostUsd;
      p.balance = startBalance > 0 ? Math.max(0, startBalance - liveCostUsd) : undefined;
      return rawProgress(p);
    };
    const projectRootDir = path.join(PROJECTS_DIR, projectId);

    // Prepare commit folder — agent works inside commits/N/
    const { commitDir, commitNum } = await commitService.prepareCommitFolder(projectId);
    const projectDir = commitDir;

    fs.mkdirSync(path.join(projectDir, "frontend"), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "backend"), { recursive: true });

    // Ensure development/ exists with data/ for DB
    fs.mkdirSync(path.join(projectRootDir, "development", "data"), { recursive: true });

    const logger = new AgentLogger(projectId);

    let botToken = "";
    let qualityTier = 1;
    try {
      const project = await projectService.getProject(projectId);
      if (project?.botTokenEncrypted) {
        botToken = decryptToken(project.botTokenEncrypted);
      }
      qualityTier = (project as any)?.qualityTier || 1;
    } catch {}

    const tierConfig = QUALITY_TIERS[qualityTier] || QUALITY_TIERS[1];

    let finalPrompt = userPrompt;
    const checklistDone = new Set<number>();
    let checklist: string[] = [];
    const mandatoryTasks = [
      "Deploy & test: call deploy_to_dev(), verify key endpoints with http_request.",
      "Summarize: call short_summary() then summary() then done().",
    ];
    finalPrompt += `\n\nFIRST STEP: Call create_todo() with your task breakdown before starting any work. Your last 2 tasks will always be auto-appended: deploy & test, then summarize & finish.
FINAL STEPS ORDER: After all work is done → short_summary(user-facing text) → summary(detailed technical changelog) → done(). Never set progress to 100% before calling short_summary and summary.`;

    logger.header(tierConfig.model, finalPrompt);

    const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
    const MIME_MAP: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
    const imageBlocks: any[] = [];
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        const ext = path.extname(att.originalName).toLowerCase();
        if (IMAGE_EXTS.has(ext) && fs.existsSync(att.localPath)) {
          try {
            const data = fs.readFileSync(att.localPath).toString("base64");
            imageBlocks.push({
              type: "image",
              source: { type: "base64", media_type: MIME_MAP[ext] || "image/png", data },
            });
            console.log(`[Agent] 🖼️ Attached image for vision: ${att.originalName} (${ext})`);
          } catch (err) {
            console.error(`[Agent] Failed to read image ${att.localPath}:`, err);
          }
        }
      }
    }

    const firstMessageContent: any = imageBlocks.length > 0
      ? [...imageBlocks, { type: "text", text: finalPrompt }]
      : finalPrompt;

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: firstMessageContent },
    ];

    let summary = "";
    let shortSummary = "";
    let iterations = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheWriteTokens = 0;
    let totalCacheReadTokens = 0;
    let currentPercent: number | undefined;
    let deployCount = 0;

    const maxIterations = tierConfig.maxIterations;
    while (iterations < maxIterations) {
      if (abortedProjects.has(projectId)) {
        abortedProjects.delete(projectId);
        logger.done("ABORTED by user", iterations, totalInputTokens, totalOutputTokens);
        console.log(`[Agent] ⛔ Aborted by user after ${iterations} iterations | Tokens: in=${totalInputTokens} out=${totalOutputTokens}`);
        throw new AgentAbortedError(tierConfig.model, totalInputTokens, totalOutputTokens, totalCacheWriteTokens, totalCacheReadTokens);
      }
      iterations++;

      const response = await this.callWithRetry({
        model: tierConfig.model,
        max_tokens: tierConfig.thinking + 16000,
        thinking: { type: "enabled", budget_tokens: tierConfig.thinking },
        system: AGENT_SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
        cache_control: { type: "ephemeral" },
      } as any);

      const usage = response.usage as any;
      const iterIn = usage?.input_tokens || 0;
      const iterOut = usage?.output_tokens || 0;
      const cached = usage?.cache_read_input_tokens || 0;
      const cacheCreated = usage?.cache_creation_input_tokens || 0;
      totalInputTokens += iterIn;
      totalOutputTokens += iterOut;
      totalCacheReadTokens += cached;
      totalCacheWriteTokens += cacheCreated;
      if (cached > 0 || cacheCreated > 0) {
        console.log(`[Agent] 💾 Cache: ${cached} read, ${cacheCreated} written`);
      }

      const pricing = MODEL_PRICING[tierConfig.model] || MODEL_PRICING["claude-sonnet-4-6"];
      liveCostUsd =
        (totalInputTokens * pricing.input +
        totalOutputTokens * pricing.output +
        totalCacheWriteTokens * pricing.cache_write +
        totalCacheReadTokens * pricing.cache_read) *
        runtimeConfig.getMarkupMultiplier();

      const assistantContent: Anthropic.ContentBlock[] = response.content;
      messages.push({ role: "assistant", content: assistantContent });

      logger.iteration(iterations, tierConfig.model);
      logger.tokens(totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens, iterIn, iterOut, cached, cacheCreated, liveCostUsd);

      const thinkingBlocks = assistantContent.filter(b => (b as any).type === "thinking");
      const textBlocks = assistantContent.filter(b => b.type === "text");
      const toolBlocks = assistantContent.filter(b => b.type === "tool_use");
      for (const tb of thinkingBlocks) {
        const thinking = (tb as any).thinking || "";
        if (thinking.trim()) {
          logger.thinking(thinking);
          console.log(`[Agent] 🧠 Thinking: ${thinking.substring(0, 300).replace(/\n/g, " ")}${thinking.length > 300 ? "..." : ""}`);
        }
      }
      for (const tb of textBlocks) {
        if (tb.type === "text" && tb.text.trim()) {
          logger.claudeMessage(tb.text);
          console.log(`[Agent] 💬 Claude says: ${tb.text.substring(0, 500)}`);
        }
      }
      if (toolBlocks.length > 0) {
        const toolNames = toolBlocks.map(b => b.type === "tool_use" ? b.name : "").join(", ");
        console.log(`[Agent] 🔧 Iteration ${iterations} | Tools: [${toolNames}] | Tokens so far: in=${totalInputTokens} out=${totalOutputTokens} | stop=${response.stop_reason}`);
      }

      if (response.stop_reason === "end_turn" || !assistantContent.some(b => b.type === "tool_use")) {
        const textBlock = assistantContent.find(b => b.type === "text");
        if (textBlock && textBlock.type === "text") {
          summary = textBlock.text;
        }
        logger.done(summary, iterations, totalInputTokens, totalOutputTokens);
        console.log(`[Agent] ⏹️ Agent finished after ${iterations} iterations | Total tokens: in=${totalInputTokens} out=${totalOutputTokens}`);
        break;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of assistantContent) {
        if (block.type !== "tool_use") continue;

        const { id, name, input } = block;
        const args = input as any;
        let result = "";
        const argsSummary = this.summarizeArgs(name, args);
        logger.toolCall(name, args);

        try {
          switch (name) {
            case "list_files": {
              await progress({ action: "📂 Scanning files", detail: "", percent: currentPercent });
              const files = this.walkDirWithStats(projectDir, projectDir);
              result = files.length > 0 ? files.join("\n") : "(empty project)";
              break;
            }

            case "read_file": {
              const filePath = this.safePath(projectDir, args.path);
              if (!filePath) { result = "Error: Invalid path"; break; }
              if (!fs.existsSync(filePath)) { result = "Error: File not found"; break; }
              const content = fs.readFileSync(filePath, "utf-8");
              const lines = content.split("\n");

              if (args.offset || args.limit) {
                const start = Math.max(0, (args.offset || 1) - 1);
                const end = args.limit ? start + args.limit : lines.length;
                const slice = lines.slice(start, end);
                result = slice.map((l, i) => `${start + i + 1}|${l}`).join("\n");
                await progress({ action: "📖 Reading", detail: `${args.path} lines ${start + 1}-${Math.min(end, lines.length)}`, percent: currentPercent });
              } else {
                result = lines.map((l, i) => `${i + 1}|${l}`).join("\n");
                await progress({ action: "📖 Reading", detail: args.path, percent: currentPercent });
              }
              break;
            }

            case "write_file": {
              if (this.isProtectedPath(args.path)) { result = "Error: You can only write to frontend/ and backend/ directories."; break; }
              const filePath = this.safePath(projectDir, args.path);
              if (!filePath) { result = "Error: Invalid path"; break; }
              if (typeof args.content !== "string" || args.content.length === 0) {
                result = "Error: Content is empty or missing (likely truncated by max_tokens). Try writing a smaller file or use edit_file for targeted changes.";
                break;
              }
              fs.mkdirSync(path.dirname(filePath), { recursive: true });
              fs.writeFileSync(filePath, args.content, "utf-8");
              const lineCount = args.content.split("\n").length;
              result = `OK: Written ${lineCount} lines to ${args.path}`;
              await progress({ action: "✏️ Writing", detail: args.path, percent: currentPercent });
              break;
            }

            case "edit_file": {
              if (this.isProtectedPath(args.path)) { result = "Error: You can only edit files in frontend/ and backend/ directories."; break; }
              const filePath = this.safePath(projectDir, args.path);
              if (!filePath) { result = "Error: Invalid path"; break; }
              if (!fs.existsSync(filePath)) { result = "Error: File not found"; break; }

              let content = fs.readFileSync(filePath, "utf-8");
              const oldStr: string = args.old_string;
              const newStr: string = args.new_string;

              if (!content.includes(oldStr)) {
                result = "Error: old_string not found in file";
                break;
              }

              if (args.replace_all) {
                const count = content.split(oldStr).length - 1;
                content = content.split(oldStr).join(newStr);
                fs.writeFileSync(filePath, content, "utf-8");
                result = `OK: Replaced ${count} occurrence(s) in ${args.path}`;
              } else {
                content = content.replace(oldStr, newStr);
                fs.writeFileSync(filePath, content, "utf-8");
                result = `OK: Replaced 1 occurrence in ${args.path}`;
              }
              await progress({ action: "✏️ Editing", detail: args.path, percent: currentPercent });
              break;
            }

            case "grep": {
              await progress({ action: "🔍 Searching", detail: args.pattern, percent: currentPercent });
              try {
                const resolvedPath = args.path ? this.safePath(projectDir, args.path) : null;
                if (args.path && !resolvedPath) { result = "Error: Invalid path"; break; }

                let cwd = projectDir;
                let target = ".";

                if (resolvedPath) {
                  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isFile()) {
                    cwd = path.dirname(resolvedPath);
                    target = path.basename(resolvedPath);
                  } else {
                    cwd = resolvedPath;
                  }
                }

                const escapedPattern = args.pattern.replace(/"/g, '\\"');
                let cmd = args.include
                  ? `grep -rEn --include="${args.include}" "${escapedPattern}" ${target}`
                  : `grep -rEn "${escapedPattern}" ${target}`;

                const { stdout } = await execAsync(cmd, {
                  cwd,
                  timeout: 10000,
                  maxBuffer: 512 * 1024,
                });
                const lines = stdout.split("\n").filter(l => l.trim()).slice(0, 50);
                result = lines.length > 0 ? lines.join("\n") : "No matches found";
              } catch (err: any) {
                if (err.code === 1) {
                  result = "No matches found";
                } else {
                  result = `Error: ${(err.stderr || err.message || "grep failed").substring(0, 1000)}`;
                }
              }
              break;
            }

            case "shell": {
              const cmd: string = args.command;
              if (BLOCKED_COMMANDS.some(b => cmd.includes(b))) {
                result = "Error: Command blocked for safety";
                break;
              }
              await progress({ action: "⚡ Running system commands...", detail: "", percent: currentPercent });
              try {
                const { stdout } = await execAsync(cmd, {
                  cwd: projectDir,
                  timeout: 30000,
                  maxBuffer: 1024 * 1024,
                  env: { ...process.env, HOME: projectDir, NODE_ENV: "development" },
                });
                result = (stdout || "(no output)").substring(0, 10000);
              } catch (err: any) {
                const stderr = err.stderr || "";
                const stdout = err.stdout || "";
                result = `Exit code ${err.code || 1}:\n${(stderr + stdout || err.message).substring(0, 5000)}`;
              }
              break;
            }

            case "http_request": {
              await progress({ action: "🌐 Testing server...", detail: "", percent: currentPercent });
              try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 10000);

                const resp = await fetch(args.url, {
                  method: (args.method || "GET").toUpperCase(),
                  headers: args.headers || {},
                  body: args.body || undefined,
                  signal: controller.signal,
                });
                clearTimeout(timeout);

                const body = await resp.text();
                result = `HTTP ${resp.status} ${resp.statusText}\n${body.substring(0, 5000)}`;
              } catch (err: any) {
                result = `Error: ${err.message}`;
                console.error(`[Agent] http_request error:`, err.message);
              }
              break;
            }

            case "fetch_url": {
              await progress({ action: "🔗 Fetching data...", detail: "", percent: currentPercent });
              try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 15000);

                const resp = await fetch(args.url, {
                  headers: { "User-Agent": "Mozilla/5.0 (compatible; AppsBot/1.0)" },
                  signal: controller.signal,
                });
                clearTimeout(timeout);

                const html = await resp.text();
                // Strip HTML tags, scripts, styles to get readable text
                const text = html
                  .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
                  .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
                  .replace(/<[^>]+>/g, " ")
                  .replace(/&nbsp;/g, " ")
                  .replace(/&amp;/g, "&")
                  .replace(/&lt;/g, "<")
                  .replace(/&gt;/g, ">")
                  .replace(/&quot;/g, '"')
                  .replace(/&#39;/g, "'")
                  .replace(/\s+/g, " ")
                  .trim();
                result = text.substring(0, 12000);
              } catch (err: any) {
                result = `Error: ${err.message}`;
                console.error(`[Agent] fetch_url error:`, err.message);
              }
              break;
            }

            case "db": {
              const op = args.operation;
              await progress({ action: "🗄️ Database", detail: `${op}(${args.key || ""})`, percent: currentPercent });
              try {
                const Database = require("better-sqlite3");
                const dataDir = path.join(projectRootDir, "development", "data");
                fs.mkdirSync(dataDir, { recursive: true });
                const sqlite = new Database(path.join(dataDir, "app.db"));
                sqlite.pragma("journal_mode = WAL");
                sqlite.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)");

                switch (op) {
                  case "get": {
                    const row = sqlite.prepare("SELECT value FROM kv WHERE key = ?").get(args.key);
                    result = row ? `OK: ${row.value.substring(0, 8000)}` : "OK: null";
                    break;
                  }
                  case "set": {
                    const val = JSON.stringify(args.value);
                    sqlite.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(args.key, val);
                    result = `OK: Stored ${val.length} bytes under "${args.key}"`;
                    break;
                  }
                  case "delete": {
                    sqlite.prepare("DELETE FROM kv WHERE key = ?").run(args.key);
                    result = `OK: Deleted "${args.key}"`;
                    break;
                  }
                  case "keys": {
                    const keys = sqlite.prepare("SELECT key FROM kv").all().map((r: any) => r.key);
                    result = `OK: [${keys.join(", ")}]`;
                    break;
                  }
                  default:
                    result = `Error: Unknown operation "${op}". Use get, set, delete, or keys.`;
                }
                sqlite.close();
              } catch (err: any) {
                result = `Error: ${err.message}`;
                console.error(`[Agent] db error:`, err.message);
              }
              break;
            }

            case "telegram_api": {
              if (!botToken) { result = "Error: No bot token available"; break; }
              await progress({ action: "🤖 Telegram API", detail: args.method, percent: currentPercent });
              try {
                const resp = await fetch(
                  `https://api.telegram.org/bot${botToken}/${args.method}`,
                  {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(args.params),
                  }
                );
                const data: any = await resp.json();
                result = JSON.stringify(data);
              } catch (err: any) {
                result = `Error: ${err.message}`;
                console.error(`[Agent] telegram_api error:`, err.message);
              }
              break;
            }

            case "deploy_to_dev": {
              deployCount++;
              if (deployCount > 2) {
                result = `DEPLOY LIMIT REACHED (${deployCount}/2). You have already deployed twice. Finish your work and call done() now. Do NOT deploy again.`;
                break;
              }
              await progress({ action: "🚀 Deploying to dev", detail: `(${deployCount}/2)`, percent: currentPercent });
              try {
                commitService.syncToDev(projectId, projectDir);
                // Force-reload the dev WS so background timers and game loops
                // pick up the new routes.js without requiring clients to reconnect.
                try { forceReloadProjectWs(projectId, true); } catch {}
                result = `OK: Code deployed to development environment (deploy ${deployCount}/2).\nTest frontend: ${config.baseUrl}/dev/${projectId}/\nTest API: ${config.baseUrl}/devapi/${projectId}/\nTest WS: wss://apps-father.com/devws/${projectId}`;
              } catch (err: any) {
                result = `Error deploying to dev: ${err.message}`;
              }
              break;
            }

            case "load_skill": {
              await progress({ action: "📚 Loading skill", detail: args.name, percent: currentPercent });
              const skillContent = loadSkill(args.name);
              result = skillContent || `Error: Skill "${args.name}" not found. Available: ${getAvailableSkills().join(", ")}`;
              break;
            }

            case "server_logs": {
              await progress({ action: "📋 Reading logs", detail: "", percent: currentPercent });
              try {
                const numLines = Math.min(args.lines || 30, 100);
                const { stdout } = await execAsync(`pm2 logs apps-father --lines ${numLines} --nostream 2>&1`, {
                  timeout: 5000,
                  maxBuffer: 512 * 1024,
                });
                result = stdout.substring(0, 8000);
              } catch (err: any) {
                result = `Error reading logs: ${err.message}`;
              }
              break;
            }

            case "ask_user": {
              const question = args.question || "Please provide input:";
              const options: string[] = args.options || [];

              if (!onAskUser) {
                result = "User interaction not available in this context. Make your best decision and continue.";
                break;
              }

              console.log(`[Agent] ❓ Asking user: ${question.substring(0, 100)}`);
              await progress({ action: "Waiting for your answer...", detail: question.substring(0, 80), percent: currentPercent });

              const ASK_TIMEOUT = 5 * 60 * 1000;
              let timeoutId: ReturnType<typeof setTimeout>;
              const answer = await Promise.race([
                onAskUser(question, options),
                new Promise<string>(resolve => {
                  timeoutId = setTimeout(() => resolve(""), ASK_TIMEOUT);
                }),
              ]);
              clearTimeout(timeoutId!);

              if (answer) {
                result = `User answered: ${answer}`;
                console.log(`[Agent] ✅ User answered: ${answer.substring(0, 100)}`);
              } else {
                result = "User skipped this question. Proceed with your best judgment.";
                console.log(`[Agent] ⏭️ User skipped question`);
              }
              break;
            }

            case "set_progress": {
              currentPercent = Math.max(0, Math.min(100, Math.round(args.percent)));
              const msg = args.message || "";
              result = `OK: Progress set to ${currentPercent}%`;
              await progress({ action: msg || "Working...", detail: "", percent: currentPercent });
              break;
            }

            case "create_todo": {
              const items = (args.items || []).filter((s: any) => typeof s === "string").slice(0, 10);
              const userItemCount = items.length;
              checklist = [...items, ...mandatoryTasks];
              checklistDone.clear();
              if (onCreateTodo) {
                try { await onCreateTodo(items); } catch {}
              }
              result = `OK: Checklist created with ${checklist.length} tasks (including mandatory deploy & finish steps). Use check_todo(id) to mark each done.`;
              console.log(`[Agent] 📋 create_todo: ${checklist.length} tasks (${userItemCount} user + ${mandatoryTasks.length} mandatory)`);
              break;
            }

            case "check_todo": {
              const todoId = Math.round(args.id);
              if (checklist.length > 0 && todoId >= 1 && todoId <= checklist.length) {
                checklistDone.add(todoId);
                const userItemCount = checklist.length - mandatoryTasks.length;
                if (onCheckTodo && todoId <= userItemCount) {
                  try { await onCheckTodo(todoId); } catch {}
                }
                result = `OK: Task ${todoId} marked as done (${checklistDone.size}/${checklist.length} completed)`;
                console.log(`[Agent] ✅ check_todo(${todoId}): "${checklist[todoId - 1]}" — ${checklistDone.size}/${checklist.length} done`);
              } else {
                result = `Error: Invalid task ID ${todoId}. ${checklist.length === 0 ? "Call create_todo first." : ""}`;
              }
              break;
            }

            case "short_summary": {
              shortSummary = args.text || "";
              result = "OK: Short summary saved.";
              console.log(`[Agent] 📝 short_summary: ${shortSummary.substring(0, 100)}`);
              break;
            }

            case "summary": {
              summary = args.text || "Changes applied";
              result = "OK: Summary saved. Now call done().";
              console.log(`[Agent] 📝 summary: ${summary.substring(0, 200)}`);
              break;
            }

            case "done": {
              if (!summary) summary = "Changes applied";
              if (!shortSummary) shortSummary = summary.split("\n")[0].substring(0, 200);
              currentPercent = 100;
              if (checklist.length > 0 && checklistDone.size < checklist.length) {
                const missing = checklist.filter((_, i) => !checklistDone.has(i + 1));
                console.log(`[Agent] ⚠️ done() called with ${checklist.length - checklistDone.size} unchecked tasks: ${missing.join(", ")}`);
              }
              console.log(`[Agent] ✅ Done after ${iterations} iterations | Total tokens: in=${totalInputTokens} out=${totalOutputTokens}`);

              if (botToken) {
                try {
                  const appUrl = `${config.baseUrl}/app/${projectId}/`;
                  await fetch(`https://api.telegram.org/bot${botToken}/setChatMenuButton`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      menu_button: { type: "web_app", text: "Launch App", web_app: { url: appUrl } },
                    }),
                  });
                } catch {}
              }

              try {
                const code = this.getProjectCode(projectDir);
                await projectService.storeGeneratedCode(projectId, code);
              } catch {}

              bustCache(projectDir);
              try { commitService.syncToDev(projectId, projectDir); } catch {}
              toolResults.push({ type: "tool_result", tool_use_id: id, content: "OK" });
              messages.push({ role: "user", content: toolResults });
              logger.done(summary, iterations, totalInputTokens, totalOutputTokens);
              const logFilePath = logger.getLogPath();
              logger.close();
              return { summary, shortSummary, model: tierConfig.model, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheWriteTokens: totalCacheWriteTokens, cacheReadTokens: totalCacheReadTokens, logPath: logFilePath, commitNum, commitDir };
            }

            default:
              result = `Error: Unknown tool ${name}`;
          }
        } catch (err: any) {
          result = `Error: ${err.message}`;
          console.error(`[Agent] ❌ Tool ${name} error:`, err.message);
        }

        logger.toolResult(name, result);
        console.log(`[Agent] 📥 ${name}(${argsSummary}) -> ${result.substring(0, 200).replace(/\n/g, "\\n")}${result.length > 200 ? "..." : ""}`);
        toolResults.push({ type: "tool_result", tool_use_id: id, content: result });
      }

      messages.push({ role: "user", content: toolResults });

      // this.pruneConversation(messages);

      // Metrics: log message sizes and detect stuck exploration
      const msgSize = JSON.stringify(messages).length;
      const estimatedTokens = Math.round(msgSize / 4);
      console.log(`[Agent] 📊 Iter ${iterations} | Messages: ${messages.length} | ~${estimatedTokens} tokens | Cost: $${liveCostUsd.toFixed(4)}`);

      const hasWrite = toolBlocks.some(b =>
        b.type === "tool_use" && ["write_file", "edit_file"].includes(b.name)
      );
      if (!hasWrite && iterations > 5) {
        console.warn(`[Agent] ⚠️ Iteration ${iterations} had no writes — agent may be stuck in exploration`);
      }
    }

    // Fallback: store code even if done() wasn't called
    try {
      const code = this.getProjectCode(projectDir);
      await projectService.storeGeneratedCode(projectId, code);
    } catch {}

    bustCache(projectDir);
    // Final sync commit folder to development/
    try { commitService.syncToDev(projectId, projectDir); } catch {}

    logger.done(summary || "Agent reached iteration limit", iterations, totalInputTokens, totalOutputTokens);
    const logFilePath = logger.getLogPath();
    logger.close();

    return {
      summary: summary || "App updated (agent reached iteration limit)",
      shortSummary: shortSummary || summary?.split("\n")[0]?.substring(0, 200) || "Update completed",
      model: tierConfig.model,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheWriteTokens: totalCacheWriteTokens,
      cacheReadTokens: totalCacheReadTokens,
      logPath: logFilePath,
      commitNum,
      commitDir,
    };
  }

  private extractCodeSummary(content: string, filePath: string): string {
    const lines = content.split("\n");
    const lineCount = lines.length;
    const summaryParts: string[] = [`[written: ${lineCount} lines to ${filePath}]`];

    if (filePath.includes("routes.js")) {
      // Extract route definitions: router.get('/path', ...), router.post('/path', ...)
      const routes: string[] = [];
      for (const line of lines) {
        const match = line.match(/router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/i);
        if (match) routes.push(`${match[1].toUpperCase()} ${match[2]}`);
      }
      if (routes.length > 0) summaryParts.push(`Routes: ${routes.join(", ")}`);
    }

    if (filePath.includes("app.js") || filePath.includes("index.html")) {
      // Extract API endpoints called from frontend
      const endpoints: string[] = [];
      for (const line of lines) {
        const fetchMatch = line.match(/apiCall\s*\(\s*['"`]([^'"`]+)['"`]/);
        if (fetchMatch) endpoints.push(fetchMatch[1]);
        const fetchMatch2 = line.match(/fetch\s*\(\s*['"`]([^'"`]*\/api\/[^'"`]+)['"`]/);
        if (fetchMatch2) endpoints.push(fetchMatch2[1]);
        const apiBaseMatch = line.match(/API_BASE\s*\+\s*['"`]([^'"`]+)['"`]/);
        if (apiBaseMatch) endpoints.push(apiBaseMatch[1]);
      }
      if (endpoints.length > 0) summaryParts.push(`API calls: ${[...new Set(endpoints)].join(", ")}`);
    }

    // Extract db.get/db.set keys from routes.js
    if (filePath.includes("routes.js")) {
      const dbKeys: string[] = [];
      for (const line of lines) {
        const getMatch = line.match(/db\.(?:get|set)\s*\(\s*['"`]([^'"`]+)['"`]/);
        if (getMatch) dbKeys.push(getMatch[1]);
      }
      if (dbKeys.length > 0) summaryParts.push(`DB keys: ${[...new Set(dbKeys)].join(", ")}`);
    }

    return summaryParts.join("\n");
  }

  private pruneConversation(messages: Anthropic.MessageParam[]): void {
    const keepRecent = 6; // 3 iterations (user+assistant pairs)
    const pruneUntil = messages.length - keepRecent;
    if (pruneUntil <= 1) return;

    for (let i = 1; i < pruneUntil; i++) {
      const msg = messages[i];

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        // Remove thinking blocks from old messages (in-place to avoid reassignment)
        const arr = msg.content as any[];
        for (let j = arr.length - 1; j >= 0; j--) {
          if (arr[j].type === "thinking") arr.splice(j, 1);
        }

        for (const block of arr) {
          if (block.type !== "tool_use") continue;

          if (block.name === "write_file" && block.input?.content) {
            const lines = block.input.content.split("\n").length;
            block.input = { path: block.input.path, content: `[written ${lines} lines to ${block.input.path}]` };
          }

          if (block.name === "edit_file" && block.input?.old_string) {
            block.input = {
              path: block.input.path,
              old_string: `[${block.input.old_string.length} chars replaced]`,
              new_string: `[${block.input.new_string?.length || 0} chars new]`,
            };
          }
        }
      }

      if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const block of msg.content as any[]) {
          if (block.type !== "tool_result") continue;
          if (typeof block.content === "string" && block.content.length > 300) {
            if (block.content.startsWith("OK:")) continue;
            block.content = block.content.substring(0, 150) + `\n...[cleared: ${block.content.length} chars]`;
          }
        }
      }
    }

    // Emergency pruning if context is still too large
    const estimatedTokens = JSON.stringify(messages).length / 4;
    if (estimatedTokens > 150000 && messages.length > 8) {
      console.warn(`[Agent] ⚠️ Emergency prune: ~${Math.round(estimatedTokens)} tokens`);
      const first = messages[0]; // user prompt
      // Keep last 3 pairs (6 messages) to maintain alternation
      let keepFrom = messages.length - 6;
      // Ensure we start with an assistant message (to follow the first user message)
      if (messages[keepFrom]?.role === "user") keepFrom++;
      const recent = messages.slice(keepFrom);
      messages.length = 0;
      messages.push(first, ...recent);
    }
  }

  private summarizeArgs(toolName: string, args: any): string {
    switch (toolName) {
      case "list_files": return "";
      case "read_file": return args.offset ? `${args.path}:${args.offset}-${args.offset + (args.limit || 0)}` : args.path;
      case "write_file": return `${args.path}, ${(args.content || "").length} chars`;
      case "edit_file": return `${args.path}, "${(args.old_string || "").substring(0, 40)}..." -> "${(args.new_string || "").substring(0, 40)}..."`;
      case "grep": return `"${args.pattern}"${args.path ? ` in ${args.path}` : ""}${args.include ? ` (${args.include})` : ""}`;
      case "shell": return args.command?.substring(0, 80) || "";
      case "http_request": return `${args.method || "GET"} ${args.url}`;
      case "fetch_url": return args.url || "";
      case "db": return `${args.operation}(${args.key || ""})${args.value ? ", " + JSON.stringify(args.value).substring(0, 60) : ""}`;
      case "telegram_api": return args.method || "";
      case "load_skill": return args.name || "";
      case "server_logs": return `${args.lines || 30} lines`;
      case "deploy_to_dev": return "";
      case "check_todo": return `task #${args.id}`;
      case "done": return (args.summary || "").substring(0, 80);
      default: return JSON.stringify(args).substring(0, 80);
    }
  }

  private isProtectedPath(relativePath: string): boolean {
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    if (/^(frontend|backend)(\/|$)/i.test(normalized)) return false;
    return true;
  }

  private safePath(projectDir: string, relativePath: string): string | null {
    if (relativePath.includes("..")) return null;
    const full = path.join(projectDir, relativePath);
    if (!full.startsWith(projectDir)) return null;
    return full;
  }

  private static readonly SKIP_DIRS = new Set([
    "node_modules", ".git", "data",
  ]);
  private static readonly SKIP_EXTS = new Set([
    ".mp3", ".png", ".jpg", ".jpeg", ".gif", ".wav", ".mp4", ".webp", ".db",
  ]);

  private walkDirWithStats(dir: string, base: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (AgentService.SKIP_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        results.push(...this.walkDirWithStats(fullPath, base));
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (AgentService.SKIP_EXTS.has(ext)) continue;
        try {
          const stat = fs.statSync(fullPath);
          const content = fs.readFileSync(fullPath, "utf-8");
          const lineCount = content.split("\n").length;
          const sizeKB = (stat.size / 1024).toFixed(1);
          const relPath = path.relative(base, fullPath).replace(/\\/g, "/");
          results.push(`${relPath} (${lineCount} lines, ${sizeKB}KB)`);
        } catch {
          const relPath = path.relative(base, fullPath).replace(/\\/g, "/");
          results.push(relPath);
        }
      }
    }
    return results;
  }

  private gatherProjectInfo(projectDir: string): { fileTree: string; dbKeys: string; npmPackages: string } {
    const files = this.walkDirWithStats(projectDir, projectDir);
    const fileTree = files.length > 0 ? files.map(f => "  " + f).join("\n") : "";

    let dbKeys = "";
    try {
      const Database = require("better-sqlite3");
      const projectRoot = path.resolve(projectDir, "..", "..");
      const dbPath = path.join(projectRoot, "development", "data", "app.db");
      if (fs.existsSync(dbPath)) {
        const sqlite = new Database(dbPath, { readonly: true });
        const keys = sqlite.prepare("SELECT key FROM kv").all().map((r: any) => r.key);
        sqlite.close();
        if (keys.length > 0) dbKeys = keys.join(", ");
      }
    } catch {}

    let npmPackages = "";
    const pkgPath = path.join(projectDir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        const deps = Object.keys(pkg.dependencies || {});
        if (deps.length > 0) npmPackages = deps.join(", ");
      } catch {}
    }

    return { fileTree, dbKeys, npmPackages };
  }

  private extractCodeLocations(commitDir: string): string {
    const locations: string[] = [];
    const scanFile = (relPath: string) => {
      const filePath = path.join(commitDir, relPath);
      if (!fs.existsSync(filePath)) return;
      let lines: string[];
      try { lines = fs.readFileSync(filePath, "utf-8").split("\n"); } catch { return; }

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        const routeMatch = line.match(/router\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/);
        if (routeMatch) {
          locations.push(`- ${relPath}:${i + 1} — ${routeMatch[1].toUpperCase()} ${routeMatch[2]}`);
          continue;
        }
        const funcMatch = line.match(/^(?:  )?(?:async\s+)?function\s+(\w+)\s*\(/);
        if (funcMatch) {
          locations.push(`- ${relPath}:${i + 1} — ${funcMatch[1]}()`);
          continue;
        }
        const constFuncMatch = line.match(/^(?:  )?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\(|function)/);
        if (constFuncMatch) {
          locations.push(`- ${relPath}:${i + 1} — ${constFuncMatch[1]}()`);
          continue;
        }
        const iifeMatch = line.match(/^(?:window\.(\w+)\s*=|const\s+(\w+)\s*=\s*\(\(\)\s*=>)/);
        if (iifeMatch) {
          const name = iifeMatch[1] || iifeMatch[2];
          locations.push(`- ${relPath}:${i + 1} — ${name} (IIFE/module)`);
          continue;
        }
        if (line.match(/module\.exports\.ws\s*=/)) {
          locations.push(`- ${relPath}:${i + 1} — module.exports.ws (WebSocket handler)`);
          continue;
        }
        if (line.match(/module\.exports\s*[.=]/)) {
          locations.push(`- ${relPath}:${i + 1} — module.exports`);
          continue;
        }
        const constMatch = line.match(/^(?:  )?const\s+((?:[A-Z_]{2,}|BONUS_TIERS|DJM_PER_TON|ADMIN_USERNAMES))\s*=/);
        if (constMatch) {
          locations.push(`- ${relPath}:${i + 1} — ${constMatch[1]} (constant)`);
        }
      }
    };

    scanFile("backend/routes.js");
    scanFile("frontend/app.js");

    // Scan additional backend files
    const backendDir = path.join(commitDir, "backend");
    if (fs.existsSync(backendDir)) {
      for (const f of fs.readdirSync(backendDir)) {
        if (f !== "routes.js" && f.endsWith(".js")) {
          scanFile(`backend/${f}`);
        }
      }
    }

    return locations.length > 0 ? locations.join("\n") : "No code locations extracted";
  }

  private readCodeForContext(commitDir: string): string {
    const BINARY_EXTS = new Set([".db", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp3", ".wav", ".mp4", ".ico", ".svg"]);
    const parts: string[] = [];
    const readDir = (dir: string, prefix: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;
        try {
          const content = fs.readFileSync(path.join(dir, entry.name), "utf-8");
          const maxChars = 500000;
          const truncated = content.length > maxChars
            ? content.substring(0, maxChars) + `\n...[truncated from ${content.length} chars]`
            : content;
          parts.push(`--- ${prefix}/${entry.name} (${content.split("\n").length} lines) ---\n${truncated}`);
        } catch {}
      }
    };
    readDir(path.join(commitDir, "frontend"), "frontend");
    readDir(path.join(commitDir, "backend"), "backend");
    return parts.join("\n\n");
  }

  private async generatePassport(opts: {
    projectId: string;
    commitDir: string;
    commitNum: number;
    description?: string;
    doneSummary?: string;
    prevPassport?: string;
  }): Promise<string> {
    const { projectId, commitDir, commitNum, description, doneSummary, prevPassport } = opts;
    const { fileTree, dbKeys, npmPackages } = this.gatherProjectInfo(commitDir);
    const extractor = new ConventionExtractor();
    const { structure, conventions } = extractor.extract(commitDir);

    const inputParts: string[] = [];
    if (description) inputParts.push(`APP DESCRIPTION: ${description}`);
    if (structure) inputParts.push(`CODE STRUCTURE MAP:\n${structure}`);
    if (conventions) inputParts.push(`CODE CONVENTION SAMPLES:\n${conventions}`);
    if (fileTree) inputParts.push(`FILE TREE:\n${fileTree}`);
    if (dbKeys) inputParts.push(`DB KEYS: ${dbKeys}`);
    if (npmPackages) inputParts.push(`NPM PACKAGES: ${npmPackages}`);
    if (prevPassport) inputParts.push(`PREVIOUS PASSPORT (for reference — preserve style and key decisions, but update everything from actual code):\n${prevPassport.substring(0, 8000)}`);
    if (doneSummary) inputParts.push(`LATEST CHANGES (commit #${commitNum}):\n${doneSummary.substring(0, 3000)}`);

    const response = await this.client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 16000,
      messages: [{
        role: "user",
        content: `${doneSummary ? "Generate an updated" : "Analyze this codebase and generate a"} project passport for a Telegram Mini App.
This document will be used by an AI developer agent in future updates to understand the project
instantly WITHOUT reading all files. It must be accurate and complete — the agent will trust this
document and use Code Locations to jump directly to the right lines.
${prevPassport ? "\nUse the previous passport for style/format reference and to preserve Key Decisions that are still relevant." : ""}

${inputParts.join("\n\n")}

Output a structured markdown document (under 4000 words) with EXACTLY these sections:

## App: <name>
Purpose: <one-line description>

## Architecture
Pages/screens, navigation flow, API routes (method + path + what it does), WebSocket events if any,
DB keys and what they store. Be specific — list every route, every DB key, every screen ID.

## Code Locations
Use the auto-extracted locations above as a base. Keep all of them.
Add any important helpers, constants, or hook points that were missed.
Format: \`- file:line — description\`
This section is CRITICAL for the agent's efficiency.

## Code Conventions
- **Frontend structure:** key function names and what they do, global state variables (what's in \`state\` object), how tabs/modals are toggled, DOM update patterns.
- **CSS patterns:** naming convention, CSS variables used for theming, key class names for major components.
- **Backend patterns:** route handler structure, middleware, error handling style, how db.get/db.set are used.
- **Critical wiring:** how frontend calls API (fetch wrapper? base URL pattern?), how WebSocket events are dispatched and handled, event listeners setup.

## UI
Theme, layout approach, key components with their CSS class names, special effects/animations.

## Key Decisions
Important implementation choices and WHY they were made. Include gotchas, known issues,
and things that look wrong but are intentional.

## Current State
What the app can do right now. What features are complete, what's partially done.`,
      }],
    });

    const passportText = response.content[0]?.type === "text" ? response.content[0].text : "";
    if (!passportText) throw new Error("Failed to generate passport");

    const usage = response.usage as any;
    const inTok = usage?.input_tokens || 0;
    const outTok = usage?.output_tokens || 0;
    const p = MODEL_PRICING["claude-haiku-4-5-20251001"];
    const costUsd = inTok * p.input + outTok * p.output;

    fs.writeFileSync(path.join(commitDir, "passport.md"), passportText, "utf-8");

    // Build history: append to previous or create fresh
    let history = "";
    if (commitNum > 0) {
      const prevHistoryPath = path.join(commitDir, "..", String(commitNum - 1), "history.md");
      if (fs.existsSync(prevHistoryPath)) {
        history = fs.readFileSync(prevHistoryPath, "utf-8");
      }
    }
    const historyLine = doneSummary
      ? doneSummary.split("\n")[0].substring(0, 200)
      : "Context regenerated from source code";
    history += `\n- #${commitNum}: ${historyLine}`;
    history = history.trim();
    fs.writeFileSync(path.join(commitDir, "history.md"), history, "utf-8");

    const combined = passportText + "\n\n## Update History\n" + history;
    fs.writeFileSync(path.join(commitDir, "context.md"), combined, "utf-8");
    await projectService.updateProjectSummary(projectId, combined);

    const label = doneSummary ? "Generated" : "Regenerated";
    console.log(`[Context] ✅ ${label} passport for ${projectId.substring(0, 8)} commit #${commitNum} | in=${inTok} out=${outTok} | $${costUsd.toFixed(4)}`);
    return combined;
  }

  async compactContext(
    projectId: string,
    commitDir: string,
    doneSummary: string,
    commitNum: number,
    description?: string,
    plan?: string,
  ): Promise<string> {
    let prevPassport = "";
    if (commitNum > 0) {
      const prevPath = path.join(commitDir, "..", String(commitNum - 1), "passport.md");
      if (fs.existsSync(prevPath)) {
        prevPassport = fs.readFileSync(prevPath, "utf-8");
      } else {
        const prevCtxPath = path.join(commitDir, "..", String(commitNum - 1), "context.md");
        if (fs.existsSync(prevCtxPath)) {
          prevPassport = fs.readFileSync(prevCtxPath, "utf-8");
        }
      }
    }

    try {
      return await this.generatePassport({ projectId, commitDir, commitNum, description, doneSummary, prevPassport });
    } catch (err) {
      console.error(`[Context] Failed to generate passport for ${projectId.substring(0, 8)}:`, err);
    }

    const fallback = this.buildFallbackSummary(commitDir, doneSummary);
    fs.writeFileSync(path.join(commitDir, "context.md"), fallback, "utf-8");
    await projectService.updateProjectSummary(projectId, fallback);
    return fallback;
  }

  async regenerateContext(projectId: string): Promise<string> {
    const projectDir = path.join(PROJECTS_DIR, projectId);
    const commitsDir = path.join(projectDir, "commits");

    let latestNum = 0;
    let latestDir = "";
    if (fs.existsSync(commitsDir)) {
      const nums = fs.readdirSync(commitsDir).map(Number).filter(n => !isNaN(n));
      if (nums.length > 0) {
        latestNum = Math.max(...nums);
        latestDir = path.join(commitsDir, String(latestNum));
      }
    }

    if (!latestDir || !fs.existsSync(latestDir)) {
      latestDir = path.join(projectDir, "development");
      if (!fs.existsSync(latestDir)) throw new Error("No code found to analyze");
    }

    const project = await projectService.getProject(projectId);
    return this.generatePassport({ projectId, commitDir: latestDir, commitNum: latestNum, description: project?.description || undefined });
  }

  private buildFallbackSummary(projectDir: string, doneSummary: string): string {
    const { fileTree, dbKeys, npmPackages } = this.gatherProjectInfo(projectDir);
    const parts: string[] = [];
    if (fileTree) parts.push("FILE TREE:\n" + fileTree);
    if (doneSummary) parts.push("ARCHITECTURE & CHANGES:\n" + doneSummary);
    if (dbKeys) parts.push("DB KEYS: " + dbKeys);
    if (npmPackages) parts.push("NPM PACKAGES: " + npmPackages);
    return parts.join("\n\n");
  }

  private loadLatestContext(projectId: string): string | null {
    try {
      const commitsDir = path.join(PROJECTS_DIR, projectId, "commits");
      if (!fs.existsSync(commitsDir)) return null;
      const nums = fs.readdirSync(commitsDir).map(Number).filter(n => !isNaN(n));
      if (nums.length === 0) return null;
      const latest = Math.max(...nums);
      const latestDir = path.join(commitsDir, String(latest));

      // Prefer passport.md + history.md (new format)
      const passportPath = path.join(latestDir, "passport.md");
      if (fs.existsSync(passportPath)) {
        let result = fs.readFileSync(passportPath, "utf-8");
        const historyPath = path.join(latestDir, "history.md");
        if (fs.existsSync(historyPath)) {
          const history = fs.readFileSync(historyPath, "utf-8");
          const recentHistory = history.split("\n").slice(-10).join("\n");
          result += "\n\n## Recent Updates\n" + recentHistory;
        }
        return result;
      }

      // Fallback to context.md (old format)
      const contextPath = path.join(latestDir, "context.md");
      if (fs.existsSync(contextPath)) {
        return fs.readFileSync(contextPath, "utf-8");
      }
    } catch {}
    return null;
  }

  private getProjectCode(projectDir: string): string {
    const result: Record<string, string> = {};
    const readDir = (dir: string, prefix: string) => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          result[`${prefix}/${entry.name}`] = fs.readFileSync(path.join(dir, entry.name), "utf-8");
        }
      }
    };
    readDir(path.join(projectDir, "frontend"), "frontend");
    readDir(path.join(projectDir, "backend"), "backend");
    const schemaPath = path.join(projectDir, "schema.sql");
    if (fs.existsSync(schemaPath)) {
      result["schema.sql"] = fs.readFileSync(schemaPath, "utf-8");
    }
    return JSON.stringify(result, null, 2);
  }
}

export const agentService = new AgentService();
