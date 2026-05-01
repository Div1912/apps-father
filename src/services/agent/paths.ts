import path from "path";

export const PROJECTS_DIR = path.join(process.cwd(), "projects");
export const KNOWLEDGE_DIR = path.join(process.cwd(), "agent_knowledge");
export const INSTRUCTIONS_DIR = path.join(KNOWLEDGE_DIR, "instructions");
export const SKILLS_DIR = path.join(KNOWLEDGE_DIR, "skills");
