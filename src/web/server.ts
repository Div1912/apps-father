import http from "http";
import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import multer from "multer";
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
import { setupMiniAppWebSocket } from "./miniapp-ws";
import { broadcastToProject, registerAnswerResolver, resolveAnswer } from "./miniapp-ws";
import { projectService } from "../services/project.service";
import { decryptToken } from "../services/crypto.service";
import { billingService } from "../services/billing.service";
import { chatService, ChatMessage } from "../services/chat.service";
import { agentService, AgentProgress } from "../services/agent.service";
import { processingProjects } from "../bot/processing";
import { commitService } from "../services/commit.service";
import { publishReport } from "../services/telegraph.service";
import { claudeService } from "../services/claude.service";

let expressApp: express.Application | null = null;
let httpServer: http.Server | null = null;
const avatarCache = new Map<string, string>();

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

  app.post("/telegram-mini-app/api/buy-slot", async (req, res) => {
    try {
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const result = await projectService.buySlot(user.id);
      res.json({ ok: true, newSlots: result.newSlots, newBalance: result.newBalance });
    } catch (err: any) {
      console.error("[MiniApp API] Buy slot error:", err);
      res.status(400).json({ error: err.message || "Failed to buy slot" });
    }
  });

  app.post("/telegram-mini-app/api/topup", async (req, res) => {
    try {
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const { amount, method } = req.body;
      const amountUsd = parseFloat(amount);
      if (isNaN(amountUsd) || amountUsd < 10) {
        res.status(400).json({ error: "Minimum top-up is $10" });
        return;
      }

      let invoiceUrl: string;
      if (method === "cryptobot") {
        const result = await billingService.createCryptoBotInvoice(user.id, amountUsd);
        invoiceUrl = result.invoiceUrl;
      } else if (method === "stars") {
        const STAR_RATE = 0.013;
        const rawStars = Math.ceil(amountUsd / STAR_RATE);
        const stars = Math.floor(rawStars / 10) * 10;
        const result = await billingService.createStarsInvoice(user.id, amountUsd, stars);
        invoiceUrl = result.invoiceUrl;
      } else {
        const result = await billingService.createTopUp(user.id, amountUsd);
        invoiceUrl = result.invoiceUrl;
      }

      res.json({ ok: true, invoiceUrl });
    } catch (err: any) {
      console.error("[MiniApp API] Topup error:", err);
      res.status(400).json({ error: err.message || "Failed to create payment" });
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

  // ── Chat API ──
  const upload = multer({ dest: path.join(process.cwd(), "tmp_uploads"), limits: { fileSize: 10 * 1024 * 1024 } });

  app.get("/telegram-mini-app/api/chat/:projectId", async (req, res) => {
    try {
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const project = await projectService.getProject(req.params.projectId);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

      const before = req.query.before ? parseInt(req.query.before as string) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit as string) : 50;
      const messages = chatService.getHistory(req.params.projectId, before, limit);
      res.json({ messages });
    } catch (err) {
      console.error("[Chat API] History error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/chat/:projectId/send", async (req, res) => {
    try {
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const project = await projectService.getProject(req.params.projectId);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

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
          const errMsg = chatService.addMessage(projectId, { role: "system", type: "error", content: "Another process is already running for this app." });
          broadcastToProject(projectId, { type: "message", message: errMsg });
          res.json({ messageId: userMsg.id, status: "error", error: "already_processing" });
          return;
        }

        const balance = await billingService.getUserBalance(user.id);
        if (balance < 5) {
          const errMsg = chatService.addMessage(projectId, { role: "system", type: "balance_error", content: `Insufficient balance ($${balance.toFixed(2)}). Minimum $5.00 required for updates.`, metadata: { balance } });
          broadcastToProject(projectId, { type: "message", message: errMsg });
          res.json({ messageId: userMsg.id, status: "error", error: "insufficient_balance" });
          return;
        }

        res.json({ messageId: userMsg.id, status: "processing" });

        // Run agent in background
        (async () => {
          processingProjects.add(projectId);
          let progressMsgId: string | null = null;
          let checklistItems: string[] = [];
          let items: { id: number; text: string; done: boolean }[] = [];

          try {
            checklistItems = await agentService.generateChecklist(text.trim());
          } catch {}
          items = checklistItems.map((t, i) => ({ id: i + 1, text: t, done: false }));

          const progressMsg = chatService.addMessage(projectId, {
            role: "assistant",
            type: "progress",
            content: "Starting...",
            checklist: items.length > 0 ? items : undefined,
            percent: 0,
          });
          progressMsgId = progressMsg.id;
          broadcastToProject(projectId, { type: "message", message: progressMsg });

          try {
            await projectService.updateProjectStatus(projectId, "building");
            const currentBalance = await billingService.getUserBalance(user.id);

            const onProgress = async (p: AgentProgress) => {
              if (!progressMsgId) return;
              const updated = chatService.updateMessage(projectId, progressMsgId, {
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
                  const ansMsg = chatService.addMessage(projectId, { role: "user", type: "answer", content: answer });
                  broadcastToProject(projectId, { type: "message", message: ansMsg });
                  resolve(answer);
                });
              });
            };

            const onCheckTodo = items.length > 0 ? async (id: number) => {
              if (id >= 1 && id <= items.length) {
                items[id - 1].done = true;
                if (progressMsgId) {
                  chatService.updateMessage(projectId, progressMsgId, { checklist: items });
                  broadcastToProject(projectId, {
                    type: "progress",
                    projectId,
                    messageId: progressMsgId,
                    checklist: items,
                  });
                }
              }
            } : undefined;

            const attachments = userMsg.attachments?.map((a: any) => ({
              localPath: a.path,
              projectPath: `frontend/assets/${a.name}`,
              originalName: a.name,
            }));

            const result = await agentService.updateApp(
              projectId, text.trim(), onProgress, attachments,
              onAskUser, items.length > 0 ? checklistItems : undefined,
              onCheckTodo, undefined, currentBalance,
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

            if (progressMsgId) {
              broadcastToProject(projectId, {
                type: "progress", projectId, messageId: progressMsgId,
                percent: 100, message: "Summarizing changes...",
                checklist: items, costUsd: usage.costUsd, balance: usage.newBalance,
              });
              chatService.updateMessage(projectId, progressMsgId, {
                percent: 100, content: "Summarizing changes...",
                checklist: items, costUsd: usage.costUsd, balance: usage.newBalance,
              });
            }

            const history = chatService.getHistory(projectId, undefined, 1000);
            const updateNum = history.filter(m => m.type === "result").length + 1;
            const project = await projectService.getProject(projectId);
            const appName = project?.name || "App";

            const [shortSummary, changelogUrl] = await Promise.all([
              agentService.summarizeShort(result.summary, updateNum),
              publishReport(`${appName} — Update #${updateNum}`, result.summary, `Cost: $${usage.costUsd.toFixed(4)}`).catch(() => null),
            ]);

            if (progressMsgId) {
              chatService.updateMessage(projectId, progressMsgId, {
                type: "result",
                content: shortSummary,
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
              summary: shortSummary,
              changelogUrl,
              costUsd: usage.costUsd,
              balance: usage.newBalance,
            });

          } catch (err: any) {
            console.error("[Chat API] Agent error:", err);
            await projectService.updateProjectStatus(projectId, "error");
            const errMsg = chatService.addMessage(projectId, {
              role: "assistant",
              type: "error",
              content: `Update failed: ${err.message || "Unknown error"}`,
            });
            broadcastToProject(projectId, { type: "message", message: errMsg });
          } finally {
            processingProjects.delete(projectId);
          }
        })();

        return;
      }

      if (msgType === "question") {
        const streamMsgId = crypto.randomBytes(8).toString("hex");
        res.json({ messageId: userMsg.id, streamMsgId, status: "processing" });

        broadcastToProject(projectId, { type: "stream_start", projectId, messageId: streamMsgId });

        (async () => {
          try {
            const allHistory = chatService.getHistory(projectId, undefined, 1000);
            const lastResultMsg = [...allHistory].reverse().find(m => m.type === "result");
            const lastUpdate = lastResultMsg?.content || undefined;
            const proj = await projectService.getProject(projectId);

            const answer = await agentService.answerQuestionStream(
              projectId, text.trim(),
              (_chunk, fullText) => {
                broadcastToProject(projectId, { type: "stream_chunk", projectId, messageId: streamMsgId, text: fullText });
              },
              lastUpdate, proj?.description || undefined,
            );

            const ansMsg = chatService.addMessage(projectId, {
              role: "assistant",
              type: "text",
              content: answer,
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

  app.post("/telegram-mini-app/api/chat/:projectId/suggestions", async (req, res) => {
    try {
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const project = await projectService.getProject(req.params.projectId);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

      const suggestions = await agentService.getSuggestions(req.params.projectId);
      res.json({ suggestions });
    } catch (err) {
      console.error("[Chat API] Suggestions error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/chat/:projectId/plan", async (req, res) => {
    try {
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const projectId = req.params.projectId;
      const project = await projectService.getProject(projectId);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

      const { description } = req.body;
      if (!description?.trim()) { res.status(400).json({ error: "Description required" }); return; }

      if (!(await billingService.hasBalance(user.id))) {
        res.status(402).json({ error: "Insufficient balance" });
        return;
      }

      await projectService.updateProjectDescription(projectId, description.trim());

      const assets = await projectService.getProjectAssets(projectId);
      const assetPaths = assets.map((a: any) => a.filePath).filter(Boolean) as string[];
      const result = await claudeService.generatePlan(description.trim(), assetPaths);
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

      res.json({ plan: result.plan, costUsd: usage.costUsd, balance: usage.newBalance });
    } catch (err) {
      console.error("[Chat API] Plan generation error:", err);
      res.status(500).json({ error: "Failed to generate plan" });
    }
  });

  app.post("/telegram-mini-app/api/chat/:projectId/approve-plan", async (req, res) => {
    try {
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const projectId = req.params.projectId;
      const project = await projectService.getProject(projectId);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

      if (!project.plan) { res.status(400).json({ error: "No plan to approve" }); return; }
      if (processingProjects.has(projectId)) { res.status(409).json({ error: "Already processing" }); return; }

      const balance = await billingService.getUserBalance(user.id);
      if (balance < 5) {
        res.status(402).json({ error: `Insufficient balance ($${balance.toFixed(2)}). Minimum $5.00 required.` });
        return;
      }

      res.json({ status: "building" });

      (async () => {
        processingProjects.add(projectId);
        let progressMsgId: string | null = null;
        let checklistItems: string[] = [];
        let items: { id: number; text: string; done: boolean }[] = [];

        try {
          checklistItems = await agentService.generateChecklist(project.description || "", project.plan!);
        } catch {}
        items = checklistItems.map((t, i) => ({ id: i + 1, text: t, done: false }));

        const progressMsg = chatService.addMessage(projectId, {
          role: "assistant", type: "progress", content: "Starting...",
          checklist: items.length > 0 ? items : undefined, percent: 0,
        });
        progressMsgId = progressMsg.id;
        broadcastToProject(projectId, { type: "message", message: progressMsg });

        try {
          await projectService.updateProjectStatus(projectId, "building");

          const onProgress = async (p: AgentProgress) => {
            if (!progressMsgId) return;
            const updated = chatService.updateMessage(projectId, progressMsgId, {
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
                const ansMsg = chatService.addMessage(projectId, { role: "user", type: "answer", content: answer });
                broadcastToProject(projectId, { type: "message", message: ansMsg });
                resolve(answer);
              });
            });
          };

          const onCheckTodo = items.length > 0 ? async (id: number) => {
            if (id >= 1 && id <= items.length) {
              items[id - 1].done = true;
              if (progressMsgId) {
                chatService.updateMessage(projectId, progressMsgId, { checklist: items });
                broadcastToProject(projectId, { type: "progress", projectId, messageId: progressMsgId, checklist: items });
              }
            }
          } : undefined;

          const result = await agentService.buildApp(
            projectId, project.description || "", project.plan!,
            onProgress, onAskUser,
            items.length > 0 ? checklistItems : undefined,
            onCheckTodo, undefined, balance,
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
          } catch {}

          if (progressMsgId) {
            broadcastToProject(projectId, {
              type: "progress", projectId, messageId: progressMsgId,
              percent: 100, message: "Summarizing changes...",
              checklist: items, costUsd: usage.costUsd, balance: usage.newBalance,
            });
            chatService.updateMessage(projectId, progressMsgId, {
              percent: 100, content: "Summarizing changes...",
              checklist: items, costUsd: usage.costUsd, balance: usage.newBalance,
            });
          }

          const appName = project.name || "App";
          const [shortSummary, changelogUrl] = await Promise.all([
            agentService.summarizeShort(result.summary, 1),
            publishReport(`${appName} — Created`, result.summary, `Cost: $${usage.costUsd.toFixed(4)}`).catch(() => null),
          ]);

          if (progressMsgId) {
            chatService.updateMessage(projectId, progressMsgId, {
              type: "result", content: shortSummary || result.summary,
              percent: 100, costUsd: usage.costUsd, balance: usage.newBalance,
              metadata: { changelogUrl, summary: result.summary },
            });
            broadcastToProject(projectId, {
              type: "status", projectId, messageId: progressMsgId,
              status: "done", summary: shortSummary || result.summary,
              changelogUrl, costUsd: usage.costUsd, balance: usage.newBalance,
            });
          }

          broadcastToProject(projectId, { type: "status_change", projectId, status: "deployed" });
        } catch (err: any) {
          console.error("[Chat API] Build error:", err);
          await projectService.updateProjectStatus(projectId, "error");
          const errMsg = chatService.addMessage(projectId, { role: "system", type: "error", content: `Build failed: ${err.message || "Unknown error"}` });
          broadcastToProject(projectId, { type: "message", message: errMsg });
        } finally {
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
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const projectId = req.params.projectId;
      const project = await projectService.getProject(projectId);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

      const { feedback } = req.body;
      if (!feedback?.trim()) { res.status(400).json({ error: "Feedback required" }); return; }

      if (!(await billingService.hasBalance(user.id))) {
        res.status(402).json({ error: "Insufficient balance" });
        return;
      }

      chatService.addMessage(projectId, { role: "user", type: "text", content: feedback.trim() });

      const updatedDescription = `${project.description}\n\nAdditional feedback: ${feedback.trim()}`;
      const result = await claudeService.generatePlan(updatedDescription);
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
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const project = await projectService.getProject(req.params.projectId);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

      const { answer } = req.body;
      const resolved = resolveAnswer(req.params.projectId, answer || "");
      res.json({ resolved });
    } catch (err) {
      console.error("[Chat API] Answer error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── Versions API ──

  app.get("/telegram-mini-app/api/versions/:projectId", async (req, res) => {
    try {
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const project = await projectService.getProject(req.params.projectId as string);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

      const commits = await commitService.getCommits(req.params.projectId as string);
      const allMessages = chatService.getHistory(req.params.projectId as string, undefined, 10000);
      const resultMessages = allMessages.filter(m => m.type === "result" && m.metadata?.changelogUrl);

      const versions = commits.map((c, idx) => {
        const resultMsg = resultMessages[idx];
        return {
          version: parseInt(c.version, 10),
          changelog: c.changelog || "",
          createdAt: c.createdAt,
          isReleased: project.releaseCommit === parseInt(c.version, 10),
          hasLog: !!commitService.getLogPath(req.params.projectId as string, parseInt(c.version, 10)),
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
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

      const { version } = req.body;
      if (version !== undefined && version !== null) {
        await commitService.revertToCommit(projectId, version);
      }
      const commitNum = await commitService.releaseCurrentDev(projectId);
      res.json({ released: commitNum });
    } catch (err) {
      console.error("[MiniApp API] Release error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  app.post("/telegram-mini-app/api/versions/:projectId/revert", async (req, res) => {
    try {
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

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
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

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

  app.post("/telegram-mini-app/api/quality/:projectId", async (req, res) => {
    try {
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

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

  // ── Transfer Ownership API ──

  app.post("/telegram-mini-app/api/transfer/:projectId", async (req, res) => {
    try {
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

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
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

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
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }
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
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

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
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

      const { featureId } = req.body;
      if (!featureId) { res.status(400).json({ error: "featureId required" }); return; }

      const { purchaseFeature, getFeatureById } = await import("../services/features.service");
      const feature = getFeatureById(featureId);
      if (!feature) { res.status(400).json({ error: "Unknown feature" }); return; }

      const { newBalance } = await purchaseFeature(user.id, projectId, featureId);
      res.json({ success: true, newBalance, featureId });
    } catch (err: any) {
      console.error("[MiniApp API] Feature purchase error:", err);
      res.status(400).json({ error: err.message || "Purchase failed" });
    }
  });

  app.post("/telegram-mini-app/api/chat/:projectId/upload", upload.array("files", 5), async (req, res) => {
    try {
      const auth = validateMiniAppInitData((req.headers["x-telegram-init-data"] || "") as string);
      if (!auth.valid) { res.status(401).json({ error: "Unauthorized" }); return; }
      const user = await projectService.getOrCreateUser(auth.telegramId!, auth.username, auth.firstName);
      const projectId = req.params.projectId as string;
      const project = await projectService.getProject(projectId);
      if (!project || project.userId !== user.id) { res.status(403).json({ error: "Forbidden" }); return; }

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
