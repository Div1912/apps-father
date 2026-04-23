KIND = Text Bot (no Mini App, backend-only).

This project is a TELEGRAM BOT, not an app or a game. There is NO Mini App, NO frontend, NO `mini_app/` folder, NO `index.html`. All UX is delivered through the Telegram Bot API: messages, reply keyboards, inline buttons, slash commands. The user interacts with the bot in their normal Telegram chat — never in a WebApp viewport.

The bot token is ALREADY linked at the moment you start planning (the user created the bot in BotFather before triggering the build), so `db.botToken` and `db.botUsername` are non-empty from turn 1. Use them.

## Hard rules

- BUILD only `backend/routes.js`. Do NOT create `mini_app/index.html`, `mini_app/app.js`, `mini_app/styles.css`, or any HTML/CSS file. If you find yourself writing `<html>` you have misunderstood the project.
- `routes.js` MUST export `router.post("/bot-webhook", async (req, res) => { ... })` — exact path string, no variants. The platform forwards every Telegram `update` to this route. See the bot-management skill for the full webhook contract.
- `/start` is the entry point. Always answer it with a welcome message and the initial keyboard for the user's first state.
- `configure_bot(name, description, shortDescription, menuButtonText)` — pass `menuButtonText: ""` (empty string) and DO NOT set `menuButtonUrl`. Text bots have no Mini App, so the chat menu button must stay on Telegram's default ("Menu" / commands list). The platform clears any stale menu button automatically when `kind === "textBot"`, but you should also pass `""` explicitly so the intent is in the prompt and the agent log.
- `setMyCommands` via `telegram_api` for the slash-command menu (`/start`, `/help`, plus whatever the bot does). Always include `/start` and `/help`.
- Use `db.botToken` to call Telegram Bot API (`https://api.telegram.org/bot${db.botToken}/sendMessage` etc.) directly with `fetch`. Do NOT install a bot library — fetch is enough and it keeps the bundle tiny.

## Forbidden

- ANY frontend file. ANY reference to `Telegram.WebApp`. ANY HTML / CSS.
- Calling `setWebhook` / `deleteWebhook` from inside the project (the platform owns the webhook URL — see bot-management skill).
- Setting a Mini App menu button (`setChatMenuButton` with `type: "web_app"`).
- Importing `express` directly. The project receives `router` and `db` and `fetch` from the platform — use them.
- Using `setMyCommands` to list commands that you don't actually handle in `/bot-webhook`. Every command in the menu MUST have a handler.

## State persistence

User state lives in `db.userState`, a JSON object keyed by Telegram user ID. The platform persists `db` automatically between requests.

```js
const uid = update.message?.from?.id || update.callback_query?.from?.id;
db.userState ??= {};
db.userState[uid] ??= { step: "idle", language: update.message?.from?.language_code || "en" };
const state = db.userState[uid];
// ... read/write state.step, state.cart, etc. ...
```

For collections that aren't user-keyed (a global product catalog, scheduled broadcasts, etc.), use top-level `db` keys: `db.products`, `db.broadcasts`. Initialise with `db.products ??= [...]`.

## Webhook handler shape

```js
router.post("/bot-webhook", async (req, res) => {
  res.json({ ok: true }); // ALWAYS respond 200 immediately so Telegram doesn't retry
  try {
    const update = req.body;
    if (update.message) await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    console.error("[bot] handler error", err);
  }
});
```

Always respond `200 OK` first, then process. Throwing INSIDE the handler is fine (the response is already sent), but you'd lose the update — so wrap in try/catch and log.

## Telegram API helper

Use a single shared helper at the top of `routes.js`:

```js
async function tg(method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${db.botToken}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const json = await r.json();
  if (!json.ok) console.error(`[tg] ${method} failed`, json);
  return json;
}
```

Then:

```js
await tg("sendMessage", { chat_id, text, parse_mode: "HTML", reply_markup });
await tg("answerCallbackQuery", { callback_query_id });
await tg("editMessageText", { chat_id, message_id, text, reply_markup });
```

## /start handler

```js
async function handleMessage(msg) {
  const text = msg.text || "";
  const chatId = msg.chat.id;
  if (text === "/start" || text.startsWith("/start ")) {
    const param = text.split(" ")[1] || null; // deep-link payload
    return sendWelcome(chatId, msg.from, param);
  }
  // ... other commands / state-driven handlers ...
}
```

Always handle the deep-link parameter even if the bot doesn't use one yet — log it so future referral tracking is easy to add.

## /help handler

`/help` MUST exist. List the bot's commands and a short description of each. Keep it short (under 1500 chars).

## Configuration on first build

In step 8 of the workflow, call:

```
configure_bot({
  name: "Pizza Order Bot",                                  // user-facing display name
  description: "Order pizza in two taps. Cash, card, Stars.", // shown in profile
  shortDescription: "Pizza in two taps.",                    // shown in shared link previews
  menuButtonText: ""                                          // explicit clear; platform also enforces
})
```

Then call `telegram_api("setMyCommands", { commands: [...] })` with the full command list.

## Messaging rules

- HTML parse mode (`parse_mode: "HTML"`) for all messages. Escape user-provided text with a small helper:
  ```js
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  ```
- Keep messages under 4096 chars (Telegram's hard limit). Split if needed.
- For lists with > 10 items, paginate with inline buttons.
- Never send more than one message per user action — squash into one `editMessageText` if you're updating an existing card.

## Mandatory skill

Read `agent_knowledge/skills/bot-management.md` BEFORE writing the webhook. It documents the exact `/bot-webhook` contract, payment handling, deep links, and the platform's pre-emptive `/start` behaviour. The Text Bot workflow extends that skill, it does not replace it.

## Aesthetic / tone

- Match the user's `language_code` (`msg.from.language_code`) for replies. Default to English.
- Short sentences. No marketing fluff. Telegram users skim.
- Emojis are OK for visual structure (📦 / ✅ / ❌) but never decorate every line.
