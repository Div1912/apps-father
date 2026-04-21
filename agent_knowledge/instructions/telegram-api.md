TELEGRAM_API USAGE:
- For initial bot setup (description / short description / menu button) ALWAYS use configure_bot(...) — never call telegram_api for those.
- Never use setMyCommands — it clutters the bot menu and is unwanted.
- Never call telegram_api with getWebhookInfo for verification — webhook is set up server-side.