import fs from "fs";
import path from "path";
import { config } from "../../config";
import { getEnabledLessonsBlock as getAgentLessonsBlock } from "../agent-lessons.service";
import { INSTRUCTIONS_DIR, SKILLS_DIR } from "./paths";
import { AgentMode, ProjectKind, normalizeProjectKind } from "./types";

const NEW_WORKFLOW_BY_KIND: Record<ProjectKind, string> = {
  app: "workflow-new-app.md",
  game: "workflow-new-game.md",
  textBot: "workflow-new-textbot.md",
};

const UPDATE_WORKFLOW_BY_KIND: Record<ProjectKind, string> = {
  app: "workflow-update-app.md",
  game: "workflow-update-game.md",
  textBot: "workflow-update-textbot.md",
};

// What the agent knows depends on the build mode. Most instruction files are
// loaded for every run; only workflow-* files are mode-specific. Order matters.
const INSTRUCTION_MANIFEST: Array<{ file: string; modes?: AgentMode[]; kinds?: ProjectKind[] }> = [
  { file: "identity.md" },
  { file: "architecture.md" },
  { file: "frontend-rules.md", kinds: ["app"] },
  { file: "backend-rules.md", kinds: ["app", "textBot"] },
  { file: "database-design.md", kinds: ["app", "textBot"] },
  { file: "routes-hot-reload.md", kinds: ["app", "textBot"] },
  { file: "bot-webhook.md", kinds: ["app", "textBot"] },
  { file: "technology-choice.md", kinds: ["app"] },

  { file: "best-practices.md" },
  { file: "efficiency.md" },

  { file: "workflow-new.md", modes: ["new"] },
  { file: "workflow-update.md", modes: ["update"] },
  { file: "finish-tool.md" },
  { file: "telegram-api.md" },
  { file: "bot-side-updates.md", kinds: ["app", "textBot"] },
  { file: "after-writing.md" },
  { file: "ask-user.md" },
  { file: "skills-index.md" },
  { file: "frontend-design.md", kinds: ["app"] },
  { file: "server-tools.md" },
];

const instructionCache = new Map<string, string>();

const TEMPLATE_KEYS = ["domain", "baseUrl", "wsBaseUrl", "wsScheme"] as const;
type TemplateKey = typeof TEMPLATE_KEYS[number];
const TEMPLATE_KEY_RE = new RegExp(`\\{(${TEMPLATE_KEYS.join("|")})\\}`, "g");

export function workflowFileFor(mode: AgentMode, kind?: string | null): string {
  const normalized = normalizeProjectKind(kind);
  return mode === "new"
    ? NEW_WORKFLOW_BY_KIND[normalized]
    : UPDATE_WORKFLOW_BY_KIND[normalized];
}

export function buildTemplateVars(): Record<TemplateKey, string> {
  const baseUrl = config.baseUrl;
  const wsScheme = baseUrl.startsWith("https://") ? "wss" : "ws";
  const wsBaseUrl = baseUrl.replace(/^https?:\/\//, `${wsScheme}://`);
  return {
    domain: config.domain,
    baseUrl,
    wsBaseUrl,
    wsScheme,
  };
}

export function renderTemplate(text: string, vars: Record<TemplateKey, string>): string {
  if (!text) return text;
  return text.replace(TEMPLATE_KEY_RE, (_, k: TemplateKey) => vars[k] ?? `{${k}}`);
}

function loadInstruction(file: string): string {
  if (instructionCache.has(file)) return instructionCache.get(file)!;
  try {
    const filePath = path.join(INSTRUCTIONS_DIR, file);
    if (!filePath.startsWith(INSTRUCTIONS_DIR)) return "";
    const content = fs.readFileSync(filePath, "utf-8").trim();
    instructionCache.set(file, content);
    return content;
  } catch (err: any) {
    console.warn(`[Agent] missing instruction file: ${file} — ${err.message}`);
    instructionCache.set(file, "");
    return "";
  }
}

export async function buildSystemPrompt(mode: AgentMode, kind?: string): Promise<string> {
  const parts: string[] = [];
  const missing: string[] = [];
  const vars = buildTemplateVars();
  const normalizedKind = normalizeProjectKind(kind);

  for (const entry of INSTRUCTION_MANIFEST) {
    if (entry.modes && !entry.modes.includes(mode)) continue;
    if (entry.kinds && !entry.kinds.includes(normalizedKind)) continue;

    let file = entry.file;
    if ((file === "workflow-new.md" && mode === "new") || (file === "workflow-update.md" && mode === "update")) {
      const kindFile = workflowFileFor(mode, normalizedKind);
      const kindContent = loadInstruction(kindFile);
      if (kindContent) {
        file = kindFile;
      }
    }

    const content = loadInstruction(file);
    if (content) parts.push(renderTemplate(content, vars));
    else missing.push(file);
  }

  try {
    const lessonsBlock = await getAgentLessonsBlock();
    if (lessonsBlock) parts.push(lessonsBlock);
  } catch (err: any) {
    console.warn(`[Agent] failed to load learned lessons: ${err?.message || err}`);
  }

  const prompt = parts.join("\n----------------------\n");
  if (!prompt.trim()) {
    throw new Error(
      `[Agent] system prompt is empty — agent_knowledge/instructions/ missing or unreadable at ${INSTRUCTIONS_DIR}. ` +
      `Missing files: ${missing.join(", ")}. ` +
      `Run deploy-full.ps1 (or copy agent_knowledge/ to the server) and restart the process.`
    );
  }
  if (missing.length > 0) {
    console.warn(`[Agent] buildSystemPrompt(${mode}, kind=${kind ?? "?"}): ${missing.length} instruction file(s) missing: ${missing.join(", ")}`);
  }
  return prompt;
}

export function loadSkill(name: string): string {
  try {
    const filePath = path.join(SKILLS_DIR, name.endsWith(".md") ? name : name + ".md");
    if (!filePath.startsWith(SKILLS_DIR)) return "";
    const raw = fs.readFileSync(filePath, "utf-8");
    return renderTemplate(raw, buildTemplateVars());
  } catch {
    return "";
  }
}

export function getAvailableSkills(): string[] {
  try {
    return fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".md")).map(f => f.replace(".md", ""));
  } catch {
    return [];
  }
}
