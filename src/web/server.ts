import http from "http";
import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import multer from "multer";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { config } from "../config";
import appRoutes from "./routes/app.routes";
import apiRoutes, { invalidateProjectDbCache } from "./routes/api.routes";
import devRoutes from "./routes/dev.routes";
import bucketRoutes, { listProjectFiles, uploadProjectFile, uploadProjectFileFromBuffer, deleteProjectFile } from "./routes/bucket.routes";
import devApiRoutes from "./routes/devapi.routes";
import { createRunnerProxyRouter, proxyWebSocketUpgrade } from "./routes/runner-proxy";
import { runnerManager } from "../services/runner-manager.service";
import webhookRoutes from "./routes/webhook.routes";
import adminRoutes from "./routes/admin.routes";
import logsRoutes from "./routes/logs.routes";
import billingRoutes from "./routes/billing.routes";
import appStoreRoutes from "./routes/app-store.routes";
import { appStoreService } from "../services/app-store.service";
import { tonToNano } from "../services/liquidity-amm.service";
import { applyLiquidityRemove } from "../services/liquidity-amm.service";
import { payoutTon } from "../services/jetton.service";
import { setupWebSocket, forceReloadProjectWs } from "./ws-manager";
import { setupMiniAppWebSocket } from "./miniapp-ws";
import { broadcastToProject, registerAnswerResolver, resolveAnswer } from "./miniapp-ws";
import { projectService } from "../services/project.service";
import { parseAgentLog } from "../services/agent-logger";
import { decryptToken, encryptToken } from "../services/crypto.service";
import { billingService } from "../services/billing.service";
import { avatarCache } from "../services/avatar-cache";
import { chatService, ChatMessage } from "../services/chat.service";
import { AgentProgress, AgentAbortedError } from "../services/agent.service";
import { agentSessionService } from "../services/agent-session.service";
import { processingProjects, abortedProjects } from "../bot/processing";
import { commitService } from "../services/commit.service";
import * as adminQueries from "../services/admin-queries.service";
import { publishReport } from "../services/telegraph.service";
import { claudeService } from "../services/claude.service";
import { parseStartParam, trackEvent } from "../services/analytics.service";
import { isMaintenanceMode, setMaintenanceMode } from "../services/maintenance.service";
import { prisma } from "../db";
import { runtimeConfig, LINK_BOT_FEE_CREDITS } from "../services/runtime-config.service";
import { Decimal } from "@prisma/client/runtime/library";
import { t, Lang } from "../bot/i18n";
import { notifyProcessDone } from "../services/notify.service";
import { sendBotWelcome } from "../services/welcome.service";
import { writeLedger } from "../services/ledger.service";
import { sendTon } from "../services/wallet.service";

// ── Security: scrub platform master secrets from process.env ─────────────────
// All imports above have already read what they need from process.env (config.ts
// captures every value into a frozen object at import time). We now permanently
// delete the sensitive keys so that any user-supplied routes.js loaded later via
// require() cannot read them — even indirectly via process.env or
// /proc/self/environ on Linux.
//
// Platform code must use the `config` import (captured before this scrub) and
// must NEVER re-read process.env for secrets after this point.
(function scrubPlatformSecrets() {
  const SENSITIVE = [
    "APPS_FATHER_TOKEN",
    "ENCRYPTION_KEY",
    // DATABASE_URL must stay in process.env — Prisma reads it at $connect() time.
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "ADMIN_PASSWORD",
    "WALLET_MNEMONIC",
    "NOWPAYMENTS_API_KEY",
    "NOWPAYMENTS_IPN_SECRET",
    "CRYPTO_BOT_TOKEN",
    "TONCENTER_API_KEY",
    "WEBHOOK_SECRET",
    "OPENPANEL_CLIENT_SECRET",
    "ELEVENLABS_API_KEY",
    "APIPASS_KEY",
    // AF_INTERNAL_SECRET is intentionally passed to user routes via envVars in
    // in-process mode — do not scrub here. Worker mode strips it at spawn time
    // (see runner-manager.service.ts → buildWorkerEnv) and again inside
    // worker-entry.js before routes.js is required.
    "RUNNER_SECRET",
    "RUNTIME_MODE",
  ];
  for (const key of SENSITIVE) {
    delete process.env[key];
  }
  console.log("[Security] Platform secrets scrubbed from process.env");
})();
// ─────────────────────────────────────────────────────────────────────────────

let expressApp: express.Application | null = null;
let httpServer: http.Server | null = null;

/**
 * Forward an AgentProgress to the mini-app over the project WebSocket.
 *
 * If `p.event` is set, we emit one of the structured events:
 *   `agent_step_start` | `agent_step_end`
 *   `agent_narration_start` | `agent_narration_chunk` | `agent_narration_end`
 *
 * Otherwise we emit the legacy `progress` event (and update the chat row),
 * keeping older mini-app builds working unchanged.
 *
 * Returns `true` if this was a structured event (caller should NOT also do the
 * legacy "update progress chat row" work for it).
 */
function forwardAgentProgress(
  projectId: string,
  progressMsgId: string,
  p: AgentProgress,
  checklist: { id: number; text: string; done: boolean }[],
): boolean {
  if (!p.event) return false;
  const base: any = {
    projectId,
    messageId: progressMsgId,
    stepId: p.stepId,
    costUsd: p.costUsd,
    balance: p.balance,
  };
  switch (p.event) {
    case "step_start":
      broadcastToProject(projectId, {
        ...base,
        type: "agent_step_start",
        kind: p.kind,
        title: p.title,
        toolName: p.toolName,
        target: p.target,
        checklist,
      });
      break;
    case "step_end":
      broadcastToProject(projectId, {
        ...base,
        type: "agent_step_end",
        status: p.status,
        meta: p.meta,
        checklist,
      });
      break;
    case "narration_start":
      broadcastToProject(projectId, { ...base, type: "agent_narration_start" });
      break;
    case "narration_chunk":
      broadcastToProject(projectId, {
        ...base,
        type: "agent_narration_chunk",
        delta: p.delta,
      });
      break;
    case "narration_end":
      broadcastToProject(projectId, { ...base, type: "agent_narration_end" });
      break;
    case "writing_chunk":
      broadcastToProject(projectId, {
        ...base,
        type: "agent_writing_chunk",
        toolName: p.toolName,
        delta: p.delta,
      });
      break;
  }
  return true;
}


