import crypto from "crypto";
import { config } from "../config";

const DESKTOP_TOKEN_SECRET = crypto.createHmac("sha256", "DesktopAuth").update(config.botToken).digest();

export function signDesktopToken(payload: { telegramId: number; username?: string; firstName?: string }): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", DESKTOP_TOKEN_SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}

export function verifyDesktopToken(token: string): { valid: boolean; telegramId?: number; username?: string; firstName?: string } {
  try {
    const [data, sig] = token.split(".");
    if (!data || !sig) return { valid: false };
    const expected = crypto.createHmac("sha256", DESKTOP_TOKEN_SECRET).update(data).digest("base64url");
    if (sig !== expected) return { valid: false };
    const payload = JSON.parse(Buffer.from(data, "base64url").toString());
    if (!payload.telegramId) return { valid: false };
    return { valid: true, telegramId: payload.telegramId, username: payload.username, firstName: payload.firstName };
  } catch { return { valid: false }; }
}
