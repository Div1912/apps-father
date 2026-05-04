import type OpenAI from "openai";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";
import { normalizeProjectKind } from "../../../types";

export class TechnicalPlanTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "technical_plan",
        description: "MANDATORY first planning tool for new builds. Submit the concrete implementation contract before writing code. The schema is kind-specific: App uses dbKeys/restEndpoints/wsMessages/screens; Text Bot uses stateShape/conversationFlow/keyboards/commands/testScenarios; Game uses coordinateSystem/sceneGraph/camera/input/collision/stateMachine/performanceBudget. If the app needs external APIs, list them in externalDependencies and call ask_user first for any required credentials. After this, code must match the submitted names exactly.",
        parameters: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["app", "game", "textBot"], description: "Project kind this plan targets" },
            summary: { type: "string", description: "One-sentence architecture summary" },
            dbKeys: { type: "array", items: { type: "object" }, description: "DB key contracts: key pattern + stored shape" },
            restEndpoints: { type: "array", items: { type: "object" }, description: "REST contracts: method, path, auth, input, output" },
            wsMessages: { type: "array", items: { type: "object" }, description: "WebSocket message contracts with direction/type/fields" },
            screens: { type: "array", items: { type: "object" }, description: "Frontend screens/components and their data/events" },
            botBehavior: { type: "array", items: { type: "object" }, description: "Optional bot commands/callback/deep-link behaviour for Mini Apps" },
            stateShape: { type: "object", description: "Text Bot state object stored under state:{uid}" },
            conversationFlow: { type: "array", items: { type: "object" }, description: "Text Bot steps/buttons/callbacks and transitions" },
            keyboards: { type: "array", items: { type: "object" }, description: "Text Bot reply/inline keyboards with exact button labels/callback_data" },
            commands: { type: "array", items: { type: "object" }, description: "Bot slash commands: command + description" },
            testScenarios: { type: "array", items: { type: "object" }, description: "Test cases the agent must run with simulate_* before finish" },
            externalDependencies: { type: "array", items: { type: "object" }, description: "External APIs/providers used, whether credentials are required, and whether ask_user is needed before implementation" },
            coordinateSystem: { type: "string", description: "Game coordinate system" },
            sceneGraph: { type: "array", items: { type: "object" }, description: "Game scene/group/object graph" },
            camera: { type: "object", description: "Game camera type/follow/smoothing" },
            input: { type: "array", items: { type: "object" }, description: "Game input mapping" },
            collision: { type: "object", description: "Game collision/win-loss rules" },
            stateMachine: { type: "array", items: { type: "string" }, description: "Game state machine" },
            performanceBudget: { type: "object", description: "Game FPS, pixel ratio, reuse/instancing budget" },
          },
          required: ["kind", "summary"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    ctx.technicalPlan = { ...args, kind: normalizeProjectKind(args.kind || ctx.runKind) };
    ctx.technicalPlanSubmitted = true;
    return `OK: Technical plan accepted for kind=${ctx.technicalPlan.kind}. Code must now follow this contract exactly.`;
  }
}
