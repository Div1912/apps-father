TELEGRAM_API USAGE:
- For initial app/bot setup (name / description / long description / menu button) ALWAYS use configure_app(...).
- Never call getWebhookInfo for verification — webhook is set up server-side. Use simulate_telegram and server_logs.
