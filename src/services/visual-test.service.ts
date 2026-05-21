import { chromium } from "playwright";
import { getOpenRouterClient } from "./openrouter.service";
import { config } from "../config";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ConsoleEntry {
  type: "log" | "info" | "warn" | "error" | "debug";
  text: string;
  url?: string;
  line?: number;
}

export interface NetworkError {
  url: string;
  status?: number;
  statusText?: string;
  failure?: string;
}

/** A single step in a visual-test scenario. */
export type ScenarioStep =
  | { target: string; type: "click" }
  | { target: string; type: "input"; value: string }
  | { delay: number };

export interface VisualTestResult {
  /** Base64-encoded PNG screenshot */
  screenshotBase64: string;
  /** All console entries captured during the test */
  consoleLogs: ConsoleEntry[];
  /** Only console.error() and unhandled JS errors */
  consoleErrors: ConsoleEntry[];
  /** Failed network requests */
  networkErrors: NetworkError[];
  /** Unhandled page-level JS errors */
  pageErrors: string[];
  /** Errors from scenario step execution (e.g. element not found) */
  scenarioErrors: string[];
  /** Page title at time of capture */
  pageTitle: string;
  /** Final URL (after any redirects) */
  finalUrl: string;
  /** Whether Playwright considered the page fully loaded */
  loadedSuccessfully: boolean;
  /** AI verdict from vision model */
  verdict: VisualVerdict;
  /** Raw ms taken for the browser session */
  durationMs: number;
}

