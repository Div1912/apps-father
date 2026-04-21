import http from "http";
import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import multer from "multer";
import { config } from "../config";
import appRoutes from "./routes/app.routes";
import apiRoutes, { invalidateProjectDbCache } from "./routes/api.routes";
import devRoutes from "./routes/dev.routes";
import devApiRoutes from "./routes/devapi.routes";
import webhookRoutes from "./routes/webhook.routes";
import adminRoutes from "./routes/admin.routes";
import editorRoutes from "./routes/editor.routes";
import logsRoutes from "./routes/logs.routes";
import billingRoutes from "./routes/billing.routes";
import { setupWebSocket, forceReloadProjectWs } from "./ws-manager";
import { setupMiniAppWebSocket } from "./miniapp-ws";
import { broadcastToProject, registerAnswerResolver, resolveAnswer } from "./miniapp-ws";
import { projectService } from "../services/project.service";
import { parseAgentLog } from "../services/agent-logger";
import { decryptToken } from "../services/crypto.service";
import { billingService } from "../services/billing.service";
import { chatService, ChatMessage } from "../services/chat.service";
import { agentService, AgentProgress, AgentAbortedError } from "../services/agent.service";
import { processingProjects, abortedProjects } from "../bot/processing";
import { commitService } from "../services/commit.service";
import { publishReport } from "../services/telegraph.service";
import { claudeService } from "../services/claude.service";
import {
  PREFERENCES_CATALOG,
  validatePreferences,
  parseProjectPreferences,
} from "../services/preferences.catalog";
import { parseStartParam, trackEvent } from "../services/analytics.service";
import { prisma } from "../db";
import { runtimeConfig } from "../services/runtime-config.service";
import { Decimal } from "@prisma/client/runtime/library";
import { t, Lang } from "../bot/i18n";
import { notifyProcessDone } from "../services/notify.service";
import { signDesktopToken, verifyDesktopToken } from "./desktop-auth";
import { sendBotWelcome } from "../services/welcome.service";

let expressApp: express.Application | null = null;
let httpServer: http.Server | null = null;
const avatarCache = new Map<string, string>();


