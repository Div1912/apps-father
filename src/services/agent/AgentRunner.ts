import OpenAI from "openai";
import { getOpenRouterClient } from "../openrouter.service";
import { abortedProjects } from "../../bot/processing";
import { AgentAbortedError } from "../agent.service";
import type { AgentResult } from "../agent.service";
import type { AgentTool } from "./AgentTool";
import { RunContext } from "./RunContext";
import type { ToolStepKind, ToolStepTarget } from "./AgentTool";

type AgentStepKind = ToolStepKind;

const TOOL_DISPLAY: Record<string, { kind: ToolStepKind; title: string; targetKey?: string; targetField?: "file" | "url" | "key" }> = {
  list_files:       { kind: "searching",   title: "Scanning files" },
  read_file:        { kind: "reading",     title: "Reading",               targetKey: "path",     targetField: "file" },
  write_file:       { kind: "writing",     title: "Writing",               targetKey: "path",     targetField: "file" },
  edit_file:        { kind: "editing",     title: "Editing",               targetKey: "path",     targetField: "file" },
  grep:             { kind: "searching",   title: "Searching",             targetKey: "pattern",  targetField: "key" },
  shell:            { kind: "shell",       title: "Running command",       targetKey: "command",  targetField: "key" },
  fetch_url:        { kind: "fetch",       title: "Fetching URL",          targetKey: "url",      targetField: "url" },
  db:               { kind: "db",          title: "Database",              targetKey: "key",      targetField: "key" },
  deploy_to_dev:    { kind: "deploying",   title: "Deploying to dev" },
  load_skill:       { kind: "skill",       title: "Loading skill",         targetKey: "name",     targetField: "key" },
  ask_user:         { kind: "ask",         title: "Waiting for your answer" },
  technical_plan:   { kind: "thinking",   title: "Technical plan",        targetKey: "kind",     targetField: "key" },
  configure_app:    { kind: "configuring", title: "Configuring app" },
  finish:           { kind: "done",        title: "Finishing" },
  server_logs:      { kind: "searching",   title: "Reading logs" },
  simulate_telegram:{ kind: "telegram",    title: "Simulating bot message" },
  simulate_api:     { kind: "fetch",       title: "Simulating API call" },
  simulate_ws:      { kind: "shell",       title: "Simulating WebSocket" },
  visual_test:      { kind: "visual",      title: "Visual test",            targetKey: "path",     targetField: "url" },
  image_generate:   { kind: "visual",      title: "Generating image",       targetKey: "filename", targetField: "file" },
};

function buildToolStepTarget(toolName: string, args: any): ToolStepTarget | undefined {
  const cfg = TOOL_DISPLAY[toolName];
  if (!cfg?.targetKey) return undefined;
  const raw = args?.[cfg.targetKey];
  if (typeof raw !== "string" || !raw) return undefined;
  const trimmed = raw.length > 200 ? raw.slice(0, 197) + "..." : raw;
  const field = cfg.targetField || "file";
  return { [field]: trimmed };
}

function summarizeToolArgs(toolName: string, args: any): string {
  switch (toolName) {
    case "list_files":        return "";
    case "read_file":         return args.offset ? `${args.path}:${args.offset}-${args.offset + (args.limit || 0)}` : args.path;
    case "write_file":        return `${args.path}, ${(args.content || "").length} chars`;
    case "edit_file":         return `${args.path}, "${(args.old_string || "").substring(0, 40)}..." -> "${(args.new_string || "").substring(0, 40)}..."`;
    case "grep":              return `"${args.pattern}"${args.path ? ` in ${args.path}` : ""}${args.include ? ` (${args.include})` : ""}`;
    case "shell":             return args.command?.substring(0, 80) || "";
    case "fetch_url":         return args.url || "";
    case "db":                return `${args.operation}(${args.key || ""})${args.value ? ", " + JSON.stringify(args.value).substring(0, 60) : ""}`;
    case "load_skill":        return args.name || "";
    case "ask_user":          return (args.question || "").substring(0, 60);
    case "technical_plan":    return `${args.kind || "app"}: ${(args.summary || "").substring(0, 80)}`;
    case "configure_app":     return args.name || "";
    case "server_logs":       return `${args.lines || 50} lines`;
    case "simulate_telegram": return args.update?.message?.text || args.update?.callback_query?.data || "update";
    case "simulate_api":      return `${args.method || "GET"} ${args.path}`;
    case "simulate_ws":       return args.scenarioId || `${Array.isArray(args.messages) ? args.messages.length : 0} message(s)`;
    case "deploy_to_dev":     return "";
    case "visual_test":       return (args.path as string) || "/";
    case "finish":            return (args.shortSummary || args.summary || "").substring(0, 80);
    default:                  return JSON.stringify(args).substring(0, 80);
  }
}

