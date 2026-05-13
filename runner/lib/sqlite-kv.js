/* eslint-disable */
"use strict";

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

/**
 * Per-runtime KV wrapper. Same surface as the legacy in-process one in
 * src/web/routes/{api,devapi}.routes.ts and src/web/ws-manager.ts:
 *
 *   db.get(key) / db.set(key, value) / db.getAll() / db.delete(key) / db.keys()
 *   db.close()
 *   db.botToken / db.botUsername / db.projectId
 *
 * Uses `db.sqlite` (not `app.db`) — the worker entry handles the legacy rename
 * before this module is loaded.
 *
 * `db.bucket` is attached by loadRuntime once the helper is built.
 */
function createKvDb({ dbPath, botToken, botUsername, projectId }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)");

  let closed = false;

  const getStmt    = sqlite.prepare("SELECT value FROM kv WHERE key = ?");
  const setStmt    = sqlite.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)");
  const delStmt    = sqlite.prepare("DELETE FROM kv WHERE key = ?");
  const keysStmt   = sqlite.prepare("SELECT key FROM kv");
  const allStmt    = sqlite.prepare("SELECT key, value FROM kv");

  return {
    get open() { return !closed; },
    get(key) {
      if (closed) return null;
      try {
        const row = getStmt.get(key);
        return row ? JSON.parse(row.value) : null;
      } catch {
        return null;
      }
    },
    set(key, value) {
      if (closed) return;
      try { setStmt.run(key, JSON.stringify(value)); } catch {}
    },
    getAll() {
      if (closed) return {};
      try {
        const rows = allStmt.all();
        const out = {};
        for (const row of rows) out[row.key] = JSON.parse(row.value);
        return out;
      } catch { return {}; }
    },
    delete(key) {
      if (closed) return;
      try { delStmt.run(key); } catch {}
    },
    keys() {
      if (closed) return [];
      try { return keysStmt.all().map((r) => r.key); } catch { return []; }
    },
    close() {
      if (closed) return;
      closed = true;
      try { sqlite.close(); } catch {}
    },
    botToken,
    botUsername,
    projectId,
  };
}

module.exports = { createKvDb };
