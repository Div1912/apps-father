import fs from "fs";
import path from "path";
import type { AskTool } from "./AskTool";
import type { AskContext } from "./AskContext";
import { KNOWLEDGE_DIR } from "../../../paths";

const ALLOWED_TOPICS = new Set(["payments", "referrals", "realtime", "bot", "billing", "tiers"]);

export class PlatformHelpAskTool implements AskTool {
  name = "platform_help";
  definition = {
    type: "function",
    function: {
      name: "platform_help",
      description: "Look up Apps Father platform documentation aimed at owners. Use this when the owner asks about platform-wide features, pricing, payments, referrals, real-time, the bot side, etc.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "One of: payments, referrals, realtime, bot, billing, tiers. Omit for the high-level overview." },
        },
        additionalProperties: false,
      },
    },
  };

  async execute(args: Record<string, any>, _ctx: AskContext): Promise<string> {
    const topic = (typeof args?.topic === "string" ? args.topic : "").toLowerCase().trim();
    const askDir = path.join(KNOWLEDGE_DIR, "ask");
    if (!topic) return this._loadOverview();
    if (!ALLOWED_TOPICS.has(topic)) {
      return `Unknown topic. Available: ${[...ALLOWED_TOPICS].join(", ")}`;
    }
    const file = path.join(askDir, "topics", `${topic}.md`);
    if (!fs.existsSync(file)) return `Topic '${topic}' has no doc yet.`;
    return fs.readFileSync(file, "utf-8");
  }

  private _loadOverview(): string {
    try {
      const p = path.join(KNOWLEDGE_DIR, "ask", "platform-overview.md");
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
    } catch {}
    return "(platform overview unavailable)";
  }
}
