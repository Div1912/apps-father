import type OpenAI from "openai";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";
import { botRunnerService } from "../../../../bot-runner.service";

export class SimulateTelegramTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "simulate_telegram",
        description: "Simulate a Telegram update (message or callback_query) hitting the bot webhook WITHOUT a real Telegram account. The test user always gets id=-100. All tg() API calls the bot makes are intercepted and returned. Also logged so server_logs shows them. Use after deploy_to_dev to test the bot flow end-to-end.",
        parameters: {
          type: "object",
          properties: {
            update: {
              type: "object",
              description: "Telegram update object (message or callback_query). Omit update_id — it is auto-assigned.",
            },
          },
          required: ["update"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    const update = { ...(args.update || {}) };
    if (update.update_id == null) update.update_id = Date.now();
    if (update.message?.from) update.message = { ...update.message, from: { ...update.message.from, id: -100 } };
    if (update.callback_query?.from) update.callback_query = { ...update.callback_query, from: { ...update.callback_query.from, id: -100 } };

    const captured = await botRunnerService.simulateBotWebhook(ctx.projectId, update, { deployment: "development" });
    const requiresTelegramReply =
      ctx.runKind === "textBot" ||
      (ctx.runKind === "app" && Array.isArray(ctx.technicalPlan?.botBehavior) && ctx.technicalPlan.botBehavior.length > 0);
    const ok = !requiresTelegramReply || captured.length > 0;

    let result: string;
    if (ok) {
      ctx.testsRun.telegram = true;
      result = captured.length === 0
        ? "OK: Bot webhook processed update; no Telegram API call was required by the plan."
        : `OK: Captured ${captured.length} tg() call(s):\n` +
          captured.map((c: any, i: number) => `${i + 1}. ${c.method}(${JSON.stringify(c.body).slice(0, 300)})`).join("\n");
    } else {
      result = "Error: simulate_telegram expected at least one Telegram API call for the planned bot behavior, but captured none. Check backend/routes.js /bot-webhook and server_logs.";
    }
    ctx.testResults.push({ tool: "simulate_telegram", ok, detail: result.slice(0, 500) });
    return result;
  }
}
