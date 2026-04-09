import { config } from "../config";

const ADMIN_IDS = ["8784357184", "8796958409"];

function sendTelegram(chatId: string, text: string): void {
  fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
  }).catch((err) => console.error("[Notify] Failed to send to", chatId, err));
}

function notifyAdmins(text: string): void {
  for (const id of ADMIN_IDS) {
    sendTelegram(id, text);
  }
}

export function notifyNewUser(telegramId: number, username?: string, firstName?: string): void {
  const name = firstName || "Unknown";
  const uname = username ? ` (@${username})` : "";
  notifyAdmins(
    `👤 <b>New user registered</b>\n\n` +
    `<b>Name:</b> ${name}${uname}\n` +
    `<b>Telegram ID:</b> <code>${telegramId}</code>`
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
