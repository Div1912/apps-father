import type OpenAI from "openai";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";

export class FetchUrlTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "fetch_url",
        description: "Fetch a URL and return its text content. Strips HTML tags. Do NOT use for Apps Father project endpoints — use simulate_api/simulate_ws instead.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL to fetch" },
          },
          required: ["url"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    await ctx.progress({ action: "🔗 Fetching data...", detail: "", percent: ctx.currentPercent });
    try {
      const targetUrl = String(args.url || "");
      if (/^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/(?:devapi|api|dev|app)\//i.test(targetUrl)) {
        return "Error: Do not test Apps Father project endpoints with fetch_url or localhost URLs. Use deploy_to_dev(), then simulate_api/simulate_ws/simulate_telegram for project testing.";
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const resp = await fetch(targetUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; AppsBot/1.0)" },
        signal: controller.signal,
      });
      clearTimeout(timeout);

      const html = await resp.text();
      const text = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
      return text.substring(0, 12000);
    } catch (err: any) {
      console.error(`[Agent] fetch_url error:`, err.message);
      return `Error: ${err.message}`;
    }
  }

  getStepMeta(args: Record<string, any>): Record<string, any> {
    return args?.url ? { url: args.url } : {};
  }
}
