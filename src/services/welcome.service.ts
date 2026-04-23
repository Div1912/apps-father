import { config } from "../config";
import { Lang, t } from "../bot/i18n";
import { getWelcomeCaption, buildMiniAppUrl } from "../bot/commands/start";

const TG_API = `https://api.telegram.org/bot${config.botToken}`;

/**
 * Send the /start welcome message via the Bot HTTP API.
 *
 * Used when a NEW user opens the Mini App directly (e.g. via
 * `t.me/apps_father_bot/app?startapp=...`) instead of issuing /start in the
 * bot. This way the user still sees the welcome card + Open App button in
 * their bot chat the very first time they show up, regardless of entry point.
 *
 * If the user has not yet allowed PM (or the chat doesn't exist yet) the
 * Telegram API will respond with 403 — we just log and move on; the Mini App
 * itself is already open in front of them.
 */
export async function sendBotWelcome(
  telegramId: number,
  lang: Lang = "en",
  startParam?: string | null,
): Promise<void> {
  const caption = getWelcomeCaption(lang);
  const photoUrl = `${config.baseUrl}/assets/bot_images/welcome.png`;
  const webAppUrl = buildMiniAppUrl(startParam);
  const replyMarkup = {
    inline_keyboard: [[{ text: t(lang, "btn_create_app"), web_app: { url: webAppUrl }, style: "primary" }]],
  };

  try {
    const r = await fetch(`${TG_API}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramId,
        photo: photoUrl,
        caption,
        parse_mode: "HTML",
        reply_markup: replyMarkup,
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      // 403 = user hasn't started the bot yet (or blocked it). Nothing we can
      // do — they'll see the welcome the next time they /start the bot.
      if (r.status === 403) {
        console.log(`[Welcome] sendPhoto skipped for ${telegramId}: ${txt}`);
        return;
      }
      // Any other failure (bad URL, invalid photo dims, wrong content-type,
      // chat_not_found backed by retry, etc.) → fall back to a plain
      // sendMessage so the user still sees the welcome card. The previous
      // "PHOTO/photo in error text" gate missed errors like
      // "failed to get HTTP URL content" and the user got no message at all.
      console.warn(`[Welcome] sendPhoto failed for ${telegramId}: ${r.status} ${txt} — falling back to text`);
      const fallback = await fetch(`${TG_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: telegramId,
          text: caption,
          parse_mode: "HTML",
          reply_markup: replyMarkup,
          link_preview_options: { is_disabled: true },
        }),
      }).catch(() => null);
      if (fallback && !fallback.ok) {
        const ftxt = await fallback.text().catch(() => "");
        console.warn(`[Welcome] sendMessage fallback failed for ${telegramId}: ${fallback.status} ${ftxt}`);
      }
    }
  } catch (err) {
    console.error(`[Welcome] Failed to send welcome to ${telegramId}:`, err);
  }
}
