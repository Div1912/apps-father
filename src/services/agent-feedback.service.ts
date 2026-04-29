/**
 * Agent Feedback analysis pipeline (Investigator).
 *
 * The analyzer is itself an LLM agent: instead of a single fat prompt we give
 * it READ-ONLY tools and let it gather evidence iteratively, then submit a
 * structured analysis via the terminal `submit_analysis` tool.
 *
 * Available tools (server-side execution):
 *   - list_instructions / read_instruction
 *   - list_agent_sources / read_agent_source
 *   - list_commit_files / read_commit_file
 *   - read_commit_diff
 *   - read_agent_log_window
 *   - submit_analysis           (terminal — produces AnalysisResult)
 *
 * Uses a SEPARATE OpenRouter API key + optional provider routing
 * (runtimeConfig.getTrainingApiKey / getTrainingProvider) so training spend
 * is isolated from production user runs.
 */

import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { config } from "../config";
import { prisma } from "../db";
import { runtimeConfig } from "./runtime-config.service";
import { parseAgentLog } from "./agent-logger";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const PROJECTS_DIR = path.join(process.cwd(), "projects");
const KNOWLEDGE_DIR = path.join(process.cwd(), "agent_knowledge");
const INSTRUCTIONS_DIR = path.join(KNOWLEDGE_DIR, "instructions");
const SERVICES_DIR = path.join(process.cwd(), "src", "services");

// Per-tool result truncation (defends against blowing up the context).
const MAX_TOOL_RESULT_CHARS = 80_000;
// Hard cap on iterations for the investigation loop.
const MAX_ITERATIONS = 12;
// Max log window characters returned at once.
const MAX_LOG_WINDOW_CHARS = 60_000;

// Files we let the analyzer read from src/services/ (whitelisted to avoid
// dumping unrelated server code into the context).
const AGENT_SOURCE_WHITELIST = [
  "agent.service.ts",
  "agent-logger.ts",
  "agent-lessons.service.ts",
  "agent-feedback.service.ts",
  "commit.service.ts",
  "openrouter.service.ts",
  "billing.service.ts",
];

export interface SuggestedLesson {
  rule: string;
  context?: string | null;
  tags?: string[];
  notes?: string | null;
}

export interface SuggestedPatch {
  title: string;
  problem: string;
  targetFiles: string[];
  suggestion: string;
  cursorPrompt: string;
  tags?: string[];
  notes?: string | null;
}

export interface InvestigationStep {
  iter: number;
  tool: string;
  args: Record<string, any>;
  resultPreview: string;   // first ~600 chars, for the admin UI
  resultLength: number;
  ok: boolean;
}

export interface AnalysisUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface AnalysisResult {
  summary: string;
  rootCause?: string;
  suggestedLessons: SuggestedLesson[];
  suggestedPatches: SuggestedPatch[];
  investigationLog?: InvestigationStep[];
  iterations?: number;
  truncated?: boolean;     // hit MAX_ITERATIONS without submit_analysis
  usage?: AnalysisUsage;
}

// ─── OpenRouter client ──────────────────────────────────────────────────────

function assertAscii(value: string, label: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code > 127) {
      throw new Error(
        `${label} contains a non-ASCII character at position ${i} ` +
        `(codepoint ${code}, char "${value[i]}").\n` +
        `HTTP headers only allow ASCII (0-127). ` +
        `Check for Cyrillic/Unicode look-alikes (e.g. Cyrillic "р" vs Latin "p").`
      );
    }
  }
}

function getTrainingClient(): OpenAI {
  const key = runtimeConfig.getTrainingApiKey();
  // HTTP headers must be a ByteString (chars 0-255). Stick to plain ASCII.
  // A common mistake is pasting API keys with Cyrillic look-alike letters
  // (e.g. "р" U+0440 instead of "p" U+0070). Assert early so the error
  // message names the field instead of crashing with an opaque ByteString error.
  assertAscii(key, "Training API key");
  const referer = `https://${config.domain}`;
  assertAscii(referer, "HTTP-Referer header (DOMAIN env var)");
  return new OpenAI({
    apiKey: key,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: {
      "HTTP-Referer": referer,
      "X-Title": "Apps Father - Agent Training",
    },
  });
}

