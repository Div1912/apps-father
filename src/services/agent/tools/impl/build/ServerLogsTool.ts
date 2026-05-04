import type OpenAI from "openai";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";
import { prisma } from "../../../../../db";

export class ServerLogsTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "server_logs",
        description: "Read recent logs for this project: routes.js console.log/error output, webhook errors, simulate_telegram and simulate_api results. Call after deploy_to_dev or simulate_* to debug behaviour.",
        parameters: {
          type: "object",
          properties: {
            lines: { type: "number", description: "How many recent log lines to return (default 50, max 200)" },
          },
          required: [],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    const n = Math.min(args.lines || 50, 200);
    const rows = await prisma.appLog.findMany({
      where: { projectId: ctx.projectId },
      orderBy: { ts: "desc" },
      take: n,
      select: { ts: true, level: true, category: true, message: true },
    });
    return rows.reverse()
      .map(r => `[${(r.ts as Date).toISOString()}] [${r.level.toUpperCase()}] ${r.message}`)
      .join("\n") || "(no logs yet for this project)";
  }
}
