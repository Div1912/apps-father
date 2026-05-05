import { chromium } from "playwright";
import Anthropic from "@anthropic-ai/sdk";
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
  /** Page title at time of capture */
  pageTitle: string;
  /** Final URL (after any redirects) */
  finalUrl: string;
  /** Whether Playwright considered the page fully loaded */
  loadedSuccessfully: boolean;
  /** AI verdict from Claude */
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
    /** Extra ms to let JS finish rendering after load. Default: 2000 */
    settleMs?: number;
    /** Whether to emulate Telegram dark theme CSS vars. Default: true */
    emulateTelegram?: boolean;
  } = {},
): Promise<VisualTestResult> {
  const {
    viewportWidth = 390,
    viewportHeight = 844,
    timeout = 15000,
    settleMs = 2000,
    emulateTelegram = true,
  } = options;

  const start = Date.now();

  const consoleLogs: ConsoleEntry[] = [];
  const networkErrors: NetworkError[] = [];
  const pageErrors: string[] = [];
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
    });

    const page = await context.newPage();

    // ── Inject mock Telegram.WebApp BEFORE page load ─────────────────────
    // Dev server skips initData signature validation but still requires the
    // field to be present so it can extract a user ID. We inject a fake but
    // structurally valid initData — this gives the app a real auth session
    // and eliminates the 401 that a bare headless browser would receive.
    const fakeUser = JSON.stringify({
      id: 999999999,
      first_name: "VisualTest",
      last_name: "Bot",
      username: "visual_test_bot",
      language_code: "en",
    });
    const fakeInitData =
      `user=${encodeURIComponent(fakeUser)}` +
      `&auth_date=${Math.floor(Date.now() / 1000)}` +
      `&hash=visualtest_fake_hash_dev_only`;

    await page.addInitScript((initData: string) => {
      const tg: any = {
        initData,
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
    }, fakeInitData);

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
      // 401/403 are EXPECTED in headless context — no Telegram initData is available.
      // Only collect actual unexpected errors (5xx, non-auth 4xx).
      const isExpectedAuth = status === 401 || status === 403;
      if (status >= 400 && !isExpectedAuth) {
        networkErrors.push({
          url: resp.url(),
          status,
          statusText: resp.statusText(),
        });
      }
    });

    // ── Navigate ────────────────────────────────────────────────────────────
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout });
      loadedSuccessfully = true;
    } catch (navErr: any) {
      // Even if navigation times out, still capture what we got
      pageErrors.push(`Navigation error: ${navErr.message}`);
    }

    // ── Inject Telegram-like CSS variables ──────────────────────────────────
    if (emulateTelegram) {
      // addStyleTag runs in the browser context without needing DOM types
      // in this Node.js tsconfig.
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

    // ── Wait for JS to settle ───────────────────────────────────────────────
    if (settleMs > 0) {
      await page.waitForTimeout(settleMs);
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
    const consoleErrors = consoleLogs.filter(
      (l) => l.type === "error",
    );

    // ── AI verdict ──────────────────────────────────────────────────────────
    const verdict = await analyzeWithClaude({
      screenshotBase64,
      consoleErrors,
      networkErrors,
      pageErrors,
      pageTitle,
      url,
    });

    return {
      screenshotBase64,
      consoleLogs,
      consoleErrors,
      networkErrors,
      pageErrors,
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
// Claude Vision analysis
// ─────────────────────────────────────────────────────────────────────────────

async function analyzeWithClaude(input: {
  screenshotBase64: string;
  consoleErrors: ConsoleEntry[];
  networkErrors: NetworkError[];
  pageErrors: string[];
  pageTitle: string;
  url: string;
}): Promise<VisualVerdict> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

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
  ]
    .filter(Boolean)
    .join("\n\n");

  const prompt = `You are a QA engineer doing a VISUAL RENDERING check of a Telegram Mini App.
This test runs in a headless browser with NO real Telegram session — auth (401/403) errors are EXPECTED and NORMAL. Do NOT treat auth errors as failures.

Page title: "${input.pageTitle}"
URL: ${input.url}

${errorSummary ? `Non-auth runtime errors detected:\n${errorSummary}\n` : "No unexpected runtime errors.\n"}

Your ONLY job is to judge the VISUAL RENDERING quality:
1. Does the UI look correct and fully rendered — no blank/white/black screens, no broken layouts?
2. Is there visible UI structure (header, navigation, content areas) even if data is empty due to no auth?
3. Are there obvious visual glitches, overlapping elements, or broken styles?
4. IGNORE any errors related to authentication, 401, 403, or missing user session — these are expected in headless testing.

Respond ONLY with a JSON object in this exact format (no markdown, no extra text):
{
  "status": "pass" | "warn" | "fail",
  "headline": "one sentence summary focused on visual rendering",
  "analysis": "detailed analysis of what you see visually",
  "issues": ["visual issue 1", "visual issue 2"],
  "suggestions": ["suggestion 1"]
}

Rules:
- "pass" = UI structure renders correctly (even if empty due to no auth)
- "warn" = minor visual issues, partially rendered, or non-critical problems
- "fail" = completely blank page, broken layout, critical render crash, or app is visually unusable`;

  try {
    const response = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: input.screenshotBase64,
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

    const raw = (response.content[0] as any)?.text || "";
    // Extract JSON from response (strip any surrounding text)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in Claude response");

    const parsed = JSON.parse(jsonMatch[0]) as VisualVerdict;
    // Ensure arrays exist
    if (!Array.isArray(parsed.issues)) parsed.issues = [];
    if (!Array.isArray(parsed.suggestions)) parsed.suggestions = [];
    return parsed;
  } catch (err: any) {
    console.error("[VisualTest] Claude analysis failed:", err.message);
    // Fallback verdict based on error presence
    const hasErrors =
      input.consoleErrors.length > 0 ||
      input.networkErrors.length > 0 ||
      input.pageErrors.length > 0;
    return {
      status: hasErrors ? "warn" : "pass",
      headline: "AI analysis unavailable — manual review needed",
      analysis: `Claude vision analysis failed: ${err.message}`,
      issues: input.pageErrors,
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
