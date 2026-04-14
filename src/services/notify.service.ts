import { config } from "../config";

const ADMIN_IDS = ["8784357184", "8796958409"];

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

export function notifyNewUser(telegramId: number, username?: string, firstName?: string, referredBy?: number): void {
  const name = firstName || "Unknown";
  const uname = username ? ` (@${username})` : "";
  const source = referredBy ? `\n<b>Source:</b> Referred by <code>${referredBy}</code>` : "\n<b>Source:</b> Direct";
  notifyAdmins(
    `👤 <b>New user registered</b>\n\n` +
    `<b>Name:</b> ${name}${uname}\n` +
    `<b>Telegram ID:</b> <code>${telegramId}</code>` +
    source
  );
}

export function notifyReferralBonus(referrerTelegramId: number, referrerUsername: string | undefined, bonus: number, fromTelegramId: number): void {
  const uname = referrerUsername ? ` (@${referrerUsername})` : "";
  notifyAdmins(
    `🎁 <b>Referral bonus paid</b>\n\n` +
    `<b>Referrer:</b> ${referrerTelegramId}${uname}\n` +
    `<b>Bonus:</b> +$${bonus.toFixed(2)}\n` +
    `<b>From user:</b> <code>${fromTelegramId}</code>`
  );
}

export function notifyDeposit(telegramId: number, username: string | undefined, amount: number, newBalance: number): void {
  const uname = username ? ` (@${username})` : "";
  notifyAdmins(
    `💰 <b>New deposit confirmed</b>\n\n` +
    `<b>User:</b> ${telegramId}${uname}\n` +
    `<b>Amount:</b> +$${amount.toFixed(2)}\n` +
    `<b>New balance:</b> $${newBalance.toFixed(2)}`
  );
}

export function notifyProcessDone(
  telegramId: number,
  appName: string,
  summary: string,
  kind: "build" | "update" | "fix",
): void {
  const emoji = kind === "build" ? "🚀" : kind === "fix" ? "🔧" : "✅";
  const label = kind === "build" ? "App Created" : kind === "fix" ? "Error Fixed" : "Update Complete";
  const miniAppUrl = `${config.baseUrl}/telegram-mini-app`;

  const text = `${emoji} <b>${label}</b>\n\n` +
    `<b>${appName}</b>\n` +
    `${summary.substring(0, 300)}`;

  sendTelegram(String(telegramId), text, {
    reply_markup: {
      inline_keyboard: [[{
        text: "📱 View Details",
        web_app: { url: miniAppUrl },
      }]],
    },
  });
}
