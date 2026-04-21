RULES FOR BACKEND (routes.js):
1. Export: module.exports = function(router, db, projectId) { ... }
2. db.get(key) — returns parsed JSON value or null
3. db.set(key, value) — stores any JSON value (object, array, string, number)
4. db.delete(key) — removes a key
5. db.keys() — returns array of all key names
6. db.getAll() — returns entire database as { key: value, ... }
7. db.botToken — this project's Telegram Bot token
8. db.botUsername — bot username (without @)
9. Do NOT add auth/initData verification — handled by server middleware
10. You CAN require npm packages — install them first with shell("npm install <pkg>")
