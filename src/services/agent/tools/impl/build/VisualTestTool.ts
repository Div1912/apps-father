import crypto from "crypto";
import type OpenAI from "openai";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";
import { runVisualTest, formatVisualTestResult, type VisualTestResult, type ScenarioStep } from "../../../../../services/visual-test.service";
import { config } from "../../../../../config";

/**
 * Build a Telegram initData string for visual testing.
 *
 * The backend `verifyInitData` middleware populates `req.telegramUser` from
 * `parseInitDataUser(initData)` as long as the `user=...` field is present
 * and parseable — HMAC verification is logged but never blocks. So we send
 * a signed initData when the bot token is available (normal case), and fall
 * back to an unsigned-but-parseable initData when it isn't.
 */
function buildVisualTestInitData(botToken?: string): string {
  const user = JSON.stringify({
    id: 999999999,
    first_name: "VisualTest",
    last_name: "Bot",
    username: "visual_test_bot",
    language_code: "en",
    is_bot: false,
  });
  const authDate = Math.floor(Date.now() / 1000);

  let hash: string;
  if (botToken) {
    const dataCheckString = `auth_date=${authDate}\nuser=${user}`;
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
    hash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  } else {
    hash = "visualtest_unsigned";
  }
  return `auth_date=${authDate}&user=${encodeURIComponent(user)}&hash=${hash}`;
}

/**
 * VisualTestTool — launches a headless Chromium browser, optionally runs an
 * interaction scenario, screenshots the final state, captures console errors
 * and network failures, then asks Claude Vision whether the page looks correct.
 *
 * The agent should call this after deploy_to_dev() to verify the UI renders
 * properly before finishing.
 */
export class VisualTestTool implements AgentTool {
  private _lastResult: VisualTestResult | null = null;

  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "visual_test",
        description: `Launch a headless browser, optionally execute a sequence of UI interactions (clicks, inputs, delays), then screenshot the final state and capture all console errors / network failures / JS exceptions. Returns an AI verdict (pass/warn/fail) on visual correctness. Call this after deploy_to_dev() to verify the UI before finishing.`,
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: `URL path to test, relative to the project root (e.g. "/" or "/game"). Defaults to "/".`,
            },
            settle_ms: {
              type: "number",
              description: "Extra milliseconds to wait after page load for JS animations/data to settle before starting the scenario. Default: 2000.",
            },
            scenario: {
              type: "array",
              description: `Optional sequence of interactions to execute after page load. Each step is one of:
- { "target": "<css-selector>", "type": "click" } — click the element
- { "target": "<css-selector>", "type": "input", "value": "<text>" } — fill an input field
- { "delay": <ms> } — wait the given number of milliseconds
The screenshot is taken after all steps complete.`,
              items: {
                type: "object",
                description: "A single scenario step: click, input, or delay.",
              },
            },
          },
          required: [],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    this._lastResult = null;
    const pathArg: string = (args.path as string) || "/";
    const settleMs: number =
      typeof args.settle_ms === "number" ? args.settle_ms : 2000;
    const scenario: ScenarioStep[] | undefined = Array.isArray(args.scenario)
      ? (args.scenario as ScenarioStep[])
      : undefined;

    // Build the URL — guard against agent passing full URL or /dev/{id}/... prefix
    let normalizedPath = pathArg.startsWith("/") ? pathArg : `/${pathArg}`;
    let resolvedUrl: string;
    if (pathArg.startsWith("http")) {
      try {
        const u = new URL(pathArg);
        const devPrefix = `/dev/${ctx.projectId}`;
        const appPath = u.pathname.startsWith(devPrefix)
          ? u.pathname.slice(devPrefix.length) || "/"
          : u.pathname;
        resolvedUrl = `${config.baseUrl}/dev/${ctx.projectId}${appPath.startsWith("/") ? appPath : "/" + appPath}`;
      } catch {
        resolvedUrl = `${config.baseUrl}/dev/${ctx.projectId}/`;
      }
    } else {
      const devPrefix = `/dev/${ctx.projectId}`;
      if (normalizedPath.startsWith(devPrefix)) {
        normalizedPath = normalizedPath.slice(devPrefix.length) || "/";
        if (!normalizedPath.startsWith("/")) normalizedPath = "/" + normalizedPath;
      }
      resolvedUrl = `${config.baseUrl}/dev/${ctx.projectId}${normalizedPath}`;
    }
    const url = resolvedUrl;

    const scenarioLabel = scenario && scenario.length > 0
      ? ` + scenario (${scenario.length} steps)`
      : "";

    await ctx.progress({
      action: `🧪 Running visual test${scenarioLabel}`,
      detail: url,
      percent: ctx.currentPercent,
    });

    console.log(`[VisualTest] Testing ${url} (settle: ${settleMs}ms${scenarioLabel})`);

    // Build initData (signed if bot token available). Always provide one so
    // every outgoing request from the browser carries an x-telegram-init-data
    // header, ensuring `req.telegramUser` gets populated and /me-style routes
    // don't return 401.
    const visualTestInitData = buildVisualTestInitData(ctx.botToken);

    try {
      const result = await runVisualTest(url, {
        viewportWidth: 390,
        viewportHeight: 844,
        timeout: 20000,
        settleMs,
        emulateTelegram: true,
        scenario,
        initDataHash: visualTestInitData,
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

    if (args.scenario && Array.isArray(args.scenario)) {
      meta.scenarioSteps = args.scenario.length;
    }

    if (this._lastResult) {
      const r = this._lastResult;
      meta.screenshotBase64 = r.screenshotBase64;
      meta.headline = r.verdict.headline;
      meta.issues = r.verdict.issues.slice(0, 3);
      meta.consoleErrors = r.consoleErrors.length;
      meta.networkErrors = r.networkErrors.length;
      meta.pageErrors = r.pageErrors.length;
      meta.scenarioErrors = r.scenarioErrors.length;
      meta.loadedSuccessfully = r.loadedSuccessfully;
      meta.durationMs = r.durationMs;
    }

    return meta;
  }
}
