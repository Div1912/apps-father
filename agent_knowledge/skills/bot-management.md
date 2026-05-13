# Bot Management Skill — Telegram Bot Commands, Webhooks & Quality

Use this skill any time the user wants to add **bot-side behavior**: custom commands, message handlers, deep-link `/start <param>`, callback buttons, push notifications, payments, command menus, mini-app launch buttons, etc.

---

## 0. THE ONE RULE THAT BREAKS EVERYTHING IF YOU GET IT WRONG

The **only** route path that the platform forwards Telegram updates to is the literal string:

```js
router.post("/bot-webhook", async (req, res) => { ... })
```

Express matches the path **literally**. The platform builds `req.path = "/bot-webhook"` and runs the project's router against it. If your route is registered at any other path, it never fires — and **no error is ever raised**, the platform just silently falls back to the default "Tap the button" reply.

❌ Forbidden — every one of these silently breaks:

| What you might be tempted to write | Why it fails |
|---|---|
| `router.post("/webhook", ...)` | legacy fallback only; do not use in new code |
| `router.post("/bot/webhook", ...)` | path mismatch — never fires |
| `router.post("/api/bot-webhook", ...)` | path mismatch — never fires |
| `router.post("/telegram-webhook", ...)` | path mismatch — never fires |
| `router.post("/tg-webhook", ...)` | path mismatch — never fires |
| `router.post("/bot_webhook", ...)` | underscore ≠ hyphen — never fires |
| `router.post("/botwebhook", ...)` | missing hyphen — never fires |
| `app.post("/bot-webhook", ...)` | wrong handle — `app` is not in scope, only `router` |

✅ Required — copy this verbatim, change nothing about the path string:

```js
router.post("/bot-webhook", async (req, res) => {
  res.json({ ok: true });
  // ... handle update ...
});
```

Before you call `done()`, grep the file:
```
shell("grep -n 'router\\.post' backend/routes.js | grep -i webhook")
```
If the only line printed is `router.post("/bot-webhook", ...` you are correct. Anything else → fix immediately.

---

## 1. Architecture you are working inside (CRITICAL — read first)

Each project has its own Telegram bot, but **the platform owns the webhook URL on Telegram**.

What this means in practice:

- A platform service (`BotRunnerService`) calls `setWebhook` on the bot's token at startup, pointing at infrastructure you do not control. It also handles `pre_checkout_query` and `successful_payment` for Telegram Stars automatically.
- For every incoming Telegram update (messages, callbacks, etc.) the platform:
  1. Runs its built-in handlers (the default `/start` reply with a "🚀 Launch App" button, plain-text fallback, payment processing).
  2. **Forwards the raw `update` JSON body** to a route called **`POST /bot-webhook`** in the project's `backend/routes.js`, if such a route exists.
- If `routes.js` exposes `POST /bot-webhook`, the **platform's default `/start` reply is suppressed** — your route now owns the bot UX.
- If there is no `/bot-webhook` route, only the default behavior runs.

### NEVER call these methods from inside the project

```
setWebhook        ❌ — platform owns the webhook URL
deleteWebhook     ❌ — would break update delivery
setUpdateHandler  ❌ — there is no such concept; you only react to forwarded updates
```

If you want updates → **define `POST /bot-webhook`** and process the body.
For app/bot name/description/menu button → use `configure_app`. This is a profile/configuration call, not a webhook call.

---

## 2. Decide which pattern you need

| The user wants… | Pattern |
|---|---|
| Just a button in the chat menu that opens the Mini App | **Pattern A** — `configure_app` only, no `/bot-webhook` |
| Custom replies to `/help`, `/balance`, `/leaderboard`, etc. directly from the bot (no Mini App round-trip) | **Pattern B** — define `/bot-webhook` |
| Custom replies to `/help`, `/balance`, `/leaderboard`, etc. directly from the bot (no Mini App round-trip) | **Pattern B** — define `/bot-webhook` |
| Read `/start <ref_code>` deep-link parameter to attribute a referral / promo | **Pattern B** — `/bot-webhook` parses `text` |
| Inline-keyboard buttons with `callback_data` (Like / Vote / Confirm) | **Pattern B** — `/bot-webhook` handles `callback_query` |
| Push a notification to a user from a backend job | **Pattern C** — direct `sendMessage` from any backend route, no webhook needed |
| Telegram Stars payment | Use **Stars pattern in `backend.md`** — platform auto-handles `pre_checkout_query` + `successful_payment` |

