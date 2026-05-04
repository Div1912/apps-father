import type OpenAI from "openai";
import fs from "fs";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";
import { validateBackendRoutes, validateFinishReadiness } from "../../../validation";
import type { ProjectKind } from "../../../types";
import { commitService } from "../../../../../services/commit.service";
import { projectService } from "../../../../../services/project.service";
import { config } from "../../../../../config";
import { evictDevApiCache } from "../../../../../web/routes/devapi.routes";

function bustCache(projectDir: string): void {
  const indexPath = require("path").join(projectDir, "frontend", "index.html");
  if (!fs.existsSync(indexPath)) return;
  try {
    const v = Date.now();
    let html = fs.readFileSync(indexPath, "utf-8");
    html = html.replace(
      /(href|src)="([^"]+\.(css|js))(\?[^"]*)?"/g,
      (_, attr, file) => `${attr}="${file}?v=${v}"`,
    );
    fs.writeFileSync(indexPath, html, "utf-8");
  } catch {}
}

async function setRuntimeMenuButton(ctx: RunContext): Promise<void> {
  if (!ctx.botToken) return;
  let menuButtonText = "Launch App";
  try {
    const project = await projectService.getProject(ctx.projectId);
    menuButtonText = ((project as any)?.appMenuButtonText || menuButtonText).toString().substring(0, 32);
  } catch {}
  const menuButton = ctx.runKind === "textBot"
    ? { type: "default" as const }
    : { type: "web_app" as const, text: menuButtonText, web_app: { url: `${config.baseUrl}/app/${ctx.projectId}/` } };
  await fetch(`https://api.telegram.org/bot${ctx.botToken}/setChatMenuButton`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ menu_button: menuButton }),
  });
}

function getProjectCode(projectDir: string): string {
  const path = require("path");
  const files = ["frontend/index.html", "frontend/app.js", "frontend/styles.css", "backend/routes.js"];
  const parts: string[] = [];
  for (const f of files) {
    const full = path.join(projectDir, f);
    if (fs.existsSync(full)) {
      try { parts.push(`// === ${f} ===\n${fs.readFileSync(full, "utf-8")}`); } catch {}
    }
  }
  return parts.join("\n\n");
}

export class FinishTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "finish",
        description: "Complete the build. Provide a short summary (1-2 sentences shown to user) and a detailed technical summary. Must be called AFTER deploy_to_dev and all required simulate_* tests pass. This is the ONLY way to end the agent run successfully.",
        parameters: {
          type: "object",
          properties: {
            shortSummary: { type: "string", description: "Short user-facing summary (1-2 sentences, shown in chat)" },
            summary: { type: "string", description: "Detailed technical summary of all changes made" },
            context_diff: { type: "string", description: "Optional: short architectural delta describing new/removed routes, DB keys, screens, decisions added in this commit" },
          },
          required: ["summary"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    ctx.shortSummary = (args.shortSummary || "").toString();
    ctx.summary = (args.summary || "Changes applied").toString();
    ctx.contextDiff = (args.context_diff || "").toString();
    if (!ctx.shortSummary) ctx.shortSummary = ctx.summary.split("\n")[0].substring(0, 200);
    ctx.currentPercent = 100;

    console.log(`[Agent] 📝 finish.shortSummary: ${ctx.shortSummary.substring(0, 100)}`);
    console.log(`[Agent] 📝 finish.summary: ${ctx.summary.substring(0, 200)}`);
    if (ctx.contextDiff) console.log(`[Agent] 📝 finish.context_diff: ${ctx.contextDiff.substring(0, 200)}`);
    console.log(`[Agent] ✅ finish() called | stepCount=${ctx.stepCounter} | in=${ctx.totalInputTokens} out=${ctx.totalOutputTokens}`);

    try { await setRuntimeMenuButton(ctx); } catch {}

    const readinessError = validateFinishReadiness(
      ctx.runKind as ProjectKind, ctx.mode, ctx.technicalPlan, ctx.testsRun,
      ctx.deployed, ctx.testResults, ctx.wsCoverage, !!ctx.botToken,
    );

    if (readinessError) {
      if (ctx.deployLocked) {
        return this._blockedResult(ctx, readinessError, "blocked_deploy_locked");
      }
      return `Error: ${readinessError}`;
    }

    const routeError = validateBackendRoutes(ctx.projectDir, ctx.projectId, ctx.runKind as ProjectKind, ctx.technicalPlan);
    ctx.validatorResults.push({ stage: "finish", ok: !routeError, message: routeError || undefined });
    if (routeError) {
      if (ctx.deployLocked) {
        return this._blockedResult(ctx, routeError, "blocked_deploy_locked_route_error");
      }
      return `Error: ${routeError} Fix backend/routes.js, deploy to dev, then call finish(shortSummary, summary) again.`;
    }

    try {
      const code = getProjectCode(ctx.projectDir);
      await projectService.storeGeneratedCode(ctx.projectId, code);
    } catch {}

    bustCache(ctx.projectDir);
    try { commitService.syncToDev(ctx.projectId, ctx.projectDir); } catch {}
    try { evictDevApiCache(ctx.projectId); } catch {}

    ctx.finished = true;
    ctx.logger.done(ctx.summary, ctx.stepCounter, ctx.totalInputTokens, ctx.totalOutputTokens);
    ctx.writeDetailedLog("finish");
    const logFilePath = ctx.logger.getLogPath();
    ctx.logger.close();

    ctx.terminate({
      summary: ctx.summary,
      shortSummary: ctx.shortSummary,
      contextDiff: ctx.contextDiff,
      model: ctx.tierConfig.modelId,
      inputTokens: ctx.totalInputTokens,
      outputTokens: ctx.totalOutputTokens,
      cacheWriteTokens: ctx.totalCacheWriteTokens,
      cacheReadTokens: ctx.totalCacheReadTokens,
      logPath: logFilePath,
      commitNum: ctx.commitNum,
      commitDir: ctx.commitDir,
      stepCount: ctx.stepCounter,
      durationMs: Date.now() - ctx.runStartMs,
    });

    return "OK";
  }

  private _blockedResult(ctx: RunContext, reason: string, logReason: string): string {
    ctx.summary = `Build blocked after deploy limit was reached.\n\n${reason}\n\nNo further edits can be deployed or verified in this run. Start a fresh run after addressing the last failing test setup or code issue.\n\nAgent summary before blocking:\n${ctx.summary}`;
    ctx.shortSummary = ctx.shortSummary || "Build blocked after deploy limit\n\nThe app could not be safely finished because the deploy limit was reached before required tests passed.";
    ctx.finished = true;
    ctx.logger.done(ctx.summary, ctx.stepCounter, ctx.totalInputTokens, ctx.totalOutputTokens);
    ctx.writeDetailedLog(logReason);
    const logFilePath = ctx.logger.getLogPath();
    ctx.logger.close();

    ctx.terminate({
      summary: ctx.summary,
      shortSummary: ctx.shortSummary,
      contextDiff: ctx.contextDiff,
      model: ctx.tierConfig.modelId,
      inputTokens: ctx.totalInputTokens,
      outputTokens: ctx.totalOutputTokens,
      cacheWriteTokens: ctx.totalCacheWriteTokens,
      cacheReadTokens: ctx.totalCacheReadTokens,
      logPath: logFilePath,
      commitNum: ctx.commitNum,
      commitDir: ctx.commitDir,
      stepCount: ctx.stepCounter,
      durationMs: Date.now() - ctx.runStartMs,
    });

    return "OK";
  }
}
