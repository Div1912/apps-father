import { config } from "../config";
import { t, Lang } from "../bot/i18n";
import { prisma } from "../db";

const ADMIN_IDS = ["8784357184", "8796958409"];

// How long we delay the "new user" admin notification after a user row is
// first persisted. With the X-Apps-Father-Start-Param header now flowing
// through every Mini App / Desktop API call (see attachAttribution
// middleware in src/web/server.ts), the FIRST request to create the row
// already carries the correct source — so the back-fill window collapses
// to milliseconds in the common case. We still hold the notification for
// 10 s as cheap insurance: it covers (a) the bot /start cross-session case
// where the row is created from the bot first and the Mini App carries the
// source seconds later, and (b) any Telegram client where headers race
// behind body delivery on slow networks. Cost is purely admin-side latency.
const ADMIN_NOTIFY_DELAY_MS = 3000;

function sendTelegram(chatId: string, text: string, extra?: Record<string, any>): void {
  fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...extra }),
  }).catch((err) => console.error("[Notify] Failed to send to", chatId, err));
}

function notifyAdmins(text: string): void {
  for (const id of ADMIN_IDS) {
    sendTelegram(id, text);
  }
}

// Fire the "new user" admin notification at most ONCE per Telegram user,
// regardless of how many parallel calls reach getOrCreateUser. The hint
// args (username/firstName/referredBy/source) are diagnostic only; the
// actual notification is built from the freshest DB row at send time so
// that any /api/init back-fill is already reflected.
//
// Concurrency model:
//   1. Wait ADMIN_NOTIFY_DELAY_MS — gives the in-flight /api/init enough
//      time to back-fill utm_source / referredBy on the row.
//   2. Atomically claim the notification slot via UPDATE ... WHERE
//      admin_notified_at IS NULL — Postgres guarantees only ONE caller
//      gets count=1, every other concurrent caller gets count=0 and exits.
//   3. The winner re-reads the user (now with backfilled source) and sends
//      a single, correctly-attributed message to admins.
export function notifyNewUser(
  telegramId: number,
  _username?: string,
  _firstName?: string,
  _referredBy?: number,
  _source?: string | null,
): void {
  setTimeout(() => {
    void sendNewUserNotification(telegramId);
  }, ADMIN_NOTIFY_DELAY_MS);
}

async function sendNewUserNotification(telegramId: number): Promise<void> {
  try {
    // Atomic claim: at most one parallel call will see count=1.
    const claim = await prisma.user.updateMany({
      where: { telegramId: BigInt(telegramId), adminNotifiedAt: null },
      data: { adminNotifiedAt: new Date() },
    });
    if (claim.count === 0) return; // Already notified by a sibling call.

    const fresh = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
      select: {
        username: true,
        firstName: true,
        utmSource: true,
        referredBy: true,
      },
    });
    if (!fresh) return;

    const name = fresh.firstName || "Unknown";
    const uname = fresh.username ? ` @${fresh.username}` : name;
    const referredBy = fresh.referredBy ? Number(fresh.referredBy) : null;
    const source = fresh.utmSource || null;

    let sourceLine: string;
    if (referredBy && source) {
      sourceLine = 
        `Source: <b>#partnership</b>\n` +
        `Partner: <b>${source}</b> | <b>${referredBy}</b>`;
    } else if (referredBy) {
      sourceLine = 
        `Source: <b>#referral</b>\n` +
        `Referred by: <b>${referredBy}</b>`;
    } else if (source) {
      sourceLine = 
        `Source: <b>#${source}</b>`;
    } else {
      sourceLine = 
        `Source: <b>#organic</b>`;
    }

    notifyAdmins(
      `💎 User <b>${uname}</b> | ID: <b>#ID${telegramId}</b>\n` +
      sourceLine
    );
  } catch (err) {
    console.error("[Notify] sendNewUserNotification error:", err);
  }
}

export function notifyReferralBonus(referrerTelegramId: number, referrerUsername: string | undefined, bonus: number, fromTelegramId: number): void {
  const uname = referrerUsername ? ` (@${referrerUsername})` : "";
  // notifyAdmins(
  //   `🎁 <b>Referral bonus paid</b>\n\n` +
  //   `<b>Referrer:</b> ${referrerTelegramId}${uname}\n` +
  //   `<b>Bonus:</b> +$${bonus.toFixed(2)}\n` +
  //   `<b>From user:</b> <code>${fromTelegramId}</code>`
  // );
}

const METHOD_LABELS: Record<string, string> = {
  ton: "TON",
  stars: "Telegram Stars",
  cryptobot: "Crypto Bot",
  nowpayments: "Other Crypto (NowPayments)",
  crypto: "Other Crypto (NowPayments)",
};

export function notifyDeposit(
  telegramId: number,
  username: string | undefined,
  amount: number,
  newBalance: number,
  method?: string,
): void {
  const uname = username ? ` (@${username})` : "";
  const methodLine = method
    ? `${METHOD_LABELS[method] || method}`
    : "";
  notifyAdmins(
    `💵 <b>${amount.toFixed(2)}</b>\n` +
    `Method: <b>${methodLine}</b>\n` +
    `New balance: <b>${newBalance.toFixed(2)}</b>\n` +
    `User: <b>${uname}</b> | ID: <b>#ID${telegramId}</b>\n`
  );
}

export function notifyProcessDone(
  telegramId: number,
  appName: string,
  summary: string,
  kind: "build" | "update" | "fix",
  lang: Lang = "en",
): void {
  const emoji = kind === "build" ? "🚀" : kind === "fix" ? "🔧" : "✅";
  const labelKey = kind === "build" ? "notify_build_done" : kind === "fix" ? "notify_fix_done" : "notify_update_done";
  const label = t(lang, labelKey);
  const miniAppUrl = `${config.baseUrl}/telegram-mini-app`;

  const text = `${emoji} <b>${label}</b>\n\n` +
    `<b>${appName}</b>\n` +
    `${summary.substring(0, 300)}`;

  sendTelegram(String(telegramId), text, {
    reply_markup: {
      inline_keyboard: [[{
        text: `${t(lang, "notify_view_details")}`,
        web_app: { url: miniAppUrl },
        style: "success",
      }]],
    },
  });
}