// ─── File-system helpers (path-jail every read) ─────────────────────────────

function safeRead(filePath: string, root: string): string | null {
  try {
    const resolved = path.resolve(filePath);
    const resolvedRoot = path.resolve(root);
    if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
      return null;
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
    let txt = fs.readFileSync(resolved, "utf-8");
    if (txt.length > MAX_TOOL_RESULT_CHARS) {
      txt = txt.slice(0, MAX_TOOL_RESULT_CHARS) + `\n…[truncated, original ${txt.length} chars]`;
    }
    return txt;
  } catch {
    return null;
  }
}

function listDirRecursive(root: string, sub: string = ""): string[] {
  const out: string[] = [];
  const startAbs = path.join(root, sub);
  if (!fs.existsSync(startAbs)) return out;
  const stack: string[] = [startAbs];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        // Skip common heavy dirs that shouldn't appear in user projects but
        // guard anyway.
        if (e.name === "node_modules" || e.name === ".git") continue;
        stack.push(full);
      } else if (e.isFile()) {
        out.push(path.relative(root, full).replace(/\\/g, "/"));
      }
    }
  }
  out.sort();
  return out;
}

// ─── Investigation-time data the tools work against ─────────────────────────

interface CaseContext {
  feedbackId: string;
  projectId: string;
  commitNumBefore: number | null;
  commitNumAfter: number | null;
  /** Pre-parsed agent log entries (full, not truncated). */
  agentLogEntries: any[];
}

function commitDir(projectId: string, commitNum: number | null | undefined): string | null {
  if (!commitNum) return null;
  return path.join(PROJECTS_DIR, projectId, "commits", String(commitNum));
}

function readAgentLogEntriesForCase(projectId: string, commitNum: number | null | undefined): any[] {
  if (!commitNum) return [];
  const logPath = path.join(PROJECTS_DIR, projectId, "commits", String(commitNum), "agent.log");
  if (!fs.existsSync(logPath)) return [];
  try { return parseAgentLog(logPath); } catch { return []; }
}

// ─── Tool definitions (OpenAI function-calling shape) ───────────────────────

