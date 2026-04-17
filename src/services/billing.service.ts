import { prisma } from "../db";
import { config } from "../config";
import crypto from "crypto";
import { Decimal } from "@prisma/client/runtime/library";
import { runtimeConfig } from "./runtime-config.service";
import { notifyDeposit, notifyReferralBonus } from "./notify.service";
import { trackEvent } from "./analytics.service";

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
  "claude-haiku-4-5-20251001": {
    input: 1.00 / 1_000_000,
    output: 5.00 / 1_000_000,
    cache_write: 1.25 / 1_000_000,
    cache_read: 0.10 / 1_000_000,
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

  calculateCost(model: string, usage: TokenUsage, operation?: string): number {
    const p = MODEL_PRICING[model] || MODEL_PRICING["claude-sonnet-4-6"];
    const inputCost = (usage.input_tokens ?? 0) * p.input;
    const outputCost = (usage.output_tokens ?? 0) * p.output;
    const cacheWrite = (usage.cache_creation_input_tokens ?? 0) * p.cache_write;
    const cacheRead = (usage.cache_read_input_tokens ?? 0) * p.cache_read;
    const total = inputCost + outputCost + cacheWrite + cacheRead;
    const multiplier = operation === "ask" ? runtimeConfig.getAskMultiplier() : runtimeConfig.getMarkupMultiplier();
    return total * multiplier;
  }

  async recordUsage(
    userId: number,
    projectId: string | null,
    model: string,
    usage: TokenUsage,
    operation: string
  ): Promise<UsageResult> {
    const costUsd = this.calculateCost(model, usage, operation);

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

  async createCryptoBotInvoice(
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

    const response = await fetch("https://pay.crypt.bot/api/createInvoice", {
      method: "POST",
      headers: {
        "Crypto-Pay-API-Token": config.cryptoBotToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        currency_type: "fiat",
        fiat: "USD",
        accepted_assets: "USDT,TON,BTC,ETH,LTC,BNB,TRX,USDC",
        amount: amountUsd.toFixed(2),
        description: `Apps Father balance top-up $${amountUsd.toFixed(2)}`,
        payload: JSON.stringify({ paymentId: payment.id }),
        paid_btn_name: "openBot",
        paid_btn_url: "https://t.me/apps_father_bot",
      }),
    });

    const data: any = await response.json();

    if (!data.ok || !data.result) {
      console.error("[Billing] CryptoBot error:", data);
      throw new Error("Failed to create CryptoBot invoice");
    }

    const invoiceUrl = data.result.mini_app_invoice_url || data.result.bot_invoice_url;

    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        nowpaymentsId: String(data.result.invoice_id),
        nowpaymentsInvoiceUrl: invoiceUrl,
      },
    });

    return { paymentId: payment.id, invoiceUrl };
  }

  async createStarsInvoice(
    userId: number,
    amountUsd: number,
    stars: number
  ): Promise<{ paymentId: number; invoiceUrl: string }> {
    const payment = await prisma.payment.create({
      data: {
        userId,
        amountUsd: new Decimal(amountUsd.toFixed(4)),
        status: "pending",
      },
    });

    const response = await fetch(`https://api.telegram.org/bot${config.botToken}/createInvoiceLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `Top-up $${amountUsd.toFixed(2)}`,
        description: `Apps Father balance top-up $${amountUsd.toFixed(2)} (${stars} stars)`,
        payload: JSON.stringify({ paymentId: payment.id, type: "topup" }),
        provider_token: "",
        currency: "XTR",
        prices: [{ label: `$${amountUsd.toFixed(2)} top-up`, amount: stars }],
      }),
    });

    const data: any = await response.json();

    if (!data.ok || !data.result) {
      console.error("[Billing] Stars invoice error:", data);
      throw new Error("Failed to create Stars invoice");
    }

    await prisma.payment.update({
      where: { id: payment.id },
      data: {
        nowpaymentsId: `stars_${payment.id}`,
        nowpaymentsInvoiceUrl: data.result,
      },
    });

    return { paymentId: payment.id, invoiceUrl: data.result };
  }

  static readonly TON_WALLET = "UQCoZZWxI49ZtHqiUfc5v23OzY0lGG31LNEvyxu_NDlE4wNV";

  async createTonPayment(
    userId: number,
    amountUsd: number
  ): Promise<{ paymentId: number; walletAddress: string; amountNano: string }> {
    if (amountUsd < runtimeConfig.getMinTopup()) {
      throw new Error(`Minimum top-up is $${runtimeConfig.getMinTopup()}`);
    }

    const tonPrice = await this.getTonUsdPrice();
    const tonAmount = amountUsd / tonPrice;
    const amountNano = BigInt(Math.ceil(tonAmount * 1e9)).toString();

    const payment = await prisma.payment.create({
      data: {
        userId,
        amountUsd: new Decimal(amountUsd.toFixed(4)),
        status: "pending",
        nowpaymentsId: `ton:${amountNano}`,
      },
    });

    console.log(`[Billing] TON payment #${payment.id} created: $${amountUsd} = ${tonAmount.toFixed(4)} TON (${amountNano} nanoTON)`);

    return {
      paymentId: payment.id,
      walletAddress: BillingService.TON_WALLET,
      amountNano,
    };
  }

  async getTonUsdPrice(): Promise<number> {
    try {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd");
      const data: any = await res.json();
      const price = data?.["the-open-network"]?.usd;
      if (price && price > 0) return price;
    } catch (err) {
      console.error("[Billing] CoinGecko price fetch failed:", err);
    }
    return 3.5;
  }

  async verifyTonPayment(paymentId: number): Promise<{ confirmed: boolean; balance?: number }> {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new Error("Payment not found");
    if (payment.status === "confirmed") {
      const user = await prisma.user.findUnique({ where: { id: payment.userId } });
      return { confirmed: true, balance: Number(user?.balance || 0) };
    }

    // Use the original nano amount stored at creation time to avoid price drift
    let expectedNano: bigint;
    if (payment.nowpaymentsId?.startsWith("ton:")) {
      expectedNano = BigInt(payment.nowpaymentsId.slice(4));
    } else {
      const tonPrice = await this.getTonUsdPrice();
      const tonAmount = Number(payment.amountUsd) / tonPrice;
      expectedNano = BigInt(Math.ceil(tonAmount * 1e9));
    }

    // Allow 2% tolerance for network fees / rounding
    const minAcceptable = expectedNano * 98n / 100n;

    const createdAtSec = Math.floor(payment.createdAt.getTime() / 1000);

    try {
      const url = `https://toncenter.com/api/v3/transactions?account=${encodeURIComponent(BillingService.TON_WALLET)}&limit=50&sort=desc&start_utime=${createdAtSec}`;
      const apiRes = await fetch(url, { headers: { "Content-Type": "application/json" } });
      if (!apiRes.ok) {
        console.error("[Billing] TonCenter error:", apiRes.status);
        return { confirmed: false };
      }

      const data: any = await apiRes.json();
      const txList = data.transactions || [];
      const paymentIdStr = String(paymentId);

      for (const tx of txList) {
        const inMsg = tx.in_msg;
        if (!inMsg) continue;

        let msgBody = "";
        try {
          if (inMsg.message_content?.decoded?.type === "text_comment") {
            msgBody = inMsg.message_content.decoded.comment || "";
          } else if (inMsg.message_content?.body) {
            msgBody = inMsg.message_content.body;
          }
        } catch {}

        if (!msgBody.includes(paymentIdStr)) continue;

        const receivedNano = BigInt(inMsg.value || "0");
        if (receivedNano < minAcceptable) {
          console.warn(`[Billing] TON payment #${paymentId}: received ${receivedNano} < min ${minAcceptable} (expected ${expectedNano})`);
          continue;
        }

        await this.confirmTonPayment(payment.id);
        const user = await prisma.user.findUnique({ where: { id: payment.userId } });
        return { confirmed: true, balance: Number(user?.balance || 0) };
      }
    } catch (err) {
      console.error("[Billing] TON verify error:", err);
    }

    return { confirmed: false };
  }

  private async confirmTonPayment(paymentId: number): Promise<void> {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status === "confirmed") return;

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: { status: "confirmed", confirmedAt: new Date() },
      });
      await tx.user.update({
        where: { id: payment.userId },
        data: { balance: { increment: payment.amountUsd } },
      });
    });

    console.log(`[Billing] TON payment #${paymentId} confirmed — $${payment.amountUsd} credited to user ${payment.userId}`);

    const user = await prisma.user.findUnique({ where: { id: payment.userId } });
    if (user) {
      const newBalance = Number(user.balance);
      const amountUsd = Number(payment.amountUsd);
      const text =
        `<b><tg-emoji emoji-id="5377544696656599429">✅</tg-emoji> Payment confirmed!</b>\n\n` +
        `<b><tg-emoji emoji-id="5377851954321989517">💲</tg-emoji> +$${amountUsd.toFixed(2)}</b> has been added to your balance.\n\n` +
        `<blockquote>New balance: <b>$${newBalance.toFixed(2)}</b></blockquote>`;

      await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: user.telegramId.toString(), text, parse_mode: "HTML" }),
      }).catch(() => {});

      notifyDeposit(Number(user.telegramId), user.username ?? undefined, amountUsd, newBalance);
      void trackEvent(Number(user.telegramId), "payment", { amount: amountUsd, method: "ton" });

      await this.creditReferralBonus(user, amountUsd);
    }
  }

  async handleStarsPayment(paymentId: number): Promise<void> {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status === "confirmed") return;

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: { status: "confirmed", confirmedAt: new Date() },
      });

      await tx.user.update({
        where: { id: payment.userId },
        data: { balance: { increment: payment.amountUsd } },
      });
    });

    console.log(`[Billing] Stars payment #${paymentId} confirmed — $${payment.amountUsd} credited to user ${payment.userId}`);

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
        }),
      }).catch(() => {});

      notifyDeposit(Number(user.telegramId), user.username ?? undefined, Number(payment.amountUsd), newBalance);
      void trackEvent(Number(user.telegramId), "payment", { amount: Number(payment.amountUsd), method: "stars" });

      await this.creditReferralBonus(user, Number(payment.amountUsd));
    }
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
          void trackEvent(Number(user.telegramId), "payment", { amount: Number(payment.amountUsd), method: "nowpayments" });

          await this.creditReferralBonus(user, Number(payment.amountUsd));
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

  async creditReferralBonus(user: { referredBy: bigint | null; telegramId: bigint }, amountUsd: number): Promise<void> {
    if (!user.referredBy) return;

    try {
      const referrer = await prisma.user.findUnique({ where: { telegramId: user.referredBy } });
      if (!referrer) return;

      let bonus: number;
      let balanceField: "partnerBalance" | "balance";
      let label: string;

      if (referrer.isPartner && referrer.partnerPercent) {
        bonus = amountUsd * Number(referrer.partnerPercent) / 100;
        balanceField = "partnerBalance";
        label = "Partner";
      } else {
        bonus = amountUsd * 0.15;
        balanceField = "balance";
        label = "Referral";
      }

      const updated = await prisma.user.update({
        where: { telegramId: user.referredBy },
        data: { [balanceField]: { increment: new Decimal(bonus.toFixed(4)) } },
      });

      const newBal = Number(updated[balanceField]);
      const bonusText =
        `<b><tg-emoji emoji-id="5377544696656599429">✅</tg-emoji> ${label} bonus!</b>\n\n` +
        `Your referral just topped up their account.\n` +
        `<b><tg-emoji emoji-id="5377851954321989517">💲</tg-emoji> +$${bonus.toFixed(2)}</b> has been added to your ${referrer.isPartner ? "partner " : ""}balance.\n\n` +
        `<blockquote>New ${referrer.isPartner ? "partner " : ""}balance: <b>$${newBal.toFixed(2)}</b></blockquote>`;

      await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: referrer.telegramId.toString(), text: bonusText, parse_mode: "HTML" }),
      }).catch(() => {});

      notifyReferralBonus(Number(referrer.telegramId), referrer.username ?? undefined, bonus, Number(user.telegramId));
      console.log(`[Billing] ${label} bonus $${bonus.toFixed(2)} credited to ${referrer.telegramId} (${balanceField})`);
    } catch (err) {
      console.error("[Billing] Failed to credit referral/partner bonus:", err);
    }
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