You can combine all of them in a single project.

---

## 3. Pattern A — Profile / menu button only

This is a one-shot configuration call. Run it via `configure_app` **on first build only**, not on updates.

```js
// During first build, in agent:

configure_app({
  name: "Tournament App",
  description: "Real-time tournaments inside Telegram.",
  longDescription: "Compete with friends in real-time tournaments. Open the app to play!",
  menuButtonText: "Play"
})
```

Notes:
- `configure_app` saves app profile metadata first, then sets the menu button atomically if a bot is linked. Text Bot projects pass `menuButtonText: ""`.
- To have the bot reply to commands like `/help`, you need Pattern B (`/bot-webhook`).

---

## 4. Pattern B — `/bot-webhook` route (the canonical full template)

Drop this directly into `backend/routes.js`. It covers messages, commands, callback queries, deep links, and is fully idempotent.

```js
// backend/routes.js — bot-webhook section

// ── Helpers ────────────────────────────────────────────────────────────────
const TG = (db) => `https://api.telegram.org/bot${db.botToken}`;

async function tg(db, method, body) {
  try {
    const r = await fetch(`${TG(db)}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!data.ok) {
      // 403 = user blocked bot. 400 = bad request. Log and swallow.
      console.error(`[bot] ${method} failed:`, data.error_code, data.description);
    }
    return data;
  } catch (err) {
    console.error(`[bot] ${method} network error:`, err.message);
    return { ok: false };
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function getOrCreateBotUser(db, from) {
  const key = "user:" + from.id;
  let u = db.get(key);
  if (!u) {
    u = {
      telegramId: from.id,
      username: from.username || "",
      firstName: from.first_name || "",
      createdAt: new Date().toISOString(),
    };
    db.set(key, u);
  }
  return u;
}

// ── Webhook entry point ────────────────────────────────────────────────────
router.post("/bot-webhook", async (req, res) => {
  // 1) ALWAYS respond 200 immediately. Telegram retries on non-200.
  res.json({ ok: true });

  try {
    const update = req.body || {};

    // 2) Idempotency: dedupe by update_id (Telegram may retry)
    if (update.update_id != null) {
      const seenKey = "bot:seen:" + update.update_id;
      if (db.get(seenKey)) return;
      db.set(seenKey, 1);
      // Optional: prune old seen keys periodically
    }

    // 3) Route by update type
    if (update.message) return handleMessage(update.message);
    if (update.callback_query) return handleCallback(update.callback_query);
    if (update.inline_query) return handleInline(update.inline_query);
  } catch (err) {
    console.error("[bot-webhook] error:", err);
  }

  // ── Handlers ─────────────────────────────────────────────────────────────
  async function handleMessage(msg) {
    if (!msg.from || msg.from.is_bot) return;
    const user = getOrCreateBotUser(db, msg.from);
    const text = (msg.text || "").trim();

    // /start [param]
    if (text.startsWith("/start")) {
      const parts = text.split(/\s+/);
      const startParam = parts[1] || null;
      if (startParam) {
        // Persist deep-link payload (referral, promo, ad campaign, etc.)
        user.startParam = startParam;
        db.set("user:" + user.telegramId, user);
      }
      return tg(db, "sendMessage", {
        chat_id: msg.chat.id,
        text:
          `<b>Welcome, ${escapeHtml(user.firstName)}!</b>\n\n` +
          `Tap the button below to open the app.`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🚀 Launch App", web_app: { url: `${env.BASE_URL}/app/${env.PROJECT_ID}/` } },
          ]],
        },
      });
    }

    // /help
    if (text === "/help" || text.startsWith("/help ")) {
      return tg(db, "sendMessage", {
        chat_id: msg.chat.id,
        text:
          `<b>How it works</b>\n\n` +
          `• /start — open the app\n` +
          `• /balance — your current balance\n` +
          `• /leaderboard — top players\n` +
          `• /help — this message`,
        parse_mode: "HTML",
      });
    }

    // /balance
    if (text === "/balance") {
      const balance = user.balance || 0;
      return tg(db, "sendMessage", {
        chat_id: msg.chat.id,
        text: `Your balance: <b>${balance}</b>`,
        parse_mode: "HTML",
      });
    }

    // Unknown text → fall back to the launch button (so user can never get stuck)
    return tg(db, "sendMessage", {
      chat_id: msg.chat.id,
      text: "Tap the button below to open the app:",
      reply_markup: {
        inline_keyboard: [[
          { text: "🚀 Launch App", web_app: { url: `${env.BASE_URL}/app/${env.PROJECT_ID}/` } },
        ]],
      },
    });
  }

  async function handleCallback(cq) {
    // ALWAYS answer the callback query — otherwise the user sees a spinner forever.
    // Pass `text` to show a toast, or omit for silent.
    await tg(db, "answerCallbackQuery", { callback_query_id: cq.id });

    const data = cq.data || "";
    if (data.startsWith("vote:")) {
      const id = data.slice(5);
      // ... do work ...
    }

    // Optionally edit the original message
    // await tg(db, "editMessageReplyMarkup", { chat_id, message_id, reply_markup: { inline_keyboard: [...] } });
  }

  async function handleInline(iq) {
    return tg(db, "answerInlineQuery", {
      inline_query_id: iq.id,
      results: [], // populate as needed
      cache_time: 0,
    });
  }
});
```

⚠️ **Always use `${env.BASE_URL}/app/${env.PROJECT_ID}/` for the `web_app.url`.**
Never use `https://t.me/${botUsername}/app` or any `t.me` link — those are bot profile links, NOT mini-app launch URLs. The correct URL is always built from `env.BASE_URL` and `env.PROJECT_ID` which are injected by the platform.

### Why `res.json({ ok: true })` BEFORE the work?

Telegram resends the same update if your webhook doesn't reply within ~60s. If you await heavy work (DB writes, multiple `sendMessage` calls) before responding, you get duplicate updates → duplicate replies. Always **respond first, work after**.

### Idempotency

The platform may forward an update more than once during a redeploy or hot-reload. The `bot:seen:<update_id>` check guarantees one logical execution per update. Without it, e.g. `/start` could register the same referral twice.

---

## 5. Pattern C — Pushing a notification (no webhook needed)

You can call `sendMessage` from any backend route to push a notification to a user whose `telegramId` you know:

```js
router.post("/notify-winner", async (req, res) => {
  try {
    const { winnerTelegramId, prize } = req.body;
    await fetch(`https://api.telegram.org/bot${db.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: winnerTelegramId,
        text: `🏆 You won <b>${escapeHtml(prize)}</b>! Open the app to claim.`,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🎁 Claim", web_app: { url: `${env.BASE_URL}/app/${env.PROJECT_ID}/` } },
          ]],
        },
      }),
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("notify error:", err);
    res.status(500).json({ error: "Failed" });
  }
});
```

You can use `web_app` buttons in inline keyboards for direct mini-app launches (Bot API ≥ 6.1, fully supported).

---

## 6. The 100% Quality Checklist (run through this before `done()`)

Whenever the project includes `/bot-webhook` or sets bot commands, **verify all of these**:

### Build-time configuration
- [ ] `configure_app` — saves name, description, long description, and menu button atomically.

### Code quality inside `/bot-webhook`
- [ ] Route is registered at the EXACT path `"/bot-webhook"` (hyphen, lowercase, no prefix). See section 0. If the path is anything else, the route silently never fires.
- [ ] Responds with `200` **before** doing async work.
- [ ] Dedupes by `update.update_id`.
- [ ] HTML-escapes any user-supplied text inserted into `parse_mode: "HTML"` messages.
- [ ] Uses `parse_mode: "HTML"` consistently (avoid mixing Markdown and HTML).
- [ ] **Always** calls `answerCallbackQuery` for every `callback_query`.
- [ ] Has a fallback handler so unknown text never leaves the user without a reply.
- [ ] Persists `/start <param>` deep-link payload to the user record.
- [ ] All `tg(...)` calls swallow `403 Forbidden: bot was blocked by the user` — never crash the route.

### Verification (do this after `deploy_to_dev`)
1. Use `simulate_telegram` to send `/start`.
2. Use `simulate_telegram` for `/help` and at least one callback button if the bot uses callbacks.
3. Use `server_logs` after simulations to confirm there are no handler errors.
4. Test deep links by simulating `/start test123` and verifying the user record now has `startParam: "test123"` if the bot tracks deep links.

If any of the above fails, fix and redeploy before calling `done()`.

---

## 7. Common pitfalls (avoid these)

| Pitfall | Why it breaks | Fix |
|---|---|---|
| Registering the route as `/webhook`, `/bot/webhook`, `/api/bot-webhook`, `/tg-webhook`, `/bot_webhook`, etc. | Express path mismatch — the platform forwards to `/bot-webhook` literally and your route never fires. No error is logged. | Use the EXACT string `"/bot-webhook"`. See section 0. |
| Calling `setWebhook` from inside the project | Overwrites the platform's webhook → bot stops receiving updates platform-wide | Never call it. The platform owns it. |
| Not answering `callback_query` | Telegram client shows a loading spinner on the button forever | Always `answerCallbackQuery` first thing |
| Awaiting heavy work before responding 200 | Telegram retries → duplicate side-effects (double-credit, double-message) | `res.json({ok:true})` immediately |
| Putting raw `${user.firstName}` into HTML text | `<` `>` `&` in usernames break parse_mode and can be exploited | Always `escapeHtml(...)` |
| `setMyCommands` includes `/start` as `start` with leading slash | Telegram returns 400 — commands must NOT include the `/` | Use `{ command: "start", ... }` |
| Hardcoding `parse_mode: "Markdown"` | Legacy mode breaks on common chars like `_`, `(`, `*` in user names | Use `parse_mode: "HTML"` everywhere |
| Same `update_id` processed twice during a redeploy | Same notification sent twice | Use the `bot:seen:<update_id>` dedupe key |
| Ignoring `data.ok === false` from `tg()` | Silent failures (user blocked bot, message_id missing, etc.) | Log; for "blocked" mark the user inactive in DB so you stop pushing them |
| Setting commands but never handling them in `/bot-webhook` | Users click commands and bot stays silent | Match every entry in `setMyCommands` to a branch in `handleMessage` |

---

## 8. Quick decision tree (copy-paste into your plan)

```
User wants bot behavior?
├── Just a launch button + commands menu, no custom replies?
│   └── Pattern A: setMyCommands + setChatMenuButton, no /bot-webhook
├── Bot must reply to commands or read /start <param>?
│   └── Pattern B: define POST /bot-webhook + setMyCommands
├── Backend needs to push messages to users?
│   └── Pattern C: fetch() to sendMessage from any route
└── After build: ALWAYS run getWebhookInfo to confirm it's healthy.
```

---

## 9. Minimum viable bot-webhook (for tiny apps)

If the user just wants `/start <ref>` attribution and nothing else, you can ship the smallest possible webhook:

```js
router.post("/bot-webhook", async (req, res) => {
  res.json({ ok: true });
  try {
    const msg = req.body?.message;
    if (!msg || !msg.from || msg.from.is_bot) return;
    const text = (msg.text || "").trim();
    if (!text.startsWith("/start")) return;
    const ref = text.split(/\s+/)[1] || null;
    const key = "user:" + msg.from.id;
    const u = db.get(key) || { telegramId: msg.from.id, createdAt: new Date().toISOString() };
    u.username = msg.from.username || u.username || "";
    u.firstName = msg.from.first_name || u.firstName || "";
    if (ref && !u.startParam) u.startParam = ref;
    db.set(key, u);

    await fetch(`https://api.telegram.org/bot${db.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: msg.chat.id,
        text: `Welcome! Tap the button below to open the app.`,
        reply_markup: {
          inline_keyboard: [[{ text: "🚀 Launch App", web_app: { url: `${env.BASE_URL}/app/${env.PROJECT_ID}/` } }]],
        },
      }),
    });
  } catch (err) {
    console.error("[bot-webhook]", err);
  }
});
```

This already passes the quality checklist for a referral-tracking bot.
