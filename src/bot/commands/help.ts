import { BotContext } from "../../types";
import { EMOJI, ce } from "../emoji";

export async function helpCommand(ctx: BotContext) {
  await ctx.reply(
    `${ce(EMOJI.help)} <b>Apps Father Help</b>\n\n` +
    `I create Telegram Mini Apps for you using AI.\n\n` +
    `<b>How it works:</b>\n` +
    `1. Create a new project\n` +
    `2. A new bot will be created for your app\n` +
    `3. Describe what your app should do\n` +
    `4. I'll generate a plan for you to review\n` +
    `5. Approve the plan and I'll build the app\n` +
    `6. Test your app via the bot's Launch button\n` +
    `7. Request updates and improvements anytime\n\n` +
    `<b>Features:</b>\n` +
    `• AI-generated Mini Apps with database &amp; backend\n` +
    `• Send images to use as design references\n` +
    `• AI-powered improvement suggestions\n` +
    `• Version management &amp; releases\n` +
    `• Admin analytics panel for each project`,
    { parse_mode: "HTML" }
  );
}
