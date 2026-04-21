DATABASE KEY DESIGN (CRITICAL):
- Store each user as a separate key: db.set('user:' + telegramId, userData)
- Read one user: db.get('user:' + telegramId) — instant O(1) lookup
- NEVER store all users in one array key like db.get('users') — this breaks at scale
- For leaderboards: maintain a pre-sorted 'leaderboard' key (top 50), update it when score changes
- For counters/stats: maintain a 'stats' key updated at write time, never count at read time
- For collections (items, games): use 'item:{id}' per record + 'item_index' array of IDs
- Use db.keys().filter(k => k.startsWith('user:')) only for admin/rare operations
- Always handle null: db.get('user:' + id) || null
