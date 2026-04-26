TELEGRAM_API USAGE:
- For initial bot setup (name / description / short description / menu button) ALWAYS use configure_bot(...).
- For Text Bots, use set_bot_commands(...) for the slash-command menu. Every command must be handled in /bot-webhook.
- For standard Mini Apps, do not set bot commands unless the technical_plan explicitly includes bot-side command behavior.
- Never call getWebhookInfo for verification — webhook is set up server-side. Use simulate_telegram and server_logs.