export function createWebServer() {
  const app = express();

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  // /assets serves files from the repo-root /assets folder (logos, welcome
  // image, etc.). __dirname at runtime is dist/web, so we go ../.. to land
  // at the repo root. The previous "..", "assets" resolved to dist/assets
  // (which doesn't exist) and any URL fetch — including Telegram's
  // sendPhoto for the /start welcome card — silently 404'd.
  app.use("/assets", express.static(path.join(__dirname, "..", "..", "assets")));

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

  // Service mode middleware — when service mode is ON, block ALL mini-app API
  // requests from non-admin users. Admins (ADMIN_TELEGRAM_IDS) always pass through.
  // /init is exempted so the mini_app can still receive serviceMode:true and
  // display the maintenance page correctly.
  // Admin bypass is checked via validateAuth() which does full HMAC verification
  // against the platform bot token — no unverified header parsing.
  app.use("/telegram-mini-app/api", (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!runtimeConfig.isServiceMode()) return next();
    if (req.path === "/init") return next();
    const auth = validateAuth(req);
    if (auth.valid && auth.telegramId && config.adminTelegramIds.has(String(auth.telegramId))) return next();
    res.status(503).json({ error: "service_mode", message: "Apps Father is under maintenance. Please check back soon." });
  });

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

      res.json({
        ok: true,
        isNew,
        utmSource: user.utmSource,
        serviceMode: runtimeConfig.isServiceMode(),
        isAdmin: isAdminTelegramId(auth.telegramId),
      });
    } catch (err: any) {
      console.error("[MiniApp API] Init error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  });

  // Create a new project without a bot — the bot is linked later, after the
  // first build, via the managed_bot event. This replaces the old flow where
  // the user had to go through BotFather before describing their app.
  app.post("/telegram-mini-app/api/projects/create", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const canCreate = await projectService.canCreateApp(user.id);
      if (!canCreate) { res.status(403).json({ error: "slot_limit" }); return; }
      const project = await projectService.createProject(user.id, "New App");
      console.log(`[MiniApp] Created botless project ${project.id} for user ${user.id}`);
      res.json({ projectId: project.id });
    } catch (err) {
      console.error("[MiniApp] Create project error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── GET /telegram-mini-app/api/user/avatar — returns the caller's Telegram profile photo URL ──
  app.get("/telegram-mini-app/api/user/avatar", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const telegramId = String(auth.telegramId);
      const cacheKey = `avatar:${telegramId}`;

      // Return cached URL if available
      if (avatarCache.has(cacheKey)) {
        res.json({ url: avatarCache.get(cacheKey) });
        return;
      }

      const token = config.botToken;
      if (!token) { res.json({ url: null }); return; }

      // Fetch profile photo from Telegram Bot API
      const pr = await fetch(
        `https://api.telegram.org/bot${token}/getUserProfilePhotos?user_id=${telegramId}&limit=1`
      );
      const pd: any = await pr.json();
      if (!pd.ok || !pd.result?.photos?.length) { res.json({ url: null }); return; }
      const photo = pd.result.photos[0];
      const biggest = photo[photo.length - 1];
      const fr = await fetch(
        `https://api.telegram.org/bot${token}/getFile?file_id=${biggest.file_id}`
      );
      const fd: any = await fr.json();
      if (!fd.ok) { res.json({ url: null }); return; }
      const url = `https://api.telegram.org/file/bot${token}/${fd.result.file_path}`;
      avatarCache.set(cacheKey, url);
      res.json({ url });
    } catch (err: any) {
      res.json({ url: null });
    }
  });

  app.get("/telegram-mini-app/api/projects", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }

      const { user } = await getOrCreateUserFromReq(req, auth);
      const projects = await projectService.getProjectsByUser(user.id);

      // Pre-load app-store logos in one query so we can override the bot avatar
      const projectIds = projects.map((p: any) => p.id);
      const listings = projectIds.length
        ? await prisma.appListing.findMany({
            where: { projectId: { in: projectIds } },
            select: { projectId: true, appLogoFilename: true },
          })
        : [];
      const appLogoByProject: Record<string, string | null> = {};
      for (const l of listings as any[]) {
        appLogoByProject[l.projectId] = l.appLogoFilename || null;
      }

      const result = await Promise.all(projects.map(async (p: any) => {
        let avatarUrl: string | null = null;
        // Highest priority: App Store-specific logo set via the App Information page
        const appLogo = appLogoByProject[p.id];
        if (appLogo) {
          avatarUrl = `/bucket/${p.id}/${appLogo}`;
        }
        if (!avatarUrl) avatarUrl = avatarCache.get(p.id) ?? null;
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
          features: p.features || "[]",
          releaseCommit: p.releaseCommit || null,
          lastTaskId: (p as any).lastTaskId || null,
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

  // Performance-tier endpoint removed — tiers are replaced by Agent Session Configuration.

  // ── Project .env variables editor ──
  const _PROJECTS_DIR_ENV = path.join(process.cwd(), "projects");

  app.get("/telegram-mini-app/api/project-env/:projectId", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const { projectId } = req.params;
      const project = await projectService.getProject(projectId);
      const ADMIN_TG_IDS = [8784357184, 8796958409];
      if (!project || (project.userId !== user.id && !ADMIN_TG_IDS.includes(auth.telegramId || 0))) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
      const env = (req.query.env as string) === "release" ? "release" : "dev";
      const envDir = env === "release" ? "release" : "development";
      const envPath = path.join(_PROJECTS_DIR_ENV, projectId, envDir, "backend", ".env");
      if (!fs.existsSync(envPath)) {
        res.json({ vars: {} }); return;
      }
      const dotenv = await import("dotenv");
      const vars = dotenv.parse(fs.readFileSync(envPath));
      res.json({ vars });
    } catch (err) {
      console.error("[MiniApp API] project-env GET error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/project-env/:projectId", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const { projectId } = req.params;
      const project = await projectService.getProject(projectId);
      const ADMIN_TG_IDS_W = [8784357184, 8796958409];
      if (!project || (project.userId !== user.id && !ADMIN_TG_IDS_W.includes(auth.telegramId || 0))) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
      const { vars, env } = req.body as { vars: Record<string, string>; env: string };
      if (!vars || typeof vars !== "object") {
        res.status(400).json({ error: "vars required" }); return;
      }
      const envDir = env === "release" ? "release" : "development";
      const backendDir = path.join(_PROJECTS_DIR_ENV, projectId, envDir, "backend");
      fs.mkdirSync(backendDir, { recursive: true });
      const envContent = Object.entries(vars)
        .filter(([k]) => k && /^[A-Z_][A-Z0-9_]*$/i.test(k))
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
      fs.writeFileSync(path.join(backendDir, ".env"), envContent, "utf-8");
      try { invalidateProjectDbCache(projectId); } catch {}
      res.json({ ok: true });
    } catch (err) {
      console.error("[MiniApp API] project-env POST error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Bucket management (owner only) ──────────────────────────────────────
  const bucketUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

  // GET  /telegram-mini-app/api/bucket/:projectId  → list files
  app.get("/telegram-mini-app/api/bucket/:projectId", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const project = await projectService.getProject(req.params.projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
      const files = listProjectFiles(req.params.projectId);
      res.json({ files });
    } catch (err: any) {
      console.error("[Bucket API] List error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /telegram-mini-app/api/bucket/:projectId/upload  → owner upload (multipart/form-data)
  app.post("/telegram-mini-app/api/bucket/:projectId/upload", bucketUpload.single("file"), async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
      if (!req.file) {
        res.status(400).json({ error: "No file uploaded. Send multipart/form-data with field 'file'" }); return;
      }
      const result = uploadProjectFileFromBuffer(projectId, req.file.buffer, req.file.mimetype);
      res.json(result);
    } catch (err: any) {
      console.error("[Bucket API] Upload error:", err);
      res.status(500).json({ error: err.message || "Upload failed" });
    }
  });

  // DELETE /telegram-mini-app/api/bucket/:projectId/:filename  → owner delete
  app.delete("/telegram-mini-app/api/bucket/:projectId/:filename", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const project = await projectService.getProject(req.params.projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
      const deleted = deleteProjectFile(req.params.projectId, req.params.filename);
      if (!deleted) { res.status(404).json({ error: "File not found" }); return; }
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[Bucket API] Delete error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Server Control (worker lifecycle + metrics) ──────────────────────────

  /** Recursively sum directory size in bytes. Returns 0 if dir does not exist. */
  function dirSizeBytes(dir: string): number {
    try {
      if (!fs.existsSync(dir)) return 0;
      let total = 0;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) total += dirSizeBytes(full);
        else { try { total += fs.statSync(full).size; } catch {} }
      }
      return total;
    } catch { return 0; }
  }

  // GET /telegram-mini-app/api/server-control/:projectId
  app.get("/telegram-mini-app/api/server-control/:projectId", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const { projectId } = req.params;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) {
        res.status(403).json({ error: "Forbidden" }); return;
      }

      const metrics = config.isWorkerRuntime ? runnerManager.getMetrics(projectId) : null;

      // App size: sum of the project directory under /srv (worker / docker mode)
      // or projects/<id> (in-process legacy).
      const { runnerProvisionService } = await import("../services/runner-provision.service");
      const workerRoot = config.isWorkerRuntime
        ? runnerProvisionService.projectRoot(projectId)
        : path.join(process.cwd(), "projects", projectId);
      const appSizeBytes = dirSizeBytes(workerRoot);

      // Bucket size
      const bucketDir = path.join(process.cwd(), "bucket", projectId);
      const bucketSizeBytes = dirSizeBytes(bucketDir);

      res.json({
        workerMode: config.isWorkerRuntime,
        state: metrics?.state ?? "not_tracked",
        uptimeMs: metrics?.uptimeMs ?? null,
        memRssBytes: metrics?.memRssBytes ?? null,
        cpuPercent: metrics?.cpuPercent ?? null,
        crashCount: metrics?.crashCount ?? 0,
        restartCount: metrics?.restartCount ?? 0,
        release: metrics?.release ?? null,
        development: metrics?.development ?? null,
        lastError: metrics?.lastError ?? null,
        appSizeBytes,
        bucketSizeBytes,
        maintenanceMode: isMaintenanceMode(projectId),
      });
    } catch (err: any) {
      console.error("[ServerControl] GET error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // GET /telegram-mini-app/api/server-control/:projectId/logs
  app.get("/telegram-mini-app/api/server-control/:projectId/logs", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const { projectId } = req.params;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
      if (!config.isWorkerRuntime) {
        res.json({ logs: [] }); return;
      }
      const n = req.query.n ? Math.min(500, Math.max(1, parseInt(String(req.query.n), 10))) : 200;
      const logs = runnerManager.getLogs(projectId, n);
      res.json({ logs });
    } catch (err: any) {
      console.error("[ServerControl] logs error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // POST /telegram-mini-app/api/server-control/:projectId/start
  app.post("/telegram-mini-app/api/server-control/:projectId/start", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const { projectId } = req.params;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
      if (!config.isWorkerRuntime) {
        res.status(409).json({ error: "not_in_worker_mode" }); return;
      }
      const handle = await runnerManager.ensureRunning(projectId);
      res.json({ ok: true, port: handle.port, pid: handle.pid });
    } catch (err: any) {
      console.error("[ServerControl] start error:", err);
      res.status(500).json({ error: err.message || "Start failed" });
    }
  });

  // POST /telegram-mini-app/api/server-control/:projectId/stop
  app.post("/telegram-mini-app/api/server-control/:projectId/stop", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const { projectId } = req.params;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
      if (!config.isWorkerRuntime) {
        res.status(409).json({ error: "not_in_worker_mode" }); return;
      }
      await runnerManager.stop(projectId);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[ServerControl] stop error:", err);
      res.status(500).json({ error: err.message || "Stop failed" });
    }
  });

  // POST /telegram-mini-app/api/server-control/:projectId/restart
  app.post("/telegram-mini-app/api/server-control/:projectId/restart", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const { projectId } = req.params;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
      if (!config.isWorkerRuntime) {
        res.status(409).json({ error: "not_in_worker_mode" }); return;
      }
      const handle = await runnerManager.restart(projectId);
      res.json({ ok: true, port: handle.port, pid: handle.pid });
    } catch (err: any) {
      console.error("[ServerControl] restart error:", err);
      res.status(500).json({ error: err.message || "Restart failed" });
    }
  });

  // POST /telegram-mini-app/api/server-control/:projectId/maintenance
  app.post("/telegram-mini-app/api/server-control/:projectId/maintenance", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const { projectId } = req.params;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
      const { enabled } = req.body as { enabled: boolean };
      if (typeof enabled !== "boolean") {
        res.status(400).json({ error: "enabled (boolean) required" }); return;
      }
      setMaintenanceMode(projectId, enabled);
      res.json({ ok: true, maintenanceMode: enabled });
    } catch (err: any) {
      console.error("[ServerControl] maintenance error:", err);
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

  app.get("/telegram-mini-app/api/bundles", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);

      const confirmedCount = await prisma.payment.count({
        where: { userId: user.id, status: "confirmed" },
      });
      const isFirstPurchase = confirmedCount === 0;

      const bundles = await prisma.bundle.findMany({
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
      });

      const result = bundles.map((b) => ({
        id: b.id,
        name: b.name,
        credits: b.credits,
        bonusCredits: b.bonusCredits,
        priceUsd: Number(b.priceUsd),
        discount: b.discount,
        isLimited: b.isLimited,
        limitTotal: b.limitTotal,
        purchaseCount: b.purchaseCount,
        isSoldOut: b.isLimited && b.limitTotal !== null && b.purchaseCount >= b.limitTotal,
        sortOrder: b.sortOrder,
        isFirstPurchase,
      }));

      res.json({ bundles: result, isFirstPurchase });
    } catch (err: any) {
      console.error("[MiniApp API] Bundles error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/topup", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const { bundleId, amount, method } = req.body;

      let amountUsd: number;

      if (bundleId) {
        // Bundle-based topup
        const bundle = await prisma.bundle.findUnique({ where: { id: bundleId } });
        if (!bundle || !bundle.isActive) {
          res.status(400).json({ error: "Bundle not found or inactive" });
          return;
        }
        if (bundle.isLimited && bundle.limitTotal !== null && bundle.purchaseCount >= bundle.limitTotal) {
          res.status(400).json({ error: "This bundle is sold out" });
          return;
        }
        amountUsd = Number(bundle.priceUsd);
      } else {
        // Legacy free-form topup
        amountUsd = parseFloat(amount);
        if (isNaN(amountUsd) || amountUsd < 2) {
          res.status(400).json({ error: "Minimum top-up is $2" });
          return;
        }
      }

      let invoiceUrl: string;
      let paymentId: number | undefined;
      if (method === "cryptobot") {
        const result = await billingService.createCryptoBotInvoice(user.id, amountUsd, bundleId);
        invoiceUrl = result.invoiceUrl;
        paymentId = result.paymentId;
      } else if (method === "stars") {
        const STAR_RATE = 0.013;
        const rawStars = Math.ceil(amountUsd / STAR_RATE);
        const stars = Math.floor(rawStars / 10) * 10;
        const result = await billingService.createStarsInvoice(user.id, amountUsd, stars, bundleId);
        invoiceUrl = result.invoiceUrl;
        paymentId = result.paymentId;
      } else if (method === "ton") {
        const result = await billingService.createTonPayment(user.id, amountUsd, bundleId);
        res.json({ ok: true, ton: true, paymentId: result.paymentId, walletAddress: result.walletAddress, amountNano: result.amountNano });
        return;
      } else {
        // "Other Crypto" (NowPayments) — provider charges high fees on small
        // invoices, so require at least $15 to keep the deposit worthwhile.
        if (amountUsd < 15) {
          res.status(400).json({ error: "Other Crypto requires a minimum of $15. Please use TON, Stars or Crypto Bot for smaller amounts." });
          return;
        }
        const result = await billingService.createTopUp(user.id, amountUsd, bundleId);
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
      await billingService.reconcilePendingTonPaymentsForUser(user.id);
      const [credits, paymentCount, fullUser] = await Promise.all([
        billingService.getUserCredits(user.id),
        prisma.payment.count({ where: { userId: user.id, status: "confirmed" } }),
        prisma.user.findUnique({ where: { id: user.id }, select: { firstDepositBonusGiven: true } }),
      ]);
      const firstDepositBonusEligible = paymentCount === 0 && !fullUser?.firstDepositBonusGiven;
      const firstDepositBonusPercent = Number(runtimeConfig.get().firstTopupBonusPercent) || 0;
      const creditsPerDollar = runtimeConfig.getCreditsPerDollar();
      const slotPriceCredits = runtimeConfig.get().slotPriceCredits || 30;
      const cashbackPercent = Math.max(0, Math.min(100, runtimeConfig.get().cashbackPercent ?? 50));
      const cashbackEnabled = runtimeConfig.get().cashbackEnabled !== false;
      res.json({
        balance: credits,
        credits,
        paymentCount,
        firstDepositBonusEligible,
        firstDepositBonusPercent,
        creditsPerDollar,
        slotPriceCredits,
        cashbackPercent,
        cashbackEnabled,
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
      if (claim.count > 0) {
        writeLedger(user.id, "USD", SUB_BONUS_USD, "sub_bonus");
      }

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

        const userForBuild = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
        const userCredits = userForBuild?.credits ?? 0;
        const updateCost = runtimeConfig.getSessionCost("update");
        if (userCredits < updateCost) {
          const errMsg = chatService.addMessage(projectId, { role: "system", type: "balance_error", content: t(lang, "insufficient_balance_amount", { balance: `${userCredits} cr`, min: `${updateCost} cr` }), metadata: { balance: userCredits, minCost: updateCost } });
          broadcastToProject(projectId, { type: "message", message: errMsg });
          res.json({ messageId: userMsg.id, status: "error", error: "insufficient_balance" });
          return;
        }

        // Pre-charge credits immediately so balance updates before agent finishes
        const preCharge = await billingService.preChargeAction(user.id, projectId, "update").catch(() => ({ creditsCharged: 0, newCredits: userCredits }));
        if (preCharge.creditsCharged > 0) {
          broadcastToProject(projectId, { type: "balance_update", newCredits: preCharge.newCredits });
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
            metadata: {
              creditsPreCharged: preCharge.creditsCharged,
              taskKind: "update",
              originalText: text,
            },
          });
          progressMsgId = progressMsg.id;
          broadcastToProject(projectId, { type: "message", message: progressMsg });

          // Announce the new task session ID so the mini app can show it immediately
          const runningProject = await projectService.getProject(projectId);
          const pendingTaskId = (runningProject as any)?.lastTaskId;
          if (pendingTaskId) {
            broadcastToProject(projectId, { type: "task_started", taskId: pendingTaskId });
          }

          try {
            await projectService.updateProjectStatus(projectId, "building");

            let progressDone = false;
            const onProgress = async (p: AgentProgress) => {
              if (!progressMsgId || progressDone) return;
              if (forwardAgentProgress(projectId, progressMsgId, p, items)) return;
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

            const attachments = userMsg.attachments?.map((a: any) => ({
              localPath: a.path,
              projectPath: `frontend/assets/${a.name}`,
              originalName: a.name,
            }));

            const result = await agentSessionService.session_update(
              projectId, text.trim(), onProgress, attachments,
              onAskUser, lang, userCredits, preCharge.creditsCharged,
            );

            const project = await projectService.getProject(projectId);
            const completedTaskId = (project as any)?.lastTaskId || undefined;
            const usage = await billingService.recordUsage(
              user.id, projectId, result.model,
              { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: result.cacheWriteTokens, cache_read_input_tokens: result.cacheReadTokens },
              "update", undefined, preCharge.creditsCharged, completedTaskId,
            );

            await projectService.updateProjectStatus(projectId, "deployed");

            try {
              await commitService.createCommit(projectId, `Update: ${text.trim().substring(0, 80)}`, result.commitNum!, result.commitDir!, result.logPath);
            } catch {}

            const history = chatService.getHistory(projectId, undefined, 1000);
            const updateNum = history.filter(m => m.type === "result").length + 1;
            const appName = project?.name || "App";

            // Publish telegraph (fast) before showing result
            const changelogUrl = await publishReport(`${appName} — Update #${updateNum}`, result.summary).catch(() => null);

            // Show result immediately with short summary + changelog
            const cashbackEnabled = runtimeConfig.get().cashbackEnabled !== false;
            const cashbackAvail = cashbackEnabled && (usage.creditsCharged ?? 0) > 0;
            if (progressMsgId) {
              chatService.updateMessage(projectId, progressMsgId, {
                type: "result",
                content: result.shortSummary,
                percent: 100,
                costUsd: usage.costUsd,
                balance: usage.newBalance,
                creditsCharged: usage.creditsCharged,
                commitNum: result.commitNum,
                cashbackAvailable: cashbackAvail,
                cashbackClaimed: false,
                checklist: items,
                metadata: { changelogUrl, stepCount: result.stepCount, durationMs: result.durationMs },
              });
            }

            broadcastToProject(projectId, {
              type: "status", projectId, status: "done",
              messageId: progressMsgId,
              summary: result.shortSummary,
              changelogUrl,
              costUsd: usage.costUsd,
              balance: usage.newBalance,
              creditsCharged: usage.creditsCharged,
              commitNum: result.commitNum,
              cashbackAvailable: cashbackAvail,
              stepCount: result.stepCount,
              durationMs: result.durationMs,
            });

            notifyProcessDone(auth.telegramId!, appName, result.shortSummary, "update", lang);

            // Skip passport if the user aborted just as the agent finished
            if (abortedProjects.has(projectId)) {
              abortedProjects.delete(projectId);
              processingProjects.delete(projectId);
              return;
            }

            // Run passport in background — keep processingProjects lock
            broadcastToProject(projectId, { type: "message", message: { role: "system", content: "preparing_next_update", metadata: { preparing: true } } });
            (async () => {
              try {
                await agentSessionService.compactContext(projectId, result.commitDir!, result.summary, result.commitNum!, project?.description || undefined, project?.plan || undefined, result.contextDiff || undefined);
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
              const abortedProj = await projectService.getProject(projectId).catch(() => null);
              const abortedTaskId = (abortedProj as any)?.lastTaskId || undefined;
              await billingService.recordUsage(
                user.id, projectId, err.model,
                { input_tokens: err.inputTokens, output_tokens: err.outputTokens, cache_creation_input_tokens: err.cacheWriteTokens, cache_read_input_tokens: err.cacheReadTokens },
                "update", undefined, false, abortedTaskId,
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

            // Auto-refund the pre-charged credits since the agent never produced
            // anything billable. Surface the refund + a Try-again retry handle
            // so the client can re-send the same prompt.
            let refundedCredits = 0;
            if (preCharge.creditsCharged > 0) {
              try {
                const r = await billingService.refundAction(user.id, projectId, "update", preCharge.creditsCharged);
                refundedCredits = preCharge.creditsCharged;
                broadcastToProject(projectId, { type: "balance_update", newCredits: r.newCredits });
              } catch (refundErr) {
                console.error("[Chat API] Update refund failed:", refundErr);
              }
            }

            const errMsg = chatService.addMessage(projectId, {
              role: "assistant",
              type: "error",
              content: friendlyContent,
              metadata: refundedCredits > 0 ? {
                refunded: true,
                creditsRefunded: refundedCredits,
                retry: { kind: "update", text },
              } : undefined,
            });
            broadcastToProject(projectId, { type: "message", message: errMsg });
            broadcastToProject(projectId, { type: "status", projectId, status: "error", messageId: errMsg.id });
            processingProjects.delete(projectId);
          }
        })();

        return;
      }

      if (msgType === "question") {
        // Answer sessions are free (0 credits)

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

            const answer = await agentSessionService.session_answer(
              projectId, text.trim(),
              (_chunk, fullText) => {
                broadcastToProject(projectId, { type: "stream_chunk", projectId, messageId: streamMsgId, text: fullText });
              },
              lastUpdate, proj?.description || undefined, askHistory, lang,
            );

            const usage = await billingService.recordUsage(
              user.id, projectId, runtimeConfig.getSessionConfig("answer").model,
              { input_tokens: answer.inputTokens, output_tokens: answer.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
              "answer",
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

      const { message, stack, url, type: reportType } = req.body || {};
      if (!message) { res.status(400).json({ error: "No message" }); return; }

      const project = await projectService.getProject(projectId);
      if (!project) { res.status(404).json({ error: "Project not found" }); return; }

      // Extract devtools tag prefix [Tag Name] from the raw message before any wrapping
      const rawMsg = String(message);
      const tagMatch = rawMsg.match(/^\[([^\]]+)\]/);
      const devtoolsTag = tagMatch ? tagMatch[1] : null;

      let errorText: string;
      if (reportType === "design") {
        // Design changes from visual editor — send as plain update request (tag already at start)
        errorText = rawMsg;
      } else {
        // Keep enough frames for the agent to actually trace the error. 8 lines
        // typically cuts off mid-trace before reaching app code; 40 covers all
        // realistic stacks while still bounding payload size.
        const shortStack = (stack || "").toString().split("\n").slice(0, 40).join("\n");
        const body = `${rawMsg}${shortStack ? "\n" + shortStack : ""}`;
        if (devtoolsTag) {
          // Tag already at start; wrap the content after the tag line so tag stays first
          const afterTag = rawMsg.replace(/^\[[^\]]+\]\s*\n?/, "");
          const bodyAfterTag = `${afterTag}${shortStack ? "\n" + shortStack : ""}`;
          errorText = `[${devtoolsTag}]\n\`\`\`\n${bodyAfterTag}\n\`\`\`\nPlease investigate and fix this issue.`;
        } else {
          errorText = `🐛 Error detected in the app:\n\`\`\`\n${body}\n\`\`\`\nPlease fix this error.`;
        }
      }

      const msgType = devtoolsTag ? "devtools_request" : "update_request";

      // Add as user message so agent treats it as an update request
      const userMsg = chatService.addMessage(projectId, {
        role: "user",
        type: msgType,
        content: errorText,
        ...(devtoolsTag ? { metadata: { tag: devtoolsTag } } : {}),
      });
      broadcastToProject(projectId, { type: "message", message: userMsg });

      res.json({ status: "ok" });

      // Trigger agent to fix it (runs in background)
      if (processingProjects.has(projectId)) return;

      const owner = await prisma.user.findUnique({ where: { id: project.userId } });
      if (!owner) return;
      const ownerLang = (owner.language as Lang) || "en";

      const ownerData = await prisma.user.findUnique({ where: { id: owner.id }, select: { credits: true } });
      const ownerCredits = ownerData?.credits ?? 0;
      // Auto-bug-fix uses a non-router path (triggered from injected error
      // monitor) so there's no proposal card. We default to "medium"
      // complexity for the price quote — admins can re-tune that column.
      const autoFixCost = runtimeConfig.getSessionCost("bug-fix");
      if (ownerCredits < autoFixCost) {
        const errMsg = chatService.addMessage(projectId, {
          role: "system", type: "balance_error",
          content: t(ownerLang, "autofix_insufficient_balance", { balance: `${ownerCredits} cr` }),
          metadata: { balance: ownerCredits },
        });
        broadcastToProject(projectId, { type: "message", message: errMsg });
        return;
      }

      const fixPreCharge = await billingService
        .preChargeAction(owner.id, projectId, "bug-fix")
        .catch(() => ({ creditsCharged: 0, newCredits: ownerCredits }));
      if (fixPreCharge.creditsCharged > 0) {
        broadcastToProject(projectId, { type: "balance_update", newCredits: fixPreCharge.newCredits });
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

          let progressDone = false;
          const onProgress = async (p: AgentProgress) => {
            if (!progressMsgId || progressDone) return;
            if (forwardAgentProgress(projectId, progressMsgId, p, items)) return;
            if ((p.percent ?? 0) >= 100) { progressDone = true; return; }
            chatService.updateMessage(projectId, progressMsgId, { content: `${p.action} ${p.detail}`, percent: p.percent, costUsd: p.costUsd, balance: p.balance });
            broadcastToProject(projectId, { type: "progress", projectId, messageId: progressMsgId, percent: p.percent, message: `${p.action} ${p.detail}`, checklist: items, costUsd: p.costUsd, balance: p.balance });
          };

          const result = await agentSessionService.session_update(
            projectId, errorText, onProgress, [], undefined, ownerLang, ownerCredits,
            fixPreCharge.creditsCharged,
          );

          const fixedProject = await projectService.getProject(projectId).catch(() => null);
          const fixTaskId = (fixedProject as any)?.lastTaskId || undefined;
          const usage = await billingService.recordUsage(
            owner.id, projectId, result.model,
            { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: result.cacheWriteTokens, cache_read_input_tokens: result.cacheReadTokens },
            "bug-fix", undefined, fixPreCharge.creditsCharged, fixTaskId,
          );

          await projectService.updateProjectStatus(projectId, "deployed");
          try { await commitService.createCommit(projectId, `Fix: ${(message || "").toString().slice(0, 60)}`, result.commitNum!, result.commitDir!, result.logPath); } catch {}

          const history = chatService.getHistory(projectId, undefined, 1000);
          const updateNum = history.filter(m => m.type === "result").length + 1;
          const appName = project?.name || "App";
          const changelogUrl = await publishReport(`${appName} — Fix #${updateNum}`, result.summary).catch(() => null);

          const cashbackEnabledFix = runtimeConfig.get().cashbackEnabled !== false;
          const cashbackAvailFix = cashbackEnabledFix && (usage.creditsCharged ?? 0) > 0;
          if (progressMsgId) {
            chatService.updateMessage(projectId, progressMsgId, { type: "result", content: result.shortSummary, percent: 100, costUsd: usage.costUsd, balance: usage.newBalance, creditsCharged: usage.creditsCharged, commitNum: result.commitNum, cashbackAvailable: cashbackAvailFix, cashbackClaimed: false, checklist: items, metadata: { changelogUrl, stepCount: result.stepCount, durationMs: result.durationMs } });
          }
          broadcastToProject(projectId, { type: "status", projectId, status: "done", messageId: progressMsgId, summary: result.shortSummary, changelogUrl, costUsd: usage.costUsd, balance: usage.newBalance, creditsCharged: usage.creditsCharged, commitNum: result.commitNum, cashbackAvailable: cashbackAvailFix, stepCount: result.stepCount, durationMs: result.durationMs });

          notifyProcessDone(Number(owner.telegramId), appName, result.shortSummary, "fix", ownerLang);

          broadcastToProject(projectId, { type: "message", message: { role: "system", content: "preparing_next_update", metadata: { preparing: true } } });
          (async () => {
            try { await agentSessionService.compactContext(projectId, result.commitDir!, result.summary, result.commitNum!, project?.description || undefined, project?.plan || undefined, result.contextDiff || undefined); } catch {}
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
              "bug-fix",
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

      // Suggestions are free (0 credits)
      const suggestions = await agentSessionService.session_suggestions(req.params.projectId, suggestLang);

      await billingService.recordUsage(
        user.id, req.params.projectId, runtimeConfig.getSessionConfig("suggestions").model,
        { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        "suggestions",
      ).catch(() => {});

      res.json({ suggestions });
    } catch (err) {
      console.error("[Chat API] Suggestions error:", err);
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

      // Plan generation is part of the build flow — free at this step (charged at approve-plan/build)

      await projectService.updateProjectDescription(projectId, description.trim());

      // Persist the user prompt up-front so the streaming UI sees it even if
      // the connection drops before the plan arrives.
      chatService.addMessage(projectId, { role: "user", type: "text", content: description.trim() });

      const streamMsgId = crypto.randomBytes(8).toString("hex");
      res.json({ status: "streaming", streamMsgId });

      // Run the plan generation in the background and broadcast streamed
      // chunks to the mini-app. The final `plan_stream_end` carries the
      // persisted assistant message so the client can render Build/Edit
      // buttons exactly the same way as a replayed plan from history.
      (async () => {
        broadcastToProject(projectId, { type: "plan_stream_start", projectId, messageId: streamMsgId });
        try {
          const assets = await projectService.getProjectAssets(projectId);
          const assetPaths = assets.map((a: any) => a.filePath).filter(Boolean) as string[];
          const result = await claudeService.generatePlan(
            description.trim(), assetPaths, planLang,
            (_delta, full) => {
              broadcastToProject(projectId, { type: "plan_stream_chunk", projectId, messageId: streamMsgId, text: full });
            },
          );
          await projectService.updateProjectPlan(projectId, result.plan);

          const usage = await billingService.recordUsage(
            user.id, projectId, runtimeConfig.getSessionConfig("build").model,
            { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            "plan",
          );

          const planMsg = chatService.addMessage(projectId, {
            role: "assistant", type: "plan", content: result.plan,
            metadata: { costUsd: usage.costUsd, balance: usage.newBalance, buildCost: runtimeConfig.getSessionCost("build") },
          });

          void trackEvent(auth.telegramId!, "plan_created", {
            project_id: projectId,
            cost_usd: usage.costUsd,
          });

          broadcastToProject(projectId, {
            type: "plan_stream_end", projectId, messageId: streamMsgId,
            message: planMsg, costUsd: usage.costUsd, balance: usage.newBalance,
          });
        } catch (err: any) {
          console.error("[Chat API] Plan generation error:", err);
          const errMsg = chatService.addMessage(projectId, {
            role: "assistant", type: "error",
            content: `Failed to generate plan: ${err?.message || "Unknown error"}`,
          });
          broadcastToProject(projectId, {
            type: "plan_stream_end", projectId, messageId: streamMsgId,
            message: errMsg, error: err?.message || "Failed to generate plan",
          });
        }
      })();
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

      const buildUserData = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
      const buildCredits = buildUserData?.credits ?? 0;
      const buildCost = runtimeConfig.getSessionCost("build");
      if (buildCredits < buildCost) {
        res.status(402).json({ error: t(buildLang, "insufficient_balance_amount", { balance: `${buildCredits} cr`, min: `${buildCost} cr` }) });
        return;
      }

      // Pre-charge credits immediately
      const buildPreCharge = await billingService.preChargeAction(user.id, projectId, "build").catch(() => ({ creditsCharged: 0, newCredits: buildCredits }));
      if (buildPreCharge.creditsCharged > 0) {
        broadcastToProject(projectId, { type: "balance_update", newCredits: buildPreCharge.newCredits });
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
          metadata: {
            // Refund-on-error metadata: lets /abort recovery refund stale
            // pre-charges after a server restart, and the catch block below
            // know how much to refund / what to retry.
            creditsPreCharged: buildPreCharge.creditsCharged,
            taskKind: "build",
          },
        });
        progressMsgId = progressMsg.id;
        broadcastToProject(projectId, { type: "message", message: progressMsg });

        try {
          await projectService.updateProjectStatus(projectId, "building");

          let progressDone = false;
          const onProgress = async (p: AgentProgress) => {
            if (!progressMsgId || progressDone) return;
            if (forwardAgentProgress(projectId, progressMsgId, p, items)) return;
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

          const result = await agentSessionService.session_build(
            projectId,
            { description: project.description || "", brief: (project as any).plan || "" },
            onProgress, onAskUser, buildLang, buildCredits, undefined,
            buildPreCharge.creditsCharged,
          );

          const usage = await billingService.recordUsage(
            user.id, projectId, result.model,
            { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: result.cacheWriteTokens, cache_read_input_tokens: result.cacheReadTokens },
              "build", undefined, buildPreCharge.creditsCharged,
          );

          await projectService.updateProjectStatus(projectId, "deployed");

          try {
            await commitService.createCommit(projectId, `App created: ${(project.description || "").substring(0, 80)}`, result.commitNum!, result.commitDir!, result.logPath);
            await commitService.releaseCurrentDev(projectId);
            try { forceReloadProjectWs(projectId, false); } catch {}
            try { invalidateProjectDbCache(projectId); } catch {}
          } catch {}

          const appName = project.name || "App";
          const changelogUrl = await publishReport(`${appName} — Created`, result.summary).catch(() => null);

          const cashbackEnabledCreate = runtimeConfig.get().cashbackEnabled !== false;
          const cashbackAvailCreate = cashbackEnabledCreate && (usage.creditsCharged ?? 0) > 0;
          if (progressMsgId) {
            chatService.updateMessage(projectId, progressMsgId, {
              type: "result", content: result.shortSummary,
              percent: 100, costUsd: usage.costUsd, balance: usage.newBalance,
              creditsCharged: usage.creditsCharged,
              commitNum: result.commitNum,
              cashbackAvailable: cashbackAvailCreate,
              cashbackClaimed: false,
              metadata: { changelogUrl, stepCount: result.stepCount, durationMs: result.durationMs },
            });
            broadcastToProject(projectId, {
              type: "status", projectId, messageId: progressMsgId,
              status: "done", summary: result.shortSummary,
              changelogUrl,
              costUsd: usage.costUsd, balance: usage.newBalance,
              creditsCharged: usage.creditsCharged,
              commitNum: result.commitNum,
              cashbackAvailable: cashbackAvailCreate,
              stepCount: result.stepCount,
              durationMs: result.durationMs,
            });
          }

          broadcastToProject(projectId, { type: "status_change", projectId, status: "deployed" });

          notifyProcessDone(auth.telegramId!, appName, result.shortSummary, "build", buildLang);

          // Skip passport if the user aborted just as the agent finished
          if (abortedProjects.has(projectId)) {
            abortedProjects.delete(projectId);
            processingProjects.delete(projectId);
            return;
          }

          // Run passport in background
          broadcastToProject(projectId, { type: "message", message: { role: "system", content: "preparing_next_update", metadata: { preparing: true } } });
          (async () => {
            try {
              await agentSessionService.compactContext(projectId, result.commitDir!, result.summary, result.commitNum!, project.description || undefined, project.plan || undefined, result.contextDiff || undefined);
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

          // Refund pre-charged credits since the build never produced output.
          // Try-again on the client re-fires POST /approve-plan which will
          // pre-charge again from a fresh balance.
          let refundedCredits = 0;
          if (buildPreCharge.creditsCharged > 0) {
            try {
              const r = await billingService.refundAction(user.id, projectId, "build", buildPreCharge.creditsCharged);
              refundedCredits = buildPreCharge.creditsCharged;
              broadcastToProject(projectId, { type: "balance_update", newCredits: r.newCredits });
            } catch (refundErr) {
              console.error("[Chat API] Build refund failed:", refundErr);
            }
          }

          // Drop any in-flight progress bubble before posting the error so
          // the chat doesn't show two parallel statuses.
          if (progressMsgId) {
            chatService.removeMessage(projectId, progressMsgId);
            broadcastToProject(projectId, { type: "remove_messages", projectId, messageIds: [progressMsgId] });
          }

          const errMsg = chatService.addMessage(projectId, {
            role: "assistant",
            type: "error",
            content: `${t(buildLang, "sys_build_failed")}: ${err.message || "Unknown error"}`,
            metadata: refundedCredits > 0 ? {
              refunded: true,
              creditsRefunded: refundedCredits,
              retry: { kind: "build" },
            } : undefined,
          });
          broadcastToProject(projectId, { type: "message", message: errMsg });
          broadcastToProject(projectId, { type: "status", projectId, status: "error", messageId: errMsg.id });
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

      // Edit plan is free (part of the build flow)

      chatService.addMessage(projectId, { role: "user", type: "text", content: feedback.trim() });

      const streamMsgId = crypto.randomBytes(8).toString("hex");
      res.json({ status: "streaming", streamMsgId });

      (async () => {
        broadcastToProject(projectId, { type: "plan_stream_start", projectId, messageId: streamMsgId });
        try {
          const updatedDescription = `${project.description}\n\nAdditional feedback: ${feedback.trim()}`;
          const result = await claudeService.generatePlan(
            updatedDescription, undefined, editPlanLang,
            (_delta, full) => {
              broadcastToProject(projectId, { type: "plan_stream_chunk", projectId, messageId: streamMsgId, text: full });
            },
          );
          await projectService.updateProjectPlan(projectId, result.plan);

          const usage = await billingService.recordUsage(
            user.id, projectId, runtimeConfig.getSessionConfig("build").model,
            { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            "plan",
          );

          const planMsg = chatService.addMessage(projectId, {
            role: "assistant", type: "plan", content: result.plan,
            metadata: { costUsd: usage.costUsd, balance: usage.newBalance, buildCost: runtimeConfig.getSessionCost("build") },
          });

          broadcastToProject(projectId, {
            type: "plan_stream_end", projectId, messageId: streamMsgId,
            message: planMsg, costUsd: usage.costUsd, balance: usage.newBalance,
          });
        } catch (err: any) {
          console.error("[Chat API] Edit plan error:", err);
          const errMsg = chatService.addMessage(projectId, {
            role: "assistant", type: "error",
            content: `Failed to update plan: ${err?.message || "Unknown error"}`,
          });
          broadcastToProject(projectId, {
            type: "plan_stream_end", projectId, messageId: streamMsgId,
            message: errMsg, error: err?.message || "Failed to update plan",
          });
        }
      })();
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

  // ── v4 chat router: classify message, propose action with one button ──
  app.post("/telegram-mini-app/api/chat/:projectId/route", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const lang = (user.language as Lang) || "en";
      const projectId = req.params.projectId;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const { text, attachmentIds } = req.body;
      if (!text || !text.trim()) { res.status(400).json({ error: "Empty message" }); return; }

      const routerUserData = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
      const routerCredits = routerUserData?.credits ?? 0;
      // Router session is always free (cost = 0); the charged session starts after proposal acceptance.
      const routerPreCharge = { creditsCharged: 0, newCredits: routerCredits };
      if (routerPreCharge.creditsCharged > 0) {
        broadcastToProject(projectId, { type: "balance_update", newCredits: routerPreCharge.newCredits });
      }

      // Persist the user's message so it survives reconnect.
      const userMsg = chatService.addMessage(projectId, { role: "user", type: "text", content: text.trim(), attachments: attachmentIds });
      broadcastToProject(projectId, { type: "message", message: userMsg });

      // Build attachment list for forwarding to the build agent if this routes to a build proposal.
      const routerAttachments = Array.isArray(userMsg.attachments) && userMsg.attachments.length > 0
        ? userMsg.attachments.map((a: any) => ({ localPath: a.path, projectPath: `frontend/assets/${a.name}`, originalName: a.name }))
        : undefined;

      res.json({ messageId: userMsg.id, status: "routing" });

      (async () => {
        broadcastToProject(projectId, { type: "router_thinking", projectId, intent: null, detail: "Reading your message..." });

        const allHistory = chatService.getHistory(projectId, undefined, 1000);
        // Include plain text (including proposal descriptions), completed build/update
        // result summaries, and error messages so the router has full session context.
        // Proposals are stored as type="text" with metadata.proposal=true, so their
        // description is already visible without special handling.
        const ROUTER_MSG_TYPES = new Set(["text", "result", "error"]);
        const routerHistory = allHistory
          .filter(m => (m.role === "user" || m.role === "assistant") && ROUTER_MSG_TYPES.has(m.type))
          .filter(m => m.id !== userMsg.id)
          .slice(-20)
          .map(m => {
            let content = m.content || "";
            if (m.type === "result") content = `[✅ Completed]: ${content}`;
            else if (m.type === "error") content = `[❌ Error]: ${content}`;
            return { role: m.role as "user" | "assistant", content };
          });

        // Wire questionnaire + proposal hooks to chat + WS.
        const hooks = {
          async askQuestion(question: string, options: string[]) {
            const qMsg = chatService.addMessage(projectId, {
              role: "assistant",
              type: "question",
              content: question,
              metadata: { options, source: "router" },
            });
            broadcastToProject(projectId, { type: "router_question", projectId, messageId: qMsg.id, question, options });

            return new Promise<{ answer: string }>((resolve) => {
              const timeout = setTimeout(() => resolve({ answer: "" }), 5 * 60 * 1000);
              registerAnswerResolver(projectId, (answer: string) => {
                clearTimeout(timeout);
                chatService.removeMessage(projectId, qMsg.id);
                broadcastToProject(projectId, { type: "remove_messages", projectId, messageIds: [qMsg.id] });
                // Re-emit thinking so the skeleton card reappears while the router
                // processes the answer and decides on a proposal.
                broadcastToProject(projectId, { type: "router_thinking", projectId, intent: null, detail: "Thinking\u2026" });
                resolve({ answer });
              });
            });
          },
          async emitProposal(p: {
            kind: string;
            title: string;
            description: string;
            plan?: string[];
            brief?: string;
            prefilledPrompt?: string;
            creditsCost: number;
            complexity?: string;
            maxModeMultiplier?: number;
            featureId?: string;
          }) {
            const pMsg = chatService.addMessage(projectId, {
              role: "assistant",
              type: "text",
              content: p.description,
              metadata: {
                proposal: true,
                kind: p.kind,
                title: p.title,
                description: p.description,
                plan: p.plan,
                brief: p.brief,
                prefilledPrompt: p.prefilledPrompt,
                creditsCost: p.creditsCost,
                complexity: p.complexity,
                maxModeMultiplier: p.maxModeMultiplier,
                featureId: p.featureId,
                // Carry attachments from the user's initial message into the proposal
                // so execute-proposal can forward them to session_build/session_update.
                buildAttachments: routerAttachments ? routerAttachments : undefined,
              },
            });
            broadcastToProject(projectId, { type: "message", message: pMsg });
            broadcastToProject(projectId, {
              type: "router_proposal",
              projectId,
              messageId: pMsg.id,
              proposalId: pMsg.id,
              kind: p.kind,
              title: p.title,
              description: p.description,
              plan: p.plan,
              creditsCost: p.creditsCost,
              complexity: p.complexity,
              maxModeMultiplier: p.maxModeMultiplier,
              featureId: p.featureId,
            });
            return { proposalId: pMsg.id };
          },
          emitThinking(detail: string) {
            broadcastToProject(projectId, { type: "router_thinking", projectId, intent: null, detail });
          },
        };

        const TOOL_LABELS: Record<string, string> = {
          project_info:   "Reading project info…",
          list_files:     "Listing project files…",
          read_file:      "Reading a file…",
          db_query:       "Checking the database…",
          platform_help:  "Looking up platform docs…",
          questionnaire:  "Asking you a question…",
          propose_action: "Deciding…",
        };
        const onToolCall = (toolName: string) => {
          if (toolName === "propose_action") return; // proposal event handles this
          broadcastToProject(projectId, {
            type: "router_tool_call",
            projectId,
            tool: toolName,
            label: TOOL_LABELS[toolName] || `${toolName}…`,
          });
        };

        try {
          const result = await agentSessionService.session_router(
            projectId, text.trim(), hooks as any, routerHistory, lang, onToolCall,
          );

          const usage = await billingService.recordUsage(
            user.id, projectId, result.modelId,
            { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            "router", undefined, false,
          );

          if (!result.proposed) {
            // Router didn't end with propose_action. This is a model behaviour bug.
            // Log it loudly so we can monitor and tighten the prompt over time.
            console.warn(
              "[Router] No proposal emitted. firstMessage=%s textLen=%d preview=%s",
              result.isFirstMessage,
              (result.text || "").length,
              (result.text || "").slice(0, 200).replace(/\s+/g, " "),
            );

            if (result.isFirstMessage) {
              // First message MUST produce a build proposal.
              const retryMsg = chatService.addMessage(projectId, {
                role: "assistant", type: "text",
                content: "Не удалось сформировать предложение. Пожалуйста, опишите, что вы хотите создать, и я начну сборку.",
                costUsd: usage.costUsd, balance: usage.newBalance,
              });
              broadcastToProject(projectId, { type: "message", message: retryMsg });
            } else if (result.text.trim()) {
              // Heuristic: detect "wall of questions" output (model emitted clarification
              // questions as free text instead of using questionnaire). Patterns:
              //   - 2+ question marks
              //   - bullet list (•/-/*) or numbered list with question marks
              const txt = result.text.trim();
              const qCount = (txt.match(/[?？]/g) || []).length;
              const isQuestionWall = qCount >= 2 && /[•\-*]|\b\d+[.)]/.test(txt);

              if (isQuestionWall) {
                // Replace the dead text wall with a clear retry hint. The model
                // should have used questionnaire — until prompts catch every
                // case, give the user a clean signal instead of a hideable wall.
                const retryMsg = chatService.addMessage(projectId, {
                  role: "assistant", type: "text",
                  content: "Мне нужно уточнить детали. Пришлите сообщение ещё раз — я задам вопросы по одному с кнопками для ответа.",
                  costUsd: usage.costUsd, balance: usage.newBalance,
                });
                broadcastToProject(projectId, { type: "message", message: retryMsg });
              } else {
                // Plain free-text answer (e.g. small chitchat) — render as-is.
                const fallbackMsg = chatService.addMessage(projectId, {
                  role: "assistant", type: "text",
                  content: txt,
                  costUsd: usage.costUsd, balance: usage.newBalance,
                });
                broadcastToProject(projectId, { type: "message", message: fallbackMsg });
              }
            } else {
              broadcastToProject(projectId, { type: "balance_update", newCredits: usage.newBalance });
            }
          } else {
            broadcastToProject(projectId, { type: "balance_update", newCredits: usage.newBalance });
          }
        } catch (err: any) {
          console.error("[Chat API] Router error:", err);
          // Router session is free, nothing to refund.
          const errMsg = chatService.addMessage(projectId, {
            role: "assistant", type: "error",
            content: `Failed to process message: ${err?.message || "Unknown error"}`,
          });
          broadcastToProject(projectId, { type: "message", message: errMsg });
        }
      })();
    } catch (err) {
      console.error("[Chat API] Route handler error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Execute a proposal card's button (Fix / Build) ──
  // Looks up the proposal message, extracts prefilledPrompt + planItems, then
  // re-uses the existing /send (update) pipeline by calling agentSessionService.session_update.
  app.post("/telegram-mini-app/api/chat/:projectId/execute-proposal", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const lang = (user.language as Lang) || "en";
      const projectId = req.params.projectId;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const { proposalId } = req.body;
      if (!proposalId) { res.status(400).json({ error: "proposalId required" }); return; }

      const history = chatService.getHistory(projectId, undefined, 2000);
      const proposalMsg = history.find(m => m.id === proposalId);
      if (!proposalMsg || !proposalMsg.metadata?.proposal) {
        res.status(404).json({ error: "Proposal not found" });
        return;
      }

      const kind = String(proposalMsg.metadata.kind || "");
      const prefilledPrompt = String(proposalMsg.metadata.prefilledPrompt || "").trim();
      const plan: string[] = Array.isArray(proposalMsg.metadata.plan) ? proposalMsg.metadata.plan : [];
      const brief = String(proposalMsg.metadata.brief || "").trim();
      const proposalTitle = String(proposalMsg.metadata.title || "").trim();
      const proposalDescription = String(proposalMsg.metadata.description || "").trim();
      const proposalComplexity = typeof proposalMsg.metadata.complexity === "string"
        ? proposalMsg.metadata.complexity
        : undefined;
      // Find the user message that triggered this proposal (last user msg before proposal in history)
      const proposalIndex = history.findIndex(m => m.id === proposalId);
      const triggerMsg = proposalIndex > 0
        ? [...history.slice(0, proposalIndex)].reverse().find(m => m.role === "user")
        : undefined;
      const userOriginalMessage = triggerMsg?.content || "";
      const baseCreditsCost: number = proposalMsg.metadata.creditsCost ?? 0;

      // MAX MODE — toggle from the proposal card. We re-read the multiplier
      // from runtime config (NOT from the metadata or req.body) so an admin
      // price change between propose and execute always wins, and so a
      // tampered client can't ship a sub-1 multiplier to undercharge.
      const maxMode = !!req.body?.max_mode;
      const PAID_KINDS = new Set(["build", "update", "update-plan", "bug-fix"]);
      const isPaidKind = PAID_KINDS.has(kind);
      const maxModeMultiplier = maxMode && isPaidKind ? runtimeConfig.getMaxModeMultiplier() : 1;
      const creditsCost = Math.max(0, Math.round(baseCreditsCost * maxModeMultiplier));
      const buildAttachments: { localPath: string; projectPath: string; originalName: string }[] | undefined =
        Array.isArray(proposalMsg.metadata.buildAttachments) && proposalMsg.metadata.buildAttachments.length > 0
          ? proposalMsg.metadata.buildAttachments
          : undefined;

      if (kind === "answer" || kind === "suggestions") {
        // Free sessions — answer was already shown in the bubble body.
        res.json({ status: "noop" });
        return;
      }
      const agentPrompt = prefilledPrompt || brief;
      if (!agentPrompt) {
        res.status(400).json({ error: "Proposal has no prompt or brief" });
        return;
      }
      if (processingProjects.has(projectId)) {
        res.status(409).json({ error: "Already processing" });
        return;
      }

      const execUserData = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
      const execCredits = execUserData?.credits ?? 0;
      if (execCredits < creditsCost) {
        const errMsg = chatService.addMessage(projectId, {
          role: "system",
          type: "balance_error",
          content: t(lang, "insufficient_balance_amount", { balance: `${execCredits} cr`, min: `${creditsCost} cr` }),
          metadata: { balance: execCredits, minCost: creditsCost },
        });
        broadcastToProject(projectId, { type: "message", message: errMsg });
        res.status(402).json({ error: "insufficient_balance" });
        return;
      }

      // Build the agent prompt. For update-plan prepend the plan checklist.
      let buildPrompt = agentPrompt;
      if (kind === "update-plan" && plan.length > 0) {
        const items = plan.map((s, i) => `${i + 1}. ${s}`).join("\n");
        buildPrompt = `${agentPrompt}\n\nPlanned subtasks (complete all):\n${items}`;
      }

      // Honour the exact price quoted on the proposal card. Admin price edits
      // between propose() and execute() must NOT silently re-bill the user.
      const preCharge = await billingService
        .preChargeAmount(user.id, projectId, creditsCost)
        .catch(() => ({ creditsCharged: 0, newCredits: execCredits }));
      if (preCharge.creditsCharged > 0) {
        broadcastToProject(projectId, { type: "balance_update", newCredits: preCharge.newCredits });
      }

      // Mark the proposal bubble as accepted so the client can hide its button.
      chatService.updateMessage(projectId, proposalId, {
        metadata: { ...proposalMsg.metadata, accepted: true },
      });
      broadcastToProject(projectId, { type: "proposal_accepted", projectId, proposalId });

      res.json({ status: "processing" });

      void trackEvent(auth.telegramId!, "agent_started", {
        project_id: projectId,
        source: `router_${kind}`,
        credits_cost: preCharge.creditsCharged,
        max_mode: maxMode,
        complexity: proposalComplexity || null,
      });

      (async () => {
        processingProjects.add(projectId);
        let progressMsgId: string | null = null;
        let items: { id: number; text: string; done: boolean }[] = [];

        const progressMsg = chatService.addMessage(projectId, {
          role: "assistant", type: "progress",
          content: t(lang, "sys_starting"), percent: 0,
          metadata: {
            creditsPreCharged: preCharge.creditsCharged,
            taskKind: kind,
            originalText: buildPrompt,
            sourceProposalId: proposalId,
            isMaxMode: maxMode,
            complexity: proposalComplexity,
          },
        });
        progressMsgId = progressMsg.id;
        broadcastToProject(projectId, { type: "message", message: progressMsg });

        const runningProject = await projectService.getProject(projectId);
        const pendingTaskId = (runningProject as any)?.lastTaskId;
        if (pendingTaskId) {
          broadcastToProject(projectId, { type: "task_started", taskId: pendingTaskId });
        }

        try {
          await projectService.updateProjectStatus(projectId, "building");
          let progressDone = false;
          const onProgress = async (p: AgentProgress) => {
            if (!progressMsgId || progressDone) return;
            if (forwardAgentProgress(projectId, progressMsgId, p, items)) return;
            if ((p.percent ?? 0) >= 100) { progressDone = true; return; }
            chatService.updateMessage(projectId, progressMsgId, {
              content: `${p.action} ${p.detail}`,
              percent: p.percent, costUsd: p.costUsd, balance: p.balance,
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

          let result: Awaited<ReturnType<typeof agentSessionService.session_build>>;
          const sessionExtras = {
            creditsCharged: preCharge.creditsCharged,
            maxMode,
            complexity: proposalComplexity,
            sessionKind: (kind === "build" || kind === "update" || kind === "bug-fix" || kind === "update-plan") ? kind as "build" | "update" | "bug-fix" | "update-plan" : undefined,
          };
          if (kind === "build") {
            result = await agentSessionService.session_build(
              projectId,
              {
                name: proposalTitle,
                description: proposalDescription,
                brief,
                userPrompt: userOriginalMessage,
              },
              onProgress, onAskUser, lang, execCredits, buildAttachments,
              sessionExtras,
            );
          } else {
            result = await agentSessionService.session_update(
              projectId, buildPrompt, onProgress, buildAttachments,
              onAskUser, lang, execCredits,
              sessionExtras,
            );
          }

          const proj = await projectService.getProject(projectId);
          const completedTaskId = (proj as any)?.lastTaskId || undefined;
          const usage = await billingService.recordUsage(
            user.id, projectId, result.model,
            { input_tokens: result.inputTokens, output_tokens: result.outputTokens, cache_creation_input_tokens: result.cacheWriteTokens, cache_read_input_tokens: result.cacheReadTokens },
            kind, undefined, preCharge.creditsCharged, completedTaskId,
          );
          await projectService.updateProjectStatus(projectId, "deployed");

          try {
            const shortLabel = kind === "build" ? "App created" : kind === "bug-fix" ? "Fix" : "Update";
            await commitService.createCommit(projectId, `${shortLabel}: ${buildPrompt.substring(0, 80)}`, result.commitNum!, result.commitDir!, result.logPath);
          } catch {}

          const allHistory = chatService.getHistory(projectId, undefined, 1000);
          const updateNum = allHistory.filter(m => m.type === "result").length + 1;
          const appName = proj?.name || "App";
          const changelogUrl = await publishReport(`${appName} — Update #${updateNum}`, result.summary).catch(() => null);

          const cashbackEnabled = runtimeConfig.get().cashbackEnabled !== false;
          const cashbackAvail = cashbackEnabled && (usage.creditsCharged ?? 0) > 0;
          if (progressMsgId) {
            chatService.updateMessage(projectId, progressMsgId, {
              type: "result", content: result.shortSummary, percent: 100,
              costUsd: usage.costUsd, balance: usage.newBalance,
              creditsCharged: usage.creditsCharged, commitNum: result.commitNum,
              cashbackAvailable: cashbackAvail, cashbackClaimed: false, checklist: items,
              // Preserve sourceProposalId so history replay can merge the cards.
              metadata: { changelogUrl, stepCount: result.stepCount, durationMs: result.durationMs, sourceProposalId: proposalId },
            });
          }

          broadcastToProject(projectId, {
            type: "status", projectId, status: "done", messageId: progressMsgId,
            summary: result.shortSummary, changelogUrl,
            costUsd: usage.costUsd, balance: usage.newBalance,
            creditsCharged: usage.creditsCharged, commitNum: result.commitNum,
            cashbackAvailable: cashbackAvail, stepCount: result.stepCount, durationMs: result.durationMs,
            // Tells the client to merge the completion card into the proposal bubble.
            sourceProposalId: proposalId,
          });

          notifyProcessDone(auth.telegramId!, appName, result.shortSummary, kind === "build" ? "build" : "update", lang);

          if (abortedProjects.has(projectId)) {
            abortedProjects.delete(projectId);
            processingProjects.delete(projectId);
            return;
          }

          broadcastToProject(projectId, { type: "message", message: { role: "system", content: "preparing_next_update", metadata: { preparing: true } } });
          (async () => {
            try {
              await agentSessionService.compactContext(projectId, result.commitDir!, result.summary, result.commitNum!, proj?.description || undefined, proj?.plan || undefined, result.contextDiff || undefined);
            } catch (err) {
              console.error("[Chat API] Background passport error:", err);
            } finally {
              broadcastToProject(projectId, { type: "finalizing_done", projectId });
              processingProjects.delete(projectId);
            }
          })();
        } catch (err: any) {
          if (err instanceof AgentAbortedError) {
            const abortedProj = await projectService.getProject(projectId).catch(() => null);
            const abortedTaskId = (abortedProj as any)?.lastTaskId || undefined;
            await billingService.recordUsage(
              user.id, projectId, err.model,
              { input_tokens: err.inputTokens, output_tokens: err.outputTokens, cache_creation_input_tokens: err.cacheWriteTokens, cache_read_input_tokens: err.cacheReadTokens },
              kind, undefined, false, abortedTaskId,
            );
            await projectService.updateProjectStatus(projectId, "deployed");
            processingProjects.delete(projectId);
            return;
          }
          console.error("[Chat API] Execute-proposal agent error:", err);
          await projectService.updateProjectStatus(projectId, "error");
          if (progressMsgId) {
            chatService.removeMessage(projectId, progressMsgId);
            broadcastToProject(projectId, { type: "remove_messages", projectId, messageIds: [progressMsgId] });
          }
          let refunded = 0;
          if (preCharge.creditsCharged > 0) {
            try {
              const r = await billingService.refundAction(user.id, projectId, "update", preCharge.creditsCharged);
              refunded = preCharge.creditsCharged;
              broadcastToProject(projectId, { type: "balance_update", newCredits: r.newCredits });
            } catch {}
          }
          const errMsg = chatService.addMessage(projectId, {
            role: "assistant", type: "error",
            content: `${t(lang, "sys_update_failed")}: ${err?.message || "Unknown error"}`,
            metadata: refunded > 0 ? { refunded: true, creditsRefunded: refunded, retry: { kind: "execute-proposal", proposalId } } : undefined,
          });
          broadcastToProject(projectId, { type: "message", message: errMsg });
          broadcastToProject(projectId, { type: "status", projectId, status: "error", messageId: errMsg.id });
          processingProjects.delete(projectId);
        }
      })();
    } catch (err) {
      console.error("[Chat API] Execute-proposal handler error:", err);
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
      const danglingMsgs = history
        .filter(m => (m.type === "progress" && (m.percent ?? 0) < 100) || m.type === "question");
      const danglingIds = danglingMsgs.map(m => m.id);

      if (!isInFlight && danglingIds.length === 0) {
        // Truly nothing to do — UI is already in sync with server.
        res.json({ ok: false, error: "Not processing" });
        return;
      }

      if (isInFlight) {
        abortedProjects.add(projectId);
        // Remove from processing immediately so history API no longer returns finalizing:true
        processingProjects.delete(projectId);
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

      // Server-restart recovery: refund any pre-charged credits sitting on
      // dangling progress messages. We DON'T refund on user-initiated aborts
      // (those go through recordUsage partial billing in the agent catch).
      // For each refunded run, post a fresh error+retry bubble so the user
      // sees "Credits refunded — Try again" even after a process restart.
      if (!isInFlight) {
        for (const m of danglingMsgs) {
          const meta = m.metadata || {};
          if (m.type !== "progress") continue;
          if (meta.refunded) continue;
          const credits = Number(meta.creditsPreCharged || 0);
          const taskKind = meta.taskKind === "build" || meta.taskKind === "update" ? meta.taskKind : null;
          if (credits <= 0 || !taskKind) continue;
          try {
            const r = await billingService.refundAction(user.id, projectId, taskKind, credits);
            broadcastToProject(projectId, { type: "balance_update", newCredits: r.newCredits });
            await projectService.updateProjectStatus(projectId, "error").catch(() => {});
            const errMsg = chatService.addMessage(projectId, {
              role: "assistant",
              type: "error",
              content: t((user.language as Lang) || "en", taskKind === "build" ? "sys_build_failed" : "sys_update_failed") + ": Process interrupted",
              metadata: {
                refunded: true,
                creditsRefunded: credits,
                retry: taskKind === "build"
                  ? { kind: "build" }
                  : { kind: "update", text: meta.originalText || "" },
              },
            });
            broadcastToProject(projectId, { type: "message", message: errMsg });
          } catch (refundErr) {
            console.error("[Chat API] Recovery refund failed:", refundErr);
          }
        }
      }

      broadcastToProject(projectId, { type: "finalizing_done", projectId });

      res.json({ ok: true, recovered: !isInFlight && danglingIds.length > 0 });
    } catch (err) {
      console.error("[Chat API] Abort error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Link Bot paywall API ─────────────────────────────────────────────
  // One-time 15-credit fee per project to unlock the "Create Bot" flow.
  // Charged for ALL users (not just non-depositors) since attaching a
  // Telegram bot is a high-value action. Once unlocked we log
  // `bot_create_unlock` in usage_logs so subsequent clicks (e.g. user
  // closed BotFather without finishing) don't re-charge.

  app.get("/telegram-mini-app/api/bot-create/:projectId/state", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId;

      const project = await projectService.getProject(projectId);
      if (!project) { res.status(404).json({ error: "Not found" }); return; }
      if (project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

      const alreadyUnlocked = await billingService.hasUnlockedBotCreate(user.id, projectId);
      const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });

      res.json({
        requiresPayment: !alreadyUnlocked && !project.botUsername,
        balance: fresh?.credits ?? 0,
        fee: LINK_BOT_FEE_CREDITS,
        alreadyUnlocked,
        alreadyLinked: !!project.botUsername,
      });
    } catch (err) {
      console.error("[BotCreate API] state error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/bot-create/:projectId/unlock", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId;

      const project = await projectService.getProject(projectId);
      if (!project) { res.status(404).json({ error: "Not found" }); return; }
      if (project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

      // Already linked (server saw a botUsername) → free pass-through.
      if (project.botUsername) {
        const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
        res.json({ ok: true, alreadyLinked: true, newCredits: fresh?.credits ?? 0 });
        return;
      }
      // Already paid for this project earlier → no double-charge.
      const alreadyUnlocked = await billingService.hasUnlockedBotCreate(user.id, projectId);
      if (alreadyUnlocked) {
        const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
        res.json({ ok: true, alreadyUnlocked: true, newCredits: fresh?.credits ?? 0 });
        return;
      }

      const fresh = await prisma.user.findUnique({ where: { id: user.id }, select: { credits: true } });
      const credits = fresh?.credits ?? 0;
      if (credits < LINK_BOT_FEE_CREDITS) {
        res.status(402).json({
          error: "insufficient_credits",
          required: LINK_BOT_FEE_CREDITS,
          balance: credits,
        });
        return;
      }

      const newCredits = await prisma.$transaction(async (tx) => {
        const u = await tx.user.update({
          where: { id: user.id },
          data: { credits: { decrement: LINK_BOT_FEE_CREDITS } },
        });
        await tx.usageLog.create({
          data: {
            userId: user.id,
            projectId,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: new Decimal("0"),
            operation: "bot_create_unlock",
            creditsCharged: LINK_BOT_FEE_CREDITS,
            },
        });
        return u.credits;
      });

      writeLedger(user.id, "credits", -LINK_BOT_FEE_CREDITS, "feature_purchase",
        { featureId: "bot_create_unlock", projectId });
      void trackEvent(auth.telegramId!, "bot_create_unlocked", { project_id: projectId });
      res.json({ ok: true, newCredits, fee: LINK_BOT_FEE_CREDITS });
    } catch (err) {
      console.error("[BotCreate API] unlock error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Tasks / Earn Credits API ──

  app.get("/telegram-mini-app/api/tasks", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);

      const tasks = await prisma.task.findMany({
        where: {
          isActive: true,
          OR: [{ targeting: "all" }, { targeting: user.language }],
        },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      });

      const completionSet = new Set(
        (await prisma.taskCompletion.findMany({
          where: { userId: user.id, taskId: { in: tasks.map(t => t.id) } },
          select: { taskId: true },
        })).map(c => c.taskId)
      );

      const lang = (user.language || "en") as string;
      const pick = (obj: any, fallback = "") => {
        if (!obj) return fallback;
        return obj[lang] || obj["en"] || obj["ru"] || fallback;
      };

      res.json(tasks.map(task => ({
        id: task.id,
        title: pick(task.title),
        description: pick(task.description),
        imageUrl: task.imageUrl,
        reward: task.reward,
        link: task.link,
        type: task.type,
        delaySeconds: task.delaySeconds,
        completed: completionSet.has(task.id),
      })));
    } catch (err) {
      console.error("[Tasks] list error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/tasks/:taskId/complete", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const taskId = parseInt(req.params.taskId, 10);

      const task = await prisma.task.findUnique({ where: { id: taskId } });
      if (!task || !task.isActive) { res.status(404).json({ error: "Task not found" }); return; }

      // Check already completed
      const existing = await prisma.taskCompletion.findUnique({
        where: { taskId_userId: { taskId, userId: user.id } },
      });
      if (existing) { res.status(409).json({ error: "already_completed" }); return; }

      // Verify completion for channel_subscribe tasks
      if (task.type === "channel_subscribe" && task.payload) {
        // Use the main bot token to check membership
        const botToken = config.botToken;
        const chatId = task.payload.trim();
        let isMember = false;
        try {
          const tgRes = await fetch(
            `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${auth.telegramId}`,
          );
          const tgData = await tgRes.json() as any;
          const status: string = tgData?.result?.status || "";
          isMember = ["member", "administrator", "creator"].includes(status);
        } catch (err) {
          console.error("[Tasks] getChatMember error:", err);
        }
        if (!isMember) {
          res.status(200).json({ ok: false, error: "not_subscribed" });
          return;
        }
      }

      // Grant credits in a transaction
      const result = await prisma.$transaction(async (tx) => {
        await tx.taskCompletion.create({ data: { taskId, userId: user.id } });
        const updated = await tx.user.update({
          where: { id: user.id },
          data: { credits: { increment: task.reward } },
        });
        return updated.credits;
      });
      writeLedger(user.id, "credits", task.reward, "task", { taskId });

      res.json({ ok: true, reward: task.reward, newCredits: result });
    } catch (err) {
      console.error("[Tasks] complete error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Agent Feedback (cashback issue) ──
  // The mini app calls this after a build/update completes when the user clicks
  // "Get cashback & rate agent" in the result bubble. We store the feedback,
  // refund 50% of credits charged, and return the new balance. The case can
  // later be analyzed by an admin (Admin → Agent Feedback → Run Analysis).
  app.get("/telegram-mini-app/api/feedback/check", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = String(req.query.projectId || "");
      const commitNumRaw = req.query.commitNum;
      const commitNum = typeof commitNumRaw === "string" ? parseInt(commitNumRaw, 10) : NaN;
      if (!projectId || !Number.isFinite(commitNum)) {
        res.status(400).json({ error: "projectId and commitNum required" });
        return;
      }
      const fb = await prisma.agentFeedback.findUnique({
        where: {
          userId_projectId_commitNumAfter: {
            userId: user.id,
            projectId,
            commitNumAfter: commitNum,
          },
        },
      });
      res.json({ rated: !!fb, cashbackCredits: fb?.cashbackCredits || 0 });
    } catch (err) {
      console.error("[Feedback] check error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/feedback", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);

      const projectId = String(req.body?.projectId || "");
      const commitNum = Number(req.body?.commitNum);
      const isCorrect = !!req.body?.isCorrect;
      const qualityScore = Math.max(0, Math.min(10, Math.round(Number(req.body?.qualityScore) || 0)));
      const speedScore = Math.max(0, Math.min(10, Math.round(Number(req.body?.speedScore) || 0)));
      const description = String(req.body?.description || "").trim();

      if (!projectId || !Number.isFinite(commitNum)) {
        res.status(400).json({ error: "projectId and commitNum required" });
        return;
      }

      if (runtimeConfig.get().cashbackEnabled === false) {
        res.status(403).json({ error: "Feedback cashback is currently disabled." });
        return;
      }

      // When user marks NOT correct we require a description (anti-gaming).
      if (!isCorrect && !description) {
        res.status(400).json({ error: "description_required" });
        return;
      }

      const project = await projectService.getProject(projectId);
      if (!project || project.userId !== user.id) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      // Refuse double-cashback for the same run.
      const existing = await prisma.agentFeedback.findUnique({
        where: {
          userId_projectId_commitNumAfter: {
            userId: user.id,
            projectId,
            commitNumAfter: commitNum,
          },
        },
      });
      if (existing) {
        res.status(409).json({ error: "already_rated", cashbackCredits: existing.cashbackCredits });
        return;
      }

      // Look up the matching UsageLog row for this run to determine credits
      // charged + the original user prompt (reconstructed from chat history).
      const usageRow = await prisma.usageLog.findFirst({
        where: { userId: user.id, projectId },
        orderBy: { createdAt: "desc" },
        take: 1,
      });
      const creditsCharged = usageRow?.creditsCharged ?? 0;
      const cashbackPercent = Math.max(0, Math.min(100, runtimeConfig.get().cashbackPercent ?? 50));
      const cashbackCredits = Math.max(0, Math.floor(creditsCharged * (cashbackPercent / 100)));

      // Try to recover the user prompt that triggered this run.
      let userPrompt = "";
      try {
        const history = chatService.getHistory(projectId, undefined, 200);
        const lastUserMsg = [...history].reverse().find(
          (m) => m.role === "user" && (m.type === "text" || m.type === "update_request" || m.type === "answer"),
        );
        userPrompt = lastUserMsg?.content?.slice(0, 4000) || "";
      } catch {}

      // Find the previous commit number from the project versions (best effort).
      let commitNumBefore: number | null = null;
      try {
        const commits = await commitService.getCommits(projectId);
        const idx = commits.findIndex((c) => parseInt(c.version, 10) === commitNum);
        if (idx > 0) commitNumBefore = parseInt(commits[idx - 1].version, 10);
      } catch {}

      const result = await prisma.$transaction(async (tx) => {
        const fb = await tx.agentFeedback.create({
          data: {
            projectId,
            userId: user.id,
            userPrompt: userPrompt || "(prompt unavailable)",
            commitNumBefore,
            commitNumAfter: commitNum,
            creditsCharged,
            isCorrect,
            qualityScore,
            speedScore,
            userDescription: description || null,
            cashbackCredits,
            cashbackPaidAt: cashbackCredits > 0 ? new Date() : null,
            analysisStatus: "pending",
          },
        });
        let newBalance = user.credits;
        if (cashbackCredits > 0) {
          const updated = await tx.user.update({
            where: { id: user.id },
            data: { credits: { increment: cashbackCredits } },
            select: { credits: true },
          });
          newBalance = updated.credits;
        }
        return { feedback: fb, newBalance, didCashback: cashbackCredits > 0 };
      });

      // Mark the result bubble as claimed so re-entry shows a "Rated ✓" pill.
      try {
        const history = chatService.getHistory(projectId, undefined, 200);
        const resultMsg = [...history].reverse().find(
          (m) => m.type === "result" && m.commitNum === commitNum,
        );
        if (resultMsg) {
          chatService.updateMessage(projectId, resultMsg.id, { cashbackClaimed: true });
        }
      } catch {}

      if (result.didCashback) {
        writeLedger(user.id, "credits", cashbackCredits, "cashback",
          { feedbackId: result.feedback.id, creditsCharged, cashbackPercent });
      }

      res.json({
        ok: true,
        cashbackCredits,
        newCredits: result.newBalance,
        newBalance: result.newBalance,
        feedbackId: result.feedback.id,
      });
    } catch (err: any) {
      console.error("[Feedback] submit error:", err);
      res.status(500).json({ error: err?.message || "Internal server error" });
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
    res.status(410).json({ error: "Quality tiers are disabled" });
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

      const context = await agentSessionService.regenerateContext(projectId);
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

  // ── App Store (owner endpoints) ─────────────────────────────────────────
  // Public read-only routes are mounted under /api/store; owner-authenticated
  // routes live here so they can use validateAuth + project ownership checks.

  const storeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

  // Shared helper: generate an image via OpenRouter Recraft API, return Buffer.
  const _aiGenerateImage = async (opts: {
    projectId: string;
    apiKey: string;
    prompt: string;
    filename: string;
    aspectRatio?: string;
    style?: string; // Recraft V3 style (e.g. "Illustration", "Vector art"). Omit for V4 Pro.
  }): Promise<Buffer | null> => {
    if (!opts.apiKey) return null;
    const useStyle = typeof opts.style === "string" && opts.style.trim().length > 0;
    const model = useStyle ? "recraft/recraft-v3" : "recraft/recraft-v4-pro";
    const image_config: Record<string, unknown> = { image_size: "1K" };
    if (opts.aspectRatio) image_config.aspect_ratio = opts.aspectRatio;
    if (useStyle) image_config.style = opts.style!.trim();
    const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": `https://${config.domain}`,
        "X-Title": "Apps Father",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: opts.prompt }],
        modalities: ["image"],
        image_config,
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!resp.ok) { console.warn(`[AI Gen] image API ${resp.status}`); return null; }
    const data = await resp.json() as Record<string, any>;
    const imgUrl: string | undefined =
      data?.choices?.[0]?.message?.images?.[0]?.image_url?.url ??
      data?.choices?.[0]?.message?.images?.[0]?.imageUrl?.url;
    if (!imgUrl) { console.warn("[AI Gen] no image in response"); return null; }
    const base64 = imgUrl.replace(/^data:image\/[a-z]+;base64,/, "");
    return Buffer.from(base64, "base64");
  };

  // Resolve listing → owner-validated; admins are allowed too.
  const requireListingOwner = async (req: any, res: any): Promise<{ ok: false } | { ok: true; userId: number; isAdmin: boolean; listing: any }> => {
    const auth = validateAuth(req);
    if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return { ok: false }; }
    const { user } = await getOrCreateUserFromReq(req, auth);
    const isAdmin = isAdminTelegramId(auth.telegramId);
    const listing = await prisma.appListing.findUnique({
      where: { id: req.params.listingId },
      include: { project: { select: { id: true, userId: true } }, token: true },
    });
    if (!listing) { res.status(404).json({ error: "Listing not found" }); return { ok: false }; }
    if (!isAdmin && listing.project.userId !== user.id) {
      res.status(403).json({ error: "Forbidden" }); return { ok: false };
    }
    return { ok: true, userId: user.id, isAdmin, listing };
  };

  // Get-or-create draft for a project the caller owns.
  app.post("/telegram-mini-app/api/store/projects/:projectId/listing", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const project = await projectService.getProject(req.params.projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
      const listing = await appStoreService.getOrCreateDraft(req.params.projectId);
      res.json({ listing });
    } catch (err: any) {
      console.error("[Store] draft error:", err);
      res.status(500).json({ error: err.message || "Internal" });
    }
  });

  // Update draft fields (descriptions, socials, token name/symbol).
  app.patch("/telegram-mini-app/api/store/listings/:listingId", async (req, res) => {
    try {
      const r = await requireListingOwner(req, res); if (!r.ok) return;
      const updated = await appStoreService.updateDraft(req.params.listingId, req.body || {});
      res.json({ listing: updated });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Upload a screenshot (multipart "file").
  app.post(
    "/telegram-mini-app/api/store/listings/:listingId/screenshots",
    storeUpload.single("file"),
    async (req, res) => {
      try {
        const r = await requireListingOwner(req, res); if (!r.ok) return;
        if (!req.file) { res.status(400).json({ error: "No file" }); return; }
        const ext = (req.file.mimetype.split("/")[1] || "png").toLowerCase();
        const filename = await appStoreService.addScreenshot(
          req.params.listingId as string,
          r.listing.projectId,
          req.file.buffer,
          ext,
        );
        res.json({ ok: true, filename, url: `/bucket/${r.listing.projectId}/${filename}` });
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    },
  );

  app.delete("/telegram-mini-app/api/store/listings/:listingId/screenshots/:filename", async (req, res) => {
    try {
      const r = await requireListingOwner(req, res); if (!r.ok) return;
      await appStoreService.removeScreenshot(req.params.listingId, r.listing.projectId, req.params.filename);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Upload an App Store-specific app logo (avatar). Independent from the
  // bot avatar fetched from Telegram.
  app.post(
    "/telegram-mini-app/api/store/listings/:listingId/app-logo",
    storeUpload.single("file"),
    async (req, res) => {
      try {
        const r = await requireListingOwner(req, res); if (!r.ok) return;
        if (!req.file) { res.status(400).json({ error: "No file" }); return; }
        const ext = (req.file.mimetype.split("/")[1] || "png").toLowerCase();
        const filename = await appStoreService.setAppLogo(
          req.params.listingId as string,
          r.listing.projectId,
          req.file.buffer,
          ext,
        );
        res.json({ ok: true, filename, url: `/bucket/${r.listing.projectId}/${filename}` });
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    },
  );

  // Upload a hero/banner image for the App Store detail page.
  app.post(
    "/telegram-mini-app/api/store/listings/:listingId/banner",
    storeUpload.single("file"),
    async (req, res) => {
      try {
        const r = await requireListingOwner(req, res); if (!r.ok) return;
        if (!req.file) { res.status(400).json({ error: "No file" }); return; }
        const ext = (req.file.mimetype.split("/")[1] || "png").toLowerCase();
        const filename = await appStoreService.setBanner(
          req.params.listingId as string,
          r.listing.projectId,
          req.file.buffer,
          ext,
        );
        res.json({ ok: true, filename, url: `/bucket/${r.listing.projectId}/${filename}` });
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    },
  );

  app.delete("/telegram-mini-app/api/store/listings/:listingId/banner", async (req, res) => {
    try {
      const r = await requireListingOwner(req, res); if (!r.ok) return;
      await appStoreService.removeBanner(req.params.listingId, r.listing.projectId);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Readiness panel for the redesigned 7-step App Settings publish flow.
  // Returns the per-step done/missing state so the mini-app can render the
  // progress bar without computing it locally.
  //
  // Auth follows the same pattern as the rest of the store routes:
  // validateAuth → resolve / create user → ensure project ownership (admins
  // are allowed too).
  app.get("/telegram-mini-app/api/store/projects/:projectId/readiness", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const isAdmin = isAdminTelegramId(auth.telegramId);
      const project = await prisma.project.findUnique({
        where: { id: req.params.projectId },
        select: { id: true, userId: true },
      });
      if (!project) { res.status(404).json({ error: "Project not found" }); return; }
      if (!isAdmin && project.userId !== user.id) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
      const readiness = await appStoreService.getReadiness(req.params.projectId);
      res.json(readiness);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Upload token logo (separate from app logo).
  app.post(
    "/telegram-mini-app/api/store/listings/:listingId/token-logo",
    storeUpload.single("file"),
    async (req, res) => {
      try {
        const r = await requireListingOwner(req, res); if (!r.ok) return;
        if (!req.file) { res.status(400).json({ error: "No file" }); return; }
        const ext = (req.file.mimetype.split("/")[1] || "png").toLowerCase();
        const filename = await appStoreService.setTokenLogo(
          req.params.listingId as string,
          r.listing.projectId,
          req.file.buffer,
          ext,
        );
        res.json({ ok: true, filename, url: `/bucket/${r.listing.projectId}/${filename}` });
      } catch (err: any) {
        res.status(400).json({ error: err.message });
      }
    },
  );

  // ── AI content generation (SSE) ─────────────────────────────────────────
  // items: array of "texts" | "avatar" | "banner" | "screenshots"
  app.post("/telegram-mini-app/api/store/listings/:listingId/ai-generate", async (req, res) => {
    // SSE setup
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const emit = (data: Record<string, unknown>) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
    };

    try {
      const auth = validateAuth(req);
      if (!auth.valid) { emit({ type: "error", message: "Unauthorized" }); res.end(); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const listingId = req.params.listingId as string;
      const items: string[] = Array.isArray(req.body?.items) ? req.body.items : ["texts", "avatar", "banner", "screenshots"];

      const listing = await prisma.appListing.findUnique({
        where: { id: listingId },
        include: { project: { select: { id: true, userId: true, name: true, projectSummary: true } } },
      });
      if (!listing) { emit({ type: "error", message: "Listing not found" }); res.end(); return; }
      if (listing.project?.userId !== user.id && !isAdminTelegramId(auth.telegramId)) {
        emit({ type: "error", message: "Forbidden" }); res.end(); return;
      }

      const projectId = listing.projectId;
      const appName = (listing.appName as string | null) || listing.project?.name || "App";
      // Use /dev/ URL — same path the VisualTestTool uses so the app is always reachable.
      const appUrl = `${config.baseUrl}/dev/${projectId}/`;
      const results: Record<string, unknown> = {};
      let pct = 0;

      // ── 1. Texts (names, descriptions, tags, category in EN/RU/UA) ──────────
      if (items.includes("texts")) {
        pct = 5;
        emit({ type: "progress", step: "texts", percent: pct, message: "Analyzing your app…" });

        const apiKey = runtimeConfig.getOpenRouterApiKey() || config.openrouterApiKey;
        if (!apiKey) { emit({ type: "error", message: "No API key configured" }); res.end(); return; }

        const existingDesc = (listing.shortDescription as string | null) || "";
        const summary = (listing.project?.projectSummary as string | null) || "";

        const prompt = `You are a professional App Store copywriter. Generate listing content for a Telegram Mini App.

App name: "${appName}"${existingDesc ? `\nCurrent description: "${existingDesc}"` : ""}${summary ? `\nApp context: "${summary.slice(0, 600)}"` : ""}

Return ONLY valid JSON (no markdown, no fences):
{
  "en": { "name": "...", "shortDescription": "...", "longDescription": "...", "tags": ["tag1",...], "category": "..." },
  "ru": { "name": "...", "shortDescription": "...", "longDescription": "..." },
  "ua": { "name": "...", "shortDescription": "...", "longDescription": "..." }
}

Rules:
- name: max 32 chars, catchy
- shortDescription: max 120 chars, one compelling sentence
- longDescription: 300-600 chars, features and benefits
- tags: 5-8 relevant lowercase tags (hyphens ok, no spaces)
- category: ONE of: Finance, Social, Games, Tools, Education, Shopping, News, Health, Entertainment, Business
- Translate ru and ua naturally`;

        pct = 10;
        emit({ type: "progress", step: "texts", percent: pct, message: "Writing descriptions…" });

        const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": `https://${config.domain}`,
            "X-Title": "Apps Father",
          },
          body: JSON.stringify({
            model: "anthropic/claude-3-5-haiku",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 2000,
          }),
          signal: AbortSignal.timeout(30_000),
        });

        const respData = await resp.json() as Record<string, any>;
        const raw: string = respData?.choices?.[0]?.message?.content || "";
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const gen = JSON.parse(jsonMatch[0]);
            results.texts = gen;
            await prisma.appListing.update({
              where: { id: listingId },
              data: {
                appName: gen.en?.name || appName,
                shortDescription: gen.en?.shortDescription || null,
                longDescription: gen.en?.longDescription || null,
                category: gen.en?.category || null,
                tags: gen.en?.tags || [],
                translations: {
                  ru: { name: gen.ru?.name || "", short: gen.ru?.shortDescription || "", long: gen.ru?.longDescription || "" },
                  ua: { name: gen.ua?.name || "", short: gen.ua?.shortDescription || "", long: gen.ua?.longDescription || "" },
                },
              },
            });
          } catch {}
        }
        pct = 25;
        emit({ type: "result", step: "texts", data: results.texts });
        emit({ type: "progress", step: "texts", percent: pct, message: "Descriptions done ✓" });
      }

      // ── 2. Avatar ────────────────────────────────────────────────────────────
      if (items.includes("avatar")) {
        pct = 30;
        emit({ type: "progress", step: "avatar", percent: pct, message: "Creating app icon…" });
        try {
          const avatarBuf = await _aiGenerateImage({
            projectId, apiKey: runtimeConfig.getOpenRouterApiKey() || config.openrouterApiKey,
            prompt: `App icon for "${appName}" Telegram mini app. Bold single graphic symbol centered on a rich vibrant gradient background. Clean minimal design, no text, no letters, no words. Square composition. Professional mobile app icon.`,
            filename: `ai-avatar-${Date.now()}.png`,
            aspectRatio: "1:1",
          });
          if (avatarBuf) {
            const filename = await appStoreService.setAppLogo(listingId, projectId, avatarBuf, "png");
            results.avatar = { filename, url: `/bucket/${projectId}/${filename}` };
            emit({ type: "result", step: "avatar", data: results.avatar });
          }
        } catch (e: any) { console.warn("[AI Gen] avatar:", e.message); }
        pct = 50;
        emit({ type: "progress", step: "avatar", percent: pct, message: "Icon done ✓" });
      }

      // ── 3. Banner ────────────────────────────────────────────────────────────
      if (items.includes("banner")) {
        pct = 52;
        emit({ type: "progress", step: "banner", percent: pct, message: "Creating banner…" });
        try {
          const bannerBuf = await _aiGenerateImage({
            projectId, apiKey: runtimeConfig.getOpenRouterApiKey() || config.openrouterApiKey,
            prompt: `App Store header banner for a Telegram Mini App called "${appName}". Dark atmospheric background gradient from near-black to deep navy. Abstract thematic illustration — glowing geometric shapes, subtle UI motifs, vibrant accent lighting. App name "${appName}" in clean bold white text. No photos of people. Wide cinematic landscape format. Professional, modern, high quality.`,
            filename: `ai-banner-${Date.now()}.png`,
            aspectRatio: "16:9",
          });
          if (bannerBuf) {
            const filename = await appStoreService.setBanner(listingId, projectId, bannerBuf, "png");
            results.banner = { filename, url: `/bucket/${projectId}/${filename}` };
            emit({ type: "result", step: "banner", data: results.banner });
          }
        } catch (e: any) { console.warn("[AI Gen] banner:", e.message); }
        pct = 72;
        emit({ type: "progress", step: "banner", percent: pct, message: "Banner done ✓" });
      }

      // ── 4. Screenshots via Playwright ────────────────────────────────────────
      if (items.includes("screenshots")) {
        pct = 74;
        emit({ type: "progress", step: "screenshots", percent: pct, message: "Opening your app…" });
        try {
          const { runVisualTest } = await import("../services/visual-test.service");
          // Build unsigned initData so the app doesn't 401
          const initData = `auth_date=${Math.floor(Date.now()/1000)}&user=${encodeURIComponent(JSON.stringify({ id: 999999999, first_name: "Preview", username: "preview_user", language_code: "en" }))}&hash=visualtest_unsigned`;
          const screenshotFilenames: string[] = [];

          const scrollAmounts = [0, 300, 600, 900];
          for (let i = 0; i < 4; i++) {
            pct = 74 + i * 5;
            emit({ type: "progress", step: "screenshots", percent: pct, message: `Screenshot ${i + 1}/4…` });
            try {
              const scenario = scrollAmounts[i] > 0
                ? [{ target: "body", type: "scroll" as const, amount: scrollAmounts[i] }]
                : undefined;
              const result = await runVisualTest(appUrl, {
                viewportWidth: 390, viewportHeight: 844,
                timeout: 20000, settleMs: 2500 + i * 300,
                emulateTelegram: true,
                initDataHash: initData,
                scenario: scenario as any,
              });
              if (result.screenshotBase64) {
                const buf = Buffer.from(result.screenshotBase64, "base64");
                const filename = await appStoreService.addScreenshot(listingId, projectId, buf, "png");
                screenshotFilenames.push(filename);
              }
            } catch (e: any) { console.warn(`[AI Gen] screenshot ${i}:`, e.message); }
          }
          results.screenshots = screenshotFilenames;
          emit({ type: "result", step: "screenshots", data: { filenames: screenshotFilenames } });
        } catch (e: any) { console.warn("[AI Gen] screenshots:", e.message); }
        pct = 98;
        emit({ type: "progress", step: "screenshots", percent: pct, message: "Screenshots done ✓" });
      }

      emit({ type: "progress", step: "done", percent: 100, message: "All done!" });
      emit({ type: "done", data: results });
    } catch (err: any) {
      emit({ type: "error", message: err.message || "Generation failed" });
    }
    res.end();
  });

  // Submit for review (returns wallet address + comment to use in TonConnect).
  app.post("/telegram-mini-app/api/store/listings/:listingId/submit", async (req, res) => {
    try {
      const r = await requireListingOwner(req, res); if (!r.ok) return;
      const result = await appStoreService.submit(req.params.listingId);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── PF2: internal-balance token creation + balance fetch ─────────────────

  // Create the App Token. Deducts initial liquidity from user's TON balance.
  app.post("/telegram-mini-app/api/store/listings/:listingId/create-token", async (req, res) => {
    try {
      const r = await requireListingOwner(req, res); if (!r.ok) return;
      const ticker = String(req.body?.ticker || "");
      const liquidityTon = Number(req.body?.liquidityTon || 0);
      const result = await appStoreService.createToken(req.params.listingId, r.userId, { ticker, liquidityTon });
      res.json({ ok: true, ...result });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Wallet TON top-up ────────────────────────────────────────────────────

  // Step 1: create a pending topup record and return the platform wallet + amount.
  app.post("/telegram-mini-app/api/wallet/topup-create", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);

      const amountTon = parseFloat(req.body.amountTon);
      if (isNaN(amountTon) || amountTon < 0.1) {
        res.status(400).json({ error: "Minimum top-up is 0.1 TON" });
        return;
      }
      if (amountTon > 1000) {
        res.status(400).json({ error: "Maximum top-up is 1000 TON" });
        return;
      }

      const amountNano = String(BigInt(Math.round(amountTon * 1e9)));
      const topup = await prisma.tonTopup.create({
        data: {
          userId: user.id,
          amountTon: amountTon,
          amountNano,
          status: "pending",
        },
      });

      res.json({
        topupId: topup.id,
        walletAddress: appStoreService.platformWalletAddress(),
        amountNano,
        comment: `topup:${topup.id}`,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Step 2: poll for topup status (called by frontend after tx is sent).
  app.get("/telegram-mini-app/api/wallet/topup-status/:topupId", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const topup = await prisma.tonTopup.findUnique({ where: { id: req.params.topupId } });
      if (!topup || topup.userId !== user.id) { res.status(404).json({ error: "Not found" }); return; }
      res.json({ status: topup.status, confirmedAt: topup.confirmedAt });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Real TON price (CoinGecko, 60 s cache) ──────────────────────────────
  let _tonPriceCache: { usd: number; fetchedAt: number } = { usd: 5.50, fetchedAt: 0 };
  async function getTonPriceUsd(): Promise<number> {
    const now = Date.now();
    if (now - _tonPriceCache.fetchedAt < 60_000) return _tonPriceCache.usd;
    try {
      const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd", {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
      if (r.ok) {
        const d = await r.json() as any;
        const usd = d?.["the-open-network"]?.usd;
        if (typeof usd === "number" && usd > 0) _tonPriceCache = { usd, fetchedAt: now };
      }
    } catch { /* keep cached */ }
    return _tonPriceCache.usd;
  }

  app.get("/telegram-mini-app/api/wallet/ton-price", async (_req, res) => {
    try {
      const usd = await getTonPriceUsd();
      res.json({ usd });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Market tokens (all tokens available to swap into) ────────────────────
  app.get("/telegram-mini-app/api/wallet/market-tokens", async (req, res) => {
    try {
      const { spotPriceNano: ammSpot } = await import("../services/liquidity-amm.service");
      const tokens = await prisma.appToken.findMany({
        where: { status: "live" },
        include: {
          listing: {
            select: {
              id: true, appName: true, status: true, appLogoFilename: true,
              project: { select: { id: true, name: true } },
            },
          },
        },
      });
      const rows = tokens.map((t) => {
        let tonRes = t.realTonReserve;
        let tokRes = t.realTokenReserve;
        if ((tonRes === 0n || tokRes === 0n) && t.creationLockedLiquidityTon) {
          const initTon = BigInt(Math.round(Number(t.creationLockedLiquidityTon) * 1e9));
          const initTok = (t.totalSupply * 9n) / 10n;
          tonRes = initTon; tokRes = initTok;
        }
        const state = { realTonReserve: tonRes, realTokenReserve: tokRes, lpTotalShares: t.lpTotalShares };
        const pNano = ammSpot(state);
        const priceTon = Number(pNano) / 1e9;
        const mcapTon = (Number(pNano) * Number(t.totalSupply)) / 1e18;
        const displayLogo = (t.listing as any)?.appLogoFilename || t.logoFilename || null;
        return {
          tokenId: t.id,
          listingId: t.listingId,
          projectId: t.projectId,
          name: t.name,
          symbol: t.symbol,
          logoFilename: displayLogo,
          priceTon,
          mcapTon,
        };
      });
      res.json(rows);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Swap quote (read-only). direction: "buy" (TON→token) or "sell" (token→TON) ─
  app.get("/telegram-mini-app/api/wallet/swap-quote", async (req, res) => {
    try {
      const { quoteBuy, quoteSell, spotPriceNano: ammSpot } = await import("../services/liquidity-amm.service");
      const direction = (req.query.direction as string) || "buy";
      const amountIn = parseFloat(req.query.amountIn as string || req.query.tonAmount as string || "0");
      const tokenId = String(req.query.tokenId || "");
      if (!tokenId || amountIn <= 0) { res.status(400).json({ error: "tokenId and amountIn required" }); return; }
      const t = await prisma.appToken.findUnique({ where: { id: tokenId } });
      if (!t) { res.status(404).json({ error: "Token not found" }); return; }
      let tonRes = t.realTonReserve;
      let tokRes = t.realTokenReserve;
      if ((tonRes === 0n || tokRes === 0n) && t.creationLockedLiquidityTon) {
        tonRes = BigInt(Math.round(Number(t.creationLockedLiquidityTon) * 1e9));
        tokRes = (t.totalSupply * 9n) / 10n;
      }
      const feePercent = runtimeConfig.get().appStore.tradingFeePercent;
      const state = { realTonReserve: tonRes, realTokenReserve: tokRes, lpTotalShares: t.lpTotalShares };
      const priceBefore = Number(ammSpot(state)) / 1e9;

      if (direction === "sell") {
        const tokensInAtomic = BigInt(Math.round(amountIn * 1e9));
        const quote = quoteSell(state, tokensInAtomic, feePercent);
        const priceAfter = quote.newTokenReserve > 0n
          ? Number((quote.newTonReserve * BigInt(1e9)) / quote.newTokenReserve) / 1e9
          : priceBefore;
        res.json({
          direction: "sell",
          amountOut: Number(quote.tonOutNet) / 1e9,
          feePercent,
          priceImpactBps: quote.priceImpactBps,
          priceTonBefore: priceBefore,
          priceTonAfter: priceAfter,
        });
        return;
      }

      // buy: TON → token
      const tonInNano = BigInt(Math.round(amountIn * 1e9));
      const quote = quoteBuy(state, tonInNano, feePercent);
      const priceAfter = quote.newTokenReserve > 0n
        ? Number((quote.newTonReserve * BigInt(1e9)) / quote.newTokenReserve) / 1e9
        : priceBefore;
      res.json({
        direction: "buy",
        amountOut: Number(quote.tokensOut) / 1e9,
        // legacy field for older client code
        tokensOut: Number(quote.tokensOut) / 1e9,
        feePercent,
        priceImpactBps: quote.priceImpactBps,
        priceTonBefore: priceBefore,
        priceTonAfter: priceAfter,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Execute internal swap (TON ↔ token, no TonConnect needed) ────────────
  // Body: { tokenId, direction: "buy"|"sell", amountIn }
  // Backwards-compatible: { tokenId, tonAmountIn } → buy
  app.post("/telegram-mini-app/api/wallet/swap", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const { quoteBuy, quoteSell, spotPriceNano: ammSpot, marketCapNano } = await import("../services/liquidity-amm.service");
      const tokenId = String(req.body?.tokenId || "");
      const direction = (String(req.body?.direction || "buy")) as "buy" | "sell";
      const amountIn = parseFloat(req.body?.amountIn ?? req.body?.tonAmountIn ?? 0);
      if (!tokenId || amountIn <= 0) { res.status(400).json({ error: "tokenId and amountIn required" }); return; }

      const result = await prisma.$transaction(async (tx) => {
        const t = await tx.appToken.findUniqueOrThrow({ where: { id: tokenId } });
        if (t.status !== "live") throw new Error("Token is not live");

        // Auto-seed pool if first trade
        let tonRes = t.realTonReserve;
        let tokRes = t.realTokenReserve;
        if ((tonRes === 0n || tokRes === 0n) && t.creationLockedLiquidityTon) {
          tonRes = BigInt(Math.round(Number(t.creationLockedLiquidityTon) * 1e9));
          tokRes = (t.totalSupply * 9n) / 10n;
        }
        if (tonRes === 0n || tokRes === 0n) throw new Error("Token pool not initialized — no initial liquidity");

        const feePercent = runtimeConfig.get().appStore.tradingFeePercent;
        const state = { realTonReserve: tonRes, realTokenReserve: tokRes, lpTotalShares: t.lpTotalShares };

        if (direction === "sell") {
          // SELL: token → TON
          const tokensInAtomic = BigInt(Math.round(amountIn * 1e9));
          const holding = await tx.tokenHolding.findUnique({
            where: { tokenId_userId: { tokenId, userId: user.id } },
          });
          if (!holding || holding.balance < tokensInAtomic) throw new Error(`Insufficient ${t.symbol} balance`);
          const quote = quoteSell(state, tokensInAtomic, feePercent);
          if (quote.tonOutNet <= 0n) throw new Error("Swap yields zero TON — amount too small or pool too small");

          const priceNano = tokensInAtomic > 0n ? (quote.tonOutGross * BigInt(1e9)) / tokensInAtomic : 0n;
          const mcap = marketCapNano({ realTonReserve: quote.newTonReserve, realTokenReserve: quote.newTokenReserve, lpTotalShares: t.lpTotalShares }, t.totalSupply);

          // Update pool
          await tx.appToken.update({
            where: { id: tokenId },
            data: {
              realTonReserve: quote.newTonReserve,
              realTokenReserve: quote.newTokenReserve,
              feeBalanceNanoTon: { increment: quote.feeNano },
            },
          });

          // Decrement user holding
          const newBal = holding.balance - tokensInAtomic;
          await tx.tokenHolding.update({
            where: { tokenId_userId: { tokenId, userId: user.id } },
            data: { balance: newBal },
          });

          // Credit TON to user
          const tonOutFloat = Number(quote.tonOutNet) / 1e9;
          await tx.user.update({ where: { id: user.id }, data: { tonBalance: { increment: tonOutFloat as any } } });

          // Listing volume + mcap
          await tx.appListing.update({
            where: { id: t.listingId },
            data: { volume24hNanoTon: { increment: quote.tonOutGross }, marketCapNanoTon: mcap },
          });

          // Record the trade so the chart has data points
          const sellTrade = await tx.tokenTrade.create({
            data: {
              tokenId,
              userId: user.id,
              type: "sell",
              tonAmount: quote.tonOutNet,
              tokenAmount: tokensInAtomic,
              priceNanoTon: priceNano,
              feeTonAmount: quote.feeNano,
              status: "settled",
            },
          });

          return {
            direction: "sell",
            _ledger: { symbol: t.symbol, tokensInAtomic: Number(tokensInAtomic), tonOutFloat, tradeId: sellTrade.id },
            amountOut: tonOutFloat,
            feePercent,
            priceImpactBps: quote.priceImpactBps,
            newPriceTon: Number(ammSpot({ realTonReserve: quote.newTonReserve, realTokenReserve: quote.newTokenReserve, lpTotalShares: t.lpTotalShares })) / 1e9,
            outSymbol: "TON",
          };
        }

        // BUY: TON → token
        const u = await tx.user.findUnique({ where: { id: user.id }, select: { tonBalance: true } });
        if (!u) throw new Error("User not found");
        if (Number(u.tonBalance) < amountIn) throw new Error(`Insufficient TON balance`);
        const tonInNano = BigInt(Math.round(amountIn * 1e9));
        const quote = quoteBuy(state, tonInNano, feePercent);
        if (quote.tokensOut <= 0n) throw new Error("Swap yields zero tokens — amount too small or pool exhausted");

        const priceNano = tonInNano > 0n ? (tonInNano * BigInt(1e9)) / quote.tokensOut : 0n;
        const mcap = marketCapNano({ realTonReserve: quote.newTonReserve, realTokenReserve: quote.newTokenReserve, lpTotalShares: t.lpTotalShares }, t.totalSupply);

        await tx.user.update({ where: { id: user.id }, data: { tonBalance: { decrement: amountIn as any } } });
        await tx.appToken.update({
          where: { id: tokenId },
          data: {
            realTonReserve: quote.newTonReserve,
            realTokenReserve: quote.newTokenReserve,
            feeBalanceNanoTon: { increment: quote.feeNano },
            soldSupply: { increment: quote.tokensOut },
          },
        });
        await tx.appListing.update({
          where: { id: t.listingId },
          data: { volume24hNanoTon: { increment: tonInNano }, marketCapNanoTon: mcap },
        });
        const existing = await tx.tokenHolding.findUnique({
          where: { tokenId_userId: { tokenId, userId: user.id } },
        });
        const newBal = (existing?.balance ?? 0n) + quote.tokensOut;
        const newAvg = newBal > 0n
          ? ((existing?.balance ?? 0n) * (existing?.avgBuyNanoTon ?? 0n) + quote.tokensOut * priceNano) / newBal
          : priceNano;
        await tx.tokenHolding.upsert({
          where: { tokenId_userId: { tokenId, userId: user.id } },
          create: { tokenId, userId: user.id, balance: newBal, avgBuyNanoTon: newAvg },
          update: { balance: newBal, avgBuyNanoTon: newAvg },
        });

        // Record the trade so the chart has data points
        const buyTrade = await tx.tokenTrade.create({
          data: {
            tokenId,
            userId: user.id,
            type: "buy",
            tonAmount: tonInNano,
            tokenAmount: quote.tokensOut,
            priceNanoTon: priceNano,
            feeTonAmount: quote.feeNano,
            status: "settled",
          },
        });

        const tokensOutFloat = Number(quote.tokensOut) / 1e9;
        return {
          direction: "buy",
          amountOut: tokensOutFloat,
          tokensOut: tokensOutFloat,
          feePercent,
          priceImpactBps: quote.priceImpactBps,
          newPriceTon: Number(ammSpot({ realTonReserve: quote.newTonReserve, realTokenReserve: quote.newTokenReserve, lpTotalShares: t.lpTotalShares })) / 1e9,
          outSymbol: t.symbol,
          _ledger: { symbol: t.symbol, tokensOutFloat, tradeId: buyTrade.id },
        };
      });

      // Ledger writes happen after the transaction commits (never inside tx)
      if (result._ledger) {
        const L = result._ledger as any;
        if (result.direction === "sell") {
          writeLedger(user.id, L.symbol, -L.tokensInAtomic / 1e9, "swap_sell",
            { tradeId: L.tradeId, tokenId, tonOutNet: L.tonOutFloat });
          writeLedger(user.id, "TON", L.tonOutFloat, "swap_sell",
            { tradeId: L.tradeId, tokenId, tokenSymbol: L.symbol });
        } else {
          writeLedger(user.id, "TON", -amountIn, "swap_buy",
            { tradeId: L.tradeId, tokenId, tokenSymbol: L.symbol, tokensOut: L.tokensOutFloat });
          writeLedger(user.id, L.symbol, L.tokensOutFloat, "swap_buy",
            { tradeId: L.tradeId, tokenId, tonIn: amountIn });
        }
      }

      const { _ledger: _l, ...publicResult } = result as any;
      res.json({ ok: true, ...publicResult });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get user's internal TON balance (used by App Token + Wallet pages).
  app.get("/telegram-mini-app/api/wallet/ton-balance", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const tonBalance = await appStoreService.getUserTonBalance(user.id);
      res.json({ tonBalance });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── TON Withdrawal (auto-sends from hot wallet to user's connected address) ──

  app.post("/telegram-mini-app/api/wallet/withdraw", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);

      const amountTon = Number(req.body?.amountTon);
      const tonAddress = String(req.body?.tonAddress || "").trim();

      if (!amountTon || amountTon <= 0) {
        res.status(400).json({ error: "invalid_amount" }); return;
      }
      if (amountTon < 0.01) {
        res.status(400).json({ error: "min_amount" }); return;
      }
      if (!tonAddress) {
        res.status(400).json({ error: "wallet_not_connected" }); return;
      }

      const currentBalance = await prisma.user.findUnique({
        where: { id: user.id },
        select: { tonBalance: true },
      });
      if (!currentBalance) { res.status(404).json({ error: "user_not_found" }); return; }

      const bal = Number(currentBalance.tonBalance);
      if (amountTon > bal) {
        res.status(400).json({ error: "insufficient_balance", balance: bal }); return;
      }

      // Deduct balance and create withdrawal record atomically
      const [withdrawal] = await prisma.$transaction([
        prisma.tonWithdrawal.create({
          data: {
            userId: user.id,
            amountTon: amountTon,
            tonAddress,
            status: "pending",
          },
        }),
        prisma.user.update({
          where: { id: user.id },
          data: { tonBalance: { decrement: amountTon } },
        }),
      ]);

      // Respond immediately so the user doesn't wait for blockchain confirmation
      res.json({ ok: true, withdrawalId: withdrawal.id });

      // Auto-send TON from hot wallet in the background
      setImmediate(async () => {
        try {
          const txHash = await sendTon(tonAddress, amountTon);

          await prisma.tonWithdrawal.update({
            where: { id: withdrawal.id },
            data: { status: "approved", txHash, processedAt: new Date() },
          });

          void writeLedger(user.id, "TON", -amountTon, "ton_withdrawal", {
            withdrawalId: withdrawal.id,
            tonAddress,
            txHash,
          });

          console.log(`[Wallet] Auto-withdrawal #${withdrawal.id} sent: ${amountTon} TON → ${tonAddress} | tx: ${txHash}`);
        } catch (err: any) {
          console.error(`[Wallet] Auto-withdrawal #${withdrawal.id} FAILED, refunding user:`, err.message);

          // Refund the user's balance and mark as failed
          await prisma.tonWithdrawal.update({
            where: { id: withdrawal.id },
            data: { status: "failed", adminNote: err.message, processedAt: new Date() },
          }).catch(() => {});

          await prisma.user.update({
            where: { id: user.id },
            data: { tonBalance: { increment: amountTon } },
          }).catch(() => {});

          void writeLedger(user.id, "TON", amountTon, "ton_withdrawal_refund", {
            withdrawalId: withdrawal.id,
            reason: err.message,
          });
        }
      });
    } catch (err: any) {
      console.error("[Wallet] withdraw error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/telegram-mini-app/api/wallet/withdrawals", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);

      const withdrawals = await prisma.tonWithdrawal.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 20,
      });
      res.json({ withdrawals });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── V2 Publish flow: user-signed Jetton deploy + LP init ───────────────
  //
  // After admin approval, the publisher signs TWO TonConnect transactions:
  //   1. /prepare-deploy → deploys their Jetton master + mints supply to themselves
  //   2. /prepare-lp-init → seeds the liquidity pool (TON + Jettons → vault)
  //
  // Both endpoints return TonConnect-compatible message arrays. The frontend
  // calls `tonConnectUI.sendTransaction({ messages, validUntil })`. The TON
  // monitor then confirms the on-chain landing and advances the listing
  // status (approved → deployed_pending_lp → published).

  app.post("/telegram-mini-app/api/store/listings/:listingId/prepare-deploy", async (req, res) => {
    try {
      const r = await requireListingOwner(req, res); if (!r.ok) return;
      const userWalletAddress = String(req.body?.userWalletAddress || "");
      if (!userWalletAddress) { res.status(400).json({ error: "userWalletAddress required" }); return; }
      const result = await appStoreService.preparePublishDeploy(req.params.listingId, { userWalletAddress });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/telegram-mini-app/api/store/listings/:listingId/prepare-lp-init", async (req, res) => {
    try {
      const r = await requireListingOwner(req, res); if (!r.ok) return;
      const userWalletAddress = String(req.body?.userWalletAddress || "");
      const tonAmount = Number(req.body?.tonAmount);
      const tokenShare = Number(req.body?.tokenShare);
      if (!userWalletAddress) { res.status(400).json({ error: "userWalletAddress required" }); return; }
      if (!Number.isFinite(tonAmount) || tonAmount <= 0) {
        res.status(400).json({ error: "tonAmount must be a positive number" }); return;
      }
      if (!Number.isFinite(tokenShare) || tokenShare <= 0) {
        res.status(400).json({ error: "tokenShare must be > 0" }); return;
      }
      const result = await appStoreService.preparePublishLpInit(req.params.listingId, {
        userWalletAddress, tonAmount, tokenShare,
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // ── Liquidity management ────────────────────────────────────────────────

  app.post("/telegram-mini-app/api/store/listings/:listingId/lp-add", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      await getOrCreateUserFromReq(req, auth);
      const userWalletAddress = String(req.body?.userWalletAddress || "");
      const tonAmount = Number(req.body?.tonAmount);
      if (!userWalletAddress) { res.status(400).json({ error: "userWalletAddress required" }); return; }
      if (!Number.isFinite(tonAmount) || tonAmount <= 0) {
        res.status(400).json({ error: "tonAmount must be a positive number" }); return;
      }
      const result = await appStoreService.prepareLpAdd(req.params.listingId, { userWalletAddress, tonAmount });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post("/telegram-mini-app/api/store/listings/:listingId/lp-remove-preview", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      await getOrCreateUserFromReq(req, auth);
      const userWalletAddress = String(req.body?.userWalletAddress || "");
      const fraction = Number(req.body?.fraction);
      const sharesToBurn = req.body?.sharesToBurn ? BigInt(String(req.body.sharesToBurn)) : undefined;
      if (!userWalletAddress) { res.status(400).json({ error: "userWalletAddress required" }); return; }
      const result = await appStoreService.previewLpRemove(req.params.listingId, {
        userWalletAddress,
        fraction: Number.isFinite(fraction) ? fraction : undefined,
        sharesToBurn,
      });
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  /**
   * Custodial LP remove. The user signed (via Telegram init data) a request
   * to burn `sharesToBurn` (or a `fraction` of their position). The backend's
   * hot wallet then dispatches the proportional TON + Jetton payouts. For
   * V1.5 we only dispatch TON automatically — the Jetton payout is queued
   * for admin review (future: jetton-tx-builder.payoutJetton from vault).
   */
  app.post("/telegram-mini-app/api/store/listings/:listingId/lp-remove", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      await getOrCreateUserFromReq(req, auth);
      const userWalletAddress = String(req.body?.userWalletAddress || "");
      const fraction = Number(req.body?.fraction);
      const sharesToBurn = req.body?.sharesToBurn ? BigInt(String(req.body.sharesToBurn)) : undefined;
      if (!userWalletAddress) { res.status(400).json({ error: "userWalletAddress required" }); return; }

      const preview = await appStoreService.previewLpRemove(req.params.listingId, {
        userWalletAddress,
        fraction: Number.isFinite(fraction) ? fraction : undefined,
        sharesToBurn,
      });

      const listing = await prisma.appListing.findUnique({
        where: { id: req.params.listingId },
        include: { token: true },
      });
      if (!listing?.token) { res.status(404).json({ error: "Listing/token not found" }); return; }

      // Burn shares + decrement reserves atomically.
      const result = await applyLiquidityRemove({
        tokenId: listing.token.id,
        ownerWalletAddress: userWalletAddress,
        sharesToBurn: BigInt(preview.sharesToBurn),
      });

      // Dispatch TON payout immediately. Jetton payout deferred to admin queue.
      let tonPayoutTxHash: string | null = null;
      try {
        const out = await payoutTon({
          to: userWalletAddress,
          amountNano: result.tonOutNano,
          comment: `lp_remove:${req.params.listingId}`,
        });
        tonPayoutTxHash = out.txHash;
      } catch (err: any) {
        console.error("[LP remove] TON payout failed:", err.message);
      }

      res.json({
        ok: true,
        sharesBurned: result.sharesBurned.toString(),
        tonOutNano: result.tonOutNano.toString(),
        tokensOut: result.tokensOut.toString(),
        tonPayoutTxHash,
        tokenPayoutPending: true,
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Create a pending trade row, returns wallet+comment for the TonConnect tx.
  app.post("/telegram-mini-app/api/store/tokens/:tokenId/buy", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);

      const amount = String(req.body?.tonAmount || "");
      if (!amount.match(/^\d+(\.\d+)?$/)) {
        res.status(400).json({ error: "tonAmount must be a positive number" }); return;
      }
      const tonInNano = tonToNano(amount);

      const token = await prisma.appToken.findUnique({ where: { id: req.params.tokenId } });
      if (!token) { res.status(404).json({ error: "Token not found" }); return; }
      if (token.status !== "live") { res.status(400).json({ error: "Token not live" }); return; }

      const trade = await prisma.tokenTrade.create({
        data: {
          tokenId: token.id,
          userId: user.id,
          type: "buy",
          tonAmount: tonInNano,
          tokenAmount: 0n,
          priceNanoTon: 0n,
          feeTonAmount: 0n,
          status: "pending_payment",
        },
      });

      res.json({
        tradeId: trade.id,
        walletAddress: appStoreService.platformWalletAddress(),
        comment: `buy:${trade.id}`,
        tonAmount: amount,
        expiresInSec: 600,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Sells: user-initiated. Creates a pending trade with the requested
  // tokensIn so the monitor matches the jetton-transfer notification.
  app.post("/telegram-mini-app/api/store/tokens/:tokenId/sell", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);

      const amount = String(req.body?.tokenAmount || "");
      if (!amount.match(/^\d+(\.\d+)?$/)) {
        res.status(400).json({ error: "tokenAmount must be a positive number" }); return;
      }

      const token = await prisma.appToken.findUnique({ where: { id: req.params.tokenId } });
      if (!token) { res.status(404).json({ error: "Token not found" }); return; }
      if (token.status !== "live") { res.status(400).json({ error: "Token not live" }); return; }

      const tokensInAtomic = tonToNano(amount); // 9 decimals same as nanoTON

      // Verify the user has the balance.
      const holding = await prisma.tokenHolding.findUnique({
        where: { tokenId_userId: { tokenId: token.id, userId: user.id } },
      });
      if (!holding || holding.balance < tokensInAtomic) {
        res.status(400).json({ error: "Insufficient holding" }); return;
      }

      const trade = await prisma.tokenTrade.create({
        data: {
          tokenId: token.id,
          userId: user.id,
          type: "sell",
          tonAmount: 0n,
          tokenAmount: tokensInAtomic,
          priceNanoTon: 0n,
          feeTonAmount: 0n,
          status: "pending_payment",
        },
      });

      res.json({
        tradeId: trade.id,
        walletAddress: appStoreService.platformWalletAddress(),
        comment: `sell:${trade.id}`,
        jettonMasterAddress: token.jettonMasterAddress,
        tokenAmount: amount,
        expiresInSec: 600,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Trade status (UI polls this after sending TonConnect tx).
  app.get("/telegram-mini-app/api/store/trades/:tradeId", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const trade = await prisma.tokenTrade.findUnique({ where: { id: req.params.tradeId } });
      if (!trade || trade.userId !== user.id) {
        res.status(404).json({ error: "Not found" }); return;
      }
      res.json({
        id: trade.id,
        type: trade.type,
        status: trade.status,
        tonAmount: Number(trade.tonAmount) / 1e9,
        tokenAmount: Number(trade.tokenAmount) / 1e9,
        priceTon: Number(trade.priceNanoTon) / 1e9,
        txHashIn: trade.txHashIn,
        txHashOut: trade.txHashOut,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Listing status (UI polls after sending publish-fee tx).
  app.get("/telegram-mini-app/api/store/listings/:listingId/status", async (req, res) => {
    try {
      const r = await requireListingOwner(req, res); if (!r.ok) return;
      res.json({ status: r.listing.status });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Owner can re-fetch their own draft (with token sub-row).
  app.get("/telegram-mini-app/api/store/listings/:listingId", async (req, res) => {
    try {
      const r = await requireListingOwner(req, res); if (!r.ok) return;
      const listing = await appStoreService.getListing(req.params.listingId);
      res.json({ listing });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // User portfolio (everything they hold).
  app.get("/telegram-mini-app/api/store/portfolio", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const items = await appStoreService.getPortfolio(user.id);
      res.json({ items });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Admin App Store endpoints live in admin.routes.ts (under /admin/api/*)
  // because the browser admin dashboard uses bearer-token auth, not Telegram
  // init data.

  // ── Unlink Bot ──

  // ── Revoke / replace bot token via Telegram's replaceManagedBotToken ──
  app.post("/telegram-mini-app/api/projects/:projectId/revoke-bot-token", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) {
        res.status(403).json({ error: "Forbidden" }); return;
      }
      if (!project.botTokenEncrypted) {
        res.status(400).json({ error: "No existing bot token" }); return;
      }
      if (!project.botUserId) {
        res.status(400).json({ error: "Bot user ID not found — cannot revoke via managed API" }); return;
      }

      // Call Telegram's replaceManagedBotToken using the platform's own token
      const replaceRes = await fetch(`https://api.telegram.org/bot${config.botToken}/replaceManagedBotToken`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: Number(project.botUserId) }),
      });
      const replaceData = await replaceRes.json() as any;
      if (!replaceData.ok) {
        res.status(400).json({ error: "Telegram error: " + (replaceData.description || "replaceManagedBotToken failed") }); return;
      }
      const newToken = replaceData.result as string;

      // Stop the old bot runner so it releases the old webhook
      try {
        const { botRunnerService } = await import("../services/bot-runner.service");
        await botRunnerService.stopBot(projectId);
      } catch {}

      // Give Telegram ~1s to activate the new token before setting the webhook
      await new Promise(r => setTimeout(r, 1000));

      // Save the new encrypted token (keep same botUsername / botUserId)
      await prisma.project.update({
        where: { id: projectId },
        data: { botTokenEncrypted: encryptToken(newToken) },
      });

      // Re-start the bot runner with the new token (sets webhook automatically in production)
      try {
        const { botRunnerService } = await import("../services/bot-runner.service");
        await botRunnerService.startBot(projectId, newToken, project.botUsername!);
      } catch (err: any) {
        console.error("[revoke-bot-token] re-start error:", err?.message || err);
        // Non-fatal — token is already saved
      }

      res.json({ ok: true, botUsername: project.botUsername });
    } catch (err: any) {
      console.error("[MiniApp API] Revoke bot token error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/projects/:projectId/unlink-bot", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) {
        res.status(403).json({ error: "Forbidden" }); return;
      }

      try {
        const { botRunnerService } = await import("../services/bot-runner.service");
        await botRunnerService.stopBot(projectId);
      } catch {}

      await projectService.unlinkBot(projectId);

      res.json({ ok: true });
    } catch (err) {
      console.error("[MiniApp API] Unlink bot error:", err);
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
    const projectId = String(req.params.projectId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
      res.status(400).end(); return;
    }
    const avatarPath = path.join(process.cwd(), "projects", projectId, "avatar.jpg");
    if (fs.existsSync(avatarPath)) {
      res.sendFile(avatarPath);
    } else {
      res.status(404).end();
    }
  });

  // ── AI Avatar generation (Edit Info → "Generate Avatar with AI") ──
  // Two-step UX:
  //   1. POST /generate-avatar → returns { imageUrl } (charges $0.10).
  //   2. POST /apply-avatar    → uploads the chosen URL to Telegram as the
  //      bot's profile photo. Split so the user can confirm before replacing.
  const AVATAR_GEN_PRICE_CREDITS = 10;

  app.post("/telegram-mini-app/api/projects/:projectId/generate-avatar", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }

      const userCredits = await billingService.getUserCredits(user.id);
      if (userCredits < AVATAR_GEN_PRICE_CREDITS) {
        res.status(402).json({ error: "insufficient_balance", required: AVATAR_GEN_PRICE_CREDITS, balance: userCredits });
        return;
      }

      const { generateAvatarUrl } = await import("../services/avatar-generator.service");
      const { imageUrl, prompt } = await generateAvatarUrl(
        project.description || project.name || "",
        project.name || undefined,
      );

      // Charge only on success — failures (timeout/upstream error) stay free
      const result = await prisma.$transaction(async (tx) => {
        await tx.usageLog.create({
          data: {
            userId: user.id,
            projectId,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: new Decimal("0"),
            operation: "avatar_generation",
          },
        });
        const updated = await tx.user.update({
          where: { id: user.id },
          data: { credits: { decrement: AVATAR_GEN_PRICE_CREDITS } },
        });
        return { newCredits: updated.credits };
      });

      void trackEvent(auth.telegramId!, "avatar_generated", {
        project_id: projectId,
        cost_credits: AVATAR_GEN_PRICE_CREDITS,
      });

      res.json({
        imageUrl,
        prompt,
        cost: AVATAR_GEN_PRICE_CREDITS,
        newBalance: result.newCredits,
      });
    } catch (err: any) {
      console.error("[MiniApp API] Avatar generation error:", err);
      const msg = err?.message || "generation_failed";
      res.status(500).json({ error: msg });
    }
  });

  app.post("/telegram-mini-app/api/projects/:projectId/apply-avatar", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      if (!project.botTokenEncrypted) {
        res.status(400).json({ error: "no_bot" });
        return;
      }

      const { imageUrl } = req.body as { imageUrl?: string };
      if (!imageUrl || typeof imageUrl !== "string") {
        res.status(400).json({ error: "imageUrl required" });
        return;
      }
      // Only allow URLs from our known image provider — guards against using
      // this endpoint as an arbitrary fetch proxy.
      if (!/^https:\/\/cdn\.apipass\.dev\//i.test(imageUrl)) {
        res.status(400).json({ error: "invalid_image_source" });
        return;
      }

      const token = decryptToken(project.botTokenEncrypted);

      const imgRes = await fetch(imageUrl);
      if (!imgRes.ok) {
        res.status(502).json({ error: `image_fetch_failed_${imgRes.status}` });
        return;
      }
      const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
      const blob = new Blob([imgBuffer], { type: "image/jpeg" });

      const formData = new (globalThis as any).FormData();
      formData.set("photo", JSON.stringify({ type: "static", photo: "attach://photo_file" }));
      formData.set("photo_file", blob, "avatar.jpg");

      const tgRes = await fetch(`https://api.telegram.org/bot${token}/setMyProfilePhoto`, {
        method: "POST",
        body: formData,
      });
      const tgData = (await tgRes.json()) as any;
      if (!tgData.ok) {
        res.status(502).json({ error: tgData.description || "telegram_set_photo_failed" });
        return;
      }

      avatarCache.delete(projectId);
      res.json({ ok: true });
    } catch (err: any) {
      console.error("[MiniApp API] Apply avatar error:", err);
      res.status(500).json({ error: err?.message || "Internal server error" });
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

      const { getProjectFeatures, PAID_FEATURES, getBundleQuote } = await import("../services/features.service");
      const owned = await getProjectFeatures(projectId);
      const balance = await billingService.getUserCredits(user.id);

      const features = PAID_FEATURES.map(f => ({
        id: f.id,
        label: f.label,
        price: f.price,
        creditsPrice: f.creditsPrice,
        description: f.description,
        owned: owned.includes(f.id),
      }));

      const quote = getBundleQuote(owned);
      const bundle = {
        id: "bundle_all",
        price: quote.bundlePrice,
        fullPrice: quote.fullPrice,
        creditsPrice: quote.bundleCreditsPrice,
        fullCreditsPrice: quote.fullCreditsPrice,
        saveCredits: quote.saveCredits,
        featureIds: quote.missingIds,
        available: quote.available,
      };

      res.json({ features, balance, bundle });
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

      const { featureId, payWith = "credits" } = req.body;
      if (!featureId) { res.status(400).json({ error: "featureId required" }); return; }

      const { purchaseFeature, getFeatureById } = await import("../services/features.service");
      const feature = getFeatureById(featureId);
      if (!feature) { res.status(400).json({ error: "Unknown feature" }); return; }

      const { newBalance, newCredits } = await purchaseFeature(user.id, projectId, featureId, payWith as "credits" | "balance");

      void trackEvent(auth.telegramId!, "purchase", {
        type: "feature",
        feature_id: featureId,
        feature_label: feature.label,
        amount: feature.price,
        project_id: projectId,
      });

      res.json({ success: true, newBalance, newCredits, featureId });
    } catch (err: any) {
      console.error("[MiniApp API] Feature purchase error:", err);
      res.status(400).json({ error: err.message || "Purchase failed" });
    }
  });

  app.post("/telegram-mini-app/api/features/:projectId/buy-bundle", async (req, res) => {
    try {
      const auth = validateAuth(req);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const { user } = await getOrCreateUserFromReq(req, auth);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || (project.userId !== user.id && !isAdminTelegramId(auth.telegramId))) { res.status(403).json({ error: "Forbidden" }); return; }

      const { purchaseBundle } = await import("../services/features.service");
      const { payWith = "credits" } = req.body;
      const { newBalance, newCredits, granted, charged } = await purchaseBundle(user.id, projectId, payWith as "credits" | "balance");

      void trackEvent(auth.telegramId!, "purchase", {
        type: "bundle",
        feature_id: "bundle_all",
        feature_label: "All-Access Bundle",
        amount: charged,
        granted_features: granted,
        project_id: projectId,
      });

      res.json({ success: true, newBalance, newCredits, granted, charged });
    } catch (err: any) {
      console.error("[MiniApp API] Bundle purchase error:", err);
      res.status(400).json({ error: err.message || "Purchase failed" });
    }
  });

  // Speech-to-text: accepts a single audio blob from the chat input mic
  // button, forwards it to ElevenLabs Scribe v2 via the official SDK, returns
  // the recognised text. The client autofills the chat input with the result
  // (no auto-send).
  //
  // We use the official SDK rather than hand-rolling fetch+FormData because
  // native Node FormData + Blob serialization has subtle edge cases (filename
  // headers, chunked-transfer length headers) that can cause the upstream to
  // reject the request silently — manifesting as a Cloudflare 502 with no
  // error in our logs. The SDK normalizes all of that.
  app.post(
    "/telegram-mini-app/api/transcribe",
    upload.single("audio"),
    async (req, res) => {
      const startedAt = Date.now();
      const file = (req as any).file as Express.Multer.File | undefined;
      const cleanup = () => {
        if (file?.path) {
          try { fs.unlinkSync(file.path); } catch {}
        }
      };
      try {
        const auth = validateAuth(req);
        if (!auth.valid) { cleanup(); res.status(401).json({ error: "Unauthorized" }); return; }

        if (!file) { res.status(400).json({ error: "No audio uploaded" }); return; }
        if (file.size === 0) { cleanup(); res.status(400).json({ error: "Empty audio" }); return; }

        if (!config.elevenLabsApiKey) {
          cleanup();
          console.error("[Transcribe] ELEVENLABS_API_KEY is not set");
          res.status(503).json({ error: "Speech-to-text not configured on server" });
          return;
        }

        const buffer = fs.readFileSync(file.path);
        cleanup();

        const languageCode = typeof req.body?.languageCode === "string" && req.body.languageCode
          ? req.body.languageCode
          : undefined;

        // SDK accepts a Blob as the file argument — same shape as the example
        // in the docs ( new Blob([await response.arrayBuffer()], { type: ... }) ).
        const blob = new Blob([new Uint8Array(buffer)], {
          type: file.mimetype || "audio/webm",
        });

        const elevenlabs = new ElevenLabsClient({ apiKey: config.elevenLabsApiKey });

        const transcription = await elevenlabs.speechToText.convert({
          file: blob,
          modelId: "scribe_v2",
          tagAudioEvents: false,
          diarize: false,
          ...(languageCode ? { languageCode } : {}),
        });

        const text = ((transcription as any)?.text || "").trim();
        const detectedLang = (transcription as any)?.languageCode || (transcription as any)?.language_code || null;
        const ms = Date.now() - startedAt;
        console.log(`[Transcribe] OK ${file.size}b -> ${text.length} chars in ${ms}ms (lang=${detectedLang})`);

        res.json({ text, languageCode: detectedLang });
      } catch (err: any) {
        cleanup();
        const status = err?.statusCode || err?.status || 0;
        const upstreamBody = err?.body || err?.rawResponse || err?.message || String(err);
        console.error(
          `[Transcribe] Failed (status=${status}, file=${file?.size}b, mime=${file?.mimetype}):`,
          typeof upstreamBody === "string" ? upstreamBody.slice(0, 800) : upstreamBody,
        );
        if (!res.headersSent) {
          res.status(502).json({
            error: "Speech-to-text failed",
            upstreamStatus: status || undefined,
          });
        }
      }
    },
  );

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
        // Use only the basename and strip any path separators; generate a
        // safe name by prefixing with a random UUID to prevent overwrites
        // and path-traversal via crafted originalname values.
        const safeExt = path.extname(path.basename(f.originalname)).replace(/[^a-zA-Z0-9.]/g, "").slice(0, 12);
        const safeName = crypto.randomUUID() + (safeExt ? safeExt : "");
        const dest = path.join(assetsDir, safeName);
        // Verify the resolved destination stays inside assetsDir
        if (!dest.startsWith(assetsDir + path.sep) && dest !== assetsDir) {
          throw new Error("Invalid file path");
        }
        fs.renameSync(f.path, dest);
        return { name: f.originalname, path: dest, safeName, type: f.mimetype };
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
      const parseIso = (raw: unknown): Date | null => {
        if (typeof raw !== "string" || !raw) return null;
        const d = new Date(raw);
        return isNaN(d.getTime()) ? null : d;
      };
      const fromDate = parseIso(req.query.from);
      const toDate = parseIso(req.query.to);

      const mainToken = config.botToken;
      const resolveAvatar = mainToken
        ? (async (telegramId: string): Promise<string | null> => {
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
          })
        : undefined;

      const result = await adminQueries.getSourcesStats({ from: fromDate, to: toDate, resolveAvatar });
      res.json(result);
    } catch (err: any) {
      console.error("[Admin] Sources stats error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  /* LEGACY_SOURCES_BLOCK_START
      //
      // Funnel reflects the new "create-project-first" flow (project is
      // created BEFORE the bot is linked):
      //   has_app   — user has any project at all (was "has_bot" before).
      //   has_plan  — at least one project has a plan generated.
      //   has_built — at least one project finished a build (deployed/released).
      //
      // Old name "has_bot" no longer makes sense for the funnel because most
      // projects start botless and only get a bot after the first build.
      const userAgg = await prisma.$queryRawUnsafe<Array<{
        id: number;
        utm_source: string | null;
        referred_by: bigint | null;
        has_app: boolean;
        has_plan: boolean;
        has_built: boolean;
        revenue: any;
      }>>(`
        SELECT
          u.id,
          NULLIF(u.utm_source, '') AS utm_source,
          u.referred_by,
          EXISTS (
            SELECT 1 FROM projects p
            WHERE p.user_id = u.id
          ) AS has_app,
          EXISTS (
            SELECT 1 FROM projects p
            WHERE p.user_id = u.id AND p.plan IS NOT NULL
          ) AS has_plan,
          EXISTS (
            SELECT 1 FROM projects p
            WHERE p.user_id = u.id AND p.status IN ('deployed', 'released')
          ) AS has_built,
          COALESCE((
            SELECT SUM(pm.amount_usd) FROM payments pm
            WHERE pm.user_id = u.id AND pm.status = 'confirmed'
          ), 0) AS revenue
        FROM users u
        WHERE ($1::timestamptz IS NULL OR u.created_at >= $1::timestamptz)
          AND ($2::timestamptz IS NULL OR u.created_at <  $2::timestamptz)
      `, fromDate, toDate);

      type Metrics = {
        users: number; createdApp: number; createdPlan: number; builtApp: number;
        payingUsers: number; revenue: number;
      };
      const emptyMetrics = (): Metrics => ({
        users: 0, createdApp: 0, createdPlan: 0, builtApp: 0, payingUsers: 0, revenue: 0,
      });
      const addUser = (m: Metrics, r: (typeof userAgg)[number]) => {
        m.users++;
        if (r.has_app) m.createdApp++;
        if (r.has_plan) m.createdPlan++;
        if (r.has_built) m.builtApp++;
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
  LEGACY_SOURCES_BLOCK_END */

  // List of users that registered in the given date range AND match a
  // specific bucket from the Sources screen.
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
      const kind = String(req.query.kind || "all") as any;
      const key = typeof req.query.key === "string" ? req.query.key : "";

      const result = await adminQueries.listSourceUsers({ from: fromDate, to: toDate, kind, key });
      res.json(result);
    } catch (err: any) {
      console.error("[Admin] Sources users error:", err);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  /* LEGACY_SOURCES_USERS_BLOCK_START
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
      // drill-down feels consistent with the parent card). Same renaming as
      // /stats/sources: hasApp = "has any project", hasBuilt = "deployed/released".
      const userIds = users.map(u => u.id);
      let funnels = new Map<number, { hasApp: boolean; hasPlan: boolean; hasBuilt: boolean; revenue: number }>();
      if (userIds.length > 0) {
        const rows = await prisma.$queryRawUnsafe<Array<{
          id: number; has_app: boolean; has_plan: boolean; has_built: boolean; revenue: any;
        }>>(`
          SELECT
            u.id,
            EXISTS (SELECT 1 FROM projects p WHERE p.user_id = u.id)                                AS has_app,
            EXISTS (SELECT 1 FROM projects p WHERE p.user_id = u.id AND p.plan IS NOT NULL)        AS has_plan,
            EXISTS (SELECT 1 FROM projects p WHERE p.user_id = u.id AND p.status IN ('deployed','released')) AS has_built,
            COALESCE((SELECT SUM(pm.amount_usd) FROM payments pm WHERE pm.user_id = u.id AND pm.status = 'confirmed'), 0) AS revenue
          FROM users u
          WHERE u.id = ANY($1::int[])
        `, userIds);
        for (const r of rows) {
          funnels.set(r.id, {
            hasApp: r.has_app, hasPlan: r.has_plan, hasBuilt: r.has_built,
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
            hasApp: f?.hasApp ?? false,
            hasPlan: f?.hasPlan ?? false,
            hasBuilt: f?.hasBuilt ?? false,
            revenue: f?.revenue ?? 0,
          };
        }),
      });
  LEGACY_SOURCES_USERS_BLOCK_END */

  // ─── User admin endpoints (Mini-App admin) ─────────────────────────────
  // Backed by src/services/admin-queries.service.ts so the legacy mini-app
  // admin and the new browser CRM (/admin/api/users/*) share identical logic.

  app.get("/telegram-mini-app/api/admin/users", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const result = await adminQueries.listUsers({
        q:        typeof req.query.q === "string" ? req.query.q : undefined,
        filter:   req.query.filter as any,
        sort:     req.query.sort   as any,
        page:     req.query.page     ? parseInt(String(req.query.page),     10) : undefined,
        // Mini-App admin doesn't paginate — return everything in one page.
        pageSize: req.query.pageSize ? parseInt(String(req.query.pageSize), 10) : 5000,
      });
      // Backward compat: the existing mini_app/app.js consumes a flat array.
      res.json(result.users);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.get("/telegram-mini-app/api/admin/users/:id", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const userId = parseInt(req.params.id, 10);
      const user = await adminQueries.getUserDetail(userId);
      if (!user) { res.status(404).json({ error: "User not found" }); return; }
      res.json(user);
    } catch (err: any) { res.status(500).json({ error: err.message }); }
  });

  app.post("/telegram-mini-app/api/admin/users/:id/partner", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const userId = parseInt(req.params.id, 10);
      const result = await adminQueries.updateUserPartner(userId, req.body || {});
      res.json(result);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  app.post("/telegram-mini-app/api/admin/users/:id/balance", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const userId = parseInt(req.params.id, 10);
      const action = req.body?.action;
      const amount = parseFloat(req.body?.amount);
      if (action !== "set" && action !== "add") {
        res.status(400).json({ error: "action must be 'set' or 'add'" }); return;
      }
      const result = await adminQueries.setUserBalance(userId, action, amount);
      res.json(result);
    } catch (err: any) { res.status(400).json({ error: err.message }); }
  });

  // Wipe user-attached data (payments, conversations, usage logs, withdrawals,
  // voucher redemptions) and reset user profile fields to defaults — but KEEP
  // the User row and KEEP all Projects (apps continue to function under the
  // anonymized user). Backed by adminQueries.wipeUserData so the new CRM and
  // the Mini App both share the exact same transaction.
  app.delete("/telegram-mini-app/api/admin/users/:id/data", async (req, res) => {
    if (!adminGuard(req, res)) return;
    try {
      const userId = parseInt(req.params.id, 10);
      const deleted = await adminQueries.wipeUserData(userId);
      console.log(`[Admin] Wiped data for user ${userId}:`, deleted);
      res.json({ ok: true, deleted });
    } catch (err: any) {
      console.error("[Admin] Wipe user data error:", err);
      res.status(err.status || 500).json({ error: err.message });
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
      const userId = parseInt(req.params.id, 10);
      const deleted = await adminQueries.fullResetUser(userId);
      console.log(`[Admin] FULL RESET for user ${userId}:`, deleted);
      res.json({ ok: true, deleted });
    } catch (err: any) {
      console.error("[Admin] Full reset error:", err);
      res.status(err.status || 500).json({ error: err.message });
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

  // ── Telegram deep-link redirect ──────────────────────────────────────────
  // GET /redirect/create?startapp=<param>
  //   → 302 Location: tg://resolve?domain=apps_father_bot&appname=app&startapp=<param>
  //   + <meta http-equiv="refresh"> fallback for browsers that don't honour 302
  //     to a non-http scheme.
  //
  // The route is intentionally unauthenticated — it's meant to be the
  // landing target for ad campaigns, QR codes, and short links where the
  // user isn't yet in a Telegram context.
  app.get("/redirect/create", (req, res) => {
    const BOT  = config.domain.startsWith("dev.") ? "apps_father_dev_bot" : "apps_father_bot";
    const APP  = "app";

    // Sanitise: Telegram only accepts A-Z a-z 0-9 _ - (max 64 chars) for startapp.
    const raw = typeof req.query.startapp === "string" ? req.query.startapp : "";
    const sa  = raw.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);

    const tgUrl = sa
      ? `tg://resolve?domain=${BOT}&appname=${APP}&startapp=${encodeURIComponent(sa)}`
      : `tg://resolve?domain=${BOT}&appname=${APP}`;

    const displayUrl = tgUrl.replace(/&/g, "&amp;");

    res.setHeader("Cache-Control", "no-cache, private");
    res.setHeader("Location", tgUrl);
    res.status(302).send(
      `<!DOCTYPE html>\n` +
      `<html>\n` +
      `<head>\n` +
      `  <meta charset="UTF-8" />\n` +
      `  <meta http-equiv="refresh" content="0;url='${displayUrl}'" />\n` +
      `  <title>Redirecting to Apps Father</title>\n` +
      `</head>\n` +
      `<body>\n` +
      `  Redirecting to <a href="${displayUrl}">${displayUrl}</a>.\n` +
      `</body>\n` +
      `</html>`,
    );
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
  app.use("/bucket", bucketRoutes);
  app.use("/dev", devRoutes);
  // App Store routes MUST be mounted before /api — apiRoutes is a user-project
  // catch-all that returns "No backend routes configured for this project" for
  // anything it doesn't recognise, which would shadow /api/store/*.
  app.use("/api/store", appStoreRoutes);

  // ── Runner proxy (worker / docker modes) ────────────────────────────────
  // When RUNTIME_MODE=worker or RUNTIME_MODE=docker, /app/:id/api/*,
  // /dev/:id/api/*, /api/:id/*, and /devapi/:id/* are proxied into the
  // per-project worker (process or container). The legacy in-process
  // api/devapi routers are skipped.
  if (config.isWorkerRuntime) {
    app.use(createRunnerProxyRouter());
    console.log(`[Runtime] ${config.runtimeMode} mode active — user routes execute in per-project workers`);
  } else {
    app.use("/api", apiRoutes);
    app.use("/devapi", devApiRoutes);
  }

  app.use("/webhook", webhookRoutes);
  app.use("/admin", adminRoutes);
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

