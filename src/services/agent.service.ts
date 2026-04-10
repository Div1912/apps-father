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

Layout:
- html,body { margin:0; background:#000; color:#fff; overflow-x:hidden; overscroll-behavior:none; }
- Safe areas: padding-top: calc(var(--tg-safe-area-inset-top, 0px) + var(--tg-content-safe-area-inset-top, 0px)); padding-bottom: calc(var(--tg-safe-area-inset-bottom, 0px) + var(--tg-content-safe-area-inset-bottom, 0px))
- Hide scrollbars: ::-webkit-scrollbar { display:none; } body { scrollbar-width:none; }
- Full viewport height: min-height: 100vh

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

IMPORTANT - ROUTES HOT-RELOAD:
Backend routes.js is reloaded on EVERY API request. You do NOT need to restart anything after editing routes.js. Changes take effect immediately on the next http_request test.
WebSocket handlers (module.exports.ws) are loaded once when the first client connects. To test WS changes, all clients must disconnect first (or reload the app).

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

DEBUGGING RULES:
- If http_request returns the same wrong result 3 times after different fixes, STOP and use server_logs to check for errors
- If you cannot fix a bug after 5 attempts, call done() with a summary explaining the issue — do NOT keep retrying the same approach
- When an API returns unexpected results, check server_logs FIRST before rewriting code

WORKFLOW FOR NEW APP:
1. list_files + read existing files (parallel calls to understand current state)
2. Decide: does this app need real-time? (chat, games, live updates → YES → load_skill('websocket'))
3. Plan ALL files mentally: decide endpoints, db keys, WS message types, frontend API calls BEFORE writing any code
4. Write backend/routes.js FIRST — REST endpoints + module.exports.ws handler if real-time needed
5. Write frontend files (index.html, styles.css, app.js) — endpoint names and WS message types MUST match routes.js exactly
6. shell("npm install <pkg>") if external packages needed
7. telegram_api to configure bot (setMyDescription, setMyCommands, setChatMenuButton) — ONLY on first build
8. VERIFY: grep app.js for all apiCall/fetch URLs, then test each with http_request
9. fetch_url to read API docs when you need to learn an unfamiliar external API
9. Call done() ONLY after verifying all endpoints work

WORKFLOW FOR UPDATE:
1. grep + read_file (parallel) to find relevant code
2. Make changes with edit_file (small) or write_file (large)
3. If changing backend routes, grep frontend for affected apiCall URLs
4. Test changed endpoints with http_request
5. Call done()
IMPORTANT: Do NOT call telegram_api(setMyDescription) during updates — only set bot description on first build.

ASKING THE USER (ask_user tool):
- Use ask_user ONLY when you need information the user MUST provide: API keys, credentials, external account IDs, or a choice between fundamentally different approaches where guessing wrong wastes significant effort.
- NEVER use ask_user for implementation details, design choices, styling, naming, or anything you can decide yourself.
- NEVER call ask_user in parallel with other tools — it must be the ONLY tool in its turn.
- Always provide clear options as buttons when the question has a finite set of answers.
- If the user clicks Skip or doesn't answer, proceed with the best default.

PROGRESS REPORTING:
- You will receive a TASK CHECKLIST in the prompt. After completing each task, call check_todo(id) with the task number (1-based). This updates a live checklist the user sees.
- Call check_todo in parallel with other tool calls — it costs nothing.
- Call done() ONLY after ALL checklist tasks are checked off.
- You may also call set_progress(percent, message) for fine-grained status updates between checklist items.

PARALLEL TOOL CALLS — USE AGGRESSIVELY:
- Read multiple files at once: read_file(routes.js) + read_file(app.js) + read_file(styles.css) in ONE turn
- Write related files together: write_file(index.html) + write_file(styles.css) in ONE turn
- Initialize multiple db keys: db(set, 'users', []) + db(set, 'settings', {}) in ONE turn
- Test multiple endpoints: http_request(GET /user) + http_request(GET /leaderboard) in ONE turn
- Configure bot: telegram_api(setMyDescription) + telegram_api(setMyCommands) + telegram_api(setChatMenuButton) in ONE turn
- NEVER make 1 tool call when you could make 2-5 independent calls in the same turn

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
    name: "done",
    description: "Call this when you've finished all changes. Provide a detailed summary of what was done.",
    input_schema: {
      type: "object" as const,
      properties: {
        summary: { type: "string" as const, description: "Detailed summary of all changes made" },
      },
      required: ["summary"],
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

export interface AgentResult {
  summary: string;
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
  1: { model: "claude-sonnet-4-6", thinking: 8000, maxIterations: 60 },
  2: { model: "claude-sonnet-4-6", thinking: 16000, maxIterations: 100 },
  3: { model: "claude-opus-4-6", thinking: 8000, maxIterations: 60 },
  4: { model: "claude-opus-4-6", thinking: 16000, maxIterations: 100 },
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

  async generateChecklist(description: string, plan?: string, lang?: string): Promise<string[]> {
    try {
      const langNote = lang && lang !== "en"
        ? ` Write the task items in ${lang === "ru" ? "Russian" : "Ukrainian"}.`
        : "";
      const prompt = plan
        ? `Break down this app build plan into concrete implementation tasks (short, actionable items a developer would check off). Return ONLY a JSON array of strings.${langNote}\n\nPlan:\n${plan}\n\nDescription:\n${description}`
        : `Break down this update request into concrete implementation tasks (short, actionable items a developer would check off). If the request is simple (1-2 small changes), return just 2-3 items. Only use more items (up to 8) for complex multi-part requests. Return ONLY a JSON array of strings.${langNote}\n\nRequest:\n${description}`;

      const response = await this.client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content[0]?.type === "text" ? response.content[0].text : "[]";
      const arrMatch = text.match(/\[[\s\S]*\]/);
      const raw = arrMatch ? arrMatch[0] : text;
      let items: unknown;
      try { items = JSON.parse(raw); } catch { items = null; }
      if (Array.isArray(items) && items.length > 0) {
        return items.filter((s): s is string => typeof s === "string").slice(0, 10);
      }
    } catch (err) {
      console.error("[Agent] Failed to generate checklist:", err);
    }
    return [];
  }

  async buildApp(
    projectId: string,
    description: string,
    plan: string,
    onProgress?: (p: AgentProgress) => Promise<void>,
    onAskUser?: (question: string, options: string[]) => Promise<string>,
    checklist?: string[],
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

    return this.runAgent(projectId, prompt, onProgress, onAskUser, checklist, onCheckTodo, userBalance);
  }

  async updateApp(
    projectId: string,
    updateDescription: string,
    onProgress?: (p: AgentProgress) => Promise<void>,
    attachments?: { localPath: string; projectPath: string; originalName: string; caption?: string }[],
    onAskUser?: (question: string, options: string[]) => Promise<string>,
    checklist?: string[],
    onCheckTodo?: (id: number) => Promise<void>,
    lang?: string,
    userBalance?: number,
  ): Promise<AgentResult> {
    const project: any = await projectService.getProject(projectId);
    const contextParts: string[] = [];

    // Load structured context.md from latest commit
    const latestContext = this.loadLatestContext(projectId);
    if (latestContext) {
      contextParts.push(`PROJECT CONTEXT:\n${latestContext}`);
    } else if (project?.projectSummary) {
      contextParts.push(`PROJECT CONTEXT (from previous builds):\n${project.projectSummary}`);
    }
    if (project?.plan) {
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

    return this.runAgent(projectId, prompt, onProgress, onAskUser, checklist, onCheckTodo, userBalance);
  }

  private async runAgent(
    projectId: string,
    userPrompt: string,
    onProgress?: (p: AgentProgress) => Promise<void>,
    onAskUser?: (question: string, options: string[]) => Promise<string>,
    checklist?: string[],
    onCheckTodo?: (id: number) => Promise<void>,
    userBalance?: number,
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
    const mandatoryTasks = [
      "Deploy & test: call deploy_to_dev(), verify key endpoints with http_request. Do NOT mark done until you have tested.",
      "Summarizing: call done() with a detailed summary of all changes made. Include architecture decisions, new files, and anything the next update should know.",
    ];
    const fullChecklist = checklist ? [...checklist, ...mandatoryTasks] : [...mandatoryTasks];
    const checklistText = fullChecklist.map((item, i) => `${i + 1}. ${item}`).join("\n");
    if (checklist && checklist.length > 0) {
      finalPrompt += `\n\nYOUR TASK CHECKLIST (complete each item, then call check_todo(id) to mark it done):\n${checklistText}\n\nYou MUST call check_todo(id) after completing each task. Call done() only after ALL tasks are checked off.`;
    } else {
      finalPrompt += `\n\nMANDATORY FINAL STEPS (call check_todo(id) for each before calling done()):\n${checklistText}`;
    }
    checklist = fullChecklist;

    logger.header(tierConfig.model, finalPrompt);

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: finalPrompt },
    ];

    let summary = "";
    let iterations = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheWriteTokens = 0;
    let totalCacheReadTokens = 0;
    let currentPercent: number | undefined;
    let deployCount = 0;

    const maxIterations = tierConfig.maxIterations;
    while (iterations < maxIterations) {
      iterations++;

      const response = await this.callWithRetry({
        model: tierConfig.model,
        max_tokens: tierConfig.thinking + 8000,
        thinking: { type: "enabled", budget_tokens: tierConfig.thinking },
        system: AGENT_SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
        cache_control: { type: "ephemeral" },
      } as any);

      const usage = response.usage as any;
      totalInputTokens += usage?.input_tokens || 0;
      totalOutputTokens += usage?.output_tokens || 0;
      const cached = usage?.cache_read_input_tokens || 0;
      const cacheCreated = usage?.cache_creation_input_tokens || 0;
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
      logger.tokens(totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens);

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

            case "check_todo": {
              const todoId = Math.round(args.id);
              if (checklist && todoId >= 1 && todoId <= checklist.length) {
                checklistDone.add(todoId);
                if (onCheckTodo) {
                  try { await onCheckTodo(todoId); } catch {}
                }
                result = `OK: Task ${todoId} marked as done (${checklistDone.size}/${checklist.length} completed)`;
                console.log(`[Agent] ✅ check_todo(${todoId}): "${checklist[todoId - 1]}" — ${checklistDone.size}/${checklist.length} done`);
              } else {
                result = `Error: Invalid task ID ${todoId}`;
              }
              break;
            }

            case "done": {
              summary = args.summary || "Changes applied";
              currentPercent = 100;
              if (checklist && checklist.length > 0 && checklistDone.size < checklist.length) {
                const missing = checklist.filter((_, i) => !checklistDone.has(i + 1));
                console.log(`[Agent] ⚠️ done() called with ${checklist.length - checklistDone.size} unchecked tasks: ${missing.join(", ")}`);
              }
              await progress({ action: "Summarizing...", detail: "", percent: 100 });
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

              // Generate structured context.md via Claude
              try {
                const project = await projectService.getProject(projectId);
                await this.compactContext(projectId, projectDir, summary, commitNum, project?.description || undefined, project?.plan || undefined);
              } catch (err) {
                console.error("[Agent] Failed to generate context:", err);
              }

              bustCache(projectDir);
              // Final sync commit folder to development/
              try { commitService.syncToDev(projectId, projectDir); } catch {}
              toolResults.push({ type: "tool_result", tool_use_id: id, content: "OK" });
              messages.push({ role: "user", content: toolResults });
              logger.done(summary, iterations, totalInputTokens, totalOutputTokens);
              const logFilePath = logger.getLogPath();
              logger.close();
              return { summary, model: tierConfig.model, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheWriteTokens: totalCacheWriteTokens, cacheReadTokens: totalCacheReadTokens, logPath: logFilePath, commitNum, commitDir };
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

      // Prune large tool inputs from older assistant messages to reduce token usage
      // this.pruneConversation(messages);
    }

    // Fallback: store code and context even if done() wasn't called
    try {
      const code = this.getProjectCode(projectDir);
      await projectService.storeGeneratedCode(projectId, code);
    } catch {}
    try {
      const project = await projectService.getProject(projectId);
      await this.compactContext(projectId, projectDir, summary || "Agent stopped", commitNum, project?.description || undefined, project?.plan || undefined);
    } catch {}

    bustCache(projectDir);
    // Final sync commit folder to development/
    try { commitService.syncToDev(projectId, projectDir); } catch {}

    logger.done(summary || "Agent reached iteration limit", iterations, totalInputTokens, totalOutputTokens);
    const logFilePath = logger.getLogPath();
    logger.close();

    return {
      summary: summary || "App updated (agent reached iteration limit)",
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
    // Keep last 8 messages intact (4 iterations) for accurate edit_file context
    const keepRecent = 8;
    const pruneUntil = messages.length - keepRecent;
    if (pruneUntil <= 1) return;

    for (let i = 1; i < pruneUntil; i++) {
      const msg = messages[i];

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        for (const block of msg.content as any[]) {
          if (block.type !== "tool_use") continue;

          if (block.name === "write_file" && block.input?.content && block.input.content.length > 200) {
            const summary = this.extractCodeSummary(block.input.content, block.input.path);
            block.input = { path: block.input.path, content: summary };
          }

          if (block.name === "edit_file" && block.input?.old_string && block.input.old_string.length > 200) {
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
          if (typeof block.content === "string" && block.content.length > 2000) {
            block.content = block.content.substring(0, 800) + `\n...[truncated from ${block.content.length} chars]`;
          }
        }
      }
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

  async compactContext(
    projectId: string,
    commitDir: string,
    doneSummary: string,
    commitNum: number,
    description?: string,
    plan?: string,
  ): Promise<string> {
    const { fileTree, dbKeys, npmPackages } = this.gatherProjectInfo(commitDir);

    let previousContext = "";
    if (commitNum > 0) {
      const prevContextPath = path.join(commitDir, "..", String(commitNum - 1), "context.md");
      if (fs.existsSync(prevContextPath)) {
        previousContext = fs.readFileSync(prevContextPath, "utf-8");
      }
    }

    const isFirstBuild = !previousContext;

    const inputParts: string[] = [];
    if (isFirstBuild) {
      if (description) inputParts.push(`APP DESCRIPTION:\n${description}`);
      if (plan) inputParts.push(`BUILD PLAN:\n${plan}`);
    } else {
      inputParts.push(`PREVIOUS CONTEXT:\n${previousContext}`);
    }
    inputParts.push(`CHANGES (commit #${commitNum}):\n${doneSummary}`);
    if (fileTree) inputParts.push(`FILE TREE:\n${fileTree}`);
    if (dbKeys) inputParts.push(`DB KEYS: ${dbKeys}`);
    if (npmPackages) inputParts.push(`NPM PACKAGES: ${npmPackages}`);

    try {
      const response = await this.client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4500,
        messages: [{
          role: "user",
          content: `${isFirstBuild ? "Generate" : "Update"} a concise project context document for a Telegram Mini App. This document will be used by an AI developer in future updates to understand the project instantly without reading all files.

${inputParts.join("\n\n")}

Output a structured markdown document (under 2000 words) with these sections:
## App: <name>
Purpose: <one-line description>

## Architecture
Pages/screens, navigation flow, API routes (method + path + what it does), WebSocket events if any, DB keys and what they store.

## Code Conventions
- **Frontend structure:** key function names and what they do (e.g. renderLeaderboard(), startRound()), global state variables, how tabs/modals are toggled, DOM update patterns.
- **CSS patterns:** naming convention (BEM, flat, etc.), CSS variables used for theming (e.g. --accent, --bg-dark), key class names for major components.
- **Backend patterns:** route handler structure, middleware, error handling style, how db.get/db.set are used.
- **Critical wiring:** how frontend calls API (fetch wrapper? base URL pattern?), how WebSocket events are dispatched and handled, event listeners setup.

## UI
Theme, layout approach, key components with their CSS class names, special effects/animations.

## Key Decisions
Important implementation choices and why.

## Update History
One line per commit: - #N: <what changed>`,
        }],
      });

      const text = response.content[0]?.type === "text" ? response.content[0].text : "";
      if (text) {
        const contextPath = path.join(commitDir, "context.md");
        fs.writeFileSync(contextPath, text, "utf-8");
        await projectService.updateProjectSummary(projectId, text);
        console.log(`[Context] Generated context.md for project ${projectId.substring(0, 8)} commit #${commitNum}`);
        return text;
      }
    } catch (err) {
      console.error(`[Context] Failed to generate context for ${projectId.substring(0, 8)}:`, err);
    }

    const fallback = this.buildFallbackSummary(commitDir, doneSummary);
    const contextPath = path.join(commitDir, "context.md");
    fs.writeFileSync(contextPath, fallback, "utf-8");
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

    const { fileTree, dbKeys, npmPackages } = this.gatherProjectInfo(latestDir);

    const codeFiles: string[] = [];
    const readCode = (dir: string, prefix: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && !AgentService.SKIP_EXTS.has(path.extname(entry.name).toLowerCase())) {
          try {
            const content = fs.readFileSync(path.join(dir, entry.name), "utf-8");
            if (content.length < 15000) {
              codeFiles.push(`--- ${prefix}/${entry.name} ---\n${content}`);
            }
          } catch {}
        }
      }
    };
    readCode(path.join(latestDir, "frontend"), "frontend");
    readCode(path.join(latestDir, "backend"), "backend");

    const project = await projectService.getProject(projectId);

    const inputParts: string[] = [];
    if (project?.description) inputParts.push(`APP DESCRIPTION: ${project.description}`);
    if (codeFiles.length > 0) inputParts.push(`SOURCE CODE:\n${codeFiles.join("\n\n")}`);
    if (fileTree) inputParts.push(`FILE TREE:\n${fileTree}`);
    if (dbKeys) inputParts.push(`DB KEYS: ${dbKeys}`);
    if (npmPackages) inputParts.push(`NPM PACKAGES: ${npmPackages}`);

    const response = await this.client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4500,
      messages: [{
        role: "user",
        content: `Analyze this Telegram Mini App codebase and generate a concise project context document. This will be used by an AI developer in future updates to understand the project instantly.

${inputParts.join("\n\n")}

Output a structured markdown document (under 2000 words) with these sections:
## App: <name>
Purpose: <one-line description>

## Architecture
Pages/screens, navigation flow, API routes (method + path + what it does), WebSocket events if any, DB keys and what they store.

## Code Conventions
- **Frontend structure:** key function names and what they do, global state variables, how tabs/modals are toggled, DOM update patterns.
- **CSS patterns:** naming convention, CSS variables used for theming, key class names for major components.
- **Backend patterns:** route handler structure, middleware, error handling, how db.get/db.set are used.
- **Critical wiring:** how frontend calls API (fetch wrapper? base URL pattern?), how WebSocket events are dispatched and handled.

## UI
Theme, layout approach, key components with their CSS class names, special effects/animations.

## Key Decisions
Important implementation choices and why.

## Update History
Best guess from the code of what the app contains.`,
      }],
    });

    const text = response.content[0]?.type === "text" ? response.content[0].text : "";
    if (!text) throw new Error("Failed to generate context");

    if (latestDir.includes("commits")) {
      fs.writeFileSync(path.join(latestDir, "context.md"), text, "utf-8");
    }
    await projectService.updateProjectSummary(projectId, text);
    console.log(`[Context] Regenerated context for project ${projectId.substring(0, 8)}`);
    return text;
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
      const contextPath = path.join(commitsDir, String(latest), "context.md");
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
