/**
 * Builds system_prompt + user_prompt for every agent session type.
 * Pure data builders — filesystem reads only, no LLM calls or side effects.
 */
import fs from "fs";
import path from "path";
import { projectService } from "./project.service";
import { getProjectFeatures } from "./features.service";
import { config } from "../config";
import { PROJECTS_DIR, KNOWLEDGE_DIR } from "./agent/paths";
import { ConventionExtractor } from "./convention-extractor";
import {
  BINARY_EXTS,
  READ_FILE_MAX_BYTES,
  SKIP_DIRS,
  SKIP_EXTS,
} from "./agent/config";

export interface SessionPrompts {
  systemPrompt: string;
  userPrompt: string;
}

// ── Context / data helpers ───────────────────────────────────────────────────

export function loadLatestContext(projectId: string): string | null {
  try {
    const commitsDir = path.join(PROJECTS_DIR, projectId, "commits");
    if (!fs.existsSync(commitsDir)) return null;
    const nums = fs.readdirSync(commitsDir).map(Number).filter(n => !isNaN(n));
    if (nums.length === 0) return null;
    const latest = Math.max(...nums);
    const minIdx = Math.max(1, latest - 5);

    // Walk backward looking for the most recent passport.md
    for (let i = latest; i >= minIdx; i--) {
      const dir = path.join(commitsDir, String(i));
      const passportPath = path.join(dir, "passport.md");
      if (!fs.existsSync(passportPath)) continue;
      let result = fs.readFileSync(passportPath, "utf-8");
      const historyPath = path.join(dir, "history.md");
      if (fs.existsSync(historyPath)) {
        const history = fs.readFileSync(historyPath, "utf-8");
        result += "\n\n## Recent Updates\n" + history.split("\n").slice(-10).join("\n");
      }
      if (i !== latest) {
        console.log(`[loadLatestContext] passport missing in commit ${latest}, fell back to commit ${i}`);
      }
      return result;
    }

    // Fall back to older context.md format
    for (let i = latest; i >= minIdx; i--) {
      const contextPath = path.join(commitsDir, String(i), "context.md");
      if (!fs.existsSync(contextPath)) continue;
      if (i !== latest) {
        console.log(`[loadLatestContext] context.md missing in commit ${latest}, fell back to commit ${i}`);
      }
      return fs.readFileSync(contextPath, "utf-8");
    }
  } catch {}
  return null;
}

export function loadAskPlatformOverview(): string {
  try {
    const p = path.join(KNOWLEDGE_DIR, "ask", "platform-overview.md");
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
  } catch {}
  return "(platform overview unavailable)";
}

export function getDbSummary(projectId: string): string | null {
  try {
    const Database = require("better-sqlite3");
    const dbPath = path.join(PROJECTS_DIR, projectId, "development", "data", "app.db");
    if (!fs.existsSync(dbPath)) return null;
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT key FROM kv").all() as any[];
    const keys = rows.map((r: any) => r.key);
    const summary: string[] = [`Keys (${keys.length}): ${keys.slice(0, 30).join(", ")}`];
    for (const key of keys.slice(0, 5)) {
      const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as any;
      if (row) {
        const val = row.value.substring(0, 200);
        summary.push(`  ${key}: ${val}${row.value.length > 200 ? "..." : ""}`);
      }
    }
    db.close();
    return summary.join("\n");
  } catch { return null; }
}

export async function buildFeatureGating(projectId: string): Promise<string> {
  const features = await getProjectFeatures(projectId);
  const project = await projectService.getProject(projectId);
  const starsStatus = features.includes("stars_payment")
    ? "UNLOCKED — you may implement Telegram Stars / XTR payment logic"
    : "LOCKED — do NOT implement any Telegram Stars / XTR payment logic. If the user asks for it, respond that they need to purchase this feature first.";
  let tonStatus: string;
  if (features.includes("ton_payment")) {
    const wallet = project?.tonWallet || "NOT SET";
    tonStatus = `UNLOCKED — you may implement TON payment logic. Use load_skill('ton-payments') for full implementation patterns. Wallet address: ${wallet}`;
  } else {
    tonStatus = "LOCKED — do NOT implement any TON / blockchain payment logic. If the user asks for it, respond that they need to purchase this feature first.";
  }
  return `\nPAID FEATURES STATUS:\n- Stars Payment System: ${starsStatus}\n- TON Payment System: ${tonStatus}\n`;
}

