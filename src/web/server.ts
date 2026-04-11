import http from "http";
import express from "express";
import path from "path";
import crypto from "crypto";
import { config } from "../config";
import appRoutes from "./routes/app.routes";
import apiRoutes from "./routes/api.routes";
import devRoutes from "./routes/dev.routes";
import devApiRoutes from "./routes/devapi.routes";
import webhookRoutes from "./routes/webhook.routes";
import adminRoutes from "./routes/admin.routes";
import editorRoutes from "./routes/editor.routes";
import logsRoutes from "./routes/logs.routes";
import billingRoutes from "./routes/billing.routes";
import { setupWebSocket } from "./ws-manager";
import { projectService } from "../services/project.service";
import { decryptToken } from "../services/crypto.service";
import { billingService } from "../services/billing.service";

let expressApp: express.Application | null = null;
let httpServer: http.Server | null = null;

export function createWebServer() {
  const app = express();

  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  app.use("/assets", express.static(path.join(__dirname, "..", "assets")));

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

  app.get("/telegram-mini-app/api/projects", async (req, res) => {
    try {
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }

      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const projects = await projectService.getProjectsByUser(user.id);

      const result = projects.map((p: any) => ({
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
      }));

      res.json(result);
    } catch (err) {
      console.error("[MiniApp API] Error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.get("/telegram-mini-app/api/token/:projectId", async (req, res) => {
    try {
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }

      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const project = await projectService.getProject(req.params.projectId);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }
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
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const balance = await billingService.getUserBalance(user.id);
      res.json({ balance });
    } catch (err) {
      console.error("[MiniApp API] Balance error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

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

  setupWebSocket(server);

  return new Promise<void>((resolve) => {
    server.listen(config.port, () => {
      console.log(`[Web] Server running on port ${config.port}`);
      console.log(`[Web] Base URL: ${config.baseUrl}`);
      resolve();
    });
  });
}
