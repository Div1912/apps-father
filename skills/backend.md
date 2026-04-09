# Backend Skill — Routes & Database Patterns

## Routes.js Structure

```js
module.exports = function(router, db, projectId) {
  // db.get(key) — returns parsed JSON or null
  // db.set(key, value) — stores any JSON (object, array, string, number)
  // db.delete(key) — removes a key
  // db.keys() — lists all key names
  // db.getAll() — returns entire db as { key: value, ... }
  // db.botToken — Telegram Bot token
  // db.botUsername — bot username (without @)
};
```

## DATABASE KEY DESIGN (CRITICAL — follow strictly)

NEVER store users or large collections in a single array key like `db.get('users')`.
This loads the entire array on every request and breaks at scale.

Instead, use **per-record keys** with prefixes:

```
user:{telegramId}  -> { telegramId, username, firstName, score, ... }
item:{id}          -> { id, name, price, ... }
game:{id}          -> { id, status, players, ... }
```

For aggregations (leaderboards, counters, stats), maintain a **separate pre-computed key**
that gets updated at write time — never computed at read time.

```
leaderboard        -> [{ telegramId, firstName, score }, ...] (top 50 only)
stats              -> { totalUsers: 123, totalGames: 45 }
```

## User Registration (find or create)

```js
function getOrCreateUser(db, telegramId, username, firstName) {
  let user = db.get('user:' + telegramId);
  if (!user) {
    user = {
      telegramId,
      username: username || '',
      firstName: firstName || '',
      score: 0,
      createdAt: new Date().toISOString()
    };
    db.set('user:' + telegramId, user);
    // Update stats counter
    const stats = db.get('stats') || { totalUsers: 0 };
    stats.totalUsers++;
    db.set('stats', stats);
  }
  return user;
}

router.post('/user', (req, res) => {
  const { telegramId, username, firstName } = req.body;
  const user = getOrCreateUser(db, telegramId, username, firstName);
  res.json(user);
});
```

## Getting User from InitData

```js
function getUserId(req) {
  try {
    const authHeader = req.headers.authorization || '';
    const initData = authHeader.replace('Bearer ', '');
    const params = new URLSearchParams(initData);
    const userStr = params.get('user');
    if (userStr) {
      const user = JSON.parse(decodeURIComponent(userStr));
      return user.id?.toString();
    }
  } catch {}
  return null;
}

router.get('/me', (req, res) => {
  const telegramId = getUserId(req);
  if (!telegramId) return res.status(401).json({ error: 'Unauthorized' });
  const user = db.get('user:' + telegramId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});
```

## Update a Record + Leaderboard

```js
router.post('/click', (req, res) => {
  const telegramId = getUserId(req);
  const user = db.get('user:' + telegramId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  user.score += 1;
  user.lastClickAt = new Date().toISOString();
  db.set('user:' + telegramId, user);

  // Update leaderboard (keep top 50, pre-sorted)
  updateLeaderboard(db, user);

  res.json({ score: user.score });
});

function updateLeaderboard(db, user) {
  const board = db.get('leaderboard') || [];
  const idx = board.findIndex(e => e.telegramId === user.telegramId);
  const entry = { telegramId: user.telegramId, firstName: user.firstName, username: user.username, score: user.score };
  if (idx >= 0) board[idx] = entry;
  else board.push(entry);
  board.sort((a, b) => b.score - a.score);
  if (board.length > 50) board.length = 50;
  db.set('leaderboard', board);
}
```

## Leaderboard (read — instant, pre-computed)

```js
router.get('/leaderboard', (req, res) => {
  const board = db.get('leaderboard') || [];
  res.json({ leaderboard: board });
});
```

## Counting users or listing keys by prefix

```js
// Count all users
router.get('/stats', (req, res) => {
  const stats = db.get('stats') || { totalUsers: 0 };
  res.json(stats);
});

// If you need to iterate users (rare, admin only):
function getAllUsers(db) {
  return db.keys()
    .filter(k => k.startsWith('user:'))
    .map(k => db.get(k));
}
```

