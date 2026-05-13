import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { projectService } from "../../services/project.service";
import { decryptToken } from "../../services/crypto.service";

export async function verifyInitData(req: Request, res: Response, next: NextFunction) {
  const rawHeader = req.headers["x-telegram-init-data"] || 
                    req.headers["authorization"]?.replace("Bearer ", "") || "";
  const initData = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;

  const projectId = String(req.params.projectId);
  if (!projectId) {
    res.status(400).json({ error: "Missing project ID" });
    return;
  }

  (req as any).projectId = projectId;

  // If no initData at all — allow through, but no user context.
  if (!initData) {
    next();
    return;
  }

  // Always parse the user out of initData so req.telegramUser is populated
  // even when we cannot verify the signature (no bot token yet, dev mode, etc.)
  const parsedUser = parseInitDataUser(initData);
  if (parsedUser) {
    (req as any).telegramUser = parsedUser;
  }

  // Skip HMAC verification for dev API endpoints — unverified user set above is enough.
  if (req.originalUrl?.includes("/devapi/")) {
    next();
    return;
  }

  try {
    const project = await projectService.getProject(projectId);
    if (!project?.botTokenEncrypted) {
      // No bot token configured yet — user is set from raw initData above.
      next();
      return;
    }

    const botToken = decryptToken(project.botTokenEncrypted);
    const isValid = validateTelegramInitData(initData, botToken);

    if (!isValid) {
      res.status(401).json({ error: "Not Authorized" });
      return;
    } else {
      // Full parse when hash is valid (includes all fields, not just user).
      const parsed = parseInitData(initData);
      (req as any).telegramUser = parsed.user;
      
      next();
    }
  } catch (err) {
    console.error("[InitData] Verification error:", err);

    res.status(401).json({ error: "Not Authorized" });
    return;
  }
}

function validateTelegramInitData(initData: string, botToken: string): boolean {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return false;

    params.delete("hash");
    const entries = Array.from(params.entries());
    entries.sort(([a], [b]) => a.localeCompare(b));
    const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");

    const secretKey = crypto
      .createHmac("sha256", "WebAppData")
      .update(botToken)
      .digest();

    const computedHash = crypto
      .createHmac("sha256", secretKey)
      .update(dataCheckString)
      .digest("hex");

    if (computedHash.length !== hash.length) return false;
    return crypto.timingSafeEqual(Buffer.from(computedHash, "hex"), Buffer.from(hash, "hex"));
  } catch {
    return false;
  }
}

function parseInitData(initData: string): any {
  const params = new URLSearchParams(initData);
  const result: any = {};

  for (const [key, value] of params.entries()) {
    try {
      result[key] = JSON.parse(value);
    } catch {
      result[key] = value;
    }
  }

  return result;
}

// Fast extraction of just the `user` object from initData — no crypto, used as
// an unverified fallback when the project has no bot token configured yet.
function parseInitDataUser(initData: string): any {
  try {
    const params = new URLSearchParams(initData);
    const userStr = params.get("user");
    if (!userStr) return null;
    return JSON.parse(userStr);
  } catch {
    return null;
  }
}
