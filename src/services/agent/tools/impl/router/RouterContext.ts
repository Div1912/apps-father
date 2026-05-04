import type { AskContext } from "../ask/AskContext";

/**
 * The kind of action the proposal card asks the user to confirm.
 * Maps 1-to-1 with AgentSessionType from runtime-config.service.
 *  - answer      : just an answer bubble, no follow-up agent run (free)
 *  - build       : create a new app from scratch (100 credits)
 *  - update      : one focused change to the app (85 credits)
 *  - update-plan : multi-step change with a plan list (50 + N×25 credits)
 *  - bug-fix     : diagnose + fix a reported bug (30 credits)
 *  - suggestions : free-form suggestions, no agent run triggered (free)
 */
export type ProposalKind = "answer" | "build" | "update" | "update-plan" | "bug-fix" | "suggestions";

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
    /** Credit cost computed from session pricing (0 for free sessions) */
    creditsCost: number;
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
