# Text Bot Skill — Complete Reference

## How the runtime works (read first)

On every incoming Telegram update, the platform:
1. Creates a **brand-new SQLite-backed `db` object**
2. Does `delete require.cache[routesFile]` then `require(routesFile)` — the **module is reloaded from disk**
3. Calls `routeModule(router, db, projectId)`, dispatches the request, then calls `db.close()`

**Consequence:** Any value stored as a direct property on `db` (e.g. `db.userState`, `db.cart`) or in a module-level variable is discarded after every request. The only persistence is `db.get(key)` / `db.set(key, value)`, which write to a SQLite key-value store on disk.

---

## State machine — the right way

### Helper functions (put at the top of routes.js)

```js
// Returns the persisted state object for this user, or creates a fresh one.
// Always call saveState() after mutating it.
function getOrCreateState(uid, lang) {
  const saved = db.get("state:" + uid);
  if (saved) return saved;
  const fresh = { step: "idle", lang: (lang || "en").startsWith("ru") ? "ru" : "en" };
  db.set("state:" + uid, fresh);
  return fresh;
}

function saveState(uid, state) {
  db.set("state:" + uid, state);
}
```

### Usage in handleMessage

```js
async function handleMessage(msg) {
  const uid   = String(msg.from.id);
  const chatId = msg.chat.id;
  const text  = (msg.text || "").trim();
  const state = getOrCreateState(uid, msg.from.language_code);

  if (text === "/start") {
    state.step = "setup_name";
    saveState(uid, state);                          // ← persist before returning
    await tg("sendMessage", { chat_id: chatId, text: "What is your name?" });
    return;
  }

  if (state.step === "setup_name") {
    db.set("profile:" + uid, { name: text });
    state.step = "menu";
    saveState(uid, state);                          // ← persist
    await tg("sendMessage", { chat_id: chatId, text: `Hello, ${text}!` });
    return;
  }

  // fallthrough
  await tg("sendMessage", { chat_id: chatId, text: "Use /start to begin." });
}
```

### Rule: mutate → saveState → respond

Every code path that changes `state.step` or any field on `state` **must** call `saveState(uid, state)` before returning. Missing a `saveState` call is the most common bug in Text Bots: the step appears to reset on the next message.

---

## Profile / user data

Store user profiles under `"profile:{uid}"` keys, separate from the state machine:

```js
function getProfile(uid) {
  return db.get("profile:" + uid) || null;
}

function setProfile(uid, data) {
  db.set("profile:" + uid, data);
}
```

Read-modify-write pattern (always re-read, mutate in-memory, then set):

```js
const profile = getProfile(uid) || {};
profile.name = text.slice(0, 60);
setProfile(uid, profile);
```

**Never** accumulate profiles in a single `db.get("all_profiles")` array — it degrades at scale.  
Use `db.keys().filter(k => k.startsWith("profile:"))` to iterate when needed.

---

## Collections

```js
// Add an item to a collection
const items = db.get("items") || [];
items.push({ id: Date.now(), text: "foo" });
db.set("items", items);

// Remove from a collection
let items = db.get("items") || [];
items = items.filter(i => i.id !== targetId);
db.set("items", items);
```

For collections that grow large (100+ entries), use per-record keys instead:

```js
// Write
db.set("item:" + id, { id, text, createdAt });
// Keep a small index
const idx = db.get("item_index") || [];
idx.push(id);
db.set("item_index", idx);

// Read all
const idx = db.get("item_index") || [];
const items = idx.map(id => db.get("item:" + id)).filter(Boolean);
```

---

## Multi-step conversation scaffold

