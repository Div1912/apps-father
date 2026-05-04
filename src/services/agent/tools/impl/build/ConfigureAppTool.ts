import type OpenAI from "openai";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";
import { projectService } from "../../../../../services/project.service";

export class ConfigureAppTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "configure_app",
        description: "Set the app's name, description, and bot profile. First-build only — not available during updates.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "App name (max 64 chars)" },
            description: { type: "string", description: "Short description (max 120 chars)" },
            longDescription: { type: "string", description: "Long description (max 512 chars)" },
            menuButtonText: { type: "string", description: "Menu button label (max 32 chars, default 'Launch App')" },
          },
          required: ["name"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    if (ctx.mode !== "new") {
      return "Error: configure_app is first-build only. Do not call it during updates.";
    }
    if (ctx.configuredApp) {
      return "Error: configure_app was already called in this build. Continue with code/deploy/finish.";
    }

    await ctx.progress({ action: "⚙️ Configuring app", detail: "name + descriptions + bot profile", percent: ctx.currentPercent });

    const name = (args.name || "").toString().trim().substring(0, 64);
    const description = (args.description || "").toString().substring(0, 120);
    const longDescription = (args.longDescription || "").toString().substring(0, 512);
    const menuButtonText = ctx.runPrefs.kind === "textBot"
      ? ""
      : (args.menuButtonText ?? "Launch App").toString().substring(0, 32);

    try {
      await projectService.updateProjectAppConfig(ctx.projectId, {
        name,
        description,
        longDescription,
        menuButtonText,
      });
      ctx.configuredApp = true;

      const lines = [
        `db.project.name updated to "${name}"`,
        "db.project.appDescription saved",
        "db.project.appLongDescription saved",
        "db.project.appMenuButtonText saved",
      ];

      if (ctx.botToken) {
        const botResult = await projectService.configureProjectBotFromAppConfig(ctx.projectId, ctx.botToken);
        lines.push(...botResult.lines);
        return `OK: App config saved to Apps Father DB and bot configured.\n${lines.join("\n")}`;
      }
      lines.push("bot token not connected yet; saved config will be applied automatically when the bot is linked");
      return `OK: App config saved to Apps Father DB.\n${lines.join("\n")}`;
    } catch (err: any) {
      return `Error configuring app: ${err.message}`;
    }
  }
}
