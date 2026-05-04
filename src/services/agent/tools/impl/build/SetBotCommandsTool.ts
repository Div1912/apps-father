import type OpenAI from "openai";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";

export class SetBotCommandsTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "set_bot_commands",
        description: "Set the bot's command menu in Telegram using setMyCommands. Each command must have 'command' and 'description'.",
        parameters: {
          type: "object",
          properties: {
            commands: {
              type: "array",
              items: { type: "object" },
              description: "Array of { command, description } objects",
            },
          },
          required: ["commands"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    if (!ctx.botToken) return "Error: No bot token available";
    const commands = (Array.isArray(args.commands) ? args.commands : [])
      .map((c: any) => ({
        command: String(c.command || "").replace(/^\//, "").trim(),
        description: String(c.description || "").trim().slice(0, 256),
      }))
      .filter((c: any) => c.command && c.description);
    if (commands.length === 0) return "Error: set_bot_commands requires at least one valid command.";
    const resp = await fetch(`https://api.telegram.org/bot${ctx.botToken}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands }),
    });
    const body = await resp.text();
    return `setMyCommands: ${resp.status} ${body.slice(0, 1000)}`;
  }
}
