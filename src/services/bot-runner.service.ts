import { Bot, webhookCallback } from "grammy";
import { config } from "../config";
import { projectService } from "./project.service";
import { decryptToken } from "./crypto.service";
import Database from "better-sqlite3";
import type { Request, Response, NextFunction } from "express";

interface ManagedBotInstance {
  bot: Bot;
  projectId: string;
  botUsername: string;
  webhookHandler: (req: Request, res: Response, next: NextFunction) => void;
}

export class BotRunnerService {
  private bots = new Map<string, ManagedBotInstance>();

  async startBot(projectId: string, token: string, botUsername: string): Promise<void> {
    if (this.bots.has(projectId)) {
      console.log(`[BotRunner] Bot for ${projectId} already running`);
      return;
    }

    const bot = new Bot(token);
    const appUrl = `${config.baseUrl}/app/${projectId}/`;

    bot.command("start", async (ctx) => {
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
          const dataDir = path.join(process.cwd(), "projects", projectId, "data");
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

    const webhookHandler = webhookCallback(bot, "express");

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
}

export const botRunnerService = new BotRunnerService();
