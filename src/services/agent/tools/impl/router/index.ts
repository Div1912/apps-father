import type { AskTool } from "../ask/AskTool";
import type { RouterTool } from "./RouterTool";
import type { RouterContext } from "./RouterContext";

export { QuestionnaireTool } from "./QuestionnaireTool";
export { ProposeActionTool } from "./ProposeActionTool";
export type { RouterTool } from "./RouterTool";
export type {
  RouterContext,
  RouterChatHooks,
  ProposalKind,
  QuestionnaireResult,
} from "./RouterContext";

/**
 * Adapt an AskTool (which only needs the read-only AskContext) so the router
 * can use it. Avoids duplicating ReadFile / ListFiles / DbQuery / etc.
 *
 * RouterContext extends AskContext, so the AskTool's execute method receives
 * a structurally-compatible object — no actual delegation needed beyond the
 * type erasure here.
 */
export function wrapAskTool(askTool: AskTool): RouterTool {
  return {
    name: askTool.name,
    definition: askTool.definition,
    execute(args: Record<string, any>, ctx: RouterContext): Promise<string> {
      return askTool.execute(args, ctx);
    },
  };
}
