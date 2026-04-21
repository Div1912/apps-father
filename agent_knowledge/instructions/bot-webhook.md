Each project should have a required route: /bot-webhook. This endpoint using for get Bot updates, like Message, SuccessPurchase, etc. Implement this route for first simple command /start. Make a custom welcome message with button to open a WebApp

✅ ALWAYS write EXACTLY:
   router.post("/bot-webhook", async (req, res) => {
     res.json({ ok: true });   // respond 200 BEFORE any work — Telegram retries on slow responses
     try { /* handle update */ } catch (err) { console.error("[bot-webhook]", err); }
   });

If you need bot-side other behavior (commands, /command <param>, callbacks, push) →
load_skill('bot-management') and copy the canonical template VERBATIM. Do NOT
invent your own path naming.