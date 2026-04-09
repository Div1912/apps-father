import { Bot, Api } from "grammy";
import { BotContext } from "../../types";
import { config } from "../../config";
import { projectService } from "../../services/project.service";
import { botRunnerService } from "../../services/bot-runner.service";
import { EMOJI, ce } from "../emoji";

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

    // Retry up to 10 times (5s total) to handle race condition where
    // handleManagedBotAsync hasn't finished creating the project yet
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

    const existingProject = await projectService.getProjectByBotUserId(newBot.id);
    if (existingProject) {
      console.log(`[ManagedBot] Project already exists for bot ${newBot.id}, skipping`);
      return;
    }

    const canCreate = await projectService.canCreateApp(user.id);
    if (!canCreate) {
      const { used, total } = await projectService.getUserSlotInfo(user.id);
      await sendToUser(
        `${ce(EMOJI.indicator_error)} <b>App slot limit reached (${used}/${total})</b>\n\n` +
        `You need to buy an additional app slot for <b>$25</b> before creating a new app.\n` +
        `Tap <b>Main Menu → Buy Slot</b> to purchase one.`,
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
        `${ce(EMOJI.indicator_error)} <b>Failed to get token for @${newBot.username}.</b>\n\nPlease try again.`,
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

    await sendToUser(
      `${ce(EMOJI.indicator_success)} <b>Project "${projectName}" created!</b>\n` +
      `<blockquote>Bot: @${newBot.username}</blockquote>\n\n` +
      `${ce(EMOJI.idea)} <b>Now describe your app.</b>\n` +
      `Tell me what it should do, what features it needs, and any design preferences.\n\n` +
      `You can also send images as design references!`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    console.error("[ManagedBot] Error handling managed bot:", err);
    await sendToUser(
      `${ce(EMOJI.indicator_error)} <b>Something went wrong</b> while setting up your project.\n\nPlease try again.`,
      { parse_mode: "HTML" }
    );
  }
}
