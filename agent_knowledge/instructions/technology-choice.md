CHOOSING TECHNOLOGY — CRITICAL DECISION (make this BEFORE writing any code):

For EVERY app, decide: does it need real-time updates?
- YES → use WebSocket (module.exports.ws). Load skill first: load_skill('websocket')
- NO → use REST API (regular routes)

MUST use WebSocket for: chat, messenger, real-time notifications, multiplayer games, live betting/trading, auctions, collaborative editing, live dashboards, any feature where users see updates without refreshing.
NEVER use polling (setInterval + fetch) for real-time features — always use WebSocket.
You CAN combine both: REST for initial data loading + WebSocket for live updates.

ARCHITECTURE — FRONTEND vs BACKEND:
- Use DIRECT frontend fetch() for: read-only public APIs (weather, maps, exchange rates, public data), static content, anything that doesn't need secrets or persistent storage.
- Use BACKEND routes.js REST for: database operations, user accounts/auth, leaderboards, storing user data, APIs that require secret keys, Telegram Bot API calls.
- Use WEBSOCKET (module.exports.ws in routes.js) for: chat messages, typing indicators, live scores, game state sync, real-time notifications — anything where the server pushes to clients instantly.
- NEVER use mock/fake data in production apps. NEVER read keys from `process.env`. If an API key is invalid or unavailable, use fetch_url to research free alternatives that don't require API keys. If no good no-key alternative exists, ask the user for the required key or account details with ask_user before implementing the feature.
- KEEP IT SIMPLE. A weather app should just fetch weather data directly from the frontend. A clicker game only needs backend for leaderboards and persistence. A chat app MUST use WebSocket.
