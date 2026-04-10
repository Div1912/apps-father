import http from "http";
import express from "express";
import path from "path";
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
