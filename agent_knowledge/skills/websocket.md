# WebSocket Skill — Real-Time Communication

Use WebSockets when the app needs **instant updates**: chat/messenger, live bets, multiplayer games, auctions, live dashboards, collaborative tools, real-time notifications.

Do NOT use WebSockets for simple CRUD apps, leaderboards, settings, or anything where a few seconds delay is acceptable — use REST routes instead.

## Connection URL

Frontend connects to: `{wsBaseUrl}/ws/{projectId}`

## Backend — routes.js WebSocket Handler

Add a `ws` export alongside the main routes function:

```js
// Keep connection state at module scope when REST routes need to notify
// connected WebSocket clients. module.exports and module.exports.ws share
// this scope when the platform loads routes.js.
const online = new Map();

module.exports = function(router, db, projectId) {
  // Normal REST routes here...
};

module.exports.ws = function(wss, db, projectId) {
  // wss.clients          — Set of all connected WebSocket clients
  // wss.broadcast(data)  — send to ALL connected clients
  // wss.broadcastExcept(sender, data)  — send to all EXCEPT sender
  // wss.onConnection(handler)  — called when a new client connects

  wss.onConnection((socket, req) => {
    // socket.send(data)  — send to this one client
    // socket.on('message', (msg) => { ... })  — receive from this client
    // socket.on('close', () => { ... })  — client disconnected

    socket.send(JSON.stringify({ type: 'welcome', message: 'Connected!' }));

    socket.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        // Handle message based on data.type
      } catch (err) {
        console.error('Invalid message:', err);
      }
    });
  });
};
```

## Frontend — Connecting from app.js

```js
const WS_URL = '{wsBaseUrl}/ws/' + PROJECT_ID;
let ws;
let reconnectTimer;

function connectWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.onopen = function() {
    console.log('WebSocket connected');
    clearTimeout(reconnectTimer);
    // Always send auth immediately after connecting.
    // Do not send a raw userId; the server must derive it from initData.
    ws.send(JSON.stringify({ type: 'auth', initData: Telegram.WebApp.initData || '' }));
  };

  ws.onmessage = function(event) {
    try {
      const data = JSON.parse(event.data);
      handleMessage(data);
    } catch (err) {
      console.error('WS parse error:', err);
    }
  };

  ws.onclose = function() {
    reconnectTimer = setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = function(err) {
    ws.close();
  };
}

function sendWS(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function handleMessage(data) {
  switch (data.type) {
    case 'welcome': break;
    // Handle other message types...
  }
}

connectWebSocket();
```

---

## Example: Group Chat / Messenger (broadcast)

All users see all messages — use `wss.broadcast`.

### Backend (routes.js)

```js
module.exports = function(router, db, projectId) {
  router.get('/messages', (req, res) => {
    const messages = db.get('messages') || [];
    res.json({ messages: messages.slice(-100) });
  });
};

module.exports.ws = function(wss, db, projectId) {
  wss.onConnection((socket, req) => {
    const messages = db.get('messages') || [];
    socket.send(JSON.stringify({ type: 'history', messages: messages.slice(-50) }));

    socket.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        if (data.type === 'chat_message') {
          const msg = {
            id: Date.now().toString(36) + Math.random().toString(36).substr(2, 6),
            userId: data.userId,
            username: data.username,
            text: data.text,
            timestamp: Date.now()
          };
          const messages = db.get('messages') || [];
          messages.push(msg);
          if (messages.length > 500) messages.splice(0, messages.length - 500);
          db.set('messages', messages);
          wss.broadcast(JSON.stringify({ type: 'new_message', message: msg }));
        }

        if (data.type === 'typing') {
          wss.broadcastExcept(socket, JSON.stringify({
            type: 'user_typing', userId: data.userId, username: data.username
          }));
        }
      } catch (err) {
        console.error('Message error:', err);
      }
    });
  });
};
```

---

## Example: Private 1-to-1 Chat (direct messages between two users)

Apps like dating, support, marketplaces need messages to go only to the intended recipient.
The key pattern is: maintain a `userId → socket` Map so you can target a specific connected user.
If the recipient is offline — persist the message to DB and deliver it next time they connect.

### Backend (routes.js)