export interface VisualVerdict {
  /** "pass" | "warn" | "fail" */
  status: "pass" | "warn" | "fail";
  /** 1-sentence headline */
  headline: string;
  /** Detailed multi-line analysis */
  analysis: string;
  /** Specific issues found */
  issues: string[];
  /** Suggestions for improvement */
  suggestions: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Core visual test runner
// ─────────────────────────────────────────────────────────────────────────────

export async function runVisualTest(
  url: string,
  options: {
    /** Viewport width. Default: 390 (iPhone 14) */
    viewportWidth?: number;
    /** Viewport height. Default: 844 */
    viewportHeight?: number;
    /** Max ms to wait for load. Default: 15000 */
    timeout?: number;
    /** Extra ms to let JS finish rendering after load (before scenario). Default: 2000 */
    settleMs?: number;
    /** Whether to emulate Telegram dark theme CSS vars. Default: true */
    emulateTelegram?: boolean;
    /** Optional sequence of interactions to run after page load. */
    scenario?: ScenarioStep[];
    /**
     * Raw initData string (query-string format, e.g. from buildSignedInitData).
     * When provided, it is appended to the URL as #tgWebAppData=... so the
     * AF SDK _parseMockHash() picks it up natively, fixing 401 errors.
     */
    initDataHash?: string;
  } = {},
): Promise<VisualTestResult> {
  const {
    viewportWidth = 390,
    viewportHeight = 844,
    timeout = 15000,
    settleMs = 2000,
    emulateTelegram = true,
    scenario,
    initDataHash,
  } = options;

  const start = Date.now();

  // Build the full URL with Telegram hash so AF SDK _parseMockHash() works
  const navigationUrl = initDataHash
    ? `${url}#tgWebAppData=${encodeURIComponent(initDataHash)}&tgWebAppVersion=9.6&tgWebAppPlatform=ios`
    : url;

  const consoleLogs: ConsoleEntry[] = [];
  const networkErrors: NetworkError[] = [];
  const pageErrors: string[] = [];
  const scenarioErrors: string[] = [];
  let loadedSuccessfully = false;
  let pageTitle = "";
  let finalUrl = url;

  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Telegram/10.0.0",
      isMobile: true,
      // Inject x-telegram-init-data on EVERY request so backend auth middleware
      // can populate req.telegramUser regardless of whether the app uses AF SDK
      // or some custom fetch path. This is the most reliable way to fix 401s
      // in visual tests — bypass all client-side SDK logic and stamp the header
      // at the network layer.
      ...(initDataHash
        ? { extraHTTPHeaders: { "x-telegram-init-data": initDataHash } }
        : {}),
    });

    const page = await context.newPage();

    // ── Inject mock Telegram.WebApp BEFORE page load ─────────────────────
    // initData is intentionally empty — when initDataHash is provided via URL
    // hash (#tgWebAppData=...) the AF SDK _parseMockHash() picks it up and
    // uses it for all AF.api() calls, solving the 401 issue.

    await page.route("**/telegram-web-app.js", (route) => route.fulfill({ body: "/* stub */", contentType: "application/javascript" }));

    await page.addInitScript(() => {
      const tg: any = {
        initData: "",
        initDataUnsafe: {
          user: {
            id: 999999999,
            first_name: "VisualTest",
            last_name: "Bot",
            username: "visual_test_bot",
            language_code: "en",
          },
          auth_date: Math.floor(Date.now() / 1000),
          hash: "visualtest_fake_hash_dev_only",
        },
        version: "7.0",
        platform: "ios",
        colorScheme: "dark",
        themeParams: {
          bg_color: "#1c1c1e",
          text_color: "#ffffff",
          hint_color: "#8e8e93",
          link_color: "#0a84ff",
          button_color: "#0a84ff",
          button_text_color: "#ffffff",
          secondary_bg_color: "#2c2c2e",
        },
        isExpanded: true,
        viewportHeight: 844,
        viewportStableHeight: 844,
        isClosingConfirmationEnabled: false,
        BackButton: { isVisible: false, onClick: () => {}, offClick: () => {}, show: () => {}, hide: () => {} },
        MainButton: { text: "", color: "#0a84ff", textColor: "#ffffff", isVisible: false, isActive: true, isProgressVisible: false, setText: () => tg.MainButton, onClick: () => tg.MainButton, offClick: () => tg.MainButton, show: () => tg.MainButton, hide: () => tg.MainButton, enable: () => tg.MainButton, disable: () => tg.MainButton, showProgress: () => tg.MainButton, hideProgress: () => tg.MainButton, setParams: () => tg.MainButton },
        HapticFeedback: { impactOccurred: () => tg.HapticFeedback, notificationOccurred: () => tg.HapticFeedback, selectionChanged: () => tg.HapticFeedback },
        expand: () => {},
        close: () => {},
        ready: () => {},
        sendData: () => {},
        openLink: () => {},
        openTelegramLink: () => {},
        showPopup: () => {},
        showAlert: () => {},
        showConfirm: () => {},
        enableClosingConfirmation: () => {},
        disableClosingConfirmation: () => {},
        onEvent: () => {},
        offEvent: () => {},
        setHeaderColor: () => {},
        setBackgroundColor: () => {},
        requestWriteAccess: () => {},
        requestContact: () => {},
      };
      (globalThis as any).Telegram = { WebApp: tg };
    });

    // ── Console listener ────────────────────────────────────────────────────
    page.on("console", (msg) => {
      const type = msg.type() as ConsoleEntry["type"];
      const location = msg.location();
      consoleLogs.push({
        type,
        text: msg.text(),
        url: location?.url,
        line: location?.lineNumber,
      });
    });

    // ── Page error (unhandled JS exceptions) ────────────────────────────────
    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    // ── Network failures ────────────────────────────────────────────────────
    page.on("requestfailed", (req) => {
      networkErrors.push({
        url: req.url(),
        failure: req.failure()?.errorText,
      });
    });
    page.on("response", (resp) => {
      const status = resp.status();
      if (status >= 400) {
        networkErrors.push({
          url: resp.url(),
          status,
          statusText: resp.statusText(),
        });
      }
    });

    // ── Navigate ────────────────────────────────────────────────────────────
    try {
      await page.goto(navigationUrl, { waitUntil: "networkidle", timeout });
      loadedSuccessfully = true;
    } catch (navErr: any) {
      pageErrors.push(`Navigation error: ${navErr.message}`);
    }

    // ── Inject Telegram-like CSS variables ──────────────────────────────────
    if (emulateTelegram) {
      await page.addStyleTag({
        content: `
          :root {
            --tg-theme-bg-color: #1c1c1e;
            --tg-theme-text-color: #ffffff;
            --tg-theme-hint-color: #8e8e93;
            --tg-theme-link-color: #0a84ff;
            --tg-theme-button-color: #0a84ff;
            --tg-theme-button-text-color: #ffffff;
            --tg-theme-secondary-bg-color: #2c2c2e;
            --tg-theme-accent-text-color: #0a84ff;
            --tg-viewport-height: 844px;
            --tg-viewport-stable-height: 844px;
          }
        `,
      }).catch(() => {});
    }

    // ── Wait for JS to settle before scenario ───────────────────────────────
    if (settleMs > 0) {
      await page.waitForTimeout(settleMs);
    }

    // ── Execute scenario steps ──────────────────────────────────────────────
    if (scenario && scenario.length > 0) {
      for (let i = 0; i < scenario.length; i++) {
        const step = scenario[i];
        try {
          if ("delay" in step) {
            await page.waitForTimeout(step.delay);
          } else if (step.type === "click") {
            await page.locator(step.target).first().click({ timeout: 5000 });
          } else if (step.type === "input") {
            await page.locator(step.target).first().fill(step.value, { timeout: 5000 });
          }
        } catch (stepErr: any) {
          const label = "delay" in step
            ? `step[${i}] delay`
            : `step[${i}] ${step.type} on "${(step as any).target}"`;
          scenarioErrors.push(`${label}: ${stepErr.message}`);
        }
      }
      // Short settle after interactions for animations/network
      await page.waitForTimeout(600);
    }

    finalUrl = page.url();
    pageTitle = await page.title().catch(() => "");

    // ── Screenshot ──────────────────────────────────────────────────────────
    const screenshotBuffer = await page.screenshot({
      type: "png",
      fullPage: false,
      clip: { x: 0, y: 0, width: viewportWidth, height: viewportHeight },
    });

    await context.close();

    const screenshotBase64 = screenshotBuffer.toString("base64");
    const consoleErrors = consoleLogs.filter((l) => l.type === "error");

    // ── AI verdict ──────────────────────────────────────────────────────────
    const verdict = await analyzeWithClaude({
      screenshotBase64,
      consoleErrors,
      networkErrors,
      pageErrors,
      scenarioErrors,
      pageTitle,
      url,
      scenario,
    });

    return {
      screenshotBase64,
      consoleLogs,
      consoleErrors,
      networkErrors,
      pageErrors,
      scenarioErrors,
      pageTitle,
      finalUrl,
      loadedSuccessfully,
      verdict,
      durationMs: Date.now() - start,
    };
  } finally {
    await browser.close();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Vision analysis via OpenRouter (provider-agnostic)
// ─────────────────────────────────────────────────────────────────────────────

async function analyzeWithClaude(input: {
  screenshotBase64: string;
  consoleErrors: ConsoleEntry[];
  networkErrors: NetworkError[];
  pageErrors: string[];
  scenarioErrors: string[];
  pageTitle: string;
  url: string;
  scenario?: ScenarioStep[];
}): Promise<VisualVerdict> {
  const client = getOpenRouterClient();

  const errorSummary = [
    input.consoleErrors.length > 0
      ? `Console errors:\n${input.consoleErrors.map((e) => `  - ${e.text}`).join("\n")}`
      : "",
    input.networkErrors.length > 0
      ? `Network errors:\n${input.networkErrors.map((e) => `  - [${e.status ?? "FAIL"}] ${e.url} ${e.failure ?? ""}`).join("\n")}`
      : "",
    input.pageErrors.length > 0
      ? `Page JS errors:\n${input.pageErrors.map((e) => `  - ${e}`).join("\n")}`
      : "",
    input.scenarioErrors.length > 0
      ? `Scenario step errors:\n${input.scenarioErrors.map((e) => `  - ${e}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const scenarioDescription = input.scenario && input.scenario.length > 0
    ? `\nA test scenario was executed after page load:\n${input.scenario.map((s, i) => {
        if ("delay" in s) return `  ${i + 1}. wait ${s.delay}ms`;
        if (s.type === "click") return `  ${i + 1}. click "${s.target}"`;
        if (s.type === "input") return `  ${i + 1}. type "${s.value}" into "${s.target}"`;
        return `  ${i + 1}. unknown step`;
      }).join("\n")}\nThe screenshot shows the state AFTER this scenario completed.\n`
    : "";

  const prompt = `You are a senior UI/UX reviewer doing a thorough visual inspection of a Telegram Mini App screenshot (390×844px mobile viewport).
This runs in a headless browser with a mock Telegram session. Auth (401/403) errors = real failures.

Page: "${input.pageTitle}" — ${input.url}
${scenarioDescription}
${errorSummary ? `Runtime errors:\n${errorSummary}\n` : "No runtime errors.\n"}

Inspect the screenshot like a designer doing QA. Check ALL of the following:

LAYOUT & ALIGNMENT
- Are any elements clipped or cut off at the screen edges (left, right, top, bottom)?
- Is the main content properly centered or aligned as intended?
- Are there stray/orphan elements floating in unexpected positions?
- Does content overflow its container (text spilling out, buttons outside their parent)?

SPACING & SIZING
- Is spacing between elements consistent and intentional?
- Are buttons appropriately sized (large enough to tap, not too small)?
- Is padding correct on all sides — no content touching the screen edge without margin?

SAFE AREA & OVERLAP
- Does any content overlap or sit under the bottom system bar / navigation bar?
- Does content sit under the Telegram header / status bar at the top?

TYPOGRAPHY
- Is all text readable (not too small, not clipped, not overflowing)?
- Are font sizes proportional and consistent?

VISUAL DESIGN QUALITY
- Does the color scheme look intentional and polished?
- Are buttons clearly distinguishable (primary vs secondary)?
- Does the overall design look finished, or does it look like a rough prototype?

DATA & STATE
- Is real data showing, or placeholder/empty states where data is expected?
- Are there loading spinners stuck in a loading state?

API ERRORS
- Are there 401/403 errors? If yes, auth is broken.
- Are there 4xx/5xx errors preventing content from loading?
${input.scenario && input.scenario.length > 0 ? "\nSCENARIO RESULT\n- Did the interactions produce expected visible changes?" : ""}

For each issue found, describe it concisely AND suggest the specific fix (e.g. "Logo clipped on left — add padding-left: 16px to .header").

Respond ONLY with a JSON object (no markdown, no extra text):
{
  "status": "pass" | "warn" | "fail",
  "headline": "one sentence summary of overall UI quality",
  "analysis": "2-4 sentence description of what you see — layout, design quality, data state, any errors",
  "issues": ["specific issue + fix hint", "..."],
  "suggestions": ["improvement idea", "..."]
}

Scoring:
- "pass" = layout correct, no clipping, design looks polished, no API errors
- "warn" = minor issues (spacing off, small overlaps, non-critical errors) but app is usable
- "fail" = elements clipped/broken, blank screen, critical overlap, 401/403, app is unusable or looks unfinished`;

  try {
    const response = await client.chat.completions.create({
      model: "google/gemini-3.5-flash",
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${input.screenshotBase64}`,
              },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    });

    const raw = response.choices?.[0]?.message?.content || "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in AI response");

    const parsed = JSON.parse(jsonMatch[0]) as VisualVerdict;
    if (!Array.isArray(parsed.issues)) parsed.issues = [];
    if (!Array.isArray(parsed.suggestions)) parsed.suggestions = [];
    return parsed;
  } catch (err: any) {
    console.error("[VisualTest] AI analysis failed:", err.message);
    const hasErrors =
      input.consoleErrors.length > 0 ||
      input.networkErrors.length > 0 ||
      input.pageErrors.length > 0 ||
      input.scenarioErrors.length > 0;
    return {
      status: hasErrors ? "warn" : "pass",
      headline: "AI analysis unavailable — manual review needed",
      analysis: `Vision analysis failed: ${err.message}`,
      issues: [...input.pageErrors, ...input.scenarioErrors],
      suggestions: [],
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Format result as a readable string (for agent tool output)
// ─────────────────────────────────────────────────────────────────────────────

export function formatVisualTestResult(result: VisualTestResult): string {
  const statusEmoji =
    result.verdict.status === "pass"
      ? "✅"
      : result.verdict.status === "warn"
        ? "⚠️"
        : "❌";

  const lines: string[] = [
    `${statusEmoji} Visual Test: ${result.verdict.status.toUpperCase()}`,
    `📋 ${result.verdict.headline}`,
    ``,
    `🔍 Analysis:`,
    result.verdict.analysis,
  ];

  if (result.verdict.issues.length > 0) {
    lines.push(``, `🐛 Issues found:`);
    for (const issue of result.verdict.issues) lines.push(`  • ${issue}`);
  }

  if (result.verdict.suggestions.length > 0) {
    lines.push(``, `💡 Suggestions:`);
    for (const s of result.verdict.suggestions) lines.push(`  • ${s}`);
  }

  if (result.scenarioErrors.length > 0) {
    lines.push(``, `🎭 Scenario step errors (${result.scenarioErrors.length}):`);
    for (const e of result.scenarioErrors) lines.push(`  ✗ ${e}`);
  }

  if (result.consoleErrors.length > 0) {
    lines.push(``, `🔴 Console errors (${result.consoleErrors.length}):`);
    for (const e of result.consoleErrors.slice(0, 5))
      lines.push(`  [${e.type}] ${e.text.substring(0, 150)}`);
    if (result.consoleErrors.length > 5)
      lines.push(`  ... and ${result.consoleErrors.length - 5} more`);
  }

  if (result.networkErrors.length > 0) {
    lines.push(``, `🌐 Network errors (${result.networkErrors.length}):`);
    for (const e of result.networkErrors.slice(0, 5))
      lines.push(`  [${e.status ?? "FAIL"}] ${e.url.substring(0, 100)}`);
  }

  if (result.pageErrors.length > 0) {
    lines.push(``, `💥 Page JS errors (${result.pageErrors.length}):`);
    for (const e of result.pageErrors.slice(0, 3))
      lines.push(`  ${e.substring(0, 200)}`);
  }

  lines.push(
    ``,
    `📸 Page: "${result.pageTitle}" | Loaded: ${result.loadedSuccessfully ? "yes" : "no"} | ${result.durationMs}ms`,
  );

  return lines.join("\n");
}
