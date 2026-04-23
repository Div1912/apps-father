KEYBOARD STYLE = Inline buttons.

- Use `InlineKeyboardMarkup` for actions. Buttons attached to the message itself, NOT the input area.
- Each button has `callback_data` (≤ 64 bytes). Encode the action + minimal context: `"buy:42"`, `"page:next:catalog"`, `"cancel:order:7"`.
- ALWAYS call `answerCallbackQuery` FIRST when handling a `callback_query`, even if you don't show a toast. Telegram greys the button out until you do — leaving it un-answered makes the bot feel broken.
- Prefer `editMessageText` (or `editMessageReplyMarkup`) over sending a NEW message. The point of inline is in-place updates.
- Layout: 1-3 buttons per row, max 4 rows. More than that → paginate.
- Strip the inline keyboard once the action is complete: send a final `editMessageReplyMarkup` with `reply_markup: { inline_keyboard: [] }` so the message can't be tapped again.

Skeleton:

```js
function productCard(p) {
  return {
    text: `<b>${esc(p.name)}</b>\n${esc(p.desc)}\n💰 $${p.price}`,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛒 Buy", callback_data: `buy:${p.id}` }],
        [{ text: "← Back", callback_data: "list:catalog" }],
      ],
    },
  };
}

async function handleCallback(cq) {
  await tg("answerCallbackQuery", { callback_query_id: cq.id });
  const [action, ...args] = (cq.data || "").split(":");
  const ctx = { chatId: cq.message.chat.id, messageId: cq.message.message_id, userId: cq.from.id };
  switch (action) {
    case "buy":   return doBuy(ctx, args[0]);
    case "list":  return showList(ctx, args[0]);
    case "cancel":return doCancel(ctx, args[1]);
  }
}
```

Encode-decode rule: pick ONE separator (`:`) and stick with it across the whole bot. Never mix `:` and `|` and `_` in callback_data — it makes the dispatcher brittle.

Forbidden:
- Reply keyboards (this is the pure inline style).
- `callback_data` longer than 64 bytes (Telegram silently truncates and breaks dispatch).
- Sending a new message to "update" a card. Use `editMessageText`.
