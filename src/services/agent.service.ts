import OpenAI from "openai";
import { getModelPricing, getOpenRouterClient, toOpenAITool } from "./openrouter.service";
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
import { parseProjectPreferences, buildPreferencesPrompt, DEFAULT_PREFERENCES } from "./preferences.catalog";
import { forceReloadProjectWs } from "../web/ws-manager";
import { runWithProject } from "./console-tagger.service";
import { botRunnerService } from "./bot-runner.service";
import { getEnabledLessonsBlock as getAgentLessonsBlock } from "./agent-lessons.service";
import { prisma } from "../db";

const PROJECTS_DIR = path.join(process.cwd(), "projects");
const KNOWLEDGE_DIR = path.join(process.cwd(), "agent_knowledge");
const INSTRUCTIONS_DIR = path.join(KNOWLEDGE_DIR, "instructions");
const SKILLS_DIR = path.join(KNOWLEDGE_DIR, "skills");

// What the agent knows depends on the build mode. Most instruction files are
// loaded for every run; only workflow-* files are mode-specific. Order matters —
// it's the order they appear in the system prompt. To add a new section, drop
// a .md into agent_knowledge/instructions/ and add an entry here.
type AgentMode = "new" | "update";
type ProjectKind = "app" | "game" | "textBot";
const VALID_PROJECT_KINDS = new Set<ProjectKind>(["app", "game", "textBot"]);
const DEFAULT_PROJECT_KIND: ProjectKind = "app";

const NEW_WORKFLOW_BY_KIND: Record<ProjectKind, string> = {
  app: "workflow-new-app.md",
  game: "workflow-new-game.md",
  textBot: "workflow-new-textbot.md",
};

const UPDATE_WORKFLOW_BY_KIND: Record<ProjectKind, string> = {
  app: "workflow-update-app.md",
  game: "workflow-update-game.md",
  textBot: "workflow-update-textbot.md",
};

const INSTRUCTION_MANIFEST: Array<{ file: string; modes?: AgentMode[]; kinds?: ProjectKind[] }> = [
  { file: "identity.md" },
  { file: "architecture.md" },
  { file: "frontend-rules.md", kinds: ["app"] },
  { file: "backend-rules.md", kinds: ["app", "textBot"] },
  { file: "database-design.md", kinds: ["app", "textBot"] },
  { file: "routes-hot-reload.md", kinds: ["app", "textBot"] },
  { file: "bot-webhook.md", kinds: ["app", "textBot"] },
  { file: "technology-choice.md", kinds: ["app"] },

  { file: "best-practices.md" },
  { file: "efficiency.md" },

  { file: "workflow-new.md", modes: ["new"] },
  { file: "workflow-update.md", modes: ["update"] },
  { file: "telegram-api.md" },
  { file: "bot-side-updates.md", kinds: ["app", "textBot"] },
  { file: "after-writing.md" },
  { file: "ask-user.md" },
  { file: "skills-index.md" },
  { file: "frontend-design.md", kinds: ["app"] }, // last — the always-loaded design skill block
  { file: "server-tools.md" }, // OpenRouter server tools reference (always loaded)
];

// Cache file contents in memory so we don't hit the disk on every build.
// Invalidate by restarting the server (instruction files change rarely).
const instructionCache = new Map<string, string>();

// ---- Template variables for instructions/skills ----
// Markdown can use placeholders like {domain} or {wsBaseUrl}; they are
// substituted at prompt-build time with values derived from the runtime
// config. This keeps the docs portable across environments
// (apps-father.com / dev.apps-father.com / localhost:3000) without forking
// the markdown.
//
// IMPORTANT: only the keys listed in TEMPLATE_KEYS are substituted. Other
// curly placeholders the agent already uses in docs — {projectId}, {userId},
// {file}, {key}, etc. — are left as literal text so the agent still sees
// them as runtime placeholders to fill in generated code.
const TEMPLATE_KEYS = ["domain", "baseUrl", "wsBaseUrl", "wsScheme"] as const;
type TemplateKey = typeof TEMPLATE_KEYS[number];
const TEMPLATE_KEY_RE = new RegExp(`\\{(${TEMPLATE_KEYS.join("|")})\\}`, "g");

export function buildTemplateVars(): Record<TemplateKey, string> {
  const baseUrl = config.baseUrl;
  const wsScheme = baseUrl.startsWith("https://") ? "wss" : "ws";
  const wsBaseUrl = baseUrl.replace(/^https?:\/\//, `${wsScheme}://`);
  return {
    domain: config.domain,
    baseUrl,
    wsBaseUrl,
    wsScheme,
  };
}

function renderTemplate(text: string, vars: Record<TemplateKey, string>): string {
  if (!text) return text;
  return text.replace(TEMPLATE_KEY_RE, (_, k: TemplateKey) => vars[k] ?? `{${k}}`);
}

function loadInstruction(file: string): string {
  if (instructionCache.has(file)) return instructionCache.get(file)!;
  try {
    const filePath = path.join(INSTRUCTIONS_DIR, file);
    if (!filePath.startsWith(INSTRUCTIONS_DIR)) return "";
    const content = fs.readFileSync(filePath, "utf-8").trim();
    instructionCache.set(file, content);
    return content;
  } catch (err: any) {
    console.warn(`[Agent] missing instruction file: ${file} — ${err.message}`);
    instructionCache.set(file, "");
    return "";
  }
}

function normalizeProjectKind(kind?: string | null): ProjectKind {
  return VALID_PROJECT_KINDS.has(kind as ProjectKind) ? kind as ProjectKind : DEFAULT_PROJECT_KIND;
}

function workflowFileFor(mode: AgentMode, kind?: string | null): string {
  const normalized = normalizeProjectKind(kind);
  return mode === "new"
    ? NEW_WORKFLOW_BY_KIND[normalized]
    : UPDATE_WORKFLOW_BY_KIND[normalized];
}

async function buildSystemPrompt(mode: AgentMode, kind?: string): Promise<string> {
  const parts: string[] = [];
  const missing: string[] = [];
  const vars = buildTemplateVars();
  const normalizedKind = normalizeProjectKind(kind);

  for (const entry of INSTRUCTION_MANIFEST) {
    if (entry.modes && !entry.modes.includes(mode)) continue;
    if (entry.kinds && !entry.kinds.includes(normalizedKind)) continue;

    let file = entry.file;
    if ((file === "workflow-new.md" && mode === "new") || (file === "workflow-update.md" && mode === "update")) {
      const kindFile = workflowFileFor(mode, normalizedKind);
      const kindContent = loadInstruction(kindFile);
      if (kindContent) {
        file = kindFile;
      }
    }

    const content = loadInstruction(file);
    if (content) parts.push(renderTemplate(content, vars));
    else missing.push(file);
  }

  // Append learned rules (AgentLesson rows where enabled=true). Cached in
  // memory by the service and invalidated on every lesson mutation, so
  // changes from the Admin CRM take effect on the next agent run with no
  // process restart. Failures are logged and ignored — the lesson layer
  // must NEVER block the core agent.
  try {
    const lessonsBlock = await getAgentLessonsBlock();
    if (lessonsBlock) parts.push(lessonsBlock);
  } catch (err: any) {
    console.warn(`[Agent] failed to load learned lessons: ${err?.message || err}`);
  }

  const prompt = parts.join("\n----------------------\n");
  // Fail fast with a clear error instead of sending empty system to Anthropic
  // (which returns "cache_control cannot be set for empty text blocks").
  // This typically means agent_knowledge/ wasn't deployed to the server.
  if (!prompt.trim()) {
    throw new Error(
      `[Agent] system prompt is empty — agent_knowledge/instructions/ missing or unreadable at ${INSTRUCTIONS_DIR}. ` +
      `Missing files: ${missing.join(", ")}. ` +
      `Run deploy-full.ps1 (or copy agent_knowledge/ to the server) and restart the process.`
    );
  }
  if (missing.length > 0) {
    console.warn(`[Agent] buildSystemPrompt(${mode}, kind=${kind ?? "?"}): ${missing.length} instruction file(s) missing: ${missing.join(", ")}`);
  }
  return prompt;
}

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
    const raw = fs.readFileSync(filePath, "utf-8");
    return renderTemplate(raw, buildTemplateVars());
  } catch { return ""; }
}

function getAvailableSkills(): string[] {
  try {
    return fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".md")).map(f => f.replace(".md", ""));
  } catch { return []; }
}

function buildFakeTelegramUser(args: any = {}): any {
  const rawUserId = args.userId ?? args.id ?? -100;
  const userId = Number(rawUserId);
  const suffix = String(rawUserId).replace(/^-/, "");
  return {
    id: Number.isFinite(userId) ? userId : -100,
    first_name: String(args.firstName || args.first_name || `Simulate${rawUserId}`),
    username: String(args.username || `simulate_${suffix}`),
    language_code: String(args.languageCode || args.language_code || "en"),
  };
}

function fakeInitDataFor(userArgs: any = {}): string {
  const user = buildFakeTelegramUser(userArgs);
  return `user=${encodeURIComponent(JSON.stringify(user))}&auth_date=${Math.floor(Date.now() / 1000)}&hash=${"0".repeat(64)}`;
}

function isJsonLookingString(value: any): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function jsonLookingStringError(context: string): string {
  return `${context} received a JSON-looking string. Pass a real array/object instead, not a stringified JSON value.`;
}

function parseJsonValueForDisplay(raw: string): any {
  try { return JSON.parse(raw); } catch { return raw; }
}

// All instruction blocks moved to agent_knowledge/instructions/*.md and assembled
// per-build via buildSystemPrompt(mode). Skills (frontend, backend, bot-management,
// websocket, ton-payments) live in agent_knowledge/skills/ and are still loaded
// on-demand by the model via the load_skill tool.



// Tool definitions in Anthropic schema format — converted to OpenAI format at call time.
const TOOLS_DEFS: Array<{ name: string; description: string; input_schema: Record<string, any> }> = [
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
    description: "Read a TEXT file from the project. Supports optional line range to read only specific lines (1-indexed). Returns numbered lines. NEVER call on binary files (images .png/.jpg/.jpeg/.gif/.webp, video, audio, fonts, archives, .pdf, .db, etc.) — they will be refused. Reference image assets directly in HTML/CSS via their path (e.g. <img src=\"assets/foo.jpg\">) without reading them. For text files >256KB you MUST pass offset+limit; full reads are capped.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "File path relative to project root. Must point to a text file." },
        offset: { type: "number" as const, description: "Start line number (1-indexed, optional)" },
        limit: { type: "number" as const, description: "Number of lines to read (optional). Required for files larger than 256KB." },
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
    name: "db",
    description: "Read/write project database (JSON key-value store backed by SQLite). get(key) returns parsed JSON or null. set(key, value) stores any JSON value. Pass real arrays/objects, not stringified JSON. delete(key) removes a key. keys() lists all keys.",
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
    name: "ask_user",
    description: "Ask the app owner a question and wait for their answer. Use ONLY when you truly need user input (API keys, credentials, external account IDs, design choices, naming, or choosing between fundamentally different approaches). If a requested feature requires an API key/credential and no public no-key alternative exists, you MUST call ask_user instead of inventing placeholders, using process.env, or shipping fake/mock behavior. Do NOT use for trivial implementation details you can decide yourself. Provide options as buttons when possible. The user can also type free text or press Skip.",
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
    name: "technical_plan",
    description: "MANDATORY first planning tool for new builds. Submit the concrete implementation contract before writing code. The schema is kind-specific: App uses dbKeys/restEndpoints/wsMessages/screens; Text Bot uses stateShape/conversationFlow/keyboards/commands/testScenarios; Game uses coordinateSystem/sceneGraph/camera/input/collision/stateMachine/performanceBudget. If the app needs external APIs, list them in externalDependencies and call ask_user first for any required credentials. After this, code must match the submitted names exactly.",
    input_schema: {
      type: "object" as const,
      properties: {
        kind: { type: "string" as const, enum: ["app", "game", "textBot"], description: "Project kind this plan targets" },
        summary: { type: "string" as const, description: "One-sentence architecture summary" },
        dbKeys: { type: "array" as const, items: { type: "object" as const }, description: "DB key contracts: key pattern + stored shape" },
        restEndpoints: { type: "array" as const, items: { type: "object" as const }, description: "REST contracts: method, path, auth, input, output" },
        wsMessages: { type: "array" as const, items: { type: "object" as const }, description: "WebSocket message contracts with direction/type/fields" },
        screens: { type: "array" as const, items: { type: "object" as const }, description: "Frontend screens/components and their data/events" },
        botBehavior: { type: "array" as const, items: { type: "object" as const }, description: "Optional bot commands/callback/deep-link behaviour for Mini Apps" },
        stateShape: { type: "object" as const, description: "Text Bot state object stored under state:{uid}" },
        conversationFlow: { type: "array" as const, items: { type: "object" as const }, description: "Text Bot steps/buttons/callbacks and transitions" },
        keyboards: { type: "array" as const, items: { type: "object" as const }, description: "Text Bot reply/inline keyboards with exact button labels/callback_data" },
        commands: { type: "array" as const, items: { type: "object" as const }, description: "Bot slash commands: command + description" },
        testScenarios: { type: "array" as const, items: { type: "object" as const }, description: "Test cases the agent must run with simulate_* before finish" },
        externalDependencies: { type: "array" as const, items: { type: "object" as const }, description: "External APIs/providers used, whether credentials are required, and whether ask_user is needed before implementation" },
        coordinateSystem: { type: "string" as const, description: "Game coordinate system" },
        sceneGraph: { type: "array" as const, items: { type: "object" as const }, description: "Game scene/group/object graph" },
        camera: { type: "object" as const, description: "Game camera type/follow/smoothing" },
        input: { type: "array" as const, items: { type: "object" as const }, description: "Game input mapping" },
        collision: { type: "object" as const, description: "Game collision/win-loss rules" },
        stateMachine: { type: "array" as const, items: { type: "string" as const }, description: "Game state machine" },
        performanceBudget: { type: "object" as const, description: "Game FPS, pixel ratio, reuse/instancing budget" },
      },
      required: ["kind", "summary"],
    },
  },
  {
    name: "server_logs",
    description: "Read recent logs for this project: routes.js console.log/error output, webhook errors, simulate_telegram and simulate_api results. Call after deploy_to_dev or simulate_* to debug behaviour.",
    input_schema: {
      type: "object" as const,
      properties: {
        lines: { type: "number" as const, description: "How many recent log lines to return (default 50, max 200)" },
      },
      required: [],
    },
  },
  {
    name: "simulate_telegram",
    description: "Simulate a Telegram update (message or callback_query) hitting the bot webhook WITHOUT a real Telegram account. The test user always gets id=-100. All tg() API calls the bot makes are intercepted and returned. Also logged so server_logs shows them. Use after deploy_to_dev to test the bot flow end-to-end.",
    input_schema: {
      type: "object" as const,
      properties: {
        update: {
          type: "object" as const,
          description: "Telegram Update object. For a text message: { message: { from: { id: -100, first_name: 'Test', language_code: 'en' }, chat: { id: -100, type: 'private' }, text: '/start' } }. For a callback: { callback_query: { id: '1', from: { id: -100, first_name: 'Test' }, message: { chat: { id: -100 }, message_id: 1 }, data: 'like:123' } }",
        },
      },
      required: ["update"],
    },
  },
  {
    name: "simulate_api",
    description: "Simulate an HTTP request to the app's backend API routes as a Telegram test user. Defaults to id=-100; pass userId/firstName/username to test multi-user flows. Returns status and response body. Use to test REST endpoints in routes.js.",
    input_schema: {
      type: "object" as const,
      properties: {
        method: { type: "string" as const, description: "HTTP method: GET, POST, PUT, DELETE (default GET)" },
        path: { type: "string" as const, description: "API path relative to the project, e.g. /tasks or /tasks/123" },
        body: { type: "object" as const, description: "Request body for POST/PUT" },
        expectStatus: { type: "number" as const, description: "Optional expected HTTP status for negative tests, e.g. 400 or 401" },
        userId: { type: "number" as const, description: "Telegram user id for this request (default -100). Use different ids for multi-user tests." },
        firstName: { type: "string" as const, description: "Optional Telegram first_name for this simulated user" },
        username: { type: "string" as const, description: "Optional Telegram username for this simulated user" },
      },
      required: ["path"],
    },
  },
  {
    name: "simulate_ws",
    description: "Simulate project WebSocket traffic without real clients. Creates fake clients (default: a=-100, b=-101), initializes module.exports.ws from development/backend/routes.js, can seed DB state, run REST API steps in the same module/db context, send JSON messages, and assert expected outbound event types. Mandatory before finish when technical_plan has wsMessages.",
    input_schema: {
      type: "object" as const,
      properties: {
        scenarioId: { type: "string" as const, description: "Optional id matching a technical_plan.testScenarios item" },
        clients: {
          type: "array" as const,
          items: { type: "object" as const },
          description: "Optional clients: [{ id: 'a', userId: -100 }, { id: 'b', userId: -101 }]",
        },
        seedDb: {
          type: "array" as const,
          items: { type: "object" as const },
          description: "Optional DB seed values before simulation: [{ key: 'matches', value: [{ id: 'm1', users: ['-100','-101'] }] }]. Values must be real JSON, not stringified JSON.",
        },
        messages: {
          type: "array" as const,
          items: { type: "object" as const },
          description: "Messages to send: [{ clientId: 'a', data: { type: 'auth', initData: '...' } }, ...]. Defaults to initData auth for a and b.",
        },
        steps: {
          type: "array" as const,
          items: { type: "object" as const },
          description: "Ordered scenario steps. Supports {type:'ws', clientId, data}, {type:'api', userId, method, path, body, expectStatus}, and {type:'expectWs', expectTypes:['new_msg']}.",
        },
        expectTypes: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Server WebSocket event types expected from this simulation. If omitted, validation falls back to planned server WS types.",
        },
      },
      required: [],
    },
  },
  {
    name: "set_bot_commands",
    description: "Safely set the bot slash-command menu with Telegram setMyCommands. Use for Text Bots after configure_app. Commands must all be handled in /bot-webhook.",
    input_schema: {
      type: "object" as const,
      properties: {
        commands: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              command: { type: "string" as const, description: "Command without leading slash, e.g. start" },
              description: { type: "string" as const, description: "Short user-facing description" },
            },
            required: ["command", "description"],
          },
        },
      },
      required: ["commands"],
    },
  },
  {
    name: "deploy_to_dev",
    description: "Deploy your current code to the development environment for live testing. Runs syntax/contract validators first. After calling this, frontend is available at /dev/{projectId}/, API at /devapi/{projectId}/, and WS at /devws/{projectId}. Call this before simulate_api, simulate_telegram, or simulate_ws.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  // CONSOLIDATED FINISH TOOL — replaces short_summary + summary + done.
  // The model used to split these across 3 iterations (~$0.50 wasted per build).
  // This forces atomic batching at the API level. Old short_summary/summary/done
  // handlers stay in code for backward compatibility but are NOT exposed in TOOLS.
  {
    name: "finish",
    description: "Atomically finish the build: save short user-facing summary, detailed technical summary, and signal completion — all in ONE call. This is the ONLY way to finish a build. Call this LAST, after technical_plan, file writes, deploy_to_dev, validators, and required simulate_* tests pass. There is NO separate done/summary/short_summary tool.",
    input_schema: {
      type: "object" as const,
      properties: {
        shortSummary: {
          type: "string" as const,
          description: "Short user-facing summary, format: 'Update title (3-5 words)\\n\\n1-2 sentences in simple non-technical language.' No jargon.",
        },
        summary: {
          type: "string" as const,
          description: "Detailed technical summary/changelog: architecture decisions, new files, changes made, anything the next update should know.",
        },
      },
      required: ["shortSummary", "summary"],
    },
  },
  // CONSOLIDATED APP CONFIG TOOL — stores app profile metadata in Apps Father
  // first, then configures the linked Telegram bot when a token is available.
  {
    name: "configure_app",
    description: "Save the app's name, description, long description, and menu button text in Apps Father core DB, then configure the Telegram bot if it is already linked. ONLY use on FIRST build, never on updates. If no bot token is connected yet, the saved data will be applied automatically when the bot is later created and connected. Use this INSTEAD of telegram_api(setMyName/setMyDescription/setMyShortDescription/setChatMenuButton).",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "App and bot display name (up to 64 chars)" },
        description: { type: "string" as const, description: "Short app/bot description shown in Telegram previews (up to 120 chars)" },
        longDescription: { type: "string" as const, description: "Long bot profile description shown in Telegram profile (up to 512 chars)" },
        menuButtonText: { type: "string" as const, description: "Text for the Mini App menu button (e.g. 'Launch App'). Use empty string for Text Bots." },
      },
      required: ["name", "description", "longDescription"],
    },
  },
];

