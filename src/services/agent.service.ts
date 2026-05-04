/**
 * Low-level agent executor with a fluent builder interface.
 *
 * Responsibilities:
 *   - Read session config from runtimeConfig (model, tokens, iterations, thinking)
 *   - Accept system prompt, messages, tools, and optional RunContext
 *   - Route execution to the appropriate runner (AgentRunner / AskRunner / RouterRunner)
 *
 * Does NOT orchestrate sessions, build prompts, log to DB, or broadcast WebSocket events.
 * Use agent-session.service.ts for full session orchestration.
 */
import { runtimeConfig, type AgentSessionType } from "./runtime-config.service";
import { AgentRunner } from "./agent/AgentRunner";
import { AskRunner } from "./agent/AskRunner";
import { RouterRunner } from "./agent/RouterRunner";
import type { RunContext } from "./agent/RunContext";
import type { AskTool } from "./agent/tools/impl/ask/AskTool";
import type { AskContext } from "./agent/tools/impl/ask/AskContext";
import type { RouterTool } from "./agent/tools/impl/router/RouterTool";
import type { RouterContext } from "./agent/tools/impl/router/RouterContext";
import type { AgentTool } from "./agent/AgentTool";
import type { ToolStepKind } from "./agent/AgentTool";
import crypto from "crypto";

// ── Public types ─────────────────────────────────────────────────────────────

export type AgentStepKind = ToolStepKind;

export type AgentEventType =
  | "step_start"
  | "step_end"
  | "narration_start"
  | "narration_chunk"
  | "narration_end"
  | "writing_chunk";

export interface AgentProgress {
  action: string;
  detail: string;
  percent?: number;
  costUsd?: number;
  balance?: number;
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

export interface AgentResult {
  summary: string;
  shortSummary: string;
  /**
   * Short agent-authored delta describing architectural changes this commit.
   * Populated when agent calls finish(context_diff=...). Used by append-passport path.
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
  stepCount?: number;
  durationMs?: number;
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

// ── Internal model config shape expected by runners ──────────────────────────

interface ModelCfg {
  modelId: string;
  provider?: string;
  maxTokens: number;
  maxIterations: number;
  thinkingBudget?: number;
  reasoningBudget?: number;
}

// ── Fluent Agent class ────────────────────────────────────────────────────────

/**
 * Fluent builder for a single LLM agent invocation.
 *
 * Usage:
 *   const result = await new Agent("build")
 *     .setSystemPrompt(sp)
 *     .setMessages(msgs)
 *     .setTools(AGENT_TOOL_INSTANCES)
 *     .setRawTools(SERVER_TOOLS)
 *     .setContext(ctx)
 *     .executeAsAgent();
 */
export class Agent {
  private readonly _sessionType: AgentSessionType;
  private _cfg: ReturnType<typeof runtimeConfig.getSessionConfig>;

  private _systemPrompt = "";
  private _messages: any[] = [];
  private _tools: AgentTool[] = [];
  private _rawTools: any[] = [];
  private _runContext?: RunContext;

  constructor(sessionType: AgentSessionType) {
    this._sessionType = sessionType;
    this._cfg = { ...runtimeConfig.getSessionConfig(sessionType) };
  }

  // ── Config overrides (override runtimeConfig defaults) ────────────────────

  setModel(model: string): this {
    this._cfg = { ...this._cfg, model };
    return this;
  }

  setMaxTokens(n: number): this {
    this._cfg = { ...this._cfg, max_tokens: n };
    return this;
  }

  setIterations(n: number): this {
    this._cfg = { ...this._cfg, iterations: n };
    return this;
  }

  setThinking(budget: number): this {
    this._cfg = { ...this._cfg, thinking: budget };
    return this;
  }

  // ── Run configuration ─────────────────────────────────────────────────────

  setSystemPrompt(sp: string): this {
    this._systemPrompt = sp;
    return this;
  }

  setMessages(msgs: any[]): this {
    this._messages = msgs;
    return this;
  }

  setTools(tools: AgentTool[]): this {
    this._tools = tools;
    return this;
  }

  setRawTools(tools: any[]): this {
    this._rawTools = tools;
    return this;
  }

  setContext(ctx: RunContext): this {
    this._runContext = ctx;
    return this;
  }

  // ── Execution modes ───────────────────────────────────────────────────────

  /**
   * Full agentic run with tool loop. Requires setContext() first.
   */
  async executeAsAgent(): Promise<AgentResult | null> {
    if (!this._runContext) {
      throw new Error("[Agent] RunContext required — call setContext() before executeAsAgent()");
    }
    return new AgentRunner()
      .setContext(this._runContext)
      .setSystemPrompt(this._systemPrompt)
      .setTools(this._tools)
      .setRawToolDefs(this._rawTools)
      .setMessages(this._messages)
      .run();
  }

  /**
   * Lightweight ask/answer run with streaming text output.
   */
  async executeAsAsker(opts: {
    onChunk: (delta: string, full: string) => void;
    ctx: AskContext;
    telegramId?: string;
    sessionId?: string;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    return new AskRunner().run({
      modelCfg: this._buildModelCfg(),
      systemPrompt: this._systemPrompt,
      messages: this._messages,
      tools: this._tools as unknown as AskTool[],
      ctx: opts.ctx,
      onChunk: opts.onChunk,
      telegramId: opts.telegramId,
      sessionId: opts.sessionId ?? crypto.randomUUID(),
    });
  }

  /**
   * Router classification run. Returns proposal status and free-form text.
   */
  async executeAsRouter(
    ctx: RouterContext,
    opts?: { telegramId?: string; sessionId?: string },
  ): Promise<{ proposed: boolean; text: string; inputTokens: number; outputTokens: number }> {
    return new RouterRunner().run({
      modelCfg: this._buildModelCfg(),
      systemPrompt: this._systemPrompt,
      messages: this._messages,
      tools: this._tools as unknown as RouterTool[],
      ctx,
      telegramId: opts?.telegramId,
      sessionId: opts?.sessionId ?? crypto.randomUUID(),
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _buildModelCfg(): ModelCfg {
    return {
      modelId: this._cfg.model,
      provider: this._cfg.provider,
      maxTokens: this._cfg.max_tokens,
      maxIterations: this._cfg.iterations,
      thinkingBudget: this._cfg.thinking > 0 ? this._cfg.thinking : undefined,
      reasoningBudget: this._cfg.reasoning ? 8000 : undefined,
    };
  }
}

/** Convenience factory — mirrors `new Agent(sessionType)`. */
export function createAgent(sessionType: AgentSessionType): Agent {
  return new Agent(sessionType);
}
