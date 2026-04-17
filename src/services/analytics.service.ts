import { OpenPanel } from "@openpanel/sdk";
import { config } from "../config";

// Singleton OpenPanel instance — no-ops gracefully when credentials are missing
const op = new OpenPanel({
  clientId: config.openPanelClientId,
  clientSecret: config.openPanelClientSecret,
});

/**
 * Parses the Telegram start/startapp parameter.
 * Formats supported:
 *   "source|123456789"  → { source: "source", referrerId: "123456789" }
 *   "campaign_name"     → { source: "campaign_name", referrerId: null }
 *   "123456789"         → { source: null, referrerId: "123456789" }
 */
export function parseStartParam(param: string | null | undefined): {
  source: string | null;
  referrerId: string | null;
} {
  if (!param) return { source: null, referrerId: null };
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
