import type OpenAI from "openai";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";
import { config } from "../../../../../config";
import { runnerManager } from "../../../../runner-manager.service";

export class ServerLogsTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "server_logs",
        description: "Read recent worker logs for this project: stdout/stderr from routes.js (console.log, console.error, uncaught exceptions). Call after deploy_to_dev or simulate_* to debug runtime behaviour.",
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

    if (!config.isWorkerRuntime) {
      return "(server_logs: worker mode is not active on this server — no worker logs available)";
    }

    const logs = runnerManager.getLogs(ctx.projectId, n);
    if (!logs.length) {
      return "(no worker logs yet — the worker may not have started yet, try deploy_to_dev first)";
    }

    return logs
      .map(l => {
        const time = new Date(l.ts).toISOString();
        const stream = l.stream === "stderr" ? "STDERR" : "STDOUT";
        return `[${time}] [${stream}] ${l.text}`;
      })
      .join("\n");
  }
}
