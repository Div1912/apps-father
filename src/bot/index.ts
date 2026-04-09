import { Bot, session } from "grammy";
import { config } from "../config";
import { BotContext, SessionData } from "../types";
import { startCommand } from "./commands/start";
import { newProjectCommand } from "./commands/newproject";
import { projectsCommand } from "./commands/projects";
import { helpCommand } from "./commands/help";
import { registerManagedBotHandlers } from "./handlers/managed-bot";
import { registerCallbackHandlers } from "./handlers/callback";
import { registerConversationHandlers } from "./handlers/conversation";
import { registerPhotoHandlers } from "./handlers/photo";

export function createBot(): Bot<BotContext> {
  const bot = new Bot<BotContext>(config.botToken);

  bot.use(
    session({
      initial: (): SessionData => ({
        activeProjectId: undefined,
        conversationState: "idle",
        pendingPlan: undefined,
        pendingDescription: undefined,
        awaitingInput: null,
      }),
    })
  );

  bot.command("start", startCommand);
  bot.command("newproject", newProjectCommand);
  bot.command("projects", projectsCommand);
  bot.command("help", helpCommand);

  registerManagedBotHandlers(bot);
  registerCallbackHandlers(bot);
  registerPhotoHandlers(bot);

  // "Main Menu" reply keyboard button triggers /start
  bot.hears("Main Menu", startCommand);

  // Conversation handlers must be registered last (catch-all for text)
  registerConversationHandlers(bot);

  bot.catch((err: any) => {
    const msg = err?.message || err?.error?.description || "";
    if (msg.includes("message is not modified")) return;
    console.error("[Bot] Error:", err);
  });

  return bot;
}
