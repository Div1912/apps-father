BOT-SIDE UPDATES (commands, /start params, callbacks, push):
- load_skill('bot-management') BEFORE writing any bot-side code.
- Use EXACT path: router.post("/bot-webhook", ...) - STRONG NAMING THIS ROUTE, only "/bot-webhook". This webhook for managing all events from Bot API user Updates. For example: /start, /other_command, Just typing text, etc (in Telegram instead)
