import type OpenAI from "openai";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";
import { loadSkill, getAvailableSkills } from "../../../instruction-loader";

export class LoadSkillTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "load_skill",
        description: "Load a skill document with detailed implementation patterns and best practices. Call when you need guidance for a specific feature (e.g. 'ton-payments', 'frontend', 'backend').",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Skill name to load" },
          },
          required: ["name"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    await ctx.progress({ action: "📚 Loading skill", detail: args.name, percent: ctx.currentPercent });
    const skillContent = loadSkill(args.name);
    if (skillContent && args.name) ctx.loadedSkills.add(String(args.name));
    return skillContent || `Error: Skill "${args.name}" not found. Available: ${getAvailableSkills().join(", ")}`;
  }

  getStepMeta(args: Record<string, any>): Record<string, any> {
    return args?.name ? { name: args.name } : {};
  }
}