// Pre-converted OpenAI-format tools (computed once at startup).
const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = TOOLS_DEFS.map(toOpenAITool);

// OpenRouter server tools — executed transparently by OpenRouter before returning
// the response to the client. The model can call these; OpenRouter resolves them.
const SERVER_TOOLS: any[] = [
  { type: "openrouter:datetime" },
  { type: "openrouter:web_search", parameters: { max_results: 5, max_total_results: 15 } },
  { type: "openrouter:web_fetch" },
  { type: "openrouter:image_generation" },
];

// Commands that must never run
const BLOCKED_COMMANDS = [
  "rm -rf /", "shutdown", "reboot", "mkfs", "dd if=",
  "chmod 777 /", "chown", "passwd", "useradd", "userdel",
  "systemctl", "service ", "kill -9 1", "pkill",
];

const BLOCKED_INFRA_SHELL_PATTERNS = [
  /\bfind\s+\//i,
  /\/opt\/apps-father-dev\/(?:dist|projects)/i,
  /\b(?:ps|netstat|ss|lsof)\b/i,
  /\blocalhost:\d+\b/i,
];

export type AgentStepKind =
  | "thinking"
  | "reading"
  | "writing"
  | "editing"
  | "searching"
  | "shell"
  | "fetch"
  | "db"
  | "telegram"
  | "deploying"
  | "configuring"
  | "skill"
  | "ask"
  | "done";

export type AgentEventType =
  | "step_start"
  | "step_end"
  | "narration_start"
  | "narration_chunk"
  | "narration_end"
  | "writing_chunk";    // tool-call arguments streaming (for UI live preview)

export interface AgentProgress {
  action: string;
  detail: string;
  percent?: number;
  costUsd?: number;
  balance?: number;
  // Structured event vocabulary (additive — legacy consumers ignore these).
  // When `event` is set, the message represents one of:
  //   step_start / step_end        — per-tool action with kind + target + meta
  //   narration_start / _chunk / _end — streamed assistant text per iteration
  // When `event` is undefined, this is a legacy progress tick.
  event?: AgentEventType;
  stepId?: string;
  kind?: AgentStepKind;
  toolName?: string;
  title?: string;
  target?: { file?: string; range?: string; url?: string; key?: string };
  status?: "ok" | "error";
  meta?: Record<string, any>;
  delta?: string;
  text?: string;
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

export class AgentService {
  private isEmptyResponse(response: any): boolean {
    const choices = Array.isArray(response?.choices) ? response.choices : [];
    const msg = choices[0]?.message as any;
    const toolCalls = msg?.tool_calls || [];
    const content = typeof msg?.content === "string" ? msg.content : "";
    const reasoning = msg?.reasoning_content || msg?.reasoning || "";
    const completionTokens = (response.usage as any)?.completion_tokens || 0;
    return choices.length === 0 || (toolCalls.length === 0 && !content.trim() && !String(reasoning || "").trim() && completionTokens === 0);
  }

  private invalidResponseReason(response: any): string | null {
    if (!response || typeof response !== "object") return "response is not an object";
    if (!Array.isArray(response.choices)) return "response.choices is missing or not an array";
    if (response.choices.length === 0) return "response.choices is empty";
    if (!response.choices[0]?.message) return "response.choices[0].message is missing";
    return null;
  }

  private getProviderRouting(modelId: string, provider?: string): any | undefined {
    const selectedProvider = provider?.trim();
    if (selectedProvider) {
      return { only: [selectedProvider], allow_fallbacks: false };
    }
    return undefined;
  }

