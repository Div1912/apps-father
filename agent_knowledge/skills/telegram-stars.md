TELEGRAM STARS PAYMENTS:
1. Store pending purchases: db.set('pending_' + invoiceId, { userId, stars, coins })
2. Backend creates invoice via: fetch('https://api.telegram.org/bot' + db.botToken + '/createInvoiceLink', ...)
3. Frontend opens: Telegram.WebApp.openInvoice(url, function(status) { if(status==='paid') refreshUser(); })
4. Bot auto-handles pre_checkout_query and successful_payment — no webhook endpoint needed
5. Use currency "XTR", empty provider_token ""