## Items / Collections

```js
router.post('/items', (req, res) => {
  const { name, price } = req.body;
  const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 6);
  const item = { id, name, price, createdAt: new Date().toISOString() };
  db.set('item:' + id, item);

  // Keep an index of item IDs for listing
  const index = db.get('item_index') || [];
  index.push(id);
  db.set('item_index', index);

  res.json(item);
});

router.get('/items', (req, res) => {
  const index = db.get('item_index') || [];
  const items = index.map(id => db.get('item:' + id)).filter(Boolean);
  res.json({ items });
});

router.delete('/items/:id', (req, res) => {
  db.delete('item:' + req.params.id);
  const index = db.get('item_index') || [];
  db.set('item_index', index.filter(id => id !== req.params.id));
  res.json({ success: true });
});
```

## Settings / Config Pattern

```js
router.get('/settings', (req, res) => {
  const settings = db.get('settings') || { theme: 'dark', notifications: true };
  res.json(settings);
});

router.post('/settings', (req, res) => {
  const current = db.get('settings') || {};
  const updated = { ...current, ...req.body };
  db.set('settings', updated);
  res.json(updated);
});
```

## Error Handling

```js
router.post('/action', (req, res) => {
  try {
    const { userId, value } = req.body;
    if (!userId || value === undefined) {
      return res.status(400).json({ error: 'Missing userId or value' });
    }
    // ... do work ...
    res.json({ success: true });
  } catch (err) {
    console.error('Action error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

## Telegram Stars Payments

```js
router.post('/create-invoice', async (req, res) => {
  try {
    const userId = getUserId(req);
    const { stars, item } = req.body;
    const invoiceId = 'inv_' + Math.random().toString(36).substr(2, 16);

    // Store pending purchase
    const pending = db.get('pending_purchases') || [];
    pending.push({ invoiceId, userId, stars, item, createdAt: new Date().toISOString() });
    db.set('pending_purchases', pending);

    const response = await fetch(
      `https://api.telegram.org/bot${db.botToken}/createInvoiceLink`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: item,
          description: `Purchase ${item}`,
          payload: invoiceId,
          provider_token: '',
          currency: 'XTR',
          prices: [{ label: item, amount: stars }]
        })
      }
    );
    const data = await response.json();
    if (!data.ok) throw new Error(data.description);
    res.json({ invoice_url: data.result });
  } catch (err) {
    console.error('Create invoice error:', err);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

// Frontend: Telegram.WebApp.openInvoice(url, (status) => { if (status === 'paid') refreshUser(); });
```

## TON Payments

For TON payment integration, use `load_skill('ton-payments')` to get the full implementation guide.
Quick summary: TON Connect UI on frontend, backend creates payment with random ID, sends TX with payload, backend polls toncenter.com API to verify.

## Sending Bot Notifications

```js
async function sendNotification(chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${db.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId.toString(),
        text,
        parse_mode: 'HTML'
      })
    });
  } catch (err) {
    console.error('Notification error:', err);
  }
}
```

## IMPORTANT RULES
- NEVER store users in a single array key. Use `db.get('user:' + telegramId)` per-user keys
- NEVER load all users to find one. Direct key lookup: `db.get('user:' + id)`
- NEVER compute leaderboards on read. Pre-compute on score change, read from `leaderboard` key
- For counters (total users, etc.), maintain a `stats` key updated at write time
- ALWAYS handle null: `db.get('user:' + id) || null`, `db.get('leaderboard') || []`
- Generate unique IDs: `Date.now().toString(36) + Math.random().toString(36).substr(2, 6)`
- No SQL, no schemas, no migrations — just get/set JSON
- Data persists across requests automatically
- Always wrap routes in try/catch
- Use console.error for debugging (visible via server_logs tool)
