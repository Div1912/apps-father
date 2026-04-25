import { getOpenRouterClient } from "./openrouter.service";
import { runtimeConfig } from "./runtime-config.service";
import { config } from "../config";
import { GeneratedApp, GeneratedFile } from "../types";
import { ProjectPreferences, buildPreferencesPrompt } from "./preferences.catalog";

const SYSTEM_PROMPT = `You are Apps Father AI — an expert developer that creates Telegram Mini Apps.

When asked to create a plan, return a structured plan in markdown with:
- App name and description
- List of features
- UI screens/pages
- Database tables needed
- API endpoints needed

When asked to generate code, return a JSON object with this exact structure:
{
  "frontend": [
    { "path": "index.html", "content": "..." },
    { "path": "styles.css", "content": "..." },
    { "path": "app.js", "content": "..." }
  ],
  "backend": [
    { "path": "routes.js", "content": "..." }
  ],
  "schema": "CREATE TABLE ...",
  "botDescription": "Short bot description",
  "botCommands": [
    { "command": "start", "description": "Launch the app" }
  ]
}

CRITICAL JSON RULES:
- Return ONLY valid JSON. No markdown, no code fences, no explanations.
- All string values must have properly escaped special characters (\\n for newlines, \\\\ for backslashes, \\" for quotes inside strings).
- The "content" fields contain source code as JSON strings — every line break must be \\n, every quote must be \\".
- Do NOT truncate files. Include the COMPLETE code for every file.

Rules for generating Mini Apps:
1. Frontend must be a single-page app using HTML, CSS, and vanilla JavaScript
2. Always include the Telegram WebApp SDK: <script src="https://telegram.org/js/telegram-web-app.js"></script>
3. Use Telegram theme variables for styling (var(--tg-theme-bg-color), var(--tg-theme-text-color), etc.)
4. Call Telegram.WebApp.ready() on load and Telegram.WebApp.expand() for full screen
5. Frontend communicates with backend via fetch to /api/{project_id}/...
6. Backend routes are Express.js router handlers exported as a module
7. Include proper error handling and loading states
8. Make the UI mobile-first, clean, and modern
9. Database schema should be PostgreSQL-compatible DDL
10. InitData verification is handled automatically by the server middleware - do NOT add verification in backend routes
11. CRITICAL: Every fetch() call in the frontend MUST include the Telegram initData header like this:

function apiCall(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + (window.Telegram?.WebApp?.initData || ''),
    ...(options.headers || {})
  };
  return fetch(endpoint, { ...options, headers });
}

Use this apiCall() helper for ALL API requests in the frontend JavaScript.

Backend route file format:
- Export a function that receives (router, db, projectId) parameters
- router is an Express Router
- db object has these properties:
  - db.query(sql, params) — executes SQL, returns { rows: any[], rowCount: number }
  - db.botToken — the Telegram Bot API token for this project's bot
  - db.botUsername — the bot's username (without @)
- projectId is the project UUID
- Table names in SQL are auto-qualified with the project schema, so use plain table names
- Do NOT add any initData/auth verification middleware in backend routes — it's handled by the server
- CRITICAL: When calling Telegram Bot API (e.g. createInvoiceLink, sendMessage), ALWAYS use db.botToken — never hardcode or use env vars

TELEGRAM STARS PAYMENT FLOW (when user requests payment/purchase features):
The system handles payments as follows:
1. Backend creates an invoice link via Telegram Bot API (createInvoiceLink) using db.botToken
2. Frontend opens the invoice link using Telegram.WebApp.openInvoice(url, callback)
3. The bot automatically handles pre_checkout_query (auto-approved) and successful_payment
4. On successful_payment, the system looks up the pending_purchases table by invoice_payload and:
   - Adds coins/credits to the user
   - Marks the purchase as processed
5. Frontend polls or checks the user endpoint after payment to get updated balance

CRITICAL payment rules:
- Create a "pending_purchases" table in schema: (id SERIAL PRIMARY KEY, invoice_id VARCHAR(50) UNIQUE NOT NULL, user_id VARCHAR(50) NOT NULL, stars INTEGER NOT NULL, coins INTEGER NOT NULL, processed BOOLEAN DEFAULT false, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, processed_at TIMESTAMP NULL)
- Backend only needs a POST /create-invoice endpoint — do NOT create webhook/callback endpoints for payment
- The invoice payload MUST match the invoice_id stored in pending_purchases
- Use currency "XTR" and empty provider_token "" for Telegram Stars
- Frontend should use Telegram.WebApp.openInvoice(url, function(status) { if(status === 'paid') { refreshUser(); } })

Example backend route:
module.exports = function(router, db, projectId) {
  router.get('/items', async (req, res) => {
    try {
      const result = await db.query('SELECT * FROM items ORDER BY created_at DESC');
      res.json(result.rows);
    } catch (err) {
      res.status(500).json({ error: 'Database error' });
    }
  });

  // Telegram Stars invoice creation
  router.post('/create-invoice', async (req, res) => {
    try {
      const { stars, coins, userId } = req.body;
      const invoiceId = 'inv_' + Math.random().toString(36).substr(2, 16);

      await db.query(
        'INSERT INTO pending_purchases (invoice_id, user_id, stars, coins) VALUES ($1, $2, $3, $4)',
        [invoiceId, userId, stars, coins]
      );

      const response = await fetch('https://api.telegram.org/bot' + db.botToken + '/createInvoiceLink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Purchase ' + coins + ' Coins',
          description: 'Buy ' + coins + ' coins for ' + stars + ' stars',
          payload: invoiceId,
          provider_token: '',
          currency: 'XTR',
          prices: [{ label: coins + ' Coins', amount: stars }]
        })
      });
      const data = await response.json();
      if (data.ok) {
        res.json({ invoice_url: data.result, invoice_id: invoiceId });
      } else {
        res.status(500).json({ error: data.description });
      }
    } catch (err) {
      res.status(500).json({ error: 'Failed to create invoice' });
    }
  });
};`;