```js
async function handleSetup(msg, uid, state) {
  const chatId = msg.chat.id;
  const text   = (msg.text || "").trim();

  switch (state.step) {
    case "setup_name": {
      if (!text) {
        await tg("sendMessage", { chat_id: chatId, text: "Please enter your name." });
        return;
      }
      const profile = getProfile(uid) || {};
      profile.name = text.slice(0, 60);
      setProfile(uid, profile);
      state.step = "setup_age";
      saveState(uid, state);                        // ← always persist after step change
      await tg("sendMessage", { chat_id: chatId, text: "How old are you?", reply_markup: { remove_keyboard: true } });
      return;
    }

    case "setup_age": {
      const age = parseInt(text, 10);
      if (!age || age < 13 || age > 120) {
        await tg("sendMessage", { chat_id: chatId, text: "Enter a valid age (13-120)." });
        return;                                      // ← no saveState needed: step didn't change
      }
      const profile = getProfile(uid) || {};
      profile.age = age;
      setProfile(uid, profile);
      state.step = "menu";
      saveState(uid, state);
      await tg("sendMessage", { chat_id: chatId, text: "Profile complete!", reply_markup: mainMenuKeyboard() });
      return;
    }
  }
}
```

---

## Module structure — CRITICAL, read before writing ANY code

The **entire routes.js** must follow this skeleton exactly. Pay close attention to how `router.post(...)` is closed — a missing `)` produces the runtime error `"missing ) after argument list"` and breaks all bot functionality.

```js
"use strict";

module.exports = function(router, db, projectId) {

  // ── helpers and handler functions defined here ──────────────────────────────

  async function tg(method, body) { /* ... */ }
  function getState(uid) { return db.get("state:" + uid) || null; }
  function setState(uid, s) { db.set("state:" + uid, s); }
  // ... more helpers ...

  async function handleMessage(msg) {
    // ... message handling ...
  }

  async function handleCallback(cq) {
    // ... callback_query handling ...
    // ALWAYS declare `state` at the top of handleCallback or inside each if-block:
    //   const state = getState(uid) || { step: "menu" };
    // NEVER use `state` without declaring it first in the current scope.
  }

  // ── webhook route ─────────────────────────────────────────────────────────
  router.post("/bot-webhook", async (req, res) => {
    res.json({ ok: true });
    try {
      const update = req.body || {};
      if (update.update_id != null) {
        if (db.get("seen:" + update.update_id)) return;
        db.set("seen:" + update.update_id, 1);
      }
      if (update.message)              await handleMessage(update.message);
      else if (update.callback_query)  await handleCallback(update.callback_query);
    } catch (err) {
      console.error("[bot-webhook] error:", err);
    }
  });              // ← REQUIRED: } closes arrow function body,
                  //              ) closes router.post( argument list,
                  //              ; ends the statement.
                  // NEVER write just `}` or `};` here — the `)` is MANDATORY.

};  // ← closes module.exports = function(...) {
```

### Checklist before finishing routes.js

- [ ] `router.post("/bot-webhook", ...)` ends with `});` (three characters: `}`, `)`, `;`)
- [ ] `module.exports = function(...)` ends with `};`
- [ ] Every `if`/`else` block in `handleCallback` that uses `state` has declared `const state = getState(uid) || { step: "menu" };` first
- [ ] No `state` variable is used without being declared in the current scope

---

## Sending photos — `caption` not `text`

`sendMessage` uses `text`. `sendPhoto` uses `caption`. **They are different fields.**

```js
// ✅ send a text message
await tg("sendMessage", {
  chat_id,
  text: "<b>Hello</b>",
  parse_mode: "HTML",
  reply_markup,
});

// ✅ send a photo message — use caption, NOT text
await tg("sendPhoto", {
  chat_id,
  photo: fileId,
  caption: "<b>My profile</b>",   // ← caption, NOT text
  parse_mode: "HTML",
  reply_markup,
});
```

**Never spread a `{text, reply_markup}` object into `sendPhoto`** — the `text` field is silently ignored and the photo sends with no caption:

```js
// ❌ WRONG — profileCard() returns { text, reply_markup }, but sendPhoto ignores `text`
await tg("sendPhoto", { chat_id, photo, ...profileCard(p) });

// ✅ CORRECT — explicitly use caption
await tg("sendPhoto", {
  chat_id,
  photo,
  caption: profileCard(p).text,       // rename to caption
  parse_mode: "HTML",
  reply_markup: profileCard(p).reply_markup,
});
```

### Editing messages with photos

`editMessageText` edits the TEXT of a text message. It **cannot** add a photo or change a photo message. For profiles with photos, use a fresh `sendMessage`/`sendPhoto` instead of trying to edit:

