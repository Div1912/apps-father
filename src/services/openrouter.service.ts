import OpenAI from "openai";
import { config } from "../config";
import { runtimeConfig } from "./runtime-config.service";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Returns a fresh OpenAI client pointed at OpenRouter.
 * The API key is read from runtimeConfig at call time so admin changes
 * take effect immediately without restart.
 */
export function getOpenRouterClient(): OpenAI {
  const key = runtimeConfig.getOpenRouterApiKey() || config.openrouterApiKey;
  return new OpenAI({
    apiKey: key,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: {
      "HTTP-Referer": `https://${config.domain}`,
      "X-Title": "Apps Father",
    },
  });
}

/**
 * Thin model-pricing cache so we don't hit the OR catalog on every token
 * calculation. Refreshed lazily at most once per hour.
 */
interface ORModelPricing {
  promptPerToken: number;   // USD per input token
  completionPerToken: number; // USD per output token
}

const pricingCache = new Map<string, ORModelPricing>();
let pricingCacheTs = 0;
const PRICING_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function fetchOpenRouterPricing(): Promise<Map<string, ORModelPricing>> {
  const now = Date.now();
  if (pricingCache.size > 0 && now - pricingCacheTs < PRICING_TTL_MS) {
    return pricingCache;
  }

  try {
    const key = runtimeConfig.getOpenRouterApiKey() || config.openrouterApiKey;
    if (!key) return pricingCache;

    const resp = await fetch(`${OPENROUTER_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!resp.ok) return pricingCache;

    const data = await resp.json() as { data?: any[] };
    if (!data?.data) return pricingCache;

    pricingCache.clear();
    for (const m of data.data) {
      // OpenRouter returns pricing as USD per token (for example "0.000003").
      // Admin UI multiplies this by 1M only for display.
      const promptPerToken = Number(m.pricing?.prompt) || 0;
      const completionPerToken = Number(m.pricing?.completion) || 0;
      pricingCache.set(m.id as string, {
        promptPerToken,
        completionPerToken,
      });
    }
    pricingCacheTs = now;
  } catch {}

  return pricingCache;
}

/**
 * Get the USD-per-token pricing for a specific OpenRouter model ID.
 * Falls back to 0 if pricing is unavailable.
 */
export async function getModelPricing(modelId: string): Promise<ORModelPricing | null> {
  const cache = await fetchOpenRouterPricing();
  return cache.get(modelId) ?? null;
}

/**
 * Convert an Anthropic-style tool definition to the OpenAI function-calling format
 * that OpenRouter expects.
 */
export function toOpenAITool(tool: {
  name: string;
  description: string;
  input_schema: Record<string, any>;
}): OpenAI.Chat.Completions.ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}