function getToolDefs(): any[] {
  return [
    {
      type: "function",
      function: {
        name: "list_instructions",
        description: "List all agent instruction Markdown files in agent_knowledge/instructions/. Returns filenames only.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "read_instruction",
        description: "Read the FULL contents of one instruction file (e.g. 'frontend-rules.md').",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "Filename inside agent_knowledge/instructions/, e.g. 'frontend-rules.md'." } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_agent_sources",
        description: "List the whitelisted agent source files in src/services/ that you may read.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    },
    {
      type: "function",
      function: {
        name: "read_agent_source",
        description: "Read a whitelisted agent source file (e.g. 'agent.service.ts'). Use list_agent_sources first.",
        parameters: {
          type: "object",
          properties: { name: { type: "string", description: "One of the names returned by list_agent_sources." } },
          required: ["name"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_commit_files",
        description: "Recursively list files in the post-run commit directory (projects/{projectId}/commits/{commitNumAfter}/). This is the project the agent built/updated for the user.",
        parameters: {
          type: "object",
          properties: {
            folder: { type: "string", description: "Optional sub-folder to scope the listing, e.g. 'frontend' or 'backend'." },
          },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_commit_file",
        description: "Read a file from the post-run commit directory. The path is relative to commits/{commitNumAfter}/, e.g. 'frontend/index.html' or 'backend/server.ts'.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Relative path inside the commit folder." } },
          required: ["path"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_commit_diff",
        description: "Show what changed between the BEFORE and AFTER commits. Without 'path', returns a short summary of added/modified/deleted files. With 'path', returns the file contents from both sides side-by-side.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Optional relative file path to diff, e.g. 'frontend/index.html'." } },
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "read_agent_log_window",
        description: "Read a slice of the agent.log entries by index (zero-based, half-open). Use this when the log is too large for one response. Total entries are reported in the initial system message.",
        parameters: {
          type: "object",
          properties: {
            startIndex: { type: "integer", description: "Zero-based start index." },
            endIndex:   { type: "integer", description: "Exclusive end index. Defaults to startIndex+30." },
            typesFilter: {
              type: "array",
              items: { type: "string" },
              description: "Optional filter, e.g. ['tool_call','tool_result','error']. Empty = all types.",
            },
          },
          required: ["startIndex"],
          additionalProperties: false,
        },
      },
    },
    {
      type: "function",
      function: {
        name: "submit_analysis",
        description: "TERMINAL TOOL. Call this exactly once when you have gathered enough evidence. The investigation ends as soon as you call it.",
        parameters: {
          type: "object",
          properties: {
            summary:    { type: "string", description: "1-2 sentence explanation of what went wrong." },
            rootCause:  { type: "string", description: "1-2 sentence root-cause analysis." },
            suggestedLessons: {
              type: "array",
              description: "Short prompt-injectable rules. Empty array OK.",
              items: {
                type: "object",
                properties: {
                  rule:    { type: "string" },
                  context: { type: "string" },
                  tags:    { type: "array", items: { type: "string" } },
                  notes:   { type: "string" },
                },
                required: ["rule"],
              },
            },
            suggestedPatches: {
              type: "array",
              description: "Suggested edits to instruction/source files. Empty array OK.",
              items: {
                type: "object",
                properties: {
                  title:        { type: "string" },
                  problem:      { type: "string" },
                  targetFiles:  { type: "array", items: { type: "string" } },
                  suggestion:   { type: "string" },
                  cursorPrompt: { type: "string", description: "Ready-to-paste IDE instruction." },
                  tags:         { type: "array", items: { type: "string" } },
                  notes:        { type: "string" },
                },
                required: ["title", "problem", "suggestion", "cursorPrompt"],
              },
            },
          },
          required: ["summary", "suggestedLessons", "suggestedPatches"],
          additionalProperties: false,
        },
      },
    },
  ];
}

// ─── Tool execution ─────────────────────────────────────────────────────────

function fmtAgentLogEntry(e: any, idx: number): string {
  const t = e.type;
  if (t === "text")        return `[${idx}] [text] ${String(e.text || "").slice(0, 1000)}`;
  if (t === "tool_call")   return `[${idx}] [tool_call] ${e.name} ${JSON.stringify(e.input || {}).slice(0, 800)}`;
  if (t === "tool_result") return `[${idx}] [tool_result] ${e.name} ${String(e.result || "").slice(0, 800)}`;
  if (t === "thinking")    return `[${idx}] [thinking] ${String(e.text || "").slice(0, 800)}`;
  if (t === "error")       return `[${idx}] [error] ${String(e.error || "")}`;
  if (t === "done")        return `[${idx}] [done] iter=${e.iterations} in=${e.totalInput} out=${e.totalOutput}`;
  return `[${idx}] [${t}] ${JSON.stringify(e).slice(0, 400)}`;
}

function toolListInstructions(): string {
  try {
    const files = fs.readdirSync(INSTRUCTIONS_DIR).filter((f) => f.endsWith(".md")).sort();
    return files.length ? files.join("\n") : "(no instruction files found)";
  } catch (err: any) {
    return `Error: ${err?.message || err}`;
  }
}

function toolReadInstruction(name: string): string {
  if (!name || !/^[\w.\-]+\.md$/i.test(name)) {
    return `Error: invalid filename '${name}'. Expected something like 'frontend-rules.md'.`;
  }
  const full = path.join(INSTRUCTIONS_DIR, name);
  const txt = safeRead(full, INSTRUCTIONS_DIR);
  return txt == null ? `Error: file not found: agent_knowledge/instructions/${name}` : txt;
}

function toolListAgentSources(): string {
  return AGENT_SOURCE_WHITELIST.join("\n");
}

function toolReadAgentSource(name: string): string {
  if (!AGENT_SOURCE_WHITELIST.includes(name)) {
    return `Error: '${name}' is not whitelisted. Allowed: ${AGENT_SOURCE_WHITELIST.join(", ")}`;
  }
  const full = path.join(SERVICES_DIR, name);
  const txt = safeRead(full, SERVICES_DIR);
  return txt == null ? `Error: file not found: src/services/${name}` : txt;
}

function toolListCommitFiles(ctx: CaseContext, folder?: string): string {
  const dir = commitDir(ctx.projectId, ctx.commitNumAfter);
  if (!dir) return "Error: no post-run commit available for this case.";
  if (!fs.existsSync(dir)) return `Error: commit folder not found: ${dir}`;
  const sub = (folder || "").trim();
  if (sub && !/^[\w./-]+$/.test(sub)) return `Error: invalid folder '${sub}'.`;
  const files = listDirRecursive(dir, sub);
  if (!files.length) return sub ? `(no files under '${sub}')` : "(commit folder is empty)";
  return files.join("\n");
}

function toolReadCommitFile(ctx: CaseContext, relPath: string): string {
  const dir = commitDir(ctx.projectId, ctx.commitNumAfter);
  if (!dir) return "Error: no post-run commit available.";
  if (!relPath) return "Error: 'path' is required.";
  const full = path.join(dir, relPath);
  const txt = safeRead(full, dir);
  return txt == null ? `Error: file not found in commit: ${relPath}` : txt;
}

function toolReadCommitDiff(ctx: CaseContext, relPath?: string): string {
  const afterDir = commitDir(ctx.projectId, ctx.commitNumAfter);
  const beforeDir = commitDir(ctx.projectId, ctx.commitNumBefore);
  if (!afterDir) return "Error: no post-run commit available.";
  if (!beforeDir) {
    return relPath
      ? toolReadCommitFile(ctx, relPath).split("\n").slice(0, 3).join("\n") +
          "\n[no BEFORE commit available — showing AFTER only]\n\n" +
          toolReadCommitFile(ctx, relPath)
      : "No BEFORE commit available (this was likely the first build). Listing AFTER files:\n" +
          toolListCommitFiles(ctx);
  }
  if (!relPath) {
    // Compute a simple file-set diff between the two commit folders.
    const beforeFiles = new Set(listDirRecursive(beforeDir));
    const afterFiles = new Set(listDirRecursive(afterDir));
    const added: string[] = [];
    const deleted: string[] = [];
    const modified: string[] = [];
    for (const f of afterFiles) {
      if (!beforeFiles.has(f)) { added.push(f); continue; }
      try {
        const a = fs.readFileSync(path.join(afterDir, f));
        const b = fs.readFileSync(path.join(beforeDir, f));
        if (!a.equals(b)) modified.push(f);
      } catch { modified.push(f); }
    }
    for (const f of beforeFiles) if (!afterFiles.has(f)) deleted.push(f);
    return [
      `# Diff between commit ${ctx.commitNumBefore} and ${ctx.commitNumAfter}`,
      `Added (${added.length}):`,
      ...added.map((f) => `  + ${f}`),
      `Modified (${modified.length}):`,
      ...modified.map((f) => `  ~ ${f}`),
      `Deleted (${deleted.length}):`,
      ...deleted.map((f) => `  - ${f}`),
      "",
      "Use read_commit_diff with a 'path' argument to see the actual contents of any modified file.",
    ].join("\n");
  }
  // Per-file diff: show BEFORE and AFTER, separated. Cheaper than computing
  // a real unified diff and just as informative for an LLM.
  const before = safeRead(path.join(beforeDir, relPath), beforeDir);
  const after = safeRead(path.join(afterDir, relPath), afterDir);
  if (before == null && after == null) return `Error: file not in either commit: ${relPath}`;
  return [
    `# ${relPath}`,
    `--- BEFORE (commit ${ctx.commitNumBefore}) ---`,
    before == null ? "(file did not exist)" : before,
    `--- AFTER (commit ${ctx.commitNumAfter}) ---`,
    after == null ? "(file deleted)" : after,
  ].join("\n");
}

function toolReadAgentLogWindow(
  ctx: CaseContext,
  startIndex: number,
  endIndex?: number,
  typesFilter?: string[],
): string {
  const total = ctx.agentLogEntries.length;
  if (!total) return "Error: agent log is empty for this case.";
  let s = Math.max(0, Math.floor(startIndex || 0));
  let e = Math.min(total, Math.max(s + 1, Math.floor(endIndex ?? s + 30)));
  if (s >= total) return `Error: startIndex ${s} is past end (total=${total}).`;

  const filter = Array.isArray(typesFilter) && typesFilter.length ? new Set(typesFilter) : null;
  const lines: string[] = [];
  let cur = s;
  let chars = 0;
  while (cur < e) {
    const entry = ctx.agentLogEntries[cur];
    if (!filter || filter.has(entry?.type)) {
      const line = fmtAgentLogEntry(entry, cur);
      if (chars + line.length > MAX_LOG_WINDOW_CHARS) {
        lines.push(`\n…[stopped at index ${cur}, log-window character limit reached]`);
        break;
      }
      lines.push(line);
      chars += line.length;
    }
    cur++;
  }
  lines.unshift(`# agent.log entries [${s}..${cur}) of ${total} (filtered: ${filter ? Array.from(filter).join(",") : "none"})`);
  return lines.join("\n");
}

function executeTool(
  name: string,
  args: any,
  ctx: CaseContext,
): { ok: boolean; result: string } {
  try {
    if (name === "list_instructions")    return { ok: true, result: toolListInstructions() };
    if (name === "read_instruction")     return { ok: true, result: toolReadInstruction(String(args?.name || "")) };
    if (name === "list_agent_sources")   return { ok: true, result: toolListAgentSources() };
    if (name === "read_agent_source")    return { ok: true, result: toolReadAgentSource(String(args?.name || "")) };
    if (name === "list_commit_files")    return { ok: true, result: toolListCommitFiles(ctx, args?.folder) };
    if (name === "read_commit_file")     return { ok: true, result: toolReadCommitFile(ctx, String(args?.path || "")) };
    if (name === "read_commit_diff")     return { ok: true, result: toolReadCommitDiff(ctx, args?.path) };
    if (name === "read_agent_log_window") {
      return { ok: true, result: toolReadAgentLogWindow(ctx, Number(args?.startIndex), args?.endIndex, args?.typesFilter) };
    }
    return { ok: false, result: `Error: unknown tool '${name}'.` };
  } catch (err: any) {
    return { ok: false, result: `Tool '${name}' failed: ${err?.message || err}` };
  }
}

// ─── Prompt + system message ────────────────────────────────────────────────

interface AnalysisInputs {
  userPrompt: string;
  isCorrect: boolean;
  qualityScore: number;
  speedScore: number;
  userDescription: string | null | undefined;
  ctx: CaseContext;
  instructionsList: string[];
  hasBeforeCommit: boolean;
  hasAfterCommit: boolean;
}

/**
 * Build the system + user messages for the analysis call. Exported for
 * tests / future reuse.
 */
export function buildAnalysisPrompt(inputs: AnalysisInputs): { system: string; user: string } {
  const system = `You are a senior AI engineer investigating a single failure case from an AI app builder.

You have READ-ONLY tools to gather evidence. Use them. Then call submit_analysis exactly once.

Available tools:
  - list_instructions / read_instruction(name)        -> agent_knowledge/instructions/*.md
  - list_agent_sources / read_agent_source(name)      -> src/services/*.ts (the agent's own code)
  - list_commit_files / read_commit_file(path)        -> what the agent actually produced for the user
  - read_commit_diff([path])                          -> what changed between BEFORE and AFTER commits
  - read_agent_log_window(startIndex,[endIndex,typesFilter]) -> slices of agent.log
  - submit_analysis({summary,rootCause,suggestedLessons,suggestedPatches})  -> TERMINAL

Investigation discipline:
  1. Read the user's complaint first. Decide what evidence you need.
  2. Skim the agent.log windows to see what the agent thought / which tools it called.
  3. If the bug is in produced code, use read_commit_diff to find the changed files and read them.
  4. If the bug is in agent behavior (wrong tool order, missing step, wrong instruction), read the relevant instruction file AND the relevant section of agent.service.ts.
  5. NEVER suggest a patch you have not seen the current text of. NEVER fabricate filenames.
  6. Prefer LESSONS over PATCHES — they ship instantly. Patches are for structural problems.

Output (via submit_analysis):
  - LESSONS: 1-3 sentence imperative rules injected at runtime via getEnabledLessonsBlock(). Self-contained.
  - PATCHES: text suggestions describing concrete edits to instruction/source files. cursorPrompt MUST be a complete, paste-ready instruction for an engineer dropping it into Cursor IDE — name exact files, give exact intent.

You have at most ${MAX_ITERATIONS} tool-calling iterations. Budget them: gather, then submit.`;

  const user = `## USER COMPLAINT

User's original request:
> ${inputs.userPrompt}

User judged the result CORRECT? ${inputs.isCorrect ? "YES" : "NO"}
Quality score: ${inputs.qualityScore}/10
Speed score: ${inputs.speedScore}/10

User's description of what went wrong:
${inputs.userDescription || "(no description provided)"}

## CASE METADATA

projectId:        ${inputs.ctx.projectId}
commitNumBefore:  ${inputs.ctx.commitNumBefore ?? "(none — first build)"}
commitNumAfter:   ${inputs.ctx.commitNumAfter ?? "(unknown)"}
agent log entries: ${inputs.ctx.agentLogEntries.length}
post-run commit available: ${inputs.hasAfterCommit ? "yes" : "no"}
diff available:   ${inputs.hasBeforeCommit && inputs.hasAfterCommit ? "yes" : "no"}

## INSTRUCTION FILES (filenames, fetch with read_instruction)

${inputs.instructionsList.join("\n")}

## NEXT STEP

Call tools to investigate. When ready, call submit_analysis.`;

  return { system, user };
}

// ─── Main entry: analyzeCase ────────────────────────────────────────────────

interface RawSubmittedAnalysis {
  summary?: unknown;
  rootCause?: unknown;
  suggestedLessons?: unknown;
  suggestedPatches?: unknown;
}

function normalizeAnalysisFromTool(args: RawSubmittedAnalysis): {
  summary: string;
  rootCause?: string;
  suggestedLessons: SuggestedLesson[];
  suggestedPatches: SuggestedPatch[];
} {
  const lessons = Array.isArray(args.suggestedLessons)
    ? (args.suggestedLessons as any[])
        .map((l): SuggestedLesson | null => {
          const rule = String(l?.rule || "").trim();
          if (!rule) return null;
          return {
            rule,
            context: l?.context ? String(l.context).trim() : null,
            tags: Array.isArray(l?.tags) ? l.tags.map((t: any) => String(t)) : [],
            notes: l?.notes ? String(l.notes).trim() : null,
          };
        })
        .filter((x): x is SuggestedLesson => x !== null)
    : [];
  const patches = Array.isArray(args.suggestedPatches)
    ? (args.suggestedPatches as any[])
        .map((p): SuggestedPatch | null => {
          const title = String(p?.title || "").trim();
          const problem = String(p?.problem || "").trim();
          const suggestion = String(p?.suggestion || "").trim();
          const cursorPrompt = String(p?.cursorPrompt || "").trim();
          if (!title || !problem || !suggestion || !cursorPrompt) return null;
          return {
            title, problem, suggestion, cursorPrompt,
            targetFiles: Array.isArray(p?.targetFiles) ? p.targetFiles.map((f: any) => String(f)) : [],
            tags: Array.isArray(p?.tags) ? p.tags.map((t: any) => String(t)) : [],
            notes: p?.notes ? String(p.notes).trim() : null,
          };
        })
        .filter((x): x is SuggestedPatch => x !== null)
    : [];
  return {
    summary: String(args.summary || "").trim(),
    rootCause: args.rootCause ? String(args.rootCause).trim() : undefined,
    suggestedLessons: lessons,
    suggestedPatches: patches,
  };
}

/**
 * Strip cache_control off all tool messages, then add it to the LAST one.
 * This keeps total breakpoints in the request <= 3 (system, initial user, last
 * tool result) regardless of how many iterations we run.
 */
function restampLastToolCacheMarker(messages: any[]): void {
  let lastToolIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "tool") { lastToolIdx = i; break; }
  }
  if (lastToolIdx === -1) return;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role !== "tool") continue;
    if (i === lastToolIdx) {
      const text = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((b: any) => (typeof b === "string" ? b : b?.text || "")).join("")
          : String(m.content || "");
      m.content = [{ type: "text", text, cache_control: { type: "ephemeral" } }];
    } else if (Array.isArray(m.content)) {
      // Was previously stamped — flatten back to plain string to free the slot.
      m.content = m.content.map((b: any) => (typeof b === "string" ? b : b?.text || "")).join("");
    }
  }
}