function extractJSON(text: string): any {
  // Try direct parse first
  try { return JSON.parse(text); } catch {}

  // Try extracting JSON object from markdown/text wrapper
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch {}
  }

  // Try to repair truncated JSON by finding the last complete file entry
  const cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  let jsonStr = cleaned;
  if (!jsonStr.startsWith("{")) {
    const idx = jsonStr.indexOf("{");
    if (idx >= 0) jsonStr = jsonStr.substring(idx);
  }

  // Attempt incremental repair: close unclosed strings, arrays, objects
  let repaired = jsonStr;
  const attempts = [
    () => repaired,
    () => repaired + '"}]}',
    () => repaired + '"}],"backend":[],"schema":"","botDescription":"","botCommands":[]}',
    () => repaired + '"],"backend":[],"schema":"","botDescription":"","botCommands":[]}',
    () => repaired + '}],"backend":[],"schema":"","botDescription":"","botCommands":[]}',
    () => repaired + '"]}',
    () => repaired + "]}", 
    () => repaired + "}",
  ];

  for (const attempt of attempts) {
    try {
      const candidate = attempt();
      const parsed = JSON.parse(candidate);
      if (parsed.frontend || parsed.backend) {
        console.log("[Claude] JSON repaired successfully");
        return parsed;
      }
    } catch {}
  }

  // Last resort: extract individual file objects using regex
  console.log("[Claude] Attempting regex-based file extraction");
  return extractFilesManually(text);
}

