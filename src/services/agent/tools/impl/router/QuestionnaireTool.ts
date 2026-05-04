import type { RouterTool } from "./RouterTool";
import type { RouterContext } from "./RouterContext";

const SOFT_CAP = 5;

/**
 * Lets the router ask the user one clarification question and wait for the
 * answer. Can be called any number of times until the model has enough info
 * to call propose_action.
 *
 * The answer is returned as the tool result string, so the model sees the
 * user's reply on its next turn and can decide whether to ask more, switch
 * intent, or finalize a proposal.
 */
export class QuestionnaireTool implements RouterTool {
  name = "questionnaire";
  definition = {
    type: "function",
    function: {
      name: "questionnaire",
      description:
        "Ask the user a single clarification question and wait for their answer. Use whenever you genuinely need missing context (which feature, which screen, what data shape, what design choice...). You can call this multiple times across turns — but ONLY ask things you can't infer from the chat history or by investigating files. Provide options as buttons when there is a small set of plausible answers; otherwise leave options empty for free text. Returns the user's answer as the tool result.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to ask, in the user's language. Keep it short and concrete.",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of suggested choices shown as buttons. Omit / empty array = free-text only.",
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
    },
  };

  async execute(args: Record<string, any>, ctx: RouterContext): Promise<string> {
    const question = (typeof args?.question === "string" ? args.question : "").trim();
    if (!question) return "Error: question is required.";

    const options = Array.isArray(args?.options)
      ? args.options.filter((o: any) => typeof o === "string" && o.trim()).map((o: string) => o.trim()).slice(0, 6)
      : [];

    if (ctx.questionnaireCount >= SOFT_CAP) {
      return `Error: questionnaire soft cap reached (${SOFT_CAP}). Stop asking and call propose_action with your best guess based on what you already know.`;
    }
    ctx.questionnaireCount++;

    const { answer } = await ctx.hooks.askQuestion(question, options);
    if (!answer) {
      return "User skipped this question. Proceed with your best judgment — do NOT ask the same question again.";
    }
    return `User answered: ${answer}`;
  }
}