export function walkDirWithStats(dir: string, base: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (SKIP_DIRS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      results.push(...walkDirWithStats(fullPath, base));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      const relPath = path.relative(base, fullPath).replace(/\\/g, "/");
      try {
        const stat = fs.statSync(fullPath);
        const sizeKB = (stat.size / 1024).toFixed(1);
        if (BINARY_EXTS.has(ext) || SKIP_EXTS.has(ext)) {
          results.push(`${relPath} (${sizeKB}KB, binary — do not read_file)`);
          continue;
        }
        if (stat.size > READ_FILE_MAX_BYTES) {
          results.push(`${relPath} (${sizeKB}KB, large — use grep / paged read_file)`);
          continue;
        }
        const lineCount = fs.readFileSync(fullPath, "utf-8").split("\n").length;
        results.push(`${relPath} (${lineCount} lines, ${sizeKB}KB)`);
      } catch {
        results.push(relPath);
      }
    }
  }
  return results;
}

export function gatherProjectInfo(projectDir: string): { fileTree: string; dbKeys: string; npmPackages: string } {
  const files = walkDirWithStats(projectDir, projectDir);
  const fileTree = files.length > 0 ? files.map(f => "  " + f).join("\n") : "";

  let dbKeys = "";
  try {
    const Database = require("better-sqlite3");
    const projectRoot = path.resolve(projectDir, "..", "..");
    const dbPath = path.join(projectRoot, "development", "data", "app.db");
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare("SELECT key FROM kv").all() as any[];
      dbKeys = rows.map((r: any) => r.key).join(", ");
      db.close();
    }
  } catch {}

  let npmPackages = "";
  const pkgPath = path.join(projectDir, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const deps = Object.keys(pkg.dependencies || {});
      if (deps.length > 0) npmPackages = deps.join(", ");
    } catch {}
  }

  return { fileTree, dbKeys, npmPackages };
}

export function extractRecentChanges(passport: string): string {
  if (!passport) return "";
  const re = /^##\s+Recent Changes\s*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m;
  const m = passport.match(re);
  return m ? m[1].trim() : "";
}

export function listProjectFiles(commitDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(path.join(commitDir, "frontend"), "frontend");
  walk(path.join(commitDir, "backend"), "backend");
  return out;
}

export function buildFallbackSummary(projectDir: string, doneSummary: string): string {
  const { fileTree, dbKeys, npmPackages } = gatherProjectInfo(projectDir);
  const parts: string[] = [];
  if (fileTree) parts.push("FILE TREE:\n" + fileTree);
  if (doneSummary) parts.push("ARCHITECTURE & CHANGES:\n" + doneSummary);
  if (dbKeys) parts.push("DB KEYS: " + dbKeys);
  if (npmPackages) parts.push("NPM PACKAGES: " + npmPackages);
  return parts.join("\n\n");
}

export function resolveAskProjectDir(projectId: string): string | null {
  const devDir = path.join(PROJECTS_DIR, projectId, "development");
  if (fs.existsSync(devDir)) return devDir;
  try {
    const commitsDir = path.join(PROJECTS_DIR, projectId, "commits");
    if (!fs.existsSync(commitsDir)) return null;
    const nums = fs.readdirSync(commitsDir).map(Number).filter(n => !isNaN(n));
    if (nums.length === 0) return null;
    return path.join(commitsDir, String(Math.max(...nums)));
  } catch { return null; }
}