```js
// ❌ WRONG — editMessageText cannot change a photo or add one
await tg("editMessageText", { chat_id, message_id, photo: fileId, text: "..." });

// ✅ For photo profiles in browsing flows: send a new message
if (p.photo) {
  await tg("sendPhoto", { chat_id, photo: p.photo, caption: buildCaption(p), parse_mode: "HTML", reply_markup: profileKeyboard(p.uid) });
} else {
  await tg("sendMessage", { chat_id, text: buildCaption(p), parse_mode: "HTML", reply_markup: profileKeyboard(p.uid) });
}
```

---

## Deduplication

Telegram can deliver the same update_id more than once if your server is slow.
Always deduplicate:

```js
router.post("/bot-webhook", async (req, res) => {
  res.json({ ok: true });
  try {
    const update = req.body || {};
    if (update.update_id != null) {
      const seen = db.get("seen:" + update.update_id);
      if (seen) return;
      db.set("seen:" + update.update_id, 1);
    }
    if (update.message)         await handleMessage(update.message);
    else if (update.callback_query) await handleCallback(update.callback_query);
  } catch (err) {
    console.error("[bot-webhook] error:", err);
  }
});
```

Clean up old seen-keys periodically to avoid unbounded growth (keep last 1000):

```js
// After writing a new seen key, trim old ones:
const seenKeys = db.keys().filter(k => k.startsWith("seen:")).sort();
if (seenKeys.length > 1000) {
  seenKeys.slice(0, seenKeys.length - 1000).forEach(k => db.delete(k));
}
```

---

## Forbidden patterns

```js
// ❌ direct property — wiped on every request
db.userState ??= {};
db.userState[uid] = { step: "idle" };

// ❌ module-level variable — also reset on every request (module is reloaded)
let sessionMap = {};
sessionMap[uid] = { step: "idle" };

// ✅ correct
const state = getOrCreateState(uid, lang);
state.step = "menu";
saveState(uid, state);
```

---

## Quick Telegram API reference

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

// Common calls:
await tg("sendMessage", { chat_id, text, parse_mode: "HTML", reply_markup });
await tg("answerCallbackQuery", { callback_query_id: cq.id });
await tg("editMessageText", { chat_id, message_id, text, reply_markup });
await tg("editMessageReplyMarkup", { chat_id, message_id, reply_markup: { inline_keyboard: [] } });
await tg("sendPhoto", { chat_id, photo: fileId, caption, parse_mode: "HTML", reply_markup });
```

Reply keyboard:
```js
{ keyboard: [[{ text: "Option A" }, { text: "Option B" }]], resize_keyboard: true }
```

Inline keyboard:
```js
{ inline_keyboard: [[{ text: "Like ❤️", callback_data: "like:123" }, { text: "Skip ⏭", callback_data: "skip:123" }]] }
```

Remove keyboard:
```js
{ remove_keyboard: true }
```

---

## HTML escaping

Always escape user-provided text before embedding in HTML messages:

```js
const esc = (s) => String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
```

---

## Stripping emojis from user input — CRITICAL

**NEVER use `/\p{Emoji}/gu` to strip emojis.** In Unicode, the `Emoji` property includes digit characters **0–9** (they can form emoji like 2️⃣). This regex silently deletes all digits from user input:

```js
// ❌ WRONG — strips digits too, "26" becomes ""
const text = rawText.replace(/\p{Emoji}/gu, "").trim();
parseInt("", 10); // → NaN → any numeric validation fails
```

**Use `\p{Emoji_Presentation}` instead** — it only matches characters that are *rendered as emoji by default* (😀, 🔥, etc.) and does NOT match plain digits:

```js
// ✅ CORRECT
const text = rawText.replace(/\p{Emoji_Presentation}/gu, "").trim();
parseInt("26", 10); // → 26 ✓
```

For steps that expect a number (age, quantity, amount), skip emoji stripping entirely — there's no reason for it:

```js
// ✅ Even simpler for numeric inputs
case "ask_age": {
  const text = (msg.text || "").trim();
  const age = parseInt(text, 10);
  if (!age || age < 18 || age > 99) { ... }
  ...
}
```
