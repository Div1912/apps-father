import { prisma } from "../db";
import { config } from "../config";
import crypto from "crypto";
import { Decimal } from "@prisma/client/runtime/library";
import { Cell } from "@ton/core";
import { runtimeConfig } from "./runtime-config.service";
import type { AgentSessionType, AgentComplexity } from "./runtime-config.service";
import { getModelPricing } from "./openrouter.service";
import { notifyDeposit, notifyReferralBonus } from "./notify.service";
import { trackEvent } from "./analytics.service";

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface UsageResult {
  costUsd: number;
  creditsCharged: number;
  newBalance: number;   // alias for newCredits (credits after deduction)
  newCredits: number;
}

export class BillingService {
  private decodeTonTextComment(body: string): string {
    if (!body) return "";
    try {
      const cell = Cell.fromBase64(body);
      const slice = cell.beginParse();
      if (slice.remainingBits < 32) return "";
      const op = slice.loadUint(32);
      if (op !== 0) return "";
      return slice.loadStringTail();
    } catch {
      try {
        const cells = Cell.fromBoc(Buffer.from(body, "base64"));
        const slice = cells[0]?.beginParse();
        if (!slice || slice.remainingBits < 32) return "";
        const op = slice.loadUint(32);
        if (op !== 0) return "";
        return slice.loadStringTail();
      } catch {
        return "";
      }
    }
  }

  private extractTonMessageText(inMsg: any): string {
    const parts: string[] = [];
    const decoded = inMsg?.message_content?.decoded;
    if (decoded?.type === "text_comment" && decoded.comment) {
      parts.push(String(decoded.comment));
    }
    if (typeof inMsg?.message === "string") {
      parts.push(inMsg.message);
    }
    if (typeof inMsg?.comment === "string") {
      parts.push(inMsg.comment);
    }

    const body = inMsg?.message_content?.body || inMsg?.body;
    if (typeof body === "string" && body) {
      parts.push(body);
      const decodedBody = this.decodeTonTextComment(body);
      if (decodedBody) parts.push(decodedBody);
    }

    return parts.join("\n");
  }

