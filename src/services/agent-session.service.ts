/**
 * Orchestrates every agent session type end-to-end:
 *   1. Calls agent-knowledge-builder to get system/user prompts
 *   2. Runs the appropriate Agent execution mode
 *   3. Logs results to the AgentSession DB table
 *   4. Handles context compaction (passport generation) after agent runs
 *
 * WebSocket progress events are passed in via callbacks from the server layer.
 * Use agent.service.ts for raw LLM execution.
 * Use agent-knowledge-builder.service.ts for prompt text only.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

import { prisma } from "../db";
import { projectService } from "./project.service";
import { runtimeConfig, type AgentComplexity } from "./runtime-config.service";
import { commitService } from "./commit.service";
import { runWithProject } from "./console-tagger.service";
import { decryptToken } from "./crypto.service";
import { getModelPricing, getOpenRouterClient } from "./openrouter.service";
import type { AgentMode } from "./agent/types";
import { buildSystemPrompt } from "./agent/instruction-loader";
import { validateBackendRoutes } from "./agent/validation";
import { PASSPORT_REGEN_EVERY } from "./agent/config";
import { PROJECTS_DIR } from "./agent/paths";
import { AgentLogger } from "./agent-logger";
import { AGENT_TOOL_INSTANCES, SERVER_TOOLS } from "./agent/tools/registry";
import { RunContext } from "./agent/RunContext";

import { Agent, type AgentResult, type AgentProgress } from "./agent.service";
import {
  QuestionnaireTool,
  ProposeActionTool,
  wrapAskTool,
  type RouterChatHooks,
  type RouterContext,
} from "./agent/tools/impl/router";
import {
  ProjectInfoAskTool,
  ListFilesAskTool,
  ReadFileAskTool,
  DbQueryAskTool,
  PlatformHelpAskTool,
} from "./agent/tools/impl/ask";

import * as kb from "./agent-knowledge-builder.service";

// ── Provider routing helper ───────────────────────────────────────────────────

function getProviderRouting(modelId: string, provider?: string): any | undefined {
  const sel = provider?.trim();
  return sel ? { only: [sel], allow_fallbacks: false } : undefined;
}

// ── Session log record shape ──────────────────────────────────────────────────

interface SessionLogOpts {
  type: string;
  projectId?: string | null;
  userId?: number | null;
  model: string;
  input: string;
  output?: string;
  creditsCharged?: number;
  /** Authoritative aggregate cost (sum of OR `usage.cost` per iteration). */
  costUsd?: number;
  /** Input slice of costUsd (sum of upstream_inference_prompt_cost). */
  costUsdInput?: number;
  /** Output slice of costUsd (sum of upstream_inference_completions_cost). */
  costUsdOutput?: number;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  success?: boolean;
  complexity?: string | null;
  isMaxMode?: boolean;
}

/**
 * Optional extras that propagate from the proposal card into the session.
 * Threaded as a single object so we don't grow the positional arg list every
 * time we add a new piece of metadata to log.
 */
export interface SessionExtras {
  creditsCharged?: number;
  maxMode?: boolean;
  complexity?: AgentComplexity | string | null;
  /** Explicit session kind — lets callers like bug-fix override the default build/update config. */
  sessionKind?: "build" | "update" | "bug-fix" | "update-plan";
}

/**
 * Bridge for callers that still pass the legacy `creditsCharged: number`
 * positional arg. New callers pass the SessionExtras object directly.
 */
function normalizeExtras(extras?: SessionExtras | number): SessionExtras {
  if (extras == null) return {};
  if (typeof extras === "number") return { creditsCharged: extras };
  return extras;
}

// ── AgentSessionService ───────────────────────────────────────────────────────

class AgentSessionService {

  // ── Router ──────────────────────────────────────────────────────────────────