```js
// Module-scope state shared by REST routes and the WS handler.
// Needed if a REST route creates a match and should notify an online user.
const online = new Map(); // userId (string) -> socket

module.exports = function(router, db, projectId) {
  function notifyOnlineMatch(match, toUserId, otherUser) {
    const socket = online.get(String(toUserId));
    if (socket && socket.readyState === 1) {
      socket.send(JSON.stringify({
        type: 'match_notification',
        match: {
          id: match.id,
          otherUserId: otherUser.telegramId,
          name: otherUser.name,
          photo: otherUser.photo || '',
          createdAt: match.createdAt
        }
      }));
    }
  }

  // Example: when a REST route creates a match, notify the other online user.
  // Call notifyOnlineMatch(match, otherUserId, myProfile) after db.set('matches', matches).

  // Load history for a conversation
  router.get('/messages/:matchId', (req, res) => {
    const u = req.telegramUser;
    if (!u) { res.status(401).json({ error: 'Unauthorized' }); return; }
    const msgs = db.get('msgs:' + req.params.matchId) || [];
    res.json({ messages: msgs.slice(-50) });
  });
};

module.exports.ws = function(wss, db, projectId) {
  function parseUserFromInitData(initData) {
    try {
      const params = new URLSearchParams(String(initData || ''));
      const rawUser = params.get('user');
      if (!rawUser) return null;
      const user = JSON.parse(rawUser);
      return user && user.id ? String(user.id) : null;
    } catch {
      return null;
    }
  }

  wss.onConnection((socket, req) => {
    let myUserId = null;

    socket.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        // ── Auth handshake — client sends this immediately on connect ──────
        if (data.type === 'auth') {
          myUserId = parseUserFromInitData(data.initData);
          if (!myUserId) {
            socket.send(JSON.stringify({ type: 'error', error: 'auth_required' }));
            socket.close();
            return;
          }
          online.set(myUserId, socket);
          socket.send(JSON.stringify({ type: 'authed' }));

          // Deliver any messages that arrived while this user was offline
          const pending = db.get('pending:' + myUserId) || [];
          if (pending.length > 0) {
            pending.forEach(msg => socket.send(JSON.stringify({ type: 'new_msg', ...msg })));
            db.delete('pending:' + myUserId);
          }
          return;
        }

        if (!myUserId) return; // ignore everything before auth

        // ── Send a private message ────────────────────────────────────────
        if (data.type === 'send_msg') {
          const { matchId, text, toUserId } = data;
          if (!matchId || !text || !toUserId) return;

          const matches = db.get('matches') || [];
          const match = matches.find(m => m.id === matchId);
          if (!match || !match.users || !match.users.includes(myUserId) || !match.users.includes(String(toUserId))) {
            socket.send(JSON.stringify({ type: 'error', error: 'not_allowed' }));
            return;
          }

          const msg = {
            matchId,
            from: myUserId,
            text: String(text).slice(0, 2000),
            ts: Date.now()
          };

          // Persist to DB
          const key = 'msgs:' + matchId;
          const history = db.get(key) || [];
          history.push(msg);
          if (history.length > 200) history.splice(0, history.length - 200);
          db.set(key, history);

          const payload = JSON.stringify({ type: 'new_msg', matchId, msg });

          // Deliver to recipient if online
          const recipientSocket = online.get(String(toUserId));
          if (recipientSocket && recipientSocket.readyState === 1 /* OPEN */) {
            recipientSocket.send(payload);
          } else {
            // Store for delivery when recipient reconnects
            const pending = db.get('pending:' + toUserId) || [];
            pending.push({ matchId, msg });
            if (pending.length > 100) pending.splice(0, pending.length - 100);
            db.set('pending:' + toUserId, pending);
          }

          // Echo back to sender (confirm delivery)
          socket.send(payload);
        }

        // ── Typing indicator ──────────────────────────────────────────────
        if (data.type === 'typing') {
          const { matchId, toUserId } = data;
          const recipientSocket = online.get(String(toUserId));
          if (recipientSocket && recipientSocket.readyState === 1) {
            recipientSocket.send(JSON.stringify({
              type: 'typing', matchId, fromUserId: myUserId
            }));
          }
        }

      } catch (err) {
        console.error('[ws] message error:', err);
      }
    });

    socket.on('close', () => {
      if (myUserId) online.delete(myUserId);
    });
  });
};
```

**Important for REST-to-WS notifications:** do not define `const online = new Map()` inside `module.exports.ws` if REST routes need to send events such as `match_notification`. Put the map at module scope, then both the REST route and the WS handler can access it.

**Testing private chat with simulate_ws:**
Use structured DB seed values, not stringified JSON:

```js
simulate_ws({
  scenarioId: 'chat-message',
  seedDb: [
    { key: 'matches', value: [{ id: 'm1', users: ['-100', '-101'], createdAt: new Date().toISOString() }] }
  ],
  clients: [{ id: 'a', userId: -100 }, { id: 'b', userId: -101 }],
  steps: [
    { type: 'ws', clientId: 'a', data: { type: 'auth' } },
    { type: 'ws', clientId: 'b', data: { type: 'auth' } },
    { type: 'ws', clientId: 'a', data: { type: 'send_msg', matchId: 'm1', toUserId: '-101', text: 'Hello' } }
  ],
  expectTypes: ['authed', 'new_msg']
});
```

