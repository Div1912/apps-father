import type OpenAI from "openai";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";

const ASK_TIMEOUT = 5 * 60 * 1000;

export class AskUserTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "ask_user",
        description: "Ask the app owner a question and wait for their answer. Use ONLY when you truly need user input (API keys, credentials, external account IDs, design choices, naming, or choosing between fundamentally different approaches). If a requested feature requires an API key/credential and no public no-key alternative exists, you MUST call ask_user instead of inventing placeholders, using process.env, or shipping fake/mock behavior. Do NOT use for trivial implementation details you can decide yourself. Provide options as buttons when possible. The user can also type free text or press Skip.",
        parameters: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question to ask the user" },
            options: { type: "array", items: { type: "string" }, description: "Optional list of choices shown as buttons (e.g. ['Option A', 'Option B'])" },
          },
          required: ["question"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    const question = args.question || "Please provide input:";
    const options: string[] = args.options || [];

    if (!ctx.onAskUser) {
      return "User interaction not available in this context. Make your best decision and continue.";
    }

    console.log(`[Agent] ❓ Asking user: ${question.substring(0, 100)}`);
    await ctx.progress({ action: "Waiting for your answer...", detail: question.substring(0, 80), percent: ctx.currentPercent });

    let timeoutId: ReturnType<typeof setTimeout>;
    const answer = await Promise.race([
      ctx.onAskUser(question, options),
      new Promise<string>(resolve => { timeoutId = setTimeout(() => resolve(""), ASK_TIMEOUT); }),
    ]);
    clearTimeout(timeoutId!);

    if (answer) {
      console.log(`[Agent] ✅ User answered: ${answer.substring(0, 100)}`);
      return `User answered: ${answer}`;
    }
    console.log(`[Agent] ⏭️ User skipped question`);
    return "User skipped this question. Proceed with your best judgment.";
  }
}
