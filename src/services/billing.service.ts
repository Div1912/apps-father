import { prisma } from "../db";
import { config } from "../config";
import crypto from "crypto";
import { Decimal } from "@prisma/client/runtime/library";
import { runtimeConfig } from "./runtime-config.service";
import { notifyDeposit } from "./notify.service";

export const MODEL_PRICING: Record<string, { input: number; output: number; cache_write: number; cache_read: number }> = {
  "claude-sonnet-4-6": {
    input: 3.00 / 1_000_000,
    output: 15.00 / 1_000_000,
    cache_write: 3.75 / 1_000_000,
    cache_read: 0.30 / 1_000_000,
  },
  "claude-opus-4-6": {
    input: 5.00 / 1_000_000,
    output: 25.00 / 1_000_000,
    cache_write: 6.25 / 1_000_000,
    cache_read: 0.50 / 1_000_000,
  },
};

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface UsageResult {
  costUsd: number;
  newBalance: number;
}

export class BillingService {
  async getUserBalance(userId: number): Promise<number> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { balance: true },
    });
    return user ? Number(user.balance) : 0;
  }

  async hasBalance(userId: number, minAmount: number = 0): Promise<boolean> {
    const balance = await this.getUserBalance(userId);
    if (minAmount > 0) return balance >= minAmount;
    return balance > 0;
  }

  calculateCost(model: string, usage: TokenUsage): number {
    const p = MODEL_PRICING[model] || MODEL_PRICING["claude-sonnet-4-6"];
    const inputCost = (usage.input_tokens ?? 0) * p.input;
    const outputCost = (usage.output_tokens ?? 0) * p.output;
    const cacheWrite = (usage.cache_creation_input_tokens ?? 0) * p.cache_write;
    const cacheRead = (usage.cache_read_input_tokens ?? 0) * p.cache_read;
    const total = inputCost + outputCost + cacheWrite + cacheRead;
    return total * runtimeConfig.getMarkupMultiplier();
  }

  async recordUsage(
    userId: number,
    projectId: string | null,
    model: string,
    usage: TokenUsage,
    operation: string
  ): Promise<UsageResult> {
    const costUsd = this.calculateCost(model, usage);

    const result = await prisma.$transaction(async (tx) => {
      await tx.usageLog.create({
        data: {
          userId,
          projectId,
          inputTokens: usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
          outputTokens: usage.output_tokens,
          costUsd: new Decimal(costUsd.toFixed(6)),
          operation,
        },
      });

      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: { balance: { decrement: new Decimal(costUsd.toFixed(4)) } },
      });

      if (projectId) {
        await tx.project.update({
          where: { id: projectId },
          data: { totalCostUsd: { increment: new Decimal(costUsd.toFixed(4)) } },
        });
      }

      return { costUsd, newBalance: Number(updatedUser.balance) };
    });

    return result;
  }

  async createTopUp(
    userId: number,
    amountUsd: number
  ): Promise<{ paymentId: number; invoiceUrl: string }> {
    if (amountUsd < runtimeConfig.getMinTopup()) {
      throw new Error(`Minimum top-up is $${runtimeConfig.getMinTopup()}`);
    }

    const payment = await prisma.payment.create({
      data: {
        userId,
        amountUsd: new Decimal(amountUsd.toFixed(4)),
        status: "pending",
      },
    });

    const body = {
      price_amount: amountUsd,
      price_currency: "usd",
      order_id: String(payment.id),
      order_description: `Apps Father balance top-up $${amountUsd}`,
      ipn_callback_url: `${config.baseUrl}/billing/ipn`,
      success_url: `https://t.me/apps_father_bot`,
      cancel_url: `https://t.me/apps_father_bot`,
    };

    const response = await fetch("https://api.nowpayments.io/v1/invoice", {
      method: "POST",
      headers: {
        "x-api-key": config.nowpaymentsApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const data: any = await response.json();

    if (!response.ok || !data.invoice_url) {
      console.error("[Billing] NOWPayments error:", data);
      throw new Error("Failed to create payment invoice");
    }

    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        nowpaymentsId: String(data.id),
        nowpaymentsInvoiceUrl: data.invoice_url,
      },
    });

    return { paymentId: payment.id, invoiceUrl: data.invoice_url as string };
  }

  async handleIPN(body: any, hmacHeader: string): Promise<void> {
    if (config.nowpaymentsIpnSecret) {
      const sorted = JSON.stringify(sortObject(body));
      const sig = crypto
        .createHmac("sha512", config.nowpaymentsIpnSecret)
        .update(sorted)
        .digest("hex");

      if (sig !== hmacHeader) {
        throw new Error("Invalid IPN signature");
      }
    }

    const { order_id, payment_status } = body;
    if (!order_id) return;

    const paymentId = parseInt(order_id, 10);
    if (isNaN(paymentId)) return;

    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment || payment.status === "confirmed") return;

    if (
      payment_status === "finished" ||
      payment_status === "confirmed"
    ) {
      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: paymentId },
          data: {
            status: "confirmed",
            confirmedAt: new Date(),
            nowpaymentsId: String(body.payment_id || body.id || payment.nowpaymentsId),
          },
        });

        await tx.user.update({
          where: { id: payment.userId },
          data: { balance: { increment: payment.amountUsd } },
        });
      });

      console.log(
        `[Billing] Payment #${paymentId} confirmed — $${payment.amountUsd} credited to user ${payment.userId}`
      );

      // Notify user via Telegram + notify admins
      try {
        const user = await prisma.user.findUnique({ where: { id: payment.userId } });
        if (user) {
          const newBalance = Number(user.balance);
          const text =
            `<b><tg-emoji emoji-id="5377544696656599429">✅</tg-emoji> Payment confirmed!</b>\n\n` +
            `<b><tg-emoji emoji-id="5377851954321989517">💲</tg-emoji> +$${Number(payment.amountUsd).toFixed(2)}</b> has been added to your balance.\n\n` +
            `<blockquote>New balance: <b>$${newBalance.toFixed(2)}</b></blockquote>`;

          await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: user.telegramId.toString(),
              text,
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "Join Community", url: "https://t.me/+of-sS1zbZHBmMDJi" }],
                ],
              },
            }),
          });

          notifyDeposit(Number(user.telegramId), user.username ?? undefined, Number(payment.amountUsd), newBalance);
        }
      } catch (notifyErr) {
        console.error("[Billing] Failed to notify user:", notifyErr);
      }
    } else if (
      payment_status === "expired" ||
      payment_status === "failed"
    ) {
      await prisma.payment.update({
        where: { id: paymentId },
        data: { status: payment_status },
      });
    }
  }

  async checkPaymentStatus(paymentId: number): Promise<{
    status: string;
    amountUsd: number;
  }> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) throw new Error("Payment not found");
    return {
      status: payment.status,
      amountUsd: Number(payment.amountUsd),
    };
  }
}

function sortObject(obj: any): any {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sortObject);
  return Object.keys(obj)
    .sort()
    .reduce((result: any, key) => {
      result[key] = sortObject(obj[key]);
      return result;
    }, {});
}

export const billingService = new BillingService();