  private validateFrontendMarkup(frontendText: string, projectDir?: string, kind?: string): string[] {
    const errors: string[] = [];
    if (!frontendText.trim()) return errors;

    const badAttrExamples: string[] = [];
    const identityAttrRe = /\b(?:id|class|for|name|aria-labelledby|aria-describedby|aria-controls)\s*=\s*(["'])([^"'<>]*(?:\\["']|&quot;|&#34;|&#39;)[^"'<>]*)\1/gi;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = identityAttrRe.exec(frontendText)) && badAttrExamples.length < 3) {
      badAttrExamples.push(attrMatch[0].slice(0, 80));
    }
    if (badAttrExamples.length > 0) {
      errors.push(`Frontend HTML contains escaped/nested quotes inside identity attributes (${badAttrExamples.join(", ")}). Use plain values like id="game-canvas", not id="\\"game-canvas\\"".`);
    }

    if (/\bgetElementById\s*\(\s*(["'`])(?:\\["']|["'])/.test(frontendText)) {
      errors.push(`Frontend JS queries a quoted/escaped id. Use document.getElementById("game-canvas"), not document.getElementById("\\"game-canvas\\"").`);
    }
    if (/\bquerySelector(?:All)?\s*\(\s*(["'`])[#.](?:\\["']|["'])/.test(frontendText)) {
      errors.push(`Frontend JS queries a malformed quoted selector. Use document.querySelector("#game-canvas"), not document.querySelector("#\\"game-canvas\\"").`);
    }

    // Validate that index.html references app.js and styles.css.
    // Use plain substring checks (not regex) so cache-busting query strings
    // like app.js?r=234 or attribute order variations don't trip false positives.
    if (kind !== "textBot" && projectDir) {
      const frontendDir = path.join(projectDir, "frontend");
      const indexPath = path.join(frontendDir, "index.html");
      if (fs.existsSync(indexPath)) {
        const indexHtml = fs.readFileSync(indexPath, "utf-8");
        if (!indexHtml.includes("app.js")) {
          errors.push('frontend/index.html does not reference app.js. All apps must load app.js (e.g. <script src="app.js"></script>).');
        }
        if (!indexHtml.includes("styles.css")) {
          errors.push('frontend/index.html does not reference styles.css. All apps must load styles.css (e.g. <link rel="stylesheet" href="styles.css">).');
        }
      }
    }

    // Syntax check app.js
    if (projectDir) {
      const appJsPath = path.join(projectDir, "frontend", "app.js");
      if (fs.existsSync(appJsPath)) {
        const appJsContent = fs.readFileSync(appJsPath, "utf-8");
        try {
          new Function(appJsContent);
        } catch (err: any) {
          errors.push(`frontend/app.js has a JavaScript syntax error: ${err.message}.`);
        }
        // Detect Cyrillic text in single-quoted strings with unescaped apostrophe
        // Pattern: '...CyrillicChars...'...CyrillicChars...' — inner apostrophe breaks string
        if (/'[^'\\\n]*[\u0400-\u04FF][^'\\\n]*'[^'\\\n]*[\u0400-\u04FF][^'\\\n]*'/.test(appJsContent)) {
          errors.push("frontend/app.js may have a broken string: a single-quoted JS string appears to contain an apostrophe inside Cyrillic text (e.g. зв'язок terminates the string early). Use double quotes or template literals: \"Це зв'язок\" or `Це зв'язок`.");
        }
      }
    }

    return errors;
  }

  private validateBackendRoutes(
    projectDir: string,
    projectId: string,
    kind: ProjectKind = DEFAULT_PROJECT_KIND,
    technicalPlan?: any,
  ): string | null {
    const errors: string[] = [];
    const routesPath = path.join(projectDir, "backend", "routes.js");
    const frontendDir = path.join(projectDir, "frontend");
    const frontendIndex = path.join(frontendDir, "index.html");
    const frontendApp = path.join(frontendDir, "app.js");
    const frontendStyles = path.join(frontendDir, "styles.css");
    const frontendText = [frontendIndex, frontendApp, frontendStyles]
      .filter(p => fs.existsSync(p))
      .map(p => fs.readFileSync(p, "utf-8"))
      .join("\n");
    const routesText = fs.existsSync(routesPath) ? fs.readFileSync(routesPath, "utf-8") : "";

    const hasFrontendFiles = this.dirHasFiles(frontendDir);
    errors.push(...this.validateFrontendMarkup(frontendText, projectDir, kind));
    if (/\bprocess\s*\.\s*env\b/.test(routesText + "\n" + frontendText)) {
      errors.push("Generated app code must not read process.env. Project code cannot access platform environment variables; if a feature needs an API key or credential, call ask_user before coding or use a public no-key API.");
    }

    if (kind === "textBot" && hasFrontendFiles) {
      errors.push("Text Bot builds must not contain frontend files. Delete frontend/ files and keep only backend/routes.js.");
    }
    if (kind === "game") {
      // Games must have all three frontend files (index.html + styles.css + app.js)
      if (!fs.existsSync(frontendApp)) {
        errors.push("Game builds require frontend/app.js. Move game logic out of index.html into app.js.");
      }
      if (!fs.existsSync(frontendStyles)) {
        errors.push("Game builds require frontend/styles.css. Move inline styles out of index.html into styles.css.");
      }
      // routes.js is optional for games — only error if present without planned endpoints
      if (fs.existsSync(routesPath)) {
        const gameBackend = routesText.trim();
        const gameNeedsBackend = this.plannedEndpoints(technicalPlan).length > 0 || this.plannedWsTypes(technicalPlan).length > 0;
        if (gameBackend.length > 0 && !gameNeedsBackend) {
          errors.push("Game builds must not include backend/routes.js unless the game truly needs server-side multiplayer or shared persistence.");
        }
      }
    }

    if (!fs.existsSync(routesPath)) {
      if (kind === "textBot") {
        errors.push("Text Bot builds must create backend/routes.js with router.post(\"/bot-webhook\", ...).");
      }
      if (this.plannedEndpoints(technicalPlan).length > 0 || this.plannedWsTypes(technicalPlan).length > 0) {
        errors.push("Technical plan includes backend endpoints or WebSocket messages, but backend/routes.js does not exist.");
      }
      return errors.length ? errors.join(" ") : null;
    }

    const content = routesText;
    try {
      new Function(content);
    } catch (err: any) {
      errors.push(`backend/routes.js has a JavaScript syntax error: ${err.message}.`);
    }

    // SQL-style comments (-- ...) are a syntax error in JavaScript.
    if (/^--\s/m.test(content)) {
      errors.push(`backend/routes.js contains SQL-style comments (-- ...) which are a syntax error in JavaScript. Replace every -- comment with a // comment and redeploy.`);
    }

    // Allow optional extra parameters after the required three (e.g. env, config).
    const hasPlatformExport = /module\.exports\s*=\s*function\s*\(\s*router\s*,\s*db\s*,\s*projectId\s*[,)]/.test(content);
    if (!hasPlatformExport) {
      errors.push(`backend/routes.js has invalid Apps Father format. It must export exactly: module.exports = function(router, db, projectId) { ... }. Do not export a route map/object.`);
    }
    if (/module\.exports\s*=\s*routes\b/.test(content) || /^\s*const\s+routes\s*=\s*\{/m.test(content)) {
      errors.push(`backend/routes.js uses object-style routes. Rewrite with Express router calls inside module.exports = function(router, db, projectId) { router.get('/path', ...); }.`);
    }
    const missingSlashRoutes: string[] = [];
    const routePathRe = /router\.(get|post|put|patch|delete|all)\s*\(\s*["']([^/"'][^"']*)["']/g;
    let routePathMatch: RegExpExecArray | null;
    while ((routePathMatch = routePathRe.exec(content)) && missingSlashRoutes.length < 5) {
      missingSlashRoutes.push(`router.${routePathMatch[1]}("${routePathMatch[2]}")`);
    }
    if (missingSlashRoutes.length > 0) {
      errors.push(`backend/routes.js has route paths missing a leading slash (${missingSlashRoutes.join(", ")}). Use router.get('/words', ...) not router.get('words', ...).`);
    }
    if (/['"`]\s*(GET|POST|PUT|PATCH|DELETE)\s+\/api\//i.test(content)) {
      errors.push(`backend/routes.js contains object-style API route keys like "GET /api/...". Use router.get('/path', ...) and never include /api/{projectId} in backend route paths.`);
    }
    const escapedProjectId = projectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`/api/${escapedProjectId}(?:/|['"\`])`).test(content) || /\/api\/[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(content)) {
      errors.push(`backend/routes.js hardcodes /api/{projectId}. Backend routes must be relative, for example router.get('/videos', ...).`);
    }

    if (kind === "textBot") {
      if (!/router\.post\s*\(\s*["']\/bot-webhook["']/.test(content)) {
        errors.push(`Text Bot backend must register router.post("/bot-webhook", ...).`);
      }
      if (/Telegram\.WebApp/.test(content + "\n" + frontendText)) {
        errors.push("Text Bot code must not reference Telegram.WebApp because there is no Mini App frontend.");
      }
      if (/\b(?:setWebhook|deleteWebhook)\b/.test(content)) {
        errors.push("Project code must not call setWebhook/deleteWebhook; the platform owns the webhook.");
      }
      if (/db\.[A-Za-z_$][\w$]*\s*=/.test(content)) {
        errors.push("Text Bot state must use db.get/db.set, not direct db.property assignments.");
      }
      if (/state\.step\s*=/.test(content) && !/\b(?:saveState|setState)\s*\(/.test(content)) {
        errors.push("Text Bot changes state.step but has no saveState/setState helper call.");
      }
    }

    if (kind === "app") {
      if (/\b(?:const|let|var)\s+db\s*=\s*\{[\s\S]{0,800}\bget\s*\([^)]*\)[\s\S]{0,800}\bset\s*\([^)]*\)/.test(frontendText)) {
        errors.push("Frontend contains a fake client-side db mock. Mini App frontend must use REST/WS APIs for persisted state, not a local db object.");
      }
      if (/text\.split\s*\(\s*\/\\t\/\s*\)|text\.split\s*\(\s*["']\\t["']\s*\)/.test(content)) {
        errors.push("Bot /start parsing splits only on tabs. Use text.split(/\\s+/) so deep-link parameters work from normal Telegram messages.");
      }
    }

    const frontendUsesWs = /new\s+WebSocket\s*\(/.test(frontendText);
    const backendHasWs = /module\.exports\.ws\s*=/.test(content);
    if (frontendUsesWs && !backendHasWs) {
      errors.push("Frontend opens a WebSocket, but backend/routes.js does not export module.exports.ws.");
    }
    if (backendHasWs && kind !== "textBot") {
      if (!frontendUsesWs) errors.push("Backend exports module.exports.ws, but frontend does not create a WebSocket client.");
      if (frontendUsesWs && !/onclose\s*=|addEventListener\(\s*["']close/.test(frontendText)) {
        errors.push("WebSocket frontend must implement reconnect/onclose handling.");
      }
      if (frontendUsesWs && /type\s*:\s*["']auth["']/.test(content) && !/type\s*:\s*["']auth["']/.test(frontendText)) {
        errors.push("Backend expects WS auth messages, but frontend does not send { type: 'auth', ... }.");
      }
      const trustsClientUserId =
        /data\.type\s*={2,3}\s*["']auth["'][\s\S]{0,500}(?:myUserId|userId)\s*=\s*String\s*\(\s*data\.userId\s*\)/.test(content) ||
        /online\.set\s*\(\s*String\s*\(\s*data\.userId\s*\)/.test(content);
      if (trustsClientUserId) {
        errors.push("WebSocket auth trusts data.userId from the client. Send Telegram initData (or another signed platform token) and derive the user id server-side before routing private events.");
      }
      if (/["']send_msg["']/.test(content) && /matches?/.test(content)) {
        const checksMatchMembership =
          (
            /\.users\.includes\s*\(/.test(content) ||
            /matchUsers[\s\S]{0,300}\.includes\s*\(/.test(content) ||
            /matchUsers[\s\S]{0,300}\.indexOf\s*\([^)]*\)\s*!={1,2}\s*-1/.test(content) ||
            /matchUsers[\s\S]{0,300}\.indexOf\s*\([^)]*\)\s*={2,3}\s*-1[\s\S]{0,200}(?:not_allowed|return)/.test(content) ||
            /\.users\.some\s*\(/.test(content)
          ) &&
          (
            /(?:match|matches)\.find\s*\(/.test(content) ||
            /for\s*\([^)]*matches\.length[\s\S]{0,700}\bmatch\s*=/.test(content) ||
            /matches\.some\s*\(/.test(content)
          ) &&
          /(?:myUserId|auth\.telegramId|telegramId|senderId|fromUserId)/.test(content) &&
          /(?:toUserId|recipientId|targetId|otherUserId)/.test(content) &&
          /(?:not_allowed|403|Unauthorized|Forbidden)/i.test(content);
        if (!checksMatchMembership) {
          errors.push("Private chat send_msg handler must verify the sender belongs to the match before persisting or forwarding messages.");
        }
      }
    }

    const plannedEndpointError = this.validatePlannedEndpoints(content, technicalPlan);
    if (plannedEndpointError) errors.push(plannedEndpointError);
    const plannedWsError = this.validatePlannedWsTypes(content + "\n" + frontendText, technicalPlan);
    if (plannedWsError) errors.push(plannedWsError);

    return errors.length ? errors.join(" ") : null;
  }

  private validateFinishReadiness(
    kind: ProjectKind,
    mode: AgentMode,
    technicalPlan: any,
    testsRun: { telegram: boolean; api: boolean; ws: boolean },
    deployed: boolean,
    testResults: Array<{ tool: string; ok: boolean; detail: string }> = [],
    wsCoverage: { types: Set<string>; scenarios: Set<string> } = { types: new Set(), scenarios: new Set() },
    hasBotToken = false,
  ): string | null {
    const latestResult = (tool: string) => {
      const r = [...testResults].reverse().find(t => t.tool === tool);
      return r ? ` Last ${tool} result: ${r.detail}` : "";
    };
    if (mode === "new" && !technicalPlan) {
      return "technical_plan is required before finish().";
    }
    if (!deployed) {
      return "deploy_to_dev() must succeed before finish().";
    }
    // simulate_telegram is only required when a real bot token is already
    // linked — without one the webhook exists in code but can't be invoked
    // through Telegram and will be wired up automatically when the user
    // creates and connects their bot later.
    if (hasBotToken) {
      if (kind === "textBot" && !testsRun.telegram) {
        return `Text Bot builds must pass simulate_telegram before finish().${latestResult("simulate_telegram")}`;
      }
      if (kind === "app" && Array.isArray(technicalPlan?.botBehavior) && technicalPlan.botBehavior.length > 0 && !testsRun.telegram) {
        return `App builds with planned bot behavior must pass simulate_telegram before finish().${latestResult("simulate_telegram")}`;
      }
    }
    if (kind === "app" && this.plannedEndpoints(technicalPlan).length > 0 && !testsRun.api) {
      return `App builds with planned REST endpoints must pass simulate_api before finish().${latestResult("simulate_api")}`;
    }
    if (this.plannedWsTypes(technicalPlan).length > 0) {
      const wsScenarioIds = this.plannedWsScenarioIds(technicalPlan);
      if (wsScenarioIds.length > 0) {
        const missingScenarios = wsScenarioIds.filter(id => !wsCoverage.scenarios.has(id));
        if (missingScenarios.length > 0) {
          return `Real-time builds must pass planned WebSocket test scenario(s) before finish(): ${missingScenarios.join(", ")}.${latestResult("simulate_ws")}`;
        }
      } else {
        const missingTypes = this.plannedServerWsTypes(technicalPlan).filter(type => !wsCoverage.types.has(type));
        if (missingTypes.length > 0) {
          return `Real-time builds with planned WebSocket messages must pass simulate_ws before finish(). Missing observed server type(s): ${missingTypes.join(", ")}.${latestResult("simulate_ws")}`;
        }
        if (this.plannedServerWsTypes(technicalPlan).length === 0 && !testsRun.ws) {
          return `Real-time builds with planned WebSocket messages must pass simulate_ws before finish().${latestResult("simulate_ws")}`;
        }
      }
    }
    return null;
  }

  private dirHasFiles(dir: string): boolean {
    if (!fs.existsSync(dir)) return false;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) return true;
      if (entry.isDirectory() && this.dirHasFiles(path.join(dir, entry.name))) return true;
    }
    return false;
  }

  private extractRoutes(content: string): Array<{ method: string; path: string }> {
    const routes: Array<{ method: string; path: string }> = [];
    const re = /router\.(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`]+)["'`]/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) routes.push({ method: m[1].toUpperCase(), path: m[2] });
    return routes;
  }

  private plannedEndpoints(plan: any): Array<{ method: string; path: string }> {
    const endpoints = Array.isArray(plan?.restEndpoints) ? plan.restEndpoints : [];
    return endpoints.map((e: any) => {
      if (typeof e === "string") {
        const m = e.match(/^\s*(GET|POST|PUT|PATCH|DELETE)\s+(\S+)/i);
        return m ? { method: m[1].toUpperCase(), path: m[2] } : null;
      }
      const method = (e?.method || e?.verb || "").toString().toUpperCase();
      const p = (e?.path || e?.route || "").toString();
      return method && p ? { method, path: p } : null;
    }).filter(Boolean) as Array<{ method: string; path: string }>;
  }

  private validatePlannedEndpoints(routesContent: string, plan: any): string | null {
    const planned = this.plannedEndpoints(plan);
    if (planned.length === 0) return null;
    const actual = this.extractRoutes(routesContent);
    const missing = planned.filter(p => !actual.some(a => a.method === p.method && a.path === p.path));
    return missing.length > 0
      ? `Backend is missing planned REST endpoint(s): ${missing.map(e => `${e.method} ${e.path}`).join(", ")}.`
      : null;
  }

  private plannedWsTypes(plan: any): string[] {
    const messages = Array.isArray(plan?.wsMessages) ? plan.wsMessages : [];
    const types: string[] = messages.map((m: any) => typeof m === "string" ? m : m?.type).filter(Boolean).map(String);
    return [...new Set(types)];
  }

  private plannedServerWsTypes(plan: any): string[] {
    const messages = Array.isArray(plan?.wsMessages) ? plan.wsMessages : [];
    const types: string[] = [];
    for (const msg of messages) {
      if (typeof msg === "string") {
        types.push(msg);
        continue;
      }
      const type = msg?.type ? String(msg.type) : "";
      if (!type) continue;
      const direction = String(msg?.direction || msg?.dir || "").toLowerCase();
      const clientToServer = /^client\s*(?:→|->|to)\s*server/.test(direction) || direction.includes("client→server") || direction.includes("client->server");
      const serverToClient = /^server\s*(?:→|->|to)\s*client/.test(direction) || direction.includes("server→client") || direction.includes("server->client") || direction.includes("client←server");
      if (!direction || serverToClient || (!clientToServer && direction.includes("server"))) {
        types.push(type);
      }
    }
    return [...new Set(types)];
  }

  private validatePlannedWsTypes(allCode: string, plan: any): string | null {
    const types = this.plannedWsTypes(plan);
    if (types.length === 0) return null;
    const missing = types.filter(t => !new RegExp(`["']${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(allCode));
    return missing.length > 0
      ? `Code is missing planned WebSocket message type(s): ${missing.join(", ")}.`
      : null;
  }

  private plannedWsScenarioIds(plan: any): string[] {
    const scenarios = Array.isArray(plan?.testScenarios) ? plan.testScenarios : [];
    return scenarios
      .map((scenario: any, index: number) => {
        if (typeof scenario === "string") return null;
        const hasWs =
          scenario?.tool === "simulate_ws" ||
          scenario?.type === "simulate_ws" ||
          scenario?.kind === "ws" ||
          Array.isArray(scenario?.expectTypes) ||
          Array.isArray(scenario?.wsMessages) ||
          Array.isArray(scenario?.steps) && scenario.steps.some((step: any) => String(step?.type || step?.action || "").toLowerCase().includes("ws"));
        if (!hasWs) return null;
        return String(scenario?.id || scenario?.scenarioId || scenario?.name || `scenario-${index + 1}`);
      })
      .filter(Boolean) as string[];
  }

  private observedWsTypes(sim: any): Set<string> {
    const captured = Object.values(sim?.captured || {}).flat().map(String);
    const observed = new Set<string>();
    for (const raw of captured) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed?.type) observed.add(String(parsed.type));
      } catch {
        const match = raw.match(/"type"\s*:\s*"([^"]+)"/);
        if (match) observed.add(match[1]);
      }
    }
    return observed;
  }

  private validateWsSimulation(sim: any, plan: any): string | null {
    const explicitExpected = Array.isArray(sim?.expectedTypes) ? sim.expectedTypes.map(String).filter(Boolean) : [];
    const expected: string[] = explicitExpected.length > 0 ? [...new Set<string>(explicitExpected)] : this.plannedServerWsTypes(plan);
    if (expected.length === 0) return null;

    const observed = this.observedWsTypes(sim);

    const missing = expected.filter(type => !observed.has(type));
    if (missing.length > 0) {
      return `simulate_ws did not observe expected server WebSocket message type(s): ${missing.join(", ")}. Send scenario messages that trigger the expected event(s), or pass only the expectTypes for this scenario.`;
    }
    return null;
  }

  /**
   * Stream a chat.completions call and assemble it into a synthetic
   * ChatCompletion so the rest of runAgent stays unchanged.
   *
   * Assembles:
   *   - assistant text from delta.content (forwarded via onTextDelta)
   *   - reasoning from delta.reasoning_content / delta.reasoning
   *   - tool_calls from delta.tool_calls[index] fragments (id / name / arguments)
   *   - usage from the final chunk (requires stream_options.include_usage)
   *
   * Caller is responsible for the one-shot fallback if this throws.
   */
  private async streamAgentCall(
    params: any,
    opts: {
      onTextDelta?: (delta: string, full: string) => void;
      onReasoningDelta?: (delta: string, full: string) => void;
      onToolArgsDelta?: (toolName: string, argsDelta: string, argsFull: string) => void;
    } = {},
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const client = getOpenRouterClient();
    const streamParams = {
      ...params,
      stream: true,
      stream_options: { include_usage: true },
    };

    const stream = (await client.chat.completions.create(streamParams as any)) as any;

    let assistantText = "";
    let reasoning = "";
    const toolCallAcc = new Map<number, { id?: string; name: string; args: string }>();
    let usage: any = undefined;
    let finishReason: string | null = null;
    let modelEcho: string | undefined;
    let id: string | undefined;

    for await (const chunk of stream as AsyncIterable<any>) {
      if (!chunk) continue;
      if (chunk.id) id = chunk.id;
      if (chunk.model) modelEcho = chunk.model;
      if (chunk.usage) usage = chunk.usage;

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta || {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        assistantText += delta.content;
        try { opts.onTextDelta?.(delta.content, assistantText); } catch {}
      }
      const reasonDelta = (delta as any).reasoning_content || (delta as any).reasoning;
      if (typeof reasonDelta === "string" && reasonDelta.length > 0) {
        reasoning += reasonDelta;
        try { opts.onReasoningDelta?.(reasonDelta, reasoning); } catch {}
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls as any[]) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          const acc = toolCallAcc.get(idx) || { name: "", args: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = (acc.name || "") + tc.function.name;
          if (tc.function?.arguments) {
            acc.args += tc.function.arguments;
            try { opts.onToolArgsDelta?.(acc.name, tc.function.arguments, acc.args); } catch {}
          }
          toolCallAcc.set(idx, acc);
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const tool_calls = [...toolCallAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, v]) => ({
        id: v.id || `call_${idx}`,
        type: "function" as const,
        function: { name: v.name || "", arguments: v.args || "{}" },
      }));

    const fakeMessage: any = {
      role: "assistant",
      content: assistantText,
    };
    if (tool_calls.length > 0) fakeMessage.tool_calls = tool_calls;
    if (reasoning) fakeMessage.reasoning_content = reasoning;

    return {
      id: id || "stream",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelEcho || params.model,
      choices: [{
        index: 0,
        message: fakeMessage,
        finish_reason: (finishReason || (tool_calls.length > 0 ? "tool_calls" : "stop")) as any,
        logprobs: null,
      }],
      usage,
    } as any;
  }

  private async callWithRetry(params: any, maxRetries = 3): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const client = getOpenRouterClient();
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await client.chat.completions.create(params);
        const invalidReason = this.invalidResponseReason(response);
        if (invalidReason && attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          console.warn(`[Agent] Malformed model response (${invalidReason}). Retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (invalidReason) {
          throw new Error(`Malformed model response from ${params.model}: ${invalidReason}`);
        }
        if (this.isEmptyResponse(response) && attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          console.warn(`[Agent] Empty model response. Retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (this.isEmptyResponse(response)) {
          throw new Error(`Empty model response from ${params.model}`);
        }
        return response;
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
    tierId?: string,
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

    const modelCfg = runtimeConfig.getModelConfig("ask", tierId);
    const askReasoningBudget = (modelCfg as any).reasoningBudget ?? 0;
    const askSessionId = crypto.randomUUID();
    const askProject = await projectService.getProject(projectId);
    const askOwner = (askProject as any)?.userId
      ? await prisma.user.findUnique({ where: { id: (askProject as any).userId }, select: { telegramId: true } })
      : null;
    const askTelegramId = askOwner?.telegramId ? String(askOwner.telegramId) : undefined;
    const client = getOpenRouterClient();
    const stream = await client.chat.completions.create({
      model: modelCfg.modelId,
      max_tokens: modelCfg.maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
      ...(askTelegramId ? { user: askTelegramId } : {}),
      extra_body: { session_id: askSessionId },
      ...(this.getProviderRouting(modelCfg.modelId, modelCfg.provider) ? { provider: this.getProviderRouting(modelCfg.modelId, modelCfg.provider) } : {}),
      ...(askReasoningBudget > 0 ? { reasoning: { max_tokens: askReasoningBudget } } : {}),
      stream: true,
    } as any) as any;

    let fullText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        fullText += delta;
        onChunk(delta, fullText);
      }
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens || 0;
        outputTokens = chunk.usage.completion_tokens || 0;
      }
    }

    return {
      text: fullText || "Unable to answer.",
      inputTokens,
      outputTokens,
    };
  }

  async getSuggestions(projectId: string, lang?: string, tierId?: string): Promise<{ title: string; description: string }[]> {
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

    const modelCfg = runtimeConfig.getModelConfig("suggestions", tierId);
    const suggReasoningBudget = (modelCfg as any).reasoningBudget ?? 0;
    const suggSessionId = crypto.randomUUID();
    const suggOwner = (project as any)?.userId
      ? await prisma.user.findUnique({ where: { id: (project as any).userId }, select: { telegramId: true } })
      : null;
    const suggTelegramId = suggOwner?.telegramId ? String(suggOwner.telegramId) : undefined;
    const client = getOpenRouterClient();
    const response = await client.chat.completions.create({
      model: modelCfg.modelId,
      max_tokens: modelCfg.maxTokens,
      messages: [{ role: "user", content: prompt }],
      ...(suggTelegramId ? { user: suggTelegramId } : {}),
      session_id: suggSessionId,
      ...(this.getProviderRouting(modelCfg.modelId, modelCfg.provider) ? { provider: this.getProviderRouting(modelCfg.modelId, modelCfg.provider) } : {}),
      ...(suggReasoningBudget > 0 ? { reasoning: { max_tokens: suggReasoningBudget } } : {}),
    } as any);

    const text = response.choices[0]?.message?.content || "";
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

  private async simulateProjectWs(projectRootDir: string, projectId: string, args: any): Promise<any> {
    const routesPath = path.join(projectRootDir, "development", "backend", "routes.js");
    if (!fs.existsSync(routesPath)) {
      throw new Error("development/backend/routes.js not found. Call deploy_to_dev first.");
    }

    const Database = require("better-sqlite3");
    const dataDir = path.join(projectRootDir, "development", "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const sqlite = new Database(path.join(dataDir, "app.db"));
    sqlite.pragma("journal_mode = WAL");
    sqlite.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)");
    const project = await projectService.getProject(projectId);
    const db = {
      get(key: string) {
        const row = sqlite.prepare("SELECT value FROM kv WHERE key = ?").get(key) as any;
        return row ? JSON.parse(row.value) : null;
      },
      set(key: string, value: any) {
        if (isJsonLookingString(value)) throw new Error(jsonLookingStringError(`DB seed/set for "${key}"`));
        sqlite.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
      },
      delete(key: string) {
        sqlite.prepare("DELETE FROM kv WHERE key = ?").run(key);
      },
      keys() {
        return (sqlite.prepare("SELECT key FROM kv").all() as any[]).map((r: any) => r.key);
      },
      getAll() {
        const rows = sqlite.prepare("SELECT key, value FROM kv").all() as any[];
        const all: Record<string, any> = {};
        for (const row of rows) all[row.key] = JSON.parse(row.value);
        return all;
      },
      botToken: project?.botTokenEncrypted ? decryptToken(project.botTokenEncrypted) : "SIMULATE_TOKEN",
      botUsername: project?.botUsername || "simulate_bot",
      projectId,
    };

    try {
      for (const seed of Array.isArray(args.seedDb) ? args.seedDb : []) {
        if (!seed?.key) throw new Error("simulate_ws seedDb entries require { key, value }.");
        if (isJsonLookingString(seed.value)) throw new Error(jsonLookingStringError(`simulate_ws.seedDb "${seed.key}"`));
        db.set(String(seed.key), seed.value);
      }

      try { delete require.cache[require.resolve(routesPath)]; } catch {}
      const routeModule = require(routesPath);
      if (typeof routeModule.ws !== "function") {
        throw new Error("backend/routes.js does not export module.exports.ws");
      }

      const routeHandlers: Array<{ method: string; path: string; handlers: Function[] }> = [];
      const router: any = {};
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        router[method] = (routePath: string, ...handlers: Function[]) => {
          routeHandlers.push({ method: method.toUpperCase(), path: routePath, handlers });
        };
      }
      if (typeof routeModule === "function") {
        routeModule(router, db, projectId);
      }

      const matchRoute = (routePath: string, requestPath: string): Record<string, string> | null => {
        const routeParts = routePath.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
        const reqParts = requestPath.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
        if (routeParts.length !== reqParts.length) return null;
        const params: Record<string, string> = {};
        for (let i = 0; i < routeParts.length; i++) {
          const rp = routeParts[i];
          const qp = reqParts[i];
          if (rp.startsWith(":")) params[rp.slice(1)] = decodeURIComponent(qp);
          else if (rp !== qp) return null;
        }
        return params;
      };

      const apiResults: any[] = [];
      const runApiStep = async (step: any) => {
        const method = String(step.method || "GET").toUpperCase();
        const rawPath = String(step.path || "").replace(/^\//, "");
        const [pathPart, queryPart = ""] = rawPath.split("?");
        const found = routeHandlers
          .map(route => ({ route, params: matchRoute(route.path, pathPart) }))
          .find(entry => entry.route.method === method && entry.params);
        if (!found) {
          const payload = { ok: false, method, path: rawPath, status: 404, body: { error: "Endpoint not found" } };
          apiResults.push(payload);
          return payload;
        }
        const fakeUser = buildFakeTelegramUser(step);
        const query = Object.fromEntries(new URLSearchParams(queryPart).entries());
        const req: any = {
          body: step.body || {},
          params: found.params,
          query,
          headers: { "x-telegram-init-data": fakeInitDataFor(fakeUser) },
          telegramUser: fakeUser,
        };
        let statusCode = 200;
        let responseBody: any = undefined;
        let ended = false;
        const res: any = {
          status(code: number) { statusCode = code; return res; },
          json(body: any) { responseBody = body; ended = true; return res; },
          send(body: any) { responseBody = body; ended = true; return res; },
          end(body?: any) { if (body !== undefined) responseBody = body; ended = true; return res; },
        };
        let index = 0;
        const next = () => { index++; };
        while (index < found.route.handlers.length && !ended) {
          const handler = found.route.handlers[index];
          const before = index;
          await Promise.resolve(handler(req, res, next));
          if (index === before) index++;
        }
        const expectedStatus = Number.isFinite(Number(step.expectStatus)) ? Number(step.expectStatus) : null;
        const ok = expectedStatus != null ? statusCode === expectedStatus : statusCode >= 200 && statusCode < 300;
        const payload = { ok, method, path: rawPath, status: statusCode, body: responseBody };
        apiResults.push(payload);
        return payload;
      };

      const clientsInput = Array.isArray(args.clients) && args.clients.length > 0
        ? args.clients
        : [{ id: "a", userId: -100 }, { id: "b", userId: -101 }];
      const captured: Record<string, string[]> = {};
      const handlers = new Map<string, Map<string, Function[]>>();
      const clients = new Map<string, any>();
      const clientSet = new Set<any>();

      const makeClient = (id: string) => {
        captured[id] = [];
        const eventHandlers = new Map<string, Function[]>();
        handlers.set(id, eventHandlers);
        const socket: any = {
          id,
          readyState: 1,
          send(data: any) { captured[id].push(typeof data === "string" ? data : JSON.stringify(data)); },
          on(event: string, cb: Function) {
            const arr = eventHandlers.get(event) || [];
            arr.push(cb);
            eventHandlers.set(event, arr);
          },
          close() {
            socket.readyState = 3;
            for (const cb of eventHandlers.get("close") || []) cb();
          },
        };
        clients.set(id, socket);
        clientSet.add(socket);
        return socket;
      };

      for (const c of clientsInput) makeClient(String(c.id || c.userId));

      let connectionHandler: ((socket: any, req: any) => void) | null = null;
      const wss = {
        clients: clientSet,
        broadcast(data: any) {
          const msg = typeof data === "string" ? data : JSON.stringify(data);
          for (const client of clientSet) if (client.readyState === 1) client.send(msg);
        },
        broadcastExcept(sender: any, data: any) {
          const msg = typeof data === "string" ? data : JSON.stringify(data);
          for (const client of clientSet) if (client !== sender && client.readyState === 1) client.send(msg);
        },
        onConnection(handler: (socket: any, req: any) => void) {
          connectionHandler = handler;
        },
      };

      routeModule.ws(wss, db, projectId);
      if (!connectionHandler) throw new Error("module.exports.ws did not call wss.onConnection(handler)");
      const onConnection = connectionHandler as (socket: any, req: any) => void;
      for (const c of clientsInput) {
        const id = String(c.id || c.userId);
        onConnection(clients.get(id), { url: `/devws/${projectId}`, headers: {} });
      }

      const sendWsMessage = (msg: any) => {
        const clientId = String(msg.clientId || msg.id || "a");
        const socket = clients.get(clientId);
        if (!socket) throw new Error(`simulate_ws unknown clientId "${clientId}"`);
        const clientDef = clientsInput.find((c: any) => String(c.id || c.userId) === clientId) || {};
        const dataObj = msg.data || {};
        const data = typeof dataObj === "string"
          ? dataObj
          : JSON.stringify({
            ...dataObj,
            ...(dataObj.type === "auth" && !dataObj.initData ? { initData: fakeInitDataFor(clientDef) } : {}),
          });
        for (const cb of handlers.get(clientId)?.get("message") || []) {
          cb(Buffer.from(data));
        }
      };

      const expectedTypes = new Set<string>((Array.isArray(args.expectTypes) ? args.expectTypes : []).map(String));
      const steps = Array.isArray(args.steps) ? args.steps : [];
      if (steps.length > 0) {
        for (const step of steps) {
          const stepType = String(step.type || step.action || "ws");
          if (stepType === "api") {
            await runApiStep(step);
          } else if (stepType === "seedDb") {
            if (!step.key) throw new Error("simulate_ws seedDb step requires { key, value }.");
            if (isJsonLookingString(step.value)) throw new Error(jsonLookingStringError(`simulate_ws seedDb step "${step.key}"`));
            db.set(String(step.key), step.value);
          } else if (stepType === "expectWs") {
            for (const type of Array.isArray(step.expectTypes) ? step.expectTypes : []) expectedTypes.add(String(type));
          } else if (stepType === "wait") {
            await new Promise(r => setTimeout(r, Math.max(0, Math.min(Number(step.ms) || 50, 1000))));
          } else {
            sendWsMessage(step);
          }
        }
      } else {
        const messages = Array.isArray(args.messages) && args.messages.length > 0
          ? args.messages
          : clientsInput.map((c: any) => ({
            clientId: String(c.id || c.userId),
            data: { type: "auth", initData: fakeInitDataFor(c) },
          }));
        for (const msg of messages) sendWsMessage(msg);
      }
      await new Promise(r => setTimeout(r, 50));
      return {
        scenarioId: args.scenarioId,
        clients: clientsInput,
        captured,
        apiResults,
        expectedTypes: [...expectedTypes],
      };
    } finally {
      try { sqlite.close(); } catch {}
    }
  }

  async buildApp(
    projectId: string,
    description: string,
    plan: string,
    onProgress?: (p: AgentProgress) => Promise<void>,
    onAskUser?: (question: string, options: string[]) => Promise<string>,
    lang?: string,
    userBalance?: number,
    tierId?: string,
  ): Promise<AgentResult> {
    // Run the entire agent loop (and every transitive console.log inside
    // claude/builder/commit/ws-manager) under an ALS context tagged with
    // this project's id. The console tagger then prefixes lines with
    // `[app:<id>]` and the persistent log capture (app-log.service.ts)
    // attributes them to the project instead of "core".
    return runWithProject(projectId, async () => {
    const featureGating = await this.buildFeatureGating(projectId);
    const langInstruction = lang && lang !== "en"
      ? `\n\nIMPORTANT: All user-facing text in the app (UI labels, buttons, messages, placeholders, titles) must be written in ${lang === "ru" ? "Russian" : "Ukrainian"}. The code, comments, and variable names should stay in English.`
      : "";

    const buildProject: any = await projectService.getProject(projectId);
    const buildPrefs = parseProjectPreferences(buildProject?.preferences ?? null);
    const buildKind = normalizeProjectKind(buildPrefs?.kind);
    const prefsBlock = `${buildPreferencesPrompt(buildPrefs)}\n\n`;
    const baseProjectInfo = `Project ID: ${projectId}
Development App URL: ${config.baseUrl}/dev/${projectId}/
Development API URL: ${config.baseUrl}/devapi/${projectId}/
Production App URL: ${config.baseUrl}/app/${projectId}/
Production API URL: ${config.baseUrl}/api/${projectId}/
Telegram Bot Link: ${buildProject?.botUsername ? `https://t.me/${buildProject.botUsername}` : "(bot not linked yet)"}

Description: ${description}

Plan:
${plan}
${featureGating}`;

    const hasBotLinked = !!buildProject?.botUsername;
    const simTelegramNote = hasBotLinked
      ? ""
      : "\nNOTE: No Telegram bot is linked yet — simulate_telegram is optional. You may call it to verify webhook logic but it is NOT required before finish(). The bot webhook will be testable once the user connects a bot.";

    const kindTask =
      buildKind === "textBot"
        ? `Build a new Telegram Text Bot from scratch.\n\n${baseProjectInfo}\nCreate ONLY backend/routes.js. Do not create frontend files. The bot UX happens entirely in Telegram messages, keyboards, callbacks, and /bot-webhook. Use db.get/db.set for persistence, deploy_to_dev(), test with simulate_telegram/server_logs, then finish.${simTelegramNote}${langInstruction}`
      : buildKind === "game"
        ? `Build a new Telegram Mini App game from scratch.\n\n${baseProjectInfo}\nCreate a single-file Three.js game in frontend/index.html. Do not create frontend/app.js, frontend/styles.css, or backend/routes.js unless the game truly needs server-side multiplayer/shared persistence. Use deploy_to_dev(), then finish.${langInstruction}`
      : `Build a complete Telegram Mini App from scratch.\n\n${baseProjectInfo}\nCreate all necessary files (frontend/index.html, frontend/styles.css, frontend/app.js, backend/routes.js) and configure the bot. Database is handled via db.get/db.set in routes.js — no schema setup needed. Make it beautiful and functional. Use deploy_to_dev() to deploy and test your code via the Dev URLs. In frontend code, use /api/${projectId}/ as the API base URL (this will be rewritten to /devapi/ in dev mode automatically).${simTelegramNote}${langInstruction}`;

    const prompt = `${prefsBlock}${kindTask}`;

    return this.runAgent(projectId, prompt, onProgress, onAskUser, userBalance, undefined, "new", buildKind, tierId);
    }); // end runWithProject
  }

  async updateApp(
    projectId: string,
    updateDescription: string,
    onProgress?: (p: AgentProgress) => Promise<void>,
    attachments?: { localPath: string; projectPath: string; originalName: string; caption?: string }[],
    onAskUser?: (question: string, options: string[]) => Promise<string>,
    lang?: string,
    userBalance?: number,
    tierId?: string,
  ): Promise<AgentResult> {
    // See note in `buildApp`: wrap the whole agent run in an ALS context so
    // every transitive log line (`[Agent]`, `[Builder]`, claude streams, …)
    // is tagged with this project's id and persisted under it.
    return runWithProject(projectId, async () => {
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
      contextParts.push(`PROJECT CONTEXT:\n${latestContext}`);
    } else if (project?.projectSummary) {
      contextParts.push(`PROJECT CONTEXT (from previous builds):\n${project.projectSummary}`);
    }
    // Only include original plan for the first few updates — it becomes stale
    // if (project?.plan && currentCommitNum <= 3) {
    //   contextParts.push(`ORIGINAL PLAN:\n${project.plan}`);
    // }

    let attachmentInfo = "";
    if (attachments && attachments.length > 0) {
      const lines = attachments.map(a =>
        `- ${a.projectPath} (original: ${a.originalName})${a.caption ? ` — "${a.caption}"` : ""}`
      );
      attachmentInfo = `\nATTACHED FILES (already saved to project):\n${lines.join("\n")}\nThe user uploaded these files for you to use in the app. Reference them in your code by path (e.g. <img src="assets/filename.jpg">). DO NOT call read_file on image/audio/video/font/binary files — the tool will refuse and the path alone is enough to use them. read_file is only for text files (json, csv, txt, md, etc.) you actually need to inspect.\n`;
    }

    const context = contextParts.length > 0 ? contextParts.join("\n\n") + "\n\n" : "";

    const featureGating = await this.buildFeatureGating(projectId);

    const langInstruction = lang && lang !== "en"
      ? `\n\nIMPORTANT: All user-facing text in the app (UI labels, buttons, messages, placeholders, titles) must be written in ${lang === "ru" ? "Russian" : "Ukrainian"}. The code, comments, and variable names should stay in English.`
      : "";

    const updatePrefs = parseProjectPreferences(project?.preferences ?? null);
    const updateKind = normalizeProjectKind(updatePrefs?.kind);
    const updatePrefsBlock = `${buildPreferencesPrompt(updatePrefs)}\n\n`;

    const updateHasBotLinked = !!project?.botUsername;
    const updateSimTelegramNote = updateHasBotLinked
      ? ""
      : "\nNOTE: No Telegram bot is linked yet — simulate_telegram is optional. You may call it to verify webhook logic but it is NOT required before finish(). The bot webhook will be testable once the user connects a bot.";

    const updateProjectInfo = `Project ID: ${projectId}
Development App URL: ${config.baseUrl}/dev/${projectId}/
Development API URL: ${config.baseUrl}/devapi/${projectId}/
Production App URL: ${config.baseUrl}/app/${projectId}/
Production API URL: ${config.baseUrl}/api/${projectId}/

Telegram Bot Link: ${project?.botUsername ? `https://t.me/${project.botUsername}` : "(bot not linked yet)"}
Telegram Bot Deep Link Making: ${project?.botUsername ? `https://t.me/${project.botUsername}?start={some_param}` : "(bot not linked yet)"}
Track Deep Link: in routes.js from /bot-webhook route track the as message of start param


${context}

Update request: 
${updateDescription}
${attachmentInfo}
${featureGating}`;

    const updateTask =
      updateKind === "textBot"
        ? `Update an existing Telegram Text Bot.\n\n${updateProjectInfo}\nUse targeted read_file on backend/routes.js only. Do not create frontend files. Use edit_file for targeted changes. Use deploy_to_dev(), simulate_telegram/server_logs for changed flows, then finish.${updateSimTelegramNote}${langInstruction}`
      : updateKind === "game"
        ? `Update an existing Telegram game.\n\n${updateProjectInfo}\nThe game should normally be a single file in frontend/index.html. Do not create frontend/app.js, frontend/styles.css, or backend/routes.js unless the user explicitly asked for server-side functionality. Use deploy_to_dev(), then finish.${langInstruction}`
      : `Update an existing Telegram Mini App.\n\n${updateProjectInfo}\nUse grep and read_file to verify current state before making changes. Use edit_file for targeted modifications. Use deploy_to_dev(), simulate_api/server_logs for changed backend behavior, simulate_ws for changed real-time behavior, then finish.${updateSimTelegramNote}${langInstruction}`;

    const prompt = `${updatePrefsBlock}${updateTask}`;

    return this.runAgent(projectId, prompt, onProgress, onAskUser, userBalance, attachments, "update", updateKind, tierId);
    }); // end runWithProject
  }

  private async runAgent(
    projectId: string,
    userPrompt: string,
    onProgress?: (p: AgentProgress) => Promise<void>,
    onAskUser?: (question: string, options: string[]) => Promise<string>,
    userBalance?: number,
    attachments?: { localPath: string; projectPath: string; originalName: string; caption?: string }[],
    mode: AgentMode = "update",
    kind?: string,
    tierId?: string,
  ): Promise<AgentResult> {
    // Build the system prompt from agent_knowledge/instructions/ for THIS run.
    // Mode-gated files are filtered by manifest; kind-specific workflow file is selected here.
    // Async: also pulls enabled AgentLesson rows from the DB (cached).
    const systemPrompt = await buildSystemPrompt(mode, kind);
    const promptKind = normalizeProjectKind(kind);
    // Generate a unique session ID for this agent run for tracing in OpenRouter dashboard
    const taskId = crypto.randomUUID();
    // Resolve Telegram userId for OpenRouter user-tracking field
    const agentProject = await projectService.getProject(projectId);
    const agentOwner = (agentProject as any)?.userId
      ? await prisma.user.findUnique({ where: { id: (agentProject as any).userId }, select: { telegramId: true } })
      : null;
    const agentTelegramId = agentOwner?.telegramId ? String(agentOwner.telegramId) : undefined;
    console.log(`[Agent] task_id=${taskId} user=${agentTelegramId ?? "?"} (mode=${mode}, kind=${promptKind}, workflow=${workflowFileFor(mode, promptKind)}, ${systemPrompt.length} chars)`);
    // Persist immediately so the mini app can display it
    projectService.updateProjectLastTaskId(projectId, taskId).catch(() => {});
    let liveCostUsd = 0;
    const startBalance = userBalance ?? 0;
    const rawProgress = onProgress || (async () => {});
    const progress = async (p: AgentProgress) => {
      p.costUsd = liveCostUsd;
      p.balance = startBalance > 0 ? Math.max(0, startBalance - liveCostUsd) : undefined;
      return rawProgress(p);
    };

    // ─── structured event emitters ──────────────────────────────────────────
    // These ride on top of the legacy `progress` callback. Older consumers
    // ignore the new fields (`event`, `stepId`, `kind`, …); the WS forwarder
    // in src/web/server.ts maps them to dedicated `agent_*` WS events.
    let stepCounter = 0;
    const newStepId = (prefix: string) =>
      `${prefix}-${Date.now().toString(36)}-${++stepCounter}`;
    const emitStepStart = async (
      kind: AgentStepKind,
      title: string,
      toolName: string,
      target?: AgentProgress["target"],
    ): Promise<string> => {
      const stepId = newStepId(toolName || kind);
      await progress({
        event: "step_start",
        stepId,
        kind,
        title,
        toolName,
        target,
        action: title,
        detail: target?.file || target?.url || target?.key || "",
        percent: currentPercent,
      });
      return stepId;
    };
    const emitStepEnd = async (
      stepId: string,
      status: "ok" | "error",
      meta?: Record<string, any>,
    ) => {
      await progress({
        event: "step_end",
        stepId,
        status,
        meta,
        action: "",
        detail: "",
        percent: currentPercent,
      });
    };
    const emitNarrationStart = async (stepId: string) => {
      await progress({
        event: "narration_start",
        stepId,
        action: "",
        detail: "",
        percent: currentPercent,
      });
    };
    const emitNarrationChunk = async (stepId: string, delta: string, text: string) => {
      await progress({
        event: "narration_chunk",
        stepId,
        delta,
        text,
        action: "",
        detail: "",
        percent: currentPercent,
      });
    };
    const emitNarrationEnd = async (stepId: string) => {
      await progress({
        event: "narration_end",
        stepId,
        action: "",
        detail: "",
        percent: currentPercent,
      });
    };
    const emitWritingChunk = async (stepId: string, toolName: string, argsDelta: string, argsFull: string) => {
      await progress({
        event: "writing_chunk",
        stepId,
        toolName,
        delta: argsDelta,
        text: argsFull,
        action: "",
        detail: "",
        percent: currentPercent,
      });
    };

    // Fast lookup: tool name → step kind + human title + which arg holds the
    // primary "target" for the UI (file path / URL / DB key / skill name).
    const TOOL_KIND_MAP: Record<string, { kind: AgentStepKind; title: string; targetKey?: string; targetField?: "file" | "url" | "key" }> = {
      list_files:    { kind: "searching",  title: "Scanning files" },
      read_file:     { kind: "reading",    title: "Reading",         targetKey: "path", targetField: "file" },
      write_file:    { kind: "writing",    title: "Writing",         targetKey: "path", targetField: "file" },
      edit_file:     { kind: "editing",    title: "Editing",         targetKey: "path", targetField: "file" },
      grep:          { kind: "searching",  title: "Searching",       targetKey: "pattern", targetField: "key" },
      shell:         { kind: "shell",      title: "Running command", targetKey: "command", targetField: "key" },
      fetch_url:     { kind: "fetch",      title: "Fetching URL",    targetKey: "url", targetField: "url" },
      db:            { kind: "db",         title: "Database",        targetKey: "key", targetField: "key" },
      telegram_api:  { kind: "telegram",   title: "Telegram API",    targetKey: "method", targetField: "key" },
      deploy_to_dev: { kind: "deploying",  title: "Deploying to dev" },
      load_skill:    { kind: "skill",      title: "Loading skill",   targetKey: "name", targetField: "key" },
      ask_user:      { kind: "ask",        title: "Waiting for your answer" },
      technical_plan:{ kind: "thinking",   title: "Technical plan",  targetKey: "kind", targetField: "key" },
      configure_app: { kind: "configuring",title: "Configuring app" },
      set_bot_commands: { kind: "configuring", title: "Setting bot commands" },
      set_progress:    { kind: "thinking",   title: "Updating progress" },
      done:            { kind: "done",       title: "Wrapping up" },
      finish:          { kind: "done",       title: "Finishing" },
      server_logs:     { kind: "searching",  title: "Reading logs" },
      simulate_telegram: { kind: "shell",    title: "Simulating bot message" },
      simulate_api:    { kind: "fetch",      title: "Simulating API call" },
      simulate_ws:     { kind: "shell",      title: "Simulating WebSocket" },
    };
    const buildStepTarget = (toolName: string, args: any): AgentProgress["target"] | undefined => {
      const cfg = TOOL_KIND_MAP[toolName];
      if (!cfg?.targetKey) return undefined;
      const raw = args?.[cfg.targetKey];
      if (typeof raw !== "string" || !raw) return undefined;
      const trimmed = raw.length > 200 ? raw.slice(0, 197) + "…" : raw;
      const field = cfg.targetField || "file";
      return { [field]: trimmed } as AgentProgress["target"];
    };
    // ────────────────────────────────────────────────────────────────────────
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
    // Load the project's preferences once so configure_app can
    // gate behaviour on `kind` (e.g. text-bot projects must NEVER ship a Mini
    // App menu button — see preferences.kind === "textBot" guard inside the
    // tool handler).
    let runPrefs = { ...DEFAULT_PREFERENCES };
    try {
      const project = await projectService.getProject(projectId);
      if (project?.botTokenEncrypted) {
        botToken = decryptToken(project.botTokenEncrypted);
      }
      const parsed = parseProjectPreferences((project as any)?.preferences ?? null);
      if (parsed) runPrefs = parsed;
    } catch {}
    const runKind = normalizeProjectKind(kind || runPrefs.kind);
    const setRuntimeMenuButton = async () => {
      if (!botToken) return;
      let menuButtonText = "Launch App";
      try {
        const project = await projectService.getProject(projectId);
        menuButtonText = ((project as any)?.appMenuButtonText || menuButtonText).toString().substring(0, 32);
      } catch {}
      const menuButton = runKind === "textBot"
        ? { type: "default" as const }
        : { type: "web_app" as const, text: menuButtonText, web_app: { url: `${config.baseUrl}/app/${projectId}/` } };
      await fetch(`https://api.telegram.org/bot${botToken}/setChatMenuButton`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ menu_button: menuButton }),
      });
    };

    const tierConfig = runtimeConfig.getModelConfig("codegen", tierId);

    const finalPrompt = userPrompt;

    logger.header(tierConfig.modelId, finalPrompt);

    const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
    const MIME_MAP: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
    // Build OpenAI-format content parts (text + optional image_url blocks)
    const imageContentParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        const ext = path.extname(att.originalName).toLowerCase();
        if (IMAGE_EXTS.has(ext) && fs.existsSync(att.localPath)) {
          try {
            const data = fs.readFileSync(att.localPath).toString("base64");
            const mimeType = MIME_MAP[ext] || "image/png";
            imageContentParts.push({
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${data}` },
            });
            console.log(`[Agent] 🖼️ Attached image for vision: ${att.originalName} (${ext})`);
          } catch (err) {
            console.error(`[Agent] Failed to read image ${att.localPath}:`, err);
          }
        }
      }
    }

    const firstUserContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] | string =
      imageContentParts.length > 0
        ? [...imageContentParts, { type: "text", text: finalPrompt }]
        : finalPrompt;

    // Messages array in OpenAI format.
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "user", content: firstUserContent },
    ];

    let summary = "";
    let shortSummary = "";
    let iterations = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheWriteTokens = 0;
    // Detailed admin log: full request/response per Anthropic call. Written to
    // commitDir/detailed-log.json at every terminal point. Heavy — admin-only.
    const detailedEntries: Array<{
      iteration: number;
      timestamp: string;
      request: any;
      response: any;
    }> = [];
    const selectedWorkflow = workflowFileFor(mode, runKind);
    const loadedSkills = new Set<string>();
    const validatorResults: Array<{ stage: string; ok: boolean; message?: string }> = [];
    const testResults: Array<{ tool: string; ok: boolean; detail: string }> = [];
    let technicalPlan: any = null;
    let technicalPlanSubmitted = mode === "update";
    let wroteFiles = false;
    let deployed = false;
    let finished = false;
    let configuredApp = false;
    const testsRun = { telegram: false, api: false, ws: false };
    const wsCoverage = { types: new Set<string>(), scenarios: new Set<string>() };
    const writeDetailedLog = (reason: string) => {
      try {
        const detailedLogPath = path.join(commitDir, "detailed-log.json");
        fs.writeFileSync(
          detailedLogPath,
          JSON.stringify({
            projectId,
            commitNum,
            mode,
            kind: runKind,
            selectedWorkflow,
            reason,
            loadedSkills: [...loadedSkills],
            technicalPlan,
            state: { technicalPlanSubmitted, wroteFiles, deployed, finished, testsRun },
            validatorResults,
            testResults,
            entries: detailedEntries,
          }, null, 2),
          "utf-8"
        );
      } catch (err: any) {
        console.warn(`[Agent] failed to write detailed-log.json (${reason}): ${err.message}`);
      }
    };
    let totalCacheReadTokens = 0;
    let currentPercent: number | undefined;
    let deployCount = 0;
    let deployLocked = false;
    let lastWsFailureSignature = "";
    let repeatedWsFailureCount = 0;
    let consecutiveNoWrite = 0;

    const maxIterations = tierConfig.maxIterations ?? 60;
    const staticModelPricing = MODEL_PRICING[tierConfig.modelId] || MODEL_PRICING["anthropic/claude-sonnet-4-5"] || { input: 0, output: 0, cache_write: 0, cache_read: 0 };
    const liveModelPricing = await getModelPricing(tierConfig.modelId);
    // For cache_read/write: use OpenRouter's catalog price when available (models like MiniMax,
    // Anthropic via OpenRouter expose this). Fall back to static pricing, then to a fraction
    // of input price (1.25x write, 0.1x read) as a conservative estimate.
    const baseInputPrice = liveModelPricing?.promptPerToken ?? staticModelPricing.input;
    const agentPricing = {
      input: baseInputPrice,
      output: liveModelPricing?.completionPerToken ?? staticModelPricing.output,
      cache_write: liveModelPricing != null
        ? (liveModelPricing.cacheWritePerToken || baseInputPrice * 1.25)
        : staticModelPricing.cache_write,
      cache_read: liveModelPricing != null
        ? (liveModelPricing.cacheReadPerToken || baseInputPrice * 0.1)
        : staticModelPricing.cache_read,
    };
    while (iterations < maxIterations) {
      if (abortedProjects.has(projectId)) {
        abortedProjects.delete(projectId);
        logger.done("ABORTED by user", iterations, totalInputTokens, totalOutputTokens);
        writeDetailedLog("aborted");
        console.log(`[Agent] ⛔ Aborted by user after ${iterations} iterations | Tokens: in=${totalInputTokens} out=${totalOutputTokens}`);
        throw new AgentAbortedError(tierConfig.modelId, totalInputTokens, totalOutputTokens, totalCacheWriteTokens, totalCacheReadTokens);
      }
      iterations++;

      // Build OpenAI-format request.
      // thinkingBudget → Claude extended thinking via extra_body (Claude models only).
      // reasoningBudget → OpenRouter unified reasoning.max_tokens (Kimi, DeepSeek-R1, etc.).
      const thinkingBudget  = tierConfig.thinkingBudget  ?? 0;
      const reasoningBudget = (tierConfig as any).reasoningBudget ?? 0;
      const requestMessages = this.applyCacheBreakpoint(tierConfig.modelId, systemPrompt, messages);
      const requestPayload: any = {
        model: tierConfig.modelId,
        max_tokens: tierConfig.maxTokens,
        messages: requestMessages,
        tools: [...TOOLS, ...SERVER_TOOLS],
        tool_choice: "auto" as const,
        // user: stable per-user string for OpenRouter user tracking (Telegram userId)
        ...(agentTelegramId ? { user: agentTelegramId } : {}),
        // extra_body carries OpenRouter-specific fields the OpenAI SDK would otherwise strip.
        // session_id is top-level per OpenRouter spec (not nested in metadata).
        extra_body: {
          session_id: taskId,
          ...(thinkingBudget > 0 ? { thinking: { type: "enabled", budget_tokens: thinkingBudget } } : {}),
        },
        ...(this.getProviderRouting(tierConfig.modelId, tierConfig.provider) ? { provider: this.getProviderRouting(tierConfig.modelId, tierConfig.provider) } : {}),
        ...(reasoningBudget > 0 ? {
          reasoning: { max_tokens: reasoningBudget },
        } : {}),
      };
      // Streaming is on by default; an action can opt out via runtime config
      // (`modelConfigs.<action>.streaming === false`). On any stream failure we
      // transparently fall back to a single non-streaming call so providers
      // with flaky tool-call streaming (e.g. some MiniMax variants) still work.
      const streamingEnabled = (tierConfig as any).streaming !== false;
      const iterStepId = `iter-${iterations}-${Date.now().toString(36)}`;
      let narrationOpen = false;
      let response: OpenAI.Chat.Completions.ChatCompletion;
      try {
        if (streamingEnabled) {
          try {
            await emitNarrationStart(iterStepId);
            narrationOpen = true;
            // Track combined reasoning + content text so the narration body
            // shows the model's actual thinking stream (reasoning_content) as
            // well as any regular text in delta.content.
            let narrationAccum = "";
            response = await this.streamAgentCall(requestPayload, {
              onTextDelta: (delta) => {
                narrationAccum += delta;
                void emitNarrationChunk(iterStepId, delta, narrationAccum);
              },
              onReasoningDelta: (delta) => {
                narrationAccum += delta;
                void emitNarrationChunk(iterStepId, delta, narrationAccum);
              },
              onToolArgsDelta: (toolName, argsDelta, argsFull) => {
                void emitWritingChunk(iterStepId, toolName, argsDelta, argsFull);
              },
            });
            await emitNarrationEnd(iterStepId);
            narrationOpen = false;
            // If the stream returned an empty turn, retry once via the
            // non-streaming path which has its own empty-response retry.
            if (this.isEmptyResponse(response)) {
              console.warn(`[Agent] stream returned empty response, falling back to non-stream`);
              response = await this.callWithRetry(requestPayload);
            }
          } catch (streamErr: any) {
            if (narrationOpen) {
              await emitNarrationEnd(iterStepId);
              narrationOpen = false;
            }
            console.warn(`[Agent] stream failed (${streamErr?.message}), falling back to non-stream`);
            response = await this.callWithRetry(requestPayload);
          }
        } else {
          response = await this.callWithRetry(requestPayload);
        }
      } catch (apiErr: any) {
        if (narrationOpen) {
          try { await emitNarrationEnd(iterStepId); } catch {}
        }
        try {
          const cloneSafe = (v: any) => {
            try {
              return typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v));
            } catch { return undefined; }
          };
          detailedEntries.push({
            iteration: iterations,
            timestamp: new Date().toISOString(),
            request: cloneSafe(requestPayload),
            response: { error: { name: apiErr?.name, message: apiErr?.message, status: apiErr?.status, body: apiErr?.error || apiErr?.response } },
          });
        } catch {}
        writeDetailedLog("api_error");
        throw apiErr;
      }
      try {
        const clone = (v: any) => (typeof structuredClone === "function"
          ? structuredClone(v)
          : JSON.parse(JSON.stringify(v)));
        detailedEntries.push({
          iteration: iterations,
          timestamp: new Date().toISOString(),
          request: clone(requestPayload),
          response: clone(response),
        });
      } catch (err: any) {
        console.warn(`[Agent] detailed-log clone failed at iter ${iterations}: ${err.message}`);
      }

      const usage = response.usage as any;
      const iterIn = usage?.prompt_tokens || 0;
      const iterOut = usage?.completion_tokens || 0;
      // OpenRouter reports cached tokens inside prompt_tokens_details.cached_tokens.
      // prompt_tokens already INCLUDES cached tokens, so we must subtract them to avoid
      // double-charging: fresh tokens at input_rate + cached tokens at cache_read_rate.
      const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
      totalInputTokens += iterIn - cached;   // non-cached (fresh) input tokens only
      totalOutputTokens += iterOut;
      totalCacheReadTokens += cached;
      // totalCacheWriteTokens stays 0 — OpenRouter handles cache writes transparently

      liveCostUsd =
        (totalInputTokens * agentPricing.input +
        totalOutputTokens * agentPricing.output +
        totalCacheWriteTokens * agentPricing.cache_write +
        totalCacheReadTokens * agentPricing.cache_read);

      const assistantMsg = response.choices?.[0]?.message;
      const assistantToolCalls = assistantMsg?.tool_calls || [];
      const assistantText = assistantMsg?.content || "";
      // Thinking may come back as reasoning_content from OpenRouter for Claude models
      const reasoning = (assistantMsg as any)?.reasoning_content || (assistantMsg as any)?.reasoning || "";

      // Push the full assistant message back into the conversation.
      messages.push({
        role: "assistant",
        content: assistantText,
        tool_calls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
      } as any);

      logger.iteration(iterations, tierConfig.modelId);
      logger.tokens(totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens, iterIn, iterOut, cached, 0, liveCostUsd);

      if (reasoning?.trim()) {
        logger.thinking(reasoning);
        console.log(`[Agent] 🧠 Thinking: ${reasoning.substring(0, 300).replace(/\n/g, " ")}${reasoning.length > 300 ? "..." : ""}`);
      }
      if (assistantText?.trim()) {
        logger.claudeMessage(assistantText);
        console.log(`[Agent] 💬 Claude says: ${assistantText.substring(0, 500)}`);
      }
      if (assistantToolCalls.length > 0) {
        const toolNames = assistantToolCalls.map((tc: any) => tc.function?.name).join(", ");
        console.log(`[Agent] 🔧 Iteration ${iterations} | Tools: [${toolNames}] | Tokens so far: in=${totalInputTokens} out=${totalOutputTokens} | finish=${response.choices?.[0]?.finish_reason}`);
      }

      if (assistantToolCalls.length === 0) {
        if (mode === "new" && (!technicalPlanSubmitted || !wroteFiles || !deployed)) {
          consecutiveNoWrite++;
          const needed = [
            !technicalPlanSubmitted ? "call technical_plan first" : "",
            !wroteFiles ? "write the required project files with write_file/edit_file" : "",
            !deployed ? "call deploy_to_dev after writing files" : "",
          ].filter(Boolean).join(", ");
          const corrective = `You responded with text only, but this is a build run and text does not create files. Continue now with tool calls only: ${needed}. Do not finish until validators pass and required simulate_* tests are done.`;
          messages.push({ role: "user", content: corrective });
          writeDetailedLog("end_turn_no_tools_retry");
          console.warn(`[Agent] no-tool turn during new build; injected corrective prompt (${consecutiveNoWrite})`);
          continue;
        }
        if (assistantText) summary = assistantText;
        logger.done(summary, iterations, totalInputTokens, totalOutputTokens);
        writeDetailedLog("end_turn_no_tools");
        console.log(`[Agent] ⏹️ Agent finished after ${iterations} iterations | Total tokens: in=${totalInputTokens} out=${totalOutputTokens}`);
        break;
      }

      // Tool results in OpenAI format: each gets its own { role: "tool" } message.
      const toolResults: Array<{ role: "tool"; tool_call_id: string; content: string }> = [];

      // Process all tool_use blocks, but force terminal tools (`done`, `finish`)
      // to be processed LAST so the model can safely batch UI work + finish in
      // a single turn without losing earlier writes (`done`/`finish` return immediately).
      const TERMINAL_TOOLS = new Set(["done", "finish"]);
      const orderedToolCalls = [
        ...assistantToolCalls.filter((tc: any) => !TERMINAL_TOOLS.has((tc as any).function?.name)),
        ...assistantToolCalls.filter((tc: any) => TERMINAL_TOOLS.has((tc as any).function?.name)),
      ];

      // HARD REJECT for UI-only batches: set_progress is allowed
      // ONLY when the same turn also contains a real action.
      const ALLOWED_WITH_UI = new Set(["write_file", "edit_file", "deploy_to_dev", "shell"]);
      const turnHasAllowedAction = assistantToolCalls.some((tc: any) => ALLOWED_WITH_UI.has((tc as any).function?.name));

      for (const toolCall of orderedToolCalls) {
        const id = (toolCall as any).id as string;
        let name = (toolCall as any).function?.name as string;
        let args: any;
        try {
          args = JSON.parse((toolCall as any).function?.arguments || "{}");
        } catch {
          args = {};
        }

        // Some models (e.g. MiniMax) occasionally embed the argument directly
        // in the tool name, e.g. `load_skill("frontend")` instead of calling
        // `load_skill` with `{name: "frontend"}`. Canonicalise these.
        const inlineArgMatch = name?.match(/^(\w+)\("([^"]+)"\)$/);
        if (inlineArgMatch) {
          const [, baseName, inlineArg] = inlineArgMatch;
          if (baseName === "load_skill" && !args.name) {
            name = "load_skill";
            args = { ...args, name: inlineArg };
          }
        }

        // OpenRouter server tools (openrouter:*) are executed transparently on
        // the OpenRouter side before the response reaches the client. If the model
        // somehow includes one in the tool_calls array, skip it gracefully so the
        // agent loop doesn't stall waiting for a result we can't produce.
        if (name && name.startsWith("openrouter:")) {
          messages.push({ role: "tool", tool_call_id: id, content: `OK: server tool ${name} handled by OpenRouter.` } as any);
          continue;
        }

        let result = "";
        const argsSummary = this.summarizeArgs(name, args);
        logger.toolCall(name, args);

        // Open a structured step card for this tool call. We always close it
        // in the `finally` below (with status + meta computed from `result`).
        const stepKindCfg = TOOL_KIND_MAP[name] || { kind: "thinking" as AgentStepKind, title: name };
        const stepTarget = buildStepTarget(name, args);
        const stepId = await emitStepStart(stepKindCfg.kind, stepKindCfg.title, name, stepTarget);

        try {
          switch (name) {
            case "technical_plan": {
              technicalPlan = { ...args, kind: normalizeProjectKind(args.kind || runKind) };
              technicalPlanSubmitted = true;
              result = `OK: Technical plan accepted for kind=${technicalPlan.kind}. Code must now follow this contract exactly.`;
              break;
            }

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

              const stat = fs.statSync(filePath);
              if (stat.isDirectory()) {
                result = `Error: ${args.path} is a directory, not a file. Use list_files to inspect the project tree.`;
                break;
              }

              const ext = path.extname(args.path).toLowerCase();
              const sizeKB = (stat.size / 1024).toFixed(1);

              // Refuse binary files outright — reading them as UTF-8 floods the
              // context with garbage tokens (every byte ≈ 1 token).
              if (AgentService.BINARY_EXTS.has(ext)) {
                result = `Error: ${args.path} is a binary file (${ext}, ${sizeKB}KB) and cannot be read as text. ` +
                  `Reading it would inject ~${Math.round(stat.size / 4)} junk tokens into context. ` +
                  `If this is an image/audio/video asset, reference it directly in your HTML/CSS by path ` +
                  `(e.g. <img src="${args.path.replace(/^.*?(assets\/.*)$/, "$1")}">) without reading its contents. ` +
                  `Do NOT retry read_file on this path.`;
                console.warn(`[Agent] 🚫 read_file refused binary: ${args.path} (${sizeKB}KB)`);
                logger.toolResult(name, result);
                await progress({ action: "🚫 Skipped binary", detail: `${args.path} (${sizeKB}KB)`, percent: currentPercent });
                break;
              }

              // Hard size cap for full reads.
              if (!args.offset && !args.limit && stat.size > AgentService.READ_FILE_SOFT_CAP_BYTES) {
                result = `Error: ${args.path} is ${sizeKB}KB which exceeds the 256KB full-read cap. ` +
                  `Use offset+limit to page through it (e.g. read_file({path, offset: 1, limit: 500})), ` +
                  `or run grep first to locate the specific section you need.`;
                break;
              }
              if (stat.size > AgentService.READ_FILE_MAX_BYTES) {
                result = `Error: ${args.path} is ${sizeKB}KB which exceeds the 512KB hard cap. ` +
                  `Files this large must be inspected with grep, not read_file.`;
                break;
              }

              // Sniff for binary content (NUL bytes in the first 4KB) — catches
              // unknown extensions and prevents a recurrence of the JPEG fiasco.
              const sniffSize = Math.min(stat.size, 4096);
              if (sniffSize > 0) {
                const fd = fs.openSync(filePath, "r");
                const sniffBuf = Buffer.alloc(sniffSize);
                fs.readSync(fd, sniffBuf, 0, sniffSize, 0);
                fs.closeSync(fd);
                let nulCount = 0;
                for (let i = 0; i < sniffBuf.length; i++) {
                  if (sniffBuf[i] === 0) { nulCount++; if (nulCount > 2) break; }
                }
                if (nulCount > 2) {
                  result = `Error: ${args.path} (${sizeKB}KB) appears to be a binary file (contains NUL bytes) and cannot be read as text. ` +
                    `Do NOT retry read_file on this path.`;
                  console.warn(`[Agent] 🚫 read_file refused binary-by-sniff: ${args.path}`);
                  break;
                }
              }

              const content = fs.readFileSync(filePath, "utf-8");
              const lines = content.split("\n");

              if (args.offset || args.limit) {
                const start = Math.max(0, (args.offset || 1) - 1);
                const end = args.limit ? start + args.limit : lines.length;
                const slice = lines.slice(start, end);
                let body = slice.map((l, i) => `${start + i + 1}|${l}`).join("\n");
                // Truncate by bytes if the slice is still huge.
                if (Buffer.byteLength(body, "utf-8") > AgentService.READ_FILE_SOFT_CAP_BYTES) {
                  body = body.slice(0, AgentService.READ_FILE_SOFT_CAP_BYTES) +
                    `\n... [truncated: result exceeded 256KB cap; narrow the range with smaller limit]`;
                }
                result = body;
                await progress({ action: "📖 Reading", detail: `${args.path} lines ${start + 1}-${Math.min(end, lines.length)}`, percent: currentPercent });
              } else {
                result = lines.map((l, i) => `${i + 1}|${l}`).join("\n");
                await progress({ action: "📖 Reading", detail: args.path, percent: currentPercent });
              }
              break;
            }

            case "write_file": {
              if (deployLocked) {
                result = "Error: Deploy limit has been reached. Further file edits cannot be deployed or verified in this run. Call finish to produce a blocked build report instead of editing.";
                break;
              }
              if (mode === "new" && !technicalPlanSubmitted) {
                result = "Error: technical_plan must be called before writing code in a new build.";
                break;
              }
              if (this.isProtectedPath(args.path)) { result = "Error: You can only write to frontend/ and backend/ directories."; break; }
              const filePath = this.safePath(projectDir, args.path);
              if (!filePath) { result = "Error: Invalid path"; break; }
              if (typeof args.content !== "string" || args.content.length === 0) {
                result = `Error: write_file received empty content — the model hit max_tokens while generating the full file. This will happen again if you retry.

DO NOT retry write_file on ${args.path}. Use ONE of these instead:

OPTION 1 — shell heredoc (recommended for files >400 lines):
  shell("cat > ${args.path} << 'HEREDOC_EOF'\\n... full file content here ...\\nHEREDOC_EOF")

OPTION 2 — skeleton + edit_file:
  write_file("${args.path}", "// skeleton ~50 lines with // TODO: section_A markers")
  edit_file("${args.path}", "// TODO: section_A", "... actual code ...")
  edit_file("${args.path}", "// TODO: section_B", "... actual code ...")

OPTION 3 — split into multiple smaller files if the architecture allows.

Pick one and proceed.`;
                break;
              }
              fs.mkdirSync(path.dirname(filePath), { recursive: true });
              fs.writeFileSync(filePath, args.content, "utf-8");
              const lineCount = args.content.split("\n").length;
              result = `OK: Written ${lineCount} lines to ${args.path}`;
              wroteFiles = true;
              await progress({ action: "✏️ Writing", detail: args.path, percent: currentPercent });
              break;
            }

            case "edit_file": {
              if (deployLocked) {
                result = "Error: Deploy limit has been reached. Further file edits cannot be deployed or verified in this run. Call finish to produce a blocked build report instead of editing.";
                break;
              }
              if (mode === "new" && !technicalPlanSubmitted) {
                result = "Error: technical_plan must be called before editing code in a new build.";
                break;
              }
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
              wroteFiles = true;
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
              if (BLOCKED_INFRA_SHELL_PATTERNS.some(re => re.test(cmd))) {
                result = "Error: Platform infrastructure diagnostics are not allowed from project shell. Use deploy_to_dev, simulate_api, simulate_telegram, simulate_ws, and server_logs; fix project files based on those tool results.";
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

            case "fetch_url": {
              await progress({ action: "🔗 Fetching data...", detail: "", percent: currentPercent });
              try {
                const targetUrl = String(args.url || "");
                if (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/(?:devapi|api|dev|app)\//i.test(targetUrl)) {
                  result = "Error: Do not test Apps Father project endpoints with fetch_url or localhost URLs. Use deploy_to_dev(), then simulate_api/simulate_ws/simulate_telegram for project testing.";
                  break;
                }
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 15000);

                const resp = await fetch(targetUrl, {
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
                    if (row) {
                      const parsed = parseJsonValueForDisplay(row.value);
                      result = `OK: ${JSON.stringify(parsed, null, 2).substring(0, 8000)}`;
                    } else {
                      result = "OK: null";
                    }
                    break;
                  }
                  case "set": {
                    if (isJsonLookingString(args.value)) {
                      result = `Error: ${jsonLookingStringError("DB set")}`;
                      break;
                    }
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
              if (deployLocked) {
                result = `DEPLOY LIMIT REACHED (${deployCount}/4). Deploy is locked for this run. Do not edit or deploy again; call finish to produce a blocked build report.`;
                break;
              }
              deployCount++;
              if (deployCount > 4) {
                deployLocked = true;
                result = `DEPLOY LIMIT REACHED (${deployCount}/4). You have deployed too many times. Finish your work and call finish(shortSummary, summary) now. Something is wrong with your iteration loop — do NOT deploy again.`;
                break;
              }
              if (deployCount === 3) {
                await progress({ action: "🚀 Deploying to dev (soft limit)", detail: `(${deployCount}/4 — one more left)`, percent: currentPercent });
              } else if (deployCount === 4) {
                await progress({ action: "🚀 Deploying to dev (FINAL)", detail: `(${deployCount}/4 — last allowed)`, percent: currentPercent });
              } else {
                await progress({ action: "🚀 Deploying to dev", detail: `(${deployCount}/4)`, percent: currentPercent });
              }
              try {
                const routeError = this.validateBackendRoutes(projectDir, projectId, runKind, technicalPlan);
                validatorResults.push({ stage: "deploy_to_dev", ok: !routeError, message: routeError || undefined });
                if (routeError) {
                  result = `Error: ${routeError} Fix the referenced project files, then call deploy_to_dev() again.`;
                  deployCount--;
                  break;
                }
                commitService.syncToDev(projectId, projectDir);
                // Force-reload the dev WS so background timers and game loops
                // pick up the new routes.js without requiring clients to reconnect.
                try { forceReloadProjectWs(projectId, true); } catch {}
                result = `OK: Code deployed to development environment (deploy ${deployCount}/4).
Test frontend: ${config.baseUrl}/dev/${projectId}/

The user will visually verify. If this was your final action, in your NEXT turn call finish(shortSummary, summary) — that single atomic call ends the build. Do NOT call short_summary/summary/done — they don't exist as separate tools.`;
                deployed = true;
                lastWsFailureSignature = "";
                repeatedWsFailureCount = 0;
              } catch (err: any) {
                result = `Error deploying to dev: ${err.message}`;
              }
              break;
            }

            case "load_skill": {
              await progress({ action: "📚 Loading skill", detail: args.name, percent: currentPercent });
              const skillContent = loadSkill(args.name);
              result = skillContent || `Error: Skill "${args.name}" not found. Available: ${getAvailableSkills().join(", ")}`;
              if (skillContent && args.name) loadedSkills.add(String(args.name));
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
            case "server_logs": {
              const n = Math.min(args.lines || 50, 200);
              const rows = await prisma.appLog.findMany({
                where: { projectId },
                orderBy: { ts: "desc" },
                take: n,
                select: { ts: true, level: true, category: true, message: true },
              });
              result = rows.reverse()
                .map(r => `[${(r.ts as Date).toISOString()}] [${r.level.toUpperCase()}] ${r.message}`)
                .join("\n") || "(no logs yet for this project)";
              break;
            }

            case "simulate_telegram": {
              const update = { ...(args.update || {}) };
              if (update.update_id == null) update.update_id = Date.now();
              // Force test user id = -100
              if (update.message?.from) update.message = { ...update.message, from: { ...update.message.from, id: -100 } };
              if (update.callback_query?.from) update.callback_query = { ...update.callback_query, from: { ...update.callback_query.from, id: -100 } };
              const captured = await botRunnerService.simulateBotWebhook(projectId, update, { deployment: "development" });
              const requiresTelegramReply =
                runKind === "textBot" ||
                (runKind === "app" && Array.isArray(technicalPlan?.botBehavior) && technicalPlan.botBehavior.length > 0);
              const ok = !requiresTelegramReply || captured.length > 0;
              if (ok) {
                testsRun.telegram = true;
                result = captured.length === 0
                  ? "OK: Bot webhook processed update; no Telegram API call was required by the plan."
                  : `OK: Captured ${captured.length} tg() call(s):\n` +
                    captured.map((c: any, i: number) => `${i + 1}. ${c.method}(${JSON.stringify(c.body).slice(0, 300)})`).join("\n");
              } else {
                result = "Error: simulate_telegram expected at least one Telegram API call for the planned bot behavior, but captured none. Check backend/routes.js /bot-webhook and server_logs.";
              }
              testResults.push({ tool: "simulate_telegram", ok, detail: result.slice(0, 500) });
              break;
            }

            case "simulate_api": {
              const apiMethod = (args.method || "GET").toUpperCase();
              const apiPath = String(args.path || "").replace(/^\//, "");
              const fakeUser = buildFakeTelegramUser(args);
              const fakeInitData = fakeInitDataFor(fakeUser);
              const apiUrl = `${config.baseUrl.replace(/\/+$/, "")}/devapi/${projectId}/${apiPath}`;
              try {
                const resp = await fetch(apiUrl, {
                  method: apiMethod,
                  headers: { "Content-Type": "application/json", "x-telegram-init-data": fakeInitData },
                  body: args.body ? JSON.stringify(args.body) : undefined,
                });
                let respBody: any;
                try { respBody = await resp.json(); } catch { respBody = await resp.text(); }
                const expectedStatus = Number.isFinite(Number(args.expectStatus)) ? Number(args.expectStatus) : null;
                const infrastructure404 =
                  resp.status === 404 &&
                  typeof respBody?.error === "string" &&
                  /No backend routes configured|Endpoint not found/i.test(respBody.error);
                const ok = !infrastructure404 && (
                  expectedStatus != null ? resp.status === expectedStatus : resp.status >= 200 && resp.status < 300
                );
                const payload = { ok, method: apiMethod, url: apiUrl, status: resp.status, body: respBody };
                if (ok) {
                  testsRun.api = true;
                  result = JSON.stringify(payload, null, 2);
                } else {
                  result = `Error: simulate_api failed\n${JSON.stringify(payload, null, 2)}`;
                }
                testResults.push({ tool: "simulate_api", ok, detail: result.slice(0, 500) });
              } catch (err: any) {
                result = `Error: ${err.message}`;
                testResults.push({ tool: "simulate_api", ok: false, detail: result });
              }
              break;
            }

            case "simulate_ws": {
              try {
                const sim = await this.simulateProjectWs(projectRootDir, projectId, args);
                const wsError = this.validateWsSimulation(sim, technicalPlan);
                const observedTypes = this.observedWsTypes(sim);
                for (const type of observedTypes) wsCoverage.types.add(type);
                if (wsError) {
                  const signature = wsError.replace(/\s+/g, " ").trim();
                  repeatedWsFailureCount = signature === lastWsFailureSignature ? repeatedWsFailureCount + 1 : 1;
                  lastWsFailureSignature = signature;
                  result = `Error: ${wsError}\n${JSON.stringify(sim, null, 2).slice(0, 6000)}`;
                  if (repeatedWsFailureCount >= 2) {
                    result += "\nRepeated simulate_ws failure: change the scenario setup (seedDb/steps/expectTypes) instead of retrying the same test. If the deploy limit is exhausted, stop and call finish for a blocked build report.";
                  }
                  testResults.push({ tool: "simulate_ws", ok: false, detail: result.slice(0, 500) });
                } else {
                  lastWsFailureSignature = "";
                  repeatedWsFailureCount = 0;
                  if (sim.scenarioId) wsCoverage.scenarios.add(String(sim.scenarioId));
                  testsRun.ws = true;
                  result = JSON.stringify({ ok: true, ...sim }, null, 2).slice(0, 6000);
                  testResults.push({ tool: "simulate_ws", ok: true, detail: result.slice(0, 500) });
                }
              } catch (err: any) {
                result = `Error: ${err.message}`;
                testResults.push({ tool: "simulate_ws", ok: false, detail: result });
              }
              break;
            }

            case "set_bot_commands": {
              if (!botToken) { result = "Error: No bot token available"; break; }
              const commands = (Array.isArray(args.commands) ? args.commands : [])
                .map((c: any) => ({
                  command: String(c.command || "").replace(/^\//, "").trim(),
                  description: String(c.description || "").trim().slice(0, 256),
                }))
                .filter((c: any) => c.command && c.description);
              if (commands.length === 0) {
                result = "Error: set_bot_commands requires at least one valid command.";
                break;
              }
              const resp = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ commands }),
              });
              const body = await resp.text();
              result = `setMyCommands: ${resp.status} ${body.slice(0, 1000)}`;
              break;
            }

            case "short_summary": {
              shortSummary = args.text || "";
              result = "OK: Short summary saved. (Tool deprecated — use finish(shortSummary, summary) instead.)";
              console.log(`[Agent] 📝 short_summary: ${shortSummary.substring(0, 100)}`);
              break;
            }

            case "summary": {
              summary = args.text || "Changes applied";
              result = "OK: Summary saved. (Tool deprecated — use finish(shortSummary, summary) instead.)";
              console.log(`[Agent] 📝 summary: ${summary.substring(0, 200)}`);
              break;
            }

            case "done": {
              if (!summary) summary = "Changes applied";
              if (!shortSummary) shortSummary = summary.split("\n")[0].substring(0, 200);
              currentPercent = 100;
              console.log(`[Agent] ✅ Done after ${iterations} iterations | Total tokens: in=${totalInputTokens} out=${totalOutputTokens}`);

              try { await setRuntimeMenuButton(); } catch {}

              const readinessError = this.validateFinishReadiness(runKind, mode, technicalPlan, testsRun, deployed, testResults, wsCoverage, !!botToken);
              if (readinessError) {
                if (deployLocked) {
                  summary = `Build blocked after deploy limit was reached.\n\n${readinessError}\n\nNo further edits can be deployed or verified in this run. Start a fresh run after addressing the last failing test setup or code issue.`;
                  shortSummary = shortSummary || "Build blocked after deploy limit\n\nThe app could not be safely finished because the deploy limit was reached before required tests passed.";
                  finished = true;
                  logger.done(summary, iterations, totalInputTokens, totalOutputTokens);
                  writeDetailedLog("blocked_deploy_locked");
                  const logFilePath = logger.getLogPath();
                  logger.close();
                  return { summary, shortSummary, model: tierConfig.modelId, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheWriteTokens: totalCacheWriteTokens, cacheReadTokens: totalCacheReadTokens, logPath: logFilePath, commitNum, commitDir };
                }
                result = `Error: ${readinessError}`;
                break;
              }
              const routeError = this.validateBackendRoutes(projectDir, projectId, runKind, technicalPlan);
              validatorResults.push({ stage: "done", ok: !routeError, message: routeError || undefined });
              if (routeError) {
                if (deployLocked) {
                  summary = `Build blocked after deploy limit was reached.\n\n${routeError}\n\nNo further edits can be deployed or verified in this run. Start a fresh run to fix and redeploy.`;
                  shortSummary = shortSummary || "Build blocked after deploy limit\n\nThe app could not be safely finished because validation failed after the deploy limit was reached.";
                  finished = true;
                  logger.done(summary, iterations, totalInputTokens, totalOutputTokens);
                  writeDetailedLog("blocked_deploy_locked_route_error");
                  const logFilePath = logger.getLogPath();
                  logger.close();
                  return { summary, shortSummary, model: tierConfig.modelId, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheWriteTokens: totalCacheWriteTokens, cacheReadTokens: totalCacheReadTokens, logPath: logFilePath, commitNum, commitDir };
                }
                result = `Error: ${routeError} Fix backend/routes.js, deploy to dev, then call finish(shortSummary, summary) again.`;
                break;
              }

              try {
                const code = this.getProjectCode(projectDir);
                await projectService.storeGeneratedCode(projectId, code);
              } catch {}

              bustCache(projectDir);
              try { commitService.syncToDev(projectId, projectDir); } catch {}
              toolResults.push({ role: "tool", tool_call_id: id, content: "OK" });
              for (const tr of toolResults) messages.push(tr as any);
              finished = true;
              logger.done(summary, iterations, totalInputTokens, totalOutputTokens);
              writeDetailedLog("done");
              const logFilePath = logger.getLogPath();
              logger.close();
              return { summary, shortSummary, model: tierConfig.modelId, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheWriteTokens: totalCacheWriteTokens, cacheReadTokens: totalCacheReadTokens, logPath: logFilePath, commitNum, commitDir };
            }

            case "finish": {
              // Atomic short_summary + summary + done. Replaces 3 separate calls
              // that the model used to split across 3 iterations (~$0.50 wasted).
              shortSummary = (args.shortSummary || "").toString();
              summary = (args.summary || "Changes applied").toString();
              if (!shortSummary) shortSummary = summary.split("\n")[0].substring(0, 200);
              currentPercent = 100;
              console.log(`[Agent] 📝 finish.shortSummary: ${shortSummary.substring(0, 100)}`);
              console.log(`[Agent] 📝 finish.summary: ${summary.substring(0, 200)}`);

              console.log(`[Agent] ✅ finish() after ${iterations} iterations | Total tokens: in=${totalInputTokens} out=${totalOutputTokens}`);

              try { await setRuntimeMenuButton(); } catch {}

              const readinessError = this.validateFinishReadiness(runKind, mode, technicalPlan, testsRun, deployed, testResults, wsCoverage, !!botToken);
              if (readinessError) {
                if (deployLocked) {
                  summary = `Build blocked after deploy limit was reached.\n\n${readinessError}\n\nNo further edits can be deployed or verified in this run. Start a fresh run after addressing the last failing test setup or code issue.\n\nAgent summary before blocking:\n${summary}`;
                  shortSummary = shortSummary || "Build blocked after deploy limit\n\nThe app could not be safely finished because the deploy limit was reached before required tests passed.";
                  finished = true;
                  logger.done(summary, iterations, totalInputTokens, totalOutputTokens);
                  writeDetailedLog("blocked_deploy_locked");
                  const logFilePath2 = logger.getLogPath();
                  logger.close();
                  return { summary, shortSummary, model: tierConfig.modelId, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheWriteTokens: totalCacheWriteTokens, cacheReadTokens: totalCacheReadTokens, logPath: logFilePath2, commitNum, commitDir };
                }
                result = `Error: ${readinessError}`;
                break;
              }
              const routeError = this.validateBackendRoutes(projectDir, projectId, runKind, technicalPlan);
              validatorResults.push({ stage: "finish", ok: !routeError, message: routeError || undefined });
              if (routeError) {
                if (deployLocked) {
                  summary = `Build blocked after deploy limit was reached.\n\n${routeError}\n\nNo further edits can be deployed or verified in this run. Start a fresh run to fix and redeploy.\n\nAgent summary before blocking:\n${summary}`;
                  shortSummary = shortSummary || "Build blocked after deploy limit\n\nThe app could not be safely finished because validation failed after the deploy limit was reached.";
                  finished = true;
                  logger.done(summary, iterations, totalInputTokens, totalOutputTokens);
                  writeDetailedLog("blocked_deploy_locked_route_error");
                  const logFilePath2 = logger.getLogPath();
                  logger.close();
                  return { summary, shortSummary, model: tierConfig.modelId, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheWriteTokens: totalCacheWriteTokens, cacheReadTokens: totalCacheReadTokens, logPath: logFilePath2, commitNum, commitDir };
                }
                result = `Error: ${routeError} Fix backend/routes.js, deploy to dev, then call finish(shortSummary, summary) again.`;
                break;
              }

              try {
                const code = this.getProjectCode(projectDir);
                await projectService.storeGeneratedCode(projectId, code);
              } catch {}

              bustCache(projectDir);
              try { commitService.syncToDev(projectId, projectDir); } catch {}
              toolResults.push({ role: "tool", tool_call_id: id, content: "OK" });
              for (const tr of toolResults) messages.push(tr as any);
              finished = true;
              logger.done(summary, iterations, totalInputTokens, totalOutputTokens);
              writeDetailedLog("finish");
              const logFilePath2 = logger.getLogPath();
              logger.close();
              return { summary, shortSummary, model: tierConfig.modelId, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheWriteTokens: totalCacheWriteTokens, cacheReadTokens: totalCacheReadTokens, logPath: logFilePath2, commitNum, commitDir };
            }

            case "configure_app": {
              if (mode !== "new") {
                result = "Error: configure_app is first-build only. Do not call it during updates.";
                break;
              }
              if (configuredApp) {
                result = "Error: configure_app was already called in this build. Continue with code/deploy/finish.";
                break;
              }
              await progress({ action: "⚙️ Configuring app", detail: "name + descriptions + bot profile", percent: currentPercent });
              const name = (args.name || "").toString().trim().substring(0, 64);
              const description = (args.description || "").toString().substring(0, 120);
              const longDescription = (args.longDescription || "").toString().substring(0, 512);
              const menuButtonText = runPrefs.kind === "textBot"
                ? ""
                : (args.menuButtonText ?? "Launch App").toString().substring(0, 32);
              try {
                await projectService.updateProjectAppConfig(projectId, {
                  name,
                  description,
                  longDescription,
                  menuButtonText,
                });
                configuredApp = true;
                const lines = [
                  `db.project.name updated to "${name}"`,
                  "db.project.appDescription saved",
                  "db.project.appLongDescription saved",
                  "db.project.appMenuButtonText saved",
                ];
                if (botToken) {
                  const botResult = await projectService.configureProjectBotFromAppConfig(projectId, botToken);
                  lines.push(...botResult.lines);
                  result = `OK: App config saved to Apps Father DB and bot configured.\n${lines.join("\n")}`;
                } else {
                  lines.push("bot token not connected yet; saved config will be applied automatically when the bot is linked");
                  result = `OK: App config saved to Apps Father DB.\n${lines.join("\n")}`;
                }
              } catch (err: any) {
                result = `Error configuring app: ${err.message}`;
              }
              break;
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
        toolResults.push({ role: "tool", tool_call_id: id, content: result });

        // Close the structured step card with derived status + meta. Errors
        // are surfaced as `status: "error"` so the UI can render a red state.
        const stepStatus: "ok" | "error" = result.startsWith("Error") ? "error" : "ok";
        const stepMeta: Record<string, any> = {};
        try {
          if (name === "write_file" && typeof args?.content === "string") {
            stepMeta.lines = args.content.split("\n").length;
            stepMeta.bytes = Buffer.byteLength(args.content, "utf-8");
          } else if (name === "edit_file") {
            stepMeta.added = typeof args?.new_string === "string" ? args.new_string.split("\n").length : 0;
            stepMeta.removed = typeof args?.old_string === "string" ? args.old_string.split("\n").length : 0;
            if (args?.replace_all) stepMeta.replaceAll = true;
          } else if (name === "deploy_to_dev") {
            stepMeta.deployCount = deployCount;
          } else if (name === "shell" && typeof args?.command === "string") {
            stepMeta.command = args.command.length > 120 ? args.command.slice(0, 117) + "…" : args.command;
          } else if (name === "db") {
            stepMeta.op = args?.operation;
            if (args?.key) stepMeta.key = args.key;
          } else if (name === "fetch_url" && typeof args?.url === "string") {
            stepMeta.url = args.url;
          } else if (name === "load_skill") {
            stepMeta.name = args?.name;
          } else if (name === "telegram_api") {
            stepMeta.method = args?.method;
          }
          if (stepStatus === "error") {
            stepMeta.error = result.replace(/^Error:?\s*/i, "").slice(0, 200);
          }
        } catch {}
        await emitStepEnd(stepId, stepStatus, Object.keys(stepMeta).length ? stepMeta : undefined);
      }

      // Push each tool result as a separate message (OpenAI format).
      for (const tr of toolResults) messages.push(tr as any);

      // Metrics: log message sizes and detect stuck exploration
      const msgSize = JSON.stringify(messages).length;
      const estimatedTokens = Math.round(msgSize / 4);
      console.log(`[Agent] 📊 Iter ${iterations} | Messages: ${messages.length} | ~${estimatedTokens} tokens | Cost: $${liveCostUsd.toFixed(4)}`);
    }

    // Fallback: store code even if done() wasn't called
    const finalRouteError = this.validateBackendRoutes(projectDir, projectId, runKind, technicalPlan);
    if (finalRouteError) {
      summary = `Agent reached iteration limit with invalid backend routes: ${finalRouteError}`;
      console.warn(`[Agent] final sync blocked: ${finalRouteError}`);
    }
    try {
      const code = this.getProjectCode(projectDir);
      await projectService.storeGeneratedCode(projectId, code);
    } catch {}

    bustCache(projectDir);
    // Final sync commit folder to development/
    if (!finalRouteError) {
      try { commitService.syncToDev(projectId, projectDir); } catch {}
    }

    logger.done(summary || "Agent reached iteration limit", iterations, totalInputTokens, totalOutputTokens);
    writeDetailedLog("iteration_limit");
    const logFilePath = logger.getLogPath();
    logger.close();

    return {
      summary: summary || "Agent failed: reached iteration limit before a valid finish().",
      shortSummary: shortSummary || summary?.split("\n")[0]?.substring(0, 200) || "Build failed: iteration limit",
      model: tierConfig.modelId,
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

  private isClaudeModel(modelId: string): boolean {
    return /(?:^|\/)claude/i.test(modelId) || /anthropic\/claude/i.test(modelId);
  }

  private cloneMessageForRequest(message: any): any {
    return {
      ...message,
      content: Array.isArray(message?.content)
        ? message.content.map((block: any) => ({ ...block }))
        : message?.content,
    };
  }

  private attachCacheControlToContent(content: any): any {
    const cacheControl = { type: "ephemeral" as const };
    if (typeof content === "string") {
      const text = content.trim();
      if (!text) return content;
      return [{ type: "text", text: content, cache_control: cacheControl }];
    }

    if (!Array.isArray(content)) return content;
    const blocks = content.map((block: any) => ({ ...block }));
    for (let i = blocks.length - 1; i >= 0; i--) {
      const block = blocks[i];
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        blocks[i] = { ...block, cache_control: cacheControl };
        return blocks;
      }
    }
    return content;
  }

  /**
   * Anthropic prompt caching only works when we send explicit cache_control
   * breakpoints. Use one breakpoint for the large stable system prompt and up
   * to three more for older conversation turns. Recent turns are left uncached
   * because they change every iteration.
   */
  private applyCacheBreakpoint(modelId: string, systemPrompt: string, messages: any[]): any[] {
    if (!this.isClaudeModel(modelId)) {
      return [
        { role: "system", content: systemPrompt },
        ...messages,
      ];
    }

    const requestMessages = [
      { role: "system", content: this.attachCacheControlToContent(systemPrompt) },
      ...messages.map(message => this.cloneMessageForRequest(message)),
    ];

    let remainingBreakpoints = 3;
    const newestCacheableIndex = requestMessages.length - 4;
    for (let i = newestCacheableIndex; i >= 1 && remainingBreakpoints > 0; i--) {
      const msg = requestMessages[i] as any;
      if (!msg?.content) continue;
      const cachedContent = this.attachCacheControlToContent(msg.content);
      if (cachedContent === msg.content) continue;
      msg.content = cachedContent;
      remainingBreakpoints--;
    }

    return requestMessages;
  }

  private pruneConversation(messages: any[]): void {
    // Keep last 8 iterations (16 messages) fully intact.
    // Only prune older messages where information can be safely compressed.
    const keepRecent = 16;
    const pruneUntil = messages.length - keepRecent;
    if (pruneUntil <= 1) return;

    for (let i = 1; i < pruneUntil; i++) {
      const msg = messages[i];

      if (msg.role === "assistant" && Array.isArray(msg.content)) {
        const arr = msg.content as any[];

        // Remove thinking blocks — they cost tokens but don't help on old turns
        for (let j = arr.length - 1; j >= 0; j--) {
          if (arr[j].type === "thinking") arr.splice(j, 1);
        }

        for (const block of arr) {
          if (block.type !== "tool_use") continue;

          // write_file → structural summary (NOT placeholder)
          // Replaces 25KB of source with ~500B of routes/endpoints/keys list.
          // Agent stays oriented and does NOT re-read the file.
          if (block.name === "write_file" && block.input?.content && typeof block.input.content === "string") {
            const alreadyPruned = block.input.content.startsWith("[written");
            if (!alreadyPruned) {
              const summary = this.extractCodeSummary(block.input.content, block.input.path);
              block.input = { path: block.input.path, content: summary };
            }
          }

          // edit_file → just sizes (no structure to extract from a diff)
          if (block.name === "edit_file" && block.input?.old_string && typeof block.input.old_string === "string") {
            const alreadyPruned = block.input.old_string.startsWith("[");
            if (!alreadyPruned) {
              block.input = {
                path: block.input.path,
                old_string: `[${block.input.old_string.length} chars replaced]`,
                new_string: `[${(block.input.new_string || "").length} chars new]`,
              };
            }
          }

          // UI-only tool calls on old turns — shrink the input
          if (block.name === "set_progress") {
            block.input = {};
          }
        }
      }

      if (msg.role === "user" && Array.isArray(msg.content)) {
        for (const block of msg.content as any[]) {
          if (block.type !== "tool_result") continue;
          const content = typeof block.content === "string" ? block.content : "";
          if (!content) continue;

          // Category-based pruning — different tool results need different handling

          // UI-only tools: no useful info after the fact
          if (content.startsWith("OK: Progress set")
           || content.startsWith("OK: Task ")
           || content.startsWith("OK: Checklist created")
           || content.startsWith("OK: Short summary saved")
           || content.startsWith("OK: Summary saved")
           || content === "ok") {
            block.content = "ok";
            continue;
          }

          // read_file results — file still on disk, can be re-read if needed
          // Detected by the "N|" line-number prefix format
          if (content.length > 500 && /^\d+\|/.test(content)) {
            const firstLine = content.split("\n")[0];
            block.content = `[read_file result — file is on disk, re-read if needed. First line was: ${firstLine.substring(0, 80)}]`;
            continue;
          }

          // list_files results are short and useful — keep full

          // HTTP 200 OK successful responses — keep status line, drop body
          if (content.startsWith("HTTP 200") && content.length > 300) {
            const firstLine = content.split("\n")[0];
            block.content = `${firstLine} [body omitted — ${content.length - firstLine.length} chars]`;
            continue;
          }

          // HTTP errors (4xx/5xx) — keep intact, they're usually important

          // Shell success output — compress if large
          if (content.startsWith("OK:") && content.length > 1000) {
            block.content = content.substring(0, 500) + `\n...[${content.length - 500} chars trimmed]`;
            continue;
          }

          // Loaded skills — agent should have already copied relevant patterns
          // Heuristic: large results that look like markdown
          if (content.length > 3000 && (content.includes("## ") || content.includes("```"))) {
            block.content = `[skill/doc content loaded earlier, ${content.length} chars — agent should have extracted the needed pattern]`;
            continue;
          }

          // Generic long content — trim
          if (content.length > 800) {
            block.content = content.substring(0, 400) + `\n...[${content.length - 400} chars trimmed]`;
          }
        }
      }
    }

    // NOTE: the old "emergency pruning" that wiped message history is REMOVED.
    // It destroyed the cache entirely on every trigger (~$1 penalty) and often
    // made things worse. If we hit 150K tokens, it's better to just keep going
    // than to purge — cache reads are cheap, cache writes are not.
  }

  private summarizeArgs(toolName: string, args: any): string {
    switch (toolName) {
      case "list_files": return "";
      case "read_file": return args.offset ? `${args.path}:${args.offset}-${args.offset + (args.limit || 0)}` : args.path;
      case "write_file": return `${args.path}, ${(args.content || "").length} chars`;
      case "edit_file": return `${args.path}, "${(args.old_string || "").substring(0, 40)}..." -> "${(args.new_string || "").substring(0, 40)}..."`;
      case "grep": return `"${args.pattern}"${args.path ? ` in ${args.path}` : ""}${args.include ? ` (${args.include})` : ""}`;
      case "shell": return args.command?.substring(0, 80) || "";
      // case "http_request": return `${args.method || "GET"} ${args.url}`;  // disabled
      case "fetch_url": return args.url || "";
      case "db": return `${args.operation}(${args.key || ""})${args.value ? ", " + JSON.stringify(args.value).substring(0, 60) : ""}`;
      case "telegram_api": return args.method || "";
      case "load_skill": return args.name || "";
      case "technical_plan": return args.kind || "";
      case "server_logs": return `${args.lines || 50} lines`;
      case "simulate_telegram": return (args.update?.message?.text || args.update?.callback_query?.data || "update").substring(0, 60);
      case "simulate_api": return `${args.method || "GET"} /${args.path || ""}`;
      case "simulate_ws": return `${(args.messages || []).length || 0} message(s)`;
      case "deploy_to_dev": return "";
      case "set_progress": return `${args.percent}%`;
      case "ask_user": return (args.question || "").substring(0, 60);
      case "finish": return (args.shortSummary || "").split("\n")[0].substring(0, 80);
      case "configure_app": return `name=${args.name || "(none)"}, desc=${(args.description || "").substring(0, 30)}..., menu=${args.menuButtonText || "Launch App"}`;
      case "set_bot_commands": return `${(args.commands || []).length} command(s)`;
      case "done": return (args.summary || "").substring(0, 80);
      case "short_summary": return (args.text || "").substring(0, 80);
      case "summary": return (args.text || "").substring(0, 80);
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
  // Binary / non-text file extensions that must NEVER be read as UTF-8.
  // Reading these as text injects ~1 token per byte of garbage into the LLM
  // context (a 626KB JPEG = ~419k tokens). Always refuse with a structured note.
  private static readonly BINARY_EXTS = new Set([
    // images
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".tiff", ".tif",
    ".heic", ".heif", ".avif", ".psd", ".raw",
    // video
    ".mp4", ".mov", ".webm", ".avi", ".mkv", ".m4v", ".flv", ".wmv",
    // audio
    ".mp3", ".wav", ".ogg", ".flac", ".aac", ".m4a", ".opus", ".wma",
    // fonts
    ".woff", ".woff2", ".ttf", ".otf", ".eot",
    // archives / binaries
    ".zip", ".tar", ".gz", ".tgz", ".rar", ".7z", ".bz2", ".xz",
    ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".db", ".sqlite", ".sqlite3",
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    ".class", ".jar", ".pyc", ".o", ".a", ".node", ".wasm",
  ]);
  // Hard cap on bytes read by read_file. Anything larger gets refused with
  // guidance to use offset/limit. 512KB ≈ ~130k tokens worst case for ASCII —
  // already huge but bounded.
  private static readonly READ_FILE_MAX_BYTES = 512 * 1024;
  // Lower cap on bytes returned per call (truncation threshold for offset/limit).
  // Keeps any single read well below 100k tokens.
  private static readonly READ_FILE_SOFT_CAP_BYTES = 256 * 1024;

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
        const relPath = path.relative(base, fullPath).replace(/\\/g, "/");
        try {
          const stat = fs.statSync(fullPath);
          const sizeKB = (stat.size / 1024).toFixed(1);
          // Show binary assets in the listing so the agent knows they exist,
          // but tag them so it doesn't try to read_file them as text.
          if (AgentService.BINARY_EXTS.has(ext) || AgentService.SKIP_EXTS.has(ext)) {
            results.push(`${relPath} (${sizeKB}KB, binary — do not read_file)`);
            continue;
          }
          // Avoid loading huge text files into memory just for line counts.
          if (stat.size > AgentService.READ_FILE_MAX_BYTES) {
            results.push(`${relPath} (${sizeKB}KB, large — use grep / paged read_file)`);
            continue;
          }
          const content = fs.readFileSync(fullPath, "utf-8");
          const lineCount = content.split("\n").length;
          results.push(`${relPath} (${lineCount} lines, ${sizeKB}KB)`);
        } catch {
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

    const passportTierId = (await prisma.project.findUnique({ where: { id: projectId }, select: { userId: true } })
      .then(p => p ? prisma.user.findUnique({ where: { id: p.userId }, select: { performanceTier: true } }) : null)
      .catch(() => null))?.performanceTier;
    const passportCfg = runtimeConfig.getModelConfig("passport", passportTierId);
    const client = getOpenRouterClient();
    const response = await client.chat.completions.create({
      model: passportCfg.modelId,
      max_tokens: passportCfg.maxTokens,
      ...(this.getProviderRouting(passportCfg.modelId, passportCfg.provider) ? { provider: this.getProviderRouting(passportCfg.modelId, passportCfg.provider) } : {}),
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
    } as any);

    const passportText = response.choices[0]?.message?.content || "";
    if (!passportText) throw new Error("Failed to generate passport");

    const usage = response.usage as any;
    const inTok = usage?.prompt_tokens || 0;
    const outTok = usage?.completion_tokens || 0;
    const livePricing = await getModelPricing(passportCfg.modelId);
    const staticPricing = MODEL_PRICING[passportCfg.modelId] || { input: 0, output: 0, cache_write: 0, cache_read: 0 };
    const p = {
      input: livePricing?.promptPerToken ?? staticPricing.input,
      output: livePricing?.completionPerToken ?? staticPricing.output,
    };
    const costUsd = inTok * p.input + outTok * p.output;

    fs.writeFileSync(path.join(commitDir, "passport.md"), passportText, "utf-8");

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
    return runWithProject(projectId, async () => {
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
    }); // end runWithProject
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

      // Walk backward up to 5 commits looking for passport.md (the most
      // recent commit that has it wins). A failed/aborted build can leave a
      // commit folder without passport.md, so we don't want a single missing
      // file to wipe out all prior context. The range is [latest-5, latest],
      // stopping when index drops to 0 (commit 0 is the initial planning
      // skeleton and never carries a passport).
      const minIdx = Math.max(1, latest - 5);
      for (let i = latest; i >= minIdx; i--) {
        const dir = path.join(commitsDir, String(i));
        const passportPath = path.join(dir, "passport.md");
        if (!fs.existsSync(passportPath)) continue;
        let result = fs.readFileSync(passportPath, "utf-8");
        const historyPath = path.join(dir, "history.md");
        if (fs.existsSync(historyPath)) {
          const history = fs.readFileSync(historyPath, "utf-8");
          const recentHistory = history.split("\n").slice(-10).join("\n");
          result += "\n\n## Recent Updates\n" + recentHistory;
        }
        if (i !== latest) {
          console.log(`[loadLatestContext] passport missing in commit ${latest}, fell back to commit ${i}`);
        }
        return result;
      }

      // No passport.md in the 5-commit window — try the same window for the
      // older context.md format.
      for (let i = latest; i >= minIdx; i--) {
        const contextPath = path.join(commitsDir, String(i), "context.md");
        if (!fs.existsSync(contextPath)) continue;
        if (i !== latest) {
          console.log(`[loadLatestContext] context.md missing in commit ${latest}, fell back to commit ${i}`);
        }
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