export function createWebServer() {
  const app = express();

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  app.use("/assets", express.static(path.join(__dirname, "..", "assets")));

  // ── Landing page (apps-father.com) ──
  // Static marketing site served at the root. Files live in /landing at the
  // repo root; deployed to the server and shipped as part of `pm2` builds.
  const landingDir = path.join(__dirname, "..", "..", "landing");
  app.get("/", (_req, res, next) => {
    const indexPath = path.join(landingDir, "index.html");
    if (fs.existsSync(indexPath)) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.sendFile(indexPath);
    } else {
      next();
    }
  });
  app.use(express.static(landingDir, { index: false, extensions: ["html"] }));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ── Apps Father Mini App ──
  function validateMiniAppInitData(initData: string): { valid: boolean; telegramId?: number; username?: string; firstName?: string } {
    if (!initData) return { valid: false };
    try {
      const params = new URLSearchParams(initData);
      const hash = params.get("hash");
      if (!hash) return { valid: false };
      params.delete("hash");
      const entries = Array.from(params.entries());
      entries.sort(([a], [b]) => a.localeCompare(b));
      const dataCheckString = entries.map(([k, v]) => `${k}=${v}`).join("\n");
      const secretKey = crypto.createHmac("sha256", "WebAppData").update(config.botToken).digest();
      const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
      if (computedHash !== hash) return { valid: false };
      let userData: any;
      try { userData = JSON.parse(params.get("user") || "{}"); } catch { userData = {}; }
      if (!userData.id) return { valid: false };
      return { valid: true, telegramId: userData.id, username: userData.username, firstName: userData.first_name };
    } catch { return { valid: false }; }
  }

  function validateAuth(req: express.Request): { valid: boolean; telegramId?: number; username?: string; firstName?: string } {
    const initData = (req.headers["x-telegram-init-data"] || "") as string;
    if (initData) return validateMiniAppInitData(initData);
    const desktopToken = (req.headers["x-desktop-auth"] || "") as string;
    if (desktopToken) return verifyDesktopToken(desktopToken);
    return { valid: false };
  }

  // ── Attribution middleware ──
  // Reads X-Apps-Father-Start-Param off every Mini App / Desktop API request,
  // parses it, resolves the partner tag if applicable, and stashes the result
  // on req.attribution. Routes then call getOrCreateUserFromReq(req, auth) so
  // the very first request that creates the user row carries the source.
  //
  // Why this exists: the frontend sends X-Apps-Father-Start-Param on EVERY
  // call (see mini_app/app.js apiHeaders()). Previously only /api/init and
  // /web-auth knew about the source. If reportInit() early-exited (no
  // initData) or another endpoint won the create race, the user row landed
  // with utmSource = NULL — and the admin notification fired before the
  // back-fill could happen. With this middleware, source attribution is
  // ambient: every call site that does getOrCreateUser carries it for free.
  async function attachAttribution(
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) {
    try {
      const raw = ((req.headers["x-apps-father-start-param"] || "") as string).trim();
      if (!raw) { next(); return; }
      // Same sanitization as the client (see getStartParam in mini_app/app.js).
      const cleaned = raw.replace(/[^A-Za-z0-9_|-]/g, "").slice(0, 64);
      if (!cleaned) { next(); return; }
      const parsed = parseStartParam(cleaned);
      let source: string | null = parsed.source;
      let referrerId: string | null = parsed.referrerId;
      let referredBy: number | undefined = referrerId ? Number(referrerId) : undefined;
      // Partner-tag resolution mirrors /api/init and /web-auth so this
      // middleware is the single source of truth for tag → referrer.
      if (!referredBy && source && !source.startsWith("v_")) {
        try {
          const partner = await prisma.user.findUnique({ where: { partnerTag: source } });
          if (partner && partner.isPartner) {
            referredBy = Number(partner.telegramId);
            referrerId = String(partner.telegramId);
          }
        } catch {
          // Best-effort: attribution failures must never block the request.
        }
      }
      (req as any).attribution = { source, referrerId, referredBy, raw: cleaned };
    } catch {
      // Swallow — attribution is purely a side-channel.
    }
    next();
  }
  app.use("/telegram-mini-app/api", attachAttribution);

  // Helper: any handler that needs to materialize the authenticated user
  // should call this instead of projectService.getOrCreateUser directly. It
  // forwards req.attribution (set by attachAttribution above) so source /
  // referrer land on the very first row-creating call.
  function getOrCreateUserFromReq(
    req: express.Request,
    auth: { telegramId?: number; username?: string; firstName?: string },
  ) {
    const attr = ((req as any).attribution || {}) as {
      source?: string | null;
      referredBy?: number;
    };
    return projectService.getOrCreateUser(
      auth.telegramId!,
      auth.username,
      auth.firstName,
      attr.referredBy,
      attr.source ?? null,
    );
  }

  // ── Desktop config (public, no auth) ──
  app.get("/telegram-mini-app/api/desktop-config", (_req, res) => {
    const botId = config.botToken.split(":")[0];
    res.json({ botId });
  });

  // ── Collaboration check (public, no auth) ──
  // Allows partners / external integrations to verify a Telegram user's
  // funnel state without needing initData. The {user-id} is the user's
  // Telegram ID. Always returns 200; if the user doesn't exist we return
  // registered=false with zeroed metrics so callers don't need to special
  // case 404.
  app.get("/collaboration-check/:userId", async (req, res) => {
    try {
      const tgIdRaw = req.params.userId;
      if (!/^\d+$/.test(tgIdRaw)) {
        res.status(400).json({ error: "userId must be a numeric Telegram ID" });
        return;
      }
      const tgId = BigInt(tgIdRaw);

      const user = await prisma.user.findUnique({
        where: { telegramId: tgId },
        select: { id: true },
      });

      if (!user) {
        res.json({ registered: false, app_created: false, deposit_amount: 0 });
        return;
      }

      const [builtAppCount, depositAgg] = await Promise.all([
        prisma.project.count({
          where: { userId: user.id, status: { in: ["deployed", "released"] } },
        }),
        prisma.payment.aggregate({
          _sum: { amountUsd: true },
          where: { userId: user.id, status: "confirmed" },
        }),
      ]);

      res.json({
        registered: true,
        app_created: builtAppCount > 0,
        deposit_amount: Number(depositAgg._sum.amountUsd || 0),
      });
    } catch (err: any) {
      console.error("[CollaborationCheck] Error:", err);
      res.status(500).json({ error: err.message || "Internal error" });
    }
  });

  // ── Desktop Web Auth (Telegram Login Widget) ──
  app.post("/telegram-mini-app/api/web-auth", async (req, res) => {
    try {
      const { id, first_name, username, photo_url, auth_date, hash, startParam } = req.body;
      if (!id || !hash || !auth_date) { res.status(400).json({ error: "Missing fields" }); return; }

      const now = Math.floor(Date.now() / 1000);
      if (now - Number(auth_date) > 86400) { res.status(401).json({ error: "Auth data expired" }); return; }

      // startParam is passed in by the desktop login form so it can carry
      // attribution (utm_source / referrer / partner-tag) — it's NOT part
      // of Telegram's signed payload, so we must EXCLUDE it from the hash
      // check to avoid breaking auth. Everything else stays in.
      const checkData: Record<string, string> = {};
      for (const key of Object.keys(req.body).sort()) {
        if (key === "hash" || key === "startParam") continue;
        checkData[key] = String(req.body[key]);
      }
      const dataCheckString = Object.entries(checkData).map(([k, v]) => `${k}=${v}`).join("\n");
      const secretKey = crypto.createHash("sha256").update(config.botToken).digest();
      const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

      if (computedHash !== hash) { res.status(401).json({ error: "Invalid hash" }); return; }

      // Mirror the /api/init attribution flow: parse the start param,
      // resolve referrer / partner tag / plain source, and forward to
      // getOrCreateUser. Without this every desktop-Login user is Direct.
      const parsed = parseStartParam(typeof startParam === "string" ? startParam : null);
      let { source, referrerId } = parsed;
      let referredBy = referrerId ? Number(referrerId) : undefined;
      let partnerBonus: number | null = null;
      let partnerTag: string | null = null;
      if (!referredBy && source && !source.startsWith("v_")) {
        try {
          const partner = await prisma.user.findUnique({ where: { partnerTag: source } });
          if (partner && partner.isPartner) {
            referredBy = Number(partner.telegramId);
            referrerId = String(partner.telegramId);
            partnerTag = source;
            if (partner.partnerReferralBonus && Number(partner.partnerReferralBonus) > 0) {
              partnerBonus = Number(partner.partnerReferralBonus);
            }
          }
        } catch (err) {
          console.error("[Web Auth] Partner tag lookup error:", err);
        }
      }

      const { user, isNew, attributedNow } = await projectService.getOrCreateUser(
        Number(id),
        username,
        first_name,
        referredBy,
        source,
      );

      if ((isNew || attributedNow) && partnerBonus && user.referredBy && Number(user.balance) <= 0.2) {
        try {
          await prisma.user.update({
            where: { id: user.id },
            data: { balance: { increment: new Decimal(partnerBonus.toFixed(4)) } },
          });
          console.log(`[Web Auth] Partner bonus $${partnerBonus.toFixed(2)} credited to user ${user.id} via tag ${partnerTag}`);
        } catch (err) {
          console.error("[Web Auth] Partner bonus credit error:", err);
        }
      }

      if (isNew || attributedNow) {
        void trackEvent(Number(id), "user_registered", {
          source,
          referrer_id: referrerId,
          telegram_id: Number(id),
          channel: "web_login",
        });
      }

      const token = signDesktopToken({ telegramId: Number(id), username, firstName: first_name });

      res.json({ token, user: { id: user.id, telegramId: Number(id), username, firstName: first_name, photoUrl: photo_url } });
    } catch (err) {
      console.error("[Web Auth] Error:", err);
      res.status(500).json({ error: "Auth failed" });
    }
  });

  // Analytics init — called on every Mini App load; records utm_source on first-time users
  app.post("/telegram-mini-app/api/init", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { startParam } = req.body as { startParam?: string };
      const parsed = parseStartParam(startParam);
      let { source, referrerId } = parsed;
      let referredBy = referrerId ? Number(referrerId) : undefined;

      // Resolve partner tag → referrer telegramId. Non-numeric startParam
      // could be either a generic UTM source or a partner tag. We try the
      // partner table first; if it matches an active partner we use them as
      // the referrer (and remember the partner bonus). Otherwise we keep it
      // as a plain source label for attribution.
      let partnerBonus: number | null = null;
      let partnerTag: string | null = null;
      if (!referredBy && source && !source.startsWith("v_")) {
        try {
          const partner = await prisma.user.findUnique({ where: { partnerTag: source } });
          if (partner && partner.isPartner) {
            referredBy = Number(partner.telegramId);
            referrerId = String(partner.telegramId);
            partnerTag = source;
            if (partner.partnerReferralBonus && Number(partner.partnerReferralBonus) > 0) {
              partnerBonus = Number(partner.partnerReferralBonus);
            }
          }
        } catch (err) {
          console.error("[MiniApp Init] Partner tag lookup error:", err);
        }
      }

      const { user, isNew, attributedNow } = await projectService.getOrCreateUser(
        auth.telegramId!,
        auth.username,
        auth.firstName,
        referredBy,
        source
      );

      // One-line diagnostic so we can tail logs and see attribution land in
      // real time as ad campaigns deliver. raw=the literal startParam from
      // the client, src=parsed source, ref=resolved referrer id (if any),
      // isNew=row created on this call, attr=source written on this call
      // (either via create or back-fill on race-loser).
      console.log(
        `[MiniApp Init] tg=${auth.telegramId} raw=${JSON.stringify(startParam || null)} src=${JSON.stringify(source)} ref=${referrerId || null} isNew=${isNew} attr=${attributedNow}`
      );

      if (isNew || attributedNow) {
        // Credit partner referral bonus once (only if user still has the
        // starter balance). attributedNow covers the race-loser case where
        // /api/projects won the create and stored NULL source — we now
        // backfilled it and need to honor the partner bonus too.
        if (partnerBonus && user.referredBy && Number(user.balance) <= 0.2) {
          try {
            await prisma.user.update({
              where: { id: user.id },
              data: { balance: { increment: new Decimal(partnerBonus.toFixed(4)) } },
            });
            console.log(`[MiniApp Init] Partner bonus $${partnerBonus.toFixed(2)} credited to user ${user.id} via tag ${partnerTag}`);
          } catch (err) {
            console.error("[MiniApp Init] Partner bonus credit error:", err);
          }
        }

        void trackEvent(auth.telegramId!, "user_registered", {
          source,
          referrer_id: referrerId,
          telegram_id: auth.telegramId,
          backfilled: attributedNow && !isNew ? true : undefined,
        });
      }

      if (isNew) {
        // The user opened the Mini App without going through /start in the
        // bot — fire the welcome message to their bot chat so they see the
        // standard Apps Father onboarding card too. Only on true first
        // creation; we don't want to spam users whose row existed but was
        // simply backfilled.
        const lang = (user.language as Lang) || "en";
        void sendBotWelcome(auth.telegramId!, lang, startParam || null);
      }

      res.json({ ok: true, isNew, utmSource: user.utmSource });
    } catch (err: any) {
      console.error("[MiniApp API] Init error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  app.get("/telegram-mini-app/api/projects", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { user } = await getOrCreateUserFromReq(req, auth);
      const projects = await projectService.getProjectsByUser(user.id);

      const result = await Promise.all(projects.map(async (p: any) => {
        let avatarUrl: string | null = avatarCache.get(p.id) ?? null;
        if (!avatarUrl && p.botTokenEncrypted) {
          try {
            const token = decryptToken(p.botTokenEncrypted);
            const chatRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
            const chatData = await chatRes.json() as any;
            if (chatData.ok && chatData.result?.id) {
              const photosRes = await fetch(`https://api.telegram.org/bot${token}/getUserProfilePhotos?user_id=${chatData.result.id}&limit=1`);
              const photosData = await photosRes.json() as any;
              if (photosData.ok && photosData.result?.photos?.length > 0) {
                const photo = photosData.result.photos[0];
                const biggest = photo[photo.length - 1];
                const fileId = biggest.file_id;
                const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
                const fileData = await fileRes.json() as any;
                if (fileData.ok && fileData.result?.file_path) {
                  avatarUrl = `https://api.telegram.org/file/bot${token}/${fileData.result.file_path}`;
                  avatarCache.set(p.id, avatarUrl);
                }
              }
            }
          } catch {}
        }
        return {
          id: p.id,
          name: p.name || "Unnamed App",
          description: p.description || "",
          status: p.status || "created",
          botUsername: p.botUsername || null,
          currentVersion: p.currentVersion || 0,
          totalCostUsd: p.totalCostUsd ? Number(p.totalCostUsd) : 0,
          qualityTier: p.qualityTier || 1,
          features: p.features || "[]",
          releaseCommit: p.releaseCommit || null,
          avatarUrl,
        };
      }));

      const slotInfo = await projectService.getUserSlotInfo(user.id);
      res.json({ projects: result, slots: slotInfo });
    } catch (err) {
      console.error("[MiniApp API] Error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/telegram-mini-app/api/samples", async (_req, res) => {
    try {
      const sampleIds = (process.env.SAMPLE_PROJECT_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
      if (sampleIds.length === 0) { res.json({ samples: [] }); return; }
      const samples = [];
      for (const id of sampleIds) {
        const p = await projectService.getProject(id);
        if (!p) continue;
        let avatarUrl = avatarCache.get(id);
        if (!avatarUrl) {
          try {
            const token = await projectService.getProjectToken(id);
            if (token) {
              const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
              const meData = await meRes.json() as any;
              if (meData.ok && meData.result?.id) {
                const r = await fetch(`https://api.telegram.org/bot${token}/getUserProfilePhotos?user_id=${meData.result.id}&limit=1`);
                const d: any = await r.json();
                if (d.ok && d.result?.photos?.length > 0) {
                  const photo = d.result.photos[0];
                  const biggest = photo[photo.length - 1];
                  const fr = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${biggest.file_id}`);
                  const fd: any = await fr.json();
                  if (fd.ok) {
                    avatarUrl = `https://api.telegram.org/file/bot${token}/${fd.result.file_path}`;
                    avatarCache.set(id, avatarUrl);
                  }
                }
              }
            }
          } catch {}
        }
        samples.push({
          id: p.id,
          name: p.name,
          description: p.description || "",
          botUsername: p.botUsername || "",
          avatarUrl: avatarUrl || null,
        });
      }
      res.json({ samples });
    } catch (err) {
      console.error("[MiniApp API] Samples error:", err);
      res.json({ samples: [] });
    }
  });

  app.post("/telegram-mini-app/api/language", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { lang } = req.body;
      if (!lang || !["en", "ru", "ua"].includes(lang)) { res.status(400).json({ error: "Invalid lang" }); return; }
      await prisma.user.update({ where: { telegramId: BigInt(auth.telegramId!) }, data: { language: lang } });
      res.json({ ok: true });
    } catch (err) {
      console.error("[MiniApp API] Language error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/buy-slot", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const result = await projectService.buySlot(user.id);

      void trackEvent(auth.telegramId!, "purchase", {
        type: "slot",
        amount: 25,
        new_slots: result.newSlots,
      });

      res.json({ ok: true, newSlots: result.newSlots, newBalance: result.newBalance });
    } catch (err: any) {
      console.error("[MiniApp API] Buy slot error:", err);
      res.status(400).json({ error: err.message || "Failed to buy slot" });
    }
  });

  app.post("/telegram-mini-app/api/topup", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const { amount, method } = req.body;
      const amountUsd = parseFloat(amount);
      if (isNaN(amountUsd) || amountUsd < 2) {
        res.status(400).json({ error: "Minimum top-up is $2" });
        return;
      }

      let invoiceUrl: string;
      let paymentId: number | undefined;
      if (method === "cryptobot") {
        const result = await billingService.createCryptoBotInvoice(user.id, amountUsd);
        invoiceUrl = result.invoiceUrl;
        paymentId = result.paymentId;
      } else if (method === "stars") {
        const STAR_RATE = 0.013;
        const rawStars = Math.ceil(amountUsd / STAR_RATE);
        const stars = Math.floor(rawStars / 10) * 10;
        const result = await billingService.createStarsInvoice(user.id, amountUsd, stars);
        invoiceUrl = result.invoiceUrl;
        paymentId = result.paymentId;
      } else if (method === "ton") {
        const result = await billingService.createTonPayment(user.id, amountUsd);
        res.json({ ok: true, ton: true, paymentId: result.paymentId, walletAddress: result.walletAddress, amountNano: result.amountNano });
        return;
      } else {
        // "Other Crypto" (NowPayments) — provider charges high fees on small
        // invoices, so require at least $15 to keep the deposit worthwhile.
        if (amountUsd < 15) {
          res.status(400).json({ error: "Other Crypto requires a minimum of $15. Please use TON, Stars or Crypto Bot for smaller amounts." });
          return;
        }
        const result = await billingService.createTopUp(user.id, amountUsd);
        invoiceUrl = result.invoiceUrl;
        paymentId = (result as any).paymentId;
      }

      res.json({ ok: true, invoiceUrl, paymentId });
    } catch (err: any) {
      console.error("[MiniApp API] Topup error:", err);
      res.status(400).json({ error: err.message || "Failed to create payment" });
    }
  });

  app.post("/telegram-mini-app/api/ton-verify", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { paymentId } = req.body;
      if (!paymentId) { res.status(400).json({ error: "Missing paymentId" }); return; }
      const result = await billingService.verifyTonPayment(parseInt(paymentId));
      res.json(result);
    } catch (err: any) {
      console.error("[MiniApp API] TON verify error:", err);
      res.json({ confirmed: false });
    }
  });

  // Generic payment status check — used by the Mini App as a fallback poller
  // for Stars / CryptoBot when the upstream callback doesn't reach the user.
  app.get("/telegram-mini-app/api/payment-status", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const paymentId = parseInt(String(req.query.paymentId || ""));
      if (!paymentId) { res.status(400).json({ error: "Missing paymentId" }); return; }

      const { user } = await getOrCreateUserFromReq(req, auth);
      const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
      if (!payment) { res.status(404).json({ error: "Not found" }); return; }
      if (payment.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

      res.json({
        status: payment.status,
        amountUsd: Number(payment.amountUsd),
        confirmedAt: payment.confirmedAt,
      });
    } catch (err) {
      console.error("[MiniApp API] payment-status error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/telegram-mini-app/api/token/:projectId", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { user } = await getOrCreateUserFromReq(req, auth);
      const project = await projectService.getProject(req.params.projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }
      if (!project.botTokenEncrypted) { res.status(404).json({ error: "No token" }); return; }

      const token = decryptToken(project.botTokenEncrypted);
      res.json({ token });
    } catch (err) {
      console.error("[MiniApp API] Token error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/telegram-mini-app/api/balance", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const [balance, paymentCount, fullUser] = await Promise.all([
        billingService.getUserBalance(user.id),
        prisma.payment.count({ where: { userId: user.id, status: "confirmed" } }),
        prisma.user.findUnique({ where: { id: user.id }, select: { firstDepositBonusGiven: true } }),
      ]);
      const firstDepositBonusEligible = paymentCount === 0 && !fullUser?.firstDepositBonusGiven;
      res.json({
        balance,
        paymentCount,
        firstDepositBonusEligible,
        firstDepositBonusUsd: 10,
        minTopupUsd: 2,
      });
    } catch (err) {
      console.error("[MiniApp API] Balance error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Channel-subscription bonus ──
  // Encourages users to follow @apps_father by giving them a small
  // one-time balance credit when they actually do. Two endpoints:
  //
  //   GET  /sub-status  → cheap "should we show the modal?" check
  //   POST /sub-claim   → server-authoritative claim (atomic, idempotent)
  //
  // Bonus is gated by users.sub_bonus_claimed_at (set at most once per
  // user, ever). Subscription itself is verified via Bot API getChatMember
  // — we trust Telegram, never the client.
  const SUB_CHANNEL_ID = -1003766261308;
  const SUB_CHANNEL_LINK = "https://t.me/apps_father";
  const SUB_BONUS_USD = 0.10;

  async function isUserInSubChannel(telegramId: number): Promise<boolean> {
    try {
      const r = await fetch(
        `https://api.telegram.org/bot${config.botToken}/getChatMember?chat_id=${SUB_CHANNEL_ID}&user_id=${telegramId}`,
      );
      const d = (await r.json()) as { ok: boolean; result?: { status?: string } };
      if (!d.ok || !d.result?.status) return false;
      // member / administrator / creator all count as "subscribed".
      // "left" / "kicked" / "restricted" do not.
      const s = d.result.status;
      return s === "member" || s === "administrator" || s === "creator";
    } catch (err) {
      console.warn("[SubBonus] getChatMember failed:", err);
      return false;
    }
  }

  app.get("/telegram-mini-app/api/sub-status", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);

      const fresh = await prisma.user.findUnique({
        where: { id: user.id },
        select: { subBonusClaimedAt: true },
      });
      const eligible = !fresh?.subBonusClaimedAt;

      // Skip the network call when there's no carrot left to dangle.
      // Frontend will use this to suppress the modal.
      const subscribed = eligible
        ? await isUserInSubChannel(Number(user.telegramId))
        : true;

      res.json({
        subscribed,
        eligible,
        channelLink: SUB_CHANNEL_LINK,
        bonusUsd: SUB_BONUS_USD,
      });
    } catch (err) {
      console.error("[MiniApp API] sub-status error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/sub-claim", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);

      const subscribed = await isUserInSubChannel(Number(user.telegramId));
      if (!subscribed) {
        res.json({
          ok: true,
          subscribed: false,
          claimed: false,
          alreadyClaimed: false,
          channelLink: SUB_CHANNEL_LINK,
        });
        return;
      }

      // Atomic claim: only awards the bonus if subBonusClaimedAt is still
      // NULL. Race-safe — two parallel POSTs from the same user can never
      // double-credit, because updateMany returns count=0 the second time.
      const claim = await prisma.user.updateMany({
        where: { id: user.id, subBonusClaimedAt: null },
        data: {
          subBonusClaimedAt: new Date(),
          balance: { increment: new Decimal(SUB_BONUS_USD.toFixed(4)) },
        },
      });

      const fresh = await prisma.user.findUnique({
        where: { id: user.id },
        select: { balance: true },
      });

      res.json({
        ok: true,
        subscribed: true,
        claimed: claim.count > 0,
        alreadyClaimed: claim.count === 0,
        balance: Number(fresh?.balance ?? 0),
        bonusUsd: SUB_BONUS_USD,
      });
    } catch (err) {
      console.error("[MiniApp API] sub-claim error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Partner API ──

  app.get("/telegram-mini-app/api/partner", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      if (!user.isPartner) { res.json({ isPartner: false }); return; }

      const referrals = await prisma.user.findMany({
        where: { referredBy: user.telegramId },
        select: { id: true, username: true, firstName: true, createdAt: true },
      });

      const referralIds = referrals.map(r => r.id);
      let totalEarned = 0;
      const referralDetails = [];

      for (const ref of referrals) {
        const deposits = await prisma.payment.aggregate({
          _sum: { amountUsd: true },
          where: { userId: ref.id, status: "confirmed" },
        });
        const depositTotal = Number(deposits._sum.amountUsd || 0);
        const earned = depositTotal * Number(user.partnerPercent || 0) / 100;
        totalEarned += earned;
        referralDetails.push({
          id: ref.id,
          username: ref.username,
          firstName: ref.firstName,
          joinedAt: ref.createdAt,
          deposits: depositTotal,
          earned,
        });
      }

      res.json({
        isPartner: true,
        partnerPercent: Number(user.partnerPercent || 0),
        partnerTag: user.partnerTag,
        partnerBalance: Number(user.partnerBalance),
        totalEarned,
        inviteLink: user.partnerTag ? `https://t.me/apps_father_bot/app?startapp=${user.partnerTag}` : null,
        referrals: referralDetails,
      });
    } catch (err) {
      console.error("[MiniApp API] Partner error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/partner/transfer", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      if (!user.isPartner) { res.status(403).json({ error: "Not a partner" }); return; }

      const { amount } = req.body;
      const val = parseFloat(amount);
      if (isNaN(val) || val <= 0) { res.status(400).json({ error: "Invalid amount" }); return; }
      if (val > Number(user.partnerBalance)) { res.status(400).json({ error: "Insufficient partner balance" }); return; }

      const updated = await prisma.user.update({
        where: { id: user.id },
        data: {
          partnerBalance: { decrement: new Decimal(val.toFixed(4)) },
          balance: { increment: new Decimal(val.toFixed(4)) },
        },
      });

      res.json({
        partnerBalance: Number(updated.partnerBalance),
        balance: Number(updated.balance),
      });
    } catch (err) {
      console.error("[MiniApp API] Partner transfer error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/partner/withdraw", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      if (!user.isPartner) { res.status(403).json({ error: "Not a partner" }); return; }

      const { amount, address } = req.body;
      const val = parseFloat(amount);
      if (isNaN(val) || val < 5) { res.status(400).json({ error: "Minimum withdrawal is $5.00" }); return; }
      if (val > Number(user.partnerBalance)) { res.status(400).json({ error: "Insufficient partner balance" }); return; }
      if (!address || !address.trim()) { res.status(400).json({ error: "TON address is required" }); return; }

      const withdrawal = await prisma.withdrawal.create({
        data: {
          userId: user.id,
          amountUsd: new Decimal(val.toFixed(4)),
          tonAddress: address.trim(),
        },
      });

      await prisma.user.update({
        where: { id: user.id },
        data: { partnerBalance: { decrement: new Decimal(val.toFixed(4)) } },
      });

      const groupId = config.withdrawGroupId;
      const msgText =
        `<b>💸 Withdrawal Request #${withdrawal.id}</b>\n\n` +
        `<b>Partner:</b> ${user.username ? "@" + user.username : user.firstName || "Unknown"} (ID: ${user.telegramId})\n` +
        `<b>Amount:</b> ${val.toFixed(2)} USDT\n` +
        `<b>TON Address:</b> <code>${address.trim()}</code>\n` +
        `<b>Partner Balance After:</b> $${(Number(user.partnerBalance) - val).toFixed(2)}`;

      const kbd = {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `wd_approve_${withdrawal.id}` },
          { text: "❌ Decline", callback_data: `wd_decline_${withdrawal.id}` },
        ]],
      };

      await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: groupId, text: msgText, parse_mode: "HTML", reply_markup: kbd }),
      }).catch((err) => console.error("[Withdraw] Failed to send group notification:", err));

      res.json({ ok: true, withdrawalId: withdrawal.id, message: "Withdrawal request submitted. You will be notified when it is processed." });
    } catch (err) {
      console.error("[MiniApp API] Partner withdraw error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Chat API ──
  const upload = multer({ dest: path.join(process.cwd(), "tmp_uploads"), limits: { fileSize: 10 * 1024 * 1024 } });

  app.get("/telegram-mini-app/api/chat/:projectId", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const project = await projectService.getProject(req.params.projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const before = req.query.before ? parseInt(req.query.before as string) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const messages = chatService.getHistory(req.params.projectId, before, limit);
      const hasActiveProgress = messages.some((m: any) => m.type === "progress" && (m.percent ?? 0) < 100);
      const finalizing = processingProjects.has(req.params.projectId) && !hasActiveProgress;
      res.json({ messages, finalizing });
    } catch (err) {
      console.error("[Chat API] History error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/chat/:projectId/send", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const lang = (user.language as Lang) || "en";
      const project = await projectService.getProject(req.params.projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const { text, type: msgType, attachmentIds } = req.body;
      if (!text || !text.trim()) { res.status(400).json({ error: "Empty message" }); return; }

      const projectId = req.params.projectId;

      const userMsg = chatService.addMessage(projectId, {
        role: "user",
        type: msgType === "update" ? "update_request" : "text",
        content: text.trim(),
        attachments: attachmentIds,
      });
      broadcastToProject(projectId, { type: "message", message: userMsg });

      if (msgType === "update") {
        if (processingProjects.has(projectId)) {
          const errMsg = chatService.addMessage(projectId, { role: "system", type: "error", content: t(lang, "sys_already_processing") });
          broadcastToProject(projectId, { type: "message", message: errMsg });
          res.json({ messageId: userMsg.id, status: "error", error: "already_processing" });
          return;
        }

        const balance = await billingService.getUserBalance(user.id);
        if (balance < 5) {
          const errMsg = chatService.addMessage(projectId, { role: "system", type: "balance_error", content: t(lang, "insufficient_balance_amount", { balance: `$${balance.toFixed(2)}`, min: "$5.00" }), metadata: { balance } });
          broadcastToProject(projectId, { type: "message", message: errMsg });
          res.json({ messageId: userMsg.id, status: "error", error: "insufficient_balance" });
          return;
        }

        res.json({ messageId: userMsg.id, status: "processing" });

        void trackEvent(auth.telegramId!, "agent_started", {
          project_id: projectId,
          source: "chat_update",
        });

        // Run agent in background
        (async () => {
          processingProjects.add(projectId);
          let progressMsgId: string | null = null;
          let items: { id: number; text: string; done: boolean }[] = [];

          const progressMsg = chatService.addMessage(projectId, {
            role: "assistant",
            type: "progress",
            content: t(lang, "sys_starting"),
            percent: 0,
          });
          progressMsgId = progressMsg.id;
          broadcastToProject(projectId, { type: "message", message: progressMsg });

          try {
            await projectService.updateProjectStatus(projectId, "building");
            const currentBalance = await billingService.getUserBalance(user.id);

            let progressDone = false;
            const onProgress = async (p: AgentProgress) => {
              if (!progressMsgId || progressDone) return;
              if ((p.percent ?? 0) >= 100) { progressDone = true; return; }
              chatService.updateMessage(projectId, progressMsgId, {
                content: `${p.action} ${p.detail}`,
                percent: p.percent,
                costUsd: p.costUsd,
                balance: p.balance,
              });
              broadcastToProject(projectId, {
                type: "progress",
                projectId,
                messageId: progressMsgId,
                percent: p.percent,
                message: `${p.action} ${p.detail}`,
                checklist: items,
                costUsd: p.costUsd,
                balance: p.balance,
              });
            };

            const onAskUser = async (question: string, options: string[]): Promise<string> => {
              const qMsg = chatService.addMessage(projectId, {
                role: "assistant",
                type: "question",
                content: question,
                metadata: { options },
              });
              broadcastToProject(projectId, { type: "question", projectId, messageId: qMsg.id, question, options });

              return new Promise<string>((resolve) => {
                const timeout = setTimeout(() => {
                  resolve("");
                }, 5 * 60 * 1000);

                registerAnswerResolver(projectId, (answer: string) => {
                  clearTimeout(timeout);
                  chatService.removeMessage(projectId, qMsg.id);
                  broadcastToProject(projectId, { type: "remove_messages", projectId, messageIds: [qMsg.id] });
                  resolve(answer);
                });
              });
            };

            const onCreateTodo = async (todoItems: string[]) => {
              items = todoItems.map((t, i) => ({ id: i + 1, text: t, done: false }));
              if (progressMsgId) {
                chatService.updateMessage(projectId, progressMsgId, { checklist: items });
                broadcastToProject(projectId, {
                  type: "progress", projectId, messageId: progressMsgId, checklist: items,
                });
              }
            };

            const onCheckTodo = async (id: number) => {
              if (id >= 1 && id <= items.length) {
                items[id - 1].done = true;
                if (progressMsgId) {
                  chatService.updateMessage(projectId, progressMsgId, { checklist: items });
                  broadcastToProject(projectId, {
                    type: "progress", projectId, messageId: progressMsgId, checklist: items,
                  });
                }
              }
            };

            const attachments = userMsg.attachments?.map((a: any) => ({
              localPath: a.path,
              projectPath: `frontend/assets/${a.name}`,
              originalName: a.name,
            }));

            const result = await agentService.updateApp(
              projectId, text.trim(), onProgress, attachments,
              onAskUser, onCreateTodo, onCheckTodo, lang, currentBalance,
            );

            const usage = await billingService.recordUsage(
              user.id, projectId, result.model,
              { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: result.cacheWriteTokens, cache_read_input_tokens: result.cacheReadTokens },
              "update",
            );

            await projectService.updateProjectStatus(projectId, "deployed");

            try {
              await commitService.createCommit(projectId, `Update: ${text.trim().substring(0, 80)}`, result.commitNum!, result.commitDir!, result.logPath);
            } catch {}

            const history = chatService.getHistory(projectId, undefined, 1000);
            const updateNum = history.filter(m => m.type === "result").length + 1;
            const project = await projectService.getProject(projectId);
            const appName = project?.name || "App";

            // Publish telegraph (fast) before showing result
            const changelogUrl = await publishReport(`${appName} — Update #${updateNum}`, result.summary, `Cost: $${usage.costUsd.toFixed(4)}`).catch(() => null);

            // Show result immediately with short summary + changelog
            if (progressMsgId) {
              chatService.updateMessage(projectId, progressMsgId, {
                type: "result",
                content: result.shortSummary,
                percent: 100,
                costUsd: usage.costUsd,
                balance: usage.newBalance,
                checklist: items,
                metadata: { changelogUrl },
              });
            }

            broadcastToProject(projectId, {
              type: "status", projectId, status: "done",
              messageId: progressMsgId,
              summary: result.shortSummary,
              changelogUrl,
              costUsd: usage.costUsd,
              balance: usage.newBalance,
            });

            notifyProcessDone(auth.telegramId!, appName, result.shortSummary, "update", lang);

            // Run passport in background — keep processingProjects lock
            broadcastToProject(projectId, { type: "message", message: { role: "system", content: "preparing_next_update", metadata: { preparing: true } } });
            (async () => {
              try {
                await agentService.compactContext(projectId, result.commitDir!, result.summary, result.commitNum!, project?.description || undefined, project?.plan || undefined);
              } catch (err) {
                console.error("[Chat API] Background passport error:", err);
              } finally {
                broadcastToProject(projectId, { type: "finalizing_done", projectId });
                processingProjects.delete(projectId);
              }
            })();
            return;

          } catch (err: any) {
            if (err instanceof AgentAbortedError) {
              console.log(`[Chat API] Agent aborted for ${projectId}, billing partial usage`);
              await billingService.recordUsage(
                user.id, projectId, err.model,
                { input_tokens: err.inputTokens, output_tokens: err.outputTokens, cache_creation_input_tokens: err.cacheWriteTokens, cache_read_input_tokens: err.cacheReadTokens },
                "update",
              );
              await projectService.updateProjectStatus(projectId, "deployed");
              processingProjects.delete(projectId);
              return;
            }
            console.error("[Chat API] Agent error:", err);
            await projectService.updateProjectStatus(projectId, "error");

            const rawMsg = String(err?.message || err || "");
            const lower = rawMsg.toLowerCase();
            const isUpstream =
              lower.includes("overloaded") ||
              lower.includes("credit balance") ||
              lower.includes("rate_limit") ||
              lower.includes("rate limit") ||
              lower.includes("service unavailable") ||
              /\b5\d\d\b/.test(rawMsg) ||
              lower.includes("anthropic api");

            const friendlyContent = isUpstream
              ? t(lang, "sys_update_service_unavailable")
              : `${t(lang, "sys_update_failed")}: ${rawMsg || "Unknown error"}`;

            if (progressMsgId) {
              chatService.removeMessage(projectId, progressMsgId);
              broadcastToProject(projectId, { type: "remove_messages", projectId, messageIds: [progressMsgId] });
            }

            const errMsg = chatService.addMessage(projectId, {
              role: "assistant",
              type: "error",
              content: friendlyContent,
            });
            broadcastToProject(projectId, { type: "message", message: errMsg });
            broadcastToProject(projectId, { type: "status", projectId, status: "error", messageId: errMsg.id });
            processingProjects.delete(projectId);
          }
        })();

        return;
      }

      if (msgType === "question") {
        const balance = await billingService.getUserBalance(user.id);
        if (balance < 0.5) {
          const errMsg = chatService.addMessage(projectId, { role: "system", type: "balance_error", content: t(lang, "insufficient_balance_amount", { balance: `$${balance.toFixed(2)}`, min: "$0.50" }), metadata: { balance } });
          broadcastToProject(projectId, { type: "message", message: errMsg });
          res.json({ messageId: userMsg.id, status: "error", error: "insufficient_balance" });
          return;
        }

        const streamMsgId = crypto.randomBytes(8).toString("hex");
        res.json({ messageId: userMsg.id, streamMsgId, status: "processing" });

        broadcastToProject(projectId, { type: "stream_start", projectId, messageId: streamMsgId });

        (async () => {
          try {
            const allHistory = chatService.getHistory(projectId, undefined, 1000);
            const lastResultMsg = [...allHistory].reverse().find(m => m.type === "result");
            const lastUpdate = lastResultMsg?.content || undefined;
            const proj = await projectService.getProject(projectId);

            const askHistory = allHistory
              .filter(m => (m.type === "text" && m.role === "assistant") || (m.type === "text" && m.role === "user") || (m.role === "user" && m.type === "update_request" && false))
              .filter(m => {
                const isUserAsk = m.role === "user" && m.type === "text";
                const isAssistantReply = m.role === "assistant" && m.type === "text";
                return isUserAsk || isAssistantReply;
              })
              .slice(-10)
              .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));

            const answer = await agentService.answerQuestionStream(
              projectId, text.trim(),
              (_chunk, fullText) => {
                broadcastToProject(projectId, { type: "stream_chunk", projectId, messageId: streamMsgId, text: fullText });
              },
              lastUpdate, proj?.description || undefined, askHistory, lang,
            );

            const usage = await billingService.recordUsage(
              user.id, projectId, "claude-sonnet-4-6",
              { input_tokens: answer.inputTokens, output_tokens: answer.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
              "ask",
            );

            const ansMsg = chatService.addMessage(projectId, {
              role: "assistant",
              type: "text",
              content: answer.text,
              costUsd: usage.costUsd,
              balance: usage.newBalance,
            });
            broadcastToProject(projectId, { type: "stream_end", projectId, messageId: streamMsgId, message: ansMsg });
          } catch (err: any) {
            console.error("[Chat API] Question error:", err);
            const errMsg = chatService.addMessage(projectId, {
              role: "assistant",
              type: "error",
              content: `Failed to answer: ${err.message || "Unknown error"}`,
            });
            broadcastToProject(projectId, { type: "stream_end", projectId, messageId: streamMsgId, message: errMsg });
          }
        })();

        return;
      }

      res.json({ messageId: userMsg.id, status: "ok" });
    } catch (err) {
      console.error("[Chat API] Send error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Error report from injected monitor script (no auth — owner-only enforced client-side) ──
  const errorReportRateLimit = new Map<string, number>();

  app.post("/telegram-mini-app/api/error-report/:projectId", async (req, res) => {
    try {
      const projectId = req.params.projectId;

      // Rate limit: 1 report per project per 60s
      const now = Date.now();
      const lastReport = errorReportRateLimit.get(projectId) || 0;
      if (now - lastReport < 60_000) {
        res.json({ status: "rate_limited" });
        return;
      }
      errorReportRateLimit.set(projectId, now);

      const { message, stack, url } = req.body || {};
      if (!message) { res.status(400).json({ error: "No message" }); return; }

      const project = await projectService.getProject(projectId);
      if (!project) { res.status(404).json({ error: "Project not found" }); return; }

      const shortStack = (stack || "").toString().split("\n").slice(0, 8).join("\n");
      const errorText = `🐛 Error detected in the app:\n\`\`\`\n${message}${shortStack ? "\n" + shortStack : ""}\n\`\`\`\nPlease fix this error.`;

      // Add as user message so agent treats it as an update request
      const userMsg = chatService.addMessage(projectId, {
        role: "user",
        type: "update_request",
        content: errorText,
      });
      broadcastToProject(projectId, { type: "message", message: userMsg });

      res.json({ status: "ok" });

      // Trigger agent to fix it (runs in background)
      if (processingProjects.has(projectId)) return;

      const owner = await prisma.user.findUnique({ where: { id: project.userId } });
      if (!owner) return;
      const ownerLang = (owner.language as Lang) || "en";

      const balance = await billingService.getUserBalance(owner.id);
      if (balance < 5) {
        const errMsg = chatService.addMessage(projectId, {
          role: "system", type: "balance_error",
          content: t(ownerLang, "autofix_insufficient_balance", { balance: `$${balance.toFixed(2)}` }),
          metadata: { balance },
        });
        broadcastToProject(projectId, { type: "message", message: errMsg });
        return;
      }

      (async () => {
        processingProjects.add(projectId);
        let progressMsgId: string | null = null;
        let items: { id: number; text: string; done: boolean }[] = [];

        const progressMsg = chatService.addMessage(projectId, { role: "assistant", type: "progress", content: t(ownerLang, "sys_fixing_error"), percent: 0 });
        progressMsgId = progressMsg.id;
        broadcastToProject(projectId, { type: "message", message: progressMsg });

        try {
          await projectService.updateProjectStatus(projectId, "building");
          const currentBalance = await billingService.getUserBalance(owner.id);

          let progressDone = false;
          const onProgress = async (p: AgentProgress) => {
            if (!progressMsgId || progressDone) return;
            if ((p.percent ?? 0) >= 100) { progressDone = true; return; }
            chatService.updateMessage(projectId, progressMsgId, { content: `${p.action} ${p.detail}`, percent: p.percent, costUsd: p.costUsd, balance: p.balance });
            broadcastToProject(projectId, { type: "progress", projectId, messageId: progressMsgId, percent: p.percent, message: `${p.action} ${p.detail}`, checklist: items, costUsd: p.costUsd, balance: p.balance });
          };

          const onCreateTodo = async (todoItems: string[]) => {
            items = todoItems.map((t, i) => ({ id: i + 1, text: t, done: false }));
            if (progressMsgId) {
              chatService.updateMessage(projectId, progressMsgId, { checklist: items });
              broadcastToProject(projectId, { type: "progress", projectId, messageId: progressMsgId, checklist: items });
            }
          };

          const onCheckTodo = async (id: number) => {
            if (id >= 1 && id <= items.length) {
              items[id - 1].done = true;
              if (progressMsgId) {
                chatService.updateMessage(projectId, progressMsgId, { checklist: items });
                broadcastToProject(projectId, { type: "progress", projectId, messageId: progressMsgId, checklist: items });
              }
            }
          };

          const result = await agentService.updateApp(projectId, errorText, onProgress, [], undefined, onCreateTodo, onCheckTodo, ownerLang, currentBalance);

          const usage = await billingService.recordUsage(
            owner.id, projectId, result.model,
            { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: result.cacheWriteTokens, cache_read_input_tokens: result.cacheReadTokens },
            "update",
          );

          await projectService.updateProjectStatus(projectId, "deployed");
          try { await commitService.createCommit(projectId, `Fix: ${(message || "").toString().slice(0, 60)}`, result.commitNum!, result.commitDir!, result.logPath); } catch {}

          const history = chatService.getHistory(projectId, undefined, 1000);
          const updateNum = history.filter(m => m.type === "result").length + 1;
          const appName = project?.name || "App";
          const changelogUrl = await publishReport(`${appName} — Fix #${updateNum}`, result.summary, `Cost: $${usage.costUsd.toFixed(4)}`).catch(() => null);

          if (progressMsgId) {
            chatService.updateMessage(projectId, progressMsgId, { type: "result", content: result.shortSummary, percent: 100, costUsd: usage.costUsd, balance: usage.newBalance, checklist: items, metadata: { changelogUrl } });
          }
          broadcastToProject(projectId, { type: "status", projectId, status: "done", messageId: progressMsgId, summary: result.shortSummary, changelogUrl, costUsd: usage.costUsd, balance: usage.newBalance });

          notifyProcessDone(Number(owner.telegramId), appName, result.shortSummary, "fix", ownerLang);

          broadcastToProject(projectId, { type: "message", message: { role: "system", content: "preparing_next_update", metadata: { preparing: true } } });
          (async () => {
            try { await agentService.compactContext(projectId, result.commitDir!, result.summary, result.commitNum!, project?.description || undefined, project?.plan || undefined); } catch {}
            finally {
              broadcastToProject(projectId, { type: "finalizing_done", projectId });
              processingProjects.delete(projectId);
            }
          })();

        } catch (err: any) {
          if (err instanceof AgentAbortedError) {
            console.log(`[ErrorReport] Agent aborted for ${projectId}, billing partial usage`);
            await billingService.recordUsage(
              owner.id, projectId, err.model,
              { input_tokens: err.inputTokens, output_tokens: err.outputTokens, cache_creation_input_tokens: err.cacheWriteTokens, cache_read_input_tokens: err.cacheReadTokens },
              "update",
            );
            await projectService.updateProjectStatus(projectId, "deployed");
            processingProjects.delete(projectId);
            return;
          }
          console.error("[ErrorReport] Agent fix error:", err);
          await projectService.updateProjectStatus(projectId, "error");
          const errMsg = chatService.addMessage(projectId, { role: "assistant", type: "error", content: `${t(ownerLang, "sys_autofix_failed")}: ${err.message || "Unknown error"}` });
          broadcastToProject(projectId, { type: "message", message: errMsg });
          processingProjects.delete(projectId);
        }
      })();
    } catch (err) {
      console.error("[ErrorReport] Error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/chat/:projectId/suggestions", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const suggestLang = (user.language as Lang) || "en";
      const project = await projectService.getProject(req.params.projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const suggestions = await agentService.getSuggestions(req.params.projectId, suggestLang);
      res.json({ suggestions });
    } catch (err) {
      console.error("[Chat API] Suggestions error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Project preferences (style / theme / header / density / bottom menu) ──
  // Captured via a full-screen modal in the mini-app immediately after the
  // user's first prompt and BEFORE `/plan` is allowed to run.
  app.get("/telegram-mini-app/api/chat/:projectId/preferences", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const current = parseProjectPreferences((project as any).preferences ?? null);
      res.json({ catalog: PREFERENCES_CATALOG, current });
    } catch (err) {
      console.error("[Chat API] Get preferences error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/chat/:projectId/preferences", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const validation = validatePreferences(req.body);
      if (!validation.ok) {
        res.status(400).json({ error: "invalid_preferences", details: validation.errors });
        return;
      }

      const serialized = JSON.stringify(validation.prefs);
      await prisma.project.update({
        where: { id: projectId },
        data: { preferences: serialized } as any,
      });

      res.json({ ok: true, current: validation.prefs });
    } catch (err) {
      console.error("[Chat API] Save preferences error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/chat/:projectId/plan", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const planLang = (user.language as Lang) || "en";
      const projectId = req.params.projectId;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const { description } = req.body;
      if (!description?.trim()) { res.status(400).json({ error: "Description required" }); return; }

      // Gate plan generation on the user having picked preferences. The
      // mini-app reacts to a 412 by opening the preferences modal.
      const projectPrefs = parseProjectPreferences((project as any).preferences ?? null);
      if (!(project as any).preferences) {
        res.status(412).json({ error: "preferences_required" });
        return;
      }

      if (!(await billingService.hasBalance(user.id))) {
        res.status(402).json({ error: "Insufficient balance" });
        return;
      }

      await projectService.updateProjectDescription(projectId, description.trim());

      const assets = await projectService.getProjectAssets(projectId);
      const assetPaths = assets.map((a: any) => a.filePath).filter(Boolean) as string[];
      const result = await claudeService.generatePlan(description.trim(), assetPaths, planLang, projectPrefs);
      await projectService.updateProjectPlan(projectId, result.plan);

      const usage = await billingService.recordUsage(
        user.id, projectId, "claude-sonnet-4-6",
        { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        "plan"
      );

      chatService.addMessage(projectId, { role: "user", type: "text", content: description.trim() });
      chatService.addMessage(projectId, {
        role: "assistant", type: "plan", content: result.plan,
        metadata: { costUsd: usage.costUsd, balance: usage.newBalance },
      });

      void trackEvent(auth.telegramId!, "plan_created", {
        project_id: projectId,
        cost_usd: usage.costUsd,
      });

      res.json({ plan: result.plan, costUsd: usage.costUsd, balance: usage.newBalance });
    } catch (err) {
      console.error("[Chat API] Plan generation error:", err);
      res.status(500).json({ error: "Failed to generate plan" });
    }
  });

  app.post("/telegram-mini-app/api/chat/:projectId/approve-plan", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const buildLang = (user.language as Lang) || "en";
      const projectId = req.params.projectId;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      if (!project.plan) { res.status(400).json({ error: "No plan to approve" }); return; }
      if (processingProjects.has(projectId)) { res.status(409).json({ error: "Already processing" }); return; }

      const balance = await billingService.getUserBalance(user.id);
      if (balance < 5) {
        res.status(402).json({ error: t(buildLang, "insufficient_balance_amount", { balance: `$${balance.toFixed(2)}`, min: "$5.00" }) });
        return;
      }

      res.json({ status: "building" });

      void trackEvent(auth.telegramId!, "agent_started", {
        project_id: projectId,
        source: "approve_plan",
      });

      (async () => {
        processingProjects.add(projectId);
        let progressMsgId: string | null = null;
        let items: { id: number; text: string; done: boolean }[] = [];

        const progressMsg = chatService.addMessage(projectId, {
          role: "assistant", type: "progress", content: t(buildLang, "sys_starting"),
          percent: 0,
        });
        progressMsgId = progressMsg.id;
        broadcastToProject(projectId, { type: "message", message: progressMsg });

        try {
          await projectService.updateProjectStatus(projectId, "building");

          let progressDone = false;
          const onProgress = async (p: AgentProgress) => {
            if (!progressMsgId || progressDone) return;
            if ((p.percent ?? 0) >= 100) { progressDone = true; return; }
            chatService.updateMessage(projectId, progressMsgId, {
              content: `${p.action} ${p.detail}`, percent: p.percent, costUsd: p.costUsd, balance: p.balance,
            });
            broadcastToProject(projectId, {
              type: "progress", projectId, messageId: progressMsgId,
              percent: p.percent, message: `${p.action} ${p.detail}`,
              checklist: items, costUsd: p.costUsd, balance: p.balance,
            });
          };

          const onAskUser = async (question: string, options: string[]): Promise<string> => {
            const qMsg = chatService.addMessage(projectId, {
              role: "assistant", type: "question", content: question, metadata: { options },
            });
            broadcastToProject(projectId, { type: "question", projectId, messageId: qMsg.id, question, options });
            return new Promise<string>((resolve) => {
              const timeout = setTimeout(() => resolve(""), 5 * 60 * 1000);
              registerAnswerResolver(projectId, (answer: string) => {
                clearTimeout(timeout);
                chatService.removeMessage(projectId, qMsg.id);
                broadcastToProject(projectId, { type: "remove_messages", projectId, messageIds: [qMsg.id] });
                resolve(answer);
              });
            });
          };

          const onCreateTodo = async (todoItems: string[]) => {
            items = todoItems.map((t, i) => ({ id: i + 1, text: t, done: false }));
            if (progressMsgId) {
              chatService.updateMessage(projectId, progressMsgId, { checklist: items });
              broadcastToProject(projectId, { type: "progress", projectId, messageId: progressMsgId, checklist: items });
            }
          };

          const onCheckTodo = async (id: number) => {
            if (id >= 1 && id <= items.length) {
              items[id - 1].done = true;
              if (progressMsgId) {
                chatService.updateMessage(projectId, progressMsgId, { checklist: items });
                broadcastToProject(projectId, { type: "progress", projectId, messageId: progressMsgId, checklist: items });
              }
            }
          };

          const result = await agentService.buildApp(
            projectId, project.description || "", project.plan!,
            onProgress, onAskUser,
            onCreateTodo, onCheckTodo, buildLang, balance,
          );

          const usage = await billingService.recordUsage(
            user.id, projectId, result.model,
            { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: result.cacheWriteTokens, cache_read_input_tokens: result.cacheReadTokens },
            "build",
          );

          await projectService.updateProjectStatus(projectId, "deployed");

          try {
            await commitService.createCommit(projectId, `App created: ${(project.description || "").substring(0, 80)}`, result.commitNum!, result.commitDir!, result.logPath);
            await commitService.releaseCurrentDev(projectId);
            try { forceReloadProjectWs(projectId, false); } catch {}
            try { invalidateProjectDbCache(projectId); } catch {}
          } catch {}

          const appName = project.name || "App";
          const changelogUrl = await publishReport(`${appName} — Created`, result.summary, `Cost: $${usage.costUsd.toFixed(4)}`).catch(() => null);

          if (progressMsgId) {
            chatService.updateMessage(projectId, progressMsgId, {
              type: "result", content: result.shortSummary,
              percent: 100, costUsd: usage.costUsd, balance: usage.newBalance,
              metadata: { changelogUrl },
            });
            broadcastToProject(projectId, {
              type: "status", projectId, messageId: progressMsgId,
              status: "done", summary: result.shortSummary,
              changelogUrl,
              costUsd: usage.costUsd, balance: usage.newBalance,
            });
          }

          broadcastToProject(projectId, { type: "status_change", projectId, status: "deployed" });

          notifyProcessDone(auth.telegramId!, appName, result.shortSummary, "build", buildLang);

          // Run passport in background
          broadcastToProject(projectId, { type: "message", message: { role: "system", content: "preparing_next_update", metadata: { preparing: true } } });
          (async () => {
            try {
              await agentService.compactContext(projectId, result.commitDir!, result.summary, result.commitNum!, project.description || undefined, project.plan || undefined);
            } catch (err) {
              console.error("[Chat API] Background passport error:", err);
            } finally {
              broadcastToProject(projectId, { type: "finalizing_done", projectId });
              processingProjects.delete(projectId);
            }
          })();
        } catch (err: any) {
          if (err instanceof AgentAbortedError) {
            console.log(`[Chat API] Build aborted for ${projectId}, billing partial usage`);
            await billingService.recordUsage(
              user.id, projectId, err.model,
              { input_tokens: err.inputTokens, output_tokens: err.outputTokens, cache_creation_input_tokens: err.cacheWriteTokens, cache_read_input_tokens: err.cacheReadTokens },
              "build",
            );
            await projectService.updateProjectStatus(projectId, project.generatedCode ? "deployed" : "created");
            processingProjects.delete(projectId);
            return;
          }
          console.error("[Chat API] Build error:", err);
          await projectService.updateProjectStatus(projectId, "error");
          const errMsg = chatService.addMessage(projectId, { role: "system", type: "error", content: `${t(buildLang, "sys_build_failed")}: ${err.message || "Unknown error"}` });
          broadcastToProject(projectId, { type: "message", message: errMsg });
          processingProjects.delete(projectId);
        }
      })();
    } catch (err) {
      console.error("[Chat API] Approve plan error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/chat/:projectId/edit-plan", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const editPlanLang = (user.language as Lang) || "en";
      const projectId = req.params.projectId;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const { feedback } = req.body;
      if (!feedback?.trim()) { res.status(400).json({ error: "Feedback required" }); return; }

      if (!(await billingService.hasBalance(user.id))) {
        res.status(402).json({ error: "Insufficient balance" });
        return;
      }

      chatService.addMessage(projectId, { role: "user", type: "text", content: feedback.trim() });

      const updatedDescription = `${project.description}\n\nAdditional feedback: ${feedback.trim()}`;
      const editPrefs = parseProjectPreferences((project as any).preferences ?? null);
      const result = await claudeService.generatePlan(updatedDescription, undefined, editPlanLang, editPrefs);
      await projectService.updateProjectPlan(projectId, result.plan);

      const usage = await billingService.recordUsage(
        user.id, projectId, "claude-sonnet-4-6",
        { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        "plan"
      );

      chatService.addMessage(projectId, {
        role: "assistant", type: "plan", content: result.plan,
        metadata: { costUsd: usage.costUsd, balance: usage.newBalance },
      });

      res.json({ plan: result.plan, costUsd: usage.costUsd, balance: usage.newBalance });
    } catch (err) {
      console.error("[Chat API] Edit plan error:", err);
      res.status(500).json({ error: "Failed to update plan" });
    }
  });

  app.post("/telegram-mini-app/api/chat/:projectId/answer", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const project = await projectService.getProject(req.params.projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const { answer } = req.body;
      const resolved = resolveAnswer(req.params.projectId, answer || "");
      res.json({ resolved });
    } catch (err) {
      console.error("[Chat API] Answer error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/chat/:projectId/abort", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const isInFlight = processingProjects.has(projectId);

      // Always recompute dangling messages from chat history so we can clean
      // up a stuck UI even when there's no in-memory entry (typically left
      // over from a server restart that interrupted an active build).
      const history = chatService.getHistory(projectId, undefined, 1000);
      const danglingIds = history
        .filter(m => (m.type === "progress" && (m.percent ?? 0) < 100) || m.type === "question")
        .map(m => m.id);

      if (!isInFlight && danglingIds.length === 0) {
        // Truly nothing to do — UI is already in sync with server.
        res.json({ ok: false, error: "Not processing" });
        return;
      }

      if (isInFlight) {
        abortedProjects.add(projectId);
        console.log(`[Chat API] Abort requested for project ${projectId} by user ${auth.telegramId}`);
      } else {
        console.log(`[Chat API] Recovering stuck UI for project ${projectId} (${danglingIds.length} dangling msg(s))`);
      }

      for (const id of danglingIds) {
        chatService.removeMessage(projectId, id);
      }
      if (danglingIds.length > 0) {
        broadcastToProject(projectId, { type: "remove_messages", projectId, messageIds: danglingIds });
      }

      broadcastToProject(projectId, { type: "finalizing_done", projectId });

      res.json({ ok: true, recovered: !isInFlight && danglingIds.length > 0 });
    } catch (err) {
      console.error("[Chat API] Abort error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Versions API ──

  app.get("/telegram-mini-app/api/versions/:projectId", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const project = await projectService.getProject(req.params.projectId as string);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const commits = await commitService.getCommits(req.params.projectId as string);
      const allMessages = chatService.getHistory(req.params.projectId as string, undefined, 10000);
      const resultMessages = allMessages.filter(m => m.type === "result");
      const resultMessagesReversed = [...resultMessages].reverse();

      const versions = commits.map((c, idx) => {
        const resultMsg = resultMessagesReversed[idx];
        return {
          version: parseInt(c.version, 10),
          changelog: c.changelog || "",
          createdAt: c.createdAt,
          isReleased: project.releaseCommit === parseInt(c.version, 10),
          hasLog: !!commitService.getLogPath(req.params.projectId as string, parseInt(c.version, 10)),
          hasDetailedLog: !!commitService.getDetailedLogPath(req.params.projectId as string, parseInt(c.version, 10)),
          changelogUrl: resultMsg?.metadata?.changelogUrl || null,
        };
      });
      res.json({ versions, releaseCommit: project.releaseCommit });
    } catch (err) {
      console.error("[MiniApp API] Versions error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/versions/:projectId/release", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const { version } = req.body;
      if (version !== undefined && version !== null) {
        await commitService.revertToCommit(projectId, version);
      }
      const commitNum = await commitService.releaseCurrentDev(projectId);
      // Reload the release WS handler and evict the DB cache so the new
      // routes.js takes effect immediately without a server restart.
      try { forceReloadProjectWs(projectId, false); } catch {}
      try { invalidateProjectDbCache(projectId); } catch {}
      res.json({ released: commitNum });
    } catch (err) {
      console.error("[MiniApp API] Release error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/versions/:projectId/revert", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const { version } = req.body;
      if (typeof version !== "number") { res.status(400).json({ error: "Version required" }); return; }
      await commitService.revertToCommit(projectId, version);
      res.json({ reverted: version });
    } catch (err) {
      console.error("[MiniApp API] Revert error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/telegram-mini-app/api/versions/:projectId/log/:version", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const ver = parseInt(req.params.version as string, 10);
      const logPath = commitService.getLogPath(projectId, ver);
      if (!logPath) { res.status(404).json({ error: "Log not found" }); return; }

      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="update-${ver}.log"`);
      fs.createReadStream(logPath).pipe(res);
    } catch (err) {
      console.error("[MiniApp API] Log download error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Admin-only: download the full detailed Anthropic request/response log for a commit
  app.get("/telegram-mini-app/api/versions/:projectId/detailed-log/:version", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      if (!isAdminTelegramId(auth.telegramId)) { res.status(403).json({ error: "Admin only" }); return; }

      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project) { res.status(404).json({ error: "Project not found" }); return; }

      const ver = parseInt(req.params.version as string, 10);
      const detailedPath = commitService.getDetailedLogPath(projectId, ver);
      if (!detailedPath) { res.status(404).json({ error: "Detailed log not found" }); return; }

      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="detailed-log-${ver}.json"`);
      fs.createReadStream(detailedPath).pipe(res);
    } catch (err) {
      console.error("[MiniApp API] Detailed log download error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Parsed log data as JSON for the viewer
  app.get("/telegram-mini-app/api/versions/:projectId/log-data/:version", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const ver = parseInt(req.params.version as string, 10);
      const logPath = commitService.getLogPath(projectId, ver);
      if (!logPath) { res.status(404).json({ error: "Log not found" }); return; }

      const entries = parseAgentLog(logPath);
      res.json({ entries, version: ver, projectId });
    } catch (err) {
      console.error("[MiniApp API] Log data error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/quality/:projectId", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const { tier } = req.body;
      if (typeof tier !== "number" || tier < 1 || tier > 4) { res.status(400).json({ error: "Invalid tier (1-4)" }); return; }

      const { prisma } = await import("../db");
      await prisma.project.update({ where: { id: projectId }, data: { qualityTier: tier } });

      res.json({ tier });
    } catch (err) {
      console.error("[MiniApp API] Quality tier error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Regenerate Context API ──

  app.post("/telegram-mini-app/api/regenerate-context/:projectId", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const context = await agentService.regenerateContext(projectId);
      res.json({
        success: true,
        message: "Context regenerated from source code",
        preview: context.substring(0, 500) + "...",
      });
    } catch (err: any) {
      console.error("[MiniApp API] Regenerate context error:", err);
      res.status(500).json({ error: err.message || "Failed to regenerate context" });
    }
  });

  // ── Transfer Ownership API ──

  app.post("/telegram-mini-app/api/transfer/:projectId", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const { username } = req.body;
      if (!username) { res.status(400).json({ error: "Username is required" }); return; }

      const cleanUsername = username.replace(/^@/, "").trim().toLowerCase();
      if (!cleanUsername) { res.status(400).json({ error: "Invalid username" }); return; }

      const targetUser = await projectService.getUserByUsername(cleanUsername);
      if (!targetUser) { res.status(404).json({ error: "User not found. They must be registered in Apps Father." }); return; }
      if (targetUser.id === user.id) { res.status(400).json({ error: "You already own this app" }); return; }

      await projectService.transferProject(projectId, targetUser.id);
      res.json({ ok: true, transferredTo: cleanUsername });
    } catch (err) {
      console.error("[MiniApp API] Transfer error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Delete App API ──

  app.post("/telegram-mini-app/api/delete/:projectId", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      try {
        const { botRunnerService } = await import("../services/bot-runner.service");
        await botRunnerService.stopBot(projectId);
      } catch {}

      await projectService.deleteProject(projectId);

      const projectDir = path.join(process.cwd(), "projects", projectId);
      if (fs.existsSync(projectDir)) {
        fs.rmSync(projectDir, { recursive: true, force: true });
      }
      avatarCache.delete(projectId);

      res.json({ ok: true });
    } catch (err) {
      console.error("[MiniApp API] Delete error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Bot Info API ──

  app.post("/telegram-mini-app/api/bot-info/:projectId", upload.single("photo"), async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }
      if (!project.botTokenEncrypted) { res.status(400).json({ error: "No bot token" }); return; }

      const token = decryptToken(project.botTokenEncrypted);
      const { name, about, description } = req.body;
      const photoFile = (req as any).file as Express.Multer.File | undefined;
      const errors: string[] = [];

      if (name) {
        const r = await fetch(`https://api.telegram.org/bot${token}/setMyName`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const d = await r.json() as any;
        if (!d.ok) errors.push(`Name: ${d.description || "failed"}`);
      }

      if (about !== undefined) {
        const r = await fetch(`https://api.telegram.org/bot${token}/setMyShortDescription`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ short_description: about }),
        });
        const d = await r.json() as any;
        if (!d.ok) errors.push(`About: ${d.description || "failed"}`);
      }

      if (description !== undefined) {
        const r = await fetch(`https://api.telegram.org/bot${token}/setMyDescription`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ description }),
        });
        const d = await r.json() as any;
        if (!d.ok) errors.push(`Description: ${d.description || "failed"}`);
      }

      let newAvatarUrl: string | null = null;
      if (photoFile) {
        try {
          const fileBuffer = fs.readFileSync(photoFile.path);
          const blob = new Blob([fileBuffer], { type: "image/jpeg" });
          const formData = new (globalThis as any).FormData();
          formData.set("photo", JSON.stringify({ type: "static", photo: "attach://photo_file" }));
          formData.set("photo_file", blob, photoFile.originalname);
          const r = await fetch(`https://api.telegram.org/bot${token}/setMyProfilePhoto`, {
            method: "POST",
            body: formData,
          });
          const d = await r.json() as any;
          if (!d.ok) errors.push(`Photo: ${d.description || "failed"}`);
        } catch (photoErr: any) {
          errors.push(`Photo: ${photoErr.message || "upload failed"}`);
        }
        try { fs.unlinkSync(photoFile.path); } catch {}
        avatarCache.delete(projectId);
      }

      const { prisma } = await import("../db");
      const updateData: any = {};
      if (name) updateData.name = name;
      if (description !== undefined) updateData.description = description;
      if (Object.keys(updateData).length > 0) {
        await prisma.project.update({ where: { id: projectId }, data: updateData });
      }

      res.json({ ok: errors.length === 0, errors, avatarUrl: newAvatarUrl });
    } catch (err) {
      console.error("[MiniApp API] Bot info error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/telegram-mini-app/api/avatar/:projectId", (req, res) => {
    const avatarPath = path.join(process.cwd(), "projects", req.params.projectId as string, "avatar.jpg");
    if (fs.existsSync(avatarPath)) {
      res.sendFile(avatarPath);
    } else {
      res.status(404).end();
    }
  });

  // ── Features API ──

  app.get("/telegram-mini-app/api/features/:projectId", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const { getProjectFeatures, PAID_FEATURES } = await import("../services/features.service");
      const owned = await getProjectFeatures(projectId);
      const balance = await billingService.getUserBalance(user.id);

      const features = PAID_FEATURES.map(f => ({
        id: f.id,
        label: f.label,
        price: f.price,
        description: f.description,
        owned: owned.includes(f.id),
      }));

      res.json({ features, balance });
    } catch (err) {
      console.error("[MiniApp API] Features error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/features/:projectId/buy", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const { featureId } = req.body;
      if (!featureId) { res.status(400).json({ error: "featureId required" }); return; }

      const { purchaseFeature, getFeatureById } = await import("../services/features.service");
      const feature = getFeatureById(featureId);
      if (!feature) { res.status(400).json({ error: "Unknown feature" }); return; }

      const { newBalance } = await purchaseFeature(user.id, projectId, featureId);

      void trackEvent(auth.telegramId!, "purchase", {
        type: "feature",
        feature_id: featureId,
        feature_label: feature.label,
        amount: feature.price,
        project_id: projectId,
      });

      res.json({ success: true, newBalance, featureId });
    } catch (err: any) {
      console.error("[MiniApp API] Feature purchase error:", err);
      res.status(400).json({ error: err.message || "Purchase failed" });
    }
  });

  app.post("/telegram-mini-app/api/chat/:projectId/upload", upload.array("files", 5), async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const files = (req as any).files as Express.Multer.File[];
      if (!files || files.length === 0) { res.status(400).json({ error: "No files" }); return; }
      const assetsDir = path.join(process.cwd(), "projects", projectId, "development", "frontend", "assets");
      fs.mkdirSync(assetsDir, { recursive: true });

      const uploaded = files.map(f => {
        const dest = path.join(assetsDir, f.originalname);
        fs.renameSync(f.path, dest);
        return { name: f.originalname, path: dest, type: f.mimetype };
      });

      res.json({ files: uploaded });
    } catch (err) {
      console.error("[Chat API] Upload error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Mini App Admin API ──

  const ADMIN_TELEGRAM_IDS = [8784357184, 8796958409];
  function isAdminTelegramId(telegramId: number | undefined): boolean {
    return !!telegramId && ADMIN_TELEGRAM_IDS.includes(telegramId);
  }
  const PROJECTS_DIR = path.join(process.cwd(), "projects");

  function adminGuard(req: express.Request, res: express.Response): { telegramId: number } | null {
    const auth = validateAuth(req);
    if (!auth.valid || !auth.telegramId) { res.status(401).json({ error: "Unauthorized" }); return null; }
    if (!ADMIN_TELEGRAM_IDS.includes(auth.telegramId)) { res.status(403).json({ error: "Forbidden" }); return null; }
    return { telegramId: auth.telegramId };
  }

  app.get("/telegram-mini-app/api/admin/check", (req, res) => {
    const auth = validateAuth(req);
    if (!auth.valid || !auth.telegramId) { res.json({ isAdmin: false }); return; }
    res.json({ isAdmin: ADMIN_TELEGRAM_IDS.includes(auth.telegramId) });
  });

  app.get("/telegram-mini-app/api/admin/stats", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const [userCount, projectCount, totalSpent, totalTopups, payingUsers, activeUsers7d] = await Promise.all([
        prisma.user.count(),
        prisma.project.count(),
        prisma.usageLog.aggregate({ _sum: { costUsd: true } }),
        prisma.payment.aggregate({ _sum: { amountUsd: true }, where: { status: "confirmed" } }),
        prisma.payment.groupBy({ by: ["userId"], where: { status: "confirmed" } }).then(g => g.length),
        prisma.usageLog.groupBy({ by: ["userId"], where: { createdAt: { gte: sevenDaysAgo } } }).then(g => g.length),
      ]);
      const recentUsage = await prisma.usageLog.findMany({
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { user: { select: { username: true, firstName: true } }, project: { select: { name: true } } },
      });
      res.json({
        userCount, projectCount, payingUsers, activeUsers7d,
        totalSpent: Number(totalSpent._sum.costUsd || 0),
        totalTopups: Number(totalTopups._sum.amountUsd || 0),
        recentUsage: recentUsage.map(u => ({
          id: u.id,
          username: u.user.username || u.user.firstName || `User ${u.userId}`,
          project: u.project?.name || "-",
          operation: u.operation,
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cost: Number(u.costUsd),
          createdAt: u.createdAt,
        })),
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get("/telegram-mini-app/api/admin/stats/sources", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      // Optional date range filter on user.created_at. Both bounds are
      // optional ISO timestamps. Invalid values are silently ignored so
      // bad input never breaks the admin dashboard.
      const parseIso = (raw: unknown): Date | null => {
        if (typeof raw !== "string" || !raw) return null;
        const d = new Date(raw);
        return isNaN(d.getTime()) ? null : d;
      };
      const fromDate = parseIso(req.query.from);
      const toDate = parseIso(req.query.to);

      // One pass: user-level aggregate (cheap on admin scale)
      const userAgg = await prisma.$queryRawUnsafe<Array<{
        id: number;
        utm_source: string | null;
        referred_by: bigint | null;
        has_bot: boolean;
        has_plan: boolean;
        has_app: boolean;
        revenue: any;
      }>>(`
        SELECT
          u.id,
          NULLIF(u.utm_source, '') AS utm_source,
          u.referred_by,
          EXISTS (
            SELECT 1 FROM projects p
            WHERE p.user_id = u.id AND p.bot_username IS NOT NULL
          ) AS has_bot,
          EXISTS (
            SELECT 1 FROM projects p
            WHERE p.user_id = u.id AND p.plan IS NOT NULL
          ) AS has_plan,
          EXISTS (
            SELECT 1 FROM projects p
            WHERE p.user_id = u.id AND p.status IN ('deployed', 'released')
          ) AS has_app,
          COALESCE((
            SELECT SUM(pm.amount_usd) FROM payments pm
            WHERE pm.user_id = u.id AND pm.status = 'confirmed'
          ), 0) AS revenue
        FROM users u
        WHERE ($1::timestamptz IS NULL OR u.created_at >= $1::timestamptz)
          AND ($2::timestamptz IS NULL OR u.created_at <  $2::timestamptz)
      `, fromDate, toDate);

      type Metrics = {
        users: number; createdBot: number; createdPlan: number; createdApp: number;
        payingUsers: number; revenue: number;
      };
      const emptyMetrics = (): Metrics => ({
        users: 0, createdBot: 0, createdPlan: 0, createdApp: 0, payingUsers: 0, revenue: 0,
      });
      const addUser = (m: Metrics, r: (typeof userAgg)[number]) => {
        m.users++;
        if (r.has_bot) m.createdBot++;
        if (r.has_plan) m.createdPlan++;
        if (r.has_app) m.createdApp++;
        const rev = Number(r.revenue);
        if (rev > 0) m.payingUsers++;
        m.revenue += rev;
      };
      const finalizeMetrics = (m: Metrics) => ({
        ...m,
        conversion: m.users > 0 ? (m.payingUsers / m.users) * 100 : 0,
        arpu: m.users > 0 ? m.revenue / m.users : 0,
        arppu: m.payingUsers > 0 ? m.revenue / m.payingUsers : 0,
      });

      // --- Referrers / Partners: group users by their referrer's telegramId ---
      const perReferrer = new Map<string, Metrics>();
      // --- Sources: group users by utm_source ---
      const perSource = new Map<string, Metrics>();
      // --- Organic: no utm, no referral ---
      const organicMetrics = emptyMetrics();
      const allMetrics = emptyMetrics();

      for (const r of userAgg) {
        addUser(allMetrics, r);
        if (r.referred_by) {
          const key = String(r.referred_by);
          let m = perReferrer.get(key);
          if (!m) { m = emptyMetrics(); perReferrer.set(key, m); }
          addUser(m, r);
        }
        if (r.utm_source) {
          let m = perSource.get(r.utm_source);
          if (!m) { m = emptyMetrics(); perSource.set(r.utm_source, m); }
          addUser(m, r);
        }
        if (!r.referred_by && !r.utm_source) {
          addUser(organicMetrics, r);
        }
      }

      // Fetch referrer user info (to split into partner vs referrer + for display)
      const referrerIds = Array.from(perReferrer.keys()).map(k => BigInt(k));
      const referrerUsers = referrerIds.length > 0
        ? await prisma.user.findMany({
            where: { telegramId: { in: referrerIds } },
            select: {
              id: true, telegramId: true, username: true, firstName: true,
              isPartner: true, partnerTag: true, partnerPercent: true,
            },
          })
        : [];

      const sources = Array.from(perSource.entries())
        .map(([source, m]) => ({ source, ...finalizeMetrics(m) }))
        .sort((a, b) => b.users - a.users);

      const partners: any[] = [];
      const referrers: any[] = [];
      for (const user of referrerUsers) {
        const key = String(user.telegramId);
        const m = perReferrer.get(key);
        if (!m) continue;
        const base = {
          telegramId: String(user.telegramId),
          username: user.username,
          firstName: user.firstName,
          ...finalizeMetrics(m),
        };
        if (user.isPartner) {
          partners.push({
            ...base,
            partnerTag: user.partnerTag,
            partnerPercent: user.partnerPercent != null ? Number(user.partnerPercent) : null,
          });
        } else {
          referrers.push(base);
        }
      }
      partners.sort((a, b) => b.users - a.users);
      referrers.sort((a, b) => b.users - a.users);

      // Resolve avatars for partners + referrers via main bot token (cached)
      const mainToken = config.botToken;
      if (mainToken) {
        const resolveAvatar = async (telegramId: string): Promise<string | null> => {
          const cacheKey = `u:${telegramId}`;
          if (avatarCache.has(cacheKey)) return avatarCache.get(cacheKey)!;
          try {
            const r = await fetch(`https://api.telegram.org/bot${mainToken}/getUserProfilePhotos?user_id=${telegramId}&limit=1`);
            const d: any = await r.json();
            if (!d.ok || !d.result?.photos?.length) return null;
            const photo = d.result.photos[0];
            const biggest = photo[photo.length - 1];
            const fr = await fetch(`https://api.telegram.org/bot${mainToken}/getFile?file_id=${biggest.file_id}`);
            const fd: any = await fr.json();
            if (!fd.ok) return null;
            const url = `https://api.telegram.org/file/bot${mainToken}/${fd.result.file_path}`;
            avatarCache.set(cacheKey, url);
            return url;
          } catch { return null; }
        };

        await Promise.allSettled(
          [...partners, ...referrers].map(async (p) => {
            p.avatarUrl = await resolveAvatar(p.telegramId);
          })
        );
      }

      res.json({
        range: {
          from: fromDate ? fromDate.toISOString() : null,
          to: toDate ? toDate.toISOString() : null,
        },
        all: { source: "All", ...finalizeMetrics(allMetrics) },
        organic: { source: "Organic", ...finalizeMetrics(organicMetrics) },
        sources,
        partners,
        referrers,
      });
    } catch (err: any) {
      console.error("[Admin] Sources stats error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // List of users that registered in the given date range AND match a
  // specific bucket from the Sources screen. Powers the per-card "Users"
  // drill-down. Mirrors the filtering logic of /stats/sources so the user
  // counts always line up.
  //   kind=all                          -> every user in the range
  //   kind=organic                      -> no utm_source AND no referred_by
  //   kind=source  &key=<utm_source>    -> users with that utm_source
  //   kind=partner &key=<telegramId>    -> users referred by that telegramId
  //   kind=referrer&key=<telegramId>    -> same shape as partner
  app.get("/telegram-mini-app/api/admin/stats/sources/users", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const parseIso = (raw: unknown): Date | null => {
        if (typeof raw !== "string" || !raw) return null;
        const d = new Date(raw);
        return isNaN(d.getTime()) ? null : d;
      };
      const fromDate = parseIso(req.query.from);
      const toDate = parseIso(req.query.to);
      const kind = String(req.query.kind || "all");
      const key = typeof req.query.key === "string" ? req.query.key : "";

      const where: any = {};
      if (fromDate || toDate) {
        where.createdAt = {};
        if (fromDate) where.createdAt.gte = fromDate;
        if (toDate)   where.createdAt.lt  = toDate;
      }

      if (kind === "organic") {
        where.AND = [
          { OR: [{ utmSource: null }, { utmSource: "" }] },
          { referredBy: null },
        ];
      } else if (kind === "source") {
        if (!key) { res.status(400).json({ error: "key required for kind=source" }); return; }
        where.utmSource = key;
      } else if (kind === "partner" || kind === "referrer") {
        if (!key) { res.status(400).json({ error: "key required for kind=" + kind }); return; }
        let tgId: bigint;
        try { tgId = BigInt(key); } catch { res.status(400).json({ error: "key must be a telegramId" }); return; }
        where.referredBy = tgId;
      } else if (kind !== "all") {
        res.status(400).json({ error: "unknown kind: " + kind });
        return;
      }

      const users = await prisma.user.findMany({
        where,
        orderBy: { createdAt: "desc" },
        select: {
          id: true, telegramId: true, username: true, firstName: true,
          balance: true, createdAt: true, utmSource: true, referredBy: true,
          _count: { select: { projects: true } },
        },
      });

      // Funnel + revenue per user (matches /stats/sources columns so the
      // drill-down feels consistent with the parent card).
      const userIds = users.map(u => u.id);
      let funnels = new Map<number, { hasBot: boolean; hasPlan: boolean; hasApp: boolean; revenue: number }>();
      if (userIds.length > 0) {
        const rows = await prisma.$queryRawUnsafe<Array<{
          id: number; has_bot: boolean; has_plan: boolean; has_app: boolean; revenue: any;
        }>>(`
          SELECT
            u.id,
            EXISTS (SELECT 1 FROM projects p WHERE p.user_id = u.id AND p.bot_username IS NOT NULL) AS has_bot,
            EXISTS (SELECT 1 FROM projects p WHERE p.user_id = u.id AND p.plan IS NOT NULL)        AS has_plan,
            EXISTS (SELECT 1 FROM projects p WHERE p.user_id = u.id AND p.status IN ('deployed','released')) AS has_app,
            COALESCE((SELECT SUM(pm.amount_usd) FROM payments pm WHERE pm.user_id = u.id AND pm.status = 'confirmed'), 0) AS revenue
          FROM users u
          WHERE u.id = ANY($1::int[])
        `, userIds);
        for (const r of rows) {
          funnels.set(r.id, {
            hasBot: r.has_bot, hasPlan: r.has_plan, hasApp: r.has_app,
            revenue: Number(r.revenue),
          });
        }
      }

      res.json({
        range: {
          from: fromDate ? fromDate.toISOString() : null,
          to:   toDate   ? toDate.toISOString()   : null,
        },
        kind,
        key,
        count: users.length,
        users: users.map(u => {
          const f = funnels.get(u.id);
          return {
            id: u.id,
            telegramId: u.telegramId.toString(),
            username: u.username,
            firstName: u.firstName,
            balance: Number(u.balance),
            projectCount: u._count.projects,
            createdAt: u.createdAt,
            utmSource: u.utmSource,
            referredBy: u.referredBy?.toString() || null,
            hasBot: f?.hasBot ?? false,
            hasPlan: f?.hasPlan ?? false,
            hasApp: f?.hasApp ?? false,
            revenue: f?.revenue ?? 0,
          };
        }),
      });
    } catch (err: any) {
      console.error("[Admin] Sources users error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/telegram-mini-app/api/admin/users", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const users = await prisma.user.findMany({
        include: { _count: { select: { projects: true } } },
        orderBy: { createdAt: "desc" },
      });
      res.json(users.map(u => ({
        id: u.id,
        telegramId: u.telegramId.toString(),
        username: u.username,
        firstName: u.firstName,
        balance: Number(u.balance),
        appSlots: u.appSlots,
        referredBy: u.referredBy?.toString() || null,
        projectCount: u._count.projects,
        createdAt: u.createdAt,
      })));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get("/telegram-mini-app/api/admin/users/:id", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const userId = parseInt(req.params.id);
      const user = await prisma.user.findUnique({
        where: { id: userId },
        include: {
          projects: { orderBy: { updatedAt: "desc" } },
          payments: { orderBy: { createdAt: "desc" }, take: 20 },
          usageLogs: { orderBy: { createdAt: "desc" }, take: 30, include: { project: { select: { name: true } } } },
        },
      });
      if (!user) { res.status(404).json({ error: "User not found" }); return; }
      const totalSpent = await prisma.usageLog.aggregate({ _sum: { costUsd: true }, where: { userId } });
      res.json({
        id: user.id,
        telegramId: user.telegramId.toString(),
        username: user.username,
        firstName: user.firstName,
        balance: Number(user.balance),
        appSlots: user.appSlots,
        referredBy: user.referredBy?.toString() || null,
        totalSpent: Number(totalSpent._sum.costUsd || 0),
        createdAt: user.createdAt,
        isPartner: user.isPartner,
        partnerPercent: user.partnerPercent ? Number(user.partnerPercent) : null,
        partnerTag: user.partnerTag,
        partnerReferralBonus: user.partnerReferralBonus ? Number(user.partnerReferralBonus) : null,
        partnerBalance: Number(user.partnerBalance),
        projects: user.projects.map(p => ({
          id: p.id, name: p.name, status: p.status, botUsername: p.botUsername,
          totalCost: Number(p.totalCostUsd), createdAt: p.createdAt, updatedAt: p.updatedAt,
        })),
        payments: user.payments.map(p => ({
          id: p.id, amount: Number(p.amountUsd), status: p.status,
          createdAt: p.createdAt, confirmedAt: p.confirmedAt,
        })),
        usageLogs: user.usageLogs.map(l => ({
          id: l.id, project: l.project?.name || "-", operation: l.operation,
          inputTokens: l.inputTokens, outputTokens: l.outputTokens,
          cost: Number(l.costUsd), createdAt: l.createdAt,
        })),
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post("/telegram-mini-app/api/admin/users/:id/partner", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const userId = parseInt(req.params.id);
      const { isPartner, partnerPercent, partnerTag, partnerReferralBonus } = req.body;
      const data: any = {};
      if (typeof isPartner === "boolean") data.isPartner = isPartner;
      if (partnerPercent !== undefined) data.partnerPercent = partnerPercent === null ? null : new Decimal(parseFloat(partnerPercent).toFixed(2));
      if (partnerTag !== undefined) data.partnerTag = partnerTag || null;
      if (partnerReferralBonus !== undefined) data.partnerReferralBonus = partnerReferralBonus === null ? null : new Decimal(parseFloat(partnerReferralBonus).toFixed(4));
      const updated = await prisma.user.update({ where: { id: userId }, data });
      res.json({
        isPartner: updated.isPartner,
        partnerPercent: updated.partnerPercent ? Number(updated.partnerPercent) : null,
        partnerTag: updated.partnerTag,
        partnerReferralBonus: updated.partnerReferralBonus ? Number(updated.partnerReferralBonus) : null,
        partnerBalance: Number(updated.partnerBalance),
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post("/telegram-mini-app/api/admin/users/:id/balance", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const userId = parseInt(req.params.id);
      const { action, amount } = req.body;
      const val = parseFloat(amount);
      if (isNaN(val) || val < 0) { res.status(400).json({ error: "Invalid amount" }); return; }
      let updated;
      if (action === "set") {
        updated = await prisma.user.update({ where: { id: userId }, data: { balance: new Decimal(val.toFixed(4)) } });
      } else if (action === "add") {
        updated = await prisma.user.update({ where: { id: userId }, data: { balance: { increment: new Decimal(val.toFixed(4)) } } });
      } else { res.status(400).json({ error: "action must be 'set' or 'add'" }); return; }
      res.json({ balance: Number(updated.balance) });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Wipe user-attached data (payments, conversations, usage logs, withdrawals,
  // voucher redemptions) and reset user profile fields to defaults — but KEEP
  // the User row and KEEP all Projects (apps continue to function under the
  // anonymized user). Used from the Admin → User View "Wipe User Data" button.
  app.delete("/telegram-mini-app/api/admin/users/:id/data", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const userId = parseInt(req.params.id);
      const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, telegramId: true } });
      if (!user) { res.status(404).json({ error: "User not found" }); return; }

      const result = await prisma.$transaction(async (tx) => {
        const [payments, conversations, usageLogs, withdrawals, voucherRedemptions] = await Promise.all([
          tx.payment.deleteMany({ where: { userId } }),
          tx.conversation.deleteMany({ where: { userId } }),
          tx.usageLog.deleteMany({ where: { userId } }),
          tx.withdrawal.deleteMany({ where: { userId } }),
          tx.voucherRedemption.deleteMany({ where: { userId } }),
        ]);

        await tx.user.update({
          where: { id: userId },
          data: {
            username: null,
            firstName: null,
            balance: new Decimal(0),
            partnerBalance: new Decimal(0),
            isPartner: false,
            partnerPercent: null,
            partnerTag: null,
            partnerReferralBonus: null,
            firstDepositBonusGiven: false,
            utmSource: null,
            referredBy: null,
            language: "en",
          },
        });

        return {
          payments: payments.count,
          conversations: conversations.count,
          usageLogs: usageLogs.count,
          withdrawals: withdrawals.count,
          voucherRedemptions: voucherRedemptions.count,
        };
      });

      console.log(`[Admin] Wiped data for user ${userId} (tg=${user.telegramId}):`, result);
      res.json({ ok: true, deleted: result });
    } catch (err: any) {
      console.error("[Admin] Wipe user data error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // FULL RESET — deletes everything for this user (projects + bots managed by
  // us, all attached records, and the User row itself). After this the user
  // is registered fresh on next /api/init, so source/referrer/partner-tag
  // attribution can be tested end-to-end.
  // Intended ONLY for internal testing, not for production user management.
  app.delete("/telegram-mini-app/api/admin/users/:id/full", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const userId = parseInt(req.params.id);
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, telegramId: true, projects: { select: { id: true } } },
      });
      if (!user) { res.status(404).json({ error: "User not found" }); return; }

      const projectIds = user.projects.map((p) => p.id);

      const result = await prisma.$transaction(async (tx) => {
        // First clear records that reference projects (FK constraints).
        let assets = { count: 0 };
        let versions = { count: 0 };
        if (projectIds.length) {
          [assets, versions] = await Promise.all([
            tx.asset.deleteMany({ where: { projectId: { in: projectIds } } }),
            tx.version.deleteMany({ where: { projectId: { in: projectIds } } }),
          ]);
        }

        // User-attached records (these cover both project-bound and not,
        // since both conversation.userId and usageLog.userId are required).
        const [payments, conversations, usageLogs, withdrawals, voucherRedemptions] = await Promise.all([
          tx.payment.deleteMany({ where: { userId } }),
          tx.conversation.deleteMany({ where: { userId } }),
          tx.usageLog.deleteMany({ where: { userId } }),
          tx.withdrawal.deleteMany({ where: { userId } }),
          tx.voucherRedemption.deleteMany({ where: { userId } }),
        ]);

        const projects = await tx.project.deleteMany({ where: { userId } });
        await tx.user.delete({ where: { id: userId } });

        return {
          assets: assets.count,
          versions: versions.count,
          payments: payments.count,
          conversations: conversations.count,
          usageLogs: usageLogs.count,
          withdrawals: withdrawals.count,
          voucherRedemptions: voucherRedemptions.count,
          projects: projects.count,
        };
      });

      console.log(`[Admin] FULL RESET for user ${userId} (tg=${user.telegramId}):`, result);
      res.json({ ok: true, deleted: result });
    } catch (err: any) {
      console.error("[Admin] Full reset error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/telegram-mini-app/api/admin/projects", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const projects = await prisma.project.findMany({
        include: { user: { select: { username: true, firstName: true } } },
        orderBy: { updatedAt: "desc" },
      });
      res.json(projects.map(p => ({
        id: p.id, name: p.name, status: p.status,
        owner: p.user.username || p.user.firstName || `User ${p.userId}`,
        userId: p.userId, botUsername: p.botUsername,
        totalCost: Number(p.totalCostUsd),
        description: p.description?.substring(0, 120),
        createdAt: p.createdAt, updatedAt: p.updatedAt,
      })));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get("/telegram-mini-app/api/admin/projects/:id", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const project = await prisma.project.findUnique({
        where: { id: req.params.id },
        include: { user: { select: { username: true, firstName: true, id: true } } },
      });
      if (!project) { res.status(404).json({ error: "Not found" }); return; }
      res.json({
        id: project.id, name: project.name, status: project.status,
        description: project.description, plan: project.plan,
        projectSummary: project.projectSummary, botUsername: project.botUsername,
        totalCost: Number(project.totalCostUsd),
        owner: project.user.username || project.user.firstName || `User ${project.user.id}`,
        userId: project.userId, createdAt: project.createdAt, updatedAt: project.updatedAt,
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post("/telegram-mini-app/api/admin/projects/:id/status", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      await prisma.project.update({ where: { id: req.params.id }, data: { status: req.body.status } });
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get("/telegram-mini-app/api/admin/config", (req, res) => {
    if (!adminGuard(req, res)) return;
    res.json(runtimeConfig.get());
  });

  app.post("/telegram-mini-app/api/admin/config", (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      runtimeConfig.update(req.body);
      res.json(runtimeConfig.get());
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get("/telegram-mini-app/api/admin/vouchers", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const vouchers = await prisma.voucher.findMany({
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { redemptions: true } } },
      });
      res.json(vouchers.map(v => ({
        id: v.id, code: v.code, amountUsd: Number(v.amountUsd),
        maxUses: v.maxUses, usedCount: v.usedCount, active: v.active,
        createdAt: v.createdAt,
        link: `https://t.me/apps_father_bot?start=${v.code}`,
      })));
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post("/telegram-mini-app/api/admin/vouchers", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const val = parseFloat(req.body.amount);
      const uses = parseInt(req.body.maxUses, 10);
      if (isNaN(val) || val <= 0) { res.status(400).json({ error: "Invalid amount" }); return; }
      if (isNaN(uses) || uses <= 0) { res.status(400).json({ error: "Invalid maxUses" }); return; }
      const code = "v_" + crypto.randomBytes(4).toString("hex");
      const voucher = await prisma.voucher.create({
        data: { code, amountUsd: new Decimal(val.toFixed(4)), maxUses: uses },
      });
      res.json({
        id: voucher.id, code: voucher.code, amountUsd: Number(voucher.amountUsd),
        maxUses: voucher.maxUses, usedCount: 0, active: true, createdAt: voucher.createdAt,
        link: `https://t.me/apps_father_bot?start=${voucher.code}`,
      });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.put("/telegram-mini-app/api/admin/vouchers/:id", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const id = parseInt(req.params.id, 10);
      const data: any = {};
      if (req.body.amount !== undefined) data.amountUsd = new Decimal(parseFloat(req.body.amount).toFixed(4));
      if (req.body.maxUses !== undefined) data.maxUses = parseInt(req.body.maxUses, 10);
      if (req.body.active !== undefined) data.active = Boolean(req.body.active);
      const voucher = await prisma.voucher.update({ where: { id }, data });
      res.json({ id: voucher.id, amountUsd: Number(voucher.amountUsd), maxUses: voucher.maxUses, active: voucher.active });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.delete("/telegram-mini-app/api/admin/vouchers/:id", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const id = parseInt(req.params.id, 10);
      await prisma.voucherRedemption.deleteMany({ where: { voucherId: id } });
      await prisma.voucher.delete({ where: { id } });
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  // Serve index.html with OpenPanel clientId injected as data attribute.
  // Match both `/telegram-mini-app` and `/telegram-mini-app/` because some
  // clients/cache-busters request the URL without a trailing slash.
  const serveMiniAppIndex = (_req: any, res: any) => {
    const indexPath = path.join(__dirname, "..", "..", "mini_app", "index.html");
    let html = fs.readFileSync(indexPath, "utf8");
    html = html.replace(
      '<html class="">',
      `<html class="" data-op-client-id="${config.openPanelClientId}">`
    );
    res.setHeader("Content-Type", "text/html");
    res.send(html);
  };
  app.get("/telegram-mini-app", serveMiniAppIndex);
  app.get("/telegram-mini-app/", serveMiniAppIndex);
  app.use("/telegram-mini-app", express.static(path.join(__dirname, "..", "..", "mini_app")));

  app.use("/app", appRoutes);
  app.use("/dev", devRoutes);
  app.use("/api", apiRoutes);
  app.use("/devapi", devApiRoutes);
  app.use("/webhook", webhookRoutes);
  app.use("/admin", adminRoutes);
  app.use("/editor", editorRoutes);
  app.use("/logs", logsRoutes);
  app.use("/billing", billingRoutes);

  expressApp = app;
  return app;
}

export function getExpressApp() {
  return expressApp;
}

export function getHttpServer() {
  return httpServer;
}

export async function startWebServer() {
  const app = createWebServer();

  const server = http.createServer(app);
  httpServer = server;

  const miniAppWss = setupMiniAppWebSocket();
  setupWebSocket(server, miniAppWss);

  return new Promise<void>((resolve) => {
    server.listen(config.port, () => {
      console.log(`[Web] Server running on port ${config.port}`);
      console.log(`[Web] Base URL: ${config.baseUrl}`);
      resolve();
    });
  });
}
