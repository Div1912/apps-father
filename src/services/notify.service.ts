import { config } from "../config";
import { t, Lang } from "../bot/i18n";
import { prisma } from "../db";

const ADMIN_IDS = ["8784357184", "8796958409"];

// "New user" admin notification timing — TWO-PHASE.
//
// Hard problem: a user row may be created by ANY Mini App API call. Slow
// Android Telegram WebViews routinely take 15-40 s before /api/init
// finishes (SDK boot + cold-cache JS download + initData parsing), which
// is when start_param attribution back-fills onto the row. If we notify
// admins after a flat 3-10 s, we lock in "Source: #organic" forever —
// the back-fill arrives a few seconds later but the message is already
// out and cannot be edited.
//
// Fix:
//   • At INITIAL (T+10s) check the row. If utm_source / referredBy is
//     already there, claim the slot and send with the correct source.
//   • If still missing at T+10s, do NOT send yet. Schedule a second
//     check at T+60s. This gives the slow Android boot a full minute to
//     land /api/init and back-fill the column.
//   • At FALLBACK (T+60s), claim and send whatever the row has — even
//     if it's organic. Caps notification latency at 60 s, which is fine
//     for an admin alert.
//
// All concurrent notifyNewUser() calls (race-loser back-fills, parallel
// API endpoints, etc.) share a single Postgres-atomic claim slot
// (admin_notified_at IS NULL → set), so however many timers fire across
// these phases, only ONE caller actually sends.
const ADMIN_NOTIFY_INITIAL_DELAY_MS = 10_000;
const ADMIN_NOTIFY_FALLBACK_DELAY_MS = 60_000;

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

// Fire the "new user" admin notification at most ONCE per Telegram user.
// The two-phase timing (see constants above) guarantees we wait for slow
// Android Telegram clients to back-fill utm_source / referredBy before
// we lock in "#organic". The hint args are unused — the actual content
// is built from the freshest DB row at send time.
export function notifyNewUser(
  telegramId: number,
  _username?: string,
  _firstName?: string,
  _referredBy?: number,
  _source?: string | null,
): void {
  setTimeout(() => {
    void trySendNewUserNotification(telegramId, /* isFinal */ false);
  }, ADMIN_NOTIFY_INITIAL_DELAY_MS);
}

async function trySendNewUserNotification(
  telegramId: number,
  isFinal: boolean,
): Promise<void> {
  try {
    // Read current state WITHOUT claiming the slot yet — we only want
    // to claim once we have something worth sending.
    const fresh = await prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
      select: {
        username: true,
        firstName: true,
        utmSource: true,
        referredBy: true,
        adminNotifiedAt: true,
      },
    });
    if (!fresh) return;
    if (fresh.adminNotifiedAt) return; // Already sent by an earlier call.

    const hasAttribution = Boolean(fresh.utmSource || fresh.referredBy);

    // INITIAL pass: if attribution still hasn't landed, defer. Slow
    // Android Mini App boots routinely take 30-50 s before /api/init
    // (or any source-bearing call) commits the back-fill. Schedule a
    // single fallback check at T+60s, then accept whatever the row says.
    if (!hasAttribution && !isFinal) {
      setTimeout(
        () => void trySendNewUserNotification(telegramId, true),
        ADMIN_NOTIFY_FALLBACK_DELAY_MS - ADMIN_NOTIFY_INITIAL_DELAY_MS,
      );
      return;
    }

    // Atomic claim: only one timer (across all parallel notifyNewUser
    // calls AND the initial/fallback phases) actually sends.
    const claim = await prisma.user.updateMany({
      where: { telegramId: BigInt(telegramId), adminNotifiedAt: null },
      data: { adminNotifiedAt: new Date() },
    });
    if (claim.count === 0) return;

    const name = fresh.firstName || "Unknown";
    const uname = fresh.username ? `@${fresh.username}` : name;
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
      sourceLine = `Source: <b>#${source}</b>`;
    } else {
      sourceLine = `Source: <b>#organic</b>`;
    }

    notifyAdmins(
      `💎 User <b>${uname}</b> | ID: <b>#ID${telegramId}</b>\n` +
      sourceLine,
    );
  } catch (err) {
    console.error("[Notify] trySendNewUserNotification error:", err);
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
