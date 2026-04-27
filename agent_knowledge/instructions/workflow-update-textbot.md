WORKFLOW — UPDATE TEXT BOT (Kind = textBot, backend-only)

1. READ THE PROJECT CONTEXT first. Text Bot projects only use `backend/routes.js`; there is no Mini App frontend.

2. Load relevant skills before editing if the update touches bot flow:
   - load_skill("textbot")
   - load_skill("bot-management")

3. Use targeted read_file on `backend/routes.js` only. Do NOT create or edit frontend files.

4. Plan affected state steps, DB keys, keyboard labels, callback_data values, and slash commands before editing.

5. Make changes in `backend/routes.js`.
   - Preserve `router.post("/bot-webhook", ...)`.
   - Always persist state changes with saveState/setState.
   - Every reply keyboard button must have an exact text branch.
   - Every slash command registered via set_bot_commands must be handled.

6. deploy_to_dev() to deploy your code.

7. Verify with simulate_telegram for the changed flow, then server_logs.

8. Final turn: call finish(shortSummary, summary) — ONE atomic call. Do NOT call configure_app during updates.
