import { Bot, Api } from "grammy";
import { BotContext } from "../../types";
import { config } from "../../config";
import { projectService } from "../../services/project.service";
import { botRunnerService } from "../../services/bot-runner.service";
import { EMOJI, ce } from "../emoji";
import { Lang, t } from "../i18n";

const processingBots = new Set<number>();

export function registerManagedBotHandlers(bot: Bot<BotContext>) {
  bot.on("managed_bot" as any, async (ctx: any) => {
    const managedBot = ctx.managedBot || ctx.update.managed_bot;
    if (!managedBot) return;

    const creator = managedBot.user;
    const newBot = managedBot.bot;

    if (processingBots.has(newBot.id)) return;
    processingBots.add(newBot.id);

    console.log(
      `[ManagedBot] New bot created: @${newBot.username} (${newBot.id}) by user ${creator.id}`
    );

    handleManagedBotAsync(bot, creator, newBot).finally(() => {
      setTimeout(() => processingBots.delete(newBot.id), 30000);
    });
  });

  bot.on("message:managed_bot_created" as any, async (ctx: any) => {
    console.log("[ManagedBot] Received managed_bot_created service message");
    if (!ctx.session) return;
    const managedBot = ctx.message?.managed_bot_created;
    if (!managedBot?.bot) return;

    let project = null;
    for (let i = 0; i < 10; i++) {
      project = await projectService.getProjectByBotUserId(managedBot.bot.id);
      if (project) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    if (project) {
      ctx.session.activeProjectId = project.id;
      ctx.session.awaitingInput = "description";
      console.log(`[ManagedBot] Session set for project ${project.id}`);
    } else {
      console.warn(`[ManagedBot] Project not found after retries for bot ${managedBot.bot.id}`);
    }
  });
}

async function handleManagedBotAsync(bot: Bot<BotContext>, creator: any, newBot: any) {
  const sendToUser = async (text: string, extra?: any) => {
    try {
      await bot.api.sendMessage(creator.id, text, extra);
    } catch (err) {
      console.error("[ManagedBot] Failed to send message to user:", err);
    }
  };

  try {
    const user = await projectService.getOrCreateUser(
      creator.id,
      creator.username,
      creator.first_name
    );

    const lang = (user.language as Lang) || "en";

    const existingProject = await projectService.getProjectByBotUserId(newBot.id);
    if (existingProject) {
      console.log(`[ManagedBot] Project already exists for bot ${newBot.id}, skipping`);
      return;
    }

    const canCreate = await projectService.canCreateApp(user.id);
    if (!canCreate) {
      const { used, total } = await projectService.getUserSlotInfo(user.id);
      await sendToUser(
        `${ce(EMOJI.indicator_error)} <b>${t(lang, "managed_bot_slot_limit", { used, total })}</b>\n\n` +
        t(lang, "managed_bot_slot_body"),
        { parse_mode: "HTML" }
      );
      return;
    }

    let botToken: string;
    try {
      const mainApi = new Api(config.botToken);
      botToken = await (mainApi as any).raw.getManagedBotToken({
        user_id: newBot.id,
      });
    } catch (err) {
      console.error("[ManagedBot] Failed to get bot token:", err);
      await sendToUser(
        `${ce(EMOJI.indicator_error)} <b>${t(lang, "managed_bot_token_error", { username: newBot.username })}</b>\n\n${t(lang, "try_again")}`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const projectName = newBot.first_name || newBot.username || "New Project";
    const project = await projectService.createProject(user.id, projectName);
    await projectService.setProjectBot(
      project.id,
      newBot.id,
      newBot.username || "",
      botToken
    );

    await botRunnerService.startBot(project.id, botToken, newBot.username || "");
  } catch (err) {
    console.error("[ManagedBot] Error handling managed bot:", err);
    await sendToUser(
      `${ce(EMOJI.indicator_error)} <b>${t("en", "managed_bot_error")}</b> ${t("en", "managed_bot_error_body")}`,
      { parse_mode: "HTML" }
    );
  }
}
