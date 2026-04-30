# Real-time features (WebSocket)

The platform comes with a per-project WebSocket channel out of the box.

What the agent can do with it:

- Live leaderboards and scoreboards.
- Multiplayer rooms (turn-based, real-time, chat lobbies).
- Group chat, broadcasts, and announcements pushed to all current viewers.
- Live counters (online users, "X people just joined", etc.).
- Server-driven UI updates (admin pushes a banner, all clients see it).

The owner doesn't have to think about sockets — they just describe the
behavior. ("Players in the same room should see each other's moves
immediately.")