function extractFilesManually(text: string): any {
  const result: any = { frontend: [], backend: [], schema: "", botDescription: "", botCommands: [] };

  // Find all {"path": "...", "content": "..."} blocks
  const filePattern = /"path"\s*:\s*"([^"]+)"\s*,\s*"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let match;

  while ((match = filePattern.exec(text)) !== null) {
    const filePath = match[1];
    let content = match[2];
    try {
      content = JSON.parse('"' + content + '"');
    } catch {}

    if (filePath.endsWith(".html") || filePath.endsWith(".css") || filePath.endsWith(".js")) {
      if (filePath === "routes.js") {
        result.backend.push({ path: filePath, content });
      } else {
        result.frontend.push({ path: filePath, content });
      }
    }
  }

  // Extract schema
  const schemaMatch = text.match(/"schema"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (schemaMatch) {
    try { result.schema = JSON.parse('"' + schemaMatch[1] + '"'); } catch { result.schema = schemaMatch[1]; }
  }

  // Extract botDescription
  const descMatch = text.match(/"botDescription"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (descMatch) {
    try { result.botDescription = JSON.parse('"' + descMatch[1] + '"'); } catch { result.botDescription = descMatch[1]; }
  }

  if (result.frontend.length > 0 || result.backend.length > 0) {
    console.log(`[Claude] Extracted ${result.frontend.length} frontend + ${result.backend.length} backend files via regex`);
    return result;
  }

  throw new Error("Could not extract any files from AI response");
}

export class ClaudeService {
  private getProviderRouting(modelId: string, provider?: string): any | undefined {
    const selectedProvider = provider?.trim();
    if (selectedProvider) {
      return { only: [selectedProvider], allow_fallbacks: false };
    }
    if (modelId.toLowerCase().startsWith("minimax/")) {
      return { only: ["Minimax"], allow_fallbacks: false };
    }
    return undefined;
  }

  private async streamMessage(params: {
    system: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    max_tokens: number;
    modelId: string;
    provider?: string;
  }): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    const client = getOpenRouterClient();
    const stream = await client.chat.completions.create({
      model: params.modelId,
      max_tokens: params.max_tokens,
      messages: [
        { role: "system", content: params.system },
        ...params.messages,
      ],
      ...(this.getProviderRouting(params.modelId, params.provider) ? { provider: this.getProviderRouting(params.modelId, params.provider) } : {}),
      stream: true,
    } as any) as any;

    let result = "";
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) result += delta;
      // OpenRouter returns usage on the final chunk
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens || 0;
        outputTokens = chunk.usage.completion_tokens || 0;
      }
    }

    return { text: result, inputTokens, outputTokens };
  }

  async generatePlan(
    description: string,
    assets?: string[],
    lang?: string,
    prefs?: ProjectPreferences | null,
  ): Promise<{
    plan: string;
    inputTokens: number;
    outputTokens: number;
  }> {
    const modelCfg = runtimeConfig.getModelConfig("plan");
    const prefsBlock = prefs ? `${buildPreferencesPrompt(prefs)}\n\n` : "";
    let prompt = `${prefsBlock}Create a plan for a Telegram Mini App based on this description:\n\n${description}`;
    if (assets && assets.length > 0) {
      prompt += `\n\nThe user has provided ${assets.length} image(s) as reference for the app design.`;
    }
    const langInstruction = lang && lang !== "en"
      ? `\nIMPORTANT: Write the entire plan in ${lang === "ru" ? "Russian" : lang === "ua" ? "Ukrainian" : "English"}.`
      : "";
    prompt += `\n\nReturn ONLY the plan in markdown format. Do not generate any code yet.

IMPORTANT: Keep the plan CONCISE. The user-facing summary must fit in a Telegram message.
- App name and brief description (2-3 sentences)
- Feature list (bullet points, max 8-10 items)
- UI screens (names + 2-3 bullet points each, max 4 screens)
- Do NOT include database tables, API endpoints, or technical implementation details in the plan text — those will be handled during code generation.${langInstruction}`;

    const result = await this.streamMessage({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      max_tokens: modelCfg.maxTokens,
      modelId: modelCfg.modelId,
      provider: modelCfg.provider,
    });

    return { plan: result.text, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
  }

  async generateApp(
    description: string,
    plan: string,
    projectId: string,
    assets?: string[]
  ): Promise<GeneratedApp> {
    const modelCfg = runtimeConfig.getModelConfig("codegen");
    let prompt = `Generate the complete Telegram Mini App code based on this plan.

Project ID: ${projectId}
Base API URL: ${config.baseUrl}/api/${projectId}
App URL: ${config.baseUrl}/app/${projectId}/

Description: ${description}

Plan:
${plan}`;

    if (assets && assets.length > 0) {
      prompt += `\n\nThe user has provided ${assets.length} image asset(s) available at /app/${projectId}/assets/`;
    }

    prompt += `\n\nReturn ONLY valid JSON matching the specified structure. No markdown, no code fences, just raw JSON.`;

    const result = await this.streamMessage({
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: "{" },
      ],
      max_tokens: modelCfg.maxTokens,
      modelId: modelCfg.modelId,
      provider: modelCfg.provider,
    });

    const text = "{" + result.text;

    try {
      const parsed = extractJSON(text);
      return {
        plan,
        frontend: parsed.frontend || [],
        backend: parsed.backend || [],
        schema: parsed.schema || "",
        botDescription: parsed.botDescription || "A Telegram Mini App",
        botCommands: parsed.botCommands || [{ command: "start", description: "Launch the app" }],
      };
    } catch (err) {
      console.error("[Claude] Failed to parse generated code:", err);
      console.error("[Claude] Raw response length:", text.length);
      throw new Error("Failed to parse AI-generated code. Please try again.");
    }
  }

  async generateUpdate(
    existingCode: string,
    updateDescription: string,
    projectId: string
  ): Promise<GeneratedApp> {
    const modelCfg = runtimeConfig.getModelConfig("codegen");
    const prompt = `Update the existing Telegram Mini App code based on the user's request.

Project ID: ${projectId}
Base API URL: ${config.baseUrl}/api/${projectId}
App URL: ${config.baseUrl}/app/${projectId}/

Existing code:
${existingCode}

Update request: ${updateDescription}

Return the COMPLETE updated code as valid JSON matching the specified structure. Include ALL files, not just changed ones. No markdown, no code fences, just raw JSON.`;

    const result = await this.streamMessage({
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: prompt },
        { role: "assistant", content: "{" },
      ],
      max_tokens: modelCfg.maxTokens,
      modelId: modelCfg.modelId,
      provider: modelCfg.provider,
    });

    const text = "{" + result.text;

    try {
      const parsed = extractJSON(text);
      return {
        plan: "",
        frontend: parsed.frontend || [],
        backend: parsed.backend || [],
        schema: parsed.schema || "",
        botDescription: parsed.botDescription || "",
        botCommands: parsed.botCommands || [],
      };
    } catch (err) {
      console.error("[Claude] Failed to parse update code:", err);
      console.error("[Claude] Raw response length:", text.length);
      throw new Error("Failed to parse AI-generated update. Please try again.");
    }
  }

  async suggestImprovements(description: string, plan: string, lang?: string): Promise<{
    suggestions: string[];
    inputTokens: number;
    outputTokens: number;
  }> {
    const modelCfg = runtimeConfig.getModelConfig("suggestions");
    const langInstruction = lang && lang !== "en"
      ? `\n\nIMPORTANT: Write all suggestions in ${lang === "ru" ? "Russian" : lang === "ua" ? "Ukrainian" : "English"}. The suggestions must be in that language.`
      : "";
    const prompt = `Based on this Mini App description and plan, suggest 3-5 specific improvements or features that would make it better.

Description: ${description}
Plan: ${plan}

Return a JSON array of strings, each being a brief improvement suggestion. Example:
["Add offline support with service workers", "Include pull-to-refresh on the main list"]

Return ONLY the JSON array, no other text.${langInstruction}`;

    const client = getOpenRouterClient();
    const message = await client.chat.completions.create({
      model: modelCfg.modelId,
      max_tokens: modelCfg.maxTokens,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      ...(this.getProviderRouting(modelCfg.modelId, modelCfg.provider) ? { provider: this.getProviderRouting(modelCfg.modelId, modelCfg.provider) } : {}),
    } as any);

    const text = message.choices[0]?.message?.content || "[]";
    const inputTokens = message.usage?.prompt_tokens || 0;
    const outputTokens = message.usage?.completion_tokens || 0;

    let suggestions: string[] = [];
    try {
      const arrMatch = text.match(/\[[\s\S]*\]/);
      suggestions = JSON.parse(arrMatch ? arrMatch[0] : text);
    } catch {}

    return { suggestions, inputTokens, outputTokens };
  }
}

export const claudeService = new ClaudeService();
