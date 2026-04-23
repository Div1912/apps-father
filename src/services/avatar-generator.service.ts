import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";

/**
 * AI avatar generator for app icons.
 *
 * Two-step pipeline:
 *   1. Claude Haiku turns the (often vague) app description into a detailed
 *      iOS-style logo prompt tailored for Nano-Banana 2.
 *   2. The prompt is submitted to ApiPass (`google/nano-banana-2` model). We
 *      then poll the job until `state === "success"` (or fails / times out)
 *      and return the resulting image URL.
 *
 * The image generation typically completes in 15-45 seconds.
 */

const APIPASS_BASE = "https://api.apipass.dev/api/v1";
const POLL_INTERVAL_MS = 10_000;
const MAX_POLL_ATTEMPTS = 18; // 18 × 10 s = 3 min max

const PROMPT_SAMPLE = `A professional 1:1 modern iOS-style logotype icon for an app called "Swipe", which is for "Crypto Wallet". The icon is a single, stylized, minimalist 3D symbol centered on a pure, seamless gradient background. The symbol is rendered in a vibrant glassmorphism style with deep internal layering and a soft volumetric radial gradient. The icon features subtle glowing contours and sharp specular highlights for a high-end neomorphic effect. Strictly no text, no letters, no plates, and no phone screens. Only the central glass symbol on a clean white field. 4k, ultra-sharp focus.`;

let anthropicClient: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: config.anthropicApiKey });
  }
  return anthropicClient;
}

/**
 * Step 1 — ask Haiku to draft a Nano-Banana logo prompt for this app.
 * Returns just the raw prompt string (no markdown wrappers).
 */
export async function buildLogoPrompt(appDescription: string, appName?: string): Promise<string> {
  const userPrompt = `Make a prompt for Nano Banana 2 for making a logo for Telegram Bot Avatar
You should know that prompt following the style of modern logos, like ios modern logo, you should indicate in prompt: what colors of background, and main logo element on center by description the app

App Name: ${appName || "Unnamed App"}
App Description: ${appDescription || "(no description provided)"}

Prompt sample: ${PROMPT_SAMPLE}

Return only the prompt as text. No markdown, no preamble, no quotes.`;

  const response = await getAnthropic().messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 800,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
  if (!text) throw new Error("Haiku returned empty prompt");
  return text;
}

interface ApiPassCreateResponse {
  code: number;
  message: string;
  data?: { taskId: string };
}

interface ApiPassRecordResponse {
  code: number;
  message: string;
  data?: {
    taskId: string;
    state: "pending" | "running" | "success" | "failed" | string;
    failCode?: string;
    failMsg?: string;
    resultJson?: { resultUrls?: string[] };
  };
}

/** Step 2a — submit a generation job. */
async function createApiPassTask(prompt: string): Promise<string> {
  const res = await fetch(`${APIPASS_BASE}/jobs/createTask`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiPassKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "google/nano-banana-2",
      input: {
        prompt,
        resolution: "1K",
        image_input: [],
        aspect_ratio: "1:1",
        image_search: false,
        google_search: false,
        output_format: "jpg",
      },
    }),
  });

  const data = (await res.json()) as ApiPassCreateResponse;
  if (!res.ok || data.code !== 200 || !data.data?.taskId) {
    throw new Error(`ApiPass createTask failed: ${data.message || res.statusText}`);
  }
  return data.data.taskId;
}

/** Step 2b — poll the task until success / failure / timeout. */
async function pollApiPassTask(taskId: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    // Wait BEFORE the first poll too — nano-banana takes ~15 s minimum.
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const url = `${APIPASS_BASE}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.apiPassKey}` },
    });
    const data = (await res.json()) as ApiPassRecordResponse;

    if (!res.ok || data.code !== 200 || !data.data) {
      console.warn(`[AvatarGen] Poll error for ${taskId}: ${data.message || res.statusText}`);
      continue;
    }

    const state = data.data.state;
    if (state === "success") {
      const url = data.data.resultJson?.resultUrls?.[0];
      if (!url) throw new Error("ApiPass returned success without result URL");
      return url;
    }
    if (state === "failed") {
      throw new Error(`ApiPass generation failed: ${data.data.failMsg || data.data.failCode || "unknown"}`);
    }
    // pending / running — keep polling
  }
  throw new Error("ApiPass generation timed out");
}

/**
 * End-to-end: description → Haiku prompt → ApiPass image URL.
 * Throws on any upstream failure or timeout.
 */
export async function generateAvatarUrl(appDescription: string, appName?: string): Promise<{
  imageUrl: string;
  prompt: string;
}> {
  const prompt = await buildLogoPrompt(appDescription, appName);
  console.log(`[AvatarGen] Built prompt (${prompt.length} chars)`);

  const taskId = await createApiPassTask(prompt);
  console.log(`[AvatarGen] ApiPass task ${taskId} submitted, polling…`);

  const imageUrl = await pollApiPassTask(taskId);
  console.log(`[AvatarGen] Task ${taskId} succeeded → ${imageUrl}`);

  return { imageUrl, prompt };
}
