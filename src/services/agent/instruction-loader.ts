import fs from "fs";
import path from "path";
import { config } from "../../config";
import { getEnabledLessonsBlock as getAgentLessonsBlock } from "../agent-lessons.service";
import { INSTRUCTIONS_DIR, SKILLS_DIR } from "./paths";
import { AgentMode } from "./types";

// What the agent knows depends on the build mode. Most instruction files are
// loaded for every run; only workflow-* files are mode-specific. Order matters.
const INSTRUCTION_MANIFEST: Array<{ file: string; modes?: AgentMode[] }> = [
  { file: "identity.md" },
  { file: "architecture.md" },
  { file: "frontend-rules.md" },
  { file: "backend-rules.md" },
  { file: "database-design.md" },
  { file: "routes-hot-reload.md" },
  { file: "bot-webhook.md" },
  { file: "technology-choice.md" },

  { file: "best-practices.md" },
  { file: "efficiency.md" },

  { file: "workflow-new.md", modes: ["new"] },
  { file: "workflow-update.md", modes: ["update"] },
  { file: "finish-tool.md" },
  { file: "telegram-api.md" },
  { file: "bot-side-updates.md" },
  { file: "after-writing.md" },
  { file: "ask-user.md" },
  { file: "skills-index.md" },
  { file: "frontend-design.md" },
  { file: "server-tools.md" },
];

const instructionCache = new Map<string, string>();

const TEMPLATE_KEYS = ["domain", "baseUrl", "wsBaseUrl", "wsScheme"] as const;
type TemplateKey = typeof TEMPLATE_KEYS[number];
const TEMPLATE_KEY_RE = new RegExp(`\\{(${TEMPLATE_KEYS.join("|")})\\}`, "g");

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

export async function buildSystemPrompt(mode: AgentMode): Promise<string> {
  const parts: string[] = [];
  const missing: string[] = [];
  const vars = buildTemplateVars();

  for (const entry of INSTRUCTION_MANIFEST) {
    if (entry.modes && !entry.modes.includes(mode)) continue;

    const content = loadInstruction(entry.file);
    if (content) parts.push(renderTemplate(content, vars));
    else missing.push(entry.file);
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
    console.warn(`[Agent] buildSystemPrompt(${mode}): ${missing.length} instruction file(s) missing: ${missing.join(", ")}`);
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
