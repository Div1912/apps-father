import { getOpenRouterClient } from "../openrouter.service";
import type { RouterTool } from "./tools/impl/router/RouterTool";
import type { RouterContext } from "./tools/impl/router/RouterContext";

export interface RouterRunnerOpts {
  modelCfg: any;
  systemPrompt: string;
  messages: any[];
  tools: RouterTool[];
  ctx: RouterContext;
  /** Streamed assistant text (for "thinking" UX bubble). */
  onChunk?: (delta: string, full: string) => void;
  /** Called when the router invokes a tool (before the result is available). */
  onToolCall?: (toolName: string) => void;
  telegramId?: string;
  sessionId?: string;
}

export interface RouterRunnerResult {
  /** Final free-text the model produced (used as "speak" answer when no proposal was emitted). */
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** Sum of `usage.cost` across iterations. 0 if OR didn't return cost. */
  costUsd: number;
  costUsdInput: number;
  costUsdOutput: number;
  /** True iff `propose_action` was called (terminal tool). */
  proposed: boolean;
}

/**
 * Lightweight runner for the conversational router.
 *
 * Mirrors the AskRunner shape: a small tool-use loop on a cheap model.
 * The loop terminates when:
 *   - the model returns no tool calls (free-text answer), OR
 *   - the `propose_action` tool sets ctx.proposalEmitted = true, OR
 *   - we hit the maxIterations limit from modelCfg.
 */
export class RouterRunner {
  async run(opts: RouterRunnerOpts): Promise<RouterRunnerResult> {
    const { modelCfg, systemPrompt, tools, ctx, onChunk, onToolCall } = opts;

    const toolMap = new Map<string, RouterTool>(tools.map(t => [t.name, t]));
    const openAiTools = tools.map(t => t.definition);

    const messages: any[] = [...opts.messages];
    const reasoningBudget = (modelCfg as any).reasoningBudget ?? 0;
    const maxIterations: number = (modelCfg as any).maxIterations ?? 8;
    const client = getOpenRouterClient();

    let fullText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let costUsdInput = 0;
    let costUsdOutput = 0;

    for (let iter = 0; iter < maxIterations; iter++) {
      const isLastIter = iter === maxIterations - 1;
      const iterNote = `[Iteration ${iter + 1}/${maxIterations}]`;

      // On the final iteration, force propose_action so the router always ends
      // with a decision rather than running out of budget silently.
      const toolChoice: any = isLastIter
        ? { type: "function", function: { name: "propose_action" } }
        : "auto";

      // Append a lightweight system note so the model knows its budget.
      const iterSystemMsg = {
        role: "system" as const,
        content: isLastIter
          ? `${iterNote} ⚠️ FINAL ITERATION — you MUST call propose_action NOW. No more reading or questions allowed.`
          : `${iterNote} You have ${maxIterations - iter - 1} iteration(s) remaining after this. Reserve the last iteration for propose_action.`,
      };

      const params: any = {
        model: modelCfg.modelId,
        max_tokens: modelCfg.maxTokens,
        messages: [{ role: "system", content: systemPrompt }, ...messages, iterSystemMsg],
        tools: openAiTools,
        tool_choice: toolChoice,
        ...(opts.telegramId ? { user: opts.telegramId } : {}),
        // Opt into OpenRouter usage accounting — see AskRunner / AgentRunner.
        extra_body: { session_id: opts.sessionId, usage: { include: true } },
        ...(this._getProviderRouting(modelCfg.modelId, modelCfg.provider)
          ? { provider: this._getProviderRouting(modelCfg.modelId, modelCfg.provider) }
          : {}),
        ...(reasoningBudget > 0 ? { reasoning: { max_tokens: reasoningBudget } } : {}),
      };

      let response: any;
      try {
        response = await this._streamCall(params, (delta) => {
          fullText += delta;
          if (onChunk) onChunk(delta, fullText);
        });
      } catch (err) {
        console.warn("[Router] Tool streaming failed, falling back:", (err as Error).message);
        const fallback = await client.chat.completions.create({
          ...params, tools: undefined, tool_choice: undefined,
        } as any) as any;
        const txt = fallback.choices?.[0]?.message?.content || "";
        if (txt) { fullText += txt; if (onChunk) onChunk(txt, fullText); }
        if (fallback.usage) {
          inputTokens += fallback.usage.prompt_tokens || 0;
          outputTokens += fallback.usage.completion_tokens || 0;
          costUsd += Number(fallback.usage.cost) || 0;
          costUsdInput += Number(fallback.usage.cost_details?.upstream_inference_prompt_cost) || 0;
          costUsdOutput += Number(fallback.usage.cost_details?.upstream_inference_completions_cost) || 0;
        }
        break;
      }

      if (response.usage) {
        inputTokens += response.usage.prompt_tokens || 0;
        outputTokens += response.usage.completion_tokens || 0;
        costUsd += Number(response.usage.cost) || 0;
        costUsdInput += Number(response.usage.cost_details?.upstream_inference_prompt_cost) || 0;
        costUsdOutput += Number(response.usage.cost_details?.upstream_inference_completions_cost) || 0;
      }

      const choice = response.choices?.[0];
      const assistantMsg: any = choice?.message || {};
      const toolCalls = assistantMsg.tool_calls || [];

      messages.push({
        role: "assistant",
        content: assistantMsg.content || "",
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      });

      if (toolCalls.length === 0 || choice?.finish_reason === "stop") break;

      let proposalEmittedThisTurn = false;
      for (const tc of toolCalls) {
        let argsObj: any = {};
        try { argsObj = JSON.parse(tc.function?.arguments || "{}"); } catch {}
        const tool = toolMap.get(tc.function?.name || "");
        if (onToolCall && tc.function?.name) onToolCall(tc.function.name);
        const toolResult = tool
          ? await tool.execute(argsObj, ctx).catch(err => `Tool error: ${err.message}`)
          : `Unknown tool: ${tc.function?.name}`;
        messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
        if (ctx.proposalEmitted) proposalEmittedThisTurn = true;
      }

      if (proposalEmittedThisTurn) break;
    }

    return {
      text: fullText,
      inputTokens,
      outputTokens,
      costUsd,
      costUsdInput,
      costUsdOutput,
      proposed: ctx.proposalEmitted,
    };
  }

