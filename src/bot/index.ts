import { Bot, session, InlineKeyboard } from "grammy";
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
import { billingService } from "../services/billing.service";

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
  bot.command("miniapp", async (ctx) => {
    const kb = new InlineKeyboard().webApp("Open Mini App", `${config.baseUrl}/telegram-mini-app`);
    await ctx.reply("Manage your apps from the Mini App ✨", { reply_markup: kb });
  });

  registerManagedBotHandlers(bot);
  registerCallbackHandlers(bot);
  registerPhotoHandlers(bot);

  // Stars payments — auto-approve pre_checkout and process successful_payment
  bot.on("pre_checkout_query" as any, async (ctx: any) => {
    try {
      await ctx.answerPreCheckoutQuery(true);
    } catch (err) {
      console.error("[Bot] pre_checkout_query error:", err);
      try { await ctx.answerPreCheckoutQuery(false, { error_message: "Payment error" }); } catch {}
    }
  });

  bot.on("message:successful_payment" as any, async (ctx: any) => {
    try {
      const payment = ctx.message.successful_payment;
      console.log(`[Bot] Stars payment received: user=${ctx.from.id}, amount=${payment.total_amount} ${payment.currency}, payload=${payment.invoice_payload}`);
      const payload = JSON.parse(payment.invoice_payload);
      if (payload.type === "topup" && payload.paymentId) {
        await billingService.handleStarsPayment(payload.paymentId);
      }
    } catch (err) {
      console.error("[Bot] successful_payment error:", err);
    }
  });

  // "Main Menu" reply keyboard button triggers /start (all languages)
  bot.hears(/^(Main Menu|Главное меню|Головне меню)$/i, startCommand);

  // Conversation handlers must be registered last (catch-all for text)
  registerConversationHandlers(bot);

  bot.catch((err: any) => {
    const msg = err?.message || err?.error?.description || "";
    if (msg.includes("message is not modified")) return;
    console.error("[Bot] Error:", err);
  });

  return bot;
}
