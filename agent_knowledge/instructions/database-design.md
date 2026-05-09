DATABASE KEY DESIGN — quick reminder (full patterns in `load_skill('backend')`):
- Per-record keys: `db.set('user:' + telegramId, data)` — never a single array key for all users
- Pre-computed aggregates: maintain `leaderboard` and `stats` keys at write time, read directly
- Collections: `item:{id}` per record + `item_index` array of IDs
- Always handle null: `db.get('user:' + id) || null`