  async getUserBalance(userId: number): Promise<number> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { balance: true },
    });
    return user ? Number(user.balance) : 0;
  }

  async getUserCredits(userId: number): Promise<number> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { credits: true },
    });
    return user ? user.credits : 0;
  }

  /** Check if user has enough credits. minAmount is in credits. */
  async hasBalance(userId: number, minAmount: number = 1): Promise<boolean> {
    const credits = await this.getUserCredits(userId);
    return credits >= minAmount;
  }

  async hasCredits(userId: number, minCredits: number = 1): Promise<boolean> {
    const credits = await this.getUserCredits(userId);
    return credits >= minCredits;
  }

  private calculateCostWithPricing(
    pricing: { input: number; output: number; cache_write: number; cache_read: number },
    usage: TokenUsage,
  ): number {
    const inputCost = (usage.input_tokens ?? 0) * pricing.input;
    const outputCost = (usage.output_tokens ?? 0) * pricing.output;
    const cacheWrite = (usage.cache_creation_input_tokens ?? 0) * pricing.cache_write;
    const cacheRead = (usage.cache_read_input_tokens ?? 0) * pricing.cache_read;
    return inputCost + outputCost + cacheWrite + cacheRead;
  }

  async calculateCostAsync(model: string, usage: TokenUsage): Promise<number> {
    const livePricing = await getModelPricing(model);
    if (livePricing) {
      return this.calculateCostWithPricing({
        input: livePricing.promptPerToken,
        output: livePricing.completionPerToken,
        cache_write: livePricing.cacheWritePerToken || livePricing.promptPerToken * 1.25,
        cache_read: livePricing.cacheReadPerToken || livePricing.promptPerToken * 0.1,
      }, usage);
    }
    console.warn(`[Billing] No live pricing for model "${model}", cost recorded as 0`);
    return 0;
  }

  /**
   * Immediately deduct the flat credit cost for a session type from the user's
   * balance so the balance update is visible before the agent finishes.
   * Returns the credits charged and the new balance.
   * Call recordUsage afterwards with preCharged=true to log without double-deducting.
   */
  async preChargeAction(
    userId: number,
    projectId: string | null,
    sessionType: AgentSessionType,
    complexity?: AgentComplexity,
    planLength?: number,
  ): Promise<{ creditsCharged: number; newCredits: number }> {
    return this._preChargeWithAmount(
      userId, projectId,
      runtimeConfig.getSessionCost(sessionType, complexity, planLength),
    );
  }

  /**
   * Pre-charge an exact, already-computed credit amount. Used by
   * `execute-proposal` to honour the price quoted to the user on the
   * proposal card, immune to admin price edits between propose and execute.
   */
  async preChargeAmount(
    userId: number,
    projectId: string | null,
    creditsCharged: number,
  ): Promise<{ creditsCharged: number; newCredits: number }> {
    return this._preChargeWithAmount(userId, projectId, creditsCharged);
  }

  private async _preChargeWithAmount(
    userId: number,
    projectId: string | null,
    creditsChargedRaw: number,
  ): Promise<{ creditsCharged: number; newCredits: number }> {
    const creditsCharged = Math.max(0, creditsChargedRaw | 0);
    if (creditsCharged <= 0) {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { credits: true } });
      return { creditsCharged: 0, newCredits: u?.credits ?? 0 };
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { credits: { decrement: creditsCharged } },
    });
    if (projectId) {
      await prisma.project.update({
        where: { id: projectId },
        data: { totalCostUsd: { increment: new Decimal("0") } },
      }).catch(() => {});
    }
    return { creditsCharged, newCredits: updatedUser.credits };
  }

  /**
   * Refund credits previously taken via preChargeAction when the agent
   * fails before producing usable output. Logs a UsageLog row with a
   * negative `creditsCharged` so admin sessions page reflects refunds.
   * Operation should be the original action id ("build", "update", ...);
   * we tag the log row as `refund_<operation>` for clarity.
   * Idempotent: refunds the requested amount as a single increment, so
   * callers must guard against double-refund themselves (we do that via
   * progress-message metadata flagging in /abort recovery).
   */
  async refundAction(
    userId: number,
    projectId: string | null,
    operation: string,
    credits: number,
    taskId?: string,
  ): Promise<{ newCredits: number }> {
    if (credits <= 0) {
      const u = await prisma.user.findUnique({ where: { id: userId }, select: { credits: true } });
      return { newCredits: u?.credits ?? 0 };
    }
    const result = await prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: userId },
        data: { credits: { increment: credits } },
      });
      await tx.usageLog.create({
        data: {
          userId,
          projectId: projectId ?? null,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: new Decimal("0"),
          operation: `refund_${operation}`,
          creditsCharged: -credits,
          taskId: taskId ?? null,
        },
      });
      return u.credits;
    });
    return { newCredits: result };
  }

  /**
   * True iff the user has ever made a confirmed deposit (any payment row
   * with status = "confirmed"). Used to gate the player-preview paywall.
   */
  async hasEverDeposited(userId: number): Promise<boolean> {
    const p = await prisma.payment.findFirst({
      where: { userId, status: "confirmed" },
      select: { id: true },
    });
    return !!p;
  }

  /**
   * True iff this user has previously unlocked the preview for this
   * project (one-time 20-credit purchase logged in usage_logs).
   */
  async hasUnlockedPreview(userId: number, projectId: string): Promise<boolean> {
    const log = await prisma.usageLog.findFirst({
      where: { userId, projectId, operation: "preview_unlock" },
      select: { id: true },
    });
    return !!log;
  }

  /**
   * True iff this user has previously paid the one-time 15-credit fee
   * to unlock the "Create Bot" / link-bot flow for this project.
   * The actual bot-link itself is tracked via Project.botUsername; this
   * is just the gate that prevents charging the same project twice when
   * the user re-clicks the button before completing the flow.
   */
  async hasUnlockedBotCreate(userId: number, projectId: string): Promise<boolean> {
    const log = await prisma.usageLog.findFirst({
      where: { userId, projectId, operation: "bot_create_unlock" },
      select: { id: true },
    });
    return !!log;
  }

  async recordUsage(
    userId: number,
    projectId: string | null,
    model: string,
    usage: TokenUsage,
    operation: string,
    _legacyTierId?: string,
    preCharged: boolean | number = false,
    taskId?: string,
  ): Promise<UsageResult> {
    const costUsd = await this.calculateCostAsync(model, usage);

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { credits: true } });
    // When preCharged is a number we record that exact amount (it represents
    // the credits already deducted via preChargeAction at session start).
    // When `true` is passed, we keep the legacy behaviour of "no extra deduct"
    // but still record 0 so the row stays consistent with preChargeAction.
    // Old call sites pass `true` — they should migrate to passing the number.
    const creditsCharged = typeof preCharged === "number"
      ? Math.max(0, preCharged | 0)
      : 0;

    const result = await prisma.$transaction(async (tx) => {
      await tx.usageLog.create({
        data: {
          userId,
          projectId,
          inputTokens: usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens,
          outputTokens: usage.output_tokens,
          costUsd: new Decimal(costUsd.toFixed(6)),
          operation,
          creditsCharged,
          taskId: taskId || null,
        },
      });

      if (projectId) {
        await tx.project.update({
          where: { id: projectId },
          data: { totalCostUsd: { increment: new Decimal(costUsd.toFixed(4)) } },
        });
      }

      const newCredits = user?.credits ?? 0;
      return { costUsd, creditsCharged, newCredits, newBalance: newCredits };
    });

    return result;
  }

  /**
   * Resolve credits to grant for a payment.
   * Uses bundle definition when bundleId is present, else falls back to creditsPerDollar rate.
   * isFirstPurchase = user has 0 previously confirmed payments → doubles total.
   */
  async resolveCreditsForPayment(paymentId: number): Promise<{
    total: number; base: number; bonus: number; isFirstPurchase: boolean; bundleName?: string;
  }> {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { bundle: true },
    });
    if (!payment) throw new Error("Payment not found");

    const confirmedBefore = await prisma.payment.count({
      where: { userId: payment.userId, status: "confirmed", id: { not: paymentId } },
    });
    const isFirstPurchase = confirmedBefore === 0;
    const multiplier = isFirstPurchase ? 2 : 1;

    if (payment.bundle) {
      const base = payment.bundle.credits;
      const bonus = payment.bundle.bonusCredits;
      const total = (base + bonus) * multiplier;
      return { total, base, bonus, isFirstPurchase, bundleName: payment.bundle.name };
    }

    // Legacy: no bundle → flat rate
    const base = Math.floor(Number(payment.amountUsd) * runtimeConfig.getCreditsPerDollar());
    return { total: base * multiplier, base, bonus: 0, isFirstPurchase };
  }

  async createTopUp(
    userId: number,
    amountUsd: number,
    bundleId?: string
  ): Promise<{ paymentId: number; invoiceUrl: string }> {
    if (amountUsd < runtimeConfig.getMinTopup()) {
      throw new Error(`Minimum top-up is $${runtimeConfig.getMinTopup()}`);
    }

    const payment = await prisma.payment.create({
      data: {
        userId,
        amountUsd: new Decimal(amountUsd.toFixed(4)),
        status: "pending",
        bundleId: bundleId ?? null,
        method: "crypto",
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
      const detail = data?.message || data?.error || JSON.stringify(data);
      console.error("[Billing] NOWPayments error:", data);
      throw new Error(`Failed to create payment invoice: ${detail}`);
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
    amountUsd: number,
    bundleId?: string
  ): Promise<{ paymentId: number; invoiceUrl: string }> {
    if (amountUsd < runtimeConfig.getMinTopup()) {
      throw new Error(`Minimum top-up is $${runtimeConfig.getMinTopup()}`);
    }

    const payment = await prisma.payment.create({
      data: {
        userId,
        amountUsd: new Decimal(amountUsd.toFixed(4)),
        status: "pending",
        bundleId: bundleId ?? null,
        method: "cryptobot",
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
        amount: parseFloat(amountUsd.toFixed(2)),
        description: `Apps Father balance top-up $${amountUsd.toFixed(2)}`,
        payload: JSON.stringify({ paymentId: payment.id }),
        paid_btn_name: "openBot",
        paid_btn_url: "https://t.me/apps_father_bot",
      }),
    });

    const data: any = await response.json();

    if (!data.ok || !data.result) {
      const detail = data?.error?.name || data?.error?.code || JSON.stringify(data?.error || data);
      console.error("[Billing] CryptoBot error:", data);
      throw new Error(`Failed to create CryptoBot invoice: ${detail}`);
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
    stars: number,
    bundleId?: string
  ): Promise<{ paymentId: number; invoiceUrl: string }> {
    const payment = await prisma.payment.create({
      data: {
        userId,
        amountUsd: new Decimal(amountUsd.toFixed(4)),
        status: "pending",
        bundleId: bundleId ?? null,
        method: "stars",
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
    amountUsd: number,
    bundleId?: string
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
        bundleId: bundleId ?? null,
        method: "ton",
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

        const msgBody = this.extractTonMessageText(inMsg);

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

  async reconcilePendingTonPaymentsForUser(userId: number): Promise<number> {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const pending = await prisma.payment.findMany({
      where: {
        userId,
        status: "pending",
        nowpaymentsId: { startsWith: "ton:" },
        createdAt: { gte: since },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true },
    });

    let confirmed = 0;
    for (const payment of pending) {
      try {
        const result = await this.verifyTonPayment(payment.id);
        if (result.confirmed) confirmed++;
      } catch (err: any) {
        console.error(`[Billing] TON reconcile failed for payment #${payment.id}:`, err.message || err);
      }
    }
    return confirmed;
  }

  private async confirmTonPayment(paymentId: number): Promise<void> {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status === "confirmed") return;

    const { total: creditsToGrant, base, bonus, isFirstPurchase, bundleName } = await this.resolveCreditsForPayment(paymentId);

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: "confirmed",
          confirmedAt: new Date(),
          creditsGranted: creditsToGrant,
          bonusCredits: bonus,
          method: "ton",
        },
      });
      await tx.user.update({
        where: { id: payment.userId },
        data: {
          balance: { increment: payment.amountUsd },
          credits: { increment: creditsToGrant },
        },
      });
      if (payment.bundleId) {
        await tx.bundle.update({
          where: { id: payment.bundleId },
          data: { purchaseCount: { increment: 1 } },
        });
      }
    });

    console.log(`[Billing] TON payment #${paymentId} confirmed — $${payment.amountUsd} / ${creditsToGrant} cr credited to user ${payment.userId}`);

    const user = await prisma.user.findUnique({ where: { id: payment.userId } });
    if (user) {
      const amountUsd = Number(payment.amountUsd);
      const text =
        `<b><tg-emoji emoji-id="5377544696656599429">✅</tg-emoji> Payment confirmed!</b>\n\n` +
        `<b>+${creditsToGrant.toLocaleString()} credits</b> added to your balance.` +
        (bonus > 0 ? ` (includes ${(bonus * (isFirstPurchase ? 2 : 1)).toLocaleString()} bonus!)` : "") +
        (isFirstPurchase ? "\n🎉 <b>×2 first-purchase bonus applied!</b>" : "") +
        `\n\n<blockquote>New balance: <b>${(await this.getUserCredits(user.id)).toLocaleString()} credits</b></blockquote>`;

      await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: user.telegramId.toString(), text, parse_mode: "HTML" }),
      }).catch(() => {});

      notifyDeposit(Number(user.telegramId), user.username ?? undefined, amountUsd, creditsToGrant, bonus, isFirstPurchase, "ton", bundleName, await this.getUserCredits(user.id));
      void trackEvent(Number(user.telegramId), "payment", { amount: amountUsd, method: "ton" });

      await this.creditReferralBonus(user, amountUsd, creditsToGrant);
    }
  }

  async handleStarsPayment(paymentId: number): Promise<void> {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status === "confirmed") return;

    const { total: creditsToGrant, base, bonus, isFirstPurchase, bundleName } = await this.resolveCreditsForPayment(paymentId);

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: "confirmed",
          confirmedAt: new Date(),
          creditsGranted: creditsToGrant,
          bonusCredits: bonus,
          method: "stars",
        },
      });

      await tx.user.update({
        where: { id: payment.userId },
        data: {
          balance: { increment: payment.amountUsd },
          credits: { increment: creditsToGrant },
        },
      });

      if (payment.bundleId) {
        await tx.bundle.update({
          where: { id: payment.bundleId },
          data: { purchaseCount: { increment: 1 } },
        });
      }
    });

    console.log(`[Billing] Stars payment #${paymentId} confirmed — $${payment.amountUsd} / ${creditsToGrant} cr credited to user ${payment.userId}`);

    const user = await prisma.user.findUnique({ where: { id: payment.userId } });
    if (user) {
      const amountUsd = Number(payment.amountUsd);
      const text =
        `<b><tg-emoji emoji-id="5377544696656599429">✅</tg-emoji> Payment confirmed!</b>\n\n` +
        `<b>+${creditsToGrant.toLocaleString()} credits</b> added to your balance.` +
        (bonus > 0 ? ` (includes ${(bonus * (isFirstPurchase ? 2 : 1)).toLocaleString()} bonus!)` : "") +
        (isFirstPurchase ? "\n🎉 <b>×2 first-purchase bonus applied!</b>" : "") +
        `\n\n<blockquote>New balance: <b>${(await this.getUserCredits(user.id)).toLocaleString()} credits</b></blockquote>`;

      await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: user.telegramId.toString(),
          text,
          parse_mode: "HTML",
        }),
      }).catch(() => {});

      notifyDeposit(Number(user.telegramId), user.username ?? undefined, amountUsd, creditsToGrant, bonus, isFirstPurchase, "stars", bundleName, await this.getUserCredits(user.id));
      void trackEvent(Number(user.telegramId), "payment", { amount: amountUsd, method: "stars" });

      await this.creditReferralBonus(user, amountUsd, creditsToGrant);
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
      const { total: creditsToGrant, base, bonus, isFirstPurchase, bundleName } = await this.resolveCreditsForPayment(paymentId);

      await prisma.$transaction(async (tx) => {
        await tx.payment.update({
          where: { id: paymentId },
          data: {
            status: "confirmed",
            confirmedAt: new Date(),
            nowpaymentsId: String(body.payment_id || body.id || payment.nowpaymentsId),
            creditsGranted: creditsToGrant,
            bonusCredits: bonus,
            method: "crypto",
          },
        });

        await tx.user.update({
          where: { id: payment.userId },
          data: {
            balance: { increment: payment.amountUsd },
            credits: { increment: creditsToGrant },
          },
        });

        if (payment.bundleId) {
          await tx.bundle.update({
            where: { id: payment.bundleId },
            data: { purchaseCount: { increment: 1 } },
          });
        }
      });

      console.log(
        `[Billing] Payment #${paymentId} confirmed — $${payment.amountUsd} / ${creditsToGrant} cr credited to user ${payment.userId}`
      );

      // Notify user via Telegram + notify admins
      try {
        const user = await prisma.user.findUnique({ where: { id: payment.userId } });
        if (user) {
          const amountUsd = Number(payment.amountUsd);
          const text =
            `<b><tg-emoji emoji-id="5377544696656599429">✅</tg-emoji> Payment confirmed!</b>\n\n` +
            `<b>+${creditsToGrant.toLocaleString()} credits</b> added to your balance.` +
            (bonus > 0 ? ` (includes ${(bonus * (isFirstPurchase ? 2 : 1)).toLocaleString()} bonus!)` : "") +
            (isFirstPurchase ? "\n🎉 <b>×2 first-purchase bonus applied!</b>" : "") +
            `\n\n<blockquote>New balance: <b>${(await this.getUserCredits(user.id)).toLocaleString()} credits</b></blockquote>`;

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

          notifyDeposit(Number(user.telegramId), user.username ?? undefined, amountUsd, creditsToGrant, bonus, isFirstPurchase, "crypto", bundleName, await this.getUserCredits(user.id));
          void trackEvent(Number(user.telegramId), "payment", { amount: amountUsd, method: "crypto" });

          await this.creditReferralBonus(user, amountUsd, creditsToGrant);
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

  /**
   * Credit a percentage-based bonus on the user's very first confirmed deposit.
   * The bonus equals `runtimeConfig.firstTopupBonusPercent`% of the deposited
   * amount (e.g. 100% → user deposits $5 and receives an extra +$5).
   * Atomic: only triggers if `firstDepositBonusGiven` is still false AND the
   * confirmed-payments-count equals 1 (i.e. the payment we just confirmed).
   */
  async creditFirstDepositBonus(userId: number, justConfirmedPaymentId: number): Promise<void> {
    try {
      const percent = Number(runtimeConfig.get().firstTopupBonusPercent) || 0;
      if (percent <= 0) return;

      // Count confirmed payments that are NOT the one we just confirmed
      const otherConfirmed = await prisma.payment.count({
        where: { userId, status: "confirmed", id: { not: justConfirmedPaymentId } },
      });
      if (otherConfirmed > 0) return;

      // Pull the deposit amount so the bonus can be a % of it.
      const justPaid = await prisma.payment.findUnique({
        where: { id: justConfirmedPaymentId },
        select: { amountUsd: true },
      });
      const depositAmountUsd = Number(justPaid?.amountUsd ?? 0);
      if (depositAmountUsd <= 0) return;

      const bonusUsd = +(depositAmountUsd * percent / 100).toFixed(4);
      if (bonusUsd <= 0) return;

      const bonusCredits = Math.floor(bonusUsd * runtimeConfig.getCreditsPerDollar());

      // Atomic: flag toggles only if currently false; this prevents double-credit.
      const updated = await prisma.user.updateMany({
        where: { id: userId, firstDepositBonusGiven: false },
        data: {
          firstDepositBonusGiven: true,
          balance: { increment: new Decimal(bonusUsd.toFixed(4)) },
          credits: { increment: bonusCredits },
        },
      });
      if (updated.count === 0) return;

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return;
      const newBalance = Number(user.balance);

      const text =
        `<b><tg-emoji emoji-id="5384541907051357217">🎁</tg-emoji> First-deposit bonus!</b>\n\n` +
        `<b><tg-emoji emoji-id="5377851954321989517">💲</tg-emoji> +$${bonusUsd.toFixed(2)}</b> (${percent}% of your first deposit) credited to your balance.\n\n` +
        `<blockquote>New balance: <b>$${newBalance.toFixed(2)}</b></blockquote>`;

      await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: user.telegramId.toString(), text, parse_mode: "HTML" }),
      }).catch(() => {});

      console.log(`[Billing] First-deposit bonus +$${bonusUsd.toFixed(2)} (${percent}%) credited to user ${userId}`);
    } catch (err) {
      console.error("[Billing] Failed to credit first-deposit bonus:", err);
    }
  }

  async creditReferralBonus(
    user: { referredBy: bigint | null; telegramId: bigint },
    amountUsd: number,
    creditsGranted: number = 0,
  ): Promise<void> {
    if (!user.referredBy) return;

    try {
      const referrer = await prisma.user.findUnique({ where: { telegramId: user.referredBy } });
      if (!referrer) return;

      if (referrer.isPartner && referrer.partnerPercent) {
        // Partner earns a % of the USD amount paid by their referred user
        const bonusUsd = amountUsd * Number(referrer.partnerPercent) / 100;
        const updated = await prisma.user.update({
          where: { telegramId: user.referredBy },
          data: { partnerBalance: { increment: new Decimal(bonusUsd.toFixed(4)) } },
        });
        const newBal = Number(updated.partnerBalance);
        const bonusText =
          `<b><tg-emoji emoji-id="5377544696656599429">✅</tg-emoji> Partner commission!</b>\n\n` +
          `Your referred user made a deposit.\n` +
          `<b>+$${bonusUsd.toFixed(2)}</b> added to your partner balance.\n\n` +
          `<blockquote>Partner balance: <b>$${newBal.toFixed(2)}</b></blockquote>`;
        await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: referrer.telegramId.toString(), text: bonusText, parse_mode: "HTML" }),
        }).catch(() => {});
        notifyReferralBonus(Number(referrer.telegramId), referrer.username ?? undefined, bonusUsd, Number(user.telegramId));
        console.log(`[Billing] Partner commission $${bonusUsd.toFixed(2)} credited to ${referrer.telegramId}`);
      } else {
        // Regular referral: referrer earns % of credits granted to the buyer
        const pct = runtimeConfig.get().referralBonusPercent ?? 15;
        const bonusCredits = Math.round(creditsGranted * pct / 100);
        if (bonusCredits <= 0) return;
        const updated = await prisma.user.update({
          where: { telegramId: user.referredBy },
          data: { credits: { increment: bonusCredits } },
        });
        const newCredits = updated.credits;
        const bonusText =
          `<b><tg-emoji emoji-id="5377544696656599429">✅</tg-emoji> Referral bonus!</b>\n\n` +
          `Your invited friend made a deposit.\n` +
          `<b>+${bonusCredits.toLocaleString()} credits</b> added to your balance.\n\n` +
          `<blockquote>New balance: <b>${newCredits.toLocaleString()} credits</b></blockquote>`;
        await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: referrer.telegramId.toString(), text: bonusText, parse_mode: "HTML" }),
        }).catch(() => {});
        notifyReferralBonus(Number(referrer.telegramId), referrer.username ?? undefined, bonusCredits, Number(user.telegramId));
        console.log(`[Billing] Referral bonus ${bonusCredits} cr credited to ${referrer.telegramId}`);
      }
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