// ── Language helpers ─────────────────────────────────────────────────────────

function langSpeakInstruction(lang?: string): string {
  if (lang === "ru") return "\nAlways speak Russian to the user.";
  if (lang === "ua") return "\nAlways speak Ukrainian to the user.";
  return "\nAlways speak the same language the user used in their message.";
}

function langReplyInstruction(lang?: string): string {
  if (lang === "ru") return "\nAlways reply in Russian.";
  if (lang === "ua") return "\nAlways reply in Ukrainian.";
  return "";
}

function langAppInstruction(lang?: string): string {
  if (lang && lang !== "en") {
    const langName = lang === "ru" ? "Russian" : "Ukrainian";
    return `\n\nIMPORTANT: All user-facing text in the app (UI labels, buttons, messages, placeholders, titles) must be written in ${langName}. The code, comments, and variable names should stay in English.`;
  }
  return "";
}

// ── Session prompt builders ──────────────────────────────────────────────────

export async function session_router(
  projectId: string,
  args: {
    userMessage: string;
    lang?: string;
    conversationHistory?: { role: "user" | "assistant"; content: string }[];
  },
): Promise<{ systemPrompt: string; messages: any[] }> {
  const project: any = await projectService.getProject(projectId);
  const context = loadLatestContext(projectId) || project?.projectSummary || "No project context available.";
  const description = project?.description || "";
  const langNote = langSpeakInstruction(args.lang);

  const systemPrompt = `You are the chat ROUTER for an Apps Father app builder. The user owns a Telegram Mini App and is chatting with you about it.

Your job per message:
  1. Classify the user's intent and call propose_action with the matching kind:
       * answer      - question / chitchat. Put the full answer in description. (Free — starts immediately.)
       * suggestions - the user wants ideas / inspiration. List them in description. (Free.)
       * build       - user wants to CREATE a new app. Provide a full brief. (100 credits.)
       * update      - user wants ONE focused change. prefilledPrompt = exact request. (85 credits.)
       * update-plan - user wants MULTIPLE changes (listed or implied). Add a plan array + prefilledPrompt. (50 + 25×items credits.)
       * bug-fix     - user reports a broken feature. Diagnose in description, fix prompt in prefilledPrompt. (30 credits.)

  2. Use read-only tools only when needed to answer or classify the request.
  3. Call questionnaire(question, options?) ONLY when intent is truly ambiguous.
  4. End with EXACTLY ONE propose_action call.

Rule: if the user lists or implies MORE THAN ONE distinct change → use 'update-plan'.
Single change → 'update'. Bug report → 'bug-fix'. New app → 'build'. Question → 'answer'.${langNote}

APP DESCRIPTION:
${description.substring(0, 1500)}

PROJECT CONTEXT:
${context.substring(0, 4000)}`;

  const messages: any[] = [];
  for (const msg of args.conversationHistory ?? []) {
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: "user", content: args.userMessage });

  return { systemPrompt, messages };
}