### Frontend (app.js)

```js
const WS_URL = '{wsBaseUrl}/ws/' + PROJECT_ID;
let ws;

function connectWS() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    // Authenticate immediately — server won't deliver messages before this
    ws.send(JSON.stringify({ type: 'auth', initData: Telegram.WebApp.initData || '' }));
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);

    if (data.type === 'authed') {
      console.log('WS authenticated');
    }
    if (data.type === 'new_msg') {
      // data.matchId, data.msg: { from, text, ts }
      renderMessage(data.matchId, data.msg);
    }
    if (data.type === 'typing') {
      showTypingIndicator(data.matchId, data.fromUserId);
    }
  };

  ws.onclose = () => setTimeout(connectWS, 2000);
}

function sendPrivateMessage(matchId, toUserId, text) {
  ws.send(JSON.stringify({ type: 'send_msg', matchId, toUserId, text }));
}

function sendTyping(matchId, toUserId) {
  ws.send(JSON.stringify({ type: 'typing', matchId, toUserId }));
}

connectWS();
```

**Key rules for private routing:**
- The client MUST send `{ type: "auth", initData }` immediately on connect before anything else
- The server MUST derive the connected user id from Telegram initData. Never trust `{ userId }` sent by the client for private routing.
- For private chat, the server MUST verify the sender and recipient both belong to the match before storing or forwarding `send_msg`.
- Store `userId → socket` in a module-level Map (it lives for the lifetime of the WS handler)
- Always check `recipientSocket.readyState === 1` before calling `.send()` — stale map entries cause crashes
- Always store undelivered messages in DB under `pending:{userId}` and flush them on auth

---

## Example: Live Betting / Ticker

```js
module.exports.ws = function(wss, db, projectId) {
  const interval = setInterval(() => {
    const odds = db.get('current_odds') || {};
    wss.broadcast(JSON.stringify({ type: 'odds_update', odds }));
  }, 1000);

  wss.onConnection((socket) => {
    const odds = db.get('current_odds') || {};
    socket.send(JSON.stringify({ type: 'odds_update', odds }));

    socket.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.type === 'place_bet') {
        const bets = db.get('bets') || [];
        const bet = { id: Date.now().toString(36), ...data, timestamp: Date.now() };
        bets.push(bet);
        db.set('bets', bets);
        socket.send(JSON.stringify({ type: 'bet_confirmed', bet }));
        wss.broadcast(JSON.stringify({ type: 'new_bet', userId: data.userId }));
      }
    });
  });
};
```

## Example: Multiplayer Game

```js
module.exports.ws = function(wss, db, projectId) {
  const players = new Map(); // socket → playerData

  wss.onConnection((socket) => {
    socket.on('message', (raw) => {
      const data = JSON.parse(raw.toString());

      if (data.type === 'join') {
        players.set(socket, { id: data.userId, name: data.username, x: 0, y: 0, score: 0 });
        wss.broadcast(JSON.stringify({ type: 'player_list', players: Array.from(players.values()) }));
      }

      if (data.type === 'move') {
        const player = players.get(socket);
        if (player) {
          player.x = data.x;
          player.y = data.y;
          wss.broadcastExcept(socket, JSON.stringify({
            type: 'player_moved', playerId: player.id, x: data.x, y: data.y
          }));
        }
      }
    });

    socket.on('close', () => {
      const player = players.get(socket);
      players.delete(socket);
      if (player) wss.broadcast(JSON.stringify({ type: 'player_left', playerId: player.id }));
    });
  });
};
```

## IMPORTANT RULES

- Always use JSON messages: `JSON.stringify({ type: '...', ...data })`
- Always parse with try/catch: `try { JSON.parse(raw.toString()) } catch {}`
- Always implement reconnection on frontend (setTimeout + connectWS on close)
- Use `data.type` field to distinguish message types
- Keep messages small — don't send entire database state every time
- For chat: cap stored messages (e.g., keep last 200 per conversation)
- Use `wss.broadcast()` for updates everyone needs (group chat, game state)
- Use `wss.broadcastExcept(socket, ...)` for messages from one user to others
- Use `socket.send()` for messages to one specific client
- Use a `userId → socket` Map for private 1:1 routing (dating apps, DMs, support chat)
- WebSocket URL is always: `{wsBaseUrl}/ws/{projectId}`
- The `db` object works exactly the same as in REST routes (get/set/delete/keys)
- The ws handler is loaded ONCE when the first client connects, not on every message
- If no clients are connected, the handler is cleaned up automatically
- Always send `auth` as the first message from the client so the server knows who is connected
