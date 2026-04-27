import { Router, Request, Response } from "express";
import crypto from "crypto";
import { billingService } from "../../services/billing.service";
import { config } from "../../config";
import { prisma } from "../../db";
import { notifyDeposit } from "../../services/notify.service";
import { trackEvent } from "../../services/analytics.service";

const router = Router();

router.post("/ipn", async (req: Request, res: Response) => {
  console.log("[Billing IPN] Received callback:", JSON.stringify(req.body));
  console.log("[Billing IPN] Signature header:", req.headers["x-nowpayments-sig"] || "(none)");

  try {
    const hmac = req.headers["x-nowpayments-sig"] as string || "";
    await billingService.handleIPN(req.body, hmac);
    console.log("[Billing IPN] Processed successfully");
    res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error("[Billing IPN] Error:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// Simple GET to verify the endpoint is reachable
router.get("/ipn", (_req: Request, res: Response) => {
  res.json({ status: "IPN endpoint active" });
});

// --- CryptoBot webhook ---

router.post("/cryptobot", async (req: Request, res: Response) => {
  console.log("[CryptoBot] Webhook received:", JSON.stringify(req.body));

  try {
    const signature = req.headers["crypto-pay-api-signature"] as string || "";
    const secret = crypto.createHash("sha256").update(config.cryptoBotToken).digest();
    const checkString = JSON.stringify(req.body);
    const hmac = crypto.createHmac("sha256", secret).update(checkString).digest("hex");

    if (hmac !== signature) {
      console.error("[CryptoBot] Invalid signature");
      res.status(403).json({ error: "Invalid signature" });
      return;
    }

    const { update_type, payload: invoice } = req.body;
    if (update_type !== "invoice_paid") {
      res.status(200).json({ ok: true });
      return;
    }

    let paymentId: number;
    try {
      const parsed = JSON.parse(invoice.payload || "{}");
      paymentId = parsed.paymentId;
    } catch {
      console.error("[CryptoBot] Failed to parse payload");
      res.status(400).json({ error: "Invalid payload" });
      return;
    }

    if (!paymentId) {
      res.status(400).json({ error: "Missing paymentId" });
      return;
    }

    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment || payment.status === "confirmed") {
      res.status(200).json({ ok: true });
      return;
    }

    const { total: creditsToGrant, base, bonus, isFirstPurchase, bundleName } = await billingService.resolveCreditsForPayment(paymentId);

    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { id: paymentId },
        data: {
          status: "confirmed",
          confirmedAt: new Date(),
          nowpaymentsId: String(invoice.invoice_id),
          creditsGranted: creditsToGrant,
          bonusCredits: bonus,
          method: "cryptobot",
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

    console.log(`[CryptoBot] Payment #${paymentId} confirmed — $${payment.amountUsd} / ${creditsToGrant} cr credited to user ${payment.userId}`);

    try {
      const user = await prisma.user.findUnique({ where: { id: payment.userId } });
      if (user) {
        const amountUsd = Number(payment.amountUsd);
        const text =
          `<b><tg-emoji emoji-id="5377544696656599429">✅</tg-emoji> Payment confirmed!</b>\n\n` +
          `<b>+${creditsToGrant.toLocaleString()} credits</b> added to your balance.` +
          (bonus > 0 ? ` (includes ${(bonus * (isFirstPurchase ? 2 : 1)).toLocaleString()} bonus!)` : "") +
          (isFirstPurchase ? "\n🎉 <b>×2 first-purchase bonus applied!</b>" : "") +
          `\n\n<blockquote>New balance: <b>${(await billingService.getUserCredits(user.id)).toLocaleString()} credits</b></blockquote>`;

        await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: user.telegramId.toString(),
            text,
            parse_mode: "HTML",
          }),
        });

        notifyDeposit(Number(user.telegramId), user.username ?? undefined, amountUsd, creditsToGrant, bonus, isFirstPurchase, "cryptobot", bundleName);
        void trackEvent(Number(user.telegramId), "payment", { amount: amountUsd, method: "cryptobot" });

        await billingService.creditReferralBonus(user, amountUsd);
      }
    } catch (notifyErr) {
      console.error("[CryptoBot] Notify error:", notifyErr);
    }

    res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error("[CryptoBot] Webhook error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
