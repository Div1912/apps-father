import { getAvailableSkills } from "../instruction-loader";
import { AgentToolDefinition } from "./types";

export const FILESYSTEM_TOOL_DEFS: AgentToolDefinition[] = [
  {
    name: "list_files",
    description: "List all files in the project directory with sizes. Returns lines like 'frontend/app.js (340 lines, 12KB)'.",
    input_schema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "read_file",
    description: "Read a TEXT file from the project. Supports optional line range to read only specific lines (1-indexed). Returns numbered lines. NEVER call on binary files (images .png/.jpg/.jpeg/.gif/.webp, video, audio, fonts, archives, .pdf, .db, etc.) - they will be refused. Reference image assets directly in HTML/CSS via their path (e.g. <img src=\"assets/foo.jpg\">) without reading them. For text files >256KB you MUST pass offset+limit; full reads are capped.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "File path relative to project root. Must point to a text file." },
        offset: { type: "number" as const, description: "Start line number (1-indexed, optional)" },
        limit: { type: "number" as const, description: "Number of lines to read (optional). Required for files larger than 256KB." },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with complete content. Use for new files or full rewrites. For small changes, prefer edit_file.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "File path relative to project root" },
        content: { type: "string" as const, description: "Complete file content" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Edit a file by replacing an exact string with new content. Much cheaper than rewriting the whole file. Use replace_all to replace every occurrence.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: { type: "string" as const, description: "File path relative to project root" },
        old_string: { type: "string" as const, description: "Exact string to find (must be unique in file unless replace_all)" },
        new_string: { type: "string" as const, description: "Replacement string" },
        replace_all: { type: "boolean" as const, description: "Replace all occurrences (default false)" },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "grep",
    description: "Search for a pattern in project files. Returns matching lines with file:line format. Supports regex.",
    input_schema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string" as const, description: "Search pattern (regex supported)" },
        path: { type: "string" as const, description: "Relative path to search in (default: entire project)" },
        include: { type: "string" as const, description: "File glob filter, e.g. '*.js' or '*.html'" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "shell",
    description: "Execute a shell command in the project directory. Use for npm install, node scripts, curl, ls, find, wc, diff, etc. Timeout: 30s.",
    input_schema: {
      type: "object" as const,
      properties: {
        command: { type: "string" as const, description: "Shell command to execute" },
      },
      required: ["command"],
    },
  },
  {
    name: "db",
    description: "Read/write project database (JSON key-value store backed by SQLite). get(key) returns parsed JSON or null. set(key, value) stores any JSON value. Pass real arrays/objects, not stringified JSON. delete(key) removes a key. keys() lists all keys.",
    input_schema: {
      type: "object" as const,
      properties: {
        operation: { type: "string" as const, enum: ["get", "set", "delete", "keys"], description: "Operation to perform" },
        key: { type: "string" as const, description: "Key name, e.g. 'users', 'settings', 'scores'" },
        value: { description: "Value to store (any JSON - object, array, string, number). Required for 'set'." },
      },
      required: ["operation"],
    },
  },
  {
    name: "fetch_url",
    description: "Fetch a web page or API documentation URL and return its text content (HTML tags stripped). Use to read API docs, READMEs, examples, etc.",
    input_schema: {
      type: "object" as const,
      properties: {
        url: { type: "string" as const, description: "URL to fetch" },
      },
      required: ["url"],
    },
  },
  {
    name: "load_skill",
    description: `Load a skill file with code patterns and best practices. Available skills: ${getAvailableSkills().join(", ")}`,
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "Skill name to load" },
      },
      required: ["name"],
    },
  },
];
