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

const PROJECTS_DIR = path.join(process.cwd(), "projects");
const KNOWLEDGE_DIR = path.join(process.cwd(), "agent_knowledge");
const INSTRUCTIONS_DIR = path.join(KNOWLEDGE_DIR, "instructions");
const SKILLS_DIR = path.join(KNOWLEDGE_DIR, "skills");

// What the agent knows depends on the build mode. Most instruction files are
// loaded for every run; only workflow-* files are mode-specific. Order matters —
// it's the order they appear in the system prompt. To add a new section, drop
// a .md into agent_knowledge/instructions/ and add an entry here.
type AgentMode = "new" | "update";
const INSTRUCTION_MANIFEST: Array<{ file: string; modes?: AgentMode[] }> = [
  { file: "identity.md" },
  { file: "architecture.md" },
  { file: "frontend-rules.md" },
  { file: "backend-rules.md" },
  { file: "database-design.md" },
  { file: "routes-hot-reload.md" },
  { file: "bot-webhook.md" },
  { file: "technology-choice.md" },

  { file: "best-practices.md" },
  { file: "efficiency.md" },
  // { file: "debugging.md" },

  { file: "workflow-new.md", modes: ["new"] },
  { file: "workflow-update.md", modes: ["update"] },
  { file: "telegram-api.md" },
  { file: "bot-side-updates.md" },
  { file: "after-writing.md" },
  { file: "ask-user.md" },
  { file: "progress-reporting.md" },
  { file: "skills-index.md" },
  { file: "frontend-design.md" }, // last — the always-loaded design skill block
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

function buildSystemPrompt(mode: AgentMode): string {
  const parts: string[] = [];
  const missing: string[] = [];
  const vars = buildTemplateVars();

  for (const entry of INSTRUCTION_MANIFEST) {
    if (entry.modes && !entry.modes.includes(mode)) continue;
    const content = loadInstruction(entry.file);
    if (content) parts.push(renderTemplate(content, vars));
    else missing.push(entry.file);
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
    console.warn(`[Agent] buildSystemPrompt(${mode}): ${missing.length} instruction file(s) missing: ${missing.join(", ")}`);
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
  // DISABLED: http_request was wasted on testing auth-protected endpoints
  // (always returned 401) — burning ~$0.10 per call. Re-enable only if needed.
  // {
  //   name: "http_request",
  //   description: "Make an HTTP request. Use to test API endpoints, fetch external resources, etc. Timeout: 10s.",
  //   input_schema: {
  //     type: "object" as const,
  //     properties: {
  //       url: { type: "string" as const, description: "Full URL" },
  //       method: { type: "string" as const, description: "HTTP method (GET, POST, PUT, DELETE). Default: GET" },
  //       headers: { type: "object" as const, description: "Request headers (optional)" },
  //       body: { type: "string" as const, description: "Request body as string (optional)" },
  //     },
  //     required: ["url"],
  //   },
  // },
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
  // {
  //   name: "telegram_api",
  //   description: "Call Telegram Bot API method using the project's bot token.",
  //   input_schema: {
  //     type: "object" as const,
  //     properties: {
  //       method: { type: "string" as const, description: "API method name, e.g. 'setMyDescription'" },
  //       params: { type: "object" as const, description: "Method parameters as JSON object" },
  //     },
  //     required: ["method", "params"],
  //   },
  // },
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
  // DISABLED: server_logs reads the host PM2 process logs (apps-father), which
  // mixes in OTHER projects' output and rarely shows project-specific errors.
  // It was costing ~$0.10/call for noise. Re-enable only with per-project tailing.
  // {
  //   name: "server_logs",
  //   description: "Read recent server logs (last N lines). Use to see console.log/console.error output from your backend routes.js, API errors, etc.",
  //   input_schema: {
  //     type: "object" as const,
  //     properties: {
  //       lines: { type: "number" as const, description: "Number of recent log lines to read (default 30, max 100)" },
  //     },
  //     required: [],
  //   },
  // },
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
  // NOTE: `set_progress` was removed. The frontend now drives the progress bar
  // dynamically from the message's createdAtUtc using y = 1 - e^(-Δsec/100).
  // The agent only needs to call create_todo + check_todo for user-visible status.
  {
    name: "create_todo",
    description: "Create the USER-FACING task checklist shown live in the mini-app. Call this FIRST before any work. Items must be short, plain-language descriptions a non-technical end user can read — like 'Building a design system', 'Adding login screen', 'Fixing the upload bug'. NEVER include tech specs, file names, tool names, function calls, npm commands, 'deploy', 'finish', 'configure bot' etc. — those are internal steps you still perform but must NOT appear in this list.",
    input_schema: {
      type: "object" as const,
      properties: {
        items: { type: "array" as const, items: { type: "string" as const }, description: "Array of 2-8 short, user-friendly task descriptions. NO tech jargon, NO file names, NO 'deploy'/'finish'." },
      },
      required: ["items"],
    },
  },
  {
    name: "check_todo",
    description: "Mark a checklist item as done. Call this only with some other tools like: write_file, shell, deploy_to_dev. For example: (write_file(html) + check_todo(2)). The user sees a live checklist that updates when you call this.",
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
  // CONSOLIDATED FINISH TOOL — replaces short_summary + summary + done.
  // The model used to split these across 3 iterations (~$0.50 wasted per build).
  // This forces atomic batching at the API level. Old short_summary/summary/done
  // handlers stay in code for backward compatibility but are NOT exposed in TOOLS.
  {
    name: "finish",
    description: "Atomically finish the build: save short user-facing summary, detailed technical summary, and signal completion — all in ONE call. This is the ONLY way to finish a build. Call this LAST, after deploy_to_dev. There is NO separate done/summary/short_summary tool.",
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
  // CONSOLIDATED BOT CONFIG TOOL — replaces 3 sequential telegram_api calls
  // (setMyDescription / setMyShortDescription / setChatMenuButton). The model used
  // to split these across 3 iterations (~$0.20 wasted per first build).
  {
    name: "configure_bot",
    description: "Atomically configure the bot's name, description, short description, and menu button — all in ONE call. ONLY use on FIRST build, never on updates. Use this INSTEAD of telegram_api(setMyName/setMyDescription) etc. The menu button URL is auto-generated from the project URL. The provided name is also saved as the app's name in Apps Father.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "Bot display name (up to 64 chars). Also becomes the app name in Apps Father." },
        description: { type: "string" as const, description: "Bot description shown in profile (up to 512 chars)" },
        shortDescription: { type: "string" as const, description: "Short bot description shown in chat list (up to 120 chars)" },
        menuButtonText: { type: "string" as const, description: "Text for the menu button (e.g. 'Launch App'). Default: 'Launch App'" },
      },
      required: ["name", "description", "shortDescription"],
    },
  },
];

// Pre-converted OpenAI-format tools (computed once at startup).
const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = TOOLS_DEFS.map(toOpenAITool);

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

export class AgentService {
  private isEmptyResponse(response: OpenAI.Chat.Completions.ChatCompletion): boolean {
    const msg = response.choices[0]?.message as any;
    const toolCalls = msg?.tool_calls || [];
    const content = typeof msg?.content === "string" ? msg.content : "";
    const reasoning = msg?.reasoning_content || msg?.reasoning || "";
    const completionTokens = (response.usage as any)?.completion_tokens || 0;
    return toolCalls.length === 0 && !content.trim() && !String(reasoning || "").trim() && completionTokens === 0;
  }

  private getProviderRouting(modelId: string, provider?: string): any | undefined {
    const selectedProvider = provider?.trim();
    if (selectedProvider) {
      return { only: [selectedProvider], allow_fallbacks: false };
    }
    if (modelId.toLowerCase().startsWith("minimax/")) {
      return { only: ["Minimax"], allow_fallbacks: false };
    }
    return undefined;
  }

  private validateBackendRoutes(projectDir: string, projectId: string): string | null {
    const routesPath = path.join(projectDir, "backend", "routes.js");
    if (!fs.existsSync(routesPath)) return null;

    const content = fs.readFileSync(routesPath, "utf-8");
    const hasPlatformExport = /module\.exports\s*=\s*function\s*\(\s*router\s*,\s*db\s*,\s*projectId\s*\)/.test(content);
    if (!hasPlatformExport) {
      return `backend/routes.js has invalid Apps Father format. It must export exactly: module.exports = function(router, db, projectId) { ... }. Do not export a route map/object.`;
    }
    if (/module\.exports\s*=\s*routes\b/.test(content) || /^\s*const\s+routes\s*=\s*\{/m.test(content)) {
      return `backend/routes.js uses object-style routes. Rewrite with Express router calls inside module.exports = function(router, db, projectId) { router.get('/path', ...); }.`;
    }
    if (/['"`]\s*(GET|POST|PUT|PATCH|DELETE)\s+\/api\//i.test(content)) {
      return `backend/routes.js contains object-style API route keys like "GET /api/...". Use router.get('/path', ...) and never include /api/{projectId} in backend route paths.`;
    }
    const escapedProjectId = projectId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`/api/${escapedProjectId}(?:/|['"\`])`).test(content) || /\/api\/[0-9a-f]{8}-[0-9a-f-]{27,}/i.test(content)) {
      return `backend/routes.js hardcodes /api/{projectId}. Backend routes must be relative, for example router.get('/videos', ...).`;
    }
    return null;
  }

  private async callWithRetry(params: any, maxRetries = 3): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const client = getOpenRouterClient();
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await client.chat.completions.create(params);
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

    const modelCfg = runtimeConfig.getModelConfig("ask");
    const client = getOpenRouterClient();
    const stream = await client.chat.completions.create({
      model: modelCfg.modelId,
      max_tokens: modelCfg.maxTokens,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
      ...(this.getProviderRouting(modelCfg.modelId, modelCfg.provider) ? { provider: this.getProviderRouting(modelCfg.modelId, modelCfg.provider) } : {}),
      stream: true,
    } as any) as any;

    let fullText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
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

    const modelCfg = runtimeConfig.getModelConfig("suggestions");
    const client = getOpenRouterClient();
    const response = await client.chat.completions.create({
      model: modelCfg.modelId,
      max_tokens: modelCfg.maxTokens,
      messages: [{ role: "user", content: prompt }],
      ...(this.getProviderRouting(modelCfg.modelId, modelCfg.provider) ? { provider: this.getProviderRouting(modelCfg.modelId, modelCfg.provider) } : {}),
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
    const prefsBlock = `${buildPreferencesPrompt(buildPrefs)}\n\n`;

    const prompt = `${prefsBlock}Build a complete Telegram Mini App from scratch.

Project ID: ${projectId}
Development App URL: ${config.baseUrl}/dev/${projectId}/
Development API URL: ${config.baseUrl}/devapi/${projectId}/
Production App URL: ${config.baseUrl}/app/${projectId}/
Production API URL: ${config.baseUrl}/api/${projectId}/

Description: ${description}

Plan:
${plan}
${featureGating}
Create all necessary files (frontend/index.html, frontend/styles.css, frontend/app.js, backend/routes.js) and configure the bot. Database is handled via db.get/db.set in routes.js — no schema setup needed. Make it beautiful and functional. Use deploy_to_dev() to deploy and test your code via the Dev URLs. In frontend code, use /api/${projectId}/ as the API base URL (this will be rewritten to /devapi/ in dev mode automatically).${langInstruction}`;

    return this.runAgent(projectId, prompt, onProgress, onAskUser, onCreateTodo, onCheckTodo, userBalance, undefined, "new");
    }); // end runWithProject
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
    const updatePrefsBlock = `${buildPreferencesPrompt(updatePrefs)}\n\n`;

    const prompt = 
`${updatePrefsBlock}Update an existing Telegram Mini App.

Project ID: ${projectId}
Development App URL: ${config.baseUrl}/dev/${projectId}/
Development API URL: ${config.baseUrl}/devapi/${projectId}/
Production App URL: ${config.baseUrl}/app/${projectId}/
Production API URL: ${config.baseUrl}/api/${projectId}/

Telegram Bot Link: https://t.me/${project.botUsername}
Telegram Bot Deep Link Making: https://t.me/${project.botUsername}?start={some_param}
Track Deep Link: in routes.js from /bot-webhook route track the as message of start param


${context}

Update request: 
${updateDescription}
${attachmentInfo}
${featureGating}

Use grep and read_file to verify current state before making changes. Use edit_file for targeted modifications. 
Use deploy_to_dev() to deploy and test your changes via the Dev URLs.
${langInstruction}`;

    return this.runAgent(projectId, prompt, onProgress, onAskUser, onCreateTodo, onCheckTodo, userBalance, attachments, "update");
    }); // end runWithProject
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
    mode: AgentMode = "update",
  ): Promise<AgentResult> {
    // Build the system prompt from agent_knowledge/instructions/ for THIS run.
    // Mode-gated files (workflow-new.md / workflow-update.md) are filtered by manifest.
    const systemPrompt = buildSystemPrompt(mode);
    console.log(`[Agent] system prompt built (mode=${mode}, ${systemPrompt.length} chars)`);
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
    // Load the project's preferences once so the configure_bot tool below can
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

    // Project quality tiers are disabled. Builds and updates now use one
    // runtime-configurable Code Gen model/limits profile.
    const tierConfig = runtimeConfig.getModelConfig("codegen");

    let finalPrompt = userPrompt;
    const checklistDone = new Set<number>();
    let checklist: string[] = [];
    // Mandatory tech steps (deploy_to_dev, finish) are NOT part of the user-visible
    // checklist any more — keep them only in agent memory via prompt instructions.
    const mandatoryTasks: string[] = [];
    finalPrompt += `\n\nFIRST STEP: Call create_todo() with a SHORT, USER-FRIENDLY task breakdown before starting any work. The checklist is shown directly to the end user — write items the way you'd describe progress to a non-technical person.
- GOOD items: "Building a design system", "Adding the login screen", "Fixing the upload bug", "Creating the database for users".
- BAD items (do NOT include): "deploy_to_dev", "finish()", "Write backend/routes.js", "Configure bot description", "Run npm install", file names, tool names, function calls, internal step names.
- Do NOT include "Deploy" or "Finish" as a checklist item — those steps are tracked internally and you must still perform them at the end (deploy_to_dev() then finish(shortSummary, summary)) but they MUST NOT appear in the user-visible list.

FINAL STEP (internal — never put in the checklist): After your last code change, call deploy_to_dev() once more, then call finish(shortSummary, summary). That single finish() call replaces the old short_summary/summary/done sequence. There are NO separate short_summary/summary/done tools any more.`;

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
    const writeDetailedLog = (reason: string) => {
      try {
        const detailedLogPath = path.join(commitDir, "detailed-log.json");
        fs.writeFileSync(
          detailedLogPath,
          JSON.stringify({ projectId, commitNum, mode, reason, entries: detailedEntries }, null, 2),
          "utf-8"
        );
      } catch (err: any) {
        console.warn(`[Agent] failed to write detailed-log.json (${reason}): ${err.message}`);
      }
    };
    let totalCacheReadTokens = 0;
    let currentPercent: number | undefined;
    let deployCount = 0;
    let consecutiveNoWrite = 0;

    const maxIterations = tierConfig.maxIterations ?? 60;
    const staticModelPricing = MODEL_PRICING[tierConfig.modelId] || MODEL_PRICING["anthropic/claude-sonnet-4-5"] || { input: 0, output: 0, cache_write: 0, cache_read: 0 };
    const liveModelPricing = await getModelPricing(tierConfig.modelId);
    const agentPricing = {
      input: liveModelPricing?.promptPerToken ?? staticModelPricing.input,
      output: liveModelPricing?.completionPerToken ?? staticModelPricing.output,
      cache_write: liveModelPricing?.promptPerToken ?? staticModelPricing.cache_write,
      cache_read: liveModelPricing?.promptPerToken ?? staticModelPricing.cache_read,
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

      // Build OpenAI-format request. Thinking is passed via extra_body for
      // Claude models on OpenRouter — non-Claude models ignore it gracefully.
      const thinkingBudget = tierConfig.thinkingBudget ?? 0;
      const requestPayload: any = {
        model: tierConfig.modelId,
        max_tokens: tierConfig.maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages,
        ],
        tools: TOOLS,
        tool_choice: "auto" as const,
        ...(this.getProviderRouting(tierConfig.modelId, tierConfig.provider) ? { provider: this.getProviderRouting(tierConfig.modelId, tierConfig.provider) } : {}),
        ...(thinkingBudget > 0 ? {
          extra_body: { thinking: { type: "enabled", budget_tokens: thinkingBudget } },
        } : {}),
      };
      let response: OpenAI.Chat.Completions.ChatCompletion;
      try {
        response = await this.callWithRetry(requestPayload);
      } catch (apiErr: any) {
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
      // OpenRouter may report cached token counts in non-standard fields
      const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
      const cacheCreated = 0;
      totalInputTokens += iterIn;
      totalOutputTokens += iterOut;
      totalCacheReadTokens += cached;
      // totalCacheWriteTokens stays 0 — OpenRouter handles caching transparently

      const markupMultiplier = tierConfig.markupMultiplier ?? runtimeConfig.getMarkupMultiplier();
      liveCostUsd =
        (totalInputTokens * agentPricing.input +
        totalOutputTokens * agentPricing.output +
        totalCacheWriteTokens * agentPricing.cache_write +
        totalCacheReadTokens * agentPricing.cache_read) *
        markupMultiplier;

      const assistantMsg = response.choices[0]?.message;
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
      logger.tokens(totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens, iterIn, iterOut, cached, cacheCreated, liveCostUsd);

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
        console.log(`[Agent] 🔧 Iteration ${iterations} | Tools: [${toolNames}] | Tokens so far: in=${totalInputTokens} out=${totalOutputTokens} | finish=${response.choices[0]?.finish_reason}`);
      }

      const finishReason = response.choices[0]?.finish_reason;
      if (finishReason === "stop" || (finishReason as string) === "end_turn" || assistantToolCalls.length === 0) {
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

      // HARD REJECT for UI-only batches: check_todo / set_progress are allowed
      // ONLY when the same turn also contains a real action.
      const ALLOWED_WITH_UI = new Set(["write_file", "edit_file", "deploy_to_dev", "shell"]);
      const turnHasAllowedAction = assistantToolCalls.some((tc: any) => ALLOWED_WITH_UI.has((tc as any).function?.name));

      for (const toolCall of orderedToolCalls) {
        const id = (toolCall as any).id as string;
        const name = (toolCall as any).function?.name as string;
        let args: any;
        try {
          args = JSON.parse((toolCall as any).function?.arguments || "{}");
        } catch {
          args = {};
        }
        let result = "";
        const argsSummary = this.summarizeArgs(name, args);
        logger.toolCall(name, args);

        // // HARD REJECT: UI tools without an allowed action in the same turn.
        // // The actual handler is skipped entirely — no checklist update, no progress.
        // if (!turnHasAllowedAction && (name === "check_todo" || name === "set_progress")) {
        //   result = `Error: ${name} REJECTED — must be batched in the SAME turn with one of: write_file, edit_file, deploy_to_dev, shell. Your batch contains none of these. The action was NOT executed and produced no UI update. Either include a real action together with this call, or skip the UI update entirely (don't call ${name} alone).`;
        //   logger.toolResult(name, result);
        //   console.warn(`[Agent] 🚫 Iter ${iterations}: HARD REJECTED ${name}(${argsSummary}) — no allowed action in batch`);
        //   toolResults.push({ type: "tool_result", tool_use_id: id, content: result });
        //   continue;
        // }

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

            // DISABLED: see TOOLS array comment for http_request.
            // case "http_request": {
            //   await progress({ action: "🌐 Testing server...", detail: "", percent: currentPercent });
            //   try {
            //     const controller = new AbortController();
            //     const timeout = setTimeout(() => controller.abort(), 10000);
            //
            //     const resp = await fetch(args.url, {
            //       method: (args.method || "GET").toUpperCase(),
            //       headers: args.headers || {},
            //       body: args.body || undefined,
            //       signal: controller.signal,
            //     });
            //     clearTimeout(timeout);
            //
            //     const body = await resp.text();
            //     result = `HTTP ${resp.status} ${resp.statusText}\n${body.substring(0, 5000)}`;
            //   } catch (err: any) {
            //     result = `Error: ${err.message}`;
            //     console.error(`[Agent] http_request error:`, err.message);
            //   }
            //   break;
            // }

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
              if (deployCount > 4) {
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
                const routeError = this.validateBackendRoutes(projectDir, projectId);
                if (routeError) {
                  result = `Error: ${routeError} Fix backend/routes.js, then call deploy_to_dev() again.`;
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

            // DISABLED: see TOOLS array comment for server_logs.
            // case "server_logs": {
            //   await progress({ action: "📋 Reading logs", detail: "", percent: currentPercent });
            //   try {
            //     const numLines = Math.min(args.lines || 30, 100);
            //     const { stdout } = await execAsync(`pm2 logs apps-father --lines ${numLines} --nostream 2>&1`, {
            //       timeout: 5000,
            //       maxBuffer: 512 * 1024,
            //     });
            //     result = stdout.substring(0, 8000);
            //   } catch (err: any) {
            //     result = `Error reading logs: ${err.message}`;
            //   }
            //   break;
            // }

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

            // case "set_progress": {
            //   // DEPRECATED: kept only so re-played transcripts don't blow up.
            //   // Progress bar is now computed in the frontend from createdAtUtc.
            //   result = "OK (set_progress is deprecated and ignored — the progress bar is now driven by elapsed time on the frontend; just use check_todo).";
            //   break;
            // }

            case "create_todo": {
              const items = (args.items || []).filter((s: any) => typeof s === "string").slice(0, 10);
              checklist = [...items, ...mandatoryTasks];
              checklistDone.clear();
              if (onCreateTodo) {
                try { await onCreateTodo(items); } catch {}
              }
              result = `OK: Checklist created with ${checklist.length} user-facing tasks. Use check_todo(id) to mark each done. Remember: deploy_to_dev() and finish() are internal steps — perform them at the end but they are NOT in this checklist.`;
              console.log(`[Agent] 📋 create_todo: ${checklist.length} user tasks`);
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

            // NOTE: short_summary / summary / done handlers are kept for backward
            // compatibility (e.g. older transcripts re-played) but are NOT exposed
            // to the model in TOOLS — model must use `finish(shortSummary, summary)`.
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
              // Auto-check anything the model forgot — work was clearly finished if
              // we're at done(). Only emit onCheckTodo for user-visible items
              // (mandatory tasks aren't shown to the user).
              if (checklist.length > 0 && checklistDone.size < checklist.length) {
                const userItemCount = checklist.length - mandatoryTasks.length;
                const missing = checklist.filter((_, i) => !checklistDone.has(i + 1));
                console.log(`[Agent] auto-checking ${checklist.length - checklistDone.size} remaining tasks at done(): ${missing.join(", ")}`);
                for (let i = 1; i <= checklist.length; i++) {
                  if (checklistDone.has(i)) continue;
                  checklistDone.add(i);
                  if (onCheckTodo && i <= userItemCount) {
                    try { await onCheckTodo(i); } catch {}
                  }
                }
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

              const routeError = this.validateBackendRoutes(projectDir, projectId);
              if (routeError) {
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

              if (checklist.length > 0 && checklistDone.size < checklist.length) {
                const userItemCount = checklist.length - mandatoryTasks.length;
                const missing = checklist.filter((_, i) => !checklistDone.has(i + 1));
                console.log(`[Agent] auto-checking ${checklist.length - checklistDone.size} remaining tasks at finish(): ${missing.join(", ")}`);
                for (let i = 1; i <= checklist.length; i++) {
                  if (checklistDone.has(i)) continue;
                  checklistDone.add(i);
                  if (onCheckTodo && i <= userItemCount) {
                    try { await onCheckTodo(i); } catch {}
                  }
                }
              }
              console.log(`[Agent] ✅ finish() after ${iterations} iterations | Total tokens: in=${totalInputTokens} out=${totalOutputTokens}`);

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

              const routeError = this.validateBackendRoutes(projectDir, projectId);
              if (routeError) {
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
              logger.done(summary, iterations, totalInputTokens, totalOutputTokens);
              writeDetailedLog("finish");
              const logFilePath2 = logger.getLogPath();
              logger.close();
              return { summary, shortSummary, model: tierConfig.modelId, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheWriteTokens: totalCacheWriteTokens, cacheReadTokens: totalCacheReadTokens, logPath: logFilePath2, commitNum, commitDir };
            }

            case "configure_bot": {
              // Atomic telegram_api calls. Replaces the model splitting them
              // across 3-4 iterations (~$0.20 wasted on each first build).
              // Also mirrors the chosen `name` into the project row so the
              // mini-app's app list shows the meaningful name (e.g. "Crypto
              // Wallet") instead of the placeholder used at project creation
              // time ("New App").
              if (!botToken) {
                result = "Error: bot token not available for this project";
                break;
              }
              await progress({ action: "🤖 Configuring bot", detail: "name + description + menu", percent: currentPercent });
              const name = (args.name || "").toString().trim().substring(0, 64);
              const description = (args.description || "").toString().substring(0, 512);
              const shortDescription = (args.shortDescription || "").toString().substring(0, 120);
              // Text Bot projects must NEVER expose a Mini App menu button —
              // there's no `mini_app/` deployed for them, so a `web_app` button
              // would 404 (or hit the textBot fallback page). Force-clear the
              // menu button instead, regardless of what the agent passed in.
              // The textBot.md rules also tell the agent to send `""`, but the
              // platform is the source of truth here.
              const isTextBot = runPrefs.kind === "textBot";
              const menuButtonText = (args.menuButtonText ?? "Launch App").toString().substring(0, 32);
              const appUrl = `${config.baseUrl}/app/${projectId}/`;
              const callApi = async (method: string, params: any) => {
                const resp = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(params),
                });
                return { method, status: resp.status, body: await resp.text() };
              };
              try {
                const menuButtonPayload = isTextBot
                  ? { menu_button: { type: "default" as const } }
                  : { menu_button: { type: "web_app" as const, text: menuButtonText, web_app: { url: appUrl } } };
                const calls: Array<Promise<{ method: string; status: number; body: string }>> = [
                  callApi("setMyDescription", { description }),
                  callApi("setMyShortDescription", { short_description: shortDescription }),
                  callApi("setChatMenuButton", menuButtonPayload),
                ];
                if (name) {
                  calls.push(callApi("setMyName", { name }));
                }
                const results = await Promise.all(calls);
                const lines = results.map(r => `${r.method}: ${r.status} ${r.body.substring(0, 200)}`);

                // Mirror name to Apps Father DB so the project list shows it.
                // Failure here must not fail the whole tool — telegram side is
                // authoritative for the bot, our DB is just a cached display.
                if (name) {
                  try {
                    await projectService.updateProjectName(projectId, name);
                    lines.push(`db.project.name updated to "${name}"`);
                  } catch (dbErr: any) {
                    lines.push(`db.project.name update failed: ${dbErr.message}`);
                  }
                }

                result = `OK: Bot configured atomically.\n${lines.join("\n")}`;
              } catch (err: any) {
                result = `Error configuring bot: ${err.message}`;
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
      }

      // Push each tool result as a separate message (OpenAI format).
      for (const tr of toolResults) messages.push(tr as any);

      // DISABLED: pruneConversation mutates older messages and breaks Anthropic
      // prompt cache (cacheRead drops to 0 after first prune, causing 5-10x cost
      // spike on long builds). Cache reads are ~12x cheaper than fresh input,
      // so keeping the full history cached is far cheaper than pruning it.
      // Re-enable only if we hit the 200K context window in practice.
      // this.pruneConversation(messages);

      // (UI-only batches are now hard-rejected up-front in the for-loop above —
      //  see the HARD REJECT block. No post-hoc warning needed.)

      // Metrics: log message sizes and detect stuck exploration
      const msgSize = JSON.stringify(messages).length;
      const estimatedTokens = Math.round(msgSize / 4);
      console.log(`[Agent] 📊 Iter ${iterations} | Messages: ${messages.length} | ~${estimatedTokens} tokens | Cost: $${liveCostUsd.toFixed(4)}`);

      const hasWrite = assistantToolCalls.some((tc: any) =>
        ["write_file", "edit_file"].includes((tc as any).function?.name)
      );

      // Track consecutive iterations without writes
      if (!hasWrite) {
        consecutiveNoWrite++;
      } else {
        consecutiveNoWrite = 0;
      }

      // // Inject warnings INTO the next tool_result so the agent actually sees them
      // let budgetWarning = "";
      // if (consecutiveNoWrite === 5) {
      //   budgetWarning = "\n\n⚠️ BUDGET WARNING: You have spent 5 iterations without writing code. Commit to a decision and start writing NOW, or call finish(shortSummary, summary) if you cannot make progress.";
      // } else if (consecutiveNoWrite >= 8) {
      //   budgetWarning = "\n\n🚨 CRITICAL: 8+ iterations without writing code. This session is burning money on exploration. Write code in your NEXT turn or call finish(shortSummary, summary) with an honest explanation of why you're stuck.";
      // }
      // if (iterations === Math.floor(maxIterations * 0.7)) {
      //   budgetWarning += `\n\n⏳ ITERATION BUDGET: You are at ${iterations}/${maxIterations} iterations (70%). Wrap up remaining work and prepare to call finish(shortSummary, summary).`;
      // }
      // if (iterations === Math.floor(maxIterations * 0.9)) {
      //   budgetWarning += `\n\n🛑 FINAL ITERATIONS: You are at ${iterations}/${maxIterations} (90%). Call finish(shortSummary, summary) NOW. No more exploration.`;
      // }

      // // Append warning to the last tool_result if there was one
      // if (budgetWarning && toolResults.length > 0) {
      //   const last = toolResults[toolResults.length - 1];
      //   if (typeof last.content === "string") {
      //     last.content = last.content + budgetWarning;
      //   }
      // }

      if (!hasWrite && iterations > 5) {
        console.warn(`[Agent] ⚠️ Iteration ${iterations} had no writes (streak: ${consecutiveNoWrite}) — agent may be stuck`);
      }
    }

    // Fallback: store code even if done() wasn't called
    const finalRouteError = this.validateBackendRoutes(projectDir, projectId);
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
      summary: summary || "App updated (agent reached iteration limit)",
      shortSummary: shortSummary || summary?.split("\n")[0]?.substring(0, 200) || "Update completed",
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

  /**
   * Attach a cache_control breakpoint on the last message that's at least 4
   * messages old. Recent messages stay uncached (they change each turn),
   * everything before them is served from cache at ~10x discount.
   *
   * This mutates the messages — but only via a shallow copy of the target
   * block, so the caller's messages array stays clean for subsequent iters.
   */
  /** @deprecated No longer used — OpenRouter handles caching transparently. */
  private applyCacheBreakpoint(messages: any[]): any[] {
    return messages;
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
          if (block.name === "check_todo" || block.name === "set_progress") {
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
      // case "server_logs": return `${args.lines || 30} lines`;  // disabled
      case "deploy_to_dev": return "";
      case "check_todo": return `task #${args.id}`;
      case "set_progress": return `${args.percent}%`;
      case "create_todo": return `${(args.items || []).length} items`;
      case "ask_user": return (args.question || "").substring(0, 60);
      case "finish": return (args.shortSummary || "").split("\n")[0].substring(0, 80);
      case "configure_bot": return `name=${args.name || "(none)"}, desc=${(args.description || "").substring(0, 30)}..., menu=${args.menuButtonText || "Launch App"}`;
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

    const passportCfg = runtimeConfig.getModelConfig("passport");
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
    const markupMul = passportCfg.markupMultiplier ?? runtimeConfig.getMarkupMultiplier();
    const livePricing = await getModelPricing(passportCfg.modelId);
    const staticPricing = MODEL_PRICING[passportCfg.modelId] || { input: 0, output: 0, cache_write: 0, cache_read: 0 };
    const p = {
      input: livePricing?.promptPerToken ?? staticPricing.input,
      output: livePricing?.completionPerToken ?? staticPricing.output,
    };
    const costUsd = (inTok * p.input + outTok * p.output) * markupMul;

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
