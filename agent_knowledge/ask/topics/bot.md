# Bot side — outside the Mini App

Each project comes with a Telegram bot. Apps Father wires the bot
automatically. Owners can ask for:

- **Custom /commands** — `/start`, `/help`, `/balance`, anything they want.
- **Inline keyboards** under bot messages (callback buttons that trigger
  server-side logic and edit the message in place).
- **Reply keyboards** under the input field for quick choices.
- **Deep-link parameters** — `t.me/<bot>?start=invite_<code>` lets the agent
  attribute the source (referrals, campaigns, QR codes).
- **Group chat behavior** — react to bot mentions, /commands inside groups,
  new chat members.
- **Scheduled / triggered messages** — daily digests, drop-style giveaways,
  reminders.
- **Webhooks for payment success / failure**, channel post events, etc.

Text Bot projects live entirely in this layer — there is no Mini App
window, the whole product is the bot conversation.

## Bot management things owners can do themselves

- Change the bot's display name and short description (the agent edits
  them automatically when the project is renamed, or the owner can ask).
- Change the bot avatar by uploading an image in chat.
- Connect / reconnect the bot if the BotFather token changes (the platform
  guides them through it).
