import type { AgentTool } from "../AgentTool";

// ── Filesystem tools ──────────────────────────────────────────────────────────
import { ListFilesTool } from "./impl/filesystem/ListFilesTool";
import { ReadFileTool } from "./impl/filesystem/ReadFileTool";
import { WriteFileTool } from "./impl/filesystem/WriteFileTool";
import { EditFileTool } from "./impl/filesystem/EditFileTool";
import { GrepTool } from "./impl/filesystem/GrepTool";
import { ShellTool } from "./impl/filesystem/ShellTool";
import { FetchUrlTool } from "./impl/filesystem/FetchUrlTool";

// ── Build / workflow tools ────────────────────────────────────────────────────
import { TechnicalPlanTool } from "./impl/build/TechnicalPlanTool";
import { DbTool } from "./impl/build/DbTool";
import { DeployToDevTool } from "./impl/build/DeployToDevTool";
import { LoadSkillTool } from "./impl/build/LoadSkillTool";
import { AskUserTool } from "./impl/build/AskUserTool";
import { ServerLogsTool } from "./impl/build/ServerLogsTool";
import { SimulateTelegramTool } from "./impl/build/SimulateTelegramTool";
import { SimulateApiTool } from "./impl/build/SimulateApiTool";
import { SimulateWsTool } from "./impl/build/SimulateWsTool";
import { SetBotCommandsTool } from "./impl/build/SetBotCommandsTool";
import { ConfigureAppTool } from "./impl/build/ConfigureAppTool";
import { FinishTool } from "./impl/build/FinishTool";

/**
 * All agent tool instances. Each exposes renderDefinition() (OpenAI schema)
 * and execute(args, ctx) (implementation). The AgentRunner builds the dispatch
 * map from these at run time.
 */
export const AGENT_TOOL_INSTANCES: AgentTool[] = [
  new ListFilesTool(),
  new ReadFileTool(),
  new WriteFileTool(),
  new EditFileTool(),
  new GrepTool(),
  new ShellTool(),
  new FetchUrlTool(),
  new TechnicalPlanTool(),
  new DbTool(),
  new DeployToDevTool(),
  new LoadSkillTool(),
  new AskUserTool(),
  new ServerLogsTool(),
  new SimulateTelegramTool(),
  new SimulateApiTool(),
  new SimulateWsTool(),
  new SetBotCommandsTool(),
  new ConfigureAppTool(),
  new FinishTool(),
];

/** OpenRouter server tools — executed transparently by OpenRouter. */
export const SERVER_TOOLS: any[] = [
  { type: "openrouter:datetime" },
  { type: "openrouter:web_search", parameters: { max_results: 5, max_total_results: 15 } },
  { type: "openrouter:web_fetch" },
  { type: "openrouter:image_generation" },
];
