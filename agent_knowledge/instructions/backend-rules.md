RULES FOR BACKEND (routes.js):
1. Export: module.exports = function(router, db, projectId) { ... }
2. db.get(key) — returns parsed JSON value or null
3. db.set(key, value) — stores any JSON value (object, array, string, number)
4. db.delete(key) — removes a key
5. db.keys() — returns array of all key names
6. db.getAll() — returns entire database as { key: value, ... }
7. db.botToken — this project's Telegram Bot token
8. db.botUsername — bot username (without @)
9. Do NOT add initData signature verification — platform middleware already verified it before routes.js runs.
10. ALWAYS get the authenticated user from req.telegramUser (injected by middleware, already HMAC-verified):
    function getUser(req) {
      const u = req.telegramUser;
      if (!u || !u.id) return null;
      return { telegramId: String(u.id), firstName: u.first_name || '', username: u.username || '' };
    }
11. NEVER use req.query.telegramId or req.body.telegramId for authentication — anyone can spoof these.
12. NEVER use SQL-style comments (-- comment) in routes.js — they are a syntax error in JavaScript. Always use // for single-line comments.
13. You CAN require npm packages — install them first with shell("npm install <pkg>")
