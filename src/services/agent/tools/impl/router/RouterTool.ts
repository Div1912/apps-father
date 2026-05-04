import type { RouterContext } from "./RouterContext";

/**
 * Same contract as AskTool but typed against RouterContext so the propose +
 * questionnaire tools can mutate state and call hooks.
 *
 * The read-only investigation tools (read_file, list_files, db_query, etc.)
 * are wrapped from the existing AskTool implementations via `wrapAskTool`.
 */
export interface RouterTool {
  name: string;
  definition: object;
  execute(args: Record<string, any>, ctx: RouterContext): Promise<string>;
}
