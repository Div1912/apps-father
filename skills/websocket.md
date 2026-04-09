# WebSocket Skill — Real-Time Communication

Use WebSockets when the app needs **instant updates**: chat/messenger, live bets, multiplayer games, auctions, live dashboards, collaborative tools, real-time notifications.

Do NOT use WebSockets for simple CRUD apps, leaderboards, settings, or anything where a few seconds delay is acceptable — use REST routes instead.

## Connection URL

Frontend connects to: `wss://apps-father.com/ws/{projectId}`

## Backend — routes.js WebSocket Handler

Add a `ws` export alongside the main routes function:

```js
module.exports = function(router, db, projectId) {
  // Normal REST routes here...
};

module.exports.ws = function(wss, db, projectId) {
  // wss.clients       — Set of all connected WebSocket clients
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
const WS_URL = 'wss://apps-father.com/ws/' + PROJECT_ID;
let ws;
let reconnectTimer;

function connectWebSocket() {
  ws = new WebSocket(WS_URL);

  ws.onopen = function() {
    console.log('WebSocket connected');
    clearTimeout(reconnectTimer);
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
    console.log('WebSocket disconnected, reconnecting...');
    reconnectTimer = setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = function(err) {
    console.error('WebSocket error:', err);
    ws.close();
  };
}

function sendMessage(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function handleMessage(data) {
  switch (data.type) {
    case 'welcome':
      console.log(data.message);
      break;
    // Handle other message types...
  }
}

connectWebSocket();
```

## Example: Chat / Messenger

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
    // Send last 50 messages on connect
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

          // Save to DB
          const messages = db.get('messages') || [];
          messages.push(msg);
          if (messages.length > 500) messages.splice(0, messages.length - 500);
          db.set('messages', messages);

          // Broadcast to all clients
          wss.broadcast(JSON.stringify({ type: 'new_message', message: msg }));
        }

        if (data.type === 'typing') {
          wss.broadcastExcept(socket, JSON.stringify({
            type: 'user_typing',
            userId: data.userId,
            username: data.username
          }));
        }
      } catch (err) {
        console.error('Message error:', err);
      }
    });

    socket.on('close', () => {
      // Notify others that user left (optional)
    });
  });
};
```

### Frontend (app.js)

```js
const projectId = window.location.pathname.split('/')[2];
const WS_URL = 'wss://apps-father.com/ws/' + projectId;
let ws;

function connectWS() {
  ws = new WebSocket(WS_URL);

  ws.onmessage = function(event) {
    const data = JSON.parse(event.data);

    if (data.type === 'history') {
      data.messages.forEach(renderMessage);
    }
    if (data.type === 'new_message') {
      renderMessage(data.message);
    }
    if (data.type === 'user_typing') {
      showTypingIndicator(data.username);
    }
  };

  ws.onclose = function() {
    setTimeout(connectWS, 2000);
  };
}

function sendChatMessage(text) {
  const user = Telegram.WebApp.initDataUnsafe.user;
  ws.send(JSON.stringify({
    type: 'chat_message',
    userId: user.id,
    username: user.first_name,
    text: text
  }));
}

connectWS();
```

## Example: Live Betting / Ticker

### Backend (routes.js)

```js
module.exports.ws = function(wss, db, projectId) {
  // Periodic price/odds update
  const interval = setInterval(() => {
    const odds = db.get('current_odds') || {};
    wss.broadcast(JSON.stringify({ type: 'odds_update', odds }));
  }, 1000);

  wss.onConnection((socket) => {
    // Send current state on connect
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

### Backend (routes.js)

```js
module.exports.ws = function(wss, db, projectId) {
  const players = new Map(); // socket -> playerData

  wss.onConnection((socket) => {
    socket.on('message', (raw) => {
      const data = JSON.parse(raw.toString());

      if (data.type === 'join') {
        players.set(socket, { id: data.userId, name: data.username, x: 0, y: 0, score: 0 });
        wss.broadcast(JSON.stringify({
          type: 'player_list',
          players: Array.from(players.values())
        }));
      }

      if (data.type === 'move') {
        const player = players.get(socket);
        if (player) {
          player.x = data.x;
          player.y = data.y;
          wss.broadcastExcept(socket, JSON.stringify({
            type: 'player_moved',
            playerId: player.id,
            x: data.x,
            y: data.y
          }));
        }
      }
    });

    socket.on('close', () => {
      const player = players.get(socket);
      players.delete(socket);
      if (player) {
        wss.broadcast(JSON.stringify({ type: 'player_left', playerId: player.id }));
      }
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
- For chat: cap stored messages (e.g., keep last 500)
- Use `wss.broadcast()` for updates everyone needs
- Use `wss.broadcastExcept(socket, ...)` for messages from one user to others
- Use `socket.send()` for messages to one specific client
- WebSocket URL is always: `wss://apps-father.com/ws/{projectId}`
- The `db` object works exactly the same as in REST routes (get/set/delete/keys)
- The ws handler is loaded ONCE when the first client connects, not on every message
- If no clients are connected, the handler is cleaned up automatically
