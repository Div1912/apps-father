import OpenAI from "openai";
import { toOpenAITool } from "../../openrouter.service";
import { BUILD_TOOL_DEFS } from "./build-tools";
import { FILESYSTEM_TOOL_DEFS } from "./filesystem-tools";
import { AgentToolDefinition } from "./types";

export const AGENT_TOOL_DEFS: AgentToolDefinition[] = [
  ...FILESYSTEM_TOOL_DEFS,
  ...BUILD_TOOL_DEFS,
];

// Pre-converted OpenAI-format tools (computed once at startup).
export const AGENT_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = AGENT_TOOL_DEFS.map(toOpenAITool);

// OpenRouter server tools - executed transparently by OpenRouter before returning
// the response to the client. The model can call these; OpenRouter resolves them.
export const SERVER_TOOLS: any[] = [
  { type: "openrouter:datetime" },
  { type: "openrouter:web_search", parameters: { max_results: 5, max_total_results: 15 } },
  { type: "openrouter:web_fetch" },
  { type: "openrouter:image_generation" },
];
