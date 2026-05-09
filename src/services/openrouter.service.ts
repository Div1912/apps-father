import { config } from "../config";
import { runtimeConfig } from "./runtime-config.service";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterClient {
  chat: {
    completions: {
      create(params: any): Promise<any>;
    };
  };
}

function openRouterHeaders(apiKey: string, sessionId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": `https://${config.domain}`,
    "X-Title": "Apps Father",
    "X-OpenRouter-Title": "Apps Father",
    ...(sessionId ? { "x-session-id": sessionId } : {}),
  };
}

function normalizeOpenRouterBody(params: any): any {
  const { extra_body, ...rest } = params || {};
  // Older OpenAI SDK path used extra_body as a pass-through. Direct OpenRouter
  // requests should receive these fields at top-level (session_id, thinking, etc.).
  return {
    ...(extra_body || {}),
    ...rest,
  };
}

function normalizeOpenRouterJson(data: any): any {
  if (data?.error) {
    const err = data.error;
    const message = typeof err === "string"
      ? err
      : err.message || err.code || JSON.stringify(err).slice(0, 500);
    throw new Error(`OpenRouter error: ${message}`);
  }

  // Some proxy-style APIs wrap the completion in { data: ... }. Accept that
  // defensively so callers still receive the OpenAI-compatible shape.
  if (!Array.isArray(data?.choices) && Array.isArray(data?.data?.choices)) {
    return data.data;
  }

  if (!Array.isArray(data?.choices)) {
    throw new Error(`OpenRouter returned unexpected response: ${JSON.stringify(data).slice(0, 1000)}`);
  }

  return data;
}

async function* parseOpenRouterStream(resp: Response): AsyncGenerator<any> {
  const reader = (resp.body as any)?.getReader?.();
  if (!reader) throw new Error("OpenRouter streaming response has no readable body");

  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);

        for (const line of rawEvent.split(/\r?\n/)) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") return;
          const parsed = JSON.parse(data);
          if (parsed?.error) {
            const err = parsed.error;
            throw new Error(`OpenRouter stream error: ${err.message || JSON.stringify(err).slice(0, 500)}`);
          }
          yield parsed;
        }

        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    try { reader.releaseLock?.(); } catch {}
  }
}

/**
 * Returns a fresh OpenRouter client.
 * The API key is read from runtimeConfig at call time so admin changes
 * take effect immediately without restart.
 */
export function getOpenRouterClient(): OpenRouterClient {
  const key = runtimeConfig.getOpenRouterApiKey() || config.openrouterApiKey;
  return {
    chat: {
      completions: {
        async create(params: any): Promise<any> {
          const body = normalizeOpenRouterBody(params);
          const sessionId = body.session_id ? String(body.session_id) : undefined;
          const resp = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
            method: "POST",
            headers: openRouterHeaders(key, sessionId),
            body: JSON.stringify(body),
          });

          if (!resp.ok) {
            const text = await resp.text().catch(() => "");
            throw new Error(`OpenRouter ${resp.status}: ${text || resp.statusText}`);
          }

          if (body.stream) {
            return parseOpenRouterStream(resp);
          }
          let data: any;
          try {
            const text = await resp.text();
            data = JSON.parse(text);
          } catch (parseErr: any) {
            // Truncated or empty body — treat as a retryable network error
            throw new Error(`OpenRouter response parse error (truncated body): ${parseErr.message}`);
          }
          return normalizeOpenRouterJson(data);
        },
      },
    },
  };
}

/**
 * Thin model-pricing cache so we don't hit the OR catalog on every token
 * calculation. Refreshed lazily at most once per hour.
 */
interface ORModelPricing {
  promptPerToken: number;       // USD per input token (fresh)
  completionPerToken: number;   // USD per output token
  cacheReadPerToken: number;    // USD per cached input token (0 if not supported)
  cacheWritePerToken: number;   // USD per cache-write token (0 if not supported)
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
      // Cache read/write prices — OpenRouter exposes these for models that support
      // provider-level caching (e.g. MiniMax, Anthropic via OpenRouter, etc.)
      const cacheReadPerToken = Number(m.pricing?.input_cache_read) || 0;
      const cacheWritePerToken = Number(m.pricing?.input_cache_write) || 0;
      pricingCache.set(m.id as string, {
        promptPerToken,
        completionPerToken,
        cacheReadPerToken,
        cacheWritePerToken,
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
}): any {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}
