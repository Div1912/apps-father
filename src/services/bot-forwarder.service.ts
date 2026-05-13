import { Request, Response, NextFunction } from "express";
import * as crypto from "crypto";
import * as http from "http";
import { prisma } from "../db";
import { config } from "../config";
import { decryptToken } from "./crypto.service";
import { runnerManager } from "./runner-manager.service";

/**
 * Worker-mode replacement for `botRunnerService.getWebhookHandler`.
 *
 * Telegram POSTs to `/webhook/<tokenHash>`. In worker mode we no longer
 * instantiate grammY bots in the main process — instead we:
 *
 *   1. Match `tokenHash` to a project (using a lazily-built cache of
 *      `tokenHash → projectId`, decrypting bot tokens once per row).
 *   2. Lazy-spawn the project's worker via `runnerManager.ensureRunning()`.
 *   3. POST the raw update body to the worker's
 *      `/__worker/bot-update` endpoint with `X-Runner-Secret`.
 *
 * Returns the same `(req, res, next) => void` shape as the legacy
 * `getWebhookHandler(tokenHash)` so `webhook.routes.ts` stays unchanged.
 */
class BotForwarderService {
  /** tokenHash → projectId. Populated on demand; cleared on bot rotation. */
  private hashToProjectId = new Map<string, string>();

  /**
   * Single source of truth for the SHA-256 truncation. Identical to the legacy
   * `BotRunnerService.hashToken`.
   */
  hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex").substring(0, 16);
  }

  /** Used by token rotation flows so the next webhook re-resolves. */
  forgetTokenHash(hash: string) {
    this.hashToProjectId.delete(hash);
  }

  /** Drop the entire cache (e.g. after admin "stop-all" / mass rotation). */
  clearCache() {
    this.hashToProjectId.clear();
  }

  /**
   * Webhook handler factory mirroring `BotRunnerService.getWebhookHandler`.
   * Returns null when the tokenHash is not associated with any known project.
   *
   * The handler is async-resilient: any error returns 200 to Telegram so it
   * does not retry indefinitely. We log and surface failures via worker logs.
   */
  getWebhookHandler(
    tokenHash: string,
  ): ((req: Request, res: Response, next: NextFunction) => void) | null {
    // We do the actual project resolution inside the handler so that a stale
    // cache hit doesn't prevent rotation from taking effect on the next call.
    return async (req, res, _next) => {
      try {
        const projectId = await this.resolveProjectId(tokenHash);
        if (!projectId) {
          res.status(404).json({ error: "Bot not found" });
          return;
        }

        // Lazy-spawn worker if needed.
        let workerPort: number;
        try {
          const handle = await runnerManager.ensureRunning(projectId);
          workerPort = handle.port;
        } catch (err) {
          console.error(`[BotForwarder] worker unavailable for ${projectId}:`, (err as Error).message);
          // Telegram retries on 5xx, so respond 200 to drop the update — better
          // than retry storms while we triage.
          res.status(200).end();
          return;
        }

        await this.forwardUpdate(workerPort, req.body);
        res.status(200).end();
      } catch (err) {
        console.error(`[BotForwarder] dispatch error:`, err);
        // Same reasoning: 200 to suppress Telegram retry storms.
        res.status(200).end();
      }
    };
  }

  private async resolveProjectId(tokenHash: string): Promise<string | null> {
    const cached = this.hashToProjectId.get(tokenHash);
    if (cached) return cached;

    // Walk projects with bot tokens and rebuild matches. We only decrypt
    // tokens once per row per process boot; misses are rare.
    const projects = await prisma.project.findMany({
      where: { botTokenEncrypted: { not: null } },
      select: { id: true, botTokenEncrypted: true },
    });
    for (const p of projects) {
      if (!p.botTokenEncrypted) continue;
      try {
        const token = decryptToken(p.botTokenEncrypted);
        if (!token) continue;
        const h = this.hashToken(token);
        this.hashToProjectId.set(h, p.id);
      } catch {
        // Bad encryption — skip this row.
      }
    }
    return this.hashToProjectId.get(tokenHash) || null;
  }

  private forwardUpdate(workerPort: number, body: any): Promise<void> {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body || {}));
      const req = http.request(
        {
          host: "127.0.0.1",
          port: workerPort,
          path: "/__worker/bot-update",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(payload.length),
            "X-Runner-Secret": config.runnerSecret,
          },
          timeout: 10_000,
        },
        (res) => {
          // Drain so the socket can be reused.
          res.on("data", () => {});
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 500) {
              reject(new Error(`worker returned ${res.statusCode}`));
            } else {
              resolve();
            }
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("worker bot-update timeout")));
      req.on("error", reject);
      req.end(payload);
    });
  }
}

export const botForwarderService = new BotForwarderService();
