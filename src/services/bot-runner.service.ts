import { Bot, webhookCallback } from "grammy";
import { Router } from "express";
import { config } from "../config";
import { projectService } from "./project.service";
import { decryptToken } from "./crypto.service";
import { runWithProject } from "./console-tagger.service";
import { prisma } from "../db";
import { Lang, t } from "../bot/i18n";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { Request, Response, NextFunction } from "express";

/**
 * Apps Father's own bot username, picked per-environment so user-bot deep
 * links land on the correct mini-app instance. Dev server uses the dev bot
 * (its mini-app domain is dev.apps-father.com), prod uses the main bot.
 */
function getFatherBotUsername(): string {
  return config.domain.startsWith("dev.") ? "apps_father_dev_bot" : "apps_father_bot";
}

interface ManagedBotInstance {
  bot: Bot;
  projectId: string;
  botUsername: string;
  webhookHandler: (req: Request, res: Response, next: NextFunction) => void;
}

export class BotRunnerService {
  private bots = new Map<string, ManagedBotInstance>();

  /**
   * Start (or re-start) the user's bot and register its webhook.
   *
   * @param sendOwnerWelcome When true, immediately push the "Good job, bot
   *   created" card to the owner via bot.api.sendMessage *after* the webhook
   *   is live. This covers the race where the user is bounced into their new
   *   bot by mobile Telegram and presses /start before our webhook is set —
   *   they'd otherwise get nothing. Pass `false` (the default) when restoring
   *   bots at server boot, or every old user would get spammed with the
   *   welcome card on every deploy.
   */
  async startBot(
    projectId: string,
    token: string,
    botUsername: string,
    sendOwnerWelcome = false,
  ): Promise<void> {
    if (this.bots.has(projectId)) {
      console.log(`[BotRunner] Bot for ${projectId} already running`);
      return;
    }

    const bot = new Bot(token);
    const appUrl = `${config.baseUrl}/app/${projectId}/`;

    bot.command("start", async (ctx) => {
      if (await this.hasCustomWebhook(projectId)) return;

      // Decide which welcome to send based on (a) deploy status and
      // (b) whether the sender is the project owner. We deliberately fetch
      // fresh project + owner data on every /start because it's a low-volume
      // command and stale cache here would either show the "app not ready"
      // card after deploy, or leak the owner-only nudge to a friend who
      // pressed /start in someone else's bot.
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
          releaseCommit: true,
          user: { select: { telegramId: true, language: true } },
        },
      });
      if (!project) return;

      const isReleased = project.releaseCommit !== null && project.releaseCommit !== undefined;
      const senderTelegramId = ctx.from?.id;
      const isOwner = !!senderTelegramId && BigInt(senderTelegramId) === project.user.telegramId;

