import OpenAI from "openai";
import { getModelPricing, getOpenRouterClient } from "./openrouter.service";
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
import { prisma } from "../db";
import { PROJECTS_DIR, KNOWLEDGE_DIR } from "./agent/paths";
import { AgentMode, normalizeProjectKind } from "./agent/types";
import { buildSystemPrompt, getAvailableSkills, loadSkill, workflowFileFor } from "./agent/instruction-loader";
import {
  observedWsTypes,
  validateBackendRoutes,
  validateFinishReadiness,
  validateWsSimulation,
} from "./agent/validation";
import {
  BINARY_EXTS,
  BLOCKED_COMMANDS,
  BLOCKED_INFRA_SHELL_PATTERNS,
  PASSPORT_REGEN_EVERY,
  READ_FILE_MAX_BYTES,
  READ_FILE_SOFT_CAP_BYTES,
  SKIP_DIRS,
  SKIP_EXTS,
} from "./agent/config";
import { AGENT_TOOLS, SERVER_TOOLS } from "./agent/tools/registry";
import { ASK_TOOLS } from "./agent/tools/ask-tools";
import { ToolStepKind, TOOL_DISPLAY, buildToolStepTarget, summarizeToolArgs } from "./agent/tools/presentation";

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

export type AgentStepKind = ToolStepKind;

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
  /**
   * Agent-authored short delta describing the architectural changes from
   * THIS commit (new/removed routes, DB keys, screens, decisions). Populated
   * when the agent calls `finish(context_diff=...)`. Falls back to "" when
   * the agent forgets — the platform then derives a delta from `summary`.
   * Used by the cheap append-passport path; ignored on full-regen commits.
   */
  contextDiff?: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  logPath?: string;
  commitNum?: number;
  commitDir?: string;
  /** Total tool-call steps executed by the agent */
  stepCount?: number;
  /** Wall-clock duration of the run in milliseconds */
  durationMs?: number;
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

    const platformOverview = this.loadAskPlatformOverview();

    const systemPrompt = `You are a friendly assistant helping an app owner (non-technical person) understand their Telegram Mini App built on Apps Father.
Answer in simple, everyday language. NO programming terms, NO code, NO file names, NO technical jargon.
Talk as if explaining to a friend who doesn't know anything about coding.
Use markdown formatting: **bold**, lists (- item), headings (## Title) to keep it readable.
If the question is about app data/users/stats, give clear numbers and insights.
Keep answers concise and actionable.${langInstruction}

────────────────  APPS FATHER PLATFORM (what the owner can do here) ────────────────
${platformOverview}
────────────────────────────────────────────────────────────────────────────────────

You have tools — USE them whenever the question is about *this specific project*:
- project_info()              — name, kind, description, plan, prefs, locked features.
- list_files()                — see what files the project has.
- read_file(path, offset?, limit?) — peek into the live app code (frontend/, backend/).
- db_query({ action, key?, prefix?, limit? }) — read the project's key/value store.
    action="list"  → recent keys (with prefix filter); shows truncated values.
    action="get"   → value for a single key.
    action="count" → count of keys (with optional prefix).
- platform_help(topic?)       — deeper Apps Father feature docs (topics: payments,
    referrals, realtime, bot, billing, tiers). No topic = the high-level overview.

Tool guidelines:
- Prefer tools over guessing. If the owner asks "how many users?" → db_query count.
- Don't dump tool output verbatim. Translate findings into plain language.
- Never expose file paths, code, SQL, or stack traces in your final answer.
- 1–3 tool calls per turn is plenty. Avoid fishing expeditions.

APP DESCRIPTION:
${description.substring(0, 2000)}

PROJECT CONTEXT:
${context.substring(0, 6000)}

${lastUpdate ? `LAST UPDATE SUMMARY:\n${lastUpdate.substring(0, 2000)}\n` : ""}
${dbSummary ? `DB KEYS SUMMARY:\n${dbSummary}\n` : ""}`;

    const messages: any[] = [{ role: "system", content: systemPrompt }];
    if (conversationHistory && conversationHistory.length > 0) {
      for (const msg of conversationHistory) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
    messages.push({ role: "user", content: question });

    const modelCfg = runtimeConfig.getModelConfig("ask", tierId);
    const askReasoningBudget = (modelCfg as any).reasoningBudget ?? 0;
    const askSessionId = crypto.randomUUID();
    const askOwner = project?.userId
      ? await prisma.user.findUnique({ where: { id: project.userId }, select: { telegramId: true } })
      : null;
    const askTelegramId = askOwner?.telegramId ? String(askOwner.telegramId) : undefined;

    let fullText = "";
    let inputTokens = 0;
    let outputTokens = 0;

    const MAX_ITERATIONS = 4;
    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const params: any = {
        model: modelCfg.modelId,
        max_tokens: modelCfg.maxTokens,
        messages,
        tools: ASK_TOOLS,
        tool_choice: "auto",
        ...(askTelegramId ? { user: askTelegramId } : {}),
        extra_body: { session_id: askSessionId },
        ...(this.getProviderRouting(modelCfg.modelId, modelCfg.provider) ? { provider: this.getProviderRouting(modelCfg.modelId, modelCfg.provider) } : {}),
        ...(askReasoningBudget > 0 ? { reasoning: { max_tokens: askReasoningBudget } } : {}),
      };

      let response: OpenAI.Chat.Completions.ChatCompletion;
      try {
        response = await this.streamAgentCall(params, {
          onTextDelta: (_delta) => {
            // Concatenate text across tool-call iterations so the UI sees a
            // continuous stream rather than restarting on each tool result.
            fullText += _delta;
            onChunk(_delta, fullText);
          },
        });
      } catch (err) {
        // Some models / providers don't support tool streaming; fall back to a
        // non-streaming call without tools so the owner still gets an answer.
        console.warn("[Ask] Tool streaming failed, falling back to plain answer:", (err as Error).message);
        const fallback = await getOpenRouterClient().chat.completions.create({
          ...params,
          tools: undefined,
          tool_choice: undefined,
        } as any) as OpenAI.Chat.Completions.ChatCompletion;
        const txt = fallback.choices?.[0]?.message?.content || "";
        if (txt) {
          fullText += txt;
          onChunk(txt, fullText);
        }
        if (fallback.usage) {
          inputTokens += fallback.usage.prompt_tokens || 0;
          outputTokens += fallback.usage.completion_tokens || 0;
        }
        break;
      }

      if (response.usage) {
        inputTokens += response.usage.prompt_tokens || 0;
        outputTokens += response.usage.completion_tokens || 0;
      }

      const choice = response.choices?.[0];
      const assistantMsg: any = choice?.message || {};
      const toolCalls = assistantMsg.tool_calls || [];

      messages.push({
        role: "assistant",
        content: assistantMsg.content || "",
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });

      if (toolCalls.length === 0 || choice?.finish_reason === "stop") {
        break;
      }

      // Execute every tool call sequentially and append a tool message per id.
      for (const tc of toolCalls) {
        let argsObj: any = {};
        try { argsObj = JSON.parse(tc.function?.arguments || "{}"); } catch {}
        const toolResult = await this.runAskTool(tc.function?.name || "", argsObj, projectId);
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: toolResult,
        });
      }
    }

    return {
      text: fullText || "Unable to answer.",
      inputTokens,
      outputTokens,
    };
  }

  // ─────────────────────  Ask tool dispatch  ─────────────────────

  /**
   * Resolve the directory the ask tools should read from. We prefer the
   * deployed `development/` mirror because it reflects what the owner
   * actually sees; if it's not built yet we fall back to the latest commit.
   */
  private resolveAskProjectDir(projectId: string): string | null {
    const devDir = path.join(PROJECTS_DIR, projectId, "development");
    if (fs.existsSync(devDir)) return devDir;
    try {
      const commitsDir = path.join(PROJECTS_DIR, projectId, "commits");
      if (!fs.existsSync(commitsDir)) return null;
      const nums = fs.readdirSync(commitsDir).map(Number).filter(n => !isNaN(n));
      if (nums.length === 0) return null;
      const latest = Math.max(...nums);
      return path.join(commitsDir, String(latest));
    } catch { return null; }
  }

  private loadAskPlatformOverview(): string {
    try {
      const p = path.join(KNOWLEDGE_DIR, "ask", "platform-overview.md");
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
    } catch {}
    return "(platform overview unavailable)";
  }

  private async runAskTool(name: string, args: any, projectId: string): Promise<string> {
    try {
      switch (name) {
        case "project_info": {
          const p: any = await projectService.getProject(projectId);
          if (!p) return "Project not found.";
          const features = await getProjectFeatures(projectId).catch(() => [] as string[]);
          const prefs = p.preferences ? (typeof p.preferences === "string" ? p.preferences : JSON.stringify(p.preferences)) : "(default)";
          const info = {
            name: p.name || "(unnamed)",
            kind: p.kind || "app",
            status: p.status || "unknown",
            description: (p.description || "").substring(0, 1500),
            hasPlan: !!p.plan,
            createdAt: p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : null,
            updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString().slice(0, 10) : null,
            botUsername: p.botUsername || null,
            preferences: prefs.substring(0, 800),
            paidFeatures: {
              telegram_stars: features.includes("telegram_stars") ? "UNLOCKED" : "LOCKED",
              ton_payment: features.includes("ton_payment") ? "UNLOCKED" : "LOCKED",
            },
          };
          return JSON.stringify(info, null, 2);
        }

        case "list_files": {
          const dir = this.resolveAskProjectDir(projectId);
          if (!dir) return "Project has no built files yet.";
          const files = this.walkDirWithStats(dir, dir);
          if (files.length === 0) return "(empty project)";
          // Cap to keep tool result small and on-budget for the model.
          return files.slice(0, 80).join("\n") + (files.length > 80 ? `\n... +${files.length - 80} more` : "");
        }

        case "read_file": {
          const dir = this.resolveAskProjectDir(projectId);
          if (!dir) return "Project has no built files yet.";
          if (typeof args?.path !== "string" || !args.path) return "Error: path is required.";
          const filePath = this.safePath(dir, args.path);
          if (!filePath) return "Error: invalid path.";
          if (!fs.existsSync(filePath)) return `Error: file not found: ${args.path}`;

          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) return `Error: ${args.path} is a directory; use list_files instead.`;

          const ext = path.extname(args.path).toLowerCase();
          const sizeKB = (stat.size / 1024).toFixed(1);
          if (BINARY_EXTS.has(ext)) {
            return `Error: ${args.path} is a binary file (${ext}, ${sizeKB}KB) and cannot be read as text.`;
          }
          if (!args.offset && !args.limit && stat.size > READ_FILE_SOFT_CAP_BYTES) {
            return `Error: ${args.path} is ${sizeKB}KB; pass offset+limit to page through it.`;
          }
          if (stat.size > READ_FILE_MAX_BYTES) {
            return `Error: ${args.path} is ${sizeKB}KB; too large to read.`;
          }

          const content = fs.readFileSync(filePath, "utf-8");
          const lines = content.split("\n");
          if (args.offset || args.limit) {
            const start = Math.max(0, (args.offset || 1) - 1);
            const end = args.limit ? start + args.limit : lines.length;
            return lines.slice(start, end).map((l, i) => `${start + i + 1}|${l}`).join("\n");
          }
          // Cap full reads at ~20KB to keep tool responses lean.
          if (Buffer.byteLength(content, "utf-8") > 20 * 1024) {
            const sliced = content.slice(0, 20 * 1024);
            return sliced + `\n... [truncated; pass offset+limit to read more]`;
          }
          return lines.map((l, i) => `${i + 1}|${l}`).join("\n");
        }

        case "db_query": {
          const action = String(args?.action || "").toLowerCase();
          if (!["list", "get", "count"].includes(action)) {
            return "Error: action must be one of 'list', 'get', 'count'.";
          }
          const Database = require("better-sqlite3");
          const dbPath = path.join(PROJECTS_DIR, projectId, "development", "data", "app.db");
          if (!fs.existsSync(dbPath)) return "(no database yet — the app hasn't stored anything)";
          const db = new Database(dbPath, { readonly: true });
          try {
            if (action === "count") {
              const prefix = typeof args.prefix === "string" ? args.prefix : null;
              const row: any = prefix
                ? db.prepare("SELECT COUNT(*) AS n FROM kv WHERE key LIKE ?").get(`${prefix}%`)
                : db.prepare("SELECT COUNT(*) AS n FROM kv").get();
              return JSON.stringify({ action: "count", prefix, count: row?.n || 0 });
            }
            if (action === "get") {
              if (typeof args.key !== "string" || !args.key) return "Error: key is required for action=get.";
              const row: any = db.prepare("SELECT value FROM kv WHERE key = ?").get(args.key);
              if (!row) return JSON.stringify({ key: args.key, value: null, found: false });
              const truncated = row.value.length > 4000 ? row.value.slice(0, 4000) + "...(truncated)" : row.value;
              return JSON.stringify({ key: args.key, value: truncated, found: true });
            }
            // list
            const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
            const prefix = typeof args.prefix === "string" ? args.prefix : null;
            const rows: any[] = prefix
              ? db.prepare("SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key LIMIT ?").all(`${prefix}%`, limit)
              : db.prepare("SELECT key, value FROM kv ORDER BY key LIMIT ?").all(limit);
            const out = rows.map(r => ({
              key: r.key,
              value: r.value.length > 200 ? r.value.slice(0, 200) + "..." : r.value,
            }));
            return JSON.stringify({ action: "list", prefix, returned: out.length, limit, items: out });
          } finally {
            try { db.close(); } catch {}
          }
        }

        case "platform_help": {
          const topic = (typeof args?.topic === "string" ? args.topic : "").toLowerCase().trim();
          const askDir = path.join(KNOWLEDGE_DIR, "ask");
          if (!topic) {
            const overview = this.loadAskPlatformOverview();
            return overview;
          }
          const allowed = new Set(["payments", "referrals", "realtime", "bot", "billing", "tiers"]);
          if (!allowed.has(topic)) {
            return `Unknown topic. Available: ${[...allowed].join(", ")}`;
          }
          const file = path.join(askDir, "topics", `${topic}.md`);
          if (!fs.existsSync(file)) return `Topic '${topic}' has no doc yet.`;
          return fs.readFileSync(file, "utf-8");
        }

        default:
          return `Unknown tool: ${name}`;
      }
    } catch (err: any) {
      return `Tool '${name}' error: ${err?.message || String(err)}`;
    }
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

    const dbSnapshot = new Map<string, any>();
    const dbPath = path.join(projectRootDir, "development", "data", "app.db");
    if (fs.existsSync(dbPath)) {
      const Database = require("better-sqlite3");
      const sqlite = new Database(dbPath, { readonly: true });
      try {
        const rows = sqlite.prepare("SELECT key, value FROM kv").all() as any[];
        for (const row of rows) dbSnapshot.set(row.key, JSON.parse(row.value));
      } catch {
        // Missing/empty kv table is fine for a WS-only simulation.
      } finally {
        try { sqlite.close(); } catch {}
      }
    }

    const project = await projectService.getProject(projectId);
    const dbMutations: Array<{ operation: "set" | "delete"; key: string }> = [];
    const db = {
      get(key: string) {
        return dbSnapshot.has(key) ? dbSnapshot.get(key) : null;
      },
      set(key: string, value: any) {
        if (isJsonLookingString(value)) throw new Error(jsonLookingStringError(`simulate_ws db.set "${key}"`));
        dbSnapshot.set(key, value);
        dbMutations.push({ operation: "set", key });
      },
      delete(key: string) {
        dbSnapshot.delete(key);
        dbMutations.push({ operation: "delete", key });
      },
      keys() {
        return [...dbSnapshot.keys()];
      },
      getAll() {
        const all: Record<string, any> = {};
        for (const [key, value] of dbSnapshot.entries()) all[key] = value;
        return all;
      },
      botToken: project?.botTokenEncrypted ? decryptToken(project.botTokenEncrypted) : "SIMULATE_TOKEN",
      botUsername: project?.botUsername || "simulate_bot",
      projectId,
    };

    try { delete require.cache[require.resolve(routesPath)]; } catch {}
    const routeModule = require(routesPath);
    if (typeof routeModule.ws !== "function") {
      throw new Error("backend/routes.js does not export module.exports.ws");
    }

    const messages = Array.isArray(args.messages) ? args.messages : [];
    if (messages.length === 0) {
      throw new Error("simulate_ws requires messages: [{ clientId, data }]. It does not send default/auth/setup messages.");
    }

    const clientsInput = Array.isArray(args.clients) && args.clients.length > 0
      ? args.clients
      : [...new Set(messages.map((msg: any) => String(msg.clientId || msg.id || "a")))].map((id, index) => ({
        id,
        userId: -100 - index,
      }));
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
      if (!Object.prototype.hasOwnProperty.call(msg, "data")) {
        throw new Error(`simulate_ws message for client "${clientId}" requires a data field.`);
      }
      const data = typeof msg.data === "string" ? msg.data : JSON.stringify(msg.data);
      for (const cb of handlers.get(clientId)?.get("message") || []) {
        cb(Buffer.from(data));
      }
    };

    for (const msg of messages) sendWsMessage(msg);
    await new Promise(r => setTimeout(r, 50));
    return {
      scenarioId: args.scenarioId,
      clients: clientsInput,
      sentMessages: messages.length,
      captured,
      expectedTypes: Array.isArray(args.expectTypes) ? args.expectTypes.map(String) : [],
      dbMutations,
      dbPersisted: false,
    };
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
    const runStartMs = Date.now();
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
    let contextDiff = "";
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
        tools: [...AGENT_TOOLS, ...SERVER_TOOLS],
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
        const argsSummary = summarizeToolArgs(name, args);
        logger.toolCall(name, args);

        // Open a structured step card for this tool call. We always close it
        // in the `finally` below (with status + meta computed from `result`).
        const stepKindCfg = TOOL_DISPLAY[name] || { kind: "thinking" as AgentStepKind, title: name };
        const stepTarget = buildToolStepTarget(name, args) as AgentProgress["target"] | undefined;
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
              if (BINARY_EXTS.has(ext)) {
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
              if (!args.offset && !args.limit && stat.size > READ_FILE_SOFT_CAP_BYTES) {
                result = `Error: ${args.path} is ${sizeKB}KB which exceeds the 256KB full-read cap. ` +
                  `Use offset+limit to page through it (e.g. read_file({path, offset: 1, limit: 500})), ` +
                  `or run grep first to locate the specific section you need.`;
                break;
              }
              if (stat.size > READ_FILE_MAX_BYTES) {
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
                if (Buffer.byteLength(body, "utf-8") > READ_FILE_SOFT_CAP_BYTES) {
                  body = body.slice(0, READ_FILE_SOFT_CAP_BYTES) +
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
                const routeError = validateBackendRoutes(projectDir, projectId, runKind, technicalPlan);
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
                const wsError = validateWsSimulation(sim, technicalPlan);
                const observedTypes = observedWsTypes(sim);
                for (const type of observedTypes) wsCoverage.types.add(type);
                if (wsError) {
                  const signature = wsError.replace(/\s+/g, " ").trim();
                  repeatedWsFailureCount = signature === lastWsFailureSignature ? repeatedWsFailureCount + 1 : 1;
                  lastWsFailureSignature = signature;
                  result = `Error: ${wsError}\n${JSON.stringify(sim, null, 2).slice(0, 6000)}`;
                  if (repeatedWsFailureCount >= 2) {
                    result += "\nRepeated simulate_ws failure: change the explicit clients/messages/expectTypes instead of retrying the same test. If the deploy limit is exhausted, stop and call finish for a blocked build report.";
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

            case "finish": {
              // Atomic short_summary + summary + done. Replaces 3 separate calls
              // that the model used to split across 3 iterations (~$0.50 wasted).
              shortSummary = (args.shortSummary || "").toString();
              summary = (args.summary || "Changes applied").toString();
              contextDiff = (args.context_diff || "").toString();
              if (!shortSummary) shortSummary = summary.split("\n")[0].substring(0, 200);
              currentPercent = 100;
              console.log(`[Agent] 📝 finish.shortSummary: ${shortSummary.substring(0, 100)}`);
              console.log(`[Agent] 📝 finish.summary: ${summary.substring(0, 200)}`);
              if (contextDiff) console.log(`[Agent] 📝 finish.context_diff: ${contextDiff.substring(0, 200)}`);

              console.log(`[Agent] ✅ finish() after ${iterations} iterations | Total tokens: in=${totalInputTokens} out=${totalOutputTokens}`);

              try { await setRuntimeMenuButton(); } catch {}

              const readinessError = validateFinishReadiness(runKind, mode, technicalPlan, testsRun, deployed, testResults, wsCoverage, !!botToken);
              if (readinessError) {
                if (deployLocked) {
                  summary = `Build blocked after deploy limit was reached.\n\n${readinessError}\n\nNo further edits can be deployed or verified in this run. Start a fresh run after addressing the last failing test setup or code issue.\n\nAgent summary before blocking:\n${summary}`;
                  shortSummary = shortSummary || "Build blocked after deploy limit\n\nThe app could not be safely finished because the deploy limit was reached before required tests passed.";
                  finished = true;
                  logger.done(summary, iterations, totalInputTokens, totalOutputTokens);
                  writeDetailedLog("blocked_deploy_locked");
                  const logFilePath2 = logger.getLogPath();
                  logger.close();
                  return { summary, shortSummary, contextDiff, model: tierConfig.modelId, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheWriteTokens: totalCacheWriteTokens, cacheReadTokens: totalCacheReadTokens, logPath: logFilePath2, commitNum, commitDir, stepCount: stepCounter, durationMs: Date.now() - runStartMs };
                }
                result = `Error: ${readinessError}`;
                break;
              }
              const routeError = validateBackendRoutes(projectDir, projectId, runKind, technicalPlan);
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
                  return { summary, shortSummary, contextDiff, model: tierConfig.modelId, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheWriteTokens: totalCacheWriteTokens, cacheReadTokens: totalCacheReadTokens, logPath: logFilePath2, commitNum, commitDir, stepCount: stepCounter, durationMs: Date.now() - runStartMs };
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
              return { summary, shortSummary, contextDiff, model: tierConfig.modelId, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheWriteTokens: totalCacheWriteTokens, cacheReadTokens: totalCacheReadTokens, logPath: logFilePath2, commitNum, commitDir, stepCount: stepCounter, durationMs: Date.now() - runStartMs };
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
    const finalRouteError = validateBackendRoutes(projectDir, projectId, runKind, technicalPlan);
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
      contextDiff,
      model: tierConfig.modelId,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheWriteTokens: totalCacheWriteTokens,
      cacheReadTokens: totalCacheReadTokens,
      logPath: logFilePath,
      commitNum,
      commitDir,
      stepCount: stepCounter,
      durationMs: Date.now() - runStartMs,
    };
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

  private walkDirWithStats(dir: string, base: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (SKIP_DIRS.has(entry.name)) continue;
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
          if (BINARY_EXTS.has(ext) || SKIP_EXTS.has(ext)) {
            results.push(`${relPath} (${sizeKB}KB, binary — do not read_file)`);
            continue;
          }
          // Avoid loading huge text files into memory just for line counts.
          if (stat.size > READ_FILE_MAX_BYTES) {
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
    // Append-only deltas accumulated since the last full regen. Tell the LLM
    // to fold each entry into the relevant body sections, then RESET the new
    // Recent Changes section to empty so future commits start fresh.
    const recentChanges = this.extractRecentChanges(prevPassport || "");
    if (recentChanges) {
      inputParts.push(
        `RECENT CHANGES TO FOLD IN (these are append-only deltas from commits since the last regen — merge each entry into Architecture / Code Locations / Current State as appropriate, then leave the new Recent Changes section EMPTY):\n${recentChanges.substring(0, 4000)}`
      );
    }
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
${prevPassport ? "\nUse the previous passport for style/format reference and to preserve Key Decisions that are still relevant." : ""}${recentChanges ? "\nIf RECENT CHANGES TO FOLD IN is provided above, merge every entry into the relevant body sections (new routes go to Architecture, new files go to Code Locations, removed features come out of Current State, etc.) and OUTPUT an EMPTY Recent Changes section at the bottom — do NOT just copy the deltas back into Recent Changes." : ""}

${inputParts.join("\n\n")}

Output a structured markdown document (under 4000 words) with EXACTLY these sections (in this order):

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
What the app can do right now. What features are complete, what's partially done.

## Recent Changes
(empty — populated by future commits via append path)`,
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
    contextDiff?: string,
  ): Promise<string> {
    // ── Cheap path: every commit between full regens just appends a one-line
    // delta to the prior passport. No LLM call, no tokens spent. The agent
    // supplies `context_diff` via finish(); when missing, fall back to the
    // first line of the build summary.
    const isRegenCommit = commitNum === 0 || (commitNum % PASSPORT_REGEN_EVERY === 0);
    if (!isRegenCommit && commitNum > 0) {
      try {
        const appended = await this.appendPassportDelta(
          projectId,
          commitDir,
          commitNum,
          (contextDiff && contextDiff.trim()) || doneSummary,
        );
        if (appended) return appended;
        // Prior passport missing — fall through to full regen below.
      } catch (err) {
        console.warn(`[Context] append-delta path failed for ${projectId.substring(0, 8)} commit #${commitNum}, falling back to regen:`, err);
      }
    }

    // ── Full LLM regen path: every Nth commit, or whenever the cheap path
    // bailed (e.g. no prior passport).
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

  /**
   * Extract the body of the `## Recent Changes` section from a passport.
   * Returns "" when the section is missing or empty. Used by:
   *   - appendPassportDelta — to know what's already there before adding a new bullet.
   *   - generatePassport     — to feed the accumulated deltas to the regen LLM.
   */
  private extractRecentChanges(passport: string): string {
    if (!passport) return "";
    const re = /^##\s+Recent Changes\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m;
    const m = passport.match(re);
    if (!m) return "";
    return m[1].trim();
  }

  /**
   * List relative paths under frontend/ and backend/ in a commit folder.
   * Used by the cheap append path to detect newly created or deleted files
   * without an LLM call.
   */
  private listProjectFiles(commitDir: string): string[] {
    const out: string[] = [];
    const walk = (dir: string, prefix: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), rel);
        } else if (entry.isFile()) {
          out.push(rel);
        }
      }
    };
    walk(path.join(commitDir, "frontend"), "frontend");
    walk(path.join(commitDir, "backend"), "backend");
    return out.sort();
  }

  /**
   * Append a one-line delta to the prior commit's passport.md and write it
   * into the new commit folder. NO LLM call. Returns the combined context or
   * `null` if the prior passport could not be located (caller must fall back
   * to a full regen in that case).
   */
  private async appendPassportDelta(
    projectId: string,
    commitDir: string,
    commitNum: number,
    deltaText: string,
  ): Promise<string | null> {
    if (commitNum <= 0) return null;
    const prevDir = path.join(commitDir, "..", String(commitNum - 1));
    const prevPassportPath = path.join(prevDir, "passport.md");
    if (!fs.existsSync(prevPassportPath)) return null;

    const prevPassport = fs.readFileSync(prevPassportPath, "utf-8");
    if (!prevPassport.trim()) return null;

    // Detect newly-added / deleted files between prior and current commit.
    const prevFiles = new Set(this.listProjectFiles(prevDir));
    const currFiles = new Set(this.listProjectFiles(commitDir));
    const added = [...currFiles].filter(f => !prevFiles.has(f));
    const removed = [...prevFiles].filter(f => !currFiles.has(f));

    const firstLine = String(deltaText || "").split("\n")[0].trim().slice(0, 280);
    const date = new Date().toISOString().slice(0, 10);
    const bullet = `- #${commitNum} (${date}): ${firstLine || "Changes applied"}`;
    const fileBullets: string[] = [];
    for (const f of added)   fileBullets.push(`  - new: ${f}`);
    for (const f of removed) fileBullets.push(`  - deleted: ${f}`);
    const newEntry = [bullet, ...fileBullets].join("\n");

    // Insert under `## Recent Changes`. If the section doesn't exist yet
    // (older passport), append it at the end. We only keep prior body when
    // it actually contains bullet entries — placeholders / hint text from
    // the regen template (e.g. "(empty — populated by future commits…)")
    // are discarded so the section doesn't accumulate noise.
    let updated: string;
    if (/^##\s+Recent Changes\s*$/m.test(prevPassport)) {
      updated = prevPassport.replace(
        /^##\s+Recent Changes\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m,
        (_match, body) => {
          const existing = body.trim();
          const hasBullets = /^- /m.test(existing);
          const merged = hasBullets ? `${existing}\n${newEntry}` : newEntry;
          return `## Recent Changes\n${merged}\n\n`;
        },
      );
    } else {
      updated = prevPassport.trimEnd() + `\n\n## Recent Changes\n${newEntry}\n`;
    }

    // Carry forward / extend history.md too.
    let history = "";
    const prevHistoryPath = path.join(prevDir, "history.md");
    if (fs.existsSync(prevHistoryPath)) {
      history = fs.readFileSync(prevHistoryPath, "utf-8");
    }
    history += `\n- #${commitNum}: ${firstLine || "Changes applied"}`;
    history = history.trim();

    fs.writeFileSync(path.join(commitDir, "passport.md"), updated, "utf-8");
    fs.writeFileSync(path.join(commitDir, "history.md"), history, "utf-8");
    const combined = updated + "\n\n## Update History\n" + history;
    fs.writeFileSync(path.join(commitDir, "context.md"), combined, "utf-8");

    await projectService.updateProjectSummary(projectId, combined);

    console.log(
      `[Context] +Δ passport for ${projectId.substring(0, 8)} commit #${commitNum} ` +
      `(append, no LLM, $0.0000) | +${added.length} files, -${removed.length}`
    );
    return combined;
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
