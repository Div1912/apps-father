export const ASK_TOOLS = [
  {
    type: "function",
    function: {
      name: "project_info",
      description: "Get high-level metadata about THIS project: name, kind (app/game/textBot), description, plan presence, last update, status, owner-picked preferences, and which paid features are unlocked.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files in the live app (frontend/ + backend/) with sizes. Use this to see what the project actually contains before asking the owner.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the live app. Paths are relative to the project root (e.g. 'frontend/index.html', 'backend/routes.js'). Refuses binary files. Optional offset/limit page through long files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative file path, e.g. frontend/index.html" },
          offset: { type: "number", description: "1-based start line for paging." },
          limit: { type: "number", description: "Max lines to return when offset is set." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "db_query",
      description: "Read-only inspection of the project's key/value database. Use this to answer 'how many users?', 'what's stored?', 'show me the latest order' kinds of questions.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["list", "get", "count"], description: "list = recent keys with truncated values; get = single key value; count = key count." },
          key: { type: "string", description: "Required when action=get." },
          prefix: { type: "string", description: "Optional key prefix filter for list/count." },
          limit: { type: "number", description: "Max keys returned by list (default 20, max 100)." },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "platform_help",
      description: "Look up Apps Father platform documentation aimed at owners. Use this when the owner asks about platform-wide features, pricing, payments, referrals, real-time, the bot side, etc.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "One of: payments, referrals, realtime, bot, billing, tiers. Omit for the high-level overview." },
        },
        additionalProperties: false,
      },
    },
  },
];