export async function session_answer(
  projectId: string,
  args: {
    question: string;
    lastUpdate?: string;
    appDescription?: string;
    conversationHistory?: { role: "user" | "assistant"; content: string }[];
    lang?: string;
  },
): Promise<{ systemPrompt: string; messages: any[] }> {
  const project: any = await projectService.getProject(projectId);
  const context = loadLatestContext(projectId) || project?.projectSummary || "No project context available.";
  const dbSummary = getDbSummary(projectId);
  const description = args.appDescription || project?.description || "";
  const langNote = langReplyInstruction(args.lang);
  const platformOverview = loadAskPlatformOverview();

  const systemPrompt = `You are a friendly assistant helping an app owner (non-technical person) understand their Telegram Mini App built on Apps Father.
Answer in simple, everyday language. NO programming terms, NO code, NO file names, NO technical jargon.
Talk as if explaining to a friend who doesn't know anything about coding.
Use markdown formatting: **bold**, lists (- item), headings (## Title) to keep it readable.
If the question is about app data/users/stats, give clear numbers and insights.
Keep answers concise and actionable.${langNote}

────────────────  APPS FATHER PLATFORM (what the owner can do here) ────────────────
${platformOverview}
────────────────────────────────────────────────────────────────────────────────────

You have tools — USE them whenever the question is about *this specific project*:
- project_info()              — name, kind, description, plan, prefs, locked features.
- list_files()                — see what files the project has.
- read_file(path, offset?, limit?) — peek into the live app code (frontend/, backend/).
- db_query({ action, key?, prefix?, limit? }) — read the project's key/value store.
    action="list"  → recent keys (with prefix filter); shows truncated values.
    action="get"   → value for a single key.
    action="count" → count of keys (with optional prefix).
- platform_help(topic?)       — deeper Apps Father feature docs (topics: payments,
    referrals, realtime, bot, billing, tiers). No topic = the high-level overview.

Tool guidelines:
- Prefer tools over guessing. If the owner asks "how many users?" → db_query count.
- Don't dump tool output verbatim. Translate findings into plain language.
- Never expose file paths, code, SQL, or stack traces in your final answer.
- 1–3 tool calls per turn is plenty. Avoid fishing expeditions.

APP DESCRIPTION:
${description.substring(0, 2000)}

PROJECT CONTEXT:
${context.substring(0, 6000)}

${args.lastUpdate ? `LAST UPDATE SUMMARY:\n${args.lastUpdate.substring(0, 2000)}\n` : ""}${dbSummary ? `DB KEYS SUMMARY:\n${dbSummary}\n` : ""}`;

  const messages: any[] = [];
  for (const msg of args.conversationHistory ?? []) {
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: "user", content: args.question });

  return { systemPrompt, messages };
}

export async function session_suggestions(
  projectId: string,
  args: { lang?: string },
): Promise<{ userPrompt: string }> {
  const project: any = await projectService.getProject(projectId);
  const context = loadLatestContext(projectId) || project?.projectSummary || "No project context available.";
  const dbSummary = getDbSummary(projectId);
  const description = project?.description || "";
  const langNote = args.lang === "ru"
    ? "\nWrite all titles and descriptions in Russian."
    : args.lang === "ua" ? "\nWrite all titles and descriptions in Ukrainian."
    : "";

  const userPrompt = `You are a product advisor for a Telegram Mini App. Analyze the current app and suggest 5 practical improvements the owner could make next.

APP DESCRIPTION:
${description.substring(0, 2000)}

PROJECT CONTEXT:
${context.substring(0, 8000)}

${dbSummary ? `DB KEYS SUMMARY:\n${dbSummary}\n` : ""}
Return EXACTLY a JSON array of 5 objects, each with "title" (short, 3-8 words) and "description" (1-2 sentences, simple non-technical language explaining the benefit for users). No markdown, no code blocks, just raw JSON array.

Focus on:
- UX improvements
- New features users would love
- Design/visual enhancements
- Performance or usability fixes
- Engagement or retention ideas

Keep suggestions practical and specific to THIS app.${langNote}`;

  return { userPrompt };
}

