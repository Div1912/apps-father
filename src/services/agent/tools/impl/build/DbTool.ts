import type OpenAI from "openai";
import fs from "fs";
import path from "path";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";

function isJsonLookingString(value: any): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

function parseJsonValueForDisplay(raw: string): any {
  try { return JSON.parse(raw); } catch { return raw; }
}

export class DbTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "db",
        description: "Read or write to the project's key-value database. Operations: get, set, delete, keys.",
        parameters: {
          type: "object",
          properties: {
            operation: { type: "string", enum: ["get", "set", "delete", "keys"], description: "Database operation" },
            key: { type: "string", description: "Key to operate on" },
            value: { description: "Value to store (for set operation)" },
          },
          required: ["operation"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    const op = args.operation;
    await ctx.progress({ action: "🗄️ Database", detail: `${op}(${args.key || ""})`, percent: ctx.currentPercent });
    try {
      const Database = require("better-sqlite3");
      const dataDir = path.join(ctx.projectRootDir, "development", "data");
      fs.mkdirSync(dataDir, { recursive: true });
      const sqlite = new Database(path.join(dataDir, "app.db"));
      sqlite.pragma("journal_mode = WAL");
      sqlite.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)");

      let result: string;
      switch (op) {
        case "get": {
          const row = sqlite.prepare("SELECT value FROM kv WHERE key = ?").get(args.key);
          if (row) {
            const parsed = parseJsonValueForDisplay((row as any).value);
            result = `OK: ${JSON.stringify(parsed, null, 2).substring(0, 8000)}`;
          } else {
            result = "OK: null";
          }
          break;
        }
        case "set": {
          if (isJsonLookingString(args.value)) {
            result = `Error: db.set "${args.key}" received a JSON-looking string. Pass a real array/object instead, not a stringified JSON value.`;
            break;
          }
          const val = JSON.stringify(args.value);
          sqlite.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(args.key, val);
          result = `OK: Stored ${val.length} bytes under "${args.key}"`;
          break;
        }
        case "delete": {
          sqlite.prepare("DELETE FROM kv WHERE key = ?").run(args.key);
          result = `OK: Deleted "${args.key}"`;
          break;
        }
        case "keys": {
          const keys = sqlite.prepare("SELECT key FROM kv").all().map((r: any) => r.key);
          result = `OK: [${keys.join(", ")}]`;
          break;
        }
        default:
          result = `Error: Unknown operation "${op}". Use get, set, delete, or keys.`;
      }
      sqlite.close();
      return result;
    } catch (err: any) {
      console.error(`[Agent] db error:`, err.message);
      return `Error: ${err.message}`;
    }
  }

  getStepMeta(args: Record<string, any>): Record<string, any> {
    const meta: Record<string, any> = { op: args?.operation };
    if (args?.key) meta.key = args.key;
    return meta;
  }
}
