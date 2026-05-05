import type OpenAI from "openai";
import type { RunContext } from "./RunContext";

export type ToolStepKind =
  | "thinking"
  | "reading"
  | "writing"
  | "editing"
  | "searching"
  | "shell"
  | "fetch"
  | "db"
  | "telegram"
  | "deploying"
  | "configuring"
  | "skill"
  | "ask"
  | "visual"
  | "done";

export type ToolStepTarget = { file?: string; range?: string; url?: string; key?: string };

export interface AgentTool {
  /**
   * Return the OpenAI-format tool definition sent to the model.
   * The `function.name` field is used as the key for dispatch.
   */
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool;

  /**
   * Execute the tool with the parsed arguments.
   * Must return a string that will be sent back to the model as the tool result.
   * To terminate the agent loop (e.g. finish()), call ctx.terminate(result) before returning.
   */
  execute(args: Record<string, any>, ctx: RunContext): Promise<string>;

  /**
   * Optional: return extra metadata to attach to the step_end event.
   * Called after execute() — args and result are both available.
   */
  getStepMeta?(args: Record<string, any>, result: string): Record<string, any>;
}
