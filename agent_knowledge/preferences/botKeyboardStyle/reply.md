KEYBOARD STYLE = Reply keyboard.

- Use `ReplyKeyboardMarkup` for navigation. Buttons appear under the input field, replacing the keyboard.
- Always include `resize_keyboard: true`. Often pair with `is_persistent: true` so it doesn't auto-collapse.
- Layout buttons in rows of 2-3. Single-button rows are fine for primary actions.
- Re-render the keyboard on EVERY state change. The user sees the keyboard for the state they're in, never a stale one.
- Match button taps in `handleMessage`: switch on `msg.text` literal (e.g. `case "📦 My Orders": ...`). Include the emoji in the button label and the case-string so they match exactly.
- To remove the keyboard temporarily (e.g. when waiting for free-text input): send a message with `reply_markup: { remove_keyboard: true }`.
- NO inline buttons in this style — keep things consistent. Inline is reserved for pure information messages where the keyboard would be wrong (rare).

Skeleton:

```js
function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: "📦 My Orders" }, { text: "🛒 New Order" }],
      [{ text: "💰 Balance" }, { text: "ℹ️ Help" }],
    ],
    resize_keyboard: true,
    is_persistent: true,
  };
}

await tg("sendMessage", {
  chat_id: chatId,
  text: "What would you like to do?",
  reply_markup: mainMenuKeyboard(),
});
```

Forbidden:
- Mixing reply and inline keyboards in the same flow (pick one — this is the reply-keyboard style).
- More than 8 visible buttons at once.
- Long button labels (> ~24 chars). They wrap and look broken on narrow screens.