export async function analyzeCase(feedbackId: string): Promise<void> {
  const fb = await prisma.agentFeedback.findUnique({ where: { id: feedbackId } });
  if (!fb) throw new Error(`AgentFeedback ${feedbackId} not found`);

  await prisma.agentFeedback.update({
    where: { id: feedbackId },
    data: { analysisStatus: "learning", analysisError: null },
  });

  try {
    const trainingKey = runtimeConfig.getTrainingApiKey();
    if (!trainingKey) {
      throw new Error(
        "Dedicated Training OpenRouter API key is not set. " +
          "Open Admin -> Configuration -> Agent Training and paste a separate key, then retry.",
      );
    }

    const ctx: CaseContext = {
      feedbackId,
      projectId: fb.projectId,
      commitNumBefore: fb.commitNumBefore ?? null,
      commitNumAfter: fb.commitNumAfter ?? null,
      agentLogEntries: readAgentLogEntriesForCase(fb.projectId, fb.commitNumAfter),
    };
    const hasAfterCommit = !!commitDir(ctx.projectId, ctx.commitNumAfter);
    const hasBeforeCommit = !!commitDir(ctx.projectId, ctx.commitNumBefore);
    const instructionsList = (() => {
      try { return fs.readdirSync(INSTRUCTIONS_DIR).filter((f) => f.endsWith(".md")).sort(); }
      catch { return []; }
    })();

    const { system, user } = buildAnalysisPrompt({
      userPrompt: fb.userPrompt,
      isCorrect: fb.isCorrect,
      qualityScore: fb.qualityScore,
      speedScore: fb.speedScore,
      userDescription: fb.userDescription,
      ctx,
      instructionsList,
      hasAfterCommit,
      hasBeforeCommit,
    });

    const model = runtimeConfig.getTrainingModel();
    const provider = runtimeConfig.getTrainingProvider();
    const client = getTrainingClient();
    const tools = getToolDefs();

    // Anthropic prompt caching: mark the system + initial user message with
    // cache_control. The system prompt + user complaint + case metadata are
    // identical for every iteration of the loop, so all calls after the first
    // one only re-process the new tool messages tail (~10% of the cost).
    const isAnthropic = /^anthropic\//i.test(model) || (provider || "").toLowerCase() === "anthropic";
    const cacheable = (text: string) =>
      isAnthropic
        ? [{ type: "text", text, cache_control: { type: "ephemeral" } }]
        : text;
    const messages: any[] = [
      { role: "system", content: cacheable(system) },
      { role: "user",   content: cacheable(user) },
    ];

    const investigationLog: InvestigationStep[] = [];
    const totalUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let submitted: ReturnType<typeof normalizeAnalysisFromTool> | null = null;
    let truncated = false;
    let iter = 0;

    console.log(
      `[AgentFeedback] starting tool-loop case=${feedbackId} model=${model}` +
        (provider ? ` provider=${provider}` : "") +
        ` logEntries=${ctx.agentLogEntries.length}`,
    );

    for (iter = 1; iter <= MAX_ITERATIONS; iter++) {
      // Rolling cache breakpoint: mark only the LAST tool message with
      // cache_control so the previous iteration's full prefix (system + user +
      // every prior tool round) becomes the cache lookup key for THIS call.
      // Anthropic allows max 4 breakpoints; we use 3 (system, initial user,
      // last tool result) — re-stamp on each iteration.
      if (isAnthropic) restampLastToolCacheMarker(messages);

      const reqBody: any = {
        model,
        max_tokens: 4000,
        messages,
        tools,
        tool_choice: "auto",
      };
      if (provider) {
        reqBody.provider = { only: [provider], allow_fallbacks: false };
      }

      const completion: any = await client.chat.completions.create(reqBody);
      const choice = completion.choices?.[0];
      const msg = choice?.message;
      const toolCalls: any[] = msg?.tool_calls || [];
      const text: string = typeof msg?.content === "string" ? msg.content : "";

      // Per-iteration usage breakdown (incl. cache hits when supported).
      const usage = completion.usage || {};
      const cacheRead =
        usage.prompt_tokens_details?.cached_tokens ??
        usage.cache_read_input_tokens ??
        0;
      const cacheWrite = usage.cache_creation_input_tokens ?? 0;
      console.log(
        `[AgentFeedback] iter=${iter} in=${usage.prompt_tokens || 0} ` +
          `out=${usage.completion_tokens || 0} cacheR=${cacheRead} cacheW=${cacheWrite}`,
      );
      totalUsage.input  += usage.prompt_tokens || 0;
      totalUsage.output += usage.completion_tokens || 0;
      totalUsage.cacheRead  += cacheRead;
      totalUsage.cacheWrite += cacheWrite;

      // Persist the assistant turn (with its tool_calls) so the model can
      // reference them when we feed back tool results.
      messages.push({
        role: "assistant",
        content: text || "",
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });

      if (!toolCalls.length) {
        // No tool call AND no submit yet — try once to nudge the model.
        if (iter < MAX_ITERATIONS) {
          messages.push({
            role: "user",
            content:
              "You did not call any tool. If you are done investigating, call `submit_analysis` now. Otherwise call one of the read tools.",
          });
          continue;
        }
        truncated = true;
        break;
      }

      // Execute every tool call, append a `tool` message for each.
      let didSubmit = false;
      for (const tc of toolCalls) {
        const callId = tc.id;
        const name = tc.function?.name;
        let args: any = {};
        try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; }
        catch { args = {}; }

        if (name === "submit_analysis") {
          submitted = normalizeAnalysisFromTool(args || {});
          investigationLog.push({
            iter, tool: name, args: { lessons: submitted.suggestedLessons.length, patches: submitted.suggestedPatches.length },
            resultPreview: "(submitted)", resultLength: 0, ok: true,
          });
          messages.push({
            role: "tool",
            tool_call_id: callId,
            content: "Accepted. Investigation complete.",
          });
          didSubmit = true;
          break;
        }

        const { ok, result } = executeTool(name, args, ctx);
        const safeResult = result.length > MAX_TOOL_RESULT_CHARS
          ? result.slice(0, MAX_TOOL_RESULT_CHARS) + `\n…[tool result truncated, original ${result.length} chars]`
          : result;
        investigationLog.push({
          iter,
          tool: name,
          args,
          resultPreview: safeResult.slice(0, 600),
          resultLength: safeResult.length,
          ok,
        });
        messages.push({
          role: "tool",
          tool_call_id: callId,
          content: safeResult,
        });
      }

      if (didSubmit) break;
    }

    if (!submitted) {
      truncated = true;
      submitted = {
        summary: "Investigation incomplete: model did not call submit_analysis within the iteration budget.",
        rootCause: undefined,
        suggestedLessons: [],
        suggestedPatches: [],
      };
    }

    const result: AnalysisResult = {
      ...submitted,
      investigationLog,
      iterations: iter,
      truncated,
      usage: totalUsage,
    };

    await prisma.agentFeedback.update({
      where: { id: feedbackId },
      data: {
        analysisStatus: "result_ready",
        analysisResult: result as any,
        analysisModel: provider ? `${model} (provider: ${provider})` : model,
        analysisError: null,
      },
    });

    console.log(
      `[AgentFeedback] analysis complete: ${feedbackId} iter=${iter} ` +
        `lessons=${result.suggestedLessons.length} patches=${result.suggestedPatches.length}` +
        (truncated ? " (TRUNCATED)" : ""),
    );
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.warn(`[AgentFeedback] analysis failed for ${feedbackId}: ${msg}`);
    await prisma.agentFeedback.update({
      where: { id: feedbackId },
      data: { analysisStatus: "pending", analysisError: msg.slice(0, 1000) },
    });
    throw err;
  }
}

// ─── Helpers re-exported for the admin detail panel ─────────────────────────

export function readAgentLogEntries(projectId: string, commitNum: number | null | undefined) {
  return readAgentLogEntriesForCase(projectId, commitNum);
}

export function readInstructionFile(name: string): string {
  return toolReadInstruction(name);
}
