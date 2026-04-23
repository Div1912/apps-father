KEYBOARD STYLE = Mixed (reply for navigation, inline for actions).

The split is rigid:

- **Reply keyboard** = top-level navigation. Always-present sections of the bot ("My Orders", "Catalog", "Profile", "Help"). Re-render on every state change.
- **Inline buttons** = per-message actions. Buttons attached to a specific message that act on a specific item ("Buy", "Cancel order", "Page → next").
- Slash commands like `/start` and `/help` exist alongside both — register them via `setMyCommands` so the `/` menu still works.

Rule of thumb: if a button means "take me to a section" → reply keyboard. If it means "do something to this item" → inline.

Skeleton:

```js
function navKeyboard() {
  return {
    keyboard: [
      [{ text: "🛒 Catalog" }, { text: "📦 My Orders" }],
      [{ text: "👤 Profile" }, { text: "ℹ️ Help" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

async function handleMessage(msg) {
  const text = msg.text || "";
  if (text === "/start") return sendWelcome(msg);
  if (text === "🛒 Catalog") return showCatalog(msg);
  if (text === "📦 My Orders") return showOrders(msg);
  if (text === "👤 Profile") return showProfile(msg);
  // ... etc
}

async function showCatalog(msg) {
  for (const p of db.products) {
    await tg("sendMessage", {
      chat_id: msg.chat.id,
      text: `<b>${esc(p.name)}</b>\n$${p.price}`,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "🛒 Buy", callback_data: `buy:${p.id}` }]] },
    });
  }
}
```

When sending a message that has BOTH a navigation context AND inline actions, send the inline buttons attached to the action message and let the persistent reply keyboard stay where it is — don't re-render the reply keyboard for every list item, that's spammy.

`answerCallbackQuery` rule from the inline style still applies: always answer first. `editMessageText` rule still applies: update in place where possible.

Forbidden:
- Putting navigation actions ("Catalog", "Settings") inside inline buttons. Those belong on the reply keyboard.
- Putting per-item actions ("Buy this", "Delete this") on the reply keyboard. Those belong inline.
- Hiding the reply keyboard mid-flow. Once the user has the navigation bar, it stays visible.
