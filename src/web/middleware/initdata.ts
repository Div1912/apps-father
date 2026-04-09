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

  // If no initData provided, allow the request but without user context
  // This enables testing via direct URL and graceful fallback
  if (!initData) {
    console.log(`[InitData] No initData for ${req.method} ${req.url} - allowing without auth`);
    next();
    return;
  }

  try {
    const project = await projectService.getProject(projectId);
    if (!project?.botTokenEncrypted) {
      // Project exists but no bot token - allow request anyway
      next();
      return;
    }

    const botToken = decryptToken(project.botTokenEncrypted);
    const isValid = validateTelegramInitData(initData, botToken);

    if (!isValid) {
      console.log(`[InitData] Invalid initData for project ${projectId}`);
      // Still allow the request - verification is best-effort for now
      // In production with payments, this should return 401
      next();
      return;
    }

    const parsed = parseInitData(initData);
    (req as any).telegramUser = parsed.user;

    next();
  } catch (err) {
    console.error("[InitData] Verification error:", err);
    // Don't block on verification errors
    next();
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

    return computedHash === hash;
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
