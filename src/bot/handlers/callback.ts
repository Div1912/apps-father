import { Bot } from "grammy";
import { BotContext } from "../../types";
import { prisma } from "../../db";
import { config } from "../../config";
import { sendUsdt } from "../../services/wallet.service";

export function registerCallbackHandlers(bot: Bot<BotContext>) {
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (data.startsWith("wd_approve_") || data.startsWith("wd_decline_")) {
      const isApprove = data.startsWith("wd_approve_");
      const wdId = parseInt(data.replace(/^wd_(approve|decline)_/, ""), 10);
      if (isNaN(wdId)) { await ctx.answerCallbackQuery({ text: "Invalid withdrawal ID" }); return; }

      const withdrawal = await prisma.withdrawal.findUnique({ where: { id: wdId }, include: { user: true } });
      if (!withdrawal) { await ctx.answerCallbackQuery({ text: "Withdrawal not found" }); return; }
      if (withdrawal.status !== "pending") { await ctx.answerCallbackQuery({ text: `Already ${withdrawal.status}` }); return; }

      if (isApprove) {
        await ctx.answerCallbackQuery({ text: "Processing USDT withdrawal..." });

        try {
          await ctx.editMessageText(
            ctx.callbackQuery.message?.text + "\n\n⏳ <b>Processing...</b> Sending USDT...",
            { parse_mode: "HTML" },
          );
        } catch {}

        try {
          const amountUsdt = Number(withdrawal.amountUsd);
          const txHash = await sendUsdt(withdrawal.tonAddress, amountUsdt);

          const isFailed = txHash.startsWith("send_failed_");
          if (isFailed) {
            await prisma.withdrawal.update({ where: { id: wdId }, data: { status: "failed", txHash } });
            await prisma.user.update({ where: { id: withdrawal.userId }, data: { partnerBalance: { increment: withdrawal.amountUsd } } });
            try {
              await ctx.editMessageText(
                `❌ <b>Withdrawal #${wdId} FAILED</b>\n\nUSDT transfer broadcast failed. Balance refunded.\nTX: <code>${txHash}</code>`,
                { parse_mode: "HTML" },
              );
            } catch {}
          } else {
            await prisma.withdrawal.update({ where: { id: wdId }, data: { status: "completed", txHash, processedAt: new Date() } });

            const viewerUrl = (txHash.startsWith("sent_") || txHash.startsWith("confirmed_"))
              ? null
              : `https://tonviewer.com/transaction/${txHash}`;

            const successMsg =
              `✅ <b>Withdrawal #${wdId} APPROVED</b>\n\n` +
              `<b>Partner:</b> ${withdrawal.user.username ? "@" + withdrawal.user.username : withdrawal.user.firstName || "Unknown"}\n` +
              `<b>Amount:</b> ${amountUsdt.toFixed(2)} USDT\n` +
              `<b>Address:</b> <code>${withdrawal.tonAddress}</code>\n` +
              `<b>TX:</b> <code>${txHash}</code>` +
              (viewerUrl ? `\n<a href="${viewerUrl}">View on TonViewer</a>` : "");

            try { await ctx.editMessageText(successMsg, { parse_mode: "HTML" }); } catch {}

            await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: withdrawal.user.telegramId.toString(),
                text: `✅ <b>Withdrawal Processed!</b>\n\nYour withdrawal of <b>${amountUsdt.toFixed(2)} USDT</b> has been sent to:\n<code>${withdrawal.tonAddress}</code>\n\nTX: <code>${txHash}</code>` +
                  (viewerUrl ? `\n<a href="${viewerUrl}">View on TonViewer</a>` : ""),
                parse_mode: "HTML",
              }),
            }).catch(() => {});
          }
        } catch (err: any) {
          console.error("[Withdraw] Approve processing error:", err);
          await prisma.withdrawal.update({ where: { id: wdId }, data: { status: "failed" } });
          await prisma.user.update({ where: { id: withdrawal.userId }, data: { partnerBalance: { increment: withdrawal.amountUsd } } });
          try {
            await ctx.editMessageText(
              `❌ <b>Withdrawal #${wdId} FAILED</b>\n\nError: ${err.message || "Unknown"}\nBalance refunded.`,
              { parse_mode: "HTML" },
            );
          } catch {}
        }
      } else {
        await prisma.withdrawal.update({ where: { id: wdId }, data: { status: "declined", processedAt: new Date() } });
        await prisma.user.update({ where: { id: withdrawal.userId }, data: { partnerBalance: { increment: withdrawal.amountUsd } } });

        try {
          await ctx.editMessageText(
            `❌ <b>Withdrawal #${wdId} DECLINED</b>\n\n` +
            `Partner: ${withdrawal.user.username ? "@" + withdrawal.user.username : withdrawal.user.firstName || "Unknown"}\n` +
            `Amount: ${Number(withdrawal.amountUsd).toFixed(2)} USDT\nBalance refunded.`,
            { parse_mode: "HTML" },
          );
        } catch {}

        await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: withdrawal.user.telegramId.toString(),
            text: `❌ <b>Withdrawal Declined</b>\n\nYour withdrawal request of <b>${Number(withdrawal.amountUsd).toFixed(2)} USDT</b> has been declined.\nYour partner balance has been refunded.`,
            parse_mode: "HTML",
          }),
        }).catch(() => {});

        await ctx.answerCallbackQuery({ text: "Withdrawal declined, balance refunded" });
      }
      return;
    }

    await ctx.answerCallbackQuery();
  });
}
