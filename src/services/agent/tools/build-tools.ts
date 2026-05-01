import { AgentToolDefinition } from "./types";

export const BUILD_TOOL_DEFS: AgentToolDefinition[] = [
  {
    name: "ask_user",
    description: "Ask the app owner a question and wait for their answer. Use ONLY when you truly need user input (API keys, credentials, external account IDs, design choices, naming, or choosing between fundamentally different approaches). If a requested feature requires an API key/credential and no public no-key alternative exists, you MUST call ask_user instead of inventing placeholders, using process.env, or shipping fake/mock behavior. Do NOT use for trivial implementation details you can decide yourself. Provide options as buttons when possible. The user can also type free text or press Skip.",
    input_schema: {
      type: "object" as const,
      properties: {
        question: { type: "string" as const, description: "The question to ask the user" },
        options: { type: "array" as const, items: { type: "string" as const }, description: "Optional list of choices shown as buttons (e.g. ['Option A', 'Option B'])" },
      },
      required: ["question"],
    },
  },
  {
    name: "technical_plan",
    description: "MANDATORY first planning tool for new builds. Submit the concrete implementation contract before writing code. The schema is kind-specific: App uses dbKeys/restEndpoints/wsMessages/screens; Text Bot uses stateShape/conversationFlow/keyboards/commands/testScenarios; Game uses coordinateSystem/sceneGraph/camera/input/collision/stateMachine/performanceBudget. If the app needs external APIs, list them in externalDependencies and call ask_user first for any required credentials. After this, code must match the submitted names exactly.",
    input_schema: {
      type: "object" as const,
      properties: {
        kind: { type: "string" as const, enum: ["app", "game", "textBot"], description: "Project kind this plan targets" },
        summary: { type: "string" as const, description: "One-sentence architecture summary" },
        dbKeys: { type: "array" as const, items: { type: "object" as const }, description: "DB key contracts: key pattern + stored shape" },
        restEndpoints: { type: "array" as const, items: { type: "object" as const }, description: "REST contracts: method, path, auth, input, output" },
        wsMessages: { type: "array" as const, items: { type: "object" as const }, description: "WebSocket message contracts with direction/type/fields" },
        screens: { type: "array" as const, items: { type: "object" as const }, description: "Frontend screens/components and their data/events" },
        botBehavior: { type: "array" as const, items: { type: "object" as const }, description: "Optional bot commands/callback/deep-link behaviour for Mini Apps" },
        stateShape: { type: "object" as const, description: "Text Bot state object stored under state:{uid}" },
        conversationFlow: { type: "array" as const, items: { type: "object" as const }, description: "Text Bot steps/buttons/callbacks and transitions" },
        keyboards: { type: "array" as const, items: { type: "object" as const }, description: "Text Bot reply/inline keyboards with exact button labels/callback_data" },
        commands: { type: "array" as const, items: { type: "object" as const }, description: "Bot slash commands: command + description" },
        testScenarios: { type: "array" as const, items: { type: "object" as const }, description: "Test cases the agent must run with simulate_* before finish" },
        externalDependencies: { type: "array" as const, items: { type: "object" as const }, description: "External APIs/providers used, whether credentials are required, and whether ask_user is needed before implementation" },
        coordinateSystem: { type: "string" as const, description: "Game coordinate system" },
        sceneGraph: { type: "array" as const, items: { type: "object" as const }, description: "Game scene/group/object graph" },
        camera: { type: "object" as const, description: "Game camera type/follow/smoothing" },
        input: { type: "array" as const, items: { type: "object" as const }, description: "Game input mapping" },
        collision: { type: "object" as const, description: "Game collision/win-loss rules" },
        stateMachine: { type: "array" as const, items: { type: "string" as const }, description: "Game state machine" },
        performanceBudget: { type: "object" as const, description: "Game FPS, pixel ratio, reuse/instancing budget" },
      },
      required: ["kind", "summary"],
    },
  },
  {
    name: "server_logs",
    description: "Read recent logs for this project: routes.js console.log/error output, webhook errors, simulate_telegram and simulate_api results. Call after deploy_to_dev or simulate_* to debug behaviour.",
    input_schema: {
      type: "object" as const,
      properties: {
        lines: { type: "number" as const, description: "How many recent log lines to return (default 50, max 200)" },
      },
      required: [],
    },
  },
  {
    name: "simulate_telegram",
    description: "Simulate a Telegram update (message or callback_query) hitting the bot webhook WITHOUT a real Telegram account. The test user always gets id=-100. All tg() API calls the bot makes are intercepted and returned. Also logged so server_logs shows them. Use after deploy_to_dev to test the bot flow end-to-end.",
    input_schema: {
      type: "object" as const,
      properties: {
        update: {
          type: "object" as const,
          description: "Telegram Update object. For a text message: { message: { from: { id: -100, first_name: 'Test', language_code: 'en' }, chat: { id: -100, type: 'private' }, text: '/start' } }. For a callback: { callback_query: { id: '1', from: { id: -100, first_name: 'Test' }, message: { chat: { id: -100 }, message_id: 1 }, data: 'like:123' } }",
        },
      },
      required: ["update"],
    },
  },
  {
    name: "simulate_api",
    description: "Simulate an HTTP request to the app's backend API routes as a Telegram test user. Defaults to id=-100; pass userId/firstName/username to test multi-user flows. Returns status and response body. Use to test REST endpoints in routes.js.",
    input_schema: {
      type: "object" as const,
      properties: {
        method: { type: "string" as const, description: "HTTP method: GET, POST, PUT, DELETE (default GET)" },
        path: { type: "string" as const, description: "API path relative to the project, e.g. /tasks or /tasks/123" },
        body: { type: "object" as const, description: "Request body for POST/PUT" },
        expectStatus: { type: "number" as const, description: "Optional expected HTTP status for negative tests, e.g. 400 or 401" },
        userId: { type: "number" as const, description: "Telegram user id for this request (default -100). Use different ids for multi-user tests." },
        firstName: { type: "string" as const, description: "Optional Telegram first_name for this simulated user" },
        username: { type: "string" as const, description: "Optional Telegram username for this simulated user" },
      },
      required: ["path"],
    },
  },
  {
    name: "simulate_ws",
    description: "Simulate project WebSocket traffic only: open fake client connections, send the explicit messages you provide, and capture outbound WebSocket data. Does not seed DB, does not run REST API steps, and does not send default/auth/setup messages. Uses an in-memory DB snapshot so project WS code cannot persist test mutations.",
    input_schema: {
      type: "object" as const,
      properties: {
        scenarioId: { type: "string" as const, description: "Optional id matching a technical_plan.testScenarios item" },
        clients: {
          type: "array" as const,
          items: { type: "object" as const },
          description: "Optional fake clients to connect before sending messages: [{ id: 'a', userId: -100 }, { id: 'b', userId: -101 }]. If omitted, clients are inferred from message clientId values.",
        },
        messages: {
          type: "array" as const,
          items: { type: "object" as const },
          description: "Required messages to send after connections open: [{ clientId: 'a', data: { type: 'auth', initData: '...' } }, { clientId: 'a', data: { type: 'ping' } }]. Data is sent exactly as provided.",
        },
        expectTypes: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Server WebSocket event types expected from this simulation. If omitted, validation falls back to planned server WS types.",
        },
      },
      required: ["messages"],
    },
  },
  {
    name: "set_bot_commands",
    description: "Safely set the bot slash-command menu with Telegram setMyCommands. Use for Text Bots after configure_app. Commands must all be handled in /bot-webhook.",
    input_schema: {
      type: "object" as const,
      properties: {
        commands: {
          type: "array" as const,
          items: {
            type: "object" as const,
            properties: {
              command: { type: "string" as const, description: "Command without leading slash, e.g. start" },
              description: { type: "string" as const, description: "Short user-facing description" },
            },
            required: ["command", "description"],
          },
        },
      },
      required: ["commands"],
    },
  },
  {
    name: "deploy_to_dev",
    description: "Deploy your current code to the development environment for live testing. Runs syntax/contract validators first. After calling this, frontend is available at /dev/{projectId}/, API at /devapi/{projectId}/, and WS at /devws/{projectId}. Call this before simulate_api, simulate_telegram, or simulate_ws.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "finish",
    description: "Atomically finish the build: save short user-facing summary, detailed technical summary, and signal completion - all in ONE call. This is the ONLY way to finish a build. Call this LAST, after technical_plan, file writes, deploy_to_dev, validators, and required simulate_* tests pass. There is NO separate done/summary/short_summary tool.",
    input_schema: {
      type: "object" as const,
      properties: {
        shortSummary: {
          type: "string" as const,
          description: "Short user-facing summary, format: 'Update title (3-5 words)\\n\\n1-2 sentences in simple non-technical language.' No jargon.",
        },
        summary: {
          type: "string" as const,
          description: "Detailed technical summary/changelog: architecture decisions, new files, changes made, anything the next update should know.",
        },
        context_diff: {
          type: "string" as const,
          description: "Short delta for the project passport (1-3 sentences). Describe NEW or REMOVED routes, DB keys, screens, key decisions, or architectural changes from THIS commit only. Used to incrementally update the passport without re-reading the codebase. If empty, the platform falls back to the first line of `summary`. Examples: 'Added /api/leaderboard returning top-10 by score from db.users.' / 'Removed legacy /api/stats-v1; replaced by /api/stats which paginates.' / 'New screen #profile with avatar upload via /api/upload-avatar.'",
        },
      },
      required: ["shortSummary", "summary"],
    },
  },
  {
    name: "configure_app",
    description: "Save the app's name, description, long description, and menu button text in Apps Father core DB, then configure the Telegram bot if it is already linked. ONLY use on FIRST build, never on updates. If no bot token is connected yet, the saved data will be applied automatically when the bot is later created and connected. Use this instead of direct Telegram Bot API calls.",
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "App and bot display name (up to 64 chars)" },
        description: { type: "string" as const, description: "Short app/bot description shown in Telegram previews (up to 120 chars)" },
        longDescription: { type: "string" as const, description: "Long bot profile description shown in Telegram profile (up to 512 chars)" },
        menuButtonText: { type: "string" as const, description: "Text for the Mini App menu button (e.g. 'Launch App'). Use empty string for Text Bots." },
      },
      required: ["name", "description", "longDescription"],
    },
  },
];
