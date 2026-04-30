# Payments — Telegram Stars and TON

## Telegram Stars (XTR)

- Telegram's official in-Mini-App currency. Users buy Stars from Telegram and
  spend them inside the app.
- Apps Father can implement Stars checkout for any product, subscription, or
  unlock the owner wants.
- The Stars feature is **LOCKED by default**. The owner has to purchase the
  unlock once for the project, then the agent can wire up checkout flows on
  every future build/update.
- Refunds, success and failure handling, and the bot-side payment webhook are
  all done by the agent — the owner just describes what they're selling.

## TON crypto

- Pay with TON (The Open Network) directly from a Telegram wallet.
- Locked by default, same one-time unlock as Stars.
- The owner must provide their TON wallet address before unlock — that's the
  address that receives the funds.
- The agent generates deep-links / connect-wallet buttons; users approve from
  Tonkeeper or any TON-compatible wallet.
- Suitable for higher-value purchases, NFT-like assets, P2P transfers,
  one-off donations.

## Choosing between them

- **Stars** = lower friction, works for everyone with a Telegram account, no
  wallet setup, micro-transactions feel native.
- **TON** = better for crypto-native audiences, higher amounts, and on-chain
  receipts.
- An app can use both at the same time.
