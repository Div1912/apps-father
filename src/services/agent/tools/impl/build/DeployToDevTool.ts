import type OpenAI from "openai";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";
import { validateBackendRoutes } from "../../../validation";
import { commitService } from "../../../../../services/commit.service";
import { forceReloadProjectWs } from "../../../../../web/ws-manager";
import { evictDevApiCache } from "../../../../../web/routes/devapi.routes";
import { config } from "../../../../../config";

export class DeployToDevTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "deploy_to_dev",
        description: "Deploy all written files to the development environment so they can be tested. Must be called after writing/editing files. Limited to 4 calls per run.",
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    };
  }

  async execute(_args: Record<string, any>, ctx: RunContext): Promise<string> {
    if (ctx.deployLocked) {
      return `DEPLOY LIMIT REACHED (${ctx.deployCount}/4). Deploy is locked for this run. Do not edit or deploy again; call finish to produce a blocked build report.`;
    }
    ctx.deployCount++;
    if (ctx.deployCount > 4) {
      ctx.deployLocked = true;
      return `DEPLOY LIMIT REACHED (${ctx.deployCount}/4). You have deployed too many times. Finish your work and call finish(shortSummary, summary) now. Something is wrong with your iteration loop — do NOT deploy again.`;
    }

    if (ctx.deployCount === 3) {
      await ctx.progress({ action: "🚀 Deploying to dev (soft limit)", detail: `(${ctx.deployCount}/4 — one more left)`, percent: ctx.currentPercent });
    } else if (ctx.deployCount === 4) {
      await ctx.progress({ action: "🚀 Deploying to dev (FINAL)", detail: `(${ctx.deployCount}/4 — last allowed)`, percent: ctx.currentPercent });
    } else {
      await ctx.progress({ action: "🚀 Deploying to dev", detail: `(${ctx.deployCount}/4)`, percent: ctx.currentPercent });
    }

    try {
      // Diagnostic: log the state of app.js right before validator runs
      const path = require("path");
      const fs = require("fs");
      const appJsPath = path.join(ctx.projectDir, "frontend", "app.js");
      const appJsExists = fs.existsSync(appJsPath);
      console.log(`[DeployToDevTool] deploy#${ctx.deployCount} projectDir=${ctx.projectDir} app.js exists=${appJsExists}` +
        (appJsExists ? ` bytes=${fs.statSync(appJsPath).size} contains-AF.openWS=${fs.readFileSync(appJsPath, "utf-8").includes("AF.openWS")}` : ""));

      const routeError = validateBackendRoutes(ctx.projectDir, ctx.projectId, ctx.technicalPlan);
      ctx.validatorResults.push({ stage: "deploy_to_dev", ok: !routeError, message: routeError || undefined });
      if (routeError) {
        ctx.deployCount--;
        return `Error: ${routeError} Fix the referenced project files, then call deploy_to_dev() again.`;
      }
      commitService.syncToDev(ctx.projectId, ctx.projectDir);
      try { forceReloadProjectWs(ctx.projectId, true); } catch {}
      try { evictDevApiCache(ctx.projectId); } catch {}
      ctx.deployed = true;
      ctx.lastWsFailureSignature = "";
      ctx.repeatedWsFailureCount = 0;
      return `OK: Code deployed to development environment (deploy ${ctx.deployCount}/4).
Test frontend: ${config.baseUrl}/dev/${ctx.projectId}/

The user will visually verify. If this was your final action, in your NEXT turn call finish(shortSummary, summary) — that single atomic call ends the build. Do NOT call short_summary/summary/done — they don't exist as separate tools.`;
    } catch (err: any) {
      return `Error deploying to dev: ${err.message}`;
    }
  }

  getStepMeta(_args: Record<string, any>, _result: string, ctx?: RunContext): Record<string, any> {
    return ctx ? { deployCount: ctx.deployCount } : {};
  }
}
