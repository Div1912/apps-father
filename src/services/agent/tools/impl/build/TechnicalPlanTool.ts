import type OpenAI from "openai";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";

export class TechnicalPlanTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "technical_plan",
        description: "MANDATORY first planning tool for new builds. Submit the concrete implementation contract before writing code. List API routes (method, path, auth, input, output), WebSocket messages (direction/type/fields), DB keys (pattern + stored shape), and UI screens with their data/events. If the app needs external APIs, list them in externalDependencies and call ask_user first for any required credentials. After this, code must match the submitted names exactly.",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string", description: "One-sentence architecture summary" },
            dbKeys: { type: "array", items: { type: "object" }, description: "DB key contracts: key pattern + stored shape" },
            restEndpoints: { type: "array", items: { type: "object" }, description: "REST contracts: method, path, auth, input, output" },
            wsMessages: { type: "array", items: { type: "object" }, description: "WebSocket message contracts with direction/type/fields" },
            screens: { type: "array", items: { type: "object" }, description: "Frontend screens/components and their data/events" },
            botBehavior: { type: "array", items: { type: "object" }, description: "Optional bot commands/callback/deep-link behaviour" },
            testScenarios: { type: "array", items: { type: "object" }, description: "Test cases the agent must run with simulate_* before finish" },
            externalDependencies: { type: "array", items: { type: "object" }, description: "External APIs/providers used, whether credentials are required, and whether ask_user is needed before implementation" },
          },
          required: ["summary"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    ctx.technicalPlan = { ...args };
    ctx.technicalPlanSubmitted = true;
    return `OK: Technical plan accepted. Code must now follow this contract exactly.`;
  }
}
