import type { AskContext } from "../ask/AskContext";
import type { AgentComplexity } from "../../../../runtime-config.service";

/**
 * The kind of action the proposal card asks the user to confirm.
 * Maps 1-to-1 with AgentSessionType from runtime-config.service.
 *  - answer       : just an answer bubble, no follow-up agent run (free)
 *  - build        : create a new app from scratch (priced by complexity)
 *  - update       : one focused change to the app (priced by complexity)
 *  - update-plan  : multi-step change with a plan list (priced by complexity + per-item)
 *  - bug-fix      : diagnose + fix a reported bug (priced by complexity)
 *  - suggestions  : free-form suggestions, no agent run triggered (free)
 *  - paid-feature : the requested feature is gated behind a paid feature unlock — show
 *                   a card directing the user to the Paid Features page (free, no agent run)
 */
export type ProposalKind = "answer" | "build" | "update" | "update-plan" | "bug-fix" | "suggestions" | "paid-feature";

export type ProposalComplexity = AgentComplexity;

export interface QuestionnaireResult {
  answer: string;
}

/**
 * Hooks the RouterRunner uses to talk back to the chat (questionnaire bubbles,
 * proposal cards). Server wires these to chatService + WS broadcast.
 */
export interface RouterChatHooks {
  /**
   * Post a question bubble and block until the user answers (or skips/times out).
   */
  askQuestion(question: string, options: string[]): Promise<QuestionnaireResult>;

  /**
   * Persist + broadcast the final proposal card. Called exactly once by
   * `propose_action`. After this returns, the loop terminates.
   */
  emitProposal(proposal: {
    kind: ProposalKind;
    title: string;
    description: string;
    /** Plan steps for update-plan */
    plan?: string[];
    /** Brief / app description for build */
    brief?: string;
    /** Pre-resolved prompt sent to the agent if the user clicks Start */
    prefilledPrompt?: string;
    /** Credit cost computed from session pricing (0 for free sessions). */
    creditsCost: number;
    /**
     * Complexity bucket the router classified this request into. Determines
     * which column of the agentPricing matrix produced creditsCost. Required
     * for paid kinds (build / update / update-plan / bug-fix), undefined for
     * free kinds (answer / suggestions).
     */
    complexity?: ProposalComplexity;
    /**
     * Markup applied to creditsCost when the user toggles MAX MODE on the
     * card. Frontend uses this to render the live "with-MAX" price; the
     * server uses runtimeConfig.getMaxModeMultiplier() at execute time to
     * resist client tampering, so this is purely informational.
     */
    maxModeMultiplier?: number;
    /**
     * For kind="paid-feature" — id of the locked feature in the catalog
     * (PAID_FEATURES). Frontend uses this to deep-link the user into
     * /features and pre-highlight the relevant card.
     */
    featureId?: string;
  }): Promise<{ proposalId: string }>;

  /**
   * Stream a "thinking" / progress detail to the chat.
   * Optional — purely cosmetic.
   */
  emitThinking?(detail: string): void;
}

/**
 * Mutable per-run context for the RouterRunner.
 */
export interface RouterContext extends AskContext {
  hooks: RouterChatHooks;

  /** Set to true by ProposeActionTool to terminate the loop. */
  proposalEmitted: boolean;

  /** Number of questionnaire turns used so far. */
  questionnaireCount: number;
}
