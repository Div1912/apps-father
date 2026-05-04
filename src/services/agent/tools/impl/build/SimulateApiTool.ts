import type OpenAI from "openai";
import type { AgentTool } from "../../../AgentTool";
import type { RunContext } from "../../../RunContext";
import { config } from "../../../../../config";

function buildFakeTelegramUser(args: any = {}): any {
  const rawUserId = args.userId ?? args.id ?? -100;
  const userId = Number(rawUserId);
  const suffix = String(rawUserId).replace(/^-/, "");
  return {
    id: Number.isFinite(userId) ? userId : -100,
    first_name: String(args.firstName || args.first_name || `Simulate${rawUserId}`),
    username: String(args.username || `simulate_${suffix}`),
    language_code: String(args.languageCode || args.language_code || "en"),
  };
}

function fakeInitDataFor(userArgs: any = {}): string {
  const user = buildFakeTelegramUser(userArgs);
  return `user=${encodeURIComponent(JSON.stringify(user))}&auth_date=${Math.floor(Date.now() / 1000)}&hash=${"0".repeat(64)}`;
}

export class SimulateApiTool implements AgentTool {
  renderDefinition(): OpenAI.Chat.Completions.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: "simulate_api",
        description: "Simulate an HTTP request to the project's backend API. Use after deploy_to_dev to test REST endpoints. The test user is created from optional userId/firstName/username fields.",
        parameters: {
          type: "object",
          properties: {
            method: { type: "string", description: "HTTP method (GET, POST, PUT, DELETE, etc.)" },
            path: { type: "string", description: "API path (e.g. '/users' or 'status')" },
            body: { type: "object", description: "Request body for POST/PUT" },
            expectStatus: { type: "number", description: "Expected HTTP status code (default: 200-299)" },
            userId: { type: "number", description: "Fake Telegram user id (default: -100)" },
            firstName: { type: "string", description: "Fake user first name" },
            username: { type: "string", description: "Fake Telegram username" },
          },
          required: ["method", "path"],
        },
      },
    };
  }

  async execute(args: Record<string, any>, ctx: RunContext): Promise<string> {
    const apiMethod = (args.method || "GET").toUpperCase();
    const apiPath = String(args.path || "").replace(/^\//, "");
    const fakeUser = buildFakeTelegramUser(args);
    const fakeInitData = fakeInitDataFor(fakeUser);
    const apiUrl = `${config.baseUrl.replace(/\/+$/, "")}/devapi/${ctx.projectId}/${apiPath}`;
    try {
      const resp = await fetch(apiUrl, {
        method: apiMethod,
        headers: { "Content-Type": "application/json", "x-telegram-init-data": fakeInitData },
        body: args.body ? JSON.stringify(args.body) : undefined,
      });
      let respBody: any;
      try { respBody = await resp.json(); } catch { respBody = await resp.text(); }
      const expectedStatus = Number.isFinite(Number(args.expectStatus)) ? Number(args.expectStatus) : null;
      const infrastructure404 =
        resp.status === 404 &&
        typeof respBody?.error === "string" &&
        /No backend routes configured|Endpoint not found/i.test(respBody.error);
      const ok = !infrastructure404 && (
        expectedStatus != null ? resp.status === expectedStatus : resp.status >= 200 && resp.status < 300
      );
      // X-App-Deploy-Time lets the agent confirm which routes.js version ran.
      const deployTime = resp.headers.get("x-app-deploy-time");
      const deployedAt = deployTime ? new Date(Number(deployTime)).toISOString() : undefined;
      const payload: Record<string, any> = { ok, method: apiMethod, url: apiUrl, status: resp.status, body: respBody };
      if (deployedAt) payload.routesDeployedAt = deployedAt;
      let result: string;
      if (ok) {
        ctx.testsRun.api = true;
        result = JSON.stringify(payload, null, 2);
      } else {
        result = `Error: simulate_api failed\n${JSON.stringify(payload, null, 2)}`;
      }
      ctx.testResults.push({ tool: "simulate_api", ok, detail: result.slice(0, 500) });
      return result;
    } catch (err: any) {
      const result = `Error: ${err.message}`;
      ctx.testResults.push({ tool: "simulate_api", ok: false, detail: result });
      return result;
    }
  }
}
