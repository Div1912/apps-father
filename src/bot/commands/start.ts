import { InputFile, InlineKeyboard } from "grammy";
import path from "path";
import { BotContext } from "../../types";
import { projectService } from "../../services/project.service";
import { EMOJI, ce } from "../emoji";
import { prisma } from "../../db";
import { Decimal } from "@prisma/client/runtime/library";
import { Lang, t } from "../i18n";
import { config } from "../../config";

function getWelcomeCaption(lang: Lang): string {
  return (
    `<b>${ce(EMOJI.logo)} ${t(lang, "welcome_caption_title")}</b> - ${t(lang, "welcome_caption_desc")}\n\n` +
    `<b>${ce(EMOJI.idea)} ${t(lang, "welcome_caption_idea")}</b>\n` +
    `${t(lang, "welcome_caption_body")}\n\n` +
    `<b>${ce(EMOJI.list)} ${t(lang, "welcome_caption_samples")}</b>\n` +
    `${t(lang, "welcome_caption_samples_body")} \n\n` +
    `${ce(EMOJI.indicator_none)} <a href="https://t.me/InstagramMysbot"><b>GramMini</b></a>   ${ce(EMOJI.indicator_none)} <a href="https://t.me/teleweatherabot"><b>TeleWeather</b></a>   ${ce(EMOJI.indicator_none)} <a href="https://t.me/pixelduel7bot"><b>Pixel Duel</b></a>   ${ce(EMOJI.indicator_none)} <a href="https://t.me/my_best_ton_walletbot"><b>TON Wallet</b></a>`
  );
}

export function getNavWelcomeText(balance: number, lang: Lang = "en"): string {
  return `<b>${ce(EMOJI.logo)} Apps Father</b>\n\n` +
    `<blockquote><b>${ce(EMOJI.setting)}  ${t(lang, "nav_welcome_blockquote")}</b></blockquote>\n\n` +
    `${ce(EMOJI.dollar, "💲")} <b>${t(lang, "nav_welcome_balance", { balance: balance.toFixed(2) })}</b>\n` +
    `${t(lang, "nav_welcome_balance_desc")}\n\n` +
    `<b>${t(lang, "nav_welcome_cta")}</b>`;
}

export async function startCommand(ctx: BotContext) {
  const from = ctx.from;
  if (!from) return;

  ctx.session.awaitingInput = null;
  ctx.session.activeProjectId = undefined;
  ctx.session.pendingPlan = undefined;
  ctx.session.pendingDescription = undefined;
  ctx.session.conversationState = "idle";

  const startParam = ctx.match ? String(ctx.match) : undefined;
  const referredBy = startParam && /^\d+$/.test(startParam) ? parseInt(startParam, 10) : undefined;

  const user = await projectService.getOrCreateUser(from.id, from.username, from.first_name, referredBy);

  ctx.session.language = (user.language as Lang) || "en";
  const lang = ctx.session.language;

  let voucherMsg: string | null = null;
  if (startParam && startParam.startsWith("v_")) {
    try {
      const voucher = await prisma.voucher.findUnique({ where: { code: startParam } });
      if (voucher && voucher.active && voucher.usedCount < voucher.maxUses) {
        const alreadyUsed = await prisma.voucherRedemption.findUnique({
          where: { voucherId_userId: { voucherId: voucher.id, userId: user.id } },
        });
        if (!alreadyUsed) {
          await prisma.$transaction(async (tx) => {
            await tx.user.update({
              where: { id: user.id },
              data: { balance: { increment: new Decimal(Number(voucher.amountUsd).toFixed(4)) } },
            });
            await tx.voucher.update({
              where: { id: voucher.id },
              data: { usedCount: { increment: 1 } },
            });
            await tx.voucherRedemption.create({
              data: { voucherId: voucher.id, userId: user.id },
            });
          });
          voucherMsg =
            `${ce(EMOJI.indicator_success, "✅")} <b>${t(lang, "voucher_redeemed")}</b>\n\n` +
            t(lang, "voucher_redeemed_detail", { amount: Number(voucher.amountUsd).toFixed(2) });
        } else {
          voucherMsg = `${ce(EMOJI.indicator_warning, "⚠️")} ${t(lang, "voucher_already_used")}`;
        }
      } else if (voucher && (!voucher.active || voucher.usedCount >= voucher.maxUses)) {
        voucherMsg = `${ce(EMOJI.indicator_error, "❌")} ${t(lang, "voucher_expired")}`;
      }
    } catch (err) {
      console.error("[Start] Voucher redemption error:", err);
    }
  }

  const imagePath = path.join(__dirname, "..", "..", "..", "assets", "bot_images", "welcome.png");
  const miniAppUrl = `${config.baseUrl}/telegram-mini-app`;

  const chatId = ctx.chat!.id;

  const hideMsg = await ctx.reply("⏳", { reply_markup: { remove_keyboard: true } });
  await ctx.api.deleteMessage(chatId, hideMsg.message_id);

  const keyboard = new InlineKeyboard()
    .webApp(t(lang, "btn_create_app"), miniAppUrl);

  const btnRow = (keyboard as any).inline_keyboard;
  if (btnRow?.[0]?.[0]) btnRow[0][0].style = "primary";

  try {
    await ctx.replyWithPhoto(new InputFile(imagePath), {
      caption: getWelcomeCaption(lang),
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } catch (err) {
    console.error("[Start] Failed to send photo, sending text:", err);
    await ctx.reply(getWelcomeCaption(lang), {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  }

  if (voucherMsg) {
    setTimeout(async () => {
      try {
        await ctx.api.sendMessage(chatId, voucherMsg!, { parse_mode: "HTML" });
      } catch (err) {
        console.error("[Start] Failed to send voucher message:", err);
      }
    }, 1500);
  }
}
