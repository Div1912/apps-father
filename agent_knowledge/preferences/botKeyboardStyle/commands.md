KEYBOARD STYLE = Slash commands only.

- NO reply keyboards. NO inline buttons. Pure CLI-style: every action is a slash command.
- Register the full command list with `setMyCommands` so they appear in Telegram's `/` menu and as autocomplete suggestions.
- Commands MAY take arguments separated by spaces: `/buy 42`, `/transfer @alice 100`, `/remind 30m make tea`.
- Always include `/start` and `/help`. `/help` lists every other command with one-line descriptions.

Skeleton:

```js
async function configureCommands() {
  await tg("setMyCommands", {
    commands: [
      { command: "start",   description: "Start using the bot" },
      { command: "help",    description: "Show all commands" },
      { command: "balance", description: "Show your balance" },
      { command: "buy",     description: "Buy item: /buy <id>" },
    ],
  });
}

async function handleMessage(msg) {
  const text = (msg.text || "").trim();
  if (!text.startsWith("/")) {
    return tg("sendMessage", { chat_id: msg.chat.id, text: "Send /help to see what I can do." });
  }
  const [head, ...args] = text.split(/\s+/);
  const cmd = head.split("@")[0].slice(1).toLowerCase(); // /buy@my_bot → "buy"
  switch (cmd) {
    case "start":   return cmdStart(msg, args);
    case "help":    return cmdHelp(msg);
    case "balance": return cmdBalance(msg);
    case "buy":     return cmdBuy(msg, args);
    default:        return tg("sendMessage", { chat_id: msg.chat.id, text: "Unknown command. Try /help." });
  }
}
```

Argument parsing rule: if a command needs arguments and the user gave none, reply with the usage line — don't silently no-op. Example: `/buy` with no args → `"Usage: /buy <product_id>. See /catalog for IDs."`.

In groups, Telegram appends `@bot_username` to commands (`/buy@my_bot`). Always strip with `.split("@")[0]` before dispatching.

Call `configureCommands()` from inside `/bot-webhook` ONLY on first invocation (guard with `db.commandsConfigured ??= false; if (!db.commandsConfigured) { await configureCommands(); db.commandsConfigured = true; }`).

Forbidden:
- Sending `reply_markup` with `keyboard` or `inline_keyboard` arrays anywhere — this is the pure-commands style.
- Free-text fallback that pretends to understand natural language. Always fall back to `"Send /help"`.
- Commands not listed in `setMyCommands` — every handled command MUST be discoverable.
