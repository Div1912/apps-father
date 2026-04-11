import { WebSocketServer, WebSocket } from "ws";
import { IncomingMessage } from "http";
import crypto from "crypto";
import { config } from "../config";

interface MiniAppClient {
  ws: WebSocket;
  telegramId?: number;
  subscribedProject?: string;
}

const clients = new Set<MiniAppClient>();

const pendingAnswers = new Map<string, (answer: string) => void>();

function validateInitData(initData: string): { valid: boolean; telegramId?: number; username?: string } {
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
    return { valid: true, telegramId: userData.id, username: userData.username };
  } catch { return { valid: false }; }
}

function send(client: MiniAppClient, data: any): void {
  if (client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(typeof data === "string" ? data : JSON.stringify(data));
  }
}

export function broadcastToProject(projectId: string, data: any): void {
  const msg = typeof data === "string" ? data : JSON.stringify(data);
  for (const c of clients) {
    if (c.subscribedProject === projectId && c.ws.readyState === WebSocket.OPEN) {
      c.ws.send(msg);
    }
  }
}

export function registerAnswerResolver(projectId: string, resolve: (answer: string) => void): void {
  pendingAnswers.set(projectId, resolve);
}

export function resolveAnswer(projectId: string, answer: string): boolean {
  const resolver = pendingAnswers.get(projectId);
  if (!resolver) return false;
  pendingAnswers.delete(projectId);
  resolver(answer);
  return true;
}

export function hasPendingAnswer(projectId: string): boolean {
  return pendingAnswers.has(projectId);
}

let miniAppWss: WebSocketServer | null = null;

export function setupMiniAppWebSocket(): WebSocketServer {
  miniAppWss = new WebSocketServer({ noServer: true });

  miniAppWss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    const client: MiniAppClient = { ws };
    clients.add(client);

    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw.toString());

        if (data.type === "auth") {
          const auth = validateInitData(data.initData || "");
          if (auth.valid) {
            client.telegramId = auth.telegramId;
            send(client, { type: "auth_ok", telegramId: auth.telegramId });
          } else {
            send(client, { type: "auth_error", error: "Invalid initData" });
          }
          return;
        }

        if (data.type === "subscribe") {
          if (!client.telegramId) {
            send(client, { type: "error", error: "Not authenticated" });
            return;
          }
          client.subscribedProject = data.projectId;
          send(client, { type: "subscribed", projectId: data.projectId });
          return;
        }

        if (data.type === "answer") {
          if (!client.telegramId || !data.projectId) return;
          resolveAnswer(data.projectId, data.answer || "");
          return;
        }
      } catch (err) {
        console.error("[MiniApp WS] Message parse error:", err);
      }
    });

    ws.on("close", () => {
      clients.delete(client);
    });

    ws.on("error", () => {
      clients.delete(client);
    });
  });

  console.log("[MiniApp WS] WebSocket handler ready (path: /telegram-mini-app/ws)");
  return miniAppWss;
}

export function getMiniAppWss(): WebSocketServer | null {
  return miniAppWss;
}
