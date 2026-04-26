KIND = Text Bot (no Mini App, backend-only).

This project is a TELEGRAM BOT, not an app or a game. There is NO Mini App, NO frontend, NO `frontend/` folder, NO `index.html`. All UX is delivered through the Telegram Bot API: messages, reply keyboards, inline buttons, slash commands. The user interacts with the bot in their normal Telegram chat — never in a WebApp viewport.

The bot token is ALREADY linked at the moment you start planning (the user created the bot in BotFather before triggering the build), so `db.botToken` and `db.botUsername` are non-empty from turn 1. Use them.

## Hard rules

- BUILD only `backend/routes.js`. Do NOT create `frontend/index.html`, `frontend/app.js`, `frontend/styles.css`, or any HTML/CSS file. If you find yourself writing `<html>` you have misunderstood the project.
- `routes.js` MUST export `router.post("/bot-webhook", async (req, res) => { ... })` — exact path string, no variants. The platform forwards every Telegram `update` to this route. See the bot-management skill for the full webhook contract.
- `/start` is the entry point. Always answer it with a welcome message and the initial keyboard for the user's first state.
- `configure_bot(name, description, shortDescription, menuButtonText)` — pass `menuButtonText: ""` (empty string) and DO NOT set `menuButtonUrl`. Text bots have no Mini App, so the chat menu button must stay on Telegram's default ("Menu" / commands list). The platform clears any stale menu button automatically when `kind === "textBot"`, but you should also pass `""` explicitly so the intent is in the prompt and the agent log.
- `set_bot_commands({ commands: [...] })` for the slash-command menu (`/start`, `/help`, plus whatever the bot does). Always include `/start` and `/help`.
- Use `db.botToken` to call Telegram Bot API (`https://api.telegram.org/bot${db.botToken}/sendMessage` etc.) directly with `fetch`. Do NOT install a bot library — fetch is enough and it keeps the bundle tiny.

## Forbidden

- ANY frontend file. ANY reference to `Telegram.WebApp`. ANY HTML / CSS.
- Calling `setWebhook` / `deleteWebhook` from inside the project (the platform owns the webhook URL — see bot-management skill).
- Setting a Mini App menu button (`setChatMenuButton` with `type: "web_app"`).
- Importing `express` directly. The project receives `router` and `db` and `fetch` from the platform — use them.
- Using `setMyCommands` to list commands that you don't actually handle in `/bot-webhook`. Every command in the menu MUST have a handler.
- Using `process.env` for API keys, bot tokens, model keys, or any configuration. Use `db.botToken` for Telegram and `ask_user` for user-provided external credentials.

## State persistence — CRITICAL

**The `db` object and the `routes.js` module are recreated from scratch on every webhook call.** Direct property assignments like `db.userState = {}` or `db.anything = value` are lost immediately after the request ends. The ONLY persistence layer is `db.get(key)` / `db.set(key, value)`, which write to SQLite on disk.

### ✅ CORRECT — use db.get / db.set for user state

```js
function getOrCreateUserState(uid, lang) {
  const state = db.get("state:" + uid);
  if (state) return state;
  const fresh = { step: "idle", lang: (lang || "en").startsWith("ru") ? "ru" : "en" };
  db.set("state:" + uid, fresh);
  return fresh;
}

function saveState(uid, state) {
  db.set("state:" + uid, state);
}
```

Usage — always call `saveState` after mutating state:

```js
const uid = String(msg.from.id);
const state = getOrCreateUserState(uid, msg.from.language_code);

// mutate, then ALWAYS persist:
state.step = "setup_name";
saveState(uid, state);
```

### ❌ WRONG — never store state as a direct db property

```js
// This is wiped after every request — NEVER do this:
db.userState ??= {};
db.userState[uid] = { step: "idle" };

// Also wrong:
db.products ??= [];
db.cart = [];
```

### Collections (global, not user-keyed)

For global data (catalogs, broadcast lists, etc.) use named keys through `db.get`/`db.set`:

```js
// Read:
const products = db.get("products") || [];

// Write:
const products = db.get("products") || [];
products.push(newItem);
db.set("products", products);
```

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

Then call `set_bot_commands({ commands: [...] })` with the full command list.

## Messaging rules

- HTML parse mode (`parse_mode: "HTML"`) for all messages. Escape user-provided text with a small helper:
  ```js
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  ```
- Keep messages under 4096 chars (Telegram's hard limit). Split if needed.
- For lists with > 10 items, paginate with inline buttons.
- Never send more than one message per user action — squash into one `editMessageText` if you're updating an existing card.

## Mandatory skills

Load BOTH skills before writing any code:

1. `load_skill("textbot")` — state persistence rules, multi-step conversation scaffold, deduplication. **This is the most important skill for Text Bots.** The db persistence model is non-obvious and getting it wrong means all user state resets on every message.
2. `load_skill("bot-management")` — `/bot-webhook` contract, payment handling, deep links, platform's pre-emptive `/start` behaviour.

## Aesthetic / tone

- Match the user's `language_code` (`msg.from.language_code`) for replies. Default to English.
- Short sentences. No marketing fluff. Telegram users skim.
- Emojis are OK for visual structure (📦 / ✅ / ❌) but never decorate every line.
