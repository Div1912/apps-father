import type OpenAI from "openai";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";
import { runVisualTest, formatVisualTestResult, type VisualTestResult } from "../../../../../services/visual-test.service";
import { config } from "../../../../../config";

/**
 * VisualTestTool — launches a headless Chromium browser, screenshots the
 * deployed app, captures console errors and network failures, then asks
 * Claude Vision whether the page looks correct.
 *
 * The agent should call this after deploy_to_dev() to verify the UI
 * renders properly before finishing.
 */
export class VisualTestTool implements AgentTool {
  /** Stored after execute() so getStepMeta can access screenshot + verdict. */
  private _lastResult: VisualTestResult | null = null;

  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "visual_test",
        description: `Launch an internal headless browser, screenshot the deployed app, capture all console errors / network failures / JS exceptions, then get an AI verdict (pass/warn/fail) on whether the page looks correct visually. Call this after deploy_to_dev() to verify the UI before finishing. Returns a detailed report with screenshot analysis.`,
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: `URL path to test, relative to the project root (e.g. "/" or "/game"). Defaults to "/". The full URL is auto-constructed from the project's dev URL.`,
            },
            settle_ms: {
              type: "number",
              description: "Extra milliseconds to wait after page load for JS animations/data to settle. Default: 2000.",
            },
          },
          required: [],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    this._lastResult = null;
    const path: string = (args.path as string) || "/";
    const settleMs: number =
      typeof args.settle_ms === "number" ? args.settle_ms : 2000;

    // Build the URL: use the dev URL for the project
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const url = `${config.baseUrl}/dev/${ctx.projectId}${normalizedPath}`;

    await ctx.progress({
      action: "🧪 Running visual test",
      detail: url,
      percent: ctx.currentPercent,
    });

    console.log(`[VisualTest] Testing ${url} (settle: ${settleMs}ms)`);

    try {
      const result = await runVisualTest(url, {
        viewportWidth: 390,
        viewportHeight: 844,
        timeout: 20000,
        settleMs,
        emulateTelegram: true,
      });

      this._lastResult = result;
      const formatted = formatVisualTestResult(result);

      // Save screenshot to project's bucket for reference
      try {
        const fs = await import("fs");
        const path_mod = await import("path");
        const screenshotDir = path_mod.join(
          process.cwd(),
          "bucket",
          ctx.projectId,
          "visual-tests",
        );
        fs.mkdirSync(screenshotDir, { recursive: true });
        const fname = `vt-${ctx.taskId}-${Date.now()}.png`;
        fs.writeFileSync(
          path_mod.join(screenshotDir, fname),
          Buffer.from(result.screenshotBase64, "base64"),
        );
        console.log(`[VisualTest] Screenshot saved: ${fname}`);
      } catch (saveErr: any) {
        console.warn(`[VisualTest] Screenshot save failed: ${saveErr.message}`);
      }

      return formatted;
    } catch (err: any) {
      const msg = `Visual test failed to run: ${err.message}`;
      console.error(`[VisualTest] ❌ ${msg}`);
      return `Error: ${msg}`;
    }
  }

  getStepMeta(args: Record<string, any>, result: string): Record<string, any> {
    const statusMatch = result.match(/Visual Test: (PASS|WARN|FAIL)/i);
    const status = statusMatch ? statusMatch[1].toLowerCase() : "error";
    const meta: Record<string, any> = {
      status,
      path: (args.path as string) || "/",
    };

    if (this._lastResult) {
      const r = this._lastResult;
      meta.screenshotBase64 = r.screenshotBase64;
      meta.headline = r.verdict.headline;
      meta.issues = r.verdict.issues.slice(0, 3);
      meta.consoleErrors = r.consoleErrors.length;
      meta.networkErrors = r.networkErrors.length;
      meta.pageErrors = r.pageErrors.length;
      meta.loadedSuccessfully = r.loadedSuccessfully;
      meta.durationMs = r.durationMs;
    }

    return meta;
  }
}
