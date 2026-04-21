REFERRAL SYSTEM (when user asks for referrals/invite system):
1. Referral link format: const refLink = 'https://t.me/' + botUsername + '?start=' + userId;
2. Share via Telegram:
   const shareText = encodeURIComponent('Your share text here derived from app description');
   const shareUrl = 'https://t.me/share/url?url=' + encodeURIComponent(refLink) + '&text=' + shareText;
   Telegram.WebApp.openTelegramLink(shareUrl);
3. Two complementary tracking paths — implement BOTH for reliable attribution:
   a) Mini App path (when user clicks the share link and opens the Mini App directly):
      const startParam = Telegram.WebApp.initDataUnsafe?.start_param;
      if (startParam) apiCall('/api/{projectId}/register', { method:'POST', body: JSON.stringify({ referrerId: startParam }) });
   b) Bot path (when user lands on the bot first via /start <referrerId>):
      Define POST /bot-webhook in routes.js (see bot-management skill) and persist
      msg.text.split(' ')[1] as the referrer on the new user's record.
   Both paths write to the SAME user record — the second one is a no-op for already-attributed users.
4. Store referral data per-user: db.set('user:' + userId, { ...userData, referredBy: referrerId, referrals: [] })
5. Update referrer's data: push new userId to referrer's referrals array, add bonus to referrer's balance
6. Let the user configure the bonus amount — store it in db as a config or use a default
7. Show referral stats: total referrals count, earned bonuses
8. Copy link button: navigator.clipboard.writeText(refLink) with a "Copied!" toast feedback
9. If the project includes bot-side handling → load_skill('bot-management') for the canonical pattern (see BOT WEBHOOK rule above for path).
