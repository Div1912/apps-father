import type OpenAI from "openai";
import fs from "fs";
import path from "path";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";
import { validateWsSimulation, observedWsTypes } from "../../../validation";
import { projectService } from "../../../../../services/project.service";
import { decryptToken } from "../../../../../services/crypto.service";

function isJsonLookingString(value: any): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

export class SimulateWsTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "simulate_ws",
        description: "Simulate WebSocket messages against the deployed backend. Provide messages array with clientId + data. Use after deploy_to_dev to test real-time message flows.",
        parameters: {
          type: "object",
          properties: {
            scenarioId: { type: "string", description: "Scenario name for tracking coverage" },
            messages: {
              type: "array",
              items: { type: "object" },
              description: "Array of { clientId, data } messages to send",
            },
            clients: {
              type: "array",
              items: { type: "object" },
              description: "Optional array of { id, userId } clients (auto-derived from messages if omitted)",
            },
            expectTypes: {
              type: "array",
              items: { type: "string" },
              description: "Expected WS message types that must appear in captured output",
            },
          },
          required: ["messages"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    try {
      const sim = await this._simulateProjectWs(ctx.projectRootDir, ctx.projectId, args);
      const wsError = validateWsSimulation(sim, ctx.technicalPlan);
      const observedTypes = observedWsTypes(sim);
      for (const type of observedTypes) ctx.wsCoverage.types.add(type);

      if (wsError) {
        const signature = wsError.replace(/\s+/g, " ").trim();
        ctx.repeatedWsFailureCount = signature === ctx.lastWsFailureSignature ? ctx.repeatedWsFailureCount + 1 : 1;
        ctx.lastWsFailureSignature = signature;
        let result = `Error: ${wsError}\n${JSON.stringify(sim, null, 2).slice(0, 6000)}`;
        if (ctx.repeatedWsFailureCount >= 2) {
          result += "\nRepeated simulate_ws failure: change the explicit clients/messages/expectTypes instead of retrying the same test. If the deploy limit is exhausted, stop and call finish for a blocked build report.";
        }
        ctx.testResults.push({ tool: "simulate_ws", ok: false, detail: result.slice(0, 500) });
        return result;
      }

      ctx.lastWsFailureSignature = "";
      ctx.repeatedWsFailureCount = 0;
      if (sim.scenarioId) ctx.wsCoverage.scenarios.add(String(sim.scenarioId));
      ctx.testsRun.ws = true;
      const result = JSON.stringify({ ok: true, ...sim }, null, 2).slice(0, 6000);
      ctx.testResults.push({ tool: "simulate_ws", ok: true, detail: result.slice(0, 500) });
      return result;
    } catch (err: any) {
      const result = `Error: ${err.message}`;
      ctx.testResults.push({ tool: "simulate_ws", ok: false, detail: result });
      return result;
    }
  }

  private async _simulateProjectWs(projectRootDir: string, projectId: string, args: any): Promise<any> {
    const routesPath = path.join(projectRootDir, "development", "backend", "routes.js");
    if (!fs.existsSync(routesPath)) {
      throw new Error("development/backend/routes.js not found. Call deploy_to_dev first.");
    }

    const dbSnapshot = new Map<string, any>();
    const dbPath = path.join(projectRootDir, "development", "data", "app.db");
    if (fs.existsSync(dbPath)) {
      const Database = require("better-sqlite3");
      const sqlite = new Database(dbPath, { readonly: true });
      try {
        const rows = sqlite.prepare("SELECT key, value FROM kv").all() as any[];
        for (const row of rows) dbSnapshot.set(row.key, JSON.parse(row.value));
      } catch {} finally {
        try { sqlite.close(); } catch {}
      }
    }

    const project = await projectService.getProject(projectId);
    const dbMutations: Array<{ operation: "set" | "delete"; key: string }> = [];
    const db = {
      get(key: string) { return dbSnapshot.has(key) ? dbSnapshot.get(key) : null; },
      set(key: string, value: any) {
        if (isJsonLookingString(value)) throw new Error(`simulate_ws db.set "${key}" received a JSON-looking string. Pass a real array/object instead.`);
        dbSnapshot.set(key, value);
        dbMutations.push({ operation: "set", key });
      },
      delete(key: string) { dbSnapshot.delete(key); dbMutations.push({ operation: "delete", key }); },
      keys() { return [...dbSnapshot.keys()]; },
      getAll() {
        const all: Record<string, any> = {};
        for (const [k, v] of dbSnapshot.entries()) all[k] = v;
        return all;
      },
      botToken: (project as any)?.botTokenEncrypted ? decryptToken((project as any).botTokenEncrypted) : "SIMULATE_TOKEN",
      botUsername: (project as any)?.botUsername || "simulate_bot",
      projectId,
    };

    try { delete require.cache[require.resolve(routesPath)]; } catch {}
    const routeModule = require(routesPath);
    if (typeof routeModule.ws !== "function") {
      throw new Error("backend/routes.js does not export module.exports.ws");
    }

    const messages = Array.isArray(args.messages) ? args.messages : [];
    if (messages.length === 0) {
      throw new Error("simulate_ws requires messages: [{ clientId, data }]. It does not send default/auth/setup messages.");
    }

    const clientsInput = Array.isArray(args.clients) && args.clients.length > 0
      ? args.clients
      : [...new Set(messages.map((msg: any) => String(msg.clientId || msg.id || "a")))].map((id, index) => ({ id, userId: -100 - index }));

    const captured: Record<string, string[]> = {};
    const handlers = new Map<string, Map<string, Function[]>>();
    const clients = new Map<string, any>();
    const clientSet = new Set<any>();

    const makeClient = (id: string) => {
      captured[id] = [];
      const eventHandlers = new Map<string, Function[]>();
      handlers.set(id, eventHandlers);
      const socket: any = {
        id, readyState: 1,
        send(data: any) { captured[id].push(typeof data === "string" ? data : JSON.stringify(data)); },
        on(event: string, cb: Function) {
          const arr = eventHandlers.get(event) || [];
          arr.push(cb);
          eventHandlers.set(event, arr);
        },
        close() {
          socket.readyState = 3;
          for (const cb of eventHandlers.get("close") || []) cb();
        },
      };
      clients.set(id, socket);
      clientSet.add(socket);
      return socket;
    };

    for (const c of clientsInput) makeClient(String(c.id || c.userId));

    let connectionHandler: ((socket: any, req: any) => void) | null = null;
    const wss = {
      clients: clientSet,
      broadcast(data: any) {
        const msg = typeof data === "string" ? data : JSON.stringify(data);
        for (const client of clientSet) if (client.readyState === 1) client.send(msg);
      },
      broadcastExcept(sender: any, data: any) {
        const msg = typeof data === "string" ? data : JSON.stringify(data);
        for (const client of clientSet) if (client !== sender && client.readyState === 1) client.send(msg);
      },
      onConnection(handler: (socket: any, req: any) => void) { connectionHandler = handler; },
    };

    routeModule.ws(wss, db, projectId);
    if (!connectionHandler) throw new Error("module.exports.ws did not call wss.onConnection(handler)");
    const onConnection = connectionHandler as (socket: any, req: any) => void;
    for (const c of clientsInput) {
      const id = String(c.id || c.userId);
      onConnection(clients.get(id), { url: `/devws/${projectId}`, headers: {} });
    }

    for (const msg of messages) {
      const clientId = String(msg.clientId || msg.id || "a");
      const socket = clients.get(clientId);
      if (!socket) throw new Error(`simulate_ws unknown clientId "${clientId}"`);
      if (!Object.prototype.hasOwnProperty.call(msg, "data")) {
        throw new Error(`simulate_ws message for client "${clientId}" requires a data field.`);
      }
      const data = typeof msg.data === "string" ? msg.data : JSON.stringify(msg.data);
      for (const cb of handlers.get(clientId)?.get("message") || []) cb(Buffer.from(data));
    }

    await new Promise(r => setTimeout(r, 50));
    return {
      scenarioId: args.scenarioId,
      clients: clientsInput,
      sentMessages: messages.length,
      captured,
      expectedTypes: Array.isArray(args.expectTypes) ? args.expectTypes.map(String) : [],
      dbMutations,
      dbPersisted: false,
    };
  }
}