      // Owner always gets the "back to Apps Father" nudge on /start —
      // they don't need a Launch App button in their own bot, they need
      // to get back into Apps Father to keep iterating on the app.
      // Under the new flow the project is already deployed when the bot
      // is linked, but the nudge is still the right surface for the owner.
      if (isOwner) {
        const lang = (project.user.language as Lang) || "en";
        const fatherBot = getFatherBotUsername();
        const backUrl = `https://t.me/${fatherBot}/app?startapp=open_dialog`;
        await ctx.reply(
          `<b>${t(lang, "user_bot_start_owner_title")}</b>\n${t(lang, "user_bot_start_owner_body")}`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: t(lang, "user_bot_start_owner_button"), url: backUrl, style: "primary" }],
              ],
            },
          },
        );
        return;
      }

      // Non-owner /start. If the app isn't deployed yet there's nothing
      // to launch, so stay silent. Otherwise hand them the standard
      // "Launch App" card.
      if (!isReleased) return;

      await ctx.reply(
        `Welcome! Tap the button below to launch the app.`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: "🚀 Launch App", web_app: { url: appUrl } }],
            ],
          },
        }
      );
    });

    // Handle pre_checkout_query — auto-approve all payments
    bot.on("pre_checkout_query" as any, async (ctx: any) => {
      try {
        const query = ctx.preCheckoutQuery || ctx.update.pre_checkout_query;
        if (query) {
          await ctx.answerPreCheckoutQuery(true);
          console.log(`[BotRunner] Pre-checkout approved for ${botUsername}, payload: ${query.invoice_payload}`);
        }
      } catch (err) {
        console.error(`[BotRunner] Error answering pre_checkout_query:`, err);
        try { await ctx.answerPreCheckoutQuery(false, { error_message: "Payment processing error" }); } catch {}
      }
    });

    // Handle successful_payment — process the payment
    bot.on("message:successful_payment" as any, async (ctx: any) => {
      try {
        const payment = ctx.message.successful_payment;
        const userId = ctx.from.id.toString();
        const invoicePayload = payment.invoice_payload;

        console.log(`[BotRunner] Payment received for ${botUsername}: user=${userId}, payload=${invoicePayload}, amount=${payment.total_amount} ${payment.currency}`);

        try {
          const path = require("path");
          const fs = require("fs");
          const dataDir = path.join(process.cwd(), "projects", projectId, "release", "data");
          if (fs.existsSync(path.join(dataDir, "app.db"))) {
            const sqlite = new Database(path.join(dataDir, "app.db"));
            sqlite.pragma("journal_mode = WAL");
            sqlite.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)");

            const getVal = (key: string) => {
              const row = sqlite.prepare("SELECT value FROM kv WHERE key = ?").get(key) as any;
              return row ? JSON.parse(row.value) : null;
            };
            const setVal = (key: string, value: any) => {
              sqlite.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
            };

            const pending = getVal("pending_purchases") || [];
            const purchase = pending.find((p: any) => p.invoiceId === invoicePayload && !p.processed);

            if (purchase) {
              const coinsToAdd = parseInt(purchase.coins) || 0;
              const purchaseUserId = purchase.userId;

              const users = getVal("users") || [];
              const user = users.find((u: any) => u.telegramId === purchaseUserId || u.user_id === purchaseUserId);
              if (user) {
                user.coins = (user.coins || 0) + coinsToAdd;
              }
              setVal("users", users);

              purchase.processed = true;
              purchase.processedAt = new Date().toISOString();
              setVal("pending_purchases", pending);

              sqlite.close();
              console.log(`[BotRunner] Payment processed: +${coinsToAdd} coins for user ${purchaseUserId}`);
              await ctx.reply(`🎉 Payment successful! +${coinsToAdd} coins added to your account!`);
            } else {
              sqlite.close();
              console.log(`[BotRunner] No pending purchase found for payload: ${invoicePayload}`);
              await ctx.reply(`✅ Payment received! Thank you.`);
            }
          } else {
            await ctx.reply(`✅ Payment received! Thank you.`);
          }
        } catch (dbErr) {
          console.error(`[BotRunner] DB error processing payment:`, dbErr);
          await ctx.reply(`✅ Payment received! Your purchase will be processed shortly.`);
        }
      } catch (err) {
        console.error(`[BotRunner] Error handling successful_payment:`, err);
      }
    });

    bot.on("message:text", async (ctx) => {
      if (await this.hasCustomWebhook(projectId)) return;

      // Same gating as /start: before deploy, only the owner gets a reply.
      // Without this, bots that aren't ready yet would noisily reply
      // "Tap the button below" and link to a /app/<id>/ URL that 404s.
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: {
          releaseCommit: true,
          user: { select: { telegramId: true } },
        },
      });
      if (!project) return;
      const isReleased = project.releaseCommit !== null && project.releaseCommit !== undefined;
      if (!isReleased) return;

      await ctx.reply("Tap the button below to open the app!", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🚀 Launch App", web_app: { url: appUrl } }],
          ],
        },
      });
    });

    bot.catch((err: any) => {
      console.error(`[BotRunner] Error in bot @${botUsername}:`, err);
    });

    const grammyHandler = webhookCallback(bot, "express");

    const webhookHandler = (req: Request, res: Response, next: NextFunction) => {
      const body = req.body;
      grammyHandler(req, res);
      this.forwardToAppWebhook(projectId, token, botUsername, body).catch(err => {
        console.error(`[BotRunner] Forward error for @${botUsername}:`, err.message);
      });
    };

    this.bots.set(projectId, { bot, projectId, botUsername, webhookHandler });

    if (config.nodeEnv === "production") {
      const tokenHash = this.hashToken(token);
      const webhookUrl = `${config.webhookUrl}/${tokenHash}`;
      await bot.api.setWebhook(webhookUrl, {
        secret_token: config.webhookSecret,
      });
      console.log(`[BotRunner] Webhook set for ${botUsername} -> ${webhookUrl}`);
    } else {
      bot.start({
        onStart: () => console.log(`[BotRunner] Polling started for @${botUsername}`),
      });
    }

    console.log(`[BotRunner] Bot @${botUsername} started for project ${projectId}`);

    if (sendOwnerWelcome) {
      // Fire-and-forget so a failure to DM the owner (blocked the bot,
      // restricted account, etc.) never breaks the create-bot flow.
      this.sendOwnerWelcome(bot, projectId, botUsername).catch((err) => {
        console.error(`[BotRunner] sendOwnerWelcome failed for @${botUsername}:`, err?.message || err);
      });
    }
  }

  /**
   * Push the localized "Good job, bot created" card directly to the owner
   * the moment the webhook is live. This covers the mobile race where
   * Telegram bounces the user into their freshly created bot and they tap
   * /start before our webhook has been registered — without this, the
   * /start update is dropped on the floor and the user sees nothing.
   */
  private async sendOwnerWelcome(bot: Bot, projectId: string, botUsername: string): Promise<void> {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        releaseCommit: true,
        user: { select: { telegramId: true, language: true } },
      },
    });
    if (!project) return;
    // We deliberately push regardless of releaseCommit: under the new flow
    // (bot creation happens AFTER the first build) the project is already
    // deployed when the bot is linked, but the owner still needs the
    // "back to Apps Father" nudge to continue editing / managing the app.
    // The legacy assumption that "deployed = nothing to nudge about" no
    // longer holds.

    const lang = (project.user.language as Lang) || "en";
    const fatherBot = getFatherBotUsername();
    const backUrl = `https://t.me/${fatherBot}/app?startapp=open_dialog`;
    const ownerId = Number(project.user.telegramId);
    if (!ownerId) return;

    try {
      await bot.api.sendMessage(
        ownerId,
        `<b>${t(lang, "user_bot_start_owner_title")}</b>\n${t(lang, "user_bot_start_owner_body")}`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: t(lang, "user_bot_start_owner_button"), url: backUrl, style: "primary" }],
            ],
          },
        },
      );
      console.log(`[BotRunner] Owner welcome sent via @${botUsername} to ${ownerId}`);
    } catch (err: any) {
      // 403 "bot was blocked by the user" is expected for some users — log
      // at info level rather than error so it doesn't pollute alerts.
      const code = err?.error_code || err?.statusCode;
      const desc = err?.description || err?.message;
      if (code === 403) {
        console.log(`[BotRunner] Owner welcome skipped for @${botUsername}: ${desc}`);
      } else {
        throw err;
      }
    }
  }

  async stopBot(projectId: string): Promise<void> {
    const instance = this.bots.get(projectId);
    if (!instance) return;

    try {
      await instance.bot.stop();
    } catch (err) {
      console.error(`[BotRunner] Error stopping bot for ${projectId}:`, err);
    }

    this.bots.delete(projectId);
    console.log(`[BotRunner] Bot stopped for project ${projectId}`);
  }

  getWebhookHandler(tokenHash: string): ((req: Request, res: Response, next: NextFunction) => void) | null {
    for (const instance of this.bots.values()) {
      const token = this.getTokenFromInstance(instance);
      if (token && this.hashToken(token) === tokenHash) {
        return instance.webhookHandler;
      }
    }
    return null;
  }

  async loadAllBots(): Promise<void> {
    console.log("[BotRunner] Loading all active project bots...");
    const projects = await projectService.getAllActiveProjects();

    for (const project of projects) {
      if (!project.botTokenEncrypted || !project.botUsername) continue;

      try {
        const token = decryptToken(project.botTokenEncrypted);
        await this.startBot(project.id, token, project.botUsername);
      } catch (err) {
        console.error(`[BotRunner] Failed to start bot for project ${project.id}:`, err);
      }
    }

    console.log(`[BotRunner] Loaded ${this.bots.size} bots`);
  }

  isRunning(projectId: string): boolean {
    return this.bots.has(projectId);
  }

  getRunningCount(): number {
    return this.bots.size;
  }

  private hashToken(token: string): string {
    const crypto = require("crypto");
    return crypto.createHash("sha256").update(token).digest("hex").substring(0, 16);
  }

  private getTokenFromInstance(instance: ManagedBotInstance): string | null {
    try {
      return (instance.bot as any).token;
    } catch {
      return null;
    }
  }

  /** Returns the webhook route path registered in routes.js, or null if none. */
  private getCustomWebhookPath(projectId: string): string | null {
    const routesFile = path.join(process.cwd(), "projects", projectId, "release", "backend", "routes.js");
    if (!fs.existsSync(routesFile)) return null;
    try {
      const content = fs.readFileSync(routesFile, "utf-8");
      // Check for explicit bot-webhook first, then fall back to generic /webhook route
      if (content.includes("bot-webhook")) return "/bot-webhook";
      if (/router\s*\.\s*post\s*\(\s*['"`]\/webhook['"`]/.test(content)) return "/webhook";
      return null;
    } catch {
      return null;
    }
  }

  private async hasCustomWebhook(projectId: string): Promise<boolean> {
    return this.getCustomWebhookPath(projectId) !== null;
  }

  private async forwardToAppWebhook(
    projectId: string,
    token: string,
    botUsername: string,
    body: any,
  ): Promise<void> {
    const projectDir = path.join(process.cwd(), "projects", projectId);
    const routesFile = path.join(projectDir, "release", "backend", "routes.js");
    if (!fs.existsSync(routesFile)) return;

    const webhookPath = this.getCustomWebhookPath(projectId);
    if (!webhookPath) return;

    // Tag console output produced by the project's webhook handler with
    // `[app:<projectId>]` so the log viewer can filter by project.
    return runWithProject(projectId, async () => {
    let db: any = null;
    try {
      delete require.cache[require.resolve(routesFile)];
      const routeModule = require(routesFile);
      if (typeof routeModule !== "function") return;

      const releaseDir = path.join(projectDir, "release");
      const dataDir = path.join(releaseDir, "data");
      fs.mkdirSync(dataDir, { recursive: true });
      const sqlite = new Database(path.join(dataDir, "app.db"));
      sqlite.pragma("journal_mode = WAL");
      sqlite.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)");

      db = {
        get(key: string) { const r = sqlite.prepare("SELECT value FROM kv WHERE key = ?").get(key) as any; return r ? JSON.parse(r.value) : null; },
        set(key: string, value: any) { sqlite.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, JSON.stringify(value)); },
        getAll() { const rows = sqlite.prepare("SELECT key, value FROM kv").all() as any[]; const res: Record<string, any> = {}; for (const row of rows) res[row.key] = JSON.parse(row.value); return res; },
        delete(key: string) { sqlite.prepare("DELETE FROM kv WHERE key = ?").run(key); },
        keys() { return (sqlite.prepare("SELECT key FROM kv").all() as any[]).map((r: any) => r.key); },
        close() { try { sqlite.close(); } catch {} },
        botToken: token,
        botUsername,
        projectId,
      };

      const projectRouter = Router();
      routeModule(projectRouter, db, projectId);

      await new Promise<void>((resolve) => {
        const fakeReq = {
          method: "POST",
          url: webhookPath,
          path: webhookPath,
          headers: { "content-type": "application/json" },
          body,
          params: {},
          query: {},
          get: (h: string) => h === "content-type" ? "application/json" : undefined,
        } as any;

        const fakeRes = {
          statusCode: 200,
          _headers: {} as Record<string, string>,
          setHeader(k: string, v: string) { this._headers[k] = v; },
          status(code: number) { this.statusCode = code; return this; },
          json(data: any) { resolve(); },
          send(data: any) { resolve(); },
          end() { resolve(); },
          get: (h: string) => undefined,
          set: (k: string, v: string) => fakeRes,
          type: (t: string) => fakeRes,
        } as any;

        projectRouter(fakeReq, fakeRes, () => {
          resolve();
        });

        setTimeout(resolve, 5000);
      });

      db.close();
    } catch (err: any) {
      if (db) try { db.close(); } catch {}
      throw err;
    }
    });
  }
}

export const botRunnerService = new BotRunnerService();