  async session_router(
    projectId: string,
    userMessage: string,
    hooks: RouterChatHooks,
    conversationHistory?: { role: "user" | "assistant"; content: string }[],
    lang?: string,
    onToolCall?: (toolName: string) => void,
  ): Promise<{ proposed: boolean; text: string; inputTokens: number; outputTokens: number; modelId: string; isFirstMessage: boolean }> {
    const { systemPrompt, messages, isFirstMessage } = await kb.session_router(projectId, { userMessage, lang, conversationHistory });

    const routerCfg = runtimeConfig.getSessionConfig("router");
    const project: any = await projectService.getProject(projectId);
    const owner = project?.userId
      ? await prisma.user.findUnique({ where: { id: project.userId }, select: { telegramId: true } })
      : null;
    const telegramId = owner?.telegramId ? String(owner.telegramId) : undefined;

    const ctx: RouterContext = {
      projectId,
      projectDir: kb.resolveAskProjectDir(projectId),
      hooks,
      proposalEmitted: false,
      questionnaireCount: 0,
    };

    // On first message there is no project to inspect — only questionnaire + propose_action needed.
    const tools = isFirstMessage
      ? [new QuestionnaireTool(), new ProposeActionTool()]
      : [
          wrapAskTool(new ProjectInfoAskTool()),
          wrapAskTool(new ListFilesAskTool()),
          wrapAskTool(new ReadFileAskTool()),
          wrapAskTool(new DbQueryAskTool()),
          wrapAskTool(new PlatformHelpAskTool()),
          new QuestionnaireTool(),
          new ProposeActionTool(),
        ];

    const routerStartMs = Date.now();
    const result = await new Agent("router")
      .setSystemPrompt(systemPrompt)
      .setMessages(messages)
      .setTools(tools as any)
      .executeAsRouter(ctx, { telegramId, sessionId: crypto.randomUUID(), onToolCall });

    void this._logWithCost({
      type: "router",
      projectId,
      userId: project?.userId ?? null,
      model: routerCfg.model,
      input: userMessage,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: Date.now() - routerStartMs,
      success: true,
      // Authoritative OR cost — overrides _logWithCost's catalog estimate.
      costUsd: result.costUsd,
      costUsdInput: result.costUsdInput,
      costUsdOutput: result.costUsdOutput,
    });

    return {
      proposed: result.proposed,
      text: result.text,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      modelId: routerCfg.model,
      isFirstMessage,
    };
  }

  // ── Answer ───────────────────────────────────────────────────────────────────

  async session_answer(
    projectId: string,
    question: string,
    onChunk: (text: string, fullText: string) => void,
    lastUpdate?: string,
    appDescription?: string,
    conversationHistory?: { role: "user" | "assistant"; content: string }[],
    lang?: string,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const { systemPrompt, messages } = await kb.session_answer(projectId, {
      question, lastUpdate, appDescription, conversationHistory, lang,
    });

    const project: any = await projectService.getProject(projectId);
    const owner = project?.userId
      ? await prisma.user.findUnique({ where: { id: project.userId }, select: { telegramId: true } })
      : null;
    const telegramId = owner?.telegramId ? String(owner.telegramId) : undefined;
    const projectDir = kb.resolveAskProjectDir(projectId);
    const answerCfg = runtimeConfig.getSessionConfig("answer");

    const answerStartMs = Date.now();
    const result = await new Agent("answer")
      .setSystemPrompt(systemPrompt)
      .setMessages(messages)
      .setTools([
        new ProjectInfoAskTool(),
        new ListFilesAskTool(),
        new ReadFileAskTool(),
        new DbQueryAskTool(),
        new PlatformHelpAskTool(),
      ] as any)
      .executeAsAsker({ onChunk, ctx: { projectId, projectDir }, telegramId, sessionId: crypto.randomUUID() });

    void this._logWithCost({
      type: "answer",
      projectId,
      userId: project?.userId ?? null,
      model: answerCfg.model,
      input: question,
      output: result.text?.substring(0, 500),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: Date.now() - answerStartMs,
      success: true,
      costUsd: result.costUsd,
      costUsdInput: result.costUsdInput,
      costUsdOutput: result.costUsdOutput,
    });

    // Trim runner-only fields before returning to callers that still expect
    // the legacy { text, inputTokens, outputTokens } contract.
    return {
      text: result.text,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    };
  }

