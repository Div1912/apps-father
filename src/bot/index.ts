import { Bot, session } from "grammy";
import { config } from "../config";
import { BotContext, SessionData } from "../types";
import { startCommand } from "./commands/start";
import { billingService } from "../services/billing.service";
import { registerManagedBotHandlers } from "./handlers/managed-bot";
import { registerCallbackHandlers } from "./handlers/callback";

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

  bot.command("start", (ctx) => {
    if (ctx.chat.type !== "private") return;
    return startCommand(ctx);
  });

  // IMPORTANT: payment-related handlers must be registered BEFORE the generic
  // `bot.on("message")` catch-all, otherwise grammy will short-circuit at the
  // first matching handler that doesn't call next() and Stars payments will
  // never reach handleStarsPayment.
  bot.on("pre_checkout_query" as any, async (ctx: any) => {
    try {
      console.log(`[Bot] pre_checkout_query: user=${ctx.from?.id}, payload=${ctx.preCheckoutQuery?.invoice_payload}`);
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
      } else {
        console.warn(`[Bot] Stars payment with unknown payload:`, payload);
      }
    } catch (err) {
      console.error("[Bot] successful_payment error:", err);
    }
  });

  registerCallbackHandlers(bot);
  registerManagedBotHandlers(bot);

  bot.on("message", (ctx) => {
    if (ctx.chat.type !== "private") return;
    // Don't treat service messages (like successful_payment) as a /start trigger
    if ((ctx.message as any).successful_payment) return;
    return startCommand(ctx);
  });

  bot.catch((err: any) => {
    const msg = err?.message || err?.error?.description || "";
    if (msg.includes("message is not modified")) return;
    console.error("[Bot] Error:", err);
  });

  return bot;
}