export class AgentRunner {
  private _ctx!: RunContext;
  private _systemPrompt = "";
  private _tools: AgentTool[] = [];
  private _rawToolDefs: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
  private _messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  setContext(ctx: RunContext): this {
    this._ctx = ctx;
    return this;
  }

  setSystemPrompt(p: string): this {
    this._systemPrompt = p;
    return this;
  }

  setTools(tools: AgentTool[]): this {
    this._tools = tools;
    return this;
  }

  setMessages(msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[]): this {
    this._messages = msgs;
    return this;
  }

  /** Extra OpenAI-format tool definitions to append (e.g. SERVER_TOOLS). */
  setRawToolDefs(defs: any[]): this {
    this._rawToolDefs = defs;
    return this;
  }

  async run(): Promise<AgentResult> {
    const ctx = this._ctx;
    const { tierConfig } = ctx;

    // Build a fast name→tool dispatch map from renderDefinition().function.name
    const toolMap = new Map<string, AgentTool>();
    const openAiTools: OpenAI.Chat.Completions.ChatCompletionTool[] = [];
    for (const t of this._tools) {
      const def = t.renderDefinition();
      const name = (def as any).function?.name as string;
      toolMap.set(name, t);
      openAiTools.push(def);
    }
    // Append raw tool definitions (e.g. OpenRouter server tools)
    const allTools = [...openAiTools, ...this._rawToolDefs];

    const maxIterations = tierConfig.maxIterations ?? 60;
    let iterations = 0;

    while (iterations < maxIterations) {
      // ── Abort check ───────────────────────────────────────────────────────
      if (abortedProjects.has(ctx.projectId)) {
        abortedProjects.delete(ctx.projectId);
        ctx.logger.done("ABORTED by user", iterations, ctx.totalInputTokens, ctx.totalOutputTokens);
        ctx.writeDetailedLog("aborted");
        console.log(`[Agent] ⛔ Aborted by user after ${iterations} iterations | in=${ctx.totalInputTokens} out=${ctx.totalOutputTokens}`);
        throw new AgentAbortedError(
          tierConfig.modelId,
          ctx.totalInputTokens,
          ctx.totalOutputTokens,
          ctx.totalCacheWriteTokens,
          ctx.totalCacheReadTokens,
        );
      }

      iterations++;

      // ── Build request payload ─────────────────────────────────────────────
      const thinkingBudget = tierConfig.thinkingBudget ?? 0;
      const reasoningBudget = (tierConfig as any).reasoningBudget ?? 0;
      const agentTelegramId = (ctx as any)._telegramId as string | undefined;

      const requestMessages = this._applyCacheBreakpoint(
        tierConfig.modelId,
        this._systemPrompt,
        this._messages,
      );

      const requestPayload: any = {
        model: tierConfig.modelId,
        max_tokens: tierConfig.maxTokens,
        messages: requestMessages,
        tools: allTools,
        tool_choice: "auto" as const,
        ...(agentTelegramId ? { user: agentTelegramId } : {}),
        extra_body: {
          session_id: ctx.taskId,
          // Ask OpenRouter to attach `usage.cost` and `usage.cost_details` to
          // every response. Without this the response.usage block only carries
          // token counts, and we'd have to reconstruct the price from the
          // catalog (which goes stale and misses cache-read discounts).
          usage: { include: true },
          ...(thinkingBudget > 0 ? { thinking: { type: "enabled", budget_tokens: thinkingBudget } } : {}),
        },
        ...(this._getProviderRouting(tierConfig.modelId, tierConfig.provider)
          ? { provider: this._getProviderRouting(tierConfig.modelId, tierConfig.provider) }
          : {}),
        ...(reasoningBudget > 0 ? { reasoning: { max_tokens: reasoningBudget } } : {}),
      };

      // ── Stream / call ─────────────────────────────────────────────────────
      const streamingEnabled = (tierConfig as any).streaming !== false;
      const iterStepId = `iter-${iterations}-${Date.now().toString(36)}`;
      let narrationOpen = false;
      let response: OpenAI.Chat.Completions.ChatCompletion;

      try {
        if (streamingEnabled) {
          try {
            await ctx.emitNarrationStart(iterStepId);
            narrationOpen = true;
            let narrationAccum = "";
            response = await this._streamAgentCall(requestPayload, {
              onTextDelta: (delta) => {
                narrationAccum += delta;
                void ctx.emitNarrationChunk(iterStepId, delta, narrationAccum);
              },
              onReasoningDelta: (delta) => {
                narrationAccum += delta;
                void ctx.emitNarrationChunk(iterStepId, delta, narrationAccum);
              },
              onToolArgsDelta: (toolName, argsDelta, argsFull) => {
                void ctx.emitWritingChunk(iterStepId, toolName, argsDelta, argsFull);
              },
            });
            await ctx.emitNarrationEnd(iterStepId);
            narrationOpen = false;
            if (this._isEmptyResponse(response)) {
              console.warn(`[Agent] stream returned empty response, falling back to non-stream`);
              response = await this._callWithRetry(requestPayload);
            }
          } catch (streamErr: any) {
            if (narrationOpen) {
              await ctx.emitNarrationEnd(iterStepId);
              narrationOpen = false;
            }
            console.warn(`[Agent] stream failed (${streamErr?.message}), falling back to non-stream`);
            // Brief pause before fallback — gives the network a moment to stabilize
            await new Promise(r => setTimeout(r, 1500));
            response = await this._callWithRetry(requestPayload);
          }
        } else {
          response = await this._callWithRetry(requestPayload);
        }
      } catch (apiErr: any) {
        if (narrationOpen) {
          try { await ctx.emitNarrationEnd(iterStepId); } catch {}
        }
        try {
          ctx.detailedEntries.push({
            iteration: iterations,
            timestamp: new Date().toISOString(),
            request: this._cloneSafe(requestPayload),
            response: { error: { name: apiErr?.name, message: apiErr?.message, status: apiErr?.status, body: apiErr?.error || apiErr?.response } },
          });
        } catch {}
        ctx.writeDetailedLog("api_error");
        throw apiErr;
      }

      // ── Record detailed entry ─────────────────────────────────────────────
      try {
        ctx.detailedEntries.push({
          iteration: iterations,
          timestamp: new Date().toISOString(),
          request: this._cloneSafe(requestPayload),
          response: this._cloneSafe(response),
        });
      } catch (err: any) {
        console.warn(`[Agent] detailed-log clone failed at iter ${iterations}: ${err.message}`);
      }

      // ── Token accounting ──────────────────────────────────────────────────
      const usage = response.usage as any;
      const iterIn = usage?.prompt_tokens || 0;
      const iterOut = usage?.completion_tokens || 0;
      const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
      ctx.totalInputTokens += iterIn - cached;
      ctx.totalOutputTokens += iterOut;
      ctx.totalCacheReadTokens += cached;

      // Authoritative cost from OpenRouter — when the model returns it,
      // this is the dollar amount actually charged by upstream and is what
      // we want to show in admin Sessions. Falls back to the token×catalog
      // estimate below when the response didn't include cost (e.g. older
      // providers that ignore the `usage.include` flag).
      const iterCost = Number(usage?.cost) || 0;
      const iterCostIn = Number(usage?.cost_details?.upstream_inference_prompt_cost) || 0;
      const iterCostOut = Number(usage?.cost_details?.upstream_inference_completions_cost) || 0;
      ctx.totalCostUsd += iterCost;
      ctx.totalCostUsdInput += iterCostIn;
      ctx.totalCostUsdOutput += iterCostOut;

      const pricing = (ctx as any)._agentPricing as { input: number; output: number; cache_write: number; cache_read: number };
      ctx.liveCostUsd = ctx.totalCostUsd > 0
        ? ctx.totalCostUsd
        : (
          ctx.totalInputTokens * pricing.input +
          ctx.totalOutputTokens * pricing.output +
          ctx.totalCacheWriteTokens * pricing.cache_write +
          ctx.totalCacheReadTokens * pricing.cache_read
        );

      // ── Parse assistant message ───────────────────────────────────────────
      const assistantMsg = response.choices?.[0]?.message;
      const assistantToolCalls = assistantMsg?.tool_calls || [];
      const assistantText = assistantMsg?.content || "";
      const reasoning = (assistantMsg as any)?.reasoning_content || (assistantMsg as any)?.reasoning || "";

      this._messages.push({
        role: "assistant",
        content: assistantText,
        tool_calls: assistantToolCalls.length > 0 ? assistantToolCalls : undefined,
      } as any);

      ctx.logger.iteration(iterations, tierConfig.modelId);
      ctx.logger.tokens(
        ctx.totalInputTokens, ctx.totalOutputTokens, ctx.totalCacheReadTokens,
        ctx.totalCacheWriteTokens, iterIn, iterOut, cached, 0, ctx.liveCostUsd,
      );

      if (reasoning?.trim()) {
        ctx.logger.thinking(reasoning);
        console.log(`[Agent] 🧠 Thinking: ${reasoning.substring(0, 300).replace(/\n/g, " ")}${reasoning.length > 300 ? "..." : ""}`);
      }
      if (assistantText?.trim()) {
        ctx.logger.claudeMessage(assistantText);
        console.log(`[Agent] 💬 Claude says: ${assistantText.substring(0, 500)}`);
      }
      if (assistantToolCalls.length > 0) {
        const toolNames = assistantToolCalls.map((tc: any) => tc.function?.name).join(", ");
        console.log(`[Agent] 🔧 Iteration ${iterations} | Tools: [${toolNames}] | in=${ctx.totalInputTokens} out=${ctx.totalOutputTokens} | finish=${response.choices?.[0]?.finish_reason}`);
      }

      // ── No tool calls ─────────────────────────────────────────────────────
      if (assistantToolCalls.length === 0) {
        if (ctx.mode === "new" && (!ctx.technicalPlanSubmitted || !ctx.wroteFiles || !ctx.deployed)) {
          ctx.consecutiveNoWrite++;
          const needed = [
            !ctx.technicalPlanSubmitted ? "call technical_plan first" : "",
            !ctx.wroteFiles ? "write the required project files with write_file/edit_file" : "",
            !ctx.deployed ? "call deploy_to_dev after writing files" : "",
          ].filter(Boolean).join(", ");
          const corrective = `You responded with text only, but this is a build run and text does not create files. Continue now with tool calls only: ${needed}. Do not finish until validators pass and required simulate_* tests are done.`;
          this._messages.push({ role: "user", content: corrective });
          ctx.writeDetailedLog("end_turn_no_tools_retry");
          console.warn(`[Agent] no-tool turn during new build; injected corrective prompt (${ctx.consecutiveNoWrite})`);
          continue;
        }
        if (assistantText) ctx.summary = assistantText;
        ctx.logger.done(ctx.summary, iterations, ctx.totalInputTokens, ctx.totalOutputTokens);
        ctx.writeDetailedLog("end_turn_no_tools");
        console.log(`[Agent] ⏹️ Agent finished after ${iterations} iterations | in=${ctx.totalInputTokens} out=${ctx.totalOutputTokens}`);
        break;
      }

      // ── Process tool calls ────────────────────────────────────────────────
      const TERMINAL_TOOLS = new Set(["done", "finish"]);
      const orderedToolCalls = [
        ...assistantToolCalls.filter((tc: any) => !TERMINAL_TOOLS.has((tc as any).function?.name)),
        ...assistantToolCalls.filter((tc: any) => TERMINAL_TOOLS.has((tc as any).function?.name)),
      ];

      const toolResults: Array<{ role: "tool"; tool_call_id: string; content: string }> = [];

      for (const toolCall of orderedToolCalls) {
        const id = (toolCall as any).id as string;
        let name = (toolCall as any).function?.name as string;
        let args: any;
        let argsTruncated = false;
        const rawArgs = (toolCall as any).function?.arguments || "{}";
        try {
          args = JSON.parse(rawArgs);
        } catch {
          // JSON truncated by max_tokens — pass empty args and let the tool handle it
          args = {};
          argsTruncated = true;
        }

        // Short-circuit truncated tool calls before they hit the tool. Most
        // tools can't recover meaningfully from empty args, and write_file in
        // particular used to suggest the wrong escape hatch (shell heredoc)
        // when its content was cut off. Inject a precise retry instruction
        // here so the agent's next turn restarts on the right foot.
        if (argsTruncated) {
          const retryHint =
            name === "write_file"
              ? `Error: write_file's arguments were truncated by max_tokens (the response body did not fit in one tool call).
DO NOT retry with the full file. Split the content into chunks using the append flag:

  write_file({ path: "<your/path>", content: "<first ~200 lines>" })
  write_file({ path: "<your/path>", content: "<next ~200 lines>", append: true })
  write_file({ path: "<your/path>", content: "<final ~200 lines>", append: true })

The first call overwrites; every subsequent call with append:true extends the file. Continue until the file is complete. Do NOT use shell — shell writes to a different filesystem than the build directory.`
              : `Error: tool '${name}' was truncated by max_tokens. The arguments JSON did not finish streaming. Retry with a smaller payload, or break the work into multiple tool calls.`;
          this._messages.push({ role: "tool", tool_call_id: id, content: retryHint } as any);
          console.warn(`[Agent] ⚠️ Tool '${name}' args truncated by max_tokens — injected retry hint, skipping execution.`);
          continue;
        }

        // Canonicalize inline-argument calls (e.g. load_skill("frontend"))
        const inlineArgMatch = name?.match(/^(\w+)\("([^"]+)"\)$/);
        if (inlineArgMatch) {
          const [, baseName, inlineArg] = inlineArgMatch;
          if (baseName === "load_skill" && !args.name) {
            name = "load_skill";
            args = { ...args, name: inlineArg };
          }
        }

        // OpenRouter server tools are executed transparently; skip gracefully
        if (name && name.startsWith("openrouter:")) {
          this._messages.push({ role: "tool", tool_call_id: id, content: `OK: server tool ${name} handled by OpenRouter.` } as any);
          continue;
        }

        const argsSummary = summarizeToolArgs(name, args);
        ctx.logger.toolCall(name, args);

        const stepKindCfg = TOOL_DISPLAY[name] || { kind: "thinking" as AgentStepKind, title: name };
        const stepTarget = buildToolStepTarget(name, args) as any;
        const stepId = await ctx.emitStepStart(stepKindCfg.kind, stepKindCfg.title, name, stepTarget);

        let result = "";
        try {
          const tool = toolMap.get(name);
          if (!tool) {
            result = `Error: Unknown tool ${name}`;
          } else {
            result = await tool.execute(args, ctx);
          }
        } catch (err: any) {
          result = `Error: ${err.message}`;
          console.error(`[Agent] ❌ Tool ${name} error:`, err.message);
        }

        ctx.logger.toolResult(name, result);
        console.log(`[Agent] 📥 ${name}(${argsSummary}) -> ${result.substring(0, 200).replace(/\n/g, "\\n")}${result.length > 200 ? "..." : ""}`);
        toolResults.push({ role: "tool", tool_call_id: id, content: result });

        // Compute step metadata for the step_end event
        const tool = toolMap.get(name);
        let stepMeta: Record<string, any> = {};
        try {
          if (tool?.getStepMeta) {
            stepMeta = tool.getStepMeta(args, result);
          } else {
            stepMeta = this._defaultStepMeta(name, args, ctx);
          }
          if (result.startsWith("Error")) {
            stepMeta.error = result.replace(/^Error:?\s*/i, "").slice(0, 200);
          }
        } catch {}

        const stepStatus: "ok" | "error" = result.startsWith("Error") ? "error" : "ok";
        await ctx.emitStepEnd(stepId, stepStatus, Object.keys(stepMeta).length ? stepMeta : undefined);

        // If finish() called ctx.terminate(), push remaining results and return
        if (ctx.terminalResult) {
          toolResults.push(...toolResults.splice(0)); // flush into array (already there)
          for (const tr of toolResults) this._messages.push(tr as any);
          return ctx.terminalResult;
        }
      }

      for (const tr of toolResults) this._messages.push(tr as any);

      const msgSize = JSON.stringify(this._messages).length;
      const estimatedTokens = Math.round(msgSize / 4);
      console.log(`[Agent] 📊 Iter ${iterations} | Messages: ${this._messages.length} | ~${estimatedTokens} tokens | Cost: $${ctx.liveCostUsd.toFixed(4)}`);
    }

    // Iteration limit reached — return without finish()
    return null as unknown as AgentResult;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _getProviderRouting(modelId: string, provider?: string): any | undefined {
    const sel = provider?.trim();
    if (sel) return { only: [sel], allow_fallbacks: false };
    return undefined;
  }

  private _isClaudeModel(modelId: string): boolean {
    return /(?:^|\/)claude/i.test(modelId) || /anthropic\/claude/i.test(modelId);
  }

  private _isEmptyResponse(response: any): boolean {
    const choices = Array.isArray(response?.choices) ? response.choices : [];
    const msg = choices[0]?.message as any;
    const toolCalls = msg?.tool_calls || [];
    const content = typeof msg?.content === "string" ? msg.content : "";
    const reasoning = msg?.reasoning_content || msg?.reasoning || "";
    const completionTokens = (response.usage as any)?.completion_tokens || 0;
    return choices.length === 0 || (toolCalls.length === 0 && !content.trim() && !String(reasoning || "").trim() && completionTokens === 0);
  }

  private _invalidResponseReason(response: any): string | null {
    if (!response || typeof response !== "object") return "response is not an object";
    if (!Array.isArray(response.choices)) return "response.choices is missing or not an array";
    if (response.choices.length === 0) return "response.choices is empty";
    if (!response.choices[0]?.message) return "response.choices[0].message is missing";
    return null;
  }

  private async _callWithRetry(params: any, maxRetries = 3): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const client = getOpenRouterClient();
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await client.chat.completions.create(params);
        const invalidReason = this._invalidResponseReason(response);
        if (invalidReason && attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          console.warn(`[Agent] Malformed model response (${invalidReason}). Retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (invalidReason) throw new Error(`Malformed model response from ${params.model}: ${invalidReason}`);
        if (this._isEmptyResponse(response) && attempt < maxRetries) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 8000);
          console.warn(`[Agent] Empty model response. Retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (this._isEmptyResponse(response)) throw new Error(`Empty model response from ${params.model}`);
        return response;
      } catch (err: any) {
        const status = err?.status || err?.error?.status;
        const msg = String(err?.message || "");
        const isNetworkOrParseError = !status && (
          err instanceof SyntaxError ||
          /truncated|parse error|unexpected end|network|connection|ECONNRESET|ETIMEDOUT|fetch failed|socket/i.test(msg)
        );
        if (status === 429 && attempt < maxRetries) {
          const retryAfter = parseInt(err?.headers?.["retry-after"] || "0", 10);
          const delay = retryAfter > 0 ? retryAfter * 1000 : Math.min(2000 * Math.pow(2, attempt), 30000);
          console.log(`[Agent] Rate limited (429). Retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        if (isNetworkOrParseError && attempt < maxRetries) {
          const delay = Math.min(2000 * Math.pow(2, attempt), 16000);
          console.warn(`[Agent] Network/parse error (${msg.substring(0, 80)}). Retry ${attempt + 1}/${maxRetries} after ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error("Max retries exceeded");
  }

  private async _streamAgentCall(
    params: any,
    opts: {
      onTextDelta?: (delta: string, full: string) => void;
      onReasoningDelta?: (delta: string, full: string) => void;
      onToolArgsDelta?: (toolName: string, argsDelta: string, argsFull: string) => void;
    } = {},
  ): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const client = getOpenRouterClient();
    const stream = (await client.chat.completions.create({ ...params, stream: true, stream_options: { include_usage: true } } as any)) as any;

    let assistantText = "";
    let reasoning = "";
    const toolCallAcc = new Map<number, { id?: string; name: string; args: string }>();
    let usage: any;
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
      .map(([idx, v]) => ({ id: v.id || `call_${idx}`, type: "function" as const, function: { name: v.name || "", arguments: v.args || "{}" } }));

    const fakeMessage: any = { role: "assistant", content: assistantText };
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

  private _attachCacheControlToContent(content: any): any {
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

  private _applyCacheBreakpoint(modelId: string, systemPrompt: string, messages: any[]): any[] {
    if (!this._isClaudeModel(modelId)) {
      return [{ role: "system", content: systemPrompt }, ...messages];
    }
    const requestMessages = [
      { role: "system", content: this._attachCacheControlToContent(systemPrompt) },
      ...messages.map(msg => ({
        ...msg,
        content: Array.isArray(msg?.content)
          ? msg.content.map((block: any) => ({ ...block }))
          : msg?.content,
      })),
    ];
    let remainingBreakpoints = 3;
    const newestCacheableIndex = requestMessages.length - 4;
    for (let i = newestCacheableIndex; i >= 1 && remainingBreakpoints > 0; i--) {
      const msg = requestMessages[i] as any;
      if (!msg?.content) continue;
      const cachedContent = this._attachCacheControlToContent(msg.content);
      if (cachedContent === msg.content) continue;
      msg.content = cachedContent;
      remainingBreakpoints--;
    }
    return requestMessages;
  }

  private _defaultStepMeta(name: string, args: any, ctx: RunContext): Record<string, any> {
    const meta: Record<string, any> = {};
    if (name === "write_file" && typeof args?.content === "string") {
      meta.lines = args.content.split("\n").length;
      meta.bytes = Buffer.byteLength(args.content, "utf-8");
    } else if (name === "edit_file") {
      meta.added = typeof args?.new_string === "string" ? args.new_string.split("\n").length : 0;
      meta.removed = typeof args?.old_string === "string" ? args.old_string.split("\n").length : 0;
      if (args?.replace_all) meta.replaceAll = true;
    } else if (name === "deploy_to_dev") {
      meta.deployCount = ctx.deployCount;
    } else if (name === "shell" && typeof args?.command === "string") {
      meta.command = args.command.length > 120 ? args.command.slice(0, 117) + "…" : args.command;
    } else if (name === "db") {
      meta.op = args?.operation;
      if (args?.key) meta.key = args.key;
    } else if (name === "fetch_url" && typeof args?.url === "string") {
      meta.url = args.url;
    } else if (name === "load_skill") {
      meta.name = args?.name;
    }
    return meta;
  }

  private _cloneSafe(v: any): any {
    try {
      return typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v));
    } catch { return undefined; }
  }
}