  private _getProviderRouting(_modelId: string, provider?: string): any | undefined {
    const sel = provider?.trim();
    return sel ? { only: [sel], allow_fallbacks: false } : undefined;
  }

  private async _streamCall(params: any, onTextDelta: (delta: string) => void): Promise<any> {
    const client = getOpenRouterClient();
    const stream = (await client.chat.completions.create({
      ...params, stream: true, stream_options: { include_usage: true },
    } as any)) as any;

    let assistantText = "";
    const toolCallAcc = new Map<number, { id?: string; name: string; args: string }>();
    let usage: any;
    let finishReason: string | null = null;
    let modelEcho: string | undefined;
    let id: string | undefined;

    for await (const chunk of stream as AsyncIterable<any>) {
      if (!chunk) continue;
      if (chunk.id) id = chunk.id;
      if (chunk.model) modelEcho = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta || {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        assistantText += delta.content;
        try { onTextDelta(delta.content); } catch {}
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls as any[]) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          const acc = toolCallAcc.get(idx) || { name: "", args: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = (acc.name || "") + tc.function.name;
          if (tc.function?.arguments) acc.args += tc.function.arguments;
          toolCallAcc.set(idx, acc);
        }
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }

    const tool_calls = [...toolCallAcc.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, v]) => ({ id: v.id || `call_${idx}`, type: "function" as const, function: { name: v.name, arguments: v.args || "{}" } }));

    const fakeMessage: any = { role: "assistant", content: assistantText };
    if (tool_calls.length > 0) fakeMessage.tool_calls = tool_calls;

    return {
      id: id || "stream",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: modelEcho || params.model,
      choices: [{ index: 0, message: fakeMessage, finish_reason: finishReason || (tool_calls.length > 0 ? "tool_calls" : "stop"), logprobs: null }],
      usage,
    };
  }
}
