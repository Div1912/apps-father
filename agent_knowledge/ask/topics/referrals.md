# Referrals

Apps Father has a built-in referral system the agent can wire into any app:

- Each user gets a personal invite link (start parameter).
- When a friend opens the bot via that link, the platform attributes the
  referral to the inviter.
- The agent can build any reward logic on top: bonuses on first launch,
  percentage shares of the friend's purchases, leaderboards of top
  inviters, etc.
- The owner just describes the reward rules ("give 10 coins to inviter when
  the friend buys for the first time"); the agent implements it.
- Anti-abuse: self-referrals and repeated joins from the same Telegram ID
  are not double-counted by default.
