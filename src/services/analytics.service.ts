import { OpenPanel } from "@openpanel/sdk";
import { config } from "../config";

// Singleton OpenPanel instance — no-ops gracefully when credentials are missing
const op = new OpenPanel({
  clientId: config.openPanelClientId,
  clientSecret: config.openPanelClientSecret,
});

/**
 * Reserved start_param values that are used by Apps Father itself for
 * intra-bot navigation (e.g. the user-bot's /start "back to Apps Father"
 * button). They must NEVER be persisted as utm_source / referrer because
 * they don't represent an external acquisition channel — they're internal
 * deep links our own UI emits. Add new sentinels here as we introduce them.
 */
export const RESERVED_START_PARAMS = new Set<string>([
  "open_dialog", // sent by the user-bot welcome card → open the most recent project's chat
]);

/**
 * Parses the Telegram start/startapp parameter.
 * Formats supported:
 *   "source|123456789"  → { source: "source", referrerId: "123456789" }
 *   "campaign_name"     → { source: "campaign_name", referrerId: null }
 *   "123456789"         → { source: null, referrerId: "123456789" }
 *
 * Reserved sentinels (see RESERVED_START_PARAMS) always return null/null
 * so they don't pollute attribution.
 */
export function parseStartParam(param: string | null | undefined): {
  source: string | null;
  referrerId: string | null;
} {
  if (!param) return { source: null, referrerId: null };
  if (RESERVED_START_PARAMS.has(param)) return { source: null, referrerId: null };
  if (param.includes("|")) {
    const [src, id] = param.split("|");
    return {
      source: src || null,
      referrerId: /^\d+$/.test(id || "") ? id : null,
    };
  }
  if (/^\d+$/.test(param)) return { source: null, referrerId: param };
  return { source: param, referrerId: null };
}

/**
 * Track a server-side event.
 * Note: identify is intentionally NOT done server-side — it runs on the
 * frontend so OpenPanel captures the user's real device, IP and location
 * (server identify would attribute every user to the server's location).
 */
export async function trackEvent(
  telegramId: number | string,
  event: string,
  properties?: Record<string, any>
): Promise<void> {
  if (!config.openPanelClientId) return;
  try {
    await op.track(event, {
      profileId: String(telegramId),
      ...(properties || {}),
    });
  } catch (e: any) {
    console.error("[Analytics] track error:", e.message);
  }
}

export { op as openPanel };
