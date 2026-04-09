import { InputFile } from "grammy";
import path from "path";
import { BotContext } from "../../types";
import { projectService } from "../../services/project.service";
import { billingService } from "../../services/billing.service";
import { welcomeKeyboard, replyKeyboard } from "../keyboards";
import { EMOJI, ce } from "../emoji";

const WELCOME_CAPTION =
  `<b>${ce(EMOJI.logo)} Apps Father</b> - Build Telegram apps without writing a single line of code.\n\n` +
  `<b>${ce(EMOJI.idea)} Got an idea?</b>\n` +
  `That's all you need. <b>Apps Father</b> turns your concepts into fully working Telegram mini-apps — <b>no developers, no syntax, no headaches. Just describe what you want</b>, and watch it come to life inside Telegram.\n\n` +
  `<b>${ce(EMOJI.list)} Samples</b>\n` +
  `See the samples that built by Apps Father: \n\n` +
  `${ce(EMOJI.indicator_none)} <a href="https://t.me/InstagramMysbot"><b>GramMini</b></a>   ${ce(EMOJI.indicator_none)} <a href="https://t.me/teleweatherabot"><b>TeleWeather</b></a>   ${ce(EMOJI.indicator_none)} <a href="https://t.me/pixelduel7bot"><b>Pixel Duel</b></a>   ${ce(EMOJI.indicator_none)} <a href="https://t.me/my_best_ton_walletbot"><b>TON Wallet</b></a>`;

export function getNavWelcomeText(balance: number): string {
  return `<b>${ce(EMOJI.logo)} Apps Father</b>\n\n` +
    `<blockquote><b>${ce(EMOJI.setting)}  Whether you're building a booking tool, a voting bot, a loyalty program, or a custom game — Apps Father handles the hard part so you can focus on what matters: your idea.</b></blockquote>\n\n` +
    `${ce(EMOJI.dollar, "💲")} <b>User Balance: $${balance.toFixed(2)}</b>\n` +
    `Each app will take from balance by cost in tokens,\nyou can topup your account by button below\n\n` +
    `<b>Create a project right now by buttons below:</b>`;
}

export async function startCommand(ctx: BotContext) {
  const from = ctx.from;
  if (!from) return;

  ctx.session.awaitingInput = null;
  ctx.session.activeProjectId = undefined;
  ctx.session.pendingPlan = undefined;
  ctx.session.pendingDescription = undefined;
  ctx.session.conversationState = "idle";

  const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name);
  const balance = await billingService.getUserBalance(user.id);

  const imagePath = path.join(__dirname, "..", "..", "..", "assets", "bot_images", "welcome.png");

  try {
    await ctx.replyWithPhoto(new InputFile(imagePath), {
      caption: WELCOME_CAPTION,
      parse_mode: "HTML",
      reply_markup: replyKeyboard(),
    });
  } catch (err) {
    console.error("[Start] Failed to send photo, sending text:", err);
    await ctx.reply(WELCOME_CAPTION, {
      parse_mode: "HTML",
      reply_markup: replyKeyboard(),
    });
  }

  await ctx.reply(getNavWelcomeText(balance), {
    parse_mode: "HTML",
    reply_markup: welcomeKeyboard(),
  });
}
