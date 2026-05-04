import fs from "fs";
import path from "path";
import type { AskTool } from "./AskTool";
import type { AskContext } from "./AskContext";
import { PROJECTS_DIR } from "../../../paths";

export class DbQueryAskTool implements AskTool {
  name = "db_query";
  definition = {
    type: "function",
    function: {
      name: "db_query",
      description: "Read-only inspection of the project's key/value database. Use this to answer 'how many users?', 'what's stored?', 'show me the latest order' kinds of questions.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get", "count"], description: "list = recent keys with truncated values; get = single key value; count = key count." },
          key: { type: "string", description: "Required when action=get." },
          prefix: { type: "string", description: "Optional key prefix filter for list/count." },
          limit: { type: "number", description: "Max keys returned by list (default 20, max 100)." },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  };

  async execute(args: Record<string, any>, ctx: AskContext): Promise<string> {
    const action = String(args?.action || "").toLowerCase();
    if (!["list", "get", "count"].includes(action)) {
      return "Error: action must be one of 'list', 'get', 'count'.";
    }
    const Database = require("better-sqlite3");
    const dbPath = path.join(PROJECTS_DIR, ctx.projectId, "development", "data", "app.db");
    if (!fs.existsSync(dbPath)) return "(no database yet — the app hasn't stored anything)";
    const db = new Database(dbPath, { readonly: true });
    try {
      if (action === "count") {
        const prefix = typeof args.prefix === "string" ? args.prefix : null;
        const row: any = prefix
          ? db.prepare("SELECT COUNT(*) AS n FROM kv WHERE key LIKE ?").get(`${prefix}%`)
          : db.prepare("SELECT COUNT(*) AS n FROM kv").get();
        return JSON.stringify({ action: "count", prefix, count: row?.n || 0 });
      }
      if (action === "get") {
        if (typeof args.key !== "string" || !args.key) return "Error: key is required for action=get.";
        const row: any = db.prepare("SELECT value FROM kv WHERE key = ?").get(args.key);
        if (!row) return JSON.stringify({ key: args.key, value: null, found: false });
        const truncated = row.value.length > 4000 ? row.value.slice(0, 4000) + "...(truncated)" : row.value;
        return JSON.stringify({ key: args.key, value: truncated, found: true });
      }
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
      const prefix = typeof args.prefix === "string" ? args.prefix : null;
      const rows: any[] = prefix
        ? db.prepare("SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key LIMIT ?").all(`${prefix}%`, limit)
        : db.prepare("SELECT key, value FROM kv ORDER BY key LIMIT ?").all(limit);
      const out = rows.map(r => ({
        key: r.key,
        value: r.value.length > 200 ? r.value.slice(0, 200) + "..." : r.value,
      }));
      return JSON.stringify({ action: "list", prefix, returned: out.length, limit, items: out });
    } finally {
      try { db.close(); } catch {}
    }
  }
}