export async function session_build(
  projectId: string,
  args: { description: string; plan: string; lang?: string },
): Promise<{ userPrompt: string }> {
  const project: any = await projectService.getProject(projectId);
  const featureGating = await buildFeatureGating(projectId);
  const langNote = langAppInstruction(args.lang);
  const hasBotLinked = !!project?.botUsername;
  const simTelegramNote = hasBotLinked
    ? ""
    : "\nNOTE: No Telegram bot is linked yet — simulate_telegram is optional. You may call it to verify webhook logic but it is NOT required before finish(). The bot webhook will be testable once the user connects a bot.";

  const baseProjectInfo = `Project ID: ${projectId}
Development App URL: ${config.baseUrl}/dev/${projectId}/
Development API URL: ${config.baseUrl}/devapi/${projectId}/
Production App URL: ${config.baseUrl}/app/${projectId}/
Production API URL: ${config.baseUrl}/api/${projectId}/
Telegram Bot Link: ${project?.botUsername ? `https://t.me/${project.botUsername}` : "(bot not linked yet)"}

Description: ${args.description}

Plan:
${args.plan}
${featureGating}`;

  const userPrompt = `Build a complete Telegram Mini App from scratch.\n\n${baseProjectInfo}\nCreate all necessary files (frontend/index.html, frontend/styles.css, frontend/app.js, backend/routes.js) and configure the bot. Database is handled via db.get/db.set in routes.js — no schema setup needed. Make it beautiful and functional. Use deploy_to_dev() to deploy and test your code via the Dev URLs. In frontend code, use /api/${projectId}/ as the API base URL (this will be rewritten to /devapi/ in dev mode automatically).${simTelegramNote}${langNote}`;

  return { userPrompt };
}

export async function session_update(
  projectId: string,
  args: {
    updateDescription: string;
    lang?: string;
    attachments?: { localPath: string; projectPath: string; originalName: string; caption?: string }[];
  },
): Promise<{ userPrompt: string }> {
  const project: any = await projectService.getProject(projectId);
  const contextParts: string[] = [];
  const latestContext = loadLatestContext(projectId);
  if (latestContext) {
    contextParts.push(`PROJECT CONTEXT:\n${latestContext}`);
  } else if (project?.projectSummary) {
    contextParts.push(`PROJECT CONTEXT (from previous builds):\n${project.projectSummary}`);
  }

  let attachmentInfo = "";
  if (args.attachments && args.attachments.length > 0) {
    const lines = args.attachments.map(a =>
      `- ${a.projectPath} (original: ${a.originalName})${a.caption ? ` — "${a.caption}"` : ""}`
    );
    attachmentInfo = `\nATTACHED FILES (already saved to project):\n${lines.join("\n")}\nThe user uploaded these files for you to use in the app. Reference them in your code by path (e.g. <img src="assets/filename.jpg">). DO NOT call read_file on image/audio/video/font/binary files — the tool will refuse and the path alone is enough to use them. read_file is only for text files (json, csv, txt, md, etc.) you actually need to inspect.\n`;
  }

  const featureGating = await buildFeatureGating(projectId);
  const langNote = langAppInstruction(args.lang);
  const hasBotLinked = !!project?.botUsername;
  const simNote = hasBotLinked
    ? ""
    : "\nNOTE: No Telegram bot is linked yet — simulate_telegram is optional. You may call it to verify webhook logic but it is NOT required before finish(). The bot webhook will be testable once the user connects a bot.";

  const context = contextParts.length > 0 ? contextParts.join("\n\n") + "\n\n" : "";
  const projectInfo = `Project ID: ${projectId}
Development App URL: ${config.baseUrl}/dev/${projectId}/
Development API URL: ${config.baseUrl}/devapi/${projectId}/
Production App URL: ${config.baseUrl}/app/${projectId}/
Production API URL: ${config.baseUrl}/api/${projectId}/

Telegram Bot Link: ${project?.botUsername ? `https://t.me/${project.botUsername}` : "(bot not linked yet)"}
Telegram Bot Deep Link Making: ${project?.botUsername ? `https://t.me/${project.botUsername}?start={some_param}` : "(bot not linked yet)"}
Track Deep Link: in routes.js from /bot-webhook route track the as message of start param

${context}
Update request:
${args.updateDescription}
${attachmentInfo}
${featureGating}`;

  const userPrompt = `Update an existing Telegram Mini App.\n\n${projectInfo}\nUse grep and read_file to verify current state before making changes. Use edit_file for targeted modifications. Use deploy_to_dev(), simulate_api/server_logs for changed backend behavior, simulate_ws for changed real-time behavior, then finish.${simNote}${langNote}`;

  return { userPrompt };
}

export async function session_context(
  projectId: string,
  args: {
    commitDir: string;
    commitNum: number;
    description?: string;
    doneSummary?: string;
    prevPassport?: string;
  },
): Promise<{ inputText: string }> {
  const { commitDir, commitNum, description, doneSummary, prevPassport } = args;
  const { fileTree, dbKeys, npmPackages } = gatherProjectInfo(commitDir);
  const extractor = new ConventionExtractor();
  const { structure, conventions } = extractor.extract(commitDir);

  const inputParts: string[] = [];
  if (description) inputParts.push(`APP DESCRIPTION: ${description}`);
  if (structure) inputParts.push(`CODE STRUCTURE MAP:\n${structure}`);
  if (conventions) inputParts.push(`CODE CONVENTION SAMPLES:\n${conventions}`);
  if (fileTree) inputParts.push(`FILE TREE:\n${fileTree}`);
  if (dbKeys) inputParts.push(`DB KEYS: ${dbKeys}`);
  if (npmPackages) inputParts.push(`NPM PACKAGES: ${npmPackages}`);
  if (prevPassport) {
    inputParts.push(`PREVIOUS PASSPORT (for reference — preserve style and key decisions, but update everything from actual code):\n${prevPassport.substring(0, 8000)}`);
  }
  const recentChanges = extractRecentChanges(prevPassport || "");
  if (recentChanges) {
    inputParts.push(
      `RECENT CHANGES TO FOLD IN (these are append-only deltas from commits since the last regen — merge each entry into Architecture / Code Locations / Current State as appropriate, then leave the new Recent Changes section EMPTY):\n${recentChanges.substring(0, 4000)}`
    );
  }
  if (doneSummary) inputParts.push(`LATEST CHANGES (commit #${commitNum}):\n${doneSummary.substring(0, 3000)}`);

  const inputText = `${doneSummary ? "Generate an updated" : "Analyze this codebase and generate a"} project passport for a Telegram Mini App.
This document will be used by an AI developer agent in future updates to understand the project
instantly WITHOUT reading all files. It must be accurate and complete — the agent will trust this
document and use Code Locations to jump directly to the right lines.
${prevPassport ? "\nUse the previous passport for style/format reference and to preserve Key Decisions that are still relevant." : ""}${recentChanges ? "\nIf RECENT CHANGES TO FOLD IN is provided above, merge every entry into the relevant body sections (new routes go to Architecture, new files go to Code Locations, removed features come out of Current State, etc.) and OUTPUT an EMPTY Recent Changes section at the bottom — do NOT just copy the deltas back into Recent Changes." : ""}

${inputParts.join("\n\n")}

Output a structured markdown document (under 4000 words) with EXACTLY these sections (in this order):

## App: <name>
Purpose: <one-line description>

## Architecture
Pages/screens, navigation flow, API routes (method + path + what it does), WebSocket events if any,
DB keys and what they store. Be specific — list every route, every DB key, every screen ID.

## Code Locations
Use the auto-extracted locations above as a base. Keep all of them.
Add any important helpers, constants, or hook points that were missed.
Format: \`- file:line — description\`
This section is CRITICAL for the agent's efficiency.

## Code Conventions
- **Frontend structure:** key function names and what they do, global state variables (what's in \`state\` object), how tabs/modals are toggled, DOM update patterns.
- **CSS patterns:** naming convention, CSS variables used for theming, key class names for major components.
- **Backend patterns:** route handler structure, middleware, error handling style, how db.get/db.set are used.
- **Critical wiring:** how frontend calls API (fetch wrapper? base URL pattern?), how WebSocket events are dispatched and handled, event listeners setup.

## UI
Theme, layout approach, key components with their CSS class names, special effects/animations.

## Key Decisions
Important implementation choices and WHY they were made. Include gotchas, known issues,
and things that look wrong but are intentional.

## Current State
What the app can do right now. What features are complete, what's partially done.

## Recent Changes
(empty — populated by future commits via append path)`;

  return { inputText };
}
