import { Bot } from "grammy";
import { config } from "../config";
import { GeneratedApp } from "../types";
import { projectService } from "./project.service";
import { builderService } from "./builder.service";
import { decryptToken } from "./crypto.service";

export class DeployService {
  async deployProject(
    projectId: string,
    app: GeneratedApp,
    onProgress?: (msg: string) => Promise<void>
  ): Promise<string> {
    const progress = onProgress || (async () => {});

    await progress("📁 Writing project files...");
    if (builderService.projectExists(projectId)) {
      await builderService.updateProject(projectId, app);
    } else {
      await builderService.scaffoldProject(projectId, app);
    }

    await progress("🤖 Configuring bot...");
    await this.configureManagedBot(projectId, app);

    await projectService.storeGeneratedCode(
      projectId,
      JSON.stringify({
        frontend: app.frontend,
        backend: app.backend,
        schema: app.schema,
      })
    );

    const appUrl = `${config.baseUrl}/app/${projectId}/`;
    await progress(`✅ Deployed! Your app is live at:\n${appUrl}`);

    return appUrl;
  }

  private async configureManagedBot(projectId: string, app: GeneratedApp): Promise<void> {
    const project = await projectService.getProject(projectId);
    if (!project?.botTokenEncrypted) return;

    const token = decryptToken(project.botTokenEncrypted);
    const bot = new Bot(token);

    try {
      if (app.botDescription) {
        await bot.api.setMyDescription(app.botDescription);
      }

      if (app.botCommands && app.botCommands.length > 0) {
        await bot.api.setMyCommands(app.botCommands);
      }

      const appUrl = `${config.baseUrl}/app/${projectId}/`;
      await bot.api.setChatMenuButton({
        menu_button: {
          type: "web_app",
          text: "Launch App",
          web_app: { url: appUrl },
        },
      });
    } catch (err) {
      console.error(`[Deploy] Error configuring managed bot for ${projectId}:`, err);
    }
  }
}

export const deployService = new DeployService();
