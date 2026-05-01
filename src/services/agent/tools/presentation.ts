export type ToolStepKind =
  | "thinking"
  | "reading"
  | "writing"
  | "editing"
  | "searching"
  | "shell"
  | "fetch"
  | "db"
  | "telegram"
  | "deploying"
  | "configuring"
  | "skill"
  | "ask"
  | "done";

export type ToolTargetField = "file" | "url" | "key";

export interface ToolDisplayConfig {
  kind: ToolStepKind;
  title: string;
  targetKey?: string;
  targetField?: ToolTargetField;
}

export type ToolStepTarget = { file?: string; range?: string; url?: string; key?: string };

// Fast lookup: tool name -> UI step kind/title and the primary arg to render.
export const TOOL_DISPLAY: Record<string, ToolDisplayConfig> = {
  list_files: { kind: "searching", title: "Scanning files" },
  read_file: { kind: "reading", title: "Reading", targetKey: "path", targetField: "file" },
  write_file: { kind: "writing", title: "Writing", targetKey: "path", targetField: "file" },
  edit_file: { kind: "editing", title: "Editing", targetKey: "path", targetField: "file" },
  grep: { kind: "searching", title: "Searching", targetKey: "pattern", targetField: "key" },
  shell: { kind: "shell", title: "Running command", targetKey: "command", targetField: "key" },
  fetch_url: { kind: "fetch", title: "Fetching URL", targetKey: "url", targetField: "url" },
  db: { kind: "db", title: "Database", targetKey: "key", targetField: "key" },
  deploy_to_dev: { kind: "deploying", title: "Deploying to dev" },
  load_skill: { kind: "skill", title: "Loading skill", targetKey: "name", targetField: "key" },
  ask_user: { kind: "ask", title: "Waiting for your answer" },
  technical_plan: { kind: "thinking", title: "Technical plan", targetKey: "kind", targetField: "key" },
  configure_app: { kind: "configuring", title: "Configuring app" },
  set_bot_commands: { kind: "configuring", title: "Setting bot commands" },
  finish: { kind: "done", title: "Finishing" },
  server_logs: { kind: "searching", title: "Reading logs" },
  simulate_telegram: { kind: "shell", title: "Simulating bot message" },
  simulate_api: { kind: "fetch", title: "Simulating API call" },
  simulate_ws: { kind: "shell", title: "Simulating WebSocket" },
};

export function buildToolStepTarget(toolName: string, args: any): ToolStepTarget | undefined {
  const cfg = TOOL_DISPLAY[toolName];
  if (!cfg?.targetKey) return undefined;
  const raw = args?.[cfg.targetKey];
  if (typeof raw !== "string" || !raw) return undefined;
  const trimmed = raw.length > 200 ? raw.slice(0, 197) + "..." : raw;
  const field = cfg.targetField || "file";
  return { [field]: trimmed };
}

export function summarizeToolArgs(toolName: string, args: any): string {
  switch (toolName) {
    case "list_files": return "";
    case "read_file": return args.offset ? `${args.path}:${args.offset}-${args.offset + (args.limit || 0)}` : args.path;
    case "write_file": return `${args.path}, ${(args.content || "").length} chars`;
    case "edit_file": return `${args.path}, "${(args.old_string || "").substring(0, 40)}..." -> "${(args.new_string || "").substring(0, 40)}..."`;
    case "grep": return `"${args.pattern}"${args.path ? ` in ${args.path}` : ""}${args.include ? ` (${args.include})` : ""}`;
    case "shell": return args.command?.substring(0, 80) || "";
    case "fetch_url": return args.url || "";
    case "db": return `${args.operation}(${args.key || ""})${args.value ? ", " + JSON.stringify(args.value).substring(0, 60) : ""}`;
    case "load_skill": return args.name || "";
    case "ask_user": return (args.question || "").substring(0, 60);
    case "technical_plan": return `${args.kind || "app"}: ${(args.summary || "").substring(0, 80)}`;
    case "configure_app": return args.name || "";
    case "set_bot_commands": return Array.isArray(args.commands) ? `${args.commands.length} commands` : "";
    case "server_logs": return `${args.lines || 50} lines`;
    case "simulate_telegram": return args.update?.message?.text || args.update?.callback_query?.data || "update";
    case "simulate_api": return `${args.method || "GET"} ${args.path}`;
    case "simulate_ws": return args.scenarioId || `${Array.isArray(args.messages) ? args.messages.length : 0} message(s)`;
    case "deploy_to_dev": return "";
    case "finish": return (args.shortSummary || args.summary || "").substring(0, 80);
    default: return JSON.stringify(args).substring(0, 80);
  }
}
