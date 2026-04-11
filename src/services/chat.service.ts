import fs from "fs";
import path from "path";
import crypto from "crypto";

const PROJECTS_DIR = path.join(process.cwd(), "projects");

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  type: "text" | "update_request" | "question" | "answer" | "result" | "progress" | "error" | "plan" | "balance_error";
  content: string;
  attachments?: { name: string; path: string; type: string }[];
  checklist?: { id: number; text: string; done: boolean }[];
  percent?: number;
  costUsd?: number;
  balance?: number;
  timestamp: number;
  metadata?: Record<string, any>;
}

function historyPath(projectId: string): string {
  return path.join(PROJECTS_DIR, projectId, "chat-history.json");
}

function readHistory(projectId: string): ChatMessage[] {
  const fp = historyPath(projectId);
  if (!fs.existsSync(fp)) return [];
  try {
    return JSON.parse(fs.readFileSync(fp, "utf-8"));
  } catch {
    return [];
  }
}

function writeHistory(projectId: string, messages: ChatMessage[]): void {
  const fp = historyPath(projectId);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(messages, null, 2), "utf-8");
}

export const chatService = {
  getHistory(projectId: string, before?: number, limit = 50): ChatMessage[] {
    const all = readHistory(projectId);
    if (!before) return all.slice(-limit);
    const idx = all.findIndex(m => m.timestamp >= before);
    if (idx <= 0) return [];
    const start = Math.max(0, idx - limit);
    return all.slice(start, idx);
  },

  addMessage(projectId: string, msg: Omit<ChatMessage, "id" | "timestamp">): ChatMessage {
    const messages = readHistory(projectId);
    const full: ChatMessage = {
      ...msg,
      id: crypto.randomBytes(8).toString("hex"),
      timestamp: Date.now(),
    };
    messages.push(full);
    writeHistory(projectId, messages);
    return full;
  },

  updateMessage(projectId: string, msgId: string, partial: Partial<ChatMessage>): ChatMessage | null {
    const messages = readHistory(projectId);
    const idx = messages.findIndex(m => m.id === msgId);
    if (idx === -1) return null;
    messages[idx] = { ...messages[idx], ...partial, id: msgId };
    writeHistory(projectId, messages);
    return messages[idx];
  },

  clearHistory(projectId: string): void {
    const fp = historyPath(projectId);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  },
};
