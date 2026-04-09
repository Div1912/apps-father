import { BotContext } from "../../types";
import { createBotKeyboard } from "../keyboards";
import { EMOJI, ce } from "../emoji";

export async function newProjectCommand(ctx: BotContext) {
  const from = ctx.from;
  if (!from) return;

  await ctx.reply(
    `${ce(EMOJI.add)} <b>Create New Project</b>\n\n` +
    `Tap the button below to create a bot for your new Mini App.\n` +
    `You'll set the bot's name and username in Telegram's interface.`,
    {
      parse_mode: "HTML",
      reply_markup: createBotKeyboard(),
    }
  );
}