  // ── Suggestions ──────────────────────────────────────────────────────────────

  async session_suggestions(
    projectId: string,
    lang?: string,
  ): Promise<{ title: string; description: string }[]> {
    const { userPrompt } = await kb.session_suggestions(projectId, { lang });
    const suggCfg = runtimeConfig.getSessionConfig("suggestions");
    const project: any = await projectService.getProject(projectId);
    const owner = project?.userId
      ? await prisma.user.findUnique({ where: { id: project.userId }, select: { telegramId: true } })
      : null;
    const telegramId = owner?.telegramId ? String(owner.telegramId) : undefined;

    const client = getOpenRouterClient();
    const suggStartMs = Date.now();
    const response = await client.chat.completions.create({
      model: suggCfg.model,
      max_tokens: suggCfg.max_tokens,
      messages: [{ role: "user", content: userPrompt }],
      ...(telegramId ? { user: telegramId } : {}),
      extra_body: { session_id: crypto.randomUUID(), usage: { include: true } },
      ...(getProviderRouting(suggCfg.model, suggCfg.provider)
        ? { provider: getProviderRouting(suggCfg.model, suggCfg.provider) }
        : {}),
      ...(suggCfg.reasoning ? { reasoning: { max_tokens: 8000 } } : {}),
    } as any);

    const suggUsage = (response.usage as any) || {};
    void this._logWithCost({
      type: "suggestions",
      projectId,
      userId: project?.userId ?? null,
      model: suggCfg.model,
      input: projectId,
      inputTokens: suggUsage.prompt_tokens ?? 0,
      outputTokens: suggUsage.completion_tokens ?? 0,
      durationMs: Date.now() - suggStartMs,
      success: true,
      costUsd: Number(suggUsage.cost) || 0,
      costUsdInput: Number(suggUsage.cost_details?.upstream_inference_prompt_cost) || 0,
      costUsdOutput: Number(suggUsage.cost_details?.upstream_inference_completions_cost) || 0,
    });

    const text = response.choices[0]?.message?.content || "";
    try {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) return JSON.parse(match[0]);
    } catch {}
    return [{ title: "Improve your app", description: "Ask for a specific update to enhance your app." }];
  }

  // ── Build ────────────────────────────────────────────────────────────────────

  async session_build(
    projectId: string,
    buildArgs: { name?: string; description?: string; brief?: string; userPrompt?: string } | string,
    onProgress?: (p: AgentProgress) => Promise<void>,
    onAskUser?: (question: string, options: string[]) => Promise<string>,
    lang?: string,
    userBalance?: number,
    attachments?: { localPath: string; projectPath: string; originalName: string; caption?: string }[],
    extras?: SessionExtras | number,
  ): Promise<AgentResult> {
    return runWithProject(projectId, async () => {
      // Support legacy string call (description + plan) from the first-time build path
      const args = typeof buildArgs === "string"
        ? { description: buildArgs, brief: buildArgs }
        : buildArgs;
      const { userPrompt } = await kb.session_build(projectId, {
        name: args.name,
        description: args.description,
        brief: args.brief,
        userPrompt: args.userPrompt,
        lang,
        hasAttachments: !!(attachments && attachments.length > 0),
      });
      return this._runCoreAgent(
        projectId, userPrompt, onProgress, onAskUser, userBalance, attachments, "new",
        normalizeExtras(extras),
      );
    });
  }

  // ── Update ───────────────────────────────────────────────────────────────────

  async session_update(
    projectId: string,
    updateDescription: string,
    onProgress?: (p: AgentProgress) => Promise<void>,
    attachments?: { localPath: string; projectPath: string; originalName: string; caption?: string }[],
    onAskUser?: (question: string, options: string[]) => Promise<string>,
    lang?: string,
    userBalance?: number,
    extras?: SessionExtras | number,
  ): Promise<AgentResult> {
    return runWithProject(projectId, async () => {
      const { userPrompt } = await kb.session_update(projectId, {
        updateDescription, lang, attachments,
      });
      return this._runCoreAgent(
        projectId, userPrompt, onProgress, onAskUser, userBalance, attachments, "update",
        normalizeExtras(extras),
      );
    });
  }

  // ── Context compaction ───────────────────────────────────────────────────────

  async compactContext(
    projectId: string,
    commitDir: string,
    doneSummary: string,
    commitNum: number,
    description?: string,
    plan?: string,
    contextDiff?: string,
  ): Promise<string> {
    const isRegenCommit = commitNum === 0 || commitNum % PASSPORT_REGEN_EVERY === 0;
    if (!isRegenCommit && commitNum > 0) {
      try {
        const appended = await this._appendPassportDelta(
          projectId, commitDir, commitNum, (contextDiff?.trim()) || doneSummary,
        );
        if (appended) return appended;
      } catch (err) {
        console.warn(`[Context] append-delta failed for ${projectId.substring(0, 8)} commit #${commitNum}, falling back to regen:`, err);
      }
    }

    let prevPassport = "";
    if (commitNum > 0) {
      const prevPath = path.join(commitDir, "..", String(commitNum - 1), "passport.md");
      if (fs.existsSync(prevPath)) {
        prevPassport = fs.readFileSync(prevPath, "utf-8");
      } else {
        const prevCtxPath = path.join(commitDir, "..", String(commitNum - 1), "context.md");
        if (fs.existsSync(prevCtxPath)) prevPassport = fs.readFileSync(prevCtxPath, "utf-8");
      }
    }

    try {
      return await this._generatePassport({ projectId, commitDir, commitNum, description, doneSummary, prevPassport });
    } catch (err) {
      console.error(`[Context] Failed to generate passport for ${projectId.substring(0, 8)}:`, err);
    }

    const fallback = kb.buildFallbackSummary(commitDir, doneSummary);
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
      return this._generatePassport({
        projectId, commitDir: latestDir, commitNum: latestNum,
        description: project?.description || undefined,
      });
    });
  }

  // ── Session logging ───────────────────────────────────────────────────────────

  /**
   * Wrapper around `logSession` that fills in `costUsd` from the static
   * model-pricing catalog when callers don't pass an authoritative one.
   * If the caller already has the OpenRouter-reported cost (preferred)
   * pass it via `opts.costUsd` and we skip the catalog lookup entirely.
   */
  private async _logWithCost(opts: SessionLogOpts): Promise<void> {
    try {
      let costUsd = opts.costUsd;
      if (typeof costUsd !== "number" || !(costUsd > 0)) {
        const pricing = await getModelPricing(opts.model);
        costUsd = pricing
          ? (opts.inputTokens ?? 0) * pricing.promptPerToken + (opts.outputTokens ?? 0) * pricing.completionPerToken
          : 0;
      }
      await this.logSession({ ...opts, costUsd });
    } catch (err) {
      console.warn("[AgentSession] _logWithCost failed:", err);
    }
  }

  async logSession(opts: SessionLogOpts): Promise<void> {
    try {
      const Decimal = require("@prisma/client/runtime/library").Decimal;
      // Only persist the input/output split when we actually have a number
      // for it — avoids silently writing 0 on rows logged before the OR
      // usage-accounting wiring landed.
      const inUsd = typeof opts.costUsdInput === "number" && opts.costUsdInput >= 0
        ? new Decimal(opts.costUsdInput.toFixed(6)) : null;
      const outUsd = typeof opts.costUsdOutput === "number" && opts.costUsdOutput >= 0
        ? new Decimal(opts.costUsdOutput.toFixed(6)) : null;
      await prisma.agentSession.create({
        data: {
          type: opts.type,
          projectId: opts.projectId ?? null,
          userId: opts.userId ?? null,
          model: opts.model,
          input: (opts.input || "").substring(0, 2000),
          output: opts.output ? opts.output.substring(0, 2000) : null,
          creditsCharged: opts.creditsCharged ?? 0,
          costUsd: new Decimal((opts.costUsd ?? 0).toFixed(6)),
          costUsdInput: inUsd,
          costUsdOutput: outUsd,
          inputTokens: opts.inputTokens ?? 0,
          outputTokens: opts.outputTokens ?? 0,
          durationMs: opts.durationMs ?? null,
          success: opts.success ?? true,
          complexity: opts.complexity ?? null,
          isMaxMode: !!opts.isMaxMode,
        },
      });
    } catch (err) {
      console.warn("[AgentSession] Failed to log session:", err);
    }
  }

  // ── Core agent runner (shared by session_build / session_update) ──────────────

  private async _runCoreAgent(
    projectId: string,
    userPrompt: string,
    onProgress?: (p: AgentProgress) => Promise<void>,
    onAskUser?: (question: string, options: string[]) => Promise<string>,
    userBalance?: number,
    attachments?: { localPath: string; projectPath: string; originalName: string; caption?: string }[],
    mode: AgentMode = "update",
    extras: SessionExtras = {},
  ): Promise<AgentResult> {
    const systemPrompt = await buildSystemPrompt(mode);
    const taskId = crypto.randomUUID();

    const agentProject = await projectService.getProject(projectId);
    const agentOwner = (agentProject as any)?.userId
      ? await prisma.user.findUnique({ where: { id: (agentProject as any).userId }, select: { telegramId: true } })
      : null;
    const agentTelegramId = agentOwner?.telegramId ? String(agentOwner.telegramId) : undefined;

    const defaultSessionType = mode === "new" ? "build" : "update";
    const sessionType = extras.sessionKind ?? defaultSessionType;
    const isMaxMode = !!extras.maxMode;
    const sessionCfg = runtimeConfig.getEffectiveSessionConfig(sessionType, isMaxMode);
    const creditsCharged = extras.creditsCharged;
    const complexity = (typeof extras.complexity === "string" && extras.complexity) || null;

    console.log(`[Agent] task_id=${taskId} user=${agentTelegramId ?? "?"} (mode=${mode}${isMaxMode ? " · MAX" : ""}, ${systemPrompt.length} chars)`);
    projectService.updateProjectLastTaskId(projectId, taskId).catch(() => {});

    const projectRootDir = path.join(PROJECTS_DIR, projectId);
    const { commitDir, commitNum } = await commitService.prepareCommitFolder(projectId);
    fs.mkdirSync(path.join(commitDir, "frontend"), { recursive: true });
    fs.mkdirSync(path.join(commitDir, "backend"), { recursive: true });
    fs.mkdirSync(path.join(projectRootDir, "development", "data"), { recursive: true });

    const logger = new AgentLogger(projectId);

    let botToken = "";
    try {
      const project = await projectService.getProject(projectId);
      if (project?.botTokenEncrypted) botToken = decryptToken(project.botTokenEncrypted);
    } catch {}

    const tierConfig = {
      modelId: sessionCfg.model,
      provider: sessionCfg.provider,
      maxTokens: sessionCfg.max_tokens,
      maxIterations: sessionCfg.iterations,
      thinkingBudget: sessionCfg.thinking > 0 ? sessionCfg.thinking : undefined,
      reasoningBudget: sessionCfg.reasoning ? 8000 : undefined,
    };
    logger.header(tierConfig.modelId, userPrompt);

    const liveModelPricing = await getModelPricing(tierConfig.modelId);
    const baseInputPrice = liveModelPricing?.promptPerToken ?? 0;
    const agentPricing = {
      input: baseInputPrice,
      output: liveModelPricing?.completionPerToken ?? 0,
      cache_write: liveModelPricing ? (liveModelPricing.cacheWritePerToken || baseInputPrice * 1.25) : 0,
      cache_read: liveModelPricing ? (liveModelPricing.cacheReadPerToken || baseInputPrice * 0.1) : 0,
    };

    // Build initial messages with optional vision attachments
    const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
    const MIME_MAP: Record<string, string> = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
      ".webp": "image/webp", ".gif": "image/gif",
    };
    const imageContentParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        const ext = path.extname(att.originalName).toLowerCase();
        if (IMAGE_EXTS.has(ext) && fs.existsSync(att.localPath)) {
          try {
            const data = fs.readFileSync(att.localPath).toString("base64");
            const mimeType = MIME_MAP[ext] || "image/png";
            imageContentParts.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${data}` } });
            console.log(`[Agent] 🖼️ Attached image for vision: ${att.originalName} (${ext})`);
          } catch (err) {
            console.error(`[Agent] Failed to read image ${att.localPath}:`, err);
          }
        }
      }
    }

    const firstUserContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] | string =
      imageContentParts.length > 0
        ? [...imageContentParts, { type: "text", text: userPrompt }]
        : userPrompt;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: "user", content: firstUserContent },
    ];

    const ctx = new RunContext({
      projectId,
      projectDir: commitDir,
      projectRootDir,
      commitDir,
      commitNum,
      mode,
      botToken,
      tierConfig,
      taskId,
      selectedWorkflow: mode === "new" ? "workflow-new.md" : "workflow-update.md",
      logger,
      onAskUser,
      rawProgress: onProgress || (async () => {}),
    }, userBalance);
    (ctx as any)._agentPricing = agentPricing;
    (ctx as any)._telegramId = agentTelegramId;

    // When MAX MODE is on, route the agent through the dedicated "max-mode"
    // config slot so it picks up its own model, tokens, thinking budget, and
    // iteration cap (set independently of the standard build/update slots).
    const agentSessionType = isMaxMode ? "max-mode" : sessionType;
    const runnerResult = await new Agent(agentSessionType)
      .setSystemPrompt(systemPrompt)
      .setTools(AGENT_TOOL_INSTANCES as any)
      .setRawTools(SERVER_TOOLS)
      .setMessages(messages)
      .setContext(ctx)
      .executeAsAgent();

    if (runnerResult) {
      // Prefer the OR-reported cost summed across iterations
      // (runnerResult.costUsd / costUsdInput / costUsdOutput) — that's the
      // dollar figure upstream actually charged, including cache discounts.
      // Token×catalog estimate stays as a fallback for legacy/edge models
      // that don't honour the usage.include flag.
      const orCostUsd = runnerResult.costUsd ?? 0;
      const costUsd = orCostUsd > 0
        ? orCostUsd
        : (runnerResult.inputTokens * agentPricing.input + runnerResult.outputTokens * agentPricing.output);
      void this.logSession({
        type: mode === "new" ? "build" : "update",
        projectId,
        userId: (agentProject as any)?.userId ?? null,
        model: tierConfig.modelId,
        input: userPrompt,
        output: runnerResult.summary?.substring(0, 500),
        costUsd,
        costUsdInput: runnerResult.costUsdInput,
        costUsdOutput: runnerResult.costUsdOutput,
        creditsCharged,
        inputTokens: runnerResult.inputTokens,
        outputTokens: runnerResult.outputTokens,
        durationMs: runnerResult.durationMs,
        success: true,
        complexity,
        isMaxMode,
      });
      return runnerResult;
    }

    // Iteration limit reached — agent never called finish()
    const finalRouteError = validateBackendRoutes(commitDir, projectId, ctx.technicalPlan);
    if (finalRouteError) {
      ctx.summary = `Agent reached iteration limit with invalid backend routes: ${finalRouteError}`;
      console.warn(`[Agent] final sync blocked: ${finalRouteError}`);
    }
    try {
      const code = this._getProjectCode(commitDir);
      await projectService.storeGeneratedCode(projectId, code);
    } catch {}

    this._bustCache(commitDir);
    if (!finalRouteError) {
      try { commitService.syncToDev(projectId, commitDir); } catch {}
    }

    ctx.logger.done(ctx.summary || "Agent reached iteration limit", ctx.stepCounter, ctx.totalInputTokens, ctx.totalOutputTokens);
    ctx.writeDetailedLog("iteration_limit");
    const logFilePath = ctx.logger.getLogPath();
    ctx.logger.close();

    const iterLimitResult = {
      summary: ctx.summary || "Agent failed: reached iteration limit before a valid finish().",
      shortSummary: ctx.shortSummary || ctx.summary?.split("\n")[0]?.substring(0, 200) || "Build failed: iteration limit",
      contextDiff: ctx.contextDiff,
      model: tierConfig.modelId,
      inputTokens: ctx.totalInputTokens,
      outputTokens: ctx.totalOutputTokens,
      cacheWriteTokens: ctx.totalCacheWriteTokens,
      cacheReadTokens: ctx.totalCacheReadTokens,
      logPath: logFilePath,
      commitNum,
      commitDir,
      stepCount: ctx.stepCounter,
      durationMs: Date.now() - ctx.runStartMs,
    };

    // Same priority as the success path: OR-reported cost wins, fall back
    // to token×catalog when missing.
    const iterCostUsd = ctx.totalCostUsd > 0
      ? ctx.totalCostUsd
      : (ctx.totalInputTokens * agentPricing.input + ctx.totalOutputTokens * agentPricing.output);
    void this.logSession({
      type: mode === "new" ? "build" : "update",
      projectId,
      userId: (agentProject as any)?.userId ?? null,
      model: tierConfig.modelId,
      input: userPrompt,
      output: iterLimitResult.summary?.substring(0, 500),
      costUsd: iterCostUsd,
      costUsdInput: ctx.totalCostUsdInput || undefined,
      costUsdOutput: ctx.totalCostUsdOutput || undefined,
      creditsCharged,
      inputTokens: ctx.totalInputTokens,
      outputTokens: ctx.totalOutputTokens,
      durationMs: iterLimitResult.durationMs,
      success: false,
      complexity,
      isMaxMode,
    });

    return iterLimitResult;
  }

  // ── Passport generation ───────────────────────────────────────────────────────

  private async _generatePassport(opts: {
    projectId: string;
    commitDir: string;
    commitNum: number;
    description?: string;
    doneSummary?: string;
    prevPassport?: string;
  }): Promise<string> {
    const { projectId, commitDir, commitNum, description, doneSummary, prevPassport } = opts;
    const { inputText } = await kb.session_context(projectId, { commitDir, commitNum, description, doneSummary, prevPassport });

    const passportCfg = runtimeConfig.getSessionConfig("context");
    const client = getOpenRouterClient();
    const response = await client.chat.completions.create({
      model: passportCfg.model,
      max_tokens: passportCfg.max_tokens,
      ...(getProviderRouting(passportCfg.model, passportCfg.provider)
        ? { provider: getProviderRouting(passportCfg.model, passportCfg.provider) }
        : {}),
      // Same OR usage opt-in as the rest of the runners. The passport call
      // doesn't surface in admin Sessions today, but tracking real cost
      // here keeps internal cost dashboards honest.
      extra_body: { usage: { include: true } },
      messages: [{ role: "user", content: inputText }],
    } as any);

    const passportText = response.choices[0]?.message?.content || "";
    if (!passportText) throw new Error("Failed to generate passport");

    const usage = response.usage as any;
    const inTok = usage?.prompt_tokens || 0;
    const outTok = usage?.completion_tokens || 0;
    // Prefer the OR-reported cost; fall back to catalog only when missing.
    const orCost = Number(usage?.cost) || 0;
    let costUsd = orCost;
    if (!(costUsd > 0)) {
      const livePricing = await getModelPricing(passportCfg.model);
      costUsd = inTok * (livePricing?.promptPerToken ?? 0) + outTok * (livePricing?.completionPerToken ?? 0);
    }

    fs.writeFileSync(path.join(commitDir, "passport.md"), passportText, "utf-8");

    let history = "";
    if (commitNum > 0) {
      const prevHistoryPath = path.join(commitDir, "..", String(commitNum - 1), "history.md");
      if (fs.existsSync(prevHistoryPath)) history = fs.readFileSync(prevHistoryPath, "utf-8");
    }
    const historyLine = doneSummary
      ? doneSummary.split("\n")[0].substring(0, 200)
      : "Context regenerated from source code";
    history = (history + `\n- #${commitNum}: ${historyLine}`).trim();

    fs.writeFileSync(path.join(commitDir, "history.md"), history, "utf-8");
    const combined = passportText + "\n\n## Update History\n" + history;
    fs.writeFileSync(path.join(commitDir, "context.md"), combined, "utf-8");
    await projectService.updateProjectSummary(projectId, combined);

    const label = doneSummary ? "Generated" : "Regenerated";
    console.log(`[Context] ✅ ${label} passport for ${projectId.substring(0, 8)} commit #${commitNum} | in=${inTok} out=${outTok} | $${costUsd.toFixed(4)}`);

    // Log as an agent session so the admin Sessions page tracks context cost.
    try {
      const project: any = await projectService.getProject(projectId);
      void this.logSession({
        type: "context",
        projectId,
        userId: project?.userId ?? null,
        model: passportCfg.model,
        input: `commit #${commitNum}${doneSummary ? ": " + doneSummary.split("\n")[0].substring(0, 120) : ""}`,
        output: passportText.substring(0, 500),
        costUsd,
        costUsdInput: Number(usage?.cost_details?.upstream_inference_prompt_cost) || undefined,
        costUsdOutput: Number(usage?.cost_details?.upstream_inference_completions_cost) || undefined,
        inputTokens: inTok,
        outputTokens: outTok,
        success: true,
      });
    } catch (logErr) {
      console.warn("[Context] Failed to log session:", logErr);
    }

    return combined;
  }

  private async _appendPassportDelta(
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

    const prevFiles = new Set(kb.listProjectFiles(prevDir));
    const currFiles = new Set(kb.listProjectFiles(commitDir));
    const added = [...currFiles].filter(f => !prevFiles.has(f));
    const removed = [...prevFiles].filter(f => !currFiles.has(f));

    const firstLine = String(deltaText || "").split("\n")[0].trim().slice(0, 280);
    const date = new Date().toISOString().slice(0, 10);
    const bullet = `- #${commitNum} (${date}): ${firstLine || "Changes applied"}`;
    const fileBullets: string[] = [
      ...added.map(f => `  - new: ${f}`),
      ...removed.map(f => `  - deleted: ${f}`),
    ];
    const newEntry = [bullet, ...fileBullets].join("\n");

    let updated: string;
    if (/^##\s+Recent Changes\s*$/m.test(prevPassport)) {
      updated = prevPassport.replace(
        /^##\s+Recent Changes\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m,
        (_match, body) => {
          const existing = body.trim();
          const merged = /^- /m.test(existing) ? `${existing}\n${newEntry}` : newEntry;
          return `## Recent Changes\n${merged}\n\n`;
        },
      );
    } else {
      updated = prevPassport.trimEnd() + `\n\n## Recent Changes\n${newEntry}\n`;
    }

    let history = "";
    const prevHistoryPath = path.join(prevDir, "history.md");
    if (fs.existsSync(prevHistoryPath)) history = fs.readFileSync(prevHistoryPath, "utf-8");
    history = (history + `\n- #${commitNum}: ${firstLine || "Changes applied"}`).trim();

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

  // ── Misc helpers ──────────────────────────────────────────────────────────────

  private _bustCache(projectDir: string): void {
    const indexPath = path.join(projectDir, "frontend", "index.html");
    if (!fs.existsSync(indexPath)) return;
    try {
      const v = Date.now();
      let html = fs.readFileSync(indexPath, "utf-8");
      html = html.replace(/(href|src)="([^"]+\.(css|js))(\?[^"]*)?"/g, (_, attr, file) => `${attr}="${file}?v=${v}"`);
      fs.writeFileSync(indexPath, html, "utf-8");
    } catch {}
  }

  private _getProjectCode(projectDir: string): string {
    const result: Record<string, string> = {};
    const readDir = (dir: string, prefix: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile()) {
          result[`${prefix}/${entry.name}`] = fs.readFileSync(path.join(dir, entry.name), "utf-8");
        }
      }
    };
    readDir(path.join(projectDir, "frontend"), "frontend");
    readDir(path.join(projectDir, "backend"), "backend");
    const schemaPath = path.join(projectDir, "schema.sql");
    if (fs.existsSync(schemaPath)) result["schema.sql"] = fs.readFileSync(schemaPath, "utf-8");
    return JSON.stringify(result, null, 2);
  }
}

export const agentSessionService = new AgentSessionService();
