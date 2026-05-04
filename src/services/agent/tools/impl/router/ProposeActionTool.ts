import type { RouterTool } from "./RouterTool";
import type { RouterContext, ProposalKind } from "./RouterContext";
import { runtimeConfig } from "../../../../../services/runtime-config.service";
import type { AgentSessionType } from "../../../../../services/runtime-config.service";

const VALID_KINDS: ProposalKind[] = ["answer", "build", "update", "update-plan", "bug-fix", "suggestions"];

/**
 * Terminal tool. The router calls this exactly once to classify the user's
 * intent and emit a proposal card. The card is shown immediately in the chat.
 *
 * Kinds:
 *  - answer      : answered in `description`; no agent run required (free)
 *  - suggestions : short list of ideas shown to user (free)
 *  - build       : create a new app; pass `brief` with the full app spec
 *  - update      : single focused change; pass `prefilledPrompt`
 *  - update-plan : multi-step change; pass `plan` array + `prefilledPrompt`
 *  - bug-fix     : fix a reported bug; pass `prefilledPrompt`
 *
 * After this returns, the runner sees ctx.proposalEmitted=true and stops.
 */
export class ProposeActionTool implements RouterTool {
  name = "propose_action";
  definition = {
    type: "function",
    function: {
      name: "propose_action",
      description:
        "Finalize the routing turn. Classify the user intent and emit a proposal card.\n" +
        " - 'answer'      : you already have the answer; put it in `description`. No agent run.\n" +
        " - 'suggestions' : you have helpful ideas / suggestions; put them in `description`. No agent run.\n" +
        " - 'build'       : user wants to create a new app. Put a detailed brief in `brief`.\n" +
        " - 'update'      : user wants one focused change. Put a self-contained prompt in `prefilledPrompt`.\n" +
        " - 'update-plan' : user wants multiple changes. List them in `plan` (array of strings). Also set `prefilledPrompt` with all items as context.\n" +
        " - 'bug-fix'     : user reported a bug. Diagnose in `description`, pass fix prompt in `prefilledPrompt`.\n" +
        "Rule: if the user lists MORE THAN ONE distinct change/feature, always use 'update-plan'.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: VALID_KINDS,
            description: "Session type this proposal will start.",
          },
          title: {
            type: "string",
            description: "Short headline for the card (max ~60 chars).",
          },
          description: {
            type: "string",
            description: "Body text shown to the user. For 'answer'/'suggestions' this IS the full response.",
          },
          plan: {
            type: "array",
            items: { type: "string" },
            description: "Required for 'update-plan': ordered list of change items.",
          },
          brief: {
            type: "string",
            description: "Required for 'build': full app spec / brief that drives code generation.",
          },
          prefilledPrompt: {
            type: "string",
            description: "Self-contained prompt sent to the agent on click. Required for 'update', 'update-plan', 'bug-fix', 'build'.",
          },
        },
        required: ["kind", "title", "description"],
        additionalProperties: false,
      },
    },
  };

  async execute(args: Record<string, any>, ctx: RouterContext): Promise<string> {
    const kind = String(args?.kind || "") as ProposalKind;
    const title = (args?.title || "").toString().trim().slice(0, 200);
    const description = (args?.description || "").toString().trim();
    const plan: string[] | undefined = Array.isArray(args?.plan)
      ? args.plan.filter((s: any) => typeof s === "string" && s.trim()).map((s: string) => s.trim().slice(0, 300))
      : undefined;
    const brief = typeof args?.brief === "string" ? args.brief.trim() : undefined;
    const prefilledPrompt = typeof args?.prefilledPrompt === "string" ? args.prefilledPrompt.trim() : undefined;

    if (!VALID_KINDS.includes(kind)) {
      return `Error: kind must be one of ${VALID_KINDS.join(", ")}. Got: ${kind}`;
    }
    if (!title) return "Error: title is required.";
    if (!description) return "Error: description is required.";

    if ((kind === "update" || kind === "bug-fix") && !prefilledPrompt) {
      return `Error: prefilledPrompt is required for kind='${kind}'.`;
    }
    if (kind === "update-plan") {
      if (!plan || plan.length === 0) return "Error: plan must be a non-empty array for kind='update-plan'.";
      if (!prefilledPrompt) return "Error: prefilledPrompt is required for kind='update-plan'.";
    }
    if (kind === "build" && !brief && !prefilledPrompt) {
      return "Error: brief (or prefilledPrompt) is required for kind='build'.";
    }
    if (ctx.proposalEmitted) {
      return "Error: a proposal was already emitted for this turn. Do not call propose_action again.";
    }

    const creditsCost = runtimeConfig.getSessionCost(kind as AgentSessionType, plan?.length);

    const { proposalId } = await ctx.hooks.emitProposal({
      kind, title, description, plan, brief, prefilledPrompt, creditsCost,
    });

    ctx.proposalEmitted = true;

    return `Proposal sent to user (id=${proposalId}, kind=${kind}, credits=${creditsCost}). Stop — do not call any more tools this turn.`;
  }
}
