import { Bot, Api } from "grammy";
import { BotContext } from "../../types";
import { config } from "../../config";
import { projectService } from "../../services/project.service";
import { botRunnerService } from "../../services/bot-runner.service";
import { trackEvent } from "../../services/analytics.service";
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
    const { user } = await projectService.getOrCreateUser(
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

    // Look for an existing project the user already created (new flow: project
    // exists before bot is linked). If found, link this bot to it. Otherwise
    // we need a free slot to create a fresh project.
    const unbotted = await projectService.getUnbottedProject(user.id);

    // Slot limit only applies when we'd CREATE a new project. Linking a bot
    // to an existing botless project does not consume a new slot — the slot
    // was already counted when the project was created. Without this guard,
    // a user with their last slot occupied by a botless project gets the
    // "slot limit reached" error during bot creation and the bot is never
    // linked to their just-built app (bug).
    if (!unbotted) {
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

    let project: { id: string; description: string | null };
    let isExisting = false;

    if (unbotted) {
      console.log(`[ManagedBot] Linking bot @${newBot.username} to existing project ${unbotted.id}`);
      project = unbotted;
      isExisting = true;
    } else {
      const projectName = newBot.first_name || newBot.username || "New Project";
      project = await projectService.createProject(user.id, projectName);
      console.log(`[ManagedBot] Created new project ${project.id} for bot @${newBot.username}`);
    }

    await projectService.setProjectBot(
      project.id,
      newBot.id,
      newBot.username || "",
      botToken
    );

    void trackEvent(creator.id, "app_created", {
      project_id: project.id,
      bot_username: newBot.username || "",
    });

    // Apply the app profile metadata saved by configure_app immediately after
    // the bot is linked. If the agent configured the app before a bot existed,
    // this is where Telegram receives the stored name/descriptions/menu button.
    if (isExisting) {
      try {
        await projectService.configureProjectBotFromAppConfig(project.id, botToken);
      } catch (err: any) {
        console.error(`[ManagedBot] configure_app failed for @${newBot.username}:`, err?.message || err);
      }
    }

    // sendOwnerWelcome=true: the moment the webhook is live, push the
    // "Good job, bot created" card directly to the owner. Mobile Telegram
    // bounces them into the freshly created bot and they typically tap
    // /start before the webhook is registered — that update is dropped, so
    // without this proactive DM they'd just see an unresponsive bot.
    await botRunnerService.startBot(project.id, botToken, newBot.username || "", true);
  } catch (err) {
    console.error("[ManagedBot] Error handling managed bot:", err);
    await sendToUser(
      `${ce(EMOJI.indicator_error)} <b>${t("en", "managed_bot_error")}</b> ${t("en", "managed_bot_error_body")}`,
      { parse_mode: "HTML" }
    );
  }
}
